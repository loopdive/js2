// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrClassId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { ValType } from "../../wasm/model/instructions.js";
import type { IrFnctorShape } from "./fnctor-shapes.js";
import type { IrFuncRef } from "./value-references.js";
import { type TagId, tagRefinementEquals } from "./tag-refinement.js";
import { requireBindingId } from "./binding-key-primitives.js";

// ---------------------------------------------------------------------------
// Symbolic references
// ---------------------------------------------------------------------------
//
// Symbolic refs are the whole reason the middle-end IR exists. The legacy
// pipeline embeds raw funcIdx / globalIdx integers in emitted instructions,
// so any late import addition must re-walk every body via
// `shiftLateImportIndices` to rewrite those integers. The IR instead emits
// a symbolic `IrFuncRef` with a structural callable binding; lowering resolves
// it to a concrete index AFTER all imports are finalized, making the shift
// pass a no-op on the IR path. `name` remains only a compatibility/debug label.

/** Closed structural identity for every symbolic IR type target. */
export type IrTypeBinding =
  | { readonly kind: "source"; readonly bindingId: IrBindingId }
  | {
      readonly kind: "class";
      readonly bindingId: IrBindingId;
      readonly classId: IrClassId;
    }
  | {
      readonly kind: "runtime";
      readonly bindingId: IrBindingId;
      readonly symbol: string;
    }
  | { readonly kind: "support"; readonly bindingId: IrBindingId };

export interface IrTypeRef {
  readonly kind: "type";
  /** Compatibility/debug label; never the semantic lookup key. */
  readonly name: string;
  readonly binding: IrTypeBinding;
}

/** Nominal compiler-support storage; physical ownership is resolved later. */
export interface IrSupportRefType {
  readonly kind: "support-ref";
  readonly ref: IrTypeRef & {
    readonly binding: Extract<IrTypeBinding, { readonly kind: "support" }>;
  };
  readonly nullable: boolean;
}

export function irSupportRef(ref: IrTypeRef, nullable: boolean): IrSupportRefType {
  if (!ref || ref.kind !== "type" || ref.binding?.kind !== "support")
    throw new TypeError("support-ref requires a support type reference");
  requireBindingId(ref.binding.bindingId, "support-ref bindingId", "type");
  if (typeof nullable !== "boolean") throw new TypeError("support-ref nullability must be boolean");
  return { kind: "support-ref", ref: ref as IrSupportRefType["ref"], nullable };
}

/**
 * Final, backend-selected storage identities for one logical dense vector.
 *
 * The middle end reasons about {@link IrType}'s `vec` arm and its element
 * type. Program preparation later attaches these symbolic Program-ABI refs;
 * neither inference nor optimization observes module-relative type indices.
 * Field indices are part of the compiler/runtime vector ABI rather than a
 * backend registry lookup, so lowering can consume the prepared layout
 * without rediscovering a struct shape from ambient module state.
 */
export interface IrVecLayoutRef {
  readonly carrierType: IrTypeRef;
  readonly dataType: IrTypeRef;
  readonly lengthFieldIndex: number;
  readonly dataFieldIndex: number;
}

