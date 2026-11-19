// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7354 D1) Dynamic-value legalization for the Prepared standalone WasmGC
 * source program.
 *
 * The Prepared backend binds runtime functions only through semantic
 * intrinsics, so the dynamic IR operations from-ast emits (`box` to dynamic,
 * `unbox`, `tag.test`, `dyn.*`) are rewritten into the intrinsics that name
 * the same meaning, and every `dynamic` type becomes its carrier, an
 * `externref`. The source producer runs it on each lowered function, so every
 * later stage (runtime projection, validator replay, physical plan) sees one
 * ordinary externref program. The pass is total: an operation it cannot
 * express throws {@link DynamicValueGap} with a name instead of reaching the
 * backend.
 *
 * Soundness rests on the admitted value set: only numbers, booleans,
 * `undefined` and `null` can enter a dynamic value here (every other box
 * refuses), and the runtime functions behind the intrinsics are exact for that
 * set. (#7354 T) `null` is the carrier's null reference, as on the ordinary
 * standalone pipeline; `undefined` is the non-null singleton, so the two stay
 * apart under strict equality and the `undefined` probe. (#7354 Fa) A function
 * value enters as its closure struct: strict equality compares it by identity,
 * ToBoolean answers true, ToNumber NaN (it has no own properties yet, so no
 * `valueOf` of its own), and the `undefined` probe false.
 */
import { irValueTypes } from "../analysis/value-types.js";
import { INTRINSIC_SIGNATURE_VERSION, INTRINSIC_DEFINITIONS, type IntrinsicId } from "../core/intrinsics.js";
import {
  forEachInstrDeep,
  type AllocSiteId,
  mapNestedBuffers,
  type IrFunction,
  type IrGlobalRef,
  type IrInstr,
  type IrValueId,
} from "../core/nodes.js";
import type { IrClosureSignature, IrType } from "../core/types.js";
import { IR_DYN_CALL_BOX_FN } from "../../shared/contracts/dynamic-call-helpers.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { irRuntimeCallableDeclaration } from "../runtime/callable-declarations.js";
import { JS_TAG_IDS } from "../runtime/js-tag-domain.js";
import type { TagId } from "../core/tag-domain.js";

const CARRIER: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });

/** A dynamic operation the Prepared path has no intrinsic for; the message names it. */
export class DynamicValueGap extends Error {}

function gap(operation: string): never {
  throw new DynamicValueGap(`dynamic operation ${operation} has no Prepared intrinsic`);
}

/** Walk the data structurally: IR constants may hold bigints, which JSON cannot. */
function containsDynamic(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if ((value as { kind?: unknown }).kind === "dynamic") return true;
  return Object.values(value).some(containsDynamic);
}

/**
 * The carrier form of a type: the dynamic value is the carrier, and (#7354 Fa) so is every dynamic parameter or
 * result of a function value's signature, which is what `js.closure.call:N` passes and returns.
 */
function carrierOf(type: IrType): IrType {
  if (type.kind === "dynamic") return CARRIER;
  if (type.kind !== "closure" && type.kind !== "callable") return type;
  return containsDynamic(type) ? { kind: type.kind, signature: carrierSignature(type.signature) } : type;
}

function carrierSignature(signature: IrClosureSignature): IrClosureSignature {
  return {
    ...signature,
    params: signature.params.map(carrierOf),
    returnType: signature.returnType && carrierOf(signature.returnType),
  };
}

/** (#7354 Fa) The types a closure allocation or a lifted closure body names, in carrier form. */
function carrierClosureInstr(instr: IrInstr): IrInstr {
  if (instr.kind !== "closure.new" || !containsDynamic(instr.signature)) return instr;
  return {
    ...instr,
    signature: carrierSignature(instr.signature),
    captureFieldTypes: instr.captureFieldTypes.map(carrierOf),
  };
}

/**
 * (#7354 Ty, Fa) `typeof`'s answer for each kind of value the carrier admits, keyed by the answer so that no two kinds
 * share one (`typeof null` is "object": an admitted object kind must merge with that row). The admitted kinds ARE this
 * table's values: a value enters the carrier only as one of them (`boxedKind`, the function-value projection and a
 * packed callable's coercion all go through `admit`, exhaustive by type), so a slice that admits a kind adds its
 * row here and `admit` does not compile until it has an arm for it.
 */
