// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6712 — exact Test262 manifest discovery must preserve the original selected
 * identities, including an Intl path omitted by the default category walk.
 * These controls are intentionally filesystem-only: they never start a
 * compiler worker or turn a selection check into a conformance claim.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import {
  parseTest262ExactManifest,
  readTest262ExactManifest,
  sha256Test262ExactManifestFile,
} from "../scripts/test262-exact-manifest.mjs";
import {
  evaluateTest262Completeness,
  TEST262_COMPLETION_MANIFEST_SCHEMA,
} from "../scripts/validate-test262-completeness.mjs";
import { discoverFixtureGraph, hasSelfModuleImport } from "../scripts/test262-fixture-graph.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const RUNNER = resolve(ROOT, "scripts/run-test262-vitest.sh");
const FULL_MANIFEST = resolve(ROOT, "scripts/test262-es2015-11778-manifest.txt");
const EDITION_INDEX = resolve(ROOT, "website/public/benchmarks/results/test262-file-editions.json");
const HISTORICAL_ES2015_PATHS_SHA256 = "f2fdd4e4544a44608f0b53d89d343526cfa9c9044ca263e860da949dc1a2f59f";
const CANONICAL_SHA256 = "632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360";

const selectionEnv = ["TEST262_EXACT_MANIFEST_FILE", "TEST262_PATH_FILTER", "TEST262_PATH_FILTER_FILE"] as const;
const originalEnv = new Map<string, string | undefined>();
for (const key of selectionEnv) originalEnv.set(key, process.env[key]);

type EditionIndex = {
  editions: string[];
  files: Record<string, number>;
};

function pathsForEdition(index: EditionIndex, edition: string): string[] {
  const editionIndex = index.editions.indexOf(edition);
  if (editionIndex < 0) throw new Error(`Edition index is missing ${edition}`);
  return Object.entries(index.files)
    .filter(([, value]) => value === editionIndex)
    .map(([path]) => `test/${path}`)
    .sort();
}

function strippedPathSetSha256(paths: readonly string[]): string {
  const stripped =
    paths
      .map((path) => {
        if (!path.startsWith("test/")) throw new Error(`Expected canonical Test262 path: ${path}`);
        return path.slice("test/".length);
      })
      .sort()
      .join("\n") + "\n";
  return createHash("sha256").update(stripped).digest("hex");
}

function unsetSelectionEnv(key: (typeof selectionEnv)[number]) {
  Reflect.deleteProperty(process.env, key);
}

// `test262-runner` is intentionally large. Prime it once during collection
// with a known unfiltered environment, so individual discovery tests keep the
// normal 35s test budget without weakening its module-level legacy filter
// cache. Exact selection itself is read fresh on every discovery call.
for (const key of selectionEnv) unsetSelectionEnv(key);
const runner = await import("./test262-runner.js");

afterEach(() => {
  for (const key of selectionEnv) {
    const value = originalEnv.get(key);
    if (value === undefined) unsetSelectionEnv(key);
    else process.env[key] = value;
  }
});

type CorpusFixture = {
  cleanup: () => void;
  corpusRoot: string;
  intl: string;
  manifest: string;
  namespaceFixtureEntry: string;
  namespaceSelfImport: string;
  ordinary: string;
};

