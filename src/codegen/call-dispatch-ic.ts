// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Call-dispatch DEVIRTUALIZATION — inline every filled fixed-arity
 * `__call_m_<name>_<arity>` dispatcher's OUTERMOST guard + arm at the call
 * site.
 *
 * The `__call_m` dispatcher family is the largest remaining executed-call
 * block on the acorn self-parse: 103,652 calls across 24 dispatchers
 * (`test_1` 29,117; `call_2` 20,680; `currentVarScope_0` 17,931;
 * `parseSubscript_7` 17,091; `push_1` 12,652; …). Every one of those calls
 * walks a guard ladder whose OUTERMOST arm is — by the fill's own wrap order
 * (closed-method-dispatch.ts) — the measured-hot one: the `$NativeRegExp`
 * `.test` brand (#3507), the closure-receiver `.call` fast arm (#4185), the
 * #3673 round-13 cached direct-call arm, the vec push/indexOf brand arms.
 * `wasm-opt` cannot inline the dispatchers (they call), so the ladder head is
 * paid on every dispatch.
 *
 * This finalize pass copies the dispatcher's outermost guard chain and hit
 * arm VERBATIM to each `call` site, with the unmodified dispatcher call as
 * the miss arm — one generic transform over the fill-emitted body shape, no
 * per-family logic:
 *
 *     <recv> <arg0> … <argN-1>          ;; the site's original operands
 *     local.set $aN-1 … local.set $a0 ; local.set $r    ;; SET, never tee
 *     block (result externref)
 *       local.get $r ; any.convert_extern ; local.set $any
 *       <guard chain, copied verbatim, locals re-homed>
 *       if (result externref)
 *         <outermost arm, copied verbatim; `return` -> depth-tracked `br`>
 *       else
 *         local.get $r ; local.get $a0 … ; call $__call_m_<name>_<arity>
 *       end
 *     end
 *
 * ## Why a wrong guess cannot be a wrong answer
 *
 * 1. **Nothing here is written by this pass.** The accepted body shape is
 *    exactly what `fillClosedMethodDispatch` emits —
 *    `local.get 0 ; any.convert_extern ; local.set <__any> ; <guards> ;
 *    if (result externref) then=HIT else=REST` — and the guard chain + hit
 *    arm are copied instruction-for-instruction. Any dispatcher whose body
 *    deviates from that shape is declined wholesale; the pass cannot copy an
 *    arm it did not fully recognise the frame of.
 * 2. **The label stack is recreated, not translated.** At the site, the
 *    wrapping `block (result externref)` stands in for the dispatcher's
 *    implicit function frame and the recreated `if` stands in for the body's
 *    outermost `if`, so every verbatim arm-internal `br`/`br_if` resolves to
 *    the same frame it did in the dispatcher. The single construct that has
 *    no in-place equivalent — `return` — is rewritten to a depth-tracked
 *    `br` to the wrapping block (the function-frame stand-in). Anything the
 *    recreated stack cannot reproduce — a branch escaping past the function
 *    frame, any `br_table`, any `return_call`/`return_call_ref` — declines
 *    the dispatcher wholesale.
 * 3. **The miss arm is the unmodified dispatcher call** with the original
 *    operands re-materialised from the site locals, so every value the copied
 *    guard does not claim reaches exactly today's dispatcher and the site's
 *    answer set is IDENTICAL to the dispatcher's.
 * 4. **Locals are re-homed onto site-minted twins** (params 0..arity onto the
 *    captured receiver/argument locals, `__any` + scratch onto typed twins
 *    cloned from the dispatcher's own declarations). Every scratch read in
 *    the fill-emitted arms is dominated by a write inside the copied region
 *    (`local.tee`/`local.set` before any `local.get` on every path), so twin
 *    reuse across sites cannot observe a stale value — the same property the
 *    dispatcher itself relies on across calls is what makes the copy sound.
 * 5. **Only `op: "call"` sites are rewritten.** A dispatcher invoked via
 *    `return_call` stays as-is (the known ~105-call residual): the transform
 *    needs a continuation to run the miss arm in, which a tail call does not
 *    have.
 *
 * Out of scope (deliberate): `__call_fn_method_<K>` (the funcref ladder),
 * `__named_this_call_*`, and the `__call_m_<name>_vararg` dispatchers.
 *
 * ## Flag — DEFAULT OFF
 *
 * `JS2WASM_CALL_DISPATCH_IC` unset / "" / `0` / `off` / `false` / `no`
 * (trimmed, case-insensitive) → the pass returns before touching anything and
 * the binary is byte-identical (sha256-verified) to base.
 *   - any other value: rewrite every eligible site
 *   - `JS2WASM_CALL_DISPATCH_IC_DEBUG=1` stderr stats (armed dispatchers,
 *     patched sites, per-reason declines)
 *   - `JS2WASM_CALL_DISPATCH_IC_POISON=1` **deliberately corrupts the inlined
 *     hit arm** (replaces it with `unreachable`). A workload whose answer is
 *     unchanged under poison did not execute the fast path — the only way to
 *     tell a real null from a mechanism that never fired (#4157 entry 22).
 *     Poison without the main flag is inert.
 *
 * MUST run at the same finalize point as `inlineExternGetCallSites` — after
 * every `__call_m_*` body fill and BEFORE dead-code elimination / the census
 * installs — so the `typeIdx`/`funcIdx` operands it copies stay in the
 * helper's own regime. Helper bodies are found BY NAME over
 * `ctx.mod.functions` (funcMap holds mint-time handles, not list positions —
 * the alloc-census trap), while call SITES are matched against the mint-time
 * handle from `ctx.funcMap`, which is what the emitted `call` instrs carry.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** True when `JS2WASM_CALL_DISPATCH_IC` requests the rewrite. DEFAULT OFF. */
function enabled(): boolean {
  const raw = (process.env.JS2WASM_CALL_DISPATCH_IC ?? "").trim().toLowerCase();
  return !(raw === "" || raw === "0" || raw === "off" || raw === "false" || raw === "no");
}

type AnyInstr = Instr & {
  op: string;
  index?: number;
  funcIdx?: number;
  depth?: number;
  body?: Instr[];
  then?: Instr[];
  else?: Instr[];
  catches?: { body?: Instr[] }[];
  catchAll?: Instr[];
  blockType?: { kind: string; type?: ValType };
};

/** The recognised fill-emitted dispatcher body, split for the copy. */
interface DispatcherPlan {
  /** Mint-time handle the emitted `call` instrs carry (from ctx.funcMap). */
  callIdx: number;
  /** Declared args (receiver excluded). */
  arity: number;
  /** Everything between the `local.set <__any>` prologue and the final `if`. */
  guards: Instr[];
  /** The final `if`'s then — the outermost (hot) arm. */
  arm: Instr[];
  /** Dispatcher-local index -> ValType for every local the copy references. */
  localTypes: Map<number, ValType>;
}

/**
 * Scan a to-be-copied region for constructs the site cannot reproduce.
 * `outDepth` is the depth at which the wrapping block will sit when the copy
 * runs (0 at guard-chain top level, 1 at arm top level). Collects every
 * referenced local index into `used`. Returns a decline reason or undefined.
 */
function scanRegion(instrs: Instr[], outDepth: number, used: Set<number>): string | undefined {
  for (const instr of instrs) {
    const a = instr as AnyInstr;
    switch (a.op) {
      case "br_table":
        return "br_table";
      case "return_call":
      case "return_call_ref":
        return "tail-call";
      case "try":
      case "try_table":
        // A try frame's catch-label bookkeeping is not modelled by the plain
        // depth recreation below; the fills never emit one in a dispatcher.
        return "try-frame";
      case "br":
      case "br_if":
        // Depths 0..outDepth-1 target frames inside the copied region or the
        // recreated `if`; depth == outDepth would target the dispatcher's
        // implicit function frame — reproduced by the wrapping block, but a
        // branch carrying the result there is exactly what `return` is
        // rewritten into, so a VERBATIM br at that depth (`br_if` especially,
        // which would fall through with a different stack) is out of the
        // recognised fill shape. Decline past-the-if depths wholesale.
        if ((a.depth ?? 0) >= outDepth) return "escaping-branch";
        break;
      case "local.get":
      case "local.set":
      case "local.tee":
        if (a.index !== undefined) used.add(a.index);
        break;
    }
    if (Array.isArray(a.body)) {
      const r = scanRegion(a.body, outDepth + 1, used);
      if (r) return r;
    }
    if (Array.isArray(a.then)) {
      const r = scanRegion(a.then, outDepth + 1, used);
      if (r) return r;
    }
    if (Array.isArray(a.else)) {
      const r = scanRegion(a.else, outDepth + 1, used);
      if (r) return r;
    }
  }
  return undefined;
}

/**
 * Length of the standalone/WASI nullish-receiver TypeError guard that #4394
 * prepends to a filled dispatcher body, or 0 when absent (host lane, `.then`,
 * or the machinery never reserved). Shape, from
 * `closed-method-dispatch.ts:nullishReceiverGuardInstrs`:
 *
 *   local.get 0 ; [call $__nullish_to_null] ; ref.is_null ; if (empty) { throw }
 *
 * Matched EXACTLY — the real prologue's second instr is `any.convert_extern`,
 * never `call`/`ref.is_null`, so the two shapes cannot be confused, and an
 * unrecognised prefix still declines as `prologue` rather than being skipped.
 *
 * The guard is deliberately NOT copied to the call site. A nullish receiver
 * fails the copied arm's type test and falls through to the else arm — which
 * is the unmodified dispatcher call, guard included — so the TypeError is
 * still thrown, by the dispatcher, exactly as before.
 */
function nullishGuardPrefixLength(body: Instr[]): number {
  const b0 = body[0] as AnyInstr | undefined;
  if (!b0 || b0.op !== "local.get" || b0.index !== 0) return 0;
  let i = 1;
  if ((body[i] as AnyInstr | undefined)?.op === "call") i++;
  if ((body[i] as AnyInstr | undefined)?.op !== "ref.is_null") return 0;
  i++;
  const iff = body[i] as AnyInstr | undefined;
  if (!iff || iff.op !== "if" || iff.blockType?.kind !== "empty") return 0;
  return i + 1;
}

/**
 * Recognise one FILLED fixed-arity dispatcher body and build its copy plan.
 * Returns a decline reason string instead when the body is not the exact
 * fill-emitted shape (placeholder `unreachable` stubs decline as `too-short`).
 */
function analyzeDispatcher(
  ctx: CodegenContext,
  fn: WasmFunction,
  callIdx: number,
  arity: number,
): DispatcherPlan | string {
  const t = ctx.mod.types[fn.typeIdx];
  if (!t || t.kind !== "func") return "no-func-type";
  if (t.params.length !== arity + 1 || t.params.some((p) => p.kind !== "externref")) return "param-shape";
  if (t.results.length !== 1 || t.results[0]!.kind !== "externref") return "result-shape";

  const body = fn.body;
  const skip = nullishGuardPrefixLength(body);
  if (body.length < skip + 4) return "too-short";
  const anyLocalIdx = arity + 1;
  const p0 = body[skip] as AnyInstr;
  const p1 = body[skip + 1] as AnyInstr;
  const p2 = body[skip + 2] as AnyInstr;
  if (p0.op !== "local.get" || p0.index !== 0) return "prologue";
  if (p1.op !== "any.convert_extern") return "prologue";
  if (p2.op !== "local.set" || p2.index !== anyLocalIdx) return "prologue";
  if (fn.locals[0]?.type.kind !== "anyref") return "any-local-type";

  const last = body[body.length - 1] as AnyInstr;
  if (
    last.op !== "if" ||
    last.blockType?.kind !== "val" ||
    last.blockType.type?.kind !== "externref" ||
    !Array.isArray(last.then) ||
    last.then.length === 0 ||
    !Array.isArray(last.else) ||
    last.else.length === 0
  ) {
    return "no-outer-if";
  }

  const guards = body.slice(skip + 3, -1);
  const arm = last.then;
  const used = new Set<number>();
  used.add(anyLocalIdx); // the copied prologue always writes it
  const guardReason = scanRegion(guards, 0, used);
  if (guardReason) return `guard-${guardReason}`;
  const armReason = scanRegion(arm, 1, used);
  if (armReason) return `arm-${armReason}`;

  const localTypes = new Map<number, ValType>();
  for (const idx of used) {
    if (idx <= arity) {
      localTypes.set(idx, { kind: "externref" });
      continue;
    }
    const decl = fn.locals[idx - (arity + 1)];
    if (!decl) return "unknown-local";
    localTypes.set(idx, decl.type);
  }
  return { callIdx, arity, guards, arm, localTypes };
}

/** Per-(function, dispatcher) twins: dispatcher-local index -> site local. */
type Twins = Map<number, number>;

/**
 * Copy a region verbatim: locals re-homed through `twins`, `return` rewritten
 * to `br outDepth` (the wrapping block — the dispatcher's function-frame
 * stand-in). `outDepth` grows by one per structured frame, exactly mirroring
 * the depth accounting `scanRegion` validated.
 */
function copyRegion(src: Instr[], twins: Twins, outDepth: number): Instr[] {
  const out: Instr[] = [];
  for (const instr of src) {
    const a = instr as AnyInstr;
    if (a.op === "return") {
      out.push({ op: "br", depth: outDepth });
      continue;
    }
    if ((a.op === "local.get" || a.op === "local.set" || a.op === "local.tee") && a.index !== undefined) {
      const idx = twins.get(a.index);
      if (idx === undefined) throw new Error(`call-dispatch-ic: unmapped local ${a.index}`);
      out.push({ ...a, index: idx } as Instr);
      continue;
    }
    const copy = { ...a } as AnyInstr;
    if (Array.isArray(a.body)) copy.body = copyRegion(a.body, twins, outDepth + 1);
    if (Array.isArray(a.then)) copy.then = copyRegion(a.then, twins, outDepth + 1);
    if (Array.isArray(a.else)) copy.else = copyRegion(a.else, twins, outDepth + 1);
    out.push(copy as Instr);
  }
  return out;
}

interface Stats {
  armed: number;
  patched: number;
  fnsTouched: number;
  declines: Map<string, number>;
}

/** Rewrite one instruction array in place, recursing into nested bodies. */
function rewriteInstrs(
  instrs: Instr[],
  plans: Map<number, DispatcherPlan>,
  twinsFor: (plan: DispatcherPlan) => Twins,
  poison: boolean,
  stats: Stats,
): number {
  let patched = 0;
  const out: Instr[] = [];
  for (const instr of instrs) {
    const a = instr as AnyInstr;
    if (Array.isArray(a.body)) patched += rewriteInstrs(a.body, plans, twinsFor, poison, stats);
    if (Array.isArray(a.then)) patched += rewriteInstrs(a.then, plans, twinsFor, poison, stats);
    if (Array.isArray(a.else)) patched += rewriteInstrs(a.else, plans, twinsFor, poison, stats);
    if (Array.isArray(a.catches)) {
      for (const c of a.catches)
        if (Array.isArray(c.body)) patched += rewriteInstrs(c.body, plans, twinsFor, poison, stats);
    }
    if (Array.isArray(a.catchAll)) patched += rewriteInstrs(a.catchAll, plans, twinsFor, poison, stats);

    // Only plain `call` sites — a `return_call` has no continuation for the
    // miss arm and is left on the dispatcher (the known residual).
    if (a.op !== "call" || a.funcIdx === undefined || !plans.has(a.funcIdx)) {
      out.push(instr);
      continue;
    }
    const plan = plans.get(a.funcIdx)!;
    const twins = twinsFor(plan);
    const recv = twins.get(0)!;

    // Capture the site's operands. local.SET, never tee — a tee would leave a
    // duplicate under the block result (the extern-get-ic "type error in
    // fallthru" lesson). The args sit above the receiver, so pop them in
    // reverse declaration order.
    for (let arg = plan.arity - 1; arg >= 0; arg--) {
      out.push({ op: "local.set", index: twins.get(1 + arg)! });
    }
    out.push({ op: "local.set", index: recv });

    const miss: Instr[] = [{ op: "local.get", index: recv }];
    for (let arg = 0; arg < plan.arity; arg++) miss.push({ op: "local.get", index: twins.get(1 + arg)! });
    miss.push(instr); // the unmodified dispatcher call

    out.push({
      op: "block",
      blockType: { kind: "val", type: { kind: "externref" } },
      body: [
        // The dispatcher's own prologue, re-homed.
        { op: "local.get", index: recv },
        { op: "any.convert_extern" },
        { op: "local.set", index: twins.get(plan.arity + 1)! },
        ...copyRegion(plan.guards, twins, 0),
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: poison ? [{ op: "unreachable" }] : copyRegion(plan.arm, twins, 1),
          else: miss,
        },
      ],
    });
    patched++;
    stats.patched++;
  }
  instrs.length = 0;
  instrs.push(...out);
  return patched;
}

/**
 * (#4157) Devirtualize the fixed-arity `__call_m_<name>_<arity>` dispatchers:
 * copy each armed dispatcher's outermost guard + arm to every plain `call`
 * site, with the unmodified dispatcher call as the miss arm.
 *
 * No-op unless `JS2WASM_CALL_DISPATCH_IC` is set (see the header).
 */
export function inlineCallDispatchSites(ctx: CodegenContext): void {
  if (!enabled()) return; // DEFAULT OFF — byte-identical to base.
  const debug = process.env.JS2WASM_CALL_DISPATCH_IC_DEBUG === "1";
  const poison = process.env.JS2WASM_CALL_DISPATCH_IC_POISON === "1";

  const stats: Stats = { armed: 0, patched: 0, fnsTouched: 0, declines: new Map() };
  const decline = (name: string, reason: string): void => {
    stats.declines.set(reason, (stats.declines.get(reason) ?? 0) + 1);
    if (debug) process.stderr.write(`[call-dispatch-ic] declined ${name}: ${reason}\n`);
  };

  // Find every FILLED fixed-arity dispatcher BY NAME over the defined-function
  // list (funcMap handles are mint-time, not list positions), memoizing one
  // analysis per dispatcher. The name regex takes the LAST `_<digits>` run as
  // the arity — exactly how `dispatcherName` mangles — and never matches the
  // `_vararg` twins; `__call_fn_method_*`/`__named_this_call_*` don't carry
  // the `__call_m_` prefix at all.
  const plans = new Map<number, DispatcherPlan>();
  for (const fn of ctx.mod.functions) {
    const m = /^__call_m_.+_(\d+)$/.exec(fn.name);
    if (!m) continue;
    const callIdx = ctx.funcMap.get(fn.name);
    if (callIdx === undefined) {
      decline(fn.name, "no-funcmap-handle");
      continue;
    }
    const plan = analyzeDispatcher(ctx, fn, callIdx, Number.parseInt(m[1]!, 10));
    if (typeof plan === "string") {
      decline(fn.name, plan);
      continue;
    }
    plans.set(callIdx, plan);
    stats.armed++;
  }
  if (plans.size === 0) {
    if (debug) process.stderr.write(`[call-dispatch-ic] no armed dispatchers — nothing to do\n`);
    return;
  }

  for (const fn of ctx.mod.functions) {
    // Never patch inside the dispatcher family itself: the copied guard has
    // already run (or is about to) on that path — pure tax by construction.
    if (fn.name.startsWith("__call_m_")) continue;
    const ty = ctx.mod.types[fn.typeIdx];
    const nparams = ty && ty.kind === "func" ? ty.params.length : 0;
    // One twin set per dispatcher per function, shared across that function's
    // sites (sound: every scratch read in the copied region is dominated by a
    // write inside it — see header point 4).
    const cache = new Map<DispatcherPlan, Twins>();
    const twinsFor = (plan: DispatcherPlan): Twins => {
      let twins = cache.get(plan);
      if (twins) return twins;
      twins = new Map();
      for (const [idx, type] of plan.localTypes) {
        twins.set(idx, nparams + fn.locals.length);
        fn.locals.push({ name: `__cd${plan.callIdx}_${idx}`, type });
      }
      cache.set(plan, twins);
      return twins;
    };
    if (rewriteInstrs(fn.body, plans, twinsFor, poison, stats) > 0) stats.fnsTouched++;
  }

  if (debug) {
    const declineStr = [...stats.declines].map(([r, n]) => `${r}=${n}`).join(" ");
    process.stderr.write(
      `[call-dispatch-ic] armed-dispatchers=${stats.armed} patched-sites=${stats.patched} ` +
        `functions=${stats.fnsTouched}${declineStr ? ` declined: ${declineStr}` : ""}` +
        `${poison ? " POISON=ON" : ""}\n`,
    );
  }
}
