// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Backend layout-handle types (#1713).
//
// These interfaces describe the *layout* of an IR value in a concrete
// backend's representation. They are produced by the `IrLowerResolver`
// (layout factory, in `lower.ts`) and consumed by a `BackendEmitter`
// (op emission, in `backend/emitter.ts`).
//
// They were extracted verbatim from `lower.ts` so the `BackendEmitter`
// trait file can import them without pulling in the 2.4k-line lowering
// pass (which would create an import cycle). `lower.ts` re-exports them
// for backwards compatibility, so existing `import { IrVecLowering } from
// "./lower.js"` sites keep working.
//
// Phase 1 (#1713) began with WasmGC-typed handles (`typeIdx` / `fieldIdx`).
// Second backends (#1714 linear, #1715 bytecode) add parallel handle metadata
// and parameterise the emitter over it -- see the
// `## Implementation Plan` section 7 in
// `plan/issues/1713-ir-backend-emitter-trait-seam.md` for that design step.
// Nothing here changes for Phase 1.

import type { Instr, ValType } from "../types.js";
import type { JsTag } from "../js-tag.js";
import type { IrClassMemberKind, IrFuncRef } from "../nodes.js";
import type {
  LinearAllocationSitePlan,
  LinearRecordLayoutPlan,
  LinearRuntimeOperation,
  LinearVectorLayoutPlan,
} from "../analysis/linear-memory-plan.js";

/**
 * Information about a tagged-union struct type emitted into the WasmGC module.
 * See `passes/tagged-union-types.ts` for the registry that produces these.
 */
export interface IrUnionLowering {
  /** WasmGC type index of the `$union_<members>` struct. */
  readonly typeIdx: number;
  /** Field index of the `$tag` i32 discriminator. */
  readonly tagFieldIdx: number;
  /** Field index of the `$val` field carrying the member scalar. */
  readonly valFieldIdx: number;
  /** Canonical tag value (i32 constant) for each ValType kind. */
  tagFor(member: ValType): number;
}

/**
 * Information about a heap-allocated scalar box -- see
 * `IrType { kind: "boxed", inner }`. Resolved lazily by the lowering pass.
 */
export interface IrBoxedLowering {
  /** WasmGC type index of the `$box_<inner>` struct. */
  readonly typeIdx: number;
  /** Field index of the inner `$val`. */
  readonly valFieldIdx: number;
}

/**
 * Information about a registered WasmGC struct that backs an
 * `IrType.object` shape. The resolver memoizes one of these per shape.
 *
 * `fieldIdx(name)` returns the WasmGC struct's field index for the given
 * shape field name (in the shape's canonical order). It throws when the
 * name is not a member of the shape -- the lowerer catches via the
 * surrounding try/catch and emits a clean fall-back error.
 */
export interface IrObjectStructLowering {
  /** WasmGC type index of the registered struct. */
  readonly typeIdx: number;
  /** Field index for each field name in the shape's canonical order. */
  fieldIdx(name: string): number;
}

/**
 * Linear-memory field metadata carried by the aggregate/ref-cell handles.
 * Offsets follow `src/codegen-linear/layout.ts`; the IR layer deliberately
 * sees only the backend-neutral memory facts needed by `LinearEmitter`.
 */
export interface LinearMemoryFieldLowering {
  readonly offset: number;
  readonly type: ValType;
}

/**
 * Linear-memory analogue of an object struct handle. `typeIdx`/`fieldIdx`
 * remain present because `IrLowerResolver` predates parallel layout handles;
 * the linear emitter consumes this additive metadata and never interprets
 * the sentinel type index as a WasmGC type.
 */
export interface PlannedObjectMemoryLowering {
  /** Canonical per-site allocation decision; absent on read/write-only handles. */
  readonly allocation?: LinearAllocationSitePlan;
  /** Canonical target-neutral layout consumed by every linear-memory backend. */
  readonly layout: LinearRecordLayoutPlan;
  /** Still symbolic until the selected backend binds its allocator. */
  readonly allocate: LinearRuntimeOperation;
  readonly fieldCount: number;
  field(name: string): LinearMemoryFieldLowering;
}

