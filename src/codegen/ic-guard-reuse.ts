// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157 defect C) CROSS-IC GUARD REUSE — stop re-testing a receiver whose
 * runtime type provably cannot have changed since the previous inline cache.
 *
 * Three consecutive `this.lastTokX = this.X` statements in acorn's `pp.next`
 * emit independent `member-get-inline-ic` sites on the SAME receiver, each
 * paying `local.tee $ic` + `ref.test $S` + (on the hit path) `ref.cast $S`.
 * V8 removes the 2nd and 3rd by guard-redundancy elimination. Nothing here did:
 * 6,723 `ref.test` of one struct type in the tuned acorn build (entry 30).
 *
 * ## Why this is a FINALIZE pass and not an extension of receiver-CSE
 *
 * The obvious composition — teach `receiver-cse.ts` to also cache the
 * post-`ref.cast` typed value — is structurally impossible. `ref.cast $S` does
 * not exist at emission time: the struct candidate set is only COMPLETE at
 * finalize (that is the whole #2674 argument in `member-get-inline-ic.ts`, and
 * why the IC is a finalize pass at all). At emission a dynamic member read is a
 * plain `call $__get_member_<name>` with no type to cache. So the reuse has to
 * happen where the guard is minted.
 *
 * ## Why dominance is free here, unlike in receiver-CSE
 *
 * `receiver-cse.ts`'s hard-won finding is that `fctx.body` is NOT append-only:
 * ~8 emitters relocate an already-emitted range with `fctx.body.splice(start)`,
 * which moves a cached `local.tee` into a conditional arm where it stops
 * dominating — a silent wrong answer. That hazard is an EMISSION-time one. This
 * pass runs after emission, over one instruction array at a time, and that array
 * is rebuilt by strictly appending to a fresh `out` (the single `out.pop()` in
 * `rewriteInstrs` removes the site's own `extern.convert_any`, which is never a
 * recorded instruction). A Wasm instruction array is entered only at the top, so
 * an earlier instruction dominates every later one in the SAME array, and reuse
 * scoped to one array needs no analysis. Nested bodies are separate arrays,
 * rewritten by separate `rewriteInstrs` invocations, so they simply miss.
 *
 * The relocation probe is kept anyway, in the form receiver-CSE proved
 * necessary: at reuse the recorded `local.tee` instruction OBJECT must still sit
 * at the index it was left at. Here it also does a SECOND job — it is what makes
 * the pre-scan's prediction unfalsifiable. The pre-scan pairs sites on the
 * original array; emission may still decline the leader (producer shape, no
 * plan), and then no tee is recorded and the follower declines too.
 *
 * ## Why the type cannot change between the two tests
 *
 * A WasmGC object's heap type is fixed at allocation — nothing retypes a
 * referent, so no call, `struct.set` or store between the sites can change the
 * answer. The ONLY way the guard's outcome can differ is if the receiver LOCAL
 * is reassigned, so that is the whole invalidation rule (checked recursively
 * through nested bodies), plus a clear on `br`/`return`/`throw`/`unreachable`,
 * after which the rest of the array is unreachable anyway.
 *
 * ## What a follower saves
 *
 * Leader:   `<recv> ; local.tee $ic ; ref.test $S ; local.tee $guard ; if …`
 *           with `ref.cast $S ; local.tee $cast` opening the hit arm.
 * Follower: `local.get $guard ; if (then `local.get $cast ; struct.get …`) …`
 *
 * So a follower drops its producer, `local.tee $ic`, `ref.test $S` AND
 * `ref.cast $S` — two of them real type checks — and its miss arm reads the
 * receiver local directly instead of round-tripping `$ic` back through
 * `extern.convert_any`. Caching the cast is sound for the same reason the guard
 * is: the follower's hit arm is reached exactly when `$guard` is 1, which is
 * exactly when the leader's hit arm ran and set `$cast`.
 *
 * A miss is a redundant test — today's behaviour — never a wrong answer: every
 * decline below leaves the site as the full IC.
 *
 * ## Flag — DEFAULT OFF
 *
 * `JS2WASM_IC_GUARD_REUSE` unset / `0` → `planGuardReuse` returns `undefined`
 * before looking at anything and the binary is byte-identical.
 *   - `=1` on
 *   - `JS2WASM_IC_GUARD_REUSE_LIMIT=N` reuse at most N sites (bisection)
 *   - `JS2WASM_IC_GUARD_REUSE_POISON=1` **corrupts the reused cast** (the hit arm
 *     reads a null instead, so any executed reuse traps). A workload whose
 *     answer is unchanged under poison provably never took a reused path — the
 *     entry-22 lesson that a confident null must be told apart from a mechanism
 *     that never fired.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** `index` → the declared kind of that local, or `undefined` if unknown. */
