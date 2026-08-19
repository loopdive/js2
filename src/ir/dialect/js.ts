// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// The **JavaScript dialect** of the IR instruction set (#3954 phase 2, first
// slice; scheduled ahead of the `ir-full-coverage` push per the cost-of-delay
// measurement in #4551 — phase 2 is O(kinds), and kinds grew 51 -> 78 in the
// three months to 2026-08-01).
//
// Every instruction declared here encodes an **ECMAScript** protocol: the
// abstract operations behind `dyn.*` (ToBoolean / ToNumber / abstract equality
// / property lookup), the iterator protocol, generator objects, `await`, the
// JS-host extern surface including RegExp, and — since slice A — the two
// total-function string indexing operations plus the inlined string-iterator
// statement form. None of them means anything to a source language that is not
// JavaScript.
//
// The neutral core stays in `../nodes.ts`: control flow, calls, closures,
// refcells, slots, arithmetic, try/throw.
//
// **Placement here is argued, never guessed.** The first slice moved only the
// uncontested members; `scripts/check-ir-kind-neutrality.mjs` (#4551) then
// produced a per-kind verdict with cited evidence, and slice A moved the three
// kinds it judged `js` while still in core — `string.char_at`,
// `string.char_code_at`, `forof.string`. The families that came back **neutral**
// stay in core and are not candidates: `vec.*`, `class.*`, `object.*`,
// `box`/`unbox`/`tag.test`, `forof.vec`, `coerce.to_externref`, and the
// encoding-parameterized `string.const`/`string.concat`/`string.eq`. An
// `unresolved` kind (`string.len`, and the payload-vocabulary leak in
// `binary`/`intrinsic`) also stays in core — the gate's R3 rule turns a
// premature move into a build failure rather than a silent mistake.
//
// **Structure:** declaration moves and re-exports only. `nodes.ts` re-exports
// every name below, so all 54 importers are unchanged and no behaviour moves.
// The `IrInstr` union is still assembled in `nodes.ts` — that is the one
// sanctioned core->dialect edge, and `scripts/check-ir-dialect.mjs` enforces
// that it is the only one.
//
// The imports below are `import type` only: interfaces are erased, so the
// core<->dialect cycle has no runtime edge.

import type {
  IrFuncRef,
  IrFunction,
  IrInstr,
  IrInstrBase,
  IrInstrThrow,
  IrInstrWhileLoop,
  IrLabelId,
  IrTerminatorReturn,
  IrType,
  IrValueId,
  irVal,
} from "../nodes.js";
// `string-runtime.ts` sits BELOW the IR node layer (it is where the
// representation axis lives), so this is an ordinary downward edge, not a
// second core->dialect one. Type-only, like everything else here.
import type { IrStringEncoding } from "../string-runtime.js";

/**
 * (#1373 Phase B) `await <expr>` — suspend the current async function until
 * `expr`'s Promise settles, then resume with the resolved value. The IR
 * node carries the operand whose evaluation produces a Promise (or a
 * non-Promise value that must be wrapped in `Promise.resolve` before
 * suspension per spec §27.2.1.4).
 *
 * Phase B (this slice) defines the type only — no lowering. Phase C
 * (CPS transform, follow-up #1373b) splits the function at each await
 * point, lifts the post-await tail into a continuation closure, and
 * emits microtask-queue calls (`__promise_then(promise, continuation)`)
 * to schedule resumption.
 *
 * The result IrValueId carries the resolved value. Its IrType must
 * match the surrounding expression context (typically the unwrapped
 * `T` from `Promise<T>`).
 */
export interface IrInstrAwait extends IrInstrBase {
  readonly kind: "await";
  readonly operand: IrValueId;
}

