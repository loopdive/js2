// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #700 — the authoritative Test262 worker must use the persistent TypeScript
 * Language Service for literal JavaScript harness assemblies, not only for the
 * older synthetic-TypeScript lane.
 */
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { CompilerPool } from "../scripts/compiler-pool.js";
import { IncrementalProjectLanguageService } from "../src/checker/index.js";
import { compile, compileMulti, createIncrementalCompiler } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";

const WORKER_OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  sourceMap: true,
  sourceMapUrl: "test.wasm.map",
  emitWat: false,
  skipSemanticDiagnostics: true,
  deferTopLevelInit: true,
} as const;

let pool: CompilerPool | undefined;

afterAll(() => {
  pool?.shutdown();
});

describe("#700 Test262 Language Service integration", () => {
  it("routes the original-harness branch through the persistent single-source compiler", () => {
    const worker = readFileSync("scripts/test262-worker.mjs", "utf8");
    const branchStart = worker.indexOf("  if (originalHarness) {");
    const branchEnd = worker.indexOf("\n  }\n  return compileSingleSource(source, {", branchStart);
    const originalHarnessBranch = worker.slice(branchStart, branchEnd);

    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    expect(originalHarnessBranch).toContain("return compileSingleSource(source, {");
    expect(originalHarnessBranch).not.toContain("return compile(source, {");
    expect(worker).toContain(
      "return incrementalCompiler ? incrementalCompiler.compile(source, options) : compile(source, options);",
    );
    expect(worker).toContain("incrementalCompiler.compileMulti(files, entryFile, options)");

    const fixtureBranchStart = worker.indexOf("  if (hasFixtureGraph(fixtureFiles)) {");
    const fixtureBranchEnd = worker.indexOf("\n  }\n  if (originalHarness) {", fixtureBranchStart);
    const fixtureBranch = worker.slice(fixtureBranchStart, fixtureBranchEnd);
    expect(fixtureBranch).toContain("return compileMultipleSources(");
    expect(fixtureBranch).not.toContain("return compileMulti(");
  });

  it("does not cold-recreate the Language Service on a fixed compilation interval", () => {
    const worker = readFileSync("scripts/test262-worker.mjs", "utf8");

    expect(worker).not.toContain("RECREATE_INTERVAL");
    expect(worker).not.toContain("RECREATE at compile");
    expect(worker).toContain("compileCount % GC_INTERVAL === 0");
    expect(worker).toContain("incrementalCompiler?.dispose?.()");
    expect(worker).toContain("createFreshCompiler();");
  });

  it("retains unchanged dependency ASTs while editing a project graph", () => {
    const service = new IncrementalProjectLanguageService();
    const firstFiles = {
      "./dep.ts": "export function value(): number { return 1; }",
      "./main.ts": "import { value } from './dep'; export function run(): number { return value(); }",
    };

    try {
      service.updateProject(firstFiles, "./main.ts");
      const first = service.analyze();
      const firstDependency = first.program.getSourceFile("dep.ts");

      service.updateProject(firstFiles, "./main.ts");
      const unchanged = service.analyze();
      expect(unchanged.program).toBe(first.program);
      expect(unchanged.entryFile).toBe(first.entryFile);
      expect(unchanged.program.getSourceFile("dep.ts")).toBe(firstDependency);

      service.updateProject(
        {
          ...firstFiles,
          "./main.ts": "import { value } from './dep'; export function run(): number { return value() + 1; }",
        },
        "./main.ts",
      );
      const second = service.analyze();
      expect(second.program).not.toBe(first.program);
      expect(second.program.getSourceFile("dep.ts")).toBe(firstDependency);
      expect(second.entryFile).not.toBe(first.entryFile);
    } finally {
      service.dispose();
    }
  });

  it("keeps edited multi-file builds byte-identical to standalone compilation", async () => {
    const incremental = createIncrementalCompiler({ emitWat: false });
    const entryFile = "./main.ts";
    const graphs = [2, 3].map((factor) => ({
      "./math.ts": `export function scale(value: number): number { return value * ${factor}; }`,
      [entryFile]:
        "import { scale } from './math'; export function run(value: number): number { return scale(value); }",
    }));

    try {
      for (const [index, files] of graphs.entries()) {
        const standaloneResult = await compileMulti(files, entryFile, { emitWat: false });
        const incrementalResult = await incremental.compileMulti(files, entryFile);

        expect(incrementalResult.success).toBe(true);
        expect(incrementalResult.errors).toEqual(standaloneResult.errors);
        expect(Buffer.from(incrementalResult.binary)).toEqual(Buffer.from(standaloneResult.binary));

        const imports = buildImports(incrementalResult.imports, undefined, incrementalResult.stringPool);
        const { instance } = await WebAssembly.instantiate(incrementalResult.binary, imports);
        imports.setInstance?.(instance);
        expect((instance.exports.run as (value: number) => number)(7)).toBe(index === 0 ? 14 : 21);
      }
    } finally {
      incremental.dispose();
    }
  });

  it("invalidates removed files and clears repaired project diagnostics", () => {
    const service = new IncrementalProjectLanguageService();
    const entryFile = "./main.ts";
    const validFiles = {
      "./dep.ts": "export const value: number = 42;",
      [entryFile]: "import { value } from './dep'; export const answer: number = value;",
    };

    try {
      service.updateProject(validFiles, entryFile);
      expect(service.analyze().diagnostics).toEqual([]);

      const alternateEntry = "./alternate.ts";
      service.updateProject(
        {
          ...validFiles,
          [alternateEntry]: "import { value } from './dep'; export function alternate(): number { return value + 1; }",
        },
        alternateEntry,
      );
      expect(service.analyze().entryFile.fileName).toBe("alternate.ts");

      service.updateProject({ [entryFile]: validFiles[entryFile] }, entryFile);
      expect(service.analyze().diagnostics.some((diagnostic) => diagnostic.code === 2307)).toBe(true);

      service.updateProject(validFiles, entryFile);
      expect(service.analyze().diagnostics).toEqual([]);
    } finally {
      service.dispose();
    }
  });

  it("isolates simultaneous project services that use the same virtual paths", () => {
    const first = new IncrementalProjectLanguageService();
    const second = new IncrementalProjectLanguageService();
    const entryFile = "./main.ts";

    try {
      first.updateProject(
        {
          "./dep.ts": "export const value = 1;",
          [entryFile]: "import { value } from './dep'; export const result = value;",
        },
        entryFile,
      );
      second.updateProject(
        {
          "./dep.ts": "export const value = 2;",
          [entryFile]: "import { value } from './dep'; export const result = value;",
        },
        entryFile,
      );

      const firstDependency = first.analyze().program.getSourceFile("dep.ts");
      const secondDependency = second.analyze().program.getSourceFile("dep.ts");
      expect(firstDependency?.text).toContain("value = 1");
      expect(secondDependency?.text).toContain("value = 2");
      expect(firstDependency).not.toBe(secondDependency);
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it("keeps sequential JavaScript harness replacements byte-identical to standalone compilation", async () => {
    const sources = [
      "assert.sameValue(21 * 2, 42);\n",
      "var values = [1, 2, 3];\nassert.sameValue(values.length, 3);\n",
      "var total = 0;\nfor (var i = 0; i < 8; i++) total += i;\nassert.sameValue(total, 28);\n",
    ].map((body) => assembleOriginalHarness(body, { flags: ["noStrict"] }).primary.source);
    const incremental = createIncrementalCompiler(WORKER_OPTIONS);

    try {
      for (const source of sources) {
        const standaloneResult = await compile(source, WORKER_OPTIONS);
        const incrementalResult = await incremental.compile(source);

        expect(incrementalResult.success).toBe(standaloneResult.success);
        expect(incrementalResult.errors).toEqual(standaloneResult.errors);
        expect(Buffer.from(incrementalResult.binary)).toEqual(Buffer.from(standaloneResult.binary));
      }
    } finally {
      incremental.dispose();
    }
  });

  it("drops syntax diagnostics from the preceding JavaScript harness", async () => {
    const precedingSource = assembleOriginalHarness(
      'if (1 !== undefined) throw new Test262Error("preceding runtime failure");\n',
      { flags: ["noStrict"] },
    ).primary.source;
    const invalidSource = assembleOriginalHarness("const = ;\n", { flags: ["noStrict"] }).primary.source;
    const validSource = assembleOriginalHarness('throw new SyntaxError("runtime, not parse");\n', {
      flags: ["noStrict"],
    }).primary.source;
    const incremental = createIncrementalCompiler(WORKER_OPTIONS);

    try {
      const precedingResult = await incremental.compile(precedingSource);
      expect(precedingResult.success).toBe(true);

      const invalidResult = await incremental.compile(invalidSource);
      expect(invalidResult.success).toBe(false);

      const standaloneResult = await compile(validSource, WORKER_OPTIONS);
      const incrementalResult = await incremental.compile(validSource);
      expect(standaloneResult.success).toBe(true);
      expect(incrementalResult.errors).toEqual(standaloneResult.errors);
      expect(incrementalResult.success).toBe(standaloneResult.success);
      expect(Buffer.from(incrementalResult.binary)).toEqual(Buffer.from(standaloneResult.binary));
    } finally {
      incremental.dispose();
    }
  });

  it("compiles and executes consecutive original-harness jobs in one unified CI worker", async () => {
    pool ??= new CompilerPool(1, "unified");
    await pool.ready();

    const bodies = [
      "assert.sameValue(6 * 7, 42);\n",
      "assert.sameValue([1, 2, 3].length, 3);\n",
      "var value = 0;\nfor (var i = 0; i < 5; i++) value += i;\nassert.sameValue(value, 10);\n",
    ];
    const sources = bodies.map((body) => assembleOriginalHarness(body, { flags: ["noStrict"] }).primary.source);

    for (const [index, source] of sources.entries()) {
      const result = await pool.runTest(
        source,
        {
          originalHarness: true,
          asyncTest: false,
          inferModuleStrictArguments: false,
          label: `#700 original-harness incremental job ${index + 1}`,
        },
        30_000,
      );
      expect(result.status, result.error).toBe("pass");
      expect(result.reachedTest).toBe(true);
    }

    const invalidSource = assembleOriginalHarness("const = ;\n", { flags: ["noStrict"] }).primary.source;
    const invalidResult = await pool.runTest(
      invalidSource,
      {
        originalHarness: true,
        isRuntimeNegative: true,
        expectedErrorType: "TypeError",
        label: "#700 invalid original-harness source",
      },
      30_000,
    );
    expect(invalidResult.status, JSON.stringify(invalidResult)).toBe("compile_error");

    const recoveredSource = assembleOriginalHarness("assert.sameValue(2 + 2, 4);\n", {
      flags: ["noStrict"],
    }).primary.source;
    const recoveredResult = await pool.runTest(
      recoveredSource,
      {
        originalHarness: true,
        label: "#700 passing original-harness source after syntax error",
      },
      30_000,
    );
    expect(recoveredResult.status, JSON.stringify(recoveredResult)).toBe("pass");
    expect(recoveredResult.reachedTest).toBe(true);

    const standaloneResult = await pool.runTest(
      recoveredSource,
      {
        originalHarness: true,
        target: "standalone",
        label: "#700 standalone original-harness source",
      },
      30_000,
    );
    expect(standaloneResult.status, JSON.stringify(standaloneResult)).toBe("pass");
    expect(standaloneResult.reachedTest).toBe(true);
  }, 90_000);

  it("reuses one unified CI worker across changing Test262 fixture graphs", async () => {
    pool ??= new CompilerPool(1, "unified");
    await pool.ready();

    const entryFile = "./language/module-code/issue-700-entry.js";
    const fixtureFile = "./language/module-code/issue-700_FIXTURE.js";
    for (const expected of [41, 42]) {
      const source = assembleOriginalHarness(
        `import { fixtureValue } from "./issue-700_FIXTURE.js";\nassert.sameValue(fixtureValue, ${expected});\n`,
        { flags: ["module"] },
      ).primary.source;
      const result = await pool.runTest(
        source,
        {
          originalHarness: true,
          fixtureFiles: { [fixtureFile]: `export const fixtureValue = ${expected};` },
          entryFile,
          inferModuleStrictArguments: true,
          label: `#700 incremental fixture graph ${expected}`,
        },
        30_000,
      );
      expect(result.status, JSON.stringify(result)).toBe("pass");
      expect(result.reachedTest).toBe(true);
    }
  }, 90_000);
});
