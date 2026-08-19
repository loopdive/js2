// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3954 PHASE 3 — the falsification test: is the tag-domain seam REAL or NOMINAL?
//
// Phase 3's brief (issue #3954, "Proposal → Phase 3"):
//
//   > Validate it with the existing `backend/bytecode-vm.ts` plus a synthetic
//   > non-JS tag domain constructed in tests: build IR carrying a tag domain JS
//   > could not produce and assert it lowers and verifies. This is the cheap
//   > falsification test — if it can't be written, the seam is nominal.
//
// ORIGINAL VERDICT (2026-08-19): **the seam is real for the TYPE LATTICE and
// nominal for every OPERATION on a dynamic value.** A non-JS domain can define
// its partitions, carriers, lattice and coercion rules; those partitions can
// ride an `IrType`; and IR built against the domain's own carrier decisions
// lowers through the production `lower.ts` and RUNS on the real bytecode VM.
// But the instant the IR must *use* a dynamic value — `unbox` it, `tag.test`
// it, or `box` with the partition proven — the node fields, the verifier and
// the lowering pass all spoke `JsTag`, and the synthetic domain was bypassed.
//
// UPDATED VERDICT: **W3, W4 and W5 are CLOSED.** A foreign partition can now be
// named on an `unbox`/`tag.test` node, built by `IrFunctionBuilder`, and
// verified against its own domain — including the Abacus-specific singleton and
// carrier rules. What remains nominal is the LOWERING of a dynamic value: W2
// and W6 are one move, gated on the review of the #3029-S1-frozen
// `IrDynamicLowering` contract, and W1 is a backend-capability gap owned by
// #1584.
//
// Every wall below is asserted, not asserted-about: each `it` pins the exact
// error or type-level refusal, so a future slice that closes one of them turns
// a passing expectation red and has to come back here and say so.
//
// The walls, with their file:line as of the ORIGINAL run:
//
//   W1  src/ir/backend/legality.ts:451  OPEN. The bytecode backend rejects the
//       `dynamic` IrType outright ("does not support IR type 'dynamic'"), and
//       :300 rejects the `box`/`unbox`/`tag.test` instructions. Phase 3's
//       literal vehicle therefore cannot carry a tag-bearing value AT ALL —
//       for a backend-capability reason, not a seam reason. #1584's business.
//   W2  src/ir/lower.ts:1764           OPEN, deliberately. `jsTagOf(
//       instr.toType.tag)` — the box-to-dynamic hint crossing. Throws on a
//       foreign partition. Closing it edits the frozen `IrDynamicLowering`
//       contract, so it moves with W6 or not at all.
//   W3  src/ir/verify.ts:673           CLOSED. `verifyIrFunction(func, domain?)`
//       now takes the domain (default `defaultTagDomain()`), threaded down to
//       the per-instruction rules.
//   W4  src/ir/nodes.ts:1072 / :1093   CLOSED. The fields are `tagId?: TagId`.
//       NOTE the underlying language-level hole is UNCHANGED: `TagId` is still
//       assignable to a numeric enum, so `TagId → JsTag` compiles with no cast.
//       Widening the fields removed the sites where that mattered; the runtime
//       check in `jsTagOf` is what guards the remaining crossing (W6).
//   W5  src/ir/builder.ts:481          CLOSED. `emitUnbox(value, tagId: TagId)`
//       / `emitTagTest(value, tagId: TagId)`, answering from a `TagDomain` the
//       builder HOLDS (5th ctor arg, same default).
//   W6  src/ir/backend/handles.ts:283/300/308/319 — OPEN. The frozen (#3029-S1)
//       `IrDynamicLowering` contract is `JsTag`-typed member by member, and its
//       `emitToBoolean`/`emitToNumber` are §7.1.2/§7.1.4 by definition.
//
// See the "Phase 3 findings" section of the issue file for what closing each
// would cost.

import { describe, expect, it } from "vitest";

import { BytecodeEmitter, BytecodeSink, BytecodeTypeConverter, OP } from "../src/ir/backend/bytecode-emitter.js";
import type { IrDynamicLowering } from "../src/ir/backend/handles.js";
import { verifyIrBackendLegality } from "../src/ir/backend/legality.js";
import { type FuncEntry, type Program, runProgram } from "../src/ir/backend/bytecode-vm.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import type { JsTag } from "../src/ir/js-tag.js";
import { JS_TAG_IDS } from "../src/ir/js-tag-domain.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { type IrLowerResolver, lowerIrFunctionBody, wasmValueTypeConverter } from "../src/ir/lower.js";
import type { IrFunction, IrInstr, IrType } from "../src/ir/nodes.js";
import { asBlockId, asValueId, irDynamic, irVal } from "../src/ir/nodes.js";
import { irUnitFuncRef } from "../src/ir/callable-bindings.js";
import {
  asTagId,
  formatTagRefinement,
  isSingletonTag,
  joinTagRefinement,
  tagIdValue,
  type TagCarrierKind,
  type TagDomain,
  type TagId,
  type TagNumericCoercion,
  type TagTruthiness,
} from "../src/ir/tag-domain.js";
import type { ValType } from "../src/ir/types.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

