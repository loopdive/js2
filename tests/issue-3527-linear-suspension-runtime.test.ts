// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** #3527 B2 — compile-once ownership and preserved await ordering. */
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";
import { ts } from "../src/ts-api.js";

const SOURCE = `
function delay(ms: number, value: number): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

export async function genericChain(seed: number): Promise<number> {
  let live = seed;
  const first = await delay(1, live + 10);
  live = first + 1;
  const settled = await Promise.resolve(live + 20);
  const unused = await Promise.resolve(99);
  const settledNonThenable = await 42;
  const last = await delay(1, live + 30);
  return live + first + settled + last;
}

export async function providerOnly(seed: number): Promise<number> {
  const first = await Promise.resolve(seed + 1);
  const second = await Promise.resolve(first + 2);
  return first + second;
}
`;

const REJECTION_SOURCE = `
function delay(ms: number, value: number): Promise<number> {
  return new Promise<number>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

export async function rejectFirst(seed: number): Promise<number> {
  const first = await delay(1, seed);
  const later = await Promise.resolve(first + 1);
  return later;
}

export async function rejectSecond(seed: number): Promise<number> {
  const first = await delay(1, seed);
  const second = await delay(1, first + 1);
  return second;
}
`;

const STATIC_ONLY_SOURCE = `
export async function literalOne(seed: number): Promise<number> {
  const value = await 42;
  return value + 1;
}

export async function literalTwo(seed: number): Promise<number> {
  const first = await 42;
  const second = await 43;
  return first + second;
}
`;

function expectSuccessful(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
}

function countFunctionAwaits(source: string, name: string): number {
  const file = ts.createSourceFile(
    "issue-3527-linear-count.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const declaration = file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration?.body) return 0;
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isAwaitExpression(node)) count++;
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return count;
}

function extractWasmFunction(wat: string | undefined, name: string): string | null {
  if (!wat) return null;
  const marker = `(func $${name}`;
  const start = wat.indexOf(marker);
  if (start < 0) return null;
  let depth = 0;
  for (let index = start; index < wat.length; index++) {
    if (wat[index] === "(") depth++;
    else if (wat[index] === ")" && --depth === 0) return wat.slice(start, index + 1);
  }
  return null;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 16; index++) await Promise.resolve();
}

interface Harness {
  readonly promise: Promise<number>;
  readonly jobs: Array<() => void>;
  readonly events: string[];
}

interface ControlledTimer {
  readonly jobs: Array<() => void>;
  readonly events: string[];
  readonly setTimeout: typeof setTimeout;
}

function controlledTimer(): ControlledTimer {
  const jobs: Array<() => void> = [];
  const events: string[] = [];
  const setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const ordinal = jobs.length;
    events.push(`schedule:${ordinal}:${Number(delay ?? 0)}`);
    jobs.push(() => {
      events.push(`fire:${ordinal}`);
      callback(...args);
    });
    return (ordinal + 1) as unknown as ReturnType<typeof globalThis.setTimeout>;
  }) as typeof globalThis.setTimeout;
  return { jobs, events, setTimeout };
}

function nativeGenericChain(seed: number, timer: ControlledTimer): Promise<number> {
  const delay = (ms: number, value: number): Promise<number> =>
    new Promise<number>((resolve) => timer.setTimeout(() => resolve(value), ms));
  return (async () => {
    let live = seed;
    const first = await delay(1, live + 10);
    live = first + 1;
    const settled = await Promise.resolve(live + 20);
    const unused = await Promise.resolve(99);
    const settledNonThenable = await 42;
    const last = await delay(1, live + 30);
    return live + first + settled + last;
  })();
}

function queueIndependentMicrotaskObservers(events: string[]): void {
  Promise.resolve().then(() => {
    events.push("observer:1");
    Promise.resolve().then(() => events.push("observer:2"));
  });
}