/**
 * (#1373 Phase B) `return <value>` from an async function body. UNLIKE
 * `IrTerminatorReturn`, which produces the bare value, this wraps the
 * value in `Promise.resolve(value)` per the async function spec
 * §15.8.5.5. The IR node defines the wrap intent; lowering (Phase C)
 * emits the wrap via the existing `Promise_resolve` host import in
 * JS-host mode or via the standalone `$Promise` struct.new in WASI
 * mode (the latter wired in #1326 Phase 1B).
 *
 * Used in tail position only — non-tail `return` inside an async
 * function flows through the IR's normal block terminator, which the
 * Phase C lowerer recognises and routes through the same wrap.
 */
export interface IrInstrAsyncReturn extends IrInstrBase {
  readonly kind: "async.return";
  readonly value: IrValueId;
}

/**
 * (#1373 Phase B) Synchronous throw inside an async function body.
 * UNLIKE `IrInstrThrow`, which propagates as a Wasm exception, this
 * wraps the thrown value in `Promise.reject(reason)` so the async
 * function's outer Promise settles in the rejected state. Lowering
 * (Phase C) emits the wrap via `Promise_reject` (host) or `$Promise`
 * struct.new with `state = REJECTED` (standalone, #1326 Phase 1B).
 *
 * Currently NOT emitted by from-ast — Phase C wires it from
 * `ts.ThrowStatement` nodes inside async function bodies.
 */
export interface IrInstrAsyncThrow extends IrInstrBase {
  readonly kind: "async.throw";
  readonly reason: IrValueId;
}

/**
 * `ToBoolean(value)` on a boxed-any carrier — the dynamic-value truthiness
 * op (#2949 S5.1). `value` MUST be `IrType.dynamic`; result (via
 * `IrInstrBase.result`) is `i32` (1 = truthy, 0 = falsy), suitable directly
 * as an `if` / loop / ternary `condValue`.
 *
 * This is deliberately NOT `unbox{Boolean}`: unboxing reads the Boolean
 * *partition* payload and is only valid on a proven boolean, whereas JS
 * `ToBoolean` (§7.1.2) is defined over EVERY partition — `0`/`NaN`/`""`/
 * `null`/`undefined` are falsy, every other value truthy. Lowering routes
 * through the SAME `coercion-engine.emitToBoolean` legacy uses (`__any_
 * unbox_bool` on the gc `$AnyValue` carrier / `__is_truthy` on the host
 * externref carrier) via `IrDynamicLowering.emitToBoolean` — one ToBoolean
 * engine (June-audit D4), byte-parity with legacy. The known-literal
 * `tag.test`+`unbox` fast path is reserved for producers that statically
 * know the partition; general truthiness is this node.
 */
export interface IrInstrDynTruthy extends IrInstrBase {
  readonly kind: "dyn.truthy";
  readonly value: IrValueId;
}

/**
 * `dyn.to_number{value}` — `ToNumber(value)` (§7.1.4) on a boxed-any carrier,
 * result `f64` (#2949 S5.3). The single-operand ToNumber primitive that the
 * numeric-abstract relational lowering (`< > <= >=`) uses: from-ast converts a
 * dynamic relational operand to `f64` with this node, then feeds the existing
 * `f64.lt`/`gt`/`le`/`ge` compare path (a concrete numeric operand is used
 * as-is — no node).
 *
 * Lowering routes to the CANONICAL per-backend ToNumber engine via
 * `IrDynamicLowering.emitToNumber` — one ToNumber policy (June-audit D4):
 *   - gc/fast/standalone: `__any_to_f64` (the SAME boxed-any→f64 helper legacy's
 *     `__any_lt`/`__any_gt`/… + the arithmetic helpers use — null→0,
 *     undefined→NaN, boolean→0/1, number→value).
 *   - host: `__unbox_number` (`Number(v)`, §7.1.4 — the canonical host ToNumber
 *     `coercion-engine.emitToNumber` emits for the externref carrier).
 *
 * SCOPE — numeric-abstract only. Legacy `any < any` is a FULL Abstract
 * Relational Comparison (§7.2.11) that is mode-split three ways (host
 * `__host_compare`; standalone a runtime both-strings-lexicographic-else-numeric
 * branch; fast numeric-hint) — NOT a bare ToNumber. This node deliberately
 * implements only the numeric arm; string×string lexicographic relational is
 * DEFERRED. A boxed-string operand ToNumbers (host: `Number("5")=5`; gc:
 * `__any_to_f64` reads the box's f64 slot, matching legacy `__any_lt`), which is
 * spec-correct ONLY when the OTHER operand is a number (ARC never takes the
 * both-strings branch) — hence the S5.P producer admits a dynamic relational
 * operand ONLY against a numeric literal/concrete.
 */
