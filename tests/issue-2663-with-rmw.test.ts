// #2663 Slice 3 — read-modify-write through a `with` scope.
//
// Compound assignment (`x += v`) and update expressions (`++x` / `x--`) did not
// consult `fctx.withScopes` at all before this slice: `with (o) { x /= 3 }` read
// AND wrote the outer `x`, so both the with-object property and the outer
// binding ended up wrong.
//
// §13.15.2 / §13.4 evaluate the LHS to a Reference ONCE and then GetValue and
// PutValue on THAT reference. For an Object Environment Record the base is
// decided by HasBinding (§9.1.1.2.1), so the decision is captured before the
// read and reused for the write — the `get x() { delete this.x; … }` shape of
// the `S11.13.2_A5.*` / `S11.4.4_A5_*` / `S11.3.1_A5_*` test262 family exists
// precisely to catch a compiler that re-decides at the write.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(body: string, target?: "standalone"): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    ...(target ? { target } : {}),
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2663 Slice 3 — compound assignment through `with`", () => {
  it("writes the with-object property, not the outer binding (dynamic target)", async () => {
    // S11.13.2_A5.2_T1 shape: the getter deletes the property mid-read, so the
    // write must still land on the object (the Reference was already resolved).
    const exp = await run(
      `var x = 0;
       var scope = { get x() { delete this.x; return 6; } };
       with (scope) { x /= 3; }
       return scope.x * 100 + x;`,
    );
    expect(exp.test()).toBe(200); // scope.x === 2, x === 0
  });

  it("same, on the standalone lane", async () => {
    const exp = await run(
      `var x = 0;
       var scope = { get x() { delete this.x; return 2; } };
       with (scope) { x *= 3; }
       return scope.x * 100 + x;`,
      "standalone",
    );
    expect(exp.test()).toBe(600); // scope.x === 6, x === 0
  });

  it("routes through a Tier-1 static (closed-shape) with scope too", async () => {
    const exp = await run(`var x = 0; var o = { x: 6 }; with (o) { x /= 3; } return o.x * 100 + x;`);
    expect(exp.test()).toBe(200); // o.x === 2, x === 0
  });

  it("falls through to the outer binding when the object does NOT bind the name", async () => {
    const exp = await run(`var x = 6; var o = { y: 1 }; with (o) { x /= 3; } return x;`);
    expect(exp.test()).toBe(2);
  });

  it("a body-declared lexical shadows the with object", async () => {
    const exp = await run(`var o = { x: 99 }; var r = 0; with (o) { let x = 6; x /= 3; r = x; } return o.x * 100 + r;`);
    expect(exp.test()).toBe(9902); // o.x untouched, the let is updated
  });

  // NOT asserted: nested with over two STATIC (Tier-1 closed-struct) scopes that
  // share a name — `with (a) { with (b) { x *= 3 } }` picks the wrong scope. That
  // is a pre-existing #2663 Slice-1 defect independent of read-modify-write; the
  // sibling test "nested with: inner object shadows the outer for a shared name"
  // in tests/issue-2663.test.ts already fails on main for the plain READ. Adding
  // an assertion here would only duplicate that red. Mixed static/dynamic nesting
  // (a static outer with a dynamic inner) is exercised by the test262
  // `S11.13.2_A5.*_T3` family.

  it("`+=` stays string-or-numeric (§13.15.3), not numeric-only", async () => {
    const exp = await run(`var o = { s: "a" }; var r = ""; with (o) { s += "b"; r = s; } return r;`);
    expect(exp.test()).toBe("ab");
  });
});

describe("#2663 Slice 3 — update expressions through `with`", () => {
  it("x++ returns the old value and writes the with-object", async () => {
    const exp = await run(
      `var x = 0; var o = { x: 6 }; var r = 0; with (o) { r = x++; } return o.x * 1000 + r * 10 + x;`,
    );
    expect(exp.test()).toBe(7060); // o.x === 7, r === 6, x === 0
  });

  it("++x returns the new value", async () => {
    const exp = await run(
      `var x = 0; var o = { x: 6 }; var r = 0; with (o) { r = ++x; } return o.x * 1000 + r * 10 + x;`,
    );
    expect(exp.test()).toBe(7070);
  });

  it("x-- and --x write the with-object", async () => {
    const exp = await run(`var o = { x: 6 }; with (o) { x--; } return o.x;`);
    expect(exp.test()).toBe(5);
    const exp2 = await run(`var o = { x: 6 }; var r = 0; with (o) { r = --x; } return o.x * 10 + r;`);
    expect(exp2.test()).toBe(55);
  });

  it("falls through to the outer binding when the object does not bind the name", async () => {
    const exp = await run(`var x = 6; var o = { y: 1 }; with (o) { x++; } return x;`);
    expect(exp.test()).toBe(7);
  });
});
