// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4192) Receiver install for `.call` / `.apply` on a **variable-held function
 * expression**.
 *
 * ## The defect
 *
 * ```js
 * var fe = function () { this.touched = true; };
 * var o = {};
 * fe.call(o);          // o.touched === undefined   (want true)
 * ```
 *
 * A function *declaration* gets this right — `named-this-call.ts` (#3796/#4025,
 * `.apply` via #3983) reserves an exact-target trampoline that saves, installs
 * and restores `__current_this` around the call. But `resolveDeclaration` there
 * demands `ts.isFunctionDeclaration`, and the call site additionally gates the
 * whole named-`this` arm on `!closureInfo` — and `var fe = function () {}`
 * registers a `closureMap` entry. So the dominant JS function shape fell into
 * the legacy arm, which evaluates `thisArg` and **drops** it:
 *
 * ```wat
 * local.get <thisArg> ; drop        ;; ← the receiver, discarded
 * <closure call>
 * ```
 *
 * That is a silent wrong answer, not a refusal — the same failure this module's
 * sibling was created to remove for declarations.
 *
 * ## Why the fix is only a call-site install
 *
 * The lifted closure body is already correct. Measured on the WAT for the
 * snippet above: `bodyReferencesOwnThis` is true for the function expression, so
 * `compileFunctionBody` sets `readsCurrentThis` and the body opens with
 *
 * ```wat
 * global.get $__current_this ; ref.is_null
 * (if (result externref) (then global.get $__undefined …) (else …))
 * ```
 *
 * i.e. it reads the global and falls back to `undefined` when nothing was
 * installed. Nothing in the module ever wrote that global — `global.set` on it
 * appeared only inside `__call_fn_method_N`, which this path does not reach.
 * So the body half needs no change; only the writer was missing.
 *
 * ## Shape
 *
 * Inline save/install/restore, mirroring `__call_fn_method_N`
 * (closure-exports.ts) and `fillDirectCallTrampolines` (typed-this.ts) —
 * **including their one documented limitation, that an exceptional unwind
 * skips the restore**. An inline sequence cannot use the trampoline's
 * `catch_all` without wrapping an arbitrary sub-expression in a `try`, and
 * matching the established sequence exactly is worth more here than being the
 * one path that differs.
 *
 * ```wat
 * <thisArg>                       ;; already on the stack (externref)
 * local.set   $__recv
 * global.get  $__current_this
 * local.set   $__prev_this
 * local.get   $__recv
 * global.set  $__current_this
 * <closure call>                  ;; result (or nothing) on the stack
 * [local.set  $__recv_result]
 * local.get   $__prev_this
 * global.set  $__current_this
 * [local.get  $__recv_result]
 * ```
 *
 * A **null** receiver needs no special arm: the body's own `ref.is_null` guard
 * already answers `undefined`, so `f.call(null)` / `f.call(undefined)` keep the
 * exact value they have today. That is deliberately different from
 * `named-this-call.ts`, which must branch because its trampoline hands the
 * receiver over as a parameter.
 *
 * ## Admission
 *
 * Narrow on purpose — it fires only where the current lowering provably throws
 * the receiver away:
 *
 *  - the callee identifier resolves to a `VariableDeclaration` whose initializer
 *    is a **`FunctionExpression`** (an arrow is excluded: its `this` is
 *    lexical, and installing a dynamic receiver would change its meaning);
 *  - that function's body references its **own** `this`
 *    (`bodyReferencesOwnThis` — the same predicate the body used to decide it
 *    would read the global, so the two can never disagree);
 *  - it is not a generator, not `async`, and has no explicit `this` parameter.
 *
 * Reassignment of the variable is *not* checked, and does not need to be: unlike
 * the exact-target trampoline, this install bakes no callee. If the variable
 * holds some other function at runtime, that function either reads
 * `__current_this` (in which case installing the spec receiver is the correct
 * answer) or does not (in which case the install is unobservable).
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { bodyReferencesOwnThis } from "./helpers/body-references-own-this.js";
import { installableReceiverInstrs } from "./helpers/undefined-receiver.js"; // (#4555) §10.4.3
import { ensureCurrentThisGlobal } from "./statements/nested-declarations.js";

/**
 * Narrow a `compileExpression`-family result (`InnerResult = ValType | null |
 * VOID_RESULT`) to the `ValType` the restore must preserve, or `undefined` when
 * the call left nothing on the stack. Typed structurally rather than importing
 * `shared.ts`, to keep this module free of a codegen import cycle.
 */
export function innerResultValType(result: ValType | null | symbol): ValType | undefined {
  return result === null || typeof result === "symbol" ? undefined : result;
}

/** Locals + global reserved for one install/restore pair. */
export interface ClosureReceiverInstall {
  readonly globalIdx: number;
  readonly recvLocal: number;
  readonly prevLocal: number;
}

/**
 * Does `callee` name a variable holding a `this`-reading function expression?
 * Returns the reserved install handle, or `undefined` to leave every existing
 * lowering (including the evaluate-and-drop one) authoritative.
 */
export function planClosureReceiverInstall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  callee: ts.Identifier,
): ClosureReceiverInstall | undefined {
  const declaration = ctx.oracle.valueDeclarationOf(callee);
  if (!declaration || !ts.isVariableDeclaration(declaration)) return undefined;
  const initializer = declaration.initializer;
  if (!initializer || !ts.isFunctionExpression(initializer) || initializer.body === undefined) return undefined;
  if (initializer.asteriskToken !== undefined) return undefined;
  if (initializer.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) === true) return undefined;
  const first = initializer.parameters[0];
  if (first && ts.isIdentifier(first.name) && first.name.text === "this") return undefined;
  if (!bodyReferencesOwnThis(initializer.body)) return undefined;

  const globalIdx = ensureCurrentThisGlobal(ctx);
  const seq = fctx.locals.length;
  return {
    globalIdx,
    recvLocal: allocLocal(fctx, `__recv_this_${seq}`, { kind: "externref" }),
    prevLocal: allocLocal(fctx, `__prev_this_${seq}`, { kind: "externref" }),
  };
}

