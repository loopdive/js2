// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B) §22.1.3 step 2 — the `String.prototype.{match,replace,
 * search,split}` **symbol-protocol dispatch**, standalone.
 *
 * Every one of those four methods begins the same way:
 *
 * ```
 * 2. If searchValue is neither undefined nor null, then
 *    a. Let m be ? GetMethod(searchValue, @@<protocol>).
 *    b. If m is not undefined, return ? Call(m, searchValue, «O[, extra]»).
 * ```
 *
 * `string-search-value.ts` (#4016) owns the decision for step 3 onward — the
 * plain-`ToString` lane and the `RegExpCreate(ToString(v))` lane. It answers
 * step 2 **statically**, with `ctx.oracle.wellKnownSymbolMemberOf(value,
 * protocol) === false`.
 *
 * ## Why the static answer is unsound for a plain object, and only for one
 *
 * That proof is exact for a primitive (`"a,b".split(",")` — a string can never
 * grow an own `@@split`) and for a builtin (`"abc".match(/b/)` — the RegExp
 * lane IS the protocol implementation). It is NOT a proof for an ordinary
 * object: `wellKnownSymbolMemberOf` reads the *declared* type, and the whole
 * idiom the spec step exists for installs the method **after** the object is
 * created, where no declared type can see it:
 *
 * ```js
 * var regexp = {};                       // declared type: `{}`
 * regexp[Symbol.search] = function () { … };
 * "O".search(regexp);                    // must call it
 * ```
 *
 * Before this module the compiler read `{}`, found no `@@search`, and took the
 * step-3 lane — `RegExpCreate(ToString(regexp))`, i.e. the pattern
 * `"[object Object]"`. That is a **silent wrong answer** wearing a runtime
 * error's clothes: the four `cstm-*-invocation` rows reported
 * `TypeError: Unsupported dynamic regular expression pattern`, which reads
 * like a missing engine feature and is actually the compiler having
 * stringified a value it was required to call.
 *
 * So this module re-opens step 2 for exactly one shape — `typeFactOf(v).kind
 * === "object"` — and answers it at RUNTIME. Everything else keeps the static
 * answer and the existing lowering byte-for-byte: a string / number / boolean
 * / symbol / array / function / builtin / `any` search value never reaches
 * here. That is the narrowest gate that covers the unsound case, and it is the
 * reason the fast paths (`"abc".search(/b/)`, `"a,b".split(",")`) are
 * untouched.
 *
 * ## The emitted shape
 *
 * ```
 *   V := <search value>                          ; externref, evaluated ONCE
 *   M := __extern_get(V, __box_symbol(<id>))     ; step 2.a, an ordinary [[Get]]
 *   if (M is neither null nor undefined) {       ; GetMethod §7.3.10 step 3
 *      if (!__typeof_function(M)) throw TypeError
 *      args := __objvec_new(); push(O); [push(extra)]
 *      result := __apply_closure(M, V, args)     ; step 2.b
 *   } else {
 *      result := <the existing step-3 lowering>  ; boxed to externref
 *   }
 * ```
 *
 * `__extern_get` is a real `[[Get]]`, which is what makes the four
 * `cstm-*-get-err` rows work: a `@@split` installed as an accessor by
 * `Object.defineProperty` fires its getter here, and an abrupt getter
 * propagates instead of being skipped.
 *
 * ## Why both arms are re-emitted from the same AST, and what that costs
 *
 * The fallback arm is the caller's own lowering, re-entered through a closure.
 * It re-evaluates the receiver and the search-value expressions, so the two
 * arms together would run a side effect twice at COMPILE time even though only
 * one arm runs at RUNTIME — and the probe has already evaluated the search
 * value before the branch. Rather than plumb a "pre-evaluated operand"
 * override through four independent lowerings, the gate requires both operands
 * to be **re-evaluable without observable effect**: an identifier, `this`, or a
 * literal. That is what the corpus uses (`"O".search(regexp)`), it is checked
 * rather than assumed, and a computed operand simply keeps the previous
 * behaviour.
 *
 * Known residuals, deliberately out of scope here and recorded in #6651:
 * - `String.prototype.split.call(nonStringable, splitter)` — the reflective
 *   closure lane, whose receiver must NOT be `ToString`ed before step 2.
 *   `emitReceiver` has already coerced by the time this module sees it.
 * - `RegExp.prototype[@@search] = f` — overriding the protocol on the *builtin*
 *   prototype, which needs the step-3 RegExp lane itself to dispatch through a
 *   reified, replaceable method object.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { buildThrowJsErrorInstrs, noJsHost } from "./js-errors.js";
import { getWellKnownSymbolId } from "./literals.js";
import { ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { compileExpression, ensureLateImport } from "./shared.js";
import { coerceType } from "./type-coercion.js";

const EXTERNREF: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };

/** The four §22.1.3 methods whose step 2 this module answers. */
const PROTOCOL_METHODS: ReadonlySet<string> = new Set(["match", "replace", "search", "split"]);

/**
 * The second argument each method forwards RAW (uncoerced) to the protocol
 * method: `split`'s `limit` and `replace`'s `replaceValue`. `match`/`search`
 * pass only `«O»`. `cstm-split-invocation` asserts `args[1] === 'limit'` — the
 * string, not `ToUint32` of it — so this argument must not be coerced here.
 */
function extraArgIndex(method: string): number | undefined {
  return method === "split" || method === "replace" ? 1 : undefined;
}

/**
 * Re-evaluable without observable effect? Both operands are emitted into BOTH
 * arms of the branch (see the module note), so anything that could run user
 * code — a call, a property access with a possible getter, an assignment —
 * declines the whole probe.
 */
function isReEvaluable(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return true;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (ts.isNumericLiteral(node)) return true;
  if (ts.isParenthesizedExpression(node)) return isReEvaluable(node.expression);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return isReEvaluable(node.expression);
  return false;
}

interface ProtocolDeps {
  externGet: number;
  boxSymbol: number;
  externIsUndefined: number;
  typeofFunction: number;
  objVecNew: number;
  objVecPush: number;
  applyClosure: number;
}

/**
 * Register every native the probe calls and resolve the indices in ONE batch,
 * before any index is read — a later registration shifts indices already
 * resolved (the #2043 late-shift class).
 */
function prepareDeps(ctx: CodegenContext): ProtocolDeps | undefined {
  ensureObjectRuntime(ctx);
  const applyClosure = reserveApplyClosure(ctx);
  ensureLateImport(ctx, "__extern_get", [EXTERNREF, EXTERNREF], [EXTERNREF]);
  ensureLateImport(ctx, "__extern_is_undefined", [EXTERNREF], [I32]);
  ensureLateImport(ctx, "__box_symbol", [I32], [EXTERNREF]);
  const get = (name: string): number | undefined => ctx.funcMap.get(name);
  const externGet = get("__extern_get");
  const boxSymbol = get("__box_symbol");
  const externIsUndefined = get("__extern_is_undefined");
  const typeofFunction = get("__typeof_function");
  const objVecNew = get("__objvec_new");
  const objVecPush = get("__objvec_push");
  if (
    externGet === undefined ||
    boxSymbol === undefined ||
    externIsUndefined === undefined ||
    typeofFunction === undefined ||
    objVecNew === undefined ||
    objVecPush === undefined
  ) {
    return undefined;
  }
  return { externGet, boxSymbol, externIsUndefined, typeofFunction, objVecNew, objVecPush, applyClosure };
}

/**
 * Emit `instrs` by recording them through the REAL function context and
 * splicing them back out. Every lowering in this subsystem registers locals,
 * late imports and string constants as a side effect of emission, so an arm
 * cannot be built in a detached buffer — it has to be emitted where those
 * registrations land and then moved into the branch.
 */
function captureInto(fctx: FunctionContext, emit: () => void): Instr[] {
  const start = fctx.body.length;
  emit();
  return fctx.body.splice(start);
}

/**
 * §22.1.3 step 2 for `String.prototype.{match,replace,search,split}` with an
 * ORDINARY-OBJECT search value, in a no-JS-host target.
 *
 * Returns `undefined` when this is not the right arm (the overwhelmingly
 * common case), so the caller proceeds with its existing dispatch unchanged.
 * Otherwise returns `externref`: the protocol method's own return value, or —
 * when the object carries no such method at runtime — the caller's step-3
 * result boxed.
 */
export function tryCompileStringSymbolProtocolDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.CallExpression,
  propAccess: ts.PropertyAccessExpression,
  method: string,
  /** The caller's own step-3 lowering, re-entered in the not-found arm. */
  emitFallback: () => ValType | null,
): ValType | null | undefined {
  if (!noJsHost(ctx) || !PROTOCOL_METHODS.has(method)) return undefined;
  if (expr.arguments.length < 1) return undefined;
  const searchExpr = expr.arguments[0]!;
  const receiverExpr = propAccess.expression;

  // The unsound-static-answer shapes (see the module note). A builtin
  // (RegExp), an array, a function, a primitive or an unresolvable `any` all
  // keep the existing decision.
  //
  // BOTH `object` and `class` are admitted, and the second one is not
  // optional: `var regexp = {}` in a **JS** source — which is every test262
  // row — gets TypeScript's expando inference, so its anonymous type carries
  // the VARIABLE's name as its symbol name, and `factOfType` reports
  // `{kind:"class", name:"regexp"}` rather than `{kind:"object"}`. Gating on
  // `object` alone therefore declined the exact corpus this exists for: the
  // probe compiled and fired under a `.ts` harness and never fired under the
  // runner (measured 2026-09-20 — the focused 17-row slice was byte-identical
  // before and after). A genuine class instance can also grow a `@@split` at
  // runtime, so admitting it is spec-correct too; when the probe finds
  // nothing it falls through to the identical lowering it would have used.
  const searchFact = ctx.oracle.typeFactOf(searchExpr).kind;
  if (searchFact !== "object" && searchFact !== "class") return undefined;
  if (!isReEvaluable(searchExpr) || !isReEvaluable(receiverExpr)) return undefined;

  const symbolId = getWellKnownSymbolId(method);
  if (symbolId === undefined) return undefined;
  const deps = prepareDeps(ctx);
  if (deps === undefined) return undefined;

  const extraIdx = extraArgIndex(method);
  const extraExpr = extraIdx === undefined ? undefined : expr.arguments[extraIdx];
  if (extraExpr !== undefined && !isReEvaluable(extraExpr)) return undefined;

  // --- step 2.a: V, then an ordinary [[Get]] of the well-known symbol key ---
  const vLocal = allocLocal(fctx, `__sp_v_${fctx.locals.length}`, EXTERNREF);
  const searchType = compileExpression(ctx, fctx, searchExpr, EXTERNREF);
  if (searchType === null) return null;
  if (searchType.kind !== "externref") coerceType(ctx, fctx, searchType, EXTERNREF);
  fctx.body.push({ op: "local.set", index: vLocal });

  const mLocal = allocLocal(fctx, `__sp_m_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "local.get", index: vLocal });
  fctx.body.push({ op: "i32.const", value: symbolId });
  fctx.body.push({ op: "call", funcIdx: deps.boxSymbol });
  fctx.body.push({ op: "call", funcIdx: deps.externGet });
  fctx.body.push({ op: "local.set", index: mLocal });

  // --- step 2.b: Call(m, V, «O[, extra]») ---
  const callArm = captureInto(fctx, () => {
    // GetMethod §7.3.10 step 4: present but not callable is a TypeError.
    fctx.body.push({ op: "local.get", index: mLocal });
    fctx.body.push({ op: "call", funcIdx: deps.typeofFunction });
    fctx.body.push({ op: "i32.eqz" });
    fctx.body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "TypeError", `${method} protocol method is not a function`, { flush: fctx }),
      else: [],
    });
    const argsLocal = allocLocal(fctx, `__sp_args_${fctx.locals.length}`, EXTERNREF);
    fctx.body.push({ op: "call", funcIdx: deps.objVecNew });
    fctx.body.push({ op: "local.set", index: argsLocal });
    fctx.body.push({ op: "local.get", index: argsLocal });
    const recvType = compileExpression(ctx, fctx, receiverExpr, EXTERNREF);
    if (recvType !== null && recvType.kind !== "externref") coerceType(ctx, fctx, recvType, EXTERNREF);
    fctx.body.push({ op: "call", funcIdx: deps.objVecPush });
    if (extraExpr !== undefined) {
      fctx.body.push({ op: "local.get", index: argsLocal });
      const extraType = compileExpression(ctx, fctx, extraExpr, EXTERNREF);
      if (extraType !== null && extraType.kind !== "externref") coerceType(ctx, fctx, extraType, EXTERNREF);
      fctx.body.push({ op: "call", funcIdx: deps.objVecPush });
    }
    fctx.body.push({ op: "local.get", index: mLocal });
    fctx.body.push({ op: "local.get", index: vLocal });
    fctx.body.push({ op: "local.get", index: argsLocal });
    fctx.body.push({ op: "call", funcIdx: deps.applyClosure });
  });

  // --- step 3 onward: the caller's own lowering, boxed to the shared type ---
  let fallbackFailed = false;
  const fallbackArm = captureInto(fctx, () => {
    const t = emitFallback();
    if (t === null) {
      fallbackFailed = true;
      return;
    }
    if (t.kind !== "externref") coerceType(ctx, fctx, t, EXTERNREF);
  });
  if (fallbackFailed) {
    // The fallback reported its own diagnostic; keep it rather than swapping a
    // documented refusal for a half-emitted branch.
    for (const instr of fallbackArm) fctx.body.push(instr);
    return null;
  }

  // GetMethod §7.3.10 step 3: BOTH `null` and `undefined` mean "absent".
  fctx.body.push({ op: "local.get", index: mLocal });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({ op: "local.get", index: mLocal });
  fctx.body.push({ op: "call", funcIdx: deps.externIsUndefined });
  fctx.body.push({ op: "i32.or" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: EXTERNREF },
    then: fallbackArm,
    else: callArm,
  });
  return EXTERNREF;
}
