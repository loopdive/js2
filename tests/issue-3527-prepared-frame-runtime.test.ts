// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { emitBinary } from "../src/emit/binary.js";
import { createEmptyModule, type Import, type StructTypeDef, type WasmFunction } from "../src/ir/types.js";
import type { IrBindingId, IrUnitId } from "../src/ir/identity.js";
import { emitPreparedFrame, preflightPreparedFrame } from "../src/codegen/prepared-async-frame-engine.js";
import type {
  PreparedFrameHandle,
  PreparedFramePlan,
  PreparedFrameResources,
} from "../src/codegen/prepared-async-frame-types.js";

import { emitPreparedIrAsyncFrame } from "../src/codegen/prepared-async-frame-adapter.js";
import type { PreparedIrAsyncFrameResources, PreparedFrameOutput } from "../src/codegen/prepared-async-frame-types.js";
import {
  asAsyncStateId,
  canonicalPromiseAbi,
  createIrAsyncPlan,
  createPreparedIrAsyncRuntime,
} from "../src/ir/async-plan.js";
import { ASYNC_RUNTIME_FEATURES, asPreparedAsyncHostAdapter } from "../src/ir/async-runtime-providers.js";
import { RuntimeManifestBuilder, projectRuntimeBackendRequirements } from "../src/ir/runtime-manifest.js";
import { irCallableBindingKey, irImportFuncRef, irSupportFuncRef } from "../src/ir/callable-bindings.js";
import { asValueId, irVal, type IrFunction } from "../src/ir/nodes.js";

const ext = { kind: "externref" } as const;
const num = { kind: "f64" } as const;
const i32 = { kind: "i32" } as const;

