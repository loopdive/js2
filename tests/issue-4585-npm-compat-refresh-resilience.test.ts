// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, validateJavaScriptAdapterManifest, type JavaScriptAdapterManifestV1 } from "../src/index.js";

const ACORN_PARSE_SHAPE = `
  var pp = {};
  function stringToNumber(str, legacy) {
    if (legacy) return parseInt(str, 8);
    return parseFloat(str.replace(/_/g, ""));
  }
  pp.read = function (str) { return parseInt(str, 8); };
  export function run(str) {
    return stringToNumber(str, true) + pp.read(str);
  }
`;

describe("#4585 npm compatibility refresh resilience", () => {
  it("reuses the ambient parseInt slot across legacy and prepared IR consumers", async () => {
    const previous = process.env.JS2WASM_LIB_SCAN;
    try {
      for (const scanner of [undefined, "checker"] as const) {
        if (scanner === undefined) Reflect.deleteProperty(process.env, "JS2WASM_LIB_SCAN");
        else process.env.JS2WASM_LIB_SCAN = scanner;
        const result = await compile(ACORN_PARSE_SHAPE, {
          fileName: "acorn-parse-shape.mjs",
          skipSemanticDiagnostics: true,
        });
        expect(result.success, result.errors.map(({ message }) => message).join("\n")).toBe(true);
        expect(WebAssembly.validate(result.binary)).toBe(true);

        const physical = WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).filter(
          ({ module, name, kind }) => module === "env" && name === "parseInt" && kind === "function",
        );
        expect(physical, scanner ?? "syntactic").toHaveLength(1);

        const manifest = result.adapterManifest!;
        const projected = manifest.imports.filter(
          ({ module, name, kind }) => module === "env" && name === "parseInt" && kind === "func",
        );
        expect(projected, scanner ?? "syntactic").toHaveLength(1);

        const imports = result.importObject!;
        const { instance } = await WebAssembly.instantiate(result.binary, imports);
        imports.__setInstance?.(instance);
        expect((instance.exports.run as (value: string) => number)("17")).toBe(30);

        const forged = {
          ...manifest,
          imports: [...manifest.imports, projected[0]!],
        } as JavaScriptAdapterManifestV1;
        expect(validateJavaScriptAdapterManifest(forged)).toContain(
          "duplicate adapter import 'env::parseInt' appears 2 times",
        );
      }
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_LIB_SCAN");
      else process.env.JS2WASM_LIB_SCAN = previous;
    }
  });
});