// ---------------------------------------------------------------------------
// IR types
// ---------------------------------------------------------------------------
//
// IrType is the middle-end's own type. It is a discriminated union over the
// shapes the middle-end needs to describe:
//
//   { kind: "val",   val: ValType }      A single concrete Wasm value type —
//                                        the 1:1 wrapper around a backend
//                                        ValType (i32, f64, externref, …).
//   { kind: "union", members: IrType[] }  A tagged union of IrTypes, lowered
//                                        to a canonical WasmGC struct with a
//                                        `$tag: i32` discriminator + one or
//                                        more `$val` fields. V1 scope:
//                                        homogeneous-width SCALAR members only
//                                        (e.g. `f64|i32`). Members are
//                                        themselves IrTypes (#1926) so a union
//                                        composes with the symbolic
//                                        string/object/etc. kinds without
//                                        baking a backend ValType (and its
//                                        module-relative typeIdx) into the IR
//                                        type system. The backend resolver
//                                        unwraps each member's underlying
//                                        ValType at lowering time. Members
//                                        containing `externref` / `ref` /
//                                        `funcref` fall back to `dynamic`
//                                        upstream.
//   { kind: "boxed", inner: IrType }     A heap-allocated single-field box
//                                        (`struct (field $val inner)`) —
//                                        lets the middle-end materialise
//                                        scalars on the heap when a
//                                        downstream pass needs a reference.
//                                        The `inner` is an IrType (#1926); the
//                                        backend resolver unwraps it to a
//                                        concrete ValType at lowering time.
//
// Every IrType use-site that would have passed a raw `ValType` now either
//   (a) wraps with `irVal(v)` to produce `{ kind: "val", val: v }`, or
//   (b) reads back via `asVal(t)` which returns the underlying `ValType`
//       when `t.kind === "val"`, otherwise `null`.
//
// Lowering contract (in `lower.ts`):
//   { kind: "val",   val }     → `val` (unchanged).
//   { kind: "union", members } → ref to the canonical `$union_<members>`
//                                struct (registered once per module via
//                                `passes/tagged-union-types.ts`). Each member
//                                IrType is unwrapped to its ValType
//                                (`asVal`) at the resolver boundary.
//   { kind: "boxed", inner }   → ref to a single-field struct with the
//                                inner IrType's ValType as its `$val`
//                                (unwrapped via `asVal` at the resolver
//                                boundary).
//   { kind: "closure", signature }
//                              → ref to the canonical `__fn_wrap_*` ROOT.
//                                Construction still allocates the signature
//                                wrapper or a declared captured subtype.
//   { kind: "callable", signature }
//                              → externref boundary carrier for that canonical
//                                wrapper family (#3214 B0).
//   { kind: "dynamic", tag? }  → `resolver.resolveDynamic()` — the module's
//                                canonical boxed-any carrier (#2949/#1852:
//                                `ref_null $AnyValue` in fast/standalone,
//                                `externref` in host mode). The `tag`
//                                refinement never changes the carrier.

/**
 * A canonical object shape — a sorted list of named fields with their IR
 * types. Equal shapes (same names, same types in the same canonical order)
 * resolve to the same WasmGC struct via the lowerer's resolver. Carrying
 * the field types as `IrType` (not `ValType`) lets a struct-of-string or
 * struct-of-object compose cleanly: the resolver recursively materializes
 * field types when registering the WasmGC struct.
 *
 * Names must be unique. The constructor in `from-ast.ts` sorts by name
 * before constructing the IrType so structurally-identical shapes compare
 * equal regardless of source order.
 */
export interface IrObjectShape {
  readonly fields: readonly { readonly name: string; readonly type: IrType }[];
}

/**
 * Slice 3 (#1169c) — a closure's caller-visible signature. Used both as
 * the IR-level type discriminator for closure values and as the resolver
 * lookup key for the signature allocation wrapper + exact lifted func type.
 * The implicit canonical-root `__self` param at index 0 of the lifted body is
 * NOT present in `params` — the resolver adds it to the func type.
 */
export interface IrClosureSignature {
  readonly params: readonly IrType[];
  /**
   * First caller-visible parameter with an expression default. The physical
   * closure ABI still carries every entry in `params`; callers pad an omitted
   * numeric suffix with the reserved legacy missing-argument sentinel.
   */
  readonly defaultParamStart?: number;
  /** `null` is the canonical zero-result / JavaScript `void` signature. */
  readonly returnType: IrType | null;
}

/**
 * Slice 4 (#1169d) — descriptor for one field on a class.
 */
export interface IrClassFieldDescriptor {
  readonly name: string;
  readonly type: IrType;
}

/**
 * Descriptor for one projected callable class member. The implicit `this`
 * receiver on instance methods/accessors is NOT listed in `params`; the
 * lowerer prepends it when emitting the call. Static methods have no implicit
 * receiver. A void method or setter has `returnType: null`.
 */
export type IrClassMemberKind = "method" | "getter" | "setter" | "static";

