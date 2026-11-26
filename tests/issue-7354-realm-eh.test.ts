// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 O1 — a Prepared program that builds a realm object and has a user `try` emits only standardized exception
// handling. A user `try` lowers to `try_table`; a realm body that still used the legacy `try … catch_all … rethrow`
// made a module that mixes both, which Node 25 (V8) rejects at validation, while Node 22 accepts it. So the check is
// on the module text, and it holds on any Node: no legacy `try`, `catch_all`, `rethrow` or `delegate` beside the
// `try_table`.
import { describe, expect, it } from "vitest";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { compile, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";

const options = (): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: true,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

/** The exception-handling instructions of a module's text, by name. */
function exceptionInstructions(
  wat: string,
): Record<"tryTable" | "legacyTry" | "catchAll" | "rethrow" | "delegate", number> {
  const count = (pattern: RegExp) => (wat.match(pattern) ?? []).length;
  return {
    tryTable: count(/\(try_table\b/g),
    legacyTry: count(/\(try(?![_\w])/g),
    catchAll: count(/\(catch_all\b/g),
    rethrow: count(/\brethrow\b/g),
    delegate: count(/\bdelegate\b/g),
  };
}

describe("#7354 O1 — a realm module with a user try uses standardized exception handling only", () => {
  it.each([
    [
      "a caught throw beside an object",
      "function f(){ var o = { a: 1 }; var r = 0; try { throw 2; } catch (e) { r = 1; } return o.a + r; }",
      2,
    ],
    [
      "a try/finally beside an object",
      "function f(){ var o = { a: 1 }; try { g(); } finally { o.a; } return o.a; } function g(){}",
      1,
    ],
  ])(
    "%s",
    async (_label, body, answer) => {
      for (const [expected, outcome] of [
        [answer, "returned"],
        [answer + 1, "threw"],
      ] as const) {
        const source = `${body} if (f() !== ${expected}) throw 1;`;
        if (outcome === "returned") expect(() => new Function(source)()).not.toThrow();
        else expect(() => new Function(source)()).toThrow();
        const result = await compile(source, options());
        expect(result.errors.map((error) => error.message)).toEqual([]);
        expect(exceptionInstructions(result.wat ?? "")).toMatchObject({
          legacyTry: 0,
          catchAll: 0,
          rethrow: 0,
          delegate: 0,
        });
        expect(exceptionInstructions(result.wat ?? "").tryTable).toBeGreaterThan(0);
        let actual: "returned" | "threw" = "returned";
        try {
          (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
        } catch {
          actual = "threw";
        }
        expect(actual).toBe(outcome);
      }
    },
    240_000,
  );
});
