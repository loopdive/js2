import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { compileProject } from "../src/index.js";

/**
 * #4152 — regression guard for lodash's `createHybrid` family.
 *
 * ## Why this file exists
 *
 * `_createHybrid.js` is the most capture-dense function in lodash: it builds a
 * wrapper closure over `partials`, `holders`, `argPos`, `ary`, `arity` and
 * friends, and returns it from the enclosing factory. That is exactly the shape
 * the #4133/#4134 nested-capture defects hit — a nested function whose captures
 * are sourced from the declaring frame's local slots.
 *
 * It has already been broken once. The `funcMapOwnerDecl` +
 * `restoreShadowedFuncBindings` recompile path attempted during #4134 broke
 * `createHybrid`; it was caught only because someone ran the full lodash bundle
 * by hand, and the approach was backed out entirely. **Nothing in the test
 * suite covered it** — verified 2026-08-04, `grep -rl createHybrid tests/`
 * returned nothing. This file closes that gap.
 *
 * ## What is asserted, and why THAT
 *
 * The failure mode of this defect class is **an invalid module**, not a wrong
 * value: codegen emits `local.get N` where N is outside the function's frame,
 * and the binary fails Wasm validation with "local index out of range". So the
 * load-bearing assertion is `WebAssembly.validate`, not a computed result.
 *
 * Compilation is checked to *succeed* but NOT to be diagnostic-free: these
 * files legitimately produce TypeScript type errors when compiled as loose JS
 * (`Property 'placeholder' does not exist on type 'Function'`, and similar).
 * Those are non-fatal — `success` stays true and a valid binary is produced.
 * Asserting zero diagnostics would make this test fail for reasons unrelated to
 * the invariant it guards.
 *
 * ## Non-vacuity
 *
 * Measured on this checkout, 2026-08-04, all four entry points compile to valid
 * Wasm (`partial` 73,792 B · `_createHybrid` 49,749 B · `bind` 75,460 B ·
 * `curry` 70,009 B). The test therefore passes today for a real reason.
 *
 * "It passes today" is not on its own evidence that the assertion has teeth, so
 * the rejection side was demonstrated directly rather than assumed: a
 * hand-assembled module whose single function declares ZERO locals and executes
 * `local.get 5` — the exact emission shape of this defect — returns
 * `WebAssembly.validate(...) === false`, while an otherwise identical
 * well-formed module returns `true`. So the guard flips red the moment
 * out-of-frame emission returns to this call graph, which is the precise event
 * it exists to catch.
 *
 * A stronger assertion (invoking the wrapper and checking behaviour) is
 * deliberately NOT made here: these modules do not yet instantiate standalone
 * (missing imports, tracked separately), so a behavioural assertion would have
 * to be skipped and would guard nothing. Validity is the strongest claim that
 * is true today.
 *
 * ## Gating reality — read before assuming this protects main
 *
 * Untouched root test files do NOT run at PR time (#3008's two-layer design);
 * the full suite is deferred to the post-merge `issue-tests.yml` detector,
 * which detects but does not ENFORCE. The per-PR enforcing gate is the curated
 * `tests/guard-suite.json` manifest, and this file does **not** currently meet
 * its entry criterion 1 ("guards an invariant that a prior PR silently broke on
 * **main**") — the `createHybrid` break happened on a branch and was backed out
 * before merge. Adding it anyway would be quietly widening a manifest whose
 * whole value is that its criteria are honoured, so it is left out. If this
 * ever breaks main, criterion 1 is satisfied and it should be promoted; it
 * already meets criteria 2 (~16s for the file, no test262 harness or other
 * prepared inputs — well inside the 60s ceiling) and 3 (green on main).
 */

const LODASH_ENTRIES = [
  "node_modules/lodash/_createHybrid.js",
  "node_modules/lodash/partial.js",
  "node_modules/lodash/bind.js",
  "node_modules/lodash/curry.js",
] as const;

const lodashInstalled = existsSync("node_modules/lodash/_createHybrid.js");
const runIfInstalled = lodashInstalled ? it : it.skip;

describe("#4152 — lodash createHybrid family compiles to a VALID module", () => {
  for (const entry of LODASH_ENTRIES) {
    const name = entry.split("/").pop();

    runIfInstalled(`${name}: compiles and passes Wasm validation`, async () => {
      const result = await compileProject(entry, { allowJs: true });

      expect(result.success).toBe(true);
      expect(result.binary).toBeDefined();
      expect(result.binary!.length).toBeGreaterThan(0);

      // The invariant. An out-of-frame `local.get` fails here and nowhere else.
      expect(WebAssembly.validate(result.binary!)).toBe(true);
    });

    runIfInstalled(`${name}: emits no out-of-frame local reference`, async () => {
      const result = await compileProject(entry, { allowJs: true });

      // Belt-and-braces alongside validate(): if the emitter ever reports the
      // breach as a diagnostic rather than producing an invalid binary, this
      // arm still catches it. Scoped to the specific message so unrelated
      // type diagnostics (which these files DO produce) don't trip it.
      const outOfFrame = (result.errors ?? []).map((e) => e.message).filter((m) => /local index out of range/i.test(m));

      expect(outOfFrame).toEqual([]);
    });
  }
});
