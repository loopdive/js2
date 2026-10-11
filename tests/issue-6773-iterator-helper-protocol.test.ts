// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6773 — ES2015-tagged standalone `Iterator.prototype.{chunks,windows,join}`
// residue: the iterator-HELPER protocol (lazy `$LazyIterHelper` wrappers,
// iter-lazy-native.ts) under `--target standalone`.
//
// One `it` per implementation step. Every expectation marked "base:" below was
// measured on `origin/main` 0907dd8342 (2026-09-30) with the same program
// (`.tmp/6773/pins/*.js`), so each pin FAILS on base and passes on the branch:
//
//   S1  a `class X extends Iterator` instance is the helper's live source
//       (GetIteratorDirect) — base: the helper was empty, the class `next()`
//       never ran; two same-layout classes also mis-dispatched `__call_next`.
//   S2  §7.4.4 — a non-Object `next()` result throws TypeError (base: done).
//   S3  `helper.return()` forwards IteratorClose once, never after exhaustion,
//       and consults a class GETTER named `return` (base: "called value is not
//       a function").
//   S4  the wrapper's [[Prototype]] is %IteratorHelperPrototype%, whose parent
//       is the one %IteratorPrototype% (base: null; `instanceof Iterator` false).
//   S5  `new <missing member>(…)` throws TypeError (base: constructed an object).
//   S6  `Iterator.prototype.{join,chunks,windows}` are function values (base:
//       undefined).
//
// Programs name `Iterator` exactly like the test262 runner's shim
// (`scripts/test262-iterator-binding.mjs`): a compiled function whose
// `prototype` is `%IteratorPrototype%` — that shim is also what bootstraps the
// object runtime the S1 fix has to route around.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SHIM = `function Iterator() {}
Iterator.prototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
`;

/** Compile `body` standalone, run its top level, and read back `__r`. */
async function run(body: string): Promise<string> {
  const source = `var __r = "";\n${body}\nexport function rlen() { return __r.length; }\nexport function rat(j) { return __r.charCodeAt(j); }\n`;
  const result = await compile(source, {
    target: "standalone",
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  if (!result.success) throw new Error(`compile failed: ${result.errors.map((e) => e.message).join("; ")}`);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  const ex = instance.exports as Record<string, (...a: number[]) => number>;
  ex.__module_init?.();
  let out = "";
  const n = ex.rlen!();
  for (let j = 0; j < n; j++) out += String.fromCharCode(ex.rat!(j));
  return out;
}

describe("#6773 iterator-helper protocol (standalone)", () => {
  it("S1: a class instance is the helper's own source; same-layout classes dispatch nominally", async () => {
    const out = await run(`${SHIM}
class Throwing extends Iterator {
  next() { throw new RangeError("NEXT"); }
  get return() { throw new TypeError("RETURN"); }
}
class T extends Iterator {
  constructor() { super(); this.i = 0; }
  next() { return { done: this.i++ > 1, value: this.i }; }
}
class Q {
  constructor() { this.i = 10; }
  next() { return { done: this.i++ > 11, value: this.i }; }
}
var s = "";
try { new Throwing().chunks(1).next(); s += "chunks:no-throw;"; } catch (e) { s += "chunks:" + e.message + ";"; }
try { new Throwing().map(function (x) { return x; }).next(); s += "map:no-throw;"; } catch (e) { s += "map:" + e.message + ";"; }
try { var r = new T().map(function (x) { return x * 2; }).next(); s += "T.map:" + r.done + "/" + r.value + ";"; } catch (e) { s += "T.map:" + e.message + ";"; }
var q = new Q();
s += "Q:" + q.next().value + ";";
__r = s;`);
    // base: "chunks:no-throw;map:no-throw;T.map:true/undefined;Q:11;"
    expect(out).toBe("chunks:NEXT;map:NEXT;T.map:false/2;Q:11;");
  });

  it("S2: a non-Object next() result is a TypeError, not done", async () => {
    const out = await run(`${SHIM}
class NullResult extends Iterator { next() { return null; } }
class NumResult extends Iterator { next() { return 5; } }
var s = "";
try { new NullResult().chunks(1).next(); s += "null:no-throw;"; } catch (e) { s += "null:" + (e instanceof TypeError) + ";"; }
try { new NumResult().windows(1).next(); s += "num:no-throw;"; } catch (e) { s += "num:" + (e instanceof TypeError) + ";"; }
__r = s;`);
    // base: "null:no-throw;num:no-throw;"
    expect(out).toBe("null:true;num:true;");
  });

  it("S3: helper.return() forwards once, not after exhaustion, and reads a getter", async () => {
    const out = await run(`${SHIM}
