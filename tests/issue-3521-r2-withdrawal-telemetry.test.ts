// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3521 R2-T1 — every compile-twice row names WHY it was never prepared.
//
// A `(prepareAttempts, directBodyEmissions, irBodyEmissions) === (1, 1, 1)`
// function row is the compile-twice shape R2 exists to retire. Until this
// slice the ledger recorded THAT it happened and never WHY, so the R2 census
// had to be re-derived by hand-instrumenting the selector each time. The
// reason is now a closed vocabulary carried on the row itself, recorded by the
// admission chain, the ownership fixed point, the unsealed-component deferral
// and the three routes where the selector never ran at all.
//
// The suite pins four things a later change could silently undo:
//   (a) the vocabulary is closed, minted in exactly one place per reason, and
//       malformed evidence fails `check:ir-only` under BOTH policies;
//   (b) one measured shape per reachable reason — in the sibling files
//       `tests/issue-3521-r2-withdrawal-shapes.test.ts` and
//       `…-multi-source.test.ts`. The suite is split across four files ONLY for
//       memory: a vitest fork gets 512 MB (`vitest.config.ts:5`), a single
//       `compile` costs ~20 MB of retained `ts.Program` and `compileFiles`
//       ~90 MB, so one file carrying every compile OOMs while each case passes
//       alone (measured 2026-09-02);
//   (c) neutrality — no other row shape carries the field, and the field does
//       not move a single compiled byte — in
//       `tests/issue-3521-r2-withdrawal-neutrality.test.ts`, split out for the
//       same 512 MB reason;
//   (d) source pins for the recorder itself, including the reasons no shape
//       reaches today (measured, see the checkpoint note) — an unreached
//       recorder must not be quietly deleted to make a count fit;
//   (e) the CI selector actually admits `tests/ir` and pins the six suites.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { IrObservedOutcome } from "../src/index.js";
import { IR_R2_WITHDRAWAL_REASONS, r2WithdrawalDefect } from "../src/ir/r2-withdrawal.js";

import {
  baselineFrom,
  evaluateIrOnlyReport,
  type IrOnlyBaseline,
  type IrOnlyEntryObservation,
  type IrOnlyLaneObservation,
} from "../scripts/check-ir-only.js";

const SELECTOR_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/codegen/ir-prepared-free-functions.ts", import.meta.url)),
  "utf8",
);
const CODEGEN_INDEX_SOURCE = readFileSync(fileURLToPath(new URL("../src/codegen/index.ts", import.meta.url)), "utf8");
const SELECT_TESTS_SOURCE = readFileSync(
  fileURLToPath(new URL("../scripts/select-changed-issue-tests.mjs", import.meta.url)),
  "utf8",
);

// ── (a) contract ────────────────────────────────────────────────────────────

/** A hand-built row, in the shape `check-ir-only` receives from the ledger. */
function row(overrides: Partial<IrObservedOutcome> & Record<string, unknown> = {}): IrObservedOutcome {
  return {
    key: "fixture.ts::function::f#0",
    file: "fixture.ts",
    unitKind: "function",
    displayName: "f",
    ordinal: 0,
    line: 1,
    column: 1,
    backend: "wasmgc",
    target: "gc",
    prepareAttempts: 1,
    directBodyEmissions: 1,
    irBodyEmissions: 1,
    legacyBodyEmitted: true,
    irBodyEmitted: true,
    kind: "emitted",
    stage: "patch",
    ...overrides,
  } as IrObservedOutcome;
}

const WELL_FORMED = row({ r2Withdrawal: { stage: "admission", reason: "async-declaration" } });

function entryOf(outcomes: readonly IrObservedOutcome[]): IrOnlyEntryObservation {
  return {
    entry: "fixture.ts",
    success: true,
    outcomes,
    hardDiagnostics: [],
    irPostClaimErrors: [],
    irCompiledFuncs: outcomes.filter((o) => o.kind === "emitted").map((o) => o.displayName),
    irFirstSkipped: outcomes.filter((o) => o.unitKind === "function" && !o.legacyBodyEmitted).map((o) => o.displayName),
    failures: [],
  };
}

function laneOf(outcomes: readonly IrObservedOutcome[]): IrOnlyLaneObservation {
  return { name: "single-host", expectedEntries: 1, entries: [entryOf(outcomes)] };
}

function baselineOf(lane: IrOnlyLaneObservation): IrOnlyBaseline {
  return baselineFrom([lane], undefined);
}

