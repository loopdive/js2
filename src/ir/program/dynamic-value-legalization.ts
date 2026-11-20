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
 * apart under strict equality and the `undefined` probe.
 */
import { irValueTypes } from "../analysis/value-types.js";
import { INTRINSIC_SIGNATURE_VERSION, INTRINSIC_DEFINITIONS, type IntrinsicId } from "../core/intrinsics.js";
import {
  forEachInstrDeep,
  mapNestedBuffers,
  type IrFunction,
  type IrGlobalRef,
  type IrInstr,
  type IrValueId,
} from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { irRuntimeCallableDeclaration } from "../runtime/callable-declarations.js";
import { irOrdinaryObjectCallableDeclaration } from "../runtime/ordinary-object-callables.js";
import { JS_TAG_IDS } from "../runtime/js-tag-domain.js";

const CARRIER: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "externref" }) });

/** A dynamic operation the Prepared path has no intrinsic for; the message names it. */
export class DynamicValueGap extends Error {}

function gap(operation: string): never {
  throw new DynamicValueGap(`dynamic operation ${operation} has no Prepared intrinsic`);
}

/** Walk the data structurally: IR constants may hold bigints, which JSON cannot. */
export function containsDynamic(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if ((value as { kind?: unknown }).kind === "dynamic") return true;
  return Object.values(value).some(containsDynamic);
}

function carrierOf(type: IrType): IrType {
  return type.kind === "dynamic" ? CARRIER : type;
}

/** Each value's defining instruction, nested buffers included. */
function valueDefinitions(fn: IrFunction): Map<IrValueId, IrInstr> {
  const definitions = new Map<IrValueId, IrInstr>();
  for (const block of fn.blocks)
    for (const root of block.instrs)
      forEachInstrDeep(root, (i) => {
        if (i.result !== null && i.result !== undefined) definitions.set(i.result, i);
      });
  return definitions;
}

/**
 * (#7354 X, O1) The kind the carrier holds `value` as, from its type and defining instruction: the dynamic value
 * itself, a native string (its own payload), a boundary box's number or Boolean, the null constant's null reference,
 * or, through a coercion, its operand's kind. Any other value has none: an ordinary object until #7354 O2 gives the
 * carrier its kind, a callable until slice Fa gives it its tag.
 */
export function carrierKind(
  value: IrValueId,
  types: ReadonlyMap<IrValueId, IrType>,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
): "dynamic" | "string" | "number" | "boolean" | "null" | undefined {
  const type = types.get(value);
  if (type?.kind === "dynamic" || type?.kind === "string") return type.kind;
  const definition = definitions.get(value);
  if (definition?.kind === "intrinsic" && definition.id === "js.number.box") return "number";
  if (definition?.kind === "intrinsic" && definition.id === "js.boolean.box") return "boolean";
  if (definition?.kind === "const" && definition.value.kind === "null") return "null";
  return definition?.kind === "coerce.to_externref" ? carrierKind(definition.value, types, definitions) : undefined;
}

/** A value {@link carrierKind} has no kind for (through its coercions), as a refusal names it. */
function unadmittedValue(
  value: IrValueId,
  types: ReadonlyMap<IrValueId, IrType>,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
): string {
  const definition = definitions.get(value);
  if (definition?.kind === "coerce.to_externref") return unadmittedValue(definition.value, types, definitions);
  if (
    definition?.kind === "call" &&
    irOrdinaryObjectCallableDeclaration(definition.target)?.feature === "js.object.create-default"
  )
    return "an ordinary object";
  const type = types.get(value);
  return `a value of type ${type?.kind === "val" ? type.val.kind : type?.kind}`;
}

/** Rewrite one function. A function without a dynamic value is returned unchanged. */
export function legalizeDynamicValues(fn: IrFunction): IrFunction {
  if (!containsDynamic(fn)) return fn;
  const types = irValueTypes(fn);
  const definitions = valueDefinitions(fn);
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

  const expand = (instr: IrInstr): readonly IrInstr[] => {
    switch (instr.kind) {
      case "box": {
        if (instr.toType.kind !== "dynamic") return [instr];
        if (instr.toType.tag === JS_TAG_IDS.Boolean) return [intrinsic(instr, "js.boolean.box", [instr.value])];
        // The Null partition has one value, the carrier's null reference.
        if (instr.toType.tag === JS_TAG_IDS.Null)
          return [{ kind: "const", value: { kind: "null", ty: CARRIER }, result: instr.result, resultType: CARRIER }];
        const source = types.get(instr.value);
        if (source?.kind === "val" && source.val.kind === "f64")
          return [intrinsic(instr, "js.number.box", [instr.value])];
        // (#7354 Str) A native string is its own carrier payload: the externref that wraps it.
        if (source?.kind === "string")
          return [
            {
              kind: "coerce.to_externref",
              value: instr.value,
              result: instr.result,
              resultType: CARRIER,
              ...(instr.site === undefined ? {} : { site: instr.site }),
            },
          ];
        return gap(`box of a non-primitive value`);
      }
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
      // A front-end dynamic helper (`__ir_dyn_add`, ...) has no runtime declaration.
      case "call":
        return instr.target.binding.kind === "runtime" &&
          !irRuntimeCallableDeclaration(instr.target) &&
          [instr.resultType, ...instr.args.map((arg) => types.get(arg))].some((type) => type?.kind === "dynamic")
          ? gap(instr.target.name)
          : [instr];
      // (#7354 X, O1) The carrier already is the native externref value: the exception payload a thrown dynamic
      // value carries and the value an ordinary object's property stores. A coercion to it keeps, and lowers to
      // nothing over the legalized operand, only for an operand of a kind the carrier holds. (A callable pack is
      // a coercion to the callable type, not to the carrier.)
      case "coerce.to_externref": {
        const target = instr.resultType;
        const toCarrier = target?.kind === "dynamic" || (target?.kind === "val" && target.val.kind === "externref");
        return !toCarrier || carrierKind(instr.value, types, definitions) !== undefined
          ? [instr]
          : gap(`coerce.to_externref of ${unadmittedValue(instr.value, types, definitions)}`);
      }
      default:
        return instr.kind.startsWith("dyn.") ? gap(instr.kind) : [instr];
    }
  };
  const mapBuffer = (buffer: readonly IrInstr[]): readonly IrInstr[] =>
    buffer.flatMap((instr) => {
      const nested = mapNestedBuffers(instr, mapBuffer);
      return expand(nested).map((out) =>
        out.resultType?.kind === "dynamic" ? ({ ...out, resultType: CARRIER } as IrInstr) : out,
      );
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
  };
  // Any `dynamic` left (inside a composite type, an async frame, a closure
  // signature) has no carrier on this projection.
  if (containsDynamic(legalized)) gap("on a value of composite type");
  return legalized;
}

/**
 * (#7354 X, O1) A catch binding reads the thrown payload back as the dynamic value, so in a program that binds one,
 * every throw, in whichever function, must be a value of a {@link carrierKind}. Any other value refuses by name.
 */
export function refuseUnadmittedThrows(fn: IrFunction): void {
  const throws: IrValueId[] = [];
  for (const block of fn.blocks)
    for (const root of block.instrs)
      forEachInstrDeep(root, (i) => {
        if (i.kind === "throw") throws.push(i.value);
      });
  if (throws.length === 0) return;
  const types = irValueTypes(fn);
  const definitions = valueDefinitions(fn);
  for (const value of throws)
    if (carrierKind(value, types, definitions) === undefined)
      gap(`throw of a value outside the dynamic carrier's kinds (${unadmittedValue(value, types, definitions)})`);
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
