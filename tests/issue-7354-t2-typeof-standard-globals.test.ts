// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice T — `typeof` of a standard global on the Prepared path. A global the language defines but this path does
// not provide yet (`Math`, `parseInt`, `Object`, …) answered "undefined" (node: "object" / "function"): the rule took
// every lib global for an absent one. Now only a name nothing declares — neither the program nor the standard
// library — is absent; a standard global's `typeof` refuses by name (the abort body inside a function), the values
// `undefined` / `NaN` / `Infinity` and a program's own binding of a standard name give node's answer.
import { describe, expect, it } from "vitest";
import { abortBodies, agreesWithNode, refusal } from "./helpers/prepared-node-agreement.js";

// (#7354 W2) `Object`, `String`, `Number` and `Boolean` are realm constructors now (issue-7354-w2-wrappers); (A1) so
// is `Array` (issue-7354-a1-array-values), and (#7557) `Function` (issue-7557-builtins-through-values).
const UNPROVIDED = [
  "parseInt",
  "parseFloat",
  "isNaN",
  "Math",
  "RegExp",
  "Date",
  "JSON",
  "encodeURIComponent",
  "globalThis",
];

describe("#7354 T — typeof of a standard global", () => {
  it.each(UNPROVIDED)("refuses typeof %s by name at top level", async (name) => {
    expect(await refusal(`var t = typeof ${name};\n`)).toContain(
      `identifier "${name}" is not in scope in <module-init>`,
    );
  });

  it("aborts a function that takes typeof of an unprovided standard global", async () => {
    expect(await abortBodies('function f() { return typeof Math === "undefined"; }\nvar out = f();')).toEqual([
      'f: ir/from-ast: identifier "Math" is not in scope in f',
    ]);
  });

  // (#7354 G1) The Error constructors are the realm's function objects now.
  it("answers typeof of an Error constructor as node does", async () => {
    await agreesWithNode(
      "var out = typeof Error + typeof TypeError + typeof RangeError + typeof SyntaxError + typeof ReferenceError" +
        ' + typeof EvalError + typeof URIError + (typeof TypeError === "function");',
    );
  });

  it("answers the global values and a name nothing declares as node does", async () => {
    await agreesWithNode(
      'var out = typeof undefined + typeof NaN + typeof Infinity + typeof zzz + (typeof zzz === "undefined");\n' +
        "function f() { return typeof NaN + typeof qqq; }\nout = out + f();",
    );
  });

  it("answers a program's own variable of a standard name as node does", async () => {
    await agreesWithNode(
      'var Math = 1;\nvar out = typeof Math;\nfunction f() { var Object = "s"; return typeof Object; }\nout = out + f();',
    );
  });

  // The checker merges a script's `function parseInt` with the lib's; the read of it as a value refuses, as before.
  it("refuses typeof of a script function that shares a standard name", async () => {
    expect(await refusal("function parseInt() { return 2; }\nvar t = typeof parseInt;\n")).toContain(
      'identifier "parseInt" is not in scope in <module-init>',
    );
  });
});
