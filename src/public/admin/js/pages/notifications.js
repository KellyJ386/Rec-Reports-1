import { api } from "../api.js";
import { el, clearChildren, errorBanner, emptyState, tableScroll, toast } from "../ui.js";
import { getContext } from "../state.js";

const SEVERITY_TONE = { info: "badge-off", warning: "badge-custom", critical: "badge-denied" };

export async function renderNotifications(container) {
  container.append(el("h1", {}, ["Notifications"]));

  const context = getContext();
  if (!context.facilityId) {
    container.append(emptyState("Select a facility in the top bar to manage notification routing."));
    return;
  }
  const facilityId = context.facilityId;
  const statusRegion = el("div", { class: "status-region", role: "status", "aria-live": "polite" }, []);
  container.append(statusRegion);

  const catalogSection = el("section", { class: "panel", "aria-labelledby": "ne-heading" }, [
    el("h2", { id: "ne-heading" }, ["Event catalog"]),
    el("div", { "data-region": "ne-body" }, [])
  ]);
  const listsSection = el("section", { class: "panel", "aria-labelledby": "dl-heading" }, [
    el("h2", { id: "dl-heading" }, ["Distribution lists"]),
    el("div", { "data-region": "dl-body" }, [])
  ]);
  const routesSection = el("section", { class: "panel", "aria-labelledby": "nr-heading" }, [
    el("h2", { id: "nr-heading" }, ["Routing"]),
    el("div", { "data-region": "nr-body" }, [])
  ]);
  container.append(catalogSection, listsSection, routesSection);

  let events = [];

  async function loadCatalog() {
    const body = catalogSection.querySelector("[data-region=ne-body]");
    clearChildren(body);
    try {
      events = (await api.get("/notification-events")) ?? [];
    } catch (error) {
      body.append(errorBanner(`Could not load events: ${error.message}`));
      return;
    }
    if (events.length === 0) {
      body.append(emptyState("No notification events in the catalog."));
      return;
    }
    const table = el("table", { class: "data-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { scope: "col" }, ["Code"]),
          el("th", { scope: "col" }, ["Severity"]),
          el("th", { scope: "col" }, ["Module"]),
          el("th", { scope: "col" }, ["Default channels"])
        ])
      ])
    ]);
    const tbody = el("tbody", {}, []);
    for (const event of events) {
      const channels = Array.isArray(event.default_channels_jsonb) ? event.default_channels_jsonb.join(", ") : "";
      tbody.append(
        el("tr", {}, [
          el("td", {}, [el("code", {}, [event.code])]),
          el("td", {}, [el("span", { class: `badge ${SEVERITY_TONE[event.severity] ?? "badge-off"}` }, [event.severity])]),
          el("td", {}, [event.module_code]),
          el("td", {}, [channels])
        ])
      );
    }
    table.append(tbody);
    body.append(tableScroll(table));
  }

  // --- Distribution lists ---------------------------------------------------
  async function loadLists() {
    const body = listsSection.querySelector("[data-region=dl-body]");
    clearChildren(body);
    let lists = [];
    try {
      lists = (await api.get(`/facilities/${encodeURIComponent(facilityId)}/distribution-lists`)) ?? [];
    } catch (error) {
      body.append(errorBanner(`Could not load lists: ${error.message}`));
      return;
    }
    body.append(buildCreateListForm({ facilityId, statusRegion, onCreated: loadLists }));
    if (lists.length === 0) {
      body.append(emptyState("No distribution lists yet. Create one above."));
      return;
    }
    for (const list of lists) {
      body.append(await buildListPanel(list, { facilityId, statusRegion, onChanged: loadLists }));
    }
  }

  async function buildListPanel(list, { facilityId, statusRegion, onChanged }) {
    const panel = el("div", { class: "subpanel" }, [
      el("h3", {}, [list.name, list.active ? "" : " (inactive)"])
    ]);
    if (list.description) panel.append(el("p", { class: "detail-subhead" }, [list.description]));

    const membersRegion = el("div", { "data-region": "members" }, []);
    panel.append(membersRegion);

    async function renderMembers() {
      clearChildren(membersRegion);
      let members = [];
      try {
        members =
          (await api.get(
            `/facilities/${encodeURIComponent(facilityId)}/distribution-lists/${encodeURIComponent(list.id)}/members`
          )) ?? [];
      } catch (error) {
        membersRegion.append(errorBanner(`Could not load members: ${error.message}`));
        return;
      }
      if (members.length === 0) {
        membersRegion.append(emptyState("No members yet."));
      } else {
        const ul = el("ul", { class: "member-list" }, []);
        for (const member of members) {
          const remove = el("button", { type: "button", class: "ghost-button", "aria-label": "Remove member" }, ["Remove"]);
          remove.addEventListener("click", async () => {
            remove.disabled = true;
            try {
              await deleteMember(facilityId, list.id, member.id);
              await renderMembers();
            } catch (error) {
              toast(`Could not remove member: ${error.message}`, { tone: "error" });
              remove.disabled = false;
            }
          });
          ul.append(
            el("li", { class: "member-row" }, [
              el("span", { class: "badge badge-custom" }, [member.member_type]),
              " ",
              el("code", {}, [member.member_ref_id]),
              el("span", { class: "row-actions" }, [remove])
            ])
          );
        }
        membersRegion.append(ul);
      }
      membersRegion.append(
        buildAddMemberForm({ facilityId, listId: list.id, onAdded: renderMembers })
      );
    }

    await renderMembers();
    return panel;
  }

  // --- Routing --------------------------------------------------------------
  async function loadRoutes() {
    const body = routesSection.querySelector("[data-region=nr-body]");
    clearChildren(body);
    let routes = [];
    try {
      routes = (await api.get(`/facilities/${encodeURIComponent(facilityId)}/notification-routes`)) ?? [];
    } catch (error) {
      body.append(errorBanner(`Could not load routes: ${error.message}`));
      return;
    }
    body.append(buildCreateRouteForm({ facilityId, events, statusRegion, onCreated: loadRoutes }));
    if (routes.length === 0) {
      body.append(emptyState("No routes configured yet. Add one above."));
      return;
    }
    const table = el("table", { class: "data-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { scope: "col" }, ["Event"]),
          el("th", { scope: "col" }, ["Priority"]),
          el("th", { scope: "col" }, ["Channels"]),
          el("th", { scope: "col" }, ["Active"]),
          el("th", { scope: "col" }, ["Actions"])
        ])
      ])
    ]);
    const tbody = el("tbody", {}, []);
    for (const route of routes) {
      const channels = Array.isArray(route.route_jsonb?.channels) ? route.route_jsonb.channels.join(", ") : "";
      const toggle = el("button", { type: "button", class: "ghost-button" }, [route.active ? "Disable" : "Enable"]);
      toggle.addEventListener("click", async () => {
        toggle.disabled = true;
        try {
          await api.patch(
            `/facilities/${encodeURIComponent(facilityId)}/notification-routes/${encodeURIComponent(route.id)}`,
            { active: !route.active }
          );
          await loadRoutes();
        } catch (error) {
          toast(`Could not update route: ${error.message}`, { tone: "error" });
          toggle.disabled = false;
        }
      });
      const test = el("button", { type: "button", class: "ghost-button" }, ["Send test"]);
      test.addEventListener("click", async () => {
        test.disabled = true;
        try {
          await api.post(
            `/facilities/${encodeURIComponent(facilityId)}/notification-routes/${encodeURIComponent(route.id)}/test`
          );
          statusRegion.textContent = `Queued a test notification for ${route.event_code}.`;
          toast("Test notification queued in the sandbox.", { tone: "success" });
        } catch (error) {
          toast(`Could not send test: ${error.message}`, { tone: "error" });
        } finally {
          test.disabled = false;
        }
      });
      tbody.append(
        el("tr", {}, [
          el("td", {}, [el("code", {}, [route.event_code])]),
          el("td", {}, [String(route.priority)]),
          el("td", {}, [channels]),
          el("td", {}, [el("span", { class: `badge ${route.active ? "badge-on" : "badge-off"}` }, [route.active ? "Active" : "Off"])]),
          el("td", { class: "row-actions" }, [el("span", { class: "row-actions" }, [toggle, test])])
        ])
      );
    }
    table.append(tbody);
    body.append(tableScroll(table));
  }

  await loadCatalog();
  await loadLists();
  await loadRoutes();
}