/** Shared-plan record handle consumed by linear-Wasm and Porffor IR. */
export interface PlannedObjectLowering extends IrObjectStructLowering {
  readonly linearMemory: PlannedObjectMemoryLowering;
}

export interface LinearObjectLowering extends PlannedObjectLowering {
  readonly linearMemory: PlannedObjectMemoryLowering & {
    /** Deferred helper `(field0, ...fieldN) -> i32` appended after user slots. */
    readonly newFuncIdx: number;
  };
}

/**
 * Slice 3 / #3214 B0: WasmGC allocation/type info for a closure:
 *   - A signature wrapper (`structTypeIdx`) contains field 0's funcref and is
 *     shared with the legacy `__fn_wrap_*` registry. A no-capture closure
 *     constructs it directly; it is not the cross-module carrier.
 *   - An optional captured subtype extends that signature wrapper with capture
 *     fields and is downcast from root `self` inside the lifted body.
 *
 * `funcTypeIdx` is the exact lifted function signature
 * `(ref $wrapperRoot, ...sig.params) -> sig.returnType`. The root self type,
 * field-0 read, and funcref signature together are independent of per-module
 * signature-wrapper creation order.
 */
export interface IrClosureLowering {
  readonly structTypeIdx: number;
  readonly funcFieldIdx: number;
  /** Field index for capture position `i` (0-based). Valid only for captured-subtype lowerings. */
  capFieldIdx(index: number): number;
  readonly funcTypeIdx: number;
  /**
   * Exact private singleton appended to certified standalone DOM callback
   * carriers. The thunk resolves the live absolute global index so a late
   * import-global insertion cannot stale the allocation operand.
   */
  readonly domCallbackAuthorityGlobalIdx?: () => number;
}

/**
 * Slice 3 (#1169c): WasmGC type info for a ref cell over a primitive
 * value type. Single-field struct `(struct (field $value (mut T)))`.
 */
export interface IrRefCellLowering {
  readonly typeIdx: number;
  readonly fieldIdx: number;
}

/** Linear-memory analogue of the one-field mutable ref-cell struct. */
export interface LinearRefCellLowering extends IrRefCellLowering {
  readonly linearMemory: {
    readonly layout: LinearRecordLayoutPlan;
    readonly allocate: LinearRuntimeOperation;
    /** Deferred helper `(value) -> i32` appended after user slots. */
    readonly newFuncIdx: number;
    readonly value: LinearMemoryFieldLowering;
  };
}

/**
 * Slice 6 (#1169e): WasmGC type info for a vec struct (the runtime layout
 * for `Array<T>` / tuple types). The struct is `{ length: i32, data: (ref
 * $arr) }` where `$arr` is the element array type. This interface is the
 * lowerer's contract for emitting `vec.len` and `vec.get` against a known
 * vec value's IrType.
 *
 *   - `vecStructTypeIdx`   Wasm struct type index of the vec.
 *   - `lengthFieldIdx`     field index of the i32 length (typically 0).
 *   - `dataFieldIdx`       field index of the data array ref (typically 1).
 *   - `arrayTypeIdx`       Wasm array type index of the data array.
 *   - `elementValType`     element ValType -- used by `vec.get` to lower
 *                           the result and (recursively, via the resolver)
 *                           to widen the element to the loop variable's
 *                           declared type when needed.
 */
export interface IrVecLowering {
  /** Backend value carrier (`ref $vec` on WasmGC, `i32` arena pointer on linear). */
  readonly valueType?: ValType;
  readonly vecStructTypeIdx: number;
  readonly lengthFieldIdx: number;
  readonly dataFieldIdx: number;
  readonly arrayTypeIdx: number;
  readonly elementValType: ValType;
}

