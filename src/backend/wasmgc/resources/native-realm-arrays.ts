// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 A1) The arrays of a realm that holds the Array family: ArrayCreate (`js.object.create-array`) and the one
 * ArrayDefineOwnProperty every realm define of an array goes through (`realm-array-bodies.ts`). Both are reserved
 * before the descriptor pack, whose boundary defines call the latter, and filled once the kernel they read exists. A
 * realm that holds no Array family reserves neither, and its pack's defines are what they were.
 */
import type { FunctionReservation, PhysicalModuleReservations } from "../../../wasm/physical/module-reservations.js";
import type { Instr } from "../../../wasm/model/instructions.js";
import { NATIVE_ERROR_CONSTRUCTORS } from "../../../runtime/contracts/native-realm-catalog.js";
import { builtinTypeError } from "../../../runtime/wasmgc/values/builtin-function-bodies.js";
import {
  buildArrayCreateDefinition,
  buildArrayDefineDefinition,
  type RealmArrayOperands,
} from "../../../runtime/wasmgc/values/realm-array-bodies.js";
import { nativeBuiltinFunctionOperands, type NativeBuiltinFunctionReservations } from "./native-builtin-functions.js";
import type { NativeValueReservations } from "./native-values.js";

export interface NativeRealmArrays {
  readonly create: FunctionReservation;
  readonly define: FunctionReservation;
}

const EXTERNREF = { kind: "externref" } as const;

export function reserveNativeRealmArrays(tx: PhysicalModuleReservations, key: string): NativeRealmArrays {
  return Object.freeze({
    create: tx.reserveFunction(key + ":arrays:create", key + ":array-create", {
      params: [{ kind: "f64" }],
      results: [EXTERNREF],
    }),
    define: tx.reserveFunction(key + ":arrays:define", key + ":array-define", {
      params: [EXTERNREF, EXTERNREF, EXTERNREF, EXTERNREF, EXTERNREF, { kind: "f64" }, { kind: "i32" }],
      results: [{ kind: "i32" }],
    }),
  });
}

export const nativeRealmArrayInventory = (arrays: NativeRealmArrays): readonly FunctionReservation[] => [
  arrays.create,
  arrays.define,
];

/** The realm's RangeError selector (`js.object.create-error`). */
const RANGE_ERROR = NATIVE_ERROR_CONSTRUCTORS.indexOf("RangeError");

export function fillNativeRealmArrays(
  tx: PhysicalModuleReservations,
  arrays: NativeRealmArrays,
  dependencies: {
    readonly kernel: NativeBuiltinFunctionReservations;
    readonly values: NativeValueReservations;
    /** The descriptor pack's accessor ValidateAndApplyPropertyDescriptor. */
    readonly defineAccessorBody: FunctionReservation;
  },
): void {
  const { kernel, values } = dependencies;
  const d = nativeBuiltinFunctionOperands(tx, kernel);
  const prototype = d.objects.find(({ id }) => id === "%Array.prototype%");
  if (!prototype) throw new Error("native realm arrays: the realm holds no %Array.prototype%");
  const errorCreate = kernel.errorCreate;
  const operands: RealmArrayOperands = {
    objectTypeIdx: d.objectTypeIdx,
    entryTypeIdx: d.entryTypeIdx,
    mapTypeIdx: d.mapTypeIdx,
    boxedBooleanTypeIdx: values.types.boxedBoolean.typeIndex,
    prototype: prototype.global,
    initializer: d.initializer,
    createWithPrototype: d.createWithPrototype,
    findOwn: d.findOrdinary,
    deleteOwn: kernel.functions.deleteOwn.handle,
    arrayIndex: kernel.functions.arrayIndex.handle,
    defineDataBody: d.defineDataBody,
    defineAccessorBody: dependencies.defineAccessorBody.handle,
    boxNumber: d.boxNumber,
    unboxNumber: values.functions.unboxNumber.handle,
    isNumber: values.functions.isNumber.handle,
    anyValueTypeIdx: values.types.anyValue.typeIndex,
    lengthKey: d.lengthKey,
    throwTypeError: (message) => builtinTypeError(d, d.text(message)),
    // Where the realm holds the Error family it holds RangeError with Array (`native-realm-requirements.ts`); elsewhere
    // no code reads a thrown value.
    throwRangeError: (message): Instr[] =>
      errorCreate
        ? [
            ...d.text(message),
            { op: "i32.const", value: RANGE_ERROR },
            { op: "call", funcIdx: errorCreate.handle },
            { op: "throw", tagIdx: d.exceptionTag },
          ]
        : builtinTypeError(d, d.text(message)),
  };
  tx.fillFunction(arrays.create, buildArrayCreateDefinition(operands));
  tx.fillFunction(arrays.define, buildArrayDefineDefinition(operands));
}
