// #5248 — the test262 lane's `Temporal` wiring, at the two seams that are cheap
// to assert and expensive to get wrong. Neither test builds the provider (~52 s
// cold); both guard invariants that a 838-row measurement discovered the hard
// way.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { temporalPrelude } from "../src/temporal-provider.js";
import { test262NeedsTemporalGlobal } from "./test262-runner.js";

const REPO_ROOT = join(import.meta.dirname, "..");

const PROVIDER = {
  getterField: "__temporal_global_0",
} as unknown as Parameters<typeof temporalPrelude>[0];

describe("#5248 the prelude stays valid JavaScript, not just TypeScript", () => {
  // The prelude read `const Temporal: any = …` before this issue. Every test262
  // row compiles as `.js` under `allowJs`, so that annotation turned all five
  // probe rows into `compile_error: Type annotations can only be used in
  // TypeScript files` — a 100 % failure the dogfood harness could not see,
  // because its own entry is `.ts`.
  it("parses as .js with no syntactic diagnostics", () => {
    const prelude = temporalPrelude(PROVIDER);
    expect(prelude).not.toMatch(/:\s*any/);
    const sf = ts.createSourceFile("probe.js", prelude, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS);
    // `parseDiagnostics` is internal but stable; an annotation in a JS file
    // surfaces here and nowhere else without a full program.
    const diagnostics = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))).toEqual([]);
  });
});

describe("#5248 the provider gate", () => {
  it("takes a Temporal path OR a `features:` mention, and nothing else", () => {
    expect(test262NeedsTemporalGlobal("built-ins/Temporal/Duration/basic.js", {})).toBe(true);
    // The 8 `toTemporalInstant` rows have no path separator before `Temporal`
    // and are reachable ONLY through `features:`.
    expect(
      test262NeedsTemporalGlobal("built-ins/Date/prototype/toTemporalInstant/basic.js", { features: ["Temporal"] }),
    ).toBe(true);
    // A stray mention in a comment or an assertion message must NOT put a
    // non-Temporal row on the linked path — that is why the gate is not
    // `referencesTemporal(source)`.
    expect(test262NeedsTemporalGlobal("built-ins/Date/prototype/toTemporalInstant/basic.js", {})).toBe(false);
    expect(test262NeedsTemporalGlobal("language/statements/const/basic.js", { features: ["BigInt"] })).toBe(false);
  });

  it("honours JS2WASM_TEST262_TEMPORAL=0 set AFTER this module was imported", () => {
    // The opt-out is read lazily for exactly this reason: ESM imports are
    // hoisted, so `scripts/validate-test262-baseline.ts` sets the variable long
    // after the runner module has been evaluated. A module-scope `const` would
    // capture the unset value and ignore the opt-out silently.
    const previous = process.env.JS2WASM_TEST262_TEMPORAL;
    process.env.JS2WASM_TEST262_TEMPORAL = "0";
    try {
      expect(test262NeedsTemporalGlobal("built-ins/Temporal/Duration/basic.js", {})).toBe(false);
    } finally {
      // `Reflect.deleteProperty`, not `delete` (lint) and not `= undefined`
      // (which would set the STRING "undefined" and leak into later tests).
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST262_TEMPORAL");
      else process.env.JS2WASM_TEST262_TEMPORAL = previous;
    }
  });

  it("the baseline validator takes its default FROM the baseline, not from a pin", () => {
    // #5248 pinned this OFF because only the in-process lane was wired and the
    // committed baseline came from the unwired sharded lane. #5353 wires the
    // sharded lane, so the correct default flips one merge AFTER that lands —
    // when a provider-linked baseline is first promoted. A constant is wrong on
    // one side of that promotion whichever value it holds, and wrong here is
    // expensive: a red `test262-baseline-validate` is a NON-required check, and
    // `UNSTABLE` is skipped by auto-enqueue silently and indefinitely
    // (#3878/#3904). So the validator reads the evidence the baseline itself
    // carries — `Temporal is not defined` rows exist only in an unlinked one.
    const source = readFileSync(join(REPO_ROOT, "scripts", "validate-test262-baseline.ts"), "utf-8");
    expect(source).not.toMatch(/process\.env\.JS2WASM_TEST262_TEMPORAL \?\?= "0"/);
    expect(source).toContain("alignTemporalProviderWithBaseline");
    expect(source).toContain("Temporal is not defined");
  });
});
