// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) IR-level inliner for USER code — `JS2WASM_IR_INLINE`, **default `on`**
 * since the tuned-set flip (see `src/perf-flags.ts`). `=0` / `off` is the revert.
 *
 * ## Why this exists at all
 *
 * Binaryen's flexible inlining applies only to functions its own help text calls
 * "lightweight (no loops or function calls)". Every function acorn compiles to
 * contains a call or a loop, so **no size budget reaches them at any value** —
 * measured on this module after `-O4`: exactly ONE of 1,321 functions is
 * eligible, and `-fimfs=60` cost +11.3 % size while moving the target functions
 * by zero. The decision in #4157 entries (18)/(19) is therefore that the
 * inlining COST MODEL moves in-tree and `wasm-opt` handles only what we decline.
 *
 * ## The cost model (entry 19), and what each input is
 *
 * 1. **Call-site frequency from loop nesting depth.** `weight(site) = 10^depth`,
 *    the standard AOT substitute for V8's runtime call counts (LLVM's
 *    `BlockFrequencyInfo` uses ~10× per loop level). Propagated one step across
 *    the call graph so a callee of a hot function inherits hotness.
 *
 *    **Why this is admissible where #3927 §7's frequency ranking was not.**
 *    #3927 had to abandon frequency-based FIELD ranking because observed
 *    instance counts are a property of the CORPUS: a compiler that used them
 *    would be input-specific, and six corpus-independent proxies all scored
 *    ≤ ~25 % against ground truth. Loop nesting depth is not that. It is read
 *    off the SOURCE BEING COMPILED, so it is a property of the PROGRAM and
 *    stays valid for every input that program is ever run on. A reviewer who
 *    knows #3927 will reach for that objection first; it does not apply.
 *
 * 2. **Specialisation delta, not callee size.** The admission question is how
 *    big the inlined result is AFTER the site's facts fold — not how big the
 *    callee is in isolation. `specialisedSize` clones the callee, substitutes
 *    call-site-constant arguments into never-reassigned params, folds the
 *    branches that become constant, and measures THAT. This is the case a
 *    generic size heuristic structurally cannot see, because the facts are gone
 *    by the time `wasm-opt` runs.
 *
 * 3. **Adapters always.** The `__dc_*` dispatch trampolines are ~25 functions
 *    carrying ~4 % of runtime in pure self-time. The two native
 *    number-to-string carrier thunks and three native-Map carrier adapters
 *    likewise contain only representation conversions the direct backend
 *    emits inline. An adapter's whole body is overhead by construction, so no
 *    size heuristic gets a vote.
 *
 * 4. **Cold by construction never, and not charged to the caller.** The
 *    `__new_TypeError` / `__throw*` guard paths are never inlined, AND their
 *    instruction mass is subtracted from a callee's `effectiveSize` — otherwise
 *    a caller is judged too fat to inline on the strength of code that never
 *    runs.
 *
 * 5. **A callee that CONTAINS a loop is not a loop-leaf.** Rule 1 estimates how
 *    often a SITE runs; the loop-leaf rule then trades code growth for the call
 *    sequence that site pays. That trade needs the callee's per-call cost to be
 *    comparable to the call itself — true of a small straight-line leaf, false
 *    the moment the callee carries a loop of its own, because then one call
 *    covers the whole trip count and the overhead removed is a vanishing
 *    fraction of it. What is NOT vanishing is the cost of moving that loop into
 *    the caller: every value the CALLER holds live across a call of its own
 *    lives in a stack slot (f64/v128 registers are caller-saved), and the
 *    inlined loop then re-loads them on the back edge, per iteration, forever.
 *    This is the same line Binaryen draws with "lightweight (no loops or
 *    function calls)", reached from the cost side rather than the safety side.
 *
 *    Measured on the landing WASI host lane: its `fib` program is `export function
 *    run(n)`, one `for` loop, ~30 instructions and a leaf — so it passed every
 *    other loop-leaf test and was inlined into the benchmark's `warm` driver at
 *    both of its sites. Cranelift then spilled `n`, `__best` and `__t0` (all
 *    live across the driver's `performance.now()` calls) and reloaded three
 *    xmm words inside the 20M-iteration inner loop: 12.44 ms -> 24.89 ms, a
 *    lane that read 1.50x V8 turned into 0.76x. `array-sum` lost 34 % the same
 *    way; `fib-recursive` (self-recursive, already declined) and `string-hash`
 *    (not a leaf) were untouched, which is what identified the rule.
 *
 *    **Rule 5 gates `loop-leaf` only, NOT the `hot` rule** of entry (48), even
 *    though `hot` is the same frequency-rule shape and would readmit exactly
 *    this callee (the landing `fib` kernel clears `hotMax` comfortably). `hot`
 *    is flag-gated OFF and still being measured; narrowing another lane's
 *    in-flight experiment would invalidate its numbers. Whoever flips it on
 *    owns deciding whether a loop-carrying callee belongs under it.
 *
 * ## Correctness — what is proven and what is declined
 *
 * Inlining at the wasm level rewrites three things, and a wrong answer on any
 * of them is a SILENT MISCOMPILE, so every construct that cannot be proven safe
 * is declined with a named reason (see `DeclineReason`) rather than guessed at.
 *
 * - **Arguments.** At the `call`, the arguments are the top N operand-stack
 *   slots. They are spilled into N fresh locals typed exactly as the callee's
 *   params, with `local.set` emitted in REVERSE parameter order (the last
 *   parameter is on top). This is stack-neutral and needs no knowledge of how
 *   the arguments were computed.
 * - **Locals.** The callee's whole local index space (params `[0, nParams)`
 *   then declared locals) is relocated to a contiguous block appended to the
 *   caller, so `i -> base + i` on every `local.get/set/tee`.
 * - **Control flow.** The callee body is wrapped in one `block` whose result
 *   type is the callee's result. Relative label depths INSIDE the callee are
 *   unchanged by construction — a `br k` with `k < d` (d = structured nesting
 *   depth) targets a label the copy still contains, and a `br d`, which in the
 *   callee targeted the implicit FUNCTION label, now targets the wrapper block,
 *   which carries the identical result type. The only rewrite needed is
 *   `return` -> `br d`. `br_table` targets get the same treatment (none, plus
 *   the same reasoning for entries equal to `d`).
 *
 * Declined, each because the rewrite above is NOT sound for it:
 * - `return_call` / `return_call_ref` — a tail call returns from the ENCLOSING
 *   frame. Inlined, it would return from the caller. Rewriting it to
 *   `call` + `br` is semantically right but silently converts a constant-stack
 *   tail call into a growing one, which can turn a working deep recursion into
 *   a stack overflow. Declined outright.
 * - `try` / `rethrow` — the relative-depth argument does extend to catch
 *   labels, but `rethrow` indexes catch handlers rather than blocks and the
 *   downstream `stackBalance` pass has its own model of try arity. Not proven,
 *   so not done.
 * - multi-result callees — the wrapper `block` would need a `[] -> results`
 *   functype that may not exist in the type section, and minting one after the
 *   type space is final is exactly the class of index churn #1899 retired.
 * - direct self-recursion, and any callee whose body was never filled.
 *
 * ## Placement contract (why `codegen/index.ts` calls this exactly where it does)
 *
 * The call sits immediately after `finalizeFunctionPoisonPillCalls` and
 * immediately before the index freeze. That is the ONLY point where all four
 * of these hold at once:
 *
 * - **After dead-elim and `repairStructTypeMismatches`** — every `call`'s
 *   funcIdx is final, and every argument's ref-null typing has already been
 *   repaired, so spilling an argument into a param-typed local cannot mistype
 *   it. (Inlining earlier would hand the repair passes a `local.set` where
 *   they expect a `call`, which is the same adjacency hazard that broke the
 *   older call-site census — see `exec-census.ts`.)
 * - **After `finalizeFunctionPoisonPillCalls`** — that pass threads the SOURCE
 *   CALLER's strictness into each invocation. Inlining first would move an
 *   invocation into a different caller and hand it the wrong strictness.
 * - **Before the index freeze** — the pass appends locals, and under `count`
 *   one module global.
 * - **Before `stackBalance` / `fixupExternConvertAny`** — the two repair
 *   passes still get to see the inlined bodies.
 *
 * The censuses run just above, so an inlined copy would otherwise carry the
 * callee's entry increment; `stripCensusPrefix` removes it from the copy, which
 * is what makes an inlined call genuinely ABSENT from the executed-call count
 * rather than double-counted.
 *
 * ## Interaction with binaryen (entry 19's correction)
 *
 * Binaryen's inliner is a COOPERATING pass, not a competitor: once a call is
 * inlined the call is gone, so there is nothing left for `wasm-opt` to
 * re-inline. No double-inlining mechanism exists and this pass does not try to
 * constrain `wasm-opt`. The only obligation is empirical — report total size
 * and the function-size distribution at `optimize: 0` and `-O4`.
 *
 * ## Flag surface
 *
 *   (unset)                                   the `on` preset — the DEFAULT
 *   JS2WASM_IR_INLINE=0 | off                 the pass does not run at all
 *   JS2WASM_IR_INLINE=report                  analyse + print, mutate NOTHING
 *   JS2WASM_IR_INLINE=on                      adapters + single-caller + loop-leaf
 *   JS2WASM_IR_INLINE=adapters,single,loop    pick rules individually
 *   JS2WASM_IR_INLINE=on,hot,hotmax=N         + the hot non-leaf rule (entry 48)
 *   JS2WASM_IR_INLINE=on,count                + runtime site-execution counter
 *   JS2WASM_IR_INLINE=on,poison               + perturb every inlined result
 *   ...,maxsize=N  ...,growth=N  ...,verbose
 *
 * A value that selects no rule at all — `count` on its own, or a typo — gets
 * the `on` preset plus whatever modifiers it did name, rather than silently
 * disabling the inliner; only an explicit off-token disables it.
 *
 * `poison` exists because a confident null from a mechanism that never fired
 * closes a door that was never opened — #4157 records that failure twice in one
 * session. It perturbs the value produced by every inlined body, so the acorn
 * self-parse checksum MUST move off 422 when the mechanism is live.
 */
