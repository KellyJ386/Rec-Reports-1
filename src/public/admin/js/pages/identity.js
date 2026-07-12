import { api } from "../api.js";
import { el, clearChildren, errorBanner, emptyState, tableScroll, toast } from "../ui.js";
import { getContext } from "../state.js";

// The 16-code permission catalog, kept in lockstep with src/lib/permissions.mjs.
// Browser modules are copied verbatim by the build (no bundler), so the frozen
// list is mirrored here for the permission-grid editor. Order matches the lib.
const PERMISSION_CATALOG = [
  { code: "reports.read", label: "Reports: read" },
  { code: "reports.create", label: "Reports: create drafts" },
  { code: "reports.submit", label: "Reports: submit" },
  { code: "reports.export", label: "Reports: export" },
  { code: "schedule.read", label: "Schedule: read" },
  { code: "schedule.manage", label: "Schedule: manage" },
  { code: "training.read", label: "Training: read" },
  { code: "training.manage", label: "Training: manage" },
  { code: "incidents.read", label: "Incidents: read" },
  { code: "incidents.manage", label: "Incidents: manage" },
  { code: "work_orders.read", label: "Work orders: read" },
  { code: "work_orders.manage", label: "Work orders: manage" },
  { code: "admin.manage", label: "Admin: manage configuration" },
  { code: "reports.template.manage", label: "Reports: manage templates" },
  { code: "communications.read", label: "Communications: read" },
  { code: "communications.publish", label: "Communications: publish" }
];

const MEMBERSHIP_STATUSES = ["invited", "active", "disabled"];

const REASON_LABEL = {
  granted: "Granted by an active membership",
  "permission-missing": "Active membership lacks this permission",
  "membership-inactive": "Membership exists but is not active",
  "no-membership": "No membership in this facility"
};

export async function renderIdentity(container) {
  container.append(el("h1", {}, ["Identity & Permissions"]));

  const context = getContext();
  if (!context.facilityId) {
    container.append(
      emptyState("Select a facility in the top bar to manage roles, memberships, and simulate access.")
    );
    return;
  }
  const facilityId = context.facilityId;

  const statusRegion = el("div", { class: "status-region", role: "status", "aria-live": "polite" }, []);
  container.append(statusRegion);

  // Roles are shared by the roles panel (editing) and the memberships panel
  // (the role picker), so load them once here.
  let roles = [];
  try {
    roles = (await api.get(`/facilities/${encodeURIComponent(facilityId)}/roles`)) ?? [];
  } catch (error) {
    container.append(errorBanner(`Could not load roles: ${error.message}`));
    roles = [];
  }

  const rolesSection = el("section", { class: "panel", "aria-labelledby": "roles-heading" }, [
    el("h2", { id: "roles-heading" }, ["Roles"])
  ]);
  const rolesBody = el("div", {}, []);
  rolesSection.append(rolesBody);
  container.append(rolesSection);

  const membershipsSection = el("section", { class: "panel", "aria-labelledby": "memberships-heading" }, [
    el("h2", { id: "memberships-heading" }, ["Memberships"])
  ]);
  const membershipsBody = el("div", {}, []);
  membershipsSection.append(membershipsBody);
  container.append(membershipsSection);

  const simulatorSection = el("section", { class: "panel", "aria-labelledby": "simulator-heading" }, [
    el("h2", { id: "simulator-heading" }, ["Access simulator"])
  ]);
  const simulatorBody = el("div", {}, []);
  simulatorSection.append(simulatorBody);
  container.append(simulatorSection);

  function renderRoles() {
    clearChildren(rolesBody);
    renderRolesPanel({ facilityId, roles, container: rolesBody, statusRegion, onChanged: renderRoles });
  }
  renderRoles();

  renderMembershipsPanel({ facilityId, roles, container: membershipsBody, statusRegion });
  renderSimulatorPanel({ facilityId, container: simulatorBody });
}

function buildPermissionGrid({ idPrefix, selected }) {
  const selectedSet = new Set(selected ?? []);
  const checkboxes = new Map();
  const items = PERMISSION_CATALOG.map(({ code, label }) => {
    const inputId = `${idPrefix}-${code.replace(/[^a-z0-9]/gi, "-")}`;
    const input = el("input", { type: "checkbox", id: inputId, value: code });
    if (selectedSet.has(code)) input.checked = true;
    checkboxes.set(code, input);
    return el("label", { class: "permission-option", for: inputId }, [input, el("span", {}, [label])]);
  });
  const grid = el("div", { class: "permission-grid", role: "group", "aria-label": "Permission codes" }, items);
  return {
    node: grid,
    getSelected: () => PERMISSION_CATALOG.map((p) => p.code).filter((code) => checkboxes.get(code).checked)
  };
}

