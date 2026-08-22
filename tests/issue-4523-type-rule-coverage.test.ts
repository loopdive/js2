// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4523 — per-instruction type-rule coverage is a POLICY, not a hole.
//
// `checkInstr` in `src/ir/verify.ts` implements type rules for a subset of the
// `IrInstr` union by construction. #4523 decided option (c), a hybrid:
//
//   1. `TYPE_RULE_STATUS` is a `Record` over the whole kind union, so a NEW
//      IR kind cannot be added without classifying it (compile-time gate).
//   2. `checkInstr`'s `default:` arm consults the map, so DELETING an existing
//      rule fails loudly at verify time (this file proves that path fires).
//   3. The `rule-worth-adding:` bucket is the roadmap denominator.
//
// This file is the runtime half: the compile-time gate lives in the `Record`
// type itself, which a type-stripping test runner would not enforce.

import { describe, expect, it } from "vitest";
import {
  asBlockId,
  asValueId,
  TYPE_RULE_CATEGORIES,
  TYPE_RULE_STATUS,
  typeRuleCategoryOf,
  typeRuleCoverageProblem,
  verifyIrFunction,
  type IrFunction,
  type IrValueId,
  type TypeRuleCategory,
  type TypeRuleStatus,
} from "../src/ir/index.js";

/** Local alias so the roadmap loop can index the map with a plain string. */
type TypeRuleStatusLike = TypeRuleStatus;
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("issue-4523-type-rule-coverage");

/**
 * The `IrInstr` kind union as of #4523, pinned at runtime.
 *
 * Adding an IR kind SHOULD fail this list. That is the point: the `Record`
 * type forces you to classify the kind in `TYPE_RULE_STATUS`, and this list
 * forces the same decision to be visible in the coverage ratchet.
 */
const EXPECTED_KINDS: readonly string[] = [
  "async.return",
  "async.throw",
  "await",
  "binary",
  "box",
  "br.label",
  "call",
  "class.call",
  "class.get",
  "class.instanceof",
  "class.new",
  "class.set",
  "class.static_call",
  "class.super_call",
  "class.super_init",
  "closure.call",
  "closure.cap",
  "closure.new",
  "coerce.to_externref",
  "const",
  "dyn.eq",
  "dyn.member_get",
  "dyn.member_set",
  "dyn.to_number",
  "dyn.truthy",
  "early.return",
  "extern.call",
  "extern.new",
  "extern.prop",
  "extern.propSet",
  "extern.regex",
  "for.loop",
  "forof.iter",
  "forof.string",
  "forof.vec",
  "gen.epilogue",
  "gen.push",
  "gen.setReturn",
  "gen.yieldStar",
  "global.get",
  "global.set",
  "if",
  "if.stmt",
  "intrinsic",
  "iter.done",
  "iter.new",
  "iter.next",
  "iter.return",
  "iter.value",
  "labeled.block",
  "object.get",
  "object.new",
  "object.set",
  "raw.wasm",
  "refcell.get",
  "refcell.new",
  "refcell.set",
  "select",
  "slot.read",
  "slot.write",
  "string.char_at",
  "string.char_code_at",
  "string.concat",
  "string.const",
  "string.eq",
  "string.len",
  "switch",
  "tag.test",
  "throw",
  "try",
  "unary",
  "unbox",
  "vec.get",
  "vec.len",
  "vec.new_fixed",
  "vec.set",
  "vec.set_length",
  "while.loop",
];

/**
 * Ratchet floor for the checked-kind count.
 *
 * 16 when #4523 landed; #4603 implemented a real rule for 16 of the 17
 * `rule-worth-adding` kinds, so the floor moves to 32. The 17th
 * (`early.return`) was a misclassification — `verifyIrFunction` has applied
 * its rule since #2856 — and is now `checked-elsewhere`, not a checked arm.
 */
const BASELINE_CHECKED_COUNT = 32;

/** Per-category triage counts (#4523 triage, as retired by #4603). */
const BASELINE_CATEGORY_COUNTS: Readonly<Record<TypeRuleCategory, number>> = {
  structural: 5,
  // 12 + `early.return` (#4603 reclassification).
  "checked-elsewhere": 13,
  "resolver-typed": 23,
  "dynamic-by-design": 5,
  // #4603 emptied the roadmap. This is a FLOOR of zero, not a target to
  // refill: a new kind that genuinely needs a rule may re-enter the bucket,
  // and the parity/ratchet tests above still hold in that case.
  "rule-worth-adding": 0,
};

