// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #5117 — standalone DataView ToIndex must reject a static Symbol byteOffset.
 *
 * The corpus rows are optional so compiler-only validation remains runnable in
 * a worktree without the linked Test262 checkout. The no-corpus controls below
 * are mandatory and exercise the same direct native accessor path, including
 * side-effect and setter argument-order behavior.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = resolve(__dirname, "..", "test262");
const HAVE_TEST262 = existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const CORPUS_TIMEOUT = 180_000;

const ROWS = [
  "built-ins/DataView/prototype/getFloat32/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/getFloat64/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/getInt16/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/getInt32/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/getInt8/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/getUint16/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/getUint32/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/getUint8/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/setFloat32/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/setFloat64/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/setInt16/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/setInt32/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/setInt8/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/setUint16/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/setUint32/return-abrupt-from-tonumber-byteoffset-symbol.js",
  "built-ins/DataView/prototype/setUint8/return-abrupt-from-tonumber-byteoffset-symbol.js",
] as const;

const ROW_CHUNKS = [ROWS.slice(0, 4), ROWS.slice(4, 8), ROWS.slice(8, 12), ROWS.slice(12, 16)];

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-5117.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors?.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "standalone module must validate").toBe(true);

  const module = new WebAssembly.Module(result.binary);
  const imports = WebAssembly.Module.imports(module);
  expect(
    imports.map((entry) => `${entry.module}::${entry.name}`),
    "standalone must be host-free",
  ).toEqual([]);

  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { run: () => number }).run();
}

async function runCorpus(relative: string, target?: "standalone") {
  return runTest262File(join(TEST262_ROOT, "test", relative), "built-ins/DataView", 120_000, target);
}

describe("#5117 ES2015 DataView byteOffset Symbol conversion", () => {
  it("rejects a static Symbol byteOffset with a catchable TypeError without host imports", async () => {
    await expect(
      runStandalone(`
        export function run(): number {
          const view = new DataView(new ArrayBuffer(4));
          const offset = Symbol("offset");
          try {
            view.getUint8(offset);
          } catch (error) {
            return error instanceof TypeError ? 1 : 2;
          }
          return 0;
        }
      `),
    ).resolves.toBe(1);
  });

  it("evaluates every supplied argument expression before the Symbol TypeError", async () => {
    await expect(
      runStandalone(`
        export function run(): number {
          const view = new DataView(new ArrayBuffer(4));
          let offsetEvaluated = false;
          let valueEvaluated = false;
          let littleEndianEvaluated = false;
          function offset(): symbol {
            offsetEvaluated = true;
            return Symbol("offset");
          }
          function value(): number {
            valueEvaluated = true;
            return 7;
          }
          function littleEndian(): boolean {
            littleEndianEvaluated = true;
            return true;
          }
          let caughtTypeError = false;
          try {
            view.setInt8(offset(), value(), littleEndian());
          } catch (error) {
            caughtTypeError = error instanceof TypeError;
          }
          return caughtTypeError && offsetEvaluated && valueEvaluated && littleEndianEvaluated ? 1 : 0;
        }
      `),
    ).resolves.toBe(1);
  });

  it("evaluates setter argument expressions without invoking later coercion hooks", async () => {
    await expect(
      runStandalone(`
        export function run(): number {
          const view = new DataView(new ArrayBuffer(4));
          let valueExpressionEvaluated = false;
          let littleEndianExpressionEvaluated = false;
          let valueOfCalls = 0;
          let littleEndianValueOfCalls = 0;
          const valueObject: any = {
            valueOf: function(): number {
              valueOfCalls++;
              return 7;
            }
          };
          const littleEndianObject: any = {
            valueOf: function(): number {
              littleEndianValueOfCalls++;
              return 1;
            }
          };
          function offset(): symbol {
            return Symbol("offset");
          }
          function value(): any {
            valueExpressionEvaluated = true;
            return valueObject;
          }
          function littleEndian(): any {
            littleEndianExpressionEvaluated = true;
            return littleEndianObject;
          }
          let caughtTypeError = false;
          try {
            view.setInt8(offset(), value(), littleEndian());
          } catch (error) {
            caughtTypeError = error instanceof TypeError;
          }
          return caughtTypeError && valueExpressionEvaluated && littleEndianExpressionEvaluated && valueOfCalls === 0 && littleEndianValueOfCalls === 0 ? 1 : 0;
        }
      `),
    ).resolves.toBe(1);
  });

  it("lets an abrupt later argument expression win over the Symbol TypeError", async () => {
    await expect(
      runStandalone(`
        export function run(): number {
          const view = new DataView(new ArrayBuffer(4));
          function offset(): symbol {
            return Symbol("offset");
          }
          function later(): number {
            throw 42;
          }
          try {
            view.setInt8(offset(), later(), false);
          } catch (error) {
            return error === 42 ? 1 : 2;
          }
          return 0;
        }
      `),
    ).resolves.toBe(1);
  });

  it("keeps dynamic numeric byteOffset read/write behavior", async () => {
    await expect(
      runStandalone(`
        export function run(): number {
          const view = new DataView(new ArrayBuffer(4));
          const offset = 1;
          view.setUint8(offset, 42);
          return view.getUint8(offset) === 42 ? 1 : 0;
        }
      `),
    ).resolves.toBe(1);
  });

  for (const [chunkIndex, chunk] of ROW_CHUNKS.entries()) {
    it.skipIf(!HAVE_TEST262)(
      `passes exact host rows ${chunkIndex + 1}/${ROW_CHUNKS.length}`,
      { timeout: CORPUS_TIMEOUT },
      async () => {
        for (const relative of chunk) {
          const result = await runCorpus(relative);
          expect(result.status, `${relative}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
        }
      },
    );

    it.skipIf(!HAVE_TEST262)(
      `passes exact standalone rows ${chunkIndex + 1}/${ROW_CHUNKS.length}`,
      { timeout: CORPUS_TIMEOUT },
      async () => {
        for (const relative of chunk) {
          const result = await runCorpus(relative, "standalone");
          expect(result.status, `${relative}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
        }
      },
    );
  }
});
