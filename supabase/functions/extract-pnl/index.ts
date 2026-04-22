// Real PDF extraction with AI-native PDF reading (handles scans via Gemini vision).
// Pipeline:
//   1. Receive base64 PDF from client.
//   2. Send the PDF directly to Gemini as a file attachment together with a
//      strict tool schema. Gemini natively reads both text-based and scanned
//      PDFs, so we don't need a separate text-extraction + OCR pass.
//   3. Return the structured ExtractionResult JSON.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
// Use Pro for extraction — better at reading messy financial tables (text + scanned).
const EXTRACT_MODEL = "google/gemini-2.5-pro";

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

// Send the PDF directly to Gemini and ask it to return structured P&L data
// via a tool call. Gemini reads PDFs natively (text + scans).
async function extractFromPdfWithGemini(pdfB64: string, apiKey: string) {
  const body = {
    model: EXTRACT_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a financial-document extraction engine. You will be given a PDF of an annual report / audited financial statements. Your job: (1) locate the consolidated Profit & Loss / Income Statement (also called 'Statement of Profit or Loss', 'Statement of Comprehensive Income', or 'Income Statement'); (2) extract EVERY row exactly as printed, in order, including subtotals like 'Gross profit', 'Operating profit', 'Profit for the year' — copy line-item text verbatim; (3) capture both the latest period and the comparative prior period as numbers (parentheses = negative); (4) record the page number each row appears on; (5) then locate the explanatory notes that break down each P&L line and return their components. Match notes to P&L lines: prefer the explicit numeric note ref printed next to the P&L row; otherwise match by note title; otherwise infer semantically and flag with lower confidence. NEVER return empty arrays unless the document truly has no income statement — if you can see revenue/expense rows, you MUST return them.",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Extract the P&L statement and supporting notes from this PDF. Return via the return_extraction tool." },
          { type: "image_url", image_url: { url: `data:application/pdf;base64,${pdfB64}` } },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "return_extraction",
          description: "Return the structured P&L and note extraction.",
          parameters: EXTRACT_SCHEMA,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "return_extraction" } },
  };

  const resp = await fetch(AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`AI gateway error ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  const call = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) throw new Error("AI returned no tool call");
  return JSON.parse(call.function.arguments);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) throw new Error("LOVABLE_API_KEY is not configured");

    const { fileName, base64 } = await req.json();
    if (!base64) throw new Error("Missing 'base64' in request body");

    // Sanity-check that the base64 decodes to a real PDF (starts with %PDF)
    try {
      const head = bytesFromBase64(base64.slice(0, 32));
      const sig = String.fromCharCode(...head.slice(0, 4));
      if (sig !== "%PDF") console.warn("Payload does not start with %PDF — got:", sig);
    } catch { /* ignore */ }

    const extracted = await extractFromPdfWithGemini(base64, apiKey);

    return new Response(
      JSON.stringify({ ...extracted, fileName }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("extract-pnl error:", e);
    const msg = e instanceof Error ? e.message : "Unknown error";
    const status = msg.includes("429") ? 429 : msg.includes("402") ? 402 : 500;
    return new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});