// #6651 W1 — Object Environment Record conformance for the `with` statement.
//
// Four independent defects in §9.1.1.2, each of which a `language/statements/with`
// row observes through the exact SEQUENCE of Proxy trap operations rather than
// through the final value:
//
//  1. §9.1.1.2.1 step 5's `Get(bindingObject, @@unscopables)` performed a `has`
//     trap first, because the host `__extern_get` probed presence with `in`
//     before reading. §10.5.8 [[Get]] invokes only the `get` trap.
//  2. §9.1.1.2.6 GetBindingValue step 2 (`stillExists = HasProperty`) and its
//     step-3 strict `ReferenceError` were missing entirely.
//  3. §9.1.1.2.5 SetMutableBinding step 2/3 — same, on the write side.
//  4. §9.1.1.2.1 step 5's `?` swallowed a throwing @@unscopables getter, and
//     `Object.defineProperty(env, Symbol.unscopables, …)` did not disqualify the
//     static (Tier-1) `with` projection, so HasBinding never ran at all.
//
// Every `it` below FAILS on the parent commit; see the issue file's
// 2026-09-24 receipt for the per-row base/after measurement.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(body: string): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

const PROXY_ENV = `
  var log: any = [];
  var env: any = { p: 0 };
  var proxy: any = new Proxy(env, {
    has: function (t, k) { log.push("has:" + String(k)); return Reflect.has(t, k); },
    get: function (t, k, r) { log.push("get:" + String(k)); return Reflect.get(t, k, r); },
    set: function (t, k, v, r) { log.push("set:" + String(k)); return Reflect.set(t, k, v, r); },
  });
`;

describe("#6651 W1 — with / Object Environment Record", () => {
  it("HasBinding's @@unscopables Get fires only the `get` trap (§9.1.1.2.1 step 5)", async () => {
    const exp = await run(`${PROXY_ENV} with (proxy) { p; } return log;`);
    // The FIRST three entries are HasBinding step 2, HasBinding step 5, and
    // GetBindingValue step 2. Base emitted has:p, has:Symbol(...), get:Symbol(...)
    // — a `has` trap the spec never performs.
    expect(exp.test().slice(0, 3)).toEqual(["has:p", "get:Symbol(Symbol.unscopables)", "has:p"]);
  });

  it("GetBindingValue re-checks HasProperty before the read (§9.1.1.2.6 step 2)", async () => {
    const exp = await run(`${PROXY_ENV} with (proxy) { p; } return log;`);
    expect(exp.test()).toEqual(["has:p", "get:Symbol(Symbol.unscopables)", "has:p", "get:p"]);
  });

  it("SetMutableBinding re-checks HasProperty before the write (§9.1.1.2.5 step 2)", async () => {
    const exp = await run(`${PROXY_ENV} with (proxy) { p = 1; } return log.slice(0, 4);`);
    expect(exp.test()).toEqual(["has:p", "get:Symbol(Symbol.unscopables)", "has:p", "set:p"]);
  });

  it("a strict write to a binding deleted mid-evaluation throws ReferenceError (§9.1.1.2.5 step 3)", async () => {
    const exp = await run(`
      var env: any = Object.create(new Int32Array(10));
      Object.defineProperty(env, "NaN", { configurable: true, value: 100 });
      var thrown = "none";
      with (env) {
        try {
          (function () { "use strict"; NaN = (delete env.NaN, 0); })();
        } catch (e) { thrown = (e as any).constructor.name; }
      }
      return thrown;
    `);
    expect(exp.test()).toBe("ReferenceError");
  });

  it("a sloppy write to a binding deleted mid-evaluation does NOT throw (§9.1.1.2.5 step 3)", async () => {
    const exp = await run(`
      var env: any = Object.create(new Int32Array(10));
      Object.defineProperty(env, "NaN", { configurable: true, value: 100 });
      var thrown = "none";
      with (env) {
        try { NaN = (delete env.NaN, 0); } catch (e) { thrown = (e as any).constructor.name; }
      }
      return thrown;
    `);
    expect(exp.test()).toBe("none");
  });

  it("a throwing @@unscopables getter installed via defineProperty propagates (§9.1.1.2.1 step 5)", async () => {
    const exp = await run(`
      var env: any = { x: 86 };
      Object.defineProperty(env, Symbol.unscopables, {
        get: function () { throw new RangeError("unscopables"); },
      });
      var caught = "none";
      with (env) {
        try { x; } catch (e) { caught = (e as any).message; }
      }
      return caught;
    `);
    expect(exp.test()).toBe("unscopables");
  });

  it("a throwing @@unscopables BLOCKLIST getter propagates (§9.1.1.2.1 step 5.a)", async () => {
    const exp = await run(`
      var env: any = { x: 86 };
      var blocklist: any = {};
      Object.defineProperty(blocklist, "x", { get: function () { throw new RangeError("blocklist"); } });
      Object.defineProperty(env, Symbol.unscopables, { value: blocklist });
      var caught = "none";
      with (env) {
        try { x; } catch (e) { caught = (e as any).message; }
      }
      return caught;
    `);
    expect(exp.test()).toBe("blocklist");
  });
});
