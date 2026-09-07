// DR-23 (plans/DAILY_REPORTS_PLAN.md): the async drain half of the PDF
// snapshot pipeline. report-pdf.mjs renders bytes from plain inputs and does
// no I/O of its own; this file is the I/O orchestration on top of it --
// pure orchestration over an injectable PostgREST client (service-role: the
// internal drain route, src/lib/http/internal-routes.mjs, is the only
// caller, and it always builds a service-role client, same as
// notifications/worker.mjs's drainAll) and an injectable Storage client
// (src/lib/storage.mjs's createStorageClientFromEnv). No HTTP/cron wiring
// lives here, matching notifications/worker.mjs's own split.
//
// Queue model: report_submissions.pdf_status IS the queue -- there is no
// separate outbox/job table for this pipeline. Another builder (DR-20's
// workflow execution) flips a freshly-submitted row's pdf_status to
// 'queued'; processReportPdfJobs below claims every row still in that state
// (oldest updated_at first, so a stuck retry doesn't starve newer
// submissions) and drives each one through render -> upload -> record.
//
// Determinism (DR-23's acceptance criterion): the Integrity block's
// "generated at" is always the submission's own submitted_at, NEVER
// wall-clock time -- so an original attempt and a later retry of the SAME
// row render byte-identical PDFs, and the derived hash (and therefore the
// Storage path) never drifts between attempts. `now` is only ever used for
// this module's own bookkeeping columns (updated_at), never handed to the
// renderer.
//
// Idempotency: a row already 'generated' is never selected (the query
// filters pdf_status = 'queued'). A row that becomes 'queued' again after
// already being generated once (a future re-queue path, not built by DR-23)
// re-renders, but since the content hash is a pure function of the
// submission's own immutable fields, an unchanged row reproduces the exact
// same hash -- and therefore the exact same Storage path -- so the upload
// (upsert: true) simply overwrites the object with byte-identical content
// instead of minting a new one; the DB write is a no-op patch in that case.
import { Buffer } from "node:buffer";
import { pgSelect, pgUpdate } from "./supabase-rest.mjs";
import { uploadObject } from "./storage.mjs";
import { buildReportSnapshotPdfPackage } from "./report-pdf.mjs";
import { reportError } from "./observability.mjs";

export const REPORT_PDF_MAX_ATTEMPTS = 3;
const DEFAULT_LIMIT = 25;

const SUBMISSION_COLUMNS =
  "id,facility_id,department_id,template_id,template_version_id,report_date,shift_ref,status," +
  "submitted_by,submitted_at,payload_json,revision_of,source,pdf_status,pdf_storage_path,pdf_content_hash,pdf_attempts";

// Best-effort load of a table that may not exist in this tree yet
// (DR-23's "signatures list if the table exists in this tree" instruction).
// pgSelect against an undefined relation surfaces as a PostgrestError from
// PostgREST (404/PGRST205, "table not found in schema cache") rather than a
// network failure, so any thrown error here is treated as "no such table,
// no signatures to show" -- never a reason to fail the whole render. The
// moment a report_submission_signatures table is added by a future builder,
// this starts returning real rows with zero changes required here.
async function loadSignaturesIfTableExists(client, submissionId) {
  try {
    const rows = await pgSelect(client, "report_submission_signatures", {
      filters: { submission_id: submissionId },
      select: "id,signer_name,role,signed_at",
      order: "signed_at.asc"
    });
    return rows ?? [];
  } catch {
    return [];
  }
}

async function loadOne(select, table, filters) {
  const rows = await select(table, filters);
  return (rows ?? [])[0] ?? null;
}

// Resolves everything renderReportSnapshotPdf needs for one submission row.
// Pinned version (never the template's current active version), matching
// admin/report-pdf.mjs's GET .../pdf route -- a re-publish after this
// submission was filed must not relabel a snapshot already on record.
async function loadSnapshotInputs(client, submission) {
  const select = (table, filters) => pgSelect(client, table, { filters, limit: 1 });

  const [template, version, facility, department, submitter, attachments, signatures] = await Promise.all([
    loadOne(
      (table, filters) => pgSelect(client, table, { filters, select: "id,name,code", limit: 1 }),
      "report_templates",
      { id: submission.template_id }
    ),
    loadOne(
      (table, filters) =>
        pgSelect(client, table, { filters, select: "id,template_id,version_number,schema_json", limit: 1 }),
      "report_template_versions",
      { id: submission.template_version_id }
    ),
    loadOne(
      (table, filters) => pgSelect(client, table, { filters, select: "id,name", limit: 1 }),
      "facilities",
      { id: submission.facility_id }
    ),
    submission.department_id
      ? loadOne(
          (table, filters) => pgSelect(client, table, { filters, select: "id,name", limit: 1 }),
          "departments",
          { id: submission.department_id }
        )
      : Promise.resolve(null),
    submission.submitted_by
      ? loadOne(
          (table, filters) => pgSelect(client, table, { filters, select: "id,full_name", limit: 1 }),
          "app_users",
          { id: submission.submitted_by }
        )
      : Promise.resolve(null),
    pgSelect(client, "report_submission_attachments", {
      filters: { submission_id: submission.id },
      select: "id,storage_path",
      order: "created_at.asc"
    }),
    loadSignaturesIfTableExists(client, submission.id)
  ]);

  return { template, version, facility, department, submitter, attachments: attachments ?? [], signatures };
}

