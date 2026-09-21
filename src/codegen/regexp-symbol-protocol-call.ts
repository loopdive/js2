// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B3) The **DIRECT** spelling `re[Symbol.search](s)` /
 * `re[Symbol.match](s)`, routed through the reified
 * `RegExp.prototype[@@<id>]` method value instead of the static native core.
 *
 * ## The defect this closes
 *
 * Slice B2 made `RegExp.prototype[@@search]` / `[@@match]` observable:
 * §22.2.7.1 RegExpExec reads `exec` through a real `[[Get]]`, calls a callable
 * override, and only falls back to the builtin matcher when `exec` is not
 * callable. That body lives in the reflective closure, so the
 * `RegExp.prototype[Symbol.search].call(rx, s)` spelling got it.
 *
 * The DIRECT spelling did not. `tryCompileStandaloneRegExpSymbolCall` answers
 * `re[Symbol.search](s)` from the static native core — the same engine
 * `"abc".search(/b/)` uses — which never consults `exec` at all. So eight rows
 * stayed red **even though the substrate that answers them already existed**:
 * `@@match/exec-{err,invocation,return-type-invalid,return-type-valid}` and
 * `@@search/{coerce-string,coerce-string-err,set-lastindex-init-samevalue,
 * set-lastindex-restore-samevalue}`.
 *
 * ## Why this is a ROUTE and not a second implementation
 *
 * The value this module calls is the identity-stable singleton every other
 * reader of `RegExp.prototype[Symbol.search]` already sees
 * (`resolveStandaloneProtoMemberValueClosure` → `ensureStandaloneNativeMethodClosure`,
 * the #2984 three-tier resolver). The call is `__apply_closure(m, rx, «S»)`, the
 * same bridge `Reflect.apply` and `fn.apply` use — measured working against that
 * exact closure before this module existed (probe: `Reflect.apply(
 * RegExp.prototype[Symbol.search], /ring/, ["a string"]) === 4`, standalone).
 * There is therefore exactly ONE §22.2.6.8/.12 body in the compiler, and this
 * spelling reaches it rather than re-deriving it.
 *
 * ## The gate, and why it is a WHOLE-FILE predicate
 *
 * Routing through the closure changes the call's result type to `externref`
 * (the closure ABI's carrier) where the static core answers `f64` / a native
 * match vector, and it costs a dynamic call where the core emits a direct one.
 * Neither is acceptable for the fast lane, so the route is taken only when the
 * program can actually OBSERVE the protocol:
 *
 *  - the file mentions `exec` in a position that could install or read an
 *    `exec` property (a `.exec` member, an `"exec"` string key, an `exec`
 *    member declaration), or
 *  - the file touches `RegExp.prototype` at all, or
 *  - the call's own argument is not statically string-like, in which case the
 *    static core DECLINES anyway (it requires a string-like operand) and the
 *    previous answer was a compile error, not a fast path.
 *
 * A whole-file predicate is deliberately coarse: `exec` appearing anywhere in
 * the file is enough. The direction of the coarseness is the safe one — a file
 * that merely CALLS `re.exec(s)` takes the observable route and gets the same
 * answer through it (the `[[Get]]` finds no own `exec`, RegExpExec step 5 runs
 * the builtin), while a file with no `exec` token and no `RegExp.prototype`
 * keeps the static core byte-for-byte. `"abc".search(/b/)` is not even in this
 * lowering's reach (it is the `String.prototype` lane), and the direct-spelling
 * fast path `re[Symbol.search]("abc")` in an `exec`-free file is unchanged —
 * both verified by compiled-binary sha256 comparison.
 */
import { ts } from "../ts-api.js";
import type { ValType } from "../ir/types.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { getBuiltinBrand } from "./native-proto.js";
import { resolveStandaloneProtoMemberValueClosure } from "./native-proto-value-read.js";
import { ensureObjVecBuilders, ensureObjectRuntime, reserveApplyClosure } from "./object-runtime.js";
import { compileExpression } from "./shared.js";
import { coerceType } from "./type-coercion.js";

const EXTERNREF: ValType = { kind: "externref" };

/** Per-source-file answer of {@link fileObservesRegExpExecProtocol}. */
const observesByFile = new WeakMap<ts.SourceFile, boolean>();

/**
 * Does this SOURCE FILE observe the RegExp `exec` protocol anywhere?
 *
 * Walked once per file and memoised. See the module header for why the answer
 * is per-FILE rather than per-call: the cheap, provable property is "this
 * program never mentions `exec` and never touches `RegExp.prototype`", and that
 * is exactly the property that keeps the static lane byte-identical.
 */
export function fileObservesRegExpExecProtocol(node: ts.Node): boolean {
  const sf = node.getSourceFile();
  const cached = observesByFile.get(sf);
  if (cached !== undefined) return cached;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(n)) {
      if (n.name.text === "exec") found = true;
      // `RegExp.prototype` in any position — a read, a write, a `.call`
      // receiver, an argument to `Object.defineProperty`.
      else if (n.name.text === "prototype" && ts.isIdentifier(n.expression) && n.expression.text === "RegExp") {
        found = true;
      }
    } else if (ts.isStringLiteralLike(n)) {
      if (n.text === "exec") found = true;
    } else if (
      (ts.isPropertyAssignment(n) || ts.isMethodDeclaration(n) || ts.isPropertyDeclaration(n)) &&
      (ts.isIdentifier(n.name) || ts.isStringLiteralLike(n.name)) &&
      n.name.text === "exec"
    ) {
      found = true;
    }
    if (!found) ts.forEachChild(n, visit);
  };
  visit(sf);
  observesByFile.set(sf, found);
  return found;
}

