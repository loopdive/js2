// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5289 — an `any`/`unknown` top-level binding is a real IR module-binding
// storage kind (`{ kind: "dynamic" }`), resolved per LANE.
//
// The axis this file varies is the one the issue exists to name. `#4208`'s
// blocker comment says "fast mode has a `$AnyValue` dynamic carrier while
// compatibility allocation widens these globals to externref" — and "fast" is
// the `fast` FLAG, not the `target`. Measured 2026-09-03, `(global $__mod_a …)`
// straight out of the emitted WAT:
//
//   gc/compat          (mut externref)
//   gc/fast            (mut (ref null 34))
//   standalone/compat  (mut externref)
//   standalone/fast    (mut (ref null 45))
//
// Both targets agree with each other in each mode, so every test below is
// parameterised over {gc, standalone} x {compat, fast} — four cells, not two.
// A two-cell version of this file (vary `target`, default options) reads both
// samples from the SAME side of the split and concludes the carriers agree.
//
// What these tests protect:
//   - **The carriers are NOT unified.** `externref` and `(ref null $AnyValue)`
//     are two spellings of one source fact, each named by ONE function of ONE
//     flag on BOTH sides of the boundary — `resolveWasmType` allocates the
//     legacy slot, `resolveIrDynamicCarrierType` resolves the IR one, and
//     `resolveModuleBindingGlobal`'s storage-agreement check arbitrates. The
//     anti-unification test below fails if a future change collapses them onto
//     one carrier, mirroring R4-M1's assertion that the two STRING carriers
//     differ.
//   - **Claim ⇔ lowering parity.** Tests compile, instantiate, RUN and compare
//     against the same program evaluated in JS. A claim whose lowering is
//     wrong fails here, not as a Program ABI invariant in a later build.
//   - **The boundary is deliberate.** A module `var` is excluded — it is the
//     one form whose legacy slot the widening arms retype to `externref`,
//     which in FAST mode is NOT the dynamic carrier, and that disagreement is
//     only reportable as a hard invariant, never as a demote.
//   - **`unknown` tracks `any`.** The predicate mirrors `resolveWasmType`'s own
//     `Any | Unknown` branch, so the two forms are asserted against each other
//     rather than against a constant.
import { describe, expect, it } from "vitest";

import { compile, type IrModuleBindingRefusal, type IrObservedOutcome } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

interface Cell {
  readonly name: string;
  readonly target: "gc" | "standalone";
  readonly fast: boolean;
}

const CELLS: readonly Cell[] = [
  { name: "gc/compat", target: "gc", fast: false },
  { name: "gc/fast", target: "gc", fast: true },
  { name: "standalone/compat", target: "standalone", fast: false },
  { name: "standalone/fast", target: "standalone", fast: true },
];

const DIAG = "JS2WASM_IR_SHAPE_DIAG";

interface Run {
  readonly outcomes: readonly IrObservedOutcome[];
  readonly wat: string;
  readonly binary: Uint8Array;
  readonly imports: unknown;
  readonly stringPool: unknown;
}

async function compileIn(source: string, cell: Cell): Promise<Run> {
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
    return {
      outcomes: result.irOutcomes ?? [],
      wat: result.wat,
      binary: result.binary,
      imports: result.imports,
      stringPool: result.stringPool,
    };
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, DIAG);
    else process.env[DIAG] = previous;
  }
}

/** Instantiate through the production import builder and call `test()`. */
async function runExport(run: Run): Promise<unknown> {
  const built = buildImports(run.imports as never, {}, run.stringPool as never);
  const { instance } = await instantiateWasm(run.binary, built.env, built.string_constants);
  return (instance.exports as Record<string, () => unknown>).test?.();
}

function moduleInit(outcomes: readonly IrObservedOutcome[]): IrObservedOutcome {
  const found = outcomes.find((outcome) => outcome.unitKind === "module-init");
  if (!found) throw new Error(`no <module-init> outcome (have: ${outcomes.map((o) => o.unitKind).join(", ")})`);
  return found;
}

function refusals(outcomes: readonly IrObservedOutcome[]): readonly IrModuleBindingRefusal[] {
  return (
    (moduleInit(outcomes) as { moduleBindingRefusals?: readonly IrModuleBindingRefusal[] }).moduleBindingRefusals ?? []
  );
}

/** The `(global $__mod_<name> …)` line, so the CARRIER is asserted, not inferred. */
function moduleGlobalLine(wat: string, name: string): string {
  const line = wat.split("\n").find((candidate) => candidate.includes(`(global $__mod_${name} `));
  if (!line) throw new Error(`no __mod_${name} global in emitted module`);
  return line.trim();
}

const ANY_NUMBER = `
let a: any = 1;

export function test(): number {
  return (a as number) + 1;
}
`;

const UNKNOWN_NUMBER = `
let a: unknown = 1;

export function test(): number {
  return (a as number) + 1;
}
`;

const ANY_CONST = `
const a: any = 1;

export function test(): number {
  return (a as number) + 1;
}
`;

const ANY_REASSIGNED = `
let a: any = 1;
a = 41;

export function test(): number {
  return (a as number) + 1;
}
`;

/** The control: the same program with no `any` binding at all. */
const NO_ANY = `
let a = 1;

export function test(): number {
  return a + 1;
}
`;

