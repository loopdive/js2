/**
 * #3685 step 2 — admit PRESENCE-TRACKED externref fields into the
 * proven-receiver inline read.
 *
 * The step-1 census (`3af81b1b`) measured, over one standalone acorn compile,
 * 244 proven receiver verdicts against 88 inlined reads — and attributed
 * **156/156** of the gap to the presence-tracked carve-out (144 `presence:` +
 * 12 `reserved:Node.name`, which is itself a presence-tracked slot). The
 * carve-out's stated reason — "absence is semantic `undefined`, which a bare
 * `struct.get` cannot express" — is true of a bare `struct.get` and false of
 * the compiler: `emitNullGuardedStructGet` already emits
 * `presenceTestInstrs` → `if` → `struct.get` : `undefined` for exactly this
 * case. This slice nests that inside the existing `ref.test` then-arm.
 *
 * What has to be pinned is the semantics that make it delicate, because they
 * are the reason the carve-out existed:
 *
 *  1. a presence-tracked field READ BEFORE it is ever assigned yields
 *     `undefined` — not `null`, not the slot's raw contents, not a trap;
 *  2. after assignment it yields the value;
 *  3. both go through the proven-receiver inline path (asserted via the
 *     decline census, so a regression to the dynamic `__extern_get` arm — which
 *     would answer the same values and hide the loss — still fails);
 *  4. the HARD CORRECTNESS CONDITION: only **externref** presence-tracked
 *     slots are admitted. `undefined` has no representation in an f64/i32/i64
 *     slot, where the absent arm would substitute `0` for a value whose
 *     semantics are `undefined`.
 *
 * Every semantic expectation is checked against the SAME source evaluated as
 * plain JavaScript, so the pin cannot drift into freezing a compiler quirk.
 */
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { provenReceiverStats, resetProvenReceiverStats } from "../src/codegen/proven-receiver-stats.ts";

// `label` is assigned only under a condition, so it is a presence-tracked slot
// of `$__fnctor_Node`, and it is written from an UNTYPED PARAMETER, which is
// what keeps that slot `externref` — the admission this file pins is
// externref-only by design. `n` is a never-reassigned binding initialized from
// `new Node(...)`, which the #3685 S1 receiver-flow analysis proves — so the
// reads below reach `tryEmitProvenReceiverFieldGet` with a verdict in hand.
//
// (2026-08-09) The condition used to live OUTSIDE the constructor
// (`function tag(n, v) { if (v > 0) { n.label = "L" + v; } }`). Two later
// changes each independently stopped that shape from producing the slot this
// file is about, and the census assertion below had been red on `main` ever
// since:
//
//   - #4194's instance-expando substrate routes a field first written from
//     outside the constructor into the `$$resid` EXPANDO BAG, so `label` was
//     not a struct field at all and every read declined `nofield:Node.label`;
//   - writing `"L" + v` makes the slot a native string `ref_null`, which the
//     admission correctly refuses (`presence-nonextern:`).
//
// Both of those are pinned below as kill-switches rather than merely described,
// because either one silently turns this file's main assertion into a test of
// nothing. The machinery itself was verified intact at the same time: the
// fixture below produces `ok:Node.label:externref:presence` x4, the exact key
// this file has always asserted.
const SOURCE = `
function Node(pos, v) {
  this.start = pos;
  this.type = "T";
  if (pos > 0) { this.label = v; }
}
export function readBeforeAssign() { var n = new Node(0, "L5"); return n.label === undefined ? 1 : 0; }
export function readAfterAssign() { var n = new Node(2, "L5"); return n.label === "L5" ? 1 : 0; }
export function absentIsNotNull() { var n = new Node(0, "L5"); return n.label === null ? 1 : 0; }
export function typeofAbsent() { var n = new Node(0, "L5"); return typeof n.label === "undefined" ? 1 : 0; }
export function plainFieldStillReads() { var n = new Node(9, "L5"); return n.start; }
`;

/**
 * The two shapes that must NOT reach the presence admission, each with the
 * decline reason it must produce. These are the kill-switches for `SOURCE`
 * above: they are the shapes it used to have, and each one reaching `ok:` would
 * mean the externref-only rule had been relaxed.
 */
const DECLINING_SHAPES = [
  {
    what: "native-string presence slot (#3753 promoted the carrier)",
    reason: "presence-nonextern:Node.label:ref_null",
    source: `
function Node(pos, v) { this.start = pos; this.type = "T"; if (pos > 0) { this.label = "L" + v; } }
export function readBeforeAssign() { var n = new Node(0, 5); return n.label === undefined ? 1 : 0; }
export function readAfterAssign() { var n = new Node(2, 5); return n.label === "L5" ? 1 : 0; }
`,
  },
  {
    what: "first written from OUTSIDE the ctor (#4194 expando bag)",
    reason: "nofield:Node.label",
    source: `
function Node(pos) { this.start = pos; this.type = "T"; }
function tag(n, v) { if (v > 0) { n.label = "L" + v; } return n; }
export function readBeforeAssign() { var n = new Node(1); return n.label === undefined ? 1 : 0; }
export function readAfterAssign() { var n = new Node(2); tag(n, 5); return n.label === "L5" ? 1 : 0; }
`,
  },
] as const;

const EXPORT_NAMES = [
  "readBeforeAssign",
  "readAfterAssign",
  "absentIsNotNull",
  "typeofAbsent",
  "plainFieldStillReads",
] as const;

