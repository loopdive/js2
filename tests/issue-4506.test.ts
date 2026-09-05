// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4506) `new F()` instances as `$Object`s — the SLOT half.
//
// #2660 S3a already emits an escape-gate-approved, empty-body, no-arg
// `new F()` under `--target standalone` as `__object_create(F.prototype)`, i.e.
// a real `$Object` on the ONE `$Object.$proto` walk. Measured on this branch's
// base (`d0ae8a947`, 405 ES≤5 test262 files that construct a user function,
// gate instrumented, runs executed for this issue):
//
//   | outcome for a `new F()` site (629 sites / 391 files) |   n |
//   | ---------------------------------------------------- | --: |
//   | escape gate classifies `reconstruct`                  | 579 |
//   | of those, the S3a lowering FIRES                      | 464 |
//   | of those, it declines ONLY because the binding's slot |     |
//   | is not externref                                      |  97 |
//   | `keep-typed` (the #1888 typed own-field hot path)     |  11 |
//
// So the representation change was gated on a SLOT, not on analysis or
// emission. This suite pins both halves of the fix:
//
//   S1 — a module-scope `var x = new F()` whose site the lowering converts gets
//        an externref slot, so the conversion can actually happen, and the
//        per-fnctor constructor CACHE can no longer strand a later approved
//        site on the struct (that miss was harmless while every slot was
//        struct-typed and would be a WRONG answer once one is not).
//   S2 — `<any>.isPrototypeOf(inst)` and `<key> in inst` are DYNAMIC consumers
//        in the escape gate's classification. Both are [[Prototype]]-chain
//        walks over the instance — the exact consumer the reconstruction
//        exists to serve — and both were classified `neutral`, so a fnctor
//        whose only dynamic use was the walk stayed a bespoke struct and the
//        walk answered `false`.
//
// Every case below is a MODULE-scope program compiled with
// `deferTopLevelInit`, because that is the shape the failing test262 rows have
// and the shape whose slot the fix widens; the same code inside a function body
// exercises a different (function-local) slot typer, which this slice
// deliberately does not touch — see the `it.fails` residuals at the end.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * Compile `pre` at MODULE scope plus `return <expr>` as the `test()` export and
 * run it host-free. `deferTopLevelInit` puts the module body in
 * `__module_init`, which the runner calls first — the test262 script shape.
 */
async function runModule(pre: string, expr: string): Promise<number> {
  const source = `${pre}\nexport function test() { return ${expr}; }`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4506.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  // Host-free: a standalone module must instantiate against an empty import
  // object. If this ever needs a bridge, an arm leaked a host import.
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, () => number>;
  if (typeof exports.__module_init === "function") exports.__module_init();
  return exports.test!();
}

