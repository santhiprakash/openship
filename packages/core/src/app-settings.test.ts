import { describe, it, expect } from "vitest";
import {
  envToSettingValue,
  settingToEnvValue,
  validateSetting,
  findSettingField,
  flattenSettingFields,
  type AppSettingField,
  type AppSettingGroup,
} from "./app-settings";
import { getAppTemplate, getAppManagement, getAppSettings } from "./app-templates";

const boolField: AppSettingField = { key: "B", service: "s", label: "B", type: "boolean", default: "true" };
const onOffField: AppSettingField = {
  key: "M",
  service: "s",
  label: "M",
  type: "boolean",
  trueValue: "on",
  falseValue: "off",
};
const numField: AppSettingField = { key: "N", service: "s", label: "N", type: "number", default: "336" };
const selField: AppSettingField = {
  key: "S",
  service: "s",
  label: "S",
  type: "select",
  options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
};

describe("envToSettingValue", () => {
  it("boolean compares against the true-value (custom or default)", () => {
    expect(envToSettingValue(boolField, "true")).toBe(true);
    expect(envToSettingValue(boolField, "false")).toBe(false);
    expect(envToSettingValue(boolField, undefined)).toBe(true); // falls back to default "true"
    expect(envToSettingValue(onOffField, "on")).toBe(true);
    expect(envToSettingValue(onOffField, "off")).toBe(false);
  });

  it("plain field falls back env → default → empty", () => {
    expect(envToSettingValue(numField, "500")).toBe("500");
    expect(envToSettingValue(numField, undefined)).toBe("336");
    expect(envToSettingValue({ key: "T", service: "s", label: "T", type: "text" }, undefined)).toBe("");
  });
});

describe("settingToEnvValue", () => {
  it("boolean maps to the configured env strings", () => {
    expect(settingToEnvValue(boolField, true)).toBe("true");
    expect(settingToEnvValue(boolField, false)).toBe("false");
    expect(settingToEnvValue(onOffField, true)).toBe("on");
    expect(settingToEnvValue(onOffField, false)).toBe("off");
  });

  it("non-boolean stringifies", () => {
    expect(settingToEnvValue(numField, "336")).toBe("336");
    expect(settingToEnvValue({ key: "T", service: "s", label: "T", type: "text" }, "hi")).toBe("hi");
  });
});

describe("validateSetting", () => {
  it("empty is always allowed (clear / unchanged)", () => {
    expect(validateSetting(numField, "")).toBeNull();
    expect(validateSetting(selField, "")).toBeNull();
  });
  it("number must be numeric", () => {
    expect(validateSetting(numField, "500")).toBeNull();
    expect(validateSetting(numField, "abc")).toMatch(/must be a number/);
  });
  it("number honours integer + min/max bounds", () => {
    const hours: AppSettingField = {
      key: "H", service: "s", label: "Hours", type: "number", integer: true, min: 1, max: 1000,
    };
    expect(validateSetting(hours, "336")).toBeNull();
    expect(validateSetting(hours, "0")).toMatch(/at least 1/);
    expect(validateSetting(hours, "-24")).toMatch(/at least 1/);
    expect(validateSetting(hours, "1.5")).toMatch(/whole number/);
    expect(validateSetting(hours, "5000")).toMatch(/at most 1000/);
  });
  it("select must be an allowed option", () => {
    expect(validateSetting(selField, "a")).toBeNull();
    expect(validateSetting(selField, "z")).toMatch(/must be one of/);
  });
  it("boolean must be one of the two env strings", () => {
    expect(validateSetting(onOffField, "on")).toBeNull();
    expect(validateSetting(onOffField, "maybe")).toMatch(/must be a boolean/);
  });
});

describe("field lookup", () => {
  const groups: AppSettingGroup[] = [
    { id: "g1", label: "G1", fields: [boolField, numField] },
    { id: "g2", label: "G2", fields: [selField] },
  ];
  it("flattens across groups", () => {
    expect(flattenSettingFields(groups).map((f) => f.key)).toEqual(["B", "N", "S"]);
  });
  it("finds by service + key", () => {
    expect(findSettingField(groups, "s", "N")).toBe(numField);
    expect(findSettingField(groups, "s", "nope")).toBeUndefined();
  });
});

describe("template management resolution", () => {
  it("n8n exposes schema management + settings groups", () => {
    const n8n = getAppTemplate("n8n")!;
    expect(getAppManagement(n8n)).toEqual({ kind: "schema" });
    expect(getAppSettings(n8n).length).toBeGreaterThan(0);
  });
  it("mail exposes a custom management href", () => {
    const mail = getAppTemplate("mail")!;
    expect(getAppManagement(mail)).toEqual({ kind: "custom", href: "/emails" });
  });
  it("an app with no settings has no curated management", () => {
    const kuma = getAppTemplate("uptime-kuma")!;
    expect(getAppManagement(kuma)).toBeNull();
    expect(getAppSettings(kuma)).toEqual([]);
  });
});
