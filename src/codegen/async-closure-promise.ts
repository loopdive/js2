// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4648) JS-host promise wrapper for an AWAIT-FREE async function expression
 * that reaches the host-callback bridge.
 *
 * ## The gap
 *
 * An async function with no `await` is declined by the frame engine
 * (`asyncFnNeedsHostDrive` → false) and compiled as the "legacy synchronous
 * pass-through": a plain Wasm function that returns the body's value and lets a
 * `throw` unwind normally. That is only correct because the CALL SITE repairs
 * it — `isAsyncCallExpression` (expressions.ts) wraps the result in
 * `Promise_resolve` and the whole call in a try/catch that turns a synchronous
 * throw into `Promise_reject`.
 *
 * That repair is STATIC. When the function escapes as a value to a HOST callee
 * the caller cannot see the `async` modifier, so no repair happens:
 *
 *     assert.throwsAsync(Error, async function () { throw new Error(); });
 *     // inside the harness:  res = func();   → threw SYNCHRONOUSLY,
 *     //                                        and res was not a thenable
 *
 * (`asyncHelpers-throwsAsync-native`.) The `__cb_<id>` export is what the host
 * bridge invokes, so giving THAT the async contract fixes the whole class.
 *
 * ## Reserve, then FILL AT FINALIZE — not "emit now"
 *
 * The wrapper body calls three things by index: the raw body, `Promise_resolve`
 * and `Promise_reject`. Every one of those indices MOVES when a later late
 * import is inserted, and a body written during compilation is not re-walked
 * reliably — the first cut baked them at emit time and the module came out
 * calling `isNegativeZero` / `__box_number` / `isPrimitive` instead, i.e.
 * six pass→compile_error regressions with "type error in fallthru[0] (expected
 * externref, got i32)". Nothing about the SHAPE was wrong; the indices were
 * stale. So this module follows the same reserve/fill discipline as
 * `accessor-driver.ts` and `host-fnctor-method-driver.ts`: mint a stable
 * handle with a placeholder body while compiling, and resolve every callee BY
 * NAME at finalize, once the import section has settled.
 *
 * ## Scope
 *
 * - **JS-host only** (it uses the host Promise imports); standalone/wasi keep
 *   their existing lowering byte-identical.
 * - **Callback bridge only.** The first cut also wrapped the closure-struct
 *   path (`compileArrowAsClosure`) and broke three equivalence tests; that path
 *   is left alone — its call sites are the ones the static repair covers.
 * - The raw body stays in `funcMap` under `<cb>__async_body`, so nothing that
 *   resolves the body by name is redirected through the Promise.
 *
 * Escape hatch: `JS2WASM_ASYNC_CLOSURE_PROMISE=0`.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./index.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureExnTag } from "./registry/imports.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";

const EXTERNREF: ValType = { kind: "externref" };

interface ReservedWrapper {
  /** funcMap key of the RAW body this wrapper forwards to. */
  readonly bodyName: string;
  /** funcMap key of the wrapper itself. */
  readonly wrapperName: string;
  readonly paramCount: number;
}

const reservedByCtx = new WeakMap<CodegenContext, ReservedWrapper[]>();

/** Is the host-lane async-closure promise wrapper enabled? (escape hatch: `=0`) */
export function asyncClosurePromiseWrapEnabled(ctx: CodegenContext): boolean {
  if (ctx.standalone === true || ctx.wasi === true) return false;
  return process.env.JS2WASM_ASYNC_CLOSURE_PROMISE !== "0";
}

/**
 * Reserve `<bodyName>__async_promise`: same params as the raw body, `externref`
 * (Promise) result, placeholder body filled by
 * {@link fillAsyncClosurePromiseWrappers} at finalize.
 *
 * Returns the wrapper's funcIdx, or `undefined` when the wrapper cannot be
 * built — the caller then keeps the previous (un-wrapped) lowering. The refusal
 * cases are decided HERE, while the caller can still fall back:
 *
 *  - a required host import is unavailable;
 *  - the body's settled result is not something `Promise_resolve` takes
 *    verbatim. `resolveWasmTypeForClosureReturn` lowers a `Promise<boolean>`-ish
 *    signature to a raw `i32`, and boxing that would have to guess boolean vs
 *    number — guessing wrong is a silent `true` → `1`. Decline instead.
 */
