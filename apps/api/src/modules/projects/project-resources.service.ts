/**
 * Project resources service - CPU/memory/disk config + sleep mode.
 */

import { repos } from "@repo/db";
import { ValidationError } from "@repo/core";
import type { ResourceConfig } from "@repo/adapters";
import { encodeResources, decodeResources } from "../../lib/resources";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import type { TUpdateResourcesBody } from "./project.schema";

// ─── Get resources ───────────────────────────────────────────────────────────

export async function getResources(projectId: string, organizationId: string) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  const production = p.resources as ResourceConfig | null;
  const build = p.buildResources as ResourceConfig | null;
  return encodeResources(production, build, p.sleepMode ?? "auto_sleep", p.port ?? 3000);
}

// ─── Update resources ────────────────────────────────────────────────────────

export async function updateResources(
  projectId: string,
  data: TUpdateResourcesBody,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  const update: Record<string, unknown> = {};

  if (data.production) {
    update.resources = decodeResources(data.production);
  }
  if (data.build) {
    update.buildResources = decodeResources(data.build);
  }
  if (data.sleepMode) {
    update.sleepMode = data.sleepMode;
  }
  if (data.port) {
    update.port = data.port;
  }

  await repos.project.update(projectId, update);
  return getResources(projectId, organizationId);
}

// ─── Sleep mode ──────────────────────────────────────────────────────────────

export async function setSleepMode(
  projectId: string,
  sleepMode: string,
  organizationId: string,
) {
  const p = await repos.project.findById(projectId);
  assertResourceInOrg(p, "Project", organizationId, projectId);

  if (!["auto_sleep", "always_on"].includes(sleepMode)) {
    throw new ValidationError("Invalid sleep mode. Must be 'auto_sleep' or 'always_on'");
  }

  await repos.project.update(projectId, { sleepMode });
  return { success: true, sleepMode };
}


