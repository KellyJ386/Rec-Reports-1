// Entitlements / feature-flag / usage helpers for the Billing & Subscription
// admin surface (subscription_plans, tenant_subscriptions, usage_counters,
// feature_flags, feature_flag_rules; 0018). The pure functions are deterministic
// transforms for node:test; loadEntitlements is the single small I/O helper the
// route layer shares to resolve a tenant's entitlements before a gated write.

import { pgSelect } from "../supabase-rest.mjs";

// Merge a plan's feature_entitlements_jsonb with any add-on entitlements into a
// flat { key: true } map. Accepts either an object ({ "cert_policies": true })
// or an array of keys (["cert_policies"]) in either source, so seed shape is
// flexible. A missing/null plan yields {} (fail closed -- no entitlements).
export function entitlementsFor(plan, addons = []) {
  const merged = {};
  const absorb = (source) => {
    const keys = normalizeEntitlementKeys(source);
    for (const key of keys) merged[key] = true;
  };
  absorb(plan?.feature_entitlements_jsonb ?? plan?.featureEntitlements);
  for (const addon of addons ?? []) {
    absorb(addon?.feature_entitlements_jsonb ?? addon?.featureEntitlements);
  }
  return merged;
}

export function isEntitled(entitlements, key) {
  return Boolean(entitlements) && entitlements[key] === true;
}

// Classify usage against a soft limit. Returns { level, pct } where level is
// 'ok' | 'warn80' | 'warn90' | 'exceeded' (design 10.3 soft limits). Boundaries
// are inclusive: exactly 80% -> warn80, 90% -> warn90, 100% -> exceeded. A
// null/zero/absent limit is treated as unlimited -> { level: 'ok', pct: 0 }.
export function usageStatus(counter, limit) {
  const value = typeof counter === "number" ? counter : Number(counter?.value ?? counter?.value_bigint ?? 0);
  const cap = typeof limit === "number" ? limit : Number(limit ?? 0);
  if (!Number.isFinite(cap) || cap <= 0) return { level: "ok", pct: 0 };
  const pct = Math.round((value / cap) * 100);
  let level = "ok";
  if (pct >= 100) level = "exceeded";
  else if (pct >= 90) level = "warn90";
  else if (pct >= 80) level = "warn80";
  return { level, pct };
}

// Resolve a feature flag's effective boolean state for a caller's context.
// Precedence: an in-window facility rule > an in-window org rule > the flag's
// default_state. For a matched rule: a non-null rollout_percentage is a
// percentage gate (bucket, a caller-provided stable hash in [0,99], must be
// below the percentage); otherwise the rule's plain state applies. A rule is
// only considered when `now` is inside its [starts_at, ends_at) window (a null
// bound is open-ended).
export function flagState(flag, rules = [], { organizationId, facilityId, bucket = 0, now = new Date() } = {}) {
  const applicable = (rules ?? []).filter((rule) => rule && rule.feature_flag_id === flag?.id && withinWindow(rule, now));

  const facilityRule = applicable.find(
    (rule) => rule.scope_type === "facility" && rule.scope_id === facilityId
  );
  const orgRule = applicable.find(
    (rule) => rule.scope_type === "organization" && rule.scope_id === organizationId
  );

  const rule = facilityRule ?? orgRule;
  if (rule) return evaluateRule(rule, bucket);
  return Boolean(flag?.default_state);
}

function evaluateRule(rule, bucket) {
  const pct = rule.rollout_percentage;
  if (pct !== null && pct !== undefined) {
    return Number(bucket) < Number(pct);
  }
  return Boolean(rule.state);
}

function withinWindow(rule, now) {
  const at = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (rule.starts_at) {
    const start = new Date(rule.starts_at).getTime();
    if (Number.isFinite(start) && at < start) return false;
  }
  if (rule.ends_at) {
    const end = new Date(rule.ends_at).getTime();
    if (Number.isFinite(end) && at >= end) return false;
  }
  return true;
}

function normalizeEntitlementKeys(source) {
  if (!source) return [];
  if (Array.isArray(source)) return source.filter((key) => typeof key === "string");
  if (typeof source === "object") {
    return Object.entries(source)
      .filter(([, value]) => value === true)
      .map(([key]) => key);
  }
  return [];
}

// Subscription statuses that keep a tenant's paid entitlements active. Any
// other status (canceled, past_due, incomplete, ...) -- or no row at all --
// fails closed to the free/essentials tier (design 10.3 / plan Phase 7.4).
const ENTITLED_STATUSES = ["active", "trialing"];

// I/O helper shared by cert-policy-routes and notification-routes: load an
// organization's active subscription + plan and return its entitlements once per
// request. Only a subscription whose status is 'active' or 'trialing' counts --
// canceled/past_due/other statuses (and a missing subscription/plan) yield empty
// entitlements, i.e. the tenant is treated as the free/essentials tier and every
// advanced, entitlement-gated write FAILS CLOSED. Callers 402 when the needed
// key is absent. When more than one subscription row exists for the org, the
// most-recently-renewing one is picked deterministically (order renews_at desc).
export async function loadEntitlements(client, organizationId) {
  if (!organizationId) return { entitlements: {}, plan: null, subscription: null };
  const subs = await pgSelect(client, "tenant_subscriptions", {
    filters: { organization_id: organizationId },
    select: "id,organization_id,plan_id,status,seat_limit,renews_at,usage_limits_jsonb",
    order: "renews_at.desc",
    limit: 1,
    extra: { status: `in.(${ENTITLED_STATUSES.join(",")})` }
  });
  const subscription = (subs ?? [])[0] ?? null;
  if (!subscription) return { entitlements: {}, plan: null, subscription: null };
  const plans = await pgSelect(client, "subscription_plans", {
    filters: { id: subscription.plan_id },
    select: "id,code,name,feature_entitlements_jsonb",
    limit: 1
  });
  const plan = (plans ?? [])[0] ?? null;
  return { entitlements: entitlementsFor(plan), plan, subscription };
}
