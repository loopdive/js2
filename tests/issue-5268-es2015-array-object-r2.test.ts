// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5268) ES2015 standalone Array + Object built-ins — r2 residual pass.
 *
 * One `describe` per landed step of the issue's implementation plan. Every pin
 * EXECUTES the operation it guards through the module's own `__stdout_*`
 * channel (#3469) — a standalone module cannot hand a string to the host any
 * other way — and every pin was verified RED on the pre-change tree.
 *
 * `runLines` asserts `result.imports` is EMPTY on every compile: the standalone
 * lane's host-import leak scan (#2961, `tests/test262-runner.ts`) fails any
 * module that emits an `env::` import, so a step that "fixes" a row by adding
 * one has not fixed it.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * Compile `body` as a standalone module and return the lines it printed.
 * `LOG(s)` is `console.log`; a module-level throw is reported as a trailing
 * `THREW` line so a pin can assert on a refusal without decoding a Wasm-GC
 * exception payload.
 */
async function runLines(body: string): Promise<string[]> {
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5268-es2015-array-object-r2.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    nativeStrings: true,
    hostBridge: "always",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, (...args: number[]) => number>;
  let threw = false;
  try {
    exports.__module_init!();
  } catch {
    threw = true;
  }
  const length = exports.__stdout_prepare!() | 0;
  let sink = "";
  for (let i = 0; i < length; i++) sink += String.fromCharCode(exports.__stdout_char!(i) & 0xffff);
  const lines = sink.split("\n").filter((l) => l.length > 0);
  if (threw) lines.push("THREW");
  return lines;
}

/**
 * (#5268 review F1) The JS-HOST twin of {@link runLines}. Every arm this
 * change-set adds is standalone-gated, so the host lane's job here is to prove
 * the SAME programs still compile and answer what they answered on base — the
 * defect F1 found was a host-lane COMPILE ERROR, which a standalone-only pin
 * cannot see. A compile failure is returned as a `COMPILE_ERROR:` line rather
 * than thrown, so a pin asserts on it by value.
 */
async function runHostLines(body: string): Promise<string[]> {
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5268-host.js",
    skipSemanticDiagnostics: true,
  });
  if (!result.success) {
    return [`COMPILE_ERROR: ${result.errors.map((e) => `L${e.line}: ${e.message}`).join(" | ")}`];
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const captured: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
    (imports as { setInstance?: (i: WebAssembly.Instance) => void }).setInstance?.(instance);
    const exports = instance.exports as Record<string, () => void>;
    if (typeof exports.main === "function") exports.main();
    else exports.__module_init?.();
  } finally {
    console.log = original;
  }
  return captured;
}

describe("#5268 step 1 — Object.prototype.__proto__ accessor pair (standalone)", () => {
  it("gOPD(Object.prototype, '__proto__') is an accessor pair with the §17 names", async () => {
    // RED on base: the descriptor is `undefined`, so `desc.get` throws
    // "Cannot access property on null or undefined".
    const lines = await runLines(`
      var desc = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__");
      LOG("value=" + (desc.value === undefined));
      LOG("get=" + (typeof desc.get));
      LOG("set=" + (typeof desc.set));
      LOG("getName=" + desc.get.name);
      LOG("setName=" + desc.set.name);
      LOG("getLength=" + desc.get.length);
      LOG("setLength=" + desc.set.length);
      LOG("enumerable=" + desc.enumerable);
      LOG("configurable=" + desc.configurable);
    `);
    expect(lines).toEqual([
      "value=true",
      "get=function",
      "set=function",
      "getName=get __proto__",
      "setName=set __proto__",
      "getLength=0",
      "setLength=1",
      "enumerable=false",
      "configurable=true",
    ]);
  });

  it("the reflective getter reads [[GetPrototypeOf]] and throws for nullish `this`", async () => {
    // RED on base: the descriptor read itself throws.
    const lines = await runLines(`
      var get = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__").get;
      var proto = {};
      var withCustomProto = Object.create(proto);
      var withNullProto = Object.create(null);
      LOG("custom=" + (get.call(withCustomProto) === proto));
      LOG("null=" + (get.call(withNullProto) === null));
      var verdict = "no-throw";
      try { get.call(undefined); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("undef=" + verdict);
      verdict = "no-throw";
      try { get.call(null); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("nul=" + verdict);
    `);
    expect(lines).toEqual(["custom=true", "null=true", "undef=TypeError", "nul=TypeError"]);
  });

  it("the reflective setter ignores a non-Object proto and a non-Object receiver", async () => {
    // §B.2.2.1.2 steps 2/3 — both return undefined WITHOUT a write and WITHOUT
    // a throw. RED on base: the descriptor read throws first.
    const lines = await runLines(`
      var set = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__").set;
      var proto = {};
      var subject = Object.create(proto);
      LOG("bool=" + set.call(subject, true));
      LOG("num=" + set.call(subject, 1));
      LOG("str=" + set.call(subject, "string"));
      LOG("kept=" + (Object.getPrototypeOf(subject) === proto));
      LOG("primThis=" + set.call(true));
      var verdict = "no-throw";
      try { set.call(undefined); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("nullish=" + verdict);
    `);
    expect(lines).toEqual([
      "bool=undefined",
      "num=undefined",
      "str=undefined",
      "kept=true",
      "primThis=undefined",
      "nullish=TypeError",
    ]);
  });

  it("the syntactic `o.__proto__ = v` form throws on a refused [[SetPrototypeOf]]", async () => {
    // §B.2.2.1.2 step 5. RED on base: `__object_setPrototypeOf` is deliberately
    // a silent no-op for a cycle, so no exception was thrown at all.
    const lines = await runLines(`
      var root = {};
      var intermediary = Object.create(root);
      var leaf = Object.create(intermediary);
      var verdict = "no-throw";
      try { root.__proto__ = leaf; } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("cycle=" + verdict);
    `);
    expect(lines).toEqual(["cycle=TypeError"]);
  });

  it("%Object.prototype% is an immutable-prototype exotic object (§10.4.7)", async () => {
    // RED on base: both the throw and the `false` were a silent success/`true`.
    const lines = await runLines(`
      var ObjProto = Object.prototype;
      var verdict = "no-throw";
      try { Object.setPrototypeOf(ObjProto, {}); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("obj=" + verdict);
      verdict = "no-throw";
      try { Object.setPrototypeOf(ObjProto, ObjProto); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("self=" + verdict);
      LOG("reflect=" + Reflect.setPrototypeOf(ObjProto, {}));
    `);
    expect(lines).toEqual(["obj=TypeError", "self=TypeError", "reflect=false"]);
  });
});

