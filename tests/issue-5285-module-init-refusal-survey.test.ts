// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5285 — the module-init storage census must be able to report MORE THAN ONE
// blocker per file.
//
// Why this test exists, stated as the defect it would have caught: every
// instrument that reported this census was fail-fast. `buildModuleBindingsMap`
// (`src/ir/integration.ts`) throws on the first top-level declaration with no
// supported storage, and the `JS2WASM_IR_SHAPE_DIAG` reject-arm recorder in
// `src/ir/select.ts` is first-wins by construction. Read as a survey, either one
// answers "exactly one category" for every file regardless of what the file
// contains — which is how a 13-file dogfood census concluded "no file mixes
// categories" and a best-set-of-size-N slice ranking got built on it.
// `tests/dogfood/corpus/escapes-unicode.js` refutes that in five lines, and
// R4-M1 (the predicted string extension) then failed on precisely that file.
//
// So the assertions below are deliberately about MULTIPLICITY and ORDER, not
// about any single refusal:
//   - a fixture carrying three DIFFERENT unrepresentable declarations reports
//     all three; a first-blocker-only implementation reports one and fails,
//   - refusals come back in SOURCE ORDER, because every historical measurement
//     recorded the first blocker and keeping the order is what lets those
//     numbers be reconciled with these rather than discarded,
//   - representable declarations interleaved with the refused ones are NOT
//     reported, so "reports everything" cannot pass by over-reporting,
//   - the binding name is `d.name.text`, never a source slice — the corpus
//     carries a non-ASCII binding (`const id = café`),
//   - and the survey is INERT: with `JS2WASM_IR_SHAPE_DIAG` unset the emitted
//     binary is byte-identical and no refusal list is attached (criterion 2,
//     the one the whole design is shaped around).
import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { compile, type IrModuleBindingRefusal, type IrObservedOutcome } from "../src/index.js";

type Lane = "gc" | "standalone";

const LANES: readonly Lane[] = ["gc", "standalone"];

const DIAG = "JS2WASM_IR_SHAPE_DIAG";

/** `Reflect.deleteProperty`, not `delete` (biome) and not `= undefined` (that
 *  sets the STRING "undefined", which would leave the survey enabled). */
function unsetDiag(): void {
  Reflect.deleteProperty(process.env, DIAG);
}

async function compileFixture(source: string, lane: Lane, diagnostic: boolean) {
  const previous = process.env[DIAG];
  if (diagnostic) process.env[DIAG] = "1";
  else unsetDiag();
  try {
    return await compile(source, { fileName: "test.ts", trackIrOutcomes: true, target: lane });
  } finally {
    if (previous === undefined) unsetDiag();
    else process.env[DIAG] = previous;
  }
}

function moduleInitRow(outcomes: readonly IrObservedOutcome[]): IrObservedOutcome {
  const row = outcomes.find((outcome) => outcome.unitKind === "module-init");
  if (!row) throw new Error(`no <module-init> outcome (have: ${outcomes.map((o) => o.unitKind).join(", ")})`);
  return row;
}

async function surveyRefusals(source: string, lane: Lane): Promise<readonly IrModuleBindingRefusal[]> {
  const result = await compileFixture(source, lane, true);
  expect(result.success).toBe(true);
  return moduleInitRow(result.irOutcomes ?? []).moduleBindingRefusals ?? [];
}

/**
 * Three DIFFERENT unrepresentable declarations, with two representable ones
 * interleaved. `used` keeps every binding live so nothing is dropped before the
 * module-init population is collected.
 *
 * `n` and `s` are representable today — a number is scalar storage, and a
 * string became one in R4-M1 (#3523) — so they are the over-reporting control.
 */
const MIXED_CATEGORIES = `
const n = 1;
const obj = { b: 2 };
const s = "plain";
const big = 9007199254740993n;
const fn = (x) => x + 1;

export function used(): number {
  return n + s.length + (obj.b as number) + Number(big) + fn(1);
}
`;

