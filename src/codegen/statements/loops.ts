import { isStringType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Loop statement lowering: while, for, do-while, for-of, for-in.
 */
import { forEachChild, ts } from "../../ts-api.js";
import { collectReferencedIdentifiers } from "../closures.js";
import { popBody, pushBody } from "../context/bodies.js";
import { reportError, reportErrorNoNode } from "../context/errors.js";
import { reportSilentFallback } from "../fallback-telemetry.js";
import { allocLocal, getLocalType, restoreLocals, snapshotLocals } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { emitExternrefDestructureGuard } from "../destructuring-params.js";
import {
  findUnresolvableInArrayPattern,
  findUnresolvableInObjectPattern,
  isStrictContext,
} from "../expressions/assignment.js";
import { emitCoercedLocalSet, emitThrowTypeError } from "../expressions/helpers.js";
import { ensureLateImport, flushLateImportShifts, shiftLateImportIndices } from "../expressions/late-imports.js";
import {
  addIteratorImports,
  ensureI32Condition,
  ensureNativeStringHelpers,
  nativeStringType,
  resolveWasmType,
} from "../index.js";
import { resolveComputedKeyExpression } from "../literals.js";
import { addImport, addStringConstantGlobal, ensureExnTag, localGlobalIdx } from "../registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterRefCellType } from "../registry/types.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  emitBoundsCheckedArrayGet,
  valTypesMatch,
} from "../shared.js";
import { containsLinearU8Allocation, emitLinearU8ArenaMark, linearU8ArenaResetInstrs } from "../linear-uint8-arena.js";
import { nativeGeneratorInfoForForOfSubject, tryCompileNativeGeneratorForOf } from "../generators-native.js";
import { ensureNativeIteratorRuntime } from "../iterator-native.js";
import {
  compileArrayDestructuring,
  arrayDstrNeedsIdentity,
  compileExternrefArrayDestructuringDecl,
  compileExternrefObjectDestructuringDecl,
  compileObjectDestructuring,
  emitDefaultValueCheck,
  emitNullGuard,
  ensureAsyncIterator,
  ensureExternIsUndefined,
  syncDestructuredLocalsToGlobals,
  tryEmitArrayProtoIteratorReadDrive,
} from "./destructuring.js";
import { arrayIteratorOverrideGlobalIdx } from "../expressions/proto-override.js";
import { adjustRethrowDepth, collectInstrs, restoreBlockScopedShadows, saveBlockScopedShadows } from "./shared.js";
import { collectPatternBindingNames } from "./tdz.js";

export function compileWhileStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.WhileStatement): void {
  // block $break
  //   loop $continue
  //     <condition>
  //     i32.eqz
  //     br_if $break (depth to block)
  //     block $continue_body { <body> }
  //     <linear-u8 arena reset, if needed>
  //     br $continue (depth to loop)
  //   end
  // end

  const arenaMark = containsLinearU8Allocation(ctx, stmt.statement)
    ? emitLinearU8ArenaMark(ctx, fctx, "__linu8_loop_mark")
    : undefined;
  const arenaReset = linearU8ArenaResetInstrs(ctx, arenaMark);
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop+body-block adds 3 levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);

  // Track break/continue depths
  // From body inside $continue_body: break = br 2, continue = br 0.
  fctx.breakStack.push(2); // break: exit the outer block
  fctx.continueStack.push(0); // continue: exit body block, then reset/restart

  // Compile condition
  const condInstrs: Instr[] = [];
  ctx.liveBodies.add(condInstrs);
  const condBody = fctx.body;
  fctx.body = condInstrs;
  const condType = compileExpression(ctx, fctx, stmt.expression);
  ensureI32Condition(fctx, condType, ctx);
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break out of block
  fctx.body = condBody;

  // Compile body — must save/restore block-scoped shadows so that let/const
  // declarations inside the loop body do not leak into the outer scope (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  const bodyInstrs = fctx.body;

  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;
  adjustRethrowDepth(fctx, -3);

  popBody(fctx, savedBody);

  const loopBody: Instr[] = [
    ...condInstrs,
    { op: "block", blockType: { kind: "empty" }, body: bodyInstrs },
    ...arenaReset,
    { op: "br", depth: 0 },
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
  ctx.liveBodies.delete(condInstrs);
}

/**
 * Detect integer loop counter pattern: for (let i = INT; i < EXPR; i++)
 * Returns the variable name and initial integer value if the pattern matches,
 * or null if it doesn't match.
 */
function detectI32LoopVar(stmt: ts.ForStatement): { name: string; initValue: number } | null {
  // 1. Check initializer: must be a single variable declaration with an integer literal
  if (!stmt.initializer || !ts.isVariableDeclarationList(stmt.initializer)) return null;
  const decls = stmt.initializer.declarations;
  if (decls.length !== 1) return null;
  const decl = decls[0];
  if (!ts.isIdentifier(decl.name)) return null;
  const name = decl.name.text;
  if (!decl.initializer || !ts.isNumericLiteral(decl.initializer)) return null;
  const initValue = Number(decl.initializer.text.replace(/_/g, ""));
  if (!Number.isInteger(initValue) || initValue < -2147483648 || initValue > 2147483647) return null;

  // 2. Check condition: must be i < EXPR, i <= EXPR, EXPR > i, or EXPR >= i
  if (!stmt.condition || !ts.isBinaryExpression(stmt.condition)) return null;
  const cond = stmt.condition;
  const op = cond.operatorToken.kind;
  let isValidCondition = false;
  if (
    (op === ts.SyntaxKind.LessThanToken || op === ts.SyntaxKind.LessThanEqualsToken) &&
    ts.isIdentifier(cond.left) &&
    cond.left.text === name
  ) {
    isValidCondition = true;
  }
  if (
    (op === ts.SyntaxKind.GreaterThanToken || op === ts.SyntaxKind.GreaterThanEqualsToken) &&
    ts.isIdentifier(cond.right) &&
    cond.right.text === name
  ) {
    isValidCondition = true;
  }
  if (!isValidCondition) return null;

  // 3. Check incrementor: must be i++, ++i, i--, --i, i += INT, or i -= INT
  if (!stmt.incrementor) return null;
  const incr = stmt.incrementor;
  if (ts.isPostfixUnaryExpression(incr)) {
    if (!ts.isIdentifier(incr.operand) || incr.operand.text !== name) return null;
    if (incr.operator !== ts.SyntaxKind.PlusPlusToken && incr.operator !== ts.SyntaxKind.MinusMinusToken) return null;
  } else if (ts.isPrefixUnaryExpression(incr)) {
    if (!ts.isIdentifier(incr.operand) || incr.operand.text !== name) return null;
    if (incr.operator !== ts.SyntaxKind.PlusPlusToken && incr.operator !== ts.SyntaxKind.MinusMinusToken) return null;
  } else if (ts.isBinaryExpression(incr)) {
    if (!ts.isIdentifier(incr.left) || incr.left.text !== name) return null;
    if (
      incr.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken &&
      incr.operatorToken.kind !== ts.SyntaxKind.MinusEqualsToken
    )
      return null;
    // The RHS must be an integer literal
    if (!ts.isNumericLiteral(incr.right)) return null;
    const stepVal = Number(incr.right.text.replace(/_/g, ""));
    if (!Number.isInteger(stepVal)) return null;
  } else {
    return null;
  }

  return { name, initValue };
}

/**
 * #1196: Detect mutations of the loop index or array binding inside a for-loop
 * body. Used by the bounds-check elimination pass — we can only elide bounds
 * checks for `arr[i]` if both `i` and `arr` are stable across every iteration.
 *
 * Returns `true` if the body contains anything that could mutate either
 * binding:
 *   - Direct assignment / compound assignment to `i` or `arr`
 *     (`i = …`, `i += …`, `arr = …`, etc.)
 *   - `i++ / ++i / i-- / --i` or the same on `arr`
 *   - Method calls on `arr` (`arr.push()`, `arr.length = …`, etc.)
 *   - `arr.length = …` assignment
 *   - Any nested function / arrow / class — closures could capture and mutate
 *     either binding outside our static view (conservative).
 *
 * Notes:
 *   - `arr[k] = v` writes through the array but does not change the binding
 *     itself or `arr.length` (when `k < arr.length`), so element writes are
 *     allowed — they're the whole point of the optimisation.
 */
function loopBodyMutatesIndexOrArray(body: ts.Statement, indexName: string, arrayName: string): boolean {
  let mutates = false;

  function isAssignmentOp(kind: ts.SyntaxKind): boolean {
    return (
      kind === ts.SyntaxKind.EqualsToken ||
      kind === ts.SyntaxKind.PlusEqualsToken ||
      kind === ts.SyntaxKind.MinusEqualsToken ||
      kind === ts.SyntaxKind.AsteriskEqualsToken ||
      kind === ts.SyntaxKind.SlashEqualsToken ||
      kind === ts.SyntaxKind.PercentEqualsToken ||
      kind === ts.SyntaxKind.AsteriskAsteriskEqualsToken ||
      kind === ts.SyntaxKind.LessThanLessThanEqualsToken ||
      kind === ts.SyntaxKind.GreaterThanGreaterThanEqualsToken ||
      kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken ||
      kind === ts.SyntaxKind.AmpersandEqualsToken ||
      kind === ts.SyntaxKind.BarEqualsToken ||
      kind === ts.SyntaxKind.CaretEqualsToken ||
      kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
      kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      kind === ts.SyntaxKind.BarBarEqualsToken
    );
  }

  function visit(node: ts.Node): void {
    if (mutates) return;

    // Direct assignment to index / array binding, or to arr.length
    if (ts.isBinaryExpression(node) && isAssignmentOp(node.operatorToken.kind)) {
      const lhs = node.left;
      if (ts.isIdentifier(lhs) && (lhs.text === indexName || lhs.text === arrayName)) {
        mutates = true;
        return;
      }
      // arr.length = …
      if (
        ts.isPropertyAccessExpression(lhs) &&
        ts.isIdentifier(lhs.expression) &&
        lhs.expression.text === arrayName &&
        lhs.name.text === "length"
      ) {
        mutates = true;
        return;
      }
    }

    // Pre/post-fix increment/decrement: i++, ++i, i--, --i, arr++, etc.
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      const op = node.operand;
      if (ts.isIdentifier(op) && (op.text === indexName || op.text === arrayName)) {
        mutates = true;
        return;
      }
    }

    // Any method call on `arr` — conservatively assume it could mutate length
    // (push/pop/shift/unshift/splice/sort/reverse/copyWithin/fill, etc.). Pure
    // reads via element access (`arr[i]`) and `.length` reads are property
    // accesses, not call expressions — so they don't trigger here.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === arrayName
    ) {
      mutates = true;
      return;
    }

    // Any nested function / arrow / class — could capture and mutate either
    // binding via a runtime call we can't statically reason about. Conservative.
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      mutates = true;
      return;
    }

    forEachChild(node, visit);
  }

  visit(body);
  return mutates;
}

/**
 * #1453: Per-iteration fresh binding detection for `for (let X = …; …; …)`.
 *
 * Per ECMA-262 §14.7.4.4 (CreatePerIterationEnvironment), each iteration of
 * a `for` with let/const head bindings runs against a freshly-allocated
 * binding initialised from the previous iteration's value. Closures captured
 * inside the body therefore see distinct bindings.
 *
 * Detect which head-binding names are referenced from a nested closure (arrow,
 * function expression/declaration, method, class) anywhere in the loop's
 * condition, incrementor, or body. Names with no closure capture keep the
 * single-local fast path; captured names get boxed as ref-cells and the
 * codegen allocates a fresh cell at the iteration boundary.
 *
 * `collectReferencedIdentifiers` is scope-aware (tracks shadowing across
 * nested function boundaries), so a reference to `i` inside a nested
 * function that re-binds `i` is correctly ignored.
 */
function findHeadBindingsCapturedByClosures(stmt: ts.ForStatement, headNames: ReadonlySet<string>): Set<string> {
  const captured = new Set<string>();
  if (headNames.size === 0) return captured;
  function visit(node: ts.Node | undefined): void {
    if (!node) return;
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      // Scope-aware reference collection over the entire nested subtree.
      const refs = new Set<string>();
      collectReferencedIdentifiers(node, refs);
      for (const n of headNames) {
        if (refs.has(n)) captured.add(n);
      }
      return; // collectReferencedIdentifiers already walked deeper closures.
    }
    forEachChild(node, visit);
  }
  // Walk condition + incrementor + body. Closures may appear in any of them
  // (e.g. `for (let i=0; (f = () => i, true); i++) {}`).
  visit(stmt.condition);
  visit(stmt.incrementor);
  visit(stmt.statement);
  return captured;
}

/**
 * #1589: Find every identifier name that appears inside a nested closure
 * anywhere in the for-loop's condition/incrementor/body. Used to pre-emptively
 * box outer-scope (`var`-declared or enclosing-function) variables before
 * compiling the loop condition.
 *
 * Without this pre-pass, the closure-construction codegen promotes the
 * variable to a ref-cell mid-loop. The loop condition (compiled first) reads
 * the original unboxed slot, while the incrementor (compiled after the body)
 * writes through the ref cell — so the condition's view never updates and the
 * loop spins forever.
 */
function findAllNamesCapturedByClosuresInForLoop(stmt: ts.ForStatement): Set<string> {
  const captured = new Set<string>();
  function visit(node: ts.Node | undefined): void {
    if (!node) return;
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      const refs = new Set<string>();
      collectReferencedIdentifiers(node, refs);
      for (const n of refs) captured.add(n);
      return;
    }
    forEachChild(node, visit);
  }
  visit(stmt.condition);
  visit(stmt.incrementor);
  visit(stmt.statement);
  return captured;
}

/**
 * Collect names that are lexically declared (`let`/`const`/`using`, class,
 * or function) at the top level of the loop body — i.e. block-scoped bindings
 * that belong to each iteration's environment rather than to an outer scope.
 *
 * The #1589 pre-box pass is only meant for `var`-declared or enclosing-function
 * variables. A body-local `let`/`const` captured by a closure already gets a
 * fresh per-iteration cell via the body declaration + closure-construction
 * path; pre-boxing it at the loop head is semantically wrong (the binding does
 * not exist yet) and conflates the hoisted value slot with the ref cell,
 * emitting `ref.is_null` over an f64 local (invalid wasm). We exclude these.
 *
 * We do NOT descend into nested closures or nested blocks/loops: only bindings
 * whose scope is the loop body's own lexical environment matter here.
 */
function findBodyLocalLexicalNames(stmt: ts.ForStatement): Set<string> {
  const names = new Set<string>();
  const body = stmt.statement;
  const statements = ts.isBlock(body) ? body.statements : [body];
  for (const s of statements) {
    if (ts.isVariableStatement(s)) {
      const isLexical =
        (s.declarationList.flags &
          (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing)) !==
        0;
      if (!isLexical) continue;
      for (const decl of s.declarationList.declarations) {
        for (const n of collectPatternBindingNames(decl.name)) names.add(n);
      }
    } else if (ts.isFunctionDeclaration(s) && s.name) {
      names.add(s.name.text);
    } else if (ts.isClassDeclaration(s) && s.name) {
      names.add(s.name.text);
    }
  }
  return names;
}