// ───────────────────────────────────────────────────────────────────────────
// The synthetic domain: "Abacus", an exact-arithmetic language.
// ───────────────────────────────────────────────────────────────────────────
//
// Chosen so that NO partition of it is expressible as a `JsTag`, and so that
// several of its properties are ones ECMAScript cannot have at all:
//
//   - **No floating point anywhere.** Abacus has no f64, therefore no `NaN`,
//     no `-0`, and no `Infinity`. ECMAScript's tag set cannot avoid f64: the
//     `Number` type IS a double (§6.1.6.1), and `JsTag.NumberF64`'s carrier is
//     the f64 payload field. A domain with zero `f64` carriers is the cleanest
//     single proof that this is not JavaScript wearing a hat.
//   - **`Rune` is a first-class SCALAR character type.** JavaScript has no
//     character type — a "character" is a 1-length `String`, and above the BMP
//     not even that (a UTF-16 surrogate PAIR, length 2). U+1F600 is one Abacus
//     `Rune` and two JavaScript code units.
//   - **`Text` is codepoint-indexed, and refuses numeric coercion.** ECMAScript
//     §7.1.4 sends `String` through §7.1.4.1 StringToNumber; Abacus has no
//     implicit string→integer conversion at all, so its `Text` numeric arm is
//     `throws`, which is the arm §7.1.4 reserves for Symbol/BigInt.
//   - **`Cap` is an AFFINE capability**: consumed on use, not duplicable, not
//     discardable. There is no ECMAScript value with a use-once discipline.
//   - **`Nat <: Int` is a genuine subtype relation**, so `joinTags` returns a
//     proper supertag. ECMAScript's partitions are flat — every distinct pair
//     joins to the lattice top.
//   - **Exactly ONE nullary value.** ECMAScript famously has two (`null` and
//     `undefined`), which is why `JsTag` carries two payload-less partitions.
//
// The ids start at 1001 DELIBERATELY: they are disjoint from `JsTag`'s 0..7, so
// any code that assumes the ECMAScript numbering fails loudly instead of
// silently reinterpreting an Abacus partition as a JavaScript one. (A domain
// may renumber freely — `tag-domain.ts` says so — and the JS domain's own
// numbering is pinned only because it is `$AnyValue.tag` ABI.)

const ABACUS_TAGS = {
  /** The unit value. Exactly one, unlike ECMAScript's null + undefined pair. */
  Unit: asTagId(1001),
  /** A Unicode scalar value, as a SCALAR — not a 1-length string. */
  Rune: asTagId(1002),
  /** Arbitrary-precision natural. */
  Nat: asTagId(1003),
  /** Arbitrary-precision integer; `Nat` is a proper subtype of it. */
  Int: asTagId(1004),
  /** Codepoint-indexed text (not UTF-16 code units). */
  Text: asTagId(1005),
  /** An affine capability handle — used once, never copied. */
  Cap: asTagId(1006),
} as const;

const ABACUS_NAMES: ReadonlyMap<number, string> = new Map(
  Object.entries(ABACUS_TAGS).map(([name, id]) => [tagIdValue(id), name]),
);

function abacusName(tag: TagId): string {
  const name = ABACUS_NAMES.get(tagIdValue(tag));
  if (name === undefined) throw new Error(`abacus: tag id ${tagIdValue(tag)} is not an Abacus partition`);
  return name;
}

const ABACUS_TAG_DOMAIN: TagDomain = {
  id: "abacus",
  tags: Object.values(ABACUS_TAGS),
  nameOf: abacusName,
  // Each Abacus partition is its own source-language type. There is no analogue
  // of ECMAScript's invariant V2 (two carriers, one `number` type) — Abacus's
  // numeric tower is exact, so `Nat` and `Int` are genuinely different types
  // related by subtyping, not two representations of one.
  classOf: abacusName,
  carrierKindOf: (tag): TagCarrierKind => {
    switch (tagIdValue(tag)) {
      case tagIdValue(ABACUS_TAGS.Unit):
        // Payload-less singleton: its identity is all it has.
        return null;
      case tagIdValue(ABACUS_TAGS.Rune):
      case tagIdValue(ABACUS_TAGS.Cap):
        // A scalar codepoint and an affine handle are both machine words.
        return "i32";
      default:
        // Bignums and codepoint text are heap values. NOTE: never "f64" —
        // Abacus has no floating point at all. Asserted below.
        return "ref";
    }
  },
  // Abacus has NO implicit boolean coercion — conditionals take a `Bool`, full
  // stop. `"not-coercible"` is the arm #3954 phase 3 added to `TagTruthiness`
  // for exactly this: before it, a domain with no ToBoolean had to answer with
  // one of three ECMAScript-shaped lies. See `src/ir/tag-domain.ts`.
  truthinessOf: (): TagTruthiness => "not-coercible",
  numericCoercionOf: (tag): TagNumericCoercion => {
    switch (tagIdValue(tag)) {
      case tagIdValue(ABACUS_TAGS.Rune):
      case tagIdValue(ABACUS_TAGS.Nat):
      case tagIdValue(ABACUS_TAGS.Int):
        // A rune's ordinal and an integer's value are pure payload reads.
        return { kind: "payload" };
      default:
        // Unit, Text and Cap have no numeric meaning. Note the contrast with
        // ECMA-262 §7.1.4, where EVERY partition except Symbol/BigInt coerces:
        // `Number(null)` is `+0`, `Number("12")` is `12`, `Number({})` runs
        // user code. Abacus refuses all three.
        return { kind: "throws" };
    }
  },
  // `Nat ⊑ Int` — a real hierarchy, so the join is a proper supertag rather
  // than the lattice top ECMAScript's flat partitions always widen to.
  joinTags: (a, b) => {
    if (a === b) return a;
    const pair = new Set([tagIdValue(a), tagIdValue(b)]);
    if (pair.has(tagIdValue(ABACUS_TAGS.Nat)) && pair.has(tagIdValue(ABACUS_TAGS.Int))) return ABACUS_TAGS.Int;
    return undefined;
  },
};

