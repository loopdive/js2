// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6417 — five independent mechanisms behind the axios upstream residual, each
// reduced to an untyped `.js` package half plus a typed entry (the shape the
// upstream npm suites compile). Every `was ✗` case answered wrongly on the
// parent commit; the `control` cases passed there and must keep passing — a
// fix that answered a constant would fail them.
//
//   1. A host-invoked callback whose TS result is `boolean` returned the raw
//      i32: `assert.throws(fn, (err) => err.code === "X")` saw `1` and threw
//      "The validation function is expected to return "true". Received 1"
//      (axios fromDataURI / transformResponse).
//   2. `typeof importedBinding` folded to "undefined": the import's symbol is
//      the ALIAS, which has no valueDeclaration (axios buildURL `typeof encode`).
//   3. A callable property whose stored closure widened an OMITTABLE formal to
//      externref (`@param {number} [position]`, TS `function f(x?: number)`)
//      was dispatched only through the declared-f64 arm and threw "Cannot
//      access property on null or undefined" (axios `utils.endsWith`, which
//      broke every object/array/date param of `buildURL`).
//   4. A compiled Date handed to a dynamic host method call crossed as the
//      generic struct facade: `Object.prototype.toString.call(d)` answered
//      `[object Object]` (axios `kindOf`/`isDate`).
//   5. `X.prototype.toString = function (encoder) {…}` was stored through the
//      fixed ZERO-arity bridge, so `x.toString(enc)` lost `enc` (axios
//      `AxiosURLSearchParams.prototype.toString(encoder)`).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports, wrapExports } from "../src/runtime.js";
import { getWebHostConstructors } from "../src/runtime/web-host-constructors.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const MOD = `export class CodedError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
export function boom() {
  throw new CodedError("bad", "ERR_X");
}

export function encode(val) {
  return "enc:" + val;
}

/**
 * @param {String} str
 * @param {String} searchString
 * @param {Number} [position= 0]
 * @returns {boolean}
 */
const endsWith = (str, searchString, position) => {
  str = String(str);
  if (position === undefined || position > str.length) {
    position = str.length;
  }
  position -= searchString.length;
  const lastIndex = str.indexOf(searchString, position);
  return lastIndex !== -1 && lastIndex === position;
};
export default { endsWith };

const { toString } = Object.prototype;
export function tagOf(thing) {
  return toString.call(thing);
}
export function makeDate() {
  return new Date(0);
}

function Params(value) {
  this._value = value;
}
Params.prototype.toString = function toString(encoder) {
  return encoder ? encoder(this._value) : "plain:" + this._value;
};
export function render(value, encoder) {
  return new Params(value).toString(encoder);
}`;

const OPTIONAL_TS = `function maybe(position?: number): string {
  return position === undefined ? "undef" : "num:" + position;
}
export default { maybe };`;

const ENTRY = `import assert from "assert";
import utils, { boom, encode, makeDate, render, tagOf } from "./mod.js";
import optional from "./optional";

function attempt(fn: () => unknown): string {
  try {
    return String(fn());
  } catch (e) {
    return "THROW " + String(e).slice(0, 80);
  }
}

export function validatorEquality(): string {
  return attempt(() => {
    assert.throws(() => boom(), (err) => err.code === "ERR_X");
    return "ok";
  });
}
export function validatorBlock(): string {
  return attempt(() => {
    assert.throws(() => boom(), (err) => {
      return err.code === "ERR_X";
    });
    return "ok";
  });
}
export function validatorFalse(): string {
  return attempt(() => {
    assert.throws(() => boom(), (err) => err.code === "ERR_OTHER");
    return "ok";
  });
}

export function typeofImported(): string {
  return typeof encode;
}
export function typeofImportedCompare(): string {
  return String(typeof encode === "function");
}
export function typeofUndeclared(): string {
  return typeof (globalThis as any).__js2NotDeclared6417;
}

export function endsWithHit(): string {
  return attempt(() => utils.endsWith("foo{}", "{}"));
}
export function endsWithMiss(): string {
  return attempt(() => utils.endsWith("foo", "{}"));
}
export function optionalGiven(): string {
  return attempt(() => optional.maybe(3));
}
export function optionalOmitted(): string {
  return attempt(() => optional.maybe());
}

export function dateTag(): string {
  return tagOf(makeDate());
}
export function objectTag(): string {
  return tagOf({ a: 1 });
}

export function toStringWithEncoder(): string {
  return attempt(() => render("v", (x: unknown) => "E(" + x + ")"));
}
export function toStringWithoutEncoder(): string {
  return attempt(() => render("v", undefined));
}`;

type Exports = Record<string, () => unknown>;
let cached: Promise<Exports> | undefined;

function compiled(): Promise<Exports> {
  cached ??= (async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-6417-"));
    roots.push(root);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "mod.js"), MOD);
    writeFileSync(join(root, "optional.ts"), OPTIONAL_TS);
    writeFileSync(join(root, "entry.ts"), ENTRY);
    const result = await compileProject(join(root, "entry.ts"), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "web",
      experimentalIR: true,
      emitWat: false,
      deferTopLevelInit: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const imports = buildCompiledImports(result, getWebHostConstructors());
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    return wrapExports(instance, { signatures: result.exportSignatures }) as unknown as Exports;
  })();
  return cached;
}

describe("#6417 axios residual mechanisms", () => {
  it("a host-invoked boolean callback returns a JS boolean (expression body) — was ✗", async () => {
    expect((await compiled()).validatorEquality()).toBe("ok");
  });
  it("a host-invoked boolean callback returns a JS boolean (block body) — was ✗", async () => {
    expect((await compiled()).validatorBlock()).toBe("ok");
  });
  it("control: a validator answering false still fails assert.throws", async () => {
    expect((await compiled()).validatorFalse()).toMatch(/^THROW /);
  });

  it("typeof an imported function is 'function' — was ✗", async () => {
    expect((await compiled()).typeofImported()).toBe("function");
  });
  it("typeof an imported function compares equal to 'function' — was ✗", async () => {
    expect((await compiled()).typeofImportedCompare()).toBe("true");
  });
  it("control: typeof an absent global property stays 'undefined'", async () => {
    expect((await compiled()).typeofUndeclared()).toBe("undefined");
  });

  it("a JSDoc-optional formal in a default-export object is callable — was ✗", async () => {
    expect((await compiled()).endsWithHit()).toBe("true");
  });
  it("the same callee answers false (not true, not a throw) for a miss — was ✗", async () => {
    expect((await compiled()).endsWithMiss()).toBe("false");
  });
  it("a TS optional formal of a function declaration in an object is callable — was ✗", async () => {
    const exports = await compiled();
    expect(exports.optionalGiven()).toBe("num:3");
    expect(exports.optionalOmitted()).toBe("undef");
  });

  it("a compiled Date reaches a host method call as a Date — was ✗", async () => {
    expect((await compiled()).dateTag()).toBe("[object Date]");
  });
  it("control: a plain object still tags as Object", async () => {
    expect((await compiled()).objectTag()).toBe("[object Object]");
  });

  it("a prototype toString keeps its argument — was ✗", async () => {
    expect((await compiled()).toStringWithEncoder()).toBe("E(v)");
  });
  it("control: the no-argument toString takes the default branch", async () => {
    expect((await compiled()).toStringWithoutEncoder()).toBe("plain:v");
  });
});
