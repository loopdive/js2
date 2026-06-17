// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { ts, forEachChild } from "../ts-api.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { analyzeLinearUint8 } from "./linear-uint8-analysis.js";
import { isLinearU8RepresentableNew } from "./linear-uint8-signatures.js";
import type { MultiTypedAST, TypedAST } from "../checker/index.js";
import {
  isBigIntType,
  isBooleanType,
  isExternalDeclaredClass,
  isHeterogeneousUnion,
  isNullablePrimitiveType,
  isNumberType,
  isStringType,
  isVoidType,
  mapTsTypeToWasm,
} from "../checker/type-mapper.js";
import type { FieldDef, Instr, StructTypeDef, ValType, WasmFunction, WasmModule } from "../ir/types.js";
import { createEmptyModule } from "../ir/types.js";
import { compileIrPathFunctions, type IrIntegrationError } from "../ir/integration.js";
import { irVal, type IrType } from "../ir/nodes.js";
import { buildTypeMap, type LatticeType } from "../ir/propagate.js";
import { planIrCompilation, type IrFallbackReason } from "../ir/select.js";
import { createCodegenContext } from "./context/create-context.js";
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
import { ensureNativeIteratorRuntime, fillNativeIteratorUserArms } from "./iterator-native.js";
import { fillClosedMethodDispatch } from "./closed-method-dispatch.js";
import { emitUndefined, reconcileNativeStrFinalizeShift } from "./expressions/late-imports.js";
import { fillProtoIteratorDriver } from "./expressions/proto-override.js";
import { fillAccessorDrivers } from "./accessor-driver.js";
import { fillApplyClosure, fillExternIsArray, fillProxyDispatch } from "./object-runtime.js";
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
  getOrRegisterTemplateVecType,
  getOrRegisterVecType,
} from "./registry/types.js";
import { exportDrainMicrotasksIfRegistered, getDrainFuncIdxForWasiStart } from "./async-scheduler.js";
import { flushLateImportShifts, registerAddStringImports, registerAddUnionImports } from "./shared.js";
import { stackBalance, getFixupEvents, summarizeFixups, strictBalanceDiagnostics } from "./stack-balance.js";
import { emitNativeParseNumber } from "./parse-number-native.js";
import { ensureRegexMatchVecType } from "./native-regex.js";
import { STANDALONE_REGEXP_REFLECTION_PROPS } from "./regexp-standalone.js";

