import test from "node:test";
import assert from "node:assert/strict";
import { router, userRouter } from "../scripts/server.mjs";

// The admin control center's fetch wrapper is pinned to /api/admin/v1, so /me
// has to exist on the admin router as well as the end-user one. When it only
// existed on the end-user router, every admin session lookup 404'd and the app
// treated a perfectly valid sign-in as "signed out".
test("GET /me is registered on both API prefixes", () => {
  for (const [name, target] of [
    ["admin router", router],
    ["end-user router", userRouter]
  ]) {
    const { handler } = target.match({ method: "GET", url: "/me" });
    assert.ok(handler, `expected GET /me to be registered on the ${name}`);
  }
});

test("the auth endpoints the sign-in page calls are registered", () => {
  for (const path of ["/auth/sign-in", "/auth/refresh", "/auth/sign-out"]) {
    const { handler } = userRouter.match({ method: "POST", url: path });
    assert.ok(handler, `expected POST ${path} to be registered on the end-user router`);
  }
});

// Credentials must never be reachable behind the admin prefix, which the
// browser only ever calls with a bearer token it does not yet have at sign-in.
test("auth endpoints are not exposed on the admin prefix", () => {
  for (const path of ["/auth/sign-in", "/auth/refresh", "/auth/sign-out"]) {
    const { handler } = router.match({ method: "POST", url: path });
    assert.equal(handler, null, `did not expect POST ${path} on the admin router`);
  }
});
