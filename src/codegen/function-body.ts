// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Function body compilation — compileFunctionBody and call-site inlining helpers.
 *
 * Extracted from codegen/index.ts (#1013).
 */
import { ts, forEachChild } from "../ts-api.js";
import { isVoidType, unwrapPromiseType } from "../checker/type-mapper.js";
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { bodyReferencesOwnThis } from "./helpers/body-references-own-this.js";
import { popBody, pushBody } from "./context/bodies.js";
import { reportError } from "./context/errors.js";
import { allocLocal, deduplicateLocals } from "./context/locals.js";
import { attachSourcePos, getSourcePos } from "./context/source-pos.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  buildDestructureNullThrow,
  destructureParamArray,
  destructureParamObject,
  isNullOrUndefinedLiteral,
  structHintForBindingPattern,
} from "./destructuring-params.js";
import {
  cacheStringLiterals,
  hasAsyncModifier,
  hoistLetConstWithTdz,
  hoistVarDeclarations,
  resolveWasmType,
} from "./index.js";
import { ensureExnTag } from "./registry/imports.js";
import { buildTargetTaggedTry } from "../ir/try-table.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  ensureLateImport,
  flushLateImportShifts,
  hoistFunctionDeclarations,
  valTypesMatch,
} from "./shared.js";
import {
  cacheParamDefaultArgc,
  emitF64ParamSentinelCheck,
  emitArgumentsVecBody,
  emitParamDefaultArgMissingCheck,
  paramDefaultNeedsArgc,
} from "./statements/nested-declarations.js";
import { beginNestedFunctionNameScope, endNestedFunctionNameScope } from "./nested-function-name-scope.js"; // (#4456)
import { emitThrowReferenceError } from "./expressions/helpers.js";
import { compileObjectLiteralAsExternref } from "./literals.js";
import { needsImplicitArgumentsObject } from "./helpers/body-uses-arguments.js";
import { shouldRegisterArgumentsWithHost } from "./helpers/arguments-registration.js";
import { seedDeclarationArgumentsCallee } from "./arguments-callee.js"; // (#4243) §10.6 step 13.a
import { isStrictFunction, isSimpleParameterList } from "./helpers/is-strict-function.js";
import { initializeFunctionPoisonPillContext } from "./function-poison-pill.js";
import { detectStringBuilders, type StringBuilderPresizeInfo } from "./string-builder.js";
import { collectI32SpecializedArrays } from "./array-element-typing.js";
// (#3741) `collectI32CoercedLocals` moved out of this file into a pure,
// dependency-free analysis module so the IR front-end can reuse the SAME
// hardened #1120/#1236 proof without importing this emit-heavy module.
// Re-exported here because `codegen/index.ts` and tests import it by this path.
export { collectI32CoercedLocals } from "../ir/analysis/i32-coerced-locals.js";
import { collectI32CoercedLocals } from "../ir/analysis/i32-coerced-locals.js";
import { detectArrayReduceFusion, applyArrayReduceFusion } from "./array-reduce-fusion.js";
import { compileNativeGeneratorFunction } from "./generators-native.js";
import { maybeActivateAsync } from "./async-activation.js";
import { emitAsyncGenerator, isAsyncGenDriveCandidate } from "./async-frame.js";
import {
  functionHasLinearU8Params,
  getLinearU8ParamIndicesForDeclaration,
  registerLinearU8Buffer,
} from "./linear-uint8-signatures.js";
import { containsLinearU8Allocation, emitLinearU8ArenaMark, emitLinearU8ArenaReset } from "./linear-uint8-arena.js";
import { walkInstructions } from "./walk-instructions.js";
import { emitUndefined } from "./expressions/late-imports.js";
import {
  collectDirectEvalActivationBindingNames,
  collectDirectEvalBindingNames,
  functionMayReachDirectEval,
  reifyCurrentDirectEvalBindings,
} from "./direct-eval-environment.js";

/** Maximum number of instructions for a function body to be considered inlinable */
export const INLINE_MAX_INSTRS = 10;

/**
 * (#2121) Per §10.2.11 FunctionDeclarationInstantiation, parameter bindings are
 * initialized left-to-right, so a default value that reads its own parameter or
 * a *later* one observes that binding in the TDZ and must throw ReferenceError.
 * Scan the default initializer of the parameter at `paramIndex` for an
 * identifier naming a parameter at index ≥ `paramIndex`. Returns that name when
 * found (the default would throw if it fired), else undefined. References to
 * strictly-earlier params (e.g. `f(a, b = a)`) are valid and ignored.
 */
function findTdzViolatingParamRef(decl: ts.FunctionLikeDeclarationBase, paramIndex: number): string | undefined {
  // Names of params bound at or after this one (the TDZ window). Skip binding
  // patterns and the `this` pseudo-param — only plain identifier params can be
  // referenced by name and observed in the TDZ here.
  const poisoned = new Set<string>();
  for (let j = paramIndex; j < decl.parameters.length; j++) {
    const p = decl.parameters[j]!;
    if (ts.isIdentifier(p.name) && p.name.text !== "this") poisoned.add(p.name.text);
  }
  if (poisoned.size === 0) return undefined;

  const init = decl.parameters[paramIndex]!.initializer;
  if (!init) return undefined;
  let found: string | undefined;
  const walk = (node: ts.Node): void => {
    if (found) return;
    // Do not descend into nested functions/arrows: a reference to the param
    // there is a closure capture resolved after instantiation, not a TDZ read.
    if (
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      return;
    }
    if (ts.isIdentifier(node) && poisoned.has(node.text)) {
      // Exclude identifiers in non-reference positions (property names, etc.).
      const parent = node.parent;
      if (
        parent &&
        ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          (ts.isPropertyAssignment(parent) && parent.name === node) ||
          (ts.isBindingElement(parent) && parent.propertyName === node))
      ) {
        return;
      }
      found = node.text;
      return;
    }
    forEachChild(node, walk);
  };
  walk(init);
  return found;
}

