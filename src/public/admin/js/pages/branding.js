import { api } from "../api.js";
import { el, clearChildren, errorBanner, emptyState, tableScroll, toast, formatDateTime } from "../ui.js";
import { getContext } from "../state.js";

const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const STATUS_LABELS = {
  draft: "Draft",
  pending_review: "Pending review",
  approved: "Approved",
  rejected: "Rejected",
  published: "Published"
};

// Maps a change-request status to one of admin.css's existing badge tones
// (badge-on/badge-off/badge-denied) rather than inventing new CSS.
function statusBadgeClass(status) {
  if (status === "published") return "badge-on";
  if (status === "rejected") return "badge-denied";
  return "badge-off";
}

export async function renderBranding(container) {
  container.append(el("h1", {}, ["Branding & Documents"]));

  const context = getContext();
  if (!context.facilityId) {
    container.append(emptyState("Select a facility in the top bar to manage its branding."));
    return;
  }
  const facilityId = context.facilityId;

  const statusRegion = el("div", { class: "status-region", role: "status", "aria-live": "polite" }, []);
  container.append(statusRegion);

  const themeSection = el("section", { class: "panel", "aria-labelledby": "branding-theme-heading" }, [
    el("h2", { id: "branding-theme-heading" }, ["Theme"]),
    el("p", { class: "detail-subhead" }, [
      "Saving stages a draft change request -- it does not touch the live theme until the request is approved and published below."
    ])
  ]);
  container.append(themeSection);

  const crSection = el("section", { class: "panel", "aria-labelledby": "branding-cr-heading" }, [
    el("h2", { id: "branding-cr-heading" }, ["Branding change requests"])
  ]);
  container.append(crSection);
  const crBody = el("div", {}, []);
  crSection.append(crBody);

  let branding = null;
  try {
    branding = await api.get(`/facilities/${encodeURIComponent(facilityId)}/branding`);
  } catch (error) {
    themeSection.append(errorBanner(`Could not load branding: ${error.message}`));
  }

  function applyBrandingPatch(patch) {
    return api.patch(`/facilities/${encodeURIComponent(facilityId)}/branding`, patch);
  }

  async function loadAndRenderChangeRequests() {
    clearChildren(crBody);
    crBody.append(emptyState("Loading change requests…"));
    let rows = [];
    try {
      const all = (await api.get(`/facilities/${encodeURIComponent(facilityId)}/change-requests`)) ?? [];
      rows = all.filter((row) => row.entity_table === "branding_profiles");
    } catch (error) {
      clearChildren(crBody);
      crBody.append(errorBanner(`Could not load change requests: ${error.message}`));
      return;
    }
    clearChildren(crBody);
    crBody.append(
      buildChangeRequestTable(rows, {
        statusRegion,
        onChanged: loadAndRenderChangeRequests,
        applyBrandingPatch
      })
    );
  }

  themeSection.append(
    buildThemeForm({ facilityId, branding, statusRegion, onSaved: loadAndRenderChangeRequests })
  );
  await loadAndRenderChangeRequests();
}

