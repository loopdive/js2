// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// AST → IR lowering.
//
// Phase 1 numeric/bool subset. The selector in `select.ts` restricts us to
// functions whose params are number/boolean, whose return type is
// number/boolean, and whose body is a "tail":
//   - zero or more `(let|const) <id> = <expr>;` declarations, followed by
//   - either `return <expr>;` OR `if (<expr>) <tail> else <tail>`,
//   - where each if-arm is itself a valid tail (terminates via return).
//
// `<expr>` may be:
//   - NumericLiteral / TrueKeyword / FalseKeyword
//   - Identifier referring to a parameter or a previously-declared local
//   - BinaryExpression with an arithmetic / comparison / logical operator
//   - PrefixUnaryExpression with `-`, `+`, `!`
//   - ConditionalExpression (`a ? b : c`)
//   - CallExpression to a locally-declared function (Phase 2)
//   - ParenthesizedExpression (unwrap)
//
// Everything else throws — the selector must keep those functions on the
// legacy path.
//
// Control flow is represented as basic blocks with `br_if` terminators. The
// entry block holds the pre-branch `let`/`const` decls; each if-arm is its
// own block (fork scope so declarations don't leak). Arms always terminate
// with `return` — Phase 1 doesn't model join blocks yet.
//
// Phase 2 extensions:
//   - Explicit TS `: number` / `: boolean` annotations are optional. When
//     absent, the caller passes `paramTypeOverrides` / `returnTypeOverride`
//     from the propagated TypeMap. This is what lets a recursive `fib`
//     whose `n` is untyped in source compile as `(f64) -> f64`.
//   - CallExpression to a local function lowers to `IrInstrCall`. The
//     call's return type comes from `callReturnTypes` (same TypeMap),
//     with arg types validated against the propagated callee param types.

import { ts, forEachChild } from "../ts-api.js";
import { exactIndirectEvalStatement } from "../eval-call-shape.js";

import { TsCheckerOracle, type TypeOracle } from "../checker/oracle.js";
import {
  IR_DYN_ADD_FN,
  IR_DYN_GE_FN,
  IR_DYN_GT_FN,
  IR_DYN_LE_FN,
  IR_DYN_LT_FN,
  IR_DYN_METHOD_CALL_0_FN,
  IR_DYN_METHOD_CALL_1_FN,
  IR_DYN_STRING_REPLACE_FN,
} from "../codegen/dyn-ops.js";
import { STANDALONE_REGEXP_CARRIER_TEST_HELPER } from "./regexp-runtime-contract.js";
import { IR_NATIVE_MAP_GET_NUM_FN, IR_NATIVE_MAP_NEW_FN, IR_NATIVE_MAP_SET_NUM_FN } from "../codegen/ir-native-map.js"; // (#4461) native $Map adapter ABI
// (#1373b C-1) Leaf-module async helpers (no codegen/index cycle).
import { staticPromiseResolveSettledExpr, unwrapPromiseTypeNode } from "./async-static.js";
import { boundedPreparedNestedOrdinaryClassBindingName } from "./class-accessor-safety.js";
import { remainderFastPathPlan } from "./analysis/remainder-fast-path.js";
import { evaluateConstantCondition } from "../codegen/statements/control-flow.js";
import type { IrClassInstanceInitializer } from "./class-instance-initializers.js";
// #2766 — reuse the legacy counted-loop proof predicates (pure AST analysis, no
// codegen state) to port the `safeIndexedArrays` in-bounds proof into the IR.
import { isIncreasingStep, loopBodyMutatesIndexOrArray } from "./analysis/loop-shape.js";
// (#3741) native-i32 slot storage for provably-int32 mutable locals
import {
  COMPOUND_TO_BITWISE_TOKEN,
  counterStepAssignment,
  I32_COMPARE_BINOPS,
  i32LiteralValue,
  isBitwiseToken,
  isCanonI32Lowerable,
  type IsPromotedI32,
  isWrapI32Lowerable,
  jsBitwiseBinop,
  peelExpr,
  referencesPromotedI32Slot,
} from "./analysis/i32-slots.js";
import { IrFunctionBuilder } from "./builder.js";
import { emitNumberRemainder } from "./remainder-fast-path.js";
import { sameIrGlobalBinding } from "./abi-bindings.js";
import {
  irImportFuncRef,
  irIntrinsicFuncRef,
  irRuntimeFuncRef,
  irUnitFuncRef,
  sameIrCallableBinding,
} from "./callable-bindings.js";
import { IR_NUMBER_TO_FIXED_FN, IR_NUMBER_TO_STRING_FN } from "./string-runtime.js";
import { timerArg, timerResult } from "./timer-shim-lowering.js";
import { irBool, irTypeIsBoolean, lowerBooleanToString } from "./boolean-brand.js";
import { collectOuterWrites } from "./closure-captures.js";
import { planArrayLiteralSpread } from "./array-spread-shape.js";
import { objectLiteralDataPropertyName } from "./property-key-fold.js";
import { collectDynamicStringLocalWidening } from "./dynamic-local-widening.js";
import { coercibleStandaloneDomArgumentBoundary } from "./dom-boundary.js";
import { fmodRefFor, FMOD_FN } from "./fmod-selection.js";
import { detectFixedLiteralLoopSafeIndexes, forInitsIndexNonNegative } from "./fixed-literal-loop-proof.js";
import {
  requireMatchingModuleBindingOwner,
  requireMatchingLoweringPlanOwner,
  requireValidImportedCallTarget,
  type IrDirectCallLoweringPlan,
  type IrHostDateGetterLoweringPlan,
  type IrHostDateSnapshotLoweringPlan,
  type IrHostVoidCallbackLoweringPlan,
  type IrImportedCallLoweringPlan,
  type IrImportedOptionalParamPlan,
  type IrTopLevelFunctionValueLoweringPlan,
  type ModuleBindingGlobal,
} from "./ast-lowering-plans.js";
export type {
  IrDirectCallLoweringPlan,
  IrHostDateGetterLoweringPlan,
  IrHostDateSnapshotLoweringPlan,
  IrHostVoidCallbackLoweringPlan,
  IrImportedCallLoweringPlan,
  IrImportedOptionalParamPlan,
  IrTopLevelFunctionValueLoweringPlan,
  ModuleBindingGlobal,
} from "./ast-lowering-plans.js";
import { irDateSnapshotGetterSymbol } from "./date-runtime.js";
import type { AllocSiteRegistry } from "./alloc-registry.js";
import { classifyLiteral, joinEncoding, type Encoding } from "./analysis/encoding.js";
import { proveTypedStringAppend, proveTypedStringMethod, type TypedValueEvidence } from "./analysis/string-evidence.js";
import {
  EmptyArrayElementInference,
  emptyArrayInferenceDiagnostic,
  inferEmptyArrayElementTypes,
} from "./array-element-inference.js";
import {
  annotatedArrayElementValType,
  canonicalCountedPushPlanForLiteral,
  emitForwardingAwareLinearVecLen,
  emitSafeNarrowedI32VecGet,
  emitSafeVecGet,
  emptyLiteralElementValType,
  isNarrowedI32Vec,
  lowerNarrowedI32Element as lowerNarrowedI32ElementWith,
  planI32ArrayElements,
  tryLowerVecPush,
} from "./array-element-lowering.js";
import {
  preparedAsyncAwaitResultType,
  tryLowerPreparedAsyncPromiseAll,
  type PreparedAsyncFromAstResolver,
} from "./async-from-ast.js";
import {
  assertNotDeferred,
  binaryOpCapability,
  collectStringLiteralLens,
  consoleSurfaceCapability,
  domSurfaceCapability,
  hostExternCapability,
  prefixOpCapability,
  stringIndexProvenBelow,
} from "./capability.js";
import type { IrStandaloneDomOperation } from "./dom-capability.js";
import { IR_CONSOLE_METHODS, IR_CONSOLE_SINK_APPEND_FN, IR_NUMBER_TO_STRING_NATIVE_FN } from "./host-free-runtime.js";
import type { IrLowerResolver, IrVecLowering } from "./lower.js";
import {
  allocateLiftedFunctionArtifact,
  type IrDerivedUnitProvenance,
  type IrFunctionIdentity,
  type IrLiftedFunctionArtifactIdentity,
  type IrUnitId,
} from "./identity.js";
import type { IrPlanningIdentityContext } from "./planning-identity.js";
// (#3931) the #2682 canonical char-read-loop recogniser, ported to the IR.
import {
  type CharReadProof,
  detectCanonicalCharReadLoopShape,
  matchProvenCharRead,
  type ProvenCharReads,
} from "./char-read-loop.js";
import {
  computeI32PureNames,
  type I32PureNames,
  isI32PureExprIR,
  isIrBitwiseOperatorToken,
} from "./i32-pure-bitwise.js";
// #4177 — fixpoint-fact consumption for the `+` operand proof.
import { collectLatticeParamFacts, latticeAdditiveFact, type LatticeParamFacts } from "./lattice-param-facts.js";
import { tryEmitUnrolledReduction } from "./reduction-unroll.js";
import { demoteToLegacy, IrInvariantError, IrUnsupportedError } from "./outcomes.js";
import { isPristineEs5IntrinsicIsFrozenCall } from "./object-integrity.js";
import {
  effectiveIrParamTypeNode,
  effectiveIrReturnTypeNode,
  expressionStatementMutatesAtTopLevel,
  irClosureSignatureFromFunctionTypeNode,
  IR_MATH_METHOD_TABLE,
} from "./select.js";
// #3954 phase 1 — `IrType`'s dynamic leaf carries an opaque `TagId`, so a
// box-refinement names its partition through the JS producer's tag-domain
// vocabulary. This file IS the JavaScript producer, so naming ECMAScript
// partitions here is in-layer; the IR core cannot (and must not) do the same.
// #3954 phase 3 (W4/W5) — the `unbox`/`tag.test` instruction fields and the
// builder APIs that construct them now take a `TagId` too, so the direct
// `JsTag` enum import this file used to carry is gone: the producer names its
// partitions through `JS_TAG_IDS` throughout.
import { JS_TAG_IDS } from "./js-tag-domain.js";
import {
  exactClosureLiftedName,
  tryLowerPromiseDelayCall,
  tryLowerPromiseDelayConstruction,
  validateExactCapturePlan,
  type ExactClosureLoweringOptions,
  type IrPromiseDelayLoweringHost,
  type IrPromiseDelayLoweringPlans,
} from "./promise-delay-lowering.js";
import {
  asVal,
  closureSignatureEquals,
  irDynamic,
  irTypeEquals,
  irVal,
  irVec,
  type IrBinop,
  type IrClassShape,
  type IrClosureSignature,
  type IrConst,
  type IrFunction,
  type IrFuncRef,
  type IrGlobalRef,
  type IrInstr,
  type IrLabelId,
  type IrObjectShape,
  type IrType,
  type IrUnop,
  type IrValueId,
} from "./nodes.js";
import type { ValType } from "./types.js";
import { coerceIrValueToExternref } from "./value-coercion.js";
import {
  IR_HOLEY_ARRAY_ELEM_SET,
  IR_HOLEY_ARRAY_NEW,
  irVecElemSetSymbol,
  irVecNewSizedSymbol,
} from "./vector-runtime.js";

interface ResolvedIrVecType {
  readonly lowering: IrVecLowering;
  readonly elementType: IrType;
  readonly valueType: ValType;
}

interface IrSlotRepresentation {
  readonly storageType: ValType;
  readonly bindingType: IrType;
  readonly asType?: IrType;
}

/** Resolve a logical vec type without exposing its physical type index to inference. */
function resolveIrVecType(type: IrType, cx: Pick<LowerCtx, "resolver" | "funcName">): ResolvedIrVecType | null {
  if (type.kind === "vec") {
    const elementValType =
      asVal(type.elementType) ?? (type.elementType.kind === "string" ? cx.resolver?.resolveString?.() : undefined);
    if (!elementValType) return null;
    const lowering = cx.resolver?.resolveVecForElement?.(elementValType);
    if (!lowering) return null;
    const backendValueType =
      cx.resolver?.resolveVecValueTypeForElement?.(elementValType) ??
      lowering.valueType ??
      ({ kind: type.nullable ? "ref_null" : "ref", typeIdx: lowering.vecStructTypeIdx } as ValType);
    const valueType =
      (backendValueType.kind === "ref" || backendValueType.kind === "ref_null") && type.nullable
        ? ({ kind: "ref_null", typeIdx: backendValueType.typeIdx } as ValType)
        : backendValueType;
    return { lowering, elementType: type.elementType, valueType };
  }
  const valueType = asVal(type);
  if (!valueType) return null;
  const lowering = cx.resolver?.resolveVec?.(valueType);
  return lowering ? { lowering, elementType: irVal(lowering.elementValType), valueType } : null;
}

/** Materialize a logical IR type into mutable backend-local storage. */
function resolveIrSlotRepresentation(
  type: IrType,
  resolver: IrFromAstResolver | undefined,
  funcName: string,
): IrSlotRepresentation | null {
  const valueType = asVal(type);
  if (valueType) return { storageType: valueType, bindingType: type };

  let storageType: ValType | undefined;
  if (type.kind === "string") storageType = resolver?.resolveString?.();
  else if (type.kind === "dynamic") storageType = resolver?.resolveDynamic?.();
  else if (type.kind === "vec") {
    storageType = resolveIrVecType(type, { resolver, funcName })?.valueType;
  }
  return storageType ? { storageType, bindingType: irVal(storageType), asType: type } : null;
}

function vecElemSetProviderSymbol(type: IrType, vec: IrVecLowering): string {
  return type.kind === "vec" ? irVecElemSetSymbol(type.elementType) : `__vec_elem_set_${vec.vecStructTypeIdx}`;
}

function vecNewSizedProviderSymbol(type: IrType, vec: IrVecLowering): string {
  return type.kind === "vec" ? irVecNewSizedSymbol(type.elementType) : `__vec_new_sized_${vec.vecStructTypeIdx}`;
}

function unsupportedVoidCallExpression(detail: string): never {
  throw new IrUnsupportedError("void-call-expression", "build", detail);
}

/**
 * Slice 10 (#1169i) — the from-ast view of one extern-class entry. Mirrors
 * `ExternClassInfo` from `src/codegen/context/types.ts` but limits the
 * surface to what the from-ast layer needs to validate `new ExternClass(...)`,
 * `recv.method(...)`, and property access on extern-class receivers.
 *
 * Methods carry the LEGACY-registered signature shape: `params[0]` is the
 * receiver `externref` and `params[1..]` are the user args. The from-ast
 * lowerer slices off the receiver when matching call args against
 * `params.slice(1)`. Slicing here keeps the from-ast logic dispatch-free.
 */
export interface IrExternClassMeta {
  readonly className: string;
  /** Exact legacy/import registry prefix; may differ for namespaces. */
  readonly importPrefix: string;
  readonly constructorParams: readonly ValType[];
  readonly methods: ReadonlyMap<string, { readonly params: readonly ValType[]; readonly results: readonly ValType[] }>;
  readonly properties: ReadonlyMap<string, { readonly type: ValType; readonly readonly: boolean }>;
}

/**
 * Slice 6 part 4 refactor (#1185): a narrowed view of `IrLowerResolver`
 * restricted to the methods the AST→IR build phase actually consults.
 * Threading this subset through `LowerCtx` retires per-feature shortcuts
 * (`nativeStrings: boolean`, `anyStrTypeIdx: number`,
 * `inferVecElementValTypeFromContext`, etc.) without forcing the full
 * resolver — including its lazy struct registries that don't exist
 * yet at Phase-1 build time — into the from-ast layer.
 *
 * Phase-1 callable methods only:
 *   - `resolveString()` — `IrType.string` ValType (extern vs native struct ref)
 *   - `resolveVec(valType)` — vec struct shape recovery
 *
 * (#2955) The raw `nativeStrings()` mode discriminator is deliberately NOT
 * on this interface anymore: every former from-ast mode read is now a
 * narrow resolver-owned capability/rep/strategy query (`stringIsExternref`,
 * `hasHostNumberBox`, `hasHostBooleanBox`, `hasHostNumberToString`, `stringMethodPlan`,
 * `stringForOfPlan`). Keeping the raw discriminator off the front-end
 * surface makes a new representation-polymorphic IR-build branch a compile
 * error instead of a drift channel. (`IrLowerResolver` still carries it —
 * the lower side legitimately owns mode knowledge.)
 *
 * Slice 10 (#1169i) adds:
 *   - `getExternClassInfo(name)` — extern-class metadata for slice-10
 *     lowering of `new ExternClass(...)`, `recv.method(...)`, and
 *     property access on extern-class receivers. Returns undefined if
 *     `name` isn't a registered extern class.
 *
 * The full `IrLowerResolver` (in `src/ir/lower.ts`) extends this and
 * adds Phase-3 methods like `resolveObject`, `resolveClass`,
 * `resolveClosure`. Those depend on registries that aren't populated
 * until Phase 3, so from-ast doesn't see them.
 */
export interface IrFromAstResolver extends PreparedAsyncFromAstResolver {
  /** Resolve the pre-collected exact JS-host indirect-eval import. */
  hostIndirectEvalTarget?(): IrFuncRef | null;
  /** Exact pre-scanned sparse constructor sites. */
  isHoleyArrayConstructor?(expr: ts.NewExpression): boolean;
  /** Exact direct filter consumers of those sparse constructors. */
  isHoleyArrayFilterCall?(expr: ts.CallExpression): boolean;
  /** Exact element writes whose receiver is the same sparse carrier binding. */
  isHoleyArrayElementStore?(expr: ts.ElementAccessExpression): boolean;
  /** Resolve the host-free `%Function.prototype%.[[Call]]` entry point. */
  functionPrototypeCallTarget?(): IrFuncRef | null;
  /**
   * Resolve the fast-standalone predicate for an exact ambient primitive
   * wrapper constructor. Null keeps the operation on direct codegen.
   */
  standaloneWrapperInstanceOfPlan?(ctorName: string): { readonly funcName: string } | null;
  /**
   * Resolve the canonical host ToPropertyDescriptor entry point for an
   * ambient `Object.defineProperty(target, key, descriptor)` call.
   *
   * `null` means this lane cannot preserve the descriptor carrier through
   * the IR yet (notably standalone, whose typed descriptor structs require
   * the legacy reification step before `__obj_define_from_desc`).
   */
  objectDefinePropertyTarget?(): IrFuncRef | null;
  resolveString?(): ValType;
  /**
   * Resolve the backend's canonical boxed-any carrier for a dynamic value.
   * This must match `IrLowerResolver.resolveDynamic()` so a mutable slot and
   * the function parameter that seeds it have the same Wasm representation.
   */
  resolveDynamic?(): ValType;
  /**
   * (#2955 number-box slice) Capability predicate: does this compile's lane
   * own the `__box_number` / `__unbox_number` host imports (the f64⇄externref
   * boxing pair legacy registers via `addUnionImports`)? The two from-ast
   * boxing arms (`coerceToExpectedExtern` f64→externref, `coerceReturnValue`
   * externref→f64) previously read `nativeStrings?.() === false` as a PROXY
   * for this — a mode read the #2955 grep gate wants out of the front-end.
   * The mode knowledge now lives on the resolver/lower side
   * (`integration.ts`); from-ast only asks "can I box here?" and demotes when
   * the answer is no. The implementation is intentionally `!ctx.nativeStrings`
   * today (byte-inert relocation); widening it (native-strings host compiles,
   * standalone `$AnyValue` boxing) is a semantic follow-up tracked in #2955.
   */
  hasHostNumberBox?(): boolean;
  /**
   * Does this compile's lane own the host `__box_boolean` import? Boolean
   * values use the same i32 carrier as integer-shaped numbers, so this
   * capability is deliberately separate from `hasHostNumberBox`: callers
   * must prove the boolean brand before selecting the boolean boxer.
   */
  hasHostBooleanBox?(): boolean;
  /**
   * (#2955 slice 3) Rep predicate: is `IrType.string`'s carrier ValType
   * externref (the host-strings backend), so a string SSA value can flow
   * unchanged into an externref-expected position (host-call args,
   * `__extern_is_undefined` operands)? The two from-ast string-rep arms
   * (`coerceToExpectedExtern` string→externref pass-through,
   * `tryLowerUndefinedCompare` externref-shaped test) previously read
   * `nativeStrings` directly for this — a mode read the #2955 grep gate
   * wants out of the front-end. The mode knowledge now lives on the
   * resolver/lower side (`integration.ts`); from-ast only asks the rep
   * question and demotes (or takes the native fold path) when the answer
   * is no. The answer MUST stay a build-time answer: the native arm of
   * `coerceToExpectedExtern` is a demote throw (claim/demote decisions
   * have no lower-time channel — same constraint as `stringMethodPlan` /
   * `hasHostNumberBox`). Implementation is intentionally
   * `!ctx.nativeStrings` today (byte-inert relocation); a native string
   * (`(ref $AnyString)`) can NEVER satisfy an externref host-arg position,
   * so unlike the number-box capability there is no widening follow-up on
   * the coercion arm — only the undefined-test's fold could ever move to a
   * true abstract op (tracked in #2955's remaining-slices map).
   */
  stringIsExternref?(): boolean;
  /**
   * (#2955 slice 4) Capability predicate: does this compile's lane own the
   * `number_toString` `(f64) -> externref` host import (pre-registered by
   * the legacy source scan whenever a checker-number `.toString()` appears
   * in source)? The from-ast `<number>.toString()` arm previously read
   * `nativeStrings?.() === false` as a PROXY for this — the import is
   * host-lane-only AND its return is host-mode's string carrier
   * (externref), so the mode read was doing capability duty. Same shape as
   * `hasHostNumberBox`: the answer MUST stay a build-time answer (the
   * native arm is a demote — no lower-time demote channel), the
   * implementation is intentionally `!ctx.nativeStrings` today (byte-inert
   * relocation), and widening (a native number formatter whose return is
   * the `(ref $AnyString)` carrier) is a semantic follow-up tracked in
   * #2955's remaining-slices map, to be validated against the standalone
   * floor.
   */
  hasHostNumberToString?(): boolean;
  /**
   * (#4462) The widening `hasHostNumberToString` deferred: does this lane own a
   * HOST-FREE `Number::toString` whose result is already the IR string carrier?
   * True in the native-string lanes (standalone / WASI / explicit
   * `--nativeStrings`), where #3912 made legacy's own `(n).toString()` native.
   * The provider is resolver-selected (`IR_NUMBER_TO_STRING_NATIVE_FN`), so
   * from-ast never learns which lane it is in. Disjoint from
   * `hasHostNumberToString` by construction — one is `!nativeStrings`, the other
   * `nativeStrings` — so the two arms can never both claim one call.
   */
  nativeNumberToStringAvailable?(): boolean;
  /**
   * Does this lane own a host-free `Number::toFixed` provider whose result is
   * already the IR string carrier? The bounded literal-digits lowering asks
   * this separately from the host import capability so host behavior remains
   * byte-for-byte unchanged.
   */
  nativeNumberToFixedAvailable?(): boolean;
  /**
   * (#4462) Does this lane have the host-free console sink (#3469's
   * `__stdout_append`)? Consulted by the console capability row
   * (`consoleSurfaceCapability`) on BOTH sides of the claim boundary, so a
   * standalone module that never minted the sink defers rather than claiming a
   * call with nothing to lower to.
   */
  standaloneConsoleSinkAvailable?(): boolean;
  /**
   * (#2955 slice 5) Strategy query: how does this mode iterate a
   * `string`-typed for-of iterable? `"char-loop"` = the native fast path
   * (counter loop over `__str_charAt`, slice 6 part 4 — #1183);
   * `"iter-host"` = the host-iterator protocol (`__iterator` import; the
   * host-mode string is already externref-shaped so it feeds the import
   * unchanged). `lowerForOfStatement` previously read `nativeStrings()`
   * directly for this — the LAST functional mode read in from-ast; both
   * loop builders stay here, only the selection is resolver-owned (same
   * shape as `stringMethodPlan`: the selection must be settled at build
   * time since the two strategies build structurally different IR).
   * Resolver-absent default: `iter-host` (preserving the legacy falsy
   * fallthrough). Implementations: integration =
   * `nativeStrings ? "char-loop" : "iter-host"`; the selfhost
   * native-strings build resolver pins `"char-loop"`; linear omits it
   * (iter-host fallthrough, as before).
   */
  stringForOfPlan?(): "char-loop" | "iter-host";
  /**
   * #3787 — mode-selected target and numeric ABI for the exact ambient
   * `String.fromCharCode(...)` static call.
   *
   * The helper is unary in both modes; from-ast preserves the variadic JS
   * surface by invoking it once per argument and concatenating the resulting
   * one-code-unit strings from left to right. Native helpers take i32 after
   * an exact ToUint16 fold; the host import takes f64 and performs ToUint16
   * in JS. `null` keeps resolver-less/unsupported backends on legacy.
   */
  stringFromCharCodePlan?(): {
    readonly funcName: string;
    readonly argumentRep: "i32" | "f64";
  } | null;
  /**
   * #2952 slice 5 — mode-selected runtime symbols for dynamic for-in.
   * Both plans share the same externref/i32 ABI and preserve the #2964
   * snapshot ordering plus per-visit liveness semantics.
   */
  dynamicForInPlan?(): {
    readonly keys: string;
    readonly len: string;
    readonly get: string;
    readonly has: string;
  } | null;
  resolveVec?(valType: ValType): IrVecLowering | null;
  /**
   * #1804 — register-or-recover the vec struct for an element ValType so
   * `lowerArrayLiteral` can type a constructed `vec.new_fixed`'s result SSA
   * value as `{ kind: "ref", typeIdx: vecStructTypeIdx }`.
   */
  resolveVecForElement?(elementValType: ValType): IrVecLowering | null;
  /**
   * Backend value representation for a vec constructed from `elementValType`.
   * WasmGC omits this and keeps the registered `(ref $vec)` default; linear
   * returns `i32`, its canonical arena pointer representation.
   */
  resolveVecValueTypeForElement?(elementValType: ValType): ValType | null;
  /** Backend-specific vec OOB carrier; omission keeps the shared default. */
  resolveVecOutOfBoundsConst?(elementValType: ValType): IrConst | null;
  /** True when the TS expression is a vec carried by a scalar backend value. */
  isVecValueExpression?(expr: ts.Expression): boolean;
  /**
   * Slice 10 (#1169i) — return metadata for the named extern class, or
   * `undefined` if no such class is registered.
   */
  getExternClassInfo?(className: string): IrExternClassMeta | undefined;
  /**
   * #1375 narrow slice — TS-narrowing fast-path for optional chaining.
   * Returns `true` when the TypeScript type of `expr` is provably non-null
   * (i.e. `getNonNullableType(t) === t`). Used by `lowerPropertyAccess`
   * to skip the `?.`-on-nullable-receiver throw when TS has already
   * narrowed away null/undefined — the IR's `isIrTypeNullable` is more
   * conservative (treats `extern` as always nullable), so this gate
   * recovers a small set of well-typed `m?.x` cases where `m: Map<...>`
   * (no `| undefined`) is genuinely non-null at TS level.
   *
   * When unimplemented or returns `undefined`, `lowerPropertyAccess`
   * keeps the existing throw → legacy fallback.
   */
  isExpressionTsNonNullable?(expr: ts.Expression): boolean | undefined;
  /**
   * (#2856) Host-extern support — resolve a bare identifier to an ambient
   * host global registered by the legacy `collectDeclaredGlobals` pass
   * (`document` → `{ importName: "global_document", className: "Document" }`).
   * Returns `undefined` for anything that isn't a registered declared global.
   * In host-free modes (standalone/wasi/strictNoHostImports) the legacy pass
   * registers nothing, so this resolves nothing — the capability gate
   * (`hostExternCapability`) already made the selector defer those functions.
   */
  getHostGlobalInfo?(name: string): { importName: string; className: string } | undefined;
  /**
   * (#2856) True iff this compile targets a JS host. Feeds the
   * `hostExternCapability` invariant assert at the host-extern lowering
   * arms — a host-extern node reaching the builder in a host-free mode is a
   * selector↔capability drift, not a fallback.
   */
  jsHostExterns?(): boolean;
  /**
   * #4576 — exact source-node authorization for the standalone dom@1
   * provider. Absence never falls back to a name/type guess.
   */
  standaloneDomOperation?(node: ts.Node): IrStandaloneDomOperation | undefined;
  /**
   * (#4461) The host-free `Map` carrier. Returns the lane's native `$Map`
   * module-binding storage type (`(ref null $Map)` as an IR `val`) when this
   * compile lowers `Map` to the WasmGC struct (#1103a), and `undefined` on the
   * JS-host lane, where `Map` is an externref extern class instead.
   *
   * This is the SINGLE predicate that decides the native-map lowering arms, so
   * it is also what the selector's `allowNativeMapStorage` option must agree
   * with — one fact, two readers, no independent mode reads.
   *
   * PURE — it never materializes anything. It answers `undefined` until the
   * `$Map` struct actually exists in this module, which is what makes it safe
   * to call from a hot path. Use {@link ensureNativeMapStorageType} at the one
   * site that is genuinely constructing a Map; see that method for why.
   */
  nativeMapStorageType?(): IrType | undefined;
  /**
   * The MATERIALIZING twin of {@link nativeMapStorageType}: registers the
   * `$Map` struct + its runtime helpers if absent, then reports the storage
   * type.
   *
   * The split is load-bearing, not stylistic. #4461 shipped ONE method that
   * always materialized, and both from-ast call sites asked it BEFORE they knew
   * they were looking at a Map — `lowerNewExpression` asked on every `new`, and
   * the module-binding probe on every method receiver. In a native-string or
   * standalone lane that emitted the entire twelve-function `$Map` runtime
   * (`__map_new`, `__map_get`, `__map_set`, `__map_has`, `__map_delete`,
   * `__map_clear`, `__map_size`, the two iterator helpers, `__map_lookup_idx`,
   * `__hash_anyref`, `__same_value_zero`) plus its struct types into every
   * module containing a `new` expression. Measured on a two-class module with
   * no `Map` anywhere: +1,374 bytes, 59 → 71 functions. That is what changed
   * the wasm hash of 508 test262 files, regressed 297 in
   * `language/expressions/class/elements`, and failed the standalone
   * high-water floor.
   *
   * So: a QUERY must not emit. Only call this once the construct is PROVEN to
   * be a `Map`.
   */
  ensureNativeMapStorageType?(): IrType | undefined;
  /**
   * (#4461) True when `undefined`-ness of an externref-shaped value is tested
   * by a NATIVE `__extern_is_undefined` function rather than the `env` host
   * import. Host-free lanes register the predicate as a real Wasm function
   * (`ensureObjectRuntime`); asking for the import there would put a host
   * import into a standalone module.
   */
  externIsUndefinedIsNative?(): boolean;
  /**
   * (#4461) True when `__unbox_number` exists as a NATIVE function on this
   * lane. Complementary to `hasHostNumberBox`: standalone registers the same
   * name/signature through `addUnionImports`'s native-provider arm, so an
   * externref carrying a boxed number can be unboxed without a host import.
   */
  hasNativeNumberUnbox?(): boolean;
  /**
   * (#2856) Console-argument variant selection for `console.<m>(arg)` —
   * returns the import-name suffix (`console_<m>_<variant>`). MUST use the
   * same checker predicates as the legacy `collectConsoleImports` scan so
   * the variant the IR picks is the variant the scan registered.
   */
  consoleArgVariant?(arg: ts.Expression): "number" | "bool" | "string" | "externref";
  /**
   * (#2955 slice 2) The ENTIRE string-prototype-method mode decision for
   * `lowerStringMethodCall`, resolved on the lower-time side (the resolver is
   * owned by integration/lower) so from-ast reads no `nativeStrings` at this
   * site. Given the method name, call-site arg count (user args, receiver
   * excluded), and conservative producer-side receiver encoding, returns:
   *   - `null` — this mode cannot lower the call (native-mode
   *     indexOf/includes/startsWith/endsWith, native-mode omitted optionals
   *     other than `slice(start)`, or no resolver at all) → from-ast returns
   *     null and the function demotes to legacy, exactly as before.
   *   - a plan: `funcName` is the mode's target (`string_<m>` host import vs
   *     `__str_<m>` native helper); `indexArgRep` is the representation of
   *     index-style (f64) user args (`"i32"` ⇒ from-ast inserts
   *     `i32.trunc_sat_f64_s`, the native helper signature); `padOmitted`
   *     picks the omitted-optional strategy (`"host"` = the host-shim
   *     sentinel conventions incl. #1248 slice/substring-end + #2002
   *     NaN-position; `"native-slice-len"` = `slice(start)`'s implicit end =
   *     recv.length, i32-truncated; `"native-substring"` (#3156) = substring's
   *     omitted start/end pad `i32 0` / `i32 0x7fffffff` — both the native and
   *     guarded host helpers clamp end to len;
   *     `"charcode-zero"` (#3156) = charCodeAt's omitted position pads
   *     `i32 0` in BOTH modes, since the guarded helpers take an i32 index).
   *
   * Capability note: demote/claim decisions must be settled at BUILD time
   * (post-claim demotion is the documented residual channel; there is no
   * lower-time demote), which is why this is a resolver callback rather than
   * an abstract-instr lowering case. Promoting the rep half (the trunc
   * insertion) into a true `str.method` instr lowered per mode is the
   * follow-up slice recorded in #2955.
   */
  stringMethodPlan?(
    method: string,
    argCount: number,
    receiverEncoding: Encoding | undefined,
  ): {
    funcName: string;
    indexArgRep: "f64" | "i32";
    padOmitted: "host" | "native-slice-len" | "native-substring" | "charcode-zero" | "search-zero";
    /** Native indexOf returns i32 while JavaScript's numeric carrier is f64. */
    resultRep?: "i32-number";
  } | null;
  /** Non-escaping substring locals are cheaper through legacy's scalar descriptor read. */
  preferLegacyFlatSubstringCharCodeAt?(receiver: ts.Expression): boolean;
  /**
   * (#3931) Backend half of the #2682 canonical char-read-loop hoist. Asked
   * ONCE per recognised loop (`ir/char-read-loop.ts` has already discharged
   * the `0 <= i < recv.length` proof); `null` refuses the optimisation and the
   * loop lowers exactly as before.
   *
   * `hoist` is the native-strings answer: `flattenFuncName` is called ONCE in
   * the loop preheader and its result parked in a string-carrier slot, after
   * which each body read is `readFuncName(flat, i)` — no per-iteration
   * flatten, no bounds/NaN branch. `trustedFuncName` is the host answer: host
   * strings have no flattenable descriptor, so there the win is purely
   * dropping the guard around the `wasm:js-string` builtin.
   *
   * Both names take/produce only STRING-carrier and i32 values — deliberately,
   * so no IR value here is typed with a raw backend `ref` (a prepared
   * component carrying one is refused, which would demote the whole function
   * and silently undo the optimisation).
   *
   * Mode-free by construction on the from-ast side (the #2955 discipline): all
   * the helper names come from here, so a backend with neither answer (linear,
   * Porffor) simply omits the callback.
   */
  charReadPlan?(): {
    hoist: { flattenFuncName: string; readFuncName: string } | null;
    trustedFuncName: string | null;
  } | null;
  /**
   * (#2856) Resolve an extern-class member through the legacy inheritance
   * chain (`ctx.externClasses` + `ctx.externClassParent` — e.g. `appendChild`
   * on an `Element` receiver resolves on `Node`). `node`, when provided, is
   * the use-site AST node (the PropertyAccessExpression or its enclosing
   * CallExpression) — the resolver uses the checker's type AT THE USE SITE to
   * brand an externref-typed result with its extern class name
   * (`resultClassName`), which is what lets chained member access
   * (`document.body.appendChild(...)`, `e.style.cssText = ...`) dispatch.
   * Registration-time result types can't provide this (overloads collapse to
   * the first signature; generic returns have no symbol).
   */
  resolveExternMember?(
    className: string,
    memberName: string,
    kind: "method" | "property",
    node?: ts.Node,
  ):
    | {
        /** The registered import prefix — `${prefix}_${method}` / `${prefix}_get_${prop}`. */
        importPrefix: string;
        /** Method signature (params[0] = receiver externref), when kind = "method". */
        method?: { params: ValType[]; results: ValType[]; requiredParams: number };
        /** Property info, when kind = "property". */
        property?: { type: ValType; readonly: boolean };
        /** Extern class name of the RESULT when it is an externref-shaped host
         *  object (checker-derived at the use site); undefined otherwise. */
        resultClassName?: string;
      }
    | undefined;
  /**
   * (#2856 C2) True when `expr`'s checker type names a TypedArray-family
   * view (Uint8Array, Int16Array, Uint8ClampedArray, …, or a subarray
   * view). Element WRITES on those carry per-view conversion semantics
   * (ToUint8 / ToUint8Clamp / packed-storage truncation — see the legacy
   * `compileElementAssignment` view arms) that the plain vec store helper
   * must not bypass, so `lowerElementStore` demotes them to legacy.
   * Element READS are unaffected (value-identical to plain vec reads).
   */
  isTypedArrayViewExpr?(expr: ts.Expression): boolean;
  /**
   * (#2856 Capability C) Resolve the checker-owned module declaration for
   * this identifier to the exact legacy storage slot. Passing `writeValue`
   * additionally proves that the declaration is mutable and that the RHS
   * preserves its storage representation. Locals/params/imports/unsupported
   * module declarations return undefined.
   */
  resolveModuleBinding?(node: ts.Identifier, writeValue?: ts.Expression): ModuleBindingGlobal | undefined;
  /**
   * #3791 — exact standalone native RegExp `.test` bridge. The receiver is
   * the real legacy module-global carrier; the helper is an in-module defined
   * function with the canonical receiver-first externref ABI.
   */
  standaloneRegExpTestPlan?(
    receiver: ts.Expression,
  ): { readonly receiverGlobal: IrGlobalRef; readonly funcName: string } | null;
  /**
   * #3793 — existing retained function-object module carrier plus its live
   * receiver-preserving closed method dispatcher.
   */
  retainedFunctionMethodPlan?(
    call: ts.CallExpression,
  ): { readonly receiverGlobal: IrGlobalRef; readonly funcName: string } | null;
  /** #4387 — stable fnctor instance inheriting one intrinsic Array prototype. */
  fnctorArrayMethodPlan?(
    call: ts.CallExpression,
  ): { readonly receiverGlobal: IrGlobalRef; readonly funcName: string } | null;
  /** #3791 exact stable module numeric vec at a direct-call boundary. */
  staticNumericArrayRead?(
    expression: ts.Expression,
    expected: IrType,
  ): { readonly globalRef: IrGlobalRef; readonly type: IrType } | null;
  /** True for any checker-owned top-level lexical, including unsupported reps. */
  isDirectModuleBinding?(node: ts.Identifier): boolean;
  /** True when the identifier resolves to an ambient declaration-file symbol. */
  isAmbientBinding?(node: ts.Identifier): boolean;
  /**
   * #3787 checker identity for the global String constructor. JavaScript
   * inputs compiled without lib declarations may leave the identifier
   * unresolved; the production resolver treats that as the global only when
   * no source declaration owns the name.
   */
  isAmbientStringBinding?(node: ts.Identifier): boolean;
  /**
   * True only when `IrType.dynamic` lowers to the raw externref carrier.
   * This permits exact externref runtime boundaries (currently parseInt /
   * parseFloat) to consume a dynamic string result without an invented
   * unbox. Fast AnyValue carriers return false.
   */
  dynamicCarrierIsExternref?(): boolean;
}

export interface AstToIrOptions {
  readonly exported?: boolean;
  /** Authoritative identity for the main artifact and exact feature-plan owner. */
  readonly ownerUnitId: IrUnitId;
  /**
   * #1370 Phase B: explicit name for the lowered function. Required for
   * MethodDeclaration (where `.name` is `PropertyName`, not Identifier)
   * and ConstructorDeclaration (which has no name node at all). For
   * top-level FunctionDeclaration this can be omitted; the caller's
   * `fn.name.text` is used as a fallback.
   */
  readonly funcName?: string;
  /**
   * #1370 Phase B: when set, the lowered function gets an implicit
   * `__self` parameter as its FIRST parameter, and `this` is bound in
   * the body's scope to that parameter's SSA value. Pass when lowering
   * an instance method — the legacy `class-bodies.ts` pre-allocates
   * instance method signatures as `[(ref $structTypeIdx), ...userParams]`
   * (see `class-bodies.ts:301`); the IR-lowered body must mirror that
   * layout exactly so existing legacy callers' `call $methodFuncIdx`
   * ops route to the correct typeIdx.
   *
   * The `IrType` should be `{ kind: "class"; shape }` so `this.field`
   * accesses resolve via `class.get` / `class.set` against the shape's
   * field list.
   *
   * Static methods don't get a `selfParam`; constructor init bodies use the
   * dedicated final-parameter mode below.
   */
  readonly selfParam?: { readonly type: IrType };
  /**
   * #3522 constructor retirement: lower a source constructor as the
   * allocator-independent `<Class>_init` body. User parameters keep their
   * source order and the caller-supplied class receiver is appended as the
   * final parameter, matching the frozen direct ABI
   * `(...ctorParams, self) -> self`. Mutually exclusive with
   * `selfParam`.
   */
  readonly constructorInitClassShape?: IrClassShape;
  /** Ordered own-instance field work executed by this constructor `_init`. */
  readonly constructorFieldInitializers?: readonly IrClassInstanceInitializer[];
  /** Synthesized derived constructor: forward every ABI parameter to this parent. */
  readonly implicitConstructorParentShape?: IrClassShape;
  /**
   * If present, overrides the IR types for the function's own parameters.
   * Indexed by parameter position. Used when the AST lacks explicit TS
   * type annotations and the Phase-2 propagation pass has inferred types.
   */
  readonly paramTypeOverrides?: readonly IrType[];
  /**
   * If present, overrides the IR return type. Same rationale as
   * `paramTypeOverrides`.
   *
   * Slice 14 (#1228) — null = void return (zero Wasm result types). The
   * IrFunctionBuilder is constructed with `[]` results and the lowerer
   * accepts bare `return;` and fall-through tails.
   */
  readonly returnTypeOverride?: IrType | null;
  /**
   * Map from callee function name to that callee's IR types (param +
   * return). Consulted when lowering a CallExpression whose callee is a
   * local function. Missing entries cause the lowerer to throw — the
   * selector's call-graph closure should guarantee every call we reach
   * has an entry.
   *
   * Slice 14 (#1228) — `returnType: IrType | null`. Null means a void
   * callee — calls in expression position (`x = f();`) are spec-illegal
   * for void; calls in statement position (`f();`) are fine.
   */
  readonly calleeTypes?: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType | null }>;
  /** Exact source direct-call plans keyed by the certified AST call node. */
  readonly directCalls?: ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan>;
  /** (#3214) Exact imported-call, function-value, and host-callback AST-site plans. */
  readonly importedCalls?: ReadonlyMap<ts.CallExpression, IrImportedCallLoweringPlan>;
  readonly topLevelFunctionValues?: ReadonlyMap<ts.Identifier, IrTopLevelFunctionValueLoweringPlan>;
  readonly hostVoidCallbacks?: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>;
  readonly hostDateSnapshots?: ReadonlyMap<ts.NewExpression, IrHostDateSnapshotLoweringPlan>;
  readonly hostDateGetters?: ReadonlyMap<ts.CallExpression, IrHostDateGetterLoweringPlan>;
  /** (#2856) Exact Promise-delay construction/timer/resolve node plans. */
  readonly promiseDelays?: IrPromiseDelayLoweringPlans;
  /** Exact source-unit identities for nested executable declarations. */
  readonly identityContext?: IrPlanningIdentityContext;
  /**
   * Slice 4 (#1169d): map from class name to that class's IR shape
   * (fields + methods + constructor signature). Consulted when lowering
   * NewExpression / class-receiver PropertyAccess / class-receiver
   * method calls. Missing entries cause the relevant lowering case to
   * throw, falling back to legacy.
   */
  readonly classShapes?: ReadonlyMap<string, IrClassShape>;
  /**
   * Slice 6 part 4 refactor (#1185): the from-ast view of the IR
   * lowerer's resolver. Replaces the per-feature shortcuts that
   * #1181 / #1182 / #1183 each added (`nativeStrings`,
   * `anyStrTypeIdx`, `inferVecElementValTypeFromContext`).
   *
   * Optional so existing tests / callers that don't need string or
   * vec type resolution can keep working. The `lowerForOfStatement`
   * arms that DO need it (string + vec) throw a clean fall-back-to-
   * legacy error when the resolver is absent or returns `null`.
   *
   * The integration layer (`compileIrPathFunctions`) is the canonical
   * supplier — it builds the resolver (or its subset) eagerly and
   * passes it in.
   */
  readonly resolver?: IrFromAstResolver;
  /** Optional-chain nullability check (#1281). When absent, `?.` / `?.()` throw to legacy. */
  readonly checker?: ts.TypeChecker;
  /**
   * (#4218) The compile's `ctx.oracle` — the backend-selected type oracle.
   * When present it is used for the numeric-fact queries below INSTEAD of
   * wrapping `checker` in an ad-hoc `TsCheckerOracle`, so the
   * `oracleBackend` option/env actually governs these paths.
   */
  readonly oracle?: TypeOracle;
  /**
   * (#3765) Direct-codegen's whole-program proof that an implicit-any local
   * always contains a number. IR consumes the same proof before rejecting an
   * unboxed f64 local: the checker type remains `any` for ordinary JavaScript
   * even when every definition is grounded numeric.
   */
  readonly numericLocalScalarForDecl?: (decl: ts.VariableDeclaration) => "number" | undefined;
  /**
   * #1586: module-global allocation-site registry. When supplied, the builder
   * mints a stable `AllocSiteId` for every value-creating instr (object.new,
   * closure.new, string.const, …). Optional — when absent, `alloc` fields stay
   * unset, which is inert at lowering (byte-identical output).
   */
  readonly allocRegistry?: AllocSiteRegistry;
  /**
   * (#3142 Slice 2) The function being lowered is the synthetic
   * `<module-init>` claim unit (the top-level statement population wrapped
   * by `makeModuleInitSynthetic`). Mirrors the constructor-body precedent:
   * every statement lowers as a plain body statement via `lowerStmt` (no
   * tail requirement) and the builder terminates with an empty `return`.
   * Requires `returnTypeOverride: null` (the unit is void) and a
   * `moduleBindings` map for the top-level declared names.
   */
  readonly moduleInitUnit?: boolean;
  /**
   * (#3142 Slice 2) Module-scope bindings → the Wasm global the legacy
   * backend allocated for each (`__mod_<name>`, plus the `__tdz_<name>`
   * flag when legacy tracks one). A top-level `let`/`const` declaration
   * for a name in this map lowers as a symbolic `global.set` against that
   * SAME storage slot (and binds in scope as a `moduleGlobal`
   * ScopeBinding), so every other function — legacy or IR — observes the
   * initialized value exactly as it does with the legacy `__module_init`
   * body. Capability C admits f64/i32 and branded externref-backed globals;
   * unsupported storage still demotes.
   */
  readonly moduleBindings?: ReadonlyMap<string, ModuleBindingGlobal>;
  /**
   * Host-lane dynamic method names observed while lowering IR. The legacy
   * finalizer uses this shared set to expose ordinary class-member bridges for
   * dynamic receivers; standalone/WASI callers may omit it.
   */
  readonly hostDynamicClassMethodNames?: Set<string>;
}

/**
 * Slice 3 (#1169c): lowering an outer function may produce additional
 * lifted IR functions (one per nested function declaration / closure
 * expression). The integration layer treats these as synthesized
 * BuiltFns that get fresh funcIdx slots.
 */
export interface LoweredFunctionResult {
  readonly main: IrFunction;
  readonly lifted: readonly IrFunction[];
  /** Exact allocation-side provenance for `lifted`, joined by ID rather than array position. */
  readonly liftedUnitProvenance: readonly IrDerivedUnitProvenance[];
}

function isDirectSourceVarStatement(statement: ts.Statement): boolean {
  return (
    ts.isVariableStatement(statement) &&
    (statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
  );
}

/** Direct module `var`s have persistent globals; nested/for-init `var`s still need hoisting support. */
function moduleInitContainsNestedVar(statements: readonly ts.Statement[]): boolean {
  const findVarDecl = (node: ts.Node): boolean => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) {
      return false;
    }
    if (ts.isVariableDeclarationList(node) && (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
      return true;
    }
    return ts.forEachChild(node, findVarDecl) === true;
  };
  return statements.some((statement) => !isDirectSourceVarStatement(statement) && findVarDecl(statement));
}

function lowerConstructorBody(
  builder: IrFunctionBuilder,
  statements: readonly ts.Statement[],
  options: AstToIrOptions,
  thisValue: IrValueId,
  parameterValues: readonly IrValueId[],
  cx: LowerCtx,
  name: string,
): void {
  const fieldInitializers = options.constructorFieldInitializers ?? [];
  const parentShape = options.constructorInitClassShape?.parent;
  if (options.implicitConstructorParentShape) {
    if (options.implicitConstructorParentShape !== parentShape) {
      // invariant (producer-promise): the prepared implicit-ctor plan promised the parent shape — #4502.
      throw new Error(`ir/from-ast: implicit constructor parent shape mismatch (${name})`);
    }
    builder.emitClassSuperInit(options.implicitConstructorParentShape, thisValue, parameterValues);
    lowerConstructorFieldInitializers(fieldInitializers, thisValue, cx);
  } else if (parentShape && fieldInitializers.length > 0) {
    // Selection admits explicit derived constructors only with one leading
    // `super(...)`. Own fields run immediately after it and before the rest
    // of the source constructor body (ECMA-262 InitializeInstanceElements).
    const [first, ...rest] = statements;
    // invariant (producer-promise): selection admits derived ctors only with one leading super(...) — #4502.
    if (!first) throw new Error(`ir/from-ast: derived constructor has no leading super (${name})`);
    lowerStmt(first, cx);
    lowerConstructorFieldInitializers(fieldInitializers, thisValue, cx);
    for (const statement of rest) lowerStmt(statement, cx);
  } else {
    lowerConstructorFieldInitializers(fieldInitializers, thisValue, cx);
    for (const statement of statements) lowerStmt(statement, cx);
  }
  builder.terminate({ kind: "return", values: [thisValue] });
}

export function lowerFunctionAstToIr(
  fn:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    // #3000-B: get/set accessors lower as no-arg / one-arg instance members
    // over the (now-supported) private slot. A getter behaves like a no-param
    // method whose return type is `fn.type`; a setter behaves like a one-param
    // VOID method (setters carry no source-level return type).
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
  options: AstToIrOptions,
): LoweredFunctionResult {
  // #1370 Phase B: name resolution.
  //
  // FunctionDeclaration: prefer `fn.name.text`, fall back to options.funcName.
  // MethodDeclaration: use options.funcName (its `.name` is PropertyName).
  // ConstructorDeclaration: use options.funcName (no `.name` node).
  const astName = ts.isFunctionDeclaration(fn) ? fn.name?.text : undefined;
  const name = options.funcName ?? astName;
  if (!name) {
    demoteToLegacy(
      "body-shape-rejected",
      "ir/from-ast: function declaration without a name (and no options.funcName supplied)",
    );
  }
  if (!fn.body) {
    demoteToLegacy("body-shape-rejected", `ir/from-ast: function ${name} has no body`);
  }

  // #1370 Phase B: ConstructorDeclaration has no `asteriskToken` field,
  // and a method/function may have one. Type-narrow before access.
  const isGenerator = (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && !!fn.asteriskToken;

  // ConstructorDeclaration has no `.type`; the integration walk supplies the
  // exact init shape and the caller-provided receiver is returned implicitly.
  const isCtor = ts.isConstructorDeclaration(fn);
  if (isCtor && (!options.constructorInitClassShape || options.selfParam)) {
    // invariant (producer-promise): the integration walk supplies the exact init shape (comment at the site) — #4502.
    throw new Error(`ir/from-ast: constructor lowering requires the exact init shape (${name})`);
  }

  // Slice 7a (#1169f): `function*` produces a Generator-like externref
  // regardless of the source-level return type annotation
  // (`Generator<number>`, `IterableIterator<T>`, etc.). The IR result
  // type is unconditionally `externref`; the source annotation is
  // ignored at the IR layer.
  //
  // Slice 14 (#1228) — `void` return: `returnTypeOverride === null` AND
  // `fn.type?.kind === VoidKeyword` indicates a void-returning function.
  // The IR builder is constructed with `[]` results; lowerTail accepts
  // bare `return;` / fall-through tails.
  // (#1373b C-1) A C-1-claimed async fn compiles on the legacy SYNC
  // pass-through model: its wasm result is the raw `T` unwrapped from the
  // `Promise<T>` annotation (matching the declaration pre-pass's
  // `unwrapPromiseType`); the #1796 call-site consumption contract owns the
  // Promise wrap for thenable consumers. Async METHODS are out of C-1 scope
  // (the selector never claims them), so the declaration-only check is safe.
  const isAsync =
    !isGenerator &&
    !isCtor &&
    ts.isFunctionDeclaration(fn) &&
    !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
  const declaredReturnTypeNode =
    ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn)
      ? effectiveIrReturnTypeNode(fn)
      : undefined;
  const asyncUnwrappedReturn = isAsync ? unwrapPromiseTypeNode(declaredReturnTypeNode) : null;
  const effectiveReturnTypeNode = isAsync ? (asyncUnwrappedReturn ?? undefined) : declaredReturnTypeNode;
  const isVoidReturn =
    !isGenerator &&
    !isCtor &&
    // #3000-B: a set accessor is inherently void (no source-level return type);
    // treat it as void even if the caller forgot the explicit override.
    (ts.isSetAccessorDeclaration(fn) ||
      options.returnTypeOverride === null ||
      (options.returnTypeOverride === undefined && effectiveReturnTypeNode?.kind === ts.SyntaxKind.VoidKeyword));
  const returnType: IrType | null = isGenerator
    ? irVal({ kind: "externref" })
    : // #3000-C: a constructor returns the constructed instance — `(ref $struct)`.
      isCtor
      ? ({ kind: "class", shape: options.constructorInitClassShape! } as IrType)
      : isVoidReturn
        ? null
        : resolveIrType(effectiveReturnTypeNode, options.returnTypeOverride ?? undefined, `return type of ${name}`);
  // #1372 — binding-pattern params: synthesize a stable internal name
  // (`__pattern_param_<idx>`) so the IR `addParam` machinery has a regular
  // identifier to bind, then emit destructuring reads (object.get / vec.get
  // / class.get) into the function body as a preamble. Identifier params
  // pass through unchanged.
  const params: { name: string; type: IrType }[] = fn.parameters.map((p, idx) => {
    const override = options.paramTypeOverrides?.[idx];
    if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) {
      return {
        name: `__pattern_param_${idx}`,
        type: resolveIrType(effectiveIrParamTypeNode(p), override, `pattern param #${idx} of ${name}`),
      };
    }
    if (!ts.isIdentifier(p.name)) {
      demoteToLegacy("param-shape-rejected", `ir/from-ast: unsupported param shape in Phase 1 (${name})`);
    }
    // #2713 — rest (`...args`), default (`x = 5`) and optional (`x?`) params
    // keep an Identifier name and so slip this gate, after which their
    // arity/defaulting semantics are dropped (a regression against #1372).
    // The top-level selector already rejects them (`select.ts` →
    // param-shape-rejected); mirror that here so nested function declarations
    // lowered through this path demote cleanly to legacy rather than
    // miscompiling. (No-op for top-level claimed functions — the selector has
    // already filtered these out.)
    if (p.questionToken || p.dotDotDotToken || p.initializer) {
      demoteToLegacy(
        "param-shape-rejected",
        `ir/from-ast: rest/default/optional param not in Phase 1 IR scope (${name})`,
      );
    }
    return {
      name: p.name.text,
      type: resolveIrType(effectiveIrParamTypeNode(p), override, `param ${p.name.text} of ${name}`),
    };
  });

  // Slice 14 (#1228) — void functions have zero result types; pass `[]`.
  const builder = new IrFunctionBuilder(
    { unitId: options.ownerUnitId, name },
    returnType === null ? [] : [returnType],
    options.exported ?? false,
    options.allocRegistry,
  );
  const mutatedLets = collectMutatedLetNames(fn);
  const dynamicStringLocals = collectDynamicStringLocalWidening(
    fn,
    new Set(params.filter((param) => param.type.kind === "dynamic").map((param) => param.name)),
  );

  // Single scope map for both params and let/const locals. Phase 1 forbids
  // shadowing (enforced by the selector) so there is no nesting to track.
  const scope = new Map<string, ScopeBinding>();
  // #1370 Phase B: synthetic `__self` for instance methods. Must be added
  // FIRST so its SSA index matches the legacy `local 0` slot the
  // pre-allocated typeIdx expects (see `class-bodies.ts:301`). `this` is
  // bound in scope to this SSA value; subsequent `this.field` /
  // `this.method()` accesses route through the existing class.get /
  // class.set / class.method lowerings (slice 4 #1169d).
  if (options.selfParam) {
    const selfV = builder.addParam("__self", options.selfParam.type);
    scope.set("this", { kind: "local", value: selfV, type: options.selfParam.type });
  }
  // #1372 — track binding-pattern params + their SSA values for the post-
  // openBlock destructure preamble.
  const parameterValues: IrValueId[] = [];
  const pendingDestructures: { pattern: ts.BindingPattern; value: IrValueId }[] = [];
  const pendingMutableParams: { name: string; type: IrType; value: IrValueId }[] = [];
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    const astParam = fn.parameters[i]!;
    const v = builder.addParam(p.name, p.type);
    parameterValues.push(v);
    if (ts.isObjectBindingPattern(astParam.name) || ts.isArrayBindingPattern(astParam.name)) {
      // Don't bind the synthesized __pattern_param_N name in user-visible
      // scope — leaf names will be bound below by lowerBindingPattern.
      pendingDestructures.push({ pattern: astParam.name, value: v });
      continue;
    }
    if (mutatedLets.has(p.name)) {
      pendingMutableParams.push({ name: p.name, type: p.type, value: v });
    } else {
      scope.set(p.name, { kind: "local", value: v, type: p.type });
    }
  }
  let constructorInitSelf: IrValueId | undefined;
  if (options.constructorInitClassShape) {
    const selfType: IrType = { kind: "class", shape: options.constructorInitClassShape };
    constructorInitSelf = builder.addParam("__self", selfType);
    scope.set("this", { kind: "local", value: constructorInitSelf, type: selfType });
  }

  builder.openBlock();

  // Parameters enter the function as SSA values, but a parameter that is
  // reassigned must subsequently read through mutable storage just like a
  // reassigned `let`. Seed one slot from the incoming SSA value before any
  // user-body instruction. Selection admits scalar/string parameters plus
  // dynamic parameters whose concrete assignments can be boxed into the
  // backend's canonical carrier, so every accepted type has an exact slot
  // representation.
  for (const param of pendingMutableParams) {
    const representation = resolveIrSlotRepresentation(param.type, options.resolver, name);
    if (!representation) {
      demoteToLegacy(
        "param-shape-rejected",
        `ir/from-ast: mutable parameter "${param.name}" has no slot representation (${name})`,
      );
    }
    const slotIndex = builder.declareSlot(param.name, representation.storageType);
    builder.emitSlotWrite(slotIndex, param.value);
    scope.set(param.name, {
      kind: "slot",
      slotIndex,
      type: representation.bindingType,
      ...(representation.asType ? { asType: representation.asType } : {}),
    });
  }

  // Slice 7a (#1169f): generator prologue — allocate the `__gen_buffer`
  // Wasm-local slot, initialize it via `__gen_create_buffer()`. Must
  // happen AFTER `openBlock()` (instrs require a current block) and
  // BEFORE user-body lowering so `lowerYield` can emit `gen.push`
  // against the slot. The lowerer reads `func.generatorBufferSlot` to
  // produce the `local.get $__gen_buffer` op.
  let generatorBufferSlot: number | undefined;
  if (isAsync) {
    // (#1373b C-1) Mark the IrFunction async. No prologue is needed — the
    // sync-pass-through model compiles the body as an ordinary synchronous
    // function; `await` lowers per-lane in lower.ts (`case "await"`).
    builder.setFuncKind("async");
  }
  if (isGenerator) {
    // (#3565 contract) The generator prologue below needs the HOST-ONLY import
    // `env.__gen_create_buffer`. In host-free modes (standalone / wasi /
    // strictNoHostImports) that import is deliberately never registered — the
    // legacy path lowers generators to the native `__GenState` state machine
    // instead (see tests/issue-680). Claiming such a function here would emit a
    // reference to an import that does not exist in the module, which the exact
    // import resolver reports as a HARD `unknown-function-ref` invariant at the
    // `lower` stage — where `unsupported` is not expressible. So refuse at BUILD
    // stage, which demotes the function to legacy as designed rather than
    // failing the whole compile.
    if (options.resolver?.jsHostExterns?.() === false) {
      throw new IrUnsupportedError(
        "imported-call-planning-unsupported",
        "build",
        `ir/from-ast: generator ${name} needs host-only env.__gen_create_buffer; host-free targets lower generators via the legacy native state machine`,
      );
    }
    builder.setFuncKind("generator");
    generatorBufferSlot = builder.declareSlot("__gen_buffer", { kind: "externref" });
    builder.setGeneratorBufferSlot(generatorBufferSlot);
    const buf = builder.emitCall(irImportFuncRef("env", "__gen_create_buffer"), [], irVal({ kind: "externref" }));
    if (buf === null) {
      // invariant (producer-promise): a compiler-support helper declared non-void must produce an SSA value — #4502.
      throw new Error(`ir/from-ast: __gen_create_buffer call must produce a value (${name})`);
    }
    builder.emitSlotWrite(generatorBufferSlot, buf);
  }

  const stmts = fn.body.statements;
  // #3000-C: an empty constructor body (`constructor() {}`) is valid — it just
  // allocates + returns `this`. Only non-ctor Phase-1 functions require ≥1
  // statement (their body must produce a return/tail).
  if (!isCtor && stmts.length < 1) {
    demoteToLegacy("body-shape-rejected", `ir/from-ast: Phase 1 expects at least 1 statement in ${name}`);
  }

  const lifted: IrFunction[] = [];
  const liftedUnitProvenance: IrDerivedUnitProvenance[] = [];
  const liftedCounter = { value: 0 };
  const ownedStringAppendSymbols = collectOwnedStringAppendSymbols(fn.body, options.checker);
  const i32PureNames = computeI32PureNames(fn);
  const { i32Slots, emptyArrayInference } = planI32ArrayElements(
    fn,
    mutatedLets,
    isGenerator,
    options.oracle ?? (options.checker ? new TsCheckerOracle(options.checker) : undefined),
  );
  const cx: LowerCtx = {
    builder,
    scope,
    funcName: name,
    ownerUnitId: options.ownerUnitId,
    returnType,
    calleeTypes: options.calleeTypes,
    directCalls: options.directCalls,
    importedCalls: options.importedCalls,
    topLevelFunctionValues: options.topLevelFunctionValues,
    hostVoidCallbacks: options.hostVoidCallbacks,
    hostDateSnapshots: options.hostDateSnapshots,
    hostDateGetters: options.hostDateGetters,
    promiseDelays: options.promiseDelays,
    identityContext: options.identityContext,
    classShapes: options.classShapes,
    resolver: options.resolver,
    lifted,
    liftedUnitProvenance,
    liftedCounter,
    mutatedLets,
    dynamicStringLocals,
    i32PureNames,
    i32Slots,
    ownedStringAppendSymbols,
    emptyArrayInference,
    // (#2972) statically-known literal string lengths — proven-in-bounds
    // string element reads (`hex[(n >> 4) & 0xf]`) consult this.
    stringLiteralLens: collectStringLiteralLens(fn),
    funcKind: isGenerator ? "generator" : isAsync ? "async" : "regular",
    generatorBufferSlot,
    checker: options.checker,
    oracle: options.oracle,
    // #4177 — outer function only; lifted-closure contexts deliberately omit
    // it (see the LowerCtx field doc).
    latticeParamFacts: collectLatticeParamFacts(fn, params),
    numericLocalScalarForDecl: options.numericLocalScalarForDecl,
    allocRegistry: options.allocRegistry,
    moduleBindings: options.moduleInitUnit ? options.moduleBindings : undefined,
    hostDynamicClassMethodNames: options.hostDynamicClassMethodNames,
  };
  // #1372 — emit destructuring preamble for binding-pattern params. Each
  // leaf becomes a `local` ScopeBinding via `lowerBindingPattern`; the
  // user-body code then sees the leaf identifiers as regular locals.
  // Emitted AFTER cx is built (lowerObjectPattern/lowerArrayPattern need
  // `cx.scope`/`cx.builder`) but BEFORE `lowerStatementList(stmts, cx)`
  // so the body sees the leaves in scope from statement #0.
  for (const { pattern, value } of pendingDestructures) {
    lowerBindingPattern(pattern, value, cx);
  }

  // (#3142 Slice 2) `<module-init>` unit — constructor-body precedent: every
  // population statement is a plain body statement (`lowerStmt`, the same
  // dispatcher the selector's `isPhase1BodyStatement` mirrors), no tail
  // requirement, implicit empty return. Top-level declarations bind through
  // `cx.moduleBindings` (see `lowerVarDecl`) so the legacy `__mod_<name>`
  // globals receive the initialized values.
  if (options.moduleInitUnit) {
    if (returnType !== null) {
      demoteToLegacy("module-init-legacy-coupling", `ir/from-ast: module-init unit must be void (${name})`);
    }
    if (moduleInitContainsNestedVar(stmts)) {
      demoteToLegacy(
        "module-init-legacy-coupling",
        `ir/from-ast: module-init unit contains a nested var declaration (${name})`,
      );
    }
    for (const s of stmts) {
      lowerStmt(s, cx);
      // A top-level break/continue can't appear (no enclosing loop — the
      // selector rejects it), so no dead-code guard is needed.
    }
    builder.terminate({ kind: "return", values: [] });
    return { main: builder.finish(), lifted, liftedUnitProvenance };
  }

  if (isCtor) {
    // The AST-free `_new` wrapper allocates; this source-owned `_init` receives
    // the exact instance as its final parameter and owns all source writes.
    lowerConstructorBody(builder, stmts, options, constructorInitSelf!, parameterValues, cx, name);
    return { main: builder.finish(), lifted, liftedUnitProvenance };
  }

  lowerStatementList(stmts, cx);

  return { main: builder.finish(), lifted, liftedUnitProvenance };
}

/** Lower an implicit constructor through the same constructor IR pipeline. */
export function lowerImplicitConstructorAstToIr(
  declaration: ts.ClassDeclaration | ts.ClassExpression,
  options: AstToIrOptions & { readonly constructorInitClassShape: IrClassShape },
): LoweredFunctionResult {
  const parameters = options.constructorInitClassShape.constructorParams.map((_type, index) =>
    ts.factory.createParameterDeclaration(undefined, undefined, `__arg${index}`, undefined, undefined, undefined),
  );
  const synthetic = ts.factory.createConstructorDeclaration(undefined, parameters, ts.factory.createBlock([]));
  return lowerFunctionAstToIr(synthetic, options);
}

/**
 * Does `stmt` unconditionally terminate its control flow (return / throw, or a
 * block / if-else whose every path does)? Used by the mid-body `if (cond)
 * <then>; <rest>` rewrite: the "early-return" structural reinterpretation
 * (`if (cond) <then> else { <rest> }`) is only sound when the then-arm
 * terminates — otherwise `<rest>` must still run after a true-branch
 * side effect. (#1979)
 */
function thenArmTerminates(stmt: ts.Statement): boolean {
  if (ts.isReturnStatement(stmt) || ts.isThrowStatement(stmt)) {
    return true;
  }
  if (ts.isBlock(stmt)) {
    const last = stmt.statements[stmt.statements.length - 1];
    return last !== undefined && thenArmTerminates(last);
  }
  if (ts.isIfStatement(stmt)) {
    // An `if` terminates only when it has an else and BOTH arms terminate.
    return (
      stmt.elseStatement !== undefined && thenArmTerminates(stmt.thenStatement) && thenArmTerminates(stmt.elseStatement)
    );
  }
  return false;
}

interface DenseArrayReductionPlan {
  readonly accumulatorDeclaration: ts.VariableStatement;
  readonly fillLoop: ts.ForStatement;
  readonly fillValue: ts.Expression;
  readonly accumulatorName: string;
  readonly returnStatement: ts.ReturnStatement;
}

function referencesIdentifier(expr: ts.Expression, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  visit(expr);
  return found;
}

/**
 * Eliminate a local dense array that is filled and then consumed exactly once
 * by an i32 sum reduction. The array never escapes and both loops are pure, so
 * accumulating the generated value in the fill loop preserves iteration order
 * while avoiding a large, immediately-dead WasmGC allocation.
 */
function denseArrayReductionPlan(stmts: readonly ts.Statement[]): DenseArrayReductionPlan | null {
  if (stmts.length !== 5) return null;
  const [arrayStatement, fillStatement, accumulatorStatement, reductionStatement, returnStatement] = stmts;
  if (
    !arrayStatement ||
    !fillStatement ||
    !accumulatorStatement ||
    !reductionStatement ||
    !returnStatement ||
    !ts.isVariableStatement(arrayStatement) ||
    !ts.isForStatement(fillStatement) ||
    !ts.isVariableStatement(accumulatorStatement) ||
    !ts.isForStatement(reductionStatement) ||
    !ts.isReturnStatement(returnStatement)
  ) {
    return null;
  }

  const arrayDeclaration = arrayStatement.declarationList.declarations[0];
  if (
    arrayStatement.declarationList.declarations.length !== 1 ||
    !arrayDeclaration ||
    !arrayDeclaration.initializer ||
    !ts.isArrayLiteralExpression(arrayDeclaration.initializer)
  ) {
    return null;
  }
  const fillPlan = denseFillPlanForLiteral(arrayDeclaration.initializer);
  if (!fillPlan || fillPlan.loop !== fillStatement) return null;
  const fillBody = ts.isBlock(fillStatement.statement)
    ? fillStatement.statement.statements[0]
    : fillStatement.statement;
  if (!fillBody || !ts.isExpressionStatement(fillBody) || !ts.isBinaryExpression(fillBody.expression)) return null;
  const fillValue = fillBody.expression.right;
  if (!isNestedBitwiseResult(fillValue)) return null;

  const accumulatorDeclaration = accumulatorStatement.declarationList.declarations[0];
  if (
    accumulatorStatement.declarationList.declarations.length !== 1 ||
    !accumulatorDeclaration ||
    !ts.isIdentifier(accumulatorDeclaration.name) ||
    !accumulatorDeclaration.initializer ||
    !ts.isNumericLiteral(accumulatorDeclaration.initializer) ||
    Number(accumulatorDeclaration.initializer.text) !== 0
  ) {
    return null;
  }
  const accumulatorName = accumulatorDeclaration.name.text;
  if (referencesIdentifier(fillValue, accumulatorName)) return null;

  const reductionInit = reductionStatement.initializer;
  if (
    !reductionInit ||
    !ts.isVariableDeclarationList(reductionInit) ||
    reductionInit.declarations.length !== 1 ||
    !reductionInit.declarations[0]?.initializer ||
    !ts.isIdentifier(reductionInit.declarations[0].name) ||
    !ts.isNumericLiteral(reductionInit.declarations[0].initializer) ||
    Number(reductionInit.declarations[0].initializer.text) !== 0
  ) {
    return null;
  }
  const reductionIndex = reductionInit.declarations[0].name.text;
  const reductionCondition = reductionStatement.condition;
  const reductionIncrement = reductionStatement.incrementor;
  if (
    !reductionCondition ||
    !ts.isBinaryExpression(reductionCondition) ||
    reductionCondition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    !ts.isIdentifier(reductionCondition.left) ||
    reductionCondition.left.text !== reductionIndex ||
    !ts.isPropertyAccessExpression(reductionCondition.right) ||
    !ts.isIdentifier(reductionCondition.right.expression) ||
    reductionCondition.right.expression.text !== fillPlan.arrayName ||
    reductionCondition.right.name.text !== "length" ||
    !reductionIncrement ||
    (!ts.isPrefixUnaryExpression(reductionIncrement) && !ts.isPostfixUnaryExpression(reductionIncrement)) ||
    reductionIncrement.operator !== ts.SyntaxKind.PlusPlusToken ||
    !ts.isIdentifier(reductionIncrement.operand) ||
    reductionIncrement.operand.text !== reductionIndex
  ) {
    return null;
  }

  const reductionBody = ts.isBlock(reductionStatement.statement)
    ? reductionStatement.statement.statements[0]
    : reductionStatement.statement;
  if (!reductionBody || !ts.isExpressionStatement(reductionBody) || !ts.isBinaryExpression(reductionBody.expression)) {
    return null;
  }
  const assignment = reductionBody.expression;
  const reduced = peelExpr(assignment.right);
  if (
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isIdentifier(assignment.left) ||
    assignment.left.text !== accumulatorName ||
    !ts.isBinaryExpression(reduced) ||
    reduced.operatorToken.kind !== ts.SyntaxKind.BarToken ||
    i32LiteralValue(reduced.right) !== 0
  ) {
    return null;
  }
  const addition = peelExpr(reduced.left);
  if (
    !ts.isBinaryExpression(addition) ||
    addition.operatorToken.kind !== ts.SyntaxKind.PlusToken ||
    !ts.isIdentifier(addition.left) ||
    addition.left.text !== accumulatorName ||
    !ts.isElementAccessExpression(addition.right) ||
    !ts.isIdentifier(addition.right.expression) ||
    addition.right.expression.text !== fillPlan.arrayName ||
    !ts.isIdentifier(addition.right.argumentExpression) ||
    addition.right.argumentExpression.text !== reductionIndex
  ) {
    return null;
  }

  const returned = returnStatement.expression ? peelExpr(returnStatement.expression) : null;
  const returnIsAccumulator =
    returned !== null &&
    (ts.isIdentifier(returned)
      ? returned.text === accumulatorName
      : ts.isBinaryExpression(returned) &&
        returned.operatorToken.kind === ts.SyntaxKind.BarToken &&
        ts.isIdentifier(returned.left) &&
        returned.left.text === accumulatorName &&
        i32LiteralValue(returned.right) === 0);
  if (!returnIsAccumulator) return null;

  return {
    accumulatorDeclaration: accumulatorStatement,
    fillLoop: fillStatement,
    fillValue,
    accumulatorName,
    returnStatement,
  };
}

function lowerStatementList(stmts: readonly ts.Statement[], cx: LowerCtx): void {
  if (stmts.length < 1) {
    demoteToLegacy("body-shape-rejected", `ir/from-ast: empty statement list in ${cx.funcName}`);
  }
  const denseReduction = denseArrayReductionPlan(stmts);
  if (denseReduction) {
    lowerVarDecl(denseReduction.accumulatorDeclaration, cx);
    lowerForStatement(denseReduction.fillLoop, cx, (bodyCx) => {
      const accumulator = bodyCx.scope.get(denseReduction.accumulatorName);
      if (!accumulator || accumulator.kind !== "slot") {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: fused dense reduction accumulator must use slot storage (${cx.funcName})`,
        );
      }
      const value = lowerAsI32(denseReduction.fillValue, bodyCx, "wrap");
      const accumulatorRead = bodyCx.builder.emitSlotRead(accumulator.slotIndex);
      const accumulatorI32 =
        accumulator.i32Storage === true
          ? accumulatorRead
          : bodyCx.builder.emitUnary("i32.trunc_sat_f64_s", accumulatorRead, IR_I32);
      const sum = bodyCx.builder.emitBinary("i32.add", accumulatorI32, value, IR_I32);
      bodyCx.builder.emitSlotWrite(
        accumulator.slotIndex,
        accumulator.i32Storage === true ? sum : bodyCx.builder.emitUnary("f64.convert_i32_s", sum, IR_F64),
      );
    });
    lowerTail(denseReduction.returnStatement, cx);
    return;
  }
  for (let i = 0; i < stmts.length - 1; i++) {
    const s = stmts[i]!;
    if (ts.isVariableStatement(s)) {
      lowerVarDecl(s, cx);
      continue;
    }
    // Slice 3 (#1169c): nested function declaration. Adds a
    // `nestedFunc` scope binding and lifts the body to a top-level IR
    // function in `cx.lifted`.
    if (ts.isFunctionDeclaration(s)) {
      lowerNestedFunctionDeclaration(s, cx);
      continue;
    }
    if (ts.isClassDeclaration(s) && s.name && cx.classShapes?.has(s.name.text)) {
      // The bounded nested-class selector proved ClassDefinitionEvaluation is
      // effect-free and Program ABI preparation already installed every body.
      // No runtime instruction is required; retain the lexical name only in
      // the selector's class-shape registry.
      continue;
    }
    // Slice 3 (#1169c): bare call expression statement — lower the
    // call, drop the result. Lets `inc(); inc(); inc();` work.
    //
    // Slice 4 (#1169d): also accept `<obj>.<field> = <expr>;` — lowered
    // as `class.set` or `object.set` based on the receiver's IrType.
    if (ts.isExpressionStatement(s)) {
      if (ts.isCallExpression(s.expression)) {
        // (#2856) Method-shaped statement calls go through lowerMethodCall
        // in STATEMENT position so void extern/console methods are legal
        // (`host.appendChild(box);`, `console.log("…");`). Expression
        // position keeps throwing on void — only this flag differs.
        if (ts.isPropertyAccessExpression(s.expression.expression) && !s.expression.questionDotToken) {
          void lowerMethodCall(s.expression, cx, /* statementPosition */ true);
          continue;
        }
        // The result SSA value is unused; DCE strips it if pure.
        // closure.call and call are flagged side-effecting in dead-code
        // so they stay live. (#2856 C4) Statement position — a VOID direct
        // call (`quicksort(arr, lo, p - 1);`) is legal here.
        void lowerCall(s.expression, cx, /* statementPosition */ true);
        continue;
      }
      // Slice 7a (#1169f): `yield <expr>;` as a top-level statement.
      // Selected only inside `function*` (the selector enforces this
      // at the function-claim level; if a non-generator function
      // somehow surfaces a yield here, `lowerYield` throws).
      if (ts.isYieldExpression(s.expression)) {
        lowerYield(s.expression, cx);
        continue;
      }
      if (
        ts.isBinaryExpression(s.expression) &&
        s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(s.expression.left)
      ) {
        lowerIdentifierAssignment(s.expression.left, s.expression.right, cx);
        continue;
      }
      if (
        ts.isBinaryExpression(s.expression) &&
        s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(s.expression.left)
      ) {
        lowerPropertyAssignment(s.expression, cx);
        continue;
      }
      // (#2856 C2) element store `arr[i] = v;` as a non-tail statement —
      // quicksort's post-partition swap writes live here (outside any loop).
      if (
        ts.isBinaryExpression(s.expression) &&
        s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isElementAccessExpression(s.expression.left)
      ) {
        lowerElementStore(s.expression.left, s.expression.right, cx);
        continue;
      }
      // #3787 / #2856 — a body-level compound assignment followed by a
      // return has the same slot semantics as the already-supported form
      // inside loop/body buffers. Reuse the shared lowering instead of
      // requiring the assignment to be nested in a block-owning statement.
      if (
        ts.isBinaryExpression(s.expression) &&
        (s.expression.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ||
          s.expression.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken ||
          s.expression.operatorToken.kind === ts.SyntaxKind.AsteriskEqualsToken ||
          s.expression.operatorToken.kind === ts.SyntaxKind.SlashEqualsToken) &&
        ts.isIdentifier(s.expression.left)
      ) {
        lowerCompoundAssignment(s.expression.left, s.expression.operatorToken.kind, s.expression.right, cx);
        continue;
      }
      // (#4459) Value-discarding statement — `x + 1;`, `x;`, `1;`,
      // `cond ? a : b;`. The expression evaluates for its effects and its
      // SSA result is simply never consumed (a discarded ternary becomes an
      // `if.stmt`, so only the taken arm evaluates). The selector's
      // `isPhase1DiscardedExpr` admits exactly this set. Every MUTATING
      // shape has a dedicated arm above and is refused by that selector arm,
      // so one reaching here is a real selector↔builder divergence and must
      // still surface as an unsupported shape rather than being lowered as
      // an ordinary value.
      if (!expressionStatementMutatesAtTopLevel(s.expression)) {
        lowerDiscardedExpression(s.expression, cx);
        continue;
      }
      demoteToLegacy("body-shape-rejected", `ir/from-ast: unsupported ExpressionStatement shape in ${cx.funcName}`);
    }
    if (ts.isWithStatement(s)) {
      lowerWithStatement(s, cx);
      continue;
    }
    // Slice 6 part 2 (#1181): for-of statement (always non-tail). The
    // body is shape-checked by `isPhase1ForOf` and lowered via a
    // separate `lowerStmt` body-statement dispatcher (no nested
    // closures, no nested function decls).
    if (ts.isForOfStatement(s)) {
      lowerForOfStatement(s, cx);
      continue;
    }
    if (ts.isForInStatement(s)) {
      lowerForInStatement(s, cx);
      continue;
    }
    // Slice 12 (#1280): generic structured `while (cond) body` and
    // `for (init; cond; update) body` loops. Both lower to a
    // declarative `{while,for}.loop` IR instr which the lowerer
    // emits as `block { loop { <cond>; i32.eqz; br_if 1; <body>;
    // <update?>; br 0 } }`.
    if (ts.isWhileStatement(s)) {
      lowerWhileStatement(s, cx);
      continue;
    }
    if (ts.isForStatement(s)) {
      lowerForStatement(s, cx);
      continue;
    }
    // #2952 slice 1: `do { body } while (cond)` (post-test loop).
    if (ts.isDoStatement(s)) {
      lowerDoStatement(s, cx);
      continue;
    }
    // #2952 slice 3: `lbl: <loop>` as a non-tail statement.
    if (ts.isLabeledStatement(s)) {
      lowerLabeledStatement(s, cx);
      continue;
    }
    // #2952 slice 4: `switch (...)` as a non-tail statement.
    if (ts.isSwitchStatement(s)) {
      lowerSwitchStatement(s, cx);
      continue;
    }
    // Slice 9 (#1169h): throw / try as a non-tail statement.
    if (ts.isThrowStatement(s)) {
      lowerThrowStatement(s, cx);
      continue;
    }
    if (ts.isTryStatement(s)) {
      lowerTryStatement(s, cx);
      continue;
    }
    // (#2856 calendar residual) A non-tail `if/else` whose arms are plain
    // body statements is a converging statement, not a tail CFG split. Reuse
    // the existing structured `if.stmt` lowering, then continue with the
    // trailing statements. The selector admits exactly the body shapes this
    // helper can lower, so returns that would need CFG termination stay on the
    // legacy path.
    if (ts.isIfStatement(s) && s.elseStatement) {
      lowerIfBodyStatement(s, cx);
      continue;
    }
    // Phase 2: early-return `if` with no else + subsequent statements.
    // Structurally: `if (cond) <tail>; <rest>` ≡ `if (cond) <tail> else { <rest> }`.
    // The then-arm lowers to its own block that terminates in `return`
    // (lowerTail enforces that); the else-arm opens a reserved block and
    // recursively lowers the remaining statements.
    if (ts.isIfStatement(s) && !s.elseStatement) {
      // Whether the then-arm unconditionally terminates decides the shape:
      // a terminating then-arm permits the early-return rewrite
      // (`if (cond) <tail> else { <rest> }`); a non-terminating one is just a
      // side-effecting guard and `<rest>` must run afterwards either way. (#1979)
      const terminates = thenArmTerminates(s.thenStatement);

      // #1043: compile-time constant fold. After --define substitution of
      // process.env.NODE_ENV (etc.), the condition may be a literal-vs-literal
      // comparison. Skip the dead arm so dev-only code never reaches codegen.
      const constResult = evaluateConstantCondition(s.expression);
      if (constResult !== undefined) {
        if (constResult) {
          if (terminates) {
            // Then-arm taken and terminating: the rest is unreachable, stop.
            lowerTail(s.thenStatement, { ...cx, scope: new Map(cx.scope) });
            return;
          }
          // Then-arm taken but non-terminating: run its side effects, then
          // fall through to the rest in the same block / scope.
          const takenCx: LowerCtx = { ...cx, scope: new Map(cx.scope) };
          lowerStmt(s.thenStatement, takenCx);
          joinScopeStringEncodingFacts(cx.scope, [takenCx.scope]);
          continue;
        }
        // Then-arm dead: skip it and continue with the remaining statements
        // in the same block / scope.
        continue;
      }

      // A non-terminating guard is already representable by the structured
      // statement-if used inside loop/body buffers. Keep it in the current
      // statement list so the condition is evaluated exactly once and the
      // trailing statements are emitted once, rather than building a CFG
      // continuation that the Wasm structurizer must duplicate into both
      // arms.
      if (!terminates) {
        lowerIfBodyStatement(s, cx);
        continue;
      }

      const rawCond = lowerExpr(s.expression, cx, irVal({ kind: "i32" }));
      // The move-only selector already admits dynamic conditions and the
      // structured-if path below uses this same canonical ToBoolean bridge.
      // Apply it before the early-return CFG split as well.
      const cond = coerceLoopCondToBool(rawCond, s.expression, cx, "if");
      const rest = stmts.slice(i + 1);

      // Early-return rewrite: `if (cond) <tail> else { <rest> }`.
      const thenId = cx.builder.reserveBlockId();
      const elseId = cx.builder.reserveBlockId();
      cx.builder.terminate({
        kind: "br_if",
        condition: cond,
        ifTrue: { target: thenId, args: [] },
        ifFalse: { target: elseId, args: [] },
      });

      cx.builder.openReservedBlock(thenId);
      lowerTail(s.thenStatement, { ...cx, scope: new Map(cx.scope) });

      cx.builder.openReservedBlock(elseId);
      lowerStatementList(rest, { ...cx, scope: new Map(cx.scope) });
      return;
    }
    demoteToLegacy(
      "body-shape-rejected",
      `ir/from-ast: unexpected statement before tail (got ${ts.SyntaxKind[s.kind]} in ${cx.funcName})`,
    );
  }
  lowerTail(stmts[stmts.length - 1]!, cx);
}

/**
 * Lower an expression whose value is discarded while preserving its effects.
 * Calls need an explicit statement-position bit because a void callee has no
 * SSA result. Routing `return voidCall()` through ordinary expression lowering
 * incorrectly treated that absence as a value-use error; the same bug affected
 * early returns nested in loop/body buffers.
 */
function lowerDiscardedExpression(expr: ts.Expression, cx: LowerCtx): void {
  if (ts.isParenthesizedExpression(expr)) {
    lowerDiscardedExpression(expr.expression, cx);
    return;
  }
  if (ts.isVoidExpression(expr)) {
    lowerDiscardedExpression(expr.expression, cx);
    return;
  }
  if (ts.isConditionalExpression(expr)) {
    const rawCond = lowerExpr(expr.condition, cx, irVal({ kind: "i32" }));
    // (#4512) §7.1.2 ToBoolean — see lowerConditional. Host externref → demote.
    const cond = lowerToBooleanForCondition(rawCond, expr.condition, cx);
    if (cond === null) {
      demoteToLegacy(
        "operand-coercion-unsupported",
        `ir/from-ast: discarded ternary condition must be bool in ${cx.funcName}`,
      );
    }

    const branchScope = new Map(cx.scope);
    const thenCx: LowerCtx = { ...cx, scope: new Map(branchScope) };
    const thenBody = cx.builder.collectBodyInstrs(() => {
      lowerDiscardedExpression(expr.whenTrue, thenCx);
    });
    const elseCx: LowerCtx = { ...cx, scope: new Map(branchScope) };
    const elseBody = cx.builder.collectBodyInstrs(() => {
      lowerDiscardedExpression(expr.whenFalse, elseCx);
    });
    cx.builder.emitIfStmt({ cond, then: thenBody, else: elseBody });
    joinScopeStringEncodingFacts(cx.scope, [thenCx.scope, elseCx.scope]);
    return;
  }
  if (ts.isCommaListExpression(expr)) {
    for (const element of expr.elements) lowerDiscardedExpression(element, cx);
    return;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    lowerDiscardedExpression(expr.left, cx);
    lowerDiscardedExpression(expr.right, cx);
    return;
  }
  if (ts.isCallExpression(expr)) {
    const hostDateGetter = lowerHostDateGetterCall(expr, cx);
    if (hostDateGetter !== undefined) return;
    if (ts.isPropertyAccessExpression(expr.expression) && !expr.questionDotToken) {
      void lowerMethodCall(expr, cx, /* statementPosition */ true);
      return;
    }
    if (ts.isIdentifier(expr.expression) || expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
      void lowerCall(expr, cx, /* statementPosition */ true);
      return;
    }
  }
  void lowerExpr(expr, cx, irVal({ kind: "externref" }));
}

/**
 * Lower a "tail" statement — one that must end in a return on every path.
 * Phase 1 tails are: `return <expr>;`, a `Block { ... }` whose own tail is a
 * tail, or `if (<cond>) <tail> else <tail>`.
 */
function lowerTail(stmt: ts.Statement, cx: LowerCtx): void {
  if (ts.isReturnStatement(stmt)) {
    // Slice 7a/7b (#1169f): generator return. Match the legacy semantics
    // (`compileReturnStatement` in `codegen/statements/control-flow.ts`
    // line 89-123): a `return <value>` inside a `function*` pushes
    // `<value>` onto the eager buffer as a final yielded value, then
    // wraps the buffer with `__create_generator` to produce the
    // externref Generator object. This is non-spec — JS spec says the
    // return value lands in `IteratorResult.value` with `done:true` —
    // but matching legacy is the correctness target so existing
    // test262 coverage doesn't drift.
    //
    // Slice 7b widens the return type: we accept any Phase-1 expression
    // and route it through the same `lowerYield`-style dispatch
    // (f64/i32 stay native; ref/string/object/class coerce to
    // externref → __gen_push_ref). Same dispatch logic as `lowerYield`
    // except we get a `ts.Expression` already, not a YieldExpression.
    if (cx.funcKind === "generator") {
      // #2951: a generator's `return <value>` value belongs ONLY to the
      // terminal `{value, done:true}` IteratorResult — it must NOT be pushed
      // into the eager yield buffer (where spread / for-of / Array.from would
      // surface it as a yielded `done:false` element). The legacy return path
      // (`compileReturnStatement` in `codegen/statements/control-flow.ts:144`)
      // routes the value through `__gen_set_return`, which stashes it on the
      // buffer as a side property for the host drain to emit once with
      // `done:true`. We now mirror that here via `gen.setReturn`: lower the
      // value through the SAME dispatch `lowerYield` uses (f64 / i32 stay
      // native; reference-shaped values coerce to externref), then emit
      // `gen.setReturn` — the lowerer BOXES the value to externref (f64 →
      // `__box_number`, and if the box helper is unresolvable it THROWS to
      // defer to legacy). Finally the epilogue wraps the buffer with
      // `__create_generator`. Bare `return;` (no value) has nothing to stash
      // and skips straight to the epilogue.
      if (stmt.expression) {
        // Same advisory-externref hint + `typeOf`-driven dispatch as
        // `lowerYield`: numeric / bool returns keep their native f64 / i32
        // representation (the `gen.setReturn` lowerer boxes them); every
        // reference-shaped value is coerced to externref upstream so the
        // lowerer's `externref → pass-through` arm sees the right Wasm type.
        const value = lowerExpr(stmt.expression, cx, irVal({ kind: "externref" }));
        const valTy = asVal(cx.builder.typeOf(value));
        if (valTy?.kind === "f64" || valTy?.kind === "i32") {
          cx.builder.emitGenSetReturn(value);
        } else {
          cx.builder.emitGenSetReturn(coerceIrValueToExternref(cx.builder, value));
        }
      }
      const generatorObj = cx.builder.emitGenEpilogue();
      cx.builder.terminate({ kind: "return", values: [generatorObj] });
      return;
    }
    // Slice 14 (#1228): void function — bare `return;` or `return expr;`
    // (the value is discarded). Terminate with empty values.
    if (cx.returnType === null) {
      if (stmt.expression) {
        lowerDiscardedExpression(stmt.expression, cx);
      }
      cx.builder.terminate({ kind: "return", values: [] });
      return;
    }
    if (!stmt.expression) {
      demoteToLegacy("body-shape-rejected", `ir/from-ast: Phase 1 return must have an expression in ${cx.funcName}`);
    }
    const v = lowerExpr(stmt.expression, cx, cx.returnType);
    const vCoerced = coerceReturnValue(v, cx, stmt.expression);
    cx.builder.terminate({ kind: "return", values: [vCoerced] });
    return;
  }
  // Slice 14 (#1228) — void function tail: any non-return statement that
  // doesn't terminate the function falls through to an implicit return.
  // We accept ExpressionStatement (e.g., `f();`) as a tail in void
  // functions and synthesize the implicit return.
  if (cx.returnType === null && ts.isExpressionStatement(stmt)) {
    if (ts.isCallExpression(stmt.expression)) {
      lowerDiscardedExpression(stmt.expression, cx);
      cx.builder.terminate({ kind: "return", values: [] });
      return;
    }
    if (
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(stmt.expression.left)
    ) {
      lowerIdentifierAssignment(stmt.expression.left, stmt.expression.right, cx);
      cx.builder.terminate({ kind: "return", values: [] });
      return;
    }
    // #3000-B: property-store assignment as a void tail — the SET accessor
    // body shape `set name(v) { this.#name = v; }`. Route through the SAME
    // `lowerPropertyAssignment` the non-tail statement path uses (see
    // `lowerStatementList`), so a setter's lone assignment produces bytes
    // identical to the mid-body case, then synthesize the implicit return.
    if (
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(stmt.expression.left)
    ) {
      lowerPropertyAssignment(stmt.expression, cx);
      cx.builder.terminate({ kind: "return", values: [] });
      return;
    }
    // #3000-B: element-store assignment as a void tail (`arr[i] = v;` as the
    // final statement of a void function) — mirror the non-tail element-store
    // arm for select↔build parity.
    if (
      ts.isBinaryExpression(stmt.expression) &&
      stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(stmt.expression.left)
    ) {
      lowerElementStore(stmt.expression.left, stmt.expression.right, cx);
      cx.builder.terminate({ kind: "return", values: [] });
      return;
    }
    lowerDiscardedExpression(stmt.expression, cx);
    cx.builder.terminate({ kind: "return", values: [] });
    return;
  }
  if (ts.isBlock(stmt)) {
    // Fork scope — declarations inside the block stay local to this arm.
    const childCx: LowerCtx = { ...cx, scope: new Map(cx.scope) };
    lowerStatementList(stmt.statements, childCx);
    return;
  }
  // Slice 9 (#1169h): `throw <expr>;` at function tail. The throw
  // terminates the function abruptly — no return is reached. We lower
  // the throw and terminate the current block with `unreachable` so the
  // verifier and lowerer treat it as a stop.
  if (ts.isThrowStatement(stmt)) {
    lowerThrowStatement(stmt, cx);
    cx.builder.terminate({ kind: "unreachable" });
    return;
  }
  if (ts.isIfStatement(stmt)) {
    if (!stmt.elseStatement) {
      if (cx.returnType !== null) {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: non-void Phase 1 if must have an else arm in ${cx.funcName}`,
        );
      }
      lowerIfBodyStatement(stmt, cx);
      cx.builder.terminate({ kind: "return", values: [] });
      return;
    }
    // #1043: compile-time constant fold. After --define substitution of
    // process.env.NODE_ENV (etc.), the condition may be a literal-vs-literal
    // comparison. Lower only the live arm so dev-only code never reaches codegen.
    const constResult = evaluateConstantCondition(stmt.expression);
    if (constResult !== undefined) {
      const taken = constResult ? stmt.thenStatement : stmt.elseStatement;
      lowerTail(taken, { ...cx, scope: new Map(cx.scope) });
      return;
    }
    const rawCond = lowerExpr(stmt.expression, cx, irVal({ kind: "i32" }));
    // (#4512) §7.1.2 ToBoolean — object/string/ref conditions lower to a
    // branded i32 truthiness; a raw host externref returns null → demote.
    const cond = lowerToBooleanForCondition(rawCond, stmt.expression, cx);
    if (cond === null) {
      demoteToLegacy("operand-coercion-unsupported", `ir/from-ast: if condition must be bool in ${cx.funcName}`);
    }
    // Reserve block IDs for both arms BEFORE terminating the current block.
    // The else ID must be fixed when we emit br_if, even though it opens after
    // any nested blocks the then-arm allocates.
    const thenId = cx.builder.reserveBlockId();
    const elseId = cx.builder.reserveBlockId();
    cx.builder.terminate({
      kind: "br_if",
      condition: cond,
      ifTrue: { target: thenId, args: [] },
      ifFalse: { target: elseId, args: [] },
    });

    cx.builder.openReservedBlock(thenId);
    lowerTail(stmt.thenStatement, { ...cx, scope: new Map(cx.scope) });

    cx.builder.openReservedBlock(elseId);
    lowerTail(stmt.elseStatement, { ...cx, scope: new Map(cx.scope) });
    return;
  }
  // #2952 slice 6a — a function ENDING in a `switch`. The switch lowers
  // through the SAME `IrInstrSwitch` ladder as the non-tail form (slice 4);
  // only the block terminator differs. The selector proved one of:
  //   - void return  → control may fall out of the ladder into the implicit
  //     empty return (mirrors the `tail-if-noelse` void arm above);
  //   - non-void     → `switchAllPathsTerminate` proved every clause leaves
  //     the function and a `default` covers the no-match path, so the
  //     instruction after the ladder is unreachable (same terminator the
  //     throw-tail arm uses).
  if (ts.isSwitchStatement(stmt)) {
    lowerSwitchStatement(stmt, { ...cx, scope: new Map(cx.scope) });
    cx.builder.terminate(cx.returnType === null ? { kind: "return", values: [] } : { kind: "unreachable" });
    return;
  }
  demoteToLegacy(
    "body-shape-rejected",
    `ir/from-ast: unsupported tail statement ${ts.SyntaxKind[stmt.kind]} in ${cx.funcName}`,
  );
}

/**
 * Slice 3 (#1169c): scope bindings carry a "kind" so call-site lowering
 * knows how to dispatch.
 *
 *   - `local`: params, let/const primitives, locally-built objects, and
 *     closures stored as values (the closure case sets `type` to
 *     `IrType.closure`). Reads emit `local.get`; if the type is `boxed`
 *     (ref cell), reads dereference via `refcell.get`.
 *   - `nestedFunc`: name-only binding for `function inner() {...}`.
 *     Calls expand into prepended-capture-args + direct call (matches
 *     the legacy `compileNestedFunctionDeclaration` pattern).
 *
 * Slice 6 (#1169e):
 *   - `slot`: a Wasm-local slot that survives across iterations of a
 *     for-of loop. Used for the loop variable AND for outer-scope `let`
 *     bindings that are mutated inside the loop body. Reads emit
 *     `slot.read`; writes emit `slot.write`. Once a name is bound as a
 *     slot, all subsequent reads/writes (including AFTER the for-of)
 *     route through the slot — this preserves the cross-iteration value
 *     semantics without requiring SSA phi nodes.
 */
type ScopeBinding =
  | { kind: "local"; value: IrValueId; type: IrType; stringEncoding?: Encoding }
  | {
      /**
       * #4206 static `with` binding. The receiver is captured by reference;
       * reads/writes stay object.get/object.set operations at the point of use.
       */
      kind: "withField";
      receiver: IrValueId;
      name: string;
      type: IrType;
      stringEncoding?: Encoding;
    }
  | {
      /**
       * (#3142 Slice 2) A module-scope binding inside the `<module-init>`
       * unit. Reads emit a symbolic `global.get` and writes a symbolic
       * `global.set` against the legacy-allocated `__mod_<name>` global, so
       * the IR-lowered init body and every other function (legacy or IR)
       * share the exact same storage. Slice 2 restricts `type` to f64/i32.
       */
      kind: "moduleGlobal";
      globalRef: IrGlobalRef;
      type: IrType;
      stringEncoding?: Encoding;
    }
  | {
      kind: "nestedFunc";
      target: IrFuncRef;
      signature: IrClosureSignature;
      captures: readonly NestedCapture[];
    }
  | {
      kind: "slot";
      slotIndex: number;
      /**
       * The slot's IR type as the binding sees it. For most slots this
       * equals the underlying Wasm-local type (e.g. `irVal({ kind:
       * "f64" })` for a numeric slot). For string-loop variables in
       * native-strings mode, this is `IrType.string` while the
       * underlying slot is `(ref $AnyString)` — see `asType` below.
       */
      type: IrType;
      /**
       * Slice 6 part 4 refactor (#1185): optional widening for
       * identifier reads. When present, the SSA result of a `slot.read`
       * against this binding is re-tagged to `asType` instead of
       * `irVal(slot.type)`. Used for native-strings string for-of
       * where the slot ValType is `(ref $AnyString)` but the loop
       * variable should compose with slice-1 string ops as
       * `IrType.string`.
       *
       * The Wasm-level value is identical between `slot.type` and
       * `asType` — `IrType.string` lowers to `(ref $AnyString)` in
       * native mode — so this is purely a type-system rewrite.
       */
      asType?: IrType;
      /**
       * (#3741) The underlying Wasm slot is `i32` while `type` stays `f64` —
       * the local was proven to hold only exact signed int32 values
       * (`planI32Slots`). Reads go through `readPromotedI32Slot`, which
       * appends `f64.convert_i32_s` so the SSA value handed to EVERY consumer
       * is f64-typed exactly as before the promotion; writes go through
       * `writePromotedI32Slot`, which lowers the RHS directly as an exact
       * i32. This is deliberately NOT an `asType` widening: `asType` re-tags
       * the value the body sees, which is the cross-cutting change #3741's
       * first (reverted) attempt made.
       */
      i32Storage?: true;
      stringEncoding?: Encoding;
    };

/**
 * Slice 3 (#1169c): one entry in a closure / nested-function's capture
 * set. `outerValue` is the SSA value the call-site uses to materialize
 * the capture argument; for mutable captures, the call-site wraps it
 * in a refcell on first use (rebinding `cx.scope` in-place so
 * subsequent outer reads/writes go through the cell).
 */
interface NestedCapture {
  readonly name: string;
  /** Stored capture type. For a with-field this is the object receiver type. */
  readonly type: IrType;
  readonly mutable: boolean;
  readonly outerValue: IrValueId;
  /** Rehydrate an invocation-time object-property binding, not a value snapshot. */
  readonly withField?: { readonly name: string; readonly type: IrType };
}

interface LowerCtx {
  readonly builder: IrFunctionBuilder;
  readonly scope: Map<string, ScopeBinding>;
  readonly funcName: string;
  readonly ownerUnitId: IrUnitId;
  // Slice 14 (#1228) — `null` means the enclosing function is void.
  // `lowerTail` checks this to accept bare `return;` / fall-through tails.
  readonly returnType: IrType | null;
  readonly calleeTypes?: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType | null }>;
  readonly directCalls?: ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan>;
  readonly importedCalls?: ReadonlyMap<ts.CallExpression, IrImportedCallLoweringPlan>;
  readonly topLevelFunctionValues?: ReadonlyMap<ts.Identifier, IrTopLevelFunctionValueLoweringPlan>;
  readonly hostVoidCallbacks?: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>;
  readonly hostDateSnapshots?: ReadonlyMap<ts.NewExpression, IrHostDateSnapshotLoweringPlan>;
  readonly hostDateGetters?: ReadonlyMap<ts.CallExpression, IrHostDateGetterLoweringPlan>;
  readonly promiseDelays?: IrPromiseDelayLoweringPlans;
  readonly identityContext?: IrPlanningIdentityContext;
  /** Slice 4 (#1169d) — class shape registry, keyed by className. */
  readonly classShapes?: ReadonlyMap<string, IrClassShape>;
  /**
   * Slice 6 part 4 refactor (#1185) — from-ast view of the IR
   * resolver. Drives:
   *   - the string for-of strategy switch (`nativeStrings()`)
   *   - native-strings slot ValTypes (`resolveString()`)
   *   - vec element / data-array ValType inference (`resolveVec()`)
   *
   * Replaces the per-feature `nativeStrings: boolean` and
   * `anyStrTypeIdx: number` fields that #1183 added. Optional so
   * legacy callers (and tests) without resolver support work; the
   * for-of arms that need it throw a clean fall-back-to-legacy
   * error when it's absent.
   */
  readonly resolver?: IrFromAstResolver;
  /** Slice 3 — output bin for lifted closures / nested funcs. */
  readonly lifted: IrFunction[];
  /** Structural provenance emitted alongside each lifted function. */
  readonly liftedUnitProvenance: IrDerivedUnitProvenance[];
  /** Slice 3 — mutable counter for synthesizing lifted-func names. */
  readonly liftedCounter: { value: number };
  /**
   * Slice 6 part 2 (#1181) — names of `let` bindings that are mutated
   * somewhere in the function body (assignments via `=`, `+=`, `-=`,
   * `*=`, `/=`, or pre/postfix `++`/`--`). Mutated lets bind as a
   * `slot` ScopeBinding instead of `local` so cross-iteration writes
   * propagate correctly. Computed once per outer function in
   * `lowerFunctionAstToIr` via `collectMutatedLetNames`.
   */
  readonly mutatedLets: ReadonlySet<string>;
  /**
   * #3795 — direct-body mutable string-literal locals whose every later
   * write is a statement-position dynamic string concat. Selection and
   * lowering share the immutable proof so the local can use the canonical
   * dynamic carrier without widening arbitrary mutable strings.
   */
  readonly dynamicStringLocals: ReadonlySet<string>;
  /**
   * (#3758) Names proven, by the SAME analyses legacy's own #1120/#1236
   * i32-local promotion uses (`collectI32CoercedLocals`, `detectI32LoopVar`),
   * to always hold a clean int32 value when read. Consulted ONLY by
   * `isI32PureExprIR`/`emitI32PureExpr` (`ir/i32-pure-bitwise.ts` /
   * this file) to fast-path a bitwise operator's operand lowering through
   * genuine native i32 arithmetic instead of the expensive ToInt32 dance —
   * never used to change any local's declared IrType, so no other consumer
   * in the function is affected. Computed once per outer/nested/closure
   * function body, mirroring `mutatedLets`.
   */
  readonly i32PureNames: I32PureNames;
  /**
   * (#3741) DECLARATION NODES (whose names are a subset of `mutatedLets`)
   * whose Wasm SLOT is declared
   * `i32` instead of `f64`. Planned once per outer function by
   * `planI32Slots`. Keyed on the declaration NODE, never on identifier text:
   * two sibling `for (let i = …)` loops are two distinct bindings that share
   * a name, and a name-keyed set has to reject both to stay safe — silently
   * disabling the optimization on one of the most common shapes in real code. Distinct from `i32PureNames` above, which is a
   * VALUE-range fact used to pick cheaper arithmetic while the local keeps
   * its f64 storage: this one changes the STORAGE, which is what removes the
   * loop-carried `f64 -> i32 -> f64` round trip (see #3741's Correction
   * section for the measurements). The binding's LOGICAL `IrType` still stays
   * `f64`, so no consumer of an identifier read observes the promotion — see
   * `readPromotedI32Slot` / `writePromotedI32Slot`. Absent (undefined) for
   * nested-function / closure contexts, which keep the pre-#3741 behaviour.
   */
  readonly i32Slots?: ReadonlySet<ts.VariableDeclaration>;
  /**
   * #3502 conservative ownership proof for string builders. Each symbol is a
   * fresh empty-string `let` whose loop-local uses are discarded `+=` writes
   * only. Linear backends may therefore reuse its current allocation without
   * exposing mutation through a JavaScript string alias.
   */
  readonly ownedStringAppendSymbols: ReadonlySet<ts.Symbol>;
  /**
   * #3501 function-wide may-alias/evidence closure for unannotated `[]`.
   * It is analysis-only: allocation remains the ordinary vec.new_fixed site.
   */
  readonly emptyArrayInference: EmptyArrayElementInference;
  /**
   * (#2972) Locals bound once to a string literal and never reassigned
   * (incl. nested-function writes) → the literal's code-unit length. Feeds
   * the proven-in-bounds string element read in `lowerElementAccess`.
   * Populated for the OUTER function only; nested/lifted contexts omit it
   * (shadowing across closure scopes would make the fact unsound there).
   */
  readonly stringLiteralLens?: ReadonlyMap<string, number>;
  /**
   * Slice 7a (#1169f): kind of function being lowered. `lowerYield`
   * checks this to refuse `yield` outside generators (defensive — the
   * selector should already have rejected the function). `lowerTail`
   * uses it to rewrite `return <expr>;` as a `gen.epilogue` + return
   * the externref Generator object, since a generator's IR-level
   * return type is externref regardless of source-level annotation.
   */
  readonly funcKind: "regular" | "generator" | "async";
  /**
   * Slice 7a (#1169f): for `funcKind === "generator"` only — the slot
   * index of the `__gen_buffer` Wasm-local. Reserved by the prologue
   * in `lowerFunctionAstToIr`. `lowerYield` reads this when emitting
   * `gen.push`; `lowerTail` reads it when emitting `gen.epilogue`.
   */
  readonly generatorBufferSlot?: number;
  /** Optional-chain nullability check (#1281). When absent, `?.` / `?.()` throw to legacy. */
  readonly checker?: ts.TypeChecker;
  /** (#4218) Backend-selected oracle threaded from AstToIrOptions (see there). */
  readonly oracle?: TypeOracle;
  /**
   * #4177 — the enclosing function's OWN never-written parameter facts from
   * the SAME signature resolution selection claimed the function with,
   * consumed by `proveAdditiveOperand` via `latticeAdditiveFact`. Populated
   * for the OUTER function only; lifted-closure contexts omit it (a captured
   * param could be reassigned by a sibling closure between the outer read
   * sites, which the outer-body write scan cannot see). Full soundness
   * argument: src/ir/lattice-param-facts.ts.
   */
  readonly latticeParamFacts?: LatticeParamFacts;
  /** See {@link AstToIrOptions.numericLocalScalarForDecl}. */
  readonly numericLocalScalarForDecl?: (decl: ts.VariableDeclaration) => "number" | undefined;
  /** Host-lane dynamic method names observed while lowering IR. */
  readonly hostDynamicClassMethodNames?: Set<string>;
  /**
   * #1586: module-global allocation-site registry, threaded so lifted-closure
   * builders mint stable ids on the same registry as the outer function.
   */
  readonly allocRegistry?: AllocSiteRegistry;
  /**
   * #2766 — counted-loop in-bounds proof, ported from legacy
   * `fctx.safeIndexedArrays`. Holds `"arrayVar:indexVar"` pairs proven
   * `0 <= index < array.length` for the *current loop body* (a fresh set is
   * threaded onto the body cx by `lowerForStatement`, so it naturally scopes to
   * the loop and accumulates outward through nested loops). `lowerElementAccess`
   * consults it: a proven read keeps the fast unchecked `vec.get`; every
   * unproven read falls to the SAFE bounds-checked read (no trap).
   */
  readonly safeIndexedArrays?: ReadonlySet<string>;
  /**
   * (#3931) The #2682 canonical char-read-loop proof(s) active for the CURRENT
   * loop body, keyed by receiver name — the IR twin of legacy's
   * `fctx.hoistedCharReads`. Installed by `lowerForStatement` on a fresh body
   * cx (so it scopes to the loop and nested loops accumulate outward) and
   * consulted by `matchProvenCharRead` at `recv.charCodeAt(i)` sites, which
   * may then skip the §22.1.3.3 bounds/NaN guard and read the hoisted
   * descriptor directly. Never leaks into a nested function: the recogniser
   * refuses any body containing one.
   */
  readonly provenCharReads?: ProvenCharReads;
  /**
   * #2952 slice 2 — the innermost enclosing CLAIMED loop's label, threaded
   * onto the body cx by every loop lowerer. `lowerBreakContinueStatement`
   * emits `br.label` against it (unlabeled break/continue bind the
   * innermost loop, ECMA-262 §14.8/§14.9). Absent outside loop bodies;
   * lifted-closure contexts are constructed fresh, so it never leaks
   * across function boundaries.
   */
  readonly loopLabel?: IrLabelId;
  /**
   * #2952 slice 4 — the innermost UNLABELED-`break` target: the nearest
   * enclosing loop OR switch (ECMA-262 §14.9 — break binds the nearest
   * breakable statement, while continue binds the nearest LOOP, which is
   * why this is a separate field from `loopLabel`). Loop lowerers set both
   * to the loop's label; `lowerSwitchStatement` sets only this one (a
   * `continue` inside a switch still targets the enclosing loop).
   */
  readonly breakTargetLabel?: IrLabelId;
  /**
   * #2952 slice 3 — source-label environment: maps a `LabeledStatement`'s
   * label NAME to the `IrLabelId` of the loop it labels. `break lbl` /
   * `continue lbl` resolve through this map (the id is the labeled loop's
   * own `loopLabel`, so the lowering-time depth resolver needs no new
   * machinery). Scoped to the labeled statement's own lowering — the map
   * is extended on the ctx passed INTO the labeled loop and never leaks
   * to siblings. Lifted-closure contexts are built fresh, so labels never
   * cross a function boundary (JS labels are function-local anyway).
   */
  readonly labelEnv?: ReadonlyMap<string, IrLabelId>;
  /**
   * #2952 slice 3 — a pre-allocated label id the NEXT loop lowerer must
   * adopt as its `loopLabel` instead of minting a fresh one. Set by
   * `lowerLabeledStatement` so `lbl: while (...)` gives the loop the same
   * id that `labelEnv["lbl"]` maps to. Every loop lowerer consumes it
   * exactly once and clears it on its inner contexts (a nested unlabeled
   * loop must NOT inherit the same id — labels are per-loop unique).
   */
  readonly pendingLoopLabel?: IrLabelId;
  /**
   * (#2856) Early-return barrier. Set `true` for statement buffers where a
   * Wasm-`return`-based early exit is UNSOUND: for-of bodies (an iterator-
   * protocol drive would skip its `iter.return` cleanup) and try/catch/
   * finally bodies (a Wasm return skips the inlined finally). `lowerStmt`'s
   * ReturnStatement arm throws (→ clean legacy demote) when set. Plain
   * while/for/do bodies inherit the surrounding value, so a loop nested
   * inside a try correctly stays barred. Mirrored by the selector's
   * `earlyReturnBarrierDepth` so accepted shapes always lower.
   */
  readonly noEarlyReturn?: boolean;
  /**
   * (#3142 Slice 2) Module-scope binding storage map — present only when
   * lowering the `<module-init>` unit. `lowerVarDecl` consults it: a
   * declared name with an entry binds as a `moduleGlobal` ScopeBinding
   * (symbolic global.set) instead of a local/slot. Names WITHOUT an entry
   * (loop-scoped `let i` in a for-init, block-scoped inner lets) keep the
   * ordinary local/slot lowering.
   */
  readonly moduleBindings?: ReadonlyMap<string, ModuleBindingGlobal>;
}

/** Conservative producer-side encoding evidence for the typed string slice. */
function inferStringEncoding(expr: ts.Expression, cx: LowerCtx): Encoding | undefined {
  if (ts.isParenthesizedExpression(expr)) return inferStringEncoding(expr.expression, cx);
  if (ts.isStringLiteral(expr) || expr.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    return classifyLiteral((expr as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text);
  }
  if (ts.isIdentifier(expr)) {
    const binding = cx.scope.get(expr.text);
    return binding && "stringEncoding" in binding ? binding.stringEncoding : undefined;
  }
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = inferStringEncoding(expr.left, cx);
    const right = inferStringEncoding(expr.right, cx);
    return left && right ? joinEncoding(left, right) : undefined;
  }
  if (
    ts.isCallExpression(expr) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    expr.expression.name.text === "charAt"
  ) {
    const receiver = inferStringEncoding(expr.expression.expression, cx);
    return receiver === "ascii" ? "ascii" : receiver ? "wtf16" : undefined;
  }
  return undefined;
}

type StringEncodingScopeBinding = Exclude<ScopeBinding, { kind: "nestedFunc" }>;

function isStringEncodingScopeBinding(binding: ScopeBinding): binding is StringEncodingScopeBinding {
  if (binding.kind === "nestedFunc") return false;
  return (binding.kind === "slot" ? (binding.asType ?? binding.type) : binding.type).kind === "string";
}

function sameScopeStorage(a: StringEncodingScopeBinding, b: ScopeBinding | undefined): boolean {
  if (!b || b.kind !== a.kind) return false;
  switch (a.kind) {
    case "local":
      return b.kind === "local" && b.value === a.value;
    case "moduleGlobal":
      return b.kind === "moduleGlobal" && sameIrGlobalBinding(b.globalRef.binding, a.globalRef.binding);
    case "withField":
      return b.kind === "withField" && b.receiver === a.receiver && b.name === a.name;
    case "slot":
      return b.kind === "slot" && b.slotIndex === a.slotIndex;
  }
}

/**
 * (#3214 B1) Read/create the canonical cached wrapper for one exact bare
 * top-level function-value site.  The codegen planning phase has already
 * materialized the matching symbolic trampoline/global declarations through
 * `ensureFuncClosureSingleton`; IR owns only the lazy access sequence.
 */
function lowerTopLevelFunctionValue(plan: IrTopLevelFunctionValueLoweringPlan, cx: LowerCtx): IrValueId {
  requireMatchingLoweringPlanOwner("top-level function value", plan.ownerUnitId, cx.ownerUnitId, cx.funcName);
  if (plan.target.binding.kind !== "unit") {
    // invariant (producer-promise): identity resolution promised an exact unit — #4502.
    throw new Error(`ir/from-ast: top-level function value target ${plan.target.name} is not an exact unit`);
  }
  if (plan.trampoline.binding.kind !== "support") {
    // invariant (producer-promise): the prepared trampoline plan promised a compiler-support binding — #4502.
    throw new Error(`ir/from-ast: function-value trampoline ${plan.trampoline.name} is not compiler support`);
  }
  const cache = plan.cacheGlobal;
  const cached = cx.builder.emitGlobalGet(cache, irVal({ kind: "externref" }));
  const isNull = cx.builder.emitRefIsNull(cached);
  const thenBody = cx.builder.collectBodyInstrs(() => {
    const closure = cx.builder.emitClosureNew(plan.trampoline, plan.signature, [], []);
    const external = cx.builder.emitCoerceToExternref(closure);
    cx.builder.emitGlobalSet(cache, external);
  });
  cx.builder.emitIfStmt({ cond: isNull, then: thenBody, else: [] });
  // `callable<S>` is the source boundary type and lowers to the exact same
  // externref global carrier. Retagging the final read avoids an unsound
  // externref→closure cast while preserving singleton identity.
  return cx.builder.emitGlobalGet(cache, { kind: "callable", signature: plan.signature });
}

/**
 * Join optional encoding evidence at a control-flow merge. Absence is the
 * conservative top fact: one unproven predecessor invalidates a narrower
 * claim. Proven predecessors use the existing encoding lattice.
 */
function joinStringEncodingFacts(left: Encoding | undefined, right: Encoding | undefined): Encoding | undefined {
  return left === undefined || right === undefined ? undefined : joinEncoding(left, right);
}

/**
 * Merge mutable string facts from every reachable predecessor into `target`.
 * Only bindings that still name the same storage participate; a child-scope
 * shadow leaves the outer binding unchanged on that predecessor.
 */
function joinScopeStringEncodingFacts(
  target: Map<string, ScopeBinding>,
  predecessors: readonly ReadonlyMap<string, ScopeBinding>[],
): void {
  for (const [name, binding] of target) {
    if (!isStringEncodingScopeBinding(binding) || predecessors.length === 0) continue;
    let joined: Encoding | undefined = binding.stringEncoding;
    let first = true;
    for (const predecessor of predecessors) {
      const candidate = predecessor.get(name);
      const fact = sameScopeStorage(binding, candidate)
        ? (candidate as StringEncodingScopeBinding).stringEncoding
        : binding.stringEncoding;
      joined = first ? fact : joinStringEncodingFacts(joined, fact);
      first = false;
    }
    target.set(name, { ...binding, stringEncoding: joined });
  }
}

function joinedStringEncodingScope(
  base: ReadonlyMap<string, ScopeBinding>,
  predecessors: readonly ReadonlyMap<string, ScopeBinding>[],
): Map<string, ScopeBinding> {
  const joined = new Map(base);
  joinScopeStringEncodingFacts(joined, predecessors);
  return joined;
}

type PotentialStringEncodingWrite = {
  readonly name: string;
  readonly rhs?: ts.Expression;
  readonly append: boolean;
};

/** Collect possible writes in evaluation order, excluding nested functions. */
function collectPotentialStringEncodingWrites(root: ts.Node): readonly PotentialStringEncodingWrite[] {
  const writes: PotentialStringEncodingWrite[] = [];

  const visit = (node: ts.Node): void => {
    if (node !== root && (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node))) return;

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      // Assignment-expression side effects in the RHS happen before the outer
      // identifier write, so record them first for the abstract transfer.
      visit(node.right);
      if (ts.isIdentifier(node.left)) {
        const op = node.operatorToken.kind;
        writes.push({
          name: node.left.text,
          ...(op === ts.SyntaxKind.EqualsToken || op === ts.SyntaxKind.PlusEqualsToken ? { rhs: node.right } : {}),
          append: op === ts.SyntaxKind.PlusEqualsToken,
        });
      } else {
        visit(node.left);
      }
      return;
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      visit(node.initializer);
      writes.push({ name: node.name.text, rhs: node.initializer, append: false });
      return;
    }

    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      writes.push({ name: node.operand.text, append: false });
      return;
    }

    // `for (outerBinding of iterable)` performs a write on every iteration.
    // The element encoding is not represented by this syntax-level summary,
    // so kill any matching outer string fact conservatively.
    if (ts.isForOfStatement(node) && ts.isIdentifier(node.initializer)) {
      visit(node.expression);
      writes.push({ name: node.initializer.text, append: false });
      visit(node.statement);
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(root);
  return writes;
}

/**
 * Compute the least conservative encoding environment after zero or more
 * executions of every possible write in `root`. Each transfer joins with the
 * incoming fact, preserving the path where the write is skipped. Iteration to
 * stability is required for loop-carried dependencies such as
 * `text = other; other = input`: the second write widens `other` on pass one,
 * and the first write must then widen `text` on pass two.
 */
function conservativeStringEncodingScope(root: ts.Node, cx: LowerCtx): Map<string, ScopeBinding> {
  const scope = new Map(cx.scope);
  const writes = collectPotentialStringEncodingWrites(root);

  let changed: boolean;
  do {
    changed = false;
    for (const write of writes) {
      const binding = scope.get(write.name);
      if (!binding || !isStringEncodingScopeBinding(binding)) continue;
      const current = binding.stringEncoding;
      const rhsEncoding = write.rhs ? inferStringEncoding(write.rhs, { ...cx, scope }) : undefined;
      const written = write.append ? joinStringEncodingFacts(current, rhsEncoding) : rhsEncoding;
      const widened = joinStringEncodingFacts(current, written);
      if (widened === current) continue;
      scope.set(write.name, { ...binding, stringEncoding: widened });
      changed = true;
    }
  } while (changed);

  return scope;
}

/** Compute the conservative loop-header fixed point without emitting IR. */
function conservativeLoopStringEncodingScope(loop: ts.IterationStatement, cx: LowerCtx): Map<string, ScopeBinding> {
  return conservativeStringEncodingScope(loop, cx);
}

function typedValueEvidence(
  expr: ts.Expression,
  carrierType: IrType,
  stringEncoding: Encoding | undefined,
  cx: LowerCtx,
  producerSemanticType: IrType = carrierType,
): TypedValueEvidence {
  const checkerProof = cx.checker ? classifyPrimitiveProof(cx.checker.getTypeAtLocation(expr)) : "unprovable";
  if (checkerProof === "string" || checkerProof === "number") {
    return {
      semanticType: checkerProof,
      carrierType,
      semanticSource: "checker",
      ...(checkerProof === "string" && stringEncoding ? { stringEncoding } : {}),
    };
  }
  const producerCarrier = asVal(producerSemanticType);
  return {
    semanticType:
      producerSemanticType.kind === "string" ? "string" : producerCarrier?.kind === "f64" ? "number" : "other",
    carrierType,
    semanticSource: "producer",
    ...(producerSemanticType.kind === "string" && stringEncoding ? { stringEncoding } : {}),
  };
}

/**
 * Slice 6 part 2 (#1181): walk a function body to collect every `let`
 * name that is reassigned somewhere — `<id> = <expr>`, `<id> +=/-=/*=/`/=`
 * `<expr>`, or pre/postfix `++<id>`/`--<id>`/`<id>++`/`<id>--`. Names
 * that match are bound as `slot` ScopeBindings so the cross-iteration
 * write semantics inside for-of loops work correctly. Const-bound names
 * are not in scope for mutation; we only track identifier-LHS writes.
 *
 * This includes parameters as well as `let` locals: an accepted reassigned
 * parameter is seeded into a slot from its incoming SSA value. We DON'T
 * descend into nested function-likes — their writes are local to their own
 * scope and don't influence the outer's slot decisions.
 */
function collectMutatedLetNames(
  fn:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    // #3000-B: accessors reach this via `lowerFunctionAstToIr`; only `.body` is read.
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration,
): Set<string> {
  const writes = new Set<string>();
  if (!fn.body) return writes;
  return collectMutatedLetNamesFromBlock(fn.body);
}

function collectMutatedLetNamesFromBlock(body: ts.Block): Set<string> {
  const writes = new Set<string>();
  const visit = (node: ts.Node): void => {
    // Skip nested function bodies — their writes belong to their own
    // scope. The outer `mutatedLets` only governs outer-scope `let`s.
    if (
      node !== body &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node))
    ) {
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.CaretEqualsToken)
      ) {
        if (ts.isIdentifier(node.left)) writes.add(node.left.text);
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const op = node.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        if (ts.isIdentifier(node.operand)) writes.add(node.operand.text);
      }
    }
    forEachChild(node, visit);
  };
  forEachChild(body, visit);
  return writes;
}

/**
 * Prove the narrow, backend-neutral string-builder shape used by the linear
 * append optimization:
 *
 *   let value = "";
 *   for (...) {
 *     value += part;
 *   }
 *
 * The declaration and loop must be adjacent. Within the loop every reference
 * to the exact checker symbol must be the direct LHS of a discarded `+=`;
 * nested-function references are rejected. Later reads are allowed, but later
 * writes are not. This keeps the semantic IR operation `string.concat` while
 * proving that a linear backend may mutate/reallocate the current carrier.
 */
function collectOwnedStringAppendSymbols(body: ts.Block, checker: ts.TypeChecker | undefined): Set<ts.Symbol> {
  const proven = new Set<ts.Symbol>();
  if (!checker) return proven;

  const statements = body.statements;
  for (let statementIndex = 0; statementIndex + 1 < statements.length; statementIndex++) {
    const declarationStatement = statements[statementIndex]!;
    const loopStatement = statements[statementIndex + 1]!;
    if (!ts.isVariableStatement(declarationStatement)) continue;
    if (!(declarationStatement.declarationList.flags & ts.NodeFlags.Let)) continue;
    if (declarationStatement.declarationList.declarations.length !== 1) continue;
    if (!isIterationStatement(loopStatement)) continue;

    const declaration = declarationStatement.declarationList.declarations[0]!;
    if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
    if (!isEmptyStringLiteral(declaration.initializer)) continue;
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (!symbol) continue;

    let appendCount = 0;
    let loopUsesAreOwnedAppends = true;
    const visitLoop = (node: ts.Node, nestedFunction = false): void => {
      const entersNestedFunction =
        nestedFunction ||
        (node !== loopStatement &&
          (ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) ||
            ts.isMethodDeclaration(node)));
      if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) {
        const parent = node.parent;
        const isDiscardedAppend =
          !entersNestedFunction &&
          ts.isBinaryExpression(parent) &&
          parent.left === node &&
          parent.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
          ts.isExpressionStatement(parent.parent);
        if (!isDiscardedAppend) loopUsesAreOwnedAppends = false;
        else appendCount++;
      }
      forEachChild(node, (child) => visitLoop(child, entersNestedFunction));
    };
    visitLoop(loopStatement);
    if (!loopUsesAreOwnedAppends || appendCount === 0) continue;

    let laterWrite = false;
    const visitLater = (node: ts.Node): void => {
      if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)) {
        const op = node.operatorToken.kind;
        if (
          checker.getSymbolAtLocation(node.left) === symbol &&
          (op === ts.SyntaxKind.EqualsToken ||
            (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.CaretEqualsToken))
        ) {
          laterWrite = true;
        }
      }
      if (
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
        ts.isIdentifier(node.operand) &&
        checker.getSymbolAtLocation(node.operand) === symbol
      ) {
        laterWrite = true;
      }
      forEachChild(node, visitLater);
    };
    for (let laterIndex = statementIndex + 2; laterIndex < statements.length; laterIndex++) {
      visitLater(statements[laterIndex]!);
    }
    if (!laterWrite) proven.add(symbol);
  }
  return proven;
}

function isIterationStatement(statement: ts.Statement): boolean {
  return (
    ts.isForStatement(statement) ||
    ts.isForInStatement(statement) ||
    ts.isForOfStatement(statement) ||
    ts.isWhileStatement(statement) ||
    ts.isDoStatement(statement)
  );
}

function isEmptyStringLiteral(expression: ts.Expression): boolean {
  const unwrapped = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
  return (
    (ts.isStringLiteral(unwrapped) || unwrapped.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) &&
    (unwrapped as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text.length === 0
  );
}

// ---------------------------------------------------------------------------
// (#3741) Native-i32 slot storage
//
// A local planned by `planI32Slots` gets an `i32` Wasm slot while its
// ScopeBinding `type` stays `f64`. The whole safety argument rests on two
// invariants, both enforced here:
//
//   R (read)  — every read of a promoted slot immediately widens with
//               `f64.convert_i32_s`, so the SSA value every consumer receives
//               is f64-typed and numerically identical to the pre-promotion
//               value. NO consumer anywhere in this file can tell the
//               difference. This is what makes the change locally contained,
//               unlike #3741's first attempt (which retyped the binding).
//   W (write) — every write lowers its RHS DIRECTLY to an exact i32 via
//               `lowerAsI32`, never by truncating an already-lowered f64.
//               If a write shape somehow reaches here that `lowerAsI32`
//               cannot produce, we demote the whole function (clean
//               `IrUnsupportedError`) rather than approximate — a wrong
//               arithmetic answer is the one outcome that is not acceptable.
//
// Everything else in this block is a *peephole*: it replaces a value with a
// provably bit-identical one of the SAME IrType, so it can be deleted without
// changing behaviour.
// ---------------------------------------------------------------------------

const IR_I32: IrType = irVal({ kind: "i32" });
const IR_F64: IrType = irVal({ kind: "f64" });
const IR_I64: IrType = irVal({ kind: "i64" });
/**
 * (#4503) The boolean-branded `i32` (see `boolean-brand.ts`). Every site that
 * produces a JS `boolean` — literal, comparison, `!`, the equality folds —
 * types its value with this instead of the bare {@link IR_I32}, so a consumer
 * can tell `${true}` from `${1}` once the checker family is gone. The brand is
 * erasable under `irTypeEquals`, so branding a producer changes nothing about
 * what joins or verifies — only what a brand-reading consumer may claim.
 */
const IR_BOOL: IrType = irBool();
const LEGACY_EXPRESSION_DEFAULT_F64_SENTINEL_BITS = 0x7ff00000deadc0den;

/** `cx`-bound "is this name an i32-promoted slot right now?" predicate. */
function promotedI32Probe(cx: LowerCtx): IsPromotedI32 {
  return (id: ts.Identifier): boolean => {
    const b = cx.scope.get(id.text);
    return b !== undefined && b.kind === "slot" && b.i32Storage === true;
  };
}

function lowerNarrowedI32Element(value: ts.Expression, cx: LowerCtx): IrValueId {
  return lowerNarrowedI32ElementWith(value, cx, promotedI32Probe(cx), (expression) =>
    lowerAsI32(expression, cx, "canon"),
  );
}

/**
 * Union of the two i32 proofs available in an already-ToInt32'd (Q-WRAP)
 * position:
 *   - #3741's SLOT promotion — the local's Wasm storage IS i32, so the read is
 *     the i32 (no narrowing instruction at all);
 *   - #3758's VALUE proof — the local keeps f64 storage but its value is
 *     provably int32-range, so it can be narrowed with the cheap
 *     `i32.trunc_sat_f64_s` (`isI32PureExprIR` / `emitI32PureExpr`).
 *
 * Taking the union matters: without it, a mixed expression like
 * `(promoted + notPromotedButPure) | 0` would satisfy neither predicate alone
 * and fall all the way back to the full ToInt32 dance — i.e. #3741 would
 * REGRESS an expression #3758 already handles.
 */
function isFusedI32Lowerable(e: ts.Expression, cx: LowerCtx): boolean {
  return isWrapI32Lowerable(e, promotedI32Probe(cx)) || isI32PureExprIR(e, cx.i32PureNames, cx.provenCharReads);
}

/**
 * A nested bitwise result is already the exact 32-bit pattern the enclosing
 * bitwise operator's ToInt32 conversion consumes. This deliberately includes
 * `>>>`: its JavaScript NUMBER result may be above INT32_MAX, so it is not a
 * generally signed-i32-valued expression, but converting that uint32 result
 * back through ToInt32 preserves the same 32 bits.
 */
function isNestedBitwiseResult(e: ts.Expression): boolean {
  const inner = peelExpr(e);
  return ts.isBinaryExpression(inner) && isIrBitwiseOperatorToken(inner.operatorToken.kind);
}

/** Invariant R — read a promoted slot and widen to the f64 every consumer expects. */
function readPromotedI32Slot(slotIndex: number, cx: LowerCtx): IrValueId {
  return cx.builder.emitUnary("f64.convert_i32_s", cx.builder.emitSlotRead(slotIndex), IR_F64);
}

/**
 * Lower one operand of a bitwise op. When the operand is Q-WRAP lowerable we
 * emit it natively in i32 (the enclosing bitwise op's own ToInt32 is then a
 * no-op, which is exactly the fast path `lower.ts` already recognises for two
 * i32-typed operands); otherwise nothing changes — plain f64 lowering, and
 * `lower.ts` applies its usual `emitJsToInt32`.
 */
function lowerBitwiseOperand(e: ts.Expression, parent: ts.BinaryExpression | null, cx: LowerCtx): IrValueId {
  if (isFusedI32Lowerable(e, cx) || isNestedBitwiseResult(e)) return lowerAsI32(e, cx, "wrap");
  const v = lowerExpr(e, cx, IR_F64);
  // Taking the fused path means we bypassed `lowerBinary`'s operand-shape
  // gates (string / dynamic / packed). Reproduce its verdict EXACTLY for a
  // non-scalar operand rather than feeding an externref to `js.bit*`: a
  // checker-proven coercion gap is a soft demote, anything else stays the
  // loud producer-contract invariant.
  const kind = asVal(cx.builder.typeOf(v))?.kind;
  if (kind !== "f64" && kind !== "i32" && parent !== null) {
    const detail =
      `ir/from-ast: Phase 1 requires matching operand types for ` +
      `'${ts.tokenToString(parent.operatorToken.kind)}' in ${cx.funcName}`;
    if (checkerProvesBinarySourceCapabilityGap(parent.left, parent.right, cx)) {
      throw new IrUnsupportedError("operand-coercion-unsupported", "build", detail);
    }
    throw new Error(detail);
  }
  if (kind !== "f64" && kind !== "i32") {
    throw new IrUnsupportedError(
      "operand-coercion-unsupported",
      "build",
      `ir/from-ast: bitwise compound-assignment RHS must be a scalar in ${cx.funcName} (#3741)`,
    );
  }
  return v;
}

/**
 * Emit `expr` as a native i32 SSA value.
 *
 * `mode` records WHICH proof the caller holds:
 *   - `"canon"` — the value is exactly a signed int32 (safe to STORE).
 *   - `"wrap"`  — the value is only `ToInt32`-equivalent, which is enough when
 *     it feeds a bitwise operator or an i32-promoted slot (both apply ToInt32).
 *
 * Precondition: the matching predicate (`isCanonI32Lowerable` /
 * `isWrapI32Lowerable`) holds. A violation demotes the function rather than
 * emitting an approximation.
 */
function lowerAsI32(expr: ts.Expression, cx: LowerCtx, mode: "canon" | "wrap"): IrValueId {
  const inner = peelExpr(expr);

  const lit = i32LiteralValue(inner);
  if (lit !== null) return cx.builder.emitConst({ kind: "i32", value: lit }, IR_I32);

  if (ts.isIdentifier(inner)) {
    const b = cx.scope.get(inner.text);
    if (b !== undefined && b.kind === "slot" && b.i32Storage === true) {
      return cx.builder.emitSlotRead(b.slotIndex);
    }
  }

  if (ts.isBinaryExpression(inner)) {
    const k = inner.operatorToken.kind;
    // In wrap-only contexts a `>>>` result is consumed as its raw 32-bit
    // pattern, so it can use the same native emitter as signed bitwise ops.
    if (jsBitwiseBinop(k) !== null) return lowerBitwiseAsI32(inner, cx);
    if (
      mode === "wrap" &&
      (k === ts.SyntaxKind.PlusToken || k === ts.SyntaxKind.MinusToken) &&
      isFusedI32Lowerable(inner.left, cx) &&
      isFusedI32Lowerable(inner.right, cx)
    ) {
      // The fused unit #3741 exists for. `i32.add` / `i32.sub` wrap mod 2^32,
      // which equals `ToInt32(f64.add/sub(a, b))` because both operands are
      // int32-range so the f64 result is exact (|a ± b| < 2^32 < 2^53).
      const lhs = lowerAsI32(inner.left, cx, "wrap");
      const rhs = lowerAsI32(inner.right, cx, "wrap");
      return cx.builder.emitBinary(k === ts.SyntaxKind.PlusToken ? "i32.add" : "i32.sub", lhs, rhs, IR_I32);
    }
  }

  // (#3758) Anything this function cannot produce itself but whose VALUE is
  // provably int32-range falls to #3758's emitter, which composes `i32.add`/
  // `i32.sub`/guarded-`i32.mul` and narrows genuine leaves with the cheap
  // `i32.trunc_sat_f64_s`. Checked BEFORE the generic lowering below so a
  // mixed promoted/pure subtree never degrades to the full ToInt32 dance.
  if (isI32PureExprIR(inner, cx.i32PureNames, cx.provenCharReads)) return emitI32PureExpr(inner, cx);

  // Comparisons (and anything else the predicates admit) already lower to i32
  // through the ordinary path — take it and assert the representation.
  const v = lowerExpr(inner, cx, IR_I32);
  if (asVal(cx.builder.typeOf(v))?.kind === "i32") return v;
  throw new IrUnsupportedError(
    "operand-coercion-unsupported",
    "build",
    `ir/from-ast: i32-promoted slot store needs an exact i32 but '${ts.SyntaxKind[inner.kind]}' lowered to ` +
      `${describeIrType(cx.builder.typeOf(v))} in ${cx.funcName} (#3741)`,
  );
}

/**
 * Lower a bitwise binary expression, narrowing its IR result type to i32.
 * Callers only request an i32 result where the value is consumed as a 32-bit
 * pattern. That includes nested `>>>`: its standalone JavaScript value remains
 * unsigned f64, but an enclosing bitwise operation immediately applies
 * ToInt32 and consumes exactly these bits.
 */
function lowerBitwiseAsI32(expr: ts.BinaryExpression, cx: LowerCtx): IrValueId {
  const k = expr.operatorToken.kind;
  // `x | 0` / `x ^ 0` — OR/XOR with 0 is the identity on the ToInt32 bit
  // pattern, so when `x` is already i32-lowerable the operator disappears
  // entirely. (One level deeper than #3733's `lower.ts` fast path, which still
  // had to run `emitJsToInt32` on `x`.)
  if (
    (k === ts.SyntaxKind.BarToken || k === ts.SyntaxKind.CaretToken) &&
    i32LiteralValue(expr.right) === 0 &&
    isFusedI32Lowerable(expr.left, cx)
  ) {
    return lowerAsI32(expr.left, cx, "wrap");
  }
  const binop = jsBitwiseBinop(k);
  if (binop === null) {
    // invariant (producer-promise): caller contract: reachable only for bitwise operators — #4502.
    throw new Error(`ir/from-ast: '${ts.tokenToString(k)}' is not a bitwise operator (${cx.funcName}) (#3741)`);
  }
  const lhs = lowerBitwiseOperand(expr.left, expr, cx);
  const rhs = lowerBitwiseOperand(expr.right, expr, cx);
  return cx.builder.emitBinary(binop, lhs, rhs, IR_I32);
}

/** Invariant W — store `rhs` into an i32-promoted slot. */
function writePromotedI32Slot(slotIndex: number, rhs: ts.Expression, cx: LowerCtx, targetName?: string): void {
  const promoted = promotedI32Probe(cx);
  const exactI32 = (id: ts.Identifier): boolean => promoted(id) || cx.i32PureNames.has(id.text);
  // (#3907) `i = i + <int literal>` — the desugared spelling of the `i += <lit>`
  // counter step that `lowerPromotedI32CompoundAssignment` already emits. The
  // planner admits it only for a `detectI32LoopVar`-proven counter, so it
  // carries the same bounded-by-the-loop-condition proof; emit the same
  // `i32.add`/`i32.sub` here rather than demoting the whole function. Before
  // #3907 this never mattered because fast mode narrowed every `number`
  // unconditionally; it is the spelling the benchmark suite actually uses.
  const counterStep = targetName === undefined ? null : counterStepAssignment(rhs, targetName);
  if (counterStep !== null) {
    const lhs = cx.builder.emitSlotRead(slotIndex);
    const stepValue = cx.builder.emitConst({ kind: "i32", value: counterStep.step }, IR_I32);
    const binop: IrBinop = counterStep.negate ? "i32.sub" : "i32.add";
    cx.builder.emitSlotWrite(slotIndex, cx.builder.emitBinary(binop, lhs, stepValue, IR_I32));
    return;
  }
  if (!isCanonI32Lowerable(rhs, exactI32)) {
    throw new IrUnsupportedError(
      "operand-coercion-unsupported",
      "build",
      `ir/from-ast: write to i32-promoted slot is not exact-i32 lowerable in ${cx.funcName} (#3741)`,
    );
  }
  cx.builder.emitSlotWrite(slotIndex, lowerAsI32(rhs, cx, "canon"));
}

/**
 * (#3741) `<id> <op>= <expr>` on an i32-promoted slot.
 *
 * `planI32Slots` admits exactly two shapes here, and both stay in the i32
 * domain end-to-end (no f64 round trip):
 *   - a BITWISE compound (`&=` `|=` `^=` `<<=` `>>=`), whose result is an
 *     exact int32 whatever the RHS is (`>>>=` is excluded — its uint32 value
 *     can exceed 2^31-1);
 *   - `+=` / `-=` by an INTEGER LITERAL on a `detectI32LoopVar`-proven
 *     counter, i.e. the generalised `i++` step legacy also promotes. A general
 *     `+=` accumulator is deliberately NOT admitted — that is the #1236 trap.
 */
function lowerPromotedI32CompoundAssignment(
  id: ts.Identifier,
  slotIndex: number,
  compoundOp: ts.SyntaxKind,
  rhs: ts.Expression,
  cx: LowerCtx,
): void {
  const bitwiseToken = COMPOUND_TO_BITWISE_TOKEN[compoundOp as keyof typeof COMPOUND_TO_BITWISE_TOKEN];
  if (bitwiseToken !== undefined) {
    const lhs = cx.builder.emitSlotRead(slotIndex);
    const rhsValue = lowerBitwiseOperand(rhs, null, cx);
    const binop = jsBitwiseBinop(bitwiseToken);
    if (binop === null) {
      // invariant (producer-promise): caller contract: reachable only for bitwise operators — #4502.
      throw new Error(`ir/from-ast: unmapped bitwise compound op in ${cx.funcName} (#3741)`);
    }
    cx.builder.emitSlotWrite(slotIndex, cx.builder.emitBinary(binop, lhs, rhsValue, IR_I32));
    return;
  }
  const step = i32LiteralValue(rhs);
  if (
    step !== null &&
    (compoundOp === ts.SyntaxKind.PlusEqualsToken || compoundOp === ts.SyntaxKind.MinusEqualsToken)
  ) {
    const lhs = cx.builder.emitSlotRead(slotIndex);
    const stepValue = cx.builder.emitConst({ kind: "i32", value: step }, IR_I32);
    const binop: IrBinop = compoundOp === ts.SyntaxKind.PlusEqualsToken ? "i32.add" : "i32.sub";
    cx.builder.emitSlotWrite(slotIndex, cx.builder.emitBinary(binop, lhs, stepValue, IR_I32));
    return;
  }
  throw new IrUnsupportedError(
    "operand-coercion-unsupported",
    "build",
    `ir/from-ast: compound assign '${ts.tokenToString(compoundOp)}' to i32-promoted slot "${id.text}" ` +
      `is not exact-i32 lowerable in ${cx.funcName} (#3741)`,
  );
}

/**
 * (#3741) Fused i32 fast paths for `lowerBinary`. Both arms are peepholes:
 * they return a value of the SAME IrType the unfused lowering would, so no
 * consumer observes anything new.
 *
 * Returns `null` when nothing applies (the caller continues unchanged).
 */
function tryLowerFusedI32Binary(expr: ts.BinaryExpression, op: ts.SyntaxKind, cx: LowerCtx): IrValueId | null {
  const promoted = promotedI32Probe(cx);

  // (0) `x | 0` / `x ^ 0` is the identity on the ToInt32 bit pattern, so the
  //     operator disappears whenever `x` is i32-lowerable by EITHER proof.
  //     For a #3758-only `x` this also removes a redundant `i32.const 0;
  //     i32.or`: that path lowers the `0` as `i32.trunc_sat_f64_s(f64.const
  //     0)`, which `lower.ts`'s #3733 `tryConstOf(rhs) === 0` check cannot
  //     see through.
  if (
    (op === ts.SyntaxKind.BarToken || op === ts.SyntaxKind.CaretToken) &&
    i32LiteralValue(expr.right) === 0 &&
    isFusedI32Lowerable(expr.left, cx)
  ) {
    return cx.builder.emitUnary("f64.convert_i32_s", lowerAsI32(expr.left, cx, "wrap"), IR_F64);
  }

  // (a) Bitwise op that actually READS an i32-promoted slot. The
  //     "reads a promoted slot" gate is load-bearing: without it this arm would
  //     also swallow expressions that only #3758 can fuse well (e.g.
  //     `(a + b) | 0` over i32-pure-but-f64-STORED locals), where our narrower
  //     Q-WRAP matcher rejects the `a + b` and we would fall back to an f64 add
  //     plus a full ToInt32 — strictly worse than #3758's `i32.add`. When no
  //     promoted slot participates we return null and #3758's path runs
  //     unchanged.
  if (jsBitwiseBinop(op) !== null) {
    if (!referencesPromotedI32Slot(expr.left, promoted) && !referencesPromotedI32Slot(expr.right, promoted)) {
      return null;
    }
    if (isBitwiseToken(op)) {
      // Result is an exact int32 → compute in i32 and widen once, matching the
      // f64 result type `lowerBinary` would have produced.
      return cx.builder.emitUnary("f64.convert_i32_s", lowerBitwiseAsI32(expr, cx), IR_F64);
    }
    // `>>>` — the uint32 result must stay f64-typed so `lower.ts` tails it with
    // the UNSIGNED `f64.convert_i32_u`. Only the operands are fused.
    const lhs = lowerBitwiseOperand(expr.left, expr, cx);
    const rhs = lowerBitwiseOperand(expr.right, expr, cx);
    return cx.builder.emitBinary("js.shr_u", lhs, rhs, IR_F64);
  }

  // (b) Magnitude comparison where BOTH operands are exactly-int32 (Q-CANON,
  //     NOT Q-WRAP: a wrapped `a + b` has a different VALUE than the f64 sum,
  //     which would change the comparison — legacy's #2055 rule). Both sides
  //     are exact integers, so `i32.lt_s` and `f64.lt` agree bit-for-bit, and
  //     the result type (i32 bool, boolean-branded since #4503 — same as the
  //     unfused arm in `lowerBinary`) is unchanged.
  const cmp = I32_COMPARE_BINOPS[op as keyof typeof I32_COMPARE_BINOPS];
  if (cmp !== undefined && isCanonI32Lowerable(expr.left, promoted) && isCanonI32Lowerable(expr.right, promoted)) {
    // Require at least one side to be a promoted slot read; otherwise this is
    // a pair of constants / bitwise results the existing lowering already
    // handles natively and the rewrite buys nothing.
    if (referencesPromotedI32Slot(expr.left, promoted) || referencesPromotedI32Slot(expr.right, promoted)) {
      const lhs = lowerAsI32(expr.left, cx, "canon");
      const rhs = lowerAsI32(expr.right, cx, "canon");
      return cx.builder.emitBinary(cmp, lhs, rhs, IR_BOOL);
    }
  }

  return null;
}

function lowerVarDecl(stmt: ts.VariableStatement, cx: LowerCtx): void {
  const isConst = !!(stmt.declarationList.flags & ts.NodeFlags.Const);
  for (const d of stmt.declarationList.declarations) {
    // Slice 8a (#1169g): destructuring binding patterns (selector restricts
    // to const, no rest, no defaults, no nesting). Lower the initializer
    // ONCE into an SSA value, then walk the pattern emitting one
    // `object.get` (object pattern) or `vec.get` (array pattern) per leaf
    // and binding each leaf as a `local` ScopeBinding.
    if (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) {
      if (!d.initializer) {
        demoteToLegacy(
          "module-init-legacy-coupling",
          `ir/from-ast: binding pattern requires an initializer (${cx.funcName})`,
        );
      }
      // (#3142 Slice 2) Top-level destructuring in the module-init unit:
      // the leaves are module globals on the legacy path, but the pattern
      // lowerer binds them as plain locals — demote instead of splitting
      // the storage.
      if (cx.moduleBindings) {
        const leafIsModuleBinding = (pattern: ts.BindingPattern): boolean => {
          for (const element of pattern.elements) {
            if (ts.isOmittedExpression(element)) continue;
            if (ts.isIdentifier(element.name)) {
              if (cx.moduleBindings!.has(element.name.text)) return true;
            } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
              if (leafIsModuleBinding(element.name)) return true;
            }
          }
          return false;
        };
        if (leafIsModuleBinding(d.name)) {
          demoteToLegacy(
            "module-init-legacy-coupling",
            `ir/from-ast: module-level destructuring declaration not in module-init Slice 2 scope (${cx.funcName})`,
          );
        }
      }
      // Hint: pass an externref so the initializer's actual IrType (object,
      // class, vec ref, etc.) flows through unchanged. The pattern lowerer
      // dispatches on the inferred IrType.
      const initValue = lowerExpr(d.initializer, cx, irVal({ kind: "externref" }));
      lowerBindingPattern(d.name, initValue, cx);
      continue;
    }
    if (!ts.isIdentifier(d.name)) {
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: destructuring declarations not supported in Phase 1 (${cx.funcName})`,
      );
    }
    const name = d.name.text;
    if (cx.scope.has(name)) {
      demoteToLegacy("body-shape-rejected", `ir/from-ast: redeclaration of '${name}' in ${cx.funcName}`);
    }
    if (!d.initializer) {
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: Phase 1 requires an initializer for '${name}' in ${cx.funcName}`,
      );
    }
    if (
      ts.isClassExpression(d.initializer) &&
      isConst &&
      boundedPreparedNestedOrdinaryClassBindingName(d.initializer) === name &&
      cx.classShapes?.has(name)
    ) {
      // Selection proved the class definition inert and the exact Program ABI
      // component already installed every constructor/method body. The class
      // binding is a compile-time constructor identity in this bounded family.
      continue;
    }
    // (#3142 Slice 2) A module-scope binding initialized with a
    // function-like value: the legacy path stores its closure where other
    // functions can reach it (closureMap / the `__mod_<name>` global), and
    // the IR closure binding below would keep it purely local to the init
    // body — the observable storage would never be written. Demote.
    const moduleBinding = cx.moduleBindings?.get(name);
    if (moduleBinding) requireMatchingModuleBindingOwner(moduleBinding, cx.ownerUnitId, cx.funcName);
    if (moduleBinding && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
      demoteToLegacy(
        "module-init-legacy-coupling",
        `ir/from-ast: module-level closure binding '${name}' not in module-init Slice 2 scope (${cx.funcName})`,
      );
    }
    // Slice 3 (#1169c): closure-literal initializer. Lifted to a
    // top-level IR function and bound in scope as an IrType.closure
    // value (so `lowerCall` dispatches via `closure.call`).
    if (isConst && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
      const value = lowerClosureExpression(d.initializer, cx);
      cx.scope.set(name, { kind: "local", value, type: cx.builder.typeOf(value) });
      continue;
    }
    // Slice 2 (#1169b): non-primitive type annotations on locals
    // (TypeLiteral / TypeReference) can't be resolved to an IrType
    // here without a TS checker. Defer those to inference from the
    // initializer — `typeNodeToIr` only fires for primitive type
    // keywords; everything else falls through to inference.
    let annotated =
      d.type && isPrimitiveTypeNode(d.type) ? typeNodeToIr(d.type, `local ${name} of ${cx.funcName}`) : undefined;
    // (#2856) `number[]` annotation → resolve the f64-element vec and use its
    // struct ref as the annotated type. This is what gives an EMPTY literal
    // initializer (`const arr: number[] = []`) the vec-typed hint
    // `lowerArrayLiteral` needs to type its `vec.new_fixed`. Parity: the
    // selector's `isPhase1TypeNode` accepts exactly this shape (ArrayTypeNode
    // with a NumberKeyword element), so every claim reaches a hint here. A
    // resolver that can't register the vec throws → clean demote to legacy.
    if (annotated === undefined && d.type && ts.isArrayTypeNode(d.type)) {
      // (#3734) An ANNOTATED `const arr: number[] = []` reaches the vec type
      // through this arm, not through the inference arm below — so the i32
      // element narrowing has to be consulted here too, or the exact shape the
      // landing-page `array.ts` benchmark uses would never narrow.
      const elementValType = annotatedArrayElementValType(d, cx);
      const vec = cx.resolver?.resolveVecForElement?.(elementValType);
      if (!vec) {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: resolver cannot register vec for number[] annotation on '${name}' (${cx.funcName})`,
        );
      }
      annotated = irVec(irVal(elementValType), true);
    }
    let inferredEmptyArrayHint: IrType | undefined;
    if (annotated === undefined && ts.isArrayLiteralExpression(d.initializer) && d.initializer.elements.length === 0) {
      const inference = cx.emptyArrayInference.resultForLiteral(d.initializer);
      if (inference?.kind === "rejected") {
        demoteToLegacy("body-shape-rejected", emptyArrayInferenceDiagnostic(inference, cx.funcName));
      }
      if (inference?.kind === "resolved") {
        const elementValType = emptyLiteralElementValType(d.initializer, cx);
        const vec = cx.resolver?.resolveVecForElement?.(elementValType);
        if (!vec) {
          demoteToLegacy(
            "body-shape-rejected",
            `ir/from-ast: resolver cannot register inferred number[] vec for '${name}' (${cx.funcName})`,
          );
        }
        inferredEmptyArrayHint = irVec(irVal(elementValType), true);
      }
    }
    // (#3142 Slice 2) A module binding's hint is its GLOBAL's type — the
    // storage slot is fixed by the legacy allocation, so the initializer
    // must land on exactly that representation (checked below).
    // (#3741) Native-i32 slot storage. Decided BEFORE the initializer is
    // lowered — lowering it twice (once f64 for the proof gates, once i32 for
    // the slot) would double-evaluate any side effect in `let s = f() | 0`.
    // Every other hint source wins: an explicit annotation, an empty-array
    // inference and a module binding each pin the representation.
    const widenDynamic = cx.dynamicStringLocals.has(name) || moduleBinding?.type.kind === "dynamic";
    const promoteI32Slot =
      annotated === undefined &&
      inferredEmptyArrayHint === undefined &&
      moduleBinding === undefined &&
      !widenDynamic &&
      !isConst &&
      cx.mutatedLets.has(name) &&
      cx.i32Slots?.has(d) === true &&
      d.initializer !== undefined &&
      isCanonI32Lowerable(d.initializer, promotedI32Probe(cx));
    const hint: IrType =
      annotated ??
      inferredEmptyArrayHint ??
      moduleBinding?.type ??
      (widenDynamic ? irDynamic() : promoteI32Slot ? IR_I32 : irVal({ kind: "f64" }));
    let value = promoteI32Slot
      ? lowerAsI32(d.initializer as ts.Expression, cx, "canon")
      : lowerExpr(d.initializer, cx, hint);
    if (widenDynamic && cx.builder.typeOf(value).kind !== "dynamic") {
      const boxed = boxConcreteToDynamic(value, cx.builder.typeOf(value), d.initializer, cx);
      if (boxed === null) {
        throw new IrUnsupportedError(
          "operand-coercion-unsupported",
          "build",
          `ir/from-ast: proven dynamic binding '${name}' initializer has no supported carrier (${cx.funcName})`,
        );
      }
      value = boxed;
    }
    const inferred = cx.builder.typeOf(value);
    const stringEncoding = inferred.kind === "string" ? inferStringEncoding(d.initializer, cx) : undefined;
    if (annotated) {
      // Slice 1 (#1169a): the IrType discriminator includes a `string` arm
      // alongside `val`, so use `irTypeEquals` for a structural match
      // rather than `asVal`-only kind comparison (which silently drops
      // the string case).
      if (!irTypeAssignable(inferred, annotated)) {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: local '${name}' annotated as ${describeIrType(annotated)} but initializer is ${describeIrType(inferred)} in ${cx.funcName}`,
        );
      }
    }
    // #2782 (hybrid Row 5) + #2790 (i32 arm) — no-box NUMBER-local proof gate.
    // The bindings below keep an `f64` / `i32`-typed local UNBOXED (as a `local`
    // SSA value or a numeric `slot`). Per the Hybrid Invariant that no-box
    // specialization must be discharged by a proof on the TS *type*, never the
    // lowered Wasm kind: `number` / `boolean` / `symbol` all collapse to `f64` /
    // `i32`, so the kind alone cannot tell a genuine numeric local from an `any`
    // / union one a scalar hint coerced opaquely. Prove the local's TS type is a
    // pure number — or (i32 only, #2790) a pure `boolean`, the other sound
    // tag-determinable i32 brand that boxes via `__box_boolean` (#2785) —
    // (`proveUnboxedNumberLocal`, reusing #2781's `classifyPrimitiveProof`);
    // anything unprovable — `any` / `unknown` / a MIXED `number | string` union —
    // demotes to the SAFE boxed legacy lowering (which carries the dynamic tag).
    // No checker → unchanged (#2780 / #2781's no-checker arm). `inferred` is the
    // bound representation here (an `annotated` mismatch already threw above),
    // and `d.name` is an Identifier (non-identifier decls threw earlier).
    const scalarVecValue =
      cx.resolver?.isVecValueExpression?.(d.initializer) === true ||
      cx.emptyArrayInference.isResolvedVectorExpression(d.initializer);
    // A checker-certified Date snapshot is deliberately carried as raw f64
    // milliseconds. The snapshot resolver proves this exact `const` has no
    // aliases, writes, escapes, or uses outside the three supported getters,
    // so it has a closed representation contract even though its TS type is
    // `Date`, not `number`. Keep the general scalar proof gate for every other
    // f64 local.
    const hostDateSnapshotCarrier =
      ts.isNewExpression(d.initializer) && cx.hostDateSnapshots?.has(d.initializer) === true;
    if (!scalarVecValue && !hostDateSnapshotCarrier && !proveUnboxedNumberLocal(d, inferred, cx)) {
      const boundKind = asVal(inferred)?.kind === "i32" ? "i32" : "f64";
      // (#3784) Typed `unsupported`, never a plain `Error` — an untyped throw is
      // classified `invariant` and hard-fails, defeating the demotion below.
      throw new IrUnsupportedError(
        "unboxed-number-local-unprovable",
        "build",
        `ir/from-ast: local '${name}' is bound as an unboxed ${boundKind} but its TS type is not ` +
          `provably a pure number${boundKind === "i32" ? " or boolean" : ""} — keeping the no-box ` +
          `number representation is unsound (the ${boundKind} Wasm kind conflates number / boolean / ` +
          `any); demote to the SAFE boxed legacy lowering in ${cx.funcName} (#2782/#2790)`,
      );
    }
    // (#3142 Slice 2) Module-scope binding: write the legacy-allocated
    // `__mod_<name>` global (symbolic ref — the lowerer's `resolveGlobal`
    // maps it to the concrete index) and bind as `moduleGlobal` so body
    // reads/writes route through global.get/set. Mutation needs no slot —
    // the global IS the mutable storage. Mirrors legacy `emitTdzInit`: when
    // a TDZ flag global exists for the name, set it to 1 AFTER the value
    // write so cross-function TDZ checks observe initialization.
    if (moduleBinding) {
      if (!moduleStorageCompatible(inferred, moduleBinding.type)) {
        demoteToLegacy(
          "module-init-legacy-coupling",
          `ir/from-ast: module binding '${name}' initializer is ${describeIrType(inferred)} but its global is ` +
            `${describeIrType(moduleBinding.type)} in ${cx.funcName}`,
        );
      }
      cx.builder.emitGlobalSet(moduleBinding.globalRef, value);
      if (moduleBinding.tdzGlobalRef) {
        const one = cx.builder.emitConst({ kind: "i32", value: 1 }, irVal({ kind: "i32" }));
        cx.builder.emitGlobalSet(moduleBinding.tdzGlobalRef, one);
      }
      cx.scope.set(name, {
        kind: "moduleGlobal",
        globalRef: moduleBinding.globalRef,
        type: moduleBinding.type,
        ...(stringEncoding ? { stringEncoding } : {}),
      });
      continue;
    }
    // Slice 6 part 2 (#1181): mutable `let` bindings whose name is
    // reassigned anywhere in the function body bind as a `slot`
    // ScopeBinding instead of `local`. The slot is a Wasm-local that
    // survives across for-of iterations, and reads/writes go through
    // `slot.read` / `slot.write` instead of carrying the SSA value
    // through the scope.
    //
    // Logical string, dynamic, and vector values use resolver-selected
    // backend storage while identifier reads retain their logical IR type.
    if (!isConst && cx.mutatedLets.has(name)) {
      const logicalType = inferred.kind === "dynamic" && widenDynamic ? irDynamic() : inferred;
      const representation = resolveIrSlotRepresentation(logicalType, cx.resolver, cx.funcName);
      if (representation) {
        const slotIndex = cx.builder.declareSlot(name, representation.storageType);
        cx.builder.emitSlotWrite(slotIndex, value);
        if (promoteI32Slot) {
          // (#3741) The Wasm slot is i32; the BINDING's logical type stays f64
          // so every identifier read produces the same f64-typed SSA value it
          // did before the promotion (invariant R — `readPromotedI32Slot`).
          cx.scope.set(name, { kind: "slot", slotIndex, type: IR_F64, i32Storage: true });
          continue;
        }
        cx.scope.set(name, {
          kind: "slot",
          slotIndex,
          type: representation.bindingType,
          ...(representation.asType ? { asType: representation.asType } : {}),
          ...(stringEncoding ? { stringEncoding } : {}),
        });
        continue;
      }
      // Fall through only for representations without a concrete ValType.
      // A later assignment then remains an invariant: the mutation pre-pass
      // promised that every mutable binding with a slot representation was
      // materialized above.
    }
    cx.scope.set(name, { kind: "local", value, type: inferred, ...(stringEncoding ? { stringEncoding } : {}) });
  }
}

// ---------------------------------------------------------------------------
// Binding pattern lowering (slice 8a — #1169g)
// ---------------------------------------------------------------------------
//
// Destructuring patterns decompose at compile time into a sequence of
// single-name bindings. Object pattern leaves emit `object.get`; array
// pattern leaves emit `vec.get` (when the source is a vec ref).
//
// Slice 8a scope: identifier-leaf, no-default, no-rest, no-nested patterns.
// Anything wider is rejected by the selector and stays on the legacy
// destructuring path. Mixed array/object patterns over generic iterables
// (Map, Set) require iter.next protocol and are deferred to slice 8b.
//
// Why hint with externref for the initializer in `lowerVarDecl`? The
// pattern's source type isn't known until lowering — it could be
// IrType.object, IrType.class (for class instances treated like objects
// — out of scope), or `(ref $vec_*)`. The externref hint is advisory;
// `lowerExpr`'s producers inspect their own type rather than coercing
// to the hint, so an object literal stays IrType.object and a vec ref
// stays `(ref $vec_*)`.

/**
 * Slice 8a (#1169g): walk a destructuring binding pattern and emit one
 * field/index read per leaf, binding each name as a `local` ScopeBinding.
 *
 * The source SSA value is read once per leaf. The IR's CSE / DCE passes
 * coalesce repeated reads when safe; even without that, struct.get and
 * array.get are pure ops cheap enough that a single-store tee isn't
 * required for correctness.
 */
function lowerBindingPattern(pattern: ts.BindingPattern, source: IrValueId, cx: LowerCtx): void {
  if (ts.isObjectBindingPattern(pattern)) {
    lowerObjectPattern(pattern, source, cx);
    return;
  }
  lowerArrayPattern(pattern, source, cx);
}

/**
 * Slice 8a (#1169g): decompose `const { a, b: x } = obj` into per-leaf
 * `object.get` reads. The source must lower to an IrType.object; class
 * instances and externref-typed sources fall through to a clean throw,
 * landing the function back on legacy.
 */
function lowerObjectPattern(pattern: ts.ObjectBindingPattern, source: IrValueId, cx: LowerCtx): void {
  const sourceType = cx.builder.typeOf(source);
  // #1372 — destructuring a class instance ({ x, y }: Vec2) is identical at
  // the IR level to destructuring an object literal: each leaf reads one
  // named field. The only difference is the emit op (class.get vs object.get).
  if (sourceType.kind !== "object" && sourceType.kind !== "class") {
    demoteToLegacy(
      "destructuring-param-complex",
      `ir/from-ast: object destructuring source must be IrType.object or IrType.class (got ${describeIrType(sourceType)}) in ${cx.funcName}`,
    );
  }
  for (const elem of pattern.elements) {
    // Selector enforces no rest / no default / identifier-leaf only;
    // defensive checks here surface selector regressions as clean throws
    // rather than silent miscompiles.
    if (elem.dotDotDotToken) {
      demoteToLegacy(
        "destructuring-param-complex",
        `ir/from-ast: object rest pattern not in slice 8a (${cx.funcName})`,
      );
    }
    if (elem.initializer) {
      demoteToLegacy(
        "destructuring-param-complex",
        `ir/from-ast: pattern default values not in slice 8a (${cx.funcName})`,
      );
    }
    if (!ts.isIdentifier(elem.name)) {
      demoteToLegacy(
        "destructuring-param-complex",
        `ir/from-ast: nested binding patterns not in slice 8a (${cx.funcName})`,
      );
    }
    // The property name being read out of the source. `propertyName`
    // is set when the pattern uses renaming (`{ a: x }` — propName is
    // "a", localName is "x"); shorthand patterns leave it null.
    const propName = elem.propertyName
      ? ts.isIdentifier(elem.propertyName)
        ? elem.propertyName.text
        : ts.isStringLiteral(elem.propertyName)
          ? elem.propertyName.text
          : null
      : elem.name.text;
    if (propName === null) {
      demoteToLegacy(
        "destructuring-param-complex",
        `ir/from-ast: object pattern property name must be Identifier or StringLiteral (${cx.funcName})`,
      );
    }
    const localName = elem.name.text;
    if (cx.scope.has(localName)) {
      demoteToLegacy(
        "destructuring-param-complex",
        `ir/from-ast: redeclaration of '${localName}' in pattern in ${cx.funcName}`,
      );
    }
    const field = sourceType.shape.fields.find((f) => f.name === propName);
    if (!field) {
      demoteToLegacy(
        "destructuring-param-complex",
        `ir/from-ast: object pattern reads unknown field "${propName}" (shape: ${describeIrType(sourceType)}) in ${cx.funcName}`,
      );
    }
    const v =
      sourceType.kind === "class"
        ? cx.builder.emitClassGet(source, propName, field.type)
        : cx.builder.emitObjectGet(source, propName, field.type);
    cx.scope.set(localName, { kind: "local", value: v, type: field.type });
  }
}

/**
 * Slice 8a (#1169g): decompose `const [x, y, z] = arr` into per-index
 * `vec.get` reads on a vec source. `vec.get` traps on out-of-bounds at
 * runtime — same semantics as legacy destructuring's array path
 * (legacy uses array.get without a bounds check too).
 *
 * The source must lower to a `(ref|ref_null) $vec_*` IrType.val. Anything
 * else (string, externref, class) routes to legacy via a clean throw.
 */
function lowerArrayPattern(pattern: ts.ArrayBindingPattern, source: IrValueId, cx: LowerCtx): void {
  const sourceType = cx.builder.typeOf(source);
  const resolved = resolveIrVecType(sourceType, cx);
  if (!resolved) {
    demoteToLegacy(
      "array-representation-unsupported",
      `ir/from-ast: array destructuring source is not a recognisable vec (${describeIrType(sourceType)}) in ${cx.funcName}`,
    );
  }
  const elemIrType = resolved.elementType;

  let i = 0;
  for (const elem of pattern.elements) {
    if (ts.isOmittedExpression(elem)) {
      i++;
      continue;
    }
    if (elem.dotDotDotToken) {
      demoteToLegacy(
        "array-representation-unsupported",
        `ir/from-ast: array rest pattern not in slice 8a (${cx.funcName})`,
      );
    }
    if (elem.initializer) {
      demoteToLegacy(
        "array-representation-unsupported",
        `ir/from-ast: pattern default values not in slice 8a (${cx.funcName})`,
      );
    }
    if (!ts.isIdentifier(elem.name)) {
      demoteToLegacy(
        "array-representation-unsupported",
        `ir/from-ast: nested binding patterns not in slice 8a (${cx.funcName})`,
      );
    }
    const localName = elem.name.text;
    if (cx.scope.has(localName)) {
      demoteToLegacy(
        "array-representation-unsupported",
        `ir/from-ast: redeclaration of '${localName}' in pattern in ${cx.funcName}`,
      );
    }
    const idx = cx.builder.emitConst({ kind: "i32", value: i }, irVal({ kind: "i32" }));
    const v = cx.builder.emitVecGet(source, idx, elemIrType);
    cx.scope.set(localName, { kind: "local", value: v, type: elemIrType });
    i++;
  }
}

// #2956 L1: exported so the linear IR driver (backend/linear-integration.ts)
// can pre-seed `calleeTypes` from ANNOTATIONS with the exact same primitive
// mapping this builder uses for its own params (self/mutual recursion needs
// the callee signature before the callee has built). Export is additive —
// no behavior change.
export function typeNodeToIr(node: ts.TypeNode | undefined, where: string): IrType {
  if (!node) demoteToLegacy("type-resolution-unsupported", `ir/from-ast: missing type annotation (${where})`);
  switch (node.kind) {
    case ts.SyntaxKind.NumberKeyword:
      return irVal({ kind: "f64" });
    case ts.SyntaxKind.BooleanKeyword:
      return irVal({ kind: "i32", boolean: true });
    case ts.SyntaxKind.StringKeyword:
      return { kind: "string" };
    default:
      demoteToLegacy("type-resolution-unsupported", `ir/from-ast: unsupported type in Phase 1 (${where})`);
  }
}

/**
 * Quick predicate: does this TypeNode resolve to a primitive IrType
 * without needing a TS checker? Used by `lowerVarDecl` and
 * `resolveIrType` to decide whether to consult the override map.
 */
function isPrimitiveTypeNode(node: ts.TypeNode): boolean {
  return (
    node.kind === ts.SyntaxKind.NumberKeyword ||
    node.kind === ts.SyntaxKind.BooleanKeyword ||
    node.kind === ts.SyntaxKind.StringKeyword
  );
}

/**
 * (#3673) Bridge a plain numeric SSA value to a plain numeric target type.
 *
 * A native type annotation (`pos: i32`, `#323`) makes a class field or a local
 * a Wasm `i32` while the surrounding JS-typed expressions still produce `f64`.
 * `this.pos = 0` therefore hands an `f64` const to an `i32` field, which the
 * assignment sites used to reject outright — so an `i32`-annotated class threw
 * out of `from-ast` and (under the #2138 IR-first gate) failed the compile.
 *
 * This inserts exactly the conversion the LEGACY path inserts at the same seam
 * (`coerceType` in `codegen/type-coercion.ts`): saturating truncation when
 * narrowing, signed/unsigned widening when widening. It deliberately handles
 * ONLY unbranded i32/f32/f64 scalars — a `boolean`/`symbol`-branded i32 keeps
 * its brand-specific boxing rules and must not be silently reinterpreted, and
 * every non-`val` type (string/object/closure/…) still falls through to the
 * caller's mismatch error.
 *
 * Returns `null` when no sound conversion applies, so callers keep their
 * existing "reject and fall back" behaviour.
 */
function coerceIrNumeric(value: IrValueId, target: IrType, cx: LowerCtx): IrValueId | null {
  const from = cx.builder.typeOf(value);
  if (from.kind !== "val" || target.kind !== "val") return null;
  const f = from.val;
  const t = target.val;
  // Brands are load-bearing at the box seam — never coerce across them.
  if (f.kind === "i32" && (f.boolean || f.symbol)) return null;
  if (t.kind === "i32" && (t.boolean || t.symbol)) return null;
  if (f.kind === t.kind) return null; // caller's equality check already covers this
  if (f.kind === "f64" && t.kind === "i32") {
    return cx.builder.emitUnary("i32.trunc_sat_f64_s", value, irVal({ kind: "i32" }));
  }
  if (f.kind === "i32" && t.kind === "f64") {
    // `signed === false` marks the uint32 domain (#1126). Widening it needs
    // `f64.convert_i32_u`, which the IR unop set does not carry — bail rather
    // than emit the signed conversion, which would read `-1 >>> 0` back as -1
    // instead of 2^32-1 (`tests/issue-1817`).
    if (from.signed === false) return null;
    return cx.builder.emitUnary("f64.convert_i32_s", value, irVal({ kind: "f64" }));
  }
  return null;
}

/** Short debug string for IrType, used in error messages. */
function describeIrType(t: IrType): string {
  if (t.kind === "val") return t.val.kind;
  if (t.kind === "string") return "string";
  if (t.kind === "vec") return `vec<${describeIrType(t.elementType)}>${t.nullable ? "?" : ""}`;
  if (t.kind === "object") {
    return `object{${t.shape.fields.map((f) => `${f.name}:${describeIrType(f.type)}`).join(",")}}`;
  }
  if (t.kind === "closure") {
    const ps = t.signature.params.map(describeIrType).join(",");
    return `closure(${ps})->${t.signature.returnType === null ? "void" : describeIrType(t.signature.returnType)}`;
  }
  if (t.kind === "callable") {
    const ps = t.signature.params.map(describeIrType).join(",");
    return `callable(${ps})->${t.signature.returnType === null ? "void" : describeIrType(t.signature.returnType)}`;
  }
  if (t.kind === "class") return `class<${t.shape.className}>`;
  if (t.kind === "extern") return `extern<${t.className}>`;
  // #1926 — union members / boxed inner are IrTypes; recurse.
  if (t.kind === "union") return `union<${t.members.map(describeIrType).join(",")}>`;
  // #2949 — dynamic leaf; render the optional tag refinement when present.
  if (t.kind === "dynamic") return t.tag === undefined ? "dynamic" : `dynamic<tag:${t.tag}>`;
  return `boxed<${describeIrType(t.inner)}>`;
}

/**
 * Resolve the IR type for a function param or return.
 *
 * If the AST has an explicit TypeNode, it must agree with the override
 * (if any). If the AST has no TypeNode, the override is authoritative.
 * If neither is present, that's a compiler bug — the selector should not
 * have claimed this function.
 */
function resolveIrType(node: ts.TypeNode | undefined, override: IrType | undefined, where: string): IrType {
  if (node && isPrimitiveTypeNode(node)) {
    const fromNode = typeNodeToIr(node, where);
    if (override && !irTypeEquals(override, fromNode)) {
      demoteToLegacy(
        "type-resolution-unsupported",
        `ir/from-ast: type override (${describeIrType(override)}) disagrees with annotation (${describeIrType(fromNode)}) at ${where}`,
      );
    }
    return fromNode;
  }
  // Slice 2 (#1169b): non-primitive TypeNodes (TypeLiteral / TypeReference)
  // need a TS checker to resolve into an IrType.object — we don't have
  // one inside the IR layer. The caller (codegen/index.ts:resolvePositionType)
  // pre-resolves these and passes the result via `override`, so we
  // simply prefer the override here. If neither is present, the
  // selector and override builder are out of sync — that's a bug.
  if (override) return override;
  demoteToLegacy("type-resolution-unsupported", `ir/from-ast: missing type annotation and no override (${where})`);
}

/** True when two logical IR types use the same already-allocated global slot. */
function moduleStorageCompatible(actual: IrType, expected: IrType): boolean {
  if (irTypeEquals(actual, expected)) return true;
  // Dynamic tag refinements describe the value partition, not a different
  // physical carrier. A `dynamic<tag:String>` initializer and the unrefined
  // dynamic module global therefore use the same slot.
  if (actual.kind === "dynamic" && expected.kind === "dynamic") return true;
  if (expected.kind !== "extern") return false;
  if (actual.kind === "extern") return true;
  return asVal(actual)?.kind === "externref";
}

/** Emit the exact legacy module-global TDZ guard before a read or write. */
function lowerResolvedModuleBindingTdzCheck(name: string, binding: ModuleBindingGlobal, cx: LowerCtx): void {
  requireMatchingModuleBindingOwner(binding, cx.ownerUnitId, cx.funcName);
  if (binding.type.kind === "extern") {
    assertNotDeferred(
      domSurfaceCapability(cx.resolver?.jsHostExterns?.() === true, binding.capability === "dom"),
      `module-scope extern binding "${name}"`,
      cx.funcName,
    );
  }
  if (binding.tdzGlobalRef && binding.omitTdzReadCheck !== true) {
    const tdz = cx.builder.emitGlobalGet(binding.tdzGlobalRef, irVal({ kind: "i32" }));
    const cond = cx.builder.emitUnary("i32.eqz", tdz, irVal({ kind: "i32" }));
    const thenBody = cx.builder.collectBodyInstrs(() => {
      const nullExt = cx.builder.emitConst(
        { kind: "null", ty: irVal({ kind: "externref" }) },
        irVal({ kind: "externref" }),
      );
      const referenceError = cx.builder.emitCall(
        irRuntimeFuncRef("__new_ReferenceError"),
        [nullExt],
        irVal({ kind: "externref" }),
      );
      if (referenceError === null) {
        // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
        throw new Error(`ir/from-ast: ReferenceError constructor returned no value (${cx.funcName})`);
      }
      cx.builder.emitThrow(referenceError);
    });
    cx.builder.emitIfStmt({ cond, then: thenBody, else: [] });
  }
}

/** Emit the legacy module-global TDZ check followed by the symbolic read. */
function lowerResolvedModuleBindingRead(name: string, binding: ModuleBindingGlobal, cx: LowerCtx): IrValueId {
  lowerResolvedModuleBindingTdzCheck(name, binding, cx);
  return cx.builder.emitGlobalGet(binding.globalRef, binding.type);
}

function lowerHostDateSnapshotExpression(expr: ts.NewExpression, cx: LowerCtx): IrValueId | undefined {
  const plan = cx.hostDateSnapshots?.get(expr);
  if (!plan) return undefined;
  requireMatchingLoweringPlanOwner("host Date snapshot", plan.ownerUnitId, cx.ownerUnitId, cx.funcName);
  const snapshot = cx.builder.emitCall(plan.target, [], irVal({ kind: "f64" }));
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (snapshot === null) throw new Error(`ir/from-ast: host Date snapshot produced no value (${cx.funcName})`);
  return snapshot;
}

function lowerHostDateGetterCall(expr: ts.CallExpression, cx: LowerCtx): IrValueId | undefined {
  const plan = cx.hostDateGetters?.get(expr);
  if (!plan) return undefined;
  requireMatchingLoweringPlanOwner("host Date getter", plan.ownerUnitId, cx.ownerUnitId, cx.funcName);
  if (
    !ts.isPropertyAccessExpression(expr.expression) ||
    expr.expression.name.text !== plan.getter ||
    expr.arguments.length !== 0
  ) {
    // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
    throw new Error(`ir/from-ast: host Date getter plan changed shape (${cx.funcName})`);
  }
  const receiver = lowerExpr(expr.expression.expression, cx, irVal({ kind: "f64" }));
  if (asVal(cx.builder.typeOf(receiver))?.kind !== "f64") {
    // invariant (producer-promise): the carrier the producer promised was dropped — #4502.
    throw new Error(`ir/from-ast: host Date snapshot lost its f64 timestamp carrier (${cx.funcName})`);
  }
  const result = cx.builder.emitCall(
    irIntrinsicFuncRef(irDateSnapshotGetterSymbol(plan.getter)),
    [receiver],
    irVal({ kind: "f64" }),
  );
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (result === null) throw new Error(`ir/from-ast: host Date getter produced no value (${cx.funcName})`);
  return result;
}

function lowerExpr(expr: ts.Expression, cx: LowerCtx, hint: IrType): IrValueId {
  if (ts.isParenthesizedExpression(expr)) {
    return lowerExpr(expr.expression, cx, hint);
  }
  // (#3583) Type-erased assertion wrappers emit nothing at runtime, so lowering
  // is the operand's lowering under the SAME hint — the hint comes from the
  // consuming context (declared type / param ABI / return ABI), which is what
  // decides the value representation, so the asserted type cannot change the
  // emitted bytes. Paired with the matching `isPhase1Expr` arm in select.ts:
  // selector claim ⇔ lowering parity.
  if (
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    return lowerExpr(expr.expression, cx, hint);
  }
  // (#1373b C-1) `await <e>` in a claimed async body — the legacy SYNC
  // pass-through model, mirrored exactly:
  //   1. `await Promise.resolve(x)` → lower `x` (#3227 static substitution;
  //      the selector already rejected the zero-arg undefined-settle form).
  //   2. Non-externref-shaped operand (f64/i32/... — e.g. a call to another
  //      sync-model async fn, which returns raw `T` per the #1796 call-site
  //      contract) → passthrough, no await node.
  //   3. Externref-shaped operand → `await` instr; lower.ts decides per lane
  //      (native-`$Promise` carrier: one-level unwrap; JS-host: identity).
  if (ts.isAwaitExpression(expr)) {
    if (cx.funcKind !== "async") {
      demoteToLegacy("body-shape-rejected", `ir/from-ast: await outside an async function (${cx.funcName})`);
    }
    const settled = staticPromiseResolveSettledExpr(expr.expression);
    if (settled === "undefined") {
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: await Promise.resolve() (undefined settle) not in C-1 scope (${cx.funcName})`,
      );
    }
    if (settled !== null) {
      return lowerExpr(settled, cx, hint);
    }
    const operand = lowerExpr(expr.expression, cx, hint);
    const opType = cx.builder.valueType(operand);
    const opVal = opType !== undefined ? asVal(opType) : undefined;
    const externShaped =
      (opVal !== undefined && opVal !== null && opVal.kind === "externref") || opType?.kind === "extern";
    if (!externShaped) return operand;
    return cx.builder.emitAwait(operand, preparedAsyncAwaitResultType(expr.expression, cx.resolver));
  }
  if (ts.isNumericLiteral(expr)) {
    return cx.builder.emitConst({ kind: "f64", value: Number(expr.text) }, irVal({ kind: "f64" }));
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) {
    return cx.builder.emitConst({ kind: "bool", value: true }, IR_BOOL);
  }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) {
    return cx.builder.emitConst({ kind: "bool", value: false }, IR_BOOL);
  }
  // Slice 1 (#1169a) — strings, templates, typeof, .length, null-keyword.
  if (ts.isStringLiteral(expr) || expr.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
    const lit = expr as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;
    return cx.builder.emitStringConst(lit.text);
  }
  if (ts.isTemplateExpression(expr)) {
    return lowerTemplateExpression(expr, cx);
  }
  if (ts.isTypeOfExpression(expr)) {
    return lowerTypeOf(expr, cx);
  }
  if (expr.kind === ts.SyntaxKind.NullKeyword) {
    // Bare `null` composes only when the consuming context is reference-
    // shaped (externref / ref_null), because IR Phase 1 has no nullable
    // union: a `null` flowing into an f64/i32 hint would mismatch the
    // consumer's Wasm type at validation. The optional-chaining null arm
    // and the `??` lowering both pass a reference-shaped hint here.
    //
    // `=== null` / `!== null` never reach this branch — `tryFoldNullCompare`
    // intercepts them before operand recursion (the fold is purely static
    // because there's no runtime null value to compare against).
    // The null const's `ty` must be a `val`-kind externref/ref_null so the
    // lowerer emits `ref.null.extern` / `ref.null T` (see lower.ts "null").
    // An `extern` className hint is null-compatible at the Wasm level
    // (opaque externref), so we materialize a plain `externref` null for it.
    const hintVal = asVal(hint);
    if (hint.kind === "extern") {
      const ty = irVal({ kind: "externref" });
      return cx.builder.emitConst({ kind: "null", ty }, ty);
    }
    if (hintVal && (hintVal.kind === "externref" || hintVal.kind === "ref_null")) {
      return cx.builder.emitConst({ kind: "null", ty: hint }, hint);
    }
    throw new IrUnsupportedError(
      "nullish-value-unsupported",
      "build",
      `ir/from-ast: bare 'null' in non-reference context (${describeIrType(hint)}) is not supported in IR (${cx.funcName})`,
    );
  }
  if (ts.isPropertyAccessExpression(expr)) {
    return lowerPropertyAccess(expr, cx);
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return lowerObjectLiteral(expr, cx);
  }
  // #3522 returned-closure ownership. A literal produced in expression
  // position retains the internal closure carrier until an exact callable
  // boundary requests it. Function results use that boundary, so pack the
  // closure once here; local literal declarations keep the existing internal
  // carrier and avoid an externref round trip.
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    const closure = lowerClosureExpression(expr, cx);
    const closureType = cx.builder.typeOf(closure);
    if (
      hint.kind === "callable" &&
      closureType.kind === "closure" &&
      closureSignatureEquals(closureType.signature, hint.signature)
    ) {
      return cx.builder.emitCallablePack(closure, hint.signature);
    }
    return closure;
  }
  if (ts.isElementAccessExpression(expr)) {
    return lowerElementAccess(expr, cx);
  }
  // Slice 12 (#1169o) — `ArrayLiteralExpression` is selector-accepted
  // for shape but the IR doesn't yet emit `vec.new_fixed`. Throw clean
  // fallback so the enclosing function reverts to legacy. The selector
  // accepts the shape primarily so functions whose only "non-Phase-1"
  // construct is an array-literal callee argument (e.g. `f([1,2,3])`)
  // don't drop their callee from the IR claim set via the call-graph
  // closure.
  if (ts.isArrayLiteralExpression(expr)) {
    return lowerArrayLiteral(expr, cx, hint);
  }
  // #1370 Phase B: `this` reference inside an instance method body.
  // The integration loop binds `this` in scope to the synthetic
  // `__self` parameter's SSA value before lowering the body. Outside
  // of class-method bodies the keyword never enters scope, so this
  // branch only fires for IR-claimed instance methods.
  if (expr.kind === ts.SyntaxKind.ThisKeyword) {
    const p = cx.scope.get("this");
    if (!p) {
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: 'this' reference outside an instance method body (${cx.funcName})`,
      );
    }
    if (p.kind !== "local") {
      demoteToLegacy("body-shape-rejected", `ir/from-ast: unexpected 'this' binding kind ${p.kind} in ${cx.funcName}`);
    }
    return p.value;
  }
  if (ts.isIdentifier(expr)) {
    const topLevelFunction = cx.topLevelFunctionValues?.get(expr);
    if (topLevelFunction) return lowerTopLevelFunctionValue(topLevelFunction, cx);
    const p = cx.scope.get(expr.text);
    // (#2856) Host ambient global (`document`, `window`, …): not a scope
    // binding — resolves through the legacy declared-globals registry to the
    // `global_<name>` handle import, typed as the global's extern class so
    // member access on it dispatches through the extern arms. Scope bindings
    // take priority (a local named `document` shadows the global, matching
    // both JS semantics and the selector's checker-backed resolution).
    // Host-free modes register no declared globals, so this resolves nothing
    // there — and the capability gate means the selector never claims such a
    // function in those modes anyway (`assertNotDeferred` guards the
    // invariant).
    if (!p) {
      const moduleBinding = cx.resolver?.resolveModuleBinding?.(expr);
      if (moduleBinding) return lowerResolvedModuleBindingRead(expr.text, moduleBinding, cx);
      const standaloneDomGlobal = cx.resolver?.standaloneDomOperation?.(expr);
      const hg = cx.resolver?.getHostGlobalInfo?.(expr.text);
      if (standaloneDomGlobal?.kind === "global-get" && !hg) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          `ir/from-ast: certified DOM global ${expr.text} has no prepared import (${cx.funcName})`,
        );
      }
      if (hg) {
        const exactStandaloneDomGlobal =
          standaloneDomGlobal?.kind === "global-get" &&
          standaloneDomGlobal.identifier === expr &&
          standaloneDomGlobal.importName === hg.importName;
        assertNotDeferred(
          domSurfaceCapability(cx.resolver?.jsHostExterns?.() === true, exactStandaloneDomGlobal),
          `host global "${expr.text}"`,
          cx.funcName,
        );
        const r = cx.builder.emitCall(irImportFuncRef("env", hg.importName), [], {
          kind: "extern",
          className: hg.className,
        });
        if (r === null) {
          // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
          throw new Error(`ir/from-ast: host global "${expr.text}" produced no result in ${cx.funcName}`);
        }
        return r;
      }
    }
    if (!p)
      demoteToLegacy("body-shape-rejected", `ir/from-ast: identifier "${expr.text}" is not in scope in ${cx.funcName}`);
    // Slice 6 part 2 (#1181): slot-bound identifier (let mutated across
    // for-of iterations). Reads emit `slot.read`, which lowers to a
    // `local.get` on the Wasm-local slot. The slot's type is recorded
    // at declaration time so the IR result type matches.
    //
    // Slice 6 part 4 refactor (#1185): if the binding has an `asType`
    // widening, the SSA result is tagged as `asType` instead of
    // `irVal(slot.type)`. This lets native-strings string for-of
    // loop variables compose with slice-1 string ops even though the
    // underlying slot ValType is `(ref $AnyString)` rather than
    // `IrType.string`.
    if (p.kind === "slot") {
      // (#3741) invariant R — an i32-promoted slot widens on EVERY read, so
      // the SSA value handed to the consumer is f64-typed and numerically
      // identical to the pre-promotion one. Deliberately not an `asType`
      // widening: `asType` would re-tag the value the body sees.
      if (p.i32Storage) {
        return readPromotedI32Slot(p.slotIndex, cx);
      }
      if (p.asType) {
        return cx.builder.emitSlotReadAs(p.slotIndex, p.asType);
      }
      return cx.builder.emitSlotRead(p.slotIndex);
    }
    // (#3142 Slice 2) Module-scope binding inside the `<module-init>` unit:
    // reads come from the legacy-allocated global (symbolic ref).
    if (p.kind === "moduleGlobal") {
      return cx.builder.emitGlobalGet(p.globalRef, p.type);
    }
    if (p.kind === "withField") {
      return cx.builder.emitObjectGet(p.receiver, p.name, p.type);
    }
    if (p.kind !== "local") {
      // Slice 3 (#1169c): nestedFunc bindings are name-only — they have
      // no SSA value. Bare reference (without a CallExpression) cannot
      // produce an IR value. The callable form is handled by `lowerCall`.
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: bare reference to nested function "${expr.text}" not in slice 3 (${cx.funcName})`,
      );
    }
    // Slice 3 (#1169c): refcell-typed bindings need a deref on read.
    // The SSA value IS the cell ref; expression-position reads expect
    // the inner scalar.
    if (p.type.kind === "boxed") {
      return cx.builder.emitRefCellGet(p.value, p.type.inner);
    }
    return p.value;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    return lowerPrefixUnary(expr, cx);
  }
  if (ts.isBinaryExpression(expr)) {
    return lowerBinary(expr, cx, hint);
  }
  if (ts.isConditionalExpression(expr)) {
    return lowerConditional(expr, cx);
  }
  if (ts.isCallExpression(expr)) {
    const hostDateGetter = lowerHostDateGetterCall(expr, cx);
    if (hostDateGetter !== undefined) return hostDateGetter;
    const callResult = lowerCall(expr, cx);
    if (callResult === null) {
      // Unreachable: expression position (statementPosition=false) throws
      // before returning null.
      unsupportedVoidCallExpression(`ir/from-ast: void call in expression position (${cx.funcName})`);
    }
    return callResult;
  }
  // Slice 4 (#1169d): class instantiation. Lookup must succeed against
  // the class registry seeded from `ctx.classShapes`; if not, the
  // function falls back to legacy.
  // Slice 10 (#1169i): extends to host extern classes — `new RegExp(...)`,
  // `new Uint8Array(N)`, etc. Dispatch happens inside `lowerNewExpression`
  // by checking the resolver's `getExternClassInfo` before the slice-4
  // class-shape lookup.
  if (ts.isNewExpression(expr)) {
    const hostDateSnapshot = lowerHostDateSnapshotExpression(expr, cx);
    if (hostDateSnapshot !== undefined) return hostDateSnapshot;
    return lowerNewExpression(expr, cx);
  }
  // Slice 10 (#1169i): RegExp literal `/pattern/flags`. Lowers to
  // `extern.regex` which materializes the pattern + flags strings and
  // calls the `RegExp_new` host import.
  if (expr.kind === ts.SyntaxKind.RegularExpressionLiteral) {
    return lowerRegExpLiteral(expr, cx);
  }
  // Slice 11 (#1169n) — `delete <expr>`. The IR-claim shape doesn't
  // support property deletes that change runtime behavior (slice 11
  // doesn't track per-instance prop existence). Most `delete` uses
  // in IR-claimable functions delete properties that are statically
  // known to exist (so the result is `true`), or delete unresolved
  // refs (also `true`). We lower the operand for side effects (e.g.
  // `delete f().x` must still call f) and then push the constant
  // `true`.
  if (ts.isDeleteExpression(expr)) {
    // Lower operand for side effects only — the result is unused.
    // Property-access operand: lower the receiver (the .name part is
    // statically resolved, so the access itself has no runtime effect
    // on the IR-claim shape). Other operands lower via `lowerExpr`.
    if (ts.isPropertyAccessExpression(expr.expression)) {
      // Lower the receiver expression for side effects; ignore the
      // produced SSA value (DCE drops it if pure).
      void lowerExpr(expr.expression.expression, cx, irVal({ kind: "f64" }));
    } else {
      void lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
    }
    return cx.builder.emitConst({ kind: "bool", value: true }, irVal({ kind: "i32" }));
  }
  // Slice 11 (#1169n) — `void <expr>`. Lower the operand for side
  // effects, then push the IR's f64 NaN sentinel as the result. The
  // hint type drives whether downstream code treats this as f64 or
  // coerces to externref. For now, emit f64 NaN (the closest scalar
  // approximation of `undefined` in numeric context). Functions that
  // use `void` outside f64 context will need a future widening to
  // emit a proper undefined-typed value; for slice 11, throw if the
  // operand context demands a non-f64 result.
  if (ts.isVoidExpression(expr)) {
    lowerDiscardedExpression(expr.expression, cx);
    return cx.builder.emitConst({ kind: "f64", value: NaN }, irVal({ kind: "f64" }));
  }
  demoteToLegacy(
    "body-shape-rejected",
    `ir/from-ast: unsupported expression kind ${ts.SyntaxKind[expr.kind]} in ${cx.funcName}`,
  );
}

/**
 * #2780 (hybrid Row 6) — the widening-escape proof for the ArrayLiteral fast
 * path. Returns `true` when the literal's result flows into a sink that demands a
 * WIDER / heterogeneous element type than the homogeneous NARROW vec
 * `vec.new_fixed` would build — `any[]` / `unknown[]` / a heterogeneous-union
 * element, or a bare `any` / `unknown` slot. In that case the packed fast path is
 * UNSOUND: a `vec<f64>` (etc.) handed to an `any`-typed alias could later receive
 * a string/object element the packed vec cannot hold (e.g. `const a: any[] =
 * [1,2,3]; a[0] = "x"`). When it returns `true`, codegen must fall to the SAFE
 * legacy lowering, which boxes each element to the dynamic externref
 * representation.
 *
 * This is a **local** proof (the Hybrid-Invariant point of Row 6): it inspects
 * only the literal's own TS contextual type — no whole-function dataflow. The
 * fresh allocation is decidable from the sink type at this single site.
 *
 * The comparison reads the TS **type** (`TypeFlags`), never the Wasm ValType
 * kind: `number[]`, `boolean[]` and `symbol[]` all collapse to the same element
 * ValType (f64 / i32 / i32) — keying on the kind would misclassify a
 * boolean-vs-number sink. Note the TS gotcha that the intrinsic `boolean` type is
 * internally the union `true | false`, so `isUnion()` is `true` for it; it is
 * excluded via the `Boolean` flag so `boolean[]` stays on the fast path, while a
 * genuine heterogeneous union (`string | number`) — which does not carry that
 * flag — is correctly treated as a widening.
 *
 * Structural-supertype scalar sinks (`{}[]`, `object[]`) are intentionally NOT
 * flagged here — Row 6 scopes to `any` / `unknown` / heterogeneous sinks, and
 * those residuals stay covered by the existing downstream `irTypeEquals` net
 * (a wider-typed write demotes the function to legacy), exactly as today.
 */
function arrayLiteralWideningEscapes(expr: ts.ArrayLiteralExpression, cx: LowerCtx): boolean {
  const checker = cx.checker;
  // No checker → cannot prove a sink at this site. The existing element-type
  // (`irTypeEquals`) checks here plus the downstream demotion net still guard
  // correctness, so keep the fast path (HI: a missing proof is not a license to
  // miscompile — there is no narrow-vec build whose escape we are masking,
  // because every boundary use is still type-checked).
  if (!checker) return false;
  const ctxType = checker.getContextualType(expr);
  if (!ctxType) return false; // consumed at its own narrow type → no widening at this site.
  // A bare `any` / `unknown` slot (e.g. `const a: any = [1,2,3]`): the literal
  // escapes into a fully dynamic value.
  if (ctxType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  // Array / tuple sink: inspect the element type the sink demands.
  const ctxElem = ctxType.getNumberIndexType();
  if (!ctxElem) return false; // non-indexable concrete sink → no array widening here.
  if (ctxElem.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true; // any[] / unknown[].
  // Heterogeneous element union (`(number | string)[]`) the packed vec cannot
  // hold — but NOT the intrinsic `boolean` (= `true | false`) which is uniform.
  if (ctxElem.isUnion() && !(ctxElem.flags & ts.TypeFlags.Boolean)) return true;
  return false;
}

function isPureDenseFillRhs(expr: ts.Expression, arrayName: string): boolean {
  if (ts.isParenthesizedExpression(expr)) return isPureDenseFillRhs(expr.expression, arrayName);
  if (
    ts.isNumericLiteral(expr) ||
    ts.isStringLiteral(expr) ||
    expr.kind === ts.SyntaxKind.TrueKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    expr.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(expr)) return expr.text !== arrayName;
  if (ts.isPrefixUnaryExpression(expr)) {
    return (
      (expr.operator === ts.SyntaxKind.PlusToken ||
        expr.operator === ts.SyntaxKind.MinusToken ||
        expr.operator === ts.SyntaxKind.TildeToken ||
        expr.operator === ts.SyntaxKind.ExclamationToken) &&
      isPureDenseFillRhs(expr.operand, arrayName)
    );
  }
  if (!ts.isBinaryExpression(expr)) return false;
  const operator = expr.operatorToken.kind;
  if (operator >= ts.SyntaxKind.FirstAssignment && operator <= ts.SyntaxKind.LastAssignment) return false;
  if (operator === ts.SyntaxKind.CommaToken) return false;
  return isPureDenseFillRhs(expr.left, arrayName) && isPureDenseFillRhs(expr.right, arrayName);
}

interface DenseFillPlan {
  readonly arrayName: string;
  readonly indexName: string;
  readonly bound: ts.Expression;
  readonly loop: ts.ForStatement;
}

function denseFillPlanForLiteral(expr: ts.ArrayLiteralExpression): DenseFillPlan | null {
  // The direct-store optimization relies on the empty-literal allocation arm
  // reserving the loop bound as backing capacity and publishing that bound as
  // the final length. A non-empty literal keeps its fixed initial capacity and
  // length, so its indexed writes must retain the grow-and-length helper.
  if (expr.elements.length !== 0) return null;
  const declaration = expr.parent;
  if (!ts.isVariableDeclaration(declaration) || !ts.isIdentifier(declaration.name)) return null;
  const declarationList = declaration.parent;
  const declarationStatement = declarationList.parent;
  const block = declarationStatement.parent;
  if (
    !ts.isVariableDeclarationList(declarationList) ||
    !ts.isVariableStatement(declarationStatement) ||
    (!ts.isBlock(block) && !ts.isSourceFile(block))
  ) {
    return null;
  }
  const statements = block.statements;
  const statementIndex = statements.indexOf(declarationStatement);
  const loop = statements[statementIndex + 1];
  if (statementIndex < 0 || !loop || !ts.isForStatement(loop)) return null;

  const initializer = loop.initializer;
  if (!initializer || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) return null;
  const indexDeclaration = initializer.declarations[0];
  if (
    !ts.isIdentifier(indexDeclaration.name) ||
    !indexDeclaration.initializer ||
    !ts.isNumericLiteral(indexDeclaration.initializer) ||
    Number(indexDeclaration.initializer.text) !== 0
  ) {
    return null;
  }
  const indexName = indexDeclaration.name.text;
  const condition = loop.condition;
  if (
    !condition ||
    !ts.isBinaryExpression(condition) ||
    condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
    !ts.isIdentifier(condition.left) ||
    condition.left.text !== indexName ||
    (!ts.isIdentifier(condition.right) && !ts.isNumericLiteral(condition.right))
  ) {
    return null;
  }
  const incrementor = loop.incrementor;
  if (
    !incrementor ||
    (!ts.isPrefixUnaryExpression(incrementor) && !ts.isPostfixUnaryExpression(incrementor)) ||
    incrementor.operator !== ts.SyntaxKind.PlusPlusToken ||
    !ts.isIdentifier(incrementor.operand) ||
    incrementor.operand.text !== indexName
  ) {
    return null;
  }
  const loopStatements = ts.isBlock(loop.statement) ? loop.statement.statements : [loop.statement];
  if (loopStatements.length !== 1 || !ts.isExpressionStatement(loopStatements[0])) return null;
  const assignment = loopStatements[0].expression;
  const arrayName = declaration.name.text;
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isElementAccessExpression(assignment.left) ||
    !ts.isIdentifier(assignment.left.expression) ||
    assignment.left.expression.text !== arrayName ||
    !ts.isIdentifier(assignment.left.argumentExpression) ||
    assignment.left.argumentExpression.text !== indexName ||
    !isPureDenseFillRhs(assignment.right, arrayName)
  ) {
    return null;
  }
  return { arrayName, indexName, bound: condition.right, loop };
}

function denseFillPlanForLoop(loop: ts.ForStatement): DenseFillPlan | null {
  const parent = loop.parent;
  if (!ts.isBlock(parent) && !ts.isSourceFile(parent)) return null;
  const loopIndex = parent.statements.indexOf(loop);
  const previous = parent.statements[loopIndex - 1];
  if (
    loopIndex < 1 ||
    !previous ||
    !ts.isVariableStatement(previous) ||
    previous.declarationList.declarations.length !== 1
  ) {
    return null;
  }
  const initializer = previous.declarationList.declarations[0].initializer;
  return initializer && ts.isArrayLiteralExpression(initializer) ? denseFillPlanForLiteral(initializer) : null;
}

/**
 * #1804 — lower a fixed-length, non-spread, non-sparse, same-typed array
 * literal to a `vec.new_fixed` IR node. Out of scope (clean fallback to
 * legacy): spread elements (`[...xs]`), elision holes (`[1, , 3]`), mixed
 * element types, and empty literals with no usable element-type hint.
 *
 * Element type resolution: prefer the `hint` (a vec ref whose element IrType
 * the resolver can recover) — covers `const a: number[] = [1,2,3]` and the
 * empty `const a: number[] = []`; otherwise infer from the first element and
 * require every element to share that IrType.
 *
 * #2780 (hybrid Row 6) — before the fast `vec.new_fixed`, discharge the
 * widening-escape proof (`arrayLiteralWideningEscapes`): the packed narrow vec is
 * only sound when the literal does NOT flow into an `any` / `unknown` /
 * heterogeneous sink. When it does, demote to the SAFE legacy lowering (which
 * boxes each element) — this mirrors #2766's prove-then-specialize shape.
 */
function lowerArrayLiteral(expr: ts.ArrayLiteralExpression, cx: LowerCtx, hint: IrType): IrValueId {
  // Elision stays out of scope. Spread is adopted (#4487) only for operands
  // whose element count is provable at compile time — see
  // `planArrayLiteralSpread`; a `null` plan means at least one operand needs a
  // runtime-sized allocation, which `vec.new_fixed` cannot express.
  const spreadPlan = expr.elements.some((el) => ts.isSpreadElement(el)) ? planArrayLiteralSpread(expr) : null;
  for (const el of expr.elements) {
    // (#4502) Both arms are capability gaps — legal array literals the IR
    // cannot express with `vec.new_fixed` — so they demote rather than
    // hard-failing the claimed unit. #4487 introduced the split (elision vs.
    // a spread with no statically provable length) while the #4502 sweep was
    // in flight; the merge keeps #4487's control flow and #4502's typing.
    if (ts.isOmittedExpression(el)) {
      demoteToLegacy(
        "array-representation-unsupported",
        `ir/from-ast: array literal with elision not in #1804 scope (${cx.funcName})`,
      );
    }
    if (ts.isSpreadElement(el) && spreadPlan?.has(el) !== true) {
      demoteToLegacy(
        "array-representation-unsupported",
        `ir/from-ast: array literal spread source has no static length (${cx.funcName})`,
      );
    }
  }

  // Recover an element IrType from the hint when it is (or wraps) a vec ref.
  const hintVec = resolveIrVecType(hint, cx);
  const hintElemIr = hintVec?.elementType ?? null;

  if (expr.elements.length === 0) {
    // Empty literal — element type must come from the hint.
    if (!hintElemIr) {
      demoteToLegacy(
        "array-representation-unsupported",
        `ir/from-ast: empty array literal needs a vec-typed hint to infer element type (${cx.funcName})`,
      );
    }
    const elemVT = asVal(hintElemIr)!;
    const vec = cx.resolver?.resolveVecForElement?.(elemVT);
    if (!vec) {
      demoteToLegacy(
        "array-representation-unsupported",
        `ir/from-ast: resolver cannot register vec for empty literal (${cx.funcName})`,
      );
    }
    const vecValueType =
      cx.resolver?.resolveVecValueTypeForElement?.(elemVT) ??
      vec.valueType ??
      ({ kind: "ref", typeIdx: vec.vecStructTypeIdx } as ValType);
    const vecResultType = hint.kind === "vec" ? irVec(hintElemIr, false) : irVal(vecValueType);
    const countedPush = canonicalCountedPushPlanForLiteral(expr, cx.checker);
    if (countedPush) {
      return cx.builder.emitVecNewFixed([], hintElemIr, vecResultType, countedPush.capacity);
    }
    const denseFill = denseFillPlanForLiteral(expr);
    if (denseFill && vecValueType.kind !== "i32") {
      const bound = lowerExpr(denseFill.bound, cx, irVal({ kind: "f64" }));
      const allocated = cx.builder.emitCall(
        irIntrinsicFuncRef(vecNewSizedProviderSymbol(hint, vec)),
        [bound],
        vecResultType,
      );
      if (allocated === null) {
        // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
        throw new Error(`ir/from-ast: sized vec allocation produced no result (${cx.funcName})`);
      }
      return allocated;
    }
    return cx.builder.emitVecNewFixed([], hintElemIr, vecResultType);
  }

  // #2780 (hybrid Row 6) — widening-escape proof, the PRIMARY HI gate (run
  // before element lowering, mirroring #2766's prove-then-specialize: prove the
  // specialization is sound, else fall to the SAFE path). `vec.new_fixed` builds
  // a homogeneous NARROW vec (`vec<f64>` / `vec<i32>` / …). That specialization
  // is only sound when this non-empty literal does NOT flow into a sink that
  // demands a WIDER / heterogeneous element type (`any[]` / `unknown[]` / a
  // union). When it does — a literal passed where an `any[]` is expected
  // (`g([1,2,3])`, `g(x: any[])`), or an annotated `const a: any[] = [1,2,3]`
  // were the selector to claim it (today such functions are `body-shape-rejected`
  // because `lowerVarDecl` only forwards PRIMITIVE type annotations; this gate
  // keeps the fast path sound if that claim scope ever widens) — demote to the
  // SAFE legacy lowering, which boxes each element to the dynamic externref
  // representation. Gating here (before the element-type loop) makes the explicit
  // HI reason the demotion cause rather than the incidental "mixed-type" throw
  // that the externref-hint path would otherwise raise; the existing
  // element-type / hint `irTypeEquals` checks remain as a backstop for any sink
  // `getContextualType` cannot recover at this site. Empty literals are excluded
  // (handled above): with a wide hint they already build a correct wide vec, so
  // there is no narrow build to let escape.
  if (arrayLiteralWideningEscapes(expr, cx)) {
    throw new IrUnsupportedError(
      "array-representation-unsupported",
      "build",
      `ir/from-ast: array literal flows into a widening/heterogeneous sink ` +
        `(any[]/unknown[]/union element) — the packed vec.new_fixed fast path is ` +
        `unsound here; demote to the SAFE boxed legacy lowering (${cx.funcName})`,
    );
  }

  // Lower each element. Use the hint element type as each element's hint when
  // we have one (so e.g. number elements stay f64).
  const elementHint = hintElemIr ?? irVal({ kind: "f64" });
  const elementIds: IrValueId[] = [];
  for (const el of expr.elements) {
    if (ts.isSpreadElement(el)) {
      const shape = spreadPlan!.get(el)!;
      if (shape.kind === "inline-literal") {
        // `[...[a, b], c]` — inline the operand literal's elements verbatim.
        // The operand is never allocated (same expansion the call-argument
        // spread already uses), and source order is preserved.
        for (const inner of shape.elements) elementIds.push(lowerExpr(inner, cx, elementHint));
        continue;
      }
      // `const a = [1, 2]; … [...a, c]` — lower the source ONCE (so any
      // side effects happen once, in source order), then read each proven
      // index. Reading rather than re-lowering is what makes the result a
      // COPY: the `vec.new_fixed` below allocates its own backing array, so a
      // later `a[0] = …` is not observable through the spread result.
      const source = lowerExpr(el.expression, cx, hint);
      const sourceType = cx.builder.typeOf(source);
      const sourceVec = resolveIrVecType(sourceType, cx);
      if (!sourceVec) {
        // Same reasoning as the non-scalar arm below: a shape this expansion
        // cannot carry is a CAPABILITY gap, so it must demote, not hard-fail.
        throw new IrUnsupportedError(
          "array-representation-unsupported",
          "build",
          `ir/from-ast: array literal spread source is not a recognisable vec ` +
            `(${describeIrType(sourceType)}) in ${cx.funcName}`,
        );
      }
      // Only NUMERIC/BOOLEAN sources expand. A string-carrier vec stores
      // `externref`, so `vec.get` hands back the STORED type while sibling
      // string literals in the same literal lower as `IrType.string` — the two
      // cannot share one `vec.new_fixed` element type. Demote through the
      // unsupported channel (a bare `Error` here reads as an unexpected
      // internal throw under IR-first and fails the compile instead of
      // falling back).
      const sourceElement = asVal(sourceVec.elementType);
      if (!sourceElement || (sourceElement.kind !== "f64" && sourceElement.kind !== "i32")) {
        throw new IrUnsupportedError(
          "array-representation-unsupported",
          "build",
          `ir/from-ast: array literal spread of a non-scalar vec ` +
            `(${describeIrType(sourceVec.elementType)}) is not carried by the fixed-literal ` +
            `expansion (${cx.funcName})`,
        );
      }
      for (let index = 0; index < shape.length; index++) {
        const indexId = cx.builder.emitConst({ kind: "i32", value: index }, irVal({ kind: "i32" }));
        elementIds.push(cx.builder.emitVecGet(source, indexId, sourceVec.elementType));
      }
      continue;
    }
    elementIds.push(lowerExpr(el as ts.Expression, cx, elementHint));
  }

  // A literal that is nothing but spreads of EMPTY sources (`[...a]` with
  // `const a: number[] = []`) expands to zero elements, so there is no element
  // to infer the vec's element type from and no annotation supplying one.
  // Measured (#4487 continuation, `.tmp/probe-4487b.ts`): the selector claims
  // that unit, so a bare `Error` here surfaces under IR-first as
  // `IR path failed` — a COMPILE FAILURE for a program the branch base
  // compiled fine (base rejected it at `expr-arraylit-spread` and legacy
  // handled it). It is a capability gap, not a producer-promise violation, so
  // it demotes through the typed channel exactly like the string-carrier arm.
  if (elementIds.length === 0 && !hintElemIr) {
    throw new IrUnsupportedError(
      "array-representation-unsupported",
      "build",
      `ir/from-ast: spread-only array literal expanded to zero elements and no vec-typed ` +
        `hint supplies the element type (${cx.funcName})`,
    );
  }

  // Determine the shared element IrType: the hint's element type if present,
  // else the first element's type. Require every element to share it.
  const elementType = hintElemIr ?? cx.builder.typeOf(elementIds[0]!);
  for (const id of elementIds) {
    if (!irTypeEquals(cx.builder.typeOf(id), elementType)) {
      demoteToLegacy(
        "array-representation-unsupported",
        `ir/from-ast: mixed-type array literal not in #1804 scope (${cx.funcName})`,
      );
    }
  }

  // A logical string vector uses the backend's canonical string carrier:
  // externref in the JS-host lane and `(ref $AnyString)` in native-string
  // WasmGC. Keep `IrType.string` in the IR so an in-bounds element read still
  // carries string semantics into a capability-owned boundary.
  const storedElementIds = elementIds;
  const storedElementType = elementType;
  const elemVT =
    asVal(storedElementType) ?? (storedElementType.kind === "string" ? cx.resolver?.resolveString?.() : undefined);
  if (!elemVT) {
    // Non-scalar (nested vec / object / closure / …) element types are out of
    // scope for this slice. Typed-unsupported rather than a bare `Error`: the
    // #4487 spread adoption newly CLAIMS units that reach here — `[...[[1],
    // [2]], [3]]`, or `[...a]` over a `number[][]` const — and under IR-first
    // a bare throw fails the compile instead of demoting to the perfectly good
    // legacy body (measured on the branch base: both compiled). This is the
    // literal-construction twin of the #4486 nested-vec hard error.
    //
    // (#4502) #4487 and the #4502 sweep reached this verdict and this code
    // INDEPENDENTLY, which is the corroboration the sweep wanted; the merge
    // keeps #4487's rationale and routes it through the shared helper.
    demoteToLegacy(
      "array-representation-unsupported",
      `ir/from-ast: array literal element type ${storedElementType.kind} not in #1804 scope (${cx.funcName})`,
    );
  }
  const vec = cx.resolver?.resolveVecForElement?.(elemVT);
  if (!vec) {
    demoteToLegacy(
      "array-representation-unsupported",
      `ir/from-ast: resolver cannot register vec for array literal (${cx.funcName})`,
    );
  }
  const vecValueType =
    cx.resolver?.resolveVecValueTypeForElement?.(elemVT) ??
    vec.valueType ??
    ({ kind: "ref", typeIdx: vec.vecStructTypeIdx } as ValType);
  const resultType =
    elemVT.kind === "f64" || elemVT.kind === "i32" || storedElementType.kind === "string"
      ? irVec(storedElementType, false)
      : irVal(vecValueType);
  return cx.builder.emitVecNewFixed(storedElementIds, storedElementType, resultType);
}

/**
 * Slice 10 (#1169i) — lower a `/pattern/flags` RegExp literal. Reuses the
 * legacy `parseRegExpLiteral` to extract pattern + flags from the literal
 * text. The flags string is normalized to `""` when no flags are present
 * (matches the legacy `compileRegExpLiteral` convention — see
 * `src/codegen/typeof-delete.ts:166-168`); a `null` flags arg would
 * otherwise produce `RegExp("...", null)` at runtime, which JS rejects
 * as `TypeError: Invalid flags 'null'`.
 */
function lowerRegExpLiteral(expr: ts.Expression, cx: LowerCtx): IrValueId {
  const { pattern, flags } = parseRegExpLiteralText(expr.getText());
  return cx.builder.emitRegExpLiteral(pattern, flags);
}

/**
 * Slice 10 (#1169i) — local copy of the legacy `parseRegExpLiteral` (in
 * `src/codegen/index.ts:3218`). Duplicated here to avoid importing from
 * `codegen/index.ts` from `ir/from-ast.ts`, which would add a second
 * pass-through over the existing `codegen/index.ts ↔ ir/integration.ts`
 * circular dependency. The two implementations are trivially identical;
 * any drift would surface as a behavioural mismatch in the slice-10
 * equivalence tests.
 */
function parseRegExpLiteralText(text: string): { pattern: string; flags: string } {
  const lastSlash = text.lastIndexOf("/");
  return { pattern: text.slice(1, lastSlash), flags: text.slice(lastSlash + 1) };
}

/**
 * Lower a template literal with substitutions. Slice 1 (#1169a) admitted only
 * substitutions that lower to `IrType.string`; #4467 adds the NUMERIC family,
 * routed through the `IR_NUMBER_TO_STRING_FN` provider (§7.1.17
 * `Number::toString(value, 10)`) before it joins the same concat chain; #4503
 * adds the BOOLEAN family, distinguished from a numeric `i32` purely by the
 * `irBool()` brand and lowered to the `"true"`/`"false"` spellings of §7.1.17
 * ToString(Boolean). The remaining families still reject in the selector — see
 * the `ts.isTemplateExpression` arm of `isPhase1Expr`.
 *
 * Even when the head text is empty (`${x}rest`) we emit a `string.const ""`
 * to give the chain a consistent left operand for the first concat — same
 * convention as the legacy `compileTemplateExpression`. The IR
 * constant-folder may collapse trivial empty-concats downstream.
 */
function lowerTemplateExpression(expr: ts.TemplateExpression, cx: LowerCtx): IrValueId {
  let acc = cx.builder.emitStringConst(expr.head.text);
  for (const span of expr.templateSpans) {
    // The expected type stays `string`: a string-family substitution lowers
    // directly into the carrier, and a numeric/boolean one ignores the hint and
    // hands back its scalar, which the conversions below pick up.
    const sub = lowerExpr(span.expression, cx, { kind: "string" });
    const subType = cx.builder.typeOf(sub);
    // (#4503) BRAND FIRST, and only then the numeric conversion — a boolean and
    // a native-annotated number share the `i32` carrier, so asking the brand
    // before the carrier is what keeps `${true}` from lowering as `${1}`.
    const asString =
      subType.kind === "string"
        ? sub
        : irTypeIsBoolean(subType)
          ? lowerBooleanToString(cx.builder, sub)
          : lowerNumericSubstitutionToString(sub, subType, span.expression, cx);
    acc = cx.builder.emitStringConcat(acc, asString);
    if (span.literal.text) {
      const lit = cx.builder.emitStringConst(span.literal.text);
      acc = cx.builder.emitStringConcat(acc, lit);
    }
  }
  return acc;
}

/**
 * (#4467) Convert a lowered NUMERIC substitution to the lane's string carrier.
 *
 * The selector proved the checker family is `number`, but the IR carrier it
 * lands in is the lowerer's choice: a plain `number` is `f64`, while the
 * native `type i32 = number` / `type i64 = number` annotations keep their
 * integer carrier. All three widen to `f64` first — signed, matching the
 * legacy native template arm (`src/codegen/string-ops.ts`) — and then go
 * through the single `(f64) -> string` provider, so this site asks no mode
 * question and both string carriers work.
 *
 * A carrier the selector's family proof did not anticipate (a boxed/dynamic
 * value, say) demotes with the SAME reason the selector uses, keeping the
 * claim⇔lowering boundary reported under one bucket.
 *
 * (#4503) UNBRANDED-`i32` GUARD. The selector now also admits the boolean
 * family, so an `i32` reaching here is numeric only if it is NOT a boolean some
 * producer failed to brand — and that gap would print `${true}` as `"1"`. An
 * `i32` whose source the checker proves boolean therefore demotes instead, at
 * the selector's own reason. The brand is the fast path (no checker query for
 * the branded case); this is the backstop for a producer the brand has not
 * reached, and absent a checker it answers "not proven boolean", which is only
 * reachable in bare-selector configurations whose boolean admission is the
 * syntactic set the brand does cover (`!x`, comparisons, `true`/`false`).
 */
function lowerNumericSubstitutionToString(
  value: IrValueId,
  type: IrType,
  source: ts.Expression,
  cx: LowerCtx,
): IrValueId {
  const scalar = type.kind === "val" ? type.val.kind : undefined;
  if (scalar === "i32" && checkerOperandFamily(source, cx) === "boolean") {
    throw new IrUnsupportedError(
      "template-substitution-unsupported",
      "build",
      `ir/from-ast: boolean template substitution reached the numeric conversion unbranded (${cx.funcName})`,
    );
  }
  const asF64 =
    scalar === "f64"
      ? value
      : scalar === "i32"
        ? cx.builder.emitUnary("f64.convert_i32_s", value, IR_F64)
        : scalar === "i64"
          ? cx.builder.emitUnary("f64.convert_i64_s", value, IR_F64)
          : null;
  if (asF64 === null) {
    throw new IrUnsupportedError(
      "template-substitution-unsupported",
      "build",
      `ir/from-ast: template substitution lowered to ${describeIrType(type)}, which has no number→string provider (${cx.funcName})`,
    );
  }
  const result = cx.builder.emitCall(irIntrinsicFuncRef(IR_NUMBER_TO_STRING_FN), [asF64], { kind: "string" });
  if (result === null) {
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error(`ir/from-ast: ${IR_NUMBER_TO_STRING_FN} produced no result in ${cx.funcName}`);
  }
  return result;
}

/**
 * Lower `typeof <expr>` by static fold (slice 1). Operand IrType must be
 * statically known; union/boxed operands are deferred to a follow-up
 * slice that emits a runtime tag dispatch via `tag.test`.
 */
function lowerTypeOf(expr: ts.TypeOfExpression, cx: LowerCtx): IrValueId {
  const inner = lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
  const innerType = cx.builder.typeOf(inner);
  const tag = staticTypeOfFor(innerType);
  if (tag === null) {
    demoteToLegacy(
      "operand-coercion-unsupported",
      `ir/from-ast: typeof of non-static IrType (${describeIrType(innerType)}) is deferred (${cx.funcName})`,
    );
  }
  return cx.builder.emitStringConst(tag);
}

/**
 * Map an IR type to the JS `typeof` tag string that any value of that type
 * would produce at runtime. Returns `null` for types whose runtime tag
 * varies (unions, boxed, references) — those need a runtime dispatch and
 * are out of slice 1's scope.
 */
function staticTypeOfFor(t: IrType): string | null {
  if (t.kind === "string") return "string";
  if (t.kind === "vec") return "object";
  if (t.kind === "val") {
    if (t.val.kind === "f64" || t.val.kind === "f32" || t.val.kind === "i64") return "number";
    if (t.val.kind === "i32") return "boolean"; // i32 represents bool in slice 1
  }
  return null;
}

/**
 * Optional-chaining gate (#1281). Returns true when the lowered IrType
 * could carry a null reference at runtime — i.e. cases where the IR's
 * eager-evaluation primitives (no short-circuit `if/else` for property
 * access) cannot safely evaluate the receiver.
 *
 * Conservative: anything that's not a known non-null kind (`object`,
 * `class`, `string`, `extern` class, `closure`, `vec`, or `val.kind:
 * "ref"`) is treated as nullable. That's slightly stricter than spec
 * semantics but keeps the gate sound — the legacy fallback handles all
 * remaining cases correctly.
 */
function isIrTypeNullable(t: IrType): boolean {
  switch (t.kind) {
    case "object":
    case "class":
    case "string":
    case "closure":
      return false;
    case "vec":
      return t.nullable;
    case "callable":
      // Boundary callables are externref carriers. A host can still supply
      // null despite the source annotation, so optional access must retain a
      // runtime null check / legacy fallback.
      return true;
    case "extern":
      // Host-class externref values (Map, RegExp, ...) — externref is
      // nullable at the JS host level. Treat as nullable for `?.` gating.
      return true;
    case "val": {
      const v = t.val;
      // Non-null reference types in WasmGC are `ref`. Vecs/typed arrays
      // surface as `ref` to a registered struct. Everything else
      // (ref_null, externref, eqref, anyref, funcref, primitives) can
      // carry null at the JS source level.
      return v.kind !== "ref";
    }
    case "union":
    case "boxed":
      return true;
    default:
      return true;
  }
}

/**
 * #1375 Slice B — IR-native short-circuit lowering for `extern_recv?.prop`
 * using the (#1392) `emitIfElse` + `emitRefIsNull` primitives.
 *
 * Pattern:
 *   if (ref.is_null(recv)) { result = <undef sentinel of propType> }
 *   else                   { result = <className>_get_<propName>(recv) }
 *
 * The sentinel for the null arm depends on the property's ValType:
 *   - `f64`        — `f64.const NaN` (matches JS `undefined → Number → NaN`)
 *   - `i32`        — `i32.const 0`   (rare for extern props; pragmatic)
 *   - `externref`  — `ref.null.extern`
 *   - `ref_null T` — `ref.null` of the appropriate heap type
 *   - other refs   — fall through to legacy (cannot widen to ref_null
 *                    inside an `if` arm without type-system support)
 *
 * When the prop type isn't one of the supported sentinels, we throw to
 * legacy fallback — the existing slice-11 behavior for the rest of #1375.
 */
function lowerOptionalExternPropertyAccess(
  propName: string,
  recv: IrValueId,
  recvType: IrType,
  cx: LowerCtx,
): IrValueId {
  if (recvType.kind !== "extern") {
    demoteToLegacy(
      "property-access-unsupported",
      `ir/from-ast: lowerOptionalExternPropertyAccess called with non-extern recv in ${cx.funcName}`,
    );
  }
  const className = recvType.className;
  const resolved = cx.resolver?.resolveExternMember?.(className, propName, "property");
  const info = cx.resolver?.getExternClassInfo?.(className);
  if (!resolved?.property && !info) {
    demoteToLegacy(
      "property-access-unsupported",
      `ir/from-ast: extern class ${className} not registered in ${cx.funcName}`,
    );
  }
  const prop = resolved?.property ?? info?.properties.get(propName);
  if (!prop) {
    demoteToLegacy(
      "property-access-unsupported",
      `ir/from-ast: extern class ${className} has no property "${propName}" in ${cx.funcName}`,
    );
  }
  const importPrefix = resolved?.importPrefix ?? info?.importPrefix ?? className;
  const propValType = prop.type;
  const resultType: IrType = irVal(propValType);

  // Limit Slice B to prop types whose IR-claimed ValType matches the
  // actual host-import return type. The extern-class registry for some
  // properties (notably numeric ones like `Map.size`, `RegExp.lastIndex`)
  // declares `prop.type: f64` but the underlying `<className>_get_<prop>`
  // host import actually returns `externref` (boxed Number) — `lowerExpr`
  // for the non-`?.` case relies on a downstream coercion in `lowerBinary`
  // / `coerceType` to unbox before use. Inside our `emitIfElse` arm the
  // unboxing isn't reached, so the elseValue's wasm type (externref)
  // mismatches the if-result type (f64) at Wasm validation time.
  //
  // Safe types here: those where the IR-declared ValType matches the
  // host-import wasm return type 1:1. `externref` is always safe (the
  // host returns externref, which is what we want). We bail on `f64`
  // and `i32` to legacy until the prop registry tracks the actual
  // host-import return type alongside the declared TS type.
  if (propValType.kind !== "externref") {
    demoteToLegacy(
      "property-access-unsupported",
      `ir/from-ast: optional ?.${propName} on extern ${className} with non-externref prop type (${describeIrType(resultType)}) deferred to legacy in ${cx.funcName}`,
    );
  }

  // Compute is_null condition before opening the if-arms, so the cond
  // SSA value is defined at the if-instr's emission point (per IrInstrIf
  // contract: condition lives in the outer scope).
  const cond = cx.builder.emitRefIsNull(recv);

  // Build the "null arm": emit a `ref.null.extern` matching the result
  // type. `collectBodyInstrs` re-routes builder emits into the arm's
  // buffer; the SSA value defined inside the callback becomes `thenValue`.
  let thenValue!: IrValueId;
  const thenBody = cx.builder.collectBodyInstrs(() => {
    thenValue = cx.builder.emitConst({ kind: "null", ty: resultType }, resultType);
  });

  // Build the "non-null arm": emit the actual extern-property access.
  let elseValue!: IrValueId;
  const elseBody = cx.builder.collectBodyInstrs(() => {
    elseValue = cx.builder.emitExternProp(importPrefix, propName, recv, resultType);
  });

  return cx.builder.emitIfElse({
    cond,
    then: thenBody,
    thenValue,
    else: elseBody,
    elseValue,
    resultType,
  });
}

/**
 * #3000 — map a property name to the struct-slot key the class registry uses.
 * A `PrivateIdentifier` (`#x`) is mangled to `__priv_x`, byte-for-byte matching
 * the legacy `resolveClassMemberName` (`src/codegen/class-bodies.ts`) so the IR
 * `class.get`/`class.set` resolve the identical `structFields` slot the legacy
 * path allocated. A plain `Identifier` passes through unchanged.
 */
function irPrivateFieldName(name: ts.Identifier | ts.PrivateIdentifier): string {
  return ts.isPrivateIdentifier(name) ? "__priv_" + name.text.slice(1) : name.text;
}

/**
 * Lower a property access expression.
 *
 * Slice 1 (#1169a) handles `<string>.length` (the only `.length` form
 * relevant before slice 2). Slice 2 (#1169b) extends to named property
 * reads on `IrType.object` receivers — the lowerer resolves the field
 * by name against the receiver shape's canonical field list and emits
 * `object.get`.
 *
 * Receivers of any other IrType (boxed, union, val with non-string
 * representation) are out of slice 2's scope and throw, so the
 * containing function falls back to legacy.
 */
function lowerPropertyAccess(expr: ts.PropertyAccessExpression, cx: LowerCtx): IrValueId {
  // #3000 — private-field read (`this.#x`). A PrivateIdentifier is not an
  // Identifier, so the pre-#3000 guard rejected it. Private names lower to the
  // SAME mangled struct-slot key the legacy path registers
  // (`resolveClassMemberName`: `#x` → `__priv_x`), so the class shape / fieldIdx
  // resolve the identical slot. Only class receivers carry private slots; on any
  // other receiver kind the mangled name won't be found and the function
  // demotes to legacy cleanly.
  if (!ts.isIdentifier(expr.name) && !ts.isPrivateIdentifier(expr.name)) {
    demoteToLegacy(
      "property-access-unsupported",
      `ir/from-ast: computed property access not in slice 2 (${cx.funcName})`,
    );
  }
  const propName = irPrivateFieldName(expr.name);

  // Receiver type is unknown until we lower it; pass an f64 hint (the
  // numeric default) and inspect the resulting IrType. The hint is
  // advisory — string / object lowerings ignore it.
  const recv = lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);

  // Optional chaining (`obj?.prop`, #1281). For receivers whose lowered
  // IrType is provably non-null (struct shapes, class instances, strings,
  // non-null refs), `?.` is redundant safety syntax and we lower it like
  // a regular `.` access. For genuinely nullable IrTypes the path
  // depends on the receiver kind:
  //
  //   - TS-narrowing fast-path (#1375 Slice A): when TypeScript proves
  //     the expression's type is non-null (`getNonNullableType(t) === t`),
  //     fall through to the regular `.` access — `Map<...>` without
  //     `| undefined` is a common case the IR's conservative
  //     `isIrTypeNullable` flags as nullable but TS proves safe.
  //   - Extern host-class receiver (#1375 Slice B): use the new (#1392)
  //     `emitIfElse` + `emitRefIsNull` IR primitives to short-circuit.
  //     Returns the property's value when the receiver is non-null, or
  //     a null/NaN sentinel of the property's IrType when null.
  //   - Other nullable kinds (raw externref, ref_null val): still throw
  //     to legacy fallback, where `compileOptionalPropertyAccess`
  //     already emits a Wasm-level `if/else` null-guarded access. The
  //     IR doesn't yet have a unified prop-access dispatch for those.
  if (expr.questionDotToken && isIrTypeNullable(recvType)) {
    const tsNonNull = cx.resolver?.isExpressionTsNonNullable?.(expr.expression) === true;
    if (tsNonNull) {
      // Fall through: TS-proven non-null → lower as ordinary `.prop` access.
    } else if (recvType.kind === "extern") {
      // Slice B — IR-native short-circuit on extern receivers.
      return lowerOptionalExternPropertyAccess(propName, recv, recvType, cx);
    } else {
      demoteToLegacy(
        "property-access-unsupported",
        `ir/from-ast: optional chaining (?.) on nullable receiver not in slice 11 (${cx.funcName})`,
      );
    }
  }

  if (recvType.kind === "string") {
    // Slice 1 — only `.length` is supported on string receivers.
    if (propName !== "length") {
      demoteToLegacy(
        "property-access-unsupported",
        `ir/from-ast: .${propName} on string is not in slice 2 (${cx.funcName})`,
      );
    }
    return cx.builder.emitStringLen(recv, inferStringEncoding(expr.expression, cx));
  }

  if (recvType.kind === "object") {
    // Slice 2 — named field read on a known shape.
    const fieldIdx = recvType.shape.fields.findIndex((f) => f.name === propName);
    if (fieldIdx < 0) {
      demoteToLegacy(
        "property-access-unsupported",
        `ir/from-ast: object has no field "${propName}" (shape: ${describeIrType(recvType)}) in ${cx.funcName}`,
      );
    }
    const fieldType = recvType.shape.fields[fieldIdx]!.type;
    return cx.builder.emitObjectGet(recv, propName, fieldType);
  }

  if (recvType.kind === "class") {
    // Slice 4 (#1169d) — named field read on a class instance. Static
    // resolution: look up `propName` against the class shape's field
    // list. Methods are not readable as bare property access in slice 4
    // (no method-as-value); only call expressions resolve them.
    const field = recvType.shape.fields.find((f) => f.name === propName);
    if (!field) {
      // (#3144) Accessor fallback: `recv.prop` backed by a `get prop()`
      // accessor (own or inherited) lowers to a call of the legacy accessor
      // function `${recvClass}_get_${prop}` — the same key legacy's
      // property-access getter dispatch calls (inherited accessors are
      // key-propagated to the subclass, so the receiver's className is the
      // right prefix).
      const getter = findClassMember(recvType.shape, propName, "getter");
      if (getter && getter.returnType !== null) {
        const r = cx.builder.emitClassCall(recv, propName, "getter", [], getter.returnType, getter.target);
        if (r === null) {
          // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
          throw new Error(
            `ir/from-ast: getter ${recvType.shape.className}.${propName} produced no value (${cx.funcName})`,
          );
        }
        return r;
      }
      demoteToLegacy(
        "property-access-unsupported",
        `ir/from-ast: class ${recvType.shape.className} has no field "${propName}" in ${cx.funcName}`,
      );
    }
    return cx.builder.emitClassGet(recv, propName, field.type);
  }

  if (recvType.kind === "extern") {
    // Slice 10 (#1169i), widened by #2856 — extern-class property read with
    // inheritance-chain resolution. The instr's className must be the
    // DEFINING class (the import is `<definer>_get_<prop>`, e.g.
    // `Node_appendChild` for an `Element` receiver), which the chain walk
    // returns as `importPrefix`. Result branding (#2856): an externref-shaped
    // property whose USE-SITE type names an extern class becomes
    // `IrType.extern { className }`, so chained access
    // (`document.body.appendChild(...)`, `e.style.cssText = ...`) keeps
    // dispatching through the extern arms.
    const className = recvType.className;
    const standaloneDomRead = cx.resolver?.standaloneDomOperation?.(expr);
    const exactStandaloneDomRead = standaloneDomRead?.kind === "member-get" && standaloneDomRead.access === expr;
    assertNotDeferred(
      domSurfaceCapability(cx.resolver?.jsHostExterns?.() === true, exactStandaloneDomRead),
      `extern property read .${propName}`,
      cx.funcName,
    );
    const resolved = cx.resolver?.resolveExternMember?.(className, propName, "property", expr);
    if (resolved?.property) {
      if (exactStandaloneDomRead && `${resolved.importPrefix}_get_${propName}` !== standaloneDomRead.importName) {
        throw new IrInvariantError(
          "selection-preparation-mismatch",
          "build",
          `ir/from-ast: certified DOM property read resolved to the wrong import (${cx.funcName})`,
        );
      }
      const resultType: IrType = resolved.resultClassName
        ? { kind: "extern", className: resolved.resultClassName }
        : irVal(resolved.property.type);
      return cx.builder.emitExternProp(resolved.importPrefix, propName, recv, resultType);
    }
    // Flat (own-class) lookup for resolvers that don't implement the #2856
    // chain walk — preserves the pre-#2856 slice-10 behaviour.
    const info = cx.resolver?.getExternClassInfo?.(className);
    if (!info) {
      demoteToLegacy(
        "property-access-unsupported",
        `ir/from-ast: extern class ${className} not registered in ${cx.funcName}`,
      );
    }
    const prop = info.properties.get(propName);
    if (!prop) {
      demoteToLegacy(
        "property-access-unsupported",
        `ir/from-ast: extern class ${className} has no property "${propName}" in ${cx.funcName}`,
      );
    }
    return cx.builder.emitExternProp(info.importPrefix, propName, recv, irVal(prop.type));
  }

  // Slice 13 (#1169p) — vec-shaped receiver (`number[]`, `string[]`, …):
  // support `.length` (the only structural property a vec carries).
  // Other Array prototype properties are non-existent in TS so this
  // branch only fires for `.length`. Method dispatch (`arr.push(...)`,
  // `arr.map(...)`, etc.) is handled in `lowerMethodCall`.
  const recvVal = asVal(recvType);
  const vectorExpression =
    cx.resolver?.isVecValueExpression?.(expr.expression) === true ||
    cx.emptyArrayInference.isResolvedVectorExpression(expr.expression);
  const scalarVecCandidate = recvVal?.kind === "i32" && vectorExpression;
  if (
    recvType.kind === "vec" ||
    (recvVal && (recvVal.kind === "ref" || recvVal.kind === "ref_null" || scalarVecCandidate))
  ) {
    const resolvedVec = resolveIrVecType(recvType, cx);
    if (resolvedVec) {
      const scalarVecReceiver = resolvedVec.valueType.kind === "i32" && vectorExpression;
      if (propName === "length") {
        // A growable linear vec may have forwarded its original header after
        // an indexed write. The direct runtime reader chases that chain;
        // vec.len's raw planned load intentionally remains unchanged for
        // fixed vectors and WasmGC refs.
        if (scalarVecReceiver && cx.emptyArrayInference.isResolvedVectorExpression(expr.expression)) {
          return emitForwardingAwareLinearVecLen(recv, cx);
        }
        return cx.builder.emitVecLen(recv);
      }
      demoteToLegacy(
        "property-access-unsupported",
        `ir/from-ast: .${propName} on vec not in slice 13 (${cx.funcName})`,
      );
    }
  }

  // #3053 U1 / #2949 S5.4 — named read `recv.name` on a boxed-any (dynamic)
  // receiver: route through the unified reader primitive
  // `__dyn_member_get(recv, key)` (#3053 U0). The receiver already IS the
  // carrier; the key is the property name boxed as a tag-5 string carrier, so
  // the helper's own `__any_to_extern(key)` yields the property key. The result
  // is the identity-preserving, tag-honest carrier (`dynamic`) — the S5.4
  // carrier-impedance blocker is dissolved.
  //
  // MECHANISM ONLY: the selector's move-only scan (`select.ts`
  // `dynamicUsesAreMoveOnly`) still REJECTS a dyn receiver in a member read, so
  // no claimed function reaches this arm until S5.P (U2) opens the scan — it is
  // wired but unreached (byte-inert). It replaces the prior unconditional throw
  // for a dynamic receiver, which — being a claim-then-demote the selector
  // never actually produces — was itself unreachable in a claimed function.
  if (recvType.kind === "dynamic") {
    const key = cx.builder.emitBox(cx.builder.emitStringConst(propName), irDynamic(JS_TAG_IDS.String));
    return cx.builder.emitDynMemberGet(recv, key);
  }

  demoteToLegacy(
    "property-access-unsupported",
    `ir/from-ast: property access .${propName} on ${describeIrType(recvType)} is not in slice 2 (${cx.funcName})`,
  );
}

/**
 * Lower an object literal to an IR `object.new`. The shape is derived
 * from the literal's properties: each PropertyAssignment /
 * ShorthandPropertyAssignment contributes one field. Field types come
 * from the lowered initializer's IrType (no TS-checker introspection
 * — we're already past type resolution by the time we lower).
 *
 * The shape is sorted by name AFTER lowering so the canonical form
 * compares equal across literals with different syntactic ordering. The
 * value list is reordered to match.
 */
function lowerObjectLiteral(expr: ts.ObjectLiteralExpression, cx: LowerCtx): IrValueId {
  // #4471 — an empty literal is admitted only when the selector proved it
  // INERT (`isInertEmptyObjectLiteral`), and lowers to a zero-field
  // `object.new`. The property loop below is already a no-op at zero
  // properties, so the empty case needs no arm of its own: it falls through to
  // `emitObjectNew({ fields: [] }, [])`, which the WasmGC/linear resolvers both
  // register as an ordinary (fieldless) struct. `lowerOrdinaryToPrimitive-
  // ObjectLiteral` returns null for a zero-property literal, so the
  // valueOf/toString path is not entered.
  const ordinaryToPrimitive = lowerOrdinaryToPrimitiveObjectLiteral(expr, cx);
  if (ordinaryToPrimitive !== null) return ordinaryToPrimitive;
  const built: { name: string; type: IrType; value: IrValueId }[] = [];
  const seen = new Set<string>();
  for (const prop of expr.properties) {
    if (ts.isPropertyAssignment(prop)) {
      // (#4513) Same fold the selector admitted this literal with — one shared
      // function, so the claim rule and the lowering rule cannot drift into a
      // post-claim `invariant`.
      const name = objectLiteralDataPropertyName(prop.name);
      if (name === null) {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: object literal property name not in slice 2 (${cx.funcName})`,
        );
      }
      if (seen.has(name)) {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: duplicate object literal key "${name}" not in slice 2 (${cx.funcName})`,
        );
      }
      seen.add(name);
      const v = lowerExpr(prop.initializer, cx, irVal({ kind: "f64" }));
      const type = cx.builder.typeOf(v);
      built.push({ name, type, value: v });
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name.text;
      if (seen.has(name)) {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: duplicate object literal key "${name}" not in slice 2 (${cx.funcName})`,
        );
      }
      seen.add(name);
      const found = cx.scope.get(name);
      if (!found) {
        demoteToLegacy("body-shape-rejected", `ir/from-ast: shorthand "${name}" not in scope in ${cx.funcName}`);
      }
      // Slice 3 (#1169c): only `local`-kind bindings are usable as
      // shorthand object property values. nestedFunc bindings have no
      // SSA value.
      if (found.kind !== "local") {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: shorthand "${name}" refers to a non-local binding (${cx.funcName})`,
        );
      }
      // If the local is refcell-typed, deref to expose the inner scalar
      // (the same logic the identifier-handler in lowerExpr applies).
      if (found.type.kind === "boxed") {
        const v = cx.builder.emitRefCellGet(found.value, found.type.inner);
        built.push({ name, type: cx.builder.typeOf(v), value: v });
      } else {
        built.push({ name, type: found.type, value: found.value });
      }
      continue;
    }
    if (ts.isMethodDeclaration(prop)) {
      const name = phase1PropertyName(prop.name);
      if (name === null) {
        demoteToLegacy("body-shape-rejected", `ir/from-ast: object method name not in prepared scope (${cx.funcName})`);
      }
      if (seen.has(name)) {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: duplicate object method key "${name}" not in prepared scope (${cx.funcName})`,
        );
      }
      seen.add(name);
      const value = lowerClosureExpression(prop, cx);
      const type = cx.builder.typeOf(value);
      if (type.kind !== "closure") {
        // invariant (producer-promise): the lowering just invoked promised this shape — #4502.
        throw new Error(`ir/from-ast: object method "${name}" did not lower to a closure (${cx.funcName})`);
      }
      built.push({ name, type, value });
      continue;
    }
    demoteToLegacy(
      "body-shape-rejected",
      `ir/from-ast: object literal element ${ts.SyntaxKind[prop.kind]} not in slice 2 (${cx.funcName})`,
    );
  }
  built.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const shape: IrObjectShape = {
    fields: built.map((b) => ({ name: b.name, type: b.type })),
  };
  return cx.builder.emitObjectNew(
    shape,
    built.map((b) => b.value),
  );
}

/**
 * #4208 S3/S7 + #3522 — lower selector-certified OrdinaryToPrimitive
 * literals. Property-assigned function expressions retain #4208's open-object
 * protocol. An all-shorthand-method literal uses a closed structural
 * `object.new` whose method fields retain their exact closure signatures:
 *
 *   { valueOf: function(): number { return 1; } }
 *
 * The shorthand selector requires every method to return a numeric/boolean IR
 * primitive and rejects receiver-sensitive `this`, so unary coercion can
 * invoke its preferred field directly. String-returning shorthand remains
 * direct until a native string-to-number IR intrinsic avoids the larger
 * generic boxed conversion. This preserves the direct backend's static
 * object-method optimisation and avoids pulling the generic open-object
 * runtime into a standalone binary. Keeping the pre-existing expression form
 * open preserves its already-certified dynamic protocol and ABI.
 */
function lowerOrdinaryToPrimitiveObjectLiteral(expr: ts.ObjectLiteralExpression, cx: LowerCtx): IrValueId | null {
  const properties: {
    name: "valueOf" | "toString";
    initializer: ts.FunctionExpression | ts.MethodDeclaration;
  }[] = [];
  const seen = new Set<string>();
  for (const property of expr.properties) {
    const initializer = ts.isMethodDeclaration(property)
      ? property
      : ts.isPropertyAssignment(property) && ts.isFunctionExpression(property.initializer)
        ? property.initializer
        : null;
    if (initializer === null) return null;
    if (!property.name) return null;
    const name = phase1PropertyName(property.name);
    const primitiveReturn = initializer.type?.kind;
    const hasPreparedParityReturn =
      primitiveReturn === ts.SyntaxKind.NumberKeyword ||
      primitiveReturn === ts.SyntaxKind.BooleanKeyword ||
      (ts.isFunctionExpression(initializer) && primitiveReturn === ts.SyntaxKind.StringKeyword);
    if (
      (name !== "valueOf" && name !== "toString") ||
      seen.has(name) ||
      initializer.parameters.length !== 0 ||
      !hasPreparedParityReturn
    ) {
      return null;
    }
    seen.add(name);
    properties.push({ name, initializer });
  }
  if (properties.length === 0) return null;
  const hasFunctionExpression = properties.some(({ initializer }) => ts.isFunctionExpression(initializer));
  const hasMethodDeclaration = properties.some(({ initializer }) => ts.isMethodDeclaration(initializer));
  if (hasFunctionExpression && hasMethodDeclaration) return null;

  if (hasFunctionExpression) {
    const objectType: IrType = { kind: "extern", className: "Object" };
    const object = cx.builder.emitCall(irRuntimeFuncRef("__new_plain_object"), [], objectType);
    if (object === null) {
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(`ir/from-ast: __new_plain_object produced no value in ${cx.funcName}`);
    }
    for (const property of properties) {
      const key = cx.builder.emitCoerceToExternref(cx.builder.emitStringConst(property.name));
      const closure = lowerClosureExpression(property.initializer, cx);
      const closureType = cx.builder.typeOf(closure);
      if (closureType.kind !== "closure") {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: OrdinaryToPrimitive property is not an IR closure in ${cx.funcName}`,
        );
      }
      const callable = cx.builder.emitCallablePack(closure, closureType.signature);
      cx.builder.emitCall(irRuntimeFuncRef("__extern_set"), [object, key, callable], null);
    }
    return object;
  }

  const built: { name: "valueOf" | "toString"; type: IrType; value: IrValueId }[] = [];
  for (const property of properties) {
    const closure = lowerClosureExpression(property.initializer, cx);
    const closureType = cx.builder.typeOf(closure);
    if (closureType.kind !== "closure") {
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: OrdinaryToPrimitive property is not an IR closure in ${cx.funcName}`,
      );
    }
    built.push({ name: property.name, type: closureType, value: closure });
  }
  built.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const shape: IrObjectShape = { fields: built.map(({ name, type }) => ({ name, type })) };
  return cx.builder.emitObjectNew(
    shape,
    built.map(({ value }) => value),
  );
}

/**
 * #2766 — IR counterpart of legacy `isSafeBoundsEliminated`
 * (`src/codegen/property-access.ts`). The index `arr[i]` is proven in
 * `[0, array.length)` iff both `arr` and `i` are simple identifiers and the pair
 * was recorded by `detectCountedLoopSafeIndex` on the enclosing loop body's cx.
 */
function isProvenInBoundsIr(expr: ts.ElementAccessExpression, cx: LowerCtx): boolean {
  if (!cx.safeIndexedArrays || cx.safeIndexedArrays.size === 0) return false;
  if (!ts.isIdentifier(expr.expression) || !ts.isIdentifier(expr.argumentExpression)) return false;
  return cx.safeIndexedArrays.has(expr.expression.text + ":" + expr.argumentExpression.text);
}

/**
 * Lower an element access whose argument is a string literal — sugar
 * for property access on a known shape. Numeric / computed keys are
 * out of slice 2's scope and throw, so the function falls back to
 * legacy.
 */
/**
 * (#2856 C2) Lower an element STORE `arr[i] = v;` in statement position —
 * the write dual of `lowerElementAccess`'s vec arm. Dispatches to the
 * per-vec-type `__vec_elem_set_<vecTypeIdx>` helper (materialized on demand
 * by the resolver's `resolveFunc`, see src/codegen/vec-elem-set.ts), which
 * carries the FULL legacy semantics: null-guard, grow-on-OOB (capacity
 * doubling + data copy), the store, and the JS length update. A bare
 * `array.set` would trap on the growing-write pattern (`a[i] = v` past the
 * end), which is common in newly-claimed code — so the helper is the only
 * sound lowering.
 *
 * Demotes (clean throw → legacy) for: TypedArray-view receivers (per-view
 * conversion semantics — ToUint8/clamp/packing), non-vec receivers
 * (externref objects, strings), packed/exotic element kinds, and value
 * types that don't coerce to the element type.
 */
function lowerElementStore(lhs: ts.ElementAccessExpression, rhs: ts.Expression, cx: LowerCtx): void {
  if (lhs.questionDotToken) {
    demoteToLegacy(
      "element-store-unsupported",
      `ir/from-ast: optional element store (a?.[i] = v) not in IR scope (${cx.funcName})`,
    );
  }
  // TypedArray views need the legacy per-view value conversions.
  if (cx.resolver?.isTypedArrayViewExpr?.(lhs.expression)) {
    // (#3565) DESIGNED demote (see this function's doc: "Demotes (clean throw →
    // legacy) for: TypedArray-view receivers"). Typed UNSUPPORTED so the plain
    // `throw new Error` is not classified as the untyped `unexpected-internal-throw`
    // invariant that #3341/#3519 hard-error — a selector-claimed function with a
    // TypedArray element store must fall back to the legacy body, not fail compile.
    throw new IrUnsupportedError(
      "element-store-unsupported",
      "build",
      `ir/from-ast: element store on a TypedArray view not in IR scope (${cx.funcName})`,
    );
  }
  const recv = lowerExpr(lhs.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);
  if (recvType.kind === "dynamic") {
    const key = lowerExpr(lhs.argumentExpression, cx, irDynamic());
    if (cx.builder.typeOf(key).kind !== "dynamic") {
      throw new IrUnsupportedError(
        "element-store-unsupported",
        "build",
        `ir/from-ast: dynamic member-store key is not dynamic (${cx.funcName})`,
      );
    }
    let value = lowerExpr(rhs, cx, irDynamic());
    const valueType = cx.builder.typeOf(value);
    if (valueType.kind !== "dynamic") {
      const candidate = peelParensExpr(rhs);
      if (!ts.isStringLiteralLike(candidate) || candidate.text !== "true") {
        throw new IrUnsupportedError(
          "element-store-unsupported",
          "build",
          `ir/from-ast: concrete dynamic member-store value is outside the #3795 conflict marker (${cx.funcName})`,
        );
      }
      const boxed = boxConcreteToDynamic(value, valueType, rhs, cx);
      if (boxed === null) {
        throw new IrUnsupportedError(
          "operand-coercion-unsupported",
          "build",
          `ir/from-ast: dynamic member-store conflict marker has no dynamic carrier (${cx.funcName})`,
        );
      }
      value = boxed;
    }
    cx.builder.emitDynMemberSet(recv, key, value);
    return;
  }
  const recvVal = asVal(recvType);
  // (#2956 L2) Linear vec receivers are scalar i32 arena pointers, not GC
  // refs — admit them via the same resolver probe the read paths use
  // (`scalarVecReceiver` at the `.length` / element-access arms). The
  // WasmGC lane is unaffected: its vec receivers always lower as refs.
  const scalarVecStoreReceiver =
    recvVal?.kind === "i32" &&
    (cx.resolver?.isVecValueExpression?.(lhs.expression) === true ||
      cx.emptyArrayInference.isResolvedVectorExpression(lhs.expression));
  if (
    recvType.kind !== "vec" &&
    (!recvVal || (recvVal.kind !== "ref" && recvVal.kind !== "ref_null" && !scalarVecStoreReceiver))
  ) {
    demoteToLegacy(
      "element-store-unsupported",
      `ir/from-ast: element store on ${describeIrType(recvType)} not in IR scope (${cx.funcName})`,
    );
  }
  const resolvedVec = resolveIrVecType(recvType, cx);
  if (!resolvedVec) {
    demoteToLegacy(
      "element-store-unsupported",
      `ir/from-ast: element-store receiver is not a recognisable vec in ${cx.funcName}`,
    );
  }
  const vec = resolvedVec.lowering;
  const elem = vec.elementValType;
  // (#3734) A vector this function narrowed to i32 elements — the analysis
  // already proved this store's RHS is an exact int32 (that proof is WHY the
  // narrowing happened); `lowerNarrowedI32Element` re-checks it live.
  const narrowedI32 = isNarrowedI32Vec(vec, lhs.expression, cx);
  // Narrow slice: f64 vecs (number[]) and externref vecs (string[]/any[] in
  // host mode). Native-string / packed / exotic element vecs demote.
  if (!narrowedI32 && elem.kind !== "f64" && elem.kind !== "externref") {
    demoteToLegacy(
      "element-store-unsupported",
      `ir/from-ast: element store into '${elem.kind}' vec not in IR scope (${cx.funcName})`,
    );
  }
  // Index — the same f64-lower + trunc_sat discipline as the read path.
  const idxRaw = lowerExpr(lhs.argumentExpression, cx, irVal({ kind: "f64" }));
  const idxTy = asVal(cx.builder.typeOf(idxRaw));
  let idxI32: IrValueId;
  if (idxTy?.kind === "i32") {
    idxI32 = idxRaw;
  } else if (idxTy?.kind === "f64") {
    idxI32 = cx.builder.emitUnary("i32.trunc_sat_f64_s", idxRaw, irVal({ kind: "i32" }));
  } else {
    demoteToLegacy(
      "element-store-unsupported",
      `ir/from-ast: element-store index must be number or bool in ${cx.funcName}`,
    );
  }
  // Value — lower with the element-type hint, then coerce. Invariant W for a
  // narrowed vector: emit the exact i32 DIRECTLY, never by truncating an
  // already-lowered f64 (the #3741 rule — a truncation saturates where the
  // source semantics wrap).
  if (narrowedI32) {
    const narrowVal = lowerNarrowedI32Element(rhs, cx);
    if (isProvenInBoundsIr(lhs, cx)) {
      cx.builder.emitVecSet(recv, idxI32, narrowVal);
      return;
    }
    cx.builder.emitCall(irIntrinsicFuncRef(vecElemSetProviderSymbol(recvType, vec)), [recv, idxI32, narrowVal], null);
    return;
  }
  const valRaw = lowerExpr(rhs, cx, irVal(elem));
  let val: IrValueId;
  if (elem.kind === "f64") {
    const valTy = asVal(cx.builder.typeOf(valRaw));
    if (valTy?.kind !== "f64") {
      demoteToLegacy(
        "element-store-unsupported",
        `ir/from-ast: element-store value ${describeIrType(cx.builder.typeOf(valRaw))} into f64 vec ` +
          `not in IR scope (${cx.funcName})`,
      );
    }
    val = valRaw;
  } else {
    val = coerceToExpectedExtern(valRaw, elem, cx, `element-store value`);
  }
  // The helper name embeds the vec STRUCT typeIdx; the lower-time resolver
  // intercepts the prefix and materializes the helper on demand (name-based
  // resolution — funcIdx-shift safe by construction).
  if (isProvenInBoundsIr(lhs, cx)) {
    cx.builder.emitVecSet(recv, idxI32, val);
    return;
  }
  const provider =
    cx.resolver?.isHoleyArrayElementStore?.(lhs) === true
      ? IR_HOLEY_ARRAY_ELEM_SET
      : vecElemSetProviderSymbol(recvType, vec);
  cx.builder.emitCall(irIntrinsicFuncRef(provider), [recv, idxI32, val], null);
}

function lowerElementAccess(expr: ts.ElementAccessExpression, cx: LowerCtx): IrValueId {
  // #2713 — `a?.[i]` carries a `questionDotToken`: on a `null`/`undefined`
  // receiver the access must short-circuit to `undefined`, not index it.
  // The element-access lowering below ignores the token and emits an
  // unconditional `vec.get` (or object field read), which TRAPS on a null
  // receiver instead of yielding `undefined`. Optional chaining is
  // explicitly out of slice scope (#1169n: "Optional chaining `?.` / `?.()`
  // — need null-guard branching"), so demote the whole function to legacy,
  // which has the runtime null-guard. (Same demote-to-legacy discipline the
  // property-access optional arm already follows.)
  if (expr.questionDotToken) {
    demoteToLegacy(
      "element-access-unsupported",
      `ir/from-ast: optional element access (a?.[i]) not in IR scope (${cx.funcName})`,
    );
  }
  const arg = expr.argumentExpression;
  const isStringLitKey = ts.isStringLiteral(arg) || arg.kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral;
  // Lower the receiver first so we can dispatch by its IrType.
  const recv = lowerExpr(expr.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);

  // Slice 2 — string-literal key on an object-shaped receiver: read the
  // named field. This path matches `obj["fieldName"]` ≡ `obj.fieldName`.
  if (isStringLitKey && recvType.kind === "object") {
    const propName = (arg as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text;
    const fieldIdx = recvType.shape.fields.findIndex((f) => f.name === propName);
    if (fieldIdx < 0) {
      demoteToLegacy(
        "element-access-unsupported",
        `ir/from-ast: object has no field "${propName}" (shape: ${describeIrType(recvType)}) in ${cx.funcName}`,
      );
    }
    const fieldType = recvType.shape.fields[fieldIdx]!.type;
    return cx.builder.emitObjectGet(recv, propName, fieldType);
  }

  // Slice 12 (#1169o) — dynamic element access on a vec receiver.
  // The receiver's ValType must resolve to a vec via the resolver; the
  // index is lowered as f64 (JS Number) and truncated to i32 for the
  // backend `vec.get`.
  //
  // (#2766 — hybrid prove-then-specialize) The read is FAST (an unchecked
  // `vec.get`/`array.get`, which traps on OOB) ONLY when the index is *proven*
  // in `[0, length)` (the counted-loop proof ported from legacy
  // `safeIndexedArrays`). Otherwise it falls to the SAFE bounds-checked read
  // (`emitSafeVecGet`) that returns the JS-correct OOB value instead of
  // trapping. This retires the old "slice 12 trusts the type / the selector
  // keeps OOB functions in legacy" assumption: the trapping read was the
  // sharpest hybrid-invariant violation (strictly worse than legacy, which at
  // least bounds-checks and returns a sentinel).
  const recvVal = asVal(recvType);
  const vectorExpression =
    cx.resolver?.isVecValueExpression?.(expr.expression) === true ||
    cx.emptyArrayInference.isResolvedVectorExpression(expr.expression);
  const scalarVecCandidate = recvVal?.kind === "i32" && vectorExpression;
  if (
    recvType.kind === "vec" ||
    (recvVal && (recvVal.kind === "ref" || recvVal.kind === "ref_null" || scalarVecCandidate))
  ) {
    const resolvedVec = resolveIrVecType(recvType, cx);
    if (resolvedVec) {
      const vec = resolvedVec.lowering;
      const scalarVecReceiver = resolvedVec.valueType.kind === "i32" && vectorExpression;
      // Lower the index expression as f64 (JS Number semantics), then
      // truncate to i32 via the new `i32.trunc_sat_f64_s` IrUnop (slice
      // 12). Saturation handles NaN→0 and out-of-range values, matching
      // what test262's typical `arr[i]` patterns expect (i is always a
      // valid array index for IR-claimable functions).
      const idxF64 = lowerExpr(arg, cx, irVal({ kind: "f64" }));
      const idxF64Type = cx.builder.typeOf(idxF64);
      const idxValTy = asVal(idxF64Type);
      if (!idxValTy) {
        demoteToLegacy(
          "element-access-unsupported",
          `ir/from-ast: element-access index has unexpected IrType ${describeIrType(idxF64Type)} in ${cx.funcName}`,
        );
      }
      let idxI32: IrValueId;
      if (idxValTy.kind === "i32") {
        // Already i32 (e.g. a comparison or bool result — unusual but
        // possible for compound expressions). Use directly.
        idxI32 = idxF64;
      } else if (idxValTy.kind === "f64") {
        idxI32 = cx.builder.emitUnary("i32.trunc_sat_f64_s", idxF64, irVal({ kind: "i32" }));
      } else {
        demoteToLegacy(
          "element-access-unsupported",
          `ir/from-ast: element-access index must be number or bool (got ${idxValTy.kind}) in ${cx.funcName}`,
        );
      }
      const elemIr = resolvedVec.elementType;
      if (scalarVecReceiver && cx.emptyArrayInference.isResolvedVectorExpression(expr.expression)) {
        // The direct linear runtime historically uses a backend-specific zero
        // sentinel for OOB array reads, while the shared f64 vec path uses NaN
        // as the numeric image of JS `undefined`. Do not let inferred arrays
        // silently pick one representation: until shared IR has an explicit
        // undefined carrier, only lower reads covered by the existing counted-
        // loop bounds proof.
        if (!isProvenInBoundsIr(expr, cx)) {
          demoteToLegacy(
            "element-access-unsupported",
            `ir/from-ast: inferred linear vector read is not proven in bounds (${cx.funcName})`,
          );
        }
        const value = cx.builder.emitCall(irIntrinsicFuncRef("__arr_get"), [recv, idxI32], elemIr);
        if (value === null) {
          // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
          throw new Error(`ir/from-ast: forwarding-aware vec read produced no value (${cx.funcName})`);
        }
        return value;
      }
      // (#3734) Invariant R — a narrowed i32 vector widens back to the f64
      // every consumer of an element read expects. `scalarVecReceiver` (the
      // linear lane) never reaches here: that lane cannot register an i32 vec,
      // so `isNarrowedI32Vec` is false for it by construction.
      const narrowedI32 = isNarrowedI32Vec(vec, expr.expression, cx);
      // FAST path — proven in-bounds (counted-loop proof) → unchecked read.
      if (isProvenInBoundsIr(expr, cx)) {
        const raw = cx.builder.emitVecGet(recv, idxI32, elemIr);
        return narrowedI32 ? cx.builder.emitUnary("f64.convert_i32_s", raw, IR_F64) : raw;
      }
      if (elemIr.kind === "string") {
        demoteToLegacy(
          "element-access-unsupported",
          `ir/from-ast: native string vec read is not proven in bounds (${cx.funcName})`,
        );
      }
      // SAFE path — index not proven → bounds-checked read, no trap.
      if (narrowedI32) return emitSafeNarrowedI32VecGet(recv, idxI32, cx);
      return emitSafeVecGet(recv, idxI32, vec.elementValType, cx);
    }
  }

  // (#2972) String receiver with a PROVEN-in-bounds computed index: lower
  // through the SAME charAt machinery as `s.charAt(i)`. For an integer index
  // i with 0 ≤ i < s.length, `s[i]` ≡ `s.charAt(i)` exactly (§22.1.3.1 vs
  // §10.4.3 String-exotic indexed access — both yield the single code unit).
  // The PROOF is what makes typing the result `string` sound: an UNPROVEN
  // index could be out of bounds, where `s[i]` is `undefined` but charAt is
  // `""` — that residual deliberately stays on the demote path below (the
  // documented element-access claim-partial residual; see
  // plan/issues/2972-*.md for the widen-to-undefined alternative that was
  // rejected). Proof = receiver is a never-reassigned local bound to a
  // string literal (statically known length, `cx.stringLiteralLens`) AND the
  // index is a non-negative integer literal < len, or bit-masked by `& K`
  // with K < len (JS `x & K` = ToInt32 each, so for 0 ≤ K ≤ 2^31−1 the
  // result's set bits ⊆ K's bits ⇒ result ∈ [0, K] — the test262 harness
  // shape `hex[(n >> 4) & 0xf]` on a 16-char literal). BOTH lanes' helpers
  // are pre-registered by the #2972 element-access arm of the unified
  // collector scan (`declarations.ts`): it adds "charAt" to
  // `stringMethodNeeded`, whose finalize loop registers the `string_charAt`
  // env import (host lane) or calls `ensureNativeStringHelpers` for
  // `__str_charAt` (native lane) — no late-import shift at IR lower time.
  if (recvType.kind === "string" && ts.isIdentifier(expr.expression)) {
    const litLen = cx.stringLiteralLens?.get(expr.expression.text);
    if (litLen !== undefined && stringIndexProvenBelow(arg, litLen)) {
      const r = lowerStringMethodCall("charAt", recv, expr.expression, ts.factory.createNodeArray([arg]), cx);
      if (r !== null) return r;
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(`ir/from-ast: internal — charAt delegation produced no value in ${cx.funcName}`);
    }
  }

  // #3053 U1 / #2949 S5.4 — indexed read `recv[key]` on a boxed-any (dynamic)
  // receiver: route through the unified reader primitive
  // `__dyn_member_get(recv, key)` (#3053 U0). A string-literal key boxes as a
  // tag-5 string carrier; any other key is lowered concrete and boxed
  // (`boxConcreteToDynamic` — a numeric index boxes tag-3, and the helper's own
  // `__any_to_extern(key)` converts it to the decimal property key). `null` box
  // (an ambiguous key kind) demotes cleanly to the throw below.
  //
  // MECHANISM ONLY (see the twin arm in `lowerPropertyAccess`): the selector's
  // move-only scan rejects a dyn receiver in an element read until S5.P (U2),
  // so this arm is unreached in a claimed function today — byte-inert.
  if (recvType.kind === "dynamic") {
    let key: IrValueId | null;
    if (isStringLitKey) {
      const propName = (arg as ts.StringLiteral | ts.NoSubstitutionTemplateLiteral).text;
      key = cx.builder.emitBox(cx.builder.emitStringConst(propName), irDynamic(JS_TAG_IDS.String));
    } else {
      const idx = lowerExpr(arg, cx, irVal({ kind: "f64" }));
      const idxType = cx.builder.typeOf(idx);
      key = idxType.kind === "dynamic" ? idx : boxConcreteToDynamic(idx, idxType, arg, cx);
    }
    if (key !== null) {
      return cx.builder.emitDynMemberGet(recv, key);
    }
  }

  // (#3565) DESIGNED slice-12 residual demote — an element READ on a
  // receiver/index shape not yet in IR scope (e.g. `extern<HTMLCollection>[i]`)
  // must fall back to the legacy body. Typed UNSUPPORTED so it is not classified
  // as the untyped `unexpected-internal-throw` invariant that #3341/#3519
  // hard-error. (The internal `produced no value` / `unexpected IrType` throws
  // above are genuine invariants — they stay plain `Error` → hard.)
  throw new IrUnsupportedError(
    "element-access-unsupported",
    "build",
    `ir/from-ast: element access on ${describeIrType(recvType)} with index ${ts.SyntaxKind[arg.kind]} not in slice 12 (${cx.funcName})`,
  );
}

/**
 * Resolve a property name to a string. Identifier and StringLiteral keys
 * produce their text; NumericLiteral keys produce `.text`, already canonical.
 * ComputedPropertyName always returns null. Duplicated locally from select.ts
 * to avoid a circular import.
 *
 * (#4513) The object-literal DATA-PROPERTY site uses
 * `objectLiteralDataPropertyName` (leaf module `property-key-fold.ts`) instead,
 * so the computed-key fold is a single text shared with the selector rather
 * than a third copy here. The remaining callers below are method / prepared-
 * scope naming, which stays computed-name-rejecting.
 */
function phase1PropertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name)) return name.text;
  if (ts.isNumericLiteral(name)) return name.text;
  return null;
}

/**
 * #3000-E: the SSA value of the current `this` binding (the allocated instance
 * in a ctor, or the `__self` param in a method). Throws if `this` isn't bound —
 * `super` outside a class member never reaches here (the selector rejects it).
 */
function requireThisValue(cx: LowerCtx): IrValueId {
  const p = cx.scope.get("this");
  if (!p || p.kind !== "local") {
    demoteToLegacy("body-shape-rejected", `ir/from-ast: super used with no 'this' binding in ${cx.funcName}`);
  }
  return p.value;
}

/**
 * #3000-E: the parent `IrClassShape` for a `super(...)` / `super.method()` in the
 * current class member. Read from the `this` binding's class shape `.parent`,
 * which `buildIrClassShapes` populates only for a single-level subclass of a
 * local user class. Throws (→ clean legacy fallback) when absent — e.g. a
 * subclass whose parent's shape didn't project.
 */
function requireSuperParentShape(cx: LowerCtx): IrClassShape {
  const p = cx.scope.get("this");
  if (!p || p.kind !== "local" || p.type.kind !== "class") {
    demoteToLegacy("body-shape-rejected", `ir/from-ast: super used with no class 'this' binding in ${cx.funcName}`);
  }
  const parent = p.type.shape.parent;
  if (!parent) {
    demoteToLegacy(
      "body-shape-rejected",
      `ir/from-ast: super used in ${p.type.shape.className} which has no IR-projected parent shape (${cx.funcName})`,
    );
  }
  return parent;
}

function emitExpressionDefaultMissingF64(expected: IrType, cx: LowerCtx): IrValueId {
  if (asVal(expected)?.kind !== "f64") {
    demoteToLegacy(
      "param-shape-rejected",
      `ir/from-ast: expression-default sentinel requires an f64 parameter (${cx.funcName})`,
    );
  }
  const bits = cx.builder.emitConst({ kind: "i64", value: LEGACY_EXPRESSION_DEFAULT_F64_SENTINEL_BITS }, IR_I64);
  return cx.builder.emitUnary("f64.reinterpret_i64", bits, expected);
}

function importedMissingArgument(
  expected: IrType,
  optional: IrImportedOptionalParamPlan | undefined,
  cx: LowerCtx,
): IrValueId {
  const constant = optional?.constantDefault;
  if (constant?.kind === "f64") {
    return cx.builder.emitConst({ kind: "f64", value: constant.value }, expected);
  }
  if (constant?.kind === "i32") {
    return cx.builder.emitConst({ kind: "i32", value: constant.value }, expected);
  }

  const val = asVal(expected);
  if (val?.kind === "f64") {
    if (optional?.hasExpressionDefault) {
      // Exact legacy default-expression sentinel. Construct from its bits so
      // JS number canonicalization can never quiet/change the NaN payload.
      return emitExpressionDefaultMissingF64(expected, cx);
    }
    return cx.builder.emitConst({ kind: "f64", value: 0 }, expected);
  }
  if (val?.kind === "i32") {
    // i32 defaults use __argc to distinguish an absent arg from a supplied 0.
    return cx.builder.emitConst({ kind: "i32", value: 0 }, expected);
  }

  const hostExternCarrier =
    expected.kind === "extern" ||
    expected.kind === "callable" ||
    expected.kind === "string" ||
    expected.kind === "dynamic" ||
    val?.kind === "externref" ||
    val?.kind === "ref_extern";
  if (hostExternCarrier) {
    const undefinedValue = cx.builder.emitCall(irImportFuncRef("env", "__get_undefined"), [], expected);
    if (undefinedValue === null) {
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(`ir/from-ast: __get_undefined unexpectedly returned void (${cx.funcName})`);
    }
    return undefinedValue;
  }
  demoteToLegacy(
    "imported-call-planning-unsupported",
    `ir/from-ast: missing imported-call argument of ${describeIrType(expected)} is outside A+B1 (${cx.funcName})`,
  );
}

function lowerImportedCall(
  expr: ts.CallExpression,
  plan: IrImportedCallLoweringPlan,
  cx: LowerCtx,
  statementPosition: boolean,
): IrValueId | null {
  requireMatchingLoweringPlanOwner("imported call", plan.ownerUnitId, cx.ownerUnitId, cx.funcName);
  requireValidImportedCallTarget(plan);
  if (expr.arguments.length > plan.params.length || expr.arguments.some(ts.isSpreadElement)) {
    throw new Error(`ir/from-ast: imported call shape diverged after certification (${cx.funcName})`);
  }
  const args: IrValueId[] = [];
  for (let i = 0; i < plan.params.length; i++) {
    const expected = plan.params[i]!;
    let value: IrValueId;
    if (i < expr.arguments.length) {
      value = lowerExpr(expr.arguments[i]!, cx, expected);
      let actual = cx.builder.typeOf(value);
      if (
        actual.kind === "closure" &&
        expected.kind === "callable" &&
        closureSignatureEquals(actual.signature, expected.signature)
      ) {
        value = cx.builder.emitCallablePack(value, expected.signature);
        actual = cx.builder.typeOf(value);
      }
      value = timerArg(plan, expected, actual, value, () =>
        boxConcreteToDynamic(value, actual, expr.arguments[i]!, cx),
      );
      actual = cx.builder.typeOf(value);
      if (!irTypeAssignable(actual, expected)) {
        demoteToLegacy(
          "imported-call-planning-unsupported",
          `ir/from-ast: arg ${i} of imported call to ${plan.target.name} is ${describeIrType(actual)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
        );
      }
    } else {
      value = importedMissingArgument(expected, plan.optionalParams.get(i), cx);
    }
    args.push(value);
  }
  // Publish argc after argument evaluation to match legacy ordering.
  if (plan.needsArgc) {
    if (!plan.argcGlobal || plan.argcGlobal.binding.kind !== "runtime") {
      // invariant (producer-promise): the certified argc-sensitive plan promised the runtime global — #4502.
      throw new Error(`ir/from-ast: argc-sensitive call has no exact runtime global (${cx.funcName})`);
    }
    const argc = cx.builder.emitConst({ kind: "i32", value: expr.arguments.length }, irVal({ kind: "i32" }));
    cx.builder.emitGlobalSet(plan.argcGlobal, argc);
  } else if (plan.argcGlobal) {
    // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
    throw new Error(`ir/from-ast: argc-insensitive call unexpectedly carries runtime global state (${cx.funcName})`);
  }
  const result = cx.builder.emitCall(plan.target, args, plan.returnType);
  if (plan.source === "compiler-timer-shim") return timerResult(result, cx.builder, cx.funcName);
  if (result === null && !statementPosition) {
    unsupportedVoidCallExpression(
      `ir/from-ast: imported call to ${plan.target.name} returned void used as expression in ${cx.funcName}`,
    );
  }
  return result;
}
function makePromiseDelayLoweringHost(cx: LowerCtx): IrPromiseDelayLoweringHost {
  return {
    builder: cx.builder,
    funcName: cx.funcName,
    ownerUnitId: cx.ownerUnitId,
    lowerExpr: (expr, expected) => lowerExpr(expr, cx, expected),
    lowerClosure: (expr, signature, captures, exact) =>
      lowerClosureExpressionWithSignature(expr, signature, captures, cx, exact),
  };
}

function lowerCall(expr: ts.CallExpression, cx: LowerCtx, statementPosition = false): IrValueId | null {
  const promiseDelay = tryLowerPromiseDelayCall(expr, statementPosition, cx.promiseDelays, () =>
    makePromiseDelayLoweringHost(cx),
  );
  if (promiseDelay !== undefined) return promiseDelay;
  // Optional call (`fn?.()` / `obj?.method()`, #1281). The IR has no
  // short-circuit primitive for nullable callees, and at this point we
  // haven't yet lowered the callee/receiver to inspect its IrType. The
  // safe path is to throw to legacy, where `compileOptionalCallExpression`
  // already emits the null-guarded `if/else` block. The optional
  // PROPERTY-ACCESS path (`obj?.prop`) gets the IR fast-path; full
  // optional-call IR support is a follow-up.
  if (expr.questionDotToken) {
    demoteToLegacy("call-resolution-unsupported", `ir/from-ast: optional call (?.()) not in slice 11 (${cx.funcName})`);
  }
  const indirectEval = exactIndirectEvalStatement(expr);
  if (indirectEval) {
    const target = cx.resolver?.hostIndirectEvalTarget?.();
    if (
      !statementPosition ||
      cx.resolver?.jsHostExterns?.() !== true ||
      cx.resolver?.isAmbientBinding?.(indirectEval.evalIdentifier) !== true ||
      cx.scope.has("eval") ||
      cx.resolver?.stringIsExternref?.() !== true ||
      !target
    ) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "build",
        `ir/from-ast: certified host indirect eval lost an owning predicate (${cx.funcName})`,
      );
    }
    const source = lowerExpr(indirectEval.source, cx, { kind: "string" });
    if (cx.builder.typeOf(source).kind !== "string") {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "build",
        `ir/from-ast: certified host indirect eval source is not a string (${cx.funcName})`,
      );
    }
    const result = cx.builder.emitCall(
      target,
      [
        cx.builder.emitCoerceToExternref(source),
        cx.builder.emitConst({ kind: "i32", value: 0 }, irVal({ kind: "i32" })),
      ],
      irVal({ kind: "externref" }),
    );
    if (result === null) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "build",
        `ir/from-ast: host indirect eval provider returned void (${cx.funcName})`,
      );
    }
    // Statement-position lowering records this as a zero-use side-effecting
    // call; the backend emits the mandated Wasm `drop` for its externref result.
    return result;
  }
  const preparedPromiseAll = tryLowerPreparedAsyncPromiseAll({
    expression: expr,
    statementPosition,
    resolver: cx.resolver,
    builder: cx.builder,
    functionName: cx.funcName,
    lowerExpression: (expression, expected) => lowerExpr(expression, cx, expected),
  });
  if (preparedPromiseAll !== undefined) return preparedPromiseAll;
  // #3000-E: `super(args)` — a derived constructor chaining to its parent's
  // `_init`. Intercepted BEFORE the property-access / identifier dispatch below
  // because `super` is a keyword, not an identifier the receiver-lowering can
  // handle. The `this` binding (the allocated subclass instance) and the parent
  // shape (`this` shape's `.parent`) drive the emitted `<parent>_init` call.
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    const parentShape = requireSuperParentShape(cx);
    const self = requireThisValue(cx);
    if (expr.arguments.length !== parentShape.constructorParams.length) {
      demoteToLegacy(
        "call-arity-unsupported",
        `ir/from-ast: super(...) has ${expr.arguments.length} args, expected ${parentShape.constructorParams.length} in ${cx.funcName}`,
      );
    }
    const args: IrValueId[] = [];
    for (let i = 0; i < expr.arguments.length; i++) {
      const expected = parentShape.constructorParams[i]!;
      const argVal = lowerExpr(expr.arguments[i]!, cx, expected);
      const argType = cx.builder.typeOf(argVal);
      if (!irTypeEquals(argType, expected)) {
        demoteToLegacy(
          "call-resolution-unsupported",
          `ir/from-ast: super() arg ${i} is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
        );
      }
      args.push(argVal);
    }
    cx.builder.emitClassSuperInit(parentShape, self, args);
    return null;
  }
  // Slice 4 (#1169d): method call — `<recv>.<methodName>(args)`. The
  // receiver must lower to an IrType.class; the method must exist on
  // the class shape and be non-void (slice 4 only handles methods with
  // a returning result in expression position).
  if (ts.isPropertyAccessExpression(expr.expression)) {
    const r = lowerMethodCall(expr, cx);
    if (r === null) {
      // Unreachable: in expression position (statementPosition=false) every
      // void arm throws before returning null (#2856 added the null returns
      // for statement position only).
      unsupportedVoidCallExpression(
        `ir/from-ast: method call produced no result in expression position (${cx.funcName})`,
      );
    }
    return r;
  }
  if (!ts.isIdentifier(expr.expression)) {
    demoteToLegacy(
      "call-resolution-unsupported",
      `ir/from-ast: only direct calls supported in Phase 2 (${cx.funcName})`,
    );
  }
  const calleeName = expr.expression.text;

  // Slice 3 (#1169c): local-binding lookups WIN over top-level callees
  // because the source-level identifier resolution puts inner-scope
  // names first. The dispatcher picks one of three paths:
  //   - `local` binding whose IrType is closure/callable → closure.call
  //   - `nestedFunc` binding → direct call with prepended captures
  //   - top-level callee in calleeTypes → vanilla `call`
  const binding = cx.scope.get(calleeName);
  if (binding?.kind === "local" && (binding.type.kind === "closure" || binding.type.kind === "callable")) {
    return lowerClosureCall(binding.value, binding.type.signature, expr.arguments, cx, statementPosition);
  }
  if (binding?.kind === "nestedFunc") {
    return lowerNestedFuncCall(binding, expr.arguments, cx);
  }

  const imported = cx.importedCalls?.get(expr);
  if (imported) return lowerImportedCall(expr, imported, cx, statementPosition);

  const direct = cx.directCalls?.get(expr);
  if (!direct) {
    demoteToLegacy(
      "call-graph-closure",
      `ir/from-ast: direct call to "${calleeName}" has no exact AST-site plan in ${cx.funcName}`,
    );
  }
  requireMatchingLoweringPlanOwner("direct call", direct.ownerUnitId, cx.ownerUnitId, cx.funcName);
  const calleeSig = direct.signature;
  // Slice 8a (#1169g): spread args with statically-known sources
  // (ArrayLiteralExpression with no nested spread). Expand at compile
  // time to one IR arg per literal element. The pre-expansion arity
  // check below counts spread elements as their literal element count.
  const expandedArgExprs = expandStaticSpreadArgs(expr.arguments, cx);
  if (expandedArgExprs.length !== calleeSig.params.length) {
    demoteToLegacy(
      "call-arity-unsupported",
      `ir/from-ast: call to ${calleeName} has ${expandedArgExprs.length} args, expected ${calleeSig.params.length} in ${cx.funcName}`,
    );
  }
  const args: IrValueId[] = [];
  for (let i = 0; i < expandedArgExprs.length; i++) {
    const argExpr = expandedArgExprs[i]!;
    const expected = calleeSig.params[i]!;
    const staticNumericArray = cx.resolver?.staticNumericArrayRead?.(argExpr, expected) ?? null;
    let argVal =
      staticNumericArray === null
        ? lowerExpr(argExpr, cx, expected)
        : cx.builder.emitGlobalGet(staticNumericArray.globalRef, staticNumericArray.type);
    let argType = cx.builder.typeOf(argVal);
    // #3214 B0 — source-function callable params use externref, while closure
    // literals remain compiler-owned root-carrier refs. Cross that boundary
    // only for an exact signature match. Already-packed callables forward
    // unchanged; reverse or covariant conversions remain rejected below.
    if (
      argType.kind === "closure" &&
      expected.kind === "callable" &&
      closureSignatureEquals(argType.signature, expected.signature)
    ) {
      argVal = cx.builder.emitCallablePack(argVal, expected.signature);
      argType = cx.builder.typeOf(argVal);
    }
    // #2949 S5.P — a concrete value passed to an `any`/dynamic parameter
    // crosses the same explicit carrier boundary as a concrete equality
    // operand. Reuse the canonical tag-aware boxer; ambiguous refs/i32 values
    // still decline and demote through the existing assignability error.
    if (expected.kind === "dynamic" && argType.kind !== "dynamic") {
      const boxed = boxConcreteToDynamic(argVal, argType, argExpr, cx);
      if (boxed !== null) {
        argVal = boxed;
        argType = cx.builder.typeOf(argVal);
      }
    }
    // A dynamic value flowing into a proven numeric local ABI observes the
    // ordinary JavaScript ToNumber boundary. This keeps generic parser loops
    // dynamic at their public edge while allowing numeric helpers to retain
    // their grounded f64 signature.
    if (argType.kind === "dynamic" && asVal(expected)?.kind === "f64") {
      argVal = cx.builder.emitDynToNumber(argVal);
      argType = cx.builder.typeOf(argVal);
    }
    const dynamicExternBoundary =
      argType.kind === "dynamic" &&
      asVal(expected)?.kind === "externref" &&
      cx.resolver?.dynamicCarrierIsExternref?.() === true &&
      cx.funcName === "stringToNumber" &&
      (calleeName === "parseInt" || calleeName === "parseFloat") &&
      i === 0;
    if (!dynamicExternBoundary && !irTypeAssignable(argType, expected)) {
      demoteToLegacy(
        "call-resolution-unsupported",
        `ir/from-ast: arg ${i} of call to ${calleeName} is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  const result = cx.builder.emitCall(direct.target, args, calleeSig.returnType);
  if (result === null) {
    // (#2856 C4) `quicksort(arr, lo, p - 1);` — a void direct call in
    // STATEMENT position is legal (the recursion driver shape). Expression
    // position keeps throwing.
    if (statementPosition) return null;
    unsupportedVoidCallExpression(
      `ir/from-ast: call to ${calleeName} returned void used as expression in ${cx.funcName}`,
    );
  }
  return result;
}

/**
 * (#2856 C4) Wasm-level assignability for direct-call arguments. Exact
 * IrType equality, plus sound widenings: a tag-refined dynamic carrier into
 * an unrefined dynamic parameter, and the vec-literal-as-argument shape's
 * NON-NULL `(ref $T)` value into `(ref null $T)`. The reverse directions stay
 * rejected.
 */
function irTypeAssignable(actual: IrType, expected: IrType): boolean {
  if (irTypeEquals(actual, expected)) return true;
  if (actual.kind === "dynamic" && expected.kind === "dynamic" && expected.tag === undefined) return true;
  if (
    actual.kind === "vec" &&
    expected.kind === "vec" &&
    !actual.nullable &&
    expected.nullable &&
    irTypeEquals(actual.elementType, expected.elementType)
  ) {
    return true;
  }
  const a = asVal(actual);
  const e = asVal(expected);
  if (
    a !== null &&
    e !== null &&
    a.kind === "ref" &&
    e.kind === "ref_null" &&
    (a as { typeIdx: number }).typeIdx === (e as { typeIdx: number }).typeIdx
  ) {
    return true;
  }
  // (#3144) class<Sub> flows into a class<Parent> param when Parent is on
  // Sub's projected parent chain: legacy registers the subclass struct as a
  // declared WasmGC subtype of the parent struct (#3000-E — `(ref $Sub)`
  // already flows into `(ref $Parent)` for `super(...)`), so the raw call
  // typechecks with no coercion. `shape.parent` is present exactly for the
  // single-level local subclasses whose parent projected — the sound set.
  if (actual.kind === "class" && expected.kind === "class") {
    for (let s = actual.shape.parent; s; s = s.parent) {
      if (s.classId === expected.shape.classId) return true;
    }
  }
  return false;
}

/**
 * Slice 8a (#1169g): expand spread args at compile time. The selector
 * (`isStaticSpreadSource`) restricts spread sources to
 * `ArrayLiteralExpression` with no nested SpreadElement, so each spread
 * arg has a known element count and we can inline its elements as
 * additional 1:1 args. Non-spread args pass through unchanged.
 *
 * The result is a parallel `Expression[]` whose length equals the
 * post-expansion arity. The caller's existing 1:1 `lowerExpr`-per-arg
 * loop runs against the returned array.
 *
 * Defensive: any spread whose source isn't an ArrayLiteral throws
 * (selector should have rejected, but a clean throw routes to legacy
 * if a regression slips in).
 */
function expandStaticSpreadArgs(args: readonly ts.Expression[], cx: LowerCtx): ts.Expression[] {
  const out: ts.Expression[] = [];
  for (const a of args) {
    if (ts.isSpreadElement(a)) {
      if (!ts.isArrayLiteralExpression(a.expression)) {
        demoteToLegacy(
          "call-resolution-unsupported",
          `ir/from-ast: dynamic-length spread args not in slice 8a (${ts.SyntaxKind[a.expression.kind]} in ${cx.funcName})`,
        );
      }
      for (const e of a.expression.elements) {
        if (ts.isSpreadElement(e) || ts.isOmittedExpression(e)) {
          demoteToLegacy(
            "call-resolution-unsupported",
            `ir/from-ast: nested spread / sparse element inside spread arg not in slice 8a (${cx.funcName})`,
          );
        }
        out.push(e);
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Slice 3 / #3214 B0: lower a call-by-value to an internal closure or a
 * boundary callable binding. The lowered `closure.call` emits canonical-root
 * self, args, root self again, field-0 funcref extraction, and call_ref.
 * Boundary callables unpack externref through a root cast on each self use;
 * `collectIrUses`'s double count forces the source SSA value into a local.
 */
function isUnshadowedUndefinedExpression(expr: ts.Expression, cx: LowerCtx): boolean {
  let candidate = expr;
  while (ts.isParenthesizedExpression(candidate)) candidate = candidate.expression;
  return (
    ts.isIdentifier(candidate) &&
    candidate.text === "undefined" &&
    !cx.scope.has("undefined") &&
    cx.resolver?.resolveModuleBinding?.(candidate) === undefined
  );
}

function lowerClosureCall(
  callee: IrValueId,
  signature: IrClosureSignature,
  argExprs: readonly ts.Expression[],
  cx: LowerCtx,
  statementPosition = false,
): IrValueId | null {
  if (signature.returnType === null && !statementPosition) {
    unsupportedVoidCallExpression(`ir/from-ast: void closure calls are not in value position scope (${cx.funcName})`);
  }
  const expandedArgExprs = expandStaticSpreadArgs(argExprs, cx);
  const defaultParamStart = signature.defaultParamStart ?? signature.params.length;
  if (expandedArgExprs.length < defaultParamStart || expandedArgExprs.length > signature.params.length) {
    demoteToLegacy("call-arity-unsupported", `ir/from-ast: closure call arity mismatch in ${cx.funcName}`);
  }
  const args: IrValueId[] = [];
  for (let i = 0; i < signature.params.length; i++) {
    const expected = signature.params[i]!;
    const argument = expandedArgExprs[i];
    const argVal =
      i >= defaultParamStart && (argument === undefined || isUnshadowedUndefinedExpression(argument, cx))
        ? emitExpressionDefaultMissingF64(expected, cx)
        : lowerExpr(argument!, cx, expected);
    if (!irTypeAssignable(cx.builder.typeOf(argVal), expected)) {
      demoteToLegacy(
        "call-resolution-unsupported",
        `ir/from-ast: closure arg ${i} type mismatch (expected ${describeIrType(expected)}, got ${describeIrType(cx.builder.typeOf(argVal))}) in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  return cx.builder.emitClosureCall(callee, args, signature.returnType);
}

/**
 * Slice 3 (#1169c): lower a call to a nested function declaration.
 * Prepends capture args to the user args and emits a direct `call`
 * (no struct, no funcref) — matches the legacy
 * `compileNestedFunctionDeclaration` pattern.
 *
 * Mutable captures: if the outer hasn't already wrapped the variable
 * in a refcell (because no closure-VALUE has been built that captured
 * it as mutable), wrap it here and rebind `cx.scope[name]` so subsequent
 * outer reads/writes go through the cell.
 */
function lowerNestedFuncCall(
  binding: {
    kind: "nestedFunc";
    target: IrFuncRef;
    signature: IrClosureSignature;
    captures: readonly NestedCapture[];
  },
  argExprs: readonly ts.Expression[],
  cx: LowerCtx,
): IrValueId {
  if (binding.signature.returnType === null) {
    unsupportedVoidCallExpression(`ir/from-ast: void nested calls are not in value position scope (${cx.funcName})`);
  }
  if (argExprs.length !== binding.signature.params.length) {
    demoteToLegacy("call-arity-unsupported", `ir/from-ast: nested func call arity mismatch in ${cx.funcName}`);
  }
  const args: IrValueId[] = [];
  for (const cap of binding.captures) {
    const live = cx.scope.get(cap.name);
    if (cap.mutable) {
      if (live?.kind === "local" && live.type.kind === "boxed") {
        args.push(live.value);
      } else if (live?.kind === "local") {
        const innerVal = asVal(cap.type);
        if (!innerVal) {
          demoteToLegacy(
            "call-resolution-unsupported",
            `ir/from-ast: mutable nested capture "${cap.name}" must be a primitive (${cx.funcName})`,
          );
        }
        const cell = cx.builder.emitRefCellNew(live.value, innerVal);
        // #1926 — boxed.inner is an IrType; wrap the scalar ValType with irVal.
        cx.scope.set(cap.name, { kind: "local", value: cell, type: { kind: "boxed", inner: irVal(innerVal) } });
        args.push(cell);
      } else {
        demoteToLegacy(
          "call-resolution-unsupported",
          `ir/from-ast: nested mutable capture "${cap.name}" not in scope (${cx.funcName})`,
        );
      }
    } else {
      // Read-only capture — read the CURRENT value from outer scope. If
      // an earlier sibling's mutable capture upgraded the binding to a
      // refcell, deref through it.
      if (live?.kind === "local" && live.type.kind === "boxed") {
        const v = cx.builder.emitRefCellGet(live.value, live.type.inner);
        args.push(v);
      } else if (live?.kind === "local") {
        args.push(live.value);
      } else {
        demoteToLegacy(
          "call-resolution-unsupported",
          `ir/from-ast: nested capture "${cap.name}" not in scope (${cx.funcName})`,
        );
      }
    }
  }
  for (let i = 0; i < argExprs.length; i++) {
    const expected = binding.signature.params[i]!;
    const argVal = lowerExpr(argExprs[i]!, cx, expected);
    if (!irTypeEquals(cx.builder.typeOf(argVal), expected)) {
      demoteToLegacy(
        "call-resolution-unsupported",
        `ir/from-ast: nested arg ${i} type mismatch (expected ${describeIrType(expected)}, got ${describeIrType(cx.builder.typeOf(argVal))}) in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  if (binding.target.binding.kind !== "unit") {
    // invariant (producer-promise): identity resolution promised an exact unit — #4502.
    throw new Error(`ir/from-ast: nested function target ${binding.target.name} is not an exact lifted unit`);
  }
  const r = cx.builder.emitCall(binding.target, args, binding.signature.returnType);
  if (r === null) {
    unsupportedVoidCallExpression(`ir/from-ast: nested call returned void in ${cx.funcName}`);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Class lowering (#1169d — IR Phase 4 Slice 4)
// ---------------------------------------------------------------------------

/**
 * Slice 4 (#1169d): lower a `new ClassName(args)` expression.
 *
 * The class shape is looked up against `cx.classShapes`. Argument types
 * must match the constructor's declared `constructorParams`. Generic
 * type-arguments are normally rejected by the selector; #3517 admits only a
 * checker-certified direct module `const Map<K, V>` initializer because those
 * arguments are erased and its extern storage/constructor ABI is already
 * proven.
 *
 * Returns the SSA value of the constructed instance — its IrType is
 * `{ kind: "class", shape }` so subsequent property accesses / method
 * calls dispatch correctly.
 */
function lowerNewExpression(expr: ts.NewExpression, cx: LowerCtx): IrValueId {
  const promiseDelay = tryLowerPromiseDelayConstruction(expr, cx.promiseDelays, () => makePromiseDelayLoweringHost(cx));
  if (promiseDelay !== undefined) return promiseDelay;
  const primitiveWrapper = lowerPrimitiveWrapperConstruction(expr, cx);
  if (primitiveWrapper !== null) return primitiveWrapper.value;
  // (#4461) `new Map()` on a lane whose `Map` carrier is the native `$Map`
  // struct. Intercepted before the extern-class registry, which has no `Map`
  // entry at all in host-free mode — the pre-#4461 behaviour was the
  // `unknown-class-construction` demote at the bottom of this function.
  // The storage type is obtained INSIDE, after the `new Map()` shape is proven
  // — asking first materialized the whole `$Map` runtime on every `new`.
  const nativeMap = tryLowerNativeMapConstruction(expr, cx);
  if (nativeMap !== null) return nativeMap;
  if (!ts.isIdentifier(expr.expression)) {
    demoteToLegacy(
      "unknown-class-construction",
      `ir/from-ast: only direct constructor names supported in slice 4 (${cx.funcName})`,
    );
  }
  const className = expr.expression.text;
  if (cx.resolver?.isDirectModuleBinding?.(expr.expression) === true) {
    demoteToLegacy(
      "unknown-class-construction",
      `ir/from-ast: module binding "${className}" is not a direct constructor (${cx.funcName})`,
    );
  }

  if (className === "Array" && cx.resolver?.isHoleyArrayConstructor?.(expr) === true) {
    if ((expr.typeArguments?.length ?? 0) !== 0 || expr.arguments?.length !== 1) {
      throw new IrUnsupportedError(
        "array-representation-unsupported",
        "build",
        `ir/from-ast: sparse Array constructor shape diverged after selection (${cx.funcName})`,
      );
    }
    const lengthExpr = expr.arguments[0]!;
    if (ts.isSpreadElement(lengthExpr) || !ts.isNumericLiteral(lengthExpr)) {
      throw new IrUnsupportedError(
        "array-representation-unsupported",
        "build",
        `ir/from-ast: sparse Array length is not the selected literal (${cx.funcName})`,
      );
    }
    const length = Number(lengthExpr.text.replace(/_/g, ""));
    if (!Number.isInteger(length) || length < 0 || length > 0x7fff_ffff) {
      throw new IrUnsupportedError(
        "array-representation-unsupported",
        "build",
        `ir/from-ast: sparse Array length escaped the bounded range (${cx.funcName})`,
      );
    }
    const lengthRaw = lowerExpr(lengthExpr, cx, irVal({ kind: "f64" }));
    const lengthType = asVal(cx.builder.typeOf(lengthRaw));
    const lengthI32 =
      lengthType?.kind === "i32"
        ? lengthRaw
        : cx.builder.emitUnary("i32.trunc_sat_f64_s", lengthRaw, irVal({ kind: "i32" }));
    const result = cx.builder.emitCall(
      irIntrinsicFuncRef(IR_HOLEY_ARRAY_NEW),
      [lengthI32],
      irVec(irVal({ kind: "externref" }), true),
    );
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    if (result === null) throw new Error(`ir/from-ast: sparse Array allocator returned void (${cx.funcName})`);
    return result;
  }

  // Slice 10 (#1169i): host extern class (RegExp, Uint8Array, …) normally
  // takes priority over the slice-4 class registry — except when this exact
  // constructor name has a source-owned class shape. In that case checker-
  // backed selection already proved the identifier resolves to the local
  // class (for example `class Date { ... }`), so construction must use the
  // local shape rather than the ambient extern registry's name-only entry.
  // Aliases and non-class shadows have no matching shape and retain the loud
  // extern-shadow invariant below.
  const shape = cx.classShapes?.get(className);
  const externInfo = cx.resolver?.getExternClassInfo?.(className);
  if (externInfo && !shape) {
    if (cx.resolver?.isAmbientBinding?.(expr.expression) === false) {
      demoteToLegacy(
        "unknown-class-construction",
        `ir/from-ast: extern constructor "${className}" is shadowed (${cx.funcName})`,
      );
    }
    const argExprs = expr.arguments ?? [];
    // Constructor arity is permissive: the legacy host imports often
    // accept fewer args than `constructorParams` reports (the optional
    // / overload arms collapse). We don't enforce a strict equality
    // here — extra args are an error, but missing args silently pad
    // with sentinel values matching the legacy convention. For step A
    // (RegExp), `new RegExp(pattern)` and `new RegExp(pattern, flags)`
    // are both valid; for slice-10 step C (TypedArrays), `new
    // Uint8Array(N)` matches a single-param overload.
    if (argExprs.length > externInfo.constructorParams.length) {
      demoteToLegacy(
        "constructor-arity-unsupported",
        `ir/from-ast: new ${className}(...) has ${argExprs.length} args, max ${externInfo.constructorParams.length} in ${cx.funcName}`,
      );
    }
    const args: IrValueId[] = [];
    for (let i = 0; i < argExprs.length; i++) {
      const expectedTy = externInfo.constructorParams[i]!;
      const hint = irVal(expectedTy);
      const argVal = lowerExpr(argExprs[i]!, cx, hint);
      args.push(coerceToExpectedExtern(argVal, expectedTy, cx, `arg ${i} of new ${className}`));
    }
    // Pad missing optional args with default sentinels so the host
    // `<className>_new` import receives the right Wasm arity. Mirrors
    // the legacy `compileNewExpression` extern path (see
    // `src/codegen/expressions/new-super.ts:2200-2203`'s
    // `pushDefaultValue` loop). For step A (RegExp): missing flags arg
    // pads as `ref.null.extern`, which the host's `RegExp_new` stub
    // converts to `undefined` flags via the JS host import shim — JS
    // accepts `new RegExp(p, undefined)` as "no flags" while rejecting
    // `new RegExp(p, null)` as TypeError "Invalid flags 'null'". The
    // legacy uses `emitUndefinedValue` for the same reason; the IR
    // path leans on the host import shim's null-vs-undefined treatment
    // (the shim treats `ref.null.extern` as undefined).
    for (let i = argExprs.length; i < externInfo.constructorParams.length; i++) {
      const expectedTy = externInfo.constructorParams[i]!;
      args.push(emitDefaultExternArg(cx, expectedTy));
    }
    return cx.builder.emitExternNew(externInfo.className, args, externInfo.importPrefix);
  }

  if (!shape) {
    demoteToLegacy("unknown-class-construction", `ir/from-ast: unknown class "${className}" in ${cx.funcName}`);
  }
  const argExprs = expr.arguments ?? [];
  if (argExprs.length !== shape.constructorParams.length) {
    demoteToLegacy(
      "constructor-arity-unsupported",
      `ir/from-ast: new ${className}(...) has ${argExprs.length} args, expected ${shape.constructorParams.length} in ${cx.funcName}`,
    );
  }
  const args: IrValueId[] = [];
  for (let i = 0; i < argExprs.length; i++) {
    const expected = shape.constructorParams[i]!;
    const argVal = lowerExpr(argExprs[i]!, cx, expected);
    const argType = cx.builder.typeOf(argVal);
    if (!irTypeEquals(argType, expected)) {
      demoteToLegacy(
        "unknown-class-construction",
        `ir/from-ast: arg ${i} of new ${className}(...) is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  return cx.builder.emitClassNew(shape, args);
}

type PrimitiveWrapperConstructorName = "Boolean" | "Number" | "String";

interface LoweredPrimitiveWrapper {
  readonly kind: PrimitiveWrapperConstructorName;
  readonly value: IrValueId;
}

/**
 * #4208 S4 — checker-identity-backed ambient primitive-wrapper constructor.
 * Selection admits this only as one operand of the bounded loose-equality
 * producer; keeping the recognizer here exact prevents a textual shadow from
 * being routed to the runtime wrapper family.
 */
function primitiveWrapperConstructorName(
  expression: ts.Expression,
  cx: LowerCtx,
): PrimitiveWrapperConstructorName | null {
  const candidate = peelParensExpr(expression);
  if (!ts.isNewExpression(candidate) || !ts.isIdentifier(candidate.expression)) return null;
  const name = candidate.expression.text;
  if (name !== "Boolean" && name !== "Number" && name !== "String") return null;
  const ambient =
    name === "String"
      ? cx.resolver?.isAmbientStringBinding?.(candidate.expression) === true
      : cx.resolver?.isAmbientBinding?.(candidate.expression) === true;
  return ambient ? name : null;
}

/**
 * Materialize the real wrapper object through the existing host/native
 * constructor provider. The result stays branded `extern:Object`: loose
 * equality must still run the canonical `__to_primitive` protocol and may not
 * substitute the constructor argument as an AST shortcut.
 */
function lowerPrimitiveWrapperConstruction(expr: ts.NewExpression, cx: LowerCtx): LoweredPrimitiveWrapper | null {
  const kind = primitiveWrapperConstructorName(expr, cx);
  if (kind === null) return null;
  const args = expr.arguments ?? [];
  if (args.length !== 1 || ts.isSpreadElement(args[0]!)) {
    throw new IrUnsupportedError(
      "constructor-arity-unsupported",
      "build",
      `ir/from-ast: primitive wrapper ${kind} requires one exact primitive argument in ${cx.funcName}`,
    );
  }

  let argument: IrValueId;
  if (kind === "Number") {
    argument = lowerExpr(args[0]!, cx, irVal({ kind: "f64" }));
    if (asVal(cx.builder.typeOf(argument))?.kind !== "f64") {
      demoteToLegacy("unknown-class-construction", `ir/from-ast: new Number argument is not f64 in ${cx.funcName}`);
    }
  } else if (kind === "Boolean") {
    const boolean = lowerExpr(args[0]!, cx, irVal({ kind: "i32", boolean: true }));
    if (asVal(cx.builder.typeOf(boolean))?.kind !== "i32") {
      demoteToLegacy("unknown-class-construction", `ir/from-ast: new Boolean argument is not i32 in ${cx.funcName}`);
    }
    argument = cx.builder.emitUnary("f64.convert_i32_s", boolean, irVal({ kind: "f64" }));
  } else {
    const string = lowerExpr(args[0]!, cx, { kind: "string" });
    if (cx.builder.typeOf(string).kind !== "string") {
      demoteToLegacy("unknown-class-construction", `ir/from-ast: new String argument is not string in ${cx.funcName}`);
    }
    argument = cx.builder.emitCoerceToExternref(string);
  }

  const resultType: IrType = { kind: "extern", className: "Object" };
  const value = cx.builder.emitCall(irRuntimeFuncRef(`__new_${kind}`), [argument], resultType);
  if (value === null) {
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error(`ir/from-ast: __new_${kind} produced no value in ${cx.funcName}`);
  }
  return { kind, value };
}

/**
 * Slice 10 (#1169i) — coerce an SSA value to the ValType expected by an
 * extern-class import param. The legacy host imports take ValType-typed
 * params (most often `externref` for ref-shaped args, `f64` for numeric
 * args). The IR's static types may not match exactly:
 *   - `IrType.string` in host-strings mode is already externref → no-op.
 *   - `IrType.string` in native-strings mode is `(ref $AnyString)` → the
 *     verifier would reject the type mismatch, so for slice-10 we reject
 *     this case and fall back to legacy. (TODO follow-up: thread native-
 *     strings string args through `extern.convert_any` before the call.)
 *   - `IrType.extern { ... }` is externref → no-op when expected is
 *     externref.
 *   - `IrType.val { f64 }` matches `f64`.
 *   - Mismatches throw and the function falls back to legacy.
 *
 * Returns the (possibly identical) SSA value to push.
 */
/**
 * Slice 10 (#1169i) — emit a default sentinel SSA value for a missing
 * optional arg in an extern-class constructor or method call. Mirrors
 * `pushDefaultValue` in `src/codegen/type-coercion.ts:2093` for the
 * subset of ValTypes the IR's extern path encounters:
 *   - externref → `ref.null.extern` (host shim treats as `undefined`)
 *   - f64 → `0`
 *   - i32 → `0`
 *   - i64 → `0n`
 * Other ValTypes throw — slice 10 doesn't see them in the legacy
 * extern-class signatures we deal with.
 */
function emitDefaultExternArg(cx: LowerCtx, expected: ValType): IrValueId {
  switch (expected.kind) {
    case "externref":
      return cx.builder.emitConst({ kind: "null", ty: irVal(expected) }, irVal(expected));
    case "f64":
      return cx.builder.emitConst({ kind: "f64", value: 0 }, irVal(expected));
    case "i32":
      return cx.builder.emitConst({ kind: "i32", value: 0 }, irVal(expected));
    case "i64":
      return cx.builder.emitConst({ kind: "i64", value: 0n }, irVal(expected));
    default:
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: cannot pad default arg of type ${expected.kind} (${cx.funcName})`,
      );
  }
}

function coerceToExpectedExtern(
  value: IrValueId,
  expected: ValType,
  cx: LowerCtx,
  where: string,
  boundary?: "native-string" | "dom-handle",
): IrValueId {
  const t = cx.builder.typeOf(value);
  // Same-kind val match (e.g. f64 → f64).
  const got = asVal(t);
  if (got && got.kind === expected.kind) {
    return value;
  }
  // String → externref: when the string carrier IS externref (host-strings
  // mode), the verifier sees the SSA type as `string` but the Wasm valtype
  // is externref so the host call accepts it transparently. We keep the
  // SSA type as-is and rely on the lowerer's ValType resolution. When the
  // carrier is the native `(ref $AnyString)` struct, a string can never
  // satisfy an externref host-arg position → fall through to the demote
  // throw. (#2955 slice 3: the rep question is resolver-owned —
  // `stringIsExternref` — so from-ast reads no `nativeStrings` here. The
  // `!== false` polarity deliberately preserves the legacy resolver-absent
  // default of this site's old `!cx.resolver?.nativeStrings?.()` read:
  // no resolver → host-shaped → pass-through.)
  if (expected.kind === "externref" && t.kind === "string" && cx.resolver?.stringIsExternref?.() !== false) {
    return value;
  }
  // #4576 — the authenticated dom@1 adapter is the sole host boundary that
  // accepts the native `$AnyString` carrier. The Wasm import still receives an
  // externref, but the lifecycle-pinned adapter decodes it through the narrow
  // readout pair before touching the DOM. No other host call may opt into this.
  if (expected.kind === "externref" && t.kind === "string" && boundary === "native-string") {
    return cx.builder.emitCoerceToExternref(value);
  }
  // extern → externref: extern values are externref-shaped.
  if (expected.kind === "externref" && t.kind === "extern") {
    return value;
  }
  // (#2856 C3) f64 → externref: box through the `__box_number` host import —
  // the exact coercion legacy's `coerceType` emits for the same site (so the
  // import is registered by legacy's own compile of the function in the
  // dual-compile model). Gated on the resolver's number-box CAPABILITY
  // (#2955): standalone has no `__box_number` (its boxing is the `$AnyValue`
  // family), so the predicate is false there and we fall to the demote throw.
  if (
    expected.kind === "externref" &&
    got !== null &&
    got.kind === "f64" &&
    cx.resolver?.hasHostNumberBox?.() === true
  ) {
    const boxed = cx.builder.emitCall(irImportFuncRef("env", "__box_number"), [value], irVal({ kind: "externref" }));
    if (boxed === null) {
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(`ir/from-ast: __box_number produced no result in ${cx.funcName}`);
    }
    return boxed;
  }
  // Boolean-branded i32 -> externref: preserve JS identity by using the
  // boolean boxer. An unbranded i32 is intentionally not accepted here: that
  // carrier may represent an integer-shaped number or a symbol handle, whose
  // boxing semantics differ.
  if (
    expected.kind === "externref" &&
    got !== null &&
    got.kind === "i32" &&
    got.boolean === true &&
    cx.resolver?.hasHostBooleanBox?.() === true
  ) {
    const boxed = cx.builder.emitCall(irImportFuncRef("env", "__box_boolean"), [value], irVal({ kind: "externref" }));
    if (boxed === null) {
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(`ir/from-ast: __box_boolean produced no result in ${cx.funcName}`);
    }
    return boxed;
  }
  // (#3553) A leftover mismatch here is DESIGNED non-claimability, not a
  // compiler invariant: the doc block above explicitly rejects e.g. a native-
  // strings `(ref $AnyString)` value in an externref host-arg position so the
  // function "falls back to legacy" (which owns the native lowering — for
  // `new RegExp`/`RegExp.test` under `target: standalone` that is the native
  // regex engine). #3483's typed-outcome boundary classifies any plain
  // `Error` escaping build as `invariant`/`unexpected-internal-throw` — a
  // HARD compile error — which turned this designed fallback into a CE
  // (80/178 red in tests/issue-1539-standalone-regex.test.ts). Throw the
  // typed Unsupported error instead, like the sibling coercion sites #3483
  // itself migrated (see the `operand-coercion-unsupported` throws below).
  throw new IrUnsupportedError(
    "operand-coercion-unsupported",
    "build",
    `ir/from-ast: ${where} expects ${expected.kind} but got ${describeIrType(t)} (${cx.funcName})`,
  );
}

/**
 * Slice 4 (#1169d): lower `<recv>.<methodName>(args)` on a class
 * receiver. The receiver is lowered first (so we can inspect its
 * IrType); the method's signature is looked up against the receiver's
 * class shape; argument types must match. Returns the SSA value of the
 * call result — throws if the method is void (slice 4 rejects void
 * methods in expression position; statement-position void calls go
 * through the bare ExpressionStatement path).
 *
 * Receivers of any IrType other than `class` fall through to a clean
 * error, letting the function fall back to legacy.
 */
/**
 * (#4462) `<f64>.toString()` through the lane's HOST-FREE formatter.
 *
 * #2955 slice 4 deferred exactly this as "a native number formatter returning
 * the `(ref $AnyString)` carrier"; #3912 built the formatter for legacy, so the
 * only missing piece was an IR-visible callable whose ABI is that carrier rather
 * than the host import's externref. The resolver owns both the availability
 * question (`nativeNumberToStringAvailable`) and the provider
 * (`IR_NUMBER_TO_STRING_NATIVE_FN` → the unwrap adapter), so this reads no mode
 * flag and the result is `IrType.string` with no fix-up at this layer.
 *
 * Disjoint from the host-import arm by construction — that one is gated on
 * `!nativeStrings`, this one on `nativeStrings` — so a single call can never be
 * claimed twice.
 */
function lowerNativeNumberToString(value: IrValueId, funcName: string, cx: LowerCtx): IrValueId {
  const r = cx.builder.emitCall(irRuntimeFuncRef(IR_NUMBER_TO_STRING_NATIVE_FN), [value], { kind: "string" });
  if (r === null) throw new Error(`ir/from-ast: native number_toString produced no result in ${funcName}`);
  return r;
}

/**
 * (#4462) Render one already-lowered `console.<m>` argument to `IrType.string`
 * for the host-free sink.
 *
 * Dispatch is on the LOWERED IR type, not the checker type — deliberately, and
 * for the same reason `emitStandaloneStdoutAppendValue` dispatches on the
 * compiled ValType (#3469): the static type of a `console.log` argument can be
 * `any` while the value that actually arrives is a native string. Carriers with
 * no host-free rendering demote through the typed UNSUPPORTED channel rather
 * than silently printing nothing.
 */
function lowerHostFreeConsoleArgument(value: IrValueId, cx: LowerCtx, methodName: string): IrValueId {
  const valueType = cx.builder.typeOf(value);
  if (valueType.kind === "string") return value;
  if (valueType.kind === "val" && valueType.val.kind === "f64") {
    if (cx.resolver?.nativeNumberToStringAvailable?.() !== true) {
      throw new IrUnsupportedError(
        "primitive-method-unsupported",
        "build",
        `ir/from-ast: console.${methodName} numeric argument needs a host-free number formatter (${cx.funcName})`,
      );
    }
    return lowerNativeNumberToString(value, cx.funcName, cx);
  }
  // A number that propagation narrowed to i32 is still a number; widen and use
  // the same formatter so `console.log(x|0)` prints what `x.toString()` would.
  // `boolean: true` is excluded — a boolean prints "true"/"false", not "1"/"0",
  // and that rendering is not in this slice.
  if (valueType.kind === "val" && valueType.val.kind === "i32" && valueType.val.boolean !== true) {
    const widened = cx.builder.emitUnary("f64.convert_i32_s", value, irVal({ kind: "f64" }));
    return lowerHostFreeConsoleArgument(widened, cx, methodName);
  }
  throw new IrUnsupportedError(
    "method-call-unsupported",
    "build",
    `ir/from-ast: console.${methodName} argument of type ${describeIrType(valueType)} has no host-free rendering (${cx.funcName})`,
  );
}

/**
 * (#4462) `console.<m>(arg)` with NO JS host: render the argument to the native
 * string carrier and append it to the in-module `__stdout_acc` rope — #3469's
 * sink, the one legacy already uses at `--target standalone`, kept host-free so
 * #2961's import-leak gate stays green.
 *
 * The trailing newline is CONCATENATED rather than appended by a second call, so
 * one console call produces one rope node. Output is identical to legacy's
 * append-arg-then-append-"\n" either way; this just costs one call instead of
 * two. Statement-position only, so there is no value to return.
 */
function lowerHostFreeConsoleCall(argExpr: ts.Expression, cx: LowerCtx, methodName: string): null {
  const argVal = lowerExpr(argExpr, cx, { kind: "string" });
  const rendered = lowerHostFreeConsoleArgument(argVal, cx, methodName);
  const line = cx.builder.emitStringConcat(rendered, cx.builder.emitStringConst("\n"));
  cx.builder.emitCall(irRuntimeFuncRef(IR_CONSOLE_SINK_APPEND_FN), [line], null);
  return null;
}

/**
 * (#680) Typed UNSUPPORTED throw for a method call the IR method-call lowering
 * does not yet handle, mirroring the sibling property-write "not in slice 4"
 * throw (see `ir/from-ast: property assignment ... not in slice 4`). A plain
 * `Error` here would classify as the untyped `unexpected-internal-throw`
 * invariant, which #3341/#3519 promote to a HARD compile error — regressing e.g.
 * a standalone `g.next()` from a legacy demotion to a compile failure. A
 * not-yet-adopted lowering is UNSUPPORTED → warning/legacy.
 */
function throwMethodCallNotInSlice(methodName: string, recvType: IrType, funcName: string): never {
  throw new IrUnsupportedError(
    "method-call-unsupported",
    "build",
    `ir/from-ast: method call .${methodName}(...) on ${describeIrType(recvType)} not in slice 4 (${funcName})`,
  );
}

function lowerPreparedAsyncDateNow(
  expr: ts.CallExpression,
  cx: LowerCtx,
  methodName: string,
  receiverIdentifier: ts.Identifier | undefined,
): IrValueId | null {
  const target = cx.resolver?.preparedAsyncDateNowTarget?.(expr) ?? null;
  if (target === null) return null;
  if (methodName !== "now" || receiverIdentifier?.text !== "Date" || expr.arguments.length !== 0) {
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error(`ir/from-ast: prepared Date.now proof diverged in ${cx.funcName}`);
  }
  const result = cx.builder.emitCall(target, [], irVal({ kind: "f64" }));
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (result === null) throw new Error(`ir/from-ast: prepared Date.now returned void in ${cx.funcName}`);
  return result;
}

function lowerReceiverFirstDynamicMethod(
  expr: ts.CallExpression,
  cx: LowerCtx,
  plan: { readonly receiverGlobal: IrGlobalRef; readonly funcName: string },
  description: string,
): IrValueId {
  const receiver = cx.builder.emitGlobalGet(plan.receiverGlobal, irVal({ kind: "externref" }));
  const args: IrValueId[] = [receiver];
  for (const argument of expr.arguments) {
    if (ts.isSpreadElement(argument)) {
      throw new IrUnsupportedError(
        "method-call-unsupported",
        "build",
        `ir/from-ast: ${description} spread is unsupported (${cx.funcName})`,
      );
    }
    const value = lowerExpr(argument, cx, irDynamic());
    const type = cx.builder.typeOf(value);
    const scalar = asVal(type);
    const carrier =
      scalar?.kind === "f64" || scalar?.kind === "i32" ? boxConcreteToDynamic(value, type, argument, cx) : value;
    if (carrier === null) {
      throw new IrUnsupportedError(
        "operand-coercion-unsupported",
        "build",
        `ir/from-ast: ${description} scalar argument has no dynamic box (${cx.funcName})`,
      );
    }
    args.push(cx.builder.typeOf(carrier).kind === "dynamic" ? carrier : cx.builder.emitCoerceToExternref(carrier));
  }
  const result = cx.builder.emitCall(irRuntimeFuncRef(plan.funcName), args, irDynamic());
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (result === null) throw new Error(`ir/from-ast: ${description} returned void (${cx.funcName})`);
  return result;
}

/**
 * (#4461) Resolve `receiver` to a module binding whose storage is the lane's
 * native `$Map` struct, or `null`.
 *
 * The proof is storage identity, not spelling: the binding must resolve
 * through the same `resolveModuleBinding` the selector consulted AND carry the
 * exact IrType the lane reports for native-map storage. A host-lane
 * `extern<Map>` binding therefore never reaches these arms, and neither does a
 * user variable that merely happens to hold a Map.
 */
function nativeMapModuleBinding(
  receiver: ts.Identifier | undefined,
  cx: LowerCtx,
): { readonly binding: ModuleBindingGlobal; readonly name: string } | null {
  if (receiver === undefined) return null;
  // Resolve the binding FIRST: it is the cheap discriminator, and resolving a
  // genuinely native-map binding is itself what registers the `$Map` struct
  // (`resolveModuleBindingGlobal`'s `native-map` arm). So by the time the PURE
  // storage-type query below runs, the struct exists exactly when it should —
  // and for every other receiver we have emitted nothing at all.
  const binding = cx.resolver?.resolveModuleBinding?.(receiver);
  if (!binding) return null;
  const storageType = cx.resolver?.nativeMapStorageType?.();
  if (!storageType || !irTypeEquals(binding.type, storageType)) return null;
  return { binding, name: receiver.text };
}

/**
 * (#4461) Lower `<nativeMap>.get(k)` / `<nativeMap>.set(k, v)` through the
 * externref-ABI adapters over the shared `$Map` helpers.
 *
 * Both arms are deliberately number-keyed: the adapter ABI and the selector's
 * accepted surface are the same set, so a claim can never outrun a lowering.
 * An argument whose lowered carrier is not f64 throws the ordinary clean
 * "not in slice" demote rather than silently coercing — a string key lowered
 * as a number would corrupt SameValueZero hashing.
 */
function tryLowerNativeMapMethodCall(
  expr: ts.CallExpression,
  methodName: string,
  receiverIdentifier: ts.Identifier | undefined,
  cx: LowerCtx,
): IrValueId | null {
  if (methodName !== "get" && methodName !== "set") return null;
  const resolved = nativeMapModuleBinding(receiverIdentifier, cx);
  if (resolved === null) return null;
  const arity = methodName === "get" ? 1 : 2;
  const callee = expr.expression as ts.PropertyAccessExpression;
  if (
    expr.questionDotToken !== undefined ||
    callee.questionDotToken !== undefined ||
    expr.arguments.length !== arity ||
    expr.arguments.some(ts.isSpreadElement)
  ) {
    throw new IrUnsupportedError(
      "method-call-unsupported",
      "build",
      `ir/from-ast: native Map .${methodName} call shape is not in this slice (${cx.funcName})`,
    );
  }

  const receiver = lowerResolvedModuleBindingRead(resolved.name, resolved.binding, cx);
  const args: IrValueId[] = [receiver];
  for (const argument of expr.arguments) {
    const value = lowerExpr(argument, cx, IR_F64);
    if (asVal(cx.builder.typeOf(value))?.kind !== "f64") {
      throw new IrUnsupportedError(
        "method-call-unsupported",
        "build",
        `ir/from-ast: native Map .${methodName} needs a number key/value (${cx.funcName})`,
      );
    }
    args.push(value);
  }
  const result = cx.builder.emitCall(
    irRuntimeFuncRef(methodName === "get" ? IR_NATIVE_MAP_GET_NUM_FN : IR_NATIVE_MAP_SET_NUM_FN),
    args,
    irVal({ kind: "externref" }),
  );
  if (result === null) {
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error(`ir/from-ast: native Map .${methodName} adapter returned void (${cx.funcName})`);
  }
  return result;
}

/**
 * (#4461) Lower the one native-`$Map` producer: `new Map()` / `new Map<K, V>()`
 * initializing a module binding whose storage is the native struct. The
 * selector admits exactly this shape (`isExactModuleMapGenericInitializer` +
 * the native-map `writeValueMatches` arm), so anything else that reaches here
 * is drift rather than an unsupported source.
 */
function tryLowerNativeMapConstruction(expr: ts.NewExpression, cx: LowerCtx): IrValueId | null {
  // Every cheap, PURE rejection first. Only a proven ambient `new Map()` may
  // reach the materializing resolver call below — see
  // `ensureNativeMapStorageType` for what asking too early cost.
  if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "Map") return null;
  if ((expr.arguments?.length ?? 0) !== 0) return null;
  if (cx.resolver?.isAmbientBinding?.(expr.expression) === false) return null;
  const storageType = cx.resolver?.ensureNativeMapStorageType?.();
  if (!storageType) return null;
  const result = cx.builder.emitCall(irRuntimeFuncRef(IR_NATIVE_MAP_NEW_FN), [], storageType);
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (result === null) throw new Error(`ir/from-ast: native Map allocator returned void (${cx.funcName})`);
  return result;
}

function lowerMethodCall(expr: ts.CallExpression, cx: LowerCtx, statementPosition = false): IrValueId | null {
  if (!ts.isPropertyAccessExpression(expr.expression) || !ts.isIdentifier(expr.expression.name)) {
    demoteToLegacy("method-call-unsupported", `ir/from-ast: malformed method call in ${cx.funcName}`);
  }
  const methodName = expr.expression.name.text;
  const receiverIdentifier = ts.isIdentifier(expr.expression.expression) ? expr.expression.expression : undefined;
  const receiverIsDirectModuleBinding =
    receiverIdentifier !== undefined && cx.resolver?.isDirectModuleBinding?.(receiverIdentifier) === true;

  // (#3931) A proven-in-bounds `recv.charCodeAt(i)` inside a canonical
  // char-read loop. Intercepted here, BEFORE the receiver is lowered, so the
  // native arm reads the hoisted descriptor instead of re-deriving one. The
  // result is an i32 code unit widened to the f64 every charCodeAt consumer
  // expects; the i32-pure path (`emitI32PureExpr`) takes the i32 directly and
  // is what removes the surrounding ToInt32 dance.
  //
  // `f64.convert_i32_s`, not `_u`: a UTF-16 code unit is `[0, 65535]` (the
  // native read zero-extends an i16 array element, the host builtin returns
  // the same range), so the two conversions are bit-identical here — and the
  // signed one is already in `IrUnop`, so this adds no backend surface.
  const provenCharRead = matchProvenCharRead(expr, cx.provenCharReads);
  if (provenCharRead !== null) {
    return cx.builder.emitUnary("f64.convert_i32_s", emitProvenCharReadI32(expr, provenCharRead, cx), IR_F64);
  }

  // #4385 — ES5 §15.3.4. `%Function.prototype%` is a callable intrinsic
  // object. Evaluate arguments left-to-right for effects, discard them, then
  // call the symbolic zero-arg provider which returns the lane's real
  // undefined carrier. Intercept before receiver lowering: ambient Function
  // has no general IR value representation, and treating `prototype` as an
  // instance method is the original category error.
  if (
    receiverIdentifier?.text === "Function" &&
    methodName === "prototype" &&
    !receiverIsDirectModuleBinding &&
    cx.scope.get("Function") === undefined &&
    cx.resolver?.isAmbientBinding?.(receiverIdentifier) !== false
  ) {
    if (expr.arguments.some(ts.isSpreadElement)) {
      throw new IrUnsupportedError(
        "method-call-unsupported",
        "build",
        `ir/from-ast: Function.prototype spread call is not supported (${cx.funcName})`,
      );
    }
    const target = cx.resolver?.functionPrototypeCallTarget?.();
    if (!target) {
      throw new IrUnsupportedError(
        "method-call-unsupported",
        "build",
        `ir/from-ast: Function.prototype call provider unavailable (${cx.funcName})`,
      );
    }
    for (const argument of expr.arguments) lowerDiscardedExpression(argument, cx);
    const result = cx.builder.emitCall(target, [], irVal({ kind: "externref" }));
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    if (result === null) throw new Error(`ir/from-ast: Function.prototype helper returned void (${cx.funcName})`);
    return result;
  }

  // (#4461) `<moduleMap>.get(k)` / `.set(k, v)` where the binding's storage is
  // the native `$Map` struct. Intercepted BEFORE the receiver is lowered so
  // the map value stays in its own `(ref null $Map)` carrier all the way to
  // the adapter, instead of being coerced through an externref the host lane
  // would use. Returns null when this is not that shape.
  const nativeMapCall = tryLowerNativeMapMethodCall(expr, methodName, receiverIdentifier, cx);
  if (nativeMapCall !== null) return nativeMapCall;

  const preparedDateNow = lowerPreparedAsyncDateNow(expr, cx, methodName, receiverIdentifier);
  if (preparedDateNow !== null) return preparedDateNow;

  // #4387 — a stable `var value = new F()` whose one proven `F.prototype`
  // write installs an intrinsic Array stays in the legacy raw-fnctor global.
  // IR owns the call by loading that exact carrier and invoking the same
  // receiver-first closed dispatcher used by the direct path.
  const fnctorArrayMethod = cx.resolver?.fnctorArrayMethodPlan?.(expr) ?? null;
  if (fnctorArrayMethod !== null) {
    return lowerReceiverFirstDynamicMethod(expr, cx, fnctorArrayMethod, "fnctor Array method");
  }

  // #3793 — Acorn's public wrappers call static properties on the retained
  // `Parser` function object. Load the exact existing module carrier and
  // route through the already-reserved closed method dispatcher. That keeps
  // the receiver live (`Parser.parse` uses `new this(...)`) and deliberately
  // does not turn the assigned FunctionExpression into a bare direct call.
  const retainedMethod = cx.resolver?.retainedFunctionMethodPlan?.(expr) ?? null;
  if (retainedMethod !== null) {
    return lowerReceiverFirstDynamicMethod(expr, cx, retainedMethod, "retained function method");
  }

  // #3791 — standalone native RegExp `.test` on one exact, stable top-level
  // carrier. Keep the real legacy module global as the receiver (no duplicate
  // construction/cache), externalize the native subject string, then call the
  // established `$NativeRegExp`-first carrier helper. The selector admits
  // only this one-argument form and the resolver repeats the source proof.
  if (methodName === "test" && expr.arguments.length === 1 && !ts.isSpreadElement(expr.arguments[0]!)) {
    const plan = cx.resolver?.standaloneRegExpTestPlan?.(expr.expression.expression) ?? null;
    if (plan !== null) {
      if (plan.funcName !== STANDALONE_REGEXP_CARRIER_TEST_HELPER) {
        // invariant (producer-promise): the resolver promised a well-formed plan — #4502.
        throw new Error(`ir/from-ast: unexpected standalone RegExp test helper ${plan.funcName}`);
      }
      const receiver = cx.builder.emitGlobalGet(plan.receiverGlobal, irVal({ kind: "externref" }));
      const subject = lowerExpr(expr.arguments[0]!, cx, { kind: "string" });
      if (cx.builder.typeOf(subject).kind !== "string") {
        throw new IrUnsupportedError(
          "operand-coercion-unsupported",
          "build",
          `ir/from-ast: standalone RegExp.test subject is not a proven string (${cx.funcName})`,
        );
      }
      const subjectExtern = cx.builder.emitCoerceToExternref(subject);
      const result = cx.builder.emitCall(
        irRuntimeFuncRef(plan.funcName),
        [receiver, subjectExtern],
        irVal({ kind: "i32", boolean: true }),
      );
      if (result === null) {
        // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
        throw new Error(`ir/from-ast: standalone RegExp.test helper returned void (${cx.funcName})`);
      }
      return result;
    }
  }

  // ES5 Object.defineProperty — route an exact ambient static call through
  // the same full ToPropertyDescriptor helper as legacy codegen. Keeping the
  // target symbolic means import indices remain allocator-owned, while
  // `coerce.to_externref` preserves one representation-neutral IR shape for
  // structural target/key/descriptor values in the host lane.
  if (
    receiverIdentifier?.text === "Object" &&
    methodName === "defineProperty" &&
    !receiverIsDirectModuleBinding &&
    cx.scope.get("Object") === undefined &&
    cx.resolver?.isAmbientBinding?.(receiverIdentifier) !== false
  ) {
    if (expr.arguments.length !== 3 || expr.arguments.some(ts.isSpreadElement)) {
      throw new IrUnsupportedError(
        "method-call-unsupported",
        "build",
        `ir/from-ast: Object.defineProperty call shape not supported (${cx.funcName})`,
      );
    }
    const target = cx.resolver?.objectDefinePropertyTarget?.();
    if (!target) {
      throw new IrUnsupportedError(
        "method-call-unsupported",
        "build",
        `ir/from-ast: Object.defineProperty provider unavailable (${cx.funcName})`,
      );
    }
    const args = expr.arguments.map((arg, index) => {
      const value = lowerExpr(arg, cx, irVal({ kind: "externref" }));
      const type = cx.builder.typeOf(value);
      const val = asVal(type);
      const hostExternCarrier =
        type.kind === "extern" ||
        val?.kind === "externref" ||
        (index === 1 && type.kind === "string" && cx.resolver?.stringIsExternref?.() !== false);
      if (!hostExternCarrier) {
        throw new IrUnsupportedError(
          "operand-coercion-unsupported",
          "build",
          `ir/from-ast: Object.defineProperty arg ${index} is not host-extern-backed: ${describeIrType(type)} (${cx.funcName})`,
        );
      }
      return cx.builder.emitCoerceToExternref(value);
    });
    const result = cx.builder.emitCall(target, args, irVal({ kind: "externref" }));
    if (result === null) {
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(`ir/from-ast: Object.defineProperty helper produced no result (${cx.funcName})`);
    }
    return result;
  }

  // #3787 — exact ambient String.fromCharCode(...). Intercept before receiver
  // lowering because the ambient `String` constructor has no Phase-1 value
  // representation. The selector admits only numeric, non-spread arguments;
  // keep the checks here too so direct lowerer callers cannot bypass them.
  if (
    receiverIdentifier?.text === "String" &&
    methodName === "fromCharCode" &&
    !receiverIsDirectModuleBinding &&
    cx.scope.get("String") === undefined &&
    (cx.resolver?.isAmbientStringBinding?.(receiverIdentifier) ??
      cx.resolver?.isAmbientBinding?.(receiverIdentifier) !== false)
  ) {
    if (expr.arguments.some(ts.isSpreadElement)) {
      throw new IrUnsupportedError(
        "method-call-unsupported",
        "build",
        `ir/from-ast: String.fromCharCode spread is not supported (${cx.funcName})`,
      );
    }
    const plan = cx.resolver?.stringFromCharCodePlan?.() ?? null;
    if (plan === null) {
      throw new IrUnsupportedError(
        "method-call-unsupported",
        "build",
        `ir/from-ast: String.fromCharCode provider unavailable (${cx.funcName})`,
      );
    }

    if (expr.arguments.length === 0) return cx.builder.emitStringConst("");
    let result: IrValueId | null = null;
    for (const argument of expr.arguments) {
      const numeric = lowerExpr(argument, cx, irVal({ kind: "f64" }));
      const numericType = asVal(cx.builder.typeOf(numeric));
      if (numericType?.kind !== "f64" && numericType?.kind !== "i32") {
        throw new IrUnsupportedError(
          "operand-coercion-unsupported",
          "build",
          `ir/from-ast: String.fromCharCode argument is not numeric (${cx.funcName})`,
        );
      }

      let code = numeric;
      if (plan.argumentRep === "i32" && numericType.kind === "f64") {
        // ECMA-262 ToUint16 in the f64 domain:
        //   t = trunc(x)
        //   m = t - floor(t / 65536) * 65536
        // NaN and ±Infinity propagate to NaN, which trunc_sat maps to zero.
        // A bare trunc_sat would saturate before the helper's low-16 mask and
        // miscompile values outside the signed-i32 range.
        const truncated = cx.builder.emitUnary("f64.trunc", numeric, irVal({ kind: "f64" }));
        const quotient = cx.builder.emitBinary(
          "f64.div",
          truncated,
          cx.builder.emitConst({ kind: "f64", value: 65536 }, irVal({ kind: "f64" })),
          irVal({ kind: "f64" }),
        );
        const floored = cx.builder.emitUnary("f64.floor", quotient, irVal({ kind: "f64" }));
        const wrapped = cx.builder.emitBinary(
          "f64.sub",
          truncated,
          cx.builder.emitBinary(
            "f64.mul",
            floored,
            cx.builder.emitConst({ kind: "f64", value: 65536 }, irVal({ kind: "f64" })),
            irVal({ kind: "f64" }),
          ),
          irVal({ kind: "f64" }),
        );
        code = cx.builder.emitUnary("i32.trunc_sat_f64_s", wrapped, irVal({ kind: "i32" }));
      } else if (plan.argumentRep === "f64" && numericType.kind === "i32") {
        code = cx.builder.emitUnary("f64.convert_i32_s", numeric, irVal({ kind: "f64" }));
      }

      const part = cx.builder.emitCall(irRuntimeFuncRef(plan.funcName), [code], { kind: "string" });
      if (part === null) {
        // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
        throw new Error(`ir/from-ast: String.fromCharCode helper produced no result (${cx.funcName})`);
      }
      result = result === null ? part : cx.builder.emitStringConcat(result, part);
    }
    return result!;
  }

  if (
    isPristineEs5IntrinsicIsFrozenCall(
      expr,
      (node) => cx.resolver?.isAmbientBinding?.(node) === true && cx.scope.get(node.text) === undefined,
    )
  ) {
    return cx.builder.emitConst({ kind: "bool", value: false }, irVal({ kind: "i32", boolean: true }));
  }

  // #3000-E: `super.method(args)` — static-dispatch to the PARENT's method slot.
  // Intercepted BEFORE receiver lowering: `super` is a keyword lowerExpr can't
  // produce a value for. The receiver passed to the parent method is `this` (the
  // subclass instance — a WasmGC subtype of the parent), and the method resolves
  // against the parent shape so a subclass override is bypassed.
  if (expr.expression.expression.kind === ts.SyntaxKind.SuperKeyword) {
    const parentShape = requireSuperParentShape(cx);
    const self = requireThisValue(cx);
    const method = findClassMember(parentShape, methodName, "method");
    if (!method) {
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: super.${methodName}() — parent class ${parentShape.className} has no method "${methodName}" in ${cx.funcName}`,
      );
    }
    if (expr.arguments.length !== method.params.length) {
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: super.${methodName}() has ${expr.arguments.length} args, expected ${method.params.length} in ${cx.funcName}`,
      );
    }
    const args: IrValueId[] = [];
    for (let i = 0; i < expr.arguments.length; i++) {
      const expected = method.params[i]!;
      const argVal = lowerExpr(expr.arguments[i]!, cx, expected);
      const argType = cx.builder.typeOf(argVal);
      if (!irTypeEquals(argType, expected)) {
        demoteToLegacy(
          "method-call-unsupported",
          `ir/from-ast: super.${methodName}() arg ${i} is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
        );
      }
      args.push(argVal);
    }
    if (method.returnType === null && !statementPosition) {
      unsupportedVoidCallExpression(
        `ir/from-ast: void super.${methodName}() used in expression position (${cx.funcName})`,
      );
    }
    return cx.builder.emitClassSuperCall(parentShape, self, methodName, args, method.returnType, method.target);
  }

  // (#2856) console.<m>(arg) — host console variant call. Intercepted BEFORE
  // receiver lowering (like the Math arm below): `console` has NO
  // `global_console` handle and NO extern-class registration — the legacy
  // backend services it via dedicated per-arg-type import variants
  // (`console_log_string`, `console_log_number`, … — `collectConsoleImports`).
  // Statement position only: console methods return undefined, and the
  // single-arg restriction mirrors what this slice lowers (multi-arg calls
  // demote cleanly). The variant is chosen by the resolver from the CHECKER
  // type of the argument — the exact predicate `collectConsoleImports` used
  // to register the import — so the picked name is registered by
  // construction.
  if (
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "console" &&
    !receiverIsDirectModuleBinding &&
    cx.scope.get("console") === undefined &&
    cx.resolver?.consoleArgVariant !== undefined
  ) {
    const jsHost = cx.resolver?.jsHostExterns?.() === true;
    const hostFreeSink = cx.resolver?.standaloneConsoleSinkAvailable?.() === true;
    assertNotDeferred(consoleSurfaceCapability(jsHost, hostFreeSink), `console.${methodName}`, cx.funcName);
    if (!statementPosition) {
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: console.${methodName} in expression position not supported (${cx.funcName})`,
      );
    }
    if (!IR_CONSOLE_METHODS.has(methodName)) {
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: console.${methodName} not in IR console slice (${cx.funcName})`,
      );
    }
    if (expr.arguments.length !== 1) {
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: console.${methodName} with ${expr.arguments.length} args not in slice (${cx.funcName})`,
      );
    }
    // (#4462) Host-free lane first — the two capabilities are disjoint, and the
    // sink only exists where there is no host to import from.
    if (!jsHost && hostFreeSink) return lowerHostFreeConsoleCall(expr.arguments[0]!, cx, methodName);
    const argExpr = expr.arguments[0]!;
    const variant = cx.resolver.consoleArgVariant(argExpr);
    const importName = `console_${methodName}_${variant}`;
    const expected: ValType =
      variant === "number" ? { kind: "f64" } : variant === "bool" ? { kind: "i32" } : { kind: "externref" };
    const argVal = lowerExpr(argExpr, cx, irVal(expected));
    const coerced = coerceToExpectedExtern(argVal, expected, cx, `arg of console.${methodName}`);
    const target = cx.resolver.preparedAsyncConsoleTarget?.(expr) ?? irImportFuncRef("env", importName);
    cx.builder.emitCall(target, [coerced], null);
    return null;
  }

  // Exact-arity Math builtins become semantic intrinsics before receiver
  // lowering because the ambient `Math` global has no IR value binding.
  // Recheck the selector proof here so divergence fails with a clear error.
  if (
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === "Math" &&
    !receiverIsDirectModuleBinding &&
    cx.scope.get("Math") === undefined &&
    // The self-host stdlib builder has no checker-backed ambient callback;
    // user-source builds do, and an explicit `false` preserves shadow safety.
    cx.resolver?.isAmbientBinding?.(expr.expression.expression) !== false
  ) {
    const plan = IR_MATH_METHOD_TABLE[methodName];
    if (plan !== undefined && expr.arguments.length === plan.arity) {
      const args = expr.arguments.map((argExpr) => {
        const arg = lowerExpr(argExpr, cx, irVal({ kind: "f64" }));
        const argType = cx.builder.typeOf(arg);
        if (argType.kind !== "val" || argType.val.kind !== "f64") {
          demoteToLegacy(
            "method-call-unsupported",
            `ir/from-ast: Math.${methodName} arg must be f64, got ${describeIrType(argType)} (${cx.funcName})`,
          );
        }
        return arg;
      });
      const source = expr.getSourceFile();
      const position = source.getLineAndCharacterOfPosition(expr.getStart(source));
      return cx.builder.emitIntrinsic(plan.intrinsic, args, {
        line: position.line + 1,
        column: position.character,
      });
    }
    demoteToLegacy("method-call-unsupported", `ir/from-ast: Math.${methodName} not in IR whitelist (${cx.funcName})`);
  }

  // (#3144) `C.m(args)` — static method call on a locally-declared class.
  // Recognised BEFORE receiver lowering (like the Math/console arms above):
  // a bare class identifier has no IR value binding (lowerExpr would throw
  // "unknown identifier"). Mirrors the selector's static-call arm exactly:
  // identifier receiver, unshadowed, naming a local class. The descriptor
  // lookup walks the parent chain — an inherited static resolves through the
  // call-site class's `${className}_${method}` key, which legacy's
  // inherited-member propagation registers. Legacy statics take NO `self`
  // param, so `class.static_call` emits args only.
  if (
    ts.isIdentifier(expr.expression.expression) &&
    !receiverIsDirectModuleBinding &&
    cx.scope.get(expr.expression.expression.text) === undefined &&
    cx.classShapes?.has(expr.expression.expression.text)
  ) {
    const className = expr.expression.expression.text;
    const shape = cx.classShapes.get(className)!;
    const method = findClassMember(shape, methodName, "static");
    if (!method) {
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: class ${className} has no static method "${methodName}" in ${cx.funcName}`,
      );
    }
    if (expr.arguments.length !== method.params.length) {
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: static ${className}.${methodName} has ${expr.arguments.length} args, expected ${method.params.length} in ${cx.funcName}`,
      );
    }
    const args: IrValueId[] = [];
    for (let i = 0; i < expr.arguments.length; i++) {
      const expected = method.params[i]!;
      const argVal = lowerExpr(expr.arguments[i]!, cx, expected);
      const argType = cx.builder.typeOf(argVal);
      if (!irTypeEquals(argType, expected)) {
        demoteToLegacy(
          "method-call-unsupported",
          `ir/from-ast: arg ${i} of static ${className}.${methodName} is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
        );
      }
      args.push(argVal);
    }
    if (method.returnType === null && !statementPosition) {
      unsupportedVoidCallExpression(
        `ir/from-ast: void static method ${className}.${methodName} used in expression position (${cx.funcName})`,
      );
    }
    return cx.builder.emitClassStaticCall(shape, methodName, args, method.returnType, method.target);
  }

  const recv = lowerExpr(expr.expression.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);

  if (methodName === "filter" && cx.resolver?.isHoleyArrayFilterCall?.(expr) === true) {
    const resolvedVec = resolveIrVecType(recvType, cx);
    if (!resolvedVec || resolvedVec.lowering.elementValType.kind !== "externref") {
      throw new IrUnsupportedError(
        "method-call-unsupported",
        "build",
        `ir/from-ast: sparse filter receiver lost its externref carrier (${cx.funcName})`,
      );
    }
    if (expr.arguments.length !== 1 || ts.isSpreadElement(expr.arguments[0]!)) {
      throw new IrUnsupportedError(
        "method-call-unsupported",
        "build",
        `ir/from-ast: sparse filter callback shape diverged after selection (${cx.funcName})`,
      );
    }
    const callback = lowerExpr(expr.arguments[0]!, cx, irVal({ kind: "externref" }));
    const callbackType = cx.builder.typeOf(callback);
    const callbackExtern =
      callbackType.kind === "closure" || callbackType.kind === "callable"
        ? cx.builder.emitCoerceToExternref(callback)
        : asVal(callbackType)?.kind === "externref"
          ? callback
          : null;
    if (callbackExtern === null) {
      throw new IrUnsupportedError(
        "method-call-unsupported",
        "build",
        `ir/from-ast: sparse filter callback is not a callable carrier (${cx.funcName})`,
      );
    }
    const result = cx.builder.emitCall(
      irRuntimeFuncRef("__hof_holey_array_filter"),
      [cx.builder.emitCoerceToExternref(recv), callbackExtern, emitDefaultExternArg(cx, { kind: "externref" })],
      irVal({ kind: "externref" }),
    );
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    if (result === null) throw new Error(`ir/from-ast: sparse filter provider returned void (${cx.funcName})`);
    return result;
  }

  if (recvType.kind === "dynamic") {
    // Preserve the static property name for the host-side ordinary-class
    // bridge. IR's dynamic runtime helper intentionally accepts an arbitrary
    // key at execution time, so the finalizer otherwise cannot know which
    // compiled class methods need `__member_kind_*`/`__call_*` exports.
    cx.hostDynamicClassMethodNames?.add(methodName);
    const firstArgumentText = expr.arguments[0]?.getText();
    const isNarrowStringReplace =
      methodName === "replace" &&
      expr.arguments.length === 2 &&
      expr.arguments[0]!.kind === ts.SyntaxKind.RegularExpressionLiteral &&
      firstArgumentText === "/_/g" &&
      ts.isStringLiteralLike(expr.arguments[1]!) &&
      expr.arguments[1]!.text === "";
    if (isNarrowStringReplace) {
      const replacement = lowerExpr(expr.arguments[1]!, cx, { kind: "string" });
      const replacementType = cx.builder.typeOf(replacement);
      if (replacementType.kind !== "string") {
        throw new IrUnsupportedError(
          "operand-coercion-unsupported",
          "build",
          `ir/from-ast: dynamic string replace replacement is not a proven string (${cx.funcName})`,
        );
      }
      const dynamicReplacement = boxConcreteToDynamic(replacement, replacementType, expr.arguments[1]!, cx);
      if (dynamicReplacement === null) {
        throw new IrUnsupportedError(
          "operand-coercion-unsupported",
          "build",
          `ir/from-ast: dynamic string replace replacement has no canonical dynamic box (${cx.funcName})`,
        );
      }
      const key = cx.builder.emitBox(cx.builder.emitStringConst(methodName), irDynamic(JS_TAG_IDS.String));
      const result = cx.builder.emitCall(
        irRuntimeFuncRef(IR_DYN_STRING_REPLACE_FN),
        [recv, key, dynamicReplacement],
        irDynamic(),
      );
      if (result === null) {
        // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
        throw new Error(`ir/from-ast: dynamic string replace produced no result in ${cx.funcName}`);
      }
      return result;
    }
    if (expr.arguments.length > 1 || expr.arguments.some(ts.isSpreadElement)) {
      throw new IrUnsupportedError(
        "method-call-unsupported",
        "build",
        `ir/from-ast: dynamic method .${methodName}(...) supports at most one non-spread argument (${cx.funcName})`,
      );
    }
    const key = cx.builder.emitBox(cx.builder.emitStringConst(methodName), irDynamic(JS_TAG_IDS.String));
    const dynamicArgs: IrValueId[] = [recv, key];
    for (const argument of expr.arguments) {
      const value = lowerExpr(argument, cx, irDynamic());
      const valueType = cx.builder.typeOf(value);
      const dynamicValue = valueType.kind === "dynamic" ? value : boxConcreteToDynamic(value, valueType, argument, cx);
      if (dynamicValue === null) {
        throw new IrUnsupportedError(
          "operand-coercion-unsupported",
          "build",
          `ir/from-ast: dynamic method argument cannot be boxed (${cx.funcName})`,
        );
      }
      dynamicArgs.push(dynamicValue);
    }
    const target = expr.arguments.length === 0 ? IR_DYN_METHOD_CALL_0_FN : IR_DYN_METHOD_CALL_1_FN;
    const result = cx.builder.emitCall(irRuntimeFuncRef(target), dynamicArgs, irDynamic());
    if (result === null) {
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(`ir/from-ast: dynamic method .${methodName}(...) produced no result in ${cx.funcName}`);
    }
    return result;
  }

  // #3522 parameterized object-method ownership. A selector-certified
  // shorthand method is stored as an exact closure field in the closed object
  // layout. Receiver-sensitive bodies are rejected before build, so the
  // JavaScript call is the same typed closure call with no ambient `this`
  // installation. This retains the direct backend's static target and avoids
  // generic property/method dispatch.
  if (recvType.kind === "object") {
    const field = recvType.shape.fields.find((candidate) => candidate.name === methodName);
    if (!field || (field.type.kind !== "closure" && field.type.kind !== "callable")) {
      throw new IrUnsupportedError(
        "method-call-unsupported",
        "build",
        `ir/from-ast: object field .${methodName} is not an exact callable (${cx.funcName})`,
      );
    }
    const callee = cx.builder.emitObjectGet(recv, methodName, field.type);
    return lowerClosureCall(callee, field.type.signature, expr.arguments, cx, statementPosition);
  }

  // (#2856) `<number>.toString()` (no radix) on an f64 receiver → the
  // `number_toString` `(f64) -> externref` host import, pre-registered by the
  // legacy source scan whenever a checker-number `.toString()` appears in
  // source (src/codegen/index.ts ~9100). The import is host-lane-only and
  // its return is a HOST string (externref), which is exactly `IrType.string`'s
  // carrier there — so the result composes with the string `+` proof arms
  // (`"n=" + i.toString()`). (#2955 slice 4: that availability question is
  // resolver-owned — `hasHostNumberToString` — so from-ast reads no
  // `nativeStrings` here. The `=== true` polarity preserves the legacy
  // resolver-absent default of this site's old `nativeStrings?.() === false`
  // read: no resolver → demote.) Lanes without the import (native strings:
  // `(ref $AnyString)` carrier, no native number formatter yet) demote here;
  // radix args likewise demote.
  if (
    methodName === "toString" &&
    expr.arguments.length === 0 &&
    recvType.kind === "val" &&
    recvType.val.kind === "f64" &&
    cx.resolver?.hasHostNumberToString?.() === true
  ) {
    const target = cx.resolver.preparedAsyncNumberToStringTarget?.(expr) ?? irImportFuncRef("env", "number_toString");
    const r = cx.builder.emitCall(target, [recv], { kind: "string" });
    if (r === null) {
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(`ir/from-ast: number_toString produced no result in ${cx.funcName}`);
    }
    return r;
  }

  // (#4462) The same call in a HOST-FREE lane — see `lowerNativeNumberToString`.
  if (
    methodName === "toString" &&
    expr.arguments.length === 0 &&
    recvType.kind === "val" &&
    recvType.val.kind === "f64" &&
    cx.resolver?.nativeNumberToStringAvailable?.() === true
  ) {
    return lowerNativeNumberToString(recv, cx.funcName, cx);
  }

  // #2856 builtins slice — a bounded literal fraction-digits argument needs
  // no runtime RangeError guard. Host-string mode owns number_toFixed's
  // `(f64, f64) -> externref` ABI; native-string modes stay pre-claim
  // deferred until the front-end has a representation-polymorphic formatter.
  if (
    methodName === "toFixed" &&
    expr.arguments.length === 1 &&
    ts.isNumericLiteral(expr.arguments[0]!) &&
    recvType.kind === "val" &&
    recvType.val.kind === "f64" &&
    cx.resolver?.hasHostNumberToString?.() === true
  ) {
    const digits = Number(expr.arguments[0]!.text.replace(/_/g, ""));
    if (!Number.isInteger(digits) || digits < 0 || digits > 100) {
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: number.toFixed digits not a bounded integer literal (${cx.funcName})`,
      );
    }
    const digitValue = cx.builder.emitConst({ kind: "f64", value: digits }, irVal({ kind: "f64" }));
    const r = cx.builder.emitCall(irImportFuncRef("env", "number_toFixed"), [recv, digitValue], { kind: "string" });
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    if (r === null) throw new Error(`ir/from-ast: number_toFixed produced no result in ${cx.funcName}`);
    return r;
  }

  // #4576 — native-string lanes expose the same bounded literal-digits slice
  // through a symbolic provider while the host arm keeps its direct env import.
  if (
    methodName === "toFixed" &&
    expr.arguments.length === 1 &&
    ts.isNumericLiteral(expr.arguments[0]!) &&
    recvType.kind === "val" &&
    recvType.val.kind === "f64" &&
    cx.resolver?.nativeNumberToFixedAvailable?.() === true
  ) {
    const digits = Number(expr.arguments[0]!.text.replace(/_/g, ""));
    if (!Number.isInteger(digits) || digits < 0 || digits > 100) {
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: number.toFixed digits not a bounded integer literal (${cx.funcName})`,
      );
    }
    const digitValue = cx.builder.emitConst({ kind: "f64", value: digits }, irVal({ kind: "f64" }));
    const r = cx.builder.emitCall(irIntrinsicFuncRef(IR_NUMBER_TO_FIXED_FN), [recv, digitValue], { kind: "string" });
    if (r === null) throw new Error(`ir/from-ast: ${IR_NUMBER_TO_FIXED_FN} produced no result in ${cx.funcName}`);
    return r;
  }

  // Slice 13c (#1232) — String prototype method dispatch. When the receiver
  // is `IrType.string`, look up the method in the synthetic String pseudo-
  // extern registry (#1238) and dispatch to either the native helper
  // (`__str_<method>`) or the JS-host import (`string_<method>`) based on
  // the active string backend. Returns null when the method isn't supported
  // by Phase 1 (caller falls through to the existing `string` arm below).
  if (recvType.kind === "string") {
    if (
      methodName === "replace" &&
      (expr.arguments.length !== 2 ||
        !expr.arguments.every((arg) => ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)))
    ) {
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: String.replace requires two literal-string arguments (${cx.funcName})`,
      );
    }
    const r = lowerStringMethodCall(methodName, recv, expr.expression.expression, expr.arguments, cx);
    if (r !== null) return r;
    // Method not in slice 13c table — fall through to the recvType.kind !== "class"
    // check below, which throws the clean "not in slice 4" error and routes this
    // function back to the legacy compiler path. Do NOT throw here — a premature
    // throw here gets caught at the wrong layer and corrupts the claim state.
  }

  // Slice 10 (#1169i) — extern-class method call. The legacy host imports
  // store the signature as `[receiver_externref, ...userParams] ->
  // results`, so we slice off `params[0]` when matching call args.
  //
  // #2856 widens this arm with (a) inheritance-chain member resolution
  // (`appendChild` on an `Element` receiver resolves on `Node`; the instr's
  // className becomes the DEFINING class so the lowered import name is
  // `Node_appendChild`), (b) use-site result branding (an externref result
  // whose checker type names an extern class carries `IrType.extern` so
  // chained access dispatches), and (c) statement-position void calls
  // (`host.appendChild(box);`) — expression position keeps throwing on void.
  if (recvType.kind === "extern") {
    const standaloneDomCall = cx.resolver?.standaloneDomOperation?.(expr);
    const exactStandaloneDomCall = standaloneDomCall?.kind === "member-call" && standaloneDomCall.call === expr;
    assertNotDeferred(
      domSurfaceCapability(cx.resolver?.jsHostExterns?.() === true, exactStandaloneDomCall),
      `extern method call .${methodName}`,
      cx.funcName,
    );
    const className = recvType.className;
    const chained = cx.resolver?.resolveExternMember?.(className, methodName, "method", expr);
    const flatInfo = cx.resolver?.getExternClassInfo?.(className);
    const method = chained?.method ?? flatInfo?.methods.get(methodName);
    if (!method) {
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: extern class ${className} has no method "${methodName}" in ${cx.funcName}`,
      );
    }
    const definingClass = chained?.importPrefix ?? flatInfo?.importPrefix ?? className;
    if (exactStandaloneDomCall && `${definingClass}_${methodName}` !== standaloneDomCall.importName) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "build",
        `ir/from-ast: certified DOM method call resolved to the wrong import (${cx.funcName})`,
      );
    }
    // params[0] is the receiver — userParams = params.slice(1).
    const userParams = method.params.slice(1);
    if (expr.arguments.length > userParams.length) {
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: method ${definingClass}.${methodName} has ${expr.arguments.length} args, max ${userParams.length} in ${cx.funcName}`,
      );
    }
    const args: IrValueId[] = [];
    for (let i = 0; i < expr.arguments.length; i++) {
      const expected = userParams[i]!;
      const argument = expr.arguments[i]!;
      const hostCallbackArrow = ts.isArrowFunction(argument) ? argument : undefined;
      const hostCallbackPlan = hostCallbackArrow ? cx.hostVoidCallbacks?.get(hostCallbackArrow) : undefined;
      if (hostCallbackPlan && hostCallbackArrow) {
        if (
          methodName !== "addEventListener" ||
          i !== 1 ||
          expected.kind !== "externref" ||
          hostCallbackPlan.signature.params.length !== 0 ||
          hostCallbackPlan.signature.returnType !== null
        ) {
          // invariant (producer-promise): the resolver promised a well-formed plan — #4502.
          throw new Error(`ir/from-ast: invalid host void callback plan for ${definingClass}.${methodName}`);
        }
        const closure = lowerHostVoidCallbackExpression(hostCallbackArrow, hostCallbackPlan, cx);
        const packed = cx.builder.emitCallablePack(closure, hostCallbackPlan.signature);
        if (exactStandaloneDomCall && standaloneDomCall.argumentBoundaries[i] === "native-callback-zero-void") {
          args.push(packed);
          continue;
        }
        // -2 is the compiler-owned one-shot sentinel: this exact inline
        // closure is created solely for the immediately following host call,
        // so it cannot cross the boundary a second time. The runtime may
        // therefore skip the identity WeakMap used by the reusable -1 ABI.
        const sentinel = cx.builder.emitConst({ kind: "i32", value: -2 }, irVal({ kind: "i32" }));
        const wrapped = cx.builder.emitCall(
          irImportFuncRef("env", "__make_callback"),
          [sentinel, packed],
          irVal({ kind: "externref" }),
        );
        if (wrapped === null) {
          // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
          throw new Error(`ir/from-ast: __make_callback produced no value in ${cx.funcName}`);
        }
        args.push(wrapped);
        continue;
      }
      const argVal = lowerExpr(argument, cx, irVal(expected));
      const boundary = coercibleStandaloneDomArgumentBoundary(
        exactStandaloneDomCall ? standaloneDomCall : undefined,
        i,
        cx.funcName,
      );
      args.push(coerceToExpectedExtern(argVal, expected, cx, `arg ${i} of ${definingClass}.${methodName}`, boundary));
    }
    // (#2856) Pad missing OPTIONAL args with default sentinels: the host
    // import's Wasm signature has FIXED arity = the registered params
    // (`createElement(tagName, options?)` imports as (recv, externref,
    // externref)), so the call must push exactly that many values. Mirrors
    // the legacy `pushDefaultValue` loop (new-super.ts) and the extern.new
    // padding above — without it the emitted call is stack-short and the
    // module fails Wasm validation ("not enough arguments on the stack").
    for (let i = expr.arguments.length; i < userParams.length; i++) {
      args.push(emitDefaultExternArg(cx, userParams[i]!));
    }
    // Result type: use-site extern brand when available (#2856), else the
    // first registered result, or null if void.
    const resultType: IrType | null =
      method.results.length > 0
        ? chained?.resultClassName
          ? { kind: "extern", className: chained.resultClassName }
          : irVal(method.results[0]!)
        : null;
    if (resultType === null && !statementPosition) {
      unsupportedVoidCallExpression(
        `ir/from-ast: void method ${definingClass}.${methodName} used in expression position (${cx.funcName})`,
      );
    }
    const r = cx.builder.emitExternCall(definingClass, methodName, recv, args, resultType);
    if (resultType !== null && r === null) {
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(`ir/from-ast: extern.call produced no result in ${cx.funcName}`);
    }
    return r;
  }

  const vecPush = tryLowerVecPush(expr, methodName, recv, recvType, statementPosition, cx, {
    lowerExpr: (expression, expected) => lowerExpr(expression, cx, expected),
    lowerNarrowedElement: (expression) => lowerNarrowedI32Element(expression, cx),
    coerceToExpectedExtern: (value, expected, detail) => coerceToExpectedExtern(value, expected, cx, detail),
    describeType: describeIrType,
  });
  if (vecPush !== undefined) return vecPush;

  if (recvType.kind !== "class") {
    throwMethodCallNotInSlice(methodName, recvType, cx.funcName);
  }
  // (#3144) memberKind-filtered + parent-chain-walking lookup: getter/
  // setter/static descriptors never resolve as instance methods, and an
  // inherited (non-overridden) method found on an ancestor shape resolves —
  // the emitted `${recvClass}_${method}` key exists via legacy's
  // inherited-member key propagation.
  const method = findClassMember(recvType.shape, methodName, "method");
  if (!method) {
    demoteToLegacy(
      "method-call-unsupported",
      `ir/from-ast: class ${recvType.shape.className} has no method "${methodName}" in ${cx.funcName}`,
    );
  }
  if (expr.arguments.length !== method.params.length) {
    demoteToLegacy(
      "method-call-unsupported",
      `ir/from-ast: method ${recvType.shape.className}.${methodName} has ${expr.arguments.length} args, expected ${method.params.length} in ${cx.funcName}`,
    );
  }
  const args: IrValueId[] = [];
  for (let i = 0; i < expr.arguments.length; i++) {
    const expected = method.params[i]!;
    const argVal = lowerExpr(expr.arguments[i]!, cx, expected);
    const argType = cx.builder.typeOf(argVal);
    if (!irTypeEquals(argType, expected)) {
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: arg ${i} of ${recvType.shape.className}.${methodName} is ${describeIrType(argType)}, expected ${describeIrType(expected)} in ${cx.funcName}`,
      );
    }
    args.push(argVal);
  }
  // #3052: a VOID instance method is legal in STATEMENT position
  // (`this.add(x);` / `obj.tick();`) — only reject void in EXPRESSION position
  // (mirrors the `super.method()` arm above and the extern-class arm below).
  // The `class.call` emit + lowering already carry a null result through: a
  // void method's Wasm slot leaves nothing on the operand stack, so the
  // statement emits balanced (no drop needed) via `emitBlockBody`'s
  // `result === null` in-place path. The selector already CLAIMS this shape —
  // before this slice from-ast threw here, demoting the caller post-claim to
  // legacy (banked in #3000-C's notes).
  if (method.returnType === null && !statementPosition) {
    unsupportedVoidCallExpression(
      `ir/from-ast: void method ${recvType.shape.className}.${methodName} used in expression position (${cx.funcName})`,
    );
  }
  const r = cx.builder.emitClassCall(recv, methodName, "method", args, method.returnType, method.target);
  if (method.returnType !== null && r === null) {
    // Defensive — emitClassCall returns null only when resultType is null.
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error(`ir/from-ast: class.call produced no result in ${cx.funcName}`);
  }
  return r;
}

/**
 * Slice 13c (#1232) — Phase 1 String prototype-method dispatch through the IR.
 *
 * For an IR-claimed function with a string-typed receiver, dispatch the
 * method call directly to:
 *   - **`__str_<method>`** (native helper) when `nativeStrings` mode is on
 *   - **`string_<method>`** (host import) when JS-host string backend is on
 *
 * Both helpers/imports are pre-registered by the legacy passes
 * (`collectStringMethodImports` walks the entire source AST regardless
 * of IR claim, so any `s.<method>(...)` triggers import registration;
 * `ensureNativeStringHelpers` populates the native helpers once per
 * module). The IR's `cx.builder.emitCall` then resolves the import name
 * via the lowerer's `resolveFunc` at module-emit time.
 *
 * Argument coercion:
 *   - **Native mode**: index args (start, end, fromIndex, position) are
 *     `i32` in the helper signature. Lower the source `f64` and apply
 *     `i32.trunc_sat_f64_s` (saturating truncation, matches the legacy
 *     `compileStringMethodCall` path). String args lower as `IrType.string`
 *     and pass through unchanged (resolver maps the IrType to
 *     `(ref $NativeString)` at lower time).
 *   - **JS-host mode**: index args remain f64 (the host import's signature
 *     is `(externref, f64...) -> externref`). String args lower as
 *     `IrType.string` (resolver maps to externref).
 *
 * Result type:
 *   - String-returning methods: `IrType.string` (resolver picks externref
 *     vs `(ref $NativeString)` per backend mode).
 *   - Number-returning (`charCodeAt`, `indexOf`): `IrType.val<f64>`.
 *   - Boolean-returning (`includes`, `startsWith`, `endsWith`): `IrType.val<i32>`.
 *
 * **MLIR seam alignment** (per #1231 Phase 2 design note): the dispatch
 * table here is a static const + `cx.resolver.nativeStrings()` lookup —
 * no IR node mutations, no ambient maps. A future MLIR optimizer
 * producing the same `IrType.string` receiver shape would hit this same
 * function unchanged.
 *
 * Returns `null` for unsupported methods so the caller can fall back to
 * legacy via a clean throw.
 */
/**
 * (#3167) Sentinel func-ref name for the string relational compare helper.
 * `resolveFunc` (integration.ts) maps it mode-appropriately to the native
 * `__str_compare` defined helper or the host `string_compare` env import —
 * both `(str, str) -> i32` returning a -1/0/1 lexicographic sign. Keeping the
 * mode decision in `resolveFunc` (not from-ast) mirrors the #3156 charCodeAt
 * sentinel pattern, so from-ast reads no `nativeStrings`.
 */
export const IR_STRING_COMPARE_FN = "__ir_str_compare";

/**
 * (#3167) Emit a both-string relational `<`/`>`/`<=`/`>=`. Calls the mode-
 * resolved compare helper for a -1/0/1 sign, then folds to the operator's
 * boolean via a signed i32 compare of the sign against 0 (`foldOp`). Total
 * for two strings — the sign is never the dynamic-path `2` sentinel.
 */
function emitStringRelational(
  lhs: IrValueId,
  rhs: IrValueId,
  foldOp: "i32.lt_s" | "i32.gt_s" | "i32.le_s" | "i32.ge_s",
  cx: LowerCtx,
): IrValueId {
  const sign = cx.builder.emitCall(irIntrinsicFuncRef(IR_STRING_COMPARE_FN), [lhs, rhs], irVal({ kind: "i32" }));
  if (sign === null) {
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error(`ir/from-ast: string compare produced void result (${cx.funcName})`);
  }
  const zero = cx.builder.emitConst({ kind: "i32", value: 0 }, irVal({ kind: "i32" }));
  return cx.builder.emitBinary(foldOp, sign, zero, irVal({ kind: "i32" }));
}

interface StringMethodSig {
  /** User-arg ValTypes in JS-host mode (excluding receiver). Used to
   *  hint `lowerExpr` and to choose i32-truncation for native mode. */
  readonly hostArgs: readonly ValType[];
  /** IR result type — `IrType.string` for string-returning methods,
   *  `IrType.val<f64>` for number-returning, `IrType.val<i32>` for boolean. */
  readonly result: IrType;
  /** Number of required user args (excluding optional ones). */
  readonly requiredArgs: number;
}

export const STRING_METHOD_TABLE: Readonly<Record<string, StringMethodSig>> = {
  toUpperCase: { hostArgs: [], result: { kind: "string" }, requiredArgs: 0 },
  toLowerCase: { hostArgs: [], result: { kind: "string" }, requiredArgs: 0 },
  trim: { hostArgs: [], result: { kind: "string" }, requiredArgs: 0 },
  charAt: { hostArgs: [{ kind: "f64" }], result: { kind: "string" }, requiredArgs: 0 },
  slice: {
    hostArgs: [{ kind: "f64" }, { kind: "f64" }],
    result: { kind: "string" },
    requiredArgs: 1, // slice(start) is valid; end is optional
  },
  // (#3156) §22.1.3.24 — substring() and substring(start) are both valid:
  // omitted start defaults to 0, omitted end to the string length. Host mode
  // targets the `string_substring` env import `(externref, f64, f64)` with
  // the #1248 length-default pad; native mode targets `__str_substring`
  // `(ref $AnyString, i32, i32)` whose clamp makes `0x7fffffff` an exact
  // "to end" sentinel (mirrors the legacy native arm).
  substring: {
    hostArgs: [{ kind: "f64" }, { kind: "f64" }],
    result: { kind: "string" },
    requiredArgs: 0,
  },
  // (#3156) §22.1.3.3 — charCodeAt(pos ?? 0); out-of-range → NaN. Lowers to
  // ONE call of a mode-specific guarded helper `(recv, i32) -> f64`
  // (src/codegen/char-code-at-helpers.ts) so the bounds guard lives in the
  // helper, not in from-ast-built control flow. The host helper wraps the
  // `wasm:js-string` builtins via `ctx.jsStringImports` (the #1072
  // bare-name-shadowing-safe registry); the native helper mirrors the legacy
  // flatten + `array.get_u` arm.
  charCodeAt: {
    hostArgs: [{ kind: "f64" }],
    result: irVal({ kind: "f64" }),
    requiredArgs: 0,
  },
  indexOf: {
    hostArgs: [{ kind: "externref" }, { kind: "externref" }],
    result: irVal({ kind: "f64" }),
    requiredArgs: 1, // fromIndex optional
  },
  // #2002 — the second arg is the start position (includes/startsWith) or
  // endPosition (endsWith). Declared as an optional f64 so the IR host path
  // forwards it to `string_<method>` (whose import signature is now
  // `(externref, externref, f64) -> i32`). An omitted position pads with NaN;
  // the `string_method` host shim strips a trailing NaN so the JS method
  // applies its spec default (0 for includes/startsWith, length for endsWith).
  includes: {
    hostArgs: [{ kind: "externref" }, { kind: "f64" }],
    result: irVal({ kind: "i32" }),
    requiredArgs: 1,
  },
  startsWith: {
    hostArgs: [{ kind: "externref" }, { kind: "f64" }],
    result: irVal({ kind: "i32" }),
    requiredArgs: 1,
  },
  endsWith: {
    hostArgs: [{ kind: "externref" }, { kind: "f64" }],
    result: irVal({ kind: "i32" }),
    requiredArgs: 1,
  },
  replace: {
    hostArgs: [{ kind: "externref" }, { kind: "externref" }],
    result: { kind: "string" },
    requiredArgs: 2,
  },
};

function lowerStringMethodCall(
  methodName: string,
  recv: IrValueId,
  receiverExpr: ts.Expression,
  args: ts.NodeArray<ts.Expression>,
  cx: LowerCtx,
): IrValueId | null {
  // The signature table is a plain object, so inherited Object.prototype
  // names (notably `toString` and `valueOf`) must not masquerade as
  // StringMethodSig entries. Such names are selector-owned unsupported
  // methods; if one reaches this backstop, return null so the normal method
  // capability invariant reports it instead of leaking a raw TypeError while
  // reading `hostArgs.length` from the inherited function.
  const sig = Object.prototype.hasOwnProperty.call(STRING_METHOD_TABLE, methodName)
    ? STRING_METHOD_TABLE[methodName]
    : undefined;
  if (!sig) return null;

  if (methodName === "charCodeAt" && cx.resolver?.preferLegacyFlatSubstringCharCodeAt?.(receiverExpr) === true) {
    return null;
  }

  if (args.length < sig.requiredArgs || args.length > sig.hostArgs.length) {
    demoteToLegacy(
      "method-call-unsupported",
      `ir/from-ast: String.${methodName}(...) arg count ${args.length} not in [${sig.requiredArgs}, ${sig.hostArgs.length}] (${cx.funcName})`,
    );
  }

  // #3522 Builtins retirement — preserve the direct path's exact immutable
  // literal predicate fold before asking the backend-specific method planner.
  // The receiver was already lowered by lowerMethodCall, and we lower the
  // search argument here before returning so source evaluation order remains
  // explicit even though this deliberately narrow proof admits only effect-
  // free literal/const chains. A second position argument stays on the normal
  // runtime path.
  if ((methodName === "includes" || methodName === "indexOf") && args.length === 1 && cx.checker) {
    const receiverValue = immutableLiteralStringValue(receiverExpr, cx.checker);
    const searchValue = immutableLiteralStringValue(args[0]!, cx.checker);
    if (receiverValue !== undefined && searchValue !== undefined) {
      lowerExpr(args[0]!, cx, { kind: "string" });
      return methodName === "includes"
        ? cx.builder.emitConst({ kind: "bool", value: receiverValue.includes(searchValue) }, irVal({ kind: "i32" }))
        : cx.builder.emitConst({ kind: "f64", value: receiverValue.indexOf(searchValue) }, irVal({ kind: "f64" }));
    }
  }

  const receiverEncoding = inferStringEncoding(receiverExpr, cx);
  if (methodName === "charAt" || methodName === "charCodeAt") {
    const receiverEvidence = typedValueEvidence(receiverExpr, cx.builder.typeOf(recv), receiverEncoding, cx);
    // Without encoding evidence, preserve the established helper-call path
    // below. Internal stdlib string parameters intentionally have no source
    // producer proof, while literal/slot chains in the shared linear slice do.
    if (receiverEvidence.semanticType === "string" && receiverEvidence.stringEncoding !== undefined) {
      let index: IrValueId;
      let indexType: IrType | null = null;
      if (args.length === 0) {
        index = cx.builder.emitConst({ kind: "i32", value: 0 }, irVal({ kind: "i32" }));
      } else {
        const indexExpr = args[0]!;
        const semantic = proveAdditiveOperand(indexExpr, cx);
        if (semantic !== "number" && semantic !== "no-checker") {
          demoteToLegacy(
            "method-call-unsupported",
            `ir/from-ast: String.${methodName} index is not provably numeric (${semantic}) in ${cx.funcName}`,
          );
        }
        const numeric = lowerExpr(indexExpr, cx, irVal({ kind: "f64" }));
        indexType = cx.builder.typeOf(numeric);
        index =
          asVal(indexType)?.kind === "i32"
            ? numeric
            : cx.builder.emitUnary("i32.trunc_sat_f64_s", numeric, irVal({ kind: "i32" }));
      }
      const evidence = proveTypedStringMethod(receiverEvidence, methodName, indexType === null ? [] : [indexType]);
      if (!evidence) {
        demoteToLegacy(
          "string-evidence-unsupported",
          `ir/from-ast: String.${methodName} requires typed string receiver/encoding evidence (${cx.funcName})`,
        );
      }
      if (evidence.intrinsic === "char-at") {
        return cx.builder.emitStringCharAt(recv, index, evidence.receiverEncoding, evidence.resultEncoding ?? "wtf16");
      }
      return cx.builder.emitStringCharCodeAt(recv, index, evidence.receiverEncoding);
    }
  }

  // (#2955 slice 2) The mode decision — target name, index-arg rep, and the
  // omitted-optional strategy — is resolved by the lower-time side via
  // `stringMethodPlan` (implemented in integration.ts, where the string-mode
  // discriminator lives). from-ast reads NO `nativeStrings` here: it just
  // applies the plan mechanically. A `null` plan is this mode's demote
  // decision (native indexOf/includes/startsWith/endsWith per #2002, native
  // omitted optionals other than slice(start), or a resolver without the
  // callback) — return null so the caller's clean throw demotes to legacy.
  const plan = cx.resolver?.stringMethodPlan?.(methodName, args.length, receiverEncoding) ?? null;
  if (plan === null) return null;
  const funcName = plan.funcName;

  // Build the argument list. params[0] is always the receiver
  // (`IrType.string`). Remaining args are coerced per backend.
  const loweredArgs: IrValueId[] = [recv];
  for (let i = 0; i < args.length; i++) {
    const expectedHost = sig.hostArgs[i]!;
    let argVal: IrValueId;
    if (expectedHost.kind === "f64") {
      // Index-style arg. Lower as f64, then truncate to i32 when the plan's
      // target signature takes i32 indices (the native helpers).
      const numeric = lowerExpr(args[i]!, cx, irVal({ kind: "f64" }));
      argVal =
        plan.indexArgRep === "i32"
          ? cx.builder.emitUnary("i32.trunc_sat_f64_s", numeric, irVal({ kind: "i32" }))
          : numeric;
    } else if (expectedHost.kind === "externref") {
      // The legacy host `string_indexOf` ABI carries its optional fromIndex
      // as a boxed externref even though the source argument is numeric.
      // Mirror that ABI exactly; the search string remains the ordinary
      // string-shaped externref argument.
      if (methodName === "indexOf" && i === 1) {
        const numeric = lowerExpr(args[i]!, cx, irVal({ kind: "f64" }));
        argVal = coerceToExpectedExtern(numeric, expectedHost, cx, "String.indexOf fromIndex");
      } else {
        // String-style arg. Lower as IrType.string — resolver maps to
        // externref (host) or (ref $NativeString) (native) at lower time.
        argVal = lowerExpr(args[i]!, cx, { kind: "string" });
      }
    } else {
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: String.${methodName} arg ${i} expected ValType ${expectedHost.kind} not in slice 13c (${cx.funcName})`,
      );
    }
    loweredArgs.push(argVal);
  }

  // Pad missing optional args with backend-appropriate sentinels.
  // For host-mode externref args (e.g. indexOf's fromIndex omitted),
  // emit `ref.null.extern` — the host import shim treats it as undefined.
  // For host-mode f64 args (e.g. slice's end omitted), emit a sentinel
  // that the host knows means "to end" (matches the legacy convention).
  //
  // #1248: For `String.slice(start)` (single-arg), the missing `end`
  // argument MUST default to `s.length`, NOT 0. The host import
  // `string_slice(s, start, 0)` interprets end=0 literally and returns
  // an empty string for any non-zero start. The fix is symmetric to the
  // legacy compiler path in `src/codegen/expressions/calls.ts:4040+` —
  // when slice is called with only `start`, push `recv.length` as the
  // implicit `end` arg.
  for (let i = args.length; i < sig.hostArgs.length; i++) {
    const expectedHost = sig.hostArgs[i]!;
    // #4576 — native indexOf/includes helpers take an explicit i32 position;
    // their one-argument JS surface defaults that omitted position to zero.
    if (plan.padOmitted === "search-zero") {
      loweredArgs.push(cx.builder.emitConst({ kind: "i32", value: 0 }, irVal({ kind: "i32" })));
      continue;
    }
    // (#3156) charCodeAt() — omitted position is position 0 (§22.1.3.3
    // ToIntegerOrInfinity(undefined) = 0). The guarded helpers take an i32
    // index in both modes, so the pad is an i32 zero.
    if (plan.padOmitted === "charcode-zero") {
      loweredArgs.push(cx.builder.emitConst({ kind: "i32", value: 0 }, irVal({ kind: "i32" })));
      continue;
    }
    // (#3156) i32 substring helpers — omitted start pads 0; omitted end pads
    // the 0x7fffffff "to end" sentinel. Both the native helper and the guarded
    // host builtin helper clamp it to len.
    if (plan.padOmitted === "native-substring") {
      loweredArgs.push(cx.builder.emitConst({ kind: "i32", value: i === 1 ? 0x7fffffff : 0 }, irVal({ kind: "i32" })));
      continue;
    }
    if (plan.padOmitted === "native-slice-len") {
      // #1248 native-mode: slice's missing `end` defaults to `recv.len`.
      // The plan only selects this strategy for `slice(start)` — any other
      // native-mode omission already returned a null plan (demote) above.
      if (methodName === "slice" && i === 1 && expectedHost.kind === "f64") {
        // emitStringLen returns f64; truncate to i32 for native helpers
        const f64Len = cx.builder.emitStringLen(recv, inferStringEncoding(receiverExpr, cx));
        const i32Len = cx.builder.emitUnary("i32.trunc_sat_f64_s", f64Len, irVal({ kind: "i32" }));
        loweredArgs.push(i32Len);
        continue;
      }
      demoteToLegacy(
        "method-call-unsupported",
        `ir/from-ast: String.${methodName} optional arg ${i} omitted in nativeStrings mode not in slice 13c (${cx.funcName})`,
      );
    } else {
      // #1248 host-mode: for `String.slice(start)` / `String.substring(start)`
      // (#3156), the missing `end` arg defaults to `recv.length` (as f64) —
      // padding 0 would make the host run `substring(start, 0)`, which the
      // spec SWAPS to `substring(0, start)` (§22.1.3.24 step 6-8). All other
      // missing optional args fall back to the generic sentinel.
      if ((methodName === "slice" || methodName === "substring") && i === 1 && expectedHost.kind === "f64") {
        const lenVal = cx.builder.emitStringLen(recv, inferStringEncoding(receiverExpr, cx));
        loweredArgs.push(lenVal);
        continue;
      }
      // #2002 — includes/startsWith/endsWith pad an omitted position with NaN.
      // The `string_method` host shim strips a trailing NaN so the JS method
      // applies its spec default (0 for includes/startsWith, length for
      // endsWith) instead of ToInteger(NaN)=0.
      if (
        expectedHost.kind === "f64" &&
        (methodName === "includes" || methodName === "startsWith" || methodName === "endsWith")
      ) {
        const nan = cx.builder.emitConst({ kind: "f64", value: NaN }, irVal({ kind: "f64" }));
        loweredArgs.push(nan);
        continue;
      }
      const def = emitDefaultExternArg(cx, expectedHost);
      loweredArgs.push(def);
    }
  }

  const callResultType = plan.resultRep === "i32-number" ? irVal({ kind: "i32" }) : sig.result;
  const r = cx.builder.emitCall(irIntrinsicFuncRef(funcName), loweredArgs, callResultType);
  if (r === null) {
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error(`ir/from-ast: String.${methodName} produced void result (${cx.funcName})`);
  }
  return plan.resultRep === "i32-number" ? cx.builder.emitUnary("f64.convert_i32_s", r, irVal({ kind: "f64" })) : r;
}

function immutableLiteralStringValue(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: ReadonlySet<ts.Symbol> = new Set(),
): string | undefined {
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isTypeAssertionExpression(expression)
  ) {
    return immutableLiteralStringValue(expression.expression, checker, seen);
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  const declaration = symbol?.valueDeclaration;
  if (!symbol || seen.has(symbol) || !declaration || !ts.isVariableDeclaration(declaration)) return undefined;
  const declarationList = declaration.parent;
  if (
    !ts.isVariableDeclarationList(declarationList) ||
    !(declarationList.flags & ts.NodeFlags.Const) ||
    !declaration.initializer
  ) {
    return undefined;
  }
  const nextSeen = new Set(seen);
  nextSeen.add(symbol);
  return immutableLiteralStringValue(declaration.initializer, checker, nextSeen);
}

/**
 * Slice 4 (#1169d): lower `<obj>.<field> = <expr>;` as `class.set` (or
 * `object.set`, depending on the receiver's IrType). Statement-position
 * only — caller (in `lowerStatementList`) has already verified shape.
 *
 * For class receivers: validate `fieldName` exists on the shape and
 * the RHS type matches the field type. For object receivers: same idea
 * via the slice-2 `object.set`. Anything else throws and the function
 * falls back to legacy.
 */
function lowerPropertyAssignment(expr: ts.BinaryExpression, cx: LowerCtx): void {
  const lhs = expr.left;
  // #3000 — private-field write (`this.#x = v`). Same mangling as the read
  // path so the write targets the identical legacy struct slot.
  if (!ts.isPropertyAccessExpression(lhs) || (!ts.isIdentifier(lhs.name) && !ts.isPrivateIdentifier(lhs.name))) {
    demoteToLegacy("property-write-unsupported", `ir/from-ast: malformed property assignment LHS in ${cx.funcName}`);
  }
  const fieldName = irPrivateFieldName(lhs.name);
  const recv = lowerExpr(lhs.expression, cx, irVal({ kind: "f64" }));
  const recvType = cx.builder.typeOf(recv);

  if (recvType.kind === "class") {
    const field = recvType.shape.fields.find((f) => f.name === fieldName);
    if (!field) {
      // (#3144) Accessor fallback: `recv.prop = v` backed by a `set prop(v)`
      // accessor lowers to `call ${recvClass}_set_${prop}(recv, v)` — the
      // legacy setter function is `(self, value) -> []` (void), so a
      // null-result class.call in statement position emits balanced.
      const setter = findClassMember(recvType.shape, fieldName, "setter");
      if (setter && setter.params.length === 1) {
        const newValue = lowerExpr(expr.right, cx, setter.params[0]!);
        const newValueType = cx.builder.typeOf(newValue);
        if (!irTypeEquals(newValueType, setter.params[0]!)) {
          demoteToLegacy(
            "property-write-unsupported",
            `ir/from-ast: assignment to setter ${recvType.shape.className}.${fieldName} (${describeIrType(setter.params[0]!)}) got ${describeIrType(newValueType)} (${cx.funcName})`,
          );
        }
        cx.builder.emitClassCall(recv, fieldName, "setter", [newValue], null, setter.target);
        return;
      }
      demoteToLegacy(
        "property-write-unsupported",
        `ir/from-ast: class ${recvType.shape.className} has no field "${fieldName}" in ${cx.funcName}`,
      );
    }
    lowerCheckedClassFieldSet(recv, recvType.shape, fieldName, expr.right, cx);
    return;
  }

  if (recvType.kind === "object") {
    const fieldIdx = recvType.shape.fields.findIndex((f) => f.name === fieldName);
    if (fieldIdx < 0) {
      demoteToLegacy(
        "property-write-unsupported",
        `ir/from-ast: object has no field "${fieldName}" (shape: ${describeIrType(recvType)}) in ${cx.funcName}`,
      );
    }
    const fieldType = recvType.shape.fields[fieldIdx]!.type;
    const rawValue = lowerExpr(expr.right, cx, fieldType);
    const newValue = irTypeEquals(cx.builder.typeOf(rawValue), fieldType)
      ? rawValue
      : (coerceIrNumeric(rawValue, fieldType, cx) ?? rawValue);
    const newValueType = cx.builder.typeOf(newValue);
    if (!irTypeEquals(newValueType, fieldType)) {
      demoteToLegacy(
        "property-write-unsupported",
        `ir/from-ast: assignment to .${fieldName} (${describeIrType(fieldType)}) got ${describeIrType(newValueType)} (${cx.funcName})`,
      );
    }
    cx.builder.emitObjectSet(recv, fieldName, newValue);
    return;
  }

  // (#2856) Extern-class property write (`box.textContent = "x"`,
  // `e.style.cssText = css`, `host.innerHTML = ""`). Chain-walking
  // resolution like the read arm; the instr's className is the DEFINING
  // class so the lowered import is `<definer>_set_<prop>`
  // (`Element_set_textContent` for an HTMLDivElement receiver). The value
  // coerces to the registered property ValType exactly as extern method
  // args do. Readonly properties never resolve as writable in the lib, so
  // TS source that assigns them failed checking before reaching us.
  if (recvType.kind === "extern") {
    const standaloneDomSet = cx.resolver?.standaloneDomOperation?.(expr) ?? cx.resolver?.standaloneDomOperation?.(lhs);
    const exactStandaloneDomSet =
      standaloneDomSet?.kind === "member-set" &&
      standaloneDomSet.assignment === expr &&
      standaloneDomSet.access === lhs;
    assertNotDeferred(
      domSurfaceCapability(cx.resolver?.jsHostExterns?.() === true, exactStandaloneDomSet),
      `extern property write .${fieldName}`,
      cx.funcName,
    );
    const resolved = cx.resolver?.resolveExternMember?.(recvType.className, fieldName, "property", lhs);
    if (!resolved?.property) {
      demoteToLegacy(
        "property-write-unsupported",
        `ir/from-ast: extern class ${recvType.className} has no property "${fieldName}" in ${cx.funcName}`,
      );
    }
    if (exactStandaloneDomSet && `${resolved.importPrefix}_set_${fieldName}` !== standaloneDomSet.importName) {
      throw new IrInvariantError(
        "selection-preparation-mismatch",
        "build",
        `ir/from-ast: certified DOM property write resolved to the wrong import (${cx.funcName})`,
      );
    }
    const newValue = lowerExpr(expr.right, cx, irVal(resolved.property.type));
    const coerced = coerceToExpectedExtern(
      newValue,
      resolved.property.type,
      cx,
      `value of .${fieldName}`,
      exactStandaloneDomSet ? standaloneDomSet.valueBoundary : undefined,
    );
    cx.builder.emitExternPropSet(resolved.importPrefix, fieldName, recv, coerced);
    return;
  }

  throw new IrUnsupportedError(
    "property-write-unsupported",
    "build",
    `ir/from-ast: property assignment on ${describeIrType(recvType)} is not in slice 4 (${cx.funcName})`,
  );
}

/** Shared typed field write for source assignments and constructor elements. */
function lowerCheckedClassFieldSet(
  receiver: IrValueId,
  shape: IrClassShape,
  fieldName: string,
  expression: ts.Expression,
  cx: LowerCtx,
): void {
  const field = shape.fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    demoteToLegacy(
      "property-write-unsupported",
      `ir/from-ast: class ${shape.className} has no field "${fieldName}" in ${cx.funcName}`,
    );
  }
  const rawValue = lowerExpr(expression, cx, field.type);
  // (#3673) Native numeric slots retain their physical representation while
  // JavaScript expressions remain number-valued at the source boundary.
  const newValue = irTypeEquals(cx.builder.typeOf(rawValue), field.type)
    ? rawValue
    : (coerceIrNumeric(rawValue, field.type, cx) ?? rawValue);
  const newValueType = cx.builder.typeOf(newValue);
  if (!irTypeEquals(newValueType, field.type)) {
    demoteToLegacy(
      "property-write-unsupported",
      `ir/from-ast: assignment to ${shape.className}.${fieldName} (${describeIrType(field.type)}) got ${describeIrType(newValueType)} (${cx.funcName})`,
    );
  }
  cx.builder.emitClassSet(receiver, fieldName, newValue);
}

function lowerConstructorFieldInitializers(
  initializers: readonly IrClassInstanceInitializer[],
  receiver: IrValueId,
  cx: LowerCtx,
): void {
  const receiverType = cx.builder.typeOf(receiver);
  if (receiverType.kind !== "class") {
    demoteToLegacy("body-shape-rejected", `ir/from-ast: constructor receiver is not class-shaped (${cx.funcName})`);
  }
  let priorOrdinal = -1;
  for (const initializer of initializers) {
    if (initializer.sourceOrdinal <= priorOrdinal) {
      // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
      throw new Error(`ir/from-ast: constructor field plan is not in source order (${cx.funcName})`);
    }
    priorOrdinal = initializer.sourceOrdinal;
    lowerCheckedClassFieldSet(receiver, receiverType.shape, initializer.fieldName, initializer.expression, cx);
  }
}

// ---------------------------------------------------------------------------
// for-of statement lowering (slice 6 part 2 — #1181)
// ---------------------------------------------------------------------------
//
// Activates the slice-6 IR scaffolding shipped by #1169e. Lowers
// `for (const x of arr)` over a vec ref to a `forof.vec` declarative
// instr, with the loop variable bound as a `slot` ScopeBinding inside
// the body. Body statements go through `lowerStmt` (separate from
// `lowerStatementList` — the body is non-tail, no early-return / nested
// closures, just simple statement forms).
//
// Iterables that don't lower to a `(ref|ref_null) $vec_*` ValType throw
// and the function falls back to legacy. The iterator-protocol path
// (Map / Set / generators) lands in #1182.

// ---------------------------------------------------------------------------
// yield lowering (slice 7a — #1169f)
// ---------------------------------------------------------------------------

/**
 * Slice 7a/7b (#1169f): lower a yield expression-statement. The yielded
 * value is pushed onto the generator's `__gen_buffer` Wasm-local slot
 * via `gen.push`, which the lowerer expands to a typed `__gen_push_*`
 * host call dispatched on the value's IrType (f64 → push_f64,
 * i32 → push_i32, otherwise externref → push_ref).
 *
 * Slice 7b adds three extensions:
 *   - **Bare `yield;`** — emits a null-externref const + `gen.push`,
 *     matching legacy's "yield with no value" semantics (every
 *     consumer sees `IteratorResult { value: undefined, done: false }`
 *     for that step).
 *   - **`yield <non-numeric>`** — strings, booleans-as-i32 stay native;
 *     ref/object/class/closure values coerce to externref via
 *     `coerce.to_externref` (the `extern.convert_any` Wasm op), then
 *     flow through `__gen_push_ref(buf, externref)`.
 *   - **`yield* <iterable>`** — coerces the iterable to externref and
 *     emits `gen.yieldStar`, which lowers to
 *     `__gen_yield_star(buf, iterable)`. The host iterator-protocol
 *     drains every value from the inner iterable into the outer
 *     buffer (see `runtime.ts:2999`).
 *
 * Defensive: throws if the enclosing function isn't a generator. The
 * selector should have rejected the function in that case, but a
 * defensive check here surfaces selector regressions as a clean
 * fall-back to legacy rather than malformed Wasm.
 */
function lowerYield(expr: ts.YieldExpression, cx: LowerCtx): void {
  if (cx.funcKind !== "generator") {
    demoteToLegacy("body-shape-rejected", `ir/from-ast: yield outside generator function in ${cx.funcName}`);
  }

  // ---------------------------------------------------------------
  // `yield* <iterable>` — slice 7b.
  // ---------------------------------------------------------------
  if (expr.asteriskToken) {
    if (!expr.expression) {
      // TS parser enforces this; keep as defense-in-depth.
      demoteToLegacy("body-shape-rejected", `ir/from-ast: yield* requires an iterable in ${cx.funcName}`);
    }
    // Lower the iterable with an externref hint; the iterable's
    // actual IrType might be vec/string/object/externref. Coerce to
    // externref via the slice-6-part-3 helper so the host
    // `__gen_yield_star(externref, externref)` import sees the
    // right Wasm value type.
    const inner = lowerExpr(expr.expression, cx, irVal({ kind: "externref" }));
    const innerExt = coerceIrValueToExternref(cx.builder, inner);
    cx.builder.emitGenYieldStar(innerExt);
    return;
  }

  // ---------------------------------------------------------------
  // Bare `yield;` (no value) — slice 7b.
  // ---------------------------------------------------------------
  if (!expr.expression) {
    // Materialize a null externref and push as ref. Legacy emits
    // the same shape (`__gen_push_ref(buf, ref.null.extern)`) when
    // a `yield;` statement appears in a generator body.
    const nullExt = cx.builder.emitConst(
      { kind: "null", ty: irVal({ kind: "externref" }) },
      irVal({ kind: "externref" }),
    );
    cx.builder.emitGenPush(nullExt);
    return;
  }

  // ---------------------------------------------------------------
  // `yield <expr>` — slice 7a (numeric) and 7b (any Phase-1 type).
  // ---------------------------------------------------------------
  // Lower with an externref hint as a fallback shape; the IR type
  // recovered via `typeOf` drives the dispatch below. For numeric
  // and bool yields the lowerer's downstream typing keeps them as
  // f64/i32 — `lowerExpr`'s `hint` is advisory, not authoritative.
  const value = lowerExpr(expr.expression, cx, irVal({ kind: "externref" }));
  const valueType = cx.builder.typeOf(value);
  const valTy = asVal(valueType);
  if (valTy?.kind === "f64" || valTy?.kind === "i32") {
    // Native primitive yield — `gen.push` lowerer dispatches to
    // `__gen_push_f64` / `__gen_push_i32` directly.
    cx.builder.emitGenPush(value);
    return;
  }
  // Reference-shaped yield — coerce to externref so the lowerer's
  // `__gen_push_ref(buf, externref)` arm sees the right Wasm type.
  const valueExt = coerceIrValueToExternref(cx.builder, value);
  cx.builder.emitGenPush(valueExt);
}

/**
 * #1798 — reconcile a lowered return value with the function's declared
 * result type before terminating with `return`.
 *
 * The return expression is lowered with `cx.returnType` as an *advisory*
 * hint, but several expression kinds honestly produce their concrete type
 * regardless of the hint (most notably `new C()` → `IrType.class` (struct
 * ref), object literals → struct ref). When the function declares `: any`
 * (which `resolvePositionType` maps to `externref`, see
 * `src/codegen/index.ts:438`), a `(ref $C) → externref` mismatch would reach
 * `return` and the emitted body fails Wasm validation
 * (`return[0] expected externref, got (ref null N)`).
 *
 * The legacy return path (`compileReturnStatement` →
 * `coerceType(exprType, fctx.returnType)`) coerces here; the IR return-tail
 * previously did not. This mirrors that coercion for the externref case:
 *
 *   - Declared result is `externref` and the value is reference-shaped
 *     (class / object / closure / vec ref / ref_null / native-string) →
 *     coerce via `coerceIrValueToExternref` (`extern.convert_any`). This
 *     is a zero-cost re-tag valid for any anyref subtype, agnostic to the
 *     exact struct typeIdx (so type compaction cannot break it).
 *   - Declared result is `externref` but the value is a native scalar
 *     (`f64` / `i32`) → throw a clean "not in slice" fallback. Boxing a
 *     number to externref needs `__box_number`; the IR has no box primitive
 *     yet, and the legacy path boxes correctly. Deferring mirrors the
 *     existing numeric-throw deferral in `lowerThrowStatement`.
 *
 * All other cases (matching kinds, already-externref values, non-externref
 * declared results) pass through unchanged.
 */
function coerceReturnValue(value: IrValueId, cx: LowerCtx, sourceExpression?: ts.Expression): IrValueId {
  const declared = cx.returnType;
  if (declared?.kind === "callable") {
    const actual = cx.builder.typeOf(value);
    if (actual.kind === "callable" && closureSignatureEquals(actual.signature, declared.signature)) return value;
    if (actual.kind === "closure" && closureSignatureEquals(actual.signature, declared.signature)) {
      return cx.builder.emitCallablePack(value, declared.signature);
    }
    return value;
  }
  if (declared?.kind === "dynamic") {
    const actual = cx.builder.typeOf(value);
    if (actual.kind === "dynamic") return value;
    if (sourceExpression) {
      const boxed = boxConcreteToDynamic(value, actual, sourceExpression, cx);
      if (boxed !== null) return boxed;
    }
    // (#4027) The from-ast half of the #1798 return-value concern that
    // `return-type-legacy-coupling` already covers on the verify side. This is
    // the documented "clean 'not in slice' fallback", NOT a compiler invariant,
    // so it must demote the function to legacy rather than abort the compile.
    throw new IrUnsupportedError(
      "return-type-legacy-coupling",
      "build",
      `ir/from-ast: concrete return needs a dynamic box in ${cx.funcName}`,
    );
  }
  // (#2856 C3) externref value into a NUMBER (f64) declared result —
  // `return hit;` where `hit = cache.get(n)` is the externref Map_get
  // result. Unbox through `__unbox_number`, exactly what legacy emits for
  // the same site (import registered by legacy's own compile in the
  // dual-compile model). Gated on the resolver's number-box capability
  // (#2955) — the lane without `__unbox_number` demotes. Before this
  // arm such returns slipped to the verifier's #1798 gate and demoted;
  // now they lower like legacy.
  if (declared && declared.kind === "val" && declared.val.kind === "f64") {
    const actualT = cx.builder.typeOf(value);
    const actualV = asVal(actualT);
    if (actualV && actualV.kind === "externref") {
      // (#4461) Both lanes own a `__unbox_number` with the same
      // `(externref) -> f64` signature; only the PROVIDER differs (host import
      // vs the native function `addUnionImports` registers under
      // `semanticProviders: "native-first"`). A host-free `Map.get` result
      // reaches this site with a boxed number inside an externref, so the
      // native arm is what makes `return hit;` lower instead of demoting.
      const provider = cx.resolver?.hasHostNumberBox?.()
        ? irImportFuncRef("env", "__unbox_number")
        : cx.resolver?.hasNativeNumberUnbox?.()
          ? irRuntimeFuncRef("__unbox_number")
          : null;
      if (provider !== null) {
        const unboxed = cx.builder.emitCall(provider, [value], irVal({ kind: "f64" }));
        if (unboxed === null) {
          // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
          throw new Error(`ir/from-ast: __unbox_number produced no result in ${cx.funcName}`);
        }
        return unboxed;
      }
    }
    return value;
  }
  // Only the externref (TS `any`) declared-result case can mismatch here;
  // native scalar / matching-ref returns already line up via the hint.
  if (!declared || declared.kind !== "val" || declared.val.kind !== "externref") {
    return value;
  }
  const actual = cx.builder.typeOf(value);
  // Already externref — nothing to do.
  if (actual.kind === "val" && actual.val.kind === "externref") {
    return value;
  }
  // Native scalar → externref needs a box helper the IR lacks; defer the whole
  // function to legacy. (#2785) Legacy's box is now TYPE-AWARE — `coerceType(i32
  // → externref)` picks `__box_boolean` / `__box_symbol` / `__box_number` from
  // the value's brand — so this demote is type-correct for a `boolean`/`symbol`
  // scalar too, not only a number. The IR still has no box primitive of its own;
  // it inherits the type-aware box for free via demote-to-legacy.
  const actualVal = asVal(actual);
  // #2782 (hybrid Row 5) — the no-box NUMBER escape edge. An unboxed `f64`
  // number returned into an `any` (externref) result is the canonical "number
  // local / value sinks to an `any` sink" case: the IR keeps numbers unboxed
  // (no runtime tag), so handing one to the dynamic `any` result without an
  // explicit box would lose its identity. The IR has no box primitive, so the
  // SAFE lowering is to demote to legacy (which boxes via `__box_number`). This
  // is the reachable, claimable counterpart to the `lowerVarDecl` declaration
  // gate (`proveUnboxedNumberLocal`): together they keep the value unboxed only
  // while it is provably a pure number AND box it at the proven escape edge.
  if (actualVal && actualVal.kind === "f64") {
    demoteToLegacy(
      "return-type-legacy-coupling",
      `ir/from-ast: unboxed f64 number returned into an 'any' (externref) result — the ` +
        `no-box number representation is unsound at this escape sink; demote to the SAFE ` +
        `boxed legacy lowering (boxes via __box_number) in ${cx.funcName} (#2782)`,
    );
  }
  if (actualVal && (actualVal.kind === "i32" || actualVal.kind === "i64")) {
    demoteToLegacy(
      "return-type-legacy-coupling",
      `ir/from-ast: return of numeric ${actualVal.kind} into an 'any' (externref) result ` +
        `needs the box helper — deferring to legacy in ${cx.funcName}`,
    );
  }
  // Reference-shaped (class / object / closure / vec ref / ref_null /
  // native-string) → extern.convert_any. `coerceIrValueToExternref` is a
  // no-op for host-strings (already externref) and re-tags all anyref
  // subtypes otherwise.
  return coerceIrValueToExternref(cx.builder, value);
}

/**
 * Lower a `for (const|let <id> of <expr>) <body>` statement using the
 * vec fast path. The iterable expression must lower to an IR value
 * whose ValType is `(ref $vec_*)` or `(ref_null $vec_*)`. The vec's
 * struct shape (`{ length: i32, data: (ref $arr_<elem>) }`) is read at
 * lowering time via `inferVecElementValType` so we can pre-allocate
 * the element slot with the right ValType.
 */
function lowerForOfStatement(stmt: ts.ForOfStatement, cx: LowerCtx): void {
  // 1. Lower the iterable. Pass an externref hint — the actual IR type
  //    is inferred from the lowered value.
  const iterableV = lowerExpr(stmt.expression, cx, irVal({ kind: "externref" }));
  const iterableT = cx.builder.typeOf(iterableV);

  // 2. Resolve the loop-variable name. The selector enforces a single
  //    Identifier-named decl in `(const|let)` form. Shared between vec
  //    and iter-host arms.
  const init = stmt.initializer;
  if (!ts.isVariableDeclarationList(init) || init.declarations.length !== 1) {
    demoteToLegacy("body-shape-rejected", `ir/from-ast: for-of init shape unexpected (${cx.funcName})`);
  }
  const decl = init.declarations[0]!;
  if (!ts.isIdentifier(decl.name)) {
    demoteToLegacy("body-shape-rejected", `ir/from-ast: for-of destructuring init not in slice 6 (${cx.funcName})`);
  }
  const loopVarName = decl.name.text;

  // 3. Strategy dispatch.
  //
  //   - `(val) ref|ref_null`        → vec path (slice 6 part 2 — #1181).
  //                                    The lowerer's resolveVec validates
  //                                    the struct's `{ length, data }`
  //                                    shape; if it isn't a vec, lowering
  //                                    throws and the function falls back
  //                                    to legacy.
  //   - `string`                     → per the resolver's `stringForOfPlan`
  //                                    (#2955 slice 5): `"char-loop"` =
  //                                    string fast path (slice 6 part 4 —
  //                                    #1183), counter loop with
  //                                    `__str_charAt`; `"iter-host"` (or no
  //                                    resolver) = fall through to
  //                                    iter-host — the host-mode string IR
  //                                    value is already externref-backed,
  //                                    so no coercion is needed.
  //   - `(val) externref`           → iter-host (slice 6 part 3 — #1182).
  //   - `class` / `object`           → iter-host (with extern.convert_any
  //                                    coercion).
  //   - anything else                → throw, fall back to legacy.
  const valTy = asVal(iterableT);
  if (iterableT.kind === "vec") {
    lowerForOfVec(stmt, cx, iterableV, iterableT, loopVarName);
    return;
  }
  if (valTy && (valTy.kind === "ref" || valTy.kind === "ref_null")) {
    lowerForOfVec(stmt, cx, iterableV, iterableT, loopVarName);
    return;
  }
  if (iterableT.kind === "string") {
    // (#2955 slice 5) The strategy selection is resolver-owned; from-ast
    // reads no `nativeStrings` here. Resolver-absent → iter-host, preserving
    // the legacy falsy fallthrough of the old `nativeStrings?.()` read.
    if (cx.resolver?.stringForOfPlan?.() === "char-loop") {
      lowerForOfString(stmt, cx, iterableV, loopVarName);
      return;
    }
    // Iter-host strategy: the string's underlying ValType is already
    // externref, so no coercion is needed — the iter-host arm passes
    // `iterableV` straight to `__iterator`. We bind the loop variable as
    // externref (host strings only have host-side string semantics; the
    // iter-host element is opaque externref by design).
    lowerForOfIterFromExternrefValue(stmt, cx, iterableV, loopVarName, /* alreadyExternref */ true);
    return;
  }

  // Iter-host arm: externref / class / object iterables.
  const isIterHostEligible = valTy?.kind === "externref" || iterableT.kind === "class" || iterableT.kind === "object";
  if (!isIterHostEligible) {
    demoteToLegacy(
      "body-shape-rejected",
      `ir/from-ast: for-of iterable type ${describeIrType(iterableT)} not supported in slice 6 (${cx.funcName})`,
    );
  }
  lowerForOfIterFromExternrefValue(stmt, cx, iterableV, loopVarName, valTy?.kind === "externref");
}

/**
 * #2952 slice 5 — lower the runtime-dynamic for-in shape through the shared
 * #2964 enumeration ABI.
 *
 * Keys are snapshotted once, then each candidate is checked for liveness
 * immediately before the user body. The loop itself reuses `for.loop`, so
 * break/continue and early return keep the structured-control semantics
 * already shipped by the earlier #2952 slices.
 */
function lowerForInStatement(stmt: ts.ForInStatement, cx: LowerCtx): void {
  const plan = cx.resolver?.dynamicForInPlan?.();
  if (!plan) {
    throw new IrUnsupportedError(
      "body-shape-rejected",
      "build",
      `ir/from-ast: dynamic for-in runtime is unavailable in ${cx.funcName}`,
    );
  }
  const init = stmt.initializer;
  if (!ts.isVariableDeclarationList(init) || init.declarations.length !== 1) {
    // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
    throw new Error(`ir/from-ast: for-in init shape drift in ${cx.funcName}`);
  }
  const declaration = init.declarations[0]!;
  if (!ts.isIdentifier(declaration.name) || declaration.initializer) {
    // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
    throw new Error(`ir/from-ast: for-in head shape drift in ${cx.funcName}`);
  }

  const receiver = lowerExpr(stmt.expression, cx, irDynamic());
  if (cx.builder.typeOf(receiver).kind !== "dynamic") {
    // invariant (producer-promise): the carrier the producer promised was dropped — #4502.
    throw new Error(`ir/from-ast: for-in receiver lost dynamic carrier in ${cx.funcName}`);
  }

  const externref = irVal({ kind: "externref" });
  const i32 = irVal({ kind: "i32" });
  const keys = cx.builder.emitCall(irRuntimeFuncRef(plan.keys), [receiver], externref);
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (keys === null) throw new Error(`ir/from-ast: for-in keys helper returned void in ${cx.funcName}`);
  const length = cx.builder.emitCall(irRuntimeFuncRef(plan.len), [keys], i32);
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (length === null) throw new Error(`ir/from-ast: for-in length helper returned void in ${cx.funcName}`);

  const counterSlot = cx.builder.declareSlot("__forin_i", { kind: "i32" });
  const keySlot = cx.builder.declareSlot(`__forin_${declaration.name.text}`, { kind: "externref" });
  cx.builder.emitSlotWrite(counterSlot, cx.builder.emitConst({ kind: "i32", value: 0 }, i32));

  let condValue: IrValueId | null = null;
  const cond = cx.builder.collectBodyInstrs(() => {
    condValue = cx.builder.emitBinary("i32.lt_s", cx.builder.emitSlotRead(counterSlot), length, i32);
  });
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (condValue === null) throw new Error(`ir/from-ast: for-in condition produced no value in ${cx.funcName}`);

  const loopLabel = cx.pendingLoopLabel ?? cx.builder.freshLoopLabel();
  const loopScope = conservativeLoopStringEncodingScope(stmt, cx);
  const bodyScope = new Map(loopScope);
  // #2952 slice 6c — the head binding is now READABLE in the body. The key
  // helper hands back an externref; when the active string carrier IS the
  // host externref (`resolveString()`), that value is interchangeable with an
  // `IrType.string`, so tag the binding `asType: string` and identifier reads
  // compose with the ordinary string ops — the same `asType` idiom
  // `lowerForOfString` uses for its `(ref $AnyString)` element slot. On a
  // native-strings lane the carriers differ, so the tag is withheld and the
  // selector's `forInHeadValueIsHostString` gate keeps head-value uses off
  // the IR path entirely (fail-closed, not claim-then-demote).
  const headIsHostString = cx.resolver?.resolveString?.()?.kind === "externref";
  bodyScope.set(declaration.name.text, {
    kind: "slot",
    slotIndex: keySlot,
    type: externref,
    ...(headIsHostString ? { asType: { kind: "string" } as IrType } : {}),
  });
  const bodyCx: LowerCtx = {
    ...cx,
    scope: bodyScope,
    loopLabel,
    breakTargetLabel: loopLabel,
    pendingLoopLabel: undefined,
  };
  const body = cx.builder.collectBodyInstrs(() => {
    const key = cx.builder.emitCall(
      irRuntimeFuncRef(plan.get),
      [keys, cx.builder.emitSlotRead(counterSlot)],
      externref,
    );
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    if (key === null) throw new Error(`ir/from-ast: for-in key helper returned void in ${cx.funcName}`);
    cx.builder.emitSlotWrite(keySlot, key);
    const live = cx.builder.emitCall(irRuntimeFuncRef(plan.has), [receiver, key], i32);
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    if (live === null) throw new Error(`ir/from-ast: for-in liveness helper returned void in ${cx.funcName}`);
    const liveBody = cx.builder.collectBodyInstrs(() => lowerStmt(stmt.statement, bodyCx));
    cx.builder.emitIfStmt({ cond: live, then: liveBody, else: [] });
  });

  const update = cx.builder.collectBodyInstrs(() => {
    const one = cx.builder.emitConst({ kind: "i32", value: 1 }, i32);
    const next = cx.builder.emitBinary("i32.add", cx.builder.emitSlotRead(counterSlot), one, i32);
    cx.builder.emitSlotWrite(counterSlot, next);
  });
  cx.builder.emitForLoop({ cond, condValue, body, update, loopLabel });
  joinScopeStringEncodingFacts(cx.scope, [loopScope]);
}

// ---------------------------------------------------------------------------
// Slice 12 (#1280) — generic structured loops (`while` / `for`)
// ---------------------------------------------------------------------------

/**
 * Slice 12 (#1280): lower `while (cond) body` to an IR `while.loop`
 * declarative instruction.
 *
 * Pattern: collect the cond expression's IR into a buffer, capture the
 * resulting i32 SSA value, collect the body statements into another
 * buffer, then emit `while.loop`. The lowerer emits the canonical
 * `block { loop { <cond>; i32.eqz; br_if 1; <body>; br 0 } }` Wasm
 * pattern.
 *
 * The body uses a fresh scope (cloned from `cx.scope`) so any
 * `let`-decls inside the body don't leak out — the selector's
 * `mutatedLets` analysis already tagged any outer `let` whose name
 * the body reassigns as slot-bound, so cross-iteration writes go
 * through `slot.read` / `slot.write` and survive the loop.
 */
/**
 * (#4512) §7.1.2 ToBoolean for a value in CONDITION / ternary / `!` position.
 * Returns an i32 truthiness BRANDED `irBool()` (a proven JS boolean, #4503), or
 * `null` when the carrier is a raw host `externref` — its value may box a falsy
 * primitive (`0`/`""`/`false`/`NaN`/`undefined`), so a `ref.is_null` test would
 * be a WRONG answer; the caller DEMOTES cleanly instead of mis-lowering.
 *
 * Per-carrier §7.1.2 (pinned by value in tests/issue-4512.test.ts): i32 passes
 * through; f64 → `abs(x) > 0` (NaN-safe, #1937); string → `length !== 0`;
 * object/class/closure/non-null ref → always truthy; nullable wasmgc ref →
 * `ref.is_null; i32.eqz`; dynamic → `dyn.truthy` (full ToBoolean, D4); host
 * externref/ref_extern → `null` (demote). MUST be called inside the loop
 * cond-buffer closure so it re-runs each iteration.
 */
function lowerToBooleanForCondition(
  condValue: IrValueId,
  conditionExpr: ts.Expression,
  cx: LowerCtx,
): IrValueId | null {
  const irType = cx.builder.typeOf(condValue);
  if (irType.kind === "dynamic") {
    // Full JS truthiness on the boxed-any carrier: one ToBoolean engine (D4).
    return cx.builder.emitDynTruthy(condValue);
  }
  const kind = asVal(irType)?.kind;
  if (kind === "i32") return condValue;
  if (kind === "f64") {
    // ToBoolean(f64) = abs(x) > 0  (false for 0, -0, NaN; true otherwise).
    const absV = cx.builder.emitUnary("f64.abs", condValue, irVal({ kind: "f64" }));
    const zero = cx.builder.emitConst({ kind: "f64", value: 0 }, irVal({ kind: "f64" }));
    return cx.builder.emitBinary("f64.gt", absV, zero, IR_BOOL);
  }
  if (irType.kind === "string") {
    const length = cx.builder.emitStringLen(condValue, inferStringEncoding(conditionExpr, cx));
    const zero = cx.builder.emitConst({ kind: "f64", value: 0 }, irVal({ kind: "f64" }));
    return cx.builder.emitBinary("f64.gt", length, zero, IR_BOOL);
  }
  if (irType.kind === "object" || irType.kind === "class" || irType.kind === "closure" || kind === "ref") {
    // A statically non-null wasmgc reference is ALWAYS truthy.
    return cx.builder.emitConst({ kind: "bool", value: true }, IR_BOOL);
  }
  if (
    irType.kind === "callable" ||
    kind === "ref_null" ||
    kind === "funcref" ||
    kind === "eqref" ||
    kind === "anyref"
  ) {
    // Nullable wasmgc reference: truthy iff non-null.
    const isNull = cx.builder.emitRefIsNull(condValue);
    return cx.builder.emitUnary("i32.eqz", isNull, IR_BOOL);
  }
  // Host external carrier (extern / externref / ref_extern): ToBoolean needs the
  // JS host and a null test is a WRONG answer — demote (return null) instead.
  return null;
}

/**
 * #2136 — coerce a loop condition SSA value to an i32 boolean via ToBoolean.
 *
 * The `{while,for}.loop` lowerer emits `<condValue>; i32.eqz; br_if 1`, which
 * requires an i32 condValue. An f64 (numeric) condition is converted with the
 * NaN-safe ToBoolean `abs(x) > 0` — `f64.abs` folds `-0` to `0` and `NaN > 0`
 * is false, so `0`, `-0` and `NaN` are all falsy (matching JS ToBoolean and
 * the linear backend's `emitTruthyCoercion`, #1937). An i32 value is already a
 * bool and passes through. Strings test their length, statically non-null
 * object/class/closure values are always truthy, and nullable reference
 * carriers use `ref.is_null`.
 *
 * MUST be called inside the `collectBodyInstrs` closure that builds the cond
 * buffer so the coercion instructions re-run each iteration.
 */
function coerceLoopCondToBool(
  condValue: IrValueId,
  conditionExpr: ts.Expression,
  cx: LowerCtx,
  loopKind: "while" | "for" | "do" | "if",
): IrValueId {
  // (#4512) Shared §7.1.2 ToBoolean. A raw host externref returns null (no
  // cheap host-free ToBoolean) — demote rather than emit a wrong truthiness.
  const result = lowerToBooleanForCondition(condValue, conditionExpr, cx);
  if (result !== null) return result;
  demoteToLegacy("operand-coercion-unsupported", `ir/from-ast: ${loopKind} condition must be bool in ${cx.funcName}`);
}

function lowerWhileStatement(stmt: ts.WhileStatement, cx: LowerCtx): void {
  // #2952 slice 3 — a labeled loop adopts the pre-allocated id (consumed
  // here; cleared below so nested loops mint their own).
  const loopLabel = cx.pendingLoopLabel ?? cx.builder.freshLoopLabel();
  const loopCx: LowerCtx = {
    ...cx,
    scope: conservativeLoopStringEncodingScope(stmt, cx),
    pendingLoopLabel: undefined,
  };
  // Capture the value id `lowerExpr` returns rather than the cond buffer's
  // last instruction result — the latter is fragile (e.g. a trailing store
  // produces no value). (#1980)
  let condResult: IrValueId | null = null;
  const condInstrs = loopCx.builder.collectBodyInstrs(() => {
    const raw = lowerExpr(stmt.expression, loopCx, irVal({ kind: "i32" }));
    // #2136 — an f64 (numeric-truthiness) condition was previously bailed to
    // legacy (#1980) because the lowerer's unconditional `i32.eqz` on an f64
    // emitted invalid Wasm. Instead, coerce it to an i32 bool via ToBoolean
    // INSIDE the cond buffer (so the coercion re-runs each iteration) and use
    // the coerced value as `condValue`. The shared coercer also handles the
    // proven string and reference families accepted by the selector.
    condResult = coerceLoopCondToBool(raw, stmt.expression, loopCx, "while");
  });
  if (condResult === null || condResult === undefined) {
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error(`ir/from-ast: while cond produced no SSA value (${cx.funcName})`);
  }
  // #2952 slice 2 — the loop's label is threaded as the innermost loop for
  // the body, so unlabeled break/continue resolve here.
  const bodyCx: LowerCtx = { ...loopCx, scope: new Map(loopCx.scope), loopLabel, breakTargetLabel: loopLabel };
  const bodyInstrs = loopCx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.statement, bodyCx);
  });
  loopCx.builder.emitWhileLoop({
    cond: condInstrs,
    condValue: condResult,
    body: bodyInstrs,
    loopLabel,
  });
  joinScopeStringEncodingFacts(cx.scope, [loopCx.scope]);
}

/**
 * #2952 slice 1 — lower `do { body } while (cond)` to a `while.loop` IR
 * instr with `postCond: true`. A do-while is a POST-test loop: the body
 * runs once unconditionally, then the cond decides whether to repeat. It
 * reuses the `while.loop` node (same cond / body buffers) so no pass needs
 * a new instr kind; the lowerer's `postCond` flag flips the emission order
 * (body → cond-check) to `block { loop { <body>; <cond>; i32.eqz; br_if 1;
 * br 0 } }`.
 *
 * Bodies containing `break` / `continue` are rejected up-front by the
 * selector (`isPhase1BodyStatement` has no break/continue arm — same as
 * the already-adopted `while` / `for`), so this slice only claims the
 * multi-exit-free subset and never reaches a demote channel post-claim.
 */
function lowerDoStatement(stmt: ts.DoStatement, cx: LowerCtx): void {
  // #2952 slice 3 — adopt a labeled statement's pre-allocated id when set.
  const loopLabel = cx.pendingLoopLabel ?? cx.builder.freshLoopLabel();
  const loopCx: LowerCtx = {
    ...cx,
    scope: conservativeLoopStringEncodingScope(stmt, cx),
    pendingLoopLabel: undefined,
  };
  // Body first (buffer built exactly as `while`, just emitted before cond
  // at lower time). Scope mirrors the while path. (#2952 slice 2) The
  // synthesised label makes this loop the innermost break/continue target;
  // a continue falls through to the cond (post-test semantics).
  const bodyCx: LowerCtx = { ...loopCx, scope: new Map(loopCx.scope), loopLabel, breakTargetLabel: loopLabel };
  const bodyInstrs = loopCx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.statement, bodyCx);
  });

  // Cond buffer — re-evaluated each iteration (after the body).
  let condResult: IrValueId | null = null;
  const condInstrs = loopCx.builder.collectBodyInstrs(() => {
    const raw = lowerExpr(stmt.expression, bodyCx, irVal({ kind: "i32" }));
    condResult = coerceLoopCondToBool(raw, stmt.expression, bodyCx, "do");
  });
  if (condResult === null || condResult === undefined) {
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error(`ir/from-ast: do-while cond produced no SSA value (${cx.funcName})`);
  }

  loopCx.builder.emitWhileLoop({
    cond: condInstrs,
    condValue: condResult,
    body: bodyInstrs,
    postCond: true,
    loopLabel,
  });
  joinScopeStringEncodingFacts(cx.scope, [loopCx.scope]);
}

/**
 * Slice 12 (#1280): lower `for (init; cond; update) body` to an IR
 * `for.loop` declarative instruction.
 *
 * The init clause is emitted INLINE before the for.loop instr (a
 * `let` declaration becomes a `lowerVarDecl`; an expression init
 * becomes a `lowerExpr` whose result is dropped). Cond, update, and
 * body are collected into separate buffers carried on the for.loop
 * instr. The loop variable's binding enters scope before
 * cond/update/body are lowered.
 */
/**
 * #2766 — does the `for`'s initializer declare `indexVar` with a non-negative
 * numeric-literal initializer (`let i = 0`, `let i = 5`, …)? Part of the
 * counted-loop in-bounds proof's lower-bound half. Conservative: anything that
 * is not a plain non-negative numeric literal (a prefix `-1`, a computed init,
 * an index declared outside the loop) returns false → the read falls to the SAFE
 * lowering rather than being (unsoundly) trusted.
 */
/**
 * #2766 — the counted-loop in-bounds proof for the IR. Returns the
 * `"arrayVar:indexVar"` key when the `for` provably keeps its index in
 * `[0, array.length)` across the whole body, else `null`.
 *
 * This is a *real* proof (per the hybrid invariant — a compiler-checked fact,
 * not the mere presence of a `: number[]` type), and it is intentionally
 * STRICTER than legacy's `safeIndexedArrays` population (which checked only the
 * `i < arr.length` condition + body non-mutation): the IR fast path emits an
 * UNCHECKED `array.get` that *traps* on OOB, so the proof must also pin the lower
 * bound. We therefore additionally require a non-negative-literal init and a
 * strictly-increasing step, giving `0 <= i` at entry, `i` only increases, and
 * the strict `i < arr.length` condition ⇒ `0 <= i < arr.length` at every body
 * point. Anything not fully proven returns `null` and gets the SAFE read.
 */
function detectCountedLoopSafeIndex(stmt: ts.ForStatement): string | null {
  if (!stmt.condition || !ts.isBinaryExpression(stmt.condition)) return null;
  const cond = stmt.condition;
  const op = cond.operatorToken.kind;
  let indexExpr: ts.Expression | undefined;
  let lengthExpr: ts.Expression | undefined;
  // Strict `i < arr.length`
  if (op === ts.SyntaxKind.LessThanToken) {
    indexExpr = cond.left;
    lengthExpr = cond.right;
  } else if (op === ts.SyntaxKind.GreaterThanToken) {
    // Strict `arr.length > i`
    indexExpr = cond.right;
    lengthExpr = cond.left;
  } else {
    return null; // `<=` / `>=` would admit `i == arr.length` (OOB)
  }
  if (
    !indexExpr ||
    !lengthExpr ||
    !ts.isIdentifier(indexExpr) ||
    !ts.isPropertyAccessExpression(lengthExpr) ||
    !ts.isIdentifier(lengthExpr.name) ||
    lengthExpr.name.text !== "length" ||
    !ts.isIdentifier(lengthExpr.expression)
  ) {
    return null;
  }
  const indexVar = indexExpr.text;
  const arrayVar = lengthExpr.expression.text;
  // Lower bound: i starts >= 0 and strictly increases.
  if (!forInitsIndexNonNegative(stmt, indexVar)) return null;
  if (!isIncreasingStep(stmt.incrementor, indexVar)) return null;
  // Stability: body must not reassign i / arr / arr.length, call a method on arr
  // (could change length), or contain a nested function (could capture+mutate).
  if (loopBodyMutatesIndexOrArray(stmt.statement, indexVar, arrayVar)) return null;
  return arrayVar + ":" + indexVar;
}

/**
 * (#3786) The compile-time entry value of a `for` counter, plus the slot the
 * init wrote it to — or `null` when the initializer is not a single
 * integer-literal `let`/`var` bound to a slot.
 *
 * Must run AFTER the init has been lowered, so the declared name is in scope and
 * its slot index is known. Reporting the slot (not just the value) is what lets
 * `tryEmitUnrolledReduction` refuse `for (let j = 0; i < N; i++)`, where the
 * init's literal says nothing about the counter the condition actually tests.
 */
function literalCounterEntry(stmt: ts.ForStatement, cx: LowerCtx): { value: number; slotIndex: number } | null {
  const init = stmt.initializer;
  if (!init || !ts.isVariableDeclarationList(init) || init.declarations.length !== 1) return null;
  const decl = init.declarations[0];
  if (!ts.isIdentifier(decl.name) || !decl.initializer) return null;
  if (!ts.isNumericLiteral(decl.initializer)) return null;
  const value = Number(decl.initializer.text);
  if (!Number.isSafeInteger(value)) return null;
  const binding = cx.scope.get(decl.name.text);
  if (!binding || binding.kind !== "slot") return null;
  // Deliberately NOT checking `binding.type` for i32: #3741 gives a promoted
  // counter a native i32 SLOT while keeping the binding's IrType at f64 (that is
  // how it avoids a consumption-site blast radius), so an i32 check here rejects
  // every loop this transform exists for. The slot's i32-ness is established
  // structurally instead — the recogniser only accepts a cond/update/body built
  // from `i32.lt_s` / `i32.add` against this same slot index.
  return { value, slotIndex: binding.slotIndex };
}

/**
 * (#3931) Lower a proven char-read loop's INDEX operand to a native i32.
 *
 * The index is the loop's own induction identifier (the match in
 * `matchProvenCharRead` admits nothing else), so when #3741 gave it an i32
 * SLOT the read is just that slot — no `f64.convert_i32_s` / `trunc_sat`
 * round trip, which is a per-iteration saving on top of the dropped guard.
 * Anything else takes the ordinary f64 lowering and the cheap narrowing the
 * guarded helpers' i32 index arg already used.
 */
function lowerCharReadIndexI32(indexExpr: ts.Expression, cx: LowerCtx): IrValueId {
  if (ts.isIdentifier(indexExpr)) {
    const binding = cx.scope.get(indexExpr.text);
    if (binding !== undefined && binding.kind === "slot" && binding.i32Storage === true) {
      return cx.builder.emitSlotRead(binding.slotIndex);
    }
  }
  const numeric = lowerExpr(indexExpr, cx, IR_F64);
  return asVal(cx.builder.typeOf(numeric))?.kind === "i32"
    ? numeric
    : cx.builder.emitUnary("i32.trunc_sat_f64_s", numeric, IR_I32);
}

/**
 * (#3931) Emit one proven `recv.charCodeAt(i)` as a native i32 code unit —
 * the read site half of the #2682 port. The caller must have matched the
 * expression against an ACTIVE proof (`matchProvenCharRead`), which is what
 * makes dropping §22.1.3.3's bounds/NaN arm byte-faithful rather than a
 * semantic change.
 *
 * Native strings: `readFunc(flat, i)` against the receiver flattened once in
 * the preheader — legacy's `emitHoistedCharCodeAtRead`, one (inlinable) call
 * deep. Host strings: the unguarded builtin wrapper, with the receiver
 * lowered here (a plain identifier read — no observable evaluation-order
 * effect, and the ONLY expression the recogniser admits).
 */
function emitProvenCharReadI32(call: ts.CallExpression, proof: CharReadProof, cx: LowerCtx): IrValueId {
  const receiverExpr = (call.expression as ts.PropertyAccessExpression).expression;
  const indexExpr = call.arguments[0]!;
  if (proof.hoist) {
    const flat = cx.builder.emitSlotReadAs(proof.hoist.flatSlot, { kind: "string" });
    const index = lowerCharReadIndexI32(indexExpr, cx);
    const read = cx.builder.emitCall(irIntrinsicFuncRef(proof.hoist.readFuncName), [flat, index], IR_I32);
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    if (read === null) throw new Error(`ir/from-ast: hoisted char read produced void (${cx.funcName})`);
    return read;
  }
  const recv = lowerExpr(receiverExpr, cx, { kind: "string" });
  const index = lowerCharReadIndexI32(indexExpr, cx);
  const read = cx.builder.emitCall(irIntrinsicFuncRef(proof.trustedFuncName!), [recv, index], IR_I32);
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (read === null) throw new Error(`ir/from-ast: trusted char read produced void (${cx.funcName})`);
  return read;
}

/**
 * (#3931) The preheader half: recognise the canonical char-read loop and, if
 * the backend offers a plan, emit the loop-invariant hoist ONCE before the
 * loop and return the proof to install on the body cx.
 *
 * MUST be called while the builder's current buffer is the OUTER one (after
 * the `for` init is lowered, before the cond/body buffers are collected), so
 * the flatten + descriptor reads run exactly once per loop entry — the same
 * placement contract legacy's `detectCanonicalCharReadLoop` documents.
 *
 * Returns `null` (having emitted nothing) on any deviation: an unrecognised
 * shape, no oracle to prove the receiver is a string, or a backend with no
 * plan. Refuse-loud, never miscompile.
 */
function installCanonicalCharReadProof(stmt: ts.ForStatement, cx: LowerCtx): CharReadProof | null {
  const plan = cx.resolver?.charReadPlan?.() ?? null;
  if (!plan) return null;
  const oracle = cx.oracle;
  if (!oracle) return null;
  const shape = detectCanonicalCharReadLoopShape(stmt, (id) => oracle.typeFactOf(id).kind === "string");
  if (!shape) return null;

  if (!plan.hoist) {
    if (!plan.trustedFuncName) return null;
    return {
      recvName: shape.recvName,
      indexName: shape.indexName,
      hoist: null,
      trustedFuncName: plan.trustedFuncName,
      // (#4517) Host strings keep the generic condition: their `.length` is an
      // engine call, so hoisting it is a different (larger) change than the
      // native-lane fix this issue measures. Narrowest site.
      lenSlot: null,
    };
  }

  const hoist = plan.hoist;
  // The carrier ValType for the slot, exactly as `lowerForOfString` gets it.
  const carrier = cx.resolver?.resolveString?.();
  if (!carrier || carrier.kind !== "ref") return null;
  const recv = lowerExpr(shape.recvIdent, cx, { kind: "string" });
  if (cx.builder.typeOf(recv).kind !== "string") return null;
  // Result typed `IrType.string`, NOT a raw `ref $NativeString`: a flat string
  // IS a string carrier value, and a raw-ref-typed IR value would fail the
  // prepared-component ABI gate and demote the whole function.
  const flat = cx.builder.emitCall(irIntrinsicFuncRef(hoist.flattenFuncName), [recv], { kind: "string" });
  if (flat === null) return null;
  // A slot (not an SSA value) because it is read from INSIDE the loop body's
  // own instruction buffer — the same reason `lowerForOfString` parks its
  // receiver in one. Named after legacy's hoist locals.
  const flatSlot = cx.builder.declareSlot("__cca_flat", carrier);
  cx.builder.emitSlotWrite(flatSlot, flat);

  // (#4517) Second preheader hoist: `recv.length` as an i32 slot, so the loop
  // CONDITION can be a bare `i32.lt_s` instead of the generic relational's
  // `f64.lt(f64.convert_i32_s(i), f64.convert_i32_s(len))`. Cranelift does no
  // LICM and no strength reduction, so on wasmtime/x64 that f64 round-trip is
  // executed literally every iteration of a ~10-instruction loop — measured at
  // 5.4x on the landing `string-hash warm` lane (#4557 → #4517). V8 folds it
  // away, which is why the same artifact looked faster everywhere testable.
  //
  // Soundness is the SAME invariance assumption that already licenses the
  // flatten above: the recogniser pins `recv` for the loop's whole extent (no
  // assignment, no shadowing, no capturing nested function), so `recv.length`
  // is loop-invariant. String lengths are u31, so the f64 the length intrinsic
  // hands back converts exactly — the compare answers identically.
  //
  // `.data` / `.off` are deliberately NOT hoisted: they are raw backend refs,
  // and an IR value typed with one fails the prepared-component ABI gate and
  // demotes the whole function (the #3931 constraint documented in
  // `codegen/char-code-at-helpers.ts`). Making those fields immutable so
  // wasm-opt can hoist the `struct.get`s itself is the follow-up.
  const lenSlot = hoistCharReadLengthI32(shape.recvIdent, recv, cx);
  return {
    recvName: shape.recvName,
    indexName: shape.indexName,
    hoist: { flatSlot, readFuncName: hoist.readFuncName },
    trustedFuncName: null,
    lenSlot,
  };
}

/**
 * (#4517) Park `recv.length` in a preheader i32 slot, or return `null` if the
 * length is not obtainable as an i32 here. Refuse-loud: a `null` result leaves
 * the caller's condition lowering completely untouched rather than emitting a
 * half-applied one.
 */
function hoistCharReadLengthI32(recvIdent: ts.Identifier, recv: IrValueId, cx: LowerCtx): number | null {
  const rawLen = cx.builder.emitStringLen(recv, inferStringEncoding(recvIdent, cx));
  const lenKind = asVal(cx.builder.typeOf(rawLen))?.kind;
  // The length intrinsic is f64-typed on every current carrier; convert ONCE,
  // in the preheader (exact — a string length is a u31).
  const lenI32 =
    lenKind === "i32" ? rawLen : lenKind === "f64" ? cx.builder.emitUnary("i32.trunc_sat_f64_s", rawLen, IR_I32) : null;
  if (lenI32 === null) return null;
  const lenSlot = cx.builder.declareSlot("__cca_len", { kind: "i32" });
  cx.builder.emitSlotWrite(lenSlot, lenI32);
  return lenSlot;
}

/**
 * (#4517) The proven induction variable as a bare i32, WITHOUT the fallback
 * `lowerCharReadIndexI32` carries: the condition rewrite is only worth doing
 * when `i` already lives in an i32 slot, which is exactly when the recogniser
 * matched (`detectI32LoopVar`). Anything else returns `null` and the caller
 * keeps the generic condition.
 */
function provenIndexSlotReadI32(indexName: string, cx: LowerCtx): IrValueId | null {
  const binding = cx.scope.get(indexName);
  if (binding === undefined || binding.kind !== "slot" || binding.i32Storage !== true) return null;
  return cx.builder.emitSlotRead(binding.slotIndex);
}

function lowerForStatement(stmt: ts.ForStatement, cx: LowerCtx, bodyOverride?: (bodyCx: LowerCtx) => void): void {
  // #2952 slice 3 — adopt a labeled statement's pre-allocated id when set
  // (consumed here; cleared so init/body contexts don't leak it inward).
  const loopLabel = cx.pendingLoopLabel ?? cx.builder.freshLoopLabel();
  const innerCx: LowerCtx = { ...cx, scope: new Map(cx.scope), pendingLoopLabel: undefined };

  // 1. Init — emit inline before the for.loop instr.
  if (stmt.initializer) {
    if (ts.isVariableDeclarationList(stmt.initializer)) {
      // Synthesize a VariableStatement so we can re-use lowerVarDecl.
      // The flags carry let/const-ness (already validated by the selector).
      const synthStmt = ts.factory.createVariableStatement(undefined, stmt.initializer);
      lowerVarDecl(synthStmt, innerCx);
    } else {
      // Expression init — lower as a value, drop the result.
      void lowerExpr(stmt.initializer, innerCx, irVal({ kind: "f64" }));
    }
  }

  const loopCx: LowerCtx = { ...innerCx, scope: conservativeLoopStringEncodingScope(stmt, innerCx) };

  // (#3931) 1b. The #2682 canonical char-read hoist. Emitted HERE — after the
  // init, before any buffer is collected — so the loop-invariant flatten +
  // `.data`/`.off` descriptor reads land in the preheader and run once. The
  // proof is threaded onto the body cx below (never onto cond/update: the
  // condition is where `i < recv.length` is ESTABLISHED, and the update runs
  // after the body, where `i` may already be out of range).
  const charReadProof = installCanonicalCharReadProof(stmt, loopCx);

  // 2. Cond — collect its IR into a buffer.
  // Capture the value id `lowerExpr` returns rather than the buffer's last
  // instruction result (fragile — see #1980).
  let condResult: IrValueId | null = null;
  const condInstrs = loopCx.builder.collectBodyInstrs(() => {
    // (#3583) An omitted condition is `true` per the spec. Emit the constant
    // directly rather than synthesizing a `ts.factory.createTrue()` node: a
    // parentless synthetic node has no checker identity, and every downstream
    // helper here (`coerceLoopCondToBool`, string-encoding scoping) is
    // AST-position-sensitive. This is byte-identical to the already-claimed
    // `for (; true; )` form, whose `TrueKeyword` arm emits the same const.
    const cond = stmt.condition;
    if (!cond) {
      condResult = loopCx.builder.emitConst({ kind: "bool", value: true }, irVal({ kind: "i32" }));
      return;
    }
    // (#4517) The recognised char-read loop's condition is `i < recv.length`
    // BY SHAPE (the recogniser rejects anything else), and both operands are
    // already i32 — `i` in its i32 slot, `recv.length` in the preheader slot
    // hoisted above. Emit the native compare instead of routing through the
    // generic relational, which promotes both sides to f64. `i32.lt_s` and
    // `f64.lt` agree bit-for-bit here: `i` is a non-negative i32 counter and a
    // string length is a u31, so neither operand can reach the range where the
    // two disagree. If either piece is missing, fall through to the generic
    // lowering unchanged — never a half-applied condition.
    const provenIndex =
      charReadProof && charReadProof.lenSlot !== null ? provenIndexSlotReadI32(charReadProof.indexName, loopCx) : null;
    if (charReadProof && charReadProof.lenSlot !== null && provenIndex !== null) {
      condResult = loopCx.builder.emitBinary(
        "i32.lt_s",
        provenIndex,
        loopCx.builder.emitSlotRead(charReadProof.lenSlot),
        IR_BOOL,
      );
      return;
    }
    const raw = lowerExpr(cond, loopCx, irVal({ kind: "i32" }));
    // #2136 — coerce a numeric-truthiness `for` cond (e.g. `for (...; k; ...)`
    // with f64 `k`) to an i32 bool via ToBoolean inside the cond buffer,
    // instead of bailing to legacy (#1980). Mirrors the while-loop arm.
    condResult = coerceLoopCondToBool(raw, cond, loopCx, "for");
  });
  if (condResult === null || condResult === undefined) {
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error(`ir/from-ast: for cond produced no SSA value (${cx.funcName})`);
  }

  // 3. Body — collect into a buffer.
  // (#2766) Counted-loop in-bounds proof (port of legacy `safeIndexedArrays`):
  // when this `for` is provably `for (let i = <k≥0>; i < arr.length; i++/+=k>0)`
  // and the body never mutates `i` / `arr` / `arr.length` and has no nested
  // function, every `arr[i]` in the body is provably `0 <= i < arr.length`, so it
  // keeps the fast unchecked `vec.get`. Thread the proven pair onto a body-scoped
  // cx (immutable copy → no leak to siblings; nested loops accumulate outward).
  const provenPair = detectCountedLoopSafeIndex(stmt);
  const fixedLiteralPairs = detectFixedLiteralLoopSafeIndexes(stmt, loopCx.checker);
  const denseFill = denseFillPlanForLoop(stmt);
  const denseFillPair = denseFill ? `${denseFill.arrayName}:${denseFill.indexName}` : null;
  // #2952 slice 2 — the loop's label; the body cx carries it as the
  // innermost break/continue target (a continue jumps to the update).
  const bodyScope = new Map(loopCx.scope);
  const safePairs =
    provenPair || denseFillPair || fixedLiteralPairs.length > 0
      ? new Set([
          ...(loopCx.safeIndexedArrays ?? []),
          ...(provenPair ? [provenPair] : []),
          ...(denseFillPair ? [denseFillPair] : []),
          ...fixedLiteralPairs,
        ])
      : null;
  // (#3931) Nested loops accumulate outward, exactly like `safeIndexedArrays`:
  // an inner loop over a DIFFERENT receiver keeps the outer receiver's proof
  // live (the outer `i` is still in range inside the inner body), while a
  // same-name receiver is shadowed by the inner (fresher) proof.
  const provenCharReads: ProvenCharReads | undefined = charReadProof
    ? new Map([...(loopCx.provenCharReads ?? new Map()), [charReadProof.recvName, charReadProof]])
    : loopCx.provenCharReads;
  const bodyCx: LowerCtx = safePairs
    ? {
        ...loopCx,
        scope: bodyScope,
        safeIndexedArrays: safePairs,
        provenCharReads,
        loopLabel,
        breakTargetLabel: loopLabel,
      }
    : { ...loopCx, scope: bodyScope, provenCharReads, loopLabel, breakTargetLabel: loopLabel };
  const bodyInstrs = loopCx.builder.collectBodyInstrs(() => {
    if (bodyOverride) bodyOverride(bodyCx);
    else lowerStmt(stmt.statement, bodyCx);
  });

  // 4. Update — collect into a buffer (or empty if absent).
  const updateInstrs: IrInstr[] = stmt.incrementor
    ? loopCx.builder.collectBodyInstrs(() => {
        lowerForUpdateExpr(stmt.incrementor!, { ...loopCx, scope: new Map(bodyCx.scope) });
      })
    : [];

  // (#3786) Reduction unroll: an i32-wrapping accumulator loop is latency-bound
  // on its accumulator chain, so splitting it across k independent partial sums
  // is worth ~2.3x. Attempted only on the fully-collected buffers (where every
  // value is already typed i32) and fails closed on any shape it does not match
  // exactly, in which case the loop lowers unchanged below.
  const counterEntry = literalCounterEntry(stmt, innerCx);
  if (
    tryEmitUnrolledReduction({
      builder: loopCx.builder,
      cond: condInstrs,
      condValue: condResult,
      body: bodyInstrs,
      update: updateInstrs,
      counterEntry,
    })
  ) {
    joinScopeStringEncodingFacts(cx.scope, [loopCx.scope]);
    return;
  }

  loopCx.builder.emitForLoop({
    cond: condInstrs,
    condValue: condResult,
    body: bodyInstrs,
    update: updateInstrs,
    loopLabel,
  });
  joinScopeStringEncodingFacts(cx.scope, [loopCx.scope]);
}

/**
 * Slice 12 (#1280): lower the update clause of a `for` loop. Mirrors
 * the body-statement dispatcher's expression-statement branch (postfix
 * `i++` / `i--`, prefix, plain assignment, compound assignment) but
 * drops the result.
 */
function lowerForUpdateExpr(expr: ts.Expression, cx: LowerCtx): void {
  if (ts.isPostfixUnaryExpression(expr) || ts.isPrefixUnaryExpression(expr)) {
    const op = expr.operator;
    if ((op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) && ts.isIdentifier(expr.operand)) {
      lowerIncrementDecrement(expr.operand, op, cx);
      return;
    }
  }
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.EqualsToken && ts.isIdentifier(expr.left)) {
      lowerIdentifierAssignment(expr.left, expr.right, cx);
      return;
    }
    if (
      (op === ts.SyntaxKind.PlusEqualsToken ||
        op === ts.SyntaxKind.MinusEqualsToken ||
        op === ts.SyntaxKind.AsteriskEqualsToken ||
        op === ts.SyntaxKind.SlashEqualsToken) &&
      ts.isIdentifier(expr.left)
    ) {
      lowerCompoundAssignment(expr.left, op, expr.right, cx);
      return;
    }
  }
  // Fallback: lower as an expression and drop the result.
  void lowerExpr(expr, cx, irVal({ kind: "f64" }));
}

/**
 * Slice 6 part 3 (#1182) iter-host emit helper, factored out of
 * `lowerForOfStatement` so the string-arm host-strings fall-through can
 * reuse it. `alreadyExternref` skips the `extern.convert_any` coercion
 * when the input value is already externref-typed at the Wasm level
 * (true for `(val) externref` and for `IrType.string` in host mode).
 */
function lowerForOfIterFromExternrefValue(
  stmt: ts.ForOfStatement,
  cx: LowerCtx,
  iterableV: IrValueId,
  loopVarName: string,
  alreadyExternref: boolean,
): void {
  let iterableExt = iterableV;
  if (!alreadyExternref) {
    iterableExt = cx.builder.emitCoerceToExternref(iterableV);
  }

  const iterSlot = cx.builder.declareSlot("__forof_iter", { kind: "externref" });
  const resultSlot = cx.builder.declareSlot("__forof_result", { kind: "externref" });
  const elementSlot = cx.builder.declareSlot("__forof_elem", { kind: "externref" });

  const elemIrT: IrType = irVal({ kind: "externref" });
  const loopScope = conservativeLoopStringEncodingScope(stmt, cx);
  const bodyScope = new Map(loopScope);
  bodyScope.set(loopVarName, { kind: "slot", slotIndex: elementSlot, type: elemIrT });
  // #2952 slice 2 — this loop is the innermost break/continue target.
  // (#2856) …and an early-return BARRIER (iter cleanup / conservative).
  // (slice 3) A labeled for-of adopts the pre-allocated id.
  const loopLabel = cx.pendingLoopLabel ?? cx.builder.freshLoopLabel();
  const bodyCx: LowerCtx = {
    ...cx,
    scope: bodyScope,
    loopLabel,
    breakTargetLabel: loopLabel,
    noEarlyReturn: true,
    pendingLoopLabel: undefined,
  };

  const body = cx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.statement, bodyCx);
  });

  cx.builder.emitForOfIter({
    iterable: iterableExt,
    iterSlot,
    resultSlot,
    elementSlot,
    body,
    loopLabel,
  });
  joinScopeStringEncodingFacts(cx.scope, [loopScope]);
}

/**
 * Slice 6 part 4 (#1183) — native-strings string for-of. Iterates code
 * units via `__str_charAt(str, i)`. The element IR type is `string`
 * (single-char string ref); body code can compose with slice-1 string
 * ops. The slot ValType is `(ref $AnyString)`, supplied by
 * `nativeStringRefValType` (the lowering-time resolver shape — we
 * synthesize the same shape here so from-ast doesn't need a resolver
 * thread-through). The lowerer cross-checks the slot type against
 * `resolver.resolveString()` at emit time.
 */
function lowerForOfString(stmt: ts.ForOfStatement, cx: LowerCtx, strV: IrValueId, loopVarName: string): void {
  // Native-strings mode requires the resolver's `resolveString()` to
  // produce a `(ref $AnyString)` ValType. If the resolver is absent,
  // the function falls back to legacy via the throw — same outcome
  // as before #1185, just wired through one indirection.
  const strRef = cx.resolver?.resolveString?.();
  if (!strRef || strRef.kind !== "ref") {
    demoteToLegacy(
      "array-representation-unsupported",
      `ir/from-ast: native-strings for-of needs resolver.resolveString() (${cx.funcName})`,
    );
  }

  const counterSlot = cx.builder.declareSlot("__forof_si", { kind: "i32" });
  const lengthSlot = cx.builder.declareSlot("__forof_slen", { kind: "i32" });
  const strSlot = cx.builder.declareSlot("__forof_str", strRef);
  const elementSlot = cx.builder.declareSlot("__forof_selem", strRef);

  // The loop variable is bound as a slot of `(ref $AnyString)`. In
  // native-strings mode the `IrType.string` lowering also produces
  // `(ref $AnyString)`, so as a Wasm value the slot read result and a
  // string-typed SSA value are interchangeable.
  //
  // Slice 6 part 4 refactor (#1185): we tag the binding with
  // `asType: IrType.string` so identifier reads of the loop var
  // produce SSA values typed `IrType.string` rather than
  // `irVal((ref $AnyString))`. This lets body code compose with
  // slice-1 string ops (`c + "world"`, `c.length`, etc.). The
  // underlying Wasm op is unchanged — `slot.read` against the
  // externref-or-ref slot — only the SSA type tag is rewritten.
  const elemIrT: IrType = irVal(strRef);
  const loopScope = conservativeLoopStringEncodingScope(stmt, cx);
  const bodyScope = new Map(loopScope);
  bodyScope.set(loopVarName, {
    kind: "slot",
    slotIndex: elementSlot,
    type: elemIrT,
    asType: { kind: "string" },
  });
  // #2952 slice 2 — this loop is the innermost break/continue target.
  // (#2856) …and an early-return BARRIER (iter cleanup / conservative).
  // (slice 3) A labeled for-of adopts the pre-allocated id.
  const loopLabel = cx.pendingLoopLabel ?? cx.builder.freshLoopLabel();
  const bodyCx: LowerCtx = {
    ...cx,
    scope: bodyScope,
    loopLabel,
    breakTargetLabel: loopLabel,
    noEarlyReturn: true,
    pendingLoopLabel: undefined,
  };

  const body = cx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.statement, bodyCx);
  });

  cx.builder.emitForOfString({
    str: strV,
    counterSlot,
    lengthSlot,
    strSlot,
    elementSlot,
    body,
    loopLabel,
  });
  joinScopeStringEncodingFacts(cx.scope, [loopScope]);
}

/**
 * Slice 6 part 2 (#1181) vec fast-path — extracted into a helper so
 * `lowerForOfStatement` can dispatch between vec and iter-host arms.
 */
function lowerForOfVec(
  stmt: ts.ForOfStatement,
  cx: LowerCtx,
  iterableV: IrValueId,
  iterableType: IrType,
  loopVarName: string,
): void {
  // Slice 6 part 4 refactor (#1185): ask the resolver for the vec
  // shape rather than hard-coding `f64` element / `vecTypeIdx - 1`
  // data-array assumptions. The resolver inspects the actual
  // registered struct fields and returns the correct element
  // ValType + array typeIdx; we synthesize the data-field ValType
  // (a non-null ref to the array type) from the latter.
  //
  // Fall back to the legacy heuristic only if the resolver is
  // absent (older callers / tests) — same behavior as before #1185.
  let elemValType: ValType | null = null;
  let dataValType: ValType | null = null;
  const resolvedVec = resolveIrVecType(iterableType, cx);
  const valTy = resolvedVec?.valueType ?? asVal(iterableType);
  if (resolvedVec) {
    elemValType = resolvedVec.lowering.elementValType;
    dataValType = { kind: "ref", typeIdx: resolvedVec.lowering.arrayTypeIdx };
  } else {
    if (!valTy) {
      demoteToLegacy(
        "array-representation-unsupported",
        `ir/from-ast: for-of iterable has no backend vec carrier in ${cx.funcName}`,
      );
    }
    elemValType = inferVecElementValTypeFromContext(valTy, cx);
    dataValType = inferVecDataValTypeFromContext(valTy, cx);
  }
  if (!elemValType) {
    demoteToLegacy(
      "array-representation-unsupported",
      `ir/from-ast: for-of iterable's IR type is not a recognisable vec in ${cx.funcName}`,
    );
  }
  const elemIrT = irVal(elemValType);

  if (!dataValType) {
    demoteToLegacy(
      "array-representation-unsupported",
      `ir/from-ast: for-of vec has unexpected data field shape (${cx.funcName})`,
    );
  }
  if (!valTy) {
    demoteToLegacy(
      "array-representation-unsupported",
      `ir/from-ast: for-of vec has no backend value carrier (${cx.funcName})`,
    );
  }
  const counterSlot = cx.builder.declareSlot("__forof_i", { kind: "i32" });
  const lengthSlot = cx.builder.declareSlot("__forof_len", { kind: "i32" });
  const vecSlot = cx.builder.declareSlot("__forof_vec", valTy);
  const dataSlot = cx.builder.declareSlot("__forof_data", dataValType);
  const elementSlot = cx.builder.declareSlot("__forof_elem", elemValType);

  const loopScope = conservativeLoopStringEncodingScope(stmt, cx);
  const bodyScope = new Map(loopScope);
  bodyScope.set(loopVarName, { kind: "slot", slotIndex: elementSlot, type: elemIrT });
  // #2952 slice 2 — this loop is the innermost break/continue target.
  // (#2856) …and an early-return BARRIER (iter cleanup / conservative).
  // (slice 3) A labeled for-of adopts the pre-allocated id.
  const loopLabel = cx.pendingLoopLabel ?? cx.builder.freshLoopLabel();
  const bodyCx: LowerCtx = {
    ...cx,
    scope: bodyScope,
    loopLabel,
    breakTargetLabel: loopLabel,
    noEarlyReturn: true,
    pendingLoopLabel: undefined,
  };

  const body = cx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.statement, bodyCx);
  });

  cx.builder.emitForOfVec({
    vec: iterableV,
    elementType: elemIrT,
    counterSlot,
    lengthSlot,
    vecSlot,
    dataSlot,
    elementSlot,
    body,
    loopLabel,
  });
  joinScopeStringEncodingFacts(cx.scope, [loopScope]);
}

/**
 * Recover the element ValType of a vec from its `(ref|ref_null) $vec_*`
 * ValType by walking the legacy type registry (same lookup the
 * resolver's `resolveVec` performs at lowering time, but inlined here
 * because the from-ast layer doesn't have direct access to the
 * resolver). Returns `null` if the struct shape isn't recognisable as
 * a vec.
 *
 * The IR builder doesn't have access to `ctx.mod.types` directly —
 * we'd need to thread the resolver through `LowerCtx` for that. For
 * slice-6 part 2 we reuse the typeOf+structInspect mechanism the
 * resolver itself uses, but inline. Future cleanup can hoist this
 * into the resolver and pass it through `LowerCtx`.
 */
function inferVecElementValTypeFromContext(_valTy: ValType, _cx: LowerCtx): ValType | null {
  // Slice 6 part 2 deferred design: the legacy vec IS always shaped as
  // `{ length: i32, data: (ref $arr_<elem>) }` for f64-element vecs
  // (the only variety the IR-claimable Array<number> path produces in
  // slice 6). The lowerer's resolveVec verifies the shape; from-ast
  // just needs the element ValType to size the element slot. For
  // slice-6's narrow vec scope we hardcode `f64` — the resolver will
  // throw at lowering time if the actual struct shape differs.
  //
  // A cleaner design (deferred to a follow-up) threads the resolver
  // through `LowerCtx` so this function can call `resolveVec(valTy)`
  // and read `elementValType` off the result. The current shape works
  // for the slice-6 vec test cases and matches the spec's deferred-
  // design stance.
  return { kind: "f64" };
}

/**
 * Recover the vec's data-array ValType (the `data` field type, a
 * non-null `(ref $arr_<elem>)`). Same caveats as
 * `inferVecElementValTypeFromContext` — slice-6 hardcodes the
 * data-field as `(ref $arr_f64)` since that's what the legacy
 * `getOrRegisterVecType("f64", ...)` produces and matches every
 * IR-claimable Array<number> param.
 */
function inferVecDataValTypeFromContext(valTy: ValType, _cx: LowerCtx): ValType | null {
  // The data-array typeIdx for a vec at typeIdx N is N - 1 in the
  // legacy registry (the array type is registered first, then the
  // wrapping vec struct). This is brittle but matches the layout the
  // legacy `getOrRegisterArrayType` + `getOrRegisterVecType` produce.
  // Revisit when threading the resolver through LowerCtx (see the
  // note on `inferVecElementValTypeFromContext`).
  if (valTy.kind !== "ref" && valTy.kind !== "ref_null") return null;
  const vecTypeIdx = (valTy as { typeIdx: number }).typeIdx;
  // Default: data is always at vecTypeIdx - 1 in the legacy layout.
  return { kind: "ref", typeIdx: vecTypeIdx - 1 };
}

/**
 * Slice 6 part 2 (#1181): body-statement dispatcher. Mirrors the
 * `isPhase1BodyStatement` selector arm in `src/ir/select.ts` —
 * accepts Block (recurses), VariableStatement, identifier-LHS /
 * property-LHS / compound-assignment ExpressionStatements, bare
 * CallExpression, and nested ForOfStatement.
 *
 * No fall-through if/else, no nested closures, no early-return —
 * those are statement-list / tail-context features that don't make
 * sense inside a non-terminating loop body.
 */
function lowerStmt(stmt: ts.Statement, cx: LowerCtx): void {
  if (ts.isBlock(stmt)) {
    const childCx: LowerCtx = { ...cx, scope: new Map(cx.scope) };
    for (const s of stmt.statements) {
      lowerStmt(s, childCx);
      // #2952 slice 2 — a break/continue terminates its buffer (the
      // verifier requires br.label to be last); statements after it are
      // dead code — skip them rather than emit unreachable instrs.
      if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) break;
    }
    joinScopeStringEncodingFacts(cx.scope, [childCx.scope]);
    return;
  }
  if (ts.isVariableStatement(stmt)) {
    lowerVarDecl(stmt, cx);
    return;
  }
  if (ts.isExpressionStatement(stmt)) {
    if (ts.isCallExpression(stmt.expression)) {
      lowerDiscardedExpression(stmt.expression, cx);
      return;
    }
    // Slice 7a (#1169f): `yield <expr>;` inside a for-of body. The
    // selector accepts this shape; the lowerer enforces the enclosing
    // function is a generator via `lowerYield`.
    if (ts.isYieldExpression(stmt.expression)) {
      lowerYield(stmt.expression, cx);
      return;
    }
    if (ts.isBinaryExpression(stmt.expression)) {
      const op = stmt.expression.operatorToken.kind;
      // Plain assignment `<id> = <expr>` — id MUST resolve to a `slot`
      // binding (mutation pre-pass should have detected it). For
      // property assignment, dispatch to `lowerPropertyAssignment`
      // (the slice-4 helper).
      if (op === ts.SyntaxKind.EqualsToken) {
        if (ts.isIdentifier(stmt.expression.left)) {
          lowerIdentifierAssignment(stmt.expression.left, stmt.expression.right, cx);
          return;
        }
        if (ts.isPropertyAccessExpression(stmt.expression.left)) {
          lowerPropertyAssignment(stmt.expression, cx);
          return;
        }
        // (#2856 C2) element store `arr[i] = v;` in a body buffer.
        if (ts.isElementAccessExpression(stmt.expression.left)) {
          lowerElementStore(stmt.expression.left, stmt.expression.right, cx);
          return;
        }
      }
      // Compound assignment `<id> <op>= <expr>` — desugar to
      // `<id> = <id> <binop> <expr>`. The binop maps from the
      // compound-assignment token kind. This keeps the lowering
      // straightforward; the optimizer can fold redundant reads later.
      if (
        op === ts.SyntaxKind.PlusEqualsToken ||
        op === ts.SyntaxKind.MinusEqualsToken ||
        op === ts.SyntaxKind.AsteriskEqualsToken ||
        op === ts.SyntaxKind.SlashEqualsToken
      ) {
        if (ts.isIdentifier(stmt.expression.left)) {
          lowerCompoundAssignment(stmt.expression.left, op, stmt.expression.right, cx);
          return;
        }
      }
    }
    // Slice 12 (#1280): postfix `i++` / `i--` and prefix `++i` / `--i`
    // as expression statements. Desugar to compound assignment by
    // synthesizing a `PlusEquals`/`MinusEquals` lowering against
    // an i32(1)/f64(1) literal — the value semantics for use as an
    // expression-statement match: the RHS is read, modified, written
    // back, the result is dropped.
    if (ts.isPostfixUnaryExpression(stmt.expression) || ts.isPrefixUnaryExpression(stmt.expression)) {
      const op = stmt.expression.operator;
      if (
        (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) &&
        ts.isIdentifier(stmt.expression.operand)
      ) {
        lowerIncrementDecrement(stmt.expression.operand, op, cx);
        return;
      }
    }
    // (#4459) Value-discarding statement inside a body buffer — the same
    // `lowerDiscardedExpression` the top-level walker uses. A discarded
    // ternary collects one buffer per arm and emits `if.stmt` (#2952
    // slice 2), which nests correctly inside loop / try / switch bodies.
    if (!expressionStatementMutatesAtTopLevel(stmt.expression)) {
      lowerDiscardedExpression(stmt.expression, cx);
      return;
    }
    demoteToLegacy("body-shape-rejected", `ir/from-ast: unsupported body ExpressionStatement shape in ${cx.funcName}`);
  }
  if (ts.isWithStatement(stmt)) {
    lowerWithStatement(stmt, cx);
    return;
  }
  if (ts.isForOfStatement(stmt)) {
    lowerForOfStatement(stmt, cx);
    return;
  }
  if (ts.isForInStatement(stmt)) {
    lowerForInStatement(stmt, cx);
    return;
  }
  // Slice 12 (#1280): nested while / for loops inside a body buffer.
  if (ts.isWhileStatement(stmt)) {
    lowerWhileStatement(stmt, cx);
    return;
  }
  if (ts.isForStatement(stmt)) {
    lowerForStatement(stmt, cx);
    return;
  }
  // #2952 slice 1: nested `do { body } while (cond)` inside a body buffer.
  if (ts.isDoStatement(stmt)) {
    lowerDoStatement(stmt, cx);
    return;
  }
  // Slice 9 (#1169h) — throw / try inside a body-statement context.
  if (ts.isThrowStatement(stmt)) {
    lowerThrowStatement(stmt, cx);
    return;
  }
  if (ts.isTryStatement(stmt)) {
    lowerTryStatement(stmt, cx);
    return;
  }
  // #2952 slice 2 — statement-level if inside a body buffer.
  if (ts.isIfStatement(stmt)) {
    lowerIfBodyStatement(stmt, cx);
    return;
  }
  // #2952 slice 2 — unlabeled break / continue against the innermost loop.
  // (slice 3) Labeled forms resolve through cx.labelEnv in the same helper.
  if (ts.isBreakStatement(stmt) || ts.isContinueStatement(stmt)) {
    lowerBreakContinueStatement(stmt, cx);
    return;
  }
  // #2952 slice 3 — `lbl: <loop>` nested inside a body buffer.
  if (ts.isLabeledStatement(stmt)) {
    lowerLabeledStatement(stmt, cx);
    return;
  }
  // #2952 slice 4 — switch nested inside a body buffer.
  if (ts.isSwitchStatement(stmt)) {
    lowerSwitchStatement(stmt, cx);
    return;
  }
  // (#2856 C1) Early `return` inside a body buffer — `if (v === target)
  // return mid;` inside a while loop. Lowers to the Wasm `return` op via
  // the `early.return` instr. Guarded against contexts where that is
  // unsound (generators, try/finally, iterator-protocol for-of) — the
  // selector mirrors these guards so accepted shapes always lower.
  if (ts.isReturnStatement(stmt)) {
    lowerEarlyReturn(stmt, cx);
    return;
  }
  demoteToLegacy(
    "body-shape-rejected",
    `ir/from-ast: unsupported body statement ${ts.SyntaxKind[stmt.kind]} in ${cx.funcName}`,
  );
}

/**
 * #4206 first IR slice: a closed inline object literal plus an ordinary
 * synchronous function expression. Each literal field becomes a `withField`
 * scope binding backed by the one receiver SSA value. A closure captures that
 * receiver and rehydrates the field binding in `liftClosureBody`, so reads and
 * writes remain invocation-time object operations after this statement exits.
 */
function lowerWithStatement(stmt: ts.WithStatement, cx: LowerCtx): void {
  if (!ts.isObjectLiteralExpression(stmt.expression) || !ts.isBlock(stmt.statement)) {
    demoteToLegacy(
      "body-shape-rejected",
      `ir/from-ast: with target/body outside the closed-object IR slice (${cx.funcName})`,
    );
  }
  const receiver = lowerObjectLiteral(stmt.expression, cx);
  const receiverType = cx.builder.typeOf(receiver);
  if (receiverType.kind !== "object") {
    // invariant (producer-promise): the lowering just invoked promised this shape — #4502.
    throw new Error(`ir/from-ast: with target did not lower to an object (${cx.funcName})`);
  }

  const bodyCx: LowerCtx = { ...cx, scope: new Map(cx.scope) };
  for (const field of receiverType.shape.fields) {
    bodyCx.scope.set(field.name, {
      kind: "withField",
      receiver,
      name: field.name,
      type: field.type,
    });
  }
  for (const bodyStatement of stmt.statement.statements) lowerStmt(bodyStatement, bodyCx);
}

/**
 * #2952 slice 2 — lower a statement-position `if (cond) then [else]` inside
 * a body buffer to the void `if.stmt` IR instr. Unlike the top-level
 * statement-list `if` (which uses the block-CFG layer), nested buffers have
 * no CFG access, so this stays fully structured: cond is lowered INLINE in
 * the current buffer (evaluated once), each arm is collected into its own
 * sub-buffer with a cloned scope (arm-local `let`s don't leak).
 */
function lowerIfBodyStatement(stmt: ts.IfStatement, cx: LowerCtx): void {
  const raw = lowerExpr(stmt.expression, cx, irVal({ kind: "i32" }));
  // Coerce through the shared ToBoolean path used by loop conditions.
  const cond = coerceLoopCondToBool(raw, stmt.expression, cx, "if");
  const thenCx: LowerCtx = { ...cx, scope: new Map(cx.scope) };
  const thenInstrs = cx.builder.collectBodyInstrs(() => {
    lowerStmt(stmt.thenStatement, thenCx);
  });
  const elseCx: LowerCtx = { ...cx, scope: new Map(cx.scope) };
  const elseInstrs = stmt.elseStatement
    ? cx.builder.collectBodyInstrs(() => {
        lowerStmt(stmt.elseStatement!, elseCx);
      })
    : [];
  cx.builder.emitIfStmt({ cond, then: thenInstrs, else: elseInstrs });
  joinScopeStringEncodingFacts(cx.scope, [thenCx.scope, elseCx.scope]);
}

/**
 * #2952 slice 3 — lower `lbl: <loop>` (a labeled LOOP statement; labeled
 * non-loop statements are selector-rejected — `labeled.block` is banked for
 * the switch slice). The label id is pre-allocated HERE and handed to the
 * loop lowerer via `cx.pendingLoopLabel`, so the loop's own `loopLabel` IS
 * the id that `labelEnv[name]` maps to — `break lbl` / `continue lbl`
 * become plain `br.label{label, mode}` against the loop's existing frames
 * and the lowering-time depth resolver needs no new machinery. Multiple
 * labels on one loop (`a: b: while …`) share a single id by recursion:
 * the inner labeled statement sees `pendingLoopLabel` already set and
 * binds its own name to the same id.
 */
function lowerLabeledStatement(stmt: ts.LabeledStatement, cx: LowerCtx): void {
  const label = cx.pendingLoopLabel ?? cx.builder.freshLoopLabel();
  const labelEnv = new Map(cx.labelEnv ?? []);
  labelEnv.set(stmt.label.text, label);
  const innerCx: LowerCtx = { ...cx, labelEnv, pendingLoopLabel: label };
  const inner = stmt.statement;
  if (ts.isLabeledStatement(inner)) {
    lowerLabeledStatement(inner, innerCx);
    return;
  }
  if (ts.isWhileStatement(inner)) {
    lowerWhileStatement(inner, innerCx);
    return;
  }
  if (ts.isDoStatement(inner)) {
    lowerDoStatement(inner, innerCx);
    return;
  }
  if (ts.isForStatement(inner)) {
    lowerForStatement(inner, innerCx);
    return;
  }
  if (ts.isForOfStatement(inner)) {
    lowerForOfStatement(inner, innerCx);
    return;
  }
  // #2952 slice 6c — labeled for-in. It lowers to `for.loop`, whose
  // `loopLabel` IS the pre-allocated id, so `break lbl` / `continue lbl`
  // resolve through the same slice-2/3 machinery with no new obligation
  // (no iterator ⇒ no IteratorClose to interleave).
  if (ts.isForInStatement(inner)) {
    lowerForInStatement(inner, innerCx);
    return;
  }
  // #2952 slice 4 — `lbl: switch (...)`: the switch adopts the label as
  // its breakLabel (via pendingLoopLabel), so `break lbl` and unlabeled
  // `break` target the same frame.
  if (ts.isSwitchStatement(inner)) {
    lowerSwitchStatement(inner, innerCx);
    return;
  }
  // #2952 slice 4 — any other labeled statement: a break-only
  // `labeled.block` frame around the inner statement's buffer.
  const blockCx: LowerCtx = { ...innerCx, scope: new Map(innerCx.scope), pendingLoopLabel: undefined };
  const body = cx.builder.collectBodyInstrs(() => {
    lowerStmt(inner, blockCx);
  });
  cx.builder.emitLabeledBlock({ label, body });
  joinScopeStringEncodingFacts(cx.scope, [blockCx.scope]);
}

/**
 * #2952 slice 2 — lower an unlabeled `break;` / `continue;` to `br.label`
 * against the innermost enclosing loop's synthesised label (threaded on
 * `cx.loopLabel` by every loop lowerer). The selector's `inLoop` gate
 * guarantees a label is in scope and the statement is unlabeled; the
 * throws are internal-invariant assertions, not fallback paths.
 *
 * (slice 3) The labeled forms resolve the label NAME through
 * `cx.labelEnv` — the id is the labeled loop's own `loopLabel`, so both
 * forms emit the same `br.label` instr. The selector's label-set gate
 * guarantees the name is bound by an enclosing claimed labeled loop.
 */
function lowerBreakContinueStatement(stmt: ts.BreakStatement | ts.ContinueStatement, cx: LowerCtx): void {
  const kind = ts.isBreakStatement(stmt) ? "break" : "continue";
  if (stmt.label) {
    const target = cx.labelEnv?.get(stmt.label.text);
    if (target === undefined) {
      // invariant (producer-promise): the selector's own gate already decided this predicate — #4502.
      throw new Error(
        `ir/from-ast: ${kind} ${stmt.label.text} targets no enclosing claimed labeled statement — selector gate failed (${cx.funcName})`,
      );
    }
    cx.builder.emitBrLabel(target, kind);
    return;
  }
  // (slice 4) Unlabeled break binds the nearest BREAKABLE (loop or
  // switch, §14.9); unlabeled continue binds the nearest LOOP (§14.8).
  const target = kind === "break" ? cx.breakTargetLabel : cx.loopLabel;
  if (target === undefined) {
    // invariant (producer-promise): the selector's own gate already decided this predicate — #4502.
    throw new Error(
      `ir/from-ast: ${kind} outside a claimed ${kind === "break" ? "loop/switch" : "loop"} — selector gate failed (${cx.funcName})`,
    );
  }
  cx.builder.emitBrLabel(target, kind);
}

/**
 * #2952 slice 4 — lower `switch (disc) { case <numeric literal>: ... }` to
 * the `switch` IR instr (block-per-case ladder; see IrInstrSwitch in
 * nodes.ts). The selector admits only numeric-literal case tests, so
 * clause selection is a compile-time table; the disc must lower to
 * i32/f64 (ref/string/dynamic discs throw → clean legacy demote, same
 * discipline as loop conds, #2136).
 *
 * Scope: per §14.12 the whole case block is ONE declaration scope shared
 * across clauses — mirrored by a single `switchCx` scope Map reused for
 * every clause body. Statements after a `break`/`continue` in a clause
 * are dead and skipped (verifier requires br.label last-in-buffer).
 */
function lowerSwitchStatement(stmt: ts.SwitchStatement, cx: LowerCtx): void {
  const clauses = stmt.caseBlock.clauses;
  const stringTestTexts = clauses.map((clause) =>
    ts.isCaseClause(clause) ? stringLiteralCaseTestValue(clause.expression) : null,
  );
  const isStringSwitch = stringTestTexts.some((text) => text !== null);

  // #2952 slice 6b — a STRING-tested switch reuses the numeric ladder by
  // computing a dispatch INDEX first: `disc` is compared against each case's
  // literal with the IR's abstract `string.eq`, and the matching clause's
  // index (or -1) becomes the i32 discriminant of the ordinary
  // `IrInstrSwitch`. Deliberately NO new IR node/field (and therefore no
  // exhaustiveness sweep): the ladder, br_table fast path, fallthrough
  // layout, `break` frame and verifier rules all stay exactly as slice 4
  // shipped them, and preparation still sees the string consts / `string.eq`
  // as ordinary IR instructions, so provider binding needs no special case.
  const dispatch = isStringSwitch ? lowerStringSwitchDispatch(stmt, cx, stringTestTexts) : null;

  const discRaw = dispatch ? dispatch.disc : lowerExpr(stmt.expression, cx, irVal({ kind: "f64" }));
  const discT = asVal(cx.builder.typeOf(discRaw));
  if (!discT || (discT.kind !== "f64" && discT.kind !== "i32")) {
    demoteToLegacy("body-shape-rejected", `ir/from-ast: switch disc must lower to i32/f64 in ${cx.funcName}`);
  }
  const discSlot = cx.builder.declareSlot("__switch_disc", discT);
  // A labeled switch (`lbl: switch (...)`) adopts the pre-allocated label
  // as its break target, so `break lbl` and unlabeled `break` coincide.
  const breakLabel = cx.pendingLoopLabel ?? cx.builder.freshLoopLabel();
  const switchCx: LowerCtx = {
    ...cx,
    scope: new Map(cx.scope),
    breakTargetLabel: breakLabel,
    pendingLoopLabel: undefined,
  };
  const tests: (number | null)[] = [];
  const bodies: (readonly IrInstr[])[] = [];
  for (let k = 0; k < clauses.length; k++) {
    const clause = clauses[k]!;
    if (ts.isCaseClause(clause)) {
      // String switch: the test IS the clause index (the dispatch chain
      // above already resolved the literal comparison). Numeric switch:
      // the literal's value, as slice 4.
      const v = dispatch ? k : numericLiteralValue(clause.expression);
      if (v === null) {
        // invariant (producer-promise): the selector's own gate already decided this predicate — #4502.
        throw new Error(
          `ir/from-ast: switch case test must be a numeric literal — selector gate failed (${cx.funcName})`,
        );
      }
      tests.push(v);
    } else {
      tests.push(null);
    }
    bodies.push(
      cx.builder.collectBodyInstrs(() => {
        for (const s of clause.statements) {
          lowerStmt(s, switchCx);
          if (ts.isBreakStatement(s) || ts.isContinueStatement(s)) break; // dead code after an abrupt exit
        }
      }),
    );
  }
  cx.builder.emitSwitch({ disc: discRaw, discSlot, tests, bodies, breakLabel });
  joinScopeStringEncodingFacts(cx.scope, [switchCx.scope]);
}

/**
 * #2952 slice 6b — compute the dispatch INDEX of a string-tested switch.
 *
 * Emits, into the CURRENT buffer (so no cross-buffer SSA reference is
 * created — nested buffers are self-contained, see the slice-1 note):
 *
 * ```
 *   <disc>                       ;; evaluated exactly ONCE (§14.12.9 step 1)
 *   match := -1
 *   if (string.eq(disc, lit[n-1])) match := n-1     ;; REVERSE source order
 *   …
 *   if (string.eq(disc, lit[0]))   match := 0
 *   → slot.read(match)                              ;; i32 discriminant
 * ```
 *
 * **Why reverse order + unconditional writes rather than a short-circuiting
 * chain.** A short-circuit chain would have to evaluate `disc` inside a
 * NESTED if-buffer, which cannot reference the outer buffer's SSA value; it
 * would need a string-typed slot and therefore a mode-dependent `(ref
 * $AnyString)` / externref slot ValType. Emitting all comparisons flat in one
 * buffer and letting the FIRST clause in source order win by writing LAST is
 * observationally identical: both operands are strings, so `string.eq` is
 * total, pure and cannot throw — evaluating a comparison JS would have
 * skipped is unobservable. First-clause-wins on duplicate literals is
 * preserved. The measured cost is `n` comparisons instead of up to `n`; a
 * short-circuiting variant is a pure optimisation, banked.
 *
 * The `-1` sentinel is out of the `[0, n)` clause-index range, so it falls to
 * the ladder's no-match target — the `default` clause when present, past the
 * ladder otherwise — through the SAME code slice 4 already emits (including
 * `br_table`, whose min-biased index goes out of range for -1).
 */
function lowerStringSwitchDispatch(
  stmt: ts.SwitchStatement,
  cx: LowerCtx,
  stringTestTexts: readonly (string | null)[],
): { readonly disc: IrValueId } {
  const i32 = irVal({ kind: "i32" });
  const discV = lowerExpr(stmt.expression, cx, { kind: "string" });
  const discKind = cx.builder.typeOf(discV).kind;
  if (discKind !== "string") {
    // Selector mirror (`switch-disc-not-string` / `switch-disc-not-string-carrier`).
    // `IrUnsupportedError` — NOT a bare `throw` — because under IR-first
    // (#2138) a bare build throw is an `unexpected-internal-throw` INVARIANT
    // (hard compile error), while a named Unsupported reason demotes cleanly.
    // The selector gates this shape out, so this is a defence-in-depth mirror
    // that should never fire; if it ever does, legacy still compiles the
    // function. Same channel the neighbouring string-operand `===` arm uses.
    throw new IrUnsupportedError(
      "operand-coercion-unsupported",
      "build",
      `ir/from-ast: string-tested switch disc lowered to ${discKind}, not string, in ${cx.funcName}`,
    );
  }
  const matchSlot = cx.builder.declareSlot("__switch_str_match", { kind: "i32" });
  cx.builder.emitSlotWrite(matchSlot, cx.builder.emitConst({ kind: "i32", value: -1 }, i32));
  for (let k = stringTestTexts.length - 1; k >= 0; k--) {
    const text = stringTestTexts[k];
    if (text === null) continue; // default clause — no comparison
    const literal = cx.builder.emitStringConst(text);
    const matched = cx.builder.emitStringEq(discV, literal, false);
    const then = cx.builder.collectBodyInstrs(() => {
      cx.builder.emitSlotWrite(matchSlot, cx.builder.emitConst({ kind: "i32", value: k }, i32));
    });
    cx.builder.emitIfStmt({ cond: matched, then, else: [] });
  }
  return { disc: cx.builder.emitSlotRead(matchSlot) };
}

/**
 * #2952 slice 6b — the text of a string-literal case test. `null` for any
 * other expression shape (numeric literals take the slice-4 path; everything
 * else is selector-rejected).
 */
function stringLiteralCaseTestValue(expr: ts.Expression): string | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text;
  return null;
}

/**
 * #2952 slice 4 — the numeric value of a literal case test: a plain
 * NumericLiteral or a prefix-minus NumericLiteral. `null` for any other
 * expression shape (the selector mirror rejects those).
 */
function numericLiteralValue(expr: ts.Expression): number | null {
  if (ts.isNumericLiteral(expr)) return Number(expr.text.replace(/_/g, ""));
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return -Number(expr.operand.text.replace(/_/g, ""));
  }
  return null;
}

/**
 * (#2856 C1) Lower an early `return [expr]` in body-statement position.
 * Mirrors `lowerTail`'s return handling (void discard, value coercion via
 * `coerceReturnValue`) but emits the `early.return` instr instead of a
 * block terminator — the buffer isn't a block, and the Wasm `return` op
 * unwinds the enclosing loop blocks natively.
 */
function lowerEarlyReturn(stmt: ts.ReturnStatement, cx: LowerCtx): void {
  if (cx.funcKind === "generator") {
    // A generator's `return` routes through __gen_set_return / the buffer
    // epilogue — a plain Wasm return would skip the generator wrap. The
    // selector rejects the shape; this is the defensive mirror.
    demoteToLegacy(
      "return-type-legacy-coupling",
      `ir/from-ast: early return inside a generator not in IR scope (${cx.funcName})`,
    );
  }
  if (cx.noEarlyReturn) {
    // Inside try/catch/finally (would skip inlined finally) or an
    // iterator-protocol for-of body (would skip iter.return cleanup).
    demoteToLegacy(
      "return-type-legacy-coupling",
      `ir/from-ast: early return inside try/for-of-iter not in IR scope (${cx.funcName})`,
    );
  }
  if (cx.returnType === null) {
    if (stmt.expression) {
      lowerDiscardedExpression(stmt.expression, cx);
    }
    cx.builder.emitEarlyReturn(null);
    return;
  }
  if (!stmt.expression) {
    demoteToLegacy(
      "return-type-legacy-coupling",
      `ir/from-ast: early bare return in non-void function in ${cx.funcName}`,
    );
  }
  const v = lowerExpr(stmt.expression, cx, cx.returnType);
  cx.builder.emitEarlyReturn(coerceReturnValue(v, cx, stmt.expression));
}

/**
 * Lower `<id> = <expr>` where `<id>` is a slot-bound identifier.
 * Throws if the binding isn't a slot — mutation of a `local` would
 * silently produce wrong results (the reassignment wouldn't be
 * observable through the existing SSA value), so the mutation
 * pre-pass should have flagged the name.
 */
function lowerIdentifierAssignment(id: ts.Identifier, rhs: ts.Expression, cx: LowerCtx): void {
  const binding = cx.scope.get(id.text);
  if (!binding) {
    const readable = cx.resolver?.resolveModuleBinding?.(id);
    if (readable) {
      requireMatchingModuleBindingOwner(readable, cx.ownerUnitId, cx.funcName);
      const writable = cx.resolver?.resolveModuleBinding?.(id, rhs);
      if (!writable) {
        demoteToLegacy(
          "property-write-unsupported",
          `ir/from-ast: assignment to readonly or representation-incompatible module binding "${id.text}" in ${cx.funcName}`,
        );
      }
      requireMatchingModuleBindingOwner(writable, cx.ownerUnitId, cx.funcName);
      const newValue = lowerExpr(rhs, cx, writable.type);
      const newType = cx.builder.typeOf(newValue);
      if (!moduleStorageCompatible(newType, writable.type)) {
        demoteToLegacy(
          "property-write-unsupported",
          `ir/from-ast: assignment to module binding "${id.text}" (${describeIrType(writable.type)}) got ${describeIrType(newType)} in ${cx.funcName}`,
        );
      }
      lowerResolvedModuleBindingTdzCheck(id.text, writable, cx);
      cx.builder.emitGlobalSet(writable.globalRef, newValue);
      return;
    }
    demoteToLegacy(
      "property-write-unsupported",
      `ir/from-ast: assignment to undeclared identifier "${id.text}" in ${cx.funcName}`,
    );
  }
  // (#3142 Slice 2) Module-scope binding — write the legacy global.
  if (binding.kind === "moduleGlobal") {
    const newValue = lowerExpr(rhs, cx, binding.type);
    const newType = cx.builder.typeOf(newValue);
    if (!moduleStorageCompatible(newType, binding.type)) {
      demoteToLegacy(
        "property-write-unsupported",
        `ir/from-ast: assignment to module binding "${id.text}" (${describeIrType(binding.type)}) got ${describeIrType(newType)} in ${cx.funcName}`,
      );
    }
    cx.builder.emitGlobalSet(binding.globalRef, newValue);
    cx.scope.set(id.text, { ...binding, stringEncoding: inferStringEncoding(rhs, cx) });
    return;
  }
  if (binding.kind === "local" && binding.type.kind === "boxed") {
    const newValue = lowerExpr(rhs, cx, binding.type.inner);
    const newType = cx.builder.typeOf(newValue);
    if (!irTypeAssignable(newType, binding.type.inner)) {
      demoteToLegacy(
        "property-write-unsupported",
        `ir/from-ast: assignment to captured "${id.text}" (${describeIrType(binding.type.inner)}) got ${describeIrType(newType)} in ${cx.funcName}`,
      );
    }
    cx.builder.emitRefCellSet(binding.value, newValue);
    return;
  }
  if (binding.kind === "withField") {
    const newValue = lowerExpr(rhs, cx, binding.type);
    if (!irTypeAssignable(cx.builder.typeOf(newValue), binding.type)) {
      demoteToLegacy(
        "property-write-unsupported",
        `ir/from-ast: assignment to with binding "${id.text}" (${describeIrType(binding.type)}) has incompatible value in ${cx.funcName}`,
      );
    }
    cx.builder.emitObjectSet(binding.receiver, binding.name, newValue);
    return;
  }
  if (binding.kind !== "slot") {
    // invariant (producer-promise): the mutation pre-pass promised a slot binding here — #4502.
    throw new Error(
      `ir/from-ast: assignment to non-slot binding "${id.text}" — mutation pre-pass should have detected it (${cx.funcName})`,
    );
  }
  // (#3741) invariant W — an i32-promoted slot's RHS lowers DIRECTLY to an
  // exact i32; it is never an f64 that we then truncate.
  if (binding.i32Storage) {
    writePromotedI32Slot(binding.slotIndex, rhs, cx, id.text);
    return;
  }
  // Slice 6 part 4 refactor (#1185): when the binding has an asType
  // widening, the IR type the body sees is `asType`, not the
  // underlying slot ValType. Use `asType` for the lowering hint and
  // type check; the slot.write itself accepts any value of the
  // underlying ValType, which `asType` agrees with at the Wasm
  // level (the asType invariant guarantees this).
  const logicalType = binding.asType ?? binding.type;
  let newValue = lowerExpr(rhs, cx, logicalType);
  let newType = cx.builder.typeOf(newValue);
  if (logicalType.kind === "dynamic" && newType.kind !== "dynamic") {
    const boxed = boxConcreteToDynamic(newValue, newType, rhs, cx);
    if (boxed !== null) {
      newValue = boxed;
      newType = cx.builder.typeOf(newValue);
    }
  }
  if (!irTypeAssignable(newType, logicalType)) {
    demoteToLegacy(
      "property-write-unsupported",
      `ir/from-ast: assignment to "${id.text}" (${describeIrType(logicalType)}) got ${describeIrType(newType)} in ${cx.funcName}`,
    );
  }
  cx.builder.emitSlotWrite(binding.slotIndex, newValue);
  cx.scope.set(id.text, { ...binding, stringEncoding: inferStringEncoding(rhs, cx) });
}

/**
 * Lower `<id> <op>= <expr>` by desugaring to `<id> = <id> <binop> <expr>`.
 * The binop is the arithmetic/comparison operator implied by the
 * compound-assignment token (e.g. `+=` → `f64.add` for f64 operands).
 * Only handles f64 operands in slice 6 — i32 (boolean) compound
 * assignment is rare and deferred.
 */
function lowerCompoundAssignment(id: ts.Identifier, compoundOp: ts.SyntaxKind, rhs: ts.Expression, cx: LowerCtx): void {
  const binding = cx.scope.get(id.text);
  if (!binding) {
    demoteToLegacy(
      "compound-assign-unsupported",
      `ir/from-ast: compound assign to undeclared identifier "${id.text}" in ${cx.funcName}`,
    );
  }
  const capturedCell = binding.kind === "local" && binding.type.kind === "boxed" ? binding : undefined;
  if (binding.kind !== "slot" && binding.kind !== "moduleGlobal" && !capturedCell) {
    // invariant (producer-promise): the mutation pre-pass promised a slot binding here — #4502.
    throw new Error(
      `ir/from-ast: compound assign to non-slot binding "${id.text}" — mutation pre-pass should have detected it (${cx.funcName})`,
    );
  }
  const storage = binding.kind === "slot" || binding.kind === "moduleGlobal" ? binding : capturedCell!;
  const capturedCellType = storage.kind === "local" && storage.type.kind === "boxed" ? storage.type : undefined;
  // (#3741) i32-promoted slot — invariant W. `planI32Slots` only admits the
  // compound shapes handled here (bitwise compounds, plus `+=`/`-=` by an
  // integer literal on a `detectI32LoopVar`-proven counter); anything else
  // demotes rather than approximating.
  if (storage.kind === "slot" && storage.i32Storage) {
    lowerPromotedI32CompoundAssignment(id, storage.slotIndex, compoundOp, rhs, cx);
    return;
  }
  const logicalType =
    storage.kind === "slot" ? (storage.asType ?? storage.type) : (capturedCellType?.inner ?? storage.type);
  if (compoundOp === ts.SyntaxKind.PlusEqualsToken && logicalType.kind === "string") {
    const lhs =
      storage.kind === "moduleGlobal"
        ? cx.builder.emitGlobalGet(storage.globalRef, logicalType)
        : storage.kind === "slot"
          ? cx.builder.emitSlotReadAs(storage.slotIndex, logicalType)
          : cx.builder.emitRefCellGet(storage.value, capturedCellType!.inner);
    const rhsValue = lowerExpr(rhs, cx, logicalType);
    const rhsType = cx.builder.typeOf(rhsValue);
    if (checkerOperandFamily(rhs, cx) === "string" && rhsType.kind !== "string") {
      // invariant (producer-promise): the checker POSITIVELY proves the RHS is a
      // string, yet the lowered carrier is not — a producer contradiction, not a
      // capability gap. #4502's sweep initially demoted this with the rest of
      // `lowerCompoundAssignment` and #3529 P2 caught it; the "contradictory
      // carrier" wording is the tell. Do not re-demote.
      throw new Error(
        `ir/from-ast: checker-string RHS for "${id.text} +=" has contradictory carrier ${describeIrType(rhsType)} (${cx.funcName})`,
      );
    }
    const proof = proveTypedStringAppend(
      typedValueEvidence(id, storage.type, storage.stringEncoding, cx, logicalType),
      typedValueEvidence(rhs, rhsType, inferStringEncoding(rhs, cx), cx),
    );
    if (!proof) {
      throw new IrUnsupportedError(
        "string-evidence-unsupported",
        "build",
        `ir/from-ast: typed string += requires checker/producer string and encoding evidence for "${id.text}" (${cx.funcName})`,
      );
    }
    const symbol = cx.checker?.getSymbolAtLocation(id);
    const concatMode = symbol && cx.ownedStringAppendSymbols.has(symbol) ? "owned-append" : "immutable";
    const result = cx.builder.emitStringConcat(lhs, rhsValue, proof.resultEncoding, concatMode);
    if (storage.kind === "moduleGlobal") {
      cx.builder.emitGlobalSet(storage.globalRef, result);
    } else if (storage.kind === "slot") {
      cx.builder.emitSlotWrite(storage.slotIndex, result);
    } else {
      cx.builder.emitRefCellSet(storage.value, result);
    }
    cx.scope.set(id.text, { ...storage, stringEncoding: proof.resultEncoding });
    return;
  }
  const slotValType = asVal(logicalType);
  if (!slotValType || slotValType.kind !== "f64") {
    demoteToLegacy(
      "compound-assign-unsupported",
      `ir/from-ast: compound assign to non-f64 slot "${id.text}" (${describeIrType(logicalType)}) not in slice 6 (${cx.funcName})`,
    );
  }

  // Desugar: read the slot (or, #3142, the module-binding global), lower the
  // RHS, apply the binop, write back.
  const lhs =
    storage.kind === "moduleGlobal"
      ? cx.builder.emitGlobalGet(storage.globalRef, storage.type)
      : storage.kind === "slot"
        ? cx.builder.emitSlotRead(storage.slotIndex)
        : cx.builder.emitRefCellGet(storage.value, capturedCellType!.inner);
  const rhsValue = lowerExpr(rhs, cx, logicalType);
  const rhsType = cx.builder.typeOf(rhsValue);
  if (asVal(rhsType)?.kind !== "f64") {
    // (#3565) DESIGNED demote: the f64 slot is fine, but the RHS lowered to a
    // non-f64 (e.g. an externref value yielded by a generator in `s += v`). The
    // numeric coercion is legacy-only, so this is a not-yet-adopted construct,
    // NOT a builder↔finalize desync. Typed UNSUPPORTED so it demotes to the
    // legacy body instead of the untyped `unexpected-internal-throw` invariant
    // #3341/#3519 hard-error (measured casualty: tests/issue-2079 — legacy
    // compiles+runs =3). The f64-slot/string-append arms above are unaffected.
    throw new IrUnsupportedError(
      "compound-assign-unsupported",
      "build",
      `ir/from-ast: compound assign RHS must be f64 (got ${describeIrType(rhsType)}) in ${cx.funcName}`,
    );
  }

  let binop: IrBinop;
  switch (compoundOp) {
    case ts.SyntaxKind.PlusEqualsToken:
      binop = "f64.add";
      break;
    case ts.SyntaxKind.MinusEqualsToken:
      binop = "f64.sub";
      break;
    case ts.SyntaxKind.AsteriskEqualsToken:
      binop = "f64.mul";
      break;
    case ts.SyntaxKind.SlashEqualsToken:
      binop = "f64.div";
      break;
    default:
      demoteToLegacy(
        "compound-assign-unsupported",
        `ir/from-ast: unsupported compound assign op ${ts.SyntaxKind[compoundOp]} in ${cx.funcName}`,
      );
  }
  const result = cx.builder.emitBinary(binop, lhs, rhsValue, irVal({ kind: "f64" }));
  if (storage.kind === "moduleGlobal") {
    cx.builder.emitGlobalSet(storage.globalRef, result);
    return;
  }
  if (storage.kind === "slot") {
    cx.builder.emitSlotWrite(storage.slotIndex, result);
    return;
  }
  cx.builder.emitRefCellSet(storage.value, result);
}

/**
 * Slice 12 (#1280): `<id>++` / `<id>--` / `++<id>` / `--<id>` as an
 * expression statement. Lowers to a slot read, +/- 1, slot write.
 * Result value is discarded (we're in expression-statement position).
 *
 * Both i32 and f64 slots are supported — the typical loop counter is
 * f64 (typed `number`) but `type i32 = number` annotated counters use
 * i32. The binop dispatches on the slot ValType.
 */
function lowerIncrementDecrement(id: ts.Identifier, op: ts.SyntaxKind, cx: LowerCtx): void {
  const binding = cx.scope.get(id.text);
  if (!binding) {
    demoteToLegacy(
      "compound-assign-unsupported",
      `ir/from-ast: increment/decrement of undeclared "${id.text}" in ${cx.funcName}`,
    );
  }
  const capturedCell = binding.kind === "local" && binding.type.kind === "boxed" ? binding : undefined;
  if (binding.kind !== "slot" && binding.kind !== "moduleGlobal" && !capturedCell) {
    // invariant (producer-promise): the mutation pre-pass promised a slot binding here — #4502.
    throw new Error(
      `ir/from-ast: increment/decrement of non-slot "${id.text}" — mutation pre-pass should have detected it (${cx.funcName})`,
    );
  }
  const storage = binding.kind === "slot" || binding.kind === "moduleGlobal" ? binding : capturedCell!;
  const capturedCellType = storage.kind === "local" && storage.type.kind === "boxed" ? storage.type : undefined;
  // (#3741) i32-promoted slot — `i32.add`/`i32.sub` of 1, exactly what legacy
  // has emitted for a promoted counter since #1120.
  if (storage.kind === "slot" && storage.i32Storage) {
    const cur = cx.builder.emitSlotRead(storage.slotIndex);
    const one = cx.builder.emitConst({ kind: "i32", value: 1 }, IR_I32);
    const next = cx.builder.emitBinary(op === ts.SyntaxKind.PlusPlusToken ? "i32.add" : "i32.sub", cur, one, IR_I32);
    cx.builder.emitSlotWrite(storage.slotIndex, next);
    return;
  }
  const logicalType =
    storage.kind === "slot" ? (storage.asType ?? storage.type) : (capturedCellType?.inner ?? storage.type);
  if (logicalType.kind === "dynamic") {
    const current =
      storage.kind === "moduleGlobal"
        ? cx.builder.emitGlobalGet(storage.globalRef, logicalType)
        : storage.kind === "slot"
          ? cx.builder.emitSlotReadAs(storage.slotIndex, logicalType)
          : cx.builder.emitRefCellGet(storage.value, capturedCellType!.inner);
    const numeric = cx.builder.emitDynToNumber(current);
    const one = cx.builder.emitConst({ kind: "f64", value: 1 }, irVal({ kind: "f64" }));
    const updated = cx.builder.emitBinary(
      op === ts.SyntaxKind.PlusPlusToken ? "f64.add" : "f64.sub",
      numeric,
      one,
      irVal({ kind: "f64" }),
    );
    const boxed = cx.builder.emitBox(updated, irDynamic(JS_TAG_IDS.NumberF64));
    if (storage.kind === "moduleGlobal") {
      cx.builder.emitGlobalSet(storage.globalRef, boxed);
    } else if (storage.kind === "slot") {
      cx.builder.emitSlotWrite(storage.slotIndex, boxed);
    } else {
      cx.builder.emitRefCellSet(storage.value, boxed);
    }
    return;
  }
  const slotValType = asVal(logicalType);
  // The IR's binop set only includes f64 arithmetic — i32 add/sub
  // would need additional binop variants. For now, restrict to f64
  // counters (the common case for `let i = 0; i++` where `i: number`).
  // i32-typed counters fall back to legacy via the lowerer's throw.
  if (!slotValType || slotValType.kind !== "f64") {
    demoteToLegacy(
      "compound-assign-unsupported",
      `ir/from-ast: increment/decrement of non-f64 slot "${id.text}" (${describeIrType(logicalType)}) not in slice 12 (${cx.funcName})`,
    );
  }
  const lhs =
    storage.kind === "moduleGlobal"
      ? cx.builder.emitGlobalGet(storage.globalRef, storage.type)
      : storage.kind === "slot"
        ? cx.builder.emitSlotRead(storage.slotIndex)
        : cx.builder.emitRefCellGet(storage.value, capturedCellType!.inner);
  const isAdd = op === ts.SyntaxKind.PlusPlusToken;
  const oneIr: IrType = irVal({ kind: "f64" });
  const one = cx.builder.emitConst({ kind: "f64", value: 1 }, oneIr);
  const binop: IrBinop = isAdd ? "f64.add" : "f64.sub";
  const result = cx.builder.emitBinary(binop, lhs, one, oneIr);
  if (storage.kind === "moduleGlobal") {
    cx.builder.emitGlobalSet(storage.globalRef, result);
    return;
  }
  if (storage.kind === "slot") {
    cx.builder.emitSlotWrite(storage.slotIndex, result);
    return;
  }
  cx.builder.emitRefCellSet(storage.value, result);
}

function lowerConditional(expr: ts.ConditionalExpression, cx: LowerCtx): IrValueId {
  const rawCond = lowerExpr(expr.condition, cx, irVal({ kind: "i32" }));
  // (#4512) §7.1.2 ToBoolean — dynamic lowers via `dyn.truthy`, object/string/ref
  // via the shared coercion, a raw host externref returns null → demote. The
  // coercion is emitted before the `if` so the condition evaluates once.
  const cond = lowerToBooleanForCondition(rawCond, expr.condition, cx);
  if (cond === null) {
    demoteToLegacy("operand-coercion-unsupported", `ir/from-ast: ternary condition must be bool in ${cx.funcName}`);
  }

  // #1820 — short-circuit semantics: only the selected arm may run. A prior
  // implementation lowered both arms eagerly and combined them with Wasm
  // `select`, which evaluates BOTH operands. That is fine for pure arms but
  // wrong when an arm has side effects or recurses (e.g.
  // `n <= 1 ? 1 : n * fact(n - 1)` recursed at the base case → non-termination).
  // Lower each arm into its own body buffer and combine with `IrInstrIf`, so
  // the lowerer emits a structured `if`/`else` that runs exactly one arm.
  const branchScope = new Map(cx.scope);
  const thenCx: LowerCtx = { ...cx, scope: new Map(branchScope) };
  let whenTrue!: IrValueId;
  const thenBody = cx.builder.collectBodyInstrs(() => {
    whenTrue = lowerExpr(expr.whenTrue, thenCx, irVal({ kind: "f64" }));
  });
  const ttype = cx.builder.typeOf(whenTrue);

  // Hint the false arm with the true arm's type so both land on the same
  // carrier (matches the `lowerNullish` convention).
  const elseCx: LowerCtx = { ...cx, scope: new Map(branchScope) };
  let whenFalse!: IrValueId;
  const elseBody = cx.builder.collectBodyInstrs(() => {
    whenFalse = lowerExpr(expr.whenFalse, elseCx, ttype);
  });
  const ftype = cx.builder.typeOf(whenFalse);

  const tVal = asVal(ttype);
  const fVal = asVal(ftype);
  if (!tVal || !fVal || tVal.kind !== fVal.kind) {
    // (#3144) Non-scalar arms with the SAME IrType (string/class/extern/
    // object/…) are lowerable: the `if` lowering derives the result carrier
    // from the instr's IrType via `lowerIrTypeToValType`, so e.g.
    // `cond ? "true" : "false"` types as string on either string backend.
    // Only genuinely mismatched arm types still demote.
    if (!irTypeEquals(ttype, ftype)) {
      demoteToLegacy(
        "operand-coercion-unsupported",
        `ir/from-ast: ternary branches have different types (${describeIrType(ttype)} vs ${describeIrType(ftype)}) in ${cx.funcName}`,
      );
    }
  }

  joinScopeStringEncodingFacts(cx.scope, [thenCx.scope, elseCx.scope]);

  return cx.builder.emitIfElse({
    cond,
    then: thenBody,
    thenValue: whenTrue,
    else: elseBody,
    elseValue: whenFalse,
    resultType: ttype,
  });
}

/**
 * (#3168) ToNumber(operand) → f64 for a unary `+`/`-` operand that is not
 * statically a number. Handles the scope the #3153 census flagged (§7.1.4):
 *
 *   - **boolean (i32)** → `f64.convert_i32_s` (0/1 → 0.0/1.0; boolean is 0/1
 *     so signed/unsigned agree — matches legacy `expressions/unary.ts`).
 *   - **string** → box the string into the boxed-any carrier and reuse the
 *     existing `dyn.to_number` (§7.1.4.1 StringToNumber via the carrier's
 *     tag-5 arm — native `__str_to_number` / host `__unbox_number`), so no new
 *     helper and no string-representation juggling. `""` → 0, `" 42 "` → 42,
 *     `"abc"` → NaN, hex per StringToNumber — exactly the carrier's ToNumber.
 *
 * Returns `null` for any other operand type (object ToPrimitive chain, bigint,
 * etc.) so the caller keeps its existing clean throw (demote pre-#3143, and a
 * selector-mirrored pre-claim reject is out of scope here — see the #3167
 * resolution note on select.ts being checker-free).
 */
function emitUnaryToNumber(rand: IrValueId, randType: IrType, cx: LowerCtx): IrValueId | null {
  if (asVal(randType)?.kind === "i32") {
    // boolean (the only i32-typed IR operand reaching a `+`/`-` — a native
    // `type i32 = number` operand is already numeric and takes the f64 path).
    return cx.builder.emitUnary("f64.convert_i32_s", rand, irVal({ kind: "f64" }));
  }
  if (randType.kind === "string") {
    const boxed = cx.builder.emitBox(rand, irDynamic(JS_TAG_IDS.String));
    return cx.builder.emitDynToNumber(boxed);
  }
  // #4208 S3/S7 — the original open OrdinaryToPrimitive object route. Keep
  // this branded as `extern:Object` so enabling the abstract operation does
  // not silently widen every host-class externref unary expression.
  if (randType.kind === "extern" && randType.className === "Object") {
    const externref = irVal({ kind: "externref" });
    const hint = cx.builder.emitConst({ kind: "null", ty: externref }, externref);
    const primitive = cx.builder.emitCall(irRuntimeFuncRef("__to_primitive"), [rand, hint], externref);
    if (primitive === null) {
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(`ir/from-ast: __to_primitive produced no value in ${cx.funcName}`);
    }
    const number = cx.builder.emitCall(irRuntimeFuncRef("__unbox_number"), [primitive], irVal({ kind: "f64" }));
    if (number === null) {
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(`ir/from-ast: __unbox_number produced no value in ${cx.funcName}`);
    }
    return number;
  }
  // #3522 — selector-certified closed OrdinaryToPrimitive literals contain
  // only zero-arity valueOf/toString closures with primitive returns and no
  // receiver-sensitive `this`. Invoke the preferred number-hint method
  // directly, matching the direct backend's static method dispatch instead of
  // materializing the generic standalone object/coercion runtime.
  if (randType.kind === "object") {
    const method =
      randType.shape.fields.find((field) => field.name === "valueOf") ??
      randType.shape.fields.find((field) => field.name === "toString");
    if (method?.type.kind === "closure" && method.type.signature.params.length === 0) {
      const closure = cx.builder.emitObjectGet(rand, method.name, method.type);
      const primitive = cx.builder.emitClosureCall(closure, [], method.type.signature.returnType);
      if (primitive === null || method.type.signature.returnType === null) {
        // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
        throw new Error(`ir/from-ast: OrdinaryToPrimitive method produced no value in ${cx.funcName}`);
      }
      const primitiveType = method.type.signature.returnType;
      if (asVal(primitiveType)?.kind === "f64") return primitive;
      if (asVal(primitiveType)?.kind === "i32") {
        return cx.builder.emitUnary("f64.convert_i32_s", primitive, irVal({ kind: "f64" }));
      }
      if (primitiveType.kind === "string") {
        const number = cx.builder.emitCall(
          irRuntimeFuncRef("__unbox_number"),
          [cx.builder.emitCoerceToExternref(primitive)],
          irVal({ kind: "f64" }),
        );
        if (number === null) {
          // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
          throw new Error(`ir/from-ast: string OrdinaryToPrimitive result produced no number in ${cx.funcName}`);
        }
        return number;
      }
    }
  }
  return null;
}

function lowerPrefixUnary(expr: ts.PrefixUnaryExpression, cx: LowerCtx): IrValueId {
  // #2135 — capability-table invariant, mirroring `lowerBinary`. A deferred
  // prefix op post-claim is a selector↔table disagreement (compiler bug).
  assertNotDeferred(
    prefixOpCapability(expr.operator),
    `prefix operator '${ts.tokenToString(expr.operator) ?? expr.operator}'`,
    cx.funcName,
  );
  const rand = lowerExpr(expr.operand, cx, irVal({ kind: "f64" }));
  switch (expr.operator) {
    case ts.SyntaxKind.MinusToken: {
      const randType = typeOfValue(rand, cx);
      // #2949 S5.5 — unary `-` on a boxed-any carrier is ToNumber then negate
      // (§13.5.5 Unary Minus): `dyn.to_number` (canonical `__any_to_f64` gc /
      // `__unbox_number` host — D4) feeds the existing `f64.neg`. Byte-inert
      // until the S5.P scan admits dynamic-unary bodies.
      if (randType.kind === "dynamic") {
        const n = cx.builder.emitDynToNumber(rand);
        return cx.builder.emitUnary("f64.neg", n, irVal({ kind: "f64" }));
      }
      // (#3168) `-x` on a non-number operand is `-ToNumber(x)` (§13.5.5 →
      // §7.1.4). ToNumber the operand to f64, then `f64.neg` — sign-correct for
      // `-0` (`-"" === -0`), unlike `0 - x`. Mirrors legacy `expressions/unary.ts`.
      const negToNumber = emitUnaryToNumber(rand, randType, cx);
      if (negToNumber !== null) {
        return cx.builder.emitUnary("f64.neg", negToNumber, irVal({ kind: "f64" }));
      }
      if (asVal(randType)?.kind !== "f64") {
        const detail = `ir/from-ast: unary '-' expects number in ${cx.funcName}`;
        if (checkerProvesUnaryCoercionGap(expr, cx)) {
          throw new IrUnsupportedError("operand-coercion-unsupported", "build", detail);
        }
        throw new Error(detail);
      }
      return cx.builder.emitUnary("f64.neg", rand, irVal({ kind: "f64" }));
    }
    case ts.SyntaxKind.PlusToken: {
      const randType = typeOfValue(rand, cx);
      // #2949 S5.5 — unary `+` on a boxed-any carrier IS ToNumber (§13.5.4
      // Unary Plus is exactly `? ToNumber(value)`): a bare `dyn.to_number`.
      if (randType.kind === "dynamic") {
        return cx.builder.emitDynToNumber(rand);
      }
      // (#3168) `+x` IS `ToNumber(x)` (§13.5.4). A boolean / string operand
      // ToNumbers to f64 (boolean → 0/1; string → §7.1.4.1 StringToNumber).
      const plusToNumber = emitUnaryToNumber(rand, randType, cx);
      if (plusToNumber !== null) {
        return plusToNumber;
      }
      if (asVal(randType)?.kind !== "f64") {
        const detail = `ir/from-ast: unary '+' expects number in ${cx.funcName}`;
        if (checkerProvesUnaryCoercionGap(expr, cx)) {
          throw new IrUnsupportedError("operand-coercion-unsupported", "build", detail);
        }
        throw new Error(detail);
      }
      return rand;
    }
    case ts.SyntaxKind.ExclamationToken: {
      const randType = typeOfValue(rand, cx);
      // #2949 S5.5 — `!dyn` is ToBoolean then negate (§13.5.7): `dyn.truthy`
      // (the S5.1 primitive — canonical `__any_unbox_bool` gc / `__is_truthy`
      // host) feeds the existing `i32.eqz`. Inherits S5.1's documented gc
      // boxed-NaN-is-truthy byte-parity quirk (host is spec-correct).
      if (asVal(randType)?.kind === "i32") {
        // (#4503) `!x` is a JS boolean whatever `x`'s carrier was.
        return cx.builder.emitUnary("i32.eqz", rand, IR_BOOL);
      }
      // (#4512) `!ref` = §7.1.2 ToBoolean(ref) then negate (§13.5.7). The shared
      // coercion handles dynamic (`dyn.truthy`), string, object/class/closure and
      // nullable wasmgc refs; a raw host externref returns null → demote.
      const truthy = lowerToBooleanForCondition(rand, expr.operand, cx);
      if (truthy !== null) {
        return cx.builder.emitUnary("i32.eqz", truthy, IR_BOOL);
      }
      const detail = `ir/from-ast: unary '!' expects bool in ${cx.funcName}`;
      if (checkerProvesUnaryCoercionGap(expr, cx)) {
        throw new IrUnsupportedError("operand-coercion-unsupported", "build", detail);
      }
      throw new Error(detail);
    }
    case ts.SyntaxKind.TildeToken: {
      const randType = typeOfValue(rand, cx);
      if (asVal(randType)?.kind !== "f64") {
        demoteToLegacy(
          "operand-coercion-unsupported",
          `ir/from-ast: unary '~' expects a proven number in ${cx.funcName}`,
        );
      }
      const minusOne = cx.builder.emitConst({ kind: "f64", value: -1 }, irVal({ kind: "f64" }));
      return cx.builder.emitBinary("js.bitxor", rand, minusOne, irVal({ kind: "f64" }));
    }
    default:
      demoteToLegacy(
        "operand-coercion-unsupported",
        `ir/from-ast: unsupported prefix operator ${ts.SyntaxKind[expr.operator]} in ${cx.funcName}`,
      );
  }
}

/**
 * #2781 (hybrid Row 7) — TS-type-keyed primitive classifier. The reusable
 * operand-type proof shared by the binary fast paths (and, going forward, rows
 * 3 packed-`i32` and 5 unboxed-number-locals, which need the same "provably
 * number / does-not-escape-to-`any`" judgement).
 *
 * Returns the provable primitive class of a TS type for the purpose of
 * discharging a fast-path safety predicate `P`:
 *   - `"number"`  — provably a pure number: `NumberLike` (`Number |
 *     NumberLiteral`, incl. numeric enum literals), or a union whose EVERY
 *     constituent is provably number.
 *   - `"string"`  — provably a pure string: `StringLike` (`String |
 *     StringLiteral`), template-literal / string-mapping types (always strings
 *     at runtime), or an all-string union.
 *   - `"unprovable"` — `any` / `unknown` / `object` / `boolean` (= the
 *     `true | false` union of non-number/string literals) / `bigint` /
 *     `symbol` / `null` / `undefined` / a MIXED `number | string` union /
 *     intersections / anything else. Only the SAFE dynamic lowering is correct.
 *
 * CRITICAL (the Row-7 trap that parked two prior attempts): this keys on the TS
 * *type*, NEVER the lowered Wasm kind. `number`, `boolean` and `symbol` all
 * collapse to `i32` / `f64` at the Wasm level, so the kind cannot distinguish a
 * numeric-add operand from a boolean / `any` one.
 */
const STRING_PROOF_FLAGS = ts.TypeFlags.StringLike | ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping;

function classifyPrimitiveProof(t: ts.Type): "number" | "string" | "unprovable" {
  // Union (incl. the intrinsic `boolean`, which is internally `true | false`):
  // every constituent must share the SAME provable class. Any unprovable
  // constituent, a mixed number/string union, or an empty (`never`) union →
  // unprovable.
  if (t.isUnion()) {
    let acc: "number" | "string" | null = null;
    for (const c of t.types) {
      const cc = classifyPrimitiveProof(c);
      if (cc === "unprovable") return "unprovable";
      if (acc === null) acc = cc;
      else if (acc !== cc) return "unprovable";
    }
    return acc ?? "unprovable";
  }
  const f = t.flags;
  if (f & ts.TypeFlags.NumberLike) return "number";
  if (f & STRING_PROOF_FLAGS) return "string";
  return "unprovable";
}

/**
 * #2781 — per-operand wrapper around {@link classifyPrimitiveProof}. Returns
 * `"no-checker"` when no TS checker is available, so the caller can leave the
 * existing kind-based dispatch unchanged (mirrors #2780's no-checker arm: with
 * no checker there is no specialization whose unsoundness we would be masking).
 */
function proveAdditiveOperand(node: ts.Expression, cx: LowerCtx): "number" | "string" | "unprovable" | "no-checker" {
  const checker = cx.checker;
  if (!checker) return "no-checker";
  const byChecker = classifyPrimitiveProof(checker.getTypeAtLocation(node));
  if (byChecker !== "unprovable") return byChecker;
  // #4177 — the checker says `any` for an unannotated param / a call to an
  // unannotated local function, but SELECTION may have claimed this function
  // off the #1131 interprocedural fixpoint's lattice facts (an f64 param atom,
  // an f64 callee return atom). The proof must consume the SAME facts, or the
  // claim hard-fails after the legacy body was already skipped (the exact
  // split-brain of #4177). Only already-proved facts are consulted — the
  // per-declaration param map and the certified direct-call plan signatures —
  // never fresh inference and never the lowered Wasm kind (the Row-7 trap:
  // the lattice's bool atom is i32-branded and deliberately unmapped there).
  // See src/ir/lattice-param-facts.ts for the full soundness argument.
  return latticeAdditiveFact(node, cx) ?? "unprovable";
}

/**
 * Checker-owned source family used only to classify a representation
 * contradiction at a residual coercion gate. This is deliberately broader
 * than {@link classifyPrimitiveProof}: additive specialization needs a
 * number/string proof, while an invariant backstop must also distinguish a
 * proven boolean from an unknown/object source.
 */
type CheckerOperandFamily = "number" | "string" | "boolean" | "other" | "unknown" | "no-checker";

function classifyCheckerOperandFamily(type: ts.Type): Exclude<CheckerOperandFamily, "no-checker"> {
  if (type.isUnion()) {
    if (type.types.length === 0) return "unknown";
    const families = type.types.map(classifyCheckerOperandFamily);
    const first = families[0]!;
    return first !== "unknown" && families.every((family) => family === first) ? first : "unknown";
  }
  const flags = type.flags;
  if (flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return "unknown";
  if (flags & ts.TypeFlags.NumberLike) return "number";
  if (flags & STRING_PROOF_FLAGS) return "string";
  if (flags & ts.TypeFlags.BooleanLike) return "boolean";
  return "other";
}

function checkerOperandFamily(node: ts.Expression, cx: LowerCtx): CheckerOperandFamily {
  const checker = cx.checker;
  if (!checker) return "no-checker";
  try {
    return classifyCheckerOperandFamily(checker.getTypeAtLocation(node));
  } catch {
    return "unknown";
  }
}

function isSupportedPrimitiveFamily(
  family: CheckerOperandFamily,
): family is Extract<CheckerOperandFamily, "number" | "string" | "boolean"> {
  return family === "number" || family === "string" || family === "boolean";
}

/**
 * A mismatched pair is a capability exit unless source evidence positively
 * contradicts it — i.e. the checker says both operands ARE the same
 * already-supported primitive family, yet a carrier arrived that the fast path
 * does not promise. Only that contradiction is a producer-contract violation.
 *
 * (#4502) `no-checker` and `unknown` are NOT the same condition, and collapsing
 * them was the defect:
 *
 *   - `no-checker` — the compiler is running without a TypeChecker at all.
 *     That is an infrastructure condition, says nothing about the source, and
 *     #3529 P2 deliberately keeps the invariant backstop for it (a synthetic
 *     carrier contradiction must still be loud). Unchanged: returns `false`.
 *   - `unknown` — a checker IS present and cannot classify the operand, i.e.
 *     the source really is type-erased (`x as any`). That is a statement ABOUT
 *     THE SOURCE, and it is exactly a capability gap. It used to return
 *     `false` too, which failed OPEN into a hard compile error precisely where
 *     the checker is least able to help. Measured on this branch before the
 *     change, `--target standalone`: `return -(s as any)` and the `!` / `~`
 *     equivalents produced an EMPTY binary (`Codegen error: IR path failed`)
 *     while the legacy backend lowers all three. Now returns `true`.
 *
 * A POSITIVE contradiction — the checker says both operands ARE the same
 * already-supported primitive family, yet a carrier arrived that the fast path
 * does not promise — still returns `false` and stays an invariant.
 */
function checkerProvesBinarySourceCapabilityGap(left: ts.Expression, right: ts.Expression, cx: LowerCtx): boolean {
  const leftFamily = checkerOperandFamily(left, cx);
  const rightFamily = checkerOperandFamily(right, cx);
  if (leftFamily === "no-checker" || rightFamily === "no-checker") return false;
  if (leftFamily === "unknown" || rightFamily === "unknown") return true;
  if (isSupportedPrimitiveFamily(leftFamily) && leftFamily === rightFamily) return false;
  // Every other checker-proven family pair is valid source whose representation
  // is not promised by the primitive fast path. This includes strict and
  // object-object equality even though those operators do not coerce: they are
  // capability gaps, not evidence that a carrier producer contradicted an
  // already-supported homogeneous primitive promise.
  return true;
}

/**
 * Unary `+`/`-` already lower number, boolean and string source families;
 * unary `!` already lowers boolean. If one of those proven families arrives
 * with an incompatible carrier, the producer contract is broken and the
 * caller must keep the failure as an Invariant.
 *
 * (#4502) A checker that IS present and answers `unknown` describes the SOURCE
 * (`x as any`) and now reports a capability gap; having NO checker describes
 * the pipeline and keeps the invariant backstop. See the note on
 * {@link checkerProvesBinarySourceCapabilityGap} for the split and for the
 * measured casualty (`-(s as any)`, `!(s as any)`, `~(s as any)` all hard-failed
 * to an empty binary). The Invariant is retained for the positive contradiction
 * below.
 */
function checkerProvesUnaryCoercionGap(expr: ts.PrefixUnaryExpression, cx: LowerCtx): boolean {
  const family = checkerOperandFamily(expr.operand, cx);
  if (family === "no-checker") return false;
  if (family === "unknown") return true;
  if (expr.operator === ts.SyntaxKind.ExclamationToken) return family !== "boolean";
  return family !== "number" && family !== "boolean" && family !== "string";
}

/**
 * #2790 — is `t` provably a pure `boolean` (the intrinsic `true | false` union,
 * a `true` / `false` literal, or a union thereof)? Mirrors the recursive shape
 * of {@link classifyPrimitiveProof}, but for the boolean brand — which that
 * function deliberately reports as `"unprovable"` (a `boolean` is NOT a number,
 * so it must never enter the *number* no-box path). Used by the `i32`-arm of
 * {@link proveUnboxedNumberLocal} to recognise the OTHER sound no-box `i32`
 * brand: an unboxed `boolean` carries no runtime tag either, but #2785 made the
 * escape box brand-aware (`coerceType(i32 → externref)` picks `__box_boolean`
 * for a boolean-branded scalar), so a provably-boolean `i32` local is sound to
 * keep unboxed and boxes correctly on escape. `any` / `unknown` / a mixed union
 * are NOT provably boolean → not recognised here → demoted.
 */
function isProvablyBoolean(t: ts.Type): boolean {
  if (t.isUnion()) {
    // Every constituent must itself be provably boolean; an empty (`never`)
    // union is not (mirrors classifyPrimitiveProof's `acc ?? unprovable`).
    return t.types.length > 0 && t.types.every(isProvablyBoolean);
  }
  return (t.flags & ts.TypeFlags.BooleanLike) !== 0;
}

/**
 * #2782 (hybrid Row 5) + #2790 (i32 arm) — the no-box proof for an UNBOXED
 * NUMBER local. Reuses {@link classifyPrimitiveProof} (the #2781 operand-type
 * proof) to discharge the fast-path safety predicate `P` for the "keep a number
 * local unboxed" specialization.
 *
 * `lowerVarDecl` binds a local with a native, UNBOXED scalar representation
 * whenever its value lowers to (or is annotated) `f64` / `i32`. Per the Hybrid
 * Invariant that no-box specialization is only sound when the local's value
 * provably cannot be anything but a pure number: an unboxed scalar carries no
 * runtime tag, so at any later `any` / union / externref use it would be read
 * with the wrong identity (e.g. `typeof`, `===` against a string, a
 * boxed-`Number` round-trip). When the local's TS type is NOT provably a pure
 * number — `any` / `unknown` / `number | string` / etc. — the no-box path is
 * unsound and codegen must demote to the SAFE boxed legacy lowering (which
 * carries the dynamic tag).
 *
 * Returns `true` to KEEP the no-box fast path, `false` to DEMOTE.
 *
 * CRITICAL (the trap that parked two prior Row-1 attempts): this keys on the TS
 * *type* via `classifyPrimitiveProof`, NEVER the lowered Wasm kind. `number`,
 * `boolean` and `symbol` all collapse to `f64` / `i32`, so the Wasm kind cannot
 * tell a genuine numeric local from a boolean / `any` one.
 *
 * Scope by representation:
 *   - `f64` (#2782): keep ONLY when the TS type is provably a pure `number`;
 *     anything else (`any` / `number | string` opaquely coerced by the f64 hint)
 *     is unsound → demote.
 *   - `i32` (#2790): the `i32` representation hosts TWO sound, brand-determinable
 *     primitives — a `number` (e.g. `arr.length`, a native-`i32` typed number;
 *     boxes via `__box_number`) AND a `boolean` (boxes via `__box_boolean` since
 *     #2785 made `coerceType(i32 → externref)` brand-aware). Keep BOTH unboxed;
 *     demote only a genuinely-unprovable `i32` local (`any` / `unknown` / a mixed
 *     union — no determinable brand for the escape box). CRITICAL: a `boolean` is
 *     recognised by {@link isProvablyBoolean}, NOT by the number proof — it must
 *     never enter the *number* no-box path (which would box it via
 *     `__box_number`, corrupting it). Demoting every boolean (the naive
 *     "gate i32 on `classifyPrimitiveProof === 'number'`" trap that deferred this
 *     arm in #2782) would route every boolean-local function to legacy and grow
 *     an IR-fallback bucket — explicitly avoided here.
 *   - `i64` (bigint) / reference / string locals are out of scope (unaffected).
 *
 * No checker → there is no specialization whose unsoundness we would be masking
 * (every boundary use is still type-checked), so keep the existing behavior
 * unchanged (mirrors #2780 / #2781's no-checker arm).
 */
function proveUnboxedNumberLocal(decl: ts.VariableDeclaration, boundType: IrType, cx: LowerCtx): boolean {
  const bv = asVal(boundType);
  if (!bv || (bv.kind !== "f64" && bv.kind !== "i32")) return true; // not a no-box scalar NUMBER representation — out of scope.
  if (cx.numericLocalScalarForDecl?.(decl) === "number") return true;
  const checker = cx.checker;
  if (!checker) return true; // no checker → leave behavior unchanged.
  const tsType = checker.getTypeAtLocation(decl.name);
  if (classifyPrimitiveProof(tsType) === "number") return true; // provable number — keep (boxes __box_number on escape).
  // f64 hosts only the number brand: a non-number f64 was opaquely coerced and
  // is unsound to keep unboxed → demote.
  if (bv.kind === "f64") return false;
  // i32 arm (#2790): the OTHER sound i32 brand is a provable `boolean`, kept
  // unboxed and boxed via `__box_boolean` (#2785) at the escape edge. Anything
  // else i32 (`any` / mixed union — no determinable brand) → demote.
  return isProvablyBoolean(tsType);
}

/**
 * (#3144) Walk a class shape's own + parent-chain method descriptors for a
 * member of the requested kind. `memberKind` defaults to "method" on
 * pre-#3144 descriptors, so plain instance-method lookups keep their exact
 * prior semantics while getter/setter/static descriptors never leak into
 * them. Inherited members resolve by walking `shape.parent` (present for
 * single-level local subclasses); the CALL still targets the RECEIVER's
 * `${className}_<member>` key, which legacy's inherited-member key
 * propagation registers (collectClassDeclaration).
 */
function findClassMember(
  shape: IrClassShape,
  name: string,
  kind: "method" | "getter" | "setter" | "static",
): import("./nodes.js").IrClassMethodDescriptor | undefined {
  for (let s: IrClassShape | undefined = shape; s; s = s.parent) {
    const m = s.methods.find((m) => m.name === name && (m.memberKind ?? "method") === kind);
    if (m) return m;
  }
  return undefined;
}

/**
 * (#3144) `value instanceof C` where `C` names a locally-declared class.
 * Class-typed LHS → `class.instanceof` (runtime `__tag` compare against C's
 * tag + descendant tags — exactly legacy `compileInstanceOf`'s non-null-ref
 * path). LHS representations that can never hold a user-class instance
 * (unboxed scalars, strings, plain-object structs, internal closures) fold to
 * constant false with the operand still evaluated for effects (legacy
 * parity: `drop; i32.const 0`). Everything else (boundary callables/externref,
 * dynamic, union, boxed, vec refs) demotes cleanly to legacy, which has the
 * full dynamic `__instanceof_dyn` path.
 */
function lowerInstanceOf(expr: ts.BinaryExpression, cx: LowerCtx): IrValueId {
  if (!ts.isIdentifier(expr.right)) {
    demoteToLegacy(
      "operand-coercion-unsupported",
      `ir/from-ast: instanceof RHS must be a class identifier (${cx.funcName})`,
    );
  }
  const className = expr.right.text;
  if (cx.scope.get(className) !== undefined) {
    // A local binding shadows the class name — the selector rejects this
    // shape, so reaching here is only possible via drift; demote cleanly.
    demoteToLegacy(
      "operand-coercion-unsupported",
      `ir/from-ast: instanceof RHS "${className}" is shadowed by a local (${cx.funcName})`,
    );
  }
  const wrapperPlan = cx.resolver?.standaloneWrapperInstanceOfPlan?.(className) ?? null;
  if (wrapperPlan) {
    const lhs = lowerExpr(expr.left, cx, irDynamic());
    const lt = cx.builder.typeOf(lhs);
    const resultType = irVal({ kind: "i32" });
    if (lt.kind === "dynamic") {
      const isObject = cx.builder.emitTagTest(lhs, JS_TAG_IDS.Object);
      let whenObject!: IrValueId;
      const thenBody = cx.builder.collectBodyInstrs(() => {
        const payload = cx.builder.emitUnbox(lhs, JS_TAG_IDS.Object);
        const result = cx.builder.emitCall(irRuntimeFuncRef(wrapperPlan.funcName), [payload], resultType);
        if (result === null) {
          // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
          throw new Error(`ir/from-ast: ${wrapperPlan.funcName} produced no result in ${cx.funcName}`);
        }
        whenObject = result;
      });
      let whenNotObject!: IrValueId;
      const elseBody = cx.builder.collectBodyInstrs(() => {
        whenNotObject = cx.builder.emitConst({ kind: "i32", value: 0 }, resultType);
      });
      return cx.builder.emitIfElse({
        cond: isObject,
        then: thenBody,
        thenValue: whenObject,
        else: elseBody,
        elseValue: whenNotObject,
        resultType,
      });
    }
    const lv = asVal(lt);
    if (lt.kind === "string" || lt.kind === "object" || lt.kind === "closure" || lt.kind === "class") {
      const result = cx.builder.emitCall(irRuntimeFuncRef(wrapperPlan.funcName), [lhs], resultType);
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      if (result === null) throw new Error(`ir/from-ast: ${wrapperPlan.funcName} produced no result in ${cx.funcName}`);
      return result;
    }
    if (lv?.kind === "anyref" || lv?.kind === "eqref" || lv?.kind === "ref" || lv?.kind === "ref_null") {
      const result = cx.builder.emitCall(irRuntimeFuncRef(wrapperPlan.funcName), [lhs], resultType);
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      if (result === null) throw new Error(`ir/from-ast: ${wrapperPlan.funcName} produced no result in ${cx.funcName}`);
      return result;
    }
    if (lv?.kind === "f64" || lv?.kind === "i32" || lv?.kind === "i64") {
      return cx.builder.emitConst({ kind: "i32", value: 0 }, resultType);
    }
    throw new IrUnsupportedError(
      "operand-coercion-unsupported",
      "build",
      `ir/from-ast: wrapper instanceof cannot normalize ${describeIrType(lt)} to anyref (${cx.funcName})`,
    );
  }
  const targetShape = cx.classShapes?.get(className);
  if (!targetShape) {
    demoteToLegacy(
      "operand-coercion-unsupported",
      `ir/from-ast: instanceof RHS class "${className}" has no projected shape (${cx.funcName})`,
    );
  }
  const lhs = lowerExpr(expr.left, cx, irVal({ kind: "f64" }));
  const lt = cx.builder.typeOf(lhs);
  if (lt.kind === "class") {
    return cx.builder.emitClassInstanceOf(lhs, targetShape);
  }
  if (
    lt.kind === "string" ||
    lt.kind === "object" ||
    lt.kind === "closure" ||
    (lt.kind === "val" && (lt.val.kind === "f64" || lt.val.kind === "i32"))
  ) {
    // Provably-never-a-class-instance representations → constant false. The
    // LHS is already lowered; if it carries side effects the zero-use
    // side-effecting emission arm keeps it (never silently dropped).
    return cx.builder.emitConst({ kind: "i32", value: 0 }, irVal({ kind: "i32" }));
  }
  demoteToLegacy(
    "operand-coercion-unsupported",
    `ir/from-ast: instanceof on ${describeIrType(lt)} LHS is not lowered — legacy handles the dynamic path (${cx.funcName})`,
  );
}

function peelParensExpr(e: ts.Expression): ts.Expression {
  let inner: ts.Expression = e;
  while (ts.isParenthesizedExpression(inner)) inner = inner.expression;
  return inner;
}

function expressionProducesDynamic(expr: ts.Expression, cx: LowerCtx): boolean {
  const candidate = peelParensExpr(expr);
  if (ts.isIdentifier(candidate)) {
    const binding = cx.scope.get(candidate.text);
    if (!binding) return false;
    if (binding.kind === "local" || binding.kind === "moduleGlobal") return binding.type.kind === "dynamic";
    if (binding.kind === "slot") return (binding.asType ?? binding.type).kind === "dynamic";
    return false;
  }
  if (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) {
    return expressionProducesDynamic(candidate.expression, cx);
  }
  if (ts.isCallExpression(candidate)) {
    if (ts.isIdentifier(candidate.expression)) {
      return cx.calleeTypes?.get(candidate.expression.text)?.returnType?.kind === "dynamic";
    }
    return (
      ts.isPropertyAccessExpression(candidate.expression) &&
      expressionProducesDynamic(candidate.expression.expression, cx)
    );
  }
  if (ts.isConditionalExpression(candidate)) {
    return expressionProducesDynamic(candidate.whenTrue, cx) && expressionProducesDynamic(candidate.whenFalse, cx);
  }
  return (
    ts.isBinaryExpression(candidate) &&
    candidate.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    (expressionProducesDynamic(candidate.left, cx) || expressionProducesDynamic(candidate.right, cx))
  );
}

/**
 * (#3758) Emit `e` — the caller MUST have already verified
 * `isI32PureExprIR(e, cx.i32PureNames)` — as a genuine i32-typed IrValueId.
 * `+`/`-`/guarded-`*` compositions use REAL native `i32.add`/`i32.sub`/
 * `i32.mul` (added in `ir/nodes.ts`), which wrap modulo 2^32 exactly like
 * ECMA-262 ToInt32 — never `i32.trunc_sat_f64_s` as a substitute for
 * arithmetic (that conflation is exactly what made a prior version of this
 * fast path unsound and reverted — see `ir/i32-pure-bitwise.ts`'s header
 * comment). Leaves (a proven-pure identifier, an in-range literal, or a
 * nested bitwise/shift sub-expression — always int32-range by spec
 * regardless of ITS OWN operands) are lowered via the existing, UNCHANGED
 * general path and then narrowed via the cheap `i32.trunc_sat_f64_s`,
 * which is exact here because each leaf's value is independently proven
 * bounded, not inferred from composing other values.
 */
function emitI32PureExpr(e: ts.Expression, cx: LowerCtx): IrValueId {
  const inner = peelParensExpr(e);
  if (ts.isBinaryExpression(inner)) {
    const k = inner.operatorToken.kind;
    if (k === ts.SyntaxKind.PlusToken || k === ts.SyntaxKind.MinusToken) {
      const l = emitI32PureExpr(inner.left, cx);
      const r = emitI32PureExpr(inner.right, cx);
      const binop = k === ts.SyntaxKind.PlusToken ? "i32.add" : "i32.sub";
      return cx.builder.emitBinary(binop, l, r, irVal({ kind: "i32" }));
    }
    if (k === ts.SyntaxKind.AsteriskToken) {
      const l = emitI32PureExpr(inner.left, cx);
      const r = emitI32PureExpr(inner.right, cx);
      return cx.builder.emitBinary("i32.mul", l, r, irVal({ kind: "i32" }));
    }
    // Nested bitwise/shift result — falls through to the leaf case below:
    // lower via the existing general path (unchanged), then narrow.
  }
  // (#3931) The proven char-read leaf is ALREADY an i32 code unit — take it
  // directly rather than widening to f64 and narrowing straight back.
  const provenCharRead = matchProvenCharRead(inner, cx.provenCharReads);
  if (provenCharRead !== null) return emitProvenCharReadI32(inner as ts.CallExpression, provenCharRead, cx);
  const f64Value = lowerExpr(e, cx, irVal({ kind: "f64" }));
  const valueType = asVal(typeOfValue(f64Value, cx));
  if (valueType?.kind === "i32") return f64Value; // already i32 — no redundant narrowing
  return cx.builder.emitUnary("i32.trunc_sat_f64_s", f64Value, irVal({ kind: "i32" }));
}

function collectPreparedConcatOperands(expression: ts.Expression, out: ts.Expression[]): void {
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    collectPreparedConcatOperands(expression.left, out);
    collectPreparedConcatOperands(expression.right, out);
    return;
  }
  out.push(expression);
}

function lowerPreparedAsyncConcat(expr: ts.BinaryExpression, cx: LowerCtx): IrValueId | null {
  const target = cx.resolver?.preparedAsyncConcatFiveTarget?.(expr) ?? null;
  if (target === null) return null;
  const operands: ts.Expression[] = [];
  collectPreparedConcatOperands(expr, operands);
  if (operands.length !== 5) {
    demoteToLegacy(
      "body-shape-rejected",
      `ir/from-ast: prepared five-part concat has ${operands.length} operands in ${cx.funcName}`,
    );
  }
  const values = operands.map((operand) => {
    const value = lowerExpr(operand, cx, { kind: "string" });
    if (cx.builder.typeOf(value).kind !== "string") {
      demoteToLegacy("body-shape-rejected", `ir/from-ast: prepared concat operand is not a string in ${cx.funcName}`);
    }
    return value;
  });
  const result = cx.builder.emitCall(target, values, { kind: "string" });
  // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
  if (result === null) throw new Error(`ir/from-ast: prepared five-part concat returned void in ${cx.funcName}`);
  return result;
}

function lowerBinary(expr: ts.BinaryExpression, cx: LowerCtx, hint: IrType): IrValueId {
  const op = expr.operatorToken.kind;
  const preparedConcat = lowerPreparedAsyncConcat(expr, cx);
  if (preparedConcat !== null) return preparedConcat;

  // IR-native nullish short-circuit for matching reference-shaped arms;
  // lowerNullish rejects non-reference or mismatched operands.
  if (op === ts.SyntaxKind.QuestionQuestionToken) {
    return lowerNullish(expr, cx, hint);
  }

  // #1820 — `&&` / `||` short-circuit. A prior implementation lowered both
  // operands eagerly and combined them with `i32.and` / `i32.or`, which
  // evaluates the right operand unconditionally — losing JS short-circuit
  // semantics (e.g. `guard && risky()` ran `risky()` even when `guard` was
  // false). Lower the right operand into its own body buffer and combine with
  // `IrInstrIf` so it runs only on the branch that needs it. Handled before
  // the eager operand lowering below, like `??`.
  if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) {
    return lowerLogicalAndOr(expr, op, cx);
  }

  // (#3144) `x instanceof C` with a LOCAL-class RHS — intercepted before the
  // capability gate (like `??` / `&&` above): `instanceof` stays table-deferred
  // for the general case, but the local-class form has an IR lowering
  // (`class.instanceof`, a static tag check mirroring legacy
  // `compileInstanceOf`). The selector accepts exactly this shape
  // (identifier RHS ∈ localClasses, unshadowed), keeping select↔build parity.
  if (op === ts.SyntaxKind.InstanceOfKeyword) {
    return lowerInstanceOf(expr, cx);
  }

  // #2135 — capability-table invariant (shared with the selector via
  // `src/ir/capability.ts`). The old slice-11 "shape-only acceptance" list
  // (`%` / `**` / `in` / `instanceof` claimed by the selector, thrown here)
  // is retired: those ops are table-deferred, the selector rejects them
  // up-front, and an op arriving here with a "defer" capability is a
  // claim-path BUG (loud internal error), not a legitimate legacy fallback.
  // Checked BEFORE operand lowering so a violation reports cleanly without
  // cascading operand errors.
  assertNotDeferred(binaryOpCapability(op), `binary operator '${ts.tokenToString(op) ?? op}'`, cx.funcName);

  // === / !== / == / != with a `null` literal: slice 1 has no nullable IR
  // types yet, so every operand we can lower trivially evaluates to false
  // for === null / true for !== null. Try this fold first; it short-
  // circuits the standard f64-hint lowering below (which would otherwise
  // recurse into a bare NullKeyword and throw).
  const nullFold = tryFoldNullCompare(expr, op, cx);
  if (nullFold !== null) return nullFold;

  // (#2856 C3) STRICT undefined-compare — `hit !== undefined`. Dispatch on
  // the non-undefined operand's IrType (mirrors the selector's acceptance):
  //   - externref-shaped (externref val / extern class / callable / host string):
  //     runtime `__extern_is_undefined(v)` (the legacy check for the same
  //     shape), inverted for `!==`.
  //   - representations that can never hold the JS `undefined` VALUE
  //     (unboxed f64/i32 scalars, non-null WasmGC refs incl. vecs/classes/
  //     native strings — strict equality: `null !== undefined` is true too):
  //     constant fold, evaluating the operand for side effects.
  //   - anything else (boxed / union / dynamic): clean demote.
  const undefCompare = tryLowerUndefinedCompare(expr, op, cx);
  if (undefCompare !== null) return undefCompare;

  // #2781 (hybrid Row 7) — `+` operand-type proof gate. Run BEFORE operand
  // lowering (mirrors #2780's pre-element widening gate), so no dead operand
  // instrs are emitted and the demotion cause is the explicit HI reason rather
  // than an incidental downstream "mixed string/non-string" / `requireF64`
  // throw. `+` is string-concat-OR-numeric-add chosen at RUNTIME (ToPrimitive on
  // each operand, then "if either is a string → concatenate, else add"). The
  // kind-based dispatch below picks concat-vs-add from the lowered Wasm kind,
  // but per the Hybrid Invariant a T-directed specialization must be discharged
  // by a proof on the TS *type*, never the Wasm kind: number / boolean / symbol
  // all collapse to f64 / i32, so the kind alone cannot tell a genuine
  // numeric-add operand from an `any` / string / `string | number` one the f64
  // hint coerced opaquely (the Row-7 trap). Prove BOTH operands number (→ the
  // unboxed numeric add below) or BOTH string (→ `emitStringConcat`); anything
  // unprovable — `any` / union / a MIXED number+string pair — demotes to the
  // SAFE legacy dynamic `+` (`binary-ops.ts` `emitAnyAdd`, ToPrimitive +
  // string-concat-or-add). No checker → leave the existing kind-based dispatch
  // unchanged (#2780's no-checker arm). The same operand proof
  // (`proveAdditiveOperand` / `classifyPrimitiveProof`) is the reusable
  // infrastructure rows 3 / 5 adopt.
  if (
    op === ts.SyntaxKind.PlusToken &&
    !expressionProducesDynamic(expr.left, cx) &&
    !expressionProducesDynamic(expr.right, cx)
  ) {
    const lProof = proveAdditiveOperand(expr.left, cx);
    const rProof = proveAdditiveOperand(expr.right, cx);
    if (lProof !== "no-checker" && rProof !== "no-checker") {
      if (lProof === "unprovable" || rProof === "unprovable" || lProof !== rProof) {
        throw new IrUnsupportedError(
          "operand-coercion-unsupported",
          "build",
          `ir/from-ast: '+' operands not provably both-number or both-string ` +
            `(${lProof}/${rProof}) — the unboxed numeric-add / string-concat fast ` +
            `path is unsound here; demote to the SAFE dynamic '+' (emitAnyAdd) in ${cx.funcName}`,
        );
      }
    }
  }

  // (#3741) i32 fast paths that need to choose the OPERANDS' representation:
  // slot-promotion fusion, and the `x | 0` identity. Null ⇒ nothing applied
  // and #3758's expression-level fusion below runs exactly as before.
  const fusedI32 = tryLowerFusedI32Binary(expr, op, cx);
  if (fusedI32 !== null) return fusedI32;

  // (#3758) A bitwise/shift operator whose BOTH operand expressions are
  // provably computable via genuine native i32 arithmetic (no ToInt32
  // dance anywhere in either subtree — `isI32PureExprIR`, reusing legacy's
  // own #1120/#1236 proofs) skips the expensive per-operand ToInt32
  // emulation (`js.bit*`'s IEEE-754 bit-decomposition, #3739) entirely.
  // See `ir/i32-pure-bitwise.ts` for the full soundness argument — this
  // NEVER uses `i32.trunc_sat_f64_s` as a substitute for arithmetic
  // (that was the exact bug that made a prior version of this fast path
  // unsound; see #3745's revert history).
  const i32PureBitwiseOperands =
    isIrBitwiseOperatorToken(op) &&
    isI32PureExprIR(expr.left, cx.i32PureNames, cx.provenCharReads) &&
    isI32PureExprIR(expr.right, cx.i32PureNames, cx.provenCharReads);
  const lhs = i32PureBitwiseOperands
    ? emitI32PureExpr(expr.left, cx)
    : lowerExpr(expr.left, cx, irVal({ kind: "f64" }));
  const rhs = i32PureBitwiseOperands
    ? emitI32PureExpr(expr.right, cx)
    : lowerExpr(expr.right, cx, irVal({ kind: "f64" }));
  const lt = typeOfValue(lhs, cx);
  const rt = typeOfValue(rhs, cx);

  // #2949 S5.2 — dynamic equality: `===`/`!==`/`==`/`!=` where either operand
  // is a boxed-any carrier. The concrete operand is boxed into the carrier
  // (refining the box tag from a literal's kind where known), the dyn operand
  // is left as-is, and `dyn.eq` lowers through the CANONICAL
  // `__any_strict_eq`/`__any_eq` helpers (D4). Must precede the string-operand
  // path below (a `dyn === "s"` mixes dynamic + string). The payload-less
  // STRICT `dyn === null`/`dyn === undefined` cases were already handled by
  // `tryFoldNullCompare`/`tryLowerUndefinedCompare`'s dynamic arms (cheaper
  // exact `tag.test`), so they never reach here. The generic dynamic-operand
  // arm stays byte-inert until S5.P opens its selector; #4208's focused
  // fresh-wrapper producer shares this dispatcher after canonical ToPrimitive.
  const dynEq = tryLowerDynamicEq(expr, op, lhs, rhs, lt, rt, cx);
  if (dynEq !== null) return dynEq;
  if (lt.kind === "dynamic" || rt.kind === "dynamic") {
    if (op === ts.SyntaxKind.PlusToken) {
      const dynL = lt.kind === "dynamic" ? lhs : boxConcreteToDynamic(lhs, lt, expr.left, cx);
      const dynR = rt.kind === "dynamic" ? rhs : boxConcreteToDynamic(rhs, rt, expr.right, cx);
      if (dynL !== null && dynR !== null) {
        const added = cx.builder.emitCall(irRuntimeFuncRef(IR_DYN_ADD_FN), [dynL, dynR], irDynamic());
        // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
        if (added === null) throw new Error(`ir/from-ast: dynamic '+' produced no result in ${cx.funcName}`);
        return added;
      }
    }
    // #2949 S5.3 — dynamic relational: `<`/`>`/`<=`/`>=` where either operand
    // is a boxed-any carrier. Each dynamic operand is ToNumber'd to f64 via
    // `dyn.to_number` (routing to the CANONICAL `__any_to_f64` gc /
    // `__unbox_number` host — D4), then the existing `f64.lt`/`gt`/`le`/`ge`
    // compare runs. SCOPE — numeric-abstract only: a non-f64 concrete operand
    // (and hence the string×string lexicographic case) demotes cleanly. Same
    // byte-inertness as the eq arm — reachable only once the S5.P scan admits
    // dynamic-relational bodies (restricted to a numeric-literal counter-
    // operand, where ARC never takes the both-strings branch).
    const dynRel = tryLowerDynamicRelational(op, lhs, rhs, lt, rt, cx);
    if (dynRel !== null) return dynRel;
    // #2949 S5.5 — dynamic numeric arithmetic: `-`/`*`/`/`/`%` where either
    // operand is a boxed-any carrier. Each dynamic operand is ToNumber'd to
    // f64 via `dyn.to_number` (the S5.3 primitive — canonical `__any_to_f64`
    // gc / `__unbox_number` host, D4), then the EXISTING f64 lowering runs
    // (`f64.sub`/`mul`/`div`; `%` via the shared exact-`__fmod` helper,
    // #2945). This is spec-exact: `-`/`*`/`/`/`%` are pure ToNumber operators
    // (§13.7 / §13.8.2 — ApplyStringOrNumericBinaryOperation with a
    // numeric-only opText never takes the string branch) — unlike `+`, which
    // is ToPrimitive + string-concat-OR-add dispatch and is deliberately
    // EXCLUDED (the Row-7 `proveAdditiveOperand` gate above already demotes
    // an unprovable-`any` `+` to the SAFE legacy `emitAnyAdd`). This is the
    // missing producer for the reduce-style `obj[idx-1]` bodies the #3053 U2
    // measurement flagged (its follow-up 2). Reachable only once the S5.P
    // scan admits dynamic-arithmetic bodies; today the move-only gate
    // rejects them, so this arm is byte-inert.
    const dynArith = tryLowerDynamicArithmetic(op, lhs, rhs, lt, rt, cx);
    if (dynArith !== null) return dynArith;
  }

  // String operand path (slice 1, #1169a) — `+`, `===`, `!==`, `==`, `!=`.
  // Any other operator with a string operand throws so the function falls
  // back to legacy.
  if (lt.kind === "string" || rt.kind === "string") {
    if (lt.kind !== "string" || rt.kind !== "string") {
      // Always a clean demote, never the invariant backstop: one operand is
      // statically string-kinded here, so this is a slice-1 capability gap by
      // construction. The checker-proof gate is deliberately NOT required —
      // a type-erased operand (`a as any` over a string param) reaches this
      // arm with an unprovable source type, and the #3583 assertion unwrap
      // made those bodies claimable (regressed comparison-coercion/
      // string-arithmetic-coercion equivalence tests to hard errors).
      const detail = `ir/from-ast: mixed string/non-string operand for '${ts.tokenToString(op)}' is not in slice 1 (${cx.funcName})`;
      throw new IrUnsupportedError("operand-coercion-unsupported", "build", detail);
    }
    switch (op) {
      case ts.SyntaxKind.PlusToken:
        return cx.builder.emitStringConcat(lhs, rhs, inferStringEncoding(expr, cx));
      case ts.SyntaxKind.EqualsEqualsEqualsToken:
      case ts.SyntaxKind.EqualsEqualsToken:
        return cx.builder.emitStringEq(lhs, rhs, false);
      case ts.SyntaxKind.ExclamationEqualsEqualsToken:
      case ts.SyntaxKind.ExclamationEqualsToken:
        return cx.builder.emitStringEq(lhs, rhs, true);
      // (#3167) String relational operators `<` `>` `<=` `>=` — §7.2.13
      // IsLessThan for two String operands is lexicographic code-unit
      // comparison (NOT locale, NOT numeric). Both operands are statically
      // `IrType.string` here (the mixed-string case already threw above), so
      // the compare is always well-defined: emit a call to the mode-resolved
      // compare helper (`IR_STRING_COMPARE_FN` → native `__str_compare` /
      // host `string_compare`, resolved by `resolveFunc`), which yields a
      // -1/0/1 sign i32, then FOLD the sign to the operator's boolean via a
      // signed i32 compare against 0. This mirrors legacy `emitAnyRelational`'s
      // both-string arm (binary-ops.ts) but stays representation-agnostic in
      // from-ast (the #3156 emit-a-named-call pattern — no new IR node kind).
      // The -1/0/1 sign is total for two strings (never the dynamic path's
      // `2` incomparable sentinel), so `sign {<,>,<=,>=} 0` is exact.
      case ts.SyntaxKind.LessThanToken:
        return emitStringRelational(lhs, rhs, "i32.lt_s", cx);
      case ts.SyntaxKind.GreaterThanToken:
        return emitStringRelational(lhs, rhs, "i32.gt_s", cx);
      case ts.SyntaxKind.LessThanEqualsToken:
        return emitStringRelational(lhs, rhs, "i32.le_s", cx);
      case ts.SyntaxKind.GreaterThanEqualsToken:
        return emitStringRelational(lhs, rhs, "i32.ge_s", cx);
      default:
        // Clean demote (see the mixed-operand arm above): `"a" % "b"`-style
        // shapes are legitimate JS whose coercion slice 1 simply doesn't
        // carry — the legacy dynamic path owns them.
        throw new IrUnsupportedError(
          "operand-coercion-unsupported",
          "build",
          `ir/from-ast: string operator '${ts.tokenToString(op)}' not in slice 1 (${cx.funcName})`,
        );
    }
  }

  const ltVal = asVal(lt);
  const rtVal = asVal(rt);
  if (!ltVal || !rtVal || ltVal.kind !== rtVal.kind) {
    // A representation mismatch is a stable capability gap only when the TS
    // evidence says JavaScript coercion is genuinely required (for example,
    // number-vs-boolean or object-vs-number). If both operands are provably
    // the same primitive, their different IR representations contradict the
    // producer's promise and must remain an invariant backstop. The Set
    // iterator numeric-value path exercises that distinction.
    const detail = `ir/from-ast: Phase 1 requires matching operand types for '${ts.tokenToString(op)}' in ${cx.funcName}`;
    if (checkerProvesBinarySourceCapabilityGap(expr.left, expr.right, cx)) {
      throw new IrUnsupportedError("operand-coercion-unsupported", "build", detail);
    }
    // (#3727) A PACKED operand (`i8`/`i16`) is a stable capability gap, not a
    // broken producer promise. Packed kinds are storage-only — WasmGC has no
    // i8/i16 value type, and the binary emitter rejects one in a value position
    // ("a packed type leaked"). So the IR simply cannot carry, say, a
    // `Uint8Array` element into f64 arithmetic
    // (`for (const v of xs) sum = sum + v`) today, however the operands are
    // coerced. Classifying it `invariant` made that a HARD compile error and
    // took the whole function down; the legacy backend lowers this shape fine.
    // Demote to the unsupported channel so the function falls back instead.
    if (ltVal?.kind === "i8" || ltVal?.kind === "i16" || rtVal?.kind === "i8" || rtVal?.kind === "i16") {
      throw new IrUnsupportedError("operand-coercion-unsupported", "build", detail);
    }
    throw new Error(detail);
  }

  const isF64 = ltVal.kind === "f64";
  const isI32 = ltVal.kind === "i32";

  // #1126 Stage 3 — when both operands are i32-typed, the operands' IR
  // signedness facts (set by Stage 1 when lowering the lattice) decide
  // signed-vs-unsigned ops. Both operands "signed" means:
  //   • bool/compare results (default-signed via `irVal`) → signed cmp
  //   • i32-domain (int32) values → signed cmp, signed shift, signed cast
  // Both operands "unsigned" (from u32-domain values) → unsigned variants.
  // Mixed signedness on the same i32 storage kind widens to signed
  // (the conservative choice — matches `i32.shr_s` semantics for values
  // that fit in [-2^31, 2^31)). The `?? true` mirrors `irTypeEquals`'s
  // default-is-signed convention.
  const lhsSigned = lt.kind === "val" ? (lt.signed ?? true) : true;
  const rhsSigned = rt.kind === "val" ? (rt.signed ?? true) : true;
  const i32Unsigned = isI32 && !lhsSigned && !rhsSigned;

  let binop: IrBinop;
  let resultType: IrType;

  switch (op) {
    case ts.SyntaxKind.PlusToken:
      requireF64(isF64, "+", cx.funcName);
      binop = "f64.add";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.MinusToken:
      requireF64(isF64, "-", cx.funcName);
      binop = "f64.sub";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.AsteriskToken:
      requireF64(isF64, "*", cx.funcName);
      binop = "f64.mul";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.SlashToken:
      requireF64(isF64, "/", cx.funcName);
      binop = "f64.div";
      resultType = irVal({ kind: "f64" });
      break;
    // AOT-proven integer operands lower directly to signed-i64 remainder.
    // Unknown operands get an inline integrality/range guard and the exact
    // `__fmod` helper only in the fallback arm. Negative proof (fractional,
    // non-finite, out-of-i64, or zero-divisor constants) skips speculation.
    case ts.SyntaxKind.PercentToken: {
      requireF64(isF64, "%", cx.funcName);
      const rangeContext = cx.oracle
        ? { oracle: cx.oracle }
        : cx.checker
          ? { oracle: new TsCheckerOracle(cx.checker) }
          : undefined;
      return emitNumberRemainder(
        cx.builder,
        lhs,
        rhs,
        remainderFastPathPlan(rangeContext, expr.left, expr.right),
        fmodRefFor(expr.right, cx.checker, cx.oracle),
      );
    }
    // #1126 Stage 3 — magnitude compares accept f64 OR i32 operands.
    // i32 operands emit native `i32.{lt,le,gt,ge}_{s,u}` based on
    // signedness; f64 keeps the legacy `f64.lt` etc. The result is
    // always i32 (bool), boolean-BRANDED since #4503 (`${x > 0}` vs `${1}`).
    case ts.SyntaxKind.LessThanToken:
      if (!isF64 && !isI32) requireF64(isF64, "<", cx.funcName);
      binop = isF64 ? "f64.lt" : i32Unsigned ? "i32.lt_u" : "i32.lt_s";
      resultType = IR_BOOL;
      break;
    case ts.SyntaxKind.LessThanEqualsToken:
      if (!isF64 && !isI32) requireF64(isF64, "<=", cx.funcName);
      binop = isF64 ? "f64.le" : i32Unsigned ? "i32.le_u" : "i32.le_s";
      resultType = IR_BOOL;
      break;
    case ts.SyntaxKind.GreaterThanToken:
      if (!isF64 && !isI32) requireF64(isF64, ">", cx.funcName);
      binop = isF64 ? "f64.gt" : i32Unsigned ? "i32.gt_u" : "i32.gt_s";
      resultType = IR_BOOL;
      break;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      if (!isF64 && !isI32) requireF64(isF64, ">=", cx.funcName);
      binop = isF64 ? "f64.ge" : i32Unsigned ? "i32.ge_u" : "i32.ge_s";
      resultType = IR_BOOL;
      break;
    case ts.SyntaxKind.EqualsEqualsEqualsToken:
    case ts.SyntaxKind.EqualsEqualsToken:
      // Slice 14 (#1228) — externref operands need ref-equality semantics
      // that the IR doesn't model (no `ref.eq` between externrefs in
      // WasmGC). Throw cleanly so the function falls back to legacy
      // rather than emitting an invalid `i32.eq` on externref operands.
      if (!isF64 && !isI32) {
        demoteToLegacy(
          "operand-coercion-unsupported",
          `ir/from-ast: '${ts.tokenToString(op)}' on ${ltVal.kind} operands not supported in IR (${cx.funcName})`,
        );
      }
      binop = isF64 ? "f64.eq" : "i32.eq";
      resultType = IR_BOOL;
      break;
    case ts.SyntaxKind.ExclamationEqualsEqualsToken:
    case ts.SyntaxKind.ExclamationEqualsToken:
      // Slice 14 (#1228) — same fallback rationale as `===`/`==` above.
      if (!isF64 && !isI32) {
        demoteToLegacy(
          "operand-coercion-unsupported",
          `ir/from-ast: '${ts.tokenToString(op)}' on ${ltVal.kind} operands not supported in IR (${cx.funcName})`,
        );
      }
      binop = isF64 ? "f64.ne" : "i32.ne";
      resultType = IR_BOOL;
      break;
    // `&&` / `||` are intercepted at the top of `lowerBinary` (#1820) and
    // lowered to a short-circuiting `IrInstrIf` before the eager operand
    // lowering above — they never reach this switch.
    // Slice 11 (#1169n) — bitwise ops on f64 operands. Each lowers to
    // ToInt32 + i32 op + convert back; the lowerer's `case "binary"`
    // arm dispatches on the `js.*` prefix to emit the multi-instr
    // sequence using a per-function scratch local pair. Result is
    // always f64.
    //
    // #1126 Stage 3 — also accept i32 operands. The lowerer's fast path
    // (in `lower.ts:case "binary"`) detects two i32 operands and emits
    // the native `i32.*` op directly, skipping the ToInt32 dance. The
    // result type stays f64 here so callers / returns / arithmetic
    // consumers don't need to be aware of an i32-narrowed value — the
    // lowerer tails the fast path with `f64.convert_i32_*`. Chained
    // bitwise composition (where the f64 round-trip could be skipped)
    // is left for a future Stage; the per-op fast path already covers
    // the cost-dominant cases (bool|bool, bool&bool, compare-result
    // bitwise reductions).
    case ts.SyntaxKind.AmpersandToken:
      if (!isF64 && !isI32) requireF64(isF64, "&", cx.funcName);
      binop = "js.bitand";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.BarToken:
      if (!isF64 && !isI32) requireF64(isF64, "|", cx.funcName);
      binop = "js.bitor";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.CaretToken:
      if (!isF64 && !isI32) requireF64(isF64, "^", cx.funcName);
      binop = "js.bitxor";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.LessThanLessThanToken:
      if (!isF64 && !isI32) requireF64(isF64, "<<", cx.funcName);
      binop = "js.shl";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.GreaterThanGreaterThanToken:
      if (!isF64 && !isI32) requireF64(isF64, ">>", cx.funcName);
      binop = "js.shr_s";
      resultType = irVal({ kind: "f64" });
      break;
    case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
      if (!isF64 && !isI32) requireF64(isF64, ">>>", cx.funcName);
      binop = "js.shr_u";
      resultType = irVal({ kind: "f64" });
      break;
    // Slice 11 (#1169n) — `%`, `**`, `in`, `instanceof` are intercepted by
    // the early-fallback check at the top of `lowerBinary`; `??` is handled
    // by `lowerNullish`. If any reach here the early-dispatch is missing.
    default:
      demoteToLegacy(
        "operand-coercion-unsupported",
        `ir/from-ast: unsupported binary operator ${ts.tokenToString(op)} in ${cx.funcName}`,
      );
  }

  return cx.builder.emitBinary(binop, lhs, rhs, resultType);
}

/**
 * Lower `lhs ?? rhs` (nullish coalescing) IR-natively.
 *
 * Semantics: evaluate `lhs`; if it is `null` OR `undefined`, the result is
 * `rhs`, else `lhs`. IR Phase 1 has no nullable-union ValType, so the only
 * representation that can carry "a value that might be null" is a Wasm
 * reference (externref / ref_null). We therefore lower only when:
 *   - `lhs` lowers to a reference-shaped IrType (extern / externref / ref_null),
 *     so `ref.is_null` is a valid test; and
 *   - `rhs` lowers to the SAME reference type, so both `emitIfElse` arms agree
 *     on the carrier Wasm type (no union to widen into).
 *
 * Anything else (numeric/string lhs, mismatched arm types) throws clean
 * fallback to legacy — exactly like the optional-chaining null-arm guard in
 * `lowerOptionalExternPropertyAccess`.
 *
 * Note on `undefined`: a reference-shaped lhs that is JS-`undefined` is
 * represented at the Wasm level as a null externref (the host shim maps
 * `undefined ↔ ref.null.extern`), so the single `ref.is_null` test covers
 * both the `null` and `undefined` cases the spec requires.
 */
function lowerNullish(expr: ts.BinaryExpression, cx: LowerCtx, hint: IrType): IrValueId {
  // Lower the lhs with the caller's hint so a reference-shaped consumer
  // (e.g. an externref slot / return) propagates the right carrier type.
  const lhs = lowerExpr(expr.left, cx, hint);
  const lhsType = cx.builder.typeOf(lhs);
  const lhsVal = asVal(lhsType);
  const lhsIsRef =
    lhsType.kind === "extern" || (lhsVal !== null && (lhsVal.kind === "externref" || lhsVal.kind === "ref_null"));
  if (!lhsIsRef) {
    demoteToLegacy(
      "nullish-value-unsupported",
      `ir/from-ast: '??' on non-reference lhs (${describeIrType(lhsType)}) is not supported in IR (${cx.funcName})`,
    );
  }

  // The result carrier type is the lhs reference type. Both arms must land
  // on it: the rhs is lowered with `lhsType` as its hint and must agree.
  const resultType: IrType = lhsType;

  const cond = cx.builder.emitRefIsNull(lhs);

  // then-arm (lhs IS null/undefined) → evaluate and yield rhs.
  const skippedScope = new Map(cx.scope);
  const rhsCx: LowerCtx = { ...cx, scope: new Map(skippedScope) };
  let thenValue!: IrValueId;
  const thenBody = cx.builder.collectBodyInstrs(() => {
    thenValue = lowerExpr(expr.right, rhsCx, resultType);
  });
  const rhsType = cx.builder.typeOf(thenValue);
  if (!irTypeEquals(rhsType, resultType)) {
    demoteToLegacy(
      "nullish-value-unsupported",
      `ir/from-ast: '??' arm type mismatch (lhs ${describeIrType(resultType)} vs rhs ${describeIrType(rhsType)}) is not supported in IR (${cx.funcName})`,
    );
  }
  joinScopeStringEncodingFacts(cx.scope, [rhsCx.scope, skippedScope]);

  // else-arm (lhs is non-null) → yield `lhs` directly. The lowerer records
  // `elseValue` as a cross-block use (lower.ts:479 `recordUse(elseValue, -1)`)
  // so the outer `lhs` SSA value is pre-materialized into a Wasm local before
  // the `if`, and the empty else arm just `local.get`s it as its carrier.
  return cx.builder.emitIfElse({
    cond,
    then: thenBody,
    thenValue,
    else: [],
    elseValue: lhs,
    resultType,
  });
}

/**
 * #1820 — short-circuiting lowering for `&&` / `||`.
 *
 * The previous lowering eagerly evaluated both operands and combined them with
 * `i32.and` / `i32.or`, running the right operand unconditionally. JS requires
 * the right operand to be evaluated only when the left does not already decide
 * the result:
 *   - `a && b` → if `a` is truthy yield `b`, else yield `a` (the falsy value).
 *   - `a || b` → if `a` is truthy yield `a`, else yield `b`.
 *
 * We keep the existing IR scope (both operands `i32`/bool); anything else
 * throws clean fallback to legacy, exactly as the old `requireI32` did. The
 * right operand is lowered into its own body buffer (only the taken branch
 * runs it) and the two arms are combined with a structured `IrInstrIf`.
 */
function lowerLogicalAndOr(expr: ts.BinaryExpression, op: ts.SyntaxKind, cx: LowerCtx): IrValueId {
  const isAnd = op === ts.SyntaxKind.AmpersandAmpersandToken;
  const opName = isAnd ? "&&" : "||";

  const rawLhs = lowerExpr(expr.left, cx, irVal({ kind: "i32" }));
  const lhsType = cx.builder.typeOf(rawLhs);
  const lhs =
    lhsType.kind === "dynamic" ? cx.builder.emitDynTruthy(rawLhs) : asVal(lhsType)?.kind === "i32" ? rawLhs : null;
  if (lhs === null) {
    demoteToLegacy(
      "logical-value-unsupported",
      `ir/from-ast: operator '${opName}' requires bool operands in ${cx.funcName}`,
    );
  }

  const resultType: IrType = irVal({ kind: "i32" });

  // Lower the right operand into its own buffer so it executes only on the
  // branch that needs it.
  const skippedScope = new Map(cx.scope);
  const rhsCx: LowerCtx = { ...cx, scope: new Map(skippedScope) };
  let rhs!: IrValueId;
  const rhsBody = cx.builder.collectBodyInstrs(() => {
    const rawRhs = lowerExpr(expr.right, rhsCx, resultType);
    const rhsType = cx.builder.typeOf(rawRhs);
    if (rhsType.kind === "dynamic") {
      rhs = cx.builder.emitDynTruthy(rawRhs);
    } else if (asVal(rhsType)?.kind === "i32") {
      rhs = rawRhs;
    } else {
      demoteToLegacy(
        "logical-value-unsupported",
        `ir/from-ast: operator '${opName}' requires bool operands in ${cx.funcName}`,
      );
    }
  });
  if (asVal(cx.builder.typeOf(rhs))?.kind !== "i32") {
    demoteToLegacy(
      "logical-value-unsupported",
      `ir/from-ast: operator '${opName}' requires bool operands in ${cx.funcName}`,
    );
  }
  joinScopeStringEncodingFacts(cx.scope, [rhsCx.scope, skippedScope]);

  // `cond = lhs`. For `&&`, the rhs is the then-arm (lhs truthy) and lhs is the
  // else-arm value. For `||`, lhs is the then-arm value and rhs is the
  // else-arm. The empty arm yields the already-materialized `lhs` (the lowerer
  // records it as a cross-block use, like `lowerNullish`'s else arm).
  if (isAnd) {
    return cx.builder.emitIfElse({
      cond: lhs,
      then: rhsBody,
      thenValue: rhs,
      else: [],
      elseValue: lhs,
      resultType,
    });
  }
  return cx.builder.emitIfElse({
    cond: lhs,
    then: [],
    thenValue: lhs,
    else: rhsBody,
    elseValue: rhs,
    resultType,
  });
}

function requireF64(isF64: boolean, op: string, fn: string): void {
  if (!isF64)
    demoteToLegacy("operand-coercion-unsupported", `ir/from-ast: operator '${op}' requires number operands in ${fn}`);
}

function typeOfValue(v: IrValueId, cx: LowerCtx): IrType {
  return cx.builder.typeOf(v);
}

/**
 * Compile-time fold for `expr === null` / `expr !== null` / `expr == null` /
 * `expr != null` when the non-null operand has a non-nullable IR type.
 *
 * Slice 1 (#1169a) has no nullable IR types yet (no `nullable union`,
 * no `boxed-null`), so any operand we can lower is provably non-null:
 *   - `expr === null`  → `false`
 *   - `expr !== null`  → `true`
 *
 * The non-null operand IS lowered (rather than skipped) so its side
 * effects are preserved; the IR DCE pass strips the unused value when
 * the producing instructions are pure. If the operand's IR type is
 * `boxed` (deferred to a later slice), we return `null` so the fold
 * doesn't fire and the caller's standard binary path throws cleanly,
 * letting the function fall back to legacy.
 *
 * Returns `null` when this isn't a `null`-compare (so the caller
 * proceeds with the normal lowering).
 */
/**
 * (#2856 C3) Lower a STRICT undefined-compare — `<expr> !== undefined` /
 * `<expr> === undefined` (`undefined` as a free identifier, not shadowed),
 * plus the exact side-effect-free `void 0` spelling emitted by Acorn.
 * Returns null when the expression isn't that shape (caller proceeds with
 * the normal lowering).
 *
 * Dispatch by the non-undefined operand's IrType:
 *   - externref-shaped (externref val / extern class / callable /
 *     host-mode string) —
 *     the runtime CAN hold the host `undefined`: emit the same
 *     `__extern_is_undefined(v)` check legacy emits for this shape (import
 *     registered by legacy's own lowering of the identical site in the
 *     dual-compile model), `i32.eqz`-inverted for `!==`.
 *   - representations that can never hold the JS `undefined` VALUE —
 *     unboxed f64/i32 scalars and WasmGC refs (vecs, classes, objects,
 *     closures, native strings; STRICT equality means even a null ref
 *     compares false against undefined): constant-fold, keeping the
 *     operand's side effects (DCE drops the value only when pure).
 *   - anything else (boxed / union / dynamic) — clean demote to legacy.
 *
 * LOOSE `==`/`!=` never reach here (selector rejects them against
 * `undefined`): `null == undefined` is true, so nullable-ref operands would
 * need a runtime null check this slice doesn't emit.
 */
function tryLowerUndefinedCompare(expr: ts.BinaryExpression, op: ts.SyntaxKind, cx: LowerCtx): IrValueId | null {
  const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!isStrictEq && !isStrictNeq) return null;
  const isUndefinedValue = (e: ts.Expression): boolean =>
    (ts.isIdentifier(e) && e.text === "undefined" && !cx.scope.has("undefined")) ||
    (ts.isVoidExpression(e) && ts.isNumericLiteral(e.expression) && Number(e.expression.text) === 0);
  const leftU = isUndefinedValue(expr.left);
  const rightU = isUndefinedValue(expr.right);
  if (!leftU && !rightU) return null;
  if (leftU && rightU) {
    // `undefined === undefined` → true / `!==` → false.
    return cx.builder.emitConst({ kind: "bool", value: isStrictEq }, IR_BOOL);
  }
  const other = leftU ? expr.right : expr.left;
  // A typed array index has a non-undefined TypeScript element type even when
  // the runtime index is out of bounds. Until the IR carries first-class
  // `undefined` through a numeric-vector read, only a proven in-bounds access
  // may participate in the never-undefined fold below. Unproven reads stay on
  // the direct SAFE path instead of folding `a[i] === undefined` to false.
  if (ts.isElementAccessExpression(other) && !isProvenInBoundsIr(other, cx)) {
    throw new IrUnsupportedError(
      "nullish-value-unsupported",
      "build",
      `ir/from-ast: unproven indexed read cannot be compared with undefined (${cx.funcName})`,
    );
  }
  const v = lowerExpr(other, cx, irVal({ kind: "externref" }));
  const t = cx.builder.typeOf(v);
  // #2949 S5.2 — a dynamic (boxed-any) operand: strict `=== undefined` /
  // `!== undefined` is the exact Undefined-partition tag test (cheaper and
  // more precise than boxing `undefined` into the carrier + the general
  // helper). Only strict ops reach here (`isStrictEq`/`isStrictNeq` gate).
  if (t.kind === "dynamic") {
    const flag = cx.builder.emitTagTest(v, JS_TAG_IDS.Undefined);
    return isStrictNeq ? cx.builder.emitUnary("i32.eqz", flag, IR_BOOL) : flag;
  }
  const tv = asVal(t);
  // (#2955 slice 3) The string arm asks the resolver-owned rep predicate
  // (`stringIsExternref`) instead of reading `nativeStrings` directly. The
  // `=== true` polarity deliberately preserves the legacy resolver-absent
  // default of this site's old `nativeStrings?.() === false` read: no
  // resolver → NOT externref-shaped → fall to the fold path / demote.
  const externrefShaped =
    (tv !== null && tv.kind === "externref") ||
    t.kind === "extern" ||
    t.kind === "callable" ||
    (t.kind === "string" && cx.resolver?.stringIsExternref?.() === true);
  if (externrefShaped) {
    // (#4461) Host-free lanes register `__extern_is_undefined` as a real Wasm
    // function, and `undefined` there is the #2106 non-null singleton, so the
    // predicate is load-bearing rather than an alias for `ref.is_null`. Asking
    // for the `env` import instead would put a host import into a standalone
    // module — the exact failure this arm previously had no way to avoid,
    // because no claimable standalone shape reached it before native `$Map`
    // reads did.
    const provider = cx.resolver?.externIsUndefinedIsNative?.()
      ? irRuntimeFuncRef("__extern_is_undefined")
      : irImportFuncRef("env", "__extern_is_undefined");
    const flag = cx.builder.emitCall(provider, [v], irVal({ kind: "i32" }));
    if (flag === null) {
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(`ir/from-ast: __extern_is_undefined produced no result in ${cx.funcName}`);
    }
    return isStrictNeq ? cx.builder.emitUnary("i32.eqz", flag, IR_BOOL) : flag;
  }
  // Never-undefined representations: fold — but ONLY when the operand's TS
  // static type proves the VALUE cannot be `undefined`. The Wasm-level rep
  // alone is not enough: the IR erases `void x` (static type `undefined`)
  // into an f64 NaN, so a rep-based fold would answer `void x === undefined`
  // with false where JS says true (caught by
  // tests/equivalence/logical-conditional-identity.test.ts). Types that
  // include undefined/void/any/unknown demote to legacy, which tracks
  // undefined-ness through its own lowering.
  const staticTypeMayBeUndefined = (): boolean => {
    if (!cx.checker) return true; // no checker — cannot prove; demote
    const tsType = cx.checker.getTypeAtLocation(other);
    const UNDEF_LIKE = ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown;
    if (tsType.flags & UNDEF_LIKE) return true;
    if (tsType.isUnion() && tsType.types.some((m) => (m.flags & UNDEF_LIKE) !== 0)) return true;
    return false;
  };
  const neverUndefinedRep =
    (tv !== null && (tv.kind === "f64" || tv.kind === "i32" || tv.kind === "ref" || tv.kind === "ref_null")) ||
    t.kind === "class" ||
    t.kind === "object" ||
    t.kind === "closure" ||
    t.kind === "string"; // native-strings mode only (host mode took the branch above)
  if (neverUndefinedRep && !staticTypeMayBeUndefined()) {
    return cx.builder.emitConst({ kind: "bool", value: isStrictNeq }, IR_BOOL);
  }
  throw new IrUnsupportedError(
    "nullish-value-unsupported",
    "build",
    `ir/from-ast: undefined-compare on ${describeIrType(t)} not in IR scope (${cx.funcName})`,
  );
}

function tryFoldNullCompare(expr: ts.BinaryExpression, op: ts.SyntaxKind, cx: LowerCtx): IrValueId | null {
  const isEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isEq && !isNeq) return null;

  let other: ts.Expression | null = null;
  if (expr.left.kind === ts.SyntaxKind.NullKeyword) other = expr.right;
  else if (expr.right.kind === ts.SyntaxKind.NullKeyword) other = expr.left;
  else return null;

  // `null === undefined` is intercepted by the null fold before the strict
  // undefined lowering gets a chance to recognize the ambient identifier.
  // Phase 1 has no first-class undefined value to materialize here, so record
  // the precise representation gap rather than recursing into the identifier
  // arm and surfacing an "identifier not in scope" invariant.
  if (ts.isIdentifier(other) && other.text === "undefined" && !cx.scope.has("undefined")) {
    throw new IrUnsupportedError(
      "nullish-value-unsupported",
      "build",
      `ir/from-ast: null/undefined comparison has no first-class undefined representation (${cx.funcName})`,
    );
  }

  // Lower the non-null side to learn its IrType AND keep any side effects
  // emitted (the IR DCE pass drops the unused result if the producing
  // instructions are pure).
  const v = lowerExpr(other, cx, irVal({ kind: "f64" }));
  const otherType = cx.builder.typeOf(v);

  // #2949 S5.2 — a dynamic (boxed-any) operand: STRICT `=== null` / `!== null`
  // is the exact Null-partition tag test. LOOSE `== null` / `!= null` matches
  // BOTH null and undefined (§7.2.15) — NOT a single tag test — so it is left
  // to legacy (return null → demote), NOT folded.
  if (otherType.kind === "dynamic") {
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      const flag = cx.builder.emitTagTest(v, JS_TAG_IDS.Null);
      return isNeq ? cx.builder.emitUnary("i32.eqz", flag, IR_BOOL) : flag;
    }
    return null;
  }

  // Slice 1 only knows non-nullable types: `val<...>`, `string`, and
  // unions whose members are non-null (V1 unions only carry f64/i32).
  // `boxed` is deferred; bail so the caller errors cleanly.
  if (otherType.kind === "boxed") return null;
  // Capability C: branded extern values are externref-backed and nullable.
  // Strict null equality is exactly `ref.is_null`; loose equality would also
  // have to recognize the host `undefined` sentinel, so keep that on legacy.
  if (otherType.kind === "extern") {
    if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      return null;
    }
    const flag = cx.builder.emitRefIsNull(v);
    return isNeq ? cx.builder.emitUnary("i32.eqz", flag, IR_BOOL) : flag;
  }
  // #1981 / #3214: `class`, `object`, `closure`, and boundary `callable`
  // IrTypes are reference-shaped. A class/object/closure/callable value can
  // be `null` at runtime (e.g. a host call passing `null` for a class-typed
  // parameter), so the defensive `=== null` / `!== null` guard must NOT be
  // folded to a constant — folding it deletes the guard, which either returns
  // the wrong value (`=== null` → false) or dereferences null (`!== null` →
  // true, then `p.v` traps). Bail so the caller falls back to legacy, which
  // emits a runtime `ref.is_null` check. The slice-1 fold is only sound for
  // statically non-nullable kinds.
  if (
    otherType.kind === "class" ||
    otherType.kind === "object" ||
    otherType.kind === "closure" ||
    otherType.kind === "callable"
  ) {
    return null;
  }
  // #2713 — a `string` IrType lowers to a nullable ref shape: host-strings
  // backend → `externref`, native-strings backend → `(ref null $AnyString)`.
  // A host caller can pass `null` for a `string`-typed parameter (JS has no
  // type enforcement), so the slice-1 "string is provably non-null"
  // assumption is unsound. Folding `s === null` → `false` / `s !== null` →
  // `true` then silently miscompiles the defensive guard (legacy emits the
  // correct runtime `ref.is_null` check, returning the spec result). Bail so
  // the caller falls back to legacy — same fix class as the #1981 class/
  // object/closure arm above, left open for the string arm.
  if (otherType.kind === "string") return null;
  // A plain val<externref> uses the same strict runtime check.
  const otherVal = asVal(otherType);
  if (otherVal?.kind === "externref") {
    if (op !== ts.SyntaxKind.EqualsEqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsEqualsToken) {
      return null;
    }
    const flag = cx.builder.emitRefIsNull(v);
    return isNeq ? cx.builder.emitUnary("i32.eqz", flag, IR_BOOL) : flag;
  }
  if (otherVal?.kind === "ref_null") {
    return null;
  }

  return cx.builder.emitConst({ kind: "bool", value: isNeq }, IR_BOOL);
}

/**
 * #2949 S5.2 / #4208 S4 — lower equality through the canonical dynamic
 * carrier. The focused wrapper producer first performs Object→ToPrimitive;
 * otherwise at least one operand must already be dynamic. Returns `null`
 * (clean demote) for an unboxable concrete operand or non-equality operator.
 */
function tryLowerDynamicEq(
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
  lhs: IrValueId,
  rhs: IrValueId,
  lt: IrType,
  rt: IrType,
  cx: LowerCtx,
): IrValueId | null {
  const wrapperLooseEq = tryLowerPrimitiveWrapperLooseEquality(expr, op, lhs, rhs, lt, rt, cx);
  if (wrapperLooseEq !== null) return wrapperLooseEq;
  if (lt.kind !== "dynamic" && rt.kind !== "dynamic") return null;
  const loose = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  const strict = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!loose && !strict) return null;
  const negate = op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;

  const dynL = lt.kind === "dynamic" ? lhs : boxConcreteToDynamic(lhs, lt, expr.left, cx);
  if (dynL === null) return null;
  const dynR = rt.kind === "dynamic" ? rhs : boxConcreteToDynamic(rhs, rt, expr.right, cx);
  if (dynR === null) return null;
  return cx.builder.emitDynEq(dynL, dynR, { loose, negate });
}

/**
 * #4208 S4 — lower the selector-certified fresh-wrapper loose equality.
 * This is intentionally an AST-shape producer for a canonical IR/runtime
 * sequence, not an AST-computed answer: the wrapper is allocated, then
 * `__to_primitive` observes its real [[PrimitiveValue]], then `dyn.eq` owns
 * Boolean/Number/String coercion exactly as it does for other dynamic values.
 * Both source operands were evaluated in order before this helper runs. The
 * selector restricts this to the non-fast externref carrier, so the primitive
 * result crosses `box` without a representation guess; wrapper-vs-wrapper and
 * wrapper-vs-string retain their legacy paths.
 */
function tryLowerPrimitiveWrapperLooseEquality(
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
  lhs: IrValueId,
  rhs: IrValueId,
  lt: IrType,
  rt: IrType,
  cx: LowerCtx,
): IrValueId | null {
  if (op !== ts.SyntaxKind.EqualsEqualsToken && op !== ts.SyntaxKind.ExclamationEqualsToken) return null;
  const leftKind = primitiveWrapperConstructorName(expr.left, cx);
  const rightKind = primitiveWrapperConstructorName(expr.right, cx);
  if ((leftKind === null) === (rightKind === null)) return null;
  if (cx.resolver?.dynamicCarrierIsExternref?.() !== true) {
    demoteToLegacy(
      "operand-coercion-unsupported",
      `ir/from-ast: primitive-wrapper loose equality requires the externref dynamic carrier (${cx.funcName})`,
    );
  }

  const wrapperOnLeft = leftKind !== null;
  const wrapperKind = (leftKind ?? rightKind)!;
  const wrapper = wrapperOnLeft ? lhs : rhs;
  const wrapperType = wrapperOnLeft ? lt : rt;
  const primitiveOperand = wrapperOnLeft ? rhs : lhs;
  const primitiveType = wrapperOnLeft ? rt : lt;
  const primitiveExpression = wrapperOnLeft ? expr.right : expr.left;
  if (wrapperType.kind !== "extern" || wrapperType.className !== "Object") {
    // invariant (producer-promise): the lowering just invoked promised this shape — #4502.
    throw new Error(`ir/from-ast: primitive wrapper did not lower to extern:Object in ${cx.funcName}`);
  }

  const externref = irVal({ kind: "externref" });
  const hint = cx.builder.emitConst({ kind: "null", ty: externref }, externref);
  const primitive = cx.builder.emitCall(irRuntimeFuncRef("__to_primitive"), [wrapper, hint], externref);
  if (primitive === null) {
    // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
    throw new Error(`ir/from-ast: __to_primitive produced no value in ${cx.funcName}`);
  }
  const primitiveTag =
    wrapperKind === "Boolean"
      ? JS_TAG_IDS.Boolean
      : wrapperKind === "Number"
        ? JS_TAG_IDS.NumberF64
        : JS_TAG_IDS.String;
  const wrapperDynamic = cx.builder.emitBox(primitive, irDynamic(primitiveTag));
  const otherDynamic = boxConcreteToDynamic(primitiveOperand, primitiveType, primitiveExpression, cx);
  if (otherDynamic === null) {
    demoteToLegacy(
      "operand-coercion-unsupported",
      `ir/from-ast: wrapper loose-equality primitive operand was not boxable in ${cx.funcName}`,
    );
  }
  return cx.builder.emitDynEq(
    wrapperOnLeft ? wrapperDynamic : otherDynamic,
    wrapperOnLeft ? otherDynamic : wrapperDynamic,
    { loose: true, negate: op === ts.SyntaxKind.ExclamationEqualsToken },
  );
}

/**
 * #2949 S5.2 — box a CONCRETE equality operand into the boxed-any carrier, tag-
 * refined from its literal kind / IR type. Returns `null` when the operand has
 * no sound carrier box in this slice, so the caller demotes cleanly rather than
 * mis-tagging (e.g. a boxed boolean must carry tag-4, never the number default).
 */
function boxConcreteToDynamic(v: IrValueId, t: IrType, operand: ts.Expression, cx: LowerCtx): IrValueId | null {
  if (t.kind === "string") {
    return cx.builder.emitBox(v, irDynamic(JS_TAG_IDS.String));
  }
  const tv = asVal(t);
  if (!tv) return null;
  // Proven boolean i32 → tag-4 box; without the refinement the i32 would box
  // as a NUMBER and recursive boolean helpers would lose their value family at
  // the dynamic return boundary.
  if (tv.kind === "i32" && expressionIsDefinitelyBoolean(operand)) {
    return cx.builder.emitBox(v, irDynamic(JS_TAG_IDS.Boolean));
  }
  // Numeric literal or an f64-typed value → number box (f64 hosts only the
  // number brand).
  if (tv.kind === "f64" || ts.isNumericLiteral(operand)) {
    return cx.builder.emitBox(v, irDynamic(JS_TAG_IDS.NumberF64));
  }
  // A bare non-literal `i32` is number-vs-boolean-ambiguous with no cheap proof
  // here — demote rather than risk a wrong tag. S5.P can refine with the
  // checker (isProvablyBoolean) when it opens the scan.
  return null;
}

function expressionIsDefinitelyBoolean(expression: ts.Expression): boolean {
  const candidate = peelParensExpr(expression);
  if (candidate.kind === ts.SyntaxKind.TrueKeyword || candidate.kind === ts.SyntaxKind.FalseKeyword) return true;
  if (ts.isPrefixUnaryExpression(candidate) && candidate.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isBinaryExpression(candidate)) {
    const op = candidate.operatorToken.kind;
    return (
      op === ts.SyntaxKind.LessThanToken ||
      op === ts.SyntaxKind.LessThanEqualsToken ||
      op === ts.SyntaxKind.GreaterThanToken ||
      op === ts.SyntaxKind.GreaterThanEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsToken ||
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      op === ts.SyntaxKind.InstanceOfKeyword ||
      op === ts.SyntaxKind.InKeyword ||
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken
    );
  }
  if (ts.isConditionalExpression(candidate)) {
    return expressionIsDefinitelyBoolean(candidate.whenTrue) && expressionIsDefinitelyBoolean(candidate.whenFalse);
  }
  return false;
}

/**
 * #2949 S5.3 — lower `dyn < x` / `dyn > x` / `dyn <= x` / `dyn >= x` (either or
 * both operands dynamic) as a NUMERIC-ABSTRACT relational compare: each dynamic
 * operand is ToNumber'd to `f64` via `dyn.to_number`, then the existing
 * `f64.lt`/`gt`/`le`/`ge` compare (result `i32`) runs. Returns `null` (clean
 * demote) for a non-relational operator, or for a concrete operand this slice
 * cannot feed the f64 compare (see {@link relOperandToF64}) — including the
 * string×string lexicographic case, which is DEFERRED (a boxed-string operand
 * ToNumbers to NaN in gc / `Number(s)` in host: spec-correct ONLY against a
 * numeric counter-operand, which is why the S5.P scan restricts admission to a
 * numeric-literal counter-operand).
 */
function tryLowerDynamicRelational(
  op: ts.SyntaxKind,
  lhs: IrValueId,
  rhs: IrValueId,
  lt: IrType,
  rt: IrType,
  cx: LowerCtx,
): IrValueId | null {
  let binop: IrBinop;
  let runtimeName: string;
  switch (op) {
    case ts.SyntaxKind.LessThanToken:
      binop = "f64.lt";
      runtimeName = IR_DYN_LT_FN;
      break;
    case ts.SyntaxKind.LessThanEqualsToken:
      binop = "f64.le";
      runtimeName = IR_DYN_LE_FN;
      break;
    case ts.SyntaxKind.GreaterThanToken:
      binop = "f64.gt";
      runtimeName = IR_DYN_GT_FN;
      break;
    case ts.SyntaxKind.GreaterThanEqualsToken:
      binop = "f64.ge";
      runtimeName = IR_DYN_GE_FN;
      break;
    default:
      return null;
  }
  if (lt.kind === "dynamic" && rt.kind === "dynamic") {
    const result = cx.builder.emitCall(irRuntimeFuncRef(runtimeName), [lhs, rhs], irVal({ kind: "i32" }));
    if (result === null) {
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(`ir/from-ast: dynamic relational helper ${runtimeName} produced no result in ${cx.funcName}`);
    }
    return result;
  }
  const lf = relOperandToF64(lhs, lt, cx);
  if (lf === null) return null;
  const rf = relOperandToF64(rhs, rt, cx);
  if (rf === null) return null;
  return cx.builder.emitBinary(binop, lf, rf, irVal({ kind: "i32" }));
}

/**
 * #2949 S5.3/S5.5 — coerce ONE numeric-abstract operand to `f64` (shared by the
 * relational compare and the numeric-arithmetic arm): a dynamic carrier
 * ToNumbers via `dyn.to_number`; a concrete `f64` is used as-is. Any other
 * concrete kind (i32/ref/string) returns `null` so the caller demotes cleanly —
 * these slices only convert the dynamic side, and add no i32/string→number
 * coercion (numeric literals lower to `f64` under the f64 hint the operands
 * were lowered with, so `dyn > 0` / `dyn - 1` are covered).
 */
function relOperandToF64(v: IrValueId, t: IrType, cx: LowerCtx): IrValueId | null {
  if (t.kind === "dynamic") return cx.builder.emitDynToNumber(v);
  const tv = asVal(t);
  if (tv && tv.kind === "f64") return v;
  return null;
}

/**
 * #2949 S5.5 — lower `dyn - x` / `dyn * x` / `dyn / x` / `dyn % x` (either or
 * both operands dynamic) as NUMERIC arithmetic: each dynamic operand is
 * ToNumber'd to `f64` via `dyn.to_number` (canonical `__any_to_f64` gc /
 * `__unbox_number` host — D4, the same primitive S5.3's relational arm uses),
 * then the existing f64 op runs (`f64.sub`/`mul`/`div`; `%` calls the shared
 * exact-`__fmod` helper — #2945/#2056, the SAME helper legacy `emitModulo`
 * emits, so every fmod edge — `x % 0` → NaN, `-0 % x` → -0, `x % Inf` → x —
 * agrees bit-for-bit). Returns `null` (clean demote) for any other operator, or
 * for a concrete operand this slice cannot feed the f64 op (see
 * {@link relOperandToF64}).
 *
 * These four operators are PURE ToNumber operators per §13.7 (multiplicative)
 * and §13.8.2 (subtraction): ApplyStringOrNumericBinaryOperation with a
 * numeric-only opText never takes a string branch, so — unlike relational
 * (string×string lexicographic deferred) and unlike `+` (concat dispatch,
 * excluded) — the ToNumber lowering is spec-complete for EVERY runtime operand
 * partition (string operands ToNumber per §7.1.4: host `Number(v)`; the gc
 * boxed-string→f64-slot gap matches legacy `__any_sub`-family behavior and is
 * the documented S5.3 deferred imperfection). BigInt operands are out of scope
 * (the IR claims no BigInt-typed shapes).
 */
function tryLowerDynamicArithmetic(
  op: ts.SyntaxKind,
  lhs: IrValueId,
  rhs: IrValueId,
  lt: IrType,
  rt: IrType,
  cx: LowerCtx,
): IrValueId | null {
  let binop: IrBinop | null;
  switch (op) {
    case ts.SyntaxKind.MinusToken:
      binop = "f64.sub";
      break;
    case ts.SyntaxKind.AsteriskToken:
      binop = "f64.mul";
      break;
    case ts.SyntaxKind.SlashToken:
      binop = "f64.div";
      break;
    case ts.SyntaxKind.PercentToken:
      binop = null; // routed through the __fmod helper call below
      break;
    default:
      return null;
  }
  const lf = relOperandToF64(lhs, lt, cx);
  if (lf === null) return null;
  const rf = relOperandToF64(rhs, rt, cx);
  if (rf === null) return null;
  if (binop === null) {
    const fmodResult = cx.builder.emitCall(irIntrinsicFuncRef(FMOD_FN), [lf, rf], irVal({ kind: "f64" }));
    if (fmodResult === null) {
      // Unreachable: a non-null resultType always yields a value id.
      // invariant (producer-promise): a compiler-support/runtime helper declared non-void returned no SSA value — #4502.
      throw new Error(`ir/from-ast: internal — dynamic __fmod call produced no value in ${cx.funcName}`);
    }
    return fmodResult;
  }
  return cx.builder.emitBinary(binop, lf, rf, irVal({ kind: "f64" }));
}

// ---------------------------------------------------------------------------
// Closure / nested-function lowering (#1169c — IR Phase 4 Slice 3)
// ---------------------------------------------------------------------------

function recordLiftedUnitProvenance(identity: IrLiftedFunctionArtifactIdentity, cx: LowerCtx): void {
  cx.liftedUnitProvenance.push({
    id: identity.unitId,
    parentId: identity.parentId,
    role: identity.role,
    ordinal: identity.ordinal,
    ...(identity.sourceUnit ? { sourceUnit: true } : {}),
  });
}

function allocateLoweredLiftedFunctionArtifact(
  declaration: ts.FunctionDeclaration | IrClosureLiteral,
  cx: LowerCtx,
  displayNameForOrdinal: (ordinal: number) => string,
  preserveDerivedIdentity = false,
): IrLiftedFunctionArtifactIdentity {
  // Exact host plans allocate their targets before AST lowering and compare
  // against those derived identities when the plan is consumed. They are
  // compiler-owned artifacts even though their syntax is a source closure;
  // do not replace their planned target with the source node's unit ID.
  if (preserveDerivedIdentity) return allocateLiftedFunctionArtifact(cx, displayNameForOrdinal);

  // Mutable-capture/usage transforms may retain the terminal declaration but
  // clone a nested function-like. TypeScript preserves the exact pre-transform
  // node through getOriginalNode; consult it before classifying the lift as a
  // compiler-created artifact, otherwise a real source arrow incorrectly
  // escapes into the derived-unit namespace.
  const originalDeclaration = ts.getOriginalNode(declaration);
  const expectedSourceKind = ts.isFunctionDeclaration(declaration)
    ? "nested-function"
    : ts.isMethodDeclaration(declaration)
      ? "object-method"
      : ts.isFunctionExpression(declaration)
        ? "function-expression"
        : "arrow-function";
  let sourceUnitId =
    cx.identityContext?.unitIdByDeclaration.get(declaration) ??
    (originalDeclaration !== declaration
      ? cx.identityContext?.unitIdByDeclaration.get(originalDeclaration)
      : undefined);
  if (!sourceUnitId && cx.identityContext) {
    // A few checker/usage transforms clone the nested node without preserving
    // TypeScript's original-node link. Recover only one exact-span source
    // record under this terminal owner; kind, source, owner, and offsets must
    // all agree with the frozen inventory.
    const owner = cx.identityContext.unitByUnitId.get(cx.ownerUnitId);
    const sourceFile = declaration.getSourceFile();
    const candidates = owner
      ? cx.identityContext.inventory.allUnits.filter(
          (unit) =>
            unit.sourceId === owner.sourceId &&
            unit.kind === expectedSourceKind &&
            unit.terminalOwnerId === cx.ownerUnitId &&
            unit.declarationStart === declaration.getStart(sourceFile) &&
            unit.declarationEnd === declaration.end,
        )
      : [];
    if (candidates.length === 1) sourceUnitId = candidates[0]!.id;
  }
  const sourceUnit = sourceUnitId ? cx.identityContext?.unitByUnitId.get(sourceUnitId) : undefined;
  if (sourceUnitId && sourceUnit) {
    if (
      sourceUnit.kind !== expectedSourceKind ||
      sourceUnit.terminalOwnerId !== cx.ownerUnitId ||
      sourceUnit.lexicalOwnerId === null ||
      !cx.identityContext?.unitByUnitId.has(sourceUnit.lexicalOwnerId as IrUnitId)
    ) {
      // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
      throw new Error(`ir/from-ast: lifted source identity diverged (${cx.funcName})`);
    }
    const displayOrdinal = cx.liftedCounter.value++;
    return {
      unitId: sourceUnitId,
      name: displayNameForOrdinal(displayOrdinal),
      parentId: sourceUnit.lexicalOwnerId as IrUnitId,
      role: "lifted-closure",
      ordinal: sourceUnit.ordinal,
      sourceUnit: true,
    };
  }
  return allocateLiftedFunctionArtifact(cx, displayNameForOrdinal);
}

/**
 * Lower an arrow function or function expression as an IR closure
 * value. Lifts the body to a top-level IR function (with __self as
 * param 0) and emits a `closure.new` that materialises the closure
 * struct. Returns the SSA value of the closure (its IrType is
 * `IrType.closure` with the resolved signature).
 *
 * Mutable captures: rebinds `cx.scope[capName]` to the refcell ref, so
 * subsequent outer reads/writes of `capName` route through
 * `refcell.get` / `refcell.set` automatically (see the identifier
 * handler in `lowerExpr`).
 */
function numericClosureDefaultInitializerIsIrSafe(
  initializer: ts.Expression,
  availableParamNames: ReadonlySet<string>,
  ownParamNames: ReadonlySet<string>,
  outerCx: LowerCtx,
): boolean {
  let candidate = initializer;
  while (ts.isParenthesizedExpression(candidate)) candidate = candidate.expression;
  if (ts.isNumericLiteral(candidate)) return true;
  if (ts.isIdentifier(candidate)) {
    if (availableParamNames.has(candidate.text)) return true;
    if (ownParamNames.has(candidate.text)) return false;
    const binding = outerCx.scope.get(candidate.text);
    if (binding?.kind !== "local") return false;
    const type = binding.type.kind === "boxed" ? binding.type.inner : binding.type;
    return asVal(type)?.kind === "f64";
  }
  if (
    ts.isPrefixUnaryExpression(candidate) &&
    (candidate.operator === ts.SyntaxKind.PlusToken || candidate.operator === ts.SyntaxKind.MinusToken)
  ) {
    return numericClosureDefaultInitializerIsIrSafe(candidate.operand, availableParamNames, ownParamNames, outerCx);
  }
  return (
    ts.isBinaryExpression(candidate) &&
    (candidate.operatorToken.kind === ts.SyntaxKind.PlusToken ||
      candidate.operatorToken.kind === ts.SyntaxKind.MinusToken ||
      candidate.operatorToken.kind === ts.SyntaxKind.AsteriskToken ||
      candidate.operatorToken.kind === ts.SyntaxKind.SlashToken) &&
    numericClosureDefaultInitializerIsIrSafe(candidate.left, availableParamNames, ownParamNames, outerCx) &&
    numericClosureDefaultInitializerIsIrSafe(candidate.right, availableParamNames, ownParamNames, outerCx)
  );
}

function closureDefaultParamStart(
  parameters: readonly ts.ParameterDeclaration[],
  funcName: string,
  outerCx: LowerCtx,
): number {
  let firstDefault = parameters.length;
  const availableParamNames = new Set<string>();
  const ownParamNames = new Set<string>();
  for (const parameter of parameters) collectBindingNames(parameter.name, ownParamNames);
  for (let index = 0; index < parameters.length; index++) {
    const parameter = parameters[index]!;
    if (!parameter.initializer) {
      if (firstDefault !== parameters.length) {
        demoteToLegacy("body-shape-rejected", `ir/from-ast: closure defaults must form a suffix (${funcName})`);
      }
    } else if (
      !ts.isIdentifier(parameter.name) ||
      parameter.type?.kind !== ts.SyntaxKind.NumberKeyword ||
      !numericClosureDefaultInitializerIsIrSafe(parameter.initializer, availableParamNames, ownParamNames, outerCx)
    ) {
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: closure default parameter is outside the pure numeric subset (${funcName})`,
      );
    } else if (firstDefault === parameters.length) {
      firstDefault = index;
    }
    if (ts.isIdentifier(parameter.name) && parameter.type?.kind === ts.SyntaxKind.NumberKeyword) {
      availableParamNames.add(parameter.name.text);
    }
  }
  return firstDefault;
}

type IrClosureLiteral = ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;

function lowerClosureExpression(expr: IrClosureLiteral, cx: LowerCtx): IrValueId {
  const defaultParamStart = closureDefaultParamStart(expr.parameters, cx.funcName, cx);
  const params: IrType[] = expr.parameters.map((p) => {
    if (!p.type) {
      demoteToLegacy("body-shape-rejected", `ir/from-ast: closure params must have annotations (${cx.funcName})`);
    }
    // #2713 — rest (`...xs`) and optional (`x?`) params keep
    // an Identifier name, so the gate above lets them through and the lowering
    // below would silently drop their arity semantics (a regression
    // against #1372's intent). Reject them to legacy here, mirroring the
    // top-level selector gate (`select.ts` param-shape-rejected). Numeric
    // constant defaults are handled below through the exact legacy sentinel.
    if (p.questionToken || p.dotDotDotToken) {
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: closure rest/optional param not in IR scope (${cx.funcName})`,
      );
    }
    const description = ts.isIdentifier(p.name) ? p.name.text : "<pattern>";
    return closureParameterTypeToIr(p.type, cx, `param ${description} of ${cx.funcName}.<closure>`);
  });
  if (!expr.type) {
    demoteToLegacy("body-shape-rejected", `ir/from-ast: closure must have a return type annotation (${cx.funcName})`);
  }
  const returnType = typeNodeToIr(expr.type, `return type of ${cx.funcName}.<closure>`);
  const signature: IrClosureSignature = {
    params,
    returnType,
    ...(defaultParamStart < params.length ? { defaultParamStart } : {}),
  };

  return lowerClosureExpressionWithSignature(expr, signature, undefined, cx);
}

/**
 * Resolve the checker-independent closure-parameter surface admitted by the
 * selector. Named interfaces/classes remain on the planned direct route until
 * lifted closures receive the top-level position-type sidecar.
 */
function closureParameterTypeToIr(node: ts.TypeNode, cx: LowerCtx, where: string): IrType {
  if (isPrimitiveTypeNode(node)) return typeNodeToIr(node, where);
  if (ts.isFunctionTypeNode(node)) {
    const signature = irClosureSignatureFromFunctionTypeNode(node);
    if (!signature)
      demoteToLegacy(
        "type-resolution-unsupported",
        `ir/from-ast: unsupported closure-valued parameter signature (${where})`,
      );
    return { kind: "closure", signature };
  }
  if (ts.isArrayTypeNode(node) && node.elementType.kind === ts.SyntaxKind.NumberKeyword) {
    const elementValType: ValType = { kind: "f64" };
    const elementType = irVal(elementValType);
    if (!cx.resolver?.resolveVecForElement?.(elementValType)) {
      demoteToLegacy(
        "type-resolution-unsupported",
        `ir/from-ast: resolver cannot register numeric closure parameter vec (${where})`,
      );
    }
    return irVec(elementType, true);
  }
  if (ts.isTypeLiteralNode(node) && node.members.length > 0) {
    const fields: { name: string; type: IrType }[] = [];
    const seen = new Set<string>();
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || member.questionToken || !member.type) {
        demoteToLegacy(
          "type-resolution-unsupported",
          `ir/from-ast: unsupported closure object parameter member (${where})`,
        );
      }
      const name = ts.isIdentifier(member.name)
        ? member.name.text
        : ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name)
          ? member.name.text
          : null;
      if (name === null || seen.has(name) || !isPrimitiveTypeNode(member.type)) {
        demoteToLegacy(
          "type-resolution-unsupported",
          `ir/from-ast: unsupported closure object parameter shape (${where})`,
        );
      }
      seen.add(name);
      fields.push({ name, type: typeNodeToIr(member.type, `${where}.${name}`) });
    }
    fields.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return { kind: "object", shape: { fields } };
  }
  demoteToLegacy("type-resolution-unsupported", `ir/from-ast: unsupported closure parameter type (${where})`);
}

/**
 * #3214 B2 — materialise the one certified ambient-host callback as a
 * canonical zero-result IR closure. The checker/selector plan owns the narrow
 * syntax and readonly-capture proof; this defensive comparison prevents a
 * stale or node-mismatched plan from widening lowering after selection.
 */
function lowerHostVoidCallbackExpression(
  expr: ts.ArrowFunction,
  plan: IrHostVoidCallbackLoweringPlan,
  cx: LowerCtx,
): IrValueId {
  requireMatchingLoweringPlanOwner("host void callback", plan.ownerUnitId, cx.ownerUnitId, cx.funcName);
  if (
    !ts.isBlock(expr.body) ||
    expr.parameters.length !== 0 ||
    plan.signature.params.length !== 0 ||
    plan.signature.returnType !== null ||
    cx.liftedCounter.value !== plan.liftedOrdinal
  ) {
    // invariant (producer-promise): the resolver promised a well-formed plan — #4502.
    throw new Error(`ir/from-ast: malformed host void callback plan (${cx.funcName})`);
  }
  return lowerClosureExpressionWithSignature(
    expr,
    plan.signature,
    plan.captureNames,
    cx,
    plan.standaloneDomReusable === true
      ? {
          domCallbackAuthority: {
            ownerUnitId: plan.ownerUnitId,
            liftedOrdinal: plan.liftedOrdinal,
          },
        }
      : { hostOneShot: true },
  );
}

function lowerClosureExpressionWithSignature(
  expr: IrClosureLiteral,
  signature: IrClosureSignature,
  expectedReadonlyCaptures: ReadonlySet<string> | undefined,
  cx: LowerCtx,
  exact?: ExactClosureLoweringOptions,
): IrValueId {
  const defaultParamStart = closureDefaultParamStart(expr.parameters, cx.funcName, cx);
  if ((signature.defaultParamStart ?? signature.params.length) !== defaultParamStart) {
    // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
    throw new Error(`ir/from-ast: exact closure default-parameter plan diverged (${cx.funcName})`);
  }
  const captures = analyseCaptures(expr, cx, exact?.orderedReadonlyCaptures);
  if (expectedReadonlyCaptures) {
    const actual = new Set(captures.map((capture) => capture.name));
    if (
      captures.some((capture) => capture.mutable) ||
      actual.size !== expectedReadonlyCaptures.size ||
      [...actual].some((name) => !expectedReadonlyCaptures.has(name))
    ) {
      // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
      throw new Error(`ir/from-ast: exact closure capture proof diverged (${cx.funcName})`);
    }
  }

  const liftedIdentity = allocateLoweredLiftedFunctionArtifact(
    expr,
    cx,
    (ordinal) => exactClosureLiftedName(cx.funcName, ordinal, exact?.expectedLiftedName),
    exact?.expectedLiftedTarget !== undefined ||
      exact?.hostOneShot === true ||
      exact?.domCallbackAuthority !== undefined,
  );
  recordLiftedUnitProvenance(liftedIdentity, cx);
  const liftedTarget = irUnitFuncRef(liftedIdentity);
  if (
    exact?.expectedLiftedTarget &&
    (!sameIrCallableBinding(liftedTarget.binding, exact.expectedLiftedTarget.binding) ||
      liftedTarget.name !== exact.expectedLiftedTarget.name)
  ) {
    // invariant (producer-promise): the prepared plan and the lowering disagree — a plan<->builder desync — #4502.
    throw new Error(
      `ir/from-ast: exact lifted target ${liftedTarget.name} does not match planned ${exact.expectedLiftedTarget.name} (${cx.funcName})`,
    );
  }

  // Materialize capture args. Mutable captures need a refcell; if the
  // outer doesn't already have one (a sibling closure may have built
  // one earlier), create it now and rebind the outer scope.
  const captureArgs: IrValueId[] = [];
  const captureFieldTypes: IrType[] = [];
  for (const cap of captures) {
    if (cap.withField) {
      captureFieldTypes.push(cap.type);
      captureArgs.push(cap.outerValue);
      continue;
    }
    if (cap.mutable) {
      const innerVal = asVal(cap.type);
      if (!innerVal) {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: mutable closure capture "${cap.name}" must be a primitive (${cx.funcName})`,
        );
      }
      // #1926 — boxed.inner is an IrType; wrap the scalar ValType with irVal.
      const fieldType: IrType = { kind: "boxed", inner: irVal(innerVal) };
      captureFieldTypes.push(fieldType);
      const live = cx.scope.get(cap.name);
      if (live?.kind === "local" && live.type.kind === "boxed") {
        captureArgs.push(live.value);
      } else if (live?.kind === "local") {
        const cell = cx.builder.emitRefCellNew(live.value, innerVal);
        cx.scope.set(cap.name, { kind: "local", value: cell, type: fieldType });
        captureArgs.push(cell);
      } else {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: closure mutable capture "${cap.name}" not in scope (${cx.funcName})`,
        );
      }
    } else {
      // Read-only — pass the current scalar value. If a sibling closure
      // already upgraded the binding to a refcell, deref now so the
      // captured value is the unboxed scalar (the lifted body sees it
      // as the scalar IrType, which matches our `cap.type`).
      const live = cx.scope.get(cap.name);
      let v: IrValueId;
      if (live?.kind === "local" && live.type.kind === "boxed") {
        v = cx.builder.emitRefCellGet(live.value, live.type.inner);
      } else if (live?.kind === "local") {
        v = live.value;
      } else {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: closure capture "${cap.name}" not in scope (${cx.funcName})`,
        );
      }
      captureFieldTypes.push(cap.type);
      captureArgs.push(v);
    }
  }

  // Lift body. The lifted function takes (__self: IrType.closure,
  // ...sig.params) and reads captures via `closure.cap`.
  const lifted = liftClosureBody(
    liftedIdentity,
    expr,
    signature,
    captures,
    captureFieldTypes,
    cx,
    exact?.allowConciseVoidBody === true,
    exact?.hostOneShot === true,
    exact?.domCallbackAuthority,
  );
  cx.lifted.push(lifted);

  return cx.builder.emitClosureNew(liftedTarget, signature, captureFieldTypes, captureArgs, {
    ...(exact?.hostOneShot === true ? { hostOneShot: true } : {}),
    ...(exact?.domCallbackAuthority ? { domCallbackAuthority: exact.domCallbackAuthority } : {}),
  });
}

/**
 * Lower a nested function declaration. Adds a `nestedFunc` scope
 * binding (name-only — no SSA value) and lifts the body to a
 * top-level function with prepended capture params (no __self struct).
 * Direct call: `call $lifted` with capture args first, then user args.
 */
function lowerNestedFunctionDeclaration(fn: ts.FunctionDeclaration, cx: LowerCtx): void {
  if (!fn.name || !fn.body) {
    demoteToLegacy("body-shape-rejected", `ir/from-ast: nested function without name or body in ${cx.funcName}`);
  }
  const innerName = fn.name.text;
  const params: IrType[] = fn.parameters.map((p) => {
    if (!ts.isIdentifier(p.name) || !p.type) {
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: nested func params must be Identifier-named with annotations (${cx.funcName})`,
      );
    }
    return typeNodeToIr(p.type, `param ${p.name.text} of ${cx.funcName}.${innerName}`);
  });
  if (!fn.type) {
    demoteToLegacy(
      "body-shape-rejected",
      `ir/from-ast: nested func must have a return type annotation (${cx.funcName})`,
    );
  }
  const returnType = typeNodeToIr(fn.type, `return type of ${cx.funcName}.${innerName}`);
  const signature: IrClosureSignature = { params, returnType };

  const captures = analyseCaptures(fn, cx);
  const liftedIdentity = allocateLoweredLiftedFunctionArtifact(
    fn,
    cx,
    (ordinal) => `${cx.funcName}__nested_${innerName}_${ordinal}`,
  );
  recordLiftedUnitProvenance(liftedIdentity, cx);

  const lifted = liftNestedFunction(liftedIdentity, fn, signature, captures, cx);
  cx.lifted.push(lifted);

  // Add to the OUTER scope.
  cx.scope.set(innerName, { kind: "nestedFunc", target: irUnitFuncRef(liftedIdentity), signature, captures });
}

/**
 * Lift a nested function body to a top-level IR function. The body's
 * params are: [capture0, capture1, ..., innerParam0, ...]. Mutable
 * captures are typed `boxed<T>`; the body's identifier handler
 * dereferences them via refcell.get on read.
 */
function liftNestedFunction(
  liftedIdentity: IrFunctionIdentity,
  fn: ts.FunctionDeclaration,
  signature: IrClosureSignature,
  captures: readonly NestedCapture[],
  cx: LowerCtx,
): IrFunction {
  const liftedName = liftedIdentity.name;
  if (signature.returnType === null) {
    demoteToLegacy(
      "body-shape-rejected",
      `ir/from-ast: void nested function signatures are outside slice 3 (${liftedName})`,
    );
  }
  const builder = new IrFunctionBuilder(liftedIdentity, [signature.returnType], false, cx.allocRegistry);
  const scope = new Map<string, ScopeBinding>();

  // Prepend capture params before the user's params.
  for (const cap of captures) {
    const innerVal = asVal(cap.type);
    // #1926 — boxed.inner is an IrType; wrap the scalar ValType with irVal.
    const paramType: IrType = cap.mutable && innerVal ? { kind: "boxed", inner: irVal(innerVal) } : cap.type;
    const v = builder.addParam(cap.name, paramType);
    scope.set(cap.name, { kind: "local", value: v, type: paramType });
  }
  for (let i = 0; i < fn.parameters.length; i++) {
    const p = fn.parameters[i]!;
    const name = (p.name as ts.Identifier).text;
    const t = signature.params[i]!;
    const v = builder.addParam(name, t);
    scope.set(name, { kind: "local", value: v, type: t });
  }

  builder.openBlock();

  const innerCx: LowerCtx = {
    builder,
    scope,
    funcName: liftedName,
    ownerUnitId: cx.ownerUnitId,
    returnType: signature.returnType,
    calleeTypes: cx.calleeTypes,
    directCalls: cx.directCalls,
    importedCalls: cx.importedCalls,
    topLevelFunctionValues: cx.topLevelFunctionValues,
    hostVoidCallbacks: cx.hostVoidCallbacks,
    hostDateSnapshots: cx.hostDateSnapshots,
    hostDateGetters: cx.hostDateGetters,
    promiseDelays: cx.promiseDelays,
    identityContext: cx.identityContext,
    classShapes: cx.classShapes,
    resolver: cx.resolver,
    lifted: cx.lifted,
    liftedUnitProvenance: cx.liftedUnitProvenance,
    liftedCounter: cx.liftedCounter,
    // Slice 6 part 2 (#1181) — nested-function bodies have their own
    // mutated-let scope (collected per-body when slice 6 extends to
    // closures). Empty here keeps the slice-3 nested-fn behavior intact.
    mutatedLets: collectMutatedLetNames(fn),
    dynamicStringLocals: new Set(),
    // (#3758) nested functions get their own independent i32-pure-names set,
    // same reasoning as mutatedLets above.
    i32PureNames: computeI32PureNames(fn),
    ownedStringAppendSymbols: fn.body ? collectOwnedStringAppendSymbols(fn.body, cx.checker) : new Set<ts.Symbol>(),
    emptyArrayInference: inferEmptyArrayElementTypes(
      fn,
      cx.oracle ?? (cx.checker ? new TsCheckerOracle(cx.checker) : undefined),
    ),
    // Slice 7a (#1169f) — nested function decls are NEVER generators
    // in slice 7a (the selector rejects `function*` nesting via
    // `isPhase1NestedFunc`).
    funcKind: "regular",
    checker: cx.checker,
    oracle: cx.oracle,
    numericLocalScalarForDecl: cx.numericLocalScalarForDecl,
    allocRegistry: cx.allocRegistry,
  };
  if (!fn.body) {
    demoteToLegacy("body-shape-rejected", `ir/from-ast: nested function ${innerName(fn)} has no body`);
  }
  lowerStatementList(fn.body.statements, innerCx);

  return builder.finish();
}

function innerName(fn: ts.FunctionDeclaration): string {
  return fn.name?.text ?? "<anon>";
}

/**
 * Lift a closure expression body. The lifted function has __self at
 * param 0 (typed `IrType.closure`); captures are read inside the body
 * via `closure.cap` rather than as prepended params. Mutable captures
 * land as `boxed<T>` field types so `cap` returns the refcell ref;
 * subsequent identifier reads inside the body deref via refcell.get.
 *
 * The returned IrFunction carries `closureSubtype` metadata so the
 * lowerer can emit the correct `ref.cast` on closure.cap.
 */
function liftClosureBody(
  liftedIdentity: IrFunctionIdentity,
  expr: IrClosureLiteral,
  signature: IrClosureSignature,
  captures: readonly NestedCapture[],
  captureFieldTypes: readonly IrType[],
  cx: LowerCtx,
  allowConciseVoidBody = false,
  hostOneShot = false,
  domCallbackAuthority?: import("./nodes.js").IrDomCallbackAuthority,
): IrFunction {
  const body = expr.body;
  if (!body) {
    demoteToLegacy("body-shape-rejected", `ir/from-ast: object method closure has no body (${cx.funcName})`);
  }
  const liftedName = liftedIdentity.name;
  const builder = new IrFunctionBuilder(
    liftedIdentity,
    signature.returnType === null ? [] : [signature.returnType],
    false,
    cx.allocRegistry,
  );
  const scope = new Map<string, ScopeBinding>();

  const selfType: IrType = { kind: "closure", signature };
  const selfV = builder.addParam("__self", selfType);
  // A named function expression owns a lexical self binding that is visible
  // only inside its body. Reuse the canonical closure carrier so recursive
  // calls keep the exact typed call_ref path instead of escaping through a
  // dynamic/global lookup.
  if (ts.isFunctionExpression(expr) && expr.name) {
    scope.set(expr.name.text, { kind: "local", value: selfV, type: selfType });
  }

  const pendingDestructures: { pattern: ts.BindingPattern; value: IrValueId }[] = [];
  const pendingDefaults: {
    name: string;
    rawValue: IrValueId;
    type: IrType;
    initializer: ts.Expression;
  }[] = [];
  const defaultParamStart = signature.defaultParamStart ?? signature.params.length;
  for (let i = 0; i < expr.parameters.length; i++) {
    const p = expr.parameters[i]!;
    const t = signature.params[i]!;
    const name = ts.isIdentifier(p.name) ? p.name.text : `__pattern_param_${i}`;
    const v = builder.addParam(name, t);
    if (ts.isIdentifier(p.name) && i >= defaultParamStart && p.initializer) {
      pendingDefaults.push({ name, rawValue: v, type: t, initializer: p.initializer });
    } else if (ts.isIdentifier(p.name)) scope.set(name, { kind: "local", value: v, type: t });
    else pendingDestructures.push({ pattern: p.name, value: v });
  }

  builder.openBlock();

  // Read each capture out of __self. captureFieldTypes is parallel to
  // captures; lifted body sees captures at index 0..N-1.
  for (let i = 0; i < captures.length; i++) {
    const cap = captures[i]!;
    const fieldType = captureFieldTypes[i]!;
    const v = builder.emitClosureCap(selfV, i, fieldType);
    if (cap.withField) {
      scope.set(cap.name, {
        kind: "withField",
        receiver: v,
        name: cap.withField.name,
        type: cap.withField.type,
      });
    } else {
      scope.set(cap.name, { kind: "local", value: v, type: fieldType });
    }
  }

  const innerCx: LowerCtx = {
    builder,
    scope,
    funcName: liftedName,
    ownerUnitId: cx.ownerUnitId,
    returnType: signature.returnType,
    calleeTypes: cx.calleeTypes,
    directCalls: cx.directCalls,
    importedCalls: cx.importedCalls,
    topLevelFunctionValues: cx.topLevelFunctionValues,
    hostVoidCallbacks: cx.hostVoidCallbacks,
    hostDateSnapshots: cx.hostDateSnapshots,
    hostDateGetters: cx.hostDateGetters,
    promiseDelays: cx.promiseDelays,
    identityContext: cx.identityContext,
    classShapes: cx.classShapes,
    resolver: cx.resolver,
    lifted: cx.lifted,
    liftedUnitProvenance: cx.liftedUnitProvenance,
    liftedCounter: cx.liftedCounter,
    // Slice 6 part 2 (#1181) — closure-body mutated lets are scanned
    // per closure (block bodies) or empty (concise expression bodies,
    // which can't host a let declaration).
    mutatedLets: ts.isBlock(body) ? collectMutatedLetNamesFromBlock(body) : new Set<string>(),
    dynamicStringLocals: new Set(),
    // (#3758) same independent-per-closure reasoning as mutatedLets above;
    // computeI32PureNames itself no-ops on a non-block (concise) body.
    i32PureNames: computeI32PureNames(expr),
    ownedStringAppendSymbols: ts.isBlock(body)
      ? collectOwnedStringAppendSymbols(body, cx.checker)
      : new Set<ts.Symbol>(),
    emptyArrayInference: inferEmptyArrayElementTypes(
      expr,
      cx.oracle ?? (cx.checker ? new TsCheckerOracle(cx.checker) : undefined),
    ),
    // Slice 7a (#1169f) — closures are never generator/async in 7a
    // (the selector rejects them in `isPhase1ClosureLiteral`).
    funcKind: "regular",
    checker: cx.checker,
    oracle: cx.oracle,
    numericLocalScalarForDecl: cx.numericLocalScalarForDecl,
    allocRegistry: cx.allocRegistry,
  };

  for (const pending of pendingDefaults) {
    if (asVal(pending.type)?.kind !== "f64") {
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: closure default parameter must use the f64 carrier (${liftedName})`,
      );
    }
    const rawBits = builder.emitUnary("i64.reinterpret_f64", pending.rawValue, IR_I64);
    const sentinelBits = builder.emitConst({ kind: "i64", value: LEGACY_EXPRESSION_DEFAULT_F64_SENTINEL_BITS }, IR_I64);
    const missing = builder.emitBinary("i64.eq", rawBits, sentinelBits, IR_I32);
    const fallback = lowerExpr(pending.initializer, innerCx, pending.type);
    if (!irTypeAssignable(builder.typeOf(fallback), pending.type)) {
      demoteToLegacy("body-shape-rejected", `ir/from-ast: closure default initializer type mismatch (${liftedName})`);
    }
    const resolved = builder.emitSelect(missing, fallback, pending.rawValue, pending.type);
    scope.set(pending.name, { kind: "local", value: resolved, type: pending.type });
  }

  for (const pending of pendingDestructures) {
    lowerBindingPattern(pending.pattern, pending.value, innerCx);
  }

  if (ts.isArrowFunction(expr) && !ts.isBlock(body)) {
    if (signature.returnType === null) {
      if (!allowConciseVoidBody) {
        demoteToLegacy("body-shape-rejected", `ir/from-ast: void host callbacks must be block-bodied (${liftedName})`);
      }
      lowerDiscardedExpression(body, innerCx);
      builder.terminate({ kind: "return", values: [] });
      return builder.finish({
        signature,
        captureFieldTypes: [...captureFieldTypes],
        ...(hostOneShot ? { hostOneShot: true } : {}),
        ...(domCallbackAuthority ? { domCallbackAuthority } : {}),
      });
    }
    // Concise body — wrap as `return <expr>`.
    const v = lowerExpr(body, innerCx, signature.returnType);
    if (!irTypeEquals(builder.typeOf(v), signature.returnType)) {
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: closure body type ${describeIrType(builder.typeOf(v))} != declared return ${describeIrType(signature.returnType)} (${liftedName})`,
      );
    }
    builder.terminate({ kind: "return", values: [v] });
  } else {
    if (!ts.isBlock(body)) {
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: closure body must be a block (got ${ts.SyntaxKind[body.kind]})`,
      );
    }
    lowerStatementList(body.statements, innerCx);
  }

  return builder.finish({
    signature,
    captureFieldTypes: [...captureFieldTypes],
    ...(hostOneShot ? { hostOneShot: true } : {}),
    ...(domCallbackAuthority ? { domCallbackAuthority } : {}),
  });
}

/**
 * Walk a closure / nested-function's parameter initializers and body, collecting identifiers that
 * reference outer-scope `local` bindings. Classifies each capture as
 * mutable (the body OR the outer writes to it) or read-only.
 *
 * Outer writes are conservatively detected by walking the entire
 * outer body — any identifier-LHS write to `name` upgrades it to
 * mutable, even if the closure body itself is read-only. This is the
 * safe-and-simple approach the legacy path uses too.
 */
function analyseCaptures(
  fn: ts.FunctionDeclaration | IrClosureLiteral,
  cx: LowerCtx,
  orderedCaptureNames?: readonly string[],
): NestedCapture[] {
  const referenced = new Set<string>();
  const written = new Set<string>();
  const ownParams = new Set<string>();
  if (ts.isFunctionExpression(fn) && fn.name) ownParams.add(fn.name.text);
  for (const p of fn.parameters) {
    collectBindingNames(p.name, ownParams);
  }

  const visit = (node: ts.Node): void => {
    // Don't descend into nested function-likes — they have their own
    // capture analysis run when they're lowered.
    if (node !== fn && (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      return;
    }
    if (ts.isIdentifier(node)) {
      referenced.add(node.text);
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (
        op === ts.SyntaxKind.EqualsToken ||
        (op >= ts.SyntaxKind.PlusEqualsToken && op <= ts.SyntaxKind.CaretEqualsToken)
      ) {
        if (ts.isIdentifier(node.left)) written.add(node.left.text);
      }
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      const op = node.operator;
      if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
        if (ts.isIdentifier(node.operand)) written.add(node.operand.text);
      }
    }
    forEachChild(node, visit);
  };
  for (const parameter of fn.parameters) {
    if (parameter.initializer) visit(parameter.initializer);
  }
  if (fn.body) {
    if (ts.isBlock(fn.body)) {
      for (const s of fn.body.statements) visit(s);
    } else {
      visit(fn.body);
    }
  }

  const outerWrites = collectOuterWrites(fn);

  if (orderedCaptureNames) {
    validateExactCapturePlan(
      orderedCaptureNames,
      referenced,
      ownParams,
      (name) => (cx.scope.get(name)?.kind === "local" ? "local" : cx.scope.has(name) ? "other" : undefined),
      cx.funcName,
    );
  }

  const captures: NestedCapture[] = [];
  const captureOrder: Iterable<string> = orderedCaptureNames ?? referenced;
  for (const name of captureOrder) {
    if (ownParams.has(name)) continue;
    const binding = cx.scope.get(name);
    if (!binding) continue;
    if (binding.kind === "withField") {
      const receiverType = cx.builder.typeOf(binding.receiver);
      if (receiverType.kind !== "object") {
        demoteToLegacy(
          "body-shape-rejected",
          `ir/from-ast: with binding "${name}" has a non-object receiver in ${cx.funcName}`,
        );
      }
      captures.push({
        name,
        type: receiverType,
        mutable: false,
        outerValue: binding.receiver,
        withField: { name: binding.name, type: binding.type },
      });
      continue;
    }
    if (binding.kind !== "local") {
      // Slice 3 doesn't yet capture closure / nested-fn bindings — that
      // would require either lifting the inner closure to a top-level
      // ref.func or adding closure VALUE fields to the capture struct.
      // Defer.
      demoteToLegacy(
        "body-shape-rejected",
        `ir/from-ast: closure inside ${cx.funcName} captures non-local binding "${name}" — not in slice 3`,
      );
    }
    // If the local is already a refcell (a sibling closure boxed it),
    // the capture's logical type is the inner IrType — we deref on
    // read in `lowerClosureExpression`. #1926 — boxed.inner is already an
    // IrType, so use it directly (no irVal re-wrap).
    const logicalType: IrType = binding.type.kind === "boxed" ? binding.type.inner : binding.type;
    const isMutable = written.has(name) || outerWrites.has(name);
    captures.push({
      name,
      type: logicalType,
      mutable: isMutable,
      outerValue: binding.value,
    });
  }
  return captures;
}

/** Collect every identifier leaf owned by one parameter binding. */
function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingNames(element.name, out);
  }
}

// ---------------------------------------------------------------------------
// Throw / try / catch / finally lowering (#1169h — IR Phase 4 Slice 9)
// ---------------------------------------------------------------------------

/**
 * Slice 9 (#1169h): lower a `throw <expr>;` statement. The thrown value
 * is coerced to externref (the `__exn` tag's signature is
 * `(externref)`) before the IR `throw` instr.
 *
 * Coercion strategy mirrors the legacy
 * `compileThrowStatement` in `src/codegen/statements/exceptions.ts`:
 *   - f64 / i32                → `__box_number(value)` host import.
 *                                 Slice 9 defers numeric throws — they
 *                                 require the box helper; numeric
 *                                 throws are rare and the function falls
 *                                 back to legacy via the unsupported-
 *                                 expression error.
 *   - externref                → no-op; passed through.
 *   - object / class /
 *     closure / string / ref / ref_null
 *                              → `extern.convert_any` via
 *                                 `coerce.to_externref`.
 *
 * Lowering produces a single `throw` instr with no fall-through; the
 * caller's surrounding block is responsible for any subsequent
 * unreachable terminator (top-level throws in tail position) or for
 * embedding the throw within a try buffer (where the catch_all wrapping
 * implicitly catches the unreachability).
 */
function lowerThrowStatement(stmt: ts.ThrowStatement, cx: LowerCtx): void {
  if (!stmt.expression) {
    demoteToLegacy("throw-value-unsupported", `ir/from-ast: bare 'throw' not in slice 9 (${cx.funcName})`);
  }
  const value = lowerExpr(stmt.expression, cx, irVal({ kind: "externref" }));
  const valueType = cx.builder.typeOf(value);
  const valTy = asVal(valueType);
  if (valTy?.kind === "f64" || valTy?.kind === "i32") {
    // Slice 9 still defers numerics (they need a box helper). Class instances
    // are lowered again (#4097): #4035 declined them for a render gap that the
    // `__exn_render_prepare` user-class arm now closes on BOTH paths.
    demoteToLegacy("throw-value-unsupported", `ir/from-ast: throw ${valueType.kind} not in slice 9 (${cx.funcName})`);
  }
  // Reference-shaped — coerce to externref. The helper is a no-op
  // when the value is already externref or `IrType.string` in host
  // mode (mirrors the slice-7b yield value coercion).
  const valueExt = coerceIrValueToExternref(cx.builder, value);
  cx.builder.emitThrow(valueExt);
}

/**
 * Slice 9 (#1169h): lower a `try { ... } [catch (e) { ... }] [finally
 * { ... }]` statement.
 *
 * Each sub-block (try body, catch body, finally body) is lowered into a
 * self-contained `IrInstr[]` buffer via `collectBodyInstrs`. The catch
 * variable, when present, is bound as a slot of `(externref)` — the
 * lowerer's `try` op emit prepends a `local.set $payloadSlot` at handler
 * entry to capture the externref payload off the Wasm stack.
 *
 * The finally body is lowered ONCE here; the lowerer is responsible for
 * inlining it at every exit path (normal try-exit, normal catch-exit,
 * synthesized catch_all that re-throws). This matches the legacy
 * `cloneFinally` shape but the duplication happens entirely on the
 * Wasm-emit side, not the IR layer.
 */
function lowerTryStatement(stmt: ts.TryStatement, cx: LowerCtx): void {
  // A catch/finally entry may observe state from any preceding throw point,
  // not only the normal end of the try body. Summarize all possible writes so
  // stale ASCII evidence cannot cross an exceptional edge.
  const tryMayWriteScope = conservativeStringEncodingScope(stmt.tryBlock, cx);

  // ── Try body ────────────────────────────────────────────────────────
  const tryScope = new Map(cx.scope);
  const tryCx: LowerCtx = { ...cx, scope: tryScope, noEarlyReturn: true };
  const tryBody = cx.builder.collectBodyInstrs(() => {
    for (const s of stmt.tryBlock.statements) {
      lowerStmt(s, tryCx);
    }
  });

  // ── Catch handler ───────────────────────────────────────────────────
  let catchClause: { payloadSlot: number; body: readonly IrInstr[] } | undefined;
  let catchScopeOut: Map<string, ScopeBinding> | undefined;
  if (stmt.catchClause) {
    let payloadSlot = -1;
    const catchScope = new Map(tryMayWriteScope);
    if (stmt.catchClause.variableDeclaration && ts.isIdentifier(stmt.catchClause.variableDeclaration.name)) {
      // Allocate an externref slot to receive the caught exception. The
      // lowerer prepends a `local.set` at handler entry to pop the
      // payload off the Wasm stack into this slot.
      const varName = stmt.catchClause.variableDeclaration.name.text;
      payloadSlot = cx.builder.declareSlot(`__catch_${varName}`, { kind: "externref" });
      // Bind the catch variable as a slot read so identifier reads
      // inside the handler emit `local.get` against the slot.
      catchScope.set(varName, {
        kind: "slot",
        slotIndex: payloadSlot,
        type: irVal({ kind: "externref" }),
      });
    } else if (stmt.catchClause.variableDeclaration) {
      // Destructuring catch — selector should have rejected this.
      demoteToLegacy("body-shape-rejected", `ir/from-ast: destructuring catch param not in slice 9 (${cx.funcName})`);
    }
    const catchCx: LowerCtx = { ...cx, scope: catchScope, noEarlyReturn: true };
    const catchBody = cx.builder.collectBodyInstrs(() => {
      for (const s of stmt.catchClause!.block.statements) {
        lowerStmt(s, catchCx);
      }
    });
    // Include writes on catch paths that throw before normal completion;
    // those paths still enter `finally` and must not retain narrower facts.
    catchScopeOut = conservativeStringEncodingScope(stmt.catchClause.block, {
      ...catchCx,
      scope: new Map(tryMayWriteScope),
    });
    catchClause = { payloadSlot, body: catchBody };
  }

  const joinedTryScope = catchScopeOut
    ? joinedStringEncodingScope(cx.scope, [tryScope, catchScopeOut])
    : joinedStringEncodingScope(cx.scope, [tryScope, tryMayWriteScope]);

  // ── Finally body ────────────────────────────────────────────────────
  let finallyBody: readonly IrInstr[] | undefined;
  let continuationScope = joinedTryScope;
  if (stmt.finallyBlock) {
    const finallyScope = new Map(joinedTryScope);
    const finallyCx: LowerCtx = { ...cx, scope: finallyScope, noEarlyReturn: true };
    finallyBody = cx.builder.collectBodyInstrs(() => {
      for (const s of stmt.finallyBlock!.statements) {
        lowerStmt(s, finallyCx);
      }
    });
    continuationScope = finallyScope;
  }

  cx.builder.emitTry({
    body: tryBody,
    catchClause,
    finallyBody,
  });
  joinScopeStringEncodingFacts(cx.scope, [continuationScope]);
}
