// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts, forEachChild } from "../ts-api.js";
import { emitToBoolean } from "./coercion-engine.js";
import { emitWasiErrorConstructor, fillExternGetErrorProps } from "./registry/error-types.js";
import { analyzeLinearUint8 } from "./linear-uint8-analysis.js";
import { analyzeFnctorEscapeGate, deriveFnctorFields } from "./fnctor-escape-gate.js";
import { isLinearU8RepresentableNew } from "./linear-uint8-signatures.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2) positional-read chokepoint
import { emitVecDefineWritebackExports } from "./vec-define-writeback.js"; // (#3116)
import type { MultiTypedAST, TypedAST } from "../checker/index.js";
import {
  isBigIntType,
  isBooleanType,
  isExternalDeclaredClass,
  isHeterogeneousPrimitiveUnion,
  isHeterogeneousUnion,
  isNullablePrimitiveType,
  isNumberType,
  isNumberWrapperType,
  isStringType,
  isStringWrapperType,
  isVoidType,
  mapTsTypeToWasm,
} from "../checker/type-mapper.js";
import type { FieldDef, Instr, StructTypeDef, ValType, WasmFunction, WasmModule } from "../ir/types.js";
import { createEmptyModule } from "../ir/types.js";
import { compileIrPathFunctions, type IrIntegrationError } from "../ir/integration.js";
import { asVal, irDynamic, isDynamic, irVal, type IrType } from "../ir/nodes.js";
import { buildTypeMap, type LatticeType } from "../ir/propagate.js";
import { planIrCompilation, irClosureSignatureFromFunctionTypeNode, type IrFallbackReason } from "../ir/select.js";
import { makeIrHostGlobalResolver } from "../ir/host-extern.js"; // (#2856)
import { createCodegenContext } from "./context/create-context.js";
import { collectLocalCallEdges, irFirstBodyIsProvenLowerable, type ValueDomain } from "./ir-first-gate.js";
import type { FallbackCounts } from "./fallback-telemetry.js";
import { truthyEnv } from "./fallback-telemetry.js";
import { buildLeakedHostImportError, scanForLeakedHostImports } from "./host-import-allowlist.js";
import { reportError, reportErrorNoNode } from "./context/errors.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type {
  ClosureInfo,
  CodegenContext,
  CodegenError,
  CodegenOptions,
  ExternClassInfo,
  FunctionContext,
  OptionalParamInfo,
} from "./context/types.js";
import type { NodeBuiltinImport } from "../import-resolver.js";
import { eliminateDeadImports } from "./dead-elimination.js";
import { ensureMapRuntimeTypes } from "./map-runtime.js";
import { scanForNewTarget } from "./new-target.js"; // (#2023)
import { scanForArrayHoles, ensureHoleType } from "./array-holes.js"; // (#2001 S1)
import { hoistedVarRetypesToConcreteRef, usageInferredLocalType } from "./statements/variables.js"; // (#2106 S1 PR-2) hoist undefined-init retype predicate; (#684) usage-based any-local f64 override
import { ensureDynReadHelpers, ensureDynMemberGet } from "./dyn-read.js"; // (#2580 M0) / (#3053 U0)
import { collectClosureBaseWrapperTypeIdxs, buildClosureRefTestArms } from "./closure-classifier.js"; // (#2175 V2-S1)
import { ensureNativeIteratorRuntime, fillNativeIteratorLateArms } from "./iterator-native.js";
import { emitResizableAbExports } from "./dataview-native.js"; // (#3058)
import { fillCombinatorToVec } from "./promise-combinators.js"; // (#2922) dynamic combinator-arg drain fill
import { fillClosedMethodDispatch, fillPromiseThenableHelpers } from "./closed-method-dispatch.js";
import { fillSetRecFieldGetters } from "./collections-es2025.js"; // (#3172)
import { fillIterHofSteppers } from "./iter-hof-native.js"; // (#2903)
import { fillLazyIterLadderArms } from "./iter-lazy-native.js"; // (#2903 R3)
import { fillMemberSetDispatch, reserveVecFieldMaterializers } from "./member-set-dispatch.js";
import { fillMemberGetDispatch } from "./member-get-dispatch.js";
import { emitUndefined, ensureGetUndefined, reconcileNativeStrFinalizeShift } from "./expressions/late-imports.js";
import { fillProtoIteratorDriver } from "./expressions/proto-override.js";
import { fillAccessorDrivers } from "./accessor-driver.js";
import { fillDisposableStackDisposeDriver } from "./disposable-runtime.js";
import {
  fillApplyClosure,
  fillBindDynHelper,
  fillBuiltinFnMeta,
  fillDynamicForinVecArms,
  fillExternArrayLikeStructArms,
  fillExternGetIdxVecArms,
  fillExternSetVecArms,
  fillExternIsArray,
  fillProxyDispatch,
} from "./object-runtime.js";
import { fillTaDynViewMopArms } from "./ta-dyn-mop.js"; // (#3177) dyn-view §10.4.5 MOP arms
import { fillArrayToPrimitive } from "./array-to-primitive.js";
import { fillClassToPrimitive } from "./class-to-primitive.js";
import {
  fixupExternConvertAny,
  fixupStructNewArgCounts,
  fixupStructNewResultCoercion,
  markLeafStructsFinal,
  repairStructTypeMismatches,
} from "./fixups.js";
import { emitInlineMathFunctions } from "./math-helpers.js";
import { finalizeMethodTrampolines } from "./closures.js";
import { peepholeOptimize } from "./peephole.js";
import { brandCollidingShapeTypes } from "./shape-brand.js";
import {
  addImport,
  addStringConstantGlobal,
  ensureExnTag,
  localGlobalIdx,
  nextModuleGlobalIdx,
  // #808 — moved to registry/imports.ts; imported back for index.ts's own callers.
  addStringImports,
  addUnionImports,
  collectAllSourceImports,
  collectUsedExternImports,
} from "./registry/imports.js";
import { ensureArgcGlobal, ensureCurrentThisGlobal, ensureExtrasArgvGlobal } from "./statements/nested-declarations.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterArrayType,
  getOrRegisterSubviewType,
  getOrRegisterTemplateVecType,
  getOrRegisterVecType,
} from "./registry/types.js";
import {
  enableStdinReactor,
  ensureTimerHeap,
  exportDrainMicrotasksIfRegistered,
  getDrainFuncIdxForWasiStart,
  getRunLoopFuncIdxForWasiStart,
  shiftAsyncSideChannelFuncIdxs,
} from "./async-scheduler.js";
import { inLiveShiftRange } from "../emit/resolve-layout.js"; // (#1916 S3) stable handles never shift
import {
  brandExternMethodResult,
  ensureLateImport,
  flushLateImportShifts,
  registerAddStringImports,
  registerAddUnionImports,
} from "./shared.js";
import { stackBalance, getFixupEvents, summarizeFixups, strictBalanceDiagnostics } from "./stack-balance.js";
import { emitNativeParseNumber } from "./parse-number-native.js";
import { ensureRegexMatchVecType } from "./native-regex.js";
import { STANDALONE_REGEXP_REFLECTION_PROPS } from "./regexp-standalone.js";

// ── Extracted sub-modules ──────────────────────────────────────────────────
import {
  buildIsUndefinedExternBody,
  emitWrapperValueOfFunctions,
  ensureAnyFromExternHelper,
  ensureAnyHelpers,
  ensureAnyToExternHelper,
  ensureAnyValueType,
  ensureWrapperTypes,
  isAnyValue,
  undefinedSingletonActive,
} from "./any-helpers.js";
import { UNDEF_F64_BITS } from "./value-tags.js";
import {
  buildShapePropFlagsTable,
  collectClassDeclaration,
  collectDeclaredFuncRefs,
  compileClassBodies,
} from "./class-bodies.js";
import { classMemberFuncKey, fnctorAncestorOfClass, moduleHasFnctorSubclass } from "./class-member-keys.js"; // (#1983 / #3123)
import {
  applyShapeInference,
  collectDeclarations,
  inferNumericReturnTypes,
  collectEmptyObjectWidening,
  collectGrowableObjectLiterals,
  compileDeclarations,
  createUnifiedCollectorState,
  finalizeUnifiedCollector,
  unifiedVisitNode,
} from "./declarations.js";
import {
  destructureParamArray,
  destructureParamObject,
  destructureParamObjectExternref,
} from "./destructuring-params.js";
import {
  emitExceptionRenderExports,
  emitTestRuntimeStringHelpers,
  ensureAnyToStringHelper,
  ensureNativeStringExternBridge,
  ensureNativeStringHelpers,
  flatStringType,
  nativeStringType,
  nativeStringTypeNullable,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { emitJsonQuoteString } from "./json-runtime.js";
import { isSyntheticStructName, exportFunc } from "./emit-helpers.js"; // (#3272) DRY helpers
import {
  hasExportModifier,
  hasDeclareModifier,
  hasAsyncModifier,
  hasAbstractModifier,
  hasStaticModifier,
  isGeneratorFunction,
} from "./ast-modifiers.js"; // (#3272) extracted verbatim
import {
  LINEAR_U8_ARENA_START,
  reserveLinearU8AllocType,
  reserveTypedArraySubviewTypes,
  reserveObjVecArrType,
  reserveFnctorStructTypes,
  ensureLinearU8AllocHelper,
} from "./linear-type-reservations.js"; // (#3272) extracted verbatim
import {
  reserveVecMethodHelper,
  emitVecAccessExports,
  emitVecSetByteExport,
  emitNewVecF64Export,
  emitDataViewByteExports,
} from "./vec-access-exports.js"; // (#3272) extracted verbatim
import {
  emitClosureCallExport,
  emitClosureCallExport1,
  emitClosureCallExport2,
  emitClosureCallExport3,
  emitClosureCallExport4,
  emitClosureMethodCallExportN,
  emitIsClosureExport,
  emitClosureArityExport,
  emitIsDataStructExport,
  fillStandaloneTypeofClosureArms,
} from "./closure-exports.js"; // (#3272) extracted verbatim
import {
  emitStructFieldGetters,
  emitStructFieldSetters,
  resolveSameShapeFieldNameCollisions,
} from "./struct-field-exports.js"; // (#3272) extracted verbatim
import {
  registerWasiImports,
  emitDeferredWasiHelpers,
  ensureWasiStartExnPrinter,
  ensureWasiFdWriteAllHelper,
  ensureWasiWriteAnyStringHelper,
  ensureWasiWriteAnyStringFdHelper,
  ensureWasiWriteUint8ArrayHelper,
  ensureWasiWriteArrayBufferHelper,
  WASI_STDIN_BUF_START,
  WASI_WRITE_SCRATCH_START,
  WASI_FD_WRITE_MAX_CHUNK,
  WASI_READSYNC_IOV_OFFSET,
  WASI_READSYNC_NREAD_OFFSET,
} from "./wasi.js"; // (#3272) extracted verbatim
import {
  registerBuiltinExternClasses,
  getPseudoExternClassInfo,
  resolveMethodDispatchTarget,
  collectReferencedGlobalNames,
  collectExternDeclarations,
  collectDeclaredGlobals,
  registerNodeBuiltinImports,
  registerJsxRuntimeImports,
  sourceUsesLibGlobals,
  checkWasiDomUsage,
  rejectTimersUnderWasi,
  collectEnumDeclarations,
} from "./extern-declarations.js"; // (#3272) extracted verbatim

// ── Re-exports for public API compatibility ─────────────────────────────────
export {
  hasExportModifier,
  hasDeclareModifier,
  hasAsyncModifier,
  hasAbstractModifier,
  hasStaticModifier,
  isGeneratorFunction,
  reserveLinearU8AllocType,
  reserveTypedArraySubviewTypes,
  reserveObjVecArrType,
  reserveFnctorStructTypes,
  ensureLinearU8AllocHelper,
  reserveVecMethodHelper,
  emitDeferredWasiHelpers,
  ensureWasiFdWriteAllHelper,
  ensureWasiWriteAnyStringHelper,
  ensureWasiWriteAnyStringFdHelper,
  ensureWasiWriteUint8ArrayHelper,
  ensureWasiWriteArrayBufferHelper,
  WASI_STDIN_BUF_START,
  WASI_WRITE_SCRATCH_START,
  WASI_FD_WRITE_MAX_CHUNK,
  WASI_READSYNC_IOV_OFFSET,
  WASI_READSYNC_NREAD_OFFSET,
  registerBuiltinExternClasses,
  getPseudoExternClassInfo,
  resolveMethodDispatchTarget,
  collectEnumDeclarations,
  collectClassDeclaration,
  compileClassBodies,
  destructureParamArray,
  destructureParamObject,
  destructureParamObjectExternref,
  ensureAnyFromExternHelper,
  ensureAnyHelpers,
  ensureAnyToExternHelper,
  ensureAnyValueType,
  ensureNativeStringExternBridge,
  ensureNativeStringHelpers,
  ensureWrapperTypes,
  flatStringType,
  isAnyValue,
  nativeStringType,
  nativeStringTypeNullable,
};
/**
 * Report a codegen error with source location extracted from an AST node.
 * Pushes the error into ctx.errors so it can be propagated to the caller.
 */
/**
 * Extract a compile-time constant from a parameter initializer (#869).
 * Returns the constant default info if the initializer is a numeric/boolean literal,
 * undefined/null, or a unary minus on a numeric literal. Returns undefined otherwise.
 */
/**
 * TypedArray constructor names. Most still lower to `(ref null $Vec[f64])`;
 * native Uint8Array lowers to packed byte storage.
 */
export const TYPED_ARRAY_NAMES: ReadonlySet<string> = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
]);

function typedArrayNameFromTypeNode(node: ts.TypeNode): string | null {
  if (!ts.isTypeReferenceNode(node) || !ts.isIdentifier(node.typeName)) return null;
  return TYPED_ARRAY_NAMES.has(node.typeName.text) ? node.typeName.text : null;
}

// (#2593) Per-view packed storage for the integer typed arrays under
// standalone/WASI. A width-matched packed element type makes `array.set` truncate
// to the view's width (ToInt8/ToUint16/… for free) and `array.get_s`/`get_u`
// sign/zero-extend on read. Before #2593 only `Uint8Array` was packed (i8); every
// other integer view fell through to f64, which stored the full double with no
// width truncation. Float views stay f64. Host/gc mode stays f64 for all but
// Uint8Array — the JS-host marshalling boundary already classifies non-Uint8
// typed arrays as `number[]`-on-return; packing host-side risks that boundary and
// is deferred (#2593 note). The packed map is gated on `ctx.wasi || ctx.standalone`.
const TYPED_ARRAY_PACKED_STORAGE: Readonly<Record<string, { key: string; type: ValType }>> = {
  Int8Array: { key: "i8_byte", type: { kind: "i8" } },
  Uint8Array: { key: "i8_byte", type: { kind: "i8" } },
  Uint8ClampedArray: { key: "i8_byte", type: { kind: "i8" } },
  Int16Array: { key: "i16_byte", type: { kind: "i16" } },
  Uint16Array: { key: "i16_byte", type: { kind: "i16" } },
  // (#2835) Int32/Uint32 ELEMENT storage uses a DEDICATED `i32_elem` vec key —
  // SPLIT from the `i32_byte` key that backs the ArrayBuffer/DataView BYTE buffer.
  // Both shapes are `struct { length: i32, data: array(mut i32) }` today (PR-1 is a
  // pure refactor, no rep change), but they are semantically distinct: an
  // `i32_elem` slot holds a full 32-bit element, an `i32_byte` slot holds one byte
  // (0..255). Keeping them as one type blocked #2835 PR-2 from packing the byte
  // buffer to `array(mut i8)` — that would truncate every Int32/Uint32 element.
  // The split isolates the byte-buffer rep so PR-2 can repack `i32_byte` → i8 safely.
  Int32Array: { key: "i32_elem", type: { kind: "i32" } },
  Uint32Array: { key: "i32_elem", type: { kind: "i32" } },
};

/**
 * (#838) The two BigInt typed-array views. Unlike the numeric views these can
 * NOT fall back to `f64` element storage — an f64 cannot hold an arbitrary
 * 64-bit BigInt. They always use a dedicated `i64` element vec in BOTH the
 * host/gc and standalone/WASI lanes (BigInt is represented as a first-class
 * `{ kind: "i64", bigint: true }` value throughout the compiler, so `array.get`/
 * `array.set` on the i64 backing array need no packing/unpacking). `BigInt64Array`
 * stores signed 64-bit two's-complement; `BigUint64Array` stores the same 64 raw
 * bits interpreted unsigned — the wasm i64 element holds identical bits either
 * way (ToBigInt64/ToBigUint64 both reduce mod 2^64, which i64 arithmetic already
 * does), so both map to the same `i64` storage.
 */
export const BIGINT_TYPED_ARRAY_NAMES: ReadonlySet<string> = new Set(["BigInt64Array", "BigUint64Array"]);

export function typedArrayVecStorage(ctx: CodegenContext, name: string): { key: string; type: ValType } {
  // (#838) BigInt views always use i64 storage, independent of target mode —
  // f64 cannot represent a 64-bit BigInt.
  if (BIGINT_TYPED_ARRAY_NAMES.has(name)) return { key: "i64", type: { kind: "i64" } };
  if (ctx.wasi || ctx.standalone) {
    const packed = TYPED_ARRAY_PACKED_STORAGE[name];
    if (packed) return packed;
  }
  return { key: "f64", type: { kind: "f64" } };
}

/**
 * (#2593) The signedness of a packed integer typed-array element, driving the
 * read opcode: `array.get_s` for signed views (`Int8`/`Int16`/`Int32`),
 * `array.get_u` for unsigned (`Uint8`/`Uint8Clamped`/`Uint16`/`Uint32`). MUST be
 * keyed on the TS view NAME, not the storage kind — a signed `Int8Array` and an
 * unsigned `Uint8Array` share `i8` storage but read with opposite extension.
 * Returns undefined for non-integer views (Float*, or a non-typed-array name).
 */
export function typedArrayPackedSignedness(name: string): "s" | "u" | undefined {
  switch (name) {
    case "Int8Array":
    case "Int16Array":
    case "Int32Array":
      return "s";
    case "Uint8Array":
    case "Uint8ClampedArray":
    case "Uint16Array":
    case "Uint32Array":
      return "u";
    default:
      return undefined;
  }
}

/**
 * (#1700) Classify a TS type at an export boundary for the runtime
 * `wrapExports` marshalling step. The Wasm signature for `Uint8Array` and
 * `number[]` is identical (`(ref null $Vec[f64])`), so we surface the
 * TS-level distinction as metadata.
 *
 * - "uint8array"  → caller may pass JS Uint8Array; result-side wraps as Uint8Array
 * - "typed-array" → any other TypedArray (Int8Array / Float32Array / ...) — v1
 *                   treats these like number[] on the return path; tracked for
 *                   element-fidelity follow-up
 * - "other"       → not a typed array; wrapper is a no-op for this slot
 */
export function classifyTypedArrayType(
  tsType: ts.Type,
  checker: ts.TypeChecker,
): import("../ir/types.js").TypedArrayKind {
  // Strip null/undefined/void/Promise wrappers so `Uint8Array | undefined`,
  // `Promise<Uint8Array>` etc. still classify. Match `resolveWasmType`'s
  // own unwrapping rules.
  let t = tsType;
  if (t.isUnion()) {
    const non = t.types.filter(
      (x) => !(x.flags & ts.TypeFlags.Null) && !(x.flags & ts.TypeFlags.Undefined) && !(x.flags & ts.TypeFlags.Void),
    );
    if (non.length === 1) t = non[0]!;
  }
  const sym = t.aliasSymbol ?? t.getSymbol();
  if (sym?.name === "Promise") {
    const args = checker.getTypeArguments(t as ts.TypeReference);
    if (args.length > 0) return classifyTypedArrayType(args[0]!, checker);
  }
  const name = sym?.name;
  if (!name || !TYPED_ARRAY_NAMES.has(name)) return "other";
  return name === "Uint8Array" ? "uint8array" : "typed-array";
}

function sourceContainsClass(sourceFile: ts.SourceFile): boolean {
  let found = false;
  function walk(node: ts.Node): void {
    if (found) return;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      found = true;
      return;
    }
    forEachChild(node, walk);
  }
  walk(sourceFile);
  return found;
}

/**
 * (#2179) True when the source contains a `delete` operating on a property or
 * element access (`delete o.a` / `delete o[k]`). `delete x` of a bare
 * identifier and `delete <other expr>` (no-op deletes) do NOT count — only
 * member deletes can leave a runtime tombstone that the inline struct.get
 * read fast-path would bypass. Used to gate the tombstone-aware read routing
 * so delete-free modules emit byte-identical wasm.
 */
function sourceContainsDelete(sourceFile: ts.SourceFile): boolean {
  let found = false;
  function walk(node: ts.Node): void {
    if (found) return;
    if (
      ts.isDeleteExpression(node) &&
      (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))
    ) {
      found = true;
      return;
    }
    forEachChild(node, walk);
  }
  walk(sourceFile);
  return found;
}

/**
 * (#3057) True when the source dynamically constructs a `$__ta_dyn_view` —
 * `new <ctorExpr>(bufferArg[, off[, len]])` where `<ctorExpr>` is an IDENTIFIER
 * that is NOT a statically-named TA constructor (so it's a TA constructor held in
 * a variable / array element, type `any` or a TA-ctor union — test262
 * `for (ctor of ctors) new ctor(rab, …)` / `CreateRabForTest`) and NOT a user
 * class. Mirrors the runtime dynamic-construct gate in `new-super.ts` (buffer-typed
 * first arg, non-numeric-literal). Used to enable the runtime-kind element byte
 * codec on the generic index path for helper functions compiled BEFORE the
 * construct (the `$__ta_dyn_view` type registers lazily). Byte-inert: modules
 * without this pattern never set the flag, so they never emit the codec arm.
 */
function sourceHasDynamicTaConstruct(checker: ts.TypeChecker, sourceFile: ts.SourceFile): boolean {
  // (#3272) Reuse the module-level TYPED_ARRAY_NAMES set — identical 9 names.
  const TA_NAMES = TYPED_ARRAY_NAMES;
  let found = false;
  function walk(node: ts.Node): void {
    if (found) return;
    if (ts.isNewExpression(node)) {
      let callee: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(callee) || ts.isAsExpression(callee) || ts.isNonNullExpression(callee)) {
        callee = callee.expression;
      }
      if (ts.isIdentifier(callee)) {
        // Static TA name (`new Uint8Array(buf)`) is handled by the static view
        // ctor path, never the dynamic one — skip it.
        if (!TA_NAMES.has(callee.text)) {
          // A user class callee resolves to a ClassDeclaration value — skip; only
          // a value-bound ctor (variable / param / any) reaches the dynamic path.
          const sym = checker.getSymbolAtLocation(callee);
          const decl = sym?.valueDeclaration;
          const isUserClass = decl !== undefined && ts.isClassDeclaration(decl);
          if (!isUserClass) {
            const arg0 = node.arguments && node.arguments.length >= 1 ? node.arguments[0]! : undefined;
            // Buffer-typed first arg gates the dynamic TA construct (the #3054 D
            // buffer form) — excludes `new fn(x)` on unrelated identifiers.
            if (arg0 !== undefined && !ts.isNumericLiteral(arg0)) {
              let arg0Sym: string | undefined;
              try {
                arg0Sym = checker.getTypeAtLocation(arg0).getSymbol?.()?.name;
              } catch {
                arg0Sym = undefined;
              }
              if (arg0Sym === "ArrayBuffer" || arg0Sym === "SharedArrayBuffer" || arg0Sym === "DataView") {
                found = true;
                return;
              }
            }
            // (#2872) General dynamic-ctor forms — `new TA(3)`, `new TA([…])`,
            // `new TA(otherTA)`, `new TA()` on a GENUINELY-dynamic callee (an
            // `any`/`unknown`-typed param / variable / binding element declared
            // in real source — the `testWithTypedArrayConstructors(TA => …)`
            // harness shape). Mirrors `resolvesToDynamicAnyCtorValue`
            // (new-super.ts): declaration-file symbols (ambient globals) and
            // typed function/class bindings never set the flag, so ordinary
            // `new F(...)` function-ctor modules stay byte-identical.
            if (
              decl !== undefined &&
              !decl.getSourceFile().isDeclarationFile &&
              (ts.isParameter(decl) || ts.isVariableDeclaration(decl) || ts.isBindingElement(decl))
            ) {
              try {
                const calleeType = checker.getTypeAtLocation(callee);
                if ((calleeType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) {
                  found = true;
                  return;
                }
              } catch {
                /* type resolution failure — leave the flag unset */
              }
            }
          }
        }
      }
    }
    forEachChild(node, walk);
  }
  walk(sourceFile);
  return found;
}

/**
 * #1623 — true when the source contains any object/array binding pattern
 * (destructuring) in a parameter, variable declaration, or assignment target.
 * Used to decide whether to pre-emit the WASI/standalone TypeError constructor
 * before user functions compile, so the destructuring null-throw guard's
 * `emitWasiErrorConstructor` call doesn't run mid-prologue and clobber a
 * reserved user-function slot.
 */
function sourceContainsBindingPattern(sourceFile: ts.SourceFile): boolean {
  let found = false;
  function walk(node: ts.Node): void {
    if (found) return;
    if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
      found = true;
      return;
    }
    forEachChild(node, walk);
  }
  walk(sourceFile);
  return found;
}

/**
 * (#1719 S1) Whole-program pre-scan for the `ITER_OVERRIDDEN` brand of the
 * array object-value representation track. Returns true iff the source may
 * monkeypatch `Array.prototype`'s iterator surface, i.e. it contains:
 *   (i)  an assignment `Array.prototype[Symbol.iterator] = …` or
 *        `Array.prototype.values = …` (any element/property access whose
 *        object is `Array.prototype`), OR
 *   (ii) `Object.defineProperty(Array.prototype, …)` /
 *        `Object.defineProperties(Array.prototype, …)`.
 *
 * When this returns false (the overwhelming common case), the array
 * destructuring / spread / for-of fast paths are provably unaffected by any
 * prototype override and stay byte-identical (see `arrayDstrNeedsIdentity`).
 * When true, the S2 slice routes a branded array RHS through the host-Array
 * reflection + host `GetIterator` so the override's `@@iterator` is observed
 * (§7.4.2 GetIterator, §8.5.2 IteratorBindingInitialization).
 *
 * Reused verbatim from the dev-a `issue-1719-impl` scaffolding (the front-end
 * half the architecture spec endorses keeping). Conservative by design: it
 * over-approximates (a false positive only costs the S2 slow path, never
 * correctness) and never under-approximates a literal `Array.prototype` LHS.
 */
export function sourceOverridesArrayIterator(sourceFile: ts.SourceFile): boolean {
  let found = false;
  // Strip `as`/`!`/type-assertion/paren wrappers so `(Array.prototype as any)[…]`
  // and `(Array.prototype)[…]` match the same as the bare form.
  function unwrap(e: ts.Expression): ts.Expression {
    let cur = e;
    while (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = ts.isParenthesizedExpression(cur)
        ? cur.expression
        : ts.isAsExpression(cur)
          ? cur.expression
          : ts.isNonNullExpression(cur)
            ? cur.expression
            : (cur as ts.TypeAssertion).expression;
    }
    return cur;
  }
  // `e` is the object being assigned INTO: match `Array.prototype[...]`
  // (element access) or `Array.prototype.values` (property access).
  function isArrayProtoLHS(e: ts.Expression): boolean {
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const obj = unwrap(e.expression);
      return (
        ts.isPropertyAccessExpression(obj) &&
        obj.name.text === "prototype" &&
        ts.isIdentifier(obj.expression) &&
        obj.expression.text === "Array"
      );
    }
    return false;
  }
  function walk(node: ts.Node): void {
    if (found) return;
    // (i) assignment: Array.prototype[Symbol.iterator] = … / Array.prototype.values = …
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isArrayProtoLHS(node.left)
    ) {
      found = true;
      return;
    }
    // (ii) Object.defineProperty(Array.prototype, …) / Object.defineProperties(Array.prototype, …)
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const arg0 = node.arguments[0];
      if (
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Object" &&
        (callee.name.text === "defineProperty" || callee.name.text === "defineProperties") &&
        arg0 !== undefined &&
        ts.isPropertyAccessExpression(arg0) &&
        arg0.name.text === "prototype" &&
        ts.isIdentifier(arg0.expression) &&
        arg0.expression.text === "Array"
      ) {
        found = true;
        return;
      }
    }
    forEachChild(node, walk);
  }
  walk(sourceFile);
  return found;
}

/**
 * Fold a default-parameter initializer to a compile-time numeric constant (#869).
 *
 * Handles pure literal-composed expressions — numeric literals, the read-only
 * numeric globals `NaN`/`Infinity`/`undefined`, parenthesized expressions,
 * unary `-`/`+`/`~`/`!`/`void`, and binary arithmetic/bitwise/logical operators
 * — so defaults like `= 30 * 1000`, `= 1 << 4`, `= 60 * 60`, or `= Infinity`
 * take the clean caller-side direct-emit path instead of the sNaN sentinel.
 *
 * IMPORTANT — identifier handling is deliberately narrow. Only the read-only
 * numeric globals (`NaN`/`Infinity`/`undefined`) and **immutable `const`
 * numeric bindings** are folded. `let`/`var` are NEVER folded: a default like
 * `= base` over a reassignable binding must observe the CURRENT value of `base`
 * at call time (§10.2.11), so folding it to the binding's initializer would be a
 * correctness regression. `const` is safe precisely because it cannot be
 * reassigned — its value is fixed for the program's lifetime. `const` resolution
 * is delegated to `ctx.oracle.constInitializerOf` (the checker boundary); when
 * `ctx` is absent, `const` folding is simply skipped (identical to prior
 * behavior). Any operand that is not itself constant-foldable makes the whole
 * expression unfoldable (returns `undefined`), so side-effecting operands
 * (`void foo()`, `a + bar()`) are never dropped — they fall through to the
 * existing expression-default path.
 *
 * The evaluation uses native JS operators, which already apply the correct
 * ECMAScript coercions (ToInt32 for bitwise, IEEE-754 for arithmetic), so the
 * folded value byte-matches what the callee would have computed.
 */
export function foldConstantNumericDefault(expr: ts.Expression, ctx?: CodegenContext, depth = 0): number | undefined {
  if (ts.isNumericLiteral(expr)) return Number(expr.text);
  if (ts.isParenthesizedExpression(expr)) return foldConstantNumericDefault(expr.expression, ctx, depth);
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 1;
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 0;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return 0;
  if (expr.kind === ts.SyntaxKind.UndefinedKeyword) return NaN;
  if (ts.isIdentifier(expr)) {
    // The read-only numeric globals first — never shadowable to a foldable
    // value in practice, and cheap to special-case.
    switch (expr.text) {
      case "NaN":
        return NaN;
      case "Infinity":
        return Infinity;
      case "undefined":
        return NaN;
    }
    // Immutable `const` numeric binding: resolve to the const's initializer and
    // fold that. `let`/`var` are excluded by the oracle (reassignable → must
    // read the call-time value). `depth` bounds pathological const chains.
    if (ctx && depth < 16) {
      const init = ctx.oracle.constInitializerOf(expr);
      if (init) return foldConstantNumericDefault(init, ctx, depth + 1);
    }
    return undefined;
  }
  if (ts.isVoidExpression(expr)) {
    // `void <constant>` → undefined → NaN, but only when the operand is itself
    // foldable so a side-effecting operand (`void foo()`) is never dropped.
    return foldConstantNumericDefault(expr.expression, ctx, depth) === undefined ? undefined : NaN;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    const v = foldConstantNumericDefault(expr.operand, ctx, depth);
    if (v === undefined) return undefined;
    switch (expr.operator) {
      case ts.SyntaxKind.MinusToken:
        return -v;
      case ts.SyntaxKind.PlusToken:
        return +v;
      case ts.SyntaxKind.TildeToken:
        return ~v;
      case ts.SyntaxKind.ExclamationToken:
        return v ? 0 : 1;
      default:
        return undefined;
    }
  }
  if (ts.isBinaryExpression(expr)) {
    const l = foldConstantNumericDefault(expr.left, ctx, depth);
    if (l === undefined) return undefined;
    const r = foldConstantNumericDefault(expr.right, ctx, depth);
    if (r === undefined) return undefined;
    switch (expr.operatorToken.kind) {
      case ts.SyntaxKind.PlusToken:
        return l + r;
      case ts.SyntaxKind.MinusToken:
        return l - r;
      case ts.SyntaxKind.AsteriskToken:
        return l * r;
      case ts.SyntaxKind.SlashToken:
        return l / r;
      case ts.SyntaxKind.PercentToken:
        return l % r;
      case ts.SyntaxKind.AsteriskAsteriskToken:
        return l ** r;
      case ts.SyntaxKind.LessThanLessThanToken:
        return l << r;
      case ts.SyntaxKind.GreaterThanGreaterThanToken:
        return l >> r;
      case ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken:
        return l >>> r;
      case ts.SyntaxKind.AmpersandToken:
        return l & r;
      case ts.SyntaxKind.BarToken:
        return l | r;
      case ts.SyntaxKind.CaretToken:
        return l ^ r;
      case ts.SyntaxKind.AmpersandAmpersandToken:
        return l && r;
      case ts.SyntaxKind.BarBarToken:
        return l || r;
      case ts.SyntaxKind.QuestionQuestionToken:
        // Numeric operands are never null/undefined, so the left value wins.
        return l;
      default:
        return undefined;
    }
  }
  return undefined;
}

export function extractConstantDefault(
  initializer: ts.Expression,
  paramType: ValType,
  ctx?: CodegenContext,
): OptionalParamInfo["constantDefault"] {
  if (paramType.kind === "f64") {
    if (ts.isNumericLiteral(initializer)) {
      return { kind: "f64", value: Number(initializer.text) };
    }
    // true/false → 1/0 in f64 context
    if (initializer.kind === ts.SyntaxKind.TrueKeyword) {
      return { kind: "f64", value: 1 };
    }
    if (initializer.kind === ts.SyntaxKind.FalseKeyword) {
      return { kind: "f64", value: 0 };
    }
    // undefined → NaN in f64 context
    if (
      initializer.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(initializer) && initializer.text === "undefined")
    ) {
      return { kind: "f64", value: NaN };
    }
    // null → 0 in f64 context
    if (initializer.kind === ts.SyntaxKind.NullKeyword) {
      return { kind: "f64", value: 0 };
    }
    // Unary minus: -42
    if (
      ts.isPrefixUnaryExpression(initializer) &&
      initializer.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(initializer.operand)
    ) {
      return { kind: "f64", value: -Number(initializer.operand.text) };
    }
    // Unary plus: +42
    if (
      ts.isPrefixUnaryExpression(initializer) &&
      initializer.operator === ts.SyntaxKind.PlusToken &&
      ts.isNumericLiteral(initializer.operand)
    ) {
      return { kind: "f64", value: Number(initializer.operand.text) };
    }
    // Compile-time-constant numeric expressions: `30 * 1000`, `1 << 4`,
    // `Infinity`, immutable `const` numeric bindings, etc. (#869) — emitted
    // directly at the call site.
    const folded = foldConstantNumericDefault(initializer, ctx);
    if (folded !== undefined) return { kind: "f64", value: folded };
    return undefined;
  }
  if (paramType.kind === "i32") {
    if (ts.isNumericLiteral(initializer)) {
      return { kind: "i32", value: Number(initializer.text) | 0 };
    }
    if (initializer.kind === ts.SyntaxKind.TrueKeyword) {
      return { kind: "i32", value: 1 };
    }
    if (initializer.kind === ts.SyntaxKind.FalseKeyword) {
      return { kind: "i32", value: 0 };
    }
    if (
      initializer.kind === ts.SyntaxKind.NullKeyword ||
      initializer.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(initializer) && initializer.text === "undefined")
    ) {
      return { kind: "i32", value: 0 };
    }
    if (
      ts.isPrefixUnaryExpression(initializer) &&
      initializer.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(initializer.operand)
    ) {
      return { kind: "i32", value: -Number(initializer.operand.text) | 0 };
    }
    // Compile-time-constant numeric expressions folded to a JS number, then
    // ToInt32-truncated (`| 0`) for the i32 slot — matches the callee's
    // coercion of the same default (#869). NaN/Infinity truncate to 0.
    const folded = foldConstantNumericDefault(initializer, ctx);
    if (folded !== undefined) return { kind: "i32", value: folded | 0 };
    return undefined;
  }
  // For ref types (externref, ref_null, etc.), constant defaults not supported yet
  return undefined;
}

/**
 * Lift a propagated lattice type into the backend IrType used by the IR
 * lowerer. Only concrete primitives are valid here; the caller must have
 * ensured the lattice entry is `f64` or `bool`. Non-primitive entries
 * throw — the caller should guard with `isConcreteLattice` first.
 */
function latticeToIr(t: LatticeType): IrType {
  if (t.kind === "f64") return irVal({ kind: "f64" });
  if (t.kind === "bool") return irVal({ kind: "i32" });
  // #1169a — strings flow as the backend-agnostic `IrType.string`; the
  // resolver picks the concrete Wasm representation at lowering time.
  if (t.kind === "string") return { kind: "string" };
  throw new Error(`latticeToIr: non-primitive lattice type ${t.kind}`);
}

function isConcreteLattice(t: LatticeType | undefined): t is LatticeType & { kind: "f64" | "bool" | "string" } {
  return t !== undefined && (t.kind === "f64" || t.kind === "bool" || t.kind === "string");
}

/**
 * Resolve the IR type for a function's param or return position, using
 * the AST's explicit TypeNode first (authoritative) and the TypeMap
 * lattice entry only as a fallback. If neither yields a concrete
 * primitive (or, slice 2, a representable object shape) this is a
 * selector bug — throw so the caller can skip the function and fall
 * through to legacy.
 *
 * #1169b widens this to accept TypeLiteral / TypeReference TypeNodes
 * by deriving an `IrType.object` from the TS checker. Shapes that the
 * resolver can't faithfully represent (callable types, methods,
 * non-primitive non-object fields, empty objects) cause the helper to
 * return `null`; the caller then throws so the function falls back to
 * the legacy path.
 */
function resolvePositionType(
  node: ts.TypeNode | undefined,
  mapped: LatticeType | undefined,
  ctx: CodegenContext,
  classShapes?: ReadonlyMap<string, import("../ir/nodes.js").IrClassShape>,
): IrType {
  if (node) {
    // `readonly T[]` parses as a `readonly`-TypeOperatorNode wrapping the array
    // type. `readonly` is a TS-only modifier with no runtime representation, so
    // resolve the inner type directly (parallels the ReadonlyArray handling in
    // resolveWasmType — #1748).
    if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
      return resolvePositionType(node.type, mapped, ctx, classShapes);
    }
    if (node.kind === ts.SyntaxKind.NumberKeyword) return irVal({ kind: "f64" });
    if (node.kind === ts.SyntaxKind.BooleanKeyword) return irVal({ kind: "i32" });
    if (node.kind === ts.SyntaxKind.StringKeyword) return { kind: "string" };
    // (#2949 slice 3b) AnyKeyword IS the dynamic type. The historical #1228
    // mapping (externref in ALL modes) diverged from legacy's fast-mode
    // `any` ABI — legacy `resolveWasmType` is mode-split (fast →
    // `ref_null $AnyValue`, host → externref), so an IR-claimed
    // `f(x: any)` had a DIFFERENT fast-mode signature than its legacy
    // callers/callees (measured in the slice-2 session; class-method
    // claims hit the typeIdx-parity guard for the same reason). `dynamic`
    // lowers through `resolveDynamic()`, which mirrors that mode split
    // exactly — one `any` ABI for both front-ends in both modes. Host-mode
    // bytes are unchanged (dynamic lowers to externref there).
    if (node.kind === ts.SyntaxKind.AnyKeyword) return irDynamic();
    // Slice 6 part 2 (#1181) — array type (T[] or Array<T>) resolves to a
    // vec ref. The legacy `getOrRegisterVecType` produces the same
    // (ref_null $vec_<elem>) struct ref the for-of vec fast path needs,
    // and the IR resolver's `resolveVec` (in integration.ts) reads the
    // struct shape back to recover element ValType. Numeric / boolean /
    // string element types are accepted; nested-vec or object-element
    // types throw and fall back to legacy.
    if (ts.isArrayTypeNode(node)) {
      const elemIr = resolvePositionType(node.elementType, undefined, ctx, classShapes);
      // (#2949 slice 3b) `any[]` elements keep their historical externref
      // vec representation — the AnyKeyword POSITION arm above now returns
      // `dynamic`, but element storage is a vec-layout decision (the
      // boxed-any element rep is #2379/#1852 territory, not this slice).
      // Byte-preserving for every currently-claimed `any[]` shape.
      const elemVal =
        elemIr.kind === "val"
          ? elemIr.val
          : elemIr.kind === "string" || elemIr.kind === "dynamic"
            ? ({ kind: "externref" } as ValType)
            : null;
      if (!elemVal) {
        throw new Error(
          `array element TypeNode ${ts.SyntaxKind[node.elementType.kind]} could not be lowered to a primitive ValType`,
        );
      }
      const elemKey =
        elemVal.kind === "ref" || elemVal.kind === "ref_null"
          ? `ref_${(elemVal as { typeIdx: number }).typeIdx}`
          : elemVal.kind;
      const vecIdx = getOrRegisterVecType(ctx, elemKey, elemVal);
      return irVal({ kind: "ref_null", typeIdx: vecIdx });
    }
    if (ts.isTypeLiteralNode(node) || ts.isTypeReferenceNode(node)) {
      // Slice 4 (#1169d) — TypeReferenceNode that names a local class
      // resolves to `IrType.class`. The classShapes registry is seeded
      // by `buildIrClassShapes` from the legacy class registry before
      // the IR runs. Take this path FIRST: classes also satisfy the
      // generic `objectIrTypeFromTsType` heuristic (they're "Object"
      // type-flag types), so without the explicit class detection we'd
      // fall into the data-object path, which doesn't carry method or
      // constructor info.
      if (classShapes && ts.isTypeReferenceNode(node)) {
        const ref = node.typeName;
        if (ts.isIdentifier(ref)) {
          const cs = classShapes.get(ref.text);
          if (cs) return { kind: "class", shape: cs };
        }
      }
      // TypedArray<TArrayBuffer> (TS 5.7+) carries an ArrayBufferLike type
      // argument that is erased at runtime. Lower it exactly like the bare
      // typed-array annotation.
      const typedArrayName = typedArrayNameFromTypeNode(node);
      if (typedArrayName) {
        const storage = typedArrayVecStorage(ctx, typedArrayName);
        const vecIdx = getOrRegisterVecType(ctx, storage.key, storage.type);
        return irVal({ kind: "ref_null", typeIdx: vecIdx });
      }
      // Slice 6 part 2 (#1181) — `Array<T>` TypeReferenceNode resolves
      // to a vec ref, parallel to the `T[]` ArrayTypeNode arm above.
      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        (node.typeName.text === "Array" || node.typeName.text === "ReadonlyArray")
      ) {
        const typeArgs = node.typeArguments;
        if (typeArgs && typeArgs.length === 1) {
          const elemIr = resolvePositionType(typeArgs[0]!, undefined, ctx, classShapes);
          const elemVal =
            elemIr.kind === "val" ? elemIr.val : elemIr.kind === "string" ? ({ kind: "externref" } as ValType) : null;
          if (!elemVal) {
            throw new Error(
              `Array<T> element TypeNode ${ts.SyntaxKind[typeArgs[0]!.kind]} could not be lowered to a primitive ValType`,
            );
          }
          const elemKey =
            elemVal.kind === "ref" || elemVal.kind === "ref_null"
              ? `ref_${(elemVal as { typeIdx: number }).typeIdx}`
              : elemVal.kind;
          const vecIdx = getOrRegisterVecType(ctx, elemKey, elemVal);
          return irVal({ kind: "ref_null", typeIdx: vecIdx });
        }
      }
      // Slice 6 part 3 (#1182) — built-in generic iterables (Map / Set /
      // WeakMap / WeakSet / Iterable / Iterator / Generator / Async*).
      // These all have host-managed runtime representations and the IR
      // doesn't model their internal structure; treat them as opaque
      // externref values. The IR's iter-host arm of `lowerForOfStatement`
      // accepts externref iterables and routes them through the
      // `__iterator` host import.
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        const name = node.typeName.text;
        if (
          name === "Map" ||
          name === "Set" ||
          name === "WeakMap" ||
          name === "WeakSet" ||
          name === "Iterable" ||
          name === "Iterator" ||
          name === "IterableIterator" ||
          name === "Generator" ||
          name === "AsyncIterable" ||
          name === "AsyncIterator" ||
          name === "AsyncGenerator"
        ) {
          return irVal({ kind: "externref" });
        }
      }
      // (#2856) Host extern class annotation (`: HTMLElement`, `: Element`,
      // …) — an ambient lib interface the legacy backend models as an extern
      // class (opaque externref + per-member `<Class>_get_<p>` /
      // `<Class>_<m>` imports). JS-host lane only; in host-free modes the
      // object-lowering fallback below keeps throwing (→ legacy → the
      // existing #1472 refusal). Placed AFTER the local-class / typed-array /
      // Array / iterable arms so it can't shadow them, and BEFORE
      // `objectIrTypeFromTsType`, which rejects method-carrying interfaces
      // anyway.
      if (
        ts.isTypeReferenceNode(node) &&
        ts.isIdentifier(node.typeName) &&
        !(ctx.standalone || ctx.wasi || ctx.strictNoHostImports)
      ) {
        const refType = ctx.checker.getTypeFromTypeNode(node);
        if (isExternalDeclaredClass(refType, ctx.checker)) {
          return { kind: "extern", className: refType.getSymbol()?.name ?? node.typeName.text };
        }
      }
      const tsType = ctx.checker.getTypeFromTypeNode(node);
      const ir = objectIrTypeFromTsType(ctx, tsType);
      if (ir) return ir;
      throw new Error(`object TypeNode ${ts.SyntaxKind[node.kind]} could not be lowered to IrType.object`);
    }
    // #2859 — function-typed position (`fn: () => number`). Mirrors the
    // selector's `resolveParamType` FunctionTypeNode arm: the signature is
    // built by the SAME helper, so the override the lowerer receives compares
    // `irTypeEquals`-equal to the signature a slice-3 closure literal argument
    // produces. A claimed function reaching the throw below means selector and
    // override builder diverged (the standard out-of-sync guard → legacy).
    if (ts.isFunctionTypeNode(node)) {
      const signature = irClosureSignatureFromFunctionTypeNode(node);
      if (signature) return { kind: "closure", signature };
      throw new Error(`function TypeNode not expressible as an IR closure signature`);
    }
    throw new Error(`unsupported TypeNode kind ${ts.SyntaxKind[node.kind]}`);
  }
  if (isConcreteLattice(mapped)) return latticeToIr(mapped);
  if (mapped?.kind === "object") {
    // #1231 Phase 1 — the lattice carries a recursive structural shape
    // (`fields: { name, type }[]`) so we can build an `IrType.object`
    // directly from flow evidence, without consulting the TS checker.
    // This is what enables typed structs (e.g. `(field $x f64)`) for
    // unannotated functions like `function createPoint(x, y) { return {x, y}; }`.
    const ir = objectIrTypeFromLattice(mapped);
    if (ir) return ir;
    throw new Error(`object position type — lattice shape not lowerable to IrType.object`);
  }
  // #2949 slice 2 — UNANNOTATED position whose lattice converged to `unknown`
  // (no evidence) or `dynamic` (top): the position is honestly dynamic. MUST
  // stay predicate-identical to the selector's `resolveParamType` /
  // `resolveReturnType` dynamic arms (select.ts) — the selector claims
  // exactly the functions this resolver maps, so a drift here would either
  // drop claimed functions at resolve time (kind "resolve" demotions) or
  // hand the from-ast builder types the move-only scan never approved.
  // Lowering: `lowerIrTypeToValType`'s dynamic arm → `resolveDynamic()` =
  // legacy `resolveWasmType`'s any/unknown carrier (fast: ref_null $AnyValue,
  // host: externref), so the claimed function's Wasm signature equals what
  // legacy gives the same declaration. `node` is undefined here (annotated
  // positions — including element/field recursion, which always passes a
  // node — returned or threw above).
  if (mapped && (mapped.kind === "unknown" || mapped.kind === "dynamic")) {
    return irDynamic();
  }
  throw new Error(`no concrete type (mapped=${mapped?.kind ?? "missing"})`);
}

/**
 * #1231 Phase 1 — walk a `LatticeType` (must be `kind: "object"`) into
 * an `IrType.object`. Each field's atom is recursively mapped to an
 * `IrType` (primitives → `IrType.val`, strings → `IrType.string`,
 * nested objects → recursive call). Returns `null` if any field fails
 * to lower so the caller can fall back to legacy.
 *
 * The resulting `IrType.object` is consumed by the IR's
 * `ObjectStructRegistry` (in `src/ir/integration.ts`) which dedups by
 * the legacy `fieldsHashKey` — so a lattice-derived `{x: f64, y: f64}`
 * produces the same anonymous struct (`__anon_<n>`) the legacy path
 * would have produced for an explicit `{ x: number, y: number }`
 * annotation.
 */
function objectIrTypeFromLattice(t: LatticeType): IrType | null {
  if (t.kind !== "object") return null;
  if (t.fields.length === 0) return null;
  const fields: { name: string; type: IrType }[] = [];
  for (const f of t.fields) {
    const ir = atomToFieldIr(f.type);
    if (!ir) return null;
    fields.push({ name: f.name, type: ir });
  }
  // Lattice atom field lists are canonicalised at construction time,
  // but the IrObjectShape contract is "sorted by name" — re-sort here
  // defensively (cheap; matches `objectIrTypeFromTsType`).
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: "object", shape: { fields } };
}

/**
 * Map a `LatticeAtom` to its `IrType` field-position lowering.
 * Mirrors `tsTypeToFieldIr` — but driven by flow evidence rather than
 * the TS checker. Returns `null` for atoms whose IR projection isn't
 * representable in field position (none today; reserved for forward
 * compatibility).
 */
function atomToFieldIr(a: import("../ir/propagate.js").LatticeAtom): IrType | null {
  if (a.kind === "f64") return irVal({ kind: "f64" });
  if (a.kind === "bool") return irVal({ kind: "i32" });
  if (a.kind === "string") return { kind: "string" };
  // A LatticeAtom of `kind: "object"` is also a LatticeType, so pass it
  // through to recurse over the nested field list.
  if (a.kind === "object") return objectIrTypeFromLattice(a);
  return null;
}

/**
 * Convert a TypeScript object type to an `IrType.object` shape.
 * Returns `null` if the type isn't a plain "data" object — methods,
 * getters, callable types, external declared classes, tuples, and
 * shapes containing fields the IR can't represent fall back to legacy.
 *
 * Field names are sorted into canonical (ascending) order to match
 * the `IrObjectShape` invariant.
 */
function objectIrTypeFromTsType(ctx: CodegenContext, tsType: ts.Type): IrType | null {
  if (!(tsType.flags & ts.TypeFlags.Object)) return null;
  if (tsType.getCallSignatures().length > 0) return null; // callable
  if (isExternalDeclaredClass(tsType, ctx.checker)) return null;
  if (isTupleType(tsType)) return null;

  const props = tsType.getProperties();
  if (props.length === 0) return null; // empty object — defer to a future slice

  const fields: { name: string; type: IrType }[] = [];
  for (const prop of props) {
    const decl = prop.valueDeclaration;
    if (
      decl &&
      (ts.isMethodDeclaration(decl) || ts.isGetAccessorDeclaration(decl) || ts.isSetAccessorDeclaration(decl))
    ) {
      return null;
    }
    const propType = ctx.checker.getTypeOfSymbol(prop);
    const fieldIr = tsTypeToFieldIr(ctx, propType);
    if (!fieldIr) return null;
    fields.push({ name: prop.name, type: fieldIr });
  }
  fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: "object", shape: { fields } };
}

/**
 * Field-type subset for object shapes: primitives + nested objects +
 * strings. Anything else (any/unknown/union/array/etc.) returns null,
 * which causes `objectIrTypeFromTsType` to bail and the function to
 * fall back to legacy.
 */
function tsTypeToFieldIr(ctx: CodegenContext, t: ts.Type): IrType | null {
  if (t.flags & ts.TypeFlags.NumberLike) return irVal({ kind: "f64" });
  if (t.flags & ts.TypeFlags.BooleanLike) return irVal({ kind: "i32" });
  if (t.flags & ts.TypeFlags.StringLike) return { kind: "string" };
  if (t.flags & ts.TypeFlags.Object) return objectIrTypeFromTsType(ctx, t);
  return null;
}

/**
 * Slice 4 (#1169d): build the per-class IR shape registry from the
 * legacy class collection state. Only top-level `ts.ClassDeclaration`
 * nodes are included (no class expressions, no nested-in-function
 * classes — same scope as the IR selector's `localClasses` set).
 *
 * The returned map carries:
 *   - `fields`: user-visible struct fields in canonical (alphabetical)
 *               order. The legacy `__tag` prefix is stripped here so
 *               consumers see only TS-source-level fields. The IR's
 *               `IrType.class` doesn't expose the tag; the resolver
 *               accounts for it when computing Wasm field indices.
 *   - `methods`: instance methods only (no static methods). Their
 *                signatures come from the legacy method func's typeIdx
 *                in the WasmGC type registry, but here we re-derive
 *                from the AST so the IR types are symbolic / shape-
 *                preserving (matching what `resolvePositionType` does
 *                for top-level functions).
 *   - `constructorParams`: the constructor's user-visible param list,
 *                          re-derived from the AST.
 *
 * Classes whose constructor or any field/method type can't be lowered
 * to a representable IrType are SKIPPED — the IR selector can still
 * accept the class name as a TypeReference, but `resolvePositionType`
 * will throw when the missing shape forces a fallback. That mirrors
 * the slice 2 / slice 3 behavior: best-effort acceptance with a clean
 * legacy fallback for unrepresentable shapes.
 */
function buildIrClassShapes(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
): Map<string, import("../ir/nodes.js").IrClassShape> {
  const out = new Map<string, import("../ir/nodes.js").IrClassShape>();
  // #3000-E: className → declaration, for parent-chain field re-derivation and
  // parent-shape lookup on a subclass.
  const classDeclByName = new Map<string, ts.ClassDeclaration>();
  for (const stmt of sourceFile.statements) {
    if (ts.isClassDeclaration(stmt) && stmt.name) classDeclByName.set(stmt.name.text, stmt);
  }
  for (const stmt of sourceFile.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
    // #3000-E: a single-level `extends` of a LOCAL user class projects (its own
    // shape carries the parent as `.parent`, driving `super(...)` / `super.method`
    // lowering). A class with `extends` of a builtin / externref-backed / not-yet-
    // built parent, or a non-identifier heritage expression, still defers to legacy
    // — `parentShape` stays undefined and the `continue` below drops it. An
    // `implements`-only class (no `extends`) is structurally flat and projects. This
    // predicate MIRRORS the selector's `hasParent && parentIsLocalClass` gate
    // (`src/ir/select.ts`) so a claimed subclass member always finds a shape here.
    let parentShape: import("../ir/nodes.js").IrClassShape | undefined;
    const extendsName = extendsParentClassName(stmt);
    if (extendsName !== null) {
      const ps = out.get(extendsName);
      if (!ps) continue; // parent isn't a local projected class (builtin, or declared later) → defer
      parentShape = ps;
    }
    const className = stmt.name.text;
    if (!ctx.classSet.has(className)) continue;
    if (!ctx.structFields.has(className)) continue;

    // Constructor params — re-derived from AST so types come through
    // the same `tsTypeToFieldIr`-style projection. Reject if any param
    // has a non-representable type (e.g. union, function, generic).
    const ctor = stmt.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
    const constructorParams: IrType[] = [];
    let ctorOk = true;
    if (ctor) {
      for (const p of ctor.parameters) {
        if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer) {
          ctorOk = false;
          break;
        }
        const tsType = ctx.checker.getTypeAtLocation(p);
        const ir = tsTypeToClassPositionIr(ctx, tsType, out);
        if (!ir) {
          ctorOk = false;
          break;
        }
        constructorParams.push(ir);
      }
    }
    if (!ctorOk) continue;

    // Fields — read from the legacy `structFields` (which fixes the
    // authoritative field set: names, count, and the backend ValType each
    // struct slot commits to). Strip the `__tag` prefix and map each remaining
    // field to an IrType.
    //
    // #3000 Phase-1b (string-field-shape) — re-derive each field's IR type
    // from the AST/checker instead of the *lossy* legacy ValType. A `string`
    // field lowers to externref (host) / (ref $AnyString) (native); the ValType
    // alone can't tell a string from an `any`/object in host mode (both are
    // externref), so the old `valTypeToIrField(ValType)` returned null for
    // strings and the WHOLE class (e.g. classes.ts's `Animal`, whose `#name`
    // is a string) got no IrClassShape — leaving every accessor / method / ctor
    // byte-inert on legacy. We build a checker-derived field→IrType map keyed
    // by the SAME mangled name legacy stores in `structFields`, then adopt the
    // richer type ONLY when it is byte-compatible with the legacy struct slot
    // (`irFieldTypeMatchesLegacyValType` — a field-level parity guard). Fields
    // the AST can't resolve, or whose projection disagrees with the struct
    // slot, fall back to the original ValType path. Net effect: string (and
    // boolean/number) fields now project; unresolvable shapes still reject the
    // class, so the worst case remains a clean legacy fallback.
    const astFieldIr = new Map<string, IrType>();
    const recordField = (nameNode: ts.PropertyName, tsNode: ts.Node): void => {
      let mangled: string;
      if (ts.isPrivateIdentifier(nameNode)) mangled = "__priv_" + nameNode.text.slice(1);
      else if (ts.isIdentifier(nameNode)) mangled = nameNode.text;
      else return; // computed / string-literal / numeric names → leave to ValType path
      if (astFieldIr.has(mangled)) return;
      const tsType = ctx.checker.getTypeAtLocation(tsNode);
      const ir = tsTypeToClassPositionIr(ctx, tsType, out);
      if (ir) astFieldIr.set(mangled, ir);
    };
    // #3000-E: the legacy `structFields` for a subclass is `[...parentFields,
    // ...ownFields]` (see `collectClassDeclaration`), so a subclass's slot set
    // includes fields DECLARED on its ancestors — e.g. Dog's `__priv_name` is
    // Animal's string field. The AST re-derivation must therefore walk the whole
    // ancestor chain (self + every local parent), or an inherited STRING field
    // has no `astFieldIr` entry and falls to the null-returning ValType path,
    // rejecting the whole subclass. Numeric/boolean inherited fields survive the
    // ValType path regardless; this walk is what recovers inherited string fields.
    const chain: ts.ClassDeclaration[] = [stmt];
    for (let cursor: string | null = extendsParentClassName(stmt); cursor !== null; ) {
      const decl = classDeclByName.get(cursor);
      if (!decl) break; // non-local ancestor (builtin) — its fields aren't struct slots here
      chain.push(decl);
      cursor = extendsParentClassName(decl);
    }
    for (const decl of chain) {
      // Property declarations (`#name: string;`, `x: number;`) — legacy reads the
      // field type off the member node itself; mirror that source exactly.
      for (const member of decl.members) {
        if (ts.isPropertyDeclaration(member) && member.name && !hasStaticModifier(member)) {
          recordField(member.name, member);
        }
      }
      // Constructor-body `this.x = …` field introductions — legacy reads the
      // field type off the property-access LHS node; mirror that source.
      const declCtor = decl.members.find(ts.isConstructorDeclaration) as ts.ConstructorDeclaration | undefined;
      if (declCtor?.body) {
        for (const s of declCtor.body.statements) {
          if (
            ts.isExpressionStatement(s) &&
            ts.isBinaryExpression(s.expression) &&
            s.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isPropertyAccessExpression(s.expression.left) &&
            s.expression.left.expression.kind === ts.SyntaxKind.ThisKeyword
          ) {
            recordField(s.expression.left.name, s.expression.left);
          }
        }
      }
    }

    const legacyFields = ctx.structFields.get(className)!;
    const fields: { name: string; type: IrType }[] = [];
    let fieldsOk = true;
    for (const f of legacyFields) {
      if (f.name === "__tag") continue;
      const astIr = astFieldIr.get(f.name);
      const ir = astIr && irFieldTypeMatchesLegacyValType(ctx, astIr, f.type) ? astIr : valTypeToIrField(ctx, f.type);
      if (!ir) {
        fieldsOk = false;
        break;
      }
      fields.push({ name: f.name, type: ir });
    }
    if (!fieldsOk) continue;
    fields.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    // Methods — instance methods only, re-derived from the AST.
    const methods: {
      name: string;
      params: IrType[];
      returnType: IrType | null;
      memberKind?: "method" | "getter" | "setter" | "static";
    }[] = [];
    let methodsOk = true;
    for (const member of stmt.members) {
      if (!ts.isMethodDeclaration(member) || !member.name) continue;
      if (hasStaticModifier(member)) continue; // slice 4 defers static methods
      if (hasAbstractModifier(member)) continue;
      if (!ts.isIdentifier(member.name)) continue; // computed names → defer
      if (member.asteriskToken) continue; // generators → defer
      const methodName = member.name.text;
      const params: IrType[] = [];
      for (const p of member.parameters) {
        if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer) {
          methodsOk = false;
          break;
        }
        const tsType = ctx.checker.getTypeAtLocation(p);
        const ir = tsTypeToClassPositionIr(ctx, tsType, out);
        if (!ir) {
          methodsOk = false;
          break;
        }
        params.push(ir);
      }
      if (!methodsOk) break;
      // Return type — null for void (matches IrClassMethodDescriptor).
      let returnType: IrType | null = null;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      if (sig) {
        const retTs = ctx.checker.getReturnTypeOfSignature(sig);
        if (!isVoidType(retTs)) {
          const ir = tsTypeToClassPositionIr(ctx, retTs, out);
          if (!ir) {
            methodsOk = false;
            break;
          }
          returnType = ir;
        }
      }
      methods.push({ name: methodName, params, returnType });
    }
    if (!methodsOk) continue;

    // (#3144) Accessor + static-method descriptor projections — BEST-EFFORT:
    // an unprojectable accessor/static is simply skipped (a claimed use then
    // misses the descriptor at from-ast and demotes that one function),
    // never rejecting the WHOLE class like the instance-method loop above
    // would (which would regress classes that project today). Getters carry
    // the property name with `memberKind: "getter"` ([] -> T); setters
    // `"setter"` ([T] -> null); statics `"static"` (no `this` param at the
    // Wasm level — invoked via `class.static_call`). Instance-member lookups
    // filter on `memberKind`, so these never leak into `class.call`
    // resolution.
    for (const member of stmt.members) {
      if (!member.name || !ts.isIdentifier(member.name)) continue;
      const memberName = member.name.text;
      if (ts.isGetAccessorDeclaration(member) && !hasStaticModifier(member)) {
        const sig = ctx.checker.getSignatureFromDeclaration(member);
        if (!sig) continue;
        const retTs = ctx.checker.getReturnTypeOfSignature(sig);
        if (isVoidType(retTs)) continue; // void getter — degenerate, skip
        const ir = tsTypeToClassPositionIr(ctx, retTs, out);
        if (!ir) continue;
        methods.push({ name: memberName, params: [], returnType: ir, memberKind: "getter" });
      } else if (ts.isSetAccessorDeclaration(member) && !hasStaticModifier(member)) {
        if (member.parameters.length !== 1) continue;
        const p = member.parameters[0]!;
        if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer) continue;
        const ir = tsTypeToClassPositionIr(ctx, ctx.checker.getTypeAtLocation(p), out);
        if (!ir) continue;
        methods.push({ name: memberName, params: [ir], returnType: null, memberKind: "setter" });
      } else if (
        ts.isMethodDeclaration(member) &&
        hasStaticModifier(member) &&
        !hasAbstractModifier(member) &&
        !member.asteriskToken
      ) {
        const params: IrType[] = [];
        let ok = true;
        for (const p of member.parameters) {
          if (!ts.isIdentifier(p.name) || p.dotDotDotToken || p.questionToken || p.initializer) {
            ok = false;
            break;
          }
          const ir = tsTypeToClassPositionIr(ctx, ctx.checker.getTypeAtLocation(p), out);
          if (!ir) {
            ok = false;
            break;
          }
          params.push(ir);
        }
        if (!ok) continue;
        let returnType: IrType | null = null;
        const sig = ctx.checker.getSignatureFromDeclaration(member);
        if (sig) {
          const retTs = ctx.checker.getReturnTypeOfSignature(sig);
          if (!isVoidType(retTs)) {
            const ir = tsTypeToClassPositionIr(ctx, retTs, out);
            if (!ir) continue;
            returnType = ir;
          }
        }
        // A same-name instance method + static method share ONE legacy
        // funcMap key (`${className}_${name}` — class-bodies.ts skips the
        // second registration), so resolving either would call the wrong
        // body. Project the static only when no instance member takes the
        // name (from-ast then demotes the ambiguous call cleanly).
        if (methods.some((m) => m.name === memberName && (m.memberKind ?? "method") === "method")) continue;
        methods.push({ name: memberName, params, returnType, memberKind: "static" });
      }
    }

    out.set(className, {
      className,
      fields,
      methods,
      constructorParams,
      // #3000-E: present only for a single-level subclass of a local user class.
      ...(parentShape ? { parent: parentShape } : {}),
    });
  }
  return out;
}

/**
 * #3000-E: the name of a class's `extends` parent when it is a bare identifier
 * (`class Dog extends Animal` → "Animal"). Returns null for no `extends` (flat /
 * `implements`-only) and for a non-identifier heritage expression (`extends
 * ns.Base`, `extends mixin(X)` — deferred). Mirrors `extendsParentName` in
 * `src/ir/select.ts` so the shape builder and selector agree on which subclasses
 * are IR-eligible.
 */
function extendsParentClassName(stmt: ts.ClassDeclaration): string | null {
  for (const h of stmt.heritageClauses ?? []) {
    if (h.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    const first = h.types[0]?.expression;
    if (first && ts.isIdentifier(first)) return first.text;
  }
  return null;
}

/**
 * Slice 4 (#1169d): project a TypeScript type that appears in a class
 * member position (constructor param, method param, method return,
 * field) into an IrType. Returns `null` if the type isn't
 * representable — the caller skips the whole class in that case.
 *
 * Recognises:
 *   - primitives (number → f64, boolean → i32, string)
 *   - object shapes via `objectIrTypeFromTsType`
 *   - other locally-declared classes (forward references resolve
 *     against the in-progress `out` map; cross-class self-references
 *     come back as the class's own shape after a single pass)
 */
function tsTypeToClassPositionIr(
  ctx: CodegenContext,
  t: ts.Type,
  classShapes: ReadonlyMap<string, import("../ir/nodes.js").IrClassShape>,
): IrType | null {
  if (t.flags & ts.TypeFlags.NumberLike) return irVal({ kind: "f64" });
  if (t.flags & ts.TypeFlags.BooleanLike) return irVal({ kind: "i32" });
  if (t.flags & ts.TypeFlags.StringLike) return { kind: "string" };
  // Class type — resolved by symbol name.
  const sym = t.getSymbol();
  if (sym) {
    const cs = classShapes.get(sym.name);
    if (cs) return { kind: "class", shape: cs };
  }
  if (t.flags & ts.TypeFlags.Object) {
    const ir = objectIrTypeFromTsType(ctx, t);
    if (ir) return ir;
  }
  return null;
}

/**
 * Slice 4 (#1169d): map a legacy `ValType` (already lowered to Wasm)
 * back to an IrType for a class field descriptor. Used so the IR's
 * field-type discriminator stays consistent with what the legacy
 * struct emits.
 *
 * Conservative: only primitives + ref types pass. Ref types lower to
 * `IrType.val` carrying the same Wasm typeIdx — works for both
 * class-instance fields (typeIdx points at another class struct) and
 * anonymous struct fields. Field reads against these types return
 * `(ref $...)` values which the IR can compose with subsequent
 * operations only via the surrounding class.get / class.set; that's
 * fine for slice 4's surface.
 */
function valTypeToIrField(_ctx: CodegenContext, vt: import("../ir/types.js").ValType): IrType | null {
  if (vt.kind === "f64" || vt.kind === "i32") return irVal(vt);
  // `string`-typed class fields are handled by the AST/checker projection in
  // `buildIrClassShapes` (#3000 Phase-1b) — the legacy ValType (externref /
  // (ref $AnyString)) is ambiguous in host mode, so string recovery can't be
  // done from the ValType alone. This ValType path stays the fallback for
  // non-string fields; returning null here still rejects any field the AST
  // couldn't resolve (e.g. tagged-union / `any` refs), so the class falls back
  // to legacy cleanly.
  return null;
}

/**
 * #3000 Phase-1b — field-level parity guard. Does an AST/checker-derived class
 * field `IrType` lower to the SAME backend `ValType` the legacy struct slot
 * already committed to? We only adopt the richer AST-derived type when it is
 * byte-compatible with the struct, so `class.get`/`class.set` against the shape
 * produce exactly the ValType the struct holds — no invalid Wasm, no ABI drift
 * versus legacy-compiled callers, and the #1370 method-signature parity guard
 * (`integration.ts`) sees identical typeIdx on both sides.
 *
 * Scope is intentionally narrow: primitives (`f64`/`i32`) and `string`. The
 * `string` arm mirrors `resolveWasmType`'s string arm + the `ref`→`ref_null`
 * field widening in `collectClassDeclaration` (native → `(ref/ref_null
 * $AnyString)`; host → `externref`), which is exactly what `resolveString()`
 * resolves an `IrType.string` to at lower time. Any other IR kind returns
 * false → the caller falls back to the ValType path.
 */
function irFieldTypeMatchesLegacyValType(
  ctx: CodegenContext,
  ir: IrType,
  vt: import("../ir/types.js").ValType,
): boolean {
  if (ir.kind === "val") {
    const a = ir.val;
    if (a.kind !== vt.kind) return false;
    if (a.kind === "ref" || a.kind === "ref_null") {
      return a.typeIdx === (vt as { typeIdx: number }).typeIdx;
    }
    return true;
  }
  if (ir.kind === "string") {
    if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
      return (vt.kind === "ref" || vt.kind === "ref_null") && vt.typeIdx === ctx.anyStrTypeIdx;
    }
    return vt.kind === "externref";
  }
  return false;
}

// ---------------------------------------------------------------------------
// #1530 — IR fallback phase-out hooks.
//
// Two strict-mode sets that let later PRs close the legacy fallback path
// for specific rejection / build-error classes. Both start empty so the
// current behaviour is unchanged; the sets exist as a single, well-known
// integration point so future PRs add one entry per retired bucket.
//
// `STRICT_IR_REASONS`     — selector-rejection reasons that must NOT show
//                           up in any compilation. When non-empty, the
//                           selector is run with `trackFallbacks: true` and
//                           every matching reason is surfaced as a hard
//                           compile error rather than silently flowing to
//                           legacy. Add a reason here once its bucket in
//                           `scripts/ir-fallback-baseline.json` hits zero.
//
// `STRICT_IR_BUILD_ERRORS` — substring patterns matched against the
//                           per-function message returned by
//                           `compileIrPathFunctions`. When any pattern
//                           matches, the diagnostic is promoted from a
//                           "warning" (legacy fallback) to an "error"
//                           (hard fail). Add a pattern here once the
//                           corresponding IR-build path is known to be
//                           permanently fixed.
//
// See `plan/log/ir-adoption.md` for the per-bucket ownership + target
// dates that drive this list.
// ---------------------------------------------------------------------------
const STRICT_IR_REASONS: ReadonlySet<IrFallbackReason> = new Set<IrFallbackReason>();
// Empty as of #1530 — and #3341 established that a bucket reaching zero in
// `scripts/ir-fallback-baseline.json` is NECESSARY but NOT SUFFICIENT to add
// its reason here. That baseline is measured against the 13-file playground
// corpus only; corpus-zero does NOT mean the reason is unreachable on real
// code. Most rejection reasons describe LEGITIMATE IR-non-claimability that the
// legacy path must still catch — e.g. `external-call` (a call to a
// non-whitelisted external fn), `call-graph-closure` (an unclaimable callee),
// `param-type-not-resolvable` / `return-type-not-resolvable` /
// `type-resolution-failure` (TypeMap can't resolve the type), `class-method`
// (still covers computed/generator/abstract names, static super,
// subclass-of-builtin — see plan/log/ir-adoption.md), and the destructuring
// param buckets. Adding any of these here would promote a legitimate fallback
// to a HARD COMPILE ERROR and regress real programs. So a reason may be
// promoted to strict ONLY once it is genuinely UNREACHABLE in the IR (i.e. the
// IR is now expected to always claim+lower that construct, so a rejection is a
// bug) — real #2855-family adoption work, reason by reason, not a doc flip.
// The intended promotion order once each becomes genuinely unreachable
// (cheapest first, see plan/log/ir-adoption.md):
//   "param-type-not-resolvable",
//   "call-graph-closure",
//   "body-shape-rejected",

const STRICT_IR_BUILD_ERRORS: ReadonlyArray<string> = [
  // #3341 Slice B — the first activated build-error promotion. These three
  // `ir/integration: unknown … ref` throws are the IR name-repoint INVARIANT
  // class: when the selector CLAIMS a function, the IR builder emits refs (by
  // name) to functions / globals / types that IT created, so `resolveFunction`
  // / `resolveGlobal` / `resolveType` (src/ir/integration.ts:1647/1651/1656)
  // MUST resolve them. A miss is a builder↔finalize desync bug (the late-
  // funcidx name-repoint family — see reference_1461/2191/2193), NOT an
  // unlowerable program: no valid TS source can legitimately produce an
  // unresolvable ref on a correctly-claimed function. So promoting these from
  // a silent legacy demotion to a hard compile error can only fire on a
  // compiler regression — exactly the loud, filable failure #2855 wants —
  // while being a strict no-op on all valid code (the 13-file corpus reports
  // zero of these; verified via `check:ir-fallbacks --verbose`).
  "ir/integration: unknown function ref",
  "ir/integration: unknown global ref",
  "ir/integration: unknown type ref",
  // Add further substring patterns here when another build-error class is
  // permanently fixed and a legacy fallback should no longer mask a real bug.
  //   "post-hygiene verify:",
  //   "class-method typeIdx parity mismatch",
];

function isStrictIrBuildError(message: string): boolean {
  if (STRICT_IR_BUILD_ERRORS.length === 0) return false;
  for (const pat of STRICT_IR_BUILD_ERRORS) {
    if (message.includes(pat)) return true;
  }
  return false;
}

/**
 * (#3143) Escape-hatch check for default-ON env flags: only an explicit
 * `0`/`false` disables. Unset / empty / any other value means "default on".
 */
function explicitlyDisabledEnv(v: string | undefined): boolean {
  return v === "0" || v === "false";
}

export function irVerifierHardFailureEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return truthyEnv(env.JS2WASM_IR_VERIFY_HARD) || truthyEnv(env.CI) || env.NODE_ENV === "test" || truthyEnv(env.VITEST);
}

export function formatIrPathFallbackDiagnostic(err: IrIntegrationError): {
  readonly message: string;
  readonly severity: "error" | "warning";
} {
  const body = `IR path failed for ${err.func}: ${err.message} [IR-FALLBACK]`;
  const hard = isStrictIrBuildError(err.message) || (err.kind === "verify" && irVerifierHardFailureEnabled());
  return {
    message: hard ? `Codegen error: ${body}` : body,
    severity: hard ? "error" : "warning",
  };
}

// ---------------------------------------------------------------------------
// #2138 — IR-first compile-once inversion (flag-gated investigation)
//
// `planIrOverlay` is the IR *planning* phase extracted verbatim from the
// `if (options?.experimentalIR)` overlay block in `generateModule`: it runs
// `buildTypeMap` → `planIrCompilation` → `buildIrClassShapes` → the
// overrideMap/safeSelection resolution (including the STRICT_IR_REASONS
// promotion and the #2023 `new.target` coarse gate). Extraction exists so
// the SAME code can run at two different pipeline positions:
//
//   - flag OFF (default): called AFTER `compileDeclarations`, exactly where
//     the inline block sat — the pipeline is byte-identical to pre-#2138.
//   - `JS2WASM_IR_FIRST=1` (+ experimentalIR): called BEFORE
//     `compileDeclarations`, so the body pass can SKIP legacy emission for
//     functions the IR will own — every claimed function stops being
//     compiled twice.
//
// Why the reorder is flag-gated rather than unconditional (a deliberate
// deviation from the issue's original Slice-1 spec, which assumed the hoist
// was byte-identical): the planning block is NOT side-effect-free —
//   (a) `resolvePositionType` calls `getOrRegisterVecType` /
//       `typedArrayVecStorage`, which can first-register Wasm types; moving
//       it above the body pass can permute type-section index assignment;
//   (b) `buildIrClassShapes` reads `ctx.structFields`, which body
//       compilation can mutate (dynamic field additions, #516).
// Gating the ORDER on the flag makes acceptance criterion 1 (byte-identical
// output without the flag) true by construction instead of by corpus diff.
// ---------------------------------------------------------------------------

interface IrOverlayPlan {
  readonly selection: import("../ir/select.js").IrSelection;
  readonly classShapes: Map<string, import("../ir/nodes.js").IrClassShape>;
  readonly overrideMap: Map<string, { params: IrType[]; returnType: IrType | null }>;
  readonly safeSelection: {
    funcs: Set<string>;
    classMembers?: ReadonlySet<string>;
    // (#3142 Slice 2) Claim-feeding module-init assessment, forwarded from
    // `selection` so `compileIrPathFunctions` can lower + patch the
    // `__module_init` slot. Cleared alongside funcs under the `new.target`
    // coarse gate.
    moduleInit?: import("../ir/select.js").IrModuleInitAssessment;
  };
  readonly trackFallbacks: boolean;
  readonly declByName: ReadonlyMap<string, ts.FunctionDeclaration>;
}

/**
 * (#2138/#3143) Decide which claimed functions may have their LEGACY body
 * emission skipped under IR-first (the default since #3143).
 *
 * **ALLOWLIST, not denylist (#3143).** An early attempt gated OUT the shapes
 * from-ast cannot lower (a per-shape denylist). A `result.errors` scan of the
 * equivalence inline corpus proved that surface is BROAD — ~22 distinct
 * from-ast throw classes across core operations (string methods, class-member
 * resolution, call/ctor arity, type-mismatched arith, property assignment,
 * coercion, `new Date`, …). A denylist cannot enumerate them safely: a single
 * miss ships a skipped-slot HARD error (an equivalence regression), because a
 * skipped function whose IR build throws has no legacy body to demote to.
 *
 * So the decision is inverted: skip ONLY functions that are PROVABLY lowerable.
 * A function qualifies when ALL of:
 *   - it is not a `function*` on a standalone/WASI target (gate 2, #2951 —
 *     subsumed by the numeric allowlist anyway, kept explicit);
 *   - its SIGNATURE is lowerable: no default/optional/rest/destructuring
 *     params, and every param + the return type resolve (via `overrideMap`) to
 *     a numeric/boolean Wasm type (f64 / i32) or void — `signatureLowerable`;
 *   - its BODY is entirely the proven-lowerable numeric/boolean subset —
 *     `irFirstBodyIsProvenLowerable` (matched-type arithmetic/compare/logic,
 *     control flow, correctly-typed local mutation, exact-arity calls to other
 *     CLAIMED functions, returns; NO method calls / member access / `new` /
 *     literals-of-ref-type / closures / coercion).
 *
 * Safe by construction: a construct the allowlist does not recognise keeps the
 * function COMPILE-TWICE (correct — the legacy body ships, the IR overlay may
 * still overwrite it or demote to a warning), never a hard error. The subset
 * starts narrow and WIDENS as the IR gains real lowering for more kinds
 * (#2855/#2856); each widening unlocks more of the gated-G1 legacy deletion.
 * Class members are never skipped here (typeIdx parity contract with legacy
 * callers — see `integration.ts`).
 *
 * Every skipped function gets an `unreachable` placeholder body, so the skip is
 * a *body-emission* change, never an *index-layout* change; if the IR path
 * still fails on a skipped (allowlisted) function, `generateModule` promotes it
 * to a hard error — which the allowlist is designed to make impossible.
 */
function computeIrFirstSkipSet(
  plan: IrOverlayPlan,
  _sourceFile: ts.SourceFile,
  generatorsSkippable: boolean,
): ReadonlySet<string> {
  const skip = new Set<string>();
  const funcs = plan.safeSelection.funcs;
  if (funcs.size === 0) return skip;

  // (#3143/#3203) ALLOWLIST skip — see `irFirstBodyIsProvenLowerable`. A claimed
  // function's legacy body is skipped ONLY when its whole body is the
  // proven-lowerable numeric/boolean subset AND its signature is lowerable.
  // Everything else stays COMPILE-TWICE (safe: no skipped-slot hard error).
  const isF64 = (t: IrType): boolean => asVal(t)?.kind === "f64";
  const isI32 = (t: IrType): boolean => asVal(t)?.kind === "i32";

  // `claimedArity`: name → parameter count for every claimed function with a
  // PURE-`f64` signature (all params + return `f64`). In v1 the allowlist lowers
  // inter-function calls in NUMBER context only, so a call target must be a
  // number-signature callee — this keeps the call-result domain sound and also
  // closes a latent hole in the f64-only allowlist (a call to a claimed
  // non-f64-return callee was accepted as `number`). Bool-signature functions
  // are never allowlist call targets.
  const claimedArity = new Map<string, number>();
  for (const n of funcs) {
    const f = plan.declByName.get(n);
    if (!f) continue;
    const o = plan.overrideMap.get(n);
    if (o && o.params.every(isF64) && o.returnType !== null && isF64(o.returnType)) {
      claimedArity.set(n, f.parameters.length);
    }
  }

  // (#3203) Resolve a position's value DOMAIN for the allowlist. `number` = f64.
  // `bool` = an `i32` carrier WITH an explicit `boolean` AST annotation — the
  // ONLY checker-free way to disambiguate a boolean from a native-int (`type
  // i32 = number`), which also resolves to `i32`. Unannotated `i32` (inferred)
  // and native-int stay compile-twice (native-int is a follow-up widen). Any
  // other carrier (string/object/closure/extern/dynamic/ref) → null.
  const positionDomain = (annot: ts.TypeNode | undefined, resolved: IrType): ValueDomain | null => {
    if (isF64(resolved)) return "number";
    if (isI32(resolved) && annot?.kind === ts.SyntaxKind.BooleanKeyword) return "bool";
    return null;
  };
  // Resolve the full signature domain, or null when the function is not
  // skip-eligible. Rejects default/optional/rest/destructuring params (from-ast
  // throws on those) up front.
  const resolveSignatureDomains = (
    fn: ts.FunctionDeclaration,
    name: string,
  ): { paramDomains: ValueDomain[]; returnDomain: ValueDomain | "void" } | null => {
    for (const p of fn.parameters) {
      if (p.questionToken || p.dotDotDotToken || p.initializer) return null;
      if (!ts.isIdentifier(p.name)) return null;
    }
    const o = plan.overrideMap.get(name);
    if (!o) return null; // no resolved signature — stay conservative
    const paramDomains: ValueDomain[] = [];
    for (let i = 0; i < o.params.length; i++) {
      const d = positionDomain(fn.parameters[i]?.type, o.params[i]!);
      if (d === null) return null;
      paramDomains.push(d);
    }
    let returnDomain: ValueDomain | "void";
    if (o.returnType === null) returnDomain = "void";
    else {
      const rd = positionDomain(fn.type, o.returnType);
      if (rd === null) return null;
      returnDomain = rd;
    }
    return { paramDomains, returnDomain };
  };

  for (const name of funcs) {
    const fn = plan.declByName.get(name);
    if (!fn) continue;
    // gate 2 (#2951) — a claimed generator is skippable only when targeting a
    // JS host; a `function*` body is never in the numeric allowlist anyway, so
    // this is subsumed, but kept explicit for standalone/WASI clarity.
    if (fn.asteriskToken && !generatorsSkippable) continue;
    const sig = resolveSignatureDomains(fn, name); // numeric/boolean signature only
    if (!sig) continue;
    if (!irFirstBodyIsProvenLowerable(fn, claimedArity, sig.paramDomains, sig.returnDomain)) continue; // #3143/#3203
    skip.add(name);
  }

  // (#3143) Signature-parity fixpoint: a skipped function is installed with its
  // IR-resolved signature, so a LEGACY (non-skipped) caller — whose call-site
  // arg coercion was resolved against the callee's LEGACY signature — mismatches
  // it (the boxed-`any`→typed-param `f64.convert_i32_s` validation break). So
  // keep a function skippable ONLY when EVERY caller is itself skipped. Iterate
  // to a fixpoint (removing a function can un-skip its callees' other callers).
  // `<module-init>` (top-level statement calls) is never in `skip`, so any
  // function called at module scope is correctly excluded.
  const callEdges = collectLocalCallEdges(_sourceFile);
  const callers = new Map<string, Set<string>>(); // callee → callers
  for (const [caller, callees] of callEdges) {
    for (const callee of callees) {
      let s = callers.get(callee);
      if (!s) {
        s = new Set<string>();
        callers.set(callee, s);
      }
      s.add(caller);
    }
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of skip) {
      const cs = callers.get(name);
      if (!cs) continue; // no internal callers (leaf / host-only) — safe to skip
      for (const c of cs) {
        if (!skip.has(c)) {
          skip.delete(name);
          changed = true;
          break;
        }
      }
    }
  }
  return skip;
}

function planIrOverlay(ctx: CodegenContext, ast: TypedAST): IrOverlayPlan {
  const typeMap = buildTypeMap(ast.sourceFile, ast.checker);
  // #1169q telemetry — when JS2WASM_LOG_IR_FALLBACKS is set, request the
  // selector to track every top-level FunctionDeclaration that didn't
  // make it into `funcs` along with the rejection reason. Logged to
  // stderr at end of compile. Off by default (zero overhead).
  // #1530 — `trackFallbacks` is also enabled when one or more
  // selector-rejection reasons are in `STRICT_IR_REASONS`. The set
  // starts empty (purely a hook for follow-up PRs); when populated,
  // selector rejections of those reasons promote from a silent skip
  // to a hard error so the IR path becomes the only path for the
  // affected node kinds. Telemetry mode (`JS2WASM_LOG_IR_FALLBACKS=1`)
  // continues to enable the histogram log; the strict set additionally
  // forces collection.
  const trackFallbacks = process.env.JS2WASM_LOG_IR_FALLBACKS === "1" || STRICT_IR_REASONS.size > 0;
  // (#2856) Host-extern claiming: mode gate + checker-backed ambient-global
  // resolution. Selection runs BEFORE `collectDeclaredGlobals` /
  // `collectUsedExternImports` populate the ctx registries, so the selector
  // cannot read them — it gets the checker-derived answer instead (which is
  // also shadow-exact: a user binding named `document` resolves to the user
  // declaration, never the lib global). The registries ARE populated by the
  // time from-ast lowers (post-`compileDeclarations`), which is where member
  // resolution happens.
  const jsHostExterns = !(ctx.standalone || ctx.wasi || ctx.strictNoHostImports);
  // (#3053 U2) The gc `__dyn_member_get` body is sound in every config EXCEPT
  // fast host-js-string (`fast && !standalone && !wasi`): there the carrier is
  // the gc `$AnyValue` but strings are host js-string externrefs, so the native
  // honest classifier mis-tags reads and the body is invalid. Gate the dynamic
  // member-read claim off in that ONE config (clean pre-claim rejection, not a
  // claim-then-demote). The carrier keying in `ensureDynMemberGet` matches
  // (`ctx.fast`), so every claimed config emits a valid, carrier-aligned body.
  const dynMemberReadBuildable = !(ctx.fast && !ctx.standalone && !ctx.wasi);
  const selection = planIrCompilation(
    ast.sourceFile,
    {
      experimentalIR: true,
      trackFallbacks,
      jsHostExterns,
      dynMemberReadBuildable,
      resolveHostGlobal: makeIrHostGlobalResolver(ast.checker),
    },
    typeMap,
  );
  // #1530 — when a rejection reason is listed in STRICT_IR_REASONS,
  // promote every fallback with that reason to a hard compile error
  // instead of letting the legacy path silently catch it. The set
  // starts empty; once a bucket hits zero against
  // `scripts/ir-fallback-baseline.json`, that bucket's reason can be
  // added here in a follow-up PR.
  if (STRICT_IR_REASONS.size > 0 && selection.fallbacks) {
    for (const fb of selection.fallbacks) {
      if (STRICT_IR_REASONS.has(fb.reason)) {
        reportErrorNoNode(
          ctx,
          `IR path strict mode: ${fb.name} rejected with reason "${fb.reason}" — this reason is required to be zero (see plan/log/ir-adoption.md).`,
        );
      }
    }
  }
  // Slice 4 (#1169d) — build the class-shape registry from the
  // legacy class collection (`ctx.classSet`, `ctx.structFields`,
  // `ctx.funcMap`). Done BEFORE override resolution so class-typed
  // positions (`p: Point`) lower to `IrType.class` rather than
  // throwing in `resolvePositionType`.
  const classShapes = buildIrClassShapes(ctx, ast.sourceFile);
  // Build per-function IR type overrides from the propagated TypeMap.
  //
  // For a claimed function, the selector must have resolved each
  // param + return to a concrete primitive via either an explicit
  // TS annotation OR the TypeMap. We mirror that resolution here to
  // build the override map: for each position, prefer the AST
  // annotation (authoritative) and fall back to the TypeMap only
  // when the AST lacks one. If neither yields a concrete primitive,
  // that position is a compiler bug — the selector should not have
  // claimed this function.
  //
  // The override map also feeds the `calleeTypes` in the lowerer so
  // direct calls to IR-path callees see the right signature.
  // Slice 14 (#1228) — `returnType: IrType | null` where `null` means
  // a void-returning function (zero Wasm result types). Plumbs through
  // `compileIrPathFunctions` to `from-ast.ts` so the IR builder can be
  // constructed with `[]` results and the lowerer can accept bare
  // `return;` / fall-through tails.
  const overrideMap = new Map<string, { params: IrType[]; returnType: IrType | null }>();
  const declByName = new Map<string, ts.FunctionDeclaration>();
  for (const stmt of ast.sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) declByName.set(stmt.name.text, stmt);
  }
  for (const name of selection.funcs) {
    const fn = declByName.get(name);
    if (!fn) continue;
    const entry = typeMap.get(name);
    try {
      // Slice 7a (#1169f) — generator functions return an externref
      // (the JS Generator-like object built by `__create_generator`)
      // regardless of the source-level annotation
      // (`Generator<number>`, `IterableIterator<T>`, etc.). The IR
      // lowerer enforces this; the override map needs to agree so
      // the cross-function `calleeTypes` lookup sees the right
      // signature. Bypass `resolvePositionType` for the return type
      // — `Generator<T>` doesn't resolve as `IrType.object` and
      // would otherwise drop the generator from `safeSelection`.
      const isGenerator = !!fn.asteriskToken;
      // Slice 14 (#1228) — VoidKeyword return: bypass resolvePositionType
      // (it has no representation for void in IrType) and set returnType
      // to null. The lowerer treats null returnType as "no result".
      const isVoidReturn = !isGenerator && fn.type?.kind === ts.SyntaxKind.VoidKeyword;
      const returnType: IrType | null = isGenerator
        ? ({ kind: "val", val: { kind: "externref" } } as IrType)
        : isVoidReturn
          ? null
          : resolvePositionType(fn.type, entry?.returnType, ctx, classShapes);
      const params: IrType[] = [];
      for (let i = 0; i < fn.parameters.length; i++) {
        const p = fn.parameters[i]!;
        params.push(resolvePositionType(p.type, entry?.params[i], ctx, classShapes));
      }
      overrideMap.set(name, { params, returnType });
    } catch (e) {
      // Selector claimed a function whose types can't be resolved —
      // skip the IR path for this one. Fall through to legacy.
      //
      // #1921 — this is a deliberate IR→legacy fallback, not a compile
      // error: the legacy path still produces a working body for `name`.
      // Emit severity "warning" so it stays visible to bridge tests but
      // does NOT fail the build (consistent with the IR-fallback channel
      // at `formatIrPathFallbackDiagnostic` above). Defaulting to "error"
      // would fail every program with a class-typed cross-function return
      // that the IR lowerer can't yet represent (e.g. a `Builder` chain).
      //
      // #2137 — also record this on the structured `irPostClaimErrors`
      // channel (kind "resolve") so consumers (bridge tests, the
      // check:ir-fallbacks gate) can query IR-path fallbacks without
      // string-matching the diagnostics array. The warning line below is
      // retained one sprint for back-compat.
      //
      // (#2138) NOTE: a resolve-time drop is exactly why `safeSelection`
      // — not the raw `selection` — feeds `computeIrFirstSkipSet`: this
      // function keeps its legacy body under IR-first.
      const resolveMsg = e instanceof Error ? e.message : String(e);
      (ctx.irPostClaimErrors ??= []).push({
        kind: "resolve",
        func: name,
        message: resolveMsg,
      });
      reportErrorNoNode(ctx, `IR path: could not resolve types for ${name}: ${resolveMsg}`, "warning");
    }
  }
  // Only request IR compilation for functions we successfully built
  // overrides for (the selector may have claimed more, but if we
  // couldn't map types safely we leave them to legacy).
  //
  // #1370 Phase B: thread `classMembers` through to the integration
  // loop. Class methods don't go through `overrideMap` (they're
  // typed via the class shape, not the TypeMap-derived overrides);
  // the integration's class-member walk consults `classShapes`
  // directly. Pass the set unmodified.
  const safeSelection: {
    funcs: Set<string>;
    classMembers?: ReadonlySet<string>;
    moduleInit?: import("../ir/select.js").IrModuleInitAssessment;
  } = {
    funcs: new Set<string>([...selection.funcs].filter((n) => overrideMap.has(n))),
    classMembers: selection.classMembers,
    // (#3142 Slice 2) Forward the module-init claim. A resolve-time drop of
    // one of the unit's callees is self-limiting: the integration builds
    // `calleeTypes` from safeSelection.funcs, so a call to a dropped callee
    // throws at build time and the unit demotes to the legacy body.
    moduleInit: selection.moduleInit,
  };
  // (#2023) The IR `new C(...)` lowering does not thread the new.target
  // class-id (that machinery lives only on the legacy path). When the
  // program uses `new.target`, route every function through legacy so the
  // outermost-`new` global is set/restored at each construction site. This
  // is a coarse but safe gate — `new.target` is rare, so the perf cost is
  // negligible and it avoids a parallel IR implementation of the threading.
  // (#2138: `ctx.usesNewTarget` is written only by `scanForNewTarget`, which
  // runs BEFORE `collectDeclarations` — so this gate reads the same value at
  // either pipeline position, plan-before or plan-after the body pass.)
  if (ctx.usesNewTarget) {
    safeSelection.funcs.clear();
    safeSelection.classMembers = new Set();
    // (#3142 Slice 2) The module-init unit routes through legacy too.
    safeSelection.moduleInit = undefined;
  }
  return { selection, classShapes, overrideMap, safeSelection, trackFallbacks, declByName };
}

/** Compile a typed AST into a WasmModule IR */
export function generateModule(
  ast: TypedAST,
  options?: CodegenOptions,
): {
  module: WasmModule;
  errors: CodegenError[];
  // #2089 — silent-fallback telemetry counters (per class → per site → count).
  fallbackCounts?: FallbackCounts;
  // #1923 — IR post-claim demotions (only when trackIrPostClaim is set).
  irPostClaimErrors?: { kind: string; func: string; message: string }[];
  // #3000 — functions/class-members actually IR-emitted (genuine-emission signal).
  irCompiledFuncs?: readonly string[];
  // #2138 — legacy bodies skipped under IR-first (default as of #3143; undefined when disabled).
  irFirstSkipped?: readonly string[];
} {
  const mod = createEmptyModule();
  const ctx = createCodegenContext(mod, ast.checker, options);
  // (#2138) Populated only under JS2WASM_IR_FIRST=1 — the top-level functions
  // whose legacy body emission was skipped (IR owns the slot). Declared out
  // here so the return statement below (outside the try) can surface it.
  let irFirstSkipped: readonly string[] | undefined;
  // (#1983) Pre-scan top-level user `function` declaration names BEFORE any
  // class member registers a funcMap key, so `classMemberFuncKey` can detect a
  // `${className}_${member}` ↔ user-function collision (e.g. `class A { m() {} }`
  // + `function A_m() {}`) and relocate the class member's key. Must run here —
  // ahead of class collection/compile — because the producers query this set.
  for (const stmt of ast.sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body && !hasDeclareModifier(stmt)) {
      ctx.topLevelFunctionNames.add(stmt.name.text);
    }
  }
  // (#2179) Pre-scan for `delete <member>` so `any`-receiver property reads can
  // be routed through the tombstone-aware `__extern_get` host helper instead of
  // the inline struct.get fast-path (which reads the live field and ignores the
  // runtime delete tombstone). Delete-free modules keep byte-identical output.
  ctx.moduleUsesDelete = sourceContainsDelete(ast.sourceFile);
  // (#2660 S1) Whole-program escape / dynamic-use classification of `new F()`
  // fnctor instances. INERT: the result is stored for the future S3
  // reconstruction lowering but is NOT yet consumed, so emitted Wasm is
  // byte-identical. Side-effect free; safe to run unconditionally (no fnctor
  // `new` sites ⇒ empty result ⇒ no-op).
  ctx.fnctorEscapeGate = analyzeFnctorEscapeGate(ast.checker, ast.sourceFile);
  // (#3057) Pre-scan for a dynamic `new <ctorVar>(buffer)` construct so the
  // runtime-kind element byte codec on the generic index path (`ta[i]` / `ta[i]=v`
  // for an `any` receiver) is enabled in helper functions compiled BEFORE the
  // construct (the `$__ta_dyn_view` type registers lazily). Host-free lane only;
  // byte-inert when the pattern is absent.
  if (ctx.standalone || ctx.wasi) {
    ctx.moduleUsesDynTaView = sourceHasDynamicTaConstruct(ast.checker, ast.sourceFile);
  }
  try {
    // WASI target: register linear memory, bump pointer global, and WASI imports
    if (ctx.wasi) {
      registerWasiImports(ctx, ast.sourceFile);
      // #1886 — pre-pass: classify which `Uint8Array` buffers are pure I/O
      // (never escape the GC heap) so they can be backed by linear memory with
      // zero-copy fd_read/fd_write. Side-effect free; codegen consumers are
      // additive (empty result ⇒ emitted module identical to today).
      // #2631 — pass the node:fs readSync/writeSync binding names from the
      // ORIGINAL source (import preprocessing has already stripped the `node:fs`
      // import from `ast.sourceFile`, so the analysis can't rediscover them).
      // `ctx.wasiNodeFsFuncs` records the local names of node:fs imports; the
      // byte-IO sink recognition only fires for these, so it's byte-neutral for
      // every program that doesn't import them.
      const nodeFsSyncNames = new Set<string>();
      for (const name of ctx.wasiNodeFsFuncs) {
        if (name === "readSync" || name === "writeSync") nodeFsSyncNames.add(name);
      }
      ctx.linearUint8 = analyzeLinearUint8(ast.checker, ast.sourceFile, nodeFsSyncNames);
      // #1886 Slice B: reserve the `__lin_u8_alloc` bump-allocator's
      // `(i32)->(i32)` func TYPE eagerly, here — BEFORE any WasmGC struct/array
      // type or native-string helper is registered. This keeps the shared
      // `ctx.mod.types` prefix stable: the allocator type lands at a low, fixed
      // index, so later string-helper struct/array type indices (which their
      // bodies bake absolutely, e.g. `__str_flatten`'s `(ref null $type)`) are
      // not shifted. The allocator FUNCTION itself is emitted later, in the
      // post-import-registration helper block, so its DEFINED-function index is
      // assigned after every late `env.*` import (e.g. `env.__extern_get` for
      // `buf[i]` externref element access) is already counted — keeping the
      // baked `call $__lin_u8_alloc` index correct. Splitting type (early) from
      // function (late) is what resolves the dual constraint that defeated both
      // the all-early and all-late single-shot emission points.
      // Reserve the allocator's func type whenever the #1886 analysis found a
      // safe binding. Slice C can back locals that are threaded through helper
      // params, so `localOnlyBindings` is too narrow here.
      if (ctx.linearUint8.safeBindings.size > 0) {
        reserveLinearU8AllocType(ctx);
      }
    }

    // (#2357/#47) Reserve the standalone TypedArray `$__subview_<elem>` struct
    // types up-front, here — at the SAME deterministic point in every codegen
    // pass — so the subview type index is identical across the hoist pass (which
    // sizes a `subarray`-result binding's local via
    // `inferLetConstInitializerWasmType`) and the body/emit pass (which emits the
    // matching `struct.new`). On-demand subview registration lands at
    // pass-dependent indices, de-syncing the two; eager registration *inside*
    // `getOrRegisterVecType` instead shifts the vec resolution itself (a plain
    // `new Uint8Array()` then resolves to the subview). Reserving the subviews
    // here — after the vec-independent linear-u8 reservation, before any function
    // is compiled — gives a stable, isolated slot. `getOrRegisterSubviewType`
    // pulls in only the backing array type (deduped per elem kind), so vec
    // registration order is untouched. Standalone/WASI only; additive.
    if (ctx.standalone || ctx.wasi) {
      reserveTypedArraySubviewTypes(ctx);
      // (#2901 fix) The integer-view PLAIN vec structs are deliberately NOT
      // reserved here. An up-front, unconditional reservation prepended them to
      // every standalone module's type table, renumbering the #2835 i8-packed
      // array type → ~2.6k `array.get: ... packed type i8` failures in the
      // merge_group (type-index-shift hazard). They are now registered LATE +
      // ONCE, append-only, inside `typedArrayViewBrandCandidates` (only when a
      // reflective TypedArray accessor getter is actually emitted) — so non-TA
      // modules stay byte-identical and nothing already registered is renumbered.
    }

    // (#2026 #53) Reserve `$ObjVecArr` up-front when the source declares a class,
    // so the dynamic-`new` runtime-argv path (`new K(...someVar)`) has a stable
    // type index. Class-gated + additive (one self-contained array type, no
    // helpers/imports) → no index shift for class-free programs. Both targets:
    // the dynamic-new fallback fires in host AND standalone.
    if (sourceContainsClass(ast.sourceFile)) {
      reserveObjVecArrType(ctx);
    }

    // (#2773 S1 KEYSTONE) Reserve every reconstructed-fnctor `$__fnctor_<Name>`
    // struct type up-front, here — at the SAME deterministic point in every
    // codegen pass — so the type index is identical across the hoist pass (which
    // bakes a typed-receiver `ref.test $__fnctor_<Name>` / sizes a hoisted local)
    // and the emit pass (which emits the matching `struct.new`). On-demand
    // registration at the `new F()` site lands at a pass-dependent index,
    // de-syncing the two. Gated on a non-empty approved set ⇒ byte-identical no-op
    // for fnctor-free modules. Both targets (the fnctor struct path is
    // target-independent). MUST run after the gate is built (above, line ~1081)
    // and after the subview / ObjVecArr reservations so the type-table prefix is
    // already stable.
    reserveFnctorStructTypes(ctx);

    // $AnyValue struct type is now registered lazily via ensureAnyValueType()

    // Note: console imports handled by unified collector (skipped in WASI mode via registerWasiImports)
    // First pass: collect declare namespaces (registers imports before local funcs)
    collectExternDeclarations(ctx, ast.sourceFile);

    // WASI target: check for DOM-only globals and emit compile errors
    if (ctx.wasi) {
      checkWasiDomUsage(ctx, ast.sourceFile);
      rejectTimersUnderWasi(ctx, ast.sourceFile);
    }

    // Scan lib files for DOM extern classes + globals (only if user code uses DOM)
    // After lib.d.ts refactoring, TS loads individual lib files (lib.es5.d.ts, etc.)
    if (sourceUsesLibGlobals(ast.sourceFile)) {
      // #2520 — the lib-file referenced-names gate only applies under
      // --target wasi/standalone, where the ambient global-function flood
      // (~60 register-then-dropped host imports) is the actual problem and the
      // dropped imports are DCE'd. Under the default JS-host (gc) target the
      // gate is a no-op for warnings but reorders the import/type table, which
      // exposed a latent index-shift in the late-import path (#1787 −6
      // regression: Array/TypedArray .join, TypedArray HasProperty, Array
      // reduce). Passing `undefined` here keeps the gc lane byte-identical to
      // pre-#2520 behaviour while preserving the wasi/standalone flood fix.
      const libRefs =
        ctx.wasi || ctx.standalone ? collectReferencedGlobalNames([ast.sourceFile], ctx.checker) : undefined;
      for (const sf of ast.program.getSourceFiles()) {
        const baseName = sf.fileName.split("/").pop() ?? sf.fileName;
        if (baseName.startsWith("lib.") && baseName.endsWith(".d.ts")) {
          collectExternDeclarations(ctx, sf, libRefs);
          collectDeclaredGlobals(ctx, sf, ast.sourceFile);
        }
      }
    }

    // Register built-in collection types as extern classes if not already collected from lib files
    registerBuiltinExternClasses(ctx);

    // #1044 — Register Node builtin modules as externref host imports
    if (options?.nodeBuiltins && options.nodeBuiltins.length > 0) {
      registerNodeBuiltinImports(ctx, options.nodeBuiltins);
    }

    // #1540 — Register JSX runtime imports (jsx/jsxs/Fragment) so codegen
    // call/identifier resolution can route them to the right host imports.
    if (options?.jsxRuntime) {
      registerJsxRuntimeImports(ctx, options.jsxRuntime);
    }

    // Pre-pass: detect empty object literals that get properties assigned later
    // Must run before import collectors so that widened types are known
    collectEmptyObjectWidening(ctx, ast.checker, ast.sourceFile);
    // (#2837) Detect NON-empty object literals later written out-of-shape (incl.
    // nested depth-2 descriptors) → route them to the externref $Object builder.
    collectGrowableObjectLiterals(ctx, ast.checker, ast.sourceFile);

    // Register only the extern class imports actually used in source code
    collectUsedExternImports(ctx, ast.sourceFile);

    // #1187 — pre-register imports needed by the testRuntime string-coercion
    // helpers BEFORE `collectAllSourceImports` runs. The unified collector's
    // finalize step registers native-string runtime helpers (via
    // `ensureNativeStringHelpers`) as DEFINED functions at the current
    // `numImportFuncs` boundary; if we add testRuntime imports AFTER that, the
    // already-emitted helper bodies hold stale `call funcIdx` values that
    // collide with the newly-inserted import slots (e.g. `__str_copy_tree`
    // gets shadowed by `String_fromCharCode`). Pre-registering here avoids
    // any late-import shift.
    if (ctx.testRuntime && ctx.nativeStrings) {
      // wasm:js-string.length, charCodeAt, concat, substring, equals
      addStringImports(ctx);
      // env.String_fromCharCode((f64) -> externref) — used by __test_str_to_externref
      if (!ctx.funcMap.has("String_fromCharCode")) {
        const fccTypeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
        addImport(ctx, "env", "String_fromCharCode", { kind: "func", typeIdx: fccTypeIdx });
      }
    }

    // Single-pass collection of all source imports (#592):
    // console, primitives, string literals, string methods, Math, parseInt/parseFloat,
    // String.fromCharCode, Promise, JSON, callbacks, functional array methods,
    // union types, generators, iterators, for-in/in-expr/Object.keys string literals,
    // wrapper constructors, unknown constructor imports.
    collectAllSourceImports(ctx, ast.sourceFile);

    // #1047 — register __register_prototype host import before any local function
    // is created so `emitLazyProtoGet` can look it up from funcMap without
    // triggering late-import index shifts mid-expression compilation.
    //
    // #1472 Phase A — these two imports exist solely so the JS-host Proxy
    // wrapper can present a spec-correct own-key set for class prototypes /
    // class objects. There is no Proxy (and no JS host) in any no-JS-host
    // target, so we skip registering them. `emitLazyProtoGet` /
    // `emitLazyClassObjectGet` gate their `call` emission on the import being
    // present in funcMap, so skipping registration cleanly drops the host
    // notification while the struct-backed prototype/class globals still work
    // natively.
    //
    // (#2026 PR-1b) The guard must cover BOTH no-JS-host targets (`wasi` AND
    // `standalone`), not just `standalone`. Under `--target wasi` the import was
    // still registered, so `emitLazyClassObjectGet` took its
    // `__register_class_object` CSV-notification branch and emitted a
    // `global.get` of the static-methods-CSV string global — which under
    // nativeStrings is not a real module global, baking a `-1` global index and
    // crashing binary emit ("global index out of range — -1") the moment a class
    // flowed as a value (`use(A)`, `new K()` dynamic-new). `standalone` already
    // skipped this and worked; `wasi` now matches.
    if (sourceContainsClass(ast.sourceFile) && !(ctx.standalone || ctx.wasi)) {
      const regProtoTypeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], []);
      addImport(ctx, "env", "__register_prototype", { kind: "func", typeIdx: regProtoTypeIdx });
      // (#1395) Same rationale for the class-object registry — must be
      // registered up-front so `emitLazyClassObjectGet` finds it in funcMap.
      const regClassTypeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], []);
      addImport(ctx, "env", "__register_class_object", { kind: "func", typeIdx: regClassTypeIdx });
    }

    // #1677 — reconcile native-string helper func indices before emitting more
    // defined helpers that look them up. Imports registered after the helpers
    // (e.g. the __register_prototype / __register_class_object pair above)
    // shift the helpers' true indices but not their baked-in sibling-call
    // targets nor the `nativeStrHelpers` / funcMap entries the deferred WASI
    // write helpers read. Incremental + no-op on the default GC path.
    reconcileNativeStrFinalizeShift(ctx);

    // Emit inline Wasm implementations for Math methods (after all imports are registered)
    if (ctx.pendingMathMethods.size > 0) {
      emitInlineMathFunctions(ctx, ctx.pendingMathMethods);
    }

    // Emit __toUint32 Wasm helper after all imports registered (bypasses bug
    // where direct addImport calls do not shift defined-function indices).
    emitToUint32Helper(ctx);

    // (#1483) Emit deferred WASI helper functions for the same reason —
    // `__wasi_write_string` / `__wasi_date_now` etc. reference imports via
    // funcMap, and addImport callers earlier in this pipeline (lib-globals
    // scan adding `eval` / `parseInt`) do not shift defined-func entries.
    emitDeferredWasiHelpers(ctx);

    // #1886 Slice B — emit the `__lin_u8_alloc` bump-allocator FUNCTION here,
    // in the same post-import-registration window as emitToUint32Helper /
    // emitDeferredWasiHelpers and for the same reason: all the eager import
    // collectors (collectUsedExternImports adds `env.__extern_get`;
    // collectAllSourceImports; the __register_prototype pair) have run, so
    // `numImportFuncs` is stable and the allocator's defined-func index — which
    // every `call $__lin_u8_alloc` resolves against — is final. Its func TYPE
    // was already reserved early (see reserveLinearU8AllocType) so the GC /
    // native-string type-table prefix is unperturbed. Any import added DURING
    // the compilation phase that follows goes through the proper late-import
    // shift path, which moves both `funcMap` and the baked `call` indices.
    if (ctx.wasi && ctx.linearUint8 && ctx.linearUint8.safeBindings.size > 0) {
      ensureLinearU8AllocHelper(ctx);
    }

    // Emit wrapper valueOf functions (after all imports registered, before user funcs)
    emitWrapperValueOfFunctions(ctx);

    // #1623 — pre-emit the WASI/standalone error constructors BEFORE any user
    // function compiles. The destructuring null-throw path
    // (`buildDestructureNullThrow`) lazily calls `emitWasiErrorConstructor`
    // mid-prologue while a user function's own array slot is reserved-but-not-
    // yet-pushed; the constructor then takes that reserved slot and the user
    // function clobbers it on its own push, leaving a dangling funcMap index
    // (observed as `throw expected externref, found call of type f64` and
    // `Invalid global index`). Emitting the constructor here gives it a stable
    // slot ahead of user-function compilation. The emitter is idempotent, so
    // this is a no-op when no binding patterns exist.
    if ((ctx.wasi || ctx.standalone) && sourceContainsBindingPattern(ast.sourceFile)) {
      emitWasiErrorConstructor(ctx, "TypeError", 1);
    }

    // #1121: Pre-compute return-type inference for recursive numeric kernels
    // (e.g. unannotated `function fib(n) { ... }`). This runs BEFORE
    // collectDeclarations so the inferred f64 return shows up directly in
    // the function's signature instead of being patched after the fact.
    ctx.numericReturnTypes = inferNumericReturnTypes(ctx, ast.sourceFile);

    // #1677 — final reconcile of native-string helper indices before any USER
    // function is registered. Any imports added by the deferred-helper
    // emitters above are folded in here; afterward the compilation-phase
    // late-import path (ensureLateImport → flushLateImportShifts, which now
    // also shifts `nativeStrHelpers`) keeps them correct. Incremental no-op
    // when nothing drifted.
    reconcileNativeStrFinalizeShift(ctx);

    // Second pass: collect all function declarations and interfaces
    // #1719 S1 — set the ITER_OVERRIDDEN brand if the program may monkeypatch
    // Array.prototype's @@iterator/values. When clear (the common case) every
    // array-destructuring site stays byte-identical; when set, the S2 slice
    // routes a branded array RHS through the host GetIterator lane (§7.4.2).
    // Must run BEFORE collectDeclarations: the module-init statement filter
    // (#1719 CPR write-arm) consults the brand to KEEP the
    // `Array.prototype[@@iterator] = fn` override statement in __module_init.
    if (sourceOverridesArrayIterator(ast.sourceFile)) {
      ctx.arrayIteratorMaybeOverridden = true;
    }

    // (#2023) Detect any `new.target` use up front so class collection assigns
    // class-ids and `new`/comparison sites emit the threading global. Off by
    // default — programs without `new.target` are byte-identical.
    scanForNewTarget(ctx, ast.sourceFile);

    // (#2001 S1) Detect any array-literal elision up front so externref-element
    // vec reads / joins emit the `$Hole → undefined` read-boundary guard.
    // Off by default — programs without holes are byte-identical.
    scanForArrayHoles(ctx, ast.sourceFile);

    collectDeclarations(ctx, ast.sourceFile);

    // Shape inference: detect array-like variables and override their types
    applyShapeInference(ctx, ast.checker, ast.sourceFile);

    // (#1636-S1) Eagerly register the `__current_this` module global so that
    // `ThisKeyword` resolution in free-function-closure bodies (compiled in
    // the next phase) can emit `global.get __current_this`. The companion
    // `__call_fn_method_N` exports that install / restore this global are
    // emitted in post-processing.
    ensureCurrentThisGlobal(ctx);

    // (#2931) Back reassigned function-declaration names (`fn = …`) with a
    // mutable live-binding module global so later reads observe the write.
    // No-op unless a function declaration is reassigned.
    registerReassignedFunctionGlobals(ctx, [ast.sourceFile]);

    // (#2138) IR-first compile-once inversion.
    // (#3143) Default ON — this clears gate G1 of the legacy-frontend
    // retirement (plan/log/3090-phase0-legacy-delete-list.md): with IR-first
    // the IR plan is computed BEFORE `compileDeclarations` and legacy body
    // emission is skipped for claimed functions that pass
    // `computeIrFirstSkipSet`'s gates — those slots get an `unreachable`
    // placeholder that the IR overlay MUST overwrite (a post-claim IR
    // failure on a skipped function is promoted to a hard compile error
    // below, never a silent legacy demote). Selector-REJECTED functions are
    // never claimed and still compile via the legacy path, unchanged.
    // Escape hatch (one release, #3143): `JS2WASM_IR_FIRST=0` restores the
    // old overlay order (legacy compiles everything, IR overwrites after).
    // (#2973) `disableIrFirst` opts a compile out of the IR-first inversion
    // regardless of the ambient env flag — semantics-critical sub-compiles
    // (eval / new Function host shims) set it so a post-claim IR-first hard
    // error is not swallowed by the shim's fallback catch into a silent
    // `undefined`. The ordinary IR overlay (`experimentalIR`) still runs.
    const irFirst =
      !!options?.experimentalIR && !options?.disableIrFirst && !explicitlyDisabledEnv(process.env.JS2WASM_IR_FIRST);
    let irPlan: IrOverlayPlan | null = null;
    let irSkipBodies: ReadonlySet<string> | undefined;
    if (irFirst) {
      irPlan = planIrOverlay(ctx, ast);
      // (#2951) generators are skippable only for the JS-host path — the same
      // condition the selector uses for `jsHostExterns`. Standalone/WASI keep
      // generators on the compile-twice path (see gate 2 in computeIrFirstSkipSet).
      const generatorsSkippable = !(ctx.standalone || ctx.wasi || ctx.strictNoHostImports);
      irSkipBodies = computeIrFirstSkipSet(irPlan, ast.sourceFile, generatorsSkippable);
    }

    // Third pass: compile function bodies
    const actuallySkipped = compileDeclarations(ctx, ast.sourceFile, irSkipBodies);
    if (irFirst) irFirstSkipped = actuallySkipped ?? [];

    // (#1602) Rebuild object-method-as-closure trampoline bodies against the
    // method's now-final signature (param types/order may have been re-resolved
    // during body compilation above).
    finalizeMethodTrampolines(ctx);

    // Experimental IR path: for functions selected by `planIrCompilation`,
    // rebuild their bodies via the middle-end IR (AST → IR → Wasm). Runs
    // AFTER `compileDeclarations` so the symbolic-ref resolver sees final
    // funcIdx / globalIdx / typeIdx assignments — this is what makes
    // `shiftLateImportIndices` a no-op for IR-path bodies.
    //
    // Phase 2: the TypeMap is computed from `buildTypeMap`, which runs
    // context-insensitive interprocedural propagation across the source
    // file's call graph. That's what lets a recursive `fib` whose param
    // is untyped in source compile as `(f64) -> f64` when a typed caller
    // (e.g. `run(n: number)`) flows `number` into it. The selector then
    // uses the TypeMap to decide which functions to claim, and closes
    // the claim set under call-graph edges so the IR path never emits a
    // cross-signature `call` against a legacy-compiled callee.
    if (options?.experimentalIR) {
      // (#2138) Under IR-first the plan was computed BEFORE
      // `compileDeclarations` (see above); otherwise compute it here — the
      // exact position the inline planning block occupied pre-#2138, so the
      // flag-off pipeline is order-identical. `planIrOverlay` holds the
      // planning code verbatim (typeMap → selection → STRICT_IR_REASONS →
      // classShapes → overrideMap → safeSelection → new.target gate).
      const plan = irPlan ?? planIrOverlay(ctx, ast);
      const { selection, classShapes, overrideMap, safeSelection, trackFallbacks } = plan;
      const report = compileIrPathFunctions(ctx, ast.sourceFile, safeSelection, overrideMap, classShapes);
      // #3000 — record the set of functions/class-members whose slots were
      // actually patched with an IR body (genuine-emission signal; a mere
      // selector claim does not imply this — see `irCompiledFuncs` doc).
      ctx.irCompiledFuncs = report.compiled;
      // Slice 12 (#1169o) — most IR-path failures are NOT compile errors. The
      // legacy path has already produced a working `body` for every function
      // before `compileIrPathFunctions` runs; an ordinary IR throw here is a
      // "we tried to optimise this function via IR, it didn't fit the IR's
      // claim shape, falling back to legacy" event.
      //
      // Emit as severity-"warning" so they remain visible to the
      // bridge tests (#1181's `irErrors` filter still sees them) but
      // don't affect the test262 `result.success || severity==="error"`
      // gate. Cleaner long-term: thread an `IrPathReport` channel through
      // `CompileResult` separate from compile diagnostics; tracked as a
      // follow-up.
      //
      // #1530 — the demotion is gated by `STRICT_IR_BUILD_ERRORS`: if any
      // pattern in that set matches the build-error message, the
      // diagnostic is promoted to "error" instead. The set starts empty
      // (non-behavioural change); once a build-error class is known to
      // be permanently fixed in the IR path, the matching pattern is
      // added here and the legacy fallback path is closed for that
      // class. This is the per-kind scoping hook the long-term retire
      // plan wires through (see plan/log/ir-adoption.md).
      for (const err of report.errors) {
        // #1923 — meter post-claim demotions for the ratchet gate. These are
        // functions the selector CLAIMED that then failed build/verify/lower/
        // backend-legality and fell back to legacy through this warning channel
        // — counted by no selector-level metric (`IrFallbackReason`). Always
        // collected (cheap: the errors are already iterated here) and surfaced
        // on `CompileResult.irPostClaimErrors`, mirroring `fallbackCounts`,
        // which is likewise always counted; the gate buckets by kind +
        // normalized message class. Pure telemetry; the demotion below is
        // unchanged.
        (ctx.irPostClaimErrors ??= []).push({
          kind: err.kind ?? "lower",
          func: err.func,
          message: err.message,
        });
        const diag = formatIrPathFallbackDiagnostic(err);
        // (#2138) Under IR-first, a post-claim IR failure on a function whose
        // LEGACY body was SKIPPED cannot demote to a warning: there is no
        // legacy body to fall back to — the slot holds an `unreachable`
        // placeholder that would be a live runtime trap. Promote to a hard
        // compile error. This is the intended investigation behavior: the
        // flag's job is to surface exactly these selector↔builder
        // divergences as loud, filable failures (#2135) instead of silent
        // legacy demotes. Functions NOT in the skip set keep today's
        // graceful demotion.
        const skippedTrap = irSkipBodies !== undefined && irSkipBodies.has(err.func);
        ctx.errors.push({
          message:
            skippedTrap && diag.severity !== "error"
              ? `Codegen error: ${diag.message} [IR-FIRST skipped-slot, #2138]`
              : diag.message,
          line: 0,
          column: 0,
          severity: skippedTrap ? "error" : diag.severity,
        });
      }
      // (#2138) Backstop for the skip contract: every function whose legacy
      // body was skipped MUST have been IR-compiled into its slot. A skipped
      // function that neither appears in `report.compiled` nor produced an
      // entry in `report.errors` (which the loop above already promoted)
      // means its placeholder would ship silently — fail the compile.
      if (irSkipBodies !== undefined && irSkipBodies.size > 0) {
        const compiledSet = new Set(report.compiled);
        const erroredSet = new Set(report.errors.map((e) => e.func));
        for (const name of irSkipBodies) {
          if (!compiledSet.has(name) && !erroredSet.has(name)) {
            reportErrorNoNode(
              ctx,
              `IR-first (#2138): legacy body for "${name}" was skipped but the IR path neither compiled it nor reported an error — the unreachable placeholder would ship. Selector/integration divergence; file an issue.`,
            );
          }
        }
      }
      // #1169q telemetry — when JS2WASM_LOG_IR_FALLBACKS=1, log a one-line
      // summary per compile to stderr: total top-level FunctionDeclarations
      // claimed vs. fallback, with rejection reason histogram. This is the
      // gating measurement before retiring the legacy path: drive the
      // claim rate to ~100% (excluding deferred features) and only THEN
      // delete expressions.ts / statements.ts. See #1169q.
      if (trackFallbacks && selection.fallbacks) {
        const total = selection.funcs.size + selection.fallbacks.length;
        const reasonHist: Record<string, number> = {};
        for (const fb of selection.fallbacks) {
          reasonHist[fb.reason] = (reasonHist[fb.reason] ?? 0) + 1;
        }
        const fileLabel = ast.sourceFile.fileName || "<source>";
        const reasonStr = Object.entries(reasonHist)
          .sort((a, b) => b[1] - a[1])
          .map(([r, n]) => `${r}=${n}`)
          .join(",");
        process.stderr.write(
          `[ir-fallback] file=${fileLabel} total=${total} claimed=${selection.funcs.size} fallback=${selection.fallbacks.length} reasons=${reasonStr}\n`,
        );
      }
    }

    // Fixup pass: reconcile struct.new argument counts with actual struct field counts.
    // Dynamic field additions during expression compilation can add fields to struct types
    // after the constructor's struct.new was already emitted (#516).
    fixupStructNewArgCounts(ctx);

    // Fixup pass: insert extern.convert_any after struct.new when the result
    // is stored into an externref local/global.
    fixupStructNewResultCoercion(ctx);

    // Build per-shape default property flags table for all user-visible structs
    buildShapePropFlagsTable(ctx);

    // Collect ref.func targets so the binary emitter can add a declarative element segment
    collectDeclaredFuncRefs(ctx);

    // Resolve deferred `export default <variable>` for module globals (#1108).
    // Must run AFTER compileDeclarations — string-constant imports added during
    // body compilation shift numImportGlobals, so indices aren't final until now.
    if (ctx.deferredDefaultGlobalExport) {
      const varName = ctx.deferredDefaultGlobalExport;
      const globalName = `__mod_${varName}`;
      const localIdx = ctx.mod.globals.findIndex((g) => g.name === globalName);
      if (localIdx >= 0) {
        const absIdx = ctx.numImportGlobals + localIdx;
        const alreadyExported = ctx.mod.exports.some(
          (e) => e.name === "default" || (e.name === varName && e.desc.kind === "global"),
        );
        if (!alreadyExported) {
          ctx.mod.exports.push({ name: "default", desc: { kind: "global", index: absIdx } });
          ctx.mod.exports.push({ name: varName, desc: { kind: "global", index: absIdx } });
        }
      }
      ctx.deferredDefaultGlobalExport = undefined;
    }

    // Copy metadata for .d.ts / helper generation — only include actually-used extern classes
    const importNames = mod.imports.map((imp) => imp.name);
    for (const [key, info] of ctx.externClasses) {
      const prefix = `${info.importPrefix}_`;
      const isUsed = importNames.some((n) => n.startsWith(prefix));
      if (key === info.className && isUsed) {
        mod.externClasses.push({
          importPrefix: info.importPrefix,
          namespacePath: info.namespacePath,
          className: info.className,
          constructorParams: info.constructorParams,
          methods: info.methods,
          properties: info.properties,
        });
      }
    }
    mod.stringLiteralValues = ctx.stringLiteralValues;
    mod.asyncFunctions = ctx.asyncFunctions;
    // (#1700) Surface per-export TypedArray classifications so the JS-host
    // wrapExports can marshal Uint8Array params/results across the boundary.
    if (ctx.exportSignatures.size > 0) {
      const obj: Record<string, import("../ir/types.js").ExportSignature> = {};
      for (const [k, v] of ctx.exportSignatures) obj[k] = v;
      mod.exportSignatures = obj;
    }

    // (#2009) Resolve same-structural-shape field-name collisions BEFORE the
    // getter/setter/name-export emitters read the struct layout. Runs after ALL
    // function bodies are final (legacy + IR), so its struct.new patch covers
    // every construction site uniformly and backend-agnostically. Only structs
    // that genuinely collide are touched; everything else is byte-identical.
    resolveSameShapeFieldNameCollisions(ctx);

    // (#2831) Reserve the per-target-vec host-externref → wasm-vec materializers
    // BEFORE the setter/dispatch emitters bake their value coercions. This pass
    // OWNS its import shifts (reserve-then-fill); the three setter emitters then
    // only `call` the materializer (no funcIdx churn). Must precede
    // emitStructFieldSetters + fillMemberSetDispatch + fillMemberGetDispatch.
    reserveVecFieldMaterializers(ctx);

    // Emit exported struct field getter helpers for the runtime.
    // These allow JS host imports to read WasmGC struct fields that are
    // otherwise opaque to JS (V8 returns undefined for direct property access).
    emitStructFieldGetters(ctx);
    emitStructFieldSetters(ctx);

    // Emit __vec_get / __vec_len exports for runtime iterator fallback on WasmGC arrays
    emitVecAccessExports(ctx);

    // Emit __dv_byte_{len,get,set} exports so the runtime can implement
    // DataView.prototype.{get,set}{Uint,Int,Float}* on i32_byte vec structs (#1056)
    emitDataViewByteExports(ctx);

    // (#3058) __rab_resize / __ab_max_len exports so the host runtime can
    // implement ArrayBuffer.prototype.resize + maxByteLength/resizable on
    // $__resizable_ab vec structs (no-op unless a resizable buffer exists).
    emitResizableAbExports(ctx);

    // (#1503) __vec_set_byte for crypto.getRandomValues to write into Uint8Array vecs.
    emitVecSetByteExport(ctx);

    // (#1700) __new_vec_f64 — JS-callable allocator for f64-element vecs so
    // wrapExports can copy Uint8Array (and other TypedArray) inputs across
    // the JS↔Wasm boundary. Gated on an exported user fn accepting a vec.
    emitNewVecF64Export(ctx);

    // Emit __test_str_from_externref / __test_str_to_externref exports for
    // dual-run testing in nativeStrings mode (#1187). No-op unless
    // ctx.testRuntime && ctx.nativeStrings.
    emitTestRuntimeStringHelpers(ctx);

    // Emit __call_@@iterator export for runtime Symbol.iterator dispatch on WasmGC structs
    emitIteratorMethodExport(ctx);

    // (#2038 / #3100, reserve-then-fill #1719) Rebuild the native `__iterator`
    // body with the LATE ladder arms now that every carrier type is known: the
    // (#3100) vec-FAMILY normalization arms ($ObjVec + `__vec_<elemKind>` —
    // dynamic iterables, previously an `illegal cast` trap) and, when the
    // closed-struct dispatchers just emitted above exist, the (#2038) USER
    // `{next()}` arm. Full docs on `fillNativeIteratorLateArms`. No-op unless
    // the standalone native iterator runtime was registered.
    if (
      ctx.nativeIteratorUserArmPending &&
      !ctx.funcMap.has("__is_truthy") &&
      ((ctx.funcMap.has("__call_@@iterator") &&
        ctx.funcMap.has("__call_next") &&
        ctx.funcMap.has("__sget_value") &&
        ctx.funcMap.has("__sget_done")) ||
        // (#3119) The plain-`$Object` OBJ arm needs `__is_truthy` too (the
        // `@@iterator`/`res` truthiness gates + the ToBoolean on `done`).
        (ctx.funcMap.has("__extern_get") && ctx.funcMap.has("__box_symbol") && ctx.objectRuntimeTypes !== undefined))
    ) {
      // The USER `done` flag needs `__is_truthy` (ToBoolean on the boxed bool).
      // `emitStructFieldGetters` usually registers it via `addUnionImports` when a
      // `{value,done}` bucket boxes, but force it here for the rare bucket shape
      // that does not, so the fill never silently degrades to vec-only.
      // Native in standalone/WASI (appends funcs, no funcIdx shift).
      addUnionImports(ctx);
    }
    fillNativeIteratorLateArms(ctx);

    // (#2903) Rebuild the Iterator-helper steppers (iter-hof-native.ts) with
    // per-producer driven-generator arms + the positive-admission classifier.
    // Read-only per #1719; no-op unless a helper call site reserved them.
    fillIterHofSteppers(ctx);

    // (#2903 R3) Prepend the `$LazyIterHelper` recognition arm to the
    // GetIterator ladder (`__iterator`/`_next`/`_return`) so `Array.from(...)`,
    // spread, and `for…of` drive a lazy map/filter/take/drop wrapper natively.
    // MUST run AFTER `fillNativeIteratorLateArms` (which rebuilds those bodies).
    // No-op unless a lazy wrapper was constructed.
    fillLazyIterLadderArms(ctx);

    // (#2922) Rebuild `__combinator_to_vec`'s user-iterable arm with the same
    // closed-struct dispatchers (identical five-dispatcher condition, so the
    // combinator drain and the native iterator carrier can never disagree).
    // No-op unless a dynamic Promise.all/race argument site registered it.
    fillCombinatorToVec(ctx);

    // (#1716) Emit __call_@@toPrimitive(self, hint) for runtime ToPrimitive
    // dispatch of a class's [Symbol.toPrimitive] *method* on opaque structs.
    emitToPrimitiveMethodExport(ctx);

    // (#2962) Emit __exn_render_prepare / __exn_render_char so the test262
    // harness can render a natively-thrown GC payload ("TypeError: boom")
    // with zero host imports. No-op unless (standalone || wasi) &&
    // nativeStrings && the `$exc` tag was registered (i.e. the module can
    // actually throw).
    emitExceptionRenderExports(ctx);

    // Emit __call_fn_0 export for calling zero-arg closures from JS (#851)
    emitClosureCallExport(ctx);

    // Emit __call_fn_1 export for calling one-arg closures from JS (#1090)
    emitClosureCallExport1(ctx);

    // Emit __call_fn_2 export for calling two-arg closures from JS (#1382)
    // Required for Array.from(iter, mapFn) where mapFn is a Wasm closure —
    // host `Array.from` invokes mapFn with `(value, index)`, so the JS-side
    // wrapper needs a 2-arg dispatcher to route into the closure.
    emitClosureCallExport2(ctx);

    // Emit __call_fn_3 / __call_fn_4 exports (#1382 Phase 2). Required for
    // `Array.prototype.{forEach,map,filter,every,some,find,...}.call(obj, cb)`
    // dispatched through the host `__proto_method_call` — the host invokes
    // the callback with `(value, index, array)` (arity 3) or, for reduce,
    // `(acc, value, index, array)` (arity 4). The dispatchers iterate
    // closures of arity ≤ N; lower-arity closures see extra args dropped.
    emitClosureCallExport3(ctx);
    emitClosureCallExport4(ctx);

    // #1636-S1 — emit __call_fn_method_N exports (N=0..2) for calling Wasm
    // closures from JS with a host-supplied `this`-value. Same dispatch
    // shape as __call_fn_N but takes a leading `thisVal: externref` that
    // is stored in the `__current_this` module global across the inner
    // `call_ref` so that `ThisKeyword` references in a free-function
    // closure body observe the host's receiver. Used by `JSON.stringify`'s
    // live walk to thread the holder identity through `toJSON` and the
    // replacer function per §25.5.2.2 steps 2.b / 3.
    emitClosureMethodCallExportN(ctx, 0);
    emitClosureMethodCallExportN(ctx, 1);
    emitClosureMethodCallExportN(ctx, 2);
    // (#1888 Slice 1) Arities 3 and 4 for the standalone open-any method
    // dispatch bridge `__apply_closure` (spec D7: `o.m(a,b,c[,d])`). Each call
    // is a no-op when no closure of that arity exists, so GC/host modules without
    // arity-3/4 closures stay byte-identical. Dynamic method calls above arity 4
    // are refused-loud in `__apply_closure`.
    emitClosureMethodCallExportN(ctx, 3);
    emitClosureMethodCallExportN(ctx, 4);
    // (#1712) Arity 5 for the fnctor prototype bridge: acorn-style prototype
    // methods (e.g. `Parser.prototype.parseFunction(node, statement,
    // allowExpressionBody, isAsync, forInit)`) are dispatched from the host
    // with a receiver via `wasmClosureBridge` → `__call_fn_method_5`. No-op
    // when no arity-5 closure exists.
    emitClosureMethodCallExportN(ctx, 5);

    // (#2687) Arities 6..8 for HIGHER-arity prototype methods. acorn's
    // `parseSubscript(base, startPos, startLoc, noCalls, maybeAsyncArrow,
    // optionalChained, forInit)` is arity 7 and `parsePropertyValue` is arity 8;
    // a `this.parseSubscript(...)` host method-call wraps the closure and
    // dispatches it through `__call_fn_method_<N>` (runtime.ts wasmClosureBridge /
    // wasmClosureDynamicBridge). With the highest emitted dispatcher capped at 5,
    // an arity-7 closure was OMITTED from `__call_fn_method_5` (its filter is
    // `paramTypes.length <= arity`), so the dynamic method-call returned null and
    // the body never ran — parseSubscript returned null up the parse chain, leaving
    // `ExpressionStatement.expression` null (#2687) and breaking the acorn dogfood.
    // Emit one dispatcher per arity up to the module's actual max closure arity,
    // capped at 8 — the dynamic bridge's scan range
    // (`_wrapWasmClosureUnknownArity` iterates `a = 8..0`). Each call no-ops when
    // no closure of arity ≤ N exists, so modules whose methods top out at ≤5 are
    // byte-identical. Mirrors the #2664 fix direction (a method's declared arity
    // EXCEEDING the dispatcher arity — the symmetric case of fewer-args-than-params).
    {
      let maxClosureArity = 5;
      for (const info of ctx.closureInfoByTypeIdx.values()) {
        if (info.paramTypes.length > maxClosureArity) maxClosureArity = info.paramTypes.length;
      }
      const cap = Math.min(maxClosureArity, 8);
      for (let n = 6; n <= cap; n++) emitClosureMethodCallExportN(ctx, n);
    }

    // (#1719 CPR read-drive) Fill the reserved `__drive_proto_iterator` driver
    // body now that `__call_fn_method_0` is registered. No-op when no read-drive
    // site reserved a driver (brand clear / no Array.prototype @@iterator override).
    fillProtoIteratorDriver(ctx);

    // (#1888 S5b accessor live get/set) Fill the reserved
    // `__call_accessor_get` / `__call_accessor_set` driver bodies now that
    // `__call_fn_method_0` / `__call_fn_method_1` are registered. Same
    // reserve/fill funcIdx-authority pattern as the proto-iterator driver:
    // the `__extern_get` / `__extern_set` accessor arms baked a `call
    // <reserved funcIdx>` at object-runtime-emit time; here we give those
    // placeholders a real body (wrapping the closure-method dispatcher) so a
    // stored getter/setter closure runs with the original receiver as `this`.
    // No-op when no accessor arm reserved a driver (no standalone object runtime).
    fillAccessorDrivers(ctx);

    // (#3231) Fill the reserved `__disposablestack_dispose` driver now that
    // `__call_fn_0`/`__call_fn_1` are registered — runs each stored disposer LIFO.
    // No-op when no `.dispose()` site reserved the driver.
    fillDisposableStackDisposeDriver(ctx);

    // (#1888 Slice 1) Fill the reserved `__apply_closure` bridge body now that
    // `__call_fn_method_0..4` are registered. No-op when no standalone open-any
    // method-dispatch site reserved the bridge (`ctx.applyClosureReserved`).
    fillApplyClosure(ctx);

    // (#3140) Fill the reserved `__bind_dyn` dynamic-bind helper now that every
    // closure root is registered (the callable gate needs the COMPLETE
    // classifier list). No-op when no standalone `.bind`-on-any site reserved it.
    fillBindDynHelper(ctx);

    // (#1100) Fill the reserved standalone Proxy trap-invoke drivers
    // (`__proxy_call_{get,set,has}`) now that `__call_fn_method_2/3/4` are
    // registered. Each driver wraps the matching closure-method dispatcher so a
    // user trap closure runs with the handler bound as `this`. No-op when no
    // standalone `new Proxy` site reserved the runtime (`ctx.proxyDispatchReserved`).
    fillProxyDispatch(ctx);

    // (#2151) Fill the reserved `__call_m_<name>` closed-struct method
    // dispatchers now that every object-literal struct + its `<Struct>_<name>`
    // method funcs are registered. Read-only over funcMap (all deps registered
    // at reserve time), so no funcIdx churn. No-op when no any-receiver call site
    // reserved a dispatcher (standalone/wasi only).
    fillClosedMethodDispatch(ctx);

    // (#3125) Fill the reserved `__promise_has_callable_then` predicate — the
    // native-Promise resolve path's §27.2.1.3.2 Get("then")+IsCallable test —
    // from the SAME struct/closure collectors as the `__call_m_then_vararg`
    // dispatcher the thenable job invokes. Read-only over funcMap. No-op unless
    // the async scheduler's thenable substrate reserved it (standalone/wasi).
    fillPromiseThenableHelpers(ctx);

    // (#3172) Fill the reserved `__setrec_field_{size,has,keys}` GetSetRecord
    // readers — one ref.test arm per closed struct carrying the field, bottom
    // arm = $Object `__extern_get`. Read-only over funcMap. No-op unless a
    // set-algebra any-dispatch site reserved them (standalone/nativeStrings).
    fillSetRecFieldGetters(ctx);

    // (#2664) Fill the reserved `__set_member_<name>` member-WRITE dispatchers now
    // that EVERY struct type (incl. late-registered fnctor structs like acorn's
    // `$__fnctor_Parser`) is known — so each `any`-receiver `obj.<name> = v` write
    // enumerates the COMPLETE struct-candidate set regardless of which function
    // compiled first. Read-only over funcMap (all deps registered at reserve
    // time). No-op when no write site reserved a dispatcher. Fixes the
    // compile-order candidate freeze that lost finishToken's `this.type =` write
    // to the sidecar (8th acorn dogfood wall).
    fillMemberSetDispatch(ctx);

    // (#2674) Fill the reserved `__get_member_<name>` member-READ dispatchers —
    // the symmetric read-side counterpart of the write dispatch above. Each read
    // site's frozen multi-struct alternates fallback was replaced by a call to
    // this dispatcher, filled HERE with the COMPLETE struct-candidate set (incl.
    // late-registered fnctor structs) so a reader compiled before a struct type
    // registered still resolves the real instance's slot. Fixes the read-side
    // compile-order freeze that left parser field reads (`base.end`,
    // `this.lastTokEnd`) resolving to `__extern_get` → `undefined` (acorn 9th wall).
    fillMemberGetDispatch(ctx);

    // (#1904) Fill the standalone native Array.isArray predicate after all
    // module-local array carriers have been registered.
    fillExternIsArray(ctx);

    // (#2190) Fill `__extern_get_idx`'s typed-`__vec_<elemKind>` indexing arms
    // now that every array-literal carrier type is known — sibling of #2189's
    // `.length` fix, so `(arr as any)[i]` through the externref boundary reads
    // the element instead of null/0. Standalone only (no-op otherwise).
    fillExternGetIdxVecArms(ctx);

    // (#3190) Write-side sibling of the fill above: splice `$__vec_base` STORE
    // arms into `__extern_set` so `(arr as any)[i] = v` on an any-typed array
    // lands the in-bounds element instead of silently no-op'ing. Standalone
    // only (no-op otherwise).
    fillExternSetVecArms(ctx);

    // (#3169) Splice CLOSED-STRUCT array-like arms into the standalone
    // dynamic-reader trio (`__extern_length`/`__extern_get_idx`/
    // `__extern_has_idx`) now that the struct-type table is complete — a plain
    // `{0:x, 1:y, length:n}` literal (a closed nominal struct, NOT `$Object`)
    // becomes readable by the generic `Array.prototype.<HOF>.call(obj, cb)`
    // loop. Standalone only (no-op otherwise).
    fillExternArrayLikeStructArms(ctx);

    // (#3183) Splice `$__vec_base` arms into the standalone dynamic-path for-in /
    // string-key helpers (`__object_keys_forin` / `__extern_has` / `__extern_get`)
    // now that `number_toString` / `__str_to_number` / `__extern_get_idx` exist —
    // an ANY-typed runtime array (which lowers to a `__vec_<k>` struct, not a
    // `$Object`) now enumerates its index keys for-in and answers string-key
    // reads (`arr[k]`, `arr["length"]`) instead of empty / undefined. Standalone
    // only (no-op otherwise).
    fillDynamicForinVecArms(ctx);

    // (#3177) `$__ta_dyn_view` §10.4.5 MOP arms — AFTER every vec fill above
    // (each fill prepends at body[0]; last fill wins the front slot, and the
    // dyn-view arm must beat the generic `$__vec_base` arms it subtypes).
    fillTaDynViewMopArms(ctx);

    // (#2896) Fill the reserved builtin-fn metadata natives
    // (`__builtinfn_get_meta` / `__builtinfn_gopd` / `__builtinfn_delete` /
    // `__builtinfn_push_ownnames`) now that every builtin closure meta type
    // (builtin-fn-meta.ts) is registered — the reflective
    // `Object.getOwnPropertyDescriptor(fn, "name")` / `fn[key]` /
    // `hasOwnProperty` / `getOwnPropertyNames` reads over a builtin function
    // value resolve its spec `name`/`length` at runtime, host-free. No-op when
    // no builtin closure was materialized (standalone only).
    fillBuiltinFnMeta(ctx);

    // (#3130) Splice the `$Error_struct` arm into `__extern_get` so dynamic
    // reads of `err.message`/`err.name`/`err.stack`/`err.constructor` resolve
    // on native Error objects instead of missing to `undefined` (see the fill's
    // doc in registry/error-types.ts). No-op unless the module constructs
    // native errors (standalone/wasi only) — byte-identical otherwise.
    fillExternGetErrorProps(ctx);

    // (#2358 #10) Fill the reserved `__array_to_primitive_string` body now that
    // `__extern_length`/`__extern_get_idx` (filled just above) and the native
    // string helpers exist. `__to_primitive`'s array-reduce arm baked a `call`
    // to this reserved funcIdx at emit time; here it gets the real
    // Array.prototype.toString (`join(",")`) loop so `Number([1])` / `1 + [2]` /
    // `"1,2" == [1,2]` reduce a runtime `$Vec` host-free. No-op when no standalone
    // `__to_primitive` reserved it (`ctx.arrayToPrimitiveReserved`).
    fillArrayToPrimitive(ctx);

    // #1504: emit __is_closure(externref) -> i32 so the JS-side wrapExports
    // can discriminate a closure struct return from a vec/struct return
    // (necessary because __vec_len returns 0 for both empty arrays and
    // non-vec structs — JS cannot tell them apart without this probe).
    emitIsClosureExport(ctx);

    // #2623 P-7 (B-1): emit __closure_arity(externref) -> i32 so the JS-side
    // dynamic bridge can dispatch host→wasm method callbacks at the closure's
    // REAL declared arity (exact `arguments.length` reflection) instead of the
    // highest emitted __call_fn_method_N.
    emitClosureArityExport(ctx);

    // #2794: emit __is_data_struct(externref) -> i32 — POSITIVE data-vs-closure
    // discriminator so `_wrapForHost` only bridges genuine closures and never
    // masks a data struct (AST Node / class instance / object literal) as callable.
    emitIsDataStructExport(ctx);

    // #1896: teach standalone __typeof_function/__typeof_object to recognise
    // closure wrapper structs (closures registered after the typeof helpers were
    // synthesised mid-compile). Edits the helper bodies in place — no funcIdx churn.
    fillStandaloneTypeofClosureArms(ctx);

    // Emit __call_toString/__call_valueOf exports for ToPrimitive dispatch (#866)
    emitToPrimitiveMethodExports(ctx);

    // (#2638) Fill the reserved `__class_to_primitive` driver now that the
    // per-struct `__call_valueOf`/`__call_toString` dispatchers exist (emitted
    // just above). `__to_primitive`'s standalone class arm baked a `call` to the
    // reserved funcIdx at emit time; here it gets the real §7.1.1.1
    // valueOf/toString dispatch so `(new C() as any) - 8` / `Number(new C() as any)`
    // reduce via the class's methods host-free. No-op when no standalone
    // `__to_primitive` reserved it (`ctx.classToPrimitiveReserved`).
    fillClassToPrimitive(ctx);

    // #1326c Phase 1C-A — export __drain_microtasks BEFORE WASI _start so the
    // _start wrapper (which appends a drain call) can find its funcIdx.
    // Idempotent + no-op when the queue was never registered.
    exportDrainMicrotasksIfRegistered(ctx);

    // WASI: export _start entry point (before dead import elimination adjusts indices)
    if (ctx.wasi) {
      addWasiStartExport(ctx);
    }

    // Export the exception tag so the exec worker can extract thrown payloads
    // via WebAssembly.Exception.getArg(tag, 0).
    if (ctx.exnTagIdx >= 0) {
      const numImportTags = mod.imports.filter((i) => i.desc.kind === "tag").length;
      mod.exports.push({
        name: "__exn_tag",
        desc: { kind: "tag", index: numImportTags + ctx.exnTagIdx },
      });
    }

    // Mark leaf struct types as final for V8 devirtualization (#594).
    // Skipped for `--target wasi` so that downstream `wasm-opt --all-features`
    // does not convert refs to those types into `(ref exact $T)`, which
    // wasmtime ≤ 44 rejects (#1173).
    // (#2580 M0) Emit the dynamic-read primitives (__dyn_has/__dyn_get) iff a
    // call site flagged the module needs them (M1+). Gated on ctx.usesDynRead,
    // which M0 never sets, so this is a no-op in M0 → byte-identical. Runs before
    // dead-elim/freeze so the helper funcIdx values are stable.
    ensureDynReadHelpers(ctx);
    // (#3053 U0) Emit the unified dynamic-reader carrier primitive
    // (__dyn_member_get + __carrier_recv_to_extern) iff a call site flagged the
    // module needs it (U1+). Gated on ctx.usesDynMemberGet, which U0 never sets,
    // so this is a no-op in U0 → byte-identical. Runs beside ensureDynReadHelpers
    // (before dead-elim/freeze) so the helper funcIdx values are stable.
    ensureDynMemberGet(ctx);

    // (#2800) Allocate + wire the `__in_module_init` flag global now that every
    // import global has settled (final absolute index), patching the recorded
    // delete-aware read `global.get` placeholders and wrapping `__module_init`.
    // Runs before dead-elim (which never prunes/remaps live globals) and the
    // index freeze. No-op unless a gc/host delete-aware read recorded the flag.
    finalizeInModuleInitFlag(ctx);

    // (#2853) Nominal shape branding: structurally-colliding `__anon_*` /
    // `__fnctor_*` shape types get a trailing brand-ref field so the engine's
    // iso-recursive canonicalization cannot merge distinct key-sets into one
    // runtime type (which made `ref.test`-keyed property dispatch read fields
    // by OFFSET instead of by KEY). Runs after all instruction emission and
    // BEFORE dead-type elimination so the brand-chain refs get remapped.
    brandCollidingShapeTypes(mod, ctx.noBrandShapeTypes);

    markLeafStructsFinal(mod, ctx.wasi);

    // Dead import and type elimination pass
    eliminateDeadImports(mod, ctx); // #1899 ctx → remap helper side-tables on import removal

    // Repair struct.get/struct.set type mismatches (externref → struct ref conversion)
    repairStructTypeMismatches(mod);

    // Peephole optimization: remove redundant ref.as_non_null after ref.cast, etc.
    peepholeOptimize(mod);

    // #1984 — freeze the index spaces. Every legitimate late import mutation
    // (addUnionImports / addStringImports / reconcileNativeStrFinalizeShift,
    // across gc/wasi/standalone) has run by this point; the remaining passes
    // (stackBalance, fixupExternConvertAny, emit) do NOT add imports. Any
    // addImport/ensureLateImport after here is a producer bug and throws at
    // its own call site (see imports.ts / late-imports.ts).
    ctx.indexSpaceFrozen = true;

    // Stack-balancing fixup: ensure all branches in if/try/block have matching stack states
    stackBalance(mod);
    // #1918 — drain fixup telemetry: per-compile debug log + optional strict mode.
    drainStackBalanceTelemetry(ctx, ast.sourceFile.fileName);

    // Late fixup: repair extern.convert_any applied to non-anyref values.
    // Must run after all other passes since they can introduce invalid coercions.
    fixupExternConvertAny(ctx);
  } catch (e) {
    reportErrorNoNode(ctx, `Codegen error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // (#2094) Emit-time backstop for the addImport gate: scan the finished
  // import section for host imports that leaked into a standalone/strict
  // binary and report each as a structured compile error.
  assertNoLeakedHostImports(ctx, mod);

  return {
    module: mod,
    errors: ctx.errors,
    fallbackCounts: ctx.fallbackCounts,
    irPostClaimErrors: ctx.irPostClaimErrors,
    irCompiledFuncs: ctx.irCompiledFuncs,
    irFirstSkipped,
  };
}

/**
 * (#2094) Post-link import-section scan — the emit-time backstop for the
 * `addImport` gate.
 *
 * Gated on `ctx.strictNoHostImports` ONLY, deliberately matching the per-call
 * `addImport` gate's trigger (`src/codegen/registry/imports.ts`). Under strict
 * mode (auto-on for `--target wasi`, opt-in via `--no-host-imports`) the build
 * contract is "no JS-host imports", so a host import that survived dead-import
 * elimination bypassed the gate (stale funcMap index / direct `mod.imports.push`)
 * and would fail instantiation in a hostless runtime (#2073/#2075). This scan
 * turns that into a clean `success: false` CE instead.
 *
 * It does NOT fire on plain `--target standalone` (which is NOT strict by
 * default): standalone builds today still tolerate a set of `env` imports that
 * the test harness satisfies, and rejecting them here would regress thousands
 * of currently-passing standalone tests. The scan is a backstop for the strict
 * contract, not a new policy — when standalone is run strictly
 * (`strictNoHostImports`) it is covered. No-op for host/WasmGC builds.
 */
function assertNoLeakedHostImports(ctx: CodegenContext, mod: WasmModule): void {
  if (!ctx.strictNoHostImports) return;
  // #2783 — pass `ctx.linkedNamespaces` so an arbitrary `--link`'d namespace's
  // imports survive the strict gate (left as link-time imports for a preloaded
  // provider) instead of being rejected as leaked host imports.
  const leaks = scanForLeakedHostImports(mod.imports, ctx.linkedNamespaces);
  for (const leak of leaks) {
    reportErrorNoNode(ctx, buildLeakedHostImportError(leak));
  }
}

/**
 * #1918 — Drain stack-balance fixup telemetry after a `stackBalance(mod)` run.
 *
 * Every fixup the pass applied is a masked emitter bug. Previously the count
 * was returned and discarded. Now we:
 *   - Under `JS2WASM_LOG_STACK_BALANCE=1`, log a one-line per-kind histogram to
 *     stderr (per-compile debug visibility — AC #1).
 *   - Under `JS2WASM_STRICT_BALANCE`, push each fixup as a located
 *     severity-"warning" (=1) or severity-"error" (=error) onto `ctx.errors`
 *     (AC #3 — the lossy const-default arm is warning-visible). Strict errors
 *     fail the WasmGC compile through the existing `severity === "error"` gate.
 *
 * MUST be called immediately after `stackBalance(mod)` — the collector is
 * module-scoped and reset on the next `stackBalance` call.
 */
function drainStackBalanceTelemetry(ctx: CodegenContext, fileLabel: string): void {
  const events = getFixupEvents();
  if (process.env.JS2WASM_LOG_STACK_BALANCE === "1") {
    const counts = summarizeFixups(events);
    const hist = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}=${n}`)
      .join(",");
    process.stderr.write(`[stack-balance] file=${fileLabel || "<source>"} fixups=${events.length} ${hist}\n`);
  }
  for (const diag of strictBalanceDiagnostics(events)) {
    ctx.errors.push({ message: diag.message, line: diag.line, column: diag.column, severity: diag.severity });
  }
}

/**
 * (#1789) Ensure `__module_init` runs before any exported function in WASI
 * mode. Two steps, both idempotent:
 *   1. Add a fresh `__init_done` i32 global (0) and prepend a self-guard to
 *      `__module_init`: `if (__init_done) return; __init_done = 1; …`.
 *   2. Prepend `call __module_init` to every exported function's body except
 *      `__module_init` itself (and `_start`, which is created later by
 *      addWasiStartExport and already calls `__module_init`).
 * Runs once — guarded by `ctx.moduleInitGuardApplied`.
 */
/**
 * (#2800) Finalize the `__in_module_init` flag, if any delete-aware `any`-receiver
 * read recorded one. The flag reads 1 while `__module_init` runs, 0 otherwise;
 * the read site (`tryEmitDeleteAwareDynamicGet`) branches on it — gc/host runs
 * `__module_init` via the Wasm `start` section INSIDE `WebAssembly.instantiate`,
 * before the host wires struct getters (`__setExports`), so the host
 * `__extern_get`'s `__sget_<field>` struct-read fallback returns undefined for
 * every field at init. The flag steers the read to the host-free
 * `__get_member_<name>` dispatcher during init and back to the tombstone-aware
 * host read at runtime.
 *
 * Allocates the i32 flag global HERE — after every import global has settled —
 * so its absolute index is final, then patches each recorded read's placeholder
 * `global.get` index to it (sidestepping the live-baked-index hazard where a
 * later string-constant import shifts the module-global range through closure
 * bodies the per-add fixup can miss) and wraps `__module_init` with set-1 /
 * set-0 around its body. MUST run AFTER the last import-global addition and BEFORE
 * the index-space freeze. No-op when no read recorded the flag (delete-free /
 * standalone / WASI modules stay byte-identical). gc/host has no module-init
 * idempotency guard (the Wasm `start` section runs the body exactly once), so the
 * simple prologue/epilogue wrap is sufficient; WASI/standalone never reach here
 * (the read site only records the flag when `!ctx.wasi`).
 */
function finalizeInModuleInitFlag(ctx: CodegenContext): void {
  const reads = ctx.inModuleInitFlagReads;
  if (!reads || reads.length === 0) return;

  // Allocate the flag global now that the import-global range is final, and
  // patch every recorded read's PLACEHOLDER index to the final slot. This MUST
  // happen even when there is no `__module_init` (a module whose only
  // delete-aware reads live inside ordinary functions, never at top level) —
  // otherwise the placeholder index 0 survives and points at the first import
  // global (an externref string constant), tripping `if[0] expected i32`
  // validation. With no init the flag simply stays 0, so every gated read takes
  // the runtime (host `__extern_get`) arm — exactly the pre-#2800 behaviour.
  const flagIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__in_module_init",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  ctx.inModuleInitGlobalIdx = flagIdx;
  for (const r of reads) (r as { index: number }).index = flagIdx;

  // Wrap __module_init (when present): flag = 1 for the body, 0 on completion.
  let initArrayIdx = -1;
  for (let i = 0; i < ctx.mod.functions.length; i++) {
    if (ctx.mod.functions[i]!.name === "__module_init") {
      initArrayIdx = i;
      break;
    }
  }
  if (initArrayIdx < 0) return;
  const initFn = ctx.mod.functions[initArrayIdx]!;
  initFn.body = [
    { op: "i32.const", value: 1 },
    { op: "global.set", index: flagIdx },
    ...initFn.body,
    { op: "i32.const", value: 0 },
    { op: "global.set", index: flagIdx },
  ];
}

function applyModuleInitGuard(ctx: CodegenContext): void {
  if (ctx.moduleInitGuardApplied) return;

  // Locate __module_init.
  let initArrayIdx = -1;
  for (let i = 0; i < ctx.mod.functions.length; i++) {
    if (ctx.mod.functions[i]!.name === "__module_init") {
      initArrayIdx = i;
      break;
    }
  }
  if (initArrayIdx < 0) return; // no module init — nothing to guard
  const initFuncIdx = ctx.numImportFuncs + initArrayIdx;

  // 1. __init_done global + self-guard prologue on __module_init.
  const doneGlobalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__init_done",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  const initFn = ctx.mod.functions[initArrayIdx]!;
  initFn.body = [
    { op: "global.get", index: doneGlobalIdx },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
    { op: "i32.const", value: 1 },
    { op: "global.set", index: doneGlobalIdx },
    ...initFn.body,
  ];

  // 2. Prepend `call __module_init` to every exported function (except
  //    __module_init itself). Idempotency makes repeated entry calls safe.
  for (const fn of ctx.mod.functions) {
    if (!fn.exported) continue;
    if (fn.name === "__module_init") continue;
    fn.body = [{ op: "call", funcIdx: initFuncIdx }, ...fn.body];
  }

  ctx.moduleInitGuardApplied = true;
}

/** Add a _start export for WASI — wraps a user `main()` (running module init
 *  first via the #1789 guard) or, when there is no callable `main`, the bare
 *  `__module_init` (#1122).
 *  When the async microtask queue was registered (#1326c Phase 1C-A), append a
 *  call to `__drain_microtasks` after the entry function so any scheduled
 *  microtasks fire before WASI process exit. */
function addWasiStartExport(ctx: CodegenContext): void {
  // (#1789) Make module init run before ANY exported function, not just
  // `_start`. The test262 standalone harness calls exports (e.g. `test()`)
  // directly without invoking `_start`, so a module-level `const`/`let`
  // object initializer would never run and a read of that binding would trip
  // its TDZ guard global → trap before init. We make `__module_init`
  // idempotent (self-guarded by a fresh `__init_done` i32 global) and prepend
  // `call __module_init` to every exported user function. The first entry
  // called — `_start` or a direct export — runs init exactly once; later calls
  // no-op. Observable top-level side effects (console.log/stdout) therefore
  // still fire on whichever entry runs first (for WASI hosts that's `_start`,
  // preserving existing stdout behaviour) and never run twice.
  //
  // This MUST run BEFORE we pick the `_start` target below: the guard prepends
  // `call __module_init` to every exported function (including a user `main`),
  // which is exactly what lets `_start → main` run module init before main's
  // body without splicing the init body into `main` (see the #1411/#1978 note
  // on target selection).
  if (ctx.wasi) {
    applyModuleInitGuard(ctx);
  }

  // (#2968) Pre-emit the uncaught-exception printer helper BEFORE any funcidx is
  // read below, so any late import it (transitively) registers shifts the index
  // space first and every index we compute afterwards is already post-shift.
  // Gated on a throwing (`exnTagIdx >= 0`), native-strings WASI module that has
  // the fd_write + proc_exit imports the printer needs (registerWasiImports set
  // both when the source contains a `throw`). A no-op otherwise, so the `_start`
  // body stays byte-identical for every non-throwing module.
  if (ctx.wasi && ctx.exnTagIdx >= 0 && ctx.nativeStrings && ctx.wasiFdWriteIdx >= 0 && ctx.wasiProcExitIdx >= 0) {
    ensureWasiStartExnPrinter(ctx);
  }

  // Choose the WASI program entry that `_start` wraps.
  //
  // #1411 regression: #1978 correctly stopped splicing the module-init body
  // INTO a user `main` (init must run once at module load, not on every
  // `main()` call), moving init to a standalone `__module_init`. But that left
  // this function preferring `__module_init` unconditionally, so for a program
  // WITH a user `main` (e.g. the Native Messaging host) `_start` wrapped ONLY
  // `__module_init` — top-level globals were initialised but the user `main()`
  // never ran, so the program produced no stdout under wasmtime.
  //
  // Fix: prefer an EXPORTED, no-arg, no-result `main` as the entry. Because
  // applyModuleInitGuard (above) has already prepended `call __module_init` to
  // every exported function, wrapping `main` runs module init exactly once (the
  // idempotent guard) and THEN main's body — restoring the pre-#1978 behaviour
  // WITHOUT re-introducing the splice. Only when there is no callable exported
  // `main` do we fall back to wrapping `__module_init` directly: that covers
  // pure top-level / init-only programs, and the `main()`-calls-itself
  // convention where a NON-exported `main` is already invoked from top-level
  // code captured in `__module_init`.
  let targetIdx: number | undefined;

  const mainIdx = ctx.funcMap.get("main");
  if (mainIdx !== undefined) {
    const func = definedFuncAt(ctx, mainIdx);
    if (func) {
      const funcType = ctx.mod.types[func.typeIdx];
      // Only an EXPORTED, no-arg, no-result `main` is a valid `_start` entry.
      // A non-exported `main` (the `main()`-calls-itself convention) is reached
      // through the top-level call already captured in `__module_init`, so it
      // must NOT be the target — and, being non-exported, it does NOT carry the
      // guard's `call __module_init` prefix, so wrapping it would skip module
      // init entirely.
      if (
        func.exported &&
        funcType &&
        funcType.kind === "func" &&
        funcType.params.length === 0 &&
        funcType.results.length === 0
      ) {
        targetIdx = mainIdx;
      }
    }
  }

  // No callable exported `main` → wrap `__module_init`, which carries all
  // top-level code (including any top-level call to a non-exported `main`).
  if (targetIdx === undefined) {
    for (let i = 0; i < ctx.mod.functions.length; i++) {
      if (ctx.mod.functions[i]!.name === "__module_init") {
        targetIdx = ctx.numImportFuncs + i;
        break;
      }
    }
  }

  if (targetIdx !== undefined) {
    // Create _start wrapper that calls the target function
    const startTypeIdx = addFuncType(ctx, [], [], "$wasi_start_type");
    const startFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    const body: Instr[] = [{ op: "call", funcIdx: targetIdx }];

    // #2632 Phase 1 — drive the event-loop reactor after the entry function
    // returns. When the timer heap was registered, `__run_event_loop`
    // SUPERSEDES the one-shot drain: it drains microtasks AND fires timers in a
    // loop until no pending handles remain (and it calls `__drain_microtasks`
    // itself, so we must NOT also emit the bare drain). When no timer heap was
    // registered, fall back to the #1326c one-shot drain — byte-identical to
    // the prior behaviour for every program that uses no timers.
    const runLoopFuncIdx = getRunLoopFuncIdxForWasiStart(ctx);
    if (runLoopFuncIdx !== null) {
      body.push({ op: "call", funcIdx: runLoopFuncIdx });
    } else {
      const drainFuncIdx = getDrainFuncIdxForWasiStart(ctx);
      if (drainFuncIdx !== null) {
        body.push({ op: "call", funcIdx: drainFuncIdx });
      }
    }

    // (#2968) If the uncaught-exception printer was emitted (throwing WASI
    // module), wrap the entry call + reactor drain in `try` / `catch $exc`.
    // A `return` inside the entry exits the `try` without entering the catch, so
    // only a real uncaught throw reaches the handler; there it renders the
    // payload to stderr via `__error_to_string`/fd_write and `proc_exit(1)`s so
    // the exception surfaces (instead of the pre-fix silent exit 0). No wrap when
    // the printer is absent → non-throwing modules stay byte-identical.
    const exnPrinterIdx = ctx.funcMap.get("__wasi_start_print_exn");
    const startBody: Instr[] =
      exnPrinterIdx !== undefined && ctx.wasiProcExitIdx >= 0
        ? [
            {
              op: "try",
              blockType: { kind: "empty" },
              body,
              catches: [
                {
                  tagIdx: ctx.exnTagIdx,
                  body: [
                    // The catch pushes the thrown externref payload; render + write it.
                    { op: "call", funcIdx: exnPrinterIdx },
                    // An uncaught exception is a failure — exit nonzero.
                    { op: "i32.const", value: 1 },
                    { op: "call", funcIdx: ctx.wasiProcExitIdx },
                    { op: "unreachable" },
                  ],
                },
              ],
            },
          ]
        : body;

    ctx.mod.functions.push({
      name: "_start",
      typeIdx: startTypeIdx,
      locals: [],
      body: startBody,
      exported: true,
    });

    ctx.mod.exports.push({
      name: "_start",
      desc: { kind: "func", index: startFuncIdx },
    });
  }
}

/**
 * Emit exported method dispatch functions for the iterator protocol:
 * - __call_@@iterator(externref) -> externref — calls [Symbol.iterator]() on structs
 * - __call_next(externref) -> externref — calls .next() on iterator structs
 *
 * These allow the runtime to invoke WasmGC struct methods that are opaque to JS.
 */
function emitIteratorMethodExport(ctx: CodegenContext): void {
  // Only emit if the iterator imports are registered (i.e., for-of on non-array types)
  if (!ctx.funcMap.has("__iterator") && !ctx.funcMap.has("__iterator_next")) return;

  const mod = ctx.mod;
  const dispatchTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$call_method_type");

  // Helper to emit a method dispatch export
  const emitMethodDispatch = (methodSuffix: string, exportName: string) => {
    const entries: { structName: string; typeIdx: number; funcIdx: number; resultType: ValType }[] = [];

    for (const [structName] of ctx.structFields) {
      const typeIdx = ctx.structMap.get(structName);
      if (typeIdx === undefined) continue;
      if (isSyntheticStructName(structName)) continue;

      const methodFullName = `${structName}_${methodSuffix}`;
      const funcIdx = ctx.funcMap.get(methodFullName);
      if (funcIdx === undefined) continue;

      const funcDef = definedFuncAt(ctx, funcIdx);
      const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
      const resultType: ValType =
        funcType && funcType.kind === "func" && funcType.results.length > 0
          ? funcType.results[0]!
          : { kind: "externref" };

      entries.push({ structName, typeIdx, funcIdx, resultType });
    }

    if (entries.length === 0) return;

    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const body: Instr[] = [];
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "any.convert_extern" });
    body.push({ op: "local.set", index: 1 });

    let current: Instr[] = [{ op: "ref.null.extern" }];

    for (const entry of entries) {
      const testAndCall: Instr[] = [
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: entry.typeIdx },
        { op: "call", funcIdx: entry.funcIdx },
      ];

      if (entry.resultType.kind === "ref" || entry.resultType.kind === "ref_null") {
        testAndCall.push({ op: "extern.convert_any" });
      } else if (entry.resultType.kind === "f64") {
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          testAndCall.push({ op: "call", funcIdx: boxIdx });
        }
      } else if (entry.resultType.kind === "i32") {
        testAndCall.push({ op: "f64.convert_i32_s" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          testAndCall.push({ op: "call", funcIdx: boxIdx });
        }
      }
      // externref: no conversion needed

      current = [
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx: entry.typeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: testAndCall,
          else: current,
        },
      ];
    }

    body.push(...current);

    mod.functions.push({
      name: exportName,
      typeIdx: dispatchTypeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as WasmFunction);

    mod.exports.push({
      name: exportName,
      desc: { kind: "func", index: funcIdx },
    });

    // (#2038) Register in funcMap so the native iterator carrier's USER arm can
    // resolve `__call_@@iterator` / `__call_next` at finalize-fill time
    // (`fillNativeIteratorLateArms`). Harmless for the host/GC path — no other
    // code looks these up by funcMap key.
    ctx.funcMap.set(exportName, funcIdx);
  };

  emitMethodDispatch("@@iterator", "__call_@@iterator");
  emitMethodDispatch("next", "__call_next");
  emitMethodDispatch("return", "__call_return"); // (#3100 S5) IteratorClose §7.4.9 USER-arm dispatcher

  // (#3123) Host-side class-member resolution surface for fnctor-subclass
  // instances (`class C extends F`, F a top-level plain function — the test262
  // Iterator-shim shape). The runtime's `_resolveClassMemberOnInstance` reads
  // `inst.next` / `inst.return` through these:
  //   __member_kind_<key>(recv) -> i32 : 0 none / 1 method / 2 getter
  //   __call_get_<key>(recv) -> externref : runs the compiled getter
  // (the plain-method CALL goes through the existing __call_<key> dispatchers
  // above). Gated on the module actually containing a fnctor subclass so every
  // other module's emitted bytes are IDENTICAL.
  if (!ctx.standalone && !ctx.wasi && moduleHasFnctorSubclass(ctx)) {
    // The iterator protocol keys plus every instance method / accessor name
    // of the module's fnctor-subclass classes (a widened binding dispatches
    // ALL its member calls dynamically — see fnctorWidenedLocals).
    const keys = new Set<string>(["next", "return"]);
    for (const className of ctx.classParentMap.keys()) {
      if (fnctorAncestorOfClass(ctx, className) === undefined) continue;
      for (const m of ctx.classMethodNames.get(className) ?? []) keys.add(m);
      const accPrefix = `${className}_`;
      for (const acc of ctx.classAccessorSet) {
        if (acc.startsWith(accPrefix)) keys.add(acc.slice(accPrefix.length));
      }
    }
    emitClassMemberKindExports(ctx, dispatchTypeIdx, [...keys].sort());
  }
}

/**
 * (#3123) Emit, per member key, the `__member_kind_<key>` discriminator and
 * (when any struct carries a getter of that name) the `__call_get_<key>`
 * getter dispatcher. Mirrors `emitIteratorMethodExport`'s per-struct
 * ref.test cascade. Only 1-param (self-only) methods/getters are reported —
 * that is what the 0-arg `__call_<key>` / `__call_get_<key>` dispatchers can
 * actually invoke; a parameterized `next(v)` stays unreported (kind 0) so the
 * host falls back instead of emitting an arity-invalid call.
 */
function emitClassMemberKindExports(ctx: CodegenContext, dispatchTypeIdx: number, keys: string[]): void {
  const mod = ctx.mod;
  const skipStruct = isSyntheticStructName;

  type KindEntry = { typeIdx: number; funcIdx: number; resultType: ValType };
  const collect = (nameOf: (structName: string) => string): KindEntry[] => {
    const entries: KindEntry[] = [];
    for (const [structName] of ctx.structFields) {
      const typeIdx = ctx.structMap.get(structName);
      if (typeIdx === undefined || skipStruct(structName)) continue;
      const fullName = nameOf(structName);
      if (ctx.staticMethodSet.has(fullName)) continue; // instance surface only
      const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName));
      if (funcIdx === undefined) continue;
      const funcDef = definedFuncAt(ctx, funcIdx);
      const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
      if (!funcType || funcType.kind !== "func") continue;
      if (funcType.params.length !== 1) continue; // self-only (0-arg dispatch)
      const resultType: ValType = funcType.results.length > 0 ? funcType.results[0]! : { kind: "externref" };
      entries.push({ typeIdx, funcIdx, resultType });
    }
    return entries;
  };

  const kindTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$member_kind_type");

  for (const key of keys) {
    if (ctx.funcMap.has(`__member_kind_${key}`)) continue; // idempotent
    const methodEntries = collect((s) => `${s}_${key}`);
    const getterEntries = collect((s) => `${s}_get_${key}`);
    if (methodEntries.length === 0 && getterEntries.length === 0) continue;

    // __member_kind_<key>: ref.test cascade → 1 (method) / 2 (getter) / 0.
    {
      const funcIdx = ctx.numImportFuncs + mod.functions.length;
      let current: Instr[] = [{ op: "i32.const", value: 0 }];
      const arm = (typeIdx: number, kind: number, tail: Instr[]): Instr[] => [
        { op: "local.get", index: 1 },
        { op: "ref.test", typeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "i32.const", value: kind }],
          else: tail,
        },
      ];
      for (const e of methodEntries) current = arm(e.typeIdx, 1, current);
      for (const e of getterEntries) current = arm(e.typeIdx, 2, current);
      const exportName = `__member_kind_${key}`;
      mod.functions.push({
        name: exportName,
        typeIdx: kindTypeIdx,
        locals: [{ name: "__any", type: { kind: "anyref" } }],
        body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }, ...current],
        exported: true,
      } as WasmFunction);
      exportFunc(mod, exportName, funcIdx);
      ctx.funcMap.set(exportName, funcIdx);
    }

    // __call_get_<key>: run the compiled getter, box-coerce to externref.
    if (getterEntries.length > 0) {
      const funcIdx = ctx.numImportFuncs + mod.functions.length;
      let current: Instr[] = [{ op: "ref.null.extern" }];
      for (const e of getterEntries) {
        const callArm: Instr[] = [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: e.typeIdx },
          { op: "call", funcIdx: e.funcIdx },
        ];
        if (e.resultType.kind === "ref" || e.resultType.kind === "ref_null") {
          callArm.push({ op: "extern.convert_any" });
        } else if (e.resultType.kind === "f64") {
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) callArm.push({ op: "call", funcIdx: boxIdx });
        } else if (e.resultType.kind === "i32") {
          callArm.push({ op: "f64.convert_i32_s" });
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) callArm.push({ op: "call", funcIdx: boxIdx });
        }
        current = [
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: e.typeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: callArm,
            else: current,
          },
        ];
      }
      const exportName = `__call_get_${key}`;
      mod.functions.push({
        name: exportName,
        typeIdx: dispatchTypeIdx,
        locals: [{ name: "__any", type: { kind: "anyref" } }],
        body: [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }, ...current],
        exported: true,
      } as WasmFunction);
      exportFunc(mod, exportName, funcIdx);
      ctx.funcMap.set(exportName, funcIdx);
    }
  }
}

/**
 * (#1716) Emit `__call_@@toPrimitive(self, hint) -> externref` — a 2-arg
 * dispatch wrapper so the runtime can invoke a class's `[Symbol.toPrimitive]`
 * *method* on an opaque WasmGC struct.
 *
 * Unlike valueOf/toString (which compile to `__call_<name>` 1-arg dispatchers
 * emitted by `emitToPrimitiveMethodExports` and picked up by `_hostToPrimitive`'s
 * OrdinaryToPrimitive loop), the exotic @@toPrimitive method takes the ToPrimitive
 * hint string and had NO runtime dispatch export — so ToPropertyKey (object used
 * as a property key) and String()/RegExp()/Date() object-arg coercion on such a
 * key/arg silently fell through to the opaque-struct "[object Object]" sentinel
 * (the §7.1.1 residual tracked in #1716). The method body is registered as
 * `${structName}_@@toPrimitive(self, hint)`; we ref.test `self` against each
 * such struct and forward the externref hint.
 *
 * The dispatch forwards the runtime-supplied hint as an externref (the JS-host
 * string backend's representation). In nativeStrings mode the hint param is a
 * WasmGC `(ref $string)` i16 array we cannot synthesize from the externref
 * inline, and the runtime that calls `__call_@@toPrimitive` is JS-host-only and
 * never runs in the standalone nativeStrings path — so such entries are skipped
 * to keep Wasm validation green in every mode.
 */
function emitToPrimitiveMethodExport(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const methodSuffix = "@@toPrimitive";
  const exportName = "__call_@@toPrimitive";

  // (#2083) Ensure the union imports (which register `__box_number`) are present
  // BEFORE the entries loop below resolves `funcIdx` values and reads result
  // signatures. A numeric (`f64`/`i32`) `[Symbol.toPrimitive]` result is boxed to
  // externref via `__box_number` for the dispatcher's externref fallthrough; the
  // boxing arms `ctx.funcMap.get("__box_number")` and silently skip the `call`
  // when it is absent, leaving an `f64`/struct ref where the block result demands
  // `externref` (invalid Wasm). This used to be masked because
  // `emitVecAccessExports` ran earlier and unconditionally called
  // `addUnionImports`; now that the vec exports are gated on actual array usage
  // (#2083), an object-only program with a numeric `[Symbol.toPrimitive]` and no
  // arrays no longer gets that side effect. `addUnionImports` adds imports and
  // SHIFTS function indices, so it MUST run before `funcIdx`/`resultType` are
  // captured below — doing it after would leave the captured `funcIdx` integers
  // pointing at the wrong (pre-shift) functions. It is idempotent
  // (`ctx.hasUnionImports` guard), so modules that already added the imports —
  // every array-using module, and any object module that needed them elsewhere —
  // are byte-identical. Gated on the presence of any numeric `@@toPrimitive`
  // method so non-toPrimitive / string-only-toPrimitive modules add no import.
  if (toPrimitiveNeedsBoxing(ctx, methodSuffix)) {
    addUnionImports(ctx);
  }

  const entries: { typeIdx: number; funcIdx: number; resultType: ValType; takesHint: boolean }[] = [];

  for (const [structName] of ctx.structFields) {
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    if (isSyntheticStructName(structName)) continue;

    const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, `${structName}_${methodSuffix}`)); // (#1983)
    if (funcIdx === undefined) continue;

    const funcDef = definedFuncAt(ctx, funcIdx);
    const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
    const resultType: ValType =
      funcType && funcType.kind === "func" && funcType.results.length > 0
        ? funcType.results[0]!
        : { kind: "externref" };

    // (#2883) The resolved `${structName}_@@toPrimitive` function is either a
    // 2-param `(self, hint) -> result` method (the method declared its hint
    // param — nominal class OR object literal `[Symbol.toPrimitive](hint)`) or a
    // 1-param `(self) -> result` body (the method ignores the hint, e.g. the very
    // common `[Symbol.toPrimitive]() { throw … }` abrupt-completion shape, whose
    // object-literal closure body is `(captureStruct) -> result`). The dispatcher
    // must forward the hint ONLY in the 2-param case; pushing `self + hint` into a
    // 1-param callee produced an arity mismatch that a downstream arg-coercion
    // pass "repaired" by dropping the result and leaving the struct ref on the
    // stack — yielding an invalid `fallthru[0] (expected externref, got (ref N))`
    // module for ~40 suite-wide tests. Branch on the real param count.
    const paramCount = funcType && funcType.kind === "func" ? funcType.params.length : 1;
    const takesHint = paramCount >= 2;
    // When the hint IS forwarded, skip nativeStrings non-externref string-ref
    // hint params (the runtime that calls `__call_@@toPrimitive` is JS-host-only
    // and cannot synthesize the WasmGC string-ref hint inline — see doc comment).
    const hintParamType = takesHint && funcType && funcType.kind === "func" ? funcType.params[1] : undefined;
    if (hintParamType !== undefined && hintParamType.kind !== "externref") continue;

    entries.push({ typeIdx, funcIdx, resultType, takesHint });
  }

  if (entries.length === 0) return;

  const dispatchTypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$call_method_2arg_type",
  );

  const funcIdx = ctx.numImportFuncs + mod.functions.length;
  const body: Instr[] = [];
  // local 2 = any.convert_extern(self)
  body.push({ op: "local.get", index: 0 });
  body.push({ op: "any.convert_extern" });
  body.push({ op: "local.set", index: 2 });

  let current: Instr[] = [{ op: "ref.null.extern" }];

  for (const entry of entries) {
    const testAndCall: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: entry.typeIdx },
    ];
    // (#2883) Forward the ToPrimitive hint ONLY to a method that declared it.
    // A hint-less `[Symbol.toPrimitive]()` body takes a single (self/capture)
    // param; pushing the hint there is an arity mismatch that corrupts the
    // dispatcher (see entry-collection comment above).
    if (entry.takesHint) {
      testAndCall.push({ op: "local.get", index: 1 }); // hint (externref)
    }
    testAndCall.push({ op: "call", funcIdx: entry.funcIdx });

    if (entry.resultType.kind === "ref" || entry.resultType.kind === "ref_null") {
      testAndCall.push({ op: "extern.convert_any" });
    } else if (entry.resultType.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) testAndCall.push({ op: "call", funcIdx: boxIdx });
    } else if (entry.resultType.kind === "i32") {
      testAndCall.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) testAndCall.push({ op: "call", funcIdx: boxIdx });
    }

    current = [
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: entry.typeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: testAndCall,
        else: current,
      },
    ];
  }

  body.push(...current);

  mod.functions.push({
    name: exportName,
    typeIdx: dispatchTypeIdx,
    locals: [{ name: "__any", type: { kind: "anyref" } }],
    body,
    exported: true,
  } as WasmFunction);

  exportFunc(mod, exportName, funcIdx);
}

/**
 * (#2083) True when at least one class `[Symbol.toPrimitive]` method in the
 * module returns a numeric (`f64`/`i32`) type — i.e. the `__call_@@toPrimitive`
 * dispatcher will need `__box_number` to box that result to externref. Mirrors
 * the entry-filtering in `emitToPrimitiveMethodExport` (skips Wrapper/$AnyValue/
 * vec/arr structs) and reads the compiled method's result signature. Computed
 * BEFORE any `addUnionImports`-induced funcIdx shift, off the same `funcMap` /
 * `mod.functions` state, so it is shift-stable. Used to gate the pre-emit
 * `addUnionImports` so non-numeric-toPrimitive modules add no import.
 */
function toPrimitiveNeedsBoxing(ctx: CodegenContext, methodSuffix: string): boolean {
  const mod = ctx.mod;
  for (const [structName] of ctx.structFields) {
    if (isSyntheticStructName(structName)) continue;
    const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, `${structName}_${methodSuffix}`));
    if (funcIdx === undefined) continue;
    const funcDef = definedFuncAt(ctx, funcIdx);
    const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
    const resultType =
      funcType && funcType.kind === "func" && funcType.results.length > 0 ? funcType.results[0] : undefined;
    if (resultType && (resultType.kind === "f64" || resultType.kind === "i32")) return true;
  }
  return false;
}

/**
 * Emit __call_toString and __call_valueOf exports for ToPrimitive dispatch (#866).
 * These allow the JS runtime to call toString/valueOf on WasmGC structs
 * that are opaque to JavaScript (struct fields are funcrefs, not JS functions).
 *
 * Handles both:
 * - Standalone methods: StructName_toString compiled as a function
 * - Closure fields: toString field is a closure ref, call via struct.get + call_ref
 */
function emitToPrimitiveMethodExports(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const dispatchTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$call_toPrim_type");

  const emitDispatchForMethod = (methodName: string, exportName: string) => {
    type DispatchEntry =
      | {
          structName: string;
          typeIdx: number;
          mode: "standalone";
          funcIdx: number;
          resultType: ValType;
        }
      | {
          structName: string;
          typeIdx: number;
          mode: "closure";
          fieldIdx: number;
          closureTypeIdx: number;
          closureInfo: ClosureInfo;
        }
      | {
          // (#1989) externref field holding a closure (the `any`-typed
          // object-literal method case — the field stores
          // `extern.convert_any(closureStruct)`). Recover the closure per
          // instance: `struct.get` (externref) → `any.convert_extern` →
          // `ref.cast closureTypeIdx` → field-0 funcref → `call_ref`. This makes
          // `__call_valueOf`/`__call_toString` per-object even when same-shape
          // literals share a struct type but store distinct method funcrefs.
          structName: string;
          typeIdx: number;
          mode: "closure-extern";
          fieldIdx: number;
          closureTypeIdx: number;
          closureInfo: ClosureInfo;
        }
      | {
          // (#2891) eqref closure field, GUARDED multi-candidate dispatch. A
          // single-literal object struct stores its `valueOf`/`toString` method
          // as a per-instance closure in an `eqref` field, but
          // `ctx.valueOfClosureTypes` accumulates the closure types of BOTH
          // fields, so a fixed "first tracked type" pick (the legacy eqref arm)
          // can `ref.cast` the WRONG field's closure type and TRAP. We instead
          // `ref.test` each candidate closure type on the actual stored field
          // value and `call_ref` the one that matches (null if none) — trap-free.
          // This is what lets standalone reduce a single-literal object operand
          // (the pre-#2891 code gated single literals out for exactly this trap
          // risk). Standalone-only widening; the host `_hostToPrimitive` path is
          // unchanged (it stays on the name-keyed arm).
          structName: string;
          typeIdx: number;
          mode: "closure-eqref-multi";
          fieldIdx: number;
          candidates: { closureTypeIdx: number; closureInfo: ClosureInfo }[];
        };

    const entries: DispatchEntry[] = [];

    for (const [structName, fields] of ctx.structFields) {
      const typeIdx = ctx.structMap.get(structName);
      if (typeIdx === undefined) continue;
      if (isSyntheticStructName(structName)) continue;

      const methodFullName = `${structName}_${methodName}`;
      const fieldIdx = fields.findIndex((f) => f.name === methodName);
      const field = fieldIdx >= 0 ? fields[fieldIdx]! : undefined;

      // (#1989) 1. Per-instance closure FIELD takes precedence over the
      // name-keyed standalone method — but ONLY for structs with the genuine
      // same-shape collision (`toPrimitiveForkedStructs`): two+ object literals
      // share the deduped struct type, each storing its OWN method closure in
      // the field, so reading the field + `call_ref` resolves to the right body
      // per object. The standalone `${structName}_${methodName}` func is only the
      // first literal's body and would collapse all instances onto it.
      //
      // Single-literal structs intentionally STAY on the name-keyed standalone
      // arm below: it is the one literal's correct body, is simpler, and
      // (critically) preserves the §7.1.1.1 step-6 object-return TypeError walk
      // in `_hostToPrimitive`. Same-shape valueOf/toString closures are
      // `ref.test`-indistinguishable, so routing a single-literal struct through
      // the per-instance arm could mis-select the closure type for `toString`.
      const forked = ctx.toPrimitiveForkedStructs.has(structName);
      // (#2891) In STANDALONE, also route single-literal closure-method structs
      // through the per-instance closure arm — there is no host `_hostToPrimitive`
      // to fall back on, so the name-keyed arm (which collapses same-shape
      // literals AND cannot model the §7.1.1.1 object-return fall-through) is not
      // enough. The eqref path below is GUARDED (`closure-eqref-multi`), so the
      // trap that previously justified gating single literals out is avoided.
      const preferClosure = forked || ctx.standalone;
      let pushedClosure = false;
      if (field && preferClosure) {
        // Closure ref field (eagerly-typed closure ref).
        if (field.type.kind === "ref" || field.type.kind === "ref_null") {
          const closureTypeIdx = (field.type as { typeIdx: number }).typeIdx;
          const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
          if (closureInfo && closureInfo.paramTypes.length === 0) {
            entries.push({ structName, typeIdx, mode: "closure", fieldIdx, closureTypeIdx, closureInfo });
            pushedClosure = true;
          }
        }
        // eqref field — GUARDED multi-candidate dispatch over the tracked closure
        // types (typed object-literal methods). `ref.test` selects the closure
        // type actually stored in THIS field, so accumulating both valueOf and
        // toString closure types in `valueOfClosureTypes` can no longer mis-cast.
        if (!pushedClosure && field.type.kind === "eqref") {
          const trackedTypes = ctx.valueOfClosureTypes.get(structName) ?? [];
          const candidates: { closureTypeIdx: number; closureInfo: ClosureInfo }[] = [];
          for (const closureTypeIdx of trackedTypes) {
            const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
            if (closureInfo && closureInfo.paramTypes.length === 0) {
              candidates.push({ closureTypeIdx, closureInfo });
            }
          }
          if (candidates.length > 0) {
            entries.push({ structName, typeIdx, mode: "closure-eqref-multi", fieldIdx, candidates });
            pushedClosure = true;
          }
        }
        // (#1989) externref field holding a closure — the `any`-typed
        // object-literal method case. The field stores
        // `extern.convert_any(closureStruct)`; recover it per instance.
        if (!pushedClosure && field.type.kind === "externref") {
          const trackedTypes = ctx.valueOfClosureTypes.get(structName) ?? [];
          for (const closureTypeIdx of trackedTypes) {
            const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
            if (closureInfo && closureInfo.paramTypes.length === 0) {
              entries.push({ structName, typeIdx, mode: "closure-extern", fieldIdx, closureTypeIdx, closureInfo });
              pushedClosure = true;
              break;
            }
          }
        }
      }
      if (pushedClosure) continue;

      // 2. Fallback: name-keyed standalone method `StructName_toString`. Used by
      // nominal class methods and structs whose method has no stored closure.
      const funcIdx = ctx.funcMap.get(methodFullName);
      if (funcIdx !== undefined) {
        const funcDef = definedFuncAt(ctx, funcIdx);
        const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
        const resultType: ValType =
          funcType && funcType.kind === "func" && funcType.results.length > 0
            ? funcType.results[0]!
            : { kind: "externref" };
        entries.push({ structName, typeIdx, mode: "standalone", funcIdx, resultType });
      }
    }

    if (entries.length === 0) return;

    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const anyLocal = 1;

    const boxResult = (resultType: ValType, instrs: Instr[]) => {
      if (resultType.kind === "f64") {
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx });
        else {
          instrs.push({ op: "drop" });
          instrs.push({ op: "ref.null.extern" });
        }
      } else if (resultType.kind === "i32") {
        instrs.push({ op: "f64.convert_i32_s" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx });
        else {
          instrs.push({ op: "drop" });
          instrs.push({ op: "ref.null.extern" });
        }
      } else if (resultType.kind === "i64") {
        // i64 (BigInt) — convert to f64 then box, or drop and return null
        instrs.push({ op: "f64.convert_i64_s" });
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx });
        else {
          instrs.push({ op: "drop" });
          instrs.push({ op: "ref.null.extern" });
        }
      } else if (resultType.kind === "ref" || resultType.kind === "ref_null") {
        instrs.push({ op: "extern.convert_any" });
      }
    };

    const buildDispatch = (idx: number): Instr[] => {
      if (idx >= entries.length) return [{ op: "ref.null.extern" }];
      const entry = entries[idx]!;

      const thenInstrs: Instr[] = [];
      if (entry.mode === "standalone") {
        thenInstrs.push(
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: entry.typeIdx },
          {
            op: "call",
            funcIdx: entry.funcIdx,
          },
        );
        boxResult(entry.resultType, thenInstrs);
      } else if (entry.mode === "closure-extern") {
        // (#1989) externref field holding `extern.convert_any(closureStruct)`.
        // Recover the per-instance closure: struct.get (externref) →
        // any.convert_extern → ref.cast closureType → field-0 funcref → call_ref.
        const ci = entry.closureInfo;
        const closureLocal = 2; // eqref scratch local
        thenInstrs.push(
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: entry.typeIdx },
          { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx },
          // externref field → anyref → concrete closure ref → eqref scratch.
          // (#2878) `any.convert_extern` yields `anyref`, which is the SUPERtype
          // of the `eqref` scratch local — a bare `local.set` of anyref into an
          // eqref local fails validation ("local.set expected eqref, found
          // anyref of type anyref"), the standalone `__call_toString` /
          // `__call_valueOf` invalid-Wasm bucket (#2860/#2868 residual). Narrow
          // to the concrete closure struct type first (a valid eqref subtype);
          // the field holds `extern.convert_any(closureStruct)`, so this recovers
          // exactly that struct. The `ref.cast entry.closureTypeIdx` uses of
          // `closureLocal` below become redundant re-casts of the same concrete
          // type (harmless), and this adds no new trap — that cast already ran
          // unconditionally on the value.
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          { op: "local.set", index: closureLocal },
          // self-param: the closure struct
          { op: "local.get", index: closureLocal },
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          // funcref from closure field 0
          { op: "local.get", index: closureLocal },
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          { op: "struct.get", typeIdx: entry.closureTypeIdx, fieldIdx: 0 },
          { op: "ref.cast", typeIdx: ci.funcTypeIdx },
          { op: "call_ref", typeIdx: ci.funcTypeIdx },
        );
        if (!ci.returnType) {
          thenInstrs.push({ op: "ref.null.extern" });
        } else {
          boxResult(ci.returnType, thenInstrs);
        }
      } else if (entry.mode === "closure-eqref-multi") {
        // (#2891) GUARDED dispatch over candidate closure types for an eqref
        // method field. Read the field once into the eqref scratch, then
        // `ref.test` each candidate and `call_ref` the matching one (null if
        // none) — never an unguarded `ref.cast`, so the wrong-field-type trap is
        // impossible.
        const closureLocal = 2; // eqref scratch local (the stored method closure)
        const fieldEntry = entry;
        const buildCandidate = (ci: number): Instr[] => {
          if (ci >= fieldEntry.candidates.length) return [{ op: "ref.null.extern" }];
          const { closureTypeIdx, closureInfo } = fieldEntry.candidates[ci]!;
          // Body run when BOTH the struct cast and the funcref type match.
          const callInstrs: Instr[] = [
            // self-param: the closure struct (cast is safe — struct ref.test passed)
            { op: "local.get", index: closureLocal },
            { op: "ref.cast", typeIdx: closureTypeIdx },
            // funcref already validated + stashed in eqrefFuncLocal
            { op: "local.get", index: eqrefFuncLocal },
            { op: "ref.cast", typeIdx: closureInfo.funcTypeIdx },
            { op: "call_ref", typeIdx: closureInfo.funcTypeIdx },
          ];
          if (!closureInfo.returnType) {
            callInstrs.push({ op: "ref.null.extern" });
          } else {
            boxResult(closureInfo.returnType, callInstrs);
          }
          // Guard 1: the stored closure must be (a subtype of) this candidate's
          // struct type. Guard 2: its funcref (field 0) must be this candidate's
          // func type — distinct methods can share a struct type but differ in
          // func type, so the funcref test is the real discriminator (an
          // unguarded `ref.cast funcTypeIdx` would TRAP otherwise).
          return [
            { op: "local.get", index: closureLocal },
            { op: "ref.test", typeIdx: closureTypeIdx },
            {
              op: "if",
              blockType: { kind: "val" as const, type: { kind: "externref" as const } },
              then: [
                { op: "local.get", index: closureLocal },
                { op: "ref.cast", typeIdx: closureTypeIdx },
                { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
                { op: "local.tee", index: eqrefFuncLocal },
                { op: "ref.test", typeIdx: closureInfo.funcTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val" as const, type: { kind: "externref" as const } },
                  then: callInstrs,
                  else: buildCandidate(ci + 1),
                },
              ],
              else: buildCandidate(ci + 1),
            },
          ];
        };
        thenInstrs.push(
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: entry.typeIdx },
          { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx },
          { op: "local.set", index: closureLocal },
          ...buildCandidate(0),
        );
      } else {
        // Closure field: extract closure, get funcref, call_ref
        const ci = entry.closureInfo;
        thenInstrs.push(
          { op: "local.get", index: anyLocal },
          { op: "ref.cast", typeIdx: entry.typeIdx },
          {
            op: "struct.get",
            typeIdx: entry.typeIdx,
            fieldIdx: entry.fieldIdx,
          },
        );
        // The struct.get returns the field type (eqref or ref). Store in eqref local.
        const closureLocal = 2; // eqref local
        thenInstrs.push(
          { op: "local.set", index: closureLocal },
          // Cast eqref to closure struct type for the self-param
          { op: "local.get", index: closureLocal },
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          // Get funcref from closure field 0
          { op: "local.get", index: closureLocal },
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          { op: "struct.get", typeIdx: entry.closureTypeIdx, fieldIdx: 0 },
          { op: "ref.cast", typeIdx: ci.funcTypeIdx },
          { op: "call_ref", typeIdx: ci.funcTypeIdx },
        );
        const retType = ci.returnType ?? { kind: "externref" as const };
        if (!ci.returnType) {
          // void — push null externref
          thenInstrs.push({ op: "ref.null.extern" });
        } else {
          boxResult(retType, thenInstrs);
        }
      }

      return [
        { op: "local.get", index: anyLocal },
        { op: "ref.test", typeIdx: entry.typeIdx },
        {
          op: "if",
          blockType: { kind: "val" as const, type: { kind: "externref" as const } },
          then: thenInstrs,
          else: buildDispatch(idx + 1),
        },
      ];
    };

    // Determine locals: param 0 (externref), local 1 (anyref), local 2 (eqref for closure)
    // (#2679) locals 3/4 (__prev_this / __tp_result) thread `__current_this`.
    const hasClosureEntry = entries.some(
      (e) => e.mode === "closure" || e.mode === "closure-extern" || e.mode === "closure-eqref-multi",
    );
    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    if (hasClosureEntry) {
      locals.push({ name: "__closure", type: { kind: "eqref" } });
    } else {
      // Reserve slot 2 so the prevThis/result locals land at fixed indices 3/4
      // regardless of the closure-entry branch.
      locals.push({ name: "__closure_unused", type: { kind: "eqref" } });
    }
    // (#2679) `__call_valueOf`/`__call_toString` must invoke the method with the
    // RECEIVER as `this` (§7.1.1.1 OrdinaryToPrimitive step 4.b `Call(method, O)`).
    // A compiled `valueOf(){…this…}` reads `this` from `__current_this`; the
    // dispatch below `call_ref`s the closure body WITHOUT installing it, so the
    // body saw a stale `this`. Install `__current_this` = param 0 (the receiver)
    // around the dispatch and restore it afterward (nesting-safe).
    const prevThisLocal2 = 3;
    const tpResultLocal = 4;
    locals.push({ name: "__prev_this", type: { kind: "externref" } });
    locals.push({ name: "__tp_result", type: { kind: "externref" } });
    // (#2891) funcref scratch (index 5) for the guarded `closure-eqref-multi`
    // dispatch — distinct method closures can share one closure STRUCT type but
    // carry different FUNC types, so the candidate is discriminated by a guarded
    // `ref.test` on the funcref (field 0), not by the struct type alone.
    locals.push({ name: "__tp_funcref", type: { kind: "funcref" } });
    const eqrefFuncLocal = 5;
    const currentThisGlobalIdx2 = ensureCurrentThisGlobal(ctx);

    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: anyLocal },
      // save __current_this, install the receiver
      { op: "global.get", index: currentThisGlobalIdx2 },
      { op: "local.set", index: prevThisLocal2 },
      { op: "local.get", index: 0 },
      { op: "global.set", index: currentThisGlobalIdx2 },
      // dispatch (leaves result externref on stack) → capture
      ...buildDispatch(0),
      { op: "local.set", index: tpResultLocal },
      // restore __current_this, return the captured result
      { op: "local.get", index: prevThisLocal2 },
      { op: "global.set", index: currentThisGlobalIdx2 },
      { op: "local.get", index: tpResultLocal },
    ];

    mod.functions.push({
      name: exportName,
      typeIdx: dispatchTypeIdx,
      locals,
      body,
      exported: true,
    } as WasmFunction);

    mod.exports.push({
      name: exportName,
      desc: { kind: "func", index: funcIdx },
    });

    // (#2638) Record the dispatcher funcIdx so `fillClassToPrimitive` can `call`
    // it from the reserved `__class_to_primitive` driver. The host-side
    // `_hostToPrimitive` loop reaches these via the export, not funcMap, so this
    // is purely additive (the iterator dispatchers already use this convention).
    ctx.funcMap.set(exportName, funcIdx);
  };

  emitDispatchForMethod("toString", "__call_toString");
  emitDispatchForMethod("valueOf", "__call_valueOf");
}

/**
 * (#2931) Register live-binding module globals for function declarations whose
 * name is *reassigned* somewhere in the realm (`fn = …`, `fn += …`, …).
 *
 * ES function bindings are live and mutable: a function declaration name can be
 * reassigned, and later reads must observe the new value. But a function
 * declaration is otherwise bound to an immutable Wasm func index, and the
 * assignment write-path (`emitIdentifierWriteFromLocal`) — finding the name in
 * neither `localMap`/`capturedGlobals`/`moduleGlobals` — falls through to
 * "auto-allocate a throwaway local", losing the write entirely.
 *
 * This pass (run after `collectDeclarations`, before bodies compile) statically
 * detects reassigned function-declaration names, backs each with a MUTABLE
 * `externref` module global (which the write-path then targets via `global.set`),
 * and records the name in `ctx.liveFuncBindingGlobals` so the identifier read-path
 * reads through the global (`global.get`). `__module_init` seeds each global with
 * the function's closure so a read *before* any reassignment still yields the
 * function (see `compileModuleInitBody`). Reassigning a function declaration is a
 * rare pattern, so `liveFuncBindingGlobals` is empty for virtually every program
 * and this is a no-op there.
 */
function registerReassignedFunctionGlobals(ctx: CodegenContext, sourceFiles: readonly ts.SourceFile[]): void {
  const reassigned = new Set<string>();
  const scan = (node: ts.Node): void => {
    // Simple / compound assignment (`fn = …`, `fn += …`, …) whose LHS is a
    // bare identifier resolving to a function declaration.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isIdentifier(node.left)
    ) {
      let sym: ts.Symbol | undefined;
      try {
        sym = ctx.checker.getSymbolAtLocation(node.left);
      } catch {
        sym = undefined;
      }
      const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
      if (decl && ts.isFunctionDeclaration(decl) && decl.name) {
        reassigned.add(decl.name.text);
      }
    }
    ts.forEachChild(node, scan);
  };
  for (const sf of sourceFiles) scan(sf);
  if (reassigned.size === 0) return;

  const set = (ctx.liveFuncBindingGlobals ??= new Set<string>());
  for (const name of reassigned) {
    const funcIdx = ctx.funcMap.get(name);
    // Only defined user functions (not host imports) have an in-module body.
    if (funcIdx === undefined || funcIdx < ctx.numImportFuncs) continue;
    if (ctx.moduleGlobals.has(name)) continue; // already a global — nothing to do
    const globalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: `__mod_${name}`,
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    ctx.moduleGlobals.set(name, globalIdx);
    set.add(name);
  }
}

/**
 * (#2930) Register import-binding local-name aliases.
 *
 * Codegen keys `funcMap` / `closureMap` / `moduleGlobals` (and the per-name call
 * metadata) by the imported symbol's *declaration name*, never by the local
 * import binding. So an import whose LOCAL name differs from the target's
 * declaration name — a default import (`import val from './m'` where `./m`
 * declares `function fn`), a renamed named import (`import { add as plus }`), an
 * anonymous `export default function () {}`, or `export { g as default }` — left
 * the local binding (`val` / `plus`) unresolved: every read/call of it fell
 * through to the graceful-null default (returned 0 / null / a wrong closure).
 *
 * This pass runs AFTER `collectDeclarations` (targets are registered) and BEFORE
 * function bodies compile (which reference the local names). For each import
 * binding it follows the checker alias to the target declaration's name and
 * copies the resolution entries onto the local name. Purely additive: it writes
 * ONLY local-name keys that are currently absent, so every already-resolving
 * name stays byte-identical.
 */
function registerImportBindingAliases(ctx: CodegenContext, sourceFiles: readonly ts.SourceFile[]): void {
  const aliasOneBinding = (localId: ts.Identifier): void => {
    const localName = localId.text;
    // Already resolvable under the local name (e.g. `import { add }` where the
    // local name equals the export) — nothing to alias.
    if (ctx.funcMap.has(localName) || ctx.moduleGlobals.has(localName) || ctx.closureMap.has(localName)) {
      return;
    }
    let sym: ts.Symbol | undefined;
    try {
      sym = ctx.checker.getSymbolAtLocation(localId);
    } catch {
      return;
    }
    if (!sym) return;
    let target: ts.Symbol | undefined = sym;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        target = ctx.checker.getAliasedSymbol(sym);
      } catch {
        return;
      }
    }
    if (!target) return;
    const decl = target.valueDeclaration ?? target.declarations?.[0];
    if (!decl) return;
    // The name the target was registered under in funcMap/moduleGlobals/closureMap.
    let targetName: string | undefined;
    const declName = (decl as { name?: ts.Node }).name;
    if (declName && ts.isIdentifier(declName)) {
      targetName = declName.text;
    } else if (
      (ts.isFunctionDeclaration(decl) || ts.isClassDeclaration(decl)) &&
      ts.canHaveModifiers(decl) &&
      ts.getModifiers(decl)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      // Anonymous `export default function () {}` / `export default class {}`
      // is registered under the synthetic name "default".
      targetName = "default";
    }
    if (!targetName || targetName === localName) return;
    // Copy each resolution entry keyed by the target name onto the local name.
    // Every write is guarded so a genuine same-named binding is never clobbered.
    const fnIdx = ctx.funcMap.get(targetName);
    if (fnIdx !== undefined && !ctx.funcMap.has(localName)) ctx.funcMap.set(localName, fnIdx);
    const closure = ctx.closureMap.get(targetName);
    if (closure !== undefined && !ctx.closureMap.has(localName)) ctx.closureMap.set(localName, closure);
    const modGlobal = ctx.moduleGlobals.get(targetName);
    if (modGlobal !== undefined && !ctx.moduleGlobals.has(localName)) ctx.moduleGlobals.set(localName, modGlobal);
    const optParams = ctx.funcOptionalParams.get(targetName);
    if (optParams !== undefined && !ctx.funcOptionalParams.has(localName)) {
      ctx.funcOptionalParams.set(localName, optParams);
    }
    const nested = ctx.nestedFuncCaptures.get(targetName);
    if (nested !== undefined && !ctx.nestedFuncCaptures.has(localName)) ctx.nestedFuncCaptures.set(localName, nested);
    // (#2931) If the target is a reassigned function backed by a live-binding
    // global, propagate membership so the aliased local name reads through the
    // (copied) module global too.
    if (ctx.liveFuncBindingGlobals?.has(targetName)) ctx.liveFuncBindingGlobals.add(localName);
  };

  for (const sf of sourceFiles) {
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue;
      const clause = stmt.importClause;
      if (!clause) continue;
      // Default import: `import val from './m'`.
      if (clause.name) aliasOneBinding(clause.name);
      // Named imports: `import { a, b as c } from './m'`.
      const nb = clause.namedBindings;
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) aliasOneBinding(el.name);
      }
      // Namespace import (`import * as ns`) resolves to a module object, not a
      // single function/global binding — nothing to alias here.
    }
  }
}

/**
 * Compile multiple typed source files into a single WasmModule IR.
 * All source files share the same codegen context (funcMap, structMap, etc.).
 * Only functions exported from the entry file become Wasm exports.
 */
export function generateMultiModule(
  multiAst: MultiTypedAST,
  options?: CodegenOptions,
): {
  module: WasmModule;
  errors: CodegenError[];
  // #2089 — silent-fallback telemetry counters (per class → per site → count).
  fallbackCounts?: FallbackCounts;
  // #1923 — IR post-claim demotions (only when trackIrPostClaim is set).
  irPostClaimErrors?: { kind: string; func: string; message: string }[];
  // #3000 — functions/class-members actually IR-emitted (genuine-emission signal).
  irCompiledFuncs?: readonly string[];
} {
  const mod = createEmptyModule();
  const ctx = createCodegenContext(mod, multiAst.checker, options);
  try {
    // WASI target: register linear memory, bump pointer global, and WASI imports
    if (ctx.wasi) {
      registerWasiImports(ctx, multiAst.entryFile);
    }

    // $AnyValue struct type is now registered lazily via ensureAnyValueType()

    // Phase 1: Collect extern declarations first (needed before import collectors)
    for (const sf of multiAst.sourceFiles) {
      collectExternDeclarations(ctx, sf);
    }

    // WASI target: check for DOM-only globals and emit compile errors
    if (ctx.wasi) {
      for (const sf of multiAst.sourceFiles) {
        checkWasiDomUsage(ctx, sf);
        rejectTimersUnderWasi(ctx, sf);
      }
    }

    // Scan lib files for DOM extern classes + globals (only if any user code uses DOM)
    // After lib.d.ts refactoring, TS loads individual lib files (lib.es5.d.ts, etc.)
    const anyUsesDom = multiAst.sourceFiles.some((sf) => sourceUsesLibGlobals(sf));
    if (anyUsesDom) {
      // #2520 — gate the lib-file referenced-names filter to wasi/standalone
      // only; under the default gc target it reorders the import/type table and
      // exposed a latent late-import index-shift (#1787 −6). See the matching
      // comment in generateModule above.
      const libRefs =
        ctx.wasi || ctx.standalone ? collectReferencedGlobalNames(multiAst.sourceFiles, ctx.checker) : undefined;
      for (const libSf of multiAst.program.getSourceFiles()) {
        const baseName = libSf.fileName.split("/").pop() ?? libSf.fileName;
        if (baseName.startsWith("lib.") && baseName.endsWith(".d.ts")) {
          collectExternDeclarations(ctx, libSf, libRefs);
          for (const sf of multiAst.sourceFiles) {
            if (sourceUsesLibGlobals(sf)) {
              collectDeclaredGlobals(ctx, libSf, sf);
            }
          }
        }
      }
    }

    // Register built-in collection types as extern classes if not already collected from lib files
    registerBuiltinExternClasses(ctx);

    // Pre-pass: detect empty object literals that get properties assigned later
    // Must run before import collectors so that widened types are known
    for (const sf of multiAst.sourceFiles) {
      collectEmptyObjectWidening(ctx, multiAst.checker, sf);
      // (#2837) see single-file path above.
      collectGrowableObjectLiterals(ctx, multiAst.checker, sf);
    }

    // Single-pass collection of all source imports for each file (#592)
    for (const sf of multiAst.sourceFiles) {
      collectUsedExternImports(ctx, sf);
      collectAllSourceImports(ctx, sf);
    }

    // #1677 — reconcile native-string helper indices before emitting deferred
    // helpers that look them up (see single-module path).
    reconcileNativeStrFinalizeShift(ctx);

    // Emit inline Wasm implementations for Math methods (after all imports are registered)
    if (ctx.pendingMathMethods.size > 0) {
      emitInlineMathFunctions(ctx, ctx.pendingMathMethods);
    }

    // Emit __toUint32 Wasm helper after all imports registered.
    emitToUint32Helper(ctx);

    // (#1483) Emit deferred WASI helper functions for the same reason.
    emitDeferredWasiHelpers(ctx);

    // Emit wrapper valueOf functions (after all imports registered, before user funcs)
    emitWrapperValueOfFunctions(ctx);

    // #1121: Numeric return-type inference (must run BEFORE collectDeclarations
    // so the inferred f64 return is baked into the function signature).
    {
      const merged = new Map<string, ValType>();
      for (const sf of multiAst.sourceFiles) {
        const partial = inferNumericReturnTypes(ctx, sf);
        for (const [k, v] of partial) merged.set(k, v);
      }
      ctx.numericReturnTypes = merged;
    }

    // #1677 — final reconcile before any user function is registered.
    reconcileNativeStrFinalizeShift(ctx);

    // #1719 S1 — whole-realm: OR across all source files so an override in any
    // module trips the ITER_OVERRIDDEN brand. Must run BEFORE collectDeclarations
    // (the module-init filter / #1719 CPR write-arm reads the brand to keep the
    // override statement in __module_init).
    for (const sf of multiAst.sourceFiles) {
      if (sourceOverridesArrayIterator(sf)) {
        ctx.arrayIteratorMaybeOverridden = true;
      }
    }

    // Phase 2: Collect all declarations — only entry file gets Wasm exports
    // (#2023) Whole-realm new.target detection — OR across all source files.
    for (const sf of multiAst.sourceFiles) {
      scanForNewTarget(ctx, sf);
    }

    // (#2001 S1) Whole-realm array-hole detection — OR across all source files.
    for (const sf of multiAst.sourceFiles) {
      scanForArrayHoles(ctx, sf);
    }

    for (const sf of multiAst.sourceFiles) {
      const isEntry = sf === multiAst.entryFile;
      collectDeclarations(ctx, sf, isEntry);
    }

    // Shape inference: detect array-like variables and override their types
    for (const sf of multiAst.sourceFiles) {
      applyShapeInference(ctx, multiAst.checker, sf);
    }

    // (#1636-S1) Eagerly register the `__current_this` module global so that
    // `ThisKeyword` resolution in free-function-closure bodies (compiled in
    // the next phase) can emit `global.get __current_this` instead of
    // falling through to `undefined`. The companion `__call_fn_method_N`
    // exports that install / restore this global are emitted later in
    // post-processing — registering the global here keeps both sides in sync.
    ensureCurrentThisGlobal(ctx);

    // (#2931) Back reassigned function-declaration names (`fn = …`) with a mutable
    // live-binding module global BEFORE aliasing, so an import of such a function
    // (#2930) copies the live global too. No-op unless a function is reassigned.
    registerReassignedFunctionGlobals(ctx, multiAst.sourceFiles);

    // (#2930) Register import-binding aliases (default / renamed / anonymous-default
    // imports whose LOCAL name differs from the imported target's declaration name)
    // so their reads and calls resolve to the target instead of the graceful-null
    // default. Runs after collectDeclarations (targets registered), before bodies.
    registerImportBindingAliases(ctx, multiAst.sourceFiles);

    // Phase 3: Compile all function bodies
    for (const sf of multiAst.sourceFiles) {
      compileDeclarations(ctx, sf);
    }

    // (#1602) Rebuild method-closure trampolines against final method sigs.
    finalizeMethodTrampolines(ctx);

    // Fixup pass: reconcile struct.new argument counts with actual struct field counts.
    fixupStructNewArgCounts(ctx);

    // Fixup pass: insert extern.convert_any after struct.new when the result
    // is stored into an externref local/global.
    fixupStructNewResultCoercion(ctx);

    // Build per-shape default property flags table for all user-visible structs
    buildShapePropFlagsTable(ctx);

    // Collect ref.func targets so the binary emitter can add a declarative element segment
    collectDeclaredFuncRefs(ctx);

    // Resolve deferred `export default <variable>` for module globals (#1108).
    // Must run AFTER compileDeclarations — string-constant imports added during
    // body compilation shift numImportGlobals, so indices aren't final until now.
    if (ctx.deferredDefaultGlobalExport) {
      const varName = ctx.deferredDefaultGlobalExport;
      const globalName = `__mod_${varName}`;
      const localIdx = ctx.mod.globals.findIndex((g) => g.name === globalName);
      if (localIdx >= 0) {
        const absIdx = ctx.numImportGlobals + localIdx;
        const alreadyExported = ctx.mod.exports.some(
          (e) => e.name === "default" || (e.name === varName && e.desc.kind === "global"),
        );
        if (!alreadyExported) {
          ctx.mod.exports.push({ name: "default", desc: { kind: "global", index: absIdx } });
          ctx.mod.exports.push({ name: varName, desc: { kind: "global", index: absIdx } });
        }
      }
      ctx.deferredDefaultGlobalExport = undefined;
    }

    // Copy metadata for .d.ts / helper generation
    const importNames = mod.imports.map((imp) => imp.name);
    for (const [key, info] of ctx.externClasses) {
      const prefix = `${info.importPrefix}_`;
      const isUsed = importNames.some((n) => n.startsWith(prefix));
      if (key === info.className && isUsed) {
        mod.externClasses.push({
          importPrefix: info.importPrefix,
          namespacePath: info.namespacePath,
          className: info.className,
          constructorParams: info.constructorParams,
          methods: info.methods,
          properties: info.properties,
        });
      }
    }
    mod.stringLiteralValues = ctx.stringLiteralValues;
    mod.asyncFunctions = ctx.asyncFunctions;
    // (#1700) Surface per-export TypedArray classifications so the JS-host
    // wrapExports can marshal Uint8Array params/results across the boundary.
    if (ctx.exportSignatures.size > 0) {
      const obj: Record<string, import("../ir/types.js").ExportSignature> = {};
      for (const [k, v] of ctx.exportSignatures) obj[k] = v;
      mod.exportSignatures = obj;
    }

    // (#2831) Reserve the host-externref → wasm-vec materializers before the
    // `__sset_*` setters bake their value coercions (mirrors the generateModule
    // path). No member-set-dispatch in this multi-source path, so only the
    // `__sset_*` (b) enumeration contributes; no-op without a vec write target.
    reserveVecFieldMaterializers(ctx);

    // Emit exported struct field getter helpers for the runtime (mirrors
    // generateModule path — #1308 surfaced that multi-source projects
    // were missing these export emits).
    emitStructFieldGetters(ctx);
    emitStructFieldSetters(ctx);

    // Emit __vec_get / __vec_len exports for runtime iterator fallback.
    emitVecAccessExports(ctx);

    // Emit __dv_byte_{len,get,set} exports for DataView host runtime.
    emitDataViewByteExports(ctx);

    // (#3058) Resizable-ArrayBuffer helper exports (mirrors generateModule path).
    emitResizableAbExports(ctx);

    // Emit __test_str_from_externref / __test_str_to_externref helpers
    // (no-op unless ctx.testRuntime && ctx.nativeStrings).
    emitTestRuntimeStringHelpers(ctx);

    // Emit __call_@@iterator export for runtime Symbol.iterator dispatch.
    emitIteratorMethodExport(ctx);

    // Emit __call_fn_0 export for calling zero-arg closures from JS (#851, #1308).
    emitClosureCallExport(ctx);

    // Emit __call_fn_1 export for calling one-arg closures from JS (#1090, #1308).
    emitClosureCallExport1(ctx);

    // #1504: emit __is_closure for wrapExports discrimination.
    emitIsClosureExport(ctx);

    // #2794: POSITIVE data-vs-closure discriminator (see generateModule path).
    emitIsDataStructExport(ctx);

    // #1896: teach standalone __typeof_function/__typeof_object to recognise
    // closure wrapper structs (edits helper bodies in place — no funcIdx churn).
    fillStandaloneTypeofClosureArms(ctx);

    // Emit __call_toString/__call_valueOf exports for ToPrimitive dispatch.
    emitToPrimitiveMethodExports(ctx);

    // (#1716) Emit __call_@@toPrimitive(self, hint) for runtime ToPrimitive
    // dispatch of a class's [Symbol.toPrimitive] *method* on opaque structs.
    emitToPrimitiveMethodExport(ctx);

    // (#2962) Emit __exn_render_prepare / __exn_render_char so the test262
    // harness can render a natively-thrown GC payload ("TypeError: boom")
    // with zero host imports. No-op unless (standalone || wasi) &&
    // nativeStrings && the `$exc` tag was registered (i.e. the module can
    // actually throw).
    emitExceptionRenderExports(ctx);

    // #1326c Phase 1C-A — export __drain_microtasks BEFORE WASI _start so the
    // _start wrapper (which appends a drain call) can find its funcIdx.
    // Idempotent + no-op when the queue was never registered.
    exportDrainMicrotasksIfRegistered(ctx);

    // WASI: export _start entry point (before dead import elimination adjusts indices)
    if (ctx.wasi) {
      addWasiStartExport(ctx);
    }

    // Export the exception tag so the exec worker can extract thrown payloads
    // via WebAssembly.Exception.getArg(tag, 0).
    if (ctx.exnTagIdx >= 0) {
      const numImportTags = mod.imports.filter((i) => i.desc.kind === "tag").length;
      mod.exports.push({
        name: "__exn_tag",
        desc: { kind: "tag", index: numImportTags + ctx.exnTagIdx },
      });
    }

    // Mark leaf struct types as final for V8 devirtualization (#594).
    // Skipped for `--target wasi` so that downstream `wasm-opt --all-features`
    // does not convert refs to those types into `(ref exact $T)`, which
    // wasmtime ≤ 44 rejects (#1173).
    // (#2580 M0) Emit the dynamic-read primitives (__dyn_has/__dyn_get) iff a
    // call site flagged the module needs them (M1+). Gated on ctx.usesDynRead,
    // which M0 never sets, so this is a no-op in M0 → byte-identical. Runs before
    // dead-elim/freeze so the helper funcIdx values are stable.
    ensureDynReadHelpers(ctx);
    // (#3053 U0) See the single-module pipeline note above. No-op unless
    // ctx.usesDynMemberGet is set (U1+); byte-identical in U0.
    ensureDynMemberGet(ctx);

    // (#2800) Allocate + wire the `__in_module_init` flag global now that every
    // import global has settled (final absolute index), patching the recorded
    // delete-aware read `global.get` placeholders and wrapping `__module_init`.
    // Runs before dead-elim (which never prunes/remaps live globals) and the
    // index freeze. No-op unless a gc/host delete-aware read recorded the flag.
    finalizeInModuleInitFlag(ctx);

    // (#2853) Nominal shape branding — same pass + placement as the
    // single-module pipeline (see generateModule): after all instruction
    // emission, before dead-type elimination.
    brandCollidingShapeTypes(mod, ctx.noBrandShapeTypes);

    markLeafStructsFinal(mod, ctx.wasi);

    // Dead import and type elimination pass
    eliminateDeadImports(mod, ctx); // #1899 ctx → remap helper side-tables on import removal

    // Repair struct.get/struct.set type mismatches (externref → struct ref conversion)
    repairStructTypeMismatches(mod);

    // Peephole optimization: remove redundant ref.as_non_null after ref.cast, etc.
    peepholeOptimize(mod);

    // #1984 — freeze the index spaces (multi-module path). Same boundary as the
    // single-module generateModule: all legitimate late import mutations have
    // run; stackBalance / fixupExternConvertAny / emit add no imports. Any
    // addImport/ensureLateImport after here throws at the producer site.
    ctx.indexSpaceFrozen = true;

    // Stack-balancing fixup: ensure all branches in if/try/block have matching stack states
    stackBalance(mod);
    // #1918 — drain fixup telemetry: per-compile debug log + optional strict mode.
    drainStackBalanceTelemetry(ctx, multiAst.entryFile.fileName);

    // Late fixup: repair extern.convert_any applied to non-anyref values.
    // Must run after stackBalance since fixCallArgTypesInBody can insert
    // duplicate/redundant extern.convert_any when walking back through
    // already-converted producers (#1400). Without this, ESLint's Config_new
    // and similar multi-arg __extern_set call sites emit 2–4 consecutive
    // extern.convert_any ops, the second of which fails validation
    // ("found extern.convert_any of type externref" — externref is NOT a
    // subtype of anyref). Mirror the single-module pipeline at line 1053.
    fixupExternConvertAny(ctx);
  } catch (e) {
    reportErrorNoNode(ctx, `Codegen error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // (#2094) Emit-time backstop for the addImport gate — see generateModule.
  assertNoLeakedHostImports(ctx, mod);

  return {
    module: mod,
    errors: ctx.errors,
    fallbackCounts: ctx.fallbackCounts,
    irPostClaimErrors: ctx.irPostClaimErrors,
    irCompiledFuncs: ctx.irCompiledFuncs,
  };
}

// ── Unified single-pass import collector (#592) ─────────────────────
//
// Instead of walking the AST 19+ times with separate collect* functions,
// collectAllSourceImports performs a SINGLE recursive traversal and
// dispatches to all collector logic on every node.  The individual
// collect* functions below are preserved but no longer called from
// generateModule / generateMultiModule — they remain as reference and
// for any call sites that need them independently.

// String method signatures: name → { params (excluding self), resultKind }
export const STRING_METHODS: Record<string, { params: ValType[]; result: ValType }> = {
  toUpperCase: { params: [], result: { kind: "externref" } },
  toLowerCase: { params: [], result: { kind: "externref" } },
  trim: { params: [], result: { kind: "externref" } },
  trimStart: { params: [], result: { kind: "externref" } },
  trimEnd: { params: [], result: { kind: "externref" } },
  charAt: { params: [{ kind: "f64" }], result: { kind: "externref" } },
  slice: {
    params: [{ kind: "f64" }, { kind: "f64" }],
    result: { kind: "externref" },
  },
  substring: {
    params: [{ kind: "f64" }, { kind: "f64" }],
    result: { kind: "externref" },
  },
  indexOf: { params: [{ kind: "externref" }, { kind: "externref" }], result: { kind: "f64" } },
  lastIndexOf: { params: [{ kind: "externref" }, { kind: "externref" }], result: { kind: "f64" } },
  // #2002 — second arg is the start position (includes/startsWith) or
  // endPosition (endsWith). Declared as f64 so the generic arg loop forwards
  // it to the host instead of truncating to import arity. An omitted position
  // is padded with NaN; the `string_method` host shim strips a trailing NaN
  // so the JS method applies its spec default (0 for includes/startsWith,
  // length for endsWith) rather than ToInteger(NaN)=0.
  includes: { params: [{ kind: "externref" }, { kind: "f64" }], result: { kind: "i32" } },
  startsWith: { params: [{ kind: "externref" }, { kind: "f64" }], result: { kind: "i32" } },
  endsWith: { params: [{ kind: "externref" }, { kind: "f64" }], result: { kind: "i32" } },
  replace: {
    params: [{ kind: "externref" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  replaceAll: {
    params: [{ kind: "externref" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  repeat: { params: [{ kind: "f64" }], result: { kind: "externref" } },
  padStart: {
    params: [{ kind: "f64" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  padEnd: {
    params: [{ kind: "f64" }, { kind: "externref" }],
    result: { kind: "externref" },
  },
  // split: separator (externref) + limit (f64, NaN sentinel for "no limit" — #1441).
  // The host runtime in `string_method` detects NaN and calls `split(sep)` without
  // the limit so the spec default 2^32-1 applies (instead of ToUint32(NaN) === 0).
  split: { params: [{ kind: "externref" }, { kind: "f64" }], result: { kind: "externref" } },
  match: { params: [{ kind: "externref" }], result: { kind: "externref" } },
  search: { params: [{ kind: "externref" }], result: { kind: "f64" } },
  at: { params: [{ kind: "f64" }], result: { kind: "externref" } },
  codePointAt: { params: [{ kind: "f64" }], result: { kind: "f64" } },
  normalize: { params: [{ kind: "externref" }], result: { kind: "externref" } },
};

// Register addStringImports so any-helpers.ts can call it via the delegate
// (breaks circular dep: index.ts → any-helpers.ts → shared.ts ← index.ts)
registerAddStringImports(addStringImports);
// #1471: lets late-imports.ts route box/unbox/typeof/is_truthy names to the
// in-module native funcs under no-JS-host mode without an import cycle.
registerAddUnionImports(addUnionImports);

/** Parse a RegExp literal text (e.g. "/\\d+/gi") into pattern and flags */
export function parseRegExpLiteral(text: string): { pattern: string; flags: string } {
  // The text includes the leading '/' and trailing '/flags'.
  // Find the last '/' which separates pattern from flags.
  const lastSlash = text.lastIndexOf("/");
  const pattern = text.slice(1, lastSlash);
  const flags = text.slice(lastSlash + 1);
  return { pattern, flags };
}

/** Math methods that need host imports (no native Wasm opcode) */
export const MATH_HOST_METHODS_1ARG = new Set([
  "exp",
  "log",
  "log2",
  "log10",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "sinh",
  "cosh",
  "tanh",
  "acosh",
  "asinh",
  "atanh",
  "cbrt",
  "expm1",
  "log1p",
]);
export const MATH_HOST_METHODS_2ARG = new Set(["pow", "atan2"]);

/**
 * Emit the __toUint32 Wasm helper function. Must be called AFTER all imports
 * that are added directly via addImport (bypassing ensureLateImport's shift
 * mechanism) have been registered, and BEFORE any user function body that
 * calls Math.clz32 or Math.imul is compiled. Emitting earlier leaves a stale
 * funcMap entry because addImport does not shift defined-function indices.
 *
 * Implements ES §7.1.7: NaN/±Infinity → 0, otherwise trunc(x) modulo 2^32.
 */
export function emitToUint32Helper(ctx: CodegenContext): void {
  if (!ctx.needsToUint32) return;
  if (ctx.funcMap.has("__toUint32")) return;
  const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "i32" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__toUint32", funcIdx);
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "local.get", index: 0 },
    { op: "f64.ne" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: 0 },
    { op: "f64.abs" },
    { op: "f64.const", value: Infinity },
    { op: "f64.eq" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 0 }, { op: "return" }] },
    { op: "local.get", index: 0 },
    { op: "i64.trunc_sat_f64_s" },
    { op: "i32.wrap_i64" },
  ];
  ctx.mod.functions.push({
    name: "__toUint32",
    typeIdx,
    locals: [],
    body,
    exported: false,
  });
}

/** Known constructors handled natively (not needing __new_ imports) */
export const KNOWN_CONSTRUCTORS = new Set([
  "Array",
  "Date",
  "Map",
  "Set",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  // (#1467) AggregateError gets its own 3-param `__new_AggregateError` host
  // import registered by new-super.ts (errors + message + options). The
  // generic unknown-constructor pre-pass would register it with a 2-param
  // signature (errors + message only), which then collides with new-super.ts's
  // 3-param call site and silently drops the `options` argument. Keep this
  // entry in `KNOWN_CONSTRUCTORS` so the pre-pass skips it and lets
  // new-super.ts register the canonical signature.
  "AggregateError",
  "Test262Error",
  "Object",
  "Function",
  "Promise",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "Number",
  "String",
  "Boolean",
  "ArrayBuffer",
  "DataView",
  "Proxy",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
]);

/** Functional array methods that need host callback bridges */
export const FUNCTIONAL_ARRAY_METHODS = new Set([
  "filter",
  "map",
  "reduce",
  "reduceRight",
  "forEach",
  "find",
  "findIndex",
  "some",
  "every",
]);

/**
 * Check if a ts.Type is a TypeScript tuple type (e.g. [number, string]).
 * Tuples are TypeReference types whose target has the Tuple object flag.
 * The Tuple flag is on the target, not the reference itself.
 */
export function isTupleType(type: ts.Type): boolean {
  if (!(type.flags & ts.TypeFlags.Object)) return false;
  const objType = type as ts.ObjectType;
  // Direct Tuple flag check (on the target for TypeReference types)
  if ((objType.objectFlags & ts.ObjectFlags.Tuple) !== 0) return true;
  // TypeReference → check target's objectFlags
  if ((objType.objectFlags & ts.ObjectFlags.Reference) !== 0) {
    const ref = type as ts.TypeReference;
    if (ref.target && (ref.target.objectFlags & ts.ObjectFlags.Tuple) !== 0) {
      return true;
    }
  }
  return false;
}

/**
 * Get the element types of a tuple type.
 * Returns the resolved ValType for each element position.
 */
export function getTupleElementTypes(ctx: CodegenContext, tsType: ts.Type): ValType[] {
  const typeRef = tsType as ts.TypeReference;
  const typeArgs = ctx.checker.getTypeArguments(typeRef);
  return typeArgs.map((t) => {
    // In tuple element position, `undefined` must not map to i32: i32 can't
    // distinguish "missing" from 0, which breaks destructuring default checks
    // on hole/undefined elements (e.g. `[x=23] = [,]` — the param default is a
    // hole-array tuple; the sNaN sentinel gets truncated to i32 0 and the inner
    // default `x=23` never fires). Promote to f64 so the sNaN sentinel survives.
    if ((t.flags & ts.TypeFlags.Undefined) !== 0) {
      return { kind: "f64" };
    }
    return resolveWasmType(ctx, t);
  });
}

/**
 * Build a unique key for a tuple type signature based on its element types.
 * Used as the key for tupleTypeMap to de-duplicate identical tuple shapes.
 */
function tupleTypeKey(elemTypes: ValType[]): string {
  return elemTypes
    .map((t) => {
      if (t.kind === "ref" || t.kind === "ref_null") return `${t.kind}_${t.typeIdx}`;
      return t.kind;
    })
    .join(",");
}

/**
 * Get or register a Wasm GC struct type for a tuple type.
 * Each unique tuple signature (e.g. [f64, externref]) maps to one struct type
 * with fields named _0, _1, etc.
 */
export function getOrRegisterTupleType(ctx: CodegenContext, elemTypes: ValType[]): number {
  const key = tupleTypeKey(elemTypes);
  const existing = ctx.tupleTypeMap.get(key);
  if (existing !== undefined) return existing;

  const fields: FieldDef[] = elemTypes.map((t, i) => ({
    name: `_${i}`,
    type: t,
    mutable: false,
  }));

  const typeIdx = ctx.mod.types.length;
  const structName = `__tuple_${ctx.tupleTypeMap.size}`;
  ctx.mod.types.push({
    kind: "struct",
    name: structName,
    fields,
  } as StructTypeDef);
  ctx.tupleTypeMap.set(key, typeIdx);
  ctx.structMap.set(structName, typeIdx);

  // Register in structFields so emitStructFieldGetters can export __sget_0, __sget_1 etc.
  // This enables the runtime to introspect tuple elements (needed for Map/Set iterables).
  ctx.structFields.set(
    structName,
    fields.map((f) => ({
      name: f.name,
      type: f.type,
      mutable: f.mutable ?? false,
    })),
  );

  return typeIdx;
}

/**
 * Native type annotation map: type alias names that map to Wasm types.
 * When a user writes `type i32 = number; let x: i32 = 42;`, the compiler
 * will use Wasm i32 instead of f64 for the local variable.
 */
const NATIVE_TYPE_MAP: Record<string, ValType> = {
  i32: { kind: "i32" },
  u8: { kind: "i32" }, // unsigned 8-bit — stored as i32 (masked at boundaries)
  u16: { kind: "i32" }, // unsigned 16-bit — stored as i32 (masked at boundaries)
  u32: { kind: "i32" }, // unsigned 32-bit — stored as i32
  i8: { kind: "i32" }, // signed 8-bit — stored as i32
  i16: { kind: "i32" }, // signed 16-bit — stored as i32
  f32: { kind: "f32" },
  f64: { kind: "f64" },
  // i64 intentionally omitted — requires BigInt integration, not yet supported
};

/**
 * Detect native type annotations (e.g., `type i32 = number`) from a TS type's
 * alias symbol. Returns the corresponding Wasm ValType, or null if not a native
 * type annotation.
 *
 * TypeScript preserves the alias symbol on types at the usage site, so
 * `let x: i32` where `type i32 = number` will have aliasSymbol.name === "i32"
 * even though the resolved type is `number`.
 */
export function resolveNativeTypeAnnotation(tsType: ts.Type): ValType | null {
  const aliasName = tsType.aliasSymbol?.name;
  if (aliasName && aliasName in NATIVE_TYPE_MAP) {
    // Verify the alias resolves to number (not some unrelated type named "i32")
    // by checking that the underlying type is a number type.
    // aliasSymbol is set → the resolved type should be NumberLike.
    const flags = tsType.flags;
    if (flags & ts.TypeFlags.Number || flags & ts.TypeFlags.NumberLiteral) {
      return NATIVE_TYPE_MAP[aliasName]!;
    }
  }
  return null;
}

/**
 * (#2176) Resolve the type of an identifier reference, preferring the user's
 * own declaration over an ambient lib (`.d.ts`) global of the same name.
 *
 * Root cause: js2wasm analyzes a top-level program as a **script** (no
 * import/export ⇒ not a module). In script mode a top-level `const name = …`
 * does NOT shadow the writable global `var name: string` declared in
 * `lib.dom.d.ts` (both live in the global scope, and TypeScript resolves a
 * bare reference to the ambient symbol). So `const y = name` types `y` as
 * `void` (the ambient `name`) instead of `string`, and the colliding-name
 * read (`` `${name}` ``, `"x" + name`, `const y = name`) loses its real type —
 * the codegen then registers `y` as an i32 global and the value reads back as
 * `0`/`undefined`. Runtime values are stored correctly under `$__mod_name`;
 * only the *type* is poisoned. Common colliders: `name` (→ undefined),
 * `length`, `top`, `status`, `origin`, etc. from lib.dom.
 *
 * Fix: when `getTypeAtLocation(id)` binds to a symbol whose declarations live
 * ONLY in lib `.d.ts` files, but a user-level binding of that exact name is in
 * scope (a non-lib declaration), re-derive the type from the user binding so
 * the read/declaration sees the real type. Falls back to the original type
 * when no user binding shadows the ambient — zero behavior change for genuine
 * host-global reads (`window.name`, bare `length` with no user binding).
 */
export function resolveIdentifierType(ctx: CodegenContext, id: ts.Identifier): ts.Type {
  const sym = ctx.checker.getSymbolAtLocation(id);
  const decls = sym?.declarations;
  // Only intervene when the bound symbol is purely ambient (every declaration
  // lives in a lib/declaration file). A user declaration mixed in means TS
  // already resolved (at least partly) to the user — leave it alone.
  const isPurelyAmbient =
    decls !== undefined && decls.length > 0 && decls.every((d) => d.getSourceFile().isDeclarationFile);
  if (!isPurelyAmbient) {
    return ctx.checker.getTypeAtLocation(id);
  }
  // A same-name user binding shadows the ambient global, but in script mode the
  // checker's scope contains ONLY the ambient symbol — `getSymbolsInScope`
  // never surfaces the user binding. So walk the AST enclosing scopes for a
  // user-source declaration (var/let/const, function, class, or param) of the
  // same name and re-derive the type from it.
  const userDecl = findUserBindingDecl(id);
  if (userDecl) {
    return ctx.checker.getTypeAtLocation(userDecl);
  }
  return ctx.checker.getTypeAtLocation(id);
}

/**
 * (#2176) Walk enclosing scopes from `id` outward to find a user-source
 * declaration that binds `id.text` (a `var`/`let`/`const` declaration,
 * function/class declaration, or parameter). Returns the binding node whose
 * `getTypeAtLocation` gives the real type, or undefined if no user binding
 * shadows the ambient global.
 */
function findUserBindingDecl(id: ts.Identifier): ts.Node | undefined {
  const name = id.text;
  const bindsName = (node: ts.Node): ts.Node | undefined => {
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      !node.getSourceFile().isDeclarationFile
    ) {
      return node;
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name?.text === name &&
      !node.getSourceFile().isDeclarationFile
    ) {
      return node;
    }
    return undefined;
  };
  // Search a statement list (block / source file body) for a binding.
  const searchStatements = (statements: readonly ts.Statement[]): ts.Node | undefined => {
    for (const stmt of statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          const found = bindsName(d);
          if (found) return found;
        }
      } else {
        const found = bindsName(stmt);
        if (found) return found;
      }
    }
    return undefined;
  };
  let scope: ts.Node | undefined = id.parent;
  while (scope) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope)) {
      const found = searchStatements(scope.statements);
      if (found) return found;
    }
    // Function/arrow/method parameters bind names in their body scope.
    if (
      (ts.isFunctionDeclaration(scope) ||
        ts.isFunctionExpression(scope) ||
        ts.isArrowFunction(scope) ||
        ts.isMethodDeclaration(scope) ||
        ts.isConstructorDeclaration(scope)) &&
      scope.parameters
    ) {
      for (const p of scope.parameters) {
        const found = bindsName(p);
        if (found) return found;
      }
    }
    scope = scope.parent;
  }
  return undefined;
}

/**
 * Resolve a ts.Type to a ValType, using the struct registry and anonymous type map.
 * Use this instead of mapTsTypeToWasm in the codegen to get real type indices.
 */
export function resolveWasmType(ctx: CodegenContext, tsType: ts.Type, _depth = 0, _visited?: Set<ts.Type>): ValType {
  // Guard against infinite recursion (can happen with skipSemanticDiagnostics
  // when getTypeArguments returns the container type itself)
  if (_depth > 10) return { kind: "externref" };
  if (_visited && _visited.has(tsType)) return { kind: "externref" };
  if (!_visited) _visited = new Set<ts.Type>();
  _visited.add(tsType);
  // Native type annotations: type i32 = number; let x: i32 → Wasm i32
  // Check aliasSymbol first — TypeScript preserves the alias name on the type.
  const nativeType = resolveNativeTypeAnnotation(tsType);
  if (nativeType) return nativeType;

  // Fast mode: string → ref $AnyString (not externref).
  // The String WRAPPER object (`new String(x)`) is excluded here — `isStringType`
  // intentionally also matches the wrapper for primitive-string method dispatch,
  // but the wrapper is a `typeof "object"` value carrying its [[StringData]] in a
  // native `$Object` slot (#1910 S2 / #2160). Resolving it to `$AnyString` would
  // make the wrapper-`$Object` externref fail the ref.cast on bind → null. It must
  // fall through to the externref wrapper branch below.
  if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && isStringType(tsType) && !isStringWrapperType(tsType)) {
    return { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
  }

  // Check tuple types BEFORE Array — tuples have the Object flag and Array symbol
  // but should be compiled to structs, not arrays
  if (isTupleType(tsType)) {
    const elemTypes = getTupleElementTypes(ctx, tsType);
    const tupleIdx = getOrRegisterTupleType(ctx, elemTypes);
    return { kind: "ref", typeIdx: tupleIdx };
  }

  // Check Array<T> / T[] BEFORE isExternalDeclaredClass, because Array is declared
  // in the lib as `declare var Array: ArrayConstructor` which would match externref
  if (tsType.flags & ts.TypeFlags.Object) {
    const sym = (tsType as ts.TypeReference).symbol ?? (tsType as ts.Type).symbol;
    // `TemplateStringsArray` (the first parameter of a tag function) is the
    // template object built by `compileTaggedTemplateExpression` — a vec struct
    // `{ length, data, raw }` (the template vec type). It extends
    // `ReadonlyArray<string>`, so it MUST be matched before the Array branch
    // below, otherwise it would lower to a plain string vec without the `raw`
    // field and indexed/`.raw` reads would mismatch the runtime struct (#2008).
    if (sym?.name === "TemplateStringsArray") {
      const templateVecTypeIdx = getOrRegisterTemplateVecType(ctx);
      return { kind: "ref_null", typeIdx: templateVecTypeIdx };
    }

    // `readonly T[]` / `ReadonlyArray<T>` lower identically to `T[]` — `readonly`
    // is a TS-only modifier with no runtime representation. Without this, a
    // ReadonlyArray-typed struct field falls through to the anonymous-struct /
    // externref path and mismatches the vec the array literal builds, trapping
    // on indexed read (#1748).
    if (sym?.name === "Array" || sym?.name === "ReadonlyArray") {
      const typeArgs = ctx.checker.getTypeArguments(tsType as ts.TypeReference);
      const elemTsType = typeArgs[0];
      let elemWasm: ValType = elemTsType
        ? resolveWasmType(ctx, elemTsType, _depth + 1, _visited)
        : { kind: "externref" };
      // (#2806) An array whose element type is **purely** `undefined` / `void`
      // must lower to an externref-element vec, not a numeric (i32) vec — the
      // same alignment applied to `var x = (void 0)` slots. The canonical source
      // is acorn's `parseExprList`: `var elt = (void 0); … elt = <nodeRef>;
      // elts.push(elt); return elts`. TS infers the *function return type* as
      // `undefined[]`, so the returned vec type would be an i32 vec while the
      // local `elts` is an externref vec — `return elts` then copies/coerces
      // each pushed REFERENCE to i32 `0`, dropping the AST node refs (#2801).
      // Resolving `undefined[]`/`void[]` to externref here keeps the return type
      // (and any field/param so typed) in lockstep with the externref local.
      // `never[]` already resolves to externref; this closes the `undefined[]`
      // gap. Pure undefined/void only (no Number/Boolean/etc.) so `number[]`
      // (f64) and `boolean[]` (i32) are untouched; `number | undefined` carries
      // the Union flag, not Undefined, and is left alone.
      if (
        elemTsType &&
        (elemWasm.kind === "i32" || elemWasm.kind === "f64") &&
        (elemTsType.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0 &&
        (elemTsType.flags & ~(ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0
      ) {
        elemWasm = { kind: "externref" };
      }
      const elemKey =
        elemWasm.kind === "ref" || elemWasm.kind === "ref_null"
          ? `ref_${(elemWasm as { typeIdx: number }).typeIdx}`
          : elemWasm.kind;
      const vecIdx = getOrRegisterVecType(ctx, elemKey, elemWasm);
      // Use ref_null so locals can default-initialize to null
      return { kind: "ref_null", typeIdx: vecIdx };
    }

    // Wrapper types (Number, String, Boolean) — map to externref.
    // new Number(x), new String(x), new Boolean(x) are wrapper objects (typeof "object").
    if (sym?.name === "Number" && tsType.flags & ts.TypeFlags.Object) {
      return { kind: "externref" };
    }
    if (sym?.name === "String" && tsType.flags & ts.TypeFlags.Object) {
      return { kind: "externref" };
    }
    if (sym?.name === "Boolean" && tsType.flags & ts.TypeFlags.Object) {
      return { kind: "externref" };
    }

    // Promise<T> → unwrap to T (host/GC) OR externref (native carrier).
    if (sym?.name === "Promise") {
      const typeArgs = ctx.checker.getTypeArguments(tsType as ts.TypeReference);
      if (typeArgs.length > 0) {
        const inner = typeArgs[0]!;
        if (isVoidType(inner)) return { kind: "externref" }; // Promise<void> → externref (no value)
        // (#2905/#3134) A `Promise<T>` VALUE slot (local/param/field/non-async
        // return/vec element) lowers to externref on EVERY lane — it holds a
        // real promise, not the unwrapped `T`. Unwrapping to `T` (f64) then
        // `__unbox_number`'d a real promise externref → NaN; externref serves
        // the legacy sync-fakery rep too (an async call compiled synchronously
        // returns the unwrapped f64, which boxes at the coerce and unboxes /
        // `Promise_resolve`-assimilates on use). Unifying the rep also fixes a
        // `Promise<T>[]` element (frame spill guess now matches the stored
        // promise → unblocks #2967 2c class-2). An async fn's OWN return
        // pre-unwraps via `unwrapPromiseType` before this branch. externref is
        // a leaf valtype (no DCE/funcIdx churn). Broad rep change → full-CI A/B.
        return { kind: "externref" };
      }
      return { kind: "externref" }; // bare Promise without type arg
    }

    // TypedArray types → vec struct. Native Uint8Array uses packed-byte
    // storage; other typed arrays keep the legacy f64 representation.
    // Covers: Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    //         Int32Array, Uint32Array, Float32Array, Float64Array
    // (#838) BigInt64Array/BigUint64Array resolve to an i64-element vec (they are
    // deliberately kept OUT of `TYPED_ARRAY_NAMES` so the f64-assuming host
    // marshalling classifier treats them as "other"; `typedArrayVecStorage`
    // returns i64 for them).
    if (sym?.name && (TYPED_ARRAY_NAMES.has(sym.name) || BIGINT_TYPED_ARRAY_NAMES.has(sym.name))) {
      const storage = typedArrayVecStorage(ctx, sym.name);
      const vecIdx = getOrRegisterVecType(ctx, storage.key, storage.type);
      return { kind: "ref_null", typeIdx: vecIdx };
    }

    // Date → WasmGC struct with i64 timestamp field
    if (sym?.name === "Date") {
      const dateTypeIdx = ensureDateStructForCtx(ctx);
      return { kind: "ref", typeIdx: dateTypeIdx };
    }

    // (#1103a) Map → WasmGC native Map struct (`$Map`) in standalone /
    // nativeStrings mode. Mirrors Date above — a `Map`-typed binding/param
    // becomes `ref $Map` so `new Map()` stores directly and method/.size
    // dispatch reads a typed receiver (no externref round-trip / illegal cast).
    // JS-host mode keeps Map as an externref-backed externClass (falls through).
    if (sym?.name === "Map" && ctx.nativeStrings) {
      ensureMapRuntimeTypes(ctx);
      if (ctx.mapTypeIdx >= 0) return { kind: "ref", typeIdx: ctx.mapTypeIdx };
    }

    // (#2162) Set → the SAME native `$Map` struct in standalone / nativeStrings
    // mode (a Set is a Map with key === value). A `Set`-typed binding becomes
    // `ref $Map` so `new Set()` stores directly and method/.size dispatch reads
    // a typed receiver. JS-host mode keeps Set as an externref externClass.
    if (sym?.name === "Set" && ctx.nativeStrings) {
      ensureMapRuntimeTypes(ctx);
      if (ctx.mapTypeIdx >= 0) return { kind: "ref", typeIdx: ctx.mapTypeIdx };
    }

    // (#2162) WeakMap / WeakSet → the SAME native `$Map` struct in standalone /
    // nativeStrings mode (they reuse the Map backing store with object-identity
    // keys and no iteration). JS-host mode keeps them as externref externClasses.
    if ((sym?.name === "WeakMap" || sym?.name === "WeakSet") && ctx.nativeStrings) {
      ensureMapRuntimeTypes(ctx);
      if (ctx.mapTypeIdx >= 0) return { kind: "ref", typeIdx: ctx.mapTypeIdx };
    }

    // Check externref AFTER Array check — Array is declared in lib but should use wasm GC arrays
    if (isExternalDeclaredClass(tsType, ctx.checker)) return { kind: "externref" };

    // (#2937) The checker type of a `{}` var poisoned as an `$Object`-hash
    // consumer (#2584/#2849) must NOT resolve to a closed struct. In JS-mode
    // sources the checker EVOLVES `var o = {}` through its later static-named
    // writes into an anonymous object type WITH those props; auto-registering
    // it below would type the local — and every flow position the object
    // passes through (returns, class fields, receivers) — as `(ref null
    // __anon_N)` while the poisoned initializer builds a host plain object
    // (externref). The declaration's guarded cast then stores ref.null and
    // every static read null-derefs (compiled-acorn `getOptions`, #2937).
    // Externref keeps ALL access forms on the poisoned var routed through the
    // host MOP coherently. The set is empty in standalone mode (recorded
    // host-only), so standalone codegen is unaffected.
    if (ctx.objectHashConsumerTypes.has(tsType)) return { kind: "externref" };

    // (#1712) Function-style-constructor instance types resolve to EXTERNREF,
    // never to a synthesized checker-shape struct. The runtime instance struct
    // (compileFnctorNew, `__fnctor_<name>`) is built from ctor `this.*` writes
    // only, while the checker's shape adds prototype-assigned methods as
    // members — the two shapes have no subtype relation, so any value typed
    // with the checker shape guard-casts to null and downstream struct.get /
    // ref.as_non_null traps (acorn `Parser.prototype.parse = function () {
    // return new Parser(...); }`). Externref makes fnctor instances flow
    // dynamically end to end: member calls take the host-bridge path (which
    // resolves through the vivified prototype) and field reads go through
    // __extern_get/_safeGet. NOTE: resolving to the CTOR struct here instead
    // was tried and regressed (.tmp/dbg15.mts G4/G5) — the member-call
    // static/dynamic split keys off this type, so only the always-dynamic
    // externref resolution is safe. JS-host mode only.
    if (!ctx.standalone && !ctx.wasi) {
      const fnDecl = sym?.valueDeclaration;
      const isFnCtorType =
        (sym?.name !== undefined && ctx.funcConstructorMap.has(sym.name)) ||
        (!!fnDecl &&
          (ts.isFunctionDeclaration(fnDecl) ||
            ts.isFunctionExpression(fnDecl) ||
            (ts.isVariableDeclaration(fnDecl) && !!fnDecl.initializer && ts.isFunctionExpression(fnDecl.initializer))));
      // Only when the type is an INSTANCE shape (has properties but is not
      // itself callable) — the function VALUE type (callable) must keep its
      // closure-wrapper resolution.
      if (isFnCtorType && tsType.getCallSignatures().length === 0) {
        return { kind: "externref" };
      }
    }

    // (#2542) A PURE string-index-signature type — `{ [s: string]: T }`, a
    // `type`-alias to one, or an `interface Dict { [s: string]: T }` — with no own
    // named properties is an open dictionary. Its only access mode is runtime
    // string-keyed [[Get]]/[[Set]] (`o[k]`), serviced by the native object runtime
    // over a `$Object` externref (`__extern_get`/`__extern_set`). Without this
    // guard the type lowers to an EMPTY WasmGC struct (anonymous → the auto-register
    // below; named interface → `collectInterface`'s empty struct): a value typed
    // that way (param, return, local) becomes `ref $empty`, so a `$Object` argument
    // guard-casts to null at the call boundary and every `o[k]` read returns 0.
    // Resolving to externref keeps such values flowing as `$Object`s end to end,
    // matching the open-`$Object` literal lowering in compileObjectLiteral (#2542).
    //
    // Runs BEFORE the named-struct lookup so a pure-index-signature *interface*
    // (already registered as an empty struct by `collectInterface`) still resolves
    // to externref — the empty struct stays registered (harmless; dead-eliminated
    // if unreferenced) but is never used as a value type, so no type-index shift.
    //
    // Standalone-only: the open-object runtime is emitted exclusively under
    // `ctx.standalone` (see compileObjectLiteral's #1901/#2542 gate); gc/host/wasi
    // keep their existing struct/externref mapping byte-identical. A MIXED
    // `{ a: number; [s: string]: T }` (own named props) is intentionally excluded —
    // it has a static shape consumers read by field, so it keeps its struct.
    if (
      ctx.standalone &&
      tsType.getProperties().length === 0 &&
      tsType.getCallSignatures().length === 0 &&
      !!ctx.checker.getIndexInfoOfType(tsType, ts.IndexKind.String)
    ) {
      return { kind: "externref" };
    }

    let name = sym?.name;
    // Map class expression symbol names to their synthetic names
    if (name && !ctx.structMap.has(name)) {
      name = ctx.classExprNameMap.get(name) ?? name;
    }
    // (#3051 Slice 3, NARROWED after the PR-#2910 merge_group park) Accessor-
    // bearing ANONYMOUS object types are NOT blanket-lowered to externref here:
    // #2724's guard in ensureStructForType deliberately keeps getter-ONLY
    // literal types registered as structs because the object-REST copy paths
    // (`{...x} = { get v() {…} }`, for-await rest) steer by that registration
    // (struct→externref→__extern_rest_object); unregistering routed them to the
    // externref-rest path which never invokes the getter (regressed
    // dstr/obj-rest-getter-abrupt-get-error in the merge_group re-validation).
    // The host-object-representation fix for CLOSURE RETURNS lives at the two
    // return-type resolution sites in closures.ts via
    // `resolveWasmTypeForClosureReturn` instead.
    // Check named structs (interfaces, type aliases)
    if (name && name !== "__type" && name !== "__object" && ctx.structMap.has(name)) {
      // (#1366a) Externref-backed user classes (e.g. `class Sub extends Error`)
      // have their instance live as a real JS object; the registered struct
      // type exists for tag/registry bookkeeping only. Wasm-typed values for
      // these types must be externref so callers see what `<className>_new`
      // actually returns.
      if (ctx.classExternrefBackedSet.has(name)) {
        return { kind: "externref" };
      }
      return { kind: "ref", typeIdx: ctx.structMap.get(name)! };
    }
    // Check anonymous type registry
    const anonName = ctx.anonTypeMap.get(tsType);
    if (anonName && ctx.structMap.has(anonName)) {
      return { kind: "ref", typeIdx: ctx.structMap.get(anonName)! };
    }

    // Auto-register anonymous object types that look like plain data objects
    // (name is __type or __object, has properties, not a class/function/external type)
    if (!anonName && (name === "__type" || name === "__object") && tsType.getProperties().length > 0) {
      ensureStructForType(ctx, tsType);
      const registeredName = ctx.anonTypeMap.get(tsType);
      if (registeredName && ctx.structMap.has(registeredName)) {
        return { kind: "ref", typeIdx: ctx.structMap.get(registeredName)! };
      }
    }
  }

  // Handle unions (T | undefined | void) — resolve inner type.
  // (#1550) Filter Void alongside Null/Undefined — TS treats counter()'s `void`
  // return as a distinct type, but at runtime it's just `undefined`. Without
  // this, `void | null` (e.g. binding `w` in `function f({w = counter()} = {w: null})`)
  // collapses to `void` → i32 and the destructured null is erased.
  if (tsType.isUnion()) {
    const nonNullish = tsType.types.filter(
      (t) => !(t.flags & ts.TypeFlags.Null) && !(t.flags & ts.TypeFlags.Undefined) && !(t.flags & ts.TypeFlags.Void),
    );
    if (nonNullish.length === 1 && tsType.types.length === 2) {
      const inner = resolveWasmType(ctx, nonNullish[0]!, _depth + 1, _visited);
      if (inner.kind === "ref") return { kind: "ref_null", typeIdx: inner.typeIdx };
      return inner;
    }
    // (#745 S2) Known heterogeneous primitive unions (number|string, …) adopt
    // the universal $AnyValue tagged carrier in unionAnyRep lanes
    // (standalone/nativeStrings), replacing externref + per-op
    // box/unbox/typeof round-trips. Homogeneous unions, nullable single-kind
    // unions (handled above), and unions with any non-primitive member keep
    // their existing representation — see isHeterogeneousPrimitiveUnion.
    if (ctx.unionAnyRep && isHeterogeneousPrimitiveUnion(tsType)) {
      ensureAnyValueType(ctx);
      return { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };
    }
  }

  // any/unknown → ref_null $AnyValue (boxed any) when available.
  // Only in fast mode where there are no host-imported extern classes to conflict with.
  // In non-fast mode, any/unknown falls through to mapTsTypeToWasm → externref.
  if (ctx.fast && tsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
    ensureAnyValueType(ctx);
    return { kind: "ref_null", typeIdx: ctx.anyValueTypeIdx };
  }

  return mapTsTypeToWasm(tsType, ctx.checker, ctx.fast);
}

/**
 * (#3051 Slice 3) True when the object type carries at least one property
 * declared as an OBJECT-LITERAL get/set accessor (`{ get x() {…} }` /
 * `{ set x(v) {…} }`). Such values are runtime-represented as HOST plain
 * objects (see `compileObjectLiteralWithAccessors`, #1239). Class/interface
 * accessors (declaration parent is not an ObjectLiteralExpression) do NOT
 * qualify — those instances keep their struct representation.
 */
function typeHasObjLitAccessorProperty(tsType: ts.Type): boolean {
  for (const p of tsType.getProperties()) {
    const decls = p.getDeclarations?.() ?? p.declarations;
    if (!decls) continue;
    for (const d of decls) {
      if (
        (ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d)) &&
        d.parent != null &&
        ts.isObjectLiteralExpression(d.parent)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * (#3051 Slice 3, narrowed) Resolve a CLOSURE/CALLBACK return type, lowering
 * accessor-bearing anonymous object-literal types to externref. The runtime
 * value of `{ get index() {…} }` is a HOST plain object
 * (`compileObjectLiteralWithAccessors`, #1239); typing the closure's wasm
 * return as the checker's struct made the return-path coercion
 * externref→struct null-drop on the failed `ref.test` (type-coercion.ts) —
 * a `regexp.exec` override returning a poisoned `{ get index() { throw … } }`
 * arrived at V8's @@replace protocol as `null` (= no match) and the getter
 * never fired (the test262 `result-get-*-err` cluster). Scoped to RETURN-type
 * resolution ONLY: blanket-lowering these types in `resolveWasmType` broke the
 * #2724 object-REST steering (see the note in `resolveWasmType`).
 */
export function resolveWasmTypeForClosureReturn(ctx: CodegenContext, retType: ts.Type): ValType {
  const symName = retType.getSymbol()?.name;
  if ((symName === "__type" || symName === "__object") && typeHasObjLitAccessorProperty(retType)) {
    return { kind: "externref" };
  }
  return resolveWasmType(ctx, retType);
}

/**
 * Compute a hash key for a list of struct fields (for O(1) structural dedup).
 * The key encodes field names, type kinds, and typeIdx for ref/ref_null types.
 */
function fieldsHashKey(fields: FieldDef[]): string {
  const parts: string[] = [];
  for (const f of fields) {
    const t = f.type;
    if (t.kind === "ref" || t.kind === "ref_null") {
      parts.push(`${f.name}:${t.kind}:${(t as { typeIdx: number }).typeIdx}`);
    } else if (t.kind === "i32" && (t as { boolean?: true }).boolean) {
      // (#1788) Keep boolean-branded i32 fields distinct from numeric i32 in the
      // structural dedup key — they box differently (`__box_boolean` vs
      // `__box_number`), so two shapes that differ only in boolean-vs-number must
      // not collapse to one struct (which would inherit the wrong getter boxing).
      parts.push(`${f.name}:i32:bool`);
    } else {
      parts.push(`${f.name}:${t.kind}`);
    }
  }
  return parts.join("|");
}

/** Ensure the $__Date struct type exists in the module, return its type index. */
function ensureDateStructForCtx(ctx: CodegenContext): number {
  const existing = ctx.structMap.get("__Date");
  if (existing !== undefined) return existing;

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct" as const,
    name: "__Date",
    fields: [{ name: "timestamp", type: { kind: "i64" as const }, mutable: true }],
  });
  ctx.structMap.set("__Date", typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, "__Date");
  ctx.structFields.set("__Date", [{ name: "timestamp", type: { kind: "i64" as const }, mutable: true }]);
  return typeIdx;
}

/**
 * Ensure a ts.Type that's an object type is registered as a struct.
 * For named types already in structMap, this is a no-op.
 * For anonymous types, auto-registers them with a generated name.
 */
export function ensureStructForType(ctx: CodegenContext, tsType: ts.Type): void {
  if (!(tsType.flags & ts.TypeFlags.Object)) return;
  if (isExternalDeclaredClass(tsType, ctx.checker)) return;
  // (#2937) Never register a struct for the evolved checker type of a poisoned
  // `$Object`-hash-consumer `{}` var — it must stay externref/host-MOP end to
  // end (see resolveWasmType's matching guard for the full rationale).
  if (ctx.objectHashConsumerTypes.has(tsType)) return;
  // Types declared in `.d.ts` files (interfaces, type aliases, classes
  // exported from declaration-file-only packages) have no JS implementation
  // we can lower to a WasmGC struct. Registering them as anon structs
  // recursively pulls in their fields' types, which for any non-trivial
  // shape (e.g. `errors: ValidationError[]` in `@types/json-schema`)
  // produces forward heap-type references that fail Wasm validation.
  // Skip registration — these types map to `externref` everywhere. (#1287)
  const dtsDecls = tsType.symbol?.getDeclarations?.();
  if (dtsDecls && dtsDecls.length > 0 && dtsDecls.every((d) => d.getSourceFile().isDeclarationFile)) {
    return;
  }
  // Tuple types are handled by getOrRegisterTupleType, not as anonymous structs
  if (isTupleType(tsType)) return;
  // #1247: Array types compile to vec structs (length+data) via getOrRegisterVecType,
  // not anonymous structs that pull in every Array.prototype method as a field. Without
  // this guard, `string[]` registers an anonymous struct named after Array.prototype's
  // shape, and `paths.shift()` resolves through compileCallablePropertyCall (a
  // callable-field dispatch) instead of compileArrayMethodCall — producing
  // struct-type mismatches at instantiation when the local was allocated via the
  // vec path but the callable-property dispatch reads through the anon struct.
  {
    const sym = (tsType as ts.TypeReference).symbol ?? (tsType as ts.Type).symbol;
    if (
      sym?.name === "Array" ||
      sym?.name === "ReadonlyArray" ||
      sym?.name === "Int8Array" ||
      sym?.name === "Uint8Array" ||
      sym?.name === "Uint8ClampedArray" ||
      sym?.name === "Int16Array" ||
      sym?.name === "Uint16Array" ||
      sym?.name === "Int32Array" ||
      sym?.name === "Uint32Array" ||
      sym?.name === "Float32Array" ||
      sym?.name === "Float64Array" ||
      sym?.name === "Promise" ||
      sym?.name === "Date" ||
      sym?.name === "Map" ||
      sym?.name === "Set" ||
      sym?.name === "WeakMap" ||
      sym?.name === "WeakSet" ||
      sym?.name === "RegExp" ||
      sym?.name === "Number" ||
      sym?.name === "String" ||
      sym?.name === "Boolean"
    ) {
      return;
    }
  }
  // Callable types (functions) are compiled as closures, not structs
  if (tsType.getCallSignatures().length > 0) return;
  // (#2542) A pure string-index-signature type — `{ [s: string]: T }` with no own
  // named properties — is an open dictionary that lowers to a `$Object` externref
  // (see resolveWasmType's #2542 guard), NOT an empty WasmGC struct. Registering an
  // empty struct here would make `resolveWasmType` pick `ref $empty` for the binding
  // and break the call-boundary `$Object`→struct cast (every `o[k]` read returns 0).
  // Standalone-only, matching the resolveWasmType guard's scope.
  if (
    ctx.standalone &&
    tsType.getProperties().length === 0 &&
    !!ctx.checker.getIndexInfoOfType(tsType, ts.IndexKind.String)
  ) {
    return;
  }
  // Guard against infinite recursion on circular/self-referencing types.
  // Uses per-compilation ctx.ensureStructPending (not module-scoped) to avoid
  // leaking state between compile() calls in the same process (#923).
  if (ctx.ensureStructPending.has(tsType)) return;
  ctx.ensureStructPending.add(tsType);

  const name = tsType.symbol?.name;

  // Already registered as named struct
  if (name && name !== "__type" && name !== "__object" && ctx.structMap.has(name)) return;

  // Already registered as anonymous struct
  if (ctx.anonTypeMap.has(tsType)) return;

  // Get properties from the type (empty objects get an empty struct)
  const props = tsType.getProperties();

  // (#2724) An object-LITERAL accessor-bearing type that ALSO carries a
  // non-accessor (data/method) own property must not become a closed struct.
  // getTypeOfSymbol on a getter symbol yields the getter's RETURN type, so a
  // getter `return` would be laid out as a plain data field (e.g. f64) — but the
  // literal is built as an externref $Object by compileObjectLiteralWithAccessors
  // (literals.ts). The two representations collide (gc: the externref $Object does
  // not match the struct, so reads come back null; standalone: the externref→struct
  // ref.cast traps with "illegal cast"). Skip registration → the type lowers to
  // externref everywhere (resolveWasmType falls through to mapTsTypeToWasm), and the
  // existing $Object accessor read path (__extern_get → __call_accessor_get) services
  // it. This is the root cause of #1642's residual iterator-close-*-get-method-* edges
  // (the iterator factory `{ next, get return() }` registered a closed struct, so
  // __iterator(iterable) read back null and __iterator_next(null) threw upstream of
  // close).
  //
  // (#2724 narrowing — merge_group floor fix) SCOPED to MIXED accessor literals
  // (≥1 obj-literal accessor AND ≥1 non-accessor own property). A getter-ONLY
  // literal like `{ get v() {} }` is, on main, used almost exclusively as an
  // object-REST/spread SOURCE (`{...x} = { get v() {} }`, `for await ({...x} of
  // [{ get v() {} }])`, RegExpExec's `{ get 0() {} }`). The object-rest copy paths
  // (assignment.ts / loops.ts) read the source through a `struct→externref →
  // __extern_rest_object` conversion that REQUIRES the source to be a registered
  // struct; lowering a getter-only literal to externref instead routes it to the
  // externref-rest path which does not run __extern_rest_object (assignment-rest)
  // or double-wraps it (`extern.convert_any` on an already-externref value in the
  // for-await path) — so the getter is never invoked / re-invoked, breaking
  // CopyDataProperties semantics. Restricting the guard to MIXED literals keeps
  // every getter-only rest/RegExp source on its working struct path (zero
  // regressions vs. the merged baseline) while still externref-lowering the #1642
  // iterators (which are mixed: an iterator always has a `next` method). The
  // getter-only return/member-read case is deferred to the #2580 externref-rest
  // substrate work. SCOPED to object-LITERAL accessors only (declaration parent is
  // an ObjectLiteralExpression): a CLASS getter's declaration parent is a
  // ClassDeclaration (and an interface's an InterfaceDeclaration) and MUST keep the
  // struct + getter-method representation.
  let hasObjLitAccessor = false;
  let hasNonAccessor = false;
  for (const prop of props) {
    const isAccessorSym = (prop.flags & (ts.SymbolFlags.GetAccessor | ts.SymbolFlags.SetAccessor)) !== 0;
    if (
      isAccessorSym &&
      (prop.declarations ?? []).some(
        (d) =>
          (ts.isGetAccessorDeclaration(d) || ts.isSetAccessorDeclaration(d)) &&
          d.parent != null &&
          ts.isObjectLiteralExpression(d.parent),
      )
    ) {
      hasObjLitAccessor = true;
    } else if (!isAccessorSym) {
      hasNonAccessor = true;
    }
  }
  if (hasObjLitAccessor && hasNonAccessor) return; // leave externref; do not register a struct

  const fields: FieldDef[] = [];
  // #1118 follow-up: track callable-property arities so structs whose methods
  // differ in arity don't dedup. Two object literals like `{ then(r) {…} }`
  // and `{ then(r, j) {…} }` both stringify their `then` field to externref,
  // so without this distinguishing info their structs would dedup. The
  // method placeholders share a funcMap entry, and the second method body
  // overrides the first's typeIdx — breaking trampolines created against
  // the original arity. Including the arity in the hash key keeps such
  // structs distinct.
  const methodSigParts: string[] = [];
  for (const prop of props) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    // Recursively register nested object types as structs before resolving
    ensureStructForType(ctx, propType);
    // Use resolveWasmType so nested structs get ref types, not externref
    let wasmType = resolveWasmType(ctx, propType);
    // (#1468) `{ k: undefined }` makes TS infer the property's type as the
    // literal `undefined`. `mapTsTypeToWasm` maps that to i32 because for
    // function return types `undefined`/`void` indicate "no result". For a
    // struct *field* the property is a value slot, so i32 silently loses the
    // information that the slot holds `undefined`: codegen writes
    // `i32.const 0` (which the host reads back as `false`) and destructuring
    // defaults like `{ k = D }` never fire because the value isn't
    // observably undefined. Widening the field to externref lets the
    // existing `__get_undefined()` path in `compileExpression` preserve the
    // identity of `undefined`, which then trips `__extern_is_undefined` in
    // the destructuring default fast-path.
    //
    // Scope: only when the field's TS type is *exactly* the `undefined`
    // (or `void`) primitive — for `T | undefined` unions the union branch
    // in `mapTsTypeToWasm` already widens to externref / inner-T, so this
    // never affects them.
    if (
      wasmType.kind === "i32" &&
      (propType.flags & ts.TypeFlags.Undefined || propType.flags & ts.TypeFlags.Void) &&
      !(propType.flags & ts.TypeFlags.Boolean) &&
      !(propType.flags & ts.TypeFlags.BooleanLiteral) &&
      !(propType.flags & ts.TypeFlags.Number) &&
      !(propType.flags & ts.TypeFlags.NumberLiteral) &&
      !(propType.flags & ts.TypeFlags.ESSymbol) &&
      !(propType.flags & ts.TypeFlags.UniqueESSymbol)
    ) {
      wasmType = { kind: "externref" };
    }
    const callSigs = propType.getCallSignatures();
    // (#1589A) When the property's TS type has zero own properties (an empty
    // `{}` value) but resolveWasmType picked a `ref`/`ref_null` to a struct,
    // widen the field to externref. An empty object literal is constructed at
    // runtime as a host externref (`__new_plain_object`), not as a WasmGC
    // struct instance — so coercing it into a `ref null <struct>` field fails
    // the `ref.test` and stores `ref.null`. Reading the field back through
    // `__sget_<i>` then yields null, which (a) loses the value and (b) makes
    // `__extern_has_idx` report the property as absent, breaking spec
    // HasProperty (§7.3.12) for `Array.prototype.indexOf.call`-style loops.
    // Storing the value as externref preserves both the value and presence.
    // (`__Date` is the i64-timestamp struct, never an empty object literal.)
    if (
      (wasmType.kind === "ref" || wasmType.kind === "ref_null") &&
      callSigs.length === 0 &&
      propType.getProperties().length === 0
    ) {
      const refTypeIdx = (wasmType as { typeIdx: number }).typeIdx;
      const refStructName = ctx.typeIdxToStructName.get(refTypeIdx);
      if (refStructName !== "__Date") {
        wasmType = { kind: "externref" };
      }
    }
    // For valueOf/toString callable properties, store as eqref instead of externref
    // so coercion can recover the closure and call it via call_ref
    if (wasmType.kind === "externref" && callSigs.length > 0 && (prop.name === "valueOf" || prop.name === "toString")) {
      wasmType = { kind: "eqref" };
    }
    fields.push({ name: prop.name, type: wasmType, mutable: true });
    if (callSigs.length > 0) {
      const sig = callSigs[0]!;
      // Include arity AND return-type signature in the hash key. Two object
      // literals like `{ valueOf() { return 42n } }` and
      // `{ valueOf() { throw ... } }` both have arity 0 but different return
      // types (i64 vs never/void). Without distinguishing them, the placeholder
      // method's typeIdx flips between the two, breaking trampolines.
      const retType = ctx.checker.getReturnTypeOfSignature(sig);
      const retStr = retType ? ctx.checker.typeToString(retType) : "void";
      methodSigParts.push(`${prop.name}#${sig.parameters.length}->${retStr}`);
    }
  }

  // Structural dedup: O(1) hash-based lookup for matching anonymous struct fields.
  // This avoids creating duplicate struct types for the same shape when TS returns
  // different ts.Type objects (e.g. variable type vs. initializer type).
  const hashKey = fieldsHashKey(fields) + (methodSigParts.length > 0 ? "||" + methodSigParts.join(",") : "");
  const existingName = ctx.anonStructHash.get(hashKey);
  if (existingName) {
    ctx.anonTypeMap.set(tsType, existingName);
    return;
  }

  // Widen non-null ref fields to ref_null so struct.new can use ref.null defaults
  for (const field of fields) {
    if (field.type.kind === "ref") {
      field.type = { kind: "ref_null", typeIdx: field.type.typeIdx };
    }
  }

  const structName = `__anon_${ctx.anonTypeCounter++}`;
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: structName,
    fields,
  } as StructTypeDef);
  ctx.structMap.set(structName, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, structName);
  ctx.structFields.set(structName, fields);
  ctx.anonStructHash.set(hashKey, structName);
  ctx.anonTypeMap.set(tsType, structName);

  // Pre-register placeholder functions for callable properties (methods).
  // This ensures that struct method calls (e.g. obj.foo()) can resolve
  // the function index during the first pass, before the object literal's
  // method bodies are compiled in compileObjectLiteralForStruct.
  for (const prop of props) {
    const propType = ctx.checker.getTypeOfSymbol(prop);
    const callSigs = propType.getCallSignatures();
    if (callSigs.length === 0) continue;

    // Only pre-register methods that have a user-defined declaration
    // (MethodDeclaration or PropertyAssignment with function initializer in user code).
    // Skip inherited/prototype methods (toString, valueOf from Object.prototype)
    // and lib type method signatures, as they won't have a body to compile
    // in compileObjectLiteralForStruct.
    const decl = prop.valueDeclaration;
    if (!decl) continue;
    // Only pre-register MethodDeclaration — PropertyAssignment with function
    // initializers are compiled as closures (eqref fields), not direct calls,
    // so a placeholder function would never be filled and remain with an empty
    // body causing "stack for fallthru" validation errors.
    if (!ts.isMethodDeclaration(decl)) continue;
    // Also skip declarations from .d.ts files (lib types)
    const declSourceFile = decl.getSourceFile();
    if (declSourceFile && declSourceFile.isDeclarationFile) continue;

    const fullName = `${structName}_${prop.name}`;
    const methodKey = classMemberFuncKey(ctx, fullName); // (#1983) collision-free key + display name
    if (ctx.funcMap.has(methodKey)) continue; // already registered

    const sig = callSigs[0]!;
    // Build parameter types: self (ref $structTypeIdx) + declared params.
    // (#1671) This pre-registration is the CANONICAL `funcMap` entry that
    // direct calls `obj.method()` dispatch through. Its param types MUST match
    // what the method body actually compiles to in
    // `compileObjectLiteralForStruct` (search "methodParams" in literals.ts) —
    // applying the same default-init `ref→ref_null` widening AND the
    // binding-pattern `→externref` destructure widening (#1151 Gap B).
    // Otherwise the body-compile detects a signature mismatch, forks a
    // per-literal funcIdx, and leaves THIS canonical func an empty stub body —
    // so a direct `obj.method()` lands on the stub and traps
    // ("dereferencing a null pointer" / iterator "reading 'next' of null").
    const methodParams: ValType[] = [{ kind: "ref", typeIdx }];
    for (const param of sig.parameters) {
      const paramDecl = param.valueDeclaration;
      if (paramDecl && ts.isParameter(paramDecl)) {
        const pt = ctx.checker.getTypeAtLocation(paramDecl);
        let wasmType = resolveWasmType(ctx, pt);
        if (paramDecl.initializer && wasmType.kind === "ref") {
          wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
        }
        const hasBindingPattern = ts.isArrayBindingPattern(paramDecl.name) || ts.isObjectBindingPattern(paramDecl.name);
        if (hasBindingPattern && !paramDecl.type && !paramDecl.dotDotDotToken && wasmType.kind !== "externref") {
          wasmType = { kind: "externref" };
        }
        methodParams.push(wasmType);
      } else if (paramDecl) {
        const pt = ctx.checker.getTypeAtLocation(paramDecl);
        methodParams.push(resolveWasmType(ctx, pt));
      } else {
        methodParams.push({ kind: "f64" });
      }
    }
    // Check if this is a generator method (*method() { ... })
    const isGenMethod = ts.isMethodDeclaration(decl) && decl.asteriskToken !== undefined;
    const retType = ctx.checker.getReturnTypeOfSignature(sig);
    const methodResults: ValType[] = isGenMethod
      ? [{ kind: "externref" }]
      : retType && !isVoidType(retType)
        ? [resolveWasmType(ctx, retType)]
        : [];

    const methodTypeIdx = addFuncType(ctx, methodParams, methodResults, `${fullName}_type`);
    // (#3024) STABLE handle (#1916 S3), not the legacy live-regime
    // `numImportFuncs + functions.length`. This pre-mint runs during the
    // DECLARATION SCAN (via the collectEmptyObjectWidening /
    // collectGrowableObjectLiterals pre-passes' resolveWasmType), BEFORE the
    // import collectors — a live index minted here goes stale the moment any
    // collector prepends an import without a fixup, and `definedFuncAt` then
    // fails to resolve it at literal-compile time, forking a duplicate method
    // body while trampolines keep forwarding into the stale (import-range)
    // index ("call[0] expected externref/f64, found …" — the Array.prototype
    // S15.4.4.x A2 valueOf cluster). A stable handle is layout-independent:
    // shift walkers skip it and resolution happens at emit.
    const methodFuncIdx = mintDefinedFunc(ctx);
    ctx.funcMap.set(methodKey, methodFuncIdx); // (#1983) relocated key

    const methodFunc: WasmFunction = {
      name: methodKey, // (#1983) display name matches relocated funcMap key for body-fill
      typeIdx: methodTypeIdx,
      locals: [],
      body: [],
      exported: false,
    };
    pushDefinedFunc(ctx, methodFuncIdx, methodFunc);
  }
}

/**
 * Resolve a class member's PropertyName to a static string.
 * Handles identifiers, private identifiers, string literals, numeric literals,
 * and computed property names that can be evaluated at compile time.
 */

/**
 * Pre-pass: hoist all `var` declarations in a function body.
 * Walks statements recursively and pre-allocates a local for each `var`
 * variable not yet in localMap, so identifiers are valid before their
 * declaration site (JavaScript var-hoisting semantics).
 */
/**
 * (#2806) Does this variable binding require an **externref** slot because its
 * declared type is (only) `undefined` / `void`?
 *
 * Root cause of the compiled-acorn `CallExpression.arguments` drop: acorn writes
 * `var elt = (void 0); … elt = this.parseMaybeAssign(...); elts.push(elt)`. The
 * `void 0` EXPRESSION pins the binding to TS type `undefined` — UNLIKE
 * `var elt = undefined` / `var elt;`, which TS treats as evolving-any (→ `any`,
 * → externref). `resolveWasmType(undefined)` is a numeric (i32) slot, so a later
 * REFERENCE assignment is coerced to i32 `0` and the node ref is dropped.
 *
 * The fix routes a `void`-expression initializer through the SAME externref slot
 * that `= undefined` already gets — a correctness alignment, not new behaviour.
 * Used by BOTH the `var` hoister and the let/const declaration path so the slot
 * type is uniform (a `var` reuses its hoisted slot, so both sites MUST agree).
 *
 * IMPORTANT — the `void`-EXPRESSION arm triggers on the INITIALIZER ONLY, not on
 * a bare "purely `undefined`/`void` declared type". A binding can be
 * `undefined`-typed for unrelated reasons (e.g. `const afterA = obj.a` reading an
 * optional `a?: number` after `delete obj.a`), and those MUST stay a numeric slot
 * — the delete / optional-property machinery encodes `undefined` as an f64 sNaN
 * sentinel and relies on the local being f64/i32 so `afterA === undefined`
 * detects the sentinel. Forcing those to externref boxes the sentinel via
 * `__box_number` and breaks the `=== undefined` check (regressed
 * delete-sentinel #1112). The `void 0` expression is the precise, narrow signal
 * for the acorn evolving-local idiom.
 *
 * (#3033) SECOND arm — a member read off a DYNAMIC (externref) receiver whose
 * static type collapses to `undefined`. compiled-acorn's `pp$5.parseIdentNode`
 * does `var ty = this.type` where `this` is the Parser fnctor instance
 * (externref) but the checker — unable to resolve the untyped `this`'s shape —
 * types `this.type` as pure `undefined`. `resolveWasmType(undefined)` is a
 * numeric (i32) slot, so the RUNTIME value (a TokenType read dynamically through
 * `__extern_get`, returned as externref) was truncated to the i32
 * undefined-sentinel on store → `ty` read back `undefined`, and `x.var` (any
 * `<expr>.<keyword>` property name) threw. The read goes through the dynamic
 * host path (receiver externref) and returns externref, so the slot must be
 * externref to hold it. Distinguished from the #1112 sentinel case by the
 * receiver's wasm type: an optional field off a KNOWN struct receiver resolves
 * to `ref $struct` (NOT externref), so this arm does not fire for it and the
 * numeric sentinel is preserved. An externref slot holding a genuine runtime
 * `undefined` still compares `=== undefined` (the `emitUndefined` singleton), so
 * a dynamic read that really is undefined is unaffected.
 */
export function varBindingNeedsExternrefForUndefined(
  decl: ts.VariableDeclaration | undefined,
  ctx?: CodegenContext,
): boolean {
  // `var x = (void 0)` / `var x = void <expr>` — strip parens to find the void.
  let init = decl?.initializer;
  while (init && ts.isParenthesizedExpression(init)) init = init.expression;
  if (init === undefined) return false;
  if (ts.isVoidExpression(init)) return true;
  // (#3033) Dynamic-receiver member read whose static type is purely undefined.
  if (ctx !== undefined && (ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init))) {
    const declType = ctx.checker.getTypeAtLocation(decl!);
    const isPurelyUndefinedOrVoid = (declType.flags & ~(ts.TypeFlags.Undefined | ts.TypeFlags.Void)) === 0;
    if (isPurelyUndefinedOrVoid && undefinedTypedMemberReadProducesExternref(ctx, init)) return true;
  }
  return false;
}

/**
 * (#3033 Bug 2a/2b) Shared predicate: a property/element access whose STATIC
 * type is purely `undefined`/`void` — the checker could not resolve the member
 * (untyped `this` receiver in a prototype-function, heterogeneous shapes, …) —
 * but whose RECEIVER produces an externref at runtime is a DYNAMIC member
 * read: its runtime value is externref, NOT the numeric undefined-sentinel
 * `resolveWasmType(undefined)` would give it. Recursive, so a CHAINED read
 * (`this.type.keyword` — Bug 2b) is recognized: the receiver `this.type` is
 * itself such a read. Used by BOTH the var/let slot typing
 * (`varBindingNeedsExternrefForUndefined`, Bug 2a) and the property-access
 * dynamic-receiver admission (`compilePropertyAccess` isExternObj, Bug 2b) so
 * the two stay in lockstep — no parallel branch.
 */
export function undefinedTypedMemberReadProducesExternref(ctx: CodegenContext, expr: ts.Expression): boolean {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return false;
  const t = ctx.checker.getTypeAtLocation(e);
  if ((t.flags & ~(ts.TypeFlags.Undefined | ts.TypeFlags.Void)) !== 0) return false;
  const recvType = ctx.checker.getTypeAtLocation(e.expression);
  if (resolveWasmType(ctx, recvType).kind === "externref") return true;
  return undefinedTypedMemberReadProducesExternref(ctx, e.expression);
}

export function hoistVarDeclarations(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | ts.Statement[],
): void {
  for (const stmt of stmts) {
    walkStmtForVars(ctx, fctx, stmt);
  }
}

/**
 * Walk a binding pattern and hoist all bound identifiers as locals.
 * Handles nested patterns: var { a, b: { c } } = obj; var [x, [y, z]] = arr;
 */
function hoistBindingPattern(ctx: CodegenContext, fctx: FunctionContext, pattern: ts.BindingPattern): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      const name = element.name.text;
      if (fctx.localMap.has(name)) continue;
      // #1690b: do NOT skip allocation when the name collides with a module
      // global. This hoister only runs for nested function bodies; a `var`
      // declared anywhere inside a function must shadow any module-level
      // binding with the same name (ECMA-262 §10.2.10). Skipping left the
      // identifier resolver falling through to `global.get/set $__mod_<name>`,
      // so the inner destructured var aliased the module global.
      const elemType = ctx.checker.getTypeAtLocation(element);
      const wasmType = resolveWasmType(ctx, elemType);
      const localIdx = allocLocal(fctx, name, wasmType);
      // Hoisted vars should be `undefined`, not `null` (#737)
      if (wasmType.kind === "externref") {
        emitUndefined(ctx, fctx);
        fctx.body.push({ op: "local.set", index: localIdx });
      }
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      hoistBindingPattern(ctx, fctx, element.name);
    }
  }
}

/**
 * Allocate TDZ flags for a let/const destructuring binding pattern so that
 * `let { x = x } = {}` and similar self/forward references in default
 * initializers throw ReferenceError per ECMA-262 §13.3.3.7 (#1128).
 *
 * Called from `compileObjectDestructuring` / `compileArrayDestructuring` at
 * entry — BEFORE the binding-element loop allocates the actual binding locals.
 * Only the TDZ flag is allocated here; the destructuring's own `allocLocal`
 * for the binding runs later (line ~648 of destructuring.ts) and registers
 * the binding name in `localMap`. By the time the default initializer is
 * compiled (after that `allocLocal`), `compileIdentifier` will see both
 * `localMap.has(name)` and `tdzFlagLocals.get(name)` and apply the TDZ check.
 *
 * The TDZ flag is allocated unconditionally for destructured bindings —
 * +1 i32 local per binding is cheap, and unconditionality avoids subtle
 * static-analysis gaps inside default initializers where `analyzeTdzAccess`
 * could otherwise mis-classify the access as "skip".
 */
export function ensureLetConstBindingPatternTdzFlags(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.BindingPattern,
): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      const name = element.name.text;
      // #1690b: do NOT skip when the name collides with a module global. This
      // runs only for nested function bodies, where a `let`/`const`
      // destructuring binding must shadow any module-level binding of the same
      // name (and carry its own TDZ flag) rather than aliasing the global.
      // Allocate the binding local up front if missing — needed so that when
      // a default initializer for a SIBLING binding compiles its expression,
      // a forward-reference to this binding (e.g. `let { a = b, b } = {}`)
      // resolves via `localMap.get(name)` and the TDZ check fires. Without
      // this, the forward-ref `b` falls through to the "undeclared globals"
      // path and silently returns a default value instead of throwing.
      if (!fctx.localMap.has(name)) {
        const elemType = ctx.checker.getTypeAtLocation(element);
        const wasmType = resolveWasmType(ctx, elemType);
        allocLocal(fctx, name, wasmType);
      }
      // Allocate TDZ flag if missing — zero-init (uninitialized).
      if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
      if (!fctx.tdzFlagLocals.has(name)) {
        const flagIdx = allocLocal(fctx, `__tdz_${name}`, { kind: "i32" });
        fctx.tdzFlagLocals.set(name, flagIdx);
      }
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      ensureLetConstBindingPatternTdzFlags(ctx, fctx, element.name);
    }
  }
}

/** Hoist a single variable declaration (handles both simple identifiers and binding patterns). */
function hoistVarDecl(ctx: CodegenContext, fctx: FunctionContext, decl: ts.VariableDeclaration): void {
  if (ts.isIdentifier(decl.name)) {
    const name = decl.name.text;
    if (fctx.localMap.has(name)) return;
    // #1690b: do NOT skip allocation when the name collides with a module
    // global. This hoister only runs for nested function bodies; per JS var
    // hoisting (ECMA-262 §10.2.10) a `var x` inside a function must allocate a
    // function-local that shadows any module-level `x`. The previous skip left
    // the resolver aliasing `global.get/set $__mod_x` for every read/write of
    // the inner `x`, so the function mutated the module global instead.
    const varType = ctx.checker.getTypeAtLocation(decl);
    // (#1239 / #1433) Object literals carrying get/set accessor declarations,
    // or `[Symbol.dispose]` / `[Symbol.asyncDispose]` computed methods, are
    // routed through the JS-host plain-object (externref) path. The local
    // must be allocated as externref so subsequent property reads/writes
    // bind to the host object, not a struct slot. Tag the var here so
    // resolveStructNameForExpr sees the override at every later access.
    let initForcesExternref = false;
    if (decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
      for (const p of decl.initializer.properties) {
        if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
          initForcesExternref = true;
          break;
        }
        if (ts.isMethodDeclaration(p) && ts.isComputedPropertyName(p.name)) {
          const inner = p.name.expression;
          if (
            ts.isPropertyAccessExpression(inner) &&
            ts.isIdentifier(inner.expression) &&
            inner.expression.text === "Symbol" &&
            (inner.name.text === "dispose" || inner.name.text === "asyncDispose")
          ) {
            initForcesExternref = true;
            break;
          }
        }
      }
      // (#2804) A spread-containing object literal in a NON-SPECIFIC context
      // (no concrete contextual struct type — e.g. `var b = { ...a, z: 3 }`)
      // takes the host plain-object path (compileObjectLiteralWithAccessors),
      // building an externref `$Object`, NOT the closed struct TS infers. The
      // hoisted slot must be externref to match (else the value is ref.cast to
      // the inferred struct → read NaN/null). Mirrors the let/const path in
      // statements/variables.ts (objectLiteralSpreadTakesHostPath); inlined here
      // to avoid an index↔literals import cycle.
      if (!initForcesExternref && decl.initializer.properties.some((p) => ts.isSpreadAssignment(p))) {
        const spreadCtxType = ctx.checker.getContextualType(decl.initializer);
        const nonSpecificCtx =
          !spreadCtxType ||
          (spreadCtxType.flags & ts.TypeFlags.Any) !== 0 ||
          (spreadCtxType.flags & ts.TypeFlags.Unknown) !== 0 ||
          (spreadCtxType.flags & ts.TypeFlags.NonPrimitive) !== 0 ||
          spreadCtxType.getProperties().length === 0;
        if (nonSpecificCtx) initForcesExternref = true;
      }
    }
    // (#684) Usage-narrowed f64 override for a boxed-`any` var — computed
    // separately so the entry-init below can seed NaN (see next comment).
    const usageF64 = initForcesExternref ? null : usageInferredLocalType(ctx, decl);
    const wasmType: ValType =
      initForcesExternref || isNullablePrimitiveType(varType) || varBindingNeedsExternrefForUndefined(decl, ctx)
        ? { kind: "externref" as const }
        : (usageF64 ?? resolveWasmType(ctx, varType));
    if (initForcesExternref) ctx.externrefAccessorVars.add(name);
    const localIdx = allocLocal(fctx, name, wasmType);
    // (#684) A hoisted `var` is `undefined` from function entry; when narrowed
    // to an f64 slot its entry value must be `ToNumber(undefined) === NaN`, NOT
    // the wasm default 0 — otherwise a read before the `var x = …`/`x = …`
    // assignment (JS var-hoisting) would observe 0 instead of NaN. Seed NaN at
    // entry, symmetric with the externref `emitUndefined` below.
    if (usageF64 && wasmType.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: NaN });
      fctx.body.push({ op: "local.set", index: localIdx });
      return;
    }
    // In JS, hoisted `var` variables are `undefined` before their declaration,
    // not `null`. For externref locals, emit __get_undefined() + local.set (#737).
    if (wasmType.kind === "externref") {
      // (#2106 S1 / PR-2) Under the `undefinedSingleton` regime `emitUndefined`
      // produces the NON-null tag-1 `$undefined` singleton. If this var's
      // declaration will retype the slot from externref to a concrete non-any
      // ref (standalone RegExp match array — the sole externref → ref hoist
      // retype), the later `local-set-coerce` fixup would `ref.cast_null`-trap on
      // that singleton ("illegal cast", the dominant flip-ON RegExp cluster). A
      // concrete-ref slot cannot represent the singleton anyway, so emit the
      // flag-OFF `ref.null.extern` value — it casts cleanly to `ref.null N`.
      // Byte-inert flag-OFF (the guard is false unless the regime is active).
      if (undefinedSingletonActive(ctx) && hoistedVarRetypesToConcreteRef(ctx, decl)) {
        fctx.body.push({ op: "ref.null.extern" });
      } else {
        emitUndefined(ctx, fctx);
      }
      fctx.body.push({ op: "local.set", index: localIdx });
    }
    return;
  }
  // Handle destructuring patterns: var { x, y } = obj; var [a, b] = arr;
  if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
    hoistBindingPattern(ctx, fctx, decl.name);
  }
}

function walkStmtForVars(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement): void {
  if (ts.isVariableStatement(stmt)) {
    const list = stmt.declarationList;
    // Only hoist `var` (not let/const/using/await-using). #1177
    if (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) return;
    for (const decl of list.declarations) {
      hoistVarDecl(ctx, fctx, decl);
    }
    return;
  }
  if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) walkStmtForVars(ctx, fctx, s);
    return;
  }
  if (ts.isIfStatement(stmt)) {
    walkStmtForVars(ctx, fctx, stmt.thenStatement);
    if (stmt.elseStatement) walkStmtForVars(ctx, fctx, stmt.elseStatement);
    return;
  }
  if (ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isForStatement(stmt)) {
    if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
      const list = stmt.initializer;
      if (!(list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
        for (const decl of list.declarations) {
          hoistVarDecl(ctx, fctx, decl);
        }
      }
    }
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)) {
    // Hoist the loop variable for `for (var x in obj)` / `for (var x of arr)`
    if (stmt.initializer && ts.isVariableDeclarationList(stmt.initializer)) {
      const list = stmt.initializer;
      if (!(list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
        for (const decl of list.declarations) {
          hoistVarDecl(ctx, fctx, decl);
        }
      }
    }
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isLabeledStatement(stmt)) {
    walkStmtForVars(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isTryStatement(stmt)) {
    for (const s of stmt.tryBlock.statements) walkStmtForVars(ctx, fctx, s);
    if (stmt.catchClause) {
      for (const s of stmt.catchClause.block.statements) walkStmtForVars(ctx, fctx, s);
    }
    if (stmt.finallyBlock) {
      for (const s of stmt.finallyBlock.statements) walkStmtForVars(ctx, fctx, s);
    }
    return;
  }
  if (ts.isSwitchStatement(stmt)) {
    for (const clause of stmt.caseBlock.clauses) {
      for (const s of clause.statements) walkStmtForVars(ctx, fctx, s);
    }
  }
}

/**
 * Pre-pass: hoist all `let`/`const` declarations in a function body with TDZ flags.
 * Unlike var-hoisting (which makes variables immediately accessible), let/const
 * hoisting only pre-allocates the local + a TDZ flag so nested functions can
 * capture the variable. The variable is still in TDZ until the declaration runs.
 */
export function hoistLetConstWithTdz(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | ts.Statement[],
): void {
  for (const stmt of stmts) {
    walkStmtForLetConst(ctx, fctx, stmt);
  }
}

/**
 * Check if a let/const variable needs a TDZ flag by analyzing all references.
 * Returns false if every access to the symbol is provably after the declaration
 * in straight-line code (same function, no closures, loop-local safe).
 */
export function needsTdzFlag(ctx: CodegenContext, decl: ts.VariableDeclaration): boolean {
  const symbol = ctx.checker.getSymbolAtLocation(decl.name);
  if (!symbol) return true;
  const declEnd = decl.getEnd();
  const declFunc = getContainingFunctionForTdz(decl);

  // Collect all references to this symbol in the containing function
  // We walk the function body checking every identifier that resolves to this symbol
  const funcBody = declFunc && "body" in declFunc ? (declFunc as any).body : undefined;
  const scope = funcBody || decl.getSourceFile();

  let needsFlag = false;
  function visit(node: ts.Node): void {
    if (needsFlag) return;
    if (ts.isIdentifier(node) && node !== decl.name) {
      const sym = ctx.checker.getSymbolAtLocation(node);
      if (sym === symbol) {
        const accessPos = node.getStart();
        const accessFunc = getContainingFunctionForTdz(node);
        // Cross-function access (closure) — needs flag
        if (accessFunc !== declFunc) {
          needsFlag = true;
          return;
        }
        // Access before declaration — needs flag
        if (accessPos < declEnd) {
          needsFlag = true;
          return;
        }
        // Check loop safety: if access is inside a loop containing the decl,
        // it's only safe if decl is in the loop body and access is after decl
        if (isInsideLoopContainingForTdz(node, decl)) {
          needsFlag = true;
          return;
        }
      }
    }
    // Don't recurse into nested functions (they have their own scope)
    if (
      node !== scope &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node))
    ) {
      // But DO check if they reference our symbol (closure capture)
      forEachChild(node, visit);
      return;
    }
    forEachChild(node, visit);
  }
  forEachChild(scope, visit);
  return needsFlag;
}

/** Walk up to find nearest containing function (TDZ analysis version for index.ts). */
function getContainingFunctionForTdz(node: ts.Node): ts.Node | undefined {
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

/** Check if access is inside a loop containing decl (TDZ version for index.ts). */
function isInsideLoopContainingForTdz(access: ts.Node, decl: ts.Node): boolean {
  let current = access.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isSourceFile(current)
    ) {
      return false;
    }
    if (
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isWhileStatement(current) ||
      ts.isDoStatement(current)
    ) {
      if (isDescendantOfNode(decl, current)) {
        // For-initializer variables (e.g. `for (let i = 0; ...)`) are always
        // initialized before the body/condition/incrementor execute
        if (ts.isForStatement(current) && current.initializer && isDescendantOfNode(decl, current.initializer)) {
          return false;
        }
        // For-in/for-of loop variables are initialized each iteration
        if (
          (ts.isForInStatement(current) || ts.isForOfStatement(current)) &&
          isDescendantOfNode(decl, current.initializer)
        ) {
          return false;
        }
        // Both in loop — check if decl is in loop body and access after decl
        const body = getLoopBodyNode(current);
        if (body && isDescendantOfNode(decl, body) && access.getStart() >= decl.getEnd()) {
          return false; // loop-local, access after decl — safe per iteration
        }
        return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function isDescendantOfNode(node: ts.Node, ancestor: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function getLoopBodyNode(loop: ts.Node): ts.Node | undefined {
  if (ts.isForStatement(loop)) return loop.statement;
  if (ts.isForInStatement(loop)) return loop.statement;
  if (ts.isForOfStatement(loop)) return loop.statement;
  if (ts.isWhileStatement(loop)) return loop.statement;
  if (ts.isDoStatement(loop)) return loop.statement;
  return undefined;
}

function isVecStructType(ctx: CodegenContext, type: ValType | undefined): type is ValType & { typeIdx: number } {
  if (!type || (type.kind !== "ref" && type.kind !== "ref_null")) return false;
  const def = ctx.mod.types[type.typeIdx];
  return def?.kind === "struct" && def.fields[0]?.name === "length" && def.fields[1]?.name === "data";
}

function stripRegExpInferenceWrapper(expr: ts.Expression): ts.Expression {
  while (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = (
      expr as
        | ts.ParenthesizedExpression
        | ts.AsExpression
        | ts.TypeAssertion
        | ts.SatisfiesExpression
        | ts.NonNullExpression
    ).expression;
  }
  return expr;
}

function isStaticRegExpExpressionForInference(ctx: CodegenContext, expr: ts.Expression): boolean {
  const unwrapped = stripRegExpInferenceWrapper(expr);
  if (unwrapped.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
  if (ts.isNewExpression(unwrapped) || (ts.isCallExpression(unwrapped) && !unwrapped.questionDotToken)) {
    const callee = stripRegExpInferenceWrapper(unwrapped.expression);
    return ts.isIdentifier(callee) && callee.text === "RegExp";
  }
  if (ts.isIdentifier(unwrapped)) {
    const sym = ctx.checker.getSymbolAtLocation(unwrapped);
    const decl = sym?.getDeclarations()?.find((d) => ts.isVariableDeclaration(d)) as ts.VariableDeclaration | undefined;
    return decl?.initializer !== undefined && isStaticRegExpExpressionForInference(ctx, decl.initializer);
  }
  return false;
}

function nativeStringVecTypeForStandaloneRegExp(ctx: CodegenContext): ValType | null {
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return null;
  // The match result is the match-vec SUBTYPE of the nstr vec (#1914) — the
  // precise local type keeps `.index`/`.input` reads cast-free while every
  // base-vec consumer still applies via subsumption.
  const vecTypeIdx = ensureRegexMatchVecType(ctx);
  return { kind: "ref_null", typeIdx: vecTypeIdx };
}

/** True for the computed key `Symbol.match` (the @@match well-known symbol). */
function isSymbolMatchKeyForInference(arg: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(arg) &&
    ts.isIdentifier(arg.expression) &&
    arg.expression.text === "Symbol" &&
    arg.name.text === "match"
  );
}

function inferStandaloneRegExpMatchArrayType(
  ctx: CodegenContext,
  initializer: ts.Expression | undefined,
): ValType | null {
  if (!ctx.standalone || !initializer) return null;
  const unwrapped = stripRegExpInferenceWrapper(initializer);
  if (!ts.isCallExpression(unwrapped)) return null;
  if (ts.isPropertyAccessExpression(unwrapped.expression)) {
    const method = unwrapped.expression.name.text;
    if (method === "exec") {
      return isStaticRegExpExpressionForInference(ctx, unwrapped.expression.expression)
        ? nativeStringVecTypeForStandaloneRegExp(ctx)
        : null;
    }
    if (method === "match" && unwrapped.arguments.length === 1) {
      return isStaticRegExpExpressionForInference(ctx, unwrapped.arguments[0]!)
        ? nativeStringVecTypeForStandaloneRegExp(ctx)
        : null;
    }
    return null;
  }
  // `re[Symbol.match](s)` (#2161) — symbol-protocol dual of `s.match(re)`.
  if (ts.isElementAccessExpression(unwrapped.expression)) {
    const elem = unwrapped.expression;
    if (isSymbolMatchKeyForInference(elem.argumentExpression) && unwrapped.arguments.length === 1) {
      return isStaticRegExpExpressionForInference(ctx, elem.expression)
        ? nativeStringVecTypeForStandaloneRegExp(ctx)
        : null;
    }
  }
  return null;
}

function isStaticRegExpMatchArrayCallForImportScan(ctx: CodegenContext, call: ts.CallExpression): boolean {
  const callee = stripRegExpInferenceWrapper(call.expression);
  if (ts.isPropertyAccessExpression(callee)) {
    const method = callee.name.text;
    if (method === "exec") return isStaticRegExpExpressionForInference(ctx, callee.expression);
    if (method === "match" && call.arguments.length === 1) {
      return isStaticRegExpExpressionForInference(ctx, call.arguments[0]!);
    }
    return false;
  }
  // `re[Symbol.match](s)` (#2161) — symbol-protocol dual of `s.match(re)`.
  if (ts.isElementAccessExpression(callee)) {
    if (isSymbolMatchKeyForInference(callee.argumentExpression) && call.arguments.length === 1) {
      return isStaticRegExpExpressionForInference(ctx, callee.expression);
    }
  }
  return false;
}

export function isStandaloneRegExpMatchArrayValue(ctx: CodegenContext, expr: ts.Expression): boolean {
  const unwrapped = stripRegExpInferenceWrapper(expr);
  if (ts.isCallExpression(unwrapped)) return isStaticRegExpMatchArrayCallForImportScan(ctx, unwrapped);
  if (!ts.isIdentifier(unwrapped)) return false;
  const sym = ctx.checker.getSymbolAtLocation(unwrapped);
  const decl = sym?.getDeclarations()?.find((d) => ts.isVariableDeclaration(d)) as ts.VariableDeclaration | undefined;
  const initializer = decl?.initializer ? stripRegExpInferenceWrapper(decl.initializer) : undefined;
  return initializer !== undefined && ts.isCallExpression(initializer)
    ? isStaticRegExpMatchArrayCallForImportScan(ctx, initializer)
    : false;
}

function inferLetConstInitializerWasmType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  initializer: ts.Expression | undefined,
): ValType | null {
  if (!initializer) return null;
  const standaloneRegExpMatchArrayType = inferStandaloneRegExpMatchArrayType(ctx, initializer);
  if (standaloneRegExpMatchArrayType !== null) return standaloneRegExpMatchArrayType;

  const unwrapped = stripRegExpInferenceWrapper(initializer);
  if (!ts.isCallExpression(unwrapped) || !ts.isPropertyAccessExpression(unwrapped.expression)) {
    return null;
  }

  const methodName = unwrapped.expression.name.text;
  if (methodName !== "subarray" && methodName !== "slice") return null;

  const receiver = unwrapped.expression.expression;
  let receiverType: ValType | undefined;
  if (ts.isIdentifier(receiver)) {
    const localIdx = fctx.localMap.get(receiver.text);
    if (localIdx !== undefined) receiverType = getLocalType(fctx, localIdx);
    else {
      const globalIdx = ctx.moduleGlobals.get(receiver.text);
      if (globalIdx !== undefined) receiverType = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)]?.type;
    }
  }
  receiverType ??= resolveWasmType(ctx, ctx.checker.getTypeAtLocation(receiver));
  if (!isVecStructType(ctx, receiverType)) return null;
  // (#2357/#47) Standalone `subarray` produces a `$__subview` that shares the
  // parent's backing array (true aliasing). Resolving the binding to the subview
  // type here is what makes element access pick the windowed lowering at COMPILE
  // time (so plain-array `a[i]` stays zero-cost). `slice` still returns an
  // independent copy (a plain vec). The receiver may itself be a subview (nested
  // subarray) — its element kind is recovered from the base vec.
  if (methodName === "subarray" && (ctx.standalone || ctx.wasi)) {
    const recvIdx = (receiverType as { typeIdx: number }).typeIdx;
    // elemKind from the receiver's struct name: `__vec_<elem>` (plain typed array)
    // or `__subview_<elem>` (nested subarray over a subview).
    const recvName = ctx.typeIdxToStructName.get(recvIdx);
    const elemKind = recvName?.replace(/^__vec_/, "").replace(/^__subview_/, "");
    if (elemKind !== undefined && elemKind !== recvName) {
      const svIdx = getOrRegisterSubviewType(ctx, elemKind);
      return { kind: "ref_null", typeIdx: svIdx };
    }
  }
  return { kind: "ref_null", typeIdx: receiverType.typeIdx };
}

/**
 * (#3123) When `varType` names a fnctor-subclass class (`class C extends F`,
 * F a top-level plain function), return the compiled class name; else
 * undefined. Class-expression synthetic names resolve through
 * `classExprNameMap` like the method-call ladder does.
 */
function fnctorSubclassNameOfType(ctx: CodegenContext, varType: ts.Type): string | undefined {
  let clsName = varType.getSymbol()?.name;
  if (clsName !== undefined && !ctx.classSet.has(clsName)) {
    clsName = ctx.classExprNameMap.get(clsName) ?? clsName;
  }
  if (clsName === undefined || !ctx.classSet.has(clsName)) return undefined;
  return fnctorAncestorOfClass(ctx, clsName) !== undefined ? clsName : undefined;
}

/**
 * (#3123) True when the let-binding `decl` (named `name`, declared as class
 * `clsName`) is re-assigned somewhere in its containing FUNCTION with a RHS
 * whose declared type is NOT that class — i.e. the slot can hold a foreign
 * (usually host-object) value at runtime. Oracle-based (#1930): the RHS type
 * name comes from `ctx.oracle.declaredNameOf`. Name-matched but scoped to the
 * SAME function (nested function bodies are not descended), so an inner
 * function's same-named binding cannot false-positive; same-function shadows
 * are already excluded by the pre-hoist caller (`localMap.has(name)` skip).
 */
function bindingHasForeignReassignment(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
  name: string,
  clsName: string,
): boolean {
  const declFunc = getContainingFunctionForTdz(decl);
  const funcBody = declFunc && "body" in declFunc ? (declFunc as { body?: ts.Node }).body : undefined;
  const scope = funcBody ?? decl.getSourceFile();
  let foreign = false;
  const visit = (node: ts.Node): void => {
    if (foreign) return;
    // Do not descend into nested functions — their own `name` bindings are a
    // different variable (and a capture-reassignment of the outer binding is
    // out of this analysis' scope; the static-dispatch skip must not widen on
    // it because dynamic dispatch only covers the kind-export surface).
    if (
      node !== scope &&
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) ||
        ts.isConstructorDeclaration(node))
    ) {
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name &&
      node.left !== decl.name
    ) {
      let rhsName = ctx.oracle.declaredNameOf(node.right);
      if (rhsName !== undefined && !ctx.classSet.has(rhsName)) {
        rhsName = ctx.classExprNameMap.get(rhsName) ?? rhsName;
      }
      if (rhsName !== clsName) {
        foreign = true;
        return;
      }
    }
    forEachChild(node, visit);
  };
  if (scope) forEachChild(scope, visit);
  return foreign;
}

function walkStmtForLetConst(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.Statement): void {
  if (ts.isVariableStatement(stmt)) {
    const list = stmt.declarationList;
    // Hoist `let`/`const`/`using` (not var — var is already hoisted).
    // `using`/`await using` declarations have the same TDZ semantics as
    // let/const per the explicit-resource-management spec — pre-decl access
    // must throw ReferenceError. (#1177)
    const TDZ_FLAGS = ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing;
    if (!(list.flags & TDZ_FLAGS)) return;
    for (const decl of list.declarations) {
      // #1210: skip declarations matched by detectStringBuilders — their
      // storage is replaced by a synthetic buffer triple at compile time.
      if (fctx.pendingStringBuilders?.has(decl)) continue;
      // #1886 Slice B: skip linear-backed `new Uint8Array(...)` bindings — their
      // storage is a synthetic (ptr,len) i32 pair set up at the declaration site
      // (see tryEmitLinearU8New), and the name is intentionally kept out of
      // localMap so reads route through `fctx.linearU8Buffers`. Pre-allocating a
      // GC `(ref null …)` local here would leave a dangling uninitialised local
      // (which the function finalizer then treats as a live value).
      if (
        ctx.linearUint8 &&
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        ts.isNewExpression(decl.initializer) &&
        ts.isIdentifier(decl.initializer.expression) &&
        decl.initializer.expression.text === "Uint8Array"
      ) {
        const sym = ctx.checker.getSymbolAtLocation(decl.name);
        if (sym && ctx.linearUint8.safeBindings.has(sym) && isLinearU8RepresentableNew(ctx, decl.initializer)) {
          continue;
        }
      }
      if (ts.isIdentifier(decl.name)) {
        const name = decl.name.text;
        if (fctx.localMap.has(name)) continue;
        // #2641: do NOT skip names that collide with a module global. A
        // function-body let/const that shadows a same-named module variable
        // MUST get its own Wasm local (proper lexical shadowing). Previously
        // this `continue` suppressed the shadow, so every read/write of the
        // local fell through to the module global of the same name — invalid
        // Wasm with mismatched types (string-tree value → class-struct global,
        // the #2641 symptom) and a silent miscompilation (module var clobbered)
        // with matching types. This walker runs ONLY for real function bodies
        // (free functions and, after #2641, class methods/ctors); __module_init
        // does NOT run it, so top-level let/const still become module globals.
        const varType = ctx.checker.getTypeAtLocation(decl);
        // #1120: pre-allocate as i32 if collectI32CoercedLocals tagged this
        // local — keeps the hoisted slot in sync with what compileVariableStatement
        // will use, avoiding a slot-type mismatch on first assignment.
        const isI32Coerced =
          fctx.i32CoercedLocals?.has(name) === true && (varType.flags & ts.TypeFlags.NumberLike) !== 0;
        // (#1239) If the initializer is an object literal carrying get/set
        // accessor declarations, the variable holds a JS host object
        // (externref) — never the inferred wasmGC struct type. Tag here
        // BEFORE allocating the slot so the hoisted local type matches
        // what compileObjectLiteralWithAccessors will emit, and so
        // resolveStructNameForExpr lookups against this var bail out
        // immediately even from accesses earlier in compilation order.
        const initIsAccessorLiteral =
          decl.initializer !== undefined &&
          ts.isObjectLiteralExpression(decl.initializer) &&
          decl.initializer.properties.some((p) => ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p));
        // (#2804) A spread-containing object literal in a NON-SPECIFIC context
        // (no concrete contextual struct type — e.g. `const b = { ...a, z: 3 }`)
        // is built as a host `$Object` (externref) by the literals.ts routing,
        // NOT the closed struct TS infers for the variable. This pre-hoist
        // allocator is the AUTHORITATIVE slot-typer for let/const (it runs
        // before compileVariableStatement), so the externref override MUST be
        // applied here too — otherwise the slot is the inferred struct and the
        // initializer's externref is ref.cast to it at runtime (cast fails →
        // `b.x` reads NaN/null). Mirrors statements/variables.ts; inlined to
        // avoid an index↔literals import cycle.
        let initIsHostSpreadLiteral = false;
        if (
          !initIsAccessorLiteral &&
          decl.initializer !== undefined &&
          ts.isObjectLiteralExpression(decl.initializer) &&
          decl.initializer.properties.some((p) => ts.isSpreadAssignment(p))
        ) {
          const spreadCtxType = ctx.checker.getContextualType(decl.initializer);
          initIsHostSpreadLiteral =
            !spreadCtxType ||
            (spreadCtxType.flags & ts.TypeFlags.Any) !== 0 ||
            (spreadCtxType.flags & ts.TypeFlags.Unknown) !== 0 ||
            (spreadCtxType.flags & ts.TypeFlags.NonPrimitive) !== 0 ||
            spreadCtxType.getProperties().length === 0;
        }
        if (initIsAccessorLiteral || initIsHostSpreadLiteral) {
          ctx.externrefAccessorVars.add(name);
        }
        let wasmType: ValType =
          initIsAccessorLiteral || initIsHostSpreadLiteral
            ? { kind: "externref" }
            : isI32Coerced
              ? { kind: "i32" }
              : isNullablePrimitiveType(varType)
                ? { kind: "externref" }
                : (inferLetConstInitializerWasmType(ctx, fctx, decl.initializer) ??
                  usageInferredLocalType(ctx, decl) ??
                  resolveWasmType(ctx, varType));
        // (#3123) A let-binding declared as a FNCTOR-SUBCLASS class instance
        // (`class C extends F`, F a top-level plain function) that is
        // REASSIGNED with another static type can hold a HOST object at
        // runtime (`iterator = iterator.drop(0)` — the Iterator-helper
        // wrapper minted by F's live prototype methods). A `(ref $C)` slot
        // would NULL that host value through the guarded cast — widen the
        // slot to externref and record the name so the method-call ladder
        // dispatches on it dynamically. Host lane only (standalone has no
        // host objects to hold). Typed use sites still recover the struct
        // through their own guarded casts, so a never-host value is
        // unaffected beyond the extra cast.
        if (
          (wasmType.kind === "ref" || wasmType.kind === "ref_null") &&
          !ctx.standalone &&
          !ctx.wasi &&
          (list.flags & ts.NodeFlags.Let) !== 0
        ) {
          const fnctorCls = fnctorSubclassNameOfType(ctx, varType);
          if (fnctorCls !== undefined && bindingHasForeignReassignment(ctx, decl, name, fnctorCls)) {
            wasmType = { kind: "externref" };
            (fctx.fnctorWidenedLocals ??= new Set()).add(name);
          }
        }
        const valueSlot = allocLocal(fctx, name, wasmType);
        // (#2814) Record the pre-hoisted slot for THIS declaration so
        // compileVariableStatement can reuse it when saveBlockScopedShadows later
        // deletes the block-let's own slot (the duplicate-local desync — Bug C).
        // Recorded only here, i.e. only for names the pre-pass actually allocated
        // (absent from localMap ⇒ no outer/param/var shadow). Genuine shadows are
        // skipped above (the `localMap.has(name)` continue) and never recorded.
        if (!fctx.preHoistedLetConstSlots) fctx.preHoistedLetConstSlots = new Map();
        const preHoistRecord: { valueSlot: number; flagSlot?: number } = { valueSlot };
        fctx.preHoistedLetConstSlots.set(decl, preHoistRecord);
        // Only add TDZ flag if static analysis can't prove all accesses are safe
        if (needsTdzFlag(ctx, decl)) {
          if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
          const flagIdx = allocLocal(fctx, `__tdz_${name}`, { kind: "i32" });
          fctx.tdzFlagLocals.set(name, flagIdx);
          preHoistRecord.flagSlot = flagIdx;
        }
      }
      // Destructuring patterns (let/const) are NOT pre-allocated here —
      // `compileObjectDestructuring` / `compileArrayDestructuring` allocate
      // their own bindings + TDZ flags via `ensureLetConstBindingPatternTdzFlags`
      // at entry. Pre-allocating here would create duplicate locals (one from
      // the pre-pass, one from destructuring) and pollute closure-capture
      // analysis (#1128).
    }
    return;
  }
  // Recurse into block-like structures (but NOT into nested functions)
  if (ts.isBlock(stmt)) {
    for (const s of stmt.statements) walkStmtForLetConst(ctx, fctx, s);
    return;
  }
  if (ts.isIfStatement(stmt)) {
    walkStmtForLetConst(ctx, fctx, stmt.thenStatement);
    if (stmt.elseStatement) walkStmtForLetConst(ctx, fctx, stmt.elseStatement);
    return;
  }
  if (ts.isForStatement(stmt)) {
    // Do NOT pre-allocate for-loop let/const initializer variables here.
    // compileForStatement handles their allocation with correct types (e.g. i32
    // for integer loop counters). Pre-allocating here would create duplicate
    // locals: one f64 from the pre-pass, one i32 from codegen — see #954.
    // The loop body may still declare let/const variables, so recurse into it.
    walkStmtForLetConst(ctx, fctx, stmt.statement);
    return;
  }
  if (ts.isTryStatement(stmt)) {
    for (const s of stmt.tryBlock.statements) walkStmtForLetConst(ctx, fctx, s);
    if (stmt.catchClause) {
      for (const s of stmt.catchClause.block.statements) walkStmtForLetConst(ctx, fctx, s);
    }
    if (stmt.finallyBlock) {
      for (const s of stmt.finallyBlock.statements) walkStmtForLetConst(ctx, fctx, s);
    }
    return;
  }
  if (ts.isSwitchStatement(stmt)) {
    for (const clause of stmt.caseBlock.clauses) {
      for (const s of clause.statements) walkStmtForLetConst(ctx, fctx, s);
    }
  }
}

/**
 * Check if a function body references the `arguments` identifier.
 * Skips nested function declarations and function expressions (which have
 * their own `arguments` binding), but traverses into arrow functions
 * because arrows inherit the enclosing function's `arguments`.
 */
export function cacheStringLiterals(ctx: CodegenContext, fctx: FunctionContext): void {
  // Build a set of funcIdx values that correspond to string literal thunks
  const strFuncIdxSet = new Set<number>();
  for (const [, importName] of ctx.stringLiteralMap) {
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx !== undefined) strFuncIdxSet.add(funcIdx);
  }
  if (strFuncIdxSet.size === 0) return;

  // Collect all unique string-thunk funcIdx values used in the body
  const usedFuncIdxs = new Set<number>();
  collectStringCalls(fctx.body, strFuncIdxSet, usedFuncIdxs);
  if (usedFuncIdxs.size === 0) return;

  // Allocate a local for each unique string thunk and build the mapping
  const cacheMap = new Map<number, number>(); // funcIdx → local index
  for (const funcIdx of usedFuncIdxs) {
    const localIdx = allocLocal(fctx, `__cached_str_${funcIdx}`, {
      kind: "externref",
    });
    cacheMap.set(funcIdx, localIdx);
  }

  // Build the cache-loading preamble (call + local.set for each)
  const preamble: Instr[] = [];
  for (const [funcIdx, localIdx] of cacheMap) {
    preamble.push({ op: "call", funcIdx });
    preamble.push({ op: "local.set", index: localIdx });
  }

  // Replace all matching call instructions in the body with local.get
  replaceStringCalls(fctx.body, cacheMap);

  // Prepend the preamble at the start of the body
  fctx.body.unshift(...preamble);
}

/** Recursively scan instructions to find call instructions targeting string thunks. */
function collectStringCalls(instrs: Instr[], strFuncIdxSet: Set<number>, found: Set<number>): void {
  for (const instr of instrs) {
    if ((instr.op === "call" || instr.op === "return_call") && strFuncIdxSet.has(instr.funcIdx)) {
      found.add(instr.funcIdx);
    }
    // Recurse into nested blocks
    if (instr.op === "block" || instr.op === "loop") {
      collectStringCalls(instr.body, strFuncIdxSet, found);
    } else if (instr.op === "if") {
      collectStringCalls(instr.then, strFuncIdxSet, found);
      if (instr.else) collectStringCalls(instr.else, strFuncIdxSet, found);
    } else if (instr.op === "try") {
      collectStringCalls(instr.body, strFuncIdxSet, found);
      for (const c of instr.catches) {
        collectStringCalls(c.body, strFuncIdxSet, found);
      }
      if (instr.catchAll) collectStringCalls(instr.catchAll, strFuncIdxSet, found);
    }
  }
}

/** Recursively replace call instructions matching the cache map with local.get. */
function replaceStringCalls(instrs: Instr[], cacheMap: Map<number, number>): void {
  for (let i = 0; i < instrs.length; i++) {
    const instr = instrs[i]!;
    if ((instr.op === "call" || instr.op === "return_call") && cacheMap.has(instr.funcIdx)) {
      // Replace in-place: swap the call with a local.get
      const localIdx = cacheMap.get(instr.funcIdx)!;
      (instrs as any)[i] = { op: "local.get", index: localIdx };
    }
    // Recurse into nested blocks
    if (instr.op === "block" || instr.op === "loop") {
      replaceStringCalls(instr.body, cacheMap);
    } else if (instr.op === "if") {
      replaceStringCalls(instr.then, cacheMap);
      if (instr.else) replaceStringCalls(instr.else, cacheMap);
    } else if (instr.op === "try") {
      replaceStringCalls(instr.body, cacheMap);
      for (const c of instr.catches) {
        replaceStringCalls(c.body, cacheMap);
      }
      if (instr.catchAll) replaceStringCalls(instr.catchAll, cacheMap);
    }
  }
}

/**
 * Unwrap Generator<T> return type to get the yield element type T.
 * Falls back to externref if the type cannot be unwrapped.
 */
export function unwrapGeneratorYieldType(type: ts.Type, ctx: CodegenContext): ValType {
  const symbol = type.getSymbol();
  if (symbol && symbol.name === "Generator") {
    const typeArgs = ctx.checker.getTypeArguments(type as ts.TypeReference);
    if (typeArgs.length > 0) {
      return resolveWasmType(ctx, typeArgs[0]!);
    }
  }
  // Also check Iterator and IterableIterator
  if (symbol && (symbol.name === "Iterator" || symbol.name === "IterableIterator")) {
    const typeArgs = ctx.checker.getTypeArguments(type as ts.TypeReference);
    if (typeArgs.length > 0) {
      return resolveWasmType(ctx, typeArgs[0]!);
    }
  }
  // Fallback: assume number yield type (most common case)
  return { kind: "f64" };
}

/**
 * Ensure the stack top is an i32 suitable for use as a condition.
 * Handles: f64 (truthy != 0), externref (JS truthiness via __is_truthy), null (push 0).
 */
export function ensureI32Condition(fctx: FunctionContext, condType: ValType | null, ctx?: CodegenContext): void {
  if (ctx) {
    // #1917 — the canonical ToBoolean cascade is now the single coercion engine.
    // (Behaviour-neutral: the engine's rows are transcribed from this body.)
    emitToBoolean(ctx, condType, fctx.body);
    return;
  }
  // No ctx available (a few legacy callers) — keep the ctx-free subset inline:
  // the engine's helper-call arms (__is_truthy / __any_unbox_bool / __str_flatten)
  // need ctx, so without it fall back to the same non-null / scalar handling the
  // old body used in that case.
  if (!condType) {
    fctx.body.push({ op: "i32.const", value: 0 });
    return;
  }
  if (condType.kind === "f64") {
    fctx.body.push({ op: "f64.abs" });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.gt" });
  } else if (condType.kind === "externref" || condType.kind === "ref" || condType.kind === "ref_null") {
    // Fallback: non-null → true (no ctx → no helper imports available).
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.eqz" });
  } else if (condType.kind === "i64") {
    fctx.body.push({ op: "i64.eqz" });
    fctx.body.push({ op: "i32.eqz" });
  }
  // i32 is already valid as-is
}

export { popBody, pushBody } from "./context/bodies.js";
export { createCodegenContext } from "./context/create-context.js";
export { reportError } from "./context/errors.js";
export { allocLocal, allocTempLocal, getLocalType, releaseTempLocal } from "./context/locals.js";
export { attachSourcePos, getSourcePos } from "./context/source-pos.js";
export type {
  ClosureInfo,
  CodegenContext,
  CodegenOptions,
  CodegenResult,
  ExternClassInfo,
  FunctionContext,
  InlinableFunctionInfo,
  OptionalParamInfo,
  RestParamInfo,
} from "./context/types.js";
export {
  addImport,
  addStringConstantGlobal,
  ensureExnTag,
  localGlobalIdx,
  nextModuleGlobalIdx,
  // #808 — re-exported from registry/imports.ts so existing `from "./index.js"`
  // importers across the codebase keep resolving after the extraction.
  addStringImports,
  addUnionImports,
  addIteratorImports,
  addArrayIteratorImports,
  addGeneratorImports,
  addForInImports,
} from "./registry/imports.js";
export {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterArrayType,
  getOrRegisterBoundFnType,
  getOrRegisterRefCellType,
  getOrRegisterResizableAbType,
  getOrRegisterTemplateVecType,
  getOrRegisterVecType,
} from "./registry/types.js";
export { compileExpression, compileStatement } from "./shared.js";
