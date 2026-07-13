// Zero-dependency PDF 1.4 renderer for data exports. Server-side only (uses
// node:buffer); consumed by export.mjs's "pdf" format branch.
//
// Audit rows carry arbitrary JSON payloads that don't fit a fixed-width grid,
// so instead of a table this renders each row as a record block: one
// `label: value` line per column (objects JSON-stringified, long lines
// wrapped), with a blank line and a horizontal-rule separator between
// records. US Letter portrait; page 1 opens with a title header and a
// generated-at timestamp; every page carries a "Page N of M" footer.
//
// Output is a syntactically complete, uncompressed PDF: header, catalog,
// page tree, Helvetica/Helvetica-Bold base fonts (WinAnsiEncoding), one
// content stream per page, an xref table with correct byte offsets, trailer,
// %%EOF. The whole document is assembled as a latin1-only string (non-Latin-1
// characters are mapped to "?"), so JS string offsets equal byte offsets and
// the xref can be computed over the exact bytes emitted.

import { Buffer } from "node:buffer";

const PAGE_WIDTH = 612; // US Letter portrait, in points
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const TITLE_SIZE = 16;
const META_SIZE = 9;
const BODY_SIZE = 10;
const FOOTER_SIZE = 9;
const LINE_GAP = 4; // added to the font size to get the line height
const FOOTER_ZONE = 24; // vertical space reserved above the bottom margin
const FOOTER_Y = 36; // baseline of the page-number footer
const WRAP_WIDTH = 88; // conservative char count for 10pt Helvetica in a 504pt column
const CONTINUATION_INDENT = "    ";
const SEPARATOR = "-".repeat(WRAP_WIDTH);

// Map anything outside printable Latin-1 to a safe stand-in: control chars
// become spaces (newlines are split into separate lines before this runs) and
// code points above 255 become "?", keeping the emitted document latin1-pure.
function sanitizeLatin1(text) {
  let out = "";
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    if (code > 255) out += "?";
    else if (code < 32) out += " ";
    else out += ch;
  }
  return out;
}

// Escape the PDF literal-string specials: backslash first, then parens.
function escapePdfString(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function stringifyValue(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

// Same column-resolution rule as export.mjs: explicit list wins, otherwise
// the sorted union of keys across every row.
function resolveColumns(rows, columns) {
  if (Array.isArray(columns) && columns.length > 0) return columns;
  const keys = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row ?? {})) keys.add(key);
  }
  return [...keys].sort();
}

// Greedy word wrap at `width` characters; a run with no break point is cut
// hard so pathological unbroken strings still fit.
function wrapText(text, width) {
  if (text.length <= width) return [text];
  const out = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(" ", width);
    if (cut <= 0) cut = width;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ +/, "");
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

// Flatten one `label: value` field into wrapped body lines. Embedded
// newlines in the value start fresh (indented) lines; wrap continuations are
// indented so a record's label column stays scannable.
function fieldLines(label, value) {
  const lines = [];
  const segments = value.split(/\r\n|\r|\n/).map(sanitizeLatin1);
  const contentWidth = WRAP_WIDTH - CONTINUATION_INDENT.length;
  segments.forEach((segment, index) => {
    const text = index === 0 ? `${label}: ${segment}` : segment;
    const wrapped = wrapText(text, index === 0 ? WRAP_WIDTH : contentWidth);
    wrapped.forEach((piece, pieceIndex) => {
      const indent = index === 0 && pieceIndex === 0 ? "" : CONTINUATION_INDENT;
      lines.push({ text: `${indent}${piece}`, font: "F1", size: BODY_SIZE });
    });
  });
  return lines;
}

// Build the full logical line list (title header, timestamp, record blocks)
// before pagination decides where the page breaks land.
function buildLines({ title, columns, rows }) {
  const lines = [
    { text: sanitizeLatin1(title), font: "F2", size: TITLE_SIZE },
    { text: `Generated at ${new Date().toISOString()}`, font: "F1", size: META_SIZE },
    { text: "", font: "F1", size: BODY_SIZE }
  ];
  const cols = resolveColumns(rows, columns);
  rows.forEach((row, index) => {
    for (const column of cols) {
      lines.push(...fieldLines(sanitizeLatin1(column), stringifyValue((row ?? {})[column])));
    }
    if (index < rows.length - 1) {
      lines.push({ text: "", font: "F1", size: BODY_SIZE });
      lines.push({ text: SEPARATOR, font: "F1", size: BODY_SIZE });
    }
  });
  return lines;
}

// Walk the y-cursor down each page, starting a new page when a line would
// land inside the reserved footer zone. Every line gets its final baseline y.
function paginate(lines) {
  const pages = [];
  let current = [];
  let y = PAGE_HEIGHT - MARGIN;
  for (const line of lines) {
    const lineHeight = line.size + LINE_GAP;
    if (y - lineHeight < MARGIN + FOOTER_ZONE) {
      pages.push(current);
      current = [];
      y = PAGE_HEIGHT - MARGIN;
    }
    y -= lineHeight;
    current.push({ ...line, y });
  }
  pages.push(current);
  return pages;
}

// One uncompressed content stream per page: a BT..ET text object per line
// plus the page-number footer. Uncompressed streams are valid PDF and keep
// this renderer dependency-free.
function renderContentStream(lines, pageNumber, pageCount) {
  const ops = [];
  for (const line of lines) {
    if (line.text.length === 0) continue;
    ops.push(
      `BT /${line.font} ${line.size} Tf ${MARGIN} ${line.y} Td (${escapePdfString(line.text)}) Tj ET`
    );
  }
  ops.push(
    `BT /F1 ${FOOTER_SIZE} Tf ${MARGIN} ${FOOTER_Y} Td (Page ${pageNumber} of ${pageCount}) Tj ET`
  );
  return ops.join("\n");
}

// Render rows into a complete PDF document. Returns a Buffer of the exact
// bytes (latin1). Object layout: 1 catalog, 2 page tree, 3 Helvetica,
// 4 Helvetica-Bold, then (page, content-stream) pairs from object 5 onward.
export function renderPdfDocument({ title = "Export", columns, rows = [] } = {}) {
  const pages = paginate(buildLines({ title, columns, rows: rows ?? [] }));

  const objects = [];
  const pageObjectNumbers = pages.map((_, index) => 5 + index * 2);
  objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[1] = `<< /Type /Pages /Kids [${pageObjectNumbers
    .map((n) => `${n} 0 R`)
    .join(" ")}] /Count ${pages.length} >>`;
  objects[2] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[3] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  pages.forEach((pageLines, index) => {
    const pageObjectNumber = pageObjectNumbers[index];
    const contentObjectNumber = pageObjectNumber + 1;
    objects[pageObjectNumber - 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjectNumber} 0 R >>`;
    const stream = renderContentStream(pageLines, index + 1, pages.length);
    // The document is latin1-only, so stream.length is its exact byte length.
    objects[contentObjectNumber - 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefOffset = out.length;
  out += `xref\n0 ${objects.length + 1}\n`;
  out += "0000000000 65535 f \n";
  for (const offset of offsets) {
    out += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
