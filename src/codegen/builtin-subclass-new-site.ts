// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 C5) `new D(…)` for a member-less `class D extends <Date|RegExp|DataView|Function> {}`
 * constructs the parent's real native carrier, standalone.
 *
 * ## The gap
 *
 * The #3972 standalone super-constructor for these parents is an IDENTITY
 * carrier: a fresh plain `$Object` that ignores its arguments (see
 * `standalone-subclass-ctors.ts`). `instanceof` is answered statically, so
 * identity rows pass, but any behaviour does not — `new D(0).getFullYear()`,
 * `new RE(39).test("TC39")` and `new DV(buffer).buffer` all threw "called value
 * is not a function" or read `undefined`. A faithful carrier needs the parent's
 * full argument semantics (Date's seven-argument MakeDay/MakeTime and string
 * parse, RegExp's pattern compile, DataView's buffer brand check), and every one
 * of those is AST-driven: the forwarder that calls the super-constructor only
 * holds already-evaluated `externref` arguments.
 *
 * ## The fix — at the one site that still has the AST
 *
 * For a class whose constructor would do NOTHING but construct the parent —
 * no own constructor (§15.7.14 synthesises `constructor(...args) {
 * super(...args) }`), no instance member, heritage naming the builtin directly
 * — `new D(a, b)` evaluates exactly what `new Parent(a, b)` evaluates, in the
 * same order, and yields that object. So the site compiles `new Parent(a, b)`
 * through the parent's own lowering, then runs the one standalone instance
 * step `D_new` would have run (the `constructor` own-property install), so a
 * dynamic `d.constructor === D` keeps its answer.
 *
 * Inherited methods on the result dispatch through
 * `builtin-subclass-receiver.ts`, which routes a `D`-typed receiver to the
 * parent only for a class that qualifies here — an instance built by any OTHER
 * path (`Reflect.construct(D, …)`, a subclass of `D`) is still the identity
 * carrier and keeps its previous behaviour.
 *
 * Standalone only; the JS-host lane constructs a real host object.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { rollbackSpeculative, snapshotSpeculative } from "./context/speculative.js";
import { emitStandaloneSubclassMethodInstall } from "./standalone-subclass-method-install.js";
import { coerceType } from "./type-coercion.js";

/** Parents whose `new` lowering is reused at a qualifying subclass site. */
const NEW_SITE_BUILTIN_PARENTS: ReadonlySet<string> = new Set(["Date", "RegExp", "DataView", "Function"]);

function isStaticMember(member: ts.ClassElement): boolean {
  const modifiers = ts.canHaveModifiers(member) ? (ts.getModifiers(member) ?? []) : [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword);
}

/**
 * The builtin parent `new <className>(…)` is equivalent to, when `className` is
 * a standalone externref-backed class whose heritage names that parent
 * directly and which declares no constructor and no instance member.
 */
export function newSiteBuiltinParent(ctx: CodegenContext, className: string): string | undefined {
  if (!ctx.standalone) return undefined;
  if (!ctx.classExternrefBackedSet.has(className)) return undefined;
  const parent = ctx.classBuiltinParentMap.get(className);
  if (parent === undefined || !NEW_SITE_BUILTIN_PARENTS.has(parent)) return undefined;
  if (ctx.classParentMap.get(className) !== parent) return undefined;
  const decl = ctx.classDeclarationMap.get(className);
  if (decl === undefined) return undefined;
  const memberless = decl.members.every(
    (member) => ts.isSemicolonClassElement(member) || (!ts.isConstructorDeclaration(member) && isStaticMember(member)),
  );
  return memberless ? parent : undefined;
}

/**
 * Compile the qualifying `new D(…)` as `lowerParent()` — the parent's own
 * `new` lowering on the SAME argument nodes — boxed to the externref a
 * `D`-typed value is, plus `D_new`'s standalone `constructor` install.
 * `undefined` (everything rolled back) when the parent lowering declines, so
 * the caller's ordinary `D_new` path runs.
 */
export function compileNewSiteBuiltinSubclass(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  lowerParent: () => ValType | null | undefined,
): ValType | undefined {
  const snap = snapshotSpeculative(ctx, fctx);
  const built = lowerParent();
  if (built === undefined || built === null) {
    rollbackSpeculative(ctx, fctx, snap);
    return undefined;
  }
  if (built.kind !== "externref") coerceType(ctx, fctx, built, { kind: "externref" });
  const self = allocLocal(fctx, `__newsite_${className}_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: self });
  emitStandaloneSubclassMethodInstall(ctx, fctx, self, className);
  fctx.body.push({ op: "local.get", index: self });
  return { kind: "externref" };
}
