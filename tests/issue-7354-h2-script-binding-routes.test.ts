// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 H2 — the routes to a script binding other than an identifier reference. A script `var` or function
// declaration is a property of the global object (§9.1.1.4, §16.1.7), so the global object as a value, dynamic code,
// `with`, `Object.defineProperty` and a parameter initializer (§10.2.11) reach it too. The Prepared path models only
// identifier writes (`preparedBindingRewritten`, module-binding-script-var.ts), which is sound because each of these
// routes refuses or aborts at its own site. Each program writes the binding through one route, then reads it: it must
// refuse or end at the run-time abort, never read a stale value. A slice that admits a route replaces its rows with
// node agreement: (#7471) `delete` of the binding answers `false` and writes nothing (the last block).
import { describe, expect, it } from "vitest";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { compile } from "../src/test262/test262-prepared-entry.js";
import { agreesWithNode, preparedOptions, yieldToRpc } from "./helpers/prepared-node-agreement.js";

const SLOW = 240_000;

const ROUTES: Record<string, (value: string) => string> = {
  "script `this`": (v) => `this.f = ${v};`,
  globalThis: (v) => `globalThis.f = ${v};`,
  self: (v) => `self.f = ${v};`,
  "direct eval": (v) => `eval("f = ${v}");`,
  "indirect eval": (v) => `(0, eval)("f = ${v}");`,
  Function: (v) => `Function("f = ${v}")();`,
  "new Function": (v) => `new Function("f = ${v}")();`,
  "x.constructor": (v) => `(function(){}).constructor("f = ${v}")();`,
  with: (v) => `var o = {}; with (o) { f = ${v}; }`,
  "with over an empty literal": (v) => `with ({}) { f = ${v}; }`,
  "with over a literal": (v) => `with ({ a: 1 }) { f = ${v}; }`,
  "a parameter initializer": (v) => `function p(a = (f = ${v})) { var f; } p();`,
  "sloppy-function `this`": (v) => `(function(){ this.f = ${v}; })();`,
  "Object.defineProperty": (v) => `Object.defineProperty(this, "f", { value: ${v} });`,
};

const BINDINGS: Record<string, (route: (value: string) => string) => string> = {
  "a called function declaration": (r) =>
    `function f(){ return 1; } ${r("function(){ return 2; }")} var out = String(f());`,
  "a function declaration read as a value": (r) =>
    `function f(){ return 1; } var g = f; ${r("function(){ return 2; }")} var out = String(f()) + typeof g;`,
  "a script var": (r) => `var f = 1; ${r("2")} var out = String(f);`,
  "a script var holding a function expression": (r) =>
    `var f = function(){ return 1; }; ${r("function(){ return 2; }")} var out = String(f());`,
};

const CASES = Object.entries(ROUTES).flatMap(([route, write]) =>
  Object.entries(BINDINGS).flatMap(([binding, program]) => [
    [route, binding, "at top level", program(write)],
    [route, binding, "inside a called function", program((v) => `function w(){ ${write(v)} } w();`)],
  ]),
);

/** "refused", "aborted" (the `unreachable` trap), or how the program ended otherwise. */
async function outcome(source: string): Promise<string> {
  await yieldToRpc();
  const result = await compile(source, preparedOptions());
  if (!result.success) return "refused";
  expect(WebAssembly.validate(result.binary)).toBe(true);
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as () => void)();
    return "returned";
  } catch (error) {
    const aborted = (error as Error).constructor.name === "RuntimeError" && (error as Error).message === "unreachable";
    return aborted ? "aborted" : `ended with ${(error as Error).constructor.name}`;
  }
}

describe("#7354 H2 — each route to a script binding refuses or aborts at its site", () => {
  it.each(CASES)(
    "%s writing %s %s",
    async (_route, _binding, _position, source) => {
      expect(["refused", "aborted"]).toContain(await outcome(source));
    },
    SLOW,
  );
});

// (#7471) `delete` of a declared script binding answers `false` and writes nothing (§13.5.1.2 steps 3-4, the binding
// non-configurable), so its route is node agreement now.
describe("#7354 H2 — delete of a script binding writes nothing", () => {
  it.each(
    Object.entries(BINDINGS).flatMap(([binding, program]) => [
      [binding, "at top level", `${program(() => "var d = delete f;")} out = out + String(d);`],
      [
        binding,
        "inside a called function",
        `${program(() => "function w(){ return delete f; } var d = w();")} out = out + String(d);`,
      ],
    ]),
  )("answers %s %s as node does", (_binding, _position, source) => agreesWithNode(source), SLOW);
});
