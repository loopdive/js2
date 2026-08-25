// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4566 — standalone Wasm-start/deferred-export compile-once ownership for the
// Algorithms module-init / memoized recursion component. The host-free IR path
// must keep every direct-backend optimization while deleting the three
// avoidable legacy bodies from the authoritative standalone readiness lane.

import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";

const SOURCE_URL = new URL("../website/playground/examples/js/algorithms.ts", import.meta.url);
const SOURCE = readFileSync(SOURCE_URL, "utf8");
const FILE_NAME = "website/playground/examples/js/algorithms.ts";
const FUNCTION_TERMINALS = ["fibIter", "fibMemo", "binarySearch", "quicksort", "joinNums", "main"] as const;
const BODY_NAMES = [...FUNCTION_TERMINALS, "__module_init"] as const;
const TRACE = [
  "── Fibonacci ──",
  "fib(0) iter=0 memo=0",
  "fib(1) iter=1 memo=1",
  "fib(2) iter=1 memo=1",
  "fib(3) iter=2 memo=2",
  "fib(4) iter=3 memo=3",
  "fib(5) iter=5 memo=5",
  "fib(6) iter=8 memo=8",
  "fib(7) iter=13 memo=13",
  "fib(8) iter=21 memo=21",
  "fib(9) iter=34 memo=34",
  "fib(30) iter = 832040",
  "── Binary search ──",
  "sorted = [1,3,5,8,13,21,34,55,89,144]",
  "indexOf(13) = 4",
  "indexOf(34) = 6",
  "indexOf(7)  = -1",
  "── Quicksort ──",
  "before = [5,2,8,1,9,3,7,4,6,0]",
  "after  = [0,1,2,3,4,5,6,7,8,9]",
] as const;

let irCompile: Promise<CompileResult> | undefined;
let directCompile: Promise<CompileResult> | undefined;

function compileAlgorithms(experimentalIR: boolean): Promise<CompileResult> {
  const cached = experimentalIR ? irCompile : directCompile;
  if (cached) return cached;
  const started = compile(SOURCE, {
    fileName: FILE_NAME,
    target: "standalone",
    hostBridge: "always",
    experimentalIR,
    trackFallbacks: true,
    trackIrOutcomes: true,
    emitWat: true,
  });
  if (experimentalIR) irCompile = started;
  else directCompile = started;
  return started;
}

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
}

function outcome(
  result: CompileResult,
  unitKind: IrObservedOutcome["unitKind"],
  displayName: string,
): IrObservedOutcome {
  const matches = (result.irOutcomes ?? []).filter(
    (candidate) => candidate.unitKind === unitKind && candidate.displayName === displayName,
  );
  expect(matches, `terminal outcome count for ${unitKind}:${displayName}`).toHaveLength(1);
  return matches[0]!;
}

interface WatFunction {
  readonly name: string;
  readonly body: string;
}