/**
 * (#1042) Re-point a function to a func type with the same params but a new
 * result list. Func types are interned/shared, so we cannot mutate the existing
 * one in place (that would corrupt every other function with the same shape);
 * instead intern a fresh type and reassign `func.typeIdx`. Used by the async
 * CPS hook to switch an async function's result from its unwrapped value type
 * to `externref` (it returns a Promise object).
 */
/** Set of instruction ops that disqualify a function body from inlining */
export const INLINE_DISALLOWED_OPS = new Set([
  "block",
  "loop",
  "if",
  "br",
  "br_if",
  "try",
  "try_table",
  "throw",
  "rethrow",
  "unreachable",
  "call",
  "call_ref",
  "call_indirect",
  "return_call",
  "return_call_ref",
  "local.set",
  "local.tee",
]);

/**
 * After compiling a function, check if it is eligible for call-site inlining.
 * Criteria:
 * - Body has <= INLINE_MAX_INSTRS instructions
 * - No control flow, calls, or local mutations
 * - No extra locals beyond parameters
 * - Not a rest-param or capture function
 */
/**
 * (#4134) Dump a just-compiled ordinary function body that references locals
 * outside its own frame, with `<<<<` on the offending ops.
 *
 * A `push`-trap on `fctx.body` misses this class entirely: `fctx.body` is
 * REASSIGNED during compilation (the savedBodies swap), so a proxy installed on
 * the initial array stops seeing writes after the first swap. Inspecting the
 * finished body sidesteps that. Enabled by `JS2WASM_FRAME_OPS`.
 */
export const frameSnapshotAtCompile = new Map<WasmFunction, { locals: number; bodyLen: number }>();

export function dumpFrameBreach(ctx: CodegenContext, func: WasmFunction): void {
  if (process.env?.JS2WASM_FRAME_STAGES) {
    frameSnapshotAtCompile.set(func, { locals: func.locals.length, bodyLen: func.body.length });
  }
  if (!process.env?.JS2WASM_FRAME_OPS) return;
  const type = ctx.mod.types[func.typeIdx];
  if (!type || type.kind !== "func") return;
  const frame = type.params.length + func.locals.length;
  const lines: string[] = [];
  let bad = false;
  const walk = (instrs: readonly Instr[], depth: number): void => {
    for (const instr of instrs) {
      const index = (instr as { index?: number }).index;
      const out = typeof index === "number" && index >= frame && instr.op.startsWith("local.");
      if (out) bad = true;
      lines.push(`${"  ".repeat(depth)}${instr.op}${index === undefined ? "" : ` ${index}`}${out ? "   <<<<" : ""}`);
      for (const key of ["body", "then", "else", "catchAll"] as const) {
        const nested = (instr as unknown as Record<string, unknown>)[key];
        if (Array.isArray(nested)) walk(nested as Instr[], depth + 1);
      }
    }
  };
  walk(func.body, 0);
  if (!bad) return;
  process.stderr.write(
    `[js2:fn-breach] ${func.name} frame=${frame} (${type.params.length} params + ${func.locals.length} locals)` +
      ` locals=${func.locals.map((l) => `${l.name}:${l.type.kind}`).join(",")}\n`,
  );
  for (const line of lines) process.stderr.write(`[js2:fn-breach]   ${line}\n`);
}

export function registerInlinableFunction(ctx: CodegenContext, funcName: string, func: WasmFunction): void {
  // Skip functions with rest params or captures
  if (ctx.funcRestParams.has(funcName)) return;
  if (ctx.nestedFuncCaptures.has(funcName)) return;
  if (functionHasLinearU8Params(ctx, funcName)) return;

  const body = func.body;
  if (body.length === 0 || body.length > INLINE_MAX_INSTRS) return;

  // Filter out nop instructions (source position markers)
  const realBody = body.filter((instr) => instr.op !== "nop");
  if (realBody.length === 0 || realBody.length > INLINE_MAX_INSTRS) return;

  // Allow expression-shaped functions to end in a single trailing return.
  const normalizedBody =
    realBody.length > 0 && realBody[realBody.length - 1]?.op === "return" ? realBody.slice(0, -1) : realBody;
  if (normalizedBody.length === 0 || normalizedBody.length > INLINE_MAX_INSTRS) return;

  // Get param count from type definition
  const funcType = ctx.mod.types[func.typeIdx];
  if (!funcType || funcType.kind !== "func") return;
  const paramCount = funcType.params.length;

  // No extra locals beyond params
  if (func.locals.length > 0) return;

  // Check all instructions are safe to inline
  for (const instr of normalizedBody) {
    if (INLINE_DISALLOWED_OPS.has(instr.op)) return;

    // local.get must reference params only (index < paramCount)
    if (instr.op === "local.get") {
      if ((instr as any).index >= paramCount) return;
    }
  }

  // Determine return type from function type
  const returnType = funcType.results.length > 0 ? funcType.results[0]! : null;

  ctx.inlinableFunctions.set(funcName, {
    body: normalizedBody,
    paramCount,
    paramTypes: funcType.params.slice(),
    returnType,
  });
}