const TYPEOF_KIND = {
  number: "number",
  boolean: "boolean",
  string: "string",
  undefined: "undefined",
  object: "null",
  function: "function",
} as const;
type CarrierKind = (typeof TYPEOF_KIND)[keyof typeof TYPEOF_KIND];

/** The kind a box to the dynamic value admits, from its tag refinement or its operand; `undefined` refuses. */
function boxedKind(tag: TagId | undefined, source: IrType | undefined): CarrierKind | undefined {
  if (tag === JS_TAG_IDS.Boolean) return "boolean";
  if (tag === JS_TAG_IDS.Null) return "null";
  if (source?.kind === "string") return "string";
  return source?.kind === "val" && source.val.kind === "f64" ? "number" : undefined;
}

/** Rewrite one function. A function without a dynamic value is returned unchanged. */
export function legalizeDynamicValues(fn: IrFunction): IrFunction {
  if (!containsDynamic(fn)) return fn;
  const types = irValueTypes(fn);
  let valueCount = fn.valueCount;
  const intrinsic = (instr: IrInstr, id: IntrinsicId, args: readonly IrValueId[], result = instr.result): IrInstr => ({
    kind: "intrinsic",
    id,
    version: INTRINSIC_SIGNATURE_VERSION,
    args,
    result,
    resultType: INTRINSIC_DEFINITIONS[id].signature.result,
    ...(instr.site === undefined ? {} : { site: instr.site }),
  });
  const isDynamic = (value: IrValueId): boolean => types.get(value)?.kind === "dynamic";
  /** (#7354 Fa) A packed callable is a function value: every arm that takes one into the carrier says so. */
  const isFunctionValue = (value: IrValueId): boolean => types.get(value)?.kind === "callable";
  /** `instr`'s result is the externref that wraps `value`, which is its own carrier payload. */
  const carried = (instr: IrInstr, value: IrValueId): IrInstr => ({
    kind: "coerce.to_externref",
    value,
    result: instr.result,
    resultType: CARRIER,
    ...(instr.site === undefined ? {} : { site: instr.site }),
  });
  /** A value entering the carrier as `kind`; a value of no admitted kind refuses. */
  const admit = (kind: CarrierKind | undefined, instr: IrInstr, value: IrValueId): readonly IrInstr[] => {
    switch (kind) {
      case "boolean":
        return [intrinsic(instr, "js.boolean.box", [value])];
      // The Null partition has one value, the carrier's null reference.
      case "null":
        return [{ kind: "const", value: { kind: "null", ty: CARRIER }, result: instr.result, resultType: CARRIER }];
      case "number":
        return [intrinsic(instr, "js.number.box", [value])];
      // (#7354 Str) A native string, and (#7354 Fa) a function value's closure, are their own payload: the externref
      // that wraps it.
      case "string":
      case "function":
        return [carried(instr, value)];
      // `undefined` enters only as `dyn.undefined`, never by a box.
      case "undefined":
      case undefined:
        return gap(`box of a non-primitive value`);
    }
  };

  const expand = (instr: IrInstr): readonly IrInstr[] => {
    switch (instr.kind) {
      case "box":
        return instr.toType.kind === "dynamic"
          ? admit(boxedKind(instr.toType.tag, types.get(instr.value)), instr, instr.value)
          : [instr];
      case "unbox":
        if (!isDynamic(instr.value)) return [instr];
        if (instr.tagId === JS_TAG_IDS.NumberF64) return [intrinsic(instr, "js.number.unbox", [instr.value])];
        return gap(`unbox of tag ${instr.tagId}`);
      // Only the `undefined` and `null` probes have a source producer here; the
      // number and Boolean tag tests come from `typeof`, which refuses as
      // `dyn.typeof`.
      case "tag.test":
        if (!isDynamic(instr.value)) return [instr];
        if (instr.tagId === JS_TAG_IDS.Undefined) return [intrinsic(instr, "js.extern.is_undefined", [instr.value])];
        if (instr.tagId === JS_TAG_IDS.Null)
          return [
            { kind: "unary", op: "ref.is_null", rand: instr.value, result: instr.result, resultType: instr.resultType },
          ];
        return gap(`tag.test of tag ${instr.tagId}`);
      case "dyn.undefined":
        return [intrinsic(instr, "js.value.undefined", [])];
      case "dyn.truthy":
        return [intrinsic(instr, "js.value.to_boolean", [instr.value])];
      // ToNumber over the admitted set (number, boolean, undefined, null) is
      // exactly the primitive unboxer: a number reads its payload, a boolean
      // 0/1, the `undefined` singleton NaN, the null reference 0.
      case "dyn.to_number":
        return [intrinsic(instr, "js.number.unbox", [instr.value])];
      case "dyn.eq": {
        if (instr.loose) return gap("dyn.eq (loose)");
        if (!instr.negate) return [intrinsic(instr, "js.value.strict_eq", [instr.lhs, instr.rhs])];
        const positive = valueCount++ as IrValueId;
        return [
          intrinsic(instr, "js.value.strict_eq", [instr.lhs, instr.rhs], positive),
          { kind: "unary", op: "i32.eqz", rand: positive, result: instr.result, resultType: instr.resultType },
        ];
      }
      // (#7354 Fa, Fb) The function-value projection (`functionObjectDynamicValue`) boxes a packed callable, and a
      // native closure call boxes its result, an externref, into the dynamic value: the carrier is that externref.
      case "call":
        if (instr.target.binding.kind === "runtime" && instr.target.name === IR_DYN_CALL_BOX_FN) {
          if (isFunctionValue(instr.args[0]!)) return admit("function", instr, instr.args[0]!);
          // (#7354 Fb) A native closure call's result already is a carrier value. Its kind is not known statically:
          // like a parameter's, it is whatever its producer admitted, and kind tests read it at run time.
          const operand = types.get(instr.args[0]!);
          if (operand?.kind === "val" && operand.val.kind === "externref") return [carried(instr, instr.args[0]!)];
        }
        // A front-end dynamic helper (`__ir_dyn_add`, ...) has no runtime declaration.
        return instr.target.binding.kind === "runtime" &&
          !irRuntimeCallableDeclaration(instr.target) &&
          [instr.resultType, ...instr.args.map((arg) => types.get(arg))].some((type) => type?.kind === "dynamic")
          ? gap(instr.target.name)
          : [instr];
      // (#7354 X, O1) The carrier already is the native externref value: the exception payload a thrown dynamic
      // value carries and the value an ordinary object's property stores. The coercion keeps, and lowers to nothing
      // over the legalized operand. The catch binding reads the payload back as the dynamic value: every value an
      // accepted program can throw (a dynamic value, a boxed number, `null`) is in the admitted set.
      case "coerce.to_externref":
        // (#7354 Fa) An object literal stores a closure member as its packed callable, coerced: that coercion is a
        // function value entering the carrier.
        if (isFunctionValue(instr.value)) return admit("function", instr, instr.value);
        return [instr];
      default:
        return instr.kind.startsWith("dyn.") ? gap(instr.kind) : [instr];
    }
  };
  const mapBuffer = (buffer: readonly IrInstr[]): readonly IrInstr[] =>
    buffer.flatMap((instr) => {
      const nested = mapNestedBuffers(instr, mapBuffer);
      return expand(nested).map((out) => {
        const typed = carrierClosureInstr(out);
        const resultType = typed.resultType && carrierOf(typed.resultType);
        return resultType === typed.resultType ? typed : ({ ...typed, resultType } as IrInstr);
      });
    });
  const legalized: IrFunction = {
    ...fn,
    params: fn.params.map((param) => ({ ...param, type: carrierOf(param.type) })),
    resultTypes: fn.resultTypes.map(carrierOf),
    blocks: fn.blocks.map((block) => ({
      ...block,
      blockArgTypes: block.blockArgTypes.map(carrierOf),
      instrs: mapBuffer(block.instrs),
    })),
    valueCount,
    ...(fn.closureSubtype
      ? {
          closureSubtype: {
            ...fn.closureSubtype,
            signature: carrierSignature(fn.closureSubtype.signature),
            captureFieldTypes: fn.closureSubtype.captureFieldTypes.map(carrierOf),
          },
        }
      : {}),
  };
  // Any `dynamic` left (inside a composite type, an async frame, a closure
  // signature) has no carrier on this projection.
  if (containsDynamic(legalized)) gap("on a value of composite type");
  return legalized;
}