export interface IrInstrDynToNumber extends IrInstrBase {
  readonly kind: "dyn.to_number";
  readonly value: IrValueId;
}

/**
 * `dyn.eq{lhs, rhs, loose, negate}` — strict/loose equality (§7.2.15 /
 * §7.2.16) between two boxed-any carriers, result `i32` (0/1) (#2949 S5.2).
 *
 * BOTH operands MUST be `dynamic`: the producer boxes any concrete operand
 * into the carrier first (via `box{toType: dynamic}`), leaving the dyn side
 * as-is, so this node always sees two carriers — exactly the `(ref null
 * $AnyValue, ref null $AnyValue)` shape the canonical equality helpers take.
 * Lowering routes through the SAME `__any_strict_eq` (`===`/`!==`, `loose:
 * false`) / `__any_eq` (`==`/`!=`, `loose: true`) helpers legacy's
 * `compileAnyBinaryDispatch` uses — one equality engine, byte-parity with
 * legacy, and the tag-5 field-4 classifier (incl. `NaN === NaN → false` via
 * the helper's `f64.eq`) stays in the helper body, never re-implemented
 * (June-audit D4). `negate` appends `i32.eqz` for the `!==`/`!=` form (the
 * helper always computes the positive `===`/`==`). The payload-less
 * `dyn === null` / `dyn === undefined` STRICT cases are NOT this node — the
 * producer lowers those via the cheaper exact `tag.test{Null|Undefined}`.
 */
export interface IrInstrDynEq extends IrInstrBase {
  readonly kind: "dyn.eq";
  readonly lhs: IrValueId;
  readonly rhs: IrValueId;
  /** `true` = loose `==`/`!=` (`__any_eq`); `false` = strict `===`/`!==` (`__any_strict_eq`). */
  readonly loose: boolean;
  /** `true` = `!==`/`!=` — append `i32.eqz` to the helper's positive result. */
  readonly negate: boolean;
}

/**
 * `dyn.member_get{recv, key}` — a dynamic member read `recv[key]` / `recv.name`
 * on a boxed-any receiver, result `dynamic` (#3053 U1 / #2949 S5.4).
 *
 * BOTH operands are `dynamic` carriers: the producer boxes the receiver (an
 * `any`-typed value already IS the carrier) and the key (a property-name string
 * for `.name`, or a boxed index for `[i]`) into the carrier first, so this node
 * always sees the `(carrier, carrier) -> carrier` shape the unified reader
 * primitive `__dyn_member_get(recv, key)` (#3053 U0) takes and returns.
 *
 * Lowering routes through `IrDynamicLowering.emitMemberGet` (named) /
 * `emitElementGet` (indexed) — both emit a bare `[call __dyn_member_get]` and
 * flip the `ctx.usesDynMemberGet` latch that makes the finalize
 * `ensureDynMemberGet` pass build the helper. The helper closes the
 * externref↔carrier round-trip INSIDE its own frame (U0), so the result is the
 * identity-preserving, tag-honest carrier (object→tag-6, string→tag-5,
 * number→tag-3, …) with NO externref↔$AnyValue impedance at the IR boundary —
 * the S5.4 carrier-impedance blocker is dissolved because the helper takes and
 * returns the carrier directly. `key` is carried dynamic so the helper's own
 * `__any_to_extern(key)` performs `ToPropertyKey` (string as-is, number →
 * decimal) inside its frame.
 *
 * MECHANISM ONLY in U1: the IR selector's move-only scan still REJECTS a dyn
 * receiver in a member read (`select.ts` `dynamicUsesAreMoveOnly`), so no
 * from-ast producer reaches this node in a claimed function until S5.P (U2)
 * opens the scan. The node + lowering are wired but unreached — byte-inert.
 */