function assertDirectAsyncBodyAllowed(name: string, isAsync: boolean): void {
  if (isAsync && process.env.JS2WASM_TEST_POISON_DIRECT_ASYNC_BODY) {
    throw new Error(`direct async body poison reached ${name}`);
  }
}

function assertDirectFunctionBodyAllowed(name: string): void {
  const poisoned = process.env.JS2WASM_TEST_POISON_DIRECT_FUNCTION_BODY;
  if (!poisoned) return;
  const names = new Set(poisoned.split(",").map((candidate) => candidate.trim()));
  if (names.has(name)) {
    throw new Error(`injected direct function-body poison: ${name}`);
  }
}

export function compileFunctionBody(ctx: CodegenContext, decl: ts.FunctionDeclaration, func: WasmFunction): void {
  // Captured-global lookup is scoped to the function body currently being
  // emitted. A preceding module-init pass or sibling function may have
  // promoted a same-named lexical binding, but reusing that name-keyed entry
  // would route this function's object-literal methods to the wrong global.
  // The concrete globals remain in the module; only the short-lived lookup
  // maps are reset before this body's lowering starts.
  ctx.capturedGlobals.clear();
  ctx.capturedGlobalsWidened.clear();
  ctx.capturedBoxGlobals?.clear();
  const sig = ctx.checker.getSignatureFromDeclaration(decl);
  if (!sig) {
    reportError(ctx, decl, `Cannot resolve signature for function '${func.name}'`);
    return;
  }
  const retType = ctx.checker.getReturnTypeOfSignature(sig);

  // (#2182) Defensive balance check for the detached-body funcIdx-shift hazard.
  // Every `ctx.liveBodies.add(...)` during this function's compilation MUST be
  // matched by a `.delete(...)`. A missing delete leaves a stale detached array
  // registered, which a LATER late import would over-shift (silent funcIdx
  // corruption — the #1257 bug class). Snapshot the size here and assert it's
  // restored at the end. Scoped to the delta (not "must be empty") so it never
  // false-positives on a parent body legitimately registered by an enclosing
  // compile while a lifted closure / nested function compiles.
  const liveBodiesAtEntry = ctx.liveBodies.size;

  const isAsync = ctx.asyncFunctions.has(func.name);
  const isGenerator = ctx.generatorFunctions.has(func.name);
  assertDirectAsyncBodyAllowed(func.name, isAsync);
  assertDirectFunctionBodyAllowed(func.name);
  const effectiveRetType = isAsync ? unwrapPromiseType(retType, ctx.checker) : retType;

  // Use call-site resolved types for generic functions
  const resolved = ctx.genericResolved.get(func.name);

  const restInfo = ctx.funcRestParams.get(func.name);
  const params: { name: string; type: ValType }[] = [];
  const linearParams = getLinearU8ParamIndicesForDeclaration(ctx, decl);
  // #2045: carry the param's ts.Symbol so the buffer registry is keyed by
  // symbol (scope-correct) rather than identifier text (shadow-blind).
  const linearParamBuffers: { sym: ts.Symbol | undefined; ptrLocalIdx: number; lenLocalIdx: number }[] = [];
  const funcType = ctx.mod.types[func.typeIdx];
  const sigParamTypes = funcType?.kind === "func" ? funcType.params : undefined;
  let wasmParamCursor = 0;
  for (let i = 0; i < decl.parameters.length; i++) {
    const param = decl.parameters[i]!;
    const paramName = ts.isIdentifier(param.name) ? param.name.text : `__param${i}`;
    if (linearParams?.has(i) && ts.isIdentifier(param.name)) {
      const ptrLocalIdx = wasmParamCursor++;
      const lenLocalIdx = wasmParamCursor++;
      params.push(
        {
          name: `__linu8_ptr_${paramName}_${i}`,
          type: sigParamTypes?.[ptrLocalIdx] ?? { kind: "i32" },
        },
        {
          name: `__linu8_len_${paramName}_${i}`,
          type: sigParamTypes?.[lenLocalIdx] ?? { kind: "i32" },
        },
      );
      const paramSym = ts.isIdentifier(param.name) ? ctx.checker.getSymbolAtLocation(param.name) : undefined;
      linearParamBuffers.push({ sym: paramSym, ptrLocalIdx, lenLocalIdx });
    } else if (restInfo && i === restInfo.restIndex) {
      // Rest parameter — use the vec struct ref type from the function signature
      params.push({
        name: paramName,
        type: { kind: "ref_null", typeIdx: restInfo.vecTypeIdx },
      });
      wasmParamCursor++;
    } else {
      // Prefer the type already established in the function signature (which
      // may have been inferred from call sites for untyped params).
      const sigParamType = sigParamTypes?.[wasmParamCursor];
      const paramType =
        resolved?.params[i] ?? sigParamType ?? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(param));
      params.push({ name: paramName, type: paramType });
      wasmParamCursor++;
    }
  }

  let returnType: ValType | null;
  if (isGenerator) {
    // Generator functions return externref (JS Generator object)
    returnType = { kind: "externref" };
  } else if (resolved) {
    returnType = resolved.results.length > 0 ? (resolved.results[0] ?? null) : null;
  } else {
    // Prefer the return type already established in the registered function
    // signature — collectDeclarations may have promoted an implicit-any return
    // to f64 via #1121's numericReturnTypes inference, and the body must
    // match that signature exactly to keep recursive call sites consistent.
    const funcType = ctx.mod.types[func.typeIdx];
    const sigResultType = funcType?.kind === "func" && funcType.results.length > 0 ? funcType.results[0] : undefined;
    if (sigResultType) {
      returnType = sigResultType;
    } else {
      returnType = isVoidType(effectiveRetType) ? null : resolveWasmType(ctx, effectiveRetType);
    }
  }

  // #1120: detect locals that should be promoted to i32 because every
  // value flowing through them is constrained to int32 by `| 0` coercion.
  const i32CoercedLocals = collectI32CoercedLocals(decl);

  // #1197: detect `number[]` locals whose element storage can lower to i32.
  // Depends on the i32 scalar set so that `arr[i] = sum` (where `sum` is i32)
  // counts as an i32-safe write.
  const i32SpecializedArrays = collectI32SpecializedArrays(decl, i32CoercedLocals, ctx.oracle);

  // #2152 — a named function declaration whose body references `this` may be
  // passed by reference as an array-HOF callback (e.g.
  // `arr.filter(callbackfn, thisArg)`), which installs the spec `thisArg` into
  // the `__current_this` module global before the `call_ref`. Allow such a
  // body's `this` to read that global. For DIRECT calls `__current_this` is
  // null, and the null-guarded read (#1702) falls back to `undefined` — exactly
  // the spec-correct free-function `this`, so this is behavior-preserving for
  // ordinary calls and only changes the value when a receiver was actually
  // installed by an enclosing dispatch.
  const readsThis = decl.body ? bodyReferencesOwnThis(decl.body) : false;

  const fctx: FunctionContext = {
    name: func.name,
    params,
    locals: [],
    localMap: new Map(),
    returnType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
    isGenerator,
    readsCurrentThis: readsThis,
    i32CoercedLocals: i32CoercedLocals.size > 0 ? i32CoercedLocals : undefined,
    i32SpecializedArrays: i32SpecializedArrays.size > 0 ? i32SpecializedArrays : undefined,
  };
  // A nested lexical descendant can direct-eval a name owned by this function,
  // so mark the whole ancestor chain before any parameter/default/body lowering
  // can capture those bindings through a narrower, non-canonical cell type.
  if (functionMayReachDirectEval(decl, ctx.oracle)) {
    fctx.directEvalBindingNames = collectDirectEvalBindingNames(decl);
    fctx.directEvalActivationBindingNames = collectDirectEvalActivationBindingNames(decl);
  }

  // Register params as locals
  for (let i = 0; i < params.length; i++) {
    fctx.localMap.set(params[i]!.name, i);
  }
  for (const buf of linearParamBuffers) {
    // A param with no resolvable symbol can't be looked up by element access
    // either, so skipping registration is sound — it falls to the GC path.
    if (buf.sym) registerLinearU8Buffer(fctx, buf.sym, buf.ptrLocalIdx, buf.lenLocalIdx);
  }

  ctx.currentFunc = fctx;
  initializeFunctionPoisonPillContext(ctx, fctx, decl);

  // Mark function entry with source position
  const funcPos = getSourcePos(ctx, decl);
  if (funcPos) {
    const nop: Instr = { op: "nop" };
    attachSourcePos(nop, funcPos);
    fctx.body.push(nop);
  }
  if (containsLinearU8Allocation(ctx, decl.body)) {
    fctx.linearU8ArenaMarkLocalIdx = emitLinearU8ArenaMark(ctx, fctx, "__linu8_fn_mark");
  }

  // Emit default-value initialization for parameters with initializers. Known
  // direct callers may inline a constant default, but first-class/dynamic
  // callers cannot; the callee must therefore retain the semantic check.
  const defaultArgcLocal = decl.parameters.some((param, i) => {
    if (!param.initializer) return false;
    return paramDefaultNeedsArgc(params[i]?.type);
  })
    ? cacheParamDefaultArgc(ctx, fctx)
    : undefined;
  for (let i = 0; i < decl.parameters.length; i++) {
    const param = decl.parameters[i]!;
    if (!param.initializer) continue;

    const paramIdx = i;
    const paramType = params[i]!.type;

    // Pre-ensure `__extern_is_undefined` before the initializer is compiled so
    // any late-import funcIdx shift happens while `fctx.body` (not the soon-to-
    // be-detached `thenInstrs`) is authoritative. Otherwise, a shift triggered
    // later by the check emission would miss `thenInstrs`, leaving stale
    // funcIdx values in its `call` ops.
    if (paramType.kind === "externref") {
      ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
    }

    // Per spec §14.3.3.1/§8.4.2: destructuring null/undefined must throw TypeError.
    // If the parameter uses a binding pattern and the default is a literal null/undefined,
    // then when the default fires (arg omitted) we must throw — emit throw in the then-block
    // instead of assigning the default. The destructuring step on explicit values still
    // runs normally (and its own guard handles explicit null/undefined).
    const dstrNullDefault =
      (ts.isObjectBindingPattern(param.name) || ts.isArrayBindingPattern(param.name)) &&
      isNullOrUndefinedLiteral(param.initializer);

    // (#2121) TDZ: if this default reads its own parameter or a later one, the
    // default — when it fires — observes that binding in the TDZ and must throw
    // ReferenceError per §10.2.11, rather than reading the (still
    // zero-/undefined-initialized) local. Emit the throw in the then-block.
    const tdzViolatingName = findTdzViolatingParamRef(decl, i);

    // Build the "then" block: compile default expression, local.set
    const savedBody = pushBody(fctx);
    if (tdzViolatingName !== undefined) {
      emitThrowReferenceError(ctx, fctx, `Cannot access '${tdzViolatingName}' before initialization`);
      fctx.body.push({ op: "unreachable" });
    } else if (dstrNullDefault) {
      for (const ins of buildDestructureNullThrow(ctx, fctx)) fctx.body.push(ins);
    } else {
      // For destructuring patterns with externref param, force array literals in the
      // default to compile as vec structs (not tuples). TS contextual type from the
      // binding pattern gives a tuple, but the destructure path can't convert tuple
      // externrefs back to vec — they miss ref.test on every known vec type and the
      // __extern_length fallback returns 0, causing array.copy traps for rest elements.
      const isArrayPatternExternref = ts.isArrayBindingPattern(param.name) && paramType.kind === "externref";
      const prevForceVec = (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec;
      if (isArrayPatternExternref) {
        (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = true;
      }
      // (#2568) Mirror the class-method param-default fix: compile an object
      // binding pattern's default literal against the pattern's STRUCT type (not
      // the externref param type) so it materializes in the shape the
      // destructuring `ref.test`/`ref.cast` expects, instead of boxing the nested
      // fields to externref. See structHintForBindingPattern.
      const objectPatternStructHint =
        ts.isObjectBindingPattern(param.name) && paramType.kind === "externref"
          ? structHintForBindingPattern(ctx, param.name)
          : undefined;
      // (#3333) Host-free lanes, `any`-typed pattern (NO struct hint resolves —
      // the checker types the pattern as `any`): compiling the default literal
      // against the bare externref hint materializes a typed ANONYMOUS struct
      // (`f64` fields, boxed via extern.convert_any) that the destructure's
      // dynamic `__extern_get` reader cannot reflect — every binding read NaN
      // (`function f({a,b}: any = {a:5,b:3}); f()`). Build the default through
      // `compileObjectLiteralAsExternref` instead: the `__new_plain_object`
      // dynamic carrier is exactly what the dynamic reader consumes (the
      // module-var default control works for the same reason). Host lane keeps
      // the existing shape — its `__extern_get` reflects wasm structs via the
      // host wrapper, so it was never broken.
      const useDynamicObjCarrier =
        (ctx.standalone || ctx.wasi) &&
        objectPatternStructHint === undefined &&
        ts.isObjectBindingPattern(param.name) &&
        paramType.kind === "externref" &&
        param.initializer !== undefined &&
        ts.isObjectLiteralExpression(param.initializer);
      let defaultResultType: ValType | null;
      try {
        defaultResultType = useDynamicObjCarrier
          ? compileObjectLiteralAsExternref(ctx, fctx, param.initializer as ts.ObjectLiteralExpression)
          : compileExpression(ctx, fctx, param.initializer, objectPatternStructHint ?? paramType);
        if (useDynamicObjCarrier && defaultResultType === null) {
          // Carrier unavailable — fall back to the legacy shape.
          defaultResultType = compileExpression(ctx, fctx, param.initializer, paramType);
        }
      } finally {
        if (isArrayPatternExternref) {
          (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = prevForceVec;
        }
      }
      // Coerce if the default expression produced a different type than the param
      if (defaultResultType && !valTypesMatch(defaultResultType, paramType)) {
        coerceType(ctx, fctx, defaultResultType, paramType);
      }
      fctx.body.push({ op: "local.set", index: paramIdx });
    }
    const thenInstrs = fctx.body;
    popBody(fctx, savedBody);

    // Emit the null/zero check + conditional assignment
    if (paramType.kind === "externref") {
      // Per JS spec, parameter defaults fire ONLY when the arg is `undefined`
      // (omitted or explicit), never for `null`. At the Wasm layer, JS null
      // maps to ref.null.extern (ref.is_null=1) while JS undefined is a non-
      // null externref wrapping the JS undefined value. Omitted args are padded
      // by callers with `__get_undefined()` (externref-wrapped undefined), so
      // `__extern_is_undefined` catches both "omitted" and "explicit undefined".
      // Using `ref.is_null` in addition would wrongly fire the default when the
      // caller passed explicit `null` (#1025 / #1021).
      const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, fctx);
      fctx.body.push({ op: "local.get", index: paramIdx });
      if (undefIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: undefIdx });
      } else {
        // Fallback (standalone mode): ref.is_null is imprecise — treats null
        // as undefined. Preserves pre-#737 behavior when the host import can't
        // be registered.
        fctx.body.push({ op: "ref.is_null" });
      }
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
      fctx.body.push({ op: "local.get", index: paramIdx });
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "i32") {
      emitParamDefaultArgMissingCheck(fctx, defaultArgcLocal!, i);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "f64") {
      emitParamDefaultArgMissingCheck(fctx, defaultArgcLocal!, i);
      // Keep the f64 sNaN sentinel as a fallback for existing callers that
      // materialize an explicit undefined/missing value.
      emitF64ParamSentinelCheck(fctx, paramIdx);
      fctx.body.push({ op: "i32.or" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    }
  }

  // Destructure parameters with binding patterns.
  // When a parameter is declared as e.g. function([x, y, z]) or function({a, b}),
  // the parameter is received as a single value (vec struct or struct ref) and
  // we need to extract the individual bindings into separate locals.
  //
  // (#3024) Keep the param-default materialization body reachable for the
  // field-pad patch that fires while a nested pattern's DEFAULT object literal
  // is compiled inside the destructure. A param OUTER default (`function f({ w:
  // { x, y, z } = { x, y, z } } = { w: { x, z } })`) materializes its object
  // literal into an `if.then` buffer embedded in THIS body; the destructure
  // helpers then descend into detached branch buffers to compile the nested
  // default, which — when it SHARES the outer sub-object's anonymous struct but
  // carries MORE fields — grows that struct via `ensureComputedPropertyFields`.
  // The resulting `patchStructNewForAddedField` walks `fctx.body` + `savedBodies`
  // + `liveBodies`, but by then this outer body is off `fctx.body` (a plain swap,
  // not on `savedBodies`), so the already-emitted outer `struct.new` was left one
  // operand short of the grown field count ("struct.new need 3, got 2" invalid
  // Wasm). Registering the body here (same mechanism as the var-decl #3024 fix in
  // statements/destructuring.ts and the #2503/#2158 param-branch fixes) makes it
  // reachable; removed after so it does not leak.
  const paramDestructBody = fctx.body;
  const paramDestructWasLive = ctx.liveBodies.has(paramDestructBody);
  if (!paramDestructWasLive) ctx.liveBodies.add(paramDestructBody);
  for (let i = 0; i < decl.parameters.length; i++) {
    const param = decl.parameters[i]!;
    if (ts.isObjectBindingPattern(param.name)) {
      destructureParamObject(ctx, fctx, i, param.name, params[i]!.type);
    } else if (ts.isArrayBindingPattern(param.name)) {
      destructureParamArray(ctx, fctx, i, param.name, params[i]!.type);
    }
  }
  if (!paramDestructWasLive) ctx.liveBodies.delete(paramDestructBody);
  // Set up `arguments` object if the function body references it.
  // We create a vec struct (same as Array) populated from all function parameters.
  // Use externref elements so that all parameter types (numbers, strings, objects)
  // are preserved — matching the closure version in closures.ts (#771).
  if (decl.body && needsImplicitArgumentsObject(decl, fctx.directEvalBindingNames !== undefined)) {
    // Ensure __box_number and __unbox_number are available for mapped arguments sync
    const hasNumericParam = params.some((p) => p.type.kind === "f64" || p.type.kind === "i32");
    if (hasNumericParam) {
      ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
      ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
      flushLateImportShifts(ctx, fctx);
    }

    const elemType: ValType = { kind: "externref" };
    const vecTypeIdx = getOrRegisterVecType(ctx, "externref", elemType);
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const vecRef: ValType = { kind: "ref", typeIdx: vecTypeIdx };

    const argsLocal = allocLocal(fctx, "arguments", vecRef);
    const arrTmp = allocLocal(fctx, "__args_arr_tmp", { kind: "ref", typeIdx: arrTypeIdx });

    // Mapped arguments only applies to a *simple* parameter list in non-strict
    // mode. In strict mode the arguments object is *unmapped* (§10.4.4); so is a
    // non-simple parameter list (rest/default/destructuring — §10.2.11 step
    // 22.a, #2743): writes to `arguments[i]` must not flow back into the named
    // parameter, so skip mappedArgsInfo entirely and leave the built vec as an
    // independent copy (#779e). (`isSimpleParameterList` also rejects defaulted
    // params, which the prior local `every(isIdentifier && !rest)` check missed.)
    const allSimpleParams = isSimpleParameterList(decl.parameters);
    const mappedAllowed = allSimpleParams && !isStrictFunction(decl, ctx.inferModuleStrictArguments);

    // Set up mapped arguments info for param ↔ arguments sync (#849)
    if (mappedAllowed && params.length > 0) {
      fctx.mappedArgsInfo = {
        argsLocalIdx: argsLocal,
        arrTypeIdx,
        vecTypeIdx,
        paramCount: params.length,
        paramOffset: 0,
        paramTypes: params.map((p) => p.type),
      };
      // (#2676) Record this mapped function's live `mappedArgsInfo` keyed by its
      // declaration node so a `delete args[i]` in a nested (strict) closure can
      // resolve an aliased `arguments` (`var args = arguments`) back to this
      // function's per-index `nonConfigurableIndices`. See the delete site in
      // typeof-delete.ts (resolveAliasedMappedArgs).
      ctx.mappedArgsInfoByFunc.set(decl, fctx.mappedArgsInfo);
    }

    // Build the arguments vec by concatenating formal params with
    // extras delivered via the __extras_argv global (#1053).
    emitArgumentsVecBody(
      ctx,
      fctx,
      params.map((p) => p.type),
      0,
      { vecTypeIdx, arrTypeIdx, argsLocalIdx: argsLocal, arrTmpIdx: arrTmp },
      shouldRegisterArgumentsWithHost(ctx, decl.body, fctx.directEvalBindingNames !== undefined),
    );

    // (#4243) §10.6 step 13.a — a non-strict arguments object carries `callee`.
    seedDeclarationArgumentsCallee(ctx, fctx, decl, func.name, argsLocal);
  }

  if (isGenerator && hasAsyncModifier(decl) && isAsyncGenDriveCandidate(ctx, decl)) {
    // (#2906 slice 3d-i) Async-generator PRODUCER core. `async function* g(){
    // yield await P; yield E }` routes through the generator-buffer path and
    // fails at the #680 native-generator gate in standalone/wasi. Intercept a
    // bounded async-gen body HERE — before that gate — and drive it host-free on
    // the async-frame CFG machine (frame carrier + `__async_gen_next_<name>`).
    // The generator returnType is already externref (the frame carrier).
    emitAsyncGenerator(ctx, fctx, decl);
  } else if (isGenerator) {
    const nativeGenerator = ctx.nativeGenerators.get(func.name);
    if (nativeGenerator) {
      compileNativeGeneratorFunction(ctx, fctx, decl, nativeGenerator);
    } else if (ctx.standalone || ctx.wasi) {
      reportError(
        ctx,
        decl,
        "Codegen error: native generator lowering currently supports only sequential numeric yields in standalone/WASI targets (#680). Recompile with a JS host target for complex generator shapes.",
      );
      fctx.body.push({ op: "ref.null.extern" });
    } else {
      // Generator function: eagerly evaluate body, collect yields into a JS array,
      // then wrap it with __create_generator to return a Generator-like object.
      // Body is wrapped in try/catch to defer thrown exceptions to first next() (#928).
      const bufferLocal = allocLocal(fctx, "__gen_buffer", { kind: "externref" });
      const pendingThrowLocal = allocLocal(fctx, "__gen_pending_throw", { kind: "externref" });

      // Create buffer: __gen_buffer = __gen_create_buffer()
      const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
      fctx.body.push({ op: "call", funcIdx: createBufIdx });
      fctx.body.push({ op: "local.set", index: bufferLocal });
      fctx.body.push({ op: "ref.null.extern" });
      fctx.body.push({ op: "local.set", index: pendingThrowLocal });

      // Wrap the generator body in a block so that `return` statements inside
      // the body can `br` out to the generator creation code instead of
      // using the wasm `return` opcode (which would skip __create_generator).
      // Use pushBody/popBody so the outer body stays reachable for global-index
      // fixups when new string-constant imports are added during body compilation.
      const savedGenBody = pushBody(fctx);

      // Set generator return depth for correct `br` depth in nested contexts
      fctx.generatorReturnDepth = 0;

      // Push a block label level so return can break out
      fctx.blockDepth++;
      for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
      for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;

      if (decl.body) {
        hoistVarDeclarations(ctx, fctx, decl.body.statements);
        hoistLetConstWithTdz(ctx, fctx, decl.body.statements);
        reifyCurrentDirectEvalBindings(ctx, fctx);
        // (#4456) Names this body hoists are lexically its own; pop them again
        // so a later same-named declaration elsewhere is not silently aliased
        // to this one's compiled function.
        const nameScope = beginNestedFunctionNameScope(ctx);
        try {
          hoistFunctionDeclarations(ctx, fctx, decl.body.statements);
          for (const stmt of decl.body.statements) {
            compileStatement(ctx, fctx, stmt);
          }
        } finally {
          endNestedFunctionNameScope(ctx, nameScope);
        }
      }

      fctx.blockDepth--;
      for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
      for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
      fctx.generatorReturnDepth = undefined;

      // Restore outer body and wrap compiled body in a try/catch(block)
      const bodyInstrs = fctx.body;
      popBody(fctx, savedGenBody);

      // Wrap generator body block in try/catch to capture exceptions as pending throw
      const tagIdx = ensureExnTag(ctx);
      const getCaughtIdx = ctx.funcMap.get("__get_caught_exception");
      const catchBody: Instr[] = [{ op: "local.set", index: pendingThrowLocal }];
      const catchAllBody: Instr[] =
        getCaughtIdx !== undefined
          ? [
              { op: "call", funcIdx: getCaughtIdx },
              { op: "local.set", index: pendingThrowLocal },
            ]
          : [];
      fctx.body.push(
        buildTargetTaggedTry(
          ctx,
          { kind: "empty" },
          [{ op: "block", blockType: { kind: "empty" }, body: bodyInstrs }],
          [{ tagIdx, body: catchBody }],
          catchAllBody.length > 0 ? catchAllBody : undefined,
        ),
      );

      // Return __create_generator or __create_async_generator depending on async flag.
      // Note: ctx.asyncFunctions excludes async generators (by design), so we check
      // the AST node directly to detect async function* declarations.
      const isAsyncGenerator = hasAsyncModifier(decl);
      const createGenName = isAsyncGenerator ? "__create_async_generator" : "__create_generator";
      // (#2865) Record legacy-buffer async gens so the .next() dispatch keeps a host miss arm.
      if (createGenName === "__create_async_generator") ctx.asyncGenLegacyBufferEmitted = true;
      ctx.legacyGenBufferEmitted = true; // (#3132) sync OR async legacy buffer emitted
      const createGenIdx = ctx.funcMap.get(createGenName)!;
      fctx.body.push({ op: "local.get", index: bufferLocal });
      fctx.body.push({ op: "local.get", index: pendingThrowLocal });
      fctx.body.push({ op: "call", funcIdx: createGenIdx });
      // The externref Generator object is now on the stack as the return value
    }
  } else {
    // Compile body statements
    if (decl.body) {
      // #1210: pre-scan for `let s = ""; for (...) s += <expr>` builder patterns.
      // Must run BEFORE hoistLetConstWithTdz so the hoist pass can skip
      // pre-allocating the binding's local — the binding is replaced by a
      // synthetic buffer/len/cap/mat triple set up at declaration time.
      // Only runs in nativeStrings mode (JS-host concat avoids GC pressure).
      if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
        const presize = new Map<ts.VariableDeclaration, StringBuilderPresizeInfo>();
        const builders = detectStringBuilders(ctx, decl.body, presize);
        if (builders.size > 0) fctx.pendingStringBuilders = builders;
        if (presize.size > 0) fctx.stringBuilderPresize = presize; // #1761
      }
      // #1195: array-reduce-fusion — detect the fill+reduce shape and
      // rewrite the AST to eliminate the temporary array. Runs BEFORE
      // hoisting so the fused statement list is what gets hoisted /
      // compiled. The detector is conservative; if any precondition
      // fails, the original statements are returned unchanged.
      const fusionMatches = detectArrayReduceFusion(ctx, decl.body);
      const bodyStatements: ts.Statement[] =
        fusionMatches.length > 0
          ? applyArrayReduceFusion(decl.body.statements, fusionMatches)
          : (decl.body.statements as unknown as ts.Statement[]);
      // Hoist `var` declarations: pre-allocate locals so variables are accessible
      // even before their declaration site (JS var hoisting semantics).
      hoistVarDeclarations(ctx, fctx, bodyStatements);
      // Hoist `let`/`const` declarations with TDZ flags so nested functions can
      // capture them. The TDZ flag ensures ReferenceError if accessed before init.
      hoistLetConstWithTdz(ctx, fctx, bodyStatements);
      // Promote the eval-visible entry environment before compiling hoisted
      // functions. Their capture lowering then aliases these same canonical
      // cells, as do interpreter reads/writes at a direct-eval call site.
      reifyCurrentDirectEvalBindings(ctx, fctx);
      // Hoist function declarations: JS semantics require function declarations
      // to be available before their textual position in the enclosing scope.
      // (#4456) …and require them to STOP being visible at the end of this
      // body. The scope is closed after the statement loop below, since a
      // hoisted name stays resolvable for the whole body.
      const nameScope = beginNestedFunctionNameScope(ctx);
      try {
        hoistFunctionDeclarations(ctx, fctx, bodyStatements);

        // (#1042/#1796/#2895/#2906) Async/await state-machine activation. The
        // CPS (host) + drive (standalone/host) gating, result-type rewrite, and
        // emitter dispatch were extracted into `maybeActivateAsync` (#2957
        // phase 1) so the arrow/method/object-literal body-compile paths can
        // reuse the exact same entry point in phases 2–3. On a match the helper
        // has already emitted the full body, so the normal statement loop below
        // is skipped. Byte-inert: the internal `ts.isFunctionDeclaration` guards
        // are preserved, so declaration activation is unchanged.
        const asyncCpsHandled = maybeActivateAsync(ctx, fctx, decl, func);

        if (!asyncCpsHandled) {
          for (const stmt of bodyStatements) {
            compileStatement(ctx, fctx, stmt);
          }
        }
      } finally {
        endNestedFunctionNameScope(ctx, nameScope);
      }
    }

    // Reset short-lived linear-U8 function allocations on fallthrough, then
    // ensure there's always a valid return value at the end for non-void funcs.
    const lastInstr = fctx.body[fctx.body.length - 1];
    if (!lastInstr || lastInstr.op !== "return") {
      emitLinearU8ArenaReset(ctx, fctx, fctx.linearU8ArenaMarkLocalIdx);
      if (fctx.returnType) {
        // Add a default return value
        if (fctx.returnType.kind === "f64") {
          fctx.body.push({ op: "f64.const", value: 0 });
        } else if (fctx.returnType.kind === "i32") {
          fctx.body.push({ op: "i32.const", value: 0 });
        } else if (fctx.returnType.kind === "externref") {
          emitUndefined(ctx, fctx);
        } else if (fctx.returnType.kind === "ref" || fctx.returnType.kind === "ref_null") {
          fctx.body.push({ op: "ref.null", typeIdx: fctx.returnType.typeIdx });
        }
      }
    }
  }

  cacheStringLiterals(ctx, fctx);
  const localsBeforeDedup = fctx.locals.length;
  deduplicateLocals(fctx);
  const maxLocal = fctx.params.length + fctx.locals.length;
  const invalidLocalRefs = new Set<number>();
  walkInstructions(fctx.body, (instr) => {
    if ((instr.op === "local.get" || instr.op === "local.set" || instr.op === "local.tee") && instr.index >= maxLocal) {
      invalidLocalRefs.add(instr.index);
    }
  });
  if (invalidLocalRefs.size > 0) {
    const staleBindings = [...fctx.localMap.entries()]
      .filter(([, index]) => index >= maxLocal)
      .map(([name, index]) => `${name}=${index}`)
      .join(", ");
    throw new Error(
      `codegen invariant: '${func.name}' references out-of-range local(s) ${[...invalidLocalRefs].join(", ")} ` +
        `after local dedup (params=${fctx.params.length}, locals=${fctx.locals.length}, before=${localsBeforeDedup}` +
        `${staleBindings ? `, stale bindings: ${staleBindings}` : ""})`,
    );
  }
  func.locals = fctx.locals;
  func.body = fctx.body;

  // (#2182) See the snapshot at function entry. A non-zero delta means a
  // detached-body `liveBodies.add` was not balanced by a `.delete` — a
  // funcIdx-shift hazard. Throw in dev/test builds so it surfaces immediately
  // rather than corrupting a later late import silently.
  if (ctx.liveBodies.size !== liveBodiesAtEntry) {
    throw new Error(
      `codegen invariant (#2182): liveBodies unbalanced after compiling '${func.name}' ` +
        `(entry=${liveBodiesAtEntry}, exit=${ctx.liveBodies.size}) — a detached-body ` +
        `liveBodies.add() is missing its matching .delete(), risking funcIdx over-shift.`,
    );
  }

  ctx.currentFunc = null;
}

/**
 * Build throw instructions for TypeError when destructuring null/undefined.
 * Per JS spec, destructuring null/undefined must throw TypeError.
 */