describe("#3521 R2 withdrawal telemetry — (a) contract", () => {
  it("is a closed 20-member vocabulary minted exactly once per reason", () => {
    expect(IR_R2_WITHDRAWAL_REASONS).toHaveLength(20);
    expect(new Set(IR_R2_WITHDRAWAL_REASONS).size).toBe(20);
    expect(Object.isFrozen(IR_R2_WITHDRAWAL_REASONS)).toBe(true);

    // Every reason is produced by the recorder and by nothing else: exactly one
    // string literal across the selector and the codegen entry. A second
    // literal would mean a reason minted outside the ordered tables, which is
    // how a bucket stops being ratchetable.
    const recorderSources = `${SELECTOR_SOURCE}\n${CODEGEN_INDEX_SOURCE}`;
    for (const reason of IR_R2_WITHDRAWAL_REASONS) {
      const occurrences = recorderSources.split(`"${reason}"`).length - 1;
      expect(occurrences, `reason ${reason} is minted ${occurrences} times`).toBe(1);
    }
  });

  it("names every malformed shape and accepts the well-formed row", () => {
    expect(r2WithdrawalDefect(WELL_FORMED)).toBeUndefined();

    // (i) a compile-twice function row with no reason at all.
    expect(r2WithdrawalDefect(row())).toBe("compile-twice function row carries no R2 withdrawal reason");

    // (ii) a reason on any other shape — a different triple, no triple, or a
    // non-function unit. Each is checked separately: they reach the guard by
    // different fields and a single fixture would not prove all three.
    const withReason = { r2Withdrawal: { stage: "admission", reason: "async-declaration" } as const };
    expect(r2WithdrawalDefect(row({ directBodyEmissions: 0, irBodyEmissions: 1, ...withReason }))).toMatch(
      /not a compile-twice function/,
    );
    expect(r2WithdrawalDefect(row({ directBodyEmissions: 1, irBodyEmissions: 0, ...withReason }))).toMatch(
      /not a compile-twice function/,
    );
    expect(
      r2WithdrawalDefect(
        row({ prepareAttempts: undefined, directBodyEmissions: undefined, irBodyEmissions: undefined, ...withReason }),
      ),
    ).toMatch(/not a compile-twice function/);
    expect(r2WithdrawalDefect(row({ unitKind: "class-member", ...withReason }))).toMatch(
      /not a compile-twice function/,
    );

    // (iii) a reason beside a sealed prepared component — the row DID prepare.
    expect(r2WithdrawalDefect(row({ preparedComponentId: "prepared-component:x", ...withReason }))).toMatch(
      /beside prepared component/,
    );

    // (iv) an unknown reason, and a free-text detail on a reason that may not
    // carry one. `unsealed-component` is the single exception.
    expect(r2WithdrawalDefect(row({ r2Withdrawal: { stage: "admission", reason: "invented" } }))).toBe(
      "unknown R2 withdrawal reason invented",
    );
    expect(
      r2WithdrawalDefect(row({ r2Withdrawal: { stage: "admission", reason: "async-declaration", detail: "why" } })),
    ).toMatch(/carries a free-text detail/);
    expect(
      r2WithdrawalDefect(
        row({ r2Withdrawal: { stage: "deferred", reason: "unsealed-component", detail: "deferred before sealing" } }),
      ),
    ).toBeUndefined();
  });

  it("fails evaluateIrOnlyReport under BOTH policies, and passes the well-formed twin", () => {
    const malformed: readonly [string, IrObservedOutcome][] = [
      ["missing", row()],
      ["wrong triple", row({ irBodyEmissions: 0, r2Withdrawal: { stage: "admission", reason: "async-declaration" } })],
      [
        "beside a prepared component",
        row({
          preparedComponentId: "prepared-component:x",
          r2Withdrawal: { stage: "admission", reason: "async-declaration" },
        }),
      ],
      ["unknown reason", row({ r2Withdrawal: { stage: "admission", reason: "invented" } })],
    ];
    for (const [label, bad] of malformed) {
      const lane = laneOf([bad]);
      for (const policy of ["hybrid", "ir-only"] as const) {
        const verdict = evaluateIrOnlyReport([lane], baselineOf(lane), policy);
        expect(verdict.ready, `${label} under ${policy}`).toBe(false);
        expect(
          verdict.failures.some((failure) => failure.includes("R2 withdrawal") || failure.includes("compile-twice")),
        ).toBe(true);
      }
    }

    const good = laneOf([WELL_FORMED]);
    for (const policy of ["hybrid", "ir-only"] as const) {
      const verdict = evaluateIrOnlyReport([good], baselineOf(good), policy);
      expect(
        verdict.failures.filter((f) => f.includes("R2 withdrawal") || f.includes("compile-twice")),
        `well-formed under ${policy}`,
      ).toEqual([]);
    }
  });

  it("reports D's exact failure string for a compile-twice row with no reason", () => {
    const lane = laneOf([row()]);
    const verdict = evaluateIrOnlyReport([lane], baselineOf(lane), "hybrid");
    expect(verdict.failures).toContain(
      "single-host/fixture.ts: terminal f: compile-twice function row carries no R2 withdrawal reason",
    );
  });
});

// ── (d) source pins ─────────────────────────────────────────────────────────

/** Index of the first occurrence of `needle`, asserted present. */
function at(source: string, needle: string, label: string): number {
  const index = source.indexOf(needle);
  expect(index, `${label}: ${needle} not found`).toBeGreaterThan(-1);
  return index;
}

