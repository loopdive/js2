// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Nested function and class declaration lowering.
 * Handles function declarations within other functions, class declarations,
 * function hoisting, default parameter handling, and the arguments object.
 */
import { ts } from "../../ts-api.js";
import { isVoidType, unwrapPromiseType } from "../../checker/type-mapper.js";
import { bodyUsesArguments } from "../helpers/body-uses-arguments.js";
import { bodyReferencesOwnThis } from "../helpers/body-references-own-this.js";
import { isStrictFunction, isSimpleParameterList } from "../helpers/is-strict-function.js";
import type { Instr, ValType, WasmFunction } from "../../ir/types.js";
import {
  collectReferencedIdentifiers,
  collectWrittenIdentifiers,
  promoteAccessorCapturesToGlobals,
} from "../closures.js";
import { addFunctionOwnLocals } from "../binding-info.js"; // (#2103) memoized own-locals oracle
import { popBody, pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext, OptionalParamInfo } from "../context/types.js";
import {
  bodyHasNewTryRegionAcrossYield,
  compileNativeGeneratorFunction,
  isNativeGeneratorCandidate,
  registerNativeGenerator,
  type NativeGeneratorCaptureParam,
} from "../generators-native.js";
import { emitThrowReferenceError, emitThrowString, emitThrowTypeError, noJsHost } from "../expressions/helpers.js";
import {
  collectClassDeclaration,
  compileClassBodies,
  destructureParamArray,
  destructureParamObject,
  extractConstantDefault,
  resolveWasmType,
} from "../index.js";
import { emitAsyncGenerator, isAsyncGenDriveCandidate } from "../async-frame.js"; // (#2865) nested async-gen producer
import { ensureExnTag, nextModuleGlobalIdx } from "../registry/imports.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterRefCellType,
  getOrRegisterVecType,
} from "../registry/types.js";
import { getVecInfo } from "../type-coercion.js";
import {
  compileExpression,
  compileStatement,
  ensureLateImport,
  flushLateImportShifts,
  registerEmitArgumentsObject,
  registerHoistFunctionDeclarations,
} from "../shared.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "../func-space.js"; // (#1916 S2 read chokepoint / S3b stable-regime minting)

/**
 * §15.7.1 ClassDefinitionEvaluation: the class name binding is added to the
 * class's inner scope AFTER the `extends` clause is evaluated. Referencing the
 * class name inside its own `extends` expression therefore hits the TDZ and
 * must throw ReferenceError (e.g. `class x extends x {}`). Returns true if the
 * extends heritage clause contains an identifier equal to the class name.
 */
function extendsReferencesClassName(decl: ts.ClassDeclaration | ts.ClassExpression, className: string): boolean {
  if (!decl.heritageClauses) return false;
  for (const clause of decl.heritageClauses) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
    for (const typeNode of clause.types) {
      let found = false;
      const visit = (node: ts.Node): void => {
        if (found) return;
        if (ts.isIdentifier(node) && node.text === className) {
          found = true;
          return;
        }
        ts.forEachChild(node, visit);
      };
      visit(typeNode.expression);
      if (found) return true;
    }
  }
  return false;
}