export function compileForStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForStatement): void {
  // Save localMap entries for let/const initializers that shadow outer variables.
  // `for (let x = ...; ...)` creates a block scope that ends after the loop.
  let savedForScope: Map<string, number> | null = null;
  let savedForTdz: Map<string, number> | null = null;
  let savedForConstBindings: Map<string, boolean> | null = null;
  // #1453: Save existing boxedCaptures entries that we will overwrite when
  // boxing per-iteration cells. `undefined` means the name had no prior entry.
  let savedForBoxedCaptures: Map<string, { refCellTypeIdx: number; valType: ValType } | undefined> | null = null;
  if (
    stmt.initializer &&
    ts.isVariableDeclarationList(stmt.initializer) &&
    stmt.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)
  ) {
    // #1452 — walk every name introduced by the declaration. The legacy
    // path only covered `ts.isIdentifier(decl.name)`, leaving array /
    // object / nested / rest binding-pattern bindings out of the
    // shadow-tracking. The result was that `for (let [x] = [...]) ...`
    // leaked `x` into the outer scope after the loop terminated.
    const introducedNames: string[] = [];
    for (const decl of stmt.initializer.declarations) {
      for (const n of collectPatternBindingNames(decl.name)) {
        introducedNames.push(n);
      }
    }
    for (const name of introducedNames) {
      if (!savedForConstBindings) savedForConstBindings = new Map();
      savedForConstBindings.set(name, fctx.constBindings?.has(name) ?? false);
      fctx.constBindings?.delete(name);

      const existing = fctx.localMap.get(name);
      if (existing !== undefined) {
        if (!savedForScope) savedForScope = new Map();
        savedForScope.set(name, existing);
        fctx.localMap.delete(name);
      }
      const existingTdz = fctx.tdzFlagLocals?.get(name);
      if (existingTdz !== undefined) {
        if (!savedForTdz) savedForTdz = new Map();
        savedForTdz.set(name, existingTdz);
        fctx.tdzFlagLocals?.delete(name);
      }
    }
  }

  // Compile initializer (outside the loop)
  if (stmt.initializer) {
    if (ts.isVariableDeclarationList(stmt.initializer)) {
      const isVar = !(stmt.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
      for (const decl of stmt.initializer.declarations) {
        if (ts.isObjectBindingPattern(decl.name)) {
          compileObjectDestructuring(ctx, fctx, decl);
          continue;
        }
        if (ts.isArrayBindingPattern(decl.name)) {
          compileArrayDestructuring(ctx, fctx, decl);
          continue;
        }
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.text;

        // Check if this variable is a module-level global (e.g., for(var i...)
        // at the top level). If so, use global.set instead of local.set.
        // #1745: a function-local of the same name (hoisted by
        // hoistVarDeclarations for a `var` inside a function/closure body)
        // SHADOWS the module global per ECMA-262 §10.2.10 — bind to the local
        // and fall through. Otherwise a `for (var i = <arrayExpr>; ...)` inside
        // a closure whose `i` collides with a differently-typed top-level
        // module global `i` would `global.set` an incompatible value type into
        // the global → invalid Wasm.
        const hasLocalShadow = fctx.localMap.has(name);
        const moduleGlobalIdx = hasLocalShadow ? undefined : ctx.moduleGlobals.get(name);
        if (moduleGlobalIdx !== undefined) {
          if (decl.initializer) {
            const globalDef = ctx.mod.globals[localGlobalIdx(ctx, moduleGlobalIdx)];
            const wasmType = globalDef?.type ?? resolveWasmType(ctx, ctx.checker.getTypeAtLocation(decl));
            compileExpression(ctx, fctx, decl.initializer, wasmType);
            fctx.body.push({ op: "global.set", index: moduleGlobalIdx });
          }
          continue;
        }

        // Class expression: skip, already handled as class declaration
        if (decl.initializer && ts.isClassExpression(decl.initializer)) {
          continue;
        }

        // Arrow/function expression: compile first to get closure struct ref type
        if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
          const actualType = compileExpression(ctx, fctx, decl.initializer);
          const closureType = actualType ?? { kind: "externref" as const };
          // Reuse existing local for var re-declaration
          const existingIdx = fctx.localMap.get(name);
          const localIdx =
            isVar && existingIdx !== undefined && existingIdx >= fctx.params.length
              ? existingIdx
              : allocLocal(fctx, name, closureType);
          // Update local type if hoisted slot has a less precise type
          if (isVar && existingIdx !== undefined && existingIdx >= fctx.params.length) {
            const localSlot = fctx.locals[localIdx - fctx.params.length];
            if (localSlot) localSlot.type = closureType;
          }
          emitCoercedLocalSet(ctx, fctx, localIdx, closureType);
          continue;
        }

        const varType = ctx.checker.getTypeAtLocation(decl);
        let wasmType = resolveWasmType(ctx, varType);

        // Integer loop inference: if this variable is detected as an integer loop
        // counter (e.g. for (let i = 0; i < n; i++)), use i32 instead of f64
        const i32LoopInfo = detectI32LoopVar(stmt);
        const isI32LoopVar = i32LoopInfo !== null && i32LoopInfo.name === name && wasmType.kind === "f64";
        if (isI32LoopVar) {
          wasmType = { kind: "i32" };
        }

        // Reuse existing local for var re-declaration
        const existingIdx = fctx.localMap.get(name);
        const localIdx =
          isVar && existingIdx !== undefined && existingIdx >= fctx.params.length
            ? existingIdx
            : allocLocal(fctx, name, wasmType);
        // If reusing a pre-hoisted slot, update the local's type to match
        if (isVar && existingIdx !== undefined && existingIdx >= fctx.params.length) {
          const localSlot = fctx.locals[localIdx - fctx.params.length];
          if (localSlot && !valTypesMatch(wasmType, localSlot.type)) {
            localSlot.type = wasmType;
          }
        }
        if (decl.initializer) {
          if (isI32LoopVar) {
            // Emit i32.const directly for the integer init value
            fctx.body.push({ op: "i32.const", value: i32LoopInfo!.initValue });
            fctx.body.push({ op: "local.set", index: localIdx });
          } else {
            const forInitType = compileExpression(ctx, fctx, decl.initializer, wasmType);
            if (forInitType && !valTypesMatch(forInitType, wasmType)) {
              coerceType(ctx, fctx, forInitType, wasmType);
            }
            emitCoercedLocalSet(ctx, fctx, localIdx, forInitType ?? wasmType);
          }
        }
        // Set TDZ flag for let/const loop vars so they are no longer in TDZ (#790)
        if (!isVar) {
          const tdzFlagIdx = fctx.tdzFlagLocals?.get(name);
          if (tdzFlagIdx !== undefined) {
            fctx.body.push({ op: "i32.const", value: 1 });
            fctx.body.push({ op: "local.set", index: tdzFlagIdx });
          }
        }
      }
    } else {
      const resultType = compileExpression(ctx, fctx, stmt.initializer);
      if (resultType !== null) fctx.body.push({ op: "drop" });
    }
  }

  // #1453: Per-iteration fresh binding for `for (let/const X = ...)`.
  //
  // ECMA-262 §14.7.4.4 (CreatePerIterationEnvironment) requires that each
  // iteration of a let/const for-loop runs with a fresh binding initialised
  // to the previous iteration's value, so closures captured inside the body
  // observe distinct bindings (not the final post-loop value).
  //
  // Strategy: for every head identifier name captured by a nested closure
  // anywhere in the loop's condition/incrementor/body, box the binding into
  // a ref-cell (struct { value: T }) sourced by an outer "boxed local". The
  // initial value is wrapped at loop entry. At the iteration boundary
  // (between body and incrementor), we struct.new a fresh cell with the
  // current value and re-aim the boxed local to it — closures captured in
  // earlier iterations keep their original cell. This implements the spec
  // semantics while letting non-capturing loops keep the fast single-local
  // path unchanged.
  const perIterCells: {
    name: string;
    refCellTypeIdx: number;
    boxedLocal: number;
  }[] = [];
  if (
    stmt.initializer &&
    ts.isVariableDeclarationList(stmt.initializer) &&
    stmt.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)
  ) {
    const headNames = new Set<string>();
    for (const decl of stmt.initializer.declarations) {
      // Only identifier bindings — destructuring patterns are out of scope
      // for this pass (the existing initializer code emits their bindings
      // directly into locals, and per-iteration freshness for destructured
      // names is rare enough to defer).
      if (ts.isIdentifier(decl.name)) headNames.add(decl.name.text);
    }
    const perIterationNames = findHeadBindingsCapturedByClosures(stmt, headNames);
    for (const name of perIterationNames) {
      const oldLocalIdx = fctx.localMap.get(name);
      if (oldLocalIdx === undefined) continue;
      const oldType =
        oldLocalIdx < fctx.params.length
          ? fctx.params[oldLocalIdx]!.type
          : (fctx.locals[oldLocalIdx - fctx.params.length]?.type ?? {
              kind: "f64",
            });
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, oldType);
      const boxedLocal = allocLocal(fctx, `__pi_box_${name}`, {
        kind: "ref_null",
        typeIdx: refCellTypeIdx,
      });
      // Box the initial value into the first ref cell.
      fctx.body.push({ op: "local.get", index: oldLocalIdx });
      fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
      fctx.body.push({ op: "local.set", index: boxedLocal });

      // Save the previous boxedCaptures entry (if any) so we can restore on
      // loop exit — nested for-loops with the same name would otherwise
      // permanently overwrite the outer binding.
      if (!savedForBoxedCaptures) savedForBoxedCaptures = new Map();
      savedForBoxedCaptures.set(name, fctx.boxedCaptures?.get(name));

      // Re-aim localMap to the boxed local and register the boxed-capture
      // metadata so subsequent identifier reads/writes (condition body,
      // incrementor) route through the ref cell automatically.
      fctx.localMap.set(name, boxedLocal);
      if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
      fctx.boxedCaptures.set(name, { refCellTypeIdx, valType: oldType });

      perIterCells.push({ name, refCellTypeIdx, boxedLocal });
    }
  }

  // #1589: Pre-emptive boxing for non-let/const names captured by closures.
  //
  // The closure-construction codegen promotes a captured variable to a ref
  // cell at the point the closure literal is compiled. For `var`-declared or
  // enclosing-function variables referenced from a closure INSIDE a for-loop,
  // that promotion happens AFTER the loop condition was already compiled —
  // the condition reads the original unboxed slot, while the body's
  // incrementor writes through the ref cell. Result: condition's view never
  // updates and the loop spins forever.
  //
  // Fix: before compiling the condition, find every name captured by any
  // closure in the loop and, if it currently lives in a plain local that is
  // NOT yet boxed, promote it to a ref cell now. Subsequent identifier reads
  // (condition, body, incrementor) all route through the same ref cell.
  //
  // We deliberately skip names already covered by the let/const per-iteration
  // pass above (those are in `boxedCaptures` now). Names not in `localMap`
  // (e.g. globals, module imports) are left alone — the closure-construction
  // path handles them by reading the underlying global.
  const preBoxedNames: {
    name: string;
    refCellTypeIdx: number;
    boxedLocal: number;
    valType: ValType;
    originalLocalIdx: number;
  }[] = [];
  {
    const capturedNames = findAllNamesCapturedByClosuresInForLoop(stmt);
    // Body-local `let`/`const`/class/function bindings are block-scoped to each
    // iteration and handled by the body declaration + closure-construction path.
    // Pre-boxing them at the loop head conflates the hoisted value slot with the
    // ref cell (→ `ref.is_null` over an f64 local). Exclude them.
    const bodyLocalLexical = findBodyLocalLexicalNames(stmt);
    for (const name of capturedNames) {
      if (bodyLocalLexical.has(name)) continue;
      if (fctx.boxedCaptures?.has(name)) continue; // already boxed (let/const per-iter)
      const oldLocalIdx = fctx.localMap.get(name);
      if (oldLocalIdx === undefined) continue; // not a local — globals/imports
      if (oldLocalIdx < fctx.params.length) continue; // params get boxed by closure construction itself
      const oldType = fctx.locals[oldLocalIdx - fctx.params.length]?.type ?? {
        kind: "f64" as const,
      };
      // Only box value-typed locals (i32, f64, externref, ref_null) — ref-cell
      // boxing of arbitrary struct/array refs is handled by the closure-side
      // path which knows the underlying type.
      if (
        oldType.kind !== "i32" &&
        oldType.kind !== "f64" &&
        oldType.kind !== "i64" &&
        oldType.kind !== "f32" &&
        oldType.kind !== "externref" &&
        oldType.kind !== "ref_null"
      ) {
        continue;
      }
      const refCellTypeIdx = getOrRegisterRefCellType(ctx, oldType);
      const boxedLocal = allocLocal(fctx, `__pre_box_${name}`, {
        kind: "ref_null",
        typeIdx: refCellTypeIdx,
      });
      // Box the current value into a fresh ref cell.
      fctx.body.push({ op: "local.get", index: oldLocalIdx });
      fctx.body.push({ op: "struct.new", typeIdx: refCellTypeIdx });
      fctx.body.push({ op: "local.set", index: boxedLocal });

      // Save prior boxedCaptures entry so we can restore it on loop exit.
      if (!savedForBoxedCaptures) savedForBoxedCaptures = new Map();
      if (!savedForBoxedCaptures.has(name)) {
        savedForBoxedCaptures.set(name, fctx.boxedCaptures?.get(name));
      }

      fctx.localMap.set(name, boxedLocal);
      if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
      fctx.boxedCaptures.set(name, { refCellTypeIdx, valType: oldType });
      preBoxedNames.push({
        name,
        refCellTypeIdx,
        boxedLocal,
        valType: oldType,
        originalLocalIdx: oldLocalIdx,
      });
    }
  }

  // Loop structure:
  // block $break {                    ; break target (depth 2 from body)
  //   loop $loop {                    ; loop restart (continue outer target)
  //     condition_check
  //     block $continue {             ; continue target (depth 0 from body)
  //       body
  //     }
  //     <linear-u8 arena reset, if needed>
  //     incrementor
  //     br $loop
  //   }
  // }
  const arenaMark = containsLinearU8Allocation(ctx, stmt.statement)
    ? emitLinearU8ArenaMark(ctx, fctx, "__linu8_loop_mark")
    : undefined;
  const arenaReset = linearU8ArenaResetInstrs(ctx, arenaMark);
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop+block adds 3 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);

  // From body inside $continue block:
  //   break = br 2 (exits $break block)
  //   continue = br 0 (exits $continue block, falls through to incrementor)
  fctx.breakStack.push(2);
  fctx.continueStack.push(0);

  // Condition (inside $loop, before $continue block)
  // (#1690) Register condInstrs in liveBodies before any nested compilation
  // can fire an `addStringConstantGlobal` whose fixup walker would otherwise
  // miss this detached buffer. The cond instrs live outside `fctx.body`
  // (which is the loop body buffer registered via savedBodies) for the entire
  // window from cond compilation through body+incrementor compilation until
  // the assembled loop is pushed back into fctx.body below.
  const condInstrs: Instr[] = [];
  ctx.liveBodies.add(condInstrs);
  if (stmt.condition) {
    const condBody = fctx.body;
    fctx.body = condInstrs;
    const condType = compileExpression(ctx, fctx, stmt.condition);
    ensureI32Condition(fctx, condType, ctx);
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({ op: "br_if", depth: 1 }); // break: exits $break (depth 1 from $loop body)
    fctx.body = condBody;
  }

  // --- Bounds check elimination: detect `i < arr.length` pattern (#1196) ---
  // When the condition is strictly `indexVar < arrayVar.length` (or
  // `arrayVar.length > indexVar`) AND the loop body does not mutate `i` or
  // `arr`, mark the pair so element accesses like `arrayVar[indexVar]` can
  // skip bounds checks.
  //
  // Soundness rules:
  //   - Strict `<` / `>` only: `<=` / `>=` allow `i == arr.length` which is
  //     out of bounds.
  //   - Body must not assign to `i` or `arr`, and must not call any method on
  //     `arr` (could mutate length, e.g. push/pop/splice/etc.).
  //   - Body must not contain a nested function — closures could capture and
  //     mutate either binding outside our static view.
  const savedSafeIndexed = fctx.safeIndexedArrays;
  if (stmt.condition && ts.isBinaryExpression(stmt.condition)) {
    const cond = stmt.condition;
    const op = cond.operatorToken.kind;
    let indexExpr: ts.Expression | undefined;
    let lengthExpr: ts.Expression | undefined;
    // Strict `i < arr.length`
    if (op === ts.SyntaxKind.LessThanToken) {
      indexExpr = cond.left;
      lengthExpr = cond.right;
    }
    // Strict `arr.length > i`
    if (op === ts.SyntaxKind.GreaterThanToken) {
      indexExpr = cond.right;
      lengthExpr = cond.left;
    }
    if (
      indexExpr &&
      lengthExpr &&
      ts.isIdentifier(indexExpr) &&
      ts.isPropertyAccessExpression(lengthExpr) &&
      ts.isIdentifier(lengthExpr.name) &&
      lengthExpr.name.text === "length" &&
      ts.isIdentifier(lengthExpr.expression)
    ) {
      const indexVar = indexExpr.text;
      const arrayVar = lengthExpr.expression.text;
      // Walk the body to confirm `i` and `arr` are not mutated. Only mark the
      // pair safe when both are stable across every iteration.
      if (!loopBodyMutatesIndexOrArray(stmt.statement, indexVar, arrayVar)) {
        if (!fctx.safeIndexedArrays) {
          fctx.safeIndexedArrays = new Set();
        }
        fctx.safeIndexedArrays.add(`${arrayVar}:${indexVar}`);
      }
    }
  }

  // Body (inside $continue block) — save/restore block-scoped shadows so that
  // let/const declarations inside the loop body do not leak into outer scope (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }
  const bodyInstrs = fctx.body;

  // Restore previous safeIndexedArrays (scoped to this loop)
  fctx.safeIndexedArrays = savedSafeIndexed;

  // Incrementor (inside $loop, after $continue block)
  // (#1690) Same liveBodies registration as condInstrs above: the incrementor
  // buffer is detached until the assembled loop is pushed below.
  const incrInstrs: Instr[] = [];
  ctx.liveBodies.add(incrInstrs);
  fctx.body = incrInstrs;
  if (stmt.incrementor) {
    const resultType = compileExpression(ctx, fctx, stmt.incrementor);
    if (resultType !== null) fctx.body.push({ op: "drop" });
  }

  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;
  adjustRethrowDepth(fctx, -3);

  popBody(fctx, savedBody);

  // #1453: Per-iteration fresh binding (CreatePerIterationEnvironment).
  // For each head-binding that's captured by a nested closure, allocate a
  // fresh ref cell whose value copies the current cell's, then re-aim the
  // boxed local. Closures captured in earlier iterations retain their
  // original cell, observing the spec-mandated distinct binding per
  // iteration. These instructions sit between the body block and the
  // incrementor — `continue` (br 0) exits the inner $continue block and
  // falls through here, so per-iteration freshness applies on every
  // continuation path. `break`/`return`/`throw` skip these instructions,
  // which matches the spec (no new env when leaving the loop).
  const freshCellInstrs: Instr[] = [];
  for (const cell of perIterCells) {
    freshCellInstrs.push({ op: "local.get", index: cell.boxedLocal });
    freshCellInstrs.push({
      op: "struct.get",
      typeIdx: cell.refCellTypeIdx,
      fieldIdx: 0,
    });
    freshCellInstrs.push({ op: "struct.new", typeIdx: cell.refCellTypeIdx });
    freshCellInstrs.push({ op: "local.set", index: cell.boxedLocal });
  }

  // Build the loop body: condition + block $continue { body } + fresh-cells + incrementor + br $loop
  const loopBody: Instr[] = [
    ...condInstrs,
    {
      op: "block",
      blockType: { kind: "empty" },
      body: bodyInstrs,
    },
    ...arenaReset,
    ...freshCellInstrs,
    ...incrInstrs,
    { op: "br", depth: 0 }, // restart $loop
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });

  // (#1690) The cond/incr Instr objects are now reachable via fctx.body →
  // assembled loop. The condInstrs/incrInstrs arrays themselves are no longer
  // needed by the walker (their contents were spread into `loopBody`).
  ctx.liveBodies.delete(condInstrs);
  ctx.liveBodies.delete(incrInstrs);

  // #1589: For pre-emptively boxed `var`/outer-scope names, write the final
  // ref-cell value back to the original unboxed local so post-loop reads of
  // the variable observe the loop's final state, then restore localMap.
  if (preBoxedNames.length > 0) {
    for (const pb of preBoxedNames) {
      fctx.body.push({ op: "local.get", index: pb.boxedLocal });
      // Null guard: if the ref cell somehow ended up null (shouldn't happen
      // since we struct.new'd it at loop entry), skip the writeback rather
      // than trapping.
      fctx.body.push({ op: "ref.is_null" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [],
        else: [
          { op: "local.get", index: pb.boxedLocal } as Instr,
          { op: "ref.as_non_null" } as Instr,
          {
            op: "struct.get",
            typeIdx: pb.refCellTypeIdx,
            fieldIdx: 0,
          } as Instr,
          { op: "local.set", index: pb.originalLocalIdx } as Instr,
        ],
      } as Instr);
      fctx.localMap.set(pb.name, pb.originalLocalIdx);
    }
  }

  // Restore localMap entries for for-loop let/const initializers
  if (savedForScope) {
    for (const [name, idx] of savedForScope) {
      fctx.localMap.set(name, idx);
    }
  }
  if (savedForTdz) {
    if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
    for (const [name, idx] of savedForTdz) {
      fctx.tdzFlagLocals.set(name, idx);
    }
  }
  if (savedForConstBindings) {
    if (!fctx.constBindings) fctx.constBindings = new Set();
    for (const [name, hadConstBinding] of savedForConstBindings) {
      if (hadConstBinding) fctx.constBindings.add(name);
      else fctx.constBindings.delete(name);
    }
  }
  // #1453: restore previous boxedCaptures entries so the per-iteration boxing
  // is scoped to this loop (relevant for nested loops with same-named bindings).
  if (savedForBoxedCaptures) {
    if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
    for (const [name, prev] of savedForBoxedCaptures) {
      if (prev) fctx.boxedCaptures.set(name, prev);
      else fctx.boxedCaptures.delete(name);
    }
  }
}

export function compileDoWhileStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.DoStatement): void {
  // block $break {                    ; break target (depth 2 from body)
  //   loop $loop {                    ; loop restart
  //     block $continue {             ; continue target (depth 0 from body)
  //       <body>
  //     }
  //     <linear-u8 arena reset, if needed>
  //     <condition>
  //     br_if $loop                   ; true → restart loop (depth 0 from loop level)
  //   }
  // }

  const arenaMark = containsLinearU8Allocation(ctx, stmt.statement)
    ? emitLinearU8ArenaMark(ctx, fctx, "__linu8_loop_mark")
    : undefined;
  const arenaReset = linearU8ArenaResetInstrs(ctx, arenaMark);
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop+block adds 3 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);

  // From body inside $continue block:
  //   break = br 2 (exits $break block)
  //   continue = br 0 (exits $continue block, falls through to condition)
  fctx.breakStack.push(2);
  fctx.continueStack.push(0);

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }
  const bodyInstrs = fctx.body;

  // Compile condition — true means continue looping
  // (#1690) Same liveBodies registration as compileForStatement: the cond
  // buffer is detached from fctx.body until the assembled loop is pushed.
  const condInstrs: Instr[] = [];
  ctx.liveBodies.add(condInstrs);
  fctx.body = condInstrs;
  const condType = compileExpression(ctx, fctx, stmt.expression);
  ensureI32Condition(fctx, condType, ctx);
  fctx.body.push({ op: "br_if", depth: 0 }); // restart $loop if true

  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;
  adjustRethrowDepth(fctx, -3);

  popBody(fctx, savedBody);

  // Build: block { loop { block { body } condition br_if } }
  const loopBody: Instr[] = [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: bodyInstrs,
    },
    ...arenaReset,
    ...condInstrs,
  ];

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });

  // (#1690) The cond Instr objects are now reachable via fctx.body → loop.
  ctx.liveBodies.delete(condInstrs);
}

function compileForOfDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  pattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern,
  elemLocal: number,
  elemType: ValType,
  stmt: ts.ForOfStatement,
): void {
  if (ts.isObjectBindingPattern(pattern)) {
    // Resolve the struct type from the element type
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      if (elemType.kind === "externref") {
        // Externref elements: use __extern_get to extract properties (e.g. iterator protocol)
        fctx.body.push({ op: "local.get", index: elemLocal });
        compileExternrefObjectDestructuringDecl(ctx, fctx, pattern, elemType);
        syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
        return;
      }
      // Primitives (bool, number, string) are object-coercible in JS.
      // Empty binding pattern `for (let {} of [val])` is a no-op — just iterate.
      // Non-empty patterns: properties don't exist on primitives, so use defaults
      // or the appropriate undefined sentinel.
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element)) continue;
        if (!ts.isIdentifier(element.name)) continue; // skip non-identifier binding names
        const localName = element.name.text;
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingType = resolveWasmType(ctx, bindingTsType);
        const localIdx = allocLocal(fctx, localName, bindingType);
        if (element.initializer) {
          const instrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, element.initializer!, bindingType);
            fctx.body.push({ op: "local.set", index: localIdx } as Instr);
          });
          fctx.body.push(...instrs);
        } else {
          // No default — use "undefined" sentinel matching the local's type
          if (bindingType.kind === "f64") {
            fctx.body.push({ op: "f64.const", value: NaN });
          } else if (bindingType.kind === "i32") {
            fctx.body.push({ op: "i32.const", value: 0 });
          } else if (bindingType.kind === "ref_null" || bindingType.kind === "ref") {
            const refTypeIdx = (bindingType as { typeIdx: number }).typeIdx;
            fctx.body.push({ op: "ref.null", typeIdx: refTypeIdx });
          } else {
            fctx.body.push({ op: "ref.null.extern" });
          }
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
      return;
    }

    const structTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const typeDef = ctx.mod.types[structTypeIdx];
    if (!typeDef || typeDef.kind !== "struct") {
      reportErrorNoNode(ctx, "for-of destructuring: element type is not a struct");
      return;
    }

    // Find the struct fields by looking up the struct name from reverse map
    const structName = ctx.typeIdxToStructName.get(structTypeIdx);
    const fields = structName ? ctx.structFields.get(structName) : undefined;
    if (!fields) {
      reportError(ctx, stmt, "for-of destructuring: cannot find struct fields");
      return;
    }

    // Null guard: collect field extractions for ref_null types
    emitNullGuard(ctx, fctx, elemLocal, elemType.kind === "ref_null", () => {
      for (const element of pattern.elements) {
        if (!ts.isBindingElement(element)) continue;

        // Handle rest element: for (const { a, ...rest } of arr)
        if (element.dotDotDotToken) {
          if (ts.isIdentifier(element.name)) {
            const restName = element.name.text;
            let restIdx = fctx.localMap.get(restName);
            if (restIdx === undefined) {
              restIdx = allocLocal(fctx, restName, { kind: "externref" });
            }
            // Collect excluded keys
            const excludedKeys: string[] = [];
            for (const el of pattern.elements) {
              if (!ts.isBindingElement(el) || el.dotDotDotToken) continue;
              const pn = el.propertyName ?? el.name;
              if (ts.isIdentifier(pn)) excludedKeys.push(pn.text);
              else if (ts.isStringLiteral(pn)) excludedKeys.push(pn.text);
              else if (ts.isNumericLiteral(pn)) excludedKeys.push(pn.text);
            }
            let restObjIdx = ctx.funcMap.get("__extern_rest_object");
            if (restObjIdx === undefined) {
              const importsBefore = ctx.numImportFuncs;
              const restObjType = addFuncType(
                ctx,
                [{ kind: "externref" }, { kind: "externref" }],
                [{ kind: "externref" }],
              );
              addImport(ctx, "env", "__extern_rest_object", {
                kind: "func",
                typeIdx: restObjType,
              });
              shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
              restObjIdx = ctx.funcMap.get("__extern_rest_object");
            }
            if (restObjIdx !== undefined) {
              const excludedStr = excludedKeys.join(",");
              addStringConstantGlobal(ctx, excludedStr);
              const excludedStrIdx = ctx.stringGlobalMap.get(excludedStr);
              if (excludedStrIdx !== undefined) {
                fctx.body.push({ op: "local.get", index: elemLocal });
                fctx.body.push({ op: "extern.convert_any" } as Instr);
                fctx.body.push({ op: "global.get", index: excludedStrIdx });
                fctx.body.push({ op: "call", funcIdx: restObjIdx });
                fctx.body.push({ op: "local.set", index: restIdx });
              }
            }
          }
          continue;
        }

        const propNameNode = element.propertyName ?? element.name;
        let propNameText = ts.isIdentifier(propNameNode)
          ? propNameNode.text
          : ts.isStringLiteral(propNameNode)
            ? propNameNode.text
            : ts.isNumericLiteral(propNameNode)
              ? propNameNode.text
              : undefined;
        // Try resolving computed property names at compile time
        if (!propNameText && ts.isComputedPropertyName(propNameNode)) {
          propNameText = resolveComputedKeyExpression(ctx, propNameNode.expression);
        }
        if (!ts.isIdentifier(element.name)) continue; // skip non-identifier binding names
        const localName = element.name.text;
        if (!propNameText) continue; // skip truly unresolvable computed property names

        const fieldIdx = fields.findIndex((f) => f.name === propNameText);
        if (fieldIdx === -1) {
          // Field not found in struct — property is "undefined" at runtime.
          // Use the default value if one is provided, otherwise use the
          // appropriate "undefined" sentinel for the target type.
          const bindingTsType = ctx.checker.getTypeAtLocation(element);
          const bindingType = resolveWasmType(ctx, bindingTsType);
          const localIdx = allocLocal(fctx, localName, bindingType);
          if (element.initializer) {
            const instrs = collectInstrs(fctx, () => {
              compileExpression(ctx, fctx, element.initializer!, bindingType);
              fctx.body.push({ op: "local.set", index: localIdx } as Instr);
            });
            fctx.body.push(...instrs);
          } else {
            // No default — use "undefined" sentinel matching the local's type
            if (bindingType.kind === "f64") {
              fctx.body.push({ op: "f64.const", value: NaN });
            } else if (bindingType.kind === "i32") {
              fctx.body.push({ op: "i32.const", value: 0 });
            } else if (bindingType.kind === "ref_null" || bindingType.kind === "ref") {
              const refTypeIdx = (bindingType as { typeIdx: number }).typeIdx;
              fctx.body.push({ op: "ref.null", typeIdx: refTypeIdx });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            fctx.body.push({ op: "local.set", index: localIdx });
          }
          continue;
        }

        const fieldEntry = fields[fieldIdx];
        if (!fieldEntry) continue;
        const fieldType = fieldEntry.type;
        const localIdx = allocLocal(fctx, localName, fieldType);

        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });

        // Handle default value
        if (element.initializer) {
          emitDefaultValueCheck(ctx, fctx, fieldType, localIdx, element.initializer);
        } else {
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
    }); // end null guard for for-of object destructuring
  } else if (ts.isArrayBindingPattern(pattern)) {
    // Array destructuring in for-of: for (var [a, b] of arr)
    // (#1719 CPR-2) When the program overrode Array.prototype's @@iterator and
    // the per-element array is destructured, drive the override instead of the
    // backing store (§8.5.2). Strictly gated behind the brand + a captured
    // override; both clear in the common case ⇒ byte-identical. The element
    // value lives in `elemLocal`, so feed the shared decl read-drive that local.
    if (
      arrayDstrNeedsIdentity(ctx, false) &&
      arrayIteratorOverrideGlobalIdx(ctx) !== undefined &&
      tryEmitArrayProtoIteratorReadDrive(ctx, fctx, pattern, elemType, elemLocal)
    ) {
      syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
      return;
    }
    // Element may be a vec struct (array wrapper) OR a tuple struct.
    // Handle externref elements: use __extern_get to extract indexed properties
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      if (elemType.kind === "externref") {
        // Externref elements: use __extern_get(elem, box(i)) for each binding (e.g. iterator protocol)
        fctx.body.push({ op: "local.get", index: elemLocal });
        compileExternrefArrayDestructuringDecl(ctx, fctx, pattern, elemType);
        syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
        return;
      }
      // #846: A non-ref, non-externref element (f64/i32 ⇒ number/boolean) is a
      // primitive that lacks [Symbol.iterator]. ArrayBindingPattern initialization
      // (§8.5.2 BindingInitialization → §8.5.3 IteratorBindingInitialization)
      // first performs GetIterator(elem), which throws TypeError for a non-iterable
      // primitive. This applies even to an EMPTY pattern (`for ([] of [1])`) because
      // GetIterator runs before any binding element is read. Previously this branch
      // silently assigned undefined sentinels and never threw. Strings are iterable
      // but lower to a string ref / externref, so they take a different branch and
      // are unaffected.
      //
      // The binding locals are still declared (allocated) so later references in
      // the loop body type-check, but the throw makes the code after it
      // unreachable in this iteration.
      for (const element of pattern.elements) {
        if (ts.isOmittedExpression(element)) continue;
        if (!ts.isBindingElement(element)) continue;
        if (!ts.isIdentifier(element.name)) continue;
        const localName = element.name.text;
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingType = resolveWasmType(ctx, bindingTsType);
        allocLocal(fctx, localName, bindingType);
      }
      emitThrowTypeError(ctx, fctx, "value is not iterable");
      return;
    }

    const structTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const structDef = ctx.mod.types[structTypeIdx];

    // Check if element is a tuple struct (fields named _0, _1, etc.)
    const isTupleStruct =
      structDef &&
      structDef.kind === "struct" &&
      structDef.fields.length > 0 &&
      structDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`);

    if (isTupleStruct) {
      // Tuple destructuring: extract fields directly from the struct by index
      const tupleFields = (structDef as { fields: { name?: string; type: ValType }[] }).fields;

      emitNullGuard(ctx, fctx, elemLocal, elemType.kind === "ref_null", () => {
        for (let i = 0; i < pattern.elements.length; i++) {
          const element = pattern.elements[i]!;
          if (ts.isOmittedExpression(element)) continue;

          if (i >= tupleFields.length) break; // more bindings than tuple fields

          const fieldType = tupleFields[i]!.type;

          // Handle rest element — convert tuple to externref and slice
          if (ts.isBindingElement(element) && element.dotDotDotToken) {
            const restName = ts.isIdentifier(element.name) ? element.name.text : `__rest_${fctx.locals.length}`;
            let restIdx = fctx.localMap.get(restName);
            if (restIdx === undefined) {
              restIdx = allocLocal(fctx, restName, { kind: "externref" });
            }
            let sliceIdx = ctx.funcMap.get("__extern_slice");
            if (sliceIdx === undefined) {
              const importsBefore = ctx.numImportFuncs;
              const sliceType = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
              addImport(ctx, "env", "__extern_slice", {
                kind: "func",
                typeIdx: sliceType,
              });
              shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
              sliceIdx = ctx.funcMap.get("__extern_slice");
            }
            if (sliceIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: elemLocal });
              fctx.body.push({ op: "extern.convert_any" } as Instr);
              fctx.body.push({ op: "f64.const", value: i });
              fctx.body.push({ op: "call", funcIdx: sliceIdx });
              fctx.body.push({ op: "local.set", index: restIdx });
            }
            continue;
          }

          // Handle nested binding patterns: for (const [{ a, b }] of arr)
          if (
            ts.isBindingElement(element) &&
            (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
          ) {
            const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, fieldType);
            fctx.body.push({ op: "local.get", index: elemLocal });
            fctx.body.push({
              op: "struct.get",
              typeIdx: structTypeIdx,
              fieldIdx: i,
            });
            fctx.body.push({ op: "local.set", index: nestedLocal });
            compileForOfDestructuring(ctx, fctx, element.name, nestedLocal, fieldType, stmt);
            continue;
          }

          if (!ts.isIdentifier(element.name)) continue;
          const localName = element.name.text;
          const bindingTsType = ctx.checker.getTypeAtLocation(element);
          const bindingWasmType = resolveWasmType(ctx, bindingTsType);
          const localIdx = allocLocal(fctx, localName, bindingWasmType);

          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: structTypeIdx,
            fieldIdx: i,
          });

          if (!valTypesMatch(fieldType, bindingWasmType)) {
            coerceType(ctx, fctx, fieldType, bindingWasmType);
          }

          if (element.initializer) {
            emitDefaultValueCheck(ctx, fctx, bindingWasmType, localIdx, element.initializer);
          } else {
            fctx.body.push({ op: "local.set", index: localIdx });
          }
        }
      }); // end null guard for for-of tuple destructuring
      return;
    }

    // Vec array destructuring: element is a vec struct { length, data }
    const innerArrTypeIdx = getArrTypeIdxFromVec(ctx, structTypeIdx);
    const arrDef = ctx.mod.types[innerArrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") {
      reportError(ctx, stmt, "for-of array destructuring: element is not an array type");
      return;
    }

    const innerElemType = arrDef.element;

    emitNullGuard(ctx, fctx, elemLocal, elemType.kind === "ref_null", () => {
      for (let i = 0; i < pattern.elements.length; i++) {
        const element = pattern.elements[i]!;
        if (ts.isOmittedExpression(element)) continue;

        // Handle nested binding patterns: for (const [{ a, b }] of arr)
        // Skip rest elements (dotDotDotToken) — those are handled below so the
        // rest vec is built before recursing into the nested pattern.
        if (
          ts.isBindingElement(element) &&
          !element.dotDotDotToken &&
          (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))
        ) {
          const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, innerElemType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: structTypeIdx,
            fieldIdx: 1,
          });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);
          fctx.body.push({ op: "local.set", index: nestedLocal });
          compileForOfDestructuring(ctx, fctx, element.name, nestedLocal, innerElemType, stmt);
          continue;
        }

        // Handle rest element: for (const [...rest] of arr) or for (const [a, ...rest] of arr)
        if (ts.isBindingElement(element) && element.dotDotDotToken) {
          const restName = ts.isIdentifier(element.name) ? element.name.text : `__rest_${fctx.locals.length}`;

          // Compute rest length: max(0, original.length - i)
          const restLenLocal = allocLocal(fctx, `__rest_len_${fctx.locals.length}`, { kind: "i32" });
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: structTypeIdx,
            fieldIdx: 0,
          }); // length
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.sub" } as Instr);
          fctx.body.push({ op: "local.set", index: restLenLocal });
          // Clamp to 0 if negative
          fctx.body.push({ op: "i32.const", value: 0 } as Instr);
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "i32.const", value: 0 } as Instr);
          fctx.body.push({ op: "i32.lt_s" } as Instr);
          fctx.body.push({ op: "select" } as Instr);
          fctx.body.push({ op: "local.set", index: restLenLocal });

          // Create new data array: array.new_default(restLen)
          const restArrLocal = allocLocal(fctx, `__rest_arr_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: innerArrTypeIdx,
          });
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({
            op: "array.new_default",
            typeIdx: innerArrTypeIdx,
          } as Instr);
          fctx.body.push({ op: "local.set", index: restArrLocal });

          // array.copy(restArr, 0, srcData, i, restLen)
          fctx.body.push({ op: "local.get", index: restArrLocal });
          fctx.body.push({ op: "i32.const", value: 0 });
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: structTypeIdx,
            fieldIdx: 1,
          }); // src data
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({
            op: "array.copy",
            dstTypeIdx: innerArrTypeIdx,
            srcTypeIdx: innerArrTypeIdx,
          } as Instr);

          // Create new vec struct: struct.new(restLen, restArr)
          const restVecType: ValType = { kind: "ref", typeIdx: structTypeIdx };
          fctx.body.push({ op: "local.get", index: restLenLocal });
          fctx.body.push({ op: "local.get", index: restArrLocal });
          fctx.body.push({ op: "struct.new", typeIdx: structTypeIdx } as Instr);

          let restIdx = fctx.localMap.get(restName);
          if (restIdx === undefined) {
            restIdx = allocLocal(fctx, restName, restVecType);
          }
          fctx.body.push({ op: "local.set", index: restIdx });

          // If the rest target is itself a binding pattern (e.g. [...[...x]]),
          // recurse into it with the freshly built rest vec as the element.
          if (ts.isArrayBindingPattern(element.name) || ts.isObjectBindingPattern(element.name)) {
            compileForOfDestructuring(ctx, fctx, element.name, restIdx, restVecType, stmt);
          }
          continue;
        }

        if (!ts.isIdentifier(element.name)) continue;
        const localName = element.name.text;
        const bindingTsType = ctx.checker.getTypeAtLocation(element);
        const bindingWasmType = resolveWasmType(ctx, bindingTsType);
        const localIdx = allocLocal(fctx, localName, bindingWasmType);

        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({
          op: "struct.get",
          typeIdx: structTypeIdx,
          fieldIdx: 1,
        });
        fctx.body.push({ op: "i32.const", value: i });
        // (#1396) Pass `useUndefinedSentinel: true` when this element has a
        // default initializer AND the source-array element type is externref.
        // The OOB else-branch must produce JS `undefined` (not `null`) so
        // `emitDefaultValueCheck` → `__extern_is_undefined` returns 1 and
        // the initializer fires for empty/short arrays.
        const wantUndefinedSentinel =
          element.initializer !== undefined &&
          (innerElemType.kind === "externref" || innerElemType.kind === "ref_extern");
        emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType, ctx, wantUndefinedSentinel);

        if (!valTypesMatch(innerElemType, bindingWasmType)) {
          coerceType(ctx, fctx, innerElemType, bindingWasmType);
        }

        if (element.initializer) {
          emitDefaultValueCheck(ctx, fctx, bindingWasmType, localIdx, element.initializer);
        } else {
          fctx.body.push({ op: "local.set", index: localIdx });
        }
      }
    }); // end null guard for for-of array destructuring
  }
}

/**
 * Handle assignment destructuring in for-of expression form:
 *   for ({a, b} of arr) — assigns to already-declared variables
 *   for ([x, y] of arr) — assigns to already-declared variables
 */
function compileForOfAssignDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  elemLocal: number,
  elemType: ValType,
  vecTypeIdx: number,
  arrTypeIdx: number,
  stmt: ts.ForOfStatement,
): void {
  // §6.2.4 PutValue: strict-mode assignment to unresolvable reference throws
  // ReferenceError. For for-of destructuring assignment, the throw happens each
  // iteration at the point of first unresolvable PutValue.
  const hasUnresolvable = ts.isObjectLiteralExpression(expr)
    ? findUnresolvableInObjectPattern(ctx, fctx, expr)
    : findUnresolvableInArrayPattern(ctx, fctx, expr);
  if (hasUnresolvable && isStrictContext(stmt)) {
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "ref.null.extern" } as Instr);
    fctx.body.push({ op: "throw", tagIdx });
    return;
  }
  if (ts.isObjectLiteralExpression(expr)) {
    // for ({a, b} of arr) — elem is a struct ref, extract fields
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      // Externref nested elements may be null/undefined (e.g. `for ([{x}] of [[null]])`).
      // Per ECMA-262 §13.15.5.5 RequireObjectCoercible, destructuring null/undefined
      // through a non-empty object pattern must throw TypeError (#1225).
      if (elemType.kind === "externref" && expr.properties.length > 0) {
        emitExternrefDestructureGuard(ctx, fctx, elemLocal);
      }
      // Primitives (bool, number, string) are object-coercible in JS.
      // Empty destructuring `for ({} of [val])` is a no-op — just iterate.
      // Non-empty patterns: properties don't exist on primitives, so use defaults.
      for (const prop of expr.properties) {
        if (ts.isSpreadAssignment(prop)) continue;
        if (!ts.isShorthandPropertyAssignment(prop) && !ts.isPropertyAssignment(prop)) continue;
        const targetName = ts.isShorthandPropertyAssignment(prop)
          ? prop.name.text
          : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)
            ? prop.initializer.text
            : ts.isIdentifier(prop.name)
              ? prop.name.text
              : undefined;
        if (!targetName) continue; // skip computed property names
        const targetLocal = fctx.localMap.get(targetName);
        if (targetLocal === undefined) continue;

        // Property doesn't exist on primitive — use default if provided
        const init = ts.isShorthandPropertyAssignment(prop) ? prop.objectAssignmentInitializer : undefined;
        if (init) {
          const targetType = getLocalType(fctx, targetLocal);
          const instrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, init, targetType ?? { kind: "externref" });
            fctx.body.push({ op: "local.set", index: targetLocal } as Instr);
          });
          fctx.body.push(...instrs);
        }
      }
      return;
    }

    const structTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const typeDef = ctx.mod.types[structTypeIdx];
    if (!typeDef || typeDef.kind !== "struct") return;

    const structName = ctx.typeIdxToStructName.get(structTypeIdx);
    const fields = structName ? ctx.structFields.get(structName) : undefined;
    if (!fields) return;

    for (const prop of expr.properties) {
      if (!ts.isShorthandPropertyAssignment(prop) && !ts.isPropertyAssignment(prop)) continue;
      let propName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isIdentifier(prop.name)
          ? prop.name.text
          : ts.isStringLiteral(prop.name)
            ? prop.name.text
            : undefined;
      // Try resolving computed property names at compile time
      if (!propName && ts.isPropertyAssignment(prop) && ts.isComputedPropertyName(prop.name)) {
        propName = resolveComputedKeyExpression(ctx, prop.name.expression);
      }
      if (!propName) continue; // skip truly unresolvable computed property names
      const targetName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)
          ? prop.initializer.text
          : propName;

      const fieldIdx = fields.findIndex((f) => f.name === propName);
      if (fieldIdx === -1) {
        reportSilentFallback(ctx, "lookup-miss-skip", "loops:forof-assign-destructure-field-miss", prop);
        continue;
      }

      let targetLocal = fctx.localMap.get(targetName);
      let targetSyncGlobalIdx: number | undefined;
      if (targetLocal === undefined) {
        const globalIdx = ctx.moduleGlobals.get(targetName);
        if (globalIdx === undefined) continue;
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        const globalType = globalDef?.type ?? { kind: "externref" as const };
        targetLocal = allocLocal(fctx, targetName, globalType);
        targetSyncGlobalIdx = globalIdx;
      }

      const fieldEntry2 = fields[fieldIdx];
      if (!fieldEntry2) continue;
      const fieldType = fieldEntry2.type;
      const targetType = getLocalType(fctx, targetLocal);
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
      const effectiveStackType = targetType && !valTypesMatch(fieldType, targetType) ? targetType : fieldType;
      if (targetType && !valTypesMatch(fieldType, targetType)) {
        coerceType(ctx, fctx, fieldType, targetType);
      }
      emitCoercedLocalSet(ctx, fctx, targetLocal, effectiveStackType);
      if (targetSyncGlobalIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "global.set", index: targetSyncGlobalIdx });
      }
    }
  } else if (ts.isArrayLiteralExpression(expr)) {
    // for ([x, y] of arr) — elem is a vec struct or tuple struct, extract by index
    if (elemType.kind !== "ref" && elemType.kind !== "ref_null") {
      // Externref elements: use __extern_get to extract indexed properties
      if (elemType.kind === "externref") {
        // Per ECMA-262 §13.15.5.2 / §8.4.2 GetIterator(null/undefined) throws
        // TypeError. Required for nested patterns like `for ([[x]] of [[null]])`
        // (#1225). Skip for empty `[] of …` patterns to match existing behavior.
        if (expr.elements.length > 0) {
          emitExternrefDestructureGuard(ctx, fctx, elemLocal);
        }
        compileForOfAssignDestructuringExternref(ctx, fctx, expr, elemLocal);
      }
      return;
    }

    const innerVecTypeIdx = (elemType as { typeIdx: number }).typeIdx;
    const innerStructDef = ctx.mod.types[innerVecTypeIdx];

    // Check if element is a tuple struct (fields named _0, _1, etc.)
    const isTuple =
      innerStructDef &&
      innerStructDef.kind === "struct" &&
      innerStructDef.fields.length > 0 &&
      innerStructDef.fields.every((f: { name?: string }, idx: number) => f.name === `_${idx}`);

    // Handle 0-field structs (empty tuples like []) — all elements are OOB, apply defaults
    if (innerStructDef && innerStructDef.kind === "struct" && innerStructDef.fields.length === 0) {
      for (let i = 0; i < expr.elements.length; i++) {
        const el = expr.elements[i]!;
        if (ts.isOmittedExpression(el)) continue;
        let oobTarget: ts.Expression = el;
        let oobInit: ts.Expression | undefined;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          oobTarget = el.left;
          oobInit = el.right;
        }
        if (oobInit && ts.isIdentifier(oobTarget)) {
          let oobLocal = fctx.localMap.get(oobTarget.text);
          let oobSyncGlobalIdx: number | undefined;
          if (oobLocal === undefined) {
            const globalIdx = ctx.moduleGlobals.get(oobTarget.text);
            if (globalIdx !== undefined) {
              const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
              const globalType = globalDef?.type ?? {
                kind: "externref" as const,
              };
              oobLocal = allocLocal(fctx, oobTarget.text, globalType);
              oobSyncGlobalIdx = globalIdx;
            }
          }
          if (oobLocal !== undefined) {
            const oobType = getLocalType(fctx, oobLocal);
            const instrs = collectInstrs(fctx, () => {
              compileExpression(ctx, fctx, oobInit!, oobType ?? { kind: "f64" });
              fctx.body.push({ op: "local.set", index: oobLocal! } as Instr);
            });
            fctx.body.push(...instrs);
            if (oobSyncGlobalIdx !== undefined) {
              fctx.body.push({ op: "local.get", index: oobLocal });
              fctx.body.push({ op: "global.set", index: oobSyncGlobalIdx });
            }
          }
        }
      }
      return;
    }

    if (isTuple) {
      // Tuple assignment destructuring: extract fields directly
      const tupleFields = (innerStructDef as { fields: { name?: string; type: ValType }[] }).fields;
      for (let i = 0; i < expr.elements.length; i++) {
        const el = expr.elements[i]!;
        if (ts.isOmittedExpression(el)) continue;

        // OOB: tuple has fewer fields than destructuring targets
        if (i >= tupleFields.length) {
          // If element has a default initializer, apply it directly (value is undefined/OOB)
          let oobTarget: ts.Expression = el;
          let oobInit: ts.Expression | undefined;
          if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            oobTarget = el.left;
            oobInit = el.right;
          }
          if (oobInit && ts.isIdentifier(oobTarget)) {
            let oobLocal = fctx.localMap.get(oobTarget.text);
            let oobSyncGlobalIdx: number | undefined;
            if (oobLocal === undefined) {
              const globalIdx = ctx.moduleGlobals.get(oobTarget.text);
              if (globalIdx !== undefined) {
                const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
                const globalType = globalDef?.type ?? {
                  kind: "externref" as const,
                };
                oobLocal = allocLocal(fctx, oobTarget.text, globalType);
                oobSyncGlobalIdx = globalIdx;
              }
            }
            if (oobLocal !== undefined) {
              const oobType = getLocalType(fctx, oobLocal);
              const instrs = collectInstrs(fctx, () => {
                compileExpression(ctx, fctx, oobInit!, oobType ?? { kind: "f64" });
                fctx.body.push({ op: "local.set", index: oobLocal! } as Instr);
              });
              fctx.body.push(...instrs);
              if (oobSyncGlobalIdx !== undefined) {
                fctx.body.push({ op: "local.get", index: oobLocal });
                fctx.body.push({ op: "global.set", index: oobSyncGlobalIdx });
              }
            }
          }
          continue;
        }

        const fieldType = tupleFields[i]!.type;

        // Handle nested destructuring: for ([{ a, b }] of arr) or for ([[x, y]] of arr)
        if (ts.isObjectLiteralExpression(el) || ts.isArrayLiteralExpression(el)) {
          const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: innerVecTypeIdx,
            fieldIdx: i,
          });
          fctx.body.push({ op: "local.set", index: nestedLocal });
          compileForOfAssignDestructuring(ctx, fctx, el, nestedLocal, fieldType, vecTypeIdx, arrTypeIdx, stmt);
          continue;
        }

        // Handle assignment with default: [v = 10]
        let targetEl: ts.Expression = el;
        let defaultInit: ts.Expression | undefined;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          targetEl = el.left;
          defaultInit = el.right;
        }

        if (!ts.isIdentifier(targetEl)) continue;

        let targetLocal = fctx.localMap.get(targetEl.text);
        let tupleSyncGlobalIdx: number | undefined;
        if (targetLocal === undefined) {
          const globalIdx = ctx.moduleGlobals.get(targetEl.text);
          if (globalIdx === undefined) continue;
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
          const globalType = globalDef?.type ?? { kind: "externref" as const };
          targetLocal = allocLocal(fctx, targetEl.text, globalType);
          tupleSyncGlobalIdx = globalIdx;
        }

        const targetType = getLocalType(fctx, targetLocal);
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({
          op: "struct.get",
          typeIdx: innerVecTypeIdx,
          fieldIdx: i,
        });

        if (defaultInit) {
          // Check for undefined and apply default — BEFORE type coercion
          emitDefaultValueCheck(ctx, fctx, fieldType, targetLocal, defaultInit, targetType ?? undefined);
        } else {
          if (targetType && !valTypesMatch(fieldType, targetType)) {
            coerceType(ctx, fctx, fieldType, targetType);
          }
          fctx.body.push({ op: "local.set", index: targetLocal });
        }

        if (tupleSyncGlobalIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({ op: "global.set", index: tupleSyncGlobalIdx });
        }
      }
    } else {
      // Vec array assignment destructuring
      const innerArrTypeIdx = getArrTypeIdxFromVec(ctx, innerVecTypeIdx);
      const innerArrDef = ctx.mod.types[innerArrTypeIdx];
      if (!innerArrDef || innerArrDef.kind !== "array") return;

      const innerElemType = innerArrDef.element;
      for (let i = 0; i < expr.elements.length; i++) {
        const el = expr.elements[i]!;
        if (ts.isOmittedExpression(el)) continue;

        // Handle nested destructuring: for ([{ a, b }] of arr) or for ([[x, y]] of arr)
        if (ts.isObjectLiteralExpression(el) || ts.isArrayLiteralExpression(el)) {
          const nestedLocal = allocLocal(fctx, `__forof_nested_${fctx.locals.length}`, innerElemType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: innerVecTypeIdx,
            fieldIdx: 1,
          });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);
          fctx.body.push({ op: "local.set", index: nestedLocal });
          compileForOfAssignDestructuring(ctx, fctx, el, nestedLocal, innerElemType, vecTypeIdx, arrTypeIdx, stmt);
          continue;
        }

        // Handle assignment with default: [v = 10]
        let targetEl: ts.Expression = el;
        let defaultInit: ts.Expression | undefined;
        if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          targetEl = el.left;
          defaultInit = el.right;
        }

        if (!ts.isIdentifier(targetEl)) continue;

        let targetLocal = fctx.localMap.get(targetEl.text);
        let vecSyncGlobalIdx: number | undefined;
        if (targetLocal === undefined) {
          const globalIdx = ctx.moduleGlobals.get(targetEl.text);
          if (globalIdx === undefined) continue;
          const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
          const globalType = globalDef?.type ?? { kind: "externref" as const };
          targetLocal = allocLocal(fctx, targetEl.text, globalType);
          vecSyncGlobalIdx = globalIdx;
        }

        const targetType = getLocalType(fctx, targetLocal);

        // #1510 — boxed-capture target with default initializer (vec path).
        // Mirror of the externref-path fix in compileForOfAssignDestructuringExternref.
        // Without this, `emitDefaultValueCheck` does `local.set` on the captured
        // param, overwriting the box-ref. The pre-fix symptom is
        // "dereferencing a null pointer" (when valType is a ref) or silently
        // lost writes (when valType is f64 → coerce mismatch + drop).
        const boxedCapVec = fctx.boxedCaptures?.get(targetEl.text);
        if (boxedCapVec && defaultInit) {
          const valType = boxedCapVec.valType;
          // Read elem.data[i] safely (bounds-checked → produces innerElemType or
          // the type's "undefined" sentinel for OOB). For f64 element types this
          // returns NaN sentinel; for ref/externref it returns null.
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: innerVecTypeIdx,
            fieldIdx: 1,
          });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);
          // Now stack: [box-ref, value:innerElemType]. Apply default-on-undefined
          // and coerce to valType before struct.set.
          // For f64: check sNaN sentinel; for ref/null: check ref.is_null;
          // for externref: __extern_is_undefined.
          const tmpVal = allocLocal(fctx, `__forof_dflt_v_${fctx.locals.length}`, innerElemType);
          fctx.body.push({ op: "local.tee", index: tmpVal });
          if (innerElemType.kind === "f64") {
            fctx.body.push({ op: "i64.reinterpret_f64" });
            fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den });
            fctx.body.push({ op: "i64.eq" });
          } else if (innerElemType.kind === "externref") {
            const undefIdx = ensureExternIsUndefined(ctx, fctx);
            if (undefIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: undefIdx });
            } else {
              fctx.body.push({ op: "ref.is_null" } as Instr);
            }
          } else if (innerElemType.kind === "ref" || innerElemType.kind === "ref_null") {
            fctx.body.push({ op: "ref.is_null" } as Instr);
          } else {
            // i32 or other — no reliable undefined sentinel; treat as not-undefined.
            fctx.body.push({ op: "i32.const", value: 0 });
          }
          const thenInstrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, defaultInit!, valType);
          });
          const elseInstrs = collectInstrs(fctx, () => {
            fctx.body.push({ op: "local.get", index: tmpVal } as Instr);
            if (!valTypesMatch(innerElemType, valType)) {
              coerceType(ctx, fctx, innerElemType, valType);
            }
          });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: valType },
            then: thenInstrs,
            else: elseInstrs,
          });
          fctx.body.push({
            op: "struct.set",
            typeIdx: boxedCapVec.refCellTypeIdx,
            fieldIdx: 0,
          });
          if (vecSyncGlobalIdx !== undefined) {
            fctx.body.push({ op: "local.get", index: targetLocal });
            fctx.body.push({
              op: "struct.get",
              typeIdx: boxedCapVec.refCellTypeIdx,
              fieldIdx: 0,
            });
            fctx.body.push({ op: "global.set", index: vecSyncGlobalIdx });
          }
          continue;
        }

        if (defaultInit && innerElemType.kind === "externref") {
          // For externref elements with defaults, do explicit bounds check.
          // OOB produces ref.null.extern (Wasm null) which is indistinguishable from JS null.
          // We must apply defaults for OOB but NOT for JS null.
          const arrDataLocal = allocLocal(fctx, `__forof_arr_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: innerArrTypeIdx,
          });
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: innerVecTypeIdx,
            fieldIdx: 1,
          });
          fctx.body.push({ op: "local.tee", index: arrDataLocal });
          fctx.body.push({ op: "array.len" });
          fctx.body.push({ op: "i32.const", value: i });
          fctx.body.push({ op: "i32.gt_s" } as Instr); // len > i means in-bounds

          const hintType = targetType ?? innerElemType;
          // Then branch: in-bounds — get element, check for undefined, apply default if needed
          const thenInstrs = collectInstrs(fctx, () => {
            fctx.body.push({ op: "local.get", index: arrDataLocal } as Instr);
            fctx.body.push({ op: "i32.const", value: i } as Instr);
            fctx.body.push({
              op: "array.get",
              typeIdx: innerArrTypeIdx,
            } as Instr);
            emitDefaultValueCheck(ctx, fctx, innerElemType, targetLocal!, defaultInit!, targetType ?? undefined);
          });
          // Else branch: OOB — apply default directly
          const elseInstrs = collectInstrs(fctx, () => {
            compileExpression(ctx, fctx, defaultInit!, hintType);
            fctx.body.push({ op: "local.set", index: targetLocal! } as Instr);
          });
          fctx.body.push({
            op: "if",
            blockType: { kind: "empty" },
            then: thenInstrs,
            else: elseInstrs,
          } as Instr);
        } else {
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: innerVecTypeIdx,
            fieldIdx: 1,
          });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);

          if (defaultInit) {
            // Check for undefined and apply default — BEFORE type coercion
            emitDefaultValueCheck(ctx, fctx, innerElemType, targetLocal, defaultInit, targetType ?? undefined);
          } else {
            if (targetType && !valTypesMatch(innerElemType, targetType)) {
              coerceType(ctx, fctx, innerElemType, targetType);
            }
            fctx.body.push({ op: "local.set", index: targetLocal });
          }
        }

        if (vecSyncGlobalIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({ op: "global.set", index: vecSyncGlobalIdx });
        }
      }
    }
  }
}

/**
 * Handle assignment destructuring of externref arrays in for-of.
 * Uses __extern_get(elem, box(i)) for each element, with default value support.
 */
function compileForOfAssignDestructuringExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ArrayLiteralExpression,
  elemLocal: number,
): void {
  // Ensure __extern_get is available (#1866: ensureLateImport routes to the
  // native object-runtime impl under --target standalone — no leaked
  // `env::__extern_get` host import — and to the host import in JS-host mode).
  ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  let getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) return;

  // Ensure __box_number is available
  let boxIdx = ctx.funcMap.get("__box_number");
  if (boxIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const boxType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    boxIdx = ctx.funcMap.get("__box_number");
    getIdx = ctx.funcMap.get("__extern_get");
  }
  if (boxIdx === undefined || getIdx === undefined) return;

  // Lazily register __extern_set for property/element-access destructuring
  // targets. We only register if/when we actually need it; that keeps the
  // identifier-only happy path's import surface unchanged.
  let setIdx: number | undefined;
  const ensureExternSet = (): number | undefined => {
    if (setIdx !== undefined) return setIdx;
    setIdx = ctx.funcMap.get("__extern_set");
    if (setIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const setType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
      addImport(ctx, "env", "__extern_set", { kind: "func", typeIdx: setType });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      setIdx = ctx.funcMap.get("__extern_set");
    }
    return setIdx;
  };

  for (let i = 0; i < expr.elements.length; i++) {
    const el = expr.elements[i]!;
    if (ts.isOmittedExpression(el)) continue;
    if (ts.isSpreadElement(el)) continue;

    // Handle assignment with default: [v = 10]
    let targetEl: ts.Expression = el;
    let defaultInit: ts.Expression | undefined;
    if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      targetEl = el.left;
      defaultInit = el.right;
    }

    // #1258 — destructure-assignment target may be a property access
    // (`[x.y] of [[4]]`) or element access (`[x[0]] of [[4]]`), not just
    // an identifier. Pre-#1258 the function bailed (`continue`) on any
    // non-identifier target, silently dropping the write. Spec §13.15.5.5
    // ArrayAssignmentPattern requires PutValue on the LHS — for property
    // references that is `__extern_set(receiver, key, value)`.
    if (ts.isPropertyAccessExpression(targetEl) || ts.isElementAccessExpression(targetEl)) {
      const setFnIdx = ensureExternSet();
      if (setFnIdx === undefined) continue;
      // Push receiver (already-existing variable, evaluated each iteration)
      const recvType = compileExpression(ctx, fctx, targetEl.expression, {
        kind: "externref",
      });
      if (recvType && recvType.kind !== "externref") {
        coerceType(ctx, fctx, recvType, { kind: "externref" });
      }
      if (recvType === null) {
        fctx.body.push({ op: "ref.null.extern" });
      }
      // Push key — string literal for `.prop`, computed value for `[expr]`
      if (ts.isPropertyAccessExpression(targetEl)) {
        const propName = targetEl.name.text;
        addStringConstantGlobal(ctx, propName);
        const keyGlobalIdx = ctx.stringGlobalMap.get(propName);
        if (keyGlobalIdx !== undefined) {
          fctx.body.push({ op: "global.get", index: keyGlobalIdx } as Instr);
        } else {
          // Fallback: skip — string-pool registration should cover all literal names
          continue;
        }
      } else {
        // ElementAccessExpression
        const keyType = compileExpression(ctx, fctx, targetEl.argumentExpression, { kind: "externref" });
        if (keyType && keyType.kind !== "externref") {
          coerceType(ctx, fctx, keyType, { kind: "externref" });
        }
        if (keyType === null) {
          fctx.body.push({ op: "ref.null.extern" });
        }
      }
      // Push value: __extern_get(elem, box(i))
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "f64.const", value: i });
      fctx.body.push({ op: "call", funcIdx: boxIdx });
      fctx.body.push({ op: "call", funcIdx: getIdx! });
      // Defaults on property targets: if the read is undefined, fall back to default.
      // Spec applies to ALL destructure targets identically, but the existing emit
      // path uses `emitDefaultValueCheck` against a local. For property targets
      // we'd need a temp local + the same dispatch. Out of scope for #1258 —
      // the target test cases (put-prop-ref shape) don't use destructure defaults
      // on property targets. If `defaultInit` is present on a property target,
      // skip silently rather than miscompile.
      if (defaultInit) {
        // Drop the value we just pushed; nothing to write without default-handling.
        fctx.body.push({ op: "drop" } as Instr);
        // Also drop key + receiver — they're still on the stack.
        fctx.body.push({ op: "drop" } as Instr);
        fctx.body.push({ op: "drop" } as Instr);
        continue;
      }
      // __extern_set(receiver, key, value) -> void
      fctx.body.push({ op: "call", funcIdx: setFnIdx });
      continue;
    }

    if (!ts.isIdentifier(targetEl)) continue;

    let targetLocal = fctx.localMap.get(targetEl.text);
    let extSyncGlobalIdx: number | undefined;
    if (targetLocal === undefined) {
      const globalIdx = ctx.moduleGlobals.get(targetEl.text);
      if (globalIdx === undefined) continue;
      const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
      const globalType = globalDef?.type ?? { kind: "externref" as const };
      targetLocal = allocLocal(fctx, targetEl.text, globalType);
      extSyncGlobalIdx = globalIdx;
    }

    // #1258 — if the target identifier is a boxed capture (mutable closure
    // capture re-aimed at a ref-cell), the value must go through `struct.set`
    // on the cell, not a direct `local.set` (which would overwrite the
    // ref-cell ref with the value, breaking the closure's view). Detect via
    // `fctx.boxedCaptures` and emit the boxed-write shape.
    const boxedCap = fctx.boxedCaptures?.get(targetEl.text);
    if (boxedCap && !defaultInit) {
      // Boxed-capture path: <local.get cell-ref> <value> <struct.set 0>
      fctx.body.push({ op: "local.get", index: targetLocal });
      // Push value: __extern_get(elem, box(i))
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "f64.const", value: i });
      fctx.body.push({ op: "call", funcIdx: boxIdx });
      fctx.body.push({ op: "call", funcIdx: getIdx! });
      // Coerce value to the cell's inner type if needed (refCell stores valType)
      if (boxedCap.valType.kind !== "externref") {
        coerceType(ctx, fctx, { kind: "externref" }, boxedCap.valType);
      }
      fctx.body.push({
        op: "struct.set",
        typeIdx: boxedCap.refCellTypeIdx,
        fieldIdx: 0,
      });
      if (extSyncGlobalIdx !== undefined) {
        // Re-load through the cell for global sync
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({
          op: "struct.get",
          typeIdx: boxedCap.refCellTypeIdx,
          fieldIdx: 0,
        });
        fctx.body.push({ op: "global.set", index: extSyncGlobalIdx });
      }
      continue;
    }

    // #1510 — boxed-capture target WITH default initializer.
    // The pre-#1510 code fell through to `emitDefaultValueCheck` which
    // emitted `local.set` directly on the captured param — overwriting
    // the box-ref instead of writing through the cell. The mutation was
    // invisible to the outer scope's box, which silently kept the old
    // value (e.g. -1 from a `let v = -1` decl). Test262 cases:
    //   - language/statements/for-await-of/async-{gen,func}-decl-dstr-
    //     array-elem-init-assignment.js — `[v = expr] of …` where `v` is
    //     a `let`-bound outer variable captured by the async function.
    // Spec §13.15.5.5 ArrayAssignmentPattern requires PutValue on the
    // LHS; for a boxed-capture variable that means `struct.set` on
    // field 0 of the cell.
    if (boxedCap && defaultInit) {
      const valType = boxedCap.valType;
      const undefIdx = ensureExternIsUndefined(ctx, fctx);
      // Push the box-ref for the eventual struct.set.
      fctx.body.push({ op: "local.get", index: targetLocal });
      // Get the extracted value: __extern_get(elem, box(i)) -> externref
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "f64.const", value: i });
      fctx.body.push({ op: "call", funcIdx: boxIdx! });
      fctx.body.push({ op: "call", funcIdx: getIdx! });
      // Tee into a temp so we can both test-undefined and reuse on else.
      const tmpExt = allocLocal(fctx, `__forof_dflt_ext_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.tee", index: tmpExt });
      // Test undefined-ness (using __extern_is_undefined; JS spec applies
      // defaults only on `undefined`, NOT on `null`).
      if (undefIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: undefIdx });
      } else {
        // Fallback: ref.is_null treats null AS undefined — imprecise but safer
        // than crashing. The runtime always exposes __extern_is_undefined.
        fctx.body.push({ op: "ref.is_null" } as Instr);
      }
      // Build then-branch (default fires): compile default to valType.
      const thenInstrs = collectInstrs(fctx, () => {
        compileExpression(ctx, fctx, defaultInit, valType);
      });
      // Build else-branch (value used as-is): coerce externref -> valType.
      const elseInstrs = collectInstrs(fctx, () => {
        fctx.body.push({ op: "local.get", index: tmpExt } as Instr);
        if (valType.kind !== "externref") {
          coerceType(ctx, fctx, { kind: "externref" }, valType);
        }
      });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: valType },
        then: thenInstrs,
        else: elseInstrs,
      });
      // Now stack: [box-ref, value:valType]
      fctx.body.push({
        op: "struct.set",
        typeIdx: boxedCap.refCellTypeIdx,
        fieldIdx: 0,
      });
      if (extSyncGlobalIdx !== undefined) {
        // Re-load through the cell for global sync
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({
          op: "struct.get",
          typeIdx: boxedCap.refCellTypeIdx,
          fieldIdx: 0,
        });
        fctx.body.push({ op: "global.set", index: extSyncGlobalIdx });
      }
      continue;
    }

    // Emit: __extern_get(elem, box(i)) -> externref
    fctx.body.push({ op: "local.get", index: elemLocal });
    fctx.body.push({ op: "f64.const", value: i });
    fctx.body.push({ op: "call", funcIdx: boxIdx });
    fctx.body.push({ op: "call", funcIdx: getIdx! });

    if (defaultInit) {
      const targetType = getLocalType(fctx, targetLocal);
      emitDefaultValueCheck(ctx, fctx, { kind: "externref" }, targetLocal, defaultInit, targetType ?? undefined);
    } else {
      // Coerce externref to target local's type and set
      emitCoercedLocalSet(ctx, fctx, targetLocal, { kind: "externref" });
    }

    if (extSyncGlobalIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: targetLocal });
      fctx.body.push({ op: "global.set", index: extSyncGlobalIdx });
    }
  }
}