describe("#3954 phase 3 — the synthetic domain is one JavaScript cannot produce", () => {
  it("has no f64 carrier at all — ECMAScript's Number type IS a double", () => {
    const carriers = ABACUS_TAG_DOMAIN.tags.map((t) => ABACUS_TAG_DOMAIN.carrierKindOf(t));
    expect(carriers).not.toContain("f64");
    // …and therefore no partition coerces to a fixed f64 constant, which is the
    // shape §7.1.4 needs for `undefined → NaN` and `null → +0`.
    for (const tag of ABACUS_TAG_DOMAIN.tags) {
      expect(ABACUS_TAG_DOMAIN.numericCoercionOf(tag).kind).not.toBe("constant");
    }
  });

  it("has exactly ONE payload-less singleton — ECMAScript has two", () => {
    const singletons = ABACUS_TAG_DOMAIN.tags.filter((t) => isSingletonTag(ABACUS_TAG_DOMAIN, t));
    expect(singletons).toEqual([ABACUS_TAGS.Unit]);
  });

  it("refuses string→number coercion, where §7.1.4.1 StringToNumber accepts it", () => {
    expect(ABACUS_TAG_DOMAIN.numericCoercionOf(ABACUS_TAGS.Text)).toEqual({ kind: "throws" });
    // The affine capability has no numeric reading either — there is no
    // ECMAScript value with a use-once discipline to compare it to.
    expect(ABACUS_TAG_DOMAIN.numericCoercionOf(ABACUS_TAGS.Cap)).toEqual({ kind: "throws" });
  });

  it("has a real subtype relation, so joins land on a supertag not on top", () => {
    expect(joinTagRefinement(ABACUS_TAG_DOMAIN, ABACUS_TAGS.Nat, ABACUS_TAGS.Int)).toBe(ABACUS_TAGS.Int);
    expect(joinTagRefinement(ABACUS_TAG_DOMAIN, ABACUS_TAGS.Nat, ABACUS_TAGS.Text)).toBeUndefined();
    // The neutral helpers in `tag-domain.ts` are the SAME code the JS domain
    // uses — different lattice, no branch on language.
    expect(formatTagRefinement(ABACUS_TAG_DOMAIN, ABACUS_TAGS.Cap)).toBe("Cap");
    expect(formatTagRefinement(ABACUS_TAG_DOMAIN, undefined)).toBe("?");
  });

  it("states 'this language has no boolean coercion' rather than a JS-shaped lie", () => {
    for (const tag of ABACUS_TAG_DOMAIN.tags) {
      expect(ABACUS_TAG_DOMAIN.truthinessOf(tag)).toBe("not-coercible");
    }
  });

  it("numbers its partitions disjointly from JsTag, so a JS assumption fails loudly", () => {
    for (const tag of ABACUS_TAG_DOMAIN.tags) expect(tagIdValue(tag)).toBeGreaterThan(7);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PART 1 — what the seam DOES deliver: the domain's carrier decisions drive
// real lowering, and the result runs on the real VM.
// ───────────────────────────────────────────────────────────────────────────
//
// This is the strongest form of the phase-3 exercise that is actually
// reachable. The IR's parameter and result types are DERIVED from
// `ABACUS_TAG_DOMAIN.carrierKindOf`, not hand-written — so if the domain said
// something different the program would lower differently. The production
// `lowerIrFunctionBody` (the same entry point the WasmGC path uses) emits the
// opcode stream, and the production `runProgram` executes it, and the answers
// are checked against Abacus's own semantics over `bigint` naturals.
//
// What this does NOT show: nothing here consults the domain INSIDE the
// compiler. `carrierKindOf` is read by the test, in the role of the producer.
// Part 2 is where the compiler itself would have to ask, and does not.

const irIdentities = createTestIrFunctionIdentityFactory("issue-3954-phase3");

/**
 * The Abacus → bytecode-VM value representation, derived from the DOMAIN.
 *
 * The VM's value domain is homogeneous f64 (`bytecode-vm.ts` header), and it
 * already encodes references as f64 indices — `funcref ≡ f64(tableIndex)`,
 * struct ref ≡ `f64(heapIndex)`. A `"ref"`-carried Abacus partition therefore
 * rides an f64 HANDLE into the Abacus heap, exactly the convention the VM
 * documents for its own structs. That is a backend representation decision, and
 * it is the backend's to make: `TagCarrierKind` says "reference-shaped", not
 * which reference.
 */
function abacusSlotType(tag: TagId): ValType {
  const carrier = ABACUS_TAG_DOMAIN.carrierKindOf(tag);
  switch (carrier) {
    case "i32":
      return { kind: "i32" };
    case "f64":
      // Unreachable for Abacus — asserted above. Present so the switch is total
      // over `TagCarrierKind` rather than assuming this domain's shape.
      return { kind: "f64" };
    case "ref":
      return { kind: "f64" }; // the VM's handle encoding
    case null:
      throw new Error(`abacus: ${abacusName(tag)} is payload-less and has no slot`);
  }
}

/** The Abacus runtime heap for this test: handle → arbitrary-precision value. */
class AbacusHeap {
  private readonly cells: bigint[] = [];
  /** Intern an exact natural, returning the f64 handle the VM will carry. */
  alloc(value: bigint): number {
    this.cells.push(value);
    return this.cells.length - 1;
  }
  /** Resolve a handle the VM produced back to the exact natural it denotes. */
  read(handle: number): bigint {
    const cell = this.cells[handle];
    if (cell === undefined) throw new Error(`abacus: dangling handle ${handle}`);
    return cell;
  }
}

/**
 * Minimal resolver for the Abacus program. `resolveFunc` maps an Abacus
 * function name to its bytecode function-table index.
 */
function abacusBytecodeResolver(table: ReadonlyMap<string, number>): IrLowerResolver {
  let nextTypeIdx = 0;
  return {
    resolveFunc: (ref) => {
      const idx = table.get(ref.name);
      if (idx === undefined) throw new Error(`abacus: no table entry for ${ref.name}`);
      return idx;
    },
    resolveGlobal: () => {
      throw new Error("abacus: globals are not used by this program");
    },
    resolveType: () => {
      throw new Error("abacus: named types are not used by this program");
    },
    internFuncType: () => nextTypeIdx++,
  };
}

function toFuncEntry(sink: BytecodeSink, arity: number, nLocals: number): FuncEntry {
  return {
    code: sink.code.slice(),
    constPool: sink.constPool.slice(),
    arity,
    nLocals,
    exceptionTable: [],
  };
}

/**
 * The Abacus program, in IR:
 *
 *   share(n: Nat) -> Nat            = n                  (funcIdx 1)
 *   pick(k: Rune, a: Nat, b: Nat)   = if k == U+1F600 then share(a) else share(b)
 *
 * `U+1F600` is deliberate: it is ONE Abacus `Rune` and TWO JavaScript UTF-16
 * code units, so the comparison the IR performs is not one a JS `String`
 * character comparison could express.
 */
const GRINNING_FACE = 0x1f600;

function buildAbacusProgram(): { pick: IrFunction; share: IrFunction } {
  const runeSlot = irVal(abacusSlotType(ABACUS_TAGS.Rune));
  const natSlot = irVal(abacusSlotType(ABACUS_TAGS.Nat));
  const shareIdentity = irIdentities.next("share");
  const shareRef = irUnitFuncRef(shareIdentity);

  const share: IrFunction = {
    ...shareIdentity,
    params: [{ value: asValueId(0), type: natSlot, name: "n" }],
    resultTypes: [natSlot],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [],
        terminator: { kind: "return", values: [asValueId(0)] },
      },
    ],
    exported: true,
    valueCount: 1,
  };

  const pick: IrFunction = {
    ...irIdentities.next("pick"),
    params: [
      { value: asValueId(0), type: runeSlot, name: "k" },
      { value: asValueId(1), type: natSlot, name: "a" },
      { value: asValueId(2), type: natSlot, name: "b" },
    ],
    resultTypes: [natSlot],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            kind: "const",
            value: { kind: "i32", value: GRINNING_FACE },
            result: asValueId(3),
            resultType: runeSlot,
          },
          {
            kind: "binary",
            op: "i32.eq",
            lhs: asValueId(0),
            rhs: asValueId(3),
            result: asValueId(4),
            resultType: irVal({ kind: "i32" }),
          },
          {
            kind: "if",
            cond: asValueId(4),
            then: [
              {
                kind: "call",
                target: shareRef,
                args: [asValueId(1)],
                result: asValueId(5),
                resultType: natSlot,
              },
            ],
            thenValue: asValueId(5),
            else: [
              {
                kind: "call",
                target: shareRef,
                args: [asValueId(2)],
                result: asValueId(6),
                resultType: natSlot,
              },
            ],
            elseValue: asValueId(6),
            result: asValueId(7),
            resultType: natSlot,
          },
        ],
        terminator: { kind: "return", values: [asValueId(7)] },
      },
    ],
    exported: true,
    valueCount: 8,
  };

  return { pick, share };
}