/**
 * Consume the `thisArg` already on the stack (externref) and install it,
 * stashing the previous receiver. Replaces the legacy `drop`.
 */
export function emitClosureReceiverInstall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  install: ClosureReceiverInstall,
): void {
  fctx.body.push(
    { op: "local.set", index: install.recvLocal },
    { op: "global.get", index: install.globalIdx },
    { op: "local.set", index: install.prevLocal },
    // (#4555) §10.4.3 — an `undefined` thisArg installs as "no receiver".
    ...installableReceiverInstrs(ctx, install.recvLocal),
    { op: "global.set", index: install.globalIdx },
  );
}

/**
 * Restore the saved receiver after a closure call and hand `result` straight
 * back, so a call site reads `return finishClosureReceiverCall(fctx, install,
 * compileClosureCall(…))`. A `null`/`VOID_RESULT` result left nothing on the
 * stack; anything else is parked in a typed local across the restore.
 *
 * `install === undefined` (the callee was not admitted) is a pass-through, which
 * is what keeps every unadmitted shape byte-identical.
 */
export function finishClosureReceiverCall<T extends ValType | null | symbol>(
  fctx: FunctionContext,
  install: ClosureReceiverInstall | undefined,
  result: T,
): T {
  if (!install) return result;
  const restore: Instr[] = [
    { op: "local.get", index: install.prevLocal },
    { op: "global.set", index: install.globalIdx },
  ];
  const type = innerResultValType(result);
  if (type === undefined) {
    fctx.body.push(...restore);
    return result;
  }
  const resultLocal = allocLocal(fctx, `__recv_this_res_${fctx.locals.length}`, type);
  fctx.body.push({ op: "local.set", index: resultLocal }, ...restore, { op: "local.get", index: resultLocal });
  return result;
}
