import { api } from "../api.js";
import { el, clearChildren, errorBanner, emptyState, tableScroll, toast } from "../ui.js";
import { getContext, setContext } from "../state.js";

function extractSettings(raw) {
  const settings = raw?.settings ?? raw?.settings_jsonb ?? raw ?? {};
  const reporting = settings.reporting ?? {};
  const notifications = settings.notifications ?? {};
  return {
    dailyReportDueHour:
      reporting.dailyReportDueHour ?? settings.dailyReportDueHour ?? "",
    quietStart: notifications.quietHoursStart ?? "",
    quietEnd: notifications.quietHoursEnd ?? ""
  };
}

export async function renderFacilities(container) {
  container.append(el("h1", {}, ["Facilities & Departments"]));

  const context = getContext();
  if (!context.orgId) {
    container.append(emptyState("Set an Organization ID in the top bar to manage facilities and departments."));
    return;
  }

  const statusRegion = el("div", { class: "status-region", role: "status", "aria-live": "polite" }, []);
  container.append(statusRegion);

  let facilities = [];
  try {
    facilities = (await api.get(`/org/${encodeURIComponent(context.orgId)}/facilities`)) ?? [];
  } catch (error) {
    container.append(errorBanner(`Could not load facilities: ${error.message}`));
    facilities = [];
  }

  const listSection = el("section", { class: "panel", "aria-labelledby": "facility-list-heading" }, [
    el("h2", { id: "facility-list-heading" }, ["Facilities"])
  ]);
  container.append(listSection);

  const listBody = el("div", {}, []);
  listSection.append(listBody);

  const detailSection = el("section", { class: "panel", "aria-labelledby": "facility-detail-heading" }, [
    el("h2", { id: "facility-detail-heading" }, ["Departments & settings"])
  ]);
  container.append(detailSection);
  const detailBody = el("div", {}, []);
  detailSection.append(detailBody);

  let selectedFacilityId = context.facilityId && facilities.some((f) => f.id === context.facilityId)
    ? context.facilityId
    : facilities[0]?.id ?? null;

  function selectFacility(id) {
    selectedFacilityId = id;
    setContext({ facilityId: id ?? "" });
    renderList();
    renderDetail();
  }

  function renderList() {
    clearChildren(listBody);
    listBody.append(buildCreateFacilityForm({ orgId: context.orgId, statusRegion, onCreated: (facility) => {
      facilities.push(facility);
      selectFacility(facility.id);
    } }));

    if (facilities.length === 0) {
      listBody.append(emptyState("No facilities yet. Create one above."));
      return;
    }

    const table = el("table", { class: "data-table" }, [
      el("caption", { class: "sr-only" }, ["Facility list with rename controls"]),
      el("thead", {}, [
        el("tr", {}, [
          el("th", { scope: "col" }, ["Facility"]),
          el("th", { scope: "col" }, ["Timezone"]),
          el("th", { scope: "col" }, ["Locale"]),
          el("th", { scope: "col" }, ["Actions"])
        ])
      ])
    ]);
    const tbody = el("tbody", {}, []);
    table.append(tbody);

    for (const facility of facilities) {
      tbody.append(buildFacilityRow({ facility, isSelected: facility.id === selectedFacilityId, statusRegion, onSelect: selectFacility, onRenamed: (updated) => {
        Object.assign(facility, updated);
        renderList();
      } }));
    }
    listBody.append(tableScroll(table));
  }

  async function renderDetail() {
    clearChildren(detailBody);
    if (!selectedFacilityId) {
      detailBody.append(emptyState("Select a facility above to manage its departments and settings."));
      return;
    }
    const facility = facilities.find((f) => f.id === selectedFacilityId);
    detailBody.append(el("p", { class: "detail-subhead" }, [`Managing: ${facility ? facility.name : selectedFacilityId}`]));
    detailBody.append(await buildDepartmentsPanel({ facilityId: selectedFacilityId, statusRegion }));
    detailBody.append(await buildSettingsPanel({ facilityId: selectedFacilityId, facility, statusRegion }));
  }

  renderList();
  await renderDetail();
}