function renderRolesPanel({ facilityId, roles, container, statusRegion, onChanged }) {
  container.append(
    buildCreateRoleForm({
      facilityId,
      statusRegion,
      onCreated: (role) => {
        roles.push(role);
        onChanged();
      }
    })
  );

  if (roles.length === 0) {
    container.append(emptyState("No roles yet. Create one above."));
    return;
  }

  const table = el("table", { class: "data-table" }, [
    el("caption", { class: "sr-only" }, ["Roles with permission counts"]),
    el("thead", {}, [
      el("tr", {}, [
        el("th", { scope: "col" }, ["Role"]),
        el("th", { scope: "col" }, ["Type"]),
        el("th", { scope: "col" }, ["Active"]),
        el("th", { scope: "col" }, ["Permissions"]),
        el("th", { scope: "col" }, ["Actions"])
      ])
    ])
  ]);
  const tbody = el("tbody", {}, []);
  table.append(tbody);

  for (const role of roles) {
    const editorRow = el("tr", { class: "role-editor-row", hidden: true }, []);
    const editorCell = el("td", { colspan: "5" }, []);
    editorRow.append(editorCell);

    const grid = buildPermissionGrid({ idPrefix: `role-perms-${role.id}`, selected: role.permissionCodes });
    const saveButton = el("button", { type: "button", class: "primary-button" }, ["Save permissions"]);
    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      const codes = grid.getSelected();
      try {
        await api.put(`/roles/${encodeURIComponent(role.id)}/permissions`, { permissionCodes: codes });
        role.permissionCodes = codes;
        statusRegion.textContent = `Saved permissions for ${role.name}.`;
        toast(`Saved permissions for ${role.name}.`, { tone: "success" });
        onChanged();
      } catch (error) {
        statusRegion.textContent = `Could not save permissions: ${error.message}`;
        toast(`Could not save permissions: ${error.message}`, { tone: "error" });
      } finally {
        saveButton.disabled = false;
      }
    });
    editorCell.append(
      el("div", { class: "permission-editor" }, [grid.node, el("div", { class: "row-actions" }, [saveButton])])
    );

    const editButton = el("button", { type: "button", class: "ghost-button" }, ["Edit permissions"]);
    editButton.addEventListener("click", () => {
      const nowHidden = !editorRow.hidden;
      editorRow.hidden = nowHidden;
      editButton.textContent = nowHidden ? "Edit permissions" : "Hide permissions";
      editButton.setAttribute("aria-expanded", nowHidden ? "false" : "true");
    });

    tbody.append(
      el("tr", {}, [
        el("td", {}, [role.name]),
        el("td", {}, [
          role.isSystemRole
            ? el("span", { class: "badge badge-system" }, ["System"])
            : el("span", { class: "badge badge-custom" }, ["Custom"])
        ]),
        el("td", {}, [role.active === false ? "No" : "Yes"]),
        el("td", {}, [String((role.permissionCodes ?? []).length)]),
        el("td", { class: "row-actions" }, [editButton])
      ])
    );
    tbody.append(editorRow);
  }
  container.append(tableScroll(table));
}

function buildCreateRoleForm({ facilityId, statusRegion, onCreated }) {
  const nameInput = el("input", { type: "text", id: "new-role-name", required: true, autocomplete: "off" });
  const grid = buildPermissionGrid({ idPrefix: "new-role-perms", selected: [] });

  const form = el(
    "form",
    {
      class: "inline-form stacked-form",
      "aria-label": "Create role",
      onsubmit: async (event) => {
        event.preventDefault();
        const submitButton = form.querySelector("button[type=submit]");
        submitButton.disabled = true;
        const name = nameInput.value.trim();
        const codes = grid.getSelected();
        try {
          const created = await api.post(`/facilities/${encodeURIComponent(facilityId)}/roles`, {
            name,
            permissionCodes: codes
          });
          statusRegion.textContent = `Created role ${name}.`;
          toast(`Created role ${name}.`, { tone: "success" });
          form.reset();
          onCreated(
            created ?? {
              id: crypto.randomUUID(),
              name,
              isSystemRole: false,
              active: true,
              permissionCodes: codes
            }
          );
        } catch (error) {
          statusRegion.textContent = `Could not create role: ${error.message}`;
          toast(`Could not create role: ${error.message}`, { tone: "error" });
        } finally {
          submitButton.disabled = false;
        }
      }
    },
    [
      el("label", {}, [el("span", {}, ["Role name"]), nameInput]),
      el("span", { class: "field-label" }, ["Permissions"]),
      grid.node,
      el("button", { type: "submit", class: "primary-button" }, ["Add role"])
    ]
  );
  return el("fieldset", { class: "create-fieldset" }, [el("legend", {}, ["Create a role"]), form]);
}

