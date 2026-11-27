// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7354 O4, O3, M1) A member read or write of the dynamic value with a constant key, as one chain over the receiver's
 * kinds (`MEMBER_ACCESS_ARM`): a TypeError for `undefined` / `null`, the realm's [[Get]] or [[Set]] for an object
 * ((#7354 G1) an error included), and for a primitive what its pristine wrapper answers. A key a built-in prototype
 * holds (the realm's prototypes do not hold it yet) or a computed key refuses by name.
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
  FUNCTION_PROTOTYPE_ACCESSOR_KEYS,
  identityOnlyKeyRefusal,
  OBJECT_PROTOTYPE_ACCESSOR_KEYS,
  isArrayIndexKey,
  nativeObjectPrototypeMethod,
  objectPrototypeMethodId,
  WRAPPER_OF_PRIMITIVE,
} from "./builtin-prototype-keys.js";
import type { NativeWrapperConstructor } from "../../runtime/contracts/native-realm-catalog.js";
import { MEMBER_ACCESS_ARM, type CarrierKind } from "./dynamic-value-kinds.js";
import { realmCall, realmConstructorOf, typeErrorThen, type TypeErrorBuilders } from "./dynamic-realm-calls.js";
import { gap } from "./dynamic-value-gap.js";
import { carried } from "./dynamic-value-types.js";

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
 * The access's constant key: a once-boxed string, or (#7352) a once-boxed number constant as its canonical string
 * (Number::toString, the compiler's own), which is then the key the access reads; any other key refuses by name.
 * (#7350 B3a) So does a key the receiver, a pristine realm constructor the catalog models only as an identity
 * (`String.from`), does not own: the realm lacks it, and the kernel would abort the access at run time.
 */
function constantKey<T extends MemberGet | MemberSet>(
  b: MemberAccessBuilders,
  member: T,
): { readonly name: string; readonly prelude: IrInstr[]; readonly instr: T } {
  const box = b.definitions.get(member.key);
  const number = box?.kind === "box" ? b.definitions.get(box.value) : undefined;
  const canonical = number?.kind === "const" && number.value.kind === "f64" ? String(number.value.value) : undefined;
  const name = constantKeyOf(b.definitions, member.key) ?? canonical ?? gap(`${member.kind} with a computed key`);
  const ctor = realmConstructorOf(member.recv, b.definitions);
  const miss = ctor === undefined ? undefined : identityOnlyKeyRefusal(ctor, name);
  if (miss !== undefined) gap(miss);
  if (canonical === undefined) return { name, prelude: [], instr: member };
  const [text, key] = [b.fresh(), b.fresh()];
  return { name, prelude: [b.text(name, text), carried(text, key)], instr: { ...member, key } };
}

/** (#7561) The realm prototype a primitive of `kind` reads through, where the program can obtain it. */
function heldPrototype(b: MemberAccessBuilders, kind: CarrierKind): string | undefined {
  const wrapper = WRAPPER_OF_PRIMITIVE[kind as keyof typeof WRAPPER_OF_PRIMITIVE];
  return wrapper !== undefined && b.wrappers.has(wrapper) ? `%${wrapper}.prototype%` : undefined;
}

/** (#7561) An array-index key on an object that may be a String object, whose index properties the realm lacks. */
const stringObjectIndex = (b: MemberAccessBuilders, name: string): boolean =>
  b.wrappers.has("String") && isArrayIndexKey(name);

/** "a number", "an object". */
const article = (kind: CarrierKind) => (kind === "object" ? "an object" : `a ${kind}`);

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
export function dynamicMemberRead(b: MemberAccessBuilders, member: MemberGet, result: IrValueId): IrInstr[] {
  const { name, prelude, instr } = constantKey(b, member);
  return [...prelude, ...constantRead(b, instr, name, result)];
}

/** The read of the constant key `name`. */
function constantRead(b: MemberAccessBuilders, instr: MemberGet, name: string, result: IrValueId): IrInstr[] {
  // (#7561) A wrapper constructor's (#7352) or Array's `prototype` is read only and non-configurable: the realm's
  // prototype object.
  const ctor = realmConstructorOf(instr.recv, b.definitions);
  if (name === "prototype" && (ctor?.family === "array" || (ctor?.family === "wrapper" && b.wrappers.has(ctor.name))))
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
  const objectRead = (base: IrValueId, r: IrValueId, abort: Abort): IrInstr[] => {
    const get = (s: IrValueId) => [realmCall("js.object.get", [base, instr.key, instr.recv], s)];
    if (!BUILTIN_REACHABLE_KEYS.object.has(name)) return get(r);
    const found = b.fresh();
    return [realmCall("js.object.has", [base, instr.key], found), b.branch(found, get, abort, r, b.carrier)];
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
        return BUILTIN_REACHABLE_KEYS.function.has(name) ? "Function.prototype's properties" : undefined;
      if (MEMBER_ACCESS_ARM[kind] !== "primitive") return undefined;
      const reachable = BUILTIN_REACHABLE_KEYS[kind as keyof typeof BUILTIN_REACHABLE_KEYS];
      // A string's own `length` and indexed characters come with arrays (#7352).
      if (kind === "string" && (name === "length" || isArrayIndexKey(name)))
        return "its own length and index properties";
      return reachable.has(name) && heldPrototype(b, kind) === undefined
        ? `${WRAPPER_OF_PRIMITIVE[kind as keyof typeof WRAPPER_OF_PRIMITIVE]}.prototype's properties`
        : undefined;
    },
    nullishMessage: (kind) => `Cannot read properties of ${kind} (reading '${name}')`,
    unread: (r) => b.intrinsic(instr, "js.value.undefined", [], r),
    object: (r, abort) => (stringObjectIndex(b, name) ? abort(r) : objectRead(instr.recv, r, abort)),
    function: (r) => [realmCall("js.object.get", [instr.recv, instr.key, instr.recv], r)],
    // (#7561) [[Get]] on the held prototype, with the primitive as receiver.
    primitive: (kind, r) => {
      const prototype = heldPrototype(b, kind);
      if (prototype === undefined) return inherited(r);
      const base = b.fresh();
      return [...b.realmIntrinsic(prototype, base), ...objectRead(base, r, (s) => b.abort(instr, s))];
    },
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
  const { name, prelude, instr } = constantKey(b, member);
  return [...prelude, ...constantWrite(b, instr, name)];
}

/** The write of the constant key `name`. */
function constantWrite(b: MemberAccessBuilders, instr: MemberSet, name: string): IrInstr[] {
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
    object: (r, abort, throwTypeError) =>
      stringObjectIndex(b, name) ? abort(r) : putValue("object", r, throwTypeError),
    function: (r, throwTypeError) => putValue("function", r, throwTypeError),
    primitive: (kind, r, throwTypeError) => {
      const absent = (s: IrValueId) =>
        instr.sloppy === true ? [unread(s)] : throwTypeError(`Cannot create property '${name}' on ${kind}`, s);
      const prototype = heldPrototype(b, kind);
      if (prototype === undefined) return absent(r);
      // (#7561) A key on the held prototype's chain may be a setter or read only (#7350 B3b-2): the run-time abort.
      const [base, found] = [b.fresh(), b.fresh()];
      return [
        ...b.realmIntrinsic(prototype, base),
        realmCall("js.object.has", [base, instr.key], found),
        b.branch(found, (s) => b.abort(instr, s), absent, r, b.carrier),
      ];
    },
  };
  return memberAccess(b, instr, access, b.fresh());
}
