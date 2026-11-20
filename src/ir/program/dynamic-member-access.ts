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
import { realmCall, typeError, type TypeErrorBuilders } from "./dynamic-realm-calls.js";
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
  readonly kindsOf: (value: IrValueId) => readonly CarrierKind[];
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

/** OrdinarySet's answer (`js.object.set`). */
const BOOLEAN: IrType = Object.freeze({ kind: "val", val: Object.freeze({ kind: "i32", boolean: true }) });

/** A thrown TypeError with `message` (`typeError`), the arm's unread answer into `result`. */
type ThrowTypeError = (message: string, result: IrValueId) => IrInstr[];

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
  readonly object: (result: IrValueId) => IrInstr;
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
 * The chain both accesses take over the once-evaluated receiver, into `result`. An access the realm cannot answer for
 * some kind the receiver may hold refuses, in one form: the access, the receiver (its kind, or the kinds it may be
 * whose answer is missing), and what is missing, e.g. "member read 'toFixed' of a value that may be a number needs
 * Number.prototype's properties".
 */
function memberAccess(
  b: MemberAccessBuilders,
  instr: MemberGet | MemberSet,
  access: Access,
  result: IrValueId,
): IrInstr[] {
  const kinds = b.kindsOf(instr.recv);
  const refused = kinds.filter((kind) => access.missing(kind) !== undefined);
  if (refused.length > 0) {
    const receiver =
      kinds.length === 1 ? article(kinds[0]!) : `a value that may be ${refused.map(article).join(" or ")}`;
    const missing = [...new Set(refused.map((kind) => access.missing(kind)!))].join(" and ");
    gap(`${access.operation} of ${receiver} needs ${missing}`);
  }
  // The TypeError does not complete; the access's unread answer only gives the arm its value.
  const throwTypeError: ThrowTypeError = (message, r) => [...typeError(b, message), access.unread(r)];
  const arm = (kind: CarrierKind, r: IrValueId): IrInstr[] => {
    switch (MEMBER_ACCESS_ARM[kind]) {
      case "type-error":
        return throwTypeError(access.nullishMessage(kind), r);
      case "object":
        return [access.object(r)];
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
      if (kind === "error")
        return ERROR_PROTOTYPE_KEYS.has(name) || BUILTIN_REACHABLE_KEYS.object.has(name)
          ? "Error.prototype's properties"
          : undefined;
      if (kind === "object")
        return BUILTIN_REACHABLE_KEYS.object.has(name) ? "Object.prototype's properties" : undefined;
      if (MEMBER_ACCESS_ARM[kind] !== "primitive") return undefined;
      const reachable = BUILTIN_REACHABLE_KEYS[kind as keyof typeof BUILTIN_REACHABLE_KEYS];
      // A string's own `length` and indexed characters come with arrays (#7352).
      if (kind === "string" && (name === "length" || isArrayIndexKey(name)))
        return "its own length and index properties";
      return reachable.has(name) ? `${WRAPPER[kind]}.prototype's properties` : undefined;
    },
    nullishMessage: (kind) => `Cannot read properties of ${kind} (reading '${name}')`,
    unread: (r) => b.intrinsic(instr, "js.value.undefined", [], r),
    object: (r) => realmCall("js.object.get", [instr.recv, instr.key, instr.recv], r),
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
  const unread = (r: IrValueId): IrInstr => ({
    kind: "const",
    value: { kind: "bool", value: false },
    result: r,
    resultType: BOOLEAN,
  });
  const access: Access = {
    operation: `member write '${name}'`,
    resultType: BOOLEAN,
    // The realm's error has no property storage a write could land in.
    missing: (kind) =>
      kind === "error"
        ? "property storage on the realm's error"
        : MEMBER_ACCESS_ARM[kind] === "object" && BUILTIN_REACHABLE_KEYS.object.has(name)
          ? "Object.prototype's properties"
          : MEMBER_ACCESS_ARM[kind] === "primitive" && OBJECT_PROTOTYPE_ACCESSOR_KEYS.has(name)
            ? "Object.prototype's accessor"
            : undefined,
    nullishMessage: (kind) => `Cannot set properties of ${kind} (setting '${name}')`,
    unread,
    object: (r) => realmCall("js.object.set", [instr.recv, instr.key, instr.value, instr.recv], r),
    // Refused above (`missing`): a write never reaches the error arm.
    error: () => [],
    primitive: (kind, r, throwTypeError) =>
      instr.sloppy === true ? [unread(r)] : throwTypeError(`Cannot create property '${name}' on ${kind}`, r),
  };
  return memberAccess(b, instr, access, b.fresh());
}