function parseWatFunctions(wat: string): readonly WatFunction[] {
  const starts = [...wat.matchAll(/^ {2}\(func \$([^\s(]+)/gm)].map((match) => ({
    name: match[1]!,
    index: match.index,
  }));
  return starts.map(({ name, index }, position) => ({
    name,
    body: wat.slice(index, starts[position + 1]?.index ?? wat.length),
  }));
}

function watFunction(result: CompileResult, name: string): WatFunction {
  const matches = parseWatFunctions(result.wat).filter((candidate) => candidate.name === name);
  expect(matches, `unique WAT function $${name}`).toHaveLength(1);
  return matches[0]!;
}

function watCallTargets(result: CompileResult, body: string): readonly string[] {
  const imports = [...result.wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...result.wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  return [...body.matchAll(/\b(?:return_call|call) (\d+)/g)].map((match) => names[Number(match[1])] ?? "<missing>");
}

function count(values: readonly string[], value: string): number {
  return values.filter((candidate) => candidate === value).length;
}

function bodySizeMetrics(result: CompileResult): { readonly bytes: number; readonly locals: number } {
  let bytes = 0;
  let locals = 0;
  for (const name of BODY_NAMES) {
    const body = watFunction(result, name).body.trimEnd();
    bytes += body.length;
    locals += body.match(/\(local /g)?.length ?? 0;
  }
  return { bytes, locals };
}

async function runTwice(result: CompileResult): Promise<string> {
  const { instance, module } = await WebAssembly.instantiate(result.binary, {});
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const exports = instance.exports as Record<string, unknown>;
  const main = exports.main as (() => void) | undefined;
  const prepare = exports.__stdout_prepare as (() => number) | undefined;
  const charAt = exports.__stdout_char as ((index: number) => number) | undefined;
  expect(main).toBeTypeOf("function");
  expect(prepare).toBeTypeOf("function");
  expect(charAt).toBeTypeOf("function");
  main!();
  main!();
  const length = prepare!();
  let stdout = "";
  for (let index = 0; index < length; index++) stdout += String.fromCharCode(charAt!(index));
  return stdout;
}

describe("#4566 standalone Algorithms compile-once component", () => {
  it("seals all seven terminals together and removes the final three avoidable legacy bodies", async () => {
    const result = await compileAlgorithms(true);
    expectSuccess(result);

    const componentIds = new Set<string>();
    for (const displayName of FUNCTION_TERMINALS) {
      const observed = outcome(result, "function", displayName);
      expect(observed).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      componentIds.add(observed.preparedComponentId!);
    }
    const moduleInit = outcome(result, "module-init", "<module-init>");
    expect(moduleInit).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    componentIds.add(moduleInit.preparedComponentId!);
    expect(componentIds.size).toBe(1);
    expect(result.irFallbackCounts ?? {}).toEqual({});
    expect(WebAssembly.Module.exports(new WebAssembly.Module(result.binary))).not.toContainEqual({
      name: "__module_init",
      kind: "function",
    });
  });

  it("matches the direct backend twice by value and output with zero imports", async () => {
    const [ir, direct] = await Promise.all([compileAlgorithms(true), compileAlgorithms(false)]);
    expectSuccess(ir);
    expectSuccess(direct);
    const [irStdout, directStdout] = await Promise.all([runTwice(ir), runTwice(direct)]);
    const expected = [...TRACE, ...TRACE].map((line) => `${line}\n`).join("");
    expect(irStdout).toBe(expected);
    expect(irStdout).toBe(directStdout);
  });

  it("bypasses both direct emitters and proves each poison remains live", async () => {
    const previousFunction = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    const previousModuleInit = process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "fibMemo,main";
      process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY = "1";
      const retired = await compile(SOURCE, {
        fileName: "issue-4566-standalone-retired-poisoned.ts",
        target: "standalone",
        hostBridge: "always",
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      expectSuccess(retired);
      for (const name of ["fibMemo", "main"] as const) {
        expect(outcome(retired, "function", name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
        });
      }
      expect(outcome(retired, "module-init", "<module-init>")).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      });

      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "directPoisonControl";
      const directControl = await compile(`export function directPoisonControl(): number { return 7; }`, {
        fileName: "issue-4566-direct-function-poison-control.ts",
        target: "standalone",
        experimentalIR: false,
      });
      expect(directControl.success).toBe(false);
      expect(directControl.errors.map((error) => error.message).join("\n")).toContain(
        "injected direct function-body poison: directPoisonControl",
      );

      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "not-present";
      let moduleControlEvidence = "";
      try {
        const moduleControl = await compile(
          `
            const cache = new Map<number, number>();
            class Box { static value = 42; }
            export function read(): number { return Box.value + cache.size; }
          `,
          {
            fileName: "issue-4566-direct-module-init-poison-control.ts",
            target: "standalone",
            experimentalIR: true,
          },
        );
        moduleControlEvidence = moduleControl.errors.map((error) => error.message).join("\n");
        expect(moduleControl.success).toBe(false);
      } catch (error) {
        moduleControlEvidence = error instanceof Error ? error.message : String(error);
      }
      expect(moduleControlEvidence).toContain("injected direct module-init body poison");
    } finally {
      if (previousFunction === undefined) {
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      } else {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousFunction;
      }
      if (previousModuleInit === undefined) {
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY");
      } else {
        process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY = previousModuleInit;
      }
    }
  });

  it("preserves native Map/string/vector optimizations and beats the direct size ceilings", async () => {
    const [ir, direct] = await Promise.all([compileAlgorithms(true), compileAlgorithms(false)]);
    expectSuccess(ir);
    expectSuccess(direct);

    const fibMemo = watFunction(ir, "fibMemo").body;
    const fibMemoTargets = watCallTargets(ir, fibMemo);
    const directFibMemoTargets = watCallTargets(direct, watFunction(direct, "fibMemo").body);
    for (const target of ["__map_lookup_idx", "__hash_anyref", "__map_get", "__map_set", "__box_number"] as const) {
      expect(count(fibMemoTargets, target), `${target} matches direct`).toBe(count(directFibMemoTargets, target));
    }
    expect(count(fibMemoTargets, "fibMemo")).toBe(2);

    const binarySearch = watFunction(ir, "binarySearch").body;
    expect(binarySearch).toMatch(/\bi32\.shr_s\b/);

    const quicksort = watFunction(ir, "quicksort").body;
    const quicksortTargets = watCallTargets(ir, quicksort);
    expect(quicksortTargets.filter((target) => /^__vec_elem_set_\d+$/.test(target))).toHaveLength(4);
    expect(count(quicksortTargets, "quicksort")).toBe(2);

    const joinNumsTargets = watCallTargets(ir, watFunction(ir, "joinNums").body);
    expect(count(joinNumsTargets, "__str_concat")).toBe(2);
    expect(count(joinNumsTargets, "number_toString")).toBe(1);
    expect(count(joinNumsTargets, "__ir_number_toString_native")).toBe(0);

    const main = watFunction(ir, "main").body;
    const mainTargets = watCallTargets(ir, main);
    expect(main.match(/\barray\.new_fixed\b/g) ?? []).toHaveLength(2);
    for (const target of ["fibIter", "fibMemo", "binarySearch", "quicksort", "joinNums"] as const) {
      expect(mainTargets).toContain(target);
    }
    expect(mainTargets).toContain("__stdout_append");
    expect(mainTargets).toContain("number_toString");
    expect(mainTargets).not.toContain("__ir_number_toString_native");
    expect(count(mainTargets, "__str_concat_3")).toBe(7);
    expect(count(mainTargets, "__str_concat")).toBe(6);
    expect(ir.wat).toContain("(func $__str_concat_7");
    expect(watCallTargets(ir, watFunction(ir, "__module_init").body)).toEqual(
      watCallTargets(direct, watFunction(direct, "__module_init").body),
    );

    for (const name of BODY_NAMES) {
      expect(watFunction(ir, name).body, `${name} has no generic dispatch`).not.toMatch(
        /\b(?:call_ref|call_indirect)\b/,
      );
    }
    expect(WebAssembly.Module.imports(new WebAssembly.Module(ir.binary))).toEqual([]);
    expect(ir.binary.length).toBeLessThanOrEqual(direct.binary.length);
    expect(gzipSync(ir.binary).length).toBeLessThanOrEqual(gzipSync(direct.binary).length);
    expect(ir.wat.length).toBeLessThanOrEqual(direct.wat.length);
    const irBodies = bodySizeMetrics(ir);
    const directBodies = bodySizeMetrics(direct);
    expect(irBodies.bytes).toBeLessThanOrEqual(directBodies.bytes);
    expect(irBodies.locals).toBeLessThanOrEqual(directBodies.locals);
  });

  it("inlines native number and Map carrier thunks and keeps the off control live", async () => {
    const enabled = await compileAlgorithms(true);
    expectSuccess(enabled);
    for (const name of ["joinNums", "main"] as const) {
      expect(watCallTargets(enabled, watFunction(enabled, name).body)).not.toContain("__ir_number_toString_native");
    }

    const previous = process.env.JS2WASM_IR_INLINE;
    let disabled: CompileResult;
    try {
      process.env.JS2WASM_IR_INLINE = "0";
      disabled = await compile(SOURCE, {
        fileName: "issue-4566-number-format-inline-off.ts",
        target: "standalone",
        hostBridge: "always",
        experimentalIR: true,
        emitWat: true,
      });
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_INLINE");
      else process.env.JS2WASM_IR_INLINE = previous;
    }
    expectSuccess(disabled);
    expect(watCallTargets(disabled, watFunction(disabled, "joinNums").body)).toContain("__ir_number_toString_native");
    expect(watCallTargets(disabled, watFunction(disabled, "main").body)).toContain("__ir_number_toString_native");
    expect(watCallTargets(disabled, watFunction(disabled, "fibMemo").body)).toEqual(
      expect.arrayContaining(["__ir_map_get_num", "__ir_map_set_num"]),
    );
    expect(watCallTargets(disabled, watFunction(disabled, "__module_init").body)).toContain("__ir_map_new");
    expect(await runTwice(disabled)).toBe([...TRACE, ...TRACE].map((line) => `${line}\n`).join(""));
  });

  it("keeps a shared native Map adapter single-level when the raw helper has multiple source sites", async () => {
    const source = `
      const cache = new Map<number, number>();
      function lookup(n: number): number {
        const first = cache.get(n);
        if (first !== undefined) return first;
        const second = cache.get(n + 1);
        if (second !== undefined) return second;
        return -1;
      }
      export function main(): number { return lookup(1); }
    `;
    const [ir, direct] = await Promise.all([
      compile(source, {
        fileName: "issue-4566-native-map-adapter-fanout.ts",
        target: "standalone",
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
      }),
      compile(source, {
        fileName: "issue-4566-native-map-adapter-fanout.ts",
        target: "standalone",
        experimentalIR: false,
        emitWat: true,
      }),
    ]);
    expectSuccess(ir);
    expectSuccess(direct);
    expect(outcome(ir, "function", "lookup")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    const irTargets = watCallTargets(ir, watFunction(ir, "lookup").body);
    const directTargets = watCallTargets(direct, watFunction(direct, "lookup").body);
    for (const target of ["__map_lookup_idx", "__map_get", "__ir_map_get_num"] as const) {
      expect(count(irTargets, target), `${target} fanout matches direct`).toBe(count(directTargets, target));
    }
    expect(count(irTargets, "__map_get")).toBe(2);
    const { instance, module } = await WebAssembly.instantiate(ir.binary, {});
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect((instance.exports.main as () => number)()).toBe(-1);
  });

  it("keeps a nine-operand native concat tree pairwise instead of requesting an unsupported helper", async () => {
    const result = await compile(
      `
        export function joinNine(
          a: string, b: string, c: string, d: string, e: string,
          f: string, g: string, h: string, i: string
        ): string {
          return a + b + c + d + e + f + g + h + i;
        }
      `,
      {
        fileName: "issue-4566-native-concat-arity-cap.ts",
        target: "standalone",
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
      },
    );
    expectSuccess(result);
    expect(outcome(result, "function", "joinNine")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    const targets = watCallTargets(result, watFunction(result, "joinNine").body);
    expect(count(targets, "__str_concat")).toBe(8);
    expect(targets).not.toContain("__str_concat_9");
    expect(result.wat).not.toContain("(func $__str_concat_9");
  });

  it("remaps the native Map carrier through unrelated type churn", async () => {
    const result = await compile(
      `
        function dead(): number {
          class Temp { value: number = 1; }
          return new Temp().value;
        }
        const cache = new Map<number, number>();
        function fibMemo(n: number): number {
          if (n < 2) return n;
          const hit = cache.get(n);
          if (hit !== undefined) return hit;
          const value = fibMemo(n - 1) + fibMemo(n - 2);
          cache.set(n, value);
          return value;
        }
        export function main(): number { return fibMemo(10); }
      `,
      {
        fileName: "issue-4566-native-map-type-remap.ts",
        target: "standalone",
        hostBridge: "always",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );
    expectSuccess(result);
    expect(outcome(result, "function", "dead")).toMatchObject({
      kind: "unsupported",
      code: "body-shape-rejected",
      legacyBodyEmitted: true,
    });
    const prepared = [
      outcome(result, "function", "fibMemo"),
      outcome(result, "function", "main"),
      outcome(result, "module-init", "<module-init>"),
    ];
    expect(new Set(prepared.map(({ preparedComponentId }) => preparedComponentId)).size).toBe(1);
    expect(prepared).toEqual(
      prepared.map((observed) =>
        expect.objectContaining({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        }),
      ),
    );
    const { instance, module } = await WebAssembly.instantiate(result.binary, {});
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    expect((instance.exports.main as () => number)()).toBe(55);
  });

  it("initializes one persistent native Map whose mutations survive export calls", async () => {
    const result = await compile(
      `
        const cache = new Map<number, number>();
        export function touch(): number {
          const cached = cache.get(1);
          if (cached !== undefined) return cached + 1;
          cache.set(1, 1);
          return 0;
        }
      `,
      {
        fileName: "issue-4566-persistent-map.ts",
        target: "standalone",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );
    expectSuccess(result);
    expect(outcome(result, "module-init", "<module-init>")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(outcome(result, "function", "touch")).toMatchObject({
      kind: "unsupported",
      code: "body-shape-rejected",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    const { instance, module } = await WebAssembly.instantiate(result.binary, {});
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const touch = instance.exports.touch as () => number;
    expect(touch()).toBe(0);
    expect(touch()).toBe(2);
  });

  it("fills the early deferred callable with one direct body after a prepared withdrawal", async () => {
    const previous = process.env.JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE;
    let result: CompileResult;
    try {
      process.env.JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE = "1";
      result = await compile(
        `
          const value: number = 7;
          export function read(): number { return value; }
        `,
        {
          fileName: "issue-4566-deferred-withdrawal.ts",
          target: "standalone",
          deferTopLevelInit: true,
          experimentalIR: true,
          trackIrOutcomes: true,
        },
      );
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE");
      } else {
        process.env.JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE = previous;
      }
    }
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irPostClaimErrors?.map((error) => error.func).sort()).toEqual(["<module-init>", "read"]);
    for (const observed of [outcome(result, "module-init", "<module-init>"), outcome(result, "function", "read")]) {
      expect(observed).toMatchObject({
        kind: "unsupported",
        code: "late-preparation-unsupported",
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
    }
    const moduleExports = WebAssembly.Module.exports(new WebAssembly.Module(result.binary));
    expect(moduleExports.filter((entry) => entry.name === "__module_init")).toEqual([
      { name: "__module_init", kind: "function" },
    ]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const read = instance.exports.read as () => number;
    const init = instance.exports.__module_init as () => void;
    expect(() => read()).toThrow();
    init();
    expect(read()).toBe(7);
  });

  it("compiles deferred standalone initialization once while retaining pre-init TDZ guards", async () => {
    const previousFunction = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    const previousModuleInit = process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY;
    let result: CompileResult;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "fibMemo,main";
      process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY = "1";
      result = await compile(SOURCE, {
        fileName: "website/playground/examples/js/algorithms-deferred-poisoned.ts",
        target: "standalone",
        hostBridge: "always",
        deferTopLevelInit: true,
        experimentalIR: true,
        trackIrOutcomes: true,
      });
    } finally {
      if (previousFunction === undefined) {
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      } else {
        process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previousFunction;
      }
      if (previousModuleInit === undefined) {
        Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY");
      } else {
        process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY = previousModuleInit;
      }
    }
    expectSuccess(result);
    const componentIds = new Set<string>();
    for (const [unitKind, displayName] of [
      ["module-init", "<module-init>"],
      ["function", "fibMemo"],
      ["function", "main"],
    ] as const) {
      const observed = outcome(result, unitKind, displayName);
      expect(observed).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      componentIds.add(observed.preparedComponentId!);
    }
    expect(componentIds.size).toBe(1);
    expect(count(watCallTargets(result, watFunction(result, "fibMemo").body), "__new_ReferenceError")).toBe(2);
    const moduleExports = WebAssembly.Module.exports(new WebAssembly.Module(result.binary));
    expect(moduleExports.filter((entry) => entry.name === "__module_init")).toEqual([
      {
        name: "__module_init",
        kind: "function",
      },
    ]);
    const { instance, module } = await WebAssembly.instantiate(result.binary, {});
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const exports = instance.exports as Record<string, unknown>;
    const main = exports.main as () => void;
    const init = exports.__module_init as () => void;
    expect(() => main()).toThrow();
    init();
    expect(() => main()).not.toThrow();
  });
});
