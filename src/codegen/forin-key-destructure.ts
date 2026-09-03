// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5271 step 4, C2) Array-pattern heads of a `for…in` loop.
 *
 * §14.7.5.5 ForIn/OfBodyEvaluation hands the enumerated PROPERTY KEY — always a
 * String — to the head's BindingInitialization. `let [x] in obj` therefore
 * destructures the key STRING through its iterator, binding `x` to the key's
 * first code unit.
 *
 * The head lowering routed the key straight into
 * `compileExternrefArrayDestructuringDecl`, whose externref lane has no
 * `$AnyString` arm: every element bound `null` and per-element DEFAULTS never
 * fired (so `probeDecl` stayed `undefined` and the sibling rows called `null`).
 *
 * The fix reuses two proven pieces instead of adding a third string-iteration
 * lowering: `__str_to_char_vec` (#3100 S4 — the per-code-unit `string[]` vec the
 * string-rest lowering already builds) followed by the ordinary typed-vec
 * `destructureParamArray`. Elisions, per-element defaults, nested patterns, rest
 * elements and duplicate names (`var [x, x]` → last wins) then all behave
 * exactly as they do for any other array destructure, because they ARE that
 * code path.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureStrToCharVecHelper } from "./native-strings.js";
import { destructureParamArray, type BindingKind } from "./destructuring-params.js";
import { syncDestructuredLocalsToGlobals } from "./statements/destructuring.js";

/**
 * Emit the head-pattern binding for one `for…in` iteration whose key lives in
 * `keyLocal` (an `externref` holding the enumerated key string).
 *
 * Returns `false` when the native string substrate is unavailable, so the
 * caller keeps its previous lowering.
 */
export function emitForInKeyArrayDestructure(
  ctx: CodegenContext,
  fctx: FunctionContext,
  keyLocal: number,
  pattern: ts.ArrayBindingPattern,
  bindingKind: BindingKind,
): boolean {
  if (ctx.anyStrTypeIdx < 0) return false;
  const helper = ensureStrToCharVecHelper(ctx);
  const vecType: ValType = { kind: "ref_null", typeIdx: helper.vecTypeIdx };
  const vecLocal = allocLocal(fctx, `__forin_key_chars_${fctx.locals.length}`, vecType);

  // key(externref) → $AnyString → char vec. The enumerator only ever yields
  // string keys, so the cast is total; `ref.cast` is the same discriminator the
  // string helpers use everywhere else.
  const instrs: Instr[] = [
    { op: "local.get", index: keyLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "call", funcIdx: helper.funcIdx },
    { op: "local.set", index: vecLocal },
  ];
  for (const instr of instrs) fctx.body.push(instr);

  destructureParamArray(ctx, fctx, vecLocal, pattern, vecType, {
    mode: "decl",
    bindingKind,
  });
  // The helper writes locals only; a `var` head at module level ALSO owns a
  // module global (`for (var [x, x] in …)` reads `x` back through it). A
  // `let`/`const` head must NOT sync: its binding is fresh per iteration and a
  // same-spelled top-level `let x` is a DIFFERENT binding, which a sync would
  // clobber (`for-in/scope-body-lex-open`'s `probeBefore()`).
  if (bindingKind === "var") syncDestructuredLocalsToGlobals(ctx, fctx, pattern);
  return true;
}