var count = 0;
class Counting extends Iterator {
  next() { return { done: false, value: 1 }; }
  return() { count++; return {}; }
}
class Exhausted extends Iterator {
  next() { return { done: true, value: undefined }; }
  return() { count += 100; return {}; }
}
class GetterReturn extends Iterator {
  next() { return { done: false, value: 1 }; }
  get return() { throw new RangeError("GETTER"); }
}
var s = "";
var it = new Counting().chunks(2);
try { var r = it.return(); s += "r1:" + r.done + "/" + r.value + "/" + count + ";"; } catch (e) { s += "r1:" + e.message + ";"; }
try { it.return(); s += "r2:" + count + ";"; } catch (e) { s += "r2:" + e.message + ";"; }
try { s += "after:" + it.next().done + ";"; } catch (e) { s += "after:" + e.message + ";"; }
var ex = new Exhausted().windows(1);
try { ex.next(); ex.return(); s += "exhausted:" + count + ";"; } catch (e) { s += "exhausted:" + e.message + ";"; }
var gr = new GetterReturn().chunks(1);
try { gr.next(); gr.return(); s += "getter:no-throw;"; } catch (e) { s += "getter:" + e.message + ";"; }
__r = s;`);
    // base: "r1:called value is not a function;r2:called value is not a function;after:true;
    //        exhausted:called value is not a function;getter:called value is not a function;"
    expect(out).toBe("r1:true/undefined/1;r2:1;after:true;exhausted:1;getter:GETTER;");
  });

  it("S4: a helper's [[Prototype]] is %IteratorHelperPrototype% under %IteratorPrototype%", async () => {
    // The helper prototype is created BEFORE the program first reads an
    // iterator prototype, so its guarded root init must mint the ONE root.
    const out = await run(`function* g() { yield 1; }
var w = g().chunks(1);
var m = g().map(function (x) { return x; });
var s = "";
var hp = Object.getPrototypeOf(w);
s += "hp:" + (hp !== null) + ";";
s += "shared:" + (hp === Object.getPrototypeOf(m)) + ";";
${SHIM}
s += "parent:" + (Object.getPrototypeOf(hp) === Iterator.prototype) + ";";
s += "instanceof:" + (w instanceof Iterator) + "/" + (m instanceof Iterator) + ";";
s += "isPrototypeOf:" + Iterator.prototype.isPrototypeOf(w) + ";";
s += "tag:" + hp[Symbol.toStringTag] + ";";
__r = s;`);
    // base: `__module_init` throws a wasm exception (`hp` is null, so
    // `hp[Symbol.toStringTag]` throws uncaught).
    expect(out).toBe("hp:true;shared:true;parent:true;instanceof:true/true;isPrototypeOf:true;tag:Iterator Helper;");
  });

  it("S5: new <nullish-or-primitive>(…) throws TypeError; constructors still construct", async () => {
    const out = await run(`function* g() {}
var s = "";
function t(label, f) { try { f(); s += label + ":no-throw;"; } catch (e) { s += label + ":" + (e instanceof TypeError ? "TypeError" : "other") + ";"; } }
var o = {};
t("missing", function () { new o.nope(1); });
t("helper", function () { new g().chunks(1); });
t("classStatic", function () { new (class {}).nope(1); });
var box = { n: 1, str: "x", b: true };
t("number", function () { new box.n(); });
t("string", function () { new box.str(); });
t("boolean", function () { new box.b(); });
class C { constructor(v) { this.v = v; } }
var holder = { C: C };
try { var c = new holder.C(3); s += "C:" + c.v + ";"; } catch (e) { s += "C:threw " + e.message + ";"; }
__r = s;`);
    // base: "missing:no-throw;helper:TypeError;classStatic:no-throw;number:TypeError;string:TypeError;boolean:TypeError;C:3;"
    expect(out).toBe(
      "missing:TypeError;helper:TypeError;classStatic:TypeError;number:TypeError;string:TypeError;boolean:TypeError;C:3;",
    );
  });

  it("S6: Iterator.prototype.{join,chunks,windows} are own non-constructor functions", async () => {
    const out = await run(`${SHIM}
var s = "";
s += "types:" + typeof Iterator.prototype.join + "/" + typeof Iterator.prototype.chunks + "/" + typeof Iterator.prototype.windows + ";";
s += "own:" + Object.prototype.hasOwnProperty.call(Iterator.prototype, "join") + ";";
try { s += "meta:" + Iterator.prototype.join.name + "/" + Iterator.prototype.join.length + ";"; } catch (e) { s += "meta:" + e.message + ";"; }
try { var it = [].values(); new it.join(); s += "new:no-throw;"; } catch (e) { s += "new:" + (e instanceof TypeError) + ";"; }
function* g() { yield 1; yield 2; yield 3; }
var n = 0;
for (var chunk of g().chunks(2)) n += chunk.length;
s += "native:" + n + ";";
__r = s;`);
    // base: "types:undefined/undefined/undefined;own:false;meta:Cannot access property on null or undefined at 8:22;new:true;native:3;"
    expect(out).toBe("types:function/function/function;own:true;meta:join/1;new:true;native:3;");
  });
});
