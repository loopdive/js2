// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4406 Phase 3) The PARAMETER half of the return-type unboxing ABI.
 *
 * ## What this closes
 *
 * Phase 1 typed the callee's RESULT and Phase 2 typed the logical merge that
 * consumes it. Neither can see the other end of a call: an argument. The
 * producer census in the issue's §1.4 ranks argument position as the largest
 * surviving `__box_boolean` producer (`local.get` next 29 %, `call __dc_*` next
 * 15 %, `i32.const` next 5 %), and the shape is the one `typed-this.ts` already
 * documents — `this.parseExprOp(…, false, false, forInit)` pushes
 * `i32.const 0; call $__box_boolean` twice because the trampoline declares
 * `externref` there.
 *
 * This module proves, whole-program, that a given parameter SLOT of a given
 * function NAME only ever receives booleans, so the twin and its trampoline can
 * declare a boolean-branded `i32` and the box disappears at every call site.
 *
 * ## Why the proof has a shape the RETURN half did not need
 *
 * A refined RESULT is IMPOSED on the callee: every `return` coerces to it, so an
 * imprecise fixpoint costs performance, not correctness. A refined PARAMETER is
 * imposed on the CALLERS, and an unproven caller does not coerce — it simply
 * passes a value the body will then read as a boolean. So the verdict here is
 * two-sided:
 *
 * - **call side** — EVERY syntactic `m(…)` / `<anything>.m(…)` / `new m(…)` in
 *   the program supplies an argument at that slot and that argument is
 *   provably boolean. Over-collecting receivers (an unrelated `array.find(cb)`
 *   is indexed under `find` too) can only make the verdict more conservative,
 *   never wrong — the opposite of the RETURN verdict, where `callName` has to
 *   stay narrow to avoid conflating unrelated symbols.
 * - **declaration side** — the slot is a plain identifier with no initializer
 *   and no `...rest`, the body never assigns it, and the body never reads
 *   `arguments` (whose vec is observable and must carry the raw value).
 *
 * ## What makes the un-enumerable callers safe
 *
 * `o.m` can escape as a value (`arr.map(o.m)`, `o.m.call(x, y)`,
 * `o["m"](y)`) and reach the method with anything at all. None of those can
 * reach the TWIN: devirtualization (`tryEmitDirectTwinCall`) fires only on a
 * syntactic `recv.m(args)` property access, and the twin's other entry — the
 * `ref.test` shim prepended to the generic body — is SUPPRESSED whenever any
 * parameter is refined (see `closures.ts`). The generic body keeps its
 * `externref` parameters and stays the single entry for every dynamic caller.
 * That suppression is what reduces the proof obligation to the enumerable call
 * sites; its cost is one unmonomorphized dynamic entry per refined method,
 * which is measured in the PR rather than assumed.
 *
 * ## Module shape
 *
 * A LEAF — `ts-api` + types + `ret-unbox-abi`, nothing else — so the analysis
 * can be read by `struct-field-boolean-brand.ts` (which owns the one traversal
 * that already indexes the facts) while the emission decision stays in
 * `typed-this.ts` beside `refinedTwinReturnType`.
 */
