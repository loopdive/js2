// (#2134) The IR effect model: one classification for scheduler + DCE, and an
// independent verifier that the computed emission schedule preserves program
// order for conflicting effects.
//
// Acceptance criteria covered here:
//   2. "A unit test injecting a deferred `class.get` past a `class.set` fails
//      verification" — the forged-schedule tests below.
//   (1. #1982 repros A+B live in tests/issue-1982-ir-emission-order.test.ts;
//    3. byte-identity on the playground corpus is proven in the PR via the
//    corpus-hash probe — see the issue file's Test Results.)

import { describe, it, expect } from "vitest";
import type { IrInstr, IrValueId } from "../src/ir/nodes.js";
import {
  effectsOf,
  effectsArePure,
  effectsConflict,
  isSideEffecting,
  verifyEmissionSchedule,
} from "../src/ir/effects.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// Minimal IrInstr stand-ins: the checker reads only `.kind` and `.result`;
// operand structure is injected via `usesOf`.
const vid = (n: number): IrValueId => n as unknown as IrValueId;
const instr = (kind: string, result: number | null): IrInstr =>
  ({ kind, result: result === null ? null : vid(result) }) as unknown as IrInstr;

describe("#2134 — emission-schedule verifier", () => {
  // Program order: v1 = class.get; class.set; use(v1).
  // usesOf: the consumer (index 2) uses v1; nothing else uses anything.
  const instrs = [instr("class.get", 1), instr("class.set", null), instr("binary", 2)];
  const usesOf = (i: IrInstr): readonly IrValueId[] => (i === instrs[2] ? [vid(1)] : []);

  it("REJECTS a class.get deferred past a class.set (forged schedule)", () => {
    // Forged: the get (idx 0) lazily emits at its consumer (idx 2), crossing
    // the set (idx 1) which emits in place — a read moved past a write.
    const violations = verifyEmissionSchedule(instrs, [2, 1, 2], [true, false, false], usesOf);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]!.defIndex).toBe(0);
    expect(violations[0]!.pastIndex).toBe(1);
    expect(violations[0]!.reason).toContain("class.get@0");
    expect(violations[0]!.reason).toContain("class.set@1");
  });

  it("ACCEPTS the anchored schedule (get emitted in place)", () => {
    const violations = verifyEmissionSchedule(instrs, [0, 1, 2], [false, false, false], usesOf);
    expect(violations).toEqual([]);
  });

  it("ACCEPTS same-tree emission when the consumer tree consumes the read", () => {
    // v1 = class.get; v2 = class.call(v1) — the get defers into the call's
    // tree (equal emission index). Legal: operands execute before consumers.
    const tree = [instr("class.get", 1), instr("class.call", 2)];
    const treeUses = (i: IrInstr): readonly IrValueId[] => (i === tree[1] ? [vid(1)] : []);
    expect(verifyEmissionSchedule(tree, [1, 1], [true, false], treeUses)).toEqual([]);
  });

  it("REJECTS same-tree emission without a consumption ordering", () => {
    // Two conflicting effectful ops forged to the same emission index where
    // the later one does NOT consume the earlier one's result.
    const pair = [instr("class.get", 1), instr("class.set", null)];
    const noUses = (): readonly IrValueId[] => [];
    const violations = verifyEmissionSchedule(pair, [1, 1], [true, false], noUses);
    expect(violations.length).toBe(1);
    expect(violations[0]!.reason).toContain("same tree");
  });

  it("ignores never-emitted instructions (dead reads constrain nothing)", () => {
    const violations = verifyEmissionSchedule(instrs, [Number.POSITIVE_INFINITY, 1, 2], [false, false, false], usesOf);
    expect(violations).toEqual([]);
  });

  it("pure values never conflict regardless of schedule", () => {
    const pure = [instr("const", 1), instr("class.set", null), instr("binary", 2)];
    const pureUses = (i: IrInstr): readonly IrValueId[] => (i === pure[2] ? [vid(1)] : []);
    // const deferred past the set — pure, so freely movable.
    expect(verifyEmissionSchedule(pure, [2, 1, 2], [true, false, false], pureUses)).toEqual([]);
  });
});