async function invokeControlled(result: CompileResult): Promise<Harness> {
  const timer = controlledTimer();
  const imports = buildCompiledImports(result, { setTimeout: timer.setTimeout });
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setInstance?.(instance);
  const genericChain = (instance.exports as unknown as Record<string, Function>).genericChain as (
    seed: number,
  ) => Promise<number>;
  return { promise: genericChain(1), jobs: timer.jobs, events: timer.events };
}

function invokeNativeControlled(): Harness {
  const timer = controlledTimer();
  return { promise: nativeGenericChain(1, timer), jobs: timer.jobs, events: timer.events };
}

describe("#3527 generic linear async runtime", () => {
  it("owns an arbitrary five-await chain and retains settled awaits", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-3527-linear-suspension-runtime.ts",
      target: "gc",
      experimentalIR: true,
      trackFallbacks: true,
      trackIrOutcomes: true,
      skipSemanticDiagnostics: true,
      emitWat: true,
    });
    expectSuccessful(result);
    const sourceAwaitCount = countFunctionAwaits(SOURCE, "genericChain");
    expect(sourceAwaitCount).toBe(5);
    const resumeBody = extractWasmFunction(result.wat, "__async_resume_fgenericChain__ir");
    expect(resumeBody, "missing genericChain resume body").not.toBeNull();
    // Each suspend state writes the next state number into the frame.  This
    // independently reconciles the source await denominator with the emitted
    // canonical frame graph; helper count alone cannot prove this.
    expect(resumeBody!.match(/struct\.set \d+ 0/g) ?? []).toHaveLength(sourceAwaitCount);
    expect(result.irCompiledFuncs ?? []).toContain("genericChain");
    expect(result.irCompiledFuncs ?? []).toContain("providerOnly");
    expect(result.irFirstSkipped ?? []).toContain("genericChain");
    expect(result.irFirstSkipped ?? []).toContain("providerOnly");
    expect(
      result.irCompiledFuncs?.filter((name) => name.startsWith("genericChain__ir_async_state_")).length,
    ).toBeGreaterThan(0);
    expect((result.irOutcomes ?? []).find((outcome) => outcome.displayName === "genericChain")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect((result.irOutcomes ?? []).find((outcome) => outcome.displayName === "providerOnly")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });

    const providerImports = buildCompiledImports(result);
    const { instance: providerInstance } = await WebAssembly.instantiate(
      result.binary,
      providerImports as WebAssembly.Imports,
    );
    providerImports.setInstance?.(providerInstance);
    const providerOnly = (providerInstance.exports as unknown as Record<string, Function>).providerOnly as (
      seed: number,
    ) => Promise<number>;
    await expect(providerOnly(4)).resolves.toBe(12);

    const harness = await invokeControlled(result);
    expect(harness.jobs).toHaveLength(1);
    expect(harness.events).toEqual(["schedule:0:1"]);

    const first = harness.jobs.shift()!;
    first();
    await flushMicrotasks();
    // The second timer is registered only after the first await, both settled
    // Promise.resolve/non-thenable awaits, and the unused await have each
    // crossed their retained frame edge.
    expect(harness.events).toEqual(["schedule:0:1", "fire:0", "schedule:0:1"]);
    expect(harness.jobs).toHaveLength(1);

    harness.jobs.shift()!();
    await expect(harness.promise).resolves.toBe(97);
    expect(harness.events).toEqual(["schedule:0:1", "fire:0", "schedule:0:1", "fire:0"]);
  });

  it("keeps newly prepared linear owners off the direct async emitter", async () => {
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_ASYNC_BODY;
    process.env.JS2WASM_TEST_POISON_DIRECT_ASYNC_BODY = "1";
    try {
      const result = await compile(SOURCE, {
        fileName: "issue-3527-linear-direct-poison.ts",
        target: "gc",
        experimentalIR: true,
        trackIrOutcomes: true,
        skipSemanticDiagnostics: true,
      });
      expectSuccessful(result);
      for (const name of ["genericChain", "providerOnly"]) {
        expect((result.irOutcomes ?? []).find((outcome) => outcome.displayName === name)).toMatchObject({
          kind: "emitted",
          legacyBodyEmitted: false,
          irBodyEmitted: true,
        });
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_ASYNC_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_ASYNC_BODY = previous;
    }
  });

  it("matches the direct engine's value for the same controlled chain", async () => {
    const [ir, direct] = await Promise.all([
      compile(SOURCE, {
        fileName: "issue-3527-linear-ir.ts",
        target: "gc",
        experimentalIR: true,
        trackIrOutcomes: true,
        skipSemanticDiagnostics: true,
      }),
      compile(SOURCE, {
        fileName: "issue-3527-linear-direct.ts",
        target: "gc",
        experimentalIR: false,
        skipSemanticDiagnostics: true,
      }),
    ]);
    expectSuccessful(ir);
    expectSuccessful(direct);
    expect((ir.irOutcomes ?? []).find((outcome) => outcome.displayName === "genericChain")).toMatchObject({
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });

    const irHarness = await invokeControlled(ir);
    const directHarness = await invokeControlled(direct);
    for (const harness of [irHarness, directHarness]) {
      expect(harness.jobs).toHaveLength(1);
      harness.jobs.shift()!();
      await flushMicrotasks();
      expect(harness.jobs).toHaveLength(1);
      harness.jobs.shift()!();
    }
    await expect(irHarness.promise).resolves.toBe(97);
    await expect(directHarness.promise).resolves.toBe(97);
  });

  it("matches native microtask ordering across settled and pending awaits", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-3527-linear-native-order.ts",
      target: "gc",
      experimentalIR: true,
      trackIrOutcomes: true,
      skipSemanticDiagnostics: true,
      emitWat: true,
    });
    expectSuccessful(result);

    const irHarness = await invokeControlled(result);
    const nativeHarness = invokeNativeControlled();
    for (const harness of [irHarness, nativeHarness]) {
      expect(harness.jobs).toHaveLength(1);
      harness.jobs.shift()!();
      // If any settled await were erased, the second timer would be
      // scheduled before observer:1/observer:2.  Retaining both awaits makes
      // each frame reaction yield to the independent Promise observer.
      queueIndependentMicrotaskObservers(harness.events);
      await flushMicrotasks();
      expect(harness.jobs).toHaveLength(1);
      harness.jobs.shift()!();
      await expect(harness.promise).resolves.toBe(97);
    }

    const expected = ["schedule:0:1", "fire:0", "observer:1", "observer:2", "schedule:0:1", "fire:0"];
    expect(irHarness.events).toEqual(expected);
    expect(nativeHarness.events).toEqual(expected);
    expect(irHarness.events).toEqual(nativeHarness.events);
  });

  it("keeps fully settled literal awaits on the established route", async () => {
    const result = await compile(STATIC_ONLY_SOURCE, {
      fileName: "issue-3527-linear-static-only.ts",
      target: "gc",
      experimentalIR: true,
      trackIrOutcomes: true,
      skipSemanticDiagnostics: true,
    });
    expectSuccessful(result);

    // B2 requires the existing source analysis to report a potentially
    // suspending await. A fully statically resolved chain must therefore not
    // acquire synthetic B2 state helpers until the separately planned
    // settled-await cutover.
    expect(result.irCompiledFuncs ?? []).not.toContain("literalOne__ir_async_state_0");
    expect(result.irCompiledFuncs ?? []).not.toContain("literalTwo__ir_async_state_0");
    const outcomes = new Map((result.irOutcomes ?? []).map((outcome) => [outcome.displayName, outcome]));
    expect(outcomes.get("literalOne")).toMatchObject({
      kind: "emitted",
      r2Withdrawal: { stage: "admission", reason: "async-declaration" },
    });
    expect(outcomes.get("literalTwo")).toMatchObject({
      kind: "emitted",
      r2Withdrawal: { stage: "admission", reason: "async-declaration" },
    });

    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setInstance?.(instance);
    const exports = instance.exports as unknown as Record<string, (seed: number) => number>;
    expect(exports.literalOne(0)).toBe(43);
    expect(exports.literalTwo(0)).toBe(85);
  });

  it("propagates a rejection from either suspension without executing later states", async () => {
    const result = await compile(REJECTION_SOURCE, {
      fileName: "issue-3527-linear-rejection.ts",
      target: "gc",
      experimentalIR: true,
      trackIrOutcomes: true,
      skipSemanticDiagnostics: true,
      emitWat: true,
    });
    expectSuccessful(result);
    expect(result.irCompiledFuncs ?? []).toEqual(
      expect.arrayContaining([
        "rejectFirst",
        "rejectFirst__ir_async_state_0",
        "rejectFirst__ir_async_state_1",
        "rejectSecond",
        "rejectSecond__ir_async_state_0",
        "rejectSecond__ir_async_state_1",
      ]),
    );
    const outcomes = new Map((result.irOutcomes ?? []).map((outcome) => [outcome.displayName, outcome]));
    expect(outcomes.get("rejectFirst")).toMatchObject({ legacyBodyEmitted: false, irBodyEmitted: true });
    expect(outcomes.get("rejectSecond")).toMatchObject({ legacyBodyEmitted: false, irBodyEmitted: true });

    const invoke = async (name: "rejectFirst" | "rejectSecond", rejectAt: number): Promise<string[]> => {
      let currentReject: ((reason?: unknown) => void) | undefined;
      class ControlledPromise<T> extends Promise<T> {
        constructor(
          executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void) => void,
        ) {
          super((resolve, reject) => {
            const previous = currentReject;
            currentReject = reject;
            try {
              executor(resolve, reject);
            } finally {
              currentReject = previous;
            }
          });
        }
      }

      const jobs: Array<() => void> = [];
      const events: string[] = [];
      let scheduleOrdinal = 0;
      const setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
        const ordinal = scheduleOrdinal++;
        const reject = currentReject;
        events.push(`schedule:${ordinal}:${Number(delay ?? 0)}`);
        jobs.push(() => {
          events.push(`fire:${ordinal}`);
          if (ordinal === rejectAt && reject) reject(`rejected:${ordinal}`);
          else callback(...args);
        });
        return (ordinal + 1) as unknown as ReturnType<typeof globalThis.setTimeout>;
      }) as typeof globalThis.setTimeout;
      const imports = buildCompiledImports(result, { setTimeout }, { globalSandbox: { Promise: ControlledPromise } });
      const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
      imports.setInstance?.(instance);
      const promise = (instance.exports as unknown as Record<string, Function>)[name](5) as Promise<number>;
      expect(jobs).toHaveLength(1);
      jobs.shift()!();
      await flushMicrotasks();
      if (rejectAt === 1) {
        expect(jobs).toHaveLength(1);
        jobs.shift()!();
        await expect(promise).rejects.toBe("rejected:1");
      } else {
        await expect(promise).rejects.toBe("rejected:0");
      }
      expect(jobs).toHaveLength(0);
      return events;
    };

    await expect(invoke("rejectFirst", 0)).resolves.toEqual(["schedule:0:1", "fire:0"]);
    await expect(invoke("rejectSecond", 1)).resolves.toEqual(["schedule:0:1", "fire:0", "schedule:1:1", "fire:1"]);
  });

  it("refuses a branch in the linear source proof without a partial IR body", async () => {
    const result = await compile(
      SOURCE.replace(
        "  const settled = await Promise.resolve(live + 20);",
        "  if (live > 0) live = live + 1;\n  const settled = await Promise.resolve(live + 20);",
      ),
      {
        fileName: "issue-3527-linear-control-near-miss.ts",
        target: "gc",
        experimentalIR: true,
        trackIrOutcomes: true,
        skipSemanticDiagnostics: true,
      },
    );
    expectSuccessful(result);
    expect(result.irCompiledFuncs ?? []).not.toContain("genericChain");
    expect((result.irOutcomes ?? []).find((outcome) => outcome.displayName === "genericChain")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  });
});
