// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** #4124 — final async terminal owners: sequential loop and exported main. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { evaluateIrOutcomePolicy } from "../src/ir/outcomes.js";
import { buildImports } from "../src/runtime.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// (#4157) "free of redundant carrier/bounds traffic" and "preserves main's
// direct-callee shapes" are asserted by locating named callees and counting
// their sites in the emitted WAT. The IR inliner (default ON since the
// tuned-set flip) splices those callees in, so the named state is not found at
// all. Pin it off; the ownership/optimization parity here is an IR property.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });

const PLAYGROUND_SOURCE = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
const REPO_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

const EXACT_SEQUENTIAL_SOURCE = `
  function delay(ms: number, value: number): Promise<number> {
    return new Promise<number>((resolve) => {
      setTimeout(() => resolve(value), ms);
    });
  }

  async function fetchUser(id: number): Promise<number> {
    const v = await delay(30, id * 10);
    return v;
  }

  export async function fetchAllSequential(ids: number[]): Promise<number> {
    let total = 0;
    for (let i = 0; i < ids.length; i++) {
      total = total + (await fetchUser(ids[i]));
    }
    return total;
  }
`;

type TimerJob = {
  readonly id: number;
  readonly phase: "sequential" | "parallel";
  readonly fire: () => void;
};

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
}

async function compileTracked(source: string, fileName: string): Promise<CompileResult> {
  return compile(source, { fileName, target: "gc", emitWat: true, trackIrOutcomes: true });
}

let playgroundCompilation: Promise<CompileResult> | undefined;
function compilePlayground(): Promise<CompileResult> {
  playgroundCompilation ??= compileTracked(PLAYGROUND_SOURCE, "website/playground/examples/js/async.ts");
  return playgroundCompilation;
}

let sequentialCompilation: Promise<CompileResult> | undefined;
function compileSequential(): Promise<CompileResult> {
  sequentialCompilation ??= compileTracked(EXACT_SEQUENTIAL_SOURCE, "issue-4124-sequential-runtime.ts");
  return sequentialCompilation;
}

function numberVec(exports: WebAssembly.Exports, values: readonly number[]): unknown {
  const allocate = exports.__new_vec_f64 as ((length: number) => unknown) | undefined;
  const set = exports.__vec_set_byte as ((vec: unknown, index: number, value: number) => void) | undefined;
  const get = exports.__vec_get as ((vec: unknown, index: number) => unknown) | undefined;
  if (!allocate || !set || !get) throw new Error("numeric vector host bridge exports are unavailable");
  const vec = allocate(values.length);
  values.forEach((value, index) => set(vec, index, value));
  values.forEach((value, index) => {
    if (get(vec, index) !== value) throw new Error(`numeric vector bridge lost element ${index}`);
  });
  return vec;
}

async function settled<T>(value: T | Promise<T>, ms = 4000): Promise<T> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("async result never settled")), ms);
      }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
}

async function expectPending(value: Promise<unknown>): Promise<void> {
  const state = await Promise.race([
    value.then(
      () => "fulfilled",
      () => "rejected",
    ),
    Promise.resolve("pending"),
  ]);
  expect(state).toBe("pending");
}

async function waitUntil(predicate: () => boolean, detail: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${detail}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function buildControlledTimerImports(
  result: CompileResult,
  ids: readonly number[],
  onStart: (job: Pick<TimerJob, "id" | "phase">) => void,
  onFire: (job: Pick<TimerJob, "id" | "phase">) => void,
  deps?: Record<string, unknown>,
): { readonly imports: ReturnType<typeof buildImports>; readonly jobs: TimerJob[] } {
  const jobs: TimerJob[] = [];
  let started = 0;
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: TimerHandler, _ms?: number, ...args: unknown[]) => {
    if (typeof callback !== "function") throw new TypeError("controlled timer received a non-function callback");
    const ordinal = started++;
    const id = ids[ordinal % ids.length]!;
    const phase = ordinal < ids.length ? "sequential" : "parallel";
    const job: TimerJob = {
      id,
      phase,
      fire: () => {
        onFire({ id, phase });
        callback(...args);
      },
    };
    jobs.push(job);
    onStart({ id, phase });
    return job as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    return { imports: buildImports(result.imports, deps, result.stringPool), jobs };
  } finally {
    globalThis.setTimeout = nativeSetTimeout;
  }
}