export function compileNestedClassDeclaration(
  ctx: CodegenContext,
  fctx: FunctionContext,
  decl: ts.ClassDeclaration | ts.ClassExpression,
  // (#3045 Bug 2) A class EXPRESSION nested in a function (`const C = class{…}`)
  // is compiled in-scope through this same path, keyed by the synthetic name it
  // was collected under during the collection phase. When set, `decl` is the
  // `ts.ClassExpression` and `className` is that synthetic name — otherwise this
  // is the legacy class-DECLARATION path and `className` is `decl.name.text`.
  syntheticName?: string,
): void {
  const className = syntheticName ?? decl.name?.text;
  if (!className) return;

  // §15.7.1: the class name is in TDZ while its own `extends` clause is
  // evaluated. `class x extends x {}` must throw ReferenceError (#1594B). Only
  // a NAMED class can self-reference in its own heritage (`decl.name` present);
  // an anonymous class expression has no name to hit the TDZ.
  if (decl.name && extendsReferencesClassName(decl, decl.name.text)) {
    emitThrowReferenceError(ctx, fctx, `Cannot access '${decl.name.text}' before initialization`);
    return;
  }

  const isDeferred = ctx.deferredClassBodies.has(className);
  // Skip if already collected AND not deferred (already fully compiled)
  if (ctx.structMap.has(className) && !isDeferred) {
    // ES2015 14.5.14 step 21: class with static 'prototype' member must throw TypeError
    if (ctx.classThrowsOnEval.has(className)) {
      emitThrowTypeError(ctx, fctx, "Classes may not have a static property named 'prototype'");
      return;
    }
    return;
  }

  try {
    // Collect struct type, constructor, and method stubs (if not already done).
    // A class EXPRESSION was already collected under its synthetic name in the
    // collection phase, so `structMap.has(syntheticName)` is always true and this
    // branch only runs for a genuine (un-collected) class declaration.
    if (!ctx.structMap.has(className)) {
      collectClassDeclaration(ctx, decl, syntheticName);
    }

    // ES2015 14.5.14 step 21: class with static 'prototype' member must throw TypeError
    // Check after collection since collectClassDeclaration sets the flag.
    if (ctx.classThrowsOnEval.has(className)) {
      emitThrowTypeError(ctx, fctx, "Classes may not have a static property named 'prototype'");
      return;
    }

    // Promote captured locals to globals so method/constructor bodies can access
    // variables from the enclosing function scope. Also scan parameter-default
    // initializers so e.g. `method([x] = iter)` can resolve `iter` against the
    // enclosing function scope (#1161).
    for (const member of decl.members) {
      if (ts.isMethodDeclaration(member) && member.body) {
        const paramInits = member.parameters.map((p) => p.initializer).filter((e): e is ts.Expression => !!e);
        promoteAccessorCapturesToGlobals(ctx, fctx, member.body, paramInits);
      }
      if (ts.isConstructorDeclaration(member) && member.body) {
        const paramInits = member.parameters.map((p) => p.initializer).filter((e): e is ts.Expression => !!e);
        promoteAccessorCapturesToGlobals(ctx, fctx, member.body, paramInits);
      }
      if ((ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && member.body) {
        const paramInits = member.parameters.map((p) => p.initializer).filter((e): e is ts.Expression => !!e);
        promoteAccessorCapturesToGlobals(ctx, fctx, member.body, paramInits);
      }
    }

    // Build funcByName map for compileClassBodies
    const funcByName = new Map<string, number>();
    for (let i = 0; i < ctx.mod.functions.length; i++) {
      funcByName.set(ctx.mod.functions[i]!.name, i);
    }

    // Compile constructor and method bodies
    compileClassBodies(ctx, decl, funcByName, syntheticName);

    // Mark as no longer deferred
    if (isDeferred) ctx.deferredClassBodies.delete(className);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    reportError(ctx, decl, `Internal error compiling nested class '${className}': ${msg}`);
  }
}

interface CompileNestedFunctionOptions {
  reuseReservedEntry?: WasmFunction;
}

/**
 * (#3038) Cache of, per enclosing function/source body, the set of outer-scope
 * variable names that are ASSIGNED inside SOME nested function/arrow/method
 * within that body. Keyed by the enclosing body node so it's computed at most
 * once per enclosing scope.
 */
const nestedFnMutatedNamesCache = new WeakMap<ts.Node, Set<string>>();

/**
 * (#3038) Collect the outer-scope names that are written inside a nested
 * function scope of `enclosingBody`.
 *
 * Why this matters for CAPTURE representation: a variable written by a nested
 * closure (a `function` decl, arrow, or object-literal method — e.g. an
 * iterator's `return()` callback) is boxed into a shared ref-cell so the write
 * propagates across the scope boundary. That boxing DISCONNECTS the variable
 * from the plain outer local. A sibling nested FUNCTION DECLARATION that only
 * READS the same variable was, historically, captured BY VALUE (a snapshot of
 * the now-stale plain local) — so it never observed the writer's mutation.
 * This is exactly the arrow path's `writtenInOuter` rule (closures.ts): a
 * read-only capture of a variable mutated elsewhere in the enclosing scope must
 * be captured BY REF (through the same cell). The nested-fn-decl path lacked
 * it, which silently mis-compiled the for-await-of / async-generator
 * iterator-close (`return()` → `doneCallCount`) test262 cluster and any
 * two-sibling-closure shared-mutable-binding shape (verified sync too).
 *
 * `collectWrittenIdentifiers` already handles shadowing at each function
 * boundary (a name re-declared as an own local of a deeper scope is excluded),
 * so we only need to restrict collection to writes that occur strictly INSIDE
 * a nested function scope. Top-level straight-line writes of the enclosing
 * function stay unboxed — a by-value reader snapshots the live local at the
 * direct call site, which is correct for those (a var written only in the
 * enclosing straight-line body is never boxed).
 */
function collectNamesMutatedInNestedFunctions(enclosingBody: ts.Node): Set<string> {
  const cached = nestedFnMutatedNamesCache.get(enclosingBody);
  if (cached) return cached;
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      // Every assignment inside this nested scope (to a name it does not itself
      // declare) mutates an enclosing/outer binding. `collectWrittenIdentifiers`
      // descends with per-boundary shadowing, so no further recursion is needed
      // for this subtree.
      collectWrittenIdentifiers(node, out);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(enclosingBody, visit);
  nestedFnMutatedNamesCache.set(enclosingBody, out);
  return out;
}

export function compileNestedFunctionDeclaration(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.FunctionDeclaration,
  opts: CompileNestedFunctionOptions = {},
): void {
  if (!stmt.name || !stmt.body) return;
  const funcName = stmt.name.text;

  // Determine parameter types and return type
  // Unannotated binding patterns containing a rest element are widened to
  // externref — TS contextual type gives a fixed-length tuple which the
  // destructure path can't slice correctly for the rest tail (mirrors the
  // top-level path in declarations.ts: restBindingOverridesToExternref).
  const restBindingOverridesToExternref = (p: ts.ParameterDeclaration): boolean => {
    if (p.type || p.dotDotDotToken) return false;
    if (ts.isArrayBindingPattern(p.name)) {
      return p.name.elements.some((e) => !ts.isOmittedExpression(e) && !!e.dotDotDotToken);
    }
    if (ts.isObjectBindingPattern(p.name)) {
      return p.name.elements.some((e) => !!e.dotDotDotToken);
    }
    return false;
  };
  const paramTypes: ValType[] = [];
  for (const p of stmt.parameters) {
    const paramType = ctx.checker.getTypeAtLocation(p);
    let wasmType: ValType = restBindingOverridesToExternref(p)
      ? { kind: "externref" }
      : resolveWasmType(ctx, paramType);
    // If the parameter has a default value and is a non-null ref type,
    // widen to ref_null so callers can pass ref.null as a sentinel for "use default"
    if (p.initializer && wasmType.kind === "ref") {
      wasmType = { kind: "ref_null", typeIdx: (wasmType as { kind: "ref"; typeIdx: number }).typeIdx };
    }
    paramTypes.push(wasmType);
  }

  // Check if this is a generator function declaration (function* name() { ... })
  const isGenerator = stmt.asteriskToken !== undefined;
  if (isGenerator) {
    ctx.generatorFunctions.add(funcName);
  }
  // Detect async functions — their TS return type is Promise<T> but the
  // Wasm return should be T (matching the unwrap that top-level async functions use).
  const isAsync = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
  if (isAsync && !isGenerator) {
    ctx.asyncFunctions.add(funcName);
  }

  // (#2923) A function declaration parsed from an inlined `eval("<const>")`
  // body lives in a foreign `ts.createSourceFile` with NO checker bindings, so
  // `getSignatureFromDeclaration` throws (`symbol.escapedName` on an undefined
  // symbol). Treat that as "no static signature": params already degrade to
  // externref above (getTypeAtLocation → `any`), and the return type defaults to
  // externref (dynamic `any`) so a `return <expr>` still yields its value.
  // (Detected by catch rather than a filename import to avoid an eval-inline ↔
  // nested-declarations import cycle; a normal declaration always has a symbol,
  // so the catch only fires for genuinely binding-less foreign nodes.)
  let sig: ts.Signature | undefined;
  let foreignNoSignature = false;
  try {
    sig = ctx.checker.getSignatureFromDeclaration(stmt);
  } catch {
    foreignNoSignature = true;
  }
  let returnType: ValType | null = null;
  if (isGenerator) {
    // Generator functions return externref (JS Generator object)
    returnType = { kind: "externref" };
  } else if (foreignNoSignature) {
    // Foreign eval-body function: dynamic `any` return (externref).
    returnType = { kind: "externref" };
  } else if (sig) {
    let retType = ctx.checker.getReturnTypeOfSignature(sig);
    // For async functions, unwrap Promise<T> to get T
    if (isAsync) {
      retType = unwrapPromiseType(retType, ctx.checker);
    }
    if (!isVoidType(retType)) {
      returnType = resolveWasmType(ctx, retType);
    }
  }

  // Analyze captured variables from the enclosing scope. Use scope-aware
  // collection so nested `var` declarations and parameter bindings inside the
  // function body shadow outer references — otherwise a function with its own
  // `var i;` would be treated as capturing the outer `i` (#995).
  const ownLocals = new Set<string>();
  addFunctionOwnLocals(stmt, ownLocals); // (#2103) memoized own-locals

  const referencedNames = new Set<string>();
  for (const s of stmt.body.statements) {
    collectReferencedIdentifiers(s, referencedNames, ownLocals);
  }

  // Detect which captured variables are written inside the function body
  const writtenInBody = new Set<string>();
  for (const s of stmt.body.statements) {
    collectWrittenIdentifiers(s, writtenInBody, ownLocals);
  }

  // (#3038) Also detect captured variables that are mutated by a SIBLING nested
  // scope (another `function` decl, arrow, or object-literal method) within the
  // enclosing function — e.g. an iterator's `return()` callback doing
  // `doneCallCount += 1`. Such a variable is boxed into a shared ref-cell by the
  // writer's closure materialization; a read-only capture here MUST therefore be
  // by-ref (through the same cell), not a stale by-value snapshot of the outer
  // local. Mirrors the arrow path's `writtenInOuter` rule (closures.ts). Without
  // it, the for-await-of / async-generator iterator-close cluster (and every
  // two-sibling-closure shared-mutable-binding shape, sync included) read 0.
  let mutatedInSiblingScope: Set<string> = writtenInBody;
  {
    let enclosing: ts.Node | undefined = stmt.parent;
    while (
      enclosing &&
      !ts.isFunctionDeclaration(enclosing) &&
      !ts.isFunctionExpression(enclosing) &&
      !ts.isArrowFunction(enclosing) &&
      !ts.isMethodDeclaration(enclosing) &&
      !ts.isConstructorDeclaration(enclosing) &&
      !ts.isGetAccessorDeclaration(enclosing) &&
      !ts.isSetAccessorDeclaration(enclosing) &&
      !ts.isSourceFile(enclosing)
    ) {
      enclosing = enclosing.parent;
    }
    const enclosingBody = enclosing
      ? ts.isSourceFile(enclosing)
        ? enclosing
        : (enclosing as { body?: ts.Node }).body
      : undefined;
    if (enclosingBody) mutatedInSiblingScope = collectNamesMutatedInNestedFunctions(enclosingBody);
  }

  const captures: {
    name: string;
    type: ValType;
    localIdx: number;
    mutable: boolean;
    /**
     * #1205: Whether this capture has a TDZ flag in the outer fctx. When
     * true, we (a) force-box the value so post-init mutations propagate
     * through a ref cell, and (b) propagate the boxed flag itself as an
     * extra leading param so identifier reads inside the lifted body
     * route through `boxedTdzFlags` (struct.get on the i32 ref cell)
     * rather than reading a stale capture-time snapshot.
     */
    hasTdzFlag: boolean;
    /** Outer-fctx flag local index (i32 flag OR boxed ref-cell ref). */
    tdzFlagIdx?: number;
    /**
     * #2623 Slice A: the captured local is ALREADY a ref cell in the outer
     * scope (registered in `fctx.boxedCaptures`) — e.g. an outer fn that is
     * itself materialized as a closure VALUE threads a mutable capture as a
     * boxed `$cell` param, and a nested fn re-captures the SAME name. The
     * outer slot IS the canonical cell; re-boxing it here produced a
     * `$cell-of-cell` whose deref depth desynced the construction-site cast
     * (illegal cast in Constructor()) AND the lifted body's struct.get/set
     * (read garbage → callCount never increments). Mirrors the arrow path's
     * `alreadyBoxed` handling (closures.ts:1681/1728-1748/2457-2476). When
     * set, thread the existing cell through instead of wrapping again.
     */
    alreadyBoxed: boolean;
    /** Inner value type of the outer cell (when alreadyBoxed) — the depth the
     * lifted body's struct.get/set should produce/consume. */
    boxedValType?: ValType;
  }[] = [];
  for (const name of referencedNames) {
    if (ownLocals.has(name)) continue;
    // (#1702) A nested `FunctionDeclaration` establishes its OWN `this`
    // binding per ECMA-262 §10.2.1.1 (OrdinaryCallBindThis) — `this` is
    // never lexically captured the way an arrow function inherits it. When
    // such a function is invoked without a receiver (e.g. a plain `inner()`
    // call inside a class method body or another function), its `this` is
    // `undefined` in strict code, NOT the enclosing method's receiver.
    // Capturing the outer `this` here threaded the method's instance into
    // the lifted body as param 0, so `inner()` saw the instance instead of
    // `undefined` — the class-method half of the #873/#895 strict-`this`
    // residual. Skipping `this`/`super` lets `ThisKeyword` fall through to
    // the `undefined` / `__current_this` resolution path, which is correct
    // for a free function. (Arrow functions are compiled via closures.ts,
    // which keeps lexical `this` capture — this branch only handles
    // `FunctionDeclaration`s.)
    if (name === "this" || name === "super") continue;
    const localIdx = fctx.localMap.get(name);
    if (localIdx === undefined) continue;
    // #2669: skip names bound to a *user* function — but NOT a wasm:js-string
    // builtin import (concat/length/equals/substring/charCodeAt), which lives in
    // funcMap yet must not block capture of a same-named outer local (the
    // test262 `let length = "outer"` dstr template captured by a nested fn).
    if (ctx.funcMap.has(name) && ctx.funcMap.get(name) !== ctx.jsStringImports.get(name)) continue;
    const type =
      localIdx < fctx.params.length
        ? fctx.params[localIdx]!.type
        : (fctx.locals[localIdx - fctx.params.length]?.type ?? { kind: "f64" });
    // #1205 Stage 3: detect TDZ flag in outer scope (mirrors closures.ts:1326-1336
    // for the arrow path). The `__tdz_<name>` slot scan is the fallback for the
    // case where a block-scope shadow cleared `tdzFlagLocals` but the underlying
    // local still exists.
    let tdzFlagIdx: number | undefined = fctx.tdzFlagLocals?.get(name);
    if (tdzFlagIdx === undefined) {
      const tdzSlotName = `__tdz_${name}`;
      for (let i = 0; i < fctx.locals.length; i++) {
        if (fctx.locals[i]!.name === tdzSlotName) {
          tdzFlagIdx = fctx.params.length + i;
          if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
          if (!fctx.tdzFlagLocals.has(name)) fctx.tdzFlagLocals.set(name, tdzFlagIdx);
          break;
        }
      }
    }
    const hasTdzFlag = tdzFlagIdx !== undefined;
    // #1205: We previously force-boxed the value when `hasTdzFlag` was true
    // (mirroring the arrow path at closures.ts:1356). That broke 48+
    // for-await-of test262 cases because the destructure-assign codegen path
    // (`compileForOfAssignDestructuringExternref` in loops.ts:1364) writes
    // via `emitCoercedLocalSet(targetLocal, externref)` — a direct `local.set`
    // that does NOT route through `boxedCaptures.struct.set`. With the value
    // param force-boxed to `ref $T_refcell`, the externref → ref coercion
    // emits a `ref.cast_null` + `ref.as_non_null` that traps at runtime
    // ("dereferencing a null pointer in fn() at source L<for-await-line>").
    //
    // For pure flag plumbing (the body's TDZ check via `boxedTdzFlags`) we
    // do NOT need to force-box the value — FNDECL-A2..A5's flag-box param
    // alone is sufficient, and identifier reads still see the right value
    // through the regular value param when no internal write happens.
    //
    // The "writer + reader fn-decl pair sharing a TDZ-flagged outer let"
    // pattern (issue-1205.test.ts case 1) does require this force-boxing
    // for proper sharing — but that case requires Stage 1 of #1177
    // (`localMap.get(cap.name) ?? cap.outerLocalIdx`) to be re-applied AND
    // the destructure-assign path to be box-aware. Both are out of scope
    // for this PR; the test is marked `.todo` until that follow-up lands.
    const isMutable = writtenInBody.has(name) || mutatedInSiblingScope.has(name);
    // #2623 Slice A: detect a capture whose outer slot is already the canonical
    // ref cell (the outer scope boxed it). For such a name `type` above is the
    // cell ref type, so the generic mutable-capture path would re-box to a
    // cell-of-cell. Remember the outer cell's inner value type so the lifted
    // body derefs to the right depth.
    const outerBoxedEntry = fctx.boxedCaptures?.get(name);
    const alreadyBoxed = !!outerBoxedEntry;
    captures.push({
      name,
      type,
      localIdx,
      mutable: isMutable,
      hasTdzFlag,
      tdzFlagIdx,
      alreadyBoxed,
      boxedValType: outerBoxedEntry?.valType,
    });
  }

  // (#2172 / SF-1 of #2157) Wasm-native lowering for a NESTED `function*` in
  // standalone/WASI. Previously a nested generator always took the JS-host
  // buffer path (`__create_generator` etc.), which in standalone leaks env
  // imports / hits the late-import funcindex CE — the same regression #2079
  // fixed for top-level generators, but never wired for nested declarations.
  //
  // Scope: NO captures only. A capturing nested generator would need its
  // captured cells spilled into the state struct (the resume function runs
  // detached from the enclosing frame) — that's a separate, larger change
  // (`reasoning_effort: max`), so a capturing native candidate falls through to
  // the host path unchanged. A no-capture nested generator is semantically a
  // module-level function, so it slots straight into the existing top-level
  // native machinery (`registerNativeGenerator` → state struct return →
  // `compileNativeGeneratorFunction`). The funcindex hazard is already handled:
  // both the no-capture and has-captures branches reserve the function's module
  // slot with a placeholder BEFORE the body emits (#2068 / #2079).
  const nativeGenInfo =
    isGenerator && captures.length === 0 && isNativeGeneratorCandidate(ctx, stmt)
      ? registerNativeGenerator(ctx, stmt, funcName, paramTypes)
      : undefined;
  if (nativeGenInfo) {
    // The generator factory returns the state struct, not a JS Generator object.
    returnType = { kind: "ref", typeIdx: nativeGenInfo.stateTypeIdx };
  }

  const results: ValType[] = returnType ? [returnType] : [];

  // Register optional/default parameters so call sites can supply defaults
  const optionalParams: OptionalParamInfo[] = [];
  for (let i = 0; i < stmt.parameters.length; i++) {
    const param = stmt.parameters[i]!;
    if (param.questionToken || param.initializer) {
      const info: OptionalParamInfo = { index: i, type: paramTypes[i]! };
      if (param.initializer) {
        const cd = extractConstantDefault(param.initializer, paramTypes[i]!);
        if (cd) {
          info.constantDefault = cd;
        } else {
          info.hasExpressionDefault = true;
        }
      }
      optionalParams.push(info);
    }
  }
  if (optionalParams.length > 0) {
    ctx.funcOptionalParams.set(funcName, optionalParams);
  }

  // Track nested functions that read `arguments` (#1053) so callers can
  // populate the __extras_argv global with runtime args beyond the
  // formal param count.
  if (stmt.body && bodyUsesArguments(stmt.body)) {
    ctx.funcUsesArguments.add(funcName);
  }

  if (captures.length > 0 && opts.reuseReservedEntry) {
    opts.reuseReservedEntry.body = [];
    appendDefaultReturn(
      {
        name: funcName,
        params: [],
        locals: [],
        localMap: new Map(),
        returnType,
        body: opts.reuseReservedEntry.body,
        blockDepth: 0,
        breakStack: [],
        continueStack: [],
        labelMap: new Map(),
        savedBodies: [],
      },
      returnType,
    );
    return;
  }

  if (captures.length === 0) {
    // No captures — compile as a regular module-level function
    const funcTypeIdx = addFuncType(ctx, paramTypes, results, `${funcName}_type`);
    const liftedFctx: FunctionContext = {
      name: funcName,
      params: stmt.parameters.map((p, i) => ({
        name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
        type: paramTypes[i]!,
      })),
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
      // #2152 — a nested function declaration whose body references its own
      // `this` may be passed by reference as an array-HOF callback
      // (`arr.filter(callbackfn, thisArg)`), which installs the spec `thisArg`
      // into `__current_this` before the `call_ref`. Allow its `this` to read
      // that global; for direct calls the global is null and the null-guarded
      // read (#1702) falls back to `undefined` — behaviour-preserving.
      readsCurrentThis: stmt.body ? bodyReferencesOwnThis(stmt.body) : false,
    };
    for (let i = 0; i < liftedFctx.params.length; i++) {
      liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
    }

    const savedFunc = ctx.currentFunc;
    if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
    if (savedFunc) ctx.funcStack.push(savedFunc);
    ctx.currentFunc = liftedFctx;

    // (#2068) Pre-register `funcName` in `funcMap` BEFORE compiling the body
    // so self-references and forward-sibling references inside the body resolve
    // to a real direct call instead of falling through to the unknown-identifier
    // `ref.null.extern` fallback (→ `__unbox_number(null)` → 0). Mirrors the
    // has-captures branch's reserved-entry pattern (see below). The funcIdx slot
    // is claimed up-front by pushing a placeholder mod entry; `locals`/`body`
    // are filled in after compilation. Nested functions added during body
    // compile push AFTER this slot, so the array entry's identity is stable
    // across `addUnionImports` (funcMap auto-shifts).
    //
    // The earlier (#1312) note here claimed pre-registration regressed 38
    // `built-ins/Function/15.3.5.4_2-*gs.js` tests, because a top-level
    // `function g() { return g.caller; }` used to leave the self-reference as
    // `ref.null.extern` whose `null.caller` accidentally satisfied
    // `assert.throws(TypeError)`. Those tests reference `.caller`/`.arguments`,
    // which are member accesses on the function value — they do NOT call the
    // function by name, so the self-reference resolved here is for a *call*
    // (`fact(n-1)`), a different code path from a `.caller` property read. The
    // accidental-TypeError path was for the property read, not the recursive
    // call, so pre-registering the call target does not affect it.
    let reservedEntryNC: WasmFunction | undefined;
    if (!opts.reuseReservedEntry) {
      const reservedFuncIdxNC = mintDefinedFunc(ctx);
      reservedEntryNC = {
        name: funcName,
        typeIdx: funcTypeIdx,
        locals: [],
        body: [],
        exported: false,
      };
      pushDefinedFunc(ctx, reservedFuncIdxNC, reservedEntryNC);
      ctx.funcMap.set(funcName, reservedFuncIdxNC);
    }

    // Emit default-value initialization for parameters with initializers
    emitDefaultParamInit(ctx, liftedFctx, stmt, paramTypes, 0);

    // Destructure parameters with binding patterns
    // (#3024) Keep the param-default materialization body reachable for the
    // nested-default field-pad patch (see function-body.ts / statements/
    // destructuring.ts for the full rationale).
    const pdBodyNC = liftedFctx.body;
    const pdLiveNC = ctx.liveBodies.has(pdBodyNC);
    if (!pdLiveNC) ctx.liveBodies.add(pdBodyNC);
    for (let pi = 0; pi < stmt.parameters.length; pi++) {
      const param = stmt.parameters[pi]!;
      if (ts.isObjectBindingPattern(param.name)) {
        destructureParamObject(ctx, liftedFctx, pi, param.name, paramTypes[pi]!);
      } else if (ts.isArrayBindingPattern(param.name)) {
        destructureParamArray(ctx, liftedFctx, pi, param.name, paramTypes[pi]!);
      }
    }
    if (!pdLiveNC) ctx.liveBodies.delete(pdBodyNC);

    // Set up `arguments` object if the function body references it.
    // (#2743) Unmapped when strict OR the parameter list is non-simple
    // (rest/default/destructuring) — §10.2.11 FunctionDeclarationInstantiation
    // step 22.a.
    if (stmt.body && bodyUsesArguments(stmt.body)) {
      const unmapped =
        isStrictFunction(stmt, ctx.inferModuleStrictArguments) || !isSimpleParameterList(stmt.parameters);
      emitArgumentsObject(ctx, liftedFctx, paramTypes, 0, unmapped);
      // (#2676) Expose this nested mapped function's live `mappedArgsInfo` keyed
      // by its declaration node so a `delete args[i]` in a deeper (strict)
      // closure can resolve an aliased `arguments` (`var args = arguments`) back
      // to this function's per-index `nonConfigurableIndices`.
      if (liftedFctx.mappedArgsInfo) ctx.mappedArgsInfoByFunc.set(stmt, liftedFctx.mappedArgsInfo);
    }

    if (nativeGenInfo) {
      // (#2172) No-capture nested `function*` in standalone/WASI — emit the
      // Wasm-native generator factory (builds + returns the state struct), the
      // same body the top-level path emits. No host imports, no JS buffer.
      compileNativeGeneratorFunction(ctx, liftedFctx, stmt, nativeGenInfo);
    } else if (isGenerator && isAsync && isAsyncGenDriveCandidate(ctx, stmt)) {
      // (#2865) NESTED async-generator producer (the dominant test262 shape —
      // the runner wraps every test body inside `export function test()`, so
      // the gen declaration is nested). Same interception the top-level
      // `function-body.ts` path applies BEFORE the buffer/#680 arm: build the
      // lazy `$AsyncFrame` carrier + the per-gen `__async_gen_next_<name>`
      // driver on the async-frame CFG machine. No captures in this branch, so
      // the frame captures the declared params only.
      emitAsyncGenerator(ctx, liftedFctx, stmt);
    } else if (isGenerator) {
      // Generator function: eagerly evaluate body, collect yields into a JS array,
      // then wrap it with __create_generator to return a Generator-like object.
      // The body is wrapped in try/catch so that exceptions thrown before any yields
      // are captured as a "pending throw" and deferred to the first next() call,
      // matching lazy generator semantics (#928).
      const bufferLocal = allocLocal(liftedFctx, "__gen_buffer", { kind: "externref" });
      const pendingThrowLocal = allocLocal(liftedFctx, "__gen_pending_throw", { kind: "externref" });
      const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
      liftedFctx.body.push({ op: "call", funcIdx: createBufIdx });
      liftedFctx.body.push({ op: "local.set", index: bufferLocal });
      liftedFctx.body.push({ op: "ref.null.extern" });
      liftedFctx.body.push({ op: "local.set", index: pendingThrowLocal });

      const bodyInstrs: Instr[] = [];
      const outerBody = liftedFctx.body;
      liftedFctx.body = bodyInstrs;

      liftedFctx.generatorReturnDepth = 0;
      liftedFctx.blockDepth++;
      for (let i = 0; i < liftedFctx.breakStack.length; i++) liftedFctx.breakStack[i]!++;
      for (let i = 0; i < liftedFctx.continueStack.length; i++) liftedFctx.continueStack[i]!++;

      for (const s of stmt.body.statements) {
        compileStatement(ctx, liftedFctx, s);
      }

      liftedFctx.blockDepth--;
      for (let i = 0; i < liftedFctx.breakStack.length; i++) liftedFctx.breakStack[i]!--;
      for (let i = 0; i < liftedFctx.continueStack.length; i++) liftedFctx.continueStack[i]!--;
      liftedFctx.generatorReturnDepth = undefined;

      liftedFctx.body = outerBody;

      // Wrap generator body block in try/catch to capture exceptions as pending throw
      const tagIdx = ensureExnTag(ctx);
      const getCaughtIdx = ctx.funcMap.get("__get_caught_exception");
      const catchBody: Instr[] = [{ op: "local.set", index: pendingThrowLocal }];
      const catchAllBody: Instr[] =
        getCaughtIdx !== undefined
          ? [{ op: "call", funcIdx: getCaughtIdx } as Instr, { op: "local.set", index: pendingThrowLocal }]
          : [];
      liftedFctx.body.push({
        op: "try",
        blockType: { kind: "empty" },
        body: [{ op: "block", blockType: { kind: "empty" }, body: bodyInstrs }],
        catches: [{ tagIdx, body: catchBody }],
        catchAll: catchAllBody.length > 0 ? catchAllBody : undefined,
      });

      // Return __create_generator or __create_async_generator depending on async flag
      const createGenName = isAsync ? "__create_async_generator" : "__create_generator";
      // (#2865) Record legacy-buffer async gens so the .next() dispatch keeps a host miss arm.
      if (createGenName === "__create_async_generator") ctx.asyncGenLegacyBufferEmitted = true;
      const createGenIdx = ctx.funcMap.get(createGenName)!;
      liftedFctx.body.push({ op: "local.get", index: bufferLocal });
      liftedFctx.body.push({ op: "local.get", index: pendingThrowLocal });
      liftedFctx.body.push({ op: "call", funcIdx: createGenIdx });
    } else {
      for (const s of stmt.body.statements) {
        compileStatement(ctx, liftedFctx, s);
      }
      appendDefaultReturn(liftedFctx, returnType);
    }
    if (savedFunc) ctx.funcStack.pop();
    if (savedFunc) ctx.parentBodiesStack.pop();
    ctx.currentFunc = savedFunc;

    if (opts.reuseReservedEntry) {
      opts.reuseReservedEntry.typeIdx = funcTypeIdx;
      opts.reuseReservedEntry.locals = liftedFctx.locals;
      opts.reuseReservedEntry.body = liftedFctx.body;
    } else {
      // (#2068) Fill in the reserved entry pre-registered above with the
      // compiled locals/body. The funcMap entry + mod.functions slot were
      // claimed before body compilation so recursive / forward-sibling
      // references resolved to a direct call.
      reservedEntryNC!.typeIdx = funcTypeIdx;
      reservedEntryNC!.locals = liftedFctx.locals;
      reservedEntryNC!.body = liftedFctx.body;
    }
  } else {
    // Has captures — lift with captures as leading parameters, use direct call
    // For mutable captures, use ref cell types so writes propagate back
    const valueCaptureParamTypes: ValType[] = captures.map((c) => {
      if (c.mutable) {
        // #2623 Slice A: when the outer slot is ALREADY the canonical cell,
        // thread it through unchanged (single box) rather than wrapping again
        // into a cell-of-cell — the construction site (emitFuncRefAsClosure)
        // pushes the existing cell when `boxedCaptures.has(name)`, and the
        // lifted body's struct.get/set must match that single depth.
        if (c.alreadyBoxed) {
          return c.type;
        }
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, c.type);
        return { kind: "ref" as const, typeIdx: refCellTypeIdx };
      }
      return c.type;
    });
    // #1205 Stage 3: TDZ-flag ref-cell types come AFTER value captures. The
    // layout matches the arrow path (closures.ts:1431-1445):
    //   [valueCap_0, ..., valueCap_N-1, tdzFlagBox_0, ..., tdzFlagBox_K-1, ...userParams]
    const tdzFlaggedCaptures = captures.filter((c) => c.hasTdzFlag);
    const i32RefCellTypeIdx = tdzFlaggedCaptures.length > 0 ? getOrRegisterRefCellType(ctx, { kind: "i32" }) : -1;
    const tdzFlagParamTypes: ValType[] = tdzFlaggedCaptures.map(() => ({
      kind: "ref" as const,
      typeIdx: i32RefCellTypeIdx,
    }));
    const captureParamTypes: ValType[] = [...valueCaptureParamTypes, ...tdzFlagParamTypes];
    const allParamTypes = [...captureParamTypes, ...paramTypes];

    // (#3050) CAPTURING nested `function*` whose body needs the try-region
    // machinery (catch across yield / yielding finally — shapes the eager
    // buffer PROVABLY cannot express, GeneratorPrototype/throw/try-*): lower it
    // on the native state machine with the captures riding as leading synthetic
    // params. Mutable captures are already `ref $cell` params here, so writes
    // inside resume states propagate to the enclosing frame through the shared
    // cell; the state struct stores the cells/values as ordinary `param_*`
    // fields and the call site's existing `nestedFuncCaptures` prepend supplies
    // them — no call-site changes. Scope bails (keep today's eager path):
    //   - TDZ-flagged captures (flag-box plumbing not modeled in the resume fn);
    //   - async generators;
    //   - anything the plan builder rejects (isNativeGeneratorCandidate).
    // Generators withOUT a new-region shape keep the eager path in BOTH lanes —
    // this is deliberately try-region-scoped so working eager/shim generators
    // are untouched (#2172's no-capture native path is also unchanged).
    let capturingNativeGen: ReturnType<typeof registerNativeGenerator> = null;
    if (
      isGenerator &&
      !isAsync &&
      tdzFlaggedCaptures.length === 0 &&
      bodyHasNewTryRegionAcrossYield(stmt) &&
      isNativeGeneratorCandidate(ctx, stmt)
    ) {
      const leadingCaptures: NativeGeneratorCaptureParam[] = captures.map((c, i) => {
        const t = valueCaptureParamTypes[i]!;
        if (c.mutable && (t.kind === "ref" || t.kind === "ref_null")) {
          return {
            name: c.name,
            boxed: {
              refCellTypeIdx: t.typeIdx,
              // #2623: an already-boxed outer slot IS the cell — deref to its
              // inner value type; a freshly-minted cell derefs to the local's.
              valType: c.alreadyBoxed ? (c.boxedValType ?? { kind: "f64" }) : c.type,
            },
          };
        }
        // Immutable capture whose outer slot is already the canonical cell:
        // deref through it too (mirrors the lifted-body registration below).
        const outerBoxed = fctx.boxedCaptures?.get(c.name);
        if (outerBoxed && (c.type.kind === "ref" || c.type.kind === "ref_null")) {
          return {
            name: c.name,
            boxed: { refCellTypeIdx: outerBoxed.refCellTypeIdx, valType: outerBoxed.valType },
          };
        }
        return { name: c.name };
      });
      capturingNativeGen = registerNativeGenerator(ctx, stmt, funcName, allParamTypes, false, leadingCaptures);
      if (capturingNativeGen) {
        // The generator factory returns the state struct, not a JS Generator object.
        returnType = { kind: "ref", typeIdx: capturingNativeGen.stateTypeIdx };
      }
    }
    const liftedResults: ValType[] = capturingNativeGen && returnType ? [returnType] : results;

    const funcTypeIdx = addFuncType(ctx, allParamTypes, liftedResults, `${funcName}_type`);
    const liftedFctx: FunctionContext = {
      name: funcName,
      params: [
        ...captures.map((c, i) => ({ name: c.name, type: valueCaptureParamTypes[i]! })),
        // #1205 Stage 3: extra leading params for TDZ flag boxes.
        ...tdzFlaggedCaptures.map((c) => ({
          name: `__tdz_box_${c.name}`,
          type: { kind: "ref" as const, typeIdx: i32RefCellTypeIdx },
        })),
        ...stmt.parameters.map((p, i) => ({
          name: ts.isIdentifier(p.name) ? p.name.text : `__param${i}`,
          type: paramTypes[i]!,
        })),
      ],
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
      // #2152 — a nested function declaration whose body references its own
      // `this` may be passed by reference as an array-HOF callback
      // (`arr.filter(callbackfn, thisArg)`), which installs the spec `thisArg`
      // into `__current_this` before the `call_ref`. Allow its `this` to read
      // that global; for direct calls the global is null and the null-guarded
      // read (#1702) falls back to `undefined` — behaviour-preserving.
      readsCurrentThis: stmt.body ? bodyReferencesOwnThis(stmt.body) : false,
    };
    for (let i = 0; i < liftedFctx.params.length; i++) {
      liftedFctx.localMap.set(liftedFctx.params[i]!.name, i);
    }

    // Register mutable captures as boxed so reads/writes use struct.get/set.
    // Also register non-mutable captures that are already boxed in the outer
    // scope, so the body code dereferences through the ref cell.
    for (const cap of captures) {
      if (cap.mutable) {
        // #2623 Slice A: when the outer slot is already the canonical cell, the
        // param carries that cell type directly (see valueCaptureParamTypes
        // above). Register the EXISTING cell's typeidx + its inner value type so
        // the lifted body's struct.get/set deref exactly once to the value
        // (matching the single-box param), not twice through a cell-of-cell.
        if (cap.alreadyBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
          const refCellTypeIdx = (cap.type as { typeIdx: number }).typeIdx;
          if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
          liftedFctx.boxedCaptures.set(cap.name, {
            refCellTypeIdx,
            valType: cap.boxedValType ?? { kind: "f64" },
          });
          continue;
        }
        const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.type);
        if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
        liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.type });
      } else {
        const outerBoxed = fctx.boxedCaptures?.get(cap.name);
        if (outerBoxed && (cap.type.kind === "ref" || cap.type.kind === "ref_null")) {
          if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
          liftedFctx.boxedCaptures.set(cap.name, {
            refCellTypeIdx: outerBoxed.refCellTypeIdx,
            valType: outerBoxed.valType,
          });
        }
      }
    }

    // #1205 Stage 3: register TDZ-flag boxed params so identifier reads
    // inside the body route through `struct.get` on the i32 ref cell, and
    // emitLocalTdzInit (for any inner `let __tdz_<name>` shadowing) finds
    // the box via tdzFlagLocals. Mirror closures.ts:1577-1603.
    //
    // The flag is a *param*, not an alloc'd local. We register the param
    // index directly. All `boxedTdzFlags` consumers (`emitLocalTdzCheck` in
    // expressions/identifiers.ts, the call-site check at calls.ts) only
    // `local.get $flagBoxLocal; struct.get` — they don't care whether the
    // slot is a param or a local.
    if (tdzFlaggedCaptures.length > 0) {
      for (let ti = 0; ti < tdzFlaggedCaptures.length; ti++) {
        const cap = tdzFlaggedCaptures[ti]!;
        // Param index: captures.length value-params then ti flag-params.
        const flagParamIdx = captures.length + ti;
        if (!liftedFctx.boxedTdzFlags) liftedFctx.boxedTdzFlags = new Map();
        liftedFctx.boxedTdzFlags.set(cap.name, {
          refCellTypeIdx: i32RefCellTypeIdx,
          localIdx: flagParamIdx,
        });
        if (!liftedFctx.tdzFlagLocals) liftedFctx.tdzFlagLocals = new Map();
        liftedFctx.tdzFlagLocals.set(cap.name, flagParamIdx);
      }
    }

    const savedFunc = ctx.currentFunc;
    if (savedFunc) ctx.parentBodiesStack.push(savedFunc.body);
    if (savedFunc) ctx.funcStack.push(savedFunc);
    ctx.currentFunc = liftedFctx;

    // (#1312) Pre-register `funcMap` + `nestedFuncCaptures` BEFORE compiling
    // the body so self-references inside the body resolve correctly. Without
    // this, `function next() { return call(next); }` falls through to the
    // graceful `ref.null.extern` fallback in identifiers.ts because the
    // funcMap lookup misses — and the recursive `call_ref` then null-derefs
    // at runtime ("TypeError: Cannot access property on null or undefined").
    //
    // The funcIdx slot is claimed up-front by pushing a placeholder mod
    // entry; the body and locals are filled in below after compilation.
    // Any nested function/wrapper added during body compile pushes AFTER
    // this slot, so the slot's POSITION in mod.functions is stable.
    // We remember the position by saving the `mod.functions[]` entry
    // reference itself — that's the only thing that survives unchanged
    // across `addUnionImports` (which can grow `numImportFuncs` and so
    // shift the absolute funcIdx, but the array entry's identity is
    // preserved). funcMap auto-shifts during addUnionImports.
    const reservedFuncIdx = mintDefinedFunc(ctx);
    const reservedEntry = {
      name: funcName,
      typeIdx: funcTypeIdx,
      locals: [] as Array<{ name: string; type: ValType }>,
      body: [] as Instr[],
      exported: false,
    };
    pushDefinedFunc(ctx, reservedFuncIdx, reservedEntry);
    ctx.funcMap.set(funcName, reservedFuncIdx);
    ctx.nestedFuncCaptures.set(
      funcName,
      captures.map((c) => ({
        name: c.name,
        outerLocalIdx: c.localIdx,
        mutable: c.mutable,
        valType: c.type,
        hasTdzFlag: c.hasTdzFlag,
        outerTdzFlagIdx: c.tdzFlagIdx,
      })),
    );

    // (#2758) Pre-box any by-value capture that a sibling this function CALLS
    // mutably captures, BEFORE the parameter default-init / destructuring below
    // can emit that call inside a conditionally-executed default `then`-arm.
    // Collect callee references from BOTH the body AND the parameter default
    // initializers — a destructuring default `{ w = counter() }` calls `counter`
    // from the PARAMETER list, which the body-only `referencedNames` scan misses.
    {
      const referencedCalleeNames = new Set<string>(referencedNames);
      for (const p of stmt.parameters) {
        collectReferencedIdentifiers(p, referencedCalleeNames, ownLocals);
      }
      emitEagerNestedCallCaptureBoxes(ctx, liftedFctx, captures, referencedCalleeNames);
    }

    // #2669: the user parameters are preceded by BOTH the value-capture params
    // AND the TDZ-flag-box params (layout above:
    //   [valueCap_0..N-1, tdzFlagBox_0..K-1, userParam_0..]).
    // The leading offset for default-init / destructuring / arguments must be
    // `captures.length + tdzFlaggedCaptures.length`, NOT just `captures.length`.
    // Using `captures.length` alone (ignoring the K TDZ-flag boxes) made a
    // capturing function with a *destructuring* param read the wrong param slot
    // — e.g. `let length="outer"; function f([...{length:z}]){ ...length... }`
    // (a TDZ-flagged `let`/read capture) destructured a TDZ i32-flag cell as the
    // array argument → invalid Wasm (`any.convert_extern` on a non-externref).
    // `var` write-only captures have no TDZ flag (K=0) so they were unaffected,
    // which is why `callCount`-style tests compiled while the `length`-read dstr
    // family trapped.
    const leadingParamCount = captures.length + tdzFlaggedCaptures.length;

    // Emit default-value initialization for parameters with initializers
    // (offset by all prepended leading params — value captures + TDZ flag boxes)
    emitDefaultParamInit(ctx, liftedFctx, stmt, paramTypes, leadingParamCount);

    // Destructure parameters with binding patterns (offset by leading params)
    // (#3024) Keep the param-default materialization body reachable for the
    // nested-default field-pad patch (see function-body.ts / statements/
    // destructuring.ts for the full rationale).
    const pdBodyNC2 = liftedFctx.body;
    const pdLiveNC2 = ctx.liveBodies.has(pdBodyNC2);
    if (!pdLiveNC2) ctx.liveBodies.add(pdBodyNC2);
    for (let pi = 0; pi < stmt.parameters.length; pi++) {
      const param = stmt.parameters[pi]!;
      const paramIdx = leadingParamCount + pi;
      if (ts.isObjectBindingPattern(param.name)) {
        destructureParamObject(ctx, liftedFctx, paramIdx, param.name, paramTypes[pi]!);
      } else if (ts.isArrayBindingPattern(param.name)) {
        destructureParamArray(ctx, liftedFctx, paramIdx, param.name, paramTypes[pi]!);
      }
    }
    if (!pdLiveNC2) ctx.liveBodies.delete(pdBodyNC2);

    // Set up `arguments` object if the function body references it.
    // (#2743) Unmapped when strict OR the parameter list is non-simple
    // (rest/default/destructuring) — §10.2.11 step 22.a.
    if (stmt.body && bodyUsesArguments(stmt.body)) {
      const unmapped =
        isStrictFunction(stmt, ctx.inferModuleStrictArguments) || !isSimpleParameterList(stmt.parameters);
      emitArgumentsObject(ctx, liftedFctx, paramTypes, leadingParamCount, unmapped);
      // (#2676) See the sibling site above — expose the live `mappedArgsInfo`
      // by decl node for aliased-`arguments` strict-delete resolution.
      if (liftedFctx.mappedArgsInfo) ctx.mappedArgsInfoByFunc.set(stmt, liftedFctx.mappedArgsInfo);
    }

    if (capturingNativeGen) {
      // (#3050) Capturing nested SYNC `function*` with a try-region body — emit
      // the Wasm-native generator factory. It reads EVERY wasm param (capture
      // cells and values first, then user params — exactly this lifted
      // function's param layout) into the state struct's `param_*` fields; the
      // resume function rehydrates them and routes cell captures through
      // `boxedCaptures` (see ensureNativeGeneratorResumeFunction). Disjoint
      // from the #2865 async-gen arm below: `capturingNativeGen` is only
      // registered for `!isAsync` declarations.
      compileNativeGeneratorFunction(ctx, liftedFctx, stmt, capturingNativeGen);
    } else if (isGenerator && isAsync && tdzFlaggedCaptures.length === 0 && isAsyncGenDriveCandidate(ctx, stmt)) {
      // (#2865) NESTED async-generator producer WITH captures — the dominant
      // real test262 shape (`var callCount = 0; async function* f() {
      // callCount++; ... }` inside the runner's `test()` wrapper: callCount is
      // a test() local, so the gen captures it as a mutable ref cell). The
      // lifted fn's leading capture-cell params are captured into `$AsyncFrame`
      // param fields like ordinary params; `emitAsyncGenerator` threads
      // `liftedFctx.boxedCaptures` onto the resume fn so body reads/writes
      // deref the cells. TDZ-flagged captures store PARAM indices in
      // `boxedTdzFlags` (wrong in the resume fn's local layout) → legacy.
      emitAsyncGenerator(ctx, liftedFctx, stmt);
    } else if (isGenerator) {
      // Generator function: eagerly evaluate body, collect yields into a JS array,
      // then wrap it with __create_generator to return a Generator-like object.
      // The body is wrapped in try/catch so that exceptions thrown before any yields
      // are captured as a "pending throw" and deferred to the first next() call,
      // matching lazy generator semantics (#928).
      const bufferLocal = allocLocal(liftedFctx, "__gen_buffer", { kind: "externref" });
      const pendingThrowLocal = allocLocal(liftedFctx, "__gen_pending_throw", { kind: "externref" });
      const createBufIdx = ctx.funcMap.get("__gen_create_buffer")!;
      liftedFctx.body.push({ op: "call", funcIdx: createBufIdx });
      liftedFctx.body.push({ op: "local.set", index: bufferLocal });
      liftedFctx.body.push({ op: "ref.null.extern" });
      liftedFctx.body.push({ op: "local.set", index: pendingThrowLocal });

      const bodyInstrs: Instr[] = [];
      const outerBody = liftedFctx.body;
      liftedFctx.body = bodyInstrs;

      liftedFctx.generatorReturnDepth = 0;
      liftedFctx.blockDepth++;
      for (let i = 0; i < liftedFctx.breakStack.length; i++) liftedFctx.breakStack[i]!++;
      for (let i = 0; i < liftedFctx.continueStack.length; i++) liftedFctx.continueStack[i]!++;

      for (const s of stmt.body.statements) {
        compileStatement(ctx, liftedFctx, s);
      }

      liftedFctx.blockDepth--;
      for (let i = 0; i < liftedFctx.breakStack.length; i++) liftedFctx.breakStack[i]!--;
      for (let i = 0; i < liftedFctx.continueStack.length; i++) liftedFctx.continueStack[i]!--;
      liftedFctx.generatorReturnDepth = undefined;

      liftedFctx.body = outerBody;

      // Wrap generator body block in try/catch to capture exceptions as pending throw
      const tagIdx = ensureExnTag(ctx);
      const getCaughtIdx = ctx.funcMap.get("__get_caught_exception");
      const catchBody: Instr[] = [{ op: "local.set", index: pendingThrowLocal }];
      const catchAllBody: Instr[] =
        getCaughtIdx !== undefined
          ? [{ op: "call", funcIdx: getCaughtIdx } as Instr, { op: "local.set", index: pendingThrowLocal }]
          : [];
      liftedFctx.body.push({
        op: "try",
        blockType: { kind: "empty" },
        body: [{ op: "block", blockType: { kind: "empty" }, body: bodyInstrs }],
        catches: [{ tagIdx, body: catchBody }],
        catchAll: catchAllBody.length > 0 ? catchAllBody : undefined,
      });

      // Return __create_generator or __create_async_generator depending on async flag
      const createGenName = isAsync ? "__create_async_generator" : "__create_generator";
      // (#2865) Record legacy-buffer async gens so the .next() dispatch keeps a host miss arm.
      if (createGenName === "__create_async_generator") ctx.asyncGenLegacyBufferEmitted = true;
      const createGenIdx = ctx.funcMap.get(createGenName)!;
      liftedFctx.body.push({ op: "local.get", index: bufferLocal });
      liftedFctx.body.push({ op: "local.get", index: pendingThrowLocal });
      liftedFctx.body.push({ op: "call", funcIdx: createGenIdx });
    } else {
      for (const s of stmt.body.statements) {
        compileStatement(ctx, liftedFctx, s);
      }
      appendDefaultReturn(liftedFctx, returnType);
    }
    if (savedFunc) ctx.funcStack.pop();
    if (savedFunc) ctx.parentBodiesStack.pop();
    ctx.currentFunc = savedFunc;

    // (#1312) Fill in the body/locals of the slot we reserved above. funcMap
    // and nestedFuncCaptures were already registered before body compile so
    // self-references inside the body resolved correctly. Use the saved
    // entry reference instead of recomputing the index — `addUnionImports`
    // may have shifted `ctx.numImportFuncs` since registration.
    reservedEntry.locals = liftedFctx.locals;
    reservedEntry.body = liftedFctx.body;
  }
}

