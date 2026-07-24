// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3378 — the real, unmodified test262 harness file `deepEqual.js` (which
// backs `assert.deepEqual` across many built-in/language test262 files)
// previously failed to compile with a STALE LOCAL index error (the #2043
// class, but a local — not a funcIdx — went stale):
//
//   Binary emit error: RangeError: Codegen error: local index out of range —
//   6 (valid: [0, 5)) at function '__closure_NN'.
//
// Root cause (fixed in src/codegen/closures.ts `collectReferencedIdentifiers`):
// the free-variable walker collected the NAME side of a member access
// (`parts.join('')`) as an identifier reference. `deepEqual.js` has a
// module-scope `let join = arr => arr.join(', ')`, so the property name `join`
// in `stringFromTemplate`'s `parts.join('')` was mis-recorded as a free
// variable and thus a SPURIOUS capture of `stringFromTemplate`. That capture's
// `outerLocalIdx` is only valid in the IIFE frame that declares `join`; when
// `stringFromTemplate` is invoked from the deeply-nested `toString` closure
// (a different, smaller frame), the capture-prepend baked `join`'s outer index
// (6) into a closure whose local count is 5 → "local index out of range".
// A property name is never a variable reference, so skipping it is the
// canonical free-variable-analysis rule and removes the spurious capture.
//
// This is a compilation-progress guard: it asserts the deepEqual.js compile no
// longer aborts with the `local index out of range` fatal. NOTE: a SEPARATE,
// pre-existing and independent defect (a `call_ref` arity mismatch, "not enough
// arguments on the stack for call (need 4, got 3)" in the `format` closure) was
// MASKED by this crash and is surfaced once it is fixed — it still blocks a
// fully WebAssembly-valid binary and is tracked separately. Hence this test
// checks that the specific #3378 fatal is gone, not full module validation.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

const HARNESS = join(process.cwd(), "test262", "harness");

describe("#3378 deepEqual.js — spurious property-name capture / stale local index", () => {
  it.runIf(existsSync(HARNESS))(
    "stub-assert + deepEqual.js compiles without the 'local index out of range' fatal",
    async () => {
      const rd = (f: string) => readFileSync(join(HARNESS, f), "utf8");
      // A tiny local `assert` callable is what makes deepEqual.js actually
      // compile its `assert.deepEqual.format = function(){…}` closures (rather
      // than treating them as dynamic/host writes) — the minimal trigger.
      const stub = "function assert(x, m){ if(!x) throw new Error(m); }\nassert.x=1;\n";
      const body = stub + rd("deepEqual.js") + '\nconsole.log("x");\n';
      const src = `export function test() {\n${body}\n}`;
      const r = await compile(src, {
        target: "gc",
        fileName: "test.ts",
        skipSemanticDiagnostics: true,
        emitWat: false,
      } as Parameters<typeof compile>[1]);

      const fatal = r.errors.filter((e) => (e as { severity?: string }).severity !== "warning");
      const oor = fatal.filter((e) => /local index out of range/.test(e.message));
      // The #3378 fix: the stale-local-index fatal must be gone.
      expect(
        oor.length,
        `the #3378 stale-local-index fatal is still present:\n${oor.map((e) => e.message).join("\n")}`,
      ).toBe(0);
      // Compilation as a whole must no longer abort (it did on main with the
      // above RangeError). A binary is emitted.
      expect(r.success, fatal.map((e) => e.message).join("\n")).toBe(true);
      expect(r.binary != null && r.binary.length > 0, "empty binary").toBe(true);
    },
    30000,
  );
});