// ── Extracted sub-modules ──────────────────────────────────────────────────
import {
  emitWrapperValueOfFunctions,
  ensureAnyFromExternHelper,
  ensureAnyHelpers,
  ensureAnyToExternHelper,
  ensureAnyValueType,
  ensureWrapperTypes,
  isAnyValue,
} from "./any-helpers.js";
import {
  buildShapePropFlagsTable,
  collectClassDeclaration,
  collectDeclaredFuncRefs,
  compileClassBodies,
} from "./class-bodies.js";
import { classMemberFuncKey } from "./class-member-keys.js"; // (#1983)
import {
  applyShapeInference,
  collectDeclarations,
  inferNumericReturnTypes,
  collectEmptyObjectWidening,
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
  emitTestRuntimeStringHelpers,
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

function typedArrayVecStorage(ctx: CodegenContext, name: string): { key: string; type: ValType } {
  return (ctx.wasi || ctx.standalone) && name === "Uint8Array"
    ? { key: "i8_byte", type: { kind: "i8" } }
    : { key: "f64", type: { kind: "f64" } };
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
    // Slice 14 (#1228) — AnyKeyword lowers to externref. The IR's externref
    // val type is the catch-all for host values; operations on `any`-typed
    // SSA defs must be conservative (no field access, no arithmetic) but
    // pass-through forwarding (return, parameter passing) is fine.
    if (node.kind === ts.SyntaxKind.AnyKeyword) return irVal({ kind: "externref" });
    // Slice 6 part 2 (#1181) — array type (T[] or Array<T>) resolves to a
    // vec ref. The legacy `getOrRegisterVecType` produces the same
    // (ref_null $vec_<elem>) struct ref the for-of vec fast path needs,
    // and the IR resolver's `resolveVec` (in integration.ts) reads the
    // struct shape back to recover element ValType. Numeric / boolean /
    // string element types are accepted; nested-vec or object-element
    // types throw and fall back to legacy.
    if (ts.isArrayTypeNode(node)) {
      const elemIr = resolvePositionType(node.elementType, undefined, ctx, classShapes);
      const elemVal =
        elemIr.kind === "val" ? elemIr.val : elemIr.kind === "string" ? ({ kind: "externref" } as ValType) : null;
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
      const tsType = ctx.checker.getTypeFromTypeNode(node);
      const ir = objectIrTypeFromTsType(ctx, tsType);
      if (ir) return ir;
      throw new Error(`object TypeNode ${ts.SyntaxKind[node.kind]} could not be lowered to IrType.object`);
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
  for (const stmt of sourceFile.statements) {
    if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
    if (stmt.heritageClauses && stmt.heritageClauses.length > 0) continue; // slice 4 defers inheritance
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

    // Fields — read from the legacy `structFields` (already includes
    // type info that the IR cares about). Strip the `__tag` prefix and
    // map each remaining field's ValType back to an IrType. If any
    // field type can't be projected (e.g. tagged-union ref), skip the
    // whole class.
    const legacyFields = ctx.structFields.get(className)!;
    const fields: { name: string; type: IrType }[] = [];
    let fieldsOk = true;
    for (const f of legacyFields) {
      if (f.name === "__tag") continue;
      const ir = valTypeToIrField(ctx, f.type);
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
    });
  }
  return out;
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
  // Slice 4 defers `string`-typed class fields exposed as externref or
  // (ref $AnyString) — the IR's `IrType.string` is backend-agnostic
  // but the legacy `structFields` already commits to a backend ValType
  // (externref/ref). Returning null here lets the class fall back to
  // legacy if it has string fields.
  return null;
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
} {
  const mod = createEmptyModule();
  const ctx = createCodegenContext(mod, ast.checker, options);
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
  try {
    // WASI target: register linear memory, bump pointer global, and WASI imports
    if (ctx.wasi) {
      registerWasiImports(ctx, ast.sourceFile);
      // #1886 — pre-pass: classify which `Uint8Array` buffers are pure I/O
      // (never escape the GC heap) so they can be backed by linear memory with
      // zero-copy fd_read/fd_write. Side-effect free; codegen consumers are
      // additive (empty result ⇒ emitted module identical to today).
      ctx.linearUint8 = analyzeLinearUint8(ast.checker, ast.sourceFile);
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
      for (const sf of ast.program.getSourceFiles()) {
        const baseName = sf.fileName.split("/").pop() ?? sf.fileName;
        if (baseName.startsWith("lib.") && baseName.endsWith(".d.ts")) {
          collectExternDeclarations(ctx, sf);
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
    // class objects. There is no Proxy (and no JS host) in --target standalone,
    // so we skip registering them. `emitLazyProtoGet` / `emitLazyClassObjectGet`
    // gate their `call` emission on the import being present in funcMap, so
    // skipping registration cleanly drops the host notification while the
    // struct-backed prototype/class globals still work natively.
    if (sourceContainsClass(ast.sourceFile) && !ctx.standalone) {
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

    collectDeclarations(ctx, ast.sourceFile);

    // Shape inference: detect array-like variables and override their types
    applyShapeInference(ctx, ast.checker, ast.sourceFile);

    // (#1636-S1) Eagerly register the `__current_this` module global so that
    // `ThisKeyword` resolution in free-function-closure bodies (compiled in
    // the next phase) can emit `global.get __current_this`. The companion
    // `__call_fn_method_N` exports that install / restore this global are
    // emitted in post-processing.
    ensureCurrentThisGlobal(ctx);

    // Third pass: compile function bodies
    compileDeclarations(ctx, ast.sourceFile);

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
      const selection = planIrCompilation(ast.sourceFile, { experimentalIR: true, trackFallbacks }, typeMap);
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
          // at `formatIrPathFallbackDiagnostic` below). Defaulting to "error"
          // would fail every program with a class-typed cross-function return
          // that the IR lowerer can't yet represent (e.g. a `Builder` chain).
          //
          // #2137 — also record this on the structured `irPostClaimErrors`
          // channel (kind "resolve") so consumers (bridge tests, the
          // check:ir-fallbacks gate) can query IR-path fallbacks without
          // string-matching the diagnostics array. The warning line below is
          // retained one sprint for back-compat.
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
      const safeSelection = {
        funcs: new Set<string>([...selection.funcs].filter((n) => overrideMap.has(n))),
        classMembers: selection.classMembers,
      };
      // (#2023) The IR `new C(...)` lowering does not thread the new.target
      // class-id (that machinery lives only on the legacy path). When the
      // program uses `new.target`, route every function through legacy so the
      // outermost-`new` global is set/restored at each construction site. This
      // is a coarse but safe gate — `new.target` is rare, so the perf cost is
      // negligible and it avoids a parallel IR implementation of the threading.
      if (ctx.usesNewTarget) {
        safeSelection.funcs.clear();
        safeSelection.classMembers = new Set();
      }
      const report = compileIrPathFunctions(ctx, ast.sourceFile, safeSelection, overrideMap, classShapes);
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
        // #1858 C4: keep the leading "IR path failed for …" text intact — many
        // bridge tests filter on `e.message.startsWith("IR path failed")` — but
        // append a concise, greppable `[IR-FALLBACK]` tag so a regression in the
        // fallback rate is visible in logs/CI even when the diagnostic is
        // demoted to severity-"warning". #1850 promotes verifier failures in
        // test/CI builds by prefixing the same diagnostic with `Codegen error:`.
        ctx.errors.push({
          message: diag.message,
          line: 0,
          column: 0,
          severity: diag.severity,
        });
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

    // (#2038, reserve-then-fill #1719) Rebuild the native `__iterator` /
    // `__iterator_next` carrier bodies with the USER `{next()}`-protocol arm now
    // that the closed-struct dispatchers exist: `__sget_value`/`__sget_done`
    // (emitStructFieldGetters, above) and `__call_@@iterator`/`__call_next`
    // (emitIteratorMethodExport, just above). No-op unless the standalone native
    // iterator runtime was registered AND a custom iterable produced those
    // dispatchers — otherwise the carrier stays vec-only and byte-identical.
    if (
      ctx.nativeIteratorUserArmPending &&
      ctx.funcMap.has("__call_@@iterator") &&
      ctx.funcMap.has("__call_next") &&
      ctx.funcMap.has("__sget_value") &&
      ctx.funcMap.has("__sget_done") &&
      !ctx.funcMap.has("__is_truthy")
    ) {
      // The USER `done` flag needs `__is_truthy` (ToBoolean on the boxed bool).
      // `emitStructFieldGetters` usually registers it via `addUnionImports` when a
      // `{value,done}` bucket boxes, but force it here for the rare bucket shape
      // that does not, so the fill never silently degrades to vec-only.
      // Native in standalone/WASI (appends funcs, no funcIdx shift).
      addUnionImports(ctx);
    }
    fillNativeIteratorUserArms(ctx);

    // (#1716) Emit __call_@@toPrimitive(self, hint) for runtime ToPrimitive
    // dispatch of a class's [Symbol.toPrimitive] *method* on opaque structs.
    emitToPrimitiveMethodExport(ctx);

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

    // (#1904) Fill the standalone native Array.isArray predicate after all
    // module-local array carriers have been registered.
    fillExternIsArray(ctx);

    // #1504: emit __is_closure(externref) -> i32 so the JS-side wrapExports
    // can discriminate a closure struct return from a vec/struct return
    // (necessary because __vec_len returns 0 for both empty arrays and
    // non-vec structs — JS cannot tell them apart without this probe).
    emitIsClosureExport(ctx);

    // #1896: teach standalone __typeof_function/__typeof_object to recognise
    // closure wrapper structs (closures registered after the typeof helpers were
    // synthesised mid-compile). Edits the helper bodies in place — no funcIdx churn.
    fillStandaloneTypeofClosureArms(ctx);

    // Emit __call_toString/__call_valueOf exports for ToPrimitive dispatch (#866)
    emitToPrimitiveMethodExports(ctx);

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
    markLeafStructsFinal(mod, ctx.wasi);

    // Dead import and type elimination pass
    eliminateDeadImports(mod);

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
  const leaks = scanForLeakedHostImports(mod.imports);
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
    const funcArrayIdx = mainIdx - ctx.numImportFuncs;
    if (funcArrayIdx >= 0 && funcArrayIdx < ctx.mod.functions.length) {
      const func = ctx.mod.functions[funcArrayIdx]!;
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

    // #1326c Phase 1C-A — auto-drain the microtask queue after the entry
    // function returns. Only emits the call when the async scheduler
    // actually registered the queue helpers; otherwise leaves the body
    // unchanged (no perf cost for modules that never schedule microtasks).
    const drainFuncIdx = getDrainFuncIdxForWasiStart(ctx);
    if (drainFuncIdx !== null) {
      body.push({ op: "call", funcIdx: drainFuncIdx });
    }

    ctx.mod.functions.push({
      name: "_start",
      typeIdx: startTypeIdx,
      locals: [],
      body,
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
    // (`fillNativeIteratorUserArms`). No other code looks `__sget_*` up by funcMap
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

  // Setter signatures: 3 variants by val type.
  // Mixed-kind buckets are skipped — sidecar carries the write instead.
  const setterExternTypeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [], "$sset_extern_type");
  const setterF64TypeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [], "$sset_f64_type");
  const setterI32TypeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [], "$sset_i32_type");

  // Only kinds we can emit a correct `struct.set` for after the externref →
  // anyref convert. Abstract heap types other than `anyref` (eqref / structref /
  // funcref) would need a `ref.cast` to an abstract heap type, which the
  // current Instr encoding does not express — skip those buckets so the
  // sidecar still carries the write.
  const isRefKind = (k: ValType["kind"]) =>
    k === "ref" || k === "ref_null" || k === "anyref" || k === "externref" || k === "ref_extern";

  for (const [fieldName, entries] of fieldMap) {
    const allF64 = entries.every((e) => e.fieldType.kind === "f64");
    const allI32 = entries.every((e) => e.fieldType.kind === "i32");
    const allRef = entries.every((e) => isRefKind(e.fieldType.kind));

    // Skip mixed-kind buckets or any bucket containing kinds we can't
    // route through one of the three setter signatures (i64 / f32 / v128
    // / packed i8/i16). The sidecar still carries those writes.
    if (!allF64 && !allI32 && !allRef) continue;

    let setterTypeIdx: number;
    let valMode: "extern" | "f64" | "i32";
    if (allF64) {
      setterTypeIdx = setterF64TypeIdx;
      valMode = "f64";
    } else if (allI32) {
      setterTypeIdx = setterI32TypeIdx;
      valMode = "i32";
    } else {
      setterTypeIdx = setterExternTypeIdx;
      valMode = "extern";
    }

    const funcName = `__sset_${fieldName}`;
    const funcIdx = ctx.numImportFuncs + mod.functions.length;
    const anyLocal = 2; // locals after the two params (local 0 = obj, local 1 = val)

    const funcBody = buildSetterNestedIfElse(entries, anyLocal, valMode);

    mod.functions.push({
      name: funcName,
      typeIdx: setterTypeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
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
  entries: { typeIdx: number; fieldIdx: number; fieldType: ValType; shapeId?: number; shapeFieldIdx?: number }[],
  anyLocal: number,
  valMode: "extern" | "f64" | "i32",
): Instr[] {
  const body: Instr[] = [];

  // Convert obj externref to anyref and store
  body.push({ op: "local.get", index: 0 } as Instr);
  body.push({ op: "any.convert_extern" } as Instr);
  body.push({ op: "local.set", index: anyLocal } as Instr);

  // Chain: if (ref.test T1) { cast + struct.set T1 } else if (ref.test T2) { ... }
  let current: Instr[] = []; // final else: no-op

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    let thenBranch = buildSetterStore(entry, anyLocal, valMode);

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
  return body;
}

/** Build the "then" branch that stores `val` (local 1) into a struct field. */
function buildSetterStore(
  entry: { typeIdx: number; fieldIdx: number; fieldType: ValType },
  anyLocal: number,
  valMode: "extern" | "f64" | "i32",
): Instr[] {
  const then: Instr[] = [];
  const ft = entry.fieldType;

  // Push the cast struct ref onto the stack
  then.push({ op: "local.get", index: anyLocal } as Instr);
  then.push({ op: "ref.cast", typeIdx: entry.typeIdx } as Instr);

  // Push the value (already typed per valMode) — since we only emit setters
  // for homogeneous-kind buckets, valMode and ft.kind line up.
  then.push({ op: "local.get", index: 1 } as Instr);

  if (valMode === "extern") {
    // Field kinds are restricted by isRefKind above to: ref / ref_null /
    // anyref / externref / ref_extern. externref & ref_extern need no
    // conversion; everything else converts externref → anyref first, then
    // typed-ref fields cast down to the field's specific heap type. Cast
    // failures trap; the runtime _safeSet wraps the setter call in
    // try/catch so a wrong-type assign degrades to sidecar-only (the
    // prior behaviour) rather than crashing.
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
    const shapeKey = typeParts.join("|");
    let group = byShape.get(shapeKey);
    if (!group) {
      group = [];
      byShape.set(shapeKey, group);
    }
    group.push({ structName, typeIdx, names });
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
    if (names.length > 0) legacyEntries.push({ typeIdx, names });
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

      const funcDef = mod.functions[funcIdx - ctx.numImportFuncs];
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
    // (`fillNativeIteratorUserArms`). Harmless for the host/GC path — no other
    // code looks these up by funcMap key.
    ctx.funcMap.set(exportName, funcIdx);
  };

  emitMethodDispatch("@@iterator", "__call_@@iterator");
  emitMethodDispatch("next", "__call_next");
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
  const entries: { typeIdx: number; funcIdx: number; resultType: ValType }[] = [];

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

    const funcDef = mod.functions[funcIdx - ctx.numImportFuncs];
    const funcType = funcDef ? mod.types[funcDef.typeIdx] : undefined;
    const resultType: ValType =
      funcType && funcType.kind === "func" && funcType.results.length > 0
        ? funcType.results[0]!
        : { kind: "externref" };

    // The hint param is param[1] (param[0] is `self`). Only forward when it is
    // an externref; skip nativeStrings string-ref params (see doc comment).
    const hintParamType =
      funcType && funcType.kind === "func" && funcType.params.length > 1 ? funcType.params[1] : undefined;
    if (hintParamType !== undefined && hintParamType.kind !== "externref") continue;

    entries.push({ typeIdx, funcIdx, resultType });
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
      { op: "local.get", index: 1 } as Instr, // hint (externref)
      { op: "call", funcIdx: entry.funcIdx } as Instr,
    ];

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
    const setupInstrs: Instr[] = [
      { op: "i32.const", value: arity } as Instr,
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

    const callBody: Instr[] = [
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
/**
 * Collect the deduped set of closure base-wrapper struct type indices from
 * `ctx.closureInfoByTypeIdx`. Concrete closure subtypes (with captures) share
 * their funcref signature with the base wrapper post-V8 canonicalisation, so a
 * `ref.test` against the base catches all of them. Walks each registered
 * closure struct up to its root (superTypeIdx === -1). (#1896 — shared by
 * `emitIsClosureExport` and the standalone `__typeof_function`/`__typeof_object`
 * closure-recognition arms.)
 */
function collectClosureBaseWrapperTypeIdxs(ctx: CodegenContext): number[] {
  const mod = ctx.mod;
  const baseTypeIdxs: number[] = [];
  const seenBase = new Set<number>();
  for (const [typeIdx, info] of ctx.closureInfoByTypeIdx) {
    if (!info) continue;
    const typeDef = mod.types[typeIdx];
    if (!typeDef || typeDef.kind !== "struct") continue;
    // Walk up to the root struct in the chain.
    let root = typeIdx;
    let cur = typeDef;
    while (cur && cur.kind === "struct" && cur.superTypeIdx !== undefined && cur.superTypeIdx >= 0) {
      const superIdx: number = cur.superTypeIdx;
      const parent = mod.types[superIdx];
      if (!parent || parent.kind !== "struct") break;
      root = superIdx;
      cur = parent;
    }
    if (!seenBase.has(root)) {
      seenBase.add(root);
      baseTypeIdxs.push(root);
    }
  }
  return baseTypeIdxs;
}

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
  // arm returns `matchValue` on hit. Caller supplies the param→anyref local.
  const closureTestArms = (anyLocalIdx: number, matchValue: number): Instr[] => {
    const arms: Instr[] = [];
    for (const t of baseTypeIdxs) {
      arms.push({ op: "local.get", index: anyLocalIdx } as Instr);
      arms.push({ op: "ref.test", typeIdx: t } as Instr);
      arms.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: matchValue } as Instr, { op: "return" } as Instr],
      } as Instr);
    }
    return arms;
  };

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
      ...closureTestArms(1, 1),
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
      b.splice(lastIdx, 0, ...closureTestArms(1, 0));
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
      const preferClosure = ctx.toPrimitiveForkedStructs.has(structName);
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
        // eqref field — try tracked closure types (typed object-literal methods).
        if (!pushedClosure && field.type.kind === "eqref") {
          const trackedTypes = ctx.valueOfClosureTypes.get(structName) ?? [];
          for (const closureTypeIdx of trackedTypes) {
            const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
            if (closureInfo && closureInfo.paramTypes.length === 0) {
              entries.push({ structName, typeIdx, mode: "closure", fieldIdx, closureTypeIdx, closureInfo });
              pushedClosure = true;
              break;
            }
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
        const funcDef = mod.functions[funcIdx - ctx.numImportFuncs];
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
          // externref field → anyref → eqref scratch
          { op: "any.convert_extern" } as Instr,
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
    const hasClosureEntry = entries.some((e) => e.mode === "closure" || e.mode === "closure-extern");
    const locals: { name: string; type: ValType }[] = [{ name: "__any", type: { kind: "anyref" } }];
    if (hasClosureEntry) {
      locals.push({ name: "__closure", type: { kind: "eqref" } });
    }

    const body: Instr[] = [
      { op: "local.get", index: 0 } as Instr,
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: anyLocal } as Instr,
      ...buildDispatch(0),
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
    ctx.vecTypeMap.size === 0
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
    for (let i = vecEntries.length - 1; i >= 0; i--) {
      const [elemKey, vecTypeIdx] = vecEntries[i]!;
      const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
      if (arrTypeIdx < 0) continue;
      // Skip numeric element types if __box_number is not available
      if (
        (elemKey === "f64" || elemKey === "i32" || elemKey === "i32_byte" || elemKey === "i8_byte") &&
        boxNumIdx === undefined
      )
        continue;

      // Inline boxing: avoid calling addUnionImports late
      let boxInstrs: Instr[];
      if (elemKey === "externref") {
        boxInstrs = [];
      } else if (elemKey === "f64" && boxNumIdx !== undefined) {
        boxInstrs = [{ op: "call", funcIdx: boxNumIdx } as Instr];
      } else if (elemKey === "i32" && boxNumIdx !== undefined) {
        boxInstrs = [{ op: "f64.convert_i32_s" } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr];
      } else if ((elemKey === "i32_byte" || elemKey === "i8_byte") && boxNumIdx !== undefined) {
        // ArrayBuffer/DataView byte elements (i32, unsigned 0-255) — convert unsigned then box
        boxInstrs = [{ op: "f64.convert_i32_u" } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr];
      } else if (elemKey === "i64") {
        // i64 (BigInt) is a value type, not a ref type — extern.convert_any expects anyref.
        // Convert i64 -> f64 (lossy for large values) then box, or drop and return null.
        if (boxNumIdx !== undefined) {
          boxInstrs = [{ op: "f64.convert_i64_s" } as Instr, { op: "call", funcIdx: boxNumIdx } as Instr];
        } else {
          boxInstrs = [{ op: "drop" } as Instr, { op: "ref.null.extern" } as Instr];
        }
      } else {
        boxInstrs = [{ op: "extern.convert_any" } as Instr];
      }
      const thenBranch: Instr[] = [
        // ref.cast to vec type, struct.get data array, then array.get with index
        { op: "local.get", index: 2 } as Instr,
        { op: "ref.cast", typeIdx: vecTypeIdx } as Instr,
        { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 } as Instr,
        { op: "local.get", index: 1 } as Instr, // index
        { op: elemKey === "i8_byte" ? "array.get_u" : "array.get", typeIdx: arrTypeIdx } as Instr,
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

    mod.functions.push({
      name: "__vec_get",
      typeIdx: getTypeIdx,
      locals: [{ name: "__any", type: { kind: "anyref" } }],
      body,
      exported: true,
    } as any);
    mod.exports.push({
      name: "__vec_get",
      desc: { kind: "func", index: getFuncIdx },
    });
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
    mod.functions.push({
      name: "__vec_push",
      typeIdx: pushTypeIdx,
      locals,
      body,
      exported: true,
    } as any);
    mod.exports.push({ name: "__vec_push", desc: { kind: "func", index: pushFuncIdx } });
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
      const boxInstrs: Instr[] =
        elemKey === "externref"
          ? []
          : elemKey === "f64"
            ? [{ op: "call", funcIdx: boxNumIdx2! } as Instr]
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
        { op: "array.get", typeIdx: arrTypeIdx } as Instr,
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
    mod.functions.push({
      name: "__vec_pop",
      typeIdx: popTypeIdx,
      locals,
      body,
      exported: true,
    } as any);
    mod.exports.push({ name: "__vec_pop", desc: { kind: "func", index: popFuncIdx } });
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
    } else if (elemKey === "i32" || elemKey === "i32_byte") {
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
    const idx = exp.desc.index - ctx.numImportFuncs;
    if (idx < 0 || idx >= mod.functions.length) continue;
    const fn = mod.functions[idx]!;
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
          { op: "array.get", typeIdx: arrTypeIdx },
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
      for (const libSf of multiAst.program.getSourceFiles()) {
        const baseName = libSf.fileName.split("/").pop() ?? libSf.fileName;
        if (baseName.startsWith("lib.") && baseName.endsWith(".d.ts")) {
          collectExternDeclarations(ctx, libSf);
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

    // Emit exported struct field getter helpers for the runtime (mirrors
    // generateModule path — #1308 surfaced that multi-source projects
    // were missing these export emits).
    emitStructFieldGetters(ctx);
    emitStructFieldSetters(ctx);

    // Emit __vec_get / __vec_len exports for runtime iterator fallback.
    emitVecAccessExports(ctx);

    // Emit __dv_byte_{len,get,set} exports for DataView host runtime.
    emitDataViewByteExports(ctx);

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

    // #1896: teach standalone __typeof_function/__typeof_object to recognise
    // closure wrapper structs (edits helper bodies in place — no funcIdx churn).
    fillStandaloneTypeofClosureArms(ctx);

    // Emit __call_toString/__call_valueOf exports for ToPrimitive dispatch.
    emitToPrimitiveMethodExports(ctx);

    // (#1716) Emit __call_@@toPrimitive(self, hint) for runtime ToPrimitive
    // dispatch of a class's [Symbol.toPrimitive] *method* on opaque structs.
    emitToPrimitiveMethodExport(ctx);

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
    markLeafStructsFinal(mod, ctx.wasi);

    // Dead import and type elimination pass
    eliminateDeadImports(mod);

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
  ctx.mod.memories.push({ min: 3 });
  // WASI requires the memory to be exported as "memory"
  ctx.mod.exports.push({ name: "memory", desc: { kind: "memory", index: 0 } });

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
  // #1482: process.env.X access — register environ_get / environ_sizes_get +
  // the JS-polyfill fast-path host import.
  let needsEnviron = false;
  // (#1483) Detect Date.now / performance.now / new Date() — all routed to
  // WASI clock_time_get under --target wasi.
  let needsClockTimeGet = false;
  let needsFdRead = false;

  // ctx.wasiNodeFsFuncs is populated from the original source before import preprocessing
  // (see detectNodeFsImports in compiler.ts)
  const needsPathOpen = ctx.wasiNodeFsFuncs.has("writeFileSync");

  function visit(node: ts.Node) {
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
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text;
      if (callee === "setTimeout" || callee === "setInterval" || callee === "setImmediate") {
        needsPollOneoff = true;
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
    forEachChild(node, visit);
  }
  forEachChild(sourceFile, visit);

  // writeFileSync also needs fd_write for the actual file data write
  if (needsPathOpen) needsFdWrite = true;

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
  if (needsFdWrite) {
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
      { op: "i64.const", value: 32n } as unknown as Instr,
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
      { op: "i64.const", value: 1000000n } as unknown as Instr,
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
      { op: "i64.const", value: 1000n } as unknown as Instr, // precision = 1us
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
  // iovec at memory[0]: { buf_ptr: i32, buf_len: i32 }
  // nwritten at memory[8]
  const body: Instr[] = [
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
  // iovec at memory[0]: { buf_ptr: i32, buf_len: i32 }
  // nwritten at memory[8]
  const body: Instr[] = [
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
const WASI_WRITE_SCRATCH_START = 128 * 1024;

/**
 * #1886 Slice B — start of the linear-backed `Uint8Array` arena (page 4,
 * 256 KiB). It sits above the page-2 write scratch with page 3 left as a guard,
 * so a proven-I/O-only buffer never aliases the iovec scratch, string-literal
 * data, the stdin buffer, or the write scratch. The arena grows on demand via
 * `memory.grow` in `__lin_u8_alloc`.
 */
const LINEAR_U8_ARENA_START = 256 * 1024;

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

  if (!ctx.wasi || ctx.wasiFdWriteIdx === undefined || ctx.nativeStrTypeIdx < 0) return -1;

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

  // param: s(0); locals: flat(1), len(2), off(3), data(4), i(5), o(6),
  // needPages(7), cu(8), cp(9), lo(10)
  const S = 0;
  const FLAT = 1;
  const LEN = 2;
  const OFF = 3;
  const DATA = 4;
  const I = 5;
  const O = 6;
  const NEED_PAGES = 7;
  const CU = 8;
  const CP = 9;
  const LO = 10;

  const funcTypeIdx = addFuncType(ctx, [{ kind: "ref", typeIdx: anyStrTypeIdx }], []);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set(helperName, funcIdx);

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

  const body: Instr[] = [
    // flat = __str_flatten(s)
    { op: "local.get", index: S } as Instr,
    { op: "call", funcIdx: flattenIdx } as Instr,
    { op: "local.set", index: FLAT } as Instr,

    // len = flat.len (field 0)
    { op: "local.get", index: FLAT } as Instr,
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 } as Instr,
    { op: "local.set", index: LEN } as Instr,

    // #1723/#1470: grow linear memory if the staging buffer could overflow.
    // UTF-8/WTF-8 needs at most 3 bytes per UTF-16 code unit: BMP scalars and
    // lone surrogates are 1..3 bytes, while a surrogate pair is 4 bytes across
    // two code units. The final fd_write length is the actual output cursor O.
    //
    //   neededPages = ceil((WASI_WRITE_SCRATCH_START + len*3) / 65536)
    //
    // ceil(x / 65536) == (x + 65535) >> 16. We `i32.shr_u` so a large length
    // near 2^31 still computes a non-negative page count.
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

            // If cu is a high surrogate and the next code unit is a low
            // surrogate, combine them into one scalar and consume the low unit.
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

    // iovec.buf = SCRATCH_START at memory[0]
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr,
    { op: "i32.store", align: 2, offset: 0 } as Instr,
    // iovec.buf_len = actual UTF-8 byte length at memory[4]
    { op: "i32.const", value: 4 } as Instr,
    { op: "local.get", index: O } as Instr,
    { op: "i32.store", align: 2, offset: 0 } as Instr,
    // fd_write(fd, iovs=0, iovs_len=1, nwritten=8)
    { op: "i32.const", value: fd } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.const", value: 8 } as Instr,
    { op: "call", funcIdx: ctx.wasiFdWriteIdx } as Instr,
    { op: "drop" } as Instr,
  ];

  ctx.mod.functions.push({
    name: helperName,
    typeIdx: funcTypeIdx,
    locals: [
      { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
      { name: "len", type: { kind: "i32" } },
      { name: "off", type: { kind: "i32" } },
      { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
      { name: "i", type: { kind: "i32" } },
      { name: "o", type: { kind: "i32" } },
      { name: "needPages", type: { kind: "i32" } },
      { name: "cu", type: { kind: "i32" } },
      { name: "cp", type: { kind: "i32" } },
      { name: "lo", type: { kind: "i32" } },
    ],
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
  if (!ctx.wasi || ctx.wasiFdWriteIdx === undefined) return -1;
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

    // iovec.buf = SCRATCH_START at memory[0]
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr,
    { op: "i32.store", align: 2, offset: 0 } as Instr,
    // iovec.buf_len = len at memory[4]
    { op: "i32.const", value: 4 } as Instr,
    { op: "local.get", index: LEN } as Instr,
    { op: "i32.store", align: 2, offset: 0 } as Instr,
    // fd_write(fd, iovs=0, iovs_len=1, nwritten=8)
    { op: "i32.const", value: fd } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.const", value: 8 } as Instr,
    { op: "call", funcIdx: ctx.wasiFdWriteIdx } as Instr,
    { op: "drop" } as Instr,
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
 * `ArrayBuffer` is lowered to a vec struct of i32 bytes (one byte per
 * element, values 0..255 — see dataview-native.ts comment block) rather than
 * the Uint8Array f64-element shape. The element conversion is therefore a
 * direct i32 read (no `i32.trunc_sat_f64_s`).
 */
export function ensureWasiWriteArrayBufferHelper(
  ctx: CodegenContext,
  vecTypeIdx: number,
  useStderr: boolean = false,
): number {
  const helperName = useStderr ? "__wasi_write_arraybuffer_stderr" : "__wasi_write_arraybuffer";
  const existing = ctx.funcMap.get(helperName);
  if (existing !== undefined) return existing;

  if (!ctx.wasi || ctx.wasiFdWriteIdx === undefined) return -1;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  if (arrTypeIdx < 0) return -1;

  const fd = useStderr ? 2 : 1;

  // param: buf(0); locals: len(1), data(2), i(3), needPages(4)
  const BUF = 0;
  const LEN = 1;
  const DATA = 2;
  const I = 3;
  const NEED_PAGES = 4;

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

            // value = data[i] (i32; low byte kept by i32.store8)
            { op: "local.get", index: DATA } as Instr,
            { op: "local.get", index: I } as Instr,
            { op: "array.get", typeIdx: arrTypeIdx } as Instr,

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

    // iovec.buf = SCRATCH_START at memory[0]
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.const", value: WASI_WRITE_SCRATCH_START } as Instr,
    { op: "i32.store", align: 2, offset: 0 } as Instr,
    // iovec.buf_len = len at memory[4]
    { op: "i32.const", value: 4 } as Instr,
    { op: "local.get", index: LEN } as Instr,
    { op: "i32.store", align: 2, offset: 0 } as Instr,
    // fd_write(fd, iovs=0, iovs_len=1, nwritten=8)
    { op: "i32.const", value: fd } as Instr,
    { op: "i32.const", value: 0 } as Instr,
    { op: "i32.const", value: 1 } as Instr,
    { op: "i32.const", value: 8 } as Instr,
    { op: "call", funcIdx: ctx.wasiFdWriteIdx } as Instr,
    { op: "drop" } as Instr,
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
    { op: "i64.const", value: 0n } as unknown as Instr,
    { op: "i64.store", align: 3, offset: 0 } as unknown as Instr,

    // tag @ 72 = 0 (i8 EVENTTYPE_CLOCK) — store 0 over 8 bytes covers tag + pad
    { op: "i32.const", value: SUB_OFFSET + 8 } as Instr,
    { op: "i64.const", value: 0n } as unknown as Instr,
    { op: "i64.store", align: 3, offset: 0 } as unknown as Instr,

    // clockid @ 80 = 1 (CLOCK_MONOTONIC), pad @ 84 = 0 — combined as i64
    { op: "i32.const", value: SUB_OFFSET + 16 } as Instr,
    { op: "i64.const", value: 1n } as unknown as Instr,
    { op: "i64.store", align: 3, offset: 0 } as unknown as Instr,

    // timeout @ 88 = (i64) ms * 1_000_000
    { op: "i32.const", value: SUB_OFFSET + 24 } as Instr,
    { op: "local.get", index: 0 } as Instr,
    { op: "i64.extend_i32_u" } as unknown as Instr,
    { op: "i64.const", value: 1000000n } as unknown as Instr,
    { op: "i64.mul" } as unknown as Instr,
    { op: "i64.store", align: 3, offset: 0 } as unknown as Instr,

    // precision @ 96 = 0
    { op: "i32.const", value: SUB_OFFSET + 32 } as Instr,
    { op: "i64.const", value: 0n } as unknown as Instr,
    { op: "i64.store", align: 3, offset: 0 } as unknown as Instr,

    // flags @ 104 = 0 (u16, relative), plus pad — clear 8 bytes
    { op: "i32.const", value: SUB_OFFSET + 40 } as Instr,
    { op: "i64.const", value: 0n } as unknown as Instr,
    { op: "i64.store", align: 3, offset: 0 } as unknown as Instr,

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
      if (isNumberType(receiverType) && methodName === "toFixed") {
        needed.add("number_toFixed");
      }
      if (isNumberType(receiverType) && methodName === "toPrecision") {
        needed.add("number_toPrecision");
      }
      if (isNumberType(receiverType) && methodName === "toExponential") {
        needed.add("number_toExponential");
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
      if (isStringType(receiverType) && Object.prototype.hasOwnProperty.call(STRING_METHODS, methodName)) {
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
      if (!newImportNames.has(name) && idx >= importsBefore) {
        ctx.funcMap.set(name, idx + delta);
      }
    }
    for (const exp of ctx.mod.exports) {
      if (exp.desc.kind === "func" && exp.desc.index >= importsBefore) {
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
        if ((instr.op === "call" || instr.op === "return_call") && instr.funcIdx >= importsBefore) {
          instr.funcIdx += delta;
        }
        if (instr.op === "ref.func" && instr.funcIdx >= importsBefore) {
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
          if (elem.funcIndices[i]! >= importsBefore) {
            elem.funcIndices[i]! += delta;
          }
        }
      }
    }
    if (ctx.mod.declaredFuncRefs.length > 0) {
      ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map((idx) => (idx >= importsBefore ? idx + delta : idx));
    }
    // (#1525b) Shift pendingMethodTrampolines side-channel indices in lockstep
    // — see the matching block in addUnionImports / shiftLateImportIndices.
    for (const t of ctx.pendingMethodTrampolines) {
      if (t.methodFuncIdx >= importsBefore) t.methodFuncIdx += delta;
      if (t.trampolineFuncIdx >= importsBefore) t.trampolineFuncIdx += delta;
    }
    // (#1839) `nativeStrHelpers` is read directly by string-lowering call sites
    // and helper emitters — it is NOT a copy of funcMap, so it must be shifted
    // on its own. All entries are defined functions (>= numImportFuncs), so
    // every entry >= importsBefore moves up by `delta`. Omitting this left the
    // map stale under plain `--nativeStrings` JS-host mode.
    for (const [name, idx] of ctx.nativeStrHelpers) {
      if (idx >= importsBefore) {
        ctx.nativeStrHelpers.set(name, idx + delta);
      }
    }
    // (#1913) Regex helper map moves in lockstep too — regexp-standalone call
    // sites bake `call` indices straight from this map.
    for (const [name, idx] of ctx.nativeRegexHelpers) {
      if (idx >= importsBefore) {
        ctx.nativeRegexHelpers.set(name, idx + delta);
      }
    }
    // (#2039 slice 2) Re-base so reconcileNativeStrFinalizeShift doesn't apply
    // the same `delta` a second time — this inline shift already repaired the
    // helper bodies and the map. Matches addUnionImports (#1677-fast-path) and
    // shiftLateImportIndices.
    if (ctx.nativeStrHelperImportBase >= 0) {
      ctx.nativeStrHelperImportBase = ctx.numImportFuncs;
    }
    // (#1839) The module start function index also moves if it was a defined
    // function at or above the insertion point. Matches addUnionImports.
    if (ctx.mod.startFuncIdx !== undefined && ctx.mod.startFuncIdx >= importsBefore) {
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
      "__box_bigint",
      "__to_bigint",
      "__bigint_ctor",
      "__typeof",
    ]);
    // Update funcMap entries for defined functions (not imports)
    for (const [name, idx] of ctx.funcMap) {
      if (!newImportNames.has(name) && idx >= importsBefore) {
        ctx.funcMap.set(name, idx + delta);
      }
    }
    // Update export indices
    for (const exp of ctx.mod.exports) {
      if (exp.desc.kind === "func" && exp.desc.index >= importsBefore) {
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
        if ((instr.op === "call" || instr.op === "return_call") && instr.funcIdx >= importsBefore) {
          instr.funcIdx += delta;
        }
        if (instr.op === "ref.func" && instr.funcIdx >= importsBefore) {
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
          if (elem.funcIndices[i]! >= importsBefore) {
            elem.funcIndices[i]! += delta;
          }
        }
      }
    }
    // Update declaredFuncRefs
    if (ctx.mod.declaredFuncRefs.length > 0) {
      ctx.mod.declaredFuncRefs = ctx.mod.declaredFuncRefs.map((idx) => (idx >= importsBefore ? idx + delta : idx));
    }
    // Update Wasm start function index (#907) — late-added imports shift the
    // defined-function index that __module_init lives at.
    if (ctx.mod.startFuncIdx !== undefined && ctx.mod.startFuncIdx >= importsBefore) {
      ctx.mod.startFuncIdx += delta;
    }
    // Sync nativeStrHelpers and re-base so reconcileNativeStrFinalizeShift is a no-op
    // for this import batch — the inline shiftFuncIndices above already corrected all
    // native-string helper bodies. Without this, reconcile double-shifts them (#1677-fast-path).
    if (ctx.nativeStrHelperImportBase >= 0) {
      for (const [name, idx] of ctx.nativeStrHelpers) {
        if (idx >= importsBefore) ctx.nativeStrHelpers.set(name, idx + delta);
      }
      // (#1913) Regex helper map shares the same lifecycle.
      for (const [name, idx] of ctx.nativeRegexHelpers) {
        if (idx >= importsBefore) ctx.nativeRegexHelpers.set(name, idx + delta);
      }
      ctx.nativeStrHelperImportBase = ctx.numImportFuncs;
    }
    // (#1525b) Shift pendingMethodTrampolines side-channel indices in lockstep.
    // The captured methodFuncIdx / trampolineFuncIdx are plain numbers not
    // reachable from any Instr — without this, finalizeMethodTrampolines later
    // resolves the wrong (import) signature, producing invalid Wasm.
    for (const t of ctx.pendingMethodTrampolines) {
      if (t.methodFuncIdx >= importsBefore) t.methodFuncIdx += delta;
      if (t.trampolineFuncIdx >= importsBefore) t.trampolineFuncIdx += delta;
    }
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

  // 12. __typeof_undefined(externref) -> i32 — `ref.is_null`.
  registerNative("__typeof_undefined", externrefToI32, [{ op: "local.get", index: 0 }, { op: "ref.is_null" }]);

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
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
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

  // 15. __typeof(externref) -> externref — returns null externref under
  //     wasi. Producing real type-tag strings would require a NativeString
  //     per tag; defer until a wasi caller needs the typeof RESULT as a
  //     string (today's callers compare against literal tags via the
  //     __typeof_* helpers above).
  registerNative("__typeof", externrefToExternref, [{ op: "ref.null.extern" }]);
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

  // __iterator: (externref) → externref — calls obj[Symbol.iterator]()
  const extToExt = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__iterator", { kind: "func", typeIdx: extToExt });

  // __iterator_next: (externref) → (i32 done, externref value) — calls iter.next()
  // Multi-value result avoids the $IteratorResult struct: a freshly-built WasmGC
  // struct cannot survive the JS import hop (it surfaces as undefined in V8/Node;
  // see #1620 BLOCKED). The two primitives (i32 + externref) cross the JS↔Wasm
  // multi-value ABI cleanly, eliminating __iterator_done / __iterator_value.
  const extToDoneValue = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }, { kind: "externref" }]);
  addImport(ctx, "env", "__iterator_next", {
    kind: "func",
    typeIdx: extToDoneValue,
  });

  // __iterator_return: (externref) → void — calls iter.return() if it exists
  const extToVoid = addFuncType(ctx, [{ kind: "externref" }], []);
  addImport(ctx, "env", "__iterator_return", {
    kind: "func",
    typeIdx: extToVoid,
  });

  // __iterator_rest: (externref) → externref — drains a partially-consumed
  // iterator into a real JS Array for the `[...rest]` binding pattern (#1052).
  addImport(ctx, "env", "__iterator_rest", {
    kind: "func",
    typeIdx: extToExt,
  });
}

/** Register array iterator host imports (entries/keys/values) if not already registered */
export function addArrayIteratorImports(ctx: CodegenContext): void {
  if (ctx.funcMap.has("__array_entries")) return;

  // All three: (externref) → externref — take a vec struct, return a JS iterator
  const extToExt = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__array_entries", { kind: "func", typeIdx: extToExt });
  addImport(ctx, "env", "__array_keys", { kind: "func", typeIdx: extToExt });
  addImport(ctx, "env", "__array_values", { kind: "func", typeIdx: extToExt });
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

  const bufType = addFuncType(ctx, [], [{ kind: "externref" }]);
  addImport(ctx, "env", "__gen_create_buffer", { kind: "func", typeIdx: bufType });

  const pushF64Type = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], []);
  addImport(ctx, "env", "__gen_push_f64", { kind: "func", typeIdx: pushF64Type });

  const pushI32Type = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], []);
  addImport(ctx, "env", "__gen_push_i32", { kind: "func", typeIdx: pushI32Type });

  const pushRefType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], []);
  addImport(ctx, "env", "__gen_push_ref", { kind: "func", typeIdx: pushRefType });

  // __gen_yield_star: (externref, externref) → void  (iterates inner iterable, pushes all values into outer buffer)
  addImport(ctx, "env", "__gen_yield_star", {
    kind: "func",
    typeIdx: pushRefType, // same signature as push_ref: (buf, iterable) → void
  });

  // __gen_set_return: (externref, externref) → void  (#2035 — stashes the
  // generator's `return` value on the buffer instead of pushing it as a yield)
  addImport(ctx, "env", "__gen_set_return", {
    kind: "func",
    typeIdx: pushRefType, // same signature as push_ref: (buf, value) → void
  });

  // __create_generator: (buf: externref, pendingThrow: externref) -> externref
  // Takes a buffer of yielded values and an optional pending exception,
  // returns a Generator-like object that defers the throw to the first next() call.
  const createGenType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__create_generator", { kind: "func", typeIdx: createGenType });
  // __create_async_generator: same Wasm signature as __create_generator, but .next()/.return()/.throw()
  // return Promise-wrapped results as required by the ES spec for async generators.
  addImport(ctx, "env", "__create_async_generator", { kind: "func", typeIdx: createGenType });
  const genType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__gen_next", { kind: "func", typeIdx: genType });

  const genReturnType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__gen_return", { kind: "func", typeIdx: genReturnType });
  addImport(ctx, "env", "__gen_throw", { kind: "func", typeIdx: genReturnType });

  addImport(ctx, "env", "__gen_result_value", { kind: "func", typeIdx: genType });

  const resultValF64Type = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "f64" }]);
  addImport(ctx, "env", "__gen_result_value_f64", { kind: "func", typeIdx: resultValF64Type });

  const resultDoneType = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "env", "__gen_result_done", { kind: "func", typeIdx: resultDoneType });

  // Ensure __get_caught_exception is available for generator body try/catch wrappers
  if (!ctx.funcMap.has("__get_caught_exception")) {
    const getCaughtType = addFuncType(ctx, [], [{ kind: "externref" }]);
    addImport(ctx, "env", "__get_caught_exception", { kind: "func", typeIdx: getCaughtType });
  }
}

/** Register for-in key enumeration host imports if not already registered */
export function addForInImports(ctx: CodegenContext): void {
  // Guard: only register once
  if (ctx.funcMap.has("__for_in_keys")) return;

  // __for_in_keys: (externref) -> externref — returns JS array of enumerable string keys
  const extToExt = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__for_in_keys", { kind: "func", typeIdx: extToExt });

  // __for_in_len: (externref) -> i32 — returns keys.length
  const extToI32 = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "env", "__for_in_len", { kind: "func", typeIdx: extToI32 });

  // __for_in_get: (externref, i32) -> externref — returns keys[i]
  const extI32ToExt = addFuncType(ctx, [{ kind: "externref" }, { kind: "i32" }], [{ kind: "externref" }]);
  addImport(ctx, "env", "__for_in_get", { kind: "func", typeIdx: extI32ToExt });

  // __for_in_has: (externref obj, externref key) -> i32 — per-visit liveness
  // check so a property deleted mid-enumeration is skipped (#2066).
  const extExtToI32 = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "i32" }]);
  addImport(ctx, "env", "__for_in_has", { kind: "func", typeIdx: extExtToI32 });
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

  // Fast mode: string → ref $AnyString (not externref)
  if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0 && isStringType(tsType)) {
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
      const elemWasm: ValType = elemTsType
        ? resolveWasmType(ctx, elemTsType, _depth + 1, _visited)
        : { kind: "externref" };
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

    // Promise<T> → unwrap to T.
    // Async functions are compiled synchronously, so Promise<T> is just T at the Wasm level.
    if (sym?.name === "Promise") {
      const typeArgs = ctx.checker.getTypeArguments(tsType as ts.TypeReference);
      if (typeArgs.length > 0) {
        const inner = typeArgs[0]!;
        if (isVoidType(inner)) return { kind: "externref" }; // Promise<void> → externref (no value)
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

function collectExternDeclarations(ctx: CodegenContext, sourceFile: ts.SourceFile): void {
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
      // Skip node:fs functions — they're handled by dedicated dispatch:
      //   • WASI target → __wasi_*  syscall helpers (#1035)
      //   • non-WASI + allowFs → __node_fs_* JS-host imports (#1491)
      if (ctx.wasiNodeFsFuncs.has(name) && (ctx.wasi || ctx.allowFs)) continue;
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
        const results: ValType[] = isVoidType(retType) ? [] : [mapTsTypeToWasm(retType, ctx.checker)];
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
        const results: ValType[] = isVoidType(retType) ? [] : [mapTsTypeToWasm(retType, ctx.checker)];
        info.methods.set(methodName, { params, results, requiredParams });
      }
    }
    // Property signatures
    if (ts.isPropertySignature(member) && member.name && ts.isIdentifier(member.name)) {
      const propName = member.name.text;
      if (info.properties.has(propName)) continue;
      const propType = ctx.checker.getTypeAtLocation(member);
      const wasmType = mapTsTypeToWasm(propType, ctx.checker);
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
          register("__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
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
  const collectRefs = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) referencedNames.add(node.text);
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
      const importName = `global_${name}`;
      const typeIdx = addFuncType(ctx, [], [{ kind: "externref" }]);
      addImport(ctx, "env", importName, { kind: "func", typeIdx });
      const funcIdx = ctx.funcMap.get(importName);
      if (funcIdx !== undefined) {
        ctx.declaredGlobals.set(name, { type: { kind: "externref" }, funcIdx });
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
    if (!referencedNames.has(name)) continue;
    if (ctx.declaredGlobals.has(name)) continue;
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
      // node-process-api.ts lowers supported stream calls directly to WASI.
      if (builtin.moduleName === "process") continue;
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
const WASI_REJECTED_TIMER_GLOBALS = new Set(["setTimeout", "setInterval", "setImmediate", "queueMicrotask"]);

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
    }
    const wasmType: ValType =
      initForcesExternref || isNullablePrimitiveType(varType)
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

function inferStandaloneRegExpMatchArrayType(
  ctx: CodegenContext,
  initializer: ts.Expression | undefined,
): ValType | null {
  if (!ctx.standalone || !initializer) return null;
  const unwrapped = stripRegExpInferenceWrapper(initializer);
  if (!ts.isCallExpression(unwrapped)) return null;
  if (!ts.isPropertyAccessExpression(unwrapped.expression)) return null;
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

function isStaticRegExpMatchArrayCallForImportScan(ctx: CodegenContext, call: ts.CallExpression): boolean {
  const callee = stripRegExpInferenceWrapper(call.expression);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const method = callee.name.text;
  if (method === "exec") return isStaticRegExpExpressionForInference(ctx, callee.expression);
  if (method === "match" && call.arguments.length === 1) {
    return isStaticRegExpExpressionForInference(ctx, call.arguments[0]!);
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
  return isVecStructType(ctx, receiverType) ? { kind: "ref_null", typeIdx: receiverType.typeIdx } : null;
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
        if (ctx.moduleGlobals.has(name)) continue;
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
        if (initIsAccessorLiteral) {
          ctx.externrefAccessorVars.add(name);
        }
        const wasmType: ValType = initIsAccessorLiteral
          ? { kind: "externref" }
          : isI32Coerced
            ? { kind: "i32" }
            : isNullablePrimitiveType(varType)
              ? { kind: "externref" }
              : (inferLetConstInitializerWasmType(ctx, fctx, decl.initializer) ?? resolveWasmType(ctx, varType));
        allocLocal(fctx, name, wasmType);
        // Only add TDZ flag if static analysis can't prove all accesses are safe
        if (needsTdzFlag(ctx, decl)) {
          if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
          const flagIdx = allocLocal(fctx, `__tdz_${name}`, { kind: "i32" });
          fctx.tdzFlagLocals.set(name, flagIdx);
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
  if (!condType) {
    // Expression compilation failed — push false to keep Wasm valid
    fctx.body.push({ op: "i32.const", value: 0 });
    return;
  }
  if (condType.kind === "f64") {
    // Use f64.abs + f64.gt(0) so that NaN, +0, and -0 are all falsy
    // (f64.ne(0) treats NaN as truthy which is wrong for JS semantics)
    fctx.body.push({ op: "f64.abs" });
    fctx.body.push({ op: "f64.const", value: 0 });
    fctx.body.push({ op: "f64.gt" });
  } else if (condType.kind === "externref") {
    // Use __is_truthy for proper JS truthiness (0, NaN, null, undefined, "" → falsy)
    if (ctx) {
      addUnionImports(ctx);
      const funcIdx = ctx.funcMap.get("__is_truthy");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return;
      }
    }
    // Fallback: non-null → true
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.eqz" });
  } else if (condType.kind === "ref" || condType.kind === "ref_null") {
    // Boxed any value — use __any_unbox_bool for proper JS truthiness
    if (ctx && isAnyValue(condType, ctx)) {
      ensureAnyHelpers(ctx);
      const funcIdx = ctx.funcMap.get("__any_unbox_bool");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return;
      }
    }
    // Native string or struct ref — non-empty string is truthy
    // For strings: check length > 0 via string.measure_utf8 or ref.is_null fallback
    if (ctx && condType.typeIdx === ctx.anyStrTypeIdx) {
      // Native string — check length > 0
      const lengthIdx = ctx.nativeStrHelpers.get("__str_flatten");
      if (lengthIdx !== undefined) {
        // Flatten then check len field
        fctx.body.push({ op: "call", funcIdx: lengthIdx });
        fctx.body.push({
          op: "struct.get",
          typeIdx: ctx.nativeStrTypeIdx,
          fieldIdx: 0,
        }); // len field
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "i32.gt_s" });
        return;
      }
    }
    // Fallback: non-null → true
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.eqz" });
  } else if (condType.kind === "i64") {
    // i64 truthiness: nonzero → true
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
  getOrRegisterTemplateVecType,
  getOrRegisterVecType,
} from "./registry/types.js";
export { compileExpression, compileStatement } from "./shared.js";
