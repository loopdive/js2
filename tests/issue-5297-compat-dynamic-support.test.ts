// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5297 — the compatibility lane's externref dynamic surface is now symbolized,
// so a prepared unit that boxes a number into an `any` module binding reaches
// `emitted` instead of demoting on `implicit-support-reference-unavailable`.
//
// WHY THESE ASSERTIONS ARE THE PROOF, not a proxy for it. Both halves of the
// symbolization are *load-bearing preconditions* of `irBodyEmitted: true`:
//
//   - the CARRIER must resolve through a `support`-kind Program-ABI type ref.
//     `recordSupportTypeReference` (`prepared-component-dependencies.ts`)
//     rejects any other binding kind with
//     "IR dynamic carrier must use a compiler-support Program ABI type ref",
//     and with no ref at all the `dynamic` arm blocks with
//     "IR dynamic carrier resolves backend type/helper support without a
//     symbolic Program ABI ref" — which is exactly what main emits today.
//   - the BOX HELPER must resolve through a symbolic callable ref, or
//     `implicitSupportRequirement` reports
//     "box resolves dynamic carrier/helper support without an explicit
//     symbolic ref".
//
// So `emitted` cannot be reached while either ref is missing or of the wrong
// kind, and the two failure details are asserted absent by name. That is the
// published dependency evidence (the outcome row) rather than an internal.
//
// Measured on `origin/main 42a0adf7d4` (base, before this slice): every
// assertion in the first two tests is RED —
//   gc/compat, standalone/compat: kind=unsupported,
//   code=late-preparation-unsupported, with BOTH details above.
//
// The third test is the over-claiming control: an `any` initialized from a
// STRING boxes through `emitBox`'s externref arm, which calls nothing at all,
// so no callable ref can honestly satisfy the requirement. It must still
// demote — a version of this slice that named a helper for every `box` would
// pass tests 1–2 and fail here.
import { describe, expect, it } from "vitest";

import { compile, type IrObservedOutcome } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

interface Cell {
  readonly name: string;
  readonly target: "gc" | "standalone";
  readonly fast: boolean;
}

const COMPAT: readonly Cell[] = [
  { name: "gc/compat", target: "gc", fast: false },
  { name: "standalone/compat", target: "standalone", fast: false },
];

const FAST: readonly Cell[] = [
  { name: "gc/fast", target: "gc", fast: true },
  { name: "standalone/fast", target: "standalone", fast: true },
];

const ANY_NUMBER = `
let a: any = 1;

export function test(): number {
  return (a as number) + 1;
}
`;

/** `emitBox`'s externref arm emits an identity sequence — no call to name. */
const ANY_STRING = `
let a: any = "x";

export function test(): number {
  return (a as string).length;
}
`;

const DIAG = "JS2WASM_IR_SHAPE_DIAG";

async function compileIn(source: string, cell: Cell) {
  const previous = process.env[DIAG];
  process.env[DIAG] = "1";
  try {
    const result = await compile(source, {
      fileName: "test.ts",
      trackIrOutcomes: true,
      emitWat: true,
      target: cell.target,
      fast: cell.fast,
    });
    if (!result.success) throw new Error(`compile failed (${cell.name}): ${result.errors[0]?.message}`);
    return result;
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, DIAG);
    else process.env[DIAG] = previous;
  }
}

function moduleInit(outcomes: readonly IrObservedOutcome[]): IrObservedOutcome {
  const row = outcomes.find((outcome) => outcome.unitKind === "module-init");
  if (!row) throw new Error(`no <module-init> outcome (have: ${outcomes.map((o) => o.unitKind).join(", ")})`);
  return row;
}

describe("#5297 compatibility-lane dynamic support symbolization", () => {
  for (const cell of COMPAT) {
    describe(cell.name, () => {
      it("emits the <module-init> that boxes a number into an `any` binding", async () => {
        const result = await compileIn(ANY_NUMBER, cell);
        const row = moduleInit(result.irOutcomes ?? []);
        const detail = String((row as { detail?: string }).detail ?? "");
        // Named individually so a REGRESSION reports which ref went missing.
        expect(detail).not.toContain("IR dynamic carrier resolves backend type/helper support");
        expect(detail).not.toContain("box resolves dynamic carrier/helper support");
        expect(row.kind).toBe("emitted");
        expect((row as { irBodyEmitted?: boolean }).irBodyEmitted).toBe(true);
      });

      it("keeps the physical boxing symbol the manifest already governs", async () => {
        // The #3526 F1-S3 contract: symbolizing a seam must not change WHICH
        // symbol answers it. `__box_number` is the same `env` import (gc) /
        // runtime func (standalone) the legacy coercion path calls.
        const result = await compileIn(ANY_NUMBER, cell);
        expect(result.wat).toContain("__box_number");
        // Claim ⇔ lowering parity: an emitted unit must still RUN.
        const built = buildImports(result.imports as never, {}, result.stringPool as never);
        const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
        expect((instance.exports as Record<string, () => unknown>).test?.()).toBe(2);
      });

      it("still demotes a box whose lowering calls nothing — the arm does not over-claim", async () => {
        const result = await compileIn(ANY_STRING, cell);
        const row = moduleInit(result.irOutcomes ?? []);
        expect(row.kind).toBe("unsupported");
        expect(String((row as { detail?: string }).detail ?? "")).toContain(
          "box resolves dynamic carrier/helper support",
        );
      });
    });
  }

  for (const cell of FAST) {
    it(`${cell.name}: keeps the $AnyValue carrier — the host arm did not leak across the lane`, async () => {
      // Byte identity for the fast cells is measured cohort-wide in the PR
      // body (33 files x 4 cells + controls, 0 fast-lane rows moved). What is
      // pinned HERE is the property that would have to break first: the fast
      // lane must keep its typed `$AnyValue` carrier, never the compatibility
      // lane's `externref`.
      const result = await compileIn(ANY_NUMBER, cell);
      const line = result.wat.split("\n").find((candidate) => candidate.includes("(global $__mod_a "));
      expect(line).toBeDefined();
      expect(line).toMatch(/\(mut \(ref null \d+\)\)/);
      expect(moduleInit(result.irOutcomes ?? []).kind).toBe("emitted");
    });
  }
});
