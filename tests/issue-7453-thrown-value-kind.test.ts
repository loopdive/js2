// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7453: a thrown value's error KIND comes from the module (`__exn_render_kind`),
// never from splitting its rendered text at ": ". Before, `throw "TypeError: x"`
// and an object whose `toString` returns that text both read as a TypeError on
// the ordinary standalone and JS-environment lanes, so a runtime negative
// expecting TypeError passed.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { readThrownValue } from "../scripts/lib/wasm-exn-render.mjs";

// The test262 harness's compile options: it inspects the module from JS.
const HARNESS = { hostBridge: "always", exceptionKindExport: true } as const;

const THROWS: Record<string, { body: string; kinds: string[] }> = {
  "a string that reads like a TypeError": { body: `throw "TypeError: x";`, kinds: [] },
  "an object whose toString reads like a TypeError": {
    // A closed object-literal struct: no constructor the module can name.
    body: `throw { toString: function () { return "TypeError: x"; } };`,
    kinds: [],
  },
  "a number": { body: `throw 1;`, kinds: [] },
  "a real TypeError": { body: `throw new TypeError("x");`, kinds: ["TypeError"] },
  "a TypeError whose message names another type": {
    body: `throw new TypeError("RangeError: x");`,
    kinds: ["TypeError"],
  },
  "an Error whose message names a TypeError": { body: `throw new Error("TypeError: x");`, kinds: ["Error"] },
  "a constructor function's instance": {
    body: `function Test262Error(message) { this.message = message || ""; }
throw new Test262Error("TypeError");`,
    kinds: ["Test262Error"],
  },
  "the harness's Test262Error (its prototype carries toString)": {
    body: `function Test262Error(message) { this.message = message || ""; }
Test262Error.prototype.toString = function () { return "Test262Error: " + this.message; };
throw new Test262Error("TypeError");`,
    kinds: ["Test262Error"],
  },
  "an error class instance": {
    body: `class Test262Error { message: string; constructor(m: string) { this.message = m; } }
throw new Test262Error("TypeError: x");`,
    kinds: ["Test262Error"],
  },
};

async function thrownBy(body: string, target: "gc" | "standalone") {
  const source = `export function test(): number { run(); return 1; }\nfunction run(): void { ${body} }`;
  const r = await compile(source, { ...HARNESS, ...(target === "standalone" ? { target } : {}) });
  expect(r.success, r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const imports = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  try {
    (instance.exports.test as () => number)();
  } catch (err) {
    return readThrownValue(err, { instance });
  }
  throw new Error("expected a throw");
}

describe("#7453 a thrown value's kind is the module's own answer", () => {
  for (const target of ["standalone", "gc"] as const)
    for (const [label, { body, kinds }] of Object.entries(THROWS))
      it(`${target}: ${label}`, async () => {
        expect((await thrownBy(body, target)).kinds).toEqual(kinds);
      });

  it("is a harness opt-in: production binaries are unchanged", async () => {
    const source = `export function f(x: number): number { if (x) throw new TypeError("x"); return 1; }`;
    for (const target of ["standalone", undefined] as const) {
      const options = target ? { target } : {};
      const plain = await compile(source, options);
      const optedIn = await compile(source, { ...options, exceptionKindExport: true });
      const names = (bytes: Uint8Array) => WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((e) => e.name);
      expect(names(plain.binary)).not.toContain("__exn_render_kind");
      expect(names(optedIn.binary)).toContain("__exn_render_kind");
    }
  });
});
