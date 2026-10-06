// TR-11 (plans/TRAINING_PLAN.md): the certification expiry evaluator. Runs
// from the CRON_SECRET-guarded drain (src/lib/http/internal-routes.mjs,
// response key `trainingCertExpiry`) and standalone as
// scripts/training-cert-expiry.mjs, always against a service-role client.
//
// What one pass does:
//   1. Selects the not-revoked, not-deleted employee_certifications whose
//      expires_at falls in [today - 30 days, today + 365 days] (a bounded
//      window: older lapses were reported long ago, and a notice further out
//      than the longest lead time configurable is pointless), paged.
//   2. Classifies each with certificationStatus (training.mjs -- the SAME
//      function the wallet, the cert-gaps report and the scheduling gate use)
//      and, per facility, the training.certExpiryLeadDays setting
//      (default "30,14,7"):
//        status 'expired'   -> one 'expired' notice;
//        otherwise          -> the TIGHTEST lead time already reached
//                              (days until expiry <= lead) gets one
//                              'expiring' notice; a pass that was skipped for
//                              a few days therefore sends one notice for the
//                              nearest lead, not one per missed lead.
//   3. Each notice is CLAIMED before any side effect by inserting a
//      training_cert_notices row, UNIQUE(certification, kind, lead_days,
//      expiry date) -- a conflicting insert (ON CONFLICT DO NOTHING) means a
//      previous or concurrent pass already owns that notice, so a re-run
//      produces nothing, and a RENEWED certification (new expiry date) starts
//      a fresh set of notices. 'expired' additionally writes ONE
//      certification_events row (event_type 'expired', payload carries the
//      expiry date; a lookup before the insert keeps even a claim-retry from
//      writing it twice), and both kinds enqueue ONE notification_jobs row
//      (event cert.expired / cert.expiring) for the facility's active route's
//      distribution list plus the certification's own employee, with a
//      payload dedupeKey checked before inserting. notification_jobs.dedupe_key
//      (0058) is deliberately NOT used: that column's BEFORE INSERT trigger
//      rewrites any non-null key into a facility:event:incident:escalation:
//      recipient string, which would collapse every cert notice of one
//      recipient into a single key.
//   4. CLAIM REVERT (the work-order-sla-scan pattern): a failure after a
//      successful claim deletes the claim row again (scoped to its id) and is
//      recorded in summary.errors, so the next pass retries it; a failure
//      inside one certification never aborts the rest of the pass.
//
// A facility with no active route for the event gets no 'expiring' claim at
// all (summary.noRoute) -- so the notice goes out once a route exists -- but
// an 'expired' transition still records its certification_events row.
// employee_certifications.status is NOT rewritten: a renewal that only moves
// expires_at must keep working, and the scheduling gate already reads expiry
// through certificationStatus.
import { pgSelect, pgInsert, pgDelete } from "./supabase-rest.mjs";
import { resolveRoute, expandDistributionList, isWithinQuietHours, buildNotificationJob } from "./admin/notifications.mjs";
import { nextQuietWindowEnd } from "./notifications/worker.mjs";
import { configValue } from "./settings-registry.mjs";
import { certificationStatus } from "./training.mjs";
import { makeConfigLoader } from "./http/module-config.mjs";

const TRAINING_MODULE_CODE = "training";
const EVENT_EXPIRING = "cert.expiring";
const EVENT_EXPIRED = "cert.expired";
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRED_LOOKBACK_DAYS = 30;
const LOOKAHEAD_DAYS = 365;
const PAGE_SIZE = 200;
const MAX_PAGES = 10;
const CLAIM_CONFLICT_TARGET = "employee_certification_id,notice_kind,lead_days,cert_expires_at";

const CERT_COLUMNS = "id,facility_id,employee_id,certification_type_id,expires_at,status";

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function dateOnly(value) {
  return String(value).slice(0, 10);
}

