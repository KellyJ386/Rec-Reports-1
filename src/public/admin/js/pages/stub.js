import { el } from "../ui.js";

// Consistent placeholder for nav groups whose backend/UI hasn't landed yet.
export function renderStub(container, { title, phase }) {
  const panel = el("section", { class: "stub-panel", "aria-labelledby": "stub-heading" }, [
    el("h2", { id: "stub-heading" }, [title]),
    el("p", { class: "stub-message" }, [`Coming in Phase ${phase}.`]),
    el("p", { class: "stub-detail" }, [
      "This section is planned in the Admin Control Center implementation plan but has not been built yet."
    ])
  ]);
  container.append(panel);
}
