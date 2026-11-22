// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4, O3, M1, M2) A member read or write of the dynamic value with a constant key, as one chain over the
 * receiver's kinds (`MEMBER_ACCESS_ARM`): a TypeError for `undefined` / `null`, the realm's [[Get]] or [[Set]] for an
 * object, the realm's own fields for an error, and for a primitive what its pristine wrapper answers. A key a built-in
 * prototype holds (the realm's prototypes do not hold it yet), a write to an error, or a computed key refuses by name.
 */
import type { IntrinsicId } from "../core/intrinsics.js";
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import { BUILTIN_REACHABLE_KEYS, OBJECT_PROTOTYPE_ACCESSOR_KEYS, isArrayIndexKey } from "./builtin-prototype-keys.js";
import { MEMBER_ACCESS_ARM, type CarrierKind } from "./dynamic-value-kinds.js";
import { realmCall, typeErrorThen, type TypeErrorBuilders } from "./dynamic-realm-calls.js";
import { gap } from "./dynamic-value-gap.js";
import type { ERROR_FIELD } from "./dynamic-value-chains.js";

/** The legalization builders a member access is written with. */
export interface MemberAccessBuilders extends TypeErrorBuilders {
  readonly definitions: ReadonlyMap<IrValueId, IrInstr>;
  readonly intrinsic: (
    instr: IrInstr,
    id: IntrinsicId,
    args: readonly IrValueId[],
    result?: IrValueId | null,
  ) => IrInstr;
  readonly errorField: (value: IrValueId, field: keyof typeof ERROR_FIELD, result: IrValueId) => IrInstr[];
  /** (#7354 C2) The run-time abort, a carrier answer. */
  readonly abort: (instr: IrInstr, result: IrValueId) => IrInstr[];
  readonly kindsOf: (value: IrValueId) => readonly CarrierKind[];
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
  readonly error: (result: IrValueId) => IrInstr[];
  readonly primitive: (kind: CarrierKind, result: IrValueId, throwTypeError: ThrowTypeError) => IrInstr[];
}

/** The string a once-boxed constant key holds; any other key refuses by name. */
function constantKey(b: MemberAccessBuilders, instr: MemberGet | MemberSet): string {
  const box = b.definitions.get(instr.key);
  const text = box?.kind === "box" ? b.definitions.get(box.value) : undefined;
  return text?.kind === "string.const" ? text.value : gap(`${instr.kind} with a computed key`);
}

/** "a number", "an Error". */
const article = (kind: CarrierKind) => (kind === "error" ? "an Error" : kind === "object" ? "an object" : `a ${kind}`);
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
      case "error":
        return access.error(r);
      // Only this arm assumes the built-in prototypes are the specification's (the object arm is the realm's own
      // [[Get]] / [[Set]]): no Prepared program can obtain one to change it (M1, C1; the premise test pins it).
      case "primitive":
        return access.primitive(kind, r, throwTypeError);
    }
  };
  return b.kindChain(instr, instr.recv, result, arm, kinds, access.resultType);
}

/**
 * The keys an error's read answers from its own fields (§20.5.1.1: `message` is its one own property; `name` is
 * Error.prototype's, and the realm's TypeError holds its own). `constructor`, `toString` and V8's own `stack` need
 * Error.prototype's other properties; every other key is absent unless Object.prototype holds it.
 */
const ERROR_OWN_KEYS: ReadonlySet<string> = new Set(["name", "message"]);
const ERROR_PROTOTYPE_KEYS: ReadonlySet<string> = new Set(["constructor", "toString", "stack"]);

/** The read of the instruction's key off its once-evaluated receiver into `result`. */
export function dynamicMemberRead(b: MemberAccessBuilders, instr: MemberGet, result: IrValueId): IrInstr[] {
  const name = constantKey(b, instr);
  const access: Access = {
    operation: `member read '${name}'`,
    resultType: b.carrier,
    missing: (kind) => {
      // An error's prototypes are built-in ones, so every key they hold is missing, Object.prototype's included.
      if (kind === "error")
        return ERROR_PROTOTYPE_KEYS.has(name) || BUILTIN_REACHABLE_KEYS.object.has(name)
          ? "Error.prototype's properties"
          : undefined;
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
    // chain, which [[Get]] answers exactly; a miss means the answer is Object.prototype's, which the realm lacks.
    object: (r, abort) => {
      const get = (s: IrValueId) => [realmCall("js.object.get", [instr.recv, instr.key, instr.recv], s)];
      if (!BUILTIN_REACHABLE_KEYS.object.has(name)) return get(r);
      const found = b.fresh();
      return [realmCall("js.object.has", [instr.recv, instr.key], found), b.branch(found, get, abort, r, b.carrier)];
    },
    function: (r) => [realmCall("js.object.get", [instr.recv, instr.key, instr.recv], r)],
    error: (r) =>
      ERROR_OWN_KEYS.has(name)
        ? b.errorField(instr.recv, name as keyof typeof ERROR_FIELD, r)
        : [b.intrinsic(instr, "js.value.undefined", [], r)],
    primitive: (_kind, r) => [b.intrinsic(instr, "js.value.undefined", [], r)],
  };
  return memberAccess(b, instr, access, result);
}

/**
 * (#7354 O3) The write of the instruction's value to its key on its once-evaluated receiver, its OrdinarySet answer
 * into a value no code reads. A primitive's wrapper answers `false` for every key but an accessor's: the pristine
 * prototypes' other properties are data properties, read only or set on the receiver, which is no object. PutValue
 * ignores that failure in sloppy code and throws a TypeError in strict code. (#7354 M1, C6) An accessor key
 * (`__proto__`) calls its setter instead, which answers `undefined` for a primitive `this` in strict code too
 * (§10.1.9.2, §B.2.2.1.2), so it refuses by name until the realm holds the accessor. (M2) The realm's error has no
 * property storage for a write.
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
    // The realm's error has no property storage a write could land in. (#7354 F1, D4) Every other key Object.prototype
    // holds is a writable data property, so OrdinarySet creates an own property on the receiver (§10.1.9.2 step 2),
    // as for an absent key; only its accessor's setter would run code the realm lacks.
    missing: (kind) =>
      kind === "error"
        ? "property storage on the realm's error"
        : MEMBER_ACCESS_ARM[kind] !== "type-error" && OBJECT_PROTOTYPE_ACCESSOR_KEYS.has(name)
          ? "Object.prototype's accessor"
          : undefined,
    nullishMessage: (kind) => `Cannot set properties of ${kind} (setting '${name}')`,
    unread,
    object: (r, _abort, throwTypeError) => putValue("object", r, throwTypeError),
    function: (r, throwTypeError) => putValue("function", r, throwTypeError),
    // Refused above (`missing`): a write never reaches the error arm.
    error: () => [],
    primitive: (kind, r, throwTypeError) =>
      instr.sloppy === true ? [unread(r)] : throwTypeError(`Cannot create property '${name}' on ${kind}`, r),
  };
  return memberAccess(b, instr, access, b.fresh());
}