function harness() {
  const mod = createEmptyModule();
  let sequence = 0;
  const handle = <T extends object>(target: T): PreparedFrameHandle<T> => ({
    bindingId: `test:${sequence++}` as IrBindingId,
    target,
  });
  const signature = (
    params: (typeof ext | typeof num | typeof i32 | { kind: "ref"; typeIdx: number })[],
    results: (typeof ext | typeof num)[],
  ) => {
    mod.types.push({ kind: "func", params, results });
    return mod.types.length - 1;
  };
  const imported = (
    name: string,
    params: Parameters<typeof signature>[0],
    results: Parameters<typeof signature>[1],
  ) => {
    const target: Import = { module: "host", name, desc: { kind: "func", typeIdx: signature(params, results) } };
    mod.imports.push(target);
    return handle(target);
  };
  const create = imported("create", [], [ext]);
  const resolve = imported("resolve", [ext], [ext]);
  const react = imported("react", [ext, ext, ext], [ext]);
  const wrap = imported("wrap", [i32, ext], [ext]);
  const fulfill = imported("fulfill", [ext, ext], [ext]);
  const reject = imported("reject", [ext, ext], [ext]);
  const caught = imported("caught", [], [ext]);
  const box = imported("box", [num], [ext]);
  const unbox = imported("unbox", [ext], [num]);
  const tag = { name: "exception", typeIdx: signature([ext], []) };
  mod.tags.push(tag);
  const allocate = (name: string, typeIdx: number) => {
    const fn: WasmFunction = { name, typeIdx, locals: [], body: [{ op: "unreachable" }], exported: false };
    mod.functions.push(fn);
    return handle(fn);
  };
  const make = (source: string, callbackBase: number, offset = 1) => {
    const owner = source as IrUnitId;
    const frame: StructTypeDef = {
      kind: "struct",
      name: `frame:${source}`,
      fields: [
        { name: "state", type: i32, mutable: true },
        { name: "sent", type: ext, mutable: true },
        { name: "mode", type: i32, mutable: true },
        { name: "abrupt", type: ext, mutable: true },
        { name: "error", type: ext, mutable: true },
        { name: "seed", type: num, mutable: false },
        { name: "live", type: num, mutable: true },
        { name: "first", type: num, mutable: true },
        { name: "result", type: ext, mutable: true },
      ],
    };
    mod.types.push(frame);
    const frameIndex = mod.types.length - 1;
    const entry = allocate("same", signature([num], [ext]));
    const resume = allocate("same_resume", signature([{ kind: "ref", typeIdx: frameIndex }], []));
    const stepType = signature([ext, ext], [ext]);
    const fulfillStep = allocate(`__cb_${callbackBase}`, stepType);
    const rejectStep = allocate(`__cb_${callbackBase + 1}`, stepType);
    const resources: PreparedFrameResources = {
      owner,
      frame: handle(frame),
      resultField: 8,
      entry,
      resume,
      fulfillStep,
      rejectStep,
      exceptionTag: handle(tag),
      runtime: {
        kind: "host",
        create,
        resolve,
        react,
        wrap,
        fulfill,
        reject,
        caught,
        fulfillCallback: { id: callbackBase, target: fulfillStep },
        rejectCallback: { id: callbackBase + 1, target: rejectStep },
      },
      operations: [box, unbox],
      conversions: [
        { from: num, to: ext, operation: { kind: "helper", target: box } },
        { from: ext, to: num, operation: { kind: "helper", target: unbox } },
      ],
      undefinedSource: { kind: "not-required" },
      assertCurrent() {},
      allocator: {
        function(h) {
          const imp = mod.imports.indexOf(h.target as Import);
          const def = mod.functions.indexOf(h.target as WasmFunction);
          if (imp < 0 && def < 0) throw new Error("unbound function");
          return { index: imp >= 0 ? imp : mod.imports.length + def, target: h.target };
        },
        type(h) {
          return { index: mod.types.indexOf(h.target), target: h.target };
        },
        tag(h) {
          return { index: mod.tags.indexOf(h.target as typeof tag), target: h.target };
        },
      },
    };
    const plan: PreparedFramePlan = {
      owner,
      handlers: [],
      values: [
        { id: 0, type: num, param: 0 },
        { id: 1, type: num, spill: 6 },
        { id: 2, type: num, spill: 7 },
        { id: 3, type: num },
      ],
      states: [
        {
          id: 0,
          restore: [],
          body(e) {
            e.body.push(
              { op: "local.get", index: e.local(0) },
              { op: "f64.const", value: offset },
              { op: "f64.add" },
              { op: "local.set", index: e.local(1) },
            );
          },
          terminator: {
            kind: "suspend",
            next: 1,
            live: [1],
            awaited(e) {
              e.body.push({ op: "local.get", index: e.local(0) }, e.call(box));
            },
          },
        },
        {
          id: 1,
          restore: [1],
          resume(e) {
            e.resumeValue();
            e.body.push(e.call(unbox), { op: "local.set", index: e.local(2) });
          },
          body() {},
          terminator: {
            kind: "suspend",
            next: 2,
            live: [1, 2],
            awaited(e) {
              e.body.push(
                { op: "local.get", index: e.local(2) },
                { op: "f64.const", value: 2 },
                { op: "f64.add" },
                e.call(box),
              );
            },
          },
        },
        {
          id: 2,
          restore: [1, 2],
          resume(e) {
            e.resumeValue();
            e.body.push(e.call(unbox), { op: "local.set", index: e.local(3) });
          },
          body() {},
          terminator: {
            kind: "resolve",
            value(e) {
              e.body.push(
                { op: "local.get", index: e.local(1) },
                { op: "local.get", index: e.local(2) },
                { op: "f64.add" },
                { op: "local.get", index: e.local(3) },
                { op: "f64.add" },
                e.call(box),
              );
            },
          },
        },
      ],
    };
    return { plan, resources };
  };
  const publish = (
    item: ReturnType<typeof make>,
    exportName: string,
    out: PreparedFrameOutput = emitPreparedFrame(item.plan, item.resources),
  ) => {
    for (const key of ["entry", "resume", "fulfillStep", "rejectStep"] as const)
      Object.assign(item.resources[key].target, out[key]);
    for (const [name, h] of [
      [exportName, item.resources.entry],
      [item.resources.fulfillStep.target.name, item.resources.fulfillStep],
      [item.resources.rejectStep.target.name, item.resources.rejectStep],
    ] as const) {
      mod.exports.push({ name, desc: { kind: "func", index: item.resources.allocator.function(h).index } });
    }
  };
  const run = async (boxValue: (n: number) => unknown = (n) => n) => {
    const events: string[] = [];
    const capabilities = new Map<
      Promise<unknown>,
      { resolve: (value: unknown) => void; reject: (value: unknown) => void }
    >();
    let caughtReason: unknown;
    const { instance } = await WebAssembly.instantiate(emitBinary(mod), {
      host: {
        create() {
          let resolve!: (v: unknown) => void;
          let reject!: (v: unknown) => void;
          const p = new Promise((a, b) => {
            resolve = a;
            reject = b;
          });
          capabilities.set(p, { resolve, reject });
          return p;
        },
        undefinedValue: () => undefined,
        increment: (n: number) => n + 1,
        sum: (a: number, b: number) => a + b,
        resolve: (v: unknown) => Promise.resolve(v),
        react: (p: Promise<unknown>, yes: (v: unknown) => unknown, no: (v: unknown) => unknown) => p.then(yes, no),
        wrap: (id: number, frame: unknown) => (v: unknown) => {
          events.push(`callback:${id}`);
          return (exports[`__cb_${id}`] as CallableFunction)(frame, v);
        },
        fulfill: (p: Promise<unknown>, v: unknown) => {
          capabilities.get(p)!.resolve(v);
          return v;
        },
        reject: (p: Promise<unknown>, v: unknown) => {
          capabilities.get(p)!.reject(v);
          return v;
        },
        caught: () => caughtReason,
        box: (n: number) => {
          try {
            return boxValue(n);
          } catch (error) {
            caughtReason = error;
            throw error;
          }
        },
        unbox: (n: number) => n,
      },
    });
    const exports = instance.exports;
    return { exports, events };
  };
  const scalar = () => {
    const fn = allocate("__async_resume_fsame__ir", signature([], [num]));
    fn.target.body = [{ op: "f64.const", value: 77 }];
    mod.exports.push({
      name: fn.target.name,
      desc: { kind: "func", index: mod.imports.length + mod.functions.indexOf(fn.target) },
    });
  };
  return { mod, make, publish, run, imported, scalar };
}

