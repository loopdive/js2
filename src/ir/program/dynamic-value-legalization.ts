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
 * native strings (#7354 Str), `undefined` and `null` can enter a dynamic
 * value here (every other box refuses), and the runtime functions behind the intrinsics are exact for that
 * set. (#7354 T) `null` is the carrier's null reference, as on the ordinary
 * standalone pipeline; `undefined` is the non-null singleton, so the two stay
 * apart under strict equality and the `undefined` probe.
 */
import { irValueTypes } from "../analysis/value-types.js";
import type { AllocSiteRegistry } from "../analysis/alloc-registry.js";
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
import { PREPARED_NUMBER_TO_STRING } from "./number-to-string-target.js";
import { IR_DYN_ADD_FN } from "../../shared/contracts/dynamic-add-helper.js";

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
 * slice that admits functions or objects must add its kind here. That is what makes the `typeof`
 * comparison arm sound: a literal no row answers ("function", a typo) is constant false.
 */
const TYPEOF_KIND = {
  number: "number",
  boolean: "boolean",
  string: "string",
  undefined: "undefined",
  object: "null",
} as const;
type CarrierKind = (typeof TYPEOF_KIND)[keyof typeof TYPEOF_KIND];
const KIND_OF_TYPEOF: ReadonlyMap<string, CarrierKind> = new Map(Object.entries(TYPEOF_KIND));

/** How the carrier tests for each admitted kind: a runtime predicate or the null test. */
const KIND_TEST: Readonly<Record<CarrierKind, IntrinsicId | "ref.is_null">> = {
  number: "js.value.is_number",
  boolean: "js.value.is_boolean",
  string: "js.value.is_string",
  undefined: "js.extern.is_undefined",
  null: "ref.is_null",
};

/**
 * (#7354 Str2) How ToString (§7.1.17) answers each admitted kind, in the order `dyn.to_string`'s chain tests them:
 * the native string it carries, the number formatter, "true"/"false", or the kind's own name. A `Record` over the
 * kinds, so a slice that admits a kind must say how it prints; the last kind is reached untested because the chain
 * is total over this table.
 */
const TO_STRING_ARM: Readonly<Record<CarrierKind, "as-string" | "format" | "boolean" | "name">> = {
  string: "as-string",
  number: "format",
  boolean: "boolean",
  undefined: "name",
  null: "name",
};
const KIND_ORDER = Object.keys(TO_STRING_ARM) as readonly CarrierKind[];
/** (#7354 Str2) `typeof`'s answer for each admitted kind: `TYPEOF_KIND` read backwards (`typeof null` is "object"). */
const TYPEOF_NAME = Object.fromEntries(Object.entries(TYPEOF_KIND).map(([answer, kind]) => [kind, answer])) as Readonly<
  Record<CarrierKind, string>
>;
/**
 * (#7354 Str2-c) How `+` (§13.15.3) takes each admitted kind after ToPrimitive, which is the identity on every kind
 * here because all are primitives: a string makes the addition a concatenation, any other kind is summed through
 * ToNumber. A `Record` over the kinds, so a slice admitting an object kind must give it a row, and an object has none
 * until `+` applies ToPrimitive to it.
 */
const ADD_ROLE: Readonly<Record<CarrierKind, "concat" | "numeric">> = {
  number: "numeric",
  boolean: "numeric",
  string: "concat",
  undefined: "numeric",
  null: "numeric",
};
const STRING: IrType = Object.freeze({ kind: "string" });
const F64: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "f64" }) });
const TEST_RESULT: IrType = INTRINSIC_DEFINITIONS["js.value.is_string"].signature.result;

/** The kind a box to the dynamic value admits, from its tag refinement or its operand; `undefined` refuses. */
function boxedKind(tag: TagId | undefined, source: IrType | undefined): CarrierKind | undefined {
  if (tag === JS_TAG_IDS.Boolean) return "boolean";
  if (tag === JS_TAG_IDS.Null) return "null";
  if (source?.kind === "string") return "string";
  return source?.kind === "val" && source.val.kind === "f64" ? "number" : undefined;
}

/**
 * (#7354 Str2-c) The kind each value of `fn` is proven to hold: a box to the dynamic value proves its operand's, and
 * the legalization records a concatenation's result as a string (`learn`). Any other value may hold every kind.
 */
function knownKinds(fn: IrFunction, types: ReturnType<typeof irValueTypes>) {
  const known = new Map<IrValueId, CarrierKind>();
  for (const block of fn.blocks)
    for (const root of block.instrs)
      forEachInstrDeep(root, (i) => {
        const kind = i.kind === "box" && i.toType.kind === "dynamic" && boxedKind(i.toType.tag, types.get(i.value));
        if (kind) known.set(i.result!, kind);
      });
  return {
    kindsOf: (value: IrValueId): readonly CarrierKind[] => {
      const kind = known.get(value);
      return kind ? [kind] : KIND_ORDER;
    },
    learn: (value: IrValueId, kind: CarrierKind) => known.set(value, kind),
  };
}
type KnownKinds = ReturnType<typeof knownKinds>;

