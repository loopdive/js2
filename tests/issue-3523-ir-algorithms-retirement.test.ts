// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3523 Algorithms retirement acceptance coverage.
//
// The complete Algorithms graph, including its once-only Map initializer,
// must seal as one prepared IR component. These tests pin the observable
// trace, persistent Map storage, direct-emitter retirement, and the optimized
// Wasm shapes that the legacy backend used to provide.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE_URL = new URL("../website/playground/examples/js/algorithms.ts", import.meta.url);
const SOURCE = readFileSync(SOURCE_URL, "utf8");

const FUNCTION_TERMINALS = ["fibIter", "fibMemo", "binarySearch", "quicksort", "joinNums", "main"] as const;
const RETIRED_FUNCTIONS = ["fibMemo", "binarySearch", "quicksort", "joinNums", "main"] as const;
const ALL_TERMINALS = [
  ...FUNCTION_TERMINALS.map((displayName) => ({ unitKind: "function" as const, displayName })),
  { unitKind: "module-init" as const, displayName: "<module-init>" },
] as const;
const NEWLY_RETIRED = [
  ...RETIRED_FUNCTIONS.map((displayName) => ({ unitKind: "function" as const, displayName })),
  { unitKind: "module-init" as const, displayName: "<module-init>" },
] as const;

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

let compiledAlgorithms: Promise<CompileResult> | undefined;

function compileAlgorithms(): Promise<CompileResult> {
  compiledAlgorithms ??= compile(SOURCE, {
    fileName: "website/playground/examples/js/algorithms.ts",
    experimentalIR: true,
    trackFallbacks: true,
    trackIrOutcomes: true,
    emitWat: true,
    target: "gc",
  });
  return compiledAlgorithms;
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

function watFunctionBody(wat: string, name: string): string {
  const start = wat.indexOf(`  (func $${name}`);
  expect(start, `missing $${name}`).toBeGreaterThanOrEqual(0);
  const next = wat.indexOf("\n  (func $", start + 1);
  return wat.slice(start, next < 0 ? wat.length : next);
}

interface WatCallSite {
  readonly op: "call" | "return_call";
  readonly target: string;
}

function watCallSites(wat: string, body: string): WatCallSite[] {
  const imports = [...wat.matchAll(/^\s*\(import .+ \(func(?: \$([^\s(]+))?/gm)].map(
    (match) => match[1] ?? "<anonymous-import>",
  );
  const definitions = [...wat.matchAll(/^\s*\(func \$([^\s(]+)/gm)].map((match) => match[1]!);
  const names = [...imports, ...definitions];
  return [...body.matchAll(/\b(return_call|call) (\d+)/g)].map((match) => ({
    op: match[1] as WatCallSite["op"],
    target: names[Number(match[2])] ?? "<missing>",
  }));
}

function semanticTarget(target: string): string {
  return target.endsWith("_import") ? target.slice(0, -"_import".length) : target;
}

function semanticTargets(wat: string, body: string): string[] {
  return watCallSites(wat, body).map(({ target }) => semanticTarget(target));
}

function expectTargetCount(targets: readonly string[], target: string, count: number): void {
  expect(
    targets.filter((candidate) => candidate === target),
    `${target} call count`,
  ).toHaveLength(count);
}

function expectNoGenericBodyMachinery(body: string, targets: readonly string[]): void {
  expect(body).not.toMatch(/\b(?:call_ref|call_indirect)\b/);
  expect(targets).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/(?:^|_)(?:box|unbox|argc|arguments)(?:_|$)/)]),
  );
  expect(targets).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/__extern_(?:get|set|call|method_call|new)/)]),
  );
}