function buildCreateFacilityForm({ orgId, statusRegion, onCreated }) {
  const nameId = "new-facility-name";
  const tzId = "new-facility-timezone";
  const localeId = "new-facility-locale";

  const nameInput = el("input", { type: "text", id: nameId, required: true, autocomplete: "off" });
  const tzInput = el("input", { type: "text", id: tzId, placeholder: "e.g. America/New_York", autocomplete: "off" });
  const localeInput = el("input", { type: "text", id: localeId, placeholder: "e.g. en-US", autocomplete: "off" });

  const form = el(
    "form",
    {
      class: "inline-form",
      "aria-label": "Create facility",
      onsubmit: async (event) => {
        event.preventDefault();
        const submitButton = form.querySelector("button[type=submit]");
        submitButton.disabled = true;
        try {
          const created = await api.post(`/org/${encodeURIComponent(orgId)}/facilities`, {
            name: nameInput.value.trim(),
            timezone: tzInput.value.trim() || undefined,
            locale: localeInput.value.trim() || undefined
          });
          statusRegion.textContent = `Created facility ${nameInput.value.trim()}.`;
          toast(`Created facility ${nameInput.value.trim()}.`, { tone: "success" });
          form.reset();
          onCreated(created ?? { id: crypto.randomUUID(), name: nameInput.value.trim() });
        } catch (error) {
          statusRegion.textContent = `Could not create facility: ${error.message}`;
          toast(`Could not create facility: ${error.message}`, { tone: "error" });
        } finally {
          submitButton.disabled = false;
        }
      }
    },
    [
      el("label", {}, [el("span", {}, ["Name"]), nameInput]),
      el("label", {}, [el("span", {}, ["Timezone"]), tzInput]),
      el("label", {}, [el("span", {}, ["Locale"]), localeInput]),
      el("button", { type: "submit", class: "primary-button" }, ["Add facility"])
    ]
  );
  return el("fieldset", { class: "create-fieldset" }, [el("legend", {}, ["Create a facility"]), form]);
}

function buildFacilityRow({ facility, isSelected, statusRegion, onSelect, onRenamed }) {
  const nameId = `facility-name-${facility.id}`;
  const tzId = `facility-tz-${facility.id}`;
  const localeId = `facility-locale-${facility.id}`;

  const nameInput = el("input", { type: "text", id: nameId, value: facility.name ?? "" });
  const tzInput = el("input", { type: "text", id: tzId, value: facility.timezone ?? "" });
  const localeInput = el("input", { type: "text", id: localeId, value: facility.locale ?? "" });

  const saveButton = el("button", { type: "button", class: "ghost-button" }, ["Save"]);
  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    try {
      const updated = await api.patch(`/facilities/${encodeURIComponent(facility.id)}`, {
        name: nameInput.value.trim(),
        timezone: tzInput.value.trim() || undefined,
        locale: localeInput.value.trim() || undefined
      });
      statusRegion.textContent = `Saved facility ${nameInput.value.trim()}.`;
      toast(`Saved facility ${nameInput.value.trim()}.`, { tone: "success" });
      onRenamed(updated ?? { name: nameInput.value.trim(), timezone: tzInput.value.trim(), locale: localeInput.value.trim() });
    } catch (error) {
      statusRegion.textContent = `Could not save facility: ${error.message}`;
      toast(`Could not save facility: ${error.message}`, { tone: "error" });
    } finally {
      saveButton.disabled = false;
    }
  });

  const manageButton = el("button", { type: "button", class: isSelected ? "primary-button" : "ghost-button" }, [
    isSelected ? "Managing" : "Manage"
  ]);
  manageButton.addEventListener("click", () => onSelect(facility.id));

  return el("tr", {}, [
    el("td", {}, [el("label", { class: "sr-only", for: nameId }, ["Facility name"]), nameInput]),
    el("td", {}, [el("label", { class: "sr-only", for: tzId }, ["Facility timezone"]), tzInput]),
    el("td", {}, [el("label", { class: "sr-only", for: localeId }, ["Facility locale"]), localeInput]),
    el("td", { class: "row-actions" }, [saveButton, manageButton])
  ]);
}

