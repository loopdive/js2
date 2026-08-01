// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3962) Host-free `value instanceof <user function constructor>`.
 *
 * ## The leak this closes
 *
 * `x instanceof F`, where `F` is a plain function declared in the module, took
 * the fully-dynamic path (`emitDynamicInstanceOf`) and emitted the
 * `env::__instanceof_check` host import. In `--target standalone` that import
 * is unsatisfiable, so the module does not even instantiate and the #2961 leak
 * guard refuses the test.
 *
 * Measured on the standalone baseline of 2026-08-01: **36 files in the ≤ES5
 * scope name `__instanceof_check` as their SOLE host import** — so 36 is a
 * complete bound on that scope, not a floor — and **26 of the 36 are
 * `e instanceof Test262Error`**, i.e. the harness's own top-level plain-function
 * constructor. `TypeError` and the rest of the Error family already answer
 * natively (#1473/#1536c), and the builtins answer via #2916, so this one shape
 * is what remains.
 *
 * ## Why a native answer here cannot regress a passing test
 *
 * Same safety argument as #2916's `nativeBuiltinInstanceOfTypeIdxs`: this
 * branch runs ONLY under `noJsHost`, where the operand shape it replaces
 * *always* leaks `__instanceof_check`. A leaking module cannot instantiate, so
 * every test reaching this code path already fails. A native answer can only
 * CONVERT a failing test; it can never turn a passing one into a failure. The
 * JS-host lane never enters this function and stays byte-identical.
 *
 * ## The lowering — §7.3.20 OrdinaryHasInstance, two representations
 *
 * `new F()` has two host-free lowerings, so membership is the OR of the two
 * corresponding tests:
 *
 *  1. **Bespoke struct.** A fnctor whose body assigns `this.x = …` lowers to a
 *     dedicated `$__fnctor_<F>` WasmGC struct (new-super.ts). Membership is an
 *     exact `ref.test` against that type index — plain functions have no
 *     subtyping, so the test is precise.
 *
 *  2. **`$Object` with a real `[[Prototype]]`.** The #2660 S3a reconstruct
 *     lowers an approved `new F()` to `__object_create(F.prototype)`, seeding
 *     `$Object.$proto` from the SAME per-fnctor prototype global this module
 *     reads. Membership is then literally the spec's chain walk, which the
 *     native `__isPrototypeOf(proto, value)` helper (#1472 Phase C) already
 *     performs over `$Object.$proto`.
 *
 * Type indices are rec-group / dead-elim stable and module globals are
 * append-only, so neither arm carries a funcidx-shift hazard.
 *
 * A primitive left operand answers `0` without touching either arm — §7.3.20
 * step 3 ("If Type(O) is not Object, return false") — and `ref.test` on a null
 * or non-matching `anyref` is `0`, so no arm can trap.
 */
import { emitFnctorProtoGet } from "./expressions/fnctor-prototype.js";
import { ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { compileExpression } from "./expressions.js";
import { allocLocal } from "./context/locals.js";
import { coerceType } from "./type-coercion.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";

/**
 * Emit a host-free `expr.left instanceof <ctorName>` when `ctorName` is a
 * top-level plain function constructor of this module. Leaves an i32 (0/1) on
 * the stack and returns its ValType, or `null` to decline — in which case the
 * caller falls through to its existing (host-import) path unchanged.
 */
export function tryEmitNativeUserCtorInstanceOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  ctorName: string,
): ValType | null {
  // Plain FUNCTION constructors only. Classes keep their existing dispatch:
  // class instances carry richer identity (brands, builtin parents) that the
  // two arms below do not model, and widening this to classes is separate,
  // separately-measured work.
  if (!ctx.topLevelFunctionNames.has(ctorName)) return null;
  if (ctx.classSet.has(ctorName)) return null;

  const structTypeIdx = ctx.structMap.get(`__fnctor_${ctorName}`);
  const hasStructArm = typeof structTypeIdx === "number" && structTypeIdx >= 0;

  // Reserve the proto-walk import BEFORE any operand is compiled, so a late
  // funcIdx shift reaches the already-emitted instructions through currentFunc.
  const isProtoOfIdx = ensureLateImport(
    ctx,
    "__isPrototypeOf",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (isProtoOfIdx === undefined && !hasStructArm) return null;

  // §13.10.1 evaluates the LHS before any check, so compile it either way.
  const leftType = compileExpression(ctx, fctx, expr.left);
  if (leftType && (leftType.kind === "i32" || leftType.kind === "f64" || leftType.kind === "i64")) {
    // A number / boolean primitive is never an Object — §7.3.20 step 3.
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i32.const", value: 0 });
    return { kind: "i32" };
  }
  if (!leftType) {
    fctx.body.push({ op: "ref.null.extern" });
  } else if (leftType.kind !== "externref") {
    coerceType(ctx, fctx, leftType, { kind: "externref" });
  }
  const valueLocal = allocLocal(fctx, `__uio_val_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: valueLocal });

  let pushedAnArm = false;

  if (hasStructArm) {
    fctx.body.push({ op: "local.get", index: valueLocal });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });
    pushedAnArm = true;
  }

  // Chain walk: `__isPrototypeOf(F.prototype, value)`. `emitFnctorProtoGet`
  // lazily materializes the per-fnctor prototype `$Object` — the same global the
  // #2660 S3a `new F()` reconstruct seeds `$proto` from, so object identity
  // holds.
  //
  // This is NOT a speculative compile and needs no rollback (#1919): the helper's
  // only failure point is its opening `ensureLateImport("__new_plain_object")`,
  // which precedes every `body.push` it makes — so a `false` return has emitted
  // nothing, exactly as its contract states. Truncating `body.length` here would
  // be a *partial* rollback anyway (it would not undo locals, late imports or
  // errors), which is the bug pattern the #1919 gate exists to catch.
  if (isProtoOfIdx !== undefined && emitFnctorProtoGet(ctx, fctx, ctorName)) {
    fctx.body.push({ op: "local.get", index: valueLocal });
    // Re-read the index: the proto-get may have registered helpers.
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__isPrototypeOf") ?? isProtoOfIdx });
    if (pushedAnArm) fctx.body.push({ op: "i32.or" });
    pushedAnArm = true;
  }

  if (!pushedAnArm) {
    // Neither representation is modeled in this module — `new F()` never
    // happened here, so nothing can be an instance. A definite `0` is the
    // correct host-free answer and still beats an unsatisfiable import.
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  return { kind: "i32" };
}
