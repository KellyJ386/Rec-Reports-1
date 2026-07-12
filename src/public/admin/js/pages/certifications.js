import { api } from "../api.js";
import { el, clearChildren, errorBanner, emptyState, tableScroll, toast } from "../ui.js";
import { getContext } from "../state.js";

const ENFORCEMENT_OPTIONS = [
  { value: "", label: "Default (facility setting)" },
  { value: "hard-block", label: "Hard block" },
  { value: "warning", label: "Warning" }
];

const GAP_TONE = { missing: "badge-denied", expired: "badge-denied", expiring: "badge-custom" };
const ENFORCEMENT_TONE = { "hard-block": "badge-denied", warning: "badge-custom" };

// Surfaces a 402 (plan lacks the cert_policies entitlement) as a friendly
// banner instead of a generic error, so the page explains why writes are gated.
function isEntitlementError(error) {
  return error && error.status === 402;
}

export async function renderCertifications(container) {
  container.append(el("h1", {}, ["Certifications"]));

  const context = getContext();
  if (!context.facilityId) {
    container.append(emptyState("Select a facility in the top bar to manage certification policy."));
    return;
  }
  const facilityId = context.facilityId;
  const statusRegion = el("div", { class: "status-region", role: "status", "aria-live": "polite" }, []);
  container.append(statusRegion);

  let roles = [];
  try {
    roles = (await api.get(`/facilities/${encodeURIComponent(facilityId)}/roles`)) ?? [];
  } catch (error) {
    container.append(errorBanner(`Could not load roles: ${error.message}`));
  }

  const requirementsSection = el("section", { class: "panel", "aria-labelledby": "crr-heading" }, [
    el("h2", { id: "crr-heading" }, ["Role requirements"]),
    el("p", { class: "detail-subhead" }, ["Which certification each role must hold, and how strictly it is enforced."]),
    el("div", { "data-region": "crr-body" }, [])
  ]);
  const policiesSection = el("section", { class: "panel", "aria-labelledby": "cp-heading" }, [
    el("h2", { id: "cp-heading" }, ["Policies"]),
    el("p", { class: "detail-subhead" }, ["Lifecycle rules for expiry reminders, assignment gating, and schedule gating."]),
    el("div", { "data-region": "cp-body" }, [])
  ]);
  const gapsSection = el("section", { class: "panel", "aria-labelledby": "cg-heading" }, [
    el("h2", { id: "cg-heading" }, ["Gaps report"]),
    el("div", { "data-region": "cg-body" }, [])
  ]);
  container.append(requirementsSection, policiesSection, gapsSection);

  function roleName(roleId) {
    const role = roles.find((r) => r.id === roleId);
    return role ? role.name : roleId;
  }

  // --- Requirements ---------------------------------------------------------
  async function loadRequirements() {
    const body = requirementsSection.querySelector("[data-region=crr-body]");
    clearChildren(body);
    let requirements = [];
    try {
      requirements = (await api.get(`/facilities/${encodeURIComponent(facilityId)}/cert-requirements`)) ?? [];
    } catch (error) {
      body.append(errorBanner(`Could not load requirements: ${error.message}`));
      return;
    }
    body.append(buildRequirementForm({ facilityId, roles, statusRegion, onCreated: loadRequirements }));
    if (requirements.length === 0) {
      body.append(emptyState("No role requirements yet. Add one above."));
      return;
    }
    const table = el("table", { class: "data-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { scope: "col" }, ["Certification type"]),
          el("th", { scope: "col" }, ["Role"]),
          el("th", { scope: "col" }, ["Level"]),
          el("th", { scope: "col" }, ["Enforcement"]),
          el("th", { scope: "col" }, ["Active"])
        ])
      ])
    ]);
    const tbody = el("tbody", {}, []);
    for (const requirement of requirements) {
      const select = el("select", { "aria-label": "Enforcement mode" },
        ENFORCEMENT_OPTIONS.map((option) =>
          el("option", { value: option.value, selected: (requirement.enforcement_mode ?? "") === option.value }, [option.label])
        )
      );
      select.addEventListener("change", async () => {
        select.disabled = true;
        try {
          await api.patch(
            `/facilities/${encodeURIComponent(facilityId)}/cert-requirements/${encodeURIComponent(requirement.id)}`,
            { enforcementMode: select.value === "" ? null : select.value }
          );
          statusRegion.textContent = "Requirement enforcement updated.";
          toast("Enforcement updated.", { tone: "success" });
        } catch (error) {
          if (isEntitlementError(error)) toast("Your plan does not include certification policy.", { tone: "error" });
          else toast(`Could not update: ${error.message}`, { tone: "error" });
        } finally {
          select.disabled = false;
        }
      });
      tbody.append(
        el("tr", {}, [
          el("td", {}, [el("code", {}, [requirement.certification_type_id])]),
          el("td", {}, [roleName(requirement.role_id)]),
          el("td", {}, [requirement.required_level]),
          el("td", {}, [select]),
          el("td", {}, [el("span", { class: `badge ${requirement.active ? "badge-on" : "badge-off"}` }, [requirement.active ? "Active" : "Off"])])
        ])
      );
    }
    table.append(tbody);
    body.append(tableScroll(table));
  }

  // --- Policies -------------------------------------------------------------
  async function loadPolicies() {
    const body = policiesSection.querySelector("[data-region=cp-body]");
    clearChildren(body);
    let policies = [];
    try {
      policies = (await api.get(`/facilities/${encodeURIComponent(facilityId)}/cert-policies`)) ?? [];
    } catch (error) {
      body.append(errorBanner(`Could not load policies: ${error.message}`));
      return;
    }
    body.append(buildPolicyForm({ facilityId, statusRegion, onCreated: loadPolicies }));
    if (policies.length === 0) {
      body.append(emptyState("No policies yet. Add one above."));
      return;
    }
    const table = el("table", { class: "data-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { scope: "col" }, ["Trigger"]),
          el("th", { scope: "col" }, ["Cadence"]),
          el("th", { scope: "col" }, ["Action"]),
          el("th", { scope: "col" }, ["Active"])
        ])
      ])
    ]);
    const tbody = el("tbody", {}, []);
    for (const policy of policies) {
      tbody.append(
        el("tr", {}, [
          el("td", {}, [el("span", { class: "badge badge-custom" }, [policy.trigger_type])]),
          el("td", {}, [el("code", {}, [JSON.stringify(policy.cadence_rule_jsonb ?? {})])]),
          el("td", {}, [el("code", {}, [JSON.stringify(policy.action_jsonb ?? {})])]),
          el("td", {}, [el("span", { class: `badge ${policy.active ? "badge-on" : "badge-off"}` }, [policy.active ? "Active" : "Off"])])
        ])
      );
    }
    table.append(tbody);
    body.append(tableScroll(table));
  }

  // --- Gaps report ----------------------------------------------------------
  function loadGaps() {
    const body = gapsSection.querySelector("[data-region=cg-body]");
    clearChildren(body);
    const roleSelect = el("select", { "aria-label": "Role for gaps report" },
      [el("option", { value: "" }, ["(select a role)"])].concat(
        roles.map((role) => el("option", { value: role.id }, [role.name]))
      )
    );
    const resultRegion = el("div", { "data-region": "cg-result" }, []);
    const runButton = el("button", { type: "button", class: "primary-button" }, ["Run report"]);
    runButton.addEventListener("click", async () => {
      if (!roleSelect.value) {
        toast("Select a role first.", { tone: "error" });
        return;
      }
      runButton.disabled = true;
      clearChildren(resultRegion);
      try {
        const report = await api.get(
          `/facilities/${encodeURIComponent(facilityId)}/cert-gaps?roleId=${encodeURIComponent(roleSelect.value)}`
        );
        renderGapsTable(resultRegion, report);
      } catch (error) {
        resultRegion.append(errorBanner(`Could not run report: ${error.message}`));
      } finally {
        runButton.disabled = false;
      }
    });
    body.append(el("div", { class: "inline-form" }, [roleSelect, runButton]), resultRegion);
  }

  function renderGapsTable(region, report) {
    if (!report || !Array.isArray(report.employees) || report.employees.length === 0) {
      region.append(emptyState(`No gaps found for this role (${report?.requirementCount ?? 0} requirement(s) checked).`));
      return;
    }
    const table = el("table", { class: "data-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { scope: "col" }, ["Employee"]),
          el("th", { scope: "col" }, ["Certification type"]),
          el("th", { scope: "col" }, ["Status"]),
          el("th", { scope: "col" }, ["Enforcement"])
        ])
      ])
    ]);
    const tbody = el("tbody", {}, []);
    for (const entry of report.employees) {
      for (const gap of entry.gaps) {
        tbody.append(
          el("tr", {}, [
            el("td", {}, [el("code", {}, [entry.employeeId])]),
            el("td", {}, [el("code", {}, [gap.certificationTypeId])]),
            el("td", {}, [el("span", { class: `badge ${GAP_TONE[gap.status] ?? "badge-off"}` }, [gap.status])]),
            el("td", {}, [el("span", { class: `badge ${ENFORCEMENT_TONE[gap.enforcement] ?? "badge-off"}` }, [gap.enforcement])])
          ])
        );
      }
    }
    table.append(tbody);
    region.append(tableScroll(table));
  }

  await loadRequirements();
  await loadPolicies();
  loadGaps();
}

