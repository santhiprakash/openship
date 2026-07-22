"use client";

import React from "react";
import {
  flattenSettingFields,
  envToSettingValue,
  settingToEnvValue,
  getAppTemplate,
  getAppManagement,
  type AppSettingField,
  type AppSettingGroup,
} from "@repo/core";
import type { AppSettingsView } from "@/lib/api/apps";

/** A catalog app whose template exposes curated (schema) settings — drives the
 *  "App settings" mode of the Configuration tab + the install-wizard step. */
export function isSchemaAppTemplate(appTemplateId?: string): boolean {
  if (!appTemplateId) return false;
  const tpl = getAppTemplate(appTemplateId);
  return !!tpl && getAppManagement(tpl)?.kind === "schema";
}

/**
 * Presentational, schema-driven settings form — the ONE renderer shared by the
 * day-2 project Settings tab and the install-time deploy-wizard step. It's fully
 * controlled: the parent owns value state (via `useAppSettings`) and the toolbar
 * (save / apply / advanced toggle). This component only turns a schema + values
 * into inputs, so both surfaces stay identical with zero duplication.
 */

export type FormValue = string | boolean;

/** Stable form-state key. Service names + env keys never contain spaces. */
export const fk = (service: string, key: string) => `${service} ${key}`;

/** Seed controlled form state from a settings view (secrets always start blank). */
export function seedFormValues(view: AppSettingsView): Record<string, FormValue> {
  const byKey = new Map(view.values.map((x) => [fk(x.service, x.key), x]));
  const next: Record<string, FormValue> = {};
  for (const f of flattenSettingFields(view.groups)) {
    const entry = byKey.get(fk(f.service, f.key));
    next[fk(f.service, f.key)] = f.secret
      ? ""
      : envToSettingValue(f, entry?.set ? entry.value : undefined);
  }
  return next;
}

/** Diff current values vs their seeded initial → the env changes to persist. */
export function buildChanges(
  fields: AppSettingField[],
  values: Record<string, FormValue>,
  initial: Record<string, FormValue>,
): { service: string; key: string; value: string }[] {
  const out: { service: string; key: string; value: string }[] = [];
  for (const f of fields) {
    const k = fk(f.service, f.key);
    const cur = values[k];
    if (f.secret) {
      if (cur === "" || cur === undefined) continue; // blank secret = unchanged
      out.push({ service: f.service, key: f.key, value: settingToEnvValue(f, cur) });
    } else if (cur !== initial[k]) {
      out.push({ service: f.service, key: f.key, value: settingToEnvValue(f, cur) });
    }
  }
  return out;
}

interface AppSettingsFormProps {
  groups: readonly AppSettingGroup[];
  values: Record<string, FormValue>;
  onChange: (field: AppSettingField, value: FormValue) => void;
  /** Whether a secret currently has a stored value (drives the "set" hint). */
  isSet?: (field: AppSettingField) => boolean;
  secretSetLabel: string;
  /** Show fields marked `advanced`. */
  showAdvanced?: boolean;
  /** Render only fields matching this predicate (e.g. install-step at first deploy). */
  filter?: (field: AppSettingField) => boolean;
  /** Render every (filtered) field in ONE card with no per-group headers —
   *  used by the install step, where the schema's group labels (e.g. "Advanced")
   *  would be misleading. */
  flat?: boolean;
  /** Heading for `flat` mode. */
  title?: string;
}

export function AppSettingsForm({
  groups,
  values,
  onChange,
  isSet,
  secretSetLabel,
  showAdvanced = false,
  filter,
  flat = false,
  title,
}: AppSettingsFormProps) {
  if (flat) {
    const fields = flattenSettingFields(groups).filter(
      (f) => (!filter || filter(f)) && (showAdvanced || !f.advanced),
    );
    if (fields.length === 0) return null;
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-5">
        {title && <h3 className="text-sm font-semibold text-foreground">{title}</h3>}
        <div className={`space-y-4 ${title ? "mt-4" : ""}`}>
          {fields.map((f) => (
            <Field
              key={fk(f.service, f.key)}
              field={f}
              value={values[fk(f.service, f.key)]}
              secretSet={!!isSet?.(f)}
              secretSetLabel={secretSetLabel}
              onChange={(v) => onChange(f, v)}
            />
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {groups.map((group) => {
        const visible = group.fields.filter(
          (f) => (!filter || filter(f)) && (showAdvanced || !f.advanced),
        );
        if (visible.length === 0) return null;
        return (
          <div key={group.id} className="bg-card rounded-2xl border border-border/50 p-5">
            <h3 className="text-sm font-semibold text-foreground">{group.label}</h3>
            {group.description && (
              <p className="mt-1 text-xs text-muted-foreground">{group.description}</p>
            )}
            <div className="mt-4 space-y-4">
              {visible.map((f) => (
                <Field
                  key={fk(f.service, f.key)}
                  field={f}
                  value={values[fk(f.service, f.key)]}
                  secretSet={!!isSet?.(f)}
                  secretSetLabel={secretSetLabel}
                  onChange={(v) => onChange(f, v)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Does any (optionally filtered) field carry the `advanced` flag? */
export function hasAdvancedFields(
  groups: readonly AppSettingGroup[],
  filter?: (field: AppSettingField) => boolean,
): boolean {
  return flattenSettingFields(groups).some((f) => f.advanced && (!filter || filter(f)));
}

function Field({
  field,
  value,
  secretSet,
  secretSetLabel,
  onChange,
}: {
  field: AppSettingField;
  value: FormValue | undefined;
  secretSet: boolean;
  secretSetLabel: string;
  onChange: (v: FormValue) => void;
}) {
  const inputCls =
    "w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring";

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm font-medium text-foreground">{field.label}</label>
        {field.type === "boolean" && (
          <button
            type="button"
            role="switch"
            aria-checked={value === true}
            onClick={() => onChange(!(value === true))}
            className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
              value === true ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`absolute top-0.5 size-4 rounded-full bg-background transition-transform ${
                value === true ? "translate-x-4" : "translate-x-0.5"
              }`}
            />
          </button>
        )}
      </div>

      {field.type === "select" ? (
        <select
          className={`${inputCls} mt-2`}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
        >
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : field.type === "boolean" ? null : (
        <input
          type={field.secret ? "password" : field.type === "number" ? "number" : "text"}
          className={`${inputCls} mt-2`}
          value={typeof value === "string" ? value : ""}
          placeholder={field.placeholder}
          autoComplete={field.secret ? "new-password" : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {field.help && <p className="mt-1.5 text-xs text-muted-foreground">{field.help}</p>}
      {field.secret && secretSet && (
        <p className="mt-1 text-xs text-muted-foreground">{secretSetLabel}</p>
      )}
    </div>
  );
}
