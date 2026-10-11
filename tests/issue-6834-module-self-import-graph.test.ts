// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { discoverFixtureGraph, hasPinnedEntryValueSelfImport } from "../scripts/test262-fixture-graph.mjs";
import { loadOriginalHarnessTests } from "../scripts/test262-fyi-reader.mjs";
import { FyiSourceExecutor, runTest } from "../scripts/run-test262-fyi.mjs";
import { CompilerPool } from "../scripts/compiler-pool.js";

const ROOT = join(import.meta.dirname, "..");
const PATH = "language/module-code/issue-6834-entry.js";
const ENTRY = `./${PATH}`;
const ORIGINALS = [
  "eval-export-dflt-expr-gen-anon.js",
  "eval-export-dflt-expr-gen-named.js",
  "instn-named-bndng-dflt-gen-anon.js",
  "instn-named-bndng-dflt-gen-named.js",
  "instn-named-bndng-gen.js",
].map((file) => `language/module-code/${file}`);

function source(path: string) {
  return readFileSync(join(ROOT, "test262", "test", path), "utf8");
}

const DEFAULT_SOURCE = `
import answer from "./issue-6834-entry.js";
export default function original() { return 42; }
if (answer() !== 42) throw new Error("default alias did not link");
`;

function record(contents = DEFAULT_SOURCE) {
  return {
    file: PATH,
    contents,
    flags: { module: true },
    strictRerun: false,
    negative: undefined,
    entryFile: ENTRY,
    fixtureFiles: {} as Record<string, string>,
    requiresEntrySelfImportGraph: true,
  };
}

