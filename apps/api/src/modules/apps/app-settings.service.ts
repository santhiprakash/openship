/**
 * Curated day-2 settings for an installed app.
 *
 * Reads/writes a small, schema-defined set of env keys per service instead of
 * the raw project env editor. Writes go through the SAFE merge path
 * (`mergeEnvVars`) so untouched keys — including generated install secrets like
 * INSTANCE_SECRET / N8N_ENCRYPTION_KEY on the same service — are never wiped.
 * Env changes take effect on the next deploy; the client applies with a restart
 * (or a full redeploy for `requiresRedeploy` fields).
 */

import {
  getAppTemplate,
  getAppManagement,
  getAppSettings,
  flattenSettingFields,
  validateSetting,
  ValidationError,
  type AppManagement,
  type AppSettingGroup,
} from "@repo/core";
import { repos } from "@repo/db";
import type { RequestContext } from "../../lib/request-context";
import { assertResourceInOrg } from "../../lib/controller-helpers";
import { encrypt, decrypt } from "../../lib/encryption";

const ENVIRONMENT = "production";

export interface AppSettingValue {
  service: string;
  key: string;
  /** Effective override value (decrypted); "" for secrets and unset keys. */
  value: string;
  secret: boolean;
  /** An override row exists for this key (distinguishes "set" from "default"). */
  set: boolean;
}

export interface AppSettingsView {
  appTemplateId: string | null;
  management: AppManagement | null;
  groups: AppSettingGroup[];
  values: AppSettingValue[];
}

export interface AppSettingChange {
  service: string;
  key: string;
  value: string;
}

async function loadAppProject(ctx: RequestContext, projectId: string) {
  const project = await repos.project.findById(projectId);
  assertResourceInOrg(project, "Project", ctx.organizationId, projectId);
  return project;
}

export async function getAppProjectSettings(
  ctx: RequestContext,
  projectId: string,
): Promise<AppSettingsView> {
  const project = await loadAppProject(ctx, projectId);
  const template = project.appTemplateId ? getAppTemplate(project.appTemplateId) : undefined;
  const groups = template ? [...getAppSettings(template)] : [];
  const management = template ? getAppManagement(template) : null;

  const fields = flattenSettingFields(groups);
  const services = await repos.service.listByProject(projectId);
  const idByName = new Map(services.map((s) => [s.name, s.id]));

  const values: AppSettingValue[] = [];
  for (const svcName of new Set(fields.map((f) => f.service))) {
    const serviceId = idByName.get(svcName);
    const rows = serviceId ? await repos.project.listEnvVars(projectId, ENVIRONMENT, serviceId) : [];
    const byKey = new Map(rows.map((r) => [r.key, r]));
    for (const f of fields.filter((x) => x.service === svcName)) {
      const row = byKey.get(f.key);
      values.push({
        service: f.service,
        key: f.key,
        value: row && !f.secret ? decrypt(row.value) : "",
        secret: !!f.secret,
        set: !!row,
      });
    }
  }

  return { appTemplateId: project.appTemplateId ?? null, management, groups, values };
}

export async function updateAppProjectSettings(
  ctx: RequestContext,
  projectId: string,
  changes: AppSettingChange[],
): Promise<{ count: number; requiresRedeploy: boolean }> {
  const project = await loadAppProject(ctx, projectId);
  const template = project.appTemplateId ? getAppTemplate(project.appTemplateId) : undefined;
  if (!template) throw new ValidationError("This app has no configurable settings.");

  const fields = flattenSettingFields(getAppSettings(template));
  const fieldOf = (service: string, key: string) =>
    fields.find((f) => f.service === service && f.key === key);

  // Normalize to strings up front. A JSON number/boolean is legitimate input for
  // a number/boolean field, but the schema + crypto layers operate on strings —
  // and encrypt() throws on a non-string, which would surface as a 500.
  const normalized = changes.map((c) => ({
    service: c.service,
    key: c.key,
    value: typeof c.value === "string" ? c.value : c.value == null ? "" : String(c.value),
  }));

  // Validate everything (+ reject unknown keys) before touching storage.
  for (const c of normalized) {
    const field = fieldOf(c.service, c.key);
    if (!field) throw new ValidationError(`Unknown setting: ${c.service}.${c.key}`);
    const err = validateSetting(field, c.value);
    if (err) throw new ValidationError(err);
  }

  const services = await repos.service.listByProject(projectId);
  const idByName = new Map(services.map((s) => [s.name, s.id]));

  // Build the FULL per-service write plan (encrypting as we go) before issuing a
  // single write, so a bad element can't leave a multi-service PATCH half-applied.
  type Plan = { upserts: { key: string; value: string; isSecret: boolean }[]; deletes: string[] };
  const plan = new Map<string, Plan>();
  let count = 0;
  let requiresRedeploy = false;

  for (const c of normalized) {
    const field = fieldOf(c.service, c.key)!;
    const serviceId = idByName.get(c.service);
    if (!serviceId) throw new ValidationError(`Service not found: ${c.service}`);
    const entry = plan.get(serviceId) ?? { upserts: [], deletes: [] };

    if (field.secret) {
      if (c.value === "") continue; // blank secret → leave the stored value unchanged
      entry.upserts.push({ key: field.key, value: encrypt(c.value), isSecret: true });
    } else if (c.value === "") {
      entry.deletes.push(field.key); // clear the override → template default applies
    } else {
      entry.upserts.push({ key: field.key, value: encrypt(c.value), isSecret: false });
    }
    if (field.requiresRedeploy) requiresRedeploy = true;
    count++;
    plan.set(serviceId, entry);
  }

  for (const [serviceId, { upserts, deletes }] of plan) {
    if (upserts.length > 0 || deletes.length > 0) {
      await repos.project.mergeEnvVars(projectId, ENVIRONMENT, upserts, deletes, serviceId);
    }
  }

  return { count, requiresRedeploy };
}
