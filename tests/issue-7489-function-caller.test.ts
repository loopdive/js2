// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7489 slice A — a function's `caller` on the Prepared path. The realm's Function.prototype holds the `caller` /
// `arguments` accessors with %ThrowTypeError% as getter and setter (§10.2.4), and a sloppy plain function owns V8's
// read-only `caller`, which is `null` here. Where V8 answers a sloppy caller this answers `null`: the value is
// implementation-defined and §17.1 forbids only a strict function. `arguments` keeps its refusal: a sloppy function's own
// is its arguments object.
import { afterEach, describe, expect, it, vi } from "vitest";
import { agreesWithNode, gapText, refusal, runPrepared, runnerOptions } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 300_000;
const caught = (expression: string) =>
  `(function () { try { ${expression}; return "none"; } catch (e) { return e instanceof TypeError ? "TE" : "other"; } })()`;

describe("#7489 A — a function's caller agrees with node", () => {
  it.each([
    [
      "a strict function's read and write throw TypeError, from sloppy code",
      `function s() { "use strict"; }
var out = ${caught("s.caller")} + ${caught("s.caller = 1")};`,
    ],
    [
      "a strict function's read and write throw TypeError, from strict code",
      `function s() { "use strict"; }
var out = (function () { "use strict"; return ${caught("s.caller")} + ${caught("s.caller = 1")}; })();`,
    ],
    [
      "a sloppy declaration's and expression's own caller is null when not running",
      `function g() {}
var e = function () {};
var out = String(g.caller) + String(e.caller) + String(g.hasOwnProperty("caller")) + String(e.hasOwnProperty("caller"));`,
    ],
    [
      "a sloppy write is ignored, a strict write throws (read only)",
      `function g() {}
g.caller = 5;
var out = String(g.caller) + (function () { "use strict"; return ${caught("g.caller = 1")}; })();`,
    ],
    [
      "a strict function owns no caller",
      `function s() { "use strict"; }
var out = String(s.hasOwnProperty("caller"));`,
    ],
    [
      "the TypeError is catchable inside the strict function's own caller",
      `function s() { "use strict"; return s.caller; }
var out = ${caught("s()")};`,
    ],
  ])("%s", (_label, body) => agreesWithNode(body, true, runnerOptions()), SLOW);
});

describe("#7489 A — the implementation-defined answer", () => {
  it(
    "a sloppy caller reads null where V8 answers the calling function",
    async () => {
      const source = `function g() { return g.caller; }
function h() { return g(); }
if (h() !== null) throw new Error("caller");`;
      expect(() => new Function(source)()).toThrow("caller");
      expect(await runPrepared(source, runnerOptions())).toBe("returned");
    },
    SLOW,
  );
});

describe("#7489 A — refusals that stay", () => {
  it.each([
    [
      "a read of a function's arguments",
      "function f(){} var a = f.arguments;",
      gapText("member read 'arguments' of a function needs a sloppy function's own arguments object"),
    ],
    [
      "a write of a function's arguments",
      "function f(){} f.arguments = 1;",
      gapText("member write 'arguments' of a function needs a sloppy function's own arguments object"),
    ],
  ])(
    "refuses %s",
    async (_label, source, text) => {
      expect(await refusal(source, runnerOptions())).toContain(text);
    },
    SLOW,
  );

  it.each([
    ["a generator", "function* g() {} var c = g.caller;"],
    ["an async function", "async function g() {} var c = g.caller;"],
  ])(
    "%s still refuses before it gets an own caller (§17.1 excludes it)",
    async (_label, source) => {
      expect(await refusal(source, runnerOptions())).not.toBe("");
    },
    SLOW,
  );
});