import { absoluteFuncIndex } from "../emit/resolve-layout.js";
import type { BlockType, FuncTypeDef, Instr, LocalDef, ValType, WasmFunction, WasmModule } from "../ir/types.js";
import { tunedFlagEnabled, tunedFlagExplicit } from "../perf-flags.js";
import { IR_NUMBER_TO_FIXED_FN } from "../ir/string-runtime.js";
import { EXEC_CENSUS_PREFIX } from "./exec-census.js";
import type { CodegenContext } from "./context/types.js";
import { IR_NATIVE_MAP_GET_NUM_FN, IR_NATIVE_MAP_NEW_FN, IR_NATIVE_MAP_SET_NUM_FN } from "./ir-native-map.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface InlineOptions {
  enabled: boolean;
  /**
   * Analyse and print, mutate nothing. Binary stays byte-identical. The exact
   * native-Map precomposition below is intentionally apply-only, so report
   * mode does not predict that bounded exception's composed growth.
   */
  report: boolean;
  /** Rule 3 — dispatch and exact representation-only adapters, unconditionally. */
  adapters: boolean;
  /** Single-direct-caller user functions. */
  single: boolean;
  /** Small loop-free leaf callees whose site sits inside a loop (rules 1 + 5). */
  loop: boolean;
  /**
   * (#4157 entry 48) Small HOT callees regardless of caller count or leaf-ness
   * — the `no-rule` hole: 72 % of all declines are small multi-caller non-leaf
   * helpers (`__str_equals` 2.7k sites, `__unbox_number` 1.8k, `__is_truthy`
   * 1.7k …) that `single` (needs callerCount == 1) and `loop` (needs a
   * call-free body) structurally cannot admit. Calls inside the copied body
   * stay calls — one pass never chains — so the only new risk is size, which
   * `hotMax` × the shared growth cap bound. OFF by default; measure first.
   */
  hot: boolean;
  /** Rule 2 — accept whenever the SPECIALISED size is <= the call site's cost. */
  specialise: boolean;
  /** Runtime counter global, incremented once per executed inlined body. */
  count: boolean;
  /**
   * Poison every inlined body so the workload's ANSWER must change if the
   * inlined code is on the executed path.
   *  · `"trap"`  — replace the body with `unreachable`. Universal: it is
   *    stack-polymorphic, so it type-checks against ANY result type, which
   *    the numeric variant below cannot do (every `__dc_*` adapter returns a
   *    reference, so numeric poisoning covers exactly zero of them).
   *  · `"soft"`  — perturb the result where it is `i32`/`f64`. Keeps the run
   *    alive so the checksum moves 422 -> some other number instead of
   *    trapping, but only covers numeric-returning callees.
   */
  poison: "off" | "trap" | "soft";
  /** Instruction ceiling for a single-caller callee. */
  singleMax: number;
  /** Instruction ceiling for a loop-body leaf callee. */
  loopMax: number;
  /** Instruction ceiling for a hot non-leaf callee (`hot` rule). */
  hotMax: number;
  /** Whole-module ceiling on net instructions added. */
  growth: number;
  verbose: boolean;
}

