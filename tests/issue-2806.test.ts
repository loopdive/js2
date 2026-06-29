// #2806 — a `var x = (void 0)` binding must not drop a later REFERENCE write.
//
// Root cause (corrected from the issue's original "untyped [] → f64 vec"
// framing): acorn's `parseExprList` does
//
//   var elt = (void 0);                 // `void 0` pins the TS type to `undefined`
//   elt = this.parseMaybeAssign(...);    // a node REFERENCE
//   elts.push(elt);
//   return elts;
//
// Unlike `var x = undefined` / `var x = null` / `var x;` (which TS treats as
// evolving-any → externref), the `void 0` EXPRESSION pins `elt` to type
// `undefined`. `resolveWasmType(undefined)` is a numeric (i32) slot, so the
// `undefined` type dropped the reference at three sites: the local slot, the
// array element-kind inference, and the function RETURN type. Each coerced the
// pushed node reference to i32 `0` — so compiled-acorn `parse(...).arguments`
// came back as `[0, 0]` instead of two `Identifier` nodes (the #2801 blocker).
//
// Fix: a `void`-expression initializer (or any purely `undefined`/`void` type)
// is treated as externref — the same slot `= undefined` already gets — at the
// var hoister, the let/const declaration path, `inferArrayVecType`, and the
// `resolveWasmType` Array branch.
//
// These tests compile plain-JS source with `skipSemanticDiagnostics: true`
// (the acorn dogfood compile mode) and round-trip values through the host
// proxy via `wrapExports` to assert the reference survives.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "mod.mjs", skipSemanticDiagnostics: true });
  expect(result.success).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2806 — `var x = (void 0)` must not drop later reference writes", () => {
  it("pushes a node reference through a void-0 intermediate into an untyped array (the acorn arguments pattern)", async () => {
    const exp = await run(`
      function makeId(n) { var id = {}; id.type = "Identifier"; id.name = n; return id; }
      export function parseExprList() {
        var elts = [];
        var elt = (void 0);
        elt = makeId("bar");
        elts.push(elt);
        elt = makeId("baz");
        elts.push(elt);
        return elts;
      }
    `);
    const args = exp.parseExprList();
    expect(Array.isArray(args)).toBe(true);
    expect(args.length).toBe(2);
    // The decisive assertion: elements are the pushed Identifier objects, NOT `0`.
    expect(typeof args[0]).toBe("object");
    expect(args[0].type).toBe("Identifier");
    expect(args[0].name).toBe("bar");
    expect(args[1].type).toBe("Identifier");
    expect(args[1].name).toBe("baz");
  });

  it("preserves the reference for a conditionally-assigned void-0 local", async () => {
    const exp = await run(`
      function makeId(n) { var id = {}; id.type = "Identifier"; id.name = n; return id; }
      export function build() {
        var elts = [];
        for (var i = 0; i < 1; i++) {
          var elt = (void 0);
          elt = makeId("x");
          elts.push(elt);
        }
        return elts;
      }
    `);
    const a = exp.build();
    expect(a.length).toBe(1);
    expect(a[0].type).toBe("Identifier");
    expect(a[0].name).toBe("x");
  });

  it("PRESERVES the all-numeric fast path — an untyped array of numbers stays numeric", async () => {
    // The fix must NOT widen genuinely-numeric arrays. `var a = []; a.push(1)`
    // must keep round-tripping numbers (and use the f64/i32 vec backing).
    const exp = await run(`
      export function nums() {
        var a = [];
        for (var i = 0; i < 4; i++) a.push(i * 2);
        return a;
      }
    `);
    const a = exp.nums();
    expect(a.length).toBe(4);
    expect(a[0]).toBe(0);
    expect(a[1]).toBe(2);
    expect(a[2]).toBe(4);
    expect(a[3]).toBe(6);
  });

  it("PRESERVES a numeric accumulator threaded through a void-0 local", async () => {
    // The pushed value is a real number (not a reference) — the array must
    // stay numeric and read back the numbers, not box them away.
    const exp = await run(`
      export function sums() {
        var out = [];
        var v = (void 0);
        v = 10;
        out.push(v);
        v = 20;
        out.push(v);
        return out;
      }
    `);
    const a = exp.sums();
    expect(a.length).toBe(2);
    expect(a[0]).toBe(10);
    expect(a[1]).toBe(20);
  });

  it("round-trips an arguments array (built via a void-0 push) stored on an object field (the acorn CallExpression shape)", async () => {
    // acorn's `node.arguments = this.parseExprList(...)` — the array of node
    // refs is assigned to a dynamic object field, then read back by the host.
    const exp = await run(`
      function makeId(n) { var id = {}; id.type = "Identifier"; id.name = n; return id; }
      export function build() {
        var node = {};
        node.type = "CallExpression";
        var elts = [];
        var elt = (void 0);
        elt = makeId("bar");
        elts.push(elt);
        elt = makeId("baz");
        elts.push(elt);
        node.arguments = elts;
        return node;
      }
    `);
    const node = exp.build();
    expect(node.type).toBe("CallExpression");
    expect(Array.isArray(node.arguments)).toBe(true);
    expect(node.arguments.length).toBe(2);
    expect(node.arguments[0].type).toBe("Identifier");
    expect(node.arguments[0].name).toBe("bar");
    expect(node.arguments[1].name).toBe("baz");
  });
});