export interface IrClassMethodDescriptor {
  readonly name: string;
  readonly params: readonly IrType[];
  readonly returnType: IrType | null;
  /**
   * Exact source callable selected by this descriptor. Production class-shape
   * projection always supplies it; optionality keeps compatibility fixtures
   * fail-closed until they adopt structural identity.
   */
  readonly target?: IrFuncRef;
  /**
   * Exact source placement for body ownership and ABI patching. `name` is the
   * already-resolved semantic property key; consumers must not recover this
   * identity from a flat class/member spelling.
   */
  readonly placement?: {
    readonly classId: IrClassId;
    readonly unitId: IrUnitId;
    readonly staticClassMember: boolean;
  };
  /**
   * (#3144) Member kind discriminator. Absent/`"method"` = instance method
   * (the pre-#3144 population — every existing consumer that reads
   * `shape.methods` expects instance methods, so lookups MUST filter on this
   * flag). `"getter"`/`"setter"` are accessor projections: `name` is the
   * PROPERTY name (`name`, `age`), params/returnType follow the accessor
   * signature (getter: `[] -> T`; setter: `[T] -> null`); the lowered call
   * target is `<className>_get_<name>` / `<className>_set_<name>` (the legacy
   * accessor key — inherited accessors are key-propagated to subclasses by
   * `collectClassDeclaration`, so resolution by the RECEIVER's className is
   * sound). `"static"` methods have no `this` param at the Wasm level and are
   * invoked via `class.static_call` (never through an instance receiver).
   */
  readonly memberKind?: IrClassMemberKind;
}

/**
 * Slice 4 (#1169d) — symbolic descriptor for a class declared in the
 * compilation unit. Carries the structural info the IR builder needs to
 * type-check `new`/field-access/method-call expressions on instances of
 * this class without consulting the lowering resolver.
 *
 *   - `classId`          source-qualified semantic identity
 *   - `className`        compatibility/debug label
 *   - `fields`           user fields in canonical order (alphabetical)
 *                        — the lowerer maps each field `name` to a Wasm
 *                        struct field index via `resolveClass`, which knows
 *                        about the legacy `__tag` prefix at field 0.
 *   - `methods`          callable class members with caller-visible
 *                        signatures and an explicit semantic member kind.
 *   - `constructorParams` user-visible param list for `new C(...)`.
 *
 * Class-member bodies currently share the legacy allocator. The call site
 * carries the class descriptor, semantic member kind, and source member name;
 * the resolver returns an exact typed callable reference for the selected
 * allocator-owned slot.
 */
export const IR_CLASS_SHAPE_CELL: unique symbol = Symbol("IR_CLASS_SHAPE_CELL");

export interface IrClassShape {
  /**
   * Compiler-owned identity cell for a shape that may participate in a
   * recursive class graph. The prepared-data copier recognizes cycles only
   * through this explicit brand; arbitrary cyclic input remains invalid.
   */
  readonly [IR_CLASS_SHAPE_CELL]?: true;
  readonly classId: IrClassId;
  /** Compatibility/debug label; never the semantic identity. */
  readonly className: string;
  readonly fields: readonly IrClassFieldDescriptor[];
  readonly methods: readonly IrClassMethodDescriptor[];
  readonly constructorParams: readonly IrType[];
  /** AST-free allocation wrapper backing `<Class>_new`. */
  readonly constructorTarget?: IrFuncRef;
  /** Exact constructor source unit backing `<Class>_init`. */
  readonly constructorInitTarget?: IrFuncRef;
  /**
   * #3000-E: the immediate parent class shape for a subclass declared via
   * `class Sub extends Parent`. Present only when `Parent` is a locally-declared
   * user class whose own shape projected (single-level, WasmGC-struct parent).
   * Drives `super(...)` (→ the parent's `_init`) and `super.method()` (→ the
   * parent's method slot). Absent (undefined) for flat / root classes and for
   * subclasses of a builtin/externref-backed parent (which stay on legacy).
   * `classShapeEquals` deliberately does NOT compare `parent` — a shape is
   * identified by its required `classId` (see the doc there).
   */
  readonly parent?: IrClassShape;
}