import { forEachChild, ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { retUnboxAbiEnabled } from "./ret-unbox-abi.js";

/**
 * Is the PARAMETER half of the ABI on? It rides the same
 * `JS2WASM_RET_UNBOX_ABI` variable as Phases 1 and 2 on purpose: the halves
 * compose (a boolean-returning callee is exactly what a boolean argument
 * usually comes from), so a lane that measures one without the other measures a
 * shape that will never ship. Unset ⇒ OFF, and every off-token of the shared
 * `optInFlagEnabled` rule disables it too.
 */
export function paramUnboxAbiEnabled(): boolean {
  return retUnboxAbiEnabled();
}

/**
 * Companion POISON switch, deliberately SEPARATE from
 * `JS2WASM_RET_UNBOX_ABI_POISON`. With this and the main flag on, every
 * refined boolean ARGUMENT is inverted where it is pushed. A workload whose
 * answer is unchanged under poison never executed a refined parameter — the
 * only way to tell a real null from a path that never ran. It needs its own
 * variable because Phase 1's poison already breaks the acorn parse on its own,
 * so a shared switch could not attribute the break to this half. Inert unless
 * the main flag is on.
 */
export function paramUnboxAbiPoisoned(): boolean {
  return paramUnboxAbiEnabled() && process.env.JS2WASM_PARAM_UNBOX_ABI_POISON === "1";
}

/** `runtimeParameters` (closures.ts), duplicated to keep this module acyclic. */
function runtimeParams(fn: ts.FunctionLikeDeclaration): readonly ts.ParameterDeclaration[] {
  const ps = fn.parameters;
  const first = ps.length > 0 ? ps[0] : undefined;
  return first && ts.isIdentifier(first.name) && first.name.escapedText === "this" ? ps.slice(1) : ps;
}

/** One walk per body: which identifier names it WRITES, and whether it reads `arguments`. */
interface BodyEffects {
  readonly writes: ReadonlySet<string>;
  readonly usesArguments: boolean;
}

function unwrapTarget(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
  return current;
}

/**
 * Collect assignment targets by identifier TEXT, descending into nested
 * functions on purpose. Text matching over-approximates (a shadowing inner
 * `var noIn` counts as a write to the outer one), and over-approximating writes
 * is the conservative direction: it only withdraws slots.
 */
function bodyEffectsOf(fn: ts.FunctionLikeDeclaration): BodyEffects {
  const writes = new Set<string>();
  let usesArguments = false;
  const noteTarget = (target: ts.Node): void => {
    const t = unwrapTarget(target as ts.Expression);
    if (ts.isIdentifier(t)) writes.add(t.text);
    // A destructuring target contributes every identifier it binds; the walk
    // below reaches them as ordinary identifiers, so bind the whole pattern.
    else if (ts.isObjectLiteralExpression(t) || ts.isArrayLiteralExpression(t)) {
      forEachChild(t, (n) => {
        if (ts.isIdentifier(n)) writes.add(n.text);
      });
    }
  };
  const walk = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && n.text === "arguments") usesArguments = true;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment) {
      if (n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) noteTarget(n.left);
    } else if (
      (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) &&
      (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      noteTarget(n.operand);
    } else if ((ts.isForInStatement(n) || ts.isForOfStatement(n)) && !ts.isVariableDeclarationList(n.initializer)) {
      noteTarget(n.initializer);
    }
    forEachChild(n, walk);
  };
  if (fn.body) forEachChild(fn.body, walk);
  return { writes, usesArguments };
}

/** Is slot `k` of this declaration structurally refinable? */
function slotIsAdmissible(fn: ts.FunctionLikeDeclaration, k: number, effects: BodyEffects): boolean {
  if (effects.usesArguments) return false;
  const ps = runtimeParams(fn);
  const p = ps[k];
  if (p === undefined) return false;
  if (p.dotDotDotToken !== undefined || p.initializer !== undefined) return false;
  if (!ts.isIdentifier(p.name)) return false;
  // A later `...rest` slot means `arguments`-shaped forwarding of everything
  // after it; refuse the whole declaration rather than reason about the split.
  if (ps.some((q) => q.dotDotDotToken !== undefined)) return false;
  return !effects.writes.has(p.name.text);
}

const effectsCache = new WeakMap<ts.FunctionLikeDeclaration, BodyEffects>();

/**
 * Re-check the DECLARATION side on the exact function about to be refined.
 *
 * {@link inferBooleanParamSlots} checks every declaration its index knows
 * about, but that index is keyed by `functionBindingName`, which cannot name
 * every function-like (an anonymous expression handed straight to a call, for
 * instance). The call-side half of the verdict does not depend on which
 * declaration is indexed — it enumerates call sites — but the declaration-side
 * half does, so the consumer re-asks it about the function it is actually
 * minting rather than trusting the index to be complete.
 */
export function paramSlotRefinableOn(fn: ts.FunctionLikeDeclaration, slot: number): boolean {
  let effects = effectsCache.get(fn);
  if (effects === undefined) {
    effects = bodyEffectsOf(fn);
    effectsCache.set(fn, effects);
  }
  return slotIsAdmissible(fn, slot, effects);
}