async function renderMembershipsPanel({ facilityId, roles, container, statusRegion }) {
  let memberships = [];
  try {
    memberships = (await api.get(`/facilities/${encodeURIComponent(facilityId)}/memberships`)) ?? [];
  } catch (error) {
    container.append(errorBanner(`Could not load memberships: ${error.message}`));
    return;
  }

  container.append(buildAddMembershipForm({ facilityId, roles, statusRegion, onAdded: (membership) => {
    memberships.push(membership);
    renderRows();
  } }));

  const listHost = el("div", {}, []);
  container.append(listHost);

  function renderRows() {
    clearChildren(listHost);
    if (memberships.length === 0) {
      listHost.append(emptyState("No memberships yet. Assign one above."));
      return;
    }
    const table = el("table", { class: "data-table" }, [
      el("caption", { class: "sr-only" }, ["Facility memberships with role and status controls"]),
      el("thead", {}, [
        el("tr", {}, [
          el("th", { scope: "col" }, ["User"]),
          el("th", { scope: "col" }, ["Role"]),
          el("th", { scope: "col" }, ["Status"]),
          el("th", { scope: "col" }, ["Actions"])
        ])
      ])
    ]);
    const tbody = el("tbody", {}, []);
    table.append(tbody);
    for (const membership of memberships) {
      tbody.append(buildMembershipRow({ membership, roles, statusRegion }));
    }
    listHost.append(tableScroll(table));
  }
  renderRows();
}

function buildMembershipRow({ membership, roles, statusRegion }) {
  const roleSelect = el("select", { "aria-label": "Role" }, []);
  for (const role of roles) {
    const option = el("option", { value: role.id }, [role.name]);
    if (role.id === membership.roleId) option.selected = true;
    roleSelect.append(option);
  }
  if (membership.roleId && !roles.some((r) => r.id === membership.roleId)) {
    const option = el("option", { value: membership.roleId }, [membership.roleName ?? membership.roleId]);
    option.selected = true;
    roleSelect.append(option);
  }

  const statusSelect = el("select", { "aria-label": "Status" }, []);
  for (const status of MEMBERSHIP_STATUSES) {
    const option = el("option", { value: status }, [status]);
    if (status === membership.status) option.selected = true;
    statusSelect.append(option);
  }

  const saveButton = el("button", { type: "button", class: "ghost-button" }, ["Save"]);
  saveButton.addEventListener("click", async () => {
    saveButton.disabled = true;
    try {
      await api.patch(`/memberships/${encodeURIComponent(membership.id)}`, {
        roleId: roleSelect.value,
        status: statusSelect.value
      });
      membership.roleId = roleSelect.value;
      membership.status = statusSelect.value;
      statusRegion.textContent = "Saved membership.";
      toast("Saved membership.", { tone: "success" });
    } catch (error) {
      statusRegion.textContent = `Could not save membership: ${error.message}`;
      toast(`Could not save membership: ${error.message}`, { tone: "error" });
    } finally {
      saveButton.disabled = false;
    }
  });

  const userLabel = membership.userName
    ? `${membership.userName}${membership.userEmail ? ` (${membership.userEmail})` : ""}`
    : membership.userEmail ?? membership.userId;

  return el("tr", {}, [
    el("td", {}, [userLabel]),
    el("td", {}, [roleSelect]),
    el("td", {}, [statusSelect]),
    el("td", { class: "row-actions" }, [saveButton])
  ]);
}

