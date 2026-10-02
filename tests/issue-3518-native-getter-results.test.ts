// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  getterRequirements,
  getterInvocationFixture,
  prepareGetterProgram,
} from "./helpers/native-getter-invocation-fixture.js";
import { getterResultRuntime } from "./helpers/native-getter-result-fixture.js";
import { assertNativeObjectResultRequirementsCurrent } from "../src/ir/program/native-object-result-requirements.js";
import { reserveNativeInvocationResources } from "../src/backend/wasmgc/resources/native-invocation.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";
import type { IrInstr, IrType } from "../src/ir/core/nodes.js";

const CALLABLE = `export function run() {
  const captured = 7;
  const object = { get value() { return function () { return captured; }; } };
  return object.value;
}`;
const BOOLEAN = (value: boolean) => `export function run() {
  const object = { get value() { return ${value}; } }; return object.value;
}`;
const CALLABLE_TYPE: IrType = {
  kind: "callable",
  signature: { params: [], returnType: { kind: "val", val: { kind: "f64" } } },
};
function oracle(source: string): () => unknown {
  const exports: { run?: () => unknown } = {};
  runInNewContext(
    ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
      .outputText,
    { exports },
    { timeout: 1000 },
  );
  if (!exports.run) throw new Error("actual source oracle has no run");
  return exports.run;
}
function mutable(program: PreparedIrProgram): PreparedIrProgram {
  return {
    ...program,
    ir: { ...program.ir, functions: structuredClone(program.ir.functions) },
    allocations: structuredClone(program.allocations),
    runtime: [
      {
        ...program.runtime[0]!,
        prepared: {
          ...program.runtime[0]!.prepared,
          functions: structuredClone(program.runtime[0]!.prepared.functions),
        },
      },
    ],
  };
}
function eachFunction(program: PreparedIrProgram, run: (instructions: readonly IrInstr[]) => void) {
  for (const functions of [program.ir.functions, program.runtime[0]!.prepared.functions])
    for (const fn of functions) for (const block of fn.blocks) run(block.instrs);
}
function assertReturnedGetProjection(program: PreparedIrProgram): void {
  for (const functions of [program.ir.functions, program.runtime[0]!.prepared.functions]) {
    const run = functions.find((fn) => fn.name === "run");
    expect(run).toBeDefined();
    expect(run!.resultTypes).toEqual([CALLABLE_TYPE]);
    const returns = run!.blocks.filter((block) => block.terminator.kind === "return");
    expect(returns).toHaveLength(1);
    const returned = returns[0]!.terminator;
    if (returned.kind !== "return") throw new Error("actual source run lost its return");
    expect(returned.values).toHaveLength(1);
    const instructions = run!.blocks.flatMap((block) => block.instrs);
    const projection = instructions.find((row) => row.result === returned.values[0]);
    expect(projection?.kind).toBe("coerce.to_externref");
    expect(projection?.resultType).toEqual(CALLABLE_TYPE);
    if (projection?.kind !== "coerce.to_externref") throw new Error("actual callable result projection vanished");
    const get = instructions.find((row) => row.result === projection.value);
    expect(get?.kind === "call" && get.target.binding.kind === "intrinsic" && get.target.binding.symbol).toBe(
      "js.object.get",
    );
  }
}
beforeAll(() => vi.stubEnv("JS2WASM_IR_GVN", "0"));
afterAll(() => vi.unstubAllEnvs());

