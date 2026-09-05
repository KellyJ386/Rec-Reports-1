import { api } from "../api.js";
import { el, errorBanner, emptyState, tableScroll, formatDateTime, toast } from "../ui.js";
import { getContext } from "../state.js";

// Resolve the effective enabled/disabled state for a module at a facility,
// mirroring the org-default -> facility-override precedence used server
// side (facility override wins when set, otherwise org default, otherwise
// the module's own default_enabled flag).
function resolveEffective(module, orgSetting, facilityOverride) {
  if (facilityOverride && facilityOverride.enabled !== null && facilityOverride.enabled !== undefined) {
    return { enabled: Boolean(facilityOverride.enabled), source: "facility override" };
  }
  if (orgSetting && orgSetting.enabled !== null && orgSetting.enabled !== undefined) {
    return { enabled: Boolean(orgSetting.enabled), source: "organization default" };
  }
  return { enabled: Boolean(module.default_enabled), source: "module default" };
}

function impactText(module, effective) {
  const name = module.name || module.code || "This module";
  return effective.enabled
    ? `${name} is enabled (${effective.source}). Turning it off disables ${module.category ?? "this"} features for everyone in scope.`
    : `${name} is disabled (${effective.source}). Turning it on enables ${module.category ?? "this"} features for everyone in scope.`;
}

export async function renderModules(container) {
  container.append(el("h1", {}, ["Modules & Features"]));

  const context = getContext();
  if (!context.orgId) {
    container.append(
      emptyState("Set an Organization ID in the top bar to view and manage the module toggle matrix.")
    );
    return;
  }

  const statusRegion = el("div", { class: "status-region", role: "status", "aria-live": "polite" }, []);
  container.append(statusRegion);

  let modules = [];
  let orgSettings = [];
  let facilityOverrides = [];

  try {
    modules = (await api.get("/modules")) ?? [];
  } catch (error) {
    container.append(errorBanner(`Could not load modules: ${error.message}`));
    return;
  }

  try {
    orgSettings = (await api.get(`/org/${encodeURIComponent(context.orgId)}/module-settings`)) ?? [];
  } catch (error) {
    container.append(errorBanner(`Could not load organization module settings: ${error.message}`));
  }

  if (context.facilityId) {
    try {
      facilityOverrides =
        (await api.get(`/facilities/${encodeURIComponent(context.facilityId)}/module-overrides`)) ?? [];
    } catch (error) {
      container.append(errorBanner(`Could not load facility overrides: ${error.message}`));
    }
  }

  if (modules.length === 0) {
    container.append(emptyState("No modules are defined yet."));
    return;
  }

  // module_id -> row data, kept in a closure so optimistic updates/reverts
  // don't require a full re-fetch.
  const orgByModule = new Map(orgSettings.map((row) => [row.module_id, row]));
  const overrideByModule = new Map(facilityOverrides.map((row) => [row.module_id, row]));

  const table = el("table", { class: "data-table" }, [
    el("caption", { class: "sr-only" }, ["Module toggle matrix: organization default and facility override per module"]),
    el("thead", {}, [
      el("tr", {}, [
        el("th", { scope: "col" }, ["Module"]),
        el("th", { scope: "col" }, ["Organization default"]),
        el("th", { scope: "col" }, ["Facility override"]),
        el("th", { scope: "col" }, ["Effective state"]),
        el("th", { scope: "col" }, ["Last changed"])
      ])
    ])
  ]);
  const tbody = el("tbody", {}, []);
  table.append(tbody);

  for (const module of modules) {
    const row = buildModuleRow({ module, orgByModule, overrideByModule, context, statusRegion });
    tbody.append(row);
  }

  container.append(tableScroll(table));

  // --- Per-module settings (generic, registry-driven) ---------------------
  let registryDefinitions = [];
  try {
    const registry = (await api.get("/settings-registry")) ?? {};
    registryDefinitions = Array.isArray(registry.definitions) ? registry.definitions : [];
  } catch (error) {
    container.append(errorBanner(`Could not load the settings registry: ${error.message}`));
  }

  if (registryDefinitions.length > 0) {
    const settingsSection = el("section", { class: "module-settings-section" }, [
      el("h2", {}, ["Module settings"])
    ]);
    if (!context.facilityId) {
      settingsSection.append(
        emptyState("Select a facility in the top bar to view and edit per-module settings.")
      );
    }
    for (const module of modules) {
      const definitions = registryDefinitions.filter((definition) => definition.module === module.code);
      if (definitions.length === 0) continue;
      settingsSection.append(
        buildModuleSettingsPanel({ module, definitions, context, statusRegion })
      );
    }
    container.append(settingsSection);
  }
}