describe("#3521 R2 withdrawal telemetry — (d) recorder source pins", () => {
  it("names the ten admission predicates in the chain's own order", () => {
    const order = [
      "fast-signature-unproven",
      "async-declaration",
      "generator-lane",
      "nested-executable-syntax",
      "poison-pill-read",
      "direct-caller-activation-target",
      "function-value-reference",
      "param-signature-unstable",
      "return-signature-unstable",
      "allocated-slot-mismatch",
    ];
    const positions = order.map((reason) => at(SELECTOR_SOURCE, `"${reason}"`, "admission"));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("names the five ownership-crossing edges in the fixed point's own order", () => {
    const order = [
      "callee-of-unowned-caller",
      "callee-outside-component",
      "construction-callee-outside",
      "storage-terminal-unprepared",
      "outside-caller-uncertified",
    ];
    const positions = order.map((reason) => at(SELECTOR_SOURCE, `"${reason}"`, "fixed-point"));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // The class atom is the sixth fixed-point reason and follows the edges.
    expect(at(SELECTOR_SOURCE, '"class-atom"', "fixed-point")).toBeGreaterThan(positions[4]!);
  });

  it("records the deferral inside deferUnsealedPreparedComponents", () => {
    const start = at(SELECTOR_SOURCE, "function deferUnsealedPreparedComponents(", "deferral");
    const end = at(SELECTOR_SOURCE, "function bodyProjection(", "deferral");
    expect(SELECTOR_SOURCE.slice(start, end)).toContain('"unsealed-component"');
  });

  it("sets the multi-source default at the multi overlay entry, before its gate", () => {
    const start = at(CODEGEN_INDEX_SOURCE, "function compileMultiPreparedProgramOverlays(", "multi");
    const body = CODEGEN_INDEX_SOURCE.slice(start, start + 2000);
    const assignment = at(body, 'irR2NotAttemptedReason = "multi-source-driver"', "multi");
    const gate = at(body, "if (!options?.experimentalIR || ctx.fast || !authority) return;", "multi");
    expect(assignment).toBeLessThan(gate);
  });

  it("keeps a recorder for every reason no shape reaches today", () => {
    // Measured 2026-09-02 (checkpoint note P3): these nine have no claimable
    // `(1,1,1)` shape on this base — `generator-lane` and the generator's
    // siblings are refused PRE-claim, and `class-atom` cannot appear until
    // #3522 migrates class-member body accounting. The recorder stays: a
    // vocabulary trimmed to whatever happens to be reachable stops being a
    // ratchet target the moment the reachable set changes.
    const unreached = [
      "generator-lane",
      "nested-executable-syntax",
      "poison-pill-read",
      "direct-caller-activation-target",
      "function-value-reference",
      "allocated-slot-mismatch",
      "callee-of-unowned-caller",
      "class-atom",
      "unsealed-component",
    ];
    for (const reason of unreached) {
      expect(IR_R2_WITHDRAWAL_REASONS).toContain(reason);
      expect(SELECTOR_SOURCE, `${reason} lost its recorder`).toContain(`"${reason}"`);
    }
  });
});

// ── (e) CI selector ─────────────────────────────────────────────────────────

describe("#3521 R2 withdrawal telemetry — (e) tests/ir under CI", () => {
  it("pins the six R2-named tests/ir suites", () => {
    const pinned = execFileSync("node", ["scripts/select-changed-issue-tests.mjs", "--pinned"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    for (const file of [
      "tests/ir/fnctor-abi.test.ts",
      "tests/ir/fnctor-admission.test.ts",
      "tests/ir/fnctor-argument-projection.test.ts",
      "tests/ir/fnctor-producer.test.ts",
      "tests/ir/inline-small.test.ts",
      "tests/ir/phase3c.test.ts",
    ]) {
      expect(pinned).toContain(file);
    }
  });

  it("admits every tests/ir file to the advisory changed-file selector", () => {
    // `--changed` needs a git base, so the selector's own regex is the pin: the
    // literal must be present in the script, and the identical pattern must
    // accept `tests/ir/*` while still rejecting everything outside the two
    // directories the job is scoped to.
    const literal = String.raw`/^tests\/(issue-[^/]*|ir\/[^/]*)\.test\.ts$/`;
    expect(SELECT_TESTS_SOURCE).toContain(`const ISSUE_TEST = ${literal};`);
    const pattern = /^tests\/(issue-[^/]*|ir\/[^/]*)\.test\.ts$/;
    expect(pattern.test("tests/ir/counted-string-append-provenance.test.ts")).toBe(true);
    expect(pattern.test("tests/ir/fnctor-producer.test.ts")).toBe(true);
    expect(pattern.test("tests/issue-3521-r2-withdrawal-telemetry.test.ts")).toBe(true);
    expect(pattern.test("tests/equivalence/multi-file-compilation.test.ts")).toBe(false);
    expect(pattern.test("tests/ir/nested/deep.test.ts")).toBe(false);
  });
});
