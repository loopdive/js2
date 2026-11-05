// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7234 — `classNameIsAmbiguous` counted only class names, so a second
// binding of the name (`const C = class {}`, `let C`, `function C(){}`, a
// parameter, a catch binding, a destructured `{ C }`, an import) did not make
// the name ambiguous. The private-static arms key class shapes by NAME, so
// the IR claimed `C.#m()` / `C.#x` against whichever shape owned `C`: for the
// `const C = class {}` repro every lane failed to compile ("prepared implicit
// constructor C_new has no exact installed support pair").
//
// Each case pins the legacy route of the static method that reads the private
// member (`trackIrOutcomes`) and the value the legacy path produces on
// standalone, WASI and the default gc target. Where legacy agrees with JS the
// JS value is the expectation; the two same-named-class repros trap on the
// IR-free path too (a pre-existing legacy bug), so that trap is what is pinned.
import { describe, expect, it } from "vitest";
import { compile, type CompileOptions } from "../../src/index.js";
import { classNameIsAmbiguous } from "../../src/ir/private-member-syntax.js";
import { ts } from "../../src/ts-api.js";
import { evaluateAsJs, instantiateWithRuntime } from "./helpers.js";

const LANES: { name: string; options: CompileOptions }[] = [
  { name: "standalone", options: { target: "standalone" } },
  { name: "wasi", options: { target: "wasi" } },
  { name: "gc (default)", options: {} },
];

const wasiStub = new Proxy({}, { get: () => () => 0 });

async function compileAndRun(source: string, options: CompileOptions) {
  const result = await compile(source, { fileName: "issue-7234.js", trackIrOutcomes: true, ...options });
  const hard = result.errors.filter((e) => e.severity !== "warning");
  expect(result.success, hard.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const instance =
    options.target === "standalone"
      ? (await WebAssembly.instantiate(result.binary, {})).instance
      : options.target === "wasi"
        ? (await WebAssembly.instantiate(result.binary, { wasi_snapshot_preview1: wasiStub })).instance
        : await instantiateWithRuntime(result);
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  return { result, exports };
}

function route(result: Awaited<ReturnType<typeof compile>>, unit: string): string | undefined {
  return result.irOutcomes?.find((o) => o.displayName === unit)?.kind;
}

interface Case {
  readonly source: string;
  /** Legacy (IR-free) path traps here; pin the trap instead of the JS value. */
  readonly legacyTraps?: boolean;
}

const CASES: Record<string, Case> = {
  "const C = class {} in a function (the #7234 repro)": {
    source: `
class C { static #m() { return 1 } static a() { return C.#m() } }
function f() { const C = class { static #m() { return 12 } static a() { return C.#m() } }; return C.a(); }
export function test() { return f(); }`,
    legacyTraps: true,
  },
  "let C = class {} in a function": {
    source: `
class C { static #m() { return 1 } static a() { return C.#m() } }
function f() { let C = class { static #m() { return 13 } static a() { return C.#m() } }; return C.a(); }
export function test() { return f() + C.a(); }`,
    legacyTraps: true,
  },
  "function C(){} in a sibling scope": {
    source: `
function g() { function C() { return 5 } return C(); }
class C { static #m() { return 3 } static a() { return C.#m() } }
export function test() { return g() + C.a(); }`,
  },
  "parameter named C": {
    source: `
class C { static #m() { return 4 } static a() { return C.#m() } }
function g(C) { return C + 1; }
export function test() { return g(10) + C.a(); }`,
  },
  "catch binding named C": {
    source: `
class C { static #m() { return 6 } static a() { return C.#m() } }
function g() { try { throw 2 } catch (C) { return C } }
export function test() { return g() + C.a(); }`,
  },
  "destructured { C }": {
    source: `
class C { static #m() { return 7 } static a() { return C.#m() } }
function g(o) { const { C } = o; return C; }
export function test() { return g({ C: 30 }) + C.a(); }`,
  },
  "static private field read through a shadowed name": {
    source: `
class C { static #x = 8; static a() { return C.#x } }
function g() { const C = 40; return C; }
export function test() { return g() + C.a(); }`,
  },
};

describe("#7234 classNameIsAmbiguous counts every binding of the name", () => {
  for (const [label, testCase] of Object.entries(CASES)) {
    for (const lane of LANES) {
      it(`${label} — ${lane.name}`, async () => {
        const { result, exports } = await compileAndRun(testCase.source, lane.options);
        expect(route(result, "C_a")).not.toBe("emitted");
        if (testCase.legacyTraps) {
          expect(() => exports.test!()).toThrow(WebAssembly.RuntimeError);
          return;
        }
        const js = evaluateAsJs(testCase.source) as Record<string, () => unknown>;
        expect(exports.test!()).toBe(js.test!());
      });
    }
  }

  it("a uniquely bound class name still takes the IR route", async () => {
    const source = `
class C { static #m() { return 9 } static a() { return C.#m() } static #x = 2; static b() { return this.#x + this.#m() } }
export function test() { return C.a() + C.b(); }`;
    for (const lane of LANES) {
      const { result, exports } = await compileAndRun(source, lane.options);
      expect(route(result, "C_a"), lane.name).toBe("emitted");
      expect(route(result, "C_b"), lane.name).toBe("emitted");
      expect(exports.test!(), lane.name).toBe(20);
    }
  });

  // Import bindings live at module scope, so a same-named class can only sit
  // in a nested scope, which the class-member IR does not claim today; the
  // predicate itself is pinned so a future nested-class claim cannot miss them.
  it("counts import, namespace-import and import-equals bindings", () => {
    const ambiguous = (text: string): boolean => {
      const file = ts.createSourceFile("t.ts", text, ts.ScriptTarget.ES2022, true);
      return classNameIsAmbiguous(file, "C");
    };
    const nested = "function g() { class C { static #m() { return 1 } } }";
    expect(ambiguous(`import { C } from "./m.js"; ${nested}`)).toBe(true);
    expect(ambiguous(`import { D as C } from "./m.js"; ${nested}`)).toBe(true);
    expect(ambiguous(`import { C as D } from "./m.js"; ${nested}`)).toBe(false);
    expect(ambiguous(`import C from "./m.js"; ${nested}`)).toBe(true);
    expect(ambiguous(`import * as C from "./m.js"; ${nested}`)).toBe(true);
    expect(ambiguous(`import C = require("./m"); ${nested}`)).toBe(true);
    expect(ambiguous(`const { C: D } = o; ${nested}`)).toBe(false);
    expect(ambiguous(`const f = function C() {}; ${nested}`)).toBe(true);
    expect(ambiguous(nested)).toBe(false);
  });
});
