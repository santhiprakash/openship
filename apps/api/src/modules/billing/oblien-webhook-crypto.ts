/**
 * Pure crypto helpers for the Oblien webhook receiver — signature
 * verification + idempotency-id derivation. No env/db/SDK imports so they're
 * unit-testable in isolation (the secret is passed in, not read from env).
 *
 * Signature: Oblien signs each delivery as
 *   X-Webhook-Signature = HMAC-SHA256(secret, rawBody) → hex
 * (body only — no timestamp, no `sha256=` prefix, though we tolerate the
 * prefix defensively). Compared in constant time.
 *
 * Idempotency: Oblien's envelope carries NO event id, so we derive a stable
 * one from `event : (workspace_id|namespace) : (period_end|timestamp)`. The
 * per-delivery timestamp keeps genuine periodic `credits.usage` refreshes
 * distinct while an exact re-delivery collapses onto the same id.
 */

import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export interface SignatureCheck {
  ok: boolean;
  reason?: "no_secret" | "missing_header" | "bad_signature";
}

/** Minimal envelope shape needed to derive the idempotency id. */
export interface OblienEventEnvelope {
  event?: string;
  timestamp?: string | number;
  namespace?: string;
  data?: {
    namespace?: string;
    workspace_id?: string;
    period_end?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function extractNamespace(payload: OblienEventEnvelope): string | null {
  if (typeof payload.data?.namespace === "string") return payload.data.namespace;
  if (typeof payload.namespace === "string") return payload.namespace;
  return null;
}

/**
 * Verify the Oblien webhook signature. Returns a tagged result so callers can
 * log a typed reason without branching the response (every failure → 401,
 * except a missing secret which is an operator misconfiguration → 503).
 */
export function verifyOblienSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string | undefined,
): SignatureCheck {
  if (!secret) return { ok: false, reason: "no_secret" };
  if (!signatureHeader) return { ok: false, reason: "missing_header" };

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice("sha256=".length)
    : signatureHeader;

  if (provided.length !== expected.length) {
    return { ok: false, reason: "bad_signature" };
  }
  try {
    const equal = timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(provided, "hex"),
    );
    return equal ? { ok: true } : { ok: false, reason: "bad_signature" };
  } catch {
    // Buffer.from on a non-hex string throws lazily on some inputs —
    // treat as a mismatch rather than a 500.
    return { ok: false, reason: "bad_signature" };
  }
}

/** Derive a stable idempotency id from the (id-less) Oblien envelope. */
export function deriveOblienEventId(payload: OblienEventEnvelope): string {
  const parts = [
    payload.event ?? "",
    String(payload.data?.workspace_id ?? extractNamespace(payload) ?? ""),
    String(payload.data?.period_end ?? payload.timestamp ?? ""),
  ];
  return createHash("sha256").update(parts.join(":")).digest("hex");
}
