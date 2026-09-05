// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3523 R4-M1 — a `string` top-level binding is a real IR module-binding
// storage kind, so `<module-init>` claims instead of reporting unrepresentable
// storage.
//
// Why this slice exists: `<module-init>` is one unit per source file, and ONE
// unrepresentable top-level declaration rejects the whole unit. Measured on
// `tests/dogfood/corpus` (2026-09-03, `JS2WASM_IR_SHAPE_DIAG=1`), every
// module-init rejection came from a single arm — the resolver's `unsupported`
// return — and `string` was the largest declared type with no value kind at
// all. This slice adds that kind only; `any`, arrays, objects, functions,
// class instances and bigint remain separate storage decisions.
//
// What these tests protect:
//   - **Both carriers of ONE source fact (#679).** A string module global is
//     an `externref` under host strings and a WasmGC `(ref null $AnyString)`
//     under `nativeStrings`. The emitted global type is asserted per lane, so
//     a future change that quietly unifies them — or resolves one lane's slot
//     with the other lane's carrier — fails here rather than as a Program ABI
//     invariant deep in a later build.
//   - **Claim ⇔ lowering parity.** The tests do not stop at "it claimed":
//     they compile, instantiate, RUN, and compare against the same program
//     evaluated in JS. A claim whose lowering is wrong fails here.
//   - **The boundary is deliberate.** `string | undefined` and `var` are
//     refused, and the refusals are asserted. Both are storage decisions this
//     slice did not measure: a union has no single carrier and no
//     null-carrying IR string value, and a module `var` is the one form whose
//     legacy slot the widening arms (`with`-body hoisting, an observed
//     pre-initialization `undefined`) retype to `externref` — which on the
//     native lane is NOT the string carrier.
//   - **Literal-type widening.** `const s = "plain"` has the declared type
//     `"plain"`, not `string`. Without widening the arm accepts nothing, so
//     the literal and annotated forms are asserted to behave identically.
import { describe, expect, it } from "vitest";

import { compile, type IrObservedOutcome } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

type Lane = "host" | "standalone";

const LANE_OPTIONS = {
  host: { target: "gc" as const },
  standalone: { target: "standalone" as const },
};

interface Run {
  readonly value: unknown;
  readonly outcomes: readonly IrObservedOutcome[];
  readonly wat: string;
}

async function compileAndRun(source: string, lane: Lane): Promise<Run> {
  const result = await compile(source, { fileName: "test.ts", trackIrOutcomes: true, ...LANE_OPTIONS[lane] });
  if (!result.success) throw new Error(`compile failed (${lane}): ${result.errors[0]?.message}`);
  // The production instantiator, so the host lane's `wasm:js-string` builtins
  // resolve; bare `WebAssembly.instantiate` cannot supply them.
  const built = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  const exported = (instance.exports as Record<string, () => unknown>).test;
  return { value: exported?.(), outcomes: result.irOutcomes ?? [], wat: result.wat };
}

function outcomeFor(outcomes: readonly IrObservedOutcome[], displayName: string): IrObservedOutcome {
  const found = outcomes.find((outcome) => outcome.displayName === displayName);
  if (!found) throw new Error(`no IR outcome for ${displayName} (have: ${outcomes.map((o) => o.displayName)})`);
  return found;
}

/** The `(global $__mod_<name> …)` line, so the CARRIER is asserted, not inferred. */
function moduleGlobalLine(wat: string, name: string): string {
  const line = wat.split("\n").find((candidate) => candidate.includes(`(global $__mod_${name} `));
  if (!line) throw new Error(`no __mod_${name} global in emitted module`);
  return line.trim();
}

const LITERAL_CONST = `
const greeting = "plain";
let seen = 0;

export function test(): number {
  seen = seen + greeting.length;
  return seen;
}
`;

const ANNOTATED_CONST = `
const greeting: string = "plain";
let seen = 0;

export function test(): number {
  seen = seen + greeting.length;
  return seen;
}
`;

/** The control: the SAME program with the string declaration removed. */
const NO_STRING = `
let seen = 0;

export function test(): number {
  seen = seen + 5;
  return seen;
}
`;

