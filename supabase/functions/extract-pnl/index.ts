// Real PDF extraction with AI-native PDF reading (handles scans via Claude vision).
// Pipeline:
//   1. Receive base64 PDF from client.
//   2. Send the PDF directly to Claude as a document attachment together with a
//      strict tool schema. Claude natively reads both text-based and scanned PDFs.
//   3. Return the structured ExtractionResult JSON.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AI_URL = "https://api.anthropic.com/v1/messages";
const EXTRACT_MODEL = "claude-opus-4-6";

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    company: { type: "string", description: "Company / reporting entity name" },
    period: { type: "string", description: "Reporting period e.g. 'FY 2024' or 'Year ended 31 Dec 2024'" },
    currency: { type: "string", description: "Reporting currency code, e.g. BHD, USD, EUR. Use empty string if unknown." },
    statementTitle: { type: "string", description: "Title of the P&L statement as printed in the report" },
    pnl: {
      type: "array",
      description: "P&L / income statement rows in document order",
      items: {
        type: "object",
        properties: {
          lineItem: { type: "string" },
          noteRef: { type: "string", description: "Note number printed next to this row, or empty string" },
          currentYear: { type: "number", description: "Use the latest period's value. Negative for expenses if shown that way." },
          priorYear: { type: "number" },
          page: { type: "integer", description: "1-based page number where this row appears" },
        },
        required: ["lineItem", "noteRef", "currentYear", "priorYear", "page"],
        additionalProperties: false,
      },
    },
    notes: {
      type: "array",
      description: "Note breakdown rows that explain P&L line items",
      items: {
        type: "object",
        properties: {
          parentLineItem: { type: "string", description: "Exact text of the P&L line this note explains" },
          noteTitle: { type: "string", description: "Heading of the note section" },
          component: { type: "string", description: "Sub-line / component name within the note" },
          currentYear: { type: "number" },
          priorYear: { type: "number" },
          page: { type: "integer" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          matchMethod: { type: "string", enum: ["explicit", "title", "semantic"] },
          flagged: { type: "boolean" },
        },
        required: ["parentLineItem", "noteTitle", "component", "currentYear", "priorYear", "page", "confidence", "matchMethod", "flagged"],
        additionalProperties: false,
      },
    },
  },
  required: ["company", "period", "currency", "statementTitle", "pnl", "notes"],
  additionalProperties: false,
};

function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// Send the PDF directly to Claude and ask it to return structured P&L data
// via a tool call. Claude reads PDFs natively (text + scans).
async function extractFromPdfWithClaude(pdfB64: string, apiKey: string) {
  const body = {
    model: EXTRACT_MODEL,
    max_tokens: 8192,
    system:
      "You are a financial-document extraction engine. You will be given a PDF of an annual report / audited financial statements. Your job: (1) locate the consolidated Profit & Loss / Income Statement (also called 'Statement of Profit or Loss', 'Statement of Comprehensive Income', or 'Income Statement'); (2) extract EVERY row in order, including subtotals like 'Gross profit', 'Operating profit', 'Profit for the year'; (3) capture both the latest period and the comparative prior period as numbers (parentheses = negative); (4) record the page number each row appears on; (5) then locate the explanatory notes that break down each P&L line and return their components. Match notes to P&L lines: prefer the explicit numeric note ref printed next to the P&L row; otherwise match by note title; otherwise infer semantically and flag with lower confidence. NEVER return empty arrays unless the document truly has no income statement — if you can see revenue/expense rows, you MUST return them.\n\nLANGUAGE / TRANSLATION RULES:\n- If the document is in English, copy line-item text, note titles, components, company name, period, and statement title VERBATIM.\n- If the document is in Arabic (or any non-English language), TRANSLATE all textual fields into clear, standard English financial terminology (e.g. 'الإيرادات' → 'Revenue', 'تكلفة المبيعات' → 'Cost of sales', 'إجمالي الربح' → 'Gross profit', 'مصاريف عمومية وإدارية' → 'General and administrative expenses', 'صافي الربح للسنة' → 'Net profit for the year').\n- Translate: company name (transliterate proper names if no English form is printed), period, statementTitle, lineItem, noteTitle, parentLineItem, component.\n- For bilingual documents that already show an English version next to the Arabic, USE the printed English text as-is.\n- NEVER translate or alter numeric values — keep digits, signs, and magnitudes exactly as printed (convert Arabic-Indic digits ٠-٩ to Western 0-9).\n- Currency codes must be returned in standard ISO form in English (e.g. BHD, SAR, AED, USD).\n- All output strings in the JSON MUST be in English regardless of the source language.",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: pdfB64,
            },
          },
          {
            type: "text",
            text: "Extract the P&L statement and supporting notes from this PDF. Return via the return_extraction tool.",
          },
        ],
      },
    ],
    tools: [
      {
        name: "return_extraction",
        description: "Return the structured P&L and note extraction.",
        input_schema: EXTRACT_SCHEMA,
      },
    ],
    tool_choice: { type: "tool", name: "return_extraction" },
  };

  const resp = await fetch(AI_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error("Anthropic API error", resp.status, t);
    if (resp.status === 429) throw new Error("RATE_LIMIT");
    if (resp.status === 402) throw new Error("PAYMENT_REQUIRED");
    throw new Error("EXTRACTION_FAILED");
  }

  const data = await resp.json();

  // Claude returns tool use in content array
  const toolUse = data.content?.find((block: { type: string }) => block.type === "tool_use");
  if (!toolUse) throw new Error("AI returned no tool call");

  return toolUse.input;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured");

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { fileName, base64 } = body as { fileName?: unknown; base64?: unknown };

    if (typeof base64 !== "string" || base64.length === 0) {
      return new Response(JSON.stringify({ error: "Missing or invalid 'base64' field" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // ~15 MB decoded ≈ 20M base64 chars
    if (base64.length > 20_000_000) {
      return new Response(JSON.stringify({ error: "File too large (max ~15 MB)" }), {
        status: 413, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (fileName !== undefined && (typeof fileName !== "string" || fileName.length > 255)) {
      return new Response(JSON.stringify({ error: "Invalid 'fileName' field" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Hard-reject anything that isn't a real PDF
    try {
      const head = bytesFromBase64(base64.slice(0, 32));
      const sig = String.fromCharCode(...head.slice(0, 4));
      if (sig !== "%PDF") {
        return new Response(JSON.stringify({ error: "Only PDF files are accepted" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } catch {
      return new Response(JSON.stringify({ error: "Invalid base64 payload" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const extracted = await extractFromPdfWithClaude(base64, apiKey);

    return new Response(
      JSON.stringify({ ...extracted, fileName }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("extract-pnl error:", e);
    const code = e instanceof Error ? e.message : "";
    let status = 500;
    let userMsg = "Extraction failed. Please try again.";
    if (code === "RATE_LIMIT") {
      status = 429;
      userMsg = "Rate limit reached. Please wait and retry.";
    } else if (code === "PAYMENT_REQUIRED") {
      status = 402;
      userMsg = "Service temporarily unavailable.";
    }
    return new Response(JSON.stringify({ error: userMsg }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
