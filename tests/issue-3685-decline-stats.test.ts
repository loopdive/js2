/**
 * #3685 step 1 — decline-reason census for `tryEmitProvenReceiverFieldGet`.
 *
 * The 2026-07-31 coverage audit measured 244 proven receiver verdicts against
 * only 88 inlined reads over one standalone acorn compile, and could not say
 * WHICH carve-out dropped the other 156. This census answers that. It is
 * instrumentation, so what needs pinning is that it is genuinely inert when the
 * env var is unset, and that when set it attributes each decline to the branch
 * that produced it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { provenReceiverStats, resetProvenReceiverStats } from "../src/codegen/proven-receiver-stats.ts";

// `y` is assigned only under a condition, so it is presence-tracked; `x` is
// unconditional, so it is a plain slot. `p` is a never-reassigned binding
// initialized from `new P(...)`, which the S1 receiver-flow analysis proves.
// `nope` is never assigned anywhere, so it is not a declared field at all —
// the one decline reason this shape still produces after step 2 admitted the
// presence-tracked slot (see issue-3685-presence-tracked-proven-reads).
const SOURCE = `
function P(a) { this.x = a; if (a > 1) { this.y = a + 1; } }
export function test() {
  var p = new P(2);
  return p.x + p.y + (p.nope === undefined ? 0 : 1);
}`;

async function build(): Promise<void> {
  const r = await compile(SOURCE, { fileName: "t.mjs", skipSemanticDiagnostics: true, target: "standalone" });
  expect(r.binary?.length ?? 0).toBeGreaterThan(0);
}

// Cleared rather than `delete`d: biome's `noDelete` forbids the delete form, and
// the gate reads `=== "1"`, so an empty value is indistinguishable from unset.
afterEach(() => {
  process.env.JS2WASM_PROVEN_RECEIVER_STATS = "";
  resetProvenReceiverStats();
});

describe("#3685 step 1 — proven-receiver decline census", () => {
  it("records nothing when the env var is unset", async () => {
    process.env.JS2WASM_PROVEN_RECEIVER_STATS = "";
    resetProvenReceiverStats();
    await build();
    expect(provenReceiverStats.asked).toBe(0);
    expect(provenReceiverStats.proven).toBe(0);
    expect(provenReceiverStats.inlined).toBe(0);
    expect(provenReceiverStats.reasons.size).toBe(0);
  });

  it("attributes an inlined read and a not-a-declared-field decline separately", async () => {
    process.env.JS2WASM_PROVEN_RECEIVER_STATS = "1";
    resetProvenReceiverStats();
    await build();

    expect(provenReceiverStats.proven).toBeGreaterThan(0);
    const keys = [...provenReceiverStats.reasons.keys()];
    // `p.x` — plain slot on a proven receiver — is inlined.
    expect(keys.some((k) => k.startsWith("ok:P.x:"))).toBe(true);
    // `p.y` — presence-tracked externref — is ALSO inlined since step 2, and
    // the census tags it so the two admissions stay distinguishable.
    expect(keys.some((k) => k === "ok:P.y:externref:presence")).toBe(true);
    expect(keys.some((k) => k.startsWith("presence:P.y:"))).toBe(false);
    // `p.nope` is not a declared field of the struct — a real decline.
    expect(keys.some((k) => k.startsWith("nofield:P.nope"))).toBe(true);

    // The aggregate counters must account for every proven receiver: an
    // inlined read or exactly one decline reason, never both and never neither.
    let declines = 0;
    for (const [reason, count] of provenReceiverStats.reasons) {
      if (!reason.startsWith("ok:") && reason !== "unproven-receiver") declines += count;
    }
    expect(provenReceiverStats.proven).toBe(provenReceiverStats.inlined + declines);
  });
});