function buildThemeForm({ facilityId, branding, statusRegion, onSaved }) {
  const theme = branding?.theme_jsonb ?? {};

  const nameInput = el("input", {
    type: "text",
    id: "branding-name",
    value: branding?.name ?? "",
    required: true,
    autocomplete: "off"
  });
  const primaryPicker = el("input", {
    type: "color",
    id: "branding-primary-picker",
    "aria-label": "Primary color picker",
    value: HEX_COLOR_RE.test(theme.primary ?? "") ? theme.primary : "#1c6dd0"
  });
  const primaryText = el("input", {
    type: "text",
    id: "branding-primary-text",
    "aria-label": "Primary color hex value",
    value: theme.primary ?? "#1c6dd0"
  });
  const accentPicker = el("input", {
    type: "color",
    id: "branding-accent-picker",
    "aria-label": "Accent color picker",
    value: HEX_COLOR_RE.test(theme.accent ?? "") ? theme.accent : "#9ec5a9"
  });
  const accentText = el("input", {
    type: "text",
    id: "branding-accent-text",
    "aria-label": "Accent color hex value",
    value: theme.accent ?? "#9ec5a9"
  });
  const logoInput = el("input", {
    type: "text",
    id: "branding-logo",
    value: branding?.logo_path ?? "",
    placeholder: "/logos/facility.png",
    autocomplete: "off"
  });

  const swatchPrimary = el("div", { class: "branding-swatch-block" }, []);
  const swatchAccent = el("div", { class: "branding-swatch-block" }, []);
  const swatchLabel = el("div", { class: "branding-swatch-label" }, [branding?.name || "Preview"]);
  const swatch = el("div", { class: "branding-swatch", "aria-hidden": "true" }, [
    swatchPrimary,
    swatchAccent,
    swatchLabel
  ]);

  function updateSwatch() {
    swatchPrimary.style.background = HEX_COLOR_RE.test(primaryText.value) ? primaryText.value : "#1c6dd0";
    swatchAccent.style.background = HEX_COLOR_RE.test(accentText.value) ? accentText.value : "#9ec5a9";
    swatchLabel.textContent = nameInput.value.trim() || "Preview";
  }
  updateSwatch();

  // Keep each color picker and its hex text twin in sync both ways, and
  // refresh the live preview swatch on every edit.
  primaryPicker.addEventListener("input", () => {
    primaryText.value = primaryPicker.value;
    updateSwatch();
  });
  primaryText.addEventListener("input", () => {
    if (HEX_COLOR_RE.test(primaryText.value)) primaryPicker.value = primaryText.value;
    updateSwatch();
  });
  accentPicker.addEventListener("input", () => {
    accentText.value = accentPicker.value;
    updateSwatch();
  });
  accentText.addEventListener("input", () => {
    if (HEX_COLOR_RE.test(accentText.value)) accentPicker.value = accentText.value;
    updateSwatch();
  });
  nameInput.addEventListener("input", updateSwatch);

  const form = el(
    "form",
    {
      class: "settings-form",
      "aria-label": "Branding theme",
      onsubmit: async (event) => {
        event.preventDefault();
        const submitButton = form.querySelector("button[type=submit]");
        submitButton.disabled = true;
        const after = {
          name: nameInput.value.trim(),
          primaryColor: primaryText.value.trim(),
          accentColor: accentText.value.trim(),
          logoPath: logoInput.value.trim()
        };
        const before = {
          name: branding?.name ?? "",
          primaryColor: theme.primary ?? "",
          accentColor: theme.accent ?? "",
          logoPath: branding?.logo_path ?? ""
        };
        try {
          await api.post(`/facilities/${encodeURIComponent(facilityId)}/change-requests`, {
            entityTable: "branding_profiles",
            entityId: branding?.id ?? undefined,
            changeSummary: `Update branding theme "${after.name || facilityId}"`,
            before,
            after
          });
          statusRegion.textContent = "Saved a draft change request for this branding update.";
          toast("Draft change request created. Submit it for review to publish.", { tone: "success" });
          await onSaved();
        } catch (error) {
          statusRegion.textContent = `Could not save branding: ${error.message}`;
          toast(`Could not save branding: ${error.message}`, { tone: "error" });
        } finally {
          submitButton.disabled = false;
        }
      }
    },
    [
      el("label", {}, [el("span", {}, ["Name"]), nameInput]),
      el("label", {}, [
        el("span", {}, ["Primary color"]),
        el("div", { class: "color-field" }, [primaryPicker, primaryText])
      ]),
      el("label", {}, [
        el("span", {}, ["Accent color"]),
        el("div", { class: "color-field" }, [accentPicker, accentText])
      ]),
      el("label", {}, [el("span", {}, ["Logo path"]), logoInput]),
      swatch,
      el("button", { type: "submit", class: "primary-button" }, ["Save as draft change request"])
    ]
  );
  return form;
}

function buildChangeRequestTable(rows, { statusRegion, onChanged, applyBrandingPatch }) {
  if (rows.length === 0) {
    return emptyState("No branding change requests yet. Save a theme above to create one.");
  }

  const table = el("table", { class: "data-table" }, [
    el("caption", { class: "sr-only" }, ["Branding change requests with status and workflow actions"]),
    el("thead", {}, [
      el("tr", {}, [
        el("th", { scope: "col" }, ["Summary"]),
        el("th", { scope: "col" }, ["Status"]),
        el("th", { scope: "col" }, ["Requested"]),
        el("th", { scope: "col" }, ["Actions"])
      ])
    ])
  ]);
  const tbody = el("tbody", {}, []);
  table.append(tbody);
  for (const row of rows) {
    tbody.append(buildChangeRequestRow(row, { statusRegion, onChanged, applyBrandingPatch }));
  }
  return tableScroll(table);
}

function buildChangeRequestRow(row, { statusRegion, onChanged, applyBrandingPatch }) {
  const badge = el("span", { class: `badge ${statusBadgeClass(row.status)}` }, [
    STATUS_LABELS[row.status] ?? row.status
  ]);
  const actions = el("div", { class: "row-actions" }, []);

  function actionButton(label, run) {
    const button = el("button", { type: "button", class: "ghost-button" }, [label]);
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await run();
        statusRegion.textContent = `${label}: done.`;
        toast(`${label} complete.`, { tone: "success" });
        await onChanged();
      } catch (error) {
        statusRegion.textContent = `Could not ${label.toLowerCase()}: ${error.message}`;
        toast(`Could not ${label.toLowerCase()}: ${error.message}`, { tone: "error" });
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  if (row.status === "draft") {
    actions.append(
      actionButton("Submit for review", () => api.post(`/change-requests/${encodeURIComponent(row.id)}/submit`))
    );
  } else if (row.status === "pending_review") {
    actions.append(
      actionButton("Approve", () => api.post(`/change-requests/${encodeURIComponent(row.id)}/approve`)),
      actionButton("Reject", () => api.post(`/change-requests/${encodeURIComponent(row.id)}/reject`))
    );
  } else if (row.status === "approved") {
    actions.append(
      actionButton("Publish", async () => {
        // Publishing a branding change request applies its staged after_jsonb
        // to branding_profiles first, then marks the request published -- the
        // publish endpoint itself only flips status (see workflow-routes.mjs).
        await applyBrandingPatch(row.after_jsonb ?? {});
        await api.post(`/change-requests/${encodeURIComponent(row.id)}/publish`);
      })
    );
  }

  return el("tr", {}, [
    el("td", {}, [row.change_summary ?? ""]),
    el("td", {}, [badge]),
    el("td", {}, [formatDateTime(row.created_at)]),
    el("td", { class: "row-actions" }, [actions])
  ]);
}
