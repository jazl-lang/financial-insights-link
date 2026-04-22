// Mock extraction pipeline. Designed so the shape matches what a real backend
// (PDF parse + OCR + note linking) would return. Swap `extractFromPdf` with a
// real API call later without touching UI code.

export type Confidence = "high" | "medium" | "low";

export interface PnLRow {
  id: string;
  lineItem: string;
  noteRef: string | null;
  currentYear: number | null;
  priorYear: number | null;
  page: number;
}

export interface NoteRow {
  id: string;
  parentLineItemId: string;
  noteTitle: string;
  component: string;
  currentYear: number | null;
  priorYear: number | null;
  page: number;
  confidence: Confidence;
  matchMethod: "explicit" | "title" | "semantic";
  flagged: boolean;
}

export interface ExtractionResult {
  fileId: string;
  fileName: string;
  status: "queued" | "processing" | "success" | "error";
  progress: number;
  error?: string;
  company: string;
  period: string;
  currency: string;
  statementTitle: string;
  pnl: PnLRow[];
  notes: NoteRow[];
}

const SAMPLE_COMPANIES = [
  { name: "Acme Industries PLC", period: "FY 2024", currency: "USD" },
  { name: "Northwind Holdings Ltd", period: "FY 2024", currency: "GBP" },
  { name: "Globex Manufacturing SA", period: "FY 2023", currency: "EUR" },
  { name: "Initech Technologies Inc", period: "FY 2024", currency: "USD" },
  { name: "Umbrella Group Bhd", period: "FY 2023", currency: "MYR" },
];

function rand(min: number, max: number) {
  return Math.round(min + Math.random() * (max - min));
}

function buildSamplePnl(seed: number): { pnl: PnLRow[]; notes: NoteRow[] } {
  const lines: Array<{ name: string; note: string | null; sign: 1 | -1; base: number }> = [
    { name: "Revenue", note: "5", sign: 1, base: 100000 + seed * 1000 },
    { name: "Cost of sales", note: "6", sign: -1, base: 60000 + seed * 500 },
    { name: "Gross profit", note: null, sign: 1, base: 40000 },
    { name: "Selling and distribution expenses", note: "7", sign: -1, base: 8000 },
    { name: "General and administrative expenses", note: "8", sign: -1, base: 12000 },
    { name: "Employee benefits expense", note: "9", sign: -1, base: 9000 },
    { name: "Depreciation and amortisation", note: "10", sign: -1, base: 3500 },
    { name: "Other operating expenses", note: "11", sign: -1, base: 1500 },
    { name: "Operating profit", note: null, sign: 1, base: 6000 },
    { name: "Finance costs", note: "12", sign: -1, base: 1200 },
    { name: "Profit before tax", note: null, sign: 1, base: 4800 },
    { name: "Income tax expense", note: "13", sign: -1, base: 1100 },
    { name: "Profit for the year", note: null, sign: 1, base: 3700 },
  ];

  const pnl: PnLRow[] = lines.map((l, i) => ({
    id: `pnl-${seed}-${i}`,
    lineItem: l.name,
    noteRef: l.note,
    currentYear: l.sign * l.base,
    priorYear: l.sign * Math.round(l.base * (0.85 + Math.random() * 0.2)),
    page: 42 + Math.floor(i / 6),
  }));

  const noteTemplates: Record<string, { title: string; components: string[] }> = {
    "5": { title: "Revenue", components: ["Sale of goods", "Services rendered", "Licensing income"] },
    "6": { title: "Cost of sales", components: ["Raw materials consumed", "Changes in inventory", "Direct labour"] },
    "7": { title: "Selling and distribution", components: ["Marketing & advertising", "Freight outwards", "Sales commissions"] },
    "8": { title: "General and administrative expenses", components: ["Office rent", "Legal & professional fees", "IT & communications", "Insurance"] },
    "9": { title: "Employee benefits", components: ["Salaries and wages", "Defined contribution plans", "Share-based payments", "Other staff costs"] },
    "10": { title: "Depreciation & amortisation", components: ["Depreciation of PP&E", "Amortisation of intangibles", "Right-of-use asset depreciation"] },
    "11": { title: "Other operating expenses", components: ["Foreign exchange loss", "Impairment of receivables", "Miscellaneous"] },
    "12": { title: "Finance costs", components: ["Interest on borrowings", "Interest on lease liabilities", "Bank charges"] },
    "13": { title: "Income tax", components: ["Current tax", "Deferred tax", "Prior year adjustments"] },
  };

  const notes: NoteRow[] = [];
  pnl.forEach((row) => {
    if (!row.noteRef) return;
    const tmpl = noteTemplates[row.noteRef];
    if (!tmpl) return;
    const total = Math.abs(row.currentYear ?? 0);
    const totalPrior = Math.abs(row.priorYear ?? 0);
    const weights = tmpl.components.map(() => Math.random() + 0.3);
    const wsum = weights.reduce((a, b) => a + b, 0);
    tmpl.components.forEach((c, i) => {
      const cy = Math.round((weights[i] / wsum) * total);
      const py = Math.round((weights[i] / wsum) * totalPrior);
      const conf: Confidence = row.noteRef ? "high" : Math.random() > 0.5 ? "medium" : "low";
      notes.push({
        id: `note-${row.id}-${i}`,
        parentLineItemId: row.id,
        noteTitle: tmpl.title,
        component: c,
        currentYear: row.currentYear && row.currentYear < 0 ? -cy : cy,
        priorYear: row.priorYear && row.priorYear < 0 ? -py : py,
        page: 60 + parseInt(row.noteRef, 10),
        confidence: conf,
        matchMethod: "explicit",
      flagged: false,
      });
    });
  });

  // Add an inferred / ambiguous match example
  const adminRow = pnl.find((p) => p.lineItem.includes("administrative"));
  if (adminRow && Math.random() > 0.5) {
    notes.push({
      id: `note-inferred-${seed}`,
      parentLineItemId: adminRow.id,
      noteTitle: "Administrative and general expenses",
      component: "Consultancy fees",
      currentYear: rand(200, 800),
      priorYear: rand(180, 700),
      page: 71,
      confidence: "low",
      matchMethod: "semantic",
      flagged: true,
    });
  }

  return { pnl, notes };
}

