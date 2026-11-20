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
 * native strings (#7354 Str), `undefined`, `null` and (#7354 O2) ordinary objects can enter a dynamic
 * value here (every other box refuses, `carrierKindOf`), and the runtime functions behind the intrinsics are exact
 * for that set. The kinds and each operation's answer per kind are `dynamic-value-kinds.ts`; the instruction
 * builders are `dynamic-value-chains.ts`. (#7354 T) `null` is the carrier's null reference, as on the ordinary
 * standalone pipeline; `undefined` is the non-null singleton, so the two stay
 * apart under strict equality and the `undefined` probe.
 */
import { irValueTypes } from "../analysis/value-types.js";
import type { AllocSiteRegistry } from "../analysis/alloc-registry.js";
import { INTRINSIC_SIGNATURE_VERSION, INTRINSIC_DEFINITIONS } from "../core/intrinsics.js";
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
import { JS_TAG_IDS } from "../runtime/js-tag-domain.js";
import { typeofComparisons } from "./typeof-comparisons.js";
import { IR_DYN_ADD_FN } from "../../shared/contracts/dynamic-add-helper.js";
import { gap } from "./dynamic-value-gap.js";
import { dynamicMemberRead, dynamicMemberWrite } from "./dynamic-member-access.js";
import { CARRIER, additionBuilder, chainBuilders, conversionBuilders, knownKinds } from "./dynamic-value-chains.js";
import {
  NO_OBJECTS,
  KINDS_OF_TYPEOF,
  OBJECT_TAG,
  TYPEOF_NAME,
  admittedKinds,
  carrierKindOf,
  type LegalizationProgram,
} from "./dynamic-value-kinds.js";

export { DynamicValueGap } from "./dynamic-value-gap.js";

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

/** A value {@link carrierKindOf} has no kind for (through its coercions), as a refusal names it. */
function unadmittedValue(
  value: IrValueId,
  types: ReadonlyMap<IrValueId, IrType>,
  definitions: ReadonlyMap<IrValueId, IrInstr>,
): string {
  const definition = definitions.get(value);
  if (definition?.kind === "coerce.to_externref") return unadmittedValue(definition.value, types, definitions);
  const type = types.get(value);
  return `a value of type ${type?.kind === "val" ? type.val.kind : type?.kind}`;
}

/**
 * Rewrite one function. A function without a dynamic value is returned unchanged. `allocations` is the source's
 * registry: (#7354 Str2) ToString's literal arms are string allocation sites.
 */
export function legalizeDynamicValues(
  fn: IrFunction,
  allocations: AllocSiteRegistry,
  program: LegalizationProgram = { objects: NO_OBJECTS, catches: false },
): IrFunction {
  if (!containsDynamic(fn)) return fn;
  const types = irValueTypes(fn);
  const definitions = valueDefinitions(fn);
  const admitted = admittedKinds(program);
  const kinds = knownKinds(fn, types, definitions, admitted);
  const builders = chainBuilders(fn, allocations, kinds, admitted);
  const { intrinsic, fresh, kindTest, anyKind, text, errorField, kindChain } = builders;
  const { stringOf, toNumber } = conversionBuilders(builders, program);
  const addition = additionBuilder(builders, stringOf);
  // (#7354 O4, O3) What a member read or write is written with (`dynamic-member-access.ts`).
  const memberAccess = {
    carrier: CARRIER,
    definitions,
    fresh,
    text,
    intrinsic,
    errorField,
    kindsOf: kinds.kindsOf,
    kindChain,
  };
  const isDynamic = (value: IrValueId): boolean => types.get(value)?.kind === "dynamic";
  const typeofs = typeofComparisons(fn);
  // `!==`/`!=`: the positive test into a fresh value, then its negation into the comparison's result.
  const withSense = (instr: IrInstr, negate: boolean, positive: (result: IrValueId) => IrInstr[]): IrInstr[] => {
    if (!negate) return positive(instr.result!);
    const value = fresh();
    return [
      ...positive(value),
      { kind: "unary", op: "i32.eqz", rand: value, result: instr.result, resultType: instr.resultType },
    ];
  };

  const expand = (instr: IrInstr): readonly IrInstr[] => {
    switch (instr.kind) {
      case "box": {
        if (instr.toType.kind !== "dynamic") return [instr];
        switch (carrierKindOf(instr.value, types, definitions, instr.toType.tag)) {
          case "boolean":
            return [intrinsic(instr, "js.boolean.box", [instr.value])];
          // The Null partition has one value, the carrier's null reference.
          case "null":
            return [{ kind: "const", value: { kind: "null", ty: CARRIER }, result: instr.result, resultType: CARRIER }];
          case "number":
            return [intrinsic(instr, "js.number.box", [instr.value])];
          // (#7354 Str) A native string is its own carrier payload: the externref that wraps it; (#7354 O2) an ordinary
          // object is one already.
          case "string":
          case "object":
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
          : kindTest(instr, kind, instr.value, instr.result!);
      }
      // (#7354 Ty) `typeof v <op> "literal"` is a tag test on `v`; the `typeof` string and the literal are
      // consumed by it. A literal no admitted kind answers is constant: `v` was already evaluated.
      case "string.eq": {
        const comparison = typeofs.comparisons.get(instr.result!);
        if (comparison === undefined) return [instr];
        const kinds = KINDS_OF_TYPEOF.get(comparison.literal)?.filter((kind) => admitted.includes(kind));
        if (kinds === undefined || kinds.length === 0)
          return [
            {
              kind: "const",
              value: { kind: "bool", value: comparison.negate },
              result: instr.result,
              resultType: instr.resultType,
            },
          ];
        return withSense(instr, comparison.negate, (result) => anyKind(instr, kinds, comparison.operand, result));
      }
      // (#7354 Str2) A `typeof` read other than by a literal comparison is its answer string.
      case "dyn.typeof":
        if (typeofs.consumed.has(instr.result!)) return [];
        return kindChain(instr, instr.value, instr.result!, (kind, result) => [text(TYPEOF_NAME[kind], result)]);
      // (#7354 M1, B-tag) `Object.prototype.toString.call(v)`, which from-ast intercepts: a tag per kind `v` may hold.
      case "dyn.object_tag":
        return kindChain(
          instr,
          instr.value,
          instr.result!,
          (kind, result) => {
            if (kind === "object" && program.objects.namesSymbol)
              gap("Object.prototype.toString of an object in a program that names 'Symbol'");
            return [text(`[object ${OBJECT_TAG[kind]}]`, result)];
          },
          kinds.kindsOf(instr.value),
        );
      case "string.const":
        return typeofs.consumed.has(instr.result!) ? [] : [instr];
      case "dyn.undefined":
        return [intrinsic(instr, "js.value.undefined", [])];
      case "dyn.to_string":
        return stringOf(instr, instr.value, instr.result!);
      case "dyn.truthy":
        return [intrinsic(instr, "js.value.to_boolean", [instr.value])];
      case "dyn.to_number":
        return toNumber(instr, instr.value, instr.result!);
      case "dyn.member_get":
        return dynamicMemberRead(memberAccess, instr, instr.result!);
      case "dyn.member_set":
        return dynamicMemberWrite(memberAccess, instr);
      case "dyn.eq": {
        if (instr.loose) return gap("dyn.eq (loose)");
        return withSense(instr, instr.negate, (result) => [
          intrinsic(instr, "js.value.strict_eq", [instr.lhs, instr.rhs], result),
        ]);
      }
      // A front-end dynamic helper (`__ir_dyn_lt`, ...) has no runtime declaration; (#7354 Str2-c) `__ir_dyn_add`
      // is the dynamic `+`, expanded here.
      case "call":
        if (instr.target.binding.kind === "runtime" && instr.target.binding.symbol === IR_DYN_ADD_FN)
          return addition(instr, instr.args, instr.result!);
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
        return !toCarrier || carrierKindOf(instr.value, types, definitions) !== undefined
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
    valueCount: builders.valueCount(),
  };
  // Any `dynamic` left (inside a composite type, an async frame, a closure
  // signature) has no carrier on this projection.
  if (containsDynamic(legalized)) gap("on a value of composite type");
  return legalized;
}

/**
 * (#7354 X, O1) A catch binding reads the thrown payload back as the dynamic value, so in a program that reads one,
 * every throw, in whichever function, must be a value of a {@link carrierKindOf}. Any other value refuses by name.
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
    if (carrierKindOf(value, types, definitions) === undefined)
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