function buildAddMembershipForm({ facilityId, roles, statusRegion, onAdded }) {
  const userInput = el("input", { type: "text", id: "new-membership-user", required: true, autocomplete: "off", placeholder: "User ID" });
  const roleSelect = el("select", { id: "new-membership-role", required: true }, [
    el("option", { value: "" }, ["Select a role"]),
    ...roles.map((role) => el("option", { value: role.id }, [role.name]))
  ]);
  const statusSelect = el("select", { id: "new-membership-status" }, MEMBERSHIP_STATUSES.map((status) => {
    const option = el("option", { value: status }, [status]);
    if (status === "active") option.selected = true;
    return option;
  }));

  const form = el(
    "form",
    {
      class: "inline-form",
      "aria-label": "Add membership",
      onsubmit: async (event) => {
        event.preventDefault();
        const submitButton = form.querySelector("button[type=submit]");
        submitButton.disabled = true;
        try {
          const created = await api.post(`/facilities/${encodeURIComponent(facilityId)}/memberships`, {
            userId: userInput.value.trim(),
            roleId: roleSelect.value,
            status: statusSelect.value
          });
          statusRegion.textContent = "Added membership.";
          toast("Added membership.", { tone: "success" });
          const roleName = roles.find((r) => r.id === roleSelect.value)?.name ?? null;
          form.reset();
          statusSelect.value = "active";
          onAdded(
            created
              ? { ...created, userId: created.user_id, roleId: created.role_id, roleName }
              : {
                  id: crypto.randomUUID(),
                  userId: userInput.value.trim(),
                  roleId: roleSelect.value,
                  status: statusSelect.value,
                  roleName
                }
          );
        } catch (error) {
          statusRegion.textContent = `Could not add membership: ${error.message}`;
          toast(`Could not add membership: ${error.message}`, { tone: "error" });
        } finally {
          submitButton.disabled = false;
        }
      }
    },
    [
      el("label", {}, [el("span", {}, ["User ID"]), userInput]),
      el("label", {}, [el("span", {}, ["Role"]), roleSelect]),
      el("label", {}, [el("span", {}, ["Status"]), statusSelect]),
      el("button", { type: "submit", class: "primary-button" }, ["Add membership"])
    ]
  );
  return el("fieldset", { class: "create-fieldset" }, [el("legend", {}, ["Assign a membership"]), form]);
}

function renderSimulatorPanel({ facilityId, container }) {
  const userInput = el("input", { type: "text", id: "simulator-user", autocomplete: "off", placeholder: "User ID" });
  const resultHost = el("div", {}, []);

  const form = el(
    "form",
    {
      class: "inline-form",
      "aria-label": "Simulate access",
      onsubmit: async (event) => {
        event.preventDefault();
        const submitButton = form.querySelector("button[type=submit]");
        const userId = userInput.value.trim();
        clearChildren(resultHost);
        if (!userId) {
          resultHost.append(emptyState("Enter a user ID to simulate their access."));
          return;
        }
        submitButton.disabled = true;
        try {
          const matrix =
            (await api.get(
              `/facilities/${encodeURIComponent(facilityId)}/access-simulator?userId=${encodeURIComponent(userId)}`
            )) ?? [];
          renderMatrix(resultHost, matrix);
        } catch (error) {
          resultHost.append(errorBanner(`Could not simulate access: ${error.message}`));
        } finally {
          submitButton.disabled = false;
        }
      }
    },
    [
      el("label", {}, [el("span", {}, ["User ID"]), userInput]),
      el("button", { type: "submit", class: "primary-button" }, ["Simulate access"])
    ]
  );

  container.append(
    el("p", { class: "detail-subhead" }, ["Resolve exactly what a user can do in this facility, code by code."])
  );
  container.append(form);
  container.append(resultHost);
  resultHost.append(emptyState("Enter a user ID to simulate their access."));
}

function renderMatrix(host, matrix) {
  clearChildren(host);
  if (matrix.length === 0) {
    host.append(emptyState("No permission results returned."));
    return;
  }
  const table = el("table", { class: "data-table" }, [
    el("caption", { class: "sr-only" }, ["Effective access matrix"]),
    el("thead", {}, [
      el("tr", {}, [
        el("th", { scope: "col" }, ["Permission"]),
        el("th", { scope: "col" }, ["Access"]),
        el("th", { scope: "col" }, ["Reason"])
      ])
    ])
  ]);
  const tbody = el("tbody", {}, []);
  table.append(tbody);
  for (const entry of matrix) {
    const badge = entry.allowed
      ? el("span", { class: "badge badge-allowed" }, ["Allowed"])
      : el("span", { class: "badge badge-denied" }, ["Denied"]);
    tbody.append(
      el("tr", {}, [
        el("td", {}, [entry.permission]),
        el("td", {}, [badge]),
        el("td", {}, [REASON_LABEL[entry.reason] ?? entry.reason])
      ])
    );
  }
  host.append(tableScroll(table));
}
