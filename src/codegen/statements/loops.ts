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
import { allocLocal, getLocalType } from "../context/locals.js";
import { snapshotSpeculative, rollbackSpeculative } from "../context/speculative.js";
import type { CodegenContext, FunctionContext, HoistedCharRead } from "../context/types.js";
import { emitExternrefDestructureGuard, emitObjectPatternRestFromVec } from "../destructuring-params.js";
import {
  emitAssignToTarget,
  findUnresolvableInArrayPattern,
  findUnresolvableInObjectPattern,
  isStrictContext,
} from "../expressions/assignment.js";
import { emitCoercedLocalSet, emitThrowTypeError } from "../expressions/helpers.js";
import { ensureLateImport, flushLateImportShifts, shiftLateImportIndices } from "../expressions/late-imports.js";
import { arrayIteratorOverrideGlobalIdx } from "../expressions/proto-override.js";
import { reportSilentFallback } from "../fallback-telemetry.js";
import { nativeGeneratorInfoForForOfSubject, tryCompileNativeGeneratorForOf } from "../generators-native.js";
import {
  addIteratorImports,
  ensureI32Condition,
  ensureNativeStringHelpers,
  nativeStringType,
  resolveWasmType,
} from "../index.js";
import { ensureNativeIteratorRuntime } from "../iterator-native.js";
import { containsLinearU8Allocation, emitLinearU8ArenaMark, linearU8ArenaResetInstrs } from "../linear-uint8-arena.js";
import { resolveComputedKeyExpression } from "../literals.js";
import { emitCollectionIteratorVec, ensureMapHelpers, MAP_LAYOUT } from "../map-runtime.js";
import { elemGetOp, resolveArrayInfo, typedArraySearchSignedness, unpackedElemType } from "../array-methods.js";
import { flatStringType, stringConstantExternrefInstrs } from "../native-strings.js";
import { emitNativeNumberFormat } from "../number-format-native.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { coercionInstrs } from "../type-coercion.js";
import { addImport, addStringConstantGlobal, ensureExnTag, localGlobalIdx } from "../registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterRefCellType } from "../registry/types.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  emitBoundsCheckedArrayGet,
  valTypesMatch,
} from "../shared.js";
import {
  arrayDstrNeedsIdentity,
  compileArrayDestructuring,
  compileExternrefArrayDestructuringDecl,
  compileExternrefObjectDestructuringDecl,
  compileObjectDestructuring,
  emitDefaultValueCheck,
  emitNestedBindingDefault,
  emitNullGuard,
  ensureAsyncIterator,
  ensureExternIsUndefined,
  syncDestructuredLocalsToGlobals,
  tryEmitArrayProtoIteratorReadDrive,
} from "./destructuring.js";
import { adjustRethrowDepth, collectInstrs, restoreBlockScopedShadows, saveBlockScopedShadows } from "./shared.js";
import { collectPatternBindingNames } from "./tdz.js";
import { emitHoleToUndefined } from "../array-holes.js"; // (#2001 S1)
import { definedFuncAt } from "../func-space.js"; // (#1916 S2) positional-read chokepoint

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
// #2766 — exported so the IR `lowerForStatement` (src/ir/from-ast.ts) can reuse
// the exact same counted-loop non-mutation proof when porting the
// `safeIndexedArrays` in-bounds proof into the IR.
export function loopBodyMutatesIndexOrArray(body: ts.Statement, indexName: string, arrayName: string): boolean {
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
 * #2682: the increment must strictly INCREASE `i` so that, combined with a
 * non-negative init and the strict `i < recv.length` condition, `0 <= i < len`
 * holds at every body point. `i++`/`++i` and `i += <positive int literal>`
 * qualify; `i--`/`i -= k`/`i += <non-positive>` do NOT (would break the proof).
 * Narrower than `detectI32LoopVar`'s incrementor check, which also accepts the
 * decreasing forms.
 */
// #2766 — exported so the IR `lowerForStatement` reuses the same strictly-
// increasing-step check when discharging the counted-loop in-bounds proof.
export function isIncreasingStep(incr: ts.Expression | undefined, name: string): boolean {
  if (!incr) return false;
  if (ts.isPostfixUnaryExpression(incr) || ts.isPrefixUnaryExpression(incr)) {
    return ts.isIdentifier(incr.operand) && incr.operand.text === name && incr.operator === ts.SyntaxKind.PlusPlusToken;
  }
  if (ts.isBinaryExpression(incr)) {
    if (!ts.isIdentifier(incr.left) || incr.left.text !== name) return false;
    if (incr.operatorToken.kind !== ts.SyntaxKind.PlusEqualsToken) return false;
    if (!ts.isNumericLiteral(incr.right)) return false;
    const step = Number(incr.right.text.replace(/_/g, ""));
    return Number.isInteger(step) && step > 0;
  }
  return false;
}

/**
 * #2682: string-specific variant of {@link loopBodyMutatesIndexOrArray} for the
 * canonical read-loop hoist. Returns true if the body could invalidate the
 * loop-invariance of `recvName` or the in-bounds invariant of `indexName`.
 *
 * Strings are IMMUTABLE, so — unlike the #1196 array helper — method calls on
 * the receiver (notably `recv.charCodeAt(i)`, the whole point) are SAFE and must
 * NOT disqualify. Only these break the invariants:
 *   - assignment / compound-assignment / `++`/`--` to `recvName` or `indexName`;
 *   - a body-local declaration that SHADOWS `recvName` or `indexName` — the
 *     downstream `recv.charCodeAt(i)` match keys on identifier TEXT, so a shadow
 *     (`for (…) { let recv = other; … recv.charCodeAt(i) … }`) would wrongly read
 *     the hoisted OUTER descriptor. Reject any such shadow (sound, conservative);
 *   - any nested function / arrow / class (could capture and reassign either
 *     binding via a call we can't statically see — conservative, matches #1196).
 */
function loopBodyMutatesStringReadInvariants(body: ts.Statement, indexName: string, recvName: string): boolean {
  let mutates = false;
  const declaresShadow = (name: ts.BindingName | undefined): boolean => {
    if (!name) return false;
    for (const n of collectPatternBindingNames(name)) {
      if (n === indexName || n === recvName) return true;
    }
    return false;
  };
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
    if (ts.isBinaryExpression(node) && isAssignmentOp(node.operatorToken.kind)) {
      const lhs = node.left;
      if (ts.isIdentifier(lhs) && (lhs.text === indexName || lhs.text === recvName)) {
        mutates = true;
        return;
      }
    }
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand) &&
      (node.operand.text === indexName || node.operand.text === recvName)
    ) {
      mutates = true;
      return;
    }
    // Body-local declaration shadowing recv/i — see the doc comment.
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
      declaresShadow(node.name)
    ) {
      mutates = true;
      return;
    }
    if (ts.isCatchClause(node) && declaresShadow(node.variableDeclaration?.name)) {
      mutates = true;
      return;
    }
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
 * #2682: true iff the body contains at least one `recvName.charCodeAt(indexName)`
 * read (exact receiver + induction identifier). Gating the hoist on this keeps
 * codegen byte-identical for string loops that never read a char by the
 * induction var, and avoids emitting a dead `__str_flatten` + descriptor hoist.
 */
function bodyHasMatchingCharRead(body: ts.Statement, recvName: string, indexName: string): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (found) return;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "charCodeAt" &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === recvName &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0]!) &&
      (node.arguments[0] as ts.Identifier).text === indexName
    ) {
      found = true;
      return;
    }
    forEachChild(node, visit);
  }
  visit(body);
  return found;
}

/**
 * #2682: recognise the canonical string-read hot loop
 * `for (let i = <non-neg int>; i < recv.length; i++/+=k) … recv.charCodeAt(i) …`
 * and, when matched, hoist the loop-invariant `__str_flatten(recv)` + its
 * `.data`/`.off` descriptor into fresh locals emitted ONCE before the loop.
 * Returns the in-bounds proof to install on `fctx.hoistedCharReads`, or null
 * (emitting nothing) on any deviation — refuse-loud, never miscompile.
 *
 * Native-string mode only: host/externref strings have no flattenable
 * descriptor (charCodeAt is a host call there), so the receiver isn't a
 * `$NativeString` struct and this never fires.
 *
 * Soundness of dropping the OOB/NaN branch at the read sites (R1): `init >= 0`
 * + strict `<` + monotonic increase + `i`/`recv` not mutated in the body (and
 * no capturing closure) ⇒ `0 <= i < len` at every `recv.charCodeAt(i)`. The
 * read can never be out of range, so the NaN branch is dead and the direct
 * `array.get_u` is byte-identical to the guarded read.
 *
 * MUST be called while `fctx.body` is the OUTER body (before `pushBody`) so the
 * hoisted descriptor setup runs exactly once, before the loop.
 */