describe("#3523 R4-M1 string module-binding storage", () => {
  for (const lane of ["host", "standalone"] as const) {
    describe(`${lane} lane`, () => {
      it("claims <module-init> for a string-typed top-level binding", async () => {
        const run = await compileAndRun(LITERAL_CONST, lane);
        expect(outcomeFor(run.outcomes, "<module-init>").kind).toBe("emitted");
      });

      it("runs the claimed unit and matches JS — a claim implies a real lowering", async () => {
        const run = await compileAndRun(LITERAL_CONST, lane);
        expect(run.value).toBe("plain".length);
      });

      it("is no worse than the same program without the string binding", async () => {
        // A DIFFERENTIAL, not a fixed expectation: pinning "module-init is
        // emitted" would go stale the day some other arm of this file stops
        // being representable. Pinning "the string shape does whatever the
        // string-free shape does" stays true either way, and fails loudly if
        // the string binding ever becomes the WORSE of the two.
        const withString = await compileAndRun(LITERAL_CONST, lane);
        const control = await compileAndRun(NO_STRING, lane);
        expect(outcomeFor(withString.outcomes, "<module-init>").kind).toBe(
          outcomeFor(control.outcomes, "<module-init>").kind,
        );
        expect(withString.value).toBe(control.value);
      });

      it('widens the literal type: `= "plain"` behaves as `: string`', async () => {
        // `const greeting = "plain"` has the declared type `"plain"`. A
        // `StringLike` test that does not widen first accepts NEITHER form
        // consistently, so both are asserted against each other rather than
        // against a constant.
        const literal = await compileAndRun(LITERAL_CONST, lane);
        const annotated = await compileAndRun(ANNOTATED_CONST, lane);
        expect(outcomeFor(literal.outcomes, "<module-init>").kind).toBe(
          outcomeFor(annotated.outcomes, "<module-init>").kind,
        );
        expect(outcomeFor(literal.outcomes, "<module-init>").kind).toBe("emitted");
        expect(literal.value).toBe(annotated.value);
      });

      it("carries a mutable top-level `let` through a reassignment", async () => {
        const run = await compileAndRun(
          `
let label = "a";
label = "bcd";

export function test(): number {
  return label.length;
}
`,
          lane,
        );
        expect(outcomeFor(run.outcomes, "<module-init>").kind).toBe("emitted");
        expect(run.value).toBe(3);
      });

      it("preserves a non-BMP / escape-bearing literal exactly", async () => {
        // The dogfood census's own awkward literal. A carrier that silently
        // re-encoded (UTF-8 bytes, a lost surrogate pair, an unescaped tab)
        // would change `.length` here and nowhere else in this file.
        const source = `
const s = "\u{1F600}é\\n\\t\\\\";

export function test(): number {
  return s.length;
}
`;
        const run = await compileAndRun(source, lane);
        expect(outcomeFor(run.outcomes, "<module-init>").kind).toBe("emitted");
        expect(run.value).toBe("\u{1F600}é\n\t\\".length);
      });

      it("refuses `string | undefined` — no single carrier, no null-carrying IR string", async () => {
        const run = await compileAndRun(
          `
let g: string | undefined = "ab";

export function test(): number {
  return g === undefined ? 0 : g.length;
}
`,
          lane,
        );
        expect(outcomeFor(run.outcomes, "<module-init>").kind).toBe("unsupported");
        // The refusal is a demote, not a break: legacy still compiles it.
        expect(run.value).toBe(2);
      });

      it("refuses a module `var` — the one form whose legacy slot the widening arms retype", async () => {
        const run = await compileAndRun(
          `
var g = "abc";

export function test(): number {
  return g.length;
}
`,
          lane,
        );
        expect(outcomeFor(run.outcomes, "<module-init>").kind).toBe("unsupported");
        expect(run.value).toBe(3);
      });
    });
  }

  it("resolves each backend's own carrier for the same source (#679)", async () => {
    // The dual-backend claim, stated as an assertion rather than a comment.
    // Host strings put a string module global in an `externref` slot; the
    // native-string lane puts it in the WasmGC `$AnyString` i16 array. IR
    // resolves the ACTIVE backend's carrier, so these two must DIFFER.
    const host = await compileAndRun(LITERAL_CONST, "host");
    const standalone = await compileAndRun(LITERAL_CONST, "standalone");
    const hostGlobal = moduleGlobalLine(host.wat, "greeting");
    const standaloneGlobal = moduleGlobalLine(standalone.wat, "greeting");

    expect(hostGlobal).toContain("(mut externref)");
    expect(standaloneGlobal).toMatch(/\(mut \(ref null \d+\)\)/);
    expect(standaloneGlobal).not.toContain("externref");

    // Both lanes claimed the unit against those different slots.
    expect(outcomeFor(host.outcomes, "<module-init>").kind).toBe("emitted");
    expect(outcomeFor(standalone.outcomes, "<module-init>").kind).toBe("emitted");
  });
});
