// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3685 step 1) Decline-reason census for `tryEmitProvenReceiverFieldGet` —
 * instrumentation only, OFF unless `JS2WASM_PROVEN_RECEIVER_STATS=1`.
 *
 * WHY THIS EXISTS. The 2026-07-31 coverage audit measured, over one standalone
 * acorn compile, **244 proven receiver verdicts** (184 `Node` + 60 `Parser`)
 * against only **88** inlined reads (`provenFieldStats.gets`). So 156 proven
 * receivers were proven and then dropped by one of the emitter's carve-outs —
 * `RESERVED_PROPS`, `classAccessorSet`, presence-tracked fields, a
 * call-signature-typed access, or "the name is not a declared field of the
 * struct". WHICH carve-out, and in what proportion, was never measured, and the
 * issue's own decision rule branches on the answer: dominated by
 * not-a-declared-field ⇒ #3685 closes and the object-literal shape work is a
 * separate issue; a carve-out over-broad ⇒ there is a landable fix here.
 *
 * The `this` form already has this instrument (`noteDeclinedField` /
 * `JS2WASM_TYPED_THIS_DEBUG`); the proven-receiver form did not. Same house
 * style as `alloc-census.ts`: one env var, a module-local counter, a dump on
 * `process.exit`, and zero behaviour change when off — every `note*` call is a
 * statement, never part of a condition.
 */

/** Decline / admit tallies, keyed by reason. Empty unless the env var is set. */
export const provenReceiverStats = {
  /** Calls that reached the receiver-flow query (post `this`/private/`?.`). */
  asked: 0,
  /** Of those, calls whose receiver resolved to exactly one fnctor class. */
  proven: 0,
  /** Of those, calls that emitted the guarded inline read. */
  inlined: 0,
  /** reason -> count. Reasons are prefixed by the phase that produced them. */
  reasons: new Map<string, number>(),
};

export function provenReceiverStatsEnabled(): boolean {
  return process.env.JS2WASM_PROVEN_RECEIVER_STATS === "1";
}

let hookInstalled = false;
function installDumpHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  process.on("exit", () => {
    const rows = [...provenReceiverStats.reasons.entries()].sort((a, b) => b[1] - a[1]);
    const declined = provenReceiverStats.proven - provenReceiverStats.inlined;
    process.stderr.write(
      `[proven-receiver] asked=${provenReceiverStats.asked} proven=${provenReceiverStats.proven} ` +
        `inlined=${provenReceiverStats.inlined} declinedAfterProof=${declined}\n` +
        rows.map(([k, v]) => `[proven-receiver]   ${k}=${v}\n`).join(""),
    );
  });
}

/** Bump a reason bucket. No-op unless `JS2WASM_PROVEN_RECEIVER_STATS=1`. */
export function noteProvenReceiver(reason: string): void {
  if (!provenReceiverStatsEnabled()) return;
  installDumpHook();
  provenReceiverStats.reasons.set(reason, (provenReceiverStats.reasons.get(reason) ?? 0) + 1);
}

/** Bump one of the three aggregate counters. */
export function noteProvenReceiverPhase(phase: "asked" | "proven" | "inlined"): void {
  if (!provenReceiverStatsEnabled()) return;
  installDumpHook();
  provenReceiverStats[phase]++;
}

/** Test-only: drop every recorded count so one process can measure twice. */
export function resetProvenReceiverStats(): void {
  provenReceiverStats.asked = 0;
  provenReceiverStats.proven = 0;
  provenReceiverStats.inlined = 0;
  provenReceiverStats.reasons.clear();
}