/**
 * The instruction builders of one function's legalization: fresh values after the function's own, intrinsic calls,
 * kind tests, and the per-kind chains (`kindChain`) that ToString (`stringOf`), `typeof` and `+` share.
 */
function chainBuilders(fn: IrFunction, allocations: AllocSiteRegistry, kinds: KnownKinds) {
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
  const kindTest = (
    instr: IrInstr,
    kind: CarrierKind,
    value: IrValueId,
    result: IrValueId,
    resultType = instr.resultType,
  ): IrInstr => {
    const test = KIND_TEST[kind];
    return test === "ref.is_null"
      ? { kind: "unary", op: "ref.is_null", rand: value, result, resultType }
      : intrinsic(instr, test, [value], result);
  };
  const fresh = (): IrValueId => valueCount++ as IrValueId;
  const text = (value: string, result: IrValueId): IrInstr => ({
    kind: "string.const",
    value,
    result,
    resultType: STRING,
    alloc: allocations.fresh("string", STRING),
  });
  const branch = (
    cond: IrValueId,
    then: (r: IrValueId) => IrInstr[],
    else_: (r: IrValueId) => IrInstr[],
    result: IrValueId,
    resultType: IrType = STRING,
  ): IrInstr => {
    const thenValue = fresh();
    const elseValue = fresh();
    return {
      kind: "if",
      cond,
      then: then(thenValue),
      thenValue,
      else: else_(elseValue),
      elseValue,
      result,
      resultType,
    };
  };
  // (#7354 Str2) ToString of the once-evaluated `value`, one arm per admitted kind (`TO_STRING_ARM`).
  const toStringArm = (instr: IrInstr, kind: CarrierKind, value: IrValueId, result: IrValueId): IrInstr[] => {
    switch (TO_STRING_ARM[kind]) {
      case "as-string":
        return [intrinsic(instr, "js.value.as_string", [value], result)];
      case "format": {
        const number = fresh();
        return [
          intrinsic(instr, "js.number.unbox", [value], number),
          { kind: "call", target: PREPARED_NUMBER_TO_STRING, args: [number], result, resultType: STRING },
        ];
      }
      case "boolean": {
        const flag = fresh();
        return [
          // ToBoolean of a Boolean is its payload; it needs no unbox policy.
          intrinsic(instr, "js.value.to_boolean", [value], flag),
          branch(
            flag,
            (r) => [text("true", r)],
            (r) => [text("false", r)],
            result,
          ),
        ];
      }
      case "name":
        return [text(kind, result)];
    }
  };
  // A string per admitted kind of the once-evaluated `value`: a chain of tag tests in `KIND_ORDER`, the last kind
  // untested (the chain is total over the kinds), each arm answering into its own value.
  const kindChain = (
    instr: IrInstr,
    value: IrValueId,
    result: IrValueId,
    arm: (kind: CarrierKind, result: IrValueId) => IrInstr[],
    kinds: readonly CarrierKind[] = KIND_ORDER,
  ): IrInstr[] => {
    const [kind, ...rest] = kinds;
    if (rest.length === 0) return arm(kind!, result);
    const cond = fresh();
    return [
      kindTest(instr, kind!, value, cond, TEST_RESULT),
      branch(
        cond,
        (r) => arm(kind!, r),
        (r) => kindChain(instr, value, r, arm, rest),
        result,
      ),
    ];
  };
  // ToString of the once-evaluated `value`: only the arms of the kinds it may hold.
  const stringOf = (instr: IrInstr, value: IrValueId, result: IrValueId): IrInstr[] =>
    kindChain(instr, value, result, (kind, r) => toStringArm(instr, kind, value, r), kinds.kindsOf(value));
  return {
    kinds,
    allocations,
    intrinsic,
    fresh,
    kindTest,
    text,
    branch,
    kindChain,
    stringOf,
    valueCount: () => valueCount,
  };
}
type ChainBuilders = ReturnType<typeof chainBuilders>;

/**
 * (#7354 Str2-c) The dynamic `+` of two once-evaluated operands (`ADD_ROLE`): a string on either side concatenates
 * their ToStrings, otherwise the ToNumbers are summed; either answer is boxed back into the carrier. An operand of a
 * known kind takes only its own arms: a known string makes the whole addition a concatenation without a test, and
 * only a side that may hold a string is tested.
 */
