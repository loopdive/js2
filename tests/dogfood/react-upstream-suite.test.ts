import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood setup has no declaration file
import { isReactUpstreamSuiteCheckoutValid, loadReactUpstreamSuitePin } from "./setup-react-upstream-suite.mjs";
// @ts-expect-error — .mjs dogfood environment has no declaration file
import { installReactTestEnvironment } from "./react-test-environment.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Regression floor, not a target. Raise it whenever a compiler fix moves the
// number up; never lower it to make a red run green.
const PASS_FLOOR = 55;
const SCORED_FLOOR = 50;
// Every upstream test that upstream itself does not `.skip` must RUN. Filtering
// one out to keep the pass rate tidy is the failure mode this floor prevents.
const ADMITTED_FLOOR = 270;
// Ceiling, not a floor: batches whose module #3775 makes invalid. Lower it when
// #3775 is fixed; raising it needs a reason.
const INVALID_BATCH_CEILING = 5;

describe("react upstream suite", () => {
  it("provides the browser globals used by the native React oracle", () => {
    const dom = installReactTestEnvironment();
    try {
      expect(document.createElement("div").ownerDocument).toBe(document);
      expect(typeof window.requestAnimationFrame).toBe("function");
      expect((globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT).toBe(
        true,
      );
    } finally {
      dom.cleanup();
    }
  });

  it("rejects a malformed generated source checkout so setup can repair it", () => {
    const root = mkdtempSync(join(tmpdir(), "js2-react-suite-"));
    try {
      mkdirSync(join(root, ".git"));
      expect(isReactUpstreamSuiteCheckoutValid(root, "eaf3e95ca92be7a23d3c9cc8ffd6f199a40be401")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins the source revision matching the published React version", () => {
    const pin = loadReactUpstreamSuitePin();
    expect(pin.tag).toBe("v19.2.6");
    expect(pin.commit).toBe("eaf3e95ca92be7a23d3c9cc8ffd6f199a40be401");
    // React's entire public `packages/react/src/__tests__` directory — the
    // admitted subset is decided by the extractor at run time and reported by
    // reason, not by hand-picking files here.
    expect(pin.testDirectory).toBe("packages/react/src/__tests__");
    expect(pin.testFiles.length).toBeGreaterThanOrEqual(18);
    for (const file of pin.testFiles) expect(file.startsWith(`${pin.testDirectory}/`)).toBe(true);
  });

  const heavy = process.env.DOGFOOD_REACT_UPSTREAM === "1" ? it : it.skip;
  heavy("runs React's own unit tests against compiled Wasm", { timeout: 1_800_000 }, () => {
    const out = execFileSync("npx", ["tsx", join(HERE, "react-upstream-suite.mjs"), "--json"], {
      encoding: "utf-8",
      maxBuffer: 128 * 1024 * 1024,
    });
    const report = JSON.parse(out);

    expect(report.upstreamSuite.commit).toBe("eaf3e95ca92be7a23d3c9cc8ffd6f199a40be401");

    // Compilation is per upstream file and subdivides on validation failure, so
    // "every batch valid" is NOT the contract while #3775 is open — 3 of 36
    // batches currently emit an invalid module. What IS the contract: that
    // number stays bounded (a compiler regression breaking more batches fails
    // here), and every invalid batch is reported with its validator error
    // rather than silently dropping its tests.
    expect(report.compile.batches.length).toBeGreaterThanOrEqual(20);
    expect(report.compile.invalidBatches).toBeLessThanOrEqual(INVALID_BATCH_CEILING);
    for (const batch of report.compile.batches) {
      if (!batch.validates) expect(typeof batch.firstError).toBe("string");
    }

    // The admitted slice must stay a real slice of a real suite: every upstream
    // test is either scored or rejected with a recorded reason, never dropped.
    expect(report.extraction.admitted + report.extraction.rejected).toBe(report.extraction.upstreamTestsSeen);
    expect(report.extraction.rejectedTests.every((t: { reason?: string }) => !!t.reason)).toBe(true);

    // A test that cannot even be reproduced natively says nothing about the
    // compiler, so it is excluded from the score — but it still RAN, and the
    // scored set must stay large enough to be meaningful.
    expect(report.extraction.admitted).toBeGreaterThanOrEqual(ADMITTED_FLOOR);
    expect(report.results.scored).toBeGreaterThanOrEqual(SCORED_FLOOR);
    expect(report.results.passed).toBeGreaterThanOrEqual(PASS_FLOOR);

    // Frontier reporting, not pass-rate fiction: failures stay visible and
    // enumerated rather than being trimmed out of the corpus.
    expect(report.results.passed + report.results.failed).toBe(report.results.scored);
  });
});