const DEFAULTS: InlineOptions = {
  enabled: false,
  report: false,
  adapters: false,
  single: false,
  loop: false,
  specialise: false,
  count: false,
  poison: "off",
  hot: false,
  singleMax: 400,
  loopMax: 60,
  hotMax: 60,
  growth: 400_000,
  verbose: false,
};

/** The `on` preset: every rule, no modifiers. Applied in place. */
function applyOnPreset(o: InlineOptions): void {
  o.enabled = true;
  o.adapters = true;
  o.single = true;
  o.loop = true;
  o.specialise = true;
}

export function parseInlineOptions(raw: string | undefined): InlineOptions {
  const o: InlineOptions = { ...DEFAULTS };
  // Unset ⇒ the tuned default. An off-token ⇒ genuinely off. Everything else
  // is parsed, and falls back to the preset below if it selected no rule.
  if (!tunedFlagEnabled(raw)) return o;
  if (raw === undefined) {
    applyOnPreset(o);
    return o;
  }
  const toks = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (toks.length === 0) {
    applyOnPreset(o);
    return o;
  }
  for (const t of toks) {
    const eq = t.indexOf("=");
    if (eq > 0) {
      const k = t.slice(0, eq);
      const v = Number(t.slice(eq + 1));
      if (!Number.isFinite(v)) continue;
      if (k === "maxsize" || k === "singlemax") o.singleMax = v;
      else if (k === "loopmax") o.loopMax = v;
      else if (k === "hotmax") o.hotMax = v;
      else if (k === "growth") o.growth = v;
      continue;
    }
    switch (t) {
      case "0":
      case "off":
        return { ...DEFAULTS };
      case "report":
        applyOnPreset(o);
        o.report = true;
        break;
      case "1":
      case "on":
        applyOnPreset(o);
        break;
      case "adapters":
        o.enabled = true;
        o.adapters = true;
        break;
      case "single":
        o.enabled = true;
        o.single = true;
        break;
      case "loop":
        o.enabled = true;
        o.loop = true;
        break;
      case "hot":
        // NOT part of the `on` preset (yet) — a candidate rule under
        // measurement. `JS2WASM_IR_INLINE=on,hot` composes it with the preset.
        o.enabled = true;
        o.hot = true;
        break;
      case "specialise":
      case "specialize":
        o.enabled = true;
        o.specialise = true;
        break;
      case "count":
        o.count = true;
        break;
      case "poison":
        o.poison = "trap";
        break;
      case "poison-soft":
        o.poison = "soft";
        break;
      case "verbose":
        o.verbose = true;
        break;
      default:
        break;
    }
  }
  // A spec that named only modifiers (`count`, `verbose`, `growth=…`) or
  // nothing recognisable at all selected no RULE. Under the tuned default that
  // must not read as "off" — it reads as "the default set, plus what you asked
  // for", which is also what `JS2WASM_IR_INLINE=count` obviously means.
  if (!o.enabled) applyOnPreset(o);
  return o;
}

// ---------------------------------------------------------------------------
// Classification helpers — the parts of the cost model that read NAMES
// ---------------------------------------------------------------------------

/**
 * A dispatch or representation-only adapter. Rule 3: overhead by
 * construction, so it is admitted without consulting any size budget.
 */
export function isAdapter(name: string): boolean {
  return (
    name.startsWith("__dc_") ||
    name === "__ir_number_toString_native" ||
    name === "__ir_number_to_string" ||
    name === IR_NUMBER_TO_FIXED_FN ||
    isNativeMapCarrierAdapter(name)
  );
}

function isNativeMapCarrierAdapter(name: string): boolean {
  return name === IR_NATIVE_MAP_NEW_FN || name === IR_NATIVE_MAP_GET_NUM_FN || name === IR_NATIVE_MAP_SET_NUM_FN;
}

/**
 * Cold by construction (rule 4). Never inlined, and its instruction mass does
 * not count against an enclosing function's `effectiveSize`.
 */
export function isColdByConstruction(name: string): boolean {
  return (
    name.startsWith("__new_TypeError") ||
    name.startsWith("__new_RangeError") ||
    name.startsWith("__new_SyntaxError") ||
    name.startsWith("__new_ReferenceError") ||
    name.startsWith("__new_Error") ||
    name.startsWith("__throw")
  );
}

/** Compiled USER code — acorn's own functions land in the `__closure_*` family. */
export function isUserFunction(name: string): boolean {
  return name.startsWith("__closure_") || name.startsWith("__fn_") || name.startsWith("__method_");
}

/**
 * Which population a callee belongs to. Reported per rule so "what did each
 * rule actually fire on" is answered by the run rather than inferred — the
 * distinction that matters here is USER code (the stated target) versus the
 * `__dc_*` adapter layer versus the runtime helpers.
 */
function calleeFamily(name: string): string {
  if (isAdapter(name)) return "adapter";
  if (isUserFunction(name)) return "user";
  if (name.startsWith("__")) return "helper";
  return "other";
}

// ---------------------------------------------------------------------------
// Traversal primitives
// ---------------------------------------------------------------------------

function childBodies(instr: Instr): Instr[][] {
  switch (instr.op) {
    case "block":
    case "loop":
    case "try_table":
      return [instr.body];
    case "if":
      return instr.else ? [instr.then, instr.else] : [instr.then];
    case "try": {
      const out: Instr[][] = [instr.body];
      for (const c of instr.catches) out.push(c.body);
      if (instr.catchAll) out.push(instr.catchAll);
      return out;
    }
    default:
      return [];
  }
}

export function countInstrs(body: Instr[]): number {
  let n = 0;
  for (const instr of body) {
    n++;
    for (const child of childBodies(instr)) n += countInstrs(child);
  }
  return n;
}