export interface IrInstrDynMemberGet extends IrInstrBase {
  readonly kind: "dyn.member_get";
  /** The receiver carrier (`dynamic`). */
  readonly recv: IrValueId;
  /** The property key carrier (`dynamic`): a boxed string name or boxed index. */
  readonly key: IrValueId;
}

/**
 * `dyn.member_set{recv, key, value}` — a strict, statement-position dynamic
 * member write `recv[key] = value` over the canonical boxed-any carrier
 * (#3795). All three operands are already dynamic carriers; lowering preserves
 * their source evaluation order and delegates the actual `[[Set]]` to the
 * existing strict object-runtime setter. This instruction is deliberately
 * void: assignment-as-value remains outside the IR slice.
 */
export interface IrInstrDynMemberSet extends IrInstrBase {
  readonly kind: "dyn.member_set";
  /** The receiver carrier (`dynamic`). */
  readonly recv: IrValueId;
  /** The property key carrier (`dynamic`). */
  readonly key: IrValueId;
  /** The assigned value carrier (`dynamic`). */
  readonly value: IrValueId;
}

/**
 * Slice 7a (#1169f) — push a yielded value onto the generator function's
 * `__gen_buffer` Wasm-local. The lowerer dispatches on the value's IrType:
 *   - `irVal({ kind: "f64" })` → `__gen_push_f64(buffer, value)`
 *   - (later slices: `i32` → `__gen_push_i32`; `externref` → `__gen_push_ref`)
 *
 * Result is void (`result: null`, `resultType: null`). Only valid inside
 * functions whose `funcKind === "generator"`. The lowerer reads the
 * `IrFunction.generatorBufferSlot` for the `local.get` of the buffer.
 *
 * Lowering pattern (slice 7a — f64 only):
 *   local.get $__gen_buffer
 *   <emit value>
 *   call $__gen_push_f64
 */
export interface IrInstrGenPush extends IrInstrBase {
  readonly kind: "gen.push";
  readonly value: IrValueId;
  /**
   * #2951 — the exact typed `__gen_push_*` runtime callable, attached by
   * `attachIrGeneratorSupport` once value types are final. Prepared-component
   * sealing proves this same Program ABI callable that lowering consumes.
   */
  readonly provider?: IrFuncRef;
}

/**
 * Slice 6 part 3 (#1182) — opaque iterator handle for the host iterator
 * protocol. Calls `__iterator(iterable)` to obtain the iterator object.
 *
 * Lowering:
 *   <emit iterable>           ;; pushes externref
 *   call $__iterator           ;; -> externref (the iterator)
 *
 * Result type: `irVal({ kind: "externref" })`.
 */
export interface IrInstrIterNew extends IrInstrBase {
  readonly kind: "iter.new";
  readonly iterable: IrValueId;
  /** True if this is a `for await` loop — calls `__async_iterator` instead. False for slice 6. */
  readonly async: boolean;
}

/**
 * Call iter.next() and return the result object handle (externref).
 * The result is later split into `done` / `value` via separate instrs
 * so the optimizer can decide whether to evaluate `value` (skip if done).
 *
 * Lowering: <emit iter>; call $__iterator_next  -> externref
 *
 * Result type: `irVal({ kind: "externref" })`. Side-effecting (advances
 * the iterator) — DCE must not eliminate it.
 */
export interface IrInstrIterNext extends IrInstrBase {
  readonly kind: "iter.next";
  readonly iter: IrValueId;
}