export type IrType =
  | IrSupportRefType
  // The optional `signed` flag (#1126 Stage 1) is a *value-domain* fact, not
  // a Wasm-storage fact: both `int32` and `uint32` lower to the same Wasm
  // `i32` storage but are distinguished at op-selection time (`i32.shr_s`
  // vs `i32.shr_u`, `f64.convert_i32_s` vs `_u`, signed vs unsigned cmp).
  // Default (undefined) is "signed" for backward compat — every existing
  // `val: { kind: "i32" }` callsite preserves its current semantics.
  // Stage 1 only adds the field; producers / consumers come in Stages 2-3.
  | {
      readonly kind: "val";
      readonly val: ValType;
      readonly signed?: boolean;
      /**
       * Final Program-ABI identity for a backend-owned `ref` / `ref_null`
       * carrier. Middle-end producers may still carry the allocator index in
       * `val` while building the candidate; preparation attaches this ref
       * before a component may seal. Lowering resolves the symbolic identity,
       * never the stale candidate index.
       */
      readonly typeRef?: IrTypeRef;
    }
  // Backend-agnostic string marker (#1169a). The actual Wasm representation
  // is decided at lowering time via `IrLowerResolver.resolveString`:
  //   - host-strings backend  → `externref`
  //   - native-strings backend → `(ref $AnyString)`
  // Keeping the IR type backend-agnostic mirrors how `union`/`boxed` defer
  // their concrete struct to the resolver. From the middle-end's point of
  // view a `string` value is a single SSA def with no member structure.
  //
  // Final prepared IR carries `carrierRef`: a Program-ABI identity for the
  // backend-selected storage carrier. It deliberately does not expose that
  // carrier's Wasm shape to type inference. Transitional/pre-preparation IR
  // may omit the ref; prepared-component discovery then fails closed instead
  // of consulting ambient backend state.
  | { readonly kind: "string"; readonly carrierRef?: IrTypeRef }
  // Backend-neutral dense JS-array/vector marker. The element type and
  // nullability are JS/middle-end facts; the physical WasmGC struct/array
  // identities are attached only at the final preparation boundary. Linear
  // lowering consumes the same logical type and deliberately ignores the
  // WasmGC-specific symbolic layout attachment.
  | {
      readonly kind: "vec";
      readonly elementType: IrType;
      readonly nullable: boolean;
      readonly layout?: IrVecLayoutRef;
    }
  // Backend-agnostic object-shape marker (#1169b). The actual WasmGC struct
  // is registered lazily by `IrLowerResolver.resolveObject`. Like `union`
  // and `boxed`, the IR carries enough information to drive the resolver
  // without committing to a specific Wasm typeIdx until lowering time.
  | { readonly kind: "object"; readonly shape: IrObjectShape }
  // Backend-agnostic INTERNAL closure marker (#1169c). Carries the
  // caller-visible signature only — captures are an implementation detail of
  // the closure-construction site, not a type-system property. This type is
  // compiler-owned and lowers to the canonical wrapper ROOT carrier. A
  // closure.new site still allocates the signature wrapper (or its captured
  // subtype), both of which are valid root subtypes.
  | { readonly kind: "closure"; readonly signature: IrClosureSignature }
  // #3214 B0 — callable values crossing a source-function boundary. Legacy
  // already exposes callbacks as externref-wrapped `__fn_wrap_*` values, so
  // IR parameters must use the same ABI rather than leaking the internal
  // closure struct reference. `callable<S>` is deliberately distinct from
  // `closure<S>`: only an explicit closure→callable pack may cross the
  // boundary, while callable→callable forwards without representation churn.
  | { readonly kind: "callable"; readonly signature: IrClosureSignature }
  // Slice 4 (#1169d) — symbolic class instance reference. The Wasm-level
  // value type is `(ref $ClassStruct)` where the struct is registered by
  // the legacy `collectClassDeclaration` pass; the resolver maps
  // `shape.className` to the concrete struct typeIdx + the fieldIdx /
  // method funcIdx tables. The IR carries the full shape so the
  // AST→IR lowerer can statically resolve field types and method
  // signatures without resolver round-trips.
  | { readonly kind: "class"; readonly shape: IrClassShape }
  // Slice 10 (#1169i) — opaque externref reference to a host-class value
  // (RegExp, Uint8Array, DataView, Map, Date, …). The Wasm-level type is
  // always `externref` — the IR carries the className for static method
  // / property dispatch at lowering time. The AST→IR layer tags
  // `extern.new`, `extern.regex`, and method-call results with this
  // type so subsequent receiver lookups can dispatch by className
  // without a TS-checker round trip. See `src/ir/from-ast.ts`'s
  // `lowerExternMethodCall` and the `extern.*` IR instr kinds.
  | { readonly kind: "extern"; readonly className: string }
  // #3521 — nominal function-style constructor instance. The shape is
  // source/unit/layout-qualified and remains opaque until the fnctor lowering
  // resolver proves the reserved ABI. It is deliberately not an object/class
  // alias: unsupported backends must decline it rather than guess a carrier.
  | { readonly kind: "fnctor"; readonly shape: IrFnctorShape }
  // #1926 — union members are IrTypes, not raw ValTypes. V1 still only
  // admits scalar (`f64`/`i32`) members upstream (see
  // `passes/tagged-unions.ts`), but typing them as IrType keeps the IR
  // backend-symbolic (no module-relative `ref { typeIdx }` reachable
  // through the type system) and lets the resolver unwrap each member's
  // ValType at lowering time.
  | { readonly kind: "union"; readonly members: readonly IrType[] }
  // Slice 3 (#1169c) repurposes `boxed` as the ref-cell type for mutable
  // captures. The inner IrType is the cell's stored type (#1926 — an IrType,
  // not a raw ValType); the resolver unwraps it to a ValType and delegates
  // to `getOrRegisterRefCellType` so legacy and IR ref cells share the same
  // WasmGC struct.
  | { readonly kind: "boxed"; readonly inner: IrType }
  // #2949 slice 1 — the DYNAMIC leaf: a value whose JS type is not statically
  // known (JS `any` / `unknown`, propagation-lattice top, reflective access
  // results). This is the lattice TOP of the IrType system: every other
  // IrType is convertible INTO dynamic via an explicit `box` instruction and
  // OUT of it via explicit `unbox` (after a `tag.test` proof). There are NO
  // implicit conversions — the verifier rejects a dynamic operand feeding
  // any op that requires a concrete kind (see verify.ts #2949 rules).
  //
  // `tag` is an OPTIONAL static refinement: when present, the producer has
  // proved the runtime partition of the value (e.g. after a `tag.test`
  // branch), enabling checked unboxes and op selection without a runtime
  // re-test. Absence means "partition unknown". The refinement is erased at
  // joins: two dynamics with different (or one missing) tags are NOT equal
  // under `irTypeEquals` — producers must widen to the bare
  // `{kind:"dynamic"}` before a join point (branch args, slot writes).
  //
  // #3954 phase 1 — the tag is an OPAQUE `TagId`, not an ECMAScript `JsTag`.
  // Which partitions exist, what each one's payload carrier is, how two
  // refinements join, and how a partition coerces to boolean/number are all
  // properties of the PRODUCER's `TagDomain` (`tag-domain.ts`), selected in
  // `producer.ts`. Today `JS_TAG_DOMAIN` is the only implementation and its
  // ids are numerically the `JsTag` values (they are ABI — the `$AnyValue.tag`
  // constants the `__any_box_*` helpers write). The IR core deliberately
  // cannot name a partition: `JS_TAG_IDS.String` is the JavaScript producer's
  // vocabulary (`from-ast.ts`), not the lattice's.
  //
  // Lowering contract (per the ratified #1852 representation table):
  //   - WasmGC: `resolver.resolveDynamic()` returns the module's canonical
  //     boxed-any carrier ValType — `ref_null $AnyValue` in fast/standalone
  //     mode, `externref` in host mode — matching legacy `resolveWasmType`'s
  //     any/unknown arm EXACTLY so IR-claimed and legacy-compiled functions
  //     agree on the `any` ABI. Boxing/unboxing routes through the existing
  //     `__any_box_*` / `$AnyValue` helper family (never a second engine).
  //   - Linear: f64-value + i32-tag parallel cell — DEFERRED (#1852-G4 /
  //     #2956); `resolveDynamic` stays unimplemented there and lowering
  //     throws.
  // The `tag` refinement never changes the carrier — it is compile-time
  // knowledge only.
  | { readonly kind: "dynamic"; readonly tag?: TagId };

