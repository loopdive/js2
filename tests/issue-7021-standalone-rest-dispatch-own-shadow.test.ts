// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";

/**
 * #7021 — marked's `Marked#use(...e)` reached through an `any` receiver.
 *
 * 1. The fixed-arity closed dispatcher `__call_m_use_1` treated the REST vec
 *    formal as an ordinary positional parameter and `ref.cast` the single
 *    argument (an options object) to the vec type — `illegal cast` in every
 *    upstream Hooks test. The arm now packs the arguments from the rest index on
 *    into a fresh rest vec.
 * 2. `use()` installs hooks as OWN properties over the `Hooks` class methods
 *    (`r[o] = c => …`). The dispatcher's own-slot guard that lets an own
 *    property win over the class arm was JS-host only; standalone now guards
 *    with the native `__hasOwnProperty` / `__extern_method_call`.
 *
 * Every row is checked against the same source run by the JS engine.
 */

const REST_SOURCE = `
class Marked {
  defaults: any = { n: 0 };
  use(...args: any[]): any {
    for (const a of args) this.defaults.n += a.n;
    return this;
  }
  cnt(...args: any[]): number { return args.length; }
  first(...args: any[]): any { return args[0].n; }
  tag(prefix: string, ...xs: number[]): string {
    let s = prefix;
    for (const x of xs) s += ":" + x;
    return s;
  }
}
class Other { use(o: any): any { return 99; } }
let marked: any;
function before(): void { marked = new Marked(); }
export function useOne(): number { before(); marked.use({ n: 3 }); return marked.defaults.n; }
export function useTwo(): number { before(); marked.use({ n: 3 }, { n: 4 }); return marked.defaults.n; }
export function useNone(): number { before(); marked.use(); return marked.defaults.n + 10; }
export function returnsThis(): number { before(); return marked.use({ n: 1 }) === marked ? 1 : 0; }
export function count(): number { const m: any = new Marked(); return m.cnt({ n: 3 }, 2); }
export function firstArg(): number { const m: any = new Marked(); return m.first({ n: 3 }); }
export function leadingFormal(): number { before(); return marked.tag("p", 1, 2) === "p:1:2" ? 1 : 0; }
export function leadingFormalOnly(): number { before(); return marked.tag("p") === "p" ? 1 : 0; }
export function plainSibling(): number { const o: any = new Other(); return o.use({ n: 1 }); }
`;

const OWN_SHADOW_SOURCE = `
class P {
  options: any;
  preprocess(e: any): any { return e; }
  postprocess(e: any): any { return e; }
}
class D {
  defaults: any = { hooks: null };
  use(...e: any[]): any {
    e.forEach((n: any) => {
      let s: any = { ...n };
      if (n.hooks) {
        let r: any = this.defaults.hooks || new P();
        for (let i in n.hooks) {
          if (!(i in r)) throw new Error("hook '" + i + "' does not exist");
          let o = i, u = n.hooks[o], a = r[o];
          r[o] = (c: any) => { let p = u.call(r, c); return a.call(r, p); };
        }
        s.hooks = r;
      }
      this.defaults = { ...this.defaults, ...s };
    });
    return this;
  }
  parse(n: any): any {
    let i: any = { ...this.defaults };
    if (i.hooks) n = i.hooks.preprocess(n);
    if (i.hooks) n = i.hooks.postprocess(n);
    return n;
  }
}
export function markedShape(): number {
  const m: any = new D();
  m.use({ hooks: { preprocess(x: any) { return "# " + x; } } });
  return m.parse("x") === "# x" ? 1 : 0;
}
export function stacked(): number {
  const m: any = new D();
  m.use({ hooks: { preprocess(x: any) { return x + "1"; } } });
  m.use({ hooks: { preprocess(x: any) { return x + "2"; } } });
  return m.parse("x") === "x21" ? 1 : 0;
}
export function ownWins(): number {
  const r: any = new P();
  r.preprocess = (c: any) => "# " + c;
  return r.preprocess("x") === "# x" ? 1 : 0;
}
export function displacedMethodStillCallable(): number {
  const r: any = new P();
  const a = r.preprocess;
  r.preprocess = (c: any) => a.call(r, "# " + c);
  return r.preprocess("x") === "# x" ? 1 : 0;
}
export function computedKey(): number {
  const r: any = new P();
  const o = "preprocess";
  r[o] = (c: any) => "# " + c;
  return r.preprocess("x") === "# x" ? 1 : 0;
}
export function otherInstanceUnaffected(): number {
  const shadowed: any = new P();
  shadowed.preprocess = (c: any) => "# " + c;
  const plain: any = new P();
  return plain.preprocess("x") === "x" ? 1 : 0;
}
`;

async function jsReference(source: string): Promise<Record<string, number>> {
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  const out: Record<string, number> = {};
  for (const [name, fn] of Object.entries(mod)) if (typeof fn === "function") out[name] = (fn as () => number)();
  return out;
}

async function standalone(source: string, names: string[]): Promise<Record<string, number | string>> {
  const r = await compile(source, { target: "standalone", fileName: "issue-7021.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(r.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exports = instance.exports as Record<string, () => number>;
  const out: Record<string, number | string> = {};
  for (const name of names) {
    try {
      out[name] = exports[name]!();
    } catch (error) {
      out[name] = `trap: ${(error as Error).message}`;
    }
  }
  return out;
}

describe("#7021 — standalone closed dispatch: rest-parameter methods and own-property hooks", () => {
  it("packs a rest-parameter method's arguments instead of casting them to the rest vec", async () => {
    const expected = await jsReference(REST_SOURCE);
    // Anti-vacuity: the sibling class's one-param `use` was never affected.
    expect(expected.plainSibling).toBe(99);
    const actual = await standalone(REST_SOURCE, Object.keys(expected));
    for (const name of Object.keys(expected)) expect([name, actual[name]]).toEqual([name, expected[name]]);
  });

  it("an own hook installed over a class method wins the dispatched call (marked use() shape)", async () => {
    const expected = await jsReference(OWN_SHADOW_SOURCE);
    for (const name of Object.keys(expected)) expect(expected[name]).toBe(1);
    const actual = await standalone(OWN_SHADOW_SOURCE, Object.keys(expected));
    for (const name of Object.keys(expected)) expect([name, actual[name]]).toEqual([name, expected[name]]);
  });
});
