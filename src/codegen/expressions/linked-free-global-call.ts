// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6492 round 9) §9.1.1.4 ResolveBinding for a CALL of a free identifier in a
 * separately-linked PROVIDER.
 *
 * ## The defect
 *
 * The test262 harness provider's `index.js` is the harness prefix PLUS its
 * `export const __h_<name> = <name>;` aliases in ONE file, so the compile unit
 * is an ES module. Every global the harness references but does not declare —
 * `$DONE`, `$ERROR` — is therefore symbol-less, `moduleGoalIdentifierIsUndeclared`
 * answers true, and a CALL of one took the unconditional ReferenceError in
 * `undeclared-callee.ts` (#4650).
 *
 * That is wrong for this unit, and measurably so. Instrumenting
 * `__throw_reference_error` in the real runner (2026-09-17) on
 * `harness/asyncHelpers-asyncTest-rejects-non-callable.js`:
 *
 *   [DBG refError] $DONE is not defined  hasSandbox=true
 *                  sandboxHasDONE=true  sandboxDONEtype=function
 *
 * — the realm object HAD the property and the module threw anyway. The spec
 * throws only when the binding is ABSENT; when the global object has it, the
 * reference resolves to it.
 *
 * ## Why a LIVE lookup, and not an ambient declaration
 *
 * The obvious cheaper route — declare `$DONE` in the provider's synthetic
 * project so the ordinary declared-global path serves it — cannot work, and
 * the reason is worth keeping: a `global_<name>` capability import SNAPSHOTS
 * its value at import-resolution time
 * (`platform-capability-adapter.ts`: `const ambient = globals[name]; return
 * ambient !== undefined ? () => ambient : () => {};`). The provider is
 * instantiated BEFORE the consumer's `__module_init` runs (#6477
 * `deferTopLevelInit`), so a snapshot can only ever capture whatever the
 * embedder seeded first, never a binding the body installs. A capability
 * import that snapshots is not a binding.
 *
 * ## Shape
 *
 * `__extern_has(globalThis, name)` decides; the present arm reads the value and
 * dispatches it through `__call_function`, the absent arm keeps the existing
 * ReferenceError. The has-guard is what makes this a fix rather than a
 * regression: without it a genuinely unbound name would answer `undefined`
 * instead of throwing, and every `assert.throws(ReferenceError, …)` over an
 * unbound callee would flip.
 *
 * Arguments are compiled INSIDE the present arm, so the absent arm still throws
 * before evaluating them — §13.3.6.1 step 1 resolves the callee reference
 * first, which is the rule `undeclared-callee.ts` exists to preserve.
 *
 * ## Scope
 *
 * Gated on the PROVIDER link role (`linkBrandRoleOf`, #6482) and on the JS-host
 * lane, so an ordinary single-module compile, the honest test262 lane, and
 * every standalone/WASI build emit byte-identical code — none of them is a
 * provider. Widening this to the whole host lane would be spec-correct (the
 * consumer's own free reads are leniently resolved through `__extern_get`
 * today and never throw, which is the opposite deviation) but it moves honest
 * verdicts and belongs in its own measured change.
 */
import { ts } from "../../ts-api.js";
import type { ValType } from "../../ir/types.js";
import { popBody, pushBody } from "../context/bodies.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { addHostStringConstantGlobal } from "../registry/imports.js";
import { linkBrandRoleOf } from "../shape-brand.js";
import { coerceType, compileExpression, ensureLateImport } from "../shared.js";
import { flushLateImportShifts } from "./late-imports.js";

const EXTERNREF: ValType = { kind: "externref" };

/** Is this compile unit a linked PROVIDER on the JS-host lane? */
function isLinkedProviderHostUnit(ctx: CodegenContext): boolean {
  if (ctx.standalone || ctx.wasi || ctx.strictNoHostImports) return false;
  return linkBrandRoleOf(ctx) === "provider";
}

/**
 * Emit `globalThis[name](args…)` guarded by `__extern_has`, or return
 * `undefined` to leave the caller's dispatch chain (and its ReferenceError)
 * exactly as it was.
 */
export function tryEmitLinkedProviderFreeGlobalCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  funcName: string,
): ValType | undefined {
  if (!isLinkedProviderHostUnit(ctx)) return undefined;

  // Every import is registered BEFORE a single instruction is emitted: a
  // late-import shift landing between an already-baked funcIdx and its use
  // would poison it, and `flushLateImportShifts` remaps emitted instructions,
  // not indices already captured in locals here.
  const gtIdx = ensureLateImport(ctx, "__get_globalThis", [], [EXTERNREF]);
  const hasIdx = ensureLateImport(ctx, "__extern_has", [EXTERNREF, EXTERNREF], [{ kind: "i32" }]);
  const getIdx = ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  const newIdx = ensureLateImport(ctx, "__js_array_new", [], [EXTERNREF]);
  const pushIdx = ensureLateImport(ctx, "__js_array_push", [EXTERNREF, EXTERNREF], []);
  const callIdx = ensureLateImport(ctx, "__call_function", [EXTERNREF, EXTERNREF, EXTERNREF], [EXTERNREF]);
  const throwIdx = ensureLateImport(ctx, "__throw_reference_error", [EXTERNREF], []);
  flushLateImportShifts(ctx, fctx);

  const getGlobal = ctx.funcMap.get("__get_globalThis") ?? gtIdx;
  const has = ctx.funcMap.get("__extern_has") ?? hasIdx;
  const get = ctx.funcMap.get("__extern_get") ?? getIdx;
  const arrayNew = ctx.funcMap.get("__js_array_new") ?? newIdx;
  const arrayPush = ctx.funcMap.get("__js_array_push") ?? pushIdx;
  const callFn = ctx.funcMap.get("__call_function") ?? callIdx;
  const thrower = ctx.funcMap.get("__throw_reference_error") ?? throwIdx;
  const keyIdx = addHostStringConstantGlobal(ctx, funcName);
  const msgIdx = addHostStringConstantGlobal(ctx, `${funcName} is not defined`);
  if (
    getGlobal === undefined ||
    has === undefined ||
    get === undefined ||
    arrayNew === undefined ||
    arrayPush === undefined ||
    callFn === undefined ||
    thrower === undefined ||
    keyIdx === undefined ||
    msgIdx === undefined
  ) {
    return undefined;
  }

  const objLocal = allocLocal(fctx, `__free_call_obj_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: getGlobal });
  fctx.body.push({ op: "local.set", index: objLocal });
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "global.get", index: keyIdx });
  fctx.body.push({ op: "call", funcIdx: has });

  const saved = pushBody(fctx);
  const calleeLocal = allocLocal(fctx, `__free_call_fn_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.get", index: objLocal });
  fctx.body.push({ op: "global.get", index: keyIdx });
  fctx.body.push({ op: "call", funcIdx: get });
  fctx.body.push({ op: "local.set", index: calleeLocal });
  const argsLocal = allocLocal(fctx, `__free_call_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: arrayNew });
  fctx.body.push({ op: "local.set", index: argsLocal });
  for (const argument of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    const argType = compileExpression(ctx, fctx, ts.isSpreadElement(argument) ? argument.expression : argument);
    if (argType === null) fctx.body.push({ op: "ref.null.extern" });
    else if (argType.kind !== "externref") coerceType(ctx, fctx, argType, EXTERNREF);
    fctx.body.push({ op: "call", funcIdx: arrayPush });
  }
  fctx.body.push({ op: "local.get", index: calleeLocal });
  // A bare call passes `undefined` as `this`; the host bridge reads a null
  // externref as exactly that, the same convention the #1712 host-call arm in
  // call-identifier.ts uses.
  fctx.body.push({ op: "ref.null.extern" });
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: callFn });
  const presentArm = fctx.body;
  popBody(fctx, saved);

  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then: presentArm,
    else: [{ op: "global.get", index: msgIdx }, { op: "call", funcIdx: thrower }, { op: "unreachable" }],
  });
  return EXTERNREF;
}
