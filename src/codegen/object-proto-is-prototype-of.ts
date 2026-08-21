// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491) The reflective member body for `Object.prototype.isPrototypeOf`
 * under `--target standalone` — §20.1.3.3.
 *
 * ## What was broken
 *
 * `makeGlue`'s `Object` arm sent every `Object.prototype` member except
 * `toString` to `emitObjectProtoOrRefusal`, so a *called* `isPrototypeOf`
 * threw `Object.prototype.isPrototypeOf is not yet implemented in --target
 * standalone`. That refusal is reached by the ordinary spelling
 * `b.isPrototypeOf(d)` on any receiver whose static type does not resolve to
 * one of the compile-time folds in `native-is-prototype-of.ts`: those folds
 * only fire for a receiver written literally as `Object.prototype` /
 * `Function.prototype` / `<Builtin>.prototype`, and the native runtime walk in
 * the same module only fires when the call site is dispatched through
 * `compileExternMethodCall` / the `any`-receiver resolver. A constructed
 * instance (`function base(){}; var b = new base(); b.isPrototypeOf(d)`)
 * resolves `isPrototypeOf` off `Object.prototype` and lands on the reflective
 * CLOSURE instead — which had no body.
 *
 * Measured on this branch, `--target standalone`, `runTest262File`:
 * `built-ins/Object/create/15.2.3.5-3-1.js` and `15.2.3.5-4-1.js` — 2 of the
 * 4 non-passing rows in the whole `built-ins/Object/create` bucket — fail on
 * exactly that throw, at the `b.isPrototypeOf(d)` assertion.
 *
 * ## The body
 *
 * §20.1.3.3 is a `[[Prototype]]`-chain walk over `V`, which the runtime already
 * implements as `__isPrototypeOf(O, V)` — the same native the typed call path
 * uses (`native-is-prototype-of.ts`: "the runtime walk exists ONLY host-free").
 * So this is a *routing* body, not new semantics: two params in, one call, box
 * the i32 answer.
 *
 * Steps 1–2 (a non-object `V` is `false`; a missing argument is a non-object)
 * are already the native's answers — its opening `ref.test (ref $Object)` on
 * `V` fails for a primitive/null/undefined and the loop exits before its first
 * iteration. Re-deriving them here would be a second copy of a decision the
 * walk already owns.
 *
 * The closure ABI is `(self, this, …args)`, so the receiver `O` is local 1 and
 * `V` is local 2; `memberLength.isPrototypeOf === 1` guarantees that slot
 * exists.
 *
 * ## Import ordering (the #2039 shift hazard)
 *
 * Both late-import-adding calls run BEFORE a single instruction is emitted, and
 * the funcIdxs are re-fetched BY NAME afterwards — the discipline
 * `emitStringSearchFamilyMemberBody` in this same glue spells out. A late
 * import added midway would shift the already-emitted `call` in this body,
 * which the shift fixer only repairs for `ctx.currentFunc` — and a native
 * closure body is not it.
 *
 * The answer is boxed with `__box_boolean` (never `__box_number`): standalone
 * `===` classifies `__box_boolean_struct` as a boolean, so `r === true` holds,
 * where a number box would make it `1 !== true`.
 *
 * Returns `null` to DECLINE when either helper is unavailable, so the caller
 * keeps the pre-existing loud refusal rather than emitting a half-body.
 */
import type { CodegenContext, FunctionContext } from "./context/types.js";
import type { ValType } from "../ir/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

/**
 * Emit the `Object.prototype.isPrototypeOf` reflective closure body, or return
 * `null` to leave the member on its existing refusal.
 */
export function emitObjectProtoIsPrototypeOfBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | null {
  if (member !== "isPrototypeOf") return null;
  // (1) Every late-import-adding op first — see the header.
  ensureLateImport(ctx, "__isPrototypeOf", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  ensureLateImport(ctx, "__box_boolean", [{ kind: "i32" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  // (2) Fetch the funcIdxs AFTER the shifts, by name.
  const protoIdx = ctx.funcMap.get("__isPrototypeOf");
  const boxBoolIdx = ctx.funcMap.get("__box_boolean");
  if (protoIdx === undefined || boxBoolIdx === undefined) return null;
  // (3) `memberLength` declares the arg slot (1); guard anyway so a future
  // arity change cannot read a slot that was never declared.
  const hasArgSlot = fctx.params.length > 2;
  fctx.body.push({ op: "local.get", index: 1 }); // O = `this`
  fctx.body.push(hasArgSlot ? { op: "local.get", index: 2 } : { op: "ref.null.extern" });
  fctx.body.push({ op: "call", funcIdx: protoIdx });
  fctx.body.push({ op: "call", funcIdx: boxBoolIdx });
  return { kind: "externref" };
}
