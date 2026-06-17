/**
 * Backup destinations — per-user CRUD + preflight.
 *
 * Credentials are encrypted with the existing `enc1:` envelope from
 * lib/credential-encryption.ts. Serialized destinations NEVER contain
 * ciphertext or plaintext — only `hasCredentials` flags and metadata.
 *
 * Preflight calls the destination adapter's `preflight()` (writes +
 * reads + deletes a probe object). On success we stamp lastVerifiedAt;
 * on failure we record the error so the dashboard can surface it.
 */

import { repos, type BackupDestination } from "@repo/db";
import { resolveDestination, type DestinationKind } from "@repo/adapters";
import crypto from "node:crypto";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { encryptSecretField } from "../../lib/credential-encryption";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { env } from "../../config/env";
import { toAdapterRow } from "./hydrate-server";
import { safeErrorMessage } from "@repo/core";

/**
 * Resolve + sandbox a local destination endpoint. Refuses any path
 * that escapes `BACKUP_LOCAL_ROOT` or sits inside known system
 * directories. Symlinks are resolved before the comparison so an
 * attacker can't slip a symlink-into-/etc past the check.
 *
 * The realpath() will fail if the endpoint doesn't exist yet — we
 * fall back to resolving the parent + appending the leaf, which is
 * sufficient because the destination's writes go through fs.mkdir
 * later and a deceptive non-existent path can't outflank the check.
 */
const LOCAL_DEST_DENY = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/root",
  "/var/lib/postgresql",
  "/var/lib/docker",
  "/var/lib/openship",
  "/boot",
];

async function validateLocalEndpoint(endpoint: string): Promise<void> {
  if (env.CLOUD_MODE) {
    throw new Error("Local destinations are disabled in cloud mode");
  }
  if (!env.BACKUP_ALLOW_LOCAL_DESTINATION) {
    throw new Error(
      "Local destinations are disabled. Set BACKUP_ALLOW_LOCAL_DESTINATION=true and BACKUP_LOCAL_ROOT to enable.",
    );
  }
  if (!path.isAbsolute(endpoint)) {
    throw new Error("Local destination path must be absolute");
  }
  const root = path.resolve(env.BACKUP_LOCAL_ROOT);
  const requested = path.resolve(endpoint);

  // Reject any path that lands inside a denied system directory, even
  // before we resolve symlinks (catches the obvious case + makes the
  // error message useful).
  for (const denied of LOCAL_DEST_DENY) {
    if (requested === denied || requested.startsWith(denied + path.sep)) {
      throw new Error(
        `Local destination path is inside a protected directory (${denied})`,
      );
    }
  }

  // Resolve symlinks where possible. If the leaf doesn't exist yet,
  // resolve the closest existing ancestor and append the remainder.
  let resolved = requested;
  try {
    resolved = await realpath(requested);
  } catch {
    let parent = requested;
    while (parent !== path.dirname(parent)) {
      parent = path.dirname(parent);
      try {
        const real = await realpath(parent);
        resolved = path.join(real, requested.slice(parent.length));
        break;
      } catch {
        // keep walking up
      }
    }
  }

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(
      `Local destination must be inside BACKUP_LOCAL_ROOT (${root})`,
    );
  }
}

// ─── Public shapes ───────────────────────────────────────────────────────────

export interface CreateDestinationInput {
  name: string;
  kind: DestinationKind;
  endpoint?: string | null;
  region?: string | null;
  bucket?: string | null;
  pathPrefix?: string | null;
  sshHost?: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
  /** When kind="openship_server", the user's servers.id to reuse. */
  serverId?: string | null;
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  sftpPassword?: string | null;
  sftpPrivateKey?: string | null;
  sftpKeyPassphrase?: string | null;
  isDefault?: boolean;
}

export interface UpdateDestinationInput {
  name?: string;
  endpoint?: string | null;
  region?: string | null;
  bucket?: string | null;
  pathPrefix?: string | null;
  sshHost?: string | null;
  sshPort?: number | null;
  sshUser?: string | null;
  /** Pass undefined to leave unchanged; null to clear; string to replace. */
  accessKeyId?: string | null;
  secretAccessKey?: string | null;
  sftpPassword?: string | null;
  sftpPrivateKey?: string | null;
  sftpKeyPassphrase?: string | null;
  isDefault?: boolean;
}

/** Safe-to-display destination shape — strips every ciphertext, exposes
 *  only `hasX` flags so the UI can render "credentials configured"
 *  without ever seeing the secret. */