/**
 * Slice 4 (#1169d): WasmGC type info for a class declared in the
 * compilation unit. The class's struct + constructor + method funcs
 * are all registered by the legacy `collectClassDeclaration` pass before
 * the IR runs; this interface just exposes them by name.
 *
 *   - `structTypeIdx`        Wasm struct type index for the class
 *   - `fieldIdx(name)`       Wasm struct field index for a user field name
 *                             (the legacy `__tag` prefix at field 0 is
 *                             accounted for here so the IR doesn't need to
 *                             reason about it).
 *   - `constructorFunc`      binding-aware reference to the constructor
 *                             function (`<className>_new` is only its
 *                             compatibility label); the resolver maps the
 *                             binding to the funcIdx.
 *   - `memberFunc(kind,name)` binding-aware reference to a class member;
 *                             the compatibility label is commonly
 *                             `<className>_<methodName>` (or the corresponding
 *                             getter/setter spelling).
 */
export interface IrClassLowering {
  readonly structTypeIdx: number;
  fieldIdx(name: string): number;
  readonly constructorFunc: IrFuncRef;
  memberFunc(kind: IrClassMemberKind, name: string, target?: IrFuncRef): IrFuncRef;
  /**
   * #3000-E: binding-aware reference to the constructor-init function
   * (`<className>_init` is its usual compatibility label) — signature
   * `(...ctorParams, self) -> (ref $struct)`,
   * carrying field inits + the ctor body, operating on a caller-allocated
   * instance. A derived `super(...)` lowers to `call <parent>_init(args..., self)`.
   * The resolver maps the typed reference to the funcIdx. Present for every
   * WasmGC-struct (non-externref-backed) class, which is exactly the set that
   * can appear as an IR-claimable subclass parent.
   */
  readonly initFunc: IrFuncRef;
  /**
   * (#3144) The "instanceof-compatible" tag set for THIS class: its own
   * `__tag` discrimination constant plus every transitive descendant's —
   * the same walk as legacy `collectInstanceOfTags` (typeof-delete.ts), so
   * the `class.instanceof` lowering compares against the identical set the
   * legacy `compileInstanceOf` emits. Empty when the class has no tag
   * registered (lowering then folds to constant false, legacy parity).
   */
  readonly instanceOfTags: readonly number[];
}

/**
 * #2949 slice 3 — layout + op-emission handle for the `dynamic` IrType (the
 * boxed-any carrier). Produced by `IrLowerResolver.resolveDynamicLowering()`
 * (integration.ts, closed over the live `CodegenContext`) and consumed by the
 * dynamic arms of `box` / `unbox` / `tag.test` in `lower.ts`.
 *
 * Two strategies, selected by the SAME mode split as `resolveDynamic()` (they
 * must stay in lockstep — the carrier and its ops are one decision):
 *
 *   - `"gc"` (WasmGC fast/standalone): carrier is `ref_null $AnyValue`
 *     (`{tag:i32, i32val:i32, f64val:f64, refval:eqref, externval:externref}`,
 *     `ensureAnyValueType`). Boxing routes through the CANONICAL `__any_box_*`
 *     helper family via `boxToAny` (value-tags.ts) — never a second boxing
 *     engine (June-audit D4). Unboxing reads payload fields (numbers via the
 *     canonical `__any_unbox_f64` / `__any_unbox_i32` readers, which honor the
 *     V2 numeric-class invariant across tags {2,3}).
 *   - `"host"` (WasmGC host / non-fast): carrier is `externref`; ops route
 *     through the existing host import family (`__box_number` /
 *     `__unbox_number` / `__unbox_boolean` / `__typeof_*`), registered
 *     up-front by `preregisterDynamicSupport` (late-import shift discipline).
 *
 * All `emit*` methods resolve function indices BY NAME at emit time (the
 * #2191/#2193 name-based-repoint lesson) and return the op sequence for the
 * caller to `pushRaw` — mirroring the proven `emitStringConcat` resolver
 * pattern. The `payloadFieldIdx` accessor exposes the gc layout for tests and
 * for #2953's future emitter-trait routing of these pushes.
 *
 * V2 NUMERIC-CLASS CONTRACT (deliberate deviation from the slice-1 sketch,
 * see the issue's slice-3 notes): `emitTagTest(NumberI32)` and
 * `emitTagTest(NumberF64)` BOTH lower to the numeric-CLASS test ("is a
 * number": gc `tag ∈ {2,3}`, host `typeof === "number"`). The host carrier
 * cannot distinguish the i32/f64 partitions (`typeof` has one "number"), so
 * an exact-tag gc test would be mode-divergent — a producer decision tree
 * that works in host mode would silently misbehave in fast mode. Producers
 * pick the payload via the UNBOX tag instead (`NumberF64` → f64 ToNumber-safe
 * read; `NumberI32` → i32 read with trunc-sat narrowing), which both
 * strategies implement consistently.
 */