function writeCorpusFile(corpusRoot: string, relPath: string, source = "/* Test262 fixture */\n") {
  const file = join(corpusRoot, "test", ...relPath.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
  return file;
}

function makeCorpusFixture(): CorpusFixture {
  const directory = mkdtempSync(join(tmpdir(), "js2-test262-exact-manifest-"));
  const realCorpus = join(directory, "corpus-real");
  const corpusRoot = join(directory, "corpus-link");
  mkdirSync(join(realCorpus, "test"), { recursive: true });
  symlinkSync(realCorpus, corpusRoot, "dir");

  const ordinary = writeCorpusFile(realCorpus, "language/expressions/ordinary.js");
  const intl = writeCorpusFile(realCorpus, "intl402/Locale/ordinary.js");
  writeCorpusFile(realCorpus, "language/expressions/helper_FIXTURE.js");
  writeCorpusFile(realCorpus, "staging/proposal.js");
  writeCorpusFile(realCorpus, "annexB/language/function-code/function-redeclaration-block.js");
  writeCorpusFile(realCorpus, "language/import/import-defer/deferred.js");
  const namespaceSelfImport = writeCorpusFile(
    realCorpus,
    "language/module-code/namespace/self.js",
    'import * as self from "./self.js"; export { self };\n',
  );
  const namespaceFixtureEntry = writeCorpusFile(
    realCorpus,
    "language/module-code/namespace/with-fixture.js",
    'import "./helper_FIXTURE.js";\n',
  );
  writeCorpusFile(realCorpus, "language/module-code/namespace/helper_FIXTURE.js", "export const fixture = 1;\n");
  mkdirSync(join(realCorpus, "test", "language", "expressions", "not-a-file.js"), { recursive: true });
  const outside = join(directory, "outside.js");
  writeFileSync(outside, "/* outside corpus */\n");
  mkdirSync(join(realCorpus, "test", "intl402", "Locale"), { recursive: true });
  symlinkSync(outside, join(realCorpus, "test", "intl402", "Locale", "escape.js"));

  const manifest = join(directory, "selection.txt");
  writeFileSync(manifest, "test/language/expressions/ordinary.js\ntest/intl402/Locale/ordinary.js\n");
  return {
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
    corpusRoot,
    intl,
    manifest,
    namespaceFixtureEntry,
    namespaceSelfImport,
    ordinary,
  };
}

function verdict(file: string) {
  return JSON.stringify({
    file,
    category: file.startsWith("test/intl402/") ? "intl402" : "language/expressions",
    status: "pass",
  });
}

function wrapperSnapshotHash(manifestPath: string): string {
  // Execute the exact bridge declared by the maintained shell runner, rather
  // than reimplementing its Node invocation in this test. This catches syntax
  // errors in the wrapper's dynamic-import path before an expensive build.
  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        'MAIN_DIR="$1"',
        'eval "$(sed -n \'/^exact_manifest_sha256() {/,/^}/p\' \"$MAIN_DIR/scripts/run-test262-vitest.sh\")"',
        'exact_manifest_sha256 "$2"',
      ].join("\n"),
      "bash",
      ROOT,
      manifestPath,
    ],
    { encoding: "utf8" },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function wrapperSnapshotIsIntact(manifestPath: string, expectedSha256: string): boolean {
  // Invoke the production hash and integrity functions together. The shell
  // intentionally permits a non-zero result here: false is the guard's
  // fail-closed answer after a snapshot mutation.
  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "set -uo pipefail",
        'MAIN_DIR="$1"',
        'eval "$(sed -n \'/^exact_manifest_sha256() {/,/^}/p\' \"$MAIN_DIR/scripts/run-test262-vitest.sh\")"',
        'eval "$(sed -n \'/^exact_manifest_snapshot_is_intact() {/,/^}/p\' \"$MAIN_DIR/scripts/run-test262-vitest.sh\")"',
        'TEST262_EXACT_MANIFEST_FILE="$2"',
        'EXACT_MANIFEST_SNAPSHOT_SHA256="$3"',
        "exact_manifest_snapshot_is_intact",
      ].join("\n"),
      "bash",
      ROOT,
      manifestPath,
      expectedSha256,
    ],
    { encoding: "utf8" },
  );
  expect(result.stderr).toBe("");
  expect(result.status === 0 || result.status === 1).toBe(true);
  return result.status === 0;
}

function completionManifest(
  registeredPaths: string[],
  canonicalVerdicts: number,
  callbacksSettled = registeredPaths.length,
  officialExclusions: string[] = [],
) {
  return {
    schema: TEST262_COMPLETION_MANIFEST_SCHEMA,
    runTimestamp: "6712-control",
    chunkIndex: 0,
    chunkTotal: 1,
    target: "standalone",
    registeredTests: registeredPaths.length,
    registeredPaths,
    recordedRows: canonicalVerdicts,
    canonicalVerdicts,
    exclusions: {
      proposal: { count: 0, paths: [] },
      official: { count: officialExclusions.length, paths: officialExclusions },
    },
    callbacksStarted: registeredPaths.length,
    callbacksSettled,
    allCallbacksSettled: callbacksSettled === registeredPaths.length,
  };
}