/**
 * Test whether an iterator-result object's `.done` is true.
 *
 * Lowering: <emit resultObj>; call $__iterator_done -> i32
 *
 * Result type: `irVal({ kind: "i32" })`. The operand field is named
 * `resultObj` (not `result`) to avoid colliding with the SSA-def
 * `result` field inherited from `IrInstrBase`.
 */
export interface IrInstrIterDone extends IrInstrBase {
  readonly kind: "iter.done";
  readonly resultObj: IrValueId;
}

/**
 * Read the `.value` slot of an iterator-result object.
 *
 * Lowering: <emit resultObj>; call $__iterator_value -> externref
 *
 * Result type: `irVal({ kind: "externref" })`. See `IrInstrIterDone`
 * for the `resultObj` naming rationale.
 */
export interface IrInstrIterValue extends IrInstrBase {
  readonly kind: "iter.value";
  readonly resultObj: IrValueId;
}

/**
 * Call `iter.return()` if defined. Used by the iterator-close try/finally
 * so abrupt exits notify the iterator (slice 6 step E, deferred to a
 * try/finally-aware follow-up).
 *
 * Lowering: <emit iter>; call $__iterator_return
 *
 * Result type: void (`result: null`). Side-effecting.
 */
export interface IrInstrIterReturn extends IrInstrBase {
  readonly kind: "iter.return";
  readonly iter: IrValueId;
}

/**
 * Statement-level `for (const <bind> of <iterable>) <body>` loop using
 * the host iterator protocol. The lowerer emits:
 *
 *   <emit iterable>
 *   call $__iterator
 *   local.set <iterSlot>
 *   block
 *     loop
 *       local.get <iterSlot>
 *       call $__iterator_next
 *       local.tee <resultSlot>
 *       call $__iterator_done
 *       br_if 1                  ;; exit loop on done=true
 *       local.get <resultSlot>
 *       call $__iterator_value
 *       local.set <elementSlot>
 *       <body instrs>
 *       br 0                     ;; continue
 *     end
 *   end
 *   local.get <iterSlot>
 *   call $__iterator_return       ;; normal-exit close
 *
 * The iterable must be an IR value of externref type (the from-ast
 * layer inserts a `coerce.to_externref` if the source value isn't
 * already externref). Slot indices are pre-allocated via
 * `IrFunctionBuilder.declareSlot`.
 *
 * Result: void (`result: null`).
 */
export interface IrInstrForOfIter extends IrInstrBase {
  readonly kind: "forof.iter";
  /** SSA value of the iterable as externref (caller pre-coerces). */
  readonly iterable: IrValueId;
  /** Pre-allocated externref slot for the iterator handle. */
  readonly iterSlot: number;
  /** Pre-allocated externref slot for the iterator-result object. */
  readonly resultSlot: number;
  /** Pre-allocated externref slot for the current element value. */
  readonly elementSlot: number;
  /** Body instrs emitted inside the loop. */
  readonly body: readonly IrInstr[];
  /** #2952 slice 2 — loop identity for `br.label` (see IrInstrWhileLoop). */
  readonly loopLabel?: IrLabelId;
}

/**
 * Slice 7a (#1169f) — generator function epilogue. Pushes the buffer + the
 * pending-throw cell (always `ref.null.extern` in slice 7a) and calls
 * `__create_generator(buffer, pendingThrow)` to produce the Generator-like
 * object the function returns.
 *
 * Lowering pattern (slice 7a — synchronous-throw subset):
 *   local.get $__gen_buffer
 *   ref.null.extern                ;; pendingThrow always null in 7a
 *   call $__create_generator
 *   ;; result: externref Generator object — left on stack for the
 *   ;; surrounding `return` terminator.
 *
 * Slice 7a does NOT yet emit the try/catch wrapping that legacy uses for
 * deferred-throw semantics (#928). Throws inside the body propagate
 * immediately (matches V8 generators on the FIRST `.next()` call but
 * differs from spec on subsequent calls). A future slice (7-throw) will
 * add the wrapping by carrying the preceding body instrs in this instr,
 * similar to `forof.vec.body`.
 *
 * Result type: `irVal({ kind: "externref" })` — the Generator object.
 * The function's terminator should be `return [result]`.
 */
