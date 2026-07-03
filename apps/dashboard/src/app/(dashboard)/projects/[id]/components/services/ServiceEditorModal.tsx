"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, Save, X } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Checkbox } from "@/components/ui/Checkbox";
import {
  serviceKind,
  type Service,
  type ServiceInput,
  type ComposeAdvanced,
  type ComposeHealthcheck,
} from "@/lib/api/services";
import { RoutingSettingsCard } from "@/components/routing/RoutingSettingsCard";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";

type EnvRow = { key: string; value: string; visible: boolean };

type ServiceEditorMode = "create" | "edit";

interface ServiceEditorModalProps {
  open: boolean;
  mode: ServiceEditorMode;
  service?: Service | null;
  projectName: string;
  onClose: () => void;
  onSubmit: (data: ServiceInput) => Promise<void>;
}

const splitList = (value: string) =>
  value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

const joinList = (value?: string[] | null) => (value ?? []).join("\n");

const envRowsFromRecord = (value?: Record<string, string> | null): EnvRow[] =>
  // Service env values are config knobs more often than secrets - show them
  // by default so the user can read what's there without un-masking each row.
  Object.entries(value ?? {}).map(([key, val]) => ({ key, value: val, visible: true }));

const envRecordFromRows = (rows: EnvRow[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const k = r.key.trim();
    if (!k) continue;
    out[k] = r.value;
  }
  return out;
};

