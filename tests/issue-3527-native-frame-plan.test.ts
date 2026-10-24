// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import {
  planPreparedNativeAsyncFrame,
  type PreparedNativeAsyncFrameInput,
} from "../src/ir/program/prepared-native-async-frame-plan.js";
import { planPreparedHostAsyncFrame } from "../src/ir/program/prepared-async-frame-plan.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { planAsyncFrameSetup } from "../src/ir/program/async-frame-setup.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { irUnitCallableBindingId } from "../src/ir/core/callable-bindings.js";

const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
  numberBoundary: { box: "native", unbox: "native" },
} as const;
const sources = {
  number:
    "export async function run(seed:number):Promise<number>{const first=await seed; const second=await first; return second;}",
  live: "export async function run(seed:number):Promise<number>{const first=await(seed+1); const second=await(first+2); return seed+first+second;}",
  empty: "export async function run():Promise<void>{await 1;}",
};
const programs = new Map<string, ReturnType<typeof requireProgram>>();
beforeAll(() => {
  vi.stubEnv("JS2WASM_IR_GVN", "0");
  try {
    for (const [name, source] of Object.entries(sources))
      programs.set(name, requireProgram(prepareWholeIrProgram({ ...sourceInput({ "./entry.ts": source }), policy })));
  } finally {
    vi.unstubAllEnvs();
  }
});

