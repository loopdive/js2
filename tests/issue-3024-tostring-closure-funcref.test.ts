/**
 * #3024 — `Function.prototype.toString` invalid-Wasm cluster (68 files).
 *
 * The test262 `nativeFunctionMatcher.js` harness defines mutually-recursive
 * `const` closures (`assertToStringOrNativeFunction` → `assertNativeFunction` →
 * `validateNativeFunctionSource` → inner `eat`/`test`/…). Such a closure is
 * boxed into a ref cell that stores a BARE FUNCREF, and its lifted self carrier
 * is a no-capture funcref-WRAPPER struct `(struct (field funcref))`. The
 * boxed-capture call path (`calls-closures.ts` `compileClosureCall`) stale-read
 * `boxed.valType` as `externref` and emitted `any.convert_extern` on the
 * unwrapped funcref — `any.convert_extern[0] expected type externref, found
 * struct.get of type funcref` — so EVERY `built-ins/Function/prototype/toString/*`
 * file that pulls in this harness failed Wasm validation at *instantiate*.
 *
 * The fix trusts the actual ref-cell field-0 type: when it is `funcref` and the
 * self carrier is a single-funcref-field wrapper, the self carrier is rebuilt by
 * wrapping the funcref via `struct.new` instead of the invalid
 * `any.convert_extern` + struct guarded-cast.
 *
 * This asserts the *validation* failure is gone (CE → valid Wasm). Files that
 * additionally INVOKE the native matcher surface a DISTINCT construct-site
 * closure-funcref-cell runtime trap tracked separately (#3534); this slice is
 * scoped to eliminating the invalid-Wasm compile errors, mirroring the earlier
 * #3024 slices (CE→valid, not a runtime-pass claim).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.ts";

const T262 = join(process.cwd(), "test262");
const CAT = "built-ins/Function";
const DIR = "test/built-ins/Function/prototype/toString";

// Representative files from the 68-file cluster (all failed Wasm validation with
// the `any.convert_extern … found … funcref` signature before the fix).
const FILES = [
  "arrow-function.js",
  "async-function-declaration.js",
  "bound-function.js",
  "built-in-function-object.js",
  "Function.js",
  "GeneratorFunction.js",
  "getter-class-expression.js",
  "line-terminator-normalisation-CR.js",
  "setter-object.js",
];

describe("#3024 — Function.prototype.toString closure funcref-cell invalid-Wasm", () => {
  it.runIf(existsSync(T262))(
    "no longer emits invalid Wasm (any.convert_extern on a funcref)",
    async () => {
      for (const f of FILES) {
        const abs = join(T262, DIR, f);
        if (!existsSync(abs)) continue; // tolerate submodule pathing drift
        const r = await runTest262File(abs, CAT, 20000);
        const msg = String(r.error ?? r.reason ?? "");
        expect(r.status, `${f}: ${r.status} — ${msg}`).not.toBe("compile_error");
        expect(msg).not.toMatch(
          /any\.convert_extern.*funcref|expected type externref, found struct\.get of type funcref/,
        );
      }
    },
    120000,
  );
});