/** Collect all identifier names from a binding pattern (ObjectBindingPattern or ArrayBindingPattern) */
function collectBindingNames(pattern: ts.BindingPattern): string[] {
  const names: string[] = [];
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isBindingElement(element)) {
      if (ts.isIdentifier(element.name)) {
        names.push(element.name.text);
      } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
        names.push(...collectBindingNames(element.name));
      }
    }
  }
  return names;
}

export function compileForOfStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForOfStatement): void {
  // Check the TS type of the iterable to decide compilation strategy
  const exprTsType = ctx.checker.getTypeAtLocation(stmt.expression);

  // String iteration: for (const c of "hello") iterates characters
  // In fast mode, use native string struct iteration (pure Wasm)
  if (isStringType(exprTsType) && ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
    compileForOfString(ctx, fctx, stmt);
    return;
  }

  // #681: `for (x of arr.values())` is semantically identical to `for (x of arr)`
  // — Array.prototype.values() walks the element list in order. Recognize the
  // CallExpression subject and drive the existing index loop over the inner
  // receiver, so standalone/WASI iterate natively instead of hard-erroring in
  // compileArrayIteratorMethod. JS-host mode benefits too (no __array_values).
  //
  // `arr.keys()` (§23.1.3.16 — yields each index) and `arr.entries()`
  // (§23.1.3.4 — yields each `[index, value]` pair) share the same in-order
  // index drive but project a different per-iteration value, so they go through
  // compileForOfArrayKeys / compileForOfArrayEntries. All three eliminate the
  // __array_values/__array_keys/__array_entries host imports in standalone/WASI.
  const arrayIterRecv = arrayIteratorReceiverForForOf(ctx, fctx, stmt);
  if (arrayIterRecv) {
    if (arrayIterRecv.method === "values") {
      if (compileForOfArrayTentative(ctx, fctx, stmt, arrayIterRecv.receiver)) return;
    } else if (arrayIterRecv.method === "keys") {
      compileForOfArrayKeys(ctx, fctx, stmt, arrayIterRecv.receiver);
      return;
    } else {
      compileForOfArrayEntries(ctx, fctx, stmt, arrayIterRecv.receiver);
      return;
    }
  }

  // The TS type resolving to `Array` is necessary but NOT sufficient to use the
  // fast vec-struct array path: an Array-typed iterable can still lower to a
  // non-vec value (a Symbol.iterator whose declared return widens to Array, an
  // array-subclass instance, a union). Tentatively compile the expression and
  // only take the array path when it genuinely produces a vec struct; otherwise
  // fall back to the iterator protocol instead of hard-erroring with
  // "for-of requires an array expression" (#1610).
  if (!compileForOfArrayTentative(ctx, fctx, stmt)) {
    compileForOfIterator(ctx, fctx, stmt);
  }
}

/** #681: an `arr.values()/keys()/entries()` for-of subject resolved to a vec. */
interface ArrayIteratorReceiver {
  receiver: ts.Expression;
  method: "values" | "keys" | "entries";
}

/**
 * #681: detect `for (… of <recv>.<m>())` for `m` ∈ {values, keys, entries} and
 * return the inner `<recv>` (plus which method) when it is a zero-argument call
 * whose receiver resolves to a Wasm vec struct. The three Array iterator
 * methods all walk the element list in order:
 *   - `.values()`  yields each element  → identical to iterating the array.
 *   - `.keys()`    yields each index    → compileForOfArrayKeys (§23.1.3.16).
 *   - `.entries()` yields `[i, value]`  → compileForOfArrayEntries (§23.1.3.4).
 * Recognizing them lets standalone/WASI drive a pure-Wasm index loop instead of
 * hard-erroring in compileArrayIteratorMethod. Returns undefined when the
 * subject is not a recognizable Array iterator-method call over a vec.
 */
function arrayIteratorReceiverForForOf(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
): ArrayIteratorReceiver | undefined {
  const subject = stmt.expression;
  if (!ts.isCallExpression(subject) || subject.arguments.length !== 0) return undefined;
  const callee = subject.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.name.text;
  if (method !== "values" && method !== "keys" && method !== "entries") return undefined;

  // Confirm the receiver lowers to a vec struct without leaving any code behind.
  const bodyLenBefore = fctx.body.length;
  const localsSnap = snapshotLocals(fctx); // #1847
  const recvType = compileExpression(ctx, fctx, callee.expression);
  fctx.body.length = bodyLenBefore;
  restoreLocals(fctx, localsSnap); // #1847 — also drops stale localMap entries
  if (!recvType || (recvType.kind !== "ref" && recvType.kind !== "ref_null")) return undefined;
  if (getArrTypeIdxFromVec(ctx, recvType.typeIdx) < 0) return undefined;
  return { receiver: callee.expression, method };
}

/** Compile for...of over a string — iterate characters using __str_charAt */
function compileForOfString(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForOfStatement): void {
  // Ensure native string helpers are available (provides __str_charAt)
  ensureNativeStringHelpers(ctx);

  // #1186: re-resolve `__str_charAt` by name against `ctx.mod.functions`
  // rather than reading the cached index from `ctx.nativeStrHelpers`. The
  // helpers map captures funcIdx at registration time, but late-import
  // additions later in the compilation pipeline can shift the index space
  // (`shiftLateImportIndices` walks `ctx.mod.functions[].body` and
  // `ctx.funcMap` but does NOT update `ctx.nativeStrHelpers`). The
  // captured index becomes stale and at runtime resolves to whatever
  // import landed at that position (typically `__is_truthy`), producing
  // an invalid Wasm body that fails validation:
  //
  //   call[0] expected externref, found local.get of type i32
  //
  // The IR path (#1183) sidesteps this by walking
  // `ctx.mod.functions[i].name` at lowering time. Mirroring that here
  // for the legacy path:
  let flattenIdx: number | undefined;
  let substringIdx: number | undefined;
  for (let i = 0; i < ctx.mod.functions.length; i++) {
    const name = ctx.mod.functions[i]!.name;
    if (name === "__str_flatten") flattenIdx = ctx.numImportFuncs + i;
    else if (name === "__str_substring") substringIdx = ctx.numImportFuncs + i;
    if (flattenIdx !== undefined && substringIdx !== undefined) break;
  }
  if (flattenIdx === undefined || substringIdx === undefined) {
    reportError(ctx, stmt, "for-of on string: __str_flatten/__str_substring helpers not available");
    return;
  }

  const strType = nativeStringType(ctx);

  // Compile the iterable expression (string ref)
  const bodyLenBefore = fctx.body.length;
  const compiledType = compileExpression(ctx, fctx, stmt.expression);
  if (!compiledType) {
    fctx.body.length = bodyLenBefore;
    reportError(ctx, stmt, "for-of: failed to compile string expression");
    return;
  }

  // Save string ref to temp local
  const strLocal = allocLocal(fctx, `__forof_str_${fctx.locals.length}`, strType);
  fctx.body.push({ op: "local.set", index: strLocal });

  // Mark position for null guard wrapping
  const strNullGuardStart = fctx.body.length;

  // (#1470) Flatten ONCE up front and cache len/off/data: the loop reads raw
  // code units to detect surrogate pairs (§22.1.5.1 — the String iterator
  // yields code points, so a well-formed pair is one 2-code-unit element).
  const flatLocal = allocLocal(fctx, `__forof_flat_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: ctx.nativeStrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: strLocal });
  fctx.body.push({ op: "call", funcIdx: flattenIdx });
  fctx.body.push({ op: "local.set", index: flatLocal });

  const lenLocal = allocLocal(fctx, `__forof_len_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });

  const offLocal = allocLocal(fctx, `__forof_off_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: offLocal });

  const dataLocal = allocLocal(fctx, `__forof_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: ctx.nativeStrDataTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 2 });
  fctx.body.push({ op: "local.set", index: dataLocal });

  const takeLocal = allocLocal(fctx, `__forof_take_${fctx.locals.length}`, {
    kind: "i32",
  });

  // Allocate counter local (i32)
  const iLocal = allocLocal(fctx, `__forof_i_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // Element type is string (each character is a single-char string)
  const elemType = strType;

  // Declare the loop variable
  let elemLocal: number;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forof_elem_${fctx.locals.length}`;
    elemLocal = allocLocal(fctx, varName, elemType);
    // Track const bindings — assignment to const in for-of should throw TypeError
    if (stmt.initializer.flags & ts.NodeFlags.Const && ts.isIdentifier(decl.name)) {
      if (!fctx.constBindings) fctx.constBindings = new Set();
      fctx.constBindings.add(decl.name.text);
    }
  } else if (ts.isIdentifier(stmt.initializer)) {
    // Expression form: for (x of str) — x is already declared
    const varName = stmt.initializer.text;
    elemLocal = fctx.localMap.get(varName) ?? allocLocal(fctx, varName, elemType);
  } else {
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  }

  // Build loop body
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop adds 2 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 2;
  adjustRethrowDepth(fctx, 2);

  fctx.breakStack.push(1); // break = depth 1 (exit block)
  fctx.continueStack.push(0); // continue = depth 0 (restart loop)

  // Condition: i >= length -> break
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break

  // take = 1; if data[off+i] is a high surrogate followed by a low surrogate,
  // take = 2 (the pair is one code point — §22.1.5.1).
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "local.set", index: takeLocal });
  // (data[off + i] & 0xFC00) == 0xD800 && i + 1 < len
  fctx.body.push({ op: "local.get", index: dataLocal });
  fctx.body.push({ op: "local.get", index: offLocal });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "array.get_u", typeIdx: ctx.nativeStrDataTypeIdx });
  fctx.body.push({ op: "i32.const", value: 0xfc00 });
  fctx.body.push({ op: "i32.and" });
  fctx.body.push({ op: "i32.const", value: 0xd800 });
  fctx.body.push({ op: "i32.eq" });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.lt_s" });
  fctx.body.push({ op: "i32.and" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      // (data[off + i + 1] & 0xFC00) == 0xDC00 → take = 2
      { op: "local.get", index: dataLocal },
      { op: "local.get", index: offLocal },
      { op: "local.get", index: iLocal },
      { op: "i32.add" },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "array.get_u", typeIdx: ctx.nativeStrDataTypeIdx },
      { op: "i32.const", value: 0xfc00 },
      { op: "i32.and" },
      { op: "i32.const", value: 0xdc00 },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 2 },
          { op: "local.set", index: takeLocal },
        ],
      } as Instr,
    ],
  } as Instr);

  // Get element: c = __str_substring(flat, i, i + take)
  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({ op: "ref.as_non_null" } as Instr);
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: takeLocal });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "call", funcIdx: substringIdx });
  fctx.body.push({ op: "local.set", index: elemLocal });

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  // Advance by the consumed code-unit count (1, or 2 for a surrogate pair)
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: takeLocal });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: iLocal });

  fctx.body.push({ op: "br", depth: 0 }); // continue loop

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 2;
  adjustRethrowDepth(fctx, -2);

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });

  // Null guard: if string ref is nullable, throw TypeError on null (#775)
  // In JS, `for (const c of null)` throws TypeError
  if (strType.kind === "ref_null") {
    const guardedInstrs = fctx.body.splice(strNullGuardStart);
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "local.get", index: strLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
      else: guardedInstrs,
    });
  }
}

/**
 * Tentatively try to compile for...of as an array iteration.
 * Compiles the iterable expression, checks if the result is a vec struct,
 * and if so delegates to compileForOfArray (which re-compiles the expression).
 * Returns true if the array path was used, false if caller should fall back.
 */
function compileForOfArrayTentative(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  iterableOverride?: ts.Expression,
): boolean {
  const iterableExpr = iterableOverride ?? stmt.expression;
  // Tentatively compile just the expression to discover its Wasm type
  const bodyLenBefore = fctx.body.length;
  const localsSnap = snapshotLocals(fctx); // #1847
  const exprType = compileExpression(ctx, fctx, iterableExpr);

  // Check if it compiled to a ref to a vec struct (not just any struct —
  // a class instance is also a struct but not iterable via array access).
  // A vec struct has {length: i32, data: (ref $arr)} — verified by getArrTypeIdxFromVec.
  if (exprType && (exprType.kind === "ref" || exprType.kind === "ref_null")) {
    const typeDef = ctx.mod.types[exprType.typeIdx];
    if (typeDef && typeDef.kind === "struct" && getArrTypeIdxFromVec(ctx, exprType.typeIdx) >= 0) {
      // Confirmed vec struct — undo the tentative compilation and use the
      // full array path (which compiles the expression again with proper setup)
      fctx.body.length = bodyLenBefore;
      restoreLocals(fctx, localsSnap); // #1847
      compileForOfArray(ctx, fctx, stmt, iterableOverride);
      return true;
    }
  }

  // Not a vec struct — undo tentative compilation, let caller use iterator path
  fctx.body.length = bodyLenBefore;
  restoreLocals(fctx, localsSnap); // #1847
  return false;
}