function input(name = "number", replay = false): PreparedNativeAsyncFrameInput {
  const original = programs.get(name)!;
  const program = replay ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
  const fn = program.runtime[0]!.prepared.functions.find((f) => f.name === "run")!;
  const anchor = program.inventory.sources.find((s) => s.kind === "entry")!;
  return {
    fn,
    backend: "wasmgc",
    target: "standalone",
    abiEntries: program.abi.entries,
    anchor,
    declarationOrderStart:
      Math.max(
        ...program.abi.entries
          .filter((r) => r.plan.order.sourceOrder === anchor.order)
          .map((r) => r.plan.order.declarationOrder),
      ) + 1,
  };
}
function planned(value = input()) {
  const outcome = planPreparedNativeAsyncFrame(value);
  if (outcome.kind !== "planned") throw Error(outcome.detail);
  return outcome.plan;
}
describe("native frame plans from source-owned prepared IR", () => {
  it.each([false, true])("joins native frames into the whole-program ABI, replay=%s", (replay) => {
    const original = programs.get("number")!;
    const program = replay ? decodePreparedIrProgram(encodePreparedIrProgram(original)) : original;
    const outcome = planAsyncFrameSetup(
      program,
      policy,
      program.runtime[0]!,
      [],
      program.inventory.sources.find((s) => s.kind === "entry")!,
    );
    expect(outcome.kind).toBe("planned");
    if (outcome.kind !== "planned") throw Error(outcome.detail);
    expect(outcome.setup.frames).toEqual([planned(input("number", replay))]);
    expect(outcome.setup.entries).toEqual(outcome.setup.frames[0]!.entries);
    const accepted = acceptPreparedIrProgram(program, {
      backend: "wasmgc",
      target: "standalone",
      sharedExceptionTag: false,
      utf8Storage: false,
      sourceMap: false,
      moduleName: "frame-join",
    });
    expect(accepted.kind).toBe("unsupported");
    if (accepted.kind !== "unsupported") throw Error("incomplete native runtime was accepted");
    expect(accepted.detail).not.toContain("async frames do not support wasmgc:standalone");
    expect(accepted.detail).toContain("native Promise inventory missing-runtime-configuration");
    expect(accepted.detail).toContain("complete native Promise inventory composition has not been issued");
  });
  it("allocates distinct supplemental bindings for multiple native owners", () => {
    const program = requireProgram(
      prepareWholeIrProgram({
        ...sourceInput({
          "./entry.ts":
            "async function first(n:number):Promise<number>{return await n;} export async function run(n:number):Promise<number>{return await first(n);}",
        }),
        policy,
      }),
    );
    const join = (value: typeof program) =>
      planAsyncFrameSetup(
        value,
        policy,
        value.runtime[0]!,
        [],
        value.inventory.sources.find((s) => s.kind === "entry")!,
      );
    const outcome = join(program);
    expect(outcome.kind).toBe("planned");
    if (outcome.kind !== "planned") throw Error(outcome.detail);
    expect(outcome.setup.frames).toHaveLength(2);
    expect(outcome.setup.frames.every((frame) => frame.kind === "native")).toBe(true);
    expect(outcome.setup.entries).toHaveLength(8);
    expect(new Set(outcome.setup.entries.map((entry) => entry.id)).size).toBe(8);
    expect(new Set(outcome.setup.entries.map((entry) => entry.order.declarationOrder)).size).toBe(8);
    expect(join(decodePreparedIrProgram(encodePreparedIrProgram(program)))).toEqual(outcome);
  });
  it.each(Object.keys(sources))(
    "preserves %s source planning through codec replay without host publication",
    (name) => {
      const plan = planned(input(name));
      expect(planned(input(name, true))).toEqual(plan);
      expect(plan.kind).toBe("native");
      expect(plan.owner).toBe(input(name).fn.unitId);
      expect(plan.primary.bindingId).toBe(irUnitCallableBindingId(plan.owner));
      expect(plan.frame.fields[plan.resultField]!.type).toEqual({ kind: "native-promise" });
      expect(plan.entries).toHaveLength(4);
      expect(plan.entries.map((e) => e.slotSpace)).toEqual(["type", "function", "function", "function"]);
      expect(
        plan.entries.every(
          (e) => e.intent.kind !== "export" && !(e.intent.kind === "callable" && e.intent.origin === "import"),
        ),
      ).toBe(true);
      expect(plan).not.toHaveProperty("imports");
      expect(plan).not.toHaveProperty("callbacks");
      expect(Object.isFrozen(plan)).toBe(true);
      expect(plan.bridges.map((b) => b.role)).toContain("number.box");
    },
  );
  it("plans actual native number conversion at suspend/resume and live spill storage", () => {
    const plan = planned(input("live"));
    expect(plan.bridges.map((b) => b.role)).toEqual(["number.box", "number.unbox"]);
    expect(plan.conversions).toEqual([
      { from: { kind: "f64" }, to: { kind: "externref" }, operation: { kind: "native-helper", role: "number.box" } },
      { from: { kind: "externref" }, to: { kind: "f64" }, operation: { kind: "native-helper", role: "number.unbox" } },
    ]);
    expect(plan.values.some((v) => v.spill !== undefined)).toBe(true);
    expect(plan.calls.length).toBeGreaterThan(0);
    expect(plan.undefinedSource).toEqual({ kind: "not-required" });
  });
  it("requires the canonical undefined provider for a bare return", () => {
    const plan = planned(input("empty"));
    expect(plan.undefinedSource).toEqual({ kind: "native-helper", role: "async.value.undefined" });
    expect(plan.bridges.map((b) => b.role)).toContain("async.value.undefined");
  });
  it.each(["host", "wasi", "strict-no-host"] as const)("does not reinterpret target %s as standalone", (target) => {
    expect(planPreparedNativeAsyncFrame({ ...input(), target })).toMatchObject({
      kind: "unsupported",
      feature: "prepared-native-async-frame",
    });
  });
  it("does not reinterpret Linear as WasmGC", () => {
    expect(planPreparedNativeAsyncFrame({ ...input(), backend: "linear" })).toMatchObject({ kind: "unsupported" });
  });
  it("rejects host callback publication and missing primary ABI", () => {
    const value = input();
    expect(planPreparedNativeAsyncFrame({ ...value, callbacks: {} } as PreparedNativeAsyncFrameInput)).toMatchObject({
      kind: "unsupported",
      detail: "native frames cannot publish host callbacks",
    });
    expect(planPreparedNativeAsyncFrame({ ...value, abiEntries: [] })).toMatchObject({
      kind: "unsupported",
      detail: "missing primary callable ABI",
    });
    expect(
      planPreparedHostAsyncFrame({
        ...value,
        callbacks: { fulfill: 1, reject: 2, occupiedIds: [], occupiedNames: [] },
      }),
    ).toMatchObject({ kind: "unsupported", feature: "prepared-host-async-frame" });
  });
  it("rejects a foreign runtime attachment before emitting declarations", () => {
    const value = input();
    expect(() =>
      planPreparedNativeAsyncFrame({ ...value, fn: { ...value.fn, asyncRuntime: input("live").fn.asyncRuntime } }),
    ).toThrow("IR async runtime attachment");
  });
  it("rejects changed selected providers instead of inventing bridge functions", () => {
    const value = input();
    const runtime = value.fn.asyncRuntime!;
    const providers = runtime.providers!.filter((p) => p.feature !== "promise.number.bridge");
    expect(() =>
      planPreparedNativeAsyncFrame({
        ...value,
        fn: { ...value.fn, asyncRuntime: Object.freeze({ ...runtime, providers: Object.freeze(providers) }) },
      }),
    ).toThrow("IR async runtime attachment");
  });
});
