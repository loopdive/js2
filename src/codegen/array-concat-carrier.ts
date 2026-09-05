// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4655) The ONE place that answers "will this `Array.prototype.concat` call
 * produce a DYNAMIC (`$ObjVec` externref) carrier rather than a typed WasmGC
 * vec?" — asked by the concat lowering itself and, independently, by every site
 * that must mint the SLOT the result lands in (module global, function local,
 * generator spill).
 *
 * ## Why a shared predicate instead of a local check at each site
 *
 * The measured defect is a slot/value DESYNC, not a lowering bug. On
 * `--target standalone`, `x.concat(y)` with a non-array `y` already lowers
 * correctly through the §23.1.3.1 native spec loop (`array-concat-spec.ts`) and
 * yields a `$ObjVec` externref that answers `arr[1] === y` **true**. The value
 * is then stored into a slot TypeScript typed from the lib signature
 * `concat(...items): number[]`, and the `externref → (ref null $__vec_f64)`
 * coercion runs the per-vec materializer, which ToNumbers every element:
 *
 * ```js
 * var x = [0], y = new Object();
 * x.concat(y)[1] === y;            // true   — read off the call expression
 * var b = x.concat(y); b[1] === y; // FALSE  — NaN, the object died in the slot
 * ```
 *
 * (`.tmp/probes/c3-object-arg-nostore.js` / `c4-store-vs-nostore.js`,
 * standalone, measured 2026-08-24 on the campaign tip.) TypeScript's `number[]`
 * return type is simply not true of `Array.prototype.concat` in JS, and the
 * corpus rows `concat/S15.4.4.4_A1_T2` / `_A1_T4` are exactly this shape.
 *
 * The hazard in fixing it is the one this file exists to remove: if the slot
 * typer and the lowering dispatcher disagree about WHICH concats are dynamic,
 * the desync simply moves (a vec value stored into an externref slot, or the
 * reverse). `statements/variables.ts` carries half a dozen comments saying
 * "MUST stay in lock-step with …" for exactly this class of bug. So both sides
 * call the same function, and the function is deliberately CONSERVATIVE: it
 * only answers `true` for shapes whose dispatch is decided by STATIC
 * information alone.
 *
 * ## What it deliberately does NOT claim
 *
 * `compileArrayConcat`'s typed fast path also depends on things a slot typer
 * cannot see: the receiver's runtime-probed carrier (`receiverIsExternref`) and
 * the arg's registered vec type index vs the receiver's. The single-argument
 * case turns on precisely those, so this predicate declines it (`false`) and
 * that shape keeps today's behaviour. Absent-not-wrong (brief methodology 4): a
 * missing widening leaves a pre-existing bug in place, a WRONG widening creates
 * a new one.
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/**
 * (#4655) Does this module have to route `Array.prototype.concat` through the
 * §23.1.3.1 spec loop because an index may resolve through the PROTOTYPE CHAIN?
 *
 * The typed vec fast path copies the receiver's own backing with `array.copy`
 * and never performs `Get(O, k)`, so it cannot see an index that lives on
 * `Array.prototype` / `Object.prototype`. Measured on the campaign tip
 * (`.tmp/probes/c5-proto-index.js`, `c6-proto-index-a3t1.js`, and the
 * no-concat control `c7-proto-index-noconcat.js`): the DIRECT read already
 * walks the chain correctly (`a[2] === 2` true, `a.hasOwnProperty("2")` false),
 * while the same index through a 0-argument `concat` answers `false` — the read
 * path and the copy path disagree about one index.
 *
 * The gate is `ctx.protoIndexDirty`, the #4160 pre-scan flag set only by a
 * module that writes an INDEX onto a builtin prototype (and unconditionally by
 * `dynamicCodeDirty`, since `eval` could perform that write after the pre-scan
 * has run). This is the SAME gate `array-join-proto-hole.ts` (#4491 lane J) uses
 * for the identical disagreement in `join`, and for the same reason: with the
 * flag clear a hole cannot inherit anything, `array.copy` is exactly right, and
 * the emitted bytes do not move at all.
 *
 * Restricted to `native-first` providers (`--target standalone` / `--target
 * wasi`). The JS-host lane's fallback is the `env::__array_concat_any` bridge,
 * which delegates the whole operation to the host and already gets the
 * prototype walk right; routing it through the native loop would move bytes on
 * a lane with nothing to gain.
 */
export function concatMustConsultPrototypeChain(ctx: CodegenContext): boolean {
  return ctx.targetProfile.semanticProviders === "native-first" && ctx.protoIndexDirty === true;
}

/** Strip the wrappers that can sit between a declaration and its call initializer. */
function unwrap(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * Is the receiver array-shaped — i.e. could this call reach
 * `compileArrayMethodCall` at all?
 *
 * Asked of `ctx.oracle`, not of the raw checker and not of `resolveArrayInfo`:
 *
 * - The oracle is the project's mandated type-info boundary and the query is
 *   exactly one it already answers (`typeFactOf` returns `array`/`tuple`).
 * - `resolveArrayInfo` would be worse than merely off-boundary. The slot typers
 *   run in `collectDeclarations`, before any body is compiled, and it goes
 *   through `resolveWasmType`, which MINTS vec types on demand. Minting a type
 *   earlier than the base tree does renumbers the type section for every module
 *   containing a concat — byte churn with no behavioural content, and
 *   indistinguishable from a real change in a `wasm_sha` comparison.
 *   `typeFactOf` is memoized per node and allocates nothing in the module.
 *
 * The one thing it must not do is admit a STRING receiver: `String.prototype.
 * concat` returns a string and is lowered somewhere else entirely.
 */
function receiverIsArrayShaped(ctx: CodegenContext, receiver: ts.Expression): boolean {
  const fact = ctx.oracle.typeFactOf(receiver);
  return fact.kind === "array" || fact.kind === "tuple";
}

/**
 * (#4655) Will the value produced by `expr` be a dynamic `$ObjVec` externref
 * rather than the typed vec TypeScript's `concat(...items): T[]` signature
 * promises?
 *
 * Answers `true` only for the two statically-decidable shapes:
 *
 * 1. **Two or more arguments.** Every branch of `compileArrayConcat` that sees
 *    `arguments.length > 1` routes to the native spec loop under a
 *    `native-first` provider (directly, or via `compileArrayConcatExtern`
 *    which tries the spec loop first) — the typed fast path handles a single
 *    argument only. The receiver's runtime carrier does not enter into it: an
 *    externref receiver also routes to the spec loop.
 * 2. **`concatMustConsultPrototypeChain`.** With that gate on, the lowering
 *    sends EVERY arity — including 0 — to the spec loop, so every result is an
 *    `$ObjVec`.
 *
 * Zero arguments with the gate off, and one argument in any configuration, both
 * answer `false`: their dispatch depends on the runtime receiver probe and on
 * vec-type-index equality, neither of which is available here.
 */
export function concatCallYieldsDynamicCarrier(ctx: CodegenContext, expr: ts.Expression | undefined): boolean {
  if (expr === undefined) return false;
  if (ctx.targetProfile.semanticProviders !== "native-first") return false;
  const call = unwrap(expr);
  if (!ts.isCallExpression(call)) return false;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "concat") return false;
  if (!receiverIsArrayShaped(ctx, callee.expression)) return false;
  return call.arguments.length > 1 || concatMustConsultPrototypeChain(ctx);
}
