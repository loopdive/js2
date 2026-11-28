// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7561 — String, Number and Boolean wrapper objects and their prototypes on the Prepared path (#7350 B3b-1's
// specification on main's realm model). `new X(v)` is a realm wrapper, `X.prototype` the realm's prototype object,
// `valueOf` / `toString` are found on the chain by identity (ToPrimitive, a call), and a primitive of a kind whose
// prototype the program can obtain reads through it. What the slice leaves out refuses by name or aborts.
//
// Each program computes `out` and is checked against node in a fresh realm, with a wrong answer that must throw
// (tests/helpers/prepared-node-agreement.ts). Every program calls a function expression, as the test262 harness does.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { compile } from "../src/test262/test262-prepared-entry.js";
import {
  abortsAtRunTime,
  agreesWithNode,
  freshRealmOut,
  refusal,
  runnerOptions,
  yieldToRpc,
} from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 300_000;
const CALLS = "\nvar k = function(){ return 1; }; k();";

/** `body` as a function's statements whose result is `out`. */
const inFunction = (body: string) => `function run() {\n${body}\nreturn out;\n}\nvar out = run();`;
const agrees = (body: string) => agreesWithNode(body + CALLS, true, runnerOptions(), freshRealmOut);

/** Programs checked at module level and inside a function. */
const VALUES: readonly (readonly [string, string])[] = [
  [
    "typeof, truthiness, valueOf and toString of the three wrappers; absent arguments",
    `var s = new String("ab"), n = new Number(5), b = new Boolean(false);
var out = typeof s + typeof n + typeof b + s.valueOf() + n.valueOf() + b.valueOf() + s.toString() + n.toString()
  + b.toString() + (b ? "T" : "F") + new String().valueOf() + "|" + new Number().valueOf() + new Boolean().valueOf();`,
  ],
  [
    "identity: a wrapper is a new object, equal only to itself",
    `var a = new Number(1), n = new Number(NaN);
var out = String(new Number(1) === 1) + String(a === a) + String(new Number(1) !== new Number(1)) + String(n === n)
  + String(new String("a") === new String("a"));`,
  ],
  [
    "ToPrimitive of a wrapper in arithmetic, concatenation and the conversions",
    `var t = new Boolean(true), f = new Boolean(false), w = new Number(6), s = new String(" 4 ");
var out = String(t + 1) + String(f * 3) + String(w + 1) + (s + "y") + String(new String("x")) + String(Number(t))
  + String(Number(s));`,
  ],
  [
    "instanceof and isPrototypeOf",
    `var out = String(new String("a") instanceof String) + String("a" instanceof String)
  + String(new Number(1) instanceof String) + String(new Number(1) instanceof Number)
  + String(String.prototype.isPrototypeOf(new String("x"))) + String(Number.prototype.isPrototypeOf(1));`,
  ],
  [
    "Object.prototype.toString's tags and the constructor back-link",
    `var t = function (v) { return Object.prototype.toString.call(v); };
var out = t(new String("a")) + t(new Number(1)) + t(new Boolean(false)) + t({}) + t(Number.prototype)
  + String(new String("a").constructor === String);`,
  ],
  [
    "a wrapper is an ordinary object: own properties, defineProperty, hasOwnProperty",
    `var n = new Number(1); Object.defineProperty(n, "x", {value: 5}); n.y = 2; var m = n;
var out = String(n.x) + String(n.y) + String(Number(n) + 1) + String(n === m) + String(n.hasOwnProperty("y"))
  + String(n.hasOwnProperty("valueOf"));`,
  ],
  [
    "a String wrapper's own length and its descriptor",
    `var s = new String("abc"); var d = Object.getOwnPropertyDescriptor(s, "length");
var out = String(s.length) + String(d.value) + String(d.writable) + String(d.enumerable) + String(d.configurable)
  + String(s.hasOwnProperty("length")) + String(new String("").length);`,
  ],
  [
    "the prototypes: identity, constructor, their own data, String.prototype's length",
    `var out = typeof String.prototype + String(String.prototype === String.prototype)
  + String(Number.prototype.constructor === Number) + String(Boolean.prototype.constructor === Boolean)
  + Number.prototype.toString() + String(String.prototype.length) + String(Boolean.prototype.valueOf())
  + String(String.prototype.valueOf() === "") + typeof Number.prototype;`,
  ],
];

