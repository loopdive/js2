import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @ts-expect-error — .mjs dogfood setup has no declaration file
import { loadReactDomUpstreamSuitePin } from "./setup-react-dom-upstream-suite.mjs";
// @ts-expect-error — .mjs dogfood setup has no declaration file
import { loadReactUpstreamSuitePin } from "./setup-react-upstream-suite.mjs";
// @ts-expect-error — .mjs dogfood harness has no declaration file
import { isExpectedLateJsdomHostError } from "./react-dom-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Every upstream test that upstream itself does not `.skip` must RUN. Filtering
// one out to keep a number tidy is the failure mode this floor prevents.
const ADMITTED_FLOOR = 1200;

describe("react-dom upstream suite", () => {
  it("quarantines only the known late jsdom removal exception", () => {
    const expected = {
      name: "NotFoundError",
      message: "The node to be removed is not a child of this node.",
    };
    expect(isExpectedLateJsdomHostError(expected)).toBe(true);
    expect(isExpectedLateJsdomHostError({ ...expected, message: "different DOM failure" })).toBe(false);
    expect(isExpectedLateJsdomHostError({ name: "TypeError", message: expected.message })).toBe(false);
  });

  it("shares one verified revision with the react suite", () => {
    const pin = loadReactDomUpstreamSuitePin();
    const reactPin = loadReactUpstreamSuitePin();

    // react-dom is versioned in lockstep with react in the SAME monorepo. If
    // these ever diverge the two suites would be testing different revisions of
    // one repository while both claiming to be pinned.
    expect(pin.commit).toBe(reactPin.commit);
    expect(pin.tag).toBe(reactPin.tag);
    expect(pin.commit).toBe("eaf3e95ca92be7a23d3c9cc8ffd6f199a40be401");

    expect(pin.testDirectory).toBe("packages/react-dom/src/__tests__");
    expect(pin.testFiles.length).toBeGreaterThanOrEqual(115);
    for (const file of pin.testFiles) expect(file.startsWith(`${pin.testDirectory}/`)).toBe(true);

    // The client implementation uses TWO published CJS modules, not the package entry.
    expect(pin.implementation.sharedModule).toMatch(/^package\/cjs\//);
    expect(pin.implementation.clientModule).toMatch(/^package\/cjs\//);
    expect(pin.implementation.serverModule).toBeUndefined();
  });

  const heavy = process.env.DOGFOOD_REACT_DOM_UPSTREAM === "1" ? it : it.skip;
  heavy("runs react-dom's own unit tests against compiled Wasm", { timeout: 3_600_000 }, () => {
    const out = execFileSync("npx", ["tsx", join(HERE, "react-dom-upstream-suite.mjs"), "--json"], {
      encoding: "utf-8",
      maxBuffer: 256 * 1024 * 1024,
    });
    const report = JSON.parse(out);

    expect(report.upstreamSuite.commit).toBe("eaf3e95ca92be7a23d3c9cc8ffd6f199a40be401");

    // Every upstream test is either scored or rejected with a recorded reason,
    // never dropped.
    expect(report.extraction.admitted + report.extraction.rejected).toBe(report.extraction.upstreamTestsSeen);
    expect(report.extraction.rejectedTests.every((t: { reason?: string }) => !!t.reason)).toBe(true);
    expect(report.extraction.admitted).toBeGreaterThanOrEqual(ADMITTED_FLOOR);
    expect(report.extraction.rejectionCounts["needs-react-dom-server"]).toBeGreaterThan(0);

    // The load-bearing assertion while #3982 is open: if the implementation
    // cannot compile, that must be REPORTED with the compiler's own message —
    // never left as a silent zero. Deliberately not `toBe(false)`: this passes
    // both today (invalid, reported) and after the fix (valid), and a pass
    // FLOOR is added at that point instead.
    if (report.compile.implementationInvalid !== null) {
      expect(typeof report.compile.implementationInvalid.error).toBe("string");
      expect(report.compile.implementationInvalid.error.length).toBeGreaterThan(0);
      expect(report.summary.implementationError).toBe(report.compile.implementationInvalid.error);
      expect(report.results.scored).toBe(0);
      expect(report.results.failed).toBe(0);
      expect(report.results.implementationInvalidTests).toBe(report.extraction.selected);
    }
    for (const batch of report.compile.batches) {
      if (!batch.validates) expect(typeof batch.firstError).toBe("string");
    }

    // Frontier reporting, not pass-rate fiction.
    expect(report.results.passed + report.results.failed).toBe(report.results.scored);
    expect(report.results.nativeHostErrors.every((error: object) => isExpectedLateJsdomHostError(error))).toBe(true);
    expect(report.summary.nativeHostErrors).toBe(report.results.nativeHostErrors.length);
  });
});
