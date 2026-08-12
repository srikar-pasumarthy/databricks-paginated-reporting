// Server-side PDF rendering of a banded report using pdfmake.
//
// We render into ONE pdfmake table so the column-header row repeats on every
// page (headerRows: 1). Group headers, detail rows, per-group summary bands,
// and the grand-total band are all emitted as styled rows of that table:
//
//   - group-header : a full-width band naming the current group value
//   - detail       : one row of formatted cell values (numbers right-aligned)
//   - group-summary: a bold band; aggregated columns show "Sum 1,234" etc.
//   - grand-total  : the same, across every row
//
// Standard PDF fonts (Helvetica) are used so no font files need bundling.

import PdfPrinter from 'pdfmake';
import type { TDocumentDefinitions, Content, TableCell } from 'pdfmake/interfaces';
import { aggLabel, type ReportLine, type ReportView } from './report-model.js';
import type { Report, ReportColumn } from './types.js';

// The 14 standard PDF fonts are built into every PDF viewer — no embedding.
const FONTS = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
};

const HEADER_FILL = '#1b3a57';
const HEADER_TEXT = '#ffffff';
const GROUP_FILLS = ['#e8eef4', '#f1f5f9'];
const SUMMARY_FILL = '#d7e3ef';
const GRAND_FILL = '#1b3a57';

function isNumeric(col: ReportColumn): boolean {
  return col.type === 'number';
}

/** Header row: one bold, filled cell per column (numeric labels right-aligned). */
function headerRow(columns: ReportColumn[]): TableCell[] {
  return columns.map((c) => ({
    text: c.label,
    bold: true,
    color: HEADER_TEXT,
    fillColor: HEADER_FILL,
    alignment: isNumeric(c) ? 'right' : 'left',
    fontSize: 8,
  }));
}

/** A full-width group-header band (colSpan across all columns). */
function groupHeaderRow(line: Extract<ReportLine, { type: 'group-header' }>, columns: ReportColumn[]): TableCell[] {
  const fill = GROUP_FILLS[Math.min(line.level, GROUP_FILLS.length - 1)];
  const first: TableCell = {
    text: [
      { text: `${line.label}: `, bold: false, color: '#5a6b7b' },
      { text: line.value, bold: true },
    ],
    colSpan: columns.length,
    fillColor: fill,
    margin: [2 + line.level * 8, 3, 2, 3],
    fontSize: 8.5,
  };
  // colSpan requires (n-1) placeholder cells.
  const rest: TableCell[] = Array.from({ length: columns.length - 1 }, () => ({}) as TableCell);
  return [first, ...rest];
}

function detailRow(cells: string[], columns: ReportColumn[]): TableCell[] {
  return cells.map((v, i) => ({
    text: v,
    alignment: isNumeric(columns[i]) ? 'right' : 'left',
    fontSize: 7.5,
    margin: [2, 1, 2, 1],
  }));
}

/** Build a summary band; aggregated columns show "Sum 1,234", first cell labels it. */
function summaryRow(
  cells: (string | null)[],
  columns: ReportColumn[],
  leadLabel: string,
  count: number,
  fill: string,
  grand: boolean,
): TableCell[] {
  const textColor = grand ? '#ffffff' : '#1b3a57';
  let labelPlaced = false;
  return columns.map((col, i) => {
    const val = cells[i];
    if (val !== null && col.agg !== 'none') {
      const prefix = aggLabel(col.agg);
      return {
        text: `${prefix} ${val}`,
        bold: true,
        color: textColor,
        fillColor: fill,
        alignment: 'right',
        fontSize: 7.5,
        margin: [2, 2, 2, 2],
      } as TableCell;
    }
    // Place the leading label in the first non-aggregated cell.
    if (!labelPlaced) {
      labelPlaced = true;
      return {
        text: `${leadLabel} (${count.toLocaleString('en-US')} rows)`,
        bold: true,
        italics: true,
        color: textColor,
        fillColor: fill,
        alignment: 'left',
        fontSize: 7.5,
        margin: [2, 2, 2, 2],
      } as TableCell;
    }
    return { text: '', fillColor: fill } as TableCell;
  });
}

function buildTableBody(view: ReportView): TableCell[][] {
  const { columns } = view;
  const body: TableCell[][] = [headerRow(columns)];

  for (const line of view.lines) {
    switch (line.type) {
      case 'group-header':
        body.push(groupHeaderRow(line, columns));
        break;
      case 'detail':
        body.push(detailRow(line.cells, columns));
        break;
      case 'group-summary':
        body.push(summaryRow(line.cells, columns, 'Subtotal', line.count, SUMMARY_FILL, false));
        break;
      case 'grand-total':
        body.push(summaryRow(line.cells, columns, 'Grand total', line.count, GRAND_FILL, true));
        break;
    }
  }
  return body;
}

export async function generatePdf(report: Report, view: ReportView): Promise<Buffer> {
  const printer = new PdfPrinter(FONTS);

  const groupNames = report.group_by
    .map((g) => report.columns.find((c) => c.name === g)?.label ?? g)
    .join(' › ');
  const generatedAt = new Date().toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const intro: Content[] = [
    { text: report.name, style: 'title' },
    {
      columns: [
        { text: report.source_table ?? '', style: 'subtle' },
        { text: `Generated ${generatedAt}`, style: 'subtle', alignment: 'right' },
      ],
      margin: [0, 2, 0, 0],
    },
  ];
  if (groupNames) {
    intro.push({ text: `Grouped by: ${groupNames}`, style: 'subtle', margin: [0, 2, 0, 6] });
  } else {
    intro.push({ text: '', margin: [0, 0, 0, 6] });
  }

  const docDefinition: TDocumentDefinitions = {
    // pdfmake's predefined page sizes are upper-case (A4, LETTER).
    pageSize: report.page_size === 'Letter' ? 'LETTER' : 'A4',
    pageOrientation: report.orientation,
    pageMargins: [28, 32, 28, 40],
    defaultStyle: { font: 'Helvetica', fontSize: 8 },
    styles: {
      title: { fontSize: 16, bold: true, color: '#1b3a57' },
      subtle: { fontSize: 8, color: '#5a6b7b' },
    },
    content: [
      ...intro,
      {
        table: {
          headerRows: 1,
          dontBreakRows: true,
          widths: view.columns.map(() => '*'),
          body: buildTableBody(view),
        },
        layout: {
          hLineWidth: () => 0.5,
          vLineWidth: () => 0.5,
          hLineColor: () => '#c7d2dd',
          vLineColor: () => '#c7d2dd',
        },
      },
    ],
    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        { text: report.name, style: 'subtle', margin: [28, 0, 0, 0] },
        {
          text: `Page ${currentPage} of ${pageCount}`,
          alignment: 'right',
          style: 'subtle',
          margin: [0, 0, 28, 0],
        },
      ],
      margin: [0, 12, 0, 0],
    }),
  };

  const pdfDoc = printer.createPdfKitDocument(docDefinition);
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    pdfDoc.on('data', (c: Buffer) => chunks.push(c));
    pdfDoc.on('end', () => resolve(Buffer.concat(chunks)));
    pdfDoc.on('error', reject);
    pdfDoc.end();
  });
}
