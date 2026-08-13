// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3191 — bloat S1) Canonical JS-error-throw lowering, hoisted into a
 * **layering-safe leaf module**. Runtime modules (`dataview-native.ts`,
 * `native-proto.ts`, `array-methods.ts`, `collections-es2025.ts`, …) must NOT
 * import from `expressions/` (the front-end layer, #3029), yet they all need to
 * emit a catchable JS-error throw. Before this slice the same instruction
 * template was hand-rolled in ≥4 places; they now all route through the shared
 * builders here.
 *
 * `expressions/helpers.ts` re-exports the whole surface so existing front-end
 * importers are unaffected. This module imports ONLY from leaf layers
 * (`native-strings`, `registry/*`, `shared`) — never from `expressions/` — so it
 * introduces no import cycle.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

/**
 * #1473 — No-JS-host predicate. Both `--target wasi` and `--target standalone`
 * run without a JS runtime, so neither can rely on host imports such as
 * `__throw_type_error` / `__new_TypeError` resolving to JS constructors. In
 * these modes the compiler emits Wasm-native Error constructors instead.
 */
export function noJsHost(ctx: CodegenContext): boolean {
  return ctx.wasi || ctx.standalone;
}

/** Select the in-module ECMAScript Error provider even when JavaScript supplies capabilities. */
export function usesNativeJsErrors(ctx: CodegenContext): boolean {
  return noJsHost(ctx) || ctx.targetProfile.semanticProviders === "native-first";
}

/** The real-instance JS error kinds that have an `__new_<Kind>` constructor. */
export type JsErrorKind = "TypeError" | "RangeError" | "ReferenceError" | "SyntaxError" | "Error";

/**
 * (#3175) Build the real-instance `<Kind>`-throw lowering as a terminal
 * instruction sequence (does not push), so it can be spliced into a nested
 * `if.then` array (a CONDITIONAL throw — e.g. the `Number.prototype.toString`
 * out-of-2..36 / `toFixed` out-of-0..100 RangeError gates). Those gates
 * previously threw a BARE STRING via the shared `$exc` tag, so
 * `e instanceof RangeError` was false and the raw-`try`/`catch` corpus failed.
 *
 * Dual-mode: in no-JS-host mode (`--target standalone`/`wasi`) the constructor
 * is the in-module `emitWasiErrorConstructor` function, so no unsatisfiable
 * `env::__new_<Kind>` host import is requested; the constructor is registered
 * BEFORE the funcIdx is resolved so `ensureLateImport` finds the in-module
 * function in funcMap. Leaves nothing on the value stack (the `throw` is
 * terminal / stack-polymorphic).
 *
 * (#3191) The two real divergences of the former hand-rolled copies are
 * parameterized via `opts` instead of separate copies:
 *  - `opts.flush` — a `FunctionContext` to flush late-import index shifts
 *    against. The front-end pushers pass their `fctx` (code has already been
 *    emitted into `fctx.body`, so those funcIdxs must be relocated after
 *    `ensureLateImport` may have shifted them). The DataView accessors build the
 *    throw template BEFORE emitting the body (funcIdx-capture ordering,
 *    `dataview-native.ts:620-627`) and flush themselves later, so they omit it.
 *    Omitting `flush` is NOT the #1839 index-shift hazard for those callers
 *    precisely because nothing has been emitted into the body yet.
 *  - `opts.forceInModuleCtor` — always emit the in-module `__new_<Kind>` (via
 *    `emitWasiErrorConstructor` + `funcMap`), regardless of `noJsHost`. The
 *    native-proto brand-check throw uses this so its host-mode codegen is
 *    unchanged by the unification (it always used the in-module constructor).
 */
export function buildThrowJsErrorInstrs(
  ctx: CodegenContext,
  kind: JsErrorKind,
  message: string,
  opts?: { flush?: FunctionContext; forceInModuleCtor?: boolean },
): Instr[] {
  const inModule = opts?.forceInModuleCtor === true || usesNativeJsErrors(ctx);
  if (inModule) emitWasiErrorConstructor(ctx, kind, 1);
  addStringConstantGlobal(ctx, message);
  const ctorIdx = opts?.forceInModuleCtor
    ? ctx.funcMap.get(`__new_${kind}`)
    : ensureLateImport(ctx, `__new_${kind}`, [{ kind: "externref" }], [{ kind: "externref" }]);
  if (opts?.flush) flushLateImportShifts(ctx, opts.flush);
  const tagIdx = ensureExnTag(ctx);
  const instrs: Instr[] = [...stringConstantExternrefInstrs(ctx, message)];
  // If the constructor isn't available, the message externref is still on the
  // stack — degrade to throwing a string. Both paths produce the same tag.
  if (ctorIdx !== undefined) {
    instrs.push({ op: "call", funcIdx: ctorIdx });
  }
  instrs.push({ op: "throw", tagIdx });
  return instrs;
}

/**
 * #1365 — Emit a Wasm throw of a real JS Error INSTANCE (not a bare string).
 * Pushes the terminal sequence onto `fctx.body`, self-flushing late-import
 * shifts against it. Required for spec-compliant `assert.throws(<Kind>, fn)`
 * test262 cases — those check `e instanceof <Kind>` on the caught value.
 *
 * Leaves nothing on the value stack (the `throw` is terminal / stack-polymorphic).
 */
export function emitThrowJsError(ctx: CodegenContext, fctx: FunctionContext, kind: JsErrorKind, message: string): void {
  fctx.body.push(...buildThrowJsErrorInstrs(ctx, kind, message, { flush: fctx }));
}

/**
 * #1365 — Emit a throw of a real TypeError INSTANCE. Canonical call-site name
 * (many uses). Required for `assert.throws(TypeError, fn)`.
 */
export function emitThrowTypeError(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  emitThrowJsError(ctx, fctx, "TypeError", message);
}

/**
 * #1473 — Emit a throw of a ReferenceError INSTANCE for TDZ / unresolved
 * identifier references. Mirrors `emitThrowTypeError`.
 */
export function emitThrowReferenceError(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  emitThrowJsError(ctx, fctx, "ReferenceError", message);
}

/**
 * #2164 — Emit a throw of a RangeError INSTANCE. Mirrors `emitThrowTypeError`.
 */
export function emitThrowRangeError(ctx: CodegenContext, fctx: FunctionContext, message: string): void {
  emitThrowJsError(ctx, fctx, "RangeError", message);
}

/**
 * (#2200 / #3980) Emit `<name> is not defined` for an Annex B B.3.3 name whose
 * web-compat var binding was NOT created (creating it would have been an Early
 * Error), and leave an `externref` on the stack for the caller's type contract.
 * Shared by the per-FunctionContext detector (`fctx.annexBCancelled`) and the
 * whole-SourceFile one (`collectAnnexBCancelSites`).
 *
 * Unlike `emitThrowReferenceError` this keeps the pre-existing host-lane
 * behaviour of routing through the `__throw_reference_error` late import when a
 * JS host is present, falling back to a bare `throw` on the exception tag.
 */
export function emitAnnexBUnboundReferenceError(ctx: CodegenContext, fctx: FunctionContext, name: string): ValType {
  const msg = `${name} is not defined`;
  if (usesNativeJsErrors(ctx)) {
    emitThrowReferenceError(ctx, fctx, msg);
    fctx.body.push({ op: "unreachable" });
    return { kind: "externref" };
  }
  const throwRefErrIdx = ensureLateImport(ctx, "__throw_reference_error", [{ kind: "externref" }], []);
  flushLateImportShifts(ctx, fctx);
  if (throwRefErrIdx !== undefined) {
    addStringConstantGlobal(ctx, msg);
    const strIdx = ctx.stringGlobalMap.get(msg)!;
    fctx.body.push({ op: "global.get", index: strIdx });
    fctx.body.push({ op: "call", funcIdx: throwRefErrIdx });
    fctx.body.push({ op: "unreachable" });
  } else {
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "ref.null.extern" });
    fctx.body.push({ op: "throw", tagIdx });
  }
  return { kind: "externref" };
}
