// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 L0b — expression shapes on the Prepared path. Each refused or ended at a run-time abort before: `null` where
// a number was expected (`bare 'null' in non-reference context`), a conditional whose arms are primitives of different
// kinds, a function's string local stored into again (`no slot representation`), `++`/`--` used as a value, `+` over a
// Boolean and a number, and `null == undefined`. Now each is JavaScript's value.
import { describe, it } from "vitest";
import { agreesWithNode, runnerOptions } from "./helpers/prepared-node-agreement.js";

const agrees = (body: string) => agreesWithNode(body, true, runnerOptions());

describe("#7354 L0b — expression shapes", () => {
  it("keeps null a value of its own where a number is expected", async () => {
    await agrees(
      "function t() { var x = null; var o = { n: null }; return String(x === null) + String(o.n) + String(x + 1) + typeof o.n; }\nvar out = t() + String({ n: null }.n);",
    );
  });

  it("joins a conditional of differing primitive arms on the dynamic value", async () => {
    await agrees(
      'function t(c) { var n = 3; var a = c ? n : undefined; var b = c ? "s" : null; var d = c ? true : 2; return typeof a + String(a) + String(b) + String(d); }\nvar out = t(true) + "|" + t(false);',
    );
  });

  it("stores a function's string local again, whatever is stored", async () => {
    await agrees(
      'function t(p) { var s = ""; for (var i = 0; i < 3; i++) s = s + i; s += p; var u = "a"; u = 5; return s + typeof u + u; }\nvar out = t("x") + t(2);',
    );
    await agrees(
      'function t(v) { var s = "b"; if (v) s = "c"; switch (s) { case "b": return "B"; case "c": return "C"; } return "x"; }\nvar out = t(0) + t(1);',
    );
  });

  it("answers the new value of a prefix and the old numeric value of a postfix update", async () => {
    await agrees(
      'var i = 1; var j = i++; var k = ++i; var m = i--; var n = --i;\nvar out = i + "," + j + "," + k + "," + m + "," + n;',
    );
    await agrees(
      'function t() { var i = 10; var s = "5"; var a = i++ + ++i; var b = s++; var u; var c = u++; return i + "," + a + "," + b + "," + typeof b + "," + s + "," + c; }\nvar out = t();',
    );
  });

  it("adds a Boolean and a number, and converts a Boolean to its string", async () => {
    await agrees(
      "function t() { var b = true; var n = 2; return String(b + n) + String(false + b) + String(b); }\nvar out = t() + String(true + 1) + String(1 + false);",
    );
  });

  it("equates null and undefined with each other only", async () => {
    await agrees(
      "function t() { var o = {}; return String(null == undefined) + (null === undefined) + (undefined != null) + (o.x == null) + (o.x === null); }\nvar out = t() + String(null == undefined);",
    );
  });
});