describe("#5268 step 2 — the Proxy MOP inside the Object statics (standalone)", () => {
  it("Object.freeze/seal on a Proxy run SetIntegrityLevel through the traps", async () => {
    // RED on base: a `$Proxy` fell into the #4032 carrier-bag arm, so the
    // `preventExtensions` trap never ran and the throw never happened.
    const lines = await runLines(`
      var p = new Proxy({}, { preventExtensions: function () { throw new TypeError("nope"); } });
      var verdict = "no-throw";
      try { Object.freeze(p); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("freeze=" + verdict);
      verdict = "no-throw";
      try { Object.seal(p); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("seal=" + verdict);
    `);
    expect(lines).toEqual(["freeze=TypeError", "seal=TypeError"]);
  });

  it("the per-key define runs in ownKeys order and includes the symbol key", async () => {
    // RED on base: no key was visited at all. The symbol is the part that needs
    // the trap-absent forward to be widened past `__getOwnPropertyNames`.
    const lines = await runLines(`
      var sym = Symbol("s");
      var target = {};
      target[sym] = 1;
      target.foo = 2;
      target[0] = 3;
      var seen = [];
      var proxy = new Proxy(target, {
        getOwnPropertyDescriptor: function (t, key) {
          seen.push(String(key));
          return Object.getOwnPropertyDescriptor(t, key);
        },
      });
      Object.freeze(proxy);
      LOG("order=" + seen.join(","));
      LOG("frozen=" + Object.isFrozen(proxy));
    `);
    expect(lines).toEqual(["order=0,foo,Symbol(s)", "frozen=true"]);
  });

  it("Object.values/entries on a Proxy run EnumerableOwnProperties through the traps", async () => {
    // RED on base: `__object_values` `ref.test`s `$Object`, which a `$Proxy` is
    // not, so it answered the EMPTY vec and fired no trap — a silent wrong
    // answer, not a refusal. Verified by file-copy A/B: with the arm removed
    // this prints `log=` / `len=0`.
    const lines = await runLines(`
      var log = "";
      var object = { a: 0, b: 0, c: 0 };
      var proxy = new Proxy(object, {
        get: function (t, k) { log += "|get:" + k; return t[k]; },
        getOwnPropertyDescriptor: function (t, k) {
          log += "|gopd:" + k;
          return Object.getOwnPropertyDescriptor(t, k);
        },
        ownKeys: function (t) { log += "|ownKeys"; return Object.getOwnPropertyNames(t); },
      });
      var result = Object.values(proxy);
      LOG("log=" + log);
      LOG("len=" + result.length);
    `);
    expect(lines).toEqual(["log=|ownKeys|gopd:a|get:a|gopd:b|get:b|gopd:c|get:c", "len=3"]);
  });
});