function detectCanonicalCharReadLoop(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForStatement,
): HoistedCharRead | null {
  // Native-string mode only.
  if (!ctx.nativeStrings || ctx.nativeStrTypeIdx < 0 || ctx.nativeStrDataTypeIdx < 0) return null;
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  if (flattenIdx === undefined) return null;

  // Induction var: reuse detectI32LoopVar (same shape the i32-promotion uses),
  // then add the strictly-increasing-from-non-negative constraints it lacks.
  const i32Loop = detectI32LoopVar(stmt);
  if (!i32Loop) return null;
  const indexName = i32Loop.name;
  if (i32Loop.initValue < 0) return null; // i must start >= 0
  if (!isIncreasingStep(stmt.incrementor, indexName)) return null;

  // Condition must be exactly `i < recv.length` (strict <, index on the left).
  if (!stmt.condition || !ts.isBinaryExpression(stmt.condition)) return null;
  const cond = stmt.condition;
  if (cond.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return null;
  if (!ts.isIdentifier(cond.left) || cond.left.text !== indexName) return null;
  if (!ts.isPropertyAccessExpression(cond.right) || cond.right.name.text !== "length") return null;
  if (!ts.isIdentifier(cond.right.expression)) return null;
  const recvIdent = cond.right.expression;
  const recvName = recvIdent.text;

  // recv must be a (native) string — not any/union/array.
  if (!isStringType(ctx.checker.getTypeAtLocation(recvIdent))) return null;

  // Loop-invariance + induction-in-bounds: no mutation of recv/i, no closures.
  if (loopBodyMutatesStringReadInvariants(stmt.statement, indexName, recvName)) return null;

  // Only hoist if the body actually reads `recv.charCodeAt(i)` at least once.
  if (!bodyHasMatchingCharRead(stmt.statement, recvName, indexName)) return null;

  // --- Emit the hoist into the OUTER body (runs once, before the loop) ---
  ensureNativeStringHelpers(ctx); // idempotent; __str_flatten already present
  const flatTmp = allocLocal(fctx, `__cca_flat_${fctx.locals.length}`, flatStringType(ctx));
  const dataLocal = allocLocal(fctx, `__cca_data_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ctx.nativeStrDataTypeIdx,
  });
  const offLocal = allocLocal(fctx, `__cca_off_${fctx.locals.length}`, { kind: "i32" });

  compileExpression(ctx, fctx, recvIdent); // push recv (ref $AnyString)
  fctx.body.push({ op: "call", funcIdx: ctx.nativeStrHelpers.get("__str_flatten")! });
  fctx.body.push({ op: "local.set", index: flatTmp });
  fctx.body.push({ op: "local.get", index: flatTmp });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 2 }); // .data
  fctx.body.push({ op: "local.set", index: dataLocal });
  fctx.body.push({ op: "local.get", index: flatTmp });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.nativeStrTypeIdx, fieldIdx: 1 }); // .off
  fctx.body.push({ op: "local.set", index: offLocal });

  return { recvName, indexName, dataLocal, offLocal };
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
  // #2682: canonical string-read-loop hoist proof + its scoped save/restore.
  let charReadProof: HoistedCharRead | null = null;
  let savedHoistedCharReads: Map<string, HoistedCharRead> | undefined;
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

  // #2682: recognise the canonical string-read hot loop and hoist the
  // loop-invariant `__str_flatten` + descriptor into locals emitted into the
  // OUTER body (here — BEFORE pushBody — so they run exactly once before the
  // loop). The proof is installed on a scoped `fctx.hoistedCharReads` consumed
  // by the body's `recv.charCodeAt(i)` lowering, then restored after the body.
  charReadProof = detectCanonicalCharReadLoop(ctx, fctx, stmt);
  if (charReadProof) {
    savedHoistedCharReads = fctx.hoistedCharReads;
    fctx.hoistedCharReads = new Map(fctx.hoistedCharReads ?? []);
    fctx.hoistedCharReads.set(charReadProof.recvName, charReadProof);
  }

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
  // #2682: restore the canonical-read proof (scoped to this loop). The hoisted
  // descriptor locals stay allocated (they're function-wide), but the proof is
  // only visible to THIS loop's body — the incrementor (`i++`) must NOT see it.
  if (charReadProof) fctx.hoistedCharReads = savedHoistedCharReads;

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
                // (#51) `addStringConstantGlobal` stores a `-1` sentinel under
                // nativeStrings (no host string-constant global); a bare
                // `global.get -1` crashes binary emit ("global index out of
                // range — -1"). Materialize the excluded-keys string inline via
                // the dual-mode helper (inline NativeString externref standalone,
                // host `global.get` under GC).
                for (const instr of stringConstantExternrefInstrs(ctx, excludedStr)) fctx.body.push(instr);
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
        // (#2808) Nested sub-pattern in a for-of OBJECT binding head:
        //   for (const { a: { x }, b: [y] } of arr)
        // The struct branch previously DROPPED these at the identifier-only
        // `continue` just below, so a nested object/array sub-pattern never
        // bound its inner names and — for a null/undefined property value —
        // never threw. Mirror the array branch (#2669/#2216): extract the
        // field value, apply the (undefined-only) nested default, then recurse.
        // `compileForOfDestructuring`'s own RequireObjectCoercible / GetIterator
        // null guard throws TypeError for a null/undefined nested target
        // (§13.15.5.5 / §8.5.2 BindingInitialization), so the throw is handled
        // by the recursion rather than re-emitted here.
        if (propNameText && (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name))) {
          const nestedFieldIdx = fields.findIndex((f) => f.name === propNameText);
          // A default initializer fires ONLY when the property value is
          // `undefined` (never `null`) — KeyedBindingInitialization §13.3.3.7
          // step 3. Restricted to PURE (non-call) defaults: a call default
          // compiled in a conditionally-skipped arm materialises its capture box
          // on the not-taken branch (#2692) / over-consumes a generator (#2566),
          // exactly the for-await regression class the array branch guards against.
          const nestedInit =
            element.initializer && !stmt.awaitModifier && !ts.isCallExpression(element.initializer)
              ? element.initializer
              : undefined;
          if (nestedFieldIdx >= 0) {
            const nestedFieldType = fields[nestedFieldIdx]!.type;
            const nestedLocal = allocLocal(fctx, `__forof_obj_nested_${fctx.locals.length}`, nestedFieldType);
            fctx.body.push({ op: "local.get", index: elemLocal });
            fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: nestedFieldIdx });
            fctx.body.push({ op: "local.set", index: nestedLocal });
            if (nestedInit) {
              emitNestedBindingDefault(ctx, fctx, nestedLocal, nestedFieldType, nestedInit);
            }
            compileForOfDestructuring(ctx, fctx, element.name, nestedLocal, nestedFieldType, stmt);
          } else {
            // Property absent ⇒ the value is `undefined`.
            const dfltTsType = ctx.checker.getTypeAtLocation(element);
            let dfltType = resolveWasmType(ctx, dfltTsType);
            // For an absent property with no default the value is undefined and
            // must throw; force a nullable carrier so the recursion's guard fires.
            if (!nestedInit && dfltType.kind !== "ref_null" && dfltType.kind !== "externref") {
              dfltType = { kind: "externref" };
            }
            const nestedLocal = allocLocal(fctx, `__forof_obj_nested_${fctx.locals.length}`, dfltType);
            if (nestedInit) {
              const dt = compileExpression(ctx, fctx, nestedInit, dfltType);
              if (dt && !valTypesMatch(dt, dfltType)) coerceType(ctx, fctx, dt, dfltType);
            } else if (dfltType.kind === "ref_null") {
              fctx.body.push({ op: "ref.null", typeIdx: (dfltType as { typeIdx: number }).typeIdx });
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            fctx.body.push({ op: "local.set", index: nestedLocal });
            compileForOfDestructuring(ctx, fctx, element.name, nestedLocal, dfltType, stmt);
          }
          continue;
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
          // (#2669) Apply the nested element's default initializer BEFORE recursing
          // into the sub-pattern — otherwise a short/empty source left `nestedLocal`
          // null/undefined and the recursive destructure threw
          // "Cannot destructure 'null' or 'undefined'"
          // (`for (const [[x,y,z]=[4,5,6]] of [[]])`). Mirrors the
          // `destructureParamArray` nested-default path.
          //
          // Restricted to (a) the SYNC for-of path and (b) PURE (non-call)
          // default initializers — array/object literals and identifiers. A
          // CALL-expression default (IIFE, generator `g()`, capturing helper) is
          // deferred to the pre-fix behaviour because compiling it inside the
          // conditionally-skipped default arm materialises its capture box only on
          // the not-taken branch, corrupting later reads of the captured variable
          // (#2692 closure-box-lazy territory) — and the generator case also
          // over-consumes the iterator (#2566). This is exactly what regressed 15
          // `for-await-of` elision-default tests in the merge_group floor; a pure
          // literal/identifier default has no side effect or capture box, so it is
          // safe to evaluate conditionally. Call-expression nested defaults stay
          // tracked under the umbrella tail (#2566 / #2692).
          const applyNestedDefault =
            element.initializer !== undefined && !stmt.awaitModifier && !ts.isCallExpression(element.initializer);
          if (applyNestedDefault) {
            // The OOB else-branch must yield JS `undefined` (not wasm-null) for an
            // externref source so `emitNestedBindingDefault`'s
            // `__extern_is_undefined` check fires the initializer. For a typed
            // (f64/ref) source the existing sentinel/null check already fires.
            const nestedWantsUndef = innerElemType.kind === "externref" || innerElemType.kind === "ref_extern";
            emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType, ctx, nestedWantsUndef);
            fctx.body.push({ op: "local.set", index: nestedLocal });
            (ctx as any)._arrayLiteralForceVec = true;
            try {
              emitNestedBindingDefault(ctx, fctx, nestedLocal, innerElemType, element.initializer!);
            } finally {
              (ctx as any)._arrayLiteralForceVec = false;
            }
          } else {
            // Byte-identical to the pre-#2669 extraction (no sentinel, no default).
            emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);
            fctx.body.push({ op: "local.set", index: nestedLocal });
          }
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

          // If the rest target is itself a binding pattern, destructure the
          // freshly built rest vec into it.
          if (ts.isArrayBindingPattern(element.name)) {
            // Nested array sub-pattern (e.g. [...[a, b]]): recurse — the
            // recursion's vec-array branch reads A.data[i].
            compileForOfDestructuring(ctx, fctx, element.name, restIdx, restVecType, stmt);
          } else if (ts.isObjectBindingPattern(element.name)) {
            // (#2844) Nested object sub-pattern (e.g. [...{ 0: v, length: z }]):
            // the rest vec is array-like. The generic object destructure resolves
            // struct fields by name (no field `0`) and dropped numeric-key
            // bindings — route through the shared array-like object read instead.
            // For-of/for-await loop heads are always declarations -> isDecl=true.
            emitObjectPatternRestFromVec(ctx, fctx, restIdx, structTypeIdx, innerArrTypeIdx, element.name, true);
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

        if (element.initializer && wantUndefinedSentinel) {
          // (#2669) Externref source element WITH a default: the OOB else-branch
          // yields JS `undefined`, which is only detectable on the RAW externref
          // via `__extern_is_undefined`. Coercing to the (numeric) binding type
          // FIRST would unbox `undefined` to a plain NaN — NOT the f64 sNaN
          // sentinel the default-check looks for — so the default never fired
          // (`for (const [a=9] of [[]])` kept NaN). Run the check on the externref
          // and let emitDefaultValueCheck coerce the surviving value afterwards.
          emitDefaultValueCheck(ctx, fctx, innerElemType, localIdx, element.initializer, bindingWasmType);
        } else {
          if (!valTypesMatch(innerElemType, bindingWasmType)) {
            coerceType(ctx, fctx, innerElemType, bindingWasmType);
          }
          if (element.initializer) {
            emitDefaultValueCheck(ctx, fctx, bindingWasmType, localIdx, element.initializer);
          } else {
            fctx.body.push({ op: "local.set", index: localIdx });
          }
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
/**
 * (#2692) Store a for-of-assignment destructuring field value — currently the
 * single value on top of the stack (type `fieldType`) — into a target that is a
 * closure-captured-mutable BOX. A plain `local.set` on the box-ref local would
 * clobber the cell pointer; we must write THROUGH the cell with `struct.set`.
 * Mirrors the #1510 vec-default / #1258 externref box-aware branches, but covers
 * the plain (no-default) array/tuple writes that were left box-unaware — newly
 * reachable now that #2692 boxes captured-mutable vars eagerly at function-top.
 * Captured-mutable names live in a cell, never a module global, so there is no
 * global-sync to emit. Consumes exactly one stack value.
 */
function emitBoxedForOfAssignStore(
  ctx: CodegenContext,
  fctx: FunctionContext,
  targetLocal: number,
  fieldType: ValType,
  boxedCap: { refCellTypeIdx: number; valType: ValType },
): void {
  const valType = boxedCap.valType;
  const tmpVal = allocLocal(fctx, `__forof_boxset_${fctx.locals.length}`, fieldType);
  fctx.body.push({ op: "local.set", index: tmpVal });
  fctx.body.push({ op: "local.get", index: targetLocal });
  fctx.body.push({ op: "local.get", index: tmpVal });
  if (!valTypesMatch(fieldType, valType)) {
    coerceType(ctx, fctx, fieldType, valType);
  }
  fctx.body.push({ op: "struct.set", typeIdx: boxedCap.refCellTypeIdx, fieldIdx: 0 } as Instr);
}

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
          // (#2692) Box-aware: when `targetName` is a captured-mutable var (now
          // boxed eagerly at function-top), write the default THROUGH the cell.
          const boxedCapPrim = fctx.boxedCaptures?.get(targetName);
          const targetType = boxedCapPrim ? boxedCapPrim.valType : getLocalType(fctx, targetLocal);
          const instrs = collectInstrs(fctx, () => {
            const dfltType = compileExpression(ctx, fctx, init, targetType ?? { kind: "externref" });
            if (boxedCapPrim) {
              emitBoxedForOfAssignStore(ctx, fctx, targetLocal, dfltType ?? boxedCapPrim.valType, boxedCapPrim);
            } else {
              fctx.body.push({ op: "local.set", index: targetLocal } as Instr);
            }
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

      // (#2869) Member-expression target — `for ({k: obj.y} of src)`. The
      // identifier-only resolution below computes targetName=propName and drops
      // the write (no local/global). Extract the field value into a temp and
      // route through emitAssignToTarget → the #2664 member-set dispatcher. This
      // emits into the LIVE loop body, so there is no detached-buffer funcIdx
      // repoint hazard (unlike the assignment-expression path).
      if (
        ts.isPropertyAssignment(prop) &&
        (ts.isPropertyAccessExpression(prop.initializer) || ts.isElementAccessExpression(prop.initializer))
      ) {
        const fieldEntryM = fields[fieldIdx];
        if (!fieldEntryM) continue;
        const fieldTypeM = fieldEntryM.type;
        const tmpV = allocLocal(fctx, `__forof_objmemtgt_${fctx.locals.length}`, fieldTypeM);
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        fctx.body.push({ op: "local.set", index: tmpV });
        emitAssignToTarget(ctx, fctx, prop.initializer, tmpV, fieldTypeM);
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
      // (#2692) Box-aware write: when `targetName` is a closure-captured-mutable
      // var, `targetLocal` is the ref-cell-ref local (now the common case since
      // #2692 boxes such vars eagerly at function-top). A plain
      // `emitCoercedLocalSet` would coerce the field value f64/externref → cell
      // ref (garbage / null deref). Write THROUGH the cell with `struct.set`,
      // mirroring the #1510 vec box-aware branch below. (Module-global sync is
      // moot here — captured-mutable names live in a cell, not a global.)
      const boxedCapObj = fctx.boxedCaptures?.get(targetName);
      if (boxedCapObj) {
        const valType = boxedCapObj.valType;
        fctx.body.push({ op: "local.get", index: targetLocal });
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx });
        if (!valTypesMatch(fieldType, valType)) {
          coerceType(ctx, fctx, fieldType, valType);
        }
        fctx.body.push({ op: "struct.set", typeIdx: boxedCapObj.refCellTypeIdx, fieldIdx: 0 } as Instr);
        continue;
      }
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

        if (ts.isSpreadElement(el)) {
          // (#2602) Rest element against a tuple-struct source. Convert the
          // WasmGC tuple to externref so __extern_slice can produce the rest
          // slice (a JS array host / native array standalone), then PutValue it.
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "extern.convert_any" } as Instr);
          emitForOfRestAssignment(ctx, fctx, el, i, (name) => ctx.moduleGlobals.get(name));
          continue;
        }

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

        // (#2869) Member-expression target — `for ([x.y] of [[4]])`. Read the
        // tuple field into a temp (applying any default), then route through
        // emitAssignToTarget → the #2664 member-set dispatcher. Emits into the
        // LIVE loop body → no detached-buffer funcIdx repoint hazard.
        if (ts.isPropertyAccessExpression(targetEl) || ts.isElementAccessExpression(targetEl)) {
          const tmpV = allocLocal(fctx, `__forof_memtgt_${fctx.locals.length}`, fieldType);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: i });
          if (defaultInit) {
            emitDefaultValueCheck(ctx, fctx, fieldType, tmpV, defaultInit, fieldType);
          } else {
            fctx.body.push({ op: "local.set", index: tmpV });
          }
          emitAssignToTarget(ctx, fctx, targetEl, tmpV, fieldType);
          continue;
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

        // (#2692) Box-aware write when the target is a captured-mutable var
        // (now boxed eagerly at function-top). `targetLocal` is the cell ref —
        // route through `struct.set`, NOT a plain `local.set` (which would clobber
        // the cell pointer → null deref). Tuple path: field read by index `i`.
        const boxedCapTup = fctx.boxedCaptures?.get(targetEl.text);
        const targetType = boxedCapTup ? boxedCapTup.valType : getLocalType(fctx, targetLocal);
        fctx.body.push({ op: "local.get", index: elemLocal });
        fctx.body.push({
          op: "struct.get",
          typeIdx: innerVecTypeIdx,
          fieldIdx: i,
        });

        if (boxedCapTup) {
          if (defaultInit) {
            // Compute value-or-default into a temp of the cell's value type
            // (emitDefaultValueCheck consumes the field value on the stack and
            // stores into the temp), then write the temp through the cell.
            const tmpV = allocLocal(fctx, `__forof_tupdflt_${fctx.locals.length}`, boxedCapTup.valType);
            emitDefaultValueCheck(ctx, fctx, fieldType, tmpV, defaultInit, boxedCapTup.valType);
            fctx.body.push({ op: "local.get", index: targetLocal });
            fctx.body.push({ op: "local.get", index: tmpV });
            fctx.body.push({ op: "struct.set", typeIdx: boxedCapTup.refCellTypeIdx, fieldIdx: 0 } as Instr);
          } else {
            emitBoxedForOfAssignStore(ctx, fctx, targetLocal, fieldType, boxedCapTup);
          }
          // captured-mutable lives in a cell, not a global → no global sync.
          continue;
        }

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

        if (ts.isSpreadElement(el)) {
          // (#2602) Rest element against a WasmGC vec-struct source. Build the
          // rest slice NATIVELY (mirror of the BINDING-form vec rest, loops.ts
          // ~1488): array.new_default(restLen) + array.copy from index `i` +
          // struct.new — no externref/__extern_slice roundtrip (the host
          // __extern_slice can't slice a WasmGC struct externref). The fresh vec
          // has the SAME struct type as the source, then PutValue to the target.
          emitVecRestAssignment(
            ctx,
            fctx,
            el,
            elemLocal,
            i,
            innerVecTypeIdx,
            innerArrTypeIdx,
            innerElemType,
            vecTypeIdx,
            arrTypeIdx,
            stmt,
          );
          continue;
        }

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

        // (#2869) Member-expression target — `for ([x.y] of [[4]])` over a vec
        // source. Bounds-checked read of elem.data[i] into a temp (applying any
        // default), then route through emitAssignToTarget → the #2664 member-set
        // dispatcher. Live loop body → no detached-buffer funcIdx hazard.
        if (ts.isPropertyAccessExpression(targetEl) || ts.isElementAccessExpression(targetEl)) {
          const memElemVT: ValType =
            innerElemType.kind === "i8" || innerElemType.kind === "i16" ? { kind: "i32" } : innerElemType;
          const tmpV = allocLocal(fctx, `__forof_memtgt_${fctx.locals.length}`, memElemVT);
          fctx.body.push({ op: "local.get", index: elemLocal });
          fctx.body.push({ op: "struct.get", typeIdx: innerVecTypeIdx, fieldIdx: 1 });
          fctx.body.push({ op: "i32.const", value: i });
          emitBoundsCheckedArrayGet(fctx, innerArrTypeIdx, innerElemType);
          if (defaultInit) {
            emitDefaultValueCheck(ctx, fctx, memElemVT, tmpV, defaultInit, memElemVT);
          } else {
            fctx.body.push({ op: "local.set", index: tmpV });
          }
          emitAssignToTarget(ctx, fctx, targetEl, tmpV, memElemVT);
          continue;
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
          } else if (boxedCapVec) {
            // (#2692) Box-aware plain write (boxed+default already handled and
            // `continue`d at the #1510 branch above, so here it is no-default).
            emitBoxedForOfAssignStore(ctx, fctx, targetLocal, innerElemType, boxedCapVec);
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
 * (#2602) Emit the rest-element ASSIGNMENT write for a for-of / for-await
 * assignment-destructuring head: `for ([x, ...y] of …)` (and `for await`).
 *
 * Spec §13.15.5.5 ArrayAssignmentPattern (the rest step) requires PutValue on
 * the `...y` target with the remaining iterated elements — the slice from
 * `restStartIndex` to the end. Before this, all for-of assignment-destructuring
 * loops `continue`d on `ts.isSpreadElement`, so `y` was never written and kept a
 * stale value (the source array). This mirrors the BINDING-form rest write
 * (loops.ts ~1375) and the plain `[a, ...rest] = arr` assignment-form rest
 * (assignment.ts ~1628), both of which use `__extern_slice`.
 *
 * The caller must already have pushed the source value onto the stack as an
 * `externref` (an `extern.convert_any` of the loop element for a WasmGC vec/
 * tuple element, or the element local directly for an externref element).
 * `__extern_slice(elem, restStartIndex)` returns the rest as an externref
 * (a JS array host-side / native array standalone); we then PutValue it to the
 * rest target.
 *
 * Only IDENTIFIER rest targets are handled (local OR pre-declared module global
 * — the shape every test262 array-rest case + #2602 uses). A rest target that is
 * a property/element access (`[...obj.x]`) is rare and left as a no-op (matching
 * the pre-#2602 drop — no regression). Returns `true` when the spread element was
 * consumed (the caller should `continue`), `false` to fall through.
 */
function emitForOfRestAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  spread: ts.SpreadElement,
  restStartIndex: number,
  syncGlobalForName: (name: string) => number | undefined,
): boolean {
  const restTarget = spread.expression;
  // Pop the source externref the caller pushed — we only need it when the target
  // resolves; for an unhandled target shape, drop it to keep the stack balanced.
  if (!ts.isIdentifier(restTarget)) {
    // Unhandled rest target (property/element access). Drop the source externref
    // the caller pushed so the value stack stays balanced, then bail.
    fctx.body.push({ op: "drop" } as Instr);
    return true;
  }

  // Ensure __extern_slice is available (env import in JS-host mode; the native
  // object-runtime slice under --target standalone routes through the same name).
  let sliceIdx = ctx.funcMap.get("__extern_slice");
  if (sliceIdx === undefined) {
    const importsBefore = ctx.numImportFuncs;
    const sliceType = addFuncType(ctx, [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
    addImport(ctx, "env", "__extern_slice", { kind: "func", typeIdx: sliceType });
    shiftLateImportIndices(ctx, fctx, importsBefore, ctx.numImportFuncs - importsBefore);
    sliceIdx = ctx.funcMap.get("__extern_slice");
  }
  if (sliceIdx === undefined) {
    // Could not register the slice helper — drop the source to keep balance.
    fctx.body.push({ op: "drop" } as Instr);
    return true;
  }

  const restName = restTarget.text;
  let targetLocal = fctx.localMap.get(restName);
  let restSyncGlobalIdx: number | undefined;
  if (targetLocal === undefined) {
    const globalIdx = syncGlobalForName(restName);
    if (globalIdx === undefined) {
      // No local and no module global — nothing to write to. Drop and bail.
      fctx.body.push({ op: "drop" } as Instr);
      return true;
    }
    const globalDef = ctx.mod.globals[localGlobalIdx(ctx, globalIdx)];
    const globalType = globalDef?.type ?? { kind: "externref" as const };
    targetLocal = allocLocal(fctx, restName, globalType);
    restSyncGlobalIdx = globalIdx;
  }

  // Source externref is on the stack. Compute the rest slice:
  //   __extern_slice(source, restStartIndex) -> externref
  fctx.body.push({ op: "f64.const", value: restStartIndex });
  fctx.body.push({ op: "call", funcIdx: sliceIdx });

  // Coerce externref slice -> the rest target's declared type and store. For an
  // untyped (`any` → externref) target this is a no-op; for `number[]` (a vec
  // ref) coerceType reconstructs the vec from the JS-array externref (its
  // guarded externref→ref arm handles the JS-array case — no trapping cast).
  const targetType = getLocalType(fctx, targetLocal);
  if (targetType && targetType.kind !== "externref") {
    coerceType(ctx, fctx, { kind: "externref" }, targetType);
  }
  fctx.body.push({ op: "local.set", index: targetLocal });

  if (restSyncGlobalIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: targetLocal });
    fctx.body.push({ op: "global.set", index: restSyncGlobalIdx });
  }
  return true;
}

/**
 * (#2602) Emit the rest-element ASSIGNMENT write when the for-of source element
 * is a WasmGC vec struct (`{ length, data }`) — `for ([x, ...y] of [[1,2,3]])`.
 *
 * Builds the rest slice NATIVELY (no externref / __extern_slice roundtrip — the
 * host __extern_slice cannot slice a WasmGC struct externref): compute
 * `restLen = max(0, srcLen - restStartIndex)`, `array.new_default(restLen)`,
 * `array.copy` the tail from `srcData[restStartIndex..]`, then `struct.new` a
 * fresh vec of the SAME struct type as the source. This mirrors the binding-form
 * vec rest (loops.ts ~1488) so behaviour is byte-identical between
 * `const [a,...r]=…` and `[a,...r]=…`. The fresh vec is PutValue'd to the rest
 * target (identifier local OR pre-declared module global). Only identifier
 * targets are handled (the test262 array-rest shape + #2602); a property/element
 * rest target is left unwritten (matching the pre-#2602 drop — no regression).
 */
function emitVecRestAssignment(
  ctx: CodegenContext,
  fctx: FunctionContext,
  spread: ts.SpreadElement,
  elemLocal: number,
  restStartIndex: number,
  vecTypeIdx: number,
  arrTypeIdx: number,
  innerElemType: ValType,
  outerVecTypeIdx: number,
  outerArrTypeIdx: number,
  stmt: ts.ForOfStatement,
): void {
  const restTarget = spread.expression;
  const restVecType: ValType = { kind: "ref", typeIdx: vecTypeIdx };

  // A nested pattern rest target (`for ([...[x]] of …)`): build the rest vec
  // into a temp, then recurse into the nested assignment pattern with the fresh
  // rest vec as the element (mirror of the binding-form rest recursion,
  // loops.ts ~1551). Identifier targets store directly; property/element rest
  // targets are not handled (matching the pre-#2602 drop — no regression).
  const isNestedPattern = ts.isArrayLiteralExpression(restTarget) || ts.isObjectLiteralExpression(restTarget);
  let targetLocal: number | undefined;
  let restSyncGlobalIdx: number | undefined;
  if (isNestedPattern) {
    targetLocal = allocLocal(fctx, `__forof_rest_${fctx.locals.length}`, restVecType);
  } else {
    if (!ts.isIdentifier(restTarget)) return; // property/element rest target — not handled (no regression)
    targetLocal = fctx.localMap.get(restTarget.text);
    if (targetLocal === undefined) {
      const globalIdx = ctx.moduleGlobals.get(restTarget.text);
      if (globalIdx === undefined) return; // unresolvable identifier — nothing to write
      targetLocal = allocLocal(fctx, restTarget.text, restVecType);
      restSyncGlobalIdx = globalIdx;
    }
  }

  // restLen = max(0, srcLen - restStartIndex)
  const restLenLocal = allocLocal(fctx, `__rest_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: elemLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 }); // length
  fctx.body.push({ op: "i32.const", value: restStartIndex });
  fctx.body.push({ op: "i32.sub" } as Instr);
  fctx.body.push({ op: "local.set", index: restLenLocal });
  // clamp negative to 0: select(0, restLen, restLen < 0)
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "local.get", index: restLenLocal });
  fctx.body.push({ op: "local.get", index: restLenLocal });
  fctx.body.push({ op: "i32.const", value: 0 } as Instr);
  fctx.body.push({ op: "i32.lt_s" } as Instr);
  fctx.body.push({ op: "select" } as Instr);
  fctx.body.push({ op: "local.set", index: restLenLocal });

  // restArr = array.new_default(restLen)
  const restArrLocal = allocLocal(fctx, `__rest_arr_${fctx.locals.length}`, { kind: "ref", typeIdx: arrTypeIdx });
  fctx.body.push({ op: "local.get", index: restLenLocal });
  fctx.body.push({ op: "array.new_default", typeIdx: arrTypeIdx } as Instr);
  fctx.body.push({ op: "local.set", index: restArrLocal });

  // array.copy(restArr, 0, srcData, restStartIndex, restLen)
  fctx.body.push({ op: "local.get", index: restArrLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.get", index: elemLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 }); // src data
  fctx.body.push({ op: "i32.const", value: restStartIndex });
  fctx.body.push({ op: "local.get", index: restLenLocal });
  fctx.body.push({ op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx } as Instr);
  // innerElemType is referenced for symmetry with the binding-form rest (the
  // array element type is already arrTypeIdx's element); no per-element coercion
  // is needed since we copy raw same-typed elements.
  void innerElemType;

  // restVec = struct.new(restLen, restArr)
  fctx.body.push({ op: "local.get", index: restLenLocal });
  fctx.body.push({ op: "local.get", index: restArrLocal });
  fctx.body.push({ op: "struct.new", typeIdx: vecTypeIdx } as Instr);

  if (isNestedPattern) {
    // Store the fresh rest vec into the temp local, then recurse into the
    // nested assignment pattern (`for ([...[x]] of …)`) with it as the element.
    fctx.body.push({ op: "local.set", index: targetLocal });
    compileForOfAssignDestructuring(
      ctx,
      fctx,
      restTarget as ts.ArrayLiteralExpression | ts.ObjectLiteralExpression,
      targetLocal,
      restVecType,
      outerVecTypeIdx,
      outerArrTypeIdx,
      stmt,
    );
    return;
  }

  // PutValue to the identifier rest target.
  const targetType = getLocalType(fctx, targetLocal);
  if (targetType && !valTypesMatch(restVecType, targetType)) {
    coerceType(ctx, fctx, restVecType, targetType);
  }
  fctx.body.push({ op: "local.set", index: targetLocal });

  if (restSyncGlobalIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: targetLocal });
    fctx.body.push({ op: "global.set", index: restSyncGlobalIdx });
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
    if (ts.isSpreadElement(el)) {
      // (#2602) Rest element `...y`: PutValue the slice from index `i` onward.
      // The element local is already an externref source — push it directly.
      fctx.body.push({ op: "local.get", index: elemLocal });
      emitForOfRestAssignment(ctx, fctx, el, i, (name) => ctx.moduleGlobals.get(name));
      continue;
    }

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
        // (#51) Materialize via the dual-mode helper — nativeStrings stores a
        // `-1` sentinel global so a bare `global.get` crashes binary emit.
        addStringConstantGlobal(ctx, propName);
        for (const instr of stringConstantExternrefInstrs(ctx, propName)) fctx.body.push(instr);
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
  // (#2162) Native Map/Set for-of in standalone / nativeStrings mode — MUST run
  // before the array-iterator-receiver detection below. A native collection
  // (bare `for (x of map)` or `for (x of map.values())` etc.) lowers to the
  // `$Map` struct, whose `entries` field (a ref to an array) makes
  // `getArrTypeIdxFromVec` misidentify `$Map` as a vec — so `arrayIteratorReceiver
  // ForForOf` would wrongly treat the map as an array and iterate garbage. Handle
  // the collection natively first: materialize the projection (Map default →
  // `[k, v]` entries, Set default → values; explicit `.keys()/.values()/.entries()`
  // honoured) into a canonical externref $Vec and drive the array loop over it.
  if (ctx.nativeStrings && compileForOfNativeCollection(ctx, fctx, stmt, exprTsType)) return;

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

/**
 * (#2162) Drive `for (… of <map|set>)` natively in standalone / nativeStrings
 * mode by materializing the default iterator projection into a canonical
 * externref `$Vec` and reusing the array for-of loop. Map → `[key, value]`
 * pairs (`entries`), Set → element list (`values`). Returns `true` when the
 * subject is a native Map/Set and iteration was emitted, else `false` (caller
 * continues with the array/iterator paths). A bare `.keys()/.values()/.entries()`
 * call subject is already handled upstream by `compileNativeCollectionIterator`
 * via the tentative-array vec path, so this only covers the bare collection.
 */
function compileForOfNativeCollection(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  exprTsType: ts.Type,
): boolean {
  // Resolve the *receiver* expression and the projection kind. Two subject shapes:
  //   - bare collection:        `for (x of map)`  → receiver = map, default kind
  //   - explicit iterator call: `for (x of map.keys())` → receiver = map, kind = keys
  let receiver: ts.Expression = stmt.expression;
  let explicitKind: "keys" | "values" | "entries" | undefined;
  if (ts.isCallExpression(stmt.expression)) {
    if (stmt.expression.arguments.length !== 0) return false;
    const callee = stmt.expression.expression;
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const m = callee.name.text;
    if (m !== "keys" && m !== "values" && m !== "entries") return false;
    receiver = callee.expression;
    explicitKind = m;
  }

  // The receiver must be a native Map/Set (its TS type symbol is Map/Set).
  const recvTsType = ctx.checker.getTypeAtLocation(receiver);
  const symName = recvTsType.getSymbol()?.getName() ?? recvTsType.aliasSymbol?.name;
  const isMap = symName === "Map";
  const isSet = symName === "Set";
  if (!isMap && !isSet) return false;

  // Default projection: Set → values; Map → `entries` ([k, v] pairs). An explicit
  // `.keys()/.values()/.entries()` call overrides.
  const kind: "keys" | "values" | "entries" = explicitKind ?? (isMap ? "entries" : "values");

  // `entries` with a `[k, v]` destructuring binding is driven by a dedicated
  // native walk that binds the stored key/value directly per live entry — no
  // intermediate `$ObjVec` pair (whose generic destructuring would route through
  // the host `__extern_get` and leak imports). Falls back below for non-`[k,v]`
  // shapes (a single-identifier binding over entries, holes, rest).
  if (kind === "entries") {
    if (compileForOfNativeMapEntries(ctx, fctx, stmt, receiver, isSet)) return true;
    return false;
  }

  // Confirm the receiver genuinely lowers to the native `$Map` struct (a Map/Set
  // typed value can still be a host externref in JS-host mode) without leaving
  // code behind.
  // #1919 — transactional probe: discard body + locals + late imports + errors.
  const snap = snapshotSpeculative(ctx, fctx);
  const recvType = compileExpression(ctx, fctx, receiver);
  rollbackSpeculative(ctx, fctx, snap);
  if (!recvType || (recvType.kind !== "ref" && recvType.kind !== "ref_null")) return false;
  if (recvType.typeIdx !== ctx.mapTypeIdx) return false;

  // Build the projection vec, store it in a temp, and iterate it as an array.
  const vecResult = emitCollectionIteratorVec(ctx, fctx, receiver, kind, /* isSet */ isSet);
  if (
    vecResult === undefined ||
    vecResult === null ||
    typeof vecResult !== "object" ||
    (vecResult.kind !== "ref" && vecResult.kind !== "ref_null")
  ) {
    // Could not lower (shouldn't happen after the recvType check) — undo and bail.
    return false;
  }
  const vecType: ValType = vecResult;
  const vecLocal = allocLocal(fctx, `__cof_vec_${fctx.locals.length}`, vecType);
  fctx.body.push({ op: "local.set", index: vecLocal });
  compileForOfArrayFromLocal(ctx, fctx, stmt, vecLocal, vecType);
  return true;
}

/**
 * (#2162) Drive `for (const [k, v] of map.entries())` / `for (const [k, v] of map)`
 * (and the Set `[v, v]` form) natively in standalone / `nativeStrings` mode by
 * walking the `$Map` entries vector and binding the stored key/value DIRECTLY
 * into the destructuring targets per live entry — no intermediate `$ObjVec` pair
 * (whose generic `[k, v]` destructuring would route through the host
 * `__extern_get` and leak imports). Mirrors `tryCompileNativeCollectionForEach`'s
 * tombstone-skipping walk and `compileForOfArray`'s block/loop/body-block
 * break/continue bookkeeping.
 *
 * Returns `true` when it emitted the loop; `false` (leaving no code behind) when
 * the binding is not a 2-element `[k, v]` identifier pattern (holes, rest, a
 * single-identifier binding over entries, or an assignment target), so the
 * caller can fall back to the generic path.
 */
function compileForOfNativeMapEntries(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  receiver: ts.Expression,
  isSet: boolean,
): boolean {
  if (!ctx.nativeStrings) return false;
  // Only the `const/let [k, v]` binding form (the dominant Map-entries shape).
  if (!ts.isVariableDeclarationList(stmt.initializer)) return false;
  const decl = stmt.initializer.declarations[0]!;
  if (!ts.isArrayBindingPattern(decl.name)) return false;
  const elements = decl.name.elements;
  if (elements.length !== 2) return false;
  const keyEl = elements[0]!;
  const valEl = elements[1]!;
  if (
    !ts.isBindingElement(keyEl) ||
    keyEl.dotDotDotToken ||
    keyEl.initializer ||
    !ts.isIdentifier(keyEl.name) ||
    !ts.isBindingElement(valEl) ||
    valEl.dotDotDotToken ||
    valEl.initializer ||
    !ts.isIdentifier(valEl.name)
  ) {
    return false;
  }

  ensureMapHelpers(ctx);
  if (ctx.mapTypeIdx < 0) return false;

  // Confirm the receiver genuinely lowers to the native `$Map` struct without
  // leaving code behind (same probe as compileForOfNativeCollection).
  // #1919 — transactional probe: discard body + locals + late imports + errors.
  const probeSnap = snapshotSpeculative(ctx, fctx);
  const recvProbe = compileExpression(ctx, fctx, receiver);
  rollbackSpeculative(ctx, fctx, probeSnap);
  if (!recvProbe || (recvProbe.kind !== "ref" && recvProbe.kind !== "ref_null")) return false;
  if (recvProbe.typeIdx !== ctx.mapTypeIdx) return false;

  const { M_ENTRIES, M_ENTRYCOUNT, F_KEY, F_VALUE, F_HASH, TOMBSTONE_BIT } = MAP_LAYOUT;
  const isConst = !!(stmt.initializer.flags & ts.NodeFlags.Const);
  if (isConst) {
    collectBindingNames(decl.name).forEach((n) => {
      if (!fctx.constBindings) fctx.constBindings = new Set();
      fctx.constBindings.add(n);
    });
  }

  // Receiver → ref $Map in a temp.
  const recvType = compileExpression(ctx, fctx, receiver);
  if (!recvType) return false;
  const mTmp = allocLocal(fctx, `__mef_m_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ctx.mapTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: mTmp });

  // Bound key/value locals, typed from the binding-element TS types (a numeric
  // Map key → f64, string → native string ref, etc.).
  const keyType = resolveWasmType(ctx, ctx.checker.getTypeAtLocation(keyEl));
  const valType = resolveWasmType(ctx, ctx.checker.getTypeAtLocation(valEl));
  const keyLocal = allocLocal(fctx, keyEl.name.text, keyType);
  const valLocal = allocLocal(fctx, valEl.name.text, valType);

  const iTmp = allocLocal(fctx, `__mef_i_${fctx.locals.length}`, { kind: "i32" });
  const entryTmp = allocLocal(fctx, `__mef_e_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ctx.mapEntryTypeIdx,
  });

  // entry = (cast $MapEntry) m.entries[i]
  const loadEntry: Instr[] = [
    { op: "local.get", index: mTmp } as Instr,
    { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx } as unknown as Instr,
    { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx } as Instr,
    { op: "local.set", index: entryTmp } as Instr,
  ];

  // Externalize a $MapEntry field then coerce to the bound local's type, mirroring
  // the forEach driver (entry fields are stored anyref / boxed externref).
  const bindFromEntry = (field: number, targetType: ValType, targetLocal: number): Instr[] => [
    { op: "local.get", index: entryTmp } as Instr,
    { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: field } as unknown as Instr,
    { op: "extern.convert_any" } as Instr,
    ...coercionInstrs(ctx, { kind: "externref" }, targetType, fctx),
    { op: "local.set", index: targetLocal } as Instr,
  ];

  // i = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  // Build the loop body (block { loop { body-block } }) — 3 nesting levels, so
  // adjust break/continue/return depths like compileForOfArray.
  const savedBody = pushBody(fctx);
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);
  fctx.breakStack.push(2); // break = exit outer block
  fctx.continueStack.push(0); // continue = exit body block, then increment

  // if i >= entryCount → break
  fctx.body.push({ op: "local.get", index: iTmp });
  fctx.body.push({ op: "local.get", index: mTmp });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRYCOUNT } as unknown as Instr);
  fctx.body.push({ op: "i32.ge_s" });
  fctx.body.push({ op: "br_if", depth: 1 });

  // entry = entries[i]; then i++ BEFORE the tombstone/body so a `continue`
  // (br depth 0 → loop start) and a tombstone-skip both advance the cursor
  // (mirrors the forEach driver — never re-reads the same slot).
  fctx.body.push(...loadEntry);
  fctx.body.push({ op: "local.get", index: iTmp });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: iTmp });

  // tombstone → skip this slot (continue the loop; cursor already advanced).
  fctx.body.push({ op: "local.get", index: entryTmp });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_HASH } as unknown as Instr);
  fctx.body.push({ op: "i32.const", value: TOMBSTONE_BIT });
  fctx.body.push({ op: "i32.and" });
  fctx.body.push({ op: "br_if", depth: 0 });

  // Bind k ← entry.key (Set: value === key), v ← entry.value.
  fctx.body.push(...bindFromEntry(isSet ? F_VALUE : F_KEY, keyType, keyLocal));
  fctx.body.push(...bindFromEntry(F_VALUE, valType, valLocal));

  // Compile the user body inside its own block so `continue` (br depth 0 from
  // inside the body) exits the body block and falls through to the loop's `br`.
  const savedLoopBody = pushBody(fctx);
  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) compileStatement(ctx, fctx, s);
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }
  const bodyInstrs = fctx.body;
  popBody(fctx, savedLoopBody);
  fctx.body.push({ op: "block", blockType: { kind: "empty" }, body: bodyInstrs });

  // continue loop (cursor was already advanced above).
  fctx.body.push({ op: "br", depth: 0 });

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
  return true;
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
  // #1919 — transactional probe: discard body + locals + late imports + errors.
  const snap = snapshotSpeculative(ctx, fctx);
  const recvType = compileExpression(ctx, fctx, callee.expression);
  rollbackSpeculative(ctx, fctx, snap);
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

  // Compile the iterable expression (string ref).
  // #1919 — snapshot so a failed compile rolls back body + locals + imports.
  const strSnap = snapshotSpeculative(ctx, fctx);
  const compiledType = compileExpression(ctx, fctx, stmt.expression);
  if (!compiledType) {
    rollbackSpeculative(ctx, fctx, strSnap);
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
  fctx.body.push({
    op: "struct.get",
    typeIdx: ctx.nativeStrTypeIdx,
    fieldIdx: 0,
  });
  fctx.body.push({ op: "local.set", index: lenLocal });

  const offLocal = allocLocal(fctx, `__forof_off_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({
    op: "struct.get",
    typeIdx: ctx.nativeStrTypeIdx,
    fieldIdx: 1,
  });
  fctx.body.push({ op: "local.set", index: offLocal });

  const dataLocal = allocLocal(fctx, `__forof_data_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: ctx.nativeStrDataTypeIdx,
  });
  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({
    op: "struct.get",
    typeIdx: ctx.nativeStrTypeIdx,
    fieldIdx: 2,
  });
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
  // Tentatively compile just the expression to discover its Wasm type.
  // #1919 — transactional probe: every exit re-compiles (vec path) or defers to
  // the iterator path, so always discard body + locals + late imports + errors.
  const snap = snapshotSpeculative(ctx, fctx);
  const exprType = compileExpression(ctx, fctx, iterableExpr);

  // Check if it compiled to a ref to a vec struct (not just any struct —
  // a class instance is also a struct but not iterable via array access).
  // A vec struct has {length: i32, data: (ref $arr)} — verified by getArrTypeIdxFromVec.
  if (exprType && (exprType.kind === "ref" || exprType.kind === "ref_null")) {
    const typeDef = ctx.mod.types[exprType.typeIdx];
    if (typeDef && typeDef.kind === "struct" && getArrTypeIdxFromVec(ctx, exprType.typeIdx) >= 0) {
      // Confirmed vec struct — undo the tentative compilation and use the
      // full array path (which compiles the expression again with proper setup)
      rollbackSpeculative(ctx, fctx, snap);
      compileForOfArray(ctx, fctx, stmt, iterableOverride);
      return true;
    }
  }

  // Not a vec struct — undo tentative compilation, let caller use iterator path
  rollbackSpeculative(ctx, fctx, snap);
  return false;
}