/**
 * Pre-pass: hoist function declarations inside a function body.
 * JavaScript semantics require function declarations to be available
 * before their textual position in the enclosing scope.
 * This pre-compiles them so they are in funcMap before other statements run.
 *
 * If a function fails to compile during hoisting (e.g., uses unsupported features),
 * it is rolled back and will be re-attempted during normal statement compilation.
 */
/** (#2200) Is `node` a scope boundary for var/function hoisting (a function-like
 * or the source file)? Annex B B.3.3 only applies to a `function` nested in a
 * *block* up to the enclosing function/global scope. */
function isAnnexBScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node)
  );
}

/** (#2200) Does a Block (or case clause / module body) lexically bind `name` via
 * a top-level `let`/`const`/class declaration? */
function blockBindsLexically(stmts: ts.NodeArray<ts.Statement> | ts.Statement[], name: string): boolean {
  for (const s of stmts) {
    if (ts.isVariableStatement(s) && (s.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) return true;
      }
    }
    if (ts.isClassDeclaration(s) && s.name?.text === name) return true;
  }
  return false;
}

/**
 * (#2200, Annex B B.3.3) Decide whether a block-nested `function` declaration's
 * web-compat outer var-binding is *cancelled*. Returns the declaring `Block`
 * (so the caller can record its position range) when the function is block-nested
 * AND an intervening lexical (`let`/`const`/class) binding for the same name
 * exists between the block and the enclosing function/global scope, OR a
 * same-named parameter exists; otherwise `null` (not block-nested, or eligible
 * for the outer binding — left to the existing unconditional hoist).
 *
 * Per §B.3.3.1: the outer binding is created only when replacing the function
 * with `var F` would not produce an early error — i.e. no intervening lexical
 * `F` and `F` is not a parameter. Strict-mode functions get no Annex B outer
 * binding at all, but a *cancelled* binding behaves the same observable way for
 * case A (reading `F` outside the block throws), so strict mode is not gated
 * here.
 */
