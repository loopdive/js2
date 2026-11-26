// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7354 D1) Dynamic-value legalization for the Prepared standalone WasmGC source program.
 *
 * The Prepared backend binds runtime functions only through semantic intrinsics, so the dynamic IR operations from-ast
 * emits (`box` to dynamic, `unbox`, `tag.test`, `dyn.*`) are rewritten into the intrinsics that name the same meaning,
 * and every `dynamic` type becomes its carrier, an `externref` (`dynamic-carrier-types.ts`). The source producer runs
 * it on each lowered function, so every later stage (runtime projection, validator replay, physical plan) sees one
 * ordinary externref program. The pass is total: an operation it cannot express throws {@link DynamicValueGap} with a
 * name instead of reaching the backend.
 *
 * Soundness rests on the admitted value set: only numbers, booleans, native strings (#7354 Str), `undefined`, `null`,
 * (#7354 O2) ordinary objects and (Fa) function values can enter a dynamic value here (every other box refuses,
 * `carrierKindOf`), and the runtime functions behind the intrinsics are exact for that set. The kinds and each
 * operation's answer per kind are `dynamic-value-kinds.ts`; the instruction builders are `dynamic-value-chains.ts`.
 * (#7354 T) `null` is the carrier's null reference, as on the ordinary standalone pipeline; `undefined` is the
 * non-null singleton, so the two stay apart under strict equality and the `undefined` probe.
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
import { IR_DYN_ADD_FN } from "../../shared/contracts/dynamic-operator-helpers.js";
import { comparisonBuilders, relationalOfHelper } from "./dynamic-comparisons.js";
import { gap } from "./dynamic-value-gap.js";
import { dynamicMemberRead, dynamicMemberWrite } from "./dynamic-member-access.js";
import { dynamicConstruct, dynamicCurrentThis, dynamicInstanceOf } from "./dynamic-function-operations.js";
import { dynamicObjectStatic, objectStaticOfHelper } from "./dynamic-object-statics.js";
import { dynamicPrototypeMethodCall, prototypeMethodOfCall } from "./dynamic-prototype-methods.js";
import { dynamicErrorConstruction, errorConstructorOf } from "./dynamic-error-constructors.js";
import { realmCall, realmIntrinsicOfHelper } from "./dynamic-realm-calls.js";
import { CARRIER, additionBuilder, chainBuilders, conversionBuilders, knownKinds } from "./dynamic-value-chains.js";
import {
  NO_OBJECTS,
  IS_OBJECT,
  KINDS_OF_TYPEOF,
  OBJECT_TAG,
  TYPEOF_NAME,
  admittedKinds,
  carrierKindOf,
  holdsErrors,
  type LegalizationProgram,
} from "./dynamic-value-kinds.js";
import { functionValueOperand } from "./function-value-projection.js";
import { closureMethodArity } from "../core/closure-invocation-callables.js";
import { carrierClosureSubtype, carrierOf, containsDynamic, inCarrierForm } from "./dynamic-carrier-types.js";

export { DynamicValueGap } from "./dynamic-value-gap.js";

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
  const { intrinsic, fresh, kindTest, anyKind, text, kindChain } = builders;
  const errors = holdsErrors(program);
  const conversions = conversionBuilders(builders, program);
  const { stringOf, toNumber } = conversions;
  const addition = additionBuilder(builders, conversions);
  const comparisons = comparisonBuilders(builders, conversions);
  // (#7354 O4, O3) What a member read or write is written with (`dynamic-member-access.ts`).
  const memberAccess = { ...builders, carrier: CARRIER, definitions, kindsOf: kinds.kindsOf, errors };
  // (#7354 C2) What `this`, `new` and `instanceof` are written with (`dynamic-function-operations.ts`).
  const functionOperations = { ...builders, program, objects: admitted.filter((kind) => IS_OBJECT[kind]) };
  // (#7354 O1, P1, G1) What a recognised `Object` static (`dynamic-object-statics.ts`), a call of a prototype method the
  // realm holds (`dynamic-prototype-methods.ts`) or of an Error constructor (`dynamic-error-constructors.ts`) is
  // written with.
  const objectStatics = { ...builders, stringOf, errors };
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

  /**
   * The carrier value of `kind` an entry (a box to the dynamic value, (#7354 Fa) the function-value projection) builds
   * from its raw `value`; a value of no kind refuses.
   */
  const intoCarrier = (instr: IrInstr, value: IrValueId, kind: ReturnType<typeof carrierKindOf>): IrInstr[] => {
    switch (kind) {
      case "boolean":
        return [intrinsic(instr, "js.boolean.box", [value])];
      // The Null partition has one value, the carrier's null reference.
      case "null":
        return [{ kind: "const", value: { kind: "null", ty: CARRIER }, result: instr.result, resultType: CARRIER }];
      case "number":
        return [intrinsic(instr, "js.number.box", [value])];
      // (#7354 Str) A native string is its own carrier payload: the externref that wraps it; (#7354 O2) an ordinary
      // object and (Fa) a function value's packed closure are one already, and (L0a) so is a carrier the realm answered.
      case "string":
      case "object":
      case "function":
      case "dynamic":
        return [
          {
            kind: "coerce.to_externref",
            value,
            result: instr.result,
            resultType: CARRIER,
            ...(instr.site === undefined ? {} : { site: instr.site }),
          },
        ];
      default:
        return gap(
          instr.kind === "call"
            ? `${instr.target.name} of ${unadmittedValue(value, types, definitions)}, which is not a packed callable`
            : "box of a non-primitive value",
        );
    }
  };

  const expand = (instr: IrInstr): readonly IrInstr[] => {
    switch (instr.kind) {
      case "box":
        if (instr.toType.kind !== "dynamic") return [instr];
        return intoCarrier(instr, instr.value, carrierKindOf(instr.value, types, definitions, instr.toType.tag));
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
            if (kind !== "object" || !errors) return [text(`[object ${OBJECT_TAG[kind]}]`, result)];
            // (#7354 G1) An error is an ordinary object with [[ErrorData]] (§20.1.3.6 step 9).
            const isError = fresh();
            return [
              realmCall("js.object.is-error", [instr.value], isError),
              builders.branch(
                isError,
                (r) => [text("[object Error]", r)],
                (r) => [text("[object Object]", r)],
                result,
              ),
            ];
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
      case "dyn.current_this":
        return dynamicCurrentThis(functionOperations, instr);
      case "dyn.construct": {
        const error = errorConstructorOf(instr.callee, definitions);
        return error === undefined
          ? dynamicConstruct(functionOperations, instr)
          : dynamicErrorConstruction(objectStatics, instr, error, instr.args);
      }
      case "dyn.instanceof":
        return dynamicInstanceOf(functionOperations, instr);
      case "dyn.eq":
        return withSense(instr, instr.negate, (result) =>
          instr.loose
            ? comparisons.looseEquality(instr, [instr.lhs, instr.rhs], result)
            : [intrinsic(instr, "js.value.strict_eq", [instr.lhs, instr.rhs], result)],
        );
      // A front-end dynamic helper has no runtime declaration: (#7354 Str2-c) `__ir_dyn_add` is the dynamic `+` and
      // (L0a) `__ir_dyn_lt`, ... the relational operators, expanded here.
      // (#7354 Fa) The function-value projection's packed callable is its own carrier payload.
      case "call": {
        if (instr.target.binding.kind === "runtime" && instr.target.binding.symbol === IR_DYN_ADD_FN)
          return addition(instr, instr.args, instr.result!);
        const symbol = instr.target.binding.kind === "runtime" ? instr.target.binding.symbol : undefined;
        const relational = symbol === undefined ? undefined : relationalOfHelper(symbol);
        if (relational !== undefined)
          return comparisons.relational(instr, relational, [instr.args[0]!, instr.args[1]!], instr.result!);
        const objectStatic = symbol === undefined ? undefined : objectStaticOfHelper(symbol);
        if (objectStatic !== undefined) return dynamicObjectStatic(objectStatics, instr, objectStatic);
        const realmIntrinsic = symbol === undefined ? undefined : realmIntrinsicOfHelper(symbol);
        if (realmIntrinsic !== undefined) return builders.realmIntrinsic(realmIntrinsic, instr.result!);
        const dispatched = closureMethodArity(instr.target.name) !== undefined;
        const error = dispatched ? errorConstructorOf(instr.args[1]!, definitions) : undefined;
        if (error !== undefined) return dynamicErrorConstruction(objectStatics, instr, error, instr.args.slice(2));
        // (#7354 F2) Without a source function no dispatcher exists: a call through a value would be the TypeError, or
        // (G1) a built-in's run-time abort.
        if (dispatched && !program.objects.functions)
          return gap(`${instr.target.name} in a program that creates no function value`);
        const method = prototypeMethodOfCall(instr, definitions, errors);
        if (method !== undefined) return dynamicPrototypeMethodCall(objectStatics, instr, method);
        const projected = functionValueOperand(instr);
        if (projected !== undefined) return intoCarrier(instr, projected, carrierKindOf(projected, types, definitions));
        return instr.target.binding.kind === "runtime" &&
          !irRuntimeCallableDeclaration(instr.target) &&
          [instr.resultType, ...instr.args.map((arg) => types.get(arg))].some((type) => type?.kind === "dynamic")
          ? gap(instr.target.name)
          : [instr];
      }
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
      return expand(nested).map(inCarrierForm);
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
    ...carrierClosureSubtype(fn),
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