/** Wrap a plain ValType as an IrType — the common path for Phase 1/2 callers. */
export function irVal(v: ValType): IrType {
  return { kind: "val", val: v };
}

/** Construct a backend-neutral dense-vector type. */
export function irVec(elementType: IrType, nullable = true): IrType {
  return { kind: "vec", elementType, nullable };
}

/** Construct a nominal, backend-neutral fnctor instance type. */
export function irFnctor(shape: IrFnctorShape): IrType {
  return { kind: "fnctor", shape };
}

/**
 * Return the single underlying ValType for a `val`-kind IrType, else `null`.
 * Call sites that previously did `t.kind === "f64"` against an `IrType` now
 * do `asVal(t)?.kind === "f64"`.
 */
export function asVal(t: IrType): ValType | null {
  return t.kind === "val" ? t.val : null;
}

/**
 * #2949 slice 1 — construct a dynamic IrType, optionally refined with a
 * statically-proven partition. `irDynamic()` is the lattice top (partition
 * unknown); `irDynamic(JS_TAG_IDS.String)` is a refinement the JavaScript
 * producer may emit after a `tag.test` proof. See the `dynamic` arm of
 * `IrType` for the full contract (joins erase refinements; carrier is
 * tag-independent).
 *
 * #3954 phase 1 — `tag` is an opaque {@link TagId} from the producer's
 * `TagDomain`. A bare number (and therefore a `JsTag` member) is deliberately
 * NOT assignable: only a domain can mint one.
 */