function annexBHoistCancels(fnDecl: ts.FunctionDeclaration): ts.Block | null {
  const name = fnDecl.name?.text;
  if (!name || !fnDecl.body) return null;
  const block = fnDecl.parent;
  // Must be directly inside a Block (not the function body itself, not a case
  // clause statement list, etc.). A direct function-body decl keeps its hoist.
  if (!ts.isBlock(block)) return null;
  if (isAnnexBScopeBoundary(block.parent)) return null; // block IS the fn body → direct decl

  // The block that holds the function may itself carry a sibling lexical shadow.
  if (blockBindsLexically(block.statements, name)) return block;

  // Walk up from the holding block to the enclosing fn/global, checking each
  // intervening Block for a lexical binding, and the enclosing function's params.
  let node: ts.Node = block.parent;
  while (node && !isAnnexBScopeBoundary(node)) {
    if (ts.isBlock(node) && blockBindsLexically(node.statements, name)) return block;
    if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      if (blockBindsLexically(node.statements, name)) return block;
    }
    node = node.parent;
  }
  // node is now the enclosing function/global boundary. If it is a function with
  // a parameter named `name`, the Annex B hoist is also cancelled (§B.3.3 param
  // exclusion).
  if (node && !ts.isSourceFile(node) && !ts.isModuleBlock(node) && "parameters" in node) {
    const params = (node as ts.FunctionLikeDeclarationBase).parameters;
    if (params?.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) return block;
  }
  return null;
}

/**
 * (#2552) Is the block-fn name `name` OBSERVED at function scope OUTSIDE its
 * declaring `block`? — i.e. is there a value reference to `name` somewhere in the
 * enclosing Annex-B scope (the nearest function/global boundary containing
 * `block`) that is NOT lexically inside `block` and NOT the declaration's own
 * name?
 *
 * This is the #2552 narrowing. Phase 2 (PR #1769) pre-allocated the outer
 * var-binding (an externref TDZ local + an i32 flag) for EVERY structurally
 * eligible block-nested function. That perturbed local-index layout for the
 * dominant test262 harness shape — a function that merely *contains* a
 * block-nested helper (Array-method and dstr test files wrap assertions + fns
 * in blocks) — and the full gate flagged -1180 (`wasm_compile`/`null_deref` in
 * `Array/prototype` + dstr buckets). The outer binding is only OBSERVABLE via a
 * reference to `name` outside the block; when there is none, the pre-Phase-2
 * codegen (no alloc, no flag, no `annexBOuterBindings` entry) is fully correct
 * and must stay byte-identical. Restricting allocation to the observed case
 * keeps the hot path untouched while still implementing the case-B lifecycle
 * where it is actually visible.
 */
function annexBNameObservedOutsideBlock(name: string, block: ts.Block): boolean {
  // Find the enclosing Annex-B scope (function body / source file) holding `block`.
  let scope: ts.Node = block.parent;
  while (scope && !isAnnexBScopeBoundary(scope)) scope = scope.parent;
  if (!scope) return false;
  // For a function-like boundary, scan its body; for SourceFile/ModuleBlock, the
  // node itself is the statement container.
  const scanRoot: ts.Node =
    !ts.isSourceFile(scope) && !ts.isModuleBlock(scope) && "body" in scope
      ? ((scope as ts.FunctionLikeDeclarationBase).body ?? scope)
      : scope;

  let observed = false;
  const visit = (node: ts.Node): void => {
    if (observed) return;
    // Do not descend into the declaring block itself — references there are the
    // function's own scope, not the outer binding.
    if (node === block) return;
    // Do not cross into a NESTED function scope (it has its own bindings; a
    // same-named decl there shadows and is handled on its own pass). The
    // `scanRoot` boundary itself is allowed (we started inside it).
    if (node !== scanRoot && isAnnexBScopeBoundary(node)) return;
    if (ts.isIdentifier(node) && node.text === name && isAnnexBValueReference(node)) {
      observed = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scanRoot, visit);
  return observed;
}

/**
 * (#2552) True when identifier `id` is a value *reference* that could observe the
 * Annex B outer binding — excludes property names (`obj.F`, `{F: …}`),
 * declaration names (the binding sites), and labels. A bare `F`, `typeof F`,
 * `F()`, `F` as an argument, etc. count.
 */
function isAnnexBValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if (ts.isQualifiedName(parent) && parent.right === id) return false;
  if ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === id) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isBindingElement(parent)) &&
    (parent as { name?: ts.Node }).name === id
  ) {
    return false;
  }
  if (
    (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) &&
    parent.label === id
  ) {
    return false;
  }
  return true;
}

/**
 * (#2552) Is the block-fn `name` REASSIGNED (an assignment write target) anywhere
 * inside its declaring `block`? — e.g. `{ function f() { f = 123; } }`. When it
 * is, the block-local function binding and the outer var binding hold *distinct*
 * values (per §B.3.3: the outer binding captures the function value at block
 * entry and is independent of a later in-block reassignment of the block-local
 * `f`). The flag-gated single-slot outer-binding machinery cannot model that
 * split (it shares one `localMap` slot for both), so such a shape is excluded
 * from the outer-binding allocation and reverts to the pre-Phase-2 path — which
 * already passes the `*-block-scoping` test262 files. Only assignment WRITES
 * count (not reads); the scan stays within the declaring block (nested function
 * scopes are skipped — they have their own bindings).
 */