/** The part of the allocation registry the legalization re-types. */
export interface RetypableAllocations {
  retypeClosure(id: AllocSiteId, type: Extract<IrType, { kind: "closure" }>): void;
}

/**
 * (#7354 Fa) The allocation sites of legalized closures, in the carrier form their `closure.new` now has: the
 * registry recorded the logical signature when from-ast allocated the closure.
 */
export function legalizeDynamicAllocations(functions: readonly IrFunction[], allocations: RetypableAllocations): void {
  for (const fn of functions)
    for (const block of fn.blocks)
      for (const root of block.instrs)
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "closure.new" && instr.alloc !== undefined && instr.resultType?.kind === "closure")
            allocations.retypeClosure(instr.alloc, instr.resultType);
        });
}

/**
 * (#7354 X, O1) A catch binding reads the thrown payload back as the dynamic value, so every throw of the program, in
 * whichever function, must be a value the carrier admits: a dynamic value, a boxed number, `null` or a coerced (string
 * or dynamic) value. Any other reference (an ordinary object, until the carrier admits objects) refuses by name.
 */
export function refuseUnadmittedThrows(fn: IrFunction): void {
  const definitions = new Map<IrValueId, IrInstr>();
  const throws: IrValueId[] = [];
  for (const block of fn.blocks)
    for (const root of block.instrs)
      forEachInstrDeep(root, (i) => {
        if (i.result !== null && i.result !== undefined) definitions.set(i.result, i);
        if (i.kind === "throw") throws.push(i.value);
      });
  if (throws.length === 0) return;
  const types = irValueTypes(fn);
  for (const value of throws) {
    const definition = definitions.get(value);
    const admitted =
      types.get(value)?.kind === "dynamic" ||
      definition?.kind === "coerce.to_externref" ||
      (definition?.kind === "intrinsic" && definition.id === "js.number.box") ||
      (definition?.kind === "const" && definition.value.kind === "null");
    if (!admitted) gap("throw of a value outside the dynamic carrier's kinds");
  }
}

