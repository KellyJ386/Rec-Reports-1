import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { channelsForPriority, shouldBypassQuietHours, shouldBypassQuietHoursForEscalation } from "../src/lib/communications.mjs";

// Structural checks on 0064 and the publish route for the second review round
// (NEW-1, NEW-2, NEW-3, M-5 residual). The behavior itself is proven against a
// real database by supabase/tests/communications_escalation.sql.

const SQL = readFileSync(new URL("../supabase/migrations/0064_communications_escalation.sql", import.meta.url), "utf8");
const ROUTES = readFileSync(new URL("../src/lib/http/communications-routes.mjs", import.meta.url), "utf8");

function functionBody(name) {
  const start = SQL.indexOf(`create or replace function ${name}(`);
  assert.ok(start >= 0, `${name} is defined`);
  const end = SQL.indexOf("\n$$;", SQL.indexOf("as $$", start));
  assert.ok(end > start, `${name} body terminates`);
  return SQL.slice(start, end);
}

test("NEW-1: the SQL urgent channel list is exactly channelsForPriority('urgent')", () => {
  const body = functionBody("internal.publish_urgent_message");
  const match = body.match(/'channels', jsonb_build_array\(([^)]*)\)/);
  assert.ok(match, "the job payload carries a constant channel list");
  const sqlChannels = [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(sqlChannels, channelsForPriority("urgent"));
  assert.equal(shouldBypassQuietHours({ priority: "urgent" }), true, "the function's bypass true mirrors the JS rule");
  assert.equal(shouldBypassQuietHoursForEscalation({ priority: "urgent" }), false, "unchanged: only emergency escalations bypass");
});

test("NEW-1: publish_urgent_message is a definer function that takes only the message id and derives everything else", () => {
  const body = functionBody("internal.publish_urgent_message");
  assert.match(body, /security definer\s+set search_path = public/);
  assert.match(body, /\(p_message_id uuid\)/);
  assert.match(body, /communications\.publish/);
  assert.match(body, /internal\.fn_emergency_audience\(p_message_id/);
  assert.match(body, /priority <> 'urgent'/);
  assert.match(body, /for update/);
  assert.match(body, /'quietHoursBypass', true/);
  // No client-supplied copy: the only text in the payload is the message's own subject.
  assert.ok(!/'body'/.test(body));
  assert.match(body, /'title', left\(v_message\.subject, 200\)/);
  assert.match(SQL, /revoke execute on function internal\.publish_urgent_message\(uuid\) from public;/);
  assert.match(SQL, /grant execute on function internal\.publish_urgent_message\(uuid\) to authenticated;/);
  assert.match(SQL, /revoke execute on function public\.publish_urgent_message\(uuid\) from public;/);
  assert.match(SQL, /grant execute on function public\.publish_urgent_message\(uuid\) to authenticated;/);
  assert.match(SQL, /revoke execute on function public\.publish_urgent_message\(uuid\) from anon;/);
  assert.match(SQL, /create unique index if not exists notification_jobs_urgent_publish_message_uidx/);
});

test("NEW-1: the notification_jobs client guard has no message.published bypass branch, only 0058's incident rule", () => {
  const body = functionBody("fn_notification_jobs_client_guard");
  assert.ok(!body.includes("'message.published'"), "no message.published exception remains in the guard");
  assert.ok(!body.includes("j.status <> 'cancelled'"), "no cancelled-row exemption remains");
  assert.match(body, /'incident\.submitted', 'incident\.escalated', 'incident\.sla_breached'/);
  for (const label of ["Guard 1", "Guard 2", "Guard 3", "Guard 4", "Guard 5", "Guard 6"]) {
    assert.ok(body.includes(`-- ${label}`), `${label} label kept`);
  }
  // a bypass job may be cancelled by a client only while it is still pending
  assert.match(body, /old\.status <> 'pending'/);
});

test("NEW-2: the guard also fires on DELETE, returns OLD for non-client deletes, and locks a message.emergency job entirely", () => {
  assert.match(SQL, /create trigger notification_jobs_client_guard\s+before insert or update or delete on notification_jobs/);
  const body = functionBody("fn_notification_jobs_client_guard");
  assert.match(body, /if tg_op = 'DELETE' then\s+return old;/, "a non-client delete is not swallowed");
  assert.match(body, /notification jobs cannot be deleted from a client session/);
  assert.match(body, /if old\.event_type = 'message\.emergency' then\s+raise exception/);
});

test("NEW-2: the emergency launch lifecycle is written to audit_events", () => {
  const body = functionBody("fn_emergency_alert_launch_audit");
  for (const event of ["launch_requested", "launch_approved", "launch_launched", "launch_cancelled"]) {
    assert.ok(body.includes(`emergency.${event}`), event);
  }
  assert.match(body, /insert into audit_events/);
  assert.match(SQL, /create trigger emergency_alert_launches_audit\s+after insert or update on emergency_alert_launches/);
});

test("NEW-3: the emergency audience resolver skips soft-deleted employees and keeps one row per user in a role audience", () => {
  const body = functionBody("internal.fn_emergency_audience");
  assert.match(body, /e\.facility_id = v_facility and e\.deleted_at is null/);
  assert.match(body, /distinct on \(m\.user_id\)/);
  assert.match(body, /order by m\.user_id, e\.created_at, e\.id/);
});

test("M-5: ack_due_at / published_at are checked on any client change and published_at is frozen once set", () => {
  const body = functionBody("fn_messages_set_ack_next_escalation");
  assert.match(body, /new\.ack_due_at is distinct from old\.ack_due_at\s+or new\.published_at is distinct from old\.published_at\)\s+and new\.ack_due_at <= new\.published_at/);
  assert.match(body, /old\.published_at is not null\s+and new\.published_at is distinct from old\.published_at/);
  assert.match(body, /auth\.uid\(\) is not null/);
});

test("NEW-1: the ordinary publish route sends urgent messages to the definer function and never writes a bypass flag itself", () => {
  assert.match(ROUTES, /message\.priority === "urgent"/);
  assert.match(ROUTES, /pgRpc\(auth\.client, "publish_urgent_message", \{ p_message_id: params\.id \}\)/);
  assert.ok(!/quietHoursBypass\s*=\s*true/.test(ROUTES));
  // the rpc call precedes the route's own messages PATCH and job insert
  assert.ok(ROUTES.indexOf('"publish_urgent_message"') < ROUTES.indexOf('"notification_jobs", [job]'));
});

test("verify-migrations requires the new functions", () => {
  const verify = readFileSync(new URL("../scripts/verify-migrations.mjs", import.meta.url), "utf8");
  for (const name of ["internal.publish_urgent_message", "public.publish_urgent_message", "fn_emergency_alert_launch_audit"]) {
    assert.ok(verify.includes(`"${name}"`), name);
  }
});