describe("#2134 — cross-table drift tripwire (scheduler table vs DCE facet)", () => {
  // Every kind the DCE facet pins as side-effecting must be non-pure in the
  // scheduler classification — otherwise the scheduler may reorder an op DCE
  // considers observable. `extern.regex` is the ONE documented divergence
  // (DCE-kept because RegExp_new may throw; scheduler-pure as a fresh
  // allocation) — asserted explicitly so resolving it (#2134 slice 3) updates
  // this test rather than silently changing behavior.
  const representative: readonly string[] = [
    "call",
    "global.set",
    "closure.call",
    "refcell.set",
    "object.set",
    "class.call",
    "class.set",
    "class.new",
    "slot.write",
    "iter.new",
    "iter.next",
    "iter.return",
    "throw",
    "extern.new",
    "extern.call",
    "extern.propSet",
    "extern.prop",
    "await",
    "async.return",
    "async.throw",
  ];

  it("isSideEffecting ⇒ not scheduler-pure (representative kinds)", () => {
    for (const kind of representative) {
      const i =
        kind === "slot.write" ? ({ kind, result: null, slotIndex: 0 } as unknown as IrInstr) : instr(kind, null);
      expect(isSideEffecting(i), `${kind} should be side-effecting`).toBe(true);
      expect(effectsArePure(effectsOf(i)), `${kind} must not be scheduler-pure`).toBe(false);
    }
  });

  it("documents the extern.regex divergence (DCE-kept, scheduler-pure)", () => {
    const i = instr("extern.regex", 1);
    expect(isSideEffecting(i)).toBe(true); // may throw → DCE keeps it
    expect(effectsArePure(effectsOf(i))).toBe(true); // scheduler treats as fresh allocation
  });

  it("control facet: throw/await/async.* are control effects and full barriers", () => {
    for (const kind of ["throw", "await", "async.return", "async.throw"]) {
      const fx = effectsOf(instr(kind, null));
      expect(fx.control, `${kind}.control`).toBe(true);
      expect(fx.readsHeap && fx.writesHeap, `${kind} full barrier`).toBe(true);
    }
  });

  it("conflict relation basics", () => {
    const read = effectsOf(instr("class.get", 1));
    const write = effectsOf(instr("class.set", null));
    const pure = effectsOf(instr("const", 1));
    expect(effectsConflict(read, write)).toBe(true);
    expect(effectsConflict(write, read)).toBe(true);
    expect(effectsConflict(read, read)).toBe(false); // two reads commute
    expect(effectsConflict(pure, write)).toBe(false);
  });
});

describe("#2134 — wired end-to-end (the verifier does not fire on correct schedules)", () => {
  it("the #1982 shape compiles IR-claimed and computes correctly", async () => {
    // Interleaved class reads/writes — the exact hazard family. The anchor
    // pass must anchor the read; the schedule verifier (now wired, with typed
    // Invariants always fatal) must stay silent.
    const src = `
class Box {
  v: number;
  constructor(v: number) { this.v = v; }
}
export function test(): number {
  const b = new Box(7);
  const before = b.v;   // must read 7, not 9
  b.v = 9;
  return before * 10 + b.v; // 79
}
`;
    const r = await compile(src, { fileName: "t.ts" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // No verifier demotion: under vitest a schedule violation is a HARD error,
    // and no "[IR-FALLBACK]"-channel warning mentioning the verifier may appear.
    expect(r.errors.some((e) => e.message.includes("emission-schedule verify"))).toBe(false);
    const imports = buildImports(r.imports, undefined, r.stringPool) as WebAssembly.Imports;
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    (imports as { setExports?: (e: unknown) => void }).setExports?.(instance.exports);
    expect((instance.exports as Record<string, () => unknown>).test()).toBe(79);
  });
});