async function deleteMember(facilityId, listId, memberId) {
  // api.js has no delete helper; issue the DELETE through fetch with the same
  // token handling the wrapper uses by delegating to a small inline request.
  const token = localStorage.getItem("rr_admin_token") || "";
  const response = await fetch(
    `/api/admin/v1/facilities/${encodeURIComponent(facilityId)}/distribution-lists/${encodeURIComponent(listId)}/members/${encodeURIComponent(memberId)}`,
    { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} }
  );
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
}

function buildCreateListForm({ facilityId, statusRegion, onCreated }) {
  const nameInput = el("input", { type: "text", id: "dl-name", placeholder: "On-call managers", autocomplete: "off" });
  const descInput = el("input", { type: "text", id: "dl-desc", placeholder: "Description (optional)", autocomplete: "off" });
  const submit = el("button", { type: "submit", class: "primary-button" }, ["Create list"]);
  return el(
    "form",
    {
      class: "settings-form inline-form",
      "aria-label": "Create distribution list",
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          await api.post(`/facilities/${encodeURIComponent(facilityId)}/distribution-lists`, {
            name: nameInput.value.trim(),
            description: descInput.value.trim() || undefined
          });
          statusRegion.textContent = `Created list ${nameInput.value.trim()}.`;
          toast("Distribution list created.", { tone: "success" });
          nameInput.value = "";
          descInput.value = "";
          await onCreated();
        } catch (error) {
          toast(`Could not create list: ${error.message}`, { tone: "error" });
        } finally {
          submit.disabled = false;
        }
      }
    },
    [
      el("label", {}, [el("span", {}, ["Name"]), nameInput]),
      el("label", {}, [el("span", {}, ["Description"]), descInput]),
      submit
    ]
  );
}