function buildRequirementForm({ facilityId, roles, statusRegion, onCreated }) {
  const typeInput = el("input", { type: "text", placeholder: "certification type id", autocomplete: "off", "aria-label": "Certification type id" });
  const roleSelect = el("select", { "aria-label": "Role" },
    [el("option", { value: "" }, ["(role)"])].concat(roles.map((role) => el("option", { value: role.id }, [role.name])))
  );
  const enforcementSelect = el("select", { "aria-label": "Enforcement" },
    ENFORCEMENT_OPTIONS.map((option) => el("option", { value: option.value }, [option.label]))
  );
  const submit = el("button", { type: "submit", class: "primary-button" }, ["Add requirement"]);
  return el(
    "form",
    {
      class: "settings-form inline-form",
      "aria-label": "Add role requirement",
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          await api.post(`/facilities/${encodeURIComponent(facilityId)}/cert-requirements`, {
            certificationTypeId: typeInput.value.trim(),
            roleId: roleSelect.value,
            enforcementMode: enforcementSelect.value === "" ? null : enforcementSelect.value
          });
          statusRegion.textContent = "Requirement added.";
          toast("Requirement added.", { tone: "success" });
          typeInput.value = "";
          await onCreated();
        } catch (error) {
          if (error && error.status === 402) toast("Your plan does not include certification policy.", { tone: "error" });
          else toast(`Could not add requirement: ${error.message}`, { tone: "error" });
        } finally {
          submit.disabled = false;
        }
      }
    },
    [
      el("label", {}, [el("span", {}, ["Certification type id"]), typeInput]),
      el("label", {}, [el("span", {}, ["Role"]), roleSelect]),
      el("label", {}, [el("span", {}, ["Enforcement"]), enforcementSelect]),
      submit
    ]
  );
}