describe("#5289 any/unknown module-binding storage", () => {
  for (const cell of CELLS) {
    describe(cell.name, () => {
      it("admits an `any` binding — no storage refusal is reported for it", async () => {
        // The load-bearing assertion, and the one that is RED before this
        // slice: on the base tree `a` is reported `no-value-kind`, which
        // rejects the whole <module-init> unit before any shape question.
        const run = await compileIn(ANY_NUMBER, cell);
        expect(refusals(run.outcomes).map((refusal) => refusal.name)).not.toContain("a");
      });

      it("admits `unknown` on the same terms as `any`", async () => {
        // `resolveWasmType`'s deciding branch is `Any | Unknown`; the storage
        // predicate mirrors it, so the two forms are asserted against each
        // other rather than against a constant that could go stale alone.
        const anyRun = await compileIn(ANY_NUMBER, cell);
        const unknownRun = await compileIn(UNKNOWN_NUMBER, cell);
        expect(refusals(unknownRun.outcomes).map((r) => r.name)).toEqual(refusals(anyRun.outcomes).map((r) => r.name));
        expect(moduleInit(unknownRun.outcomes).kind).toBe(moduleInit(anyRun.outcomes).kind);
      });

      it("admits `const` on the same terms as `let`", async () => {
        const letRun = await compileIn(ANY_NUMBER, cell);
        const constRun = await compileIn(ANY_CONST, cell);
        expect(refusals(constRun.outcomes).map((r) => r.name)).toEqual(refusals(letRun.outcomes).map((r) => r.name));
      });

      it("runs the program and matches JS — an admitted slot implies a real lowering", async () => {
        // Claim ⇔ lowering parity. The value is checked in EVERY cell, so a
        // carrier that is resolved but boxed/unboxed wrongly fails here.
        expect(await runExport(await compileIn(ANY_NUMBER, cell))).toBe(2);
        expect(await runExport(await compileIn(ANY_CONST, cell))).toBe(2);
        expect(await runExport(await compileIn(ANY_REASSIGNED, cell))).toBe(42);
        expect(await runExport(await compileIn(UNKNOWN_NUMBER, cell))).toBe(2);
      });

      it("excludes a module `var` — the one form whose legacy slot the widening arms retype", async () => {
        // Not a storage refusal to assert (a module `var` never reaches the
        // refusal recorder); what is asserted is that admitting `any` did NOT
        // change the `var` form's outcome, so the exclusion is real.
        const run = await compileIn(
          `
var a: any = 1;

export function test(): number {
  return (a as number) + 1;
}
`,
          cell,
        );
        expect(moduleInit(run.outcomes).kind).toBe("unsupported");
        // The exclusion is a demote, not a break: legacy still compiles it.
        expect(await runExport(run)).toBe(2);
      });

      it("is no worse than the same program without the `any` binding", async () => {
        // A DIFFERENTIAL, not a fixed expectation: pinning "<module-init> is
        // emitted" would go stale the day some other arm of this program stops
        // being representable, and would FAIL on the improvement where the
        // compatibility lane's residual blocker is retired. Pinning "the `any`
        // shape is not the worse of the two" stays true either way.
        const withAny = await compileIn(ANY_NUMBER, cell);
        const control = await compileIn(NO_ANY, cell);
        expect(await runExport(withAny)).toBe(await runExport(control));
        if (moduleInit(control.outcomes).kind === "emitted") {
          expect(refusals(withAny.outcomes).map((r) => r.name)).not.toContain("a");
        }
      });
    });
  }

  // Criterion 5. The two carriers must stay DISTINCT. This mirrors R4-M1's
  // assertion that the host and native string carriers differ, and it is the
  // test that fails if someone "unifies the ABI" by making one lane adopt the
  // other's carrier without re-deciding this issue.
  describe("the two dynamic carriers stay distinct", () => {
    for (const target of ["gc", "standalone"] as const) {
      it(`${target}: compatibility carries externref, fast carries a typed $AnyValue ref`, async () => {
        const compat = await compileIn(ANY_NUMBER, { name: `${target}/compat`, target, fast: false });
        const fast = await compileIn(ANY_NUMBER, { name: `${target}/fast`, target, fast: true });
        const compatLine = moduleGlobalLine(compat.wat, "a");
        const fastLine = moduleGlobalLine(fast.wat, "a");

        expect(compatLine).toContain("(mut externref)");
        expect(fastLine).toMatch(/\(mut \(ref null \d+\)\)/);
        // The whole point: silently unifying them fails HERE, loudly, rather
        // than as an `abi-type-index-mismatch` deep in a later build.
        expect(fastLine).not.toBe(compatLine);
      });
    }

    it("both targets make the SAME choice in each mode — the split is fast/compat, not target", async () => {
      // The four-cell control. If this ever fails, the axis assumption behind
      // every other test in this file is wrong and the file must be re-read.
      const gcCompat = moduleGlobalLine(
        (await compileIn(ANY_NUMBER, { name: "gc/compat", target: "gc", fast: false })).wat,
        "a",
      );
      const stCompat = moduleGlobalLine(
        (await compileIn(ANY_NUMBER, { name: "standalone/compat", target: "standalone", fast: false })).wat,
        "a",
      );
      expect(gcCompat).toBe(stCompat);

      const gcFast = moduleGlobalLine(
        (await compileIn(ANY_NUMBER, { name: "gc/fast", target: "gc", fast: true })).wat,
        "a",
      );
      const stFast = moduleGlobalLine(
        (await compileIn(ANY_NUMBER, { name: "standalone/fast", target: "standalone", fast: true })).wat,
        "a",
      );
      // Same SHAPE in both targets; the type index is per-module numbering.
      expect(gcFast.replace(/\d+/g, "N")).toBe(stFast.replace(/\d+/g, "N"));
    });
  });
});