// A collapsible, generically-rendered settings form for one module. On expand
// it fetches the resolved per-key {value, source} for the current facility and
// renders one input per registry definition (boolean->checkbox, integer->number,
// enum->select, string/timeRange->text). Save PATCHes the changed keys.
function buildModuleSettingsPanel({ module, definitions, context, statusRegion }) {
  const details = el("details", { class: "module-settings" }, [
    el("summary", {}, [`${module.name || module.code} settings`])
  ]);
  const body = el("div", { class: "module-settings-body" }, []);
  details.append(body);

  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loaded) return;
    if (!context.facilityId) {
      body.append(emptyState("Select a facility to edit these settings."));
      loaded = true;
      return;
    }
    loaded = true;
    body.append(el("p", { class: "cell-muted" }, ["Loading settings..."]));
    let resolved = {};
    try {
      const config = await api.get(
        `/facilities/${encodeURIComponent(context.facilityId)}/modules/${encodeURIComponent(module.code)}/config`
      );
      resolved = config?.settings ?? {};
    } catch (error) {
      body.textContent = "";
      body.append(errorBanner(`Could not load ${module.code} settings: ${error.message}`));
      return;
    }
    body.textContent = "";
    renderSettingsForm({ module, definitions, resolved, context, body, statusRegion });
  });

  return details;
}

function renderSettingsForm({ module, definitions, resolved, context, body, statusRegion }) {
  const inputs = new Map();
  const form = el("form", { class: "settings-form" }, []);
  for (const definition of definitions) {
    const entry = resolved[definition.key] ?? { value: definition.default, source: "default" };
    const inputId = `setting-${definition.key.replace(/[^a-z0-9]/gi, "-")}`;
    const input = buildSettingInput(definition, entry.value, inputId);
    inputs.set(definition.key, { definition, input });
    form.append(
      el("div", { class: "settings-field" }, [
        el("label", { for: inputId }, [definition.label]),
        input,
        el("span", { class: `badge source-${entry.source}` }, [entry.source])
      ])
    );
  }

  const saveButton = el("button", { type: "submit", class: "btn btn-primary" }, ["Save settings"]);
  form.append(saveButton);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const settings = collectSettings(inputs);
    saveButton.disabled = true;
    try {
      await api.patch(
        `/facilities/${encodeURIComponent(context.facilityId)}/modules/${encodeURIComponent(module.code)}/config`,
        { settings }
      );
      statusRegion.textContent = `Saved ${module.name || module.code} settings.`;
      toast(`Saved ${module.name || module.code} settings.`, { tone: "success" });
    } catch (error) {
      statusRegion.textContent = `Could not save ${module.code} settings: ${error.message}`;
      toast(`Failed to save ${module.code} settings: ${error.message}`, { tone: "error" });
    } finally {
      saveButton.disabled = false;
    }
  });
  body.append(form);
}

function buildSettingInput(definition, value, inputId) {
  if (definition.dataType === "boolean") {
    return el("input", { type: "checkbox", id: inputId, checked: Boolean(value) });
  }
  if (definition.dataType === "integer") {
    const attrs = { type: "number", id: inputId, step: "1", value: value ?? "" };
    if (definition.validation && definition.validation.min !== undefined) attrs.min = String(definition.validation.min);
    if (definition.validation && definition.validation.max !== undefined) attrs.max = String(definition.validation.max);
    return el("input", attrs);
  }
  if (definition.dataType === "enum") {
    const options = (definition.validation && definition.validation.values ? definition.validation.values : []).map(
      (option) => el("option", { value: option, selected: option === value }, [option])
    );
    return el("select", { id: inputId }, options);
  }
  const attrs = { type: "text", id: inputId, value: value ?? "" };
  if (definition.validation && definition.validation.pattern) attrs.pattern = definition.validation.pattern;
  return el("input", attrs);
}

function collectSettings(inputs) {
  const settings = {};
  for (const [key, { definition, input }] of inputs) {
    if (definition.dataType === "boolean") {
      settings[key] = input.checked;
    } else if (definition.dataType === "integer") {
      if (input.value === "") continue;
      settings[key] = Number(input.value);
    } else {
      if (input.value === "") continue;
      settings[key] = input.value;
    }
  }
  return settings;
}

