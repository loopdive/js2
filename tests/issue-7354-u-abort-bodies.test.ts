// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 U — abort bodies (src/ir/abort-bodies.ts) through the strict Prepared entry, which switches the policy on.
// A function whose body the path cannot lower gets the run-time abort as its body: a program that never enters it
// gives node's answer (checked twice: node's answer returns, a wrong one throws), a program that enters it traps in
// that function, uncatchably, and the entry's table names it with its refusal. Top-level code, async functions and
// generators still refuse at compile time, by the same text as without the policy.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortBodies,
  agreesWithNode,
  nodeOut,
  preparedOptions,
  refusal,
  yieldToRpc,
} from "./helpers/prepared-node-agreement.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { compile, requiredPreparedAbortBodies } from "../src/test262/test262-prepared-entry.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 240_000;
/** A construct the path refuses by name today; a slice that lowers it swaps this constant. */
const UNLOWERABLE = "/a/";
const REGEXP_REFUSAL = (unit: string) => `ir/from-ast: RegExp literal has no provider (${unit})`;

/** `source` compiles, validates, and traps in the abort body of `name`, which its table lists. */
async function abortsIn(source: string, name: string): Promise<void> {
  await yieldToRpc();
  const result = await compile(source, preparedOptions());
  expect(result.success).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  expect(requiredPreparedAbortBodies(result)!.map((row) => row.name)).toContain(name);
  let trap: unknown;
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
  } catch (error) {
    trap = error;
  }
  // The realm's RuntimeError class is not this vitest context's: matched by name, message and top frame.
  expect((trap as Error | undefined)?.constructor.name).toBe("RuntimeError");
  expect((trap as Error).message).toBe("unreachable");
  const frames = [...(trap as Error).stack!.matchAll(/at\s+(\S+)\s+\(wasm:\/\//g)].map((match) => match[1]);
  expect(frames[0]).toBe(name);
}

describe("#7354 U — a function never entered: node's answer", () => {
  it.each([
    ["a declaration", `function g(){ return ${UNLOWERABLE}; } var out = 'x';`],
    [
      "its value: typeof, length, name, identity",
      `function g(a, b){ return ${UNLOWERABLE}; } var h = g;` +
        " var out = typeof g + String(g.length) + g.name + (h === g ? 'y' : 'n') + typeof h;",
    ],
    [
      "a function expression stored, as a property, as an argument",
      `var f = function(a){ return ${UNLOWERABLE}; }; var a = {}; a.m = function(){ return ${UNLOWERABLE}; };` +
        ` function t(fn){ return fn.length; } var out = typeof f + String(f.length) + typeof a.m + String(t(function(p, q){ return ${UNLOWERABLE}; }));`,
    ],
    [
      "a closure inside a function that runs",
      `function o(){ var i = function(){ return ${UNLOWERABLE}; }; return 1; } var out = String(o() + o());`,
    ],
    [
      "a closure inside a function expression that runs: the innermost function owns the refusal",
      `var f = function(){ var i = function(){ return ${UNLOWERABLE}; }; return 1; }; var out = String(f() + f());`,
    ],
    [
      "the effects its body would have had are not made",
      `var n = 0; function g(){ n = 1; return ${UNLOWERABLE}; } var out = String(n);`,
    ],
    ["hoisted: typeof before the declaration", `var out = typeof g; function g(){ return ${UNLOWERABLE}; }`],
    [
      "`instanceof` with it on the right (no call)",
      `function G(){ this.r = ${UNLOWERABLE}; } function t(v){ return v instanceof G; } var out = String(t({}));`,
    ],
    [
      "a legalization refusal (loose equality on a dynamic value)",
      "function g(v){ return v == v; } var out = typeof g;",
    ],
    [
      "strict code",
      `'use strict'; function g(){ return ${UNLOWERABLE}; } var f = function(){ return ${UNLOWERABLE}; };` +
        " var out = typeof g + typeof f;",
    ],
    [
      "in a loop and across calls of a function that creates it",
      `function mk(i){ return function(){ return ${UNLOWERABLE}; }; } var out = '';` +
        " for (var i = 0; i < 3; i++) { var f = mk(i); out = out + typeof f + f.length; }",
    ],
  ])("%s", (_label, body) => agreesWithNode(body), SLOW);
});

describe("#7354 U — the table", () => {
  it(
    "names each aborted function with its first refusal, in source order",
    async () => {
      expect(
        await abortBodies(
          `function a(){ return ${UNLOWERABLE}; } function b(v){ var r = ${UNLOWERABLE}; return v[v]; }` +
            ` function c(){ return ${UNLOWERABLE}; } var x = 1;`,
        ),
      ).toEqual([`a: ${REGEXP_REFUSAL("a")}`, `b: ${REGEXP_REFUSAL("b")}`, `c: ${REGEXP_REFUSAL("c")}`]);
    },
    SLOW,
  );

  it(
    "names the closure, not the function around it, and not a same-named declaration",
    async () => {
      expect(
        await abortBodies(
          `function g(){ return 1; } function h(){ var g = function(){ return ${UNLOWERABLE}; }; return g; } var x = 1;`,
        ),
      ).toEqual([`h__closure_0: ${REGEXP_REFUSAL("h__closure_0")}`]);
    },
    SLOW,
  );

  it(
    "is empty for a program without such a function",
    async () => expect(await abortBodies("var x = 1; function f(v){ return v + 1; } x = f(x);")).toEqual([]),
    SLOW,
  );
});

describe("#7354 U — a function entered: the abort, which no catch or finally sees", () => {
  it.each([
    ["called at top level", `function g(){ return ${UNLOWERABLE}; } g();`, "g"],
    ["hoisted, called before the declaration", `g(); function g(){ return ${UNLOWERABLE}; }`, "g"],
    ["inside try/catch", `function g(){ return ${UNLOWERABLE}; } var c = 0; try { g(); } catch (e) { c = 1; }`, "g"],
    [
      "inside try/finally",
      `function g(){ return ${UNLOWERABLE}; } var x = 1; try { g(); } finally { x = 2; throw 3; }`,
      "g",
    ],
    [
      "from a function that catches",
      `function g(){ return ${UNLOWERABLE}; } function h(){ try { g(); } catch (e) { return 1; } return 2; } h();`,
      "g",
    ],
    ["through a call chain", `function a(){ return b(); } function b(){ return ${UNLOWERABLE}; } a();`, "b"],
    ["a function expression", `var f = function(){ return ${UNLOWERABLE}; }; f();`, "<module-init>__closure_0"],
    [
      "a method on a function object",
      `function a(){} a.m = function(){ return ${UNLOWERABLE}; }; a.m();`,
      "<module-init>__closure_1",
    ],
    [
      "a closure returned and called",
      `function o(){ var i = function(){ return ${UNLOWERABLE}; }; return i(); } o();`,
      "o__closure_0",
    ],
    ["by `new`", `function G(){ this.r = ${UNLOWERABLE}; } new G();`, "G"],
    [
      "as a ToPrimitive method",
      `var o = { toString: function(){ return ${UNLOWERABLE}; } }; var s = "" + o;`,
      "<module-init>__closure_0",
    ],
    ["strict code", `'use strict'; function g(){ return ${UNLOWERABLE}; } g();`, "g"],
    ["a legalization refusal", "function g(v){ return v == v; } g(1);", "g"],
    [
      "each of two aborted functions in its own body",
      `function a(){ return ${UNLOWERABLE}; } function b(v){ return v == v; } try { b(1); } catch (e) {} a();`,
      "b",
    ],
    [
      "an assert.throws-shaped caller: the expected throw never happens",
      `function g(){ return ${UNLOWERABLE}; } function throws(f){ try { f(); } catch (e) { return; } throw 1; }` +
        " throws(function(){ g(); });",
      "g",
    ],
  ])("%s", (_label, source, name) => abortsIn(source, name), SLOW);
});

describe("#7354 U — what still refuses at compile time, by the same text", () => {
  it.each([
    ["top-level code", `var r = ${UNLOWERABLE}; var out = typeof r;`, REGEXP_REFUSAL("<module-init>")],
    [
      "top-level code in a block never run",
      `var x = 0, y; if (x) { y = ${UNLOWERABLE}; } var out = typeof y;`,
      REGEXP_REFUSAL("<module-init>"),
    ],
    ["a generator", `function* g(){ yield ${UNLOWERABLE}; }`, "complete synchronous numeric or Boolean function"],
    ["an async function", `async function a(){ return ${UNLOWERABLE}; }`, "complete synchronous numeric or Boolean"],
    ["an early error in a function body", `function g(){ "use strict"; var eval = 1; }`, "'eval' in strict mode"],
  ])("%s", async (_label, source, text) => {
    const withAbortBodies = await compile(source, preparedOptions());
    expect(withAbortBodies.success).toBe(false);
    expect(withAbortBodies.errors.map((error) => error.message).join("\n")).toContain(text);
    expect(await refusal(source)).toContain(text);
  });

  it("without the policy, the program with the aborted function is refused by the body's text", async () => {
    const result = await compile(
      `function g(){ return ${UNLOWERABLE}; } var x = 1;`,
      preparedOptions(),
      undefined,
      "refuse",
    );
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message)).toContain(REGEXP_REFUSAL("g"));
  });

  it(
    "a program with no unlowerable function has the same bytes with and without the policy",
    async () => {
      const source = "function f(v){ return v + 1; } var out = String(f(1)) + typeof f;";
      const on = await compile(source, preparedOptions());
      const off = await compile(source, preparedOptions(), undefined, "refuse");
      expect(on.success && off.success).toBe(true);
      expect(Buffer.from(on.binary).equals(Buffer.from(off.binary))).toBe(true);
      expect(nodeOut(source)).toBe("2function");
    },
    SLOW,
  );
});

