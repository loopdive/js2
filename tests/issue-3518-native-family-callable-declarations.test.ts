// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import * as bindings from "../src/ir/core/async-callables.js";
import { irIntrinsicFuncRef, irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import { asValueId, type IrInstrCall } from "../src/ir/core/nodes.js";
import type { IrType } from "../src/ir/core/types.js";
import { irRuntimeCallableDeclaration as legacyLookup } from "../src/ir/runtime-callable-declarations.js";
import {
  irRuntimeCallableDeclaration,
  REFERENCE_ERROR_RUNTIME_PROVIDERS,
  REFERENCE_ERROR_SIGNATURE,
} from "../src/ir/runtime/callable-declarations.js";
import {
  NATIVE_ASYNC_CALLABLE_DECLARATIONS,
  irNativeAsyncCallableDeclaration,
  irRuntimeCallableHasNoSlot,
  nativeAsyncCallMismatch,
} from "../src/ir/runtime/native-async-callables.js";
import { REFERENCE_ERROR_RUNTIME_PROVIDERS as manifestReferenceError } from "../src/ir/runtime/manifest.js";

const F64: IrType = { kind: "val", val: { kind: "f64" } };
const EXTERN: IrType = { kind: "val", val: { kind: "externref" } };
const STRING: IrType = { kind: "string" };
const PROMISE: IrType = { kind: "extern", className: "Promise" };
const VECTOR: IrType = { kind: "vec", elementType: EXTERN, nullable: true };
const EXPECTED = [
  ["runtime", "__ir_promise_delay_native", [F64, F64], [PROMISE]],
  ["runtime", "__ir_async_promise_all_native", [VECTOR], [EXTERN]],
  ["intrinsic", "async.clock.snapshot", [], [F64]],
  ["intrinsic", "async.number.to-string", [F64], [STRING]],
  ["intrinsic", "async.console.log-string", [STRING], []],
  ["intrinsic", "async.string.concat$arity5", [STRING, STRING, STRING, STRING, STRING], [STRING]],
] as const;

describe("six closed native-family logical contracts", () => {
  it("pins all six canonical bindings and their complete result vectors", () => {
    expect(Object.values(bindings).sort()).toEqual(EXPECTED.map((row) => row[1]).sort());
    expect(NATIVE_ASYNC_CALLABLE_DECLARATIONS).toHaveLength(6);
    expect(
      NATIVE_ASYNC_CALLABLE_DECLARATIONS.map((entry) => [
        entry.ref.binding.kind,
        entry.ref.name,
        entry.params,
        entry.results,
      ]),
    ).toEqual(EXPECTED);
    expect(new Set(NATIVE_ASYNC_CALLABLE_DECLARATIONS).size).toBe(6);
  });

  it.each(EXPECTED)("selects %s %s structurally, independent of its display label", (kind, symbol) => {
    const makeRef = kind === "runtime" ? irRuntimeFuncRef : irIntrinsicFuncRef;
    const ref = makeRef(symbol, "not the semantic name");
    const canonical = irNativeAsyncCallableDeclaration(ref)!;
    expect(canonical).toBeDefined();
    expect(irRuntimeCallableDeclaration(ref)).toBe(canonical);
    expect(legacyLookup(ref)).toBe(canonical);
    const wrongKind = kind === "runtime" ? irIntrinsicFuncRef : irRuntimeFuncRef;
    expect(irRuntimeCallableDeclaration(wrongKind(symbol))).toBeUndefined();
    expect(irRuntimeCallableDeclaration(makeRef(`${symbol}.foreign`, symbol))).toBeUndefined();
    for (const object of [
      canonical,
      canonical.ref,
      canonical.ref.binding,
      canonical.params,
      canonical.results,
      ...canonical.params,
      ...canonical.results,
    ])
      expect(Object.isFrozen(object)).toBe(true);
    expect(Reflect.set(canonical, "feature", "foreign")).toBe(false);
  });

  it.each(EXPECTED)("validates the actual %s %s call against declared SSA types", (kind, symbol) => {
    const ref = kind === "runtime" ? irRuntimeFuncRef(symbol) : irIntrinsicFuncRef(symbol);
    const declaration = irRuntimeCallableDeclaration(ref)!;
    const args = declaration.params.map((_, index) => asValueId(index));
    const types = new Map(args.map((id, index) => [id, declaration.params[index]!]));
    const call: IrInstrCall = {
      kind: "call",
      target: ref,
      args,
      result: declaration.results.length ? asValueId(99) : null,
      resultType: declaration.results[0] ?? null,
    };
    expect(nativeAsyncCallMismatch(call, declaration, types)).toBeUndefined();
    expect(nativeAsyncCallMismatch({ ...call, args: [...args, asValueId(98)] }, declaration, types)).toContain(
      "argument count",
    );
    expect(
      nativeAsyncCallMismatch(
        { ...call, result: asValueId(99), resultType: { kind: "val", val: { kind: "i32" } } },
        declaration,
        types,
      ),
    ).toBeDefined();
    if (args.length) {
      expect(nativeAsyncCallMismatch(call, declaration, new Map())).toContain("argument 0");
      const wrong = new Map(types);
      wrong.set(args[0]!, { kind: "dynamic" });
      expect(nativeAsyncCallMismatch(call, declaration, wrong)).toContain("argument 0");
    }
  });

  it.each([
    [0, EXTERN],
    [1, PROMISE],
    [3, EXTERN],
    [4, { kind: "val", val: { kind: "i32" } }],
  ] as const)("does not erase logical result distinctions for declaration %s", (index, resultType) => {
    const contract = NATIVE_ASYNC_CALLABLE_DECLARATIONS[index]!;
    const args = contract.params.map((_, i) => asValueId(i));
    expect(
      nativeAsyncCallMismatch(
        { kind: "call", target: contract.ref, args, result: asValueId(99), resultType },
        contract,
        new Map(args.map((id, i) => [id, contract.params[i]!])),
      ),
    ).toBeDefined();
  });

  it("accepts a non-null externref vector for the nullable Promise.all parameter, not other carriers", () => {
    const contract = NATIVE_ASYNC_CALLABLE_DECLARATIONS[1]!;
    const call: IrInstrCall = {
      kind: "call",
      target: contract.ref,
      args: [asValueId(0)],
      result: asValueId(1),
      resultType: EXTERN,
    };
    expect(
      nativeAsyncCallMismatch(
        call,
        contract,
        new Map([[asValueId(0), { kind: "vec", elementType: EXTERN, nullable: false } as IrType]]),
      ),
    ).toBeUndefined();
    for (const type of [
      { kind: "vec", elementType: F64, nullable: false },
      { kind: "vec", elementType: F64, nullable: true },
      { kind: "vec", elementType: PROMISE, nullable: false },
      EXTERN,
    ] satisfies IrType[])
      expect(nativeAsyncCallMismatch(call, contract, new Map([[asValueId(0), type]]))).toContain("argument 0");
    const nonNullContract = { ...contract, params: [{ kind: "vec", elementType: EXTERN, nullable: false } as IrType] };
    expect(nativeAsyncCallMismatch(call, nonNullContract, new Map([[asValueId(0), VECTOR]]))).toContain("argument 0");
  });

  it("grants no slot to the exact clock binding only", () => {
    expect(NATIVE_ASYNC_CALLABLE_DECLARATIONS.map((entry) => irRuntimeCallableHasNoSlot(entry.ref))).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(irRuntimeCallableHasNoSlot(irRuntimeFuncRef(bindings.IR_ASYNC_CLOCK_SNAPSHOT_FN))).toBe(false);
  });

  it("keeps ReferenceError object identity and its canonical host-record signature", () => {
    const canonical = irRuntimeCallableDeclaration(irRuntimeFuncRef("__new_ReferenceError"))!;
    expect(legacyLookup(irRuntimeFuncRef("__new_ReferenceError", "renamed"))).toBe(canonical);
    expect(canonical.params).toEqual([EXTERN]);
    expect(canonical.results).toEqual([EXTERN]);
    expect(REFERENCE_ERROR_SIGNATURE.params).toBe(canonical.params);
    expect(REFERENCE_ERROR_SIGNATURE.result).toBe(canonical.results[0]);
    expect(manifestReferenceError).toBe(REFERENCE_ERROR_RUNTIME_PROVIDERS);
    expect(
      REFERENCE_ERROR_RUNTIME_PROVIDERS.every((provider) => provider.signature === REFERENCE_ERROR_SIGNATURE),
    ).toBe(true);
  });
});
