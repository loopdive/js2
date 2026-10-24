// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { builtinFunctionRuntime, type builtinFunctionFixture } from "./helpers/native-builtin-functions.js";
import { buildNativeClosureVectorApplyDefinition } from "../src/runtime/wasmgc/values/closure-vector-apply-body.js";
import { buildMixedObjectGet } from "../src/runtime/wasmgc/values/mixed-object-access-bodies.js";
import { buildClosureUndefinedTest } from "../src/runtime/wasmgc/values/closure-receiver-bodies.js";
import { requireNativeStringLiteral } from "../src/backend/wasmgc/resources/native-string-literals.js";
import type { NativeClosureMethodEntry } from "../src/runtime/wasmgc/values/closure-method-body.js";

const ext = { kind: "externref" } as const;
function mixedExecution(f: ReturnType<typeof builtinFunctionFixture>) {
  const { tx, kernel, argumentsPack: argv } = f;
  if (!kernel) throw Error("missing actual builtin producer");
  const apply = tx.reserveFunction("mixed-execution:apply", "mixedApply", { params: [ext, ext, ext], results: [ext] });
  const collision = tx.reserveFunction("mixed-execution:collision", "collision", {
    params: [ext, ext, ext],
    results: [ext],
  });
  const collisionControl = tx.reserveFunction("mixed-execution:collision-control", "collisionControl", {
    params: [ext, ext, ext],
    results: [ext],
  });
  const get = tx.reserveFunction("mixed-execution:get", "mixedGet", {
    params: [ext, ext, ext],
    results: [{ kind: "i32" }, ext],
  });
  const isUndefined = tx.reserveFunction("mixed-execution:is-undefined", "isUndefined", {
    params: [ext],
    results: [{ kind: "i32" }],
  });
  const currentThis = tx.reserveGlobal("mixed-execution:this", "currentThis", ext, true);
  const argc = tx.reserveGlobal("mixed-execution:argc", "argc", { kind: "i32" }, true);
  const extras = tx.reserveGlobal(
    "mixed-execution:extras",
    "extras",
    {
      kind: "ref_null",
      typeIdx: argv.carrier.typeIndex,
    },
    true,
  );
  return () => {
    tx.fillGlobal(currentThis, [{ op: "ref.null.extern" }]);
    tx.fillGlobal(argc, [{ op: "i32.const", value: 0 }]);
    tx.fillGlobal(extras, [{ op: "ref.null", typeIdx: argv.carrier.typeIndex }]);
    tx.fillFunction(isUndefined, { locals: [], body: buildClosureUndefinedTest(0, f.values.types.anyValue.typeIndex) });
    const entries: NativeClosureMethodEntry[] = f.sourceRequirements.units.map((unit) => {
      const shape = f.source.types.shapes.find((row) => row.id === unit.shapeId)!;
      const description = f.sourceRequirements.shapes.find((row) => row.id === unit.shapeId)!;
      const signature = f.closures.signatures.find((row) => row.id === description.signatureId)!.binding;
      const slot = f.sourceSlots.get(unit.unitId)!;
      tx.assertCompletedReservation(slot);
      return {
        allocationTypeIdx: shape.type.typeIndex,
        selfTypeIdx: signature.liftedSelfTypeIndex,
        funcTypeIdx: slot.object.typeIdx,
        closureArity: signature.info.paramTypes.length,
        params: signature.info.paramTypes,
        arguments: { unboxNumber: f.values.functions.unboxNumber.handle, isUndefined: isUndefined.handle },
        result: signature.info.returnType
          ? { kind: "value", returnType: signature.info.returnType, boxNumber: f.values.functions.boxNumber.handle }
          : {
              kind: "void",
              undefinedValue: [
                { op: "global.get", index: tx.physicalIndex(f.values.globals.undefined) },
                { op: "extern.convert_any" },
              ],
            },
      };
    });
    const types: { kind: string; superTypeIdx?: number }[] = [];
    for (const token of [
      f.closures.root,
      ...f.closures.signatures.map((row) => row.binding.type),
      ...f.source.types.shapes.map((row) => row.type),
    ]) {
      const type = token.object;
      types[token.typeIndex] = {
        kind: type.kind,
        ...(type.kind === "struct" ? { superTypeIdx: type.superTypeIdx } : {}),
      };
    }
    const message = requireNativeStringLiteral(tx, f.strings, "TypeError");
    if (message.kind !== "global") throw Error("expected real literal global");
    const definition = (selected: NativeClosureMethodEntry[], carriers: readonly number[]) =>
      buildNativeClosureVectorApplyDefinition(
        { rootTypeIdx: f.closures.root.typeIndex, types },
        selected,
        {
          currentThis: tx.physicalIndex(currentThis),
          argc: tx.physicalIndex(argc),
          extrasArgv: tx.physicalIndex(extras),
          extrasVecTypeIdx: argv.carrier.typeIndex,
          extrasArrTypeIdx: argv.array.typeIndex,
          undefinedGlobal: tx.physicalIndex(f.values.globals.undefined),
          anyValueTypeIdx: f.values.types.anyValue.typeIndex,
          receiverPolicy: "exact",
        },
        {
          newTypeError: f.errors.newTypeError.handle,
          exceptionTag: tx.physicalIndex(kernel.exception),
          message: { kind: "global", index: tx.physicalIndex(message.global) },
        },
        {
          vectorTypeIdx: argv.carrier.typeIndex,
          arrayTypeIdx: argv.array.typeIndex,
          external: true,
          receiverVector: { match: kernel.functions.match.handle, call: kernel.functions.callVector.handle, carriers },
        },
      );
    const carriers = kernel.entries.map((row) => row.type.typeIndex);
    tx.fillFunction(apply, definition(entries, carriers));
    // Adversarial recipe control: a permissive positional view with the real builtin
    // signature. It is not issued as a Source callable or completion certificate.
    const overlap: NativeClosureMethodEntry = {
      allocationTypeIdx: f.closures.root.typeIndex,
      selfTypeIdx: f.closures.root.typeIndex,
      funcTypeIdx: kernel.entries[0]!.lifted.object.typeIdx,
      closureArity: 2,
      params: [ext, { kind: "ref", typeIdx: argv.carrier.typeIndex }],
      arguments: { isUndefined: isUndefined.handle },
      result: { kind: "value", returnType: ext },
    };
    tx.fillFunction(collision, definition([overlap], carriers));
    tx.fillFunction(collisionControl, definition([overlap], []));
    tx.fillFunction(
      get,
      buildMixedObjectGet({
        argumentVector: { kind: "externref" },
        entryTypeIdx: f.layouts.propEntry.typeIndex,
        undefinedGlobal: tx.physicalIndex(f.values.globals.undefined),
        lookup: kernel.functions.lookup.handle,
        newVector: argv.newVector.handle,
        call: apply.handle,
      }),
    );
    for (const [name, token] of Object.entries({
      mixedApply: apply,
      mixedGet: get,
      collision,
      collisionControl,
      currentThis,
      argc,
      extras,
      unbox: f.values.functions.unboxNumber,
    }))
      tx.defineExport("mixed-execution:export:" + name, name, token);
  };
}
function runtime(displaced: boolean) {
  const result = builtinFunctionRuntime(displaced, false, false, mixedExecution);
  return {
    ...result,
    runtime: result.runtime as typeof result.runtime & {
      mixedApply(fn: unknown, receiver: unknown, vector: unknown): unknown;
      mixedGet(object: unknown, key: unknown, receiver: unknown): [number, unknown];
      collision(fn: unknown, receiver: unknown, vector: unknown): unknown;
      collisionControl(fn: unknown, receiver: unknown, vector: unknown): unknown;
      currentThis: WebAssembly.Global;
      argc: WebAssembly.Global;
      extras: WebAssembly.Global;
      unbox(value: unknown): number;
    },
  };
}
function abrupt(run: () => unknown, tag: WebAssembly.Tag) {
  let result: unknown;
  try {
    run();
  } catch (error) {
    result = error;
  }
  expect(result).toBeInstanceOf(WebAssembly.Exception);
  expect((result as WebAssembly.Exception).is(tag)).toBe(true);
}
describe.each([false, true])("shared source/builtin ArgumentVector execution, displaced=%s", (displaced) => {
  it("executes canonical source and builtin bodies through one dispatcher and Getter algorithm", () => {
    const { runtime: r, compiled, keyTexts } = runtime(displaced);
    expect(WebAssembly.Module.imports(compiled)).toEqual([]);
    const fn = r.sourceValue(),
      native = r.functionPrototype(),
      empty = r.newVector(),
      receiver = { outer: true };
    r.currentThis.value = receiver;
    r.argc.value = 19;
    r.extras.value = empty;
    expect(() => r.mixedApply(fn, null, empty), "apply source").not.toThrow();
    expect(r.unbox(r.mixedApply(fn, null, empty))).toBe(r.sourceCall(fn));
    expect(() => r.mixedApply(native, receiver, empty), "apply builtin").not.toThrow();
    expect(r.mixedApply(native, receiver, empty)).toBe(r.undefinedValue());
    const key = r.key(keyTexts.indexOf("value"));
    expect(() => r.defineAccessor(native, key, fn, r.undefinedValue(), 822), "define source accessor").not.toThrow();
    expect(() => r.mixedGet(native, key, receiver), "mixed getter").not.toThrow();
    const [status, value] = r.mixedGet(native, key, receiver);
    expect(status).toBe(1);
    expect(r.unbox(value)).toBe(r.sourceCall(fn));
    r.defineAccessor(native, key, r.throwTypeError(), r.undefinedValue(), 822);
    abrupt(() => r.mixedGet(native, key, receiver), r.exception);
    expect(r.currentThis.value).toBe(receiver);
    expect(r.argc.value).toBe(19);
    expect(r.extras.value).toBe(empty);
  });
  it("rejects forged/foreign builtin identities and invalid vectors without entering source state", () => {
    const { runtime: r } = runtime(displaced),
      other = runtime(displaced).runtime;
    const native = r.functionPrototype(),
      empty = r.newVector(),
      receiver = { saved: true };
    r.currentThis.value = receiver;
    r.argc.value = 23;
    r.extras.value = empty;
    for (const fn of [r.clone(native), r.forge(native, 1), r.bareMetadata(), other.functionPrototype(), null, {}])
      abrupt(() => r.mixedApply(fn, null, empty), r.exception);
    for (const vector of [null, undefined, {}, native]) abrupt(() => r.mixedApply(native, null, vector), r.exception);
    const collisionArguments = r.newVector();
    r.push(collisionArguments, receiver);
    r.push(collisionArguments, empty);
    // Without family exclusion the same physical signature reaches the foreign
    // builtin, which authenticates against its own realm and returns its undefined.
    expect(r.collisionControl(other.functionPrototype(), null, collisionArguments)).toBe(other.undefinedValue());
    abrupt(() => r.collision(other.functionPrototype(), null, collisionArguments), r.exception);
    expect(r.currentThis.value).toBe(receiver);
    expect(r.argc.value).toBe(23);
    expect(r.extras.value).toBe(empty);
  });
});
