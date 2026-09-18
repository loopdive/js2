// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5198 slice 1) `RegExpExec` (§22.2.7.1) for `@@match` / `@@search` in
 * `--target standalone`.
 *
 * ## The defect
 *
 * For a receiver the compiler types as `RegExp`, the standalone `@@match` /
 * `@@search` lowering runs the native regex engine directly
 * (`emitStandaloneRegExpMatchCore` / `…SearchCore`) and performs **zero**
 * observable spec steps. There is no `Get(R, "exec")`, no `Call`, no
 * `Get(result, …)`. A user-installed `exec` is therefore silently ignored:
 *
 * ```js
 * var r = /./;
 * r.exec = function () { throw new Test262Error(); };
 * r[Symbol.match]('');     // standalone: no throw  ·  spec/Node: throws
 * ```
 *
 * Measured on `origin/main` @ `a8b8dfc180`, `--target standalone`,
 * `result.imports` asserted `[]`: an assigned `exec` observed by `@@match`
 * returned `0` where Node returns `1`; the pristine control returned `1` in
 * both. The receiver spelling is load-bearing — `var r = /./` (what test262
 * writes, and what TypeScript infers as `RegExp`) takes this path, while
 * `const r: any = /./` takes a different dispatch with a different, separate
 * defect.
 *
 * ## Shape — the #802 posture, as a two-arm runtime branch
 *
 *   `IsCallable(Get(R, "exec"))` ? the spec sequence : the unchanged native lowering
 *
 * The ELSE arm re-dispatches the whole call, so the existing fast path is
 * emitted **verbatim** and every currently-passing row keeps its answer. That
 * is the same discipline `builtin-proto-member-override.ts` (#4556) uses for
 * "branch between two full lowerings of the same call", and it is why the
 * missing `RegExpBuiltinExec` half of §22.2.7.1 costs nothing here: when `exec`
 * is not an own callable, control simply lands on today's code.
 *
 * ## Byte-inertness is the acceptance criterion, not a hope
 *
 * The branch is built only for a module whose SOURCE escapes the protocol —
 * a write to `.exec`, or `Object`/`Reflect.defineProperty(_, "exec", …)`.
 * A module that never does that is never marked, so the arm is not merely dead,
 * it is never built and the binary is byte-identical (proved by hashing 12
 * RegExp programs on base and branch, standalone and gc). 86 of the 190 rows in
 * this cluster depend on that fast path.
 *
 * Kill switch: `JS2WASM_NO_REGEXP_PROTOCOL=1` disables the mark, which disables
 * the whole slow path wholesale — the same posture as `JS2WASM_NO_DYNPROTO`.
 *
 * ## Deliberate slice-1 scope
 *
 * - `@@match` and `@@search` only. `@@replace` / `@@split` are slice 2.
 * - `@@match` only in its NON-GLOBAL form (§22.2.6.8 step 7). The global form
 *   needs the step-5 result ARRAY and the `lastIndex` advance loop; it declines
 *   here and keeps today's lowering rather than shipping a half-built loop.
 * - `lastIndex` is read and restored through the struct slots (§22.2.6.12
 *   steps 3–6). A NON-WRITABLE `lastIndex` — `Object.defineProperty(r,
 *   'lastIndex', {writable:false})` — is not modelled, so
 *   `Symbol.match/builtin-success-g-set-lastindex-err.js` stays red; that needs
 *   runtime writability state, which is slice 3. It is a pinned residual, not a
 *   skipped test.
 * - `Get(rx,"global")` is answered statically from the receiver's flags rather
 *   than reflectively. A `global` getter override is slice 4.
 *
 * ## One ordering deviation, stated plainly
 *
 * §22.2.6.8 / §22.2.6.12 do `S = ToString(string)` BEFORE `Get(R, "exec")`.
 * Here the `Get` happens first, because the branch it feeds decides which arm
 * evaluates the argument — computing `S` in the outer body would make the ELSE
 * arm (which re-dispatches the whole call) evaluate the argument a SECOND time
 * at runtime, and a double `toString()` is a worse wrong answer than a
 * reordered one. Both orders agree unless a program poisons the `exec` getter
 * *and* the argument's `toString` and observes which fires first; no row in the
 * 190-row cluster does.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjVecBuilders, reserveApplyClosure } from "./object-runtime.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import {
  RE_FIELD_LASTINDEX,
  RE_FIELD_LASTINDEX_RAW,
  RE_FIELD_LASTINDEX_RAW_PRESENT,
  loadStandaloneRegExpStruct,
  staticRegExpFlags,
  usesNativeRegExpProvider,
} from "./regexp-standalone.js";
import { coerceType, compileExpression, flushLateImportShifts, skipTransparentExpressions } from "./shared.js";
import { ensureLateImport } from "./expressions/late-imports.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const F64: ValType = { kind: "f64" };

