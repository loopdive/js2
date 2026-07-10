// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts, forEachChild } from "../ts-api.js";
import { emitToBoolean } from "./coercion-engine.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { analyzeLinearUint8 } from "./linear-uint8-analysis.js";
import { analyzeFnctorEscapeGate, deriveFnctorFields } from "./fnctor-escape-gate.js";
import { isLinearU8RepresentableNew } from "./linear-uint8-signatures.js";
import { definedFuncAt } from "./func-space.js"; // (#1916 S2) positional-read chokepoint
import { emitVecDefineWritebackExports } from "./vec-define-writeback.js"; // (#3116)
import type { MultiTypedAST, TypedAST } from "../checker/index.js";
import {
  isBigIntType,
  isBooleanType,
  isExternalDeclaredClass,
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
import { irDynamic, isDynamic, irVal, type IrType } from "../ir/nodes.js";
import { buildTypeMap, type LatticeType } from "../ir/propagate.js";
import { planIrCompilation, irClosureSignatureFromFunctionTypeNode, type IrFallbackReason } from "../ir/select.js";
import { makeIrHostGlobalResolver } from "../ir/host-extern.js"; // (#2856)
import { createCodegenContext } from "./context/create-context.js";
import {
  collectModuleTopLevelNames,
  irFirstBodyReadsHostNode,
  irFirstBodyReadsStringElement,
} from "./ir-first-gate.js";
import type { FallbackCounts } from "./fallback-telemetry.js";
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
import { ensureDynReadHelpers, ensureDynMemberGet } from "./dyn-read.js"; // (#2580 M0) / (#3053 U0)
import { collectClosureBaseWrapperTypeIdxs, buildClosureRefTestArms } from "./closure-classifier.js"; // (#2175 V2-S1)
import { ensureNativeIteratorRuntime, fillNativeIteratorLateArms } from "./iterator-native.js";
import { emitResizableAbExports } from "./dataview-native.js"; // (#3058)
import { fillCombinatorToVec } from "./promise-combinators.js"; // (#2922) dynamic combinator-arg drain fill
import { fillClosedMethodDispatch } from "./closed-method-dispatch.js";
import { fillMemberSetDispatch, reserveVecFieldMaterializers } from "./member-set-dispatch.js";
import { fillMemberGetDispatch } from "./member-get-dispatch.js";
import { emitUndefined, ensureGetUndefined, reconcileNativeStrFinalizeShift } from "./expressions/late-imports.js";
import { fillProtoIteratorDriver } from "./expressions/proto-override.js";
import { fillAccessorDrivers } from "./accessor-driver.js";
import {
  fillApplyClosure,
  fillBuiltinFnMeta,
  fillExternGetIdxVecArms,
  fillExternIsArray,
  fillProxyDispatch,
} from "./object-runtime.js";
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
  isStandalonePromiseActive,
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

// ── Re-exports for public API compatibility ─────────────────────────────────
export {
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

export function typedArrayVecStorage(ctx: CodegenContext, name: string): { key: string; type: ValType } {
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
  const TA_NAMES = new Set([
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
  let found = false;
  function walk(node: ts.Node): void {
    if (found) return;
    if (ts.isNewExpression(node) && node.arguments && node.arguments.length >= 1) {
      let callee: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(callee) || ts.isAsExpression(callee) || ts.isNonNullExpression(callee)) {
        callee = callee.expression;
      }
      const arg0 = node.arguments[0]!;
      if (ts.isIdentifier(callee) && !ts.isNumericLiteral(arg0)) {
        // Static TA name (`new Uint8Array(buf)`) is handled by the static view
        // ctor path, never the dynamic one — skip it.
        if (!TA_NAMES.has(callee.text)) {
          // A user class callee resolves to a ClassDeclaration value — skip; only
          // a value-bound ctor (variable / param / any) reaches the dynamic path.
          const sym = checker.getSymbolAtLocation(callee);
          const decl = sym?.valueDeclaration;
          const isUserClass = decl !== undefined && ts.isClassDeclaration(decl);
          if (!isUserClass) {
            // Buffer-typed first arg gates the dynamic TA construct (matches the
            // runtime gate) — excludes `new fn(x)` on unrelated identifiers.
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

export function extractConstantDefault(
  initializer: ts.Expression,
  paramType: ValType,
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
    const methods: { name: string; params: IrType[]; returnType: IrType | null }[] = [];
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
// Empty as of #1530 — flip entries to "strict" in follow-up PRs once
// their `scripts/ir-fallback-baseline.json` bucket reaches zero. The
// intended order (cheapest first, see plan/log/ir-adoption.md):
//   "param-type-not-resolvable",
//   "call-graph-closure",
//   "body-shape-rejected",

const STRICT_IR_BUILD_ERRORS: ReadonlyArray<string> = [
  // Empty as of #1530 — add substring patterns here when a known build
  // error class is permanently fixed and a legacy fallback should no
  // longer mask a real bug. Example for a future PR:
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

function truthyEnv(v: string | undefined): boolean {
  return v === "1" || v === "true";
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
  readonly safeSelection: { funcs: Set<string>; classMembers?: ReadonlySet<string> };
  readonly trackFallbacks: boolean;
  readonly declByName: ReadonlyMap<string, ts.FunctionDeclaration>;
}

/**
 * (#2138) Decide which claimed functions may have their LEGACY body emission
 * skipped under `JS2WASM_IR_FIRST=1`. Deliberately conservative — a function
 * qualifies only when:
 *
 *   1. It survived overrideMap resolution (`safeSelection.funcs` — computed
 *      strictly AFTER the #2023 `new.target` clear and after resolve-time
 *      drops), so the IR path WILL attempt it.
 *   2. If it is a generator (`function*`), the compile targets a JS host
 *      (`generatorsSkippable` — `!standalone && !wasi`). #2951 gate-2: the
 *      IR generator lowering is now self-sufficient for the JS-host path —
 *      it pre-registers its own generator host imports
 *      (`addGeneratorImports` in `ir/integration.ts`, driven by any
 *      `funcKind === "generator"` claim) and its own `__exn` tag, and the
 *      source-level scan (`state.generatorFound` in `declarations.ts`)
 *      registers the generator imports independently of ANY individual
 *      generator's legacy body emission — so skipping a claimed generator's
 *      legacy body drops no import/type/tag the IR body relies on. The
 *      predecessor slice (`gen.setReturn`, #2640) closed the last
 *      value-returning-`return` deferral, so value-carrying generators now
 *      IR-claim with zero post-claim demotions (proven on a representative
 *      host-drain corpus, `irPostClaimErrors` empty). Any generator SHAPE the
 *      IR path still can't own is filtered UPSTREAM by the selector (async
 *      generators, generator methods → `deferred-feature`; unresolved yield
 *      shapes) so it never enters `safeSelection.funcs` and never reaches
 *      this gate. STANDALONE/WASI generators stay compile-twice: legacy
 *      restricts them to sequential-numeric-yield native lowering
 *      (`function-body.ts` "#680" guard) and the IR path unconditionally
 *      registers JS-host generator imports, so standalone self-sufficiency
 *      is genuinely unproven (#2138 deviation 3) — lift in a follow-up after
 *      a standalone measurement.
 *   3. Every DIRECT local callee is also in `safeSelection.funcs`. The
 *      selector's Step-2 closure already guarantees this against
 *      `selection.funcs`, but overrideMap resolution can re-open the closure
 *      (a callee dropped at resolve time). Such a caller's IR build then
 *      throws "call to unknown function" — a KNOWN-benign legacy fallback
 *      that must not become a skipped-slot hard error. Non-transitive is
 *      sufficient: only the function's own IR success is load-bearing for
 *      its slot, and a callee that is claimed-but-not-skipped still occupies
 *      its pre-allocated slot with a working body either way.
 *   4. Its body does not read a HOST node (property/element access or bare
 *      call rooted at an identifier that is neither function-local nor a
 *      module top-level binding) — see `irFirstBodyReadsHostNode` (#2138
 *      Trap 4 / #2856 sequencing). A no-op today (the selector still rejects
 *      host-global receivers), load-bearing the moment #2856's extern-in-IR
 *      selector arm lands: host-node functions stay compile-twice until that
 *      lowering is proven, keeping the flag-on measurement clean.
 *
 * Class members are NEVER skipped in this slice (their slot pre-allocation
 * lives in `class-bodies.ts` and carries a typeIdx parity contract with
 * legacy callers — see the parity guard in `integration.ts`); they stay on
 * the legacy-then-overwrite path.
 *
 * Every skipped function gets an `unreachable` placeholder body, so the
 * skip is a *body-emission* change, never an *index-layout* change: the
 * funcIdx/typeIdx slot assignment from `collectDeclarations` is untouched.
 * If the IR path then fails to compile a skipped function, the overlay in
 * `generateModule` promotes that failure to a hard compile error (the
 * placeholder must never ship) — surfacing exactly the selector↔builder
 * divergences this investigation exists to find (#2135).
 */
function computeIrFirstSkipSet(
  plan: IrOverlayPlan,
  sourceFile: ts.SourceFile,
  generatorsSkippable: boolean,
): ReadonlySet<string> {
  const skip = new Set<string>();
  const funcs = plan.safeSelection.funcs;
  if (funcs.size === 0) return skip;
  const edges = plan.selection.localCallees;
  // Gate 4 (#2138 Trap 4, coordinated with the extern-in-IR plan in #2856):
  // module-level user bindings, computed once — receivers/callees rooted at
  // these are user code, never host globals.
  const moduleNames = collectModuleTopLevelNames(sourceFile);
  for (const name of funcs) {
    const fn = plan.declByName.get(name);
    if (!fn) continue;
    // gate 2 (#2951) — a claimed generator is skippable only when targeting a
    // JS host. Standalone/WASI generators stay compile-twice (legacy's
    // native-generator restriction + unproven IR standalone self-sufficiency,
    // #2138 deviation 3). Non-generators are unaffected.
    if (fn.asteriskToken && !generatorsSkippable) continue;
    if (irFirstBodyReadsHostNode(fn, moduleNames)) continue; // gate 4 — host nodes
    if (irFirstBodyReadsStringElement(fn)) continue; // gate 5 — string element read (#2972)
    // Gate 6 (#2949 slice 2) — dynamic-signature functions stay compile-twice
    // under IR-first while the dynamic surface is move-only (no box/unbox
    // lowering yet). The selector's `dynamicUsesAreMoveOnly` scan is designed
    // to make claims build-proof, but a scan↔builder divergence on this brand-
    // new surface would otherwise become a skipped-slot HARD error; keep the
    // legacy body as the demotion target until slice 3 lowering + an ir_first
    // lane measurement prove the claims robust, then lift this gate.
    {
      const o = plan.overrideMap.get(name);
      if (o && (o.params.some((p) => isDynamic(p)) || (o.returnType !== null && isDynamic(o.returnType)))) {
        continue;
      }
    }
    if (!edges) continue; // no edge info (defensive) — stay conservative
    const callees = edges.get(name);
    let closed = true;
    if (callees) {
      for (const c of callees) {
        if (!funcs.has(c)) {
          closed = false;
          break;
        }
      }
    }
    if (closed) skip.add(name); // gates 1 + 3
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
  const safeSelection: { funcs: Set<string>; classMembers?: ReadonlySet<string> } = {
    funcs: new Set<string>([...selection.funcs].filter((n) => overrideMap.has(n))),
    classMembers: selection.classMembers,
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
  // #2138 — legacy bodies skipped under JS2WASM_IR_FIRST=1 (undefined when off).
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

    // (#2138) IR-first compile-once inversion — flag-gated investigation.
    // Default OFF: with `JS2WASM_IR_FIRST` unset this block is dead and the
    // pipeline below is byte-identical to the legacy order (IR planning runs
    // AFTER the body pass, inside the experimentalIR overlay). With the flag
    // set (+ experimentalIR), the IR plan is computed BEFORE
    // `compileDeclarations` and legacy body emission is skipped for claimed
    // functions that pass `computeIrFirstSkipSet`'s gates — those slots get
    // an `unreachable` placeholder that the IR overlay MUST overwrite (a
    // post-claim IR failure on a skipped function is promoted to a hard
    // compile error below, never a silent legacy demote).
    // (#2973) `disableIrFirst` opts a compile out of the IR-first inversion
    // regardless of the ambient env flag — semantics-critical sub-compiles
    // (eval / new Function host shims) set it so a post-claim IR-first hard
    // error is not swallowed by the shim's fallback catch into a silent
    // `undefined`. The ordinary IR overlay (`experimentalIR`) still runs.
    const irFirst = !!options?.experimentalIR && !options?.disableIrFirst && truthyEnv(process.env.JS2WASM_IR_FIRST);
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

    // (#1888 Slice 1) Fill the reserved `__apply_closure` bridge body now that
    // `__call_fn_method_0..4` are registered. No-op when no standalone open-any
    // method-dispatch site reserved the bridge (`ctx.applyClosureReserved`).
    fillApplyClosure(ctx);

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

    // (#2896) Fill the reserved builtin-fn metadata natives
    // (`__builtinfn_get_meta` / `__builtinfn_gopd` / `__builtinfn_delete` /
    // `__builtinfn_push_ownnames`) now that every builtin closure meta type
    // (builtin-fn-meta.ts) is registered — the reflective
    // `Object.getOwnPropertyDescriptor(fn, "name")` / `fn[key]` /
    // `hasOwnProperty` / `getOwnPropertyNames` reads over a builtin function
    // value resolve its spec `name`/`length` at runtime, host-free. No-op when
    // no builtin closure was materialized (standalone only).
    fillBuiltinFnMeta(ctx);

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
    { op: "i32.const", value: 1 } as Instr,
    { op: "global.set", index: flagIdx } as Instr,
    ...initFn.body,
    { op: "i32.const", value: 0 } as Instr,
    { op: "global.set", index: flagIdx } as Instr,
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
    { op: "global.get", index: doneGlobalIdx } as Instr,
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" } as Instr] } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "global.set", index: doneGlobalIdx } as Instr,
    ...initFn.body,
  ];

  // 2. Prepend `call __module_init` to every exported function (except
  //    __module_init itself). Idempotency makes repeated entry calls safe.
  for (const fn of ctx.mod.functions) {
    if (!fn.exported) continue;
    if (fn.name === "__module_init") continue;
    fn.body = [{ op: "call", funcIdx: initFuncIdx } as Instr, ...fn.body];
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
                    { op: "call", funcIdx: exnPrinterIdx } as Instr,
                    // An uncaught exception is a failure — exit nonzero.
                    { op: "i32.const", value: 1 } as Instr,
                    { op: "call", funcIdx: ctx.wasiProcExitIdx } as Instr,
                    { op: "unreachable" } as Instr,
                  ],
                },
              ],
            } as unknown as Instr,
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
 * Emit exported getter/setter helper functions so the JS runtime can read
 * WasmGC struct fields that are otherwise opaque to JavaScript.
 *
 * For each unique field name across all struct types, we emit:
 *   __sget_<name>(externref) -> externref
 * The function converts the externref to anyref, tries ref.test for each
 * struct type that has that field, extracts the field via struct.get,
 * and converts the result to externref.
 *
 * Numeric fields (f64, i32) are boxed via __box_number import.
 * Ref/ref_null fields are converted via extern.convert_any.
 * The runtime discovers these exports and uses them as fallback when
 * direct JS property access on a WasmGC struct returns undefined.
 */
function emitStructFieldGetters(ctx: CodegenContext): void {
  try {
    _emitStructFieldGettersInner(ctx);
  } catch (e: any) {
    // Non-fatal: if getter emission fails, the module still works
    // (the runtime just can't read struct fields from JS)
  }
}

function _emitStructFieldGettersInner(ctx: CodegenContext): void {
  const mod = ctx.mod;

  // Collect all (fieldName → [{structTypeIdx, fieldIdx, fieldType}]) mappings
  const fieldMap = new Map<string, { typeIdx: number; fieldIdx: number; fieldType: ValType }[]>();

  for (const [structName, fields] of ctx.structFields) {
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;

    // Skip internal/wrapper types
    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_")
    )
      continue;

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (!field || !field.type) continue;
      // Skip fields with names that would create invalid export names
      if (!field.name || field.name.startsWith("$")) continue;

      let entries = fieldMap.get(field.name);
      if (!entries) {
        entries = [];
        fieldMap.set(field.name, entries);
      }
      entries.push({ typeIdx, fieldIdx: i, fieldType: field.type });
    }
  }

  if (fieldMap.size === 0) return;

  // (#1320) A getter that returns a numeric/boolean field as externref boxes it
  // via __box_number / __box_boolean. Those helpers are registered lazily at
  // boxing call-sites during expression compilation — but a module whose only
  // numeric/boolean struct field is read *exclusively through the host* (e.g. a
  // function returns `{ value, done }` to JS, which then reads `.done`) never
  // hits such a call-site, so the helpers are still absent here. Without them
  // the getter fell through to `drop; ref.null.extern` and `__sget_done`
  // returned null (and `__sget_<num>` would have boxed as a number — #1788).
  // Register the union helpers (which include __box_number / __box_boolean)
  // BEFORE any getter funcIdx is computed, so the emitted getters reference the
  // final post-shift indices. addUnionImports is idempotent (hasUnionImports
  // guard), uses the immediate finalize-phase index shift, and in
  // standalone/WASI mode routes to the Wasm-native helper bodies (no env::*
  // import). We only call it when at least one field bucket would emit a box
  // call (an extern-mode bucket carrying a numeric/boolean field), so a module
  // with no such fields stays byte-identical.
  let needsBox = false;
  for (const entries of fieldMap.values()) {
    const hasF64 = entries.some((e) => e.fieldType.kind === "f64");
    const hasI32 = entries.some((e) => e.fieldType.kind === "i32");
    const hasRef = entries.some((e) => e.fieldType.kind !== "f64" && e.fieldType.kind !== "i32");
    const hasBool = entries.some((e) => e.fieldType.kind === "i32" && (e.fieldType as { boolean?: true }).boolean);
    const allF64 = hasF64 && !hasI32 && !hasRef;
    const allI32 = hasI32 && !hasF64 && !hasRef && !hasBool;
    // f64-only / i32-only buckets return the raw value (no box call). Only a
    // mixed/boolean (extern-mode) bucket carrying a numeric or boolean field
    // emits a __box_number / __box_boolean call.
    if (allF64 || allI32) continue;
    if (hasF64 || hasI32 || hasBool) {
      needsBox = true;
      break;
    }
  }
  if (needsBox) addUnionImports(ctx);

  // Find __box_number import for numeric boxing (may be undefined)
  const boxNumIdx = ctx.funcMap.get("__box_number");
  // (#1788) __box_boolean for boolean-branded i32 fields — boxes the stored i32
  // as a JS boolean so `typeof o.x === "boolean"` and `o.x === true` hold on a
  // dynamic read, instead of the value boxing as the number 1.
  const boxBoolIdx = ctx.funcMap.get("__box_boolean");

  // Two getter types: one for externref result, one for f64 result
  const getterExternTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$sget_extern_type");
  const getterF64TypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }], "$sget_f64_type");
  const getterI32TypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$sget_i32_type");

  for (const [fieldName, entries] of fieldMap) {
    // Determine the "best" return type — if all entries for this field are
    // the same kind we can use a specific return type; if mixed, use externref.
    const hasF64 = entries.some((e) => e.fieldType.kind === "f64");
    const hasI32 = entries.some((e) => e.fieldType.kind === "i32");
    const hasRef = entries.some((e) => e.fieldType.kind !== "f64" && e.fieldType.kind !== "i32");
    // (#1788) A boolean-branded i32 field must box (so the host sees a JS
    // boolean, not the number 1). The raw-i32 returnMode returns a bare i32,
    // which the host reads back as a number — so an all-i32 bucket that
    // contains any boolean field is forced to externref/box mode instead.
    const hasBool = entries.some((e) => e.fieldType.kind === "i32" && (e.fieldType as { boolean?: true }).boolean);
    const allF64 = hasF64 && !hasI32 && !hasRef;
    const allI32 = hasI32 && !hasF64 && !hasRef && !hasBool;

    let getterTypeIdx: number;
    let returnMode: "extern" | "f64" | "i32";
    if (allF64) {
      getterTypeIdx = getterF64TypeIdx;
      returnMode = "f64";
    } else if (allI32) {
      getterTypeIdx = getterI32TypeIdx;
      returnMode = "i32";
    } else {
      getterTypeIdx = getterExternTypeIdx;
      returnMode = "extern";
    }

    const funcName = `__sget_${fieldName}`;
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const anyLocal = 1; // first local after params (local 0 = externref param)

    const funcBody = buildNestedIfElse(entries, anyLocal, boxNumIdx, returnMode, boxBoolIdx);

    mod.functions.push({
      name: funcName,
      typeIdx: getterTypeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body: funcBody,
      exported: true,
    } as WasmFunction);

    mod.exports.push({
      name: funcName,
      desc: { kind: "func", index: funcIdx },
    });

    // (#2038) Register in funcMap so the native iterator carrier's USER arm can
    // resolve `__sget_value` / `__sget_done` at finalize-fill time
    // (`fillNativeIteratorLateArms`). No other code looks `__sget_*` up by funcMap
    // key, so this is inert for every other path.
    ctx.funcMap.set(funcName, funcIdx);
  }

  // Emit __struct_field_names(externref) -> externref
  // Returns a comma-separated string of field names for the struct type of the argument.
  // The runtime uses this for Object.keys(), JSON.stringify(), for-in, and spread on opaque structs.
  emitStructFieldNamesExport(ctx, fieldMap);
}

/**
 * Emit exported `__sset_<name>(externref obj, externref val) -> ()` setters
 * symmetric to the existing `__sget_<name>` getters (#1630). The runtime
 * `_safeSet` calls these so a host `Object.assign(typedStruct, src)` (and
 * other MOP writes routed through `_wrapForHost` set-trap) reflects back
 * into the real WasmGC struct field rather than only updating the JS-side
 * sidecar. Without these setters, struct.field reads via compiled Wasm see
 * the initial value while sidecar reads via host see the updated value —
 * the asymmetry that masks `Object.assign` and similar writeback cases.
 *
 * Only mutable fields get setters; immutable singleton structs (boxed
 * number / boolean) are skipped to avoid `struct.set` validation errors.
 * Field-name buckets that mix kinds (f64 / i32 / ref) across struct types
 * are skipped so the sidecar still carries the write — homogeneous-kind
 * buckets cover the object-literal cases in test262.
 */
function emitStructFieldSetters(ctx: CodegenContext): void {
  try {
    _emitStructFieldSettersInner(ctx);
  } catch {
    // Non-fatal: setter emission failure degrades to sidecar-only writeback
    // (the current pre-fix behaviour), the module still runs.
  }
}

function _emitStructFieldSettersInner(ctx: CodegenContext): void {
  const mod = ctx.mod;

  // Collect (fieldName → [{typeIdx, fieldIdx, fieldType, shapeId?, shapeFieldIdx?}])
  // mappings, but ONLY for mutable fields. Mirror the skip rules used by the
  // getter emitter so the two stay in lockstep.
  //
  // (#2009) For COLLIDING structs (those with a `$shape` field, set by
  // resolveSameShapeFieldNameCollisions), record the shape-id + `$shape` field
  // index so `buildSetterStore` can gate the write on the per-instance shape:
  // same-shape canonicalization makes `ref.test typeIdx` match a DIFFERENT
  // struct, so `__sset_b(target {a:1})` would otherwise write slot 0 of the
  // target (its `a`). The guard makes a mismatched write no-op (sidecar carries
  // it). Non-colliding structs leave shapeId undefined → no guard, byte-identical.
  type SetterEntry = {
    typeIdx: number;
    fieldIdx: number;
    fieldType: ValType;
    shapeId?: number;
    shapeFieldIdx?: number;
  };
  const fieldMap = new Map<string, SetterEntry[]>();

  for (const [structName, fields] of ctx.structFields) {
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;

    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_")
    )
      continue;

    const shapeId = ctx.shapeIdByStructName.get(structName);
    const shapeFieldIdx = shapeId !== undefined ? fields.findIndex((f) => f && f.name === "$shape") : -1;

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      if (!field || !field.type) continue;
      if (!field.name || field.name.startsWith("$")) continue;
      // Only emit setters for mutable fields — `struct.set` on an immutable
      // field is a Wasm validation error (e.g. boxed-number singletons).
      if (!field.mutable) continue;

      let entries = fieldMap.get(field.name);
      if (!entries) {
        entries = [];
        fieldMap.set(field.name, entries);
      }
      entries.push({
        typeIdx,
        fieldIdx: i,
        fieldType: field.type,
        ...(shapeId !== undefined && shapeFieldIdx >= 0 ? { shapeId, shapeFieldIdx } : {}),
      });
    }
  }

  if (fieldMap.size === 0) return;

  // Only kinds we can emit a correct `struct.set` for after the externref →
  // anyref convert. Abstract heap types other than `anyref` (eqref / structref /
  // funcref) would need a `ref.cast` to an abstract heap type, which the
  // current Instr encoding does not express — skip those ARMS so the
  // sidecar still carries the write.
  const isRefKind = (k: ValType["kind"]) =>
    k === "ref" || k === "ref_null" || k === "anyref" || k === "externref" || k === "ref_extern";

  // (#2853 bug B) Mixed-kind buckets are NO LONGER skipped. A skipped bucket
  // (e.g. `pos`, whose field kind differs across acorn's Parser /
  // RegExpValidationState structs) meant every HOST write (`state.pos = 0` via
  // a method-parameter access → `__extern_set` → `_safeSet`) landed in the
  // JS sidecar only, while every in-wasm `this.pos` access used the live
  // struct field — two stores for one key. Once the sidecar was seeded, host
  // reads (`_safeGet` first) saw the frozen sidecar value (0) forever, so
  // acorn's regexp validator compared a phantom `state.pos` and raised
  // "Unmatched ')'" on every group. Mixed buckets now use the externref
  // signature with per-arm coercion: numeric fields unbox via __unbox_number.
  // Ensure the union helpers exist BEFORE any setter funcIdx is computed
  // (mirrors the getter emitter's needsBox discipline / #1320).
  let needsUnbox = false;
  for (const entries of fieldMap.values()) {
    const allF64 = entries.every((e) => e.fieldType.kind === "f64");
    const allI32 = entries.every((e) => e.fieldType.kind === "i32");
    if (allF64 || allI32) continue;
    if (entries.some((e) => e.fieldType.kind === "f64" || e.fieldType.kind === "i32")) {
      needsUnbox = true;
      break;
    }
  }
  if (needsUnbox) addUnionImports(ctx);
  const unboxNumIdx = ctx.funcMap.get("__unbox_number");

  // Setter signatures: 3 variants by val type. All return i32 (1 = an arm
  // matched and wrote the live struct field, 0 = no arm matched) so the
  // runtime `_safeSet` can decide whether the sidecar must carry the value
  // (expando / unmatched shape) or must NOT shadow the live field (#2853 B).
  const setterExternTypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
    "$sset_extern_type",
  );
  const setterF64TypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "f64" }],
    [{ kind: "i32" }],
    "$sset_f64_type",
  );
  const setterI32TypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }],
    [{ kind: "i32" }],
    "$sset_i32_type",
  );

  for (const [fieldName, entries] of fieldMap) {
    const allF64 = entries.every((e) => e.fieldType.kind === "f64");
    const allI32 = entries.every((e) => e.fieldType.kind === "i32");

    let setterTypeIdx: number;
    let valMode: "extern" | "f64" | "i32";
    let useEntries = entries;
    if (allF64) {
      setterTypeIdx = setterF64TypeIdx;
      valMode = "f64";
    } else if (allI32) {
      setterTypeIdx = setterI32TypeIdx;
      valMode = "i32";
    } else {
      // Ref-only AND mixed buckets: externref signature, per-arm coercion.
      // Arms whose field kind we cannot coerce from externref (i64 / f32 /
      // v128 / packed i8/i16, or numeric without __unbox_number) are dropped —
      // they return 0 and the sidecar carries those writes, as before.
      useEntries = entries.filter(
        (e) =>
          isRefKind(e.fieldType.kind) ||
          ((e.fieldType.kind === "f64" || e.fieldType.kind === "i32") && unboxNumIdx !== undefined),
      );
      if (useEntries.length === 0) continue;
      setterTypeIdx = setterExternTypeIdx;
      valMode = "extern";
    }

    const funcName = `__sset_${fieldName}`;
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const anyLocal = 2; // locals after the two params (local 0 = obj, local 1 = val)
    const wroteLocal = 3; // i32 "an arm matched and wrote" flag (defaults 0)

    const funcBody = buildSetterNestedIfElse(ctx, useEntries, anyLocal, valMode, wroteLocal, unboxNumIdx);

    mod.functions.push({
      name: funcName,
      typeIdx: setterTypeIdx,
      locals: [
        { name: "__any", type: { kind: "anyref" } },
        { name: "__wrote", type: { kind: "i32" } },
      ],
      body: funcBody,
      exported: true,
    } as WasmFunction);

    mod.exports.push({
      name: funcName,
      desc: { kind: "func", index: funcIdx },
    });
  }
}

/** Build nested if/else for struct field setter dispatch. */
function buildSetterNestedIfElse(
  ctx: CodegenContext,
  entries: { typeIdx: number; fieldIdx: number; fieldType: ValType; shapeId?: number; shapeFieldIdx?: number }[],
  anyLocal: number,
  valMode: "extern" | "f64" | "i32",
  wroteLocal: number,
  unboxNumIdx?: number,
): Instr[] {
  const body: Instr[] = [];

  // Convert obj externref to anyref and store
  body.push({ op: "local.get", index: 0 } as Instr);
  body.push({ op: "any.convert_extern" } as Instr);
  body.push({ op: "local.set", index: anyLocal } as Instr);

  // Chain: if (ref.test T1) { cast + struct.set T1 } else if (ref.test T2) { ... }
  let current: Instr[] = []; // final else: no-op (wrote flag stays 0)

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    let thenBranch = buildSetterStore(ctx, entry, anyLocal, valMode, wroteLocal, unboxNumIdx);

    // (#2009) Colliding struct: `ref.test typeIdx` matched, but same-shape
    // canonicalization means the instance might be a DIFFERENT struct that
    // lacks this field. Gate the store on `struct.get $shape === entry.shapeId`
    // so a mismatched write no-ops (sidecar carries it) instead of corrupting
    // a same-slot field of the wrong struct.
    if (entry.shapeId !== undefined && entry.shapeFieldIdx !== undefined) {
      thenBranch = [
        { op: "local.get", index: anyLocal } as Instr,
        { op: "ref.cast", typeIdx: entry.typeIdx } as Instr,
        { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.shapeFieldIdx } as Instr,
        { op: "i32.const", value: entry.shapeId } as Instr,
        { op: "i32.eq" } as Instr,
        { op: "if", blockType: { kind: "empty" }, then: thenBranch } as Instr,
      ];
    }

    const ifInstr: Instr = {
      op: "if",
      blockType: { kind: "empty" },
      then: thenBranch,
      else: current,
    };

    current = [
      { op: "local.get", index: anyLocal } as Instr,
      { op: "ref.test", typeIdx: entry.typeIdx } as Instr,
      ifInstr,
    ];
  }

  body.push(...current);
  // Result: 1 iff an arm matched this receiver's runtime type and wrote.
  body.push({ op: "local.get", index: wroteLocal } as Instr);
  return body;
}

/** Build the "then" branch that stores `val` (local 1) into a struct field
 *  and sets the `wroteLocal` success flag (#2853 B). */
function buildSetterStore(
  ctx: CodegenContext,
  entry: { typeIdx: number; fieldIdx: number; fieldType: ValType },
  anyLocal: number,
  valMode: "extern" | "f64" | "i32",
  wroteLocal: number,
  unboxNumIdx?: number,
): Instr[] {
  const then: Instr[] = [];
  const ft = entry.fieldType;
  const markWrote: Instr[] = [{ op: "i32.const", value: 1 } as Instr, { op: "local.set", index: wroteLocal } as Instr];

  // Push the cast struct ref onto the stack
  then.push({ op: "local.get", index: anyLocal } as Instr);
  then.push({ op: "ref.cast", typeIdx: entry.typeIdx } as Instr);

  // Push the value (typed per valMode; for extern-mode buckets the arm
  // coerces per its own field kind below — mixed buckets are allowed, #2853 B).
  then.push({ op: "local.get", index: 1 } as Instr);

  if (valMode === "extern") {
    // (#2831) Vec-typed field: the inbound externref may be a HOST-marshalled
    // array (or any externref), NOT a wasm vec — the prior unguarded
    // `any.convert_extern; ref.cast(_null) $vec` traps `illegal cast` (or, under
    // the `_safeSet` try/catch, degrades to a SILENTLY-DROPPED cross-rep write).
    // Route through the reserved host-aware materializer instead, which builds a
    // fresh vec of the exact target type on the slot (empty/non-empty/host/
    // same-rep/null uniformly). Value (local 1, externref) is already on stack.
    // Name-based lookup (funcMap stays in lockstep across late-import shifts);
    // undefined pre-reserve ⇒ falls back to the guarded cast below.
    const vecMatName = ft.kind === "ref" || ft.kind === "ref_null" ? ctx.vecFromExternMap?.get(ft.typeIdx) : undefined;
    const vecMatIdx = vecMatName !== undefined ? ctx.funcMap.get(vecMatName) : undefined;
    if (vecMatIdx !== undefined) {
      then.push({ op: "call", funcIdx: vecMatIdx } as Instr);
      if (ft.kind === "ref") then.push({ op: "ref.as_non_null" } as Instr);
      then.push({ op: "struct.set", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx } as Instr);
      then.push(...markWrote);
      return then;
    }
    // (#2853 B) Numeric field in an extern-mode (mixed) bucket: unbox the
    // externref value to f64 (Number coercion host-side), truncating for i32
    // fields. Boolean-branded i32 fields coerce true/false → 1/0 the same way.
    if (ft.kind === "f64" || ft.kind === "i32") {
      // Caller guarantees unboxNumIdx is defined for these arms (bucket filter).
      then.push({ op: "call", funcIdx: unboxNumIdx! } as Instr);
      if (ft.kind === "i32") then.push({ op: "i32.trunc_sat_f64_s" } as Instr);
      then.push({ op: "struct.set", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx } as Instr);
      then.push(...markWrote);
      return then;
    }
    // Remaining field kinds here: ref / ref_null / anyref / externref /
    // ref_extern (the bucket filter drops i64 / f32 / v128 / packed arms).
    // externref & ref_extern need no conversion; everything else converts
    // externref → anyref first, then typed-ref fields cast down to the
    // field's specific heap type. Cast failures trap; the runtime _safeSet
    // wraps the setter call in try/catch so a wrong-type assign degrades to
    // sidecar-only (the prior behaviour) rather than crashing.
    if (ft.kind === "ref" || ft.kind === "ref_null" || ft.kind === "anyref") {
      then.push({ op: "any.convert_extern" } as Instr);
    }
    if (ft.kind === "ref") {
      then.push({ op: "ref.cast", typeIdx: ft.typeIdx } as Instr);
    } else if (ft.kind === "ref_null") {
      then.push({ op: "ref.cast_null", typeIdx: ft.typeIdx } as Instr);
    }
  }

  then.push({ op: "struct.set", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx } as Instr);
  then.push(...markWrote);
  return then;
}

/**
 * (#2009) Same-structural-shape field-name collision resolution.
 *
 * `{ aa: number }` and `{ bb: number }` compile to DISTINCT anon struct
 * typeIdxs (fieldsHashKey includes field names) — but they are STRUCTURALLY
 * identical (`struct (field (mut f64))`), so WasmGC iso-recursive
 * canonicalization makes them indistinguishable to `ref.test`. The host
 * `__struct_field_names` / `__sset_*` exports therefore mislabel / mis-write
 * every same-shape instance with the first-registered shape's names.
 *
 * Fix (opt-in, minimal blast radius): only structs that ACTUALLY collide — two+
 * anon object-literal structs that share field TYPES but differ in field NAMES —
 * get a hidden trailing `$shape` i32 field retro-stamped per-instance. The host
 * exports then read `$shape` to recover the instance's real names BY VALUE. A
 * struct with a unique field-name-shape is never touched (the common case stays
 * byte-identical, including all IR-path construction).
 *
 * Runs as a post-pass after every function body is final, so the struct.new
 * operand patch is uniform across the legacy AND IR backends (it walks emitted
 * `Instr` streams, not a specific construction path).
 */

/**
 * (#2009 R3b) Permute a struct's slot-order field names into JS INSERTION order
 * for the host name export, using the per-literal order recorded in
 * `ctx.structInsertionOrder` (see its doc). MEMBERSHIP is preserved exactly:
 * the returned list is `slotNames` reordered, never added to or filtered — every
 * name still resolves to its `__sget_<name>` getter. Names present in the
 * insertion-order list come first in that order; any slot name not in the list
 * (defensive — should not happen for a literal-derived struct) keeps its
 * original relative position at the end. No recorded order ⇒ `slotNames`
 * unchanged (plain literals, IR-fresh structs, named classes).
 */
function orderNamesByInsertion(ctx: CodegenContext, structName: string, slotNames: string[]): string[] {
  const order = ctx.structInsertionOrder.get(structName);
  if (!order || order.length === 0) return slotNames;
  const slotSet = new Set(slotNames);
  const ordered: string[] = [];
  const placed = new Set<string>();
  for (const name of order) {
    if (slotSet.has(name) && !placed.has(name)) {
      ordered.push(name);
      placed.add(name);
    }
  }
  // Append any slot name the insertion list did not cover, in slot order.
  for (const name of slotNames) {
    if (!placed.has(name)) {
      ordered.push(name);
      placed.add(name);
    }
  }
  return ordered;
}

function resolveSameShapeFieldNameCollisions(ctx: CodegenContext): void {
  // Host enumeration is JS-only; standalone/WASI has no host name export.
  if (ctx.nativeStrings) return;

  // Structural-shape key = field TYPES only (the thing WasmGC canonicalizes on),
  // ignoring names and any pre-existing internal `$`/`__` fields. Group anon
  // object-literal structs by it.
  const typeKindKey = (t: ValType): string => {
    if (t.kind === "ref" || t.kind === "ref_null") return `${t.kind}:${(t as { typeIdx: number }).typeIdx}`;
    if (t.kind === "i32" && (t as { boolean?: true }).boolean) return "i32:bool";
    return t.kind;
  };
  type Member = { structName: string; typeIdx: number; names: string[] };
  const byShape = new Map<string, Member[]>();

  for (const [structName, fields] of ctx.structFields) {
    // Only anonymous object-literal structs participate. Named classes have
    // nominal types distinct under `ref.test` already; vec/arr/wrapper/union
    // carriers are internal.
    if (!structName.startsWith("__anon_")) continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;

    const names: string[] = [];
    const typeParts: string[] = [];
    for (const f of fields) {
      if (!f || !f.type || !f.name) continue;
      if (f.name.startsWith("$") || f.name.startsWith("__")) continue;
      names.push(f.name);
      typeParts.push(typeKindKey(f.type));
    }
    if (names.length === 0) continue; // no host-enumerable fields
    // (#2009 R3b) The structural-shape key (`typeParts`) is built from slot order
    // so same-shape grouping is unaffected, but the enumerated `names` are
    // permuted to JS insertion order — so the shape-id CSV the host reads
    // reflects spec enumeration order, and two colliding structs with the SAME
    // insertion order share a shape-id.
    const orderedNames = orderNamesByInsertion(ctx, structName, names);
    const shapeKey = typeParts.join("|");
    let group = byShape.get(shapeKey);
    if (!group) {
      group = [];
      byShape.set(shapeKey, group);
    }
    group.push({ structName, typeIdx, names: orderedNames });
  }

  // A group "collides" iff it contains 2+ DISTINCT field-name lists. (Two
  // structs that share BOTH types and names are just the same shape registered
  // twice — `ref.test` returning either's identical names is correct, no fix.)
  const shapeIdByCsv = new Map<string, number>();
  const collidingTypeIdxs: { typeIdx: number; structName: string; shapeId: number }[] = [];

  for (const group of byShape.values()) {
    const distinctNameCsvs = new Set(group.map((m) => m.names.join(",")));
    if (distinctNameCsvs.size < 2) continue; // unique-name shape — leave untouched

    for (const m of group) {
      const csv = m.names.join(",");
      let shapeId = shapeIdByCsv.get(csv);
      if (shapeId === undefined) {
        shapeId = ctx.shapeNameCsvById.length;
        ctx.shapeNameCsvById.push(csv);
        shapeIdByCsv.set(csv, shapeId);
      }
      ctx.shapeIdByStructName.set(m.structName, shapeId);
      collidingTypeIdxs.push({ typeIdx: m.typeIdx, structName: m.structName, shapeId });
    }
  }

  if (collidingTypeIdxs.length === 0) return;

  // Retro-stamp: append a hidden `$shape` i32 field to each colliding struct
  // type + structFields, then patch every `struct.new <typeIdx>` instruction in
  // every compiled body to insert `i32.const <shapeId>` immediately before it,
  // matching the new operand count. The `$`-prefix excludes `$shape` from name
  // enumeration and getter/setter emission.
  for (const { typeIdx, structName, shapeId } of collidingTypeIdxs) {
    const typeDef = ctx.mod.types[typeIdx] as { kind: string; fields?: FieldDef[] } | undefined;
    if (!typeDef || typeDef.kind !== "struct" || !typeDef.fields) continue;
    // The struct registration stores ONE `fields` array shared by both
    // `ctx.mod.types[typeIdx].fields` and `ctx.structFields.get(structName)`, so
    // push `$shape` exactly once. Guard against a double-append if this somehow
    // re-runs for a type.
    const alreadyStamped = typeDef.fields.some((f) => f && f.name === "$shape");
    if (!alreadyStamped) {
      typeDef.fields.push({ name: "$shape", type: { kind: "i32" }, mutable: false });
      const sf = ctx.structFields.get(structName);
      if (sf && sf !== typeDef.fields) sf.push({ name: "$shape", type: { kind: "i32" }, mutable: false });
    }
    patchStructNewWithShapeId(ctx, typeIdx, shapeId);
  }
}

/**
 * (#2009) Insert `i32.const <shapeId>` immediately before every
 * `struct.new <typeIdx>` in every compiled function body — the retro-stamp that
 * keeps a struct.new's operand count in sync after `$shape` is appended to its
 * type. Backend-agnostic: walks the emitted `Instr` stream, so it covers both
 * the legacy and IR construction paths uniformly. Mirrors the structural walk of
 * `patchStructNewForAddedField` but inserts a specific value, not a default.
 */
function patchStructNewWithShapeId(ctx: CodegenContext, typeIdx: number, shapeId: number): void {
  const patch = (root: Instr[]): void => {
    const work: Instr[][] = [root];
    while (work.length > 0) {
      const arr = work.pop()!;
      for (let i = arr.length - 1; i >= 0; i--) {
        const instr = arr[i]!;
        if (instr.op === "struct.new" && (instr as { typeIdx?: number }).typeIdx === typeIdx) {
          arr.splice(i, 0, { op: "i32.const", value: shapeId } as Instr);
        }
        const anyInstr = instr as Record<string, unknown>;
        if (Array.isArray(anyInstr.body)) work.push(anyInstr.body as Instr[]);
        if (Array.isArray(anyInstr.then)) work.push(anyInstr.then as Instr[]);
        if (Array.isArray(anyInstr.else)) work.push(anyInstr.else as Instr[]);
        if (Array.isArray(anyInstr.catches)) {
          for (const c of anyInstr.catches as { body?: Instr[] }[]) {
            if (Array.isArray(c.body)) work.push(c.body);
          }
        }
        if (Array.isArray(anyInstr.catchAll)) work.push(anyInstr.catchAll as Instr[]);
      }
    }
  };
  for (const func of ctx.mod.functions) patch(func.body);
}

/**
 * Emit a __struct_field_names(externref) -> externref export.
 * For each struct type, ref.test and return a string constant with comma-separated field names.
 * Falls back to ref.null.extern for non-struct values.
 */
function emitStructFieldNamesExport(
  ctx: CodegenContext,
  fieldMap: Map<string, { typeIdx: number; fieldIdx: number; fieldType: ValType }[]>,
): void {
  // The __struct_field_names export is only consumed by a JS host runtime
  // (Object.keys / JSON.stringify / for-in introspection of opaque WasmGC
  // structs). In nativeStrings mode (auto-on for `--target wasi`) there is no
  // JS host, so the export is dead code AND its body uses `global.get` of a
  // string_constants global to push the comma-separated field names — which
  // forces a `string_constants::a,b,c` host import that fails to instantiate
  // under wasmtime (#1174). Skip emission in nativeStrings mode.
  if (ctx.nativeStrings) return;

  const mod = ctx.mod;

  // (#2009) Two arms per struct:
  //  - COLLIDING structs (have a `$shape` field, from
  //    resolveSameShapeFieldNameCollisions): read `struct.get $shape` and pick
  //    the name CSV by shape-id VALUE — disambiguates same-shape types that
  //    `ref.test` cannot tell apart.
  //  - non-colliding structs: legacy `ref.test typeIdx → own CSV` arm.
  type LegacyEntry = { typeIdx: number; names: string[] };
  type ShapeEntry = { typeIdx: number; shapeFieldIdx: number };
  const legacyEntries: LegacyEntry[] = [];
  const shapeEntries: ShapeEntry[] = [];
  for (const [structName, fields] of ctx.structFields) {
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined) continue;
    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_")
    )
      continue;

    const shapeFieldIdx = fields.findIndex((f) => f && f.name === "$shape");
    if (shapeFieldIdx >= 0 && ctx.shapeIdByStructName.has(structName)) {
      shapeEntries.push({ typeIdx, shapeFieldIdx });
      continue;
    }

    const names: string[] = [];
    for (const field of fields) {
      if (!field || !field.type || !field.name) continue;
      if (field.name.startsWith("$") || field.name.startsWith("__")) continue;
      names.push(field.name);
    }
    // (#2009 R3b) Permute to JS insertion order for spec-correct host
    // enumeration; no-op when no literal-derived order was recorded.
    const orderedNames = orderNamesByInsertion(ctx, structName, names);
    if (orderedNames.length > 0) legacyEntries.push({ typeIdx, names: orderedNames });
  }

  if (legacyEntries.length === 0 && shapeEntries.length === 0) return;

  // Register comma-separated field name strings as string constants.
  const legacyTypeIdxToGlobalIdx = new Map<number, number>();
  for (const { typeIdx, names } of legacyEntries) {
    const csv = names.join(",");
    addStringConstantGlobal(ctx, csv);
    const globalIdx = ctx.stringGlobalMap.get(csv);
    if (globalIdx !== undefined) legacyTypeIdxToGlobalIdx.set(typeIdx, globalIdx);
  }
  // One CSV global per shape-id (colliding structs share the table by VALUE).
  const shapeIdToGlobalIdx = new Map<number, number>();
  for (let id = 0; id < ctx.shapeNameCsvById.length; id++) {
    const csv = ctx.shapeNameCsvById[id]!;
    addStringConstantGlobal(ctx, csv);
    const globalIdx = ctx.stringGlobalMap.get(csv);
    if (globalIdx !== undefined) shapeIdToGlobalIdx.set(id, globalIdx);
  }

  // Build the function body: chain of ref.test / if-else returning the right string
  const getterExternTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$sfnames_type");
  const anyLocal = 1; // local 0 = externref param, local 1 = anyref conversion
  const shapeLocal = 2; // i32 scratch for the read shape-id (colliding arms)

  const body: Instr[] = [];
  body.push({ op: "local.get", index: 0 } as Instr);
  body.push({ op: "any.convert_extern" } as Instr);
  body.push({ op: "local.set", index: anyLocal } as Instr);

  // Helper: dispatch on a shape-id value (on stack) → CSV global.
  const buildShapeIdDispatch = (): Instr[] => {
    const ids = [...shapeIdToGlobalIdx.entries()];
    let chain: Instr[] = [{ op: "ref.null.extern" } as Instr];
    for (let i = ids.length - 1; i >= 0; i--) {
      const [shapeId, globalIdx] = ids[i]!;
      chain = [
        { op: "local.get", index: shapeLocal } as Instr,
        { op: "i32.const", value: shapeId } as Instr,
        { op: "i32.eq" } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [{ op: "global.get", index: globalIdx } as Instr],
          else: chain,
        } as Instr,
      ];
    }
    return [{ op: "local.set", index: shapeLocal } as Instr, ...chain];
  };

  // Build nested if-else chain: legacy arms first, then colliding $shape arms.
  let fallback: Instr[] = [{ op: "ref.null.extern" } as Instr];

  for (let i = legacyEntries.length - 1; i >= 0; i--) {
    const typeIdx = legacyEntries[i]!.typeIdx;
    const globalIdx = legacyTypeIdxToGlobalIdx.get(typeIdx);
    if (globalIdx === undefined) continue;
    fallback = [
      { op: "local.get", index: anyLocal } as Instr,
      { op: "ref.test", typeIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [{ op: "global.get", index: globalIdx } as Instr],
        else: fallback,
      } as Instr,
    ];
  }

  for (let i = shapeEntries.length - 1; i >= 0; i--) {
    const { typeIdx, shapeFieldIdx } = shapeEntries[i]!;
    const thenBranch: Instr[] = [
      { op: "local.get", index: anyLocal } as Instr,
      { op: "ref.cast", typeIdx } as Instr,
      { op: "struct.get", typeIdx, fieldIdx: shapeFieldIdx } as Instr,
      ...buildShapeIdDispatch(),
    ];
    fallback = [
      { op: "local.get", index: anyLocal } as Instr,
      { op: "ref.test", typeIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: thenBranch,
        else: fallback,
      } as Instr,
    ];
  }

  body.push(...fallback);

  const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
  if (shapeEntries.length > 0) locals.push({ name: "__shapeId", type: { kind: "i32" } });

  const funcIdx = ctx.numImportFuncs + mod.functions.length;
  mod.functions.push({
    name: "__struct_field_names",
    typeIdx: getterExternTypeIdx,
    locals,
    body,
    exported: true,
  } as WasmFunction);

  mod.exports.push({
    name: "__struct_field_names",
    desc: { kind: "func", index: funcIdx },
  });
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
      if (
        structName.startsWith("Wrapper") ||
        structName === "$AnyValue" ||
        structName.startsWith("__vec_") ||
        structName.startsWith("__arr_")
      )
        continue;

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
    body.push({ op: "any.convert_extern" } as Instr);
    body.push({ op: "local.set", index: 1 } as Instr);

    let current: Instr[] = [{ op: "ref.null.extern" } as Instr];

    for (const entry of entries) {
      const testAndCall: Instr[] = [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.cast", typeIdx: entry.typeIdx } as Instr,
        { op: "call", funcIdx: entry.funcIdx } as Instr,
      ];

      if (entry.resultType.kind === "ref" || entry.resultType.kind === "ref_null") {
        testAndCall.push({ op: "extern.convert_any" } as Instr);
      } else if (entry.resultType.kind === "f64") {
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          testAndCall.push({ op: "call", funcIdx: boxIdx } as Instr);
        }
      } else if (entry.resultType.kind === "i32") {
        testAndCall.push({ op: "f64.convert_i32_s" } as Instr);
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) {
          testAndCall.push({ op: "call", funcIdx: boxIdx } as Instr);
        }
      }
      // externref: no conversion needed

      current = [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.test", typeIdx: entry.typeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: testAndCall,
          else: current,
        } as Instr,
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
  const skipStruct = (structName: string): boolean =>
    structName.startsWith("Wrapper") ||
    structName === "$AnyValue" ||
    structName.startsWith("__vec_") ||
    structName.startsWith("__arr_");

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
      let current: Instr[] = [{ op: "i32.const", value: 0 } as Instr];
      const arm = (typeIdx: number, kind: number, tail: Instr[]): Instr[] => [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.test", typeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [{ op: "i32.const", value: kind } as Instr],
          else: tail,
        } as Instr,
      ];
      for (const e of methodEntries) current = arm(e.typeIdx, 1, current);
      for (const e of getterEntries) current = arm(e.typeIdx, 2, current);
      const exportName = `__member_kind_${key}`;
      mod.functions.push({
        name: exportName,
        typeIdx: kindTypeIdx,
        locals: [{ name: "__any", type: { kind: "anyref" } }],
        body: [
          { op: "local.get", index: 0 } as Instr,
          { op: "any.convert_extern" } as Instr,
          { op: "local.set", index: 1 } as Instr,
          ...current,
        ],
        exported: true,
      } as WasmFunction);
      mod.exports.push({ name: exportName, desc: { kind: "func", index: funcIdx } });
      ctx.funcMap.set(exportName, funcIdx);
    }

    // __call_get_<key>: run the compiled getter, box-coerce to externref.
    if (getterEntries.length > 0) {
      const funcIdx = ctx.numImportFuncs + mod.functions.length;
      let current: Instr[] = [{ op: "ref.null.extern" } as Instr];
      for (const e of getterEntries) {
        const callArm: Instr[] = [
          { op: "local.get", index: 1 } as Instr,
          { op: "ref.cast", typeIdx: e.typeIdx } as Instr,
          { op: "call", funcIdx: e.funcIdx } as Instr,
        ];
        if (e.resultType.kind === "ref" || e.resultType.kind === "ref_null") {
          callArm.push({ op: "extern.convert_any" } as Instr);
        } else if (e.resultType.kind === "f64") {
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) callArm.push({ op: "call", funcIdx: boxIdx } as Instr);
        } else if (e.resultType.kind === "i32") {
          callArm.push({ op: "f64.convert_i32_s" } as Instr);
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) callArm.push({ op: "call", funcIdx: boxIdx } as Instr);
        }
        current = [
          { op: "local.get", index: 1 } as Instr,
          { op: "ref.test", typeIdx: e.typeIdx } as Instr,
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: callArm,
            else: current,
          } as Instr,
        ];
      }
      const exportName = `__call_get_${key}`;
      mod.functions.push({
        name: exportName,
        typeIdx: dispatchTypeIdx,
        locals: [{ name: "__any", type: { kind: "anyref" } }],
        body: [
          { op: "local.get", index: 0 } as Instr,
          { op: "any.convert_extern" } as Instr,
          { op: "local.set", index: 1 } as Instr,
          ...current,
        ],
        exported: true,
      } as WasmFunction);
      mod.exports.push({ name: exportName, desc: { kind: "func", index: funcIdx } });
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
    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_")
    )
      continue;

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
  body.push({ op: "any.convert_extern" } as Instr);
  body.push({ op: "local.set", index: 2 } as Instr);

  let current: Instr[] = [{ op: "ref.null.extern" } as Instr];

  for (const entry of entries) {
    const testAndCall: Instr[] = [
      { op: "local.get", index: 2 } as Instr,
      { op: "ref.cast", typeIdx: entry.typeIdx } as Instr,
    ];
    // (#2883) Forward the ToPrimitive hint ONLY to a method that declared it.
    // A hint-less `[Symbol.toPrimitive]()` body takes a single (self/capture)
    // param; pushing the hint there is an arity mismatch that corrupts the
    // dispatcher (see entry-collection comment above).
    if (entry.takesHint) {
      testAndCall.push({ op: "local.get", index: 1 } as Instr); // hint (externref)
    }
    testAndCall.push({ op: "call", funcIdx: entry.funcIdx } as Instr);

    if (entry.resultType.kind === "ref" || entry.resultType.kind === "ref_null") {
      testAndCall.push({ op: "extern.convert_any" } as Instr);
    } else if (entry.resultType.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) testAndCall.push({ op: "call", funcIdx: boxIdx } as Instr);
    } else if (entry.resultType.kind === "i32") {
      testAndCall.push({ op: "f64.convert_i32_s" } as Instr);
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) testAndCall.push({ op: "call", funcIdx: boxIdx } as Instr);
    }

    current = [
      { op: "local.get", index: 2 } as Instr,
      { op: "ref.test", typeIdx: entry.typeIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: testAndCall,
        else: current,
      } as Instr,
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

  mod.exports.push({ name: exportName, desc: { kind: "func", index: funcIdx } });
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
    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_")
    )
      continue;
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
 * Emit __call_fn_0 export (#851): call a zero-arg WasmGC closure from JS.
 * (#1712) Thin alias over the generic N-arg emitter, which carries the
 * per-shape funcref extraction (capture-struct coverage), the #820l
 * argc/extras plumbing, and the #1896 arg coercion. The historical
 * hand-rolled body tested only one representative base-wrapper struct type,
 * which silently excluded capture-carrying closures from dispatch (their
 * struct types have no Wasm subtype relation to the 1-field base wrapper).
 */
function emitClosureCallExport(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 0);
}

/**
 * Emit __call_fn_1 export (#1090): call a one-arg WasmGC closure from JS.
 * (#1712) Thin alias over the generic N-arg emitter. Besides the per-shape
 * funcref extraction fix, this widens coverage from exactly-arity-1 to
 * arity <= 1, matching the documented `_maybeWrapCallableUnknownArity`
 * contract ("the __call_fn_N dispatcher iterates closures of arity <= N"):
 * the runtime wraps property-stored closures with the HIGHEST available
 * dispatcher, so __call_fn_1 must be able to invoke a zero-arg closure
 * (extra args dropped, #820l argc/extras plumbing included).
 */
function emitClosureCallExport1(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 1);
}

/**
 * Emit __call_fn_2 export — wraps the generic N-arg helper at arity 2.
 * Kept as a thin alias so the call-site name in `compile()` stays
 * descriptive when reading the dispatch sequence.
 */
function emitClosureCallExport2(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 2);
}

/**
 * Emit __call_fn_3 export (#1382 Phase 2): call a three-arg WasmGC closure
 * from JS. Same dispatch as __call_fn_2 but with one extra positional
 * arg, matching Array HOF callbacks `(value, index, array)`.
 */
function emitClosureCallExport3(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 3);
}

/**
 * Emit __call_fn_4 export (#1382 Phase 2): call a four-arg WasmGC closure
 * from JS. Used for `Array.prototype.reduce(cb, initial)` which invokes
 * `cb(accumulator, currentValue, currentIndex, array)`.
 */
function emitClosureCallExport4(ctx: CodegenContext): void {
  emitClosureCallExportN(ctx, 4);
}

/**
 * #1896 — Decide whether a host-supplied `externref` closure-call argument must
 * be lowered out of the extern domain before it feeds the closure's `call_ref`.
 *
 * The `__call_fn_<arity>` / `__call_fn_method_<arity>` exports take all user
 * args as `externref` (the host ABI). The lifted closure funcref, however,
 * declares each user param with the closure's *internal* ValType. Under the
 * native-strings backends a `string` param lowers to `(ref null $AnyString)`
 * (a concrete struct ref), so the raw `externref` arg mismatches `call_ref`
 * and the module fails validation. In `wasm:js-string` (gc) mode the string
 * param ValType *is* `externref`, so no conversion is needed.
 *
 * Returns true for non-extern reference param kinds (`anyref`/`eqref`/`ref`/
 * `ref_null`); false for `externref`/`ref_extern` (already extern-side) and for
 * the numeric/value kinds (handled by the f64/i32 unbox branches at the call
 * site, or simply not reference args).
 */
function needsExternToAnyForClosureParam(paramType: ValType): boolean {
  switch (paramType.kind) {
    case "anyref":
    case "eqref":
    case "ref":
    case "ref_null":
      return true;
    default:
      // externref / ref_extern (already extern), funcref, and value types.
      return false;
  }
}

/**
 * #1896 — Lower an `externref` closure-call arg into the internal ref domain
 * expected by the closure funcref's declared param ValType. `any.convert_extern`
 * moves externref → anyref (engine-level identity); for a *concrete* ref param
 * (`ref`/`ref_null` to a struct type, e.g. `(ref null $AnyString)`) a following
 * `ref.cast` narrows anyref → the exact param type so `call_ref` typechecks.
 * `anyref`/`eqref` params need no cast. Caller must have checked
 * `needsExternToAnyForClosureParam(paramType)` first.
 */
function externToClosureParamRef(paramType: ValType): Instr[] {
  const ops: Instr[] = [{ op: "any.convert_extern" } as Instr];
  if (paramType.kind === "ref") {
    ops.push({ op: "ref.cast", typeIdx: paramType.typeIdx } as Instr);
  } else if (paramType.kind === "ref_null") {
    ops.push({ op: "ref.cast_null", typeIdx: paramType.typeIdx } as Instr);
  }
  return ops;
}

/**
 * Emit __call_fn_<arity> export (#1382): call an N-arg WasmGC closure from
 * JS. Takes (externref closure, externref arg0, ..., externref arg<arity-1>)
 * and returns externref. Used by `__array_from`, `__proto_method_call`, and
 * other host shims that pass Wasm closures as JS callbacks.
 *
 * Dispatch: iterate ALL closure types whose user arity ≤ N. For each
 * matching closure, push only as many args as it declared (matches JS
 * spec's "extra args ignored" semantics for over-arity calls). Funcref-
 * type dispatch is required because V8 isorecursive canonicalization
 * collapses base wrapper struct types — only funcref types remain
 * distinct per signature.
 *
 * Locals layout:
 *   0..arity-1 = positional externref params (closure + user args)
 *   arity      = anyref (__any) — converted closure externref
 *   arity+1    = (ref null $baseWrapper) (__struct)
 *   arity+2    = funcref (__funcref)
 *
 * Returns early when no closures of arity ≤ N exist (no export emitted).
 */
function emitClosureCallExportN(ctx: CodegenContext, arity: number): void {
  const mod = ctx.mod;
  const exportName = `__call_fn_${arity}`;

  // Local index conventions for the dispatcher body. `arity` positional
  // params (closure + user args 0..arity-1) come first; auxiliary locals
  // are appended after the params.
  //
  //   0           = closure externref
  //   1..arity-1  = user arg externrefs
  //   anyLocal    = anyref (closure-as-anyref after extern.convert_any)
  //   structLocal = (ref null $baseWrapper) for the cast struct
  //   funcLocal   = funcref extracted from struct field 0
  const anyLocal = arity + 1;
  // arity + 2 is the declared-but-now-unused `__struct` slot (kept so the
  // local layout and funcLocal index stay stable after the #1712 per-shape
  // extraction removed the single representative struct cast).
  const funcLocal = arity + 3;

  let baseWrapperIdx: number | undefined;
  const seenFuncTypeIdx = new Set<number>();
  // Each entry tracks how many user args the closure declared
  // (closureArity ≤ arity). The host always invokes the dispatcher with
  // `arity` user args; when a closure declared fewer, the dispatch arm
  // drops the extra args. Matches JS spec's "extra args ignored at call
  // time" semantics.
  const entries: {
    funcTypeIdx: number;
    returnType: ValType | null;
    selfTypeIdx: number;
    closureArity: number;
  }[] = [];

  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.paramTypes.length > arity) continue;

    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;

    if (typeDef.superTypeIdx === -1 && baseWrapperIdx === undefined) {
      baseWrapperIdx = typeIdx;
    }

    if (!seenFuncTypeIdx.has(info.funcTypeIdx)) {
      seenFuncTypeIdx.add(info.funcTypeIdx);
      const funcTypeDef = mod.types[info.funcTypeIdx];
      const selfParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[0] : undefined;
      const selfTypeIdx =
        selfParam && (selfParam.kind === "ref" || selfParam.kind === "ref_null")
          ? (selfParam as { typeIdx: number }).typeIdx
          : typeIdx;
      entries.push({
        funcTypeIdx: info.funcTypeIdx,
        returnType: info.returnType,
        selfTypeIdx,
        closureArity: info.paramTypes.length,
      });
    }
  }

  if (entries.length === 0) return;

  // Fallback to any base wrapper if none was found at the target arity.
  // V8 isorecursive canonicalization collapses single-funcref-field
  // base structs to the same type regardless of arity, so any base
  // wrapper works for the initial ref.test + struct.get.
  if (baseWrapperIdx === undefined) {
    for (const [typeIdx] of ctx.closureInfoByTypeIdx) {
      const typeDef = mod.types[typeIdx];
      if (typeDef && typeDef.kind === "struct" && typeDef.superTypeIdx === -1) {
        baseWrapperIdx = typeIdx;
        break;
      }
    }
  }
  if (baseWrapperIdx === undefined) {
    for (const [typeIdx] of ctx.closureInfoByTypeIdx) {
      if (ctx.closureInfoByTypeIdx.get(typeIdx)!.paramTypes.length === arity) {
        baseWrapperIdx = typeIdx;
        break;
      }
    }
  }
  if (baseWrapperIdx === undefined) return;

  addUnionImports(ctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");

  // #820l — globals for argc + extras-argv plumbing into the callee's
  // `arguments` object. Both globals are mode-agnostic; ensureExtrasArgvGlobal
  // also returns the vec struct typeIdx whose `data` field is an externref
  // array (the same shape used by emitArgumentsVecBody on the receive side).
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  const { globalIdx: extrasArgvGlobalIdx, vecTypeIdx: extrasVecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const extrasArrTypeIdx = getArrTypeIdxFromVec(ctx, extrasVecTypeIdx);

  // __call_fn_<arity>(closure: externref, arg0: externref, ..., arg<arity-1>: externref) → externref
  const params: ValType[] = [];
  for (let i = 0; i < arity + 1; i++) params.push({ kind: "externref" });
  const exportFuncTypeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `$${exportName}_type`);
  const funcIdx = ctx.numImportFuncs + mod.functions.length;
  const bwIdx = baseWrapperIdx;

  const body: Instr[] = [];
  body.push({ op: "local.get", index: 0 });
  body.push({ op: "any.convert_extern" } as Instr);
  body.push({ op: "local.set", index: anyLocal } as Instr);

  let funcrefDispatch: Instr[] = [{ op: "ref.null.extern" } as Instr];

  for (const entry of entries) {
    const funcTypeDef = mod.types[entry.funcTypeIdx];

    const buildArgConversion = (argLocalIdx: number, paramType: ValType | undefined): Instr[] => {
      const ops: Instr[] = [{ op: "local.get", index: argLocalIdx } as Instr];
      if (paramType) {
        if (paramType.kind === "f64") {
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            ops.push({ op: "call", funcIdx: unboxIdx } as Instr);
          }
        } else if (paramType.kind === "i32") {
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            ops.push({ op: "call", funcIdx: unboxIdx } as Instr);
            ops.push({ op: "i32.trunc_f64_s" });
          }
        } else if (needsExternToAnyForClosureParam(paramType)) {
          // The host-facing param is `externref`, but the closure funcref
          // declares this reference param as a non-extern ref type (anyref or
          // a WasmGC struct ref — e.g. a native-strings `string` lowers to
          // `(ref null $AnyString)`). Lower the host externref to the internal
          // ref domain so the subsequent `call_ref` typechecks. In
          // `wasm:js-string` (gc) mode string params ARE externref, so this
          // branch is skipped and the arg passes raw.
          ops.push(...externToClosureParamRef(paramType));
        }
        // externref param: no conversion
      }
      return ops;
    };

    // Push self + user args 0..closureArity-1. Args beyond the closure's
    // declared arity are dropped (no `local.get` emitted for them).
    const argInstrs: Instr[] = [];
    for (let i = 0; i < entry.closureArity; i++) {
      const paramType =
        funcTypeDef?.kind === "func" && funcTypeDef.params.length >= i + 2 ? funcTypeDef.params[i + 1] : undefined;
      argInstrs.push(...buildArgConversion(i + 1, paramType));
    }

    // #820l — argc/extras-argv plumbing so the callee's `arguments` object
    // observes the *actual* host-passed arg count, not just `closureArity`.
    // The host invokes the dispatcher with `arity` user args at locals
    // [1..arity]; the closure declares `closureArity ≤ arity` formals. The
    // receive-side (emitArgumentsVecBody) reads __argc + __extras_argv to
    // build `arguments` with all `arity` slots populated.
    //
    // (#2745) `__argc` follows the CLAMPED-to-formals convention that
    // `emitArgumentsVecBody` (`totalLen = argc + extrasLen`),
    // `maybeSetArgcForKnownCall` (`min(actual, paramCount)`) and the inline
    // array-method plumbing all use: it is the count of FORMAL params filled
    // (`closureArity`), NOT the raw dispatcher arity. The overflow args go to
    // `__extras_argv`, so `arguments.length = argc + extrasLen = arity`. Setting
    // `__argc = arity` here instead double-counted the extras (e.g. an arity-0
    // closure called via `__call_fn_3` reported `arguments.length === 6`), which
    // broke bound-function over-arity forwarding (the bound `[[Call]]` prepends
    // partial args, so the target sees more args than its declared formals).
    const setupInstrs: Instr[] = [
      { op: "i32.const", value: entry.closureArity } as Instr,
      { op: "global.set", index: argcGlobalIdx } as Instr,
    ];
    if (arity > entry.closureArity) {
      // vec struct field order: (length: i32, data: arrRef). Push len first.
      const extrasCount = arity - entry.closureArity;
      setupInstrs.push({ op: "i32.const", value: extrasCount } as Instr);
      for (let i = entry.closureArity; i < arity; i++) {
        setupInstrs.push({ op: "local.get", index: i + 1 } as Instr);
      }
      setupInstrs.push({ op: "array.new_fixed", typeIdx: extrasArrTypeIdx, length: extrasCount } as Instr);
      setupInstrs.push({ op: "struct.new", typeIdx: extrasVecTypeIdx } as Instr);
      setupInstrs.push({ op: "global.set", index: extrasArgvGlobalIdx } as Instr);
    } else {
      // No extras for this arm — reset to avoid stale data from a prior call.
      setupInstrs.push({ op: "ref.null", typeIdx: extrasVecTypeIdx } as Instr);
      setupInstrs.push({ op: "global.set", index: extrasArgvGlobalIdx } as Instr);
    }

    const callBody: Instr[] = [
      ...setupInstrs,
      { op: "local.get", index: anyLocal } as Instr,
      { op: "ref.cast", typeIdx: entry.selfTypeIdx } as Instr,
      ...argInstrs,
      { op: "local.get", index: funcLocal } as Instr,
      { op: "ref.cast", typeIdx: entry.funcTypeIdx } as Instr,
      { op: "call_ref", typeIdx: entry.funcTypeIdx } as Instr,
    ];

    // Coerce result to externref.
    if (entry.returnType) {
      if ((ctx.standalone || ctx.wasi) && isAnyValue(entry.returnType, ctx)) {
        const anyToExternIdx = ensureAnyToExternHelper(ctx);
        if (anyToExternIdx !== undefined) {
          callBody.push({ op: "call", funcIdx: anyToExternIdx } as Instr);
        } else {
          callBody.push({ op: "extern.convert_any" } as Instr);
        }
      } else if (entry.returnType.kind === "ref" || entry.returnType.kind === "ref_null") {
        callBody.push({ op: "extern.convert_any" } as Instr);
      } else if (entry.returnType.kind === "f64") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "call", funcIdx: boxNumberIdx } as Instr);
        } else {
          callBody.push({ op: "drop" } as Instr);
          callBody.push({ op: "ref.null.extern" } as Instr);
        }
      } else if (entry.returnType.kind === "i32") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "f64.convert_i32_s" } as Instr);
          callBody.push({ op: "call", funcIdx: boxNumberIdx } as Instr);
        } else {
          callBody.push({ op: "drop" } as Instr);
          callBody.push({ op: "ref.null.extern" } as Instr);
        }
      } else if (entry.returnType.kind === "i64") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "f64.convert_i64_s" } as Instr);
          callBody.push({ op: "call", funcIdx: boxNumberIdx } as Instr);
        } else {
          callBody.push({ op: "drop" } as Instr);
          callBody.push({ op: "ref.null.extern" } as Instr);
        }
      }
    } else {
      callBody.push({ op: "ref.null.extern" } as Instr);
    }

    funcrefDispatch = [
      { op: "local.get", index: funcLocal } as Instr,
      { op: "ref.test", typeIdx: entry.funcTypeIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: callBody,
        else: funcrefDispatch,
      } as Instr,
    ];
  }

  // (#1712) Funcref extraction must succeed for EVERY closure struct shape in
  // the dispatch entries. Capture-carrying closures are emitted as standalone
  // struct types (compiler-side superTypeIdx === -1, no Wasm subtype relation
  // to the 1-field base wrapper), so the previous single
  // `ref.test <representative base>` excluded them and the dispatcher silently
  // returned null for any capturing closure — acorn's prototype methods all
  // capture their fnctor, which made every compiled `parse()` come back null.
  // Mirror `__is_closure` (collectClosureBaseWrapperTypeIdxs): chain a
  // `ref.test` per distinct self-struct shape, extracting field 0 (funcref)
  // from whichever matches. `funcLocal` stays null when nothing matches and
  // the funcref dispatch below falls through to `ref.null.extern` as before.
  body.push(...buildFuncrefExtraction(entries, anyLocal, funcLocal));
  body.push(...funcrefDispatch);

  mod.functions.push({
    name: exportName,
    typeIdx: exportFuncTypeIdx,
    locals: [
      { name: "__any", type: { kind: "anyref" } },
      { name: "__struct", type: { kind: "ref_null", typeIdx: bwIdx } },
      { name: "__funcref", type: { kind: "funcref" } },
    ],
    body,
    exported: true,
  } as WasmFunction);

  mod.exports.push({
    name: exportName,
    desc: { kind: "func", index: funcIdx },
  });
}

/**
 * (#1712) Build the funcref-extraction preamble shared by the
 * `__call_fn_<arity>` / `__call_fn_method_<arity>` dispatchers: for each
 * distinct closure self-struct shape among the dispatch entries, test the
 * anyref against the shape and, on match, store its field-0 funcref into
 * `funcLocal`. Every lifted closure struct has field 0 = funcref by
 * construction, so a value matching several canonically-equal shapes just
 * re-extracts the same funcref. Non-closure inputs match nothing and leave
 * `funcLocal` as null funcref (the dispatch chain's `ref.test`s all fail on
 * null and yield the `ref.null.extern` fallthrough).
 */
function buildFuncrefExtraction(entries: { selfTypeIdx: number }[], anyLocal: number, funcLocal: number): Instr[] {
  const out: Instr[] = [];
  const seenShape = new Set<number>();
  for (const entry of entries) {
    if (seenShape.has(entry.selfTypeIdx)) continue;
    seenShape.add(entry.selfTypeIdx);
    out.push({ op: "local.get", index: anyLocal } as Instr);
    out.push({ op: "ref.test", typeIdx: entry.selfTypeIdx } as Instr);
    out.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal } as Instr,
        { op: "ref.cast", typeIdx: entry.selfTypeIdx } as Instr,
        { op: "struct.get", typeIdx: entry.selfTypeIdx, fieldIdx: 0 } as Instr,
        { op: "local.set", index: funcLocal } as Instr,
      ],
    } as Instr);
  }
  return out;
}

/**
 * Emit `__call_fn_method_<arity>` export (#1636-S1): call an N-arg WasmGC
 * closure from JS with a host-supplied `this`-value. Signature is
 * `(thisVal: externref, closure: externref, arg0..arg<arity-1>) -> externref`.
 *
 * Dispatch shape mirrors `emitClosureCallExportN` (same funcref-type
 * iteration, same arg-coercion + return-boxing). The only difference is
 * that `thisVal` is stored in the `__current_this` module global before the
 * inner `call_ref` and restored after, so `ThisKeyword` resolution in the
 * closure body observes the host's receiver instead of the previous null
 * fallback (see `ensureCurrentThisGlobal`).
 *
 * Returns early when no closures of arity ≤ N exist (no export emitted).
 */
function emitClosureMethodCallExportN(ctx: CodegenContext, arity: number): void {
  const mod = ctx.mod;
  const exportName = `__call_fn_method_${arity}`;

  // Local index conventions for the dispatcher body:
  //   0           = thisVal externref
  //   1           = closure externref
  //   2..arity+1  = user arg externrefs (arity slots)
  //   anyLocal    = anyref (closure-as-anyref after extern.convert_any)
  //   structLocal = (ref null $baseWrapper) for the cast struct
  //   funcLocal   = funcref extracted from struct field 0
  //   prevThis    = externref save slot for nested invocations
  const totalParams = arity + 2; // thisVal + closure + N user args
  const anyLocal = totalParams;
  // totalParams + 1 is the declared-but-now-unused `__struct` slot (see the
  // #1712 per-shape extraction note in emitClosureCallExportN).
  const funcLocal = totalParams + 2;
  const prevThisLocal = totalParams + 3;

  let baseWrapperIdx: number | undefined;
  const seenFuncTypeIdx = new Set<number>();
  const entries: {
    funcTypeIdx: number;
    returnType: ValType | null;
    selfTypeIdx: number;
    closureArity: number;
  }[] = [];

  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (info.paramTypes.length > arity) continue;
    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;
    if (typeDef.superTypeIdx === -1 && baseWrapperIdx === undefined) {
      baseWrapperIdx = typeIdx;
    }
    if (!seenFuncTypeIdx.has(info.funcTypeIdx)) {
      seenFuncTypeIdx.add(info.funcTypeIdx);
      const funcTypeDef = mod.types[info.funcTypeIdx];
      const selfParam = funcTypeDef?.kind === "func" ? funcTypeDef.params[0] : undefined;
      const selfTypeIdx =
        selfParam && (selfParam.kind === "ref" || selfParam.kind === "ref_null")
          ? (selfParam as { typeIdx: number }).typeIdx
          : typeIdx;
      entries.push({
        funcTypeIdx: info.funcTypeIdx,
        returnType: info.returnType,
        selfTypeIdx,
        closureArity: info.paramTypes.length,
      });
    }
  }
  if (entries.length === 0) return;

  if (baseWrapperIdx === undefined) {
    for (const [typeIdx] of ctx.closureInfoByTypeIdx) {
      const typeDef = mod.types[typeIdx];
      if (typeDef && typeDef.kind === "struct" && typeDef.superTypeIdx === -1) {
        baseWrapperIdx = typeIdx;
        break;
      }
    }
  }
  if (baseWrapperIdx === undefined) {
    for (const [typeIdx] of ctx.closureInfoByTypeIdx) {
      if (ctx.closureInfoByTypeIdx.get(typeIdx)!.paramTypes.length === arity) {
        baseWrapperIdx = typeIdx;
        break;
      }
    }
  }
  if (baseWrapperIdx === undefined) return;

  addUnionImports(ctx);
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const currentThisGlobalIdx = ensureCurrentThisGlobal(ctx);
  // (#2745) Same #820l argc/extras plumbing as `emitClosureCallExportN`, so a
  // method-dispatched closure's `arguments` object observes over-arity args
  // (the receiver-bound bound-function `[[Call]]` / `[[Construct]]` path, and
  // any `o.m(...extra)` method call). Without this the method dispatch left
  // `__argc`/`__extras_argv` untouched, so a bound target reading
  // `arguments[i]` past its formals (e.g. `func.bind(obj)` then `newFunc(1)`)
  // never saw the extra args.
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  const { globalIdx: extrasArgvGlobalIdx, vecTypeIdx: extrasVecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const extrasArrTypeIdx = getArrTypeIdxFromVec(ctx, extrasVecTypeIdx);

  const params: ValType[] = [];
  for (let i = 0; i < totalParams; i++) params.push({ kind: "externref" });
  const exportFuncTypeIdx = addFuncType(ctx, params, [{ kind: "externref" }], `$${exportName}_type`);
  const funcIdx = ctx.numImportFuncs + mod.functions.length;
  const bwIdx = baseWrapperIdx;

  // Convert closure externref → anyref (closure is at local index 1).
  const body: Instr[] = [];
  body.push({ op: "local.get", index: 1 } as Instr);
  body.push({ op: "any.convert_extern" } as Instr);
  body.push({ op: "local.set", index: anyLocal } as Instr);

  // Save previous __current_this for nesting safety, then install thisVal.
  body.push({ op: "global.get", index: currentThisGlobalIdx } as Instr);
  body.push({ op: "local.set", index: prevThisLocal } as Instr);
  body.push({ op: "local.get", index: 0 } as Instr);
  body.push({ op: "global.set", index: currentThisGlobalIdx } as Instr);

  let funcrefDispatch: Instr[] = [{ op: "ref.null.extern" } as Instr];

  for (const entry of entries) {
    const funcTypeDef = mod.types[entry.funcTypeIdx];

    const buildArgConversion = (argLocalIdx: number, paramType: ValType | undefined): Instr[] => {
      const ops: Instr[] = [{ op: "local.get", index: argLocalIdx } as Instr];
      if (paramType) {
        if (paramType.kind === "f64") {
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            ops.push({ op: "call", funcIdx: unboxIdx } as Instr);
          }
        } else if (paramType.kind === "i32") {
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            ops.push({ op: "call", funcIdx: unboxIdx } as Instr);
            ops.push({ op: "i32.trunc_f64_s" });
          }
        } else if (needsExternToAnyForClosureParam(paramType)) {
          // See emitClosureCallExportN: a non-extern reference param (anyref /
          // WasmGC struct ref, e.g. a native-strings `string`) needs the host
          // externref lowered into the internal ref domain before `call_ref`.
          // Skipped in gc mode where string params are already externref.
          ops.push(...externToClosureParamRef(paramType));
        }
      }
      return ops;
    };

    // User args occupy locals [2..arity+1]. Push only as many as the
    // closure declared.
    const argInstrs: Instr[] = [];
    for (let i = 0; i < entry.closureArity; i++) {
      const paramType =
        funcTypeDef?.kind === "func" && funcTypeDef.params.length >= i + 2 ? funcTypeDef.params[i + 1] : undefined;
      argInstrs.push(...buildArgConversion(i + 2, paramType));
    }

    // (#2745) #820l argc/extras plumbing (clamped-to-formals convention; see
    // emitClosureCallExportN). User args are at locals [2..arity+1]; formal i is
    // at local i+2, extras are args[closureArity..arity) at locals
    // [closureArity+2 .. arity+2).
    const setupInstrs: Instr[] = [
      { op: "i32.const", value: entry.closureArity } as Instr,
      { op: "global.set", index: argcGlobalIdx } as Instr,
    ];
    if (arity > entry.closureArity) {
      const extrasCount = arity - entry.closureArity;
      setupInstrs.push({ op: "i32.const", value: extrasCount } as Instr);
      for (let i = entry.closureArity; i < arity; i++) {
        setupInstrs.push({ op: "local.get", index: i + 2 } as Instr);
      }
      setupInstrs.push({ op: "array.new_fixed", typeIdx: extrasArrTypeIdx, length: extrasCount } as Instr);
      setupInstrs.push({ op: "struct.new", typeIdx: extrasVecTypeIdx } as Instr);
      setupInstrs.push({ op: "global.set", index: extrasArgvGlobalIdx } as Instr);
    } else {
      setupInstrs.push({ op: "ref.null", typeIdx: extrasVecTypeIdx } as Instr);
      setupInstrs.push({ op: "global.set", index: extrasArgvGlobalIdx } as Instr);
    }

    const callBody: Instr[] = [
      ...setupInstrs,
      { op: "local.get", index: anyLocal } as Instr,
      { op: "ref.cast", typeIdx: entry.selfTypeIdx } as Instr,
      ...argInstrs,
      { op: "local.get", index: funcLocal } as Instr,
      { op: "ref.cast", typeIdx: entry.funcTypeIdx } as Instr,
      { op: "call_ref", typeIdx: entry.funcTypeIdx } as Instr,
    ];

    if (entry.returnType) {
      if ((ctx.standalone || ctx.wasi) && isAnyValue(entry.returnType, ctx)) {
        const anyToExternIdx = ensureAnyToExternHelper(ctx);
        if (anyToExternIdx !== undefined) {
          callBody.push({ op: "call", funcIdx: anyToExternIdx } as Instr);
        } else {
          callBody.push({ op: "extern.convert_any" } as Instr);
        }
      } else if (entry.returnType.kind === "ref" || entry.returnType.kind === "ref_null") {
        callBody.push({ op: "extern.convert_any" } as Instr);
      } else if (entry.returnType.kind === "f64") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "call", funcIdx: boxNumberIdx } as Instr);
        } else {
          callBody.push({ op: "drop" } as Instr);
          callBody.push({ op: "ref.null.extern" } as Instr);
        }
      } else if (entry.returnType.kind === "i32") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "f64.convert_i32_s" } as Instr);
          callBody.push({ op: "call", funcIdx: boxNumberIdx } as Instr);
        } else {
          callBody.push({ op: "drop" } as Instr);
          callBody.push({ op: "ref.null.extern" } as Instr);
        }
      } else if (entry.returnType.kind === "i64") {
        if (boxNumberIdx !== undefined) {
          callBody.push({ op: "f64.convert_i64_s" } as Instr);
          callBody.push({ op: "call", funcIdx: boxNumberIdx } as Instr);
        } else {
          callBody.push({ op: "drop" } as Instr);
          callBody.push({ op: "ref.null.extern" } as Instr);
        }
      }
    } else {
      callBody.push({ op: "ref.null.extern" } as Instr);
    }

    funcrefDispatch = [
      { op: "local.get", index: funcLocal } as Instr,
      { op: "ref.test", typeIdx: entry.funcTypeIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: callBody,
        else: funcrefDispatch,
      } as Instr,
    ];
  }

  // (#1712) Per-shape funcref extraction — same rationale as
  // `emitClosureCallExportN` / `buildFuncrefExtraction`: capture-carrying
  // closure structs have no Wasm subtype relation to the 1-field base
  // wrapper, so a single representative `ref.test` excluded them and every
  // capturing prototype method dispatched to null. The funcref dispatch
  // below leaves its externref result on the stack (null fallthrough when
  // `funcLocal` stayed null because no shape matched).
  body.push(...buildFuncrefExtraction(entries, anyLocal, funcLocal));
  body.push(...funcrefDispatch);

  // Restore __current_this. The result value remains on the stack as the
  // function's return value — we tee it through a local so we can restore
  // the global without disturbing the return value.
  // Stack at this point: [result : externref]
  // Strategy: store result in a local, restore global, reload result.
  // Reuse `prevThisLocal` is not safe since we still need its contents;
  // use `anyLocal` is also not safe (externref vs anyref). Add a dedicated
  // result-save slot at index `prevThisLocal + 1`.
  const resultSaveLocal = prevThisLocal + 1;
  body.push({ op: "local.set", index: resultSaveLocal } as Instr);
  body.push({ op: "local.get", index: prevThisLocal } as Instr);
  body.push({ op: "global.set", index: currentThisGlobalIdx } as Instr);
  body.push({ op: "local.get", index: resultSaveLocal } as Instr);

  mod.functions.push({
    name: exportName,
    typeIdx: exportFuncTypeIdx,
    locals: [
      { name: "__any", type: { kind: "anyref" } },
      { name: "__struct", type: { kind: "ref_null", typeIdx: bwIdx } },
      { name: "__funcref", type: { kind: "funcref" } },
      { name: "__prev_this", type: { kind: "externref" } },
      { name: "__result", type: { kind: "externref" } },
    ],
    body,
    exported: true,
  } as WasmFunction);

  mod.exports.push({
    name: exportName,
    desc: { kind: "func", index: funcIdx },
  });

  // (#1719 CPR) Register in funcMap so the in-Wasm `__drive_proto_iterator`
  // driver (filled in post-processing) can resolve `__call_fn_method_0` by name
  // and `call` it to drive a captured `Array.prototype[@@iterator]` override.
  // No-op for existing JS-host callers (they dispatch by export name).
  ctx.funcMap.set(exportName, funcIdx);
}

/**
 * Emit __is_closure(externref) -> i32 (#1504). Returns 1 if the value is a
 * registered Wasm closure struct, 0 otherwise. Used by the JS-side
 * `wrapExports` to discriminate closures from named structs / vecs so it can
 * choose between callable-wrapping (#1308) and `_wasmToPlain` marshaling
 * (#1504). No-op when the module has no closures.
 */
/* (#2175 V2-S1) `collectClosureBaseWrapperTypeIdxs` moved to the leaf module
 * `closure-classifier.ts` so `index.ts` and `dyn-read.ts` share ONE list (see
 * that file). Imported at the top of this module. */

function emitIsClosureExport(ctx: CodegenContext): void {
  const mod = ctx.mod;

  // Collect base wrapper struct types (deduped). Concrete closure subtypes
  // share their funcref signature with the base wrapper post-V8 canonicalisation,
  // so ref.test against the base catches all of them.
  const baseTypeIdxs = collectClosureBaseWrapperTypeIdxs(ctx);
  if (baseTypeIdxs.length === 0) return;

  const isClosureTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$is_closure_type");
  const funcIdx = ctx.numImportFuncs + mod.functions.length;

  // body: convert extern→any, then chained ref.test → return 1 on first match.
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" } as Instr,
    { op: "local.set", index: 1 } as Instr,
  ];
  for (const closureType of baseTypeIdxs) {
    body.push({ op: "local.get", index: 1 } as Instr);
    body.push({ op: "ref.test", typeIdx: closureType } as Instr);
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 } as Instr, { op: "return" } as Instr],
    } as Instr);
  }
  body.push({ op: "i32.const", value: 0 } as Instr);

  mod.functions.push({
    name: "__is_closure",
    typeIdx: isClosureTypeIdx,
    locals: [{ name: "__any", type: { kind: "anyref" } }],
    body,
    exported: true,
  } as WasmFunction);

  mod.exports.push({
    name: "__is_closure",
    desc: { kind: "func", index: funcIdx },
  });
}

/**
 * Emit `__is_data_struct(externref) -> i32` (#2794). Returns 1 when the value is
 * a registered **named DATA struct** (a class instance, an object literal, an AST
 * Node — anything the host can read fields off via `__sget_<field>`), 0 otherwise.
 *
 * This is the POSITIVE data-vs-closure discriminator the `_wrapForHost` proxy
 * needs (mirrors the proven `__is_vec`): its `get` trap masks ANY non-vec wasm
 * struct field value as a callable `closureBridge` whenever generic `__call_fn_N`
 * dispatchers exist, which wrongly presented acorn's `decl.id` (an Identifier
 * Node) as a function — `expr.type` read `undefined` and var-declaration parses
 * threw "Binding rvalue". `__is_closure` cannot gate the bridge because it
 * FALSE-NEGATIVES on some genuine closures (a capture-less arrow read 0 → would
 * be wrongly diverted to an object proxy → "not a function"). A POSITIVE
 * data-struct marker has no such failure mode: closure wrapper structs are NOT
 * registered in `structFields` (they live only in `closureInfoByTypeIdx`), so a
 * `ref.test` against the data-struct set returns 0 for every closure and 1 only
 * for genuine data. The set mirrors `_emitStructFieldGettersInner` exactly (the
 * same skip-list), so a struct presents as an object iff the host already has
 * field getters for it. No-op when the module has no eligible data structs.
 */
function emitIsDataStructExport(ctx: CodegenContext): void {
  const mod = ctx.mod;

  // Collect data-struct type indices (deduped), mirroring the getter emitter's
  // skip-list so the marker and the `__sget_<field>` getters cover one set.
  const dataTypeIdxs: number[] = [];
  const seen = new Set<number>();
  for (const [structName] of ctx.structFields) {
    if (
      structName.startsWith("Wrapper") ||
      structName === "$AnyValue" ||
      structName.startsWith("__vec_") ||
      structName.startsWith("__arr_")
    )
      continue;
    const typeIdx = ctx.structMap.get(structName);
    if (typeIdx === undefined || seen.has(typeIdx)) continue;
    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;
    seen.add(typeIdx);
    dataTypeIdxs.push(typeIdx);
  }
  if (dataTypeIdxs.length === 0) return;

  const isDataTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$is_data_struct_type");
  const funcIdx = ctx.numImportFuncs + mod.functions.length;

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" } as Instr,
    { op: "local.set", index: 1 } as Instr,
  ];
  for (const dataType of dataTypeIdxs) {
    body.push({ op: "local.get", index: 1 } as Instr);
    body.push({ op: "ref.test", typeIdx: dataType } as Instr);
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 } as Instr, { op: "return" } as Instr],
    } as Instr);
  }
  body.push({ op: "i32.const", value: 0 } as Instr);

  mod.functions.push({
    name: "__is_data_struct",
    typeIdx: isDataTypeIdx,
    locals: [{ name: "__any", type: { kind: "anyref" } }],
    body,
    exported: true,
  } as WasmFunction);

  mod.exports.push({
    name: "__is_data_struct",
    desc: { kind: "func", index: funcIdx },
  });
}

/**
 * #1896 — teach the standalone/WASI native `__typeof_function` and
 * `__typeof_object` helpers to recognise closure wrapper structs.
 *
 * Those helpers are synthesised by `addUnionImportsAsNativeFuncs`, which runs
 * once on the first `addUnionImports` call — frequently *mid-compile*, before
 * every closure type has been registered in `ctx.closureInfoByTypeIdx`. Baking
 * the base-wrapper set at registration time would therefore miss later-registered
 * closures. Instead we rewrite the two helper bodies HERE, at finalize, after all
 * closures are registered (same late timing as `emitIsClosureExport`). We locate
 * the functions by name in `ctx.mod.functions` and splice in `ref.test` arms over
 * the closure base wrappers — no funcIdx churn (we edit existing bodies in place).
 *
 * - `__typeof_function`: was `i32.const 0` (wrong — a stored standalone closure
 *   is callable). Now: `any.convert_extern` then chained `ref.test` over each
 *   closure base wrapper; return 1 on first match, else 0.
 * - `__typeof_object`: add a closure-base-wrapper `ref.test` guard that returns 0
 *   (a callable is `"function"`, never `"object"`) BEFORE the final non-null
 *   `i32.const 1`, so a wrapper read back from an open-object slot is not
 *   mis-classified as `"object"`.
 * - (#2175 V2-S1) `__typeof`: the MATERIALIZED typeof-result native (the tag as
 *   a NativeString VALUE, used by `const t = typeof x`). It classified
 *   null/number/boolean/bigint/string and fell through to `"object"` — with NO
 *   function arm, so a closure read back dynamically produced `"object"` while
 *   the INLINE `typeof x === "function"` compare (via the `__typeof_function`
 *   predicate above) produced `"function"`. That path-dependence is the #2984
 *   `typeof` instability and contradicts `JsTag.Function` (#2949 V1 tag
 *   fidelity). We splice a closure `ref.test` arm returning the `"function"`
 *   NativeString before the terminal `"object"` sequence, using the SAME
 *   closure base-wrapper list — one predicate, all three natives in lockstep.
 *
 * All three natives now share the single closure classifier
 * (`buildClosureRefTestArms` / `collectClosureBaseWrapperTypeIdxs`,
 * `closure-classifier.ts`) — never two divergent arm lists.
 *
 * No-op unless native-strings (the helpers only exist then) and at least one
 * closure base wrapper was registered.
 */
function fillStandaloneTypeofClosureArms(ctx: CodegenContext): void {
  if (!ctx.nativeStrings) return;
  const baseTypeIdxs = collectClosureBaseWrapperTypeIdxs(ctx);
  if (baseTypeIdxs.length === 0) return;

  const fnByName = (name: string): WasmFunction | undefined =>
    ctx.mod.functions.find((f) => (f as { name?: string }).name === name) as WasmFunction | undefined;

  // Chained `ref.test` arms over the anyref-converted param in local 0/1. Each
  // i32-predicate arm returns `matchValue` on hit. Builds from the ONE shared
  // closure-base-wrapper list (`closure-classifier.ts`).
  const closureI32Arms = (anyLocalIdx: number, matchValue: number): Instr[] =>
    buildClosureRefTestArms(ctx, anyLocalIdx, [
      { op: "i32.const", value: matchValue } as Instr,
      { op: "return" } as Instr,
    ]);

  // --- __typeof_function: param(0) externref → 1 if closure wrapper else 0.
  const tf = fnByName("__typeof_function");
  if (tf) {
    // Ensure an anyref local exists for the converted param (local index 1).
    if (tf.locals.length === 0) {
      tf.locals.push({ name: "$any_temp", type: { kind: "anyref" } });
    }
    tf.body = [
      { op: "local.get", index: 0 } as Instr,
      { op: "ref.is_null" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 } as Instr, { op: "return" } as Instr],
      } as Instr,
      { op: "local.get", index: 0 } as Instr,
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 1 } as Instr,
      ...closureI32Arms(1, 1),
      { op: "i32.const", value: 0 } as Instr,
    ];
  }

  // --- __typeof_object: insert closure-exclusion (return 0) before the trailing
  // non-null `i32.const 1`. The existing body already converts the param to
  // anyref into local 1 (`$any_temp`) for its boxed-primitive guards, so reuse it.
  const to = fnByName("__typeof_object");
  if (to) {
    const b = to.body;
    // The body ends with `{ i32.const 1 }` (the "non-null → object" fallthrough).
    // Splice the closure-exclusion arms immediately before that terminal const.
    const lastIdx = b.length - 1;
    const last = b[lastIdx] as { op?: string; value?: number } | undefined;
    if (last && last.op === "i32.const" && last.value === 1) {
      b.splice(lastIdx, 0, ...closureI32Arms(1, 0));
    }
  }

  // --- (#2175 V2-S1) __typeof (materialized result): splice a closure arm that
  // returns the `"function"` NativeString before the terminal `"object"`
  // sequence. The body converts param → anyref into local 1 (`$any_temp`)
  // before its boxed-primitive guards, and local 1 still holds it at the
  // terminal, so the arm reads local 1 exactly like the primitive guards.
  //
  // Robust splice point: the terminal is the last N instrs, where N is the
  // length of `stringConstantExternrefInstrs(ctx, "object")` (deterministic —
  // "object" was already registered when the body was built, so re-deriving it
  // yields the same length). We verify the tail's op-shape matches before
  // splicing; if `__typeof` is the `ref.null.extern` stub (no native-string
  // type) the shape check fails and we skip — self-guarding.
  const tt = fnByName("__typeof");
  if (tt && ctx.nativeStrTypeIdx >= 0) {
    const b = tt.body;
    const objTerminal = stringConstantExternrefInstrs(ctx, "object");
    const spliceAt = b.length - objTerminal.length;
    const tailMatches =
      spliceAt >= 0 &&
      objTerminal.every(
        (inst, i) => (b[spliceAt + i] as { op?: string } | undefined)?.op === (inst as { op?: string }).op,
      );
    if (tailMatches) {
      const fnArm = buildClosureRefTestArms(ctx, 1, [
        ...stringConstantExternrefInstrs(ctx, "function"),
        { op: "return" } as Instr,
      ]);
      b.splice(spliceAt, 0, ...fnArm);
    }
  }
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
      if (
        structName.startsWith("Wrapper") ||
        structName === "$AnyValue" ||
        structName.startsWith("__vec_") ||
        structName.startsWith("__arr_")
      )
        continue;

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
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx } as Instr);
        else {
          instrs.push({ op: "drop" } as Instr);
          instrs.push({ op: "ref.null.extern" } as Instr);
        }
      } else if (resultType.kind === "i32") {
        instrs.push({ op: "f64.convert_i32_s" } as Instr);
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx } as Instr);
        else {
          instrs.push({ op: "drop" } as Instr);
          instrs.push({ op: "ref.null.extern" } as Instr);
        }
      } else if (resultType.kind === "i64") {
        // i64 (BigInt) — convert to f64 then box, or drop and return null
        instrs.push({ op: "f64.convert_i64_s" } as Instr);
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) instrs.push({ op: "call", funcIdx: boxIdx } as Instr);
        else {
          instrs.push({ op: "drop" } as Instr);
          instrs.push({ op: "ref.null.extern" } as Instr);
        }
      } else if (resultType.kind === "ref" || resultType.kind === "ref_null") {
        instrs.push({ op: "extern.convert_any" } as Instr);
      }
    };

    const buildDispatch = (idx: number): Instr[] => {
      if (idx >= entries.length) return [{ op: "ref.null.extern" } as Instr];
      const entry = entries[idx]!;

      const thenInstrs: Instr[] = [];
      if (entry.mode === "standalone") {
        thenInstrs.push({ op: "local.get", index: anyLocal } as Instr, { op: "ref.cast", typeIdx: entry.typeIdx }, {
          op: "call",
          funcIdx: entry.funcIdx,
        } as Instr);
        boxResult(entry.resultType, thenInstrs);
      } else if (entry.mode === "closure-extern") {
        // (#1989) externref field holding `extern.convert_any(closureStruct)`.
        // Recover the per-instance closure: struct.get (externref) →
        // any.convert_extern → ref.cast closureType → field-0 funcref → call_ref.
        const ci = entry.closureInfo;
        const closureLocal = 2; // eqref scratch local
        thenInstrs.push(
          { op: "local.get", index: anyLocal } as Instr,
          { op: "ref.cast", typeIdx: entry.typeIdx },
          { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx } as Instr,
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
          { op: "any.convert_extern" } as Instr,
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          { op: "local.set", index: closureLocal } as Instr,
          // self-param: the closure struct
          { op: "local.get", index: closureLocal } as Instr,
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          // funcref from closure field 0
          { op: "local.get", index: closureLocal } as Instr,
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          { op: "struct.get", typeIdx: entry.closureTypeIdx, fieldIdx: 0 } as Instr,
          { op: "ref.cast", typeIdx: ci.funcTypeIdx },
          { op: "call_ref", typeIdx: ci.funcTypeIdx } as Instr,
        );
        if (!ci.returnType) {
          thenInstrs.push({ op: "ref.null.extern" } as Instr);
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
          if (ci >= fieldEntry.candidates.length) return [{ op: "ref.null.extern" } as Instr];
          const { closureTypeIdx, closureInfo } = fieldEntry.candidates[ci]!;
          // Body run when BOTH the struct cast and the funcref type match.
          const callInstrs: Instr[] = [
            // self-param: the closure struct (cast is safe — struct ref.test passed)
            { op: "local.get", index: closureLocal } as Instr,
            { op: "ref.cast", typeIdx: closureTypeIdx },
            // funcref already validated + stashed in eqrefFuncLocal
            { op: "local.get", index: eqrefFuncLocal } as Instr,
            { op: "ref.cast", typeIdx: closureInfo.funcTypeIdx },
            { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
          ];
          if (!closureInfo.returnType) {
            callInstrs.push({ op: "ref.null.extern" } as Instr);
          } else {
            boxResult(closureInfo.returnType, callInstrs);
          }
          // Guard 1: the stored closure must be (a subtype of) this candidate's
          // struct type. Guard 2: its funcref (field 0) must be this candidate's
          // func type — distinct methods can share a struct type but differ in
          // func type, so the funcref test is the real discriminator (an
          // unguarded `ref.cast funcTypeIdx` would TRAP otherwise).
          return [
            { op: "local.get", index: closureLocal } as Instr,
            { op: "ref.test", typeIdx: closureTypeIdx },
            {
              op: "if",
              blockType: { kind: "val" as const, type: { kind: "externref" as const } },
              then: [
                { op: "local.get", index: closureLocal } as Instr,
                { op: "ref.cast", typeIdx: closureTypeIdx },
                { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
                { op: "local.tee", index: eqrefFuncLocal } as Instr,
                { op: "ref.test", typeIdx: closureInfo.funcTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val" as const, type: { kind: "externref" as const } },
                  then: callInstrs,
                  else: buildCandidate(ci + 1),
                } as Instr,
              ],
              else: buildCandidate(ci + 1),
            } as Instr,
          ];
        };
        thenInstrs.push(
          { op: "local.get", index: anyLocal } as Instr,
          { op: "ref.cast", typeIdx: entry.typeIdx },
          { op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx } as Instr,
          { op: "local.set", index: closureLocal } as Instr,
          ...buildCandidate(0),
        );
      } else {
        // Closure field: extract closure, get funcref, call_ref
        const ci = entry.closureInfo;
        thenInstrs.push({ op: "local.get", index: anyLocal } as Instr, { op: "ref.cast", typeIdx: entry.typeIdx }, {
          op: "struct.get",
          typeIdx: entry.typeIdx,
          fieldIdx: entry.fieldIdx,
        } as Instr);
        // The struct.get returns the field type (eqref or ref). Store in eqref local.
        const closureLocal = 2; // eqref local
        thenInstrs.push(
          { op: "local.set", index: closureLocal } as Instr,
          // Cast eqref to closure struct type for the self-param
          { op: "local.get", index: closureLocal } as Instr,
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          // Get funcref from closure field 0
          { op: "local.get", index: closureLocal } as Instr,
          { op: "ref.cast", typeIdx: entry.closureTypeIdx },
          { op: "struct.get", typeIdx: entry.closureTypeIdx, fieldIdx: 0 } as Instr,
          { op: "ref.cast", typeIdx: ci.funcTypeIdx },
          { op: "call_ref", typeIdx: ci.funcTypeIdx } as Instr,
        );
        const retType = ci.returnType ?? { kind: "externref" as const };
        if (!ci.returnType) {
          // void — push null externref
          thenInstrs.push({ op: "ref.null.extern" } as Instr);
        } else {
          boxResult(retType, thenInstrs);
        }
      }

      return [
        { op: "local.get", index: anyLocal } as Instr,
        { op: "ref.test", typeIdx: entry.typeIdx },
        {
          op: "if",
          blockType: { kind: "val" as const, type: { kind: "externref" as const } },
          then: thenInstrs,
          else: buildDispatch(idx + 1),
        } as Instr,
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
      { op: "local.get", index: 0 } as Instr,
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: anyLocal } as Instr,
      // save __current_this, install the receiver
      { op: "global.get", index: currentThisGlobalIdx2 } as Instr,
      { op: "local.set", index: prevThisLocal2 } as Instr,
      { op: "local.get", index: 0 } as Instr,
      { op: "global.set", index: currentThisGlobalIdx2 } as Instr,
      // dispatch (leaves result externref on stack) → capture
      ...buildDispatch(0),
      { op: "local.set", index: tpResultLocal } as Instr,
      // restore __current_this, return the captured result
      { op: "local.get", index: prevThisLocal2 } as Instr,
      { op: "global.set", index: currentThisGlobalIdx2 } as Instr,
      { op: "local.get", index: tpResultLocal } as Instr,
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

/** Helper to get the kind of a struct field type */
function fields_type_kind(ctx: CodegenContext, structTypeIdx: number, fieldIdx: number): string {
  const structName = ctx.typeIdxToStructName.get(structTypeIdx);
  if (!structName) return "unknown";
  const fields = ctx.structFields.get(structName);
  if (!fields || !fields[fieldIdx]) return "unknown";
  return fields[fieldIdx]!.type.kind;
}

/**
 * Emit __vec_get(externref, i32) -> externref and __vec_len(externref) -> i32
 * exports so the runtime can iterate WasmGC vec structs that were coerced to
 * externref (e.g. arrays stored in `any`-typed variables).
 *
 * For each registered vec type, emits ref.test/ref.cast dispatch to extract
 * the length or the indexed element, boxing the result to externref.
 */
/**
 * (#2784 S3) Reserve a `__vec_push` / `__vec_pop` helper funcIdx UP FRONT so the
 * native-vec method dispatch (calls.ts) can bake the call at compile time — the
 * helper bodies are only built in the finalize `emitVecAccessExports` pass, which
 * runs AFTER the method-call site compiles. Pushes a valid placeholder body +
 * export + funcMap entry (shift-tracked); the finalize pass FILLS the body in
 * place (fill-or-build in `_emitVecAccessExportsInner`). Idempotent.
 */
export function reserveVecMethodHelper(ctx: CodegenContext, kind: "push" | "pop" | "get" | "len"): number {
  const name =
    kind === "push" ? "__vec_push" : kind === "pop" ? "__vec_pop" : kind === "len" ? "__vec_len" : "__vec_get";
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;
  const typeIdx =
    kind === "push"
      ? addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }], "$__vec_push_type")
      : kind === "pop"
        ? addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$__vec_pop_type")
        : kind === "len"
          ? addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$__vec_len_type")
          : addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "externref" }], "$__vec_get_type");
  const idx = ctx.numImportFuncs + ctx.mod.functions.length;
  // Placeholder body must match the declared result type.
  const placeholder: Instr[] =
    kind === "push" || kind === "len" ? [{ op: "i32.const", value: 0 } as Instr] : [{ op: "ref.null.extern" } as Instr];
  ctx.mod.functions.push({ name, typeIdx, locals: [], body: placeholder, exported: true } as any);
  ctx.mod.exports.push({ name, desc: { kind: "func", index: idx } });
  ctx.funcMap.set(name, idx);
  // Mark that the finalize vec-export pass must run (so the placeholder gets filled
  // even in a module that otherwise wouldn't emit vec helpers).
  ctx.usesVecValue = true;
  return idx;
}

function emitVecAccessExports(ctx: CodegenContext): void {
  // Emit vec access exports when the runtime may need to introspect WasmGC arrays:
  // - for-of iteration on non-array types (__iterator)
  // - JSON.stringify on arrays of structs (JSON_stringify)
  // - Promise combinators (Promise_all / Promise_race / Promise_allSettled /
  //   Promise_any) — runtime helper needs to materialise wasm vec iterables
  //   into JS arrays so the native engine's GetIterator can drive them per
  //   spec (#1465).
  // - #1504: wrapExports marshaling of compiled array returns to plain JS,
  //   which needs __vec_len / __vec_get unconditionally for any module that
  //   declares vec types.
  // - host-import paths that coerce a vec wrapper to externref and look up
  //   `.constructor` — the runtime extern_get handler uses `__vec_len` to
  //   identify vec wrappers and report `constructor === Array`
  //   (#1441, #1057, #779c). Without the export, `["a","b"].constructor ===
  //   Array` is silently false for split/map/filter/etc. results in modules
  //   that don't otherwise use for-of or JSON.stringify. When `__extern_get`
  //   is imported, the property-access lowering may need this discrimination
  //   for `vec.constructor` lookups: the constructor path calls `__vec_len`
  //   to positively distinguish vec wrappers from other null-prototype
  //   WasmGC structs.
  // (#2083) The final disjunct was `ctx.vecTypeMap.size === 0`, which could
  // NEVER be true: `createCodegenContext` pre-registers the `externref` + `f64`
  // vec struct types for type-index stability, so the map always has ≥ 2
  // entries. As a result these six host-glue vec exports leaked into EVERY
  // module — even arith-only / string-only programs with no arrays at all (the
  // exact case flagged in #2083). Gate on `ctx.usesVecValue` instead — set only
  // when a genuine array-usage site asks `getOrRegisterVecType` for a type (the
  // two prereg calls are excluded). The host runtime guards every
  // `exports.__vec_*` access with a `typeof === "function"` check, so a module
  // that never materialises an array is safe without them.
  if (
    !ctx.funcMap.has("__iterator") &&
    !ctx.funcMap.has("JSON_stringify") &&
    !ctx.funcMap.has("__make_iterable") &&
    !ctx.funcMap.has("Promise_all") &&
    !ctx.funcMap.has("Promise_race") &&
    !ctx.funcMap.has("Promise_allSettled") &&
    !ctx.funcMap.has("Promise_any") &&
    !ctx.funcMap.has("__crypto_get_random_values") && // (#1503)
    !ctx.funcMap.has("__extern_get") &&
    !ctx.usesVecValue
  ) {
    return;
  }
  try {
    _emitVecAccessExportsInner(ctx);
  } catch {
    // Non-fatal: if emission fails, the iterator fallback just won't work
  }
}

function _emitVecAccessExportsInner(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const vecEntries = Array.from(ctx.vecTypeMap.entries());
  if (vecEntries.length === 0) return;

  // Ensure __box_number is available for boxing f64/i32 elements in __vec_get (#854)
  addUnionImports(ctx);

  // (#2001 S1 regress) Pre-import `__get_undefined` BEFORE baking any funcIdx into
  // `__vec_len`/`__vec_get`, so the externref `$Hole → undefined` host-boundary map
  // below resolves it via funcMap and emits a real JS `undefined` (not the
  // `ref.null.extern` null fallback — null does NOT satisfy `__extern_is_undefined`,
  // so a marshaled hole would still suppress a destructuring default). Standalone /
  // native-strings returns undefined here (no host) and the map falls back to
  // `ref.null.extern`, which is the standalone undefined convention — and the host
  // marshaling path that leaks holes does not exist there anyway. Gated on
  // `usesArrayHoles` so hole-free modules add no import.
  if (ctx.usesArrayHoles) {
    ensureGetUndefined(ctx);
    flushLateImportShifts(ctx, null);
  }

  // __vec_len(externref) -> i32
  const lenTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$__vec_len_type");
  const lenFuncIdx = ctx.numImportFuncs + mod.functions.length;
  {
    // local 0 = externref param, local 1 = anyref converted
    const body: Instr[] = [];
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "any.convert_extern" } as Instr);
    body.push({ op: "local.set", index: 1 } as Instr);

    // Chain of ref.test / ref.cast for each vec type
    let current: Instr[] = [
      // Default: return 0 if no vec type matches
      { op: "i32.const", value: 0 } as Instr,
      { op: "return" } as Instr,
    ];
    for (let i = vecEntries.length - 1; i >= 0; i--) {
      const [, vecTypeIdx] = vecEntries[i]!;
      const thenBranch: Instr[] = [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
        { op: "return" } as Instr,
      ];
      current = [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.test", typeIdx: vecTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: thenBranch,
          else: current,
        } as Instr,
      ];
    }
    body.push(...current);

    // (#2773) FILL-or-build. The dynamic-index native-vec element read
    // (property-access.ts) reserves a `__vec_len` placeholder before this
    // finalize pass (so it can bake the length-guard call at compile time); fill
    // it in place if reserved, else push a fresh definition.
    const reservedLen = ctx.funcMap.get("__vec_len");
    if (reservedLen !== undefined) {
      const fn = definedFuncAt(ctx, reservedLen)! as {
        locals: { name: string; type: ValType }[];
        body: Instr[];
      };
      fn.locals = [{ name: "__any", type: { kind: "anyref" } as ValType }];
      fn.body = body;
    } else {
      mod.functions.push({
        name: "__vec_len",
        typeIdx: lenTypeIdx,
        locals: [{ name: "__any", type: { kind: "anyref" } }],
        body,
        exported: true,
      } as any);
      mod.exports.push({
        name: "__vec_len",
        desc: { kind: "func", index: lenFuncIdx },
      });
      ctx.funcMap.set("__vec_len", lenFuncIdx);
    }
  }

  // __vec_get(externref, i32) -> externref
  const getTypeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }],
    [{ kind: "externref" }],
    "$__vec_get_type",
  );
  const getFuncIdx = ctx.numImportFuncs + mod.functions.length;
  {
    // local 0 = externref param (vec), local 1 = i32 param (index), local 2 = anyref
    const body: Instr[] = [];
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "any.convert_extern" } as Instr);
    body.push({ op: "local.set", index: 2 } as Instr);

    // Chain of ref.test / ref.cast for each vec type
    let current: Instr[] = [
      // Default: return null if no vec type matches
      { op: "ref.null.extern" } as Instr,
      { op: "return" } as Instr,
    ];
    // Pre-check if __box_number is available (don't add late imports)
    const boxNumIdx = ctx.funcMap.get("__box_number");
    // (#2001 S1 regress) `__vec_get` is the chokepoint the HOST reads a vec
    // element through (`__make_iterable`'s convertToJS, `__array_entries`,
    // `wrapExports`, etc.). An externref slot may hold the `$Hole` sentinel for an
    // `any[]` literal elision; per §ToObject/Get an absent index reads as
    // `undefined`, NOT the opaque sentinel struct. Without mapping it here a hole
    // crosses the host boundary as an opaque WasmGC struct → JS sees a
    // non-`undefined` value → a destructuring `[x = d]` default (or any host-side
    // hole read) never fires (the -39 regression in PR #1838 — `f([,])` where the
    // hole is marshaled through `__make_iterable`). Map `$Hole → undefined` for
    // externref elements only, gated on `usesArrayHoles`. Pre-resolve the funcIdx
    // for the host `__get_undefined` (already imported when the module uses it;
    // `funcMap` lookup only — no late import added here) and register `$Hole`.
    const holeMapInVecGet = ctx.usesArrayHoles;
    let holeTypeIdxForGet = -1;
    if (holeMapInVecGet) {
      ensureHoleType(ctx);
      holeTypeIdxForGet = ctx.holeTypeIdx;
    }
    const getUndefIdxForGet = holeMapInVecGet ? ctx.funcMap.get("__get_undefined") : undefined;
    for (let i = vecEntries.length - 1; i >= 0; i--) {
      const [elemKey, vecTypeIdx] = vecEntries[i]!;
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) continue;
      // (#2669) The REAL backing-array element kind, not the `elemKey` string,
      // decides whether the read value needs converting to externref: a `ref_*`
      // keyed vec stores its (boxed) elements as externref already.
      const arrElemDef = ctx.mod.types[arrTypeIdx];
      const arrElemIsExternref =
        arrElemDef !== undefined &&
        arrElemDef.kind === "array" &&
        ((arrElemDef.element as ValType).kind === "externref" || (arrElemDef.element as ValType).kind === "ref_extern");
      // Skip numeric element types if __box_number is not available
      if (
        (elemKey === "f64" ||
          elemKey === "i32" ||
          elemKey === "i32_byte" ||
          elemKey === "i32_elem" || // (#2835) Int32/Uint32 element storage (split from i32_byte)
          elemKey === "i8_byte") &&
        boxNumIdx === undefined
      )
        continue;

      // Inline boxing: avoid calling addUnionImports late
      let boxInstrs: Instr[];
      if (elemKey === "externref") {
        // (#2001 S1 regress) Map a `$Hole` slot back to `undefined` before it
        // leaves to the host. `[externref] → [externref]`: tee the slot, test it
        // for `$Hole`; if it is the sentinel, substitute `undefined` (host
        // `__get_undefined` when imported, else `ref.null.extern` — the standalone
        // undefined convention), otherwise return the slot unchanged.
        if (holeMapInVecGet && holeTypeIdxForGet >= 0) {
          const undefInstrs: Instr[] =
            getUndefIdxForGet !== undefined
              ? [{ op: "call", funcIdx: getUndefIdxForGet } as Instr]
              : [{ op: "ref.null.extern" } as Instr];
          boxInstrs = [
            { op: "local.tee", index: 3 } as Instr,
            { op: "any.convert_extern" } as Instr,
            { op: "ref.test", typeIdx: holeTypeIdxForGet } as Instr,
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: undefInstrs,
              else: [{ op: "local.get", index: 3 } as Instr],
            } as Instr,
          ];
        } else {
          boxInstrs = [];
        }
      } else if (elemKey === "f64" && boxNumIdx !== undefined) {
        boxInstrs = [{ op: "call", funcIdx: boxNumIdx } as Instr];
      } else if (elemKey === "i32" && boxNumIdx !== undefined) {
        boxInstrs = [{ op: "f64.convert_i32_s" } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr];
      } else if (
        (elemKey === "i32_byte" ||
          elemKey === "i32_elem" || // (#2835) Int32/Uint32 element storage — same dynamic read as i32_byte pre-split
          elemKey === "i8_byte" ||
          elemKey === "i16_byte") &&
        boxNumIdx !== undefined
      ) {
        // ArrayBuffer/DataView/typed-array byte elements — convert unsigned then box.
        // (#2835) `i32_elem` (Int32/Uint32 element storage, split from `i32_byte`)
        // reads via the SAME generic arm i32_byte used before the split (plain
        // `array.get` below — it is NOT packed — then unsigned i32→f64 box), so the
        // dynamic-read behaviour is byte-for-byte preserved.
        // (#2593) i16_byte joins here: the GENERIC dynamic-read path (`__vec_get`,
        // for an `any`-typed read of a typed-array vec) reads the packed element
        // zero-extended; the per-VIEW signedness for the typed `a[i]` read site is
        // handled separately in property-access.ts (typedArrayViewSignedness).
        boxInstrs = [{ op: "f64.convert_i32_u" } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr];
      } else if (elemKey === "i64") {
        // i64 (BigInt) is a value type, not a ref type — extern.convert_any expects anyref.
        // Convert i64 -> f64 (lossy for large values) then box, or drop and return null.
        if (boxNumIdx !== undefined) {
          boxInstrs = [{ op: "f64.convert_i64_s" } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr];
        } else {
          boxInstrs = [{ op: "drop" } as Instr, { op: "ref.null.extern" } as Instr];
        }
      } else if (arrElemIsExternref) {
        // (#2669) A `ref_*` keyed vec (nested arrays/objects, e.g. `number[][]`)
        // lowers its backing store to `(array (mut externref))` — the elements
        // are already boxed to externref. `array.get` yields externref, so an
        // `extern.convert_any` (whose operand MUST be an anyref) is invalid Wasm.
        // Pass the externref slot through unchanged.
        boxInstrs = [];
      } else {
        boxInstrs = [{ op: "extern.convert_any" } as Instr];
      }
      const thenBranch: Instr[] = [
        // ref.cast to vec type, struct.get data array, then array.get with index
        { op: "local.get", index: 2 } as Instr,
        { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
        { op: "local.get", index: 1 } as Instr, // index
        // (#2593) Packed i8/i16 elements REQUIRE array.get_u/_s (plain array.get
        // is invalid Wasm on a packed array); read zero-extended in this generic
        // path. (#2835) `i32_byte` (the ArrayBuffer/DataView byte buffer) is now
        // ALSO packed i8 — it joins the `array.get_u` branch (its box arm already
        // does the unsigned i32→f64 conversion). `i32_elem` (Int32/Uint32 element
        // storage) and `f64` stay on plain `array.get`.
        {
          op: elemKey === "i8_byte" || elemKey === "i16_byte" || elemKey === "i32_byte" ? "array.get_u" : "array.get",
          typeIdx: arrTypeIdx,
        } as Instr,
        ...boxInstrs,
        { op: "return" } as Instr,
      ];
      current = [
        { op: "local.get", index: 2 } as Instr,
        { op: "ref.test", typeIdx: vecTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: thenBranch,
          else: current,
        } as Instr,
      ];
    }
    body.push(...current);

    // local 2 = __any (anyref). (#2001 S1 regress) When the module has holes,
    // local 3 = __hole_scratch (externref) backs the `$Hole → undefined`
    // read-boundary map (`local.tee 3` above). Declared ONLY then, so a
    // hole-free module's `__vec_get` is byte-identical to pre-fix.
    const getLocals = holeMapInVecGet
      ? [
          { name: "__any", type: { kind: "anyref" } as ValType },
          { name: "__hole_scratch", type: { kind: "externref" } as ValType },
        ]
      : [{ name: "__any", type: { kind: "anyref" } as ValType }];
    // (#2784 S3) FILL-or-build (see __vec_push). The native-vec element-read guard
    // (property-access.ts) reserves a `__vec_get` placeholder before this finalize
    // pass; fill it in place if reserved.
    const reservedGet = ctx.funcMap.get("__vec_get");
    if (reservedGet !== undefined) {
      const fn = definedFuncAt(ctx, reservedGet)! as { locals: typeof getLocals; body: Instr[] };
      fn.locals = getLocals;
      fn.body = body;
    } else {
      mod.functions.push({
        name: "__vec_get",
        typeIdx: getTypeIdx,
        locals: getLocals,
        body,
        exported: true,
      } as any);
      mod.exports.push({
        name: "__vec_get",
        desc: { kind: "func", index: getFuncIdx },
      });
      ctx.funcMap.set("__vec_get", getFuncIdx);
    }
  }

  // (#1712) Generic host-side vec MUTATORS. Compiled acorn mutates instance
  // array fields through dynamic `this` dispatch (`this.scopeStack.push(
  // new Scope(flags))` in enterScope): the receiver reaches the host's
  // __extern_method_call as an opaque vec struct, and the host cannot grow a
  // WasmGC array itself. These exports mirror the __vec_len/__vec_get
  // per-vec-type ref.test dispatch and perform the mutation on the Wasm side
  // (same grow discipline as compileArrayPush: newCap = max((len+1)*2, 4),
  // array.new_default + array.copy + struct.set). Element-kind coverage is
  // externref always, f64/i32 when __unbox_number/__box_number are imported;
  // unsupported kinds return the -1 / 0 sentinel so the runtime falls
  // through to its fail-loud TypeError instead of silently no-oping.
  const unboxNumIdx = ctx.funcMap.get("__unbox_number");
  const boxNumIdx2 = ctx.funcMap.get("__box_number");
  const mutEntries = vecEntries.filter(([elemKey]) => {
    if (elemKey === "externref") return true;
    if (elemKey === "f64" || elemKey === "i32") return unboxNumIdx !== undefined && boxNumIdx2 !== undefined;
    return false;
  });

  // __is_vec(externref) -> i32 — POSITIVE vec discriminator over ALL
  // registered vec types. `__vec_len` cannot serve this role (its not-a-vec
  // default of 0 is indistinguishable from an empty vec), and `__is_closure`
  // can FALSE-POSITIVE on a vec whose canonicalized layout collides with a
  // closure capture struct — the runtime's callable-wrapping paths consult
  // this export to veto bridging a vec into a JS function.
  {
    const isVecTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$__is_vec_type");
    const isVecFuncIdx = ctx.numImportFuncs + mod.functions.length;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 1 } as Instr,
    ];
    let current: Instr[] = [{ op: "i32.const", value: 0 } as Instr, { op: "return" } as Instr];
    for (let i = vecEntries.length - 1; i >= 0; i--) {
      const [, vecTypeIdx] = vecEntries[i]!;
      current = [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.test", typeIdx: vecTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 1 } as Instr, { op: "return" } as Instr],
          else: current,
        } as Instr,
      ];
    }
    body.push(...current);
    mod.functions.push({
      name: "__is_vec",
      typeIdx: isVecTypeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    mod.exports.push({ name: "__is_vec", desc: { kind: "func", index: isVecFuncIdx } });
  }

  // __vec_mut_supported(externref) -> i32 (1 = push/pop cover this vec's elem kind)
  {
    const supTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$__vec_mut_supported_type");
    const supFuncIdx = ctx.numImportFuncs + mod.functions.length;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 1 } as Instr,
    ];
    let current: Instr[] = [{ op: "i32.const", value: 0 } as Instr, { op: "return" } as Instr];
    for (let i = mutEntries.length - 1; i >= 0; i--) {
      const [, vecTypeIdx] = mutEntries[i]!;
      current = [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.test", typeIdx: vecTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 1 } as Instr, { op: "return" } as Instr],
          else: current,
        } as Instr,
      ];
    }
    body.push(...current);
    mod.functions.push({
      name: "__vec_mut_supported",
      typeIdx: supTypeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    mod.exports.push({ name: "__vec_mut_supported", desc: { kind: "func", index: supFuncIdx } });
  }

  // __vec_push(externref vec, externref value) -> i32 (new length, or -1 unsupported)
  {
    const pushTypeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      "$__vec_push_type",
    );
    const pushFuncIdx = ctx.numImportFuncs + mod.functions.length;
    // locals: 2 = anyref converted; per-arm typed locals appended below
    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 2 } as Instr,
    ];
    let current: Instr[] = [{ op: "i32.const", value: -1 } as Instr, { op: "return" } as Instr];
    for (let i = mutEntries.length - 1; i >= 0; i--) {
      const [elemKey, vecTypeIdx] = mutEntries[i]!;
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) continue;
      const base = 2 + locals.length; // 2 params + locals so far
      const vecL = base;
      const dataL = base + 1;
      const lenL = base + 2;
      const ncapL = base + 3;
      const ndataL = base + 4;
      locals.push(
        { name: `__vp_vec_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: vecTypeIdx } },
        { name: `__vp_data_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: arrTypeIdx } },
        { name: `__vp_len_${vecTypeIdx}`, type: { kind: "i32" } },
        { name: `__vp_ncap_${vecTypeIdx}`, type: { kind: "i32" } },
        { name: `__vp_ndata_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      );
      // value unboxing per element kind (value param is local 1)
      const valueInstrs: Instr[] =
        elemKey === "externref"
          ? [{ op: "local.get", index: 1 } as Instr]
          : elemKey === "f64"
            ? [{ op: "local.get", index: 1 } as Instr, { op: "call", funcIdx: unboxNumIdx! } as Instr]
            : [
                { op: "local.get", index: 1 } as Instr,
                { op: "call", funcIdx: unboxNumIdx! } as Instr,
                { op: "i32.trunc_sat_f64_s" } as Instr,
              ];
      const thenBranch: Instr[] = [
        { op: "local.get", index: 2 } as Instr,
        { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
        { op: "local.set", index: vecL } as Instr,
        // len
        { op: "local.get", index: vecL } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
        { op: "local.set", index: lenL } as Instr,
        // data + capacity check: cap < len+1 ?
        { op: "local.get", index: vecL } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
        { op: "local.tee", index: dataL } as Instr,
        { op: "array.len" } as Instr,
        { op: "local.get", index: lenL } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "i32.lt_s" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // ncap = max((len+1)*2, 4)
            { op: "local.get", index: lenL } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.add" } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.shl" } as Instr,
            { op: "i32.const", value: 4 } as Instr,
            { op: "local.get", index: lenL } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.add" } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.shl" } as Instr,
            { op: "i32.const", value: 4 } as Instr,
            { op: "i32.gt_s" } as Instr,
            { op: "select" } as Instr,
            { op: "local.set", index: ncapL } as Instr,
            // ndata = array.new_default(ncap); copy old; vec.data = ndata
            { op: "local.get", index: ncapL } as Instr,
            { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
            { op: "local.set", index: ndataL } as Instr,
            { op: "local.get", index: ndataL } as Instr,
            { op: "i32.const", value: 0 } as Instr,
            { op: "local.get", index: dataL } as Instr,
            { op: "i32.const", value: 0 } as Instr,
            { op: "local.get", index: lenL } as Instr,
            { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr,
            { op: "local.get", index: vecL } as Instr,
            { op: "local.get", index: ndataL } as Instr,
            { op: "ref.as_non_null" } as Instr,
            { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
            { op: "local.get", index: ndataL } as Instr,
            { op: "local.set", index: dataL } as Instr,
          ],
        } as Instr,
        // data[len] = value
        { op: "local.get", index: dataL } as Instr,
        { op: "local.get", index: lenL } as Instr,
        ...valueInstrs,
        { op: "array.set", typeIdx: arrTypeIdx } as Instr,
        // vec.length = len + 1
        { op: "local.get", index: vecL } as Instr,
        { op: "local.get", index: lenL } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
        // return len + 1
        { op: "local.get", index: lenL } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "return" } as Instr,
      ];
      current = [
        { op: "local.get", index: 2 } as Instr,
        { op: "ref.test", typeIdx: vecTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: thenBranch,
          else: current,
        } as Instr,
      ];
    }
    body.push(...current);
    // (#2784 S3) FILL-or-build. The native-vec method dispatch (calls.ts) compiles
    // BEFORE this finalize pass, so it RESERVES a `__vec_push` placeholder up front
    // (`reserveVecMethodHelper`) and bakes that funcIdx. If reserved, fill the
    // placeholder's body in place (index/export already set at reserve); else build
    // fresh and register in funcMap (shift-tracked) so a same-pass lookup resolves.
    const reservedPush = ctx.funcMap.get("__vec_push");
    if (reservedPush !== undefined) {
      const fn = definedFuncAt(ctx, reservedPush)! as { locals: typeof locals; body: Instr[] };
      fn.locals = locals;
      fn.body = body;
    } else {
      mod.functions.push({
        name: "__vec_push",
        typeIdx: pushTypeIdx,
        locals,
        body,
        exported: true,
      } as any);
      mod.exports.push({ name: "__vec_push", desc: { kind: "func", index: pushFuncIdx } });
      ctx.funcMap.set("__vec_push", pushFuncIdx);
    }
  }

  // __vec_pop(externref) -> externref (boxed last element; null.extern when
  // empty or unsupported — callers gate on __vec_mut_supported to tell apart)
  {
    const popTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$__vec_pop_type");
    const popFuncIdx = ctx.numImportFuncs + mod.functions.length;
    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 1 } as Instr,
    ];
    let current: Instr[] = [{ op: "ref.null.extern" } as Instr, { op: "return" } as Instr];
    for (let i = mutEntries.length - 1; i >= 0; i--) {
      const [elemKey, vecTypeIdx] = mutEntries[i]!;
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) continue;
      const base = 1 + locals.length; // 1 param + locals so far
      const vecL = base;
      const lenL = base + 1;
      locals.push(
        { name: `__vpop_vec_${vecTypeIdx}`, type: { kind: "ref_null", typeIdx: vecTypeIdx } },
        { name: `__vpop_len_${vecTypeIdx}`, type: { kind: "i32" } },
      );
      // (#2593) Packed i8/i16 elements need array.get_u and unsigned→f64; plain
      // `array.get` is invalid Wasm on a packed array. Generic dynamic path reads
      // zero-extended (the per-view signedness is at the typed `a[i]` site).
      // (#2835) `i32_byte` (ArrayBuffer/DataView byte buffer) is now packed i8 too
      // — same unsigned read/box. `i32_elem` (Int32/Uint32 element storage) stays
      // full-width signed (plain `array.get`), preserving its pre-split behaviour.
      const isPackedByte = elemKey === "i8_byte" || elemKey === "i16_byte" || elemKey === "i32_byte";
      const boxInstrs: Instr[] =
        elemKey === "externref"
          ? []
          : elemKey === "f64"
            ? [{ op: "call", funcIdx: boxNumIdx2! } as Instr]
            : isPackedByte
              ? [{ op: "f64.convert_i32_u" } as Instr, { op: "call", funcIdx: boxNumIdx2! } as Instr]
              : [{ op: "f64.convert_i32_s" } as Instr, { op: "call", funcIdx: boxNumIdx2! } as Instr];
      const thenBranch: Instr[] = [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
        { op: "local.set", index: vecL } as Instr,
        { op: "local.get", index: vecL } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
        { op: "local.set", index: lenL } as Instr,
        // empty → undefined
        { op: "local.get", index: lenL } as Instr,
        { op: "i32.eqz" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "ref.null.extern" } as Instr, { op: "return" } as Instr],
        } as Instr,
        // value = data[len-1] (boxed)
        { op: "local.get", index: vecL } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
        { op: "local.get", index: lenL } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.sub" } as Instr,
        { op: isPackedByte ? "array.get_u" : "array.get", typeIdx: arrTypeIdx } as Instr,
        ...boxInstrs,
        // vec.length = len - 1 (value stays beneath on the stack)
        { op: "local.get", index: vecL } as Instr,
        { op: "local.get", index: lenL } as Instr,
        { op: "i32.const", value: 1 } as Instr,
        { op: "i32.sub" } as Instr,
        { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
        { op: "return" } as Instr,
      ];
      current = [
        { op: "local.get", index: 1 } as Instr,
        { op: "ref.test", typeIdx: vecTypeIdx } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: thenBranch,
          else: current,
        } as Instr,
      ];
    }
    body.push(...current);
    // (#2784 S3) FILL-or-build (see __vec_push above).
    const reservedPop = ctx.funcMap.get("__vec_pop");
    if (reservedPop !== undefined) {
      const fn = definedFuncAt(ctx, reservedPop)! as { locals: typeof locals; body: Instr[] };
      fn.locals = locals;
      fn.body = body;
    } else {
      mod.functions.push({
        name: "__vec_pop",
        typeIdx: popTypeIdx,
        locals,
        body,
        exported: true,
      } as any);
      mod.exports.push({ name: "__vec_pop", desc: { kind: "func", index: popFuncIdx } });
      ctx.funcMap.set("__vec_pop", popFuncIdx);
    }
  }

  // (#3116) __vec_set_elem / __vec_set_len — array-exotic [[DefineOwnProperty]]
  // write-back exports (values into the vec, attributes in the sidecar — see
  // src/codegen/vec-define-writeback.ts for the full rationale). Gated on a
  // defineProperty import being present so modules that never define
  // properties stay byte-identical.
  const wantsDefineWriteback =
    ctx.funcMap.has("__defineProperty_value") ||
    ctx.funcMap.has("__defineProperty_desc") ||
    ctx.funcMap.has("__defineProperty_accessor") ||
    ctx.funcMap.has("__defineProperties");
  if (wantsDefineWriteback) {
    emitVecDefineWritebackExports(ctx, mutEntries, unboxNumIdx);
  }
}

/**
 * (#1503) Emit `__vec_set_byte(externref vec, i32 idx, i32 byte) -> ()` so
 * the JS runtime can write bytes back into a WasmGC vec struct from inside
 * `crypto.getRandomValues(...)`. Mirrors the dispatch pattern of
 * `__vec_get` / `__dv_byte_set`: ref.test against every registered vec
 * type, then ref.cast + struct.get the underlying array, then array.set the
 * element. The element-type conversion depends on the vec's element kind:
 *
 *   - "f64"      → f64.convert_i32_u then array.set       (TypedArrays — Uint8Array etc.)
 *   - "i32"      → array.set directly                     (plain JS arrays of numbers stored as i32 — rare)
 *   - "i32_byte" → array.set directly                     (ArrayBuffer / DataView backing)
 *   - other      → skipped (no safe coercion from a byte)
 *
 * Gated on `__crypto_get_random_values` being imported; otherwise we'd add
 * a dead export and bloat every module.
 */
function emitVecSetByteExport(ctx: CodegenContext): void {
  // (#1503) Originally gated on `__crypto_get_random_values` so the export
  // only appeared when crypto.getRandomValues was reachable.
  // (#1700) Now also needed by the JS-host `wrapExports` to populate freshly
  // allocated f64 vecs with Uint8Array bytes. Emit when either consumer is
  // present.
  if (!ctx.funcMap.has("__crypto_get_random_values") && !hasExportedVecParam(ctx)) return;
  try {
    _emitVecSetByteExportInner(ctx);
  } catch {
    // Non-fatal — if dispatch emission fails the runtime call will throw
    // a descriptive TypeError when the export is missing.
  }
}

function _emitVecSetByteExportInner(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const vecEntries = Array.from(ctx.vecTypeMap.entries());
  if (vecEntries.length === 0) return;

  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }],
    [],
    "$__vec_set_byte_type",
  );
  const funcIdx = ctx.numImportFuncs + mod.functions.length;

  // local 0 = vec externref, local 1 = idx i32, local 2 = byte i32, local 3 = anyref
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" } as Instr,
    { op: "local.set", index: 3 } as Instr,
  ];

  let current: Instr[] = [];
  for (let i = vecEntries.length - 1; i >= 0; i--) {
    const [elemKey, vecTypeIdx] = vecEntries[i]!;
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) continue;
    let writeInstrs: Instr[];
    if (elemKey === "f64") {
      writeInstrs = [
        { op: "local.get", index: 3 } as Instr,
        { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
        { op: "local.get", index: 1 } as Instr, // idx
        { op: "local.get", index: 2 } as Instr, // byte (i32)
        { op: "f64.convert_i32_u" } as Instr,
        { op: "array.set", typeIdx: arrTypeIdx } as Instr,
      ];
    } else if (elemKey === "i32" || elemKey === "i32_byte" || elemKey === "i32_elem") {
      // (#2835) `i32_elem` (Int32/Uint32 element storage, split from `i32_byte`)
      // takes the same direct `array.set` byte-write i32_byte used before the split
      // (the i32 slot is wide enough for a byte) — preserves crypto.getRandomValues
      // / wrapExports byte population into Int32/Uint32 vecs unchanged.
      writeInstrs = [
        { op: "local.get", index: 3 } as Instr,
        { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
        { op: "local.get", index: 1 } as Instr,
        { op: "local.get", index: 2 } as Instr,
        { op: "array.set", typeIdx: arrTypeIdx } as Instr,
      ];
    } else {
      // Element types we don't know how to write a byte to (externref,
      // i64, etc.) — skip silently. The runtime will TypeError if asked.
      continue;
    }
    current = [
      { op: "local.get", index: 3 } as Instr,
      { op: "ref.test", typeIdx: vecTypeIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...writeInstrs, { op: "return" } as Instr],
        else: current,
      } as Instr,
    ];
  }
  body.push(...current);

  mod.functions.push({
    name: "__vec_set_byte",
    typeIdx,
    locals: [{ name: "__any", type: { kind: "anyref" } }],
    body,
    exported: true,
  } as any);
  mod.exports.push({ name: "__vec_set_byte", desc: { kind: "func", index: funcIdx } });
}

/**
 * (#1700) Emit `__new_vec_f64(i32 len) -> externref` so the JS-host
 * `wrapExports` can allocate a fresh f64-element vec struct and populate it
 * with bytes from a JS `Uint8Array` argument. Without this export, callers
 * have no JS entry point to construct a `(ref null $Vec[f64])` and hit
 * "type incompatibility when transforming from/to JS" at the call boundary.
 *
 * The signature returns `externref` (not the typed vec ref) so the result
 * is opaque on the JS side — callers pass it straight back to a compiled
 * function param, which casts it to the right vec type internally.
 *
 * Gated: only emitted when (a) an `f64`-element vec is registered, AND
 * (b) at least one exported user function accepts a vec-shaped ref param.
 * Modules without TypedArray exports pay zero bytes.
 */
function emitNewVecF64Export(ctx: CodegenContext): void {
  if (!ctx.vecTypeMap.has("f64")) return;
  if (!hasExportedVecParam(ctx)) return;
  try {
    _emitNewVecF64ExportInner(ctx);
  } catch {
    // Non-fatal — if dispatch emission fails the JS-side wrapper falls
    // back to passing the raw arg (which raises the original TypeError),
    // which is no worse than the pre-#1700 baseline.
  }
}

function hasExportedVecParam(ctx: CodegenContext): boolean {
  const mod = ctx.mod;
  const vecTypeIdxs = new Set<number>(ctx.vecTypeMap.values());
  for (const exp of mod.exports) {
    if (exp.desc.kind !== "func") continue;
    const fn = definedFuncAt(ctx, exp.desc.index);
    if (!fn) continue;
    const typeDef = mod.types[fn.typeIdx];
    if (!typeDef) continue;
    // Resolve sub-type wrappers (some FuncTypeDefs are nested under SubTypeDef).
    const ft = typeDef.kind === "sub" ? typeDef.type : typeDef;
    if (ft.kind !== "func") continue;
    for (const p of ft.params) {
      if ((p.kind === "ref" || p.kind === "ref_null") && vecTypeIdxs.has(p.typeIdx)) {
        return true;
      }
    }
  }
  return false;
}

function _emitNewVecF64ExportInner(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const vecTypeIdx = ctx.vecTypeMap.get("f64")!;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return;
  // Skip if the export is already emitted (defensive — multi-source paths
  // may invoke the emit pass more than once; emitVecSetByteExport doesn't
  // guard either but is gated by funcMap which prevents a second emit).
  if (mod.exports.some((e) => e.name === "__new_vec_f64")) return;

  // Return the typed vec ref directly (NOT externref). V8 and SpiderMonkey
  // both reject the JS↔Wasm round-trip if we return externref and try to
  // pass it back to a `(ref null $Vec)` param — the boundary will not
  // narrow externref → concrete WasmGC ref. By returning the real type,
  // JS sees an opaque WasmGC handle and the engine accepts it on the way
  // back in (same type identity).
  const typeIdx = addFuncType(
    ctx,
    [{ kind: "i32" }],
    [{ kind: "ref_null", typeIdx: vecTypeIdx }],
    "$__new_vec_f64_type",
  );
  const funcIdx = ctx.numImportFuncs + mod.functions.length;

  // local 0 = len (i32 param)
  // local 1 = $arr (ref null $arr_f64) — the zero-initialised data array
  const arrRefType: ValType = { kind: "ref_null", typeIdx: arrTypeIdx };
  const body: Instr[] = [
    // arr = array.new_default $arr_f64 (len)
    { op: "local.get", index: 0 } as Instr,
    { op: "array.new_default", typeIdx: arrTypeIdx } as Instr,
    { op: "local.set", index: 1 } as Instr,
    // struct.new $Vec[f64] { length: len, data: arr }
    { op: "local.get", index: 0 } as Instr,
    { op: "local.get", index: 1 } as Instr,
    { op: "struct.new", typeIdx: vecTypeIdx } as Instr,
  ];

  mod.functions.push({
    name: "__new_vec_f64",
    typeIdx,
    locals: [{ name: "__arr", type: arrRefType }],
    body,
    exported: true,
  } as any);
  mod.exports.push({ name: "__new_vec_f64", desc: { kind: "func", index: funcIdx } });
}

/**
 * Emit DataView byte-access exports for i32_byte vec structs (#1056).
 *
 * Adds three exports that operate on ArrayBuffer/DataView backing stores:
 *   __dv_byte_len(externref) -> i32          — vec length, or -1 if not i32_byte
 *   __dv_byte_get(externref, i32) -> i32     — unsigned byte at index
 *   __dv_byte_set(externref, i32, i32) -> () — write byte at index
 *
 * The JS runtime uses these in __extern_method_call to implement
 * DataView.prototype.{get,set}{Uint,Int,Float}{8,16,32,64} and friends
 * by materializing a real DataView over a live byte array, invoking the
 * native method, and writing bytes back for setters.
 */
function emitDataViewByteExports(ctx: CodegenContext): void {
  const mod = ctx.mod;
  const byteVecTypeIdx = ctx.vecTypeMap.get("i32_byte");
  if (byteVecTypeIdx === undefined) return;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, byteVecTypeIdx);
  if (arrTypeIdx < 0) return;

  // __dv_byte_len(externref) -> i32
  {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }], "$__dv_byte_len_type");
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: byteVecTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 } as Instr,
          { op: "ref.cast", typeIdx: byteVecTypeIdx },
          { op: "struct.get", typeIdx: byteVecTypeIdx, fieldIdx: 0 },
          { op: "return" } as Instr,
        ],
        else: [],
      },
      { op: "i32.const", value: -1 } as Instr,
    ];
    mod.functions.push({
      name: "__dv_byte_len",
      typeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    mod.exports.push({ name: "__dv_byte_len", desc: { kind: "func", index: funcIdx } });
  }

  // __dv_byte_get(externref, i32) -> i32
  {
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$__dv_byte_get_type",
    );
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: byteVecTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 } as Instr,
          { op: "ref.cast", typeIdx: byteVecTypeIdx },
          { op: "struct.get", typeIdx: byteVecTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: 1 } as Instr,
          // (#2835) packed i8 backing → unsigned zero-extended byte read.
          { op: "array.get_u", typeIdx: arrTypeIdx },
          { op: "return" } as Instr,
        ],
        else: [],
      },
      { op: "i32.const", value: 0 } as Instr,
    ];
    mod.functions.push({
      name: "__dv_byte_get",
      typeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    mod.exports.push({ name: "__dv_byte_get", desc: { kind: "func", index: funcIdx } });
  }

  // __dv_byte_set(externref, i32, i32) -> ()
  {
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }],
      [],
      "$__dv_byte_set_type",
    );
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 3 },
      { op: "ref.test", typeIdx: byteVecTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 3 } as Instr,
          { op: "ref.cast", typeIdx: byteVecTypeIdx },
          { op: "struct.get", typeIdx: byteVecTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: 1 } as Instr,
          { op: "local.get", index: 2 } as Instr,
          { op: "array.set", typeIdx: arrTypeIdx },
        ],
        else: [],
      },
    ];
    mod.functions.push({
      name: "__dv_byte_set",
      typeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    mod.exports.push({ name: "__dv_byte_set", desc: { kind: "func", index: funcIdx } });
  }
}

/** Build nested if/else for struct field getter dispatch. */
function buildNestedIfElse(
  entries: { typeIdx: number; fieldIdx: number; fieldType: ValType }[],
  anyLocal: number,
  boxNumIdx: number | undefined,
  returnMode: "extern" | "f64" | "i32" = "extern",
  boxBoolIdx?: number,
): Instr[] {
  const body: Instr[] = [];

  // Convert externref to anyref and store
  body.push({ op: "local.get", index: 0 } as Instr);
  body.push({ op: "any.convert_extern" } as Instr);
  body.push({ op: "local.set", index: anyLocal } as Instr);

  // Default return value for the final else
  let defaultVal: Instr;
  let blockRetType: ValType;
  if (returnMode === "f64") {
    defaultVal = { op: "f64.const", value: 0 } as Instr;
    blockRetType = { kind: "f64" };
  } else if (returnMode === "i32") {
    defaultVal = { op: "i32.const", value: 0 } as Instr;
    blockRetType = { kind: "i32" };
  } else {
    defaultVal = { op: "ref.null.extern" } as Instr;
    blockRetType = { kind: "externref" };
  }

  // Build a chain: if (ref.test T1) { get from T1 } else if (ref.test T2) { ... } else { default }
  let current: Instr[] = [defaultVal];

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const thenBranch = buildGetterExtract(entry, anyLocal, boxNumIdx, returnMode, boxBoolIdx);

    const ifInstr: Instr = {
      op: "if",
      blockType: { kind: "val", type: blockRetType },
      then: thenBranch,
      else: current,
    };

    current = [
      { op: "local.get", index: anyLocal } as Instr,
      { op: "ref.test", typeIdx: entry.typeIdx } as Instr,
      ifInstr,
    ];
  }

  body.push(...current);
  return body;
}

/** Build the "then" branch that extracts a field from a cast struct. */
function buildGetterExtract(
  entry: { typeIdx: number; fieldIdx: number; fieldType: ValType },
  anyLocal: number,
  boxNumIdx: number | undefined,
  returnMode: "extern" | "f64" | "i32" = "extern",
  boxBoolIdx?: number,
): Instr[] {
  const then: Instr[] = [];

  // Cast anyref to the struct type
  then.push({ op: "local.get", index: anyLocal } as Instr);
  then.push({ op: "ref.cast", typeIdx: entry.typeIdx } as Instr);
  then.push({ op: "struct.get", typeIdx: entry.typeIdx, fieldIdx: entry.fieldIdx } as Instr);

  const ft = entry.fieldType;

  if (returnMode === "f64") {
    // Return f64 directly
    if (ft.kind === "f64") {
      // Already f64 — nothing to do
    } else if (ft.kind === "i32") {
      then.push({ op: "f64.convert_i32_s" } as Instr);
    } else {
      then.push({ op: "drop" } as Instr);
      then.push({ op: "f64.const", value: 0 } as Instr);
    }
  } else if (returnMode === "i32") {
    // Return i32 directly
    if (ft.kind === "i32") {
      // Already i32
    } else if (ft.kind === "f64") {
      then.push({ op: "i32.trunc_sat_f64_s" });
    } else {
      then.push({ op: "drop" } as Instr);
      then.push({ op: "i32.const", value: 0 } as Instr);
    }
  } else {
    // Return externref
    if (ft.kind === "f64") {
      if (boxNumIdx !== undefined) {
        then.push({ op: "call", funcIdx: boxNumIdx } as Instr);
      } else {
        then.push({ op: "drop" } as Instr);
        then.push({ op: "ref.null.extern" } as Instr);
      }
    } else if (ft.kind === "i32" && (ft as { boolean?: true }).boolean && boxBoolIdx !== undefined) {
      // (#1788) Boolean-branded i32 field — box as a JS boolean (not a number)
      // so `typeof o.x === "boolean"` and `o.x === true` hold on a dynamic read.
      // The raw i32 is already on the stack; `__box_boolean(i32) -> externref`.
      then.push({ op: "call", funcIdx: boxBoolIdx } as Instr);
    } else if (ft.kind === "i32") {
      then.push({ op: "f64.convert_i32_s" } as Instr);
      if (boxNumIdx !== undefined) {
        then.push({ op: "call", funcIdx: boxNumIdx } as Instr);
      } else {
        then.push({ op: "drop" } as Instr);
        then.push({ op: "ref.null.extern" } as Instr);
      }
    } else if (ft.kind === "i64") {
      then.push({ op: "drop" } as Instr);
      then.push({ op: "ref.null.extern" } as Instr);
    } else if (ft.kind === "externref" || ft.kind === "ref_extern") {
      // Already externref
    } else if (ft.kind === "ref" || ft.kind === "ref_null" || ft.kind === "anyref" || ft.kind === "eqref") {
      then.push({ op: "extern.convert_any" } as Instr);
    } else {
      then.push({ op: "drop" } as Instr);
      then.push({ op: "ref.null.extern" } as Instr);
    }
  }

  return then;
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

function collectAllSourceImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const state = createUnifiedCollectorState(sourceFile);
  forEachChild(sourceFile, (node) => unifiedVisitNode(ctx, state, node));
  finalizeUnifiedCollector(ctx, state);
}

/** Scan source for console.log/warn/error/info/debug() calls and register only needed import variants */
function collectConsoleImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const CONSOLE_METHODS = ["log", "warn", "error", "info", "debug"] as const;
  // Track needed variants per console method
  const neededByMethod = new Map<string, Set<"number" | "bool" | "string" | "externref">>();

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "console"
    ) {
      const method = node.expression.name.text;
      if (CONSOLE_METHODS.includes(method as any)) {
        if (!neededByMethod.has(method)) neededByMethod.set(method, new Set());
        const needed = neededByMethod.get(method)!;
        for (const arg of node.arguments) {
          const argType = ctx.checker.getTypeAtLocation(arg);
          if (isStringType(argType)) {
            needed.add("string");
          } else if (isBooleanType(argType)) {
            needed.add("bool");
          } else if (isNumberType(argType)) {
            needed.add("number");
          } else {
            needed.add("externref");
          }
        }
      }
    }
    forEachChild(node, visit);
  }

  // Scan all statements (including top-level code compiled into __module_init)
  forEachChild(sourceFile, visit);

  for (const method of CONSOLE_METHODS) {
    const needed = neededByMethod.get(method);
    if (!needed) continue;
    if (needed.has("number")) {
      const t = addFuncType(ctx, [{ kind: "f64" }], []);
      addImport(ctx, "env", `console_${method}_number`, { kind: "func", typeIdx: t });
    }
    if (needed.has("bool")) {
      const t = addFuncType(ctx, [{ kind: "i32" }], []);
      addImport(ctx, "env", `console_${method}_bool`, { kind: "func", typeIdx: t });
    }
    if (needed.has("string")) {
      const t = addFuncType(ctx, [{ kind: "externref" }], []);
      addImport(ctx, "env", `console_${method}_string`, { kind: "func", typeIdx: t });
    }
    if (needed.has("externref")) {
      const t = addFuncType(ctx, [{ kind: "externref" }], []);
      addImport(ctx, "env", `console_${method}_externref`, {
        kind: "func",
        typeIdx: t,
      });
    }
  }
}

/**
 * #2633 — does the source use stream-write IO that lowers, under
 * `--link node:fs`, to `node:fs` `writeSync` (console.log/warn/error,
 * process.stdout/stderr.write)? Drives the node:fs import registration in
 * `registerWasiImports`: even a program that never `import`s `node:fs`
 * explicitly needs the `node:fs` `writeSync` import the moment it writes to a
 * stream, because the std-IO write path is lowered to `node:fs` `writeSync(fd,
 * …)` (fd 1/2) — the bespoke `js2wasm:node-process` shim was retired (#2633).
 * Cheap syntactic scan — codegen lowers the calls regardless; this only decides
 * whether the `node:fs` write import is pulled in.
 */
function sourceUsesStreamWriteIo(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node)) {
      // console.log/warn/error
      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "console" &&
        (node.name.text === "log" || node.name.text === "warn" || node.name.text === "error")
      ) {
        found = true;
        return;
      }
      // process.stdout.write / process.stderr.write
      if (
        node.name.text === "write" &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "process" &&
        (node.expression.name.text === "stdout" || node.expression.name.text === "stderr")
      ) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Register WASI imports: fd_write, proc_exit, path_open, fd_close, linear memory, bump pointer global */
function registerWasiImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  // Add linear memory for string data + iovec structs.
  //
  // Layout (#1618 collision fix): page 0 (0..64KB) holds the iovec/nwritten
  // scratch (0..15) and the bump-allocated data segments for string literals
  // (`wasiAllocStringData`, from offset 1024 up). The stdin read buffer and the
  // raw-byte write scratch MUST NOT alias those data segments — previously both
  // the literal segments and the stdin buffer started at 1024, so reading stdin
  // overwrote the initialized literal/newline bytes, corrupting console.log
  // output. We now place the stdin buffer in page 1 (WASI_STDIN_BUF_START) and
  // the write scratch in page 2 (WASI_WRITE_SCRATCH_START), well above any
  // data segment, and reserve 3 pages so both regions always exist.
  if (ctx.linkNodeShims) {
    // #2633 — std-IO under `--link node:fs` is satisfied entirely by the
    // `node:fs` interface (fd-based `readSync`/`writeSync`), the faithful
    // synchronous Node primitives. The bespoke `js2wasm:node-process` shim
    // (`stdout_write`/`stderr_write`/`stdin_read`) was retired: its functions
    // were a 1:1 fd-fixed special-case of `writeSync(1|2, …)` / `readSync(0,
    // …)`, so the std-IO write path (console.log/warn/error,
    // process.stdout/stderr.write) now lowers to `node:fs` `writeSync(fd, …)`
    // with the fd pushed explicitly. `node:fs` OWNS + exports the single shared
    // linear memory.
    //
    // The shim OWNS + exports the linear memory; the user module IMPORTS it
    // (memory index 0) so the shim can read/write the user's bytes over the
    // SAME memory with no instantiation cycle (shim imports only
    // wasi_snapshot_preview1; user imports {memory + io fns} from the
    // already-instantiated shim). The user module declares NO memory and exports
    // none. `min: 3` mirrors the inline path's reservation (page 0 scratch/data,
    // page 1 stdin buffer, page 2 write scratch). The memory import MUST precede
    // the func imports below so it sits at memory-index 0 (loads/stores/
    // `memory.size`/`memory.grow` all target it). Import order within the import
    // section does not perturb the func index space — only func imports increment it.
    addImport(ctx, "node:fs", "memory", { kind: "memory", min: 3 });

    // node:fs fd-based IO funcs: readSync(fd,ptr,len)->i32 /
    // writeSync(fd,ptr,len)->i32 over the shared memory. The user module imports
    // module `"node:fs"` (declaring WHAT it needs, not the shim that provides
    // it); the `node-fs.wat` shim is one provider. `writeSync` is registered
    // whenever the program does any stream write (explicit `import { writeSync }`
    // OR console.log/process.std*.write), `readSync` whenever it imports
    // `readSync` from node:fs.
    const usesWriteSync = ctx.wasiNodeFsFuncs.has("writeSync") || sourceUsesStreamWriteIo(sourceFile);
    const usesReadSync = ctx.wasiNodeFsFuncs.has("readSync");
    if (usesReadSync || usesWriteSync) {
      const fsIoType = addFuncType(
        ctx,
        [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
        [{ kind: "i32" }],
        "$node_fs_io",
      );
      if (usesReadSync) {
        addImport(ctx, "node:fs", "readSync", { kind: "func", typeIdx: fsIoType });
        ctx.nodeFsReadSyncIdx = ctx.funcMap.get("readSync")!;
      }
      if (usesWriteSync) {
        addImport(ctx, "node:fs", "writeSync", { kind: "func", typeIdx: fsIoType });
        ctx.nodeFsWriteSyncIdx = ctx.funcMap.get("writeSync")!;
      }
    }
  } else {
    ctx.mod.memories.push({ min: 3 });
    // WASI requires the memory to be exported as "memory"
    ctx.mod.exports.push({ name: "memory", desc: { kind: "memory", index: 0 } });
  }

  // Add bump pointer global (mutable i32, starts at 0)
  // We reserve the first 1024 bytes for iovec scratch space
  const bumpGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__wasi_bump_ptr",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 1024 } as Instr],
  });
  ctx.wasiBumpPtrGlobalIdx = bumpGlobalIdx;

  // #1886 Slice B — dedicated bump pointer for linear-backed Uint8Array buffers.
  // Starts at LINEAR_U8_ARENA_START (page 4) so it never aliases the page-0
  // string-literal data segments, the page-1 stdin buffer, or the page-2 write
  // scratch. (`$__wasi_bump_ptr` above is for string-literal data and lives in
  // page 0, so it is unsuitable.) The allocator + memory growth are emitted
  // lazily on first use (see ensureLinearU8AllocHelper); the region grows on
  // demand via memory.grow, so reserving 3 pages here is still enough.
  const u8ArenaGlobalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__lin_u8_arena_ptr",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: LINEAR_U8_ARENA_START } as Instr],
  });
  ctx.linearU8ArenaGlobalIdx = u8ArenaGlobalIdx;

  // Check if source uses console.log/warn/error, process.exit, or node:fs functions
  let needsFdWrite = false;
  let needsConsoleStderr = false;
  let needsProcExit = false;
  let needsRandomGet = false;
  // #1484 — emit poll_oneoff + __wasi_sleep_ms helper when source references
  // setTimeout/setInterval/setImmediate. The bare-identifier call sites are
  // currently rejected at compile time by `rejectTimersUnderWasi`; emitting
  // the helper here keeps the infrastructure in place for the follow-up that
  // lowers timer calls to synchronous sleeps via the async scheduler.
  let needsPollOneoff = false;
  // #2632 Phase 1 — source references a timer / microtask scheduler global
  // (setTimeout/setInterval/clearTimeout/clearInterval/queueMicrotask). Drives
  // ensureTimerHeap + the run-loop reactor in emitDeferredWasiHelpers, and the
  // `getRunLoopFuncIdxForWasiStart` wiring in addWasiStartExport.
  let needsTimerHeap = false;
  // #2632 Phase 2 — source references the fd0 stdin reactor (a `__wasiStdinReadByte()`
  // call, or `process.stdin` streaming usage). Activates the multi-subscription
  // poll_oneoff (fd0 + timer) + internal stdin buffer; implies fd_read,
  // fd_fdstat_set_flags, poll_oneoff, clock_time_get, and the timer heap/run loop.
  let needsStdinReactor = false;
  // #1482: process.env.X access — register environ_get / environ_sizes_get +
  // the JS-polyfill fast-path host import.
  let needsEnviron = false;
  // (#1483) Detect Date.now / performance.now / new Date() — all routed to
  // WASI clock_time_get under --target wasi.
  let needsClockTimeGet = false;
  let needsFdRead = false;
  // #2684 — Deno synchronous stdio usage (`Deno.stdin.readSync` /
  // `Deno.{stdout,stderr}.writeSync`). Tracked separately from needsFdRead/Write
  // so the linkNodeShims recompute below can't drop the syscalls a Deno program
  // needs (Deno lowers to the DIRECT WASI path regardless of --link node:fs,
  // exactly like the raw-wasi import path). Re-asserted after that recompute.
  let denoUsesReadSync = false;
  let denoUsesWriteSync = false;

  // ctx.wasiNodeFsFuncs is populated from the original source before import preprocessing
  // (see detectNodeFsImports in compiler.ts)
  const needsPathOpen = ctx.wasiNodeFsFuncs.has("writeFileSync");

  function visit(node: ts.Node) {
    // (#2968) Any `throw` in the program can propagate uncaught to `_start`. The
    // uncaught-exception printer wired in `addWasiStartExport` renders the payload
    // to stderr via `fd_write` and calls `proc_exit(1)`, so a throwing WASI module
    // needs BOTH imports even when it does no explicit console/process I/O — a bare
    // `throw new TypeError("x")` otherwise exited 0 with no diagnostic. Registering
    // them here (during the normal import pass) keeps them in the existing WASI set
    // and avoids any late-import funcidx shift. Non-throwing modules are unaffected.
    if (ts.isThrowStatement(node)) {
      needsFdWrite = true;
      needsProcExit = true;
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const propAccess = node.expression;
      if (
        ts.isIdentifier(propAccess.expression) &&
        propAccess.expression.text === "console" &&
        ["log", "warn", "error"].includes(propAccess.name.text)
      ) {
        needsFdWrite = true;
        // #1493: console.warn/error must route to fd=2 (stderr), not fd=1 (stdout).
        if (propAccess.name.text === "warn" || propAccess.name.text === "error") {
          needsConsoleStderr = true;
        }
      }
      if (
        ts.isIdentifier(propAccess.expression) &&
        propAccess.expression.text === "process" &&
        propAccess.name.text === "exit"
      ) {
        needsProcExit = true;
      }
      // #1651: process.stdout.write(...) / process.stderr.write(...) need
      // fd_write. The callee is `process.<stream>.write` — a PropertyAccess
      // (name="write") whose receiver is itself `process.stdout|stderr`.
      if (
        propAccess.name.text === "write" &&
        ts.isPropertyAccessExpression(propAccess.expression) &&
        ts.isIdentifier(propAccess.expression.expression) &&
        propAccess.expression.expression.text === "process" &&
        (propAccess.expression.name.text === "stdout" || propAccess.expression.name.text === "stderr")
      ) {
        needsFdWrite = true;
        if (propAccess.expression.name.text === "stderr") {
          needsConsoleStderr = true;
        }
      }
      // #1322: Math.random() in WASI mode uses random_get for entropy
      if (
        ts.isIdentifier(propAccess.expression) &&
        propAccess.expression.text === "Math" &&
        propAccess.name.text === "random"
      ) {
        needsRandomGet = true;
      }
      // (#1483) Date.now() / performance.now()
      if (
        ts.isIdentifier(propAccess.expression) &&
        (propAccess.expression.text === "Date" || propAccess.expression.text === "performance") &&
        propAccess.name.text === "now"
      ) {
        needsClockTimeGet = true;
      }
    }
    // (#1483) `new Date()` (no args) defaults to current time → clock_time_get.
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date") {
      if (!node.arguments || node.arguments.length === 0) {
        needsClockTimeGet = true;
      }
    }
    // #1484 — track setTimeout/setInterval/setImmediate to drive poll_oneoff
    // helper emission. Only bare-identifier call positions count (member-name
    // positions like `obj.setTimeout` are skipped).
    // #2632 Phase 1 — setTimeout/setInterval/clearTimeout/clearInterval are now
    // LOWERED onto the timer heap + run-loop reactor (no longer rejected). They
    // require poll_oneoff (the blocking sleep), clock_time_get (monotonic now),
    // and the timer heap. queueMicrotask needs only the microtask queue, which
    // the reactor also drives, so it sets needsTimerHeap to wire the run loop.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      // A user function/local shadowing the global keeps its own semantics —
      // the reactor must NOT register/lower for it. The global timer names are
      // declared ONLY in lib .d.ts files; a user shadow has a declaration in a
      // real (.ts) source file. (Mirrors the call-site guard in calls.ts.)
      const isGlobalShadowed = (() => {
        const sym = ctx.checker.getSymbolAtLocation(node.expression);
        const decls = sym?.declarations;
        return !!decls && decls.length > 0 && !decls.every((d) => d.getSourceFile().isDeclarationFile);
      })();
      if (!isGlobalShadowed && (callee === "setTimeout" || callee === "setInterval" || callee === "setImmediate")) {
        needsPollOneoff = true;
      }
      if (!isGlobalShadowed && (callee === "setTimeout" || callee === "setInterval")) {
        needsPollOneoff = true;
        needsClockTimeGet = true;
        needsTimerHeap = true;
      }
      if (
        !isGlobalShadowed &&
        (callee === "clearTimeout" || callee === "clearInterval" || callee === "queueMicrotask")
      ) {
        needsTimerHeap = true;
      }
      // #2632 Phase 2 — `__wasiStdinReadByte()` is the internal-buffer primitive
      // exposed for the fd0 reactor (Phase 3's process.stdin Readable builds on
      // it). It activates the fd-readiness reactor + run loop. (No user shadow
      // applies — it is a js2wasm-internal name, not a lib global.)
      // #2632 Phase 3 adds three more internal stdin primitives the library
      // `process.stdin` Readable uses: read-N / available / EOF query and the
      // reactor-tick reader hook. They all activate the same fd0 reactor.
      if (
        callee === "__wasiStdinReadByte" ||
        callee === "__wasiStdinAvailable" ||
        callee === "__wasiStdinEof" ||
        callee === "__wasiStdinSetReader" ||
        callee === "__wasiStdinStop"
      ) {
        needsStdinReactor = true;
        needsFdRead = true;
        needsPollOneoff = true;
        needsClockTimeGet = true;
        needsTimerHeap = true;
      }
    }
    // #1482: detect `process.env.X` (PropertyAccessExpression nested two deep)
    // and `process.env["X"]` (ElementAccessExpression). The outer node may be
    // either form; we detect the inner `process.env` chain.
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const obj = node.expression;
      if (
        ts.isPropertyAccessExpression(obj) &&
        ts.isIdentifier(obj.expression) &&
        obj.expression.text === "process" &&
        obj.name.text === "env"
      ) {
        needsEnviron = true;
      }
    }
    // #1653: process.stdin.read(buf, offset?) → triggers fd_read import (the
    // binary, incremental Node-API stdin read). Detect the
    // `process.stdin.read(...)` call shape so fd_read is registered.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "read" &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === "stdin" &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === "process"
    ) {
      needsFdRead = true;
    }
    // #2684: Deno synchronous stdio → direct WASI fd_read/fd_write. Recognize the
    // ambient `Deno.stdin.readSync(buf)` / `Deno.{stdout,stderr}.writeSync(buf)`
    // member-call shapes so the syscalls are registered (the actual lowering is
    // in deno-api.ts; this only wires the import). Mirrors the process.stdin.read
    // and process.std*.write detection above.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === "Deno"
    ) {
      const method = node.expression.name.text;
      const stream = node.expression.expression.name.text;
      if (method === "readSync" && stream === "stdin") denoUsesReadSync = true;
      if (method === "writeSync" && (stream === "stdout" || stream === "stderr")) {
        denoUsesWriteSync = true;
      }
    }
    forEachChild(node, visit);
  }
  forEachChild(sourceFile, visit);

  // #2524 — remember whether the source needs a stream/console *write* helper
  // (console.log/warn/error, process.std*.write) independent of the syscall
  // import decision below. Under the node shims those helpers still get
  // emitted, but they call `node:fs::writeSync(fd, …)` instead of
  // `wasi_snapshot_preview1.fd_write` (#2633).
  const needsStreamWriteHelper = needsFdWrite;

  // writeFileSync also needs fd_write for the actual file data write
  if (needsPathOpen) needsFdWrite = true;

  // #2633 — under the node shims the stream/console IO path (process.std*.write,
  // console.log/warn/error) is lowered to `node:fs::writeSync` calls (registered
  // above), so it does NOT pull wasi_snapshot_preview1.fd_read/fd_write into the
  // user module. Only a file write (writeFileSync → path_open) still needs the
  // real syscalls. Recompute the syscall-import needs accordingly: keep fd_write
  // solely for the file path, and drop fd_read entirely (the `node:fs` shim owns
  // the read syscall; the hallucinated `process.stdin.read` was removed).
  if (ctx.linkNodeShims) {
    needsFdWrite = needsPathOpen;
    // #2632 Phase 2 — the fd0 reactor drives `fd_read` directly from readiness
    // (not the node-process shim's stdin_read). Keep the inline fd_read import
    // when the reactor is active; otherwise stdin flows through the shim.
    needsFdRead = needsStdinReactor;
  } else {
    // #2655 — DIRECT WASI Preview-1 path: a standalone `--target wasi` module
    // (no `--link node:fs`) that imports `readSync`/`writeSync` from node:fs
    // lowers fd-based `readSync(fd, buf, …)` / `writeSync(fd, buf, …)` straight to
    // `wasi_snapshot_preview1.fd_read` / `fd_write` (a plain BLOCKING read — NOT
    // the async reactor's non-blocking fd_read + poll_oneoff). `needsFdRead` is
    // otherwise only set by the hallucinated `process.stdin.read(...)` shape or
    // the stdin reactor; `needsFdWrite` only by console.log/process.std*.write —
    // so a bare `import { readSync, writeSync }` would have no syscall import to
    // call. Pull in the syscalls the imported bindings actually need.
    if (ctx.wasiNodeFsFuncs.has("readSync")) needsFdRead = true;
    if (ctx.wasiNodeFsFuncs.has("writeSync")) needsFdWrite = true;
  }

  // #2657 — RAW `wasi_snapshot_preview1` fd_read/fd_write import. When the source
  // imports the syscall by name (`import { fd_read, fd_write } from
  // "wasi_snapshot_preview1"`), the binding maps 1:1 to the import func, so the
  // import MUST be registered regardless of the shim/direct branch above (the
  // user wrote the syscall call explicitly). Routes the user binding to the same
  // `ctx.wasiFdReadIdx`/`wasiFdWriteIdx` — no duplicate import. This sits after
  // the linkNodeShims recompute so a raw `fd_read` import is never dropped.
  if (ctx.wasiRawImports.has("fd_read")) needsFdRead = true;
  if (ctx.wasiRawImports.has("fd_write")) needsFdWrite = true;

  // #2684 — Deno synchronous stdio lowers to the DIRECT WASI fd_read/fd_write
  // path (deno-api.ts), so its syscall imports must be registered regardless of
  // the shim/direct recompute above (mirrors the raw-wasi re-assertion). A Deno
  // program under --link node:fs is nonsensical, but this keeps the direct
  // path's imports from being dropped either way.
  if (denoUsesReadSync) needsFdRead = true;
  if (denoUsesWriteSync) needsFdWrite = true;

  // fd_write(fd: i32, iovs: i32, iovs_len: i32, nwritten: i32) -> i32
  if (needsFdWrite) {
    const fdWriteType = addFuncType(
      ctx,
      [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$wasi_fd_write",
    );
    addImport(ctx, "wasi_snapshot_preview1", "fd_write", { kind: "func", typeIdx: fdWriteType });
    ctx.wasiFdWriteIdx = ctx.funcMap.get("fd_write")!;
  }

  // proc_exit(code: i32) -> void
  if (needsProcExit) {
    const procExitType = addFuncType(ctx, [{ kind: "i32" }], [], "$wasi_proc_exit");
    addImport(ctx, "wasi_snapshot_preview1", "proc_exit", { kind: "func", typeIdx: procExitType });
    ctx.wasiProcExitIdx = ctx.funcMap.get("proc_exit")!;
  }

  // #1481: fd_read(fd, iovs, iovs_len, nread) -> errno (i32)
  if (needsFdRead) {
    const fdReadType = addFuncType(
      ctx,
      [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$wasi_fd_read",
    );
    addImport(ctx, "wasi_snapshot_preview1", "fd_read", { kind: "func", typeIdx: fdReadType });
    ctx.wasiFdReadIdx = ctx.funcMap.get("fd_read")!;
  }

  // #2632 Phase 2 — fd_fdstat_set_flags(fd, flags) -> errno (i32). Used by the
  // fd0 stdin reactor to put fd 0 in non-blocking mode so a post-readiness
  // fd_read can't block. Registered BEFORE any defined helper so its late-import
  // shift discipline matches fd_read / poll_oneoff (CLAUDE.md "addUnionImports").
  if (needsStdinReactor) {
    const setFlagsType = addFuncType(
      ctx,
      [{ kind: "i32" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$wasi_fd_fdstat_set_flags",
    );
    addImport(ctx, "wasi_snapshot_preview1", "fd_fdstat_set_flags", { kind: "func", typeIdx: setFlagsType });
    ctx.wasiFdFdstatSetFlagsIdx = ctx.funcMap.get("fd_fdstat_set_flags")!;
  }

  // #1322: random_get(buf_ptr: i32, buf_len: i32) -> errno (i32)
  // Used by `Math_random` (emitted in math-helpers.ts:emitInlineMathFunctions).
  // Registered HERE — before any defined helpers — so the late-import shift
  // bug (CLAUDE.md "addUnionImports" note) doesn't break `__str_*` indices.
  if (needsRandomGet) {
    const randomGetType = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], "$wasi_random_get");
    addImport(ctx, "wasi_snapshot_preview1", "random_get", { kind: "func", typeIdx: randomGetType });
  }

  // #1484 — poll_oneoff(in: i32, out: i32, nsubs: i32, nevents_out: i32) -> errno (i32)
  // Registered when the source contains setTimeout/setInterval/setImmediate so the
  // (in-progress) __wasi_sleep_ms helper has its underlying import wired. Must be
  // registered BEFORE any defined helpers so late-import shifts (CLAUDE.md
  // "addUnionImports" note) don't break previously-recorded function indices.
  if (needsPollOneoff) {
    const pollType = addFuncType(
      ctx,
      [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$wasi_poll_oneoff",
    );
    addImport(ctx, "wasi_snapshot_preview1", "poll_oneoff", { kind: "func", typeIdx: pollType });
    ctx.wasiPollOneoffIdx = ctx.funcMap.get("poll_oneoff")!;
  }

  // #1482: process.env access — register the WASI environ imports for protocol
  // compliance (a wasmtime host can satisfy these) AND register the JS-polyfill
  // fast-path host import. The codegen path emits a `call $__wasi_env_get_str`
  // because reconstructing a NativeString from a `KEY=VALUE` byte run inside
  // pure Wasm requires considerable scaffolding; the host-import shortcut keeps
  // the MVP scope tight. The environ_* imports stay declared so a future
  // pure-WASI implementation can swap in without changing the manifest.
  if (needsEnviron) {
    // environ_sizes_get(count_ptr: i32, buf_size_ptr: i32) -> errno (i32)
    const envSizesType = addFuncType(
      ctx,
      [{ kind: "i32" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$wasi_environ_sizes_get",
    );
    addImport(ctx, "wasi_snapshot_preview1", "environ_sizes_get", { kind: "func", typeIdx: envSizesType });
    ctx.wasiEnvironSizesGetIdx = ctx.funcMap.get("environ_sizes_get")!;

    // environ_get(envPtrs: i32, buf: i32) -> errno (i32)
    const envGetType = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }], "$wasi_environ_get");
    addImport(ctx, "wasi_snapshot_preview1", "environ_get", { kind: "func", typeIdx: envGetType });
    ctx.wasiEnvironGetIdx = ctx.funcMap.get("environ_get")!;

    // env::__wasi_env_get_str(key: externref) -> externref
    // JS-polyfill fast path. The polyfill maps this to `process.env[key]`.
    const envGetStrType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }], "$wasi_env_get_str_t");
    addImport(ctx, "env", "__wasi_env_get_str", { kind: "func", typeIdx: envGetStrType });
    ctx.wasiEnvGetStrIdx = ctx.funcMap.get("__wasi_env_get_str")!;
  }

  // (#1483) clock_time_get(clockid: i32, precision: i64, out_ptr: i32) -> errno (i32)
  // Used by Date.now() / performance.now() / new Date() under --target wasi.
  // Registered BEFORE any defined helpers so its late-import-shift discipline
  // matches `random_get` (see CLAUDE.md "addUnionImports" note).
  if (needsClockTimeGet) {
    const clockType = addFuncType(
      ctx,
      [{ kind: "i32" }, { kind: "i64" }, { kind: "i32" }],
      [{ kind: "i32" }],
      "$wasi_clock_time_get",
    );
    addImport(ctx, "wasi_snapshot_preview1", "clock_time_get", { kind: "func", typeIdx: clockType });
    ctx.wasiClockTimeGetIdx = ctx.funcMap.get("clock_time_get")!;
  }

  // path_open(fd: i32, dirflags: i32, path: i32, path_len: i32, oflags: i32,
  //           rights_base: i64, rights_inheriting: i64, fdflags: i32, fd_out: i32) -> i32
  if (needsPathOpen) {
    const pathOpenType = addFuncType(
      ctx,
      [
        { kind: "i32" }, // fd (dirfd)
        { kind: "i32" }, // dirflags
        { kind: "i32" }, // path ptr
        { kind: "i32" }, // path len
        { kind: "i32" }, // oflags
        { kind: "i64" }, // rights_base
        { kind: "i64" }, // rights_inheriting
        { kind: "i32" }, // fdflags
        { kind: "i32" }, // fd_out ptr
      ],
      [{ kind: "i32" }],
      "$wasi_path_open",
    );
    addImport(ctx, "wasi_snapshot_preview1", "path_open", { kind: "func", typeIdx: pathOpenType });
    ctx.wasiPathOpenIdx = ctx.funcMap.get("path_open")!;

    // fd_close(fd: i32) -> i32
    const fdCloseType = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }], "$wasi_fd_close");
    addImport(ctx, "wasi_snapshot_preview1", "fd_close", { kind: "func", typeIdx: fdCloseType });
    ctx.wasiFdCloseIdx = ctx.funcMap.get("fd_close")!;
  }

  // (#1483) Stash pending-helper flags. We emit WASI helper *functions*
  // AFTER `collectExternDeclarations` has registered any lib.es5.d.ts globals
  // (eval / parseInt / etc.) — emitting them earlier would seed funcMap with
  // entries pointing at indices that the subsequent direct `addImport` calls
  // silently shift past, corrupting later lookups (e.g. `__wasi_write_string`
  // referenced by `ensureWasiWriteI32Helper` during user-code compilation).
  // #2524 — the console/stream write helper is emitted whenever the source
  // writes to stdout/stderr, even when the node-process shim diverts the actual
  // syscall (so `needsFdWrite` was recomputed to the file-only need above).
  if (needsFdWrite || needsStreamWriteHelper) {
    ctx.wasiPendingFdWriteHelper = true;
  }
  if (needsConsoleStderr) {
    ctx.wasiPendingConsoleStderrHelper = true;
  }
  if (needsPathOpen) {
    ctx.wasiPendingPathOpenHelper = true;
  }
  if (needsClockTimeGet) {
    ctx.wasiClockHelpersPending = true;
  }
  if (needsPollOneoff) {
    ctx.wasiPendingSleepMsHelper = true;
  }
  // #2632 Phase 1 — defer timer-heap + run-loop registration to
  // emitDeferredWasiHelpers (after __wasi_sleep_ms + clock_time_get are
  // registered, before user bodies compile), so __timer_add / __timer_cancel
  // func indices referenced at timer call sites are final.
  if (needsTimerHeap) {
    ctx.wasiPendingTimerHeap = true;
  }
  // #2632 Phase 2 — activate the fd0 stdin reactor before timer-heap registration
  // (so the run-loop body builds in the fd-reactor shape).
  if (needsStdinReactor) {
    ctx.wasiPendingStdinReactor = true;
  }
}

/**
 * (#1483) Emit deferred WASI helper functions. Called after
 * `collectExternDeclarations` (and any other direct-`addImport` callers)
 * have registered all module imports, so the funcMap entries written here
 * are stable for subsequent lookups by lazily-registered helpers.
 */
export function emitDeferredWasiHelpers(ctx: CodegenContext): void {
  if (!ctx.wasi) return;
  if (ctx.wasiPendingFdWriteHelper && !ctx.funcMap.has("__wasi_write_string")) {
    emitWasiWriteStringHelper(ctx);
    // #1493: also register __wasi_write_string_stderr (fd=2) for console.warn/error.
    if (ctx.wasiPendingConsoleStderrHelper) {
      emitWasiWriteStringStderrHelper(ctx);
    }
  }
  if (ctx.wasiPendingPathOpenHelper && !ctx.funcMap.has("__wasi_write_file_sync")) {
    emitWasiWriteFileSyncHelper(ctx);
  }
  if (ctx.wasiClockHelpersPending && !ctx.funcMap.has("__wasi_date_now")) {
    emitWasiClockHelpers(ctx);
  }

  // #1484 — Register __wasi_sleep_ms(ms: i32) helper that builds a CLOCK
  // subscription and calls poll_oneoff. Currently unused (timer call sites
  // are rejected by rejectTimersUnderWasi); the follow-up issue wires the
  // async scheduler to call this for setTimeout/await sleep().
  if (ctx.wasiPendingSleepMsHelper && !ctx.funcMap.has("__wasi_sleep_ms")) {
    emitWasiSleepMsHelper(ctx);
  }

  // #2632 Phase 2 — activate the fd0 stdin reactor BEFORE ensureTimerHeap so the
  // run-loop body is built in the multi-sub-poll / internal-buffer shape and the
  // Phase-2 globals + helpers (`__rl_stdin_drain`, `__rl_poll_fd0_or_clock`)
  // register at stable func indices ahead of `__run_event_loop`.
  if (ctx.wasiPendingStdinReactor) {
    enableStdinReactor(ctx);
  }

  // #2632 Phase 1 — register the timer heap + run-loop reactor. MUST run after
  // __wasi_sleep_ms (the run loop calls it) and clock_time_get registration
  // (for __rl_now_ns), and BEFORE user bodies compile so the __timer_add /
  // __timer_cancel func indices baked into timer call sites are final.
  if (ctx.wasiPendingTimerHeap && !ctx.funcMap.has("__run_event_loop")) {
    ensureTimerHeap(ctx);
  }
}

/**
 * (#1483) Emit __wasi_date_now() -> f64 and __wasi_performance_now() -> f64
 * helpers. Both wrap `clock_time_get` from wasi_snapshot_preview1.
 *
 * Memory scratch layout (after the path_open / fd_write 0..15 region):
 *   [16..23] = i64 nanosecond timestamp for CLOCK_REALTIME (Date.now)
 *   [24..31] = i64 nanosecond timestamp for CLOCK_MONOTONIC (performance.now)
 */
function emitWasiClockHelpers(ctx: CodegenContext): void {
  const helperTypeIdx = addFuncType(ctx, [], [{ kind: "f64" }]);

  /**
   * Build the body that, after `clock_time_get` has written an i64 LE
   * nanosecond count at `outPtr`, recombines it into a single i64 on the
   * stack via two unsigned i32 loads. (We avoid `i64.load` because the
   * current binary emitter does not support it.)
   *
   * Stack effect: pushes i64 ns.
   */
  function buildI64NsFromMem(outPtr: number): Instr[] {
    return [
      // hi32 << 32
      { op: "i32.const", value: outPtr + 4 } as Instr,
      { op: "i32.load", align: 2, offset: 0 } as Instr,
      { op: "i64.extend_i32_u" } as Instr,
      { op: "i64.const", value: 32n },
      { op: "i64.shl" } as Instr,
      // | lo32
      { op: "i32.const", value: outPtr } as Instr,
      { op: "i32.load", align: 2, offset: 0 } as Instr,
      { op: "i64.extend_i32_u" } as Instr,
      { op: "i64.or" } as Instr,
    ];
  }

  // __wasi_date_now() — CLOCK_REALTIME (0). Out-ptr lives at scratch[16..23].
  {
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.funcMap.set("__wasi_date_now", funcIdx);
    const body: Instr[] = [
      // clock_time_get(CLOCK_REALTIME=0, precision=1_000_000ns=1ms, out_ptr=16) -> errno
      { op: "i32.const", value: 0 } as Instr,
      { op: "i64.const", value: 1000000n },
      { op: "i32.const", value: 16 } as Instr,
      { op: "call", funcIdx: ctx.wasiClockTimeGetIdx! } as Instr,
      { op: "drop" } as Instr, // ignore errno
      ...buildI64NsFromMem(16),
      // i64 ns → f64 ms (signed convert OK: i64 ns range is good for ~292y past 1970)
      { op: "f64.convert_i64_s" } as Instr,
      { op: "f64.const", value: 1e6 } as Instr,
      { op: "f64.div" } as Instr,
    ];
    ctx.mod.functions.push({
      name: "__wasi_date_now",
      typeIdx: helperTypeIdx,
      locals: [],
      body,
      exported: false,
    });
  }

  // __wasi_performance_now() — CLOCK_MONOTONIC (1). Out-ptr lives at scratch[24..31].
  {
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.funcMap.set("__wasi_performance_now", funcIdx);
    const body: Instr[] = [
      { op: "i32.const", value: 1 } as Instr, // CLOCK_MONOTONIC
      { op: "i64.const", value: 1000n }, // precision = 1us
      { op: "i32.const", value: 24 } as Instr,
      { op: "call", funcIdx: ctx.wasiClockTimeGetIdx! } as Instr,
      { op: "drop" } as Instr,
      ...buildI64NsFromMem(24),
      { op: "f64.convert_i64_s" } as Instr,
      { op: "f64.const", value: 1e6 } as Instr,
      { op: "f64.div" } as Instr,
    ];
    ctx.mod.functions.push({
      name: "__wasi_performance_now",
      typeIdx: helperTypeIdx,
      locals: [],
      body,
      exported: false,
    });
  }
}

/** Emit __wasi_write_string(ptr: i32, len: i32) helper that calls fd_write(1, iov, 1, nwritten) */
function emitWasiWriteStringHelper(ctx: CodegenContext): void {
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_write_string", funcIdx);

  // Parameters: 0=ptr, 1=len
  // #2633 — under the node shims, delegate to the imported `node:fs`
  // `writeSync(fd=1, ptr, len)` (the shim owns the iovec/syscall); no fd_write
  // import exists in the user module.
  const body: Instr[] = ctx.linkNodeShims
    ? [
        { op: "i32.const", value: 1 } as Instr, // fd = stdout
        { op: "local.get", index: 0 } as Instr,
        { op: "local.get", index: 1 } as Instr,
        { op: "call", funcIdx: ctx.nodeFsWriteSyncIdx } as Instr,
        { op: "drop" } as Instr, // drop bytes-written
      ]
    : [
        // iovec at memory[0]: { buf_ptr: i32, buf_len: i32 }; nwritten at memory[8]
        // Store ptr at memory[0] (iovec.buf)
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.get", index: 0 } as Instr,
        { op: "i32.store", align: 2, offset: 0 } as Instr,
        // Store len at memory[4] (iovec.buf_len)
        { op: "i32.const", value: 4 } as Instr,
        { op: "local.get", index: 1 } as Instr,
        { op: "i32.store", align: 2, offset: 0 } as Instr,
        // Call fd_write(fd=1, iovs=0, iovs_len=1, nwritten=8)
        { op: "i32.const", value: 1 } as Instr, // fd = stdout
        { op: "i32.const", value: 0 } as Instr, // iovs pointer
        { op: "i32.const", value: 1 } as Instr, // iovs_len = 1
        { op: "i32.const", value: 8 } as Instr, // nwritten pointer
        { op: "call", funcIdx: ctx.wasiFdWriteIdx } as Instr,
        { op: "drop" } as Instr, // drop the return value (errno)
      ];

  ctx.mod.functions.push({
    name: "__wasi_write_string",
    typeIdx: funcTypeIdx,
    locals: [],
    body,
    exported: false,
  });
}

/**
 * #1493: Emit __wasi_write_string_stderr(ptr: i32, len: i32) helper that calls
 * fd_write(2, iov, 1, nwritten). Used by console.warn / console.error so their
 * output lands on stderr (matching Node/V8 semantics and enabling `2>&1` / `2>err`).
 */
function emitWasiWriteStringStderrHelper(ctx: CodegenContext): void {
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_write_string_stderr", funcIdx);

  // Parameters: 0=ptr, 1=len
  // #2633 — under the node shims, delegate to the imported `node:fs`
  // `writeSync(fd=2, ptr, len)` (returns bytes-written → drop).
  const body: Instr[] = ctx.linkNodeShims
    ? [
        { op: "i32.const", value: 2 } as Instr, // fd = stderr
        { op: "local.get", index: 0 } as Instr,
        { op: "local.get", index: 1 } as Instr,
        { op: "call", funcIdx: ctx.nodeFsWriteSyncIdx } as Instr,
        { op: "drop" } as Instr, // drop bytes-written
      ]
    : [
        // iovec at memory[0]: { buf_ptr: i32, buf_len: i32 }; nwritten at memory[8]
        // Store ptr at memory[0] (iovec.buf)
        { op: "i32.const", value: 0 } as Instr,
        { op: "local.get", index: 0 } as Instr,
        { op: "i32.store", align: 2, offset: 0 } as Instr,
        // Store len at memory[4] (iovec.buf_len)
        { op: "i32.const", value: 4 } as Instr,
        { op: "local.get", index: 1 } as Instr,
        { op: "i32.store", align: 2, offset: 0 } as Instr,
        // Call fd_write(fd=2, iovs=0, iovs_len=1, nwritten=8)
        { op: "i32.const", value: 2 } as Instr, // fd = stderr
        { op: "i32.const", value: 0 } as Instr, // iovs pointer
        { op: "i32.const", value: 1 } as Instr, // iovs_len = 1
        { op: "i32.const", value: 8 } as Instr, // nwritten pointer
        { op: "call", funcIdx: ctx.wasiFdWriteIdx } as Instr,
        { op: "drop" } as Instr, // drop the return value (errno)
      ];

  ctx.mod.functions.push({
    name: "__wasi_write_string_stderr",
    typeIdx: funcTypeIdx,
    locals: [],
    body,
    exported: false,
  });
}

/**
 * WASI linear-memory layout constants (#1618 collision fix).
 *
 * The iovec lives at memory[0..7] and nwritten at memory[8..11] (shared by all
 * __wasi_write_* helpers). String-literal data segments are bump-allocated in
 * page 0 from offset 1024 (`wasiAllocStringData`). To avoid aliasing those
 * segments, the stdin read buffer and the raw-byte write scratch live in
 * dedicated higher pages:
 *   - WASI_STDIN_BUF_START  = 64KB  (page 1) — fd_read accumulation buffer
 *   - WASI_WRITE_SCRATCH_START = 128KB (page 2) — fd_write staging buffer
 * `registerWasiImports` reserves 3 pages so both always exist.
 */
export const WASI_STDIN_BUF_START = 64 * 1024;
export const WASI_WRITE_SCRATCH_START = 128 * 1024;

/**
 * #2807 — maximum byte length of a SINGLE `fd_write` iovec. wasmtime (verified
 * v46.0.1) rejects a one-iovec `fd_write` whose length is at/above ~128 MiB
 * (empirically the cap is `len <= 0x07FFFFF8`; `len >= 0x07FFFFF9` returns errno
 * 48 / `ENOMEM` with `nwritten = 0`, identically for a redirected file and a
 * pipe — wasmtime bounds the guest→host buffer it stages per write, so this is a
 * fixed structural cap, NOT real memory pressure). Because the `__wasi_write_*`
 * tails mapped a non-zero errno to "0 bytes", a single `process.stdout.write` of
 * a ≥128 MiB Native-Messaging body wrote ZERO bytes and the host exited 0 with
 * no output (the nm_node_process 128-MiB silent-failure of #2807).
 *
 * 64 MiB sits a comfortable 2× below the cap and is confirmed to write fully on
 * both a file and a pipe; the chunk count for even a 256 MiB body is trivial (4),
 * dwarfed by the per-byte GC→scratch staging copy, so there is no perf cost.
 */
export const WASI_FD_WRITE_MAX_CHUNK = 64 * 1024 * 1024;

/**
 * #2655 — DIRECT `readSync` iovec + nread scratch (page 0). The blocking
 * `wasi_snapshot_preview1.fd_read(fd, iovs, iovs_len, nread)` syscall needs a
 * `{ base, len }` iovec (8 bytes) and a `nread` out-slot (4 bytes) in linear
 * memory. These deliberately use DEDICATED page-0 offsets — NOT the async
 * reactor's `RL_FDREAD_IOV_OFFSET` (324) / `RL_FDREAD_NREAD_OFFSET` (332) — so a
 * program that uses BOTH synchronous `readSync` AND the async stdin reactor
 * never has its two iovec scratches alias. They sit above the reactor's
 * 160–336 poll/iovec region and below the 1024 string-literal data base, so
 * they collide with neither the iovec write scratch (0–24), the reactor, nor any
 * string-literal segment. The read DATA lands in the page-1 stdin buffer
 * (`WASI_STDIN_BUF_START`) for the GC-array copy path, or straight into the
 * caller's `ptr+offset` for the linear-backed zero-copy path.
 */
export const WASI_READSYNC_IOV_OFFSET = 340;
export const WASI_READSYNC_NREAD_OFFSET = 348;

/**
 * #1886 Slice B — start of the linear-backed `Uint8Array` arena (page 4,
 * 256 KiB). It sits above the page-2 write scratch with page 3 left as a guard,
 * so a proven-I/O-only buffer never aliases the iovec scratch, string-literal
 * data, the stdin buffer, or the write scratch. The arena grows on demand via
 * `memory.grow` in `__lin_u8_alloc`.
 */
const LINEAR_U8_ARENA_START = 256 * 1024;

/**
 * #2524 Phase 1 — emit the "write `len` bytes starting at linear `srcConst`
 * to fd `fd`, discarding the result" tail used by the GC-buffer / string
 * `__wasi_write_*` helpers. `len` is read from the named local index.
 *
 * Inline (default) path: build the iovec at memory[0..7] pointing at
 * `srcConst`, call `fd_write(fd, iovs=0, iovs_len=1, nwritten=8)`, drop errno.
 *
 * Shim path (`ctx.linkNodeShims`): call the imported `node:fs`
 * `writeSync(fd, srcConst, len)` directly — the shim owns the iovec + syscall
 * over the shared memory. `writeSync` returns bytes-written (dropped). (#2633)
 */
function emitWasiWriteTail(ctx: CodegenContext, fd: number, srcConst: number, lenLocalIdx: number): Instr[] {
  if (ctx.linkNodeShims) {
    return [
      { op: "i32.const", value: fd } as Instr,
      { op: "i32.const", value: srcConst } as Instr,
      { op: "local.get", index: lenLocalIdx } as Instr,
      { op: "call", funcIdx: ctx.nodeFsWriteSyncIdx } as Instr,
      { op: "drop" } as Instr, // drop bytes-written
    ];
  }
  // #2807 — route the direct-WASI write through the chunked `__wasi_fd_write_all`
  // helper so a ≥128 MiB buffer (a large Native-Messaging frame) is written in
  // bounded pieces below wasmtime's single-iovec cap, instead of one oversized
  // fd_write that returns errno 48 and silently drops every byte. The helper is
  // pre-created at the top of each `__wasi_write_*` helper (and by any inline
  // caller), so this lookup never pushes a function mid-body — keeping the
  // outer helper's reserved funcidx stable.
  const writeAllIdx = ensureWasiFdWriteAllHelper(ctx);
  if (writeAllIdx >= 0) {
    return [
      { op: "i32.const", value: fd } as Instr,
      { op: "i32.const", value: srcConst } as Instr,
      { op: "local.get", index: lenLocalIdx } as Instr,
      { op: "call", funcIdx: writeAllIdx } as Instr,
      { op: "drop" } as Instr, // drop total bytes-written
    ];
  }
  return [
    // iovec.buf = srcConst at memory[0]
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.const", value: srcConst } as Instr,
    { op: "i32.store", align: 2, offset: 0 } as Instr,
    // iovec.buf_len = len at memory[4]
    { op: "i32.const", value: 4 } as Instr,
    { op: "local.get", index: lenLocalIdx } as Instr,
    { op: "i32.store", align: 2, offset: 0 } as Instr,
    // fd_write(fd, iovs=0, iovs_len=1, nwritten=8)
    { op: "i32.const", value: fd } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.const", value: 8 } as Instr,
    { op: "call", funcIdx: ctx.wasiFdWriteIdx } as Instr,
    { op: "drop" } as Instr,
  ];
}

/**
 * #2807 — ensure the `__wasi_fd_write_all(fd, ptr, len) -> i32` helper exists and
 * return its function index (lazy). It writes `len` bytes from linear `ptr` to
 * `fd` in bounded chunks of at most {@link WASI_FD_WRITE_MAX_CHUNK}, advancing by
 * the ACTUAL `nwritten` each iteration so a kernel short-write is handled too,
 * until all bytes are written. Stops on a non-zero errno or a zero-progress write
 * (never loops forever). Returns the total bytes written.
 *
 * This is the single point that defeats wasmtime's ~128 MiB single-`fd_write`
 * cap (see {@link WASI_FD_WRITE_MAX_CHUNK}). It is a no-op (`-1`) under the
 * node-shim write path (`ctx.linkNodeShims`) — that path forwards to the shim's
 * own `writeSync` — and when no direct `fd_write` is registered.
 *
 * The iovec at memory[0..7] and nwritten at memory[8..11] are the same page-0
 * scratch slots the inline tail used; callers stage the data into `ptr` and grow
 * memory before calling, so this helper only loops the syscall.
 */
export function ensureWasiFdWriteAllHelper(ctx: CodegenContext): number {
  if (!ctx.wasi || ctx.linkNodeShims || ctx.wasiFdWriteIdx === undefined) return -1;
  const helperName = "__wasi_fd_write_all";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  // params: fd(0), ptr(1), len(2); locals: base(3), remaining(4), total(5),
  // chunk(6), errno(7), nw(8)
  const FD = 0;
  const PTR = 1;
  const LEN = 2;
  const BASE = 3;
  const REMAINING = 4;
  const TOTAL = 5;
  const CHUNK = 6;
  const ERRNO = 7;
  const NW = 8;

  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  const loopBody: Instr[] = [
    // if (remaining <= 0) break out of the block
    { op: "local.get", index: REMAINING } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.le_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
    // chunk = min(remaining, MAX_CHUNK) = remaining < MAX ? remaining : MAX
    { op: "local.get", index: REMAINING } as Instr,
    { op: "i32.const", value: WASI_FD_WRITE_MAX_CHUNK } as Instr,
    { op: "local.get", index: REMAINING } as Instr,
    { op: "i32.const", value: WASI_FD_WRITE_MAX_CHUNK } as Instr,
    { op: "i32.lt_s" } as Instr,
    { op: "select" } as Instr,
    { op: "local.set", index: CHUNK } as Instr,
    // iovec.buf = base at memory[0]
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.get", index: BASE } as Instr,
    { op: "i32.store", align: 2, offset: 0 } as Instr,
    // iovec.buf_len = chunk at memory[4]
    { op: "i32.const", value: 4 } as Instr,
    { op: "local.get", index: CHUNK } as Instr,
    { op: "i32.store", align: 2, offset: 0 } as Instr,
    // errno = fd_write(fd, iovs=0, iovs_len=1, nwritten=8)
    { op: "local.get", index: FD } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.const", value: 8 } as Instr,
    { op: "call", funcIdx: ctx.wasiFdWriteIdx } as Instr,
    { op: "local.set", index: ERRNO } as Instr,
    // if (errno != 0) break — return whatever was written so far
    { op: "local.get", index: ERRNO } as Instr,
    { op: "br_if", depth: 1 } as Instr,
    // nw = memory[8]
    { op: "i32.const", value: 8 } as Instr,
    { op: "i32.load", align: 2, offset: 0 } as Instr,
    { op: "local.set", index: NW } as Instr,
    // if (nw <= 0) break — no progress, never spin
    { op: "local.get", index: NW } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.le_s" } as Instr,
    { op: "br_if", depth: 1 } as Instr,
    // total += nw
    { op: "local.get", index: TOTAL } as Instr,
    { op: "local.get", index: NW } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: TOTAL } as Instr,
    // base += nw
    { op: "local.get", index: BASE } as Instr,
    { op: "local.get", index: NW } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: BASE } as Instr,
    // remaining -= nw
    { op: "local.get", index: REMAINING } as Instr,
    { op: "local.get", index: NW } as Instr,
    { op: "i32.sub" } as Instr,
    { op: "local.set", index: REMAINING } as Instr,
    // continue
    { op: "br", depth: 0 } as Instr,
  ];

  const body: Instr[] = [
    // base = ptr
    { op: "local.get", index: PTR } as Instr,
    { op: "local.set", index: BASE } as Instr,
    // remaining = len
    { op: "local.get", index: LEN } as Instr,
    { op: "local.set", index: REMAINING } as Instr,
    // total = 0
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.set", index: TOTAL } as Instr,
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody } as Instr],
    } as Instr,
    { op: "local.get", index: TOTAL } as Instr,
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    locals: [
      { name: "base", type: { kind: "i32" } },
      { name: "remaining", type: { kind: "i32" } },
      { name: "total", type: { kind: "i32" } },
      { name: "chunk", type: { kind: "i32" } },
      { name: "errno", type: { kind: "i32" } },
      { name: "nw", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * #1886 Slice B — Ensure the `__lin_u8_alloc(len: i32) -> i32` bump allocator
 * exists and return its function index (lazy, emitted on first linear-backed
 * `new Uint8Array`). Allocates `align8(len)` bytes from the page-4 linear arena
 * pointed at by `$__lin_u8_arena_ptr`, growing memory on demand, and returns
 * the (8-byte-aligned) base pointer. Mirrors the #1856 align8 + page-grow idiom
 * from `codegen-linear/runtime.ts`; emitted here because the WasmGC front-end
 * owns its own memory/globals and cannot call the linear backend bootstrap.
 *
 * NOTE: the returned region is NOT explicitly zero-filled — `memory.grow`
 * zeroes fresh pages, and the arena today only ever grows (no reset yet, see
 * Slice D), so every byte handed out is freshly-grown zero memory, satisfying
 * the `new Uint8Array(n)` zero-fill contract. A future arena reset (Slice D)
 * that reuses slots must `memory.fill` callers' buffers.
 */
export function reserveLinearU8AllocType(ctx: CodegenContext): void {
  // #1886 Slice B — reserve the allocator's `(i32)->(i32)` func TYPE eagerly,
  // before any WasmGC struct/array type or native-string helper is registered,
  // so the shared `ctx.mod.types` prefix stays stable when those later types
  // (whose absolute indices their bodies bake) are added. Idempotent. The
  // allocator FUNCTION is emitted later in `ensureLinearU8AllocHelper`, in the
  // post-import-registration window, so its DEFINED-function index is final.
  if (ctx.linearU8AllocTypeIdx !== undefined) return;
  if (!ctx.wasi) return;
  ctx.linearU8AllocTypeIdx = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }]);
}

/**
 * (#2357/#47) Reserve the standalone `$__subview_<elem>` struct types up-front so
 * their indices are deterministic across codegen passes (see the call site in
 * `generateModule`). Covers the element kinds standalone TypedArrays use for their
 * backing arrays: `i8_byte` (Int8/Uint8/Uint8Clamped), `i16_byte`
 * (Int16/Uint16), `i32_elem` (Int32/Uint32 element storage), and `f64` (the float
 * views). (#2593 added the i16/i32 byte views — before that only integer Uint8Array
 * was packed.) `getOrRegisterSubviewType` only forces the backing ARRAY type
 * (uniquely deduped per element kind) — it does NOT register or reorder the vec
 * struct, so plain typed-array resolution is unaffected. Idempotent.
 *
 * (#2835) Int32/Uint32 ELEMENT storage moved from the `i32_byte` key to a dedicated
 * `i32_elem` key (split from the ArrayBuffer/DataView byte buffer — see
 * `TYPED_ARRAY_PACKED_STORAGE`). So the Int32/Uint32 `subarray` subview is now keyed
 * `i32_elem` and reserved here; an `Int32Array.subarray()` (whose receiver vec is
 * `__vec_i32_elem`) resolves `getOrRegisterSubviewType(ctx, "i32_elem", …)` to this
 * PRE-RESERVED, idx-stable slot (hoist == emit), avoiding the #2357 body-time-index
 * desync. The byte buffer (`i32_byte`) has NO `subarray` view, so it is NOT reserved
 * here; the ArrayBuffer/DataView byte vec registers lazily at its use sites exactly
 * as before (it resolves directly to its vec — no subview substitution — so its
 * lazy registration is symmetric across the hoist/emit passes and needs no eager
 * slot). PR-2 will flip the `i32_byte` element type to i8 at its registration point.
 * (memory: project_type_index_shift_and_deadelim — only types whose lazy registration
 * could DESYNC across passes need an eager slot; the byte vec does not.)
 */
export function reserveTypedArraySubviewTypes(ctx: CodegenContext): void {
  getOrRegisterSubviewType(ctx, "i8_byte", { kind: "i8" });
  getOrRegisterSubviewType(ctx, "i16_byte", { kind: "i16" }); // (#2593) Int16/Uint16
  getOrRegisterSubviewType(ctx, "i32_elem", { kind: "i32" }); // (#2835) Int32/Uint32 element storage (split from i32_byte)
  getOrRegisterSubviewType(ctx, "f64", { kind: "f64" });
}

/**
 * (#2026 #53) Reserve the `$ObjVecArr` = `(array (mut externref))` type up-front,
 * at the deterministic type-init point, so the dynamic-`new` runtime-argv path
 * (`emitDynamicNewFallback`, for `new K(...someVar)`) can reference a STABLE type
 * index. Minting this type lazily mid-expression — via `ensureObjectRuntime` —
 * registered it after the deterministic type prefix had been baked, leaving an
 * unresolved `-1` heap-type ref at binary-emit (the #2043 / subview
 * type-idx-stability hazard). The type is self-contained (element `externref`,
 * no type deps), so reserving it alone is zero-helper, zero-import, additive.
 * `ensureObjectRuntime` adopts this slot (see object-runtime.ts) when present so
 * the two never collide. Gated to class-bearing sources only (the dynamic-new
 * fallback can't fire without a class).
 */
export function reserveObjVecArrType(ctx: CodegenContext): void {
  if (ctx.reservedObjVecArrTypeIdx !== undefined) return;
  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "$ObjVecArr",
    element: { kind: "externref" },
    mutable: true,
  });
  ctx.reservedObjVecArrTypeIdx = idx;
}

/**
 * #2773 S1 (KEYSTONE) — reserve every reconstructed-fnctor `$__fnctor_<Name>`
 * struct type at the deterministic up-front type-init phase (the same stable
 * point as `reserveTypedArraySubviewTypes` / `reserveObjVecArrType`), so the type
 * index is IDENTICAL across the hoist pass and the emit pass.
 *
 * ROOT CAUSE this fixes: the on-demand registration at the `new F()` call site
 * (`compileNewFunctionDeclaration`, new-super.ts — `ctx.mod.types.length`) assigns
 * the index at a NON-deterministic mid-compile point that depends on which
 * function the compiler reached first. The two-pass type numbering then desyncs:
 * a typed-receiver `ref.test $__fnctor_<Name>` baked in the hoist pass misses the
 * emit-pass `struct.new` index, and a read site compiled before the `new` site is
 * excluded from `findAlternateStructsForField`'s candidate set. Reserving up-front
 * collapses BOTH facets — the index is pass-invariant AND the candidate set is
 * complete at every read site. This is the one thing the #2674 finalize
 * dispatcher cannot retroactively fix (it can't rewrite a baked typeIdx).
 *
 * Two sub-passes — the ORDER is load-bearing:
 *   (1) reserve ALL indices + names FIRST (placeholder struct, `structMap`,
 *       `typeIdxToStructName`, `fnctorReservedTypeIdx`), so a cross-fnctor ref
 *       field in sub-pass 2 (a `Parser` field typed `Scope` →
 *       `(ref null $__fnctor_Scope)`) resolves against an already-registered
 *       `structMap` entry. Do NOT collapse the two sub-passes.
 *   (2) FILL each placeholder's fields via the shared `deriveFnctorFields`
 *       (single source of truth — identical to the on-demand derivation) and
 *       record `structFields` for candidate-set completeness.
 *
 * Determinism: the name set is SORTED, and the call-site position is fixed, so the
 * reserved index is identical across the hoist pass and the emit pass (the entire
 * point of the slice). Gated on a non-empty approved set ⇒ fnctor-free modules are
 * byte-identical (a true no-op). Runs in BOTH host and standalone — the on-demand
 * struct path is target-independent. A reserved-but-never-constructed placeholder
 * is unreferenced ⇒ `dead-elimination` prunes + renumbers it cleanly.
 */
export function reserveFnctorStructTypes(ctx: CodegenContext): void {
  const gate = ctx.fnctorEscapeGate;
  if (!gate) return;
  // The set of fnctor names whose struct slot to reserve: the reconstruct-approved
  // names plus (S2b) the `new this()` reconstruct owners. `newThisOwnerNames` is
  // empty in S1, so this is exactly `approvedNames` today.
  const names = [...new Set([...gate.approvedNames, ...gate.newThisOwnerNames])].sort();
  if (names.length === 0) return; // no-op gate ⇒ byte-identical for fnctor-free code

  // SUB-PASS 1 — reserve every index + name FIRST (placeholder, empty fields) so
  // cross-fnctor ref fields in sub-pass 2 resolve against a registered structMap.
  for (const name of names) {
    const decl = gate.ctorDeclByName.get(name);
    if (!decl || !decl.body) continue; // unresolved / body-less ⇒ skip (legacy fallback handles it)
    const structName = `__fnctor_${name}`;
    if (ctx.structMap.has(structName)) continue; // idempotent within a pass
    const idx = ctx.mod.types.length;
    ctx.mod.types.push({ kind: "struct", name: structName, fields: [] });
    ctx.structMap.set(structName, idx);
    ctx.typeIdxToStructName.set(idx, structName);
    ctx.fnctorReservedTypeIdx.set(name, idx);
  }

  // SUB-PASS 2 — fill fields now that ALL names + indices exist.
  for (const name of names) {
    const idx = ctx.fnctorReservedTypeIdx.get(name);
    if (idx === undefined) continue;
    const decl = gate.ctorDeclByName.get(name);
    if (!decl) continue;
    const fields = deriveFnctorFields(ctx, decl);
    const ty = ctx.mod.types[idx];
    if (ty && ty.kind === "struct") ty.fields = fields; // FILL IN PLACE — index unchanged
    ctx.structFields.set(`__fnctor_${name}`, fields); // candidate-set completeness
  }
}

export function ensureLinearU8AllocHelper(ctx: CodegenContext): number {
  if (ctx.linearU8AllocFuncIdx !== undefined) return ctx.linearU8AllocFuncIdx;
  if (!ctx.wasi || ctx.linearU8ArenaGlobalIdx === undefined) return -1;

  const arenaGlobal = ctx.linearU8ArenaGlobalIdx;
  // param: len(0); locals: ret(1), next(2)
  const LEN = 0;
  const RET = 1;
  const NEXT = 2;
  const PAGE = 65536;

  // Reuse the eagerly-reserved func type when present (keeps the type-table
  // prefix stable for native-string helpers); fall back to registering it now
  // for any path that reaches the allocator without the early reservation.
  const funcTypeIdx = ctx.linearU8AllocTypeIdx ?? addFuncType(ctx, [{ kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__lin_u8_alloc", funcIdx);

  const body: Instr[] = [
    // ret = arena_ptr
    { op: "global.get", index: arenaGlobal } as Instr,
    { op: "local.set", index: RET } as Instr,
    // next = align8(ret + len) = (ret + len + 7) & ~7
    { op: "local.get", index: RET } as Instr,
    { op: "local.get", index: LEN } as Instr,
    { op: "i32.add" } as Instr,
    { op: "i32.const", value: 7 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "i32.const", value: -8 } as Instr,
    { op: "i32.and" } as Instr,
    { op: "local.set", index: NEXT } as Instr,
    // if (next > memory.size * PAGE) grow by ceil((next - cur)/PAGE)
    { op: "local.get", index: NEXT } as Instr,
    { op: "memory.size" } as Instr,
    { op: "i32.const", value: PAGE } as Instr,
    { op: "i32.mul" } as Instr,
    { op: "i32.gt_u" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: NEXT } as Instr,
        { op: "memory.size" } as Instr,
        { op: "i32.const", value: PAGE } as Instr,
        { op: "i32.mul" } as Instr,
        { op: "i32.sub" } as Instr,
        { op: "i32.const", value: PAGE - 1 } as Instr,
        { op: "i32.add" } as Instr,
        { op: "i32.const", value: PAGE } as Instr,
        { op: "i32.div_u" } as Instr,
        { op: "memory.grow" } as Instr,
        { op: "drop" } as Instr,
      ],
    } as Instr,
    // arena_ptr = next
    { op: "local.get", index: NEXT } as Instr,
    { op: "global.set", index: arenaGlobal } as Instr,
    // return ret
    { op: "local.get", index: RET } as Instr,
  ];

  ctx.mod.functions.push({
    name: "__lin_u8_alloc",
    typeIdx: funcTypeIdx,
    locals: [
      { name: "ret", type: { kind: "i32" } },
      { name: "next", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });

  ctx.linearU8AllocFuncIdx = funcIdx;
  return funcIdx;
}

/**
 * Local-index layout for the shared WTF-16 → UTF-8 encoder. `S` is the AnyString
 * param's index; the ten work-locals (`FLAT`..`LO`) are laid out contiguously
 * starting at `base`. In Wasm, params occupy the low indices then declared
 * locals follow, so a helper with N params declares its work-locals starting at
 * index N. The fixed-fd writer has one param (s=0) ⇒ base 1; the runtime-fd
 * writer has two params (s=0, fd=1) ⇒ base 2 (#2639).
 */
interface WasiStrEncodeLayout {
  S: number;
  FLAT: number;
  LEN: number;
  OFF: number;
  DATA: number;
  I: number;
  O: number;
  NEED_PAGES: number;
  CU: number;
  CP: number;
  LO: number;
}

/** Build the encoder local layout: AnyString param `s` at 0, work-locals at `base..base+9`. */
function wasiStrEncodeLayout(base: number): WasiStrEncodeLayout {
  return {
    S: 0,
    FLAT: base + 0,
    LEN: base + 1,
    OFF: base + 2,
    DATA: base + 3,
    I: base + 4,
    O: base + 5,
    NEED_PAGES: base + 6,
    CU: base + 7,
    CP: base + 8,
    LO: base + 9,
  };
}

/** The (named, ordered) work-local declarations matching {@link wasiStrEncodeLayout}. */
function wasiStrEncodeLocalDecls(strTypeIdx: number, strDataTypeIdx: number) {
  return [
    { name: "flat", type: { kind: "ref" as const, typeIdx: strTypeIdx } },
    { name: "len", type: { kind: "i32" as const } },
    { name: "off", type: { kind: "i32" as const } },
    { name: "data", type: { kind: "ref" as const, typeIdx: strDataTypeIdx } },
    { name: "i", type: { kind: "i32" as const } },
    { name: "o", type: { kind: "i32" as const } },
    { name: "needPages", type: { kind: "i32" as const } },
    { name: "cu", type: { kind: "i32" as const } },
    { name: "cp", type: { kind: "i32" as const } },
    { name: "lo", type: { kind: "i32" as const } },
  ];
}

/**
 * Build the WTF-16 → UTF-8 encode-to-linear-scratch instruction sequence shared
 * by every WASI write-string helper. Flattens the AnyString param (local `S`)
 * via `__str_flatten`, grows linear memory for the worst-case 3 bytes/code-unit
 * staging region, then encodes the code points into
 * `[WASI_WRITE_SCRATCH_START .. WASI_WRITE_SCRATCH_START + O)`. On return the
 * output-cursor local `O` holds the exact UTF-8 byte count; the caller appends
 * its own write tail (fixed-fd fd_write, or runtime-fd node:fs writeSync). No
 * value is left on the stack. (#2639 factored this out of
 * {@link ensureWasiWriteAnyStringHelper} byte-for-byte so existing fd 1/2 output
 * is unchanged.)
 */
function buildWasiStringEncodeToScratch(
  flattenIdx: number,
  strTypeIdx: number,
  strDataTypeIdx: number,
  layout: WasiStrEncodeLayout,
): Instr[] {
  const { FLAT, LEN, OFF, DATA, I, O, NEED_PAGES, CU, CP, LO, S } = layout;

  const storeByte = (offsetFromO: number, value: Instr[]): Instr[] => [
    { op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr,
    { op: "local.get", index: O } as Instr,
    ...(offsetFromO === 0
      ? []
      : ([{ op: "i32.const", value: offsetFromO } as Instr, { op: "i32.add" } as Instr] as Instr[])),
    { op: "i32.add" } as Instr,
    ...value,
    { op: "i32.store8", align: 0, offset: 0 } as Instr,
  ];

  const advanceOutput = (n: number): Instr[] => [
    { op: "local.get", index: O } as Instr,
    { op: "i32.const", value: n } as Instr,
    { op: "i32.add" } as Instr,
    { op: "local.set", index: O } as Instr,
  ];

  const encodeCurrentCodePoint: Instr[] = [
    { op: "local.get", index: CP } as Instr,
    { op: "i32.const", value: 0x80 } as Instr,
    { op: "i32.lt_u" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [storeByte(0, [{ op: "local.get", index: CP } as Instr]), ...advanceOutput(1)].flat(),
      else: [
        { op: "local.get", index: CP } as Instr,
        { op: "i32.const", value: 0x800 } as Instr,
        { op: "i32.lt_u" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...storeByte(0, [
              { op: "local.get", index: CP } as Instr,
              { op: "i32.const", value: 6 } as Instr,
              { op: "i32.shr_u" } as Instr,
              { op: "i32.const", value: 0xc0 } as Instr,
              { op: "i32.or" } as Instr,
            ]),
            ...storeByte(1, [
              { op: "local.get", index: CP } as Instr,
              { op: "i32.const", value: 0x3f } as Instr,
              { op: "i32.and" } as Instr,
              { op: "i32.const", value: 0x80 } as Instr,
              { op: "i32.or" } as Instr,
            ]),
            ...advanceOutput(2),
          ],
          else: [
            { op: "local.get", index: CP } as Instr,
            { op: "i32.const", value: 0x10000 } as Instr,
            { op: "i32.lt_u" } as Instr,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...storeByte(0, [
                  { op: "local.get", index: CP } as Instr,
                  { op: "i32.const", value: 12 } as Instr,
                  { op: "i32.shr_u" } as Instr,
                  { op: "i32.const", value: 0xe0 } as Instr,
                  { op: "i32.or" } as Instr,
                ]),
                ...storeByte(1, [
                  { op: "local.get", index: CP } as Instr,
                  { op: "i32.const", value: 6 } as Instr,
                  { op: "i32.shr_u" } as Instr,
                  { op: "i32.const", value: 0x3f } as Instr,
                  { op: "i32.and" } as Instr,
                  { op: "i32.const", value: 0x80 } as Instr,
                  { op: "i32.or" } as Instr,
                ]),
                ...storeByte(2, [
                  { op: "local.get", index: CP } as Instr,
                  { op: "i32.const", value: 0x3f } as Instr,
                  { op: "i32.and" } as Instr,
                  { op: "i32.const", value: 0x80 } as Instr,
                  { op: "i32.or" } as Instr,
                ]),
                ...advanceOutput(3),
              ],
              else: [
                ...storeByte(0, [
                  { op: "local.get", index: CP } as Instr,
                  { op: "i32.const", value: 18 } as Instr,
                  { op: "i32.shr_u" } as Instr,
                  { op: "i32.const", value: 0xf0 } as Instr,
                  { op: "i32.or" } as Instr,
                ]),
                ...storeByte(1, [
                  { op: "local.get", index: CP } as Instr,
                  { op: "i32.const", value: 12 } as Instr,
                  { op: "i32.shr_u" } as Instr,
                  { op: "i32.const", value: 0x3f } as Instr,
                  { op: "i32.and" } as Instr,
                  { op: "i32.const", value: 0x80 } as Instr,
                  { op: "i32.or" } as Instr,
                ]),
                ...storeByte(2, [
                  { op: "local.get", index: CP } as Instr,
                  { op: "i32.const", value: 6 } as Instr,
                  { op: "i32.shr_u" } as Instr,
                  { op: "i32.const", value: 0x3f } as Instr,
                  { op: "i32.and" } as Instr,
                  { op: "i32.const", value: 0x80 } as Instr,
                  { op: "i32.or" } as Instr,
                ]),
                ...storeByte(3, [
                  { op: "local.get", index: CP } as Instr,
                  { op: "i32.const", value: 0x3f } as Instr,
                  { op: "i32.and" } as Instr,
                  { op: "i32.const", value: 0x80 } as Instr,
                  { op: "i32.or" } as Instr,
                ]),
                ...advanceOutput(4),
              ],
            } as Instr,
          ],
        } as Instr,
      ],
    } as Instr,
  ];

  return [
    // flat = __str_flatten(s)
    { op: "local.get", index: S } as Instr,
    { op: "call", funcIdx: flattenIdx } as Instr,
    { op: "local.set", index: FLAT } as Instr,

    // len = flat.len (field 0)
    { op: "local.get", index: FLAT } as Instr,
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 } as Instr,
    { op: "local.set", index: LEN } as Instr,

    // #1723/#1470: grow linear memory if the staging buffer could overflow.
    // UTF-8/WTF-8 needs at most 3 bytes per UTF-16 code unit.
    //   neededPages = ceil((WASI_WRITE_SCRATCH_START + len*3) / 65536)
    { op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr,
    { op: "local.get", index: LEN } as Instr,
    { op: "i32.const", value: 3 } as Instr,
    { op: "i32.mul" } as Instr,
    { op: "i32.add" } as Instr,
    { op: "i32.const", value: 65535 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "i32.const", value: 16 } as Instr,
    { op: "i32.shr_u" } as Instr,
    { op: "local.set", index: NEED_PAGES } as Instr,
    { op: "local.get", index: NEED_PAGES } as Instr,
    { op: "memory.size" } as Instr,
    { op: "i32.gt_u" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: NEED_PAGES } as Instr,
        { op: "memory.size" } as Instr,
        { op: "i32.sub" } as Instr,
        { op: "memory.grow" } as Instr,
        { op: "drop" } as Instr,
      ],
    } as Instr,

    // off = flat.off (field 1)
    { op: "local.get", index: FLAT } as Instr,
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.set", index: OFF } as Instr,

    // data = flat.data (field 2)
    { op: "local.get", index: FLAT } as Instr,
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 } as Instr,
    { op: "local.set", index: DATA } as Instr,

    // i = 0
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.set", index: I } as Instr,
    // o = 0 (UTF-8 byte cursor)
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.set", index: O } as Instr,

    // while (i < len) decode one WTF-16 code point and encode it as UTF-8.
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I } as Instr,
            { op: "local.get", index: LEN } as Instr,
            { op: "i32.ge_s" } as Instr,
            { op: "br_if", depth: 1 } as Instr,

            // cu = data[off + i]; cp = cu; i++
            { op: "local.get", index: DATA } as Instr,
            { op: "local.get", index: OFF } as Instr,
            { op: "local.get", index: I } as Instr,
            { op: "i32.add" } as Instr,
            { op: "array.get_u", typeIdx: strDataTypeIdx } as Instr,
            { op: "local.set", index: CU } as Instr,
            { op: "local.get", index: CU } as Instr,
            { op: "local.set", index: CP } as Instr,
            { op: "local.get", index: I } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.add" } as Instr,
            { op: "local.set", index: I } as Instr,

            // Combine a high+low surrogate pair into one scalar.
            { op: "local.get", index: CU } as Instr,
            { op: "i32.const", value: 0xd800 } as Instr,
            { op: "i32.ge_u" } as Instr,
            { op: "local.get", index: CU } as Instr,
            { op: "i32.const", value: 0xdbff } as Instr,
            { op: "i32.le_u" } as Instr,
            { op: "i32.and" } as Instr,
            { op: "local.get", index: I } as Instr,
            { op: "local.get", index: LEN } as Instr,
            { op: "i32.lt_s" } as Instr,
            { op: "i32.and" } as Instr,
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: DATA } as Instr,
                { op: "local.get", index: OFF } as Instr,
                { op: "local.get", index: I } as Instr,
                { op: "i32.add" } as Instr,
                { op: "array.get_u", typeIdx: strDataTypeIdx } as Instr,
                { op: "local.set", index: LO } as Instr,
                { op: "local.get", index: LO } as Instr,
                { op: "i32.const", value: 0xdc00 } as Instr,
                { op: "i32.ge_u" } as Instr,
                { op: "local.get", index: LO } as Instr,
                { op: "i32.const", value: 0xdfff } as Instr,
                { op: "i32.le_u" } as Instr,
                { op: "i32.and" } as Instr,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: 0x10000 } as Instr,
                    { op: "local.get", index: CU } as Instr,
                    { op: "i32.const", value: 0xd800 } as Instr,
                    { op: "i32.sub" } as Instr,
                    { op: "i32.const", value: 10 } as Instr,
                    { op: "i32.shl" } as Instr,
                    { op: "i32.add" } as Instr,
                    { op: "local.get", index: LO } as Instr,
                    { op: "i32.const", value: 0xdc00 } as Instr,
                    { op: "i32.sub" } as Instr,
                    { op: "i32.add" } as Instr,
                    { op: "local.set", index: CP } as Instr,
                    { op: "local.get", index: I } as Instr,
                    { op: "i32.const", value: 1 } as Instr,
                    { op: "i32.add" } as Instr,
                    { op: "local.set", index: I } as Instr,
                  ],
                } as Instr,
              ],
            } as Instr,

            ...encodeCurrentCodePoint,
            { op: "br", depth: 0 } as Instr,
          ],
        },
      ],
    },
  ];
}

/**
 * #1618: Ensure __wasi_write_any_string(s: ref NativeString) -> void exists and
 * return its function index (lazy, emitted during expression compilation).
 *
 * Writes a *runtime* string (variable, concatenation, template span) to fd=1
 * (stdout) or fd=2 (stderr). Previously these refs fell through to the
 * `[object]` placeholder in emitWasiValueToStdout, corrupting the stream.
 *
 * Strategy: flatten any AnyString (FlatString / ConsString / Utf8String) to a
 * NativeString via the existing __str_flatten helper, then encode the WTF-16
 * code units as UTF-8 bytes directly into linear memory before issuing
 * fd_write. This keeps WASI string output on the pure-Wasm path (#1470) without
 * routing through the JS-host `__str_to_mem` / `TextEncoder` bridge.
 *
 * Param 0 is typed `ref NativeString` so callers can hand us a value compiled
 * as `{ kind: "ref", typeIdx: ctx.nativeStrTypeIdx }` directly; __str_flatten
 * accepts the NativeString supertype (AnyString) and returns the flat form.
 */
export function ensureWasiWriteAnyStringHelper(ctx: CodegenContext, useStderr: boolean = false): number {
  const helperName = useStderr ? "__wasi_write_any_string_stderr" : "__wasi_write_any_string";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  // #2524 — node-process shim path needs no fd_write idx (see Uint8Array helper).
  if (!ctx.wasi || (!ctx.linkNodeShims && ctx.wasiFdWriteIdx === undefined) || ctx.nativeStrTypeIdx < 0) return -1;

  // Make sure the native-string runtime (incl. __str_flatten) is emitted.
  ensureNativeStringHelpers(ctx);
  // __str_flatten via funcMap (shift-maintained), not nativeStrHelpers (which can
  // be stale-low after late imports). See the registration in
  // ensureNativeStringHelpers. (#1618)
  const flattenIdx = ctx.funcMap.get("__str_flatten");
  if (flattenIdx === undefined) return -1;

  const fd = useStderr ? 2 : 1;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  // #1723: the param MUST be the AnyString supertype, NOT the concrete
  // NativeString. A runtime concat / template span can be a ConsString (rope),
  // and the caller hands us whatever the expression produced. If the param were
  // typed NativeString, the call site would have to `ref.cast` the argument down
  // to NativeString first — which TRAPS ("illegal cast") for a ConsString. By
  // accepting AnyString here, both NativeString and ConsString pass without any
  // downcast, and `__str_flatten` (which takes AnyString and collapses ropes)
  // does the flattening internally. The original NativeString param + call-site
  // downcast is exactly what made `writeMessage` trap on a multi-segment
  // response in the Native Messaging host (#1723).
  const anyStrTypeIdx = ctx.anyStrTypeIdx >= 0 ? ctx.anyStrTypeIdx : strTypeIdx;

  // #2807 — create the chunked-write helper BEFORE reserving this helper's
  // funcidx, so the `emitWasiWriteTail` lookup in the body below never pushes a
  // function mid-build (which would shift this reserved index).
  ensureWasiFdWriteAllHelper(ctx);

  // One param (s=0) ⇒ work-locals start at index 1.
  const layout = wasiStrEncodeLayout(1);
  const funcTypeIdx = addFuncType(ctx, [{ kind: "ref", typeIdx: anyStrTypeIdx }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  const body: Instr[] = [
    ...buildWasiStringEncodeToScratch(flattenIdx, strTypeIdx, strDataTypeIdx, layout),
    // #2524/#2633 — write the staged UTF-8 region (`O` bytes) via fd_write or
    // the node:fs shim's writeSync(fd, …). Result (bytes-written) is dropped.
    ...emitWasiWriteTail(ctx, fd, WASI_WRITE_SCRATCH_START, layout.O),
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    locals: wasiStrEncodeLocalDecls(strTypeIdx, strDataTypeIdx),
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * (#2968) Ensure `__wasi_start_print_exn(payload: externref) -> void` exists and
 * return its function index (lazy). Renders an uncaught exception payload to
 * stderr for the WASI `_start` wrapper (addWasiStartExport):
 *   - null payload (e.g. `throw null`) → no-op (no string form).
 *   - else `any.convert_extern` → `__any_to_string` (whose #2962 error arm turns
 *     an `$Error_struct` into a real "TypeError: x") → `__wasi_write_any_string_stderr`
 *     (flatten + WTF-16→UTF-8 encode + fd 2 write) → a trailing newline byte.
 * The caller invokes this from the `$exc` catch, then `proc_exit(1)`s.
 *
 * Valid only for a throwing, native-strings WASI module whose fd_write import is
 * registered (registerWasiImports sets it when the source contains a `throw`);
 * returns -1 otherwise so the caller keeps the plain `_start`.
 *
 * Index-shift safety: every dependency is ensured (each may append functions /
 * a late import) BEFORE this helper's own funcidx is reserved, and the baked
 * funcidx values are read from the authoritative `funcMap` after all ensures.
 */
function ensureWasiStartExnPrinter(ctx: CodegenContext): number {
  const helperName = "__wasi_start_print_exn";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;
  if (!ctx.wasi || ctx.exnTagIdx < 0 || !ctx.nativeStrings) return -1;
  if (!ctx.linkNodeShims && ctx.wasiFdWriteIdx < 0) return -1;

  // Ensure dependencies first (append functions / possible late import) so this
  // helper's reserved index lands AFTER any shift they cause.
  ensureNativeStringHelpers(ctx);
  ensureAnyToStringHelper(ctx);
  const writeStderrIdx = ensureWasiWriteAnyStringHelper(ctx, /* useStderr */ true);
  // The chunked-write helper backs the newline `emitWasiWriteTail` below; ensure
  // it now (idempotent — ensureWasiWriteAnyStringHelper already did) so the tail
  // lookup never pushes a function after this helper's funcidx is reserved.
  ensureWasiFdWriteAllHelper(ctx);
  // Read baked funcidx values from the authoritative funcMap AFTER all ensures.
  const anyToStrIdx = ctx.funcMap.get("__any_to_string");
  if (writeStderrIdx < 0 || anyToStrIdx === undefined) return -1;

  // param 0 = payload externref; local 1 = the newline write length (=1).
  const NL_LEN = 1;
  const funcTypeIdx = addFuncType(ctx, [{ kind: "externref" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  const body: Instr[] = [
    // A null payload has no string form — skip rendering, still exit via caller.
    { op: "local.get", index: 0 } as Instr,
    { op: "ref.is_null" } as Instr,
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" } as Instr] } as Instr,
    // payload (externref) → anyref → __any_to_string yields ref AnyString → stderr.
    { op: "local.get", index: 0 } as Instr,
    { op: "any.convert_extern" } as Instr,
    { op: "call", funcIdx: anyToStrIdx } as Instr,
    { op: "call", funcIdx: writeStderrIdx } as Instr,
    // Trailing newline: store 0x0A at the shared write scratch and write 1 byte
    // to fd 2 (emitWasiWriteTail handles both the direct-WASI and node-shim path).
    { op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr,
    { op: "i32.const", value: 0x0a } as Instr,
    { op: "i32.store8", align: 0, offset: 0 } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "local.set", index: NL_LEN } as Instr,
    ...emitWasiWriteTail(ctx, 2, WASI_WRITE_SCRATCH_START, NL_LEN),
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    locals: [{ name: "nlLen", type: { kind: "i32" } }],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * #2639: Ensure `__wasi_write_any_string_fd(s: ref AnyString, fd: i32) -> i32`
 * exists and return its function index (lazy). Encodes the string to UTF-8 in
 * the shared linear scratch (the same encoder as the fixed-fd writer) and writes
 * it to the *runtime* fd. This backs the STRING overload of `node:fs`
 * `writeSync(fd, str, position?, encoding?)`, where the fd is an arbitrary
 * integer (not just stdout/stderr). Two modes (#2655):
 *   - shim (`--link node:fs`): `writeSync(fd, ptr, len)` returns the byte count.
 *   - direct (standalone `--target wasi`): build a `{ base=ptr, len }` iovec at
 *     memory[0..7], call `fd_write(fd, iovs=0, 1, nwritten=8)`, load nwritten.
 */
export function ensureWasiWriteAnyStringFdHelper(ctx: CodegenContext): number {
  const helperName = "__wasi_write_any_string_fd";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  // Runtime-fd writes need either the node:fs shim funcidx (shim path) or the
  // wasi_snapshot_preview1.fd_write import (direct path).
  const directWrite = !ctx.linkNodeShims;
  if (!ctx.wasi || ctx.nativeStrTypeIdx < 0) return -1;
  if (directWrite ? ctx.wasiFdWriteIdx === undefined : ctx.nodeFsWriteSyncIdx < 0) return -1;

  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.funcMap.get("__str_flatten");
  if (flattenIdx === undefined) return -1;

  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const anyStrTypeIdx = ctx.anyStrTypeIdx >= 0 ? ctx.anyStrTypeIdx : strTypeIdx;

  // Two params: s(0), fd(1). The ten encoder work-locals therefore start at
  // index 2; the byte cursor `O` holds the encoded length after the encoder runs.
  const FD = 1;
  const layout = wasiStrEncodeLayout(2);

  const funcTypeIdx = addFuncType(ctx, [{ kind: "ref", typeIdx: anyStrTypeIdx }, { kind: "i32" }], [{ kind: "i32" }]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  const body: Instr[] = [
    ...buildWasiStringEncodeToScratch(flattenIdx, strTypeIdx, strDataTypeIdx, layout),
    // return bytes-written for write(fd, WASI_WRITE_SCRATCH_START, O).
    ...(directWrite
      ? [
          // iovec.base = scratch at memory[0]; iovec.len = O at memory[4].
          { op: "i32.const", value: 0 } as Instr,
          { op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr,
          { op: "i32.store", align: 2, offset: 0 } as Instr,
          { op: "i32.const", value: 4 } as Instr,
          { op: "local.get", index: layout.O } as Instr,
          { op: "i32.store", align: 2, offset: 0 } as Instr,
          // errno = fd_write(fd, iovs=0, iovs_len=1, nwritten=8)
          { op: "local.get", index: FD } as Instr,
          { op: "i32.const", value: 0 } as Instr,
          { op: "i32.const", value: 1 } as Instr,
          { op: "i32.const", value: 8 } as Instr,
          { op: "call", funcIdx: ctx.wasiFdWriteIdx } as Instr,
          // errno != 0 → 0 bytes; else load nwritten at memory[8].
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: 0 } as Instr],
            else: [{ op: "i32.const", value: 8 } as Instr, { op: "i32.load", align: 2, offset: 0 } as Instr],
          } as Instr,
        ]
      : [
          // writeSync(fd, WASI_WRITE_SCRATCH_START, O) — bytes written.
          { op: "local.get", index: FD } as Instr,
          { op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr,
          { op: "local.get", index: layout.O } as Instr,
          { op: "call", funcIdx: ctx.nodeFsWriteSyncIdx } as Instr,
        ]),
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    // Work-locals follow the two params (s, fd); no extra local for fd.
    locals: wasiStrEncodeLocalDecls(strTypeIdx, strDataTypeIdx),
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * #1617/#1651: Ensure __wasi_write_uint8array(arr: ref __vec_*) -> void
 * exists and return its function index (lazy).
 *
 * Writes raw bytes from a typed-array (Uint8Array) GC object to fd=1 (stdout)
 * or fd=2 (stderr) with NO trailing newline. Backs the
 * `process.stdout.write(new Uint8Array([...]))` path (the standard Node API
 * that supersedes the bespoke `writeStdout` builtin from #1617). A native
 * Uint8Array compiles to a "vec" struct:
 *   field 0: length (i32)
 *   field 1: data    (ref array<i8>) — each element is a byte value
 *
 * Legacy f64-backed typed arrays are still accepted; each element is converted
 * to a byte before staging in linear memory at WASI_WRITE_SCRATCH_START.
 */
export function ensureWasiWriteUint8ArrayHelper(
  ctx: CodegenContext,
  vecTypeIdx: number,
  useStderr: boolean = false,
): number {
  // #2524/#2633 — under the node shims the write is satisfied by the imported
  // `node:fs::writeSync` (no fd_write idx); otherwise it needs the real fd_write.
  if (!ctx.wasi || (!ctx.linkNodeShims && ctx.wasiFdWriteIdx === undefined)) return -1;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return -1;
  const arrDef = ctx.mod.types[arrTypeIdx];
  const elemKind = arrDef?.kind === "array" ? arrDef.element.kind : "f64";
  const helperSuffix = elemKind === "i8" ? "_i8" : elemKind === "i32" ? "_i32" : "_f64";
  const helperName = useStderr
    ? `__wasi_write_uint8array_stderr${helperSuffix}`
    : `__wasi_write_uint8array${helperSuffix}`;
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  const fd = useStderr ? 2 : 1;

  // param: arr(0); locals: len(1), data(2), i(3), needPages(4)
  const ARR = 0;
  const LEN = 1;
  const DATA = 2;
  const I = 3;
  const NEED_PAGES = 4;

  // #2807 — pre-create the chunked-write helper before reserving this funcidx
  // (see note in ensureWasiWriteAnyStringHelper).
  ensureWasiFdWriteAllHelper(ctx);

  const funcTypeIdx = addFuncType(ctx, [{ kind: "ref", typeIdx: vecTypeIdx }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  const body: Instr[] = [
    // len = arr.length (field 0)
    { op: "local.get", index: ARR } as Instr,
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
    { op: "local.set", index: LEN } as Instr,

    // #389/#1723: grow linear memory if the staging buffer
    // [WASI_WRITE_SCRATCH_START .. WASI_WRITE_SCRATCH_START+len) would overflow
    // the current memory size. The module reserves only 3 pages by default, so a
    // ~1 MiB raw-byte write (the Native Messaging large-message case) writes far
    // past page 2 and traps "memory access out of bounds" without this guard —
    // the same fix the string-write helper got in #1723 but that this and the
    // ArrayBuffer-write sibling were missing, which is what corrupted/dropped
    // guest271314's 1 MiB framed message.
    //
    //   neededPages = ceil((WASI_WRITE_SCRATCH_START + len) / 65536)
    //               = (WASI_WRITE_SCRATCH_START + len + 65535) >> 16
    // i32.shr_u keeps the page count non-negative for lengths near 2^31.
    { op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr,
    { op: "local.get", index: LEN } as Instr,
    { op: "i32.add" } as Instr,
    { op: "i32.const", value: 65535 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "i32.const", value: 16 } as Instr,
    { op: "i32.shr_u" } as Instr,
    { op: "local.set", index: NEED_PAGES } as Instr,
    // if (needPages > memory.size) memory.grow(needPages - memory.size)
    { op: "local.get", index: NEED_PAGES } as Instr,
    { op: "memory.size" } as Instr,
    { op: "i32.gt_u" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: NEED_PAGES } as Instr,
        { op: "memory.size" } as Instr,
        { op: "i32.sub" } as Instr,
        { op: "memory.grow" } as Instr,
        { op: "drop" } as Instr,
      ],
    } as Instr,

    // data = arr.data (field 1)
    { op: "local.get", index: ARR } as Instr,
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.set", index: DATA } as Instr,

    // i = 0
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.set", index: I } as Instr,

    // while (i < len) mem[SCRATCH+i] = (u8) trunc(data[i]); i++
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I } as Instr,
            { op: "local.get", index: LEN } as Instr,
            { op: "i32.ge_s" } as Instr,
            { op: "br_if", depth: 1 } as Instr,

            // address = SCRATCH_START + i
            { op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr,
            { op: "local.get", index: I } as Instr,
            { op: "i32.add" } as Instr,

            // value = data[i] — low byte kept by i32.store8
            { op: "local.get", index: DATA } as Instr,
            { op: "local.get", index: I } as Instr,
            { op: elemKind === "i8" ? "array.get_u" : "array.get", typeIdx: arrTypeIdx } as Instr,
            ...(elemKind === "f64" ? ([{ op: "i32.trunc_sat_f64_s" } as Instr] as Instr[]) : []),

            { op: "i32.store8", align: 0, offset: 0 },

            // i++
            { op: "local.get", index: I } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.add" } as Instr,
            { op: "local.set", index: I } as Instr,

            { op: "br", depth: 0 } as Instr,
          ],
        },
      ],
    },

    // #2524 — write the staged scratch region (fd_write inline, or node-process shim)
    ...emitWasiWriteTail(ctx, fd, WASI_WRITE_SCRATCH_START, LEN),
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    locals: [
      { name: "len", type: { kind: "i32" } },
      { name: "data", type: { kind: "ref", typeIdx: arrTypeIdx } },
      { name: "i", type: { kind: "i32" } },
      { name: "needPages", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * #1655: Ensure __wasi_write_arraybuffer(buf: ref __vec_i32_byte) -> void
 * exists and return its function index (lazy).
 *
 * Companion to `ensureWasiWriteUint8ArrayHelper` for the ArrayBuffer-backing
 * representation. Under `--target wasi` / `--target standalone`, an
 * `ArrayBuffer` is lowered to a vec struct of packed `i8` bytes (one byte per
 * element, values 0..255 — (#2835), see dataview-native.ts comment block)
 * rather than the Uint8Array f64-element shape. The element read is therefore a
 * packed `array.get_u` (no `i32.trunc_sat_f64_s`).
 */
export function ensureWasiWriteArrayBufferHelper(
  ctx: CodegenContext,
  vecTypeIdx: number,
  useStderr: boolean = false,
): number {
  const helperName = useStderr ? "__wasi_write_arraybuffer_stderr" : "__wasi_write_arraybuffer";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  // #2524 — node-process shim path needs no fd_write idx (see Uint8Array helper).
  if (!ctx.wasi || (!ctx.linkNodeShims && ctx.wasiFdWriteIdx === undefined)) return -1;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return -1;

  const fd = useStderr ? 2 : 1;

  // param: buf(0); locals: len(1), data(2), i(3), needPages(4)
  const BUF = 0;
  const LEN = 1;
  const DATA = 2;
  const I = 3;
  const NEED_PAGES = 4;

  // #2807 — pre-create the chunked-write helper before reserving this funcidx
  // (see note in ensureWasiWriteAnyStringHelper).
  ensureWasiFdWriteAllHelper(ctx);

  const funcTypeIdx = addFuncType(ctx, [{ kind: "ref", typeIdx: vecTypeIdx }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

  const body: Instr[] = [
    // len = buf.length (field 0)
    { op: "local.get", index: BUF } as Instr,
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
    { op: "local.set", index: LEN } as Instr,

    // #389/#1723: grow linear memory if the staging buffer would overflow the
    // current memory size (only 3 pages reserved by default). A ~1 MiB
    // ArrayBuffer write to stdout otherwise traps "memory access out of bounds".
    // Mirrors the string-write helper's #1723 guard.
    //   neededPages = (WASI_WRITE_SCRATCH_START + len + 65535) >> 16
    { op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr,
    { op: "local.get", index: LEN } as Instr,
    { op: "i32.add" } as Instr,
    { op: "i32.const", value: 65535 } as Instr,
    { op: "i32.add" } as Instr,
    { op: "i32.const", value: 16 } as Instr,
    { op: "i32.shr_u" } as Instr,
    { op: "local.set", index: NEED_PAGES } as Instr,
    { op: "local.get", index: NEED_PAGES } as Instr,
    { op: "memory.size" } as Instr,
    { op: "i32.gt_u" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: NEED_PAGES } as Instr,
        { op: "memory.size" } as Instr,
        { op: "i32.sub" } as Instr,
        { op: "memory.grow" } as Instr,
        { op: "drop" } as Instr,
      ],
    } as Instr,

    // data = buf.data (field 1)
    { op: "local.get", index: BUF } as Instr,
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
    { op: "local.set", index: DATA } as Instr,

    // i = 0
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.set", index: I } as Instr,

    // while (i < len) mem[SCRATCH+i] = (u8) data[i]; i++
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: I } as Instr,
            { op: "local.get", index: LEN } as Instr,
            { op: "i32.ge_s" } as Instr,
            { op: "br_if", depth: 1 } as Instr,

            // address = SCRATCH_START + i
            { op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr,
            { op: "local.get", index: I } as Instr,
            { op: "i32.add" } as Instr,

            // value = data[i] ((#2835) packed i8 byte → unsigned read; low byte
            // kept by i32.store8)
            { op: "local.get", index: DATA } as Instr,
            { op: "local.get", index: I } as Instr,
            { op: "array.get_u", typeIdx: arrTypeIdx } as Instr,

            { op: "i32.store8", align: 0, offset: 0 },

            // i++
            { op: "local.get", index: I } as Instr,
            { op: "i32.const", value: 1 } as Instr,
            { op: "i32.add" } as Instr,
            { op: "local.set", index: I } as Instr,

            { op: "br", depth: 0 } as Instr,
          ],
        },
      ],
    },

    // #2524 — write the staged scratch region (fd_write inline, or node-process shim)
    ...emitWasiWriteTail(ctx, fd, WASI_WRITE_SCRATCH_START, LEN),
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    locals: [
      { name: "len", type: { kind: "i32" } },
      { name: "data", type: { kind: "ref", typeIdx: arrTypeIdx } },
      { name: "i", type: { kind: "i32" } },
      { name: "needPages", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  });

  return funcIdx;
}

/**
 * Emit __wasi_write_file_sync(pathPtr: i32, pathLen: i32, dataPtr: i32, dataLen: i32) helper.
 * Opens a file via path_open, writes data via fd_write, then closes via fd_close.
 *
 * WASI path_open signature:
 *   path_open(dirfd, dirflags, path, path_len, oflags, rights_base, rights_inheriting, fdflags, fd_out) -> errno
 *
 * Memory layout (scratch area 0-1023):
 *   [0..3]   = iovec.buf (ptr to data)
 *   [4..7]   = iovec.buf_len
 *   [8..11]  = nwritten (output from fd_write)
 *   [12..15] = opened fd (output from path_open)
 */
function emitWasiWriteFileSyncHelper(ctx: CodegenContext): void {
  // params: pathPtr(0), pathLen(1), dataPtr(2), dataLen(3)
  // locals: openedFd(4)
  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "i32" }, { kind: "i32" }, { kind: "i32" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_write_file_sync", funcIdx);

  const body: Instr[] = [
    // 1. Call path_open to open the file for writing
    //    path_open(dirfd=3, dirflags=0, path, path_len,
    //              oflags=O_CREAT|O_TRUNC(=9), rights_base=FD_WRITE(=64),
    //              rights_inheriting=0, fdflags=0, fd_out=12)

    { op: "i32.const", value: 3 } as Instr, // dirfd = 3 (first preopen)
    { op: "i32.const", value: 0 } as Instr, // dirflags = 0
    { op: "local.get", index: 0 } as Instr, // path ptr
    { op: "local.get", index: 1 } as Instr, // path len
    { op: "i32.const", value: 9 } as Instr, // oflags = O_CREAT(1) | O_TRUNC(8) = 9
    { op: "i64.const", value: 64n }, // rights_base = RIGHT_FD_WRITE(64)
    { op: "i64.const", value: 0n }, // rights_inheriting = 0
    { op: "i32.const", value: 0 } as Instr, // fdflags = 0
    { op: "i32.const", value: 12 } as Instr, // fd_out ptr at memory[12]
    { op: "call", funcIdx: ctx.wasiPathOpenIdx } as Instr,
    { op: "drop" } as Instr, // drop errno

    // 2. Load the opened fd from memory[12]
    { op: "i32.const", value: 12 } as Instr,
    { op: "i32.load", align: 2, offset: 0 } as Instr,
    { op: "local.set", index: 4 } as Instr, // store in local openedFd

    // 3. Set up iovec for fd_write: iovec at memory[0]
    //    iovec.buf = dataPtr, iovec.buf_len = dataLen
    { op: "i32.const", value: 0 } as Instr,
    { op: "local.get", index: 2 } as Instr, // dataPtr
    { op: "i32.store", align: 2, offset: 0 } as Instr,
    { op: "i32.const", value: 4 } as Instr,
    { op: "local.get", index: 3 } as Instr, // dataLen
    { op: "i32.store", align: 2, offset: 0 } as Instr,

    // 4. Call fd_write(openedFd, iovs=0, iovs_len=1, nwritten=8)
    { op: "local.get", index: 4 } as Instr, // fd = openedFd
    { op: "i32.const", value: 0 } as Instr, // iovs pointer
    { op: "i32.const", value: 1 } as Instr, // iovs_len = 1
    { op: "i32.const", value: 8 } as Instr, // nwritten pointer
    { op: "call", funcIdx: ctx.wasiFdWriteIdx } as Instr,
    { op: "drop" } as Instr, // drop errno

    // 5. Call fd_close(openedFd)
    { op: "local.get", index: 4 } as Instr, // fd = openedFd
    { op: "call", funcIdx: ctx.wasiFdCloseIdx } as Instr,
    { op: "drop" } as Instr, // drop errno
  ];

  ctx.mod.functions.push({
    name: "__wasi_write_file_sync",
    typeIdx: funcTypeIdx,
    locals: [{ name: "openedFd", type: { kind: "i32" } }],
    body,
    exported: false,
  });
}

/**
 * #1484 — Emit __wasi_sleep_ms(ms: i32) helper.
 *
 * Builds a single CLOCK subscription in the scratch zone and calls poll_oneoff
 * to block for `ms` milliseconds. Synchronous; blocks the wasm thread. Matches
 * wasmtime's single-threaded execution model.
 *
 * Scratch layout (offsets inside the reserved 0..1023 bump zone):
 *   [64..111] = subscription_t (48 bytes)
 *     [64..71]   userdata (u64)            = 0
 *     [72]       tag                       = 0  (EVENTTYPE_CLOCK)
 *     [73..79]   pad                       = 0
 *     [80..83]   clockid                   = 1  (CLOCK_MONOTONIC)
 *     [84..87]   pad to 8-byte align       = 0
 *     [88..95]   timeout (u64 ns)          = ms * 1_000_000
 *     [96..103]  precision (u64)           = 0
 *     [104..105] flags (u16)               = 0  (relative)
 *     [106..111] pad
 *   [112..143] = event_t out buffer (32 bytes; per-spec)
 *   [144..147] = nevents out (u32)
 */
function emitWasiSleepMsHelper(ctx: CodegenContext): void {
  if (ctx.wasiPollOneoffIdx === undefined || ctx.wasiPollOneoffIdx < 0) {
    return; // safety: only emit when poll_oneoff is registered
  }
  const SUB_OFFSET = 64;
  const EVT_OFFSET = 112;
  const NEVENTS_OFFSET = 144;

  const funcTypeIdx = addFuncType(ctx, [{ kind: "i32" }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__wasi_sleep_ms", funcIdx);

  // Param 0 = ms (i32)
  // Local 1 = timeout_ns (i64) computed once
  const body: Instr[] = [
    // userdata @ 64 = 0 (i64)
    { op: "i32.const", value: SUB_OFFSET } as Instr,
    { op: "i64.const", value: 0n },
    { op: "i64.store", align: 3, offset: 0 },

    // tag @ 72 = 0 (i8 EVENTTYPE_CLOCK) — store 0 over 8 bytes covers tag + pad
    { op: "i32.const", value: SUB_OFFSET + 8 } as Instr,
    { op: "i64.const", value: 0n },
    { op: "i64.store", align: 3, offset: 0 },

    // clockid @ 80 = 1 (CLOCK_MONOTONIC), pad @ 84 = 0 — combined as i64
    { op: "i32.const", value: SUB_OFFSET + 16 } as Instr,
    { op: "i64.const", value: 1n },
    { op: "i64.store", align: 3, offset: 0 },

    // timeout @ 88 = (i64) ms * 1_000_000
    { op: "i32.const", value: SUB_OFFSET + 24 } as Instr,
    { op: "local.get", index: 0 } as Instr,
    { op: "i64.extend_i32_u" },
    { op: "i64.const", value: 1000000n },
    { op: "i64.mul" },
    { op: "i64.store", align: 3, offset: 0 },

    // precision @ 96 = 0
    { op: "i32.const", value: SUB_OFFSET + 32 } as Instr,
    { op: "i64.const", value: 0n },
    { op: "i64.store", align: 3, offset: 0 },

    // flags @ 104 = 0 (u16, relative), plus pad — clear 8 bytes
    { op: "i32.const", value: SUB_OFFSET + 40 } as Instr,
    { op: "i64.const", value: 0n },
    { op: "i64.store", align: 3, offset: 0 },

    // poll_oneoff(in=64, out=112, nsubs=1, nevents_out=144) — errno dropped
    { op: "i32.const", value: SUB_OFFSET } as Instr,
    { op: "i32.const", value: EVT_OFFSET } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.const", value: NEVENTS_OFFSET } as Instr,
    { op: "call", funcIdx: ctx.wasiPollOneoffIdx } as Instr,
    { op: "drop" } as Instr,
  ];

  ctx.mod.functions.push({
    name: "__wasi_sleep_ms",
    typeIdx: funcTypeIdx,
    locals: [],
    body,
    exported: false,
  });
}

/** Scan source for .toString() / .toFixed() on number types and register needed imports */
function collectPrimitiveMethodImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const needed = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression;
      const receiverType = ctx.checker.getTypeAtLocation(prop.expression);
      const methodName = prop.name.text;
      if (isNumberType(receiverType) && methodName === "toString") {
        needed.add("number_toString");
      }
      // (#1599 Phase 2) JSON.stringify(<string>) in standalone/WASI lowers to
      // the pure-Wasm `__json_quote_string` helper. Pre-register it here (before
      // body compilation) so its defined-function index is stable.
      if (
        (ctx.standalone || ctx.wasi) &&
        ts.isIdentifier(prop.expression) &&
        prop.expression.text === "JSON" &&
        methodName === "stringify" &&
        node.arguments.length === 1
      ) {
        const jsonArgT = ctx.checker.getTypeAtLocation(node.arguments[0]!);
        if ((jsonArgT.flags & ts.TypeFlags.StringLike) !== 0) {
          needed.add("__json_quote_string");
        }
      }
      // (#2160 number-wrapper) Standalone `new Number(x).<fmt>()` routes through
      // the SAME native `number_*` helpers as a primitive receiver (the wrapper's
      // f64 is recovered via __to_primitive in calls.ts). The wrapper type is
      // `TypeFlags.Object` (symbol "Number"), NOT `isNumberType`, so it must be
      // detected here too or the helper is never pre-registered and the call site
      // falls through to a null result. Gated on standalone (the recovery path).
      const isNumMethodRecv = isNumberType(receiverType) || (ctx.standalone && isNumberWrapperType(receiverType));
      if (isNumMethodRecv && methodName === "toFixed") {
        needed.add("number_toFixed");
      }
      if (isNumMethodRecv && methodName === "toPrecision") {
        needed.add("number_toPrecision");
      }
      if (isNumMethodRecv && methodName === "toExponential") {
        needed.add("number_toExponential");
      }
      // toString(radix)/toLocaleString on a standalone Number wrapper similarly
      // needs number_toString[_radix] pre-registered (primitive path registers it
      // broadly, but be explicit for the wrapper receiver).
      if (
        ctx.standalone &&
        isNumberWrapperType(receiverType) &&
        (methodName === "toString" || methodName === "toLocaleString")
      ) {
        needed.add("number_toString");
      }
      // Detect Number.prototype.method.call/apply patterns
      if ((methodName === "call" || methodName === "apply") && ts.isPropertyAccessExpression(prop.expression)) {
        const innerProp = prop.expression;
        const innerMethodName = innerProp.name.text;
        if (
          ts.isPropertyAccessExpression(innerProp.expression) &&
          innerProp.expression.name.text === "prototype" &&
          ts.isIdentifier(innerProp.expression.expression) &&
          innerProp.expression.expression.text === "Number"
        ) {
          if (innerMethodName === "toString") needed.add("number_toString");
          if (innerMethodName === "toFixed") needed.add("number_toFixed");
          if (innerMethodName === "toPrecision") needed.add("number_toPrecision");
          if (innerMethodName === "toExponential") needed.add("number_toExponential");
        }
      }
    }
    // Template expressions with number/boolean/bigint substitutions need number_toString
    if (ts.isTemplateExpression(node)) {
      for (const span of node.templateSpans) {
        const spanType = ctx.checker.getTypeAtLocation(span.expression);
        if (isNumberType(spanType) || isBooleanType(spanType) || isBigIntType(spanType)) {
          needed.add("number_toString");
        }
      }
    }
    // String(expr) calls need number_toString for number→string coercion
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "String" &&
      node.arguments.length >= 1
    ) {
      const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
      if (isNumberType(argType) || !isStringType(argType)) {
        needed.add("number_toString");
      }
    }
    // String + non-string concatenation needs number_toString for coercion.
    // Conservative: register whenever either side of + is a string and the
    // other is not (could be number, any, boolean — all may produce f64 at wasm level).
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.PlusToken || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken)
    ) {
      const leftType = ctx.checker.getTypeAtLocation(node.left);
      const rightType = ctx.checker.getTypeAtLocation(node.right);
      if (isStringType(leftType) && !isStringType(rightType)) {
        needed.add("number_toString");
      }
      if (!isStringType(leftType) && isStringType(rightType)) {
        needed.add("number_toString");
      }
      // For `any`-typed variables (e.g. `var __str; __str=""`), the left type
      // won't be detected as string, but at runtime it may hold a string.
      // When += is used with an `any`-typed LHS and a non-string RHS,
      // register number_toString so the coercion is available at codegen time.
      if (
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
        (leftType.flags & ts.TypeFlags.Any) !== 0 &&
        !isStringType(rightType)
      ) {
        needed.add("number_toString");
      }
    }
    // String comparison operators (< > <= >=) on string types need string_compare import
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.LessThanToken ||
        node.operatorToken.kind === ts.SyntaxKind.LessThanEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.GreaterThanToken ||
        node.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken)
    ) {
      const leftType = ctx.checker.getTypeAtLocation(node.left);
      if (isStringType(leftType)) {
        needed.add("string_compare");
      }
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);

  if (needed.has("number_toString")) {
    const t = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toString", { kind: "func", typeIdx: t });
  }
  if (needed.has("number_toFixed")) {
    const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toFixed", { kind: "func", typeIdx: t });
  }
  if (needed.has("number_toPrecision")) {
    const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toPrecision", { kind: "func", typeIdx: t });
  }
  if (needed.has("number_toExponential")) {
    const t = addFuncType(ctx, [{ kind: "f64" }, { kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "number_toExponential", { kind: "func", typeIdx: t });
  }
  if (needed.has("string_compare") && !ctx.nativeStrings) {
    // In native strings mode, __str_compare Wasm helper handles this — no host import needed
    const t = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
    addImport(ctx, "env", "string_compare", { kind: "func", typeIdx: t });
  }
  if (needed.has("__json_quote_string")) {
    // (#1599 Phase 2) emit the pure-Wasm runtime JSON string quoter up-front.
    emitJsonQuoteString(ctx);
  }
}

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

/** Scan source for method calls on string types and register needed imports */
function collectStringMethodImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const needed = new Set<string>();
  /** Methods called with RegExp args — need host import even in native strings mode */
  const regexpArgMethods = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const prop = node.expression;
      const receiverType = ctx.checker.getTypeAtLocation(prop.expression);
      const methodName = prop.name.text;
      // (#2576, extends #2187) An `any`/unknown receiver in native-string mode may
      // hold a native `$AnyString` at runtime; calls.ts emits a runtime-guarded
      // native string method for it (compileGuardedNativeStringMethodCall). That
      // guard's then-arm needs the same native helpers (`__str_charAt`,
      // `__str_slice`, `__str_indexOf`, …) registered, so include `any`-typed
      // receivers calling a STRING_METHODS name in the pre-scan. Without this the
      // funcMap lookup misses and the guarded dispatch has no helper to call.
      const anyReceiverNativeString =
        (ctx.wasi || ctx.standalone) &&
        ctx.nativeStrings &&
        (receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
      if (
        (isStringType(receiverType) || anyReceiverNativeString) &&
        Object.prototype.hasOwnProperty.call(STRING_METHODS, methodName)
      ) {
        needed.add(methodName);
        // Track if the method has a non-string arg (RegExp or custom object
        // implementing Symbol.replace/Symbol.match/etc). The native helpers
        // only handle string search values — for any other type the host
        // import must be available so JS handles @@replace/@@match dispatch
        // (#1443).
        if (
          (methodName === "replace" ||
            methodName === "replaceAll" ||
            methodName === "split" ||
            methodName === "match" ||
            methodName === "search") &&
          node.arguments.length > 0
        ) {
          const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
          const isStringLike = (t: ts.Type): boolean => {
            if ((t.flags & ts.TypeFlags.String) !== 0) return true;
            if ((t.flags & ts.TypeFlags.StringLiteral) !== 0) return true;
            if ((t.flags & ts.TypeFlags.Object) !== 0 && t.getSymbol()?.getName() === "String") return true;
            return false;
          };
          let needsHost = false;
          if ((argType.flags & ts.TypeFlags.Union) !== 0) {
            const union = argType as ts.UnionType;
            needsHost = !union.types.every(isStringLike);
          } else {
            needsHost = !isStringLike(argType);
          }
          if (needsHost) {
            regexpArgMethods.add(methodName);
          }
        }
      }
      // Detect String.prototype.method.call(str, ...) and String.prototype.method.apply(str, ...)
      // These patterns rewrite to str.method(...) at compile time, so we need the import
      if ((methodName === "call" || methodName === "apply") && ts.isPropertyAccessExpression(prop.expression)) {
        const innerProp = prop.expression;
        const innerMethodName = innerProp.name.text;
        if (
          ts.isPropertyAccessExpression(innerProp.expression) &&
          innerProp.expression.name.text === "prototype" &&
          ts.isIdentifier(innerProp.expression.expression) &&
          innerProp.expression.expression.text === "String" &&
          Object.prototype.hasOwnProperty.call(STRING_METHODS, innerMethodName)
        ) {
          needed.add(innerMethodName);
        }
      }
    }
    forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  // Native string methods handled in wasm (native strings mode)
  const NATIVE_STR_METHODS = new Set([
    "charAt",
    "charCodeAt",
    "substring",
    "slice",
    "at",
    "indexOf",
    "lastIndexOf",
    "includes",
    "startsWith",
    "endsWith",
    "trim",
    "trimStart",
    "trimEnd",
    "repeat",
    "padStart",
    "padEnd",
    "toLowerCase",
    "toUpperCase",
    "replace",
    "replaceAll",
    "split",
    "codePointAt",
    "normalize",
  ]);

  for (const method of needed) {
    if (ctx.nativeStrings && NATIVE_STR_METHODS.has(method) && !regexpArgMethods.has(method)) {
      // These are handled by native string helpers — no import needed
      ensureNativeStringHelpers(ctx);
      continue;
    }
    if (ctx.nativeStrings && NATIVE_STR_METHODS.has(method) && regexpArgMethods.has(method)) {
      // Need BOTH native helpers AND host import for RegExp-arg calls
      ensureNativeStringHelpers(ctx);
    }
    const sig = STRING_METHODS[method]!;
    const params: ValType[] = [{ kind: "externref" }, ...sig.params]; // self + args
    const t = addFuncType(ctx, params, [sig.result]);
    addImport(ctx, "env", `string_${method}`, { kind: "func", typeIdx: t });
  }

  // split()/match() return externref JS arrays — register __extern_get and __extern_length
  // so that element access and .length work on the result.
  // With native strings, split returns a native string array — no extern helpers needed.
  if ((needed.has("split") || needed.has("match")) && !ctx.nativeStrings) {
    if (!ctx.funcMap.has("__extern_get")) {
      const getType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "__extern_get", { kind: "func", typeIdx: getType });
    }
    if (!ctx.funcMap.has("__extern_length")) {
      const lenType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
      addImport(ctx, "env", "__extern_length", { kind: "func", typeIdx: lenType });
    }
  }
}

/** Register wasm:js-string builtin imports (called on demand when strings are used) */
export function addStringImports(ctx: CodegenContext): void {
  if (ctx.hasStringImports) return;
  // #1470: standalone target must never register the wasm:js-string namespace.
  // The nativeStrings path is the standalone alternative and is forced on for
  // ctx.standalone in createCodegenContext. If a caller still reaches this
  // path under standalone (e.g. via a missed gate), no-op so the resulting
  // module remains JS-host-free. WASI mode keeps the historical no-op
  // behavior via the same nativeStrings forcing.
  if (ctx.standalone || ctx.wasi) {
    ctx.hasStringImports = true;
    return;
  }
  ctx.hasStringImports = true;

  // Record import count before adding so we can shift function indices
  // if this is called after collectDeclarations has run.
  const importsBefore = ctx.numImportFuncs;

  // concat: (externref, externref) -> (ref extern)
  const concatType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "ref_extern" }]);
  addImport(ctx, "wasm:js-string", "concat", {
    kind: "func",
    typeIdx: concatType,
  });

  // length: (externref) -> i32
  const lengthType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "wasm:js-string", "length", {
    kind: "func",
    typeIdx: lengthType,
  });

  // equals: (externref, externref) -> i32
  const equalsType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "wasm:js-string", "equals", {
    kind: "func",
    typeIdx: equalsType,
  });

  // substring: (externref, i32, i32) -> (ref extern)
  const substringType = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }],
    [{ kind: "ref_extern" }],
  );
  addImport(ctx, "wasm:js-string", "substring", {
    kind: "func",
    typeIdx: substringType,
  });

  // charCodeAt: (externref, i32) -> i32
  const charCodeAtType = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "i32" }]);
  addImport(ctx, "wasm:js-string", "charCodeAt", {
    kind: "func",
    typeIdx: charCodeAtType,
  });

  // Store wasm:js-string import indices separately so user-defined functions
  // with the same name (e.g. user's "charCodeAt") don't shadow them (#1072).
  for (const name of ["concat", "length", "equals", "substring", "charCodeAt"]) {
    const idx = ctx.funcMap.get(name);
    if (idx !== undefined) ctx.jsStringImports.set(name, idx);
  }

  // If imports were added after defined functions were registered (late addition),
  // shift all defined-function indices.
  const delta = ctx.numImportFuncs - importsBefore;
  if (delta > 0 && ctx.mod.functions.length > 0) {
    const newImportNames = new Set(["concat", "length", "equals", "substring", "charCodeAt"]);
    for (const [name, idx] of ctx.funcMap) {
      if (!newImportNames.has(name) && inLiveShiftRange(idx, importsBefore)) {
        ctx.funcMap.set(name, idx + delta);
      }
    }
    for (const exp of ctx.mod.exports) {
      if (exp.desc.kind === "func" && inLiveShiftRange(exp.desc.index, importsBefore)) {
        exp.desc.index += delta;
      }
    }
    // Track ALL instruction arrays (top-level AND nested) to prevent
    // double-shifting when fctx.body is a nested block reachable from savedBodies (#1109).
    const shifted = new Set<Instr[]>();
    function shiftFuncIndices(instrs: Instr[]): void {
      if (shifted.has(instrs)) return;
      shifted.add(instrs);
      for (const instr of instrs) {
        if ((instr.op === "call" || instr.op === "return_call") && inLiveShiftRange(instr.funcIdx, importsBefore)) {
          instr.funcIdx += delta;
        }
        if (instr.op === "ref.func" && inLiveShiftRange(instr.funcIdx, importsBefore)) {
          instr.funcIdx += delta;
        }
        const a = instr as any;
        if (a.body && Array.isArray(a.body)) shiftFuncIndices(a.body);
        if (a.then && Array.isArray(a.then)) shiftFuncIndices(a.then);
        if (a.else && Array.isArray(a.else)) shiftFuncIndices(a.else);
        if (a.catches && Array.isArray(a.catches)) {
          for (const c of a.catches) {
            if (Array.isArray(c.body)) shiftFuncIndices(c.body);
          }
        }
        if (a.catchAll && Array.isArray(a.catchAll)) shiftFuncIndices(a.catchAll);
      }
    }
    for (const func of ctx.mod.functions) {
      shiftFuncIndices(func.body);
    }
    if (ctx.currentFunc) {
      shiftFuncIndices(ctx.currentFunc.body);
      for (const sb of ctx.currentFunc.savedBodies) {
        shiftFuncIndices(sb);
      }
    }
    for (const parentFctx of ctx.funcStack) {
      shiftFuncIndices(parentFctx.body);
      for (const sb of parentFctx.savedBodies) {
        shiftFuncIndices(sb);
      }
    }
    for (const pb of ctx.parentBodiesStack) {
      shiftFuncIndices(pb);
    }
    // (#1384) Walk all live (allocated but not yet attached to mod.functions)
    // FunctionContext bodies — covers cbFctx.body / liftedFctx.body during
    // their captures-extraction + param-coercion setup phases.
    for (const lb of ctx.liveBodies) {
      shiftFuncIndices(lb);
    }
    // (#1839) The module-init body holds `call`/`ref.func` indices too. When
    // the first string usage occurs inside a function body (not module-init),
    // this body is NOT reachable via funcStack/liveBodies yet, so it would be
    // missed and `__module_init` would call the wrong functions after the late
    // string-import shift. Matches addUnionImports / shiftLateImportIndices.
    if (ctx.pendingInitBody) {
      shiftFuncIndices(ctx.pendingInitBody);
    }
    for (const elem of ctx.mod.elements) {
      if (elem.funcIndices) {
        for (let i = 0; i < elem.funcIndices.length; i++) {
          if (inLiveShiftRange(elem.funcIndices[i]!, importsBefore)) {
            elem.funcIndices[i]! += delta;
          }
        }
      }
    }
    if (ctx.mod.declaredFuncRefs.length > 0) {
      ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map((idx) =>
        inLiveShiftRange(idx, importsBefore) ? idx + delta : idx,
      );
    }
    // (#1525b) Shift pendingMethodTrampolines side-channel indices in lockstep
    // — see the matching block in addUnionImports / shiftLateImportIndices.
    for (const t of ctx.pendingMethodTrampolines) {
      if (inLiveShiftRange(t.methodFuncIdx, importsBefore)) t.methodFuncIdx += delta;
      if (inLiveShiftRange(t.trampolineFuncIdx, importsBefore)) t.trampolineFuncIdx += delta;
    }
    // (#1839) `nativeStrHelpers` is read directly by string-lowering call sites
    // and helper emitters — it is NOT a copy of funcMap, so it must be shifted
    // on its own. All entries are defined functions (>= numImportFuncs), so
    // every entry >= importsBefore moves up by `delta`. Omitting this left the
    // map stale under plain `--nativeStrings` JS-host mode.
    for (const [name, idx] of ctx.nativeStrHelpers) {
      if (inLiveShiftRange(idx, importsBefore)) {
        ctx.nativeStrHelpers.set(name, idx + delta);
      }
    }
    // (#1913) Regex helper map moves in lockstep too — regexp-standalone call
    // sites bake `call` indices straight from this map.
    for (const [name, idx] of ctx.nativeRegexHelpers) {
      if (inLiveShiftRange(idx, importsBefore)) {
        ctx.nativeRegexHelpers.set(name, idx + delta);
      }
    }
    // (#2162) Map/Set/WeakMap/WeakSet helper map moves in lockstep too —
    // map-runtime.ts / weak-collections-runtime.ts call sites bake `call`
    // indices straight from this map (see shiftLateImportIndices for the full
    // rationale / the WeakMap stale-index validation failure it fixes).
    for (const [name, idx] of ctx.mapHelpers) {
      if (inLiveShiftRange(idx, importsBefore)) {
        ctx.mapHelpers.set(name, idx + delta);
      }
    }
    // (#2918) Async-scheduler + Promise.all/race combinator side-channel funcIdxs
    // move in lockstep too. The string-import shifter used to miss them entirely
    // — a native `.then`/combinator baked its `call`/`ref.func` from a stale-low
    // stored index whenever a string import landed between registration and the
    // bake site. Same complete key list as the other two shifters.
    shiftAsyncSideChannelFuncIdxs(ctx, importsBefore, delta);
    // (#2039 slice 2) Re-base so reconcileNativeStrFinalizeShift doesn't apply
    // the same `delta` a second time — this inline shift already repaired the
    // helper bodies and the map. Matches addUnionImports (#1677-fast-path) and
    // shiftLateImportIndices.
    if (ctx.nativeStrHelperImportBase >= 0) {
      ctx.nativeStrHelperImportBase = ctx.numImportFuncs;
    }
    // (#1839) The module start function index also moves if it was a defined
    // function at or above the insertion point. Matches addUnionImports.
    if (ctx.mod.startFuncIdx !== undefined && inLiveShiftRange(ctx.mod.startFuncIdx, importsBefore)) {
      ctx.mod.startFuncIdx += delta;
    }
  }
}

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

/** Scan source for string literals and register env imports for each unique one */
/** Scan source for string literals and register string_constants global imports */
function collectStringLiterals(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const literals = new Set<string>();
  let hasTypeofExpr = false;
  let hasTaggedTemplate = false;

  function visit(node: ts.Node) {
    // Skip computed property names — their string literals are resolved at
    // compile time and never appear as runtime values in the wasm output.
    if (ts.isComputedPropertyName(node)) return;

    if (ts.isStringLiteral(node)) {
      literals.add(node.text);
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      literals.add(node.text);
    }
    // Template expressions: collect head and span literal texts (include empty strings)
    if (ts.isTemplateExpression(node)) {
      literals.add(node.head.text);
      for (const span of node.templateSpans) {
        literals.add(span.literal.text);
      }
    }
    // Tagged template expressions: collect ALL string parts (including empty strings)
    // because tagged templates pass the full strings array to the tag function.
    // Also collect rawText values for the .raw property on template objects.
    // Register the template vec type early so tag function bodies can access .raw.
    if (ts.isTaggedTemplateExpression(node)) {
      hasTaggedTemplate = true;
      if (ts.isNoSubstitutionTemplateLiteral(node.template)) {
        literals.add(node.template.text);
        const rawText = (node.template as any).rawText;
        if (rawText !== undefined) literals.add(rawText);
      } else if (ts.isTemplateExpression(node.template)) {
        literals.add(node.template.head.text); // include empty strings
        const headRaw = (node.template.head as any).rawText;
        if (headRaw !== undefined) literals.add(headRaw);
        for (const span of node.template.templateSpans) {
          literals.add(span.literal.text); // include empty strings
          const spanRaw = (span.literal as any).rawText;
          if (spanRaw !== undefined) literals.add(spanRaw);
        }
      }
    }
    // RegExp literals: collect pattern and flags as string literals
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const { pattern, flags } = parseRegExpLiteral(node.getText());
      literals.add(pattern);
      if (flags) literals.add(flags);
    }
    // typeof expressions need type-name string constants
    if (ts.isTypeOfExpression(node)) {
      hasTypeofExpr = true;
    }
    // import.meta needs placeholder strings
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === "meta") {
      literals.add("module.wasm");
      literals.add("[object Object]");
    }
    forEachChild(node, visit);
  }

  // Scan all statements (including top-level code compiled into __module_init)
  forEachChild(sourceFile, visit);

  // typeof expressions may need type-name constants not present in source
  if (hasTypeofExpr) {
    for (const s of ["number", "string", "boolean", "object", "undefined", "function", "symbol"]) {
      literals.add(s);
    }
  }

  // Register the template vec type early so tag function bodies can use .raw
  if (hasTaggedTemplate) {
    getOrRegisterTemplateVecType(ctx);
  }

  if (literals.size === 0) return;

  if (ctx.nativeStrings) {
    // Native strings mode — ensure helpers are emitted, track literals
    // No wasm:js-string or string_constants imports needed
    ensureNativeStringHelpers(ctx);
    for (const value of literals) {
      // Track literals in stringGlobalMap so compileStringLiteral can find them.
      // Use a sentinel value (-1) since we don't import globals in fast mode.
      if (!ctx.stringGlobalMap.has(value)) {
        ctx.stringGlobalMap.set(value, -1);
      }
    }
    return;
  }

  // Register wasm:js-string imports since we have strings
  addStringImports(ctx);

  // Register a global import from "string_constants" for each unique string literal
  for (const value of literals) {
    addStringConstantGlobal(ctx, value);
  }
}

/** Register struct field names as string literals for for-in loops.
 *  Uses the type checker to get property names (runs before collectDeclarations). */
function collectForInStringLiterals(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const literals = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isForInStatement(node)) {
      const exprType = ctx.checker.getTypeAtLocation(node.expression);
      const props = exprType.getProperties();
      for (const prop of props) {
        if (!ctx.stringGlobalMap.has(prop.name)) literals.add(prop.name);
      }
    }
    forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (literals.size === 0) return;

  if (ctx.nativeStrings) {
    ensureNativeStringHelpers(ctx);
    for (const value of literals) {
      if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
    }
    return;
  }

  // Ensure wasm:js-string imports exist (may already be registered)
  addStringImports(ctx);

  for (const value of literals) {
    addStringConstantGlobal(ctx, value);
  }
}

/** Register struct field names as string literals for `key in obj` expressions
 *  where the key is a dynamic (non-literal) value. Pre-registers field names
 *  so they can be used for runtime string comparison. */
function collectInExprStringLiterals(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const literals = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword) {
      // Only collect for dynamic keys (non-string-literal, non-numeric-literal)
      if (!ts.isStringLiteral(node.left) && !ts.isNumericLiteral(node.left)) {
        const rightType = ctx.checker.getTypeAtLocation(node.right);
        const props = rightType.getProperties();
        for (const prop of props) {
          if (!ctx.stringGlobalMap.has(prop.name)) literals.add(prop.name);
        }
      }
    }
    forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (literals.size === 0) return;

  if (ctx.nativeStrings) {
    ensureNativeStringHelpers(ctx);
    for (const value of literals) {
      if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
    }
    return;
  }

  addStringImports(ctx);
  for (const value of literals) {
    addStringConstantGlobal(ctx, value);
  }
}

/** Register struct field names as string literals for Object.keys() / Object.values() calls.
 *  Detects Object.keys(expr) and Object.values(expr) patterns and pre-registers
 *  the field names from the argument's type as string thunks. */
function collectObjectMethodStringLiterals(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const literals = new Set<string>();
  let hasValues = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object" &&
      (node.expression.name.text === "keys" ||
        node.expression.name.text === "values" ||
        node.expression.name.text === "entries") &&
      node.arguments.length === 1
    ) {
      if (node.expression.name.text === "values" || node.expression.name.text === "entries") hasValues = true;
      const argType = ctx.checker.getTypeAtLocation(node.arguments[0]!);
      const props = argType.getProperties();
      for (const prop of props) {
        if (!ctx.stringLiteralMap.has(prop.name)) literals.add(prop.name);
      }
    }
    forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  // Object.values() needs union boxing imports (__box_number etc.)
  // to box primitive field values into externref. Register them now
  // before function indices are assigned in collectDeclarations.
  if (hasValues) {
    addUnionImports(ctx);
  }

  if (literals.size === 0) return;

  if (ctx.nativeStrings) {
    ensureNativeStringHelpers(ctx);
    for (const value of literals) {
      if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
    }
    return;
  }

  // Ensure wasm:js-string imports exist (may already be registered)
  addStringImports(ctx);

  for (const value of literals) {
    addStringConstantGlobal(ctx, value);
  }
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

/** Scan source for Math.xxx() calls that need host imports */
function collectMathImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const needed = new Set<string>();

  let needsToUint32 = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Math"
    ) {
      const method = node.expression.name.text;
      if (MATH_HOST_METHODS_1ARG.has(method) || MATH_HOST_METHODS_2ARG.has(method) || method === "random") {
        needed.add(method);
      }
      // clz32 and imul need __toUint32 for spec-correct ToUint32 conversion
      if (method === "clz32" || method === "imul") {
        needsToUint32 = true;
      }
    }
    // ** and **= operators need Math.pow
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskToken ||
        node.operatorToken.kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken)
    ) {
      needed.add("pow");
    }
    forEachChild(node, visit);
  }

  // Scan all statements (including top-level code compiled into __module_init)
  forEachChild(sourceFile, visit);

  for (const method of needed) {
    if (method === "random") {
      // #1322: in WASI/standalone mode, route random through WASI random_get
      // (the import is registered early by registerWasiImports). In JS-host
      // mode keep the host import.
      if (ctx.wasi) {
        ctx.pendingMathMethods.add(method);
      } else {
        const typeIdx = addFuncType(ctx, [], [{ kind: "f64" }]);
        addImport(ctx, "env", `Math_${method}`, { kind: "func", typeIdx });
      }
    } else {
      // All other math methods get pure Wasm implementations
      ctx.pendingMathMethods.add(method);
    }
  }

  // ToUint32: defer until after all imports are added; see emitToUint32Helper.
  if (needsToUint32) {
    ctx.needsToUint32 = true;
  }
}

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

/** Scan source for parseInt / parseFloat / Number() / unary + on strings and register host imports */
function collectParseImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const needed = new Set<string>();

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === "parseInt" || name === "parseFloat") {
        needed.add(name);
      }
      // Number(x) uses parseFloat for string→number coercion
      if (name === "Number") {
        needed.add("parseFloat");
      }
    }
    // Unary + on string uses parseFloat for coercion (but not for string literals
    // which are statically resolved by tryStaticToNumber)
    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.PlusToken &&
      !ts.isStringLiteral(node.operand) &&
      !ts.isNoSubstitutionTemplateLiteral(node.operand)
    ) {
      const operandType = ctx.checker.getTypeAtLocation(node.operand);
      if (operandType.flags & ts.TypeFlags.StringLike) {
        needed.add("parseFloat");
      }
    }
    // Loose equality (== / !=) between string and number/boolean needs parseFloat
    // to coerce the string operand to a number for comparison (#178)
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)
    ) {
      try {
        const leftType = ctx.checker.getTypeAtLocation(node.left);
        const rightType = ctx.checker.getTypeAtLocation(node.right);
        const leftIsStr = isStringType(leftType);
        const rightIsStr = isStringType(rightType);
        const leftIsNumOrBool = isNumberType(leftType) || isBooleanType(leftType);
        const rightIsNumOrBool = isNumberType(rightType) || isBooleanType(rightType);
        if ((leftIsStr && rightIsNumOrBool) || (rightIsStr && leftIsNumOrBool)) {
          needed.add("parseFloat");
        }
      } catch {
        // Type resolution may fail for some nodes — skip
      }
    }
    // Arithmetic/bitwise operators on string operands need parseFloat (#430)
    if (ts.isBinaryExpression(node)) {
      const opKind = node.operatorToken.kind;
      const isArithOrBitwise =
        opKind === ts.SyntaxKind.MinusToken ||
        opKind === ts.SyntaxKind.AsteriskToken ||
        opKind === ts.SyntaxKind.AsteriskAsteriskToken ||
        opKind === ts.SyntaxKind.SlashToken ||
        opKind === ts.SyntaxKind.PercentToken ||
        opKind === ts.SyntaxKind.AmpersandToken ||
        opKind === ts.SyntaxKind.BarToken ||
        opKind === ts.SyntaxKind.CaretToken ||
        opKind === ts.SyntaxKind.LessThanLessThanToken ||
        opKind === ts.SyntaxKind.GreaterThanGreaterThanToken ||
        opKind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken;
      if (isArithOrBitwise) {
        try {
          const leftType = ctx.checker.getTypeAtLocation(node.left);
          const rightType = ctx.checker.getTypeAtLocation(node.right);
          if (isStringType(leftType) || isStringType(rightType)) {
            needed.add("parseFloat");
          }
        } catch {
          // Type resolution may fail — skip
        }
      }
    }
    forEachChild(node, visit);
  }

  // Scan all statements (including top-level code compiled into __module_init)
  forEachChild(sourceFile, visit);

  for (const name of needed) {
    if (name === "parseInt") {
      // (externref, f64) -> f64  — radix is NaN when omitted
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "f64" }]);
      addImport(ctx, "env", name, { kind: "func", typeIdx });
    } else {
      // (externref) -> f64
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
      addImport(ctx, "env", name, { kind: "func", typeIdx });
    }
  }
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

/**
 * Scan source for `new X(args...)` where X is not a locally declared class
 * or known extern class, and register `__new_X` host imports so the runtime
 * can provide the constructor.
 */
function collectUnknownConstructorImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  // Map from constructor name to arg count (max seen)
  const needed = new Map<string, number>();

  function visit(node: ts.Node) {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (!KNOWN_CONSTRUCTORS.has(name)) {
        // Check if it's a class declared in this source file
        const sym = ctx.checker.getSymbolAtLocation(node.expression);
        const decls = sym?.getDeclarations() ?? [];
        const isLocalClass = decls.some((d) => {
          if (ts.isClassDeclaration(d) || ts.isClassExpression(d)) return d.getSourceFile() === sourceFile;
          // const Vec2 = class { ... } — variable whose initializer is a class expression
          if (ts.isVariableDeclaration(d) && d.initializer && ts.isClassExpression(d.initializer))
            return d.getSourceFile() === sourceFile;
          return false;
        });
        const isExtern = ctx.externClasses.has(name);
        if (!isLocalClass && !isExtern) {
          const argCount = node.arguments?.length ?? 0;
          const prev = needed.get(name) ?? 0;
          needed.set(name, Math.max(prev, argCount));
        }
      }
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);

  for (const [name, argCount] of needed) {
    const importName = `__new_${name}`;
    if (ctx.funcMap.has(importName)) continue;
    const params: ValType[] = Array.from({ length: argCount }, () => ({ kind: "externref" }) as ValType);
    const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
    addImport(ctx, "env", importName, { kind: "func", typeIdx });
  }
}

/**
 * Scan source for `new Number(x)`, `new String(x)`, `new Boolean(x)` and
 * register wrapper struct types so that resolveWasmType returns the correct
 * ref type for wrapper-typed variables.
 */
function collectWrapperConstructors(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let found = false;

  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (name === "Number" || name === "String" || name === "Boolean") {
        found = true;
        return;
      }
    }
    forEachChild(node, visit);
  }

  forEachChild(sourceFile, visit);

  if (found) {
    ensureWrapperTypes(ctx);
  }
}

/** Scan source for String.fromCharCode() calls and register host import */
function collectStringStaticImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let needsFromCharCode = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "String" &&
      node.expression.name.text === "fromCharCode"
    ) {
      needsFromCharCode = true;
    }
    forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.body) {
          visit(member.body);
        }
      }
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (needsFromCharCode) {
    // (f64) -> externref  (char code -> string)
    const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "String_fromCharCode", { kind: "func", typeIdx });
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
    }
  }
}

/** Scan source for Promise.all / Promise.race / Promise.resolve / Promise.reject
 *  calls and `new Promise(...)` constructor usage, and register host imports */
function collectPromiseImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const needed = new Set<string>();
  let needConstructor = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Promise"
    ) {
      const method = node.expression.name.text;
      // (#1368) include allSettled/any so they get pre-registered with the 2-arg
      // aggregator signature alongside all/race.
      if (
        method === "all" ||
        method === "race" ||
        method === "allSettled" ||
        method === "any" ||
        method === "resolve" ||
        method === "reject"
      ) {
        needed.add(method);
      }
    }
    // (#1368) Detect `Promise.METHOD.call(...)` patterns so their imports get
    // registered (otherwise the late path would see the existing-but-wrong-arity
    // pre-registration that was implicit before this fix).
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "call" &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      ts.isIdentifier(node.expression.expression.expression) &&
      node.expression.expression.expression.text === "Promise"
    ) {
      const method = node.expression.expression.name.text;
      if (method === "all" || method === "race" || method === "allSettled" || method === "any") {
        needed.add(method);
      }
    }
    // NOTE: Promise instance methods (.then/.catch/.finally) not detected here.
    // See #855 regression fix — pre-registering them shifts type indices.
    // Detect `new Promise(...)`
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Promise") {
      needConstructor = true;
    }
    forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.body) {
          visit(member.body);
        }
      }
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
    // Also visit top-level variable declarations and expressions
    if (ts.isVariableStatement(stmt)) {
      visit(stmt);
    }
    if (ts.isExpressionStatement(stmt)) {
      visit(stmt);
    }
    if (ts.isReturnStatement(stmt)) {
      visit(stmt);
    }
  }

  for (const method of needed) {
    const importName = `Promise_${method}`;
    if (!ctx.funcMap.has(importName)) {
      // (#1368) Aggregators (all/race/allSettled/any) take (thisArg, iterable);
      // resolve/reject keep their original 1-arg signature.
      // (#1116) Aggregators add an i32 `directCall` flag — 1 when codegen used
      // the bare `Promise.METHOD(iter)` form (substitute globalThis.Promise),
      // 0 when user wrote `Promise.METHOD.call(thisArg, iter)` (use thisArg).
      const isAggregator = method === "all" || method === "race" || method === "allSettled" || method === "any";
      const params: ValType[] = isAggregator
        ? [{ kind: "externref" }, { kind: "externref" }, { kind: "i32" }]
        : [{ kind: "externref" }];
      const typeIdx = addFuncType(ctx, params, [{ kind: "externref" }]);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
    }
  }

  // Register Promise instance methods: .then(cb) and .catch(cb)
  // These are detected from calls on Promise-typed values (e.g. p.then(...))
  for (const method of needed) {
    if (method === "then" || method === "catch") {
      const importName = `Promise_${method}`;
      if (!ctx.funcMap.has(importName)) {
        // Promise_then(promise, callback) -> promise
        // Promise_catch(promise, callback) -> promise
        const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
        addImport(ctx, "env", importName, { kind: "func", typeIdx });
      }
    }
  }

  // Register new Promise() constructor import: (externref) -> externref
  if (needConstructor && !ctx.funcMap.has("Promise_new")) {
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "Promise_new", { kind: "func", typeIdx });
  }
}

/** Scan source for JSON.parse / JSON.stringify calls and register host imports */
function collectJsonImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let needStringify = false;
  let needParse = false;

  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "JSON"
    ) {
      const method = node.expression.name.text;
      if (method === "stringify") needStringify = true;
      if (method === "parse") needParse = true;
    }
    forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      for (const member of stmt.members) {
        if (ts.isMethodDeclaration(member) && member.body) {
          visit(member.body);
        }
      }
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (needStringify || needParse) {
    addUnionImports(ctx);
  }
  if (needStringify) {
    // (value: externref, replacer: externref, space: externref) -> externref
    const typeIdx = addFuncType(
      ctx,
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
    );
    addImport(ctx, "env", "JSON_stringify", { kind: "func", typeIdx });
  }
  if (needParse) {
    // #2013 — (text, reviver); reviver is `ref.null.extern` when absent so the
    // host can apply §25.5.1 InternalizeJSONProperty.
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "JSON_parse", { kind: "func", typeIdx });
  }
}

/** Scan source for arrow functions used as call arguments and register __make_callback import */
function collectCallbackImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let found = false;

  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (found) break;
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (found) {
    // __make_callback: (i32, externref) → externref
    const typeIdx = addFuncType(ctx, [{ kind: "i32" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__make_callback", { kind: "func", typeIdx });
  }
}

/** Scan source for generator functions (function*) and register generator host imports */
function collectGeneratorImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let found = false;

  function visitNode(node: ts.Node): void {
    if (found) return;
    // Generator function declarations: function* foo() { ... }
    if (ts.isFunctionDeclaration(node) && node.asteriskToken && node.body && !hasDeclareModifier(node)) {
      found = true;
      return;
    }
    // Generator function expressions: const gen = function*() { ... }
    if (ts.isFunctionExpression(node) && node.asteriskToken) {
      found = true;
      return;
    }
    // Generator class methods: class Foo { *bar() { ... } }
    if (ts.isMethodDeclaration(node) && node.asteriskToken && node.body) {
      found = true;
      return;
    }
    forEachChild(node, visitNode);
  }

  for (const stmt of sourceFile.statements) {
    visitNode(stmt);
    if (found) break;
  }

  if (found && !ctx.funcMap.has("__gen_create_buffer")) {
    // __gen_create_buffer: () → externref  (creates an empty JS array)
    const bufType = addFuncType(ctx, [], [{ kind: "externref" }]);
    addImport(ctx, "env", "__gen_create_buffer", {
      kind: "func",
      typeIdx: bufType,
    });

    // __gen_push_f64: (externref, f64) → void  (pushes a number to the buffer)
    const pushF64Type = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], []);
    addImport(ctx, "env", "__gen_push_f64", {
      kind: "func",
      typeIdx: pushF64Type,
    });

    // __gen_push_i32: (externref, i32) → void  (pushes a boolean to the buffer)
    const pushI32Type = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], []);
    addImport(ctx, "env", "__gen_push_i32", {
      kind: "func",
      typeIdx: pushI32Type,
    });

    // __gen_push_ref: (externref, externref) → void  (pushes a string/object to the buffer)
    const pushRefType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], []);
    addImport(ctx, "env", "__gen_push_ref", {
      kind: "func",
      typeIdx: pushRefType,
    });

    // __gen_yield_star: (externref, externref) → void  (iterates inner iterable, pushes all values into outer buffer)
    addImport(ctx, "env", "__gen_yield_star", {
      kind: "func",
      typeIdx: pushRefType, // same signature as push_ref: (buf, iterable) → void
    });

    // __gen_set_return: (externref, externref) → void  (#2035 — stashes the
    // generator's `return` value on the buffer as a side property instead of
    // pushing it as a yielded element; surfaced once as the terminal result)
    addImport(ctx, "env", "__gen_set_return", {
      kind: "func",
      typeIdx: pushRefType, // same signature as push_ref: (buf, value) → void
    });

    // __create_generator: (buf: externref, pendingThrow: externref) → externref
    // Takes a buffer of yielded values and an optional pending exception,
    // returns a Generator-like object that defers the throw to the first next() call.
    const createGenType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__create_generator", {
      kind: "func",
      typeIdx: createGenType,
    });
    // __create_async_generator: same Wasm signature, but .next()/.return()/.throw() return Promises.
    addImport(ctx, "env", "__create_async_generator", {
      kind: "func",
      typeIdx: createGenType,
    });

    const genType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    // __gen_next: (generator: externref) → externref (calls gen.next(), returns IteratorResult)
    addImport(ctx, "env", "__gen_next", {
      kind: "func",
      typeIdx: genType,
    });

    // __gen_return: (generator: externref, value: externref) → externref (calls gen.return(value), returns IteratorResult)
    const genReturnType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__gen_return", {
      kind: "func",
      typeIdx: genReturnType,
    });

    // __gen_throw: (generator: externref, error: externref) → externref (calls gen.throw(error), returns IteratorResult)
    addImport(ctx, "env", "__gen_throw", {
      kind: "func",
      typeIdx: genReturnType,
    });

    // __gen_result_value: (result: externref) → externref (returns result.value)
    addImport(ctx, "env", "__gen_result_value", {
      kind: "func",
      typeIdx: genType,
    });

    // __gen_result_value_f64: (result: externref) → f64 (returns result.value as number)
    const resultValF64Type = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
    addImport(ctx, "env", "__gen_result_value_f64", {
      kind: "func",
      typeIdx: resultValF64Type,
    });

    // __gen_result_done: (result: externref) → i32 (returns result.done as boolean)
    const resultDoneType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
    addImport(ctx, "env", "__gen_result_done", {
      kind: "func",
      typeIdx: resultDoneType,
    });

    // Ensure __get_caught_exception is available for generator body try/catch wrappers
    if (!ctx.funcMap.has("__get_caught_exception")) {
      const getCaughtType = addFuncType(ctx, [], [{ kind: "externref" }]);
      addImport(ctx, "env", "__get_caught_exception", {
        kind: "func",
        typeIdx: getCaughtType,
      });
    }
  }
}

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

/** Scan source for functional array methods (filter, map, etc.) and register __call_Nf64 imports */
function collectFunctionalArrayImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let need1 = false;
  let need2 = false;

  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (FUNCTIONAL_ARRAY_METHODS.has(method)) {
        if (method === "reduce" || method === "reduceRight") {
          need2 = true;
        } else {
          need1 = true;
        }
      }
      // Also detect Array.prototype.METHOD.call(...) pattern
      if (method === "call" && ts.isPropertyAccessExpression(node.expression.expression)) {
        const innerMethod = node.expression.expression.name.text;
        if (FUNCTIONAL_ARRAY_METHODS.has(innerMethod)) {
          if (innerMethod === "reduce" || innerMethod === "reduceRight") {
            need2 = true;
          } else {
            need1 = true;
          }
        }
      }
    }
    forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (need1) {
    if (ctx.fast) {
      // __call_1_i32: (externref, i32) → i32 — invoke callback with 1 i32 arg (fast mode)
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "i32" }]);
      addImport(ctx, "env", "__call_1_i32", { kind: "func", typeIdx });
    } else {
      // __call_1_f64: (externref, f64) → f64 — invoke callback with 1 f64 arg
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "f64" }]);
      addImport(ctx, "env", "__call_1_f64", { kind: "func", typeIdx });
    }
  }

  if (need2) {
    if (ctx.fast) {
      // __call_2_i32: (externref, i32, i32) → i32 — invoke callback with 2 i32 args (fast mode)
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }, { kind: "i32" }], [{ kind: "i32" }]);
      addImport(ctx, "env", "__call_2_i32", { kind: "func", typeIdx });
    } else {
      // __call_2_f64: (externref, f64, f64) → f64 — invoke callback with 2 f64 args
      const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }, { kind: "f64" }], [{ kind: "f64" }]);
      addImport(ctx, "env", "__call_2_f64", { kind: "func", typeIdx });
    }
  }
}

/** Scan source for union types (number | string, etc.) and register needed helper imports */
function collectUnionImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let found = false;

  function visit(node: ts.Node) {
    if (found) return;
    // Check function parameter types for heterogeneous unions
    if (ts.isFunctionDeclaration(node) && node.parameters) {
      for (const param of node.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        if (isHeterogeneousUnion(paramType, ctx.checker)) {
          found = true;
          return;
        }
      }
    }
    // Check variable declarations for union types
    if (ts.isVariableDeclaration(node) && node.type) {
      const varType = ctx.checker.getTypeAtLocation(node);
      if (isHeterogeneousUnion(varType, ctx.checker)) {
        found = true;
        return;
      }
    }
    // Check for typeof expressions (used in narrowing)
    if (ts.isTypeOfExpression(node)) {
      found = true;
      return;
    }
    // Generator functions use externref-based iteration which triggers
    // ensureI32Condition with externref → needs __is_truthy from union imports
    if (ts.isFunctionDeclaration(node) && node.asteriskToken && node.body) {
      found = true;
      return;
    }
    if (ts.isFunctionExpression(node) && node.asteriskToken) {
      found = true;
      return;
    }
    if (ts.isMethodDeclaration(node) && node.asteriskToken && node.body) {
      found = true;
      return;
    }
    // for-of on non-array types uses externref iterator protocol which
    // may trigger ensureI32Condition with externref
    if (ts.isForOfStatement(node)) {
      const exprType = ctx.checker.getTypeAtLocation(node.expression);
      const sym = (exprType as ts.TypeReference).symbol ?? (exprType as ts.Type).symbol;
      if (sym?.name !== "Array") {
        found = true;
        return;
      }
    }
    forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
        visit(decl);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      visit(stmt);
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    }
  }

  if (found) {
    addUnionImports(ctx);
  }
}

/** Register union type helper imports (typeof checks, boxing/unboxing) */
export function addUnionImports(ctx: CodegenContext): void {
  if (ctx.hasUnionImports) return;
  ctx.hasUnionImports = true;

  // #2039: settle any deferred ensureLateImport batch before this pass bakes
  // or shifts funcIdx values. Under wasi/standalone the native-helper
  // registration below computes indices from the post-batch `numImportFuncs`;
  // in host mode the internal shift below uses its own `importsBefore`. Either
  // way, a still-pending batch flush would later re-apply its delta on top —
  // an over-shift that desyncs funcMap/bodies from actual function positions
  // (same mechanism as the ensureObjectRuntime guard; see object-runtime.ts).
  flushLateImportShifts(ctx, null);

  // Under `--target wasi` (#1180) and `--standalone` (#1471): emit Wasm-native
  // implementations of the box / unbox / typeof / is_truthy helpers instead of
  // `env::*` host imports, since a pure-Wasm engine (wasmtime, wasmer) cannot
  // satisfy the env::* imports without a JS host. The native impls preserve the
  // same name + signature so existing call sites
  // (`ctx.funcMap.get("__unbox_number")` etc.) work unchanged.
  // Same dual-mode pattern as #679 (strings) and #682 (RegExp).
  if (ctx.wasi || ctx.standalone) {
    addUnionImportsAsNativeFuncs(ctx);
    return;
  }

  // Record the import count before adding, so we can adjust defined-function
  // indices if imports are added after collectDeclarations has run.
  const importsBefore = ctx.numImportFuncs;

  // __typeof_number: (externref) → i32
  const typeofType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "env", "__typeof_number", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_string", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_boolean", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_bigint", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_undefined", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_object", {
    kind: "func",
    typeIdx: typeofType,
  });
  addImport(ctx, "env", "__typeof_function", {
    kind: "func",
    typeIdx: typeofType,
  });

  // __is_truthy: (externref) → i32
  addImport(ctx, "env", "__is_truthy", { kind: "func", typeIdx: typeofType });

  // __unbox_number: (externref) → f64
  const unboxNumType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
  addImport(ctx, "env", "__unbox_number", {
    kind: "func",
    typeIdx: unboxNumType,
  });

  // __unbox_boolean: (externref) → i32
  addImport(ctx, "env", "__unbox_boolean", {
    kind: "func",
    typeIdx: typeofType,
  });

  // __box_number: (f64) → externref
  const boxNumType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxNumType });

  // __box_boolean: (i32) → externref
  const boxBoolType = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__box_boolean", {
    kind: "func",
    typeIdx: boxBoolType,
  });

  // __box_symbol: (i32) → externref  (#2792 — boxes a symbol-handle i32 as a JS
  // Symbol via the identity-stable host symbol cache. The F1 `symbol[]` OOB read
  // routes here (HOST mode only — standalone defers `symbol[]`; see
  // `f1ElementBoxType`). Same (i32)→externref signature as __box_boolean. Only
  // reached on the host path; in standalone `addUnionImports` returns before this
  // block, so no symbol host import ever leaks into a standalone module.)
  addImport(ctx, "env", "__box_symbol", {
    kind: "func",
    typeIdx: boxBoolType,
  });

  // __box_bigint: (i64) → externref  (#1644 — boxes a branded-bigint i64 as a
  // JS bigint; JS-BigInt-integration makes the host body identity)
  const boxBigType = addFuncType(ctx, [{ kind: "i64" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__box_bigint", { kind: "func", typeIdx: boxBigType });

  // __to_bigint: (externref) → i64  (#1644 — §7.1.13 ToBigInt)
  const toBigType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i64" }]);
  addImport(ctx, "env", "__to_bigint", { kind: "func", typeIdx: toBigType });

  // __bigint_ctor: (externref) → i64  (#1644 Slice B — §21.2.1.1 BigInt(value):
  // ToPrimitive(number) then NumberToBigInt (RangeError) for Number, else
  // ToBigInt (SyntaxError on bad string syntax). Distinct from __to_bigint,
  // which throws TypeError on a Number per §7.1.13.)
  const ctorBigType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i64" }]);
  addImport(ctx, "env", "__bigint_ctor", { kind: "func", typeIdx: ctorBigType });

  // __typeof: (externref) → externref (returns type string)
  const typeofStrType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__typeof", {
    kind: "func",
    typeIdx: typeofStrType,
  });

  // If imports were added after defined functions were registered (late addition),
  // shift all defined-function indices and fix exports/funcMap/call instructions.
  // The new imports themselves (at indices importsBefore..numImportFuncs-1) are already
  // correct, so we only shift indices that were >= importsBefore BEFORE the addition,
  // i.e., the defined functions that start at index importsBefore in the old scheme.
  const delta = ctx.numImportFuncs - importsBefore;
  if (delta > 0 && ctx.mod.functions.length > 0) {
    // Build a set of the new import names to skip them during funcMap update
    const newImportNames = new Set([
      "__typeof_number",
      "__typeof_string",
      "__typeof_boolean",
      "__typeof_bigint",
      "__typeof_undefined",
      "__typeof_object",
      "__typeof_function",
      "__is_truthy",
      "__unbox_number",
      "__unbox_boolean",
      "__box_number",
      "__box_boolean",
      "__box_symbol",
      "__box_bigint",
      "__to_bigint",
      "__bigint_ctor",
      "__typeof",
    ]);
    // Update funcMap entries for defined functions (not imports)
    for (const [name, idx] of ctx.funcMap) {
      if (!newImportNames.has(name) && inLiveShiftRange(idx, importsBefore)) {
        ctx.funcMap.set(name, idx + delta);
      }
    }
    // (#2162) `mapHelpers` (Map/Set/WeakMap/WeakSet helper funcIdx) is NOT a
    // copy of funcMap — its entries are read directly by map-runtime.ts /
    // weak-collections-runtime.ts call sites to bake `call` funcIdx. It must be
    // shifted UNCONDITIONALLY in lockstep with the defined-function shift (the
    // nativeStr/nativeRegex shifts below are gated on the string-helper base and
    // would miss this in plain-Map programs). Leaving it stale let a late import
    // (e.g. `__box_number` for a numeric key/value) land between helper
    // registration and the call, so `wm.has` called `__map_get` → invalid Wasm.
    for (const [name, idx] of ctx.mapHelpers) {
      if (inLiveShiftRange(idx, importsBefore)) {
        ctx.mapHelpers.set(name, idx + delta);
      }
    }
    // Update export indices
    for (const exp of ctx.mod.exports) {
      if (exp.desc.kind === "func" && inLiveShiftRange(exp.desc.index, importsBefore)) {
        exp.desc.index += delta;
      }
    }
    // Track ALL instruction arrays (top-level AND nested) to prevent
    // double-shifting when fctx.body is a nested block reachable from savedBodies (#1109).
    const shifted = new Set<Instr[]>();
    function shiftFuncIndices(instrs: Instr[]): void {
      if (shifted.has(instrs)) return;
      shifted.add(instrs);
      for (const instr of instrs) {
        if ((instr.op === "call" || instr.op === "return_call") && inLiveShiftRange(instr.funcIdx, importsBefore)) {
          instr.funcIdx += delta;
        }
        if (instr.op === "ref.func" && inLiveShiftRange(instr.funcIdx, importsBefore)) {
          instr.funcIdx += delta;
        }
        const a = instr as any;
        if (a.body && Array.isArray(a.body)) shiftFuncIndices(a.body);
        if (a.then && Array.isArray(a.then)) shiftFuncIndices(a.then);
        if (a.else && Array.isArray(a.else)) shiftFuncIndices(a.else);
        if (a.catches && Array.isArray(a.catches)) {
          for (const c of a.catches) {
            if (Array.isArray(c.body)) shiftFuncIndices(c.body);
          }
        }
        if (a.catchAll && Array.isArray(a.catchAll)) shiftFuncIndices(a.catchAll);
      }
    }
    for (const func of ctx.mod.functions) {
      shiftFuncIndices(func.body);
    }
    if (ctx.currentFunc) {
      shiftFuncIndices(ctx.currentFunc.body);
      for (const sb of ctx.currentFunc.savedBodies) {
        shiftFuncIndices(sb);
      }
    }
    for (const parentFctx of ctx.funcStack) {
      shiftFuncIndices(parentFctx.body);
      for (const sb of parentFctx.savedBodies) {
        shiftFuncIndices(sb);
      }
    }
    for (const pb of ctx.parentBodiesStack) {
      shiftFuncIndices(pb);
    }
    // (#1384) Walk all live (allocated but not yet attached to mod.functions)
    // FunctionContext bodies — covers cbFctx.body / liftedFctx.body during
    // their captures-extraction + param-coercion setup phases, BEFORE the
    // savedFunc swap puts them on funcStack/parentBodiesStack.
    for (const lb of ctx.liveBodies) {
      shiftFuncIndices(lb);
    }
    if (ctx.pendingInitBody) {
      shiftFuncIndices(ctx.pendingInitBody);
    }
    // Update table elements
    for (const elem of ctx.mod.elements) {
      if (elem.funcIndices) {
        for (let i = 0; i < elem.funcIndices.length; i++) {
          if (inLiveShiftRange(elem.funcIndices[i]!, importsBefore)) {
            elem.funcIndices[i]! += delta;
          }
        }
      }
    }
    // Update declaredFuncRefs
    if (ctx.mod.declaredFuncRefs.length > 0) {
      ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map((idx) =>
        inLiveShiftRange(idx, importsBefore) ? idx + delta : idx,
      );
    }
    // Update Wasm start function index (#907) — late-added imports shift the
    // defined-function index that __module_init lives at.
    if (ctx.mod.startFuncIdx !== undefined && inLiveShiftRange(ctx.mod.startFuncIdx, importsBefore)) {
      ctx.mod.startFuncIdx += delta;
    }
    // Sync nativeStrHelpers and re-base so reconcileNativeStrFinalizeShift is a no-op
    // for this import batch — the inline shiftFuncIndices above already corrected all
    // native-string helper bodies. Without this, reconcile double-shifts them (#1677-fast-path).
    if (ctx.nativeStrHelperImportBase >= 0) {
      for (const [name, idx] of ctx.nativeStrHelpers) {
        if (inLiveShiftRange(idx, importsBefore)) ctx.nativeStrHelpers.set(name, idx + delta);
      }
      // (#1913) Regex helper map shares the same lifecycle.
      for (const [name, idx] of ctx.nativeRegexHelpers) {
        if (inLiveShiftRange(idx, importsBefore)) ctx.nativeRegexHelpers.set(name, idx + delta);
      }
      ctx.nativeStrHelperImportBase = ctx.numImportFuncs;
    }
    // (#1525b) Shift pendingMethodTrampolines side-channel indices in lockstep.
    // The captured methodFuncIdx / trampolineFuncIdx are plain numbers not
    // reachable from any Instr — without this, finalizeMethodTrampolines later
    // resolves the wrong (import) signature, producing invalid Wasm.
    for (const t of ctx.pendingMethodTrampolines) {
      if (inLiveShiftRange(t.methodFuncIdx, importsBefore)) t.methodFuncIdx += delta;
      if (inLiveShiftRange(t.trampolineFuncIdx, importsBefore)) t.trampolineFuncIdx += delta;
    }
    // (#2918) Async-scheduler + Promise.all/race combinator side-channel funcIdxs
    // move in lockstep too (addUnionImports missed them). Same complete key list
    // as shiftLateImportIndices / addStringImports.
    shiftAsyncSideChannelFuncIdxs(ctx, importsBefore, delta);
  }
}

/**
 * Wasm-native implementation of the union helper functions (#1180).
 *
 * Used under `--target wasi`, where the standard `env::*` host imports
 * cannot be satisfied by wasmtime. Instead of importing the helpers, we
 * register a small set of WasmGC struct types (`__box_number_struct`,
 * `__box_boolean_struct`) plus a synthesized function for each helper
 * with the SAME name and signature as the host-mode import. Existing
 * call sites that look helpers up via `ctx.funcMap.get("__unbox_number")`
 * etc. transparently call the native version.
 *
 * Semantics mirror the JS host runtime where possible:
 *   - `__box_number(f64)` wraps the value in a `__box_number_struct` and
 *     converts to externref via `extern.convert_any`.
 *   - `__unbox_number(externref)` returns 0 for null (matches `Number(null)`),
 *     extracts the value if the externref is a `__box_number_struct`,
 *     otherwise returns `NaN` (matches `Number(opaque host value)`).
 *   - `__box_boolean(i32)` / `__unbox_boolean(externref)` mirror the
 *     number variants with an `i32` payload.
 *   - `__is_truthy(externref)` returns 0 for null and for boxed-zero /
 *     boxed-NaN / boxed-false; returns 1 for any other ref (any non-null
 *     reference is truthy in JS).
 *   - `__typeof_number/string/boolean(externref)` use `ref.test` against
 *     the appropriate boxed struct (string under wasi/nativeStrings is
 *     the NativeString struct at `ctx.anyStrTypeIdx`).
 *   - `__typeof_undefined(externref)` is `ref.is_null`.
 *   - `__typeof_object/function(externref)` are conservatively 0 — wasi
 *     binaries don't have a JS-side function or generic object value to
 *     surface here.
 *   - `__typeof(externref)` returns null externref. Producing a real
 *     type-tag string under nativeStrings would require constructing a
 *     NativeString per tag, which is deferred until a wasi caller
 *     actually needs the result of `typeof v` as a string. Today's
 *     callers either pre-fold the typeof at the AST level or compare
 *     against a string literal (which uses `__typeof_*` instead).
 *
 * Why a struct-based box rather than letting the externref carry a raw
 * f64: externref is opaque at the Wasm level — there's no way to read a
 * payload back out without going through the WasmGC any.* / ref.cast
 * machinery against a registered struct type. The struct gives us a
 * stable shape the unbox helper can pattern-match against, and the
 * `extern.convert_any` / `any.convert_extern` round-trip is a no-op at
 * the Wasm engine level.
 */
function addUnionImportsAsNativeFuncs(ctx: CodegenContext): void {
  // #1807: settle any pending native-string finalize shift BEFORE registering
  // the union helpers. `reconcileNativeStrFinalizeShift` applies a SINGLE
  // uniform `(numImportFuncs - base)` delta to every defined function with a
  // baked `call funcIdx >= base`. That uniform model is only correct when all
  // those defined functions were registered at the SAME import count (`base`).
  //
  // The native-string helpers snapshot `base = numImportFuncs` at their first
  // emission (often `numImportFuncs == 0`, before any host import). If another
  // import is then added (e.g. `__make_callback`, or the generator-bridge
  // imports) BEFORE this union-helper block runs, the union helpers are
  // registered at a HIGHER import count — their `numImportFuncs + arrayPos`
  // indices already bake in those intervening imports. The end-of-finalize
  // reconcile would then over-shift them by exactly `(numImportFuncs_now -
  // base)`, pushing every `__typeof_*` / `__unbox_*` call target in callers
  // like the test262 `isSameValue` harness helper +N too high. After dead-import
  // elimination compacts the index space that surfaces as
  // `isSameValue ... call[0] expected type i32, found local.get of type
  // externref` — a stale call into an adjacent boxing helper (277 standalone
  // async-generator tests).
  //
  // Flushing here advances `base` to the current `numImportFuncs`, so the
  // already-registered native-string helpers absorb the intervening imports now
  // and the union helpers register at the SAME (re-based) `base`. The final
  // reconcile then applies one consistent delta to BOTH groups. No-op on the
  // default GC path (base stays -1) and when no import drifted the count.
  if (ctx.nativeStrHelperImportBase >= 0 && ctx.numImportFuncs > ctx.nativeStrHelperImportBase) {
    reconcileNativeStrFinalizeShift(ctx);
  }

  // 1. Register the boxed-value struct types. Both are immutable singletons.
  const boxNumStructIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__box_number_struct",
    fields: [{ name: "value", type: { kind: "f64" }, mutable: false }],
  });

  const boxBoolStructIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__box_boolean_struct",
    fields: [{ name: "value", type: { kind: "i32" }, mutable: false }],
  });

  const bigIntStructIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$BigInt",
    fields: [{ name: "value", type: { kind: "i64", bigint: true }, mutable: false }],
  });
  ctx.nativeBoxNumberTypeIdx = boxNumStructIdx;
  ctx.nativeBoxBooleanTypeIdx = boxBoolStructIdx;
  ctx.nativeBigIntTypeIdx = bigIntStructIdx;

  // 2. Pre-compute func types — addFuncType de-dupes by signature so
  //    repeated calls return the same typeIdx.
  const externrefToI32 = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  const externrefToF64 = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
  const externrefToI64 = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i64", bigint: true }]);
  const f64ToExternref = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
  const i32ToExternref = addFuncType(ctx, [{ kind: "i32" }], [{ kind: "externref" }]);
  const i64ToExternref = addFuncType(ctx, [{ kind: "i64", bigint: true }], [{ kind: "externref" }]);
  const externrefToExternref = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);

  if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && !ctx.funcMap.has("__str_to_number")) {
    emitNativeParseNumber(ctx, new Set(["__str_to_number"]));
  }
  const strToNumberIdx = ctx.funcMap.get("__str_to_number");

  // (#2106 S1) `undefinedSingleton` regime support for the union natives:
  // when active, `undefined` is a non-null extern-wrapped tag-1 `$AnyValue`
  // (never `ref.null.extern`), so ToBoolean must classify it FALSY, the
  // typeof cluster must answer "undefined" for the singleton and "object"
  // for null, and `__typeof_undefined` flips off bare `ref.is_null`.
  // Inactive (default): every body below is byte-identical to legacy.
  const s1Active = undefinedSingletonActive(ctx);
  if (s1Active) ensureAnyValueType(ctx);
  const s1AnyValIdx = s1Active ? ctx.anyValueTypeIdx : -1;

  /**
   * Synthesize a native helper function. The funcIdx is allocated as
   * `numImportFuncs + mod.functions.length` to match how every other
   * synthesized function (e.g. `__toUint32` from #1094) gets its slot.
   */
  const registerNative = (
    name: string,
    typeIdx: number,
    body: Instr[],
    locals: { name: string; type: ValType }[] = [],
  ): void => {
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.funcMap.set(name, funcIdx);
    ctx.mod.functions.push({ name, typeIdx, locals, body, exported: false });
  };

  const throwNativeError = (errorName: "TypeError" | "RangeError" | "SyntaxError", message: string): Instr[] => {
    emitWasiErrorConstructor(ctx, errorName, 1);
    addStringConstantGlobal(ctx, message);
    const ctorIdx = ctx.funcMap.get(`__new_${errorName}`)!;
    const tagIdx = ensureExnTag(ctx);
    return [
      ...stringConstantExternrefInstrs(ctx, message),
      { op: "call", funcIdx: ctorIdx },
      { op: "throw", tagIdx } as Instr,
    ];
  };

  // 3. __box_number(f64) -> externref
  registerNative("__box_number", f64ToExternref, [
    { op: "local.get", index: 0 },
    { op: "struct.new", typeIdx: boxNumStructIdx },
    { op: "extern.convert_any" },
  ]);

  // 4. __unbox_number(externref) -> f64
  //    Local 1 is an anyref temp used to ref.test then ref.cast without
  //    re-evaluating the parameter (which is fine — it's a local.get —
  //    but the temp shape mirrors the spec'd structure for symmetry).
  registerNative(
    "__unbox_number",
    externrefToF64,
    [
      // if (ref.is_null param) return 0   // Number(null) === 0
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "f64.const", value: 0 }, { op: "return" }],
      },
      // any = any.convert_extern(param)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      // if (ref.test $box_number_struct any) return any.value
      { op: "ref.test", typeIdx: boxNumStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxNumStructIdx },
          { op: "struct.get", typeIdx: boxNumStructIdx, fieldIdx: 0 },
          { op: "return" },
        ],
      },
      // #1910 R3 — a boxed boolean (the [[BooleanData]] slot of a
      // `new Boolean(x)` wrapper, recovered by `__to_primitive`) coerces per
      // §7.1.4 ToNumber(true)=1, ToNumber(false)=0. Without this arm a boxed
      // boolean fell through to the opaque-ref NaN fallback, so
      // `Number(new Boolean(true))` returned NaN instead of 1.
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxBoolStructIdx },
          { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
          { op: "f64.convert_i32_s" },
          { op: "return" },
        ],
      },
      ...(strToNumberIdx !== undefined && ctx.anyStrTypeIdx >= 0
        ? ([
            // StringToNumber (§7.1.4.1): object ToPrimitive can yield a native
            // string; parse it with the existing pure-Wasm scanner before the
            // opaque-ref NaN fallback.
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: strToNumberIdx }, { op: "return" }],
            },
          ] as Instr[])
        : []),
      // not a recognized boxed number → NaN (matches Number(opaque))
      { op: "f64.const", value: NaN },
    ],
    [{ name: "$any_temp", type: { kind: "anyref" } as ValType }],
  );

  // 5. __box_boolean(i32) -> externref
  registerNative("__box_boolean", i32ToExternref, [
    { op: "local.get", index: 0 },
    { op: "struct.new", typeIdx: boxBoolStructIdx },
    { op: "extern.convert_any" },
  ]);

  // #1644 Slice E1 — __box_bigint(i64) -> externref. In no-JS-host mode a
  // bigint-branded i64 needs a WasmGC carrier so it cannot fall through to the
  // number-box path and lose its BigInt identity at the externref frontier.
  registerNative("__box_bigint", i64ToExternref, [
    { op: "local.get", index: 0 },
    { op: "struct.new", typeIdx: bigIntStructIdx },
    { op: "extern.convert_any" },
  ]);

  // 6. __unbox_boolean(externref) -> i32
  //    Returns the boxed value if it's a __box_boolean_struct, otherwise
  //    falls back to Boolean-coercion: null → false, any non-null ref
  //    that isn't a boxed bool → ALSO false (under wasi we don't
  //    distinguish other truthy refs at the unbox level; the runtime
  //    fallback in `helpers.ts` does `v ? 1 : 0` which would say true,
  //    but for unbox-as-typed-call-arg the safe default is false).
  //    Boxed numbers go through __unbox_number first, then truthy-check.
  registerNative(
    "__unbox_boolean",
    externrefToI32,
    [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxBoolStructIdx },
          { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
          { op: "return" },
        ],
      },
      // not a boxed bool → false (conservative under wasi)
      { op: "i32.const", value: 0 },
    ],
    [{ name: "$any_temp", type: { kind: "anyref" } as ValType }],
  );

  // #1644 Slice E1 — __to_bigint(externref) -> i64. This is the native
  // ToBigInt frontier for values already represented by the standalone
  // BigInt struct, plus boolean -> 0n/1n. Boxed numbers throw TypeError per
  // ECMA-262 §7.1.13; native string parsing is deferred to the constructor
  // slice, so unsupported non-BigInt refs also throw instead of becoming 0.
  registerNative(
    "__to_bigint",
    externrefToI64,
    [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: throwNativeError("TypeError", "Cannot convert null or undefined to a BigInt"),
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: bigIntStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: bigIntStructIdx },
          { op: "struct.get", typeIdx: bigIntStructIdx, fieldIdx: 0 },
          { op: "return" },
        ],
      },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxBoolStructIdx },
          { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
          { op: "i64.extend_i32_u" },
          { op: "return" },
        ],
      },
      ...throwNativeError("TypeError", "Cannot convert value to a BigInt"),
    ],
    [{ name: "$any_temp", type: { kind: "anyref" } as ValType }],
  );

  // #1644 Slice E1/E2 bridge — minimal no-JS-host BigInt(value). Handles the
  // standalone carriers that can be represented without a string parser:
  // bigint identity, boolean -> 0n/1n, and integral finite boxed numbers.
  registerNative(
    "__bigint_ctor",
    externrefToI64,
    [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: throwNativeError("TypeError", "Cannot convert null or undefined to a BigInt"),
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: bigIntStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: bigIntStructIdx },
          { op: "struct.get", typeIdx: bigIntStructIdx, fieldIdx: 0 },
          { op: "return" },
        ],
      },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxBoolStructIdx },
          { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
          { op: "i64.extend_i32_u" },
          { op: "return" },
        ],
      },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: boxNumStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxNumStructIdx },
          { op: "struct.get", typeIdx: boxNumStructIdx, fieldIdx: 0 },
          { op: "local.tee", index: 2 },
          { op: "local.get", index: 2 },
          { op: "f64.ne" },
          { op: "local.get", index: 2 },
          { op: "f64.floor" },
          { op: "local.get", index: 2 },
          { op: "f64.ne" },
          { op: "i32.or" },
          { op: "local.get", index: 2 },
          { op: "f64.const", value: 2 ** 63 },
          { op: "f64.ge" },
          { op: "i32.or" },
          { op: "local.get", index: 2 },
          { op: "f64.const", value: -(2 ** 63) },
          { op: "f64.lt" },
          { op: "i32.or" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: throwNativeError(
              "RangeError",
              "The number cannot be converted to a BigInt because it is not an integer",
            ),
          },
          { op: "local.get", index: 2 },
          { op: "i64.trunc_sat_f64_s" },
          { op: "return" },
        ],
      },
      ...throwNativeError("SyntaxError", "Cannot convert string to a BigInt in standalone mode"),
    ],
    [
      { name: "$any_temp", type: { kind: "anyref" } as ValType },
      { name: "$num_temp", type: { kind: "f64" } },
    ],
  );

  // 7. __is_truthy(externref) -> i32
  //    null → 0; boxed number → value !== 0 && !NaN; boxed bool → value;
  //    anything else (other refs) → 1 (any non-null ref is truthy in JS).
  registerNative(
    "__is_truthy",
    externrefToI32,
    [
      // if (ref.is_null param) return 0
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // (#2106 S1) `$AnyValue` box: tag 0 (null) / 1 (undefined) → FALSY
      // (§7.1.2); other wrapped tags (5 string / 6 object) keep the non-null-
      // ref default (truthy). Without this arm the non-null `$undefined`
      // singleton would be truthy — `if (undefined)` taking the then-branch.
      ...(s1AnyValIdx >= 0
        ? ([
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "local.tee", index: 1 },
            { op: "ref.test", typeIdx: s1AnyValIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 1 },
                { op: "ref.cast", typeIdx: s1AnyValIdx },
                { op: "struct.get", typeIdx: s1AnyValIdx, fieldIdx: 0 },
                { op: "i32.const", value: 1 },
                { op: "i32.gt_u" },
                { op: "return" },
              ],
            },
          ] as Instr[])
        : []),
      // any = any.convert_extern(param)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      // boxed number? → value !== 0 && value === value
      { op: "ref.test", typeIdx: boxNumStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxNumStructIdx },
          { op: "struct.get", typeIdx: boxNumStructIdx, fieldIdx: 0 },
          { op: "local.tee", index: 2 },
          // value !== 0
          { op: "f64.const", value: 0 },
          { op: "f64.ne" },
          { op: "local.get", index: 2 },
          // value === value (NaN check — NaN !== NaN)
          { op: "local.get", index: 2 },
          { op: "f64.eq" },
          { op: "i32.and" },
          { op: "return" },
        ],
      },
      // boxed bool? → value
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: boxBoolStructIdx },
          { op: "struct.get", typeIdx: boxBoolStructIdx, fieldIdx: 0 },
          { op: "return" },
        ],
      },
      // boxed bigint? → value !== 0n
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: bigIntStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: bigIntStructIdx },
          { op: "struct.get", typeIdx: bigIntStructIdx, fieldIdx: 0 },
          { op: "i64.eqz" },
          { op: "i32.eqz" },
          { op: "return" },
        ],
      },
      // (#2080) native string? → length !== 0 (ToBoolean §7.1.2: "" → false).
      // In standalone/nativeStrings mode an `any`-held string is a $AnyString
      // (the supertype of $NativeString / $ConsString, all carrying $len at
      // field 0) wrapped as externref — NOT a $AnyValue box. Without this arm
      // it falls through to the "any non-null ref → truthy" default, so the
      // empty string is wrongly truthy. Guarded on anyStrTypeIdx so the GC /
      // host-string path (no native-string type registered) is unaffected.
      ...(ctx.anyStrTypeIdx >= 0
        ? ([
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 1 },
                { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
                { op: "struct.get", typeIdx: ctx.anyStrTypeIdx, fieldIdx: 0 },
                { op: "i32.const", value: 0 },
                { op: "i32.ne" },
                { op: "return" },
              ],
            },
          ] as Instr[])
        : []),
      // any other non-null ref → truthy
      { op: "i32.const", value: 1 },
    ],
    [
      { name: "$any_temp", type: { kind: "anyref" } as ValType },
      { name: "$f64_temp", type: { kind: "f64" } },
    ],
  );

  // 8. __typeof_number(externref) -> i32 — `ref.test $box_number_struct`.
  registerNative("__typeof_number", externrefToI32, [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: boxNumStructIdx },
  ]);

  // 9. __typeof_boolean(externref) -> i32 — `ref.test $box_boolean_struct`.
  registerNative("__typeof_boolean", externrefToI32, [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: boxBoolStructIdx },
  ]);

  // 10. __typeof_bigint(externref) -> i32 — `ref.test $BigInt`.
  registerNative("__typeof_bigint", externrefToI32, [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: bigIntStructIdx },
  ]);

  // 11. __typeof_string(externref) -> i32. Under nativeStrings (auto-on
  //     for wasi) strings are NativeString structs at `ctx.anyStrTypeIdx`.
  //     If that type isn't registered, return 0 (no string in scope).
  if (ctx.anyStrTypeIdx >= 0) {
    const strTypeIdx = ctx.anyStrTypeIdx;
    registerNative("__typeof_string", externrefToI32, [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: strTypeIdx },
    ]);
  } else {
    registerNative("__typeof_string", externrefToI32, [{ op: "i32.const", value: 0 }]);
  }

  // 12. __typeof_undefined(externref) -> i32 — `ref.is_null` (legacy: null and
  //     undefined share the null-extern bit pattern). (#2106 S1) Under the
  //     `undefinedSingleton` regime: tag-1 `$AnyValue` ∨ UNDEF_F64 box; a null
  //     externref answers 0 (typeof null is "object", not "undefined").
  {
    const s1Body = s1Active ? buildIsUndefinedExternBody(ctx, 1, UNDEF_F64_BITS) : undefined;
    registerNative(
      "__typeof_undefined",
      externrefToI32,
      s1Body ?? [{ op: "local.get", index: 0 }, { op: "ref.is_null" }],
      s1Body !== undefined ? [{ name: "$any_temp", type: { kind: "anyref" } as ValType }] : [],
    );
  }

  // 13. __typeof_object(externref) -> i32 — non-null AND not number AND
  //     not boolean AND not bigint AND not function. We approximate as "non-null and
  //     not a boxed primitive" — sufficient for the common typeof
  //     dispatch use cases. Returns 0 conservatively for boxed numbers
  //     and boxed booleans.
  registerNative(
    "__typeof_object",
    externrefToI32,
    [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        // (#2106 S1) typeof null IS "object" (§13.5.3) — under the singleton
        // regime a null externref means JS null, so answer 1. Legacy: null
        // means null-or-undefined; keep the historical 0.
        then: [{ op: "i32.const", value: s1Active ? 1 : 0 }, { op: "return" }],
      },
      // (#2106 S1) the tag-1 `$undefined` singleton is NOT an object.
      ...(s1AnyValIdx >= 0
        ? ([
            { op: "local.get", index: 0 },
            { op: "any.convert_extern" },
            { op: "local.tee", index: 1 },
            { op: "ref.test", typeIdx: s1AnyValIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 1 },
                { op: "ref.cast", typeIdx: s1AnyValIdx },
                { op: "struct.get", typeIdx: s1AnyValIdx, fieldIdx: 0 },
                { op: "i32.const", value: 1 },
                { op: "i32.eq" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "i32.const", value: 0 }, { op: "return" }],
                } as Instr,
              ],
            },
          ] as Instr[])
        : []),
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: boxNumStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: boxBoolStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx: bigIntStructIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // (#2107) native string ($AnyString) → "string", NOT "object". Under
      // nativeStrings/standalone a string value is a `$AnyString` GC struct
      // carried as externref; without this guard `typeof (s: any) === "object"`
      // wrongly held and `=== "string"` was the only true arm via the separate
      // __typeof_string helper, so both string-tagged comparisons disagreed.
      ...(ctx.anyStrTypeIdx >= 0
        ? ([
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: 0 }, { op: "return" }],
            },
          ] as Instr[])
        : []),
      // non-null, not a boxed primitive → object
      { op: "i32.const", value: 1 },
    ],
    [{ name: "$any_temp", type: { kind: "anyref" } as ValType }],
  );

  // 14. __typeof_function(externref) -> i32 — wasi binaries don't expose
  //     callable JS functions to the outside, so this is conservatively 0.
  registerNative("__typeof_function", externrefToI32, [{ op: "i32.const", value: 0 }]);

  // 15. __typeof(externref) -> externref — the MATERIALIZED typeof result.
  //     (#2965) This was a `ref.null.extern` stub ("defer until a wasi caller
  //     needs the typeof RESULT as a string"), which silently broke every
  //     standalone site where the typeof string is a VALUE rather than an
  //     inline `typeof x === "…"` compare: `var t = typeof x`,
  //     `assert_sameValue_str(typeof(o.p), "undefined")` (the test262 runner's
  //     paren-form transform miss), any typeof flowing through a param. The
  //     result was a null externref, so `t === "undefined"` was false for
  //     EVERY tag and `t.length` trapped. Classify with the same dispatch the
  //     `__typeof_*` predicates above use (null → "undefined", box_number →
  //     "number", box_boolean → "boolean", $BigInt → "bigint", $AnyString →
  //     "string", else → "object"). (#2175 V2-S1) A closure/function value read
  //     back here would otherwise fall through to "object";
  //     `fillStandaloneTypeofClosureArms` splices a closure `ref.test` →
  //     "function" arm before the terminal at finalize (closures aren't all
  //     registered yet at this registration point), so the materialized result
  //     agrees with the `__typeof_function` predicate. The tag is returned as
  //     an inline NativeString (sentinel-safe, no funcidx baked — the #2515
  //     discipline; string literals here are type-index-only instructions, so
  //     the late-import finalize shift cannot desync this body). Falls back to
  //     the old stub only when no native-string type is registered (then no
  //     string content could be represented anyway).
  if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
    const typeofTagArm = (test: Instr[], tag: string): Instr[] => [
      ...test,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...stringConstantExternrefInstrs(ctx, tag), { op: "return" }],
      },
    ];
    registerNative(
      "__typeof",
      externrefToExternref,
      [
        // null externref → undefined (matches __typeof_undefined = ref.is_null).
        // (#2106 S1) Under the singleton regime null means JS null → "object"
        // (§13.5.3), and the tag-1/UNDEF-box arm below answers "undefined".
        ...typeofTagArm([{ op: "local.get", index: 0 }, { op: "ref.is_null" }], s1Active ? "object" : "undefined"),
        ...(s1Active
          ? (() => {
              const test = buildIsUndefinedExternBody(ctx, 1, UNDEF_F64_BITS);
              return test !== undefined ? typeofTagArm(test, "undefined") : [];
            })()
          : []),
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.set", index: 1 },
        ...typeofTagArm(
          [
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: boxNumStructIdx },
          ],
          "number",
        ),
        ...typeofTagArm(
          [
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: boxBoolStructIdx },
          ],
          "boolean",
        ),
        ...typeofTagArm(
          [
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: bigIntStructIdx },
          ],
          "bigint",
        ),
        ...(ctx.anyStrTypeIdx >= 0
          ? typeofTagArm(
              [
                { op: "local.get", index: 1 },
                { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
              ],
              "string",
            )
          : []),
        // non-null, not a boxed primitive, not a string → object
        ...stringConstantExternrefInstrs(ctx, "object"),
      ],
      [{ name: "$any_temp", type: { kind: "anyref" } as ValType }],
    );
  } else {
    registerNative("__typeof", externrefToExternref, [{ op: "ref.null.extern" }]);
  }

  // #2508 — native `__host_eq` (Strict Equality, §7.2.16) and
  // `__same_value_zero` (SameValueZero, §7.2.11) over two boxed externrefs, so
  // standalone `any[].indexOf/lastIndexOf/includes` need no JS host import. Tag
  // dispatch mirrors the inline `===` lowering (#1776, binary-ops.ts): both
  // number → unbox f64 & compare; both boolean → unbox i32; both bigint →
  // i64; else reference identity on the WasmGC `eq` heap type. The ONLY
  // difference between Strict and SameValueZero is the number arm's NaN case:
  // Strict has NaN ≠ NaN (`f64.eq`), SameValueZero has NaN = NaN. Both treat
  // +0 = -0 as equal, which `f64.eq` already gives.
  {
    const externref2ToI32 = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
    const typeofNumIdx = ctx.funcMap.get("__typeof_number")!;
    const typeofBoolIdx = ctx.funcMap.get("__typeof_boolean")!;
    const typeofBigIdx = ctx.funcMap.get("__typeof_bigint")!;
    const unboxNumIdx = ctx.funcMap.get("__unbox_number")!;
    const unboxBoolIdx = ctx.funcMap.get("__unbox_boolean")!;
    const toBigIdx = ctx.funcMap.get("__to_bigint")!;
    const EQ_HEAP = -19; // WasmGC `eq` abstract heap type

    // params: l=0, r=1 ; locals: la=2 (anyref), ra=3 (anyref)
    const bothTag = (tagIdx: number): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: tagIdx } as Instr,
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: tagIdx } as Instr,
      { op: "i32.and" },
    ];
    // Reference-identity arm (else): both refs convert to anyref (locals 2/3);
    // if both are eq heap refs, ref.eq; otherwise unequal.
    const refIdentityArm: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: EQ_HEAP } as Instr,
      { op: "local.get", index: 3 },
      { op: "ref.test", typeIdx: EQ_HEAP } as Instr,
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx: EQ_HEAP } as Instr,
          { op: "local.get", index: 3 },
          { op: "ref.cast", typeIdx: EQ_HEAP } as Instr,
          { op: "ref.eq" },
        ],
        else: [{ op: "i32.const", value: 0 }],
      } as Instr,
    ];
    // String VALUE equality is NOT inlined here. A boxed-any STRING element
    // compares by content (`["x"].indexOf("x")` must match), which needs a
    // `__str_flatten`+`__str_equals` call. But those helpers live in the
    // native-string regime BELOW the union-helper base, and any call to them
    // baked into THIS union-helper body drifts under the late-import finalize
    // shift (`reconcileNativeStrFinalizeShift` re-bases every `call funcIdx >=
    // base`), landing on the wrong function — the encoder then patches the stack
    // with `extern.convert_any; …; drop`, which the GC validator accepts but
    // wasm-opt rejects ("popping from empty stack", surfaced as the
    // native-messaging-smoke CI failure). Rather than fight the cross-regime
    // index shift, the string arm falls back to `eq`-heap ref identity here:
    // VALID Wasm, correct for interned/same-ref strings. String-element `any[]`
    // search-by-VALUE is a tracked #2508 follow-up that belongs in a
    // `__any_str_value_eq` helper registered in the native-string regime.
    const stringOrIdentityArm: Instr[] = refIdentityArm;
    // Materialise the anyref temps (locals 2/3) once, then dispatch string/ref.
    const identityArm: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 2 },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 3 },
      ...stringOrIdentityArm,
    ];
    const bigintArm = (elseArm: Instr[]): Instr[] => [
      ...bothTag(typeofBigIdx),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: toBigIdx } as Instr,
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: toBigIdx } as Instr,
          { op: "i64.eq" },
        ],
        else: elseArm,
      } as Instr,
    ];
    const boolArm = (elseArm: Instr[]): Instr[] => [
      ...bothTag(typeofBoolIdx),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: unboxBoolIdx } as Instr,
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: unboxBoolIdx } as Instr,
          { op: "i32.eq" },
        ],
        else: elseArm,
      } as Instr,
    ];
    // numberArm: sameValueZero=true adds a NaN==NaN recovery (a!=a && b!=b).
    const numberArm = (sameValueZero: boolean, elseArm: Instr[]): Instr[] => {
      const cmp: Instr[] = [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: unboxNumIdx } as Instr,
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: unboxNumIdx } as Instr,
      ];
      if (!sameValueZero) {
        cmp.push({ op: "f64.eq" });
      } else {
        // (la == ra) || (la != la && ra != ra)   [NaN === NaN under SVZ]
        // Stack has la, ra. Tee both into anyref-free f64 temps via locals 4/5.
        cmp.length = 0;
        cmp.push(
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: unboxNumIdx } as Instr,
          { op: "local.set", index: 4 } as Instr,
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: unboxNumIdx } as Instr,
          { op: "local.set", index: 5 } as Instr,
          // la == ra
          { op: "local.get", index: 4 } as Instr,
          { op: "local.get", index: 5 } as Instr,
          { op: "f64.eq" },
          // || (la!=la && ra!=ra)
          { op: "local.get", index: 4 } as Instr,
          { op: "local.get", index: 4 } as Instr,
          { op: "f64.ne" },
          { op: "local.get", index: 5 } as Instr,
          { op: "local.get", index: 5 } as Instr,
          { op: "f64.ne" },
          { op: "i32.and" },
          { op: "i32.or" },
        );
      }
      return [
        ...bothTag(typeofNumIdx),
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: cmp,
          else: elseArm,
        } as Instr,
      ];
    };

    // __host_eq: Strict Equality. null === null (both ref.null extern) → the
    // identity arm's ref.test EQ fails for null (ref.null isn't an eq ref), so
    // handle the both-null case up front: ref.is_null l && ref.is_null r → 1.
    const nullArm = (rest: Instr[]): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      { op: "local.get", index: 1 },
      { op: "ref.is_null" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 1 }],
        else: rest,
      } as Instr,
    ];

    const eqLocals = [
      { name: "la", type: { kind: "anyref" } as ValType },
      { name: "ra", type: { kind: "anyref" } as ValType },
      { name: "fa", type: { kind: "f64" } as ValType },
      { name: "fb", type: { kind: "f64" } as ValType },
    ];

    registerNative("__host_eq", externref2ToI32, nullArm(numberArm(false, boolArm(bigintArm(identityArm)))), eqLocals);
    registerNative(
      "__same_value_zero",
      externref2ToI32,
      nullArm(numberArm(true, boolArm(bigintArm(identityArm)))),
      eqLocals,
    );
  }
}

/**
 * Scan source for for...of on non-array types (strings, externref iterables)
 * and register the host-delegated iterator protocol imports.
 */
function collectIteratorImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  let found = false;

  function visit(node: ts.Node) {
    if (found) return;
    if (ts.isForOfStatement(node)) {
      const exprType = ctx.checker.getTypeAtLocation(node.expression);
      // Array types use the existing index-based loop — no iterator imports needed
      const sym = (exprType as ts.TypeReference).symbol ?? (exprType as ts.Type).symbol;
      if (sym?.name !== "Array") {
        // In fast mode, strings are iterated natively — no iterator imports needed
        if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && isStringType(exprType)) {
          return;
        }
        found = true;
        return;
      }
    }
    forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    if (found) break;
    if (ts.isFunctionDeclaration(stmt) && stmt.body) {
      visit(stmt.body);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (decl.initializer) visit(decl.initializer);
      }
    } else if (ts.isClassDeclaration(stmt)) {
      for (const member of stmt.members) {
        if (found) break;
        if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && member.body) {
          visit(member.body);
        }
      }
    } else if (ts.isExpressionStatement(stmt)) {
      visit(stmt.expression);
    } else if (ts.isForOfStatement(stmt)) {
      visit(stmt);
    }
  }

  if (found) {
    // #1320 Slice 1: standalone/WASI binds the four iterator ops to emitted
    // Wasm fns (no JS host); JS-host mode keeps the env imports.
    if (ctx.standalone || ctx.wasi) {
      ensureNativeIteratorRuntime(ctx);
    } else {
      addIteratorImports(ctx);
    }
  }
}

/** Register the iterator protocol host imports if not already registered */
export function addIteratorImports(ctx: CodegenContext): void {
  // Guard: only register once
  if (ctx.funcMap.has("__iterator")) return;

  // (#2689) Add via the late-import batch (`ensureLateImport`) + an IMMEDIATE
  // `flushLateImportShifts`. This helper has TWO call contexts: the EARLY
  // collect-finalize (declarations.ts, before any function is registered) and
  // the LATE lazy fallback (compileForOfStatement, after functions already
  // baked `call`/`return_call` funcIdx values). Raw `addImport` bumps
  // `numImportFuncs` WITHOUT shifting already-baked defined-function indices, so
  // the LATE context silently desynced every earlier function's funcIdx — the
  // ESLint `SourceCode_new` tail call ended up pointing at `__iterator_next`
  // ("return_call: tail call type error"). The flushed batch shift fixes the
  // late context AND is a clean no-op early (no functions to shift, and the
  // immediate flush leaves NO lingering pending shift that would later
  // over-shift functions registered after these imports).
  const ER: ValType = { kind: "externref" };
  // __iterator: (externref) → externref — calls obj[Symbol.iterator]()
  ensureLateImport(ctx, "__iterator", [ER], [ER]);
  // __iterator_next: (externref) → (i32 done, externref value) — calls iter.next()
  // Multi-value result avoids the $IteratorResult struct: a freshly-built WasmGC
  // struct cannot survive the JS import hop (it surfaces as undefined in V8/Node;
  // see #1620 BLOCKED). The two primitives (i32 + externref) cross the JS↔Wasm
  // multi-value ABI cleanly, eliminating __iterator_done / __iterator_value.
  ensureLateImport(ctx, "__iterator_next", [ER], [{ kind: "i32" }, ER]);
  // __iterator_return: (externref) → void — calls iter.return() if it exists
  ensureLateImport(ctx, "__iterator_return", [ER], []);
  // __iterator_rest: (externref) → externref — drains a partially-consumed
  // iterator into a real JS Array for the `[...rest]` binding pattern (#1052).
  ensureLateImport(ctx, "__iterator_rest", [ER], [ER]);
  // Apply the batch's index shift NOW so a late call repairs already-baked
  // funcIdx immediately and no deferred shift lingers (the #2689 fix).
  flushLateImportShifts(ctx, ctx.currentFunc);
}

/** Register array iterator host imports (entries/keys/values) if not already registered */
export function addArrayIteratorImports(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__array_entries")) return;

  // (#2689) Batch + immediate flush — see addIteratorImports for the rationale.
  // Lazily called during body compilation (array-methods.ts), raw addImport
  // would desync already-baked defined-function funcIdx values.
  const ER: ValType = { kind: "externref" };
  // All three: (externref) → externref — take a vec struct, return a JS iterator
  ensureLateImport(ctx, "__array_entries", [ER], [ER]);
  ensureLateImport(ctx, "__array_keys", [ER], [ER]);
  ensureLateImport(ctx, "__array_values", [ER], [ER]);
  flushLateImportShifts(ctx, ctx.currentFunc);
}

/**
 * Register the generator host imports if not already registered.
 *
 * The legacy generator codegen (eager-buffer model) uses these imports to
 * push yielded values into a JS array on the host side, then wrap that
 * buffer with `__create_generator` (or `__create_async_generator`) to
 * produce a Generator-like / AsyncGenerator-like object. The IR path
 * (slice 7 — #1169f) reuses the same set of imports — extracting this
 * registration out of `declarations.ts:1014-1062` into a standalone
 * exported helper so both legacy and IR can call it without duplicating
 * the import-shape declarations.
 *
 * Imports registered (all under `env`):
 *   - `__gen_create_buffer`   () → externref
 *   - `__gen_push_f64`        (externref, f64) → ()
 *   - `__gen_push_i32`        (externref, i32) → ()
 *   - `__gen_push_ref`        (externref, externref) → ()
 *   - `__gen_yield_star`      (externref, externref) → ()  (same shape as push_ref)
 *   - `__create_generator`    (externref, externref) → externref  (buf, pendingThrow)
 *   - `__create_async_generator` (externref, externref) → externref  (same shape)
 *   - `__gen_next`            (externref) → externref
 *   - `__gen_return`          (externref, externref) → externref
 *   - `__gen_throw`           (externref, externref) → externref
 *   - `__gen_result_value`    (externref) → externref
 *   - `__gen_result_value_f64` (externref) → f64
 *   - `__gen_result_done`     (externref) → i32
 *   - `__get_caught_exception` () → externref  (for the body's try/catch wrapper)
 */
export function addGeneratorImports(ctx: CodegenContext, options?: { allowNoJsHost?: boolean }): void {
  if ((ctx.standalone || ctx.wasi) && !options?.allowNoJsHost) return;
  // Guard: only register once
  if (ctx.funcMap.has("__gen_create_buffer")) return;

  // (#2689) Batch + immediate flush — see addIteratorImports for the rationale.
  // Can be registered lazily (IR-path generator claim / body compilation) after
  // other functions baked their funcIdx; raw addImport would desync them. The
  // `__gen_*` / `__create_*` / `__get_caught_exception` names are not in any
  // standalone-refusal / native-helper set, so the `allowNoJsHost` fallback
  // behaves exactly as the previous raw additions did.
  const ER: ValType = { kind: "externref" };
  ensureLateImport(ctx, "__gen_create_buffer", [], [ER]);
  ensureLateImport(ctx, "__gen_push_f64", [ER, { kind: "f64" }], []);
  ensureLateImport(ctx, "__gen_push_i32", [ER, { kind: "i32" }], []);
  ensureLateImport(ctx, "__gen_push_ref", [ER, ER], []);
  // __gen_yield_star: (externref, externref) → void  (iterates inner iterable, pushes all values into outer buffer)
  ensureLateImport(ctx, "__gen_yield_star", [ER, ER], []);
  // __gen_set_return: (externref, externref) → void  (#2035 — stashes the
  // generator's `return` value on the buffer instead of pushing it as a yield)
  ensureLateImport(ctx, "__gen_set_return", [ER, ER], []);
  // __create_generator: (buf: externref, pendingThrow: externref) -> externref
  // Takes a buffer of yielded values and an optional pending exception,
  // returns a Generator-like object that defers the throw to the first next() call.
  ensureLateImport(ctx, "__create_generator", [ER, ER], [ER]);
  // __create_async_generator: same Wasm signature as __create_generator, but .next()/.return()/.throw()
  // return Promise-wrapped results as required by the ES spec for async generators.
  ensureLateImport(ctx, "__create_async_generator", [ER, ER], [ER]);
  ensureLateImport(ctx, "__gen_next", [ER], [ER]);
  ensureLateImport(ctx, "__gen_return", [ER, ER], [ER]);
  ensureLateImport(ctx, "__gen_throw", [ER, ER], [ER]);
  ensureLateImport(ctx, "__gen_result_value", [ER], [ER]);
  ensureLateImport(ctx, "__gen_result_value_f64", [ER], [{ kind: "f64" }]);
  ensureLateImport(ctx, "__gen_result_done", [ER], [{ kind: "i32" }]);
  // Ensure __get_caught_exception is available for generator body try/catch wrappers
  ensureLateImport(ctx, "__get_caught_exception", [], [ER]);
  flushLateImportShifts(ctx, ctx.currentFunc);
}

/** Register for-in key enumeration host imports if not already registered */
export function addForInImports(ctx: CodegenContext): void {
  // Guard: only register once
  if (ctx.funcMap.has("__for_in_keys")) return;

  // (#2689) Batch + immediate flush — see addIteratorImports for the rationale.
  // Only registered in JS-host mode (caller-guarded `!standalone && !wasi`), so
  // the standalone `__for_in_*` refusal inside ensureLateImport never triggers
  // here. Raw addImport on this lazy path would desync already-baked funcIdx.
  const ER: ValType = { kind: "externref" };
  // __for_in_keys: (externref) -> externref — returns JS array of enumerable string keys
  ensureLateImport(ctx, "__for_in_keys", [ER], [ER]);
  // __for_in_len: (externref) -> i32 — returns keys.length
  ensureLateImport(ctx, "__for_in_len", [ER], [{ kind: "i32" }]);
  // __for_in_get: (externref, i32) -> externref — returns keys[i]
  ensureLateImport(ctx, "__for_in_get", [ER, { kind: "i32" }], [ER]);
  // __for_in_has: (externref obj, externref key) -> i32 — per-visit liveness
  // check so a property deleted mid-enumeration is skipped (#2066).
  ensureLateImport(ctx, "__for_in_has", [ER, ER], [{ kind: "i32" }]);
  flushLateImportShifts(ctx, ctx.currentFunc);
}

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
        // (#2905) Under the native `$Promise` carrier (isStandalonePromiseActive
        // — today WASI, widened to standalone by #2895 slice 1d) a STORED/TYPED
        // `Promise<T>` is a real `$Promise` externref (produced by wrapAsyncReturn
        // at the call site / the drive-layer result), NOT the unwrapped `T`.
        // Lower the value slot to externref so it matches the value end-to-end;
        // storing the externref into an f64/struct slot would otherwise coerce
        // `externref → f64` via __unbox_number = NaN (or an illegal struct cast).
        //
        // GC/host stays byte-identical: the unwrap-to-T contract only held
        // because async fns are compiled synchronously, which is exactly when the
        // carrier is OFF. An async fn's OWN wasm return signature pre-unwraps via
        // unwrapPromiseType (function-body.ts / declarations.ts), so this branch
        // is only hit for *value* slots (bindings / params / fields / non-async
        // returns), never an async fn's own result type. externref is a leaf
        // valtype — registers no new type, so no DCE remap / funcIdx churn.
        if (isStandalonePromiseActive(ctx)) return { kind: "externref" };
        return resolveWasmType(ctx, inner, _depth + 1, _visited);
      }
      return { kind: "externref" }; // bare Promise without type arg
    }

    // TypedArray types → vec struct. Native Uint8Array uses packed-byte
    // storage; other typed arrays keep the legacy f64 representation.
    // Covers: Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array,
    //         Int32Array, Uint32Array, Float32Array, Float64Array
    if (sym?.name && TYPED_ARRAY_NAMES.has(sym.name)) {
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
    const methodFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.funcMap.set(methodKey, methodFuncIdx); // (#1983) relocated key

    const methodFunc: WasmFunction = {
      name: methodKey, // (#1983) display name matches relocated funcMap key for body-fill
      typeIdx: methodTypeIdx,
      locals: [],
      body: [],
      exported: false,
    };
    ctx.mod.functions.push(methodFunc);
  }
}

// ── Built-in extern class registration ───────────────────────────────

/** Helper to create an extern method signature with externref params and results */
function externMethod(
  paramCount: number,
  returnsExternref = true,
): { params: ValType[]; results: ValType[]; requiredParams: number } {
  const params: ValType[] = [];
  for (let i = 0; i <= paramCount; i++) params.push({ kind: "externref" }); // self + args
  return {
    params,
    results: returnsExternref ? [{ kind: "externref" }] : [],
    requiredParams: params.length,
  };
}

/**
 * Register built-in collection types (Set, Map, WeakMap, WeakSet) as extern classes
 * if they weren't already collected from lib .d.ts files. This ensures these types
 * are available for extern class method dispatch even when lib file scanning fails
 * (e.g., bundled/browser environments where readLibFile returns empty strings).
 */
export function registerBuiltinExternClasses(ctx: CodegenContext): void {
  // Set methods — all take (self: externref, ...args: externref) → externref.
  // (#2162) In standalone / nativeStrings mode `Set` is served by the
  // WasmGC-native runtime (src/codegen/set-runtime.ts, reusing the Map backing
  // store), intercepted at the new-expression / method-call / .size sites.
  // Registering it as an externClass here would eagerly emit a `Set_new` host
  // import the standalone module can't satisfy, so skip it in that mode (mirrors
  // the Map gating below). JS-host mode keeps the externClass path unchanged.
  if (!ctx.externClasses.has("Set") && !ctx.nativeStrings) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    // ES2015 methods
    methods.set("add", externMethod(1)); // add(value) → Set
    methods.set("has", externMethod(1)); // has(value) → boolean (externref)
    methods.set("delete", externMethod(1)); // delete(value) → boolean (externref)
    methods.set("clear", externMethod(0, false)); // clear() → void
    methods.set("forEach", externMethod(1)); // forEach(callback) → void (externref for simplicity)
    methods.set("entries", externMethod(0)); // entries() → Iterator
    methods.set("keys", externMethod(0)); // keys() → Iterator
    methods.set("values", externMethod(0)); // values() → Iterator
    // ES2025 Set methods
    methods.set("union", externMethod(1)); // union(other) → Set
    methods.set("intersection", externMethod(1)); // intersection(other) → Set
    methods.set("difference", externMethod(1)); // difference(other) → Set
    methods.set("symmetricDifference", externMethod(1)); // symmetricDifference(other) → Set
    methods.set("isSubsetOf", externMethod(1)); // isSubsetOf(other) → boolean (externref)
    methods.set("isSupersetOf", externMethod(1)); // isSupersetOf(other) → boolean (externref)
    methods.set("isDisjointFrom", externMethod(1)); // isDisjointFrom(other) → boolean (externref)

    ctx.externClasses.set("Set", {
      importPrefix: "Set",
      namespacePath: [],
      className: "Set",
      constructorParams: [{ kind: "externref" }], // new Set(iterable?)
      methods,
      properties: new Map([["size", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  // Map methods.
  // (#1103a) In standalone / nativeStrings mode, `Map` is served by the
  // WasmGC-native runtime (src/codegen/map-runtime.ts), intercepted at the
  // new-expression / method-call / .size sites. Registering it as an
  // externClass here would eagerly emit a `Map_new` host import the standalone
  // module can't satisfy, so skip registration in that mode. JS-host mode keeps
  // the externClass path unchanged. (Slice 1 covers number/string keys with
  // new/get/set/has/delete/clear/size; forEach / iteration / new Map(iterable)
  // are slice 2 — those fall through and currently have no standalone path.)
  if (!ctx.externClasses.has("Map") && !ctx.nativeStrings) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("get", externMethod(1));
    methods.set("set", externMethod(2));
    methods.set("has", externMethod(1));
    methods.set("delete", externMethod(1));
    methods.set("clear", externMethod(0, false));
    methods.set("forEach", externMethod(1));
    methods.set("entries", externMethod(0));
    methods.set("keys", externMethod(0));
    methods.set("values", externMethod(0));
    // (#837) TC39 Stage 3 "upsert" proposal: Map.prototype.getOrInsert /
    // .getOrInsertComputed. Both take (key, value|callback) and return the
    // existing or newly-inserted value as externref.
    methods.set("getOrInsert", externMethod(2));
    methods.set("getOrInsertComputed", externMethod(2));

    ctx.externClasses.set("Map", {
      importPrefix: "Map",
      namespacePath: [],
      className: "Map",
      constructorParams: [{ kind: "externref" }],
      methods,
      properties: new Map([["size", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  // WeakMap methods.
  // (#2162) Skip under nativeStrings — the native weak-collection runtime
  // (weak-collections-runtime.ts, reusing the Map backing store) serves it, so
  // registering the externClass would leak a `WeakMap_new` host import.
  if (!ctx.externClasses.has("WeakMap") && !ctx.nativeStrings) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("get", externMethod(1));
    methods.set("set", externMethod(2));
    methods.set("has", externMethod(1));
    methods.set("delete", externMethod(1));
    // (#837) TC39 Stage 3 "upsert" proposal: WeakMap.prototype.getOrInsert /
    // .getOrInsertComputed. Mirrors Map's signatures.
    methods.set("getOrInsert", externMethod(2));
    methods.set("getOrInsertComputed", externMethod(2));

    ctx.externClasses.set("WeakMap", {
      importPrefix: "WeakMap",
      namespacePath: [],
      className: "WeakMap",
      constructorParams: [{ kind: "externref" }],
      methods,
      properties: new Map(),
    });
  }

  // WeakSet methods.
  // (#2162) Skip under nativeStrings — served by the native weak-collection
  // runtime; registering the externClass would leak a `WeakSet_new` host import.
  if (!ctx.externClasses.has("WeakSet") && !ctx.nativeStrings) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("add", externMethod(1));
    methods.set("has", externMethod(1));
    methods.set("delete", externMethod(1));

    ctx.externClasses.set("WeakSet", {
      importPrefix: "WeakSet",
      namespacePath: [],
      className: "WeakSet",
      constructorParams: [{ kind: "externref" }],
      methods,
      properties: new Map(),
    });
  }

  // FinalizationRegistry (#1600) — host-delegate in JS mode, no-op stub in
  // standalone. The spec never guarantees cleanup callbacks run, so a registry
  // that tracks register/unregister but never fires the callback is fully
  // conformant. The host import builds a real engine FinalizationRegistry;
  // register/unregister forward to it.
  if (!ctx.externClasses.has("FinalizationRegistry")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    // register(target, heldValue, unregisterToken?) → undefined
    methods.set("register", {
      params: [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      results: [{ kind: "externref" }],
      requiredParams: 2,
    });
    // unregister(token) → boolean (externref)
    methods.set("unregister", externMethod(1));

    ctx.externClasses.set("FinalizationRegistry", {
      importPrefix: "FinalizationRegistry",
      namespacePath: [],
      className: "FinalizationRegistry",
      constructorParams: [{ kind: "externref" }], // new FinalizationRegistry(cleanupCallback)
      methods,
      properties: new Map(),
    });
  }

  // DisposableStack / AsyncDisposableStack — TC39 Explicit Resource Management (#830)
  if (!ctx.externClasses.has("DisposableStack")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("dispose", externMethod(0, false)); // dispose() → void
    methods.set("use", externMethod(1)); // use(value) → value
    methods.set("adopt", externMethod(2)); // adopt(value, onDispose) → value
    methods.set("defer", externMethod(1, false)); // defer(onDispose) → void
    methods.set("move", externMethod(0)); // move() → DisposableStack

    ctx.externClasses.set("DisposableStack", {
      importPrefix: "DisposableStack",
      namespacePath: [],
      className: "DisposableStack",
      constructorParams: [], // new DisposableStack()
      methods,
      properties: new Map([["disposed", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  if (!ctx.externClasses.has("AsyncDisposableStack")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("disposeAsync", externMethod(0)); // disposeAsync() → Promise
    methods.set("use", externMethod(1));
    methods.set("adopt", externMethod(2));
    methods.set("defer", externMethod(1, false));
    methods.set("move", externMethod(0));

    ctx.externClasses.set("AsyncDisposableStack", {
      importPrefix: "AsyncDisposableStack",
      namespacePath: [],
      className: "AsyncDisposableStack",
      constructorParams: [],
      methods,
      properties: new Map([["disposed", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  if (!ctx.externClasses.has("SuppressedError")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    ctx.externClasses.set("SuppressedError", {
      importPrefix: "SuppressedError",
      namespacePath: [],
      className: "SuppressedError",
      constructorParams: [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      methods,
      properties: new Map([
        ["error", { type: { kind: "externref" }, readonly: false }],
        ["suppressed", { type: { kind: "externref" }, readonly: false }],
        ["message", { type: { kind: "externref" }, readonly: false }],
      ]),
    });
  }

  // Register Object as base extern class with prototype methods (#799 WI2).
  // All extern classes that lack a parent inherit from Object, so
  // findExternInfoForMember will resolve hasOwnProperty, toString, etc.
  if (!ctx.externClasses.has("Object")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("hasOwnProperty", externMethod(1));
    methods.set("isPrototypeOf", externMethod(1));
    methods.set("propertyIsEnumerable", externMethod(1));
    methods.set("toString", externMethod(0));
    methods.set("valueOf", externMethod(0));
    methods.set("toLocaleString", externMethod(0));
    ctx.externClasses.set("Object", {
      importPrefix: "Object",
      namespacePath: [],
      className: "Object",
      constructorParams: [],
      methods,
      properties: new Map([["constructor", { type: { kind: "externref" }, readonly: true }]]),
    });
  }

  // Intl.ListFormat — extern class for internationalized list formatting
  if (!ctx.externClasses.has("ListFormat")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("format", externMethod(1)); // format(list) → string (externref)
    methods.set("formatToParts", externMethod(1)); // formatToParts(list) → array (externref)
    methods.set("resolvedOptions", externMethod(0)); // resolvedOptions() → object (externref)
    ctx.externClasses.set("ListFormat", {
      importPrefix: "Intl_ListFormat",
      namespacePath: ["Intl"],
      className: "ListFormat",
      constructorParams: [{ kind: "externref" }, { kind: "externref" }], // locale?, options?
      methods,
      properties: new Map(),
    });
  }

  // Intl.NumberFormat — extern class for internationalized number formatting
  if (!ctx.externClasses.has("NumberFormat")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    methods.set("format", externMethod(1)); // format(n) → string (externref)
    methods.set("formatToParts", externMethod(1)); // formatToParts(n) → array (externref)
    methods.set("resolvedOptions", externMethod(0)); // resolvedOptions() → object (externref)
    ctx.externClasses.set("NumberFormat", {
      importPrefix: "Intl_NumberFormat",
      namespacePath: ["Intl"],
      className: "NumberFormat",
      constructorParams: [{ kind: "externref" }, { kind: "externref" }], // locale?, options?
      methods,
      properties: new Map(),
    });
  }

  // #1238 — synthetic ExternClassInfo for String and Array.
  //
  // String and Array are JS built-ins, not declared classes (`declare class
  // String { ... }` doesn't appear in user source — they're skipped by
  // `BUILTIN_SKIP` in `collectExternFromDeclareVar`). To let the IR's
  // `lowerMethodCall` / `lowerPropertyAccess` dispatch through the existing
  // extern-class registry path (instead of growing more hardcoded special
  // cases), we register pseudo-`ExternClassInfo` entries here. The
  // method/property metadata mirrors the legacy `STRING_METHODS` table
  // (`src/codegen/index.ts:3058`) and the array prototype-method dispatch
  // in `src/codegen/array-methods.ts`.
  //
  // **Why a separate `pseudoExternClasses` map?**
  // Putting String/Array directly into `ctx.externClasses` broke `new
  // Array(...)` / `new String(...)` because:
  //   - `collectUsedExternImports` (line ~6297) registers `${prefix}_new`
  //     for any `new ClassName()` whose className is in `ctx.externClasses`.
  //     With "Array" in the map, `new Array(10)` registered an `array_new`
  //     host import.
  //   - `compileNewExpression` (in `src/codegen/expressions/new-super.ts`,
  //     ~line 2193) dispatches via the externInfo branch BEFORE the inline
  //     `if (className === "Array")` vec-creation special case. So `new
  //     Array(10)` emitted `call $array_new` instead of the inline vec.
  //   - At runtime, `runtime.ts` couldn't find an `Array` constructor in
  //     its `builtinCtors` map (Number/String/Map/Set/RegExp/... but no
  //     Array — Array is a TypedArray-style built-in), throwing "No
  //     dependency provided for extern class 'Array'".
  // PR#149 caught this in CI as 152 wasm_compile regressions. Splitting
  // pseudo entries into a separate map keeps `ctx.externClasses` shaped
  // exactly as before — every existing consumer is unchanged. The pseudo
  // map is queried only by the new IR-side `resolveMethodDispatchTarget`
  // helper, which downstream slices (#1232, #1233) will route through.
  //
  // **MLIR seam alignment** (per #1231 Phase 2 design note): the registry
  // itself is a static table (this function is the entry point — no IR
  // node mutations, no ambient maps). Only the lookup will be TypeMap-
  // keyed when 1232/1233 wire it up via `resolveMethodDispatchTarget`.
  if (!ctx.pseudoExternClasses.has("String")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    // Mirror STRING_METHODS in src/codegen/index.ts:3058. The extern-class
    // method-signature shape is `[receiver, ...args] -> [result]`, so we
    // prepend an externref self-param to each signature. We restrict to
    // the methods listed in the #1238 spec (slice/charAt/charCodeAt/
    // indexOf/includes/toUpperCase/toLowerCase/trim) plus `length` as a
    // property — additional STRING_METHODS entries can be added as the
    // dispatch routing in #1232 covers them.
    const SELF: ValType = { kind: "externref" };
    const methodEntry = (
      params: readonly ValType[],
      result: ValType,
    ): {
      params: ValType[];
      results: ValType[];
      requiredParams: number;
    } => ({
      params: [SELF, ...params],
      results: [result],
      requiredParams: 1 + params.length,
    });
    methods.set("slice", methodEntry([{ kind: "f64" }, { kind: "f64" }], { kind: "externref" }));
    methods.set("charAt", methodEntry([{ kind: "f64" }], { kind: "externref" }));
    methods.set("charCodeAt", methodEntry([{ kind: "f64" }], { kind: "f64" }));
    methods.set("indexOf", methodEntry([{ kind: "externref" }, { kind: "externref" }], { kind: "f64" }));
    methods.set("includes", methodEntry([{ kind: "externref" }], { kind: "i32" }));
    methods.set("toUpperCase", methodEntry([], { kind: "externref" }));
    methods.set("toLowerCase", methodEntry([], { kind: "externref" }));
    methods.set("trim", methodEntry([], { kind: "externref" }));

    // String.length is f64-typed in JS engine semantics (Number, not
    // i32). Read-only — `(str).length = N` is a no-op in JS, but we
    // mark `readonly: true` so any future write attempts cleanly fall
    // back to legacy.
    const properties = new Map<string, { type: ValType; readonly: boolean }>();
    properties.set("length", { type: { kind: "f64" }, readonly: true });

    ctx.pseudoExternClasses.set("String", {
      importPrefix: "string", // matches the legacy `string_<method>` host imports
      namespacePath: [],
      className: "String",
      constructorParams: [{ kind: "externref" }], // new String(value) — accepts any
      methods,
      properties,
    });
  }

  if (!ctx.pseudoExternClasses.has("Array")) {
    const methods = new Map<string, { params: ValType[]; results: ValType[]; requiredParams: number }>();
    // Array methods are parametric in the element type — the registry
    // here uses externref for value-shaped receivers and args, which is
    // correct for the JS-host fast path. The vec-specialised lowerings
    // (#1233) will inspect the actual vec element type at dispatch time
    // and route to the typed `vec.*` ops; this entry is the fallback
    // metadata the IR uses to recognise the method exists.
    const SELF: ValType = { kind: "externref" };
    const methodEntry = (
      params: readonly ValType[],
      result: ValType | null,
    ): { params: ValType[]; results: ValType[]; requiredParams: number } => ({
      params: [SELF, ...params],
      results: result === null ? [] : [result],
      requiredParams: 1 + params.length,
    });
    methods.set("push", methodEntry([{ kind: "externref" }], { kind: "f64" })); // returns new length
    methods.set("pop", methodEntry([], { kind: "externref" }));
    methods.set("indexOf", methodEntry([{ kind: "externref" }, { kind: "externref" }], { kind: "f64" }));
    methods.set("includes", methodEntry([{ kind: "externref" }], { kind: "i32" }));
    methods.set("slice", methodEntry([{ kind: "f64" }, { kind: "f64" }], { kind: "externref" }));
    methods.set("join", methodEntry([{ kind: "externref" }], { kind: "externref" }));
    // #1233 — concat: returns a new array. The fallback signature uses
    // externref for both the variadic items and the result; the IR's
    // existing dispatch falls through to the legacy `compileArrayConcat`
    // when needed, which handles the per-element-type splatting.
    methods.set("concat", methodEntry([{ kind: "externref" }], { kind: "externref" }));

    // Array.length — like String.length, f64-typed in JS engine
    // semantics. **Not** readonly (JS allows `arr.length = 0` to truncate),
    // but #1238 marks it read-only for now; the writable arm is a future
    // enhancement covered by #1233 if needed.
    const properties = new Map<string, { type: ValType; readonly: boolean }>();
    properties.set("length", { type: { kind: "f64" }, readonly: true });

    ctx.pseudoExternClasses.set("Array", {
      importPrefix: "array",
      namespacePath: [],
      className: "Array",
      constructorParams: [{ kind: "f64" }], // new Array(length)
      methods,
      properties,
    });
  }

  // Set Object as terminal parent for any extern class that has no parent
  for (const [className] of ctx.externClasses) {
    if (className !== "Object" && !ctx.externClassParent.has(className)) {
      ctx.externClassParent.set(className, "Object");
    }
  }
}

/**
 * #1238 — Look up a pseudo-extern-class entry by className. Returns
 * `undefined` when the className isn't registered as a pseudo-extern
 * class (i.e., it's either a real extern class — query
 * `ctx.externClasses` for those — or unknown).
 *
 * This is the canonical accessor for the synthetic String/Array
 * registry. Existing consumers of `ctx.externClasses` are intentionally
 * NOT updated to consult this map: the legacy `new ClassName()` /
 * extern-method dispatch paths must keep their existing behaviour for
 * String / Array (they're handled via inline special cases or
 * `__new_<name>` / `string_<method>` lowercase imports). The pseudo
 * registry is the IR-only seam, queried by #1232 (String dispatch) and
 * #1233 (Array dispatch).
 */
export function getPseudoExternClassInfo(ctx: CodegenContext, className: string): ExternClassInfo | undefined {
  return ctx.pseudoExternClasses.get(className);
}

/**
 * #1238 — TypeMap-keyed receiver-type → extern className lookup. Given an
 * `IrType` resolved from the propagator's `TypeMap`, return the className
 * of the matching synthetic extern class (or `null` if no match).
 *
 * This is the **MLIR-seam-friendly** dispatch helper: callers route
 * receiver IrTypes here instead of pattern-matching `atom.kind ===
 * "string"` inline. A future MLIR optimizer producing the same `IrType`
 * shape would hit the same lookup, unchanged.
 *
 * Returns:
 *   - `"String"` for `IrType.string` and `IrType.val<externref>`
 *     (the externref arm covers post-#1169i extern-tagged strings)
 *   - `"Array"` for `IrType.val<ref|ref_null>` whose typeIdx points at
 *     a registered vec type (callers must check via their vec resolver)
 *   - `null` for anything else (including primitives, classes, objects)
 *
 * Note: the array path is only metadata. Confirming the receiver IS a
 * vec (vs. a generic ref) requires the lowerer's vec resolver — this
 * helper just identifies the target className so the lowerer can pick
 * which extern entry to consult. Callers should pair this with
 * `getPseudoExternClassInfo(ctx, target)` to get the method metadata.
 */
export function resolveMethodDispatchTarget(t: import("../ir/nodes.js").IrType): "String" | "Array" | null {
  if (t.kind === "string") return "String";
  if (t.kind === "val") {
    const v = t.val;
    if (v.kind === "ref" || v.kind === "ref_null") {
      // Caller verifies via vec resolver — we just signal the candidate.
      return "Array";
    }
  }
  return null;
}

// ── Extern class collection ──────────────────────────────────────────

// #2520 — collect names that actually RESOLVE to an ambient (lib-declared)
// global in the given user source. Symbol resolution distinguishes a real
// reference to a global (e.g. `setTimeout(...)`) from a local variable or a
// property that merely shares the name — e.g. a local `let stop = …` must NOT
// pull in the DOM `window.stop` global, and `obj.close` must NOT pull in
// `close`. Used to gate the lib-file ambient-`declare function` scan so only
// genuinely-referenced globals register as host imports.
function collectReferencedGlobalNames(userFiles: readonly ts.SourceFile[], checker: ts.TypeChecker): Set<string> {
  const isLibFile = (sf: ts.SourceFile): boolean => {
    const bn = sf.fileName.split("/").pop() ?? sf.fileName;
    return bn.startsWith("lib.") && bn.endsWith(".d.ts");
  };
  // A genuine global reference resolves to an AMBIENT declaration: a lib
  // `declare function`, OR a `declare function` stub preprocessImports injects
  // into the user file (so `setTimeout` resolves to a user-file stub, not the
  // lib). A local `let stop` resolves to a plain VariableDeclaration → excluded,
  // so it can't pull in the same-named DOM global.
  const isAmbientGlobalDecl = (d: ts.Declaration): boolean =>
    isLibFile(d.getSourceFile()) || (ts.isFunctionDeclaration(d) && hasDeclareModifier(d) && !d.body);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const decls = checker.getSymbolAtLocation(node)?.getDeclarations();
      if (decls && decls.some(isAmbientGlobalDecl)) {
        names.add(node.text);
      }
    }
    forEachChild(node, visit);
  };
  for (const sf of userFiles) {
    for (const stmt of sf.statements) forEachChild(stmt, visit);
  }
  return names;
}

// #2696/#2632 — the fd0 stdin-reactor intrinsic names. The injected
// process.stdin Readable prelude declares these as `declare function` stubs;
// under `--target wasi` every call site is inline-lowered to poll_oneoff/fd_read
// (tryWasiTimerCall), so collectExternDeclarations must NOT re-register them as
// `env.*` host imports (which would only be dropped with a spurious warning).
const WASI_STDIN_REACTOR_INTRINSICS = new Set([
  "__wasiStdinReadByte",
  "__wasiStdinAvailable",
  "__wasiStdinEof",
  "__wasiStdinSetReader",
  // #2817 — `__wasiStdinStop` (added in #2735 for a NON-EOF reactor exit: it
  // drops the fd0 subscription so the run loop terminates on in-band shutdown /
  // `process.stdin.destroy()` / pre-`proc_exit`). Its every call site is
  // inline-lowered by `emitStdinStop` (async-scheduler.ts) via tryWasiTimerCall
  // — a native `global.set` clearing `__stdin_fd_active`, NO host import. The
  // sibling intrinsics above were already skipped; #2735 forgot to add this one,
  // so its prelude `declare function __wasiStdinStop` stub re-registered here as
  // a DEAD `env.__wasiStdinStop` host import (dropped from the binary, but
  // firing the spurious "not on the dual-mode allowlist" warning on the
  // otherwise-runnable standalone nm_js2wasm_node_process.ts build). Skip it.
  "__wasiStdinStop",
]);

// `libReferencedNames`, when provided (lib-file scan only), gates ambient
// `declare function` host-import registration to names the user references
// (#2520). User-file call sites omit it so preprocessImports stubs always
// register.
function collectExternDeclarations(
  ctx: CodegenContext,
  sourceFile: ts.SourceFile,
  libReferencedNames?: Set<string>,
): void {
  for (const stmt of sourceFile.statements) {
    if (ts.isModuleDeclaration(stmt) && hasDeclareModifier(stmt)) {
      collectDeclareNamespace(ctx, stmt, []);
    }
    // Top-level declare class (e.g. user-defined or import-resolver stubs)
    if (ts.isClassDeclaration(stmt) && stmt.name && hasDeclareModifier(stmt)) {
      collectExternClass(ctx, stmt, []);
    }
    // Top-level declare function stubs — registered as Wasm imports so that calls
    // can pass arguments correctly (missing args get padded with default values).
    // These are generated by preprocessImports for named imports from unresolved
    // external modules, e.g. `import { foo } from "./x.js"` → `declare function foo(a0, a1): any`.
    // In WASI mode, skip node:fs functions — they're handled by WASI syscall helpers.
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasDeclareModifier(stmt) && !stmt.body) {
      const name = stmt.name.text;
      // #2520 — when scanning the TS lib files (libReferencedNames provided),
      // only register an ambient `declare function` as an env host import if the
      // user source actually references it. Otherwise one lib-global reference
      // (Uint8Array/Date/…) drags in the whole ambient global-function surface
      // (~60: eval/alert/fetch/scroll/…), each then dropped by the allowlist
      // gate under --target wasi. User-file calls pass no set → always register.
      if (libReferencedNames && !libReferencedNames.has(name)) continue;
      // Skip node:fs functions — they're handled by dedicated dispatch:
      //   • WASI target → __wasi_*  syscall helpers (#1035)
      //   • non-WASI + allowFs → __node_fs_* JS-host imports (#1491)
      if (ctx.wasiNodeFsFuncs.has(name) && (ctx.wasi || ctx.allowFs)) continue;
      // #2696 — raw-WASI intrinsics (#2657): the `wasm:memory` accessors
      // (store32/load32/store8/load8) lower to INLINE memory ops and the
      // `wasi_snapshot_preview1` fd funcs (fd_read/fd_write) bind to the real
      // WASI import via registerWasiImports. preprocessImports rewrites BOTH
      // import forms into bare `declare function` stubs that lose their module
      // origin, so without this guard they would re-register here as `env.*`
      // host imports — spuriously firing the "not on the dual-mode allowlist"
      // drop warning on the clean nm_wasi.ts compile, and (on the npm/bun path,
      // where the stub survives) leaking an unsatisfiable `env.store32` import
      // that breaks wasmtime instantiation (loopdive/js2#389 bug 1).
      // tryCompileRawWasiCall (raw-wasi-api.ts) already handles every call site,
      // so skip the stub entirely under `--target wasi`.
      if (ctx.wasi && (ctx.wasiMemAccessors.has(name) || ctx.wasiRawImports.has(name))) continue;
      // #2696 — the #2632 fd0 stdin-reactor intrinsics. The injected
      // process.stdin prelude (src/process-stdin-prelude.ts) declares these as
      // `declare function __wasiStdin*` stubs, but every call site is
      // inline-lowered to poll_oneoff/fd_read by tryWasiTimerCall (calls.ts) when
      // `ctx.wasi`. Registering them as `env.*` host imports here therefore only
      // leaks a spurious "not on the dual-mode allowlist" dropped-import warning
      // on the otherwise-runnable standalone nm_js2wasm_node_process.ts module
      // (loopdive/js2#389 bug 2). Skip the stub under WASI.
      if (ctx.wasi && WASI_STDIN_REACTOR_INTRINSICS.has(name)) continue;
      // #1663: parseInt / parseFloat have no JS host under WASI / standalone —
      // skip the stub so the unified-collector finalize can emit the WasmGC
      // native scanners (registered under the same funcMap names) instead.
      if ((ctx.wasi || ctx.standalone) && (name === "parseInt" || name === "parseFloat")) continue;
      if (!ctx.funcMap.has(name)) {
        const sig = ctx.checker.getSignatureFromDeclaration(stmt);
        if (sig) {
          const params: ValType[] = stmt.parameters.map((p) =>
            mapTsTypeToWasm(ctx.checker.getTypeAtLocation(p), ctx.checker),
          );
          const retType = ctx.checker.getReturnTypeOfSignature(sig);
          const results: ValType[] = isVoidType(retType) ? [] : [mapTsTypeToWasm(retType, ctx.checker)];
          const typeIdx = addFuncType(ctx, params, results);
          addImport(ctx, "env", name, { kind: "func", typeIdx });
        }
      }
    }
    // declare var X: { prototype: X; new(): X } (lib.dom.d.ts pattern)
    // declare var Date: DateConstructor (interface with new() pattern)
    if (ts.isVariableStatement(stmt) && hasDeclareModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!decl.name || !ts.isIdentifier(decl.name) || !decl.type) continue;
        // Inline type literal with construct signature
        if (ts.isTypeLiteralNode(decl.type) && decl.type.members.some((m) => ts.isConstructSignatureDeclaration(m))) {
          collectExternFromDeclareVar(ctx, decl);
        }
        // Type reference to interface with construct signature (e.g. declare var Date: DateConstructor)
        // Skip types with built-in wasm handling (Array, primitives, etc.)
        else if (ts.isTypeReferenceNode(decl.type)) {
          const varName = decl.name.text;
          const BUILTIN_SKIP = new Set([
            "Array",
            "Number",
            "Boolean",
            "String",
            "Object",
            "Function",
            "Symbol",
            "BigInt",
            "Int8Array",
            "Uint8Array",
            "Int16Array",
            "Uint16Array",
            "Int32Array",
            "Uint32Array",
            "Float32Array",
            "Float64Array",
            "ArrayBuffer",
            "DataView",
            "JSON",
            "Math",
            "Error",
            "TypeError",
            "RangeError",
            "SyntaxError",
            "URIError",
            "EvalError",
            "ReferenceError",
            // Promise instance methods (.then/.catch/.finally) are handled by
            // dedicated Promise-specific codegen that registers 2-param late imports.
            // Registering Promise via collectExternFromDeclareVar causes the TypeScript
            // interface declaration (then(onfulfilled?, onrejected?)) to be collected
            // as a 3-param Wasm function, creating an arity mismatch with the 2-param
            // late imports used by the Promise-specific handler. (#966)
            "Promise",
          ]);
          if (!BUILTIN_SKIP.has(varName)) {
            const refType = ctx.checker.getTypeAtLocation(decl.type);
            const constructSigs = refType.getConstructSignatures();
            if (constructSigs.length > 0) {
              collectExternFromDeclareVar(ctx, decl);
            }
          }
        }
      }
    }
  }
}

function collectDeclareNamespace(ctx: CodegenContext, decl: ts.ModuleDeclaration, parentPath: string[]): void {
  const nsName = decl.name.text;
  const path = [...parentPath, nsName];

  if (decl.body && ts.isModuleBlock(decl.body)) {
    for (const stmt of decl.body.statements) {
      if (ts.isClassDeclaration(stmt) && stmt.name) {
        collectExternClass(ctx, stmt, path);
      }
      if (ts.isModuleDeclaration(stmt)) {
        collectDeclareNamespace(ctx, stmt, path);
      }
    }
  }
}

function collectExternClass(ctx: CodegenContext, decl: ts.ClassDeclaration, namespacePath: string[]): void {
  const className = decl.name!.text;
  if (ERROR_TYPES_SKIP.has(className)) return;
  const prefix = [...namespacePath, className].join("_");

  const info: ExternClassInfo = {
    importPrefix: prefix,
    namespacePath,
    className,
    constructorParams: [],
    methods: new Map(),
    properties: new Map(),
  };

  for (const member of decl.members) {
    if (ts.isConstructorDeclaration(member)) {
      for (const param of member.parameters) {
        const paramType = ctx.checker.getTypeAtLocation(param);
        info.constructorParams.push(mapTsTypeToWasm(paramType, ctx.checker));
      }
    }
    if (ts.isMethodDeclaration(member) && member.name) {
      const methodName = (member.name as ts.Identifier).text;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      if (sig) {
        const params: ValType[] = [{ kind: "externref" }]; // 'this'
        let requiredParams = 1;
        for (const p of member.parameters) {
          const pt = ctx.checker.getTypeAtLocation(p);
          params.push(mapTsTypeToWasm(pt, ctx.checker));
          if (!p.questionToken && !p.initializer) requiredParams++;
        }
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        // (#2770, S5b) Brand a boolean extern-method result at registration so the
        // direct `methodInfo.results[0]` consumption path (extern.ts) is honest.
        const results: ValType[] = isVoidType(retType)
          ? []
          : [brandExternMethodResult(ctx, retType, mapTsTypeToWasm(retType, ctx.checker))];
        info.methods.set(methodName, { params, results, requiredParams });
      }
    }
    if (ts.isPropertyDeclaration(member) && member.name) {
      const propName = (member.name as ts.Identifier).text;
      const propType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(propType, ctx.checker);
      const isReadonly = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
      info.properties.set(propName, { type: wasmType, readonly: isReadonly });
    }
  }

  // Record parent class for inheritance chain walk
  if (decl.heritageClauses) {
    for (const clause of decl.heritageClauses) {
      if (clause.token === ts.SyntaxKind.ExtendsKeyword && clause.types[0]) {
        const baseType = ctx.checker.getTypeAtLocation(clause.types[0]);
        const baseName = baseType.getSymbol()?.name;
        if (baseName) ctx.externClassParent.set(className, baseName);
      }
    }
  }

  ctx.externClasses.set(className, info);
  // Also register with full qualified name
  const fullName = [...namespacePath, className].join(".");
  ctx.externClasses.set(fullName, info);
}

/** Types handled natively — skip extern class registration */
const ERROR_TYPES_SKIP = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "Date",
]);

/** Collect extern class info from a `declare var X: { prototype: X; new(): X }` (lib.dom.d.ts pattern) */
function collectExternFromDeclareVar(ctx: CodegenContext, decl: ts.VariableDeclaration): void {
  const className = (decl.name as ts.Identifier).text;
  if (ERROR_TYPES_SKIP.has(className)) return;
  // (#1103a) In standalone / nativeStrings mode, `Map` is served by the
  // WasmGC-native runtime (map-runtime.ts) intercepted at the call sites.
  // Skip registering it as an externClass from the lib `declare var Map`
  // declaration — otherwise `registerExternClassImports` eagerly emits a
  // `Map_new` host import the standalone module can't satisfy.
  if (className === "Map" && ctx.nativeStrings) return;
  if (ctx.externClasses.has(className)) return;

  const symbol = ctx.checker.getSymbolAtLocation(decl.name);
  if (!symbol) return;

  const info: ExternClassInfo = {
    importPrefix: className,
    namespacePath: [],
    className,
    constructorParams: [],
    methods: new Map(),
    properties: new Map(),
  };

  // Extract constructor params from the construct signature
  if (decl.type) {
    if (ts.isTypeLiteralNode(decl.type)) {
      for (const member of decl.type.members) {
        if (ts.isConstructSignatureDeclaration(member)) {
          for (const param of member.parameters) {
            const paramType = ctx.checker.getTypeAtLocation(param);
            info.constructorParams.push(mapTsTypeToWasm(paramType, ctx.checker));
          }
          break;
        }
      }
    } else if (ts.isTypeReferenceNode(decl.type)) {
      // Resolve interface reference (e.g. DateConstructor, RegExpConstructor)
      const refType = ctx.checker.getTypeAtLocation(decl.type);
      const constructSigs = refType.getConstructSignatures();
      // Use the constructor with the most parameters so all overloads can be
      // served.  Missing args at call sites are padded with defaults.
      const sig =
        constructSigs.length > 0
          ? constructSigs.reduce((a, b) => (b.parameters.length > a.parameters.length ? b : a))
          : undefined;
      if (sig) {
        for (const param of sig.parameters) {
          const paramType = ctx.checker.getTypeOfSymbol(param);
          info.constructorParams.push(mapTsTypeToWasm(paramType, ctx.checker));
        }
      }
    }
  }

  // Collect members from own interface declarations + non-extern mixin interfaces
  const allDecls = symbol.getDeclarations() ?? [];
  const visited = new Set<string>();
  for (const d of allDecls) {
    if (!ts.isInterfaceDeclaration(d)) continue;
    // Collect own members
    collectInterfaceMembers(ctx, d, info, decl);
    // Walk extends: first extern parent → inheritance chain, non-extern → collect their members
    if (d.heritageClauses) {
      let parentSet = false;
      for (const clause of d.heritageClauses) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const typeRef of clause.types) {
          const baseType = ctx.checker.getTypeAtLocation(typeRef);
          const baseName = baseType.getSymbol()?.name;
          if (!baseName) continue;
          if (!parentSet && !ctx.externClassParent.has(className)) {
            // First extends type → record as parent for inheritance chain
            ctx.externClassParent.set(className, baseName);
            parentSet = true;
          }
          // If this base is NOT an extern class, it's a mixin — collect its members
          if (!isExternalDeclaredClass(baseType, ctx.checker)) {
            collectMixinMembers(ctx, baseType, info, decl, visited);
          }
        }
      }
    }
  }

  ctx.externClasses.set(className, info);
}

/** Collect methods and properties from an interface declaration */
function collectInterfaceMembers(
  ctx: CodegenContext,
  iface: ts.InterfaceDeclaration,
  info: ExternClassInfo,
  locationNode: ts.Node,
): void {
  for (const member of iface.members) {
    // Method signatures
    if (ts.isMethodSignature(member) && member.name && ts.isIdentifier(member.name)) {
      const methodName = member.name.text;
      if (info.methods.has(methodName)) continue;
      const sig = ctx.checker.getSignatureFromDeclaration(member);
      if (sig) {
        const params: ValType[] = [{ kind: "externref" }];
        let requiredParams = 1;
        for (const p of member.parameters) {
          const pt = ctx.checker.getTypeAtLocation(p);
          params.push(mapTsTypeToWasm(pt, ctx.checker));
          if (!p.questionToken && !p.initializer) requiredParams++;
        }
        const retType = ctx.checker.getReturnTypeOfSignature(sig);
        // (#2770, S5b) Brand a boolean extern-method result at registration so the
        // direct `methodInfo.results[0]` consumption path (extern.ts) is honest.
        const results: ValType[] = isVoidType(retType)
          ? []
          : [brandExternMethodResult(ctx, retType, mapTsTypeToWasm(retType, ctx.checker))];
        info.methods.set(methodName, { params, results, requiredParams });
      }
    }
    // Property signatures
    if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
      const propName = member.name.text;
      if (info.properties.has(propName)) continue;
      const propType = ctx.checker.getTypeAtLocation(member);
      let wasmType = mapTsTypeToWasm(propType, ctx.checker);
      // (#2671) `RegExp.lastIndex` is a value-preserving data slot: §22.2.7.2
      // RegExpBuiltinExec reads it via `ToLength(? Get(R, "lastIndex"))` at exec
      // time — the spec stores whatever was assigned verbatim and coerces only
      // inside exec (writing back only when the regex is global/sticky). Typing
      // the field `number` makes the host import eagerly ToNumber the assigned
      // value: an opaque WasmGC struct (`r.lastIndex = {valueOf(){…}}`) is
      // unconvertible to V8 ("Cannot convert object to primitive value"), so the
      // subsequent `exec` throws instead of firing the object's `valueOf` once.
      // Carry the slot as `externref` in host mode so the raw value round-trips
      // through the native RegExp; numeric uses coerce at the use site, and the
      // exec-time ToLength is performed by native code. Standalone / WASI keep
      // their native struct-field RegExp path (the `RegExp_*_lastIndex` extern
      // import is never emitted there), so only true host mode is retyped.
      if (info.className === "RegExp" && propName === "lastIndex" && !ctx.standalone && !ctx.wasi) {
        wasmType = { kind: "externref" };
      }
      // (#3051 Slice 2) `RegExp.prototype.global` / `.unicode` are spec-readonly
      // booleans, but test262's @@replace/@@split coercion tests redefine them as
      // writable data properties (`Object.defineProperty(r,'global',{writable:true})`)
      // and then assign arbitrary values (`r.global = Symbol.replace`, `= {}`,
      // `= NaN`, …). §22.2.6.11/§22.2.6.14 read the flag back through
      // `ToBoolean(? Get(rx, "global"|"unicode"))` — i.e. any value coerces at
      // read time, it is NOT constrained to a boolean on write. Typing the extern
      // property `boolean` makes the generated `RegExp_set_global(externref, i32)`
      // setter eagerly ToNumber the assigned value: a Symbol RHS traps ("Cannot
      // convert a Symbol value to a number") and an object RHS traps ("Cannot
      // convert object to primitive value") at the wasm boundary, before the value
      // is ever stored. Carry the slot as `externref` in host mode (mirroring the
      // #2671 `lastIndex` treatment) so the raw value round-trips onto the native
      // RegExp and the native @@replace/@@split protocol performs the spec
      // ToBoolean itself; explicit `r.global` reads coerce externref→boolean at the
      // use site (a boxed `false` unboxes correctly — see the Slice 2 controls).
      // Standalone / WASI keep their native struct-field RegExp path (the
      // `RegExp_*_global` extern import is never emitted there), so only host mode
      // is retyped.
      if (
        info.className === "RegExp" &&
        (propName === "global" || propName === "unicode") &&
        !ctx.standalone &&
        !ctx.wasi
      ) {
        wasmType = { kind: "externref" };
      }
      const isReadonly = member.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword) ?? false;
      info.properties.set(propName, { type: wasmType, readonly: isReadonly });
    }
    // Getter accessors (e.g. `get style(): CSSStyleDeclaration`)
    if (ts.isGetAccessorDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const propName = member.name.text;
      if (info.properties.has(propName)) continue;
      const propType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(propType, ctx.checker);
      // Check if there's a matching setter
      const hasSetter = iface.members.some(
        (m) => ts.isSetAccessorDeclaration(m) && ts.isIdentifier(m.name) && m.name.text === propName,
      );
      info.properties.set(propName, { type: wasmType, readonly: !hasSetter });
    }
  }
}

/** Recursively collect members from non-extern mixin interfaces */
function collectMixinMembers(
  ctx: CodegenContext,
  mixinType: ts.Type,
  info: ExternClassInfo,
  locationNode: ts.Node,
  visited: Set<string>,
): void {
  const mixinSymbol = mixinType.getSymbol();
  if (!mixinSymbol) return;
  const mixinName = mixinSymbol.name;
  if (visited.has(mixinName)) return;
  visited.add(mixinName);

  for (const d of mixinSymbol.getDeclarations() ?? []) {
    if (!ts.isInterfaceDeclaration(d)) continue;
    collectInterfaceMembers(ctx, d, info, locationNode);
    // Also walk this mixin's extends (for deeply nested mixins)
    if (d.heritageClauses) {
      for (const clause of d.heritageClauses) {
        if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
        for (const typeRef of clause.types) {
          const baseType = ctx.checker.getTypeAtLocation(typeRef);
          if (!isExternalDeclaredClass(baseType, ctx.checker)) {
            collectMixinMembers(ctx, baseType, info, locationNode, visited);
          }
        }
      }
    }
  }
}

function registerExternClassImports(ctx: CodegenContext, info: ExternClassInfo): void {
  // Constructor
  const ctorTypeIdx = addFuncType(ctx, info.constructorParams, [{ kind: "externref" }]);
  addImport(ctx, "env", `${info.importPrefix}_new`, {
    kind: "func",
    typeIdx: ctorTypeIdx,
  });

  // Methods
  for (const [methodName, sig] of info.methods) {
    const methodTypeIdx = addFuncType(ctx, sig.params, sig.results);
    addImport(ctx, "env", `${info.importPrefix}_${methodName}`, {
      kind: "func",
      typeIdx: methodTypeIdx,
    });
  }

  // Property getters and setters
  for (const [propName, propInfo] of info.properties) {
    const getterTypeIdx = addFuncType(ctx, [{ kind: "externref" }], [propInfo.type]);
    addImport(ctx, "env", `${info.importPrefix}_get_${propName}`, {
      kind: "func",
      typeIdx: getterTypeIdx,
    });

    if (!propInfo.readonly) {
      const setterTypeIdx = addFuncType(ctx, [{ kind: "externref" }, propInfo.type], []);
      addImport(ctx, "env", `${info.importPrefix}_set_${propName}`, {
        kind: "func",
        typeIdx: setterTypeIdx,
      });
    }
  }
}

/** Scan user code and register only the extern class imports actually used */
function collectUsedExternImports(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const registered = new Set<string>();
  const useNativeEncodingApi = ctx.wasi || ctx.standalone || ctx.strictNoHostImports;
  const isNativeEncodingClass = (className: string | undefined): boolean =>
    useNativeEncodingApi && (className === "TextEncoder" || className === "TextDecoder");

  // Pre-scan source for user-defined class names. A user-defined class shadows
  // any extern class with the same name (e.g. user `class Node` shadows DOM
  // `Node`). Without this guard, `${ClassName}_new` would be added as a host
  // import here, then collide on funcMap when class compilation later assigns
  // the same key to a defined-function index (#1284). The orphan import slot
  // then sits at the funcMap idx that the user-class registration overwrote,
  // and the late-import shift skips that key (it appears in importNames),
  // leaving funcMap[`${ClassName}_new`] pointing at an *adjacent* import slot
  // after subsequent late imports are added — so `new UserClass(...)` lowers
  // to a call against an unrelated host import (e.g. `__extern_set`).
  const userClassNames = new Set<string>();
  function collectUserClassNames(node: ts.Node): void {
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) {
      userClassNames.add(node.name.text);
    }
    forEachChild(node, collectUserClassNames);
  }
  collectUserClassNames(sourceFile);

  function resolveExtern(className: string, memberName: string, kind: "method" | "property"): ExternClassInfo | null {
    // User-defined classes shadow extern classes — never resolve to extern (#1284).
    if (userClassNames.has(className)) return null;
    let current: string | undefined = className;
    while (current) {
      const info = ctx.externClasses.get(current);
      if (info) {
        if (kind === "method" && info.methods.has(memberName)) return info;
        if (kind === "property" && info.properties.has(memberName)) return info;
      }
      current = ctx.externClassParent.get(current);
    }
    return null;
  }

  function register(importName: string, params: ValType[], results: ValType[]) {
    if (registered.has(importName)) return;
    registered.add(importName);
    const t = addFuncType(ctx, params, results);
    addImport(ctx, "env", importName, { kind: "func", typeIdx: t });
  }

  function visit(node: ts.Node) {
    // new ClassName()
    if (ts.isNewExpression(node)) {
      const type = ctx.checker.getTypeAtLocation(node);
      const className = type.getSymbol()?.name;
      if (className && !userClassNames.has(className) && !isNativeEncodingClass(className)) {
        const info = ctx.externClasses.get(className);
        if (info) register(`${info.importPrefix}_new`, info.constructorParams, [{ kind: "externref" }]);
      }
    }

    // RegExp literal (/pattern/flags) → needs RegExp_new import
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const info = ctx.externClasses.get("RegExp");
      if (info) {
        register(`${info.importPrefix}_new`, info.constructorParams, [{ kind: "externref" }]);
      }
    }

    // RegExp(pattern, flags) call without `new` — compileCallExpression
    // emits the RegExp_new host call directly. Register it here so the
    // import exists by the time codegen runs. (#1055)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "RegExp") {
      const info = ctx.externClasses.get("RegExp");
      if (info) {
        register(`${info.importPrefix}_new`, info.constructorParams, [{ kind: "externref" }]);
      }
    }

    // obj.prop or obj.method(...)
    if (ts.isPropertyAccessExpression(node)) {
      // Skip if this is the target of an assignment (setter handled below)
      const isAssignTarget =
        node.parent &&
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.parent.left === node;

      if (!isAssignTarget) {
        const objType = ctx.checker.getTypeAtLocation(node.expression);
        const className = objType.getSymbol()?.name;
        const memberName = node.name.text;
        if (className && !isNativeEncodingClass(className)) {
          const isCall = node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node;
          if (isCall) {
            const info = resolveExtern(className, memberName, "method");
            if (info) {
              const sig = info.methods.get(memberName)!;
              register(`${info.importPrefix}_${memberName}`, sig.params, sig.results);
            }
          } else {
            // #1914 — standalone answers RegExp reflection reads natively
            // (struct fields); never pre-register the env.RegExp_get_* host
            // import for them, matching the compile-path interception in
            // property-access.ts. Same set on both sides keeps a non-handled
            // prop on the (refusing) extern path instead of silently losing
            // its import.
            const isStandaloneNativeRegExpProp =
              ctx.standalone && className === "RegExp" && STANDALONE_REGEXP_REFLECTION_PROPS.has(memberName);
            const info = isStandaloneNativeRegExpProp ? null : resolveExtern(className, memberName, "property");
            if (info) {
              const propInfo = info.properties.get(memberName)!;
              register(`${info.importPrefix}_get_${memberName}`, [{ kind: "externref" }], [propInfo.type]);
            }
          }
        }
      }
    }

    // obj.prop = value
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      const objType = ctx.checker.getTypeAtLocation(node.left.expression);
      const className = objType.getSymbol()?.name;
      const propName = node.left.name.text;
      // #1914 — `re.lastIndex = v` is a native struct.set in standalone; do
      // not pre-register env.RegExp_set_lastIndex.
      const isStandaloneNativeRegExpWrite = ctx.standalone && className === "RegExp" && propName === "lastIndex";
      if (className && !isNativeEncodingClass(className) && !isStandaloneNativeRegExpWrite) {
        const info = resolveExtern(className, propName, "property");
        if (info) {
          const propInfo = info.properties.get(propName)!;
          register(`${info.importPrefix}_set_${propName}`, [{ kind: "externref" }, propInfo.type], []);
        }
      }
    }

    // obj[idx] on externref (e.g. HTMLCollection) → __extern_get
    if (ts.isElementAccessExpression(node)) {
      // Skip when element access is the callee of a call expression (e.g. obj['method']())
      // — the call handler compiles this as a direct method call, not a property read
      const isCallCallee = node.parent && ts.isCallExpression(node.parent) && node.parent.expression === node;
      const isNativeStandaloneRegExpMatchArray =
        ctx.standalone && isStandaloneRegExpMatchArrayValue(ctx, node.expression);
      const objType = ctx.checker.getTypeAtLocation(node.expression);
      const sym = objType.getSymbol();
      // Skip Array and tuple types — those use Wasm GC struct/array ops, not host import
      // Skip widened empty objects — those use struct.get, not host import
      const isWidenedVar = ts.isIdentifier(node.expression) && ctx.widenedVarStructMap.has(node.expression.text);
      if (
        !isCallCallee &&
        !isNativeStandaloneRegExpMatchArray &&
        sym?.name !== "Array" &&
        sym?.name !== "__type" &&
        sym?.name !== "__object" &&
        !isTupleType(objType) &&
        !isWidenedVar
      ) {
        const wasmType = mapTsTypeToWasm(objType, ctx.checker);
        if (wasmType.kind === "externref") {
          // (#2908) Host-free modes: DO NOT eagerly seed the `env::__extern_get`
          // HOST import here. `__extern_get` is a member of
          // OBJECT_RUNTIME_HELPER_NAMES, so under `--target standalone`/`wasi`
          // the compile-path `ensureLateImport(ctx, "__extern_get", …)` at every
          // dynamic-read site routes the name to the Wasm-native `__extern_get`
          // defined by `ensureObjectRuntime` (object-runtime.ts) — a DEFINED
          // function, no host import. But `ensureLateImport` short-circuits on
          // `funcMap.has(name)`: if THIS pre-scan has already registered the
          // host import into funcMap, that native routing never fires and the
          // module ships an unsatisfiable `env::__extern_get` (the standalone
          // dynamic-object-property leak — the single largest host-import leak
          // class, harness `verifyProperty`/`obj[name]` drives it into ~4.5k
          // tests). Skipping the pre-registration lets the native routing win;
          // host/gc mode is unchanged (still eagerly seeds the host import).
          if (!(ctx.standalone || ctx.wasi)) {
            register("__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
          }
        }
      }
    }

    forEachChild(node, visit);
  }

  for (const stmt of sourceFile.statements) {
    forEachChild(stmt, visit);
  }
}

// ── Declared globals (e.g. declare const document: Document) ────────

function collectDeclaredGlobals(ctx: CodegenContext, libFile: ts.SourceFile, userFile: ts.SourceFile): void {
  // First collect identifiers referenced in user source
  const referencedNames = new Set<string>();
  // #2520 — also track names used as a VALUE (vs. a pure call/new callee or a
  // type-position reference). Only a value use actually needs the reified host
  // constructor object (`global_<Ctor>`); `new Uint8Array(4)` does not, so it
  // must not register it.
  //
  // A property-access RECEIVER (`Date.parse`, `Date.hasOwnProperty(...)`,
  // `Uint8Array.from(...)`) IS a value use: the static methods/props the
  // compiler intercepts (`Date.now`, `Array.isArray`, `Uint8Array.from`, …) are
  // resolved BEFORE identifier resolution at the property-access site, so for
  // those the registered global is simply an unused import the fast path
  // bypasses — harmless. But for any NON-intercepted static prop (`Date.parse`,
  // `Date.prototype`, `Date.hasOwnProperty`, `X.length`, `X.constructor`) the
  // bare receiver `X` must resolve to the host constructor object, which needs
  // `global_X`. Excluding the receiver dropped that global and broke e.g.
  // `Date.hasOwnProperty("prototype")` (→ null receiver, assert fails). So a
  // receiver counts as a value use; only the call/new callee, the property NAME
  // (`obj.Date`), and type positions are excluded.
  const valueRefNames = new Set<string>();
  const isBareValueUse = (id: ts.Identifier): boolean => {
    const p = id.parent;
    if ((ts.isNewExpression(p) || ts.isCallExpression(p)) && p.expression === id) return false;
    // Property NAME (`obj.Date`) is a key, not a value reference; the RECEIVER
    // (`Date.member`) is a value use and must NOT be excluded.
    if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
    // Type-annotation position (`buf: Uint8Array`, `Uint8Array | ArrayBuffer`,
    // `typeof X`) is not a value use of the constructor.
    if (ts.isTypeReferenceNode(p) && p.typeName === id) return false;
    if (ts.isTypeQueryNode(p) && p.exprName === id) return false;
    return true;
  };
  const collectRefs = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      referencedNames.add(node.text);
      if (isBareValueUse(node)) valueRefNames.add(node.text);
    }
    forEachChild(node, collectRefs);
  };
  for (const stmt of userFile.statements) {
    forEachChild(stmt, collectRefs);
  }

  for (const stmt of libFile.statements) {
    if (!ts.isVariableStatement(stmt) || !hasDeclareModifier(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (!referencedNames.has(name)) continue; // only register used globals
      if (ctx.declaredGlobals.has(name)) continue;
      const type = ctx.checker.getTypeAtLocation(decl);
      if (!isExternalDeclaredClass(type, ctx.checker)) continue;
      // #2907 — under no-JS-host mode (standalone as well as
      // strictNoHostImports/wasi) there is no host to satisfy
      // `env.global_<Name>`. `TypeError`, `Error`, `RegExp`, `Reflect`, the
      // *Error subtypes etc. are NOT in `BUILTIN_TYPES`, so they reach here via
      // `isExternalDeclaredClass` and leaked a `global_<Name>` host import in
      // standalone — the ambient-ctor loop below already skips under strict mode
      // (#2696) but this earlier declared-globals loop had no such guard. A bare
      // value use of the global (the harness `expectedError = TypeError` idiom,
      // an array literal `[TypeError, RangeError]`, `Object.getPrototypeOf(Reflect)`)
      // was the sole standalone blocker for a large cluster. `instanceof`/`new`
      // are resolved BEFORE identifier resolution (static builtin-tag registry in
      // builtin-tags.ts / `new`-callee interception), so dropping the host value
      // binding here only affects genuine bare-value uses, which fall through to
      // the native-namespace carrier (identifiers.ts:emitBuiltinNamespaceObject)
      // or the `ref.null.extern` graceful default. Host/gc mode is unchanged.
      if (ctx.strictNoHostImports || ctx.standalone) continue;
      const importName = `global_${name}`;
      const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        // (#2856) Record the extern class of the global's declared type so
        // the IR host-extern path can type the `call global_<name>` handle
        // as `IrType.extern { className }` and dispatch member access on it.
        const className = type.getSymbol()?.name;
        ctx.declaredGlobals.set(name, { type: { kind: "externref" }, funcIdx, className });
      }
    }
  }

  // #1065 — Register ambient builtin constructors (Array, Object, Function, ...)
  // as declared globals when referenced in source. These are filtered out of
  // isExternalDeclaredClass because they have Wasm-native fast paths (vec
  // structs, tuples, etc.), but they ALSO need to resolve to the real host
  // constructor when used in identity-compare positions (`x.constructor === Array`).
  // The fast paths at call sites (`new Array(n)`, `Array.of`, `Array.prototype`,
  // `Array.isArray`) intercept BEFORE identifier resolution, so adding the
  // global only affects bare-identifier uses.
  const AMBIENT_BUILTIN_CTORS = [
    "Array",
    "Object",
    "Function",
    "Number",
    "String",
    "Boolean",
    "Symbol",
    "Error",
    "TypeError",
    "RangeError",
    "SyntaxError",
    "ReferenceError",
    "Date",
    "RegExp",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "Promise",
    "Math",
    "JSON",
    "Reflect",
    "ArrayBuffer",
    "DataView",
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
  ];
  for (const name of AMBIENT_BUILTIN_CTORS) {
    // #2520 — only when the constructor is used as a bare value/identity; a
    // plain `new Uint8Array(4)` / `Uint8Array.from(...)` is intercepted by the
    // native fast paths and needs no host constructor object.
    if (!valueRefNames.has(name)) continue;
    if (ctx.declaredGlobals.has(name)) continue;
    // #2696 — under strict-no-host-imports (auto-on for --target wasi) there is
    // no JS host to satisfy `env.global_<Ctor>`, so addImport would drop it AND,
    // because the dropped import leaves no funcMap entry, the
    // `declaredGlobals.set` below never fires either — the whole registration is
    // already a no-op EXCEPT for the spurious "not on the dual-mode allowlist"
    // warning it emits. nm_js2wasm_node_process.ts trips this via the
    // `String.fromCharCode` receiver in the injected process.stdin prelude
    // (loopdive/js2#389 bug 2: `env.global_String`). Skip it so the standalone
    // module compiles cleanly; bare identity uses already had no host global
    // under strict mode, so behavior is unchanged.
    // #2907 — `ctx.standalone` is a SEPARATE flag from `strictNoHostImports`
    // (create-context.ts: strictNoHostImports defaults to `wasi`, NOT
    // `standalone`), so the guard above missed `--target standalone`. A bare
    // value use of an ambient ctor there (`[Int8Array, Uint8Array, …].forEach`,
    // `expectedError = TypeError`) leaked `env.global_<Ctor>` with no host to
    // satisfy it. Include `ctx.standalone` so standalone stops leaking the host
    // constructor object; bare-value uses fall through to the native carrier /
    // ref.null.extern default exactly as under wasi.
    if (ctx.strictNoHostImports || ctx.standalone) continue;
    const importName = `global_${name}`;
    const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
    addImport(ctx, "env", importName, { kind: "func", typeIdx });
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx !== undefined) {
      ctx.declaredGlobals.set(name, { type: { kind: "externref" }, funcIdx });
    }
  }
}

/**
 * DOM-only globals that require a browser host and are not available in WASI.
 * Used to emit a compile error when `--target wasi` is combined with DOM usage.
 */
const DOM_ONLY_GLOBALS = new Set([
  "document",
  "window",
  "navigator",
  "location",
  "history",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "EventTarget",
  "DocumentFragment",
  "Text",
  "Comment",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]);

/**
 * Register Node.js builtin module imports as externref host imports (#1044).
 *
 * For each detected `import * as X from 'node:http'` (or named/default import),
 * we register a function import `__node_<module>` that returns the module object
 * as externref. The local binding name is added to `declaredGlobals` so that
 * identifier resolution in expressions picks it up via the existing extern path.
 *
 * In WASI mode, emit a compile error instead (Node builtins not available).
 */
function registerNodeBuiltinImports(ctx: CodegenContext, builtins: NodeBuiltinImport[]): void {
  for (const builtin of builtins) {
    if (ctx.wasi) {
      // `node:process` is a compile-time API surface for WASI: import
      // preprocessing leaves a type-level `process` binding in the AST and
      // node-fs-api.ts lowers supported stream calls directly to WASI.
      if (builtin.moduleName === "process") continue;
      // #2631/#2655 — `node:fs` is likewise a compile-time API surface when the
      // program uses the fd-based synchronous primitives readSync / writeSync:
      // those are stripped by import preprocessing and lowered by node-fs-api.ts
      // (tryCompileNodeFsCall) to EITHER imported `node:fs` shim calls
      // (--link node:fs) OR direct `wasi_snapshot_preview1.fd_read`/`fd_write`
      // syscalls (standalone --target wasi, #2655). Either way the `fs` builtin
      // import itself is consumed at compile time and must not error here.
      // Path-based fs usage is rejected at the call site (PATH_BASED_FS_FNS in
      // calls.ts) / by the no-provider gate in tryCompileNodeFsCall, not here.
      if (
        builtin.moduleName === "fs" &&
        (ctx.wasiNodeFsFuncs.has("readSync") || ctx.wasiNodeFsFuncs.has("writeSync"))
      ) {
        continue;
      }
      ctx.errors.push({
        message: `Node builtin module '${builtin.moduleName}' is not available in WASI target. Use compile-time syscall path for node:fs (#1035).`,
        line: 1,
        column: 1,
        severity: "error",
      });
      continue;
    }

    // Track this module as a Node builtin so the import manifest/runtime can resolve it
    ctx.mod.nodeBuiltinModules.add(builtin.moduleName);

    const importName = `__node_${builtin.moduleName}`;
    // Skip if already registered (e.g. duplicate imports)
    if (ctx.funcMap.has(importName)) continue;

    const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
    addImport(ctx, "env", importName, { kind: "func", typeIdx });
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx !== undefined) {
      // Register as a declared global so identifier resolution picks it up
      ctx.declaredGlobals.set(builtin.localName, { type: { kind: "externref" }, funcIdx });
      ctx.nodeBuiltinGlobals.set(builtin.localName, funcIdx);
    }
  }
}

/**
 * Register JSX runtime imports detected by preprocessImports (#1540).
 *
 * Wires three host-import shapes:
 *   - `__jsx_runtime_jsx` / `__jsx_runtime_jsxs`: `(externref, externref,
 *     externref) -> externref` — called by the JSX call-site intercept in
 *     `expressions/calls.ts`.
 *   - `__jsx_runtime_Fragment`: `() -> externref` — exposed as a declared
 *     global under the user's `localFragment` name, so identifier
 *     resolution sees it like a normal externref.
 *   - `__jsx_runtime_jsxDEV` (when present): same shape as `jsx`/`jsxs`
 *     with three extra throwaway args we ignore in v1.
 *
 * In WASI mode we still register the imports (the standalone-target
 * Wasm-native VDOM path is a follow-up); the user is expected to provide
 * `deps.jsxRuntime` or accept the built-in React-shaped fallback.
 *
 * `ctx.mod.jsxImportSource` is set so the import-manifest classifier can
 * carry the specifier through to `resolveImport`.
 */
function registerJsxRuntimeImports(
  ctx: CodegenContext,
  jsxRuntime: import("../import-resolver.js").JsxRuntimeImport,
): void {
  ctx.mod.jsxImportSource = jsxRuntime.specifier;
  ctx.jsxRuntime = jsxRuntime;
  const ext: ValType = { kind: "externref" };

  const callableShapes: { method: "jsx" | "jsxs" | "jsxDEV"; local: string | undefined; arity: number }[] = [
    { method: "jsx", local: jsxRuntime.localJsx, arity: 3 },
    { method: "jsxs", local: jsxRuntime.localJsxs, arity: 3 },
    // jsxDEV takes extra (isStatic, source, self) args. We accept up to 6
    // and ignore the trailing three at the host binding side.
    { method: "jsxDEV", local: jsxRuntime.localJsxDev, arity: 6 },
  ];
  for (const { method, local, arity } of callableShapes) {
    if (!local) continue;
    const importName = `__jsx_runtime_${method}`;
    if (ctx.funcMap.has(importName)) continue;
    const params: ValType[] = Array.from({ length: arity }, () => ext);
    const typeIdx = addFuncType(ctx, params, [ext]);
    addImport(ctx, "env", importName, { kind: "func", typeIdx });
  }

  // Fragment is an externref-returning thunk so identity comparisons work
  // (the host binding caches a single Symbol). Surface it as a declared
  // global so identifier resolution picks it up.
  if (jsxRuntime.localFragment) {
    const importName = `__jsx_runtime_Fragment`;
    if (!ctx.funcMap.has(importName)) {
      const typeIdx = addFuncType(ctx, [], [ext]);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
    }
    const funcIdx = ctx.funcMap.get(importName);
    if (funcIdx !== undefined) {
      ctx.declaredGlobals.set(jsxRuntime.localFragment, { type: { kind: "externref" }, funcIdx });
      ctx.nodeBuiltinGlobals.set(jsxRuntime.localFragment, funcIdx);
    }
  }
}

/** Check if source code references DOM globals (document, window) */
const LIB_GLOBALS = new Set([
  "document",
  "window",
  "Date",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "WeakRef",
  "RegExp",
  "Error",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  // #1065 — ambient builtin constructors that need host-global resolution
  // for bare-identifier uses (e.g. `x.constructor === Array`). Call-site
  // fast paths intercept before identifier resolution runs.
  "Array",
  "Object",
  "Function",
  "Number",
  "String",
  "Boolean",
  "Symbol",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  // #1018 — additional builtins whose .prototype access needs host resolution
  "Promise",
  "Math",
  "JSON",
  "Reflect",
  "ArrayBuffer",
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

function sourceUsesLibGlobals(sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(node) && LIB_GLOBALS.has(node.text)) {
      found = true;
      return;
    }
    // RegExp literals (/pattern/flags) implicitly use the RegExp extern class
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  };
  for (const stmt of sourceFile.statements) {
    forEachChild(stmt, visit);
    if (found) break;
  }
  return found;
}

/**
 * In WASI mode, scan source for DOM-only globals and report compile errors.
 * DOM globals require a browser host and are not available in standalone Wasm.
 */
function checkWasiDomUsage(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && DOM_ONLY_GLOBALS.has(node.text)) {
      if (!found.has(node.text)) {
        found.add(node.text);
        reportError(
          ctx,
          node,
          `Codegen error: DOM global '${node.text}' is not available in WASI target — DOM requires a browser host`,
        );
      }
    }
    forEachChild(node, visit);
  };
  for (const stmt of sourceFile.statements) {
    forEachChild(stmt, visit);
  }
}

/**
 * Timer / event-loop globals that have no equivalent in standalone WASI.
 * Reported as compile-time errors under `--target wasi` so users do not get
 * silent runtime hangs or `unknown import` instantiation failures (#1484).
 *
 * NOTE: `requestAnimationFrame` / `cancelAnimationFrame` are already covered
 * by DOM_ONLY_GLOBALS above, so they are not duplicated here.
 */
// #2632 Phase 1 — setTimeout/setInterval/clearTimeout/clearInterval and
// queueMicrotask are now LOWERED onto the timer-heap + run-loop reactor under
// --target wasi (see ensureTimerHeap / emitTimerAdd). Only `setImmediate`
// remains rejected: its Node "check phase" ordering (after I/O poll, distinct
// from a 0ms timer) is a later-phase concern not modelled by the Phase-1 loop.
const WASI_REJECTED_TIMER_GLOBALS = new Set(["setImmediate"]);

/**
 * In WASI mode, scan source for timer / event-loop globals (setTimeout etc.)
 * and emit compile errors. WASI has no event loop, so these would either
 * silently no-op (if shimmed) or fail to instantiate (env::setTimeout import
 * unresolved). See #1484. The poll_oneoff-based `__wasi_sleep_ms` helper
 * provides a synchronous-sleep building block but does not (yet) wire into
 * setTimeout/setInterval call sites — until that lands, reject the calls.
 */
function rejectTimersUnderWasi(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const found = new Set<string>();
  /**
   * Returns true if the identifier appears in a non-expression "name slot"
   * (a member name, declaration binding, property assignment key, etc.).
   * Bare global-identifier references and call-site identifiers are NOT
   * filtered by this predicate.
   */
  const isNameSlot = (id: ts.Identifier): boolean => {
    const parent = id.parent as ts.Node | undefined;
    if (!parent) return false;
    // `obj.setTimeout` — the `.name` slot of a property access.
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) return true;
    // `class C { setTimeout() {} }` — method/property/getter/setter name slot.
    if (
      (ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isGetAccessorDeclaration(parent) ||
        ts.isSetAccessorDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isShorthandPropertyAssignment(parent) ||
        ts.isEnumMember(parent) ||
        ts.isBindingElement(parent) ||
        ts.isParameter(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isFunctionDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isImportSpecifier(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isNamedImports(parent) ||
        ts.isNamedExports(parent) ||
        ts.isTypeReferenceNode(parent) ||
        ts.isQualifiedName(parent)) &&
      (parent as { name?: ts.Node }).name === id
    ) {
      return true;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && WASI_REJECTED_TIMER_GLOBALS.has(node.text) && !isNameSlot(node)) {
      if (!found.has(node.text)) {
        found.add(node.text);
        reportError(
          ctx,
          node,
          `Codegen error: '${node.text}' is not available under --target wasi — WASI has no event loop. ` +
            `Use a synchronous loop, or split work across discrete _start invocations. ` +
            `(A poll_oneoff-based sleep helper is available internally but not yet wired into ${node.text}.)`,
        );
      }
    }
    forEachChild(node, visit);
  };
  for (const stmt of sourceFile.statements) {
    forEachChild(stmt, visit);
  }
}

// ── Regular declaration collection ───────────────────────────────────

/** Collect enum declarations into ctx.enumValues / ctx.enumStringValues */
export function collectEnumDeclarations(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
  const stringEnumLiterals: string[] = [];
  for (const stmt of sourceFile.statements) {
    if (!ts.isEnumDeclaration(stmt)) continue;
    const enumName = stmt.name.text;
    let nextValue = 0;
    for (const member of stmt.members) {
      const memberName = (member.name as ts.Identifier).text;
      const key = `${enumName}.${memberName}`;
      if (member.initializer) {
        if (ts.isStringLiteral(member.initializer)) {
          // String enum member — store in enumStringValues
          const strVal = member.initializer.text;
          ctx.enumStringValues.set(key, strVal);
          if (!ctx.stringGlobalMap.has(strVal)) {
            stringEnumLiterals.push(strVal);
          }
          continue;
        }
        if (ts.isNumericLiteral(member.initializer)) {
          nextValue = Number(member.initializer.text.replace(/_/g, ""));
        } else if (
          ts.isPrefixUnaryExpression(member.initializer) &&
          member.initializer.operator === ts.SyntaxKind.MinusToken &&
          ts.isNumericLiteral(member.initializer.operand)
        ) {
          nextValue = -Number((member.initializer.operand as ts.NumericLiteral).text.replace(/_/g, ""));
        }
      }
      ctx.enumValues.set(key, nextValue);
      nextValue++;
    }
  }

  // Register string enum literals as string constant globals
  if (stringEnumLiterals.length > 0) {
    if (ctx.nativeStrings) {
      ensureNativeStringHelpers(ctx);
      for (const value of stringEnumLiterals) {
        if (!ctx.stringGlobalMap.has(value)) ctx.stringGlobalMap.set(value, -1);
      }
    } else {
      addStringImports(ctx);
      for (const value of stringEnumLiterals) {
        addStringConstantGlobal(ctx, value);
      }
    }
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
 * IMPORTANT — trigger on the `void`-EXPRESSION INITIALIZER ONLY, not on a bare
 * "purely `undefined`/`void` declared type". A binding can be `undefined`-typed
 * for unrelated reasons (e.g. `const afterA = obj.a` reading an optional
 * `a?: number` after `delete obj.a`), and those MUST stay a numeric slot — the
 * delete / optional-property machinery encodes `undefined` as an f64 sNaN
 * sentinel and relies on the local being f64/i32 so `afterA === undefined`
 * detects the sentinel. Forcing those to externref boxes the sentinel via
 * `__box_number` and breaks the `=== undefined` check (regressed
 * delete-sentinel #1112). The `void 0` expression is the precise, narrow signal
 * for the acorn evolving-local idiom.
 */
export function varBindingNeedsExternrefForUndefined(decl: ts.VariableDeclaration | undefined): boolean {
  // `var x = (void 0)` / `var x = void <expr>` — strip parens to find the void.
  let init = decl?.initializer;
  while (init && ts.isParenthesizedExpression(init)) init = init.expression;
  return init !== undefined && ts.isVoidExpression(init);
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
    const wasmType: ValType =
      initForcesExternref || isNullablePrimitiveType(varType) || varBindingNeedsExternrefForUndefined(decl)
        ? { kind: "externref" as const }
        : resolveWasmType(ctx, varType);
    if (initForcesExternref) ctx.externrefAccessorVars.add(name);
    const localIdx = allocLocal(fctx, name, wasmType);
    // In JS, hoisted `var` variables are `undefined` before their declaration,
    // not `null`. For externref locals, emit __get_undefined() + local.set (#737).
    if (wasmType.kind === "externref") {
      emitUndefined(ctx, fctx);
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

function isStandaloneRegExpMatchArrayValue(ctx: CodegenContext, expr: ts.Expression): boolean {
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
 * `clsName`) is re-assigned somewhere in its containing function with a RHS
 * whose static type is NOT that class — i.e. the slot can hold a foreign
 * (usually host-object) value at runtime. Symbol-matched like `needsTdzFlag`
 * so shadowing same-named inner bindings don't false-positive.
 */
function bindingHasForeignReassignment(
  ctx: CodegenContext,
  decl: ts.VariableDeclaration,
  name: string,
  clsName: string,
): boolean {
  const symbol = ctx.checker.getSymbolAtLocation(decl.name);
  const declFunc = getContainingFunctionForTdz(decl);
  const funcBody = declFunc && "body" in declFunc ? (declFunc as { body?: ts.Node }).body : undefined;
  const scope = funcBody ?? decl.getSourceFile();
  let foreign = false;
  const visit = (node: ts.Node): void => {
    if (foreign) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name &&
      node.left !== decl.name
    ) {
      const sym = ctx.checker.getSymbolAtLocation(node.left);
      if (symbol === undefined || sym === symbol) {
        let rhsName: string | undefined;
        try {
          rhsName = ctx.checker.getTypeAtLocation(node.right).getSymbol()?.name;
        } catch {
          rhsName = undefined;
        }
        if (rhsName !== undefined && !ctx.classSet.has(rhsName)) {
          rhsName = ctx.classExprNameMap.get(rhsName) ?? rhsName;
        }
        if (rhsName !== clsName) {
          foreign = true;
          return;
        }
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
                : (inferLetConstInitializerWasmType(ctx, fctx, decl.initializer) ?? resolveWasmType(ctx, varType));
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

export function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

export function hasDeclareModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) ?? false;
}

export function hasAsyncModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
}

export function hasAbstractModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Abstract) !== 0;
}

export function hasStaticModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Static) !== 0;
}

/** Check if a function declaration is a generator (function*) */
export function isGeneratorFunction(node: ts.FunctionDeclaration): boolean {
  return node.asteriskToken !== undefined;
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
} from "./registry/imports.js";
export {
  addFuncType,
  funcTypeEq,
  getArrTypeIdxFromVec,
  getOrRegisterArrayType,
  getOrRegisterRefCellType,
  getOrRegisterResizableAbType,
  getOrRegisterTemplateVecType,
  getOrRegisterVecType,
} from "./registry/types.js";
export { compileExpression, compileStatement } from "./shared.js";
