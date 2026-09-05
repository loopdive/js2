import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runDogfoodScript } from "./run-dogfood-script";
import { compileProject, instantiateLinkedProject } from "../../src/index.ts";

// @ts-expect-error — .mjs dogfood setup has no declaration file
import { loadLitUpstreamSuitePin, setupLitImplementation } from "./setup-lit-upstream-suite.mjs";
// @ts-expect-error — .mjs dogfood harness has no declaration file
import { buildProjectImportPrelude } from "./lit-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Every upstream test that upstream itself does not `.skip` must RUN. Filtering
// one out to keep the pass rate tidy is the failure mode this floor prevents.
const ADMITTED_FLOOR = 580;
// Regression floors, not targets. Raise them whenever a compiler fix moves the
// number up; never lower one to make a red run green. Measured 2026-08-01:
// 3 passed of 16 scored. The 13 failures are real and enumerated — #3979
// (`choose`), #3980 (`range`), #3978 (css-tag, behind an invalid module).
const PASS_FLOOR = 3;
const SCORED_FLOOR = 16;
// Ceiling, not a floor. lit-html's published implementation currently emits an
// INVALID module (#3978), so the tests of every file that imports it never get
// a chance — 478 of them. Lower this as #3978 is fixed; raising it needs a
// reason.
const IMPLEMENTATION_INVALID_TEST_CEILING = 480;

describe("lit upstream suite", () => {
  it("keeps published package imports external for provider caching", () => {
    const source = buildProjectImportPrelude({
      imports: [
        { from: "lit-html/directives/when.js", bindings: [{ imported: "when", local: "choose" }] },
        { from: "lit", bindings: [{ imported: "*", local: "Lit" }] },
        { from: "../test-utils/helpers.js", bindings: [{ imported: "fixture", local: "fixture" }] },
      ],
    });
    expect(source).toContain('import { when as choose } from "lit-html/directives/when.js";');
    expect(source).toContain('import * as Lit from "lit";');
    expect(source).not.toContain("lit-html/directives/when.js is not shipped");
    expect(source).toContain("../test-utils/helpers.js is not shipped by the published package");
  });

  it("compiles a published Lit provider once across test entries", async () => {
    const implementation = setupLitImplementation();
    const projectRoot = join(implementation.root, ".js2wasm-link-test");
    const entry = join(projectRoot, "entry.ts");
    mkdirSync(projectRoot, { recursive: true });
    const cacheDir = mkdtempSync(join(projectRoot, ".cache-"));
    writeFileSync(
      entry,
      'import { isServer } from "lit-html/is-server.js"; export function run(): number { return isServer ? 1 : 0; }\n',
    );
    const options = { allowJs: true, emitWat: false, skipSemanticDiagnostics: true, packageCacheDir: cacheDir };
    const first = await compileProject(entry, options);
    expect(first.linkPlan).toMatchObject({ mode: "separate", compiledProviders: 1, cachedProviders: 0 });
    const linked = await instantiateLinkedProject(first);
    expect(linked.instance.exports.run?.()).toBe(0);

    const second = await compileProject(entry, options);
    expect(second.linkPlan).toMatchObject({ mode: "separate", compiledProviders: 0, cachedProviders: 1 });
  });

  it("pins the source revision matching the published implementation packages", () => {
    const pin = loadLitUpstreamSuitePin();
    expect(pin.tag).toBe("lit@3.3.3");
    expect(pin.commit).toBe("20afabd3c5bfd49fdcdf1b8518e05c7f99a46db6");

    // The `lit` tarball is a four-line barrel with no implementation in it, so
    // the suite deliberately pins the three packages that actually carry lit's
    // code. If this list ever collapses back to `lit`, the suite would be
    // measuring a re-export list again — which is the whole reason #3977 exists.
    expect(pin.implementation.map((entry: { name: string }) => entry.name).sort()).toEqual([
      "@lit/reactive-element",
      "lit-element",
      "lit-html",
    ]);
    for (const entry of pin.implementation) {
      expect(entry.shasum, `${entry.name} must be pinned by sha1`).toMatch(/^[0-9a-f]{40}$/);
    }

    // The ENTIRE src/test tree of all three packages — the runnable subset is
    // decided by the extractor at run time and reported by reason, not by
    // hand-picking files here.
    expect(pin.testFiles.length).toBeGreaterThanOrEqual(58);
    for (const file of pin.testFiles) {
      expect(pin.testDirectories.some((directory: string) => file.startsWith(`${directory}/`))).toBe(true);
    }
  });

  const heavy = process.env.DOGFOOD_LIT_UPSTREAM === "1" ? it : it.skip;
  heavy("runs lit's own unit tests against compiled Wasm", { timeout: 3_600_000 }, async () => {
    const out = await runDogfoodScript(join(HERE, "lit-upstream-suite.mjs"), ["--json"], {
      maxBuffer: 256 * 1024 * 1024,
    });
    const report = JSON.parse(out);

    expect(report.upstreamSuite.commit).toBe("20afabd3c5bfd49fdcdf1b8518e05c7f99a46db6");

    // The admitted slice must stay a real slice of a real suite: every upstream
    // test is either scored or rejected with a recorded reason, never dropped.
    expect(report.extraction.admitted + report.extraction.rejected).toBe(report.extraction.upstreamTestsSeen);
    expect(report.extraction.rejectedTests.every((t: { reason?: string }) => !!t.reason)).toBe(true);
    expect(report.extraction.admitted).toBeGreaterThanOrEqual(ADMITTED_FLOOR);

    // A file whose implementation cannot even produce a valid module must be
    // named, with the validator's own message — never silently absent.
    for (const entry of report.compile.implementationInvalid) {
      expect(typeof entry.file).toBe("string");
      expect(typeof entry.error).toBe("string");
      expect(entry.error.length).toBeGreaterThan(0);
    }
    for (const batch of report.compile.batches) {
      if (!batch.validates) expect(typeof batch.firstError).toBe("string");
    }
    // Same for a bundle that could not be built at all.
    for (const entry of report.compile.bundleFailures) expect(typeof entry.error).toBe("string");

    // The regression gate on #3978. This is a CEILING: today most of lit's
    // corpus is behind an invalid implementation module, and the number must
    // not grow.
    expect(report.summary.implementationInvalidTests).toBeLessThanOrEqual(IMPLEMENTATION_INVALID_TEST_CEILING);

    // A test the NATIVE oracle also fails says nothing about the compiler, so
    // it is excluded from the score — but the scored set must stay large
    // enough to be meaningful, and the pass count must not regress.
    expect(report.results.scored).toBeGreaterThanOrEqual(SCORED_FLOOR);
    expect(report.results.passed).toBeGreaterThanOrEqual(PASS_FLOOR);

    // Frontier reporting, not pass-rate fiction: failures stay visible and
    // enumerated rather than being trimmed out of the corpus.
    expect(report.results.passed + report.results.failed).toBe(report.results.scored);
  });
});
