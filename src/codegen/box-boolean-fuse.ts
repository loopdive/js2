// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Unboxed boolean fusion — SINK `__is_truthy` consumption into the
 * materialized logical-value `if` that produced its operand, fusing the
 * `__box_boolean` producers in the arms down to raw i32.
 *
 * ## The shape this pass exists for
 *
 * A logical expression used as a VALUE materializes through an
 * `if (result externref)` merge (`expressions/logical-ops.ts`): each arm ends
 * either in a boxed-boolean producer (`call __box_boolean`, the i32→externref
 * coercion of a comparison result) or in a re-read of the tee'd condition
 * operand (`local.get tmp`, the JS value-semantics arm of `&&`/`||`). When
 * that merged value is then consumed by ToBoolean — `if (a || b) …` — codegen
 * appends `call __is_truthy` right after the merge:
 *
 *     local.tee $tmp            ;; condition operand saved for value semantics
 *     call $__is_truthy         ;; branch condition
 *     if (result externref)
 *       <rhs…> call $__box_boolean   ;; box-call leaf
 *     else
 *       local.get $tmp               ;; cond-reuse leaf
 *     end
 *     call $__is_truthy         ;; ← the sink: consumes the merge immediately
 *
 * The box+truthy pair is a round trip through the boxed representation for a
 * value that was born i32 and dies i32. The fusion rewrites the leaves to keep
 * the raw i32 — box-call leaves drop the `call __box_boolean`; cond-reuse
 * leaves become the constant the branch already proved (`then` ⇒ the condition
 * was truthy ⇒ `i32.const 1`; `else` ⇒ `i32.const 0`) — retypes every `if` in
 * the merge tree to `(result i32)`, and deletes the consuming `__is_truthy`.
 *
 * NOTE the naive ADJACENT pattern (`call __box_boolean; call __is_truthy` in a
 * straight line) basically never occurs — the value flows through an if-merge,
 * which is why the pass is designed around the SINK shape (round-1 measured:
 * fused-sink=162, fused-adjacent=0 on the acorn self-parse).
 *
 * ## Consumers recognized
 *
 * 1. `call __is_truthy` immediately after the merge (the plain sink).
 * 2. The inlined truthy-IC prefix (`is-truthy-inline-ic.ts`, when
 *    `JS2WASM_INLINE_TRUTHY_IC` is also on): the IC claims the call site first
 *    and rewrites it to `any.convert_extern; local.tee $__tr; ref.test T;
 *    if (result i32) … else … call $__is_truthy`. That whole chain answers
 *    exactly "is the merged value truthy", so when every merge leaf fuses, the
 *    chain is deleted wholesale and the raw i32 IS the answer. This pass MUST
 *    therefore run AFTER `inlineIsTruthyCallSites` at the same finalize point.
 *
 * ## Soundness bar
 *
 * A site fuses only when the boxed value is provably consumed ONCE and
 * immediately: the consumer is the very next instruction sequence after the
 * merge (nothing can observe or clobber the value in between — it only ever
 * exists on the wasm stack), and EVERY leaf of the merge tree must fuse or the
 * whole site declines untouched — there is no half-fusion. Cond-reuse leaves
 * additionally require that (a) the merge's own branch condition is literally
 * `local.tee L; call __is_truthy` on the SAME local the leaf re-reads, and
 * (b) nothing anywhere in that arm (including nested blocks/loops/catches —
 * conservative around loop back-edges and catch re-entry, cf. the relocation
 * discipline in `receiver-cse.ts`) writes L before the leaf re-reads it.
 * Cross-function shapes (the arm tail is a call to an externref-returning
 * callee, or the truthy operand arrives through a local) are declined — the
 * dominant residual, closable only by an i32-returning callee twin (a
 * return-type ABI change, out of scope here).
 *
 * `truthy(box_boolean(i)) == i` for the i32 the emitters pass (comparison
 * results and boolean-flagged i32 slots are always 0/1; `__box_boolean` is
 * only ever the BOOLEAN coercion — numbers go through `__box_number`).
 *
 * ## The SINK leaf (#4406 Phase 2) — `JS2WASM_RET_UNBOX_ABI`
 *
 * The "all leaves or nothing" rule above is what makes the arm-tail-call
 * residual expensive: one unspecialisable arm strands every box in the tree,
 * including its sibling's. #4406's return-type ABI closed the residual for the
 * arms whose callee it could retype (a boolean-branded `i32` result makes the
 * arm tail a `__box_boolean` leaf), but it cannot retype every callee — and
 * measured on the acorn self-parse, retyping alone moved the decline tally by
 * two sites.
 *
 * So Phase 2 adds the general leaf the two specialised ones are optimisations
 * of: keep the consumer, but move a COPY of it INTO the arm. Sound for the same
 * reason the pass is: the arm tail leaves exactly one externref (the merge
 * declares `(result externref)`), and the consumer answers `truthy` of it, so
 * `truthy(merge)` is unchanged leaf by leaf. Executed cost is unchanged — one
 * arm runs, one consumer runs — while every box leaf in the tree now fuses.
 * Only static size grows, which is why a tree of nothing BUT sink leaves is
 * declined (`no-free-leaf`): it would pay that size for zero deleted boxes.
 *
 * The residual this does NOT close stays open and is the parameter half of the
 * same ABI: a truthy operand that arrives through a local (`prev-local.get`)
 * or is produced by a call outside any merge (`prev-call`) never reaches a
 * merge site at all.
 *
 * ## Flag — DEFAULT OFF
 *
 * `JS2WASM_UNBOXED_BOOL_FUSE` unset, or set to (case/space-insensitive) one of
 * `"" | "0" | "off" | "false" | "no"` → the pass returns before touching
 * anything and the binary is byte-identical to base. Companions:
 *   - `JS2WASM_UNBOXED_BOOL_FUSE_POISON=1` — deliberately INVERT the fused i32
 *     answer (`i32.eqz` where the deleted consumer stood). A workload whose
 *     answer is unchanged under poison did not execute a fused site — the only
 *     way to tell a real null from a flag that never fired (#4157 entry 22).
 *     Poison alone (main flag off) is inert.
 *   - `JS2WASM_UNBOXED_BOOL_FUSE_DEBUG=1` — stderr stats (fused/declined per
 *     shape). Nothing is printed without it.
 *
 * The sink leaf carries its own default-OFF gate on top of this one
 * (`JS2WASM_RET_UNBOX_ABI`, with `JS2WASM_RET_UNBOX_ABI_POISON` inverting the
 * sites that used it), so lever 4 alone still emits exactly the bytes it did
 * before #4406 Phase 2.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { retUnboxAbiPoisoned, retUnboxMergeSinkEnabled } from "./ret-unbox-abi.js"; // (#4406 Phase 2)
import { walkChildren, walkInstructions } from "./walk-instructions.js";

const OFF_TOKENS = new Set(["", "0", "off", "false", "no"]);

/**
 * (#4406 Phase 2) Arm-tail opcodes a SINK leaf may be built on.
 *
 * An ALLOWLIST, not a denylist, and that direction is the whole safety
 * argument. The rule only holds for a tail that leaves exactly one externref on
 * the stack — which the enclosing `(result externref)` merge guarantees for
 * every *value-producing* tail, but NOT for a tail that terminates the frame
 * (`return_call`, `return`, `unreachable`) or transfers control out of the arm
 * (`br`, `br_table`): those type-check against the merge polymorphically, and
 * appending a consumer after them would be dead code at best. A denylist would
 * silently admit the next such opcode somebody adds to the `Instr` union.
 */
const SINKABLE_TAIL_OPS: ReadonlySet<string> = new Set([
  "call",
  "call_ref",
  "call_indirect",
  "local.get",
  "local.tee",
  "global.get",
  "struct.get",
  "array.get",
  "extern.convert_any",
  "ref.null",
  "select",
]);

/**
 * Structural copy of a consumer sequence, so each sink leaf owns its own
 * instructions. Sharing them would alias sub-arrays (the truthy-IC consumer is
 * a nested `if` tree) across arms, and `fctx.body` is NOT append-only — later
 * relocations splice ranges in place (#4157 entry 33).
 */
function cloneInstrs(instrs: readonly Instr[]): Instr[] {
  return structuredClone(instrs) as Instr[];
}

/** Flag gate. Default OFF ⇒ byte-identical output. */
function fuseEnabled(): boolean {
  const raw = process.env.JS2WASM_UNBOXED_BOOL_FUSE;
  if (raw === undefined) return false;
  return !OFF_TOKENS.has(raw.trim().toLowerCase());
}

interface Stats {
  fusedSink: number;
  fusedSinkIc: number;
  fusedAdjacent: number;
  leafBoxCall: number;
  leafCondReuse: number;
  /** (#4406 Phase 2) Leaves that fused by taking a COPY of the consumer. */
  leafSunkConsumer: number;
  /** (#4406 Phase 2) Sites fused only because sink leaves were available. */
  fusedSiteWithSink: number;
  declines: Map<string, number>;
}

function decline(stats: Stats, reason: string): void {
  stats.declines.set(reason, (stats.declines.get(reason) ?? 0) + 1);
}

/** Is `instr` a value-producing `if` whose declared result is externref? */
function isExternrefIf(instr: Instr | undefined): instr is Instr & { op: "if"; then: Instr[]; else?: Instr[] } {
  if (!instr || instr.op !== "if") return false;
  const bt = (instr as { blockType?: { kind: string; type?: { kind: string } } }).blockType;
  return bt?.kind === "val" && bt.type?.kind === "externref";
}

/** Does any instruction in `instrs` (recursively) write local `index`? */
function writesLocal(instrs: Instr[], index: number): boolean {
  let found = false;
  walkInstructions(instrs, (i) => {
    const a = i as { op: string; index?: number };
    if ((a.op === "local.set" || a.op === "local.tee") && a.index === index) found = true;
  });
  return found;
}

/**
 * The condition-operand local of the merge `if` at `arr[ifIdx]`, when the
 * branch condition is a ToBoolean of a just-tee'd value — either the plain
 * shape `compileLogicalAnd`/`Or` emit (`local.tee L; call __is_truthy`), or
 * that same site after `inlineIsTruthyCallSites` claimed it (`local.tee L;
 * any.convert_extern; local.tee $__tr; ref.test T; if (result i32) …` with the
 * chain's terminal else calling `__is_truthy` — the IC chain answers exactly
 * `truthy(L)`, so the branch fact about L is unchanged). `undefined` when the
 * condition is anything else (a scalar compare, …): cond-reuse leaves then
 * decline.
 */
function condTeeLocal(arr: Instr[], ifIdx: number, truthyIdx: number): number | undefined {
  // Plain: local.tee L; call __is_truthy; if …
  if (ifIdx >= 2) {
    const cond = arr[ifIdx - 1] as { op: string; funcIdx?: number };
    const tee = arr[ifIdx - 2] as { op: string; index?: number };
    if (cond.op === "call" && cond.funcIdx === truthyIdx && tee.op === "local.tee" && tee.index !== undefined) {
      return tee.index;
    }
  }
  // IC-claimed: local.tee L; <truthy-IC chain (4 instrs)>; if …
  if (ifIdx >= 5 && matchTruthyIcChain(arr, ifIdx - 4, truthyIdx) !== undefined) {
    const tee = arr[ifIdx - 5] as { op: string; index?: number };
    if (tee.op === "local.tee" && tee.index !== undefined) return tee.index;
  }
  return undefined;
}

/** One planned leaf rewrite. Applied only when the WHOLE tree planned clean. */
type LeafAction =
  | { arm: Instr[]; kind: "box" }
  | { arm: Instr[]; kind: "cond"; value: 0 | 1 }
  | { arm: Instr[]; kind: "sink" };

interface FusePlan {
  actions: LeafAction[];
  /** Every `if` in the merge tree — all retyped to `(result i32)` on apply. */
  ifs: Instr[];
  leafBox: number;
  leafCond: number;
  /** (#4406 Phase 2) Leaves that keep the consumer instead of specialising it. */
  leafSink: number;
  /**
   * (#4406 Phase 2) The consumer sequence to COPY into each sink leaf, or
   * `undefined` when the merge half is off — in which case `planFuse` declines
   * exactly the leaves it declined before, so the pass stays byte-identical.
   */
  consumer: readonly Instr[] | undefined;
}

/**
 * Plan the fusion of the merge tree rooted at `arr[ifIdx]`. Returns a decline
 * reason, or `undefined` when every leaf is fusible (plan filled in).
 */
function planFuse(
  arr: Instr[],
  ifIdx: number,
  boxIdx: number | undefined,
  truthyIdx: number,
  plan: FusePlan,
): string | undefined {
  const ifi = arr[ifIdx] as Instr & { op: "if"; then: Instr[]; else?: Instr[] };
  plan.ifs.push(ifi);
  const arms: [Instr[] | undefined, boolean][] = [
    [ifi.then, true],
    [ifi.else, false],
  ];
  for (const [arm, isThen] of arms) {
    if (!arm || arm.length === 0) return "arm-empty";
    const last = arm[arm.length - 1]!;
    const a = last as { op: string; funcIdx?: number; index?: number };
    if (a.op === "call" && boxIdx !== undefined && a.funcIdx === boxIdx) {
      plan.actions.push({ arm, kind: "box" });
      plan.leafBox++;
      continue;
    }
    if (isExternrefIf(last)) {
      const r = planFuse(arm, arm.length - 1, boxIdx, truthyIdx, plan);
      if (r !== undefined) return r;
      continue;
    }
    if (a.op === "local.get" && a.index !== undefined) {
      const condLocal = condTeeLocal(arr, ifIdx, truthyIdx);
      if (condLocal !== undefined && a.index === condLocal && !writesLocal(arm, condLocal)) {
        // The arm re-reads the exact value the branch condition tested, and
        // nothing in the arm rewrote it: its truthiness IS the branch answer.
        plan.actions.push({ arm, kind: "cond", value: isThen ? 1 : 0 });
        plan.leafCond++;
        continue;
      }
    }
    // (#4406 Phase 2) SINK leaf — the general case the two specialised leaves
    // above are optimisations of. The arm tail leaves one externref (the merge
    // declares `(result externref)`, so a value-producing tail cannot leave
    // anything else), and the consumer answers `truthy(that externref)`. Moving
    // a COPY of the consumer into the arm therefore preserves the merge's
    // value exactly, while letting the SIBLING arm's box leaf fuse — which is
    // the whole point: `planFuse` is all-or-nothing, so one unspecialisable arm
    // used to strand every box in the tree.
    //
    // Executed cost is unchanged, not merely bounded: exactly one arm runs per
    // execution, so exactly one copy of the consumer runs where exactly one ran
    // before. Only the STATIC instruction count grows (one consumer per sink
    // leaf instead of one per site).
    if (plan.consumer !== undefined && SINKABLE_TAIL_OPS.has(a.op)) {
      plan.actions.push({ arm, kind: "sink" });
      plan.leafSink++;
      continue;
    }
    if (a.op === "local.get") return "arm-local.get";
    if (a.op === "call") return "arm-tail-call";
    return `arm-${a.op}`;
  }
  return undefined;
}

/** Apply a clean plan: rewrite leaves, retype every merge `if` to i32. */
function applyFuse(plan: FusePlan, stats: Stats): void {
  for (const action of plan.actions) {
    if (action.kind === "box") action.arm.pop();
    else if (action.kind === "sink") action.arm.push(...cloneInstrs(plan.consumer ?? []));
    else action.arm[action.arm.length - 1] = { op: "i32.const", value: action.value };
  }
  for (const ifi of plan.ifs) {
    (ifi as { blockType: { kind: string; type: { kind: string } } }).blockType = {
      kind: "val",
      type: { kind: "i32" },
    };
  }
  stats.leafBoxCall += plan.leafBox;
  stats.leafCondReuse += plan.leafCond;
  stats.leafSunkConsumer += plan.leafSink;
  if (plan.leafSink > 0) stats.fusedSiteWithSink++;
}

/**
 * Match the inlined truthy-IC prefix starting at `arr[start]` (the consumer
 * shape `inlineIsTruthyCallSites` emits for an `if`-producer site):
 *
 *     any.convert_extern ; local.tee X ; ref.test T ; if (result i32) … else …
 *
 * where the guard chain's TERMINAL else is `local.get X; extern.convert_any;
 * call __is_truthy`. Returns the number of matched instructions (always 4) or
 * `undefined` when the shape is anything else.
 */
function matchTruthyIcChain(arr: Instr[], start: number, truthyIdx: number): number | undefined {
  if (start + 3 >= arr.length) return undefined;
  const conv = arr[start] as { op: string };
  const tee = arr[start + 1] as { op: string; index?: number };
  const test = arr[start + 2] as { op: string };
  if (conv.op !== "any.convert_extern" || tee.op !== "local.tee" || tee.index === undefined) return undefined;
  if (test.op !== "ref.test") return undefined;
  let cur = arr[start + 3] as { op: string; blockType?: { kind: string; type?: { kind: string } }; else?: Instr[] };
  for (let guard = 0; guard < 64; guard++) {
    if (cur.op !== "if" || cur.blockType?.kind !== "val" || cur.blockType.type?.kind !== "i32") return undefined;
    const els = cur.else;
    if (!els || els.length !== 3) return undefined;
    const e0 = els[0] as { op: string; index?: number };
    const e1 = els[1] as { op: string };
    const e2 = els[2] as { op: string; funcIdx?: number; blockType?: { kind: string; type?: { kind: string } } };
    if (e0.op !== "local.get" || e0.index !== tee.index) return undefined;
    if (e1.op === "extern.convert_any" && e2.op === "call" && e2.funcIdx === truthyIdx) return 4; // terminal
    if (e1.op === "ref.test" && e2.op === "if") {
      cur = e2 as typeof cur;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** Everything the rewrite needs that is constant for one module. */
interface FuseOpts {
  boxIdx: number | undefined;
  truthyIdx: number;
  /** Lever 4's own poison (`JS2WASM_UNBOXED_BOOL_FUSE_POISON`). */
  poison: boolean;
  /** (#4406 Phase 2) Are sink leaves allowed? */
  mergeSink: boolean;
  /** (#4406 Phase 2) `JS2WASM_RET_UNBOX_ABI_POISON` — invert sink-using sites. */
  mergePoison: boolean;
}

/**
 * Plan and apply ONE merge site whose consumer occupies
 * `arr[ifIdx+1 … ifIdx+consumerLen]`. Returns whether it fused; a decline is
 * recorded against `stats` either way.
 */
function tryFuseSite(arr: Instr[], ifIdx: number, consumerLen: number, opts: FuseOpts, stats: Stats): boolean {
  // Sliced BEFORE the splice below, and only read by `applyFuse`, which runs
  // before it — so the copies each sink leaf takes are of the live consumer.
  const consumer = opts.mergeSink ? arr.slice(ifIdx + 1, ifIdx + 1 + consumerLen) : undefined;
  const plan: FusePlan = { actions: [], ifs: [], leafBox: 0, leafCond: 0, leafSink: 0, consumer };
  const reason = planFuse(arr, ifIdx, opts.boxIdx, opts.truthyIdx, plan);
  if (reason !== undefined) {
    decline(stats, reason);
    return false;
  }
  // (#4406 Phase 2) A tree of nothing but sink leaves deletes no box — it only
  // copies the consumer into every arm. Decline it: this pass exists to remove
  // boxes, and paying static size for zero of them is a pure regression.
  if (plan.leafSink > 0 && plan.leafBox === 0 && plan.leafCond === 0) {
    decline(stats, "no-free-leaf");
    return false;
  }
  applyFuse(plan, stats);
  // Lever 4's poison and the return-ABI's Phase-2 poison are separate liveness
  // probes over overlapping sites, and inverting twice is the identity — so
  // invert exactly when one of them claims this site.
  const invert = opts.poison !== (opts.mergePoison && plan.leafSink > 0);
  arr.splice(ifIdx + 1, consumerLen, ...(invert ? ([{ op: "i32.eqz" }] as Instr[]) : []));
  return true;
}

/** Rewrite one instruction array in place, recursing into nested bodies. */
function fuseInArray(arr: Instr[], opts: FuseOpts, stats: Stats): void {
  const { boxIdx, truthyIdx, poison } = opts;
  // Children first, so an inner merge consumed inside an arm fuses before the
  // outer scan reads that arm's (unchanged) tail.
  for (const instr of arr) {
    walkChildren(instr, (children) => fuseInArray(children, opts, stats));
  }

  let i = 0;
  while (i < arr.length) {
    const cur = arr[i]!;
    const next = arr[i + 1] as ({ op: string; funcIdx?: number } & Instr) | undefined;

    if (isExternrefIf(cur) && next !== undefined) {
      // Consumer form 1: the plain sink — `call __is_truthy` right after the merge.
      if (next.op === "call" && next.funcIdx === truthyIdx) {
        if (tryFuseSite(arr, i, 1, opts, stats)) stats.fusedSink++;
        i++;
        continue;
      }
      // Consumer form 2: the inlined truthy-IC prefix claimed the site first.
      const chainLen = matchTruthyIcChain(arr, i + 1, truthyIdx);
      if (chainLen !== undefined) {
        if (tryFuseSite(arr, i, chainLen, opts, stats)) {
          stats.fusedSink++;
          stats.fusedSinkIc++;
        }
        i++;
        continue;
      }
    }

    // Adjacent form: `call __box_boolean; call __is_truthy` in a straight line.
    // Basically never occurs (the value flows through an if-merge) but it is
    // trivially sound: box then immediately unbox-to-truthiness is identity.
    if (
      boxIdx !== undefined &&
      cur.op === "call" &&
      (cur as { funcIdx?: number }).funcIdx === boxIdx &&
      next?.op === "call" &&
      next.funcIdx === truthyIdx
    ) {
      arr.splice(i, 2, ...(poison ? ([{ op: "i32.eqz" }] as Instr[]) : []));
      stats.fusedAdjacent++;
      continue;
    }

    // Residual classification: an unclaimed `__is_truthy` site, bucketed by
    // its producer's op — the cross-function residuals the KNOWN LIMITS call
    // out (prev-call / prev-local.tee / prev-local.get) land here.
    if (cur.op === "call" && (cur as { funcIdx?: number }).funcIdx === truthyIdx) {
      const prev = arr[i - 1] as { op: string } | undefined;
      decline(stats, prev === undefined ? "prev-none" : `prev-${prev.op}`);
    }

    i++;
  }
}

/**
 * (#4157) Fuse boxed-boolean producers to raw i32 at every merge whose value
 * is immediately consumed by ToBoolean.
 *
 * MUST run at the same finalize point as — and AFTER — `inlineIsTruthyCallSites`,
 * so the IC-claimed consumer shape it recognizes is the IC's final output and
 * every `funcIdx` it matches is in the same regime as the call sites. No-op
 * unless `JS2WASM_UNBOXED_BOOL_FUSE` is enabled.
 */
export function fuseBoxBooleanSinks(ctx: CodegenContext): void {
  if (!fuseEnabled()) return; // DEFAULT OFF — byte-identical to base.
  const debug = process.env.JS2WASM_UNBOXED_BOOL_FUSE_DEBUG === "1";
  const poison = process.env.JS2WASM_UNBOXED_BOOL_FUSE_POISON === "1";
  const truthyIdx = ctx.funcMap.get("__is_truthy");
  if (truthyIdx === undefined) {
    if (debug) process.stderr.write(`[box-bool-fuse] no __is_truthy in this module — pass declined\n`);
    return;
  }
  const boxIdx = ctx.funcMap.get("__box_boolean");
  // (#4406 Phase 2) OFF unless the return-ABI flag is on, so lever 4 alone
  // keeps emitting exactly the bytes it emitted before this landed.
  const opts: FuseOpts = {
    boxIdx,
    truthyIdx,
    poison,
    mergeSink: retUnboxMergeSinkEnabled(),
    mergePoison: retUnboxAbiPoisoned(),
  };

  const stats: Stats = {
    fusedSink: 0,
    fusedSinkIc: 0,
    fusedAdjacent: 0,
    leafBoxCall: 0,
    leafCondReuse: 0,
    leafSunkConsumer: 0,
    fusedSiteWithSink: 0,
    declines: new Map(),
  };
  for (const fn of ctx.mod.functions) {
    // Never rewrite the helpers themselves — only their consumption sites.
    if (fn.name === "__is_truthy" || fn.name === "__box_boolean") continue;
    fuseInArray(fn.body, opts, stats);
  }

  if (debug) {
    const declines = [...stats.declines.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(" ");
    process.stderr.write(
      `[box-bool-fuse] fused-sink=${stats.fusedSink} (via-ic=${stats.fusedSinkIc}) ` +
        `fused-adjacent=${stats.fusedAdjacent} leaves: box-call=${stats.leafBoxCall} ` +
        `cond-reuse=${stats.leafCondReuse} sunk-consumer=${stats.leafSunkConsumer} ` +
        `(sites=${stats.fusedSiteWithSink}, merge-sink=${opts.mergeSink ? "on" : "off"})` +
        `${poison ? " POISON=ON" : ""}${opts.mergePoison ? " RET-ABI-POISON=ON" : ""}` +
        `${declines.length > 0 ? ` declined: ${declines}` : ""}\n`,
    );
  }
}
