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

// Normalize a label so the same cost header from different files maps to the same row.
function normalizeKey(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s/&()-]/g, "")
    .trim();
}

type LineKind = "pnl" | "note";
interface LineDef {
  key: string;        // normalized key
  label: string;      // display label (first seen)
  kind: LineKind;
  parentKey?: string; // for notes: normalized key of parent P&L line
  subtotal: boolean;
  order: number;      // first-seen order across all files
}

/**
 * Comparative single-sheet export:
 *   Rows  = unique cost headers (P&L lines + indented note components), union across files.
 *   Cols  = each file/entity gets 2 columns (Current Year, Prior Year), separated by 1 blank column.
 *   Header: Entity name + period spanning its 2 columns.
 *   New cost headers found in later files are appended to the row list (not silently dropped).
 */
export function exportToXlsx(results: ExtractionResult[]) {
  const successful = results.filter((r) => r.status === "success" || r.pnl.length > 0);
  if (!successful.length) {
    // Fall back to empty workbook
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["No data"]]), "P&L Comparison");
    XLSX.writeFile(wb, `pnl_comparison_${new Date().toISOString().slice(0, 10)}.xlsx`);
    return;
  }

  // 1) Build the unified row list by walking every file in order.
  const lineMap = new Map<string, LineDef>();
  let orderCounter = 0;

  successful.forEach((r) => {
    // Index notes by parent P&L line id (file-scoped)
    const notesByParent = new Map<string, NoteRow[]>();
    r.notes.forEach((n) => {
      const arr = notesByParent.get(n.parentLineItemId) ?? [];
      arr.push(n);
      notesByParent.set(n.parentLineItemId, arr);
    });

    r.pnl.forEach((p: PnLRow) => {
      const pKey = normalizeKey(p.lineItem);
      if (!pKey) return;
      if (!lineMap.has(pKey)) {
        lineMap.set(pKey, {
          key: pKey,
          label: p.lineItem,
          kind: "pnl",
          subtotal: isSubtotal(p.lineItem),
          order: orderCounter++,
        });
      }

      if (!isSubtotal(p.lineItem)) {
        const childNotes = notesByParent.get(p.id) ?? [];
        childNotes.forEach((n) => {
          const nKey = `${pKey}::${normalizeKey(n.component)}`;
          if (!lineMap.has(nKey)) {
            lineMap.set(nKey, {
              key: nKey,
              label: `    ${n.component}`,
              kind: "note",
              parentKey: pKey,
              subtotal: false,
              order: orderCounter++,
            });
          }
        });
      }
    });
  });

  const lines = Array.from(lineMap.values()).sort((a, b) => a.order - b.order);

  // 2) Build per-file value lookup: key -> { cy, py }
  const fileValues: Array<Map<string, { cy: number | null; py: number | null }>> = successful.map((r) => {
    const m = new Map<string, { cy: number | null; py: number | null }>();
    const notesByParent = new Map<string, NoteRow[]>();
    r.notes.forEach((n) => {
      const arr = notesByParent.get(n.parentLineItemId) ?? [];
      arr.push(n);
      notesByParent.set(n.parentLineItemId, arr);
    });
    r.pnl.forEach((p) => {
      const pKey = normalizeKey(p.lineItem);
      if (!pKey) return;
      m.set(pKey, { cy: p.currentYear, py: p.priorYear });
      const childNotes = notesByParent.get(p.id) ?? [];
      childNotes.forEach((n) => {
        const nKey = `${pKey}::${normalizeKey(n.component)}`;
        m.set(nKey, { cy: n.currentYear, py: n.priorYear });
      });
    });
    return m;
  });

  // 3) Compose the sheet.
  // Column layout: col 0 = Line Item label.
  // Then for each file: [CY, PY, blank-spacer]. Spacer omitted after last file.
  const COL_LABEL = 0;
  const colsPerFile = 3; // CY, PY, blank
  const totalCols = 1 + successful.length * colsPerFile - 1; // drop trailing spacer

  // Row 1: Entity name + period, merged across that file's 2 value columns.
  // Row 2: Currency.
  // Row 3: "Current Year" / "Prior Year" sub-headers.
  // Row 4+: data rows.
  const rows: Row[] = [];

  const entityRow: Row = new Array(totalCols).fill("");
  const currencyRow: Row = new Array(totalCols).fill("");
  const subHeaderRow: Row = new Array(totalCols).fill("");
  subHeaderRow[COL_LABEL] = "Line Item";

  successful.forEach((r, i) => {
    const cyCol = 1 + i * colsPerFile;
    const pyCol = cyCol + 1;
    entityRow[cyCol] = `${r.company || r.fileName}${r.period ? ` — ${r.period}` : ""}`;
    currencyRow[cyCol] = r.currency ? `Currency: ${r.currency}` : "";
    subHeaderRow[cyCol] = "Current Year";
    subHeaderRow[pyCol] = "Prior Year";
  });

  rows.push(entityRow);
  rows.push(currencyRow);
  rows.push(subHeaderRow);

  const dataStartRow = rows.length;

  lines.forEach((ln) => {
    const row: Row = new Array(totalCols).fill("");
    row[COL_LABEL] = ln.label;
    successful.forEach((_r, i) => {
      const cyCol = 1 + i * colsPerFile;
      const pyCol = cyCol + 1;
      const v = fileValues[i].get(ln.key);
      row[cyCol] = v?.cy ?? "";
      row[pyCol] = v?.py ?? "";
    });
    rows.push(row);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);

  // Column widths
  const cols: { wch: number }[] = [{ wch: 50 }];
  for (let i = 0; i < successful.length; i++) {
    cols.push({ wch: 16 }); // CY
    cols.push({ wch: 16 }); // PY
    if (i < successful.length - 1) cols.push({ wch: 3 }); // spacer
  }
  ws["!cols"] = cols;

  // Merges: entity name across CY+PY for each file.
  ws["!merges"] = ws["!merges"] || [];
  successful.forEach((_r, i) => {
    const cyCol = 1 + i * colsPerFile;
    const pyCol = cyCol + 1;
    ws["!merges"]!.push({ s: { r: 0, c: cyCol }, e: { r: 0, c: pyCol } });
    ws["!merges"]!.push({ s: { r: 1, c: cyCol }, e: { r: 1, c: pyCol } });
  });

  // Freeze top 3 header rows + label column.
  ws["!freeze"] = { xSplit: 1, ySplit: 3 } as never;
  (ws as { [k: string]: unknown })["!views"] = [{ state: "frozen", xSplit: 1, ySplit: 3 }];

  // Styling
  const numFmt = '#,##0;(#,##0);"-"';
  const lastRow = rows.length - 1;

  for (let r = 0; r <= lastRow; r++) {
    for (let c = 0; c < totalCols; c++) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const cell = ws[addr];
      if (!cell) continue;

      // Spacer columns: skip styling
      const isSpacer =
        c > 0 && (c - 1) % colsPerFile === 2 && c !== totalCols; // every 3rd col after the label
      if (isSpacer) continue;

      // Entity header row
      if (r === 0 && c >= 1) {
        cell.s = {
          font: { bold: true, sz: 12, color: { rgb: "FFFFFF" } },
          fill: { fgColor: { rgb: "1F3A5F" } },
          alignment: { horizontal: "center" },
        };
        continue;
      }
      // Currency row
      if (r === 1 && c >= 1) {
        cell.s = {
          font: { italic: true, sz: 10, color: { rgb: "555555" } },
          alignment: { horizontal: "center" },
        };
        continue;
      }
      // Sub-header row (CY/PY + Line Item)
      if (r === 2) {
        cell.s = {
          font: { bold: true, color: { rgb: "FFFFFF" } },
          fill: { fgColor: { rgb: "4A6FA5" } },
          alignment: { horizontal: c === 0 ? "left" : "right" },
        };
        continue;
      }

      // Data rows
      const lineIdx = r - dataStartRow;
      const ln = lines[lineIdx];
      if (!ln) continue;

      if (typeof cell.v === "number") cell.z = numFmt;

      if (ln.subtotal) {
        cell.s = {
          font: { bold: true },
          fill: { fgColor: { rgb: "EAF0F8" } },
          border: {
            top: { style: "thin", color: { rgb: "888888" } },
            bottom: { style: "thin", color: { rgb: "888888" } },
          },
          alignment: { horizontal: c === 0 ? "left" : "right" },
        };
      } else if (ln.kind === "note") {
        cell.s = {
          font: { italic: true, sz: 10, color: { rgb: "333333" } },
          alignment: { horizontal: c === 0 ? "left" : "right", indent: c === 0 ? 1 : 0 },
        };
      } else {
        cell.s = {
          alignment: { horizontal: c === 0 ? "left" : "right" },
        };
      }
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "P&L Comparison");
  XLSX.writeFile(wb, `pnl_comparison_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

// Legacy per-file stacked layout, kept in case it is referenced elsewhere.
function _exportToXlsxLegacyStacked(results: ExtractionResult[]) {
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