// Builds the {emailAdapter, pushAdapter} pair the worker's config expects
// (config.emailAdapter -> worker.mjs buildEmailDeliveryStatuses,
// config.pushAdapter -> buildPushDeliveryStatuses), from env vars, in ONE
// place -- both src/lib/http/internal-routes.mjs (the CRON_SECRET-guarded
// drain route) and scripts/notifications-worker.mjs (the local dev drain
// loop) call this instead of each duplicating the EMAIL_PROVIDER/
// PUSH_PROVIDER switch.
//
// Unset or explicitly "noop" -> the zero-network noop adapter (the shipped
// default -- see email.mjs/push.mjs's own noopAdapter comments for why that
// is safe: every push/email delivery is simply marked 'sent' with no
// provider configured). A provider name that IS set but missing its
// required credential (EMAIL_PROVIDER=resend with no EMAIL_API_KEY,
// PUSH_PROVIDER=fcm with no FCM_SERVICE_ACCOUNT_JSON) throws immediately
// with a message naming exactly what's missing -- fail loud at startup,
// never silently fall back to noop, which would look like "delivery is
// working" right up until someone notices nobody ever got an email.
import { noopAdapter as noopEmailAdapter, createResendAdapter } from "./email.mjs";
import { noopAdapter as noopPushAdapter } from "./push.mjs";
import { createFcmAdapter } from "./fcm.mjs";

function buildEmailAdapter(env, { fetchImpl } = {}) {
  const provider = (env.EMAIL_PROVIDER ?? "noop").trim().toLowerCase();
  if (provider === "" || provider === "noop") return noopEmailAdapter;
  if (provider === "resend") {
    if (!env.EMAIL_API_KEY) throw new Error("EMAIL_PROVIDER=resend requires EMAIL_API_KEY to be set");
    if (!env.EMAIL_FROM) throw new Error("EMAIL_PROVIDER=resend requires EMAIL_FROM to be set");
    return createResendAdapter({ apiKey: env.EMAIL_API_KEY, from: env.EMAIL_FROM, fetchImpl });
  }
  throw new Error(`Unknown EMAIL_PROVIDER "${env.EMAIL_PROVIDER}" (expected "resend" or "noop")`);
}

function buildPushAdapter(env, { fetchImpl } = {}) {
  const provider = (env.PUSH_PROVIDER ?? "noop").trim().toLowerCase();
  if (provider === "" || provider === "noop") return noopPushAdapter;
  if (provider === "fcm") {
    if (!env.FCM_SERVICE_ACCOUNT_JSON) {
      throw new Error("PUSH_PROVIDER=fcm requires FCM_SERVICE_ACCOUNT_JSON to be set");
    }
    return createFcmAdapter({ serviceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON, fetchImpl });
  }
  throw new Error(`Unknown PUSH_PROVIDER "${env.PUSH_PROVIDER}" (expected "fcm" or "noop")`);
}

export function buildAdaptersFromEnv(env = {}, { fetchImpl } = {}) {
  return {
    emailAdapter: buildEmailAdapter(env, { fetchImpl }),
    pushAdapter: buildPushAdapter(env, { fetchImpl })
  };
}
