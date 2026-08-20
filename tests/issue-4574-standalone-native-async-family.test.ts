// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** #4574 — project the final standalone async playground family onto native IR. */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { evaluateIrOutcomePolicy } from "../src/ir/outcomes.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// The structural parity checks below count named callees. Keep the inliner from
// erasing those names; ownership is decided before this optimization pass.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });

const PLAYGROUND_SOURCE = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");

const RUNTIME_SOURCE = PLAYGROUND_SOURCE.replace("async function fetchUser", "export async function fetchUser")
  .replace("async function fetchAllSequential", "export async function fetchAllSequential")
  .replace("async function fetchAllParallel", "export async function fetchAllParallel");

const ASYNC_OWNERS = ["fetchUser", "fetchAllSequential", "fetchAllParallel", "main"] as const;
const COMPLETE_FAMILY = ["delay", ...ASYNC_OWNERS] as const;

interface TimerJob {
  readonly delay: number;
  readonly id: number;
  readonly ordinal: number;
  readonly phase: "single" | "sequential" | "parallel";
  readonly fire: () => void;
}

interface NativeHarness {
  readonly exports: Record<string, Function>;
  readonly wrappedExports: Record<string, any>;
  readonly jobs: TimerJob[];
  readonly events: string[];
  readonly state: (promise: unknown) => number;
  readonly value: (promise: unknown) => unknown;
  readonly drain: () => void;
  readonly stdout: () => string;
}

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
}

function terminalOutcome(result: CompileResult, displayName: string): IrObservedOutcome {
  const matches = (result.irOutcomes ?? []).filter(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === displayName,
  );
  expect(matches, `terminal outcome count for function:${displayName}`).toHaveLength(1);
  return matches[0]!;
}

function expectNativeAsyncOwnership(result: CompileResult): void {
  for (const name of ASYNC_OWNERS) {
    const observed = terminalOutcome(result, name);
    expect(observed, `${name} runtime fixture ownership:\n${JSON.stringify(observed, null, 2)}`).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
  }
  // `hostBridge: always` below publishes only test-facing vector/stdout
  // boundaries. The async semantics still have exactly one embedder import.
  expect(actualImportNames(result)).toEqual(["env.__timer_set_timeout"]);
}

function actualImportNames(result: CompileResult): readonly string[] {
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map(
    ({ module, name }) => `${module}.${name}`,
  );
}

function numberVec(exports: Record<string, Function>, values: readonly number[]): unknown {
  const allocate = exports.__new_vec_f64 as ((length: number) => unknown) | undefined;
  const set = exports.__vec_set_byte as ((vec: unknown, index: number, value: number) => void) | undefined;
  const get = exports.__vec_get as ((vec: unknown, index: number) => unknown) | undefined;
  expect(allocate, "numeric vector boundary allocator was not exported").toBeTypeOf("function");
  expect(set, "numeric vector boundary setter was not exported").toBeTypeOf("function");
  expect(get, "numeric vector boundary reader was not exported").toBeTypeOf("function");
  const vec = allocate!(values.length);
  values.forEach((value, index) => set!(vec, index, value));
  values.forEach((value, index) => expect(get!(vec, index), `numeric vector read ${index}`).toBe(value));
  return vec;
}

