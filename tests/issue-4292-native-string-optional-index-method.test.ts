// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4292 — Hono's mergePath uses optional indexing and `.at()`/`.slice()` on
// native strings. Each operation must preserve the string receiver rather than
// routing it through a nullable Array receiver.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function instantiate(result: CompileResult): Promise<WebAssembly.Exports> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports;
}

async function run(source: string, experimentalIR = true): Promise<number> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "native-string-optional.js",
    platform: "node",
    skipSemanticDiagnostics: true,
    target: "gc",
    experimentalIR,
  });
  const exports = await instantiate(result);
  return (exports.runCase as () => number)();
}

describe("#4292 native-string optional index/method chain", () => {
  it("optionally indexes a dynamic native string", async () => {
    expect(
      await run(
        `function probe(value) { return value?.[0] === "/" ? 42 : -1; } export function runCase() { return probe("/"); }`,
      ),
    ).toBe(42);
  });

  it("optionally calls at on a dynamic native string", async () => {
    expect(
      await run(
        `function probe(value) { return value?.at(-1) === "/" ? 42 : -1; } export function runCase() { return probe("/"); }`,
      ),
    ).toBe(42);
  });

  it("slices a dynamic native string", async () => {
    expect(
      await run(
        `function probe(value) { return value.slice(1) === "api" ? 42 : -1; } export function runCase() { return probe("/api"); }`,
      ),
    ).toBe(42);
  });

  it("combines Hono's trailing-slash and leading-slash branches", async () => {
    expect(
      await run(`
        function probe(base, sub) {
          const suffix = \`${'${base?.at(-1) === "/" ? "" : "/"}'}${'${sub?.[0] === "/" ? sub.slice(1) : sub}'}\`;
          return suffix === "api" ? 42 : -1;
        }
        export function runCase() { return probe("/", "/api"); }
      `),
    ).toBe(42);
  });

  it("builds the non-recursive mergePath template", async () => {
    expect(
      await run(`
        function probe(base, sub) {
          const merged = \`${'${base?.[0] === "/" ? "" : "/"}'}${"${base}"}${'${sub === "/" ? "" : `\${base?.at(-1) === "/" ? "" : "/"}\${sub?.[0] === "/" ? sub.slice(1) : sub}`}'}\`;
          return merged === "/api" ? 42 : -1;
        }
        export function runCase() { return probe("/", "/api"); }
      `),
    ).toBe(42);
  });

  it("does not re-read a getter receiver while property-chain dispatch stays deferred", async () => {
    expect(
      await run(
        `
        class Box {
          count = 0;
          get value() { this.count++; return "/"; }
        }
        function probe(box) { return box.value?.at(-1); }
        export function runCase() {
          const box = new Box();
          probe(box);
          return box.count;
        }
      `,
        false,
      ),
    ).toBe(1);
  });
});