function buildAddMemberForm({ facilityId, listId, onAdded }) {
  const typeSelect = el("select", { "aria-label": "Member type" }, [
    el("option", { value: "employee" }, ["employee"]),
    el("option", { value: "role" }, ["role"])
  ]);
  const refInput = el("input", { type: "text", placeholder: "employee or role id", autocomplete: "off", "aria-label": "Member reference id" });
  const submit = el("button", { type: "submit", class: "ghost-button" }, ["Add member"]);
  return el(
    "form",
    {
      class: "settings-form inline-form",
      "aria-label": "Add member",
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          await api.post(
            `/facilities/${encodeURIComponent(facilityId)}/distribution-lists/${encodeURIComponent(listId)}/members`,
            { memberType: typeSelect.value, memberRefId: refInput.value.trim() }
          );
          refInput.value = "";
          await onAdded();
        } catch (error) {
          toast(`Could not add member: ${error.message}`, { tone: "error" });
        } finally {
          submit.disabled = false;
        }
      }
    },
    [typeSelect, refInput, submit]
  );
}

function buildCreateRouteForm({ facilityId, events, statusRegion, onCreated }) {
  const eventSelect = el("select", { "aria-label": "Event" }, []);
  if (events.length === 0) {
    eventSelect.append(el("option", { value: "" }, ["(no events)"]));
  } else {
    for (const event of events) eventSelect.append(el("option", { value: event.code }, [event.code]));
  }
  const priorityInput = el("input", { type: "number", value: "0", "aria-label": "Priority" });
  const channelsInput = el("input", { type: "text", placeholder: "in_app,email", autocomplete: "off", "aria-label": "Channels" });
  const submit = el("button", { type: "submit", class: "primary-button" }, ["Add route"]);
  return el(
    "form",
    {
      class: "settings-form inline-form",
      "aria-label": "Create route",
      onsubmit: async (event) => {
        event.preventDefault();
        submit.disabled = true;
        const channels = channelsInput.value
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value.length > 0);
        try {
          await api.post(`/facilities/${encodeURIComponent(facilityId)}/notification-routes`, {
            eventCode: eventSelect.value,
            priority: Number(priorityInput.value) || 0,
            route: { channels }
          });
          statusRegion.textContent = `Added a route for ${eventSelect.value}.`;
          toast("Route created.", { tone: "success" });
          channelsInput.value = "";
          await onCreated();
        } catch (error) {
          toast(`Could not create route: ${error.message}`, { tone: "error" });
        } finally {
          submit.disabled = false;
        }
      }
    },
    [
      el("label", {}, [el("span", {}, ["Event"]), eventSelect]),
      el("label", {}, [el("span", {}, ["Priority"]), priorityInput]),
      el("label", {}, [el("span", {}, ["Channels (comma-separated)"]), channelsInput]),
      submit
    ]
  );
}