function trackOuterSettlement(env: Record<string, (...args: unknown[]) => unknown>) {
  const newPending = env.Promise_new_pending;
  const settleResolve = env.Promise_settle_resolve;
  const settleReject = env.Promise_settle_reject;
  if (!newPending || !settleResolve || !settleReject) throw new Error("prepared async settlement adapters are missing");
  let outer: unknown;
  let resolves = 0;
  let rejects = 0;
  env.Promise_new_pending = (...args) => newPending(...args);
  env.Promise_settle_resolve = (...args) => {
    if (args[0] === outer) resolves++;
    return settleResolve(...args);
  };
  env.Promise_settle_reject = (...args) => {
    if (args[0] === outer) rejects++;
    return settleReject(...args);
  };
  return {
    bind(value: unknown): void {
      outer = value;
    },
    counts(): { readonly resolves: number; readonly rejects: number } {
      return { resolves, rejects };
    },
  };
}

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const found = (result.irOutcomes ?? []).find((candidate) => candidate.displayName === name);
  if (!found) throw new Error(`missing IR outcome for ${name}`);
  return found;
}

function expectPreparedOwner(result: CompileResult, name: string): void {
  expect(outcome(result, name)).toMatchObject({
    kind: "emitted",
    legacyBodyEmitted: false,
    irBodyEmitted: true,
    preparedComponentId: expect.stringMatching(/^prepared-component:/),
  });
}