function buildPolicyForm({ facilityId, statusRegion, onCreated }) {
  const triggerSelect = el("select", { "aria-label": "Trigger type" },
    ["expiry", "assignment", "schedule"].map((value) => el("option", { value }, [value]))
  );
  const cadenceInput = el("input", { type: "text", placeholder: '{"daysBefore":[30,7,1]}', autocomplete: "off", "aria-label": "Cadence rule JSON" });
  const actionInput = el("input", { type: "text", placeholder: '{"notify":"distribution_list"}', autocomplete: "off", "aria-label": "Action JSON" });
  const submit = el("button", { type: "submit", class: "primary-button" }, ["Add policy"]);
  return el(
    "form",
    {
      class: "settings-form inline-form",
      "aria-label": "Add policy",
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        let cadenceRule = {};
        let action = {};
        try {
          if (cadenceInput.value.trim()) cadenceRule = JSON.parse(cadenceInput.value);
          if (actionInput.value.trim()) action = JSON.parse(actionInput.value);
        } catch {
          toast("Cadence and action must be valid JSON.", { tone: "error" });
          submit.disabled = false;
          return;
        }
        try {
          await api.post(`/facilities/${encodeURIComponent(facilityId)}/cert-policies`, {
            triggerType: triggerSelect.value,
            cadenceRule,
            action
          });
          statusRegion.textContent = "Policy added.";
          toast("Policy added.", { tone: "success" });
          cadenceInput.value = "";
          actionInput.value = "";
          await onCreated();
        } catch (error) {
          if (error && error.status === 402) toast("Your plan does not include certification policy.", { tone: "error" });
          else toast(`Could not add policy: ${error.message}`, { tone: "error" });
        } finally {
          submit.disabled = false;
        }
      }
    },
    [
      el("label", {}, [el("span", {}, ["Trigger"]), triggerSelect]),
      el("label", {}, [el("span", {}, ["Cadence (JSON)"]), cadenceInput]),
      el("label", {}, [el("span", {}, ["Action (JSON)"]), actionInput]),
      submit
    ]
  );
}
