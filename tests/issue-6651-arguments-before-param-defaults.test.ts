// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 — §10.2.11 step 22 creates the `arguments` object BEFORE
 * IteratorBindingInitialization of the formals, so a PARAMETER DEFAULT can read
 * it. Every lowering path used to emit the object *after* the defaults (and
 * after destructuring), so a default compiled against a binding that did not
 * exist yet and read a literal `ref.null extern`.
 *
 * RED on the base commit (5459b1fe):
 *   - "expression form: default reads arguments"      → WebAssembly.Exception
 *   - "declaration form: default reads arguments"     → WebAssembly.Exception
 *   - "arguments is a snapshot taken BEFORE defaults" → WebAssembly.Exception
 *   - "body `let arguments` shadows …"                → RuntimeError: illegal cast
 * GREEN on the base commit (kept as controls, they must not move):
 *   - "simple parameter list: mapped arguments still round-trips"
 *   - "simple parameter list: arguments.length from the call site"
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#6651 arguments object is created before parameter defaults", () => {
  it("expression form: default reads arguments", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var out = 0;
        var f = function (x = arguments[2], y = arguments[3], z) {
          if (x === 'third') out += 1;
          if (y === 'fourth') out += 10;
          if (z === 'third') out += 100;
        };
        f(undefined, undefined, 'third', 'fourth');
        return out;
      }
    `);
    expect(exports.test()).toBe(111);
  });

  it("declaration form: default reads arguments", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var out = 0;
        function f(x = arguments[2], y = arguments[3], z) {
          if (x === 'third') out += 1;
          if (y === 'fourth') out += 10;
          if (z === 'third') out += 100;
        }
        f(undefined, undefined, 'third', 'fourth');
        return out;
      }
    `);
    expect(exports.test()).toBe(111);
  });

  it("arguments is a snapshot taken BEFORE the defaults run", async () => {
    // §10.2.11: `arguments[0]` reflects the ARGUMENT (explicit undefined), never
    // the value the default later assigns to the parameter.
    const exports = await compileToWasm(`
      export function test(): number {
        var out = 0;
        var f = function (a = 7) {
          if (a === 7) out += 1;
          if (arguments[0] === undefined) out += 10;
        };
        f(undefined);
        return out;
      }
    `);
    expect(exports.test()).toBe(11);
  });

  it("body `let arguments` shadows the object the default already saw", async () => {
    // arguments-with-arguments-lex.js: the default runs in the PARAMETER scope
    // and sees the object; the body's `let arguments` is a separate binding.
    const exports = await compileToWasm(`
      export function test(): number {
        var args;
        var f = function (x = (args = arguments)) {
          let arguments;
        };
        f();
        return (typeof args === 'object' ? 10 : 0) + (args.length === 0 ? 1 : 0);
      }
    `);
    expect(exports.test()).toBe(11);
  });

  it("simple parameter list: mapped arguments still round-trips", async () => {
    // Control — the simple-parameter-list lane keeps the original emission
    // point, so the #849 mapped param↔arguments sync must be untouched.
    // (Same shape as tests/arguments-object.test.ts, which is green on base.)
    const exports = await compileToWasm(`
      function collect(): number {
        arguments[0] = arguments[0] + 1;
        return arguments.length * 100 + arguments[0] + arguments[1];
      }
      export function test(): number {
        return collect(2, 3);
      }
    `);
    expect(exports.test()).toBe(206);
  });

  it("simple parameter list: arguments.length from the call site", async () => {
    const exports = await compileToWasm(`
      function countArgs(a: number, b: number, c: number): number {
        return arguments.length;
      }
      export function test(): number {
        return countArgs(10, 20, 30);
      }
    `);
    expect(exports.test()).toBe(3);
  });
});