export type LocalKind = (index: number) => string | undefined;

/** Flag gate. Default OFF ⇒ every IC site keeps its own guard. */
export function icGuardReuseEnabled(): boolean {
  const raw = process.env.JS2WASM_IC_GUARD_REUSE;
  return raw !== undefined && raw !== "" && raw !== "0" && raw !== "off";
}

/**
 * How the follower re-materialises the receiver for its miss arm, and what its
 * own producer costs to remove.
 *
 * `kind: "A"` — the local holds the anyref the guard tested, so the miss arm
 * has to convert it back; `"E"` — the local is already the externref the
 * dispatcher wants.
 */
interface RecvKey {
  kind: "A" | "E";
  local: number;
  /** `pop` when the producer is a pure `local.get`; `set` for a `local.tee`. */
  producer: "pop" | "set";
}

/** A leader's minted locals, recorded only once the leader has really emitted. */
interface GuardEntry {
  guardLocal: number;
  castLocal: number;
  /** Exported counter global under `…_CENSUS=1`, else `-1`. */
  censusGlobal: number;
  /** The tested struct type — only needed to type the poison probe's null. */
  structTypeIdx: number;
  /** The array the guard tee was emitted into, and where — the relocation probe. */
  out: Instr[];
  at: number;
  tee: Instr;
}

/**
 * Reuse decisions for one FUNCTION, keyed by the site's `call` instruction
 * object (unique per site, and stable while the tree is rewritten in place).
 */
export interface ReusePlan {
  /** Sites that must mint guard + cast locals because a follower needs them. */
  leaders: Set<Instr>;
  /** Follower site → its leader site. */
  followers: Map<Instr, Instr>;
  /** Receiver key per participating site. */
  keys: Map<Instr, RecvKey>;
  /** Filled in as leaders emit; a missing entry declines its followers. */
  emitted: Map<Instr, GuardEntry>;
}

/** Counters — the proof the mechanism fired, printed by the IC pass. */
export const guardReuseStats = {
  leaders: 0,
  reuses: 0,
  declinedRelocated: 0,
  /** Sites the pre-scan saw, and the two ways one can fail to pair. */
  sites: 0,
  unkeyedProducer: 0,
  unpaired: 0,
};

/** Zero the counters so the reported line is per MODULE, not per process. */
export function resetGuardReuseStats(): void {
  for (const k of Object.keys(guardReuseStats) as (keyof typeof guardReuseStats)[]) guardReuseStats[k] = 0;
}

type AnyInstr = Instr & {
  op: string;
  index?: number;
  body?: Instr[];
  then?: Instr[];
  else?: Instr[];
  catches?: { body?: Instr[] }[];
  catchAll?: Instr[];
};

/** Every nested instruction array of `a`, in no particular order. */
function childArrays(a: AnyInstr): Instr[][] {
  const out: Instr[][] = [];
  if (Array.isArray(a.body)) out.push(a.body);
  if (Array.isArray(a.then)) out.push(a.then);
  if (Array.isArray(a.else)) out.push(a.else);
  if (Array.isArray(a.catchAll)) out.push(a.catchAll);
  if (Array.isArray(a.catches)) for (const c of a.catches) if (Array.isArray(c.body)) out.push(c.body);
  return out;
}

/** Collect every local index written anywhere in `instr`'s subtree into `sink`. */
function collectWrites(instr: Instr, sink: Set<number>): void {
  const a = instr as AnyInstr;
  if ((a.op === "local.set" || a.op === "local.tee") && a.index !== undefined) sink.add(a.index);
  for (const arr of childArrays(a)) for (const child of arr) collectWrites(child, sink);
}

/** True when `op` ends the array's straight-line flow at THIS nesting level. */
function endsFlow(op: string): boolean {
  return op === "br" || op === "br_table" || op === "return" || op === "unreachable" || op === "throw";
}