describe("#3954 phase 3 — PART 1: an Abacus program verifies, lowers and RUNS", () => {
  const { pick, share } = buildAbacusProgram();
  const table = new Map([
    ["pick", 0],
    ["share", 1],
  ]);

  it("the production verifier accepts it", () => {
    expect(verifyIrFunction(pick)).toEqual([]);
    expect(verifyIrFunction(share)).toEqual([]);
  });

  it("the bytecode backend's legality gate accepts it", () => {
    expect(verifyIrBackendLegality(pick, "bytecode")).toEqual([]);
    expect(verifyIrBackendLegality(share, "bytecode")).toEqual([]);
  });

  it("the real lower.ts + the real VM compute Abacus's answer, on bigints", () => {
    const resolver = abacusBytecodeResolver(table);
    const lowered = [pick, share].map((fn) =>
      lowerIrFunctionBody(fn, resolver, new BytecodeEmitter(), new BytecodeTypeConverter()),
    );
    // Pin that the two-frame call path really ran: `pick` dispatches through
    // OP.CALL in BOTH arms, so the answer below came from `share`'s frame.
    expect(lowered[0]!.body.code.filter((op) => op === OP.CALL)).toHaveLength(2);
    const program: Program = {
      functions: [
        toFuncEntry(lowered[0]!.body, 3, 3 + lowered[0]!.locals.length),
        toFuncEntry(lowered[1]!.body, 1, 1 + lowered[1]!.locals.length),
      ],
      entry: 0,
    };

    // Two naturals far beyond IEEE-754's exact-integer range — the values are
    // never in an f64, only their HANDLES are, which is the whole point of a
    // ref-carried arbitrary-precision partition.
    const heap = new AbacusHeap();
    const big = heap.alloc(2n ** 200n + 1n);
    const bigger = heap.alloc(2n ** 300n - 7n);

    expect(heap.read(runProgram(program, [GRINNING_FACE, big, bigger]))).toBe(2n ** 200n + 1n);
    expect(heap.read(runProgram(program, [0x41, big, bigger]))).toBe(2n ** 300n - 7n);
    // U+1F600's high surrogate alone (0xD83D) is NOT the rune — a JS string
    // comparison over code units would see a match here and Abacus does not.
    expect(heap.read(runProgram(program, [0xd83d, big, bigger]))).toBe(2n ** 300n - 7n);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PART 2 — the walls. Where the seam stops being real.
// ───────────────────────────────────────────────────────────────────────────

/** A `dynamic<Abacus.Nat>` IrType — a foreign partition riding the IR lattice. */
const ABACUS_NAT_DYN: IrType = irDynamic(ABACUS_TAGS.Nat);

function boxToAbacusNat(): IrFunction {
  return {
    ...irIdentities.next("boxNat"),
    params: [{ value: asValueId(0), type: irVal({ kind: "f64" }), name: "raw" }],
    resultTypes: [ABACUS_NAT_DYN],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            kind: "box",
            value: asValueId(0),
            toType: ABACUS_NAT_DYN,
            result: asValueId(1),
            resultType: ABACUS_NAT_DYN,
          },
        ],
        terminator: { kind: "return", values: [asValueId(1)] },
      },
    ],
    exported: true,
    valueCount: 2,
  };
}

