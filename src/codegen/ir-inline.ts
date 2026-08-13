// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) IR-level inliner for USER code — `JS2WASM_IR_INLINE`, default OFF.
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
 *    carrying ~4 % of runtime in pure self-time. A trampoline's whole body is
 *    overhead by construction, so no size heuristic gets a vote.
 *
 * 4. **Cold by construction never, and not charged to the caller.** The
 *    `__new_TypeError` / `__throw*` guard paths are never inlined, AND their
 *    instruction mass is subtracted from a callee's `effectiveSize` — otherwise
 *    a caller is judged too fat to inline on the strength of code that never
 *    runs.
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
 *   JS2WASM_IR_INLINE=report                  analyse + print, mutate NOTHING
 *   JS2WASM_IR_INLINE=on                      adapters + single-caller + loop-leaf
 *   JS2WASM_IR_INLINE=adapters,single,loop    pick rules individually
 *   JS2WASM_IR_INLINE=on,count                + runtime site-execution counter
 *   JS2WASM_IR_INLINE=on,poison               + perturb every inlined result
 *   ...,maxsize=N  ...,growth=N  ...,verbose
 *
 * `poison` exists because a confident null from a mechanism that never fired
 * closes a door that was never opened — #4157 records that failure twice in one
 * session. It perturbs the value produced by every inlined body, so the acorn
 * self-parse checksum MUST move off 422 when the mechanism is live.
 */
import { absoluteFuncIndex } from "../emit/resolve-layout.js";
import type { BlockType, FuncTypeDef, Instr, LocalDef, ValType, WasmFunction, WasmModule } from "../ir/types.js";
import { EXEC_CENSUS_PREFIX } from "./exec-census.js";
import type { CodegenContext } from "./context/types.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface InlineOptions {
  enabled: boolean;
  /** Analyse and print, mutate nothing. Binary stays byte-identical. */
  report: boolean;
  /** Rule 3 — `__dc_*` trampolines, unconditionally. */
  adapters: boolean;
  /** Single-direct-caller user functions. */
  single: boolean;
  /** Small leaf callees whose site sits inside a loop. */
  loop: boolean;
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
  singleMax: 400,
  loopMax: 60,
  growth: 400_000,
  verbose: false,
};

export function parseInlineOptions(raw: string | undefined): InlineOptions {
  const o: InlineOptions = { ...DEFAULTS };
  if (!raw) return o;
  const toks = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (toks.length === 0) return o;
  for (const t of toks) {
    const eq = t.indexOf("=");
    if (eq > 0) {
      const k = t.slice(0, eq);
      const v = Number(t.slice(eq + 1));
      if (!Number.isFinite(v)) continue;
      if (k === "maxsize" || k === "singlemax") o.singleMax = v;
      else if (k === "loopmax") o.loopMax = v;
      else if (k === "growth") o.growth = v;
      continue;
    }
    switch (t) {
      case "0":
      case "off":
        return { ...DEFAULTS };
      case "report":
        o.enabled = true;
        o.report = true;
        o.adapters = true;
        o.single = true;
        o.loop = true;
        o.specialise = true;
        break;
      case "1":
      case "on":
        o.enabled = true;
        o.adapters = true;
        o.single = true;
        o.loop = true;
        o.specialise = true;
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
  return o;
}

// ---------------------------------------------------------------------------
// Classification helpers — the parts of the cost model that read NAMES
// ---------------------------------------------------------------------------

/**
 * A `__dc_*` dispatch trampoline. Rule 3: overhead by construction, so it is
 * admitted without consulting any size budget.
 */
export function isAdapter(name: string): boolean {
  return name.startsWith("__dc_");
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
  | "no-rule";

function calleeIsSafe(fn: WasmFunction, results: ValType[]): DeclineReason | null {
  if (fn.body.length === 0) return "unsafe:empty-body";
  if (results.length > 1) return "unsafe:multi-result";
  let bad: DeclineReason | null = null;
  forEachInstr(fn.body, (i) => {
    if (bad) return;
    if (i.op === "return_call" || i.op === "return_call_ref") bad = "unsafe:return-call";
    else if (i.op === "try" || i.op === "rethrow") bad = "unsafe:try";
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
  let counterGlobalIdx = -1;
  if (opts.count && !opts.report) {
    counterGlobalIdx = ctx.numImportGlobals + mod.globals.length;
    mod.globals.push({
      name: "__ir_inline_execs",
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
    mod.exports.push({ name: "__ir_inline_execs", desc: { kind: "global", index: counterGlobalIdx } });
  }

  // --- snapshot every body: inlining is SINGLE-LEVEL -----------------------
  // Callee bodies are read from this snapshot, so a function that has itself
  // had callees inlined into it still contributes its ORIGINAL body. That
  // bounds growth to one level and removes any need for a cycle check beyond
  // direct self-recursion.
  //
  // The clone is DEEP, and that is load-bearing: a shallow `f.body` alias makes
  // the pass silently iterative in `mod.functions` order — inlining A into B
  // and then the already-inflated B into C. Measured on acorn with all rules
  // on, the alias grew the module by 243,492 instructions where single-level
  // costs 137,072, i.e. 78 % of the growth came from an order-dependent
  // transitive effect nobody had asked for. It is not unsound (the relocation
  // is uniform over the whole local space, which the alias also widens), but it
  // is unpredictable and unbudgetable, so it is not what this pass does.
  const snapshot = mod.functions.map((f) => ({ body: f.body.map(cloneInstr), locals: [...f.locals] }));

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

  for (let ci = 0; ci < mod.functions.length; ci++) {
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
        const calleeBody = snapshot[cp].body;
        const unsafe = calleeIsSafe({ ...callee, body: calleeBody }, calleeType.results);
        if (unsafe) {
          declined(callee.name, unsafe);
          continue;
        }

        const nParams = calleeType.params.length;
        const siteCost = nParams + 2;
        const rawSize = countInstrs(calleeBody);
        const effSize = effectiveSize(calleeBody);
        const isLeaf = !hasCall(calleeBody);

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

        let rule: string | null = null;
        if (opts.adapters && isAdapter(callee.name)) rule = "adapter";
        else if (opts.specialise && specSize <= siteCost) rule = "specialised";
        else if (opts.single && callerCount[cp] === 1 && !addressTaken[cp] && effSize <= opts.singleMax)
          rule = "single-caller";
        else if (opts.loop && weight >= LOOP_WEIGHT && isLeaf && effSize <= loopBudget) rule = "loop-leaf";

        if (!rule) {
          declined(callee.name, "no-rule");
          continue;
        }
        if (growth + rawSize > opts.growth) {
          declined(callee.name, "growth-cap");
          continue;
        }
        bump(stats.byRule, rule);
        bump(stats.byRule, `${rule}:${calleeFamily(callee.name)}`);
        stats.inlined++;
        growth += rawSize - 1;
        stats.addedInstrs += rawSize - 1;
        if (opts.report) continue;

        // ---- the rewrite --------------------------------------------------
        const base = callerType.params.length + caller.locals.length;
        const fresh: LocalDef[] = [];
        for (let p = 0; p < nParams; p++)
          fresh.push({ name: `__inl${stats.inlined}_p${p}`, type: calleeType.params[p] });
        // The callee's locals come from the SNAPSHOT too: `callee.locals` is
        // live and may already carry another inline's temporaries, which would
        // not match `calleeBody`'s (snapshotted) local index space.
        for (const l of snapshot[cp].locals) fresh.push({ name: `__inl${stats.inlined}_${l.name}`, type: l.type });
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

function report(stats: Stats, opts: InlineOptions, mod: WasmModule): void {
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
