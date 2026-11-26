// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 F1b review round 1 — OrdinarySet of an existing own writable property updates its value only (§10.1.9.2
// step 3.d–e), so a function's non-enumerable, non-configurable `prototype` is rewritten in sloppy and strict code
// alike, and (B2) a function under a constant computed key is named by that key. Each accepted program runs twice:
// with node's answer (returns) and with a wrong one (throws).
import { describe, expect, it } from "vitest";
import { runPrepared } from "./helpers/prepared-node-agreement.js";

const SLOW = 240_000;

/** `source` and `wrong` (the same program asserting a wrong answer): node returns on the first and throws on both. */
async function agrees(source: string, wrong: string): Promise<void> {
  expect(() => new Function(source)()).not.toThrow();
  expect(() => new Function(wrong)()).toThrow();
  expect(await runPrepared(source)).toBe("returned");
  expect(await runPrepared(wrong)).toBe("threw");
}

const FUNCTIONS =
  "function d() {} var e = function () {}; var n = function nm() {}; function mk() { return function () {}; }\n" +
  "var i = mk(); var p = { q: 7 }; function rd(v) { return v.prototype; }\n";

describe("#7354 F1b — a write of an own writable property keeps its attributes", () => {
  const SLOPPY = `${FUNCTIONS}d.prototype = 5; e.prototype = p; n.prototype = "s"; i.prototype = null;\n`;
  it(
    "rewrites the prototype of a declaration, an expression, a named expression and an inner closure (sloppy)",
    () =>
      agrees(
        `${SLOPPY}if (typeof d.prototype !== "number" || rd(d) !== 5 || e.prototype !== p || rd(e) !== p || rd(n) !== "s" || rd(i) !== null) throw 1;`,
        `${SLOPPY}if (rd(d) !== 6) throw 1;`,
      ),
    SLOW,
  );

  const STRICT =
    `"use strict";\n${FUNCTIONS}var r = "";\n` +
    'try { d.prototype = 5; e.prototype = p; n.prototype = "s"; i.prototype = null; r = "ok"; } catch (x) { r = "threw"; }\n';
  it(
    "rewrites them in strict code without a TypeError",
    () =>
      agrees(
        `${STRICT}if (r !== "ok" || rd(d) !== 5 || rd(e) !== p || rd(n) !== "s" || rd(i) !== null) throw 1;`,
        `${STRICT}if (r !== "threw") throw 1;`,
      ),
    SLOW,
  );

  const OBJECTS = "var o = { a: 1 }; o.a = 2; var q = {}; q.b = 1; q.b = 3;\n";
  it(
    "updates an object literal's and a written property's value",
    () => agrees(`${OBJECTS}if (o.a !== 2 || q.b !== 3) throw 1;`, `${OBJECTS}if (o.a !== 1) throw 1;`),
    SLOW,
  );
});
