// Small DOM helpers shared across admin pages. No frameworks, no inline
// handlers: everything is wired with addEventListener so the CSP
// (default-src 'self', no inline script) is satisfied.

let toastTimer = null;

export function toast(message, { tone = "info" } = {}) {
  const node = document.getElementById("toast");
  if (!node) return;
  node.textContent = message;
  node.dataset.tone = tone;
  node.classList.add("visible");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => node.classList.remove("visible"), 6000);
}

export function clearChildren(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function errorBanner(message) {
  return el("div", { class: "banner banner-error", role: "alert" }, [message]);
}

export function emptyState(message) {
  return el("p", { class: "empty-state" }, [message]);
}

export function signInPrompt(message = "Sign in required. Paste a session token to continue.") {
  return el("div", { class: "banner banner-warning", role: "alert" }, [message]);
}

export function tableScroll(table) {
  return el("div", { class: "table-scroll" }, [table]);
}

export function formatDateTime(value) {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}
