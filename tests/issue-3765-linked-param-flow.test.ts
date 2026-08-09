// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3765) Linked standalone compilation must carry the same grounded local
 * facts as the single-source path. Real JavaScript packages commonly expose
 * several public entrypoints that share private helpers. Calls from an unused
 * entrypoint therefore contribute `any` arguments, while the imported hot
 * entrypoint has a closed string/number flow. Declaration inference already
 * ignores those inconclusive non-recursive calls when agreeing the helper ABI;
 * this suite pins the matching local-carrier verdict used by its body.
 */
import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

const ENTRY = "entry.mjs";

function files(extraCall: string, recursive = false): Record<string, string> {
  const helper = recursive
    ? `
      function next(str, min, len, depth) {
        if (depth > 0) return next(str, min, len, depth - 1);
        var index = str.indexOf(";", min);
        return index === -1 ? len : index;
      }
    `
    : `
      function next(str, min, len) {
        var index = str.indexOf(";", min);
        return index === -1 ? len : index;
      }
    `;
  const depthArg = recursive ? ", 0" : "";
  return {
    "package.js": `
      ${helper}
      export function parse(str) {
        var len = str.length;
        return next(str, 0, len${depthArg});
      }
      ${extraCall}
    `,
    [ENTRY]: `
      import { parse } from "./package.js";
      /** @param {number} seed */
      export function run(seed) {
        var header = "a=" + seed + "; b=2";
        return parse(header);
      }
    `,
  };
}

async function build(sources: Record<string, string>, numericLocals = true) {
  const saved = process.env.JS2WASM_NUMERIC_LOCALS;
  if (!numericLocals) process.env.JS2WASM_NUMERIC_LOCALS = "0";
  try {
    return await compileMulti(sources, ENTRY, {
      allowJs: true,
      emitWat: true,
      experimentalIR: false,
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
  } finally {
    if (saved === undefined) process.env.JS2WASM_NUMERIC_LOCALS = undefined;
    else process.env.JS2WASM_NUMERIC_LOCALS = saved;
  }
}

function functionBody(wat: string, name: string): string {
  const start = wat.indexOf(`  (func $${name} `);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = wat.indexOf("\n  (func $", start + 1);
  return wat.slice(start, next < 0 ? undefined : next);
}

async function instantiate(result: Awaited<ReturnType<typeof build>>) {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary!);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  return WebAssembly.instantiate(module, {});
}

describe("#3765 — linked implicit-any helper carriers", () => {
  it("keeps the imported string-search helper's hot local unboxed", async () => {
    const result = await build(
      files(`
        export function unused(dynamic) {
          return next(dynamic, dynamic, dynamic);
        }
      `),
    );
    const wat = result.wat!;
    const body = functionBody(wat, "next");

    expect(body).toMatch(/\(local \$index f64\)/);
    expect(body).not.toMatch(/call \$__(?:box_number|to_primitive|unbox_number)/);

    const { exports } = await instantiate(result);
    expect((exports as { run: (seed: number) => number }).run(3751)).toBe(6);
  });

  it("restores the boxed linked local under the numeric-local kill switch", async () => {
    const result = await build(
      files(`
        export function unused(dynamic) {
          return next(dynamic, dynamic, dynamic);
        }
      `),
      false,
    );
    expect(functionBody(result.wat!, "next")).toMatch(/\(local \$index externref\)/);
  });

  it("rejects a concrete non-string call-site conflict", async () => {
    const result = await build(
      files(`
        export function numberSite() {
          return next(42, 0, 2);
        }
      `),
    );
    expect(functionBody(result.wat!, "next")).toMatch(/\(local \$index externref\)/);
    const { exports } = await instantiate(result);
    expect((exports as { run: (seed: number) => number }).run(3751)).toBe(6);
  });

  it("keeps an inconclusive recursive argument on the dynamic ABI", async () => {
    const result = await build(
      files(
        `
          export function unused(dynamic) {
            return next(dynamic, dynamic, dynamic, 1);
          }
        `,
        true,
      ),
    );
    expect(functionBody(result.wat!, "next")).toMatch(/\(local \$index externref\)/);
    const { exports } = await instantiate(result);
    expect((exports as { run: (seed: number) => number }).run(3751)).toBe(6);
  });
});
