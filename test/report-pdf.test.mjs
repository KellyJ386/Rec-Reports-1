import test from "node:test";
import assert from "node:assert/strict";
import { renderReportSubmissionPdf, buildReportPdfPackage } from "../src/lib/admin/report-pdf.mjs";

const SCHEMA_V1 = {
  sections: [
    {
      title: "Opening",
      fields: [
        { key: "supervisor", label: "Supervisor", type: "text", required: true },
        { key: "attendance", label: "Attendance", type: "number", required: true },
        { key: "clean", label: "Pool Clean?", type: "checkbox", required: false }
      ]
    }
  ]
};

// A re-published version 2 renames the same field keys' labels -- proves the
// PDF must render from the PINNED version, not whatever is "current".
const SCHEMA_V2 = {
  sections: [
    {
      title: "Opening (v2)",
      fields: [
        { key: "supervisor", label: "Shift Lead", type: "text", required: true },
        { key: "attendance", label: "Head Count", type: "number", required: true },
        { key: "clean", label: "Pool Clean?", type: "checkbox", required: false }
      ]
    }
  ]
};

const BASE_ARGS = {
  submissionId: "sub-1",
  facilityName: "Riverside Rec Center",
  departmentName: "Aquatics",
  templateName: "Daily Opening",
  templateCode: "daily-open",
  reportDate: "2026-07-18",
  shiftRef: "AM",
  status: "submitted",
  schema: SCHEMA_V1,
  payload: { supervisor: "Sam", attendance: 42, clean: true },
  submitterName: "Sam Submitter",
  submittedAt: "2026-07-18T20:00:00.000Z",
  revisionMarker: "Original"
};

function asText(buffer) {
  return Buffer.from(buffer).toString("latin1");
}

// --- PDF structure (like test/pdf.test.mjs) ---------------------------------

test("renderReportSubmissionPdf emits a PDF 1.4 header and %%EOF trailer", () => {
  const text = asText(renderReportSubmissionPdf(BASE_ARGS));
  assert.ok(text.startsWith("%PDF-1.4\n"));
  assert.equal(text.trimEnd().endsWith("%%EOF"), true);
});

test("renderReportSubmissionPdf emits catalog, page tree, and font objects", () => {
  const text = asText(renderReportSubmissionPdf(BASE_ARGS));
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/Type \/Pages \/Kids/);
  assert.match(text, /\/BaseFont \/Helvetica \/Encoding \/WinAnsiEncoding/);
  assert.match(text, /\/BaseFont \/Helvetica-Bold \/Encoding \/WinAnsiEncoding/);
});

test("renderReportSubmissionPdf xref offsets point at the emitted object headers", () => {
  const bytes = asText(renderReportSubmissionPdf(BASE_ARGS));
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

test("renderReportSubmissionPdf content-stream Length matches its byte content", () => {
  const bytes = asText(renderReportSubmissionPdf(BASE_ARGS));
  const streams = [...bytes.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
  assert.ok(streams.length >= 1);
  for (const [, length, content] of streams) {
    assert.equal(Number(length), content.length);
  }
});

// --- Content: header, sections, footer --------------------------------------

test("renderReportSubmissionPdf includes the header block", () => {
  const text = asText(renderReportSubmissionPdf(BASE_ARGS));
  assert.match(text, /\(Facility: Riverside Rec Center\) Tj/);
  assert.match(text, /\(Department: Aquatics\) Tj/);
  assert.match(text, /\(Report Type: Daily Opening\) Tj/);
  assert.match(text, /\(Report Date: 2026-07-18\) Tj/);
});

test("renderReportSubmissionPdf includes a section heading and its fields", () => {
  const text = asText(renderReportSubmissionPdf(BASE_ARGS));
  assert.match(text, /== Opening ==/);
  assert.match(text, /\(Supervisor: Sam\) Tj/);
  assert.match(text, /\(Attendance: 42\) Tj/);
  assert.match(text, /\(Pool Clean\?: Yes\) Tj/);
});

test("renderReportSubmissionPdf includes the footer block", () => {
  const text = asText(renderReportSubmissionPdf(BASE_ARGS));
  assert.match(text, /\(Submitted By: Sam Submitter\) Tj/);
  assert.match(text, /\(Submitted At: 2026-07-18T20:00:00\.000Z\) Tj/);
  assert.match(text, /\(Revision: Original\) Tj/);
});

test("renderReportSubmissionPdf renders an unanswered field as '(no answer)'", () => {
  const text = asText(renderReportSubmissionPdf({ ...BASE_ARGS, payload: { supervisor: "Sam" } }));
  // pdf.mjs's PDF-string escaping backslash-escapes the literal parens in
  // "(no answer)" as \( and \) within the content stream.
  assert.match(text, /\(Attendance: \\\(no answer\\\)\) Tj/);
});

test("renderReportSubmissionPdf renders a false checkbox as 'No'", () => {
  const text = asText(renderReportSubmissionPdf({ ...BASE_ARGS, payload: { ...BASE_ARGS.payload, clean: false } }));
  assert.match(text, /\(Pool Clean\?: No\) Tj/);
});

// --- Pinned-version fidelity -------------------------------------------------

test("renderReportSubmissionPdf renders labels from the PINNED schema, not a later re-publish", () => {
  const pinned = asText(renderReportSubmissionPdf({ ...BASE_ARGS, schema: SCHEMA_V1 }));
  assert.match(pinned, /\(Supervisor: Sam\) Tj/);
  assert.doesNotMatch(pinned, /\(Shift Lead: Sam\) Tj/);

  const republished = asText(renderReportSubmissionPdf({ ...BASE_ARGS, schema: SCHEMA_V2 }));
  assert.match(republished, /\(Shift Lead: Sam\) Tj/);
  assert.doesNotMatch(republished, /\(Supervisor: Sam\) Tj/);
});

test("renderReportSubmissionPdf marks a revised submission's footer accordingly", () => {
  const text = asText(renderReportSubmissionPdf({ ...BASE_ARGS, revisionMarker: "Revised" }));
  assert.match(text, /\(Revision: Revised\) Tj/);
});

test("renderReportSubmissionPdf disambiguates a repeated field label", () => {
  const schema = {
    sections: [
      { title: "A", fields: [{ key: "note1", label: "Notes", type: "text" }] },
      { title: "B", fields: [{ key: "note2", label: "Notes", type: "text" }] }
    ]
  };
  const text = asText(
    renderReportSubmissionPdf({ ...BASE_ARGS, schema, payload: { note1: "first", note2: "second" } })
  );
  assert.match(text, /\(Notes: first\) Tj/);
  // The disambiguated label's own literal parens are backslash-escaped by
  // pdf.mjs's PDF-string escaping, same as the "(no answer)" case above.
  assert.match(text, /\(Notes \\\(2\\\): second\) Tj/);
});

// --- Export envelope ---------------------------------------------------------

test("buildReportPdfPackage returns the standard export envelope", () => {
  const pkg = buildReportPdfPackage(BASE_ARGS);
  assert.equal(pkg.contentType, "application/pdf");
  assert.equal(pkg.encoding, "base64");
  assert.match(pkg.filename, /^report-sub-1-.+\.pdf$/);
  const bytes = Buffer.from(pkg.body, "base64").toString("latin1");
  assert.ok(bytes.startsWith("%PDF-1.4\n"));
  assert.ok(bytes.trimEnd().endsWith("%%EOF"));
});
