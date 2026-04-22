import * as XLSX from "xlsx";
import type { ExtractionResult, PnLRow, NoteRow } from "./mockExtractor";

// Subtotal rows that should NOT have notes nested under them, even if matched.
const SUBTOTAL_KEYWORDS = [
  "gross profit",
  "gross loss",
  "operating profit",
  "operating loss",
  "profit before tax",
  "loss before tax",
  "profit for the year",
  "loss for the year",
  "net profit",
  "net loss",
  "total comprehensive income",
  "profit/(loss)",
];

function isSubtotal(name: string) {
  const n = (name || "").toLowerCase().trim();
  return SUBTOTAL_KEYWORDS.some((k) => n.includes(k));
}

type Row = (string | number | null)[];

/**
 * Build a single-sheet income-statement view per file:
 *   Company header
 *   Statement title + period + currency
 *   Columns: Line Item | Note | Current Year | Prior Year | Page
 *   For each P&L row: print the row, then indent its matched notes below it.
 *   Subtotals (Gross profit, Operating profit, Net profit) are bolded.
 */
export function exportToXlsx(results: ExtractionResult[]) {
  const wb = XLSX.utils.book_new();
  const rows: Row[] = [];
  // Track which rows need styling: bold, header, subheader, indent
  const styleMap: Record<number, "title" | "company" | "meta" | "header" | "subtotal" | "note" | "blank"> = {};

  results.forEach((r, idx) => {
    if (idx > 0) {
      rows.push(["", "", "", "", ""]);
      styleMap[rows.length - 1] = "blank";
      rows.push(["", "", "", "", ""]);
      styleMap[rows.length - 1] = "blank";
    }

    // Company / file header
    rows.push([r.company || r.fileName, "", "", "", ""]);
    styleMap[rows.length - 1] = "company";

    rows.push([r.statementTitle || "Statement of Profit or Loss", "", "", "", ""]);
    styleMap[rows.length - 1] = "title";

    rows.push([`Period: ${r.period || "—"}`, "", `Currency: ${r.currency || "—"}`, "", `Source: ${r.fileName}`]);
    styleMap[rows.length - 1] = "meta";

    rows.push([]);
    styleMap[rows.length - 1] = "blank";

    // Column headers
    rows.push(["Line Item", "Note", "Current Year", "Prior Year", "Page"]);
    styleMap[rows.length - 1] = "header";

    // Group notes by parent P&L line id
    const notesByParent = new Map<string, NoteRow[]>();
    r.notes.forEach((n) => {
      const arr = notesByParent.get(n.parentLineItemId) ?? [];
      arr.push(n);
      notesByParent.set(n.parentLineItemId, arr);
    });

    r.pnl.forEach((p: PnLRow) => {
      const subtotal = isSubtotal(p.lineItem);
      rows.push([
        p.lineItem,
        p.noteRef ?? "",
        p.currentYear,
        p.priorYear,
        p.page ?? "",
      ]);
      styleMap[rows.length - 1] = subtotal ? "subtotal" : "blank";

      // Nest matched notes under this line (skip for subtotal rows)
      if (!subtotal) {
        const childNotes = notesByParent.get(p.id) ?? [];
        childNotes.forEach((n) => {
          rows.push([
            `    ${n.component}${n.noteTitle ? `  (${n.noteTitle})` : ""}`,
            "",
            n.currentYear,
            n.priorYear,
            n.page ?? "",
          ]);
          styleMap[rows.length - 1] = "note";
        });
      }
    });
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);

  // Column widths
  ws["!cols"] = [
    { wch: 60 }, // Line Item
    { wch: 8 },  // Note
    { wch: 18 }, // Current Year
    { wch: 18 }, // Prior Year
    { wch: 8 },  // Page
  ];

  // Apply cell formatting
  const numFmt = '#,##0;(#,##0);"-"';
  rows.forEach((_, rIdx) => {
    const kind = styleMap[rIdx];
    for (let c = 0; c < 5; c++) {
      const addr = XLSX.utils.encode_cell({ r: rIdx, c });
      const cell = ws[addr];
      if (!cell) continue;
      cell.s = cell.s || {};
      // Number formatting on the two value columns
      if ((c === 2 || c === 3) && typeof cell.v === "number") {
        cell.z = numFmt;
      }
      if (kind === "company") {
        cell.s = { font: { bold: true, sz: 14, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "1F3A5F" } } };
      } else if (kind === "title") {
        cell.s = { font: { bold: true, sz: 12, italic: true } };
      } else if (kind === "meta") {
        cell.s = { font: { sz: 10, color: { rgb: "555555" } } };
      } else if (kind === "header") {
        cell.s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "4A6FA5" } }, alignment: { horizontal: c >= 2 ? "right" : "left" } };
      } else if (kind === "subtotal") {
        cell.s = { font: { bold: true }, fill: { fgColor: { rgb: "EAF0F8" } }, border: { top: { style: "thin", color: { rgb: "888888" } }, bottom: { style: "thin", color: { rgb: "888888" } } } };
        if (typeof cell.v === "number") cell.z = numFmt;
      } else if (kind === "note") {
        cell.s = { font: { italic: true, sz: 10, color: { rgb: "333333" } }, alignment: { indent: 1 } };
        if (typeof cell.v === "number") cell.z = numFmt;
      }
    }
  });

  // Merge company / title across columns
  ws["!merges"] = ws["!merges"] || [];
  rows.forEach((_, rIdx) => {
    const kind = styleMap[rIdx];
    if (kind === "company" || kind === "title") {
      ws["!merges"]!.push({ s: { r: rIdx, c: 0 }, e: { r: rIdx, c: 4 } });
    }
  });

  XLSX.utils.book_append_sheet(wb, ws, "P&L Extract");
  XLSX.writeFile(wb, `pnl_extract_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export function exportToJson(results: ExtractionResult[]) {
  const blob = new Blob([JSON.stringify(results, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pnl_extract_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}