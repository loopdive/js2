import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

// #1830 (integer-index ↔ well-known-symbol-id collision) — host mode.
//
// `_safeGet`/`_safeSet` in src/runtime.ts used to remap a numeric key 1..15 on a
// WasmGC struct onto a well-known-symbol slot via `_symbolIdToKeys`
// (5 → @@species, 7 → @@search/@@match, …). So a GENUINE integer-index write
// `o[5] = 55` on a typed struct landed under Symbol.species: `o[5]` round-tripped
// but `5 in o` was false, and for-in leaked "@@species" instead of "5".
//
// runtime.ts only runs in host mode, where the compiler boxes every well-known
// symbol access into a REAL JS Symbol (`o[Symbol.species]` arrives as
// typeof key === "symbol", never a number) — so a numeric key reaching these host
// helpers is always a genuine integer index. The remap was dropped; these tests
// pin the corrected behavior.
async function runHost(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const imp = buildImports(r.imports, undefined, r.stringPool) as Record<string, unknown> & {
    setInstance?: (i: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(r.binary, imp);
  if (typeof imp.setInstance === "function") imp.setInstance(instance);
  return (instance.exports as { test(): unknown }).test();
}

describe("#1830 integer-index keys 1..15 are not mis-routed to symbol slots", () => {
  it("o[5]/o[7] integer-index writes round-trip, are present, and enumerate in for-in", async () => {
    const out = await runHost(`class C { p = 1; }
export function test(): string {
  const o: any = new C();
  o[5] = 55; o[7] = 77;
  const roundtrip = o[5] === 55 && o[7] === 77;
  const present = (5 in o) && (7 in o);
  let forin = "";
  for (const k in o) forin += k + ";";
  return "rt=" + roundtrip + " present=" + present + " forin=" + forin;
}`);
    // for-in: integer keys ascending first (5, 7), then string field p (#2131 ordering).
    expect(out).toBe("rt=true present=true forin=5;7;p;");
  });

  it("a real well-known-symbol key still resolves (arrives as a real JS Symbol)", async () => {
    const out = await runHost(`class C { p = 1; }
export function test(): string {
  const o: any = new C();
  o[Symbol.species] = 9;            // real Symbol key (typeof === "symbol")
  o[5] = 55;                        // genuine integer index — must NOT collide
  return "sp=" + (o[Symbol.species] === 9) + " idx=" + (o[5] === 55);
}`);
    expect(out).toBe("sp=true idx=true");
  });

  it("index 0 (outside the old 1..15 range) keeps working", async () => {
    const out = await runHost(`class C { p = 1; }
export function test(): string {
  const o: any = new C();
  o[0] = 'zero';
  let forin = ""; for (const k in o) forin += k + ";";
  return (0 in o) + ":" + forin;
}`);
    expect(out).toBe("true:0;p;");
  });
});