function annexBNameReassignedInBlock(name: string, block: ts.Block): boolean {
  let reassigned = false;
  const visit = (node: ts.Node): void => {
    if (reassigned) return;
    // Descend through the WHOLE block subtree, INCLUDING the block-fn's own body:
    // the canonical mutable-binding shape is `{ function f() { f = 123; } }`, where
    // the reassignment lives inside `f`'s body and still mutates the binding (the
    // block-local `f` and the outer var binding then diverge). A same-named decl in
    // a *deeper* nested scope would shadow, but conflating it here only makes the
    // gate MORE conservative (skip the outer binding → pre-Phase-2 path), never
    // less correct, so we accept the slight over-approximation for soundness.
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      node.left.text === name
    ) {
      reassigned = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(block, visit);
  return reassigned;
}

/**
 * (#2552) Does the enclosing Annex-B scope (the nearest function body / global
 * holding `block`) already declare a function-scoped `var name`? Per Annex B
 * B.3.3 step 2 ("If instantiatedVarNames does not contain F"), a block-nested
 * `function F` creates NO fresh outer binding when a same-named `var F` already
 * exists — the function uses the existing var. `var` declarations hoist
 * function-wide, so a `var F` ANYWHERE in the enclosing scope (including nested
 * blocks) counts, but NOT one inside a nested function scope. Excluding this case
 * keeps the existing-var binding (often a non-externref slot, e.g. an f64 number)
 * as the single home for `F`; allocating a separate externref outer binding on
 * top of it desyncs the type (a read would wrongly go through the externref path
 * → `expected externref, got f64`).
 */
function annexBSameNameVarInScope(name: string, block: ts.Block): boolean {
  let scope: ts.Node = block.parent;
  while (scope && !isAnnexBScopeBoundary(scope)) scope = scope.parent;
  if (!scope) return false;
  const scanRoot: ts.Node =
    !ts.isSourceFile(scope) && !ts.isModuleBlock(scope) && "body" in scope
      ? ((scope as ts.FunctionLikeDeclarationBase).body ?? scope)
      : scope;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // Do not descend into a nested function scope (its `var name` is a different
    // binding). The scanRoot boundary itself is allowed (we started inside it).
    if (node !== scanRoot && isAnnexBScopeBoundary(node)) return;
    if (ts.isVariableStatement(node) && (node.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(scanRoot, visit);
  return found;
}

/**
 * (#2200 Phase 2) Is `fnDecl` a block-nested function that IS eligible for the
 * Annex B web-compat outer var-binding (block-nested AND not cancelled)? Returns
 * the declaring `Block` (for the pre-allocation / decl-site init), else `null`
 * (direct function-body decl, or cancelled — Phase 1 handles the latter).
 *
 * (#2552) ADDITIONALLY narrowed: the outer binding is only allocated when the
 * name is OBSERVED outside the declaring block (see
 * `annexBNameObservedOutsideBlock`). A block-fn whose name is never referenced
 * at function scope outside its block needs no outer binding, so it stays
 * byte-identical to pre-Phase-2 codegen — this is what avoids the -1180 hot-path
 * regression. The name must ALSO not be reassigned inside its block (see
 * `annexBNameReassignedInBlock`) — the mutable-binding split is beyond the
 * single-slot flag-gated machinery and reverts to the (passing) pre-Phase-2 path.
 */
function annexBBlockNestedEligible(fnDecl: ts.FunctionDeclaration): ts.Block | null {
  const name = fnDecl.name?.text;
  if (!name || !fnDecl.body) return null;
  const block = fnDecl.parent;
  if (!ts.isBlock(block)) return null;
  if (isAnnexBScopeBoundary(block.parent)) return null; // direct fn body → not block-nested
  if (annexBHoistCancels(fnDecl) !== null) return null; // cancelled → Phase 1, no outer binding
  if (!annexBNameObservedOutsideBlock(name, block)) return null; // (#2552) not observed → no binding
  if (annexBNameReassignedInBlock(name, block)) return null; // (#2552) mutable split → pre-Phase-2 path
  if (annexBSameNameVarInScope(name, block)) return null; // (#2552) existing var F → use it, no fresh binding
  return block;
}

/**
 * (#2692) Eagerly materialize the ref-cell box for each mutable variable
 * captured by a successfully-hoisted nested `function` declaration.
 *
 * Background: a mutable captured variable (written by a nested function) is
 * boxed into a `struct (field $value (mut T))` so writes propagate across the
 * scope boundary. Historically the box was created LAZILY at the FIRST
 * capturing call site (`calls.ts` `nestedFuncCaptures` mutable branch). The
 * compile-time re-aim of `fctx.localMap`/`fctx.boxedCaptures` is global to the
 * function context, but the runtime `struct.new` + `local.set` landed in
 * whatever body buffer was active at that call site. When the first call site
 * sat inside a conditionally-executed buffer (a destructuring default's
 * then-branch, any `if`/ternary/`&&` arm) that did NOT run at runtime, the box
 * was never created — yet every later read had been statically re-aimed to a
 * `struct.get` on the still-null box → null deref → sNaN/NaN. (Root cause:
 * #2669 diagnosis.)
 *
 * Fix: create the box here, during function-declaration hoisting, where it
 * lands in the UNCONDITIONAL function-top `fctx.body`. The call site then takes
 * its existing already-boxed branch (no `struct.new`) because
 * `fctx.boxedCaptures.has(name)` is already true.
 *
 * This is a declaration-side MIRROR of the call-site machinery — it does NOT
 * widen the set of boxed variables (same `mutable && valType && !alreadyBoxed`
 * predicate, deduped via `boxedCaptures.has`), it only changes WHEN and INTO
 * WHICH buffer the box is created. The `__boxed_<name>` naming convention and
 * the lockstep `boxedCaptures` + `localMap` writes are load-bearing for the
 * call-site narrow two-signal guard (calls.ts) — preserve them.
 */
function emitEagerCaptureBoxes(ctx: CodegenContext, fctx: FunctionContext, funcName: string): void {
  const caps = ctx.nestedFuncCaptures.get(funcName);
  if (!caps) return;
  for (const cap of caps) {
    // Match the call-site predicate exactly: only mutable value captures with a
    // resolved value type are boxed. Immutable captures pass by value.
    if (!cap.mutable || !cap.valType) continue;
    // (#2692) SKIP `let`/`const` (TDZ-flagged) captures. Eager-boxing them at
    // function-top races their later block-scoped declaration: the `let`/`const`
    // decl re-allocates the value slot (block-scope shadow / type reset) and
    // resets `localMap` to a fresh unboxed f64 local, while `boxedCaptures` stays
    // set → the var-decl box-write path then emits `ref.is_null` / `struct.set`
    // on that fresh f64 slot → "ref.is_null expected reference, found f64"
    // invalid Wasm (the entire for-await-of async-dstr regression cluster — all
    // `let`-based). `var`/param captures have no such re-declaration, so eager
    // boxing is safe for them, and the captured-counter dstr template (the #2669
    // win) uses `var`. TDZ (`let`/`const`) captures fall back to the existing
    // lazy call-site boxing (the pre-#2692 behaviour). Follow-up can extend the
    // declaration path to be box-aware for the residual let/const-counter case.
    if (cap.hasTdzFlag) continue;
    // Dedup: a sibling nested fn already boxed this name (multi-capture of the
    // same var), OR the outer slot is itself the canonical cell (#2623
    // alreadyBoxed — re-boxing would create a cell-of-cell). `boxedCaptures.has`
    // covers both: alreadyBoxed ⟺ an outer `boxedCaptures` entry exists.
    if (fctx.boxedCaptures?.has(cap.name)) continue;
    const refCellTypeIdx = getOrRegisterRefCellType(ctx, cap.valType);
    // Mirror the call-site alloc: a NON-null `ref` to the cell, `__boxed_`-named.
    const boxedLocalIdx = allocLocal(fctx, `__boxed_${cap.name}`, {
      kind: "ref",
      typeIdx: refCellTypeIdx,
    });
    // Box the canonical declaration slot's current value (the hoisted default —
    // 0.0 / null — for `var`/`let`; the entry value for a param). All later
    // writes route through the box via `boxedCaptures`, so the end state matches
    // the lazy path. `local.set` (not `tee`) — the eager site leaves nothing on
    // the stack; the call site re-reads the box via its already-boxed branch.
    fctx.body.push({ op: "local.get", index: cap.outerLocalIdx });
    fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
    fctx.body.push({ op: "local.set", index: boxedLocalIdx });
    fctx.localMap.set(cap.name, boxedLocalIdx);
    if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
    fctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: cap.valType });
  }
}

/**
 * (#2758) Eagerly materialize the ref-cell box for a by-VALUE capture of THIS
 * nested function when a sibling nested function it *calls* mutably captures the
 * same variable.
 *
 * Companion to `emitEagerCaptureBoxes` (#2692). That pass fixes the DECLARING
 * scope: a var captured by a nested function declared here is boxed at this
 * function's top. This pass fixes the CALLER scope: when THIS function
 * (`function f({ w = counter() }) { …; use initCount; }`) merely *calls* a
 * sibling (`counter`) that mutably captures an outer `var` (`initCount`) which
 * THIS function ALSO captures and reads, the call-site lazy-box machinery
 * (`calls.ts` `nestedFuncCaptures` mutable branch) creates the ref cell at the
 * FIRST capturing call site — and for a destructuring/default param that first
 * call site sits inside a conditionally-executed buffer (the default's
 * `then`-arm). When the property is PRESENT the default is skipped, the box is
 * never created, and the later body read of the captured var
 * (`assert.sameValue(initCount, 0)`) dereferences the still-null box → the sNaN
 * sentinel → NaN. That is the `*-id-init-skipped` family (§13.3.3.7: the
 * initializer must NOT be evaluated when the property value is present, yet the
 * captured-var read still corrupted).
 *
 * Fix: pre-create the box here, BEFORE the parameter default-init / destructuring
 * emits any capturing call, so the `struct.new`/`local.set` lands in the
 * UNCONDITIONAL function-top `liftedFctx.body`. The later call site then takes
 * its already-boxed branch (no second `struct.new`), and the body read
 * dereferences a live box holding the by-value capture's entry value. Same
 * `__boxed_<name>` local-naming + lockstep `boxedCaptures` / `localMap` writes
 * as the call site, so the two stay in sync.
 *
 * Scope-narrowing (mirrors #2692): SKIP captures that are already `mutable`
 * (boxed as a ref-cell param), already a threaded outer cell (`alreadyBoxed`),
 * or TDZ-flagged (`let`/`const` — eager boxing races their block-scoped
 * re-declaration, the #2692 for-await regression rationale). Only `var`/param
 * by-value captures qualify — exactly the captured-counter template. The
 * ref-cell value type is taken from the CALLEE's recorded mutable-capture
 * valType so the registered `refCellTypeIdx` matches the one the lazy call site
 * will look up (guaranteeing its already-boxed branch fires).
 */
function emitEagerNestedCallCaptureBoxes(
  ctx: CodegenContext,
  liftedFctx: FunctionContext,
  captures: ReadonlyArray<{
    name: string;
    type: ValType;
    mutable: boolean;
    alreadyBoxed: boolean;
    hasTdzFlag: boolean;
  }>,
  referencedCalleeNames: ReadonlySet<string>,
): void {
  for (const cap of captures) {
    // Same narrowing as the #2692 eager pass: only plain by-value `var`/param
    // captures. Mutable → already a box param; alreadyBoxed → outer cell threaded
    // through; hasTdzFlag → `let`/`const`, eager boxing races the re-declaration.
    if (cap.mutable || cap.alreadyBoxed || cap.hasTdzFlag) continue;
    // Find a referenced sibling that mutably captures this same name, and adopt
    // ITS ref-cell value type so our refCellTypeIdx matches the lazy call-site's.
    let calleeValType: ValType | undefined;
    for (const g of referencedCalleeNames) {
      const gCaps = ctx.nestedFuncCaptures.get(g);
      if (!gCaps) continue;
      const m = gCaps.find((c) => c.name === cap.name && c.mutable && c.valType);
      if (m) {
        calleeValType = m.valType;
        break;
      }
    }
    if (!calleeValType) continue;
    // The box is built from the by-value param via `local.get` (type `cap.type`);
    // the cell field type must match. Both derive from the SAME outer variable,
    // so they are equal in practice — guard defensively and skip on any mismatch
    // (falls back to the prior lazy path rather than emitting an invalid struct).
    const sameValType =
      cap.type.kind === calleeValType.kind &&
      (cap.type.kind !== "ref" && cap.type.kind !== "ref_null"
        ? true
        : (cap.type as { typeIdx: number }).typeIdx === (calleeValType as { typeIdx: number }).typeIdx);
    if (!sameValType) continue;
    // Don't double-box (a prior pass / sibling already boxed this name).
    if (liftedFctx.boxedCaptures?.has(cap.name)) continue;
    const paramIdx = liftedFctx.localMap.get(cap.name);
    if (paramIdx === undefined) continue;
    const refCellTypeIdx = getOrRegisterRefCellType(ctx, calleeValType);
    const boxedLocalIdx = allocLocal(liftedFctx, `__boxed_${cap.name}`, {
      kind: "ref",
      typeIdx: refCellTypeIdx,
    });
    // `local.set` (not `tee`) — the eager site leaves nothing on the stack; the
    // later call site re-reads the box via its already-boxed branch.
    liftedFctx.body.push({ op: "local.get", index: paramIdx });
    liftedFctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
    liftedFctx.body.push({ op: "local.set", index: boxedLocalIdx });
    liftedFctx.localMap.set(cap.name, boxedLocalIdx);
    if (!liftedFctx.boxedCaptures) liftedFctx.boxedCaptures = new Map();
    liftedFctx.boxedCaptures.set(cap.name, { refCellTypeIdx, valType: calleeValType });
  }
}

export function hoistFunctionDeclarations(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | ts.Statement[],
  // (#2692) Internal: accumulates every successfully-hoisted nested-function
  // name across the recursive walk (into if/loop/try blocks). The TOP-LEVEL
  // call (where this is undefined) runs the eager-capture-box pass ONCE after
  // the entire recursion completes — see the rationale at the post-pass below.
  _eagerBoxFuncNames?: Set<string>,
): void {
  const isTopLevelHoist = _eagerBoxFuncNames === undefined;
  const eagerBoxFuncNames = _eagerBoxFuncNames ?? new Set<string>();
  // (#2068) Phase 0: reserve a correctly-typed bodyless funcMap slot for every
  // direct-sibling function that captures NO outer local, BEFORE compiling any
  // body. Without this a forward sibling reference
  // (`function a(){ return b(); } function b(){...}`) or mutual recursion
  // (`isEven`/`isOdd`) compiles `a`'s body while `b` is still unregistered, so
  // the call falls through to the `ref.null.extern` fallback (→ 0). The slot is
  // reserved with the REAL funcTypeIdx (computed from the signature, same as the
  // compiler below) so call sites resolve the result type correctly; the body /
  // locals are filled in by the compile loop via `reuseReservedEntry`.
  //
  // Capture-free only: the has-captures branch lifts captures as leading params
  // and must drive its own registration, so a plain reservation would mis-shape
  // it. Mutual recursion among capturing functions is out of scope here.
  const siblingFuncNames = new Set<string>();
  for (const stmt of stmts) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) siblingFuncNames.add(stmt.name.text);
  }
  if (siblingFuncNames.size > 1) {
    for (const stmt of stmts) {
      if (!ts.isFunctionDeclaration(stmt) || !stmt.name || !stmt.body) continue;
      const funcName = stmt.name.text;
      if (ctx.funcMap.has(funcName)) continue;
      if (ctx.hoistFailedFuncs?.has(funcName)) continue;

      // Capture check: a referenced name that is an outer local (and not an
      // own-local, this/super, or a sibling function) makes this capturing.
      const ownLocals = new Set<string>();
      addFunctionOwnLocals(stmt, ownLocals); // (#2103) memoized own-locals
      const referenced = new Set<string>();
      for (const s of stmt.body.statements) collectReferencedIdentifiers(s, referenced, ownLocals);
      let capturesOuter = false;
      for (const name of referenced) {
        if (name === "this" || name === "super") continue;
        if (ownLocals.has(name)) continue;
        if (siblingFuncNames.has(name)) continue;
        // #2669: skip names bound to a *user* function — but NOT a wasm:js-string
        // builtin import (concat/length/equals/substring/charCodeAt), which lives in
        // funcMap yet must not block capture of a same-named outer local (the
        // test262 `let length = "outer"` dstr template captured by a nested fn).
        if (ctx.funcMap.has(name) && ctx.funcMap.get(name) !== ctx.jsStringImports.get(name)) continue;
        if (fctx.localMap.has(name)) {
          capturesOuter = true;
          break;
        }
      }
      if (capturesOuter) continue;

      // Compute the real signature (mirror the slice in
      // compileNestedFunctionDeclaration). Generators return externref; async
      // unwraps Promise<T>.
      const paramTypes: ValType[] = stmt.parameters.map((p) => {
        let wt = resolveWasmType(ctx, ctx.checker.getTypeAtLocation(p));
        if (p.initializer && wt.kind === "ref") {
          wt = { kind: "ref_null", typeIdx: (wt as { typeIdx: number }).typeIdx };
        }
        return wt;
      });
      const isGen = stmt.asteriskToken !== undefined;
      const isAsync = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
      // (#2923) Foreign eval-body function declaration → no checker signature
      // (getSignatureFromDeclaration throws). Default the reserved result type to
      // externref, matching the identical fallback in
      // compileNestedFunctionDeclaration so the reserved funcType matches the
      // compiled body. Multiple foreign func decls hit THIS pre-reserve pass.
      let sig: ts.Signature | undefined;
      let foreignNoSig = false;
      try {
        sig = ctx.checker.getSignatureFromDeclaration(stmt);
      } catch {
        foreignNoSig = true;
      }
      let resultType: ValType | undefined;
      if (isGen) {
        resultType = { kind: "externref" };
      } else if (foreignNoSig) {
        resultType = { kind: "externref" };
      } else if (sig) {
        let rt = ctx.checker.getReturnTypeOfSignature(sig);
        if (isAsync) rt = unwrapPromiseType(rt, ctx.checker);
        if (!isVoidType(rt)) resultType = resolveWasmType(ctx, rt);
      }
      const funcTypeIdx = addFuncType(ctx, paramTypes, resultType ? [resultType] : [], `${funcName}_type`);
      const reservedFuncIdx = mintDefinedFunc(ctx);
      const reserved: WasmFunction = {
        name: funcName,
        typeIdx: funcTypeIdx,
        locals: [],
        body: [],
        exported: false,
      };
      pushDefinedFunc(ctx, reservedFuncIdx, reserved);
      ctx.funcMap.set(funcName, reservedFuncIdx);
      if (!ctx.preRegisteredBodyless) ctx.preRegisteredBodyless = new Set();
      ctx.preRegisteredBodyless.add(funcName);
    }
  }

  for (const stmt of stmts) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      const funcName = stmt.name.text;
      // (#2200 Phase 1) Annex B B.3.3 cancellation: if this block-nested function
      // is ineligible for a web-compat outer var-binding (intervening lexical
      // shadow or same-named param), record the declaring block's range so a read
      // of the name OUTSIDE the block throws ReferenceError. The body still
      // compiles below (the block-local binding must work for in-block calls).
      const cancelBlock = annexBHoistCancels(stmt);
      if (cancelBlock) {
        if (!fctx.annexBCancelled) fctx.annexBCancelled = new Map();
        const ranges = fctx.annexBCancelled.get(funcName) ?? [];
        ranges.push({ start: cancelBlock.getStart(), end: cancelBlock.getEnd() });
        fctx.annexBCancelled.set(funcName, ranges);
      } else if (annexBBlockNestedEligible(stmt) !== null) {
        // (#2200 Phase 2) Eligible block-nested function: pre-allocate the
        // web-compat outer var-binding as a TDZ var — an externref local +
        // an i32 TDZ flag (zero-init = uninitialised). The value + flag←1 are
        // emitted at the declaration's textual position (compileStatement), so a
        // read before the block / when the block is skipped sees the flag 0 →
        // `typeof` "undefined" / direct-read ReferenceError; a read after the
        // block ran sees the function value. Skip if the name already has a
        // function-local (e.g. a var/param) — that binding wins, no Annex B var.
        if (!fctx.localMap.has(funcName)) {
          allocLocal(fctx, funcName, { kind: "externref" });
          if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
          if (!fctx.tdzFlagLocals.has(funcName)) {
            const flagIdx = allocLocal(fctx, `__tdz_${funcName}`, { kind: "i32" });
            fctx.tdzFlagLocals.set(funcName, flagIdx);
          }
          if (!fctx.annexBOuterBindings) fctx.annexBOuterBindings = new Set();
          fctx.annexBOuterBindings.add(funcName);
        }
      }
      const hasReservedBodylessEntry = ctx.preRegisteredBodyless?.has(funcName) ?? false;
      const reservedFuncIdx = hasReservedBodylessEntry ? ctx.funcMap.get(funcName) : undefined;
      const reservedEntry = reservedFuncIdx !== undefined ? definedFuncAt(ctx, reservedFuncIdx) : undefined;
      if (!ctx.funcMap.has(funcName) || reservedEntry) {
        // Save state so we can roll back if compilation fails
        const errorsBefore = ctx.errors.length;

        compileNestedFunctionDeclaration(ctx, fctx, stmt, reservedEntry ? { reuseReservedEntry: reservedEntry } : {});

        // If new errors were added during hoisting, roll back
        if (ctx.errors.length > errorsBefore) {
          ctx.errors.length = errorsBefore;
          // (#2029 function-index cluster) DO NOT truncate `ctx.mod.functions`
          // back to `funcsBefore`. The failed nested compile pushed its OWN
          // partially-built funcs AND — as a SIDE EFFECT — module-level runtime
          // helpers it pulled in (`ensureObjectRuntime` registers
          // `__extern_method_call` / `__apply_closure` / the `__proxy_*`
          // dispatchers + their string/number/union dependencies;
          // `ensureObjVecBuilders` / iterator-native / array-to-primitive
          // likewise). Those helpers are recorded in `ctx.funcMap` (and gate
          // `objectRuntimeTypes` / `ensureProxyRuntime`'s `funcMap.has(...)`),
          // and they are perfectly VALID — content-addressed, idempotent, and
          // potentially needed by later real code. A blanket
          // `mod.functions.length = funcsBefore` removed them from the table while
          // leaving their funcMap entries (and the registration latches) intact,
          // so a later call site that re-needed the runtime found the guards
          // already satisfied, SKIPPED re-registration, and baked the now-stale
          // funcIdx into a dispatcher body (`fillClosedMethodDispatch` →
          // `call 136` into a 129-func module → "function index out of range").
          // Re-registering after a purge is fragile too: the runtime's own deps
          // (`number_toString`, native-string helpers, union boxes) have separate
          // latches that would also need resetting, in dependency order.
          //
          // Instead, keep every pushed func and neutralise ONLY the failed user
          // function's own entry to a valid stub. The helpers stay in the table at
          // their registered indices (funcMap consistent); the failed function
          // becomes an unreferenced dead stub (locals are never DCE'd, so it must
          // be a VALID body — `unreachable` satisfies any result type). Dropping
          // its funcMap name lets `compileStatement` re-compile it at its real
          // textual position (where captures are in scope), exactly as the
          // pre-existing `hoistFailedFuncs` re-attempt intends.
          const failedIdx = ctx.funcMap.get(funcName);
          const failedEntry = failedIdx !== undefined ? definedFuncAt(ctx, failedIdx) : undefined;
          if (reservedEntry) {
            reservedEntry.locals = [];
            reservedEntry.body = [{ op: "unreachable" } as Instr];
          } else {
            if (failedEntry) {
              failedEntry.locals = [];
              failedEntry.body = [{ op: "unreachable" } as Instr];
            }
            ctx.funcMap.delete(funcName);
            ctx.nestedFuncCaptures.delete(funcName);
            ctx.funcOptionalParams.delete(funcName);
          }
          // Track failed hoist so compileStatement doesn't re-attempt
          if (!ctx.hoistFailedFuncs) ctx.hoistFailedFuncs = new Set();
          ctx.hoistFailedFuncs.add(funcName);
        } else {
          if (reservedEntry) {
            ctx.preRegisteredBodyless?.delete(funcName);
          }
          // (#2692) Defer eager-box materialization to the post-recursion pass.
          // Boxing here (inline) would set `fctx.boxedCaptures` BEFORE a
          // LATER-hoisted sibling that captures the same var is compiled — that
          // sibling's capture detection would then see the var as `alreadyBoxed`
          // (#2623), giving it a different lifted signature (cell threaded
          // directly) than the earlier sibling (cell wrapped), and the call site
          // re-derives a cell-of-cell (illegal cast). Collecting now and boxing
          // once AFTER all nested fns are compiled keeps every sibling's
          // signature consistent (plain mutable capture), then boxes once.
          // Success path only — the rollback arm above deletes
          // `nestedFuncCaptures`, so a failed fn is never collected.
          eagerBoxFuncNames.add(funcName);
        }
      }
    }
    // Recurse into block-like structures to find nested function declarations.
    // In JS, function declarations are hoisted to the enclosing function scope,
    // even when inside if-branches, try/catch blocks, etc.
    if (ts.isIfStatement(stmt)) {
      if (ts.isBlock(stmt.thenStatement)) {
        hoistFunctionDeclarations(ctx, fctx, stmt.thenStatement.statements, eagerBoxFuncNames);
      }
      if (stmt.elseStatement) {
        if (ts.isBlock(stmt.elseStatement)) {
          hoistFunctionDeclarations(ctx, fctx, stmt.elseStatement.statements, eagerBoxFuncNames);
        } else if (ts.isIfStatement(stmt.elseStatement)) {
          hoistFunctionDeclarations(ctx, fctx, [stmt.elseStatement], eagerBoxFuncNames);
        }
      }
    }
    if (ts.isTryStatement(stmt)) {
      hoistFunctionDeclarations(ctx, fctx, stmt.tryBlock.statements, eagerBoxFuncNames);
      if (stmt.catchClause) {
        hoistFunctionDeclarations(ctx, fctx, stmt.catchClause.block.statements, eagerBoxFuncNames);
      }
      if (stmt.finallyBlock) {
        hoistFunctionDeclarations(ctx, fctx, stmt.finallyBlock.statements, eagerBoxFuncNames);
      }
    }
    if (ts.isBlock(stmt)) {
      hoistFunctionDeclarations(ctx, fctx, stmt.statements, eagerBoxFuncNames);
    }
    // Recurse into loop bodies — function declarations inside loops are hoisted
    // to the enclosing function scope in JS semantics.
    if (ts.isForStatement(stmt) || ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
      if (ts.isBlock(stmt.statement)) {
        hoistFunctionDeclarations(ctx, fctx, stmt.statement.statements, eagerBoxFuncNames);
      } else {
        hoistFunctionDeclarations(ctx, fctx, [stmt.statement], eagerBoxFuncNames);
      }
    }
    if (ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)) {
      if (ts.isBlock(stmt.statement)) {
        hoistFunctionDeclarations(ctx, fctx, stmt.statement.statements, eagerBoxFuncNames);
      } else {
        hoistFunctionDeclarations(ctx, fctx, [stmt.statement], eagerBoxFuncNames);
      }
    }
    if (ts.isSwitchStatement(stmt)) {
      for (const clause of stmt.caseBlock.clauses) {
        hoistFunctionDeclarations(ctx, fctx, clause.statements, eagerBoxFuncNames);
      }
    }
    if (ts.isLabeledStatement(stmt)) {
      if (ts.isBlock(stmt.statement)) {
        hoistFunctionDeclarations(ctx, fctx, stmt.statement.statements, eagerBoxFuncNames);
      } else {
        hoistFunctionDeclarations(ctx, fctx, [stmt.statement], eagerBoxFuncNames);
      }
    }
  }

  // (#2692) Eager-box pass — runs ONCE, at the TOP-LEVEL call, AFTER the entire
  // recursive hoist has compiled every nested function (in blocks/loops/try
  // too). Materializing the ref-cell boxes now — not inline during the walk —
  // guarantees every nested function that captures a given mutable var was
  // compiled with the SAME (plain-mutable, not `alreadyBoxed`) lifted signature,
  // so sibling call sites agree on the capture's cell type (no cell-of-cell).
  // The box `struct.new`/`local.set` lands in the unconditional function-top
  // `fctx.body` (hoisting never swaps the body buffer), so the box always exists
  // before any conditionally-executed capturing call site — the bug #2692 fixes.
  // `emitEagerCaptureBoxes` dedups via `boxedCaptures.has`, so a var captured by
  // several siblings is boxed exactly once. Root cause: #2669 diagnosis.
  if (isTopLevelHoist) {
    for (const funcName of eagerBoxFuncNames) {
      emitEagerCaptureBoxes(ctx, fctx, funcName);
    }
  }
}

