// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3287 — compiler threw a bare-STRING exception (via the shared `$exc` tag)
 * where the spec mandates a real `TypeError` INSTANCE.
 *
 * #3285 slice-1 tightened the test262 `assert_throws` shim from "did anything
 * throw" to "did the CORRECT type throw" (`e instanceof <Kind>` + `.name`
 * fallback). That exposed ~18 throw sites that emitted `emitThrowString` /
 * `buildThrowStringInstrs` — an opaque string payload that is NOT `instanceof`
 * any Error subclass and has no `.name`, so a spec-correct
 * `assert.throws(TypeError, fn)` failed even though the message string read
 * "TypeError: …". Those sites now emit real TypeError instances via
 * `emitThrowTypeError` / `buildThrowJsErrorInstrs`.
 *
 * The check below MIRRORS the tightened shim inside the compiled program:
 *   1 = caught value is `instanceof TypeError`  (spec-correct)
 *   2 = `.name === "TypeError"` fallback match
 *   3 = neither (the pre-#3287 bare-string bug)
 *   0 = nothing thrown
 * Every case must return 1 (or 2), never 3, in BOTH host and standalone modes.
 */

const MODULE = `
function chk(fn: () => void): number {
  try { fn(); } catch (e) {
    if (e instanceof TypeError) return 1;
    if ((e as any).name === "TypeError") return 2;
    return 3;
  }
  return 0;
}
// §9.1.1.1.5 SetMutableBinding on an immutable binding -> TypeError.
export function constAssign(): number { return chk(() => { const x = 1; eval; x = 2; return x; }); }
export function constPlusEq(): number { return chk(() => { const x = 1; eval; x += 2; return x; }); }
export function constPreInc(): number { return chk(() => { const x = 1; eval; ++x; return x; }); }
export function constPostInc(): number { return chk(() => { const x = 1; eval; x++; return x; }); }
// §23.1.3.24 / §23.1.3.25 step 3 — reduce/reduceRight of empty array, no seed.
export function reduceEmpty(): number { return chk(() => { const a: number[] = []; a.reduce((p, c) => p + c); }); }
export function reduceRightEmpty(): number { return chk(() => { const a: number[] = []; a.reduceRight((p, c) => p + c); }); }
// §10.1.9 — write to a frozen own data property in strict mode.
export function frozenWrite(): number { return chk(() => { "use strict"; const o: any = Object.freeze({ a: 1 }); o.a = 2; }); }
`;

async function results(target?: "standalone"): Promise<Record<string, number>> {
  // (88d8444b72, #6676) The fixture's bare `eval;` reads the eval VALUE, which
  // under standalone imports the linked `js2wasm:runtime-eval` provider by
  // default. This lane asserts "no host imports" and instantiates against `{}`,
  // so it opts out of the provider; the TypeError sites under test are unchanged.
  const opts = target ? { target, runtimeEvalProvider: false } : {};
  const r = await compile(MODULE, opts);
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const importObject = (r as unknown as { importObject?: WebAssembly.Imports }).importObject ?? {};
  const { instance } = await WebAssembly.instantiate(r.binary, target ? {} : importObject);
  const ex = instance.exports as Record<string, () => number>;
  const out: Record<string, number> = {};
  for (const k of [
    "constAssign",
    "constPlusEq",
    "constPreInc",
    "constPostInc",
    "reduceEmpty",
    "reduceRightEmpty",
    "frozenWrite",
  ]) {
    out[k] = ex[k]!();
  }
  return out;
}

describe("#3287 — throw real TypeError instances, not bare strings", () => {
  it("host mode: every wrong-type site now throws instanceof TypeError", async () => {
    const out = await results();
    for (const [name, code] of Object.entries(out)) {
      expect(code, `${name} returned ${code} (3 = bare-string / wrong-type bug)`).not.toBe(3);
      expect(code, `${name} did not throw`).not.toBe(0);
    }
  });

  it("standalone mode: same sites throw instanceof TypeError with no host imports", async () => {
    const out = await results("standalone");
    for (const [name, code] of Object.entries(out)) {
      expect(code, `${name} returned ${code} (3 = bare-string / wrong-type bug)`).not.toBe(3);
      expect(code, `${name} did not throw`).not.toBe(0);
    }
  });
});