describe("#3954 phase 3 — W1: the bytecode backend cannot carry a dynamic value at all", () => {
  // This is the finding that most directly contradicts phase 3's own brief.
  // The issue names `backend/bytecode-vm.ts` as the validation vehicle; that
  // backend's legality gate rejects the `dynamic` IrType and the box/unbox/
  // tag.test instructions outright, for a reason that has NOTHING to do with
  // tag domains — the VM has no boxed-value representation. So no tag domain,
  // JS or otherwise, can be exercised operationally through it.

  it("rejects the `dynamic` IrType (legality.ts:451) — for JS and Abacus alike", () => {
    const fn = boxToAbacusNat();
    const errors = verifyIrBackendLegality(fn, "bytecode");
    expect(errors.map((e) => e.message).join("\n")).toMatch(/bytecode backend does not support IR type 'dynamic'/);
  });

  it("rejects the `box` instruction itself (legality.ts:300)", () => {
    const fn = boxToAbacusNat();
    const errors = verifyIrBackendLegality(fn, "bytecode");
    expect(errors.map((e) => e.message).join("\n")).toMatch(/bytecode backend does not support IR instruction 'box'/);
  });

  it("…and the same is true of a JS-domain dynamic — this is not about Abacus", () => {
    // Control: swap the Abacus partition for an unrefined dynamic. Still
    // rejected, so W1 is a backend-capability wall, not a seam wall. Naming it
    // as such matters: closing the seam would not make this test pass.
    const fn = boxToAbacusNat();
    const jsFlavoured: IrFunction = {
      ...fn,
      resultTypes: [irDynamic()],
      blocks: fn.blocks.map((b) => ({
        ...b,
        instrs: b.instrs.map((i) => (i.kind === "box" ? { ...i, toType: irDynamic(), resultType: irDynamic() } : i)),
      })),
    };
    expect(verifyIrBackendLegality(jsFlavoured, "bytecode").length).toBeGreaterThan(0);
  });
});

