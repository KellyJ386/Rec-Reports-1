import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldOfferPushEnrollment,
  buildDeviceTokenPayload,
  permissionGrants
} from "../src/public/js/push-registration.mjs";

test("shouldOfferPushEnrollment requires a firebase config and both browser capabilities", () => {
  assert.equal(
    shouldOfferPushEnrollment({ firebaseWebConfig: { apiKey: "x" }, notificationSupported: true, serviceWorkerSupported: true }),
    true
  );
  assert.equal(
    shouldOfferPushEnrollment({ firebaseWebConfig: null, notificationSupported: true, serviceWorkerSupported: true }),
    false
  );
  assert.equal(
    shouldOfferPushEnrollment({ firebaseWebConfig: { apiKey: "x" }, notificationSupported: false, serviceWorkerSupported: true }),
    false
  );
  assert.equal(
    shouldOfferPushEnrollment({ firebaseWebConfig: { apiKey: "x" }, notificationSupported: true, serviceWorkerSupported: false }),
    false
  );
});

test("buildDeviceTokenPayload shapes the /me/device-tokens body, defaulting platform to 'web'", () => {
  assert.deepEqual(
    buildDeviceTokenPayload({ facilityId: "fac-1", token: "tok-1" }),
    { facilityId: "fac-1", platform: "web", token: "tok-1" }
  );
  assert.deepEqual(
    buildDeviceTokenPayload({ facilityId: "fac-1", token: "tok-1", platform: "android" }),
    { facilityId: "fac-1", platform: "android", token: "tok-1" }
  );
});

test("permissionGrants is true only for 'granted'", () => {
  assert.equal(permissionGrants("granted"), true);
  assert.equal(permissionGrants("denied"), false);
  assert.equal(permissionGrants("default"), false);
  assert.equal(permissionGrants(undefined), false);
});
