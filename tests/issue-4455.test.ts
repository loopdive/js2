// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4455) `Object.getOwnPropertyDescriptor(C.prototype, "m")` for an ACCESSOR
// member of a standalone class prototype.
//
// #3976 slice 1 made `C.prototype` a real `$Object` and installed instance
// METHODS on it, so every reflective native answers through the ordinary
// `$Object` path. Accessors were deliberately left out, and the gap was
// measurable on this branch's base with `--target standalone` (`.tmp/run-one.mts`,
// the real `runTest262File`):
//
//   | `class C { m() {} set s(v) {} }`      | base        | spec                  |
//   | ------------------------------------- | ----------- | --------------------- |
//   | `gOPD(C.prototype,"m").value`         | function    | function              |
//   | `gOPD(C.prototype,"s")`               | **undefined** | accessor descriptor |
//
// while the SAME shape written as an object literal already answered a full
// accessor descriptor — the asymmetry this closes.
//
// The tests assert the accessor SHAPE (a `get`/`set` pair, not a `value`),
// because the wrong fix here is not "absent" but "present as a data property
// holding the getter function": that would satisfy a presence check, break
// `c.x` (handing back the function instead of calling it), and be strictly
// worse than the pre-#4455 absence. Each descriptor assertion is therefore
// paired with a LIVE invocation through the member itself.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `body` as the `test()` export and run it host-free. */
async function runStandalone(body: string, decls = ""): Promise<number> {
  const source = `${decls}\nexport function test(): number { ${body} }`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4455.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  // Host-free: a standalone module must instantiate against an empty import
  // object. If this ever needs a host bridge, the arms leaked an import.
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#4455 — a class-prototype accessor is a real accessor property", () => {
  it("answers an accessor descriptor for a setter-only member (the R1 blocker)", async () => {
    // The exact shape of `language/{statements,expressions}/class/setter-length-dflt.js`:
    // an accessor-ONLY class, whose prototype kept the legacy defaulted struct
    // before this change, so `gOPD` answered `undefined` and the test died
    // dereferencing it.
    expect(
      await runStandalone(
        `const d: any = Object.getOwnPropertyDescriptor((C as any).prototype, "m");
         if (d === undefined) return -1;
         if (typeof d.set !== "function") return -2;
         if (d.get !== undefined) return -3;
         return 1;`,
        `class C { private v = 0; set m(x: number) { this.v = x; } }`,
      ),
    ).toBe(1);
  });

  it("carries §15.7.14 attributes: enumerable false, configurable true", async () => {
    expect(
      await runStandalone(
        `const d: any = Object.getOwnPropertyDescriptor((C as any).prototype, "x");
         if (d === undefined) return -1;
         if (d.enumerable !== false) return -2;
         if (d.configurable !== true) return -3;
         // An accessor descriptor has NO writable/value fields (§6.2.6.1).
         if (d.value !== undefined) return -4;
         return 1;`,
        `class C { get x(): number { return 7; } }`,
      ),
    ).toBe(1);
  });

  it("keeps the getter LIVE — the descriptor half and the member read agree", async () => {
    // The failure this guards is installing the accessor as a data property:
    // `d.get` would be absent and `c.x` would answer the function object rather
    // than 7. Both surfaces are checked in one module so they cannot drift.
    expect(
      await runStandalone(
        `const c = new C();
         if (c.x !== 7) return -1;
         const d: any = Object.getOwnPropertyDescriptor((C as any).prototype, "x");
         if (typeof d.get !== "function") return -2;
         if (d.set !== undefined) return -3;
         return 1;`,
        `class C { get x(): number { return 7; } }`,
      ),
    ).toBe(1);
  });

  it("round-trips a get/set PAIR through the prototype descriptor", async () => {
    expect(
      await runStandalone(
        `const c = new C();
         c.x = 41;
         if (c.x !== 41) return -1;
         const d: any = Object.getOwnPropertyDescriptor((C as any).prototype, "x");
         if (typeof d.get !== "function") return -2;
         if (typeof d.set !== "function") return -3;
         return 1;`,
        `class C { private v = 0; get x(): number { return this.v; } set x(n: number) { this.v = n; } }`,
      ),
    ).toBe(1);
  });

  it("does not disturb the METHOD arm when a class mixes both", async () => {
    // #3976's data-property install must keep answering `value`, not be
    // rewritten into an accessor by the new arm.
    expect(
      await runStandalone(
        `const dm: any = Object.getOwnPropertyDescriptor((C as any).prototype, "m");
         const dx: any = Object.getOwnPropertyDescriptor((C as any).prototype, "x");
         if (typeof dm.value !== "function") return -1;
         if (dm.get !== undefined) return -2;
         if (typeof dx.get !== "function") return -3;
         if (dx.value !== undefined) return -4;
         return 1;`,
        `class C { m(): number { return 1; } get x(): number { return 2; } }`,
      ),
    ).toBe(1);
  });

  it("gives the accessor halves the #4440 function metadata the length-dflt files assert", async () => {
    // `setter-length-dflt.js` reads `gOPD(C.prototype,"m").set` and then
    // `verifyProperty(set, "length", { value: 0, … })`. §15.1.5 counts
    // parameters BEFORE the first initializer, so a defaulted-only setter is 0
    // — not the declared formal count of 1.
    expect(
      await runStandalone(
        `const d: any = Object.getOwnPropertyDescriptor((C as any).prototype, "m");
         const set: any = d.set;
         if (set.length !== 0) return -1;
         const ld: any = Object.getOwnPropertyDescriptor(set, "length");
         if (ld === undefined) return -2;
         if (ld.writable !== false) return -3;
         if (ld.enumerable !== false) return -4;
         if (ld.configurable !== true) return -5;
         return 1;`,
        `class C { private v = 0; set m(x: number = 42) { this.v = x; } }`,
      ),
    ).toBe(1);
  });

  it("leaves a STATIC accessor off the prototype (it belongs to the class object)", async () => {
    expect(
      await runStandalone(
        `const d: any = Object.getOwnPropertyDescriptor((C as any).prototype, "x");
         return d === undefined ? 1 : -1;`,
        `class C { static get x(): number { return 1; } }`,
      ),
    ).toBe(1);
  });
});