/**
 * VERSIONED VALUE IDENTITY — what makes the pairing find anything at all.
 *
 * Keying on "same local index" finds almost nothing on real output (measured:
 * 388 reuses on acorn), because the emitter copies the receiver into a FRESH
 * local for every statement — `local.set $85 (local.get $7)`,
 * `local.set $86 (local.get $7)`, … — and then routes it through a per-site
 * `any.convert_extern ; local.tee $92 ; extern.convert_any` round trip. Six
 * sites on one `this` therefore present six different locals.
 *
 * So locals are tracked by the VALUE they hold, not by their index. Each local
 * carries a canonical id; a modelled copy (`local.get $r` [+ one extern/any
 * conversion] `local.set|tee $x`) propagates `$r`'s id to `$x`, and any write
 * this cannot model mints a fresh one. Because a fresh id is minted on every
 * unmodelled write, an id can never be resurrected — an entry recorded against
 * `L7#0` simply stops matching once `$7` is reassigned, which is why no
 * separate invalidation pass is needed.
 *
 * The two conversions are transparent here on purpose: `any.convert_extern` and
 * `extern.convert_any` are inverses that preserve the REFERENT, and the referent
 * is the only thing `ref.test` looks at.
 */
class ValueIds {
  private ids: Map<number, string>;
  private readonly seq: { n: number };

  constructor(from?: ValueIds) {
    this.ids = new Map(from?.ids);
    this.seq = from?.seq ?? { n: 0 };
  }

  /** The id of the value currently in `local`. */
  read(local: number): string {
    let id = this.ids.get(local);
    if (id === undefined) {
      id = `L${local}#${this.seq.n++}`;
      this.ids.set(local, id);
    }
    return id;
  }

  /** `local` now holds `id` (a modelled copy). */
  alias(local: number, id: string): void {
    this.ids.set(local, id);
  }

  /** `local` was written in a way this cannot model — its value is unknown. */
  clobber(local: number): void {
    this.ids.set(local, `L${local}#${this.seq.n++}`);
  }
}

/** Live guards + value ids at one point of the walk. */
interface WalkState {
  /** `"<struct>|<valueId>"` → the site whose guard currently covers it. */
  live: Map<string, Instr>;
  vals: ValueIds;
}

/**
 * The local whose value `instrs[i]` (a `local.set`/`local.tee`) copies, looking
 * through at most one extern/any conversion in EITHER direction — the emitter's
 * per-site receiver round trip is `any.convert_extern ; local.tee $t ;
 * extern.convert_any`, so a model that only knows one direction loses the chain
 * at its first hop and the pairing collapses (measured: it cost ~90 % of them).
 */
function copySourceAt(instrs: Instr[], i: number): number | undefined {
  let j = i - 1;
  const conv = (instrs[j] as AnyInstr | undefined)?.op;
  if (conv === "extern.convert_any" || conv === "any.convert_extern") j--;
  const src = instrs[j] as AnyInstr | undefined;
  if (!src || src.index === undefined) return undefined;
  return src.op === "local.get" || src.op === "local.tee" ? src.index : undefined;
}

/** The producer chain of the value consumed at `i`, if it is a tracked local. */
function producerAt(localKind: LocalKind, instrs: Instr[], i: number): RecvKey | undefined {
  const prev = instrs[i - 1] as AnyInstr | undefined;
  if (!prev) return undefined;
  const converted = prev.op === "extern.convert_any";
  const src = (converted ? instrs[i - 2] : prev) as AnyInstr | undefined;
  if (!src || src.index === undefined) return undefined;
  if (src.op !== "local.get" && src.op !== "local.tee") return undefined;
  const kind = localKind(src.index);
  // `extern.convert_any` in front means the local already holds the very anyref
  // the guard tests; without it the local is an externref the IC converts.
  if (converted ? kind !== "anyref" && kind !== "eqref" : kind !== "externref") return undefined;
  return {
    kind: converted ? "A" : "E",
    local: src.index,
    producer: src.op === "local.get" ? "pop" : "set",
  };
}

