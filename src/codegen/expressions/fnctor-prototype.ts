// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2660 S2 — per-fnctor prototype `$Object` (standalone).
 *
 * A user function constructor `F` (a `function F(){}` / `function expression` /
 * `var F = function(){}`, NOT a `class`) is lowered to a closure trampoline
 * struct, NOT an `$Object`. So `F.prototype` read/write went through
 * `__extern_get` / `__extern_set` on the closure struct, whose `ref.test $Object`
 * MISSES → the write was silently dropped and the read returned null. Result:
 * `Object.create(F.prototype).foo` returned 0 (verified in the emitted WAT —
 * `Con.prototype` reads as `__extern_get($closure, "prototype")`).
 *
 * S2 synthesizes a per-fnctor prototype object held in a `mut externref` module
 * global (`ctx.fnctorPrototypeObject`, keyed by the fnctor symbol name) that is a
 * real native `$Object`:
 *   - READ `F.prototype` → lazy-init an empty `$Object` (`__new_plain_object`) on
 *     first access, then `global.get`.
 *   - WRITE `F.prototype = rhs` (whole reassign) → build `rhs` as a native
 *     `$Object` when it is a plain object literal (the #2580 Stage-A precedent),
 *     else compile it to externref, then `global.set`.
 *   - WRITE `F.prototype.p = v` (per-prop) needs NO code here — it RIDES the read
 *     interception: the inner `F.prototype` read returns the global `$Object`, and
 *     the existing `__extern_set_strict` fallback writes `p` onto it.
 *
 * This is the readable `$Object` that #2660 S3 will seed `instance.$proto` from at
 * `new F()` — ONE link location (`$Object.$proto`), ONE walk
 * (`__extern_get`/`__extern_has`). No parallel `[[Prototype]]` mechanism.
 *
 * Gated on `ctx.standalone` (the host fnctor prototype is the #2660 (3a) sidecar
 * lap — host stays byte-identical). Classes (`ctx.classSet` / class fast path in
 * property-access), builtins (`Array.prototype` etc.), arrow functions, and
 * method receivers are all excluded by `resolveFnctorSymbol` (it only matches an
 * identifier resolving to a user `FunctionDeclaration`/`FunctionExpression` /
 * `var F = function` with a body). The closed-struct/`$Object` shapes the hot
 * path relies on are untouched.
 */
import { ts } from "../../ts-api.js";
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { resolveFnctorSymbol } from "../fnctor-escape-gate.js";
import { nextModuleGlobalIdx } from "../registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { compileObjectLiteralAsExternref } from "../literals.js";
import { coerceType, compileExpression } from "../shared.js";

/**
 * Resolve a property-access/assignment receiver to a user-fnctor key (the
 * resolved symbol name), or `undefined` when it is not a user function
 * constructor. Mirrors the recognition `analyzeFnctorEscapeGate` /
 * `compileNewFunctionDeclaration` use, so the read/write key agrees with the
 * `new F()` lowering. Classes, builtins, arrows, and non-identifier receivers
 * return `undefined`.
 */
export function resolveUserFnctorName(ctx: CodegenContext, expr: ts.Expression): string | undefined {
  // `resolveFnctorSymbol` itself unwraps `( … )` / `as` / `!` wrappers and
  // requires the inner node to be an identifier resolving to a user function
  // (not a class/arrow/builtin), so do NOT pre-gate on `ts.isIdentifier` —
  // `(Con as any).prototype` must still resolve to `Con`.
  const sym = resolveFnctorSymbol(ctx.checker, expr);
  if (!sym) return undefined;
  // RECONSTRUCT-GATE (#2660 S2): only materialize the per-fnctor prototype
  // `$Object` for a constructor S3 will reconstruct (≥1 `reconstruct`-classified
  // `new F()` site). A `keep-typed` / `keep-static` / never-`new`'d function keeps
  // its existing prototype behaviour — an UNSCOPED interception clobbered working
  // paths: the species `Ctor.prototype` IDENTITY in `Array/prototype/*/create-proxy`
  // (Ctor is never `new`'d in source), and `Test262Error.prototype.toString` once
  // the keep-in-init made it execute (Test262Error is `keep-typed`). Both ejected
  // the standalone floor (−40). Gate on the S1 escape-gate result (computed at
  // index.ts:1076, before collectDeclarations + codegen, so it is always set).
  const hasRuntimeDescriptorInstall = (() => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Object" &&
        (node.expression.name.text === "defineProperty" || node.expression.name.text === "defineProperties")
      ) {
        const receiver = node.arguments[0];
        if (
          receiver &&
          ts.isPropertyAccessExpression(receiver) &&
          receiver.name.text === "prototype" &&
          ts.isIdentifier(receiver.expression)
        ) {
          const receiverDeclaration = ctx.oracle.valueDeclarationOf(receiver.expression);
          if (receiver.expression.text === sym.name && receiverDeclaration === sym.valueDeclaration) {
            found = true;
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(expr.getSourceFile());
    return found;
  })();
  if (!ctx.fnctorEscapeGate?.approvedNames.has(sym.name) && !hasRuntimeDescriptorInstall) return undefined;
  // Key by the stable symbol name so the WRITE site (`F.prototype = …`) and the
  // READ site (`Object.create(F.prototype)`) resolve to the SAME global.
  return sym.name;
}

/**
 * True when `target` is a `F.prototype = …` (whole reassign) or `F.prototype.p =
 * …` (per-prop) assignment LHS for a user function constructor `F`. Used by the
 * module-init collection (declarations.ts) to KEEP such a top-level statement in
 * `__module_init`: its root identifier `F` is a function (not a module global),
 * so the generic "assignment to a module global" check drops it, and the write
 * never reaches `compilePropertyAssignment`/the S2 interception. Mirrors the
 * `Array.prototype` CPR keep-in-init case. Element-access (`F.prototype[i]=v`) is
 * not matched (the S2 cluster uses whole-literal / named-prop writes).
 */
export function isFnctorPrototypeAssignTarget(ctx: CodegenContext, target: ts.Expression): boolean {
  if (!ts.isPropertyAccessExpression(target)) return false;
  // `F.prototype = …`
  if (
    ts.isIdentifier(target.name) &&
    target.name.text === "prototype" &&
    resolveUserFnctorName(ctx, target.expression) !== undefined
  ) {
    return true;
  }
  // `F.prototype.p = …`
  const recv = target.expression;
  if (
    ts.isPropertyAccessExpression(recv) &&
    ts.isIdentifier(recv.name) &&
    recv.name.text === "prototype" &&
    resolveUserFnctorName(ctx, recv.expression) !== undefined
  ) {
    return true;
  }
  return false;
}

/** Get-or-mint the `mut externref` module global holding F's prototype `$Object`. */
function getOrMintFnctorProtoGlobal(ctx: CodegenContext, fnctorName: string): number {
  const existing = ctx.fnctorPrototypeObject.get(fnctorName);
  if (existing !== undefined) return existing;
  const idx = nextModuleGlobalIdx(ctx);
  // Module globals are append-only and index-stable (separate index space from
  // the function table), so minting one mid-compile carries no late-import
  // funcidx-shift hazard (#2043) — unlike a `call` to a defined helper.
  ctx.mod.globals.push({
    name: `__fnctor_proto_${fnctorName}`,
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  ctx.fnctorPrototypeObject.set(fnctorName, idx);
  return idx;
}

/**
 * Emit the lazy-initialized prototype `$Object` get: `if (g == null) g =
 * __new_plain_object(); return g`. Leaves an externref (`$Object`) on the stack.
 * Returns false (emitting nothing) when `__new_plain_object` is unavailable, so
 * the caller declines and falls through to the legacy path.
 *
 * Exported for #2660 S3: the `new F()` reconstruct lowering (new-super.ts) seeds
 * the instance's `$proto` from this SAME per-fnctor prototype `$Object`, so the
 * inherited-read walk and the `F.prototype` read/write share ONE link location
 * (`$Object.$proto`) and ONE object identity (`Object.getPrototypeOf(new F()) ===
 * F.prototype`). The lazy-init guarantees the proto is always a real `$Object`
 * even when `F.prototype` was never explicitly assigned.
 */
export function emitFnctorProtoGet(ctx: CodegenContext, fctx: FunctionContext, fnctorName: string): boolean {
  const newObjIdx = ensureLateImport(ctx, "__new_plain_object", [], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (newObjIdx === undefined) return false;
  const g = getOrMintFnctorProtoGlobal(ctx, fnctorName);
  fctx.body.push({ op: "global.get", index: g });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "call", funcIdx: newObjIdx },
      { op: "global.set", index: g },
    ],
    else: [],
  });
  fctx.body.push({ op: "global.get", index: g });
  return true;
}

/**
 * READ interception for `F.prototype` (F a user fnctor, standalone). Returns the
 * per-fnctor prototype `$Object` as an externref, or `undefined` to decline (the
 * caller continues its normal dispatch).
 */
export function tryEmitFnctorPrototypeRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.PropertyAccessExpression,
  propName: string,
): ValType | undefined {
  if (!ctx.standalone || propName !== "prototype") return undefined;
  const fnctorName = resolveUserFnctorName(ctx, expr.expression);
  if (fnctorName === undefined) return undefined;
  if (!emitFnctorProtoGet(ctx, fctx, fnctorName)) return undefined;
  return { kind: "externref" };
}

