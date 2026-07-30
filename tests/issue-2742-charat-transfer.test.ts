// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2742 — String.prototype.charAt is intentionally generic (§22.1.3.2).
 *
 * A transferred native charAt closure has an explicit receiver parameter, but
 * standalone dynamic method dispatch previously supplied only the position
 * argument and installed the receiver in `__current_this`. Function-constructor
 * instances therefore either missed the method or coerced the position as the
 * receiver. Exercise the literal ES5 Test262 cases so the original harness and
 * top-level execution shape remain part of the regression contract.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHAR_AT_DIR = join(REPO_ROOT, "test262/test/built-ins/String/prototype/charAt");

async function runEs5(file: string): Promise<string> {
  const path = join(CHAR_AT_DIR, file);
  if (!existsSync(path)) return "fixture-missing";
  return (await runTest262File(path, "String.prototype.charAt", 20_000, "standalone")).status;
}

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  expect(result.imports).toEqual([]);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#2742 — standalone transferred String.prototype.charAt", () => {
  it("passes ES5 A1.1: constructor instance ToString(this) and extra arguments", async () => {
    expect(await runEs5("S15.5.4.4_A1.1.js")).toBe("pass");
  });

  it("passes ES5 A2: a negative position returns the empty string", async () => {
    expect(await runEs5("S15.5.4.4_A2.js")).toBe("pass");
  });

  it("passes the explicit receiver through the transferred closure call ABI", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const method: any = String.prototype.charAt;
          return method.call("xyz", 1) === "y" ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("does not hijack a user function stored under the charAt name", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const receiver: any = {
            charAt: function () { return "custom"; }
          };
          return receiver.charAt() === "custom" ? 1 : 0;
        }
      `),
    ).toBe(1);
  });
});
