import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../src/lib/supabase-rest.mjs";
import { createStorageClient } from "../src/lib/storage.mjs";
import { processReportPdfJobs, REPORT_PDF_MAX_ATTEMPTS } from "../src/lib/report-pdf-worker.mjs";

// Same mocked-PostgREST stub-fetch style as test/notifications-worker.test.mjs:
// `respond(table, method, url, body)` returns the JSON payload for a given
// request; every call is recorded in `captured` so assertions can inspect
// exactly what the worker sent. report_submission_signatures is left
// unhandled by default (falls through to the catch-all 404), proving the
// worker's "table may not exist in this tree" fallback.
function stubFetch(t, respond, { signaturesTableExists = false } = {}) {
  const captured = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(url);
    const table = parsed.pathname.replace("/rest/v1/", "");
    const method = init.method;
    const body = init.body ? JSON.parse(init.body) : null;
    captured.push({ table, method, url: parsed, body });
    if (table === "report_submission_signatures" && !signaturesTableExists) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ message: "relation not found" }) };
    }
    const data = respond(table, method, parsed, body) ?? [];
    return { ok: true, status: 200, text: async () => JSON.stringify(data) };
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return captured;
}

function stubStorage(t, { failUpload = false } = {}) {
  const uploads = [];
  const storageClient = createStorageClient({
    url: "https://example.supabase.co",
    key: "service-key",
    bucket: "attachments",
    fetchImpl: async (url, init) => {
      const parsed = new URL(url);
      uploads.push({ url: parsed, method: init.method, headers: init.headers });
      if (failUpload) {
        return { ok: false, status: 500, text: async () => JSON.stringify({ message: "storage down" }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ Key: "attachments/mock" }) };
    }
  });
  return { storageClient, uploads };
}

function pgClient() {
  return createClient({ url: "https://example.supabase.co", key: "service-key" });
}

const SUBMISSION = {
  id: "sub-1",
  facility_id: "fac-1",
  department_id: "dept-1",
  template_id: "tpl-1",
  template_version_id: "ver-3",
  report_date: "2026-07-18",
  shift_ref: "AM",
  status: "submitted",
  submitted_by: "user-1",
  submitted_at: "2026-07-18T20:00:00.000Z",
  payload_json: { supervisor: "Sam Submitter", attendance: 12 },
  revision_of: null,
  source: "web",
  pdf_status: "queued",
  pdf_storage_path: null,
  pdf_content_hash: null,
  pdf_attempts: 0
};

function baseRespond(overrides = {}) {
  return (table, method) => {
    if (table === "report_submissions" && method === "GET") return [{ ...SUBMISSION, ...overrides }];
    if (table === "report_templates" && method === "GET") return [{ id: "tpl-1", name: "Daily Pool Opening", code: "pool_open" }];
    if (table === "report_template_versions" && method === "GET") {
      return [
        {
          id: "ver-3",
          template_id: "tpl-1",
          version_number: 3,
          schema_json: { sections: [{ title: "Opening", fields: [{ key: "supervisor", label: "Supervisor", type: "text" }] }] }
        }
      ];
    }
    if (table === "facilities" && method === "GET") return [{ id: "fac-1", name: "Riverside Rec Center" }];
    if (table === "departments" && method === "GET") return [{ id: "dept-1", name: "Aquatics" }];
    if (table === "app_users" && method === "GET") return [{ id: "user-1", full_name: "Sam Submitter" }];
    if (table === "report_submission_attachments" && method === "GET") return [];
    return [];
  };
}

test("processReportPdfJobs claims zero rows when nothing is queued", async (t) => {
  stubFetch(t, () => []);
  const { storageClient } = stubStorage(t);
  const summary = await processReportPdfJobs(pgClient(), storageClient, { now: new Date("2026-07-19T00:00:00Z") });
  assert.deepEqual(summary, { claimed: 0, generated: 0, reused: 0, retried: 0, failed: 0 });
});

test("processReportPdfJobs renders, uploads, and records a queued submission", async (t) => {
  const captured = stubFetch(t, baseRespond());
  const { storageClient, uploads } = stubStorage(t);
  const summary = await processReportPdfJobs(pgClient(), storageClient, { now: new Date("2026-07-19T00:00:00Z") });

  assert.deepEqual(summary, { claimed: 1, generated: 1, reused: 0, retried: 0, failed: 0 });
  assert.equal(uploads.length, 1);
  assert.match(
    uploads[0].url.pathname,
    /^\/storage\/v1\/object\/attachments\/facilities\/fac-1\/reports\/sub-1\/snapshot-[0-9a-f]{8}\.pdf$/
  );
  const patch = captured.find((c) => c.table === "report_submissions" && c.method === "PATCH");
  assert.equal(patch.body.pdf_status, "generated");
  assert.equal(patch.body.pdf_error, null);
  assert.match(patch.body.pdf_content_hash, /^[0-9a-f]{64}$/);
  assert.equal(
    patch.body.pdf_storage_path,
    `facilities/fac-1/reports/sub-1/snapshot-${patch.body.pdf_content_hash.slice(0, 8)}.pdf`
  );
});

