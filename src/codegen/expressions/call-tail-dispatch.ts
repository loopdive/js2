// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Tail dispatch of compileCallExpression extracted from the ~13k-line function
// (#742, Wave B mega-function decomposition, slice 5). The single exported entry
// `compileTailDispatch` handles the callee shapes that remain after the
// property-access and identifier arms: the IIFE forms, super method calls,
// element-access method calls, call-of-call chains, a conditional callee, and
// the graceful fallback for unrecognized shapes. Its graceful fallback is
// unconditional, so it ALWAYS returns an InnerResult — compileCallExpression's
// tail is a single `return compileTailDispatch(...)`. Moved verbatim: the
// emitted Wasm is byte-identical.
import { forEachChild, ts } from "../../ts-api.js";
import { isNumberType, isStringType, isVoidType } from "../../checker/type-mapper.js";
import type { Instr, ValType } from "../../ir/types.js";
import { compileArrayMethodCall, resolveArrayInfo } from "../array-methods.js";
import {
  compileArrowAsClosure,
  compileArrowFunction,
  getClosureFuncSelfTypeIdx,
  getOrCreateFuncRefWrapperTypes,
} from "../closures.js";
import { popBody, pushBody } from "../context/bodies.js";
import { reportError } from "../context/errors.js";
import { allocLocal } from "../context/locals.js";
import { rollbackSpeculative } from "../context/speculative.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "../context/types.js";
import { collectDirectEvalBindingNames, functionMayReachDirectEval } from "../direct-eval-environment.js";
import {
  getArrTypeIdxFromVec,
  getOrRegisterVecType,
  hoistLetConstWithTdz,
  hoistVarDeclarations,
  resolveWasmType,
} from "../index.js";
import { objectLiteralTakesStandaloneAnyObjectPath, resolveComputedKeyExpression } from "../literals.js";
import { emitNullCheckThrow, typeErrorThrowInstrs } from "../property-access.js";
import { tryCompileStandaloneRegExpSymbolCall, usesNativeRegExpProvider } from "../regexp-standalone.js";
import type { InnerResult } from "../shared.js";
import { brandExternMethodResult, coerceType, compileExpression, VOID_RESULT } from "../shared.js";
import { compileStatement, hoistFunctionDeclarations } from "../statements.js";
import { ensureExtrasArgvGlobal, maybeSetArgcForKnownCall } from "../statements/nested-declarations.js";
import { compileStringLiteral, isStaticUndefinedArg } from "../string-ops.js";
import { isStrictFunction } from "../helpers/is-strict-function.js";
import { needsImplicitArgumentsObject } from "../helpers/body-uses-arguments.js";
import {
  defaultValueInstrs,
  emitGuardedFuncRefCast,
  emitGuardedRefCast,
  pushDefaultValue,
  pushParamSentinel,
} from "../type-coercion.js";
import {
  compileCallableElementAccessCall,
  compileClosureCall,
  emitMatchedClosureCallArguments, // (#4394) rest-aware matched-closure args
  runtimeSignatureParameters, // (#4491) drops the synthetic `arguments` rest
} from "./calls-closures.js";
import { tsSignatureHasRest } from "./closure-sig-match.js"; // (#4394)
import {
  buildThrowJsErrorInstrs,
  getFuncParamTypes,
  getWasmFuncReturnType,
  isEffectivelyVoidReturn,
  noJsHost,
  wasmFuncReturnsVoid,
} from "./helpers.js";
import { ensureLateImport, flushLateImportShifts } from "./late-imports.js";
import { resolveStructName } from "./misc.js";
import { tryReshapeBindToNamedThisCall } from "../named-this-call.js"; // (#4203)
import { compileSuperElementMethodCall } from "./new-super.js";
import { compileCallDispatchTail, tryEmitStoredMemberClosureCall } from "./stored-member-closure-call.js";
import { classMemberFuncKey } from "../class-member-keys.js";
import { matchClosureInfoBySignature } from "./closure-sig-match.js"; // (#4394) exact-first closure pick
import { emitPlainObjectDynamicCallWithReceiver } from "./plain-object-dynamic-receiver-call.js";
import { tryEmitDynamicElementHostMethodCall } from "./dynamic-element-host-call.js";
import {
  classInstanceHasField,
  coerceNumberMethodArgToF64,
  compileCallExpression,
  compileConditionalCallee,
  compileFunctionBind,
  compileIIFE,
  elemAccessReceiverIsPlainObject,
  elemAccessReceiverIsUserClass,
  emitBoundFunctionCall,
  emitClosureCallArgcExtras,
  emitResetArgcExtras,
  emitSetArgc,
  functionExprBodyReferencesOwnName,
  tryEmitInlineDynamicCall,
} from "./calls.js";
import { enterInlineIifeBindingScope, argumentsEscapesIife } from "./inline-iife-scope.js"; // (#4555)

function isPristineStringPrototypeExpression(fctx: FunctionContext, expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === "prototype" &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "String" &&
    !fctx.localMap.has("String") &&
    !(fctx.boxedCaptures?.has("String") ?? false)
  );
}

/**
 * (#742 slice 5) Tail dispatch of compileCallExpression — extracted verbatim.
 * Handles the remaining callee shapes after the property-access and identifier
 * arms: the IIFE forms (`(function(){…})()` / `(()=>…)()`), super method calls,
 * element-access method calls (`obj[expr](…)`), call-of-call chains, a
 * conditional callee, and finally the graceful fallback (compile callee + args
 * for side effects, push ref.null.extern) for unrecognized shapes.
 *
 * The graceful fallback is unconditional, so this helper ALWAYS returns an
 * InnerResult — compileCallExpression's tail is therefore a single
 * `return compileTailDispatch(...)`. `expectedType` is threaded through. Moved
 * unchanged so the emitted Wasm is byte-identical.
 */
