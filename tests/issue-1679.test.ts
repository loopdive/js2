// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1679 — `new this(...)` dynamic constructor.
 *
 * `this` inside a static method is the constructor; `new this(...)` instantiates
 * it (acorn's subclass-friendly static-factory idiom). Per ECMA-262 §13.3.5
 * the callee is the value of `this`, so the compiler must construct it
 * dynamically rather than reject the non-identifier callee.
 */
import { describe, it, expect } from "vitest";
import { compileToWasm, compile } from "./equivalence/helpers.js";

describe("#1679 — new this(...) dynamic constructor", () => {
  it("static factory via new this() constructs the class (returns 42)", async () => {
    const exports = await compileToWasm(`
      class Parser {
        x: number;
        constructor(x: number) { this.x = x; }
        getX(): number { return this.x; }
        static make(v: number): Parser { return new this(v); }
      }
      export function test(): number {
        const p = Parser.make(42);
        return p.getX();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("new this() threads multiple constructor arguments", async () => {
    const exports = await compileToWasm(`
      class Pair {
        a: number;
        b: number;
        constructor(a: number, b: number) { this.a = a; this.b = b; }
        sum(): number { return this.a + this.b; }
        static of(a: number, b: number): Pair { return new this(a, b); }
      }
      export function test(): number {
        return Pair.of(3, 4).sum();
      }
    `);
    expect(exports.test()).toBe(7);
  });

  it("function-style class with new this() static factory compiles (acorn idiom)", async () => {
    // The acorn pattern: a constructor *function* with prototype methods and a
    // static factory using `new this(...)`. This used to emit "Unsupported new
    // expression for class" — it must now compile to valid Wasm.
    const result = await compile(`
      function Parser(this: any, x: number) { this.x = x; }
      Parser.prototype.getX = function (this: any): number { return this.x; };
      Parser.make = function (this: any, v: number): any { return new this(v); };
      export function test(): number {
        const p = Parser.make(42);
        return p.getX();
      }
    `);
    const newThisErrors = result.errors.filter((e) => /Unsupported new expression/.test(e.message));
    expect(newThisErrors).toHaveLength(0);
  });
});