/** The facts {@link inferBooleanParamSlots} needs, kept narrow so this stays a leaf. */
export interface BooleanParamSlotInputs {
  /** Every function-like indexed by its binding name (`pp.eat = function …` ⇒ `eat`). */
  readonly functionsByName: ReadonlyMap<string, readonly ts.FunctionLikeDeclaration[]>;
  /**
   * EVERY syntactic call/new argument list keyed by callee name — the BROAD
   * map, not the `this.m()`-only one the return verdict uses.
   */
  readonly callArgsByName: ReadonlyMap<string, readonly (readonly ts.Expression[])[]>;
  /** "Does this expression provably produce a boolean?" — the caller's oracle-backed rule. */
  readonly isBoolean: (expr: ts.Expression) => boolean;
}

/**
 * Whole-program verdict: for each function NAME, the parameter slots that only
 * ever receive booleans. A name with no visible call site yields no slots —
 * there is nothing to save and nothing to check against.
 */
export function inferBooleanParamSlots(inputs: BooleanParamSlotInputs): Map<string, Set<number>> {
  const verdict = new Map<string, Set<number>>();
  for (const [name, decls] of inputs.functionsByName) {
    const calls = inputs.callArgsByName.get(name);
    if (calls === undefined || calls.length === 0 || decls.length === 0) continue;
    // A spread argument hides both the count and the values behind it.
    if (calls.some((args) => args.some((a) => ts.isSpreadElement(a)))) continue;
    let width = Number.POSITIVE_INFINITY;
    for (const args of calls) width = Math.min(width, args.length);
    for (const decl of decls) width = Math.min(width, runtimeParams(decl).length);
    if (!Number.isFinite(width) || width <= 0) continue;
    const effects = decls.map((decl) => bodyEffectsOf(decl));
    const slots = new Set<number>();
    for (let k = 0; k < width; k++) {
      if (!decls.every((decl, i) => slotIsAdmissible(decl, k, effects[i]!))) continue;
      if (!calls.every((args) => inputs.isBoolean(args[k]!))) continue;
      slots.add(k);
    }
    if (slots.size > 0) verdict.set(name, slots);
  }
  return verdict;
}

/**
 * (Phase 3) The parameter funnel, printed at finalize when
 * `JS2WASM_PARAM_UNBOX_STATS=1`.
 *
 * Reports `names → slots → refined twins`, because the top line cannot
 * distinguish "the analysis proved nothing" from "it proved plenty and no
 * proven name reaches a twin" — and those call for opposite next moves.
 *
 * House rule, same as `ret-unbox-abi.ts` / `alloc-census.ts`: the caller makes
 * this call as a STATEMENT, never as part of a condition, so no emission
 * decision can depend on whether the census is enabled.
 */
/**
 * How many generic bodies lost their forwarding shim to a refined parameter —
 * MINT events, not distinct methods: an arrow lifted twice (which the closure
 * lifter does routinely) suppresses two shims for one recorded twin.
 * This is the whole cost of the parameter half — each one is a prototype method
 * whose DYNAMIC callers no longer reach the monomorphized twin — so it is
 * counted rather than argued about. Module-level like `directCallStats`,
 * because the shim decision is made deep inside `compileArrowAsClosure` where
 * threading a context field would buy nothing.
 */
let shimsSuppressed = 0;

/** Statement-only; see the house rule on {@link noteParamUnboxStats}. */
export function noteShimSuppressed(): void {
  shimsSuppressed++;
}

export function noteParamUnboxStats(ctx: CodegenContext): void {
  if (process.env.JS2WASM_PARAM_UNBOX_STATS !== "1") return;
  const slots = ctx.booleanParamSlots ?? new Map<string, ReadonlySet<number>>();
  let slotCount = 0;
  for (const set of slots.values()) slotCount += set.size;
  let refinedTwins = 0;
  let refinedSlots = 0;
  for (const twin of ctx.directCallTwins?.values() ?? []) {
    // Slot 0 of a twin is the receiver, never a user parameter.
    const n = twin.params.slice(1).filter((p) => p.kind === "i32" && p.boolean === true).length;
    if (n > 0) refinedTwins++;
    refinedSlots += n;
  }
  const rows = [...slots]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, set]) => `${name}[${[...set].sort((x, y) => x - y).join(",")}]`);
  process.stderr.write(
    `[param-unbox] flag=${paramUnboxAbiEnabled() ? "on" : "off"} provenNames=${slots.size} ` +
      `provenSlots=${slotCount} refinedTwins=${refinedTwins} refinedTwinSlots=${refinedSlots} ` +
      `shimsSuppressed=${shimsSuppressed}\n` +
      `[param-unbox] slots: ${rows.join(" ")}\n`,
  );
}
