// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2660 S1 — unit tests for the INERT fnctor escape / dynamic-use gate analysis
// (`analyzeFnctorEscapeGate`). Pure analysis: builds an in-memory TS program +
// checker and asserts the per-`new F()`-site classification. No codegen.
//
// The gate approves a `new F()` site for the future S3 `$Object` reconstruction
// iff BOTH (A) dynamically consumed AND (B) NO typed own-field consumer. Clause
// (B) is the hot-path-protection clause: a site with ANY typed `instance.<own>`
// read must NEVER be approved (reconstructing it would move the read onto
// __extern_get and regress the #1888 floor). The conservative default is `keep`.

import { describe, it, expect } from "vitest";
import * as ts from "typescript";
import { analyzeFnctorEscapeGate, type FnctorGateClass } from "../src/codegen/fnctor-escape-gate.js";

/** Build an in-memory single-file program + checker for `source`. */
function checkerFor(source: string): { sf: ts.SourceFile; checker: ts.TypeChecker } {
  const fileName = "input.ts";
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2020, /*setParentNodes*/ true);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? sf : undefined),
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? source : undefined),
  };
  const program = ts.createProgram([fileName], { noLib: true, allowJs: false, strict: false }, host);
  return { sf: program.getSourceFile(fileName)!, checker: program.getTypeChecker() };
}

/** Collect the classification of the (single) `new F()` site in `source`. */
function classifyOnly(source: string): FnctorGateClass | undefined {
  const { sf, checker } = checkerFor(source);
  const result = analyzeFnctorEscapeGate(checker, [sf]);
  const entries = [...result.sites.values()];
  return entries[0];
}

describe("#2660 S1 — fnctor escape/dynamic-use gate (inert analysis)", () => {
  it("approves a purely-dynamically-consumed instance (.call receiver) → reconstruct", () => {
    // child is read only via a generic-method .call receiver — no typed field.
    const src = `
      var proto: any = {};
      var Con: any = function () {};
      Con.prototype = proto;
      var child: any = new Con();
      [].forEach.call(child, function () {});
    `;
    expect(classifyOnly(src)).toBe("reconstruct");
  });

  it("approves an inherited (non-own) named read → reconstruct", () => {
    // `child.foo` where `foo` is NOT assigned to `this` in Con → inherited read.
    const src = `
      var Con: any = function () {};
      var child: any = new Con();
      var x: any = child.foo;
    `;
    expect(classifyOnly(src)).toBe("reconstruct");
  });

  it("KEEPS an instance with a typed own-field read (clause B) → keep-typed", () => {
    // child.x reads an own field assigned in the ctor (`this.x = …`) → a typed
    // struct.get consumer; reconstructing it would regress the hot path.
    const src = `
      var Con: any = function (this: any) { this.x = 3; };
      var child: any = new Con();
      var y: any = child.x;
    `;
    expect(classifyOnly(src)).toBe("keep-typed");
  });

  it("KEEPS when BOTH a typed own-field AND a dynamic read exist (mixed) → keep-typed", () => {
    // Clause (B) is absolute: ANY typed own-field consumer forces keep, even
    // alongside a dynamic use. The mixed case is out of scope for S1.
    const src = `
      var Con: any = function (this: any) { this.x = 3; };
      var child: any = new Con();
      var y: any = child.x;
      [].forEach.call(child, function () {});
    `;
    expect(classifyOnly(src)).toBe("keep-typed");
  });

  it("KEEPS an instance with no dynamic consumer (clause A fails) → keep-static", () => {
    // child is constructed and never read dynamically nor via a typed field.
    const src = `
      var Con: any = function () {};
      var child: any = new Con();
    `;
    expect(classifyOnly(src)).toBe("keep-static");
  });

  it("inline `new F().foo` (inherited) is classified → reconstruct", () => {
    const src = `
      var Con: any = function () {};
      var x: any = (new Con()).foo;
    `;
    expect(classifyOnly(src)).toBe("reconstruct");
  });

  it("inline `new F().x` (own field) is NOT approved → keep-typed", () => {
    const src = `
      var Con: any = function (this: any) { this.x = 3; };
      var y: any = (new Con()).x;
    `;
    expect(classifyOnly(src)).toBe("keep-typed");
  });

  it("ignores `new C()` where C is a class (not a fnctor) → no site recorded", () => {
    const src = `
      class C { constructor() {} }
      var c: any = new C();
      [].forEach.call(c, function () {});
    `;
    const { sf, checker } = checkerFor(src);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    expect(result.sites.size).toBe(0);
    expect(result.approved.size).toBe(0);
  });

  it("ignores `new Arrow()` where the binding is an arrow function → no site", () => {
    const src = `
      var Arrow: any = () => {};
      var a: any = new Arrow();
    `;
    const { sf, checker } = checkerFor(src);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    expect(result.sites.size).toBe(0);
  });

  it("fnctor-free / empty program yields an empty result (no-op)", () => {
    const { sf, checker } = checkerFor(`var x: number = 1 + 2;`);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    expect(result.sites.size).toBe(0);
    expect(result.approved.size).toBe(0);
  });

  it("the approved set equals exactly the reconstruct-classified sites", () => {
    const src = `
      var A: any = function () {};
      var B: any = function (this: any) { this.x = 1; };
      var a: any = new A();
      [].forEach.call(a, function () {});
      var b: any = new B();
      var y: any = b.x;
    `;
    const { sf, checker } = checkerFor(src);
    const result = analyzeFnctorEscapeGate(checker, [sf]);
    const reconstructCount = [...result.sites.values()].filter((c) => c === "reconstruct").length;
    expect(result.approved.size).toBe(reconstructCount);
    expect(result.approved.size).toBe(1); // only `a`
  });
});

describe("#4387 — stable Array-valued fnctor prototype proof", () => {
  it("recognizes one direct top-level intrinsic Array literal assignment", () => {
    const { sf, checker } = checkerFor(`
      F.prototype = [1, 2, 3];
      function F() {}
      var value: any = new F();
    `);
    expect(analyzeFnctorEscapeGate(checker, [sf]).stableArrayPrototypeNames).toEqual(new Set(["F"]));
  });

  it("declines multiple or computed prototype writes", () => {
    const { sf, checker } = checkerFor(`
      F.prototype = [1, 2, 3];
      F["prototype"] = [4, 5, 6];
      function F() {}
      var value: any = new F();
    `);
    expect(analyzeFnctorEscapeGate(checker, [sf]).stableArrayPrototypeNames).toEqual(new Set());
  });

  it("declines constructor aliases outside the closed proof", () => {
    const { sf, checker } = checkerFor(`
      F.prototype = [1, 2, 3];
      function F() {}
      var Alias = F;
      var value: any = new Alias();
    `);
    expect(analyzeFnctorEscapeGate(checker, [sf]).stableArrayPrototypeNames).toEqual(new Set());
  });
});
