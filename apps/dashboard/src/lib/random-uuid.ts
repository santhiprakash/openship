/**
 * `crypto.randomUUID` is only exposed in a secure context — HTTPS, or a
 * `localhost` origin. Self-hosted instances reached over plain HTTP on a
 * LAN/VPN address (`http://10.0.0.5:3001`, a Tailscale IP, …) are not one,
 * so the method is simply undefined there and every call throws
 * "crypto.randomUUID is not a function", tripping the global error boundary.
 *
 * These IDs are React keys and local list identifiers, never secrets, so a
 * non-cryptographic fallback is fine. Prefer the real thing when it exists.
 */
export function randomUUID(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;

  // RFC 4122 shape, version/variant bits included, so anything parsing these
  // as UUIDs keeps working.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const rand = (Math.random() * 16) | 0;
    const value = char === "x" ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}