/**
 * A stand-in for the backend's dynamic-lowering handle.
 *
 * Its `emitBox` throws deliberately: the point of the W2 test is that lowering
 * NEVER REACHES the backend. `lower.ts` converts the tag id to a `JsTag` before
 * it consults the handle, so the crossing — not the backend's capability — is
 * what fails. The cast is confined to this one double: the real interface has
 * ~14 members (`handles.ts:266`), every one of which is `JsTag`-typed or
 * ECMA-262-defined, which is itself W6.
 */
const UNREACHED_DYNAMIC_LOWERING = {
  carrier: { kind: "ref_null", typeIdx: 0 } as ValType,
  strategy: "gc" as const,
  anyValueTypeIdx: 0,
  tagFieldIdx: 0,
  emitBox(): readonly never[] {
    throw new Error("unreached: lower.ts must fail at the TagId→JsTag crossing before the handle is consulted");
  },
} as unknown as IrDynamicLowering;

function abacusWasmGcResolver(): IrLowerResolver {
  return {
    resolveFunc: () => {
      throw new Error("abacus: no calls in the box fixture");
    },
    resolveGlobal: () => {
      throw new Error("abacus: no globals in the box fixture");
    },
    resolveType: () => {
      throw new Error("abacus: no named types in the box fixture");
    },
    internFuncType: () => 0,
    resolveDynamic: () => ({ kind: "ref_null", typeIdx: 0 }),
    resolveDynamicLowering: () => UNREACHED_DYNAMIC_LOWERING,
  };
}