describe("#4506 S1 — the binding slot lets the reconstruction happen", () => {
  it("reads an inherited property through an instance that was also written to", async () => {
    // `language/types/object/S8.6.2_A2` CHECK#1, reduced. The WRITE is what
    // made this fail: an out-of-constructor `foo.prop = …` grows a
    // presence-tracked flow field on `$__fnctor_FooObj` (#3927), and the pinned
    // struct read of that never-set slot answered `undefined` instead of
    // walking to the prototype. As an `$Object` the write and the read are the
    // same dynamic property, and the miss walks the chain.
    expect(
      await runModule(
        `function FooObj(){}
         FooObj.prototype.prop = "some";
         var foo = new FooObj;
         var c1 = (foo.prop === "some") ? 1 : 0;
         foo.prop = true;`,
        `c1`,
      ),
    ).toBe(1);
  });

  it("keeps a second instance minted after the first is written unaffected", async () => {
    // CHECK#2 of the same row — §8.6.2's actual point: get access sees the
    // prototype, put access does not write through it.
    expect(
      await runModule(
        `function FooObj(){}
         FooObj.prototype.prop = "some";
         var foo = new FooObj;
         foo.prop = true;
         var foo__ = new FooObj;`,
        `(foo__.prop === "some") ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it("does NOT let a put on the instance write through to the prototype", async () => {
    // The negative half. A reconstruction that made `foo.prop = true` land on
    // the shared prototype object would pass the two cases above and be wrong.
    expect(
      await runModule(
        `function FooObj(){}
         FooObj.prototype.prop = "some";
         var foo = new FooObj;
         foo.prop = true;`,
        `(FooObj.prototype.prop === "some") ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it("keeps the own value on the instance that was written", async () => {
    expect(
      await runModule(
        `function FooObj(){}
         FooObj.prototype.prop = "some";
         var foo = new FooObj;
         foo.prop = true;`,
        `(foo.prop === true) ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it("lets the inherited value resurface after `delete` removes the own one", async () => {
    // §13.5.1.2 + §10.1.5. Measured 0 on the base and 1 on the branch (the same
    // file-copy A/B as the table in the residual pins below): with the instance
    // on the bespoke struct the shadowing write and the delete acted on a slot
    // the prototype chain could not see past, so the inherited value never came
    // back.
    expect(
      await runModule(
        `function F(){}
         F.prototype.phylum = "avis";
         var i = new F;
         i.phylum = "own";
         var before = i.phylum;
         delete i.phylum;`,
        `(before === "own" && i.phylum === "avis") ? 1 : 0`,
      ),
    ).toBe(1);
  });
});

describe("#4506 S2 — a chain walk is a DYNAMIC consumer", () => {
  it("answers `F.prototype.isPrototypeOf(new F())`", async () => {
    // #4480 R4, and `language/types/object/S8.6.2_A1` CHECK#2.2. The blocker
    // was the CLASSIFIER, exactly as #4480's residual said: writing the call is
    // the fnctor's only dynamic use, and an `isPrototypeOf` ARGUMENT was
    // `neutral`, so `FooObj` was `keep-static`, its instance stayed a struct,
    // and the walk's opening `ref.test (ref $Object)` failed.
    expect(
      await runModule(
        `function FooObj(){}
         var obj__ = new FooObj;`,
        `FooObj.prototype.isPrototypeOf(obj__) ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it("still answers false for an unrelated object as the prototype", async () => {
    // `S8.6.2_A1` CHECK#2.3 — the refusal half. A blanket `true` would pass the
    // case above and be wrong here.
    expect(
      await runModule(
        `var protoObj = {};
         function FooObj(){}
         var obj__ = new FooObj;`,
        `protoObj.isPrototypeOf(obj__) ? 1 : 0`,
      ),
    ).toBe(0);
  });

  it("keeps %Object.prototype% on the instance's chain", async () => {
    // `S8.6.2_A1` CHECK#2.1 — passes on the base too; pinned because the
    // conversion must not LOSE it.
    expect(
      await runModule(
        `function FooObj(){}
         var obj__ = new FooObj;`,
        `Object.prototype.isPrototypeOf(obj__) ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it("resolves `key in instance` through the prototype", async () => {
    expect(
      await runModule(
        `function F(){}
         F.prototype.phylum = "avis";
         var i = new F;`,
        `("phylum" in i) ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it.fails("does not report an inherited key as an OWN property", async () => {
    // `in`'s companion assertion in `S8.12.6_A2_T2` CHECK#3, and a residual
    // this slice does NOT fix — recorded here rather than left unstated
    // because it is a WRONG answer, not a missing one.
    //
    // A/B'd against the reverted tree (`.tmp/base-*.ts` file copies, runs
    // executed for this issue): the base answers `1` too, and so does an
    // arg'd constructor whose site is never converted at all. So the defect
    // belongs to the `F.prototype.<p> = v` per-property write route, not to
    // the instance representation:
    //
    //   | probe                                            | base | branch |
    //   | ------------------------------------------------ | ---- | ------ |
    //   | `i.hasOwnProperty("phylum")` (converted)          | 1    | 1      |
    //   | same via `Object.prototype.hasOwnProperty.call`   | 1    | 1      |
    //   | `Object.hasOwn(i, "phylum")` — CORRECT            | 0    | 0      |
    //   | same shape, `new F(1)` (never converted)          | 1    | 1      |
    //   | `Object.create(P)` control — CORRECT              | 0    | 0      |
    //
    // `Object.hasOwn` and `gOPD` answer correctly on the same receiver in the
    // same module, so the own-property table is right and it is the
    // `hasOwnProperty`/`propertyIsEnumerable` DISPATCH that consults something
    // chain-aware.
    expect(
      await runModule(
        `function F(){}
         F.prototype.phylum = "avis";
         var i = new F;`,
        `i.hasOwnProperty("phylum") ? 1 : 0`,
      ),
    ).toBe(0);
  });

  it("answers `Object.hasOwn` correctly on the same receiver (the control above)", async () => {
    expect(
      await runModule(
        `function F(){}
         F.prototype.phylum = "avis";
         var i = new F;`,
        `Object.hasOwn(i, "phylum") ? 1 : 0`,
      ),
    ).toBe(0);
  });
});

describe("#4506 — controls that must not move", () => {
  it("keeps a typed own field on the struct fast path", async () => {
    // Clause B of the #2660 gate: a typed own-field consumer is `keep-typed`
    // and never converted. This is the #1888 floor's protection, and it is the
    // measurement that decided option (a) over (b) — only 1.7 % of sites are
    // in this class.
    expect(await runModule(`function C(){ this.x = 3; } var c = new C();`, `c.x`)).toBe(3);
  });

  it("keeps `instanceof` answering for a converted instance", async () => {
    // `native-user-instanceof.ts` ORs a `ref.test (ref $__fnctor_F)` arm with
    // the `__isPrototypeOf(F.prototype, v)` chain walk. The conversion removes
    // the first arm's subject, so this pins that the second one carries it.
    expect(await runModule(`function F(){} var i = new F;`, `(i instanceof F) ? 1 : 0`)).toBe(1);
  });

  it("keeps `Object.getPrototypeOf(i) === F.prototype`", async () => {
    expect(await runModule(`function F(){} var i = new F;`, `(Object.getPrototypeOf(i) === F.prototype) ? 1 : 0`)).toBe(
      1,
    );
  });

  it("keeps an expando write/read on a converted instance", async () => {
    expect(await runModule(`function F(){} var i = new F; i.z = 5;`, `i.z`)).toBe(5);
  });

  it("keeps a constructor with arguments on its existing lowering", async () => {
    // An arg'd site is deliberately NOT converted (its argument side effects
    // still have to run through the real constructor).
    expect(await runModule(`function F(a){ this.a = a; } var i = new F(4);`, `i.a`)).toBe(4);
  });
});

describe("#4506 — measured residuals", () => {
  it.fails("runs a non-empty constructor body against an `$Object` receiver", async () => {
    // `language/expressions/in/S8.12.6_A2_T2`. `Robin` is escape-gate-approved
    // and its binding slot is now externref, but the lowering still requires an
    // EMPTY body — running a real constructor body with `this` bound to the
    // `$Object` is the next slice (9 of 115 blocked sites in the census).
    expect(
      await runModule(
        `var __proto = {phylum: "avis"};
         function Robin(){ this.name = "robin"; }
         Robin.prototype = __proto;
         var robin = new Robin;`,
        `("phylum" in robin) ? 1 : 0`,
      ),
    ).toBe(1);
  });

  // (2026-08-23) HEALED by #4623 — the residual pin TRIPPED, its designed
  // mechanism. The routed defect was neither a fnctor problem nor the receiver
  // compiling wrong: NO dispatcher claimed `recv.isPrototypeOf(v)` for a closed
  // receiver, and #4623's call arm now routes it to `__isPrototypeOf` in both
  // lanes. (S13.2.2_A1_T1/_T2 still need the fnctor-prototype edge — pinned in
  // #4623's own residuals.) Flipped to a positive pin.
  it("answers `<plain object>.isPrototypeOf(v)` for a named receiver", async () => {
    expect(
      await runModule(
        `var P = {q: 1};
         var o = Object.create(P);`,
        `P.isPrototypeOf(o) ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it("shows that same module's chain IS live (the control for the row above)", async () => {
    expect(
      await runModule(
        `var P = {q: 1};
         var o = Object.create(P);`,
        `("q" in o) ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it.fails("enumerates an inherited enumerable property in `for-in`", async () => {
    // §14.7.5.6 EnumerateObjectProperties walks the chain. Measured 0 on BOTH
    // arms for a fnctor prototype, while the `Object.create` control below
    // answers 1 on both — so this is the same auto-minted-prototype defect
    // family as the `hasOwnProperty` residual above, not something the
    // conversion introduced.
    expect(
      await runModule(
        `function F(){}
         F.prototype.phylum = "avis";
         var i = new F;
         var n = 0;
         for (var k in i) { n++; }`,
        `n`,
      ),
    ).toBe(1);
  });

  it("enumerates an inherited enumerable property for a plain `Object.create` (the control)", async () => {
    expect(
      await runModule(
        `var P = {phylum: "avis"};
         var o = Object.create(P);
         var n = 0;
         for (var k in o) { n++; }`,
        `n`,
      ),
    ).toBe(1);
  });

  it.fails("links `F.prototype`'s own [[Prototype]] to %Object.prototype%", async () => {
    // The auto-minted prototype object is created with `__new_plain_object`
    // and left with a null `$proto` (#3976 recorded the same gap for class
    // prototypes and deferred it). So the instance's chain stops one link
    // early.
    expect(
      await runModule(
        `function F(){} var i = new F;`,
        `(Object.getPrototypeOf(Object.getPrototypeOf(i)) === Object.prototype) ? 1 : 0`,
      ),
    ).toBe(1);
  });
});
