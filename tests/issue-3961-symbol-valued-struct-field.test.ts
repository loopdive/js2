// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3961 — a symbol-valued object field must retain the symbol brand on its
// overloaded i32 carrier. React stores its element discriminator in
// `$$typeof`; boxing that slot as a number makes React reject its own elements.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, wrapExports } from "../src/runtime.js";

async function run(
  src: string,
  target?: "standalone",
): Promise<{ exports: Record<string, any>; raw: WebAssembly.Exports }> {
  const result = await compile(src, { fileName: "issue-3961.ts", ...(target ? { target } : {}) });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return {
    exports: wrapExports(instance, { signatures: result.exportSignatures }),
    raw: instance.exports,
  };
}

describe("#3961 — symbol-valued struct fields retain identity", () => {
  it("widens a local reused across boolean and string values", async () => {
    const { exports } = await run(`
      export function probe(): string {
        var value: any = false;
        value = true ? ".key" : "fallback";
        return value;
      }
    `);

    expect(exports.probe()).toBe(".key");
  });

  it("dispatches string methods through a mixed local's widened carrier", async () => {
    const { exports } = await run(`
      export function probe(): string {
        var value: any = false;
        value = ".$a";
        return value.replace(/\\/+/g, "$&/");
      }
    `);

    expect(exports.probe()).toBe(".$a");
  });

  it("preserves call-site arguments beyond a closure's declared arity", async () => {
    const { exports } = await run(`
      const holder: any = {};
      holder.invoke = function (first: number, second: number, third: number): number {
        return arguments.length * 100 + arguments[5] + arguments[6];
      };
      export function probe(): number {
        return holder.invoke(1, 2, 3, 4, 5, 6, 7);
      }
    `);

    expect(exports.probe()).toBe(713);
  });

  it("keeps structural fields readable after Object.freeze", async () => {
    const { exports } = await run(`
      function read(value: any): number { return value.answer; }
      export function probe(): number {
        const value = { answer: 56 };
        Object.freeze(value);
        return read(value);
      }
    `);

    expect(exports.probe()).toBe(56);
  });

  it("inherits Object as the constructor of ordinary structural records", async () => {
    const { exports } = await run(`
      export function probe(): boolean {
        const value = { answer: 42 };
        return value.constructor === Object;
      }
    `);

    expect(exports.probe()).toBe(1);
  });

  it("keeps an assigned class static through a dynamic value round-trip", async () => {
    const { exports } = await run(`
      const Base: any = class {};
      function carry(type: any): any { return { type }; }
      export function probe(): string {
        class Component extends Base {}
        // @ts-ignore — JavaScript permits adding an undeclared constructor property.
        Component.someStaticMethod = () => "someReturnValue";
        return carry(Component).type.someStaticMethod();
      }
    `);

    expect(exports.probe()).toBe("someReturnValue");
  });

  it("does not mistake a heritage property name for a self-reference", async () => {
    const { exports } = await run(`
      const React: any = { Component: class {} };
      export function probe(): boolean {
        class Component extends React.Component {}
        return new Component() instanceof Component;
      }
    `);

    expect(exports.probe()).toBe(1);
  });

  it("keeps recursive dynamic and array call sites on a dynamic parameter ABI", async () => {
    const { exports } = await run(`
      function read(value: any, depth: number): number {
        if (depth > 0) return read(value, depth - 1);
        return Array.isArray(value) ? value.length : value.answer;
      }
      export function probe(): number {
        const dynamic: any = { answer: 7 };
        return read(dynamic, 1) * 10 + read([1, 2], 1);
      }
    `);

    expect(exports.probe()).toBe(72);
  });

  it("keeps React's $$typeof discriminator as a symbol inside Wasm", async () => {
    const { exports } = await run(`
      const REACT_ELEMENT_TYPE = Symbol.for("react.transitional.element");
      function element(type: string) {
        return { $$typeof: REACT_ELEMENT_TYPE, type };
      }
      function isValidElement(value: any): boolean {
        return typeof value === "object" && value !== null && value.$$typeof === REACT_ELEMENT_TYPE;
      }
      export function valid(): boolean {
        const value = element("div");
        return typeof value.$$typeof === "symbol" && value.$$typeof === REACT_ELEMENT_TYPE;
      }
      export function validThroughDynamicParameter(): boolean {
        return isValidElement(element("div")) && !isValidElement({});
      }
      export function label(): string {
        return String(element("div").$$typeof);
      }
      export function count(): number {
        const value = element("div");
        switch (typeof value) {
          case "object":
            switch (value.$$typeof) {
              case REACT_ELEMENT_TYPE: return 1;
            }
        }
        return 0;
      }
    `);

    expect(exports.valid()).toBe(1);
    expect(exports.validThroughDynamicParameter()).toBe(1);
    expect(exports.label()).toBe("Symbol(react.transitional.element)");
    expect(exports.count()).toBe(1);
  });

  it("keeps the same symbol identity in standalone Wasm", async () => {
    const { exports } = await run(
      `
        const TAG = Symbol.for("react.transitional.element");
        function element() { return { $$typeof: TAG, type: "div" }; }
        export function probe(): boolean {
          const value = element();
          return typeof value.$$typeof === "symbol" && value.$$typeof === TAG;
        }
      `,
      "standalone",
    );

    expect(exports.probe()).toBe(1);
  });

  it("boxes a returned symbol field as the original JS Symbol", async () => {
    const { exports } = await run(`
      const TAG = Symbol.for("react.transitional.element");
      export function element() { return { $$typeof: TAG, type: "div" }; }
    `);

    const element = exports.element();
    expect(element.$$typeof).toBe(Symbol.for("react.transitional.element"));
    expect(typeof element.$$typeof).toBe("symbol");
  });

  it("unboxes a host symbol written through the generated struct setter", async () => {
    const { exports, raw } = await run(`
      const TAG = Symbol.for("react.transitional.element");
      const OTHER = Symbol.for("react.other.element");
      const current = { $$typeof: TAG, type: "div" };
      export function rawElement() { return current; }
      export function hasOtherIdentity(): boolean { return current.$$typeof === OTHER; }
    `);

    const element = (raw.rawElement as Function)();
    (raw["__sset_$$typeof"] as Function)(element, Symbol.for("react.other.element"));
    expect(exports.hasOtherIdentity()).toBe(1);
  });
});