export interface IrInstrGenEpilogue extends IrInstrBase {
  readonly kind: "gen.epilogue";
  /** #2951 — exact `__create_generator` runtime callable (see `IrInstrGenPush.provider`). */
  readonly provider?: IrFuncRef;
}

/**
 * Slice 7b (#1169f) — `yield* <iterable>` delegation. Drains the inner
 * iterable into the outer generator's `__gen_buffer` by calling the
 * `__gen_yield_star(buf, iterable)` host import (signature
 * `(externref, externref) → void`; the host iterates the inner via
 * `Symbol.iterator` and pushes each value).
 *
 * The `inner` operand MUST already be coerced to externref by the
 * caller (`lowerYield` in `from-ast.ts` inserts a `coerce.to_externref`
 * upstream). The lowerer just emits the buffer-load, value, and call.
 *
 * Result is void. Only valid inside `funcKind === "generator"`. The
 * lowerer reads `IrFunction.generatorBufferSlot` for the buffer
 * `local.get`.
 *
 * Lowering pattern:
 *   local.get $__gen_buffer
 *   <emit inner>          ;; already externref
 *   call $__gen_yield_star
 *
 * Spec divergence note: ECMA-262 §27.5.3.7 says `yield*` evaluates to
 * the inner iterator's `return` value (the `IteratorResult.value` when
 * `done` becomes true). Under the eager-buffer model this is discarded;
 * `yield*` evaluates to `undefined`. Matches the legacy compiler's
 * behaviour (`misc.ts:177-202`).
 */
export interface IrInstrGenYieldStar extends IrInstrBase {
  readonly kind: "gen.yieldStar";
  readonly inner: IrValueId;
  /** #2951 — exact `__gen_yield_star` runtime callable (see `IrInstrGenPush.provider`). */
  readonly provider?: IrFuncRef;
}

/**
 * #2951 — a generator's `return <value>` stash. Mirrors legacy
 * `compileReturnStatement` (`codegen/statements/control-flow.ts:144-170`):
 * the return value belongs ONLY to the terminal `{value, done:true}`
 * IteratorResult — it must NOT enter the eager yield buffer (where
 * spread / for-of / Array.from would surface it as a `done:false`
 * element). The value is stashed on the buffer via
 * `__gen_set_return(buffer, value)` (signature `(externref, externref)
 * → void`), and the host drain emits it once with `done:true`.
 *
 * Same shape as `gen.push` (statement-level, `result: null`,
 * `resultType: null`, one `value` operand). The lowerer BOXES the value
 * to externref before the call — `f64` → `__box_number`, `i32` →
 * `f64.convert_i32_s` then box, `ref`/`ref_null` → `extern.convert_any`,
 * `externref` → pass through. Only valid inside `funcKind ===
 * "generator"`; the lowerer reads `IrFunction.generatorBufferSlot` for
 * the buffer `local.get`.
 *
 * Lowering pattern:
 *   local.get $__gen_buffer
 *   <emit value; box to externref>
 *   call $__gen_set_return
 */
export interface IrInstrGenSetReturn extends IrInstrBase {
  readonly kind: "gen.setReturn";
  readonly value: IrValueId;
  /** #2951 — exact `__gen_set_return` runtime callable (see `IrInstrGenPush.provider`). */
  readonly provider?: IrFuncRef;
  /**
   * #2951 — exact `__box_number` runtime callable, attached only when the
   * stashed value is `f64`/`i32` and therefore needs boxing before the
   * `(externref, externref)` call. Absent for already-externref values.
   */
  readonly boxProvider?: IrFuncRef;
}