describe("#5268 review F1/F2 — the Proxy-provenance routing stays inside its lane", () => {
  // Every one of these was RED after step 2 and is GREEN on `origin/main`; the
  // expected values below are what base prints, captured with the reviewer's
  // own probe harness on their pristine `base-main` tree.
  it("F1 — the JS-HOST lane still COMPILES Object.keys/values/entries over a proxy alias", async () => {
    // RED: `Codegen error: absoluteFuncIndex: unresolved call target
    // (funcIdx=undefined)`. The arm resolved `__object_keys` out of funcMap,
    // which host mode does not have.
    expect(
      await runHostLines(`var p = new Proxy({ a: 1 }, {}); var q = p; LOG("keys:" + Object.keys(q).join());`),
    ).toEqual(["keys:a"]);
    expect(
      await runHostLines(`var p = new Proxy({ a: 1 }, {}); var q = p; LOG("values:" + Object.values(q).join());`),
    ).toEqual(["values:NaN"]);
    expect(
      await runHostLines(`var p = new Proxy({ a: 1 }, {}); var q = p; LOG("entries:" + Object.entries(q).join());`),
    ).toEqual(["entries:[object Object]"]);
  });

  it("F1 — …through a second-level alias, and inside a function", async () => {
    expect(
      await runHostLines(
        `var p = new Proxy({ a: 1 }, {}); var q = p; var w = q; LOG("deep:" + Object.keys(w).join());`,
      ),
    ).toEqual(["deep:a"]);
    expect(
      await runHostLines(
        `function f() { var p = new Proxy({ a: 1 }, {}); var q = p; return Object.keys(q).join(); }\nLOG("fn:" + f());`,
      ),
    ).toEqual(["fn:a"]);
  });

  it("F2 — standalone: an ALIAS of a proxy binding keeps base's answer", async () => {
    // The alias reads back null on this tree AND on origin/main (a pre-existing
    // widening defect this slice does not own), so the alias must stay on the
    // compile-time expansion. `isnull` is pinned to document that, so a future
    // fix to the nulling shows up here as a deliberate change rather than a
    // silent one.
    expect(
      await runLines(`
        var t = { a: 1 };
        var pt = new Proxy(t, {});
        var qt = pt;
        LOG("isnull:" + (qt === null));
        LOG("alias:" + Object.keys(qt).join());
        LOG("direct:" + Object.keys(pt).join());
      `),
    ).toEqual(["isnull:true", "alias:a", "direct:a"]);
  });

  it("F2 — …while the DIRECT binding still runs the traps", async () => {
    // The step-2 win must survive the narrowing: a direct `new Proxy` binding
    // still routes to the native enumerator.
    expect(
      await runLines(`
        var log = "";
        var proxy = new Proxy({ a: 0, b: 0 }, {
          get: function (t, k) { log += "|get:" + k; return t[k]; },
          getOwnPropertyDescriptor: function (t, k) {
            log += "|gopd:" + k;
            return Object.getOwnPropertyDescriptor(t, k);
          },
          ownKeys: function (t) { log += "|ownKeys"; return Object.getOwnPropertyNames(t); },
        });
        var r = Object.values(proxy);
        LOG("log=" + log);
        LOG("len=" + r.length);
      `),
    ).toEqual(["log=|ownKeys|gopd:a|get:a|gopd:b|get:b", "len=2"]);
  });
});

describe("#5268 step 6 — IsArray over a Proxy (§7.2.2 step 3, standalone)", () => {
  it("unwraps a live proxy to its target and throws for a revoked one", async () => {
    // RED on base: `Array.isArray(handle.proxy)` folded to the constant `true`
    // from the TARGET's static type, so the revoked case never threw. The two
    // `nested` / `nonarr` lines pin the unwrap itself — they take the runtime
    // predicate because the provenance trace routes them there.
    const lines = await runLines(`
      var p = new Proxy([], {});
      LOG("live=" + Array.isArray(p));
      LOG("nested=" + Array.isArray(new Proxy(p, {})));
      LOG("nonarr=" + Array.isArray(new Proxy({}, {})));
      var handle = Proxy.revocable([], {});
      LOG("before=" + Array.isArray(handle.proxy));
      handle.revoke();
      var verdict = "no-throw";
      try { Array.isArray(handle.proxy); } catch (e) { verdict = e instanceof TypeError ? "TypeError" : "other"; }
      LOG("revoked=" + verdict);
    `);
    expect(lines).toEqual(["live=true", "nested=true", "nonarr=false", "before=true", "revoked=TypeError"]);
  });
});
