// Delivery methods throw on failure; the worker isolates failures per subscription.

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Post a message to a Discord channel webhook.
 * @param {string} webhookUrl  the per-subscription delivery_target
 * @param {string} message
 */
export async function sendDiscord(
  webhookUrl,
  message,
  { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  if (!webhookUrl)
    throw new Error("discord delivery_target (webhook URL) is missing");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`discord webhook responded ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dispatch a delivery for a subscription. Throws on unknown method or send failure.
 * @param {{ delivery_method: string, delivery_target: string }} subscription
 * @param {string} message
 */
export async function deliver(subscription, message, opts = {}) {
  switch (subscription.delivery_method) {
    case "discord":
      return sendDiscord(subscription.delivery_target, message, opts);
    default:
      throw new Error(
        `unsupported delivery_method: ${subscription.delivery_method}`,
      );
  }
}