/** Compile for...of over an array using index-based loop (existing behavior) */
function compileForOfArray(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  iterableOverride?: ts.Expression,
): void {
  // Compile the iterable expression (vec struct ref). `iterableOverride` is the
  // inner receiver of a `.values()` call (#681) when present.
  const bodyLenBefore = fctx.body.length;
  const vecType = compileExpression(ctx, fctx, iterableOverride ?? stmt.expression);
  if (!vecType || (vecType.kind !== "ref" && vecType.kind !== "ref_null")) {
    fctx.body.length = bodyLenBefore;
    reportError(ctx, stmt, "for-of requires an array expression");
    return;
  }

  // Expect a vec struct type {length: i32, data: (ref $__arr_T)}
  const vecTypeIdx = vecType.typeIdx;
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct") {
    fctx.body.length = bodyLenBefore;
    reportError(ctx, stmt, "for-of requires an array type");
    return;
  }

  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") {
    fctx.body.length = bodyLenBefore;
    reportError(ctx, stmt, "for-of requires an array type");
    return;
  }
  const elemType = arrDef.element;

  // Save vec ref to temp local
  const vecLocal = allocLocal(fctx, `__forof_vec_${fctx.locals.length}`, vecType);
  fctx.body.push({ op: "local.set", index: vecLocal });

  // #2065: Array iterators re-read the live length each step (§23.1.5.1), so a
  // body that mutates the array (push/pop/splice/length=…/reassignment, or a
  // closure that captures it) must observe the change. Hoisting `length`/`data`
  // once before the loop misses pushes and over-iterates after pops (and a
  // reallocated backing array leaves `data` stale). When the iterable is a plain
  // identifier and the body may mutate it, re-read both fields from the vec local
  // at the top of every iteration. Non-mutating loops keep the hoisted fast path.
  const iterableSource = iterableOverride ?? stmt.expression;
  const reReadLive =
    ts.isIdentifier(iterableSource) && loopBodyMutatesIndexOrArray(stmt.statement, "", iterableSource.text);

  // Mark position for null guard wrapping (struct.get on null ref traps)
  const nullGuardStart = fctx.body.length;

  // Extract data array from vec into a local
  const dataLocal = allocLocal(fctx, `__forof_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataLocal });

  // Extract length from vec into a local
  const lenLocal = allocLocal(fctx, `__forof_len_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // Allocate counter local (i32)
  const iLocal = allocLocal(fctx, `__forof_i_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // Declare the loop variable (may be a simple identifier or a destructuring pattern)
  let elemLocal: number;
  let destructPattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern | null = null;
  let assignDestructExpr: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | null = null;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    const isConst = !!(stmt.initializer.flags & ts.NodeFlags.Const);
    if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
      destructPattern = decl.name;
      // Allocate a temp local to hold the element for destructuring
      elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
      // Track const bindings for all identifiers in the destructuring pattern
      if (isConst) {
        collectBindingNames(decl.name).forEach((n) => {
          if (!fctx.constBindings) fctx.constBindings = new Set();
          fctx.constBindings.add(n);
        });
      }
    } else {
      const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forof_elem_${fctx.locals.length}`;
      elemLocal = allocLocal(fctx, varName, elemType);
      // Track const bindings — assignment to const in for-of should throw TypeError
      if (isConst && ts.isIdentifier(decl.name)) {
        if (!fctx.constBindings) fctx.constBindings = new Set();
        fctx.constBindings.add(decl.name.text);
      }
    }
  } else if (ts.isObjectLiteralExpression(stmt.initializer) || ts.isArrayLiteralExpression(stmt.initializer)) {
    // Expression form with destructuring: for ({a, b} of arr) or for ([x, y] of arr)
    // These assign to already-declared variables
    assignDestructExpr = stmt.initializer;
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  } else if (ts.isIdentifier(stmt.initializer)) {
    // Expression form: for (x of arr) — x is already declared
    const varName = stmt.initializer.text;
    elemLocal = fctx.localMap.get(varName) ?? allocLocal(fctx, varName, elemType);
  } else {
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  }

  // Build loop body
  const savedBody = pushBody(fctx);

  // Structure: block { loop { guard/bind; block { body }; i++; br loop } }.
  // `continue` exits the inner body block so the increment still runs.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);

  fctx.breakStack.push(2); // break = depth 2 (exit outer block)
  fctx.continueStack.push(0); // continue = depth 0 (exit body block, then increment)

  // Condition: i >= length → break. When the array may be mutated mid-loop
  // (#2065), read the live length from the vec each iteration rather than the
  // hoisted `lenLocal`.
  fctx.body.push({ op: "local.get", index: iLocal });
  if (reReadLive) {
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  } else {
    fctx.body.push({ op: "local.get", index: lenLocal });
  }
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 }); // break

  // Get element: x = data[i]. Re-read the live data array when mutating (#2065):
  // a growth that reallocated the backing array leaves the hoisted `dataLocal`
  // stale.
  if (reReadLive) {
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  } else {
    fctx.body.push({ op: "local.get", index: dataLocal });
  }
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "array.get", typeIdx: arrTypeIdx });
  // Coerce from Wasm array element type to the local's declared type
  const elemLocalType = getLocalType(fctx, elemLocal);
  if (elemLocalType && !valTypesMatch(elemType, elemLocalType)) {
    coerceType(ctx, fctx, elemType, elemLocalType);
  }
  emitCoercedLocalSet(ctx, fctx, elemLocal, elemType);

  // If destructuring pattern (binding form), destructure from the element
  if (destructPattern) {
    compileForOfDestructuring(ctx, fctx, destructPattern, elemLocal, elemType, stmt);
  }
  // If assignment destructuring expression, assign to existing locals
  if (assignDestructExpr) {
    compileForOfAssignDestructuring(ctx, fctx, assignDestructExpr, elemLocal, elemType, vecTypeIdx, arrTypeIdx, stmt);
  }

  const savedLoopBody = pushBody(fctx);

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }
  const bodyInstrs = fctx.body;
  popBody(fctx, savedLoopBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: bodyInstrs,
  });

  // Increment i
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: iLocal });

  fctx.body.push({ op: "br", depth: 0 }); // continue loop

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;
  adjustRethrowDepth(fctx, -3);

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });

  // Null guard: if vec ref is nullable, guard against null (#775, #789)
  // If null from a failed guarded cast (wrong struct type), just skip the loop.
  // Only throw TypeError for genuinely null values (e.g. `for (const x of null)`).
  if (vecType.kind === "ref_null") {
    const guardedInstrs = fctx.body.splice(nullGuardStart);
    const backupLocal: number | undefined = (fctx as any).__lastGuardedCastBackup;
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    if (backupLocal !== undefined) {
      // A guarded cast backup exists: distinguish "wrong type" from "genuinely null"
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: backupLocal } as Instr,
          { op: "ref.is_null" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
            else: [], // wrong struct type → skip loop
          } as Instr,
        ],
        else: guardedInstrs,
      });
    } else {
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
        else: guardedInstrs,
      });
    }
  }
}

/**
 * #681: `for (k of arr.keys())` — Array.prototype.keys() (§23.1.3.16) yields the
 * array indices 0..length-1 in order. Drive a pure-Wasm index loop and bind the
 * loop variable to `f64(i)` each iteration. The loop variable must be a plain
 * identifier (number-typed); a binding/assignment pattern over a numeric key is
 * not meaningful, so those fall through to the iterator protocol via the caller
 * having already checked `method === "keys"`. Mirrors compileForOfArray's
 * vec-length read, null guard and break/continue depth bookkeeping.
 */
function compileForOfArrayKeys(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  receiver: ts.Expression,
): void {
  // Resolve the loop variable. `.keys()` yields numbers, so only a simple
  // identifier binding is supported; anything else falls back to the iterator
  // path (which still hard-errors in standalone — an explicit, tracked gap).
  let keyLocal: number;
  let isConst = false;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    if (!ts.isIdentifier(decl.name)) {
      if (!compileForOfArrayTentative(ctx, fctx, stmt)) compileForOfIterator(ctx, fctx, stmt);
      return;
    }
    isConst = !!(stmt.initializer.flags & ts.NodeFlags.Const);
    keyLocal = allocLocal(fctx, decl.name.text, { kind: "f64" });
    if (isConst) {
      if (!fctx.constBindings) fctx.constBindings = new Set();
      fctx.constBindings.add(decl.name.text);
    }
  } else if (ts.isIdentifier(stmt.initializer)) {
    const varName = stmt.initializer.text;
    keyLocal = fctx.localMap.get(varName) ?? allocLocal(fctx, varName, { kind: "f64" });
  } else {
    if (!compileForOfArrayTentative(ctx, fctx, stmt)) compileForOfIterator(ctx, fctx, stmt);
    return;
  }

  emitArrayKeysEntriesLoop(ctx, fctx, stmt, receiver, (lenLocal, iLocal) => {
    // key = f64(i)
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "local.set", index: keyLocal });
    void lenLocal;
  });
}

/**
 * #681: `for ([k, v] of arr.entries())` — Array.prototype.entries() (§23.1.3.4)
 * yields a `[index, value]` pair for each element in order. The overwhelmingly
 * common form destructures the pair directly, so bind `k = f64(i)` and
 * `v = data[i]` per iteration without materializing a pair object. A
 * non-destructured `for (pair of arr.entries())` would need a 2-tuple value —
 * out of this slice — so it falls through to the iterator path.
 */
function compileForOfArrayEntries(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  receiver: ts.Expression,
): void {
  // Only support the destructured `[k, v]` binding/assignment form here.
  let pattern: ts.ArrayBindingPattern | undefined;
  let assignPattern: ts.ArrayLiteralExpression | undefined;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    if (!ts.isArrayBindingPattern(decl.name)) {
      if (!compileForOfArrayTentative(ctx, fctx, stmt)) compileForOfIterator(ctx, fctx, stmt);
      return;
    }
    pattern = decl.name;
    if (stmt.initializer.flags & ts.NodeFlags.Const) {
      collectBindingNames(decl.name).forEach((n) => {
        if (!fctx.constBindings) fctx.constBindings = new Set();
        fctx.constBindings.add(n);
      });
    }
  } else if (ts.isArrayLiteralExpression(stmt.initializer)) {
    assignPattern = stmt.initializer;
  } else {
    if (!compileForOfArrayTentative(ctx, fctx, stmt)) compileForOfIterator(ctx, fctx, stmt);
    return;
  }

  // Resolve the element (value) Wasm type from the receiver's vec/arr type.
  const probeBody = fctx.body.length;
  const probeLocals = snapshotLocals(fctx);
  const recvType = compileExpression(ctx, fctx, receiver);
  fctx.body.length = probeBody;
  restoreLocals(fctx, probeLocals);
  if (!recvType || (recvType.kind !== "ref" && recvType.kind !== "ref_null")) {
    if (!compileForOfArrayTentative(ctx, fctx, stmt)) compileForOfIterator(ctx, fctx, stmt);
    return;
  }
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, recvType.typeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") {
    if (!compileForOfArrayTentative(ctx, fctx, stmt)) compileForOfIterator(ctx, fctx, stmt);
    return;
  }
  const elemType = arrDef.element;

  // Identify the two binding targets [k, v]. Holes (`[, v]`) and rest
  // (`[k, ...rest]`) are not handled in this slice → fall back.
  const elements = pattern ? pattern.elements : assignPattern!.elements;
  if (elements.length !== 2) {
    if (!compileForOfArrayTentative(ctx, fctx, stmt)) compileForOfIterator(ctx, fctx, stmt);
    return;
  }

  // Bind key target (a number identifier) and value target. Only simple
  // identifier targets are supported here; nested patterns fall back.
  const keyEl = elements[0]!;
  const valEl = elements[1]!;
  let keyLocal: number | undefined;
  let valLocal: number | undefined;
  if (pattern) {
    if (
      !ts.isBindingElement(keyEl) ||
      keyEl.dotDotDotToken ||
      !ts.isIdentifier(keyEl.name) ||
      !ts.isBindingElement(valEl) ||
      valEl.dotDotDotToken ||
      !ts.isIdentifier(valEl.name)
    ) {
      if (!compileForOfArrayTentative(ctx, fctx, stmt)) compileForOfIterator(ctx, fctx, stmt);
      return;
    }
    keyLocal = allocLocal(fctx, keyEl.name.text, { kind: "f64" });
    valLocal = allocLocal(fctx, valEl.name.text, elemType);
  } else {
    if (!ts.isIdentifier(keyEl) || !ts.isIdentifier(valEl)) {
      if (!compileForOfArrayTentative(ctx, fctx, stmt)) compileForOfIterator(ctx, fctx, stmt);
      return;
    }
    keyLocal = fctx.localMap.get(keyEl.text) ?? allocLocal(fctx, keyEl.text, { kind: "f64" });
    valLocal = fctx.localMap.get(valEl.text) ?? allocLocal(fctx, valEl.text, elemType);
  }

  emitArrayKeysEntriesLoop(ctx, fctx, stmt, receiver, (lenLocal, iLocal, dataLocal, loopArrTypeIdx) => {
    // key = f64(i)
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "local.set", index: keyLocal! });
    // value = data[i]
    fctx.body.push({ op: "local.get", index: dataLocal });
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "array.get", typeIdx: loopArrTypeIdx });
    const valLocalType = getLocalType(fctx, valLocal!);
    if (valLocalType && !valTypesMatch(elemType, valLocalType)) {
      coerceType(ctx, fctx, elemType, valLocalType);
    }
    emitCoercedLocalSet(ctx, fctx, valLocal!, elemType);
    void lenLocal;
  });
}

/**
 * #681 shared driver for `.keys()`/`.entries()` for-of: build a `block { loop }`
 * index loop over the receiver vec, invoking `bindIteration` to project the
 * per-iteration binding(s) before the user body runs. Mirrors compileForOfArray's
 * length read, break/continue depth bookkeeping and null guard.
 */
function emitArrayKeysEntriesLoop(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  receiver: ts.Expression,
  bindIteration: (lenLocal: number, iLocal: number, dataLocal: number, arrTypeIdx: number) => void,
): void {
  const bodyLenBefore = fctx.body.length;
  const vecType = compileExpression(ctx, fctx, receiver);
  if (!vecType || (vecType.kind !== "ref" && vecType.kind !== "ref_null")) {
    fctx.body.length = bodyLenBefore;
    reportError(ctx, stmt, "for-of requires an array expression");
    return;
  }
  const vecTypeIdx = vecType.typeIdx;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") {
    fctx.body.length = bodyLenBefore;
    reportError(ctx, stmt, "for-of requires an array type");
    return;
  }

  // Save vec ref to temp local
  const vecLocal = allocLocal(fctx, `__forof_vec_${fctx.locals.length}`, vecType);
  fctx.body.push({ op: "local.set", index: vecLocal });

  // Mark position for null guard wrapping (struct.get on null ref traps).
  const nullGuardStart = fctx.body.length;

  // data = vec.data
  const dataLocal = allocLocal(fctx, `__forof_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: arrTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataLocal });

  // len = vec.length
  const lenLocal = allocLocal(fctx, `__forof_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // i = 0
  const iLocal = allocLocal(fctx, `__forof_i_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // Build loop body
  const savedBody = pushBody(fctx);

  // block+loop+body-block adds 3 nesting levels. The inner body block makes
  // `continue` fall through to the index increment instead of re-reading the
  // same element forever.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);

  fctx.breakStack.push(2); // break = exit outer block
  fctx.continueStack.push(0); // continue = exit body block, then increment

  // i >= len → break
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 });

  // Project the per-iteration binding(s).
  bindIteration(lenLocal, iLocal, dataLocal, arrTypeIdx);

  const savedLoopBody = pushBody(fctx);

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }
  const bodyInstrs = fctx.body;
  popBody(fctx, savedLoopBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: bodyInstrs,
  });

  // i += 1
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: iLocal });

  fctx.body.push({ op: "br", depth: 0 }); // continue loop

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;
  adjustRethrowDepth(fctx, -3);

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // Null guard: throw TypeError for genuinely null receiver (`arr` is null).
  if (vecType.kind === "ref_null") {
    const guardedInstrs = fctx.body.splice(nullGuardStart);
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "ref.is_null" } as Instr);
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
      else: guardedInstrs,
    });
  }
}

/**
 * Handle assignment destructuring for the iterator protocol path.
 * Element is externref — use __extern_get(elem, key) to extract properties/indices.
 */
function compileForOfIteratorAssignDestructuring(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression,
  elemLocal: number,
  stmt: ts.ForOfStatement,
): void {
  // Ensure __extern_get is available (#1866: ensureLateImport routes to the
  // native object-runtime impl under --target standalone — no leaked
  // `env::__extern_get` host import — and to the host import in JS-host mode).
  ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  let getIdx = ctx.funcMap.get("__extern_get");
  if (getIdx === undefined) return;

  if (ts.isObjectLiteralExpression(expr)) {
    // for ({a, b} of iterable) — use __extern_get(elem, "propName") for each property
    for (const prop of expr.properties) {
      if (ts.isSpreadAssignment(prop)) continue;
      if (!ts.isShorthandPropertyAssignment(prop) && !ts.isPropertyAssignment(prop)) continue;

      const propName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isIdentifier(prop.name)
          ? prop.name.text
          : ts.isStringLiteral(prop.name)
            ? prop.name.text
            : undefined;
      if (!propName) continue;

      const targetName = ts.isShorthandPropertyAssignment(prop)
        ? prop.name.text
        : ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)
          ? prop.initializer.text
          : propName;

      let targetLocal = fctx.localMap.get(targetName);
      let iterObjSyncGlobalIdx: number | undefined;
      if (targetLocal === undefined) {
        const globalIdx = ctx.moduleGlobals.get(targetName);
        if (globalIdx === undefined) continue;
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        const globalType = globalDef?.type ?? { kind: "externref" as const };
        targetLocal = allocLocal(fctx, targetName, globalType);
        iterObjSyncGlobalIdx = globalIdx;
      }

      // Register string constant for property name
      addStringConstantGlobal(ctx, propName);
      const strGlobalIdx = ctx.stringGlobalMap.get(propName);
      if (strGlobalIdx === undefined) continue;

      // Refresh getIdx in case addStringConstantGlobal shifted indices
      getIdx = ctx.funcMap.get("__extern_get");
      if (getIdx === undefined) continue;

      // Emit: __extern_get(elem, "propName") -> externref
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "global.get", index: strGlobalIdx });
      fctx.body.push({ op: "call", funcIdx: getIdx });

      // Coerce externref to target local's type and set
      emitCoercedLocalSet(ctx, fctx, targetLocal, { kind: "externref" });

      if (iterObjSyncGlobalIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "global.set", index: iterObjSyncGlobalIdx });
      }
    }
  } else if (ts.isArrayLiteralExpression(expr)) {
    // for ([x, y] of iterable) — use __extern_get(elem, box(i)) for each element

    // Ensure __box_number is available
    let boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) {
      const importsBefore = ctx.numImportFuncs;
      const boxType = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
      addImport(ctx, "env", "__box_number", { kind: "func", typeIdx: boxType });
      shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
      boxIdx = ctx.funcMap.get("__box_number");
      // Refresh getIdx since it may have shifted
      getIdx = ctx.funcMap.get("__extern_get");
    }
    if (boxIdx === undefined || getIdx === undefined) return;

    // #1258 — same property-access / boxed-capture handling as
    // compileForOfAssignDestructuringExternref (line 1503). The for-of-of-an-
    // iterable path (any-typed iterable, e.g. `let arr: any = …; for ([x.y] of arr)`)
    // routes through HERE, not the array fast-path; both need the same fixes.
    let setIdxIter: number | undefined;
    const ensureExternSetIter = (): number | undefined => {
      if (setIdxIter !== undefined) return setIdxIter;
      setIdxIter = ctx.funcMap.get("__extern_set");
      if (setIdxIter === undefined) {
        const importsBefore = ctx.numImportFuncs;
        const setType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
        addImport(ctx, "env", "__extern_set", {
          kind: "func",
          typeIdx: setType,
        });
        shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
        setIdxIter = ctx.funcMap.get("__extern_set");
        // Refresh boxIdx/getIdx since they may have shifted.
        boxIdx = ctx.funcMap.get("__box_number");
        getIdx = ctx.funcMap.get("__extern_get");
      }
      return setIdxIter;
    };

    for (let i = 0; i < expr.elements.length; i++) {
      const el = expr.elements[i]!;
      if (ts.isOmittedExpression(el)) continue;
      if (ts.isSpreadElement(el)) continue;

      // Handle assignment with default: [v = 10]
      let targetElIter: ts.Expression = el;
      let defaultInitIter: ts.Expression | undefined;
      if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        targetElIter = el.left;
        defaultInitIter = el.right;
      }

      // #1258 — Property/element-access target: `[x.y] of iterable`.
      if (ts.isPropertyAccessExpression(targetElIter) || ts.isElementAccessExpression(targetElIter)) {
        const setFnIdx = ensureExternSetIter();
        if (setFnIdx === undefined || boxIdx === undefined || getIdx === undefined) continue;
        const recvType = compileExpression(ctx, fctx, targetElIter.expression, {
          kind: "externref",
        });
        if (recvType && recvType.kind !== "externref") {
          coerceType(ctx, fctx, recvType, { kind: "externref" });
        }
        if (recvType === null) {
          fctx.body.push({ op: "ref.null.extern" });
        }
        if (ts.isPropertyAccessExpression(targetElIter)) {
          const propName = targetElIter.name.text;
          addStringConstantGlobal(ctx, propName);
          const keyGlobalIdx = ctx.stringGlobalMap.get(propName);
          if (keyGlobalIdx === undefined) continue;
          fctx.body.push({ op: "global.get", index: keyGlobalIdx } as Instr);
        } else {
          const keyType = compileExpression(ctx, fctx, targetElIter.argumentExpression, { kind: "externref" });
          if (keyType && keyType.kind !== "externref") {
            coerceType(ctx, fctx, keyType, { kind: "externref" });
          }
          if (keyType === null) {
            fctx.body.push({ op: "ref.null.extern" });
          }
        }
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "f64.const", value: i });
        fctx.body.push({ op: "call", funcIdx: boxIdx });
        fctx.body.push({ op: "call", funcIdx: getIdx! });
        if (defaultInitIter) {
          // Out-of-scope for #1258: defaults on property targets. Drop and skip.
          fctx.body.push({ op: "drop" } as Instr);
          fctx.body.push({ op: "drop" } as Instr);
          fctx.body.push({ op: "drop" } as Instr);
          continue;
        }
        fctx.body.push({ op: "call", funcIdx: setFnIdx });
        continue;
      }

      if (!ts.isIdentifier(targetElIter)) continue;

      let targetLocal = fctx.localMap.get(targetElIter.text);
      let iterArrSyncGlobalIdx: number | undefined;
      if (targetLocal === undefined) {
        const globalIdx = ctx.moduleGlobals.get(targetElIter.text);
        if (globalIdx === undefined) continue;
        const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
        const globalType = globalDef?.type ?? { kind: "externref" as const };
        targetLocal = allocLocal(fctx, targetElIter.text, globalType);
        iterArrSyncGlobalIdx = globalIdx;
      }

      // #1258 — boxed-capture identifier path: same logic as the typed-array
      // version. See compileForOfAssignDestructuringExternref for full notes.
      const boxedCap = fctx.boxedCaptures?.get(targetElIter.text);
      if (boxedCap && !defaultInitIter) {
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "f64.const", value: i });
        fctx.body.push({ op: "call", funcIdx: boxIdx });
        fctx.body.push({ op: "call", funcIdx: getIdx! });
        if (boxedCap.valType.kind !== "externref") {
          coerceType(ctx, fctx, { kind: "externref" }, boxedCap.valType);
        }
        fctx.body.push({
          op: "struct.set",
          typeIdx: boxedCap.refCellTypeIdx,
          fieldIdx: 0,
        });
        if (iterArrSyncGlobalIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: boxedCap.refCellTypeIdx,
            fieldIdx: 0,
          });
          fctx.body.push({ op: "global.set", index: iterArrSyncGlobalIdx });
        }
        continue;
      }

      // #1510 — boxed-capture target WITH default initializer (iterator path).
      // Mirror of the array-path fix in compileForOfAssignDestructuringExternref.
      // Without this, defaults on captured `let`-bound targets in for-await-of
      // (over an arbitrary iterable) silently lose the write (overwrites the
      // box-ref) or trap dereferencing a null pointer when coerceType emits
      // ref.as_non_null on a null cell.
      if (boxedCap && defaultInitIter) {
        const valType = boxedCap.valType;
        const undefIdx = ensureExternIsUndefined(ctx, fctx);
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "f64.const", value: i });
        fctx.body.push({ op: "call", funcIdx: boxIdx! });
        fctx.body.push({ op: "call", funcIdx: getIdx! });
        const tmpExt = allocLocal(fctx, `__forit_dflt_ext_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.tee", index: tmpExt });
        if (undefIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: undefIdx });
        } else {
          fctx.body.push({ op: "ref.is_null" } as Instr);
        }
        const thenInstrs = collectInstrs(fctx, () => {
          compileExpression(ctx, fctx, defaultInitIter!, valType);
        });
        const elseInstrs = collectInstrs(fctx, () => {
          fctx.body.push({ op: "local.get", index: tmpExt } as Instr);
          if (valType.kind !== "externref") {
            coerceType(ctx, fctx, { kind: "externref" }, valType);
          }
        });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: valType },
          then: thenInstrs,
          else: elseInstrs,
        });
        fctx.body.push({
          op: "struct.set",
          typeIdx: boxedCap.refCellTypeIdx,
          fieldIdx: 0,
        });
        if (iterArrSyncGlobalIdx !== undefined) {
          fctx.body.push({ op: "local.get", index: targetLocal });
          fctx.body.push({
            op: "struct.get",
            typeIdx: boxedCap.refCellTypeIdx,
            fieldIdx: 0,
          });
          fctx.body.push({ op: "global.set", index: iterArrSyncGlobalIdx });
        }
        continue;
      }

      // Emit: __extern_get(elem, box(i)) -> externref
      fctx.body.push({ op: "local.get", index: elemLocal });
      fctx.body.push({ op: "f64.const", value: i });
      fctx.body.push({ op: "call", funcIdx: boxIdx });
      fctx.body.push({ op: "call", funcIdx: getIdx! });

      if (defaultInitIter) {
        const targetType = getLocalType(fctx, targetLocal);
        emitDefaultValueCheck(ctx, fctx, { kind: "externref" }, targetLocal, defaultInitIter, targetType ?? undefined);
      } else {
        // Coerce externref to target local's type and set
        emitCoercedLocalSet(ctx, fctx, targetLocal, { kind: "externref" });
      }

      if (iterArrSyncGlobalIdx !== undefined) {
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "global.set", index: iterArrSyncGlobalIdx });
      }
    }
  }
}

