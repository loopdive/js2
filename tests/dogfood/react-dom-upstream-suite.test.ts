import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { compileProject, instantiateLinkedProject } from "../../src/index.ts";

// @ts-expect-error — .mjs dogfood setup has no declaration file
import { loadReactDomUpstreamSuitePin, setupReactDomImplementation } from "./setup-react-dom-upstream-suite.mjs";
// @ts-expect-error — .mjs dogfood setup has no declaration file
import { loadReactUpstreamSuitePin } from "./setup-react-upstream-suite.mjs";
// @ts-expect-error — .mjs dogfood harness has no declaration file
import {
  DEFAULT_PROJECT_BATCH_CHARS,
  DEFAULT_PROJECT_BATCH_TESTS,
  createNativeRequire,
  buildProjectFiles,
  buildServerProjectFiles,
  installNativeHostErrorBoundary,
  isExpectedLateJsdomHostError,
  partitionProjectTests,
  partitionReactDomTestsForBuild,
  projectCompileConcurrency,
  reactDomTestSetup,
} from "./react-dom-upstream-suite.mjs";
// @ts-expect-error — .mjs dogfood extractor has no declaration file
import { extractReactUpstreamTests } from "./react-upstream-extract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

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

  // (#4604 S7) A watchdog-abandoned test body can assert inside a late
  // scheduler/timer callback, which surfaces as an uncaughtException. The
  // boundary must RECORD it — crashing lost run 796's entire react-dom
  // measurement to one stray `toBe`. The listener is invoked directly (not via
  // process.emit) so the test never trips vitest's own uncaught handler.
  it("records unexpected late host errors instead of crashing the run", () => {
    const before = process.listeners("uncaughtException").length;
    const captured: Array<Record<string, unknown>> = [];
    const dispose = installNativeHostErrorBoundary(captured);
    const listeners = process.listeners("uncaughtException");
    expect(listeners.length).toBe(before + 1);
    const boundary = listeners[listeners.length - 1] as (error: unknown) => void;

    boundary(new Error("expected Hello toBe Goodbye"));
    const lateJsdom = new Error("The node to be removed is not a child of this node.");
    lateJsdom.name = "NotFoundError";
    boundary(lateJsdom);

    dispose();
    expect(process.listeners("uncaughtException").length).toBe(before);
    expect(captured).toHaveLength(2);
    expect(captured[0]).toMatchObject({
      message: "expected Hello toBe Goodbye",
      expectedLateJsdomHostError: false,
    });
    expect(captured[1]).toMatchObject({
      name: "NotFoundError",
      expectedLateJsdomHostError: true,
    });
  });

  it("rejects exact development-only React API calls before a production run", () => {
    const ordinary = {
      id: "ordinary",
      file: "ordinary.js",
      fullName: "ordinary",
      prelude: 'const note = "React.captureOwnerStack()";',
      body: "React.createElement('div');",
    };
    const developmentOnly = {
      id: "owner-stack",
      file: "ReactDOMHydrationDiff-test.js",
      fullName: "owner stack",
      prelude: "console.error = () => React.captureOwnerStack();",
      body: "render();",
    };

    expect(partitionReactDomTestsForBuild([ordinary, developmentOnly], "production")).toEqual({
      tests: [ordinary],
      rejected: [
        {
          id: "owner-stack",
          file: "ReactDOMHydrationDiff-test.js",
          fullName: "owner stack",
          reason: "requires-development-react-api",
        },
      ],
    });
    expect(partitionReactDomTestsForBuild([ordinary, developmentOnly], "development")).toEqual({
      tests: [ordinary, developmentOnly],
      rejected: [],
    });
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

  it("can select the matching development implementation graph", () => {
    const implementation = setupReactDomImplementation({ build: "development" });
    expect(implementation.build).toBe("development");
    expect(implementation.sharedPath).toMatch(/react-dom\.development\.js$/);
    expect(implementation.clientPath).toMatch(/react-dom-client\.development\.js$/);
    expect(implementation.serverPath).toMatch(/react-dom-server-legacy\.browser\.development\.js$/);
    expect(implementation.fizzServerPath).toMatch(/react-dom-server\.browser\.development\.js$/);
    expect(implementation.nodeFizzServerPath).toMatch(/react-dom-server\.node\.development\.js$/);
    expect(implementation.edgeFizzServerPath).toMatch(/react-dom-server\.edge\.development\.js$/);
    expect(implementation.moduleNames.fizzServer).toBe("package/cjs/react-dom-server.browser.development.js");
  });

  it("uses the pinned cross-package singletons in the native oracle", () => {
    const previous = globalThis.__js2ReactUpstreamInfrastructure;
    const react = { version: "pinned-react" };
    const reactDom = { version: "pinned-react-dom" };
    const reactDomClient = { createRoot: () => null };
    const internalTestUtils = { act: () => Promise.resolve() };
    const infrastructure = { react, reactDom, reactDomClient, internalTestUtils };
    globalThis.__js2ReactUpstreamInfrastructure = infrastructure;
    try {
      const nativeRequire = createNativeRequire();
      expect(nativeRequire("react")).toBe(react);
      expect(nativeRequire("react-dom")).toBe(reactDom);
      expect(nativeRequire("react-dom/client")).toBe(reactDomClient);
      expect(nativeRequire("internal-test-utils")).toBe(internalTestUtils);
      expect(nativeRequire("react-dom/test-utils")).toEqual({ act: internalTestUtils.act });
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "__js2ReactUpstreamInfrastructure");
      else globalThis.__js2ReactUpstreamInfrastructure = previous;
    }
  });

  it("partitions project entries without dropping tests or mixing files", () => {
    const make = (file: string, index: number, size: number) => ({
      file,
      id: `${file}-${index}`,
      prelude: "p".repeat(size),
      body: "",
    });
    const input = [make("a.js", 0, 7), make("a.js", 1, 7), make("b.js", 0, 7)];
    const batches = partitionProjectTests(input, 15);

    expect(batches.map(({ file, tests }) => [file, tests.map(({ id }) => id)])).toEqual([
      ["a.js", ["a.js-0"]],
      ["a.js", ["a.js-1"]],
      ["b.js", ["b.js-0"]],
    ]);
    expect(batches.flatMap(({ tests }) => tests).map(({ id }) => id)).toEqual(input.map(({ id }) => id));
  });

  it("keeps default linked-root adapters below the measured watchdog-safe size", () => {
    const make = (index: number) => ({
      file: "large.js",
      id: `large-${index}`,
      prelude: "p".repeat(210_000),
      body: "",
    });
    const batches = partitionProjectTests([make(0), make(1)]);

    expect(DEFAULT_PROJECT_BATCH_CHARS).toBe(400_000);
    expect(batches.map(({ tests }) => tests.map(({ id }) => id))).toEqual([["large-0"], ["large-1"]]);

    const many = Array.from({ length: 33 }, (_, index) => ({
      file: "many.js",
      id: `many-${index}`,
      prelude: "",
      body: "",
    }));
    expect(DEFAULT_PROJECT_BATCH_TESTS).toBe(32);
    expect(partitionProjectTests(many).map(({ tests }) => tests.length)).toEqual([32, 1]);
  });

  it("keeps the project compile pool bounded and deterministic", () => {
    expect(projectCompileConcurrency(0, "4")).toBe(0);
    expect(projectCompileConcurrency(3, "1")).toBe(1);
    expect(projectCompileConcurrency(3, "4")).toBe(3);
    expect(projectCompileConcurrency(3, "not-a-number")).toBe(2);
  });

  it("does not shadow upstream act functions or read a test-owned document early", () => {
    const setup = reactDomTestSetup(
      ["let React;", "let document;", "async function act(callback) { return callback(); }"].join("\n"),
      "act(() => document.body);",
      { server: true, fizz: true },
    );
    expect(setup).toContain("document.body.textContent");
    expect(setup).not.toContain("var act = async function");
    expect(setup).not.toContain("act = async function");
    expect(setup).toContain('typeof document !== "undefined"');
  });

  it("binds the native oracle to host React singletons instead of uninitialized carriers", () => {
    const setup = reactDomTestSetup(
      "let React; let ReactDOM; let ReactDOMClient; let InnerReactDOM; let act;",
      "ReactDOM.flushSync(() => {}); InnerReactDOM.flushSync(() => {}); act(() => {});",
      { nativeHost: true },
    );
    expect(setup).toContain("React = __js2ReactInfra().react;");
    expect(setup).toContain("ReactDOM = __js2ReactInfra().reactDom;");
    expect(setup).toContain("ReactDOMClient = __js2ReactInfra().reactDomClient;");
    expect(setup).toContain("InnerReactDOM = __js2ReactInfra().reactDom;");
    expect(setup).toContain("act = __js2ReactInfra().internalTestUtils.act;");
    expect(setup).not.toContain("__REACTDOM_SHARED__.flushSync");
  });

  it("keeps server and Fizz batches in isolated project modules", () => {
    const test = {
      id: "serverTest",
      file: "ReactDOMServer-test.js",
      fullName: "server test",
      prelude: "",
      body: "expect(ReactDOMServer.renderToString(React.createElement('div'))).toBe('<div></div>');",
      isAsync: false,
    };
    const legacy = buildServerProjectFiles({
      reactSource: "exports.createElement = function () {};",
      sharedSource: "exports.flushSync = function (callback) { return callback(); };",
      serverSource: "exports.renderToString = function () { return '<div></div>'; };",
      tests: [test],
    });
    expect(Object.keys(legacy)).toContain("node_modules/react-dom-server/index.ts");
    expect(Object.keys(legacy)).toContain("node_modules/react-dom-shared/index.ts");
    expect(legacy["entry.ts"]).toContain('import { __serverExports } from "react-dom-server";');
    expect(legacy["entry.ts"]).toContain("export function upstreamTestCount() { return 1; }");
    expect(legacy["node_modules/react-dom-server/index.ts"]).toContain("__serverExports");

    const fizz = buildServerProjectFiles({
      reactSource: "exports.createElement = function () {};",
      sharedSource: "exports.flushSync = function (callback) { return callback(); };",
      serverSource: "exports.unused = true;",
      fizzSource: "exports.renderToReadableStream = function () {};",
      tests: [test],
      fizzPlatform: "node",
    });
    expect(Object.keys(fizz)).toContain("node_modules/react-dom-fizz/index.ts");
    expect(fizz["entry.ts"]).toContain('import { __fizzExports } from "react-dom-fizz";');
    expect(fizz["entry.ts"]).toContain("__REACTDOM_FIZZ__");
  });

  it("models the client implementation as cacheable npm provider packages", () => {
    const files = buildProjectFiles({
      reactSource: "exports.createElement = function () {};",
      sharedSource: "exports.flushSync = function (callback) { return callback(); };",
      clientSource: "exports.createRoot = function () {};",
      tests: [],
    });
    expect(files["entry.ts"]).toContain('from "react-dom-client"');
    expect(files["node_modules/react-dom-client/index.ts"]).toContain('from "react-dom-shared"');
    expect(files["node_modules/react-dom-client/package.json"]).toContain('"exports":"./index.ts"');
    expect(Object.keys(files).some((name) => /^react\.ts$|^client\.ts$/.test(name))).toBe(false);
  });

  it("compiles generated React DOM providers once across test entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-react-dom-packages-"));
    const cacheDir = join(root, ".cache");
    const files = buildProjectFiles({
      reactSource: "exports.createElement = function () { return 1; };",
      sharedSource: "exports.flushSync = function (callback) { return callback(); };",
      clientSource: "exports.createRoot = function () { return 1; };",
      tests: [],
    });
    for (const [relativePath, source] of Object.entries(files)) {
      const target = join(root, relativePath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    const options = { allowJs: true, emitWat: false, skipSemanticDiagnostics: true, packageCacheDir: cacheDir };
    const first = await compileProject(join(root, "entry.ts"), options);
    expect(first.linkPlan).toMatchObject({ mode: "separate", compiledProviders: 4, cachedProviders: 0 });
    expect(first.linkedModules?.map((artifact) => artifact.packageName).sort()).toEqual([
      "react",
      "react-dom-client",
      "react-dom-shared",
      "scheduler",
    ]);
    const linked = await instantiateLinkedProject(first);
    expect(linked.instance.exports.upstreamTestCount?.()).toBe(0);

    const second = await compileProject(join(root, "entry.ts"), options);
    expect(second.linkPlan).toMatchObject({ mode: "separate", compiledProviders: 0, cachedProviders: 4 });
  });

  // The pinned React checkout is a generated, network-backed fixture. Keep the
  // lightweight unit run honest in a fresh clone: the extraction floor is
  // explicitly unavailable until that fixture is acquired, while the heavy
  // suite still clones and verifies it before running.
  const extractionFixture = join(HERE, ".react-upstream-suite", loadReactDomUpstreamSuitePin().testFiles[0]);
  const extractionTest = existsSync(extractionFixture) ? it : it.skip;
  extractionTest("keeps every non-skipped ReactDOM test reachable in conservative mode", () => {
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

    const production = partitionReactDomTestsForBuild(extracted.tests, "production");
    expect(production.tests).toHaveLength(1923);
    expect(production.rejected).toHaveLength(78);
    expect(
      production.rejected.every(({ reason }: { reason: string }) => reason === "requires-development-react-api"),
    ).toBe(true);
    expect(partitionReactDomTestsForBuild(extracted.tests, "development")).toEqual({
      tests: extracted.tests,
      rejected: [],
    });
  });

  const heavy = process.env.DOGFOOD_REACT_DOM_UPSTREAM === "1" ? it : it.skip;
  heavy("runs react-dom's own unit tests against compiled Wasm", { timeout: 3_600_000 }, async () => {
    const { stdout } = await execFileAsync(
      "node",
      ["--import", "tsx", join(HERE, "react-dom-upstream-suite.mjs"), "--json"],
      {
        encoding: "utf-8",
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    const report = JSON.parse(stdout);

    expect(report.upstreamSuite.commit).toBe("eaf3e95ca92be7a23d3c9cc8ffd6f199a40be401");
    // The client corpus is intentionally compiled as multiple project entries;
    // a single 1,261-test entry can hit the worker deadline before any test
    // executes. Every batch remains in the report and contributes its own
    // validation/result rows.
    expect(report.compile.batches.length).toBeGreaterThan(1);
    expect(report.summary.implementationInvalid).toBe(false);

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
