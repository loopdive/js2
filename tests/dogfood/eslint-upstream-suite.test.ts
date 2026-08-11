import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs setup has no declaration file
import { isEslintUpstreamSuiteCheckoutValid, loadEslintUpstreamSuitePin } from "./setup-eslint-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("ESLint v10.0.3 upstream suite", () => {
  it("pins the official source revision and selected original unit", () => {
    const pin = loadEslintUpstreamSuitePin();
    expect(pin.repo).toBe("https://github.com/eslint/eslint.git");
    expect(pin.tag).toBe("v10.0.3");
    expect(pin.commit).toBe("bfce7eaa0ec5d6591fd247b7ff57b51e45fb88a1");
    expect(pin.testFiles).toEqual(["tests/lib/shared/deep-merge-arrays.js"]);
    expect(pin.implementationModule).toBe("lib/shared/deep-merge-arrays.js");
  });

  it("rejects a malformed generated checkout", () => {
    const root = join("/private/tmp", `js2-eslint-suite-invalid-${process.pid}`);
    expect(isEslintUpstreamSuiteCheckoutValid(root, "bfce7eaa0ec5d6591fd247b7ff57b51e45fb88a1")).toBe(false);
  });

  const heavy = process.env.DOGFOOD_ESLINT_UPSTREAM_SUITE === "1" ? it : it.skip;
  heavy("runs all 44 original cases against Wasm and Node", { timeout: 120_000 }, async () => {
    const { runHarness } = await import("./eslint-upstream-suite.mjs");
    const report = await runHarness({ quiet: true });
    expect(report.upstreamSuite.commit).toBe("bfce7eaa0ec5d6591fd247b7ff57b51e45fb88a1");
    expect(report.extraction.upstreamTestsSeen).toBe(44);
    expect(report.extraction.admitted).toBe(44);
    expect(report.extraction.rejected).toBe(0);
    expect(report.results.nativePassed).toBe(44);
    expect(report.results.scored).toBe(44);
    expect(report.results.passed).toBe(44);
    expect(report.results.failed).toBe(0);
    expect(report.results.failedIndices).toEqual([]);
    expect(report.results.runtimeError).toBeNull();
    expect(report.compile.success).toBe(true);
    expect(report.compile.validates).toBe(true);
  });
});