/**
 * (#2162) Drive the array for-of loop over an already-materialized vec held in a
 * local (used by the native Map/Set for-of path, which builds the projection vec
 * itself). Mirrors `compileForOfArray` but skips the expression-compile +
 * vecLocal store.
 */
function compileForOfArrayFromLocal(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  vecLocal: number,
  vecType: ValType,
): void {
  compileForOfArray(ctx, fctx, stmt, undefined, { vecLocal, vecType });
}

// (#2769) Does this for-of need the in-bounds undefined/hole sentinel preserved
// through the OUTER array-literal construction? True ONLY when the subject is a
// *direct array literal* AND the for-of binding pattern has an element default
// OR a nested sub-pattern — the exact #2769 template family
// (`for (const [x = 23] of [[undefined]])`, `[[,]]`, nested-array/obj). When
// true, compileForOfArray sets the scoped `_forOfPreserveUndefElem` flag around
// the subject compile so `compileArrayLiteral` re-keys the outer element type to
// an externref vec (literals.ts), letting the inner undefined/$Hole survive to
// the existing wantUndefinedSentinel default-check. Plain `for (x of arr)` /
// non-literal subjects / default-free patterns return false → untouched.
function forOfDstrNeedsInboundsUndef(stmt: ts.ForOfStatement): boolean {
  if (!ts.isArrayLiteralExpression(stmt.expression)) return false;
  // Extract the for-of binding pattern (declaration or assignment form).
  if (ts.isVariableDeclarationList(stmt.initializer)) {
    const decl = stmt.initializer.declarations[0];
    if (decl && (ts.isArrayBindingPattern(decl.name) || ts.isObjectBindingPattern(decl.name))) {
      return bindingPatternHasDefaultOrNested(decl.name);
    }
    return false;
  }
  if (ts.isArrayLiteralExpression(stmt.initializer) || ts.isObjectLiteralExpression(stmt.initializer)) {
    return assignPatternHasDefaultOrNested(stmt.initializer);
  }
  return false;
}