describe("#3954 phase 3 — W2: box-to-dynamic crosses to JsTag inside the lowering pass", () => {
  it("the verifier ACCEPTS a box carrying a foreign partition", () => {
    // The seam holds here: `verify.ts`'s box-to-dynamic rule (R1) never reads
    // the refinement, so an Abacus partition passes unexamined. This is the
    // "real for the type lattice" half of the verdict.
    expect(verifyIrFunction(boxToAbacusNat())).toEqual([]);
  });

  it("the LOWERER rejects it — `jsTagOf` at lower.ts:1764 is unconditional", () => {
    const fn = boxToAbacusNat();
    const resolver = abacusWasmGcResolver();
    expect(() =>
      lowerIrFunctionBody(fn, resolver, new WasmGcEmitter(), wasmValueTypeConverter("wasmgc", resolver, fn.name)),
    ).toThrow(/tag id 1003 is not an ECMAScript partition/);
  });

  it("the identical function with the refinement DROPPED lowers fine", () => {
    // Isolates the cause to the tag, not to the fixture: an UNREFINED dynamic
    // reaches the backend handle (which then throws its own sentinel). So the
    // only thing standing between Abacus and the backend is the JS crossing.
    const fn = boxToAbacusNat();
    const unrefined: IrFunction = {
      ...fn,
      resultTypes: [irDynamic()],
      blocks: fn.blocks.map((b) => ({
        ...b,
        instrs: b.instrs.map((i) => (i.kind === "box" ? { ...i, toType: irDynamic(), resultType: irDynamic() } : i)),
      })),
    };
    const resolver = abacusWasmGcResolver();
    expect(() =>
      lowerIrFunctionBody(
        unrefined,
        resolver,
        new WasmGcEmitter(),
        wasmValueTypeConverter("wasmgc", resolver, unrefined.name),
      ),
    ).toThrow(/unreached: lower\.ts must fail at the TagId→JsTag crossing/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// W3 / W4 / W5 — CLOSED (#3954 phase 3 follow-up).
// ───────────────────────────────────────────────────────────────────────────
//
// These three walls were pinned by assertions that a foreign partition could
// NOT be named on an instruction, built by the builder, or verified. All three
// now succeed, so the assertions below are the flipped versions:
//
//   W4  `unbox`/`tag.test` carry `tagId: TagId`, not `jsTag: JsTag`. The
//       one-directional brand no longer matters HERE, because the field's own
//       type is the branded one — and the direction TypeScript does block
//       (`JsTag → TagId`) is now the direction a JS producer takes, so it is
//       forced through `JS_TAG_IDS` / `tagIdOfJsTag`.
//   W3  `verifyIrFunction(func, domain?)` takes the domain, defaulting to
//       `defaultTagDomain()`.
//   W5  `IrFunctionBuilder` holds a `TagDomain` (5th ctor arg, same default)
//       and `emitUnbox`/`emitTagTest` take a `TagId`, asking THAT domain for
//       the payload's carrier shape.
//
// W2 and W6 are deliberately untouched: they edit the `IrDynamicLowering`
// contract frozen by #3029-S1. That is why `lower.ts` still refuses an Abacus
// partition — see the W2 block above, which is unchanged and still passes.

/** Build a one-instruction `unbox` function over a `dynamic<Abacus.Nat>` param. */
function unboxAbacus(name: string, tag: TagId, resultType: IrType): IrFunction {
  const instr: IrInstr = {
    kind: "unbox",
    value: asValueId(0),
    tagId: tag,
    result: asValueId(1),
    resultType,
  };
  return {
    ...irIdentities.next(name),
    params: [{ value: asValueId(0), type: irDynamic(tag), name: "n" }],
    resultTypes: [resultType],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [instr],
        terminator: { kind: "return", values: [asValueId(1)] },
      },
    ],
    exported: true,
    valueCount: 2,
  };
}

describe("#3954 phase 3 — W4 (CLOSED): the instruction fields are domain-neutral", () => {
  it("`unbox.tagId` / `tag.test.tagId` take a `TagId`, and a `JsTag` member no longer fits", () => {
    // The field is the BRANDED type now, so the assignment that used to be free
    // in the wrong direction is the one that is blocked. A JS producer must go
    // through `JS_TAG_IDS` (or `tagIdOfJsTag`), which is the point.
    const abacus: IrInstr = {
      kind: "unbox",
      value: asValueId(0),
      tagId: ABACUS_TAGS.Nat,
      result: asValueId(1),
      resultType: irVal({ kind: "externref" }),
    };
    expect(abacus.kind === "unbox" && tagIdValue(abacus.tagId!)).toBe(1003);

    const blocked: IrInstr = {
      kind: "tag.test",
      value: asValueId(0),
      // @ts-expect-error — a JsTag member is not assignable to the branded TagId
      tagId: 5 as JsTag,
      result: asValueId(1),
      resultType: irVal({ kind: "i32" }),
    };
    expect(blocked.kind).toBe("tag.test");
  });

  it("the ONE-DIRECTIONAL brand is still open at the language level — just no longer reachable here", () => {
    // TypeScript assigns a branded `number` straight to a numeric enum, so
    // `TagId → JsTag` remains legal with no cast. Widening the node fields
    // removed the SITES where that mattered; it did not close the hole. What
    // still stands on it is the `IrDynamicLowering` contract (W6), which is
    // `JsTag`-typed member by member — `lower.ts` therefore routes every
    // crossing through `jsTagOf`, whose RUNTIME check is the real guard.
    const smuggled: JsTag = ABACUS_TAGS.Nat; // still no `as`, still no error
    expect(smuggled as number).toBe(1003);

    // @ts-expect-error — and the reverse is still correctly blocked
    const blocked: TagId = 5 as JsTag;
    expect(tagIdValue(blocked)).toBe(5);
  });
});

describe("#3954 phase 3 — W3 (CLOSED): the verifier can be told which domain the IR belongs to", () => {
  it("verifies an Abacus `unbox` when handed the Abacus domain", () => {
    // `Nat`'s carrier is `ref`, so a ref-shaped result is what the domain
    // demands — and the verifier reads that from ABACUS_TAG_DOMAIN, not from
    // ECMAScript.
    const fn = unboxAbacus("unboxNat", ABACUS_TAGS.Nat, irVal({ kind: "externref" }));
    expect(verifyIrFunction(fn, ABACUS_TAG_DOMAIN)).toEqual([]);
  });

  it("applies the Abacus SINGLETON rule (R2) — `Unit`, not Null/Undefined", () => {
    // Abacus has exactly one nullary value; ECMAScript has two. Under the
    // Abacus domain the payload-less rejection names `Unit`, which is a
    // partition ECMAScript cannot express at all.
    const fn = unboxAbacus("unboxUnit", ABACUS_TAGS.Unit, irVal({ kind: "i32" }));
    const errors = verifyIrFunction(fn, ABACUS_TAG_DOMAIN);
    expect(errors.map((e) => e.message).join("\n")).toMatch(/payload-less partition Unit/);
  });

  it("applies the Abacus CARRIER rule — `Rune` is an i32 SCALAR, so an f64 `tag` is inconsistent", () => {
    // The carrier answer is the domain's: JS has no character type at all, so
    // there is no ECMAScript partition this rule could be borrowed from.
    const fn: IrFunction = {
      ...unboxAbacus("unboxRune", ABACUS_TAGS.Rune, irVal({ kind: "i32" })),
    };
    const withBadTag: IrFunction = {
      ...fn,
      blocks: fn.blocks.map((b) => ({
        ...b,
        instrs: b.instrs.map((i) => (i.kind === "unbox" ? { ...i, tag: { kind: "f64" as const } } : i)),
      })),
    };
    expect(verifyIrFunction(fn, ABACUS_TAG_DOMAIN)).toEqual([]);
    expect(
      verifyIrFunction(withBadTag, ABACUS_TAG_DOMAIN)
        .map((e) => e.message)
        .join("\n"),
    ).toMatch(/inconsistent with partition Rune \(payload kind i32\)/);
  });

  it("the DEFAULT domain still answers from ECMAScript — a foreign tag is a producer bug", () => {
    // Omitting the argument is unchanged behaviour, and handing an Abacus
    // partition to a JS-domain verifier is still a loud failure. That is
    // correct: it is a domain MISMATCH, not a missing channel.
    const fn = unboxAbacus("unboxNatDefault", ABACUS_TAGS.Nat, irVal({ kind: "externref" }));
    expect(() => verifyIrFunction(fn)).toThrow(/tag id 1003 is not an ECMAScript partition/);
  });

  it("the verifier accepts the SAME shape when the tag is an ECMAScript one", () => {
    // Control, so the failure above is attributable to the domain and not to a
    // malformed fixture. `JS_TAG_IDS.String` is 5; its carrier is ref-shaped,
    // which is what the `externref` result declares.
    const fn: IrFunction = {
      ...irIdentities.next("unboxString"),
      params: [{ value: asValueId(0), type: irDynamic(), name: "n" }],
      resultTypes: [irVal({ kind: "externref" })],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "unbox",
              value: asValueId(0),
              tagId: JS_TAG_IDS.String,
              result: asValueId(1),
              resultType: irVal({ kind: "externref" }),
            },
          ],
          terminator: { kind: "return", values: [asValueId(1)] },
        },
      ],
      exported: true,
      valueCount: 2,
    };
    expect(verifyIrFunction(fn)).toEqual([]);
  });
});