async function buildStandalone(): Promise<Record<string, () => unknown>> {
  const r = await compile(SOURCE, {
    fileName: "t.mjs",
    skipSemanticDiagnostics: true,
    target: "standalone",
    optimize: 0,
  });
  expect(r.binary?.length ?? 0).toBeGreaterThan(0);
  const module = await WebAssembly.compile(r.binary as BufferSource);
  // Standalone canary: the guarded read must not pull in a host import.
  expect(WebAssembly.Module.imports(module).length).toBe(0);
  const { exports } = await WebAssembly.instantiate(module, {});
  return exports as Record<string, () => unknown>;
}

function evaluateAsPlainJs(): Record<string, () => unknown> {
  const body = `${SOURCE.replace(/export /g, "")}\nreturn { ${EXPORT_NAMES.join(", ")} };`;
  return new Function(body)() as Record<string, () => unknown>;
}

afterEach(() => {
  // Cleared rather than `delete`d — biome's `noDelete`, and the gate reads
  // `=== "1"` so empty is indistinguishable from unset.
  process.env.JS2WASM_PROVEN_RECEIVER_STATS = "";
  resetProvenReceiverStats();
});

describe("#3685 step 2 — presence-tracked proven-receiver field reads", () => {
  it("matches plain JS before and after the field is ever assigned", async () => {
    const wasm = await buildStandalone();
    const js = evaluateAsPlainJs();
    for (const name of EXPORT_NAMES) {
      expect(`${name}=${String(wasm[name]?.())}`).toBe(`${name}=${String(js[name]?.())}`);
    }
    // Spelled out, so a change to the JS control cannot quietly relax the pin:
    // absent reads as `undefined` (1), is NOT null (0), `typeof` says
    // "undefined" (1), and the assigned read yields the value (1).
    expect(wasm.readBeforeAssign?.()).toBe(1);
    expect(wasm.readAfterAssign?.()).toBe(1);
    expect(wasm.absentIsNotNull?.()).toBe(0);
    expect(wasm.typeofAbsent?.()).toBe(1);
  });

  it("takes the proven-receiver inline path, not the dynamic __extern_get arm", async () => {
    process.env.JS2WASM_PROVEN_RECEIVER_STATS = "1";
    resetProvenReceiverStats();
    await buildStandalone();

    const reasons = [...provenReceiverStats.reasons.keys()];
    // Admitted, and tagged `:presence` so the census can tell the two shapes
    // apart. Before this slice these same sites recorded `presence:Node.label:`.
    expect(reasons.some((k) => k === "ok:Node.label:externref:presence")).toBe(true);
    expect(reasons.some((k) => k.startsWith("presence:Node.label"))).toBe(false);
    expect(provenReceiverStats.inlined).toBeGreaterThanOrEqual(4);

    // Every proven receiver is still accounted for exactly once.
    let declines = 0;
    for (const [reason, count] of provenReceiverStats.reasons) {
      if (!reason.startsWith("ok:") && reason !== "unproven-receiver") declines += count;
    }
    expect(provenReceiverStats.proven).toBe(provenReceiverStats.inlined + declines);
  });

  it.each(DECLINING_SHAPES)(
    "kill-switch: $what declines with $reason and still matches plain JS",
    async ({ reason, source }) => {
      process.env.JS2WASM_PROVEN_RECEIVER_STATS = "1";
      resetProvenReceiverStats();
      const r = await compile(source, {
        fileName: "t.mjs",
        skipSemanticDiagnostics: true,
        target: "standalone",
        optimize: 0,
      });
      expect(r.binary?.length ?? 0).toBeGreaterThan(0);

      // The point of the pin: these shapes reach the proven-receiver analysis
      // (so the fixture is not simply failing to compile the reads) and are
      // then REFUSED, for the stated reason.
      expect(provenReceiverStats.proven).toBeGreaterThan(0);
      expect([...provenReceiverStats.reasons.keys()]).toContain(reason);
      expect([...provenReceiverStats.reasons.keys()].some((k) => k.startsWith("ok:Node.label"))).toBe(false);

      // A refusal must cost precision only — never an answer.
      const module = await WebAssembly.compile(r.binary as BufferSource);
      expect(WebAssembly.Module.imports(module).length).toBe(0);
      const wasm = (await WebAssembly.instantiate(module, {})).exports as Record<string, () => unknown>;
      const js = new Function(
        `${source.replace(/export /g, "")}\nreturn { readBeforeAssign, readAfterAssign };`,
      )() as Record<string, () => unknown>;
      for (const name of ["readBeforeAssign", "readAfterAssign"]) {
        expect(`${name}=${String(wasm[name]?.())}`).toBe(`${name}=${String(js[name]?.())}`);
      }
    },
  );

  it("admits a presence-tracked slot ONLY when it is externref", async () => {
    process.env.JS2WASM_PROVEN_RECEIVER_STATS = "1";
    resetProvenReceiverStats();
    await buildStandalone();

    // The hard correctness condition, stated structurally so it holds for any
    // program: a `:presence` admission always carries an `externref` slot type.
    // A non-externref presence-tracked field must decline
    // (`presence-nonextern:`), because its absent arm could only be a numeric
    // default — `0` where the semantics demand `undefined`.
    for (const reason of provenReceiverStats.reasons.keys()) {
      if (reason.startsWith("ok:") && reason.endsWith(":presence")) {
        expect(reason).toContain(":externref:");
      }
    }
  });
});