export function buildMockResult(fileName: string, idx: number): ExtractionResult {
  const meta = SAMPLE_COMPANIES[idx % SAMPLE_COMPANIES.length];
  const { pnl, notes } = buildSamplePnl(idx + 1);
  return {
    fileId: `${fileName}-${idx}-${Date.now()}`,
    fileName,
    status: "success",
    progress: 100,
    company: meta.name,
    period: meta.period,
    currency: meta.currency,
    statementTitle: "Consolidated Statement of Profit or Loss",
    pnl,
    notes,
  };
}

// Simulate async extraction with progress updates
export async function extractFromPdf(
  file: File,
  index: number,
  onProgress: (progress: number) => void,
): Promise<ExtractionResult> {
  const steps = [10, 25, 45, 65, 85, 100];
  for (const s of steps) {
    await new Promise((r) => setTimeout(r, 250 + Math.random() * 350));
    onProgress(s);
  }
  // Tiny chance of mock failure to exercise error UI
  if (Math.random() < 0.05) {
    throw new Error("Could not detect P&L statement (low text confidence)");
  }
  return buildMockResult(file.name, index);
}

export function getDemoResults(): ExtractionResult[] {
  return [
    buildMockResult("Acme_Industries_Annual_Report_2024.pdf", 0),
    buildMockResult("Northwind_Holdings_FY24.pdf", 1),
  ];
}

export function formatMoney(v: number | null, currency: string) {
  if (v === null || v === undefined) return "—";
  const sign = v < 0 ? "(" : "";
  const close = v < 0 ? ")" : "";
  return `${sign}${currency} ${Math.abs(v).toLocaleString()}${close}`;
}