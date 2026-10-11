// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6684) The reflective member bodies for `Object.prototype.hasOwnProperty`
 * (§20.1.3.2) and `Object.prototype.propertyIsEnumerable` (§20.1.3.4) under
 * `--target standalone`.
 *
 * ## What was broken
 *
 * `makeGlue`'s `Object` arm sent both members to `emitObjectProtoOrRefusal`,
 * so the method read as a VALUE threw
 * `Object.prototype.hasOwnProperty is not yet implemented in --target
 * standalone` when called. The direct spelling `o.hasOwnProperty(k)` /
 * `Object.prototype.hasOwnProperty.call(o, k)` has its own call-site lowering
 * (object-ops.ts) and never reached the closure — but the idiom every lodash-es
 * module opens with does:
 *
 * ```js
 * var objectProto = Object.prototype;
 * var hasOwnProperty = objectProto.hasOwnProperty;
 * … hasOwnProperty.call(value, key) …
 * ```
 *
 * lodash-es's standalone-dynamic npm-compat lane died on it at module init.
 *
 * ## The body
 *
 * A routing body, like `emitObjectProtoIsPrototypeOfBody`: the own-property
 * predicate already exists as the `__hasOwnProperty` / `__propertyIsEnumerable`
 * natives the direct call path uses, so the closure calls the SAME native —
 * the value and the call can never answer differently. The closure ABI is
 * `(self, this, key)`; `memberLength` for both members is 1, so the key slot
 * exists (guarded anyway).
 *
 * Step 2 (`ToObject(this value)`) throws a TypeError for a nullish receiver;
 * the natives answer `false` for one, so the body raises it first, with the
 * same guard the evolving-nullish direct path uses.
 *
 * Every late-import-adding call runs BEFORE the first instruction, and the
 * funcIdxs are re-fetched by name afterwards (the #2039 shift discipline, see
 * object-proto-is-prototype-of.ts). Returns `null` to DECLINE — keeping the
 * pre-existing loud refusal — when a helper is unavailable.
 */
import type { ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { emitEvolvingNullishReceiverGuard } from "./builtin-prototype-brand.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";

const OWN_PREDICATE_NATIVE: ReadonlyMap<string, string> = new Map([
  ["hasOwnProperty", "__hasOwnProperty"],
  ["propertyIsEnumerable", "__propertyIsEnumerable"],
]);

/**
 * The DIRECT syntactic `….hasOwnProperty.call(X, k)` /
 * `….propertyIsEnumerable.call(X, k)` keeps its legacy lowering (the #3021
 * `(X).hasOwnProperty(k)` introspection fold), exactly as #4119 keeps
 * `Object.prototype.toString.call` on its fold. Before this module wired a
 * body, the reflective `.call` interception (calls.ts) declined for these
 * members — the refusal made `ensureStandaloneNativeMethodClosure` yield
 * nothing — and the fold won. The fold reads the receiver ARGUMENT's static
 * type and answers a class CONSTRUCTOR from its static surface; the runtime
 * `__hasOwnProperty` has no class-object arm (#5195 R2-2), so routing the
 * direct form through this closure answered `true` for
 * `Object.prototype.hasOwnProperty.call(C, "field")` — 124 standalone
 * class/elements rows (merge_group run 36285181870). Value-erased spellings
 * (`var hop = objectProto.hasOwnProperty; hop.call(o, k)` — lodash-es) give
 * the fold no receiver to read and keep the closure.
 */
export function objectOwnPredicateCallKeepsFold(ifaceName: string, member: string, receiver: ts.Expression): boolean {
  return ifaceName === "Object" && OWN_PREDICATE_NATIVE.has(member) && ts.isPropertyAccessExpression(receiver);
}

export function emitObjectProtoOwnPredicateBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  member: string,
): ValType | null {
  const nativeName = OWN_PREDICATE_NATIVE.get(member);
  if (nativeName === undefined || !(ctx.standalone || ctx.wasi)) return null;
  ensureLateImport(ctx, nativeName, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  ensureLateImport(ctx, "__box_boolean", [{ kind: "i32" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (ctx.funcMap.get(nativeName) === undefined || ctx.funcMap.get("__box_boolean") === undefined) return null;
  emitEvolvingNullishReceiverGuard(ctx, fctx, member, 1);
  // Re-fetch AFTER the guard: its throw builder may register late helpers.
  const predicateIdx = ctx.funcMap.get(nativeName)!;
  const boxBoolIdx = ctx.funcMap.get("__box_boolean")!;
  fctx.body.push({ op: "local.get", index: 1 }); // O = `this`
  fctx.body.push(fctx.params.length > 2 ? { op: "local.get", index: 2 } : { op: "ref.null.extern" });
  fctx.body.push({ op: "call", funcIdx: predicateIdx });
  fctx.body.push({ op: "call", funcIdx: boxBoolIdx });
  return { kind: "externref" };
}
