/* ============================================================
   Analytics report renderers — turn a ReportDoc into bytes.
   ------------------------------------------------------------
   CSV   : flat, multi-table with section/table headers.
   Excel : one worksheet per table + a Summary sheet (exceljs).
   PDF   : a formatted multi-section report (pdfkit).
   ============================================================ */

import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";
import type { CellFormat, ReportColumn, ReportDoc, ReportTable } from "./report";

export type ExportFormat = "csv" | "xlsx" | "pdf";

const numOf = (v: unknown): number => (v == null || v === "" ? 0 : Number(v));

/* ----------------------------- CSV ----------------------------- */
// Values stay machine-readable (raw numbers; percent expressed as a number),
// so the file re-imports cleanly into any spreadsheet. Column headers carry
// the unit (e.g. "Revenue", "Conv %").

function csvValue(value: unknown, format: CellFormat | undefined): string {
  switch (format) {
    case "money":
      return String(Math.round(numOf(value)));
    case "number":
      return String(numOf(value));
    case "percent":
      return (numOf(value) * 100).toFixed(1);
    default:
      return value == null ? "" : String(value);
  }
}

function escapeCsv(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function tableToCsvLines(table: ReportTable): string[] {
  const header = table.columns.map((c) => escapeCsv(c.label)).join(",");
  const rows = table.rows.map((row) =>
    table.columns.map((c) => escapeCsv(csvValue(row[c.key], c.format))).join(",")
  );
  return [header, ...rows];
}

export function renderCsv(doc: ReportDoc): Buffer {
  const lines: string[] = [];
  lines.push(escapeCsv(doc.title));
  lines.push(`${escapeCsv(doc.rangeLabel)},Generated ${new Date(doc.generatedAt).toLocaleString("en-IN")}`);

  const single = doc.sections.length === 1 && doc.sections[0].tables.length === 1 && !doc.sections[0].kpis?.length;

  for (const section of doc.sections) {
    if (!single) {
      lines.push("");
      lines.push(`# ${escapeCsv(section.title)}`);
    }
    if (section.kpis?.length) {
      lines.push("Metric,Value");
      for (const k of section.kpis) lines.push(`${escapeCsv(k.label)},${escapeCsv(k.value)}`);
    }
    for (const table of section.tables) {
      lines.push("");
      if (!single) lines.push(`## ${escapeCsv(table.title)}`);
      lines.push(...tableToCsvLines(table));
    }
  }
  // UTF-8 BOM so Excel renders ₹ and other non-ASCII correctly.
  return Buffer.from("﻿" + lines.join("\r\n"), "utf8");
}

/* ----------------------------- Excel ----------------------------- */

function numFmtFor(format: CellFormat | undefined): string | undefined {
  if (format === "money") return '"₹"#,##0';
  if (format === "percent") return "0.0%";
  if (format === "number") return "#,##0";
  return undefined;
}

function cellValue(value: unknown, format: CellFormat | undefined): string | number {
  if (format === "money" || format === "number" || format === "percent") return numOf(value);
  return value == null ? "" : String(value);
}

export async function renderXlsx(doc: ReportDoc): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "AV Creation";
  wb.created = new Date(doc.generatedAt);

  const used = new Set<string>();
  const sheetName = (raw: string): string => {
    let base = raw.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 28) || "Sheet";
    let name = base;
    let i = 2;
    while (used.has(name.toLowerCase())) name = `${base.slice(0, 25)} ${i++}`;
    used.add(name.toLowerCase());
    return name;
  };

  // Summary sheet — title, range, and every section's KPIs.
  const summary = wb.addWorksheet(sheetName("Summary"));
  summary.columns = [{ width: 28 }, { width: 22 }];
  summary.addRow([doc.title]).font = { bold: true, size: 14 };
  summary.addRow([doc.rangeLabel]);
  summary.addRow([`Generated ${new Date(doc.generatedAt).toLocaleString("en-IN")}`]).font = { italic: true, color: { argb: "FF888888" } };
  for (const section of doc.sections) {
    if (!section.kpis?.length) continue;
    summary.addRow([]);
    summary.addRow([section.title]).font = { bold: true, size: 12 };
    for (const k of section.kpis) summary.addRow([k.label, k.value]);
  }

  for (const section of doc.sections) {
    for (const table of section.tables) {
      const ws = wb.addWorksheet(sheetName(table.title));
      ws.columns = table.columns.map((c) => ({
        header: c.label,
        key: c.key,
        width: Math.min(40, Math.max(12, c.label.length + 4)),
        style: { numFmt: numFmtFor(c.format) },
      }));
      const head = ws.getRow(1);
      head.font = { bold: true, color: { argb: "FFFFFFFF" } };
      head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
      head.alignment = { vertical: "middle" };
      for (const row of table.rows) {
        const record: Record<string, string | number> = {};
        for (const c of table.columns) record[c.key] = cellValue(row[c.key], c.format);
        ws.addRow(record);
      }
      table.columns.forEach((c, idx) => {
        if (c.align === "right") ws.getColumn(idx + 1).alignment = { horizontal: "right" };
      });
      ws.views = [{ state: "frozen", ySplit: 1 }];
      if (table.rows.length > 0) {
        ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.columns.length } };
      }
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/* ----------------------------- PDF ----------------------------- */
// pdfkit's built-in Helvetica has no ₹ glyph, so money uses "Rs." (matches the
// invoice). A4 portrait; tables paginate and repeat their header per page.