/**
 * Instruction mass MINUS the cold regions (rule 4). A structured region whose
 * last instruction is `unreachable` or `throw` is a guard path; charging its
 * body to the enclosing function is what makes an otherwise-small function look
 * unbudgetable.
 */
function effectiveSize(body: Instr[]): number {
  let n = 0;
  for (const instr of body) {
    n++;
    for (const child of childBodies(instr)) {
      if (isColdRegion(child)) continue;
      n += effectiveSize(child);
    }
  }
  return n;
}

function isColdRegion(body: Instr[]): boolean {
  if (body.length === 0) return false;
  const last = body[body.length - 1];
  return last.op === "unreachable" || last.op === "throw";
}

function forEachInstr(body: Instr[], visit: (i: Instr) => void): void {
  for (const instr of body) {
    visit(instr);
    for (const child of childBodies(instr)) forEachInstr(child, visit);
  }
}

// ---------------------------------------------------------------------------
// Callee safety
// ---------------------------------------------------------------------------

export type DeclineReason =
  | "unsafe:return-call"
  | "unsafe:try"
  | "unsafe:multi-result"
  | "unsafe:empty-body"
  | "self-recursive"
  | "cold-callee"
  | "import"
  | "budget"
  | "growth-cap"
  | "loop-in-callee"
  | "no-rule";

function calleeIsSafe(fn: WasmFunction, results: ValType[]): DeclineReason | null {
  if (fn.body.length === 0) return "unsafe:empty-body";
  if (results.length > 1) return "unsafe:multi-result";
  let bad: DeclineReason | null = null;
  forEachInstr(fn.body, (i) => {
    if (bad) return;
    if (i.op === "return_call" || i.op === "return_call_ref") bad = "unsafe:return-call";
    else if (i.op === "try" || i.op === "try_table" || i.op === "rethrow") bad = "unsafe:try";
  });
  return bad;
}

// ---------------------------------------------------------------------------
// Body cloning + relocation
// ---------------------------------------------------------------------------

function cloneInstr(instr: Instr): Instr {
  switch (instr.op) {
    case "block":
    case "loop":
    case "try_table":
      return { ...instr, body: instr.body.map(cloneInstr) };
    case "if":
      return {
        ...instr,
        then: instr.then.map(cloneInstr),
        ...(instr.else ? { else: instr.else.map(cloneInstr) } : {}),
      };
    case "try":
      return {
        ...instr,
        body: instr.body.map(cloneInstr),
        catches: instr.catches.map((c) => ({ tagIdx: c.tagIdx, body: c.body.map(cloneInstr) })),
        ...(instr.catchAll ? { catchAll: instr.catchAll.map(cloneInstr) } : {}),
      };
    case "br_table":
      return { ...instr, targets: [...instr.targets] };
    default:
      return { ...instr };
  }
}

/**
 * Relocate a cloned callee body into the caller's frame.
 *
 * `base` shifts the callee's ENTIRE local index space (params first, then
 * declared locals) into the contiguous block appended to the caller.
 *
 * `depth` is the structured nesting depth INSIDE the callee body. A `return`
 * becomes `br depth`, which — because the whole body is wrapped in exactly one
 * `block` whose result type equals the callee's result — targets that wrapper.
 * Every other label reference is relative and therefore already correct; see
 * the module header for why `br depth` needs no adjustment either.
 */
function relocate(body: Instr[], base: number, depth: number): Instr[] {
  const out: Instr[] = [];
  for (const instr of body) {
    switch (instr.op) {
      case "local.get":
      case "local.set":
      case "local.tee":
        out.push({ ...instr, index: instr.index + base });
        break;
      case "return":
        out.push({ op: "br", depth, ...(instr.sourcePos ? { sourcePos: instr.sourcePos } : {}) });
        break;
      case "block":
      case "loop":
        out.push({ ...instr, body: relocate(instr.body, base, depth + 1) });
        break;
      case "if":
        out.push({
          ...instr,
          then: relocate(instr.then, base, depth + 1),
          ...(instr.else ? { else: relocate(instr.else, base, depth + 1) } : {}),
        });
        break;
      default:
        out.push(instr);
        break;
    }
  }
  return out;
}

/**
 * Drop the executed-call census increment from an inlined COPY. The census
 * counts function ENTRIES; a copy that carried the increment would report the
 * inlined executions as if the call still happened, which is precisely the
 * signal the measurement is asking for.
 */
function stripCensusPrefix(body: Instr[]): Instr[] {
  if (body.length < 4) return body;
  const [a, b, c, d] = body;
  if (
    a.op === "global.get" &&
    b.op === "i32.const" &&
    b.value === 1 &&
    c.op === "i32.add" &&
    d.op === "global.set" &&
    a.index === d.index
  ) {
    return body.slice(4);
  }
  return body;
}

// ---------------------------------------------------------------------------
// Rule 2 — specialisation delta
// ---------------------------------------------------------------------------

type ConstVal = { op: "i32.const"; value: number } | { op: "f64.const"; value: number };

/**
 * Recover the constant arguments of a call by walking BACKWARDS from the call
 * site over single-push constant producers. Only a trailing run is recoverable
 * without a full abstract stack, which is deliberate: a partial answer that is
 * always sound beats a complete one that is sometimes wrong.
 *
 * `params` is consulted so a constant is only accepted when its type MATCHES
 * the parameter it feeds. Without that check a module whose argument sequence
 * is `f64.const; i32.const; call f(i32,i32)` would have `local.get 0` rewritten
 * to an `f64.const` — a validation failure manufactured out of an upstream
 * mismatch that was previously invisible.
 *
 * Returns an array of length `params.length`; `null` where the argument is
 * unknown or type-mismatched.
 */
function constArgs(body: Instr[], callIdx: number, params: ValType[]): (ConstVal | null)[] {
  const out: (ConstVal | null)[] = new Array(params.length).fill(null);
  let p = params.length - 1;
  let k = callIdx - 1;
  while (p >= 0 && k >= 0) {
    const instr = body[k];
    if (instr.op === "i32.const" && params[p].kind === "i32") out[p] = { op: "i32.const", value: instr.value };
    else if (instr.op === "f64.const" && params[p].kind === "f64") out[p] = { op: "f64.const", value: instr.value };
    else break;
    p--;
    k--;
  }
  return out;
}