describe("keyed native ordinary Get result proof", () => {
  it.each([false, true])(
    "preserves the returned capturing callable through actual C2 dispatch, decoded=%s",
    (decoded) => {
      const program = prepareGetterProgram(CALLABLE, decoded);
      assertReturnedGetProjection(program);
      const f = getterInvocationFixture(program);
      expect(f.invocation.gaps).toEqual([]);
      expect(f.invocation.objectResults!.uses).toHaveLength(1);
      expect(f.invocation.objectResults!.uses[0]!.returnedAllocations).toHaveLength(1);
      expect(f.invocation.getterUses).toHaveLength(1);
      const runtime = getterResultRuntime(f),
        getter = runtime.make(7);
      const first = runtime.get(getter),
        second = runtime.get(getter);
      const expected = oracle(CALLABLE)() as () => number;
      expect(first === second).toBe(false); // each real getter evaluation allocates a fresh returned closure
      expect(runtime.invoke(first)).toBe(expected());
      expect(runtime.invoke(first)).toBe(7);
      expect(runtime.invoke(second)).toBe(7);
    },
  );
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ] as const)("boxes the actual Boolean getter result value=%s decoded=%s", (value, decoded) => {
    const source = BOOLEAN(value),
      f = getterInvocationFixture(prepareGetterProgram(source, decoded, "./entry.ts", true));
    expect(f.invocation.gaps).toEqual([]);
    expect(f.invocation.objectResults!.uses[0]!.resultType).toEqual({
      kind: "val",
      val: { kind: "i32", boolean: true },
    });
    const runtime = getterResultRuntime(f),
      result = runtime.get(runtime.make());
    expect(runtime.isBoolean(result)).toBe(1);
    expect(Boolean(runtime.booleanValue(result))).toBe(oracle(source)());
    expect(runtime.get(runtime.make()) === result).toBe(true); // the real interned Boolean singleton
  });
  it("keeps the explicit disabled boxer refusal while proving the Boolean property result", () => {
    const f = getterRequirements(prepareGetterProgram(BOOLEAN(true)));
    expect(f.invocation!.objectResults!.gaps).toEqual([]);
    expect(f.invocation!.gaps.some((row) => row.detail.includes("argument/result conversion"))).toBe(true);
  });
  it("selects the actual named descriptor rather than another reachable getter", () => {
    const f = getterRequirements(
      prepareGetterProgram(
        `export function run(){
      const object={get other(){return 8;},get value(){return true;}};return object.value;
    }`,
        false,
        "./entry.ts",
        true,
      ),
    );
    expect(f.access.getters).toHaveLength(2);
    expect(f.invocation!.objectResults!.uses).toHaveLength(1);
    const result = f.invocation!.objectResults!.uses[0]!;
    expect(f.access.getters[result.getterIndex!]!.signature.returnType).toEqual({
      kind: "val",
      val: { kind: "i32", boolean: true },
    });
  });
  it("rejects a copied issued result proof after its real positive", () => {
    const pack = getterRequirements(prepareGetterProgram(CALLABLE)).invocation!.objectResults!;
    expect(() => assertNativeObjectResultRequirementsCurrent(pack)).not.toThrow();
    expect(() => assertNativeObjectResultRequirementsCurrent({ ...pack })).toThrow(/unissued/);
  });
  it.each(["projection key", "projection removed", "raw callable", "wrong getter", "wrong return"] as const)(
    "refuses forged %s provenance before reserving",
    (mutation) => {
      const program = mutable(
        prepareGetterProgram(mutation === "raw callable" ? CALLABLE : BOOLEAN(true), false, "./entry.ts", true),
      );
      const good = getterRequirements(program);
      expect(good.invocation!.gaps).toEqual([]);
      expect(good.invocation!.objectResults!.uses).toHaveLength(1);
      let changed = 0;
      if (mutation === "projection key") {
        const projection = program.runtime[0]!.prepared.functions;
        const literal = projection
          .flatMap((fn) => fn.blocks.flatMap((b) => b.instrs))
          .find((row) => row.kind === "string.const" && row.value === "value")!;
        Object.assign(literal, { value: "missing" });
        changed++;
      } else if (mutation === "projection removed") {
        for (const fn of program.runtime[0]!.prepared.functions)
          for (const block of fn.blocks) {
            const index = block.instrs.findIndex((row) => row.kind === "intrinsic" && row.id === "js.boolean.unbox");
            if (index >= 0) {
              (block.instrs as IrInstr[]).splice(index, 1);
              changed++;
            }
          }
      } else if (mutation === "raw callable") {
        eachFunction(program, (instructions) => {
          const projection = instructions.find(
            (row) =>
              row.kind === "coerce.to_externref" &&
              row.resultType?.kind === "callable" &&
              instructions.some(
                (input) => input.result === row.value && input.kind === "call" && input.target.name === "js.object.get",
              ),
          );
          const key = instructions.find(
            (row) =>
              row.kind === "coerce.to_externref" &&
              row.resultType?.kind === "val" &&
              row.resultType.val.kind === "externref",
          );
          if (projection && key) {
            Object.assign(projection, { value: key.result });
            changed++;
          }
        });
      } else if (mutation === "wrong getter") {
        eachFunction(program, (instructions) => {
          const descriptor = instructions.find(
            (row) => row.kind === "call" && row.target.name === "js.object.define-accessor",
          );
          if (descriptor?.kind === "call") {
            Object.assign(descriptor, {
              args: descriptor.args.map((value, index) => (index === 2 ? descriptor.args[3]! : value)),
            });
            changed++;
          }
        });
      } else {
        eachFunction(program, (instructions) => {
          const value = instructions.find(
            (row) =>
              row.kind === "const" &&
              row.value.kind === "bool" &&
              row.resultType?.kind === "val" &&
              row.resultType.val.kind === "i32" &&
              row.resultType.val.boolean,
          );
          if (value) {
            Object.assign(value, {
              value: { kind: "f64", value: 7 },
              resultType: { kind: "val", val: { kind: "f64" } },
            });
            changed++;
          }
        });
      }
      expect(changed).toBeGreaterThan(0);
      expect(() => assertNativeObjectResultRequirementsCurrent(good.invocation!.objectResults!)).toThrow();
      // A fresh issuer over the mutated packet must also fail closed, not only the old token.
      let fresh: ReturnType<typeof getterRequirements> | undefined, failure: unknown;
      try {
        fresh = getterRequirements(program);
      } catch (error) {
        failure = error;
      }
      if (failure !== undefined)
        expect(String(failure)).toMatch(/ordinary|getter|closure|descriptor|projection|allocation|source/i);
      else expect(fresh!.invocation!.gaps.length).toBeGreaterThan(0);
    },
  );
  it.each(["missing", "copied", "foreign"] as const)(
    "rejects the %s Boolean boxer without allocating an invocation prefix",
    (kind) => {
      const f = getterInvocationFixture(prepareGetterProgram(BOOLEAN(true), false, "./entry.ts", true));
      const other =
        kind === "foreign"
          ? getterInvocationFixture(prepareGetterProgram(BOOLEAN(true), false, "./entry.ts", true))
          : undefined;
      const dependencies = {
        ...f.dependencies,
        booleanBoxes:
          kind === "missing"
            ? undefined
            : kind === "copied"
              ? { ...f.dependencies.booleanBoxes! }
              : other!.dependencies.booleanBoxes,
      };
      const before = structuredClone(f.module);
      expect(() => reserveNativeInvocationResources(f.tx, f.invocation, dependencies)).toThrow(
        /Boolean|boxing|foreign/,
      );
      expect(f.module).toStrictEqual(before);
    },
  );
  it("does not let the explicit builder project an arbitrary externref", () => {
    const builder = new IrFunctionBuilder(createTestIrFunctionIdentityFactory("bad-get-result").next("bad"), [
      CALLABLE_TYPE,
    ]);
    const raw = builder.addParam("raw", { kind: "val", val: { kind: "externref" } });
    builder.openBlock();
    expect(() =>
      builder.emitOrdinaryGetCallableResult(raw, (CALLABLE_TYPE as Extract<IrType, { kind: "callable" }>).signature),
    ).toThrow(/actual ordinary Get/);
  });
  it("rejects a codec-shaped raw externref callable projection structurally", () => {
    const builder = new IrFunctionBuilder(createTestIrFunctionIdentityFactory("forged-get-result").next("bad"), [
      CALLABLE_TYPE,
    ]);
    const raw = builder.addParam("raw", { kind: "val", val: { kind: "externref" } });
    builder.openBlock();
    const result = builder.emitCoerceToExternref(raw);
    builder.terminate({ kind: "return", values: [result] });
    const fn = builder.finish();
    Object.assign(fn.blocks[0]!.instrs[0]!, { resultType: CALLABLE_TYPE });
    expect(verifyIrFunction(fn).some((row) => row.message.includes("callable projection"))).toBe(true);
  });
  it.each([
    {
      kind: "ambiguous",
      source: `export function run(flag: boolean) {
        return flag ? function(): number { return 7; } : function(): boolean { return true; };
      }`,
      diagnostic: /inferred callable result.*ambiguous contract/,
    },
    {
      kind: "recursive",
      source: `type Recursive = () => Recursive;
        export function run() { const value: Recursive = function(): Recursive { return value; }; return value; }`,
      diagnostic: /recursive anonymous contract/,
    },
  ])("refuses an inferred $kind callable result instead of dropping the return", ({ source, diagnostic }) => {
    expect(() => prepareGetterProgram(source)).toThrow(diagnostic);
  });
});