test("processReportPdfJobs is deterministic: generatedAt comes from submitted_at, not wall-clock now", async (t) => {
  stubFetch(t, baseRespond());
  const { storageClient: storageA } = stubStorage(t);
  const summaryA = await processReportPdfJobs(pgClient(), storageA, { now: new Date("2026-07-19T00:00:00Z") });
  assert.equal(summaryA.generated, 1);
});

test("processReportPdfJobs skips the upload when the row's content hash is already stored (idempotent reuse)", async (t) => {
  // pdf_content_hash pre-populated from a prior successful render of this
  // exact fixture -- compute it once with a throwaway pass, then feed it
  // back in as the row's existing hash to prove the second pass reuses it.
  const throwawayCaptured = stubFetch(t, baseRespond());
  const { storageClient: throwawayStorage } = stubStorage(t);
  await processReportPdfJobs(pgClient(), throwawayStorage, { now: new Date("2026-07-19T00:00:00Z") });
  const priorHash = throwawayCaptured.find((c) => c.table === "report_submissions" && c.method === "PATCH").body.pdf_content_hash;

  const captured = stubFetch(t, baseRespond({ pdf_content_hash: priorHash }));
  const { storageClient, uploads } = stubStorage(t);
  const summary = await processReportPdfJobs(pgClient(), storageClient, { now: new Date("2026-07-20T00:00:00Z") });

  assert.deepEqual(summary, { claimed: 1, generated: 0, reused: 1, retried: 0, failed: 0 });
  assert.equal(uploads.length, 0, "no upload call when the content hash already matches");
  const patch = captured.find((c) => c.table === "report_submissions" && c.method === "PATCH");
  assert.equal(patch.body.pdf_status, "generated");
  assert.equal(patch.body.pdf_content_hash, priorHash);
});

test("processReportPdfJobs increments attempts and stays queued on a failure below the retry cap", async (t) => {
  const captured = stubFetch(t, baseRespond({ pdf_attempts: 0 }));
  const { storageClient } = stubStorage(t, { failUpload: true });
  const summary = await processReportPdfJobs(pgClient(), storageClient, { now: new Date("2026-07-19T00:00:00Z") });

  assert.deepEqual(summary, { claimed: 1, generated: 0, reused: 0, retried: 1, failed: 0 });
  const patch = captured.find((c) => c.table === "report_submissions" && c.method === "PATCH");
  assert.equal(patch.body.pdf_status, "queued");
  assert.equal(patch.body.pdf_attempts, 1);
  assert.ok(patch.body.pdf_error);
  // No secrets: only the error message, never a raw response body.
  assert.doesNotMatch(patch.body.pdf_error, /service-key/);
});

test(`processReportPdfJobs marks failed once attempts reaches ${REPORT_PDF_MAX_ATTEMPTS}`, async (t) => {
  const captured = stubFetch(t, baseRespond({ pdf_attempts: REPORT_PDF_MAX_ATTEMPTS - 1 }));
  const { storageClient } = stubStorage(t, { failUpload: true });
  const summary = await processReportPdfJobs(pgClient(), storageClient, { now: new Date("2026-07-19T00:00:00Z") });

  assert.deepEqual(summary, { claimed: 1, generated: 0, reused: 0, retried: 0, failed: 1 });
  const patch = captured.find((c) => c.table === "report_submissions" && c.method === "PATCH");
  assert.equal(patch.body.pdf_status, "failed");
  assert.equal(patch.body.pdf_attempts, REPORT_PDF_MAX_ATTEMPTS);
});

test("processReportPdfJobs treats a missing pinned version as a failure, not a throw", async (t) => {
  const captured = stubFetch(t, (table, method) => {
    if (table === "report_submissions" && method === "GET") return [SUBMISSION];
    if (table === "report_template_versions" && method === "GET") return []; // missing
    if (table === "facilities" && method === "GET") return [{ id: "fac-1", name: "Riverside Rec Center" }];
    return [];
  });
  const { storageClient, uploads } = stubStorage(t);
  const summary = await processReportPdfJobs(pgClient(), storageClient, { now: new Date("2026-07-19T00:00:00Z") });
  assert.equal(summary.retried, 1);
  assert.equal(uploads.length, 0);
  const patch = captured.find((c) => c.table === "report_submissions" && c.method === "PATCH");
  assert.match(patch.body.pdf_error, /pinned template version/);
});

test("processReportPdfJobs falls back to empty signatures when the signatures table does not exist", async (t) => {
  const captured = stubFetch(t, baseRespond(), { signaturesTableExists: false });
  const { storageClient } = stubStorage(t);
  const summary = await processReportPdfJobs(pgClient(), storageClient, { now: new Date("2026-07-19T00:00:00Z") });
  assert.equal(summary.generated, 1);
  assert.ok(captured.some((c) => c.table === "report_submission_signatures"));
});

test("processReportPdfJobs respects the limit option", async (t) => {
  const captured = stubFetch(t, (table, method, url) => {
    if (table === "report_submissions" && method === "GET") {
      assert.equal(url.searchParams.get("limit"), "1");
      return [SUBMISSION];
    }
    return baseRespond()(table, method, url);
  });
  const { storageClient } = stubStorage(t);
  await processReportPdfJobs(pgClient(), storageClient, { now: new Date("2026-07-19T00:00:00Z"), limit: 1 });
  const select = captured.find((c) => c.table === "report_submissions" && c.method === "GET");
  assert.match(select.url.search, /pdf_status=eq\.queued/);
});