/**
 * Emit default-value initialization for parameters with initializers.
 * For each param with a default value, check if the caller omitted it and if
 * so compile the initializer.
 * @param paramOffset - number of prepended params (captures) before the user params
 */
function emitDefaultParamInit(
  ctx: CodegenContext,
  liftedFctx: FunctionContext,
  stmt: ts.FunctionDeclaration,
  paramTypes: ValType[],
  paramOffset: number,
): void {
  const defaultArgcLocal = stmt.parameters.some((param, i) => {
    if (!param.initializer) return false;
    return paramDefaultNeedsArgc(paramTypes[i]);
  })
    ? cacheParamDefaultArgc(ctx, liftedFctx)
    : undefined;
  for (let i = 0; i < stmt.parameters.length; i++) {
    const param = stmt.parameters[i]!;
    if (!param.initializer) continue;

    const paramIdx = paramOffset + i;
    const paramType = paramTypes[i]!;

    // Build the "then" block: compile default expression, local.set.
    // For array binding patterns with externref param, force default literals
    // to compile as vec (not tuple) so the destructure path can convert them.
    const savedBody = pushBody(liftedFctx);
    const isArrayPatternExternref = ts.isArrayBindingPattern(param.name) && paramType.kind === "externref";
    const prevForceVec = (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec;
    if (isArrayPatternExternref) {
      (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = true;
    }
    try {
      compileExpression(ctx, liftedFctx, param.initializer, paramType);
    } finally {
      if (isArrayPatternExternref) {
        (ctx as unknown as { _arrayLiteralForceVec?: boolean })._arrayLiteralForceVec = prevForceVec;
      }
    }
    liftedFctx.body.push({ op: "local.set", index: paramIdx });
    const thenInstrs = liftedFctx.body;
    popBody(liftedFctx, savedBody);

    // Emit the null/zero check + conditional assignment
    if (paramType.kind === "externref") {
      // Per JS spec, parameter defaults fire ONLY when the arg is `undefined`
      // (omitted or explicit), never for `null`. Callers pad missing args with
      // `__get_undefined()` (externref-wrapped undefined), so
      // `__extern_is_undefined` catches both "omitted" and "explicit undefined".
      // Using `ref.is_null` in addition would wrongly fire the default when the
      // caller passed explicit `null` (#1025 / #1021).
      const undefIdx = ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
      flushLateImportShifts(ctx, liftedFctx);
      liftedFctx.body.push({ op: "local.get", index: paramIdx });
      if (undefIdx !== undefined) {
        liftedFctx.body.push({ op: "call", funcIdx: undefIdx } as Instr);
      } else {
        // Fallback (standalone mode): ref.is_null is imprecise — treats null
        // as undefined.
        liftedFctx.body.push({ op: "ref.is_null" });
      }
      liftedFctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "ref_null" || paramType.kind === "ref") {
      liftedFctx.body.push({ op: "local.get", index: paramIdx });
      liftedFctx.body.push({ op: "ref.is_null" });
      liftedFctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "i32") {
      emitParamDefaultArgMissingCheck(liftedFctx, defaultArgcLocal!, i);
      liftedFctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    } else if (paramType.kind === "f64") {
      emitParamDefaultArgMissingCheck(liftedFctx, defaultArgcLocal!, i);
      emitF64ParamSentinelCheck(liftedFctx, paramIdx);
      liftedFctx.body.push({ op: "i32.or" });
      liftedFctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: thenInstrs,
      });
    }
  }
}

