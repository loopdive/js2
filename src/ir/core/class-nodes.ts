// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrInstr, IrInstrBase, IrValueId } from "./nodes.js";
import type { IrFuncRef } from "./value-references.js";
import type { IrClassShape, IrClassMemberKind, IrClosureSignature, IrType } from "./types.js";

/** Fresh class constructor value; source captures live in its Construct closure. */
export interface IrInstrClassValueNew extends IrInstrBase {
  readonly kind: "class.value.new";
  /** Exact non-capturing class [[Call]] stub, with the lifted caller signature. */
  readonly callTarget: IrFuncRef;
  readonly signature: IrClosureSignature;
  /** Explicit selected allocation provider; no ambient class-value resolver. */
  readonly allocator: IrFuncRef;
  readonly construct: IrValueId;
  readonly parent: IrValueId;
  readonly properties: IrValueId;
}

// ---------------------------------------------------------------------------
// Class operations (#1169d — IR Phase 4 Slice 4)
// ---------------------------------------------------------------------------
//
// Class instances live as `(ref $ClassStruct)` at the Wasm level. The IR
// represents them via `IrType.class` carrying the full `IrClassShape`, and
// `IrInstrClass*` ops symbolically reference the class through `shape`.
// The lowerer's `resolveClass` maps `shape.className` → struct typeIdx +
// constructor / method funcIdx + per-field index, all of which were
// allocated by the legacy `collectClassDeclaration` pass before the IR
// runs.
//
// Slice 4 keeps class methods themselves on the legacy path. The IR only
// claims OUTER functions that USE class instances — `class.call` resolves
// to a direct `call $<className>_<methodName>` against the legacy-compiled
// method body, with `this` prepended as the first argument.

/**
 * Construct a class instance through the class-owned AST-free `_new` wrapper.
 *
 * Lowering:
 *   <emit each arg in order>
 *   call $<className>_new
 *
 * Result type: `{ kind: "class"; shape }`. The Wasm-level value type is
 * `(ref $ClassStruct)` (non-null). The wrapper allocates once and tail-calls
 * the exact source-owned `<className>_init`.
 */
export interface IrInstrClassNew extends IrInstrBase {
  readonly kind: "class.new";
  readonly shape: IrClassShape;
  readonly target?: IrFuncRef;
  readonly args: readonly IrValueId[];
}

/**
 * Read a named field from a class instance. `value` must be `IrType.class`
 * with a shape containing `fieldName`. Lowering emits:
 *   <emit value>
 *   struct.get $<className> <wasmFieldIdx>
 *
 * The wasm field index accounts for the legacy `__tag` prefix at field 0
 * — see `IrLowerResolver.resolveClass`.
 *
 * Result type: the field's IrType (also placed in `resultType`).
 */
export interface IrInstrClassGet extends IrInstrBase {
  readonly kind: "class.get";
  readonly value: IrValueId;
  readonly fieldName: string;
}

/**
 * Write a named field on a class instance. Void result. Lowering emits:
 *   <emit value>
 *   <emit newValue>
 *   struct.set $<className> <wasmFieldIdx>
 *
 * The legacy `collectClassDeclaration` pass widens all class fields to
 * `mutable: true`, so `struct.set` is always valid.
 */
export interface IrInstrClassSet extends IrInstrBase {
  readonly kind: "class.set";
  readonly value: IrValueId;
  readonly fieldName: string;
  readonly newValue: IrValueId;
}

/**
 * Invoke an instance method or accessor. `receiver` must be `IrType.class`
 * whose shape contains the (`memberKind`, `methodName`) pair. `methodName`
 * remains the source-level member name even for getters/setters; the resolver
 * owns their compatibility spelling. The implicit `this` is prepended as the
 * first call argument. Lowering emits:
 *   <emit receiver>
 *   <emit each arg in order>
 *   call $<resolved exact member binding>
 *
 * Result type: the member descriptor's `returnType`. A void method/setter has
 * `result: null` and `resultType: null`; the AST→IR lowerer rejects
 * such calls in expression position so we never see a void method as
 * `lowerExpr` output.
 */
export interface IrInstrClassCall extends IrInstrBase {
  readonly kind: "class.call";
  readonly receiver: IrValueId;
  readonly target?: IrFuncRef;
  readonly memberKind: Exclude<IrClassMemberKind, "static">;
  readonly methodName: string;
  readonly args: readonly IrValueId[];
}

/**
 * #3000-E: a derived constructor's `super(args)` call. Runs the PARENT class's
 * `<parent>_init` on the already-allocated `self` — NOT the parent's `_new`
 * (which would allocate a second, wrong-typed instance). The legacy backend
 * splits every WasmGC-struct class into `<Class>_new` (alloc + tail-call init)
 * and `<Class>_init` (`(...ctorParams, self) -> (ref $struct)` — field inits +
 * ctor body, self LAST), and lowers a derived `super(...)` to
 * `call <Parent>_init(args..., self)`. This instr mirrors that exactly.
 *
 * Statement-only (no SSA result): `<Parent>_init` returns `(ref $ParentStruct)`
 * but `super(...)` as a statement discards it, so the lowering drops the result.
 * `self` is a `(ref $SubStruct)` — a WasmGC subtype of `(ref $ParentStruct)`, so
 * the raw `call` typechecks. Lowering emits: <each arg>, <self>, call, drop.
 */
