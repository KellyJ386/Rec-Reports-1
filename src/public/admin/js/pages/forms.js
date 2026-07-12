import { api } from "../api.js";
import { el, clearChildren, errorBanner, emptyState, tableScroll, toast } from "../ui.js";
import { getContext } from "../state.js";

const FIELD_TYPES = [
  "text",
  "textarea",
  "number",
  "select",
  "multiselect",
  "checkbox",
  "date",
  "time",
  "photo",
  "signature"
];

const STATUS_TONE = { draft: "badge-off", published: "badge-on", retired: "badge-denied" };

// Builds a report-template schema (sections -> fields) from the ordered binding
// rows, pulling select options out of each custom field's validation_jsonb.
function schemaFromRows(rows, fieldsByKey) {
  return {
    sections: [
      {
        title: "Fields",
        fields: rows.map((row) => {
          const field = fieldsByKey.get(row.key) ?? {};
          const spec = { key: row.key, label: field.label ?? row.key, type: field.data_type ?? "text", required: row.required };
          const options = field.validation_jsonb?.options;
          if (Array.isArray(options) && options.length > 0) spec.options = options;
          return spec;
        })
      }
    ]
  };
}

export async function renderForms(container) {
  container.append(el("h1", {}, ["Forms & Fields"]));

  const context = getContext();
  if (!context.facilityId) {
    container.append(emptyState("Select a facility in the top bar to manage its forms and custom fields."));
    return;
  }
  const facilityId = context.facilityId;
  const statusRegion = el("div", { class: "status-region", role: "status", "aria-live": "polite" }, []);
  container.append(statusRegion);

  const fieldsSection = el("section", { class: "panel", "aria-labelledby": "cf-heading" }, [
    el("h2", { id: "cf-heading" }, ["Custom field registry"])
  ]);
  const builderSection = el("section", { class: "panel", "aria-labelledby": "fb-heading" }, [
    el("h2", { id: "fb-heading" }, ["Build a form draft"])
  ]);
  const formsSection = el("section", { class: "panel", "aria-labelledby": "fl-heading" }, [
    el("h2", { id: "fl-heading" }, ["Forms"])
  ]);
  container.append(fieldsSection, builderSection, formsSection);

  let customFields = [];

  async function loadFields() {
    customFields = (await api.get(`/facilities/${encodeURIComponent(facilityId)}/custom-fields`)) ?? [];
  }

  function renderFieldsTable() {
    const body = fieldsSection.querySelector("[data-region=cf-table]");
    clearChildren(body);
    if (customFields.length === 0) {
      body.append(emptyState("No custom fields yet. Add one below."));
      return;
    }
    const table = el("table", { class: "data-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { scope: "col" }, ["Key"]),
          el("th", { scope: "col" }, ["Label"]),
          el("th", { scope: "col" }, ["Type"]),
          el("th", { scope: "col" }, ["Active"]),
          el("th", { scope: "col" }, ["Actions"])
        ])
      ])
    ]);
    const tbody = el("tbody", {}, []);
    for (const field of customFields) {
      const toggle = el("button", { type: "button", class: "ghost-button" }, [field.active ? "Deactivate" : "Activate"]);
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try {
          await api.patch(`/custom-fields/${encodeURIComponent(field.id)}`, { active: !field.active });
          await loadFields();
          renderFieldsTable();
          refreshFieldPicker();
        } catch (error) {
          toast(`Could not update field: ${error.message}`, { tone: "error" });
          toggle.disabled = false;
        }
      });
      tbody.append(
        el("tr", {}, [
          el("td", {}, [el("code", {}, [field.key])]),
          el("td", {}, [field.label]),
          el("td", {}, [field.data_type]),
          el("td", {}, [el("span", { class: `badge ${field.active ? "badge-on" : "badge-off"}` }, [field.active ? "Active" : "Inactive"])]),
          el("td", { class: "row-actions" }, [toggle])
        ])
      );
    }
    table.append(tbody);
    body.append(tableScroll(table));
  }

  fieldsSection.append(el("div", { "data-region": "cf-table" }, []));
  fieldsSection.append(buildAddFieldForm({ facilityId, statusRegion, onAdded: async () => {
    await loadFields();
    renderFieldsTable();
    refreshFieldPicker();
  } }));

  // --- Form builder ---------------------------------------------------------
  const rows = [];
  const rowsRegion = el("div", { "data-region": "fb-rows" }, []);
  const preview = el("pre", { class: "json-preview", "aria-label": "Schema preview" }, ["{}"]);
  const moduleInput = el("input", { type: "text", id: "fb-module", placeholder: "daily_reports", autocomplete: "off" });
  const codeInput = el("input", { type: "text", id: "fb-code", placeholder: "opening_checklist", autocomplete: "off" });
  const fieldPicker = el("select", { id: "fb-field-picker", "aria-label": "Custom field to add" }, []);

  function refreshFieldPicker() {
    clearChildren(fieldPicker);
    const active = customFields.filter((field) => field.active);
    if (active.length === 0) {
      fieldPicker.append(el("option", { value: "" }, ["(no active custom fields)"]));
      return;
    }
    for (const field of active) {
      fieldPicker.append(el("option", { value: field.key }, [`${field.label} (${field.key})`]));
    }
  }

  function updatePreview() {
    const fieldsByKey = new Map(customFields.map((field) => [field.key, field]));
    preview.textContent = JSON.stringify(schemaFromRows(rows, fieldsByKey), null, 2);
  }

  function renderRows() {
    clearChildren(rowsRegion);
    if (rows.length === 0) {
      rowsRegion.append(emptyState("No fields bound yet. Pick a custom field and add it."));
    }
    rows.forEach((row, index) => {
      const requiredBox = el("input", { type: "checkbox", "aria-label": `${row.key} required` });
      requiredBox.checked = row.required;
      requiredBox.addEventListener("change", () => {
        row.required = requiredBox.checked;
        updatePreview();
      });
      const up = el("button", { type: "button", class: "ghost-button", "aria-label": "Move up" }, ["↑"]);
      const down = el("button", { type: "button", class: "ghost-button", "aria-label": "Move down" }, ["↓"]);
      const remove = el("button", { type: "button", class: "ghost-button", "aria-label": "Remove" }, ["Remove"]);
      up.disabled = index === 0;
      down.disabled = index === rows.length - 1;
      up.addEventListener("click", () => {
        [rows[index - 1], rows[index]] = [rows[index], rows[index - 1]];
        renderRows();
        updatePreview();
      });
      down.addEventListener("click", () => {
        [rows[index + 1], rows[index]] = [rows[index], rows[index + 1]];
        renderRows();
        updatePreview();
      });
      remove.addEventListener("click", () => {
        rows.splice(index, 1);
        renderRows();
        updatePreview();
      });
      rowsRegion.append(
        el("div", { class: "field-binding-row" }, [
          el("span", { class: "field-binding-key" }, [el("code", {}, [row.key])]),
          el("label", { class: "field-binding-required" }, [requiredBox, el("span", {}, ["Required"])]),
          el("span", { class: "row-actions" }, [up, down, remove])
        ])
      );
    });
  }

  const addRowButton = el("button", { type: "button", class: "ghost-button" }, ["Add field"]);
  addRowButton.addEventListener("click", () => {
    const key = fieldPicker.value;
    if (!key) return;
    if (rows.some((row) => row.key === key)) {
      toast("That field is already bound.", { tone: "info" });
      return;
    }
    rows.push({ key, required: false });
    renderRows();
    updatePreview();
  });

  const createButton = el("button", { type: "submit", class: "primary-button" }, ["Create draft version"]);
  const builderForm = el(
    "form",
    {
      class: "settings-form",
      "aria-label": "Form builder",
      onsubmit: async (event) => {
        event.preventDefault();
        createButton.disabled = true;
        const fieldsByKey = new Map(customFields.map((field) => [field.key, field]));
        try {
          await api.post(`/facilities/${encodeURIComponent(facilityId)}/forms`, {
            moduleCode: moduleInput.value.trim(),
            formCode: codeInput.value.trim(),
            schema: schemaFromRows(rows, fieldsByKey)
          });
          statusRegion.textContent = `Created a draft version of ${codeInput.value.trim()}.`;
          toast("Draft form version created.", { tone: "success" });
          rows.length = 0;
          renderRows();
          updatePreview();
          await loadAndRenderForms();
        } catch (error) {
          statusRegion.textContent = `Could not create form: ${error.message}`;
          toast(`Could not create form: ${error.message}`, { tone: "error" });
        } finally {
          createButton.disabled = false;
        }
      }
    },
    [
      el("label", {}, [el("span", {}, ["Module code"]), moduleInput]),
      el("label", {}, [el("span", {}, ["Form code"]), codeInput]),
      el("div", { class: "field-picker-row" }, [fieldPicker, addRowButton]),
      rowsRegion,
      el("div", { class: "detail-subhead" }, ["Schema preview"]),
      preview,
      createButton
    ]
  );
  builderSection.append(builderForm);

  // --- Forms list -----------------------------------------------------------
  formsSection.append(el("div", { "data-region": "fl-body" }, []));

  async function loadAndRenderForms() {
    const body = formsSection.querySelector("[data-region=fl-body]");
    clearChildren(body);
    let forms = [];
    try {
      forms = (await api.get(`/facilities/${encodeURIComponent(facilityId)}/forms`)) ?? [];
    } catch (error) {
      body.append(errorBanner(`Could not load forms: ${error.message}`));
      return;
    }
    if (forms.length === 0) {
      body.append(emptyState("No forms yet. Build a draft above."));
      return;
    }
    const groups = new Map();
    for (const form of forms) {
      if (!groups.has(form.form_code)) groups.set(form.form_code, []);
      groups.get(form.form_code).push(form);
    }
    for (const [formCode, versions] of groups) {
      const list = el("ul", { class: "version-list" }, []);
      for (const version of versions) {
        const chips = el("span", {}, [
          el("span", { class: "badge badge-custom" }, [`v${version.version_no}`]),
          " ",
          el("span", { class: `badge ${STATUS_TONE[version.status] ?? "badge-off"}` }, [version.status])
        ]);
        const actions = el("span", { class: "row-actions" }, []);
        if (version.status === "draft") {
          const publish = el("button", { type: "button", class: "ghost-button" }, ["Publish"]);
          publish.addEventListener("click", async () => {
            publish.disabled = true;
            try {
              await api.post(`/forms/${encodeURIComponent(version.id)}/publish`);
              statusRegion.textContent = `Published ${formCode} v${version.version_no}.`;
              toast("Form published; prior published versions retired.", { tone: "success" });
              await loadAndRenderForms();
            } catch (error) {
              toast(`Could not publish: ${error.message}`, { tone: "error" });
              publish.disabled = false;
            }
          });
          actions.append(publish);
        }
        list.append(el("li", { class: "version-row" }, [chips, actions]));
      }
      formsSection.querySelector("[data-region=fl-body]").append(
        el("div", { class: "subpanel" }, [el("h3", {}, [el("code", {}, [formCode])]), list])
      );
    }
  }

  try {
    await loadFields();
  } catch (error) {
    fieldsSection.append(errorBanner(`Could not load custom fields: ${error.message}`));
  }
  renderFieldsTable();
  refreshFieldPicker();
  renderRows();
  updatePreview();
  await loadAndRenderForms();
}

