// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7453: a thrown value's error KINDS come from the module (`__exn_render_kind`),
// never from splitting its rendered text at ": ". Before, `throw "TypeError: x"`
// and an object whose `toString` returns that text both read as a TypeError on
// the ordinary standalone and JS-environment lanes, so a runtime negative
// expecting TypeError passed. The kinds are the two a host value is read for,
// `name` then `constructor.name` (scripts/lib/wasm-exn-render.mjs).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { readThrownValue } from "../scripts/lib/wasm-exn-render.mjs";
import { runSyntheticTest262File } from "./test262-runner.ts";

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
  "a real TypeError": { body: `throw new TypeError("x");`, kinds: ["TypeError", "TypeError"] },
  "a TypeError whose message names another type": {
    body: `throw new TypeError("RangeError: x");`,
    kinds: ["TypeError", "TypeError"],
  },
  "an Error whose message names a TypeError": { body: `throw new Error("TypeError: x");`, kinds: ["Error", "Error"] },
  "a renamed TypeError (name and constructor differ)": {
    body: `const e = new TypeError("x"); e.name = "Foo"; throw e;`,
    kinds: ["Foo", "TypeError"],
  },
  "an Error subclass instance": {
    body: `class MyErr extends TypeError {} class Other extends TypeError {} throw new Other("x");`,
    kinds: ["TypeError", "Other"],
  },
  "an Error that renders as the empty string (kinds do not wait on the rendering)": {
    body: `const e = new TypeError(); e.name = ""; throw e;`,
    kinds: ["", "TypeError"],
  },
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
  "a constructor function inheriting TypeError.prototype": {
    body: `function E() {} E.prototype = Object.create(TypeError.prototype); throw new E();`,
    kinds: ["TypeError", "E"],
  },
  "an error class instance": {
    body: `class Test262Error { message: string; constructor(m: string) { this.message = m; } }
throw new Test262Error("TypeError: x");`,
    // Lowered to an `$Error_struct` sharing the `Error` tag: its name tells it apart from an Error.
    kinds: ["Test262Error", "Test262Error"],
  },
  "a subclass instance (not its parent)": {
    body: `class A {} class B extends A {} throw new B();`,
    kinds: ["B"],
  },
  "a class instance whose sibling has the same layout": {
    body: `class Foo { a = 1; } class Bar { a = 1; } throw new Bar();`,
    kinds: ["Bar"],
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
      const absent = await compile(source, options);
      const off = await compile(source, { ...options, exceptionKindExport: false });
      const optedIn = await compile(source, { ...options, exceptionKindExport: true });
      expect(Buffer.from(off.binary).equals(Buffer.from(absent.binary))).toBe(true);
      const names = (bytes: Uint8Array) => WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((e) => e.name);
      expect(names(absent.binary)).not.toContain("__exn_render_kind");
      expect(names(optedIn.binary)).toContain("__exn_render_kind");
    }
  });
});

// (#7459) The legacy wrapper lane asks the same runtime-negative rule as every other lane.
describe("#7459 runSyntheticTest262File runtime negatives", () => {
  const scratch = mkdtempSync(join(tmpdir(), "js2-issue-7459-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const META = `/*---\ndescription: runtime negative fixture\nnegative:\n  phase: runtime\n  type: TypeError\n---*/\n`;
  const verdict = async (name: string, body: string) => {
    const path = join(scratch, `${name}.js`);
    writeFileSync(path, META + body);
    return (await runSyntheticTest262File(path, "language", 20000, "standalone")).status;
  };

  it("passes a throw of the expected type", async () => {
    expect(await verdict("typeerror", `throw new TypeError("x");`)).toBe("pass");
  });
  it("fails a throw of any other value", async () => {
    expect(await verdict("string", `throw "TypeError: x";`)).toBe("fail");
    expect(await verdict("rangeerror", `throw new RangeError("TypeError");`)).toBe("fail");
  });
});