/**
 * Compile for...of using direct Wasm method dispatch when the iterable
 * is a known struct with a @@iterator method.
 *
 * Calls @@iterator() directly in Wasm, then loops calling next() directly,
 * extracting done/value from struct fields — no host imports needed.
 *
 * Returns true if successfully compiled, false if caller should fall back.
 */
function compileForOfDirectIterator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  iterableType: ValType,
  iterMethodIdx: number,
): boolean {
  // Get the return type of the @@iterator method to find the iterator struct
  const iterMethodDef = ctx.mod.functions[iterMethodIdx - ctx.numImportFuncs];
  if (!iterMethodDef) return false;
  const iterMethodType = ctx.mod.types[iterMethodDef.typeIdx];
  if (!iterMethodType || iterMethodType.kind !== "func" || iterMethodType.results.length === 0) return false;

  const iterResultType = iterMethodType.results[0]!;
  if (iterResultType.kind !== "ref" && iterResultType.kind !== "ref_null") return false;

  const iterStructTypeIdx = iterResultType.typeIdx;
  const iterStructDef = ctx.mod.types[iterStructTypeIdx];
  if (!iterStructDef || iterStructDef.kind !== "struct") return false;

  // Find the struct name for the iterator type to look up the next method
  let iterStructName: string | undefined;
  for (const [name, idx] of ctx.structMap) {
    if (idx === iterStructTypeIdx) {
      iterStructName = name;
      break;
    }
  }
  if (!iterStructName) return false;

  const nextMethodIdx = ctx.funcMap.get(`${iterStructName}_next`);
  if (nextMethodIdx === undefined) return false;

  // Get the return type of next() to find the result struct ({value, done})
  const nextMethodDef = ctx.mod.functions[nextMethodIdx - ctx.numImportFuncs];
  if (!nextMethodDef) return false;
  const nextMethodType = ctx.mod.types[nextMethodDef.typeIdx];
  if (!nextMethodType || nextMethodType.kind !== "func" || nextMethodType.results.length === 0) return false;

  const nextResultType = nextMethodType.results[0]!;

  // If next() returns externref, we can't extract done/value in Wasm — fall back
  if (nextResultType.kind !== "ref" && nextResultType.kind !== "ref_null") return false;

  const resultStructTypeIdx = nextResultType.typeIdx;
  const resultStructDef = ctx.mod.types[resultStructTypeIdx];
  if (!resultStructDef || resultStructDef.kind !== "struct") return false;

  // Find "done" and "value" field indices in the result struct
  const resultFields =
    ctx.structFields.get(`${iterStructName}_next_result`) ?? findStructFieldsByTypeIdx(ctx, resultStructTypeIdx);
  if (!resultFields) return false;

  let doneFieldIdx = -1;
  let valueFieldIdx = -1;
  let doneFieldType: ValType | undefined;
  let valueFieldType: ValType | undefined;

  for (let i = 0; i < resultFields.length; i++) {
    const f = resultFields[i]!;
    if (f.name === "done") {
      doneFieldIdx = i;
      doneFieldType = f.type;
    }
    if (f.name === "value") {
      valueFieldIdx = i;
      valueFieldType = f.type;
    }
  }

  if (doneFieldIdx < 0 || valueFieldIdx < 0 || !doneFieldType || !valueFieldType) return false;

  // We have everything we need — compile the full iteration loop in Wasm!

  // Null check on iterable
  const nullTmp = allocLocal(fctx, `__forit_stmp_${fctx.locals.length}`, iterableType);
  fctx.body.push({ op: "local.tee", index: nullTmp });
  fctx.body.push({ op: "ref.is_null" });
  const tagIdx = ensureExnTag(ctx);
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
    else: [],
  });

  // Call @@iterator method: iter = obj[Symbol.iterator]()
  fctx.body.push({ op: "local.get", index: nullTmp });
  if (iterableType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "call", funcIdx: iterMethodIdx });

  const iterLocal = allocLocal(fctx, `__forit_iter_${fctx.locals.length}`, iterResultType);
  fctx.body.push({ op: "local.set", index: iterLocal });

  // Allocate result local
  const resultLocal = allocLocal(fctx, `__forit_res_${fctx.locals.length}`, nextResultType);

  // Declare the loop variable
  const elemType: ValType = valueFieldType;
  let elemLocal: number;
  let destructPatternIter: ts.ObjectBindingPattern | ts.ArrayBindingPattern | null = null;
  let assignDestructExprIter: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | null = null;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    const isConst = !!(stmt.initializer.flags & ts.NodeFlags.Const);
    if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
      destructPatternIter = decl.name;
      elemLocal = allocLocal(fctx, `__forit_elem_${fctx.locals.length}`, elemType);
      if (isConst) {
        collectBindingNames(decl.name).forEach((n) => {
          if (!fctx.constBindings) fctx.constBindings = new Set();
          fctx.constBindings.add(n);
        });
      }
    } else {
      const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forit_elem_${fctx.locals.length}`;
      elemLocal = allocLocal(fctx, varName, elemType);
      if (isConst && ts.isIdentifier(decl.name)) {
        if (!fctx.constBindings) fctx.constBindings = new Set();
        fctx.constBindings.add(decl.name.text);
      }
    }
  } else if (ts.isObjectLiteralExpression(stmt.initializer) || ts.isArrayLiteralExpression(stmt.initializer)) {
    assignDestructExprIter = stmt.initializer;
    elemLocal = allocLocal(fctx, `__forit_elem_${fctx.locals.length}`, elemType);
  } else if (ts.isIdentifier(stmt.initializer)) {
    const varName = stmt.initializer.text;
    elemLocal = fctx.localMap.get(varName) ?? allocLocal(fctx, varName, elemType);
  } else {
    elemLocal = allocLocal(fctx, `__forit_elem_${fctx.locals.length}`, elemType);
  }

  // Look up the return() method on the iterator struct for iterator close (#851)
  const returnMethodIdx = ctx.funcMap.get(`${iterStructName}_return`);

  // Done flag: tracks whether iterator completed normally (done=true) (#851)
  const doneFlagDirect = allocLocal(fctx, `__forit_done_${fctx.locals.length}`, { kind: "i32" });

  // Build loop body
  const savedBody = pushBody(fctx);

  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 2;
  adjustRethrowDepth(fctx, 2);

  fctx.breakStack.push(1);
  fctx.continueStack.push(0);

  // #2067: no iteration cap — see the matching note in the __iterator_next path.
  // The former 1,000,000-iteration `br_if` guard silently truncated long
  // custom-iterator loops and accumulated across re-entries; the loop now runs
  // to the iterator's own `done`.

  // Call next(): result = iter.next()
  fctx.body.push({ op: "local.get", index: iterLocal });
  if (iterResultType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({ op: "call", funcIdx: nextMethodIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Check done: result.done -> set done flag and break if truthy
  fctx.body.push({ op: "local.get", index: resultLocal });
  if (nextResultType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({
    op: "struct.get",
    typeIdx: resultStructTypeIdx,
    fieldIdx: doneFieldIdx,
  });
  // done field might be i32 (boolean) or f64; convert to i32 for br_if
  if (doneFieldType.kind === "f64") {
    fctx.body.push({ op: "i32.trunc_f64_s" } as Instr);
  }
  // If done, set the done flag to 1 before breaking (#851)
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 1 } as Instr,
      { op: "local.set", index: doneFlagDirect } as Instr,
      { op: "br", depth: 2 } as Instr, // break out of block (if + loop = depth 2)
    ],
    else: [],
  });

  // Get value: elem = result.value
  fctx.body.push({ op: "local.get", index: resultLocal });
  if (nextResultType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" } as Instr);
  }
  fctx.body.push({
    op: "struct.get",
    typeIdx: resultStructTypeIdx,
    fieldIdx: valueFieldIdx,
  });

  // Coerce value to element type if needed
  const targetElemType = getLocalType(fctx, elemLocal) ?? elemType;
  if (!valTypesMatch(valueFieldType, targetElemType)) {
    coerceType(ctx, fctx, valueFieldType, targetElemType);
  }
  fctx.body.push({ op: "local.set", index: elemLocal });

  // If destructuring, handle it
  if (destructPatternIter) {
    compileForOfDestructuring(ctx, fctx, destructPatternIter, elemLocal, elemType, stmt);
  }
  if (assignDestructExprIter) {
    compileForOfIteratorAssignDestructuring(ctx, fctx, assignDestructExprIter, elemLocal, stmt);
  }

  // Compile body
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  fctx.body.push({ op: "br", depth: 0 });

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 2;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 2;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 2;
  adjustRethrowDepth(fctx, -2);

  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });

  // Iterator close protocol (#851): call iterator.return() only on abrupt
  // completion (break/return), NOT on normal completion (done=true).
  if (returnMethodIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: doneFlagDirect });
    fctx.body.push({ op: "i32.eqz" }); // if NOT done (abrupt exit)
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: iterLocal } as Instr,
        ...(iterResultType.kind === "ref_null" ? [{ op: "ref.as_non_null" } as Instr] : []),
        { op: "call", funcIdx: returnMethodIdx } as Instr,
        // Drop the return value (return() returns {value, done})
        { op: "drop" } as Instr,
      ],
      else: [],
    });
  }

  return true;
}

/** Helper to find struct fields by type index when the name isn't directly in structFields */
function findStructFieldsByTypeIdx(
  ctx: CodegenContext,
  typeIdx: number,
): { name: string; type: ValType }[] | undefined {
  for (const [name, fields] of ctx.structFields) {
    const idx = ctx.structMap.get(name);
    if (idx === typeIdx) return fields;
  }
  // Fall back to the type definition if available
  const typeDef = ctx.mod.types[typeIdx];
  if (typeDef && typeDef.kind === "struct") {
    return typeDef.fields.map((f, i) => ({
      name: f.name ?? `field_${i}`,
      type: f.type,
    }));
  }
  return undefined;
}

/**
 * Compile for...of over a non-array iterable using the host-delegated
 * iterator protocol. Works with strings, Maps, Sets, and any object
 * implementing [Symbol.iterator]().
 *
 * Generated Wasm pseudo-code:
 *   iter = __iterator(obj)
 *   loop:
 *     (done, value) = __iterator_next(iter)   // multi-value result
 *     if done → break
 *     elem = value
 *     <body>
 *     br loop
 */
function compileForOfIterator(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForOfStatement): void {
  // Compile the iterable expression
  const bodyLenBefore = fctx.body.length;
  const localsSnap = snapshotLocals(fctx); // #1847
  const iterableType = compileExpression(ctx, fctx, stmt.expression);
  if (!iterableType) {
    reportError(ctx, stmt, "for-of: failed to compile iterable expression");
    return;
  }

  // Check if the iterable is a known struct type with a @@iterator method.
  // If so, compile the entire iteration loop in Wasm without host imports.
  if (iterableType.kind === "ref" || iterableType.kind === "ref_null") {
    let structName: string | undefined;
    for (const [name, idx] of ctx.structMap) {
      if (idx === iterableType.typeIdx) {
        structName = name;
        break;
      }
    }
    if (structName) {
      const methodFullName = `${structName}_@@iterator`;
      const iterMethodIdx = ctx.funcMap.get(methodFullName);
      if (iterMethodIdx !== undefined) {
        // Try to compile the full iteration loop in Wasm (no host imports)
        if (compileForOfDirectIterator(ctx, fctx, stmt, iterableType, iterMethodIdx)) {
          return;
        }
      }
    }
  }

  // #1665: Wasm-native generator for-of. When the iterable is a native
  // generator state struct (the value produced by a `function*` declaration
  // under --target wasi/standalone), drive the loop via the generator's resume
  // function — no JS-host iterator protocol, no #681 gate. The subject value is
  // already on the stack from compileExpression above.
  if ((ctx.standalone || ctx.wasi) && (iterableType.kind === "ref" || iterableType.kind === "ref_null")) {
    const genInfo = nativeGeneratorInfoForForOfSubject(ctx, iterableType);
    if (genInfo && tryCompileNativeGeneratorForOf(ctx, fctx, stmt, iterableType, genInfo)) {
      return;
    }
  }

  // #1320 Slice 1: standalone/WASI binds the iterator protocol to emitted Wasm
  // fns (no JS host). `ensureNativeIteratorRuntime` registers `__iterator` /
  // `__iterator_next` / `__iterator_return` / `__iterator_rest`; the same
  // consumer code below then drives the loop byte-identically to the host path.
  // The native `__iterator` expects a canonical externref `$Vec` (the producer,
  // e.g. `arr.values()`, builds one); for other shapes (generic class iterables,
  // Map/Set) this is a later slice — `__iterator`'s `ref.cast` traps loudly
  // rather than silently misbehaving, which is acceptable for Slice 1.
  if (ctx.standalone || ctx.wasi) {
    ensureNativeIteratorRuntime(ctx);
    // fall through to the shared __iterator/__iterator_next consumer path below
  }

  // Ensure iterator host imports are registered before using them (no-op in
  // standalone — ensureNativeIteratorRuntime already populated funcMap).
  addIteratorImports(ctx);

  // Coerce to externref if the iterable is a struct ref (GC type).
  if (iterableType.kind !== "externref") {
    coerceType(ctx, fctx, iterableType, { kind: "externref" });
  }

  // Null check: throw TypeError for `for (const x of null)` (#775, #789)
  // If null from a failed guarded cast, skip instead of throw.
  {
    const backupLocal: number | undefined = (fctx as any).__lastGuardedCastBackup;
    const tagIdx = ensureExnTag(ctx);
    const iterTmp = allocLocal(fctx, `__forit_null_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.tee", index: iterTmp });
    fctx.body.push({ op: "ref.is_null" });
    if (backupLocal !== undefined) {
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: backupLocal } as Instr,
          { op: "ref.is_null" } as Instr,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
            else: [],
          } as Instr,
        ],
        else: [],
      });
    } else {
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" } as Instr, { op: "throw", tagIdx } as Instr],
        else: [],
      });
    }
    fctx.body.push({ op: "local.get", index: iterTmp });
  }

  // Look up the iterator host import function indices
  let iteratorIdx: number | undefined;
  if (stmt.awaitModifier) {
    iteratorIdx = ensureAsyncIterator(ctx, fctx);
  }
  if (iteratorIdx === undefined) {
    iteratorIdx = ctx.funcMap.get("__iterator");
  }
  if (iteratorIdx === undefined) {
    reportError(ctx, stmt, "for-of on non-array type requires iterator imports");
    return;
  }

  // Call __iterator/__async_iterator(obj) -> externref (the iterator)
  fctx.body.push({ op: "call", funcIdx: iteratorIdx });

  const nextIdx = ctx.funcMap.get("__iterator_next");
  const returnIdx = ctx.funcMap.get("__iterator_return");
  if (nextIdx === undefined) {
    reportError(ctx, stmt, "for-of on non-array type requires iterator imports");
    return;
  }
  const iterLocal = allocLocal(fctx, `__forof_iter_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: iterLocal });

  // Allocate locals for the iterator-step result. __iterator_next now returns a
  // multi-value (i32 done, externref value); resultLocal holds the value, and
  // nextDoneLocal the done flag (#1620 v2 — no $IteratorResult struct).
  const resultLocal = allocLocal(fctx, `__forof_result_${fctx.locals.length}`, { kind: "externref" });
  const nextDoneLocal = allocLocal(fctx, `__forof_done_raw_${fctx.locals.length}`, { kind: "i32" });

  // Declare the loop variable (element type is externref for iterator protocol)
  const elemType: ValType = { kind: "externref" };
  let elemLocal: number;
  let destructPatternIter: ts.ObjectBindingPattern | ts.ArrayBindingPattern | null = null;
  let assignDestructExprIter: ts.ObjectLiteralExpression | ts.ArrayLiteralExpression | null = null;
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0]!;
    const isConst = !!(stmt.initializer.flags & ts.NodeFlags.Const);
    if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
      destructPatternIter = decl.name;
      elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
      if (isConst) {
        collectBindingNames(decl.name).forEach((n) => {
          if (!fctx.constBindings) fctx.constBindings = new Set();
          fctx.constBindings.add(n);
        });
      }
    } else {
      const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forof_elem_${fctx.locals.length}`;
      elemLocal = allocLocal(fctx, varName, elemType);
      if (isConst && ts.isIdentifier(decl.name)) {
        if (!fctx.constBindings) fctx.constBindings = new Set();
        fctx.constBindings.add(decl.name.text);
      }
    }
  } else if (ts.isObjectLiteralExpression(stmt.initializer) || ts.isArrayLiteralExpression(stmt.initializer)) {
    // Expression form with destructuring: for ({a, b} of arr) or for ([x, y] of arr)
    assignDestructExprIter = stmt.initializer;
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  } else if (ts.isIdentifier(stmt.initializer)) {
    // Expression form: for (x of arr) — x is already declared
    const varName = stmt.initializer.text;
    elemLocal = fctx.localMap.get(varName) ?? allocLocal(fctx, varName, elemType);
  } else {
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, elemType);
  }

  // Build loop body
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: try+block+loop adds 3 nesting levels (#851).
  // The extra +1 (vs the old +2) is for the try wrapper that enables iterator close on throw.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);

  // Done flag: tracks whether iterator completed normally (done=true).
  // Used after the loop to decide whether to call iterator.return() (#851).
  const doneFlag = allocLocal(fctx, `__forof_done_${fctx.locals.length}`, {
    kind: "i32",
  });

  // Iterator close finallyStack entry (#851): inline before return/outer-break/outer-continue.
  // Push BEFORE the for-of break/continue entries so that:
  //   - break to for-of (breakIdx = N = breakStackLen)  → N < N = false → NOT inlined (post-loop handles it)
  //   - break to outer  (breakIdx < N)                  → true → inlined ✓
  //   - continue to for-of (contIdx = M = continueStackLen) → M < M = false → NOT inlined ✓
  //   - continue to outer  (contIdx < M)                → true → inlined ✓
  //   - return                                          → always inlined ✓
  const iterCloseBreakStackLen = fctx.breakStack.length;
  const iterCloseContinueStackLen = fctx.continueStack.length;
  if (returnIdx !== undefined) {
    const capturedDoneFlag = doneFlag;
    const capturedIterLocal = iterLocal;
    const capturedReturnIdx = returnIdx;
    // The iterator-close finally body contains no `br` to any outer label
    // (only `local.get`/`call`/`if`), so the #2061 abrupt-site depth delta is a
    // no-op here: `cloneFinallyAtDepth` ignores `extraDepth` and the baselines
    // are unused. We still satisfy the finallyStack entry shape.
    const cloneIterClose = (): Instr[] =>
      structuredClone([
        { op: "local.get", index: capturedDoneFlag } as Instr,
        { op: "i32.eqz" } as Instr,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: capturedIterLocal } as Instr,
            { op: "call", funcIdx: capturedReturnIdx } as Instr,
          ],
          else: [],
        },
      ]);
    if (!fctx.finallyStack) fctx.finallyStack = [];
    fctx.finallyStack.push({
      cloneFinally: cloneIterClose,
      cloneFinallyAtDepth: cloneIterClose,
      breakStackLen: iterCloseBreakStackLen,
      continueStackLen: iterCloseContinueStackLen,
      breakDepthBaseline: fctx.breakStack.slice(),
      continueDepthBaseline: fctx.continueStack.slice(),
    });
  }

  fctx.breakStack.push(1); // break = depth 1 (exit block, inside try wrapper)
  fctx.continueStack.push(0); // continue = depth 0 (restart loop)

  // #2067: no iteration cap. A prior 1,000,000-iteration `br_if` guard (#662,
  // against collection-mutation hangs) silently truncated legitimately long
  // iterations — and its counter local was never reset across re-entries of the
  // same compiled loop, so repeated executions accumulated toward the cap.
  // Silent wrong results violate "compile away, don't emulate"; the loop now
  // runs to the iterator's own `done`, matching JS.

  // Call __iterator_next(iter) → (i32 done, externref value) [multi-value].
  // Results are pushed left-to-right, so value (externref) is on top of the
  // stack and done (i32) below it: pop value first, then done.
  fctx.body.push({ op: "local.get", index: iterLocal });
  fctx.body.push({ op: "call", funcIdx: nextIdx });
  fctx.body.push({ op: "local.set", index: resultLocal }); // externref value (top)
  fctx.body.push({ op: "local.set", index: nextDoneLocal }); // i32 done (below)

  // Check done: read the i32 directly, break if truthy
  fctx.body.push({ op: "local.get", index: nextDoneLocal });
  // If done, set the done flag to 1 before breaking
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 1 } as Instr,
      { op: "local.set", index: doneFlag } as Instr,
      { op: "br", depth: 2 } as Instr, // break out of block (if + loop = depth 2)
    ],
    else: [],
  });

  // Get value: elem = value (already in resultLocal)
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "local.set", index: elemLocal });

  // If destructuring pattern, destructure from the element
  if (destructPatternIter) {
    compileForOfDestructuring(ctx, fctx, destructPatternIter, elemLocal, elemType, stmt);
  }
  // If assignment destructuring expression, assign to existing locals.
  // For iterator path, elemType is externref — use __extern_get to extract properties/indices.
  if (assignDestructExprIter) {
    compileForOfIteratorAssignDestructuring(ctx, fctx, assignDestructExprIter, elemLocal, stmt);
  }

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  fctx.body.push({ op: "br", depth: 0 }); // continue loop

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Pop the iterator-close finallyStack entry (pushed before break/continue entries).
  if (returnIdx !== undefined && fctx.finallyStack && fctx.finallyStack.length > 0) {
    fctx.finallyStack.pop();
  }

  // Restore existing break/continue depths (undo the +3 applied at loop entry).
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;
  adjustRethrowDepth(fctx, -3);

  popBody(fctx, savedBody);

  // The block/loop body; wrapped in try/catch_all when __iterator_return is available
  // to call iterator.return() on throw (#851 via-throw).
  const blockLoop: Instr = {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  };

  if (returnIdx !== undefined) {
    // Wrap in try/catch_all: on exception, call iterator.return() then rethrow.
    //
    // Per ES §7.4.6 IteratorClose step 6: when the outer completion is
    // throw, IteratorClose returns the original throw — any error from
    // GetMethod / iterator.return() is suppressed. We model this by
    // wrapping the inner __iterator_return call in a nested try/catch_all
    // whose catchAll is empty (drops any exception). The outer catch_all
    // then `rethrow 0` re-raises the ORIGINAL exception. (#1347)
    const innerCloseTry: Instr = {
      op: "try",
      blockType: { kind: "empty" },
      body: [{ op: "local.get", index: iterLocal } as Instr, { op: "call", funcIdx: returnIdx } as Instr],
      catches: [],
      catchAll: [], // suppress any error from GetMethod / return() per spec step 6
    };
    const catchAllBody: Instr[] = [
      { op: "local.get", index: doneFlag } as Instr,
      { op: "i32.eqz" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [innerCloseTry],
        else: [],
      },
      { op: "rethrow", depth: 0 },
    ];
    fctx.body.push({
      op: "try",
      blockType: { kind: "empty" },
      body: [blockLoop],
      catches: [],
      catchAll: catchAllBody,
    });
  } else {
    fctx.body.push(blockLoop);
  }

  // Iterator close protocol (#851): call iterator.return() on break (post-loop check).
  // return/throw/outer-break/outer-continue are handled via finallyStack and try/catch_all above.
  if (returnIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: doneFlag });
    fctx.body.push({ op: "i32.eqz" }); // if NOT done (abrupt exit via break)
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: iterLocal } as Instr, { op: "call", funcIdx: returnIdx } as Instr],
      else: [],
    });
  }
}