/** A source global as the producer hands it over: its storage, and the unit that initialises it. */
interface SourceGlobal {
  readonly binding: { readonly globalRef: IrGlobalRef; readonly type: IrType };
  readonly identity: { readonly storageOwnerUnitId: IrUnitId };
}

/**
 * (#7354 H) The globals arm, over functions already legalized. A dynamic global (a script `var` without a
 * proven typed home) is stored as the carrier. JavaScript hoists such a `var` with the value `undefined`, so
 * its storage owner, the script's module-init, stores `undefined` before its first statement; nothing runs
 * before that, so the physical global's own default (a null externref, outside the admitted set) is never
 * read.
 */
export function legalizeDynamicGlobals<Global extends SourceGlobal>(
  functions: readonly IrFunction[],
  globals: readonly Global[],
): { readonly functions: readonly IrFunction[]; readonly globals: readonly Global[] } {
  const dynamic = globals.filter((global) => global.binding.type.kind === "dynamic");
  if (dynamic.length === 0) return { functions, globals };
  return {
    functions: functions.map((fn) => {
      const owned = dynamic.filter((global) => global.identity.storageOwnerUnitId === fn.unitId);
      return owned.length === 0 ? fn : storeUndefinedFirst(fn, owned);
    }),
    globals: globals.map((global) =>
      dynamic.includes(global) ? { ...global, binding: { ...global.binding, type: CARRIER } } : global,
    ),
  };
}

function storeUndefinedFirst(fn: IrFunction, globals: readonly SourceGlobal[]): IrFunction {
  const value = fn.valueCount as IrValueId;
  const prologue: IrInstr[] = [
    {
      kind: "intrinsic",
      id: "js.value.undefined",
      version: INTRINSIC_SIGNATURE_VERSION,
      args: [],
      result: value,
      resultType: INTRINSIC_DEFINITIONS["js.value.undefined"].signature.result,
    },
    ...globals.map(
      (global): IrInstr => ({
        kind: "global.set",
        target: global.binding.globalRef,
        value,
        result: null,
        resultType: null,
      }),
    ),
  ];
  const [entry, ...rest] = fn.blocks;
  return { ...fn, blocks: [{ ...entry!, instrs: [...prologue, ...entry!.instrs] }, ...rest], valueCount: value + 1 };
}
