// Real PDF extraction with OCR fallback + AI-assisted P&L/notes parsing.
// Pipeline:
//   1. Decode base64 PDF
//   2. Try text extraction with unpdf (pdf.js under the hood)
//   3. If text density is too low (likely scanned), render pages to images
//      and run OCR via Gemini vision
//   4. Send the extracted text to Gemini with a strict tool schema and return
//      structured ExtractionResult JSON.

import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const TEXT_MODEL = "google/gemini-2.5-flash";
const VISION_MODEL = "google/gemini-2.5-flash";

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

async function uint8ToBase64(u8: Uint8Array): Promise<string> {
  // chunk to avoid call stack issues
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    binary += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// OCR fallback: pass the entire PDF directly to Gemini as a file attachment.
// Gemini natively reads PDFs (including scanned ones via its vision pipeline),
// avoiding the need to render pages ourselves in the edge runtime.
async function ocrWithGeminiPdf(pdfB64: string, apiKey: string): Promise<string> {
  const resp = await fetch(AI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "This is a scanned annual report. Transcribe ALL text on every page in order. Preserve table structure using pipes (|) between columns. At the start of each page output a marker line exactly: '===== PAGE N =====' where N is the page number. Output only the transcription, no commentary.",
            },
            { type: "image_url", image_url: { url: `data:application/pdf;base64,${pdfB64}` } },
          ],
        },
      ],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`Vision OCR failed ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function extractTextFromPdf(pdfBytes: Uint8Array): Promise<{ text: string; pages: string[]; weak: boolean; totalPages: number }> {
  const pdf = await getDocumentProxy(pdfBytes);
  const totalPages = pdf.numPages;
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text as string[] : [String(text)];
  const joined = pages.map((t, i) => `\n\n===== PAGE ${i + 1} =====\n${t}`).join("\n");
  // "weak" if average chars per page is very low — likely scanned
  const avg = joined.length / Math.max(1, totalPages);
  const weak = avg < 200;
  return { text: joined, pages, weak, totalPages };
}

async function callAiForStructured(text: string, apiKey: string) {
  // Truncate very long text to keep tokens reasonable
  const MAX_CHARS = 180_000;
  const trimmed = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + "\n[...truncated...]" : text;

  const body = {
    model: TEXT_MODEL,
    messages: [
      {
        role: "system",
        content:
          "You are a financial-document extraction engine. Given the raw text of an annual report or financial statements, locate the consolidated Profit & Loss / Income Statement and the explanatory notes that break down each P&L line item. Be precise: copy line-item names verbatim, preserve negative signs for expenses if printed with parentheses, and capture page numbers from the '===== PAGE N =====' markers. Match notes to P&L lines: prefer explicit numeric note refs printed beside the P&L row; otherwise match by note title; otherwise infer semantically and flag with lower confidence. If you cannot find a P&L statement, return empty arrays.",
      },
      { role: "user", content: trimmed },
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

    const pdfBytes = bytesFromBase64(base64);
    let { text, weak, totalPages } = await extractTextFromPdf(pdfBytes);
    let usedOcr = false;

    if (weak) {
      console.log(`Weak text (${text.length} chars / ${totalPages} pages) — falling back to OCR`);
      try {
        const ocrText = await ocrWithGeminiPdf(base64, apiKey);
        if (ocrText && ocrText.length > text.length) {
          text = ocrText;
          usedOcr = true;
        }
      } catch (e) {
        console.warn("OCR fallback failed:", e);
      }
    }

    if (!text || text.trim().length < 50) {
      throw new Error("Could not extract any usable text from the PDF");
    }

    const extracted = await callAiForStructured(text, apiKey);

    return new Response(
      JSON.stringify({ ...extracted, fileName, totalPages, usedOcr }),
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