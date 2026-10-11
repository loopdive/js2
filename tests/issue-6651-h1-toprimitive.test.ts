// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 cluster H, slice H1 — spec ToString / ToInteger of a String.prototype
// ARGUMENT on `--target standalone` (§7.1.17, §7.1.5, §7.1.1, §7.1.1.1).
//
// Rows (test262, all ES2015): built-ins/String/prototype/indexOf/
//   {searchstring-tostring-errors, searchstring-tostring-toprimitive,
//    position-tointeger-errors, position-tointeger-toprimitive}.js
//
// THE CAUSES (each measured red on the reverted sources):
//  1. An object-LITERAL argument went through the compile-time struct
//     dispatchers, which only resolve shapes they can name: a non-callable
//     `valueOf` answered NaN instead of being skipped (§7.1.1.1 step 2.b), and
//     two non-callable members answered "[object Object]"/NaN instead of
//     throwing (step 3). It now takes the runtime §7.1.1 walk, which is armed to
//     FINISH the algorithm in such a module (class-to-primitive.ts).
//  2. `Object(sym)` went through the lenient `__extern_toString` (which renders
//     a Symbol, as `String(sym)` must). An argument's ToString is the spec one:
//     the intrinsic `Symbol.prototype[@@toPrimitive]` answers the Symbol, and
//     ToString of it throws.
//  3. A `toString`/`valueOf` returning a Symbol was boxed as the NUMBER its i32
//     handle is carried as, so ToString rendered a digit instead of throwing.
//
// No eval anywhere: CI's changed-test lane runs a refusal-only eval provider.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

/** Compile loose test262-shaped source standalone and answer `__r`. */
async function run(body: string): Promise<number> {
  const source = `var __r = 0;\n${body}\nexport function run() { return __r; }\n`;
  const r = await compile(source, {
    target: "standalone",
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaked = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  expect(leaked, `--target standalone leaked env imports: ${leaked.join(", ")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as Record<string, () => number>;
  ex.__module_init?.();
  return ex.run!();
}

const TE = `var b = 0;
function te(bit, f) { try { f(); } catch (e) { if (e instanceof TypeError) b |= bit; } }
`;

describe("#6651 H1 — ToString(searchString) is the spec one", () => {
  it("a Symbol wrapper, and a method returning a Symbol, throw a TypeError", async () => {
    expect(
      await run(`${TE}
te(1, function () { "".indexOf(Object(Symbol("1"))); });
te(2, function () { "".indexOf({ toString: function () { return Symbol("1"); } }); });
te(4, function () { "".indexOf({ valueOf: function () { return Symbol("1"); }, toString: null }); });
te(8, function () { "".indexOf(Symbol("1")); });
__r = b;`),
    ).toBe(15);
  });

  it("§7.1.1.1: a non-callable toString is skipped; two non-callable members throw", async () => {
    expect(
      await run(`${TE}
if ("__foo__".indexOf({ toString: 1, valueOf: function () { return "foo"; } }) === 2) b |= 1;
if ("__foo__".indexOf({ toString: {}, valueOf: function () { return "foo"; } }) === 2) b |= 2;
te(4, function () { "".indexOf({ valueOf: null, toString: null }); });
te(8, function () { "".indexOf({ valueOf: 1, toString: 1 }); });
te(16, function () { "".indexOf({ valueOf: {}, toString: {} }); });
__r = b;`),
    ).toBe(31);
  });

  // Negative controls: the shapes that already worked must keep their answers.
  it("controls — callable toString, absent own toString, a user @@toPrimitive on a wrapper; String() residual pin", async () => {
    expect(
      await run(`var b = 0;
if ("__foo__".indexOf({ toString: function () { return "foo"; }, valueOf: function () { throw 1; } }) === 2) b |= 1;
// no OWN toString: Object.prototype.toString answers, valueOf is unreachable
if ("x[object Object]".indexOf({ valueOf: function () { return "q"; } }) === 1) b |= 2;
var w = Object(Symbol("s"));
w[Symbol.toPrimitive] = function () { return "a"; };
if ("xa".indexOf(w) === 1) b |= 4;
// RESIDUAL pin, spec-WRONG on purpose: String(wrapper) is ToString(object), so
// §7.1.1 answers the Symbol and it should throw. This slice leaves String()
// on the lenient provider; the lane that fixes it must update this line.
if (String(Object(Symbol("z"))) === "Symbol(z)") b |= 8;
// a toString returning a BOOLEAN renders "true", not the number its i32 carries
// (the one regression the first cut of this slice had: String/concat S15.5.4.6_A1_T10)
if ("lego".concat({ toString: function () { return true; } }) === "legotrue") b |= 16;
// …and a valueOf returning NULL (after a skipped own toString) is the primitive null
// (the second: indexOf/searchstring-tostring-wrapped-values)
if ("__null__".indexOf({ valueOf: function () { return null; }, toString: null }) === 2) b |= 32;
__r = b;`),
    ).toBe(63);
  });
});

describe("#6651 H1 — ToIntegerOrInfinity(position) through ToPrimitive(number)", () => {
  it("§7.1.1.1: a non-callable valueOf is skipped", async () => {
    expect(
      await run(`var b = 0;
if ("aaaa".indexOf("aa", { valueOf: null, toString: function () { return 1; } }) === 1) b |= 1;
if ("aaaa".indexOf("aa", { valueOf: 1, toString: function () { return 1; } }) === 1) b |= 2;
if ("aaaa".indexOf("aa", { valueOf: {}, toString: function () { return 1; } }) === 1) b |= 4;
__r = b;`),
    ).toBe(7);
  });

  it("two non-callable members, or a Symbol result, throw a TypeError", async () => {
    expect(
      await run(`${TE}
te(1, function () { "".indexOf("", { valueOf: null, toString: null }); });
te(2, function () { "".indexOf("", { valueOf: 1, toString: 1 }); });
te(4, function () { "".indexOf("", { valueOf: {}, toString: {} }); });
te(8, function () { "".indexOf("", { valueOf: function () { return Symbol("1"); } }); });
te(16, function () { "".indexOf("", { toString: function () { return Symbol("1"); } }); });
__r = b;`),
    ).toBe(31);
  });

  it("controls — callable valueOf wins, and a plain object is NaN → 0", async () => {
    expect(
      await run(`var b = 0;
if ("aaaa".indexOf("aa", { valueOf: function () { return 1; }, toString: function () { return 3; } }) === 1) b |= 1;
if ("aaaa".indexOf("a", {}) === 0) b |= 2;
if ("aaaa".charAt({ valueOf: function () { return 2; } }) === "a") b |= 4;
__r = b;`),
    ).toBe(7);
  });
});