/**
 * Programs that write a built-in or depend on a member's identity, and one whose function declarations nest (inside a
 * function it ends at the run-time abort): module level only.
 */
const WRITES: readonly (readonly [string, string])[] = [
  [
    "a wrapper captured, returned and passed to a function",
    `function mk(v) { var w = new Number(v); return function () { return w + 1; }; }
function str() { return new String("r"); }
function inc(x) { return x + 1; }
var w = str();
var out = String(mk(2)()) + typeof w + w + w.length + String(inc(new Number(4)));`,
  ],
  [
    "a wrong receiver of valueOf / toString is a catchable TypeError",
    `var o = {valueOf: String.prototype.valueOf}, p = {toString: Number.prototype.toString};
var out = "";
try { o.valueOf(); } catch (e) { out = out + String(e instanceof TypeError); }
try { p.toString(); } catch (e) { out = out + String(e instanceof TypeError); }`,
  ],
  [
    "methods of different families are different functions",
    `var out = String(Number.prototype.valueOf === String.prototype.valueOf)
  + String(Number.prototype.toString === Boolean.prototype.toString)
  + String(new Number(1).valueOf === Number.prototype.valueOf) + typeof new String("a").charAt;`,
  ],
  [
    "a computed own key holds the whole family; a literal one its member",
    `var key = "index" + "Of";
var out = String(String.prototype.hasOwnProperty(key)) + String(String.prototype.hasOwnProperty("indexOf"))
  + String(String.prototype.hasOwnProperty("nope"));`,
  ],
  [
    "Number.prototype.valueOf overridden: a wrapper's ToPrimitive calls it, a primitive's does not",
    `Number.prototype.valueOf = function () { return 20; }; var w = new Number(1);
var out = String(w + 1) + String(w * 2) + String(1 + 1);`,
  ],
  [
    "Number.prototype.toString overridden: String(wrapper) calls it, String(primitive) does not",
    `Number.prototype.toString = function () { return "z"; }; var w = new Number(2);
var out = String(w) + (w + "") + String(5);`,
  ],
  [
    "String.prototype.toString overridden through an alias",
    `var P = String.prototype; P.toString = function () { return "A"; };
var out = String(new String("x")) + String("y");`,
  ],
  [
    "valueOf overridden through a parameter",
    `function f(p) { p.valueOf = function () { return 7; }; } f(Number.prototype); var w = new Number(1);
var out = String(w * 1);`,
  ],
  [
    "a String valueOf moved onto Number.prototype throws a catchable TypeError",
    `Number.prototype.valueOf = String.prototype.valueOf; var w = new Number(1); var out;
try { out = String(w + 1); } catch (e) { out = "e" + String(e instanceof TypeError); }`,
  ],
  [
    "valueOf and toString both answering objects is a catchable TypeError",
    `Number.prototype.valueOf = function () { return {}; }; Number.prototype.toString = function () { return {}; };
var w = new Number(1); var out;
try { out = String(w + 1); } catch (e) { out = "e" + String(e instanceof TypeError); }`,
  ],
  [
    "own valueOf / toString on the instance",
    `var w = new Number(2); w.valueOf = function () { return {}; };
var s = new String("a"); s.toString = function () { return "Q"; };
var n = new Number(1); n.valueOf = function () { return 10; };
var out = String(w + 1) + String(s) + (s + "") + s.valueOf() + String(n + 1);`,
  ],
  [
    "a prototype write, read through a primitive and through a wrapper",
    `String.prototype.foo = 3; String.prototype.valueOf = function () { return "V"; };
var s = "a"; var out = String(s.foo) + String(new String("b").foo) + s.valueOf() + typeof s.charAt;`,
  ],
];

