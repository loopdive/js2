// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// These are focused controls, not additional Test262 originals. The eight
// proposed source strings are preserved; the ninth checks the admitted static
// DV type with an actual non-view, so a heritage-constant-true fix cannot pass.
const CASES = [
  {
    id: "qualified_empty_DV_subclass",
    source:
      "class DV extends DataView {} const sample = new DV(new ArrayBuffer(1), 0, 0); export function run(){ return ArrayBuffer.isView(sample); }",
    expected: true,
    fileName: "test.js",
  },
  {
    id: "direct_DV_control",
    source:
      "const sample = new DataView(new ArrayBuffer(1), 0, 0); export function run(){ return ArrayBuffer.isView(sample); }",
    expected: true,
    fileName: "test.js",
  },
  {
    id: "direct_TA_control",
    source: "const sample = new Uint8Array(0); export function run(){ return ArrayBuffer.isView(sample); }",
    expected: true,
    fileName: "test.js",
  },
  {
    id: "ordinary_nonview_class",
    source: "class Plain {} const sample = new Plain(); export function run(){ return ArrayBuffer.isView(sample); }",
    expected: false,
    fileName: "test.js",
  },
  {
    id: "ordinary_array_control",
    source: "export function run(){ return ArrayBuffer.isView([]); }",
    expected: false,
    fileName: "test.js",
  },
  {
    id: "buffer_control",
    source: "export function run(){ return ArrayBuffer.isView(new ArrayBuffer(1)); }",
    expected: false,
    fileName: "test.js",
  },
  {
    id: "argument_once",
    source:
      "class DV extends DataView {} let calls = 0; function get(){ calls++; return new DV(new ArrayBuffer(1), 0, 0); } export function run(){ const yes = ArrayBuffer.isView(get()); return (yes ? 10 : 0) + calls; }",
    expected: 11,
    fileName: "test.js",
  },
  {
    id: "qualified_type_not_unconditional_true",
    source:
      "class DV extends DataView {} function pick(flag){ if(flag) return new DV(new ArrayBuffer(1), 0, 0); return {}; } export function run(){ return ArrayBuffer.isView(pick(false)); }",
    expected: false,
    fileName: "test.js",
  },
  {
    id: "DV_typed_parameter_nonview",
    source:
      "class DV extends DataView {} function check(sample: DV){ return ArrayBuffer.isView(sample); } export function run(){ return check({} as unknown as DV); }",
    expected: false,
    fileName: "test.ts",
  },
] as const;

describe("#5150 standalone isView: direct DataView subclass runtime brand", () => {
  it.each(CASES)("$id", async ({ source, expected, fileName }) => {
    const result = await compile(source, {
      fileName,
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(result.imports, "no host fallback").toEqual([]);
    const module = new WebAssembly.Module(result.binary);
    expect(WebAssembly.Module.imports(module), "focused modules need no provider").toEqual([]);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const instance = new WebAssembly.Instance(module, imports as unknown as WebAssembly.Imports);
    imports.setInstance?.(instance);
    const run = instance.exports.run;
    expect(run).toBeTypeOf("function");
    expect(Number((run as () => number)())).toBe(Number(expected));
  });
});
