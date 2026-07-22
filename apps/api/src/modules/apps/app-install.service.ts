/**
 * Apps catalog + one-click installer.
 *
 * "template" apps are instantiated here: reuse the standard project-create path
 * (which carries the Phase-1 `isApp`/`appTemplateId` marker), seed the template's
 * compose service rows, and write config/secret env. The caller then deploys the
 * resulting services project through the normal deploy flow. "flow" apps (mail)
 * aren't projects — the installer just returns the wizard route to hand off to.
 */

import { randomBytes } from "node:crypto";
import { APP_TEMPLATES, getAppTemplate, getAppManagement, isAppAvailable, resolveServiceHostnameLabel, type AppConfigField } from "@repo/core";
import { repos } from "@repo/db";
import type { RequestContext } from "../../lib/request-context";
import { createProject } from "../projects/project-crud.service";
import { createService, setServiceEnvVars } from "../services/service.service";

/**
 * Strong random value for generated secrets (Convex INSTANCE_SECRET, DB
 * passwords). 32 bytes → 64 hex chars: Convex self-hosted requires exactly a
 * 32-byte hex INSTANCE_SECRET (like `openssl rand -hex 32`) and the backend
 * exits 255 on boot with anything shorter — 24 bytes silently broke it. 32
 * bytes is also fine (stronger) for every other generated secret.
 */
function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Catalog for the Create-App UI. Only operator-supplied config fields are
 * returned as form inputs — `generate:"secret"` fields are filled server-side and
 * never surfaced.
 */
export function getAppCatalog() {
  return APP_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    kind: t.kind,
    logo: t.logo,
    category: t.category,
    tags: t.tags ?? [],
    flowHref: t.flowHref,
    // How the installed app is managed (schema settings / custom href / none).
    management: getAppManagement(t),
    // Not installable this version → dashboard dims it + blocks the click.
    comingSoon: !isAppAvailable(t.id),
    configFields: (t.configFields ?? [])
      .filter((f) => !f.generate)
      .map((f) => ({
        key: f.key,
        service: f.service,
        label: f.label,
        help: f.help,
        type: f.type ?? "text",
        default: f.default,
        required: f.required ?? false,
      })),
  }));
}

export interface InstallAppInput {
  templateId: string;
  name?: string;
  config?: Record<string, string>;
}

export type InstallAppResult =
  | { kind: "flow"; flowHref: string }
  | { kind: "template"; projectId: string; slug: string };

export async function installApp(
  ctx: RequestContext,
  input: InstallAppInput,
): Promise<InstallAppResult> {
  const template = getAppTemplate(input.templateId);
  if (!template) throw new Error("unknown-app-template");

  // Server-side gate: a "coming soon" app is dimmed in the UI, but also refuse
  // it here so a direct API call can't install a not-yet-enabled app.
  if (!isAppAvailable(template.id)) throw new Error("app-not-available");

  if (template.kind === "flow") {
    return { kind: "flow", flowHref: template.flowHref ?? "/" };
  }

  const name = input.name?.trim() || template.name;

  // Reuse the standard create path: it owns slug generation, the project_app
  // row, and route state — and threads the isApp/appTemplateId marker (Phase 1).
  const project = await createProject(
    {
      name,
      framework: template.framework ?? "docker-compose",
      projectType: "services",
      hasBuild: false,
      isApp: true,
      appTemplateId: template.id,
    },
    ctx.organizationId,
  );

  // Resolve config values. Secrets sharing a `generateGroup` get ONE generated
  // value (e.g. a DB password that must match across two services).
  const groupSecret = new Map<string, string>();
  const valueFor = (field: AppConfigField): string => {
    if (field.generate === "secret") {
      if (field.generateGroup) {
        const existing = groupSecret.get(field.generateGroup);
        if (existing) return existing;
        const secret = generateSecret();
        groupSecret.set(field.generateGroup, secret);
        return secret;
      }
      return generateSecret();
    }
    return input.config?.[field.key] ?? field.default ?? "";
  };

  // Seed the compose service rows.
  for (const svc of template.services ?? []) {
    // Multi-port apps (e.g. Convex: 3210 API + 3211 HTTP actions) declare one
    // route per port. Give each its own free subdomain — the primary uses the
    // default `<app>-<service>` label, secondaries append their slugSuffix — so
    // {{publicUrl:svc:port}} resolves to distinct hostnames.
    const publicEndpoints = svc.routes && svc.routes.length > 0
      ? svc.routes.map((route) => {
          const label = resolveServiceHostnameLabel(project.slug ?? project.name, svc.name, undefined, "compose");
          return {
            port: route.port,
            domainType: "free" as const,
            domain: route.slugSuffix ? `${label}-${route.slugSuffix}` : label,
          };
        })
      : undefined;

    await createService(ctx, project.id, {
      name: svc.name,
      image: svc.image,
      ports: svc.ports ? [...svc.ports] : [],
      dependsOn: svc.dependsOn ? [...svc.dependsOn] : [],
      environment: { ...(svc.environment ?? {}) },
      volumes: svc.volumes ? [...svc.volumes] : [],
      command: svc.command,
      restart: svc.restart,
      advanced: svc.healthcheck ? { healthcheck: svc.healthcheck } : {},
      exposed: svc.exposed ?? false,
      exposedPort: svc.exposedPort != null ? String(svc.exposedPort) : undefined,
      domainType: svc.exposed ? "free" : undefined,
      publicEndpoints,
    });
  }

  // Write config/secret env per service (values encrypted when `secret`).
  const varsByService = new Map<string, { key: string; value: string; isSecret: boolean }[]>();
  for (const field of template.configFields ?? []) {
    const value = valueFor(field);
    if (!value) continue;
    const list = varsByService.get(field.service) ?? [];
    list.push({ key: field.key, value, isSecret: !!field.secret });
    varsByService.set(field.service, list);
  }
  if (varsByService.size > 0) {
    const services = await repos.service.listByProject(project.id);
    const idByName = new Map(services.map((s) => [s.name, s.id]));
    for (const [svcName, vars] of varsByService) {
      const serviceId = idByName.get(svcName);
      if (serviceId) {
        await setServiceEnvVars(ctx, project.id, serviceId, { environment: "production", vars });
      }
    }
  }

  return { kind: "template", projectId: project.id, slug: project.slug };
}
