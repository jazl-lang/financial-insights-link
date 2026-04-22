import * as XLSX from "xlsx";
import type { ExtractionResult } from "./mockExtractor";

export function exportToXlsx(results: ExtractionResult[]) {
  const wb = XLSX.utils.book_new();

  const summary = results.map((r) => ({
    "Source File": r.fileName,
    Company: r.company,
    Period: r.period,
    Currency: r.currency,
    Status: r.status,
    "P&L Lines": r.pnl.length,
    "Note Rows": r.notes.length,
    Error: r.error ?? "",
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), "Summary");

  const pnl = results.flatMap((r) =>
    r.pnl.map((p) => ({
      "Source File": r.fileName,
      Company: r.company,
      "Statement Title": r.statementTitle,
      "Line Item": p.lineItem,
      "Note Ref": p.noteRef ?? "",
      Currency: r.currency,
      "Current Year": p.currentYear,
      "Prior Year": p.priorYear,
      Page: p.page,
    })),
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(pnl), "P&L Extract");

  const noteRows = results.flatMap((r) =>
    r.notes.map((n) => {
      const parent = r.pnl.find((p) => p.id === n.parentLineItemId);
      return {
        "Source File": r.fileName,
        "Parent P&L Line": parent?.lineItem ?? "",
        "Matched Note Title": n.noteTitle,
        "Note Component": n.component,
        Currency: r.currency,
        "Current Year": n.currentYear,
        "Prior Year": n.priorYear,
        "Note Page": n.page,
        Confidence: n.confidence,
      };
    }),
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(noteRows), "Note Breakdown");

  const review = results.flatMap((r) =>
    r.notes.map((n) => {
      const parent = r.pnl.find((p) => p.id === n.parentLineItemId);
      return {
        "Source File": r.fileName,
        "P&L Line": parent?.lineItem ?? "",
        "Note Title": n.noteTitle,
        "Match Method": n.matchMethod,
        Confidence: n.confidence,
        "Flagged for Review": n.flagged ? "YES" : "",
      };
    }),
  );
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(review), "Match Review");

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