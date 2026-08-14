import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { NPM_COMPAT_UPSTREAM_SOURCES } from "./npm-compat-upstream-sources.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("npm-compat upstream GitHub source pins", () => {
  it("covers every package rendered on npm-compat exactly once", () => {
    const report = JSON.parse(readFileSync(join(HERE, "../../benchmarks/results/npm-compat.json"), "utf-8"));
    const rendered = report.packages ?? report.results ?? report;
    const expected = rendered
      .map((entry: { name: string; version: string }) => `${entry.name}@${entry.version}`)
      .sort();
    const actual = NPM_COMPAT_UPSTREAM_SOURCES.map((entry) => `${entry.name}@${entry.version}`).sort();
    expect(actual).toEqual(expected);
  });

  it("uses immutable commits and valid executable adapters", () => {
    const packageJson = JSON.parse(readFileSync(join(HERE, "../../package.json"), "utf-8"));
    for (const pin of NPM_COMPAT_UPSTREAM_SOURCES) {
      expect(pin.repo).toMatch(/^https:\/\/github\.com\/.+\.git$/);
      expect(pin.tag.length).toBeGreaterThan(0);
      expect(pin.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(packageJson.scripts[pin.compileScript]).toBeTypeOf("string");
      if (pin.inventory) {
        expect(pin.inventory.fileCount).toBeGreaterThan(0);
        expect(pin.inventory.pathSha256).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(pin.suiteScript).toBeTypeOf("string");
      expect(packageJson.scripts[pin.suiteScript]).toBeTypeOf("string");
    }
  });

  it("keeps source checkout caches out of git", () => {
    const gitignore = readFileSync(join(HERE, "../../.gitignore"), "utf-8");
    expect(gitignore).toContain("tests/dogfood/.npm-upstream-suites/");
    expect(existsSync(join(HERE, "npm-compat-upstream-sources.json"))).toBe(true);
  });

  it("makes the merge-only refresh refuse missing adapter results", () => {
    const workflow = readFileSync(join(HERE, "../../.github/workflows/npm-compat-refresh.yml"), "utf-8");
    expect(workflow).toContain("suitePins.filter(entry => entry.suiteScript)");
    expect(workflow).toContain("its unit-test result is absent");
    expect(workflow).toContain("still reports adapter pending");
  });

  it("makes report generation reject configured suites missing from its executable registry", () => {
    const generator = readFileSync(join(HERE, "../../scripts/generate-npm-compat-report.mjs"), "utf-8");
    expect(generator).toContain("UPSTREAM_SUITE_RUNNERS");
    expect(generator).toContain("npm-compat upstream runner registry mismatch");
    expect(generator).toContain("runConfiguredUpstreamSuite(entry.name");
  });
});
