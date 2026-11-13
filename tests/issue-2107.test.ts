// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2107 (value-rep P4) — standalone any-helper conformance for the `typeof`
 * operator over canonical JsTag (#2104) tags.
 *
 * Two defects fixed here, both observable only on the standalone / WASI
 * (native-strings, no JS host) path where an `any`/union value is carried as an
 * externref and `typeof` routes through the native `__typeof_*` helpers (or, for
 * a true `$AnyValue` operand, `__any_typeof`):
 *
 *   1. `__typeof_object` returned `1` (object) for ANY non-null, non-boxed
 *      primitive externref — including a native `$AnyString` string. So a
 *      string-typed `any` reported BOTH `typeof === "string"` and
 *      `typeof === "object"` as true. Added a `ref.test $AnyString` guard that
 *      classifies a native string as NOT an object.
 *   2. `compileTypeofComparison`'s `$AnyValue` fast-path used pre-canonical tag
 *      maps (`string -> [5,6]`, `object -> [0]`, no `function`). Corrected to
 *      `string -> [5]`, `object -> [0,6]`, `function -> [7]`, and the
 *      `__any_typeof` helper's tag arms now emit "string"/"function" for tags
 *      5/7 instead of collapsing them to "object". `compileTypeofExpression`
 *      now consults `__any_typeof` on the standalone path too (it was gated on
 *      `ctx.fast`, leaving standalone on the null `__typeof` stub).
 *
 * Tests use the *dynamic* typeof path (a runtime-selected union branch) so the
 * value flows through the runtime helper rather than being statically resolved.
 */

async function runStandalone(src: string, target: "standalone" | "wasi"): Promise<number> {
  const r = await compile(src, { target });
  expect(
    r.success,
    `compile failed (${target}):\n${(r.errors ?? []).map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, { env: {} });
  return (instance.exports as Record<string, (...a: unknown[]) => number>).test();
}

const TARGETS: Array<"standalone" | "wasi"> = ["standalone", "wasi"];

describe("#2107 standalone typeof conformance over canonical tags", () => {
  for (const target of TARGETS) {
    describe(`target=${target}`, () => {
      // A string held dynamically is `typeof === "string"` and NOT "object".
      it("string-any reports typeof 'string', not 'object'", async () => {
        const src = `
          function pick(i: number): string | number { return i > 0 ? "hi" : 5; }
          export function test(): number {
            const x = pick(1); // runtime string
            const isStr = (typeof x === "string") ? 1 : 0;
            const isObj = (typeof x === "object") ? 1 : 0;
            // expect string=1, object=0  → encode as isStr*10 + isObj
            return isStr * 10 + isObj;
          }
        `;
        expect(await runStandalone(src, target)).toBe(10);
      });

      it("number-any reports typeof 'number'", async () => {
        const src = `
          function pick(i: number): string | number { return i > 0 ? "hi" : 5; }
          export function test(): number {
            const x = pick(0); // runtime number
            const isNum = (typeof x === "number") ? 1 : 0;
            const isStr = (typeof x === "string") ? 1 : 0;
            return isNum * 10 + isStr;
          }
        `;
        expect(await runStandalone(src, target)).toBe(10);
      });

      it("object-any reports typeof 'object', not 'string'", async () => {
        const src = `
          function pick(i: number): { a: number } | number { return i > 0 ? { a: 1 } : 5; }
          export function test(): number {
            const x = pick(1); // runtime object
            const isObj = (typeof x === "object") ? 1 : 0;
            const isStr = (typeof x === "string") ? 1 : 0;
            return isObj * 10 + isStr;
          }
        `;
        expect(await runStandalone(src, target)).toBe(10);
      });

      it("function-any reports typeof 'function', not 'object'", async () => {
        const src = `
          function pick(i: number): (() => number) | number { return i > 0 ? (() => 1) : 5; }
          export function test(): number {
            const x = pick(1); // runtime function
            const isFn = (typeof x === "function") ? 1 : 0;
            const isObj = (typeof x === "object") ? 1 : 0;
            return isFn * 10 + isObj;
          }
        `;
        expect(await runStandalone(src, target)).toBe(10);
      });

      // (#4258) Was KNOWN BROKEN — a real silent wrong answer, kept as the
      // acceptance test for the fix rather than deleted or weakened. It passes
      // on main as of 2026-10-16 (the issue-tests detector reported the
      // `it.fails` as UNEXPECTED PASS), so it is a plain `it` now and its
      // erasure-recording twin is deleted, as that twin's comment required
      // (#7014). The history below is kept because it explains the kill-switch.
      //
      // `mapTsTypeToWasm`'s union arm lowers `string | undefined` to
      // `(ref null $AnyString)`, a carrier that cannot represent `undefined`,
      // so the undefined arm is erased to NULL — the emitted signature is
      // literally `(func $pick (param f64) (result (ref null 3)))`. `typeof`
      // then correctly reports "object", because the value it is handed really
      // IS null.
      //
      // This test USED to pass, and passed for the wrong reason: under the
      // legacy regime `undefined ≡ null`, so `typeof null` answered
      // "undefined" and the erasure was invisible. `6f7f93c8` (#2106) made
      // `typeof null === "object"` — correct per §13.5.3 — which uncancelled
      // the two bugs. Bisect over 3,059 revisions lands on that commit; it is
      // the revealer, not the cause.
      //
      // **Do not make this green by reverting or re-gating #2106.** That
      // reinstates a second defect whose only virtue is hiding this one. The
      // test below this one pins exactly that mistake.
      it("undefined-any reports typeof 'undefined' (#4258)", async () => {
        const src = `
          function pick(i: number): string | undefined { return i > 0 ? "hi" : undefined; }
          export function test(): number {
            const x = pick(0); // runtime undefined
            const isUndef = (typeof x === "undefined") ? 1 : 0;
            const isStr = (typeof x === "string") ? 1 : 0;
            return isUndef * 10 + isStr;
          }
        `;
        expect(await runStandalone(src, target)).toBe(10);
      });

      // KILL-SWITCH for the wrong cure. The legacy `undefined ≡ null` regime
      // made the case above LOOK fixed, so someone chasing green could revert
      // #2106 and believe they had solved it. While #4258 was open this pinned
      // `=== null` as wrong (1) in BOTH regimes. With the erasure gone it
      // answers the JS-correct 0 in the legacy regime too (measured 2026-10-16,
      // #7014), so the pin now guards that the legacy flag does not bring the
      // erasure back.
      it("(#4258) the $undefined-singleton flag does not reintroduce the erasure — `=== null` is false", async () => {
        const src = `
          function pick(i: number): string | undefined { return i > 0 ? "hi" : undefined; }
          export function test(): number { return (pick(0) === null) ? 1 : 0; }
        `;
        const saved = process.env.JS2WASM_UNDEF_SINGLETON;
        try {
          process.env.JS2WASM_UNDEF_SINGLETON = "0";
          // JS says 0.
          expect(await runStandalone(src, target)).toBe(0);
        } finally {
          if (saved === undefined) {
            // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
            delete process.env.JS2WASM_UNDEF_SINGLETON;
          } else {
            process.env.JS2WASM_UNDEF_SINGLETON = saved;
          }
        }
      });

      // Positive control, and the whole point of #4258's diagnosis: a
      // HETEROGENEOUS union with undefined is CORRECT today, because two
      // differently-mapped arms force an `externref` carrier, which can hold
      // the `$undefined` singleton. Same `undefined`, same `typeof` lowering —
      // only the carrier differs.
      //
      // Without this control the reader cannot tell whether typeof-over-
      // undefined is broken in general (it is not) or only where the union's
      // other arm has a narrower carrier (it is). Note `{ a: number } |
      // undefined` is NOT usable here: an interface maps to a named struct
      // ref, so it is broken in the same way as the string case — checked, not
      // assumed.
      it("heterogeneous-or-undefined reports typeof 'undefined' — the carrier is what differs", async () => {
        const src = `
          function pick(i: number): string | number | undefined {
            return i > 0 ? "hi" : (i < 0 ? 5 : undefined);
          }
          export function test(): number {
            const x = pick(0);
            const isUndef = (typeof x === "undefined") ? 1 : 0;
            const isNull = (x === null) ? 1 : 0;
            return isUndef * 10 + isNull;
          }
        `;
        expect(await runStandalone(src, target)).toBe(10);
      });
    });
  }
});