export interface SerializedDestination {
  id: string;
  name: string;
  kind: string;
  endpoint: string | null;
  region: string | null;
  bucket: string | null;
  pathPrefix: string | null;
  sshHost: string | null;
  sshPort: number | null;
  sshUser: string | null;
  serverId: string | null;
  hasAccessKeyId: boolean;
  hasSecretAccessKey: boolean;
  hasSftpPassword: boolean;
  hasSftpPrivateKey: boolean;
  hasSftpKeyPassphrase: boolean;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export function serializeDestination(row: BackupDestination): SerializedDestination {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    pathPrefix: row.pathPrefix,
    sshHost: row.sshHost,
    sshPort: row.sshPort,
    sshUser: row.sshUser,
    serverId: row.serverId,
    hasAccessKeyId: !!row.accessKeyIdEnc,
    hasSecretAccessKey: !!row.secretAccessKeyEnc,
    hasSftpPassword: !!row.sftpPasswordEnc,
    hasSftpPrivateKey: !!row.sftpPrivateKeyEnc,
    hasSftpKeyPassphrase: !!row.sftpKeyPassphraseEnc,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastVerifyError: row.lastVerifyError,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

export async function listDestinations(organizationId: string): Promise<SerializedDestination[]> {
  const rows = await repos.backupDestination.listByOrganization(organizationId);
  return rows.map(serializeDestination);
}

export async function getDestination(
  id: string,
  organizationId: string,
): Promise<SerializedDestination> {
  const row = await repos.backupDestination.findById(id);
  assertResourceInOrg(row, "Destination", organizationId, id);
  return serializeDestination(row);
}

export async function createDestination(
  userId: string,
  organizationId: string,
  input: CreateDestinationInput,
): Promise<SerializedDestination> {
  await validateInput(input);

  // Ownership check for openship_server: the serverId arrives from the
  // request body and MUST belong to the calling org. Without this
  // check, an attacker could create a destination using a victim's
  // server row and SSH-impersonate them.
  if (input.kind === "openship_server") {
    if (!input.serverId) {
      throw new Error("openship_server destinations require a serverId");
    }
    const server = await repos.server.get(input.serverId);
    if (!server) {
      throw new Error("Server not accessible");
    }
    // Cross-org check when the server has an org stamp; rows without one fall through.
    if (
      "organizationId" in server &&
      (server as { organizationId?: string | null }).organizationId &&
      (server as { organizationId?: string | null }).organizationId !== organizationId
    ) {
      throw new Error("Server not accessible");
    }
  }

  // Uniqueness check (DB has a partial unique index but we want a clean
  // error message before hitting the constraint).
  const existing = await repos.backupDestination.findByNameInOrganization(
    organizationId,
    input.name,
  );
  if (existing) {
    throw new Error(`A destination named "${input.name}" already exists`);
  }

  const id = `bkd_${crypto.randomUUID()}`;
  const row = await repos.backupDestination.create({
    id,
    organizationId,
    name: input.name,
    kind: input.kind,
    endpoint: input.endpoint ?? null,
    region: input.region ?? null,
    bucket: input.bucket ?? null,
    pathPrefix: input.pathPrefix ?? null,
    sshHost: input.sshHost ?? null,
    sshPort: input.sshPort ?? null,
    sshUser: input.sshUser ?? null,
    serverId: input.serverId ?? null,
    accessKeyIdEnc: encryptSecretField(input.accessKeyId ?? null),
    secretAccessKeyEnc: encryptSecretField(input.secretAccessKey ?? null),
    sftpPasswordEnc: encryptSecretField(input.sftpPassword ?? null),
    sftpPrivateKeyEnc: encryptSecretField(input.sftpPrivateKey ?? null),
    sftpKeyPassphraseEnc: encryptSecretField(input.sftpKeyPassphrase ?? null),
    isDefault: input.isDefault ?? false,
  });
  return serializeDestination(row);
}

export async function updateDestination(
  id: string,
  organizationId: string,
  patch: UpdateDestinationInput,
): Promise<SerializedDestination> {
  const existing = await repos.backupDestination.findById(id);
  assertResourceInOrg(existing, "Destination", organizationId, id);

  // Re-validate on PATCH: for the `local` kind, every endpoint change
  // must clear validateLocalEndpoint() so the path stays inside BACKUP_LOCAL_ROOT.
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new Error("Name is required");
    if (patch.name.length > 80) throw new Error("Name is too long (max 80 chars)");
  }
  if (existing.kind === "local" && patch.endpoint !== undefined) {
    if (!patch.endpoint) {
      throw new Error("Local destinations require an absolute filesystem path");
    }
    await validateLocalEndpoint(patch.endpoint);
  }

  // Encrypt only the credential fields that are explicitly set in the
  // patch. undefined = leave unchanged; null = clear; string = replace.
  const update: Parameters<typeof repos.backupDestination.update>[1] = {};
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.endpoint !== undefined) update.endpoint = patch.endpoint;
  if (patch.region !== undefined) update.region = patch.region;
  if (patch.bucket !== undefined) update.bucket = patch.bucket;
  if (patch.pathPrefix !== undefined) update.pathPrefix = patch.pathPrefix;
  if (patch.sshHost !== undefined) update.sshHost = patch.sshHost;
  if (patch.sshPort !== undefined) update.sshPort = patch.sshPort;
  if (patch.sshUser !== undefined) update.sshUser = patch.sshUser;
  if (patch.isDefault !== undefined) update.isDefault = patch.isDefault;