describe("#6834 discovery", () => {
  it.each(ORIGINALS)("admits the untouched original %s without an entry fixture", (path) => {
    const graph = discoverFixtureGraph(path, source(path));
    expect(graph).toEqual({
      entryFile: `./${path}`,
      fixtureFiles: {},
      dynamicFixtureFiles: {},
      requiresEntrySelfImportGraph: true,
    });
  });

  it.each([
    'import g from "./issue-6834-entry.js";',
    'import { g } from "./issue-6834-entry.js";',
    'import { g as other } from "./issue-6834-entry.js";',
    'import { default as g } from "./issue-6834-entry.js";',
    'import g, { f as other } from "./issue-6834-entry.js";',
    'import\n{ g as other }\nfrom\n"./issue-6834-entry.js";',
    'import g from "./sub/../issue-6834-entry.js";',
    'import g from "./issue-6834-entry.js"; import { f } from "./issue-6834-entry.js";',
  ])("accepts supported value imports: %s", (imports) => {
    expect(hasPinnedEntryValueSelfImport(ENTRY, imports)).toBe(true);
  });

  it.each([
    'import * as ns from "./issue-6834-entry.js";',
    'import g, * as ns from "./issue-6834-entry.js";',
    'import "./issue-6834-entry.js";',
    'import {} from "./issue-6834-entry.js";',
    'import type g from "./issue-6834-entry.js";',
    'import { type g } from "./issue-6834-entry.js";',
    'import g, { type f } from "./issue-6834-entry.js";',
    'import { "default" as g } from "./issue-6834-entry.js";',
    'import g from "./issue-6834-entry.js" with { type: "json" };',
    'import g from "./issue-6834-entry.js" assert { type: "json" };',
    'import source g from "./issue-6834-entry.js";',
    'import defer * as g from "./issue-6834-entry.js";',
    'import g from "./issue-6834-entry";',
    'import g from "./issue-6834-entry.js?query";',
    'import g from "./issue-6834-entry.js#fragment";',
    'import g from "./other.js";',
    'import g from "package";',
    'import g from "https://example.com/issue-6834-entry.js";',
    'import g from "./issue-6834-entry.js"; import f from "./other.js";',
    'import g from "./issue-6834-entry.js"; import "./issue-6834-entry.js";',
    'import g from "./issue-6834-entry.js"; export * from "./issue-6834-entry.js";',
    'import g from "./issue-6834-entry.js"; export { g } from "./other.js";',
    'import("./issue-6834-entry.js");',
    'import g from "./issue-6834-entry.js"; function f() { return import("./other.js"); }',
    'import g from "./issue-6834-entry.js"; const x = `${import("./other.js")}`;',
    'import g from "./issue-6834-entry.js"; const x = import.meta;',
    'function f() { import g from "./issue-6834-entry.js"; }',
    'import g = require("./issue-6834-entry.js");',
    'import g from "./issue-6834-entry.js"; type T = import("./other.js").T;',
    'import g from "./issue-6834-entry.js"; function {',
    '/* import g from "./issue-6834-entry.js"; */',
    "const x = 'import g from \"./issue-6834-entry.js\";';",
    'const x = `import g from "./issue-6834-entry.js";`;',
    'const x = /import g from "issue-6834-entry.js"/;',
  ])("declines unsupported or unrepresented syntax: %s", (contents) => {
    expect(hasPinnedEntryValueSelfImport(ENTRY, contents)).toBe(false);
  });

  it.each([
    undefined,
    PATH,
    `/language/module-code/issue-6834-entry.js`,
    "./language/module-code//issue-6834-entry.js",
    "./language/module-code/./issue-6834-entry.js",
    "./language/module-code/sub/../issue-6834-entry.js",
    "./language/module-code/issue-6834-entry.js?query",
    "./language/module-code/issue-6834-entry.js#fragment",
    "./language\\module-code/issue-6834-entry.js",
    "./language/module-code/issue-6834-entry_FIXTURE.js",
    "./language/module-code/namespace/issue-6834-entry.js",
    "./built-ins/issue-6834-entry.js",
  ])("declines a noncanonical or out-of-scope entry %s", (entry) => {
    expect(hasPinnedEntryValueSelfImport(entry, DEFAULT_SOURCE)).toBe(false);
  });

  it("ignores import-looking trivia beside a real value import", () => {
    expect(
      hasPinnedEntryValueSelfImport(
        ENTRY,
        DEFAULT_SOURCE +
          `
/* import g from "./other.js"; */
const text = 'import g from "./other.js";';
const template = \`import g from "./other.js";\`;
const regexp = /import g from "other.js"/;
`,
      ),
    ).toBe(true);
  });

  it("leaves namespace and real fixture graphs on their existing route", () => {
    expect(
      discoverFixtureGraph(
        "language/module-code/namespace/Symbol.iterator.js",
        source("language/module-code/namespace/Symbol.iterator.js"),
      ).requiresEntrySelfImportGraph,
    ).toBeUndefined();
    const path = "language/module-code/instn-iee-bndng-let.js";
    const graph = discoverFixtureGraph(path, source(path) + `\nimport self from "./instn-iee-bndng-let.js";`);
    expect(graph.requiresEntrySelfImportGraph).toBeUndefined();
    expect(Object.keys(graph.fixtureFiles)).toHaveLength(1);
  });

  it("attaches empty graphs to literal FYI assemblies without rewriting originals", async () => {
    const records = await loadOriginalHarnessTests(ORIGINALS);
    expect(records).toHaveLength(ORIGINALS.length);
    for (const value of records) {
      expect(value.contents.endsWith(source(value.file))).toBe(true);
      expect(value.requiresEntrySelfImportGraph).toBe(true);
      expect(value.fixtureFiles).toEqual({});
      expect(hasPinnedEntryValueSelfImport(value.entryFile, value.contents)).toBe(true);
    }
  });
});

