// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 G1 review r1 (B1) — an identifier spelled like an Error constructor that is not the global (a parameter, a
// local `var`, a label, a function expression's name, a property shorthand, a catch binding, an object key) does not
// make the program hold the Error family: only a read of the unchanged global does, on the IR side
// (`source-plain-objects.ts`, through the same pristine test the read uses), and the realm holds the family only where
// the IR emitted a use of it (`native-realm-requirements.ts`). Each shape is paired with every consumer the family
// touches (String(), `+` on either side, instanceof, a caught value), against node with a wrong twin. Before the fix
// several of these threw out of compile() (`native strings: missing literal "Error"`).
// Also: a script-level bare `var` of a global the realm serves refuses by name (S1), never reads `undefined`.
import { afterEach, describe, expect, it, vi } from "vitest";
import { agreesWithNode, refusal, runnerOptions } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 300_000;
/** Every consumer, over a value `v` that is an object with its own toString. */
const CONSUMERS = `function F(){}
function caught(v){ try { throw v; } catch (c) { return String(c); } }
function use(v){ return String(v) + "|" + (v + "!") + "|" + ("?" + v) + "|" + String(v instanceof F) + "|" + caught(v); }
var obj = {toString: function(){ return "T"; }};
`;

const SHAPES: readonly (readonly [string, string])[] = [
  ["a parameter", "function f(TypeError){ return use(TypeError); } var out = f(obj);"],
  ["a local var", "function f(){ var RangeError = obj; return use(RangeError); } var out = f();"],
  ["a label", "var out; Error: for (;;) { out = use(obj); break Error; }"],
  ["a function expression's name", "var g = function SyntaxError(){ return use(obj); }; var out = g();"],
  ["a property shorthand", "function f(EvalError){ var o = {EvalError}; return use(o.EvalError); } var out = f(obj);"],
  ["a catch binding", "var out; try { throw obj; } catch (Error) { out = use(Error); }"],
  ["an object key", "var o = {URIError: obj, ReferenceError: 1}; var out = use(o.URIError) + o.ReferenceError;"],
  [
    "a catch that reads its payload in a function the path cannot lower",
    "function h(){ var a = arguments; try { return 1; } catch (e) { return e.message; } } var out = use(obj);",
  ],
];

describe("#7354 G1 — names spelled like an Error constructor are not the global", () => {
  it.each(SHAPES)("%s", (_label, body) => agreesWithNode(CONSUMERS + body, true, runnerOptions()), SLOW);
});

describe("#7354 G1 — a bare script var of a global the realm serves", () => {
  it.each(["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "Object"])(
    "refuses var %s; by name",
    async (name) => {
      const read =
        name === "Object" ? "var o = Object.create(null);" : `var t = typeof ${name}; var e = new ${name}("m");`;
      expect(await refusal(`var ${name};\n${read}\nvar k = function(){ return 1; }; k();`, runnerOptions())).toContain(
        `script var '${name}' binds the global's existing ${name}, which this path does not read through it`,
      );
    },
    SLOW,
  );
  it(
    "keeps a script var with an initializer, which replaces the built-in where it runs",
    () =>
      agreesWithNode(
        "var TypeError = {}; var RangeError = 5; var out = String(TypeError) + RangeError;",
        true,
        runnerOptions(),
      ),
    SLOW,
  );
});
