export function createRouter() {
  const routes = [];

  function register(method, pattern, handler) {
    const paramNames = [];
    const segments = pattern
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        if (segment.startsWith(":")) {
          paramNames.push(segment.slice(1));
          return "([^/]+)";
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      });
    const regex = new RegExp(`^/${segments.join("/")}/?$`);
    routes.push({ method: method.toUpperCase(), regex, paramNames, handler });
  }

  function match(req) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = (req.method ?? "GET").toUpperCase();
    for (const route of routes) {
      if (route.method !== method) continue;
      const result = route.regex.exec(url.pathname);
      if (!result) continue;
      const params = {};
      route.paramNames.forEach((name, index) => {
        params[name] = decodeURIComponent(result[index + 1]);
      });
      return { handler: route.handler, params };
    }
    return { handler: null, params: {} };
  }

  return { register, match };
}