/** Append a default return value if the function body doesn't end with a return */
function appendDefaultReturn(fctx: FunctionContext, returnType: ValType | null): void {
  if (!returnType) return;
  const lastInstr = fctx.body[fctx.body.length - 1];
  if (lastInstr && lastInstr.op === "return") return;
  if (returnType.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
  else if (returnType.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
  else if (returnType.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
}

function getLine(node: ts.Node): number {
  try {
    const sf = node.getSourceFile();
    if (!sf) return 0;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    return line + 1;
  } catch {
    return 0;
  }
}

function getCol(node: ts.Node): number {
  try {
    const sf = node.getSourceFile();
    if (!sf) return 0;
    const { character } = sf.getLineAndCharacterOfPosition(node.getStart());
    return character + 1;
  } catch {
    return 0;
  }
}

/**
 * Register (on first use) a module-level mutable global that carries
 * "extra" runtime arguments from a call site to a callee whose body reads
 * `arguments`. The global is consumed (read + reset to null) in the
 * callee's prologue (#1053).
 *
 * Type: `(mut (ref null $vec_externref))` — a WasmGC vec of externref.
 */
export function ensureExtrasArgvGlobal(ctx: CodegenContext): { globalIdx: number; vecTypeIdx: number } {
  if (ctx.extrasArgvGlobalIdx >= 0) {
    return { globalIdx: ctx.extrasArgvGlobalIdx, vecTypeIdx: ctx.extrasArgvVecTypeIdx };
  }
  const elemType: ValType = { kind: "externref" };
  const vti = getOrRegisterVecType(ctx, "externref", elemType);
  const globalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__extras_argv",
    type: { kind: "ref_null", typeIdx: vti },
    mutable: true,
    init: [{ op: "ref.null", typeIdx: vti } as Instr],
  });
  ctx.extrasArgvGlobalIdx = globalIdx;
  ctx.extrasArgvVecTypeIdx = vti;
  return { globalIdx, vecTypeIdx: vti };
}

/**
 * Lazily register a `(mut i32)` module global `__argc` that callers set
 * to the actual call-site argument count before invoking a function whose
 * body reads `arguments`. The callee reads this to set `arguments.length`
 * correctly (instead of using the formal parameter count).
 */
export function ensureArgcGlobal(ctx: CodegenContext): number {
  if (ctx.argcGlobalIdx >= 0) return ctx.argcGlobalIdx;
  const globalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__argc",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: -1 }],
  });
  ctx.argcGlobalIdx = globalIdx;
  return globalIdx;
}

/**
 * Cache the call-site argument count once at function entry for parameter
 * default checks. The raw -1 sentinel is preserved in the local; callers use
 * that to mean "unknown host/module-init caller".
 */
export function cacheParamDefaultArgc(ctx: CodegenContext, fctx: FunctionContext): number {
  if (fctx.argcCachedLocal !== undefined) return fctx.argcCachedLocal;
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  const argcLocal = allocLocal(fctx, "__argc_default", { kind: "i32" });
  fctx.body.push({ op: "global.get", index: argcGlobalIdx } as Instr);
  fctx.body.push({ op: "local.set", index: argcLocal } as Instr);
  fctx.body.push({ op: "i32.const", value: -1 } as Instr);
  fctx.body.push({ op: "global.set", index: argcGlobalIdx } as Instr);
  fctx.argcCachedLocal = argcLocal;
  return argcLocal;
}

export function paramDefaultNeedsArgc(type: ValType | undefined): boolean {
  return type?.kind === "i32" || type?.kind === "f64";
}

export function emitParamDefaultArgMissingCheck(fctx: FunctionContext, argcLocal: number, argIndex: number): void {
  fctx.body.push({ op: "local.get", index: argcLocal } as Instr);
  fctx.body.push({ op: "i32.const", value: -1 } as Instr);
  fctx.body.push({ op: "i32.ne" } as Instr);
  fctx.body.push({ op: "local.get", index: argcLocal } as Instr);
  fctx.body.push({ op: "i32.const", value: argIndex } as Instr);
  fctx.body.push({ op: "i32.le_s" } as Instr);
  fctx.body.push({ op: "i32.and" } as Instr);
}

export function emitF64ParamSentinelCheck(fctx: FunctionContext, paramIdx: number): void {
  fctx.body.push({ op: "local.get", index: paramIdx });
  fctx.body.push({ op: "i64.reinterpret_f64" });
  fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den });
  fctx.body.push({ op: "i64.eq" });
}

export function maybeSetArgcForKnownCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  funcName: string,
  actualArgCount: number,
  paramCount: number,
): void {
  if (!ctx.funcUsesArguments.has(funcName) && !ctx.funcOptionalParams.has(funcName)) return;
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  fctx.body.push({ op: "i32.const", value: Math.min(actualArgCount, paramCount) } as Instr);
  fctx.body.push({ op: "global.set", index: argcGlobalIdx } as Instr);
}

/**
 * (#1636-S1) Lazily register a `(mut externref)` module global
 * `__current_this` used by `__call_fn_method_N` to thread a host-supplied
 * `this`-value into a Wasm closure body. The dispatcher save+restores the
 * previous value across the inner `call_ref`, and `ThisKeyword` resolution
 * reads this global when no local `this` binding is in scope (free-closure
 * fallback). Default value is `ref.null.extern` (= JS `null`), which is
 * compatible with the prior "undefined fallback" behaviour for the vast
 * majority of references that compare strictly against null/undefined.
 */
export function ensureCurrentThisGlobal(ctx: CodegenContext): number {
  if (ctx.currentThisGlobalIdx >= 0) return ctx.currentThisGlobalIdx;
  const globalIdx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: "__current_this",
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" } as Instr],
  });
  ctx.currentThisGlobalIdx = globalIdx;
  return globalIdx;
}

/**
 * Emit code to build a vec struct from `args[startIdx..]` and
 * store it in the `__extras_argv` module global. Used at call sites when
 * the callee reads `arguments` and the caller passes more runtime args
 * than the callee's formal param count (#1053).
 */
