// Real PDF extraction using Google Gemini API directly.
// Pipeline:
//   1. Receive base64 PDF from client.
//   2. Send the PDF directly to Gemini as inline base64 data.
//   3. Return the structured ExtractionResult JSON.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const EXTRACT_MODEL = "gemini-2.5-pro";

const EXTRACT_SCHEMA = {
  type: "OBJECT",
  properties: {
    company: { type: "STRING", description: "Company / reporting entity name" },
    period: { type: "STRING", description: "Reporting period e.g. 'FY 2024' or 'Year ended 31 Dec 2024'" },
    currency: { type: "STRING", description: "Reporting currency code, e.g. BHD, USD, EUR. Use empty string if unknown." },
    statementTitle: { type: "STRING", description: "Title of the P&L statement as printed in the report" },
    pnl: {
      type: "ARRAY",
      description: "P&L / income statement rows in document order",
      items: {
        type: "OBJECT",
        properties: {
          lineItem: { type: "STRING" },
          noteRef: { type: "STRING", description: "Note number printed next to this row, or empty string" },
          currentYear: { type: "NUMBER", description: "Use the latest period's value. Negative for expenses if shown that way." },
          priorYear: { type: "NUMBER" },
          page: { type: "INTEGER", description: "1-based page number where this row appears" },
        },
        required: ["lineItem", "noteRef", "currentYear", "priorYear", "page"],
      },
    },
    notes: {
      type: "ARRAY",
      description: "Note breakdown rows that explain P&L line items",
      items: {
        type: "OBJECT",
        properties: {
          parentLineItem: { type: "STRING", description: "Exact text of the P&L line this note explains" },
          noteTitle: { type: "STRING", description: "Heading of the note section" },
          component: { type: "STRING", description: "Sub-line / component name within the note" },
          currentYear: { type: "NUMBER" },
          priorYear: { type: "NUMBER" },
          page: { type: "INTEGER" },
          confidence: { type: "STRING", enum: ["high", "medium", "low"] },
          matchMethod: { type: "STRING", enum: ["explicit", "title", "semantic"] },
          flagged: { type: "BOOLEAN" },
        },
        required: ["parentLineItem", "noteTitle", "component", "currentYear", "priorYear", "page", "confidence", "matchMethod", "flagged"],
      },
    },
  },
  required: ["company", "period", "currency", "statementTitle", "pnl", "notes"],
};

const SYSTEM_PROMPT = "You are a financial-document extraction engine. You will be given a PDF of an annual report / audited financial statements. Your job: (1) locate the consolidated Profit & Loss / Income Statement (also called 'Statement of Profit or Loss', 'Statement of Comprehensive Income', or 'Income Statement'); (2) extract EVERY row in order, including subtotals like 'Gross profit', 'Operating profit', 'Profit for the year'; (3) capture both the latest period and the comparative prior period as numbers (parentheses = negative); (4) record the page number each row appears on; (5) then locate the explanatory notes that break down each P&L line and return their components. Match notes to P&L lines: prefer the explicit numeric note ref printed next to the P&L row; otherwise match by note title; otherwise infer semantically and flag with lower confidence. NEVER return empty arrays unless the document truly has no income statement — if you can see revenue/expense rows, you MUST return them.\n\nLANGUAGE / TRANSLATION RULES:\n- If the document is in English, copy line-item text, note titles, components, company name, period, and statement title VERBATIM.\n- If the document is in Arabic (or any non-English language), TRANSLATE all textual fields into clear, standard English financial terminology (e.g. 'الإيرادات' → 'Revenue', 'تكلفة المبيعات' → 'Cost of sales', 'إجمالي الربح' → 'Gross profit', 'مصاريف عمومية وإدارية' → 'General and administrative expenses', 'صافي الربح للسنة' → 'Net profit for the year').\n- Translate: company name (transliterate proper names if no English form is printed), period, statementTitle, lineItem, noteTitle, parentLineItem, component.\n- For bilingual documents that already show an English version next to the Arabic, USE the printed English text as-is.\n- NEVER translate or alter numeric values — keep digits, signs, and magnitudes exactly as printed (convert Arabic-Indic digits ٠-٩ to Western 0-9).\n- Currency codes must be returned in standard ISO form in English (e.g. BHD, SAR, AED, USD).\n- All output strings in the JSON MUST be in English regardless of the source language.";

function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function extractFromPdfWithGemini(pdfB64: string, apiKey: string) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EXTRACT_MODEL}:generateContent?key=${apiKey}`;

  const body = {
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            inline_data: {
              mime_type: "application/pdf",
              data: pdfB64,
            },
          },
          {
            text: "Extract the P&L statement and supporting notes from this PDF. Return via the return_extraction function.",
          },
        ],
      },
    ],
    tools: [
      {
        function_declarations: [
          {
            name: "return_extraction",
            description: "Return the structured P&L and note extraction.",
            parameters: EXTRACT_SCHEMA,
          },
        ],
      },
    ],
    tool_config: {
      function_calling_config: {
        mode: "ANY",
        allowed_function_names: ["return_extraction"],
      },
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const t = await resp.text();
    console.error("Gemini API error", resp.status, t);
    if (resp.status === 429) throw new Error("RATE_LIMIT");
    if (resp.status === 402 || resp.status === 403) throw new Error("PAYMENT_REQUIRED");
    throw new Error("EXTRACTION_FAILED");
  }

  const data = await resp.json();

  // Gemini returns function call in candidates[0].content.parts[0].functionCall
  const part = data.candidates?.[0]?.content?.parts?.[0];
  if (!part?.functionCall?.args) {
    console.error("Unexpected Gemini response:", JSON.stringify(data));
    throw new Error("AI returned no function call");
  }

  return part.functionCall.args;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

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

    const extracted = await extractFromPdfWithGemini(base64, apiKey);

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