/** §22.2.7.1 step 1 reads this key; the prescan below marks writes to it. */
const EXEC_KEY = "exec";
/** §22.2.6.12 step 7 reads this key off the RegExpExec result. */
const INDEX_KEY = "index";
/**
 * §7.1.17 ToString, named once. The same discipline `array-tolocalestring.ts`
 * uses: one name for the operation keeps the coercion-vocabulary gate honest
 * (three literal spellings read as three hand-rolled coercion sites).
 */
const TO_STRING = "__extern_toString";

/**
 * Re-entry guard: the ELSE arm re-dispatches the whole call so the native
 * lowering runs verbatim, and must not land back here.
 */
const protocolTwoArmActive = new WeakSet<ts.CallExpression>();

/** One whole-file scan per source file; every call site asks the same question. */
const escapeScanCache = new WeakMap<ts.SourceFile, boolean>();

/**
 * Does this source file escape the `exec` protocol?
 *
 * Whole-file, syntactic, and keyed on the NAME `exec` — deliberately, for the
 * same reason `sourceOverridesBuiltinPrototypeMember` (#4556) is: writing
 * `exec` on anything is rare outside a RegExp, and the two-arm is *runtime*
 * safe even when the guess is wrong. A module that assigns `.exec` on some
 * unrelated object still reaches the ELSE arm for every pristine RegExp,
 * because `Get(R,"exec")` on an untouched standalone RegExp answers
 * `undefined` and `IsCallable` is false. So a false mark costs emitted bytes,
 * never an answer — which is what lets this be a cheap syntactic test instead
 * of a type query.
 */
export function sourceEscapesRegExpExecProtocol(anchor: ts.Node): boolean {
  if (process.env.JS2WASM_NO_REGEXP_PROTOCOL === "1") return false;
  const sf = anchor.getSourceFile();
  if (!sf) return false;
  const cached = escapeScanCache.get(sf);
  if (cached !== undefined) return cached;

  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    // `<expr>.exec = …` / `<expr>["exec"] = …` (any assignment operator).
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      const lhs = node.left;
      if (ts.isPropertyAccessExpression(lhs) && !ts.isPrivateIdentifier(lhs.name) && lhs.name.text === EXEC_KEY) {
        found = true;
        return;
      }
      if (
        ts.isElementAccessExpression(lhs) &&
        ts.isStringLiteralLike(lhs.argumentExpression) &&
        lhs.argumentExpression.text === EXEC_KEY
      ) {
        found = true;
        return;
      }
    }
    // `Object.defineProperty(_, "exec", …)` / `Reflect.defineProperty(…)`.
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "defineProperty" &&
      ts.isIdentifier(node.expression.expression) &&
      (node.expression.expression.text === "Object" || node.expression.expression.text === "Reflect") &&
      node.arguments.length >= 2 &&
      ts.isStringLiteralLike(node.arguments[1]!) &&
      node.arguments[1]!.text === EXEC_KEY
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  escapeScanCache.set(sf, found);
  return found;
}

/** Every native the slow arm calls, resolved by NAME after the last shift. */
interface ProtocolNatives {
  readonly externGet: number;
  readonly isCallable: number;
  readonly toString: number;
  readonly isNullish: number;
  readonly isUndefined: number;
  readonly typeofObject: number;
  readonly typeofFunction: number;
  readonly applyClosure: number;
  readonly objVecNew: number;
  readonly objVecPush: number;
}

/**
 * Register every helper and intern every key BEFORE any arm code is buffered —
 * a late registration shifts defined-func indices under instructions already
 * emitted into a detached arm (the #1839/#2043 late-shift class).
 *
 * Returns `undefined` when any native is unavailable, in which case the caller
 * declines and the module keeps its existing lowering.
 */