export function emitSetExtrasArgv(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: ts.Expression[],
  startIdx: number,
): void {
  const { globalIdx, vecTypeIdx } = ensureExtrasArgvGlobal(ctx);
  const ati = getArrTypeIdxFromVec(ctx, vecTypeIdx);

  // Coerce the just-compiled operand (top of stack) to externref so it can be
  // stored in the externref-element extras array. Mirrors the boxing the
  // static path uses below.
  const coerceTopToExternref = (t: ValType | null): void => {
    if (t === null) {
      fctx.body.push({ op: "ref.null.extern" });
      return;
    }
    if (t.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
      else fctx.body.push({ op: "drop" }, { op: "ref.null.extern" });
    } else if (t.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
      else fctx.body.push({ op: "drop" }, { op: "ref.null.extern" });
    } else if (t.kind === "ref" || t.kind === "ref_null") {
      fctx.body.push({ op: "extern.convert_any" } as Instr);
    }
  };

  // (#2202) A spread argument (`f(...src)`) contributes its RUNTIME element
  // count to `arguments`, not a single slot — and each spread element value must
  // appear in `arguments`. The static `array.new_fixed` path below counts each
  // spread node as one and stores the spread *source* as a single element, so
  // `arguments.length`/values were wrong for any spread call. When a spread is
  // present, build the extras array with a runtime length: evaluate every extra
  // ONCE into temps (a non-spread → one boxed externref; a spread source →
  // expanded to its elements), sum the lengths, allocate, then fill.
  //
  // The spread source is read by representation:
  //   - a typed WasmGC vec ref (`[1,2]` literal, `number[]`/`any[]` var) →
  //     read its struct length (field 0) and elements (field 1 + array.get)
  //     directly, boxing each to externref. Works in BOTH host and standalone
  //     (native vecs) and avoids the lossy `coerce-to-externref` round-trip that
  //     dropped an inline-literal vec's elements (host `__array_from_iter` saw
  //     length 0). This is the path the failing test262 `...[lit]` cases need.
  //   - otherwise (opaque externref / JS iterable, JS-host only) → materialize
  //     via `__array_from_iter` and index with `__extern_length`/`__extern_get_idx`.
  const hasSpread = args.slice(startIdx).some((a) => ts.isSpreadElement(a));
  if (hasSpread) {
    const externIndexingOk = !noJsHost(ctx);
    const lenFn = externIndexingOk
      ? ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }])
      : 0;
    const getFn = externIndexingOk
      ? ensureLateImport(ctx, "__extern_get_idx", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }])
      : 0;
    const iterFn = externIndexingOk
      ? ensureLateImport(ctx, "__array_from_iter", [{ kind: "externref" }], [{ kind: "externref" }])
      : 0;
    flushLateImportShifts(ctx, fctx);
    if (lenFn !== undefined && getFn !== undefined && iterFn !== undefined) {
      const boxIdx = ctx.funcMap.get("__box_number");
      // Box a vec element of the given kind to externref (extras are externref).
      const boxVecElem = (elemKind: ValType["kind"]): Instr[] => {
        if (elemKind === "f64") {
          return boxIdx !== undefined
            ? [{ op: "call", funcIdx: boxIdx } as Instr]
            : [{ op: "drop" } as Instr, { op: "ref.null.extern" } as Instr];
        }
        if (elemKind === "i32" || elemKind === "i8" || elemKind === "i16") {
          return boxIdx !== undefined
            ? [{ op: "f64.convert_i32_s" } as Instr, { op: "call", funcIdx: boxIdx } as Instr]
            : [{ op: "drop" } as Instr, { op: "ref.null.extern" } as Instr];
        }
        if (elemKind === "ref" || elemKind === "ref_null") {
          return [{ op: "extern.convert_any" } as Instr];
        }
        // externref element — already correct.
        return [];
      };
      // Per-extra descriptor.
      type Slot =
        | { kind: "single"; valLocal: number }
        // vec-ref spread: read length/data fields directly.
        | { kind: "vec"; vecLocal: number; vecTi: number; arrTi: number; elemKind: ValType["kind"]; lenLocal: number }
        // extern spread (host iterable): materialized array indexed by helpers.
        | { kind: "spread"; srcLocal: number; lenLocal: number };
      const slots: Slot[] = [];
      const totalLenLocal = allocLocal(fctx, `__xa_total_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 } as Instr);
      fctx.body.push({ op: "local.set", index: totalLenLocal } as Instr);

      for (let i = startIdx; i < args.length; i++) {
        const arg = args[i]!;
        if (ts.isSpreadElement(arg)) {
          // Compile the source with its natural type first (no externref hint)
          // so a typed vec stays a vec ref we can read directly.
          const st = compileExpression(ctx, fctx, arg.expression);
          const stTypeIdx =
            st && (st.kind === "ref" || st.kind === "ref_null") ? (st as { typeIdx: number }).typeIdx : -1;
          const vecInfo = stTypeIdx >= 0 ? getVecInfo(ctx, stTypeIdx) : null;
          // A non-vec ref may be a TUPLE struct (fields `_0`, `_1`, …) — that is
          // how an inline array literal `[1,2]` with statically-known elements
          // lowers in a value context (NOT a `__vec_`). Its arity is static and
          // each element is a `struct.get fieldIdx`. Detect it so an inline-literal
          // spread (`...[1,2]`) — the shape the failing test262 cluster uses —
          // expands correctly instead of being treated as one opaque element.
          const tupleDef =
            !vecInfo && stTypeIdx >= 0 && ctx.mod.types[stTypeIdx]?.kind === "struct"
              ? (ctx.mod.types[stTypeIdx] as { fields: { name?: string; type: ValType }[] })
              : null;
          const isTuple =
            tupleDef !== null && tupleDef.fields.length > 0 && tupleDef.fields.every((f, idx) => f.name === `_${idx}`);
          if (st && (st.kind === "ref" || st.kind === "ref_null") && isTuple && tupleDef) {
            // Inline tuple-literal spread: static arity, read each field directly.
            const tupLocal = allocLocal(fctx, `__xa_tup_${fctx.locals.length}`, st);
            fctx.body.push({ op: "local.set", index: tupLocal } as Instr);
            for (let fi = 0; fi < tupleDef.fields.length; fi++) {
              fctx.body.push({ op: "local.get", index: tupLocal } as Instr);
              if (st.kind === "ref_null") fctx.body.push({ op: "ref.as_non_null" } as Instr);
              fctx.body.push({ op: "struct.get", typeIdx: stTypeIdx, fieldIdx: fi } as Instr);
              const valLocal = allocLocal(fctx, `__xa_tv_${fctx.locals.length}`, { kind: "externref" });
              fctx.body.push(...boxVecElem(tupleDef.fields[fi]!.type.kind));
              fctx.body.push({ op: "local.set", index: valLocal } as Instr);
              fctx.body.push({ op: "local.get", index: totalLenLocal } as Instr);
              fctx.body.push({ op: "i32.const", value: 1 } as Instr);
              fctx.body.push({ op: "i32.add" } as Instr);
              fctx.body.push({ op: "local.set", index: totalLenLocal } as Instr);
              slots.push({ kind: "single", valLocal });
            }
            continue;
          }
          if (st && (st.kind === "ref" || st.kind === "ref_null") && vecInfo) {
            const vecTi = (st as { typeIdx: number }).typeIdx;
            const vecLocal = allocLocal(fctx, `__xa_vec_${fctx.locals.length}`, st);
            fctx.body.push({ op: "local.set", index: vecLocal } as Instr);
            const lenLocal = allocLocal(fctx, `__xa_vlen_${fctx.locals.length}`, { kind: "i32" });
            // len = (vec != null) ? vec.length : 0
            fctx.body.push({ op: "local.get", index: vecLocal } as Instr);
            fctx.body.push({ op: "ref.is_null" } as Instr);
            fctx.body.push({
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [{ op: "i32.const", value: 0 } as Instr],
              else: [
                { op: "local.get", index: vecLocal } as Instr,
                { op: "ref.as_non_null" } as Instr,
                { op: "struct.get", typeIdx: vecTi, fieldIdx: 0 } as Instr,
              ],
            } as Instr);
            fctx.body.push({ op: "local.tee", index: lenLocal } as Instr);
            fctx.body.push({ op: "local.get", index: totalLenLocal } as Instr);
            fctx.body.push({ op: "i32.add" } as Instr);
            fctx.body.push({ op: "local.set", index: totalLenLocal } as Instr);
            slots.push({
              kind: "vec",
              vecLocal,
              vecTi,
              arrTi: vecInfo.arrTypeIdx,
              elemKind: vecInfo.elemType.kind,
              lenLocal,
            });
            continue;
          }
          // Opaque source (host iterable). Coerce to externref, materialize, index.
          coerceTopToExternref(st);
          if (!externIndexingOk || lenFn === 0 || getFn === 0 || iterFn === 0) {
            // Standalone with a non-vec spread source — can't expand natively
            // here. Drop the value and treat as a single slot (best effort; the
            // static path would have done the same).
            const valLocal = allocLocal(fctx, `__xa_val_${fctx.locals.length}`, { kind: "externref" });
            fctx.body.push({ op: "local.set", index: valLocal } as Instr);
            fctx.body.push({ op: "local.get", index: totalLenLocal } as Instr);
            fctx.body.push({ op: "i32.const", value: 1 } as Instr);
            fctx.body.push({ op: "i32.add" } as Instr);
            fctx.body.push({ op: "local.set", index: totalLenLocal } as Instr);
            slots.push({ kind: "single", valLocal });
            continue;
          }
          fctx.body.push({ op: "call", funcIdx: iterFn } as Instr);
          const srcLocal = allocLocal(fctx, `__xa_src_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: srcLocal } as Instr);
          const lenLocal = allocLocal(fctx, `__xa_len_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "local.get", index: srcLocal } as Instr);
          fctx.body.push({ op: "call", funcIdx: lenFn } as Instr);
          fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);
          fctx.body.push({ op: "local.tee", index: lenLocal } as Instr);
          fctx.body.push({ op: "local.get", index: totalLenLocal } as Instr);
          fctx.body.push({ op: "i32.add" } as Instr);
          fctx.body.push({ op: "local.set", index: totalLenLocal } as Instr);
          slots.push({ kind: "spread", srcLocal, lenLocal });
        } else {
          const t = compileExpression(ctx, fctx, arg, { kind: "externref" });
          coerceTopToExternref(t);
          const valLocal = allocLocal(fctx, `__xa_val_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: valLocal } as Instr);
          // total += 1
          fctx.body.push({ op: "local.get", index: totalLenLocal } as Instr);
          fctx.body.push({ op: "i32.const", value: 1 } as Instr);
          fctx.body.push({ op: "i32.add" } as Instr);
          fctx.body.push({ op: "local.set", index: totalLenLocal } as Instr);
          slots.push({ kind: "single", valLocal });
        }
      }

      // arr = array.new_default(total); fill via a running write index.
      const arrTmp = allocLocal(fctx, `__xa_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: ati });
      fctx.body.push({ op: "local.get", index: totalLenLocal } as Instr);
      fctx.body.push({ op: "array.new_default", typeIdx: ati } as Instr);
      fctx.body.push({ op: "local.set", index: arrTmp } as Instr);
      const wIdx = allocLocal(fctx, `__xa_w_${fctx.locals.length}`, { kind: "i32" });
      fctx.body.push({ op: "i32.const", value: 0 } as Instr);
      fctx.body.push({ op: "local.set", index: wIdx } as Instr);

      for (const slot of slots) {
        if (slot.kind === "single") {
          fctx.body.push({ op: "local.get", index: arrTmp } as Instr);
          fctx.body.push({ op: "local.get", index: wIdx } as Instr);
          fctx.body.push({ op: "local.get", index: slot.valLocal } as Instr);
          fctx.body.push({ op: "array.set", typeIdx: ati } as Instr);
          fctx.body.push({ op: "local.get", index: wIdx } as Instr);
          fctx.body.push({ op: "i32.const", value: 1 } as Instr);
          fctx.body.push({ op: "i32.add" } as Instr);
          fctx.body.push({ op: "local.set", index: wIdx } as Instr);
        } else if (slot.kind === "vec") {
          // Loop i in [0, len): arr[wIdx++] = box(vec.data[i])
          const sIdx = allocLocal(fctx, `__xa_vi_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "i32.const", value: 0 } as Instr);
          fctx.body.push({ op: "local.set", index: sIdx } as Instr);
          fctx.body.push({
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: sIdx } as Instr,
                  { op: "local.get", index: slot.lenLocal } as Instr,
                  { op: "i32.ge_s" } as Instr,
                  { op: "br_if", depth: 1 } as Instr,
                  // arr[wIdx] = box(vec.data[sIdx])
                  { op: "local.get", index: arrTmp } as Instr,
                  { op: "local.get", index: wIdx } as Instr,
                  { op: "local.get", index: slot.vecLocal } as Instr,
                  { op: "ref.as_non_null" } as Instr,
                  { op: "struct.get", typeIdx: slot.vecTi, fieldIdx: 1 } as Instr,
                  { op: "local.get", index: sIdx } as Instr,
                  ...(slot.elemKind === "i8" || slot.elemKind === "i16"
                    ? [{ op: "array.get_s", typeIdx: slot.arrTi } as Instr]
                    : [{ op: "array.get", typeIdx: slot.arrTi } as Instr]),
                  ...boxVecElem(slot.elemKind),
                  { op: "array.set", typeIdx: ati } as Instr,
                  // wIdx++
                  { op: "local.get", index: wIdx } as Instr,
                  { op: "i32.const", value: 1 } as Instr,
                  { op: "i32.add" } as Instr,
                  { op: "local.set", index: wIdx } as Instr,
                  // sIdx++
                  { op: "local.get", index: sIdx } as Instr,
                  { op: "i32.const", value: 1 } as Instr,
                  { op: "i32.add" } as Instr,
                  { op: "local.set", index: sIdx } as Instr,
                  { op: "br", depth: 0 } as Instr,
                ],
              } as Instr,
            ],
          } as Instr);
        } else {
          // Loop i in [0, len): arr[wIdx++] = __extern_get_idx(src, i)
          const sIdx = allocLocal(fctx, `__xa_si_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "i32.const", value: 0 } as Instr);
          fctx.body.push({ op: "local.set", index: sIdx } as Instr);
          fctx.body.push({
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: sIdx } as Instr,
                  { op: "local.get", index: slot.lenLocal } as Instr,
                  { op: "i32.ge_s" } as Instr,
                  { op: "br_if", depth: 1 } as Instr,
                  // arr[wIdx] = __extern_get_idx(src, f64(sIdx))
                  { op: "local.get", index: arrTmp } as Instr,
                  { op: "local.get", index: wIdx } as Instr,
                  { op: "local.get", index: slot.srcLocal } as Instr,
                  { op: "local.get", index: sIdx } as Instr,
                  { op: "f64.convert_i32_s" } as Instr,
                  { op: "call", funcIdx: getFn } as Instr,
                  { op: "array.set", typeIdx: ati } as Instr,
                  // wIdx++
                  { op: "local.get", index: wIdx } as Instr,
                  { op: "i32.const", value: 1 } as Instr,
                  { op: "i32.add" } as Instr,
                  { op: "local.set", index: wIdx } as Instr,
                  // sIdx++
                  { op: "local.get", index: sIdx } as Instr,
                  { op: "i32.const", value: 1 } as Instr,
                  { op: "i32.add" } as Instr,
                  { op: "local.set", index: sIdx } as Instr,
                  { op: "br", depth: 0 } as Instr,
                ],
              } as Instr,
            ],
          } as Instr);
        }
      }

      // struct.new __vec_externref(total, arr) → __extras_argv
      fctx.body.push({ op: "local.get", index: totalLenLocal } as Instr);
      fctx.body.push({ op: "local.get", index: arrTmp } as Instr);
      fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx } as Instr);
      fctx.body.push({ op: "global.set", index: globalIdx } as Instr);
      return;
    }
    // Helpers unavailable — fall through to the static path (best effort).
  }

  const extrasCount = args.length - startIdx;

  // Build element array: compile each extra arg, coerce to externref, push.
  for (let i = startIdx; i < args.length; i++) {
    const t = compileExpression(ctx, fctx, args[i]!, { kind: "externref" });
    coerceTopToExternref(t);
  }
  fctx.body.push({ op: "array.new_fixed", typeIdx: ati, length: extrasCount });
  const arrTmp = allocLocal(fctx, `__extras_arr_tmp_${fctx.locals.length}`, { kind: "ref", typeIdx: ati });
  fctx.body.push({ op: "local.set", index: arrTmp });
  fctx.body.push({ op: "i32.const", value: extrasCount });
  fctx.body.push({ op: "local.get", index: arrTmp });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx });
  fctx.body.push({ op: "global.set", index: globalIdx } as Instr);
}

/**
 * Shared arguments-vec construction: compiles formal params, concatenates
 * extras from the `__extras_argv` global (#1053), and stores the final vec
 * struct in `argsLocalIdx`. Used by both emitArgumentsObject and the
 * function-body.ts inline path.
 */
export function emitArgumentsVecBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramTypes: ValType[],
  paramOffset: number,
  locals: {
    vecTypeIdx: number;
    arrTypeIdx: number;
    argsLocalIdx: number;
    arrTmpIdx: number;
  },
): void {
  const numArgs = paramTypes.length;
  const { vecTypeIdx: vti, arrTypeIdx: ati, argsLocalIdx: argsLocal, arrTmpIdx: arrTmp } = locals;

  // (#2743 a) Register this arguments vec with the host so its `[[Prototype]]`
  // resolves to %Object.prototype% and `.constructor`/`hasOwnProperty` behave
  // like an ordinary Object (§10.4.4). This is a NEW host import; adding it
  // shifts function indices, so register + flush HERE — before any `call` is
  // emitted below — so the box/unbox `funcMap` lookups resolve post-shift and
  // already-emitted bodies (this fctx + prior functions) are walked by the
  // flush. Host-mode only: standalone/WASI keeps the bare opaque vec.
  if (!ctx.standalone && !ctx.wasi) {
    ensureLateImport(ctx, "__register_arguments", [{ kind: "externref" }], []);
    flushLateImportShifts(ctx, fctx);
  }

  const { globalIdx: extrasGlobalIdx } = ensureExtrasArgvGlobal(ctx);
  const argcGlobalIdx = ensureArgcGlobal(ctx);
  const extrasVecType: ValType = { kind: "ref_null", typeIdx: vti };
  const extrasLocal = allocLocal(fctx, "__extras_argv_local", extrasVecType);
  const extrasLenLocal = allocLocal(fctx, "__extras_len", { kind: "i32" });
  const totalLenLocal = allocLocal(fctx, "__args_total_len", { kind: "i32" });
  const argcLocal = allocLocal(fctx, "__argc_local", { kind: "i32" });

  // Read the actual call-site argument count. Parameter-default prologues cache
  // and clear __argc before initializer expressions can make nested calls; when
  // present, reuse that local so `arguments` observes the same call.
  if (fctx.argcCachedLocal !== undefined) {
    fctx.body.push({ op: "local.get", index: fctx.argcCachedLocal } as Instr);
  } else {
    fctx.body.push({ op: "global.get", index: argcGlobalIdx } as Instr);
  }
  fctx.body.push({ op: "local.tee", index: argcLocal });
  fctx.body.push({ op: "i32.const", value: -1 } as Instr);
  fctx.body.push({ op: "i32.eq" } as Instr);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "i32.const", value: numArgs } as Instr, { op: "local.set", index: argcLocal } as Instr],
    else: [],
  } as Instr);
  if (fctx.argcCachedLocal === undefined) {
    // Clear __argc so nested calls don't see stale data.
    fctx.body.push({ op: "i32.const", value: -1 } as Instr);
    fctx.body.push({ op: "global.set", index: argcGlobalIdx } as Instr);
  }

  // Consume the extras global: read it and immediately clear so nested calls
  // don't see stale data.
  fctx.body.push({ op: "global.get", index: extrasGlobalIdx } as Instr);
  fctx.body.push({ op: "local.set", index: extrasLocal });
  fctx.body.push({ op: "ref.null", typeIdx: vti } as Instr);
  fctx.body.push({ op: "global.set", index: extrasGlobalIdx } as Instr);

  // extrasLen = extrasLocal != null ? extrasLocal.length : 0
  fctx.body.push({ op: "local.get", index: extrasLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val" as const, type: { kind: "i32" } },
    then: [{ op: "i32.const", value: 0 } as Instr],
    else: [
      { op: "local.get", index: extrasLocal } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "struct.get", typeIdx: vti, fieldIdx: 0 } as Instr,
    ],
  } as Instr);
  fctx.body.push({ op: "local.set", index: extrasLenLocal });

  // totalLen = argc + extrasLen (argc = actual call-site args, not formal params)
  fctx.body.push({ op: "local.get", index: argcLocal });
  fctx.body.push({ op: "local.get", index: extrasLenLocal });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: totalLenLocal });

  // arr = array.new_default(totalLen)
  fctx.body.push({ op: "local.get", index: totalLenLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: ati } as Instr);
  fctx.body.push({ op: "local.set", index: arrTmp });

  // Fill formals: arr[i] = box(param[i + paramOffset])
  // Guard each slot with `if (i < argc)` so we only fill actually-passed args.
  // When argc < numArgs (fewer args than formal params), the array is smaller
  // than numArgs and unguarded writes would be OOB.
  for (let i = 0; i < numArgs; i++) {
    const thenInstrs: Instr[] = [];
    thenInstrs.push({ op: "local.get", index: arrTmp } as Instr);
    thenInstrs.push({ op: "i32.const", value: i } as Instr);
    thenInstrs.push({ op: "local.get", index: i + paramOffset } as Instr);
    const pt = paramTypes[i]!;
    if (pt.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        thenInstrs.push({ op: "call", funcIdx: boxIdx } as Instr);
      } else {
        thenInstrs.push({ op: "drop" } as Instr);
        thenInstrs.push({ op: "ref.null.extern" } as Instr);
      }
    } else if (pt.kind === "i32") {
      thenInstrs.push({ op: "f64.convert_i32_s" } as Instr);
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        thenInstrs.push({ op: "call", funcIdx: boxIdx } as Instr);
      } else {
        thenInstrs.push({ op: "drop" } as Instr);
        thenInstrs.push({ op: "ref.null.extern" } as Instr);
      }
    } else if (pt.kind === "ref" || pt.kind === "ref_null") {
      thenInstrs.push({ op: "extern.convert_any" } as Instr);
    }
    thenInstrs.push({ op: "array.set", typeIdx: ati } as Instr);

    // Emit: if (i < argc) { ...thenInstrs }
    fctx.body.push({ op: "i32.const", value: i } as Instr);
    fctx.body.push({ op: "local.get", index: argcLocal });
    fctx.body.push({ op: "i32.lt_s" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: thenInstrs,
      else: [],
    } as Instr);
  }

  // If extras is non-null, copy extras into arr starting at offset numArgs.
  fctx.body.push({ op: "local.get", index: extrasLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [],
    else: [
      { op: "local.get", index: arrTmp } as Instr,
      { op: "i32.const", value: numArgs } as Instr,
      { op: "local.get", index: extrasLocal } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "struct.get", typeIdx: vti, fieldIdx: 1 } as Instr,
      { op: "i32.const", value: 0 } as Instr,
      { op: "local.get", index: extrasLenLocal } as Instr,
      { op: "array.copy", dstTypeIdx: ati, srcTypeIdx: ati } as Instr,
    ],
  } as Instr);

  // vec = { length: totalLen, data: arr }
  fctx.body.push({ op: "local.get", index: totalLenLocal });
  fctx.body.push({ op: "local.get", index: arrTmp });
  fctx.body.push({ op: "struct.new", typeIdx: vti });
  fctx.body.push({ op: "local.set", index: argsLocal });

  // (#2743 a) Tag the freshly-built vec as an ordinary arguments Object. The
  // import + index shift were settled at the top of this function, so the
  // funcMap entry is final here — no further shift between registration and use.
  const registerArgsIdx = ctx.funcMap.get("__register_arguments");
  if (registerArgsIdx !== undefined && !ctx.standalone && !ctx.wasi) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    fctx.body.push({ op: "extern.convert_any" } as Instr);
    fctx.body.push({ op: "call", funcIdx: registerArgsIdx } as Instr);
  }
}

/**
 * Emit code to create an `arguments` vec struct from function parameters.
 * paramOffset is the number of leading params to skip (e.g. captures).
 *
 * Uses an externref-backed vec so that all parameter types (f64, i32,
 * externref, ref) are preserved as externref values.  This matches JS
 * semantics where `arguments[n]` returns the original value.
 */
export function emitArgumentsObject(
  ctx: CodegenContext,
  fctx: FunctionContext,
  paramTypes: ValType[],
  paramOffset: number,
  unmapped = false,
): void {
  const numArgs = paramTypes.length;
  const elemType: ValType = { kind: "externref" };
  const vti = getOrRegisterVecType(ctx, "externref", elemType);
  const ati = getArrTypeIdxFromVec(ctx, vti);
  const vecRef: ValType = { kind: "ref", typeIdx: vti };
  const argsLocal = allocLocal(fctx, "arguments", vecRef);
  const arrTmp = allocLocal(fctx, "__args_arr_tmp", { kind: "ref", typeIdx: ati });

  // Ensure __box_number and __unbox_number are available for mapped arguments sync
  const hasNumericParams = paramTypes.some((pt) => pt.kind === "f64" || pt.kind === "i32");
  if (hasNumericParams) {
    ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
    ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
    flushLateImportShifts(ctx, fctx);
  }

  // Set up mapped arguments info for param ↔ arguments bidirectional sync (#849).
  // Strict-mode functions get an *unmapped* arguments object (§10.4.4): skip the
  // sync so writes to `arguments[i]` don't reflect into the named param (#779e).
  if (!unmapped) {
    fctx.mappedArgsInfo = {
      argsLocalIdx: argsLocal,
      arrTypeIdx: ati,
      vecTypeIdx: vti,
      paramCount: numArgs,
      paramOffset,
      paramTypes: paramTypes.slice(),
    };
  }

  // Build the arguments vec by concatenating formal params with
  // extras delivered via the __extras_argv global (#1053).
  emitArgumentsVecBody(ctx, fctx, paramTypes, paramOffset, {
    vecTypeIdx: vti,
    arrTypeIdx: ati,
    argsLocalIdx: argsLocal,
    arrTmpIdx: arrTmp,
  });
}

// Register delegates in shared.ts so index.ts can call these without
// importing statements/nested-declarations.ts directly (cycle prevention).
registerHoistFunctionDeclarations(hoistFunctionDeclarations);
registerEmitArgumentsObject(emitArgumentsObject);
