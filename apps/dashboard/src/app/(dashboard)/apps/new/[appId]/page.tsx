"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2, ArrowRight, ArrowLeft, SlidersHorizontal } from "lucide-react";
import {
  getAppTemplate,
  getAppSettings,
  flattenSettingFields,
  envToSettingValue,
  settingToEnvValue,
  isAppAvailable,
  type AppSettingField,
} from "@repo/core";
import { appsApi, deployApi, servicesApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { AppSettingsForm, fk, type FormValue } from "@/components/app-settings/AppSettingsForm";
import { AppDestinationPicker, type AppDestination } from "@/components/deploy/AppDestinationPicker";
import PublicEndpointsCard from "@/components/routing/PublicEndpointsCard";
import { createPublicEndpoint, type PublicEndpoint } from "@/context/deployment/types";
import {
  CleanDeployProgressCard,
  labelForStatus,
  firstPublicHost,
} from "@/components/deploy/CleanDeployProgress";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { AppLogo } from "@/components/AppLogo";
import { PageContainer } from "@/components/ui/PageContainer";
import { encodeProjectSlug } from "@/utils/repoSlug";

/**
 * Dedicated app-install wizard — a CLEAN business-only wrapper over the existing
 * deploy pipeline. No ports/services/routes/logs: the app's template defines
 * what to ask (install-step business fields + whether it needs a public URL);
 * the template's known ports drive routing. It's a pure client orchestration of
 * existing endpoints — install → apply settings + domain → buildAccess — with a
 * clean progress view (polling build status, no raw logs). "Advanced" hands off
 * to the technical /deploy wizard.
 */

type Phase = "form" | "installing" | "done" | "error";

const isInstallField = (f: AppSettingField) => f.installStep === true;

export default function AppInstallPage() {
  const params = useParams();
  const router = useRouter();
  const { t } = useI18n();
  const w = t.projectSettings.appInstall;
  const { showToast } = useToast();
  const { baseDomain } = usePlatform();

  const appId = String(params?.appId ?? "");
  const template = useMemo(() => getAppTemplate(appId), [appId]);
  const groups = useMemo(() => (template ? getAppSettings(template) : []), [template]);
  const installFields = useMemo(
    () => flattenSettingFields(groups).filter(isInstallField),
    [groups],
  );
  // Ports are known from the template — we only ask about a public URL when the
  // app actually exposes a web-facing service, and we drive routing off that
  // service's port (the user picks the subdomain/domain, not the port).
  const exposedService = useMemo(
    () => template?.services?.find((s) => s.exposed),
    [template],
  );
  const needsDomain = !!exposedService;
  // Routing port for the exposed service: an explicit route port wins, else the
  // host side of the first "host:container" port mapping.
  const exposedPort = useMemo(() => {
    if (!exposedService) return "";
    if (exposedService.routes && exposedService.routes.length > 0) {
      return String(exposedService.routes[0].port);
    }
    const first = exposedService.ports?.[0];
    const host = first ? String(first).split(":")[0] : "";
    return host || "";
  }, [exposedService]);

  const [values, setValues] = useState<Record<string, FormValue>>(() => {
    const seed: Record<string, FormValue> = {};
    for (const f of installFields) seed[fk(f.service, f.key)] = envToSettingValue(f, undefined);
    return seed;
  });
  // Routing — reuses the deploy wizard's PublicEndpointsCard (free-subdomain
  // slug chooser + custom domain), not a bespoke picker. One endpoint for the
  // app's single exposed service; `internalOnly` = the "no public URL" case.
  const [endpoints, setEndpoints] = useState<PublicEndpoint[]>(() => [
    createPublicEndpoint({ domainType: "free" }),
  ]);
  const [internalOnly, setInternalOnly] = useState(false);
  const [destination, setDestination] = useState<AppDestination | null>(null);

  const [phase, setPhase] = useState<Phase>("form");
  const [busy, setBusy] = useState(false);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [phaseLabel, setPhaseLabel] = useState("");
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  // Unknown / non-installable / flow apps don't belong here.
  useEffect(() => {
    if (!template || template.kind === "flow" || !isAppAvailable(appId)) {
      router.replace("/apps/new");
    }
  }, [template, appId, router]);

  // ── Clean progress poll (status only, never raw logs) ──────────────────────
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (phase !== "installing" || !deploymentId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const res = await deployApi.getBuildStatus(deploymentId);
        const s = res?.data ?? res ?? {};
        const status: string = s.deploymentStatus ?? s.status ?? "queued";
        setProgress(typeof s.progress === "number" ? s.progress : 0);
        setPhaseLabel(labelForStatus(status, w));
        if (status === "ready") {
          setLiveUrl(firstPublicHost(s?.config?.publicEndpoints, baseDomain));
          setPhase("done");
        } else if (["failed", "cancelled", "partial_failure", "rejected"].includes(status)) {
          setErrorMsg(s.failureMessage || w.installFailed);
          setPhase("error");
        }
      } catch {
        /* transient — keep polling */
      }
    };
    void tick();
    pollRef.current = setInterval(() => {
      if (!stopped) void tick();
    }, 2000);
    return () => {
      stopped = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, deploymentId, baseDomain]);

  if (!template) return null;

  const setField = (f: AppSettingField, v: FormValue) =>
    setValues((prev) => ({ ...prev, [fk(f.service, f.key)]: v }));

  /** Business-field changes vs the template defaults → the settings to persist. */
  const settingChanges = () => {
    const out: { service: string; key: string; value: string }[] = [];
    for (const f of installFields) {
      const cur = values[fk(f.service, f.key)];
      const def = envToSettingValue(f, undefined);
      if (cur !== def && !(f.secret && cur === "")) {
        out.push({ service: f.service, key: f.key, value: settingToEnvValue(f, cur ?? "") });
      }
    }
    return out;
  };

  /** Apply the chosen routing to the exposed service(s) of the freshly-created
   *  project — the same service-update endpoint the project Domains tab uses.
   *  internalOnly → unexpose; custom → set customDomain; free → set the chosen
   *  subdomain slug (or keep the template's baked default when left blank). */
  const applyDomain = async (pid: string) => {
    if (!needsDomain) return;
    const svcRes = await servicesApi.list(pid);
    const services = (svcRes?.services ?? []) as Array<{
      id: string;
      exposed?: boolean;
      exposedPort?: string | null;
    }>;
    const exposed = services.filter((s) => s.exposed);
    if (exposed.length === 0) return;
    if (internalOnly) {
      for (const s of exposed) {
        await servicesApi.update(pid, s.id, { exposed: false });
      }
      return;
    }
    const ep = endpoints[0];
    if (!ep) return;
    // Primary exposed service (the one with an exposedPort, else first).
    const primary = exposed.find((s) => s.exposedPort) ?? exposed[0];
    if (ep.domainType === "custom") {
      const custom = ep.customDomain.trim().toLowerCase();
      if (custom) await servicesApi.update(pid, primary.id, { domainType: "custom", customDomain: custom });
    } else {
      const slug = ep.domain.trim().toLowerCase();
      // Blank = keep the template's baked free subdomain; a value overrides it.
      if (slug) await servicesApi.update(pid, primary.id, { domainType: "free", domain: slug });
    }
  };

  const install = async () => {
    if (busy) return;
    if (
      needsDomain &&
      !internalOnly &&
      endpoints[0]?.domainType === "custom" &&
      !endpoints[0]?.customDomain.trim()
    ) {
      showToast(w.customRequired, "error");
      return;
    }
    setBusy(true);
    try {
      const res = await appsApi.install({ templateId: appId });
      const data = res.data;
      if (data.kind !== "template") {
        router.push((data as { flowHref?: string }).flowHref ?? "/apps");
        return;
      }
      const pid = data.projectId;
      setProjectId(pid);

      const changes = settingChanges();
      if (changes.length > 0) await appsApi.updateSettings(pid, changes);
      await applyDomain(pid);

      const dep = await deployApi.buildAccess({
        projectId: pid,
        serviceDeploymentMode: "services",
        // Where to install — reuses the deploy wizard's target selection.
        // Undefined falls back to the project/meta default server-side.
        deployTarget: destination?.deployTarget,
        serverId: destination?.deployTarget === "server" ? destination.serverId : undefined,
      });
      const depId = dep?.data?.deployment_id ?? dep?.data?.deploymentId ?? dep?.deployment_id ?? null;
      setDeploymentId(depId);
      setPhaseLabel(w.progressPreparing);
      setPhase("installing");
    } catch (err) {
      setErrorMsg(getApiErrorMessage(err, w.installFailed));
      setPhase("error");
    } finally {
      setBusy(false);
    }
  };

  /** Advanced escape: create the project and hand off to the technical wizard. */
  const goAdvanced = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await appsApi.install({ templateId: appId });
      const data = res.data;
      if (data.kind === "template") {
        router.push(`/deploy/${encodeProjectSlug(data.projectId)}`);
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, w.installFailed), "error");
      setBusy(false);
    }
  };

  // ── Progress / done / error states (shared clean progress view) ────────────
  if (phase === "installing" || phase === "done" || phase === "error") {
    return (
      <CleanDeployProgressCard
        appId={appId}
        title={template.name}
        phase={phase}
        progress={progress}
        phaseLabel={phaseLabel}
        liveUrl={liveUrl}
        errorMsg={errorMsg}
        deploymentId={deploymentId}
        onGoToProject={() => projectId && router.push(`/projects/${projectId}`)}
        onViewBuild={() => deploymentId && router.push(`/build/${deploymentId}`)}
        onRetry={() => setPhase("form")}
      />
    );
  }

  // ── Form state ────────────────────────────────────────────────────────────
  return (
    <PageContainer outerClassName="pb-20">
      <div className="mx-auto max-w-5xl pt-6">
        {/* Back to the app catalog */}
        <button
          type="button"
          onClick={() => router.push("/apps/new")}
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4 rtl:rotate-180" />
          {w.back}
        </button>

        {/* Header */}
        <div className="flex items-center gap-4">
          <div className="flex size-12 items-center justify-center rounded-2xl bg-muted/60">
            <AppLogo appId={appId} className="size-7 object-contain" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">{template.name}</h1>
            <p className="text-sm text-muted-foreground">{template.description}</p>
          </div>
        </div>

        {/* Two columns: what the app needs (left) + where it goes & the deploy
            action (right, sticky). Mirrors the deploy wizard's config/sidebar
            split so the destination switch + Deploy button live together. */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_360px]">
          {/* LEFT — business settings + public URL */}
          <div className="min-w-0 space-y-5">
            {installFields.length > 0 && (
              <AppSettingsForm
                groups={groups}
                values={values}
                onChange={setField}
                secretSetLabel={t.projectSettings.appSettings.secretSet}
                showAdvanced
                filter={isInstallField}
                flat
                title={t.projectSettings.appSettings.modeApp}
              />
            )}

            {/* Public URL — reuses the deploy wizard's routing core (subdomain
                slug chooser + custom domain). The "no public URL" case is a
                simple opt-out below it. */}
            {needsDomain && (
              <div className="rounded-2xl border border-border/50 bg-card p-5">
                <h3 className="text-sm font-semibold text-foreground">{w.domainTitle}</h3>
                {!internalOnly && (
                  <div className="mt-4">
                    <PublicEndpointsCard
                      projectName={template.name}
                      endpoints={endpoints}
                      hasServer
                      runtimePort={exposedPort}
                      allowPortEdit={false}
                      hideHeader
                      onChange={(eps) => setEndpoints(eps)}
                    />
                  </div>
                )}
                <label className="mt-3 flex items-center gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={internalOnly}
                    onChange={(e) => setInternalOnly(e.target.checked)}
                    className="size-4 rounded border-border accent-primary"
                  />
                  <span>
                    {w.domainNone}
                    <span className="text-muted-foreground/70"> — {w.domainNoneHint}</span>
                  </span>
                </label>
              </div>
            )}
          </div>

          {/* RIGHT — destination + deploy action (sticky) */}
          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            {/* Destination — where to install (reuses the deploy target picker) */}
            <div className="rounded-2xl border border-border/50 bg-card p-5">
              <h3 className="text-sm font-semibold text-foreground">{w.destinationTitle}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{w.destinationHint}</p>
              <div className="mt-4">
                <AppDestinationPicker value={destination} onChange={setDestination} allowLocal />
              </div>
            </div>

            {/* Actions */}
            <div className="space-y-2">
              <button
                type="button"
                onClick={install}
                disabled={busy}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowRight className="size-4 rtl:rotate-180" />}
                {busy ? w.installing : w.install}
              </button>
              <button
                type="button"
                onClick={goAdvanced}
                disabled={busy}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                <SlidersHorizontal className="size-3.5" /> {w.advanced}
              </button>
            </div>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}

