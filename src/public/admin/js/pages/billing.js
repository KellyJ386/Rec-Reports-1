import { api } from "../api.js";
import { el, clearChildren, errorBanner, emptyState, tableScroll, toast, formatDateTime } from "../ui.js";
import { getContext } from "../state.js";

// The entitlement keys the admin surfaces gate on, shown as a checklist so an
// admin can see at a glance what their plan unlocks.
const ENTITLEMENT_KEYS = [
  { key: "notification_routing", label: "Notification routing" },
  { key: "cert_policies", label: "Certification policy" },
  { key: "advanced_flags", label: "Advanced feature flags" },
  { key: "audit_export", label: "Audit export" },
  { key: "custom_forms", label: "Custom forms" }
];

const USAGE_TONE = { ok: "badge-on", warn80: "badge-custom", warn90: "badge-custom", exceeded: "badge-denied" };
const STATUS_TONE = { active: "badge-on", trialing: "badge-custom", past_due: "badge-denied", canceled: "badge-off" };

function money(cents) {
  if (typeof cents !== "number") return "-";
  return `$${(cents / 100).toFixed(2)}`;
}

export async function renderBilling(container) {
  container.append(el("h1", {}, ["Billing & Subscription"]));

  const context = getContext();
  if (!context.orgId) {
    container.append(emptyState("Select an organization in the top bar to view billing and entitlements."));
    return;
  }
  const orgId = context.orgId;
  const facilityId = context.facilityId || null;
  const statusRegion = el("div", { class: "status-region", role: "status", "aria-live": "polite" }, []);
  container.append(statusRegion);

  const planSection = el("section", { class: "panel", "aria-labelledby": "bp-heading" }, [
    el("h2", { id: "bp-heading" }, ["Plan"]),
    el("div", { "data-region": "bp-body" }, [])
  ]);
  const usageSection = el("section", { class: "panel", "aria-labelledby": "bu-heading" }, [
    el("h2", { id: "bu-heading" }, ["Usage"]),
    el("div", { "data-region": "bu-body" }, [])
  ]);
  const flagsSection = el("section", { class: "panel", "aria-labelledby": "bf-heading" }, [
    el("h2", { id: "bf-heading" }, ["Feature flags"]),
    el("div", { "data-region": "bf-body" }, [])
  ]);
  container.append(planSection, usageSection, flagsSection);

  await loadPlan(planSection, orgId);
  await loadUsage(usageSection, orgId);
  await loadFlags(flagsSection, orgId, facilityId, statusRegion);
}

async function loadPlan(section, orgId) {
  const body = section.querySelector("[data-region=bp-body]");
  clearChildren(body);
  let data;
  try {
    data = await api.get(`/org/${encodeURIComponent(orgId)}/subscription`);
  } catch (error) {
    body.append(errorBanner(`Could not load subscription: ${error.message}`));
    return;
  }
  const { subscription, plan, entitlements } = data ?? {};
  if (!subscription || !plan) {
    body.append(emptyState("No active subscription for this organization (treated as Essentials)."));
  } else {
    const card = el("div", { class: "subpanel" }, [
      el("h3", {}, [plan.name]),
      el("dl", { class: "detail-grid" }, [
        el("dt", {}, ["Status"]),
        el("dd", {}, [el("span", { class: `badge ${STATUS_TONE[subscription.status] ?? "badge-off"}` }, [subscription.status])]),
        el("dt", {}, ["Price"]),
        el("dd", {}, [`${money(plan.base_price_cents)} / ${plan.billing_period}`]),
        el("dt", {}, ["Renews"]),
        el("dd", {}, [formatDateTime(subscription.renews_at)]),
        el("dt", {}, ["Seat limit"]),
        el("dd", {}, [subscription.seat_limit == null ? "unlimited" : String(subscription.seat_limit)])
      ])
    ]);
    body.append(card);
  }

  // Entitlement checklist.
  const ul = el("ul", { class: "entitlement-list" }, []);
  for (const item of ENTITLEMENT_KEYS) {
    const included = Boolean(entitlements && entitlements[item.key] === true);
    ul.append(
      el("li", { class: "entitlement-row" }, [
        el("span", { class: `badge ${included ? "badge-on" : "badge-off"}`, "aria-hidden": "true" }, [included ? "✓" : "🔒"]),
        " ",
        el("span", {}, [item.label]),
        el("span", { class: "cell-muted" }, [included ? " included" : " not in plan"])
      ])
    );
  }
  body.append(el("h3", {}, ["Entitlements"]), ul);
}

