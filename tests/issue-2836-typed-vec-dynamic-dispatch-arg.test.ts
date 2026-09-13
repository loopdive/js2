// #2836 — a typed nominal-struct vec ($__vec_ref_*) lost its OBJECT elements when
// passed as an `any` argument through an indirect / dynamic-dispatch call.
//
// Root cause (host shim, NOT codegen): when a wasm vec is coerced `(ref $vec) →
// externref` for a generic call, the JS host import `__make_iterable`'s
// `convertToJS` recursively materializes the vec into a JS array and, per
// element, RECURSES. It gated the vec-conversion branch on `__vec_len(obj) >= 0`
// — but `__vec_len` returns its not-a-vec default `0` for ANY non-vec struct, so
// an object element (e.g. an acorn `Node`) was mis-detected as an empty vec and
// flattened to `new Array(0)`, erasing its fields. Scalars (number/string)
// survived because they are not wasm structs. A STATIC direct call passes the vec
// raw (no `__make_iterable`), which is why only the dynamic path failed.
//
// This was the acorn-dogfood round-3 wall: `this.parseArrowExpression(node, [id],
// …)` is a dynamic method dispatch, so the `[id]` params array lost its
// Identifier element → `toAssignable` saw an empty Array → acorn raised its own
// `SyntaxError "Assigning to rvalue"`. Every arrow with ≥1 param threw.
//
// Fix (#2836): gate the vec-conversion branch on the POSITIVE `__is_vec`
// discriminator (a `ref.test $__vec_base`) in BOTH host-shim sites —
// `__make_iterable`'s `convertToJS` and `_convertIterableForHost`. Non-vec
// structs now stay opaque and their fields read correctly. No copy, no new
// container ⇒ no identity/mutation change. Host-only: standalone keeps the native
// WasmGC vec path (unaffected).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "probe.ts" });
  expect(result.success).toBe(true);
  const io: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, io);
  io.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2836 — typed-struct vec keeps its object elements across a dynamic-dispatch `any` arg", () => {
  it("object-literal method dispatch: array-of-object element fields read correctly", async () => {
    const exp = await run(`
      // @ts-nocheck
      function mkId(){ var n = {}; n.type = "Identifier"; n.name = "x"; return n; }
      function consume(node, params, flag){ return params[0].type; }
      export function probe(){ var o = { c: consume }; return o.c({}, [mkId()], false); }
    `);
    expect(exp.probe()).toBe("Identifier");
  });

  it("indirect call through an `any`-typed function value preserves the element", async () => {
    const exp = await run(`
      // @ts-nocheck
      function mkId(){ var n = {}; n.type = "Identifier"; return n; }
      function consume(node, params, flag){ return params[0].type; }
      export function probe(){ var fn = consume; return fn({}, [mkId()], false); }
    `);
    expect(exp.probe()).toBe("Identifier");
  });

  it("iterating the array inside the dynamic callee (acorn toAssignableList shape) reads fields", async () => {
    const exp = await run(`
      // @ts-nocheck
      function mkId(){ var n = {}; n.type = "Identifier"; return n; }
      function consume(node, params, flag){
        for (var i = 0; i < params.length; i++){ var elt = params[i]; if (elt) return elt.type; }
        return "EMPTY";
      }
      export function probe(){ var o = { c: consume }; return o.c({}, [mkId()], false); }
    `);
    expect(exp.probe()).toBe("Identifier");
  });

  it("scalar-element arrays still round-trip through dynamic dispatch (no regression)", async () => {
    const exp = await run(`
      // @ts-nocheck
      function consume(node, params, flag){ return params.length * 100 + params[0]; }
      export function probe(){ var o = { c: consume }; return o.c({}, [7], false); }
    `);
    expect(exp.probe()).toBe(107);
  });

  it("string-element arrays still round-trip through dynamic dispatch (no regression)", async () => {
    const exp = await run(`
      // @ts-nocheck
      function consume(node, params, flag){ return params[0]; }
      export function probe(){ var o = { c: consume }; return o.c({}, ["hello"], false); }
    `);
    expect(exp.probe()).toBe("hello");
  });

  it("genuine empty vec still converts to an empty array (is-vec stays true)", async () => {
    const exp = await run(`
      // @ts-nocheck
      function consume(node, params, flag){ return params.length; }
      export function probe(){ var o = { c: consume }; var a = []; return o.c({}, a, false); }
    `);
    expect(exp.probe()).toBe(0);
  });
});
