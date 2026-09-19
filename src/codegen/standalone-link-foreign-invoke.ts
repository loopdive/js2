// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6643) `Function.prototype.{call,apply}` on a value a linked standalone
 * PROVIDER owns.
 *
 * ## The defect, as measured
 *
 * In a `--target standalone` LINK CONSUMER, `f.apply(thisArg, args)` where `f`
 * came across the provider boundary (`Temporal.PlainDate.from`, an object-bag
 * method, a `X.prototype.m` read) answered **`null`**, silently, and
 * `f.call(…)` threw `Function.prototype.call called on non-callable receiver`
 * — while the very same `f(…)` called directly worked.
 *
 * It is NOT a call-site lowering bug: both spellings lower to
 * `__extern_method_call(f, "apply"|"call", [thisArg, …])` in EVERY module. The
 * break is switched on by an unrelated feature of the module. A consumer that
 * merely CONTAINS `Object.getPrototypeOf(<provider instance>) === C.prototype`
 * materialises `%Function.prototype%`, and from then on the `apply`/`call`
 * member RESOLVES (to the #6630 companion glue) instead of missing — so the
 * ladder stops falling through to the `__js2wasm_link_method_call` terminal
 * (which hands the whole operation to the provider, and is correct) and
 * instead invokes the consumer's own glue, which funnels into
 * `__apply_closure(f, thisArg, vec)`.
 *
 * Reduced on the fixture in `tests/issue-6643-*.test.ts`: with the
 * `getPrototypeOf` probe present, a provider method that increments a
 * provider-side counter was **never entered** (counter stayed 0) and the call
 * answered null; without it, the same source answered 42 and the counter read
 * 1. Against the real `@js-temporal/polyfill` provider this is the FIRST
 * assertion of test262's `checkSubclassingIgnoredStatic`, which is why
 * `PlainDate/from/subclassing-ignored.js` and its `Duration` twin died before
 * any subclass existed.
 *
 * ## Why `__apply_closure`'s existing peer arm was not enough
 *
 * #6420 already routes a peer-owned callable out of `__apply_closure` to the
 * provider's own `__apply_closure` (`__js2wasm_link_apply`). Instrumentation
 * (an `unreachable` spliced into that arm) confirms the arm IS taken — and it
 * still answers null, because the value the consumer holds for a provider
 * method is the provider's method-closure SINGLETON, whose trampoline resolves
 * `this` from the provider's `__current_this` global. That is the same carrier
 * #5383 S2h documented as un-invokable through a raw apply, and the reason the
 * `methodCall` terminal exists at all. The provider's `__apply_closure` cannot
 * dispatch it either — measured with a zero-argument call, so this is not
 * argument marshalling.
 *
 * ## The fix
 *
 * Prefer the provider's OWN `Function.prototype.apply` over the provider's
 * `__apply_closure`: ask the peer for `fn.apply` and, when the peer says that
 * value is callable, re-enter through the existing `methodCall` terminal as
 * `fn["apply"](thisArg, argArray)`. That is byte-for-byte the route a consumer
 * WITHOUT `%Function.prototype%` already takes and which already answers
 * correctly, including argument count and `this` binding.
 *
 * Three properties this shape buys, each of which cost a measurement:
 *
 * - **No double invocation.** The probe is `member_get` + `callable_kind`,
 *   both side-effect-free, so the decision is made BEFORE anything runs. A
 *   "try apply, fall back on null" shape would re-invoke a provider function
 *   that legitimately returned `undefined`.
 * - **Absent-not-wrong.** A provider that does not resolve `apply` on its own
 *   callables (no `%Function.prototype%` materialised there) makes the probe
 *   false and keeps the exact `__js2wasm_link_apply` answer it has today.
 * - **Zero cost off the lane.** Every helper is looked up through
 *   `standaloneLinkBoundaryPeerIndex`, which answers `undefined` unless this
 *   module CONSUMES a standalone provider. A module with no linked provider —
 *   which is every module in the byte corpus and every provider module —
 *   emits none of this.
 *
 * `IsCallable` gets the same treatment: `%Function.prototype%.{call,apply,bind}`
 * guard their receiver with `__typeof_function`, which has no peer arm, so a
 * provider-owned callable was rejected outright (the `.call` TypeError above).
 * {@link linkedForeignCallableBitInstrs} supplies the missing disjunct.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { standaloneLinkBoundaryPeerIndex } from "./standalone-link-boundary.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";

/**
 * `1` when `local.get <valueLocal>` is a callable owned by the linked
 * provider, `0` otherwise — or `undefined` when this module consumes no
 * standalone provider, in which case the caller must emit nothing.
 *
 * Leaves exactly one `i32` on the stack.
 */
export function linkedForeignCallableBitInstrs(ctx: CodegenContext, valueLocal: number): Instr[] | undefined {
  const callableKindIdx = standaloneLinkBoundaryPeerIndex(ctx, "callableKind");
  if (callableKindIdx === undefined) return undefined;
  return [
    { op: "local.get", index: valueLocal },
    { op: "call", funcIdx: callableKindIdx },
    { op: "i32.const", value: 1 },
    { op: "i32.and" },
  ];
}

/**
 * The `__apply_closure` arm described in the file header, for the fixed ABI
 * `0 = target`, `1 = thisArg`, `2 = args vec`.
 *
 * Returns `undefined` — emit nothing, keep the caller's existing arm — when
 * any terminal or `$ObjVec` builder is missing. `scratchLocal` must be an
 * `externref` local the caller has already declared.
 */
export function linkedForeignApplyViaPeerInstrs(
  ctx: CodegenContext,
  scratchLocal: number,
  objVecNewIdx: number,
  objVecPushIdx: number,
): Instr[] | undefined {
  const callableKindIdx = standaloneLinkBoundaryPeerIndex(ctx, "callableKind");
  const memberGetIdx = standaloneLinkBoundaryPeerIndex(ctx, "memberGet");
  const methodCallIdx = standaloneLinkBoundaryPeerIndex(ctx, "methodCall");
  if (callableKindIdx === undefined || memberGetIdx === undefined || methodCallIdx === undefined) return undefined;
  // Registered here rather than at a call site: under `nativeStrings` (always
  // true on this lane) a string constant materialises INLINE, so this adds no
  // import and cannot shift the frozen function index space (#1984).
  addStringConstantGlobal(ctx, "apply");
  const applyKey = stringConstantExternrefInstrs(ctx, "apply");
  return [
    // scratch = peer.memberGet(target, "apply")
    { op: "local.get", index: 0 },
    ...applyKey,
    { op: "call", funcIdx: memberGetIdx },
    { op: "local.set", index: scratchLocal },
    ...(linkedForeignCallableBitInstrs(ctx, scratchLocal) ?? []),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...(process.env.JS2WASM_DEBUG_6643_TRAP2 ? ([{ op: "unreachable" }] as Instr[]) : []),
        // return peer.methodCall(target, "apply", [thisArg, argsVec])
        { op: "call", funcIdx: objVecNewIdx },
        { op: "local.set", index: scratchLocal },
        { op: "local.get", index: scratchLocal },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: objVecPushIdx },
        { op: "local.get", index: scratchLocal },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: objVecPushIdx },
        { op: "local.get", index: 0 },
        ...applyKey,
        { op: "local.get", index: scratchLocal },
        { op: "call", funcIdx: methodCallIdx },
        { op: "return" },
      ],
    },
  ];
}
