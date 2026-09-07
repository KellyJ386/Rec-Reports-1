// Pure, DOM-free helpers behind the "Enable notifications" button (P-5).
// Everything that actually touches the browser (Notification.requestPermission,
// the Firebase Messaging SDK, the POST to /me/device-tokens) lives in app.js,
// same split as facility-context.mjs/comms-compose.mjs -- this file is only
// the decision logic app.js's DOM wiring can call into and this project's
// tests can exercise directly, without a browser environment.
//
// TODO(P-5 follow-up): minting a real FCM registration token client-side
// needs the Firebase Messaging JS SDK's getToken(), which this app cannot
// load under its `default-src 'self'` CSP (see vercel.json /
// scripts/server.mjs's securityHeaders) without either a same-origin
// bundled copy (this is a zero-dependency, no-bundler app) or loosening the
// CSP to allow an external script host -- neither is in scope for this
// slice. app.js's enableWebPushNotifications() therefore requests
// Notification permission and is wired to POST a token via
// buildDeviceTokenPayload the moment a real token is available, but the
// token-minting step itself is stubbed out (getFcmToken() below) until a
// same-origin Firebase Messaging bundle is added.

// Whether the "Enable notifications" button should be shown at all: only
// when the server has an owner-configured Firebase web config (GET
// /api/v1/public-config's optional `firebaseWebConfig`, sourced from
// FIREBASE_WEB_CONFIG_JSON -- see src/lib/env.mjs) AND this browser exposes
// both the Notification API and a service worker registry (the two
// baseline capabilities any web-push flow needs, Firebase-backed or not).
export function shouldOfferPushEnrollment({ firebaseWebConfig, notificationSupported, serviceWorkerSupported }) {
  return Boolean(firebaseWebConfig) && notificationSupported === true && serviceWorkerSupported === true;
}

// Shapes the POST /me/device-tokens body (src/lib/http/communications-routes.mjs's
// contract: facilityId + platform + token, all required).
export function buildDeviceTokenPayload({ facilityId, token, platform = "web" }) {
  return { facilityId, platform, token };
}

// True only for the one Notification.requestPermission() outcome that means
// "go ahead and try to register a token" -- "denied" and "default"
// (dismissed) both mean stop here without ever calling into the token/POST
// path.
export function permissionGrants(permissionResult) {
  return permissionResult === "granted";
}
