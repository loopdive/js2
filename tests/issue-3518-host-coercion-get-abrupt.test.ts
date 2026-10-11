// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

afterEach(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

for (const utf8Storage of [false, true]) {
  describe(`ordinary host coercion Get, utf8=${utf8Storage}`, () => {
    for (const kind of ["number", "object", "type-error", "runtime-error"] as const) {
      it(`propagates ${kind} from the original getter without reading toString`, async () => {
        const result = await compile("export function run(o:any):number{return Number(o);}", {
          target: "host",
          experimentalIR: false,
          utf8Storage,
        });
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        const imports = buildImports(result.imports, undefined, result.stringPool);
        const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary as BufferSource), imports);
        imports.setInstance?.(instance);
        const thrown =
          kind === "number"
            ? 99
            : kind === "object"
              ? { original: true }
              : kind === "type-error"
                ? new TypeError("original getter")
                : new WebAssembly.RuntimeError("original getter");
        for (const proxy of [false, true]) {
          const reads: string[] = [];
          const target = {
            get valueOf(): never {
              reads.push("valueOf");
              throw thrown;
            },
            get toString() {
              reads.push("toString");
              return () => 1;
            },
          };
          const receiver = proxy ? new Proxy(target, {}) : target;
          let caught: unknown;
          try {
            (instance.exports.run as Function)(receiver);
          } catch (error) {
            caught = error;
          }
          expect(caught).toBe(thrown);
          expect(reads).toEqual(["valueOf"]);
        }
      });
    }
    it("keeps ordinary fallback for missing, noncallable and object-returning valueOf", async () => {
      const result = await compile("export function run(o:any):number{return Number(o);}", {
        target: "host",
        experimentalIR: false,
        utf8Storage,
      });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary as BufferSource), imports);
      imports.setInstance?.(instance);
      for (const methodValue of [undefined, 3, () => ({})]) {
        const reads: string[] = [];
        const receiver = Object.assign(Object.create(null), { valueOf: methodValue });
        Object.defineProperty(receiver, "toString", {
          get() {
            reads.push("toString");
            return () => 7;
          },
        });
        expect((instance.exports.run as Function)(receiver)).toBe(7);
        expect(reads).toEqual(["toString"]);
      }
    });
    it("keeps the dynamic class-method singleton cache across late key imports", async () => {
      const source =
        "let c:any;let count=0;class C{m(){count++;return 42;}n(){return 3;}}export function run():number{c=new C();const a=c.m;const b=c.m;const n=c.n;if(a!==b||a===n)return -1;return a()+count*100;}";
      const result = await compile(source, { target: "host", experimentalIR: false, utf8Storage });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const module = new WebAssembly.Module(result.binary as BufferSource);
      for (let fresh = 0; fresh < 2; fresh++) {
        const imports = buildImports(result.imports, undefined, result.stringPool);
        const instance = new WebAssembly.Instance(module, imports);
        imports.setInstance?.(instance);
        expect((instance.exports.run as Function)()).toBe(142);
        expect((instance.exports.run as Function)()).toBe(242);
      }
    });
    it("keeps the actual raw Wasm struct method fallback", async () => {
      const result = await compile("export function run():number{const o={valueOf(){return 7;}};return Number(o);}", {
        target: "host",
        experimentalIR: false,
        utf8Storage,
      });
      expect(result.success, JSON.stringify(result.errors)).toBe(true);
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const module = new WebAssembly.Module(result.binary as BufferSource);
      expect(WebAssembly.Module.exports(module).some((entry) => entry.name === "__sget_valueOf")).toBe(true);
      const instance = new WebAssembly.Instance(module, imports);
      imports.setInstance?.(instance);
      expect((instance.exports.run as Function)()).toBe(7);
    });
  });
}
