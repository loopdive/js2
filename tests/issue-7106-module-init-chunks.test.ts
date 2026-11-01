// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — a `<module-init>` past the shared chunk budget
// (`src/shared/module-init-chunk-plan.ts`) is lowered by the IR one planned
// chunk per private function (`src/ir/module-init-chunk-lowering.ts`) instead
// of being withdrawn to legacy.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { MODULE_INIT_CHUNK_MAX_ENTRIES } from "../src/shared/module-init-chunk-plan.js";
import { compile as compilePrepared } from "../src/test262/test262-prepared-entry.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compileHarnessBody,
  moduleInit,
  runModuleInit,
  type HarnessCompileResult,
} from "./helpers/harness-module-init.js";
import { watCallTargets, watFunction, watFunctionNames, watInstructionCount } from "./helpers/wat-functions.js";

/** One planned chunk's worth of statements that leave `tick` observable. */
const FILLER = Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES }, (_, i) => `tick = tick + ${i % 3};`);
const FILLER_SUM = Array.from({ length: MODULE_INIT_CHUNK_MAX_ENTRIES }, (_, i) => i % 3).reduce((a, b) => a + b, 0);

interface ProbeExports {
  readonly __module_init: () => void;
  readonly probe: () => number;
}

function expectIrChunks(result: HarnessCompileResult): readonly string[] {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  expect(moduleInit(result)?.irBodyEmitted).toBe(true);
  const chunks = watFunctionNames(result.wat).filter((name) => /^__module_init_chunk_\d+$/.test(name));
  expect(chunks.length).toBeGreaterThan(1);
  return chunks;
}

/** A TypeScript module with a `probe` export, compiled on standalone with the IR. */
async function compileProbe(lines: readonly string[]) {
  const result = await compile(["let tick: number = 0;", ...lines].join("\n"), {
    fileName: "issue-7106-module-init-chunks.ts",
    target: "standalone",
    deferTopLevelInit: true,
    trackIrOutcomes: true,
  });
  const chunks = expectIrChunks(result);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return { wat: result.wat, chunks, exports: instance.exports as unknown as ProbeExports };
}

/** A test262 body behind the original harness, exactly as the conformance runner compiles it. */
async function runHarnessBody(lines: readonly string[]): Promise<void> {
  const result = await compileHarnessBody(["var tick = 0;", ...lines].join("\n"));
  expectIrChunks(result);
  await runModuleInit(result);
}

