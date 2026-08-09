// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3024 — module-global slot-type-vs-stored-value desync emitted INVALID Wasm.
 *
 * A module-level `var`/`let` becomes a Wasm module global whose declared slot
 * type is derived from the STATIC TS type, but the value actually stored can
 * have a different Wasm representation, and the write site did not coerce. Two
 * write paths, one family:
 *
 *  (A) Object literal with a RUNTIME computed key — `var o = { a, [foo()]: v }`.
 *      `compileObjectLiteral` builds these as a host `$Object` (externref) via
 *      `_hasRuntimeComputedKey`, but `moduleInitForcesExternref`
 *      (declarations.ts) did NOT mirror that predicate, so the global stayed
 *      struct-typed → `global.set expected (ref null N), found externref` (and
 *      the read's `extern.convert_any` on the struct slot was also invalid).
 *      Literal computed keys `[1]` still fold to a static struct — unchanged.
 *
 *  (B) for-of / for-await array-rest destructuring-ASSIGNMENT —
 *      `var x, y; for ([x, ...y] of …) {}`. `emitGlobalSyncWriteback`
 *      (for-of-destructuring.ts) did a raw `local.get; global.set`; the rest
 *      slice materializes a `(ref null vec)` local while the untyped `var y`
 *      global is `externref` → `global.set expected externref, found
 *      (ref null N)`.
 *
 * Both guards fire ONLY on shapes that were ALWAYS invalid Wasm before, so no
 * previously-valid module changes (byte-inert). Fix mirrors the already-correct
 * function-local typing (`resolveSpillLocalValType`) and the binding-form
 * `syncDestructuredLocalsToGlobals` coercion precedent.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { runTest262File } from "./test262-runner.ts";

const T262 = join(process.cwd(), "test262");

async function validates(src: string): Promise<{ ok: boolean; msg: string }> {
  const r: any = await compile(src, { fileName: "t.ts" });
  if (!r.success) return { ok: false, msg: `compile failed: ${(r.errors ?? [])[0]?.message ?? "?"}` };
  if (WebAssembly.validate(r.binary)) return { ok: true, msg: "" };
  let msg = "invalid";
  try {
    await WebAssembly.compile(r.binary);
  } catch (e: any) {
    msg = String(e.message).split("\n")[0];
  }
  return { ok: false, msg };
}

describe("#3024 — module-global slot-type-vs-value desync", () => {
  it("A: module var object literal with a runtime computed key validates", async () => {
    const cases = [
      `function ID(x) { return x; }\nvar object = { a: 'A', [1]: 'B', c: 'C', [ID(2)]: 'D' };`,
      `var o = { a: 'A', [foo()]: 'B' }; function foo(){return 2;}`,
    ];
    for (const src of cases) {
      const { ok, msg } = await validates(src);
      expect(ok, `${msg}\n---\n${src}`).toBe(true);
    }
  });

  it("A: literal computed keys stay on the struct path (unchanged, still valid)", async () => {
    // Narrowness guard: `[1]`/`[2]` fold to a compile-time key, so these keep the
    // struct representation and must NOT be affected by the externref routing.
    for (const src of [
      `var o = { a: 'A', [1]: 'B' };`,
      `var o = { a: 'A', [1]: 'B', c: 'C', [2]: 'D' };`,
      `var o = { [1]: 'A', [2]: 'B' };`,
    ]) {
      const { ok, msg } = await validates(src);
      expect(ok, `${msg}\n---\n${src}`).toBe(true);
    }
  });

  it("B: module var for-of array-rest destructuring-assignment validates", async () => {
    for (const src of [
      `var x, y;\nfor ([x, ...y] of [[1, 2, 3]]) {}`,
      `var x, y;\nvar counter = 0;\nfor ([, , x, , ...y] of [[1, 2, 3, 4, 5, 6]]) { counter += 1; }`,
    ]) {
      const { ok, msg } = await validates(src);
      expect(ok, `${msg}\n---\n${src}`).toBe(true);
    }
  });

  // Representative real test262 files from both sub-clusters. The regression
  // guard is "no invalid-Wasm signature" (the CE→valid flip); several also reach
  // a genuine `pass`, asserted below.
  const NO_INVALID: [rel: string, category: string][] = [
    ["test/language/computed-property-names/basics/number.js", "language/computed-property-names"],
    ["test/language/computed-property-names/basics/string.js", "language/computed-property-names"],
    ["test/built-ins/Object/assign/target-is-sealed-existing-data-property.js", "built-ins/Object"],
    ["test/built-ins/Reflect/ownKeys/return-on-corresponding-order-large-index.js", "built-ins/Reflect"],
    ["test/language/statements/for-of/dstr/array-rest-elision.js", "language/statements/for-of"],
    ["test/language/statements/for-of/dstr/array-rest-after-element.js", "language/statements/for-of"],
    [
      "test/language/statements/for-await-of/async-gen-decl-dstr-array-rest-elision.js",
      "language/statements/for-await-of",
    ],
  ];

  it.runIf(existsSync(T262))(
    "representative test262 files no longer emit invalid Wasm (were CE/instantiate-fail)",
    async () => {
      for (const [rel, category] of NO_INVALID) {
        const abs = join(T262, rel);
        if (!existsSync(abs)) continue;
        const r = await runTest262File(abs, category, 20000);
        const msg = String(r.error ?? r.reason ?? "");
        expect(msg, `${rel}: ${r.status} — ${msg}`).not.toMatch(/invalid Wasm binary|Compiling function/i);
      }
    },
    60000,
  );

  it.runIf(existsSync(T262))(
    "representative files now reach a genuine pass",
    async () => {
      const PASS: [rel: string, category: string][] = [
        ["test/language/computed-property-names/basics/number.js", "language/computed-property-names"],
        ["test/language/statements/for-of/dstr/array-rest-elision.js", "language/statements/for-of"],
      ];
      for (const [rel, category] of PASS) {
        const abs = join(T262, rel);
        if (!existsSync(abs)) continue;
        const r = await runTest262File(abs, category, 20000);
        expect(r.status, `${rel}: ${r.status} — ${String(r.error ?? r.reason ?? "")}`).toBe("pass");
      }
    },
    60000,
  );
});
