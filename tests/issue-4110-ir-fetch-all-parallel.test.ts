// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** #4110 — prepared Promise.all prefix plus numeric IR continuation. */
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import {
  asAsyncStateId,
  canonicalPromiseAbi,
  createIrAsyncPlan,
  hashIrAsyncPlan,
  serializeIrAsyncPlan,
} from "../src/ir/async-plan.js";
import { ASYNC_RUNTIME_FEATURES } from "../src/ir/async-runtime-providers.js";
import { prepareSingleAwaitIrFunction } from "../src/ir/async-prepare.js";
import {
  irCallableBindingKey,
  irSupportFuncRef,
  irUnitCallableBindingId,
  irUnitFuncRef,
} from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { exactPreparedUnitCallableBindingId } from "../src/ir/integration.js";
import {
  asBlockId,
  asValueId,
  irVal,
  irVec,
  type IrFunction,
  type IrType,
  type IrVecLayoutRef,
} from "../src/ir/nodes.js";
import {
  derivePreparedComponentDependencies,
  type PreparedComponentAbiEntry,
} from "../src/ir/prepared-component-dependencies.js";
import { attachIrVecLayouts } from "../src/ir/vec-layout.js";
import { irSupportTypeRef, irTypeBindingKey } from "../src/ir/abi-bindings.js";
import type { WasmFunction } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";
import { pinPerfFlags } from "./helpers/pin-perf-flags.js";

// (#4157) "emits the exact owner and both helpers once with NO DIRECT BODY" is
// asserted as a literal `call <n>` operand — an absolute function index, which
// the tuned passes shift by adding helpers, and which the IR inliner can remove
// outright. Pin the inliner off: the ownership property this file tests is
// established during IR preparation, upstream of it.
pinPerfFlags({ JS2WASM_IR_INLINE: "0" });

const EXACT_SOURCE = `
  function delay(ms: number, value: number): Promise<number> {
    return new Promise<number>((resolve) => {
      setTimeout(() => resolve(value), ms);
    });
  }

  async function fetchUser(id: number): Promise<number> {
    const value = await delay(30, id * 10);
    return value;
  }

  export async function fetchAllParallel(ids: number[]): Promise<number> {
    const pending: Promise<number>[] = [];
    for (let i = 0; i < ids.length; i++) {
      pending.push(fetchUser(ids[i]));
    }
    const results = await Promise.all(pending);
    let code = 0;
    for (let i = 0; i < results.length; i++) {
      code = code + results[i];
    }
    return code;
  }
`;

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
}

async function compileTracked(source = EXACT_SOURCE, fileName = "issue-4110-ir-fetch-all-parallel.ts") {
  return compile(source, { fileName, target: "gc", emitWat: true, trackIrOutcomes: true });
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

function watFunctionIndex(wat: string, name: string): number {
  const functions = [...wat.matchAll(/\(func \$([^\s(]+)/g)].map((match) => match[1]!);
  const index = functions.indexOf(name);
  if (index < 0) throw new Error(`missing WAT function index for ${name}`);
  return index;
}

function expectExactMaterializedContinuation(wat: string): void {
  const continuationName = "fetchAllParallel__ir_async_state_1";
  const continuation = extractFunctionBody(wat, continuationName);
  const resume = extractFunctionBody(wat, "__async_resume_ffetchAllParallel__ir");
  const carrierType = continuation.match(/\(param \(ref null (\d+)\)\) \(result f64\)/)?.[1];
  expect(carrierType, "prepared continuation lost its exact vec carrier ABI").toBeDefined();

  const materializerName = `__vec_from_extern_${carrierType}`;
  const materializer = extractFunctionBody(wat, materializerName);
  const materializerIdx = watFunctionIndex(wat, materializerName);
  const continuationIdx = watFunctionIndex(wat, continuationName);
  const materializerCalls = [...resume.matchAll(new RegExp(`\\bcall ${materializerIdx}\\b`, "g"))];
  const continuationCalls = [...resume.matchAll(new RegExp(`\\bcall ${continuationIdx}\\b`, "g"))];

  expect(materializer).toMatch(new RegExp(`\\(param externref\\) \\(result \\(ref null ${carrierType}\\)\\)`));
  expect(materializer).toMatch(/any\.convert_extern[\s\S]*ref\.test/);
  expect(materializerCalls).toHaveLength(1);
  expect(continuationCalls).toHaveLength(1);
  expect(materializerCalls[0]!.index).toBeLessThan(continuationCalls[0]!.index);
  expect(resume).not.toMatch(/any\.convert_extern|ref\.test/);
}

async function settled<T>(value: T | Promise<T>, ms = 4000): Promise<T> {
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("prepared Promise.all never settled")), ms);
      }),
    ]);
  } finally {
    if (watchdog !== undefined) clearTimeout(watchdog);
  }
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