function wasmFunctionCount(result: CompileResult): number {
  return [...result.wat.matchAll(/^\s*(?:\(import .+ )?\(func(?:\s|\$)/gm)].length;
}

function watFunctionNames(wat: string): readonly string[] {
  return [...wat.matchAll(/\(func \$([^\s(]+)/g)].map((match) => match[1]!);
}

function extractParenthesizedForm(wat: string, marker: string): string {
  const start = wat.indexOf(marker);
  if (start < 0) throw new Error(`missing WAT form ${marker}`);
  let depth = 0;
  for (let index = start; index < wat.length; index++) {
    if (wat[index] === "(") depth++;
    else if (wat[index] === ")" && --depth === 0) return wat.slice(start, index + 1);
  }
  throw new Error(`unterminated WAT form ${marker}`);
}

function extractFunctionBody(wat: string, name: string): string {
  return extractParenthesizedForm(wat, `(func $${name}`);
}

function familyBody(wat: string, owner: string): string {
  const names = watFunctionNames(wat).filter((name) => name.includes(owner));
  expect(names, `missing ${owner} WAT family`).not.toEqual([]);
  return names.map((name) => extractFunctionBody(wat, name)).join("\n");
}

function functionIndices(wat: string, predicate: (name: string) => boolean): readonly number[] {
  return watFunctionNames(wat).flatMap((name, index) => (predicate(name) ? [index] : []));
}

function callCount(body: string, indices: readonly number[]): number {
  return indices.reduce(
    (total, index) => total + [...body.matchAll(new RegExp(`\\b(?:return_call|call) ${index}\\b`, "g"))].length,
    0,
  );
}

function callsToName(wat: string, body: string, name: string): number {
  const indices = functionIndices(wat, (candidate) => candidate === name);
  expect(indices, `missing WAT target ${name}`).not.toEqual([]);
  return callCount(body, indices);
}

function callsToMatching(wat: string, body: string, pattern: RegExp, detail: string): number {
  const indices = functionIndices(wat, (name) => pattern.test(name));
  expect(indices, `missing WAT target family ${detail}`).not.toEqual([]);
  return callCount(body, indices);
}

async function compileTracked(source: string, fileName: string, experimentalIR = true): Promise<CompileResult> {
  return compile(source, {
    fileName,
    target: "standalone",
    experimentalIR,
    trackFallbacks: true,
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    emitWat: true,
  });
}

async function compileRuntimeTracked(source: string, fileName: string): Promise<CompileResult> {
  return compile(source, {
    fileName,
    target: "standalone",
    // Publish numeric-vector and host-free stdout readout exports so the test
    // can drive exact functions. Ownership/import assertions above prevent
    // this instrumentation from silently selecting JS-host Promise semantics.
    hostBridge: "always",
    experimentalIR: true,
    trackFallbacks: true,
    trackIrOutcomes: true,
    skipSemanticDiagnostics: true,
    emitWat: true,
  });
}

let exactCompilation: Promise<CompileResult> | undefined;
function compileExact(): Promise<CompileResult> {
  exactCompilation ??= compileTracked(PLAYGROUND_SOURCE, "website/playground/examples/js/async.ts");
  return exactCompilation;
}

let runtimeCompilation: Promise<CompileResult> | undefined;
function compileRuntimeFixture(): Promise<CompileResult> {
  runtimeCompilation ??= compileRuntimeTracked(RUNTIME_SOURCE, "issue-4574-standalone-native-async-runtime.ts");
  return runtimeCompilation;
}

function expectedId(ids: readonly number[], ordinal: number): number {
  if (ids.length === 0) throw new Error("a timer was scheduled for an empty fixture");
  return ids[ordinal % ids.length]!;
}

function expectedPhase(ids: readonly number[], ordinal: number, mode: TimerJob["phase"] | "main"): TimerJob["phase"] {
  if (mode !== "main") return mode;
  return ordinal < ids.length ? "sequential" : "parallel";
}

async function instantiateControlled(
  result: CompileResult,
  ids: readonly number[],
  options: {
    readonly autoFireReverseAt?: number;
    readonly phase?: TimerJob["phase"] | "main";
    readonly rejectRegistrationAt?: number;
  } = {},
): Promise<NativeHarness> {
  const jobs: TimerJob[] = [];
  const events: string[] = [];
  let registrations = 0;
  const capturedSetTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const ordinal = registrations++;
    const id = expectedId(ids, ordinal);
    const phase = expectedPhase(ids, ordinal, options.phase ?? "single");
    events.push(`${phase}:start:${id}`);
    if (ordinal === options.rejectRegistrationAt) {
      events.push(`${phase}:registration-reject:${id}`);
      throw new Error(`injected timer registration failure at ${ordinal}`);
    }
    let firings = 0;
    const job: TimerJob = {
      delay: Number(delay ?? 0),
      id,
      ordinal,
      phase,
      fire: () => {
        events.push(`${phase}:${firings++ === 0 ? "fire" : "repeat"}:${id}`);
        callback(...args);
      },
    };
    jobs.push(job);
    if (registrations === options.autoFireReverseAt) {
      for (let index = jobs.length - 1; index >= 0; index--) jobs[index]!.fire();
    }
    return (ordinal + 1) as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  const imports = buildCompiledImports(result, { setTimeout: capturedSetTimeout });
  expectNativeAsyncOwnership(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  const exports = instance.exports as unknown as Record<string, Function>;
  const wrappedExports = wrapCompiledExports(result, instance);
  const state = exports.__promise_boundary_state as ((promise: unknown) => number) | undefined;
  const value = exports.__promise_boundary_value as ((promise: unknown) => unknown) | undefined;
  const drain = exports.__drain_microtasks as (() => void) | undefined;
  const prepare = exports.__stdout_prepare as (() => number) | undefined;
  const charAt = exports.__stdout_char as ((index: number) => number) | undefined;
  expect(state, "native Promise state boundary was not exported").toBeTypeOf("function");
  expect(value, "native Promise value boundary was not exported").toBeTypeOf("function");
  expect(drain, "native microtask drain was not exported").toBeTypeOf("function");
  expect(prepare, "standalone stdout readout was not exported").toBeTypeOf("function");
  expect(charAt, "standalone stdout character readout was not exported").toBeTypeOf("function");
  return {
    exports,
    wrappedExports,
    jobs,
    events,
    state: state!,
    value: value!,
    drain: drain!,
    stdout: () => {
      const length = prepare!();
      let output = "";
      for (let index = 0; index < length; index++) output += String.fromCharCode(charAt!(index));
      return output;
    },
  };
}

describe("#4574 standalone native async-family ownership", () => {
  it("IR-emits every exact async owner once and leaves only the explicit timer capability", async () => {
    const result = await compileExact();
    expectSuccess(result);

    for (const name of COMPLETE_FAMILY) {
      expect(terminalOutcome(result, name)).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });
      expect(
        result.irCompiledFuncs?.filter((candidate) => candidate === name),
        `${name} IR body count`,
      ).toHaveLength(1);
      expect(
        result.irFirstSkipped?.filter((candidate) => candidate === name),
        `${name} direct skip count`,
      ).toHaveLength(1);
    }

    const stateCounts = new Map<string, number>([
      ["fetchUser", 2],
      ["fetchAllSequential", 5],
      ["fetchAllParallel", 2],
      ["main", 3],
    ]);
    for (const [name, expected] of stateCounts) {
      expect(
        result.irCompiledFuncs?.filter((candidate) => candidate.startsWith(`${name}__ir_async_state_`)),
        `${name} prepared state count`,
      ).toHaveLength(expected);
    }

    const asyncOutcomes = ASYNC_OWNERS.map((name) => terminalOutcome(result, name));
    expect(evaluateIrOutcomePolicy(asyncOutcomes, "ir-only")).toMatchObject({ ready: true, blockers: [] });
    expect(
      (result.irOutcomes ?? []).filter(
        ({ displayName, stage, code }) =>
          ASYNC_OWNERS.includes(displayName as (typeof ASYNC_OWNERS)[number]) &&
          stage === "select" &&
          code === "async-function",
      ),
    ).toEqual([]);

    expect(actualImportNames(result)).toEqual(["env.__timer_set_timeout"]);
    expect(result.imports.map(({ module, name }) => `${module}.${name}`)).toEqual(["env.__timer_set_timeout"]);
    expect(result.capabilityProviderDiagnostics).toEqual([]);
    expect(result.capabilityRequirements).toEqual([
      expect.objectContaining({
        id: "timers",
        selectedProviders: ["embedder"],
        imports: [expect.objectContaining({ module: "env", name: "__timer_set_timeout", kind: "func" })],
      }),
    ]);
    for (const retiredHostAdapter of [
      "env.Promise_new_pending",
      "env.Promise_then2",
      "env.Promise_settle_resolve",
      "env.Promise_settle_reject",
      "env.Promise_all",
      "env.__box_number",
      "env.__unbox_number",
      "env.__date_now",
      "env.console_log_string",
    ]) {
      expect(actualImportNames(result)).not.toContain(retiredHostAdapter);
    }
  });

  it("keeps the IR artifact no larger than the legacy direct control", async () => {
    // Structural assertions pin the inliner off, but artifact parity must
    // measure the shipped tuned default. Temporarily opt this fresh pair back
    // into inlining; restore the file-wide shape pin before leaving the test.
    const previous = process.env.JS2WASM_IR_INLINE;
    Reflect.deleteProperty(process.env, "JS2WASM_IR_INLINE");
    try {
      const [ir, direct] = await Promise.all([
        compileTracked(PLAYGROUND_SOURCE, "issue-4574-standalone-async-artifact-ir.ts"),
        compileTracked(PLAYGROUND_SOURCE, "issue-4574-standalone-async-artifact-direct.ts", false),
      ]);
      expectSuccess(ir);
      expectSuccess(direct);

      // Keep all three deltas visible in one red run. A first failing size
      // assertion must not silently hide retained WAT or helper-count cost.
      expect.soft(ir.binary.byteLength).toBeLessThanOrEqual(direct.binary.byteLength);
      expect.soft(ir.wat.length).toBeLessThanOrEqual(direct.wat.length);
      expect.soft(wasmFunctionCount(ir)).toBeLessThanOrEqual(wasmFunctionCount(direct));
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_INLINE");
      else process.env.JS2WASM_IR_INLINE = previous;
    }
  });

  it("executes tuned async native number-string carrier fusion", async () => {
    const previous = process.env.JS2WASM_IR_INLINE;
    Reflect.deleteProperty(process.env, "JS2WASM_IR_INLINE");
    try {
      const result = await compileRuntimeTracked(RUNTIME_SOURCE, "issue-4574-standalone-async-number-string-fusion.ts");
      expectSuccess(result);
      const mainFamily = familyBody(result.wat, "main");
      const rawNumberToString = functionIndices(result.wat, (name) => name === "number_toString");
      expect(rawNumberToString).toHaveLength(1);
      const rawCalls = callCount(mainFamily, rawNumberToString);
      expect(rawCalls).toBeGreaterThanOrEqual(4);
      expect(
        [
          ...mainFamily.matchAll(
            new RegExp(`\\bcall ${rawNumberToString[0]}\\n\\s+any\\.convert_extern\\n\\s+ref\\.cast`, "g"),
          ),
        ],
        "each tuned async number formatter call restores the native string carrier",
      ).toHaveLength(rawCalls);
      expect(result.wat).not.toContain("(func $__ir_number_toString_native");

      const harness = await instantiateControlled(result, [1, 2, 3, 4, 5], { phase: "main" });
      const promise = (harness.exports.main as () => unknown)();
      for (let index = 0; index < 5; index++) harness.jobs[index]!.fire();
      for (let index = 9; index >= 5; index--) harness.jobs[index]!.fire();
      expect(harness.state(promise)).toBe(1);
      expect(harness.stdout()).toBe(
        "async/await demo\n" + "sequential sum = 150 (took ~0ms)\n" + "parallel  sum = 150 (took ~0ms)\n" + "done\n",
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IR_INLINE");
      else process.env.JS2WASM_IR_INLINE = previous;
    }
  });

  it("keeps the grounded loop, Promise.all, and main logging optimizations in their IR states", async () => {
    const result = await compileExact();
    expectSuccess(result);

    const sequentialStates = Array.from({ length: 5 }, (_, state) =>
      extractFunctionBody(result.wat, `fetchAllSequential__ir_async_state_${state}`),
    ).join("\n");
    const sequentialFamily = familyBody(result.wat, "fetchAllSequential");
    expect(sequentialStates.match(/\barray\.get\b/g)).toHaveLength(1);
    expect(sequentialStates.match(/\bf64\.add\b/g)).toHaveLength(1);
    expect(sequentialStates.match(/\bi32\.add\b/g)).toHaveLength(1);
    expect(sequentialStates.match(/\bi32\.lt_[su]\b/g)).toHaveLength(1);
    expect(sequentialStates).not.toMatch(/f64\.convert_i32|i32\.trunc_f64/);
    expect(callsToName(result.wat, sequentialFamily, "fetchUser")).toBe(1);
    const sequentialFrame = extractParenthesizedForm(result.wat, "(type $$AsyncFrame_fetchAllSequential__ir");
    expect(sequentialFrame.match(/\(field \$spill_[^ ]+ \(mut f64\)\)/g)).toHaveLength(1);
    expect(sequentialFrame.match(/\(field \$spill_[^ ]+ \(mut i32\)\)/g)).toHaveLength(1);

    const parallelEntry = extractFunctionBody(result.wat, "fetchAllParallel__ir_async_state_0");
    const parallelContinuation = extractFunctionBody(result.wat, "fetchAllParallel__ir_async_state_1");
    const parallelFamily = familyBody(result.wat, "fetchAllParallel");
    expect(parallelEntry.match(/\barray\.new_fixed\b/g)).toHaveLength(1);
    expect(callsToName(result.wat, parallelFamily, "fetchUser")).toBe(1);
    expect(callsToMatching(result.wat, parallelFamily, /promise.*all/i, "native Promise.all")).toBe(1);
    const allFulfill = extractFunctionBody(result.wat, "__combinator_all_fulfill");
    // The Promise.all fulfillment callback stores `value` through the index
    // captured for that input, rather than through completion order. Generic
    // Promise.all value coverage remains in #2867 and #4110; this pins the
    // native helper actually linked by the final standalone family.
    expect(allFulfill).toMatch(
      /local\.tee 2\s+struct\.get \d+ 0\s+local\.tee 3\s+struct\.get \d+ 1\s+local\.get 2\s+struct\.get \d+ 1\s+local\.get 1\s+array\.set/,
    );
    expect(parallelContinuation.match(/\barray\.get\b/g)).toHaveLength(1);
    expect(parallelContinuation.match(/\bf64\.add\b/g)).toHaveLength(1);
    // This is the exact existing #4110 host-IR shape: both i32 operands are
    // widened for the numeric length comparison, without a narrowing roundtrip.
    expect(parallelContinuation.match(/\bf64\.convert_i32_s\b/g)).toHaveLength(2);
    expect(parallelContinuation).not.toMatch(/i32\.trunc_f64/);

    const mainFamily = familyBody(result.wat, "main");
    const mainStates = Array.from({ length: 3 }, (_, state) =>
      extractFunctionBody(result.wat, `main__ir_async_state_${state}`),
    ).join("\n");
    const mainResume = extractFunctionBody(result.wat, "__async_resume_fmain__ir");
    expect(mainFamily.match(/\barray\.new_fixed\b/g)).toHaveLength(1);
    expect(mainFamily.match(/\bf64\.sub\b/g)).toHaveLength(2);
    expect(callsToName(result.wat, mainFamily, "fetchAllSequential")).toBe(1);
    expect(callsToName(result.wat, mainFamily, "fetchAllParallel")).toBe(1);
    expect(callsToMatching(result.wat, mainFamily, /__str_concat_5/, "native five-part concat")).toBe(2);
    expect(callsToMatching(result.wat, mainFamily, /number_toString/, "specialized number toString")).toBe(4);
    expect(callsToMatching(result.wat, mainFamily, /__stdout_append/, "standalone stdout sink")).toBe(4);
    const clockProviderIndices = functionIndices(result.wat, (name) => /clock_snapshot|date_now/.test(name));
    expect(callCount(mainFamily, clockProviderIndices)).toBe(0);
    expect(mainFamily.match(/\bf64\.const 0\b/g)).toHaveLength(4);
    expect(mainStates).not.toMatch(/f64\.convert_i32|i32\.trunc_f64/);
    // Each native Promise fulfillment has one inlined i31-number fast arm.
    // These are the two required externref-to-f64 conversions, not loop or
    // timestamp carrier roundtrips.
    expect(mainResume.match(/\bf64\.convert_i32_s\b/g)).toHaveLength(2);
    expect(mainResume).not.toMatch(/i32\.trunc_f64/);
  });
});

describe("#4574 standalone native async-family behavior", () => {
  it("suspends fetchUser on the native delay and resumes with its numeric value", async () => {
    const result = await compileRuntimeFixture();
    expectSuccess(result);
    const harness = await instantiateControlled(result, [7], { phase: "single" });
    const run = harness.exports.fetchUser as (id: number) => unknown;
    expect(run).toBeTypeOf("function");

    const promise = run(7);
    expect(harness.jobs).toHaveLength(1);
    expect(harness.jobs[0]!.delay).toBe(30);
    expect(harness.state(promise)).toBe(0);
    expect(harness.value(promise)).toBeNull();

    harness.jobs[0]!.fire();
    expect(harness.state(promise)).toBe(1);
    expect(harness.value(promise)).toBe(70);
    expect(harness.events).toEqual(["single:start:7", "single:fire:7"]);
  });

  it("normalizes a non-i31 fetchUser fulfillment through the real JS Promise boundary", async () => {
    const result = await compileRuntimeFixture();
    expectSuccess(result);
    const id = 300_000_000;
    const harness = await instantiateControlled(result, [id], {
      autoFireReverseAt: 1,
      phase: "single",
    });
    const run = harness.wrappedExports.fetchUser as (id: number) => Promise<number>;
    expect(run).toBeTypeOf("function");

    // 3_000_000_000 cannot use the native i31 fast carrier. This therefore
    // proves wrapCompiledExports recognizes and unboxes `$BoxedNumber` when a
    // settled Wasm-owned Promise crosses the standalone JS boundary.
    await expect(run(id)).resolves.toBe(3_000_000_000);
    expect(harness.events).toEqual([`single:start:${id}`, `single:fire:${id}`]);
  });

  it("starts each sequential request only after the prior timer fulfills", async () => {
    const result = await compileRuntimeFixture();
    expectSuccess(result);
    const harness = await instantiateControlled(result, [3, 1, 2], { phase: "sequential" });
    const run = harness.exports.fetchAllSequential as (ids: unknown) => unknown;
    expect(run).toBeTypeOf("function");

    const promise = run(numberVec(harness.exports, [3, 1, 2]));
    expect(harness.state(promise)).toBe(0);
    expect(harness.jobs).toHaveLength(1);
    for (let iteration = 0; iteration < 3; iteration++) {
      expect(harness.jobs).toHaveLength(iteration + 1);
      expect(harness.state(promise)).toBe(0);
      harness.jobs[iteration]!.fire();
      if (iteration === 0) {
        // A hostile embedder may invoke a nominally one-shot callback twice.
        // The settled delay and outer continuation must both ignore it.
        harness.jobs[iteration]!.fire();
        expect(harness.jobs).toHaveLength(2);
        expect(harness.state(promise)).toBe(0);
      }
    }

    expect(harness.state(promise)).toBe(1);
    expect(harness.value(promise)).toBe(60);
    expect(harness.events).toEqual([
      "sequential:start:3",
      "sequential:fire:3",
      "sequential:start:1",
      "sequential:repeat:3",
      "sequential:fire:1",
      "sequential:start:2",
      "sequential:fire:2",
    ]);

    // Retain the embedder callback itself and invoke it after the complete
    // outer chain has settled. A Promise one-shot guard must make this a true
    // no-op: no second continuation, no new timer, and no value mutation.
    harness.jobs[0]!.fire();
    expect(harness.jobs).toHaveLength(3);
    expect(harness.state(promise)).toBe(1);
    expect(harness.value(promise)).toBe(60);
    expect(harness.events.at(-1)).toBe("sequential:repeat:3");
  });

  it("fans out Promise.all eagerly and settles after reverse-order fulfillment", async () => {
    const result = await compileRuntimeFixture();
    expectSuccess(result);
    const ids = [3, 1, 2] as const;
    const harness = await instantiateControlled(result, ids, { phase: "parallel" });
    const run = harness.exports.fetchAllParallel as (ids: unknown) => unknown;
    expect(run).toBeTypeOf("function");

    const promise = run(numberVec(harness.exports, ids));
    expect(harness.jobs).toHaveLength(3);
    expect(harness.jobs.map(({ delay }) => delay)).toEqual([30, 30, 30]);
    expect(harness.state(promise)).toBe(0);

    harness.jobs[2]!.fire();
    expect(harness.state(promise)).toBe(0);
    harness.jobs[1]!.fire();
    expect(harness.state(promise)).toBe(0);
    harness.jobs[0]!.fire();
    expect(harness.state(promise)).toBe(1);
    expect(harness.value(promise)).toBe(60);
    expect(harness.events).toEqual([
      "parallel:start:3",
      "parallel:start:1",
      "parallel:start:2",
      "parallel:fire:2",
      "parallel:fire:1",
      "parallel:fire:3",
    ]);
  });

  it("settles both empty aggregate paths without scheduling a timer", async () => {
    const result = await compileRuntimeFixture();
    expectSuccess(result);
    const harness = await instantiateControlled(result, []);
    const empty = numberVec(harness.exports, []);
    const sequential = (harness.exports.fetchAllSequential as (ids: unknown) => unknown)(empty);
    // This path reaches `return total` without executing an await. Like a JS
    // async function, its outer Promise may already be internally fulfilled;
    // reaction callbacks remain microtasks.
    expect(harness.state(sequential)).toBe(1);
    expect(harness.value(sequential)).toBe(0);

    const parallel = (harness.exports.fetchAllParallel as (ids: unknown) => unknown)(empty);

    expect(harness.jobs).toEqual([]);
    expect(harness.state(sequential)).toBe(1);
    expect(harness.value(sequential)).toBe(0);
    // Promise.all([]) is fulfilled immediately, but `await` must still resume
    // this async function through the native microtask queue.
    expect(harness.state(parallel)).toBe(0);
    expect(harness.value(parallel)).toBeNull();

    harness.drain();
    expect(harness.state(sequential)).toBe(1);
    expect(harness.value(sequential)).toBe(0);
    expect(harness.state(parallel)).toBe(1);
    expect(harness.value(parallel)).toBe(0);
  });

  it("propagates a later sequential registration failure and never starts iteration three", async () => {
    const result = await compileRuntimeFixture();
    expectSuccess(result);
    const harness = await instantiateControlled(result, [3, 1, 2], {
      phase: "sequential",
      rejectRegistrationAt: 1,
    });
    const promise = (harness.exports.fetchAllSequential as (ids: unknown) => unknown)(
      numberVec(harness.exports, [3, 1, 2]),
    );
    expect(harness.jobs).toHaveLength(1);
    expect(harness.state(promise)).toBe(0);

    harness.jobs[0]!.fire();
    expect(harness.jobs).toHaveLength(1);
    expect(harness.state(promise)).toBe(2);
    // The single-import timer capability deliberately represents a foreign JS
    // registration exception with the documented null rejection sentinel.
    expect(harness.value(promise)).toBeNull();
    expect(harness.events).toEqual([
      "sequential:start:3",
      "sequential:fire:3",
      "sequential:start:1",
      "sequential:registration-reject:1",
    ]);
  });

  it("rejects Promise.all on the first error after still starting every source iteration", async () => {
    const result = await compileRuntimeFixture();
    expectSuccess(result);
    const ids = [3, 1, 2] as const;
    const harness = await instantiateControlled(result, ids, {
      phase: "parallel",
      rejectRegistrationAt: 1,
    });
    const promise = (harness.exports.fetchAllParallel as (ids: unknown) => unknown)(numberVec(harness.exports, ids));
    harness.drain();

    expect(harness.jobs.map(({ id }) => id)).toEqual([3, 2]);
    expect(harness.state(promise)).toBe(2);
    expect(harness.value(promise)).toBeNull();
    expect(harness.events).toEqual([
      "parallel:start:3",
      "parallel:start:1",
      "parallel:registration-reject:1",
      "parallel:start:2",
    ]);

    for (const job of harness.jobs) job.fire();
    expect(harness.state(promise)).toBe(2);
    expect(harness.value(promise)).toBeNull();
  });

  it("runs main sequentially, then fans out, then logs and fulfills exactly once", async () => {
    const result = await compileRuntimeFixture();
    expectSuccess(result);
    const harness = await instantiateControlled(result, [1, 2, 3, 4, 5], { phase: "main" });
    const main = harness.exports.main as () => unknown;
    expect(main).toBeTypeOf("function");

    const promise = main();
    expect(harness.state(promise)).toBe(0);
    expect(harness.jobs).toHaveLength(1);
    expect(harness.stdout()).toBe("async/await demo\n");

    for (let index = 0; index < 5; index++) {
      harness.jobs[index]!.fire();
      expect(harness.jobs).toHaveLength(index === 4 ? 10 : index + 2);
      if (index < 4) expect(harness.state(promise)).toBe(0);
    }
    expect(harness.events.filter((event) => event.startsWith("parallel:start:"))).toEqual([
      "parallel:start:1",
      "parallel:start:2",
      "parallel:start:3",
      "parallel:start:4",
      "parallel:start:5",
    ]);
    expect(harness.stdout()).toBe("async/await demo\nsequential sum = 150 (took ~0ms)\n");

    for (let index = 9; index >= 6; index--) {
      harness.jobs[index]!.fire();
      expect(harness.state(promise)).toBe(0);
    }
    harness.jobs[5]!.fire();
    expect(harness.state(promise)).toBe(1);
    const fulfillment = harness.value(promise);
    const dynamicBoundaryTag = harness.exports.__dynamic_boundary_tag as ((value: unknown) => number) | undefined;
    expect(dynamicBoundaryTag, "native undefined boundary classifier was not exported").toBeTypeOf("function");
    expect(fulfillment).not.toBeNull();
    expect(dynamicBoundaryTag!(fulfillment), "main must fulfill with undefined (tag 2), not null (tag 1)").toBe(2);
    expect(harness.stdout()).toBe(
      "async/await demo\n" + "sequential sum = 150 (took ~0ms)\n" + "parallel  sum = 150 (took ~0ms)\n" + "done\n",
    );
    expect(harness.events.slice(-5)).toEqual([
      "parallel:fire:5",
      "parallel:fire:4",
      "parallel:fire:3",
      "parallel:fire:2",
      "parallel:fire:1",
    ]);
  });
});

describe("#4574 standalone native async-family IR-only shadow", () => {
  it("keeps a source near miss on legacy ownership and blocks IR-only policy", async () => {
    const nearMissSource = PLAYGROUND_SOURCE.replace(
      "total = total + (await fetchUser(ids[i]));",
      "total = total + (await fetchUser(ids[i])) + 0;",
    );
    const result = await compileTracked(nearMissSource, "issue-4574-sequential-near-miss.ts");
    expectSuccess(result);
    const sequential = terminalOutcome(result, "fetchAllSequential");
    expect(sequential).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(evaluateIrOutcomePolicy([sequential], "ir-only").ready).toBe(false);
  });

  it("bypasses direct async emission for the exact family while the near-miss poison fires", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_ASYNC_BODY;
    process.env.JS2WASM_TEST_POISON_DIRECT_ASYNC_BODY = "1";
    try {
      const exact = await compileTracked(PLAYGROUND_SOURCE, "issue-4574-ir-only-shadow-exact.ts");
      expectSuccess(exact);
      for (const name of ASYNC_OWNERS) {
        expect(terminalOutcome(exact, name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
        });
      }

      const nearMiss = await compileTracked(
        PLAYGROUND_SOURCE.replace(
          "total = total + (await fetchUser(ids[i]));",
          "total = total + (await fetchUser(ids[i])) + 0;",
        ),
        "issue-4574-ir-only-shadow-control.ts",
      );
      expect(nearMiss.success).toBe(false);
      expect(nearMiss.errors.map(({ message }) => message).join("\n")).toContain(
        "direct async body poison reached fetchAllSequential",
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_ASYNC_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_ASYNC_BODY = previous;
    }
  });
});
