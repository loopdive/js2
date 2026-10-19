// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

// Wire contract: 0 positional, 1 source rest, 2 native packed argv.
const PACKED_CLOSURE_ARGV = 2;

const SOURCE = `
  export function assign(): any { return Object.assign; }
  export function max(): any { return Math.max; }
  export function min(): any { return Math.min; }
  export function chars(): any { return String.fromCharCode; }
  export function fixed(): any { return function(a:number,b:number):number {return a+b;}; }
  export function array(): any { return function(a:any[]):number {return a.length;}; }
  export function rest(): any { return function(this:any,...a:any[]):number {return (this?this.bias:0)+a.length;}; }
  export function object(): any { return function(a:any):any {a.count++;return a.token;}; }
  export function under(): any { return function(a:number,b:number=30):number {return a+b+arguments.length;}; }
  export function metadata(): number {return Object.assign.length===2 && Object.assign.name==="assign" ? 42:-1;}
`;

type Exports = Record<string, (...args: any[]) => any>;

describe("native callable values crossing the live JS boundary", () => {
  let ex: Exports;
  let raw: Exports;
  beforeAll(async () => {
    const result = await compile(SOURCE, { skipSemanticDiagnostics: true, deferTopLevelInit: true });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    const imports = buildCompiledImports(result);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    raw = instance.exports as Exports;
    ex = wrapCompiledExports(result, instance) as Exports;
    ex.__module_init?.();
  });

  it("classifies exact native packed identities separately from ordinary array/rest closures", () => {
    for (const name of ["assign", "max", "min", "chars"]) {
      expect(raw.__closure_has_rest(raw[name]())).toBe(PACKED_CLOSURE_ARGV);
    }
    expect(raw.__closure_has_rest(raw.array())).toBe(0);
    expect(raw.__closure_has_rest(raw.rest())).toBe(1);
    expect(ex.metadata()).toBe(42);
  });

  it("preserves builtin facade identity across repeated returns", () => {
    expect(ex.assign()).toBe(ex.assign());
    expect(ex.max()).toBe(ex.max());
  });

  it("calls ordinary two-argument closures", () => {
    expect(ex.fixed()(12, 30)).toBe(42);
  });

  it("keeps ordinary array parameters positional", () => {
    expect(ex.array()([1, 2, 3])).toBe(3);
    expect(ex.array()([1], [2], [3])).toBe(1);
  });

  it("preserves rest-function receivers", () => {
    expect(ex.rest().call({ bias: 39 }, 1, 2, 3)).toBe(42);
  });

  it("pads omitted formals without changing arguments.length", () => {
    expect(ex.under()(11)).toBe(42);
  });

  it("admits ordinary callback arguments without copying their graph", () => {
    const token = {};
    const input = { count: 0, token };
    expect(ex.object()(input)).toBe(token);
    expect(input.count).toBe(1);
  });

  for (const count of [0, 1, 3, 9, 32]) {
    it(`preserves all ${count} native builtin arguments`, () => {
      const values = Array.from({ length: count }, (_, i) => i + 65);
      expect(ex.max()(...values)).toBe(Math.max(...values));
      expect(ex.min()(...values)).toBe(Math.min(...values));
      expect(ex.chars()(...values)).toBe(String.fromCharCode(...values));
    });
  }

  it("preserves assign target, nested value and symbol identities beyond dispatcher arity", () => {
    const fn = ex.assign();
    const token = {};
    const key = Symbol("live");
    const target: any = {};
    const sources = Array.from({ length: 12 }, (_, i) => ({ [i]: i }));
    expect(fn(target, ...sources, { token, [key]: token })).toBe(target);
    expect(target[11]).toBe(11);
    expect(target.token).toBe(token);
    expect(target[key]).toBe(token);
  });

  it("does not consult the host Array iterator while constructing argv", () => {
    const fn = ex.max();
    const iterator = Array.prototype[Symbol.iterator];
    let hits = 0;
    let result: unknown;
    try {
      Array.prototype[Symbol.iterator] = () => {
        hits++;
        throw new Error("unexpected host iterator");
      };
      result = Reflect.apply(fn, undefined, [12, 30]);
    } finally {
      Array.prototype[Symbol.iterator] = iterator;
    }
    expect(result).toBe(30);
    expect(hits).toBe(0);
  });

  it("asks live descriptors and getters in order without probing a prototype", () => {
    const events: string[] = [];
    const source = new Proxy(
      { a: 42 },
      {
        ownKeys(t) {
          events.push("keys");
          return Reflect.ownKeys(t);
        },
        getOwnPropertyDescriptor(t, k) {
          events.push(`desc:${String(k)}`);
          return Reflect.getOwnPropertyDescriptor(t, k);
        },
        get(t, k, r) {
          events.push(`get:${String(k)}`);
          return Reflect.get(t, k, r);
        },
        getPrototypeOf() {
          throw new Error("unexpected prototype probe");
        },
      },
    );
    const target = {};
    expect(ex.assign()(target, source)).toBe(target);
    expect(target).toEqual({ a: 42 });
    expect(events).toEqual(["keys", "desc:a", "get:a"]);
  });

  it("preserves throw tokens and partial writes", () => {
    const token = {};
    const target: any = {};
    let later = 0;
    const run = () =>
      ex.assign()(
        target,
        { a: 42 },
        {
          get b() {
            throw token;
          },
        },
        {
          get c() {
            later++;
            return 1;
          },
        },
      );
    try {
      run();
      expect.unreachable("getter must throw");
    } catch (error) {
      expect(error).toBe(token);
    }
    expect(target).toEqual({ a: 42 });
    expect(later).toBe(0);
  });

  it("rejects a missing target", () => {
    expect(() => ex.assign()()).toThrow(TypeError);
  });
});
