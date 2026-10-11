// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * The argument array of the generic `__extern_method_call(recv, name, args)`
 * host bridge (#5361).
 *
 * Extracted from `compileReceiverMethodCall`, which is one of the compiler's
 * largest functions and is under a per-function LOC ceiling (#3400). The
 * bridge's array is built by `__js_array_new` + one `__js_array_push` per
 * argument, which is exact only while every argument is a single value: a
 * SPREAD contributes its runtime element count, so `hostArr.splice(-1, 1,
 * ...src)` handed the host the source ARRAY as one inserted item — hono's
 * `expandIPv6` then read `sections[i].padStart` off an array.
 */
import type { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { maybeStampCompiledFunctionArgName } from "./expressions/helpers.js";
import { flushLateImportShifts } from "./expressions/late-imports.js";
import { bindingIsNodeBuiltinNamedImport } from "./expressions/node-builtin-named-import.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { compileExpression, ensureLateImport } from "./shared.js";
import { buildSpreadArgList, hasSpreadArgument } from "./spread-arg-list.js";

/**
 * Fill `argsLocal` (an already-created host array) with the call's arguments.
 *
 * With a spread present the whole list goes through the shared
 * spread-expanding builder; without one the unrolled per-node loop is exact
 * and is kept verbatim, so a call site with no spread emits byte-identical
 * code to before.
 */
export function emitHostMethodCallArgs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  argsLocal: number,
  arrPushName: string,
  arrPushIdx: number,
): void {
  const handled = tryEmitSpreadHostArgs(ctx, fctx, expr.arguments, argsLocal, arrPushName, arrPushIdx, {
    afterValue: (arg) => {
      maybeStampCompiledFunctionArgName(ctx, fctx, arg);
    },
  });
  if (handled) return;
  for (const arg of expr.arguments) {
    fctx.body.push({ op: "local.get", index: argsLocal });
    const argType = compileExpression(ctx, fctx, arg, { kind: "externref" });
    if (argType && argType.kind !== "externref") {
      fctx.body.push({ op: "extern.convert_any" });
    }
    if (argType === null) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    // (#3429) A statically-name-resolvable compiled function/class argument
    // (e.g. `assert.throws(MyError, fn)`) gets its real `.name` stamped before
    // crossing — see maybeStampCompiledFunctionArgName.
    maybeStampCompiledFunctionArgName(ctx, fctx, arg);
    fctx.body.push({ op: "call", funcIdx: arrPushIdx });
  }
}

/**
 * Fill an already-created host array with a SPREAD-containing argument list,
 * expanding each spread source at its runtime length.
 *
 * Returns `false` when there is no spread (the caller keeps its own unrolled
 * per-node loop, which is exact and stays byte-identical) or when the target
 * has no substrate to expand one. Nothing is emitted in either case.
 *
 * Every host-array argument builder in the compiler is the same `__js_array_new`
 * + one `__js_array_push` per AST node shape, and every one of them sizes the
 * array from `arguments.length` — which is the right number only while each
 * argument is ONE value. This is the single place that difference is repaired,
 * so a new bridge gets the runtime count by calling here rather than by growing
 * a sixth copy of the loop.
 */
export function tryEmitSpreadHostArgs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  args: readonly ts.Expression[],
  argsLocal: number,
  arrPushName: string,
  arrPushIdx: number,
  opts?: { afterValue?: (arg: ts.Expression) => void },
): boolean {
  if (!hasSpreadArgument(args)) return false;
  const built = buildSpreadArgList(ctx, fctx, args, 0, { kind: "externref" }, "hostargs", opts);
  if (!built) return false;
  // The push helper's funcidx is re-resolved by NAME: expanding a spread can
  // register late imports, which shifts every defined-function index that was
  // captured before them.
  built.emitStores({
    pre: [{ op: "local.get", index: argsLocal }],
    post: [{ op: "call", funcIdx: ctx.funcMap.get(arrPushName) ?? arrPushIdx }],
  });
  return true;
}

const EXTERNREF: ValType = { kind: "externref" };

/**
 * (#6450) Direct CALL of a node-builtin NAMED import.
 *
 * `import { createHash } from 'node:crypto'` registers `createHash` in
 * `ctx.declaredGlobals` as a MEMBER binding of the module thunk
 * (`__node_crypto`) — see `registerNodeBuiltinImports` in
 * `extern-declarations.ts`, and the matching VALUE read in
 * `expressions/identifiers.ts` which emits
 * `__extern_get(__node_crypto(), "createHash")` (#4616, jest's `EOL`).
 *
 * The CALL position had no such arm. `compileIdentifierCall` consulted only the
 * bare-name registries, so `createHash('sha256')` resolved two different wrong
 * ways depending on what else the linked graph contained:
 *
 *   - with a same-named function anywhere in the graph, `closureMap`/`funcMap`
 *     called THAT function. Both maps are keyed by a bare identifier across the
 *     whole linked graph, so the leak is cross-MODULE and is not TS shadowing:
 *     hono's `src/utils/crypto.ts` exports `async function createHash`, and its
 *     own `crypto.test.ts` — which imports the builtin — reached the async
 *     export, whose Promise answered `update is not a function`.
 *   - with none, the ladder fell through to the graceful `ref.null.extern`
 *     default and the next property access read `update` off null.
 *
 * The fix routes the call through the same module thunk the value read uses,
 * as `__extern_method_call(__node_crypto(), "createHash", [args])`. Using the
 * method bridge rather than `__extern_get` plus a dynamic call is what binds
 * `this` to the module object, which is what `crypto.createHash` needs.
 *
 * The arm is gated on the CHECKER's binding for the call site rather than on
 * `call-identifier.ts`'s bare-name `isLocallyShadowed` /
 * `hasVisibleClosureStorage` heuristics, which the plan for this issue had
 * proposed adding on top. Those are strictly weaker here, and in the wrong
 * direction twice over: a genuine lexical or module shadow makes the checker
 * report the SHADOWING declaration, so this arm never fires and no extra guard
 * is needed; whereas a same-named binding in an unrelated module — hono's
 * `createHash` again, since `moduleGlobals` is bare-name and graph-wide — sets
 * `hasVisibleClosureStorage` and would have suppressed the import's own call,
 * defeating the fix in precisely the case it was written for.
 *
 * Compile `member(args)` where `member` is a named import of a node builtin.
 *
 * Returns `undefined` when this is not that shape (the caller keeps its own
 * dispatch ladder) or when a required host import is unavailable.
 */
export function tryCompileNodeBuiltinMemberCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  funcName: string,
  calleeBindingDecl: ts.Declaration | undefined,
): ValType | undefined {
  // Node builtins are a JS-host-only surface: `registerNodeBuiltinImports`
  // errors out under WASI rather than emitting a `__node_*` thunk, so there is
  // nothing to call in the standalone lane.
  if (ctx.wasi) return undefined;
  if (!ctx.nodeBuiltinGlobals.has(funcName)) return undefined;
  const member = ctx.declaredGlobals.get(funcName)?.member;
  if (member === undefined) return undefined;
  if (!bindingIsNodeBuiltinNamedImport(calleeBindingDecl)) return undefined;

  // Register every host dependency before emitting anything: a late import
  // shifts function indices, so the index reads below must happen after the
  // flush (the #1719 reserve-then-fill rule).
  const arrayNewIdx = ensureLateImport(ctx, "__js_array_new", [], [EXTERNREF]);
  const arrayPushIdx = ensureLateImport(ctx, "__js_array_push", [EXTERNREF, EXTERNREF], []);
  const methodCallIdx = ensureLateImport(ctx, "__extern_method_call", [EXTERNREF, EXTERNREF, EXTERNREF], [EXTERNREF]);
  addStringConstantGlobal(ctx, member);
  flushLateImportShifts(ctx, fctx);
  const resolvedNewIdx = ctx.funcMap.get("__js_array_new") ?? arrayNewIdx;
  const resolvedPushIdx = ctx.funcMap.get("__js_array_push") ?? arrayPushIdx;
  const resolvedMethodCallIdx = ctx.funcMap.get("__extern_method_call") ?? methodCallIdx;
  if (resolvedNewIdx === undefined || resolvedPushIdx === undefined || resolvedMethodCallIdx === undefined) {
    return undefined;
  }
  // Re-read the module thunk's own index for the same reason.
  const moduleThunkIdx = ctx.declaredGlobals.get(funcName)?.funcIdx;
  if (moduleThunkIdx === undefined) return undefined;

  fctx.body.push({ op: "call", funcIdx: resolvedNewIdx });
  const argsLocal = allocLocal(fctx, `__nodebuiltin_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.set", index: argsLocal });
  emitHostMethodCallArgs(ctx, fctx, expr, argsLocal, "__js_array_push", resolvedPushIdx);

  fctx.body.push({ op: "call", funcIdx: moduleThunkIdx });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, member));
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: resolvedMethodCallIdx });
  return EXTERNREF;
}