describe("#6712 exact manifest helper", () => {
  it("accepts a normal final newline and resolves a symlinked corpus root without changing identities", () => {
    const fixture = makeCorpusFixture();
    try {
      const entries = readTest262ExactManifest(fixture.manifest, { test262Root: fixture.corpusRoot });
      expect(entries.map((entry) => entry.relPath)).toEqual([
        "test/language/expressions/ordinary.js",
        "test/intl402/Locale/ordinary.js",
      ]);
      expect(entries[0]!.filePath).toBe(realpathSync(fixture.ordinary));
      expect(entries[1]!.filePath).toBe(realpathSync(fixture.intl));
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects malformed, duplicate, missing, fixture, non-file, and escaping entries", () => {
    const fixture = makeCorpusFixture();
    try {
      const cases: Array<[string, string, RegExp]> = [
        ["empty", "", /at least one path/],
        [
          "interior blank",
          "test/language/expressions/ordinary.js\n\ntest/intl402/Locale/ordinary.js\n",
          /line 2 is empty/,
        ],
        ["whitespace", "test/language/expressions/ordinary.js \n", /contains whitespace/],
        ["missing prefix", "intl402/Locale/ordinary.js\n", /must start with test/],
        ["traversal", "test/intl402/../Locale/ordinary.js\n", /canonical corpus-relative/],
        ["non JavaScript", "test/language/expressions/ordinary.txt\n", /not a JavaScript test/],
        ["fixture", "test/language/expressions/helper_FIXTURE.js\n", /fixture-only/],
        ["duplicate", "test/language/expressions/ordinary.js\ntest/language/expressions/ordinary.js\n", /duplicates/],
        ["missing file", "test/language/expressions/missing.js\n", /does not resolve/],
        ["non file", "test/language/expressions/not-a-file.js\n", /not a regular file/],
        ["symlink escape", "test/intl402/Locale/escape.js\n", /escapes the Test262 test root/],
      ];
      for (const [name, text, expected] of cases) {
        writeFileSync(fixture.manifest, text);
        expect(() => readTest262ExactManifest(fixture.manifest, { test262Root: fixture.corpusRoot }), name).toThrow(
          expected,
        );
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("executes the wrapper hash bridge and detects a changed manifest snapshot", () => {
    const fixture = makeCorpusFixture();
    try {
      const before = wrapperSnapshotHash(fixture.manifest);
      expect(before).toBe(sha256Test262ExactManifestFile(fixture.manifest));
      expect(wrapperSnapshotIsIntact(fixture.manifest, before)).toBe(true);
      writeFileSync(fixture.manifest, "test/language/expressions/ordinary.js\n");
      expect(wrapperSnapshotHash(fixture.manifest)).not.toBe(before);
      expect(wrapperSnapshotIsIntact(fixture.manifest, before)).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps the legacy category walk unchanged while an explicit manifest adds Intl", () => {
    const fixture = makeCorpusFixture();
    try {
      for (const key of selectionEnv) unsetSelectionEnv(key);
      const defaultSelection = runner.discoverTest262TestFiles({ test262Root: fixture.corpusRoot });
      expect(defaultSelection.map((entry) => entry.relPath)).toEqual([
        "test/language/expressions/ordinary.js",
        "test/language/import/import-defer/deferred.js",
        "test/language/module-code/namespace/self.js",
        "test/language/module-code/namespace/with-fixture.js",
        "test/annexB/language/function-code/function-redeclaration-block.js",
      ]);

      process.env.TEST262_EXACT_MANIFEST_FILE = fixture.manifest;
      const exactSelection = runner.discoverTest262TestFiles({ test262Root: fixture.corpusRoot });
      expect(exactSelection.map((entry) => entry.relPath)).toEqual([
        "test/language/expressions/ordinary.js",
        "test/intl402/Locale/ordinary.js",
      ]);
      expect(exactSelection.map((entry) => entry.category)).toEqual(["language/expressions", "intl402"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("refuses an exact manifest combined with either legacy filter source", () => {
    const fixture = makeCorpusFixture();
    try {
      process.env.TEST262_EXACT_MANIFEST_FILE = fixture.manifest;
      process.env.TEST262_PATH_FILTER = "ordinary";
      expect(() => runner.discoverTest262TestFiles({ test262Root: fixture.corpusRoot })).toThrow("cannot be combined");

      unsetSelectionEnv("TEST262_PATH_FILTER");
      process.env.TEST262_PATH_FILTER_FILE = fixture.manifest;
      expect(() => runner.discoverTest262TestFiles({ test262Root: fixture.corpusRoot })).toThrow("cannot be combined");
    } finally {
      fixture.cleanup();
    }
  });

  it("keeps exact fixture and namespace self-import graph keys canonical after realpath resolution", () => {
    const fixture = makeCorpusFixture();
    try {
      const namespacePath = runner.test262FixtureRelativePath(
        fixture.namespaceSelfImport,
        "test/language/module-code/namespace/self.js",
        fixture.manifest,
        fixture.corpusRoot,
      );
      expect(namespacePath).toBe("language/module-code/namespace/self.js");
      expect(
        hasSelfModuleImport(namespacePath, readFileSync(fixture.namespaceSelfImport, "utf8"), {
          test262Root: fixture.corpusRoot,
        }),
      ).toBe(true);

      const fixtureEntryPath = runner.test262FixtureRelativePath(
        fixture.namespaceFixtureEntry,
        "test/language/module-code/namespace/with-fixture.js",
        fixture.manifest,
        fixture.corpusRoot,
      );
      const graph = discoverFixtureGraph(fixtureEntryPath, readFileSync(fixture.namespaceFixtureEntry, "utf8"), {
        test262Root: fixture.corpusRoot,
      });
      expect(graph.entryFile).toBe("./language/module-code/namespace/with-fixture.js");
      expect(Object.keys(graph.fixtureFiles)).toEqual(["./language/module-code/namespace/helper_FIXTURE.js"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("uses canonical manifest identities for scope and skip policy after a corpus symlink realpath", () => {
    const fixture = makeCorpusFixture();
    try {
      const policyManifest = join(dirname(fixture.manifest), "policy-selection.txt");
      writeFileSync(
        policyManifest,
        [
          "test/staging/proposal.js",
          "test/annexB/language/function-code/function-redeclaration-block.js",
          "test/language/import/import-defer/deferred.js",
        ].join("\n") + "\n",
      );
      const selected = runner.discoverTest262TestFiles({
        exactManifestFile: policyManifest,
        test262Root: fixture.corpusRoot,
      });
      const byPath = new Map(selected.map((entry) => [entry.relPath, entry]));
      const staging = byPath.get("test/staging/proposal.js")!;
      const annexB = byPath.get("test/annexB/language/function-code/function-redeclaration-block.js")!;
      const importDefer = byPath.get("test/language/import/import-defer/deferred.js")!;

      expect(runner.classifyTestScope("", {}, staging.filePath, staging.relPath)).toMatchObject({
        scope: "proposal",
        official: false,
      });
      expect(runner.classifyTestScope("", {}, annexB.filePath, annexB.relPath)).toMatchObject({
        scope: "annex_b",
        official: true,
        strict: "no",
      });
      expect(runner.shouldSkip("", {}, importDefer.filePath, importDefer.relPath)).toEqual({
        skip: true,
        reason: "proposal feature: import defer (no test harness)",
      });
    } finally {
      fixture.cleanup();
    }
  });
});

describe("#6712 frozen ES2015 population", () => {
  it("preserves all 11,778 index identities and the 74 otherwise-missed Intl identities", () => {
    const text = readFileSync(FULL_MANIFEST, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const manifest = parseTest262ExactManifest(text, FULL_MANIFEST);
    const editionIndex = JSON.parse(readFileSync(EDITION_INDEX, "utf8")) as EditionIndex;
    // The base-359c2 raw-index SHA is a historical reconstruction receipt in
    // the issue plan. This generated report index is mutable, so the ongoing
    // control pins its ES2015 identities to the immutable manifest instead of
    // pinning unrelated serialization such as the edition-label order.
    expect(editionIndex.editions).toContain("ES2015");
    const fromIndex = pathsForEdition(editionIndex, "ES2015");
    const manifestSet = new Set(manifest);
    const indexSet = new Set(fromIndex);
    expect(manifest).toHaveLength(11_778);
    expect(fromIndex).toHaveLength(11_778);
    expect(manifest.filter((path) => path.startsWith("test/intl402/"))).toHaveLength(74);
    expect(fromIndex.filter((path) => path.startsWith("test/intl402/"))).toHaveLength(74);
    expect(manifest.every((path, index) => index === 0 || manifest[index - 1]! < path)).toBe(true);
    expect([...indexSet].filter((path) => !manifestSet.has(path))).toEqual([]);
    expect([...manifestSet].filter((path) => !indexSet.has(path))).toEqual([]);
    expect(createHash("sha256").update(text).digest("hex")).toBe(CANONICAL_SHA256);
    expect(strippedPathSetSha256(manifest)).toBe(HISTORICAL_ES2015_PATHS_SHA256);
    expect(strippedPathSetSha256(fromIndex)).toBe(HISTORICAL_ES2015_PATHS_SHA256);
  });

  it("keeps ES2015 identities stable across reordered edition labels with remapped indices", () => {
    const before: EditionIndex = {
      editions: ["ES5", "ES2015", "ES2021"],
      files: {
        "built-ins/legacy.js": 0,
        "intl402/Locale/es2015.js": 1,
        "language/es2015.js": 1,
        "language/modern.js": 2,
      },
    };
    const reordered: EditionIndex = {
      editions: ["ES2021", "ES5", "ES2015"],
      files: {
        "built-ins/legacy.js": 1,
        "intl402/Locale/es2015.js": 2,
        "language/es2015.js": 2,
        "language/modern.js": 0,
      },
    };

    const beforePaths = pathsForEdition(before, "ES2015");
    const reorderedPaths = pathsForEdition(reordered, "ES2015");
    expect(reorderedPaths).toEqual(beforePaths);
    expect(strippedPathSetSha256(reorderedPaths)).toBe(strippedPathSetSha256(beforePaths));
  });

  it("detects a changed ES2015 membership despite a valid edition-index shape", () => {
    const before: EditionIndex = {
      editions: ["ES5", "ES2015", "ES2021"],
      files: {
        "built-ins/legacy.js": 0,
        "intl402/Locale/es2015.js": 1,
        "language/es2015.js": 1,
        "language/modern.js": 2,
      },
    };
    const reclassified: EditionIndex = {
      ...before,
      files: {
        ...before.files,
        "intl402/Locale/es2015.js": 2,
      },
    };

    const beforePaths = pathsForEdition(before, "ES2015");
    const reclassifiedPaths = pathsForEdition(reclassified, "ES2015");
    expect(reclassifiedPaths).not.toEqual(beforePaths);
    expect(strippedPathSetSha256(reclassifiedPaths)).not.toBe(strippedPathSetSha256(beforePaths));
  });
});

describe("#6712 completeness and wrapper wiring", () => {
  it("rejects an expected Intl identity that was silently omitted before registration", () => {
    const ordinary = "test/language/expressions/ordinary.js";
    const intl = "test/intl402/Locale/ordinary.js";
    const result = evaluateTest262Completeness(verdict(ordinary), [completionManifest([ordinary], 1)], {
      expectedShardCount: 1,
      expectedPaths: [ordinary, intl],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "manifest-scope-mismatch")).toBe(true);
  });

  it("rejects an omitted Intl verdict and an attempt to hide an unregistered Intl path as an exclusion", () => {
    const ordinary = "test/language/expressions/ordinary.js";
    const intl = "test/intl402/Locale/ordinary.js";
    const omittedVerdict = evaluateTest262Completeness(
      verdict(ordinary),
      [completionManifest([ordinary, intl], 1, 1)],
      {
        expectedShardCount: 1,
        expectedPaths: [ordinary, intl],
      },
    );
    expect(omittedVerdict.ok).toBe(false);
    expect(omittedVerdict.errors.some((error) => error.code === "missing-verdict-identity")).toBe(true);
    expect(omittedVerdict.errors.some((error) => error.code === "callbacks-unsettled")).toBe(true);

    const hiddenAsExclusion = evaluateTest262Completeness(
      verdict(ordinary),
      [completionManifest([ordinary], 1, 1, [intl])],
      { expectedShardCount: 1, expectedPaths: [ordinary, intl] },
    );
    expect(hiddenAsExclusion.ok).toBe(false);
    expect(hiddenAsExclusion.errors.some((error) => error.code === "manifest-exclusion-not-registered")).toBe(true);
    expect(hiddenAsExclusion.errors.some((error) => error.code === "manifest-scope-mismatch")).toBe(true);
  });

  it("preflights and snapshots the original exact set before build, then passes it to completeness", () => {
    const wrapper = readFileSync(RUNNER, "utf8");
    expect(wrapper).toContain("TEST262_EXACT_MANIFEST_FILE and TEST262_PATH_FILTER cannot be combined");
    expect(wrapper).toContain("TEST262_EXACT_MANIFEST_FILE and TEST262_PATH_FILTER_FILE cannot be combined");
    expect(wrapper).toContain('node "$MAIN_DIR/scripts/test262-exact-manifest.mjs"');
    expect(wrapper).toContain('completeness_args+=(--expected-paths-file "$TEST262_EXACT_MANIFEST_FILE")');
    const preflight = wrapper.indexOf("Validating exact Test262 manifest before compiler build");
    const compilerBuild = wrapper.indexOf("Building compiler bundle in worktree");
    const snapshot = wrapper.indexOf('TEST262_EXACT_MANIFEST_FILE="$EXACT_MANIFEST_SNAPSHOT"');
    const snapshotHash = wrapper.indexOf(
      'EXACT_MANIFEST_SNAPSHOT_SHA256="$(exact_manifest_sha256 "$TEST262_EXACT_MANIFEST_FILE")"',
    );
    const snapshotIntegrityCheck = wrapper.indexOf("EXACT_MANIFEST_SNAPSHOT_INTACT=true");
    const completeness = wrapper.indexOf('completeness_args+=(--expected-paths-file "$TEST262_EXACT_MANIFEST_FILE")');
    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(compilerBuild);
    expect(snapshot).toBeGreaterThan(preflight);
    expect(snapshotHash).toBeGreaterThan(snapshot);
    expect(snapshotIntegrityCheck).toBeGreaterThan(snapshotHash);
    expect(wrapper).toContain("exact manifest snapshot changed after preflight");
    expect(completeness).toBeGreaterThan(snapshot);
  });

  it("executable wrapper preflight rejects ambiguous or missing exact inputs before it acquires a run lock", () => {
    const baseEnv = {
      ...process.env,
      TEST262_TARGET: "gc",
      TEST262_SEMANTIC_PROVIDERS: "auto",
      TEST262_PATH_FILTER: "",
      TEST262_PATH_FILTER_FILE: "",
    };
    const ambiguous = spawnSync("bash", [RUNNER], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...baseEnv, TEST262_EXACT_MANIFEST_FILE: FULL_MANIFEST, TEST262_PATH_FILTER: "ordinary" },
    });
    expect(ambiguous.status).toBe(2);
    expect(`${ambiguous.stdout}${ambiguous.stderr}`).toContain(
      "TEST262_EXACT_MANIFEST_FILE and TEST262_PATH_FILTER cannot be combined",
    );
    expect(`${ambiguous.stdout}${ambiguous.stderr}`).not.toContain("Lock acquired");

    const missing = spawnSync("bash", [RUNNER], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...baseEnv, TEST262_EXACT_MANIFEST_FILE: join(tmpdir(), "does-not-exist-6712.txt") },
    });
    expect(missing.status).toBe(2);
    expect(`${missing.stdout}${missing.stderr}`).toContain("TEST262_EXACT_MANIFEST_FILE does not exist");
    expect(`${missing.stdout}${missing.stderr}`).not.toContain("Lock acquired");
  });
});