export function ServiceEditorModal({
  open,
  mode,
  service,
  projectName,
  onClose,
  onSubmit,
}: ServiceEditorModalProps) {
  // Service kind determines which "source" fields the form shows:
  //   compose  → image OR Dockerfile build
  //   monorepo → rootDirectory + install/build/start commands (source build)
  // Both kinds share env, ports, volumes, routing.
  const isMonorepo = serviceKind(service) === "monorepo";

  const [name, setName] = useState("");
  const [sourceType, setSourceType] = useState<"image" | "build">("image");
  const [image, setImage] = useState("");
  const [build, setBuild] = useState("");
  const [dockerfile, setDockerfile] = useState("");
  const [ports, setPorts] = useState("");
  const [dependsOn, setDependsOn] = useState("");
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [volumes, setVolumes] = useState("");
  const [command, setCommand] = useState("");
  const [restart, setRestart] = useState("unless-stopped");
  // Healthcheck (compose `advanced.healthcheck`). `test` is edited as the shell
  // (CMD-SHELL) form; empty test = no healthcheck override.
  const [hcTest, setHcTest] = useState("");
  const [hcInterval, setHcInterval] = useState("");
  const [hcTimeout, setHcTimeout] = useState("");
  const [hcRetries, setHcRetries] = useState("");
  const [hcStartPeriod, setHcStartPeriod] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [exposed, setExposed] = useState(false);
  const [exposedPort, setExposedPort] = useState("");
  const [domain, setDomain] = useState("");
  const [customDomain, setCustomDomain] = useState("");
  const [domainType, setDomainType] = useState<"free" | "custom">("free");
  // Monorepo build settings (only used when isMonorepo)
  const [rootDirectory, setRootDirectory] = useState("");
  const [framework, setFramework] = useState("");
  const [packageManager, setPackageManager] = useState("");
  const [buildImage, setBuildImage] = useState("");
  const [installCommand, setInstallCommand] = useState("");
  const [buildCommand, setBuildCommand] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [outputDirectory, setOutputDirectory] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;

    setName(service?.name ?? "");
    setSourceType(service?.build || service?.dockerfile ? "build" : "image");
    setImage(service?.image ?? "");
    setBuild(service?.build ?? "");
    setDockerfile(service?.dockerfile ?? "");
    setPorts(joinList(service?.ports));
    setDependsOn(joinList(service?.dependsOn));
    setEnvRows(envRowsFromRecord(service?.environment));
    setVolumes(joinList(service?.volumes));
    setCommand(service?.command ?? "");
    setRestart(service?.restart ?? "unless-stopped");
    const hc = service?.advanced?.healthcheck;
    setHcTest(hc ? (Array.isArray(hc.test) ? hc.test.join(" ") : hc.test ?? "") : "");
    setHcInterval(hc?.interval ?? "");
    setHcTimeout(hc?.timeout ?? "");
    setHcRetries(hc?.retries != null ? String(hc.retries) : "");
    setHcStartPeriod(hc?.startPeriod ?? "");
    setEnabled(service?.enabled ?? true);
    setExposed(service?.exposed ?? false);
    setExposedPort(service?.exposedPort ?? "");
    setDomain(service?.domain ?? "");
    setCustomDomain(service?.customDomain ?? "");
    setDomainType(service?.domainType === "custom" ? "custom" : "free");
    setRootDirectory(service?.rootDirectory ?? "");
    setFramework(service?.framework ?? "");
    setPackageManager(service?.packageManager ?? "");
    setBuildImage(service?.buildImage ?? "");
    setInstallCommand(service?.installCommand ?? "");
    setBuildCommand(service?.buildCommand ?? "");
    setStartCommand(service?.startCommand ?? "");
    setOutputDirectory(service?.outputDirectory ?? "");
    setError(null);
    setSaving(false);
  }, [open, service]);

  const portList = useMemo(() => splitList(ports), [ports]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = name.trim();

    if (!trimmedName) {
      setError("Service name is required.");
      return;
    }

    // Per-kind required-field validation. Compose services need a source
    // (image OR Dockerfile). Monorepo sub-apps need a rootDirectory + at
    // least one of buildCommand / startCommand (the pipeline accepts
    // run-only sub-apps that have no build step).
    if (!isMonorepo) {
      if (sourceType === "image" && !image.trim()) {
        setError("Add an image, or switch to Dockerfile build.");
        return;
      }
      if (sourceType === "build" && !build.trim() && !dockerfile.trim()) {
        setError("Add a build context or Dockerfile path.");
        return;
      }
    } else {
      if (!rootDirectory.trim()) {
        setError("Add a root directory (e.g. apps/web).");
        return;
      }
      if (!buildCommand.trim() && !startCommand.trim()) {
        setError("Add at least a build command or a start command.");
        return;
      }
    }

    setSaving(true);
    setError(null);

    // Assemble the compose `advanced` blob. Empty test → `{}` so saving clears
    // any prior healthcheck (rather than silently preserving it).
    const buildAdvanced = (): ComposeAdvanced => {
      const test = hcTest.trim();
      if (!test) return {};
      const hc: ComposeHealthcheck = { test };
      if (hcInterval.trim()) hc.interval = hcInterval.trim();
      if (hcTimeout.trim()) hc.timeout = hcTimeout.trim();
      if (hcStartPeriod.trim()) hc.startPeriod = hcStartPeriod.trim();
      const retries = Number(hcRetries);
      if (hcRetries.trim() && Number.isInteger(retries) && retries >= 0) hc.retries = retries;
      return { healthcheck: hc };
    };

    const payload: ServiceInput = isMonorepo
      ? {
          // Monorepo sub-app: source-built. No image/build/dockerfile -
          // the build comes from rootDirectory + commands.
          name: trimmedName,
          kind: "monorepo",
          image: "",
          build: "",
          dockerfile: "",
          ports: portList,
          dependsOn: splitList(dependsOn),
          environment: envRecordFromRows(envRows),
          volumes: splitList(volumes),
          command: "",
          restart,
          enabled,
          exposed,
          exposedPort: exposed ? exposedPort.trim() || undefined : undefined,
          domain: exposed && domainType === "free" ? domain.trim() || undefined : undefined,
          customDomain:
            exposed && domainType === "custom" ? customDomain.trim() || undefined : undefined,
          domainType,
          rootDirectory: rootDirectory.trim(),
          framework: framework.trim() || undefined,
          packageManager: packageManager.trim() || undefined,
          buildImage: buildImage.trim() || undefined,
          installCommand: installCommand.trim() || undefined,
          buildCommand: buildCommand.trim() || undefined,
          startCommand: startCommand.trim() || undefined,
          outputDirectory: outputDirectory.trim() || undefined,
        }
      : {
          name: trimmedName,
          kind: "compose",
          image: sourceType === "image" ? image.trim() : "",
          build: sourceType === "build" ? build.trim() || "." : "",
          dockerfile: sourceType === "build" ? dockerfile.trim() : "",
          ports: portList,
          dependsOn: splitList(dependsOn),
          environment: envRecordFromRows(envRows),
          volumes: splitList(volumes),
          command: command.trim(),
          restart,
          advanced: buildAdvanced(),
          enabled,
          exposed,
          exposedPort: exposed ? exposedPort.trim() || undefined : undefined,
          domain: exposed && domainType === "free" ? domain.trim() || undefined : undefined,
          customDomain:
            exposed && domainType === "custom" ? customDomain.trim() || undefined : undefined,
          domainType,
        };

    try {
      await onSubmit(payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save service.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen={open} onClose={onClose} maxWidth="760px" width="100%" maxHeight="92vh">
      <form onSubmit={handleSubmit} className="flex max-h-[92vh] flex-col">
        <div className="border-b border-border/40 px-6 py-5">
          <h2 className="text-base font-semibold text-foreground">
            {mode === "create"
              ? isMonorepo ? "Add sub-app" : "Add service"
              : isMonorepo ? "Edit sub-app" : "Edit service"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Services are project children. Compose can create them, and manual services use the same deploy path.
          </p>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {error && (
            <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}

          <Field label="Name">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="web"
              className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>

          {isMonorepo ? (
            // ── Monorepo sub-app: source build (no image/Dockerfile) ────
            <div className="space-y-3">
              <Field label="Root directory">
                <input
                  value={rootDirectory}
                  onChange={(event) => setRootDirectory(event.target.value)}
                  placeholder="apps/web"
                  className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
                />
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Framework">
                  <input
                    value={framework}
                    onChange={(event) => setFramework(event.target.value)}
                    placeholder="nextjs"
                    className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
                  />
                </Field>
                <Field label="Package manager">
                  <input
                    value={packageManager}
                    onChange={(event) => setPackageManager(event.target.value)}
                    placeholder="pnpm"
                    className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
                  />
                </Field>
              </div>
              <Field label="Build image">
                <input
                  value={buildImage}
                  onChange={(event) => setBuildImage(event.target.value)}
                  placeholder="node:22"
                  className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
                />
              </Field>
              <Field label="Install command">
                <input
                  value={installCommand}
                  onChange={(event) => setInstallCommand(event.target.value)}
                  placeholder="pnpm install --frozen-lockfile"
                  className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
                />
              </Field>
              <Field label="Build command">
                <input
                  value={buildCommand}
                  onChange={(event) => setBuildCommand(event.target.value)}
                  placeholder="pnpm build"
                  className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
                />
              </Field>
              <Field label="Start command">
                <input
                  value={startCommand}
                  onChange={(event) => setStartCommand(event.target.value)}
                  placeholder="pnpm start"
                  className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
                />
              </Field>
              <Field label="Output directory">
                <input
                  value={outputDirectory}
                  onChange={(event) => setOutputDirectory(event.target.value)}
                  placeholder=".next"
                  className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40 font-mono"
                />
              </Field>
            </div>
          ) : (
            // ── Compose service: image OR Dockerfile ────────────────────
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSourceType("image")}
                  className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                    sourceType === "image"
                      ? "bg-primary/10 text-primary ring-1 ring-primary/15"
                      : "bg-muted/40 text-muted-foreground hover:bg-muted/60"
                  }`}
                >
                  Image
                </button>
                <button
                  type="button"
                  onClick={() => setSourceType("build")}
                  className={`rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
                    sourceType === "build"
                      ? "bg-primary/10 text-primary ring-1 ring-primary/15"
                      : "bg-muted/40 text-muted-foreground hover:bg-muted/60"
                  }`}
                >
                  Dockerfile
                </button>
              </div>

              {sourceType === "image" ? (
                <Field label="Image">
                  <input
                    value={image}
                    onChange={(event) => setImage(event.target.value)}
                    placeholder="postgres:16"
                    className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
                  />
                </Field>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Build context">
                    <input
                      value={build}
                      onChange={(event) => setBuild(event.target.value)}
                      placeholder="."
                      className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
                    />
                  </Field>
                  <Field label="Dockerfile">
                    <input
                      value={dockerfile}
                      onChange={(event) => setDockerfile(event.target.value)}
                      placeholder="Dockerfile"
                      className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
                    />
                  </Field>
                </div>
              )}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Ports">
              <textarea
                value={ports}
                onChange={(event) => setPorts(event.target.value)}
                placeholder={"3000\n8080:80"}
                rows={3}
                className="w-full rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
              />
            </Field>
            <Field label="Depends on">
              <textarea
                value={dependsOn}
                onChange={(event) => setDependsOn(event.target.value)}
                placeholder={"db\nredis"}
                rows={3}
                className="w-full rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
              />
            </Field>
          </div>

          {/* Compose-only: per-container "command" override. Monorepo sub-apps
              get their command from `startCommand` above, so we hide this. */}
          <div className={`grid gap-3 ${isMonorepo ? "sm:grid-cols-1" : "sm:grid-cols-2"}`}>
            {!isMonorepo && (
              <Field label="Command">
                <input
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="npm start"
                  className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
                />
              </Field>
            )}
            <Field label="Restart policy">
              <select
                value={restart}
                onChange={(event) => setRestart(event.target.value)}
                className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
              >
                <option value="unless-stopped">unless-stopped</option>
                <option value="always">always</option>
                <option value="on-failure">on-failure</option>
                <option value="no">no</option>
              </select>
            </Field>
          </div>

          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">Environment</p>
            <EnvironmentVariables
              mode="settings"
              envVars={envRows}
              onEnvVarsChange={setEnvRows}
              isEditingMode={true}
              setIsEditingMode={() => { /* always editing in modal context */ }}
              showSettingsActions={false}
              borderless
            />
          </div>

          <Field label="Volumes">
            <textarea
              value={volumes}
              onChange={(event) => setVolumes(event.target.value)}
              placeholder={"pgdata:/var/lib/postgresql/data"}
              rows={2}
              className="w-full rounded-xl border border-border/50 bg-muted/20 px-3 py-2 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
            />
          </Field>

          {/* Compose-only: container healthcheck override. Honored by the Docker
              runtime; the cloud runtime ignores it (warns at deploy). */}
          {!isMonorepo && (
            <Field label="Healthcheck">
              <input
                value={hcTest}
                onChange={(event) => setHcTest(event.target.value)}
                placeholder="curl -f http://localhost:3000/health || exit 1"
                className="h-11 w-full rounded-xl border border-border/50 bg-muted/20 px-3 text-sm text-foreground outline-none transition-colors focus:border-primary/40"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Test command (shell form). Leave empty to use the image&apos;s default check.
              </p>
              {hcTest.trim() && (
                <div className="mt-2 grid gap-2 sm:grid-cols-4">
                  <input
                    value={hcInterval}
                    onChange={(event) => setHcInterval(event.target.value)}
                    placeholder="interval 30s"
                    className="h-10 w-full rounded-lg border border-border/50 bg-muted/20 px-2.5 text-sm text-foreground outline-none focus:border-primary/40"
                  />
                  <input
                    value={hcTimeout}
                    onChange={(event) => setHcTimeout(event.target.value)}
                    placeholder="timeout 10s"
                    className="h-10 w-full rounded-lg border border-border/50 bg-muted/20 px-2.5 text-sm text-foreground outline-none focus:border-primary/40"
                  />
                  <input
                    value={hcRetries}
                    onChange={(event) => setHcRetries(event.target.value)}
                    placeholder="retries 3"
                    inputMode="numeric"
                    className="h-10 w-full rounded-lg border border-border/50 bg-muted/20 px-2.5 text-sm text-foreground outline-none focus:border-primary/40"
                  />
                  <input
                    value={hcStartPeriod}
                    onChange={(event) => setHcStartPeriod(event.target.value)}
                    placeholder="start 40s"
                    className="h-10 w-full rounded-lg border border-border/50 bg-muted/20 px-2.5 text-sm text-foreground outline-none focus:border-primary/40"
                  />
                </div>
              )}
            </Field>
          )}

          <div className="rounded-2xl border border-border/50 bg-muted/10 p-4">
            <RoutingSettingsCard
              projectName={projectName}
              domain={domain}
              customDomain={customDomain}
              domainType={domainType}
              exposed={exposed}
              ports={portList}
              exposedPort={exposedPort}
              onExposedChange={setExposed}
              onDomainTypeChange={setDomainType}
              onDomainChange={setDomain}
              onCustomDomainChange={setCustomDomain}
              onExposedPortChange={setExposedPort}
              saveMode="change"
            />
          </div>

          <label
            htmlFor="service-enabled"
            className="flex items-center justify-between rounded-2xl border border-border/50 bg-muted/10 px-4 py-3 cursor-pointer"
          >
            <span>
              <span className="block text-sm font-medium text-foreground">Enabled</span>
              <span className="text-xs text-muted-foreground">Enabled services deploy with the project.</span>
            </span>
            <Checkbox
              id="service-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              aria-label="Enabled"
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/40 px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-foreground/[0.06] px-4 text-sm font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:opacity-50"
          >
            <X className="size-4" />
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : mode === "create" ? (
              <Plus className="size-4" />
            ) : (
              <Save className="size-4" />
            )}
            {mode === "create" ? "Add service" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