const INK = "#1f2937";
const MUTED = "#6b7280";
const ACCENT = "#ea580c";
const LINE = "#e5e7eb";
const HEAD_BG = "#f3f4f6";
const ZEBRA = "#fafafa";

function pdfValue(value: unknown, format: CellFormat | undefined): string {
  switch (format) {
    case "money":
      return "Rs. " + Math.round(numOf(value)).toLocaleString("en-IN");
    case "number":
      return numOf(value).toLocaleString("en-IN");
    case "percent":
      return (numOf(value) * 100).toFixed(1) + "%";
    default:
      return value == null ? "" : String(value);
  }
}

/** Relative column widths — the first (label) column gets more room. */
function columnWeights(columns: ReportColumn[]): number[] {
  return columns.map((c, i) => (i === 0 && c.align !== "right" ? 2.4 : 1));
}

export function renderPdf(doc: ReportDoc): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margin: 40 });
    const chunks: Buffer[] = [];
    pdf.on("data", (c: Buffer) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    const left = pdf.page.margins.left;
    const right = pdf.page.width - pdf.page.margins.right;
    const width = right - left;
    const bottom = pdf.page.height - pdf.page.margins.bottom;

    // ── Report header ──
    pdf.fillColor(INK).font("Helvetica-Bold").fontSize(20).text("AV CREATION", left, 40);
    pdf.fillColor(ACCENT).font("Helvetica").fontSize(9).text("ANALYTICS REPORT", left, 64, { characterSpacing: 2 });
    pdf.fillColor(MUTED).font("Helvetica").fontSize(10).text(doc.rangeLabel, left, 40, { width, align: "right" });
    pdf.text(`Generated ${new Date(doc.generatedAt).toLocaleString("en-IN")}`, left, 54, { width, align: "right" });
    let y = 90;
    pdf.moveTo(left, y).lineTo(right, y).strokeColor(LINE).stroke();
    y += 18;

    const ensure = (need: number) => {
      if (y + need > bottom) {
        pdf.addPage();
        y = pdf.page.margins.top;
      }
    };

    const drawKpis = (kpis: { label: string; value: string }[]) => {
      const perRow = 3;
      const gap = 10;
      const cardW = (width - gap * (perRow - 1)) / perRow;
      const cardH = 46;
      for (let i = 0; i < kpis.length; i += perRow) {
        ensure(cardH + 6);
        const slice = kpis.slice(i, i + perRow);
        slice.forEach((k, j) => {
          const x = left + j * (cardW + gap);
          pdf.roundedRect(x, y, cardW, cardH, 6).fillColor("#fbfbfb").fill();
          pdf.roundedRect(x, y, cardW, cardH, 6).strokeColor(LINE).stroke();
          pdf.fillColor(MUTED).font("Helvetica").fontSize(8).text(k.label.toUpperCase(), x + 10, y + 9, { width: cardW - 20, characterSpacing: 0.5 });
          pdf.fillColor(INK).font("Helvetica-Bold").fontSize(14).text(k.value, x + 10, y + 22, { width: cardW - 20 });
        });
        y += cardH + 8;
      }
    };

    const drawTable = (table: ReportTable) => {
      ensure(40);
      pdf.fillColor(INK).font("Helvetica-Bold").fontSize(11).text(table.title, left, y);
      y += 18;

      const weights = columnWeights(table.columns);
      const totalW = weights.reduce((s, w) => s + w, 0);
      const colW = weights.map((w) => (width * w) / totalW);
      const rowH = 18;
      const pad = 5;

      const drawHeader = () => {
        pdf.rect(left, y, width, rowH).fillColor(HEAD_BG).fill();
        let x = left;
        table.columns.forEach((c, i) => {
          pdf.fillColor(MUTED).font("Helvetica-Bold").fontSize(7.5);
          pdf.text(c.label.toUpperCase(), x + pad, y + 5.5, {
            width: colW[i] - pad * 2,
            align: c.align === "right" ? "right" : "left",
            ellipsis: true,
            characterSpacing: 0.3,
          });
          x += colW[i];
        });
        y += rowH;
      };

      drawHeader();
      if (table.rows.length === 0) {
        pdf.fillColor(MUTED).font("Helvetica-Oblique").fontSize(8.5).text("No data in this range.", left + pad, y + 4);
        y += rowH + 6;
        return;
      }
      table.rows.forEach((row, idx) => {
        if (y + rowH > bottom) {
          pdf.addPage();
          y = pdf.page.margins.top;
          drawHeader();
        }
        if (idx % 2 === 1) pdf.rect(left, y, width, rowH).fillColor(ZEBRA).fill();
        let x = left;
        table.columns.forEach((c, i) => {
          pdf.fillColor(INK).font("Helvetica").fontSize(8);
          pdf.text(pdfValue(row[c.key], c.format), x + pad, y + 5.5, {
            width: colW[i] - pad * 2,
            align: c.align === "right" ? "right" : "left",
            ellipsis: true,
            lineBreak: false,
          });
          x += colW[i];
        });
        pdf.moveTo(left, y + rowH).lineTo(right, y + rowH).strokeColor(LINE).stroke();
        y += rowH;
      });
      y += 10;
    };

    doc.sections.forEach((section, si) => {
      ensure(30);
      if (doc.sections.length > 1 || (section.kpis && section.kpis.length)) {
        if (si > 0) y += 4;
        pdf.fillColor(ACCENT).font("Helvetica-Bold").fontSize(13).text(section.title, left, y);
        y += 20;
      }
      if (section.kpis?.length) drawKpis(section.kpis);
      section.tables.forEach(drawTable);
    });

    pdf.end();
  });
}
