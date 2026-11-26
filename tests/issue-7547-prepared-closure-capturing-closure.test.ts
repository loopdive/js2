// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7547 — on the Prepared path a closure that captures a closure has no native carrier: it is refused where it is
// made, so the function that makes it aborts, and a program that never runs that function compiles.
import { describe, expect, it } from "vitest";
import { abortBodies, agreesWithNode } from "./helpers/prepared-node-agreement.js";

const SLOW = 240_000;
const PAIR = "var b = function(){ return 6; }; var a = function(){ return b() + 1; };";

describe("#7547 — a function expression capturing a closure", () => {
  it(
    "compiles when its function never runs",
    () => agreesWithNode(`function g(){ ${PAIR} return a(); } var out = 'x';`),
    SLOW,
  );
  it(
    "aborts by name in the function that makes it",
    async () => {
      const rows = await abortBodies(`function g(){ ${PAIR} return a(); } g();`);
      expect(rows).toContain('g: ir/from-ast: a closure capturing the closure "b" has no native carrier (g)');
    },
    SLOW,
  );
});
