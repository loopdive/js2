import { isStringType } from "../../checker/type-mapper.js";
import { isStandalonePromiseActive } from "../async-scheduler.js";
import type { Instr, ValType } from "../../ir/types.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Loop statement lowering: while, for, do-while, for-of, for-in.
 */
import { ts } from "../../ts-api.js";
import { popBody, pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import { allocLocal, getLocalType } from "../context/locals.js";
import { snapshotSpeculative, rollbackSpeculative } from "../context/speculative.js";
import type { CodegenContext, FunctionContext, HoistedCharRead } from "../context/types.js";
import { emitCoercedLocalSet, emitWebCompatCallAssignmentTarget } from "../expressions/helpers.js";
import { ensureLateImport, flushLateImportShifts, shiftLateImportIndices } from "../expressions/late-imports.js";
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
import { emitCollectionIteratorVec, ensureMapHelpers, MAP_LAYOUT } from "../map-runtime.js";
import { elemGetOp, resolveArrayInfo, typedArraySearchSignedness, unpackedElemType } from "../array-methods.js";
import { flatStringType, stringConstantExternrefInstrs } from "../native-strings.js";
import { emitNativeNumberFormat } from "../number-format-native.js";
import { ensureObjectRuntime } from "../object-runtime.js";
import { coercionInstrs, defaultValueInstrs } from "../type-coercion.js";
import {
  addForInImports,
  addImport,
  addStringConstantGlobal,
  ensureExnTag,
  localGlobalIdx,
} from "../registry/imports.js";
import {
  addFuncType,
  getArrTypeIdxFromVec,
  getOrRegisterRefCellType,
  getOrRegisterVecBaseType,
} from "../registry/types.js";
import { overlayRouteActive } from "../typed-lane-overlay-route.js"; // (#4222) overlay-aware index presence
import { reserveVecIndexEnumerable } from "../vec-index-enumerable.js"; // (#4491) overlay-aware index [[Enumerable]]
import { coerceType, compileExpression, compileStatement, valTypesMatch } from "../shared.js";
import {
  compileArrayDestructuring,
  compileExternrefArrayDestructuringDecl,
  compileExternrefObjectDestructuringDecl,
  compileObjectDestructuring,
  ensureAsyncIterator,
} from "./destructuring.js";
import { emitForInStaticUnroll } from "./for-in-static-unroll.js"; // (#4561)
import { blockLoop, restoreBlockScopedShadows, saveBlockScopedShadows, shiftLoopDepths } from "./shared.js";
import {
  bodyHasMatchingCharRead,
  collectBindingNames,
  collectForInHeadClosureCaptures,
  detectI32LoopVar,
  findAllNamesCapturedByClosuresInForLoop,
  findBodyLocalLexicalNames,
  findHeadBindingsCapturedByClosures,
  forOfDstrNeedsInboundsUndef,
  isIncreasingStep,
  isStaticNullishReceiver,
  loopBodyMutatesIndexOrArray,
  loopBodyMutatesStringReadInvariants,
  varCounterRedeclarationBlocksI32,
} from "../../ir/analysis/loop-shape.js";
import { emitForAwaitElementUnwrap, emitForAwaitStepCapCheck } from "./for-await-helpers.js";
import { buildStandardTryTable } from "../../ir/try-table.js";
import {
  compileForOfAssignDestructuring,
  compileForOfDestructuring,
  compileForOfIteratorAssignDestructuring,
} from "./for-of-destructuring.js";
import { collectPatternBindingNames } from "./tdz.js";
import { tryCompileCountedStringAppend } from "./counted-string-append.js";
import { emitHoleToUndefined } from "../array-holes.js"; // (#2001 S1)
import { definedFuncAt, nativeStrHelperHandle } from "../func-space.js"; // (#1916 S2) positional-read chokepoint

/**
 * Compile a loop body, saving/restoring block-scoped shadows (#817) so that
 * `let`/`const` declared at the top of the body don't leak into the outer
 * scope. Extracted from 11 identical inline copies (#3269 DRY).
 */
function compileLoopBodyWithShadows(ctx: CodegenContext, fctx: FunctionContext, body: ts.Statement): void {
  if (ts.isBlock(body)) {
    const savedScope = saveBlockScopedShadows(fctx, body);
    for (const s of body.statements) {
      compileStatement(ctx, fctx, s);
    }
    restoreBlockScopedShadows(fctx, savedScope);
  } else {
    compileStatement(ctx, fctx, body);
  }
}

/** Emit the unobserved step of an already-promoted i32 induction variable. */
function emitPromotedI32Increment(fctx: FunctionContext, stmt: ts.ForStatement): boolean {
  const loop = detectI32LoopVar(stmt);
  const incrementor = stmt.incrementor;
  if (!loop || !incrementor) return false;
  const localIdx = fctx.localMap.get(loop.name);
  if (localIdx === undefined || getLocalType(fctx, localIdx)?.kind !== "i32") return false;

  let step: number | undefined;
  if (ts.isPostfixUnaryExpression(incrementor) || ts.isPrefixUnaryExpression(incrementor)) {
    step = incrementor.operator === ts.SyntaxKind.PlusPlusToken ? 1 : -1;
  } else if (ts.isBinaryExpression(incrementor) && ts.isNumericLiteral(incrementor.right)) {
    const magnitude = Number(incrementor.right.text.replace(/_/g, ""));
    if (incrementor.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) step = magnitude;
    if (incrementor.operatorToken.kind === ts.SyntaxKind.MinusEqualsToken) step = -magnitude;
  } else if (
    ts.isBinaryExpression(incrementor) &&
    incrementor.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isBinaryExpression(incrementor.right) &&
    ts.isNumericLiteral(incrementor.right.right)
  ) {
    const magnitude = Number(incrementor.right.right.text.replace(/_/g, ""));
    step = incrementor.right.operatorToken.kind === ts.SyntaxKind.PlusToken ? magnitude : -magnitude;
  }
  if (step === undefined || !Number.isInteger(step)) return false;

  // The incrementor's value is discarded by ForBodyEvaluation, so update the
  // proven i32 slot directly instead of round-tripping it through f64 JS-number
  // addition and truncation on every iteration.
  fctx.body.push({ op: "local.get", index: localIdx });
  fctx.body.push({ op: "i32.const", value: step });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: localIdx });
  return true;
}

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
  shiftLoopDepths(fctx, 3);

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
  compileLoopBodyWithShadows(ctx, fctx, stmt.statement);

  const bodyInstrs = fctx.body;

  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  shiftLoopDepths(fctx, -3);

  popBody(fctx, savedBody);

  const loopBody: Instr[] = [
    ...condInstrs,
    { op: "block", blockType: { kind: "empty" }, body: bodyInstrs },
    ...arenaReset,
    { op: "br", depth: 0 },
  ];
  fctx.body.push(blockLoop(loopBody));
  ctx.liveBodies.delete(condInstrs);
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