/**
 * The 17 kinds #4523 put on the roadmap. #4603 closed all of them: 16 with a
 * `checkInstr` arm, `early.return` by recognising the rule already existed.
 * Pinned so a later PR cannot quietly re-open one by flipping it back to a
 * skip without saying so here.
 */
const ROADMAP_KINDS_4523: readonly string[] = [
  "const",
  "call",
  "global.get",
  "global.set",
  "select",
  "if",
  "object.new",
  "closure.new",
  "class.new",
  "class.super_init",
  "class.instanceof",
  "coerce.to_externref",
  "iter.done",
  "forof.vec",
  "forof.iter",
  "forof.string",
  "early.return",
];

const checkedKinds = Object.keys(TYPE_RULE_STATUS).filter((k) => TYPE_RULE_STATUS[k as never] === "checked");

/** A minimal valid one-block function whose only instr is a `const` (skipped kind). */
function constFunc(name: string): IrFunction {
  return {
    ...irIdentities.next(name),
    params: [],
    resultTypes: [],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            kind: "const",
            value: { kind: "i32", value: 1 },
            result: asValueId(0),
            resultType: { kind: "val", val: { kind: "i32" } },
          },
        ],
        terminator: { kind: "return", values: [] as IrValueId[] },
      },
    ],
    exported: false,
    valueCount: 1,
  };
}

/**
 * A minimal valid void function whose only instr is a bare `early.return` —
 * a kind that still legitimately reaches `checkInstr`'s `default:` after
 * #4603, so it can play the desync probe `const` used to play.
 */
function earlyReturnFunc(name: string): IrFunction {
  return {
    ...irIdentities.next(name),
    params: [],
    resultTypes: [],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [{ kind: "early.return", value: null, result: null, resultType: null }],
        terminator: { kind: "return", values: [] as IrValueId[] },
      },
    ],
    exported: false,
    valueCount: 0,
  };
}

describe("#4523 TYPE_RULE_STATUS / checkInstr parity", () => {
  it("the map covers exactly the IrInstr kind union (runtime pin of the compile-time Record)", () => {
    expect(Object.keys(TYPE_RULE_STATUS).sort()).toEqual([...EXPECTED_KINDS].sort());
  });

  it("the union has 78 kinds", () => {
    expect(Object.keys(TYPE_RULE_STATUS)).toHaveLength(78);
  });

  it("ratchet: the checked-kind count never decreases", () => {
    expect(checkedKinds.length).toBeGreaterThanOrEqual(BASELINE_CHECKED_COUNT);
  });

  it("every non-checked kind carries a categorised, non-empty skip reason", () => {
    for (const [kind, status] of Object.entries(TYPE_RULE_STATUS)) {
      if (status === "checked") continue;
      expect(status.skip, `${kind} skip reason`).toBeTruthy();
      expect(
        typeRuleCategoryOf(status),
        `${kind} skip reason must start with one of ${TYPE_RULE_CATEGORIES.join("|")}, got: ${status.skip}`,
      ).not.toBeNull();
      // The category prefix alone is not a reason — require prose after it.
      expect(status.skip.slice(status.skip.indexOf(":") + 1).trim().length, `${kind} reason prose`).toBeGreaterThan(10);
    }
  });

  it("the triage totals match the counts recorded in the issue file", () => {
    // Seed every category at 0 — #4603 emptied `rule-worth-adding`, and an
    // absent key must read as "zero kinds", not as "category retired".
    const counts: Record<string, number> = Object.fromEntries(TYPE_RULE_CATEGORIES.map((c) => [c, 0]));
    for (const status of Object.values(TYPE_RULE_STATUS)) {
      const category = typeRuleCategoryOf(status);
      if (category !== null) counts[category] = (counts[category] ?? 0) + 1;
    }
    expect(counts).toEqual(BASELINE_CATEGORY_COUNTS);
    const skipped = Object.values(BASELINE_CATEGORY_COUNTS).reduce((a, b) => a + b, 0);
    expect(checkedKinds.length + skipped).toBe(78);
  });

  it("the roadmap denominator (rule-worth-adding) matches the recorded count", () => {
    const roadmap = Object.entries(TYPE_RULE_STATUS)
      .filter(([, s]) => typeRuleCategoryOf(s) === "rule-worth-adding")
      .map(([k]) => k);
    expect(roadmap.length).toBe(BASELINE_CATEGORY_COUNTS["rule-worth-adding"]);
  });

  it("#4603 — every kind on #4523's roadmap is closed (checked, or checked-elsewhere)", () => {
    for (const kind of ROADMAP_KINDS_4523) {
      const status = TYPE_RULE_STATUS[kind as never] as TypeRuleStatusLike;
      const category = status === "checked" ? "checked" : typeRuleCategoryOf(status);
      expect(category, `${kind} must not sit in rule-worth-adding any more`).not.toBe("rule-worth-adding");
    }
    // 16 of the 17 got a real `checkInstr` arm; `early.return`'s rule already
    // lived in `verifyIrFunction` (arity + returnTypeAssignable, #1798/#2856),
    // where it also carries the `demote` flag a `checkInstr` arm would lose.
    const checkedFromRoadmap = ROADMAP_KINDS_4523.filter((k) => TYPE_RULE_STATUS[k as never] === "checked");
    expect(checkedFromRoadmap).toHaveLength(16);
    expect(ROADMAP_KINDS_4523.filter((k) => TYPE_RULE_STATUS[k as never] !== "checked")).toEqual(["early.return"]);
  });
});