function buildAddFieldForm({ facilityId, statusRegion, onAdded }) {
  const keyInput = el("input", { type: "text", id: "cf-key", placeholder: "pool_ready", autocomplete: "off" });
  const labelInput = el("input", { type: "text", id: "cf-label", placeholder: "Pool ready", autocomplete: "off" });
  const typeSelect = el("select", { id: "cf-type" }, FIELD_TYPES.map((type) => el("option", { value: type }, [type])));
  const entityInput = el("input", { type: "text", id: "cf-entity", value: "report", autocomplete: "off" });
  const submit = el("button", { type: "submit", class: "primary-button" }, ["Add custom field"]);

  return el(
    "form",
    {
      class: "settings-form",
      "aria-label": "Add custom field",
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          await api.post(`/facilities/${encodeURIComponent(facilityId)}/custom-fields`, {
            key: keyInput.value.trim(),
            label: labelInput.value.trim(),
            dataType: typeSelect.value,
            entityType: entityInput.value.trim() || "report"
          });
          statusRegion.textContent = `Added custom field ${keyInput.value.trim()}.`;
          toast("Custom field added.", { tone: "success" });
          keyInput.value = "";
          labelInput.value = "";
          await onAdded();
        } catch (error) {
          statusRegion.textContent = `Could not add field: ${error.message}`;
          toast(`Could not add field: ${error.message}`, { tone: "error" });
        } finally {
          submit.disabled = false;
        }
      }
    },
    [
      el("label", {}, [el("span", {}, ["Key (snake_case)"]), keyInput]),
      el("label", {}, [el("span", {}, ["Label"]), labelInput]),
      el("label", {}, [el("span", {}, ["Type"]), typeSelect]),
      el("label", {}, [el("span", {}, ["Entity type"]), entityInput]),
      submit
    ]
  );
}
