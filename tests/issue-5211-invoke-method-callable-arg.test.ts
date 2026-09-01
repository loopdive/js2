import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * (#5211) `invokeMethod` — the generic `extern_class` method shim in
 * `src/runtime.ts` — marshalled every WasmGC-struct argument with
 * `_wrapForHost` ALONE. Two things follow from that, and they are NOT the
 * same defect:
 *
 *  1. CAPABILITY. `_wrapForHost` builds a DATA facade; it never builds a
 *     callable. So a compiled CLOSURE handed to a host method crossed with no
 *     `[[Call]]`. The reported case is `n.sort(cmp)` on an `any`-typed
 *     receiver: the first-match ambient binding
 *     (`tryExternClassMethodOnAny`) resolves it to `Uint8ClampedArray_sort`,
 *     `self` is at runtime a real host `Array`, and native
 *     `Array.prototype.sort` rejected the argument with
 *     "The comparison function must be either a function or undefined:
 *     [object Object]".
 *
 *     Unlike the rest of the #5193/#5202/#5203/#5205/#5209 series, this facet
 *     is NOT a module-init-window bug — it reproduces IDENTICALLY before and
 *     after instantiation. The `[init]`/`[post-init]` pairs below are the pin
 *     on that: both rows threw on base.
 *
 *  2. TIMING. The `_wrapForHost` call itself used the strict
 *     `callbackState.getExports()`, which is `undefined` for the whole of the
 *     wasm `start` section in the JS-host lane. A vec argument therefore
 *     reached the host as the generic object proxy (`[object Object]`)
 *     instead of its array facade during init only. `marshalExports` (#5209)
 *     is the marshalling-only view that also sees the `ref.func` helpers the
 *     module registered on itself; `__extern_method_call`'s `wrapHostValue`
 *     already used it, this twin dispatcher did not.
 *
 * Why the direct-arrow rows are controls, not repros: a comparator written
 * inline at the call site usually crosses via `__make_callback` as a REAL JS
 * function, so `hasStructArg` is false and `invokeMethod` never touches it.
 * Those rows passed on base and must keep passing — they are the fast path
 * this fix is required not to disturb.
 *
 * `const _re = /x/;` in each source is load-bearing: it registers the
 * TypedArray extern classes, which is what makes the first-match loop bind
 * `sort` to `Uint8ClampedArray_sort` at all. Without it the call falls to
 * `__extern_method_call`, which has had both fixes since #5209 — i.e. the
 * module compiles to a DIFFERENT dispatcher and the defect is invisible.
 *
 * Base measurement (this branch's parent, 2026-08-30, by reverting only
 * `src/runtime.ts`): 6 of these 15 assertions fail, ALL on the HOST lane —
 * 4 throw the comparison-function TypeError, 2 answer 0 instead of 1. Every
 * other host row and every standalone row already passed.
 *
 * Standalone rows are guards only, and deliberately assert a narrower set:
 * the standalone lane has no JS host, so none of this code runs there. It
 * also does NOT sort at all through this shape (`312` in, `312` out) — a
 * separate, pre-existing defect reported with this issue, NOT fixed here, so
 * the standalone rows below use shapes whose standalone answer is already
 * correct.
 */
type Lane = "host" | "standalone";

async function run(source: string, lane: Lane): Promise<unknown> {
  const result = await compile(source, {
    fileName: "issue-5211.ts",
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => unknown>).test!();
}

/** Registers the TypedArray extern classes — see the header note. */
const RE = "const _re = /x/;\n";

/**
 * The polyfill's shape: `n = t.filter(...)` yields a REAL host array, then
 * `n.sort(cmp)` crosses the comparator through the `extern_class` shim.
 */
const SORT_BODY = (comparator: string) => `function f(t: any): any {
    const n = t.filter((x: any) => x > 0);
    ${comparator}
    return n;
  }`;

const VAR_CMP = "const cmp = (a: any, b: any) => a - b;\n    n.sort(cmp);";
const VAR_CMP_DESC = "const cmp = (a: any, b: any) => b - a;\n    n.sort(cmp);";
const INLINE_CMP = 'n.sort((a: any, b: any) => { if (a > 100) throw new RangeError("no"); return a - b; });';

const atInit = (body: string) => `${RE}${body}
   const out = f([3, 1, 2]);
   export function test(): number { return out[0] * 100 + out[1] * 10 + out[2]; }`;

const afterInit = (body: string) => `${RE}${body}
   export function test(): number { const out = f([3, 1, 2]); return out[0] * 100 + out[1] * 10 + out[2]; }`;

/** [title, source, expected, base-failed-on-host] */
const rows: ReadonlyArray<readonly [string, string, number, boolean]> = [
  // ---- facet 1: capability. Both rows threw on base — timing is not the axis.
  ["comparator held in a variable, sort at module init", atInit(SORT_BODY(VAR_CMP)), 123, true],
  [
    "comparator held in a variable, sort AFTER init (same defect, no init window)",
    afterInit(SORT_BODY(VAR_CMP)),
    123,
    true,
  ],
  [
    "the comparator's ORDERING is honoured, not just its callability (descending)",
    atInit(SORT_BODY(VAR_CMP_DESC)),
    321,
    true,
  ],
  [
    "one comparator variable driving TWO sorts (cached bridge stays callable)",
    atInit(SORT_BODY(`const cmp = (a: any, b: any) => a - b;\n    n.sort(cmp);\n    n.sort(cmp);`)),
    123,
    true,
  ],

  // ---- facet 2: timing. A NON-closure struct argument (a vec) must reach the
  // host as its array facade during init, not as the generic object proxy.
  // `g([1])` is what makes the module register the init-marshal helpers.
  [
    "a vec ARGUMENT stringifies as an array during init, not [object Object]",
    `${RE}function g(t: any): any { return t.filter((x: any) => x > 0); }
     const _warm = g([1]);
     const _match = /^1,2,3$/;
     function f(t: any): boolean { return _match.test(t); }
     const out = f([1, 2, 3]);
     export function test(): number { return out ? 1 : 0; }`,
    1,
    true,
  ],

  // ---- controls: already correct on base, must stay correct. These are the
  // fast path — an inline arrow crosses as a real JS function, so
  // `hasStructArg` is false and the wrapping loop never runs.
  ["control: inline block-body arrow comparator at init (already worked)", atInit(SORT_BODY(INLINE_CMP)), 123, false],
  [
    "control: inline block-body arrow comparator after init (already worked)",
    afterInit(SORT_BODY(INLINE_CMP)),
    123,
    false,
  ],
];

describe("#5211 — invokeMethod callable-wraps compiled closure arguments", () => {
  for (const [title, source, expected] of rows) {
    it(`${title} [host]`, async () => {
      expect(await run(source, "host")).toBe(expected);
    });
  }

  // Standalone guards: no JS host runs at all there, so these pin that the
  // host-side change stayed host-side. Only shapes whose standalone answer is
  // already correct are asserted (see the header note on the standalone
  // dynamic-receiver `.sort` no-op).
  const standaloneGuards: ReadonlyArray<readonly [string, string, number]> = [
    [
      "compiled `.sort` on a statically-typed receiver at init",
      `const arr = [3, 1, 2];
       arr.sort((a, b) => a - b);
       export function test(): number { return arr[0] * 100 + arr[1] * 10 + arr[2]; }`,
      123,
    ],
    [
      "compiled `.sort` on a statically-typed receiver after init",
      `export function test(): number { const arr = [3, 1, 2]; arr.sort((a, b) => a - b); return arr[0] * 100 + arr[1] * 10 + arr[2]; }`,
      123,
    ],
    [
      "a vec argument reaching a host-shaped call site at init",
      `const _match = /^1,2,3$/;
       function g(t: any): any { return t.filter((x: any) => x > 0); }
       const _warm = g([1]);
       function f(t: any): boolean { return _match.test(t); }
       const out = f([1, 2, 3]);
       export function test(): number { return out ? 1 : 0; }`,
      1,
    ],
  ];
  for (const [title, source, expected] of standaloneGuards) {
    for (const lane of ["host", "standalone"] as const) {
      it(`guard: ${title} [${lane}]`, async () => {
        expect(await run(source, lane)).toBe(expected);
      });
    }
  }

  // A SEPARATE defect found while building the rows above, and recorded here as
  // a `known-unfixed` pin with the note "when that defect is fixed this
  // assertion flips and should become `.toBe(123)`". It has been fixed —
  // #5221 pads an omitted extern-class argument with `undefined` rather than
  // `ref.null.extern`, which is what §23.1.3.30 requires (native
  // `Array.prototype.sort` accepts `undefined`, not `null`). Flipped, as the
  // note instructed; the row now guards the fix instead of the defect.
  it("fixed by #5221: `.sort()` with no comparator passes `undefined`, not `null` [host]", async () => {
    expect(await run(atInit(SORT_BODY("n.sort();")), "host")).toBe(123);
  });
});

/**
 * The DOM-lane control the issue asks for. `invokeMethod` is that lane's hot
 * path, and this fix adds work only inside the `hasStructArg` branch — which
 * the DOM crossings never enter, because their arguments are strings and host
 * element handles, not WasmGC structs. This exercises exactly the
 * `dom/create-elements` + `dom/set-attributes` benchmark shapes and asserts
 * the mock's recorded state, so a behaviour change (dropped argument, wrong
 * facade, wrong receiver) would show up as a wrong recording rather than as a
 * throw.
 */
describe("#5211 — DOM-lane control: extern_class crossings with non-struct arguments", () => {
  it("createElement / setAttribute / appendChild record the same values as before", async () => {
    type MockEl = {
      tagName: string;
      attributes: Record<string, string>;
      children: MockEl[];
      setAttribute(name: string, value: string): void;
      getAttribute(name: string): string | null;
      appendChild(child: MockEl): MockEl;
    };
    const makeEl = (tag: string): MockEl => ({
      tagName: tag,
      attributes: {},
      children: [],
      setAttribute(name, value) {
        this.attributes[name] = value;
      },
      getAttribute(name) {
        return this.attributes[name] ?? null;
      },
      appendChild(child) {
        this.children.push(child);
        return child;
      },
    });
    const root = makeEl("div");
    const doc = { createElement: (tag: string) => makeEl(tag), body: root };

    const result = await compile(
      `export function test(): number {
         const parent = document.createElement("section");
         let n = 0;
         for (let i = 0; i < 3; i++) {
           const child = document.createElement("span");
           child.setAttribute("data-i", "v" + i);
           child.setAttribute("class", "row");
           parent.appendChild(child);
           if (child.getAttribute("data-i") === "v" + i) n = n + 1;
         }
         document.body.appendChild(parent);
         return n;
       }`,
      { fileName: "issue-5211-dom.ts" },
    );
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);

    const imports = buildImports(result.imports, { document: doc }, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
    imports.setInstance?.(instance);

    expect((instance.exports as { test: () => number }).test()).toBe(3);
    expect(root.children).toHaveLength(1);
    const section = root.children[0]!;
    expect(section.tagName).toBe("section");
    expect(section.children).toHaveLength(3);
    expect(section.children.map((c) => c.attributes["data-i"])).toEqual(["v0", "v1", "v2"]);
    expect(section.children.map((c) => c.attributes.class)).toEqual(["row", "row", "row"]);
  });
});