export function irDynamic(tag?: TagId): IrType {
  return tag === undefined ? { kind: "dynamic" } : { kind: "dynamic", tag };
}

/**
 * Structural equality for IrType. Two types are equal iff they have the same
 * shape and their underlying ValType members compare structurally equal.
 *
 * Used by the verifier and by migration assertions. We keep the implementation
 * local to avoid pulling a full deep-equal dep into the IR layer.
 */
export function irTypeEquals(a: IrType, b: IrType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "support-ref" && b.kind === "support-ref")
    return a.ref.binding.bindingId === b.ref.binding.bindingId && a.nullable === b.nullable;
  if (a.kind === "val" && b.kind === "val") {
    if (!valTypeEquals(a.val, b.val)) return false;
    // #1126 Stage 1 — `signed` is a domain fact, not a Wasm-storage fact.
    // Two `val` types differ if they disagree on signedness (e.g. an
    // i32 inferred as `int32` in one branch vs `uint32` in another would
    // join to `f64` in the lattice; we never want them to compare equal
    // here). `undefined` is treated as "signed" (the legacy default).
    const aSigned = a.signed ?? true;
    const bSigned = b.signed ?? true;
    return aSigned === bSigned;
  }
  if (a.kind === "string" && b.kind === "string") return true;
  if (a.kind === "vec" && b.kind === "vec") {
    return a.nullable === b.nullable && irTypeEquals(a.elementType, b.elementType);
  }
  // #1926 — `inner`/`members` are IrTypes now, so recurse via irTypeEquals
  // (a boxed-of-string or union-of-symbolic-kind compares structurally).
  if (a.kind === "boxed" && b.kind === "boxed") return irTypeEquals(a.inner, b.inner);
  if (a.kind === "union" && b.kind === "union") {
    if (a.members.length !== b.members.length) return false;
    for (let i = 0; i < a.members.length; i++) {
      if (!irTypeEquals(a.members[i]!, b.members[i]!)) return false;
    }
    return true;
  }
  if (a.kind === "object" && b.kind === "object") {
    return objectShapeEquals(a.shape, b.shape);
  }
  if (a.kind === "closure" && b.kind === "closure") {
    return closureSignatureEquals(a.signature, b.signature);
  }
  if (a.kind === "callable" && b.kind === "callable") {
    return closureSignatureEquals(a.signature, b.signature);
  }
  if (a.kind === "class" && b.kind === "class") {
    return classShapeEquals(a.shape, b.shape);
  }
  // Slice 10 (#1169i) — extern is keyed solely on className. Two
  // `IrType.extern` values represent the same class iff their names
  // match.
  if (a.kind === "extern" && b.kind === "extern") {
    return a.className === b.className;
  }
  if (a.kind === "fnctor" && b.kind === "fnctor") {
    const seen = activeFnctorPairs.get(a.shape);
    if (seen?.has(b.shape)) return true;
    const peers = seen ?? new WeakSet<object>();
    activeFnctorPairs.set(a.shape, peers);
    peers.add(b.shape);
    try {
      return fnctorShapeEquals(a.shape, b.shape, new Set());
    } finally {
      peers.delete(b.shape);
      if (peers) activeFnctorPairs.delete(a.shape);
    }
  }
  // #2949 slice 1 — dynamic equality is EXACT on the `tag` refinement (both
  // absent, or both present and equal). Deliberately strict: silently
  // merging two different refinements at a join would keep whichever tag the
  // first producer wrote, which is provably wrong for the other path.
  // Producers widen to the bare `{kind:"dynamic"}` before joins instead.
  if (a.kind === "dynamic" && b.kind === "dynamic") {
    // #3954 — refinement comparison lives in the domain leaf, not here: this
    // is the rule "a refined dynamic is not the same type as an unrefined
    // one", and it is domain-independent.
    return tagRefinementEquals(a.tag, b.tag);
  }
  return false;
}