function ensureProtocolNatives(ctx: CodegenContext, fctx: FunctionContext): ProtocolNatives | undefined {
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__is_callable", [EXTERNREF], [I32]);
  ensureLateImport(ctx, TO_STRING, [EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_nullish", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__typeof_object", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__typeof_function", [EXTERNREF], [I32]);
  reserveApplyClosure(ctx);
  ensureObjVecBuilders(ctx);
  addStringConstantGlobal(ctx, EXEC_KEY);
  addStringConstantGlobal(ctx, INDEX_KEY);
  flushLateImportShifts(ctx, fctx);

  const get = (name: string): number | undefined => ctx.funcMap.get(name);
  const externGet = get("__extern_get");
  const isCallable = get("__is_callable");
  const toStringIdx = get(TO_STRING);
  const isNullish = get("__extern_is_nullish");
  const isUndefined = get("__extern_is_undefined");
  const typeofObject = get("__typeof_object");
  const typeofFunction = get("__typeof_function");
  const applyClosure = get("__apply_closure");
  const objVecNew = get("__objvec_new");
  const objVecPush = get("__objvec_push");
  if (
    externGet === undefined ||
    isCallable === undefined ||
    toStringIdx === undefined ||
    isNullish === undefined ||
    isUndefined === undefined ||
    typeofObject === undefined ||
    typeofFunction === undefined ||
    applyClosure === undefined ||
    objVecNew === undefined ||
    objVecPush === undefined
  ) {
    return undefined;
  }
  return {
    externGet,
    isCallable,
    toString: toStringIdx,
    isNullish,
    isUndefined,
    typeofObject,
    typeofFunction,
    applyClosure,
    objVecNew,
    objVecPush,
  };
}

/**
 * `[] → [i32]` — §22.2.7.1 step 5b's admissible set: `Type(result)` is Object
 * **or** Null.
 *
 * `typeof null` is `"object"`, so the nullish half is decided first: `null`
 * passes, `undefined` does not. Everything else is admitted exactly when the
 * module's own `typeof` classifiers call it object-like or callable.
 */
function buildIsObjectOrNull(n: ProtocolNatives, valLocal: number): Instr[] {
  return [
    { op: "local.get", index: valLocal },
    { op: "call", funcIdx: n.isNullish },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "local.get", index: valLocal }, { op: "call", funcIdx: n.isUndefined }, { op: "i32.eqz" }],
      else: [
        { op: "local.get", index: valLocal },
        { op: "call", funcIdx: n.typeofObject },
        { op: "local.get", index: valLocal },
        { op: "call", funcIdx: n.typeofFunction },
        { op: "i32.or" },
      ],
    },
  ];
}

/** Scratch slots the slow arm needs. */
interface ProtocolLocals {
  readonly recv: number;
  readonly exec: number;
  readonly subject: number;
  readonly args: number;
  readonly result: number;
}

function allocProtocolLocals(fctx: FunctionContext): ProtocolLocals {
  return {
    recv: allocLocal(fctx, `__rxp_recv_${fctx.locals.length}`, EXTERNREF),
    exec: allocLocal(fctx, `__rxp_exec_${fctx.locals.length}`, EXTERNREF),
    subject: allocLocal(fctx, `__rxp_s_${fctx.locals.length}`, EXTERNREF),
    args: allocLocal(fctx, `__rxp_args_${fctx.locals.length}`, EXTERNREF),
    result: allocLocal(fctx, `__rxp_res_${fctx.locals.length}`, EXTERNREF),
  };
}

/**
 * Emit `S = ToString(string)` then `result = RegExpExec(R, S)` for the
 * callable-`exec` half of §22.2.7.1 (steps 5a–5c), leaving `result` in
 * `slots.result` and nothing on the value stack.
 *
 * Returns `false` when the argument could not be compiled; the caller abandons
 * the branch.
 */
