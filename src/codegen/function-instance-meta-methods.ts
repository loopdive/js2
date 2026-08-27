// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4440) The METHOD half of #4437's per-function metadata carrier: class and
 * object-literal methods/accessors get a `$fnmeta` slot too, so their `name`
 * and their §15.1.5 `length` reflect like a plain function declaration's.
 *
 * ## The residual this closes (#4437 R1)
 * #4437 gave `name` a runtime home and made the reflective `length` exact, but
 * only for mint sites that hold a DECLARATION: `ensureFuncClosureSingleton`,
 * `funcref-as-closure.ts`, `arrow-phases.ts`. The method mint sites
 * (`ensureMethodClosureSingleton`, `emitObjectMethodAsClosure`) take a method
 * NAME and a funcIdx — no node — so the §15.1.5 walk had nothing to read and
 * `length` fell back to `$arity`, the DECLARED FORMAL COUNT. Measured on this
 * branch's base (`--target standalone`, `.tmp/run-one.mts`):
 *
 * | `class C { m(x = 42) {} }` — read on `C.prototype.m` | base | spec |
 * | ---------------------------------------------------- | ---- | ---- |
 * | `m["length"]` (reflective)                           | 1    | 0    |
 * | `m["name"]`                                          | absent | "m" |
 *
 * All eight remaining `*-method-length-dflt.js` / `*-setter-length-dflt.js`
 * files sit on that first row.
 *
 * ## Mechanism — a physical-name → declaration side table
 * The two method mint sites are reached from very different places (a class
 * prototype object build, a member-get dispatcher fill, an object literal), and
 * threading a node through all of them would touch five files. What they DO
 * share is the physical name they key everything else by:
 * `${className}_${member}` for a class method, `${className}_get_<p>` /
 * `${className}_set_<p>` for an accessor, `${literalType}_${field}` for an
 * object-literal method. `class-bodies.ts` records the declaration under that
 * exact key at the same moment it registers the funcMap entry; the mint sites
 * look it up.
 *
 * Keying by NAME rather than by funcIdx is deliberate: funcIdx is shift-
 * sensitive (late imports renumber every defined function), and the physical
 * name is precisely what `ensureMethodClosureSingleton` /
 * `member-get-dispatch.ts` already re-resolve by at fill time.
 *
 * ## §10.2.9 SetFunctionName for a method — what is and is NOT resolvable
 * A method's `name` carries a prefix for accessors (`get m` / `set m`) and, for
 * a symbol key, the description in brackets (`[Symbol.iterator]`). Only the
 * syntactic forms that carry a literal key are decidable at the mint site, so
 * this module **declines the whole slot** when the key is computed or private,
 * rather than publishing a guess.
 *
 * Declining is the safe direction and costs nothing that was already there:
 * with no slot, `length` keeps #4436's `$arity` answer (the property never
 * disappears) and `name` stays absent (never *wrong*). That asymmetry is
 * #4437's design and this module preserves it verbatim — a wrong `name` on
 * `[Symbol.iterator]` would be a new defect, whereas a missing one is the
 * status quo.
 */
import type { Instr, FieldDef } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ts } from "../ts-api.js";
import { expectedArgumentCountOfParams } from "./function-expected-argument-count.js";
import { fnMetaSlotOfMeta, type FnInstanceMeta } from "./function-instance-meta.js";

/** A member declaration that can carry `name` / `length` metadata. */
type MetaBearingMember =
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.PropertyAssignment;

/** The side table, created lazily so an unrelated compile pays nothing. */
function registry(ctx: CodegenContext): Map<string, MetaBearingMember> {
  return (ctx.fnMetaMemberDecls ??= new Map<string, MetaBearingMember>());
}

/**
 * Record `decl` as the declaration behind the physical function name
 * `physicalName` (`ClassName_m`, `ClassName_get_p`, `ClassName_set_p`, or an
 * object literal's `TypeName_field`).
 *
 * Idempotent by first-writer-wins: `class-bodies.ts` skips re-registering a
 * name that is already in `funcMap`, and the same guard applies here so a
 * second class reusing a physical name cannot silently repoint an existing
 * entry at its own parameter list.
 */
export function recordFnMetaMemberDeclaration(ctx: CodegenContext, physicalName: string, decl: ts.Node): void {
  if (!ctx.standalone) return;
  if (!isMetaBearingMember(decl)) return;
  const map = registry(ctx);
  if (map.has(physicalName)) return;
  map.set(physicalName, decl);
}

function isMetaBearingMember(decl: ts.Node): decl is MetaBearingMember {
  return (
    ts.isMethodDeclaration(decl) ||
    ts.isGetAccessorDeclaration(decl) ||
    ts.isSetAccessorDeclaration(decl) ||
    ts.isPropertyAssignment(decl)
  );
}

/**
 * §10.2.9 `name` for a member, or `undefined` when the key is not statically
 * decidable (a computed key is a runtime value; a `#private` name is not an
 * observable property key at all).
 *
 * The `get `/`set ` prefixes are part of the spec answer, not decoration:
 * `Object.getOwnPropertyDescriptor({ get m() {} }, "m").get.name` is `"get m"`.
 */
function memberNameOf(decl: MetaBearingMember): string | undefined {
  const key = decl.name;
  let base: string | undefined;
  if (ts.isIdentifier(key) || ts.isStringLiteral(key) || ts.isNumericLiteral(key)) base = key.text;
  if (base === undefined) return undefined;
  if (ts.isGetAccessorDeclaration(decl)) return `get ${base}`;
  if (ts.isSetAccessorDeclaration(decl)) return `set ${base}`;
  return base;
}

/**
 * The §15.1.5 / §10.2.9 metadata for a member declaration, or `undefined` when
 * the member carries no resolvable key (see the module header on why declining
 * beats guessing).
 *
 * A `PropertyAssignment` is included because an object literal's
 * `{ m: function () {} }` reaches the same mint site as `{ m() {} }`; its
 * metadata comes from the INITIALIZER's parameter list, and NamedEvaluation
 * already gives that function the property name, so the two spellings agree.
 */
export function fnMetaOfMember(decl: MetaBearingMember): FnInstanceMeta | undefined {
  const name = memberNameOf(decl);
  if (name === undefined) return undefined;
  const fnLike: ts.Node | undefined = ts.isPropertyAssignment(decl) ? decl.initializer : decl;
  if (fnLike === undefined || !ts.isFunctionLike(fnLike)) return undefined;
  return { name, length: expectedArgumentCountOfParams(fnLike.parameters) };
}

/** The `$fnmeta` field + `struct.new` operand for a member declaration. */
export function fnMetaSlotForMemberDecl(
  ctx: CodegenContext,
  decl: ts.Node | undefined,
): { field: FieldDef; init: Instr[]; meta: FnInstanceMeta } | undefined {
  if (!ctx.standalone || decl === undefined || !isMetaBearingMember(decl)) return undefined;
  const meta = fnMetaOfMember(decl);
  return meta === undefined ? undefined : fnMetaSlotOfMeta(ctx, meta);
}

/**
 * The `$fnmeta` field + `struct.new` operand for the member registered under
 * `physicalName`, or `undefined` when nothing was recorded (an object-literal
 * method reached through a path `class-bodies.ts` never sees, a computed key,
 * or a non-standalone target).
 */
export function fnMetaSlotForMemberName(
  ctx: CodegenContext,
  physicalName: string,
): { field: FieldDef; init: Instr[]; meta: FnInstanceMeta } | undefined {
  if (!ctx.standalone) return undefined;
  return fnMetaSlotForMemberDecl(ctx, ctx.fnMetaMemberDecls?.get(physicalName));
}
