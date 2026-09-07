import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

import { buildCompiledAdapterImports, instantiateWasm, wrapExports } from "../src/runtime.js";
import { diffAst } from "./dogfood/ast-diff.mjs";
import { setupAcorn } from "./dogfood/setup-acorn.mjs";

// The playground's AST explorer parses with acorn COMPILED TO WASM by this
// compiler, loaded from committed artifacts under website/public/acorn/.
//
// Those artifacts are built by hand (`pnpm run build:acorn-wasm`, ~30s and a
// multi-GB heap), so nothing regenerates them on a normal CI run — which makes
// them exactly the kind of thing that rots silently. This test does not check
// freshness; it checks that what IS committed still loads and parses correctly,
// following the same three steps the browser does:
//
//   1. build the import object from the committed adapter manifest JSON,
//   2. instantiate,
//   3. wrapExports — without it `parse` returns an opaque WasmGC handle and
//      every AST node inspects as an empty object.
//
// node-acorn from the same pinned tarball is the oracle, so any divergence is a
// compiler bug rather than a version difference.

const ACORN_DIR = path.resolve("website/public/acorn");
const WASM_PATH = path.join(ACORN_DIR, "acorn.wasm");
const MANIFEST_PATH = path.join(ACORN_DIR, "acorn.manifest.json");
const META_PATH = path.join(ACORN_DIR, "meta.json");

const PARSE_OPTIONS = { ecmaVersion: 2022, sourceType: "module" as const };

// Deliberately spans several node families the explorer renders differently:
// declarations, a class with a private field, arrow + template + destructuring.
const SAMPLE = `export class Counter {
  #n = 0;
  inc(by = 1) { this.#n += by; return this.#n; }
}
const squares = [1, 2, 3].map((x) => x ** 2);
for (const [k, v] of Object.entries({ a: 1 })) console.log(\`\${k}=\${v}\`);
`;

async function loadCompiledAcorn() {
  const bytes = readFileSync(WASM_PATH);
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));

  const imports = buildCompiledAdapterImports(manifest);
  const { instance } = await instantiateWasm(bytes, imports.env, imports.string_constants, imports.string_constants16);
  imports.setInstance?.(instance);

  const exports = wrapExports(instance, {
    signatures: manifest.exportSignatures,
    boundaryPolicies: manifest.exportBoundaries,
  });
  return exports as { parse: (src: string, opts: typeof PARSE_OPTIONS) => any };
}

describe("playground AST explorer — committed acorn.wasm artifact", () => {
  it("ships all three files the panel fetches", () => {
    expect(existsSync(WASM_PATH), `${WASM_PATH} missing — run pnpm run build:acorn-wasm`).toBe(true);
    expect(existsSync(MANIFEST_PATH)).toBe(true);
    expect(existsSync(META_PATH)).toBe(true);

    const meta = JSON.parse(readFileSync(META_PATH, "utf-8"));
    const pin = JSON.parse(readFileSync("tests/dogfood/acorn-pin.json", "utf-8"));
    // A meta.json naming a different acorn than the pin means the artifact was
    // built from a source the oracle below no longer matches.
    expect(meta.acornVersion).toBe(pin.version);
    expect(meta.wasmBytes).toBe(readFileSync(WASM_PATH).length);
  });

  it("instantiates and parses, matching node-acorn on the same input", async () => {
    const compiled = await loadCompiledAcorn();
    expect(typeof compiled.parse).toBe("function");

    const ast = compiled.parse(SAMPLE, PARSE_OPTIONS);
    expect(ast.type).toBe("Program");
    // Ranges drive the panel's click-to-select; a node without them is useless
    // there even if the tree shape is right.
    expect(typeof ast.body[0].start).toBe("number");
    expect(typeof ast.body[0].end).toBe("number");

    const { entryModulePath } = setupAcorn();
    const oracle = await import(entryModulePath);
    const diff = diffAst(oracle.parse(SAMPLE, PARSE_OPTIONS), ast, {
      ignorePositions: true,
      // Uncapped: a capped "equal" hides exactly the divergences worth seeing.
      maxDivergences: 100000,
    });

    // Cosmetic host-marshalling artifacts are not parser bugs — same split
    // tests/dogfood/acorn-corpus.mjs applies.
    const real = diff.divergences.filter(
      (d: { reason: string; path: string; expected: unknown; actual: unknown }) =>
        !(d.reason === "extra-field" && /\.sourceFile$/.test(d.path)) &&
        !(typeof d.expected === "boolean" && (d.actual === 0 || d.actual === 1)),
    );
    expect(real).toEqual([]);
  }, 120_000);

  it("reports a parse error rather than throwing something unreadable", async () => {
    const compiled = await loadCompiledAcorn();
    // The panel surfaces `error.message`; an error without one would render as
    // an empty status line.
    expect(() => compiled.parse("function (", PARSE_OPTIONS)).toThrow(/./);
  }, 120_000);
});

// (#5337) The iOS Safari symptom, produced under V8 by the one thing that
// yields it here: an instance whose export set was never published
// (`setInstance` not called). The module cannot read the host options object,
// acorn falls back to its defaults (warning "Since Acorn 8.0.0,
// options.ecmaVersion is required"), and then dies inside its keyword table
// with "Cannot read properties of null (reading 'replace')" — thrown by the
// runtime's own `__extern_method_call` guard, hence V8 wording on every engine.
//
// The actual iOS cause was different (helpers MASKED by identity checks JSC
// cannot satisfy — see tests/issue-5337-exported-function-identity.test.ts);
// this pins the symptom the panel's load-time canary detects, so a future fix
// that makes the unwired case loud is recognised as a change, not a surprise.
describe("#5337 — unwired host boundary degrades silently", () => {
  it("parses with default options and then throws deep inside, instead of failing loudly", async () => {
    const bytes = readFileSync(WASM_PATH);
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));

    const imports = buildCompiledAdapterImports(manifest);
    const { instance } = await instantiateWasm(
      bytes,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    );
    // Deliberately NOT calling imports.setInstance(instance).
    const exports = wrapExports(instance, {
      signatures: manifest.exportSignatures,
      boundaryPolicies: manifest.exportBoundaries,
    }) as { parse: (src: string, opts: typeof PARSE_OPTIONS) => any };

    expect(typeof exports.parse).toBe("function");
    expect(() => exports.parse(SAMPLE, PARSE_OPTIONS)).toThrow(/Cannot read properties of null/);
  }, 120_000);

  it("a wired instance parses the same input correctly", async () => {
    const compiled = await loadCompiledAcorn();
    // The canary the panel runs at load: a one-token parse must round-trip.
    const canary = compiled.parse("0", PARSE_OPTIONS);
    expect(canary.body[0].expression.value).toBe(0);
    expect(compiled.parse(SAMPLE, PARSE_OPTIONS).type).toBe("Program");
  }, 120_000);
});
