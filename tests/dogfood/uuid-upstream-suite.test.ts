import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDogfoodScript } from "./run-dogfood-script";

// @ts-expect-error — .mjs setup has no declaration file
import { isUuidUpstreamSuiteCheckoutValid, loadUuidUpstreamSuitePin } from "./setup-uuid-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("uuid v14.0.1 upstream suite", () => {
  it("pins the official source revision and complete test inventory", () => {
    const pin = loadUuidUpstreamSuitePin();
    expect(pin.repo).toBe("https://github.com/uuidjs/uuid.git");
    expect(pin.tag).toBe("v14.0.1");
    expect(pin.commit).toBe("70177807e9229dfacde2038dc1e722f1828f358a");
    expect(pin.testFiles).toHaveLength(10);
    expect(pin.helperFiles).toEqual(["src/test/test_constants.ts"]);
    for (const file of pin.testFiles) expect(file.startsWith("src/test/")).toBe(true);
  });

  it("rejects a malformed generated checkout", () => {
    const root = join("/private/tmp", `js2-uuid-suite-invalid-${process.pid}`);
    expect(isUuidUpstreamSuiteCheckoutValid(root, "70177807e9229dfacde2038dc1e722f1828f358a")).toBe(false);
  });

  // The full suite clones the pinned source and compiles ten Wasm modules. It
  // is opt-in for normal Vitest runs; the canonical command is
  // `pnpm run dogfood:uuid-upstream-suite`.
  const heavy = process.env.DOGFOOD_UUID_UPSTREAM_SUITE === "1" ? it : it.skip;
  heavy("runs all original UUID tests against Wasm and Node", { timeout: 600_000 }, async () => {
    const out = await runDogfoodScript(join(HERE, "uuid-upstream-suite.mjs"), ["--json"], {
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=1536" },
    });
    const report = JSON.parse(out);
    expect(report.upstreamSuite.commit).toBe("70177807e9229dfacde2038dc1e722f1828f358a");
    expect(report.extraction.upstreamTestsSeen).toBe(75);
    expect(report.extraction.admitted).toBe(75);
    expect(report.extraction.rejected).toBe(0);
    expect(report.results.nativePassed).toBe(75);
    expect(report.results.scored).toBe(75);
    expect(report.results.passed).toBeGreaterThanOrEqual(3);
    expect(report.results.passed + report.results.failed).toBe(report.results.scored);
    expect(report.compile.files).toHaveLength(10);
  });
});