/** The `escapes-unicode.js` shape: the refused binding's name is non-ASCII. */
const NON_ASCII_NAME = `
const café = { a: 1 };

export function used(): number {
  return café.a as number;
}
`;

/** A top-level destructuring pattern has no one-to-one legacy global. */
const DESTRUCTURED = `
const [p, q] = [1, 2];
const bad = { b: 2 };

export function used(): number {
  return p + q + (bad.b as number);
}
`;

afterEach(unsetDiag);

describe("#5285 module-init refusal survey", () => {
  for (const lane of LANES) {
    describe(`${lane} lane`, () => {
      it("reports EVERY unrepresentable top-level declaration, not just the first", async () => {
        const refusals = await surveyRefusals(MIXED_CATEGORIES, lane);
        // The load-bearing assertion. A first-blocker-only implementation
        // returns exactly one row here and fails on this line.
        expect(refusals.length).toBeGreaterThanOrEqual(3);
        expect(refusals.map((refusal) => refusal.name)).toEqual(["obj", "big", "fn"]);
      });

      it("keeps source order, so first-blocker measurements stay reconcilable", async () => {
        const refusals = await surveyRefusals(MIXED_CATEGORIES, lane);
        expect(refusals.map((refusal) => refusal.initializerKind)).toEqual([
          "ObjectLiteralExpression",
          "BigIntLiteral",
          "ArrowFunction",
        ]);
        // Every historical row recorded the FIRST blocker; that value must still
        // be readable off the new record.
        expect(refusals[0]?.name).toBe("obj");
      });

      it("carries the per-declaration detail the census needs", async () => {
        const refusals = await surveyRefusals(MIXED_CATEGORIES, lane);
        const byName = new Map(refusals.map((refusal) => [refusal.name, refusal]));
        expect(byName.get("big")?.declaredType).toBe("9007199254740993n");
        expect(byName.get("obj")?.arm).toBe("no-value-kind");
        expect(byName.get("fn")?.arm).toBe("no-value-kind");
      });

      it("does NOT report representable declarations", async () => {
        const refusals = await surveyRefusals(MIXED_CATEGORIES, lane);
        // `n` (number) and `s` (string, R4-M1) both have real module storage.
        // Without this, "reports every refusal" would pass by reporting all.
        expect(refusals.map((refusal) => refusal.name)).not.toContain("n");
        expect(refusals.map((refusal) => refusal.name)).not.toContain("s");
      });

      it("records the declared name, not a source slice", async () => {
        const refusals = await surveyRefusals(NON_ASCII_NAME, lane);
        expect(refusals.map((refusal) => refusal.name)).toEqual(["café"]);
      });

      it("records a top-level destructuring pattern and keeps surveying past it", async () => {
        const refusals = await surveyRefusals(DESTRUCTURED, lane);
        // `buildModuleBindingsMap` THROWS on this declaration, which is exactly
        // why the survey may not reuse it: everything after it would be unseen.
        expect(refusals.map((refusal) => refusal.arm)).toEqual(["destructuring-pattern", "no-value-kind"]);
        expect(refusals[0]?.name).toBe("p,q");
      });

      it("is inert: flag off emits the same bytes and attaches no refusals", async () => {
        const off = await compileFixture(MIXED_CATEGORIES, lane, false);
        const on = await compileFixture(MIXED_CATEGORIES, lane, true);
        expect(off.success && on.success).toBe(true);
        expect(createHash("sha256").update(off.binary).digest("hex")).toBe(
          createHash("sha256").update(on.binary).digest("hex"),
        );
        expect(moduleInitRow(off.irOutcomes ?? []).moduleBindingRefusals).toBeUndefined();
        expect(moduleInitRow(on.irOutcomes ?? []).moduleBindingRefusals).toBeDefined();
      });
    });
  }
});
