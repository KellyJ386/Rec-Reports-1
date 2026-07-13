import test from "node:test";
import assert from "node:assert/strict";
import { renderPdfDocument } from "../src/lib/admin/pdf.mjs";

// The renderer emits latin1-only bytes, so latin1 decoding round-trips the
// exact byte content for string assertions.
function asText(document) {
  return Buffer.from(document).toString("latin1");
}

const SAMPLE_ROWS = [
  { id: "a", event_type: "config.changed", event_payload: { before: null, after: { locale: "en-US" } } },
  { id: "b", event_type: "config.changed", event_payload: { before: { locale: "en-US" }, after: null } }
];

test("renderPdfDocument emits a PDF 1.4 header and %%EOF trailer", () => {
  const text = asText(renderPdfDocument({ title: "Audit Export", rows: SAMPLE_ROWS }));
  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.equal(text.trimEnd().endsWith("%%EOF"), true);
});

test("renderPdfDocument emits catalog, page tree, fonts, and page objects", () => {
  const text = asText(renderPdfDocument({ title: "Audit Export", rows: SAMPLE_ROWS }));
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/Type \/Pages \/Kids \[5 0 R\] \/Count 1/);
  assert.match(text, /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/);
  assert.match(text, /\/BaseFont \/Helvetica-Bold \/Encoding \/WinAnsiEncoding/);
  // \b excludes "/Type /Pages" (the tree node) from the per-page matches.
  const pageObjects = text.match(/\/Type \/Page\b/g) ?? [];
  assert.equal(pageObjects.length, 1);
});

test("renderPdfDocument renders title, timestamp, labels, and a footer", () => {
  const text = asText(renderPdfDocument({ title: "Audit Export", rows: SAMPLE_ROWS }));
  assert.match(text, /\(Audit Export\) Tj/);
  assert.match(text, /\(Generated at \d{4}-\d{2}-\d{2}T.+\) Tj/);
  assert.match(text, /\(event_type: config\.changed\) Tj/);
  assert.match(text, /\(Page 1 of 1\) Tj/);
});

test("renderPdfDocument escapes parens and backslashes in values", () => {
  const rows = [{ note: "has (paren) and back\\slash" }];
  const text = asText(renderPdfDocument({ title: "Escapes", rows }));
  assert.ok(text.includes("has \\(paren\\) and back\\\\slash"));
  assert.equal(text.includes("has (paren)"), false);
});

test("renderPdfDocument replaces non-Latin-1 characters with ?", () => {
  const rows = [{ note: "café ✓ 日本" }];
  const text = asText(renderPdfDocument({ title: "Encoding", rows }));
  assert.match(text, /\(note: café \? \?\?\) Tj/);
});

test("renderPdfDocument paginates a large row set across multiple pages", () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    id: `row-${index}`,
    event_type: "config.changed",
    event_payload: { before: { seq: index }, after: { seq: index + 1 } }
  }));
  const text = asText(renderPdfDocument({ title: "Big Export", rows }));
  const pageObjects = text.match(/\/Type \/Page\b/g) ?? [];
  assert.ok(pageObjects.length >= 2, `expected >=2 pages, got ${pageObjects.length}`);
  assert.match(text, new RegExp(`\\(Page ${pageObjects.length} of ${pageObjects.length}\\) Tj`));
  assert.match(text, new RegExp(`/Count ${pageObjects.length} `));
});

test("renderPdfDocument xref offsets point at the emitted object headers", () => {
  const bytes = asText(renderPdfDocument({ title: "Offsets", rows: SAMPLE_ROWS }));

  const startxrefMatch = bytes.match(/startxref\n(\d+)\n%%EOF\n$/);
  assert.ok(startxrefMatch, "startxref block missing");
  const xrefOffset = Number(startxrefMatch[1]);
  assert.equal(bytes.slice(xrefOffset, xrefOffset + 5), "xref\n");

  const xrefSection = bytes.slice(xrefOffset, bytes.indexOf("trailer", xrefOffset));
  const entries = [...xrefSection.matchAll(/^(\d{10}) (\d{5}) ([fn]) $/gm)];
  const sizeMatch = bytes.match(/\/Size (\d+)/);
  assert.equal(entries.length, Number(sizeMatch[1]));

  entries.forEach((entry, index) => {
    if (index === 0) {
      assert.equal(entry[3], "f");
      return;
    }
    const offset = Number(entry[1]);
    assert.ok(
      bytes.slice(offset).startsWith(`${index} 0 obj\n`),
      `xref entry ${index} does not point at "${index} 0 obj" (offset ${offset})`
    );
  });
});

test("renderPdfDocument content stream lengths match their byte content", () => {
  const bytes = asText(renderPdfDocument({ title: "Lengths", rows: SAMPLE_ROWS }));
  const streams = [...bytes.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
  assert.ok(streams.length >= 1);
  for (const [, length, content] of streams) {
    assert.equal(Number(length), content.length);
  }
});

test("renderPdfDocument renders a header-only document for zero rows", () => {
  const text = asText(renderPdfDocument({ title: "Empty", rows: [] }));
  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.match(text, /\(Empty\) Tj/);
  assert.match(text, /\(Page 1 of 1\) Tj/);
});
