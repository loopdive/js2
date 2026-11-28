// #7628 v3 fact rows: `npx tsx rows3.mts` from a tree root (base, v2 or v3). stop = fold false.
// A row is a source, or a map of sources whose entry is the `./entry.*` key (`.ts` for TS-only declarations).
import { readFileSync } from "node:fs";
import { analyzeMultiSource } from "../../src/checker/index.js";
import { foldsBuiltinMember } from "../../src/ir/builtin-global-binding.js";
import { ts } from "../../src/frontend/typescript.js";
const D = '(1).constructor, "isNaN", {value: 1}';
const CMP = "function cmp(a, b) { for (var i = 0; i < a.length; i++) { if (!same(b[i], a[i])) return false; } return true; } function same(x, y) { return x === y; } cmp([1], [1]);";
type Row = [string, "stop" | "keep", string | Record<string, string>];
const ROWS: Row[] = [
  ["six-1", "stop", `Object["define" + "Property"](${D});`],
  ["six-2", "stop", `var p = "Property"; Object[\`define\${p}\`](${D});`],
  ["six-3", "stop", '(1).constructor["__define" + "Getter__"]("isNaN", function () {});'],
  ["six-4", "stop", `var {["define" + "Property"]: d} = Object; d(${D});`],
  ["six-5", "stop", `var d; ({["define" + "Property"]: d} = Object); d(${D});`],
  ["six-6", "stop", `Object.getOwnPropertyNames(Object).forEach(function (n) { Object[n](${D}); });`],
  ["B1 globalThis.Reflect", "stop", 'globalThis.Reflect.set((1).constructor, "isNaN", 1);'],
  ["B1 this[\"Reflect\"]", "stop", 'this["Reflect"].set((1).constructor, "isNaN", 1);'],
  ["B1 Ref+lect", "stop", 'globalThis["Ref" + "lect"].set((1).constructor, "isNaN", 1);'],
  ["B2 import", "stop", { "./entry.js": `import { q as p } from "./m.js"; Object["define" + p](${D});`, "./m.js": 'export var q = "Property";' }],
  ["B2 import + by-text var", "stop", { "./entry.js": `import { q as p } from "./m.js"; Object["define" + p](${D});`, "./m.js": 'export var q = "Property"; var p = "Xyz";' }],
  ["B2 undeclared", "stop", `Object["define" + suffix](${D});`],
  ["B2 arguments", "stop", `var arguments = "Xyz"; function f() { arguments.toString = function () { return "define" + "Property"; }; Object[arguments](${D}); } f();`],
  ["B3 long chain keep", "keep", 'var s = ""; for (var j = 0; j < 100; j++) s = s + "x"; ({})[s];'],
  ["B3 long literal keep", "keep", `({})[${Array.from({ length: 200 }, (_, i) => `"k${i}"`).join(" + ")}];`],
  ["B3 two-letter growth stop", "stop", 'var s = ""; s = s + "x"; s = s + "y"; ({})[s];'],
  ["B3 cap during product (cost)", "stop", `var p = "a0"; ${Array.from({ length: 8 }, (_, i) => `p = "a${i + 1}";`).join(" ")} ({})[p + p + p];`],
  ["holes fresh inherited", "stop", 'var g = ({})["__define" + "Getter__"]; g.call((1).constructor, "isNaN", function () {});'],
  ["holes nested pattern", "stop", `var [{["define" + "Property"]: d}] = [Object]; d(${D});`],
  ["holes for-of pattern", "stop", `for (var {["define" + "Property"]: d} of [Object]) d(${D});`],
  ["holes param default", "stop", `function f({["define" + "Property"]: d} = {}) { d(${D}); } f(Object);`],
  ["holes this.p", "stop", `var p = "Xyz"; this.p = "Property"; Object["define" + p](${D});`],
  ["holes globalThis[p]", "stop", `var p = "Xyz"; globalThis["p"] = "Property"; Object["define" + p](${D});`],
  ["holes defineProperty(this)", "stop", `var i = 0; Object.defineProperty(this, "i", {value: "define" + "Property"}); Object[i](${D});`],
  ["holes assign(this)", "stop", `var i = 0; Object.assign(this, {i: "define" + "Property"}); Object[i](${D});`],
  ["holes +=", "stop", `var t = ""; t += "define"; t += "Property"; Object[t](${D});`],
  ["holes number then string", "stop", `var i = 0; i = "define" + "Property"; Object[i](${D});`],
  ["keep compareArray", "keep", CMP],
  ["keep a[i]", "keep", "var a = [1]; var i = 0; var x = a[i]; var y = [1][i + 1]; x; y;"],
  ["keep s+=arr[j]", "keep", "var arr = [1, 2]; var s = 0; for (var j = 0; j < arr.length; j++) s += arr[j];"],
  ["keep is+Finite", "keep", '({})["is" + "Finite"];'],
  ["fragile: param i anywhere", "stop", CMP + " function g(i) { return i; }"],
  ["R10 super[]", "stop", `class C extends Object { static m() { return super["define" + "Property"]; } } C.m()(${D});`],
  ["R10 Object?.[]", "stop", `Object?.["define" + "Property"](${D});`],
  ["R10 for-in head", "stop", `var k; for (k in {["define" + "Property"]: 0}) Object[k](${D});`],
  ["R10 catch", "stop", `try { throw "define" + "Property"; } catch (p) { Object[p](${D}); }`],
  ["R10 chained stop", "stop", `var a = "x", b = "y"; a = b = "define" + "Property"; Object[a](${D});`],
  ["R10 chained keep", "keep", 'var a = "x", b = "y"; a = b = "is" + "Finite"; ({})[a]; ({})[b];'],
  ["R10 ternary stop", "stop", `var c = 1; Object[(c ? "define" : "get") + "Property"](${D});`],
  ["R10 ternary keep (cost)", "stop", 'var c = 1; ({})[c ? "a" : "b"];'],
  ["R8 ||=", "stop", `var p = ""; p ||= "define" + "Property"; Object[p](${D});`],
  ["R8 mixed str+num", "stop", 'var n = 0; n++; ({})["k" + n];'],
  ["R8 template num", "stop", 'var n = 0; n++; ({})[`k${n}`];'],
  ["R8 cooked text", "stop", `Object["\\x64efine" + "Property"](${D});`],
  ["R7 hoisted var undefined", "keep", '({})["define" + p]; var p = "X";'],
  ["keep real prelude", "keep", ["assert.js", "sta.js"].map((f) => readFileSync(`test262/harness/${f}`, "utf8")).join("\n")],
  // PRV-7628 round 2, N1: a for-in / for-of head declaration holds the loop's values, initializer or not.
  ["N1 for-in initializer", "stop", `for (var p = "Xyz" in {Property: 0}) Object["define" + p](${D});`],
  ["N1 for-in initializer computed", "stop", `for (var k = "Xyz" in {["define" + "Property"]: 0}) Object[k](${D});`],
  ["N1 for-of declaration", "stop", `for (var k of ["define" + "Property"]) Object[k](${D});`],
  ["N1 CTL for(;;) initializer", "keep", `for (var p = "Xyz"; false; ) Object["define" + p](${D});`],
  // N2: a declaration kind the record does not model binds any value.
  ["N2 namespace", "stop", { "./entry.ts": `namespace p { export function toString() { return "Property"; } } (Object as any)["define" + p](${D}); var p = "Xyz";` }],
  ["N2 enum", "stop", { "./entry.ts": `enum q { A } (q as any).toString = function () { return "Property"; }; (Object as any)["define" + q](${D}); var q = "Xyz";` }],
  ["N2 import = + by-text var", "stop", { "./entry.ts": `import p = require("./m"); (Object as any)["define" + p](${D});`, "./m.ts": `export = { toString() { return "Property"; } }; var p = "Xyz";` }],
  ["N2 CTL var only (ts)", "keep", { "./entry.ts": `var p = "Xyz"; (Object as any)["define" + p](${D});` }],
  ["N2 CTL interface + type", "keep", { "./entry.ts": `interface p { a: 1 } type q = string; var p = "Xyz", q = "Abc"; (Object as any)["define" + p + q](${D});` }],
  ["N2 CTL enum of another name", "keep", { "./entry.ts": `enum E { A } var p = "Xyz"; (Object as any)["define" + p](${D}); E.A;` }],
];
function fold(src: string | Record<string, string>): boolean {
  const files: Record<string, string> = typeof src === "string" ? { "./entry.js": src } : { ...src };
  const entry = Object.keys(files).find((name) => name.startsWith("./entry."))!;
  files[entry] += "\nNumber.isNaN(1);";
  const ast = analyzeMultiSource(files, entry, undefined, { allowJs: true });
  const last = ast.entryFile.statements.at(-1) as ts.ExpressionStatement;
  const id = ((last.expression as ts.CallExpression).expression as ts.PropertyAccessExpression).expression as ts.Identifier;
  return foldsBuiltinMember(ast.checker, ast.sourceFiles)(id);
}
let bad = 0;
for (const [name, want, src] of ROWS) {
  let got: string;
  try { got = fold(src) ? "keep" : "stop"; } catch (e) { got = "THROW " + String(e).slice(0, 100); }
  if (got !== want) bad++;
  console.log((got === want ? "ok  " : "DIFF") + " " + name.padEnd(30) + " want " + want + " got " + got);
}
console.log("mismatching rows:", bad, "of", ROWS.length);
