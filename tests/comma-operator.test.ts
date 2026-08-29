// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Comma operator — runtime semantics, pinned against BOTH pipelines.
//
// This file predates #5164 (the IR adoption of the comma operator). It used to
// hand-roll its own WebAssembly import object with nothing but the three
// `console_log_*` host functions. That stopped being a complete import surface
// on 2026-08-08, when constant boxing moved to module globals (#4157/#4219) and
// every module — even one with no user string literals — began importing the
// `string_constants` pool that carries its export names. From that day all five
// rows failed identically at INSTANTIATION with
//
//     Import #0 module="string_constants": module is not an object or function
//
// while the compiled answers were correct the whole time. No CI gate runs this
// file (it is not in `tests/guard-suite.json` and does not match the `issue-*`
// changed-root selector), so it sat red in silence — the rotted-untouched-row
// class tracked by #5172.
//
// The fix is to build the import object the way every current test does, via
// `buildImports` from the runtime. Since the shapes below are now partly
// IR-owned, each row additionally asserts THREE-WAY agreement — legacy
// (`experimentalIR: false`), IR, and the JavaScript reference value — plus which
// pipeline actually owns it. Ownership is read from `trackIrOutcomes`
// (`kind: "emitted"`), never from a bare selector claim: a claim that never
// reaches a body is a vacuous pass.
//
// The ownership split is the #4459 discard-purity line that #5164 inherited: a
// comma whose operands are pure is IR-emitted, and one whose LEFT operand
// MUTATES (`x = (x = 5, x + 10)`) stays legacy-owned, rejected pre-claim as
// `body-shape-rejected`.

import { describe, expect, it } from "vitest";

import { compile, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

interface RunResult {
  readonly exports: Record<string, (...args: unknown[]) => unknown>;
  readonly emitted: ReadonlySet<string>;
  readonly outcomes: readonly IrObservedOutcome[];
  readonly postClaim: readonly { kind: string; func: string; message: string }[];
}

async function compileAndRun(source: string, experimentalIR: boolean): Promise<RunResult> {
  const result = await compile(source, {
    fileName: "test.ts",
    experimentalIR,
    trackIrOutcomes: true,
  });
  expect(
    result.success,
    `Compile failed (${experimentalIR ? "IR" : "legacy"}):\n${result.errors
      .map((e) => `L${e.line}: ${e.message}`)
      .join("\n")}`,
  ).toBe(true);

  const built = buildImports(result.imports as never, undefined, result.stringPool) as Record<string, never> & {
    env: Record<string, unknown>;
    setExports?: (exports: unknown) => void;
  };
  built.env.console_log_number = () => {};
  built.env.console_log_string = () => {};
  built.env.console_log_bool = () => {};

  const { instance } = await WebAssembly.instantiate(result.binary, built as never);
  built.setExports?.(instance.exports);

  return {
    exports: instance.exports as Record<string, (...args: unknown[]) => unknown>,
    emitted: new Set(
      (result.irOutcomes ?? []).filter((outcome) => outcome.kind === "emitted").map((outcome) => outcome.displayName),
    ),
    outcomes: result.irOutcomes ?? [],
    postClaim: result.irPostClaimErrors ?? [],
  };
}

/** The terminal outcome code the selector recorded for `fn`. */
function outcomeCode(outcomes: readonly IrObservedOutcome[], fn: string): string | undefined {
  const outcome = outcomes.find((entry) => entry.displayName === fn);
  return (outcome as { code?: string } | undefined)?.code;
}

/**
 * Assert legacy ≡ IR ≡ the JavaScript reference for `test()`, and pin which
 * pipeline owns the body. `owner: "ir"` requires a genuine emission;
 * `owner: "legacy"` requires a PRE-claim rejection, not a claim-then-demote.
 */
async function expectParity(source: string, expected: number, owner: "ir" | "legacy"): Promise<void> {
  const legacy = await compileAndRun(source, false);
  const ir = await compileAndRun(source, true);

  expect(legacy.exports.test!(), "legacy value matches the JavaScript reference").toBe(expected);
  expect(ir.exports.test!(), "IR value matches legacy + JavaScript").toBe(expected);

  expect(ir.postClaim, "no post-claim demotions").toStrictEqual([]);
  if (owner === "ir") {
    expect(ir.emitted.has("test"), "genuinely IR-emitted (a claim alone is not evidence)").toBe(true);
  } else {
    expect(ir.emitted.has("test"), "stays legacy-owned").toBe(false);
    expect(outcomeCode(ir.outcomes, "test"), "rejected pre-claim on body shape").toBe("body-shape-rejected");
  }
}

describe("comma operator", () => {
  it("returns the right-hand value", async () => {
    // JavaScript reference: (1, 2) === 2.
    await expectParity(`export function test(): number { return (1, 2); }`, 2, "ir");
  });

  it("evaluates left side for side effects", async () => {
    // JavaScript reference: x = ((x = 5), x + 10) ⇒ 15. The left operand
    // MUTATES, so #4459's purity line keeps this legacy-owned.
    await expectParity(
      `
      export function test(): number {
        let x: number = 0;
        x = (x = 5, x + 10);
        return x;
      }
    `,
      15,
      "legacy",
    );
  });

  it("chains multiple comma operators", async () => {
    // JavaScript reference: (1, 2, 3) === 3.
    await expectParity(`export function test(): number { return (1, 2, 3); }`, 3, "ir");
  });

  it("works inside a for-loop update expression", async () => {
    // JavaScript reference: a increments 5 times (0..4), b increments 5 times
    // by 2 ⇒ 5 + 10 = 15. The mutating `a = a + 1` IS admissible here: #5164 S2
    // re-enters the update-clause rules for each side of a for-incrementor
    // comma, where that idiom is exactly what the clause is for.
    await expectParity(
      `
      export function test(): number {
        let a: number = 0;
        let b: number = 0;
        for (let i: number = 0; i < 5; i = i + 1, a = a + 1) {
          b = b + 2;
        }
        return a + b;
      }
    `,
      15,
      "ir",
    );
  });

  it("works with different types on left and right", async () => {
    // JavaScript reference: ((x = 10), x + 1) ⇒ 11. Mutating left operand ⇒
    // legacy-owned, same boundary as the side-effects row above.
    await expectParity(
      `
      export function test(): number {
        let x: number = 42;
        return (x = 10, x + 1);
      }
    `,
      11,
      "legacy",
    );
  });
});
