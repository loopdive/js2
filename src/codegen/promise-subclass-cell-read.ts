// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster D, slice D6) The typed read `C.p` of a module-scope assignment
 * cell on `class C extends Promise {}`, BEFORE the assignment has run.
 *
 * ## The defect, measured
 *
 * `registerModuleClassStaticAssignments` (codegen/index.ts) gives every
 * top-level `C.p = v` its own externref global `__static_C_p`, and the typed
 * read `C.p` lowers to `global.get` of it. Until the assignment runs the cell
 * is `null` — read as ABSENT by the dynamic MOP (#6651 C-expando), but the
 * typed read handed the raw `null` back. For a class whose [[Prototype]] is
 * `%Promise%` (§15.7.14 step 5.b) that is wrong exactly when `p` names an
 * inherited static: the five test262 rows
 * `built-ins/Promise/{all,allSettled,any,race}/invoke-resolve-on-{promises,values}-every-iteration-of-custom.js`
 * do
 *
 *     class Custom extends Promise {}
 *     let boundCustomResolve = Custom.resolve.bind(Custom);   // read BEFORE the write
 *     Custom.resolve = function (...args) { return boundCustomResolve(...args); };
 *
 * so `Custom.resolve` read `null`, `boundCustomResolve` was a bound function
 * over `null`, every `Custom.resolve(x)` the combinator made answered a
 * non-object, and the drive's `Invoke(nextPromise, "then", …)` threw
 * `Promise combinator element then is not a function`.
 *
 * ## The fix
 *
 * OrdinaryGet (§10.1.8.1): an absent own property continues at the
 * [[Prototype]]. For a DIRECT `extends Promise` class that is `%Promise%`, so
 * a `null` cell answers `Get(%Promise%, p)` — the live property, so a
 * reassigned `Promise.p` is honoured (D4's `promiseIntrinsicGetInstrs`). A
 * class whose parent is a USER class keeps its read unchanged (its
 * [[Prototype]] is that class object, not `%Promise%`).
 *
 * ## Gate
 *
 * Standalone, a recorded C-expando cell, direct heritage `Promise`. Every
 * other module is byte-identical. The cell-holds-JS-`null` ambiguity is
 * C-expando's documented bounded divergence and is unchanged in kind: such a
 * cell now reads the inherited value instead of `null`.
 */
import type { ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { isClassObjectExpandoCell } from "./class-object-expando.js";
import { promiseIntrinsicGetInstrs } from "./promise-subclass-proto-link.js";
import { localGlobalIdx } from "./registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

const EXTERNREF: ValType = { kind: "externref" };

function applies(ctx: CodegenContext, className: string, propName: string, cellGlobalIdx: number): boolean {
  if (ctx.standalone !== true || ctx.classBuiltinParentMap.get(className) !== "Promise") return false;
  const parent = ctx.classParentMap.get(className);
  if (parent !== undefined && ctx.classSet.has(parent)) return false;
  if (!isClassObjectExpandoCell(ctx, className, propName)) return false;
  return ctx.mod.globals[localGlobalIdx(ctx, cellGlobalIdx)]?.type.kind === "externref";
}

/**
 * Emit `cell ?? Get(%Promise%, propName)` for the typed read of a Promise-subclass
 * assignment cell. Returns `undefined` (nothing emitted) when the shape does not apply.
 */
export function tryEmitPromiseSubclassCellRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  className: string,
  propName: string,
  cellGlobalIdx: number,
): ValType | undefined {
  if (!applies(ctx, className, propName, cellGlobalIdx)) return undefined;
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  flushLateImportShifts(ctx, fctx);
  const inherited = promiseIntrinsicGetInstrs(ctx, fctx, propName);
  if (inherited === null) return undefined;
  fctx.body.push(
    { op: "global.get", index: cellGlobalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: EXTERNREF },
      then: inherited,
      else: [{ op: "global.get", index: cellGlobalIdx }],
    },
  );
  return EXTERNREF;
}
