// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { NPM_COMPAT_CATALOG_NAMES } from "./dogfood/npm-compat-catalog.mjs";
import {
  buildNpmCompatPerfDriver,
  NPM_COMPAT_PERF_PACKAGE_NAMES,
  NPM_COMPAT_PERF_SPECS,
} from "./dogfood/npm-compat-perf-specs.mjs";

const LEGACY_PACKAGES = ["acorn", "marked", "clsx", "cookie", "eslint", "prettier", "react"];
const ROOT = resolve(import.meta.dirname, "..");

describe("npm compatibility performance coverage", () => {
  it("has one workload spec for every curated package", () => {
    const expected = new Set([...LEGACY_PACKAGES, ...NPM_COMPAT_CATALOG_NAMES]);
    expect(new Set(NPM_COMPAT_PERF_PACKAGE_NAMES)).toEqual(expected);
  });

  it("imports every legacy setup used by the generic performance runner", () => {
    const generator = readFileSync(resolve(ROOT, "scripts/generate-npm-compat-report.mjs"), "utf-8");

    for (const setupName of ["setupMarked", "setupEslint", "setupPrettier", "setupReact"]) {
      expect(generator, setupName).toMatch(new RegExp(`import \\{ ${setupName} \\} from `));
      expect(generator, setupName).toContain(`setupFactory: ${setupName}`);
    }
  });

  it("gives every package static, host-dynamic, and standalone-dynamic driver shapes", () => {
    for (const [name, spec] of Object.entries(NPM_COMPAT_PERF_SPECS)) {
      expect(spec.staticInput, name).toEqual(expect.any(String));
      expect(spec.dynamicInput, name).toEqual(expect.any(Function));
      expect(spec.nativeOperation, name).toEqual(expect.any(Function));
      expect(buildNpmCompatPerfDriver(spec, "./package/index.js", "js-host"), name).toContain(
        "export function __npmCompatPerf",
      );
      expect(buildNpmCompatPerfDriver(spec, "./package/index.js", "standalone-static"), name).toContain(
        "export function __npmCompatStandaloneBenchmark",
      );
      expect(buildNpmCompatPerfDriver(spec, "./package/index.js", "standalone-dynamic"), name).toContain(
        "export function __npmCompatStandaloneDynamic",
      );
    }
  });
});
