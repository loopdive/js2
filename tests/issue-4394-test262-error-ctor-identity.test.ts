// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4394 — a module that DECLARES `function Test262Error` (every literal
 * upstream-harness assembly does, via sta.js) must see the constructed error's
 * `.constructor` back-pointer as `===` the declaration.
 *
 * `new Test262Error(msg)` is intercepted by NAME in `new-builtin-globals.ts` and
 * lowered to a host import that builds a real `Error` subclass. Before this
 * fix the resulting object's `constructor` was that HOST class, while the
 * `Test262Error` identifier read the compiled closure — so `assert.throws`'
 * `thrown.constructor !== expectedErrorConstructor` was always true and the
 * harness's own self-tests reported the tell-tale
 * `Expected a Test262Error, but a "Test262Error" was thrown.`
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runJs(source: string): Promise<string[]> {
  const result = await compile(source, { fileName: "test.js" });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const logged: string[] = [];
  const imports = buildImports(result.imports, undefined, result.stringPool) as any;
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const { instance } = await WebAssembly.instantiate(result.binary!, imports);
    imports.setInstance?.(instance);
    imports.setExports?.(instance.exports);
    const exports = instance.exports as Record<string, unknown>;
    if (typeof exports.main === "function") (exports.main as () => void)();
  } finally {
    console.log = originalLog;
  }
  return logged;
}

/** The literal sta.js declaration, plus assert.js's throw site. */
const HARNESS_PRELUDE = `
function Test262Error(message) {
  if (!(this instanceof Test262Error)) return new Test262Error(message);
  this.message = message || "";
}
Test262Error.prototype.toString = function () {
  return "Test262Error: " + this.message;
};
Test262Error.thrower = function (message) {
  throw new Test262Error(message);
};
function assert(v, message) {
  if (v === true) return;
  throw new Test262Error(message || "boom");
}
`;

describe("#4394 — Test262Error constructor identity", () => {
  it("reports thrown.constructor === Test262Error for a module-declared harness ctor", async () => {
    const logged = await runJs(`${HARNESS_PRELUDE}
var e;
try { assert(false); } catch (err) { e = err; }
console.log("ctor: " + (e.constructor === Test262Error));
console.log("msg: " + e.message);
`);
    expect(logged).toContain("ctor: true");
    expect(logged).toContain("msg: boom");
  });

  it("satisfies assert.throws' constructor identity check", async () => {
    const logged = await runJs(`${HARNESS_PRELUDE}
function assertThrows(expectedErrorConstructor, func) {
  try {
    func();
  } catch (thrown) {
    if (typeof thrown !== "object" || thrown === null) return "not-an-object";
    if (thrown.constructor !== expectedErrorConstructor) return "wrong-ctor";
    return "ok";
  }
  return "no-throw";
}
console.log("throws: " + assertThrows(Test262Error, function () { throw new Test262Error("x"); }));
console.log("mismatch: " + assertThrows(Test262Error, function () { throw new TypeError("x"); }));
`);
    expect(logged).toContain("throws: ok");
    expect(logged).toContain("mismatch: wrong-ctor");
  });

  it("keeps the constructed value a real host Error (message, name, String())", async () => {
    const logged = await runJs(`${HARNESS_PRELUDE}
var e = new Test262Error("detail");
console.log("name: " + e.name);
console.log("message: " + e.message);
console.log("typeofCtor: " + typeof e.constructor);
`);
    expect(logged).toContain("name: Test262Error");
    expect(logged).toContain("message: detail");
    expect(logged).toContain("typeofCtor: function");
  });

  it("leaves the builtin Error family's constructor identity intact", async () => {
    const logged = await runJs(`${HARNESS_PRELUDE}
var e;
try { throw new TypeError("t"); } catch (err) { e = err; }
console.log("typeError: " + (e.constructor === TypeError));
console.log("notError: " + (e.constructor === Error));
`);
    expect(logged).toContain("typeError: true");
    expect(logged).toContain("notError: false");
  });
});
