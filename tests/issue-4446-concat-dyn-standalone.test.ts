// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4446) `Array.prototype.concat` with a DYNAMIC operand must lower natively
// under `--target standalone`.
//
// `compileArrayConcatExtern` — the fallback taken whenever an operand is not a
// statically-known WasmGC array (an `any`-typed receiver, an array-like, an
// object carrying `Symbol.isConcatSpreadable`) — delegated the whole operation
// to the JS host via `env::__array_concat_any` plus `env::__js_array_new` /
// `env::__js_array_push`. Host-free those are unsatisfiable imports, so the
// #2961 strict leak guard turned every such call into a standalone
// compile_error: 28 of the 69 `built-ins/Array/prototype/concat` test262 files
// reported `standalone target emitted host imports: env::__array_concat_any…`.
//
// The replacement (`compileArrayConcatNativeSpec`) walks §23.1.3.1 directly
// over the dynamic-object substrate — `__extern_get` + `__box_symbol` for the
// `@@isConcatSpreadable` read, `__extern_is_array` for the IsArray default,
// `__extern_length` for `Get(E,"length")` + ToLength (§7.1.20, including the
// observable valueOf/toString walk and its abrupt propagation),
// `__extern_get_idx` per element, and the `$ObjVec` builders for the result.
//
// The load-bearing assertion in every case below is the LEAK one: the emitted
// standalone module must carry ZERO `env::` imports (mirrors the
// `envImportNames` WAT scan in tests/issue-2961.test.ts). A behavioural
// assertion alone would not catch a regression that silently re-routes the
// call back to the host bridge, because the host bridge is *also* correct —
// it just cannot be instantiated standalone.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** Extract `env` import names from WAT (same scan as tests/issue-2961.test.ts). */
function envImportNames(wat: string): string[] {
  const out: string[] = [];
  const re = /\(import\s+"env"\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(wat)) !== null) out.push(m[1]!);
  return out;
}

async function compileJs(src: string, target: "standalone" | "gc") {
  const r = await compile(src, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(target === "standalone" ? { target: "standalone" as const } : {}),
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  return r;
}

async function run(src: string, target: "standalone" | "gc"): Promise<unknown> {
  const r = await compileJs(src, target);
  const imports = target === "standalone" ? {} : buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test: () => unknown }).test();
}

/** Compile standalone and return the leaked `env::` import names (expected: none). */
async function standaloneEnvImports(src: string): Promise<string[]> {
  const r = await compileJs(src, "standalone");
  return envImportNames(r.wat);
}

// ── The four fixtures from the #4446 Validation section ────────────────────

/** `any`-typed receiver: `Array.prototype.concat.call(arrayLike, …)`-shaped. */
const ANY_RECEIVER = `
var recv = [1, 2];
var arg = {};
export function test() {
  var out = recv.concat(arg);
  return out.length;
}`;

/**
 * An ARRAY with a falsy `@@isConcatSpreadable`. Carried for the LEAK assertion
 * only — see the `RESIDUAL` note on the semantics block below: a vec-backed
 * receiver does not expose symbol-keyed own properties through `__extern_get`,
 * so the IsArray default wins and this operand is still spread. That gap is in
 * the symbol/vec property channel (#2866-adjacent), not in the concat loop, and
 * it reproduces identically on the untouched gc lane.
 */
const SPREADABLE_FALSE_ARRAY = `
var item = [1, 2, 3];
item[Symbol.isConcatSpreadable] = false;
export function test() {
  var out = [].concat(item);
  return out.length;
}`;

/** A non-array array-like with a FALSY `@@isConcatSpreadable` is appended whole. */
const SPREADABLE_FALSE_OBJECT = `
var item = { length: 3, 0: 1, 1: 2, 2: 3 };
item[Symbol.isConcatSpreadable] = false;
export function test() {
  var out = [].concat(item);
  return out.length;
}`;

/** A non-array array-like with a truthy `@@isConcatSpreadable` IS spread. */
const SPREADABLE_ARRAY_LIKE = `
var obj = { length: 3, 0: "a", 1: "b", 2: "c" };
obj[Symbol.isConcatSpreadable] = true;
export function test() {
  var out = [9].concat(obj);
  return out.length;
}`;

/** A throwing `length` getter propagates out of ToLength (§7.1.20 abrupt). */
const LENGTH_GETTER_THROWS = `
var obj = {};
obj[Symbol.isConcatSpreadable] = true;
Object.defineProperty(obj, "length", {
  get: function () { throw new TypeError("boom"); },
});
export function test() {
  try {
    [].concat(obj);
  } catch (e) {
    return 42;
  }
  return 0;
}`;