async function buildDepartmentsPanel({ facilityId, statusRegion }) {
  const panel = el("div", { class: "subpanel" }, [el("h3", {}, ["Departments"])]);
  let departments = [];
  try {
    departments = (await api.get(`/facilities/${encodeURIComponent(facilityId)}/departments`)) ?? [];
  } catch (error) {
    panel.append(errorBanner(`Could not load departments: ${error.message}`));
    return panel;
  }

  const list = el("ul", { class: "department-list" }, []);

  function renderDepartments() {
    clearChildren(list);
    if (departments.length === 0) {
      list.append(el("li", {}, [emptyState("No departments yet.")]));
      return;
    }
    for (const department of departments) {
      const inputId = `department-name-${department.id}`;
      const input = el("input", { type: "text", id: inputId, value: department.name ?? "" });
      const label = el("label", { class: "sr-only", for: inputId }, ["Department name"]);
      const saveButton = el("button", { type: "button", class: "ghost-button" }, ["Save"]);
      saveButton.addEventListener("click", async () => {
        saveButton.disabled = true;
        try {
          const updated = await api.patch(`/departments/${encodeURIComponent(department.id)}`, {
            name: input.value.trim()
          });
          department.name = updated?.name ?? input.value.trim();
          statusRegion.textContent = `Renamed department to ${department.name}.`;
          toast(`Renamed department to ${department.name}.`, { tone: "success" });
        } catch (error) {
          statusRegion.textContent = `Could not rename department: ${error.message}`;
          toast(`Could not rename department: ${error.message}`, { tone: "error" });
        } finally {
          saveButton.disabled = false;
        }
      });
      list.append(el("li", { class: "department-row" }, [label, input, saveButton]));
    }
  }
  renderDepartments();
  panel.append(list);

  const newNameId = `new-department-name-${facilityId}`;
  const newNameInput = el("input", { type: "text", id: newNameId, required: true, autocomplete: "off" });
  const createForm = el(
    "form",
    {
      class: "inline-form",
      "aria-label": "Create department",
      onsubmit: async (event) => {
        event.preventDefault();
        const submitButton = createForm.querySelector("button[type=submit]");
        submitButton.disabled = true;
        try {
          const created = await api.post(`/facilities/${encodeURIComponent(facilityId)}/departments`, {
            name: newNameInput.value.trim()
          });
          departments.push(created ?? { id: crypto.randomUUID(), name: newNameInput.value.trim() });
          statusRegion.textContent = `Created department ${newNameInput.value.trim()}.`;
          toast(`Created department ${newNameInput.value.trim()}.`, { tone: "success" });
          createForm.reset();
          renderDepartments();
        } catch (error) {
          statusRegion.textContent = `Could not create department: ${error.message}`;
          toast(`Could not create department: ${error.message}`, { tone: "error" });
        } finally {
          submitButton.disabled = false;
        }
      }
    },
    [
      el("label", {}, [el("span", {}, ["New department name"]), newNameInput]),
      el("button", { type: "submit", class: "primary-button" }, ["Add department"])
    ]
  );
  panel.append(createForm);

  return panel;
}

async function buildSettingsPanel({ facilityId, facility, statusRegion }) {
  const panel = el("div", { class: "subpanel" }, [el("h3", {}, ["Report & notification defaults"])]);

  let existing = {};
  try {
    const raw = await api.get(`/facilities/${encodeURIComponent(facilityId)}/settings`);
    existing = extractSettings(raw);
  } catch (error) {
    panel.append(errorBanner(`Could not load facility settings: ${error.message}`));
    existing = extractSettings(null);
  }

  const dueHourId = `due-hour-${facilityId}`;
  const quietStartId = `quiet-start-${facilityId}`;
  const quietEndId = `quiet-end-${facilityId}`;

  const dueHourInput = el("input", {
    type: "number",
    id: dueHourId,
    min: "0",
    max: "23",
    value: existing.dailyReportDueHour === "" ? "" : String(existing.dailyReportDueHour)
  });
  const quietStartInput = el("input", { type: "time", id: quietStartId, value: existing.quietStart || "" });
  const quietEndInput = el("input", { type: "time", id: quietEndId, value: existing.quietEnd || "" });

  const form = el(
    "form",
    {
      class: "settings-form",
      "aria-label": `Facility settings for ${facility ? facility.name : facilityId}`,
      onsubmit: async (event) => {
        event.preventDefault();
        const submitButton = form.querySelector("button[type=submit]");
        submitButton.disabled = true;
        const settingsPatch = {
          reporting: {
            dailyReportDueHour: dueHourInput.value === "" ? null : Number(dueHourInput.value)
          },
          notifications: {
            quietHoursStart: quietStartInput.value || null,
            quietHoursEnd: quietEndInput.value || null
          }
        };
        try {
          await api.patch(`/facilities/${encodeURIComponent(facilityId)}/settings`, { settingsPatch });
          statusRegion.textContent = "Saved facility settings.";
          toast("Saved facility settings.", { tone: "success" });
        } catch (error) {
          statusRegion.textContent = `Could not save facility settings: ${error.message}`;
          toast(`Could not save facility settings: ${error.message}`, { tone: "error" });
        } finally {
          submitButton.disabled = false;
        }
      }
    },
    [
      el("label", {}, [el("span", {}, ["Daily report due hour (0-23)"]), dueHourInput]),
      el("label", {}, [el("span", {}, ["Quiet hours start"]), quietStartInput]),
      el("label", {}, [el("span", {}, ["Quiet hours end"]), quietEndInput]),
      el("button", { type: "submit", class: "primary-button" }, ["Save settings"])
    ]
  );
  panel.append(form);
  return panel;
}