/**
 * Does any branch inside `body` target a label AT OR OUTSIDE this region?
 *
 * This is the guard on the constant-`if` fold. Splicing a taken arm up one
 * structured level removes a label from the stack, so every branch that
 * escaped the arm has its depth silently decremented — `br 0` that meant "leave
 * the if" would come to mean "leave the enclosing block". That is a MISCOMPILE,
 * not a size regression, and it is exactly the class of thing this pass has to
 * decline rather than guess at. `return` is unaffected (it targets the function
 * label, which the splice does not move) and so is not counted.
 */
function escapesRegion(body: Instr[], depth = 0): boolean {
  for (const instr of body) {
    if (instr.op === "br" || instr.op === "br_if") {
      if (instr.depth >= depth) return true;
    } else if (instr.op === "br_table") {
      if (instr.defaultDepth >= depth || instr.targets.some((t) => t >= depth)) return true;
    } else if (instr.op === "rethrow") {
      if (instr.depth >= depth) return true;
    }
    for (const child of childBodies(instr)) {
      if (escapesRegion(child, depth + 1)) return true;
    }
  }
  return false;
}

function paramIsReassigned(body: Instr[], idx: number): boolean {
  let hit = false;
  forEachInstr(body, (i) => {
    if ((i.op === "local.set" || i.op === "local.tee") && i.index === idx) hit = true;
  });
  return hit;
}

/** Substitute constant params, then fold the branches that become constant. */
function specialise(body: Instr[], consts: (ConstVal | null)[]): Instr[] {
  const usable = consts.map((c, i) => (c && !paramIsReassigned(body, i) ? c : null));
  if (!usable.some((c) => c !== null)) return body;
  return foldConst(substitute(body, usable));
}

function substitute(body: Instr[], consts: (ConstVal | null)[]): Instr[] {
  return body.map((instr): Instr => {
    if (instr.op === "local.get" && instr.index < consts.length) {
      const c = consts[instr.index];
      if (c) return c.op === "i32.const" ? { op: "i32.const", value: c.value } : { op: "f64.const", value: c.value };
    }
    switch (instr.op) {
      case "block":
      case "loop":
        return { ...instr, body: substitute(instr.body, consts) };
      case "if":
        return {
          ...instr,
          then: substitute(instr.then, consts),
          ...(instr.else ? { else: substitute(instr.else, consts) } : {}),
        };
      default:
        return instr;
    }
  });
}

/**
 * The fold that makes rule 2 real: an `if` whose condition is now a literal
 * collapses to the taken arm, which is where "the inlined result is SMALLER
 * than the callee" comes from. Also folds the i32 comparisons that typically
 * feed such a condition.
 */