export function compileTailDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  expectedType?: ValType,
): InnerResult {
  // Handle IIFE: (function() { ... })() or (() => expr)() — inline the function body
  {
    // Unwrap parenthesized expression to find the function/arrow
    let callee: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(callee)) {
      callee = callee.expression;
    }
    if (ts.isFunctionExpression(callee) || ts.isArrowFunction(callee)) {
      // Generator function expressions (function*) must NOT be inlined as IIFEs
      // because their body contains `yield` which requires a generator context.
      // Let them fall through to the normal closure compilation path (#657).
      const isGeneratorIIFE = ts.isFunctionExpression(callee) && callee.asteriskToken !== undefined;
      // (#2707c) A *recursive* named function expression IIFE —
      // `(function f(n){ … f(n-1) … })(N)` — must NOT be inlined either: the
      // inlined body has no real callable to bind its own name `f` to, so the
      // self-call silently fails to recurse (the base case is never reached, so
      // e.g. a test262 TCO counter stays 0). Compile it as a closure instead —
      // the closure path binds the function-expression's own name via `__self`
      // (the lifted param-0 self-reference), exactly as it already does for
      // `var g = function f(n){ … f(n-1) … }`. Conservative: ANY reference to
      // the own name inside the body routes here (compile-as-closure is always
      // semantically correct, just unInlined), so a shadowed reference can never
      // be mis-inlined.
      const isRecursiveNamedFnExprIIFE =
        ts.isFunctionExpression(callee) && callee.name !== undefined && functionExprBodyReferencesOwnName(callee);
      // A direct eval needs a genuine per-call function environment. The
      // inliner deliberately has no separate activation, so compiling this
      // shape inline would either expose caller bindings or omit IIFE-owned
      // bindings from the eval environment. Use the normal closure path.
      const reachesDirectEval = functionMayReachDirectEval(callee, ctx.oracle);
      if (isGeneratorIIFE || isRecursiveNamedFnExprIIFE || reachesDirectEval || argumentsEscapesIife(callee, expr)) {
        // Cannot inline: a generator IIFE needs a generator context for `yield`,
        // and a recursive named-fn-expr IIFE needs a real callable to bind its
        // own name to. Compile as closure, store in temp local, invoke via
        // call_ref — the closure path binds `function*`'s context and a named
        // expression's own name (self-reference) correctly.
        const closureType = compileArrowFunction(ctx, fctx, callee as ts.FunctionExpression);
        if (closureType && (closureType.kind === "ref" || closureType.kind === "ref_null")) {
          const typeIdx = (closureType as { typeIdx: number }).typeIdx;
          const closureInfo = ctx.closureInfoByTypeIdx.get(typeIdx);
          if (closureInfo) {
            // Store closure ref in a temp local
            const tmpName = `__iife_closure_${fctx.locals.length}`;
            const tmpLocal = allocLocal(fctx, tmpName, closureType);
            fctx.body.push({ op: "local.set", index: tmpLocal });
            // Register the temp local so compileClosureCall can find it
            fctx.localMap.set(tmpName, tmpLocal);
            return compileClosureCall(ctx, fctx, expr, tmpName, closureInfo);
          }
        }
        // If closure compilation failed, drop any value on stack and fall through to fallback
        if (closureType) {
          fctx.body.push({ op: "drop" });
        }
      } else {
        const params = callee.parameters;
        const args = expr.arguments;
        // Check if the IIFE body references `arguments` (only for function expressions, not arrows)
        const iifeNeedsArguments = ts.isFunctionExpression(callee) && needsImplicitArgumentsObject(callee);
        // Support IIFEs with matching parameter/argument counts
        if (params.length <= args.length) {
          const iifeBindingNames = collectDirectEvalBindingNames(callee);
          if (ts.isFunctionExpression(callee) && callee.name) iifeBindingNames.add(callee.name.text);
          const leaveIifeBindingScope = enterInlineIifeBindingScope(fctx, iifeBindingNames);
          try {
            // (#3128) Record that this function node is being INLINED into the
            // current fctx: its AST function boundary does not exist in the
            // emitted Wasm. The closure capture-mutability analysis
            // (compileArrowAsClosure `writtenInOuter`) reads this to walk PAST
            // the IIFE when locating the real enclosing scope — otherwise a
            // closure inside the IIFE body that captures an outer var written
            // outside the IIFE (`p2 = (function(){ return () => p2; })()`)
            // misses the write and captures a stale by-value copy.
            (fctx.inlinedIifeNodes ??= new Set()).add(callee);
            // Allocate locals for parameters and compile arguments
            const paramLocals: number[] = [];
            const allArgLocals: { idx: number; type: ValType }[] = [];
            for (let i = 0; i < params.length; i++) {
              const param = params[i]!;
              const paramName = ts.isIdentifier(param.name) ? param.name.text : `__iife_p${i}`;
              const argType = compileExpression(ctx, fctx, args[i]!);
              const localType = argType ?? { kind: "f64" as const };
              const idx = allocLocal(fctx, paramName, localType);
              fctx.body.push({ op: "local.set", index: idx });
              paramLocals.push(idx);
              if (iifeNeedsArguments) {
                allArgLocals.push({ idx, type: localType });
              }
            }
            // Extra arguments beyond declared params
            if (iifeNeedsArguments) {
              // Store extra args in locals for the arguments object
              for (let i = params.length; i < args.length; i++) {
                const t = compileExpression(ctx, fctx, args[i]!);
                const localType = t ?? { kind: "f64" as const };
                if (t === null) {
                  // No value produced — push a default
                  fctx.body.push({ op: "f64.const", value: 0 });
                }
                const idx = allocLocal(fctx, `__iife_extra_${i}`, localType as ValType);
                fctx.body.push({ op: "local.set", index: idx });
                allArgLocals.push({ idx, type: localType as ValType });
              }
            } else {
              // Drop extra arguments (evaluate for side effects)
              for (let i = params.length; i < args.length; i++) {
                const t = compileExpression(ctx, fctx, args[i]!);
                if (t) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }

            // Set up `arguments` vec for the IIFE if needed
            if (iifeNeedsArguments && allArgLocals.length > 0) {
              // Ensure __box_number is available for boxing numeric args
              const hasNumeric = allArgLocals.some((a) => a.type.kind === "f64" || a.type.kind === "i32");
              if (hasNumeric) {
                ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                flushLateImportShifts(ctx, fctx);
              }

              const vti = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
              const ati = getArrTypeIdxFromVec(ctx, vti);
              const vecRef: ValType = { kind: "ref", typeIdx: vti };
              const argsLocal = allocLocal(fctx, "arguments", vecRef);
              const arrTmp = allocLocal(fctx, "__iife_args_arr", { kind: "ref", typeIdx: ati });

              for (const { idx, type } of allArgLocals) {
                fctx.body.push({ op: "local.get", index: idx });
                if (type.kind === "f64") {
                  const boxIdx = ctx.funcMap.get("__box_number");
                  if (boxIdx !== undefined) {
                    fctx.body.push({ op: "call", funcIdx: boxIdx });
                  } else {
                    fctx.body.push({ op: "drop" });
                    fctx.body.push({ op: "ref.null.extern" });
                  }
                } else if (type.kind === "i32") {
                  fctx.body.push({ op: "f64.convert_i32_s" });
                  const boxIdx = ctx.funcMap.get("__box_number");
                  if (boxIdx !== undefined) {
                    fctx.body.push({ op: "call", funcIdx: boxIdx });
                  } else {
                    fctx.body.push({ op: "drop" });
                    fctx.body.push({ op: "ref.null.extern" });
                  }
                } else if (type.kind === "ref" || type.kind === "ref_null") {
                  fctx.body.push({ op: "extern.convert_any" });
                }
                // externref: already correct
              }
              fctx.body.push({ op: "array.new_fixed", typeIdx: ati, length: allArgLocals.length });
              fctx.body.push({ op: "local.set", index: arrTmp });
              fctx.body.push({ op: "i32.const", value: allArgLocals.length });
              fctx.body.push({ op: "local.get", index: arrTmp });
              fctx.body.push({ op: "struct.new", typeIdx: vti });
              fctx.body.push({ op: "local.set", index: argsLocal });
            } else if (iifeNeedsArguments) {
              // No arguments at all — create empty arguments vec
              const vti = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
              const ati = getArrTypeIdxFromVec(ctx, vti);
              const vecRef: ValType = { kind: "ref", typeIdx: vti };
              const argsLocal = allocLocal(fctx, "arguments", vecRef);
              const arrTmp = allocLocal(fctx, "__iife_args_arr", { kind: "ref", typeIdx: ati });
              fctx.body.push({ op: "array.new_fixed", typeIdx: ati, length: 0 });
              fctx.body.push({ op: "local.set", index: arrTmp });
              fctx.body.push({ op: "i32.const", value: 0 });
              fctx.body.push({ op: "local.get", index: arrTmp });
              fctx.body.push({ op: "struct.new", typeIdx: vti });
              fctx.body.push({ op: "local.set", index: argsLocal });
            }

            // Compile body
            if (ts.isArrowFunction(callee) && !ts.isBlock(callee.body)) {
              // Concise body: expression — no return issue
              const savedDeferredDynamicImportTrap = fctx.deferredDynamicImportTrap;
              fctx.deferredDynamicImportTrap = !callee.modifiers?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
              );
              const result = compileExpression(ctx, fctx, callee.body);
              fctx.deferredDynamicImportTrap = savedDeferredDynamicImportTrap;
              return result;
            }

            // Block body (arrow or function expression) — need to handle return
            const bodyStmts = ts.isArrowFunction(callee)
              ? (callee.body as ts.Block).statements
              : callee.body.statements;
            if (bodyStmts.length === 0) {
              return VOID_RESULT;
            }

            // #3509 — ordinary IIFEs use the same host-free call-site trap as
            // invoking a previously-created ordinary closure. The inline path
            // has no lifted FunctionContext of its own, so carry the marker only
            // while compiling this function body. Async IIFEs stay on #3494's
            // explicit unsupported path (a synchronous throw is not a Promise
            // rejection and would be a semantic lie).
            const savedDeferredDynamicImportTrap = fctx.deferredDynamicImportTrap;
            fctx.deferredDynamicImportTrap = !callee.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
            );

            // Determine return type from TS
            const iifeRetType = ctx.checker.getTypeAtLocation(expr);
            let iifeWasmRetType = isVoidType(iifeRetType) ? null : resolveWasmType(ctx, iifeRetType);
            // (#3128) The ret-local type must agree with what the returned
            // expression will ACTUALLY lower to. Under standalone, an object
            // literal in any/unknown/dictionary context diverts to the open
            // `$Object` path and produces an **externref**
            // (`objectLiteralTakesStandaloneAnyObjectPath`, the #1901/#2542
            // gate) — but `resolveWasmType` types the ret local from the TS
            // struct type. The return-site coercion externref→(ref null $struct)
            // then goes through a `ref.test` arm that silently yields NULL
            // (measured: `p2 = (function(){ return { a: (function(){ return
            // p2; }) }; })()` — p2 read back null; the #3128-A cell write itself
            // was correct, it faithfully wrote the nulled ret value). Mirror the
            // literal's own divert decision here and widen the ret local to
            // externref; struct-typed sibling returns coerce ref→externref
            // losslessly (`extern.convert_any`). Scan only the IIFE's OWN
            // returns — nested function boundaries keep their own return type.
            if (iifeWasmRetType && (iifeWasmRetType.kind === "ref" || iifeWasmRetType.kind === "ref_null")) {
              let divertedObjlitReturn = false;
              const scanReturns = (node: ts.Node): void => {
                if (divertedObjlitReturn) return;
                if (ts.isFunctionLike(node) && node !== callee) return;
                if (ts.isReturnStatement(node) && node.expression) {
                  let retExpr: ts.Expression = node.expression;
                  while (ts.isParenthesizedExpression(retExpr)) retExpr = retExpr.expression;
                  if (
                    ts.isObjectLiteralExpression(retExpr) &&
                    objectLiteralTakesStandaloneAnyObjectPath(ctx, retExpr)
                  ) {
                    divertedObjlitReturn = true;
                    return;
                  }
                }
                forEachChild(node, scanReturns);
              };
              for (const stmt of bodyStmts) scanReturns(stmt);
              if (divertedObjlitReturn) {
                iifeWasmRetType = { kind: "externref" };
              }
            }

            if (iifeWasmRetType) {
              // Returning IIFE: allocate a result local, compile body into a block,
              // and replace `return` with `local.set + br` to exit the block
              const retLocal = allocLocal(fctx, `__iife_ret_${fctx.locals.length}`, iifeWasmRetType);
              const savedBody = fctx.body;
              fctx.savedBodies.push(savedBody);
              const blockBody: Instr[] = [];
              // (#3017) An inlined IIFE has no Wasm FunctionContext of its own,
              // but it remains a source function boundary for legacy
              // Function#caller semantics. Preserve the region's strictness so
              // the final call-site pass does not inherit the containing Wasm
              // function's bit (for example, a strict IIFE inside a sloppy
              // Test262 wrapper).
              ctx.sourceFunctionStrictnessByBody.set(
                blockBody,
                isStrictFunction(callee, ctx.inferModuleStrictArguments),
              );
              fctx.body = blockBody;

              // Save and override returnType so that return statements inside the
              // IIFE coerce to the IIFE's own return type, not the outer function's.
              // Without this, a boolean-returning IIFE inside an f64-returning
              // function would coerce i32→f64 before local.set into an i32 local.
              const savedReturnType = fctx.returnType;
              fctx.returnType = iifeWasmRetType;

              // A real function instantiation creates all var bindings before
              // body evaluation. Besides read-before-declaration semantics, this
              // pre-allocation makes an IIFE-local var shadow a same-named module
              // global while the body is compiled.
              hoistVarDeclarations(ctx, fctx, bodyStmts as unknown as ts.Statement[]);
              // Hoist let/const with TDZ flags so accesses before init throw (#790)
              hoistLetConstWithTdz(ctx, fctx, bodyStmts as unknown as ts.Statement[]);
              // Hoist function declarations so they're available before textual position
              hoistFunctionDeclarations(ctx, fctx, bodyStmts as unknown as ts.Statement[]);

              // Increase block depth so return→br targets the right level
              fctx.blockDepth++;
              for (const stmt of bodyStmts) {
                compileStatement(ctx, fctx, stmt);
              }
              fctx.blockDepth--;

              fctx.deferredDynamicImportTrap = savedDeferredDynamicImportTrap;

              // Restore outer function's return type
              fctx.returnType = savedReturnType;
              fctx.savedBodies.pop();
              fctx.body = savedBody;

              // Post-process: replace `return` / `return_call` / `return_call_ref` ops
              // with `local.set retLocal + br <depth>`.  Tail-call optimization in
              // compileReturnStatement may have merged call+return into return_call;
              // inside an IIFE we must undo that since we need local.set + br instead.
              function patchReturns(instrs: Instr[], depth: number): void {
                for (let i = 0; i < instrs.length; i++) {
                  const op = instrs[i]!.op;
                  if (op === "return") {
                    // The instruction before `return` is the return value expression.
                    // Replace `return` with `local.set + br`
                    instrs[i] = { op: "local.set", index: retLocal };
                    instrs.splice(i + 1, 0, { op: "br", depth });
                    i++; // skip the inserted br
                  } else if (op === "return_call" || op === "return_call_ref") {
                    // Undo tail-call: return_call funcIdx → call funcIdx + local.set + br
                    const instr = instrs[i] as any;
                    instr.op = op === "return_call" ? "call" : "call_ref";
                    instrs.splice(i + 1, 0, { op: "local.set", index: retLocal }, { op: "br", depth });
                    i += 2; // skip inserted instructions
                  }
                  // Recurse into sub-blocks (if/then/else/block/loop)
                  const instr = instrs[i] as any;
                  if (instr.then) patchReturns(instr.then, depth + 1);
                  if (instr.else) patchReturns(instr.else, depth + 1);
                  if (instr.body && Array.isArray(instr.body)) patchReturns(instr.body, depth + 1);
                }
              }
              patchReturns(blockBody, 0);

              // Emit: block { <body> } local.get retLocal
              fctx.body.push({
                op: "block",
                blockType: { kind: "empty" },
                body: blockBody,
              });
              fctx.body.push({ op: "local.get", index: retLocal });
              return iifeWasmRetType;
            } else {
              // Void IIFE — wrap the body in a block so that `return` inside
              // the IIFE exits ONLY the IIFE rather than the enclosing function
              // (#1348). Without this wrapper, e.g.
              //   (function () { for (var x of it) { return; } }());
              // would emit a Wasm `return` from the outer function, dropping
              // any `for-of`-followups (post-IIFE asserts) and breaking the
              // §14.7.5 IteratorClose-on-return semantics expected by callers.
              const savedBody = fctx.body;
              fctx.savedBodies.push(savedBody);
              const blockBody: Instr[] = [];
              // Keep the source-level boundary even though the IIFE is inlined;
              // see the returning arm above.
              ctx.sourceFunctionStrictnessByBody.set(
                blockBody,
                isStrictFunction(callee, ctx.inferModuleStrictArguments),
              );
              fctx.body = blockBody;

              // Save and override returnType: void IIFE has no return value,
              // so any `return <expr>;` inside the body should drop the value
              // (we model this by setting returnType=null which causes
              // compileReturnStatement to drop the expression value).
              const savedReturnType = fctx.returnType;
              fctx.returnType = null;

              // See the returning arm above: function-scoped vars must exist
              // before the first statement and must shadow outer/global names.
              hoistVarDeclarations(ctx, fctx, bodyStmts as unknown as ts.Statement[]);
              // Hoist let/const with TDZ flags so accesses before init throw (#790)
              hoistLetConstWithTdz(ctx, fctx, bodyStmts as unknown as ts.Statement[]);
              // Hoist function declarations so they're available before textual position
              hoistFunctionDeclarations(ctx, fctx, bodyStmts as unknown as ts.Statement[]);

              // Increase block depth so return→br targets the right level
              fctx.blockDepth++;
              for (const stmt of bodyStmts) {
                compileStatement(ctx, fctx, stmt);
              }
              fctx.blockDepth--;

              fctx.deferredDynamicImportTrap = savedDeferredDynamicImportTrap;

              // Restore outer function's return type
              fctx.returnType = savedReturnType;
              fctx.savedBodies.pop();
              fctx.body = savedBody;

              // Post-process: replace `return` / `return_call` / `return_call_ref`
              // with `br <depth>`. Tail-call optimization in compileReturnStatement
              // may have merged call+return into return_call; inside an IIFE we
              // must undo that and lower it back to a plain call.
              function patchVoidReturns(instrs: Instr[], depth: number): void {
                for (let i = 0; i < instrs.length; i++) {
                  const op = instrs[i]!.op;
                  if (op === "return") {
                    // void IIFE: no value to capture — replace with br
                    instrs[i] = { op: "br", depth };
                  } else if (op === "return_call" || op === "return_call_ref") {
                    // Undo tail-call: rewrite as plain call + br
                    const instr = instrs[i] as any;
                    instr.op = op === "return_call" ? "call" : "call_ref";
                    instrs.splice(i + 1, 0, { op: "br", depth });
                    i++; // skip inserted br
                  }
                  const instr = instrs[i] as any;
                  if (instr.then) patchVoidReturns(instr.then, depth + 1);
                  if (instr.else) patchVoidReturns(instr.else, depth + 1);
                  if (instr.body && Array.isArray(instr.body)) patchVoidReturns(instr.body, depth + 1);
                  if (instr.catchAll && Array.isArray(instr.catchAll)) patchVoidReturns(instr.catchAll, depth + 1);
                  if (Array.isArray(instr.catches)) {
                    for (const c of instr.catches) {
                      if (Array.isArray(c.body)) patchVoidReturns(c.body, depth + 1);
                    }
                  }
                }
              }
              patchVoidReturns(blockBody, 0);

              // Emit: block { <body> }
              fctx.body.push({
                op: "block",
                blockType: { kind: "empty" },
                body: blockBody,
              });
              return VOID_RESULT;
            }
          } finally {
            leaveIifeBindingScope();
          }
        }
      } // end else (non-generator IIFE)
    }
  }

  // Handle standalone super() calls (constructor chaining) — top-level super(...)
  // statements are handled inline by compileClassBodies, which short-circuits the
  // ExpressionStatement before it reaches this path. When `super(...)` appears
  // nested inside control flow (try/catch, if/loop) inside the user constructor,
  // the inline handler doesn't see it. To preserve §13.3.7.1 step 4 (ArgumentList­
  // Evaluation + ReturnIfAbrupt) we evaluate every argument left-to-right here
  // for side effects, dropping the resulting value. Parent-field assignment
  // remains best-effort: nested-super field forwarding is handled by the
  // inline path; this fallback ensures throws from arg expressions propagate
  // to the user's try/catch (#1551).
  if (expr.expression.kind === ts.SyntaxKind.SuperKeyword) {
    for (const arg of expr.arguments) {
      const inner = ts.isSpreadElement(arg) ? arg.expression : arg;
      const argResult = compileExpression(ctx, fctx, inner);
      if (argResult !== null) {
        fctx.body.push({ op: "drop" });
      }
    }
    // (#1551) Return VOID_RESULT, NOT null. A `null` return signals "no usable
    // value" to the #1919 speculative wrapper in compileExpressionBody, which
    // then calls rollbackSpeculative — TRUNCATING the argument-evaluation
    // instructions we just emitted (including a throwing super-arg call) and
    // replacing them with a default constant. That rollback is exactly why the
    // super-arg throw escaped the enclosing try-region: the exception-raising
    // call was deleted before it could run, so the user's `catch` never fired
    // and execution fell through past `super(...)`. VOID_RESULT means "compiled,
    // void result, KEEP the emitted instructions" — the wrapper preserves the
    // arg evaluation so ArgumentListEvaluation's abrupt completion propagates.
    return VOID_RESULT;
  }

  // Handle IIFE: (function(...) { ... })(...) — immediately invoked function expression
  {
    const iifeResult = compileIIFE(ctx, fctx, expr);
    if (iifeResult !== undefined) return iifeResult;
  }

  // Handle comma-operator indirect calls: (0, foo)() or (expr, fn)()
  // Unwrap parenthesized comma expression, evaluate left for side effects, call right.
  {
    let callee: ts.Expression = expr.expression;
    while (ts.isParenthesizedExpression(callee)) {
      callee = callee.expression;
    }
    if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      // Evaluate left side for side effects and drop
      const leftType = compileExpression(ctx, fctx, callee.left);
      if (leftType) {
        fctx.body.push({ op: "drop" });
      }
      // Create a synthetic call with the right side as callee
      const syntheticCall = ts.factory.createCallExpression(
        callee.right as ts.Expression as ts.LeftHandSideExpression,
        expr.typeArguments,
        expr.arguments,
      );
      // Preserve parent for type checker resolution
      ts.setTextRange(syntheticCall, expr);
      (syntheticCall as any).parent = expr.parent;
      return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
    }
  }

  // Handle ElementAccessExpression calls: obj['method']() or obj[0]() or obj[constKey]()
  // Convert to equivalent property access method call when the index resolves to a static key.
  if (ts.isElementAccessExpression(expr.expression)) {
    const elemAccess = expr.expression;
    const argExpr = elemAccess.argumentExpression;
    // Resolve the key to a static string: string literals, numeric literals, const variables, etc.
    let resolvedMethodName: string | undefined;
    if (argExpr) {
      if (ts.isStringLiteral(argExpr)) {
        resolvedMethodName = argExpr.text;
      } else if (ts.isNumericLiteral(argExpr)) {
        resolvedMethodName = String(Number(argExpr.text));
      } else {
        resolvedMethodName = resolveComputedKeyExpression(ctx, argExpr);
      }
    }

    // Handle super['method']() calls — resolve to ParentClass_method with this as first arg
    if (elemAccess.expression.kind === ts.SyntaxKind.SuperKeyword && resolvedMethodName !== undefined) {
      return compileSuperElementMethodCall(ctx, fctx, expr, resolvedMethodName);
    }

    if (resolvedMethodName !== undefined) {
      const methodName = resolvedMethodName;
      const receiverType = ctx.checker.getTypeAtLocation(elemAccess.expression);

      // Iterator protocol dispatch (#1016b): obj[Symbol.iterator]() and
      // obj[Symbol.asyncIterator]() must drive the iterator protocol via the
      // host imports __iterator / __async_iterator. Without this, calls like
      // `array[Symbol.iterator]()` fall through to the null-pushing fallback
      // because no class method `__@@iterator` is registered for built-in JS
      // iterables (TypedArray, Map, Set, RegExpStringIterator, etc.).
      // The runtime __iterator handles all dispatch paths:
      //   - direct Symbol.iterator on JS objects
      //   - sidecar @@iterator on WasmGC structs
      //   - WasmGC closure via __call_fn_0
      //   - __call_@@iterator export for user-defined iterable classes
      //   - __vec_len/__vec_get fallback for vec structs (arrays)
      if (methodName === "@@iterator" || methodName === "@@asyncIterator") {
        // (#3013) Standalone/WASI: `<array>[Symbol.iterator]()` is, per
        // §23.1.3.40, the SAME operation as `Array.prototype.values` —
        // `Array.prototype[Symbol.iterator] === Array.prototype.values`. Route an
        // array receiver to the native `.values()` lowering so it produces the
        // identical `$__IterRec` value host-free, instead of leaking the
        // `env::__iterator` host import (the sole leak of the array-iterator
        // conformance cluster). The `.values()`/`.keys()`/`.entries()` forms are
        // already native; this closes the `[Symbol.iterator]()` gap. Host/gc mode
        // keeps the existing `__iterator` bridge (byte-inert). Async iterator and
        // non-array receivers fall through unchanged.
        if (methodName === "@@iterator" && (ctx.standalone || ctx.wasi) && resolveArrayInfo(ctx, receiverType)) {
          const nativeResult = compileArrayMethodCall(ctx, fctx, elemAccess, expr, receiverType, "values");
          if (nativeResult !== undefined && nativeResult !== null) return nativeResult as ValType;
          // Fall through to the host bridge if the native path declined.
        }
        const importName = methodName === "@@iterator" ? "__iterator" : "__async_iterator";
        // `%String.prototype%` is the empty String value (§22.1.3). Its
        // general first-class representation is a `$NativeProto` metadata
        // object, which the iterator provider cannot coerce to text. Preserve
        // the intrinsic call semantics by feeding the provider the equivalent
        // empty native string. This exact pristine-realm shape is used by
        // Deno to discover `%StringIteratorPrototype%` during bootstrap.
        const recvType =
          methodName === "@@iterator" &&
          (ctx.standalone || ctx.wasi) &&
          isPristineStringPrototypeExpression(fctx, elemAccess.expression)
            ? compileStringLiteral(ctx, fctx, "")
            : compileExpression(ctx, fctx, elemAccess.expression);
        if (recvType) {
          if (recvType.kind === "ref" || recvType.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          } else if (recvType.kind === "f64") {
            const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
            if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
          } else if (recvType.kind === "i32") {
            fctx.body.push({ op: "f64.convert_i32_s" });
            const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
            if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
          // externref / funcref / other: assume already iterable-shaped
        }
        // Iterator methods take no arguments; evaluate any extras for side effects only.
        for (const arg of expr.arguments) {
          const argType = compileExpression(ctx, fctx, arg);
          if (argType) fctx.body.push({ op: "drop" });
        }
        const iterIdx = ensureLateImport(ctx, importName, [{ kind: "externref" }], [{ kind: "externref" }]);
        flushLateImportShifts(ctx, fctx);
        if (iterIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: iterIdx });
        } else {
          fctx.body.push({ op: "ref.null.extern" });
        }
        return { kind: "externref" };
      }

      // (#1439) RegExp.prototype[@@replace/@@match/@@search/@@split/@@matchAll]
      // protocol dispatch. `regex[Symbol.replace](str, replaceValue)` is the
      // ECMAScript §22.2.5 mechanism that `String.prototype.replace` and
      // friends delegate to. The receiver is an externref (RegExp lives in
      // the host), so a direct call_ref on the property access would deref
      // a null pointer — there's no Wasm function bound to the symbol key
      // on a host object. Route to `__regex_symbol_call(regex, id, arg0, arg1)`
      // which performs `regex[Symbol.X](arg0[, arg1])` in JS land.
      {
        const REGEX_SYMBOL_METHODS: Record<string, number> = {
          "@@match": 7,
          "@@replace": 8,
          "@@search": 9,
          "@@split": 10,
          "@@matchAll": 15,
        };
        const protocolId = REGEX_SYMBOL_METHODS[methodName];
        if (protocolId !== undefined) {
          // Receiver is RegExp, or its static type is unresolvable (`any` /
          // `unknown`) so we cannot prove it is *not* a RegExp. The latter
          // covers `(re as any)[Symbol.split](str)`, a RegExp stored in an
          // `any`/parameter slot, and `RegExp.prototype[Symbol.split]`
          // accessed off a base that loses its type (#1331). In all these
          // cases the host helper `__regex_symbol_call` does a fully dynamic
          // `recv[Symbol.X](args)` lookup, so routing here is correct for any
          // object that implements the well-known symbol method — not just
          // RegExp. We must NOT catch receivers that resolve to a user-defined
          // wasm class (handled by the ClassName_method dispatch below) or the
          // `@@iterator`/`@@asyncIterator` cases (already handled above).
          const recvSym = receiverType.getSymbol()?.name;
          // (#1330) When a regex flows through an `any`/unresolved variable —
          // the common test262 shape `re[Symbol.search](s)` with `re: any` —
          // recvSym is undefined and the narrow `=== "RegExp"` guard rejects
          // it, so dispatch falls through to generic method lookup which can't
          // resolve the "@@search" string key → returns 0/undefined. Route
          // these through `__regex_symbol_call` too: the host import validates
          // the receiver at runtime (throws the correct TypeError if it isn't a
          // RegExp), so widening here is spec-safe. Stay narrow for receivers
          // that resolve to a *user* class/struct, which may define their own
          // @@match/@@replace/etc.
          const isRegExpRecv = recvSym === "RegExp" || recvSym === "RegExpConstructor";
          let resolvedClassName = receiverType.getSymbol()?.name;
          if (resolvedClassName && !ctx.classSet.has(resolvedClassName)) {
            resolvedClassName = ctx.classExprNameMap.get(resolvedClassName) ?? resolvedClassName;
          }
          const recvIsUserClass = !!resolvedClassName && ctx.classSet.has(resolvedClassName);
          const recvIsUnresolved = (receiverType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0;
          if ((isRegExpRecv || recvIsUnresolved) && !recvIsUserClass) {
            // #3567 — WASI shares the fail-loud function-replacer contract
            // without opting its supported symbol-method forms into the
            // standalone native engine. A string replacer returns undefined
            // here and preserves the existing WASI dispatch.
            if (ctx.wasi && methodName === "@@replace" && expr.arguments.length === 2) {
              const wasiReplaceRefusal = tryCompileStandaloneRegExpSymbolCall(
                ctx,
                fctx,
                expr,
                elemAccess.expression,
                methodName,
              );
              if (wasiReplaceRefusal !== undefined) return wasiReplaceRefusal;
            }
            if (usesNativeRegExpProvider(ctx)) {
              // (#2161) Route the well-known-symbol protocol READ forms
              // (`re[Symbol.match/matchAll/search](str)`) to the native engine
              // for static / backend-created RegExp receivers — the
              // operand-swapped dual of the String.prototype.* native path.
              // Returns undefined for forms not yet wired (dynamic receivers,
              // @@replace/@@split, string-coercion args), which fall through to
              // the refusal below.
              const symResult = tryCompileStandaloneRegExpSymbolCall(
                ctx,
                fctx,
                expr,
                elemAccess.expression,
                methodName,
              );
              if (symResult !== undefined) return symResult;
              reportError(
                ctx,
                expr,
                `Codegen error: standalone RegExp literal-substring backend does not support ` +
                  `${methodName} symbol protocol calls (#682/#1474). Use RegExp.prototype.test ` +
                  `with a plain static pattern and no flags, or recompile without --target standalone.`,
              );
              return null;
            }

            // Push receiver as externref (already a RegExp host object)
            const recvType = compileExpression(ctx, fctx, elemAccess.expression);
            if (recvType) {
              if (recvType.kind === "ref" || recvType.kind === "ref_null") {
                fctx.body.push({ op: "extern.convert_any" });
              } else if (recvType.kind === "f64") {
                const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
              } else if (recvType.kind === "i32") {
                fctx.body.push({ op: "f64.convert_i32_s" });
                const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
              }
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            // symbol ID
            fctx.body.push({ op: "i32.const", value: protocolId });
            // arg0 (the string operand) — coerce to externref
            if (expr.arguments.length > 0) {
              const a0 = compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "externref" });
              if (a0) {
                if (a0.kind === "ref" || a0.kind === "ref_null") {
                  fctx.body.push({ op: "extern.convert_any" });
                } else if (a0.kind === "f64") {
                  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                  if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else if (a0.kind === "i32") {
                  fctx.body.push({ op: "f64.convert_i32_s" });
                  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                  if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
                }
              } else {
                fctx.body.push({ op: "ref.null.extern" });
              }
            } else {
              // Spec: ToString(undefined) → "undefined" — but at the host
              // boundary an `undefined` externref roundtrip is fine because
              // the host method does its own ToString coercion.
              fctx.body.push({ op: "ref.null.extern" });
            }
            // arg1 (replaceValue / limit) — coerce to externref, default null
            if (expr.arguments.length > 1) {
              const a1 = compileExpression(ctx, fctx, expr.arguments[1]!, { kind: "externref" });
              if (a1) {
                if (a1.kind === "ref" || a1.kind === "ref_null") {
                  fctx.body.push({ op: "extern.convert_any" });
                } else if (a1.kind === "f64") {
                  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                  if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
                } else if (a1.kind === "i32") {
                  fctx.body.push({ op: "f64.convert_i32_s" });
                  const boxIdx = ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
                  if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
                }
              } else {
                fctx.body.push({ op: "ref.null.extern" });
              }
            } else {
              fctx.body.push({ op: "ref.null.extern" });
            }
            // Drop any extra arguments (evaluate for side effects)
            for (let i = 2; i < expr.arguments.length; i++) {
              const extra = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extra !== null) fctx.body.push({ op: "drop" });
            }
            const callIdx = ensureLateImport(
              ctx,
              "__regex_symbol_call",
              [{ kind: "externref" }, { kind: "i32" }, { kind: "externref" }, { kind: "externref" }],
              [{ kind: "externref" }],
            );
            flushLateImportShifts(ctx, fctx);
            if (callIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: callIdx });
            } else {
              // Shouldn't happen, but be defensive
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "ref.null.extern" });
            }
            return { kind: "externref" };
          }
        }
      }

      // Try class instance method: ClassName_methodName
      let receiverClassName = receiverType.getSymbol()?.name;
      if (receiverClassName && !ctx.classSet.has(receiverClassName)) {
        receiverClassName = ctx.classExprNameMap.get(receiverClassName) ?? receiverClassName;
      }
      if (receiverClassName && ctx.classSet.has(receiverClassName)) {
        const fullName = `${receiverClassName}_${methodName}`;
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          // Push self (the receiver) as first argument
          compileExpression(ctx, fctx, elemAccess.expression);
          // Push remaining arguments with type hints
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const eaMethodParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
          for (let i = 0; i < expr.arguments.length; i++) {
            if (i < eaMethodParamCount) {
              compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]); // +1 to skip self
            } else {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
          // Pad missing arguments with defaults (skip self param at index 0)
          if (paramTypes) {
            for (let i = Math.min(expr.arguments.length, eaMethodParamCount) + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          fctx.body.push({ op: "call", funcIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
            return brandExternMethodResult(
              ctx,
              retType,
              getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType),
            );
          }
          return VOID_RESULT;
        }
      }

      // Try struct method: structName_methodName
      const structTypeName = resolveStructName(ctx, receiverType);
      if (structTypeName) {
        const fullName = `${structTypeName}_${methodName}`;
        const funcIdx = ctx.funcMap.get(fullName);
        if (funcIdx !== undefined) {
          const recvType = compileExpression(ctx, fctx, elemAccess.expression);
          // Check if receiver went through emitGuardedRefCast — null may mean
          // "wrong struct type" rather than genuinely null (#789)
          const eaReceiverWasCast = (fctx as any).__lastGuardedCastBackup !== undefined;
          // Null-guard: if receiver is ref_null, check for null before calling method
          if (recvType && recvType.kind === "ref_null") {
            const sig = ctx.checker.getResolvedSignature(expr);
            let callReturnType: ValType | typeof VOID_RESULT = VOID_RESULT;
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (!isEffectivelyVoidReturn(ctx, retType, fullName))
                callReturnType = brandExternMethodResult(
                  ctx,
                  retType,
                  getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType),
                );
            }
            const tmp = allocLocal(fctx, `__ng_ea_recv_${fctx.locals.length}`, recvType);
            fctx.body.push({ op: "local.tee", index: tmp });
            fctx.body.push({ op: "ref.is_null" });

            const savedBody = pushBody(fctx);
            fctx.body.push({ op: "local.get", index: tmp });
            fctx.body.push({ op: "ref.as_non_null" });
            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            const eaNgParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
            for (let i = 0; i < expr.arguments.length; i++) {
              if (i < eaNgParamCount) {
                compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
              } else {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
            if (paramTypes) {
              for (let i = Math.min(expr.arguments.length, eaNgParamCount) + 1; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!, ctx);
              }
            }
            fctx.body.push({ op: "call", funcIdx });
            const elseInstrs = fctx.body;
            fctx.body = savedBody;

            if (callReturnType === VOID_RESULT) {
              // If null after cast, skip (wrong type); if genuinely null, throw TypeError (#789)
              fctx.body.push({
                op: "if",
                blockType: { kind: "empty" },
                then: eaReceiverWasCast ? [] : typeErrorThrowInstrs(ctx),
                else: elseInstrs,
              });
              return VOID_RESULT;
            } else {
              const resultType: ValType =
                callReturnType.kind === "ref"
                  ? {
                      kind: "ref_null",
                      typeIdx: (callReturnType as any).typeIdx,
                    }
                  : callReturnType;
              // If null after cast, default (wrong type); if genuinely null, throw TypeError (#789)
              fctx.body.push({
                op: "if",
                blockType: { kind: "val" as const, type: resultType },
                then: eaReceiverWasCast ? defaultValueInstrs(resultType) : typeErrorThrowInstrs(ctx),
                else: elseInstrs,
              });
              return resultType;
            }
          }
          // Non-nullable receiver
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const eaNnParamCount = paramTypes ? paramTypes.length - 1 : expr.arguments.length;
          for (let i = 0; i < expr.arguments.length; i++) {
            if (i < eaNnParamCount) {
              compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i + 1]);
            } else {
              const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
              if (extraType !== null) {
                fctx.body.push({ op: "drop" });
              }
            }
          }
          if (paramTypes) {
            for (let i = Math.min(expr.arguments.length, eaNnParamCount) + 1; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }
          fctx.body.push({ op: "call", funcIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
            return brandExternMethodResult(
              ctx,
              retType,
              getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType),
            );
          }
          return VOID_RESULT;
        }
      }

      // Try static method: ClassName.staticMethod via element access
      if (ts.isIdentifier(elemAccess.expression) && ctx.classSet.has(elemAccess.expression.text)) {
        const clsName = ctx.classExprNameMap.get(elemAccess.expression.text) ?? elemAccess.expression.text;
        const fullName = `${clsName}_${methodName}`;
        if (ctx.staticMethodSet.has(fullName)) {
          const funcIdx = ctx.funcMap.get(classMemberFuncKey(ctx, fullName, "static"));
          if (funcIdx !== undefined) {
            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            const eaStaticParamCount = paramTypes ? paramTypes.length : expr.arguments.length;
            for (let i = 0; i < expr.arguments.length; i++) {
              if (i < eaStaticParamCount) {
                compileExpression(ctx, fctx, expr.arguments[i]!, paramTypes?.[i]);
              } else {
                const extraType = compileExpression(ctx, fctx, expr.arguments[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
            if (paramTypes) {
              for (let i = expr.arguments.length; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!, ctx);
              }
            }
            fctx.body.push({ op: "call", funcIdx });

            const sig = ctx.checker.getResolvedSignature(expr);
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
              if (wasmFuncReturnsVoid(ctx, funcIdx)) return VOID_RESULT;
              return brandExternMethodResult(
                ctx,
                retType,
                getWasmFuncReturnType(ctx, funcIdx) ?? resolveWasmType(ctx, retType),
              );
            }
            return VOID_RESULT;
          }
        }
      }

      // Try string method: string_methodName
      if (isStringType(receiverType)) {
        // (#3027) Native-strings mode (standalone/wasi `--nativeStrings`)
        // never registers the host `string_<method>` import looked up right
        // below — a computed-key string method call (`"str"["charAt"](i)`,
        // `new String(x)["slice"](i)`) always found `funcIdx === undefined`
        // and fell through every later branch to the generic dynamic-call
        // fallback, which produces a null/non-callable value for a native
        // string or wrapper receiver (there is no host `$Object` to ask) —
        // manifesting downstream as "Cannot access property on null or
        // undefined". The dot form (`"str".charAt(i)`) already dispatches
        // correctly through the native `__str_*` engine (incl. the String-
        // wrapper `__to_primitive` unwrap) earlier in this same function;
        // recompile this call as the equivalent dot form (same receiver, same
        // method, same arguments) so it takes that exact path instead of
        // duplicating the logic here.
        if (ctx.nativeStrings && ctx.nativeStrTypeIdx >= 0) {
          const syntheticProp = ts.factory.createPropertyAccessExpression(elemAccess.expression, methodName);
          ts.setTextRange(syntheticProp, elemAccess);
          (syntheticProp as unknown as { parent: ts.Node }).parent = expr;
          const syntheticCall = ts.factory.createCallExpression(syntheticProp, expr.typeArguments, expr.arguments);
          ts.setTextRange(syntheticCall, expr);
          (syntheticCall as unknown as { parent: ts.Node }).parent = expr.parent;
          return compileCallExpression(ctx, fctx, syntheticCall as ts.CallExpression);
        }
        const importName = `string_${methodName}`;
        const funcIdx = ctx.funcMap.get(importName);
        if (funcIdx !== undefined) {
          compileExpression(ctx, fctx, elemAccess.expression);
          const paramTypes = getFuncParamTypes(ctx, funcIdx);
          const args = expr.arguments;
          for (let ai = 0; ai < args.length; ai++) {
            const argResult = compileExpression(ctx, fctx, args[ai]!);
            const expectedType = paramTypes?.[ai + 1];
            if (argResult && expectedType && argResult.kind !== expectedType.kind) {
              coerceType(ctx, fctx, argResult, expectedType);
            }
          }
          if (paramTypes && args.length + 1 < paramTypes.length) {
            for (let pi = args.length + 1; pi < paramTypes.length; pi++) {
              const pt = paramTypes[pi]!;
              if (pt.kind === "externref") fctx.body.push({ op: "ref.null.extern" });
              else if (pt.kind === "f64") fctx.body.push({ op: "f64.const", value: 0 });
              else if (pt.kind === "i32") fctx.body.push({ op: "i32.const", value: 0 });
            }
          }
          fctx.body.push({ op: "call", funcIdx });
          const returnsBool = methodName === "includes" || methodName === "startsWith" || methodName === "endsWith";
          return returnsBool
            ? { kind: "i32" }
            : methodName === "indexOf" || methodName === "lastIndexOf" || methodName === "search"
              ? { kind: "f64" }
              : { kind: "externref" };
        }
      }

      // Try number method: number.toString(), number.toFixed(), toPrecision(), toExponential()
      if (
        isNumberType(receiverType) &&
        (methodName === "toString" ||
          methodName === "toFixed" ||
          methodName === "toPrecision" ||
          methodName === "toExponential")
      ) {
        // RangeError validation for toString(radix) — radix must be integer 2-36
        // (#2029 family C) Hoisted so the call below can PASS the radix — the
        // old code validated it, then called the 1-arg `number_toString`
        // (radix silently dropped → `5["toString"](2)` returned "5").
        let radixLocal: number | undefined;
        if (methodName === "toString" && expr.arguments.length > 0) {
          compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "f64" });
          // Floor the radix (ToInteger semantics)
          fctx.body.push({ op: "f64.floor" });
          radixLocal = allocLocal(fctx, `__radix_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: radixLocal });
          fctx.body.push({ op: "f64.const", value: 2 });
          fctx.body.push({ op: "f64.lt" });
          fctx.body.push({ op: "local.get", index: radixLocal });
          fctx.body.push({ op: "f64.const", value: 36 });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
          // Check radix is NaN (NaN != NaN)
          fctx.body.push({ op: "local.get", index: radixLocal });
          fctx.body.push({ op: "local.get", index: radixLocal });
          fctx.body.push({ op: "f64.ne" });
          fctx.body.push({ op: "i32.or" });
          {
            const rangeErrMsg = "RangeError: toString() radix must be between 2 and 36";
            // (#3477) Throw a real RangeError INSTANCE via buildThrowJsErrorInstrs
            // so the authentic-harness `assert.throws(RangeError, …)` /
            // `e instanceof RangeError` guard passes — matches the dot-access twin
            // (call-receiver-method.ts). Formerly a bare-string throw (only
            // `e === "RangeError: …"`). buildThrowJsErrorInstrs handles the dual
            // -mode message push + tag internally (the #2029 sentinel concern).
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: buildThrowJsErrorInstrs(ctx, "RangeError", rangeErrMsg, { flush: fctx }),
              else: [],
            });
          }
          // radix was consumed by the validation comparisons above (via local.tee),
          // no extra drop needed
        }
        const exprType = compileExpression(ctx, fctx, elemAccess.expression);
        if (exprType && exprType.kind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        }
        if (methodName === "toFixed" && expr.arguments.length > 0) {
          // ToNumber funnel — Symbol args must throw TypeError (#1564).
          coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
          // RangeError: fractionDigits must be 0-100
          const digitsLocal = allocLocal(fctx, `__toFixed_digits_${fctx.locals.length}`, { kind: "f64" });
          fctx.body.push({ op: "local.tee", index: digitsLocal });
          fctx.body.push({ op: "f64.const", value: 0 });
          fctx.body.push({ op: "f64.lt" });
          fctx.body.push({ op: "local.get", index: digitsLocal });
          fctx.body.push({ op: "f64.const", value: 100 });
          fctx.body.push({ op: "f64.gt" });
          fctx.body.push({ op: "i32.or" });
          {
            const rangeErrMsg = "RangeError: toFixed() digits argument must be between 0 and 100";
            // (#3477) Real RangeError INSTANCE via buildThrowJsErrorInstrs — see
            // the toString() radix twin above; matches the dot-access twin so
            // `assert.throws(RangeError, …)` passes.
            fctx.body.push({
              op: "if",
              blockType: { kind: "empty" },
              then: buildThrowJsErrorInstrs(ctx, "RangeError", rangeErrMsg, { flush: fctx }),
              else: [],
            });
          }
          fctx.body.push({ op: "local.get", index: digitsLocal });
        } else if (methodName === "toFixed") {
          fctx.body.push({ op: "f64.const", value: 0 });
        }
        if (methodName === "toPrecision" && expr.arguments.length > 0 && !isStaticUndefinedArg(expr.arguments[0])) {
          // (#3078) explicit `undefined` precision ≡ no arg (§21.1.3.5 step 2) —
          // route to the `toString`-equivalent else branch, not ToInteger→0.
          // ToNumber funnel — Symbol args must throw TypeError (#1564).
          coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
          // (#49) See `number.toPrecision` site above — the precision
          // range check was moved into the runtime helper because per
          // spec §21.1.3.5 step 4, non-finite receivers must return
          // Number::toString(x) BEFORE the range check fires.
        } else if (methodName === "toPrecision") {
          // No argument → same as toString()
          const funcIdx = ctx.funcMap.get("number_toString");
          if (funcIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx });
            return { kind: "externref" };
          }
        }
        if (methodName === "toExponential" && expr.arguments.length > 0 && !isStaticUndefinedArg(expr.arguments[0])) {
          // (#3078) explicit `undefined` fractionDigits ≡ no arg (§21.1.3.3
          // step 2) — route to the NaN-sentinel else branch (variable digits),
          // not ToInteger→0.
          // ToNumber funnel — Symbol args must throw TypeError (#1564).
          coerceNumberMethodArgToF64(ctx, fctx, compileExpression(ctx, fctx, expr.arguments[0]!));
          // (#49) See `number.toExponential` site above — the
          // fractionDigits range check was moved into the runtime
          // helper because per spec §21.1.3.3 step 3, non-finite
          // receivers must return Number::toString(x) BEFORE the
          // range check fires. Removing the codegen pre-check lets
          // `(NaN).toExponential(101)` return "NaN" as the spec
          // requires.
        } else if (methodName === "toExponential") {
          // No argument → pass NaN sentinel
          fctx.body.push({ op: "f64.const", value: NaN });
        }
        const funcName =
          methodName === "toFixed"
            ? "number_toFixed"
            : methodName === "toPrecision"
              ? "number_toPrecision"
              : methodName === "toExponential"
                ? "number_toExponential"
                : radixLocal !== undefined
                  ? "number_toString_radix"
                  : "number_toString";
        const funcIdx = ctx.funcMap.get(funcName);
        if (funcIdx !== undefined) {
          // (#2029 family C) The 2-arg radix helper takes (x, radix) — mirror
          // the dot-access site: receiver is already on the stack, append the
          // validated radix.
          if (funcName === "number_toString_radix" && radixLocal !== undefined) {
            fctx.body.push({ op: "local.get", index: radixLocal });
          }
          fctx.body.push({ op: "call", funcIdx });
          return { kind: "externref" };
        }
      }

      // Try array method calls
      {
        const arrMethodResult = compileArrayMethodCall(ctx, fctx, elemAccess, expr, receiverType, methodName);
        if (arrMethodResult !== undefined) return arrMethodResult;
      }

      // ELEM ACCESS RESOLVED, NO METHOD MATCHED — try callable element type
      // (#1306). Covers `fns[0](args)` and `fns[ConstKey](args)` where
      // `fns` is an array (or other element-access-able value) of callables.
      {
        const cea = compileCallableElementAccessCall(ctx, fctx, expr, elemAccess);
        if (cea !== undefined) return cea;
      }

      // (#3166 S1) Computed-key call on a class-instance FIELD holding a
      // closure: `c[1+1]()` where `[1+1] = () => …` is a class field. TS does
      // NOT track a member named "2" for a computed-name field, so the callee
      // (`c[1+1]`) carries no call signature — `compileCallableElementAccessCall`
      // above bailed — and it is NOT a prototype method (no `ClassName_2` in
      // funcMap). The struct-field READ works (numeric/string keys already
      // canonicalise to field "2"); route the invocation through dynamic
      // closure dispatch. The runtime
      // ref.test guards make this safe for a non-closure field value (the
      // default arm reproduces the historical `ref.null.extern`).
      if (elemAccessReceiverIsUserClass(ctx, elemAccess) && classInstanceHasField(ctx, elemAccess, methodName)) {
        const dyn = tryEmitInlineDynamicCall(ctx, fctx, expr, true);
        if (dyn !== null) return dyn;
      }

      // (#4252) Runtime-key call on a PLAIN OBJECT receiver: `o[k]()` where `k`
      // is a variable that const-folds to a key for which no builtin/class
      // method matched. The element READ is already correct (`var g = o[k]; g()`
      // invokes; `typeof o[k] === 'function'` answers true) — only the
      // INVOCATION was dropped by the fallback below, silently, yielding
      // `undefined` with the callee never entered. Route the same
      // ref.test-guarded dynamic closure dispatch the user-class arm above uses;
      // its default arm reproduces the historical `ref.null.extern`, so a
      // non-callable read value keeps today's behaviour.
      if (elemAccessReceiverIsPlainObject(ctx, elemAccess)) {
        // (#4269) …and give that dispatch a receiver. #4252 made the callee RUN;
        // it still ran with `this` unbound, which is the same silent wrong
        // answer one layer down. See object-literal-method-receiver.ts for why
        // the gate is asked of the receiver's literal here and why an argument
        // that reads `this` refuses the bind outright.
        const dyn = emitPlainObjectDynamicCallWithReceiver(ctx, fctx, expr, elemAccess);
        if (dyn !== null) return dyn;
      }

      const dynamicHostCall = tryEmitDynamicElementHostMethodCall(ctx, fctx, expr, elemAccess);
      if (dynamicHostCall !== undefined) return dynamicHostCall;

      // (#4482) `o["m"](…)` where the module stored a closure in `o.m` — the
      // bracket twin of the dot-access shape `compileCallDispatchTail` already
      // narrows. Placed immediately before the local graceful fallback below,
      // which is the point where "no arm recognised this call" becomes the
      // silent VALUE `undefined`; the arm is admission-tested on the same
      // source scan, so a module that never writes `X.m = …` /
      // `Object.defineProperty(X, "m", …)` reaches the fallback exactly as
      // before. Measured: `RegExp/prototype/{exec,test}/…_A2_T6`, where the
      // transferred intrinsic must run its brand check and throw `TypeError`.
      {
        const storedElem = tryEmitStoredMemberClosureCall(ctx, fctx, expr);
        if (storedElem !== undefined) return storedElem;
      }

      {
        const recvType = compileExpression(ctx, fctx, elemAccess.expression);
        if (recvType) {
          fctx.body.push({ op: "drop" });
        }
        for (const arg of expr.arguments) {
          const argType = compileExpression(ctx, fctx, arg);
          if (argType) {
            fctx.body.push({ op: "drop" });
          }
        }
        fctx.body.push({ op: "ref.null.extern" });
        return { kind: "externref" };
      }
    }

    // Try the callable element type before the unresolved-key fallback (#1306).
    {
      const cea = compileCallableElementAccessCall(ctx, fctx, expr, elemAccess);
      if (cea !== undefined) return cea;
    }

    // (#3166 S1) Runtime-key call on a class-instance field holding a closure:
    // `c[String(1+1)]()` — the key is not const-foldable so no static field
    // name is known, but the dynamic element READ already canonicalises the key
    // (ToPropertyKey) and finds struct field "2". Only the INVOCATION was
    // dropped. Route the read + ref.test-guarded dynamic closure dispatch, gated
    // on a user-class-instance receiver so primitive/array receivers keep their
    // historical behaviour. A non-closure read value hits the safe default arm.
    if (elemAccessReceiverIsUserClass(ctx, elemAccess)) {
      const dyn = tryEmitInlineDynamicCall(ctx, fctx, expr, true);
      if (dyn !== null) return dyn;
    }
    // (#4252) The unresolved-key twin of the plain-object arm above:
    // `traps[trap]()` where `trap` is a parameter, so no static key exists. This
    // is the shape the test262 harness self-tests `proxytrapshelper-{default,
    // overrides}.js` exercise — `allowProxyTraps` hands back an object literal
    // of 14 functions and the test calls `traps[trap]()` for each. The dynamic
    // element read canonicalises the key at runtime and finds the right slot;
    // only the call was dropped, which turned a throwing trap into a silent
    // no-op and reported the file as a (vacuous) pass.
    if (elemAccessReceiverIsPlainObject(ctx, elemAccess)) {
      // (#4269) With a receiver — see the resolved-key twin above.
      const dyn = emitPlainObjectDynamicCallWithReceiver(ctx, fctx, expr, elemAccess);
      if (dyn !== null) return dyn;
    }

    const dynamicHostCall = tryEmitDynamicElementHostMethodCall(ctx, fctx, expr, elemAccess);
    if (dynamicHostCall !== undefined) return dynamicHostCall;

    {
      const recvType = compileExpression(ctx, fctx, elemAccess.expression);
      if (recvType) {
        fctx.body.push({ op: "drop" });
      }
      if (argExpr) {
        const keyType = compileExpression(ctx, fctx, argExpr);
        if (keyType) {
          fctx.body.push({ op: "drop" });
        }
      }
      for (const arg of expr.arguments) {
        const argType = compileExpression(ctx, fctx, arg);
        if (argType) {
          fctx.body.push({ op: "drop" });
        }
      }
      fctx.body.push({ op: "ref.null.extern" });
      return { kind: "externref" };
    }
  }

  // Handle fn.bind(thisArg, ...partialArgs)(...remainingArgs) — immediate bind+call
  // Transform to fn(...partialArgs, ...remainingArgs), dropping thisArg.
  // (#1337) Also accept the equivalent Function.prototype.bind.call(fn, thisArg, ...) form
  // by reshaping bindCall to the method form before pattern-matching.
  if (ts.isCallExpression(expr.expression)) {
    let bindCall = expr.expression;
    if (
      ts.isPropertyAccessExpression(bindCall.expression) &&
      bindCall.expression.name.text === "call" &&
      ts.isPropertyAccessExpression(bindCall.expression.expression) &&
      bindCall.expression.expression.name.text === "bind" &&
      ts.isPropertyAccessExpression(bindCall.expression.expression.expression) &&
      bindCall.expression.expression.expression.name.text === "prototype" &&
      ts.isIdentifier(bindCall.expression.expression.expression.expression) &&
      bindCall.expression.expression.expression.expression.text === "Function" &&
      bindCall.arguments.length >= 1
    ) {
      const fnExpr = bindCall.arguments[0]!;
      const reshapedArgs = bindCall.arguments.slice(1);
      const reshapedProp = ts.factory.createPropertyAccessExpression(fnExpr as ts.LeftHandSideExpression, "bind");
      ts.setTextRange(reshapedProp, bindCall.expression);
      const reshapedInner = ts.factory.createCallExpression(reshapedProp, undefined, reshapedArgs);
      ts.setTextRange(reshapedInner, bindCall);
      (reshapedInner as any).parent = expr;
      bindCall = reshapedInner;
    }
    if (ts.isPropertyAccessExpression(bindCall.expression) && bindCall.expression.name.text === "bind") {
      const bindTarget = bindCall.expression.expression;

      // Case: identifier.bind(thisArg, ...partialArgs)(...args)
      if (ts.isIdentifier(bindTarget)) {
        const funcName = bindTarget.text;
        const closureInfo = ctx.closureMap.get(funcName);
        const funcIdx = ctx.funcMap.get(funcName);

        // (#4203) Route `f.bind(t, …)(…)` onto the receiver-correct `.call`
        // trampoline instead of the drop-thisArg lowering below (see
        // named-this-call.ts) — the reshape #3983 did for `.apply`.
        if (!closureInfo && funcIdx !== undefined) {
          const asCall = tryReshapeBindToNamedThisCall(ctx, fctx, expr, bindCall, bindTarget, funcIdx);
          if (asCall !== undefined) return compileCallExpression(ctx, fctx, asCall);
        }

        if (closureInfo || funcIdx !== undefined) {
          // Evaluate and drop thisArg (first bind argument) for side effects
          if (bindCall.arguments.length > 0) {
            const thisType = compileExpression(ctx, fctx, bindCall.arguments[0]!);
            if (thisType) {
              fctx.body.push({ op: "drop" });
            }
          }

          // Collect all effective arguments: partial args from bind + remaining args from outer call
          const partialArgs = bindCall.arguments.length > 1 ? Array.from(bindCall.arguments).slice(1) : [];
          const allArgs = [...partialArgs, ...Array.from(expr.arguments)];

          if (closureInfo) {
            const syntheticCall = ts.factory.createCallExpression(
              bindTarget,
              undefined,
              allArgs as unknown as readonly ts.Expression[],
            );
            (syntheticCall as any).parent = expr.parent;
            return compileClosureCall(ctx, fctx, syntheticCall as ts.CallExpression, funcName, closureInfo);
          }

          // Regular function call
          const paramTypes = getFuncParamTypes(ctx, funcIdx!);
          for (let i = 0; i < allArgs.length; i++) {
            compileExpression(ctx, fctx, allArgs[i]!, paramTypes?.[i]);
          }

          // Supply defaults for missing optional params
          const optInfo = ctx.funcOptionalParams.get(funcName);
          if (optInfo) {
            for (const opt of optInfo) {
              if (opt.index >= allArgs.length) {
                pushParamSentinel(fctx, opt.type, ctx, opt);
              }
            }
          }

          // Pad remaining missing params
          if (paramTypes) {
            const optFilledCount = optInfo ? optInfo.filter((o) => o.index >= allArgs.length).length : 0;
            const totalPushed = allArgs.length + optFilledCount;
            for (let i = totalPushed; i < paramTypes.length; i++) {
              pushDefaultValue(fctx, paramTypes[i]!, ctx);
            }
          }

          const finalFuncIdx = ctx.funcMap.get(funcName) ?? funcIdx!;
          maybeSetArgcForKnownCall(
            ctx,
            fctx,
            funcName,
            allArgs.length,
            getFuncParamTypes(ctx, finalFuncIdx)?.length ?? allArgs.length,
          );
          fctx.body.push({ op: "call", funcIdx: finalFuncIdx });

          const sig = ctx.checker.getResolvedSignature(expr);
          if (sig) {
            const retType = ctx.checker.getReturnTypeOfSignature(sig);
            if (isEffectivelyVoidReturn(ctx, retType, funcName)) return VOID_RESULT;
            if (wasmFuncReturnsVoid(ctx, finalFuncIdx)) return VOID_RESULT;
            return brandExternMethodResult(
              ctx,
              retType,
              getWasmFuncReturnType(ctx, finalFuncIdx) ?? resolveWasmType(ctx, retType),
            );
          }
          return getWasmFuncReturnType(ctx, finalFuncIdx) ?? { kind: "f64" };
        }
      }

      // Case: obj.method.bind(thisArg)(...args) — method call with different receiver
      if (ts.isPropertyAccessExpression(bindTarget)) {
        const methodName = bindTarget.name.text;
        const objExpr = bindTarget.expression;
        const objType = ctx.checker.getTypeAtLocation(objExpr);

        let className = objType.getSymbol()?.name;
        if (className && !ctx.classSet.has(className)) {
          className = ctx.classExprNameMap.get(className) ?? className;
        }
        if (!className || !ctx.classSet.has(className)) {
          className = resolveStructName(ctx, objType) ?? undefined;
        }

        if (className && (ctx.classSet.has(className) || ctx.funcMap.has(`${className}_${methodName}`))) {
          const fullName = `${className}_${methodName}`;
          const funcIdx = ctx.funcMap.get(fullName);
          if (funcIdx !== undefined && bindCall.arguments.length > 0) {
            // First bind argument is the thisArg (receiver)
            compileExpression(ctx, fctx, bindCall.arguments[0]!);

            // Remaining bind args + outer call args
            const partialArgs = bindCall.arguments.length > 1 ? Array.from(bindCall.arguments).slice(1) : [];
            const allArgs = [...partialArgs, ...Array.from(expr.arguments)];

            const paramTypes = getFuncParamTypes(ctx, funcIdx);
            // User-visible param count excludes self (param 0)
            const bindParamCount = paramTypes ? paramTypes.length - 1 : allArgs.length;
            for (let i = 0; i < allArgs.length; i++) {
              if (i < bindParamCount) {
                compileExpression(ctx, fctx, allArgs[i]!, paramTypes?.[i + 1]);
              } else {
                // Extra argument beyond method's parameter count — evaluate for
                // side effects (JS semantics) and discard the result
                const extraType = compileExpression(ctx, fctx, allArgs[i]!);
                if (extraType !== null) {
                  fctx.body.push({ op: "drop" });
                }
              }
            }
            // Pad missing arguments with defaults (skip self at index 0)
            if (paramTypes) {
              for (let i = allArgs.length + 1; i < paramTypes.length; i++) {
                pushDefaultValue(fctx, paramTypes[i]!, ctx);
              }
            }

            const finalCallIdx = ctx.funcMap.get(fullName) ?? funcIdx;
            fctx.body.push({ op: "call", funcIdx: finalCallIdx });

            const sig = ctx.checker.getResolvedSignature(expr);
            if (sig) {
              const retType = ctx.checker.getReturnTypeOfSignature(sig);
              if (isEffectivelyVoidReturn(ctx, retType, fullName)) return VOID_RESULT;
              if (wasmFuncReturnsVoid(ctx, finalCallIdx)) return VOID_RESULT;
              return brandExternMethodResult(
                ctx,
                retType,
                getWasmFuncReturnType(ctx, finalCallIdx) ?? resolveWasmType(ctx, retType),
              );
            }
            return VOID_RESULT;
          }
        }
      }

      // A callable stored in an object field (for example `f.af`) has no
      // statically registered `Class_method` body for the direct optimization
      // above. In JS-host mode `.bind()` therefore produces a real host bound
      // function, not a Wasm closure struct. Invoke that externref through the
      // host callable seam instead of letting the generic call-of-call path
      // ref.test it as a closure and dereference the resulting null.
      if (!ctx.standalone && !noJsHost(ctx) && ts.isPropertyAccessExpression(bindCall.expression)) {
        const boundType = compileFunctionBind(ctx, fctx, bindCall, bindCall.expression);
        if (boundType !== undefined) {
          const called = emitBoundFunctionCall(ctx, fctx, expr, true);
          if (called !== null) return called;
        }
      }
    }
  }

  // Handle CallExpression as callee: fn()(), makeAdder(10)(32), etc.
  // The inner call returns a closure struct (possibly coerced to externref),
  // and we need to call the returned closure with the outer arguments.
  if (ts.isCallExpression(expr.expression)) {
    // Get the TS type of the inner call result — should be a callable type
    const innerResultTsType = ctx.checker.getTypeAtLocation(expr.expression);
    let callSigs = innerResultTsType.getCallSignatures?.();
    if (!callSigs || callSigs.length === 0) {
      // (#1298) Strip nullable members for callees like `Map<K, Fn>.get(...)`
      // whose return type is `Fn | undefined`. Storage is externref either way.
      const nonNull = ctx.checker.getNonNullableType(innerResultTsType);
      callSigs = nonNull.getCallSignatures?.();
    }

    if (callSigs && callSigs.length > 0) {
      const sig = callSigs[0]!;

      // Find matching closure info by comparing param types and return type
      // against all registered closure types. (#4394) Exact-first (typeIdx-
      // aware) — the old kind-only scan picked whichever same-arity closure
      // registered first; a wrong ref-result typeIdx makes the guarded funcref
      // cast below null → call_ref trap (standalone deepEqual-* family).
      // (#4491) Drop the checker's synthetic `arguments`-derived rest symbol.
      const runtimeSigParams = runtimeSignatureParameters(sig);
      const sigParamCount = runtimeSigParams.length;
      const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
      const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
      const sigParamWasmTypes: ValType[] = [];
      for (let i = 0; i < sigParamCount; i++) {
        const paramType = ctx.checker.getTypeOfSymbol(runtimeSigParams[i]!);
        sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
      }

      const sigMatched = matchClosureInfoBySignature(ctx, sigParamWasmTypes, sigRetWasm, {
        sigHasRest: tsSignatureHasRest(sig),
      });
      const matchedClosureInfo: ClosureInfo | undefined = sigMatched?.info;
      const matchedStructTypeIdx: number | undefined = sigMatched?.structTypeIdx;

      if (matchedClosureInfo && matchedStructTypeIdx !== undefined) {
        // Compile the inner call expression to get the closure on the stack
        const innerResultType = compileExpression(ctx, fctx, expr.expression);
        const selfTypeIdx = getClosureFuncSelfTypeIdx(ctx, matchedClosureInfo.funcTypeIdx) ?? matchedStructTypeIdx;
        const closureRefType: ValType = { kind: "ref_null", typeIdx: selfTypeIdx };

        // Save closure ref to a local so we can extract both args and funcref.
        // Erased shared closures normalize to the canonical root; private/named
        // funcs retain the concrete self encoded in their func type.
        const closureLocal = allocLocal(fctx, `__call_ret_${fctx.locals.length}`, closureRefType);
        if (innerResultType?.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" });
          emitGuardedRefCast(fctx, selfTypeIdx);
        } else if (
          innerResultType &&
          (innerResultType.kind === "ref" || innerResultType.kind === "ref_null") &&
          innerResultType.typeIdx !== selfTypeIdx
        ) {
          emitGuardedRefCast(fctx, selfTypeIdx);
        }
        fctx.body.push({ op: "local.set", index: closureLocal });

        // Push closure ref as first arg (self param) — null-check → TypeError (#728)
        fctx.body.push({ op: "local.get", index: closureLocal });
        emitNullCheckThrow(ctx, fctx, closureRefType);

        // Push call arguments (only up to declared param count). (#4394)
        // Rest-aware: a matched rest-param closure gets its trailing args
        // packed into the rest vec instead of arg0 being coerced (→ nulled)
        // straight to the vec param. Includes the #1511 argc/extras protocol.
        emitMatchedClosureCallArguments(ctx, fctx, expr, matchedClosureInfo);

        // Push the funcref from the closure struct (field 0) — null-check → TypeError (#728)
        fctx.body.push({ op: "local.get", index: closureLocal });
        emitNullCheckThrow(ctx, fctx, closureRefType);
        fctx.body.push({
          op: "struct.get",
          typeIdx: selfTypeIdx,
          fieldIdx: 0,
        });
        // Guard funcref cast to avoid illegal cast (#778)
        emitGuardedFuncRefCast(fctx, matchedClosureInfo.funcTypeIdx);
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: matchedClosureInfo.funcTypeIdx });

        // call_ref with the lifted function's type index
        fctx.body.push({
          op: "call_ref",
          typeIdx: matchedClosureInfo.funcTypeIdx,
        });

        // (#1511) Reset __argc / __extras_argv. A callee that doesn't read
        // `arguments` never consumed them and would otherwise leak stale
        // values into the next call.
        if (matchedClosureInfo.returnType === null) {
          emitResetArgcExtras(ctx, fctx);
        } else {
          const _retLocal = allocLocal(fctx, `__cr_ret_${fctx.locals.length}`, matchedClosureInfo.returnType);
          fctx.body.push({ op: "local.set", index: _retLocal });
          emitResetArgcExtras(ctx, fctx);
          fctx.body.push({ op: "local.get", index: _retLocal });
        }

        // Return VOID_RESULT for void closures so compileExpression doesn't
        // treat the null return as a compilation failure and roll back instructions
        return matchedClosureInfo.returnType ?? VOID_RESULT;
      }
    }
  }

  // Handle ConditionalExpression as callee (not wrapped in parens):
  // (cond ? fn1 : fn2)(args) — handled directly
  if (ts.isConditionalExpression(expr.expression)) {
    return compileConditionalCallee(ctx, fctx, expr, expr.expression);
  }

  // (#1298 fix #3) Generic fallback: ref.test-guarded closure dispatch.
  //
  // For callees whose TS type carries a call signature, eagerly resolve the
  // wrapper struct/funcref pair via getOrCreateFuncRefWrapperTypes so the
  // dispatch is order-independent. Then gate the actual cast + call_ref on a
  // RUNTIME `ref.test (ref $__fn_wrap_N)`:
  //   - then branch (ref.test == 1): the value really is a wasm closure of
  //     this signature shape — cast + dispatch.
  //   - else branch (ref.test == 0): host function ref, foreign externref,
  //     null, or wasm closure of a different shape — fall back to the
  //     graceful `ref.null.extern` semantics that the pre-rewrite scan-only
  //     fallback used at this site.
  //
  // This avoids the v1 (PR #223) regression cluster (340 null_derefs in
  // Temporal/* etc.): the v1 path committed unconditionally to the wasm
  // closure dispatch and the first `emitNullCheckThrow` after a failed cast
  // turned the graceful-null exit into a TypeError.
  //
  // Args are evaluated into locals BEFORE the ref.test so the else branch
  // doesn't have to re-evaluate them (preserves side-effect ordering).
  //
  // See plan/issues/sprints/50/1298-fn-typed-fields-call-drops.md
  // (`## Fix #3 — Safe reimplementation`) for the full design.
  {
    const calleeTsType = ctx.checker.getTypeAtLocation(expr.expression);
    let callSigs = calleeTsType.getCallSignatures?.();
    if (!callSigs || callSigs.length === 0) {
      // (#1298) Strip nullable members for `Fn | null | undefined` callees.
      const nonNull = ctx.checker.getNonNullableType(calleeTsType);
      callSigs = nonNull.getCallSignatures?.();
    }

    if (callSigs && callSigs.length > 0) {
      const sig = callSigs[0]!;

      // (#4491) See the sibling site above.
      const runtimeSigParams = runtimeSignatureParameters(sig);
      const sigParamCount = runtimeSigParams.length;
      const sigRetType = ctx.checker.getReturnTypeOfSignature(sig);
      const sigRetWasm = isVoidType(sigRetType) ? null : resolveWasmType(ctx, sigRetType);
      const sigParamWasmTypes: ValType[] = [];
      for (let i = 0; i < sigParamCount; i++) {
        const paramType = ctx.checker.getTypeOfSymbol(runtimeSigParams[i]!);
        sigParamWasmTypes.push(resolveWasmType(ctx, paramType));
      }

      // (#1298 PR #231 fix) Look up an existing wrapper struct/funcref pair
      // for this signature WITHOUT registering a new one. The earlier draft
      // of fix #3 called `getOrCreateFuncRefWrapperTypes` here to get
      // order-independent dispatch, but registering a fresh wrapper struct
      // at this fallback site polluted `closureInfoByTypeIdx` with a struct
      // that wasn't actually used by any compiled closure. Downstream
      // funcref-candidate scans (e.g. the identifier-callable-param path's
      // multi-funcref dispatch at calls.ts:5106) then picked the unused
      // wrapper as a candidate, mismatching the closure that was actually
      // stored — `language/statements/function/S13_A18.js` reproduced this
      // as a null-deref inside a lifted closure body. Conservative fix:
      // only enter the dispatch path when a closure of this signature has
      // already been registered (the original scan-only behavior), and
      // gate THAT dispatch with ref.test. If no match, fall through to the
      // graceful tail at the end of compileCallExpression.
      // (#4394) Exact-first (typeIdx-aware) pick — see closure-sig-match.ts.
      const sigMatched = matchClosureInfoBySignature(ctx, sigParamWasmTypes, sigRetWasm, {
        sigHasRest: tsSignatureHasRest(sig),
      });
      const matchedClosureInfo: ClosureInfo | undefined = sigMatched?.info;
      const matchedStructTypeIdx: number | undefined = sigMatched?.structTypeIdx;
      const wrapperTypes =
        matchedClosureInfo && matchedStructTypeIdx !== undefined
          ? {
              closureInfo: matchedClosureInfo,
              structTypeIdx: matchedStructTypeIdx,
              liftedFuncTypeIdx: matchedClosureInfo.funcTypeIdx,
            }
          : null;

      if (wrapperTypes) {
        const closureInfo = wrapperTypes.closureInfo;
        const structTypeIdx = wrapperTypes.structTypeIdx;
        const funcTypeIdx = closureInfo.funcTypeIdx;
        const selfTypeIdx = getClosureFuncSelfTypeIdx(ctx, funcTypeIdx) ?? structTypeIdx;

        // 1. Compile the callee once. It must be a ref-shaped value (we can't
        //    `ref.test` an i32 / f64). For non-ref callees, drop value + args
        //    and emit graceful null directly.
        const innerResultType = compileExpression(ctx, fctx, expr.expression);

        const isRefShaped =
          innerResultType !== null &&
          (innerResultType.kind === "externref" ||
            innerResultType.kind === "ref" ||
            innerResultType.kind === "ref_null");

        if (!isRefShaped) {
          if (innerResultType !== null) {
            fctx.body.push({ op: "drop" });
          }
          for (const arg of expr.arguments) {
            const argType = compileExpression(ctx, fctx, arg);
            if (argType !== null) fctx.body.push({ op: "drop" });
          }
          fctx.body.push({ op: "ref.null.extern" });
          return { kind: "externref" };
        }

        // 2. Save callee value to a local. Stash type matches the compiled
        //    callee shape so re-loading roundtrips losslessly.
        const calleeStashType: ValType = innerResultType.kind === "externref" ? { kind: "externref" } : innerResultType;
        const calleeLocal = allocLocal(fctx, `__cb_callee_${fctx.locals.length}`, calleeStashType);
        fctx.body.push({ op: "local.set", index: calleeLocal });

        // 3. Compile call args into locals so both branches can re-push them
        //    without re-evaluating side effects.
        const argLocals: Array<{ local: number; type: ValType }> = [];
        const ccParamCnt = closureInfo.paramTypes.length;
        for (let i = 0; i < Math.min(expr.arguments.length, ccParamCnt); i++) {
          compileExpression(ctx, fctx, expr.arguments[i]!, closureInfo.paramTypes[i]);
          const argLocal = allocLocal(fctx, `__cb_carg_${fctx.locals.length}`, closureInfo.paramTypes[i]!);
          fctx.body.push({ op: "local.set", index: argLocal });
          argLocals.push({ local: argLocal, type: closureInfo.paramTypes[i]! });
        }
        // (#1511) Excess args: compile and save to externref locals so we can
        // pack them into __extras_argv inside the then branch without
        // re-running side effects.
        const extrasLocals: number[] = [];
        for (let i = ccParamCnt; i < expr.arguments.length; i++) {
          const extraType = compileExpression(ctx, fctx, expr.arguments[i]!, { kind: "externref" });
          if (extraType === null) {
            fctx.body.push({ op: "ref.null.extern" });
          } else if (extraType.kind === "f64") {
            const boxIdx = ctx.funcMap.get("__box_number");
            if (boxIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: boxIdx });
            } else {
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else if (extraType.kind === "i32") {
            fctx.body.push({ op: "f64.convert_i32_s" });
            const boxIdx = ctx.funcMap.get("__box_number");
            if (boxIdx !== undefined) {
              fctx.body.push({ op: "call", funcIdx: boxIdx });
            } else {
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "ref.null.extern" });
            }
          } else if (extraType.kind === "ref" || extraType.kind === "ref_null") {
            fctx.body.push({ op: "extern.convert_any" });
          }
          const extraLocal = allocLocal(fctx, `__cb_cextra_${fctx.locals.length}`, { kind: "externref" });
          fctx.body.push({ op: "local.set", index: extraLocal });
          extrasLocals.push(extraLocal);
        }
        // Pad missing args. For non-nullable ref params widen to nullable so
        // `pushDefaultValue` emits a plain `ref.null` (no `ref.as_non_null`
        // trap). The lifted func sig accepts nullable refs, so the call_ref
        // type matches.
        for (let i = expr.arguments.length; i < ccParamCnt; i++) {
          const paramType = closureInfo.paramTypes[i]!;
          const padType: ValType =
            paramType.kind === "ref" ? { kind: "ref_null", typeIdx: paramType.typeIdx } : paramType;
          pushDefaultValue(fctx, padType, ctx);
          const argLocal = allocLocal(fctx, `__cb_cpad_${fctx.locals.length}`, padType);
          fctx.body.push({ op: "local.set", index: argLocal });
          argLocals.push({ local: argLocal, type: padType });
        }

        // 4. Emit the ref.test guard. Stack before the if: [i32].
        fctx.body.push({ op: "local.get", index: calleeLocal });
        if (innerResultType.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" });
        }
        fctx.body.push({ op: "ref.test", typeIdx: selfTypeIdx });

        // 5. then branch — ref.test passed, do the dispatch.
        // (#1395 fix) Use pushBody/popBody so the saved body is tracked in
        // fctx.savedBodies. Without this, late-import index shifts via
        // `fixupModuleGlobalIndices` walking only `ctx.currentFunc.body` +
        // `savedBodies` would miss `global.get`/`global.set` instructions
        // that were emitted into the OUTER body before the swap. In
        // particular, `compileExpression(C.f)` at line 7436 above pushes
        // `global.get <staticPropIdx>` for a class static-field receiver
        // into the outer body; if a string-constant import then gets
        // added during dispatch compilation below (step 4b/5), the
        // shifter's threshold/delta would correctly bump the static-prop
        // map but skip the orphaned outer body, producing a stale index
        // that points at a sibling global (e.g. `__class_C` instead of
        // `__static_C_f`). Tests:
        // language/statements/class/elements/static-field-init-this-
        // inside-arrow-function.js (#1395 followup).
        const savedBody = pushBody(fctx);
        const thenInstrs = fctx.body;

        // Re-load callee + plain ref.cast (test already proved it succeeds).
        fctx.body.push({ op: "local.get", index: calleeLocal });
        if (innerResultType.kind === "externref") {
          fctx.body.push({ op: "any.convert_extern" });
        }
        fctx.body.push({ op: "ref.cast", typeIdx: selfTypeIdx });
        const closureLocal = allocLocal(fctx, `__cb_closure_${fctx.locals.length}`, {
          kind: "ref",
          typeIdx: selfTypeIdx,
        });
        fctx.body.push({ op: "local.set", index: closureLocal });

        // Push self (closure ref) + saved args.
        fctx.body.push({ op: "local.get", index: closureLocal });
        for (const al of argLocals) {
          fctx.body.push({ op: "local.get", index: al.local });
        }

        // (#1511) Set __extras_argv (from saved extras locals) and __argc so
        // the lifted callee can compute the correct arguments.length when it
        // reads `arguments`. Stack contributions are immediately consumed.
        if (extrasLocals.length > 0) {
          const { globalIdx: extrasGlobalIdx, vecTypeIdx: extrasVecTi } = ensureExtrasArgvGlobal(ctx);
          const extrasArrTi = getArrTypeIdxFromVec(ctx, extrasVecTi);
          for (const el of extrasLocals) {
            fctx.body.push({ op: "local.get", index: el });
          }
          fctx.body.push({ op: "array.new_fixed", typeIdx: extrasArrTi, length: extrasLocals.length });
          const arrTmp = allocLocal(fctx, `__cb_extras_arr_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: extrasArrTi,
          });
          fctx.body.push({ op: "local.set", index: arrTmp });
          fctx.body.push({ op: "i32.const", value: extrasLocals.length });
          fctx.body.push({ op: "local.get", index: arrTmp });
          fctx.body.push({ op: "struct.new", typeIdx: extrasVecTi });
          fctx.body.push({ op: "global.set", index: extrasGlobalIdx });
        }
        emitSetArgc(ctx, fctx, expr.arguments.length, ccParamCnt);

        // Push funcref from closure struct, guarded cast + null-check, call_ref.
        fctx.body.push({ op: "local.get", index: closureLocal });
        fctx.body.push({ op: "struct.get", typeIdx: selfTypeIdx, fieldIdx: 0 });
        emitGuardedFuncRefCast(fctx, funcTypeIdx);
        emitNullCheckThrow(ctx, fctx, { kind: "ref_null", typeIdx: funcTypeIdx });
        fctx.body.push({ op: "call_ref", typeIdx: funcTypeIdx });

        // (#4394) A concrete GC-ref closure result keeps its OWN type across
        // the if-join instead of detouring through externref. The externref
        // detour ran the #2358 struct→`$Object` materialization on a
        // user-`toString` struct, and the CALLER's guarded externref→struct
        // cast then nulled the materialized `$Object` — deepEqual.js's
        // `return lazyResult`…`()` came back null. Wasm typing guarantees the
        // call_ref result is `funcTypeIdx`'s declared result, so the typed
        // join is always valid; the graceful else arm stays a null of the
        // same type. Void and numeric results keep the externref join.
        const refResultType: ValType | null =
          closureInfo.returnType !== null &&
          (closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null")
            ? { kind: "ref_null", typeIdx: closureInfo.returnType.typeIdx }
            : null;
        const joinType: ValType = refResultType ?? { kind: "externref" };
        if (closureInfo.returnType === null) {
          fctx.body.push({ op: "ref.null.extern" });
        } else if (refResultType === null && closureInfo.returnType.kind !== "externref") {
          coerceType(ctx, fctx, closureInfo.returnType, { kind: "externref" });
        }
        // (#1511) Reset argc/extras after the call. Return value is on the
        // stack at this point — save, reset, restore.
        {
          const _retL = allocLocal(fctx, `__cb_ret_${fctx.locals.length}`, joinType);
          fctx.body.push({ op: "local.set", index: _retL });
          emitResetArgcExtras(ctx, fctx);
          fctx.body.push({ op: "local.get", index: _retL });
        }

        // 6. else branch — graceful null (typed to match the join).
        const elseInstrs: Instr[] =
          refResultType !== null
            ? [{ op: "ref.null", typeIdx: (refResultType as { typeIdx: number }).typeIdx }]
            : [{ op: "ref.null.extern" }];

        // 7. Restore body, emit the if/else.
        popBody(fctx, savedBody);
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: joinType },
          then: thenInstrs,
          else: elseInstrs,
        });

        return joinType;
      }
    }
  }

  // (#4096) The last two steps — the stored-member-closure arm and the graceful
  // `ref.null.extern` fallback it guards — live in `stored-member-closure-call.ts`,
  // where the rationale sits next to the lowering. See that module's header.
  return compileCallDispatchTail(ctx, fctx, expr);
}