export interface IrInstrClassSuperInit extends IrInstrBase {
  readonly kind: "class.super_init";
  readonly parentShape: IrClassShape;
  readonly target?: IrFuncRef;
  readonly self: IrValueId;
  readonly args: readonly IrValueId[];
}

/**
 * #3000-E: a `super.method(args)` call inside a subclass method. Static-dispatches
 * to the PARENT's method slot (`<parent>_<method>`) with the subclass receiver.
 * Unlike `class.call` (which resolves the method against the RECEIVER's shape),
 * this resolves against `parentShape` so an override on the subclass is bypassed.
 * The receiver value is a `(ref $SubStruct)` passed where the parent method
 * expects `(ref $ParentStruct)` (valid WasmGC subtyping). Lowering emits:
 *   <receiver> <each arg> call $<parent>_<method>
 * Result type: the parent method descriptor's `returnType` (null → void).
 *
 * (#3522 W1-C) `memberKind` selects WHICH member slot of the parent is
 * dispatched, exactly as it does on `class.call`: `"method"` → `<parent>_<name>`,
 * `"getter"` → `<parent>_get_<name>` (a `super.<accessor>` read, no args),
 * `"setter"` → `<parent>_set_<name>` (a `super.<accessor> = v` write, one arg,
 * void). ABSENT means `"method"` — the pre-#3522 population, so every existing
 * producer keeps its exact slot. The kind never widens the OPERATION: this is
 * still one static call to a parent slot, which is why the op is shared rather
 * than split.
 */
export interface IrInstrClassSuperCall extends IrInstrBase {
  readonly kind: "class.super_call";
  readonly parentShape: IrClassShape;
  readonly receiver: IrValueId;
  readonly target?: IrFuncRef;
  readonly methodName: string;
  readonly memberKind?: Exclude<IrClassMemberKind, "static">;
  readonly args: readonly IrValueId[];
}

/**
 * (#3144) `value instanceof C` where `C` is a locally-declared user class.
 * `value` must be `IrType.class` (a non-null `(ref $Struct)` — the IR's class
 * carrier is never null, so no null arm is needed). Lowering mirrors the
 * legacy `compileInstanceOf` non-nullable-ref path byte-for-byte in shape:
 *   <emit value>
 *   struct.get $<RecvStruct> <__tag fieldIdx>       ;; hidden tag at slot 0
 *   ;; compare against the TARGET class's tag + all descendant tags
 *   i32.const t0, i32.eq [ (i32.or i32.const ti, i32.eq)* via scratch local ]
 * The compatible-tag set comes from the resolver (`IrClassLowering.
 * instanceOfTags` — own tag + transitive children, the same walk as legacy's
 * `collectInstanceOfTags`). An empty tag set lowers to `drop; i32.const 0`
 * (legacy parity for a tag-less class). Result type: i32 (JS boolean).
 */
export interface IrInstrClassInstanceOf extends IrInstrBase {
  readonly kind: "class.instanceof";
  readonly value: IrValueId;
  readonly targetShape: IrClassShape;
}

/**
 * (#3144) Static method call `C.m(args)` on a locally-declared user class.
 * No receiver: legacy compiles a static method WITHOUT a `self` param
 * (`class-bodies.ts` — `methodParams = isStatic ? [] : [self]`), so the
 * lowering emits args then a call resolved via `IrClassLowering.memberFunc`.
 * Its typed binding selects the slot; its name remains the compatibility key
 * for the current backend adapter. `shape` is the class named at the call site; an inherited static
 * resolves through the same key thanks to legacy's inherited-member key
 * propagation. Result type: the descriptor's `returnType` (null → void).
 */
export interface IrInstrClassStaticCall extends IrInstrBase {
  readonly kind: "class.static_call";
  readonly shape: IrClassShape;
  readonly target?: IrFuncRef;
  readonly methodName: string;
  readonly args: readonly IrValueId[];
}

export function explicitIrClassShapes(
  instr: IrInstr,
  valueTypes: ReadonlyMap<IrValueId, IrType>,
): readonly IrClassShape[] {
  switch (instr.kind) {
    case "class.new":
    case "class.static_call":
      return [instr.shape];
    case "class.super_init":
    case "class.super_call":
      return [instr.parentShape];
    case "class.instanceof":
      return [instr.targetShape];
    case "class.get":
    case "class.set":
    case "class.call": {
      const receiver = valueTypes.get(instr.kind === "class.call" ? instr.receiver : instr.value);
      return receiver?.kind === "class" ? [receiver.shape] : [];
    }
    default:
      return [];
  }
}