describe("#4110 prepared fetchAllParallel", () => {
  it("emits the exact owner and both helpers once with no direct body", async () => {
    const result = await compileTracked();
    expectSuccess(result);

    expect(result.irFirstSkipped ?? []).toEqual(expect.arrayContaining(["delay", "fetchUser", "fetchAllParallel"]));
    expect(result.irCompiledFuncs ?? []).toEqual(
      expect.arrayContaining([
        "fetchAllParallel",
        "fetchAllParallel__ir_async_state_0",
        "fetchAllParallel__ir_async_state_1",
      ]),
    );
    expect((result.irOutcomes ?? []).find((outcome) => outcome.displayName === "fetchAllParallel")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });

    const source = extractFunctionBody(result.wat, "fetchAllParallel");
    const entry = extractFunctionBody(result.wat, "fetchAllParallel__ir_async_state_0");
    const continuation = extractFunctionBody(result.wat, "fetchAllParallel__ir_async_state_1");
    const resume = extractFunctionBody(result.wat, "__async_resume_ffetchAllParallel__ir");
    const fetchUserIdx = watFunctionIndex(result.wat, "fetchUser");
    const promiseAllIdx = watFunctionIndex(result.wat, "Promise_all_import");
    const functionNames = [...result.wat.matchAll(/\(func \$([^\s(]+)/g)].map((match) => match[1]!);
    const scalarBridgeIndices = functionNames.flatMap((name, index) =>
      name === "__unbox_number_import" || name === "__box_number_import" ? [index] : [],
    );

    expect(entry).toMatch(/array\.new_fixed/);
    expect(entry.match(/array\.new_fixed/g)).toHaveLength(1);
    expect(entry).toMatch(new RegExp(`\\bcall ${fetchUserIdx}\\b`));
    // The Promise result is single-use by pending.push. Keep it on the Wasm
    // stack through the immediately following typed vec append; a local spill
    // here is safe but needlessly regresses the direct backend's call shape.
    expect(entry).toMatch(new RegExp(`\\bcall ${fetchUserIdx}\\b\\s+call \\d+\\b`));
    expect(scalarBridgeIndices.length).toBeGreaterThan(0);
    for (const index of scalarBridgeIndices) expect(entry).not.toMatch(new RegExp(`\\bcall ${index}\\b`));
    expect(entry).toMatch(new RegExp(`\\bcall ${promiseAllIdx}\\b`));
    expect(continuation).toMatch(/\(param \(ref null \d+\)\) \(result f64\)/);
    expect(continuation).toMatch(/struct\.get[\s\S]*array\.get[\s\S]*f64\.add/);
    expect(continuation).toMatch(/\(loop/);
    expect(continuation.match(/\barray\.get\b/g)).toHaveLength(1);
    expect(continuation.match(/\bf64\.add\b/g)).toHaveLength(1);
    expect(continuation.match(/\bi32\.add\b/g)).toHaveLength(1);
    expect(continuation.match(/\bbr_if\b/g)).toHaveLength(1);
    expect(continuation).not.toMatch(/\bcall(?:_ref)?\b|any\.convert|extern\.convert|ref\.cast/);
    expectExactMaterializedContinuation(result.wat);
    expect(resume).toMatch(/struct\.set/);
    expect(`${source}\n${continuation}\n${resume}`).not.toMatch(/array\.new_fixed/);
  });

  it("prepares unique string support used only in the post-await IR state", async () => {
    const literal = "__post_await_ir_string__";
    const source = EXACT_SOURCE.replace("let code = 0;", `let code = "${literal}".length;`);
    const previous = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
    try {
      process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = "fetchAllParallel";
      const result = await compileTracked(source, "issue-4110-post-await-string-preparation.ts");
      expectSuccess(result);
      expect((result.irOutcomes ?? []).find((outcome) => outcome.displayName === "fetchAllParallel")).toMatchObject({
        kind: "emitted",
        legacyBodyEmitted: false,
        irBodyEmitted: true,
        preparedComponentId: expect.stringMatching(/^prepared-component:/),
      });

      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
      imports.setExports?.(instance.exports as Record<string, Function>);
      const ids = numberVec(instance.exports, [1, 2, 3]);
      await expect(
        settled((instance.exports.fetchAllParallel as (ids: unknown) => Promise<number>)(ids)),
      ).resolves.toBe(60 + literal.length);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY");
      else process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY = previous;
    }
  });

  it("fans out before settlement and preserves Promise.all input order", async () => {
    const result = await compileTracked(
      EXACT_SOURCE.replace("async function fetchUser", "export async function fetchUser"),
    );
    expectSuccess(result);
    const events: string[] = [];
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      events.push(`start:${Number(ms)}`);
      return nativeSetTimeout(() => {
        events.push(`done:${Number(ms)}`);
        callback(...args);
      }, ms);
    }) as typeof setTimeout;
    try {
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const env = imports.env as Record<string, (...args: unknown[]) => unknown>;
      const promiseAll = env.Promise_all!;
      let aggregateValues: unknown;
      env.Promise_all = (...args) =>
        Promise.resolve(promiseAll(...args)).then((values) => {
          aggregateValues = values;
          return values;
        });
      const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
      imports.setExports?.(instance.exports as Record<string, Function>);

      await expect(
        Promise.all([1, 2, 3].map((id) => (instance.exports.fetchUser as (id: number) => Promise<number>)(id))),
      ).resolves.toEqual([10, 20, 30]);
      events.length = 0;

      const ids = numberVec(instance.exports, [1, 2, 3]);
      const resolved = await settled((instance.exports.fetchAllParallel as (ids: unknown) => Promise<number>)(ids));
      expect(events.slice(0, 3)).toEqual(["start:30", "start:30", "start:30"]);
      expect(events.findIndex((event) => event.startsWith("done:"))).toBeGreaterThanOrEqual(3);
      expect(events.filter((event) => event.startsWith("done:")).slice(0, 3)).toEqual([
        "done:30",
        "done:30",
        "done:30",
      ]);
      expect(aggregateValues).toEqual([10, 20, 30]);
      expect(resolved).toBe(60);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
    }
  });

  it("keeps the named materializer and continuation targets stable after a later direct import", async () => {
    const result = await compileTracked(
      `
      ${EXACT_SOURCE}
      export function lateDirect(value: any = "A"): boolean { return value === "A"; }
    `,
      "issue-4110-late-import-targets.ts",
    );
    expectSuccess(result);
    expect(result.imports.map((entry) => entry.name)).toContain("__extern_is_undefined");
    expect((result.irOutcomes ?? []).find((outcome) => outcome.displayName === "fetchAllParallel")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect((result.irOutcomes ?? []).find((outcome) => outcome.displayName === "lateDirect")).toMatchObject({
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expectExactMaterializedContinuation(result.wat);
  });

  it("fails terminally without retrying the exact owner after preparation starts", async () => {
    const previous = process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW;
    process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW = "inline";
    try {
      const result = await compileTracked(EXACT_SOURCE, "issue-4110-preparation-failure.ts");
      expect(result.success).toBe(false);
      expect(result.irFirstSkipped ?? []).toContain("fetchAllParallel");
      expect((result.irOutcomes ?? []).find((outcome) => outcome.displayName === "fetchAllParallel")).toMatchObject({
        kind: "invariant",
        legacyBodyEmitted: false,
        irBodyEmitted: false,
      });
      expect(result.irPostClaimErrors ?? []).toEqual(
        expect.arrayContaining([expect.objectContaining({ func: "fetchAllParallel" })]),
      );
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_PHASE_THROW");
      else process.env.JS2WASM_TEST_INJECT_IR_PHASE_THROW = previous;
    }
  });

  it("propagates the first aggregate rejection without settling the outer promise from the continuation", async () => {
    const result = await compileTracked();
    expectSuccess(result);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const env = imports.env as Record<string, (...args: unknown[]) => unknown>;
    const newPending = env.Promise_new_pending!;
    const settleResolve = env.Promise_settle_resolve!;
    const settleReject = env.Promise_settle_reject!;
    let outerPromise: unknown;
    let outerResolves = 0;
    let outerRejects = 0;
    env.Promise_new_pending = (...args) => {
      const promise = newPending(...args);
      outerPromise ??= promise;
      return promise;
    };
    env.Promise_settle_resolve = (...args) => {
      if (args[0] === outerPromise) outerResolves++;
      return settleResolve(...args);
    };
    env.Promise_settle_reject = (...args) => {
      if (args[0] === outerPromise) outerRejects++;
      return settleReject(...args);
    };
    env.Promise_all = () => Promise.reject(4110);

    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const ids = numberVec(instance.exports, [1, 2, 3]);
    await expect(settled((instance.exports.fetchAllParallel as (ids: unknown) => Promise<number>)(ids))).rejects.toBe(
      4110,
    );
    expect(outerRejects).toBe(1);
    expect(outerResolves).toBe(0);
  });

  it("projects the unchanged exact owner through the standalone native runtime", async () => {
    const result = await compile(EXACT_SOURCE, {
      fileName: "issue-4110-host-free.ts",
      target: "standalone",
      emitWat: true,
      trackIrOutcomes: true,
    });
    expectSuccess(result);
    expect(result.irFirstSkipped ?? []).toContain("fetchAllParallel");
    expect((result.irOutcomes ?? []).find((outcome) => outcome.displayName === "fetchAllParallel")).toMatchObject({
      legacyBodyEmitted: false,
      irBodyEmitted: true,
      preparedComponentId: expect.stringMatching(/^prepared-component:/),
    });
    expect(
      WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map(({ module, name }) => `${module}.${name}`),
    ).toEqual(["env.__timer_set_timeout"]);
  });

  it.each([
    [
      "ordinary array",
      EXACT_SOURCE.replace("const pending: Promise<number>[] = [];", "const pending: number[] = [];").replace(
        "pending.push(fetchUser(ids[i]));",
        "pending.push(ids[i]);",
      ),
    ],
    [
      "non-numeric promise array",
      EXACT_SOURCE.replace("const pending: Promise<number>[] = [];", "const pending: Promise<string>[] = [];")
        .replace("pending.push(fetchUser(ids[i]));", "pending.push(Promise.resolve(ids[i].toString()));")
        .replace("code = code + results[i];", "code = code + results[i].length;"),
    ],
    ["generic owner", EXACT_SOURCE.replace("fetchAllParallel(ids: number[])", "fetchAllParallel<T>(ids: number[])")],
    [
      "nested executable",
      EXACT_SOURCE.replace("let code = 0;", "function zero(): number { return 0; }\n    let code = zero();"),
    ],
    [
      "pre-await capture",
      EXACT_SOURCE.replace(
        "const pending: Promise<number>[] = [];",
        "const offset = 1;\n    const pending: Promise<number>[] = [];",
      ).replace("return code;", "return code + offset;"),
    ],
    [
      "multiple awaits",
      EXACT_SOURCE.replace(
        "const results = await Promise.all(pending);",
        "const results = await Promise.all(pending);\n    await Promise.resolve(0);",
      ),
    ],
    [
      "nullable vector ABI",
      EXACT_SOURCE.replace("fetchAllParallel(ids: number[])", "fetchAllParallel(ids: number[] | null)")
        .replaceAll("ids.length", "ids!.length")
        .replaceAll("ids[i]", "ids![i]"),
    ],
  ])("keeps the %s near miss off prepared ownership", async (_label, source) => {
    const result = await compileTracked(source, `issue-4110-${String(_label).replaceAll(" ", "-")}.ts`);
    expectSuccess(result);
    expect(result.irFirstSkipped ?? []).not.toContain("fetchAllParallel");
    expect((result.irOutcomes ?? []).find((outcome) => outcome.displayName === "fetchAllParallel")).toMatchObject({
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  });

  it("keeps static-settled identity owners and unresolved cycles off the prepared fixed point", async () => {
    const source = `
      async function staticValue(): Promise<number> {
        const value = await Promise.resolve(1);
        return value;
      }
      async function a(id: number): Promise<number> { const value = await b(id); return value; }
      async function b(id: number): Promise<number> { const value = await a(id); return value; }
      export async function cycle(ids: number[]): Promise<number> {
        const pending: Promise<number>[] = [];
        for (let i = 0; i < ids.length; i++) pending.push(a(ids[i]));
        const values = await Promise.all(pending);
        let total = 0;
        for (let i = 0; i < values.length; i++) total = total + values[i];
        return total;
      }
      export async function settled(): Promise<number> { const value = await staticValue(); return value; }
    `;
    const result = await compileTracked(source, "issue-4110-fixed-point-near-misses.ts");
    expectSuccess(result);
    for (const name of ["staticValue", "a", "b", "cycle", "settled"]) {
      expect(result.irFirstSkipped ?? []).not.toContain(name);
      expect((result.irOutcomes ?? []).find((outcome) => outcome.displayName === name)).toMatchObject({
        legacyBodyEmitted: true,
        irBodyEmitted: false,
      });
    }
  });
});

describe("#4110 target-neutral async vector evidence", () => {
  function fixture() {
    const source = ts.createSourceFile(
      "issue-4110-sidecar.ts",
      "export async function f(p: Promise<number[]>): Promise<number[]> { return await p; }",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const inventory = buildIrUnitInventory([source], { entrySource: source });
    const unit = inventory.terminalUnits.find((candidate) => candidate.displayName === "f")!;
    const extern = irVal({ kind: "externref" });
    const fulfilledVec = irVec(irVal({ kind: "f64" }), true);
    const unrelatedVec = irVec(irVal({ kind: "f64" }), true);
    const promise = asValueId(0);
    const carried = asValueId(1);
    const resumed = asValueId(2);
    const plan = createIrAsyncPlan({
      schemaVersion: 1,
      ownerUnitId: unit.id,
      kind: "async-function",
      abi: canonicalPromiseAbi(fulfilledVec),
      entry: asAsyncStateId(0),
      params: [
        { value: promise, type: extern },
        { value: carried, type: unrelatedVec },
      ],
      values: [
        { value: promise, type: extern },
        { value: carried, type: unrelatedVec },
        { value: resumed, type: fulfilledVec },
      ],
      spills: [{ value: carried, type: unrelatedVec, storage: "slot" }],
      states: [
        {
          id: asAsyncStateId(0),
          body: [],
          terminator: {
            kind: "suspend",
            awaited: promise,
            resume: { state: asAsyncStateId(1), value: resumed },
            rejected: { kind: "reject" },
            live: [carried],
          },
        },
        {
          id: asAsyncStateId(1),
          resume: { value: resumed, type: fulfilledVec, source: "fulfilled" },
          body: [],
          terminator: { kind: "resolve", value: carried },
        },
      ],
      handlers: [],
      runtimeIntents: ASYNC_RUNTIME_FEATURES,
    });
    const fn: IrFunction = {
      unitId: unit.id,
      name: "f",
      params: [{ value: promise, type: extern, name: "p" }],
      resultTypes: [extern],
      blocks: [{ id: asBlockId(0), blockArgs: [], blockArgTypes: [], instrs: [], terminator: { kind: "unreachable" } }],
      exported: true,
      valueCount: 3,
      funcKind: "async",
      asyncPlan: plan,
      asyncRuntime: { kind: "host-wasmgc", adapters: [], states: plan.states },
    };
    const carrier = irSupportTypeRef(unit.sourceId, "vec-carrier", "vec-carrier");
    const data = irSupportTypeRef(unit.sourceId, "vec-data", "vec-data");
    const layout: IrVecLayoutRef = { carrierType: carrier, dataType: data, lengthFieldIndex: 0, dataFieldIndex: 1 };
    const fromExtern = irSupportFuncRef(unit.sourceId, "vec-host-bridge", "__vec_from_extern_test", 6);
    if (fromExtern.binding.kind !== "support") throw new Error("invalid vec materializer fixture");
    const voidSignature = Object.freeze({ params: Object.freeze([]), results: Object.freeze([]) });
    const sourceCallable: PreparedComponentAbiEntry = {
      id: irUnitCallableBindingId(unit.id),
      structuralReferenceKey: irCallableBindingKey(irUnitFuncRef(fn).binding),
      slotPolicy: "required",
      intent: { kind: "callable", origin: "source", unitId: unit.id, signature: voidSignature },
    };
    const materializerEntry: PreparedComponentAbiEntry = {
      id: fromExtern.binding.bindingId,
      structuralReferenceKey: irCallableBindingKey(fromExtern.binding),
      slotPolicy: "required",
      intent: { kind: "callable", origin: "support", sourceId: unit.sourceId, signature: voidSignature },
    };
    const typeEntry = (ref: typeof carrier): PreparedComponentAbiEntry => ({
      id: ref.binding.bindingId,
      structuralReferenceKey: irTypeBindingKey(ref.binding),
      slotPolicy: "required",
      intent: { kind: "type", shapeKey: ref.name },
    });
    const abi = new Map(
      [sourceCallable, materializerEntry, typeEntry(carrier), typeEntry(data)].map(
        (entry) => [entry.id, entry] as const,
      ),
    );
    return { inventory, unit, fn, layout, fromExtern, abi };
  }

  it("keeps serialization/hash target-neutral while covering every exact final plan vector object", () => {
    const { fn, layout } = fixture();
    const before = serializeIrAsyncPlan(fn.asyncPlan!);
    const beforeHash = hashIrAsyncPlan(fn.asyncPlan!);
    const attachment = attachIrVecLayouts(fn, () => layout);
    expect(attachment.function).toBe(fn);
    expect(serializeIrAsyncPlan(fn.asyncPlan!)).toBe(before);
    expect(hashIrAsyncPlan(fn.asyncPlan!)).toBe(beforeHash);
    expect(fn.asyncPlan).not.toHaveProperty("typeLayouts");

    const exactVecObjects = [
      ...(fn.asyncPlan!.abi.fulfillmentType ? [fn.asyncPlan!.abi.fulfillmentType] : []),
      ...fn.asyncPlan!.params.map((value) => value.type),
      ...fn.asyncPlan!.values.map((value) => value.type),
      ...fn.asyncPlan!.spills.map((spill) => spill.type),
      ...fn.asyncPlan!.states.flatMap((state) => (state.resume ? [state.resume.type] : [])),
    ].filter((type) => type.kind === "vec");
    expect(attachment.asyncPlanLayouts.size).toBe(new Set(exactVecObjects).size);
    expect(attachment.asyncPlanLayouts.size).toBeGreaterThan(1);
    for (const type of exactVecObjects) expect(attachment.asyncPlanLayouts.get(type)).toBe(layout);
  });

  it("accepts only valid exact-identity async vec sidecars", () => {
    const { inventory, unit, fn, layout, fromExtern, abi } = fixture();
    const fulfilledResumeType = fn.asyncPlan!.states.find((state) => state.resume?.source === "fulfilled")!.resume!
      .type;
    const exactEntries = [...attachIrVecLayouts(fn, () => layout).asyncPlanLayouts].map(([logicalType, candidate]) => ({
      logicalType,
      layout: candidate,
      ...(logicalType === fulfilledResumeType ? { fromExtern } : {}),
    }));
    const report = (
      typeLayouts: readonly {
        readonly logicalType: IrType;
        readonly layout: IrVecLayoutRef;
        readonly fromExtern?: ReturnType<typeof irSupportFuncRef>;
      }[],
    ) =>
      derivePreparedComponentDependencies({
        module: {
          functions: [
            {
              ...fn,
              asyncRuntime: {
                ...fn.asyncRuntime!,
                typeLayouts,
              },
            },
          ],
        },
        terminalUnitIds: new Set([unit.id]),
        inventory,
        abi: { get: (id) => abi.get(id) },
      }).components[0]!;

    expect(report(exactEntries).failures).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "implicit-support-reference-unavailable" })]),
    );
    const fulfilledEntry = exactEntries.find((entry) => entry.logicalType === fulfilledResumeType)!;
    const unrelatedEntry = exactEntries.find((entry) => entry.logicalType !== fulfilledResumeType)!;
    expect(fulfilledEntry.fromExtern).toBe(fromExtern);
    expect(unrelatedEntry).not.toHaveProperty("fromExtern");
    expect(
      report(exactEntries.map((entry) => (entry === unrelatedEntry ? { ...entry, fromExtern } : entry))).failures,
    ).toContainEqual(
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("outside an exact fulfilled resume type"),
      }),
    );
    const wrongFromExtern = irSupportFuncRef(unit.sourceId, "vec-host-bridge", "__vec_from_extern_wrong", 7);
    expect(
      report(
        exactEntries.map((entry) => (entry === fulfilledEntry ? { ...entry, fromExtern: wrongFromExtern } : entry)),
      ).failures,
    ).toContainEqual(
      expect.objectContaining({
        code: "unplanned-abi-binding",
        bindingId: wrongFromExtern.binding.kind === "support" ? wrongFromExtern.binding.bindingId : undefined,
      }),
    );
    expect(
      report([{ ...exactEntries[0]!, layout: { ...layout, dataFieldIndex: 0 } }, ...exactEntries.slice(1)]).failures,
    ).toContainEqual(
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("invalid field layout"),
      }),
    );
    expect(report([...exactEntries, exactEntries[0]!]).failures).toContainEqual(
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("duplicate backend layout"),
      }),
    );
    expect(
      report([...exactEntries, { logicalType: irVal({ kind: "f64" }), layout, fromExtern }]).failures,
    ).toContainEqual(
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("non-vector"),
      }),
    );
    expect(
      report([...exactEntries, { logicalType: irVec(irVal({ kind: "f64" }), true), layout, fromExtern }]).failures,
    ).toContainEqual(
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("dangling"),
      }),
    );
    expect(report(exactEntries.slice(1)).failures).toContainEqual(
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("no exact backend layout sidecar"),
      }),
    );
  });

  it("requires the planned binding to own the exact pre-sealed allocator object", () => {
    const { unit } = fixture();
    const owned: WasmFunction = { name: "owned", typeIdx: 0, locals: [], body: [], exported: false };
    const foreign: WasmFunction = { ...owned, name: "foreign" };
    const bindingId = irUnitCallableBindingId(unit.id);
    const session = {
      hasPlan: (candidate: typeof bindingId) => candidate === bindingId,
      hasLocator: (candidate: typeof bindingId, func: WasmFunction) => candidate === bindingId && func === owned,
    };
    expect(exactPreparedUnitCallableBindingId(session, unit.id, owned)).toBe(bindingId);
    expect(exactPreparedUnitCallableBindingId(session, unit.id, foreign)).toBeUndefined();
  });

  it("rejects a mutable slot used on both sides of the suspension", () => {
    const { unit } = fixture();
    const extern = irVal({ kind: "externref" });
    const f64 = irVal({ kind: "f64" });
    const promise = asValueId(0);
    const written = asValueId(1);
    const resumed = asValueId(2);
    const returned = asValueId(3);
    const fn: IrFunction = {
      unitId: unit.id,
      name: "sharedSlot",
      params: [{ value: promise, type: extern, name: "p" }],
      resultTypes: [f64],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            { kind: "const", value: { kind: "f64", value: 1 }, result: written, resultType: f64 },
            { kind: "slot.write", slotIndex: 0, value: written, result: null, resultType: null },
            { kind: "await", operand: promise, result: resumed, resultType: f64 },
            { kind: "slot.read", slotIndex: 0, result: returned, resultType: f64 },
          ],
          terminator: { kind: "return", values: [returned] },
        },
      ],
      exported: false,
      valueCount: 4,
      slots: [{ index: 0, name: "shared", type: f64 }],
      funcKind: "async",
    };
    expect(prepareSingleAwaitIrFunction(fn)).toBeNull();
  });
});