// Renders + uploads one submission's snapshot. Never throws -- every failure
// mode (missing pinned version, render error, storage error) is caught and
// turned into { outcome: "failed"/"retried", error } so the caller can
// update attempts/pdf_error and move on to the next row without one bad
// submission wedging the whole drain pass.
async function processOne(client, storageClient, submission, { now, config }) {
  try {
    const { template, version, facility, department, submitter, attachments, signatures } = await loadSnapshotInputs(
      client,
      submission
    );
    if (!version || !facility) {
      throw new Error("report submission is missing its pinned template version or facility");
    }

    const pkg = buildReportSnapshotPdfPackage({
      submissionId: submission.id,
      facilityName: facility.name,
      departmentName: department?.name ?? null,
      templateName: template?.name ?? null,
      templateCode: template?.code ?? null,
      versionNumber: version.version_number,
      reportDate: submission.report_date,
      shiftRef: submission.shift_ref,
      status: submission.status,
      schema: version.schema_json,
      payload: submission.payload_json ?? {},
      submitterName: submitter?.full_name ?? null,
      // Deterministic on purpose (see module header): the row's OWN
      // submitted_at, never `now`.
      submittedAt: submission.submitted_at,
      revisionOf: submission.revision_of,
      attachments,
      signatures,
      generatedAt: submission.submitted_at,
      generatedBy: "system"
    });

    const path = `facilities/${submission.facility_id}/reports/${submission.id}/snapshot-${pkg.documentHash.slice(0, 8)}.pdf`;

    // Idempotent reuse: this query only ever selects pdf_status = 'queued'
    // rows, so by the time we get here submission.pdf_status is ALWAYS
    // 'queued' -- including for a row that was 'generated' before some
    // future re-queue path (not built by DR-23) flipped it back. The
    // signal that content hasn't actually changed since a prior successful
    // render is therefore pdf_content_hash, not pdf_status: an unchanged
    // row reproduces the identical hash (and therefore path), so skip the
    // upload round-trip entirely rather than re-uploading byte-identical
    // content to a path that already holds it.
    const alreadyStored = submission.pdf_content_hash != null && submission.pdf_content_hash === pkg.documentHash;
    if (!alreadyStored) {
      await uploadObject(storageClient, {
        path,
        body: Buffer.from(pkg.body, "base64"),
        contentType: "application/pdf",
        upsert: true
      });
    }

    await pgUpdate(
      client,
      "report_submissions",
      { id: submission.id },
      {
        pdf_status: "generated",
        pdf_storage_path: path,
        pdf_content_hash: pkg.documentHash,
        pdf_error: null,
        updated_at: now.toISOString()
      },
      { returning: false }
    );
    return { outcome: alreadyStored ? "reused" : "generated" };
  } catch (error) {
    const attempts = (submission.pdf_attempts ?? 0) + 1;
    const exhausted = attempts >= REPORT_PDF_MAX_ATTEMPTS;
    // No secrets: error.message only, never the raw Storage/PostgREST
    // response body (which can carry request headers/keys in some failure
    // shapes) -- same posture as notifications/worker.mjs's handleFailure.
    const message = String(error?.message ?? error ?? "unknown error").slice(0, 500);
    await pgUpdate(
      client,
      "report_submissions",
      { id: submission.id },
      {
        pdf_status: exhausted ? "failed" : "queued",
        pdf_attempts: attempts,
        pdf_error: message,
        updated_at: now.toISOString()
      },
      { returning: false }
    );
    reportError(error, {
      dsn: config?.dsn,
      fetchImpl: config?.observabilityFetch,
      route: "reports.pdf-worker",
      status: exhausted ? "failed" : "retry",
      requestId: submission.id,
      userId: null
    });
    return { outcome: exhausted ? "failed" : "retried", error: message };
  }
}

// Claims every report_submissions row with pdf_status = 'queued' (oldest
// updated_at first, capped at `limit`) and drives each through
// render -> upload -> record. Returns a summary
// { claimed, generated, reused, retried, failed } shaped like
// notifications/worker.mjs's drain summaries, for the internal drain route
// to fold into its own response body.
export async function processReportPdfJobs(client, storageClient, { limit = DEFAULT_LIMIT, now = new Date(), config = {} } = {}) {
  const rows = await pgSelect(client, "report_submissions", {
    filters: { pdf_status: "queued" },
    select: SUBMISSION_COLUMNS,
    order: "updated_at.asc",
    limit
  });

  const summary = { claimed: (rows ?? []).length, generated: 0, reused: 0, retried: 0, failed: 0 };
  for (const submission of rows ?? []) {
    const result = await processOne(client, storageClient, submission, { now, config });
    summary[result.outcome] += 1;
  }
  return summary;
}