const FIXTURES: [string, string][] = [
  ["any-typed receiver + object argument", ANY_RECEIVER],
  ["array with isConcatSpreadable=false", SPREADABLE_FALSE_ARRAY],
  ["object with isConcatSpreadable=false", SPREADABLE_FALSE_OBJECT],
  ["spreadable array-like object", SPREADABLE_ARRAY_LIKE],
  ["throwing length getter", LENGTH_GETTER_THROWS],
];

describe("#4446 — dynamic Array.prototype.concat lowers host-free under --target standalone", () => {
  describe("no host-import leak (the #2961 guard)", () => {
    for (const [name, src] of FIXTURES) {
      it(`${name} emits zero env:: imports`, async () => {
        const leaked = await standaloneEnvImports(src);
        expect(leaked, `leaked host imports: ${leaked.join(", ")}`).toEqual([]);
      });
    }

    it("specifically none of the three retired concat host imports appears", async () => {
      // The exact trio the issue names. Pinned separately from the blanket
      // "zero imports" assertion so a future, deliberately-allowlisted import
      // elsewhere in the module cannot mask a concat regression.
      const retired = ["__array_concat_any", "__js_array_new", "__js_array_push"];
      for (const [, src] of FIXTURES) {
        const leaked = await standaloneEnvImports(src);
        for (const name of retired) expect(leaked).not.toContain(name);
      }
    });
  });

  describe("§23.1.3.1 semantics", () => {
    it("a non-spreadable object argument is appended as one element", async () => {
      // IsConcatSpreadable({}) → Get(@@isConcatSpreadable) is undefined →
      // IsArray({}) is false → the object itself is element 2.
      expect(await run(ANY_RECEIVER, "standalone")).toBe(3);
    });

    it("an OBJECT with a falsy @@isConcatSpreadable is NOT spread", async () => {
      // The pre-#4446 native shortcut spread every operand it took
      // unconditionally — the is-concat-spreadable-val-falsey signature.
      expect(await run(SPREADABLE_FALSE_OBJECT, "standalone")).toBe(1);
    });

    it("RESIDUAL: a vec-backed ARRAY still ignores its @@isConcatSpreadable", async () => {
      // Pins the KNOWN GAP so it cannot regress silently in either direction.
      // `item[Symbol.isConcatSpreadable] = false` on a vec receiver does not
      // reach the symbol-key channel that `__extern_get` reads, so
      // IsConcatSpreadable falls through to IsArray → true → spread. The set
      // currently lands on numeric index 6 instead, which is why `item.length`
      // is 7 and the concat result has 7 elements. Measured identically on the
      // untouched gc lane (`item.length === 7` there too), so this is the
      // symbol/vec property channel, NOT the #4446 concat loop.
      expect(await run(SPREADABLE_FALSE_ARRAY, "standalone")).toBe(7);
      expect(
        await run(
          `var item=[1,2,3]; item[Symbol.isConcatSpreadable]=false;
        export function test(){ return item.length; }`,
          "gc",
        ),
      ).toBe(7);
    });

    it("an array-like with a truthy @@isConcatSpreadable IS spread", async () => {
      expect(await run(SPREADABLE_ARRAY_LIKE, "standalone")).toBe(4);
    });

    it("a throwing length getter propagates (ToLength is observable)", async () => {
      expect(await run(LENGTH_GETTER_THROWS, "standalone")).toBe(42);
    });
  });

  describe("the JS-host (gc) lane keeps its host bridge", () => {
    it("gc still routes the dynamic fallback through env::__array_concat_any", async () => {
      // #4446 switches the fallback PER TARGET; the gc path is deliberately
      // unchanged (it is faster and complete there). This pins that the switch
      // did not leak into the host lane.
      const r = await compileJs(ANY_RECEIVER, "gc");
      expect(envImportNames(r.wat)).toContain("__array_concat_any");
    });

    it("gc's own answer for this shape is byte-for-byte what it was", async () => {
      // Deliberately NOT `toBe(3)`. The gc host bridge already answered 1 for
      // this program before #4446 (its `.length` read of the returned host
      // Array is a separate, pre-existing defect), and an A/B against
      // `git show HEAD:src/codegen/array-methods.ts` reproduced 1 on both
      // sides. Pinning the OBSERVED value is what proves the per-target switch
      // left the host lane untouched; pinning the SPEC value here would just
      // be a red test about someone else's bug.
      expect(await run(ANY_RECEIVER, "gc")).toBe(1);
    });
  });
});
