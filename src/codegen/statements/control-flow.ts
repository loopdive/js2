// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Control flow statement lowering: return, if, switch, break, continue, labeled.
 */
import { ts } from "../../ts-api.js";
import { isBooleanType, isNumberType, isStringType } from "../../checker/type-mapper.js";
import type { TypeFact } from "../../checker/oracle.js";
import type { Instr, ValType } from "../../ir/types.js";
import { popBody, pushBody } from "../context/bodies.js";
import { allocLocal, allocTempLocal, getLocalType } from "../context/locals.js";
import type { CodegenContext, FunctionContext, NullGuardFact, NullishExclusion } from "../context/types.js";
import { emitEagerAsyncPromiseWrap } from "../async-eager-promise.js"; // (#4630)
import { emitToNumber } from "../coercion-engine.js";
import { emitThrowTypeError } from "../expressions/helpers.js";
import {
  addStringImports,
  addUnionImports,
  ensureI32Condition,
  ensureNativeStringHelpers,
  resolveWasmType,
} from "../index.js";
import {
  coerceType,
  compileExpression,
  compileStatement,
  ensureAnyHelpers,
  ensureLateImport,
  flushLateImportShifts,
  isAnyValue,
  valTypesMatch,
} from "../shared.js";
import { emitLinearU8ArenaReset } from "../linear-uint8-arena.js";
import { adjustRethrowDepth } from "./shared.js";
import { definedFuncAt } from "../func-space.js"; // (#1916 S2) positional-read chokepoint
import { emitUndefined } from "../expressions/late-imports.js";
import { emitConstructReturnSelect } from "../construct-return-value.js"; // (#4464)
import { buildThrowJsErrorInstrs } from "../js-errors.js";

/**
 * (#2061) Compute the extra nesting depth between a finally-inline site and the
 * try frame at which the finally body was pre-compiled.
 *
 * The finally body is lowered once with break/continue depths bumped by exactly
 * +1 (the try frame). When a return/break/continue that triggers the inline is
 * nested DEEPER than the try frame (inside an `if`/`switch`/inner-`try` within
 * the try block), every label op descended since try entry has bumped all outer
 * break/continue stack entries by +1, uniformly. So the delta is simply
 * `current outer-label depth − baseline outer-label depth`, read from any outer
 * entry. Returns 0 when the inline site is at the try frame itself, or when no
 * outer label exists to measure against (e.g. a finally containing only
 * `return`, whose clone has no outer-targeting branches to retarget).
 */
function finallyInlineDelta(
  fctx: FunctionContext,
  entry: { breakDepthBaseline: number[]; continueDepthBaseline: number[] },
): number {
  for (let i = entry.breakDepthBaseline.length - 1; i >= 0; i--) {
    const cur = fctx.breakStack[i];
    if (cur !== undefined) return cur - entry.breakDepthBaseline[i]!;
  }
  for (let i = entry.continueDepthBaseline.length - 1; i >= 0; i--) {
    const cur = fctx.continueStack[i];
    if (cur !== undefined) return cur - entry.continueDepthBaseline[i]!;
  }
  return 0;
}

function canTailCall(ctx: CodegenContext, fctx: FunctionContext, calleeIdx: number): boolean {
  let calleeTypeIdx: number | undefined;
  if (calleeIdx < ctx.numImportFuncs) {
    // Import function
    const imp = ctx.mod.imports[calleeIdx];
    if (imp?.desc.kind === "func") calleeTypeIdx = imp.desc.typeIdx;
  } else {
    // Local function
    const func = definedFuncAt(ctx, calleeIdx);
    if (func) calleeTypeIdx = func.typeIdx;
  }
  if (calleeTypeIdx === undefined) return false;
  const typeDef = ctx.mod.types[calleeTypeIdx];
  if (!typeDef || typeDef.kind !== "func") return false;

  // Parameter count must match — return_call requires the stack to contain
  // exactly the callee's params, so mismatched counts cause "not enough
  // arguments" CE (#822 Work Item 1)
  if (typeDef.params.length !== fctx.params.length) return false;

  // Compare callee results with caller return type
  const calleeResults = typeDef.results;
  if (!fctx.returnType) {
    // Caller is void — callee must also return nothing
    return calleeResults.length === 0;
  }
  // Caller has a return type — callee must return exactly one matching type
  if (calleeResults.length !== 1) return false;
  const calleeRet = calleeResults[0]!;
  const callerRet = fctx.returnType;
  // Exact kind match (we allow ref subtyping — same kind is sufficient)
  if (calleeRet.kind === callerRet.kind) return true;
  // ref/ref_null are compatible for return purposes
  if (
    (calleeRet.kind === "ref" || calleeRet.kind === "ref_null") &&
    (callerRet.kind === "ref" || callerRet.kind === "ref_null")
  )
    return true;
  return false;
}

/**
 * Check if a call_ref with a given type index can be safely converted to return_call_ref.
 */
function canTailCallRef(ctx: CodegenContext, fctx: FunctionContext, typeIdx: number): boolean {
  const typeDef = ctx.mod.types[typeIdx];
  if (!typeDef || typeDef.kind !== "func") return false;

  // Parameter count must match (#822 Work Item 1)
  if (typeDef.params.length !== fctx.params.length) return false;

  const calleeResults = typeDef.results;
  if (!fctx.returnType) return calleeResults.length === 0;
  if (calleeResults.length !== 1) return false;
  const calleeRet = calleeResults[0]!;
  const callerRet = fctx.returnType;
  if (calleeRet.kind === callerRet.kind) return true;
  if (
    (calleeRet.kind === "ref" || calleeRet.kind === "ref_null") &&
    (callerRet.kind === "ref" || callerRet.kind === "ref_null")
  )
    return true;
  return false;
}

function emitLinearU8ArenaResetBeforeReturn(ctx: CodegenContext, fctx: FunctionContext): boolean {
  if (fctx.linearU8ArenaMarkLocalIdx === undefined || ctx.linearU8ArenaGlobalIdx === undefined) return false;
  if (fctx.returnType) {
    const retTmp = allocLocal(fctx, `__linu8_ret_${fctx.locals.length}`, fctx.returnType);
    fctx.body.push({ op: "local.set", index: retTmp });
    emitLinearU8ArenaReset(ctx, fctx, fctx.linearU8ArenaMarkLocalIdx);
    fctx.body.push({ op: "local.get", index: retTmp });
  } else {
    emitLinearU8ArenaReset(ctx, fctx, fctx.linearU8ArenaMarkLocalIdx);
  }
  return true;
}

