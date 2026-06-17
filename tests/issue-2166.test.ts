// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2166 — standalone JSON conformance residual.
//
// The standalone `JSON.stringify` primitive slice (#1324) handled the static
// `true`/`false` keyword literals but skipped a `boolean`-TYPED value: TypeScript
// models the `boolean` primitive as the union `true | false`, so a `boolean`-typed
// variable carries the `Union` type flag and was wrongly rejected by the
// ambiguous-shape early-return in `tryEmitJsonStringifyPrimitive`
// (src/codegen/expressions/calls.ts). `JSON.stringify(b)` then refused to compile
// in standalone instead of serializing to "true"/"false".
//
// Fix: recognize the `boolean` union (`Boolean` flag + `intrinsicName === "boolean"`)
// before the ambiguous-mask return, so the existing boolean stringify branch fires.
//
// Standalone native strings don't auto-marshal across the export boundary to JS,
// so these assertions compare the JSON string INTERNALLY (the §25.5 result vs an
// in-module literal) and return a boolean — matching how test262 exercises this.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Mode = { label: string; opts: Record<string, unknown> };
const MODES: Mode[] = [
  { label: "host", opts: {} },
  { label: "standalone", opts: { target: "standalone" } },
];

async function runBool(src: string, opts: Record<string, unknown>): Promise<unknown> {
  const result = await compile(src, { fileName: "test.ts", ...opts });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as { test(): unknown }).test();
}

describe("#2166 — standalone JSON.stringify of a boolean-typed value", () => {
  for (const { label, opts } of MODES) {
    describe(`[${label}]`, () => {
      it('dynamic boolean true → "true"', async () => {
        expect(
          await runBool(
            `export function test(): boolean { const b: boolean = 1 > 0; return JSON.stringify(b) === "true"; }`,
            opts,
          ),
        ).toBe(1);
      });

      it('dynamic boolean false → "false"', async () => {
        expect(
          await runBool(
            `export function test(): boolean { const b: boolean = 1 < 0; return JSON.stringify(b) === "false"; }`,
            opts,
          ),
        ).toBe(1);
      });

      it("boolean parameter serializes both ways", async () => {
        expect(
          await runBool(
            `function s(b: boolean): boolean { return JSON.stringify(b) === (b ? "true" : "false"); }
             export function test(): boolean { return s(true) && s(false); }`,
            opts,
          ),
        ).toBe(1);
      });

      it("static true/false literals still serialize (regression guard)", async () => {
        expect(
          await runBool(
            `export function test(): boolean { return JSON.stringify(true) === "true" && JSON.stringify(false) === "false"; }`,
            opts,
          ),
        ).toBe(1);
      });
    });
  }
});

/**
 * #2166 (space slice) — `JSON.stringify(value, replacer, space)` with a `space`
 * argument. The standalone static-fold path was gated on `arguments.length === 1`
 * and hit the #1599 refusal for the common pretty-print form
 * `JSON.stringify(obj, null, 2)`. Thread a `null`/`undefined` replacer + a static
 * numeric/string space through the compile-time fold (forwarding to JS's own
 * JSON.stringify for §25.5.2 clamping). A function/array replacer or dynamic space
 * still refuses. No `JSON_*` host import leaks in standalone/wasi.
 */
async function standaloneNum(body: string, target: "standalone" | "wasi" = "standalone"): Promise<number> {
  const r = await compile(body, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  expect(labels.some((l) => /JSON_stringify|JSON_parse/.test(l))).toBe(false);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

async function expectRefused(body: string): Promise<void> {
  const r = await compile(body, { target: "standalone" });
  expect(r.success, `expected compile failure for:\n${body}`).toBe(false);
  expect(r.errors.some((e) => /#1599/.test(e.message))).toBe(true);
}

describe("#2166 — standalone JSON.stringify with space (indentation)", () => {
  it("indents an object with numeric space (length proof matches host)", async () => {
    const expected = JSON.stringify({ a: 1 }, null, 2).length;
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1 }, null, 2).length; }`),
    ).toBe(expected);
  });

  it("indents a nested object/array with numeric space", async () => {
    const expected = JSON.stringify({ a: 1, b: [1, 2] }, null, 2).length;
    expect(
      await standaloneNum(
        `export function test(): number { return JSON.stringify({ a: 1, b: [1, 2] }, null, 2).length; }`,
      ),
    ).toBe(expected);
  });

  it("indents with a string space (tab)", async () => {
    const expected = JSON.stringify({ a: 1 }, null, "\t").length;
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1 }, null, "\\t").length; }`),
    ).toBe(expected);
  });

  it("space 0 produces the compact form", async () => {
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1 }, null, 0).length; }`),
    ).toBe(JSON.stringify({ a: 1 }, null, 0).length);
  });

  it("a null replacer with no space stays compact", async () => {
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1 }, null).length; }`),
    ).toBe(JSON.stringify({ a: 1 }, null).length);
  });

  it("works under --target wasi too", async () => {
    const expected = JSON.stringify({ a: 1 }, null, 2).length;
    expect(
      await standaloneNum(
        `export function test(): number { return JSON.stringify({ a: 1 }, null, 2).length; }`,
        "wasi",
      ),
    ).toBe(expected);
  });

  it("does not regress the 1-arg compact form", async () => {
    expect(
      await standaloneNum(`export function test(): number { return JSON.stringify({ a: 1, b: 2 }).length; }`),
    ).toBe(13);
  });
});

describe("#2166 — replacer / dynamic space still refuse (no silent wrong output)", () => {
  it("refuses a function replacer", async () => {
    await expectRefused(`export function test(): number { return JSON.stringify({ a: 1 }, (k, v) => v, 2).length; }`);
  });

  it("refuses an array replacer", async () => {
    await expectRefused(`export function test(): number { return JSON.stringify({ a: 1, b: 2 }, ["a"], 2).length; }`);
  });

  it("refuses a dynamic (non-static) space", async () => {
    await expectRefused(`export function test(s: number): number { return JSON.stringify({ a: 1 }, null, s).length; }`);
  });
});