describe("#3523 Algorithms legacy-body retirement", () => {
  it("seals all seven terminals as one prepared IR component and retires the exact final six bodies", async () => {
    const result = await compileAlgorithms();
    expectSuccess(result);

    const observedKeys = (result.irOutcomes ?? [])
      .map(({ unitKind, displayName }) => `${unitKind}:${displayName}`)
      .sort();
    expect(observedKeys).toEqual(ALL_TERMINALS.map(({ unitKind, displayName }) => `${unitKind}:${displayName}`).sort());

    const componentIds = new Set<string>();
    for (const terminal of ALL_TERMINALS) {
      const observed = outcome(result, terminal.unitKind, terminal.displayName);
      expect(observed).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      componentIds.add(observed.preparedComponentId!);
    }
    expect(componentIds.size).toBe(1);

    expect(
      NEWLY_RETIRED.map(({ unitKind, displayName }) => outcome(result, unitKind, displayName)).map(
        ({ unitKind, displayName, legacyBodyEmitted, irBodyEmitted }) => ({
          unitKind,
          displayName,
          legacyBodyEmitted,
          irBodyEmitted,
        }),
      ),
    ).toEqual(
      NEWLY_RETIRED.map(({ unitKind, displayName }) => ({
        unitKind,
        displayName,
        legacyBodyEmitted: false,
        irBodyEmitted: true,
      })),
    );
  });

  it("runs the exact 20-line trace twice while initializing and retaining one shared Map", async () => {
    const result = await compileAlgorithms();
    expectSuccess(result);

    const built = buildImports(result.imports, undefined, result.stringPool);
    const env = built.env as Record<string, (...args: unknown[]) => unknown>;
    const originalNew = env.Map_new!;
    const originalGet = env.Map_get!;
    const originalSet = env.Map_set!;
    const maps: unknown[] = [];
    const receivers: unknown[] = [];
    const logs: string[] = [];
    let getCalls = 0;
    let setCalls = 0;

    env.console_log_string = (value: unknown) => logs.push(String(value));
    env.Map_new = (...args: unknown[]) => {
      const map = originalNew(...args);
      maps.push(map);
      return map;
    };
    env.Map_get = (receiver: unknown, ...args: unknown[]) => {
      getCalls++;
      receivers.push(receiver);
      return originalGet(receiver, ...args);
    };
    env.Map_set = (receiver: unknown, ...args: unknown[]) => {
      setCalls++;
      receivers.push(receiver);
      return originalSet(receiver, ...args);
    };

    const imports: WebAssembly.Imports = { env: built.env, string_constants: built.string_constants };
    imports["wasm:js-string"] = built["wasm:js-string"] as unknown as WebAssembly.ModuleImports;
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    built.setInstance?.(instance);
    built.setExports?.(instance.exports as Record<string, Function>);
    expect(maps, "Map_new runs exactly once during Wasm instantiation").toHaveLength(1);

    const main = instance.exports.main as () => void;
    main();
    expect(logs).toEqual(TRACE);
    const firstGets = getCalls;
    const firstSets = setCalls;
    expect(firstGets).toBeGreaterThan(0);
    expect(firstSets).toBeGreaterThan(0);

    main();
    expect(logs.slice(TRACE.length)).toEqual(TRACE);
    expect(logs).toEqual([...TRACE, ...TRACE]);
    expect(getCalls).toBeGreaterThan(firstGets);
    expect(setCalls, "the second run reuses fibMemo's populated module Map").toBe(firstSets);
    expect(maps).toHaveLength(1);
    expect(receivers.length).toBeGreaterThan(0);
    expect(
      receivers.every((receiver) => receiver === maps[0]),
      "Map_get/Map_set retain one receiver",
    ).toBe(true);
  });

  it("never enters the direct function-body emitter for the five newly retired functions", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    const controlName = "issue3523OrdinaryDirectPoisonControl";
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = RETIRED_FUNCTIONS.join(",");
      const retired = await compile(SOURCE, {
        fileName: "website/playground/examples/js/algorithms-function-poisoned.ts",
        experimentalIR: true,
        trackFallbacks: true,
        trackIrOutcomes: true,
        target: "gc",
      });
      expectSuccess(retired);
      for (const name of RETIRED_FUNCTIONS) {
        expect(outcome(retired, "function", name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
          preparedComponentId: expect.stringMatching(/^prepared-component:/),
        });
      }

      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = controlName;
      const control = await compile(`export function ${controlName}(): number { return 7; }`, {
        fileName: "issue-3523-ordinary-direct-poison-control.ts",
        experimentalIR: false,
        target: "gc",
      });
      expect(control.success).toBe(false);
      expect(control.errors.map((error) => error.message)).toContain(
        `Internal error compiling function '${controlName}': injected direct function-body poison: ${controlName}`,
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previous;
    }
  });

  it("never enters the direct module-init emitter and proves the poison with unsupported Map shapes", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY = "1";
      const retired = await compile(SOURCE, {
        fileName: "website/playground/examples/js/algorithms-module-init-poisoned.ts",
        experimentalIR: true,
        trackFallbacks: true,
        trackIrOutcomes: true,
        target: "gc",
      });
      expectSuccess(retired);
      expect(outcome(retired, "module-init", "<module-init>")).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });

      let controlEvidence = "";
      try {
        const control = await compile(
          `let cache = new Map<number, number>(); export function read(): number { return cache.size; }`,
          {
            fileName: "issue-3523-unsupported-map-poison-control.ts",
            experimentalIR: true,
            trackFallbacks: true,
            trackIrOutcomes: true,
            target: "gc",
          },
        );
        controlEvidence = control.errors.map((error) => error.message).join("\n");
        expect(control.success).toBe(false);
      } catch (error) {
        controlEvidence = error instanceof Error ? error.message : String(error);
      }
      expect(controlEvidence).toContain("injected direct module-init body poison");

      let staticControlEvidence = "";
      try {
        const control = await compile(
          `
            const cache = new Map<number, number>();
            class Box { static value = 42; }
            export function read(): number { return Box.value + cache.size; }
          `,
          {
            fileName: "issue-3523-static-map-poison-control.ts",
            experimentalIR: true,
            trackFallbacks: true,
            trackIrOutcomes: true,
            target: "gc",
          },
        );
        staticControlEvidence = control.errors.map((error) => error.message).join("\n");
        expect(control.success).toBe(false);
      } catch (error) {
        staticControlEvidence = error instanceof Error ? error.message : String(error);
      }
      expect(staticControlEvidence).toContain("injected direct module-init body poison");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY = previous;
    }
  });

  it("preserves the optimized call shapes for string building, integer search, recursion, and vector mutation", async () => {
    const result = await compileAlgorithms();
    expectSuccess(result);

    const mainBody = watFunctionBody(result.wat, "main");
    const mainTargets = semanticTargets(result.wat, mainBody);
    expectTargetCount(mainTargets, "__concat_6", 1);
    expectTargetCount(mainTargets, "__concat_3", 3);
    expectTargetCount(mainTargets, "__concat_4", 0);
    expectTargetCount(mainTargets, "concat", 4);
    expectTargetCount(mainTargets, "fibIter", 2);
    expectTargetCount(mainTargets, "fibMemo", 1);
    expectTargetCount(mainTargets, "binarySearch", 3);
    expectTargetCount(mainTargets, "quicksort", 1);
    expectTargetCount(mainTargets, "joinNums", 3);
    expect(mainBody.match(/\barray\.new_fixed\b/g) ?? []).toHaveLength(2);
    expectNoGenericBodyMachinery(mainBody, mainTargets);

    const binarySearchBody = watFunctionBody(result.wat, "binarySearch");
    const binarySearchTargets = semanticTargets(result.wat, binarySearchBody);
    expect(binarySearchBody).toMatch(/\bi32\.shr_s\b/);
    expect(binarySearchTargets).toEqual([]);
    expectNoGenericBodyMachinery(binarySearchBody, binarySearchTargets);

    const fibMemoBody = watFunctionBody(result.wat, "fibMemo");
    const fibMemoTargets = semanticTargets(result.wat, fibMemoBody);
    // Wasm start runs the prepared initializer before any export is callable,
    // so both module-global memo accesses omit obsolete TDZ/ReferenceError
    // guards while retaining the exact native Map and numeric conversions.
    expect(fibMemoTargets).toEqual([
      "__box_number",
      "Map_get",
      "__extern_is_undefined",
      "__unbox_number",
      "fibMemo",
      "fibMemo",
      "__box_number",
      "__box_number",
      "Map_set",
    ]);
    expect(fibMemoBody).not.toMatch(/\b(?:call_ref|call_indirect)\b/);

    const quicksortBody = watFunctionBody(result.wat, "quicksort");
    const quicksortSites = watCallSites(result.wat, quicksortBody).map(({ op, target }) => ({
      op,
      target: semanticTarget(target),
    }));
    const quicksortTargets = quicksortSites.map(({ target }) => target);
    expect(quicksortTargets.filter((target) => /^__vec_elem_set_\d+$/.test(target))).toHaveLength(4);
    expectTargetCount(quicksortTargets, "quicksort", 2);
    expect(quicksortSites.filter(({ target }) => target === "quicksort").map(({ op }) => op)).toEqual([
      "call",
      "return_call",
    ]);
    expectNoGenericBodyMachinery(quicksortBody, quicksortTargets);

    const joinNumsBody = watFunctionBody(result.wat, "joinNums");
    const joinNumsTargets = semanticTargets(result.wat, joinNumsBody);
    expect(joinNumsBody).toMatch(/\(local \$\$slot_i i32\)/);
    expectTargetCount(joinNumsTargets, "number_toString", 1);
    expectTargetCount(joinNumsTargets, "concat", 2);
    expectNoGenericBodyMachinery(joinNumsBody, joinNumsTargets);

    const moduleInitBody = watFunctionBody(result.wat, "__module_init");
    const moduleInitTargets = semanticTargets(result.wat, moduleInitBody);
    expectTargetCount(moduleInitTargets, "Map_new", 1);
    expect(moduleInitBody).toMatch(/\bglobal\.set\b/);
    expectNoGenericBodyMachinery(moduleInitBody, moduleInitTargets);
  });

  it("batches only maximal concat trees and preserves shared intermediates and two-part calls", async () => {
    const result = await compile(
      `
        export function shared(a: string, b: string, c: string): string {
          const prefix = a + b;
          return prefix + c + prefix;
        }
        export function pair(a: string, b: string): string { return a + b; }
      `,
      {
        fileName: "issue-3523-batched-concat-near-miss.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        emitWat: true,
        target: "gc",
      },
    );
    expectSuccess(result);

    const sharedTargets = semanticTargets(result.wat, watFunctionBody(result.wat, "shared"));
    expectTargetCount(sharedTargets, "concat", 1);
    expectTargetCount(sharedTargets, "__concat_3", 1);
    expect(sharedTargets).not.toEqual(expect.arrayContaining(["__concat_5"]));

    const pairTargets = semanticTargets(result.wat, watFunctionBody(result.wat, "pair"));
    expect(pairTargets).toEqual(["concat"]);

    const built = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, {
      env: built.env,
      "wasm:js-string": built["wasm:js-string"],
      string_constants: built.string_constants,
    });
    built.setInstance?.(instance);
    built.setExports?.(instance.exports as Record<string, Function>);
    expect((instance.exports.shared as (a: string, b: string, c: string) => string)("a", "b", "c")).toBe("abcab");
    expect((instance.exports.pair as (a: string, b: string) => string)("a", "b")).toBe("ab");
  });
});