describe("#3954 phase 3 — W5 (CLOSED): the builder constructs foreign-domain instructions", () => {
  function abacusBuilder(name: string, results: readonly IrType[]): IrFunctionBuilder {
    // 5th ctor arg (#3954 W5) — the domain. 4th stays `undefined`: no
    // allocation-site registry, as for every other test builder.
    return new IrFunctionBuilder(irIdentities.next(name), results, true, undefined, ABACUS_TAG_DOMAIN);
  }

  it("`emitUnbox` derives the result ValType from the ABACUS carrier, not from ECMAScript", () => {
    // `Rune` → i32. Nothing in ECMAScript maps a character to an i32 scalar
    // (a JS "character" is a 1-length String, ref-shaped), so this answer could
    // not have come from the JS domain.
    const rune = abacusBuilder("abacusUnboxRune", [irVal({ kind: "i32" })]);
    const rp = rune.addParam("c", irDynamic(ABACUS_TAGS.Rune));
    rune.openBlock();
    const scalar = rune.emitUnbox(rp, ABACUS_TAGS.Rune);
    expect(rune.typeOf(scalar)).toEqual(irVal({ kind: "i32" }));
    rune.terminate({ kind: "return", values: [scalar] });
    expect(verifyIrFunction(rune.finish(), ABACUS_TAG_DOMAIN)).toEqual([]);

    // `Nat` → ref (declared as `externref` by the plumbing).
    const nat = abacusBuilder("abacusUnboxNat", [irVal({ kind: "externref" })]);
    const np = nat.addParam("n", irDynamic(ABACUS_TAGS.Nat));
    nat.openBlock();
    const payload = nat.emitUnbox(np, ABACUS_TAGS.Nat);
    expect(nat.typeOf(payload)).toEqual(irVal({ kind: "externref" }));
    nat.terminate({ kind: "return", values: [payload] });
    expect(verifyIrFunction(nat.finish(), ABACUS_TAG_DOMAIN)).toEqual([]);
  });

  it("`emitUnbox` rejects the ABACUS singleton by its own name", () => {
    const b = abacusBuilder("abacusUnboxUnit", [irVal({ kind: "i32" })]);
    const p = b.addParam("u", irDynamic(ABACUS_TAGS.Unit));
    b.openBlock();
    expect(() => b.emitUnbox(p, ABACUS_TAGS.Unit)).toThrow(/payload-less partition Unit/);
  });

  it("`emitTagTest` builds a `tag.test` carrying a foreign partition", () => {
    const b = abacusBuilder("abacusTagTest", [irVal({ kind: "i32" })]);
    const p = b.addParam("c", irDynamic(ABACUS_TAGS.Cap));
    b.openBlock();
    const flag = b.emitTagTest(p, ABACUS_TAGS.Cap);
    b.terminate({ kind: "return", values: [flag] });
    const fn = b.finish();
    const instr = fn.blocks[0].instrs[0];
    expect(instr.kind === "tag.test" && tagIdValue(instr.tagId!)).toBe(1006);
    expect(verifyIrFunction(fn, ABACUS_TAG_DOMAIN)).toEqual([]);
  });

  it("a builder with NO domain argument still answers from ECMAScript", () => {
    // The default is `defaultTagDomain()`, so every existing caller is
    // unchanged — and an Abacus partition handed to a default builder fails
    // loudly rather than being reinterpreted.
    const b = new IrFunctionBuilder(irIdentities.next("defaultDomain"), [irVal({ kind: "f64" })], true);
    const p = b.addParam("x", irDynamic());
    b.openBlock();
    expect(b.typeOf(b.emitUnbox(p, JS_TAG_IDS.NumberF64))).toEqual(irVal({ kind: "f64" }));
    expect(() => b.emitUnbox(p, ABACUS_TAGS.Nat)).toThrow(/tag id 1003 is not an ECMAScript partition/);
  });
});