describe("#7561 — wrapper objects and their prototypes agree with node", () => {
  for (const [name, body] of VALUES) {
    it(`${name} (at module level)`, () => agrees(body), SLOW);
    it(`${name} (inside a function)`, () => agrees(inFunction(body)), SLOW);
  }
  it.each(WRITES)("%s", (_name, body) => agrees(body), SLOW);
});

describe("#7561 — what the slice leaves out refuses by name or aborts", () => {
  it.each([
    [
      "a static of a pristine constructor written",
      "Number.isNaN = function () { return 1; };",
      'identifier "Number" is not in scope',
    ],
    ["loose equality with a wrapper", "var out = new Number(1) == 1;", "dyn.eq (loose)"],
    ["a static of a constructor read", "var p = String.fromCharCode;", "String.fromCharCode is not reachable"],
    ["a constructor's prototype deleted", "var out = delete Number.prototype;", "member delete 'prototype' of Number"],
  ])("refuses %s", async (_label, source, expected) => {
    expect(await refusal(source + CALLS, runnerOptions())).toContain(expected);
  });

  // A String wrapper's index keys need the String exotic object (#7350 B3c); each use aborts, uncatchably.
  const CHECK = `function check(f) { try { f(); } catch (e) { return "caught"; } return "none"; }\n`;
  it.each([
    ["a constant index read", 'var s = new String("ab"); return s["0"];'],
    ["a constant index delete", 'var s = new String("ab"); return delete s["0"];'],
    ["an index own-property query", 'var s = new String("ab"); return s.hasOwnProperty("0");'],
    ["a computed index descriptor", 'var s = new String("ab"); return Object.getOwnPropertyDescriptor(s, "0" + "");'],
    ["an index definition", 'Object.defineProperty(new String("ab"), "0", {value: "x"});'],
    ["a String wrapper as a properties map", 'Object.defineProperties({}, new String("ab"));'],
    ["toString with a radix", "return new Number(255).toString(16);"],
  ])(
    "aborts %s",
    (_label, statement) =>
      abortsAtRunTime(`${CHECK}var out = check(function () { ${statement} });${CALLS}`, runnerOptions()),
    SLOW,
  );

  // Never the folded built-in after a write through an alias (the identity row's mark).
  it(
    "aborts a static written through an alias",
    () =>
      abortsAtRunTime(
        `var N = Number; N.isNaN = function () { return 1; }; var out; try { out = Number.isNaN(1); } catch (e) { out = e; }${CALLS}`,
        runnerOptions(),
        undefined,
        freshRealmOut,
      ),
    SLOW,
  );
});

const ROOT = join(__dirname, "..");
const HARNESS = ["assert.js", "sta.js"].map((file) => join(ROOT, "test262", "harness", file));

/** `body` behind the real prelude, asserting `answer` with assert.sameValue: "returned", or the uncaught outcome. */
async function withPrelude(body: string, answer: string): Promise<string> {
  await yieldToRpc();
  const prelude = [join(ROOT, "scripts", "test262-fyi-runtime.js"), ...HARNESS].map((f) => readFileSync(f, "utf8"));
  const source = `${prelude.join("")}${body}\nassert.sameValue(out, ${JSON.stringify(answer)});\n`;
  const result = await compile(source, runnerOptions());
  expect(result.errors.filter((error) => error.severity === "error")).toEqual([]);
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as () => void)();
    return "returned";
  } catch (error) {
    return (error as Error).constructor.name;
  }
}

describe.skipIf(!HARNESS.every((file) => existsSync(file)))("#7561 — through the real harness prelude", () => {
  it.each(VALUES.slice(0, 5))(
    "%s (inside a function)",
    async (_name, body) => {
      const program = inFunction(body);
      const answer = freshRealmOut(program);
      expect(await withPrelude(program, answer)).toBe("returned");
      expect(await withPrelude(program, `${answer}!`)).not.toBe("returned");
    },
    SLOW,
  );
});
