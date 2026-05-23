// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #846 (class-static prototype sub-bucket) — ~403 tests in the assert.throws
 * not-thrown family verify that defining a class static member named
 * "prototype" throws TypeError. The compiler currently lets these classes
 * compile and run silently, so assert.throws fails ("returned 2").
 *
 * Per ES2024 §15.7.1 (ClassBody Early Errors):
 *   "It is a Syntax Error if PropName of MethodDefinition is 'prototype'."
 *
 * For literal names that's a parse-time SyntaxError. For computed names
 * (e.g. `static *['prototype']()`) the spec falls through to
 * ClassDefinitionEvaluation / DefineMethodProperty: the class function's
 * own `prototype` property is non-writable + non-configurable, so
 * OrdinaryDefineOwnProperty fails and throws TypeError at evaluation time.
 *
 * Sample failing test262 file: `test/language/computed-property-names/class/static/generator-prototype.js`
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#846 class static prototype restriction", () => {
  // Note: literal `static prototype()` and `static get prototype()` are
  // rejected at compile time by both TS itself (code 2699) and our
  // validation.ts. Those paths don't reach codegen, so we only test the
  // COMPUTED-name case which is what test262's
  // `language/computed-property-names/class/static/*-prototype.js`
  // family hits.

  it("class { static *['prototype']() {} } — should throw at class evaluation", async () => {
    const exports = await compileToWasm(`
      export function test(): boolean {
        try {
          class C {
            static *['prototype'](): any { yield; }
          }
          return false;
        } catch (e: any) {
          return e instanceof TypeError;
        }
      }
    `);
    expect(exports.test()).toBeTruthy();
  });

  // Mirror the canonical test262 file shape:
  //   test/language/computed-property-names/class/static/generator-prototype.js
  // which wraps the class definition in assert.throws(TypeError, ...).
  it("simulated assert.throws(TypeError, () => class { static *['prototype']() {} })", async () => {
    const exports = await compileToWasm(`
      function attemptDefineProtoStaticGen(): boolean {
        class C {
          static *['prototype'](): any { yield; }
        }
        return false; // unreachable — class evaluation should throw
      }
      export function test(): boolean {
        try {
          attemptDefineProtoStaticGen();
          return false;
        } catch (e: any) {
          return e instanceof TypeError;
        }
      }
    `);
    expect(exports.test()).toBeTruthy();
  });

  // Non-static "prototype" is legal (it's a regular instance method)
  it("class { prototype() {} } — instance method named 'prototype' is OK", async () => {
    const exports = await compileToWasm(`
      class C {
        prototype(): string { return 'fine'; }
      }
      export function test(): string {
        return new C().prototype();
      }
    `);
    expect(exports.test()).toBe("fine");
  });
});
