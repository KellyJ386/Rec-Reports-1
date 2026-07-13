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

// Builds a report-template schema (sections -> fields) from the builder canvas
// state. Field label/type/options come from the custom-field registry when the
// key is registered; otherwise from the row's `spec` fallback (kept when a
// draft whose keys have since left the registry is loaded for editing), so
// editing never silently rewrites fields the registry no longer knows.
function schemaFromSections(sections, fieldsByKey) {
  return {
    sections: sections.map((section) => ({
      title: section.title,
      fields: section.rows.map((row) => {
        const field = fieldsByKey.get(row.key);
        const fallback = row.spec ?? {};
        const spec = {
          key: row.key,
          label: field?.label ?? fallback.label ?? row.key,
          type: field?.data_type ?? fallback.type ?? "text",
          required: row.required
        };
        const options = field ? field.validation_jsonb?.options : fallback.options;
        if (Array.isArray(options) && options.length > 0) spec.options = options;
        return spec;
      })
    }))
  };
}

// Reads the JSON payload set at dragstart. getData is only readable on drop
// (per the DnD spec), so dragover handlers style without inspecting it.
function parseDragData(event) {
  try {
    const raw = event.dataTransfer.getData("text/plain");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
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
    el("h2", { id: "fb-heading" }, ["Form builder"])
  ]);
  const formsSection = el("section", { class: "panel", "aria-labelledby": "fl-heading" }, [
    el("h2", { id: "fl-heading" }, ["Forms"])
  ]);
  container.append(fieldsSection, builderSection, formsSection);

  let customFields = [];

  async function loadFields() {
    customFields = (await api.get(`/facilities/${encodeURIComponent(facilityId)}/custom-fields`)) ?? [];
  }

  function fieldsByKey() {
    return new Map(customFields.map((field) => [field.key, field]));
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
          renderPalette();
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
    renderPalette();
  } }));

  // --- Form builder ---------------------------------------------------------
  // Canvas state: an ordered list of sections, each holding ordered rows of
  // { key, required, spec? }. `editing` carries the draft being edited in
  // place (null while composing a brand-new draft).
  const sections = [{ title: "Fields", rows: [] }];
  let editing = null;

  const preview = el("pre", { class: "json-preview", "aria-label": "Schema preview" }, ["{}"]);
  const moduleInput = el("input", { type: "text", id: "fb-module", placeholder: "daily_reports", autocomplete: "off" });
  const codeInput = el("input", { type: "text", id: "fb-code", placeholder: "opening_checklist", autocomplete: "off" });
  const paletteList = el("div", { class: "palette-list", role: "list", "aria-label": "Field palette" }, []);
  const canvas = el("div", { class: "builder-canvas", "aria-label": "Form canvas" }, []);
  const submitButton = el("button", { type: "submit", class: "primary-button" }, ["Create draft version"]);
  const cancelEditButton = el("button", { type: "button", class: "ghost-button", hidden: true }, ["Cancel edit"]);

  function updatePreview() {
    preview.textContent = JSON.stringify(schemaFromSections(sections, fieldsByKey()), null, 2);
  }

  function keyOnCanvas(key) {
    return sections.some((section) => section.rows.some((row) => row.key === key));
  }

  function addFieldToSection(key, sectionIndex, insertAt) {
    if (keyOnCanvas(key)) {
      toast("That field is already on the canvas.", { tone: "info" });
      return;
    }
    const section = sections[sectionIndex];
    if (!section) return;
    const row = { key, required: false };
    if (insertAt === undefined) section.rows.push(row);
    else section.rows.splice(insertAt, 0, row);
    renderCanvas();
    updatePreview();
  }

  function moveRow(from, to) {
    const [fromSection, fromIndex] = from;
    let [toSection, toIndex] = to;
    const source = sections[fromSection];
    const target = sections[toSection];
    if (!source || !target) return;
    const [row] = source.rows.splice(fromIndex, 1);
    if (!row) return;
    if (fromSection === toSection && fromIndex < toIndex) toIndex -= 1;
    if (toIndex === undefined) target.rows.push(row);
    else target.rows.splice(toIndex, 0, row);
    renderCanvas();
    updatePreview();
  }

  function handleCanvasDrop(event, sectionIndex, insertAt) {
    const data = parseDragData(event);
    if (!data) return;
    if (data.kind === "palette") addFieldToSection(data.key, sectionIndex, insertAt);
    else if (data.kind === "move") moveRow(data.from, [sectionIndex, insertAt]);
  }

  function clearDropMarkers() {
    for (const marked of canvas.querySelectorAll(".drag-over, .drag-over-top, .drag-over-bottom")) {
      marked.classList.remove("drag-over", "drag-over-top", "drag-over-bottom");
    }
  }

  function renderPalette() {
    clearChildren(paletteList);
    const active = customFields.filter((field) => field.active);
    if (active.length === 0) {
      paletteList.append(emptyState("No active custom fields. Add one in the registry above."));
      return;
    }
    for (const field of active) {
      const onCanvas = keyOnCanvas(field.key);
      const item = el(
        "button",
        {
          type: "button",
          class: `palette-item${onCanvas ? " palette-item-used" : ""}`,
          role: "listitem",
          draggable: "true",
          "aria-label": `Add ${field.label} to the canvas`
        },
        [
          el("span", { class: "palette-item-label" }, [field.label]),
          el("span", { class: "palette-item-meta" }, [el("code", {}, [field.key]), ` · ${field.data_type}`])
        ]
      );
      item.addEventListener("dragstart", (event) => {
        event.dataTransfer.setData("text/plain", JSON.stringify({ kind: "palette", key: field.key }));
        event.dataTransfer.effectAllowed = "copy";
      });
      item.addEventListener("click", () => {
        addFieldToSection(field.key, sections.length - 1);
      });
      paletteList.append(item);
    }
  }

  function renderFieldRow(row, sectionIndex, rowIndex) {
    const field = fieldsByKey().get(row.key);
    const fallback = row.spec ?? {};
    const label = field?.label ?? fallback.label ?? row.key;
    const type = field?.data_type ?? fallback.type ?? "text";

    const requiredBox = el("input", { type: "checkbox", "aria-label": `${row.key} required` });
    requiredBox.checked = row.required;
    requiredBox.addEventListener("change", () => {
      row.required = requiredBox.checked;
      updatePreview();
    });

    const up = el("button", { type: "button", class: "ghost-button", "aria-label": `Move ${row.key} up` }, ["↑"]);
    const down = el("button", { type: "button", class: "ghost-button", "aria-label": `Move ${row.key} down` }, ["↓"]);
    const remove = el("button", { type: "button", class: "ghost-button", "aria-label": `Remove ${row.key}` }, ["Remove"]);
    up.disabled = rowIndex === 0;
    down.disabled = rowIndex === sections[sectionIndex].rows.length - 1;
    up.addEventListener("click", () => moveRow([sectionIndex, rowIndex], [sectionIndex, rowIndex - 1]));
    down.addEventListener("click", () => moveRow([sectionIndex, rowIndex], [sectionIndex, rowIndex + 2]));
    remove.addEventListener("click", () => {
      sections[sectionIndex].rows.splice(rowIndex, 1);
      renderCanvas();
      updatePreview();
    });

    const rowNode = el("div", { class: "field-binding-row canvas-row", draggable: "true" }, [
      el("span", { class: "drag-handle", "aria-hidden": "true" }, ["⋮⋮"]),
      el("span", { class: "field-binding-key" }, [
        el("strong", {}, [label]),
        el("span", { class: "palette-item-meta" }, [" ", el("code", {}, [row.key]), ` · ${type}`])
      ]),
      el("label", { class: "field-binding-required" }, [requiredBox, el("span", {}, ["Required"])]),
      el("span", { class: "row-actions" }, [up, down, remove])
    ]);
    rowNode.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData(
        "text/plain",
        JSON.stringify({ kind: "move", from: [sectionIndex, rowIndex] })
      );
      event.dataTransfer.effectAllowed = "move";
      window.setTimeout(() => rowNode.classList.add("drag-ghost"), 0);
    });
    rowNode.addEventListener("dragend", () => {
      rowNode.classList.remove("drag-ghost");
      clearDropMarkers();
    });
    rowNode.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = rowNode.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      rowNode.classList.toggle("drag-over-top", before);
      rowNode.classList.toggle("drag-over-bottom", !before);
    });
    rowNode.addEventListener("dragleave", () => {
      rowNode.classList.remove("drag-over-top", "drag-over-bottom");
    });
    rowNode.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = rowNode.getBoundingClientRect();
      const before = event.clientY < rect.top + rect.height / 2;
      clearDropMarkers();
      handleCanvasDrop(event, sectionIndex, before ? rowIndex : rowIndex + 1);
    });
    return rowNode;
  }

  function renderCanvas() {
    clearChildren(canvas);
    sections.forEach((section, sectionIndex) => {
      const titleInput = el("input", {
        type: "text",
        value: section.title,
        "aria-label": `Section ${sectionIndex + 1} title`
      });
      titleInput.addEventListener("input", () => {
        section.title = titleInput.value;
        updatePreview();
      });

      const upSection = el("button", { type: "button", class: "ghost-button", "aria-label": "Move section up" }, ["↑"]);
      const downSection = el("button", { type: "button", class: "ghost-button", "aria-label": "Move section down" }, ["↓"]);
      const removeSection = el("button", { type: "button", class: "ghost-button", "aria-label": "Remove section" }, ["Remove section"]);
      upSection.disabled = sectionIndex === 0;
      downSection.disabled = sectionIndex === sections.length - 1;
      removeSection.disabled = sections.length === 1;
      upSection.addEventListener("click", () => {
        [sections[sectionIndex - 1], sections[sectionIndex]] = [sections[sectionIndex], sections[sectionIndex - 1]];
        renderCanvas();
        updatePreview();
      });
      downSection.addEventListener("click", () => {
        [sections[sectionIndex + 1], sections[sectionIndex]] = [sections[sectionIndex], sections[sectionIndex + 1]];
        renderCanvas();
        updatePreview();
      });
      removeSection.addEventListener("click", () => {
        if (section.rows.length > 0 && !window.confirm("Remove this section and its fields from the canvas?")) return;
        sections.splice(sectionIndex, 1);
        renderCanvas();
        updatePreview();
      });

      const fieldsRegion = el("div", { class: "builder-fields" }, []);
      if (section.rows.length === 0) {
        fieldsRegion.append(el("p", { class: "drop-hint" }, ["Drag fields here from the palette, or click a palette entry."]));
      }
      section.rows.forEach((row, rowIndex) => {
        fieldsRegion.append(renderFieldRow(row, sectionIndex, rowIndex));
      });
      fieldsRegion.addEventListener("dragover", (event) => {
        event.preventDefault();
        fieldsRegion.classList.add("drag-over");
      });
      fieldsRegion.addEventListener("dragleave", () => {
        fieldsRegion.classList.remove("drag-over");
      });
      fieldsRegion.addEventListener("drop", (event) => {
        event.preventDefault();
        clearDropMarkers();
        handleCanvasDrop(event, sectionIndex, undefined);
      });

      canvas.append(
        el("div", { class: "builder-section" }, [
          el("div", { class: "builder-section-header" }, [
            el("label", { class: "builder-section-title" }, [el("span", {}, ["Section title"]), titleInput]),
            el("span", { class: "row-actions" }, [upSection, downSection, removeSection])
          ]),
          fieldsRegion
        ])
      );
    });

    const addSection = el("button", { type: "button", class: "ghost-button" }, ["Add section"]);
    addSection.addEventListener("click", () => {
      sections.push({ title: `Section ${sections.length + 1}`, rows: [] });
      renderCanvas();
      updatePreview();
    });
    canvas.append(el("div", { class: "builder-canvas-actions" }, [addSection]));
    renderPalette();
  }

  function updateBuilderMode() {
    submitButton.textContent = editing ? `Save draft v${editing.versionNo}` : "Create draft version";
    cancelEditButton.hidden = !editing;
    moduleInput.disabled = Boolean(editing);
    codeInput.disabled = Boolean(editing);
  }

  function resetBuilder() {
    editing = null;
    moduleInput.value = "";
    codeInput.value = "";
    sections.length = 0;
    sections.push({ title: "Fields", rows: [] });
    renderCanvas();
    updatePreview();
    updateBuilderMode();
  }

  function loadDraftIntoBuilder(version) {
    editing = { id: version.id, formCode: version.form_code, versionNo: version.version_no };
    moduleInput.value = version.module_code ?? "";
    codeInput.value = version.form_code ?? "";
    sections.length = 0;
    const loaded = Array.isArray(version.schema_jsonb?.sections) ? version.schema_jsonb.sections : [];
    for (const section of loaded) {
      sections.push({
        title: section.title ?? "Fields",
        rows: (Array.isArray(section.fields) ? section.fields : []).map((field) => ({
          key: field.key,
          required: Boolean(field.required),
          spec: field
        }))
      });
    }
    if (sections.length === 0) sections.push({ title: "Fields", rows: [] });
    renderCanvas();
    updatePreview();
    updateBuilderMode();
    statusRegion.textContent = `Editing draft ${version.form_code} v${version.version_no}.`;
    builderSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  cancelEditButton.addEventListener("click", () => {
    resetBuilder();
    statusRegion.textContent = "Edit cancelled.";
  });

  // Light client-side pre-check mirroring the server validator's structural
  // rules, so common mistakes fail with a pointed message before a round-trip.
  function canvasProblems() {
    const problems = [];
    if (sections.length === 0) problems.push("add at least one section");
    sections.forEach((section, index) => {
      if (!section.title.trim()) problems.push(`section ${index + 1} needs a title`);
      if (section.rows.length === 0) problems.push(`section "${section.title.trim() || index + 1}" needs at least one field`);
    });
    return problems;
  }

  const builderForm = el(
    "form",
    {
      class: "settings-form",
      "aria-label": "Form builder",
      onsubmit: async (event) => {
        event.preventDefault();
        const problems = canvasProblems();
        if (problems.length > 0) {
          toast(`Fix the canvas first: ${problems.join("; ")}.`, { tone: "error" });
          return;
        }
        submitButton.disabled = true;
        const schema = schemaFromSections(sections, fieldsByKey());
        try {
          if (editing) {
            await api.patch(`/forms/${encodeURIComponent(editing.id)}`, { schema });
            statusRegion.textContent = `Saved draft ${editing.formCode} v${editing.versionNo}.`;
            toast("Draft saved.", { tone: "success" });
            resetBuilder();
          } else {
            await api.post(`/facilities/${encodeURIComponent(facilityId)}/forms`, {
              moduleCode: moduleInput.value.trim(),
              formCode: codeInput.value.trim(),
              schema
            });
            statusRegion.textContent = `Created a draft version of ${codeInput.value.trim()}.`;
            toast("Draft form version created.", { tone: "success" });
            resetBuilder();
          }
          await loadAndRenderForms();
        } catch (error) {
          statusRegion.textContent = `Could not save form: ${error.message}`;
          toast(`Could not save form: ${error.message}`, { tone: "error" });
        } finally {
          submitButton.disabled = false;
        }
      }
    },
    [
      el("label", {}, [el("span", {}, ["Module code"]), moduleInput]),
      el("label", {}, [el("span", {}, ["Form code"]), codeInput]),
      el("div", { class: "builder-layout" }, [
        el("aside", { class: "field-palette" }, [
          el("h3", {}, ["Field palette"]),
          paletteList,
          el("p", { class: "palette-hint" }, ["Drag a field onto the canvas, or click it to append."])
        ]),
        canvas
      ]),
      el("div", { class: "detail-subhead" }, ["Schema preview"]),
      preview,
      el("div", { class: "row-actions" }, [submitButton, cancelEditButton])
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
          const edit = el("button", { type: "button", class: "ghost-button" }, ["Edit"]);
          edit.addEventListener("click", () => loadDraftIntoBuilder(version));
          actions.append(edit);
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
  renderCanvas();
  updatePreview();
  updateBuilderMode();
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
