import { api, ApiError } from "../api.js";
import { el, errorBanner, signInPrompt, emptyState } from "../ui.js";
import { getContext } from "../state.js";
import { loadMe } from "../session.js";

function statTile(label, value, hash) {
  const body = [el("span", { class: "stat-value" }, [String(value)]), el("span", { class: "stat-label" }, [label])];
  if (hash) {
    return el("a", { class: "stat-tile stat-tile-link", href: hash }, body);
  }
  return el("div", { class: "stat-tile" }, body);
}

export async function renderDashboard(container) {
  const heading = el("h1", {}, ["Dashboard"]);
  container.append(heading);

  const me = await loadMe();
  if (me.error === "missing-token" || me.error === "unauthorized") {
    container.append(
      signInPrompt(
        me.error === "missing-token"
          ? "No session token is set. Open “Session token” in the top bar and paste an access token to continue."
          : "Your session token was rejected (401). Open “Session token” in the top bar and paste a valid access token."
      )
    );
    return;
  }
  if (me.error) {
    container.append(errorBanner("Could not reach the admin API to load your session. Some data below may be unavailable."));
  }

  const activeMemberships = (me.memberships ?? []).filter((membership) => membership.status === "active");
  const context = getContext();

  const statsRow = el("div", { class: "stat-row" }, [
    statTile("Active facility memberships", activeMemberships.length, "#/facilities")
  ]);
  container.append(statsRow);

  let modules = [];
  let modulesError = null;
  try {
    modules = (await api.get("/modules")) ?? [];
  } catch (error) {
    modulesError = error;
  }

  if (modulesError) {
    statsRow.append(statTile("Modules", "—", "#/modules"));
  } else {
    statsRow.append(statTile("Available modules", modules.length, "#/modules"));
  }

  if (!context.orgId) {
    container.append(
      emptyState(
        "Set an Organization ID in the top bar to see facility counts and manage module and facility settings."
      )
    );
  } else {
    try {
      const facilities = (await api.get(`/org/${encodeURIComponent(context.orgId)}/facilities`)) ?? [];
      statsRow.append(statTile("Facilities in this organization", facilities.length, "#/facilities"));
    } catch (error) {
      container.append(errorBanner(`Could not load facilities for this organization: ${error.message}`));
    }
  }

  const links = el("section", { class: "panel", "aria-labelledby": "dashboard-links-heading" }, [
    el("h2", { id: "dashboard-links-heading" }, ["Quick links"]),
    el("ul", { class: "quick-links" }, [
      el("li", {}, [el("a", { href: "#/modules" }, ["Modules & Features — module toggle matrix"])]),
      el("li", {}, [el("a", { href: "#/facilities" }, ["Facilities & Departments — org tree management"])])
    ])
  ]);
  container.append(links);

  if (modulesError instanceof ApiError && modulesError.status === 0) {
    container.append(errorBanner("Network error reaching the admin API. The backend may not be running in this environment."));
  }
}
