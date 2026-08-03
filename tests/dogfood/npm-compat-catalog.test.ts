import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood helpers have no declaration files
import { NPM_COMPAT_CATALOG, setupNpmCompatCatalogPackage } from "./npm-compat-catalog.mjs";
// @ts-expect-error — .mjs dogfood helpers have no declaration files
import { runNpmCompatCatalogHarness } from "./npm-compat-catalog-harness.mjs";

const EXPECTED_NAMES = [
  "hono",
  "lodash",
  "axios",
  "react-dom",
  "jsdom",
  "webpack",
  "uuid",
  "typescript",
  "redux",
  "jest",
  "styled-components",
  "moment",
  "stylelint",
  "three",
  "lit",
  "tailwindcss",
];

function reportPackageNames(path: URL): string[] {
  const report = JSON.parse(readFileSync(path, "utf8")) as { packages: Array<{ name: string }> };
  return report.packages.map((entry) => entry.name);
}

describe("npm compatibility package catalog", () => {
  it("pins and verifies every requested published package", () => {
    expect(NPM_COMPAT_CATALOG.map((entry: { name: string }) => entry.name)).toEqual(EXPECTED_NAMES);

    for (const entry of NPM_COMPAT_CATALOG) {
      const setup = setupNpmCompatCatalogPackage(entry.name);
      expect(setup.version).toBe(entry.version);
      expect(setup.pin.shasum).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(setup.entryModulePath)).toBe(entry.expectedEntryMissing !== true);
    }
  });

  it("keeps the canonical report and public mirror in sync", () => {
    const canonical = reportPackageNames(new URL("../../benchmarks/results/npm-compat.json", import.meta.url));
    const publicMirror = reportPackageNames(
      new URL("../../website/public/benchmarks/results/npm-compat.json", import.meta.url),
    );

    expect(canonical).toEqual(publicMirror);
    expect(canonical).toEqual(expect.arrayContaining(EXPECTED_NAMES));
  });

  const selectedPackage = process.env.DOGFOOD_NPM_CATALOG;
  const heavy = selectedPackage ? it : it.skip;
  heavy("records the selected package's bounded compile and validation frontier", { timeout: 240_000 }, async () => {
    expect(EXPECTED_NAMES).toContain(selectedPackage);
    const report = await runNpmCompatCatalogHarness(selectedPackage, { quiet: true });
    expect(report[selectedPackage!]?.version).toBe(
      NPM_COMPAT_CATALOG.find((entry: { name: string }) => entry.name === selectedPackage)?.version,
    );
    expect(typeof report.compile.success).toBe("boolean");
    expect(typeof report.validation.validates).toBe("boolean");
    // (#4127) `diff.runnable === false` is a FACT about this harness (it
    // compiles and validates, it never runs the package), not a property worth
    // asserting on its own — asserting it was how "we never checked" stayed
    // indistinguishable from "we checked and it was fine". What must hold is
    // that the report says so on the record: the correctness axis is present
    // and explicitly `unverified`, with a reason.
    expect(report.diff.runnable).toBe(false);
    expect(report.correctness.status).toBe("unverified");
    expect(report.correctness.reason).toEqual(expect.any(String));
    expect(report.correctness.reason.length).toBeGreaterThan(0);
  });
});
