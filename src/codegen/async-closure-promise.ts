// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4648) JS-host promise wrapper for an AWAIT-FREE async function expression.
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
 * That repair is STATIC. When the closure escapes as a value and is invoked
 * through a dynamic callee the caller cannot see the `async` modifier, so no
 * repair happens:
 *
 *     assert.throwsAsync(Error, async function () { throw new Error(); });
 *     // inside the harness:  res = func();   → threw SYNCHRONOUSLY,
 *     //                                        and res was not a thenable
 *
 * (`asyncHelpers-throwsAsync-native` / `-custom-typeerror`: "Expected a Error
 * to be thrown asynchronously but the function threw synchronously".)
 *
 * ## The fix
 *
 * Give the CLOSURE the async contract instead of relying on the call site:
 * the struct's funcref points at a wrapper that calls the raw body inside a
 * try/catch and returns `Promise_resolve(value)` / `Promise_reject(reason)`.
 *
 * Deliberate scope:
 *  - **JS-host only.** It uses the host `Promise_resolve`/`Promise_reject`
 *    imports; standalone/wasi keep their existing lowering byte-identical.
 *  - **The raw body stays in `funcMap` under the closure name**, so DIRECT
 *    (devirtualized) call sites keep calling it unwrapped — those are exactly
 *    the sites the static call-site repair already covers, and routing them
 *    through the wrapper would double-wrap.
 *  - Double-wrapping on the dynamic path is harmless on this lane anyway: the
 *    host `Promise.resolve` assimilates a thenable (the same reason the
 *    `Promise.resolve(v)` re-wrap note in expressions.ts calls it harmless).
 *
 * Known residual: the js-host legacy `await` is an identity pass-through
 * (expressions.ts), so `await <closure call>` in a body no engine drives now
 * observes a Promise object where it used to observe the raw value. Set
 * `JS2WASM_ASYNC_CLOSURE_PROMISE=0` to restore the previous lowering.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./index.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { ensureExnTag } from "./registry/imports.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";

const EXTERNREF: ValType = { kind: "externref" };

/** Is the host-lane async-closure promise wrapper enabled? (escape hatch: `=0`) */
export function asyncClosurePromiseWrapEnabled(ctx: CodegenContext): boolean {
  if (ctx.standalone === true || ctx.wasi === true) return false;
  return process.env.JS2WASM_ASYNC_CLOSURE_PROMISE !== "0";
}

/**
 * Mint `<closureName>__async_promise`: same signature as the lifted body but
 * with an `externref` (Promise) result, forwarding every parameter.
 *
 * Returns the wrapper's funcIdx, or `undefined` when a required host import is
 * unavailable (the caller then keeps the raw body as the closure's funcref).
 *
 * The late imports are registered FIRST and the raw body's index is re-read
 * from `funcMap` afterwards: adding an import shifts the whole defined-function
 * index space, so a value captured before the shift would name another
 * function.
 */
export function emitAsyncClosurePromiseWrapper(
  ctx: CodegenContext,
  closureName: string,
  liftedParams: readonly ValType[],
  ensureImport: (name: string, params: ValType[], results: ValType[]) => number | undefined,
): number | undefined {
  const resolveIdx = ensureImport("Promise_resolve", [EXTERNREF], [EXTERNREF]);
  const rejectIdx = ensureImport("Promise_reject", [EXTERNREF], [EXTERNREF]);
  const getCaughtIdx = ensureImport("__get_caught_exception", [], [EXTERNREF]);
  if (resolveIdx === undefined || rejectIdx === undefined || getCaughtIdx === undefined) return undefined;
  const bodyIdx = ctx.funcMap.get(closureName);
  if (bodyIdx === undefined) return undefined;
  const bodyFunc = definedFuncAt(ctx, bodyIdx);
  if (!bodyFunc) return undefined;

  const name = `${closureName}__async_promise`;
  const typeIdx = addFuncType(ctx, [...liftedParams], [EXTERNREF], `$${name}_type`);
  const inner: Instr[] = [];
  for (let i = 0; i < liftedParams.length; i++) inner.push({ op: "local.get", index: i });
  inner.push({ op: "call", funcIdx: bodyIdx });
  // A void body (`async function () { … }` with no returned value) leaves
  // nothing on the stack — resolve with `undefined` rather than mis-typing the
  // `Promise_resolve` operand.
  const bodyType = ctx.mod.types[bodyFunc.typeIdx];
  const bodyResults = bodyType !== undefined && bodyType.kind === "func" ? bodyType.results.length : 1;
  if (bodyResults === 0) inner.push({ op: "ref.null.extern" });
  inner.push({ op: "call", funcIdx: resolveIdx });

  // A compiler-native throw carries the thrown JS value as the `$exn` tag's
  // externref payload; `catch_all` covers a throwing host import, whose value
  // is retrieved from the runtime's caught-exception slot. Same split as the
  // call-site repair in expressions.ts.
  const tagIdx = ensureExnTag(ctx);
  const body: Instr[] = [
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

  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals: [], body, exported: false });
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}
