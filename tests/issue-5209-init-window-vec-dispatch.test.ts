import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * (#5209) A compiled vec reaching a DYNAMIC method call during module init.
 *
 * In the JS-host lane top-level code runs in the wasm `start` section, i.e.
 * DURING `WebAssembly.instantiate`, so `callbackState.getExports()` is
 * `undefined` for the whole of module init. This is the same window #5193
 * (marshalling helpers), #5202 (class dispatch), #5203 (closure dispatch) and
 * #5205 (struct reads) closed facet by facet. Three more facets were still
 * open, and the reduced repro from the issue hit all three in sequence:
 *
 *   class HelperBase { constructor() {} }
 *   class G extends HelperBase {
 *     constructor(e, t) { super(); this.eras = t.filter((x) => x.code); }
 *   }
 *   class Sub extends G { constructor(e, t) { super(e, t); } }
 *   new Sub("c", [{ code: "a" }, { code: "b" }]);
 *
 *   1. `_wrapForHost` gated its VEC ARRAY FACADE on `getExports()`, so the vec
 *      arrived at the extern-method dispatcher as a generic object proxy with
 *      no `filter` — "TypeError: filter is not a function", thrown from the
 *      dispatcher's "no arm matched" line.
 *   2. `__cb_<id>`, the compiled body of a callback bridge, was not on the
 *      start-export channel, so `createNativeFunctionCallbackBridge` PARKED
 *      every call and answered `undefined` on the spot. Correct for an async
 *      reaction, silently wrong for `filter`: the predicate never passed and
 *      the result was `[]`.
 *   3. `_safeGet`'s `__sget_<field>` probe still asked `getExports()`, so a
 *      field read off an untyped callback parameter answered `undefined`.
 *
 * Facets 2 and 3 are the reason these rows assert VALUES, not just absence of
 * a throw: fixing only the dispatch would have turned the reported TypeError
 * into a silently empty array, which is worse — the polyfill's
 * `n.filter((e) => null != e.reverseOf).length > 1` era guard would simply
 * stop guarding.
 *
 * Every row is asserted at MODULE INIT and, where meaningful, against a
 * post-init control that was already correct on base — the boundary is timing,
 * not the source shape. Values are numeric so the standalone lane (WasmGC
 * `i16` string arrays, not host strings) runs the same assertions.
 *
 * Measured on pristine origin/main 2026-08-30: 8 of these 18 assertions fail,
 * ALL of them on the HOST lane. Every standalone row already passed — the whole
 * defect lives in the JS-host export-timing window, which the standalone lane
 * does not have. The standalone rows are kept as the guard that the fix stayed
 * on the host side.
 */
type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<unknown> {
  const result = await compile(source, {
    fileName: "issue-5209.ts",
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => unknown>).test!();
}

/** Rows measured on the host lane against pristine origin/main (2026-08-30). */
const rows: ReadonlyArray<readonly [string, string, number]> = [
  [
    // The issue's reduced repro. Base: THREW "filter is not a function".
    "derived-ctor chain: array-literal ctor argument, `.filter` at module init",
    `class HelperBase { constructor() {} }
     class G extends HelperBase {
       eras: any;
       constructor(e: any, t: any) { super(); this.eras = t.filter((x: any) => x.code); }
     }
     class Sub extends G { constructor(e: any, t: any) { super(e, t); } }
     const s = new Sub("c", [{ code: 1 }, { code: 2 }, { code: 0 }]);
     export function test(): number { return s.eras.length; }`,
    2,
  ],
  [
    // The polyfill's exact shape: `.filter(cb).length > 1`, evaluated during
    // `GregorianBaseHelper_init`. Base: THREW.
    "polyfill shape: `.filter(cb).length > 1` inside a derived ctor at init",
    `class HelperBase { constructor() {} }
     class G extends HelperBase {
       ok: boolean;
       constructor(e: any, t: any) { super(); this.ok = t.filter((x: any) => x.reverseOf != null).length > 1; }
     }
     class Sub extends G { constructor(e: any, t: any) { super(e, t); } }
     const many = new Sub("c", [{ reverseOf: 1 }, { reverseOf: 2 }]);
     const one = new Sub("c", [{ reverseOf: 1 }, {}]);
     export function test(): number { return (many.ok ? 10 : 0) + (one.ok ? 1 : 0); }`,
    10,
  ],
  [
    // No base class — the ctor chain is not load-bearing, the INIT WINDOW is.
    // Base: silently 0 (the callback bridge parked, facet 2).
    "plain class ctor at init, no base class",
    `class G {
       n: number;
       constructor(e: any, t: any) { this.n = t.filter((x: any) => x > 1).length; }
     }
     const s = new G("c", [1, 2, 3]);
     export function test(): number { return s.n; }`,
    2,
  ],
  [
    // The non-class control the issue asks for, at init. Base: THREW.
    "plain function control: `function f(t) { return t.filter(...) }` called at init",
    `function f(t: any): any { return t.filter((x: any) => x.code); }
     const out = f([{ code: 1 }, { code: 2 }, { code: 0 }]);
     export function test(): number { return out.length; }`,
    2,
  ],
  [
    // Facet 3 in isolation: STATICALLY typed receiver — `filter` itself is
    // fully compiled, no host dispatch at all — but an UNTYPED callback
    // parameter, so `x.code` is a dynamic `__extern_get` read that needs
    // `__sget_code`. Base: silently 0, no throw anywhere.
    "untyped callback parameter reads a field at init (compiled receiver)",
    `const arr = [{ code: "a" }, { code: "b" }];
     const out = arr.filter((x) => x.code === "a");
     export function test(): number { return out.length; }`,
    1,
  ],
  [
    // Facet 2: the callback must run IN PLACE, in order, during init. On base
    // this row throws at facet 1 (the receiver is dynamic, so `filter` is not
    // found at all), which is why facet 2 only became visible after the
    // dispatch fix — at which point every row above returned 0 instead of
    // throwing. The row stays as the pin on ordering: `seenDuringInit` is read
    // BEFORE instantiation returns, so a parked callback cannot satisfy it.
    "callback runs IN PLACE at init, not parked until after instantiation",
    `let seen = 0;
     function f(t: any): any { return t.filter((x: any) => { seen = seen + 1; return x > 1; }); }
     const out = f([1, 2, 3]);
     const seenDuringInit = seen;
     export function test(): number { return seenDuringInit * 10 + out.length; }`,
    32,
  ],
  [
    // Post-init control: correct on base, must stay correct. This is the pin
    // that the fix moved the INIT case up to the post-init case rather than
    // moving the post-init case anywhere.
    "control: the identical shape after init was already correct",
    `class HelperBase { constructor() {} }
     class G extends HelperBase {
       eras: any;
       constructor(e: any, t: any) { super(); this.eras = t.filter((x: any) => x.code); }
     }
     class Sub extends G { constructor(e: any, t: any) { super(e, t); } }
     export function test(): number { return new Sub("c", [{ code: 1 }, { code: 2 }, { code: 0 }]).eras.length; }`,
    2,
  ],
  [
    // Init and post-init must AGREE. Base returned 1 — init 0, post-init 1 —
    // i.e. the same expression answered differently depending only on WHEN it
    // ran. That divergence is the whole bug, and it is silent.
    "init and post-init agree on the same expression",
    `const arr = [{ code: "a" }, { code: "b" }];
     const atInit = arr.filter((x) => x.code === "a").length;
     export function test(): number { return atInit * 10 + arr.filter((x) => x.code === "a").length; }`,
    11,
  ],
  [
    // A read-only primitive-returning method on an opaque vec at init — the
    // dispatcher's `_VEC_PRIMITIVE_READ_METHODS` arm, which was gated on the
    // same post-instantiation export set.
    "`indexOf` on an opaque vec receiver at init",
    `function f(t: any): number { return t.indexOf(3); }
     const at = f([1, 2, 3]);
     export function test(): number { return at; }`,
    2,
  ],
];

describe("#5209 — compiled vecs and callbacks during the module-init window", () => {
  for (const [title, source, expected] of rows) {
    for (const lane of ["host", "standalone"] as const) {
      it(`${title} [${lane}]`, async () => {
        expect(await run(source, lane)).toBe(expected);
      });
    }
  }
});