export function compileReturnStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.ReturnStatement): void {
  // Inside a generator function, `return expr` should push the return value
  // into the generator buffer (so .next().value sees it), then break out of
  // the body block (not use the wasm `return` opcode, which would skip __create_generator).
  if (fctx.isGenerator) {
    if (stmt.expression) {
      const bufferIdx = fctx.localMap.get("__gen_buffer");
      const resultType = compileExpression(ctx, fctx, stmt.expression);
      const setReturnIdx = ctx.funcMap.get("__gen_set_return");
      if (resultType !== null && bufferIdx !== undefined && setReturnIdx !== undefined) {
        // #2035: the generator's `return` value belongs ONLY to the terminal
        // `{value, done:true}` result — it must NOT be pushed into the yield
        // buffer (where spread/for-of/Array.from would surface it as a yielded
        // element). Coerce it to externref and stash it on the buffer via
        // `__gen_set_return`; the host drain emits it once with `done:true`.
        const tmpLocal = allocLocal(fctx, `__gen_ret_${fctx.locals.length}`, resultType);
        fctx.body.push({ op: "local.set", index: tmpLocal });
        fctx.body.push({ op: "local.get", index: bufferIdx });
        fctx.body.push({ op: "local.get", index: tmpLocal });
        coerceType(ctx, fctx, resultType, { kind: "externref" });
        fctx.body.push({ op: "call", funcIdx: setReturnIdx });
      } else if (resultType !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
    // Break out of the generator body block.
    // generatorReturnDepth tracks the correct br depth accounting for
    // nested loops/blocks that wrap the body instructions.
    const genReturnDepth = fctx.generatorReturnDepth ?? fctx.blockDepth;
    fctx.body.push({ op: "br", depth: genReturnDepth });
    return;
  }

  // (#2895 PATH B) Inside a host-free async resume function, `return v` settles
  // the frame's result `$Promise` with `v` (`__promise_fulfill`) and returns
  // void — the resume function carries the async result through the promise, not
  // its wasm return value. Mirrors the generator arm above.
  if (fctx.asyncDriveReturn) {
    const hook = fctx.asyncDriveReturn;
    const { resultPromiseLocal, fulfillFuncIdx } = hook;
    // (#2906 3c-ii) return-through-finally: when this `return` sits inside a
    // try/finally region (buildStateBody armed `pendingFinalizer`), evaluate
    // the operand FIRST (§14.15.3 ordering), replay the region's await-free
    // finalizer, then settle. The region local resets to 0 before the replay
    // (a throw in the finally must not re-enter the region — same rule as the
    // inline finally leads) and `pendingFinalizer` is cleared during it (a
    // `return` inside the finally settles directly — its completion overrides).
    const finalizer = hook.pendingFinalizer;
    if (finalizer !== undefined && finalizer.length > 0) {
      const tmp = allocLocal(fctx, `__async_ret_${fctx.locals.length}`, { kind: "externref" });
      if (stmt.expression) {
        const t = compileExpression(ctx, fctx, stmt.expression);
        if (t !== null && t !== undefined) {
          coerceType(ctx, fctx, t as ValType, { kind: "externref" });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      fctx.body.push({ op: "local.set", index: tmp });
      if (hook.handlerLocal !== undefined) {
        fctx.body.push({ op: "i32.const", value: 0 });
        fctx.body.push({ op: "local.set", index: hook.handlerLocal });
      }
      hook.pendingFinalizer = undefined;
      try {
        for (const f of finalizer) compileStatement(ctx, fctx, f);
      } finally {
        hook.pendingFinalizer = finalizer;
      }
      fctx.body.push({ op: "local.get", index: resultPromiseLocal });
      fctx.body.push({ op: "local.get", index: tmp });
      fctx.body.push({ op: "call", funcIdx: fulfillFuncIdx });
      fctx.body.push({ op: "drop" }); // __promise_fulfill returns the value
      fctx.body.push({ op: "return" });
      return;
    }
    fctx.body.push({ op: "local.get", index: resultPromiseLocal });
    if (stmt.expression) {
      const t = compileExpression(ctx, fctx, stmt.expression);
      if (t !== null && t !== undefined) {
        coerceType(ctx, fctx, t as ValType, { kind: "externref" });
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
    } else {
      fctx.body.push({ op: "ref.null.extern" });
    }
    fctx.body.push({ op: "call", funcIdx: fulfillFuncIdx });
    fctx.body.push({ op: "drop" }); // __promise_fulfill returns the value
    fctx.body.push({ op: "return" });
    return;
  }

  const hasPendingFinally = fctx.finallyStack && fctx.finallyStack.length > 0;

  // Externref-backed derived constructors (the standalone native built-in
  // families, e.g. `class C extends Object`) cannot use the nominal-struct
  // return path below.  Their return operand is a genuine runtime value, so
  // §10.2.1.3 must classify it after evaluating the expression: undefined is
  // discarded in favour of `this`, an object/function replaces `this`, and a
  // primitive throws TypeError.  The old static-only check missed JavaScript
  // tests because allowJs gives an unannotated `return 42` the `any` type; it
  // then returned the boxed number as the constructed instance. (#4450)
  if (fctx.isDerivedConstructor && fctx.returnType?.kind === "externref") {
    const selfIdx = fctx.localMap.get("this");
    if (selfIdx !== undefined && stmt.expression) {
      // Compile the operand first.  Both the expression and the typeof
      // predicates may register late imports; the throw template must be
      // captured only after those shifts have been flushed, otherwise its
      // detached call index can point at the wrong helper (#1839).
      const exprType = compileExpression(ctx, fctx, stmt.expression, { kind: "externref" });
      if (exprType === null || exprType === undefined) {
        fctx.body.push({ op: "local.get", index: selfIdx });
      } else {
        if (exprType.kind !== "externref") coerceType(ctx, fctx, exprType, { kind: "externref" });
        const typeofUndefinedIdx = ensureLateImport(
          ctx,
          "__typeof_undefined",
          [{ kind: "externref" }],
          [{ kind: "i32" }],
        );
        const typeofObjectIdx = ensureLateImport(ctx, "__typeof_object", [{ kind: "externref" }], [{ kind: "i32" }]);
        const typeofFunctionIdx = ensureLateImport(
          ctx,
          "__typeof_function",
          [{ kind: "externref" }],
          [{ kind: "i32" }],
        );
        flushLateImportShifts(ctx, fctx);
        const throwInstrs = buildThrowJsErrorInstrs(
          ctx,
          "TypeError",
          "Derived constructors may only return an object or undefined",
          { flush: fctx },
        );
        const callInstr = (funcIdx: number | undefined): Instr[] =>
          funcIdx === undefined ? [] : [{ op: "call", funcIdx }];
        const returned = allocLocal(fctx, `__derived_ret_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: returned });
        // `null` is not an Object for [[Construct]], even though its JS
        // typeof is "object".  Check it before the typeof predicates.
        fctx.body.push({ op: "local.get", index: returned });
        fctx.body.push({ op: "ref.is_null" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: throwInstrs,
          else: [
            { op: "local.get", index: returned },
            ...callInstr(typeofUndefinedIdx),
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: [{ op: "local.get", index: selfIdx }],
              else: [
                { op: "local.get", index: returned },
                ...callInstr(typeofObjectIdx),
                { op: "local.get", index: returned },
                ...callInstr(typeofFunctionIdx),
                { op: "i32.or" },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "externref" } },
                  then: [{ op: "local.get", index: returned }],
                  else: throwInstrs,
                },
              ],
            },
          ],
        });
      }
    } else if (selfIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: selfIdx });
    }
    emitReturnTail(ctx, fctx, hasPendingFinally);
    return;
  }

  // Other derived class constructors have nominal struct results. Detect
  // statically-provable primitive returns before the struct coercion path;
  // this preserves the existing bounded behaviour for that representation.
  if (fctx.isDerivedConstructor && stmt.expression) {
    const tsType = ctx.checker.getTypeAtLocation(stmt.expression);
    const primitiveFlags =
      ts.TypeFlags.NumberLike |
      ts.TypeFlags.BooleanLike |
      ts.TypeFlags.BigIntLike |
      ts.TypeFlags.StringLike |
      ts.TypeFlags.ESSymbolLike;
    if (tsType.flags & primitiveFlags) {
      emitThrowTypeError(ctx, fctx, "Derived constructors may only return an object or undefined");
      return;
    }
  }

  // §10.2.1.3 [[Construct]] step 13: a `return` inside a constructor never
  // yields the raw operand. A returned Object overrides `this`; a returned
  // primitive (or `undefined`, i.e. bare `return;`) is discarded and the
  // constructor result is `this` (`__self`). Without this arm a constructor
  // fell through to the generic value-return path below, which pushed a
  // `ref.null <struct>` for bare/primitive returns and `ref.cast`-coerced an
  // object operand to the struct return type — both producing a null/illegal
  // struct ref that traps "dereferencing a null pointer" at the `new` site
  // (#2018). The derived-ctor `return <primitive>` TypeError is handled
  // statically above (#825); here we only reach base-class / object / bare
  // returns, plus derived returns the static check let through.
  // Scope to BASE (non-derived) constructors: a derived ctor's `__self` is
  // produced by `super(...)` and the post-super `this` aliasing is handled on a
  // separate path, so we leave derived returns to the existing logic (the
  // static derived-ctor return-primitive TypeError above still applies). This
  // matches the issue scope (#2018, "base-class constructor").
  // (#4464) The same step-13 rule for the FunctionExpression construction
  // lowering, whose receiver and result are an externref `$Object` rather than
  // a nominal struct. The struct arm below decides "is the operand an Object?"
  // statically (it can: the only representable override is its own struct);
  // here the operand may be ANY runtime value, so the probe is a runtime one.
  if (fctx.constructThisExternLocal !== undefined) {
    const selfIdx = fctx.constructThisExternLocal;
    if (!stmt.expression) {
      fctx.body.push({ op: "local.get", index: selfIdx });
    } else {
      const exprType = compileExpression(ctx, fctx, stmt.expression, { kind: "externref" });
      if (exprType === null || exprType === undefined) {
        fctx.body.push({ op: "local.get", index: selfIdx });
      } else {
        if (exprType.kind !== "externref") coerceType(ctx, fctx, exprType, { kind: "externref" });
        if (!emitConstructReturnSelect(ctx, fctx, selfIdx)) {
          // No runtime Type(V) probe available — the spec-safe answer is the
          // one that is right for every PRIMITIVE return and wrong only for an
          // object one, so discard rather than hand back a value we cannot
          // classify.
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "local.get", index: selfIdx });
        }
      }
    }
    emitReturnTail(ctx, fctx, hasPendingFinally);
    return;
  }

  if (
    (fctx.isConstructor || fctx.isFnctorConstructor) &&
    !fctx.isDerivedConstructor &&
    fctx.returnType &&
    fctx.returnType.kind === "ref" &&
    fctx.localMap.has("this")
  ) {
    const selfIdx = fctx.localMap.get("this")!;
    const structTypeIdx = fctx.returnType.typeIdx;
    if (!stmt.expression) {
      // Bare `return;` → return `this` (the guard-clause idiom). #2018
      fctx.body.push({ op: "local.get", index: selfIdx });
    } else {
      const tsType = ctx.checker.getTypeAtLocation(stmt.expression);
      const primitiveFlags =
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.StringLike |
        ts.TypeFlags.ESSymbolLike |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Void;
      // Compile WITHOUT the struct return-type hint: a struct hint would make
      // `compileExpression` ref.cast the operand to `(ref $Struct)` (trapping
      // for a primitive / foreign object) before we can apply the §10.2.1.3
      // override/discard logic. Let it yield its natural type instead.
      const exprType = compileExpression(ctx, fctx, stmt.expression, undefined);
      if (tsType.flags & primitiveFlags) {
        // Statically a primitive / null / undefined → discard, return `this`.
        if (exprType) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "local.get", index: selfIdx });
      } else if (exprType && exprType.kind === "ref" && exprType.typeIdx === structTypeIdx) {
        // Already the struct return type (e.g. `return this` / `return new Same()`)
        // — pass it through as the override object.
      } else if (
        exprType &&
        (exprType.kind === "externref" || exprType.kind === "ref" || exprType.kind === "ref_null")
      ) {
        // Object-typed or `any` operand. The override object is only
        // representable as the constructor's `(ref $Struct)` result when it is
        // a runtime instance of that struct, so guard the cast: if the operand
        // is the struct, return it (the spec override); otherwise fall back to
        // `this` rather than trapping with an illegal cast. A foreign plain
        // object via `as any` cannot be represented by the struct-typed `new`
        // result and so resolves to `this` (the non-trapping behaviour).
        if (exprType.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" });
        }
        const overrideTmp = allocTempLocal(fctx, { kind: "anyref" } as ValType);
        fctx.body.push({ op: "local.tee", index: overrideTmp });
        fctx.body.push({ op: "ref.test", typeIdx: structTypeIdx });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: fctx.returnType as ValType },
          then: [
            { op: "local.get", index: overrideTmp },
            { op: "ref.cast", typeIdx: structTypeIdx },
          ],
          else: [{ op: "local.get", index: selfIdx }],
        });
      } else {
        // A non-ref operand slipped through (e.g. f64/i32 from `as any`) —
        // discard and return `this`.
        if (exprType) fctx.body.push({ op: "drop" });
        fctx.body.push({ op: "local.get", index: selfIdx });
      }
    }
    // Emit the shared finally / tail-call / `return` tail with the constructor
    // result already on the stack.
    emitReturnTail(ctx, fctx, hasPendingFinally);
    return;
  }

  if (stmt.expression) {
    const exprType = compileExpression(ctx, fctx, stmt.expression, fctx.returnType ?? undefined);
    // Coerce expression result to match function return type if they differ
    if (exprType && fctx.returnType && !valTypesMatch(exprType, fctx.returnType)) {
      coerceType(ctx, fctx, exprType, fctx.returnType);
    }
    // (#585) If the function is void (no return type) but the expression produced
    // a value, drop it — Wasm requires an empty stack before `return` in void funcs.
    if (exprType && !fctx.returnType) {
      fctx.body.push({ op: "drop" });
    }
  } else if (fctx.returnType) {
    // Bare `return;` in a value-returning function — push default value
    if (fctx.returnType.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
    else if (fctx.returnType.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
    else if (fctx.returnType.kind === "i64") fctx.body.push({ op: "i64.const", value: 0n });
    else if (fctx.returnType.kind === "externref") emitUndefined(ctx, fctx);
    else if (fctx.returnType.kind === "ref_null") fctx.body.push({ op: "ref.null", typeIdx: fctx.returnType.typeIdx });
    else if (fctx.returnType.kind === "ref") fctx.body.push({ op: "ref.null", typeIdx: fctx.returnType.typeIdx });
  }

  // (#4630) A parked async closure whose result was promoted to a `$Promise`
  // settles its completion value here — `Promise.resolve(v)`, idempotent for a
  // value that already IS a native `$Promise` (§27.2.4.7 step 2).
  if (fctx.eagerAsyncPromiseReturn === true) {
    emitEagerAsyncPromiseWrap(ctx, fctx);
  }

  emitReturnTail(ctx, fctx, hasPendingFinally);
}

/**
 * Shared tail for `return` lowering once the return value is on the stack:
 * inline any pending `finally` blocks, then apply tail-call optimization, then
 * emit the `return`. Factored out so the constructor return arm (#2018) and the
 * generic value/void return paths share one implementation.
 */
function emitReturnTail(ctx: CodegenContext, fctx: FunctionContext, hasPendingFinally: boolean | undefined): void {
  // If inside a try block with a finally clause, save the return value to a
  // temp local, inline the finally instructions, then restore and return.
  // This ensures finally always runs, and if finally contains its own return,
  // that return takes precedence (the subsequent return becomes unreachable).
  if (hasPendingFinally) {
    // Save return value to a temp local (if there is one)
    let retTmpIdx: number | undefined;
    if (fctx.returnType) {
      retTmpIdx = allocLocal(fctx, `__finally_ret_${fctx.locals.length}`, fctx.returnType);
      fctx.body.push({ op: "local.set", index: retTmpIdx });
    }
    // Inline ALL pending finally blocks from innermost to outermost. Each
    // clone's outer-targeting branches must be retargeted for the extra nesting
    // between this return site and that try frame (#2061).
    for (let i = fctx.finallyStack!.length - 1; i >= 0; i--) {
      const entry = fctx.finallyStack![i]!;
      fctx.body.push(...entry.cloneFinallyAtDepth(finallyInlineDelta(fctx, entry)));
    }
    emitLinearU8ArenaReset(ctx, fctx, fctx.linearU8ArenaMarkLocalIdx);
    // Restore return value and emit return
    if (retTmpIdx !== undefined) {
      fctx.body.push({ op: "local.get", index: retTmpIdx });
    }
    fctx.body.push({ op: "return" });
    return;
  }

  // Tail call optimization: if the last instruction is a call or call_ref,
  // replace it with return_call / return_call_ref to eliminate stack growth
  // for recursive and tail-position calls.
  // Guard: only apply when the callee's return type matches the caller's,
  // otherwise return_call produces a type mismatch (#839).
  // Guard: never inside a try with a catch handler — return_call replaces the
  // caller frame, so a throw from the callee would unwind past the enclosing
  // catch and escape to the host (#1972).
  const inTryWithHandler = (fctx.tryCatchDepth ?? 0) > 0;
  const resetBeforeReturn = emitLinearU8ArenaResetBeforeReturn(ctx, fctx);

  // (#2707c) Peel the value-producing tail of the return down to the underlying
  // `call` / `call_ref` / nested `if`, looking through the materialization
  // (`local.set X` / `local.get X` / `local.tee X`) and the #1511 `__argc` /
  // `__extras_argv` reset a closure/host call emits AFTER itself. Both hide the
  // tail call from a naive "is the last instruction a call?" check:
  //   - a constant-folded conditional / comma leaves `call; local.set X;
  //     <reset>; local.get X` at the TOP level, and
  //   - a `?:` / `&&` / `||` leaves an `(if (result T) …)` whose tail call lives
  //     inside an arm (handled via rewriteArmTailCalls).
  // The reset is dead in tail position (`return_call` replaces the caller frame
  // and the callee sets up its own `__argc` before reading `arguments`), so on a
  // successful promotion the buffer is truncated at the terminator, dropping the
  // dead materialization + reset. Promote only when the callee signature matches
  // (return_call type guards #822/#839) and never inside a try-with-handler
  // (#1972) — both already gated by the conditions above.
  if (!resetBeforeReturn && !inTryWithHandler) {
    const tIdx = peelToTailCallIdx(ctx, fctx.body);
    if (tIdx >= 0) {
      const target = fctx.body[tIdx]!;
      if (target.op === "call" && canTailCall(ctx, fctx, (target as any).funcIdx as number)) {
        (target as any).op = "return_call";
        // Truncate dead code (materialization + #1511 reset) after the terminator.
        fctx.body.length = tIdx + 1; // not-a-probe-rollback (#1919): dead-code truncation after return_call, not a speculative-compile rollback
        return; // return_call implicitly returns
      }
      if (target.op === "call_ref") {
        const typeIdx = (target as any).typeIdx as number | undefined;
        if (typeIdx !== undefined && canTailCallRef(ctx, fctx, typeIdx)) {
          (target as any).op = "return_call_ref";
          fctx.body.length = tIdx + 1; // not-a-probe-rollback (#1919): dead-code truncation after return_call_ref, not a speculative-compile rollback
          return;
        }
      }
      if (target.op === "if") {
        // `?:` / `&&` / `||`: each arm's value flows into this return, so each is
        // a tail position. The `if` itself still produces a value for any arm
        // that is NOT a tail call, so the trailing `return` below stays correct.
        rewriteArmTailCalls(ctx, fctx, (target as any).then as Instr[] | undefined);
        rewriteArmTailCalls(ctx, fctx, (target as any).else as Instr[] | undefined);
      }
    }
  }

  fctx.body.push({ op: "return" });
}

/**
 * (#2707c) Walk back from the end of `buf` through the call-result
 * materialization (`local.set X` / `local.get X` / `local.tee X`) and a trailing
 * #1511 `__argc`/`__extras_argv` reset to find the index of the underlying
 * value-producing `call` / `call_ref` / `if`. Returns -1 when the tail is not a
 * recognised call-materialization shape. PURE — never mutates `buf`.
 *
 * Recognised tails (call C, materialization local X, optional reset R):
 *   `C`                         · `C; local.tee X`        · `C; local.set X`
 *   `C; local.set X; local.get X`            (IR store/reload, same local)
 *   `C; local.set X; R; local.get X`         (closure: reset between store/load)
 * plus a bare trailing `if` (a `?:`/`&&`/`||` value).
 */
function peelToTailCallIdx(ctx: CodegenContext, buf: Instr[]): number {
  let idx = buf.length - 1;
  if (idx < 0) return -1;
  let loadLocal: number | undefined;
  const lastIns = buf[idx];
  if (lastIns && lastIns.op === "local.get") {
    loadLocal = (lastIns as { index?: number }).index;
    idx -= 1;
  }
  // A #1511 reset sitting between the materialization store and the trailing load.
  idx -= trailingArgcResetLen(ctx, buf.slice(0, idx + 1));
  if (idx < 0) return -1;
  const store = buf[idx];
  if (loadLocal !== undefined) {
    // The trailing `local.get X` is only a materialized call result if matched by
    // a `local.set X` store; otherwise it is an unrelated value.
    if (store && store.op === "local.set" && (store as { index?: number }).index === loadLocal) idx -= 1;
    else return -1;
  } else if (store && (store.op === "local.tee" || store.op === "local.set")) {
    idx -= 1;
  }
  if (idx < 0) return -1;
  return idx;
}

/**
 * (#2707c) Rewrite the trailing tail call of one `if`-arm (a Conditional /
 * Logical branch in return position) to `return_call` / `return_call_ref`.
 *
 * The arm's value-producing tail is one of:
 *   - a bare `call` / `call_ref` (e.g. the `||` short-circuit RHS),
 *   - a `call` / `call_ref` immediately followed by the IR's materialization
 *     `local.tee` / `local.set` (`… call $f / local.tee $ir`), or
 *   - a nested `if` (a `&&`/`||`/`?:` chain) — recurse into it.
 * Any other trailing shape (`f() + 1`, a plain value, a non-tail outer call)
 * is left untouched, so non-tail calls are never mis-promoted.
 *
 * Safe because the arm is in return position: the `if` result flows straight to
 * the `return`, so a materialization local written after the call is dead, and
 * `return_call` is a stack-polymorphic terminator, so any instruction left after
 * it in the arm is valid unreachable code.
 */
/**
 * (#2707c) Length of a trailing `__argc` / `__extras_argv` reset sequence at the
 * end of `buf` (4 with the extras reset, 2 for the argc-only variant), or 0 if
 * none. Mirrors `buildArgcExtrasReset` / `buildArgcResetNoLazyExtras` in
 * `expressions/calls.ts`:
 *   [ref.null $extrasVec, global.set $extras,] i32.const -1, global.set $argc
 * Identified by the module's known `__argc` / `__extras_argv` global indices, so
 * it never mis-matches an unrelated `global.set`.
 */
function trailingArgcResetLen(ctx: CodegenContext, buf: Instr[]): number {
  const n = buf.length;
  const argcIdx = ctx.argcGlobalIdx;
  if (argcIdx < 0 || n < 2) return 0;
  const d = buf[n - 1];
  const c = buf[n - 2];
  const argcReset =
    d !== undefined &&
    d.op === "global.set" &&
    (d as { index?: number }).index === argcIdx &&
    c !== undefined &&
    c.op === "i32.const" &&
    (c as { value?: number }).value === -1;
  if (!argcReset) return 0;
  const extrasIdx = ctx.extrasArgvGlobalIdx;
  if (extrasIdx >= 0 && n >= 4) {
    const b = buf[n - 3];
    const a = buf[n - 4];
    if (
      b !== undefined &&
      b.op === "global.set" &&
      (b as { index?: number }).index === extrasIdx &&
      a !== undefined &&
      a.op === "ref.null"
    ) {
      return 4;
    }
  }
  return 2;
}

function rewriteArmTailCalls(ctx: CodegenContext, fctx: FunctionContext, arm: Instr[] | undefined): void {
  if (!arm || arm.length === 0) return;
  // The arm's value flows straight into the enclosing `return`, so its tail call
  // (peeled through materialization + the #1511 reset, same as the top level) is
  // in tail position. PEEK first — the reset is dropped only on a confirmed
  // promotion, since stripping it without promoting reintroduces the stale-arg-
  // count leak it guards (#1511).
  const idx = peelToTailCallIdx(ctx, arm);
  if (idx < 0) return;
  const target = arm[idx];
  if (!target) return;
  // After promotion, `return_call` is a terminator, so every instruction after
  // `idx` (the materialization tee/set and the now-dead #1511 reset) is dead and
  // is dropped by truncating the arm to end at the terminator.
  if (target.op === "call") {
    if (canTailCall(ctx, fctx, (target as any).funcIdx as number)) {
      (target as any).op = "return_call";
      arm.length = idx + 1;
    }
  } else if (target.op === "call_ref") {
    const typeIdx = (target as any).typeIdx as number | undefined;
    if (typeIdx !== undefined && canTailCallRef(ctx, fctx, typeIdx)) {
      (target as any).op = "return_call_ref";
      arm.length = idx + 1;
    }
  } else if (target.op === "if") {
    rewriteArmTailCalls(ctx, fctx, (target as any).then as Instr[] | undefined);
    rewriteArmTailCalls(ctx, fctx, (target as any).else as Instr[] | undefined);
  }
}

/**
 * Detect null-comparison narrowing in an if-condition.
 * Returns the variable name narrowed to non-null and which branch benefits:
 *   - `x !== null` / `x != null` / `null !== x` / `null != x` → narrowed in THEN
 *   - `x === null` / `x == null` / `null === x` / `null == x` → narrowed in ELSE
 * Returns null if the condition is not a null comparison on a simple identifier.
 */
function nullishLiteralKind(expr: ts.Expression): "null" | "undefined" | null {
  if (expr.kind === ts.SyntaxKind.NullKeyword) return "null";
  if (expr.kind === ts.SyntaxKind.UndefinedKeyword) return "undefined";
  if (ts.isIdentifier(expr) && expr.text === "undefined") return "undefined";
  return null;
}

function nullishPresenceOfType(type: ts.Type): { hasNull: boolean; hasUndefined: boolean } {
  let hasNull = false;
  let hasUndefined = false;
  const parts = type.isUnion() ? type.types : [type];
  for (const part of parts) {
    if (part.flags & ts.TypeFlags.Null) hasNull = true;
    if (part.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) hasUndefined = true;
  }
  return { hasNull, hasUndefined };
}

function excludesAllNullish(type: ts.Type, excludes: NullishExclusion): boolean {
  const presence = nullishPresenceOfType(type);
  if (!presence.hasNull && !presence.hasUndefined) return false;
  if (presence.hasNull && excludes === "undefined") return false;
  if (presence.hasUndefined && excludes === "null") return false;
  return true;
}

function detectNullNarrowing(ctx: CodegenContext, expr: ts.Expression): NullGuardFact | null {
  if (!ts.isBinaryExpression(expr)) return null;
  const op = expr.operatorToken.kind;
  const isStrictNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  const isLooseNeq = op === ts.SyntaxKind.ExclamationEqualsToken;
  const isStrictEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const isLooseEq = op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq = isStrictNeq || isLooseNeq;
  const isEq = isStrictEq || isLooseEq;
  if (!isNeq && !isEq) return null;

  const rightNullish = nullishLiteralKind(expr.right);
  const leftNullish = nullishLiteralKind(expr.left);

  if (!rightNullish && !leftNullish) return null;

  const comparedNullish = rightNullish ?? leftNullish;
  const nonNullSide = rightNullish ? expr.left : expr.right;
  if (!ts.isIdentifier(nonNullSide)) return null;
  const excludes: NullishExclusion = isLooseEq || isLooseNeq ? "nullish" : comparedNullish!;

  return {
    varName: nonNullSide.text,
    narrowedBranch: isNeq ? "then" : "else",
    excludes,
    provesNonNull: excludesAllNullish(ctx.checker.getTypeAtLocation(nonNullSide), excludes),
  };
}

function detectAliasedNullNarrowing(fctx: FunctionContext, expr: ts.Expression): NullGuardFact | null {
  if (ts.isIdentifier(expr)) {
    return fctx.nullGuardAliases?.get(expr.text) ?? null;
  }
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.ExclamationToken &&
    ts.isIdentifier(expr.operand)
  ) {
    const alias = fctx.nullGuardAliases?.get(expr.operand.text);
    if (!alias) return null;
    return {
      ...alias,
      narrowedBranch: alias.narrowedBranch === "then" ? "else" : "then",
    };
  }
  return null;
}

/**
 * Detect `typeof x === "string"` / `typeof x === "number"` patterns in if conditions.
 * Returns the variable name, the type literal, and which branch is narrowed.
 */
function detectTypeofNarrowing(
  expr: ts.Expression,
): { varName: string; typeLiteral: string; narrowedBranch: "then" | "else" } | null {
  if (!ts.isBinaryExpression(expr)) return null;
  const op = expr.operatorToken.kind;
  const isEq = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const isNeq = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!isEq && !isNeq) return null;

  let typeofExpr: ts.TypeOfExpression | null = null;
  let stringLiteral: string | null = null;

  if (ts.isTypeOfExpression(expr.left) && ts.isStringLiteral(expr.right)) {
    typeofExpr = expr.left;
    stringLiteral = expr.right.text;
  } else if (ts.isTypeOfExpression(expr.right) && ts.isStringLiteral(expr.left)) {
    typeofExpr = expr.right;
    stringLiteral = expr.left.text;
  }

  if (!typeofExpr || !stringLiteral) return null;

  // Only narrow for simple identifier operands
  const operand = typeofExpr.expression;
  if (!ts.isIdentifier(operand)) return null;

  // Only narrow for "string" and "number" for now
  if (stringLiteral !== "string" && stringLiteral !== "number") return null;

  return {
    varName: operand.text,
    typeLiteral: stringLiteral,
    narrowedBranch: isEq ? "then" : "else",
  };
}

/**
 * Apply typeof narrowing for a branch: allocate a new local of the narrowed type,
 * emit unboxing from the AnyValue local, and remap localMap.
 * Returns the original local index so we can restore it later.
 */
function applyTypeofNarrowing(
  ctx: CodegenContext,
  fctx: FunctionContext,
  varName: string,
  typeLiteral: string,
): { originalLocalIdx: number; narrowedLocalIdx: number } | null {
  const originalLocalIdx = fctx.localMap.get(varName);
  if (originalLocalIdx === undefined) return null;

  // Check that the variable is currently AnyValue typed
  const localType = getLocalType(fctx, originalLocalIdx);
  if (!localType || !isAnyValue(localType, ctx)) return null;

  ensureAnyHelpers(ctx);

  let narrowedType: ValType;
  let unboxHelper: string;

  if (typeLiteral === "number") {
    narrowedType = { kind: "f64" };
    unboxHelper = "__any_unbox_f64";
  } else if (typeLiteral === "string") {
    narrowedType = { kind: "externref" };
    unboxHelper = "__any_unbox_extern";
  } else {
    return null;
  }

  const funcIdx = ctx.funcMap.get(unboxHelper);
  if (funcIdx === undefined) return null;

  // Allocate a new local for the narrowed value
  const narrowedLocalIdx = allocLocal(fctx, `__typeof_${varName}`, narrowedType);

  // Emit unboxing: load original AnyValue, call unbox, store in narrowed local
  fctx.body.push({ op: "local.get", index: originalLocalIdx });
  fctx.body.push({ op: "call", funcIdx });
  fctx.body.push({ op: "local.set", index: narrowedLocalIdx });

  // Remap the variable to use the narrowed local
  fctx.localMap.set(varName, narrowedLocalIdx);

  return { originalLocalIdx, narrowedLocalIdx };
}

export function compileIfStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.IfStatement): void {
  // Constant-folding: if the condition is a compile-time constant (e.g. after
  // --define substitution of process.env.NODE_ENV), emit only the taken branch.
  // Handles: "x" === "y", "x" !== "y", true, false, !true, !false
  const constResult = evaluateConstantCondition(stmt.expression);
  if (constResult !== undefined) {
    // Route the taken branch through compileStatement so its Block case runs
    // block-scope save/restore — a const-folded `if (true) { let x = ... }`
    // must not leak the inner binding into the enclosing scope either (#2064).
    if (constResult) {
      // Condition is always true — emit only the then branch
      compileStatement(ctx, fctx, stmt.thenStatement);
    } else if (stmt.elseStatement) {
      // Condition is always false — emit only the else branch (if any)
      compileStatement(ctx, fctx, stmt.elseStatement);
    }
    return;
  }

  // Detect null-narrowing pattern before compiling the condition
  const directNarrowing = detectNullNarrowing(ctx, stmt.expression);
  const aliasNarrowing = directNarrowing ? null : detectAliasedNullNarrowing(fctx, stmt.expression);
  const narrowing = directNarrowing ?? aliasNarrowing;

  // Detect typeof narrowing pattern (typeof x === "string" / "number")
  const typeofNarrowing = detectTypeofNarrowing(stmt.expression);

  // Compile condition
  const condType = compileExpression(ctx, fctx, stmt.expression);
  ensureI32Condition(fctx, condType, ctx);

  // The 'if' instruction adds one label level. Increment break/continue depths
  // so that br instructions emitted inside the if branches target the correct labels.
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;
  adjustRethrowDepth(fctx, 1);

  // Save pre-existing narrowed set so we can restore it after each branch
  const savedNarrowedNonNull = fctx.narrowedNonNull ? new Set(fctx.narrowedNonNull) : undefined;
  const savedAliasedNullGuardNonNull = fctx.aliasedNullGuardNonNull ? new Set(fctx.aliasedNullGuardNonNull) : undefined;

  // Apply narrowing for the then branch
  if (narrowing?.provesNonNull && narrowing.narrowedBranch === "then") {
    if (!fctx.narrowedNonNull) fctx.narrowedNonNull = new Set();
    fctx.narrowedNonNull.add(narrowing.varName);
    if (aliasNarrowing) {
      if (!fctx.aliasedNullGuardNonNull) fctx.aliasedNullGuardNonNull = new Set();
      fctx.aliasedNullGuardNonNull.add(narrowing.varName);
    }
  }

  // Compile then branch
  const savedBody = pushBody(fctx);

  // Apply typeof narrowing at start of the appropriate branch
  let typeofNarrowResult: { originalLocalIdx: number; narrowedLocalIdx: number } | null = null;
  if (typeofNarrowing && typeofNarrowing.narrowedBranch === "then") {
    typeofNarrowResult = applyTypeofNarrowing(ctx, fctx, typeofNarrowing.varName, typeofNarrowing.typeLiteral);
  }

  // Route through compileStatement so the generic Block case runs its
  // saveBlockScopedShadows/restoreBlockScopedShadows handling — otherwise a
  // branch-local `let`/`const` permanently clobbers the outer binding in
  // fctx.localMap/constBindings for the rest of the function (#2064).
  compileStatement(ctx, fctx, stmt.thenStatement);
  const thenInstrs = fctx.body;

  // Restore typeof narrowing after then branch
  if (typeofNarrowResult) {
    fctx.localMap.set(typeofNarrowing!.varName, typeofNarrowResult.originalLocalIdx);
  }

  // Restore narrowing before compiling else branch
  fctx.narrowedNonNull = savedNarrowedNonNull ? new Set(savedNarrowedNonNull) : undefined;
  fctx.aliasedNullGuardNonNull = savedAliasedNullGuardNonNull ? new Set(savedAliasedNullGuardNonNull) : undefined;

  // Apply narrowing for the else branch
  if (narrowing?.provesNonNull && narrowing.narrowedBranch === "else") {
    if (!fctx.narrowedNonNull) fctx.narrowedNonNull = new Set();
    fctx.narrowedNonNull.add(narrowing.varName);
    if (aliasNarrowing) {
      if (!fctx.aliasedNullGuardNonNull) fctx.aliasedNullGuardNonNull = new Set();
      fctx.aliasedNullGuardNonNull.add(narrowing.varName);
    }
  }

  // Compile else branch
  let elseInstrs: Instr[] | undefined;
  let typeofNarrowResultElse: { originalLocalIdx: number; narrowedLocalIdx: number } | null = null;
  if (stmt.elseStatement) {
    // (#1712) Park the completed then-branch buffer in savedBodies for the
    // whole else-compilation window. The raw `fctx.body = []` swap below
    // would otherwise leave `thenInstrs` reachable only through this local
    // variable — invisible to every late-import index shifter
    // (addStringImports / addUnionImports / fixupModuleGlobalIndices). A
    // string constant first registered inside the else branch (e.g. a
    // property null-throw message) then shifts all module-global indices
    // while the then-branch's already-emitted `global.get`s stay stale by
    // one. Compiling acorn hit exactly this: `FUNC_STATEMENT |
    // FUNC_NULLABLE_ID` inside a then branch read the neighbouring
    // (ref-typed) global and produced invalid Wasm. Mirrors the #779d fix
    // for destructuring branch buffers.
    fctx.savedBodies.push(thenInstrs);
    fctx.body = [];

    // Apply typeof narrowing for else branch
    if (typeofNarrowing && typeofNarrowing.narrowedBranch === "else") {
      typeofNarrowResultElse = applyTypeofNarrowing(ctx, fctx, typeofNarrowing.varName, typeofNarrowing.typeLiteral);
    }

    // Block-scope save/restore via compileStatement's Block case (#2064).
    compileStatement(ctx, fctx, stmt.elseStatement);
    elseInstrs = fctx.body;

    // Restore typeof narrowing after else branch
    if (typeofNarrowResultElse) {
      fctx.localMap.set(typeofNarrowing!.varName, typeofNarrowResultElse.originalLocalIdx);
    }

    // (#1712) Unpark the then-branch buffer (LIFO — must precede popBody).
    fctx.savedBodies.pop();
  }

  popBody(fctx, savedBody);

  // Restore original narrowing state (leaving the if block clears narrowing)
  fctx.narrowedNonNull = savedNarrowedNonNull;
  fctx.aliasedNullGuardNonNull = savedAliasedNullGuardNonNull;

  // Restore break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;
  adjustRethrowDepth(fctx, -1);

  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: thenInstrs,
    else: elseInstrs,
  });
}

/**
 * (#2063) Is the switch comparison domain a single, statically-known primitive
 * class? Per §14.12.2 CaseClauseIsSelected the discriminant is matched against
 * each case with **StrictEquality** (different types ⇒ no match, no coercion).
 * The fast path (unify the whole switch into one f64/i32/string comparison) is
 * only sound when the discriminant AND every case expression are provably the
 * same primitive class — otherwise an `any`/mixed switch silently coerces
 * (`switch(true){case 1}` matches; `switch("1"){case 1}` matches) or crashes
 * (numeric value shoved through string-equals). Returns the homogeneous class,
 * or null when the switch must use per-case strict equality.
 */
function homogeneousSwitchClass(ctx: CodegenContext, stmt: ts.SwitchStatement): "number" | "string" | "boolean" | null {
  const discType = ctx.checker.getTypeAtLocation(stmt.expression);
  let cls: "number" | "string" | "boolean" | null;
  if (isNumberType(discType)) cls = "number";
  else if (isStringType(discType)) cls = "string";
  else if (isBooleanType(discType)) cls = "boolean";
  else return null; // any / unknown / union / object discriminant → strict per-case
  for (const clause of stmt.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue; // default clause carries no value
    const caseType = ctx.checker.getTypeAtLocation(clause.expression);
    const caseCls = isNumberType(caseType)
      ? "number"
      : isStringType(caseType)
        ? "string"
        : isBooleanType(caseType)
          ? "boolean"
          : null;
    if (caseCls !== cls) return null; // any cross-class case ⇒ strict per-case
  }
  return cls;
}

/**
 * Return the common primitive class of every case expression without requiring
 * the discriminant to have that static class. This supports a guarded fast path
 * for JavaScript such as `switch (anyValue) { case 1: ... }`: test the
 * discriminant's runtime type once, then compare all numeric cases directly.
 *
 * Case expressions are still evaluated in source order even when the runtime
 * discriminant has another type, preserving their side effects.
 */
function homogeneousSwitchCaseClass(
  ctx: CodegenContext,
  stmt: ts.SwitchStatement,
): "number" | "string" | "boolean" | null {
  let cls: "number" | "string" | "boolean" | null = null;
  let sawCase = false;
  for (const clause of stmt.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue;
    sawCase = true;
    const caseFact = ctx.oracle.typeFactOf(clause.expression);
    const caseCls =
      caseFact.kind === "number" || caseFact.kind === "string" || caseFact.kind === "boolean" ? caseFact.kind : null;
    if (caseCls === null) return null;
    if (cls === null) cls = caseCls;
    else if (caseCls !== cls) return null;
  }
  return sawCase ? cls : null;
}

/**
 * A JavaScript local can remain checker-typed `any` even after the numeric-flow
 * pass has proved every definition stores a number and selected an unboxed f64
 * slot for codegen. Reuse that symbol-scoped proof for a switch discriminant.
 *
 * Without this bridge, `var ch = input.charCodeAt(i); switch (ch) { ... }`
 * immediately boxes `ch`, runtime-brand-checks it, and unboxes it again merely
 * because the checker still says `any`. The definition proof is stronger than
 * that checker type and makes the ordinary homogeneous numeric comparison
 * sound: the runtime value cannot be a string, object, bigint, or boolean.
 */
function isProvenNumericLocalSwitchDiscriminant(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.Expression,
): boolean {
  if (process.env.JS2WASM_GROUNDED_NUMERIC_SWITCHES === "0") return false;
  if (!ts.isIdentifier(expr)) return false;
  const localIdx = fctx.localMap.get(expr.text);
  if (localIdx !== undefined && getLocalType(fctx, localIdx)?.kind === "f64") return true;
  const declaration = ctx.oracle.variableDeclarationOf(expr);
  return declaration !== undefined && ctx.usageInference.scalarForDecl(declaration) === "number";
}

function isDefinitelyObjectSwitchFact(fact: TypeFact): boolean {
  switch (fact.kind) {
    case "array":
    case "tuple":
    case "function":
    case "class":
    case "builtin":
    case "object":
      return true;
    case "union":
      return fact.parts.length > 0 && fact.parts.every(isDefinitelyObjectSwitchFact);
    default:
      return false;
  }
}

/**
 * StrictEquality against a definitely-object case value only needs reference
 * identity. A primitive discriminant cannot match the object; the same object
 * compares true by `ref.eq`; every distinct object compares false. This is
 * deliberately a whole-switch proof so a mixed primitive/object case set keeps
 * the full per-case StrictEquality lowering.
 */
function switchHasOnlyObjectCases(ctx: CodegenContext, stmt: ts.SwitchStatement): boolean {
  let sawCase = false;
  for (const clause of stmt.caseBlock.clauses) {
    if (!ts.isCaseClause(clause)) continue;
    sawCase = true;
    if (!isDefinitelyObjectSwitchFact(ctx.oracle.typeFactOf(clause.expression))) return false;
  }
  return sawCase;
}

function emitSwitchObjectIdentityEq(
  fctx: FunctionContext,
  lTmp: number,
  rTmp: number,
  lAny: number,
  rAny: number,
): void {
  const EQ_HEAP = -19; // WasmGC `eq` abstract heap type
  fctx.body.push(
    { op: "local.get", index: lTmp },
    { op: "any.convert_extern" },
    { op: "local.set", index: lAny },
    { op: "local.get", index: rTmp },
    { op: "any.convert_extern" },
    { op: "local.set", index: rAny },
    { op: "local.get", index: lAny },
    { op: "ref.test", typeIdx: EQ_HEAP },
    { op: "local.get", index: rAny },
    { op: "ref.test", typeIdx: EQ_HEAP },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: lAny },
        { op: "ref.cast", typeIdx: EQ_HEAP },
        { op: "local.get", index: rAny },
        { op: "ref.cast", typeIdx: EQ_HEAP },
        { op: "ref.eq" },
      ],
      else: [{ op: "i32.const", value: 0 }],
    },
  );
}

/**
 * (#2063) Emit a §7.2.16 StrictEquality comparison of two externref operands
 * already spilled to temps `lTmp` / `rTmp`, pushing an i32 (1 = equal).
 *
 * Mirrors the externref-equality lowering the `===` operator uses
 * (binary-ops.ts): JS-host mode delegates to `__host_eq` (JS `===`, which is
 * strict and cross-type-false by construction, with a both-numbers unbox
 * fallback to recover equal numbers boxed in distinct externrefs); standalone /
 * WASI mode uses the #1776 Wasm-native tag dispatch (number→f64.eq,
 * boolean→i32.eq, bigint→i64.eq, native-string→value compare, else ref
 * identity). No coercion across tags — different runtime types compare unequal,
 * never crash.
 */
function emitSwitchStrictEq(ctx: CodegenContext, fctx: FunctionContext, lTmp: number, rTmp: number): void {
  const noJsHost = ctx.standalone === true || ctx.wasi === true;
  if (noJsHost) {
    const EQ_HEAP = -19; // WasmGC `eq` abstract heap type
    addUnionImports(ctx);
    const typeofNum = ctx.funcMap.get("__typeof_number")!;
    const typeofBool = ctx.funcMap.get("__typeof_boolean")!;
    const typeofBigint = ctx.funcMap.get("__typeof_bigint")!;
    const unboxNum = ctx.funcMap.get("__unbox_number")!;
    const unboxBool = ctx.funcMap.get("__unbox_boolean")!;
    const toBigint = ctx.funcMap.get("__to_bigint")!;

    const lAny = allocLocal(fctx, `__sweq_l_${fctx.locals.length}`, { kind: "anyref" });
    const rAny = allocLocal(fctx, `__sweq_r_${fctx.locals.length}`, { kind: "anyref" });
    const identityArm: Instr[] = [
      { op: "local.get", index: lAny },
      { op: "ref.test", typeIdx: EQ_HEAP },
      { op: "local.get", index: rAny },
      { op: "ref.test", typeIdx: EQ_HEAP },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: lAny },
          { op: "ref.cast", typeIdx: EQ_HEAP },
          { op: "local.get", index: rAny },
          { op: "ref.cast", typeIdx: EQ_HEAP },
          { op: "ref.eq" },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
    ];
    const refArm: Instr[] = [
      { op: "local.get", index: lTmp },
      { op: "any.convert_extern" },
      { op: "local.set", index: lAny },
      { op: "local.get", index: rTmp },
      { op: "any.convert_extern" },
      { op: "local.set", index: rAny },
    ];
    let stringArmEmitted = false;
    if (ctx.nativeStrings && ctx.anyStrTypeIdx >= 0) {
      ensureNativeStringHelpers(ctx);
      const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
      const strEqIdx = ctx.nativeStrHelpers.get("__str_equals");
      if (flattenIdx !== undefined && strEqIdx !== undefined) {
        stringArmEmitted = true;
        refArm.push(
          { op: "local.get", index: lAny },
          { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
          { op: "local.get", index: rAny },
          { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: lAny },
              { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
              { op: "call", funcIdx: flattenIdx },
              { op: "local.get", index: rAny },
              { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
              { op: "call", funcIdx: flattenIdx },
              { op: "call", funcIdx: strEqIdx },
            ],
            else: identityArm,
          },
        );
      }
    }
    if (!stringArmEmitted) refArm.push(...identityArm);

    const taggedCascade: Instr[] = [
      { op: "local.get", index: lTmp },
      { op: "call", funcIdx: typeofNum },
      { op: "local.get", index: rTmp },
      { op: "call", funcIdx: typeofNum },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: lTmp },
          { op: "call", funcIdx: unboxNum },
          { op: "local.get", index: rTmp },
          { op: "call", funcIdx: unboxNum },
          { op: "f64.eq" },
        ],
        else: [
          { op: "local.get", index: lTmp },
          { op: "call", funcIdx: typeofBool },
          { op: "local.get", index: rTmp },
          { op: "call", funcIdx: typeofBool },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: lTmp },
              { op: "call", funcIdx: unboxBool },
              { op: "local.get", index: rTmp },
              { op: "call", funcIdx: unboxBool },
              { op: "i32.eq" },
            ],
            else: [
              { op: "local.get", index: lTmp },
              { op: "call", funcIdx: typeofBigint },
              { op: "local.get", index: rTmp },
              { op: "call", funcIdx: typeofBigint },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [
                  { op: "local.get", index: lTmp },
                  { op: "call", funcIdx: toBigint },
                  { op: "local.get", index: rTmp },
                  { op: "call", funcIdx: toBigint },
                  { op: "i64.eq" },
                ],
                else: refArm,
              },
            ],
          },
        ],
      },
    ];

    // (#4621 D) NULL arm, ahead of the tag cascade. `null` is the null
    // externref, so `any.convert_extern` hands the identity arm a null anyref —
    // and `ref.test (ref eq)` on a null answers 0. The cascade therefore fell
    // all the way through to an identity test that CANNOT be true for two
    // nulls, making `switch (null) { case null: }` miss its own case and take
    // `default` (measured: `language/statements/switch/S12.11_A1_T{3,4}`,
    // "SwitchTest(null) === 192. Actual: 32"). §7.2.16 step 1: same Type ⇒
    // Null === Null is true.
    //
    // `undefined` is NOT null in this representation — it is the tag-1
    // singleton (#4489), so `ref.is_null` is false for it and `null ===
    // undefined` still answers false through the both-must-be-null test below.
    // The JS-host branch further down needs no arm: `__host_eq` is JS `===`.
    fctx.body.push(
      { op: "local.get", index: lTmp },
      { op: "ref.is_null" },
      { op: "local.get", index: rTmp },
      { op: "ref.is_null" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: lTmp },
          { op: "ref.is_null" },
          { op: "local.get", index: rTmp },
          { op: "ref.is_null" },
          { op: "i32.and" },
        ],
        else: taggedCascade,
      },
    );
    return;
  }

  // JS-host mode: delegate to JS `===` via `__host_eq`, with a both-numbers
  // unbox fallback to recover equal numbers boxed in distinct externrefs (the
  // same #1383-gated fallback the `===` operator uses).
  const hostEqIdx = ensureLateImport(
    ctx,
    "__host_eq",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "i32" }],
  );
  flushLateImportShifts(ctx, fctx);
  const finalHostEqIdx = ctx.funcMap.get("__host_eq") ?? hostEqIdx;
  const typeofNumIdx = ctx.funcMap.get("__typeof_number");
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  fctx.body.push(
    { op: "local.get", index: lTmp },
    { op: "local.get", index: rTmp },
    {
      op: "call",
      funcIdx: finalHostEqIdx!,
    },
  );
  if (typeofNumIdx !== undefined && unboxIdx !== undefined) {
    // Wrap: host_eq || (bothNumbers && unbox-eq).
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 1 }],
      else: [
        { op: "local.get", index: lTmp },
        { op: "call", funcIdx: typeofNumIdx },
        { op: "local.get", index: rTmp },
        { op: "call", funcIdx: typeofNumIdx },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: [
            { op: "local.get", index: lTmp },
            { op: "call", funcIdx: unboxIdx },
            { op: "local.get", index: rTmp },
            { op: "call", funcIdx: unboxIdx },
            { op: "f64.eq" },
          ],
          else: [{ op: "i32.const", value: 0 }],
        },
      ],
    });
  }
}