/**
 * Walk one instruction array in the SAME pre-order `rewriteInstrs` uses —
 * children of `k` before `k` itself — pairing sites that test the same struct
 * type on the same value.
 *
 * Scope is dominance, not array identity. Everything preceding an instruction in
 * its enclosing array dominates that instruction's nested bodies, so a child
 * array INHERITS a copy of the state, while the parent never inherits anything
 * back (a conditional arm's guard does not dominate what follows the `if`) and
 * siblings never see each other. That is why each descent gets a fresh copy.
 *
 * Two re-entry shapes break the "everything before dominates" reading and are
 * handled by clobbering the whole subtree's write set on the way in:
 *   - `loop` — a back edge re-enters the body AFTER later body instructions have
 *     run, so a receiver the body reassigns would be tested with the previous
 *     iteration's guard;
 *   - `try` — a catch body is entered from anywhere in the try body, including
 *     after it has reassigned the receiver.
 * Both are conservative: they only ever cost reuses.
 */
function walkForReuse(
  instrs: Instr[],
  state: WalkState,
  plan: ReusePlan,
  localKind: LocalKind,
  structOfSite: (instr: Instr) => number | undefined,
): void {
  const writes = new Set<number>();
  for (let i = 0; i < instrs.length; i++) {
    const instr = instrs[i]!;
    const a = instr as AnyInstr;
    const kids = childArrays(a);
    if (kids.length > 0) {
      const reentrant = a.op === "loop" || a.op === "try" || a.op === "try_table";
      for (const kid of kids) {
        const sub: WalkState = { live: new Map(state.live), vals: new ValueIds(state.vals) };
        if (reentrant) {
          writes.clear();
          collectWrites(instr, writes);
          for (const w of writes) sub.vals.clobber(w);
        }
        walkForReuse(kid, sub, plan, localKind, structOfSite);
      }
    }
    const structIdx = structOfSite(instr);
    if (structIdx !== undefined) {
      guardReuseStats.sites++;
      const key = producerAt(localKind, instrs, i);
      // A site writes only the shared `$ic` scratch, never a tracked local.
      if (key === undefined) {
        guardReuseStats.unkeyedProducer++;
        continue;
      }
      const slot = `${structIdx}|${state.vals.read(key.local)}`;
      const leader = state.live.get(slot);
      if (leader !== undefined) {
        plan.leaders.add(leader);
        plan.followers.set(instr, leader);
      } else {
        guardReuseStats.unpaired++;
        state.live.set(slot, instr);
      }
      plan.keys.set(instr, key);
      continue;
    }
    if (endsFlow(a.op)) {
      // Everything after leaves this array; clearing keeps the reuse strictly
      // inside straight-line, reachable code.
      state.live.clear();
      continue;
    }
    if (kids.length === 0 && (a.op === "local.set" || a.op === "local.tee") && a.index !== undefined) {
      const src = copySourceAt(instrs, i);
      if (src !== undefined && src !== a.index) state.vals.alias(a.index, state.vals.read(src));
      else state.vals.clobber(a.index);
      continue;
    }
    writes.clear();
    collectWrites(instr, writes);
    for (const w of writes) state.vals.clobber(w);
  }
}

/**
 * Pair up the reusable guard sites of one FUNCTION. Returns `undefined` when the
 * flag is off or nothing pairs, so the caller stays on today's path entirely.
 *
 * `structOfSite` answers "the struct type this instruction's IC would test", or
 * `undefined` for everything that is not a patchable site.
 */
export function planGuardReuse(
  body: Instr[],
  localKind: LocalKind,
  structOfSite: (instr: Instr) => number | undefined,
): ReusePlan | undefined {
  if (!icGuardReuseEnabled()) return undefined;
  const plan: ReusePlan = { leaders: new Set(), followers: new Map(), keys: new Map(), emitted: new Map() };
  walkForReuse(body, { live: new Map(), vals: new ValueIds() }, plan, localKind, structOfSite);
  return plan.leaders.size === 0 ? undefined : plan;
}

/**
 * One exported mutable `i32` per module counting EXECUTED reuses, so the payoff
 * can be quoted dynamically and not just as a static site count. Appending a
 * global is index-safe here (unlike an import, it shifts nothing already baked).
 */
const censusGlobals = new WeakMap<CodegenContext, number>();

function censusGlobalFor(ctx: CodegenContext): number {
  if (process.env.JS2WASM_IC_GUARD_REUSE_CENSUS !== "1") return -1;
  const cached = censusGlobals.get(ctx);
  if (cached !== undefined) return cached;
  const name = "__ic_guard_reuse_hits";
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({ name, type: { kind: "i32" }, mutable: true, init: [{ op: "i32.const", value: 0 }] });
  ctx.mod.exports.push({ name, desc: { kind: "global", index: globalIdx } });
  censusGlobals.set(ctx, globalIdx);
  return globalIdx;
}