// Declaration-form binding pattern: any element with a default initializer
// (`[x = 23]`) or a nested array/object sub-pattern (`[[y]]` / `[{z}]`).
function bindingPatternHasDefaultOrNested(pattern: ts.ArrayBindingPattern | ts.ObjectBindingPattern): boolean {
  return pattern.elements.some((el) => {
    if (ts.isOmittedExpression(el)) return false;
    const be = el as ts.BindingElement;
    if (be.initializer) return true; // element default
    return ts.isArrayBindingPattern(be.name) || ts.isObjectBindingPattern(be.name); // nested sub-pattern
  });
}

// Assignment-form pattern (`for ([x = 23] of …)` / `for ({a = 1} of …)`): same
// predicate over the literal AST (`x = 23` is a BinaryExpression with `=`; a
// nested array/object literal is a sub-pattern).
function assignPatternHasDefaultOrNested(pattern: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression): boolean {
  if (ts.isArrayLiteralExpression(pattern)) {
    return pattern.elements.some((el) => {
      if (ts.isOmittedExpression(el)) return false;
      if (ts.isBinaryExpression(el) && el.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
      return ts.isArrayLiteralExpression(el) || ts.isObjectLiteralExpression(el);
    });
  }
  return pattern.properties.some((p) => {
    if (ts.isShorthandPropertyAssignment(p)) return !!p.objectAssignmentInitializer; // {a = 1}
    if (ts.isPropertyAssignment(p)) {
      const init = p.initializer;
      if (ts.isBinaryExpression(init) && init.operatorToken.kind === ts.SyntaxKind.EqualsToken) return true;
      return ts.isArrayLiteralExpression(init) || ts.isObjectLiteralExpression(init);
    }
    return false;
  });
}

/** Compile for...of over an array using index-based loop (existing behavior) */
function compileForOfArray(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForOfStatement,
  iterableOverride?: ts.Expression,
  preVec?: { vecLocal: number; vecType: ValType },
): void {
  // Compile the iterable expression (vec struct ref). `iterableOverride` is the
  // inner receiver of a `.values()` call (#681) when present. When `preVec` is
  // supplied the caller already materialized the vec into a local (#2162 native
  // Map/Set for-of), so skip the expression compile.
  // #1919 — snapshot so a non-array receiver rolls back body + locals + imports
  // before reporting. With `preVec` no compile happens, so rollback is a no-op.
  const snap = snapshotSpeculative(ctx, fctx);
  // (#2769) Preserve in-bounds undefined/hole identity through the OUTER
  // array-literal construction for the spec'd for-of-dstr template family. The
  // flag is scoped tightly to the subject compile (set→compile→restore) so it
  // can't leak into unrelated array literals; `iterableOverride` (`.values()`
  // receiver) and `preVec` paths are not direct array literals, so the gate is
  // false for them.
  const preserveUndefElem = !preVec && !iterableOverride && forOfDstrNeedsInboundsUndef(stmt);
  const prevPreserveUndefElem = (ctx as any)._forOfPreserveUndefElem;
  if (preserveUndefElem) (ctx as any)._forOfPreserveUndefElem = true;
  const vecType = preVec ? preVec.vecType : compileExpression(ctx, fctx, iterableOverride ?? stmt.expression);
  if (preserveUndefElem) (ctx as any)._forOfPreserveUndefElem = prevPreserveUndefElem;
  if (!vecType || (vecType.kind !== "ref" && vecType.kind !== "ref_null")) {
    rollbackSpeculative(ctx, fctx, snap);
    reportError(ctx, stmt, "for-of requires an array expression");
    return;
  }

  // Expect a vec struct type {length: i32, data: (ref $__arr_T)}
  const vecTypeIdx = vecType.typeIdx;
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct") {
    rollbackSpeculative(ctx, fctx, snap);
    reportError(ctx, stmt, "for-of requires an array type");
    return;
  }

  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") {
    rollbackSpeculative(ctx, fctx, snap);
    reportError(ctx, stmt, "for-of requires an array type");
    return;
  }
  const elemType = arrDef.element;
  // (#2934 1b) Packed i8/i16 typed-array elements (Uint8Array/Int8Array/
  // Int16Array/… standalone, #2593) are STORAGE-only types: a local declared
  // `i8` is invalid Wasm ("packed storage type is not valid in a value
  // position") and a plain `array.get` on a packed array fails validation. Bind
  // the loop variable as the unpacked `i32` and read with the view-name-driven
  // extension — `Int*` sign-extends (`array.get_s`), `Uint*` zero-extends
  // (`array.get_u`); the storage kind alone cannot distinguish them (#2648).
  // For non-packed elements both are identity (`readElemType === elemType`,
  // plain `array.get`), so host mode and plain arrays emit byte-identical code.
  const readElemType = unpackedElemType(elemType);
  const elemReadOp = elemGetOp(elemType, typedArraySearchSignedness(ctx, iterableOverride ?? stmt.expression));

  // Save vec ref to temp local. With `preVec` the vec is already in `vecLocal`.
  const vecLocal = preVec ? preVec.vecLocal : allocLocal(fctx, `__forof_vec_${fctx.locals.length}`, vecType);
  if (!preVec) {
    fctx.body.push({ op: "local.set", index: vecLocal });
  }

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
      elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, readElemType);
      // Track const bindings for all identifiers in the destructuring pattern
      if (isConst) {
        collectBindingNames(decl.name).forEach((n) => {
          if (!fctx.constBindings) fctx.constBindings = new Set();
          fctx.constBindings.add(n);
        });
      }
    } else {
      const varName = ts.isIdentifier(decl.name) ? decl.name.text : `__forof_elem_${fctx.locals.length}`;
      elemLocal = allocLocal(fctx, varName, readElemType);
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
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, readElemType);
  } else if (ts.isIdentifier(stmt.initializer)) {
    // Expression form: for (x of arr) — x is already declared
    const varName = stmt.initializer.text;
    elemLocal = fctx.localMap.get(varName) ?? allocLocal(fctx, varName, readElemType);
  } else {
    elemLocal = allocLocal(fctx, `__forof_elem_${fctx.locals.length}`, readElemType);
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
  fctx.body.push({ op: elemReadOp, typeIdx: arrTypeIdx } as Instr);
  // (#2001 S1) A for-of over an `any[]` with a literal hole reads `$Hole` at the
  // hole index; map it back to `undefined` (the iteration value of an absent
  // index — for-of uses array iterator Get, which yields undefined for holes).
  // Gated on externref element + `usesArrayHoles`.
  if (ctx.usesArrayHoles && elemType.kind === "externref") emitHoleToUndefined(ctx, fctx);
  // Coerce from the READ value's type (packed i8/i16 arrive on the stack as the
  // widened i32, #2934) to the local's declared type.
  const elemLocalType = getLocalType(fctx, elemLocal);
  if (elemLocalType && !valTypesMatch(readElemType, elemLocalType)) {
    coerceType(ctx, fctx, readElemType, elemLocalType);
  }
  emitCoercedLocalSet(ctx, fctx, elemLocal, readElemType);

  // If destructuring pattern (binding form), destructure from the element
  if (destructPattern) {
    compileForOfDestructuring(ctx, fctx, destructPattern, elemLocal, readElemType, stmt);
  }
  // If assignment destructuring expression, assign to existing locals
  if (assignDestructExpr) {
    compileForOfAssignDestructuring(
      ctx,
      fctx,
      assignDestructExpr,
      elemLocal,
      readElemType,
      vecTypeIdx,
      arrTypeIdx,
      stmt,
    );
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
  // #1919 — transactional probe: discard body + locals + late imports + errors.
  const probeSnap = snapshotSpeculative(ctx, fctx);
  const recvType = compileExpression(ctx, fctx, receiver);
  rollbackSpeculative(ctx, fctx, probeSnap);
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
  // (#2934 1b) Same packed-element discipline as compileForOfArray: bind the
  // value local as the unpacked i32 and read with the view-name signedness —
  // a raw packed i8/i16 local or a plain `array.get` on a packed array is
  // invalid Wasm. Identity for non-packed elements.
  const readElemType = unpackedElemType(elemType);
  const elemReadOp = elemGetOp(elemType, typedArraySearchSignedness(ctx, receiver));

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
    valLocal = allocLocal(fctx, valEl.name.text, readElemType);
  } else {
    if (!ts.isIdentifier(keyEl) || !ts.isIdentifier(valEl)) {
      if (!compileForOfArrayTentative(ctx, fctx, stmt)) compileForOfIterator(ctx, fctx, stmt);
      return;
    }
    keyLocal = fctx.localMap.get(keyEl.text) ?? allocLocal(fctx, keyEl.text, { kind: "f64" });
    valLocal = fctx.localMap.get(valEl.text) ?? allocLocal(fctx, valEl.text, readElemType);
  }

  emitArrayKeysEntriesLoop(ctx, fctx, stmt, receiver, (lenLocal, iLocal, dataLocal, loopArrTypeIdx) => {
    // key = f64(i)
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "f64.convert_i32_s" });
    fctx.body.push({ op: "local.set", index: keyLocal! });
    // value = data[i] (packed i8/i16 widens to i32 on read, #2934)
    fctx.body.push({ op: "local.get", index: dataLocal });
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: elemReadOp, typeIdx: loopArrTypeIdx } as Instr);
    const valLocalType = getLocalType(fctx, valLocal!);
    if (valLocalType && !valTypesMatch(readElemType, valLocalType)) {
      coerceType(ctx, fctx, readElemType, valLocalType);
    }
    emitCoercedLocalSet(ctx, fctx, valLocal!, readElemType);
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
  // #1919 — snapshot so a non-array receiver rolls back body + locals + imports.
  const snap = snapshotSpeculative(ctx, fctx);
  const vecType = compileExpression(ctx, fctx, receiver);
  if (!vecType || (vecType.kind !== "ref" && vecType.kind !== "ref_null")) {
    rollbackSpeculative(ctx, fctx, snap);
    reportError(ctx, stmt, "for-of requires an array expression");
    return;
  }
  const vecTypeIdx = vecType.typeIdx;
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") {
    rollbackSpeculative(ctx, fctx, snap);
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
  const lenLocal = allocLocal(fctx, `__forof_len_${fctx.locals.length}`, {
    kind: "i32",
  });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // i = 0
  const iLocal = allocLocal(fctx, `__forof_i_${fctx.locals.length}`, {
    kind: "i32",
  });
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

      // Refresh getIdx in case addStringConstantGlobal shifted indices
      getIdx = ctx.funcMap.get("__extern_get");
      if (getIdx === undefined) continue;

      // Emit: __extern_get(elem, "propName") -> externref. (#51) Materialize the
      // key via the dual-mode helper — nativeStrings stores a `-1` sentinel global
      // so a bare `global.get` would crash binary emit.
      fctx.body.push({ op: "local.get", index: elemLocal });
      for (const instr of stringConstantExternrefInstrs(ctx, propName)) fctx.body.push(instr);
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
      if (ts.isSpreadElement(el)) {
        // (#2602) Rest element on the generic iterator path (any-typed iterable
        // / generator source, incl. for-await). The element local is externref —
        // push it directly and slice from index `i`.
        fctx.body.push({ op: "local.get", index: elemLocal });
        emitForOfRestAssignment(ctx, fctx, el, i, (name) => ctx.moduleGlobals.get(name));
        continue;
      }

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
          // (#51) Dual-mode key materialization (nativeStrings `-1` sentinel).
          addStringConstantGlobal(ctx, propName);
          for (const instr of stringConstantExternrefInstrs(ctx, propName)) fctx.body.push(instr);
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
  const iterMethodDef = definedFuncAt(ctx, iterMethodIdx);
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
  const nextMethodDef = definedFuncAt(ctx, nextMethodIdx);
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
  // Compile the iterable expression. (#1919) Unlike the tentative probes above,
  // every path here KEEPS the compiled iterable on the stack — it is consumed by
  // the chosen iteration loop — so there is no rollback and no snapshot to take.
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
  // under --target wasi/standalone — or, since #3050, a try-region generator
  // under the JS host), drive the loop via the generator's resume function — no
  // JS-host iterator protocol, no #681 gate. TYPE-driven, not mode-driven: the
  // state-struct type only exists when the generator registered natively, and
  // the host iterator protocol cannot iterate a WasmGC struct (a #3050
  // host-lane native generator consumed by for-of summed 0). The subject value
  // is already on the stack from compileExpression above.
  if (iterableType.kind === "ref" || iterableType.kind === "ref_null") {
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
  const resultLocal = allocLocal(fctx, `__forof_result_${fctx.locals.length}`, {
    kind: "externref",
  });
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
    // (#51) Dual-mode key materialization (nativeStrings `-1` sentinel global).
    addStringConstantGlobal(ctx, propName);
    for (const instr of stringConstantExternrefInstrs(ctx, propName)) fctx.body.push(instr);
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

/**
 * (#2575) Emit `for (k in arr)` over a WasmGC array/vec receiver: enumerate the
 * live integer-index keys `"0".."length-1"` (as strings) in ascending order,
 * per §13.7.5 / OrdinaryOwnPropertyKeys. Self-contained — no `__for_in_*` host
 * import and no `$ObjVec` walk; length is read from the vec struct (field 0) and
 * each index is ToString'd via the sealed decimal-key formatter (the same helper
 * the object runtime uses for integer keys). Works identically in host and
 * standalone mode. Shares the `block $break { loop { cond; block $continue {
 * body } incr; br } }` scaffolding with the dynamic-object path so `break` /
 * `continue` / nested-loop depth handling is consistent.
 */
function emitArrayForIn(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForInStatement,
  arrayInfo: { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType },
  keyLocal: number,
  memberTarget: ts.PropertyAccessExpression | ts.ElementAccessExpression | null,
  bindingPattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern | null,
): void {
  const { vecTypeIdx } = arrayInfo;

  // Decimal-key formatter (f64 -> externref) for the integer index. Reuses the
  // sealed engine helper — NOT a hand-rolled ToString — via the SAME registration
  // array `.join`/`.toString` use. Dual-mode: no-JS-host (standalone / wasi /
  // nativeStrings) registers the DEFINED native (the helper is not in
  // UNION_NATIVE_HELPER_NAMES, so a late host import would leak `env::*` there);
  // JS-host uses the host import (the native formatter needs NativeString GC
  // types host mode doesn't register — registering them there bakes a `-1`
  // heap-type ref, the #2043 class). Register before the funcIdx capture so the
  // late-import index shift settles first.
  const NUM_FMT = "number_toString";
  if (ctx.standalone || ctx.wasi || ctx.nativeStrings) {
    emitNativeNumberFormat(ctx, new Set([NUM_FMT]));
  } else if (ctx.funcMap.get(NUM_FMT) === undefined) {
    ensureLateImport(ctx, NUM_FMT, [{ kind: "f64" }], [{ kind: "externref" }]);
  }
  flushLateImportShifts(ctx, fctx);
  const numToStrIdx = ctx.funcMap.get(NUM_FMT);

  // Compile the array expression into a vec ref local. A null/undefined receiver
  // would throw in JS; for-in over null/undefined is spec'd as a no-op (§13.7.5.1
  // step 2 returns when the value is undefined/null), so guard with ref.is_null.
  const vecLocal = allocLocal(fctx, `__forin_arr_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecTypeIdx });
  const exprType = compileExpression(ctx, fctx, stmt.expression);
  if (exprType && (exprType.kind === "ref" || exprType.kind === "ref_null")) {
    // already a vec ref
  } else if (exprType && exprType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: vecTypeIdx } as Instr);
  }
  fctx.body.push({ op: "local.set", index: vecLocal });

  // length = vec.field0  (0 when the ref is null → loop body never runs)
  const lenLocal = allocLocal(fctx, `__forin_len_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: 0 } as Instr],
    else: [
      { op: "local.get", index: vecLocal } as Instr,
      { op: "ref.as_non_null" } as Instr,
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 } as Instr,
    ],
  } as Instr);
  fctx.body.push({ op: "local.set", index: lenLocal });

  // Counter i = 0
  const iLocal = allocLocal(fctx, `__forin_i_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // Build the user body (block+loop+block adds 3 nesting levels — same as the
  // dynamic-object path), with the per-iteration head write for non-identifier
  // heads (#1613).
  const savedBody = pushBody(fctx);
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! += 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! += 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth += 3;
  adjustRethrowDepth(fctx, 3);
  fctx.breakStack.push(2);
  fctx.continueStack.push(0);

  if (memberTarget) {
    emitForInMemberTargetWrite(ctx, fctx, memberTarget, keyLocal);
  } else if (bindingPattern) {
    if (ts.isArrayBindingPattern(bindingPattern)) {
      fctx.body.push({ op: "local.get", index: keyLocal });
      compileExternrefArrayDestructuringDecl(ctx, fctx, bindingPattern, { kind: "externref" });
    } else {
      fctx.body.push({ op: "local.get", index: keyLocal });
      compileExternrefObjectDestructuringDecl(ctx, fctx, bindingPattern, { kind: "externref" });
    }
  }

  if (ts.isBlock(stmt.statement)) {
    const savedScope = saveBlockScopedShadows(fctx, stmt.statement);
    for (const s of stmt.statement.statements) compileStatement(ctx, fctx, s);
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, stmt.statement);
  }

  const userBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]! -= 3;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]! -= 3;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth -= 3;
  adjustRethrowDepth(fctx, -3);
  popBody(fctx, savedBody);

  const loopBody: Instr[] = [];
  // Condition: i >= length → break ($break is depth 1 from inside $loop)
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "local.get", index: lenLocal });
  loopBody.push({ op: "i32.ge_s" });
  loopBody.push({ op: "br_if", depth: 1 });

  // key = <decimal formatter>(f64(i))  → keyLocal (externref string)
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "f64.convert_i32_s" });
  if (numToStrIdx !== undefined) {
    loopBody.push({ op: "call", funcIdx: numToStrIdx });
  }
  loopBody.push({ op: "local.set", index: keyLocal });

  // block $continue { userBody }
  loopBody.push({ op: "block", blockType: { kind: "empty" }, body: userBody });

  // increment + restart
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "i32.const", value: 1 });
  loopBody.push({ op: "i32.add" });
  loopBody.push({ op: "local.set", index: iLocal });
  loopBody.push({ op: "br", depth: 0 });

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });
}

/**
 * (#2705) Is the for-in receiver statically the `null`/`undefined`/`void`
 * literal? §14.7.5.6 ForIn/OfHeadEvaluation step 7 yields zero iterations for a
 * nullish receiver. Detect the literal forms syntactically (the checker can
 * widen the receiver to `any`, so a type-based test is unreliable). Conservative
 * by design — a runtime-nullish receiver (`for (k in maybeNull)`) is NOT covered
 * here and would still enumerate; only the statically-provable literal nullish
 * forms short-circuit.
 */
function isStaticNullishReceiver(expr: ts.Expression): boolean {
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(expr) && expr.text === "undefined") return true;
  if (ts.isVoidExpression(expr)) return true;
  if (ts.isParenthesizedExpression(expr)) return isStaticNullishReceiver(expr.expression);
  return false;
}

/**
 * (#2705) Which of a `for (let/const <head> in …)` head's bound names are
 * referenced from a nested closure anywhere in the receiver, the ForDeclaration
 * (binding-pattern default initializers), or the body? Such names must be boxed
 * into a ref cell so the closure captures the binding by reference — for the
 * head TDZ environment (a closure built in the receiver captures the
 * never-initialized binding → `typeof x` throws) and the per-iteration
 * environment. Mirrors `findHeadBindingsCapturedByClosures` (the C-style-loop
 * analogue) but walks the for-in's receiver/ForDeclaration/body.
 */
function collectForInHeadClosureCaptures(stmt: ts.ForInStatement, headNames: ReadonlySet<string>): Set<string> {
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
      const refs = new Set<string>();
      collectReferencedIdentifiers(node, refs);
      for (const n of headNames) if (refs.has(n)) captured.add(n);
      return; // collectReferencedIdentifiers already walked nested closures.
    }
    forEachChild(node, visit);
  }
  visit(stmt.expression); // receiver (head TDZ scope)
  visit(stmt.initializer); // ForDeclaration — binding-pattern default initializers
  visit(stmt.statement); // body
  return captured;
}

/**
 * (#2705) Saved outer-scope binding for a for-in head name, so the head's
 * lexical environment can be torn down and the outer binding restored after the
 * loop (no leak — `head-bound` names must not escape per §14.7.5.7).
 */
interface ForInHeadSaved {
  name: string;
  localMap: number | undefined;
  tdz: number | undefined;
  boxed: { refCellTypeIdx: number; valType: ValType } | undefined;
  boxedTdz: { localIdx: number; refCellTypeIdx: number } | undefined;
  isConst: boolean;
}

export function compileForInStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForInStatement): void {
  // Get the loop variable name
  const init = stmt.initializer;
  // (#2705) Unwrap a CoverParenthesizedExpression head — `for ((x) in obj)` /
  // `for ((a.b) in obj)`. The parenthesized form parses as a
  // ParenthesizedExpression wrapping the real LHS target. A
  // VariableDeclarationList is never parenthesized, so only the expression
  // branches dispatch on `head`.
  let head: ts.Node = init;
  while (ts.isParenthesizedExpression(head)) head = head.expression;
  // (#2705) A `let`/`const` head needs a per-iteration lexical environment with
  // a TDZ binding (§14.7.5.6/.7). A `var` head reuses the function-scope slot
  // the var-hoister already allocated. The non-strict `for (let in obj)` legacy
  // form (an *empty* VariableDeclarationList — see below) is an identifier
  // reference, not a ForDeclaration, so it is NOT treated as lexical.
  const isLexicalHead =
    ts.isVariableDeclarationList(init) &&
    init.declarations.length > 0 &&
    !!(init.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));

  // (#2705 Slice B) Snapshot the OUTER binding of each head bound name BEFORE the
  // dispatch below allocates the head's own local — for a plain-identifier let
  // head the dispatch does `localMap.set(x, keyLocal)`, overwriting the true
  // outer slot, so capturing the save afterwards would restore to `keyLocal`
  // (the leaked head binding) instead of the enclosing scope's `x`. The head
  // names come straight from the ForDeclaration. Used to install the head TDZ
  // env around the receiver compile (host path) and to restore the outer
  // bindings after the loop so head names do not leak (§14.7.5.7).
  const headNames: string[] = [];
  const headSaved: ForInHeadSaved[] = [];
  if (isLexicalHead) {
    const headDecl = init.declarations[0]!;
    for (const n of collectPatternBindingNames(headDecl.name)) headNames.push(n);
    for (const name of headNames) {
      headSaved.push({
        name,
        localMap: fctx.localMap.get(name),
        tdz: fctx.tdzFlagLocals?.get(name),
        boxed: fctx.boxedCaptures?.get(name),
        boxedTdz: fctx.boxedTdzFlags?.get(name),
        isConst: fctx.constBindings?.has(name) ?? false,
      });
    }
  }
  let varName: string;
  let keyLocal: number;
  // For non-identifier heads (binding pattern / member-expression target) the
  // enumerated key is materialised in a temp externref local, then written to
  // the real target each iteration (#1613). These describe that write.
  let bindingPattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern | null = null;
  let memberTarget: ts.PropertyAccessExpression | ts.ElementAccessExpression | null = null;
  if (ts.isVariableDeclarationList(init)) {
    if (init.declarations.length === 0) {
      // (#2705) `for (let in obj)` in non-strict mode: TS parses the head as a
      // VariableDeclarationList with ZERO declarations (the `let` token is
      // consumed as the list keyword and the identifier text is lost). Per the
      // grammar's `[lookahead ∉ { let [ }]` restriction, a `let` not followed by
      // `[` is the *identifier* `let`. `var`/`const` cannot produce an empty
      // list (both are reserved as identifiers), so the name is unambiguously
      // "let" — a real, writable binding visible after the loop.
      varName = "let";
      const existingLocal = fctx.localMap.get(varName);
      keyLocal = existingLocal !== undefined ? existingLocal : allocLocal(fctx, varName, { kind: "externref" });
    } else {
      const decl = init.declarations[0]!;
      if (!ts.isIdentifier(decl.name)) {
        // Destructuring binding head: `for (var/let [a] in obj)`. The key is a
        // string; per spec the binding pattern destructures that string value.
        bindingPattern = decl.name;
        varName = `__forin_key_${fctx.locals.length}`;
        keyLocal = allocLocal(fctx, varName, { kind: "externref" });
      } else {
        varName = decl.name.text;
        if (!isLexicalHead) {
          // (#2705) `var` head: reuse the function-scope slot the var-hoister
          // already allocated so the body's `var x` re-declaration and the
          // post-loop read all resolve to the SAME slot. Allocating a fresh
          // local here shadowed the hoisted one (writes never reached the body's
          // view of `x`).
          const existingLocal = fctx.localMap.get(varName);
          keyLocal = existingLocal !== undefined ? existingLocal : allocLocal(fctx, varName, { kind: "externref" });
        } else {
          // let/const head: fresh block-scoped local (Slice B refines this into
          // a per-iteration ref cell + TDZ flag).
          keyLocal = allocLocal(fctx, varName, { kind: "externref" });
        }
      }
    }
  } else if (ts.isPropertyAccessExpression(head) || ts.isElementAccessExpression(head)) {
    // Member-expression target: `for (x.y in obj)` / `for (x[k] in obj)`.
    // Per spec the enumerated key is assigned to the reference each iteration.
    memberTarget = head;
    varName = `__forin_key_${fctx.locals.length}`;
    keyLocal = allocLocal(fctx, varName, { kind: "externref" });
  } else if (ts.isIdentifier(head)) {
    // Bare identifier: `for (x in obj)` — look up existing local
    varName = head.text;
    const existingLocal = fctx.localMap.get(varName);
    if (existingLocal !== undefined) {
      keyLocal = existingLocal;
    } else {
      // Variable might be a global or not yet declared — allocate as local
      keyLocal = allocLocal(fctx, varName, { kind: "externref" });
    }
  } else if (
    ts.isBinaryExpression(head) &&
    head.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isIdentifier(head.left)
  ) {
    // Assignment expression: `for (x = defaultVal in obj)` — compile assignment, use the target
    varName = head.left.text;
    const existingLocal = fctx.localMap.get(varName);
    if (existingLocal !== undefined) {
      keyLocal = existingLocal;
    } else {
      keyLocal = allocLocal(fctx, varName, { kind: "externref" });
    }
    // Compile the initializer assignment (default value)
    compileExpression(ctx, fctx, head.right);
    fctx.body.push({ op: "local.set", index: keyLocal });
  } else {
    reportError(ctx, stmt, "for-in requires a variable declaration or identifier");
    return;
  }

  // (#2705) §14.7.5.6 step 7: a `null`/`undefined` receiver yields zero
  // iterations. When the receiver is statically the `null`/`undefined`/`void`
  // literal, emit NO loop — the body is never reached (so a body that would
  // compile to invalid Wasm, e.g. a lexical-decl-only statement after ASI, is
  // correctly skipped) and the enumeration primitives are never invoked over a
  // null ref (which trapped / produced invalid Wasm before). `var`-hoisting
  // already ran in the function pre-pass, so nothing is lost by the early exit.
  if (isStaticNullishReceiver(stmt.expression)) {
    return;
  }

  // (#2575) Array receiver: enumerate the live numeric indices, not the static
  // array TYPE members. `for (k in arr)` must yield the own enumerable keys —
  // the integer-index keys "0".."length-1" as strings, ascending
  // (§13.7.5 / OrdinaryOwnPropertyKeys). The receiver lowers to a WasmGC vec
  // struct (not `$Object`, so `__object_keys` returns empty; not a closed
  // struct, so the static-unroll path enumerated `length`+prototype members =
  // wrong, and host mode enumerated nothing). Emit a self-contained native
  // index loop here for BOTH host and standalone — length from vec field 0,
  // each index ToString'd via the sealed decimal-key formatter, no host import.
  const recvArrayInfo = resolveArrayInfo(ctx, ctx.checker.getTypeAtLocation(stmt.expression));
  if (recvArrayInfo) {
    emitArrayForIn(ctx, fctx, stmt, recvArrayInfo, keyLocal, memberTarget, bindingPattern);
    return;
  }

  // Resolve the four enumeration primitives. In JS-host mode these are the
  // `__for_in_*` host imports. In a no-JS-host target (standalone / WASI) the
  // host imports are unavailable, so route through the native object-runtime
  // (#2572): `__object_keys` returns a `$ObjVec` of the live + enumerable own
  // keys in OrdinaryOwnPropertyKeys order (#1837), and `__extern_length` /
  // `__extern_get_idx` / `__extern_has` are `$ObjVec`-aware native helpers. The
  // four have signatures 1:1 compatible with `__for_in_keys/_len/_get/_has`, so
  // the loop scaffolding below is identical for both modes. This replaces the
  // old static-unroll fallback, which enumerated the receiver's *static* shape
  // and was therefore wrong for a runtime-mutated dynamic object (a key added
  // or deleted at runtime was invisible / stale).
  let keysIdx = ctx.funcMap.get("__for_in_keys");
  let lenIdx = ctx.funcMap.get("__for_in_len");
  let getIdx = ctx.funcMap.get("__for_in_get");
  let hasIdx = ctx.funcMap.get("__for_in_has");

  if ((keysIdx === undefined || lenIdx === undefined || getIdx === undefined) && (ctx.standalone || ctx.wasi)) {
    // No-JS-host target: the `__for_in_*` host imports are intentionally not
    // registered (#2572, declarations.ts). For a receiver that lowers to the
    // dynamic `$Object` representation (an `any`/index-signature object whose
    // keys are determined at runtime), route through the native object runtime:
    // `__object_keys` returns a `$ObjVec` of the live + enumerable own keys in
    // OrdinaryOwnPropertyKeys order (#1837); `__extern_length`/`__extern_get_idx`
    // /`__extern_has` are `$ObjVec`-aware native helpers with signatures 1:1
    // compatible with `__for_in_keys/_len/_get/_has`, so the loop scaffolding
    // below is shared. A closed WasmGC struct or an array does NOT lower to
    // `$Object` (so `__object_keys` would return empty) — those keep the
    // static-unroll path below, which is exact for a non-mutated closed shape.
    const recvWasmType = resolveWasmType(ctx, ctx.checker.getTypeAtLocation(stmt.expression));
    const isDynamicReceiver =
      recvWasmType.kind === "externref" || recvWasmType.kind === "anyref" || recvWasmType.kind === "ref_extern";
    if (isDynamicReceiver) {
      ensureObjectRuntime(ctx);
      // #2964 — for-in must enumerate inherited enumerable keys too, so route
      // through `__object_keys_forin` (own ordered keys per level + `$proto`
      // walk with shadow-skip), NOT the OWN-only `__object_keys` (which powers
      // Object.keys). Same `$ObjVec` return shape, so the loop scaffolding and
      // the `__extern_length`/`__extern_get_idx`/`__extern_has` accessors below
      // are unchanged.
      keysIdx = ctx.funcMap.get("__object_keys_forin");
      lenIdx = ctx.funcMap.get("__extern_length");
      getIdx = ctx.funcMap.get("__extern_get_idx");
      hasIdx = ctx.funcMap.get("__extern_has");
    }
  }

  if (keysIdx === undefined || lenIdx === undefined || getIdx === undefined) {
    // Fallback: static unrolling. Used in standalone for a closed-shape receiver
    // (WasmGC struct) — the static key set is exact — and as the historical
    // fallback when no enumeration primitive is available.
    const exprType = ctx.checker.getTypeAtLocation(stmt.expression);
    const props = exprType.getProperties();
    if (props.length === 0) return;
    for (const prop of props) {
      // (#51) Materialize each enumerated key via the dual-mode helper. Under
      // nativeStrings `stringGlobalMap` holds a `-1` sentinel global, so the old
      // `global.get <sentinel>` reached binary emit as "global index out of
      // range — -1". `stringConstantExternrefInstrs` emits the NativeString
      // inline (externref) standalone and a host `global.get` only under GC.
      addStringConstantGlobal(ctx, prop.name);
      for (const instr of stringConstantExternrefInstrs(ctx, prop.name)) fctx.body.push(instr);
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

  // (#2705 Slice B) For a `let`/`const` head, §14.7.5.6 ForIn/OfHeadEvaluation
  // step 2 puts the head's bound names in a fresh TDZ environment while the
  // RECEIVER is evaluated — so a read of a head name inside the receiver (direct
  // `{ x }`, or via a closure built there) throws ReferenceError / `typeof`
  // throws. We install that TDZ env now, compile the receiver, then tear it down
  // (step 4) before the per-iteration body binds the names to the key. The outer
  // binding was snapshot into `headSaved` (BEFORE the dispatch) and is restored
  // after the loop so the head names do not leak.
  if (isLexicalHead) {
    const captured = collectForInHeadClosureCaptures(stmt, new Set(headNames));
    for (const name of headNames) {
      if (captured.has(name)) {
        // Closure-captured head name → box the binding + its TDZ flag so the
        // closure captures them by reference. The receiver-env cell is NEVER
        // initialized (TDZ flag stays 0), so a closure built in the receiver
        // observes a permanent TDZ.
        const valCellTypeIdx = getOrRegisterRefCellType(ctx, { kind: "externref" });
        const boxLocal = allocLocal(fctx, `__forin_hbox_${name}_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: valCellTypeIdx,
        });
        fctx.body.push({ op: "ref.null.extern" } as Instr); // placeholder value
        fctx.body.push({ op: "struct.new", typeIdx: valCellTypeIdx });
        fctx.body.push({ op: "local.set", index: boxLocal });
        const flagCellTypeIdx = getOrRegisterRefCellType(ctx, { kind: "i32" });
        const flagBoxLocal = allocLocal(fctx, `__forin_hflag_${name}_${fctx.locals.length}`, {
          kind: "ref_null",
          typeIdx: flagCellTypeIdx,
        });
        fctx.body.push({ op: "i32.const", value: 0 }); // uninitialized
        fctx.body.push({ op: "struct.new", typeIdx: flagCellTypeIdx });
        fctx.body.push({ op: "local.set", index: flagBoxLocal });
        fctx.localMap.set(name, boxLocal);
        if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
        fctx.boxedCaptures.set(name, { refCellTypeIdx: valCellTypeIdx, valType: { kind: "externref" } });
        if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
        fctx.tdzFlagLocals.set(name, flagBoxLocal);
        if (!fctx.boxedTdzFlags) fctx.boxedTdzFlags = new Map();
        fctx.boxedTdzFlags.set(name, { localIdx: flagBoxLocal, refCellTypeIdx: flagCellTypeIdx });
      } else {
        // Not captured — a plain local + a plain (i32, zero-init = uninitialized)
        // TDZ flag suffice. The value slot is never read (TDZ throws first).
        const slot = allocLocal(fctx, `__forin_hbind_${name}_${fctx.locals.length}`, { kind: "externref" });
        const flagLocal = allocLocal(fctx, `__forin_hflag_${name}_${fctx.locals.length}`, { kind: "i32" });
        fctx.localMap.set(name, slot);
        if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
        fctx.tdzFlagLocals.set(name, flagLocal);
        fctx.boxedCaptures?.delete(name);
        fctx.boxedTdzFlags?.delete(name);
      }
      fctx.constBindings?.delete(name);
    }
  }

  const exprType = compileExpression(ctx, fctx, stmt.expression);
  if (exprType && exprType.kind !== "externref") {
    coerceType(ctx, fctx, exprType, { kind: "externref" });
  }

  // (#2705 Slice B) Tear down the head TDZ env (HeadEvaluation step 4). The
  // per-iteration body now binds the head names afresh: a binding-pattern head
  // re-allocates them via the destructuring path below; a plain-identifier head
  // uses `keyLocal` (which receives keys[i] each iteration). Remove the TDZ-env
  // entries so the body reads resolve to the per-iteration binding, not the
  // never-initialized receiver-env cell.
  if (isLexicalHead) {
    for (const s of headSaved) {
      fctx.localMap.delete(s.name);
      fctx.tdzFlagLocals?.delete(s.name);
      fctx.boxedCaptures?.delete(s.name);
      fctx.boxedTdzFlags?.delete(s.name);
      fctx.constBindings?.delete(s.name);
    }
    if (bindingPattern === null && memberTarget === null) {
      // Plain-identifier head: `keyLocal` is the per-iteration binding.
      fctx.localMap.set(varName, keyLocal);
      if (init.flags & ts.NodeFlags.Const) {
        if (!fctx.constBindings) fctx.constBindings = new Set();
        fctx.constBindings.add(varName);
      }
    }
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

  // (#2705 Slice B) Restore the outer bindings the head TDZ / per-iteration env
  // shadowed, so the head names do not leak past the loop (§14.7.5.7 — the
  // lexical bindings are scoped to the loop). Without this, `let x = 'outside';
  // for (let x in obj) …; x /* === 'outside' */` would observe the loop's last
  // binding instead.
  for (const s of headSaved) {
    if (s.localMap !== undefined) fctx.localMap.set(s.name, s.localMap);
    else fctx.localMap.delete(s.name);
    if (s.tdz !== undefined) {
      if (!fctx.tdzFlagLocals) fctx.tdzFlagLocals = new Map();
      fctx.tdzFlagLocals.set(s.name, s.tdz);
    } else fctx.tdzFlagLocals?.delete(s.name);
    if (s.boxed !== undefined) {
      if (!fctx.boxedCaptures) fctx.boxedCaptures = new Map();
      fctx.boxedCaptures.set(s.name, s.boxed);
    } else fctx.boxedCaptures?.delete(s.name);
    if (s.boxedTdz !== undefined) {
      if (!fctx.boxedTdzFlags) fctx.boxedTdzFlags = new Map();
      fctx.boxedTdzFlags.set(s.name, s.boxedTdz);
    } else fctx.boxedTdzFlags?.delete(s.name);
    if (s.isConst) {
      if (!fctx.constBindings) fctx.constBindings = new Set();
      fctx.constBindings.add(s.name);
    } else fctx.constBindings?.delete(s.name);
  }
}
