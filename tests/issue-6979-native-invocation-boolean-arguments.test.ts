// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { prepareGetterProgram, getterRequirements } from "./helpers/native-getter-invocation-fixture.js";
import { replayOptions, replayProgram } from "./helpers/ir-whole-program-replay.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { assertNativeInvocationRequirementsCurrent } from "../src/ir/program/native-invocation-requirements.js";
import { nativeInvocationBooleanArguments } from "../src/ir/program/native-invocation-result-values.js";
import { buildClosureMethodArgument } from "../src/runtime/wasmgc/values/closure-argument-bodies.js";
import type { FuncHandle } from "../src/wasm/model/instructions.js";
import { emitBinary } from "../src/emit/binary.js";

const IDENTITY = `export function run(): number {
  const identity = function(flag: boolean): boolean { return flag; };
  const first = identity.call(null, true);
  const second = identity.apply(undefined, [false]);
  return (first ? 100 : 0) + (second ? 1 : 0);
}`;
const CONDITIONAL = `export function run(): number {
  const captured = 8;
  const choose = function(flag: boolean, value: number): boolean { return value > captured ? flag : !flag; };
  const a = choose.call(null, true, 10);
  const b = choose.apply(undefined, [false, 20]);
  const c = choose.call(undefined, false, 4);
  return (a ? 100 : 0) + (b ? 10 : 0) + (c ? 1 : 0);
}`;
const NUMERIC = `export function run(): number {
  const choose = function(flag: boolean, value: number): number { return flag ? value + 4 : value - 2; };
  return choose.call(null, true, 10) * 100 + choose.apply(undefined, [false, 20]);
}`;
const CHAIN = `export function run(): number {
  const identity = function(flag: boolean): boolean { return flag; };
  const first = identity.call(null, identity.call(null, true));
  const second = identity.apply(undefined, [identity.apply(undefined, [false])]);
  return (first ? 100 : 0) + (second ? 1 : 0);
}`;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await setImmediate();
});
const prepare = (source = IDENTITY, decoded = false, boxing = true) =>
  prepareGetterProgram(source, decoded, "./entry.ts", boxing);
function requirements(program: ReturnType<typeof prepare>) {
  const r = getterRequirements(program);
  if (!r.invocation) throw Error("lost actual source invocation owner");
  return { ...r, invocation: r.invocation };
}