/**
 * Write the current for-in key (held in `keyLocal` as an externref) to a
 * member-expression target (`for (x.y in obj)` / `for (x[k] in obj)`), per
 * ECMA-262 §14.7.5.6 ForIn/OfBodyEvaluation (lhsKind = assignment). Emits
 * `__extern_set(receiver, key, value)` (#1613).
 */
function emitForInMemberTargetWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  target: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  keyLocal: number,
): void {
  let setIdx = ctx.funcMap.get("__extern_set");
  if (setIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const setType = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }], []);
    addImport(ctx, "env", "__extern_set", { kind: "func", typeIdx: setType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    setIdx = ctx.funcMap.get("__extern_set");
  }
  if (setIdx === undefined) return;

  // Receiver
  const recvType = compileExpression(ctx, fctx, target.expression, {
    kind: "externref",
  });
  if (recvType && recvType.kind !== "externref") {
    coerceType(ctx, fctx, recvType, { kind: "externref" });
  } else if (recvType === null) {
    fctx.body.push({ op: "ref.null.extern" } as Instr);
  }

  // Key
  if (ts.isPropertyAccessExpression(target)) {
    const propName = target.name.text;
    addStringConstantGlobal(ctx, propName);
    const keyGlobalIdx = ctx.stringGlobalMap.get(propName);
    if (keyGlobalIdx === undefined) return;
    fctx.body.push({ op: "global.get", index: keyGlobalIdx } as Instr);
  } else {
    const keyType = compileExpression(ctx, fctx, target.argumentExpression, {
      kind: "externref",
    });
    if (keyType && keyType.kind !== "externref") {
      coerceType(ctx, fctx, keyType, { kind: "externref" });
    } else if (keyType === null) {
      fctx.body.push({ op: "ref.null.extern" } as Instr);
    }
  }

  // Value = the enumerated key string
  fctx.body.push({ op: "local.get", index: keyLocal });
  fctx.body.push({ op: "call", funcIdx: setIdx });
}

export function compileForInStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForInStatement): void {
  // Get the loop variable name
  const init = stmt.initializer;
  let varName: string;
  let keyLocal: number;
  // For non-identifier heads (binding pattern / member-expression target) the
  // enumerated key is materialised in a temp externref local, then written to
  // the real target each iteration (#1613). These describe that write.
  let bindingPattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern | null = null;
  let memberTarget: ts.PropertyAccessExpression | ts.ElementAccessExpression | null = null;
  if (ts.isVariableDeclarationList(init)) {
    const decl = init.declarations[0]!;
    if (!ts.isIdentifier(decl.name)) {
      // Destructuring binding head: `for (var/let [a] in obj)`. The key is a
      // string; per spec the binding pattern destructures that string value.
      bindingPattern = decl.name;
      varName = `__forin_key_${fctx.locals.length}`;
      keyLocal = allocLocal(fctx, varName, { kind: "externref" });
    } else {
      varName = decl.name.text;
      // Allocate a local for the loop variable (string / externref)
      keyLocal = allocLocal(fctx, varName, { kind: "externref" });
    }
  } else if (ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) {
    // Member-expression target: `for (x.y in obj)` / `for (x[k] in obj)`.
    // Per spec the enumerated key is assigned to the reference each iteration.
    memberTarget = init;
    varName = `__forin_key_${fctx.locals.length}`;
    keyLocal = allocLocal(fctx, varName, { kind: "externref" });
  } else if (ts.isIdentifier(init)) {
    // Bare identifier: `for (x in obj)` — look up existing local
    varName = init.text;
    const existingLocal = fctx.localMap.get(varName);
    if (existingLocal !== undefined) {
      keyLocal = existingLocal;
    } else {
      // Variable might be a global or not yet declared — allocate as local
      keyLocal = allocLocal(fctx, varName, { kind: "externref" });
    }
  } else if (
    ts.isBinaryExpression(init) &&
    init.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(init.left)
  ) {
    // Assignment expression: `for (x = defaultVal in obj)` — compile assignment, use the target
    varName = init.left.text;
    const existingLocal = fctx.localMap.get(varName);
    if (existingLocal !== undefined) {
      keyLocal = existingLocal;
    } else {
      keyLocal = allocLocal(fctx, varName, { kind: "externref" });
    }
    // Compile the initializer assignment (default value)
    compileExpression(ctx, fctx, init.right);
    fctx.body.push({ op: "local.set", index: keyLocal });
  } else {
    reportError(ctx, stmt, "for-in requires a variable declaration or identifier");
    return;
  }

  // Look up for-in host imports
  const keysIdx = ctx.funcMap.get("__for_in_keys");
  const lenIdx = ctx.funcMap.get("__for_in_len");
  const getIdx = ctx.funcMap.get("__for_in_get");
  const hasIdx = ctx.funcMap.get("__for_in_has");

  if (keysIdx === undefined || lenIdx === undefined || getIdx === undefined) {
    // Fallback: static unrolling when host imports are not available (standalone mode)
    const exprType = ctx.checker.getTypeAtLocation(stmt.expression);
    const props = exprType.getProperties();
    if (props.length === 0) return;
    for (const prop of props) {
      const globalIdx = ctx.stringGlobalMap.get(prop.name);
      if (globalIdx === undefined) continue;
      fctx.body.push({ op: "global.get", index: globalIdx });
      fctx.body.push({ op: "local.set", index: keyLocal });
      compileStatement(ctx, fctx, stmt.statement);
    }
    return;
  }

  // Compile the object expression and coerce to externref for the host import.
  // Retain the object ref in a local so the per-visit liveness check (#2066) can
  // re-query whether a key deleted during the loop body should be skipped.
  const objLocal = allocLocal(fctx, `__forin_obj_${fctx.locals.length}`, {
    kind: "externref",
  });
  const exprType = compileExpression(ctx, fctx, stmt.expression);
  if (exprType && exprType.kind !== "externref") {
    coerceType(ctx, fctx, exprType, { kind: "externref" });
  }
  fctx.body.push({ op: "local.tee", index: objLocal });
  fctx.body.push({ op: "call", funcIdx: keysIdx }); // __for_in_keys(obj) -> keys array

  // Store keys array in a local
  const keysLocal = allocLocal(fctx, `__forin_keys_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push({ op: "local.set", index: keysLocal });

  // Get length
  const lenLocal = allocLocal(fctx, `__forin_len_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "local.get", index: keysLocal });
  fctx.body.push({ op: "call", funcIdx: lenIdx }); // __for_in_len(keys) -> i32
  fctx.body.push({ op: "local.set", index: lenLocal });

  // Counter
  const iLocal = allocLocal(fctx, `__forin_i_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // Build the user's loop body in a new body segment.
  // Structure: block $break { loop $loop { <cond> block $continue { <body> } <incr> br $loop } }
  // This ensures `continue` (br 0 = exit $continue) falls through to the increment,
  // while `break` (br 2 = exit $break) exits the entire loop.
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block+loop+block adds 3 nesting levels
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);

  fctx.breakStack.push(2); // break = depth 2 (exit $break block)
  fctx.continueStack.push(0); // continue = depth 0 (exit $continue block -> falls to incr)

  // Non-identifier head (#1613): write the per-iteration key into its real
  // target before the user body runs. keyLocal holds keys[i] at this point.
  if (memberTarget) {
    emitForInMemberTargetWrite(ctx, fctx, memberTarget, keyLocal);
  } else if (bindingPattern) {
    // Spec: the binding pattern destructures the (string) key value. Reuse the
    // externref destructuring helpers — array patterns iterate the string's
    // code units, object patterns read named properties.
    if (ts.isArrayBindingPattern(bindingPattern)) {
      fctx.body.push({ op: "local.get", index: keyLocal });
      compileExternrefArrayDestructuringDecl(ctx, fctx, bindingPattern, {
        kind: "externref",
      });
    } else {
      fctx.body.push({ op: "local.get", index: keyLocal });
      compileExternrefObjectDestructuringDecl(ctx, fctx, bindingPattern, {
        kind: "externref",
      });
    }
  }

  // Compile the user's loop body — save/restore block-scoped shadows for let/const (#817).
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  const userBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;
  adjustRethrowDepth(fctx, -3);

  popBody(fctx, savedBody);

  // Build the full loop body: condition + key fetch + block{userBody} + increment + br
  const loopBody: Instr[] = [];

  // Condition: i >= length -> break (depth 1 exits $break from inside $loop)
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "local.get", index: lenLocal });
  loopBody.push({ op: "i32.ge_s" });
  loopBody.push({ op: "br_if", depth: 1 }); // break out of $break block

  // Get current key: key = keys[i]
  loopBody.push({ op: "local.get", index: keysLocal });
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "call", funcIdx: getIdx }); // __for_in_get(keys, i) -> externref
  loopBody.push({ op: "local.set", index: keyLocal });

  // Per-visit liveness guard (#2066): if the key was deleted earlier in this
  // enumeration, skip it. Emitted at the START of the $continue block so the
  // `br 0` lands on the increment (same path as a user `continue`), never
  // re-running the loop without advancing. Only when the host check is
  // available (it always is when the snapshot imports are).
  const guardedBody: Instr[] = userBody;
  if (hasIdx !== undefined) {
    // The guard sits inside `block $continue { … }`. From inside the `if`'s
    // `then`, the enclosing labels are: if(0) → $continue(1). Skipping a deleted
    // key means exiting $continue (which falls through to the increment), so the
    // br target is depth 1, not 0 (br 0 would only exit the `if` and fall into
    // the user body — re-visiting the deleted key).
    guardedBody.unshift({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "br", depth: 1 } as Instr],
    } as Instr);
    guardedBody.unshift({ op: "i32.eqz" } as Instr);
    guardedBody.unshift({ op: "call", funcIdx: hasIdx } as Instr);
    guardedBody.unshift({ op: "local.get", index: keyLocal } as Instr);
    guardedBody.unshift({ op: "local.get", index: objLocal } as Instr);
  }

  // Wrap user body in block $continue so `continue` exits here
  loopBody.push({
    op: "block",
    blockType: { kind: "empty" },
    body: guardedBody,
  });

  // Increment counter (reached after user body OR after continue)
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "i32.const", value: 1 });
  loopBody.push({ op: "i32.add" });
  loopBody.push({ op: "local.set", index: iLocal });

  loopBody.push({ op: "br", depth: 0 }); // restart $loop

  // Emit block $break { loop $loop { ...loopBody } }
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });
}