  if (patch.accessKeyId !== undefined) {
    update.accessKeyIdEnc = encryptSecretField(patch.accessKeyId);
  }
  if (patch.secretAccessKey !== undefined) {
    update.secretAccessKeyEnc = encryptSecretField(patch.secretAccessKey);
  }
  if (patch.sftpPassword !== undefined) {
    update.sftpPasswordEnc = encryptSecretField(patch.sftpPassword);
  }
  if (patch.sftpPrivateKey !== undefined) {
    update.sftpPrivateKeyEnc = encryptSecretField(patch.sftpPrivateKey);
  }
  if (patch.sftpKeyPassphrase !== undefined) {
    update.sftpKeyPassphraseEnc = encryptSecretField(patch.sftpKeyPassphrase);
  }

  const row = await repos.backupDestination.update(id, update);
  if (!row) throw new Error("Destination not found");
  return serializeDestination(row);
}

export async function deleteDestination(id: string, organizationId: string): Promise<void> {
  const row = await repos.backupDestination.findById(id);
  assertResourceInOrg(row, "Destination", organizationId, id);

  const result = await repos.backupDestination.softDelete(id);
  if (!result.ok) {
    throw new Error(result.reason);
  }
}

// ─── Preflight ───────────────────────────────────────────────────────────────

export async function preflightDestination(
  id: string,
  organizationId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const row = await repos.backupDestination.findById(id);
  assertResourceInOrg(row, "Destination", organizationId, id);

  try {
    const adapterRow = await toAdapterRow(row);
    const destination = resolveDestination(adapterRow);
    const result = await destination.preflight();
    if (result.ok) {
      await repos.backupDestination.setLastVerified(id, true);
      return { ok: true };
    }
    await repos.backupDestination.setLastVerified(id, false, result.reason);
    return { ok: false, reason: result.reason };
  } catch (err) {
    const reason = safeErrorMessage(err);
    await repos.backupDestination.setLastVerified(id, false, reason);
    return { ok: false, reason };
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

async function validateInput(input: CreateDestinationInput): Promise<void> {
  if (!input.name?.trim()) throw new Error("Name is required");
  if (input.name.length > 80) throw new Error("Name is too long (max 80 chars)");

  switch (input.kind) {
    case "s3_compatible":
      if (!input.bucket) throw new Error("S3 destinations require a bucket");
      if (!input.accessKeyId || !input.secretAccessKey) {
        throw new Error("S3 destinations require access credentials");
      }
      break;
    case "sftp":
      if (!input.sshHost) throw new Error("SFTP destinations require sshHost");
      if (!input.sshUser) throw new Error("SFTP destinations require sshUser");
      if (!input.sftpPassword && !input.sftpPrivateKey) {
        throw new Error("SFTP destinations require a password or private key");
      }
      break;
    case "openship_server":
      if (!input.serverId) {
        throw new Error("openship_server destinations require a serverId");
      }
      break;
    case "local":
      if (!input.endpoint) {
        throw new Error("Local destinations require an absolute filesystem path");
      }
      await validateLocalEndpoint(input.endpoint);
      break;
    case "http_upload":
      throw new Error("http_upload destinations are not yet supported");
    default:
      throw new Error(`Unknown destination kind: ${String(input.kind)}`);
  }
}