function emitExecInvocation(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argExpr: ts.Expression,
  n: ProtocolNatives,
  slots: ProtocolLocals,
): boolean {
  // §22.2.6.8 step 2 / §22.2.6.12 step 2 — ToString(string).
  const argType = compileExpression(ctx, fctx, argExpr, EXTERNREF);
  if (argType === null) return false;
  if (argType.kind !== "externref") coerceType(ctx, fctx, argType, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get(TO_STRING) ?? n.toString });
  fctx.body.push({ op: "local.set", index: slots.subject });

  // §22.2.7.1 step 5a — Call(exec, R, «S»).
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_new") ?? n.objVecNew });
  fctx.body.push({ op: "local.set", index: slots.args });
  fctx.body.push({ op: "local.get", index: slots.args });
  fctx.body.push({ op: "local.get", index: slots.subject });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__objvec_push") ?? n.objVecPush });
  fctx.body.push({ op: "local.get", index: slots.exec });
  fctx.body.push({ op: "local.get", index: slots.recv });
  fctx.body.push({ op: "local.get", index: slots.args });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__apply_closure") ?? n.applyClosure });
  fctx.body.push({ op: "local.set", index: slots.result });

  // §22.2.7.1 step 5c — neither Object nor Null is a TypeError.
  fctx.body.push(...buildIsObjectOrNull(n, slots.result));
  fctx.body.push({ op: "i32.eqz" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "empty" },
    then: buildThrowJsErrorInstrs(
      ctx,
      "TypeError",
      "RegExp exec method returned something other than an Object or null",
      {
        flush: fctx,
      },
    ),
  });
  return true;
}

/**
 * `re[Symbol.match](s)` / `re[Symbol.search](s)` in standalone, for a module
 * whose source escapes the `exec` protocol.
 *
 * Returns the branch's ValType, `null` when a required sub-emission already
 * reported an error, or `undefined` to leave the caller on its ordinary single
 * path — which is what happens for every module that does not escape, for a
 * receiver whose evaluation is not safe to repeat, for the global `@@match`
 * form, and whenever an arm declines.
 */
export function tryCompileRegExpProtocolTwoArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  regexExpr: ts.Expression,
  methodName: string,
): ValType | null | undefined {
  if (!ctx.standalone || !usesNativeRegExpProvider(ctx)) return undefined;
  const method = methodName === "@@match" ? "match" : methodName === "@@search" ? "search" : undefined;
  if (method === undefined) return undefined;
  if (expr.arguments.length !== 1) return undefined;
  if (expr.arguments.some((a) => ts.isSpreadElement(a))) return undefined;
  if (protocolTwoArmActive.has(expr)) return undefined;

  // The ELSE arm re-compiles the receiver, so it must be safe to evaluate
  // twice. Identifiers are the general case and the only one test262 writes.
  const receiverExpr = skipTransparentExpressions(regexExpr);
  if (!ts.isIdentifier(receiverExpr)) return undefined;
  if (!sourceEscapesRegExpExecProtocol(expr)) return undefined;

  // Slice 1 does not build the §22.2.6.8 step-5 result array; the global
  // `@@match` form keeps today's lowering (see the module header).
  const flags = staticRegExpFlags(ctx, receiverExpr);
  if (flags === null) return undefined;
  if (method === "match" && flags.includes("g")) return undefined;

  const natives = ensureProtocolNatives(ctx, fctx);
  if (natives === undefined) return undefined;

  const loaded = loadStandaloneRegExpStruct(ctx, fctx, receiverExpr);
  if (loaded === null) return null;
  const { regexpLocal, structTypeIdx } = loaded;
  flushLateImportShifts(ctx, fctx);

  const slots = allocProtocolLocals(fctx);
  // The externref view of the same receiver: `Get`/`Call` take externref, the
  // `lastIndex` slots take the struct.
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "local.set", index: slots.recv });

  // §22.2.7.1 step 1 — Get(R, "exec"); its getter may throw, which propagates.
  fctx.body.push({ op: "local.get", index: slots.recv });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, EXEC_KEY));
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? natives.externGet });
  fctx.body.push({ op: "local.tee", index: slots.exec });
  // §22.2.7.1 step 4 — IsCallable(exec) selects the arm.
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__is_callable") ?? natives.isCallable });

  const armType: ValType = method === "match" ? EXTERNREF : F64;
  const outer = fctx.body;
  const thenArm: Instr[] = [];
  const elseArm: Instr[] = [];
  fctx.savedBodies.push(outer);
  fctx.savedBodies.push(thenArm);
  fctx.savedBodies.push(elseArm);

  fctx.body = thenArm;
  const thenOk =
    method === "match"
      ? emitMatchSlowArm(ctx, fctx, expr, natives, slots)
      : emitSearchSlowArm(ctx, fctx, expr, natives, slots, regexpLocal, structTypeIdx);

  fctx.body = elseArm;
  protocolTwoArmActive.add(expr);
  const rElse = compileExpression(ctx, fctx, expr);
  protocolTwoArmActive.delete(expr);
  let elseOk = rElse !== null && rElse !== undefined;
  if (elseOk) {
    const t = rElse as ValType;
    if (t.kind !== armType.kind || (armType.kind === "externref" && t.kind !== "externref")) {
      coerceType(ctx, fctx, t, armType);
    }
    elseOk = true;
  }

  fctx.body = outer;
  fctx.savedBodies.pop();
  fctx.savedBodies.pop();
  fctx.savedBodies.pop();

  if (!thenOk || !elseOk) return undefined;

  outer.push({ op: "if", blockType: { kind: "val", type: armType }, then: thenArm, else: elseArm });
  return armType;
}

