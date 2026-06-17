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
import { isStrictFunction } from "../helpers/is-strict-function.js";
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
  compileNativeGeneratorFunction,
  isNativeGeneratorCandidate,
  registerNativeGenerator,
} from "../generators-native.js";
import { emitThrowReferenceError, emitThrowString, emitThrowTypeError } from "../expressions/helpers.js";
import {
  collectClassDeclaration,
  compileClassBodies,
  destructureParamArray,
  destructureParamObject,
  extractConstantDefault,
  resolveWasmType,
} from "../index.js";
import { ensureExnTag, nextModuleGlobalIdx } from "../registry/imports.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterRefCellType,
  getOrRegisterVecType,
} from "../registry/types.js";
import {
  compileExpression,
  compileStatement,
  ensureLateImport,
  flushLateImportShifts,
  registerEmitArgumentsObject,
  registerHoistFunctionDeclarations,
} from "../shared.js";

/**
 * §15.7.1 ClassDefinitionEvaluation: the class name binding is added to the
 * class's inner scope AFTER the `extends` clause is evaluated. Referencing the
 * class name inside its own `extends` expression therefore hits the TDZ and
 * must throw ReferenceError (e.g. `class x extends x {}`). Returns true if the
 * extends heritage clause contains an identifier equal to the class name.
 */