export function compileSwitchStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.SwitchStatement): void {
  // Evaluate the switch expression and save it to a temp local
  const exprType = ctx.checker.getTypeAtLocation(stmt.expression);
  let wasmType = resolveWasmType(ctx, exprType);

  // (#2063) When the discriminant and every case are NOT provably the same
  // primitive class, §14.12.2 requires per-case StrictEquality — the unified
  // f64/string fast path below would coerce (`switch(true){case 1}` matches) or
  // crash (numeric value through string-equals). Route those switches through a
  // boxed, per-case strict-equality comparison instead. `homogeneousClass` is
  // non-null exactly when the legacy fast path is sound.
  const homogeneousClass = homogeneousSwitchClass(ctx, stmt);
  const homogeneousCaseClass = homogeneousSwitchCaseClass(ctx, stmt);
  const provenNumericDiscriminant =
    homogeneousClass === null &&
    (ctx.standalone === true || ctx.wasi === true) &&
    homogeneousCaseClass === "number" &&
    isProvenNumericLocalSwitchDiscriminant(ctx, fctx, stmt.expression);
  const strictPerCase = homogeneousClass === null && !provenNumericDiscriminant;
  const guardedNumericCases =
    strictPerCase && (ctx.standalone === true || ctx.wasi === true) && homogeneousCaseClass === "number";
  const objectIdentityPerCase =
    strictPerCase &&
    !guardedNumericCases &&
    (ctx.standalone === true || ctx.wasi === true) &&
    switchHasOnlyObjectCases(ctx, stmt);

  // Detect if the switch discriminant or any case value involves strings (#245).
  // Check both the discriminant type and case expression types, since the
  // discriminant may be `any` while case values are string literals.
  let switchIsString = isStringType(exprType);
  if (!switchIsString) {
    for (const clause of stmt.caseBlock.clauses) {
      if (ts.isCaseClause(clause)) {
        const caseType = ctx.checker.getTypeAtLocation(clause.expression);
        if (isStringType(caseType)) {
          switchIsString = true;
          break;
        }
      }
    }
  }

  // (#2063) Strict per-case path: keep the discriminant boxed as externref and
  // compare each case with `emitSwitchStrictEq` (no coercion across types).
  if (strictPerCase && !guardedNumericCases) {
    wasmType = { kind: "externref" };
    switchIsString = false; // suppress the string fast path; strict-eq handles strings
  } else if (guardedNumericCases) {
    wasmType = { kind: "f64" };
    switchIsString = false;
  }

  // For string switch: use the appropriate string type and comparison
  let strEqFuncIdx: number | undefined;
  if (switchIsString) {
    if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
      // Fast mode: native string comparison
      ensureNativeStringHelpers(ctx);
      const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
      const equalsIdx = ctx.nativeStrHelpers.get("__str_equals");
      strEqFuncIdx = equalsIdx;
      wasmType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
    } else {
      // Non-fast mode: externref string comparison via wasm:js-string equals
      addStringImports(ctx);
      strEqFuncIdx = ctx.jsStringImports.get("equals");
      wasmType = { kind: "externref" };
    }
  } else if (!strictPerCase && wasmType.kind === "externref") {
    // Externref discriminant (non-string, homogeneous-numeric): unbox to f64 for
    // numeric comparison. The strict per-case path (#2063) keeps it externref.
    wasmType = { kind: "f64" };
  }

  const tmpLocalIdx = allocLocal(fctx, `__sw_${fctx.locals.length}`, wasmType);
  let guardedNumericMatchLocal = -1;
  if (guardedNumericCases) {
    addUnionImports(ctx);
    const typeofNum = ctx.funcMap.get("__typeof_number")!;
    const discriminant = allocLocal(fctx, `__sw_disc_${fctx.locals.length}`, { kind: "externref" });
    guardedNumericMatchLocal = allocLocal(fctx, `__sw_num_${fctx.locals.length}`, { kind: "i32" });
    const savedBody = pushBody(fctx);
    fctx.body.push({ op: "local.get", index: discriminant });
    emitToNumber(ctx, fctx, { kind: "externref" });
    fctx.body.push({ op: "local.set", index: tmpLocalIdx });
    const numericThen = fctx.body;
    popBody(fctx, savedBody);
    compileExpression(ctx, fctx, stmt.expression, { kind: "externref" });
    fctx.body.push(
      { op: "local.set", index: discriminant },
      { op: "f64.const", value: Number.NaN },
      { op: "local.set", index: tmpLocalIdx },
      { op: "local.get", index: discriminant },
      { op: "call", funcIdx: typeofNum },
      { op: "local.tee", index: guardedNumericMatchLocal },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: numericThen,
      },
    );
  } else {
    compileExpression(ctx, fctx, stmt.expression, wasmType);
    fctx.body.push({ op: "local.set", index: tmpLocalIdx });
  }

  // Use a "target" local to track which clause index to start executing from.
  // Sentinel value = number of clauses means "no match yet".
  const clauses = stmt.caseBlock.clauses;
  const noMatchSentinel = clauses.length;

  const targetLocalIdx = allocLocal(fctx, `__sw_target_${fctx.locals.length}`, { kind: "i32" });
  // Initialize target to sentinel (no match)
  fctx.body.push({ op: "i32.const", value: noMatchSentinel });
  fctx.body.push({ op: "local.set", index: targetLocalIdx });

  // Reuse two internal-reference temps for the whole object-valued switch.
  // The prior generic lowering allocated two temps and emitted a complete
  // primitive/tag cascade for every case.
  const objectIdentityLAny = objectIdentityPerCase
    ? allocLocal(fctx, `__sw_obj_l_${fctx.locals.length}`, { kind: "anyref" })
    : -1;
  const objectIdentityRAny = objectIdentityPerCase
    ? allocLocal(fctx, `__sw_obj_r_${fctx.locals.length}`, { kind: "anyref" })
    : -1;

  // Choose the equality opcode based on the switch expression type
  const eqOp: "f64.eq" | "i32.eq" = wasmType.kind === "i32" ? "i32.eq" : "f64.eq";

  // --- Phase 1: Evaluate all case expressions to find the target clause ---
  // Skip default clauses in this phase; just check case expressions.
  let defaultIdx = -1;
  for (let ci = 0; ci < clauses.length; ci++) {
    const clause = clauses[ci]!;
    if (ts.isDefaultClause(clause)) {
      defaultIdx = ci;
      continue;
    }
    const caseClause = clause as ts.CaseClause;

    // if (target == sentinel) { if (tmp == caseExpr) { target = ci; } }
    // Use pushBody/popBody so the outer body stays reachable for global-index
    // fixups when new string-constant imports are added during case compilation.
    const savedCaseBody = pushBody(fctx);

    if (strictPerCase && !guardedNumericCases) {
      // (#2063) Compile the case to externref and compare with the discriminant
      // (already boxed in tmpLocalIdx) using §7.2.16 StrictEquality. Pushes i32.
      const caseTmp = allocLocal(fctx, `__sw_case_${fctx.locals.length}`, { kind: "externref" });
      compileExpression(ctx, fctx, caseClause.expression, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: caseTmp });
      if (objectIdentityPerCase) {
        emitSwitchObjectIdentityEq(fctx, tmpLocalIdx, caseTmp, objectIdentityLAny, objectIdentityRAny);
      } else {
        emitSwitchStrictEq(ctx, fctx, tmpLocalIdx, caseTmp);
      }
    } else {
      fctx.body.push({ op: "local.get", index: tmpLocalIdx });
      if (switchIsString && ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
        fctx.body.push({ op: "call", funcIdx: flattenIdx });
      }
      compileExpression(ctx, fctx, caseClause.expression, wasmType);
      if (switchIsString && ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
        const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
        fctx.body.push({ op: "call", funcIdx: flattenIdx });
      }
      if (switchIsString && strEqFuncIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: strEqFuncIdx });
      } else {
        fctx.body.push({ op: eqOp });
      }
      if (guardedNumericCases) {
        fctx.body.push({ op: "local.get", index: guardedNumericMatchLocal }, { op: "i32.and" });
      }
    }
    // if (comparison result) { target = ci; }
    const setTarget: Instr[] = [
      { op: "i32.const", value: ci },
      { op: "local.set", index: targetLocalIdx },
    ];
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: setTarget,
    });

    const checkBody = fctx.body;
    popBody(fctx, savedCaseBody);

    // Guard: only check if target is still sentinel (no match found yet)
    fctx.body.push({ op: "local.get", index: targetLocalIdx });
    fctx.body.push({ op: "i32.const", value: noMatchSentinel });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: checkBody,
    });
  }

  // After checking all cases: if no case matched, fall to default (if present)
  if (defaultIdx >= 0) {
    const setDefault: Instr[] = [
      { op: "i32.const", value: defaultIdx },
      { op: "local.set", index: targetLocalIdx },
    ];
    fctx.body.push({ op: "local.get", index: targetLocalIdx });
    fctx.body.push({ op: "i32.const", value: noMatchSentinel });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: setDefault,
    });
  }

  // --- Phase 2: Emit clause bodies with fall-through ---
  // A clause body executes if clauseIndex >= target.
  // We use a "running" local that gets set to 1 once we reach the target
  // and stays 1 for fall-through (until a break resets via br).
  const runningLocalIdx = allocLocal(fctx, `__sw_running_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: runningLocalIdx });

  // Collect instructions for the switch block body
  const savedBody = pushBody(fctx);

  // Adjust existing break/continue depths: block adds 1 nesting level
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;
  adjustRethrowDepth(fctx, 1);

  // break from switch => br to outer block (depth 0 from inside the block).
  // Each case body is wrapped in an if (+1 nesting), so break depth = 1.
  const switchBreakIdx = fctx.breakStack.length;
  fctx.breakStack.push(1);

  for (let ci = 0; ci < clauses.length; ci++) {
    const clause = clauses[ci]!;

    // Set running = 1 if this clause is the target
    // if (target == ci) { running = 1; }
    const activateBody: Instr[] = [
      { op: "i32.const", value: 1 },
      { op: "local.set", index: runningLocalIdx },
    ];
    fctx.body.push({ op: "local.get", index: targetLocalIdx });
    fctx.body.push({ op: "i32.const", value: ci });
    fctx.body.push({ op: "i32.eq" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: activateBody,
    });

    // Emit body: if (running) { <statements> }
    // Use pushBody/popBody so the outer body stays reachable for global-index
    // fixups when new string-constant imports are added during case compilation.
    if (clause.statements.length > 0) {
      const savedSwitchBody = pushBody(fctx);

      // Adjust outer entries for the if-wrapping (+1 nesting level).
      for (let i = 0; i < switchBreakIdx; i++) fctx.breakStack[i]!++;
      for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
      if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;
      adjustRethrowDepth(fctx, 1);

      for (const s of clause.statements) {
        compileStatement(ctx, fctx, s);
      }

      // Restore depths after case body compilation
      for (let i = 0; i < switchBreakIdx; i++) fctx.breakStack[i]!--;
      for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
      if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;
      adjustRethrowDepth(fctx, -1);

      const bodyInstrs = fctx.body;
      popBody(fctx, savedSwitchBody);

      fctx.body.push({ op: "local.get", index: runningLocalIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: bodyInstrs,
      });
    }
  }

  fctx.breakStack.pop();

  // Restore existing break/continue depths
  for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
  for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
  if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;
  adjustRethrowDepth(fctx, -1);

  const switchBody = fctx.body;
  popBody(fctx, savedBody);

  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: switchBody,
  });
}

/**
 * Destructure a for-of element stored in `elemLocal` into the bindings of a
 * destructuring pattern. Handles both object and array binding patterns with
 * default values.
 */

export function compileLabeledStatement(ctx: CodegenContext, fctx: FunctionContext, stmt: ts.LabeledStatement): void {
  const labelName = stmt.label.text;
  const innerStmt = stmt.statement;

  // If the inner statement is a loop, we just record the label and let the
  // loop push its own break/continue entries. But if the inner statement is
  // a block (e.g. `label: { ... break label; ... }`), we need to wrap it in
  // a Wasm block so that `break label` can exit the entire labeled block.
  const isLoop =
    ts.isWhileStatement(innerStmt) ||
    ts.isDoStatement(innerStmt) ||
    ts.isForStatement(innerStmt) ||
    ts.isForInStatement(innerStmt) ||
    ts.isForOfStatement(innerStmt);

  if (isLoop) {
    // Record the label with the current break/continue stack indices.
    // The inner loop statement will push its own entries, so the label
    // points to the index that will be pushed by the labeled loop.
    const breakIdx = fctx.breakStack.length;
    const continueIdx = fctx.continueStack.length;
    fctx.labelMap.set(labelName, { breakIdx, continueIdx });

    compileStatement(ctx, fctx, innerStmt);

    fctx.labelMap.delete(labelName);
  } else {
    // Non-loop labeled statement: wrap in a Wasm block for break support.
    // Structure:
    //   block $label {
    //     body
    //   }
    const savedBody = pushBody(fctx);

    // Adjust existing break/continue depths: block adds 1 nesting level
    for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!++;
    for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!++;
    if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth++;
    adjustRethrowDepth(fctx, 1);

    // Push break entry for this labeled block: br 0 exits the block
    const breakIdx = fctx.breakStack.length;
    const continueIdx = fctx.continueStack.length;
    fctx.breakStack.push(0);
    fctx.labelMap.set(labelName, { breakIdx, continueIdx });

    compileStatement(ctx, fctx, innerStmt);

    const bodyInstrs = fctx.body;

    fctx.breakStack.pop();
    fctx.labelMap.delete(labelName);

    // Restore existing break/continue depths
    for (let i = 0; i < fctx.breakStack.length; i++) fctx.breakStack[i]!--;
    for (let i = 0; i < fctx.continueStack.length; i++) fctx.continueStack[i]!--;
    if (fctx.generatorReturnDepth !== undefined) fctx.generatorReturnDepth--;
    adjustRethrowDepth(fctx, -1);

    popBody(fctx, savedBody);
    fctx.body.push({
      op: "block",
      blockType: { kind: "empty" },
      body: bodyInstrs,
    });
  }
}

export function compileBreakStatement(_ctx: CodegenContext, fctx: FunctionContext, stmt: ts.BreakStatement): void {
  let breakIdx: number;
  if (stmt.label) {
    const labelName = stmt.label.text;
    const labelInfo = fctx.labelMap.get(labelName);
    if (labelInfo === undefined) return;
    breakIdx = labelInfo.breakIdx;
  } else {
    breakIdx = fctx.breakStack.length - 1;
  }
  const depth = fctx.breakStack[breakIdx];
  if (depth === undefined) return;

  // Inline finally blocks for any try-with-finally that we're breaking out of.
  // A finallyStack entry applies if the break target is outside the try block,
  // i.e. the breakStack index we're targeting is less than the entry's breakStackLen.
  if (fctx.finallyStack) {
    for (let i = fctx.finallyStack.length - 1; i >= 0; i--) {
      const entry = fctx.finallyStack[i]!;
      if (breakIdx < entry.breakStackLen) {
        // Retarget the clone's outer branches for the extra nesting between
        // this break site and the try frame (#2061).
        fctx.body.push(...entry.cloneFinallyAtDepth(finallyInlineDelta(fctx, entry)));
      }
    }
  }

  fctx.body.push({ op: "br", depth });
}

export function compileContinueStatement(
  _ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ContinueStatement,
): void {
  let contIdx: number;
  if (stmt.label) {
    const labelName = stmt.label.text;
    const labelInfo = fctx.labelMap.get(labelName);
    if (labelInfo === undefined) return;
    contIdx = labelInfo.continueIdx;
  } else {
    contIdx = fctx.continueStack.length - 1;
  }
  const depth = fctx.continueStack[contIdx];
  if (depth === undefined) return;

  // Inline finally blocks for any try-with-finally that we're continuing out of.
  if (fctx.finallyStack) {
    for (let i = fctx.finallyStack.length - 1; i >= 0; i--) {
      const entry = fctx.finallyStack[i]!;
      if (contIdx < entry.continueStackLen) {
        // Retarget the clone's outer branches for the extra nesting between
        // this continue site and the try frame (#2061).
        fctx.body.push(...entry.cloneFinallyAtDepth(finallyInlineDelta(fctx, entry)));
      }
    }
  }

  fctx.body.push({ op: "br", depth });
}

/**
 * Evaluate a condition expression at compile time if possible.
 * Returns true/false for constant conditions, undefined if not constant.
 *
 * Handles:
 * - `"x" === "y"`, `"x" !== "y"` (string literal comparisons)
 * - `true`, `false` literals
 * - `!<constant>` (prefix logical not)
 * - `"x" == "y"`, `"x" != "y"` (loose equality on string literals)
 * - `&&` and `||` with constant operands
 */
export function evaluateConstantCondition(expr: ts.Expression): boolean | undefined {
  // Unwrap parentheses
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;

  // Boolean literals: true, false
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;

  // Prefix !: negate a constant sub-expression
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = evaluateConstantCondition(e.operand);
    return inner !== undefined ? !inner : undefined;
  }

  // Binary comparison of two string literals
  if (ts.isBinaryExpression(e)) {
    const left = unwrapParens(e.left);
    const right = unwrapParens(e.right);
    if (ts.isStringLiteral(left) && ts.isStringLiteral(right)) {
      const eq = left.text === right.text;
      switch (e.operatorToken.kind) {
        case ts.SyntaxKind.EqualsEqualsEqualsToken:
        case ts.SyntaxKind.EqualsEqualsToken:
          return eq;
        case ts.SyntaxKind.ExclamationEqualsEqualsToken:
        case ts.SyntaxKind.ExclamationEqualsToken:
          return !eq;
      }
    }
    // Logical && and || with constant operands
    if (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      const l = evaluateConstantCondition(e.left);
      if (l === false) return false;
      if (l === true) return evaluateConstantCondition(e.right);
    }
    if (e.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
      const l = evaluateConstantCondition(e.left);
      if (l === true) return true;
      if (l === false) return evaluateConstantCondition(e.right);
    }
  }

  return undefined;
}

function unwrapParens(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}
