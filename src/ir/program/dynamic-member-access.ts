// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4, O3, M1) A member read, write or (#7471) delete of the dynamic value with a constant key, as one chain over
 * the receiver's kinds (`MEMBER_ACCESS_ARM`): a TypeError for `undefined` / `null`, the realm's [[Get]], [[Set]] or
 * [[Delete]] for an object ((#7354 G1) an error included), and for a primitive what its pristine wrapper answers. A key
 * a built-in prototype holds (the realm's prototypes do not hold it yet) or a computed key refuses by name.
 *
 * (#7561) Where the program can obtain a wrapper prototype (`ProgramObjects.wrappers`) it can change it, so a
 * primitive of that kind reads through the realm's prototype (§7.3.2 GetV: [[Get]] with the primitive as receiver),
 * and a write meeting a key on it is the run-time abort (§10.1.9.2 step 2.b, a setter's call, is #7350 B3b-2). A
 * String object's index keys are virtual and the realm lacks them (#7350 B3c): where one may exist, an array-index key
 * on an object is the run-time abort.
 */
import type { IntrinsicId } from "../core/intrinsics.js";
import type { IrInstr, IrValueId } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import {
  BUILTIN_REACHABLE_KEYS,
  identityOnlyKeyRefusal,
  OBJECT_PROTOTYPE_ACCESSOR_KEYS,
  functionOwnKeyGap,
  isArrayIndexKey,
  nativeObjectPrototypeMethod,
  objectPrototypeMethodId,
  WRAPPER_OF_PRIMITIVE,
} from "./builtin-prototype-keys.js";
import type { NativeWrapperConstructor } from "../../runtime/contracts/native-realm-catalog.js";
import { MEMBER_ACCESS_ARM, article, type CarrierKind } from "./dynamic-value-kinds.js";
import { BOOLEAN, booleanConst } from "./dynamic-value-chains.js";
import { realmCall, realmConstructorOf, typeErrorThen, type TypeErrorBuilders } from "./dynamic-realm-calls.js";
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
  /** (#7354 C2) The run-time abort with its (#7486) reason, a carrier answer. */
  readonly abort: (instr: IrInstr, reason: string, result: IrValueId) => IrInstr[];
  readonly kindsOf: (value: IrValueId) => readonly CarrierKind[];
  readonly admitted: readonly CarrierKind[];
  /** (#7354 P1, G1) The realm's built-in function object `id` into `result`. */
  readonly realmIntrinsic: (id: string, result: IrValueId) => IrInstr[];
  /** (#7354 G1) A value may be an error: the program holds the Error family (`holdsFamily`). */
  readonly errors: boolean;
  /** (#7561) The wrapper kinds whose prototype the program can obtain (`ProgramObjects.wrappers`). */
  readonly wrappers: ReadonlySet<NativeWrapperConstructor>;
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
type Call = Extract<IrInstr, { kind: "call" }>;

/**
 * The access an instruction makes: the instruction (its run-time abort and chain are its), the once-evaluated receiver
 * and key, and the name a computed-key refusal gives it.
 */
interface MemberSite {
  readonly instr: IrInstr;
  readonly recv: IrValueId;
  readonly key: IrValueId;
  readonly label: string;
}
const memberSite = (instr: MemberGet | MemberSet): MemberSite => ({
  instr,
  recv: instr.recv,
  key: instr.key,
  label: instr.kind,
});

/** A thrown TypeError with `message` (`typeError`), the arm's unread answer into `result`. */
type ThrowTypeError = (message: string, result: IrValueId) => IrInstr[];
/** The run-time abort with its (#7486) reason, the access's unread answer into `result`. */
type Abort = (reason: string, result: IrValueId) => IrInstr[];

/** What sets a read, a write and a delete apart past the receiver chain they share. */
interface Access {
  /** The access as a refusal names it ("member read 'k'"). */
  readonly operation: string;
  readonly resultType: IrType;
  /** What the realm lacks to answer the access for a receiver of `kind`, if it lacks something. */
  readonly missing: (kind: CarrierKind) => string | undefined;
  /** V8's TypeError message for a nullish receiver. */
  readonly nullishMessage: (kind: CarrierKind) => string;
  /** The answer of an arm whose value no code reads (after a throw or the abort, or a sloppy write's ignored failure). */
  readonly unread: (result: IrValueId) => IrInstr;
  /** (#7354 C2) `abort`: the run-time abort, for an answer only a built-in prototype the realm lacks holds. */
  readonly object: (result: IrValueId, abort: Abort, throwTypeError: ThrowTypeError) => IrInstr[];
  /** (#7354 F1b) A function value: the object's access, but its own `length` and `name` are read only. */
  readonly function: (result: IrValueId, throwTypeError: ThrowTypeError) => IrInstr[];
  readonly primitive: (kind: CarrierKind, result: IrValueId, throwTypeError: ThrowTypeError) => IrInstr[];
}

/** (#7561) The string a constant call argument holds: a once-boxed constant, or its carrier. */
export function constantArgumentOf(definitions: ReadonlyMap<IrValueId, IrInstr>, value: IrValueId): string | undefined {
  const definition = definitions.get(value);
  return constantKeyOf(definitions, definition?.kind === "coerce.to_externref" ? definition.value : value);
}

/** The string a once-boxed constant `key` holds, if it is one. */
export function constantKeyOf(definitions: ReadonlyMap<IrValueId, IrInstr>, key: IrValueId): string | undefined {
  const box = definitions.get(key);
  const text = box?.kind === "box" ? definitions.get(box.value) : undefined;
  return text?.kind === "string.const" ? text.value : undefined;
}

/**
 * The access's constant key; any other key refuses by name. (#7350 B3a) So does a key the receiver, a pristine realm
 * constructor the catalog models only as an identity (`String.prototype`), does not own: the realm lacks it, and the
 * kernel would abort the access at run time.
 */
function constantKey(b: MemberAccessBuilders, site: MemberSite): string {
  const key = constantKeyOf(b.definitions, site.key) ?? gap(`${site.label} with a computed key`);
  const ctor = realmConstructorOf(site.recv, b.definitions);
  const miss = ctor === undefined ? undefined : identityOnlyKeyRefusal(ctor, key);
  return miss === undefined ? key : gap(miss);
}

/** (#7561) The realm prototype a primitive of `kind` reads through, where the program can obtain it. */
function heldPrototype(b: MemberAccessBuilders, kind: CarrierKind): string | undefined {
  const wrapper = WRAPPER_OF_PRIMITIVE[kind as keyof typeof WRAPPER_OF_PRIMITIVE];
  return wrapper !== undefined && b.wrappers.has(wrapper) ? `%${wrapper}.prototype%` : undefined;
}

/** (#7561) An array-index key on an object that may be a String object, whose index properties the realm lacks. */
const stringObjectIndex = (b: MemberAccessBuilders, name: string): boolean =>
  b.wrappers.has("String") && isArrayIndexKey(name);
/** The (#7486) reason of that access's run-time abort. */
const stringObjectIndexReason = (operation: string) =>
  `${operation} of an object that may be a String object: needs its index properties`;

/**
 * The access a receiver of one of `kinds` cannot have, and what the realm lacks for it: "member read 'toFixed' of a
 * value that may be a number or a string needs Number.prototype's properties and String.prototype's properties".
 */
function refusal(access: Access, kinds: readonly CarrierKind[]): string {
  const receiver = kinds.length === 1 ? article(kinds[0]!) : `a value that may be ${kinds.map(article).join(" or ")}`;
  const missing = [...new Set(kinds.map((kind) => access.missing(kind)!))].join(" and ");
  return `${access.operation} of ${receiver} needs ${missing}`;
}
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
function memberAccess(b: MemberAccessBuilders, site: MemberSite, access: Access, result: IrValueId): IrInstr[] {
  const kinds = b.kindsOf(site.recv);
  const refused = kinds.filter((kind) => access.missing(kind) !== undefined);
  if (refused.length === kinds.length) gap(refusal(access, kinds));
  // Neither the TypeError nor the abort completes; the access's unread answer only gives the arm its value.
  const throwTypeError: ThrowTypeError = (message, r) => typeErrorThen(b, message, access.unread(r));
  const abort: Abort = (reason, r) => [...b.abort(site.instr, reason, b.fresh()), access.unread(r)];
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    if (refused.includes(kind)) return abort(refusal(access, [kind]), r);
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
  return b.kindChain(site.instr, site.recv, result, arm, kinds, access.resultType);
}

/** A string's own `length` and indexed characters, which come with arrays (#7352). */
const stringOwnKey = (kind: CarrierKind, name: string): string | undefined =>
  kind === "string" && (name === "length" || isArrayIndexKey(name)) ? "its own length and index properties" : undefined;

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
  const site = memberSite(instr);
  const name = constantKey(b, site);
  // (#7561) A wrapper constructor's `prototype` is read only and non-configurable: the realm's prototype object.
  const ctor = realmConstructorOf(instr.recv, b.definitions);
  if (ctor?.family === "wrapper" && name === "prototype" && b.wrappers.has(ctor.name))
    return b.realmIntrinsic(`%${ctor.name}.prototype%`, result);
  // (#7354 P1) A method the realm's Object.prototype holds: an object's or a function's read finds it through the
  // realm's [[Get]]; a primitive's wrapper prototype lacks it, and no program can change one (M1), so its read answers
  // Object.prototype's own. The value is a function object, so the function kind must be admitted.
  const method = nativeObjectPrototypeMethod(name);
  if (method !== undefined && !b.admitted.includes("function"))
    gap(`member read '${name}' in a program that creates no function value`);
  if (b.errors && V8_ERROR_KEYS.has(name))
    gap(`member read '${name}' (V8's own error property) where a value may be an error`);
  // (#7354 C2) [[Get]] on the chain from `base`: a key Object.prototype holds is found by `js.object.has` only on the
  // object's own or source-built chain, which [[Get]] answers exactly; a miss means the answer is Object.prototype's,
  // which the realm lacks ((#7354 P1) but for the methods it holds, which [[Get]] finds there).
  const objectRead = (base: IrValueId, kind: CarrierKind, r: IrValueId, abort: Abort): IrInstr[] => {
    const get = (s: IrValueId) => [realmCall("js.object.get", [base, instr.key, instr.recv], s)];
    if (!BUILTIN_REACHABLE_KEYS.object.has(name)) return get(r);
    const found = b.fresh();
    const absent = (s: IrValueId) =>
      abort(`member read '${name}' of ${article(kind)} without it: Object.prototype's own, which the realm lacks`, s);
    return [realmCall("js.object.has", [base, instr.key], found), b.branch(found, get, absent, r, b.carrier)];
  };
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
        return (
          functionOwnKeyGap(name) ??
          (BUILTIN_REACHABLE_KEYS.function.has(name) ? "Function.prototype's properties" : undefined)
        );
      if (MEMBER_ACCESS_ARM[kind] !== "primitive") return undefined;
      const reachable = BUILTIN_REACHABLE_KEYS[kind as keyof typeof BUILTIN_REACHABLE_KEYS];
      return (
        stringOwnKey(kind, name) ??
        (reachable.has(name) && heldPrototype(b, kind) === undefined
          ? `${WRAPPER[kind]}.prototype's properties`
          : undefined)
      );
    },
    nullishMessage: (kind) => `Cannot read properties of ${kind} (reading '${name}')`,
    unread: (r) => b.intrinsic(instr, "js.value.undefined", [], r),
    object: (r, abort) =>
      stringObjectIndex(b, name)
        ? abort(stringObjectIndexReason(access.operation), r)
        : objectRead(instr.recv, "object", r, abort),
    function: (r) => [realmCall("js.object.get", [instr.recv, instr.key, instr.recv], r)],
    // (#7561) [[Get]] on the held prototype, with the primitive as receiver.
    primitive: (kind, r) => {
      const prototype = heldPrototype(b, kind);
      if (prototype === undefined) return inherited(r);
      const base = b.fresh();
      return [
        ...b.realmIntrinsic(prototype, base),
        ...objectRead(base, kind, r, (reason, s) => b.abort(instr, reason, s)),
      ];
    },
  };
  return memberAccess(b, site, access, result);
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
  const site = memberSite(instr);
  const name = constantKey(b, site);
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
    resultType: b.carrier,
    // (#7354 F1, D4) Every key Object.prototype holds but its accessor is a writable data property, so OrdinarySet
    // creates an own property on the receiver (§10.1.9.2 step 2), as for an absent key; only an accessor's setter
    // would run code the realm lacks: Object.prototype's. (#7489) A function's `caller` is the realm's: a sloppy
    // function's own read-only one, else Function.prototype's %ThrowTypeError% setter; its `arguments` refuses.
    missing: (kind) => {
      if (MEMBER_ACCESS_ARM[kind] === "type-error") return undefined;
      if (OBJECT_PROTOTYPE_ACCESSOR_KEYS.has(name)) return "Object.prototype's accessor";
      return kind === "function" ? functionOwnKeyGap(name) : undefined;
    },
    nullishMessage: (kind) => `Cannot set properties of ${kind} (setting '${name}')`,
    unread,
    object: (r, abort, throwTypeError) =>
      stringObjectIndex(b, name)
        ? abort(stringObjectIndexReason(access.operation), r)
        : putValue("object", r, throwTypeError),
    function: (r, throwTypeError) => putValue("function", r, throwTypeError),
    primitive: (kind, r, throwTypeError) => {
      const absent = (s: IrValueId) =>
        instr.sloppy === true ? [unread(s)] : throwTypeError(`Cannot create property '${name}' on ${kind}`, s);
      const prototype = heldPrototype(b, kind);
      if (prototype === undefined) return absent(r);
      // (#7561) A key on the held prototype's chain may be a setter or read only (#7350 B3b-2): the run-time abort.
      const [base, found] = [b.fresh(), b.fresh()];
      const held = (s: IrValueId) =>
        b.abort(instr, `${access.operation} of ${article(kind)} whose prototype chain holds the key`, s);
      return [
        ...b.realmIntrinsic(prototype, base),
        realmCall("js.object.has", [base, instr.key], found),
        b.branch(found, held, absent, r, b.carrier),
      ];
    },
  };
  return memberAccess(b, site, access, b.fresh());
}

/**
 * (#7471) `delete <recv>.<key>` (§13.5.1.2): the [[Delete]] of the key on the call's once-evaluated receiver, its
 * Boolean into the call's result. An object's or a function's is the realm's OrdinaryDelete; in strict code a `false`
 * answer is a TypeError. A number's or a Boolean's wrapper owns no property, and a string's owns only its `length` and
 * indices, so every other key answers `true`. (#7489) A sloppy function's own `caller` is the realm's, so its delete is
 * OrdinaryDelete too; its own `arguments` is not (`functionOwnKeyGap`), so the function arm lacks it, as the read and
 * write arms' does.
 */
export function dynamicMemberDelete(b: MemberAccessBuilders, instr: Call, strict: boolean): IrInstr[] {
  const [recv, key] = instr.args as [IrValueId, IrValueId];
  const site: MemberSite = { instr, recv, key, label: instr.target.name };
  const name = constantKey(b, site);
  // (#7561) The realm holds a wrapper constructor's `prototype` only where the program reads it.
  const ctor = realmConstructorOf(recv, b.definitions);
  if (ctor?.family === "wrapper" && name === "prototype") gap(`member delete 'prototype' of ${ctor.name}`);
  const ordinaryDelete = (kind: "object" | "function", r: IrValueId, throwTypeError: ThrowTypeError): IrInstr[] => {
    if (!strict) return [realmCall("js.object.delete", [recv, key], r)];
    const deleted = b.fresh();
    const refused = (s: IrValueId) => throwTypeError(`Cannot delete property '${name}' of ${kind}`, s);
    return [
      realmCall("js.object.delete", [recv, key], deleted),
      b.branch(deleted, (s) => [booleanConst(true, s)], refused, r, BOOLEAN),
    ];
  };
  const access: Access = {
    operation: `member delete '${name}'`,
    resultType: BOOLEAN,
    missing: (kind) => (kind === "function" ? functionOwnKeyGap(name) : undefined) ?? stringOwnKey(kind, name),
    nullishMessage: () => "Cannot convert undefined or null to object",
    unread: (r) => booleanConst(false, r),
    object: (r, abort, throwTypeError) =>
      stringObjectIndex(b, name)
        ? abort(stringObjectIndexReason(access.operation), r)
        : ordinaryDelete("object", r, throwTypeError),
    function: (r, throwTypeError) => ordinaryDelete("function", r, throwTypeError),
    primitive: (_kind, r) => [booleanConst(true, r)],
  };
  return memberAccess(b, site, access, instr.result!);
}