async function loadUsage(section, orgId) {
  const body = section.querySelector("[data-region=bu-body]");
  clearChildren(body);
  let rows;
  try {
    rows = (await api.get(`/org/${encodeURIComponent(orgId)}/usage`)) ?? [];
  } catch (error) {
    body.append(errorBanner(`Could not load usage: ${error.message}`));
    return;
  }
  if (rows.length === 0) {
    body.append(emptyState("No usage recorded for this period."));
    return;
  }
  const table = el("table", { class: "data-table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { scope: "col" }, ["Metric"]),
        el("th", { scope: "col" }, ["Usage"]),
        el("th", { scope: "col" }, ["Limit"]),
        el("th", { scope: "col" }, ["% used"]),
        el("th", { scope: "col" }, ["Status"])
      ])
    ])
  ]);
  const tbody = el("tbody", {}, []);
  for (const row of rows) {
    tbody.append(
      el("tr", {}, [
        el("td", {}, [el("code", {}, [row.metric_code])]),
        el("td", {}, [String(row.value)]),
        el("td", {}, [row.limit == null ? "unlimited" : String(row.limit)]),
        el("td", {}, [`${row.pct}%`]),
        el("td", {}, [el("span", { class: `badge ${USAGE_TONE[row.level] ?? "badge-off"}` }, [row.level])])
      ])
    );
  }
  table.append(tbody);
  body.append(tableScroll(table));
}

async function loadFlags(section, orgId, facilityId, statusRegion) {
  const body = section.querySelector("[data-region=bf-body]");
  clearChildren(body);
  let flags;
  try {
    const query = facilityId ? `?facilityId=${encodeURIComponent(facilityId)}` : "";
    flags = (await api.get(`/org/${encodeURIComponent(orgId)}/feature-flags${query}`)) ?? [];
  } catch (error) {
    body.append(errorBanner(`Could not load feature flags: ${error.message}`));
    return;
  }
  if (flags.length === 0) {
    body.append(emptyState("No feature flags in the catalog."));
    return;
  }
  const table = el("table", { class: "data-table" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { scope: "col" }, ["Flag"]),
        el("th", { scope: "col" }, ["Type"]),
        el("th", { scope: "col" }, ["Default"]),
        el("th", { scope: "col" }, ["Effective"]),
        el("th", { scope: "col" }, ["Set rule"])
      ])
    ])
  ]);
  const tbody = el("tbody", {}, []);
  for (const flag of flags) {
    tbody.append(
      el("tr", {}, [
        el("td", {}, [el("code", {}, [flag.key]), flag.description ? el("div", { class: "cell-hint" }, [flag.description]) : null]),
        el("td", {}, [flag.rollout_type]),
        el("td", {}, [el("span", { class: `badge ${flag.default_state ? "badge-on" : "badge-off"}` }, [flag.default_state ? "on" : "off"])]),
        el("td", {}, [el("span", { class: `badge ${flag.effectiveState ? "badge-on" : "badge-off"}` }, [flag.effectiveState ? "on" : "off"])]),
        el("td", {}, [buildRuleControls({ orgId, facilityId, flag, statusRegion, onChanged: () => loadFlags(section, orgId, facilityId, statusRegion) })])
      ])
    );
  }
  table.append(tbody);
  body.append(tableScroll(table));
}

function buildRuleControls({ orgId, facilityId, flag, statusRegion, onChanged }) {
  const scopeSelect = el("select", { "aria-label": `Scope for ${flag.key}` }, [
    el("option", { value: "organization" }, ["organization"]),
    el("option", { value: "facility", disabled: !facilityId }, ["facility"])
  ]);
  const stateSelect = el("select", { "aria-label": `State for ${flag.key}` }, [
    el("option", { value: "on" }, ["on"]),
    el("option", { value: "off" }, ["off"])
  ]);
  const apply = el("button", { type: "button", class: "ghost-button" }, ["Apply"]);
  apply.addEventListener("click", async () => {
    apply.disabled = true;
    const scopeType = scopeSelect.value;
    const scopeId = scopeType === "facility" ? facilityId : orgId;
    try {
      await api.post(`/org/${encodeURIComponent(orgId)}/feature-flag-rules`, {
        featureFlagId: flag.id,
        scopeType,
        scopeId,
        state: stateSelect.value === "on"
      });
      statusRegion.textContent = `Set ${flag.key} ${stateSelect.value} for ${scopeType}.`;
      toast("Rule saved.", { tone: "success" });
      await onChanged();
    } catch (error) {
      toast(`Could not save rule: ${error.message}`, { tone: "error" });
      apply.disabled = false;
    }
  });
  return el("span", { class: "row-actions" }, [scopeSelect, stateSelect, apply]);
}