function toHHMM(date) {
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

// Parses the comma-separated lead-time setting into a sorted, de-duplicated
// list of positive integers (ascending); anything unparseable falls back to
// the shipped default so a bad stored value can never silence the evaluator.
export function parseLeadDays(raw) {
  const parsed = String(raw ?? "")
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= LOOKAHEAD_DAYS);
  const unique = [...new Set(parsed)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : [7, 14, 30];
}

// Decides the notice (if any) a certification is owed right now.
//   -> { kind: "expired", leadDays: 0 }
//   -> { kind: "expiring", leadDays }  (the tightest lead already reached)
//   -> null                              (revoked, no expiry, or not yet within any lead)
export function noticeFor(cert, now, leadDays, config = {}) {
  if (!cert.expires_at) return null;
  const status = certificationStatus({ status: cert.status, expiresAt: cert.expires_at }, now, config);
  if (status === "revoked") return null;
  if (status === "expired") return { kind: "expired", leadDays: 0 };
  const daysUntil = Math.ceil((new Date(cert.expires_at).getTime() - now.getTime()) / DAY_MS);
  const reached = leadDays.filter((lead) => daysUntil <= lead);
  if (reached.length === 0) return null;
  return { kind: "expiring", leadDays: Math.min(...reached), daysUntil };
}

export function dedupeKeyFor(cert, notice) {
  return `${cert.id}:${notice.kind}:${notice.leadDays}:${dateOnly(cert.expires_at)}`;
}

async function resolveRecipients(client, facilityId, eventCode) {
  const routes = await pgSelect(client, "notification_routes", {
    filters: { facility_id: facilityId, event_code: eventCode, active: true },
    select: "id,facility_id,event_code,priority,route_jsonb,active"
  });
  const route = resolveRoute(eventCode, routes ?? []);
  const listId = route?.route_jsonb?.distributionListId ?? null;
  if (!route) return { route: null, recipients: [] };
  if (!listId) return { route, recipients: [] };

  const [listRows, members, employees] = await Promise.all([
    pgSelect(client, "distribution_lists", {
      filters: { id: listId, facility_id: facilityId },
      select: "id,facility_id,name,active",
      limit: 1
    }),
    pgSelect(client, "distribution_list_members", {
      filters: { distribution_list_id: listId, facility_id: facilityId },
      select: "id,facility_id,distribution_list_id,member_type,member_ref_id"
    }),
    pgSelect(client, "employees", { filters: { facility_id: facilityId }, select: "id" })
  ]);
  const list = (listRows ?? [])[0] ?? { id: listId };
  return { route, recipients: expandDistributionList(list, members ?? [], { employees: employees ?? [] }) };
}

async function jobAlreadyEnqueued(client, facilityId, dedupeKey) {
  const rows = await pgSelect(client, "notification_jobs", {
    filters: { facility_id: facilityId },
    select: "id",
    limit: 1,
    extra: { "payload_jsonb->>dedupeKey": `eq.${dedupeKey}` }
  });
  return (rows ?? []).length > 0;
}

async function expiredEventExists(client, cert) {
  const rows = await pgSelect(client, "certification_events", {
    filters: { facility_id: cert.facility_id, employee_certification_id: cert.id, event_type: "expired" },
    select: "id",
    limit: 1,
    extra: { "payload_jsonb->>expiresAt": `eq.${dateOnly(cert.expires_at)}` }
  });
  return (rows ?? []).length > 0;
}

async function claimNotice(client, cert, notice) {
  const rows = await pgInsert(
    client,
    "training_cert_notices",
    [
      {
        facility_id: cert.facility_id,
        employee_certification_id: cert.id,
        notice_kind: notice.kind,
        lead_days: notice.leadDays,
        cert_expires_at: dateOnly(cert.expires_at)
      }
    ],
    { onConflict: CLAIM_CONFLICT_TARGET, ignoreDuplicates: true, returning: true }
  );
  return (rows ?? [])[0] ?? null;
}

async function revertClaim(client, claim) {
  await pgDelete(client, "training_cert_notices", { id: claim.id, facility_id: claim.facility_id });
}

// scanCertificationExpiry(client, { now, loadConfig, config }) -> summary.
// `loadConfig({ facilityId, moduleCode })` resolves a facility's effective
// training settings (default: makeConfigLoader(client); registry defaults on
// any lookup failure). `config.quietHoursStart/End` mirror the other drain
// consumers' optional overrides.
export async function scanCertificationExpiry(
  client,
  { now = new Date(), loadConfig = makeConfigLoader(client), config = {} } = {}
) {
  const summary = {
    scanned: 0,
    expiredNotices: 0,
    expiringNotices: 0,
    eventsWritten: 0,
    jobsEnqueued: 0,
    deduped: 0,
    noRoute: 0,
    disabled: 0,
    errors: []
  };

  const quietStart = config.quietHoursStart ?? configValue({}, "reports.quietHoursStart");
  const quietEnd = config.quietHoursEnd ?? configValue({}, "reports.quietHoursEnd");
  const nowHHMM = toHHMM(now);
  const nowIso = toIso(now);
  const windowStart = dateOnly(new Date(now.getTime() - EXPIRED_LOOKBACK_DAYS * DAY_MS).toISOString());
  const windowEnd = dateOnly(new Date(now.getTime() + LOOKAHEAD_DAYS * DAY_MS).toISOString());

  const routeCache = new Map(); // `${facilityId}:${eventCode}` -> Promise<{route, recipients}>
  function recipientsFor(facilityId, eventCode) {
    const key = `${facilityId}:${eventCode}`;
    if (!routeCache.has(key)) routeCache.set(key, resolveRecipients(client, facilityId, eventCode));
    return routeCache.get(key);
  }
  const typeCache = new Map(); // certificationTypeId -> Promise<{id,name}|null>
  function certTypeFor(certificationTypeId) {
    if (!typeCache.has(certificationTypeId)) {
      typeCache.set(
        certificationTypeId,
        pgSelect(client, "certification_types", {
          filters: { id: certificationTypeId },
          select: "id,code,name",
          limit: 1
        }).then((rows) => (rows ?? [])[0] ?? null)
      );
    }
    return typeCache.get(certificationTypeId);
  }

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const certs =
      (await pgSelect(client, "employee_certifications", {
        filters: { status: { neq: "revoked" }, expires_at: { gte: windowStart, lte: windowEnd } },
        select: CERT_COLUMNS,
        order: "expires_at.asc,id.asc",
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        extra: { deleted_at: "is.null" }
      })) ?? [];
    summary.scanned += certs.length;

    for (const cert of certs) {
      let claim = null;
      try {
        const facilityConfig = await loadConfig({ facilityId: cert.facility_id, moduleCode: TRAINING_MODULE_CODE });
        const leadDays = parseLeadDays(configValue(facilityConfig, "training.certExpiryLeadDays"));
        const notice = noticeFor(cert, now, leadDays, facilityConfig);
        if (!notice) continue;
        const notifyEnabled = configValue(facilityConfig, "training.certExpiryNotifyEnabled") !== false;
        if (notice.kind === "expiring" && !notifyEnabled) {
          summary.disabled += 1;
          continue;
        }

        const eventCode = notice.kind === "expired" ? EVENT_EXPIRED : EVENT_EXPIRING;
        const { route, recipients } = notifyEnabled
          ? await recipientsFor(cert.facility_id, eventCode)
          : { route: null, recipients: [] };
        if (notice.kind === "expiring" && !route) {
          // Nothing to enqueue and nothing claimed: once a route exists the
          // notice still goes out.
          summary.noRoute += 1;
          continue;
        }

        claim = await claimNotice(client, cert, notice);
        if (!claim) {
          summary.deduped += 1;
          continue;
        }

        if (notice.kind === "expired") {
          if (!(await expiredEventExists(client, cert))) {
            await pgInsert(
              client,
              "certification_events",
              [
                {
                  facility_id: cert.facility_id,
                  employee_certification_id: cert.id,
                  event_type: "expired",
                  payload_jsonb: {
                    expiresAt: dateOnly(cert.expires_at),
                    previousStatus: cert.status,
                    detectedAt: nowIso,
                    source: "training-cert-expiry"
                  }
                }
              ],
              { returning: false }
            );
            summary.eventsWritten += 1;
          }
          summary.expiredNotices += 1;
        } else {
          summary.expiringNotices += 1;
        }

        if (!route) {
          summary.noRoute += 1;
          continue;
        }
        const dedupeKey = dedupeKeyFor(cert, notice);
        if (await jobAlreadyEnqueued(client, cert.facility_id, dedupeKey)) {
          summary.deduped += 1;
          continue;
        }

        const certType = await certTypeFor(cert.certification_type_id);
        const certName = certType?.name ?? "certification";
        const deferred = isWithinQuietHours(nowHHMM, quietStart, quietEnd);
        const base = buildNotificationJob(eventCode, route, [...new Set([cert.employee_id, ...recipients])]);
        await pgInsert(
          client,
          "notification_jobs",
          [
            {
              ...base,
              scheduled_for: deferred ? toIso(nextQuietWindowEnd(now, quietEnd)) : nowIso,
              payload_jsonb: {
                ...base.payload_jsonb,
                quietHoursBypass: false,
                dedupeKey,
                title:
                  notice.kind === "expired"
                    ? `Certification expired: ${certName}`
                    : `Certification expiring in ${notice.daysUntil} day(s): ${certName}`,
                body:
                  notice.kind === "expired"
                    ? `A ${certName} certification expired on ${dateOnly(cert.expires_at)}.`
                    : `A ${certName} certification expires on ${dateOnly(cert.expires_at)}.`,
                employeeCertificationId: cert.id,
                employeeId: cert.employee_id,
                certificationTypeId: cert.certification_type_id,
                expiresAt: dateOnly(cert.expires_at),
                leadDays: notice.leadDays
              }
            }
          ],
          { returning: false }
        );
        summary.jobsEnqueued += 1;
      } catch (error) {
        summary.errors.push({ certificationId: cert.id, error: error.message });
        if (claim) {
          // Revert so the next pass retries; the revert is itself a network
          // call and must not abort the loop if it fails too.
          try {
            await revertClaim(client, claim);
          } catch (revertError) {
            summary.errors.push({ certificationId: cert.id, stage: "revert", error: revertError.message });
          }
        }
      }
    }
    if (certs.length < PAGE_SIZE) break;
  }
  return summary;
}