describe("actual native Boolean argument value preservation", () => {
  for (const decoded of [false, true])
    for (const utf8Storage of [false, true])
      it(`round-trips true/false through real source parameter returns decoded=${decoded} utf8=${utf8Storage}`, async () => {
        vi.stubEnv("JS2WASM_IR_GVN", "0");
        const program = prepare(IDENTITY, decoded),
          r = requirements(program);
        expect(r.invocation.gaps).toEqual([]);
        expect(r.invocation.uses.flatMap((row) => row.booleanArguments ?? [])).toHaveLength(2);
        expect(r.invocation.booleanResults).toHaveLength(2);
        const outcome = await replayProgram(program, { ...replayOptions("wasmgc", "standalone"), utf8Storage });
        if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
        expect(outcome.run.emitted.module.imports).toEqual([]);
        for (let count = 0; count < 3; count++) expect((outcome.run.exports.run as () => number)()).toBe(100);
      }, 120000);
  for (const gvn of [false, true])
    it(`preserves Boolean formals through captured conditionals GVN=${gvn}`, async () => {
      vi.stubEnv("JS2WASM_IR_GVN", gvn ? "1" : "0");
      const program = prepare(CONDITIONAL, true);
      expect(requirements(program).invocation.gaps).toEqual([]);
      const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
      if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
      expect(outcome.run.emitted.module.imports).toEqual([]);
      expect((outcome.run.exports.run as () => number)()).toBe(101);
    }, 120000);
  for (const [source, expected] of [
    [NUMERIC, 1418],
    [CHAIN, 100],
  ] as const)
    it(`preserves ${source === NUMERIC ? "mixed Boolean/numeric parameters" : "chained Boolean invocation results"}`, async () => {
      vi.stubEnv("JS2WASM_IR_GVN", "0");
      const program = prepare(source, true);
      expect(requirements(program).invocation.gaps).toEqual([]);
      const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
      if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
      expect(outcome.run.emitted.module.imports).toEqual([]);
      expect((outcome.run.exports.run as () => number)()).toBe(expected);
    }, 120000);
  for (const call of [
    "identity.call(null)",
    "identity.call(null, undefined as any)",
    "identity.call(null, (undefined as unknown) as boolean)",
    "identity.apply(null, [])",
    "identity.call(null, 0 as unknown as boolean)",
  ])
    it(`refuses unproved input ${call} without changing it to false`, () => {
      vi.stubEnv("JS2WASM_IR_GVN", "0");
      const program = prepare(IDENTITY.replace("identity.call(null, true)", call));
      const r = requirements(program);
      expect(r.invocation.gaps.some((row) => /Boolean argument/.test(row.detail))).toBe(true);
      expect(acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone")).kind).not.toBe("accepted");
    });
  it("requires explicit native Boolean boxing policy", () => {
    vi.stubEnv("JS2WASM_IR_GVN", "0");
    expect(() => prepare(IDENTITY, true, false)).toThrow(/js.boolean.box.*box=unsupported/);
  });
  it("preserves a shadowed asserted Boolean named undefined", async () => {
    vi.stubEnv("JS2WASM_IR_GVN", "0");
    const text = IDENTITY.replace(
      "const first = identity.call(null, true);",
      "const undefined = false; const first = identity.call(null, (undefined as boolean));",
    ).replace("identity.apply(undefined, [false])", "identity.apply(null, [true])");
    const program = prepare(text, true);
    expect(requirements(program).invocation.gaps).toEqual([]);
    const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
    if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
    expect(outcome.run.emitted.module.imports).toEqual([]);
    expect((outcome.run.exports.run as () => number)()).toBe(1);
  }, 120000);
  it("preserves canonical asserted undefined for an actual numeric default", async () => {
    vi.stubEnv("JS2WASM_IR_GVN", "0");
    const program = prepare(
      `export function run(): number {
      const add = function(value: number = 17): number { return value + 3; };
      return add.call(null, undefined as number);
    }`,
      true,
    );
    expect(requirements(program).invocation.gaps).toEqual([]);
    const outcome = await replayProgram(program, replayOptions("wasmgc", "standalone"));
    if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
    expect(outcome.run.emitted.module.imports).toEqual([]);
    expect((outcome.run.exports.run as () => number)()).toBe(20);
  }, 120000);
  for (const projectionOnly of [false, true])
    it(`rejects forged raw argument provenance projectionOnly=${projectionOnly}`, () => {
      vi.stubEnv("JS2WASM_IR_GVN", "0");
      const program = structuredClone(prepare()),
        r = requirements(program);
      expect(r.invocation.gaps).toEqual([]);
      const functions = projectionOnly
        ? [program.runtime[0]!.prepared.functions]
        : [program.ir.functions, program.runtime[0]!.prepared.functions];
      let changed = 0;
      for (const population of functions)
        for (const fn of population)
          for (const block of fn.blocks)
            for (const instruction of block.instrs)
              if (
                instruction.kind === "call" &&
                instruction.target.binding.kind === "intrinsic" &&
                instruction.target.binding.symbol === "js.closure.call:1"
              ) {
                Object.assign(instruction, {
                  args: [instruction.args[0]!, instruction.args[1]!, instruction.args[0]!],
                });
                changed++;
              }
      expect(changed).toBe(projectionOnly ? 1 : 2);
      const use = r.invocation.uses.find((row) => row.kind === "method")!;
      expect(() => assertNativeInvocationRequirementsCurrent(r.invocation)).toThrow();
      expect(requirements(program).invocation.gaps.length).toBeGreaterThan(0);
      expect(nativeInvocationBooleanArguments(r.source, use.ownerUnitId, "projection", use.occurrence)).toBeUndefined();
    });
  it("refuses cyclic boxed result proof without looping or mistaking an annotation for evidence", () => {
    vi.stubEnv("JS2WASM_IR_GVN", "0");
    const program = structuredClone(prepare()),
      r = requirements(program);
    const use = r.invocation.uses.find((row) => row.kind === "method")!;
    const row = r.source.demands.occurrences[use.occurrence]!.instruction;
    if (row.kind !== "call") throw Error("lost original method call");
    const input = row.args[2]!,
      fn = program.runtime[0]!.prepared.functions.find((row) => row.unitId === use.ownerUnitId)!;
    const instructions = fn.blocks.flatMap((block) => block.instrs);
    const box = instructions.find((row) => row.result === input)!,
      unbox = instructions.find((row) => row.kind === "intrinsic" && row.id === "js.boolean.unbox")!;
    expect(box.kind).toBe("intrinsic");
    Object.assign(box, { args: [unbox.result] });
    expect(nativeInvocationBooleanArguments(r.source, use.ownerUnitId, "projection", use.occurrence)).toBeUndefined();
  });
  it("uses the strict native argument cast in the actual producer method slot", async () => {
    vi.stubEnv("JS2WASM_IR_GVN", "0");
    const outcome = await replayProgram(prepare(IDENTITY, true), replayOptions("wasmgc", "standalone"));
    if (outcome.kind !== "ran") throw Error(JSON.stringify(outcome.failure));
    expect(outcome.run.emitted.module.imports).toEqual([]);
    // Clone-only observers of real compiler slots. No forged source, algorithms,
    // allocation roots or production completion capability are supplied.
    const observer = structuredClone(outcome.run.emitted.module);
    const method = observer.functions.findIndex((row) => row.name === "__call_fn_method_1");
    const boxer = observer.functions.findIndex((row) => row.name === "__box_number");
    if (method < 0 || boxer < 0) throw Error("lost real producer method/Number boxer");
    const callee = observer.globals.length,
      argument = callee + 1;
    for (const name of ["observedCallee", "observedArgument"])
      observer.globals.push({ name, type: { kind: "externref" }, mutable: true, init: [{ op: "ref.null.extern" }] });
    observer.functions[method]!.body.unshift(
      { op: "local.get", index: 1 },
      { op: "global.set", index: callee },
      { op: "local.get", index: 2 },
      { op: "global.set", index: argument },
    );
    observer.exports.push(
      { name: "observedCallee", desc: { kind: "global", index: callee } },
      { name: "observedArgument", desc: { kind: "global", index: argument } },
      { name: "nativeMethod", desc: { kind: "func", index: method } },
      { name: "boxNumber", desc: { kind: "func", index: boxer } },
    );
    const compiled = new WebAssembly.Module(emitBinary(observer) as Uint8Array<ArrayBuffer>);
    const fresh = () => {
      const api = new WebAssembly.Instance(compiled).exports as Record<string, any>;
      expect(api.run()).toBe(100);
      return { api, self: api.observedCallee.value, value: api.observedArgument.value };
    };
    const positive = fresh();
    expect(positive.api.nativeMethod(null, positive.self, positive.value)).toBe(positive.value);
    let reads = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          reads++;
          throw Error("unexpected host hook");
        },
      },
    );
    for (const make of [
      (api: Record<string, any>) => api.boxNumber(0),
      (api: Record<string, any>) => api.boxNumber(1),
      (api: Record<string, any>) => api.boxNumber(NaN),
      () => null,
      () => undefined,
      () => true,
      () => hostile,
    ]) {
      const { api, self } = fresh();
      expect(() => api.nativeMethod(null, self, make(api))).toThrow(WebAssembly.RuntimeError);
    }
    expect(reads).toBe(0);
  }, 120000);
});

describe("native Boolean argument recipe, not numeric conversion", () => {
  const unboxNumber = 17 as FuncHandle;
  it("extracts the actual typed Boolean payload without number unboxing", () => {
    expect(
      buildClosureMethodArgument(2, 0, { kind: "i32", boolean: true }, 7, { unboxNumber, booleanTypeIdx: 41 }),
    ).toEqual([
      { op: "local.get", index: 2 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: 41 },
      { op: "struct.get", typeIdx: 41, fieldIdx: 0 },
    ]);
  });
  it("preserves the old Boolean fallback when no native Boolean binding is supplied", () => {
    expect(buildClosureMethodArgument(2, 0, { kind: "i32", boolean: true }, 7, { unboxNumber })).toEqual([
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: unboxNumber },
      { op: "i32.trunc_sat_f64_s" },
    ]);
  });
  it("does not relabel an unbranded i32 as a Boolean", () => {
    expect(buildClosureMethodArgument(2, 0, { kind: "i32" }, 7, { unboxNumber, booleanTypeIdx: 41 })).toEqual([
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: unboxNumber },
      { op: "i32.trunc_sat_f64_s" },
    ]);
  });
});