/**
 * §22.2.6.8 step 7 — the non-global `@@match` is exactly `RegExpExec(rx, S)`,
 * returned unchanged (identity included: `exec-return-type-valid.js` asserts
 * `SameValue(r[Symbol.match](''), retValue)` for a `{}` return).
 */
function emitMatchSlowArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  n: ProtocolNatives,
  slots: ProtocolLocals,
): boolean {
  if (!emitExecInvocation(ctx, fctx, expr.arguments[0]!, n, slots)) return false;
  fctx.body.push({ op: "local.get", index: slots.result });
  return true;
}

/**
 * §22.2.6.12 — `@@search` reads `lastIndex`, normalises it to `+0`, runs
 * `RegExpExec`, restores the saved value, and answers `-1` or
 * `Get(result, "index")`.
 *
 * The save/restore covers all three `lastIndex` slots (the numeric fast slot
 * plus the deferred raw value and its presence flag), so a non-numeric pending
 * assignment is neither lost nor promoted. The restore is unconditional rather
 * than `SameValue`-gated: the two behaviours differ only when `lastIndex` is
 * non-writable, which slice 1 does not model either way.
 *
 * An abrupt `RegExpExec` skips the restore, which is what `? RegExpExec` means.
 */
function emitSearchSlowArm(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  n: ProtocolNatives,
  slots: ProtocolLocals,
  regexpLocal: number,
  structTypeIdx: number,
): boolean {
  const prevNum = allocLocal(fctx, `__rxp_li_${fctx.locals.length}`, F64);
  const prevRaw = allocLocal(fctx, `__rxp_liraw_${fctx.locals.length}`, EXTERNREF);
  const prevPresent = allocLocal(fctx, `__rxp_lipr_${fctx.locals.length}`, I32);

  // Step 3 — previousLastIndex = Get(rx, "lastIndex").
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX });
  fctx.body.push({ op: "local.set", index: prevNum });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX_RAW });
  fctx.body.push({ op: "local.set", index: prevRaw });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX_RAW_PRESENT });
  fctx.body.push({ op: "local.set", index: prevPresent });

  // Step 4 — Set(rx, "lastIndex", +0). `-0` is not SameValue `+0`, and the
  // custom `exec` reads the slot (`set-lastindex-init-samevalue.js`).
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "f64.const", value: 0 });
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX_RAW_PRESENT });

  // Step 5 — result = RegExpExec(rx, S).
  if (!emitExecInvocation(ctx, fctx, expr.arguments[0]!, n, slots)) return false;

  // Step 6 — restore the saved lastIndex.
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "local.get", index: prevNum });
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "local.get", index: prevRaw });
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX_RAW });
  fctx.body.push({ op: "local.get", index: regexpLocal });
  fctx.body.push({ op: "local.get", index: prevPresent });
  fctx.body.push({ op: "struct.set", typeIdx: structTypeIdx, fieldIdx: RE_FIELD_LASTINDEX_RAW_PRESENT });

  // Step 7 — null ⇒ -1, else Get(result, "index").
  const indexArm: Instr[] = [];
  const saved = fctx.body;
  fctx.body = indexArm;
  fctx.body.push({ op: "local.get", index: slots.result });
  fctx.body.push(...stringConstantExternrefInstrs(ctx, INDEX_KEY));
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? n.externGet });
  coerceType(ctx, fctx, EXTERNREF, F64);
  fctx.body = saved;

  fctx.body.push({ op: "local.get", index: slots.result });
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_is_nullish") ?? n.isNullish });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: F64 },
    then: [{ op: "f64.const", value: -1 }],
    else: indexArm,
  });
  return true;
}