/**
 * Emit `re[Symbol.<match|search>](arg)` as
 * `__apply_closure(RegExp.prototype[@@<id>], re, «arg»)`.
 *
 * Returns `undefined` when the reified member is unavailable (no glue / a
 * refusing body), in which case the caller keeps its existing lowering; the
 * caller owns the gate (see {@link fileObservesRegExpExecProtocol}).
 *
 * Evaluation order matches §13.3.6: the receiver first, then the argument. The
 * method value itself is a compile-time singleton read with no observable
 * effect, so emitting it last is not a reordering.
 */
export function emitRegExpSymbolProtocolApply(
  ctx: CodegenContext,
  fctx: FunctionContext,
  regexExpr: ts.Expression,
  argExpr: ts.Expression,
  symbolId: number,
): ValType | undefined {
  const brand = getBuiltinBrand(ctx, "RegExp");
  if (brand === undefined) return undefined;
  const resolved = resolveStandaloneProtoMemberValueClosure(ctx, brand, "RegExp", `@@${symbolId}`);
  if (!resolved || resolved.kind !== "method") return undefined;

  // Every native this emits is registered BEFORE a single index is read: the
  // closure minted above may register late imports, and a late import shifts
  // every defined-function index at or above it (the #2043 late-shift class).
  ensureObjectRuntime(ctx);
  const applyClosure = reserveApplyClosure(ctx);
  const { newIdx: objVecNew, pushIdx: objVecPush } = ensureObjVecBuilders(ctx);

  const rxLocal = allocLocal(fctx, `__rxs_recv_${fctx.locals.length}`, EXTERNREF);
  const rxType = compileExpression(ctx, fctx, regexExpr, EXTERNREF);
  if (rxType === null) return undefined;
  if (rxType.kind !== "externref") coerceType(ctx, fctx, rxType, EXTERNREF);
  fctx.body.push({ op: "local.set", index: rxLocal });

  // «S» — passed RAW. §22.2.6.8/.12 step 3 does the `ToString`, inside the
  // method body, exactly once (`coerce-string` passes an object whose
  // `toString` must run there and nowhere else).
  const argsLocal = allocLocal(fctx, `__rxs_args_${fctx.locals.length}`, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: objVecNew });
  fctx.body.push({ op: "local.set", index: argsLocal });
  fctx.body.push({ op: "local.get", index: argsLocal });
  const argType = compileExpression(ctx, fctx, argExpr, EXTERNREF);
  if (argType === null) return undefined;
  if (argType.kind !== "externref") coerceType(ctx, fctx, argType, EXTERNREF);
  fctx.body.push({ op: "call", funcIdx: objVecPush });

  fctx.body.push(...pushBuiltinFnSingletonValueInstrs(ctx, resolved.closure));
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "local.get", index: rxLocal });
  fctx.body.push({ op: "local.get", index: argsLocal });
  fctx.body.push({ op: "call", funcIdx: applyClosure });
  return EXTERNREF;
}