function buildModuleRow({ module, orgByModule, overrideByModule, context, statusRegion }) {
  let orgSetting = orgByModule.get(module.id) ?? null;
  let facilityOverride = overrideByModule.get(module.id) ?? null;

  const rowEl = el("tr", {});
  rowEl.append(el("th", { scope: "row" }, [module.name || module.code]));

  // --- Organization default checkbox ---
  const orgCheckboxId = `org-toggle-${module.id}`;
  const orgCheckbox = el("input", {
    type: "checkbox",
    id: orgCheckboxId,
    checked: orgSetting ? Boolean(orgSetting.enabled) : Boolean(module.default_enabled)
  });
  const orgLabel = el("label", { class: "sr-only", for: orgCheckboxId }, [
    `Enable ${module.name || module.code} by default for the organization`
  ]);
  const orgCell = el("td", {}, [orgLabel, orgCheckbox]);
  rowEl.append(orgCell);

  // --- Facility override tri-state select ---
  const overrideSelectId = `override-select-${module.id}`;
  const overrideSelect = el("select", { id: overrideSelectId, disabled: !context.facilityId }, [
    el("option", { value: "inherit" }, ["Inherit organization default"]),
    el("option", { value: "on" }, ["On"]),
    el("option", { value: "off" }, ["Off"])
  ]);
  overrideSelect.value =
    facilityOverride && facilityOverride.enabled !== null && facilityOverride.enabled !== undefined
      ? facilityOverride.enabled
        ? "on"
        : "off"
      : "inherit";
  const overrideLabel = el("label", { class: "sr-only", for: overrideSelectId }, [
    `Facility override for ${module.name || module.code}`
  ]);
  const overrideCell = el("td", {}, [
    overrideLabel,
    overrideSelect,
    !context.facilityId ? el("p", { class: "cell-hint" }, ["Select a facility to override"]) : null
  ]);
  rowEl.append(overrideCell);

  const effectiveCell = el("td", {}, []);
  const lastChangedCell = el("td", { class: "cell-muted" }, []);
  rowEl.append(effectiveCell);
  rowEl.append(lastChangedCell);

  const impactLine = el("p", { class: "impact-text" }, []);
  effectiveCell.append(impactLine);

  function refreshDerived() {
    const effective = resolveEffective(
      module,
      { enabled: orgCheckbox.checked },
      context.facilityId
        ? {
            enabled: overrideSelect.value === "inherit" ? null : overrideSelect.value === "on"
          }
        : null
    );
    effectiveCell.textContent = "";
    effectiveCell.append(
      el("span", { class: effective.enabled ? "badge badge-on" : "badge badge-off" }, [
        effective.enabled ? "Enabled" : "Disabled"
      ]),
      el("p", { class: "impact-text" }, [impactText(module, effective)])
    );

    const lastChangedSource = context.facilityId && facilityOverride ? facilityOverride : orgSetting;
    lastChangedCell.textContent = lastChangedSource
      ? `Changed ${formatDateTime(lastChangedSource.updated_at)}`
      : "Not yet changed";
  }
  refreshDerived();

  orgCheckbox.addEventListener("change", async () => {
    const previous = !orgCheckbox.checked;
    orgCheckbox.disabled = true;
    refreshDerived();
    try {
      await api.put(`/org/${encodeURIComponent(context.orgId)}/module-settings/${encodeURIComponent(module.id)}`, {
        enabled: orgCheckbox.checked,
        configPatch: {}
      });
      orgSetting = { ...(orgSetting ?? { module_id: module.id }), enabled: orgCheckbox.checked, updated_at: new Date().toISOString() };
      orgByModule.set(module.id, orgSetting);
      statusRegion.textContent = `Saved organization default for ${module.name || module.code}.`;
      toast(`Saved organization default for ${module.name || module.code}.`, { tone: "success" });
    } catch (error) {
      orgCheckbox.checked = previous;
      statusRegion.textContent = `Could not save organization default for ${module.name || module.code}: ${error.message}`;
      toast(`Failed to save ${module.name || module.code}: ${error.message}`, { tone: "error" });
    } finally {
      orgCheckbox.disabled = false;
      refreshDerived();
    }
  });

  overrideSelect.addEventListener("change", async () => {
    if (!context.facilityId) return;
    const previousValue = overrideSelect.dataset.previous ?? "inherit";
    overrideSelect.disabled = true;
    refreshDerived();
    const enabled = overrideSelect.value === "inherit" ? null : overrideSelect.value === "on";
    try {
      await api.put(
        `/facilities/${encodeURIComponent(context.facilityId)}/module-overrides/${encodeURIComponent(module.id)}`,
        { enabled, configPatch: {} }
      );
      facilityOverride = {
        ...(facilityOverride ?? { module_id: module.id }),
        enabled,
        updated_at: new Date().toISOString()
      };
      overrideByModule.set(module.id, facilityOverride);
      overrideSelect.dataset.previous = overrideSelect.value;
      statusRegion.textContent = `Saved facility override for ${module.name || module.code}.`;
      toast(`Saved facility override for ${module.name || module.code}.`, { tone: "success" });
    } catch (error) {
      overrideSelect.value = previousValue;
      statusRegion.textContent = `Could not save facility override for ${module.name || module.code}: ${error.message}`;
      toast(`Failed to save override for ${module.name || module.code}: ${error.message}`, { tone: "error" });
    } finally {
      overrideSelect.disabled = !context.facilityId;
      refreshDerived();
    }
  });
  overrideSelect.dataset.previous = overrideSelect.value;

  return rowEl;
}