const activeFnctorPairs = new WeakMap<object, WeakSet<object>>();

function canonicalRefBinding(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalRefBinding).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalRefBinding(entry)}`).join(",")}}`;
}

function fnctorShapeEquals(
  left: IrFnctorShape,
  right: IrFnctorShape,
  active: Set<readonly [IrFnctorShape, IrFnctorShape]>,
): boolean {
  const pair = [left, right] as const;
  for (const seen of active) if (seen[0] === left && seen[1] === right) return true;
  active.add(pair);
  if (
    left.sourceId !== right.sourceId ||
    left.constructorUnitId !== right.constructorUnitId ||
    left.hiddenIdentity !== right.hiddenIdentity ||
    left.constructorIdentity.unitId !== right.constructorIdentity.unitId ||
    left.constructorIdentity.paramIndex !== right.constructorIdentity.paramIndex ||
    left.constructorTarget.kind !== right.constructorTarget.kind ||
    canonicalRefBinding(left.constructorTarget.binding) !== canonicalRefBinding(right.constructorTarget.binding) ||
    left.reservedLayout.kind !== right.reservedLayout.kind ||
    canonicalRefBinding(left.reservedLayout.binding) !== canonicalRefBinding(right.reservedLayout.binding) ||
    left.fields.length !== right.fields.length ||
    left.captures.length !== right.captures.length ||
    left.userParamTypes.length !== right.userParamTypes.length
  ) {
    return false;
  }
  for (let i = 0; i < left.fields.length; i++) {
    const aField = left.fields[i]!;
    const bField = right.fields[i]!;
    if (aField.name !== bField.name || aField.ordinal !== bField.ordinal || !irTypeEquals(aField.type, bField.type))
      return false;
  }
  for (let i = 0; i < left.captures.length; i++) {
    const aCapture = left.captures[i]!;
    const bCapture = right.captures[i]!;
    if (
      aCapture.name !== bCapture.name ||
      aCapture.ordinal !== bCapture.ordinal ||
      aCapture.hasTdzFlag !== bCapture.hasTdzFlag ||
      !irTypeEquals(aCapture.type, bCapture.type)
    )
      return false;
  }
  return left.userParamTypes.every((type, index) => irTypeEquals(type, right.userParamTypes[index]!));
}

/**
 * Nominal equality for source class shapes. `classId` is source-qualified,
 * so same-labelled declarations remain distinct across source and lexical
 * owners. Shape payload and `className` are projections/diagnostics only.
 */
export function classShapeEquals(a: IrClassShape, b: IrClassShape): boolean {
  return a.classId === b.classId;
}

/**
 * Structural equality for closure signatures. Recurses through param /
 * return IrTypes via `irTypeEquals` so a closure-of-closure or a
 * closure-of-object compares correctly.
 */
export function closureSignatureEquals(a: IrClosureSignature, b: IrClosureSignature): boolean {
  if (a.params.length !== b.params.length) return false;
  if ((a.defaultParamStart ?? a.params.length) !== (b.defaultParamStart ?? b.params.length)) return false;
  for (let i = 0; i < a.params.length; i++) {
    if (!irTypeEquals(a.params[i]!, b.params[i]!)) return false;
  }
  return a.returnType === null || b.returnType === null
    ? a.returnType === b.returnType
    : irTypeEquals(a.returnType, b.returnType);
}

/**
 * Structural equality for object shapes. Field lists must be parallel
 * (same length, same order, same name and IrType per slot). Recursing
 * via `irTypeEquals` lets nested object fields compare correctly.
 */
export function objectShapeEquals(a: IrObjectShape, b: IrObjectShape): boolean {
  if (a.fields.length !== b.fields.length) return false;
  for (let i = 0; i < a.fields.length; i++) {
    const fa = a.fields[i]!;
    const fb = b.fields[i]!;
    if (fa.name !== fb.name) return false;
    if (!irTypeEquals(fa.type, fb.type)) return false;
  }
  return true;
}

function valTypeEquals(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "ref" || a.kind === "ref_null") {
    return (a as { typeIdx: number }).typeIdx === (b as { typeIdx: number }).typeIdx;
  }
  return true;
}