describe("prepared physical frame engine", () => {
  it("executes two input-dependent awaits and preserves live values and Promise identity", async () => {
    const h = harness();
    const item = h.make("source:a/same", 0);
    h.publish(item, "run");
    const { exports, events } = await h.run();
    const p = (exports.run as CallableFunction)(7) as Promise<number>;
    expect(p).toBeInstanceOf(Promise);
    const alias = p;
    events.push("after-call");
    await Promise.resolve();
    events.push("after-flush");
    expect(await p).toBe(24);
    expect(alias).toBe(p);
    expect(events).toEqual(["after-call", "callback:0", "after-flush", "callback:0"]);
    const oracleEvents: string[] = [];
    const javascript = async (seed: number) => {
      const live = seed + 1;
      const first = await seed;
      oracleEvents.push("callback:0");
      const second = await (first + 2);
      oracleEvents.push("callback:0");
      return live + first + second;
    };
    const oracle = javascript(7);
    oracleEvents.push("after-call");
    await Promise.resolve();
    oracleEvents.push("after-flush");
    expect(await p).toBe(await oracle);
    expect(events).toEqual(oracleEvents);
    expect(await (exports.run as CallableFunction)(11)).toBe(36);
  });
  it("reads delivered values through the resume seam rather than reusing awaited locals", async () => {
    const h = harness();
    const item = h.make("source:delivered/same", 0);
    h.publish(item, "run");
    let calls = 0;
    const { exports } = await h.run((value) => {
      // Transform only the two awaited results; final settlement stays intact.
      return ++calls <= 2 ? Promise.resolve(value + 10) : value;
    });
    // live=8, first=17, second=29. Reading the original operand yields 24.
    expect(await (exports.run as CallableFunction)(7)).toBe(54);
    expect(calls).toBe(3);
  });
  it("keeps same-named functions distinct after a late import and function remap", async () => {
    const h = harness();
    const a = h.make("a/same", 0),
      b = h.make("b/same", 2, 10);
    h.imported("box", [num], [ext]);
    h.mod.functions.reverse();
    h.scalar();
    h.publish(a, "first");
    h.publish(b, "second");
    const { exports } = await h.run();
    expect(await (exports.first as CallableFunction)(3)).toBe(12);
    expect(await (exports.second as CallableFunction)(3)).toBe(21);
    expect((exports.__async_resume_fsame__ir as CallableFunction)()).toBe(77);
    expect(a.resources.resume.target).not.toBe(b.resources.resume.target);
  });
  it("refuses a removed resource without publishing any bodies", () => {
    const h = harness();
    const a = h.make("a", 0);
    preflightPreparedFrame(a.plan, a.resources);
    h.mod.functions.splice(h.mod.functions.indexOf(a.resources.resume.target), 1);
    expect(() => emitPreparedFrame(a.plan, a.resources)).toThrow("unbound");
    expect(a.resources.entry.target.body).toEqual([{ op: "unreachable" }]);
  });
  it("rejects synchronous throws and rejected awaits using the same result Promise", async () => {
    for (const rejection of [false, true]) {
      const h = harness();
      const a = h.make("a", 0);
      h.publish(a, "run");
      const reason = new Error("second await");
      const { exports } = await h.run((n) => {
        if (n === 9) {
          if (rejection) return Promise.reject(reason);
          throw reason;
        }
        return n;
      });
      const p = (exports.run as CallableFunction)(7);
      await expect(p).rejects.toBe(reason);
    }
  });
  it("fails before publication when an operation removes a bound resource", () => {
    const h = harness();
    const a = h.make("a", 0);
    const first = a.plan.states[0]!;
    const plan = {
      ...a.plan,
      states: [
        {
          ...first,
          body() {
            h.mod.functions.splice(h.mod.functions.indexOf(a.resources.entry.target), 1);
          },
        },
        ...a.plan.states.slice(1),
      ],
    };
    expect(() => emitPreparedFrame(plan, a.resources)).toThrow("allocator changed during emission");
    expect(a.resources.resume.target.body).toEqual([{ op: "unreachable" }]);
  });
  it("refuses stale authority, unsupported handlers and a missing callback capability", () => {
    const h = harness();
    const a = h.make("a", 0);
    expect(() =>
      emitPreparedFrame(a.plan, {
        ...a.resources,
        assertCurrent() {
          throw new Error("stale current runtime");
        },
      }),
    ).toThrow("stale current runtime");
    expect(() => emitPreparedFrame({ ...a.plan, handlers: [undefined as never] }, a.resources)).toThrow("handlers");
    const rt = a.resources.runtime;
    if (rt.kind !== "host") throw new Error("expected host");
    h.mod.imports.splice(h.mod.imports.indexOf(rt.wrap.target as Import), 1);
    expect(() => emitPreparedFrame(a.plan, a.resources)).toThrow("unbound");
    expect(a.resources.entry.target.body).toEqual([{ op: "unreachable" }]);
  });
  it("rejects a transient resolver change during step emission before returning outputs", () => {
    const h = harness();
    const a = h.make("a", 0);
    const lookup = a.resources.allocator.function;
    let bodyEmitted = false;
    let resumeReads = 0;
    const first = a.plan.states[0]!;
    const plan = {
      ...a.plan,
      states: [
        {
          ...first,
          body(e: Parameters<typeof first.body>[0]) {
            first.body(e);
            bodyEmitted = true;
          },
        },
        ...a.plan.states.slice(1),
      ],
    };
    const resources = {
      ...a.resources,
      allocator: {
        ...a.resources.allocator,
        function(handle: Parameters<typeof lookup>[0]) {
          const found = lookup(handle);
          if (bodyEmitted && handle === a.resources.resume && ++resumeReads === 2)
            return { ...found, index: found.index + 1 };
          return found;
        },
      },
    };
    // First resume read emits the entry call; second emits fulfill-step's call.
    expect(() => emitPreparedFrame(plan, resources)).toThrow("allocator changed during emission");
    expect(resumeReads).toBe(2);
    for (const key of ["entry", "resume", "fulfillStep", "rejectStep"] as const) {
      expect(a.resources[key].target.body).toEqual([{ op: "unreachable" }]);
    }
  });
  it("rejects sparse/duplicate parameter slots and malformed spill fields before operations", () => {
    const h = harness();
    const a = h.make("a", 0);
    const cases = [
      a.plan.values.map((v) => (v.id === 0 ? { ...v, param: 1 } : v)),
      a.plan.values.map((v) => (v.id === 1 ? { ...v, param: 0 } : v)),
      a.plan.values.map((v) => (v.id === 1 ? { ...v, spill: 8 } : v)),
      a.plan.values.map((v) => (v.id === 1 ? { ...v, spill: -1 } : v)),
      a.plan.values.map((v) => (v.id === 1 ? { ...v, type: ext } : v)),
    ];
    for (const values of cases) {
      let entered = false;
      const plan = {
        ...a.plan,
        values,
        states: a.plan.states.map((s) => ({
          ...s,
          body() {
            entered = true;
          },
        })),
      };
      expect(() => emitPreparedFrame(plan, a.resources)).toThrow(/parameter|spill/);
      expect(entered).toBe(false);
      expect(a.resources.entry.target.body).toEqual([{ op: "unreachable" }]);
    }
  });
  it("rejects an allocator that materializes on lookup against the supplied sealed view", () => {
    const h = harness();
    const a = h.make("a", 0);
    const count = h.mod.imports.length;
    const lookup = a.resources.allocator.function;
    let allocations = 0;
    const resources = {
      ...a.resources,
      assertCurrent() {
        if (h.mod.imports.length !== count) throw new Error("sealed resource closure changed");
      },
      allocator: {
        ...a.resources.allocator,
        function(handle: Parameters<typeof lookup>[0]) {
          if (!allocations++) {
            h.imported("box", [num], [ext]);
          }
          return lookup(handle);
        },
      },
    };
    expect(() => emitPreparedFrame(a.plan, resources)).toThrow("sealed resource closure changed");
    expect(a.resources.entry.target.body).toEqual([{ op: "unreachable" }]);
  });
  it("rejects foreign owners, duplicate states, missing spills and wrong carriers before emission", () => {
    const h = harness();
    const a = h.make("a", 0);
    expect(() => emitPreparedFrame({ ...a.plan, owner: "foreign" as IrUnitId }, a.resources)).toThrow("foreign owner");
    expect(() => emitPreparedFrame({ ...a.plan, states: [a.plan.states[0]!, a.plan.states[0]!] }, a.resources)).toThrow(
      "unique",
    );
    expect(() =>
      emitPreparedFrame({ ...a.plan, values: a.plan.values.filter((v) => v.id !== 1) }, a.resources),
    ).toThrow("missing spill");
    a.resources.frame.target.fields[8]!.type = num;
    expect(() => emitPreparedFrame(a.plan, a.resources)).toThrow("Promise result carrier");
    expect(a.resources.entry.target.body).toEqual([{ op: "unreachable" }]);
  });
});