describe("#4523 desync detection (AC 2 — removing a rule must fail loudly)", () => {
  it("a kind marked checked that reaches default: is reported as a missing rule", () => {
    // This is exactly what `checkInstr`'s default: arm computes when a `case`
    // arm is deleted — the #4070-method proof, executed as a unit.
    const message = typeRuleCoverageProblem("vec.len", "checked");
    expect(message).not.toBeNull();
    expect(message).toContain("vec.len");
    expect(message).toContain("TYPE_RULE_STATUS says checked");
  });

  it("a kind carrying a skip reason legitimately reaches default: (no error)", () => {
    // `if` was in this list until #4603 gave it a rule; `early.return` replaces
    // it as the sample of a kind whose rule lives outside `checkInstr`.
    for (const kind of ["early.return", "try", "throw", "await", "extern.call"] as const) {
      expect(typeRuleCoverageProblem(kind, TYPE_RULE_STATUS[kind]), kind).toBeNull();
    }
  });

  it("a kind absent from the map is reported as a map/union desync", () => {
    const message = typeRuleCoverageProblem("not.a.real.kind" as never, undefined);
    expect(message).not.toBeNull();
    expect(message).toContain("out of sync with the IrInstr union");
  });

  it("end-to-end: the default: arm is wired — a checked-but-unhandled kind errors through verifyIrFunction", () => {
    // The #4070-method proof, as a test rather than a scratch build. Deleting
    // a `case` arm and flipping a kind's status to "checked" are the SAME
    // desync from `default:`'s point of view — both leave a kind the map calls
    // checked with no arm handling it. `const` carried a skip reason until
    // #4603 gave it a real arm, so the probe kind moved to `early.return` —
    // still a `{ skip }` entry (its rule lives in `verifyIrFunction`), so
    // flipping it reproduces the condition without touching production
    // wiring; the entry is restored in `finally`.
    const saved = TYPE_RULE_STATUS["early.return"];
    try {
      TYPE_RULE_STATUS["early.return"] = "checked";
      const messages = verifyIrFunction(earlyReturnFunc("desyncEarlyReturn")).map((e) => e.message);
      expect(messages.some((m) => m.includes("type-rule missing for 'early.return'"))).toBe(true);
      expect(messages.some((m) => m.includes("TYPE_RULE_STATUS says checked"))).toBe(true);
    } finally {
      TYPE_RULE_STATUS["early.return"] = saved;
    }
    // ...and the same function is clean again once the map is consistent.
    expect(verifyIrFunction(constFunc("restoredConst")).map((e) => e.message)).toEqual([]);
  });

  it("an unknown kind is caught even earlier by the #4070 collectUses guard", () => {
    // Documents the ordering: `collectUses` throws before the type-rule pass
    // runs, so `typeRuleCoverageProblem`'s `undefined` branch is a defensive
    // backstop for a map/union desync, not the first line of defence.
    const func: IrFunction = {
      ...irIdentities.next("unmappedKind"),
      params: [],
      resultTypes: [],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "not.a.real.kind", result: null, resultType: null } as never],
          terminator: { kind: "return", values: [] as IrValueId[] },
        },
      ],
      exported: false,
      valueCount: 0,
    };
    expect(() => verifyIrFunction(func)).toThrow(/no case for IR instruction kind not\.a\.real\.kind/);
  });

  it("a valid function produces no coverage errors (no behaviour change for valid IR)", () => {
    expect(verifyIrFunction(constFunc("validNoop")).map((e) => e.message)).toEqual([]);
  });
});