export function compileForStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ForStatement): void {
  // (#1004) Counted-append string-loop aggregation: `for (let i=A;i<B;i++) s = s + FRAG`
  // → `s += FRAG.repeat(N)`. Provably-identical fast path; returns true when handled.
  if (tryCompileCountedStringAppend(ctx, fctx, stmt)) return;
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

      // A lexical loop-head binding shadows the complete outer storage
      // descriptor, not just its localMap entry. If the outer name was boxed
      // for a closure, leaving boxedCaptures active makes reads of the fresh
      // scalar loop slot perform ref-cell operations on that scalar.
      if (!savedForBoxedCaptures) savedForBoxedCaptures = new Map();
      savedForBoxedCaptures.set(name, fctx.boxedCaptures?.get(name));
      fctx.boxedCaptures?.delete(name);

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
        //
        // #3343: a `let`/`const` for-head is a FRESH block binding (ECMA-262
        // §14.7.4) — inside a function it must be a per-invocation local, NEVER a
        // same-named module global (recursion would clobber the shared counter;
        // compiled-acorn's top-level `i` → `$__mod_i` runaway). `let`/`const`
        // aren't hoisted into `localMap`, so `hasLocalShadow` missed them. Only
        // `__module_init` (module top level) keeps the global. `var` unchanged.
        // Full write-up in the #3343 issue.
        const hasLocalShadow = fctx.localMap.has(name);
        const blockScopedInsideFunction = !isVar && fctx.name !== "__module_init";
        const moduleGlobalIdx = hasLocalShadow || blockScopedInsideFunction ? undefined : ctx.moduleGlobals.get(name);
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
        // counter (e.g. for (let i = 0; i < n; i++)), use i32 instead of f64.
        // (#3419) `var` counters share ONE function-scoped local across every
        // redeclaration — promotion is only sound when every other `var <name>`
        // in the scope is the same promotable counter shape; otherwise one loop
        // emits i32 ops and another f64 ops against the same local (invalid
        // wasm — see varCounterRedeclarationBlocksI32).
        const i32LoopInfo = detectI32LoopVar(stmt);
        const isI32LoopVar =
          i32LoopInfo !== null &&
          i32LoopInfo.name === name &&
          wasmType.kind === "f64" &&
          !(isVar && varCounterRedeclarationBlocksI32(stmt, name));
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
      if (!savedForBoxedCaptures.has(name)) {
        savedForBoxedCaptures.set(name, fctx.boxedCaptures?.get(name));
      }

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
  shiftLoopDepths(fctx, 3);

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
  compileLoopBodyWithShadows(ctx, fctx, stmt.statement);
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
    if (!emitPromotedI32Increment(fctx, stmt)) {
      const resultType = compileExpression(ctx, fctx, stmt.incrementor);
      if (resultType !== null) fctx.body.push({ op: "drop" });
    }
  }

  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  shiftLoopDepths(fctx, -3);

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

  fctx.body.push(blockLoop(loopBody));

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
          { op: "local.get", index: pb.boxedLocal },
          { op: "ref.as_non_null" },
          {
            op: "struct.get",
            typeIdx: pb.refCellTypeIdx,
            fieldIdx: 0,
          },
          { op: "local.set", index: pb.originalLocalIdx },
        ],
      });
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
  shiftLoopDepths(fctx, 3);

  // From body inside $continue block:
  //   break = br 2 (exits $break block)
  //   continue = br 0 (exits $continue block, falls through to condition)
  fctx.breakStack.push(2);
  fctx.continueStack.push(0);

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  compileLoopBodyWithShadows(ctx, fctx, stmt.statement);
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
  shiftLoopDepths(fctx, -3);

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

  fctx.body.push(blockLoop(loopBody));

  // (#1690) The cond Instr objects are now reachable via fctx.body → loop.
  ctx.liveBodies.delete(condInstrs);
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
    { op: "local.get", index: mTmp },
    { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES },
    { op: "local.get", index: iTmp },
    { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx },
    { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx },
    { op: "local.set", index: entryTmp },
  ];

  // Externalize a $MapEntry field then coerce to the bound local's type, mirroring
  // the forEach driver (entry fields are stored anyref / boxed externref).
  const bindFromEntry = (field: number, targetType: ValType, targetLocal: number): Instr[] => [
    { op: "local.get", index: entryTmp },
    { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: field },
    { op: "extern.convert_any" },
    ...coercionInstrs(ctx, { kind: "externref" }, targetType, fctx),
    { op: "local.set", index: targetLocal },
  ];

  // i = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });

  // Build the loop body (block { loop { body-block } }) — 3 nesting levels, so
  // adjust break/continue/return depths like compileForOfArray.
  const savedBody = pushBody(fctx);
  shiftLoopDepths(fctx, 3);
  fctx.breakStack.push(2); // break = exit outer block
  fctx.continueStack.push(0); // continue = exit body block, then increment

  // if i >= entryCount → break
  fctx.body.push({ op: "local.get", index: iTmp });
  fctx.body.push({ op: "local.get", index: mTmp });
  fctx.body.push({ op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRYCOUNT });
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
  fctx.body.push({ op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_HASH });
  fctx.body.push({ op: "i32.const", value: TOMBSTONE_BIT });
  fctx.body.push({ op: "i32.and" });
  fctx.body.push({ op: "br_if", depth: 0 });

  // Bind k ← entry.key (Set: value === key), v ← entry.value.
  fctx.body.push(...bindFromEntry(isSet ? F_VALUE : F_KEY, keyType, keyLocal));
  fctx.body.push(...bindFromEntry(F_VALUE, valType, valLocal));

  // Compile the user body inside its own block so `continue` (br depth 0 from
  // inside the body) exits the body block and falls through to the loop's `br`.
  const savedLoopBody = pushBody(fctx);
  compileLoopBodyWithShadows(ctx, fctx, stmt.statement);
  const bodyInstrs = fctx.body;
  popBody(fctx, savedLoopBody);
  fctx.body.push({ op: "block", blockType: { kind: "empty" }, body: bodyInstrs });

  // continue loop (cursor was already advanced above).
  fctx.body.push({ op: "br", depth: 0 });

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();
  shiftLoopDepths(fctx, -3);
  popBody(fctx, savedBody);

  fctx.body.push(blockLoop(loopBody));
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
  // for the legacy path.
  //
  // (#3909) That scan is now the SECOND choice — `nativeStrHelpers` holds
  // unshiftable stable handles since #1916 S3. See `nativeStrHelperHandle`.
  const flattenIdx = nativeStrHelperHandle(ctx, "__str_flatten");
  const substringIdx = nativeStrHelperHandle(ctx, "__str_substring");
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
  shiftLoopDepths(fctx, 2);

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
      },
    ],
  });

  // Get element: c = __str_substring(flat, i, i + take)
  fctx.body.push({ op: "local.get", index: flatLocal });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: takeLocal });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "call", funcIdx: substringIdx });
  fctx.body.push({ op: "local.set", index: elemLocal });
  if (!ts.isVariableDeclarationList(stmt.initializer)) {
    emitWebCompatCallAssignmentTarget(ctx, fctx, stmt.initializer);
  }

  // Compile body — save/restore block-scoped shadows for let/const (#817).
  compileLoopBodyWithShadows(ctx, fctx, stmt.statement);

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
  shiftLoopDepths(fctx, -2);

  popBody(fctx, savedBody);

  fctx.body.push(blockLoop(loopBody));

  // Null guard: if string ref is nullable, throw TypeError on null (#775)
  // In JS, `for (const c of null)` throws TypeError
  if (strType.kind === "ref_null") {
    const guardedInstrs = fctx.body.splice(strNullGuardStart);
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "local.get", index: strLocal });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" }, { op: "throw", tagIdx }],
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
  shiftLoopDepths(fctx, 3);

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
  // (#3224) In standalone, bounds-check the per-element read against the
  // physical WasmGC backing so a sparse array (logical `.length` set beyond the
  // backing) yields the absent value instead of an OOB TRAP. The array iterator
  // visits every index up to the LOGICAL length (§23.1.5.1) — so this does NOT
  // clamp the loop; it only guards the READ: `if i < array.len(data): data[i]
  // else <default>`. `defaultValueInstrs` gives the same rep the within-backing
  // holes use — externref → `ref.null.extern` (≡ standalone `undefined`), f64 →
  // the sNaN hole sentinel, i32/packed → 0. No-op for dense arrays.
  if (ctx.standalone) {
    const dataIterLocal = allocLocal(fctx, `__forof_dataiter_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: arrTypeIdx,
    });
    if (reReadLive) {
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
    } else {
      fctx.body.push({ op: "local.get", index: dataLocal });
    }
    fctx.body.push({ op: "local.set", index: dataIterLocal });
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: "local.get", index: dataIterLocal });
    fctx.body.push({ op: "array.len" });
    fctx.body.push({ op: "i32.lt_s" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: readElemType },
      then: [
        { op: "local.get", index: dataIterLocal },
        { op: "local.get", index: iLocal },
        { op: elemReadOp, typeIdx: arrTypeIdx },
      ],
      else: defaultValueInstrs(readElemType),
    });
  } else {
    if (reReadLive) {
      fctx.body.push({ op: "local.get", index: vecLocal });
      fctx.body.push({ op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 });
    } else {
      fctx.body.push({ op: "local.get", index: dataLocal });
    }
    fctx.body.push({ op: "local.get", index: iLocal });
    fctx.body.push({ op: elemReadOp, typeIdx: arrTypeIdx });
  }
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
  if (!ts.isVariableDeclarationList(stmt.initializer)) {
    emitWebCompatCallAssignmentTarget(ctx, fctx, stmt.initializer);
  }

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
  compileLoopBodyWithShadows(ctx, fctx, stmt.statement);
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
  shiftLoopDepths(fctx, -3);

  popBody(fctx, savedBody);

  fctx.body.push(blockLoop(loopBody));

  // Null guard: if vec ref is nullable, guard against null (#775, #789)
  // If null from a failed guarded cast (wrong struct type), just skip the loop.
  // Only throw TypeError for genuinely null values (e.g. `for (const x of null)`).
  if (vecType.kind === "ref_null") {
    const guardedInstrs = fctx.body.splice(nullGuardStart);
    const backupLocal: number | undefined = (fctx as any).__lastGuardedCastBackup;
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "ref.is_null" });
    if (backupLocal !== undefined) {
      // A guarded cast backup exists: distinguish "wrong type" from "genuinely null"
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: backupLocal },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "ref.null.extern" }, { op: "throw", tagIdx }],
            else: [], // wrong struct type → skip loop
          },
        ],
        else: guardedInstrs,
      });
    } else {
      const tagIdx = ensureExnTag(ctx);
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "throw", tagIdx }],
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
    // (#3224) In standalone, bounds-check the read against the physical backing
    // so a sparse array (logical length beyond the backing) yields the absent
    // value (undefined ≡ ref.null.extern; f64 → sNaN sentinel) instead of an OOB
    // trap. entries() visits every index up to the logical length; the read is
    // guarded, the loop is not clamped. No-op for dense arrays.
    if (ctx.standalone) {
      fctx.body.push({ op: "local.get", index: iLocal });
      fctx.body.push({ op: "local.get", index: dataLocal });
      fctx.body.push({ op: "array.len" });
      fctx.body.push({ op: "i32.lt_s" });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: readElemType },
        then: [
          { op: "local.get", index: dataLocal },
          { op: "local.get", index: iLocal },
          { op: elemReadOp, typeIdx: loopArrTypeIdx },
        ],
        else: defaultValueInstrs(readElemType),
      });
    } else {
      fctx.body.push({ op: "local.get", index: dataLocal });
      fctx.body.push({ op: "local.get", index: iLocal });
      fctx.body.push({ op: elemReadOp, typeIdx: loopArrTypeIdx });
    }
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
  shiftLoopDepths(fctx, 3);

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
  compileLoopBodyWithShadows(ctx, fctx, stmt.statement);
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

  shiftLoopDepths(fctx, -3);

  popBody(fctx, savedBody);

  fctx.body.push(blockLoop(loopBody));

  // Null guard: throw TypeError for genuinely null receiver (`arr` is null).
  if (vecType.kind === "ref_null") {
    const guardedInstrs = fctx.body.splice(nullGuardStart);
    const tagIdx = ensureExnTag(ctx);
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" }, { op: "throw", tagIdx }],
      else: guardedInstrs,
    });
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
    then: [{ op: "ref.null.extern" }, { op: "throw", tagIdx }],
    else: [],
  });

  // Call @@iterator method: iter = obj[Symbol.iterator]()
  fctx.body.push({ op: "local.get", index: nullTmp });
  if (iterableType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" });
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

  // (#2978 / #2934-3b) Result arity of the user `return()` method. A VOID
  // `return()` (e.g. `return() { count += 1; }`) has zero results, so the
  // unconditional post-close `drop` underflowed the operand stack → invalid
  // Wasm → the module fail-fasted at validation (which is exactly what hid the
  // #2978 OOM loop). Guard every close-site `drop` on this arity.
  let returnMethodResultArity = 0;
  if (returnMethodIdx !== undefined) {
    const returnMethodDef = definedFuncAt(ctx, returnMethodIdx);
    const returnMethodType = returnMethodDef ? ctx.mod.types[returnMethodDef.typeIdx] : undefined;
    returnMethodResultArity =
      returnMethodType && returnMethodType.kind === "func" ? returnMethodType.results.length : 0;
  }

  // (#2978) `for await` on the sync drive: cap the step count (all lanes — a
  // sync body can never observe a pending/host promise settle), and under the
  // native `$Promise` carrier also unwrap each element per §27.1.4.4 (REJECTED
  // → IteratorClose + rethrow). The close-on-throw wrapper below needs one
  // extra label level, mirroring the __iterator path's +3 (#851).
  const isForAwait = !!stmt.awaitModifier;
  const wrapForAwaitClose = isForAwait && returnMethodIdx !== undefined;
  const carrierAwait = isForAwait && valueFieldType.kind === "externref" && isStandalonePromiseActive(ctx);
  const forAwaitDepth = wrapForAwaitClose ? 3 : 2;
  let capLocal = -1;
  if (isForAwait) {
    capLocal = allocLocal(fctx, `__forawait_steps_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: capLocal });
  }

  // Done flag: tracks whether iterator completed normally (done=true) (#851)
  const doneFlagDirect = allocLocal(fctx, `__forit_done_${fctx.locals.length}`, { kind: "i32" });

  // Build loop body
  const savedBody = pushBody(fctx);

  shiftLoopDepths(fctx, forAwaitDepth);

  fctx.breakStack.push(1);
  fctx.continueStack.push(0);

  // (#2978) Step cap — first thing in the loop body so `continue` re-checks it.
  if (isForAwait) {
    emitForAwaitStepCapCheck(ctx, fctx, capLocal);
  }

  // #2067: no iteration cap — see the matching note in the __iterator_next path.
  // The former 1,000,000-iteration `br_if` guard silently truncated long
  // custom-iterator loops and accumulated across re-entries; the loop now runs
  // to the iterator's own `done`.

  // Call next(): result = iter.next()
  fctx.body.push({ op: "local.get", index: iterLocal });
  if (iterResultType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" });
  }
  fctx.body.push({ op: "call", funcIdx: nextMethodIdx });
  fctx.body.push({ op: "local.set", index: resultLocal });

  // Check done: result.done -> set done flag and break if truthy
  fctx.body.push({ op: "local.get", index: resultLocal });
  if (nextResultType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" });
  }
  fctx.body.push({
    op: "struct.get",
    typeIdx: resultStructTypeIdx,
    fieldIdx: doneFieldIdx,
  });
  // done field might be i32 (boolean) or f64; convert to i32 for br_if
  if (doneFieldType.kind === "f64") {
    fctx.body.push({ op: "i32.trunc_f64_s" });
  }
  // If done, set the done flag to 1 before breaking (#851)
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: [
      { op: "i32.const", value: 1 },
      { op: "local.set", index: doneFlagDirect },
      { op: "br", depth: 2 }, // break out of block (if + loop = depth 2)
    ],
    else: [],
  });

  // Get value: elem = result.value
  fctx.body.push({ op: "local.get", index: resultLocal });
  if (nextResultType.kind === "ref_null") {
    fctx.body.push({ op: "ref.as_non_null" });
  }
  fctx.body.push({
    op: "struct.get",
    typeIdx: resultStructTypeIdx,
    fieldIdx: valueFieldIdx,
  });

  // (#2978) `for await` under the native `$Promise` carrier: Await the element
  // — a REJECTED promise throws its reason (abrupt loop completion; the
  // close-on-throw wrapper below runs IteratorClose first), a FULFILLED one
  // unwraps. Runs on the raw externref BEFORE the element coercion so the
  // unwrapped value (not the promise) is what reaches the loop variable.
  if (carrierAwait) {
    const awaitTmp = allocLocal(fctx, `__forawait_val_${fctx.locals.length}`, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: awaitTmp });
    emitForAwaitElementUnwrap(ctx, fctx, awaitTmp);
    fctx.body.push({ op: "local.get", index: awaitTmp });
  }

  // Coerce value to element type if needed
  const targetElemType = getLocalType(fctx, elemLocal) ?? elemType;
  if (!valTypesMatch(valueFieldType, targetElemType)) {
    coerceType(ctx, fctx, valueFieldType, targetElemType);
  }
  fctx.body.push({ op: "local.set", index: elemLocal });
  if (!ts.isVariableDeclarationList(stmt.initializer)) {
    emitWebCompatCallAssignmentTarget(ctx, fctx, stmt.initializer);
  }

  // If destructuring, handle it
  if (destructPatternIter) {
    compileForOfDestructuring(ctx, fctx, destructPatternIter, elemLocal, elemType, stmt);
  }
  if (assignDestructExprIter) {
    compileForOfIteratorAssignDestructuring(ctx, fctx, assignDestructExprIter, elemLocal, stmt);
  }

  // Compile body
  compileLoopBodyWithShadows(ctx, fctx, stmt.statement);

  fctx.body.push({ op: "br", depth: 0 });

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  shiftLoopDepths(fctx, -forAwaitDepth);

  popBody(fctx, savedBody);

  // Fresh instrs per call site — the close sequence is emitted at TWO sites
  // (post-loop break-close and the #2978 catch_all close) and a shared Instr[]
  // aliased into two branches double-remaps under DCE (see
  // reference_shared_instr_object_dce_double_remap).
  const closeCallInstrs = (): Instr[] => [
    { op: "local.get", index: iterLocal },
    ...(iterResultType.kind === "ref_null" ? ([{ op: "ref.as_non_null" }] satisfies Instr[]) : []),
    { op: "call", funcIdx: returnMethodIdx! },
    // Drop the return value only when return() actually yields one
    // (#2978 / #2934-3b — a void return() has nothing to drop).
    ...(returnMethodResultArity > 0 ? ([{ op: "drop" }] satisfies Instr[]) : []),
  ];

  const blockLoopInstr: Instr = blockLoop(loopBody);

  if (wrapForAwaitClose) {
    // (#2978) `for await`: close the iterator on ABRUPT (throw) completion —
    // the element-await rethrows a rejection reason, and per §27.1.4.4 /
    // §7.4.6 the sync iterator must be closed exactly once before the
    // rejection reaches the user catch. Per §7.4.6 step 6, an error thrown by
    // `return()` itself is suppressed (the original throw wins) — hence the
    // empty inner catch_all. Mirrors the __iterator path's #1347 wrapper.
    const catchBodyPrefix: Instr[] = [
      { op: "local.get", index: doneFlagDirect },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ctx.wasi || ctx.standalone
            ? buildStandardTryTable({ kind: "empty" }, closeCallInstrs(), [
                {
                  kind: "catch",
                  tagIdx: ensureExnTag(ctx),
                  payloadType: { kind: "externref" },
                  body: [{ op: "drop" }],
                },
              ])
            : {
                op: "try",
                blockType: { kind: "empty" },
                body: closeCallInstrs(),
                catches: [],
                catchAll: [], // suppress return() errors per §7.4.6 step 6
              },
        ],
        else: [],
      },
    ];
    if (ctx.wasi || ctx.standalone) {
      const tagIdx = ensureExnTag(ctx);
      const exnLocal = allocLocal(fctx, `__forawait_close_exn_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push(
        buildStandardTryTable(
          { kind: "empty" },
          [blockLoopInstr],
          [
            {
              kind: "catch",
              tagIdx,
              payloadType: { kind: "externref" },
              body: [
                { op: "local.set", index: exnLocal },
                ...catchBodyPrefix,
                { op: "local.get", index: exnLocal },
                { op: "throw", tagIdx },
              ],
            },
          ],
        ),
      );
    } else {
      fctx.body.push({
        op: "try",
        blockType: { kind: "empty" },
        body: [blockLoopInstr],
        catches: [],
        catchAll: [...catchBodyPrefix, { op: "rethrow", depth: 0 }],
      });
    }
  } else {
    fctx.body.push(blockLoopInstr);
  }

  // Iterator close protocol (#851): call iterator.return() only on abrupt
  // completion (break/return), NOT on normal completion (done=true).
  if (returnMethodIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: doneFlagDirect });
    fctx.body.push({ op: "i32.eqz" }); // if NOT done (abrupt exit)
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: closeCallInstrs(),
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
          { op: "local.get", index: backupLocal },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "ref.null.extern" }, { op: "throw", tagIdx }],
            else: [],
          },
        ],
        else: [],
      });
    } else {
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "throw", tagIdx }],
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

  // (#2978) `for await` on the sync __iterator drive: step cap (all lanes) +
  // per-element Await under the native `$Promise` carrier. See the direct-path
  // twin above; here the existing #1347 try/catch_all wrapper already provides
  // close-on-throw, so the rejection rethrow needs no extra structure.
  const isForAwaitIter = !!stmt.awaitModifier;
  const carrierAwaitIter = isForAwaitIter && isStandalonePromiseActive(ctx);
  let capLocalIter = -1;
  if (isForAwaitIter) {
    capLocalIter = allocLocal(fctx, `__forawait_steps_${fctx.locals.length}`, { kind: "i32" });
    fctx.body.push({ op: "i32.const", value: 0 });
    fctx.body.push({ op: "local.set", index: capLocalIter });
  }

  // Build loop body
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: try+block+loop adds 3 nesting levels (#851).
  // The extra +1 (vs the old +2) is for the try wrapper that enables iterator close on throw.
  shiftLoopDepths(fctx, 3);

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
        { op: "local.get", index: capturedDoneFlag },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: capturedIterLocal },
            { op: "call", funcIdx: capturedReturnIdx },
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

  // (#2978) Step cap — first thing in the loop body so `continue` re-checks it.
  if (isForAwaitIter) {
    emitForAwaitStepCapCheck(ctx, fctx, capLocalIter);
  }

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
      { op: "i32.const", value: 1 },
      { op: "local.set", index: doneFlag },
      { op: "br", depth: 2 }, // break out of block (if + loop = depth 2)
    ],
    else: [],
  });

  // (#2978) `for await` under the native `$Promise` carrier: Await the element.
  // A REJECTED promise throws its reason; the #1347 try/catch_all wrapper below
  // closes the iterator (return() exactly once, errors suppressed) and rethrows,
  // so the user catch observes the rejection reason (§27.1.4.4).
  if (carrierAwaitIter) {
    emitForAwaitElementUnwrap(ctx, fctx, resultLocal);
  }

  // Get value: elem = value (already in resultLocal)
  fctx.body.push({ op: "local.get", index: resultLocal });
  fctx.body.push({ op: "local.set", index: elemLocal });
  if (!ts.isVariableDeclarationList(stmt.initializer)) {
    emitWebCompatCallAssignmentTarget(ctx, fctx, stmt.initializer);
  }

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
  compileLoopBodyWithShadows(ctx, fctx, stmt.statement);

  fctx.body.push({ op: "br", depth: 0 }); // continue loop

  const loopBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Pop the iterator-close finallyStack entry (pushed before break/continue entries).
  if (returnIdx !== undefined && fctx.finallyStack && fctx.finallyStack.length > 0) {
    fctx.finallyStack.pop();
  }

  // Restore existing break/continue depths (undo the +3 applied at loop entry).
  shiftLoopDepths(fctx, -3);

  popBody(fctx, savedBody);

  // The block/loop body; wrapped in try/catch_all when __iterator_return is available
  // to call iterator.return() on throw (#851 via-throw).
  const blockLoopInstr: Instr = blockLoop(loopBody);

  if (returnIdx !== undefined) {
    // Wrap in try/catch_all: on exception, call iterator.return() then rethrow.
    //
    // Per ES §7.4.6 IteratorClose step 6: when the outer completion is
    // throw, IteratorClose returns the original throw — any error from
    // GetMethod / iterator.return() is suppressed. We model this by
    // wrapping the inner __iterator_return call in a nested try/catch_all
    // whose catchAll is empty (drops any exception). The outer catch_all
    // then `rethrow 0` re-raises the ORIGINAL exception. (#1347)
    const closeBody: Instr[] = [
      { op: "local.get", index: iterLocal },
      { op: "call", funcIdx: returnIdx },
    ];
    const innerCloseTry: Instr =
      ctx.wasi || ctx.standalone
        ? buildStandardTryTable({ kind: "empty" }, closeBody, [
            {
              kind: "catch",
              tagIdx: ensureExnTag(ctx),
              payloadType: { kind: "externref" },
              body: [{ op: "drop" }],
            },
          ])
        : {
            op: "try",
            blockType: { kind: "empty" },
            body: closeBody,
            catches: [],
            catchAll: [], // suppress any error from GetMethod / return() per spec step 6
          };
    const closeOnThrowBody: Instr[] = [
      { op: "local.get", index: doneFlag },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [innerCloseTry],
        else: [],
      },
    ];
    if (ctx.wasi || ctx.standalone) {
      const tagIdx = ensureExnTag(ctx);
      const exnLocal = allocLocal(fctx, `__iterator_close_exn_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push(
        buildStandardTryTable(
          { kind: "empty" },
          [blockLoopInstr],
          [
            {
              kind: "catch",
              tagIdx,
              payloadType: { kind: "externref" },
              body: [
                { op: "local.set", index: exnLocal },
                ...closeOnThrowBody,
                { op: "local.get", index: exnLocal },
                { op: "throw", tagIdx },
              ],
            },
          ],
        ),
      );
    } else {
      fctx.body.push({
        op: "try",
        blockType: { kind: "empty" },
        body: [blockLoopInstr],
        catches: [],
        catchAll: [...closeOnThrowBody, { op: "rethrow", depth: 0 }],
      });
    }
  } else {
    fctx.body.push(blockLoopInstr);
  }

  // Iterator close protocol (#851): call iterator.return() on break (post-loop check).
  // return/throw/outer-break/outer-continue are handled via finallyStack and try/catch_all above.
  if (returnIdx !== undefined) {
    fctx.body.push({ op: "local.get", index: doneFlag });
    fctx.body.push({ op: "i32.eqz" }); // if NOT done (abrupt exit via break)
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: iterLocal },
        { op: "call", funcIdx: returnIdx },
      ],
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
    fctx.body.push({ op: "ref.null.extern" });
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
      fctx.body.push({ op: "ref.null.extern" });
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
  _arrayInfo: { vecTypeIdx: number; arrTypeIdx: number; elemType: ValType },
  keyLocal: number,
  memberTarget: ts.PropertyAccessExpression | ts.ElementAccessExpression | null,
  bindingPattern: ts.ObjectBindingPattern | ts.ArrayBindingPattern | null,
  callTarget: ts.CallExpression | null,
): void {
  // (#3179) `arrayInfo.vecTypeIdx` (the STATIC-type-derived vec type) is
  // deliberately unused: the loop reads only the length, via the `$__vec_base`
  // supertype, so the runtime element-kind rep no longer matters (see below).

  // Decimal-key formatter (f64 -> externref) for the integer index. Reuses the
  // sealed engine helper — NOT a hand-rolled ToString — via the SAME registration
  // array `.join`/`.toString` use. Dual-mode: no-JS-host (standalone / wasi /
  // nativeStrings) registers the DEFINED native (the helper is not in
  // UNION_NATIVE_HELPER_NAMES, so a late host import would leak `env::*` there);
  // JS-host uses the host import (the native formatter needs NativeString GC
  // types host mode doesn't register — registering them there bakes a `-1`
  // heap-type ref, the #2043 class). Register before the funcIdx capture so the
  // late-import index shift settles first.
  // (#3323) In JS-host mode, enumerate the FULL OrdinaryOwnPropertyKeys list —
  // integer indices PLUS the own enumerable non-index string keys added via
  // `arr.k = v` / `Object.defineProperty` — through the `__array_forin_keys`
  // host helper, driven by the shared `__for_in_len`/`__for_in_get` loop. The
  // pure-native index loop below (kept for standalone / wasi, where the sidecar
  // is unavailable) only emits the integer indices and drops the string keys.
  const useHostKeys = ctx.targetProfile.semanticProviders !== "native-first" && !ctx.standalone && !ctx.wasi;
  const NUM_FMT = "number_toString";
  if (useHostKeys) {
    addForInImports(ctx);
  }
  if (ctx.standalone || ctx.wasi || ctx.nativeStrings) {
    emitNativeNumberFormat(ctx, new Set([NUM_FMT]));
  } else if (!useHostKeys && ctx.funcMap.get(NUM_FMT) === undefined) {
    ensureLateImport(ctx, NUM_FMT, [{ kind: "f64" }], [{ kind: "externref" }]);
  }
  flushLateImportShifts(ctx, fctx);
  const numToStrIdx = ctx.funcMap.get(NUM_FMT);
  const arrayKeysIdx = useHostKeys ? ctx.funcMap.get("__array_forin_keys") : undefined;
  const forInLenIdx = useHostKeys ? ctx.funcMap.get("__for_in_len") : undefined;
  const forInGetIdx = useHostKeys ? ctx.funcMap.get("__for_in_get") : undefined;
  const hostKeys = useHostKeys && arrayKeysIdx !== undefined && forInLenIdx !== undefined && forInGetIdx !== undefined;

  // Compile the array expression into a vec ref local. A null/undefined receiver
  // would throw in JS; for-in over null/undefined is spec'd as a no-op (§13.7.5.1
  // step 2 returns when the value is undefined/null), so guard with ref.is_null.
  //
  // (#3179) The receiver's RUNTIME vec rep can disagree with the vec type derived
  // from the STATIC TS type: `var a = new Array(); a[0] = 5` is statically `any[]`
  // (→ `__vec_externref`) but the allocation site's usage inference
  // (compileNewExpression's Array arm) mints a `__vec_f64` — so the old
  // unconditional `ref.cast <static vecTypeIdx>` on the externref branch trapped
  // `illegal cast` at runtime. The loop below only reads the LENGTH (field 0),
  // which every `__vec_<elemKind>` exposes uniformly through the shared
  // `$__vec_base` supertype (#2186) — so downcast to `$__vec_base` instead,
  // guarded by `ref.test` (a non-vec runtime value yields a null local → 0
  // iterations, matching the nullish-receiver no-op; previously it trapped).
  // The concrete-ref branch (receiver statically compiles to a vec ref) keeps
  // its exact type via subtyping into the `$__vec_base` local.
  const vecBaseTypeIdx = getOrRegisterVecBaseType(ctx);
  const vecLocal = allocLocal(fctx, `__forin_arr_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: vecBaseTypeIdx,
  });
  const exprType = compileExpression(ctx, fctx, stmt.expression);
  if (exprType && (exprType.kind === "ref" || exprType.kind === "ref_null")) {
    // already a concrete vec ref — a `__vec_<k>` subtypes `$__vec_base`
    fctx.body.push({ op: "local.set", index: vecLocal });
  } else if (exprType && exprType.kind === "externref") {
    const anyTmp = allocLocal(fctx, `__forin_any_${fctx.locals.length}`, { kind: "anyref" });
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "local.tee", index: anyTmp });
    fctx.body.push({ op: "ref.test", typeIdx: vecBaseTypeIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyTmp },
        { op: "ref.cast", typeIdx: vecBaseTypeIdx },
        { op: "local.set", index: vecLocal },
      ],
      // non-vec runtime value → vecLocal stays null → 0 iterations
    });
  } else {
    // Defensive: unexpected receiver type on the stack — preserve the historical
    // bare local.set (validation surfaces a genuine type mismatch, as before).
    fctx.body.push({ op: "local.set", index: vecLocal });
  }

  // vec length = vec.field0 (0 when the ref is null → no integer indices).
  const vecLenLocal = allocLocal(fctx, `__forin_veclen_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: vecLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: 0 }],
    else: [
      { op: "local.get", index: vecLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: vecBaseTypeIdx, fieldIdx: 0 },
    ],
  });
  fctx.body.push({ op: "local.set", index: vecLenLocal });

  // (#3323) Host mode: materialize the full key list (integer indices + own
  // enumerable string keys) into an externref local via
  // `__array_forin_keys(vec, vecLen)`. The vec length is read above and passed in
  // (the opaque vec has no host-reachable length). A null vec → null externref +
  // len 0 → the helper returns `[]` → 0 iterations.
  const keysLocal = hostKeys ? allocLocal(fctx, `__forin_keys_${fctx.locals.length}`, { kind: "externref" }) : -1;
  if (hostKeys) {
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "extern.convert_any" });
    fctx.body.push({ op: "local.get", index: vecLenLocal });
    fctx.body.push({ op: "call", funcIdx: arrayKeysIdx! });
    fctx.body.push({ op: "local.set", index: keysLocal });
  }

  // Iteration count = keys.length (host, indices + string keys) | vecLen (native).
  const lenLocal = allocLocal(fctx, `__forin_len_${fctx.locals.length}`, { kind: "i32" });
  if (hostKeys) {
    fctx.body.push({ op: "local.get", index: keysLocal });
    fctx.body.push({ op: "call", funcIdx: forInLenIdx! });
  } else {
    fctx.body.push({ op: "local.get", index: vecLenLocal });
  }
  fctx.body.push({ op: "local.set", index: lenLocal });

  // Counter i = 0
  const iLocal = allocLocal(fctx, `__forin_i_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  // Build the user body (block+loop+block adds 3 nesting levels — same as the
  // dynamic-object path), with the per-iteration head write for non-identifier
  // heads (#1613).
  const savedBody = pushBody(fctx);
  shiftLoopDepths(fctx, 3);
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
  } else if (callTarget) {
    emitWebCompatCallAssignmentTarget(ctx, fctx, callTarget);
  }

  compileLoopBodyWithShadows(ctx, fctx, stmt.statement);

  const userBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();
  shiftLoopDepths(fctx, -3);
  popBody(fctx, savedBody);

  const loopBody: Instr[] = [];
  // Condition: i >= length → break ($break is depth 1 from inside $loop)
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "local.get", index: lenLocal });
  loopBody.push({ op: "i32.ge_s" });
  loopBody.push({ op: "br_if", depth: 1 });

  // key = keys[i] (host) | <decimal formatter>(f64(i)) (native) → keyLocal
  if (hostKeys) {
    loopBody.push({ op: "local.get", index: keysLocal });
    loopBody.push({ op: "local.get", index: iLocal });
    loopBody.push({ op: "call", funcIdx: forInGetIdx! });
  } else {
    loopBody.push({ op: "local.get", index: iLocal });
    loopBody.push({ op: "f64.convert_i32_s" });
    if (numToStrIdx !== undefined) {
      loopBody.push({ op: "call", funcIdx: numToStrIdx });
    }
  }
  loopBody.push({ op: "local.set", index: keyLocal });

  // block $continue { [presence gate] userBody }
  //
  // (#4222) `0..vecLen-1` is the own-key list only while every in-bounds index
  // is PRESENT. `delete arr[i]` leaves `length` untouched and records the
  // absence as a `FLAG_DELETED_INDEX` entry in the #3251 overlay companion, so
  // under the overlay route each iteration first asks `__extern_has_idx` — the
  // same chokepoint `in`, `Object.keys` and the HOF presence gates consult — and
  // `br_if 0` (continue) on an absent index. The gate sits INSIDE `$continue` as
  // an early branch rather than wrapping the block in an `if`, so the user
  // body's break/continue depths are untouched. Route-inactive modules and the
  // host key path emit the bare block, byte-for-byte as before.
  const forInHasIdx = !hostKeys && overlayRouteActive(ctx) ? ctx.funcMap.get("__extern_has_idx") : undefined;
  // (#4491) `[[Enumerable]]` joins the SAME gate. §14.7.5.10 EnumerateObject-
  // Properties yields only own ENUMERABLE keys, and since #3251 an array index
  // can carry `enumerable: false` — `Object.defineProperties(arr, {"0": {value:
  // 1001, writable: true, configurable: true}})`, where §6.2.5.6 defaults the
  // absent attribute to false. The descriptor already records it correctly; the
  // index loop enumerated it anyway. Reserved here (append-only mint, no funcIdx
  // shift) and filled at finalize — vec-index-enumerable.ts.
  // `keyLocal` must actually hold the decimal key STRING for the native to look
  // it up: without `number_toString` the native lane leaves a raw f64 there, so
  // the gate would be a type error rather than a wrong answer. Decline instead.
  const forInEnumIdx = hostKeys || numToStrIdx === undefined ? undefined : reserveVecIndexEnumerable(ctx);
  const skipGate: Instr[] = [];
  if (forInHasIdx !== undefined) {
    skipGate.push(
      { op: "local.get", index: vecLocal },
      { op: "extern.convert_any" },
      { op: "local.get", index: iLocal },
      { op: "f64.convert_i32_s" },
      { op: "call", funcIdx: forInHasIdx },
      { op: "i32.eqz" },
      { op: "br_if", depth: 0 },
    );
  }
  if (forInEnumIdx !== undefined) {
    skipGate.push(
      { op: "local.get", index: vecLocal },
      { op: "extern.convert_any" },
      { op: "local.get", index: keyLocal },
      { op: "call", funcIdx: forInEnumIdx },
      { op: "i32.eqz" },
      { op: "br_if", depth: 0 },
    );
  }
  loopBody.push({
    op: "block",
    blockType: { kind: "empty" },
    body: skipGate.length === 0 ? userBody : [...skipGate, ...userBody],
  });

  // increment + restart
  loopBody.push({ op: "local.get", index: iLocal });
  loopBody.push({ op: "i32.const", value: 1 });
  loopBody.push({ op: "i32.add" });
  loopBody.push({ op: "local.set", index: iLocal });
  loopBody.push({ op: "br", depth: 0 });

  fctx.body.push(blockLoop(loopBody));
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
  let callTarget: ts.CallExpression | null = null;
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
  } else if (ts.isCallExpression(head)) {
    callTarget = head;
    varName = `__forin_key_${fctx.locals.length}`;
    keyLocal = allocLocal(fctx, varName, { kind: "externref" });
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
    emitArrayForIn(ctx, fctx, stmt, recvArrayInfo, keyLocal, memberTarget, bindingPattern, callTarget);
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

  if (
    (keysIdx === undefined || lenIdx === undefined || getIdx === undefined) &&
    (ctx.standalone || ctx.wasi || ctx.targetProfile.semanticProviders === "native-first")
  ) {
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
    // fallback when no enumeration primitive is available. (#4561) It owns its
    // own `block $break` / per-iteration `block $continue` scaffolding; see
    // `for-in-static-unroll.ts` for why it had none.
    emitForInStaticUnroll(
      ctx,
      fctx,
      stmt,
      keyLocal,
      callTarget ? () => emitWebCompatCallAssignmentTarget(ctx, fctx, callTarget) : undefined,
      () => compileStatement(ctx, fctx, stmt.statement),
    );
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
        fctx.body.push({ op: "ref.null.extern" }); // placeholder value
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
  shiftLoopDepths(fctx, 3);

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
  } else if (callTarget) {
    emitWebCompatCallAssignmentTarget(ctx, fctx, callTarget);
  }

  // Compile the user's loop body — save/restore block-scoped shadows for let/const (#817).
  compileLoopBodyWithShadows(ctx, fctx, stmt.statement);

  const userBody = fctx.body;
  fctx.breakStack.pop();
  fctx.continueStack.pop();

  // Restore existing break/continue depths
  shiftLoopDepths(fctx, -3);

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
      then: [{ op: "br", depth: 1 }],
    });
    guardedBody.unshift({ op: "i32.eqz" });
    guardedBody.unshift({ op: "call", funcIdx: hasIdx });
    guardedBody.unshift({ op: "local.get", index: keyLocal });
    guardedBody.unshift({ op: "local.get", index: objLocal });
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
  fctx.body.push(blockLoop(loopBody));

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
