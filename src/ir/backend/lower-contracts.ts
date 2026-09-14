// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Data-only lowering contracts, shared by generic and concrete backend paths.
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type {
  AllocSiteId,
  IrClassShape,
  IrClosureSignature,
  IrDomCallbackAuthority,
  IrFuncRef,
  IrGlobalRef,
  IrObjectShape,
  IrStringLengthProvider,
  IrType,
  IrTypeRef,
} from "../nodes.js";
import type { IrStringConcatMode, IrStringEncoding } from "../string-runtime.js";
import type { FuncTypeDef, Instr, ValType, WasmFunction } from "../types.js";
import type {
  IrBoxedLowering,
  IrClassLowering,
  IrClosureLowering,
  IrDynamicLowering,
  IrFnctorLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  IrUnionLowering,
  IrVecLowering,
} from "./handles.js";

export type {
  IrBoxedLowering,
  IrClassLowering,
  IrClosureLowering,
  IrDynamicLowering,
  IrFnctorLowering,
  IrObjectStructLowering,
  IrRefCellLowering,
  IrUnionLowering,
  IrVecLowering,
} from "./handles.js";

export interface IrLowerResolver {
  resolveFunc(ref: IrFuncRef): number;
  /** Exact post-call carrier adaptation for a provider with a legacy ABI. */
  callResultAdapter?(ref: IrFuncRef): "native-string-from-externref" | undefined;
  resolveGlobal(ref: IrGlobalRef): number;
  resolveType(ref: IrTypeRef): number;
  internFuncType(type: FuncTypeDef): number;
  /**
   * Resolve (and memoise) the WasmGC struct type for a `union` IrType. V1
   * scope: homogeneous-width unions only — see
   * `passes/tagged-union-types.ts`. Returns `null` when the union is not
   * representable (heterogeneous, or contains reference members); callers
   * must treat that as `dynamic` upstream.
   *
   * Optional so Phase-1 resolvers without tagged-union support can omit it;
   * a Phase-3 function that actually emits `box`/`unbox`/`tag.test` will
   * fail at lowering time when it's missing, which is the correct behavior
   * (caller should have rejected the IR earlier).
   */
  resolveUnion?(members: readonly ValType[]): IrUnionLowering | null;
  /**
   * Resolve (and memoise) the WasmGC struct type for a `boxed` IrType.
   * Optional for the same reason as `resolveUnion`.
   */
  resolveBoxed?(inner: ValType): IrBoxedLowering | null;
  /**
   * Resolve (and memoise) the WasmGC struct type for an `IrType.object`
   * shape. Returns `null` if the shape contains a field type the backend
   * can't lower (e.g. a nested boxed-IrType the V1 boxed registry doesn't
   * support).
   *
   * The slice-2 implementation in `integration.ts` delegates to a shared
   * `ObjectStructRegistry` that hashes shapes against
   * `ctx.anonStructHash`, so legacy `ensureStructForType` and the IR path
   * converge on a single WasmGC struct for any given shape.
   */
  resolveObject?(shape: IrObjectShape, alloc?: AllocSiteId): IrObjectStructLowering | null;
  /**
   * Slice 3 / #3214 B0: resolve the per-signature allocation wrapper and its
   * exact lifted funcref type. The wrapper is used by `closure.new` (and as the
   * parent of captured environments), but is not the cross-module carrier or
   * lifted `self` type; those use `resolveClosureRoot`. Returns `null` if the
   * signature contains an IrType the backend can't lower.
   */
  resolveClosure?(signature: IrClosureSignature): IrClosureLowering | null;
  /**
   * #3214 B0: resolve the canonical root shared by every legacy/IR
   * funcref-wrapper struct. This is the stable closure carrier, field-0 read
   * type, and lifted `self` type. Only allocation and capture recovery use a
   * narrower per-signature wrapper/subtype.
   */
  resolveClosureRoot?(): number | null;
  /**
   * Slice 3 (#1169c): resolve the captured SUBTYPE WasmGC struct for a specific
   * closure-construction site. Different non-empty
   * `(signature, captureFieldTypes)` pairs produce different subtypes of the
   * signature's exact canonical wrapper, so the
   * lifted body's `ref.cast` recovers capture-field positions.
   */
  resolveClosureSubtype?(
    signature: IrClosureSignature,
    captureFieldTypes: readonly IrType[],
    hostOneShot?: boolean,
    domCallbackAuthority?: IrDomCallbackAuthority,
    liftedFuncIdx?: number,
  ): IrClosureLowering | null;
  /**
   * Slice 3 (#1169c): resolve the WasmGC struct type for a ref cell
   * over a primitive ValType. Delegates to the legacy
   * `getOrRegisterRefCellType` so legacy and IR ref cells share one
   * type per inner ValType.
   */
  resolveRefCell?(inner: ValType, alloc?: AllocSiteId): IrRefCellLowering | null;
  /**
   * Slice 4 (#1169d): resolve the WasmGC struct + constructor + method
   * funcs for a class declared in the compilation unit. Returns `null`
   * if `shape.className` was not registered by the legacy class
   * collection pass — that's a selector bug.
   */
  resolveClass?(shape: IrClassShape): IrClassLowering | null;
  /** Resolve one source/unit-qualified fnctor against finalized ABI state. */
  resolveFnctor?(shape: import("../fnctor-abi.js").IrFnctorShape): IrFnctorLowering | null;
  /** Exact semantic-to-physical parameter refinement for a prepared owner. */
  resolveParamPhysicalType?(
    unitId: IrUnitId,
    parameterIndex: number,
    logicalType: IrType,
  ): { readonly type: ValType; readonly refineNonNull?: true } | undefined;
  /**
   * Slice 6 (#1169e): resolve a vec struct given its top-level Wasm
   * ValType. The IR carries the vec's value as a `ref`/`ref_null` to a
   * registered vec struct; the resolver inspects the struct's fields to
   * verify the layout is `{ length: i32, data: (ref $arr) }` and returns
   * the typeIdx + field indices + element ValType. Returns `null` when
   * the type isn't a recognisable vec — caller treats that as a bug
   * (selector should have rejected the for-of).
   */
  resolveVec?(valType: ValType): IrVecLowering | null;
  /**
   * #1804 — resolve (registering if needed) the vec struct for an *element*
   * ValType, used by `vec.new_fixed` construction where a fresh literal has no
   * vec typeIdx yet. Unlike `resolveVec` (read-only — recognizes an existing
   * `(ref $vec)`), this get-or-creates the `$arr`/`$vec` types for the element
   * via the legacy registry so the constructed vec shares identity with the
   * legacy `compileArrayLiteral` output (===, instanceof Array, the for-of fast
   * path). Returns the same `IrVecLowering` shape as `resolveVec`.
   */
  resolveVecForElement?(elementValType: ValType, alloc?: AllocSiteId): IrVecLowering | null;
  /**
   * Resolve the Wasm value type used for `IrType.string` in the active
   * backend.
   *   - `wasm:js-string` mode → `{ kind: "externref" }`.
   *   - `nativeStrings` mode  → `{ kind: "ref", typeIdx: ctx.anyStrTypeIdx }`.
   * Optional so Phase-1 resolvers without string support can omit it; a
   * function that actually emits a `string.*` instr will fail at lowering
   * time when it's missing.
   */
  resolveString?(): ValType;
  /**
   * #2949 slice 1 — resolve the Wasm value type used for `IrType.dynamic`
   * (the boxed-any carrier) in the active backend/mode. The contract is the
   * ratified #1852 representation table, and the returned ValType MUST match
   * legacy `resolveWasmType`'s any/unknown arm exactly so IR-claimed and
   * legacy-compiled functions agree on the `any` ABI:
   *   - WasmGC fast/standalone mode → `ref_null $AnyValue` (registered via
   *     `ensureAnyValueType`; the `__any_box_*` helper family's carrier).
   *   - WasmGC host (non-fast) mode → `externref` (host-boxed values).
   *   - Linear backend → DEFERRED (#1852-G4 / #2956): omit the method;
   *     lowering a dynamic-typed function there fails loudly.
   * Optional so Phase-1 resolvers without dynamic support can omit it; a
   * function that actually carries a dynamic-typed value fails at lowering
   * time when it's missing.
   */
  resolveDynamic?(): ValType;
  /**
   * #2949 slice 3 — resolve the op-emission handle for dynamic
   * box/unbox/tag.test lowering (see `IrDynamicLowering` in
   * `backend/handles.ts` for the full contract, incl. the V2 numeric-class
   * tag.test rule). MUST agree with `resolveDynamic()` on the carrier — one
   * mode split, two views of it. Optional like `resolveDynamic`; a function
   * that actually emits a dynamic box/unbox/tag.test fails at lowering time
   * when it's missing. Returns `null` when the active backend/mode has no
   * dynamic op lowering (linear — #1852-G4/#2956).
   *
   * Registration discipline: the integration layer pre-registers every
   * helper/import the handle can emit (`preregisterDynamicSupport`) BEFORE
   * Phase-3 lowering starts, so no `emit*` call can trigger a mid-emission
   * late-import funcIdx shift (the #329/#2078 bug class).
   */
  resolveDynamicLowering?(): IrDynamicLowering | null;
  /**
   * Slice 6 part 4 (#1183) refactored in #1185: returns whether the
   * compiler is in native-strings mode. Drives the for-of strategy
   * switch for `string`-typed iterables in `lowerForOfStatement`.
   * Optional for the same reason as `resolveString` — Phase-1
   * resolvers without string support can omit it.
   */
  nativeStrings?(): boolean;
  /**
   * Emit the Wasm op sequence that materializes a string literal.
   *   - host strings → register a `string_constants.<value>` global import
   *                    and emit `[global.get]`.
   *   - native       → read prepared immutable storage or call an exact
   *                    prepared oversized-literal materializer.
   */
  // #1588: `alloc` lets the resolver read the string.const encoding decision.
  // Optional — resolvers/callers that omit it get the i16 path (byte-identical).
  emitStringConst?(
    value: string,
    alloc?: AllocSiteId,
    storage?: IrGlobalRef,
    materializer?: IrFuncRef,
  ): readonly Instr[];
  /** `[call concat]` (host) or `[call __str_concat]` (native). */
  emitStringConcat?(alloc?: AllocSiteId, mode?: IrStringConcatMode, provider?: IrFuncRef): readonly Instr[];
  /** Full-semantics `(string, f64) -> string` repeat provider call. */
  emitStringRepeat?(
    alloc?: AllocSiteId,
    inputEncoding?: IrStringEncoding,
    provider?: IrFuncRef,
    countedStringAppendTripCount?: number,
  ): readonly Instr[];
  /** `[call equals]` (host) or `[call __str_equals]` (native). */
  emitStringEquals?(provider?: IrFuncRef): readonly Instr[];
  /**
   * `[call length]` (host) or `[struct.get $AnyString $len]` (native).
   * Result is i32 — the `string.len` IR instr appends an
   * `f64.convert_i32_s` after this.
   */
  emitStringLen?(inputEncoding?: IrStringEncoding, provider?: IrStringLengthProvider): readonly Instr[];
  /** Typed character operations consume an already-normalized i32 index. */
  emitStringCharAt?(alloc?: AllocSiteId, inputEncoding?: IrStringEncoding, provider?: IrFuncRef): readonly Instr[];
  emitStringCharCodeAt?(inputEncoding?: IrStringEncoding, provider?: IrFuncRef): readonly Instr[];
  /**
   * Slice 9 (#1169h): resolve (and lazily register) the shared `__exn`
   * exception tag. The tag carries an `externref` payload — every
   * thrown value is coerced to externref upstream. Returning the
   * `tagIdx` lets the lowerer emit `throw $exnTagIdx` and `try ...
   * catch $exnTagIdx`. IR-compiled throws are catchable by
   * legacy-compiled handlers (and vice versa) because both paths go
   * through the same single tag.
   */
  ensureExnTag?(): number;
  /**
   * True for no-JavaScript-host targets that use the standardized
   * `try_table` exception proposal. Host `gc` output keeps the legacy
   * `try`/`catch` encoding for compatibility with JavaScript engines.
   */
  standardizedExceptions?(): boolean;
  /**
   * #1373b Phase C scaffolding — resolve (and lazily register) the
   * standalone `$Promise` WasmGC struct type. The struct's layout is
   * `{ state: i32, value: externref, callbacks: externref, $bag: externref }` (see
   * `src/codegen/async-scheduler.ts` for the canonical registration).
   *
   * Returns the struct's typeIdx. Used by IR's `async.return`,
   * `async.throw`, and `await` lowering to construct or inspect
   * Promise values without going through the JS-host `Promise.resolve`
   * / `Promise.reject` imports.
   *
   * Optional — Phase-1 resolvers (pre-#1373b) can omit it; lowering
   * falls back to a throw stub when missing.
   */
  resolvePromiseType?(): number;
  /**
   * (#1373b C-1) True iff the compile's awaited values are the Wasm-native
   * `$Promise` carrier (`isStandalonePromiseActive(ctx)` — currently the
   * wasi lane). Decides the `await` lowering:
   *   - `true`  → one-level guarded `$Promise` unwrap (mirrors the legacy
   *     `emitStandaloneAwaitUnwrap` in expressions.ts — keep in lockstep);
   *   - `false`/absent → identity passthrough (JS-host sync model — host
   *     promises are host objects; the #1796 call-site contract owns
   *     wrapping/unwrapping).
   */
  nativePromiseCarrierActive?(): boolean;
}

export interface IrLowerResult {
  readonly func: WasmFunction;
}

/**
 * One named logical value in backend slot form. A backend may represent one
 * IR value with more than one slot; the grouping is retained here so the
 * generic result never has to manufacture a Wasm local index or `ValType`.
 */
export interface IrLoweredValue<Slot> {
  readonly name: string;
  readonly slots: readonly Slot[];
}

/**
 * #1584/#3296: backend-neutral function-lowering result. The sink and value
 * slot types are independent generic parameters. Function type interning and
 * concrete local numbering belong to the backend wrapper/assembler, not this
 * result; consequently there is no mandatory Wasm `typeIdx`, `LocalDef`, or
 * `Instr[]` anywhere in the shape.
 */
export interface IrLoweredBody<S, Slot> {
  readonly name: string;
  readonly body: S;
  readonly params: readonly IrLoweredValue<Slot>[];
  readonly locals: readonly IrLoweredValue<Slot>[];
  readonly results: readonly (readonly Slot[])[];
  readonly exported: boolean;
}

export interface IrLoweredSignature<Slot> {
  readonly params: readonly IrLoweredValue<Slot>[];
  readonly results: readonly (readonly Slot[])[];
}
