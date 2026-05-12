import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";

const logger = new Logger("WebhookUrl");
let warnedOnce = false;

/**
 * Build a fully-qualified Telnyx webhook URL.
 *
 * Centralises three things every call site used to (re)implement:
 *   1. Trim trailing slashes from APP_URL so we don't emit `https://x//webhooks/...`,
 *      which Telnyx accepts but proxies / WAFs in the middle often 404.
 *   2. Reject obviously broken `APP_URL` values (unset, placeholder, localhost).
 *      Telnyx CANNOT reach `localhost`, `127.0.0.1`, or `your-app.com`. If the
 *      value is bad we throw a loud error from inside the call-initiation
 *      handler — the user sees a real 400 instead of a silent CANCELLED 60s
 *      later when Telnyx gives up waiting for `call.answered`.
 *   3. Allow `permissive` mode for non-fatal call sites (e.g. fork-leg dials
 *      where the inbound flow has already started) so we degrade to a warning
 *      rather than blowing up mid-call.
 */
export function buildWebhookUrl(
  config: ConfigService | undefined,
  path: string,
  opts: { permissive?: boolean } = {},
): string {
  const raw =
    (config && config.get<string>("APP_URL")) || process.env.APP_URL || "";
  const base = raw.trim().replace(/\/+$/, "");

  const cleanPath = path.startsWith("/") ? path : `/${path}`;

  const reason = invalidReason(base);
  if (reason) {
    const msg =
      `APP_URL is ${reason} ("${base || "<unset>"}"). ` +
      `Telnyx cannot deliver webhooks to this address, so outbound calls will ` +
      `appear to "cancel" after ~60s. Set APP_URL to a public HTTPS URL ` +
      `(e.g. an ngrok tunnel: \`ngrok http 3000\`) and restart.`;

    if (opts.permissive) {
      if (!warnedOnce) {
        logger.error(msg);
        warnedOnce = true;
      }
      // Still return *something* so call-control commands don't NPE; Telnyx
      // will simply not be able to reach it.
      return `${base || "http://APP_URL_NOT_SET.invalid"}${cleanPath}`;
    }
    throw new Error(msg);
  }

  return `${base}${cleanPath}`;
}

/**
 * Return the reason `APP_URL` is unusable for Telnyx callbacks, or null if it
 * looks OK. Pure function — exported so the boot banner can call it too.
 */
export function invalidReason(base: string): string | null {
  if (!base) return "not set";
  if (!/^https?:\/\//i.test(base)) return "missing http(s):// scheme";
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(base)) {
    return "pointing at localhost (Telnyx cannot reach localhost)";
  }
  if (/your-app\.com|example\.com|change-?me|placeholder/i.test(base)) {
    return "a placeholder value";
  }
  return null;
}
