import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { generateEmbeddedModule } from "../../../scripts/embed-catalog";
import { EMBEDDED_CATALOG } from "./catalog-embedded";

const HERE = dirname(fileURLToPath(import.meta.url));
const EMBEDDED_PATH = join(HERE, "catalog-embedded.ts");

describe("catalog-embedded", () => {
  it("is in sync with the catalog tree (run `bun run embed:catalog` if this fails)", () => {
    const current = readFileSync(EMBEDDED_PATH, "utf-8");
    expect(current).toBe(generateEmbeddedModule());
  });

  it("every bundled module has a base64 manifest that decodes to valid JSON", () => {
    for (const [module, entry] of Object.entries(EMBEDDED_CATALOG)) {
      const json = Buffer.from(entry.manifest, "base64").toString("utf-8");
      const parsed = JSON.parse(json);
      expect(parsed.module, `${module} manifest.module`).toBe(module);
    }
  });
});