function watFunctionNames(wat: string): string[] {
  return [...wat.matchAll(/\(func \$([^\s(]+)/g)].map((match) => match[1]!);
}

function extractFunctionBody(wat: string, name: string): string {
  const marker = `(func $${name}`;
  const start = wat.indexOf(marker);
  if (start < 0) throw new Error(`missing WAT function ${name}`);
  let depth = 0;
  for (let index = start; index < wat.length; index++) {
    if (wat[index] === "(") depth++;
    else if (wat[index] === ")" && --depth === 0) return wat.slice(start, index + 1);
  }
  throw new Error(`unterminated WAT function ${name}`);
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

function familyBody(wat: string, owner: string): string {
  const names = watFunctionNames(wat).filter((name) => name.includes(owner));
  expect(names, `missing ${owner} WAT family`).not.toEqual([]);
  return names.map((name) => extractFunctionBody(wat, name)).join("\n");
}

function functionIndices(wat: string, predicate: (name: string) => boolean): number[] {
  return watFunctionNames(wat).flatMap((name, index) => (predicate(name) ? [index] : []));
}

function callCount(body: string, indices: readonly number[]): number {
  return indices.reduce((count, index) => count + [...body.matchAll(new RegExp(`\\bcall ${index}\\b`, "g"))].length, 0);
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

describe("#4124 prepared fetchAllSequential", () => {
  it("runs each iteration only after the prior fulfillment and resolves the native numeric total", async () => {
    const result = await compileSequential();
    expectSuccess(result);
    expectPreparedOwner(result, "fetchAllSequential");
    const events: string[] = [];
    const { imports, jobs } = buildControlledTimerImports(
      result,
      [3, 1, 2],
      ({ id }) => events.push(`start:${id}`),
      ({ id }) => events.push(`fire:${id}`),
    );
    const settlement = trackOuterSettlement(imports.env as Record<string, (...args: unknown[]) => unknown>);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const ids = numberVec(instance.exports, [3, 1, 2]);
    const sequential = instance.exports.fetchAllSequential as (values: unknown) => Promise<number>;
    const promise = sequential(ids);
    settlement.bind(promise);
    void promise.then((value) => events.push(`resolve:${value}`));

    await waitUntil(() => jobs.length === 1, "the first sequential request");
    for (let iteration = 0; iteration < 3; iteration++) {
      expect(jobs).toHaveLength(iteration + 1);
      await expectPending(promise);
      jobs[iteration]!.fire();
      await waitUntil(
        () => (iteration === 2 ? events.includes("resolve:60") : jobs.length === iteration + 2),
        iteration === 2 ? "the sequential result" : `sequential request ${iteration + 2}`,
      );
    }

    await expect(settled(promise)).resolves.toBe(60);
    expect(events).toEqual(["start:3", "fire:3", "start:1", "fire:1", "start:2", "fire:2", "resolve:60"]);
    expect(settlement.counts()).toEqual({ resolves: 1, rejects: 0 });
  });

  it("takes the empty exit without calling fetchUser and resolves numeric zero", async () => {
    const result = await compileSequential();
    expectSuccess(result);
    expectPreparedOwner(result, "fetchAllSequential");
    const events: string[] = [];
    const { imports, jobs } = buildControlledTimerImports(
      result,
      [0],
      ({ id }) => events.push(`start:${id}`),
      ({ id }) => events.push(`fire:${id}`),
    );
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const promise = (instance.exports.fetchAllSequential as (values: unknown) => Promise<number>)(
      numberVec(instance.exports, []),
    );
    void promise.then((value) => events.push(`resolve:${value}`));

    await expect(settled(promise)).resolves.toBe(0);
    await waitUntil(() => events.length === 1, "the empty sequential result");
    expect(jobs).toEqual([]);
    expect(events).toEqual(["resolve:0"]);
  });

  it("rejects on iteration two exactly once without starting iteration three", async () => {
    const result = await compileSequential();
    expectSuccess(result);
    expectPreparedOwner(result, "fetchAllSequential");
    const events: string[] = [];
    const { imports, jobs } = buildControlledTimerImports(
      result,
      [3, 1, 2],
      ({ id }) => events.push(`start:${id}`),
      ({ id }) => events.push(`fire:${id}`),
    );
    const env = imports.env as Record<string, (...args: unknown[]) => unknown>;
    const newPending = env.Promise_new_pending!;
    const then2 = env.Promise_then2!;
    const preparedPromises = new Set<unknown>();
    let sequentialReactions = 0;
    env.Promise_new_pending = (...args) => {
      const promise = newPending(...args);
      preparedPromises.add(promise);
      return promise;
    };
    env.Promise_then2 = (promise, onFulfilled, onRejected) => {
      if (preparedPromises.has(promise) && ++sequentialReactions === 2) {
        return then2(Promise.reject(4124), onFulfilled, onRejected);
      }
      return then2(promise, onFulfilled, onRejected);
    };
    const settlement = trackOuterSettlement(env);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const promise = (instance.exports.fetchAllSequential as (values: unknown) => Promise<number>)(
      numberVec(instance.exports, [3, 1, 2]),
    );
    settlement.bind(promise);
    void promise.then(
      (value) => events.push(`resolve:${value}`),
      (reason) => events.push(`reject:${String(reason)}`),
    );

    await waitUntil(() => jobs.length === 1, "the first sequential request");
    await expectPending(promise);
    jobs[0]!.fire();
    await waitUntil(() => jobs.length === 2, "the second sequential request");
    await expect(settled(promise)).rejects.toBe(4124);
    await waitUntil(() => events.includes("reject:4124"), "the sequential rejection observer");
    expect(events).toEqual(["start:3", "fire:3", "start:1", "reject:4124"]);
    expect(jobs).toHaveLength(2);
    expect(settlement.counts()).toEqual({ resolves: 0, rejects: 1 });
  });
});

describe("#4124 prepared async main", () => {
  it("preserves the complete timer/callee/log trace and fulfills Promise<void> with undefined", async () => {
    const result = await compilePlayground();
    expectSuccess(result);
    expectPreparedOwner(result, "fetchAllSequential");
    expectPreparedOwner(result, "main");
    const trace: string[] = [];
    const logs: string[] = [];
    const { imports, jobs } = buildControlledTimerImports(
      result,
      [1, 2, 3, 4, 5],
      ({ id, phase }) => trace.push(`${phase}:start:${id}`),
      ({ id, phase }) => trace.push(`${phase}:fire:${id}`),
      {
        console: {
          log(value: unknown): void {
            const text = String(value);
            logs.push(text);
            trace.push(`log:${text}`);
          },
        },
      },
    );
    const clockValues = [1000, 1150, 2000, 2030];
    const clockImports = result.imports.filter((entry) => entry.intent.type === "date_now");
    expect(clockImports).toHaveLength(1);
    for (const imported of clockImports) {
      imports.env[imported.name] = () => {
        const value = clockValues.shift();
        if (value === undefined) throw new Error("main requested an unexpected fifth clock snapshot");
        trace.push(`clock:${value}`);
        return value;
      };
    }
    const settlement = trackOuterSettlement(imports.env as Record<string, (...args: unknown[]) => unknown>);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const promise = (instance.exports.main as () => Promise<void>)();
    settlement.bind(promise);
    void promise.then((value) => trace.push(`resolve:${String(value)}`));

    await waitUntil(() => jobs.length === 1, "main's first sequential request");
    for (let index = 0; index < 5; index++) {
      await expectPending(promise);
      jobs[index]!.fire();
      await waitUntil(
        () => (index === 4 ? jobs.length === 10 : jobs.length === index + 2),
        index === 4 ? "main's complete parallel fan-out" : `main's sequential request ${index + 2}`,
      );
    }
    expect(trace.filter((event) => event.startsWith("parallel:start:"))).toEqual([
      "parallel:start:1",
      "parallel:start:2",
      "parallel:start:3",
      "parallel:start:4",
      "parallel:start:5",
    ]);
    expect(trace.some((event) => event.startsWith("parallel:fire:"))).toBe(false);
    for (let index = 5; index < 9; index++) jobs[index]!.fire();
    await expectPending(promise);
    jobs[9]!.fire();

    await expect(settled(promise)).resolves.toBeUndefined();
    await waitUntil(() => trace.includes("resolve:undefined"), "main's fulfillment observer");
    expect(clockValues).toEqual([]);
    expect(logs).toEqual([
      "async/await demo",
      "sequential sum = 150 (took ~150ms)",
      "parallel  sum = 150 (took ~30ms)",
      "done",
    ]);
    expect(trace).toEqual([
      "log:async/await demo",
      "clock:1000",
      "sequential:start:1",
      "sequential:fire:1",
      "sequential:start:2",
      "sequential:fire:2",
      "sequential:start:3",
      "sequential:fire:3",
      "sequential:start:4",
      "sequential:fire:4",
      "sequential:start:5",
      "sequential:fire:5",
      "clock:1150",
      "log:sequential sum = 150 (took ~150ms)",
      "clock:2000",
      "parallel:start:1",
      "parallel:start:2",
      "parallel:start:3",
      "parallel:start:4",
      "parallel:start:5",
      "parallel:fire:1",
      "parallel:fire:2",
      "parallel:fire:3",
      "parallel:fire:4",
      "parallel:fire:5",
      "clock:2030",
      "log:parallel  sum = 150 (took ~30ms)",
      "log:done",
      "resolve:undefined",
    ]);
    expect(settlement.counts()).toEqual({ resolves: 1, rejects: 0 });
  });

  it("rejects the first await once and skips every later clock, parallel call, and log", async () => {
    const result = await compilePlayground();
    expectSuccess(result);
    expectPreparedOwner(result, "fetchAllSequential");
    expectPreparedOwner(result, "main");
    const trace: string[] = [];
    const { imports, jobs } = buildControlledTimerImports(
      result,
      [1, 2, 3, 4, 5],
      ({ id, phase }) => trace.push(`${phase}:start:${id}`),
      ({ id, phase }) => trace.push(`${phase}:fire:${id}`),
      { console: { log: (value: unknown) => trace.push(`log:${String(value)}`) } },
    );
    const clockValues = [1000, 1150, 2000, 2030];
    for (const imported of result.imports.filter((entry) => entry.intent.type === "date_now")) {
      imports.env[imported.name] = () => {
        const value = clockValues.shift();
        trace.push(`clock:${String(value)}`);
        return value;
      };
    }
    const env = imports.env as Record<string, (...args: unknown[]) => unknown>;
    const newPending = env.Promise_new_pending!;
    const then2 = env.Promise_then2!;
    const pending: unknown[] = [];
    env.Promise_new_pending = (...args) => {
      const promise = newPending(...args);
      pending.push(promise);
      return promise;
    };
    env.Promise_then2 = (promise, onFulfilled, onRejected) =>
      then2(promise === pending[1] ? Promise.reject(4124) : promise, onFulfilled, onRejected);
    const settlement = trackOuterSettlement(env);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const promise = (instance.exports.main as () => Promise<void>)();
    settlement.bind(promise);
    void promise.then(
      (value) => trace.push(`resolve:${String(value)}`),
      (reason) => trace.push(`reject:${String(reason)}`),
    );

    await expect(settled(promise)).rejects.toBe(4124);
    await waitUntil(() => trace.includes("reject:4124"), "main's rejection observer");
    expect(trace).toEqual(["log:async/await demo", "clock:1000", "sequential:start:1", "reject:4124"]);
    expect(jobs).toHaveLength(1);
    expect(clockValues).toEqual([1150, 2000, 2030]);
    expect(settlement.counts()).toEqual({ resolves: 0, rejects: 1 });
  });

  it("rejects the parallel await once and skips its trailing clock and logs", async () => {
    const result = await compilePlayground();
    expectSuccess(result);
    const trace: string[] = [];
    const pending: unknown[] = [];
    let parallelOuter: unknown;
    const { imports, jobs } = buildControlledTimerImports(
      result,
      [1, 2, 3, 4, 5],
      ({ id, phase }) => {
        trace.push(`${phase}:start:${id}`);
        if (phase === "parallel" && parallelOuter === undefined) parallelOuter = pending.at(-2);
      },
      ({ id, phase }) => trace.push(`${phase}:fire:${id}`),
      { console: { log: (value: unknown) => trace.push(`log:${String(value)}`) } },
    );
    const clockValues = [1000, 1150, 2000, 2030];
    for (const imported of result.imports.filter((entry) => entry.intent.type === "date_now")) {
      imports.env[imported.name] = () => {
        const value = clockValues.shift();
        trace.push(`clock:${String(value)}`);
        return value;
      };
    }
    const env = imports.env as Record<string, (...args: unknown[]) => unknown>;
    const newPending = env.Promise_new_pending!;
    const then2 = env.Promise_then2!;
    env.Promise_new_pending = (...args) => {
      const promise = newPending(...args);
      pending.push(promise);
      return promise;
    };
    env.Promise_then2 = (promise, onFulfilled, onRejected) =>
      then2(promise === parallelOuter ? Promise.reject(4124) : promise, onFulfilled, onRejected);
    const settlement = trackOuterSettlement(env);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const promise = (instance.exports.main as () => Promise<void>)();
    settlement.bind(promise);
    void promise.then(
      (value) => trace.push(`resolve:${String(value)}`),
      (reason) => trace.push(`reject:${String(reason)}`),
    );

    await waitUntil(() => jobs.length === 1, "main's first sequential request");
    for (let index = 0; index < 5; index++) {
      jobs[index]!.fire();
      await waitUntil(
        () => (index === 4 ? jobs.length === 10 : jobs.length === index + 2),
        index === 4 ? "main's parallel fan-out" : `main's sequential request ${index + 2}`,
      );
    }
    await expect(settled(promise)).rejects.toBe(4124);
    await waitUntil(() => trace.includes("reject:4124"), "main's second-await rejection observer");
    expect(trace.filter((event) => event.startsWith("parallel:fire:"))).toEqual([]);
    expect(trace.slice(-6)).toEqual([
      "parallel:start:1",
      "parallel:start:2",
      "parallel:start:3",
      "parallel:start:4",
      "parallel:start:5",
      "reject:4124",
    ]);
    expect(trace).not.toContain("clock:2030");
    expect(trace).not.toContain("log:parallel  sum = 150 (took ~30ms)");
    expect(trace).not.toContain("log:done");
    expect(clockValues).toEqual([2030]);
    expect(settlement.counts()).toEqual({ resolves: 0, rejects: 1 });
  });

  it("records the two legacy defects as an explicit non-parity control", async () => {
    const direct = await compile(PLAYGROUND_SOURCE, {
      fileName: "issue-4124-direct-control.ts",
      target: "gc",
      experimentalIR: false,
    });
    expectSuccess(direct);
    const logs: string[] = [];
    const imports = buildImports(
      direct.imports,
      { console: { log: (value: unknown) => logs.push(String(value)) } },
      direct.stringPool,
    );
    const clockValues = [1000, 1150, 2000, 2030];
    for (const imported of direct.imports.filter((entry) => entry.intent.type === "date_now")) {
      imports.env[imported.name] = () => clockValues.shift();
    }
    const { instance } = await WebAssembly.instantiate(direct.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);

    await expect(settled((instance.exports.main as () => Promise<void>)())).resolves.toBeNull();
    expect(logs).toContain("sequential sum = NaN (took ~150ms)");
  });
});

describe("#4124 ownership and optimization parity", () => {
  it("IR-emits the complete async family and keeps the IR-only telemetry check non-vacuous", async () => {
    const result = await compilePlayground();
    expectSuccess(result);
    const asyncFamily = ["delay", "fetchUser", "fetchAllSequential", "fetchAllParallel", "main"].map((name) =>
      outcome(result, name),
    );
    expect(asyncFamily).toHaveLength(5);
    expect(
      asyncFamily.every((entry) => entry.kind === "emitted"),
      JSON.stringify(asyncFamily, null, 2),
    ).toBe(true);
    expect(asyncFamily.every((entry) => entry.legacyBodyEmitted === false && entry.irBodyEmitted === true)).toBe(true);
    expect(asyncFamily.every((entry) => entry.preparedComponentId?.startsWith("prepared-component:"))).toBe(true);
    expect(evaluateIrOutcomePolicy(asyncFamily, "ir-only")).toMatchObject({ ready: true, blockers: [] });

    const compiled = result.irCompiledFuncs ?? [];
    for (const [name, states] of [
      ["fetchAllSequential", 5],
      ["main", 3],
    ] as const) {
      expect(
        compiled.filter((candidate) => candidate === name),
        `${name} must be compiled exactly once`,
      ).toHaveLength(1);
      expect(
        compiled.filter((candidate) => candidate.startsWith(`${name}__ir_async_state_`)),
        `${name} must own its exact prepared state count`,
      ).toHaveLength(states);
    }
    for (const name of ["fetchAllSequential", "main"]) {
      expect(
        result.irFirstSkipped?.filter((candidate) => candidate === name),
        `${name} must skip its direct body`,
      ).toHaveLength(1);
    }

    const nearMiss = await compileTracked(
      EXACT_SEQUENTIAL_SOURCE.replace(
        "total = total + (await fetchUser(ids[i]));",
        "total = total + (await fetchUser(ids[i])) + 0;",
      ),
      "issue-4124-async-family-shadow-positive-control.ts",
    );
    expectSuccess(nearMiss);
    const directAsync = outcome(nearMiss, "fetchAllSequential");
    expect(directAsync).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(evaluateIrOutcomePolicy([directAsync], "ir-only").ready).toBe(false);

    const changedLog = await compileTracked(
      PLAYGROUND_SOURCE.replace('" (took ~" + (t1 - t0).toString()', '" in ~" + (t1 - t0).toString()'),
      "issue-4124-main-log-near-miss.ts",
    );
    expectSuccess(changedLog);
    expect(outcome(changedLog, "main")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  });

  it("runs the IR-only async shadow with a direct-body poison and a firing control", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-4124-shadow-"));
    const probe = join(dir, "probe.mts");
    writeFileSync(
      probe,
      `import { compile } from ${JSON.stringify(join(REPO_ROOT, "src/index.ts"))};\n` +
        `const source = ${JSON.stringify(EXACT_SEQUENTIAL_SOURCE)};\n` +
        `const exact = await compile(source, { fileName: "issue-4124-shadow-exact.ts", trackIrOutcomes: true });\n` +
        `const near = await compile(source.replace("total = total + (await fetchUser(ids[i]));", "total = total + (await fetchUser(ids[i])) + 0;"), { fileName: "issue-4124-shadow-control.ts", trackIrOutcomes: true });\n` +
        `process.stdout.write(JSON.stringify({ exact: exact.success, near: near.success, errors: near.errors.map(e => e.message) }));\n`,
    );
    const parsed = JSON.parse(
      execFileSync("pnpm", ["exec", "tsx", probe], {
        cwd: REPO_ROOT,
        env: { ...process.env, JS2WASM_TEST_POISON_DIRECT_ASYNC_BODY: "1" },
      }).toString(),
    ) as { exact: boolean; near: boolean; errors: string[] };
    expect(parsed.exact).toBe(true);
    expect(parsed.near).toBe(false);
    expect(parsed.errors.join("\n")).toMatch(/direct async body poison reached fetchAllSequential/);
  });

  it("keeps the sequential loop native and free of redundant carrier/bounds traffic", async () => {
    const result = await compileSequential();
    expectSuccess(result);
    expectPreparedOwner(result, "fetchAllSequential");
    const family = familyBody(result.wat, "fetchAllSequential");
    const stateBodyList = Array.from({ length: 5 }, (_, state) =>
      extractFunctionBody(result.wat, `fetchAllSequential__ir_async_state_${state}`),
    );
    const stateBodies = stateBodyList.join("\n");
    const fetchState = stateBodyList.find((body) => callsToName(result.wat, body, "fetchUser") === 1);

    expect(fetchState, "missing sequential await/call state").toBeDefined();
    expect(fetchState).toMatch(/\barray\.get\b/);
    expect(fetchState).not.toMatch(/\bbr_if\b/);
    expect(fetchState).not.toMatch(/\(if\b/);
    expect(stateBodies.match(/\barray\.get\b/g)).toHaveLength(1);
    expect(stateBodies.match(/\bf64\.add\b/g)).toHaveLength(1);
    expect(stateBodies.match(/\bi32\.add\b/g)).toHaveLength(1);
    expect(stateBodies.match(/\bi32\.lt_[su]\b/g)).toHaveLength(1);
    expect(stateBodies).not.toMatch(/f64\.convert_i32|i32\.trunc_f64/);
    expect(callsToName(result.wat, family, "fetchUser")).toBe(1);
    expect(callsToMatching(result.wat, family, /__unbox_number/, "numeric unbox")).toBe(1);
    expect(callsToMatching(result.wat, family, /__box_number/, "numeric box")).toBe(1);
    expect(family).not.toMatch(/any\.convert|ref\.cast/);
    const frame = extractParenthesizedForm(result.wat, "(type $$AsyncFrame_fetchAllSequential__ir");
    expect(frame).toMatch(/\(field \$param_ids \(ref null \d+\)\)/);
    expect(frame.match(/\(field \$spill_[^ ]+ \(mut f64\)\)/g)).toHaveLength(1);
    expect(frame.match(/\(field \$spill_[^ ]+ \(mut i32\)\)/g)).toHaveLength(1);
    const resume = extractFunctionBody(result.wat, "__async_resume_ffetchAllSequential__ir");
    expect(resume).not.toMatch(/f64\.convert_i32|i32\.trunc_f64/);
  });

  it("preserves main's fused logging, native timing, vector, and direct-callee shapes", async () => {
    const result = await compileTracked(
      `${PLAYGROUND_SOURCE}\nexport function lateDirect(value: any = "A"): boolean { return value === "A"; }`,
      "issue-4124-main-late-import-shapes.ts",
    );
    expectSuccess(result);
    expect(outcome(result, "main")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(outcome(result, "lateDirect")).toMatchObject({ legacyBodyEmitted: true, irBodyEmitted: false });
    const family = familyBody(result.wat, "main");

    expect(family.match(/\barray\.new_fixed\b/g)).toHaveLength(1);
    expect(family.match(/\bf64\.sub\b/g)).toHaveLength(2);
    expect(callsToName(result.wat, family, "fetchAllSequential")).toBe(1);
    expect(callsToName(result.wat, family, "fetchAllParallel")).toBe(1);
    expect(callsToMatching(result.wat, family, /date_now|clock_snapshot/, "clock snapshot")).toBe(4);
    expect(callsToMatching(result.wat, family, /__concat_5/, "five-part concat")).toBe(2);
    expect(callsToMatching(result.wat, family, /number_toString/, "number toString")).toBe(4);
    expect(callsToMatching(result.wat, family, /console_log_string/, "string console log")).toBe(4);
    expect(callsToMatching(result.wat, family, /__unbox_number/, "numeric unbox")).toBe(2);
    expect(
      callCount(
        family,
        functionIndices(result.wat, (name) => /__box_number/.test(name)),
      ),
    ).toBe(0);
    const nonFusedConcat = functionIndices(result.wat, (name) => /concat/.test(name) && !/__concat_5/.test(name));
    expect(callCount(family, nonFusedConcat)).toBe(0);
    const frame = extractParenthesizedForm(result.wat, "(type $$AsyncFrame_main__ir");
    expect(frame.match(/\(field \$spill_[^ ]+ \(mut \(ref null \d+\)\)\)/g)).toHaveLength(1);
    expect(frame.match(/\(field \$spill_[^ ]+ \(mut f64\)\)/g)).toHaveLength(2);

    const resume = extractFunctionBody(result.wat, "__async_resume_fmain__ir");
    const frameType = Number(resume.match(/\(param \(ref null (\d+)\)\)/)?.[1]);
    expect(Number.isSafeInteger(frameType)).toBe(true);
    for (const field of [5, 6, 7]) {
      expect(resume.match(new RegExp(`\\bstruct\\.set ${frameType} ${field}\\b`, "g"))).toHaveLength(1);
      expect(resume.match(new RegExp(`\\bstruct\\.get ${frameType} ${field}\\b`, "g"))).toHaveLength(1);
    }
    const firstDispatch = resume.indexOf(`struct.get ${frameType} 0`);
    const firstVectorRestore = resume.indexOf(`struct.get ${frameType} 5`);
    const secondDispatch = resume.lastIndexOf(`struct.get ${frameType} 0`);
    const secondTimestampRestore = resume.indexOf(`struct.get ${frameType} 7`);
    expect(firstVectorRestore).toBeGreaterThan(firstDispatch);
    expect(resume.indexOf(`struct.get ${frameType} 6`)).toBeLessThan(secondDispatch);
    expect(secondTimestampRestore).toBeGreaterThan(secondDispatch);
    expect(resume).not.toMatch(/f64\.convert_i32|i32\.trunc_f64/);
  });
});