describe("#6834 execution", () => {
  const CONTROLS = [
    DEFAULT_SOURCE,
    `import { answer as alias } from "./issue-6834-entry.js";
     export const answer = 42;
     if (alias !== 42) throw new Error("named alias did not link");`,
    `import first from "./issue-6834-entry.js";
     import { default as second, original as third } from "./issue-6834-entry.js";
     export function original() { return 42; }
     export { original as default };
     if (first !== second || second !== third) throw new Error("binding identity differs");`,
    `import { answer as alias } from "./issue-6834-entry.js";
     export let answer = 1;
     answer = 42;
     if (alias !== 42) throw new Error("live binding did not update");`,
    `import { initCount as alias } from "./issue-6834-entry.js";
     export let initCount = 0;
     initCount++;
     if (alias !== 1 || initCount !== 1) throw new Error("entry initialized twice");`,
  ];

  it.each(["gc", "standalone"] as const)(
    "executes non-generator FYI controls in %s",
    { timeout: 60_000 },
    async (target) => {
      for (const contents of CONTROLS) {
        expect(await runTest(record(contents), target)).toMatchObject({
          pass: true,
          phase: "runtime",
          reachedTest: true,
        });
      }
    },
  );

  it.each(["gc", "standalone"] as const)(
    "forwards the explicit unified-pool flag in %s",
    { timeout: 60_000 },
    async (target) => {
      const pool = new CompilerPool(1, "unified");
      try {
        for (const contents of CONTROLS) {
          expect(
            await pool.runTest(contents, {
              originalHarness: true,
              fixtureFiles: {},
              entryFile: ENTRY,
              requiresEntrySelfImportGraph: true,
              inferModuleStrictArguments: true,
              target,
            }),
          ).toMatchObject({ status: "pass", reachedTest: true });
        }
      } finally {
        pool.shutdown();
      }
    },
  );

  it("does not activate omitted, false, malformed, or forged requests", { timeout: 60_000 }, async () => {
    const pool = new CompilerPool(1, "unified");
    try {
      const opts = {
        originalHarness: true,
        fixtureFiles: {},
        entryFile: ENTRY,
        target: "standalone" as const,
        inferModuleStrictArguments: true,
      };
      for (const change of [
        {},
        { requiresEntrySelfImportGraph: false },
        { requiresEntrySelfImportGraph: true, fixtureFiles: undefined },
        { requiresEntrySelfImportGraph: true, fixtureFiles: [] },
        { requiresEntrySelfImportGraph: true, originalHarness: false },
        { requiresEntrySelfImportGraph: true, entryFile: "./language/module-code/./issue-6834-entry.js" },
      ]) {
        const result = await pool.runTest(DEFAULT_SOURCE, { ...opts, ...change } as never);
        expect(result.status).toBe("compile_error");
        expect(result.error).toContain("env::answer");
      }
      const forged = await pool.runTest(DEFAULT_SOURCE.replace("./issue-6834-entry.js", "./other.js"), {
        ...opts,
        requiresEntrySelfImportGraph: true,
      });
      expect(forged.status).toBe("compile_error");
      expect(forged.error).toContain("env::answer");
      const collision = await pool.runTest(DEFAULT_SOURCE, {
        ...opts,
        requiresEntrySelfImportGraph: true,
        fixtureFiles: { [ENTRY]: DEFAULT_SOURCE },
      });
      expect(collision.status).toBe("compile_error");
      expect(collision.error).toContain(`fixture graph collides with entry file: ${ENTRY}`);
    } finally {
      pool.shutdown();
    }
  });

  it("declines a missing FYI flag rather than inferring a graph from its empty map", { timeout: 60_000 }, async () => {
    const test = record();
    expect(await runTest({ ...test, requiresEntrySelfImportGraph: false }, "standalone")).toMatchObject({
      pass: false,
      phase: "compile",
      detail: expect.stringContaining("env::answer"),
    });
  });

  it(
    "supports a CommonJS worker entry dynamically loading the maintained ESM worker",
    { timeout: 60_000 },
    async () => {
      const scratchRoot = join(ROOT, ".tmp");
      mkdirSync(scratchRoot, { recursive: true });
      const scratch = mkdtempSync(join(scratchRoot, "6834-cjs-"));
      const workerPath = join(scratch, "worker.cjs");
      writeFileSync(
        workerPath,
        `import(${JSON.stringify(pathToFileURL(join(ROOT, "scripts", "test262-worker.mjs")).href)});\n`,
      );
      const executor = new FyiSourceExecutor(30_000, { workerPath });
      try {
        expect(await executor.runSource(record(), DEFAULT_SOURCE, "standalone")).toMatchObject({
          pass: true,
          phase: "runtime",
          reachedTest: true,
        });
      } finally {
        executor.shutdown();
      }
    },
  );

  it("emits a real import-free standalone module for the value self-import control", { timeout: 60_000 }, async () => {
    const { compileMulti } = await import("../src/index.js");
    const result = await compileMulti({ [ENTRY]: DEFAULT_SOURCE }, ENTRY, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      validate: false,
      target: "standalone",
      inferModuleStrictArguments: true,
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  });
});