describe("#7354 U — a refusal of the dynamic-value legalization's flow rule (TypeScript: an annotated parameter)", () => {
  // `x` is read before its initializer, so its home is the dynamic value; `h` takes a number.
  const PREFIX = "var e = f(); var x = 1; function f() { return x; } function h(n: number) { return n; }";
  const FLOW = "a dynamic value flows into number without a conversion (CallExpression)";
  const ts = async (source: string, policy: "abort" | "refuse" = "abort") => {
    await yieldToRpc();
    const options = { ...preparedOptions(), fileName: "test.ts", allowJs: false };
    const result = await compile(source, options, undefined, policy);
    if (!result.success) return { refused: result.errors.map((error) => error.message).join("\n") };
    const table = requiredPreparedAbortBodies(result)!.map((row) => `${row.name}: ${row.detail}`);
    let outcome = "returned";
    try {
      (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    } catch (error) {
      outcome = (error as Error).constructor.name;
    }
    return { outcome, table };
  };

  it(
    "inside a function: the function aborts, and only when entered; without the policy the program is refused",
    async () => {
      const program = `${PREFIX} function g() { return h(x); } var y = h(2);`;
      expect(await ts(program)).toEqual({ outcome: "returned", table: [`g: ${FLOW}`] });
      expect(await ts(`${program} g();`)).toEqual({ outcome: "RuntimeError", table: [`g: ${FLOW}`] });
      expect((await ts(program, "refuse")).refused).toContain(FLOW);
    },
    SLOW,
  );

  it("at top level: refused, by the same text", async () => {
    expect((await ts(`${PREFIX} h(x);`)).refused).toContain(FLOW);
  });

  it(
    "a function that also has a lowering refusal: one row, the first refusal",
    async () => {
      expect(await ts(`${PREFIX} function g() { var r = /a/; return h(x); } var y = h(2);`)).toEqual({
        outcome: "returned",
        table: ["g: ir/from-ast: RegExp literal has no provider (g)"],
      });
    },
    SLOW,
  );

  it(
    "the rule does not read the statements of a function that has the abort body",
    async () => {
      expect(await ts(`${PREFIX} var g = function () { var r = /a/; return h(x); }; var t = typeof g;`)).toEqual({
        outcome: "returned",
        table: ["<module-init>__closure_0: ir/from-ast: RegExp literal has no provider (<module-init>__closure_0)"],
      });
    },
    SLOW,
  );
});
