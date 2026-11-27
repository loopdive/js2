// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4, O3, M1) A member read or write of the dynamic value with a constant key, as one chain over the receiver's
 * kinds (`MEMBER_ACCESS_ARM`): a TypeError for `undefined` / `null`, the realm's [[Get]] or [[Set]] for an object
 * ((#7354 G1) an error included), and for a primitive what its pristine wrapper answers. A key a built-in prototype
 * holds (the realm's prototypes do not hold it yet) refuses by name. (#7354 A1) A constant number key is its canonical
 * string; a computed key is the subset arrays need ({@link computedAccess}).
 */
import type { IntrinsicId } from "../core/intrinsics.js";
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import {
  BUILTIN_REACHABLE_KEYS,
  FUNCTION_PROTOTYPE_ACCESSOR_KEYS,
  OBJECT_PROTOTYPE_ACCESSOR_KEYS,
  isArrayIndexKey,
  nativeObjectPrototypeMethod,
  objectPrototypeMethodId,
  heldWrapperPrototypeKey,
  unheldFamilyPrototypeKeys,
} from "./builtin-prototype-keys.js";
import { WRAPPER_OF_PRIMITIVE } from "./builtin-prototype-keys.js";
import { MEMBER_ACCESS_ARM, objectFamilies, type CarrierKind, type ProgramFamilies } from "./dynamic-value-kinds.js";
import { realmCall, typeErrorThen, type TypeErrorBuilders } from "./dynamic-realm-calls.js";
import type { KnownKinds, ValueConversion } from "./dynamic-value-chains.js";
import { carried } from "./dynamic-value-types.js";
import { gap } from "./dynamic-value-gap.js";

/** The legalization builders a member access is written with. */
export interface MemberAccessBuilders extends TypeErrorBuilders {
  readonly definitions: ReadonlyMap<IrValueId, IrInstr>;
  readonly intrinsic: (
    instr: IrInstr,
    id: IntrinsicId,
    args: readonly IrValueId[],
    result?: IrValueId | null,
  ) => IrInstr;
  /** (#7354 C2) The run-time abort, a carrier answer. */
  readonly abort: (instr: IrInstr, result: IrValueId) => IrInstr[];
  readonly kindsOf: (value: IrValueId) => readonly CarrierKind[];
  readonly admitted: readonly CarrierKind[];
  /** (#7354 P1, G1) The realm's built-in function object `id` into `result`. */
  readonly realmIntrinsic: (id: string, result: IrValueId) => IrInstr[];
  /** (#7354 G1, W2) The realm families the program's values may come from. */
  readonly families: ProgramFamilies;
  /** (#7354 W2) The statics its realm constructors lack (`unheldStaticKeys`). */
  readonly staticKeys: ReadonlySet<string>;
  /** (#7354 A1) The program's ToString: ToPropertyKey of a computed primitive key. */
  readonly stringOf: ValueConversion;
  /** (#7354 A1) The kinds the legalization proved, which a computed key's arm narrows. */
  readonly kinds: Pick<KnownKinds, "learn">;
  readonly toNumber: ValueConversion;
  readonly branch: (
    cond: IrValueId,
    then: (result: IrValueId) => IrInstr[],
    else_: (result: IrValueId) => IrInstr[],
    result: IrValueId,
    resultType?: IrType,
  ) => IrInstr;
  readonly kindChain: (
    instr: IrInstr,
    value: IrValueId,
    result: IrValueId,
    arm: (kind: CarrierKind, result: IrValueId) => IrInstr[],
    kinds: readonly CarrierKind[],
    resultType: IrType,
  ) => IrInstr[];
}

type MemberGet = Extract<IrInstr, { kind: "dyn.member_get" }>;
type MemberSet = Extract<IrInstr, { kind: "dyn.member_set" }>;

/** A thrown TypeError with `message` (`typeError`), the arm's unread answer into `result`. */
type ThrowTypeError = (message: string, result: IrValueId) => IrInstr[];
/** The run-time abort into `result`, a carrier answer. */
type Abort = (result: IrValueId) => IrInstr[];

/** What sets a read and a write apart past the receiver chain they share. */
interface Access {
  /** The access as a refusal names it ("member read 'k'"). */
  readonly operation: string;
  readonly resultType: IrType;
  /** What the realm lacks to answer the access for a receiver of `kind`, if it lacks something. */
  readonly missing: (kind: CarrierKind) => string | undefined;
  /** V8's TypeError message for a nullish receiver. */
  readonly nullishMessage: (kind: CarrierKind) => string;
  /** The answer of an arm whose value no code reads (after a throw, or a sloppy write's ignored failure). */
  readonly unread: (result: IrValueId) => IrInstr;
  /** (#7354 C2) `abort`: the run-time abort, for an answer only a built-in prototype the realm lacks holds. */
  readonly object: (result: IrValueId, abort: Abort, throwTypeError: ThrowTypeError) => IrInstr[];
  /** (#7354 F1b) A function value: the object's access, but its own `length` and `name` are read only. */
  readonly function: (result: IrValueId, throwTypeError: ThrowTypeError) => IrInstr[];
  readonly primitive: (kind: CarrierKind, result: IrValueId, throwTypeError: ThrowTypeError) => IrInstr[];
}

/** The string a once-boxed constant `key` holds, if it is one. */
export function constantKeyOf(definitions: ReadonlyMap<IrValueId, IrInstr>, key: IrValueId): string | undefined {
  const box = definitions.get(key);
  const text = box?.kind === "box" ? definitions.get(box.value) : undefined;
  return text?.kind === "string.const" ? text.value : undefined;
}

/**
 * (#7354 A1) The access's key: its constant name, or a constant number's canonical string (ToString, which is the
 * compiler's own Number::toString), then written as the key the access reads; `name` is absent for a computed key.
 */
function accessKey<T extends MemberGet | MemberSet>(
  b: MemberAccessBuilders,
  instr: T,
): { readonly name: string | undefined; readonly prelude: IrInstr[]; readonly instr: T } {
  const name = constantKeyOf(b.definitions, instr.key);
  const box = b.definitions.get(instr.key);
  const number = box?.kind === "box" ? b.definitions.get(box.value) : undefined;
  if (name !== undefined || number?.kind !== "const" || number.value.kind !== "f64")
    return { name, prelude: [], instr };
  const [text, key] = [b.fresh(), b.fresh()];
  const canonical = String(number.value.value);
  return { name: canonical, prelude: [b.text(canonical, text), carried(text, key)], instr: { ...instr, key } };
}

/** "a number", "an object". */
const article = (kind: CarrierKind) => (kind === "object" ? "an object" : `a ${kind}`);
const WRAPPER: Readonly<Partial<Record<CarrierKind, string>>> = {
  number: "Number",
  boolean: "Boolean",
  string: "String",
};

/**
 * The chain both accesses take over the once-evaluated receiver, into `result`. (#7354 C2, C2-D1) An access the realm
 * cannot answer for ANY kind the receiver may hold refuses at compile time, in one form: the access, the receiver (its
 * kind, or the kinds it may be), and what is missing, e.g. "member read 'toFixed' of a value that may be a number
 * needs Number.prototype's properties". Where some kind answers, the arm of each kind that cannot is the run-time
 * abort `js.value.unsupported`: which kind the value holds is known only then, and the abort ends the program
 * uncatchably rather than answer wrong.
 */
function memberAccess(
  b: MemberAccessBuilders,
  instr: MemberGet | MemberSet,
  access: Access,
  result: IrValueId,
): IrInstr[] {
  const kinds = b.kindsOf(instr.recv);
  const refused = kinds.filter((kind) => access.missing(kind) !== undefined);
  if (refused.length === kinds.length) {
    const receiver = kinds.length === 1 ? article(kinds[0]!) : `a value that may be ${kinds.map(article).join(" or ")}`;
    const missing = [...new Set(refused.map((kind) => access.missing(kind)!))].join(" and ");
    gap(`${access.operation} of ${receiver} needs ${missing}`);
  }
  // The TypeError does not complete; the access's unread answer only gives the arm its value.
  const throwTypeError: ThrowTypeError = (message, r) => typeErrorThen(b, message, access.unread(r));
  const abort: Abort = (r) => b.abort(instr, r);
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    if (refused.includes(kind)) return abort(r);
    switch (MEMBER_ACCESS_ARM[kind]) {
      case "type-error":
        return throwTypeError(access.nullishMessage(kind), r);
      case "object":
        return access.object(r, abort, throwTypeError);
      case "function":
        return access.function(r, throwTypeError);
      // Only this arm assumes the built-in prototypes are the specification's (the object arm is the realm's own
      // [[Get]] / [[Set]]): no Prepared program can obtain one to change it (M1, C1; the premise test pins it).
      case "primitive":
        return access.primitive(kind, r, throwTypeError);
    }
  };
  return b.kindChain(instr, instr.recv, result, arm, kinds, access.resultType);
}

/**
 * (#7354 G1) The keys V8 gives an error or an Error constructor that the specification does not: `stack` (an own
 * accessor of every error), `captureStackTrace`, `stackTraceLimit`, `prepareStackTrace`. Where a value may be an
 * error a read of one refuses by name: the realm answers the specification (absent), the engine the test runs
 * beside answers V8's, and neither answer may pass for the other.
 */
const V8_ERROR_KEYS: ReadonlySet<string> = new Set([
  "stack",
  "captureStackTrace",
  "stackTraceLimit",
  "prepareStackTrace",
]);

const STATICS = "the realm constructor's statics";

/** What the realm lacks for a read of `name` off a function value. */
function functionMissing(b: MemberAccessBuilders, name: string): string | undefined {
  if (BUILTIN_REACHABLE_KEYS.function.has(name)) return "Function.prototype's properties";
  return b.staticKeys.has(name) ? STATICS : undefined;
}

/**
 * Whether a primitive of `kind` reaches `name` on a built-in prototype the realm does not hold: its wrapper prototype's
 * keys and Object.prototype's unpopulated ones, but (#7354 W2) what a held family's prototype holds.
 */
function primitiveLacks(b: MemberAccessBuilders, kind: CarrierKind, name: string): boolean {
  const wrapper = WRAPPER_OF_PRIMITIVE[kind as keyof typeof WRAPPER_OF_PRIMITIVE];
  const reachable = BUILTIN_REACHABLE_KEYS[kind as keyof typeof BUILTIN_REACHABLE_KEYS];
  return reachable.has(name) && !(b.families.wrappers.has(`%${wrapper}%`) && heldWrapperPrototypeKey(wrapper, name));
}

/**
 * (#7354 W2) `access` of the realm's prototype object a primitive of `kind` reads through: its wrapper prototype where
 * the program holds the family, else Object.prototype (the wrapper prototype's own keys refuse, `primitiveLacks`).
 */
function throughPrototype(
  b: MemberAccessBuilders,
  kind: CarrierKind,
  access: (base: IrValueId, result: IrValueId) => IrInstr[],
  result: IrValueId,
): IrInstr[] {
  const wrapper = WRAPPER_OF_PRIMITIVE[kind as keyof typeof WRAPPER_OF_PRIMITIVE];
  const base = b.fresh();
  const id = b.families.wrappers.has(`%${wrapper}%`) ? `%${wrapper}.prototype%` : "%Object.prototype%";
  return [...b.realmIntrinsic(id, base), ...access(base, result)];
}

/** The read of the instruction's key off its once-evaluated receiver into `result`. */
export function dynamicMemberRead(b: MemberAccessBuilders, member: MemberGet, result: IrValueId): IrInstr[] {
  const { name, prelude, instr } = accessKey(b, member);
  if (name === undefined) return memberAccess(b, instr, computedAccess(b, instr), result);
  return [...prelude, ...constantRead(b, instr, name, result)];
}

/** The read of the constant key `name`. */
function constantRead(b: MemberAccessBuilders, instr: MemberGet, name: string, result: IrValueId): IrInstr[] {
  // (#7354 P1) A method the realm's Object.prototype holds: an object's or a function's read finds it through the
  // realm's [[Get]]; a primitive's wrapper prototype lacks it, and no program can change one (M1), so its read answers
  // Object.prototype's own. The value is a function object, so the function kind must be admitted.
  const method = nativeObjectPrototypeMethod(name);
  if (method !== undefined && !b.admitted.includes("function"))
    gap(`member read '${name}' in a program that creates no function value`);
  if (b.families.errors && V8_ERROR_KEYS.has(name))
    gap(`member read '${name}' (V8's own error property) where a value may be an error`);
  /** A primitive's read of a key its wrapper lacks: Object.prototype's method, or else absent. */
  const inherited = (r: IrValueId): IrInstr[] =>
    method !== undefined
      ? b.realmIntrinsic(objectPrototypeMethodId(method), r)
      : [b.intrinsic(instr, "js.value.undefined", [], r)];
  const access: Access = {
    operation: `member read '${name}'`,
    resultType: b.carrier,
    missing: (kind) => {
      // (#7354 C2) An object's data keys of Object.prototype are answered where the object's own or source-built chain
      // holds them (the object arm); only the accessor would run code the realm lacks.
      if (kind === "object")
        return OBJECT_PROTOTYPE_ACCESSOR_KEYS.has(name) ? "Object.prototype's accessor" : undefined;
      if (kind === "function") return functionMissing(b, name);
      if (MEMBER_ACCESS_ARM[kind] !== "primitive") return undefined;
      // A string's own `length` and indexed characters come with arrays (#7352).
      if (kind === "string" && (name === "length" || isArrayIndexKey(name)))
        return "its own length and index properties";
      return primitiveLacks(b, kind, name) ? `${WRAPPER[kind]}.prototype's properties` : undefined;
    },
    nullishMessage: (kind) => `Cannot read properties of ${kind} (reading '${name}')`,
    unread: (r) => b.intrinsic(instr, "js.value.undefined", [], r),
    // (#7354 C2) A key Object.prototype holds: `js.object.has` finds it only on the object's own or source-built
    // chain, which [[Get]] answers exactly; a miss means the answer is Object.prototype's, which the realm lacks
    // ((#7354 P1) but for the methods it holds, which [[Get]] finds there).
    object: (r, abort) => {
      const get = (s: IrValueId) => [realmCall("js.object.get", [instr.recv, instr.key, instr.recv], s)];
      if (!BUILTIN_REACHABLE_KEYS.object.has(name) && !unheldFamilyPrototypeKeys(objectFamilies(b.families)).has(name))
        return get(r);
      const found = b.fresh();
      return [realmCall("js.object.has", [instr.recv, instr.key], found), b.branch(found, get, abort, r, b.carrier)];
    },
    function: (r) => [realmCall("js.object.get", [instr.recv, instr.key, instr.recv], r)],
    // (#7354 W2) Where a program can obtain a prototype it can change one: the read goes through the realm's.
    primitive: (kind, r) =>
      b.families.prototypes
        ? throughPrototype(b, kind, (base, s) => [realmCall("js.object.get", [base, instr.key, instr.recv], s)], r)
        : inherited(r),
  };
  return memberAccess(b, instr, access, result);
}

/**
 * (#7354 O3) The write of the instruction's value to its key on its once-evaluated receiver, its OrdinarySet answer
 * into a value no code reads. A primitive's wrapper answers `false` for every key but an accessor's: the pristine
 * prototypes' other properties are data properties, read only or set on the receiver, which is no object. PutValue
 * ignores that failure in sloppy code and throws a TypeError in strict code. (#7354 M1, C6) An accessor key
 * (`__proto__`) calls its setter instead, which answers `undefined` for a primitive `this` in strict code too
 * (§10.1.9.2, §B.2.2.1.2), so it refuses by name until the realm holds the accessor.
 */
export function dynamicMemberWrite(b: MemberAccessBuilders, member: MemberSet): IrInstr[] {
  const { name, prelude, instr } = accessKey(b, member);
  if (name === undefined) return memberAccess(b, instr, computedAccess(b, instr), b.fresh());
  return [...prelude, ...constantWrite(b, instr, name)];
}

/**
 * (#7354 F1b, O1) PutValue of the instruction's value through OrdinarySet under `key`, into the unread `r`: OrdinarySet
 * answers `false` for a read-only data property (a function's own `length` and `name`, one `Object.defineProperty`
 * made read only, an inherited one), a setter-less accessor and (#7354 A1) a new index past an array's read-only
 * `length`; PutValue ignores that in sloppy code and throws a TypeError in strict code.
 */
function putValue(
  b: MemberAccessBuilders,
  instr: MemberSet,
  key: IrValueId,
  message: string,
  r: IrValueId,
  throwTypeError: ThrowTypeError,
): IrInstr[] {
  const ok = b.fresh();
  const write = realmCall("js.object.set", [instr.recv, key, instr.value, instr.recv], ok);
  const unread = (s: IrValueId): IrInstr => b.intrinsic(instr, "js.value.undefined", [], s);
  if (instr.sloppy === true) return [write, unread(r)];
  return [
    write,
    b.branch(
      ok,
      (s) => [unread(s)],
      (s) => throwTypeError(message, s),
      r,
      b.carrier,
    ),
  ];
}

/** The write of the constant key `name`. */
function constantWrite(b: MemberAccessBuilders, instr: MemberSet, name: string): IrInstr[] {
  const unread = (r: IrValueId): IrInstr => b.intrinsic(instr, "js.value.undefined", [], r);
  const put = (kind: "object" | "function", r: IrValueId, throwTypeError: ThrowTypeError) =>
    putValue(b, instr, instr.key, `Cannot assign to read only property '${name}' of ${kind}`, r, throwTypeError);
  const access: Access = {
    operation: `member write '${name}'`,
    // (#7354 C2) The write's value is unread, but it is the carrier so that an arm's run-time abort is its answer.
    resultType: b.carrier,
    // (#7354 F1, D4) Every key Object.prototype holds but its accessor is a writable data property, so OrdinarySet
    // creates an own property on the receiver (§10.1.9.2 step 2), as for an absent key; only an accessor's setter
    // would run code the realm lacks: Object.prototype's, and (#7354 G1) a function's Function.prototype `caller` /
    // `arguments`, whose setter throws (a write that silently landed would answer wrong).
    missing: (kind) => {
      if (MEMBER_ACCESS_ARM[kind] === "type-error") return undefined;
      if (OBJECT_PROTOTYPE_ACCESSOR_KEYS.has(name)) return "Object.prototype's accessor";
      if (kind !== "function") return undefined;
      return FUNCTION_PROTOTYPE_ACCESSOR_KEYS.has(name)
        ? "Function.prototype's accessor"
        : b.staticKeys.has(name)
          ? STATICS
          : undefined;
    },
    nullishMessage: (kind) => `Cannot set properties of ${kind} (setting '${name}')`,
    unread,
    object: (r, _abort, throwTypeError) => put("object", r, throwTypeError),
    function: (r, throwTypeError) => put("function", r, throwTypeError),
    primitive: (kind, r, throwTypeError) => {
      const absent = (s: IrValueId) =>
        instr.sloppy === true ? [unread(s)] : throwTypeError(`Cannot create property '${name}' on ${kind}`, s);
      if (!b.families.prototypes) return absent(r);
      // (#7354 W2) A key the prototype chain holds may be a setter or read only: the run-time abort.
      const found = (base: IrValueId, s: IrValueId): IrInstr[] => {
        const has = b.fresh();
        return [
          realmCall("js.object.has", [base, instr.key], has),
          b.branch(has, (t) => b.abort(instr, t), absent, s, b.carrier),
        ];
      };
      return throughPrototype(b, kind, found, r);
    },
  };
  return memberAccess(b, instr, access, b.fresh());
}

/**
 * (#7354 A1) A read or write whose key is computed: the subset arrays need, which L0c's general ToPropertyKey replaces.
 * An object or a function receiver is served, a primitive's (its wrapper's keys, a string's characters) is the run-time
 * abort. The key, by its kind:
 * - a string the realm's chain holds is read or written there. One it does not hold may be a built-in key the realm
 *   lacks (`"map"`, an unheld static): the run-time abort, but for a canonical numeric string (ToString(ToNumber(k)) is
 *   k: `"1"`, `"NaN"`), which no built-in key is, read as absent or written. An object's write is the constant key's
 *   rule instead: OrdinarySet, but for `"__proto__"`, whose setter the realm lacks (the run-time abort);
 * - any other primitive is ToString'd by the program (a number's canonical string, `"true"`, `"null"`: never a built-in
 *   key), then read or written;
 * - an object or a function is the run-time abort: its ToPrimitive is observable, in an order not written here.
 */
function computedAccess(b: MemberAccessBuilders, instr: MemberGet | MemberSet): Access {
  const write = instr.kind === "dyn.member_set";
  const unread = (r: IrValueId): IrInstr => b.intrinsic(instr, "js.value.undefined", [], r);
  const keyed = (receiver: "object" | "function", r: IrValueId, throwTypeError: ThrowTypeError): IrInstr[] => {
    const access = (key: IrValueId, s: IrValueId): IrInstr[] =>
      instr.kind === "dyn.member_set"
        ? putValue(b, instr, key, `Cannot assign to read only property of ${receiver}`, s, throwTypeError)
        : [realmCall("js.object.get", [instr.recv, key, instr.recv], s)];
    // Each arm reads the key as the one kind it holds there, so a conversion of it is that kind's alone.
    const byKind = (kind: CarrierKind, s: IrValueId): IrInstr[] => {
      if (MEMBER_ACCESS_ARM[kind] === "object" || MEMBER_ACCESS_ARM[kind] === "function") return b.abort(instr, s);
      const key = b.fresh();
      b.kinds.learn(key, [kind]);
      const narrowed = carried(instr.key, key);
      if (kind === "string" && write && receiver === "object")
        return [narrowed, ...unlessProto(b, instr, key, (t) => access(key, t), s)];
      if (kind === "string") {
        const found = b.fresh();
        const absent = (t: IrValueId) =>
          canonicalNumeric(b, instr, key, (u) => (write ? access(key, u) : [unread(u)]), t);
        return [
          narrowed,
          realmCall("js.object.has", [instr.recv, key], found),
          b.branch(found, (t) => access(key, t), absent, s, b.carrier),
        ];
      }
      const [text, converted] = [b.fresh(), b.fresh()];
      return [narrowed, ...b.stringOf(instr, key, text), carried(text, converted), ...access(converted, s)];
    };
    return b.kindChain(instr, instr.key, r, byKind, b.kindsOf(instr.key), b.carrier);
  };
  return {
    operation: `member ${write ? "write" : "read"} with a computed key`,
    resultType: b.carrier,
    missing: () => undefined,
    nullishMessage: (kind) => `Cannot ${write ? "set" : "read"} properties of ${kind}`,
    unread,
    object: (r, _abort, throwTypeError) => keyed("object", r, throwTypeError),
    function: (r, throwTypeError) => keyed("function", r, throwTypeError),
    primitive: (_kind, r) => b.abort(instr, r),
  };
}

/** `then` unless the string key is `"__proto__"` (Object.prototype's accessor, which the realm lacks), else the abort. */
function unlessProto(
  b: MemberAccessBuilders,
  instr: MemberGet | MemberSet,
  key: IrValueId,
  then: (result: IrValueId) => IrInstr[],
  result: IrValueId,
): IrInstr[] {
  const guarded = [...OBJECT_PROTOTYPE_ACCESSOR_KEYS].reduceRight(
    (otherwise: (r: IrValueId) => IrInstr[], name) =>
      (r: IrValueId): IrInstr[] => {
        const [text, accessor, same] = [b.fresh(), b.fresh(), b.fresh()];
        return [
          b.text(name, text),
          carried(text, accessor),
          b.intrinsic(instr, "js.value.strict_eq", [accessor, key], same),
          b.branch(same, (s) => b.abort(instr, s), otherwise, r, b.carrier),
        ];
      },
    then,
  );
  return guarded(result);
}

/** `then` where the string key is a canonical numeric string (ToString(ToNumber(key)) is key), else the abort. */
function canonicalNumeric(
  b: MemberAccessBuilders,
  instr: MemberGet | MemberSet,
  key: IrValueId,
  then: (result: IrValueId) => IrInstr[],
  result: IrValueId,
): IrInstr[] {
  const [number, boxed, text, round, same] = [b.fresh(), b.fresh(), b.fresh(), b.fresh(), b.fresh()];
  b.kinds.learn(boxed, ["number"]);
  return [
    ...b.toNumber(instr, key, number),
    b.intrinsic(instr, "js.number.box", [number], boxed),
    ...b.stringOf(instr, boxed, text),
    carried(text, round),
    b.intrinsic(instr, "js.value.strict_eq", [round, key], same),
    b.branch(same, then, (s) => b.abort(instr, s), result, b.carrier),
  ];
}