/**
 * Slice 10 (#1169i) — `new ExternClass(arg1, arg2, ...)` where
 * `ExternClass` is a host-provided builtin (RegExp, Uint8Array, …). The
 * Wasm-level result is opaque externref; downstream code accesses it
 * via `extern.call` / `extern.prop`.
 *
 * Lowering:
 *   <emit each arg>
 *   call $<className>_new
 *
 * Result type: `{ kind: "extern", className }`.
 */
export interface IrInstrExternNew extends IrInstrBase {
  readonly kind: "extern.new";
  /** Semantic result brand used by later member resolution. */
  readonly className: string;
  /** Exact host registry prefix used only for provider selection. */
  readonly importPrefix: string;
  readonly args: readonly IrValueId[];
  /** Exact host import chosen during final provider preparation. */
  readonly provider?: IrFuncRef;
}

/**
 * Slice 10 (#1169i) — method call on an extern-class value. `receiver`
 * is the externref handle; `method` names a method registered on the
 * class via `ctx.externClasses`.
 *
 * Lowering:
 *   <emit receiver>
 *   <emit each arg>
 *   call $<className>_<method>
 *
 * Result type: matches the registered method's first result. Void
 * methods carry `result: null` and `resultType: null`.
 */
export interface IrInstrExternCall extends IrInstrBase {
  readonly kind: "extern.call";
  readonly className: string;
  readonly method: string;
  readonly receiver: IrValueId;
  readonly args: readonly IrValueId[];
  /** Exact host import chosen during final provider preparation. */
  readonly provider?: IrFuncRef;
}

/**
 * Slice 10 (#1169i) — property read on an extern-class value.
 *
 * Lowering:
 *   <emit receiver>
 *   call $<className>_get_<property>
 *
 * Result type: the property's registered ValType, wrapped as `IrType.val`.
 */
export interface IrInstrExternProp extends IrInstrBase {
  readonly kind: "extern.prop";
  readonly className: string;
  readonly property: string;
  readonly receiver: IrValueId;
  /** Exact host import chosen during final provider preparation. */
  readonly provider?: IrFuncRef;
}

/**
 * Slice 10 (#1169i) — property write on an extern-class value (for
 * non-readonly props).
 *
 * Lowering:
 *   <emit receiver>
 *   <emit value>
 *   call $<className>_set_<property>
 */
export interface IrInstrExternPropSet extends IrInstrBase {
  readonly kind: "extern.propSet";
  readonly className: string;
  readonly property: string;
  readonly receiver: IrValueId;
  readonly value: IrValueId;
  /** Exact host import chosen during final provider preparation. */
  readonly provider?: IrFuncRef;
}

/**
 * Slice 10 (#1169i) — RegExp literal `/pattern/flags`. Lowers to
 * `RegExp_new(pattern, flags)`. The pattern + flags are registered as
 * string-literal globals (the legacy `collectStringLiterals` pass
 * already collects RegExp pattern/flags as string literals — see
 * `src/codegen/index.ts:3274-3278` — so by the time the IR emits this
 * instr the corresponding string globals exist).
 *
 * Result type: `{ kind: "extern", className: "RegExp" }`.
 */
export interface IrInstrRegExpLiteral extends IrInstrBase {
  readonly kind: "extern.regex";
  readonly pattern: string;
  readonly flags: string;
}

// ---------------------------------------------------------------------------
// String indexing (#3954 phase 2, slice A)
// ---------------------------------------------------------------------------
//
// The `string.*` family split three ways under #4551's per-kind verdict: the
// encoding-parameterized members (`string.const` / `string.concat` /
// `string.eq`) came back NEUTRAL, `string.len` is still an open policy call
// (code units or code points), and these two are ECMAScript. The JS residue is
// in the OPERATION, not the representation — `IrStringEncoding` already
// parameterizes the latter. Both are total functions over an unnormalized
// index: §22.1.3.1 yields the empty string out of range and §22.1.3.2 yields
// NaN, after a ToIntegerOrInfinity (§7.1.5) normalization of the index. A
// non-JS producer would have to work around that convention, not adopt it —
// Java throws and Rust panics on the same input.

