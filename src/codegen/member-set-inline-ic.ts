// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) INLINE the monomorphic fast path of a dynamic property WRITE at the
 * CALL SITE — the write-side twin of `member-get-inline-ic.ts`.
 *
 * ## What it does
 *
 * A dynamic (`any`-receiver, static-name) property write compiles today to
 *
 *     <receiver: externref>
 *     <value: externref | f64>
 *     call $__set_member_<name>            ;; -> (nothing)
 *
 * and the dispatcher's FIRST arm is already the map check: `ref.test $S` /
 * `ref.cast $S` / `<coerce>` / `struct.set $S <slot>`. This pass moves that
 * first arm to the site:
 *
 *     local.set  $__sic_v                  ;; value  (typed: externref or f64)
 *     any.convert_extern                   ;; receiver
 *     local.set  $__sic_r
 *     local.get  $__sic_r
 *     ref.test   $S0
 *     if
 *       <first arm, copied VERBATIM; locals 2/1 re-homed to $__sic_r/$__sic_v>
 *     else
 *       local.get $__sic_r ; extern.convert_any
 *       local.get $__sic_v
 *       call $__set_member_<name>          ;; the unmodified dispatcher
 *     end
 *
 * ## Why a wrong guess cannot be a wrong answer
 *
 * 1. **The arm is not written here.** `extractFirstSetArm` reads it out of the
 *    dispatcher body `fillMemberSetDispatch` / `fillTypedMemberSetF64Dispatch`
 *    emitted, and copies it verbatim with only its two locals re-homed. It is
 *    NOT re-derived from `findAlternateStructsForField` — a second derivation
 *    could drift in candidate ORDER against the dispatcher (the correctness
 *    argument of the ladder is first-match-wins), whereas a copy cannot.
 * 2. **The extractor is strict.** It accepts only the plain first-arm shape
 *    (`local.get 2 ; ref.cast $S ; local.get 1 ; <relocatable coerce tail> ;
 *    struct.set $S <slot>`). A `$shape`-stamped arm, a (#3780) presence-bit
 *    arm, a ref-field runtime-brand-guarded arm, a (#3927) cold/layout/resid
 *    first arm, and an empty-candidate dispatcher all fail the pattern and the
 *    dispatcher DECLINES WHOLESALE — a declined site keeps today's plain call;
 *    there is no half-copy.
 * 3. **The `else` arm is the unmodified dispatcher call** with the original
 *    operands, so the site's answer set is IDENTICAL to the dispatcher's, not
 *    a subset of it (the #2674 property). A receiver that satisfies the inline
 *    `ref.test $S0` would have taken the dispatcher's first arm — `ref.test`
 *    is subtype-inclusive and structurally identical structs share one
 *    canonical heap type, so speculating only on `candidates[0]` needs no
 *    subtyping reasoning at all.
 *
 * ## Operand capture — `local.set`, NEVER `local.tee`
 *
 * The value operand sits on top of the receiver at the call site. BOTH are
 * captured with typed `local.set` scratch locals. A tee would leave a value on
 * the stack under the `if`'s frame — an extra value that surfaces as "type
 * error in fallthru" at whatever consumer sits downstream (the exact bug
 * documented in `extern-get-inline-ic.ts`). No producer-shape analysis is
 * needed: the dispatcher's `(externref, externref|f64)` signature guarantees
 * the operand types, whatever produced them.
 *
 * ## Flag — DEFAULT OFF
 *
 * `JS2WASM_SET_MEMBER_IC` unset / `""` / `0` / `off` / `false` / `no`
 * (trimmed, case-insensitive) → the pass returns before touching anything and
 * the binary is byte-identical (sha256-verified) to base.
 *   - integer `N >= 2`  speculate at dispatchers with up to N candidate arms
 *   - `=1` / `=on` / other truthy  the default candidate cap (8)
 *   - `JS2WASM_SET_MEMBER_IC_DEBUG=1`  stderr stats + per-reason decline
 *     histogram (body-shape / arm-shape / arm-tail / polymorphic); the pass is
 *     SILENT otherwise
 *   - `JS2WASM_SET_MEMBER_IC_POISON=1`  **deliberately corrupts the hit arm**
 *     (replaces it with `unreachable`). A workload whose answer is unchanged
 *     under poison did not execute the fast path — the only way to tell a real
 *     null result from a mechanism that never fired (#4157 entry 22).
 *
 * The `__set_member_<name>__f64` typed twins (#4157 slice A) are included only
 * when `JS2WASM_SET_MEMBER_F64` is itself on — their value scratch is f64 and
 * their plain arm has no coerce tail at all.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { setMemberF64Enabled } from "./member-set-f64.js";

type AnyInstr = Instr & {
  op: string;
  index?: number;
  funcIdx?: number;
  typeIdx?: number;
  body?: Instr[];
  then?: Instr[];
  else?: Instr[];
  catches?: { body?: Instr[] }[];
  catchAll?: Instr[];
  blockType?: { kind: string; type?: ValType };
};

/** Candidate cap, or 0 when the pass is off. */
function icCap(): number {
  const raw = process.env.JS2WASM_SET_MEMBER_IC;
  if (raw === undefined) return 0;
  const t = raw.trim().toLowerCase();
  if (t === "" || t === "0" || t === "off" || t === "false" || t === "no") return 0;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) && n >= 2 ? n : 8;
}

/** One speculation: the dispatcher call this shadows, and the arm to copy. */
interface SetIcPlan {
  structTypeIdx: number;
  /** The dispatcher's first `then` arm, verbatim. Locals: 1 = val, 2 = __any. */
  arm: Instr[];
  /** The value operand's wasm type — externref (generic) or f64 (typed twin). */
  valKind: "externref" | "f64";
}

/**
 * True when `instr` can be copied out of the dispatcher's arm tail unchanged:
 * no local references (the re-homing map covers only locals 1 and 2, which the
 * arm frame pins), no structured children, no branches/returns (a `br` depth or
 * a `return` means something different at the site). Calls and pure numeric /
 * ref conversions — everything `coercionInstrs` emits for an
 * externref→fieldType unbox — pass.
 */
function isRelocatableTailInstr(a: AnyInstr): boolean {
  if (a.op.startsWith("local.")) return false;
  if (Array.isArray(a.body) || Array.isArray(a.then) || Array.isArray(a.else) || Array.isArray(a.catches)) {
    return false;
  }
  if (a.op === "br" || a.op === "br_if" || a.op === "br_table") return false;
  if (a.op === "return" || a.op === "return_call" || a.op === "return_call_ref") return false;
  if (a.op === "unreachable") return false;
  return true;
}

/**
 * Strict-match the dispatcher body and extract its first candidate arm, or a
 * decline reason. The accepted body is EXACTLY what `fillMemberSetDispatch` /
 * `fillTypedMemberSetF64Dispatch` emit for a non-empty candidate list:
 *
 *     local.get 0 ; any.convert_extern ; local.set 2      ;; the __any prologue
 *     local.get 2 ; ref.test $S0 ; if { then <arm> else <rest> }
 *
 * and the accepted first arm is the PLAIN shape only (see the file header).
 * The candidate count for the polymorphism cap is read off the emitted
 * `else`-chain, not re-derived from the type table.
 */
function extractFirstSetArm(fn: WasmFunction, cap: number): { structTypeIdx?: number; arm?: Instr[]; reason?: string } {
  const b = fn.body as AnyInstr[];
  if (b.length !== 6) return { reason: "body-shape" };
  const [i0, i1, i2, i3, i4, i5] = b as [AnyInstr, AnyInstr, AnyInstr, AnyInstr, AnyInstr, AnyInstr];
  if (i0.op !== "local.get" || i0.index !== 0) return { reason: "body-shape" };
  if (i1.op !== "any.convert_extern") return { reason: "body-shape" };
  if (i2.op !== "local.set" || i2.index !== 2) return { reason: "body-shape" };
  if (i3.op !== "local.get" || i3.index !== 2) return { reason: "body-shape" };
  if (i4.op !== "ref.test" || i4.typeIdx === undefined) return { reason: "body-shape" };
  if (i5.op !== "if" || i5.blockType?.kind !== "empty" || !Array.isArray(i5.then)) return { reason: "body-shape" };

  // Candidate count = length of the contiguous `local.get 2 ; ref.test ; if`
  // else-chain. Anything else (sidecar terminal, #3927 layout/resid tests)
  // ends the count — those arms stay behind the unmodified call either way.
  let count = 1;
  let els = i5.else;
  while (Array.isArray(els) && els.length === 3) {
    const [e0, e1, e2] = els as [AnyInstr, AnyInstr, AnyInstr];
    if (e0.op !== "local.get" || e0.index !== 2 || e1.op !== "ref.test" || e2.op !== "if") break;
    count++;
    els = e2.else;
  }
  if (count > cap) return { reason: "polymorphic" };

  const t = i5.then as AnyInstr[];
  if (t.length < 4) return { reason: "arm-shape" };
  const a0 = t[0]!;
  const a1 = t[1]!;
  const a2 = t[2]!;
  const last = t[t.length - 1]!;
  if (a0.op !== "local.get" || a0.index !== 2) return { reason: "arm-shape" };
  if (a1.op !== "ref.cast" || a1.typeIdx !== i4.typeIdx) return { reason: "arm-shape" };
  if (a2.op !== "local.get" || a2.index !== 1) return { reason: "arm-shape" };
  if (last.op !== "struct.set" || last.typeIdx !== i4.typeIdx) return { reason: "arm-shape" };
  for (let k = 3; k < t.length - 1; k++) {
    if (!isRelocatableTailInstr(t[k]!)) return { reason: "arm-tail" };
  }
  return { structTypeIdx: i4.typeIdx, arm: i5.then };
}

/** Per-function scratch locals, allocated lazily and shared across sites. */
interface SiteLocals {
  any: number;
  valExt: number;
  valF64: number;
}

interface Stats {
  patched: number;
}

/** Rewrite one instruction array in place, recursing into nested bodies. */
function rewriteInstrs(
  fn: WasmFunction,
  instrs: Instr[],
  plans: Map<number, SetIcPlan>,
  scratch: (kind: "externref" | "f64") => { any: number; val: number },
  poison: boolean,
  stats: Stats,
): void {
  const out: Instr[] = [];
  for (const instr of instrs) {
    const a = instr as AnyInstr;
    if (Array.isArray(a.body)) rewriteInstrs(fn, a.body, plans, scratch, poison, stats);
    if (Array.isArray(a.then)) rewriteInstrs(fn, a.then, plans, scratch, poison, stats);
    if (Array.isArray(a.else)) rewriteInstrs(fn, a.else, plans, scratch, poison, stats);
    if (Array.isArray(a.catches)) {
      for (const c of a.catches) if (Array.isArray(c.body)) rewriteInstrs(fn, c.body, plans, scratch, poison, stats);
    }
    if (Array.isArray(a.catchAll)) rewriteInstrs(fn, a.catchAll, plans, scratch, poison, stats);

    const plan = a.op === "call" && a.funcIdx !== undefined ? plans.get(a.funcIdx) : undefined;
    if (!plan) {
      out.push(instr);
      continue;
    }
    const s = scratch(plan.valKind);
    // Copy the arm, re-homing the dispatcher's locals onto the site's scratch.
    // The extractor proved the arm touches ONLY locals 1 (val) and 2 (__any).
    const arm = plan.arm.map((src) => {
      const c = { ...(src as AnyInstr) };
      if ((c.op === "local.get" || c.op === "local.set" || c.op === "local.tee") && c.index !== undefined) {
        if (c.index !== 1 && c.index !== 2) throw new Error(`member-set-ic: unmapped local ${c.index}`);
        c.index = c.index === 2 ? s.any : s.val;
      }
      return c as Instr;
    });
    out.push({ op: "local.set", index: s.val }); // value  (top of stack)
    out.push({ op: "any.convert_extern" }); // receiver (externref by signature)
    out.push({ op: "local.set", index: s.any });
    out.push({ op: "local.get", index: s.any });
    out.push({ op: "ref.test", typeIdx: plan.structTypeIdx });
    out.push({
      op: "if",
      blockType: { kind: "empty" },
      then: poison ? [{ op: "unreachable" }] : arm,
      else: [
        { op: "local.get", index: s.any },
        { op: "extern.convert_any" },
        { op: "local.get", index: s.val },
        instr, // the unmodified dispatcher call
      ],
    });
    stats.patched++;
  }
  instrs.length = 0;
  instrs.push(...out);
}

/**
 * (#4157) Inline the member-WRITE fast path at every eligible
 * `call $__set_member_<name>` / `__set_member_nonstrict_<name>` (and, when
 * `JS2WASM_SET_MEMBER_F64` is on, their `__f64` twin) site.
 *
 * MUST run AFTER `fillMemberSetDispatch` / `fillTypedMemberSetF64Dispatch`
 * (the arm it copies is defined by those fills) and BEFORE any pass that
 * remaps type or function indices (`brandCollidingShapeTypes`, dead
 * elimination), so the `typeIdx`/`funcIdx` operands it copies stay in the
 * dispatcher's own regime. No-op unless `JS2WASM_SET_MEMBER_IC` is set.
 */
export function inlineMemberSetCallSites(ctx: CodegenContext): void {
  const cap = icCap();
  if (cap <= 0) return; // DEFAULT OFF — byte-identical to base.
  const debug = process.env.JS2WASM_SET_MEMBER_IC_DEBUG === "1";
  const poison = process.env.JS2WASM_SET_MEMBER_IC_POISON === "1";

  const plans = new Map<number, SetIcPlan>();
  const declines = new Map<string, number>();
  const decline = (r: string): void => {
    declines.set(r, (declines.get(r) ?? 0) + 1);
  };

  // Per-dispatcher analysis runs ONCE here (memoized into `plans`); the module
  // walk below only does Map lookups per call instr. No body is cloned except
  // the one first arm per patched site.
  const consider = (name: string, valKind: "externref" | "f64"): void => {
    // Site matching uses the funcMap handle (the funcIdx baked into `call`
    // operands); the BODY is found BY NAME over ctx.mod.functions — funcMap
    // holds mint-time handles, not final list positions (the alloc-census /
    // extern-get-ic trap: positional resolution silently lands on an
    // unrelated function).
    const dispIdx = ctx.funcMap.get(name);
    if (dispIdx === undefined) return;
    const fn = ctx.mod.functions.find((f) => f.name === name);
    if (!fn) return;
    // Signature check: (externref, externref|f64) -> (). Disambiguates a
    // property literally named `x__f64` from the typed twin.
    const sig = ctx.mod.types[fn.typeIdx];
    if (
      !sig ||
      sig.kind !== "func" ||
      sig.results.length !== 0 ||
      sig.params.length !== 2 ||
      sig.params[0]?.kind !== "externref" ||
      sig.params[1]?.kind !== valKind
    ) {
      return;
    }
    const { structTypeIdx, arm, reason } = extractFirstSetArm(fn, cap);
    if (arm === undefined || structTypeIdx === undefined) {
      decline(reason ?? "unknown");
      return;
    }
    plans.set(dispIdx, { structTypeIdx, arm, valKind });
  };

  for (const key of ctx.memberSetDispatchNames ?? []) {
    const sep = key.lastIndexOf("\0");
    const propName = sep >= 0 ? key.slice(0, sep) : key;
    const strict = sep >= 0 ? key.slice(sep + 1) === "S" : true;
    consider(strict ? `__set_member_${propName}` : `__set_member_nonstrict_${propName}`, "externref");
  }
  if (setMemberF64Enabled()) {
    for (const name of ctx.funcMap.keys()) {
      if (/^__set_member_(nonstrict_)?(.+)__f64$/.test(name)) consider(name, "f64");
    }
  }

  if (plans.size === 0) {
    if (debug) {
      const hist = [...declines.entries()].sort((x, y) => y[1] - x[1]).map(([r, n]) => `${r}=${n}`);
      process.stderr.write(
        `[set-member-ic] cap=${cap} eligible-dispatchers=0 patched-sites=0 functions=0\n` +
          `[set-member-ic] declined dispatchers: ${hist.join(" ") || "(none)"}\n`,
      );
    }
    return;
  }

  const stats: Stats = { patched: 0 };
  let fnsTouched = 0;
  for (const fn of ctx.mod.functions) {
    // Never patch inside the dispatcher family: the f64 twin's delegate arm
    // calls the generic dispatcher on the path where the arm has ALREADY
    // missed, so a guard there is pure tax by construction.
    if (fn.name.startsWith("__set_member_")) continue;
    const before = stats.patched;
    const locals: SiteLocals = { any: -1, valExt: -1, valF64: -1 };
    const scratch = (kind: "externref" | "f64"): { any: number; val: number } => {
      const t = ctx.mod.types[fn.typeIdx];
      const nparams = t && t.kind === "func" ? t.params.length : 0;
      if (locals.any < 0) {
        locals.any = nparams + fn.locals.length;
        fn.locals.push({ name: "__sic_r", type: { kind: "anyref" } });
      }
      if (kind === "f64") {
        if (locals.valF64 < 0) {
          locals.valF64 = nparams + fn.locals.length;
          fn.locals.push({ name: "__sic_vf", type: { kind: "f64" } });
        }
        return { any: locals.any, val: locals.valF64 };
      }
      if (locals.valExt < 0) {
        locals.valExt = nparams + fn.locals.length;
        fn.locals.push({ name: "__sic_v", type: { kind: "externref" } });
      }
      return { any: locals.any, val: locals.valExt };
    };
    rewriteInstrs(fn, fn.body, plans, scratch, poison, stats);
    if (stats.patched > before) fnsTouched++;
  }

  if (debug) {
    const hist = [...declines.entries()].sort((x, y) => y[1] - x[1]).map(([r, n]) => `${r}=${n}`);
    process.stderr.write(
      `[set-member-ic] cap=${cap} eligible-dispatchers=${plans.size} patched-sites=${stats.patched} ` +
        `functions=${fnsTouched}${poison ? " POISON=ON" : ""}\n` +
        `[set-member-ic] declined dispatchers: ${hist.join(" ") || "(none)"}\n`,
    );
  }
}