export function reserveAsyncClosurePromiseWrapper(
  ctx: CodegenContext,
  bodyName: string,
  liftedParams: readonly ValType[],
  ensureImport: (name: string, params: ValType[], results: ValType[]) => number | undefined,
): number | undefined {
  if (
    ensureImport("Promise_resolve", [EXTERNREF], [EXTERNREF]) === undefined ||
    ensureImport("Promise_reject", [EXTERNREF], [EXTERNREF]) === undefined ||
    ensureImport("__get_caught_exception", [], [EXTERNREF]) === undefined
  ) {
    return undefined;
  }
  const bodyIdx = ctx.funcMap.get(bodyName);
  if (bodyIdx === undefined) return undefined;
  const bodyFunc = definedFuncAt(ctx, bodyIdx);
  if (!bodyFunc) return undefined;
  const bodyType = ctx.mod.types[bodyFunc.typeIdx];
  if (bodyType === undefined || bodyType.kind !== "func") return undefined;
  if (bodyType.results.length > 1) return undefined;
  if (bodyType.results.length === 1 && bodyType.results[0]!.kind !== "externref") return undefined;

  const wrapperName = `${bodyName}__async_promise`;
  const typeIdx = addFuncType(ctx, [...liftedParams], [EXTERNREF], `$${wrapperName}_type`);
  const wrapperIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, wrapperIdx, {
    name: wrapperName,
    typeIdx,
    locals: [],
    // Placeholder; replaced by the fill below. A bare `unreachable` keeps the
    // stub valid (externref result) if the fill is ever skipped.
    body: [{ op: "unreachable" }],
    exported: false,
  });
  ctx.funcMap.set(wrapperName, wrapperIdx);
  let reserved = reservedByCtx.get(ctx);
  if (!reserved) {
    reserved = [];
    reservedByCtx.set(ctx, reserved);
  }
  reserved.push({ bodyName, wrapperName, paramCount: liftedParams.length });
  return wrapperIdx;
}

/**
 * Fill every reserved wrapper AFTER the import section has settled. Every
 * callee is resolved BY NAME from `funcMap` here — that map is kept in step by
 * the import-shift fixup, which is exactly what a baked index is not.
 *
 * A missing helper degrades to "call the body and return its value" (or
 * `undefined` for a void body) rather than an ill-typed call: type-correct, and
 * observably the pre-#4648 behaviour.
 */
export function fillAsyncClosurePromiseWrappers(ctx: CodegenContext): void {
  const reserved = reservedByCtx.get(ctx);
  if (!reserved || reserved.length === 0) return;
  for (const record of reserved) {
    const wrapperIdx = ctx.funcMap.get(record.wrapperName);
    if (wrapperIdx === undefined) continue;
    const wrapper = definedFuncAt(ctx, wrapperIdx);
    if (!wrapper) continue;
    const bodyIdx = ctx.funcMap.get(record.bodyName);
    if (bodyIdx === undefined) continue;
    const bodyFunc = definedFuncAt(ctx, bodyIdx);
    const bodyType = bodyFunc ? ctx.mod.types[bodyFunc.typeIdx] : undefined;
    const bodyReturnsValue = bodyType !== undefined && bodyType.kind === "func" && bodyType.results.length === 1;

    const forward: Instr[] = [];
    for (let i = 0; i < record.paramCount; i++) forward.push({ op: "local.get", index: i });
    forward.push({ op: "call", funcIdx: bodyIdx });
    if (!bodyReturnsValue) forward.push({ op: "ref.null.extern" });

    const resolveIdx = ctx.funcMap.get("Promise_resolve");
    const rejectIdx = ctx.funcMap.get("Promise_reject");
    const getCaughtIdx = ctx.funcMap.get("__get_caught_exception");
    if (resolveIdx === undefined || rejectIdx === undefined || getCaughtIdx === undefined) {
      wrapper.body = forward;
      continue;
    }
    const inner: Instr[] = [...forward, { op: "call", funcIdx: resolveIdx }];
    // A compiler-native throw carries the thrown JS value as the `$exn` tag's
    // externref payload; `catch_all` covers a throwing host import, whose value
    // comes from the runtime's caught-exception slot. Same split as the
    // call-site repair in expressions.ts.
    const tagIdx = ensureExnTag(ctx);
    wrapper.body = [
      buildTargetTaggedTry(
        ctx,
        { kind: "val", type: EXTERNREF },
        inner,
        [{ tagIdx, body: [{ op: "call", funcIdx: rejectIdx }] }],
        [
          { op: "call", funcIdx: getCaughtIdx },
          { op: "call", funcIdx: rejectIdx },
        ],
      ),
    ];
  }
}
