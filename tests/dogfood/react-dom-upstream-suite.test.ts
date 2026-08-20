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
// @ts-expect-error — .mjs dogfood extractor has no declaration file
import { extractReactUpstreamTests } from "./react-upstream-extract.mjs";

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

    // Client and server use separate published CJS graphs. Keeping the server
    // renderer separate is what lets its original tests run without pulling
    // the client renderer's WasmGC graph into the SSR lane.
    expect(pin.implementation.sharedModule).toMatch(/^package\/cjs\//);
    expect(pin.implementation.clientModule).toMatch(/^package\/cjs\//);
    expect(pin.implementation.serverModule).toMatch(/^package\/cjs\/.*browser\.production\.js$/);
    expect(pin.implementation.fizzServerModule).toMatch(/^package\/cjs\/react-dom-server\.browser\.production\.js$/);
    expect(pin.implementation.nodeFizzServerModule).toMatch(/^package\/cjs\/react-dom-server\.node\.production\.js$/);
    expect(pin.implementation.edgeFizzServerModule).toMatch(/^package\/cjs\/react-dom-server\.edge\.production\.js$/);
  });

  it("keeps every non-skipped ReactDOM test reachable in conservative mode", () => {
    const pin = loadReactDomUpstreamSuitePin();
    const extracted = extractReactUpstreamTests({
      root: join(HERE, ".react-upstream-suite"),
      testFiles: pin.testFiles,
      admitAll: false,
      supportedInfrastructure: new Set([
        "needs-react-dom",
        "needs-react-noop",
        "needs-test-utils",
        "needs-act",
        "needs-console-assertions",
        "asserts-on-console",
        "needs-jest-runtime",
        "needs-dom",
        "dev-build-only",
        "needs-feature-flags",
        "needs-scheduler",
        "needs-external-module",
      ]),
    });
    expect(extracted.tests.length + extracted.rejected.length).toBe(2003);
    expect(extracted.tests.length).toBe(2001);
    expect(extracted.rejectionCounts).toEqual({ "upstream-skipped": 2 });
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
    expect(
      report.extraction.clientAdmitted +
        report.extraction.serverAdmitted +
        report.extraction.fizzAdmitted +
        report.extraction.nodeFizzAdmitted +
        report.extraction.edgeFizzAdmitted,
    ).toBe(report.extraction.admitted);
    expect(report.server.extraction.admitted).toBe(report.extraction.serverAdmitted);
    expect(report.server.extraction.selected).toBeGreaterThan(0);
    expect(report.server.results.passed + report.server.results.failed).toBe(report.server.results.scored);
    expect(report.fizz.extraction.admitted).toBe(report.extraction.fizzAdmitted);
    expect(report.fizz.extraction.selected).toBeGreaterThan(0);
    expect(report.fizz.results.passed + report.fizz.results.failed).toBe(report.fizz.results.scored);
    expect(report.nodeFizz.extraction.admitted).toBe(report.extraction.nodeFizzAdmitted);
    expect(report.nodeFizz.extraction.selected).toBeGreaterThan(0);
    expect(report.nodeFizz.results.passed + report.nodeFizz.results.failed).toBe(report.nodeFizz.results.scored);
    expect(report.edgeFizz.extraction.admitted).toBe(report.extraction.edgeFizzAdmitted);
    expect(report.edgeFizz.extraction.selected).toBeGreaterThan(0);
    expect(report.edgeFizz.results.passed + report.edgeFizz.results.failed).toBe(report.edgeFizz.results.scored);

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