function foldConst(body: Instr[]): Instr[] {
  const out: Instr[] = [];
  for (const raw of body) {
    let instr = raw;
    switch (instr.op) {
      case "block":
      case "loop":
        instr = { ...instr, body: foldConst(instr.body) };
        break;
      case "if":
        instr = {
          ...instr,
          then: foldConst(instr.then),
          ...(instr.else ? { else: foldConst(instr.else) } : {}),
        };
        break;
      default:
        break;
    }
    const prev = out[out.length - 1];
    if (prev && prev.op === "i32.const") {
      if (instr.op === "i32.eqz") {
        out[out.length - 1] = { op: "i32.const", value: prev.value === 0 ? 1 : 0 };
        continue;
      }
      const prev2 = out[out.length - 2];
      if (prev2 && prev2.op === "i32.const" && (instr.op === "i32.eq" || instr.op === "i32.ne")) {
        const eq = prev2.value === prev.value;
        out.length -= 2;
        out.push({ op: "i32.const", value: (instr.op === "i32.eq" ? eq : !eq) ? 1 : 0 });
        continue;
      }
      // Constant `if` — only foldable when it produces nothing, because a
      // value-producing `if` folded to one arm still has to type-check against
      // the surrounding block and we do not track the operand stack here.
      if (instr.op === "if" && instr.blockType.kind === "empty") {
        const taken = prev.value !== 0 ? instr.then : (instr.else ?? []);
        // See `escapesRegion`: splicing the arm up one level rewrites the
        // meaning of every branch that leaves it.
        if (!escapesRegion(taken)) {
          out.pop();
          out.push(...taken);
          continue;
        }
      }
    }
    out.push(instr);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

interface Stats {
  functions: number;
  callSites: number;
  inlined: number;
  addedInstrs: number;
  declines: Map<string, number>;
  byRule: Map<string, number>;
  /** `verbose` only — "<callee> <reason>" -> site count, for residual triage. */
  declinedCallees: Map<string, number>;
  poisoned: number;
}

function blockTypeFor(results: ValType[]): BlockType {
  if (results.length === 0) return { kind: "empty" };
  return { kind: "val", type: results[0] };
}

/** Memoized per-callee analysis results — see the site loop in `inlineUserFunctions`. */
interface CalleeFacts {
  unsafe: DeclineReason | null;
  rawSize: number;
  effSize: number;
  isLeaf: boolean;
  /** Rule 5 — the callee's own body contains a `loop`. See `hasLoop`. */
  loops: boolean;
}

/**
 * ORIGINAL-body views: inlining is SINGLE-LEVEL. Callee bodies are read from
 * their pre-pass ORIGINAL, so a function that has itself had callees inlined
 * into it still contributes its original body. That bounds growth to one
 * level and removes any need for a cycle check beyond direct self-recursion.
 *
 * Reading a live `f.body` alias instead makes the pass silently iterative in
 * `mod.functions` order — inlining A into B and then the already-inflated B
 * into C. Measured on acorn with all rules on, the alias grew the module by
 * 243,492 instructions where single-level costs 137,072, i.e. 78 % of the
 * growth came from an order-dependent transitive effect nobody had asked for.
 * It is not unsound (the relocation is uniform over the whole local space,
 * which the alias also widens), but it is unpredictable and unbudgetable, so
 * it is not what this pass does.
 *
 * The one bounded exception is the three native-Map carrier adapters. The IR
 * must cross those typed carrier shims, while the direct backend calls the raw
 * `__map_*` helpers at the source site. We process exactly those adapter
 * CALLERS first, then copy their composed live body at the one source call
 * layer. Nested lookup/hash calls remain calls, so this recovers the direct
 * shape without turning the module pass into a general transitive inliner.
 *
 * (#4157 shard-slowdown fix) The original guarantee is COPY-ON-WRITE, not an
 * eager whole-module deep clone. Eagerly cloning every body cost ~55 ms +
 * tens of MB of garbage PER COMPILE — irrelevant amortized over one acorn
 * build, but a large share of the tuned-defaults compile-time tax that pushed
 * test262 standalone shards past their CI timeout (the runtime helper set is
 * cloned wholesale even when nothing inlines). A function's body is
 * deep-cloned exactly once, immediately BEFORE its first mutation as a caller
 * (`preserveOriginal`); an unmutated function's live body IS its original, so
 * reading it directly (`originalOf`) is byte-for-byte identical to the eager
 * snapshot.
 */
function createOriginalBodyTracker(mod: WasmModule): {
  originalOf: (idx: number) => { body: Instr[]; locals: LocalDef[] };
  preserveOriginal: (idx: number) => void;
} {
  const snapshot: ({ body: Instr[]; locals: LocalDef[] } | undefined)[] = new Array(mod.functions.length);
  return {
    originalOf: (idx) => snapshot[idx] ?? mod.functions[idx],
    preserveOriginal: (idx) => {
      if (snapshot[idx] === undefined) {
        const f = mod.functions[idx];
        snapshot[idx] = { body: f.body.map(cloneInstr), locals: [...f.locals] };
      }
    },
  };
}

function planNativeMapAdapterPrecomposition(
  mod: WasmModule,
  opts: InlineOptions,
  callerCount: Int32Array,
  addressTaken: Uint8Array,
): { positions: Set<number>; callerOrder: number[] } {
  const positions = new Set<number>();
  const frozenAdapterCallers = new Set<number>();
  // Report mode's primary contract is byte identity. Shadow-precomposing would
  // require a cloned module/local space; keep its statistics on the ordinary
  // one-level topology rather than mutating and attempting to restore compiler
  // state. The apply path still charges the full live body below.
  if (!opts.report && opts.adapters) {
    for (let index = 0; index < mod.functions.length; index++) {
      if (
        isNativeMapCarrierAdapter(mod.functions[index]!.name) &&
        callerCount[index] === 1 &&
        addressTaken[index] === 0
      ) {
        positions.add(index);
      }
    }
  }
  if (opts.adapters && !opts.report) {
    for (let index = 0; index < mod.functions.length; index++) {
      // #4576 — this thunk is representation-only and therefore copied into
      // each source call site. Do not first inline its single raw native
      // formatter callee into the thunk itself: doing so retains a dead 7 KiB
      // composed wrapper in addition to the five direct-shaped source calls.
      if (mod.functions[index]!.name === IR_NUMBER_TO_FIXED_FN) frozenAdapterCallers.add(index);
    }
  }
  return {
    positions,
    callerOrder: [
      ...positions,
      ...Array.from(mod.functions.keys()).filter((index) => !positions.has(index) && !frozenAdapterCallers.has(index)),
    ],
  };
}

function installInlineCounter(ctx: CodegenContext, opts: InlineOptions): number {
  if (!opts.count || opts.report) return -1;
  const mod = ctx.mod;
  const globalIdx = ctx.numImportGlobals + mod.globals.length;
  mod.globals.push({
    name: "__ir_inline_execs",
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  });
  mod.exports.push({ name: "__ir_inline_execs", desc: { kind: "global", index: globalIdx } });
  return globalIdx;
}

export function inlineUserFunctions(ctx: CodegenContext): void {
  const opts = parseInlineOptions(process.env.JS2WASM_IR_INLINE);
  if (!opts.enabled) return;
  const mod = ctx.mod;
  let numImportFuncs = 0;
  for (const imp of mod.imports) if (imp.desc.kind === "func") numImportFuncs++;

  const funcTypeOf = (fn: WasmFunction): FuncTypeDef | null => {
    const t = mod.types[fn.typeIdx];
    return t && t.kind === "func" ? t : null;
  };

  // (#4483) ES5 §15.3.5.4 caller-poison guard.
  //
  // `finalizeFunctionPoisonPillCalls` runs immediately AFTER this pass and
  // marks each source call with the strictness of the WASM FUNCTION whose body
  // holds it. Inlining moves a callee's calls into the caller's body, so a
  // strict callee inlined into a sloppy caller has its calls marked SLOPPY —
  // and a sloppy function reading its own `.caller` then fails to throw.
  // Measured on this branch's base: `built-ins/Function/15.3.5.4_2-42gs` (a
  // strict FunctionDeclaration nested in a sloppy FunctionExpression) inlined
  // to exactly that, with the strict copy left dead in the module.
  //
  // The guard costs nothing in the ordinary case: `callerStrictGlobalIdx` is
  // only allocated once some function actually reads a legacy `caller`
  // property (`ensureCallerStrictSnapshot`), so a module that never observes
  // `.caller` — every real-world program — keeps every inlining decision it
  // had before.
  const poisonObserved = ctx.callerStrictGlobalIdx >= 0;
  const sourceStrictnessOf = (fn: WasmFunction): boolean | undefined =>
    ctx.sourceFunctionStrictnessByBody.get(fn.body) ?? ctx.sourceFunctionStrictness.get(fn.name);

  // --- call graph -----------------------------------------------------------
  const callerCount = new Int32Array(mod.functions.length);
  const addressTaken = new Uint8Array(mod.functions.length);
  const posOf = (h: number): number => absoluteFuncIndex(mod, h) - numImportFuncs;

  for (const fn of mod.functions) {
    forEachInstr(fn.body, (i) => {
      if (i.op === "call") {
        const p = posOf(i.funcIdx);
        if (p >= 0 && p < callerCount.length) callerCount[p]++;
      } else if (i.op === "ref.func") {
        const p = posOf(i.funcIdx);
        if (p >= 0 && p < addressTaken.length) addressTaken[p] = 1;
      }
    });
  }
  for (const el of mod.elements) {
    for (const h of el.funcIndices) {
      const p = posOf(h);
      if (p >= 0 && p < addressTaken.length) addressTaken[p] = 1;
    }
  }

  // --- static hotness: 10^loopDepth, propagated one step ---------------------
  // Property of the PROGRAM, not of any corpus — see the module header on why
  // #3927 §7's objection to frequency ranking does not reach this.
  const LOOP_WEIGHT = 10;
  const hot = new Float64Array(mod.functions.length).fill(1);
  for (let round = 0; round < 2; round++) {
    const next = Float64Array.from(hot);
    for (let ci = 0; ci < mod.functions.length; ci++) {
      const walk = (body: Instr[], depth: number): void => {
        for (const instr of body) {
          if (instr.op === "call") {
            const p = posOf(instr.funcIdx);
            if (p >= 0 && p < next.length) {
              const w = hot[ci] * Math.pow(LOOP_WEIGHT, depth);
              if (w > next[p]) next[p] = Math.min(w, 1e9);
            }
          }
          if (instr.op === "loop") walk(instr.body, depth + 1);
          else for (const child of childBodies(instr)) walk(child, depth);
        }
      };
      walk(mod.functions[ci].body, 0);
    }
    hot.set(next);
  }

  // --- counter global (needs to exist before any body references it) --------
  const counterGlobalIdx = installInlineCounter(ctx, opts);

  const { originalOf, preserveOriginal } = createOriginalBodyTracker(mod);
  const { positions: precomposedAdapterPositions, callerOrder } = planNativeMapAdapterPrecomposition(
    mod,
    opts,
    callerCount,
    addressTaken,
  );
  // Per-callee analysis cache — see the comment at its use in the site loop.
  const calleeFacts = new Map<number, CalleeFacts>();

  const stats: Stats = {
    functions: mod.functions.length,
    callSites: 0,
    inlined: 0,
    addedInstrs: 0,
    declines: new Map(),
    byRule: new Map(),
    declinedCallees: new Map(),
    poisoned: 0,
  };
  const bump = (m: Map<string, number>, k: string): void => {
    m.set(k, (m.get(k) ?? 0) + 1);
  };
  const declined = (name: string, reason: string): void => {
    bump(stats.declines, reason);
    bump(stats.declines, `${calleeFamily(name)}:${reason}`);
    if (opts.verbose) bump(stats.declinedCallees, `${name} ${reason}`);
  };

  let growth = 0;

  for (const ci of callerOrder) {
    const caller = mod.functions[ci];
    const callerType = funcTypeOf(caller);
    if (!callerType) continue;

    const rewriteBody = (body: Instr[], loopDepth: number): void => {
      for (let k = 0; k < body.length; k++) {
        const instr = body[k];
        if (instr.op === "loop") {
          rewriteBody(instr.body, loopDepth + 1);
          continue;
        }
        const kids = childBodies(instr);
        if (kids.length > 0) {
          for (const child of kids) rewriteBody(child, loopDepth);
          continue;
        }
        if (instr.op !== "call") continue;
        stats.callSites++;
        const abs = absoluteFuncIndex(mod, instr.funcIdx);
        const cp = abs - numImportFuncs;
        if (cp < 0 || cp >= mod.functions.length) {
          bump(stats.declines, "import");
          continue;
        }
        const callee = mod.functions[cp];
        const calleeType = funcTypeOf(callee);
        if (!calleeType) {
          bump(stats.declines, "unsafe:empty-body");
          continue;
        }
        if (cp === ci) {
          declined(callee.name, "self-recursive");
          continue;
        }
        if (isColdByConstruction(callee.name)) {
          declined(callee.name, "cold-callee");
          continue;
        }
        // (#4483) See `poisonObserved` above — never merge two activations that
        // disagree about strictness while the module observes `.caller`. An
        // unknown caller strictness (a trampoline / runtime helper) counts as
        // disagreement: such a body is never instrumented at all.
        if (poisonObserved) {
          const calleeStrict = sourceStrictnessOf(callee);
          if (calleeStrict !== undefined && sourceStrictnessOf(caller) !== calleeStrict) {
            declined(callee.name, "caller-poison-strictness");
            continue;
          }
        }
        const calleeView = precomposedAdapterPositions.has(cp) ? callee : originalOf(cp);
        const calleeBody = calleeView.body;
        // (#4157 shard-slowdown fix) The four analyses below are functions of
        // the callee's ORIGINAL body only (guaranteed stable by the
        // copy-on-write contract of `snapshot`), so they are computed once per
        // callee, not once per call site. A hot helper is a callee at hundreds
        // of sites per compile; re-walking its body at each was the dominant
        // per-compile cost of this pass. Memoization changes no decision —
        // every cached value is exactly what the per-site computation returned.
        let facts = calleeFacts.get(cp);
        if (facts === undefined) {
          facts = {
            unsafe: calleeIsSafe({ ...callee, body: calleeBody }, calleeType.results),
            rawSize: countInstrs(calleeBody),
            effSize: effectiveSize(calleeBody),
            isLeaf: !hasCall(calleeBody),
            loops: hasLoop(calleeBody),
          };
          calleeFacts.set(cp, facts);
        }
        const unsafe = facts.unsafe;
        if (unsafe) {
          declined(callee.name, unsafe);
          continue;
        }

        const nParams = calleeType.params.length;
        const siteCost = nParams + 2;
        const rawSize = facts.rawSize;
        const effSize = facts.effSize;
        const isLeaf = facts.isLeaf;

        // Rule 2 — specialisation delta. Measured on the actual site facts.
        let specBody: Instr[] | null = null;
        let specSize = effSize;
        if (opts.specialise && nParams > 0) {
          const consts = constArgs(body, k, calleeType.params);
          if (consts.some((c) => c !== null)) {
            const s = specialise(calleeBody.map(cloneInstr), consts);
            specSize = effectiveSize(s);
            if (specSize < effSize) specBody = s;
          }
        }

        // Rule 1 — call-site frequency. `hot[ci]` is the caller's own estimated
        // frequency (propagated one step across the call graph); the site's own
        // loop nesting multiplies it. Both come from the SOURCE BEING COMPILED,
        // never from an observed corpus.
        const weight = Math.min(hot[ci] * Math.pow(LOOP_WEIGHT, loopDepth), 1e9);
        // A hotter site earns a larger body budget — one extra `loopMax` per
        // decade of estimated frequency.
        const loopBudget = opts.loopMax * Math.max(1, Math.log10(weight));
        // Everything the loop-leaf rule asks EXCEPT rule 5, so the near-miss
        // below can name the one callee the rule turned away on cost grounds.
        const loopLeafFits = opts.loop && weight >= LOOP_WEIGHT && isLeaf && effSize <= loopBudget;

        let rule: string | null = null;
        if (opts.adapters && isAdapter(callee.name)) rule = "adapter";
        else if (opts.specialise && specSize <= siteCost) rule = "specialised";
        else if (opts.single && callerCount[cp] === 1 && !addressTaken[cp] && effSize <= opts.singleMax)
          rule = "single-caller";
        else if (loopLeafFits && !facts.loops) rule = "loop-leaf";
        // (#4157 entry 48) `hot` — the no-rule hole. Same hotness bar and
        // weight-scaled budget as loop-leaf, but caller count and leaf-ness do
        // not gate: nested calls in the copy stay calls (no chaining in one
        // pass), and multi-caller only means the body is copied at more than
        // one site, which is exactly what the growth cap is for.
        // Rule 5 deliberately does NOT gate this one — see the module header.
        else if (opts.hot && weight >= LOOP_WEIGHT && effSize <= opts.hotMax * Math.max(1, Math.log10(weight)))
          rule = "hot";

        if (!rule) {
          // Rule 5's near-miss gets its own name: "no-rule" would hide the one
          // decline whose CAUSE is a cost-model judgement rather than a missing
          // rule, and this bucket is how a future retune prices it.
          const reason = loopLeafFits && facts.loops ? "loop-in-callee" : "no-rule";
          // Verbose: carry the per-callee facts in the key — they are
          // per-callee constants, so identical strings aggregate and the
          // report shows WHY each hot candidate missed every rule.
          if (opts.verbose)
            bump(
              stats.declinedCallees,
              `${callee.name} ${reason} eff=${effSize} leaf=${isLeaf ? 1 : 0} callers=${callerCount[cp]}`,
            );
          bump(stats.declines, reason);
          bump(stats.declines, `${calleeFamily(callee.name)}:${reason}`);
          continue;
        }
        if (growth + rawSize > opts.growth) {
          declined(callee.name, "growth-cap");
          continue;
        }
        bump(stats.byRule, rule);
        bump(stats.byRule, `${rule}:${calleeFamily(callee.name)}`);
        if (opts.verbose)
          process.stderr.write(`[ir-inline]   ${rule}: ${callee.name} -> ${caller.name ?? `func#${ci}`}\n`);
        stats.inlined++;
        growth += rawSize - 1;
        stats.addedInstrs += rawSize - 1;
        if (opts.report) continue;

        // ---- the rewrite --------------------------------------------------
        // First mutation of this caller: preserve its original body NOW, so a
        // later read of it as a CALLEE still sees the pre-pass content
        // (copy-on-write contract of `snapshot`, see its declaration).
        preserveOriginal(ci);
        const base = callerType.params.length + caller.locals.length;
        const fresh: LocalDef[] = [];
        for (let p = 0; p < nParams; p++)
          fresh.push({ name: `__inl${stats.inlined}_p${p}`, type: calleeType.params[p] });
        // The locals must come from the same view as the body. Ordinary
        // callees use the stable snapshot; the exact precomposed Map adapters
        // use their live composed body and its freshly added locals together.
        for (const l of calleeView.locals) fresh.push({ name: `__inl${stats.inlined}_${l.name}`, type: l.type });
        caller.locals.push(...fresh);

        const source = specBody ?? calleeBody.map(cloneInstr);
        const relocated = relocate(stripCensusPrefix(source), base, 0);

        const seq: Instr[] = [];
        for (let p = nParams - 1; p >= 0; p--) seq.push({ op: "local.set", index: base + p });
        if (counterGlobalIdx >= 0) {
          seq.push(
            { op: "global.get", index: counterGlobalIdx },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "global.set", index: counterGlobalIdx },
          );
        }
        const bt = blockTypeFor(calleeType.results);
        if (opts.poison === "trap") {
          // `unreachable` is stack-polymorphic, so it satisfies `bt` whatever
          // the result type is. Any executed site turns 422 into a trap.
          seq.push({ op: "block", blockType: bt, body: [{ op: "unreachable" }] });
          stats.poisoned++;
        } else {
          seq.push({ op: "block", blockType: bt, body: relocated });
          if (opts.poison === "soft") {
            const r = calleeType.results[0];
            if (r && r.kind === "i32") {
              seq.push({ op: "i32.const", value: 1 }, { op: "i32.add" });
              stats.poisoned++;
            } else if (r && r.kind === "f64") {
              seq.push({ op: "f64.const", value: 1 }, { op: "f64.add" });
              stats.poisoned++;
            }
          }
        }

        body.splice(k, 1, ...seq);
        k += seq.length - 1;
      }
    };

    rewriteBody(caller.body, 0);
  }

  report(stats, opts, mod);
}

function hasCall(body: Instr[]): boolean {
  let found = false;
  forEachInstr(body, (i) => {
    if (i.op === "call" || i.op === "call_ref" || i.op === "call_indirect") found = true;
  });
  return found;
}

/**
 * Rule 5 — does the callee's own body contain a `loop`? See the module header
 * for why a loop-carrying callee is excluded from the loop-leaf rule.
 */
function hasLoop(body: Instr[]): boolean {
  let found = false;
  forEachInstr(body, (i) => {
    if (i.op === "loop") found = true;
  });
  return found;
}

function report(stats: Stats, opts: InlineOptions, mod: WasmModule): void {
  // Three dense lines per compile is a diagnostic, not a compiler message.
  // Printed when the operator asked for the flag (including `report`, whose
  // whole purpose is the print) — silent on a plain default build.
  if (!opts.report && !opts.verbose && !tunedFlagExplicit(process.env.JS2WASM_IR_INLINE)) return;
  const w = (s: string): void => void process.stderr.write(s);
  const sizes = mod.functions.map((f) => countInstrs(f.body)).sort((a, b) => a - b);
  const pct = (p: number): number =>
    sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))] : 0;
  const total = sizes.reduce((a, b) => a + b, 0);
  w(
    `[ir-inline] mode=${opts.report ? "report" : "apply"} funcs=${stats.functions} sites=${stats.callSites} ` +
      `inlined=${stats.inlined} addedInstrs=${stats.addedInstrs} poisoned=${stats.poisoned}\n`,
  );
  w(
    `[ir-inline] size-dist total=${total} p50=${pct(0.5)} p90=${pct(0.9)} p99=${pct(0.99)} max=${sizes[sizes.length - 1] ?? 0}\n`,
  );
  const fmt = (m: Map<string, number>): string =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
  w(`[ir-inline] by-rule ${fmt(stats.byRule)}\n`);
  w(`[ir-inline] declines ${fmt(stats.declines)}\n`);
  if (opts.verbose) {
    for (const [k, v] of [...stats.declinedCallees.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      w(`[ir-inline]   declined ${v}x ${k}\n`);
    }
  }
}
