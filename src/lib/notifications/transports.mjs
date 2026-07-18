// Provider-agnostic delivery transports for the notification worker.
//
// A Transport is any object shaped like:
//   { async send(delivery) -> { ok: boolean, error?: string } }
// where `delivery` is one entry from planJob(...).deliveries, i.e.
// { channel, employeeId, target, jobId, facilityId, eventType }.
//
// No email/SMS/push provider SDK is chosen here on purpose (SendGrid, SMTP,
// Twilio, etc. are all future decisions) -- logTransport is the safe default
// (it never contacts the network, so the worker always runs even before a
// provider is picked) and webhookTransport is a generic escape hatch that
// forwards deliveries as JSON to any HTTP endpoint the operator wires up
// (their own relay, a provider's inbound webhook, a queue bridge, ...).

// Default transport: records the delivery via console.log and reports
// success. Safe to run in any environment (dev, CI, prod-before-a-provider-
// is-chosen) since it performs no network I/O and needs no credentials.
export const logTransport = Object.freeze({
  async send(delivery) {
    const target = delivery?.target ?? delivery?.employeeId ?? "unknown";
    console.log(`[notifications] ${delivery?.channel ?? "unknown"} -> ${target}`, JSON.stringify(delivery));
    return { ok: true };
  }
});

// Generic transport: POSTs the delivery as JSON to `url`. Works with any
// provider that exposes (or can be fronted by) a webhook -- a relay
// function, a queue ingress, a provider's own inbound webhook -- without
// this codebase hardcoding a specific provider's SDK or credentials.
export function webhookTransport(url) {
  if (!url) throw new Error("webhookTransport requires a url");
  return {
    async send(delivery) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(delivery)
        });
        if (!response.ok) {
          return { ok: false, error: `webhook responded with status ${response.status}` };
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "webhook request failed" };
      }
    }
  };
}

// Picks a transport by name (env-driven). Defaults to the safe log
// transport for any unrecognized/unset name.
export function selectTransport(name, { webhookUrl } = {}) {
  if (name === "webhook") return webhookTransport(webhookUrl);
  return logTransport;
}
