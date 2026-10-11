// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6963) Standalone `x[i] = v` on an untyped array receiver used to
// stringify the index (`__to_property_key` → `number_toString`) and then, in
// the `__extern_set` overlay WRITE prologue, define the element through
// `__vec_dp_value` — a full defineProperty that created a companion `$Object`
// entry per array and set the module-wide "numeric companion" flag, after
// which EVERY indexed read paid a companion-table scan plus a string-keyed
// hash lookup (Octane navier-stokes: ~250x slower than node).
//
// The fix keeps a non-negative small-int key numeric for a JS-array carrier
// (`__elem_store_key`) and lets the overlay prologue hand a plain overwrite of
// an existing backed element straight to the numeric vec arm. Semantics are
// unchanged; these rows pin them (each expected value is node's answer) and
// the structural rows pin the new route.
import { describe, expect, it } from "vitest";

import { tryNativeExnRender } from "../scripts/lib/wasm-exn-render.mjs";
import { compile } from "../src/index.js";

const OPTS = {
  fileName: "probe.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
  target: "standalone" as const,
  inferModuleStrictArguments: false,
  runtimeEvalProvider: false as const,
};

async function runMain(body: string, emitWat = false): Promise<{ value: string; wat: string }> {
  const source = `
    function set(a, k, v) { try { a[k] = v; } catch (e) { return "T"; } return a[k]; }
    function inc(a, k) { a[k] += 1; return a[k]; }
    function pp(a, k) { a[k]++; return a[k]; }
    function get(a, k) { return a[k]; }
    // Mixed receivers keep the helpers' params genuinely untyped (externref),
    // the Octane shape: a param only ever fed one array literal is inferred
    // as that typed array and never reaches the dynamic store path. The
    // defineProperty makes the module build the descriptor overlay, whose
    // WRITE prologue is the path #6963 changes (navier-stokes has it too).
    function untype() {
      set({}, "z", 0); inc({ z: 1 }, "z"); pp({ z: 1 }, "z"); get({}, "z");
      Object.defineProperty([], "q", { value: 1 });
    }
    export function main() { untype(); ${body} }
  `;
  const result = await compile(source, emitWat ? { ...OPTS, emitWat: true } : OPTS);
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const instance = await WebAssembly.instantiate(mod, {});
  const raw = (instance.exports as { main: () => unknown }).main();
  // A native string result is rendered through the module's own exports.
  const value =
    raw !== null && typeof raw === "object" ? (tryNativeExnRender(instance, raw) ?? "[wasm-object]") : String(raw);
  return { value, wat: result.wat ?? "" };
}

describe("#6963 standalone dynamic element store keeps numeric keys numeric", () => {
  const rows: [string, string, string][] = [
    [
      "hole fill of new Array(n)",
      "var h = new Array(4); for (var i = 0; i < 4; i++) set(h, i, i * 2); return h.join(',');",
      "0,2,4,6",
    ],
    [
      "mixed values into a [] + push array",
      "var b = []; for (var j = 0; j < 3; j++) b.push(0); set(b, 1, 's'); set(b, 2, 2.5); return get(b, 1) + '|' + get(b, 2) + '|' + b.length;",
      "s|2.5|3",
    ],
    [
      "kind-incompatible value into a number array keeps the value",
      "var nums = [1, 2, 3]; set(nums, 0, 'str'); return typeof get(nums, 0) + ':' + get(nums, 0);",
      "string:str",
    ],
    [
      "out-of-bounds store grows (not a hole fill)",
      "var g = [1, 2, 3]; set(g, 5, 8); return g.length + '|' + g[5] + '|' + (4 in g);",
      "6|8|false",
    ],
    ["frozen array refuses", "var fr = Object.freeze([1, 2]); set(fr, 0, 5); return fr[0];", "1"],
    [
      "non-writable defined element refuses, neighbour stores",
      "var nw = [1, 2, 3]; Object.defineProperty(nw, '1', { value: 20, writable: false }); set(nw, 1, 99); set(nw, 2, 30); return nw.join(',');",
      "1,20,30",
    ],
    [
      "accessor element invokes its setter",
      "var acc = [1, 2, 3]; var seen = 0; Object.defineProperty(acc, '0', { get: function () { return 42; }, set: function (v) { seen = v; } }); set(acc, 0, 11); set(acc, 2, 12); return acc[0] + '|' + seen + '|' + acc[2];",
      "42|11|12",
    ],
    ["compound and update stores", "var c = [1, 2, 3]; inc(c, 0); pp(c, 2); return c.join(',');", "2,2,4"],
    [
      "plain object receiver keeps string keys",
      "var o = {}; set(o, 1, 'one'); set(o, '2', 'two'); return o['1'] + '|' + o[2] + '|' + Object.keys(o).join(',');",
      "one|two|1,2",
    ],
    [
      "deleted index is recreated",
      "var d = [1, 2, 3]; delete d[1]; set(d, 1, 5); return d.join(',') + '|' + Object.keys(d).join(',');",
      "1,5,3|0,1,2",
    ],
    [
      "created element has an all-true descriptor (#2668)",
      "var desc = []; set(desc, 0, 101); var dd = Object.getOwnPropertyDescriptor(desc, '0'); return dd.value + '' + dd.writable + dd.enumerable + dd.configurable;",
      "101truetruetrue",
    ],
    [
      "overwritten element keeps an all-true descriptor",
      "var w = [1, 2]; set(w, 1, 7); var wd = Object.getOwnPropertyDescriptor(w, '1'); return wd.value + '' + wd.writable + wd.enumerable + wd.configurable;",
      "7truetruetrue",
    ],
    [
      "non-extensible array still overwrites an existing element",
      "var ne = [1, 2, 3]; Object.preventExtensions(ne); set(ne, 0, 9); return ne.join(',') + '|' + ne.length;",
      "9,2,3|3",
    ],
    [
      "untyped-param hot loop round-trips",
      "var x = new Array(64); var x0 = new Array(64); for (var i = 0; i < 64; i++) { x[i] = 0; x0[i] = i; } var s = 0; for (var k = 0; k < 640; k++) { var j = k & 63; set(x, j, x0[j] + 1.5); s += x[j]; } return s;",
      "21120",
    ],
  ];
  for (const [name, body, expected] of rows) {
    it(name, async () => {
      expect((await runMain(body)).value).toBe(expected);
    });
  }

  it("routes the store key through the __elem_store_key canonicaliser", async () => {
    // The helper may be inlined into the store site (and calls print by
    // index), so pin the canonicaliser's scratch local plus the helper itself.
    const { wat } = await runMain("var a = [1, 2]; set(a, 0, 3); return a[0];", true);
    const setFn = wat.match(/\(func \$set [\s\S]*?\n {2}\(func /)?.[0] ?? "";
    expect(setFn, "set() missing from the WAT").not.toBe("");
    expect(setFn).toMatch(/\(local \$__elem_key_\d+ externref\)/);
    expect(wat).toContain("(func $__elem_store_key ");
  });

  it("negative control: a non-integer key is still canonicalised to a string", async () => {
    const { value } = await runMain("var o = {}; set(o, 1.5, 'x'); return Object.keys(o).join(',') + '|' + o['1.5'];");
    expect(value).toBe("1.5|x");
  });
});
