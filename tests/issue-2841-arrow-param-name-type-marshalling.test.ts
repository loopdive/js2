// #2841 — arrow / function-expression parameter Identifier nodes lost their
// `name` and `type` on HOST readback (compiled acorn's parsed AST did not match
// node-acorn for `(reason) => …` / `function (reason) {}`).
//
// Root cause (host marshalling, NOT codegen, NOT value-rep): #2836 fixed the
// IN-WASM read of an arrow param list by keeping object elements opaque across
// the dynamic-dispatch `any` boundary — but that boundary's host shim
// (`__make_iterable`) materialises the wasm vec into a REAL host JS array of
// opaque wasm structs. When such an array is then read back as a struct field
// through the `_wrapForHost` proxy (acorn's `node.params`), the proxy returned
// the JS array RAW, so its Identifier elements stayed unwrapped wasm structs and
// `param.type` / `param.name` read back `undefined`. Declaration / function-
// expression params take the `parseBindingList` path and stay a genuine wasm vec
// (routed to `_wrapVecForHost`, which wraps elements), so ONLY arrow params and
// any other field that arrives as a host JS array of structs were affected.
//
// Fix (#2841): in the `_wrapForHost` proxy `get` (and symmetrically in
// `_wasmToPlain` for the marshal:"copy" / JSON paths), when the resolved field
// value is a real host JS array, present a view whose struct elements are
// `_wrapForHost`-wrapped on access. Genuine wasm vecs are unaffected (they are
// not `Array.isArray`). Host-only marshalling; standalone is unchanged.
//
// Verified end-to-end by the real-world native-messaging differential: compiled
// acorn vs node-acorn on `background.js` went from 2 non-quirk divergences
// (`params[0].type`, `params[0].name`) to ZERO.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "probe.ts" });
  expect(result.success).toBe(true);
  const io: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, io);
  io.__setExports?.(instance.exports);
  io.__setInstance?.(instance);
  // (#6438) Establish the data-struct authority: without it the raw-exports
  // overload cannot decode a returned struct and now refuses instead of
  // answering `{}` (every assertion below read `{}` on main).
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2841 — host readback of an array-of-struct field built across a dynamic-dispatch boundary", () => {
  // The `node.params = params` assignment where `params` crossed an indirect
  // call (mirrors acorn `parseArrowExpression(node, exprList)`): `params`
  // reaches the host as a JS array of opaque structs. The host must read each
  // element's fields.
  it("host reads .type / .name of array elements stored via a dynamic-dispatch param list", async () => {
    const exp = await run(`
      // @ts-nocheck
      function mkId(name){ var n = {}; n.type = "Identifier"; n.name = name; return n; }
      function buildNode(params){ var node = {}; node.type = "ArrowFunctionExpression"; node.params = params; return node; }
      export function probe(){ var f = buildNode; return f([mkId("reason")]); }
    `);
    const node = exp.probe();
    expect(Array.isArray(node.params)).toBe(true);
    expect(node.params.length).toBe(1);
    expect(node.params[0].type).toBe("Identifier");
    expect(node.params[0].name).toBe("reason");
  });

  it("multiple elements all read back their fields", async () => {
    const exp = await run(`
      // @ts-nocheck
      function mkId(name){ var n = {}; n.type = "Identifier"; n.name = name; return n; }
      function buildNode(params){ var node = {}; node.params = params; return node; }
      export function probe(){ var f = buildNode; return f([mkId("a"), mkId("b")]); }
    `);
    const node = exp.probe();
    expect(node.params.map((p: any) => p.name)).toEqual(["a", "b"]);
    expect(node.params.map((p: any) => p.type)).toEqual(["Identifier", "Identifier"]);
  });

  it("iteration / spread over the wrapped array also sees element fields", async () => {
    const exp = await run(`
      // @ts-nocheck
      function mkId(name){ var n = {}; n.type = "Identifier"; n.name = name; return n; }
      function buildNode(params){ var node = {}; node.params = params; return node; }
      export function probe(){ var f = buildNode; return f([mkId("x")]); }
    `);
    const node = exp.probe();
    const names = [...node.params].map((p: any) => p.name);
    expect(names).toEqual(["x"]);
  });

  it("scalar-element arrays still round-trip unchanged (no over-wrapping regression)", async () => {
    const exp = await run(`
      // @ts-nocheck
      function buildNode(xs){ var node = {}; node.xs = xs; return node; }
      export function probe(){ var f = buildNode; return f([1, 2, 3]); }
    `);
    const node = exp.probe();
    expect([...node.xs]).toEqual([1, 2, 3]);
  });
});
