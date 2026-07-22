/**
 * Curated day-2 settings for installed apps.
 *
 * Distinct from install-time `configFields` (which are generated secrets filled
 * once at install): these are the operator-editable knobs an app exposes AFTER
 * install, rendered as a friendly form instead of raw per-service env editing.
 * Each field maps to exactly one env key on one service; the dashboard writes
 * them through the safe merge-env path and applies with a restart (or a full
 * redeploy for `requiresRedeploy` fields).
 */

/** How an installed app surfaces its management UI. */
export type AppManagement =
  | { kind: "schema" }
  | { kind: "custom"; href: string };

export interface AppSettingOption {
  value: string;
  label: string;
}

export interface AppSettingField {
  /** Env key this setting reads/writes. */
  key: string;
  /** Service whose env this setting lives on. */
  service: string;
  label: string;
  help?: string;
  type: "text" | "password" | "boolean" | "select" | "number";
  /** Choices for `type:"select"`. */
  options?: readonly AppSettingOption[];
  /** Bounds for `type:"number"` (inclusive). */
  min?: number;
  max?: number;
  /** Require a whole number for `type:"number"`. */
  integer?: boolean;
  /** Effective value when the env key is unset. */
  default?: string;
  placeholder?: string;
  /** Stored encrypted; masked on read; blank on save means "leave unchanged". */
  secret?: boolean;
  /** Env strings a boolean maps to (default "true"/"false"). */
  trueValue?: string;
  falseValue?: string;
  /** Needs a full redeploy to take effect, not just a restart-apply. */
  requiresRedeploy?: boolean;
  /** Tuck under the collapsible Advanced block within the app's settings. */
  advanced?: boolean;
  /** Collect this field in the install wizard step (before first deploy), not
   *  only in the day-2 tab. Fields safe/meaningful to set at install (e.g. a
   *  name that's dangerous to change later, or required credentials). */
  installStep?: boolean;
  /** Must be non-empty before the app can be deployed (install-wizard gate). */
  required?: boolean;
}

export interface AppSettingGroup {
  id: string;
  label: string;
  description?: string;
  fields: readonly AppSettingField[];
}

export const settingTrueValue = (f: AppSettingField): string => f.trueValue ?? "true";
export const settingFalseValue = (f: AppSettingField): string => f.falseValue ?? "false";

export function flattenSettingFields(groups: readonly AppSettingGroup[]): AppSettingField[] {
  return groups.flatMap((g) => [...g.fields]);
}

export function findSettingField(
  groups: readonly AppSettingGroup[],
  service: string,
  key: string,
): AppSettingField | undefined {
  return flattenSettingFields(groups).find((f) => f.service === service && f.key === key);
}

/** Env string → the value shape the UI control expects. */
export function envToSettingValue(field: AppSettingField, env: string | undefined): string | boolean {
  if (field.type === "boolean") return (env ?? field.default) === settingTrueValue(field);
  return env ?? field.default ?? "";
}

/** UI control value → the env string to store. */
export function settingToEnvValue(field: AppSettingField, raw: string | boolean): string {
  if (field.type === "boolean") {
    const on = typeof raw === "boolean" ? raw : raw === settingTrueValue(field) || raw === "true";
    return on ? settingTrueValue(field) : settingFalseValue(field);
  }
  return String(raw);
}

/**
 * Validate a proposed env string for a field. Empty is always allowed (means
 * "clear to default" for plain fields, "leave unchanged" for secrets). Returns
 * an error message, or null when valid.
 */
export function validateSetting(field: AppSettingField, raw: string): string | null {
  if (raw === "") return null;
  if (field.type === "number") {
    if (!/^-?\d+(\.\d+)?$/.test(raw)) return `${field.label} must be a number`;
    const n = Number(raw);
    if (field.integer && !Number.isInteger(n)) return `${field.label} must be a whole number`;
    if (field.min != null && n < field.min) return `${field.label} must be at least ${field.min}`;
    if (field.max != null && n > field.max) return `${field.label} must be at most ${field.max}`;
    return null;
  }
  if (field.type === "select") {
    const allowed = (field.options ?? []).map((o) => o.value);
    if (!allowed.includes(raw)) return `${field.label} must be one of: ${allowed.join(", ")}`;
    return null;
  }
  if (field.type === "boolean") {
    if (raw !== settingTrueValue(field) && raw !== settingFalseValue(field)) {
      return `${field.label} must be a boolean`;
    }
  }
  return null;
}
