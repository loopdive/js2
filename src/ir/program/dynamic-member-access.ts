// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4, O3, M1) A member read or write of the dynamic value with a constant key, as one chain over the receiver's
 * kinds (`MEMBER_ACCESS_ARM`): a TypeError for `undefined` / `null`, the realm's [[Get]] or [[Set]] for an object
 * ((#7354 G1) an error included), and for a primitive what its pristine wrapper answers. A key a built-in prototype
 * holds (the realm's prototypes do not hold it yet) or a computed key refuses by name.
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
} from "./builtin-prototype-keys.js";
import { MEMBER_ACCESS_ARM, type CarrierKind } from "./dynamic-value-kinds.js";
import { realmCall, typeErrorThen, type TypeErrorBuilders } from "./dynamic-realm-calls.js";
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
  /** (#7354 G1) A value may be an error: the program holds the Error family (`holdsErrors`). */
  readonly errors: boolean;
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

/** The access's constant key; any other key refuses by name. */
function constantKey(b: MemberAccessBuilders, instr: MemberGet | MemberSet): string {
  return constantKeyOf(b.definitions, instr.key) ?? gap(`${instr.kind} with a computed key`);
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

/** The read of the instruction's key off its once-evaluated receiver into `result`. */
export function dynamicMemberRead(b: MemberAccessBuilders, instr: MemberGet, result: IrValueId): IrInstr[] {
  const name = constantKey(b, instr);
  // (#7354 P1) A method the realm's Object.prototype holds: an object's or a function's read finds it through the
  // realm's [[Get]]; a primitive's wrapper prototype lacks it, and no program can change one (M1), so its read answers
  // Object.prototype's own. The value is a function object, so the function kind must be admitted.
  const method = nativeObjectPrototypeMethod(name);
  if (method !== undefined && !b.admitted.includes("function"))
    gap(`member read '${name}' in a program that creates no function value`);
  if (b.errors && V8_ERROR_KEYS.has(name))
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
      if (kind === "function")
        return BUILTIN_REACHABLE_KEYS.function.has(name) ? "Function.prototype's properties" : undefined;
      if (MEMBER_ACCESS_ARM[kind] !== "primitive") return undefined;
      const reachable = BUILTIN_REACHABLE_KEYS[kind as keyof typeof BUILTIN_REACHABLE_KEYS];
      // A string's own `length` and indexed characters come with arrays (#7352).
      if (kind === "string" && (name === "length" || isArrayIndexKey(name)))
        return "its own length and index properties";
      return reachable.has(name) ? `${WRAPPER[kind]}.prototype's properties` : undefined;
    },
    nullishMessage: (kind) => `Cannot read properties of ${kind} (reading '${name}')`,
    unread: (r) => b.intrinsic(instr, "js.value.undefined", [], r),
    // (#7354 C2) A key Object.prototype holds: `js.object.has` finds it only on the object's own or source-built
    // chain, which [[Get]] answers exactly; a miss means the answer is Object.prototype's, which the realm lacks
    // ((#7354 P1) but for the methods it holds, which [[Get]] finds there).
    object: (r, abort) => {
      const get = (s: IrValueId) => [realmCall("js.object.get", [instr.recv, instr.key, instr.recv], s)];
      if (!BUILTIN_REACHABLE_KEYS.object.has(name)) return get(r);
      const found = b.fresh();
      return [realmCall("js.object.has", [instr.recv, instr.key], found), b.branch(found, get, abort, r, b.carrier)];
    },
    function: (r) => [realmCall("js.object.get", [instr.recv, instr.key, instr.recv], r)],
    primitive: (_kind, r) => inherited(r),
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
export function dynamicMemberWrite(b: MemberAccessBuilders, instr: MemberSet): IrInstr[] {
  const name = constantKey(b, instr);
  const unread = (r: IrValueId): IrInstr => b.intrinsic(instr, "js.value.undefined", [], r);
  const set = (): { readonly ok: IrValueId; readonly instr: IrInstr } => {
    const ok = b.fresh();
    return { ok, instr: realmCall("js.object.set", [instr.recv, instr.key, instr.value, instr.recv], ok) };
  };
  // (#7354 F1b, O1) OrdinarySet answers `false` for a read-only data property (a function's own `length` and `name`,
  // one `Object.defineProperty` made read only, an inherited one) and a setter-less accessor: PutValue ignores that in
  // sloppy code and throws a TypeError in strict code.
  const putValue = (kind: "object" | "function", r: IrValueId, throwTypeError: ThrowTypeError): IrInstr[] => {
    const { ok, instr: write } = set();
    if (instr.sloppy === true) return [write, unread(r)];
    const readOnly = (s: IrValueId) => throwTypeError(`Cannot assign to read only property '${name}' of ${kind}`, s);
    return [write, b.branch(ok, (s) => [unread(s)], readOnly, r, b.carrier)];
  };
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
      return kind === "function" && FUNCTION_PROTOTYPE_ACCESSOR_KEYS.has(name)
        ? "Function.prototype's accessor"
        : undefined;
    },
    nullishMessage: (kind) => `Cannot set properties of ${kind} (setting '${name}')`,
    unread,
    object: (r, _abort, throwTypeError) => putValue("object", r, throwTypeError),
    function: (r, throwTypeError) => putValue("function", r, throwTypeError),
    primitive: (kind, r, throwTypeError) =>
      instr.sloppy === true ? [unread(r)] : throwTypeError(`Cannot create property '${name}' on ${kind}`, r),
  };
  return memberAccess(b, instr, access, b.fresh());
}