/**
 * WHOLE-REASSIGN interception for `F.prototype = rhs` (F a user fnctor,
 * standalone). Builds `rhs` as a native `$Object` (plain object literal) or an
 * externref, stores it into the per-fnctor prototype global, and leaves the
 * assigned value on the stack (assignment-expression semantics). Returns
 * `undefined` to decline. Per-prop writes (`F.prototype.p = v`) are NOT handled
 * here — they ride the READ interception above.
 */
export function tryCompileFnctorPrototypeAssign(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression,
  value: ts.Expression,
): ValType | undefined {
  if (!ctx.standalone) return undefined;
  if (!ts.isIdentifier(target.name) || target.name.text !== "prototype") return undefined;
  const fnctorName = resolveUserFnctorName(ctx, target.expression);
  if (fnctorName === undefined) return undefined;

  // Reserve the late import + global BEFORE building the RHS so any index shift
  // the RHS compile triggers reaches the already-emitted instrs via currentFunc.
  const g = getOrMintFnctorProtoGlobal(ctx, fnctorName);

  // Build the RHS as an externref (a native `$Object` when it is a plain object
  // literal — the #2580 Stage-A `compileProtoArg` precedent, replicated here to
  // avoid a calls.ts import cycle).
  if (ts.isObjectLiteralExpression(value)) {
    const lit = compileObjectLiteralAsExternref(ctx, fctx, value);
    if (lit) {
      if (lit.kind !== "externref") coerceType(ctx, fctx, lit, { kind: "externref" });
    } else {
      // `$Object` builder declined — fall back to the ordinary expression path.
      const t = compileExpression(ctx, fctx, value, { kind: "externref" });
      if (!t) fctx.body.push({ op: "ref.null.extern" });
      else if (t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
    }
  } else {
    const t = compileExpression(ctx, fctx, value, { kind: "externref" });
    if (!t) fctx.body.push({ op: "ref.null.extern" });
    else if (t.kind !== "externref") coerceType(ctx, fctx, t, { kind: "externref" });
  }

  // Stack: [rhs externref]. Store into the prototype global, leaving the value.
  fctx.body.push({ op: "global.set", index: g });
  fctx.body.push({ op: "global.get", index: g });
  return { kind: "externref" };
}