function additionBuilder(builders: ChainBuilders) {
  const { kinds, allocations, intrinsic, fresh, kindTest, branch, stringOf } = builders;
  const concat = (instr: IrInstr, operands: readonly IrValueId[], r: IrValueId): IrInstr[] => {
    const [left, right, text] = [fresh(), fresh(), fresh()];
    return [
      ...stringOf(instr, operands[0]!, left),
      ...stringOf(instr, operands[1]!, right),
      {
        kind: "string.concat",
        lhs: left,
        rhs: right,
        result: text,
        resultType: STRING,
        alloc: allocations.fresh("string", STRING),
        concatMode: "immutable",
      },
      { kind: "coerce.to_externref", value: text, result: r, resultType: CARRIER },
    ];
  };
  const sum = (instr: IrInstr, operands: readonly IrValueId[], r: IrValueId): IrInstr[] => {
    const [left, right, total] = [fresh(), fresh(), fresh()];
    return [
      intrinsic(instr, "js.number.unbox", [operands[0]!], left),
      intrinsic(instr, "js.number.unbox", [operands[1]!], right),
      { kind: "binary", op: "f64.add", lhs: left, rhs: right, result: total, resultType: F64 },
      intrinsic(instr, "js.number.box", [total], r),
    ];
  };
  return (instr: IrInstr, operands: readonly IrValueId[], result: IrValueId): IrInstr[] => {
    const roles = operands.map((value) => kinds.kindsOf(value).map((kind) => ADD_ROLE[kind]));
    if (roles.some((role) => role.every((r) => r === "concat"))) {
      // A concatenation is a known string to the next `+` of a chain (`"a" + v + "b"`). Legalization meets a value's
      // definition before its uses, so the next site reads this.
      kinds.learn(result, "string");
      return concat(instr, operands, result);
    }
    // The front end makes a `+` dynamic only over an operand of unknown kind (`emitDynamicAdd` in from-ast), which
    // may hold a string, so at least one operand is tested here.
    const tests = operands.flatMap((value) =>
      kinds
        .kindsOf(value)
        .filter((kind) => ADD_ROLE[kind] === "concat")
        .map((kind) => {
          const cond = fresh();
          return { cond, instrs: [kindTest(instr, kind, value, cond, TEST_RESULT)] };
        }),
    );
    const conds: IrInstr[] = tests.flatMap((test) => test.instrs);
    let cond = tests[0]!.cond;
    for (const test of tests.slice(1)) {
      const either = fresh();
      conds.push({ kind: "binary", op: "i32.or", lhs: cond, rhs: test.cond, result: either, resultType: TEST_RESULT });
      cond = either;
    }
    return [
      ...conds,
      branch(
        cond,
        (r) => concat(instr, operands, r),
        (r) => sum(instr, operands, r),
        result,
        CARRIER,
      ),
    ];
  };
}

/**
 * Rewrite one function. A function without a dynamic value is returned unchanged. `allocations` is the source's
 * registry: (#7354 Str2) ToString's literal arms are string allocation sites.
 */
export function legalizeDynamicValues(fn: IrFunction, allocations: AllocSiteRegistry): IrFunction {
  if (!containsDynamic(fn)) return fn;
  const types = irValueTypes(fn);
  const kinds = knownKinds(fn, types);
  const builders = chainBuilders(fn, allocations, kinds);
  const { intrinsic, fresh, kindTest, text, kindChain, stringOf, valueCount } = builders;
  const addition = additionBuilder(builders);
  const isDynamic = (value: IrValueId): boolean => types.get(value)?.kind === "dynamic";
  const thrown = new Set<IrValueId>();
  for (const block of fn.blocks)
    for (const instr of block.instrs) forEachInstrDeep(instr, (i) => i.kind === "throw" && thrown.add(i.value));
  const typeofs = typeofComparisons(fn);
  // `!==`/`!=`: the positive test into a fresh value, then its negation into the comparison's result.
  const withSense = (instr: IrInstr, negate: boolean, positive: (result: IrValueId) => IrInstr): IrInstr[] => {
    if (!negate) return [positive(instr.result!)];
    const value = fresh();
    return [
      positive(value),
      { kind: "unary", op: "i32.eqz", rand: value, result: instr.result, resultType: instr.resultType },
    ];
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
      // (#7354 Str2) A `typeof` read other than by a literal comparison is its answer string.
      case "dyn.typeof":
        if (typeofs.consumed.has(instr.result!)) return [];
        return kindChain(instr, instr.value, instr.result!, (kind, result) => [text(TYPEOF_NAME[kind], result)]);
      case "string.const":
        return typeofs.consumed.has(instr.result!) ? [] : [instr];
      case "dyn.undefined":
        return [intrinsic(instr, "js.value.undefined", [])];
      case "dyn.to_string":
        return stringOf(instr, instr.value, instr.result!);
      case "dyn.truthy":
        return [intrinsic(instr, "js.value.to_boolean", [instr.value])];
      // ToNumber over the admitted set (number, boolean, undefined, null) is
      // exactly the primitive unboxer: a number reads its payload, a boolean
      // 0/1, the `undefined` singleton NaN, the null reference 0.
      case "dyn.to_number":
        return [intrinsic(instr, "js.number.unbox", [instr.value])];
      case "dyn.eq": {
        if (instr.loose) return gap("dyn.eq (loose)");
        return withSense(instr, instr.negate, (result) =>
          intrinsic(instr, "js.value.strict_eq", [instr.lhs, instr.rhs], result),
        );
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
    valueCount: valueCount(),
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
