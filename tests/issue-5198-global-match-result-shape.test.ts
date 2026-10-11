// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #5198 — a global RegExp @@match result is an ordinary Array of strings, not
 * a RegExpExecArray. Its `index`, `input`, `groups`, and `indices` properties
 * are absent until ordinary Array mutation/prototype lookup supplies one.
 *
 * The source deliberately uses direct `String#match`, computed `@@match`,
 * top-level/local aliases, and reflective `String.prototype.match.call`: each
 * reaches a distinct producer/consumer typing path. Every module must remain
 * import-free under the standalone native RegExp provider.
 */
async function standaloneExports(source: string): Promise<Record<string, () => number>> {
  // Test262 source is compiled with semantic diagnostics suppressed. Keep the
  // same front-end mode here so the deliberate null receiver control reaches
  // the runtime property boundary rather than being rejected by TypeScript.
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary as BufferSource);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  return instance.exports as unknown as Record<string, () => number>;
}

describe("#5198 — standalone global @@match result shape", () => {
  it("keeps the exact Symbol.match global result free of exec metadata", async () => {
    const ex = await standaloneExports(`
      export function test(): number {
        const result = /.(.)./g[Symbol.match]("abcdefghi");
        return result !== null &&
          result.length === 3 && result[0] === "abc" && result[1] === "def" && result[2] === "ghi" &&
          result.index === undefined && result.input === undefined &&
          result.groups === undefined && result.indices === undefined &&
          !Object.prototype.hasOwnProperty.call(result, "index") &&
          !Object.prototype.hasOwnProperty.call(result, "input") ? 1 : 0;
      }
    `);
    expect(ex.test()).toBe(1);
  });

  it("keeps direct, top-level, local-alias, and assignment-joined result carriers safe", async () => {
    const ex = await standaloneExports(`
      var top = /a/g[Symbol.match]("xaxa");

      export function topLevel(): number {
        return top !== null && top.length === 2 && top.index === undefined && top.input === undefined ? 1 : 0;
      }

      export function directAndAlias(): number {
        const direct = "zaaz".match(/a/g);
        const alias = direct;
        return alias !== null && alias.length === 2 && alias.index === undefined && alias.input === undefined ? 1 : 0;
      }

      export function captureThenGlobal(): number {
        let result: RegExpMatchArray | null = /a/.exec("ba");
        if (result === null) return 0;
        const captureIndex = result.index;
        const captureInput = result.input;
        result = "a".match(/a/g);
        return captureIndex === 1 && captureInput === "ba" && result.index === undefined && result.input === undefined ? 1 : 0;
      }

      export function globalThenCapture(): number {
        let result: RegExpMatchArray | null = "a".match(/a/g);
        result = /a/.exec("ba");
        if (result === null) return 0;
        return result.index === 1 && result.input === "ba" ? 1 : 0;
      }

      export function captureBeforeForeignWrite(): number {
        let result: RegExpMatchArray | null = /a/.exec("ba");
        if (result === null) return 0;
        const before = result.index;
        result = { index: 99 } as RegExpMatchArray;
        return before === 1 ? 1 : 0;
      }
    `);
    expect(ex.topLevel()).toBe(1);
    expect(ex.directAndAlias()).toBe(1);
    expect(ex.captureThenGlobal()).toBe(1);
    expect(ex.globalThenCapture()).toBe(1);
    expect(ex.captureBeforeForeignWrite()).toBe(1);
  });

  it("preserves reflective dynamic g/non-g result shapes, null, and global lastIndex reset", async () => {
    const ex = await standaloneExports(`
      export function reflectiveGlobal(): number {
        const result = String.prototype.match.call("zzababa", /a/g);
        return result !== null && result.length === 3 && result[0] === "a" &&
          result.index === undefined && result.input === undefined ? 1 : 0;
      }

      export function reflectiveCapture(): number {
        const result = String.prototype.match.call("zzab", /a/);
        return result !== null && result.index === 2 && result.input === "zzab" && result[0] === "a" ? 1 : 0;
      }

      export function noMatch(): number {
        return /z/g[Symbol.match]("abc") === null ? 1 : 0;
      }

      export function lastIndex(): number {
        const re = /a/g;
        re.lastIndex = 2;
        const result = re[Symbol.match]("a a a");
        return result !== null && result.length === 3 && re.lastIndex === 0 ? 1 : 0;
      }

      export function nullMetadataRead(): number {
        const result = /z/.exec("abc") as RegExpMatchArray;
        try {
          result.index;
          return 0;
        } catch (error) {
          return error instanceof TypeError ? 1 : 2;
        }
      }
    `);
    expect(ex.reflectiveGlobal()).toBe(1);
    expect(ex.reflectiveCapture()).toBe(1);
    expect(ex.noMatch()).toBe(1);
    expect(ex.lastIndex()).toBe(1);
    expect(ex.nullMetadataRead()).toBe(1);
  });

  it("does not turn globally absent metadata into an unconditional synthetic value", async () => {
    const ex = await standaloneExports(`
      export function assignedExpando(): number {
        const result = "a".match(/a/g) as RegExpMatchArray & { index: number };
        result.index = 41;
        return result.index === 41 ? 1 : 0;
      }

      export function definedExpando(): number {
        const result = "a".match(/a/g);
        Object.defineProperty(result, "input", { value: "own", configurable: true });
        return result.input === "own" ? 1 : 0;
      }

      export function inheritedExpando(): number {
        Object.defineProperty(Array.prototype, "index", { value: 73, configurable: true });
        const result = "a".match(/a/g);
        return result.index === 73 ? 1 : 0;
      }
    `);
    expect(ex.assignedExpando()).toBe(1);
    expect(ex.definedExpando()).toBe(1);
    expect(ex.inheritedExpando()).toBe(1);
  });

  it("preserves capture metadata through typed parameters and matchAll entries", async () => {
    const ex = await standaloneExports(`
      function captureMetadata(result: RegExpExecArray): number {
        return result.index === 1 && result.input === "xa" && result[0] === "a" ? 1 : 0;
      }

      export function typedParameter(): number {
        const result = /a/.exec("xa");
        return result === null ? 0 : captureMetadata(result);
      }

      export function matchAllEntry(): number {
        for (const result of "xa".matchAll(/a/g)) {
          return result.index === 1 && result.input === "xa" && result[0] === "a" ? 1 : 0;
        }
        return 0;
      }
    `);
    expect(ex.typedParameter()).toBe(1);
    expect(ex.matchAllEntry()).toBe(1);
  });
});