export interface IrDynamicLowering {
  /** The carrier ValType — MUST equal `resolveDynamic()`'s result. */
  readonly carrier: ValType;
  /** Lowering strategy — see the interface doc. */
  readonly strategy: "gc" | "host";
  /** gc: the `$AnyValue` struct typeIdx. host: -1. */
  readonly anyValueTypeIdx: number;
  /** gc: field index of the i32 tag (0). host: -1. */
  readonly tagFieldIdx: number;
  /**
   * gc: payload field index for a partition — 1 (`i32val`) for
   * NumberI32/Boolean, 2 (`f64val`) for NumberF64, 3 (`refval`, eqref) for
   * Object/Function, 4 (`externval`, externref) for String (strings are
   * carried extern-shaped under tag 5 in BOTH string modes — the #42 /
   * tag-5-field-4 contract). Throws for the payload-less Null/Undefined
   * partitions and for the host strategy.
   */
  payloadFieldIdx(tag: JsTag): number;
  /**
   * Value of ValType `from` on the stack → carrier on the stack.
   * gc: the `__any_box_*` family via `boxToAny` (tag selection is the
   * canonical Wasm-kind-keyed policy — behavior-identical to legacy's
   * `any`-coercion for the same operand kind). host: `__box_number` family /
   * `extern.convert_any` / identity for externref.
   *
   * `hint` is the box target's OPTIONAL static tag refinement
   * (`box{toType: {kind:"dynamic", tag}}`): a producer-proven partition.
   * It maps onto `boxToAny`'s `jsType` hint and follows the same contract —
   * honored only when consistent with the operand's Wasm kind, NEVER
   * overriding representation. The one load-bearing case today: a
   * Boolean-refined i32 boxes as a tag-4 boolean (`__any_box_bool` /
   * `__box_boolean`) instead of the unbranded NUMBER default.
   * Throws when the operand kind has no sound box at all (e.g. i64 host).
   */
  emitBox(from: ValType, hint?: JsTag): readonly Instr[];
  /**
   * Carrier on the stack → the partition's payload. Caller must hold a
   * `tag.test` proof (verifier R2); a wasm-null carrier here is a producer
   * bug and traps (gc) / host-coerces (host). Result kind: NumberF64 → f64,
   * NumberI32/Boolean → i32, String → externref, Object/Function → eqref
   * (gc) / externref (host). Throws for Null/Undefined (R2 backstop).
   */
  emitUnbox(tag: JsTag): readonly Instr[];
  /**
   * Carrier on the stack → i32 (0/1): does the runtime tag match the
   * partition? Number partitions test the CLASS (see the V2 contract above).
   * `scratch` lazily allocates a carrier-typed function local — only invoked
   * for arms that must read the operand twice (host Object test:
   * `typeof === "object" && !== null`). gc arms `struct.get` the tag
   * directly (a wasm-null carrier traps — same producer contract as unbox;
   * the singleton-normalization producer slice decides null-carrier policy,
   * see the issue notes + #2106).
   */
  emitTagTest(tag: JsTag, scratch: () => number): readonly Instr[];
  /**
   * Carrier on the stack → i32 (0/1): `ToBoolean(carrier)` (§7.1.2, #2949
   * S5.1). Routes to the SAME `coercion-engine.emitToBoolean` legacy uses —
   * `__any_unbox_bool` on the gc `$AnyValue` carrier, `__is_truthy` on the
   * host externref carrier — so `0`/`NaN`/`""`/`null`/`undefined` are falsy
   * in both strategies, byte-parity with legacy's condition lowering (one
   * ToBoolean engine, June-audit D4). Unlike `emitUnbox(Boolean)` (which
   * reads a PROVEN boolean's payload), this is defined over EVERY partition
   * and needs no `tag.test` proof.
   */
  emitToBoolean(): readonly Instr[];
  /**
   * Carrier on the stack → f64: `ToNumber(carrier)` (§7.1.4, #2949 S5.3), the
   * single-operand ToNumber that the numeric-abstract relational lowering
   * (`< > <= >=`) applies to a dynamic operand before the existing `f64.lt`/
   * `gt`/`le`/`ge` compare.
   *   - gc/fast/standalone: `__any_to_f64` — the SAME boxed-any→f64 helper
   *     legacy's `__any_lt`/`__any_gt`/… + the arithmetic helpers use (null→0,
   *     undefined→NaN, boolean→0/1, number→value). It is chosen directly (not
   *     via `coercion-engine.emitToNumber`, whose `$AnyValue` arm routes through
   *     `coerceType` and REQUIRES temp-local allocation the handle's pure
   *     `Instr[]` contract cannot provide).
   *   - host: `coercion-engine.emitToNumber` on the externref carrier →
   *     `__unbox_number` (`Number(v)`) — the canonical host ToNumber, single
   *     call, no locals.
   * SCOPE — numeric-abstract only; string×string lexicographic relational is
   * DEFERRED (legacy `any < any` is a full ARC, mode-split three ways: host
   * `__host_compare`, standalone runtime both-strings-else-numeric branch, fast
   * numeric-hint). Spec-correct only when the OTHER relational operand is a
   * number — the S5.P producer admits a dynamic relational operand ONLY against
   * a numeric literal/concrete.
   */
  emitToNumber(scratch?: () => number): readonly Instr[];
  /**
   * One carrier on the stack → the operand shape this backend's equality
   * helper takes (#2949 S5.2). Emitted once per operand, immediately after that
   * operand is pushed:
   *   - gc: the carrier IS `(ref null $AnyValue)`, exactly what
   *     `__any_strict_eq`/`__any_eq` take → identity (`[]`).
   *   - host: the carrier is `externref`, exactly what
   *     `__host_eq`/`__host_loose_eq` take → identity (`[]`).
   * (It exists as a hook because a future backend might need a real
   * per-operand marshalling; today both are identity.)
   */
  emitEqOperand(): readonly Instr[];
  /**
   * Two operands on the stack (each run through {@link emitEqOperand}) → i32
   * (0/1): STRICT equality `===` (§7.2.16), routed to the SAME helper the
   * matching legacy backend uses (D4, byte-parity with the legacy runtime
   * result). `negate` appends `i32.eqz` for `!==`.
   *   - gc/fast/standalone: the native `__any_strict_eq` — its tag-5 field-4
   *     classifier owns cross-type falsity, numeric-class `23 === 23.0`,
   *     `NaN === NaN → false` (the helper's `f64.eq`), and reference identity.
   *   - host: `__host_eq` (JS `===`). (The `__any_strict_eq` path is NOT
   *     host's — legacy host `any === any` compares the raw externrefs; the
   *     `__any_*_eq` helper family is the standalone/`noJsHost` branch.)
   */
  emitStrictEq(negate: boolean): readonly Instr[];
  /**
   * Two operands on the stack → i32 (0/1): LOOSE equality `==` (§7.2.15),
   * routed to the matching legacy backend's helper (D4). `negate` appends
   * `i32.eqz` for `!=`.
   *   - gc/fast/standalone: `__any_eq` (String⇄Number / `null == undefined` /
   *     ToPrimitive arms live in the helper body).
   *   - host: `__host_loose_eq` (JS `==`).
   */
  emitLooseEq(negate: boolean): readonly Instr[];
  /**
   * Two carriers on the stack (`recv`, then `key`) → one carrier: a dynamic
   * member read `recv[key]` / `recv.name` (#3053 U1 / #2949 S5.4). Both
   * strategies emit a bare `[call __dyn_member_get]` — the unified reader
   * primitive (#3053 U0) whose result is the identity-preserving, tag-honest
   * carrier (object→tag-6, string→tag-5, number→tag-3, …). The helper closes
   * the externref↔carrier round-trip inside its OWN frame (the receiver peel
   * `__carrier_recv_to_extern` + `__extern_get` + `__any_from_extern_honest`),
   * so there is NO externref↔$AnyValue impedance at the IR boundary and reads
   * compose (`recv.a.z` = two chained calls) without re-triggering the
   * `__any_to_extern` tag-6 breaker.
   *
   * As a side effect this flips `ctx.usesDynMemberGet`, the latch the finalize
   * `ensureDynMemberGet` pass reads to build the helper (U0 registers it
   * up-front via `preregisterDynamicSupport`; the funcidx is resolved BY NAME
   * here — the #2191/#2193 name-based-repoint discipline).
   *   - gc/fast/standalone: carrier = `(ref null $AnyValue)`; the helper does
   *     the tag-6 receiver peel + honest re-box internally.
   *   - host: carrier = `externref`; the helper is a thin `__extern_get`
   *     wrapper (the host carrier IS externref).
   */
  emitMemberGet(): readonly Instr[];
  /**
   * Two carriers on the stack (`recv`, then the boxed index `key`) → one
   * carrier: a dynamic indexed read `recv[i]` (#3053 U1 / #2949 S5.4). The
   * indexed form of {@link emitMemberGet} — the index is carried `dynamic`
   * (boxed number) so the helper's own `__any_to_extern(key)` performs the
   * `ToPropertyKey` number→decimal conversion inside its frame. Emits the same
   * `[call __dyn_member_get]` (the reader is key-uniform) and flips the same
   * `ctx.usesDynMemberGet` latch.
   */
  emitElementGet(): readonly Instr[];
  /**
   * Three carriers on the stack (`recv`, `key`, then `value`) → void: strict
   * statement-position dynamic member assignment (#3795). Both backends call
   * the canonical `__dyn_member_set` helper, which preserves receiver/key/value
   * evaluation order and delegates to the existing strict object-runtime
   * setter. Assignment-as-value is intentionally not represented.
   */
  emitMemberSet(): readonly Instr[];
}

/**
 * #1714: linear-memory layout handle for a vec (array). Sibling to
 * {@link IrVecLowering} (the WasmGC handle). The linear backend stores an
 * array as a base `i32` pointer to `[header 8B][len:u32 @+8][cap:u32
 * @+12][elements @+16…]` (see `src/codegen-linear/runtime.ts:339`), so the
 * only representation detail the emitter needs is the element ValType (for
 * stride + load op). Field offsets are fixed by the layout, not per-instance.
 *
 * This is the "different handle shape the linear resolver returns" that the
 * #1713 spec §7 anticipated. The `BackendEmitter` vec methods accept
 * `IrVecLowering | LinearVecLowering`; each emitter narrows to its own shape.
 */
export interface LinearVecLowering {
  /** Element ValType — drives stride (4 vs 8) and the load op. */
  readonly elementValType: ValType;
  readonly linearMemory: {
    /** Canonical per-site decision; absent on read/write-only handles. */
    readonly allocation?: LinearAllocationSitePlan;
    readonly layout: LinearVectorLayoutPlan;
    readonly allocate: LinearRuntimeOperation;
    readonly initializeElement: LinearRuntimeOperation;
  };
}