function adapterFixture(
  h: ReturnType<typeof harness>,
  suffix = "a",
  callbacks = 0,
  mode: "plain" | "converted" | "discard" | "undefined" | "f32" | "i64" = "plain",
) {
  const item = h.make(`ir-unit:v1:adapter:${suffix}`, callbacks);
  const owner = item.resources.owner;
  const increment = irSupportFuncRef(owner, "increment", "same");
  const sum = irSupportFuncRef(owner, "sum", "same");
  const callType = mode === "converted" ? ext : num;
  const incrementHandle = h.imported("increment", [callType], [callType]);
  const sumHandle = h.imported("sum", [callType, callType], [callType]);
  const constantType =
    mode === "undefined"
      ? ext
      : mode === "f32"
        ? ({ kind: "f32" } as const)
        : mode === "i64"
          ? ({ kind: "i64" } as const)
          : undefined;
  const undefinedHelper = mode === "undefined" ? h.imported("undefinedValue", [], [ext]) : undefined;
  const number = irVal(num);
  const value = asValueId;
  const plan = createIrAsyncPlan({
    schemaVersion: 1,
    ownerUnitId: owner,
    kind: "async-function",
    entry: asAsyncStateId(0),
    abi: canonicalPromiseAbi(mode === "undefined" ? irVal(ext) : number),
    params: [{ value: value(0), type: number }],
    values: [
      ...[0, 1, 2, 3, 4, 5].map((id) => ({ value: value(id), type: number })),
      ...(constantType ? [{ value: value(6), type: irVal(constantType) }] : []),
    ],
    spills: [1, 2].map((id) => ({ value: value(id), type: number, storage: "ssa" as const })),
    handlers: [],
    runtimeIntents: [
      ...ASYNC_RUNTIME_FEATURES,
      "promise.number.bridge",
      ...(mode === "undefined" ? ["value.undefined" as const] : []),
    ],
    states: [
      {
        id: asAsyncStateId(0),
        body: [{ kind: "call", target: increment, args: [value(0)], result: value(1), resultType: number }],
        terminator: {
          kind: "suspend",
          awaited: value(0),
          resume: { state: asAsyncStateId(1), value: value(2) },
          rejected: { kind: "reject" },
          live: [value(1)],
        },
      },
      {
        id: asAsyncStateId(1),
        resume: { value: value(2), type: number, source: "fulfilled" },
        body: [],
        terminator: {
          kind: "suspend",
          awaited: value(2),
          resume: { state: asAsyncStateId(2), value: value(3) },
          rejected: { kind: "reject" },
          live: [value(1), value(2)],
        },
      },
      {
        id: asAsyncStateId(2),
        resume: { value: value(3), type: number, source: "fulfilled" },
        body: [
          { kind: "call", target: sum, args: [value(1), value(2)], result: value(4), resultType: number },
          { kind: "call", target: sum, args: [value(4), value(3)], result: value(5), resultType: number },
          ...(mode === "discard"
            ? [{ kind: "call" as const, target: increment, args: [value(3)], result: null, resultType: null }]
            : []),
          ...(constantType
            ? [
                {
                  kind: "const" as const,
                  result: value(6),
                  resultType: irVal(constantType),
                  value:
                    mode === "undefined"
                      ? { kind: "undefined" as const }
                      : mode === "f32"
                        ? { kind: "f32" as const, value: 3.5 }
                        : { kind: "i64" as const, value: 7n },
                },
              ]
            : []),
        ],
        terminator: { kind: "resolve", value: value(mode === "undefined" ? 6 : 5) },
      },
    ],
  });
  const builder = new RuntimeManifestBuilder({
    target: "host",
    backend: "wasmgc",
    numberBoundary: { box: "host", unbox: "host" },
  });
  for (const feature of plan.runtimeIntents) builder.requestFeature(feature);
  const manifest = builder.freeze();
  const providers = Object.freeze(manifest.providers.filter((p) => plan.runtimeIntents.some((f) => f === p.feature)));
  const capabilities = new Set(providers.flatMap((p) => p.hostCapabilities));
  const adapters = Object.freeze(
    manifest.hostCapabilityRecords
      .filter((r) => capabilities.has(r.capability))
      .map((r) => {
        const record = asPreparedAsyncHostAdapter(r);
        return Object.freeze({
          capability: record.capability,
          record,
          target: irImportFuncRef(record.module, record.field, record.field),
        });
      }),
  );
  const runtime = createPreparedIrAsyncRuntime({
    kind: "host-wasmgc",
    plan,
    manifest,
    providers,
    backendRequirements: projectRuntimeBackendRequirements(providers),
    states: plan.states,
    adapters,
  });
  const fn: IrFunction = {
    unitId: owner,
    name: "same",
    params: [{ value: value(0), type: number, name: "seed" }],
    resultTypes: [irVal(ext)],
    blocks: [],
    exported: true,
    valueCount: 6,
    funcKind: "async",
    asyncPlan: plan,
    asyncRuntime: runtime,
  };
  const resources: PreparedIrAsyncFrameResources = {
    ...item.resources,
    values: [
      ...item.plan.values,
      { id: 4, type: num },
      { id: 5, type: num },
      ...(constantType ? [{ id: 6, type: constantType }] : []),
    ],
    operations: [
      ...item.resources.operations,
      incrementHandle,
      sumHandle,
      ...(undefinedHelper ? [undefinedHelper] : []),
    ],
    undefinedSource: undefinedHelper ? { kind: "helper", target: undefinedHelper } : item.resources.undefinedSource,
    callTargets: new Map([
      [irCallableBindingKey(increment.binding), incrementHandle],
      [irCallableBindingKey(sum.binding), sumHandle],
    ]),
    callSignatures: new Map([
      [irCallableBindingKey(increment.binding), { params: [callType], results: [callType] }],
      [irCallableBindingKey(sum.binding), { params: [callType, callType], results: [callType] }],
    ]),
  };
  return { item, fn, runtime, resources };
}