/** Return one UTF-16 code unit as a string, or the empty string out of bounds. */
export interface IrInstrStringCharAt extends IrInstrBase {
  readonly kind: "string.char_at";
  readonly value: IrValueId;
  /** Index after ToIntegerOrInfinity-compatible numeric normalization. */
  readonly index: IrValueId;
  readonly inputEncoding: IrStringEncoding;
  readonly encodingEvidence: IrStringEncoding;
  /** Semantic callable intent bound to the exact backend provider during preparation. */
  readonly provider?: IrFuncRef;
}

/** Return one UTF-16 code unit as f64, or NaN out of bounds. */
export interface IrInstrStringCharCodeAt extends IrInstrBase {
  readonly kind: "string.char_code_at";
  readonly value: IrValueId;
  /** Index after ToIntegerOrInfinity-compatible numeric normalization. */
  readonly index: IrValueId;
  readonly inputEncoding: IrStringEncoding;
  /** Semantic callable intent bound to the exact backend provider during preparation. */
  readonly provider?: IrFuncRef;
}

// ---------------------------------------------------------------------------
// String for-of (#1183 — IR Phase 4 Slice 6 part 4)
// ---------------------------------------------------------------------------
//
// Slice 6 part 4 adds the string fast path. When `iterableType.kind ===
// "string"` and the compiler is in native-strings mode, the for-of loop
// iterates code units via `__str_charAt(str, i)` — a counter loop with
// a `(ref $AnyString, i32) -> (ref $AnyString)` host helper. In host-
// strings mode the dispatch falls through to `forof.iter` (#1182).
//
// `forof.string` is a STATEMENT-level declarative instr that mirrors
// `forof.vec` and `forof.iter`. Carries the string SSA value, the four
// slot indices (counter / length / str / element), and the body buffer.

/**
 * Statement-level `for (const c of <string>) <body>` loop using the
 * native-strings counter pattern. Emitted only when the resolver
 * reports `nativeStrings(): true` — host-strings mode falls through
 * to `forof.iter` upstream in `lowerForOfStatement`.
 *
 * The lowerer emits:
 *   <emit str>
 *   local.set <strSlot>
 *   local.get <strSlot>
 *   struct.get $AnyString $len
 *   local.set <lengthSlot>
 *   i32.const 0
 *   local.set <counterSlot>
 *   block
 *     loop
 *       local.get <counterSlot>
 *       local.get <lengthSlot>
 *       i32.ge_s
 *       br_if 1
 *       local.get <strSlot>
 *       local.get <counterSlot>
 *       call $__str_charAt
 *       local.set <elementSlot>
 *       <body instrs>
 *       local.get <counterSlot>
 *       i32.const 1
 *       i32.add
 *       local.set <counterSlot>
 *       br 0
 *     end
 *   end
 *
 * Slot types (set by from-ast):
 *   counterSlot — i32
 *   lengthSlot  — i32
 *   strSlot     — `(ref $AnyString)` (resolver.resolveString())
 *   elementSlot — `(ref $AnyString)` — each iteration produces a
 *                 single-char string
 *
 * Result: void (`result: null`).
 */
export interface IrInstrForOfString extends IrInstrBase {
  readonly kind: "forof.string";
  /** SSA value of the string (IrType.string). */
  readonly str: IrValueId;
  readonly counterSlot: number;
  readonly lengthSlot: number;
  readonly strSlot: number;
  readonly elementSlot: number;
  /** Body instrs emitted inside the loop. */
  readonly body: readonly IrInstr[];
  /** Code-point extraction intent bound to the exact native provider during preparation. */
  readonly provider?: IrFuncRef;
  /** #2952 slice 2 — loop identity for `br.label` (see IrInstrWhileLoop). */
  readonly loopLabel?: IrLabelId;
}