describe("#7106 chunked <module-init> lowered by the IR", () => {
  it("splits the initializer at the planned boundaries behind the dispatcher", async () => {
    const { wat, chunks, exports } = await compileProbe([
      ...FILLER,
      ...FILLER,
      "tick = tick * 10;",
      "export function probe(): number { return tick; }",
    ]);
    // 1 declaration + 33 statements: chunks of 16, 16 and 2 entries.
    expect(chunks).toEqual(["__module_init_chunk_0", "__module_init_chunk_1", "__module_init_chunk_2"]);
    const dispatched = watCallTargets(wat, watFunction(wat, "__module_init"));
    expect(dispatched.filter((name) => chunks.includes(name))).toEqual(chunks);
    for (const name of chunks) {
      expect(watInstructionCount(watFunction(wat, name))).toBeLessThanOrEqual(MODULE_INIT_CHUNK_MAX_ENTRIES * 8);
    }
    exports.__module_init();
    expect(exports.probe()).toBe(FILLER_SUM * 2 * 10);
  });

  it("shares a var declared in one chunk with a later chunk", async () => {
    await runHarnessBody(["var early = 40;", ...FILLER, "var late = early + 2;", "assert.sameValue(late, 42);"]);
  });

  it("calls a function hoisted from after the last chunk in the first one", async () => {
    await runHarnessBody([
      "var early = seven();",
      ...FILLER,
      "assert.sameValue(early, 7);",
      "function seven() { return 7; }",
    ]);
  });

  it("keeps a let read before its declaration in a later chunk in its TDZ", async () => {
    const { exports } = await compileProbe([
      "let caught: number = 0;",
      "function readLate(): number { return late; }",
      "try { readLate(); } catch (e) { caught = 1; }",
      ...FILLER,
      "let late: number = 5;",
      "export function probe(): number { return caught * 10 + readLate(); }",
    ]);
    exports.__module_init();
    expect(exports.probe()).toBe(15);
  });

  it("stops at a throw in a middle chunk: later chunks do not run", async () => {
    const { exports } = await compileProbe([
      "let after: number = 0;",
      "function readLate(): number { return late; }",
      ...FILLER,
      "readLate();",
      ...FILLER,
      "after = 1;",
      "let late: number = 5;",
      "export function probe(): number { return after * 1000 + tick; }",
    ]);
    expect(() => exports.__module_init()).toThrow();
    expect(exports.probe()).toBe(FILLER_SUM);
  });

  it("emits legacy's held chunks, and no IR chunk, when a claimed initializer demotes", async () => {
    // A mixed string/number `+` is claimed at selection and demoted while
    // lowering, so the legacy initializer stays and needs its bounded chunks.
    const result = await compileHarnessBody(
      [
        "var tick = 0;",
        ...FILLER,
        "if (-1 << 0 !== -1) { throw new Test262Error('#1: -1 << 0 === -1. Actual: ' + (-1 << 0)); }",
      ].join("\n"),
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(moduleInit(result)?.code).toBe("operand-coercion-unsupported");
    // The IR reserved the plain chunk names before it demoted, so legacy's take a suffix.
    const chunks = watFunctionNames(result.wat).filter((name) => /^__module_init_chunk_\d+_\d+$/.test(name));
    expect(chunks.length).toBeGreaterThan(1);
    expect(watCallTargets(result.wat, watFunction(result.wat, "__module_init"))).toEqual(
      expect.arrayContaining(chunks),
    );
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    (instance.exports.__module_init as () => void)();
  });

  it("dispatches more chunks than one dispatcher holds in source order", async () => {
    const steps = Array.from(
      { length: (MODULE_INIT_CHUNK_MAX_ENTRIES + 2) * MODULE_INIT_CHUNK_MAX_ENTRIES },
      (_, i) => i,
    );
    const { wat, chunks, exports } = await compileProbe([
      ...steps.map((step) => `tick = (tick * 31 + ${step}) % 1000003;`),
      "export function probe(): number { return tick; }",
    ]);
    expect(chunks.length).toBeGreaterThan(MODULE_INIT_CHUNK_MAX_ENTRIES);
    expect(watFunctionNames(wat)).toContain("__module_init_chunk_dispatch_0_0");
    exports.__module_init();
    expect(exports.probe()).toBe(steps.reduce((tick, step) => (tick * 31 + step) % 1000003, 0));
  });

  it(
    "chunks the initializer on the prepared whole-IR route, which used to emit one unbounded body",
    { timeout: 180_000 },
    async () => {
      const steps = Array.from({ length: 400 }, (_, i) => i);
      for (const target of ["gc", "standalone"] as const) {
        const result = await compilePrepared(
          [
            "let tick: number = 0;",
            ...steps.map((step) => `tick = (tick * 31 + ${step}) % 1000003;`),
            "export function main(): number { return tick; }",
          ].join("\n"),
          {
            wholeProgram: { kind: "prepared-program-required", version: 1 },
            target,
            backend: "wasmgc",
            sourceMap: false,
            optimize: false,
            emitWat: true,
            fileName: "entry.ts",
          },
        );
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        // 1 declaration + 400 statements in chunks of 16: 26 chunks, two dispatchers.
        expect([...(result.wat ?? "").matchAll(/\(func \$__module_init_chunk_\d+ /g)]).toHaveLength(26);
        const exports = instantiatePreparedArtifact(result).instance.exports as Record<string, () => number>;
        // The initializer runs from the start section unless the route exports it.
        (exports.__module_init ?? exports._start)?.();
        expect(exports.main!()).toBe(steps.reduce((tick, step) => (tick * 31 + step) % 1000003, 0));
      }
    },
  );

  // Review round 1 dropped a void body's trailing `return`; on an empty method that left
  // an empty body, which the prepared-class cutover reads as uninstalled (staging/sm/class/className.js).
  it("compiles a class whose static method is empty", async () => {
    for (const target of ["gc", "standalone"] as const) {
      const result = await compile("class C { constructor() {} static m() {} }\nvar x = C;", {
        allowJs: true,
        fileName: "empty-method.js",
        skipSemanticDiagnostics: true,
        ...(target === "gc" ? {} : { target }),
      } as Parameters<typeof compile>[1]);
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    }
  });
});