function extendsReferencesClassName(decl: ts.ClassDeclaration, className: string): boolean {
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
  decl: ts.ClassDeclaration,
): void {
  if (!decl.name) return;
  const className = decl.name.text;

  // §15.7.1: the class name is in TDZ while its own `extends` clause is
  // evaluated. `class x extends x {}` must throw ReferenceError (#1594B).
  if (extendsReferencesClassName(decl, className)) {
    emitThrowReferenceError(ctx, fctx, `Cannot access '${className}' before initialization`);
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
    // Collect struct type, constructor, and method stubs (if not already done)
    if (!ctx.structMap.has(className)) {
      collectClassDeclaration(ctx, decl);
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
    compileClassBodies(ctx, decl, funcByName);

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

  const sig = ctx.checker.getSignatureFromDeclaration(stmt);
  let returnType: ValType | null = null;
  if (isGenerator) {
    // Generator functions return externref (JS Generator object)
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
    if (ctx.funcMap.has(name)) continue;
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
    const isMutable = writtenInBody.has(name);
    captures.push({ name, type, localIdx, mutable: isMutable, hasTdzFlag, tdzFlagIdx });
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
      const reservedFuncIdxNC = ctx.numImportFuncs + ctx.mod.functions.length;
      reservedEntryNC = {
        name: funcName,
        typeIdx: funcTypeIdx,
        locals: [],
        body: [],
        exported: false,
      };
      ctx.mod.functions.push(reservedEntryNC);
      ctx.funcMap.set(funcName, reservedFuncIdxNC);
    }

    // Emit default-value initialization for parameters with initializers
    emitDefaultParamInit(ctx, liftedFctx, stmt, paramTypes, 0);

    // Destructure parameters with binding patterns
    for (let pi = 0; pi < stmt.parameters.length; pi++) {
      const param = stmt.parameters[pi]!;
      if (ts.isObjectBindingPattern(param.name)) {
        destructureParamObject(ctx, liftedFctx, pi, param.name, paramTypes[pi]!);
      } else if (ts.isArrayBindingPattern(param.name)) {
        destructureParamArray(ctx, liftedFctx, pi, param.name, paramTypes[pi]!);
      }
    }

    // Set up `arguments` object if the function body references it
    if (stmt.body && bodyUsesArguments(stmt.body)) {
      emitArgumentsObject(ctx, liftedFctx, paramTypes, 0, isStrictFunction(stmt));
    }

    if (nativeGenInfo) {
      // (#2172) No-capture nested `function*` in standalone/WASI — emit the
      // Wasm-native generator factory (builds + returns the state struct), the
      // same body the top-level path emits. No host imports, no JS buffer.
      compileNativeGeneratorFunction(ctx, liftedFctx, stmt, nativeGenInfo);
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
    const funcTypeIdx = addFuncType(ctx, allParamTypes, results, `${funcName}_type`);
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
    const reservedFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    const reservedEntry = {
      name: funcName,
      typeIdx: funcTypeIdx,
      locals: [] as Array<{ name: string; type: ValType }>,
      body: [] as Instr[],
      exported: false,
    };
    ctx.mod.functions.push(reservedEntry);
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

    // Emit default-value initialization for parameters with initializers
    // (offset by number of captures since they are prepended as leading params)
    emitDefaultParamInit(ctx, liftedFctx, stmt, paramTypes, captures.length);

    // Destructure parameters with binding patterns (offset by captures)
    for (let pi = 0; pi < stmt.parameters.length; pi++) {
      const param = stmt.parameters[pi]!;
      const paramIdx = captures.length + pi;
      if (ts.isObjectBindingPattern(param.name)) {
        destructureParamObject(ctx, liftedFctx, paramIdx, param.name, paramTypes[pi]!);
      } else if (ts.isArrayBindingPattern(param.name)) {
        destructureParamArray(ctx, liftedFctx, paramIdx, param.name, paramTypes[pi]!);
      }
    }

    // Set up `arguments` object if the function body references it
    if (stmt.body && bodyUsesArguments(stmt.body)) {
      emitArgumentsObject(ctx, liftedFctx, paramTypes, captures.length, isStrictFunction(stmt));
    }

    if (isGenerator) {
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
export function hoistFunctionDeclarations(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmts: ts.NodeArray<ts.Statement> | ts.Statement[],
): void {
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
        if (ctx.funcMap.has(name)) continue;
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
      const sig = ctx.checker.getSignatureFromDeclaration(stmt);
      let resultType: ValType | undefined;
      if (isGen) {
        resultType = { kind: "externref" };
      } else if (sig) {
        let rt = ctx.checker.getReturnTypeOfSignature(sig);
        if (isAsync) rt = unwrapPromiseType(rt, ctx.checker);
        if (!isVoidType(rt)) resultType = resolveWasmType(ctx, rt);
      }
      const funcTypeIdx = addFuncType(ctx, paramTypes, resultType ? [resultType] : [], `${funcName}_type`);
      const reservedFuncIdx = ctx.numImportFuncs + ctx.mod.functions.length;
      const reserved: WasmFunction = {
        name: funcName,
        typeIdx: funcTypeIdx,
        locals: [],
        body: [],
        exported: false,
      };
      ctx.mod.functions.push(reserved);
      ctx.funcMap.set(funcName, reservedFuncIdx);
      if (!ctx.preRegisteredBodyless) ctx.preRegisteredBodyless = new Set();
      ctx.preRegisteredBodyless.add(funcName);
    }
  }

  for (const stmt of stmts) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      const funcName = stmt.name.text;
      const hasReservedBodylessEntry = ctx.preRegisteredBodyless?.has(funcName) ?? false;
      const reservedFuncIdx = hasReservedBodylessEntry ? ctx.funcMap.get(funcName) : undefined;
      const reservedEntry =
        reservedFuncIdx !== undefined ? ctx.mod.functions[reservedFuncIdx - ctx.numImportFuncs] : undefined;
      if (!ctx.funcMap.has(funcName) || reservedEntry) {
        // Save state so we can roll back if compilation fails
        const errorsBefore = ctx.errors.length;
        const funcsBefore = ctx.mod.functions.length;

        compileNestedFunctionDeclaration(ctx, fctx, stmt, reservedEntry ? { reuseReservedEntry: reservedEntry } : {});

        // If new errors were added during hoisting, roll back
        if (ctx.errors.length > errorsBefore) {
          ctx.errors.length = errorsBefore;
          ctx.mod.functions.length = funcsBefore;
          if (reservedEntry) {
            reservedEntry.locals = [];
            reservedEntry.body = [];
          } else {
            ctx.funcMap.delete(funcName);
            ctx.nestedFuncCaptures.delete(funcName);
            ctx.funcOptionalParams.delete(funcName);
          }
          // Track failed hoist so compileStatement doesn't re-attempt
          if (!ctx.hoistFailedFuncs) ctx.hoistFailedFuncs = new Set();
          ctx.hoistFailedFuncs.add(funcName);
        } else if (reservedEntry) {
          ctx.preRegisteredBodyless?.delete(funcName);
        }
      }
    }
    // Recurse into block-like structures to find nested function declarations.
    // In JS, function declarations are hoisted to the enclosing function scope,
    // even when inside if-branches, try/catch blocks, etc.
    if (ts.isIfStatement(stmt)) {
      if (ts.isBlock(stmt.thenStatement)) {
        hoistFunctionDeclarations(ctx, fctx, stmt.thenStatement.statements);
      }
      if (stmt.elseStatement) {
        if (ts.isBlock(stmt.elseStatement)) {
          hoistFunctionDeclarations(ctx, fctx, stmt.elseStatement.statements);
        } else if (ts.isIfStatement(stmt.elseStatement)) {
          hoistFunctionDeclarations(ctx, fctx, [stmt.elseStatement]);
        }
      }
    }
    if (ts.isTryStatement(stmt)) {
      hoistFunctionDeclarations(ctx, fctx, stmt.tryBlock.statements);
      if (stmt.catchClause) {
        hoistFunctionDeclarations(ctx, fctx, stmt.catchClause.block.statements);
      }
      if (stmt.finallyBlock) {
        hoistFunctionDeclarations(ctx, fctx, stmt.finallyBlock.statements);
      }
    }
    if (ts.isBlock(stmt)) {
      hoistFunctionDeclarations(ctx, fctx, stmt.statements);
    }
    // Recurse into loop bodies — function declarations inside loops are hoisted
    // to the enclosing function scope in JS semantics.
    if (ts.isForStatement(stmt) || ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
      if (ts.isBlock(stmt.statement)) {
        hoistFunctionDeclarations(ctx, fctx, stmt.statement.statements);
      } else {
        hoistFunctionDeclarations(ctx, fctx, [stmt.statement]);
      }
    }
    if (ts.isForInStatement(stmt) || ts.isForOfStatement(stmt)) {
      if (ts.isBlock(stmt.statement)) {
        hoistFunctionDeclarations(ctx, fctx, stmt.statement.statements);
      } else {
        hoistFunctionDeclarations(ctx, fctx, [stmt.statement]);
      }
    }
    if (ts.isSwitchStatement(stmt)) {
      for (const clause of stmt.caseBlock.clauses) {
        hoistFunctionDeclarations(ctx, fctx, clause.statements);
      }
    }
    if (ts.isLabeledStatement(stmt)) {
      if (ts.isBlock(stmt.statement)) {
        hoistFunctionDeclarations(ctx, fctx, stmt.statement.statements);
      } else {
        hoistFunctionDeclarations(ctx, fctx, [stmt.statement]);
      }
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
  const extrasCount = args.length - startIdx;

  // Build element array: compile each extra arg, coerce to externref, push.
  for (let i = startIdx; i < args.length; i++) {
    const t = compileExpression(ctx, fctx, args[i]!, { kind: "externref" });
    if (t === null) {
      fctx.body.push({ op: "ref.null.extern" });
      continue;
    }
    if (t.kind === "f64") {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
    } else if (t.kind === "i32") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
      } else {
        fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "ref.null.extern" });
      }
    } else if (t.kind === "ref" || t.kind === "ref_null") {
      fctx.body.push({ op: "extern.convert_any" } as Instr);
    }
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
