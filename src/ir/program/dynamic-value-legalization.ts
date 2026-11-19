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
 * `undefined`, `null` and (#7354 Str) native strings can enter a dynamic
 * value here (every other box refuses), and the runtime functions behind the
 * intrinsics are exact for that set. (#7354 T) `null` is the carrier's null
 * reference, as on the ordinary standalone pipeline; `undefined` is the
 * non-null singleton, so the two stay apart under strict equality and the
 * `undefined` probe.
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
import type { TagId } from "../core/tag-domain.js";
import type { IrType } from "../core/types.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { irRuntimeCallableDeclaration } from "../runtime/callable-declarations.js";
import { JS_TAG_IDS } from "../runtime/js-tag-domain.js";
import { typeofComparisons } from "./typeof-comparisons.js";

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

function carrierOf(type: IrType): IrType {
  return type.kind === "dynamic" ? CARRIER : type;
}

/**
 * (#7354 Ty) `typeof`'s answer for each kind of value the carrier admits, keyed by the answer so that no two
 * kinds can share one (`typeof null` is "object": an admitted object kind must merge with that row). The
 * admitted kinds ARE this table's values: the box arm admits a value only as one of them (`boxedKind`), so a
 * slice that admits functions or objects must add its kind here, as Str did for strings. That is what makes
 * the `typeof` comparison arm sound: a literal no row answers ("function", "symbol", a typo) is constant false.
 */
const TYPEOF_KIND = {
  number: "number",
  boolean: "boolean",
  undefined: "undefined",
  object: "null",
  string: "string",
} as const;
type CarrierKind = (typeof TYPEOF_KIND)[keyof typeof TYPEOF_KIND];
const KIND_OF_TYPEOF: ReadonlyMap<string, CarrierKind> = new Map(Object.entries(TYPEOF_KIND));

/**
 * How the carrier tests for each admitted kind: a runtime predicate, the null test, or `"refuse"`. The native
 * lane has no string predicate resource yet, so a test for a string refuses by name rather than answering false.
 * The refusal is a named entry, not a missing one: a missing literal in `KIND_OF_TYPEOF` means constant false.
 */
const KIND_TEST: Readonly<Record<CarrierKind, IntrinsicId | "ref.is_null" | "refuse">> = {
  number: "js.value.is_number",
  boolean: "js.value.is_boolean",
  undefined: "js.extern.is_undefined",
  null: "ref.is_null",
  string: "refuse",
};

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
  const thrown = new Set<IrValueId>();
  for (const block of fn.blocks)
    for (const instr of block.instrs) forEachInstrDeep(instr, (i) => i.kind === "throw" && thrown.add(i.value));
  const typeofs = typeofComparisons(fn);
  // `!==`/`!=`: the positive test into a fresh value, then its negation into the comparison's result.
  const withSense = (instr: IrInstr, negate: boolean, positive: (result: IrValueId) => IrInstr): IrInstr[] => {
    if (!negate) return [positive(instr.result!)];
    const value = valueCount++ as IrValueId;
    return [
      positive(value),
      { kind: "unary", op: "i32.eqz", rand: value, result: instr.result, resultType: instr.resultType },
    ];
  };
  const kindTest = (instr: IrInstr, kind: CarrierKind, value: IrValueId, result: IrValueId): IrInstr => {
    const test = KIND_TEST[kind];
    if (test === "refuse") return gap(`typeof test for ${kind}`);
    return test === "ref.is_null"
      ? { kind: "unary", op: "ref.is_null", rand: value, result, resultType: instr.resultType }
      : intrinsic(instr, test, [value], result);
  };

  const expand = (instr: IrInstr): readonly IrInstr[] => {
    switch (instr.kind) {
      case "box": {
        if (instr.toType.kind !== "dynamic") return [instr];
        switch (boxedKind(instr.toType.tag, types.get(instr.value))) {
          case "boolean":
            return [intrinsic(instr, "js.boolean.box", [instr.value])];
          // The Null partition has one value, the carrier's null reference.
          case "null":
            return [{ kind: "const", value: { kind: "null", ty: CARRIER }, result: instr.result, resultType: CARRIER }];
          case "number":
            return [intrinsic(instr, "js.number.box", [instr.value])];
          // (#7354 Str) A native string is its own carrier payload: the externref that wraps it.
          case "string":
            return [
              {
                kind: "coerce.to_externref",
                value: instr.value,
                result: instr.result,
                resultType: CARRIER,
                ...(instr.site === undefined ? {} : { site: instr.site }),
              },
            ];
          default:
            return gap(`box of a non-primitive value`);
        }
      }
      case "unbox":
        if (!isDynamic(instr.value)) return [instr];
        if (instr.tagId === JS_TAG_IDS.NumberF64) return [intrinsic(instr, "js.number.unbox", [instr.value])];
        return gap(`unbox of tag ${instr.tagId}`);
      // Only the `undefined` and `null` probes have a source producer here; the number and Boolean tests come
      // from a `typeof` comparison (the `string.eq` arm below).
      case "tag.test": {
        if (!isDynamic(instr.value)) return [instr];
        const kind =
          instr.tagId === JS_TAG_IDS.Undefined ? "undefined" : instr.tagId === JS_TAG_IDS.Null ? "null" : undefined;
        return kind === undefined
          ? gap(`tag.test of tag ${instr.tagId}`)
          : [kindTest(instr, kind, instr.value, instr.result!)];
      }
      // (#7354 Ty) `typeof v <op> "literal"` is a tag test on `v`; the `typeof` string and the literal are
      // consumed by it. A literal no admitted kind answers is constant: `v` was already evaluated.
      case "string.eq": {
        const comparison = typeofs.comparisons.get(instr.result!);
        if (comparison === undefined) return [instr];
        const kind = KIND_OF_TYPEOF.get(comparison.literal);
        if (kind === undefined)
          return [
            {
              kind: "const",
              value: { kind: "bool", value: comparison.negate },
              result: instr.result,
              resultType: instr.resultType,
            },
          ];
        return withSense(instr, comparison.negate, (result) => kindTest(instr, kind, comparison.operand, result));
      }
      case "dyn.typeof":
        return typeofs.consumed.has(instr.result!) ? [] : gap("dyn.typeof");
      case "string.const":
        return typeofs.consumed.has(instr.result!) ? [] : [instr];
      case "dyn.undefined":
        return [intrinsic(instr, "js.value.undefined", [])];
      case "dyn.truthy":
        return [intrinsic(instr, "js.value.to_boolean", [instr.value])];
      // ToNumber over the admitted set is exactly the primitive unboxer: a
      // number reads its payload, a boolean 0/1, the `undefined` singleton
      // NaN, the null reference 0, and (#7354 Str) a native string goes
      // through StringToNumber.
      case "dyn.to_number":
        return [intrinsic(instr, "js.number.unbox", [instr.value])];
      case "dyn.eq": {
        if (instr.loose) return gap("dyn.eq (loose)");
        return withSense(instr, instr.negate, (result) =>
          intrinsic(instr, "js.value.strict_eq", [instr.lhs, instr.rhs], result),
        );
      }
      // A front-end dynamic helper (`__ir_dyn_add`, ...) has no runtime declaration.
      case "call":
        return instr.target.binding.kind === "runtime" &&
          !irRuntimeCallableDeclaration(instr.target) &&
          [instr.resultType, ...instr.args.map((arg) => types.get(arg))].some((type) => type?.kind === "dynamic")
          ? gap(instr.target.name)
          : [instr];
      // (#7354 X) The carrier already is the externref exception payload, so a
      // thrown dynamic value keeps the coercion, which lowers to nothing over
      // the legalized operand. The catch binding reads the payload back as the
      // dynamic value: every value an accepted program can throw (a dynamic
      // value, a boxed number, `null`) is in the admitted set.
      case "coerce.to_externref":
        return isDynamic(instr.value) && !thrown.has(instr.result!) ? gap("coerce.to_externref") : [instr];
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
