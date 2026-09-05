import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/lib/http/router.mjs";

test("router extracts named :param segments", () => {
  const router = createRouter();
  router.register("GET", "/org/:id/module-settings/:moduleId", () => {});
  const { handler, params } = router.match({ method: "GET", url: "/org/org-1/module-settings/mod-2" });
  assert.ok(handler);
  assert.deepEqual(params, { id: "org-1", moduleId: "mod-2" });
});

test("router falls through to a null handler for an unknown path", () => {
  const router = createRouter();
  router.register("GET", "/modules", () => {});
  const { handler, params } = router.match({ method: "GET", url: "/unknown" });
  assert.equal(handler, null);
  assert.deepEqual(params, {});
});

test("router falls through to a null handler on a method mismatch", () => {
  const router = createRouter();
  router.register("GET", "/modules", () => {});
  const { handler } = router.match({ method: "POST", url: "/modules" });
  assert.equal(handler, null);
});

test("router matches the correct handler among several registered routes", () => {
  const router = createRouter();
  const getHandler = () => "get";
  const putHandler = () => "put";
  router.register("GET", "/org/:id/module-settings", getHandler);
  router.register("PUT", "/org/:id/module-settings/:moduleId", putHandler);
  const getMatch = router.match({ method: "GET", url: "/org/org-1/module-settings" });
  const putMatch = router.match({ method: "PUT", url: "/org/org-1/module-settings/mod-1" });
  assert.equal(getMatch.handler, getHandler);
  assert.equal(putMatch.handler, putHandler);
});

test("router decodes URI-encoded param values", () => {
  const router = createRouter();
  router.register("GET", "/facilities/:id", () => {});
  const { params } = router.match({ method: "GET", url: "/facilities/north%20arena" });
  assert.equal(params.id, "north arena");
});

test("router ignores query strings when matching the path", () => {
  const router = createRouter();
  router.register("GET", "/modules", () => "handler");
  const { handler } = router.match({ method: "GET", url: "/modules?foo=bar" });
  assert.ok(handler);
});