describe("prepared IR adapter — isolated resources, not C production acceptance", () => {
  it("executes authentic two-await IR through bound calls, delivery, live spills and settlement", async () => {
    const h = harness();
    const a = adapterFixture(h);
    h.publish(a.item, "run", emitPreparedIrAsyncFrame(a.fn, a.runtime, a.resources));
    const { exports, events } = await h.run();
    const p = (exports.run as CallableFunction)(7);
    events.push("after-call");
    expect(await p).toBe(22);
    expect(events).toEqual(["after-call", "callback:0", "callback:0"]);
    expect(await (exports.run as CallableFunction)(11)).toBe(34);
  });
  it("keeps same-spelling call bindings and owners separate across remapping", async () => {
    const h = harness();
    const a = adapterFixture(h, "a", 0);
    const b = adapterFixture(h, "b", 2);
    h.imported("box", [num], [ext]);
    h.mod.functions.reverse();
    h.publish(a.item, "a", emitPreparedIrAsyncFrame(a.fn, a.runtime, a.resources));
    h.publish(b.item, "b", emitPreparedIrAsyncFrame(b.fn, b.runtime, b.resources));
    const { exports } = await h.run();
    expect(await (exports.a as CallableFunction)(7)).toBe(22);
    expect(await (exports.b as CallableFunction)(11)).toBe(34);
    expect(() =>
      emitPreparedIrAsyncFrame(a.fn, a.runtime, {
        ...a.resources,
        callTargets: b.resources.callTargets,
        callSignatures: b.resources.callSignatures,
      }),
    ).toThrow("call binding");
  });
  it.each(["converted", "discard", "undefined", "f32", "i64"] as const)(
    "executes accepted %s call/constant forms",
    async (mode) => {
      const h = harness();
      const a = adapterFixture(h, "a", 0, mode);
      h.publish(a.item, "run", emitPreparedIrAsyncFrame(a.fn, a.runtime, a.resources));
      const { exports } = await h.run();
      expect(await (exports.run as CallableFunction)(7)).toBe(mode === "undefined" ? undefined : 22);
      if (mode === "undefined")
        expect(() =>
          emitPreparedIrAsyncFrame(a.fn, a.runtime, { ...a.resources, undefinedSource: { kind: "not-required" } }),
        ).toThrow("canonical undefined");
    },
  );
  it("rejects missing, malformed and changed physical call signatures", () => {
    const h = harness();
    const a = adapterFixture(h);
    const key = [...a.resources.callTargets.keys()][0]!;
    for (const signature of [
      undefined,
      { params: [], results: [num] },
      { params: [num], results: [] },
      { params: [num], results: [num, num] },
    ]) {
      const callSignatures = new Map(a.resources.callSignatures);
      if (signature) callSignatures.set(key, signature);
      else callSignatures.delete(key);
      expect(() => emitPreparedIrAsyncFrame(a.fn, a.runtime, { ...a.resources, callSignatures })).toThrow(
        /signature|call result/,
      );
      expect(a.resources.entry.target.body).toEqual([{ op: "unreachable" }]);
    }
  });
  it("rejects missing mappings, conversions and foreign authority without installing outputs", () => {
    const h = harness();
    const a = adapterFixture(h);
    const variants: PreparedIrAsyncFrameResources[] = [
      { ...a.resources, values: a.resources.values.slice(1) },
      { ...a.resources, callTargets: new Map() },
      { ...a.resources, conversions: [] },
      { ...a.resources, owner: "foreign" as IrUnitId },
      { ...a.resources, values: a.resources.values.map((v) => (v.id === 1 ? { ...v, spill: undefined } : v)) },
    ];
    for (const r of variants) {
      expect(() => emitPreparedIrAsyncFrame(a.fn, a.runtime, r)).toThrow();
      expect(a.resources.entry.target.body).toEqual([{ op: "unreachable" }]);
    }
    expect(() => emitPreparedIrAsyncFrame(a.fn, { ...a.runtime }, a.resources)).toThrow("runtime attachment");
  });
  it("rejects resource-map mutation during detached emission", () => {
    const h = harness();
    const a = adapterFixture(h);
    const callTargets = new Map(a.resources.callTargets);
    const lookup = a.resources.allocator.function;
    const r = {
      ...a.resources,
      callTargets,
      allocator: {
        ...a.resources.allocator,
        function(handle: Parameters<typeof lookup>[0]) {
          callTargets.clear();
          return lookup(handle);
        },
      },
    };
    expect(() => emitPreparedIrAsyncFrame(a.fn, a.runtime, r)).toThrow("mapping changed");
    expect(a.resources.entry.target.body).toEqual([{ op: "unreachable" }]);
  });
});
