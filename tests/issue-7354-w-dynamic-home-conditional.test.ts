// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice W — a conditional over a script `var` in its dynamic home on the Prepared path. The checker types the
// var by its initializer (`number`), but a hoisted function can read it before that runs (`undefined`), so the arm
// is the dynamic value. The #5092 mixed-primitive claim used to prove it `number` and the lowering then threw
// `IrInvariantError` out of `compile()` (propertyHelper.js's `isWritable`). Such an arm now joins on the dynamic
// carrier as itself; (#7354 L0b) so does an arm that only may yield the dynamic value.
import { describe, expect, it } from "vitest";
import { agreesWithNode, runPrepared } from "./helpers/prepared-node-agreement.js";

/** `n`, `s` and `b` live in their dynamic homes: `f` reads them before their initializers run. */
const program = (fn: string, calls = "f(1) + f(2)") =>
  `var out = f(1);\nvar n = 4294967295; var s = "str"; var b = true;\n${fn}\nout = out + ${calls};`;

describe("#7354 W — a conditional arm read from a dynamic home", () => {
  it("compiles the minimal repro that threw out of compile()", async () => {
    expect(
      await runPrepared(
        'var e = f(1);\nvar n = 4294967295;\nfunction f(a) { var u = a === 1 ? n : "x"; return u === "x"; }',
      ),
    ).toBe("returned");
  });

  it("gives node's value before and after the initializer, for each arm kind", async () => {
    await agreesWithNode(
      program(
        'function f(a) { var u = a === 1 ? n : "x"; var v = a !== 1 ? 7 : s; var w = a === 1 ? b : 0;' +
          ' return typeof u + typeof v + typeof w + (u === undefined) + (v === undefined) + ";"; }',
      ),
    );
  });

  it("keeps propertyHelper's isWritable shape", async () => {
    await agreesWithNode(
      program(
        "function f(a) { var unlikely = a === 2 && typeof a === 'number' ? n : 'unlikelyValue';" +
          " var newValue = a === 3 || unlikely; return typeof newValue + ':' + (newValue === 'unlikelyValue') + ';'; }",
        "f(1) + f(2) + f(3)",
      ),
    );
  });

  it("keeps an arm whose operator fixes its representation claimable", async () => {
    await agreesWithNode(program('function f(a) { return String(a === 1 ? -n : "x") + String(a === 2 ? n : "y"); }'));
  });

  // The carrier equality's result was an unbranded i32, so a boolean-proved arm over it threw the invariant too.
  it("gives node's value for an equality arm over the dynamic home", async () => {
    await agreesWithNode(
      program('function f(a) { return String(a === 1 ? n === 1 : 7) + String(a !== 1 ? "s" : s !== s) + ";"; }'),
    );
  });

  // One binding predicate for the join, the claim and `+`: a `+` over an out-of-scope dynamic home was refused.
  it("adds a dynamic home as node does", async () => {
    await agreesWithNode(program('function f(a) { var t = n + "y"; return "x" + n + t + (n + 1) + ";"; }'));
  });

  // A literal's property read was typed from the checker (`number`), so `typeof o.p` said "number" for `undefined`.
  it("reads a literal's property stored from a dynamic home as node does", async () => {
    await agreesWithNode(
      program("function f(a) { var o = { p: n, q: s }; return String(typeof o.p) + typeof o.q + ';'; }"),
    );
  });

  // (#7354 L0b) Arms of different primitive kinds join on the carrier, so this one is no longer refused.
  it("gives node's value for an arm that may yield the dynamic value through `+`", async () => {
    await agreesWithNode(program('function f(a) { var u = a === 1 ? n + 1 : "x"; return typeof u + u + ";"; }'));
  });
});