/**
 * Mint the leader's `i32` guard and `(ref null $S)` cast locals on `fn`, and
 * hand back the two `local.tee`s the IC splices after its `ref.test` and its
 * `ref.cast`. Recorded via `recordLeader` once the guard tee is actually in
 * `out`.
 */
export function leaderTees(
  ctx: CodegenContext,
  fn: WasmFunction,
  structTypeIdx: number,
): { guardTee: Instr; castTee: Instr; entry: Omit<GuardEntry, "at" | "tee" | "out"> } {
  const t = ctx.mod.types[fn.typeIdx];
  const base = (t && t.kind === "func" ? t.params.length : 0) + fn.locals.length;
  fn.locals.push({ name: "__ic_guard", type: { kind: "i32" } });
  fn.locals.push({ name: "__ic_cast", type: { kind: "ref_null", typeIdx: structTypeIdx } });
  return {
    guardTee: { op: "local.tee", index: base },
    castTee: { op: "local.tee", index: base + 1 },
    entry: { guardLocal: base, castLocal: base + 1, structTypeIdx, censusGlobal: censusGlobalFor(ctx) },
  };
}

/** Record a leader whose guard tee is now the last instruction of `out`. */
export function recordLeader(
  plan: ReusePlan,
  site: Instr,
  entry: Omit<GuardEntry, "at" | "tee" | "out">,
  guardTee: Instr,
  out: Instr[],
): void {
  plan.emitted.set(site, { ...entry, out, at: out.length, tee: guardTee });
  guardReuseStats.leaders++;
}

/**
 * The follower's replacement for `<producer> ; local.tee $ic ; ref.test $S ; if`
 * — or `undefined` when the reuse is declined and the caller must emit the full
 * IC. `hitTail` is everything after the receiver in the hit arm (`struct.get` +
 * box), `missTail` everything after the receiver in the miss arm (the call).
 *
 * On a non-`undefined` answer the site's now-dead producer has ALREADY been
 * removed from `out`: a pure `local.get` is popped outright, while a `local.tee`
 * is demoted to `local.set` — it still has to consume its operand and keep its
 * write, it just no longer needs to leave the receiver on the stack. `out` is
 * left untouched on every decline.
 */
export function emitReusedGuard(
  plan: ReusePlan,
  site: Instr,
  out: Instr[],
  alreadyAny: boolean,
  resultType: ValType,
  hitTail: Instr[],
  missTail: Instr[],
): Instr[] | undefined {
  const leader = plan.followers.get(site);
  if (leader === undefined) return undefined;
  const entry = plan.emitted.get(leader);
  if (entry === undefined) return undefined;
  // The relocation probe receiver-CSE proved necessary, doing double duty as
  // the check that the leader really emitted where the pre-scan predicted.
  // `entry.out` is the leader's array, which for an inherited guard is an
  // ANCESTOR of this one — already rewritten up to the instruction we are
  // nested under, because the rewrite visits children before their parent.
  if (entry.out[entry.at - 1] !== entry.tee) {
    guardReuseStats.declinedRelocated++;
    return undefined;
  }
  const limit = process.env.JS2WASM_IC_GUARD_REUSE_LIMIT;
  if (limit !== undefined && guardReuseStats.reuses >= Number(limit)) return undefined;
  const key = plan.keys.get(site)!;
  if (alreadyAny) out.pop();
  if (key.producer === "pop") out.pop();
  else out[out.length - 1] = { op: "local.set", index: key.local };
  const cast: Instr =
    process.env.JS2WASM_IC_GUARD_REUSE_POISON === "1"
      ? { op: "ref.null", typeIdx: entry.structTypeIdx }
      : { op: "local.get", index: entry.castLocal };
  guardReuseStats.reuses++;
  const census: Instr[] =
    entry.censusGlobal < 0
      ? []
      : [
          { op: "global.get", index: entry.censusGlobal },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "global.set", index: entry.censusGlobal },
        ];
  return [
    ...census,
    { op: "local.get", index: entry.guardLocal },
    {
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: [cast, ...hitTail],
      else:
        key.kind === "A"
          ? [{ op: "local.get", index: key.local }, { op: "extern.convert_any" }, ...missTail]
          : [{ op: "local.get", index: key.local }, ...missTail],
    },
  ];
}
