import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2029 — `Object.create(proto, descriptors)` standalone emit crash.
//
// The compile-time descriptor expansion in the `Object.create` handler
// (`src/codegen/expressions/calls.ts`) materialized each property KEY with a
// raw `{ op: "global.get", index: stringGlobalMap.get(key) }`. Under
// `--target standalone` / nativeStrings, `addStringConstantGlobal` stores the
// documented -1 sentinel ("no host import — materialize inline", #1174), so
// the emitted `global.get -1` blew up the binary encoder:
//   `Binary emit error: Codegen error: global index out of range — -1`
// — a hard compile_error that loses the whole file. (gc/host mode kept real
// globals, so it never hit the sentinel there.)
//
// Fix: emit the key via the dual-mode `stringConstantExternrefInstrs` helper
// (native-string externref standalone; `global.get` for a valid host global),
// which already guards the -1 sentinel. Both the static (`__defineProperty_value`)
// and dynamic-flag (`__defineProperty_desc`) descriptor arms are covered.

async function compileStandalone(src: string) {
  return compile(src, { fileName: "test.ts", target: "standalone", skipSemanticDiagnostics: true });
}

async function runStandalone(src: string): Promise<number> {
  const r = await compileStandalone(src);
  if (!r.success) throw new Error("compile failed: " + (r.errors[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#2029 Object.create(proto, descriptors) standalone emit", () => {
  it("single value descriptor compiles standalone (was: global index out of range -1)", async () => {
    const r = await compileStandalone(
      `export function test(): number { const o: any = Object.create(null, { x: { value: 1 } }); return 1; }`,
    );
    expect(r.success).toBe(true);
  });

  it("value descriptor with a non-null proto compiles standalone", async () => {
    const r = await compileStandalone(
      `const proto = {}; export function test(): number { const o: any = Object.create(proto, { x: { value: 1 } }); return 1; }`,
    );
    expect(r.success).toBe(true);
  });

  it("descriptor with a static boolean flag compiles standalone", async () => {
    const r = await compileStandalone(
      `export function test(): number { const o: any = Object.create(null, { x: { value: 1, writable: true, enumerable: true } }); return 1; }`,
    );
    expect(r.success).toBe(true);
  });

  it("string-literal descriptor key compiles standalone", async () => {
    const r = await compileStandalone(
      `export function test(): number { const o: any = Object.create(null, { "k-1": { value: 1 } }); return 1; }`,
    );
    expect(r.success).toBe(true);
  });

  it("multiple descriptor keys compile standalone", async () => {
    const r = await compileStandalone(
      `export function test(): number { const o: any = Object.create(null, { a: { value: 1 }, b: { value: 2 } }); return 1; }`,
    );
    expect(r.success).toBe(true);
  });

  it("does not emit a -1 string-global (no encoder crash)", async () => {
    const r = await compileStandalone(
      `export function test(): number { const o: any = Object.create(null, { x: { value: 1 } }); return 1; }`,
    );
    expect(r.success).toBe(true);
    expect(r.errors.some((e) => /global index out of range/.test(e.message))).toBe(false);
  });

  it("reads back a single value-descriptor property standalone", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = Object.create(null, { x: { value: 42 } }); return o.x; }`,
      ),
    ).toBe(42);
  });

  it("reads back a string-literal-key property standalone", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = Object.create(null, { "k-1": { value: 5 } }); return o["k-1"]; }`,
      ),
    ).toBe(5);
  });

  it("host (gc) mode unaffected — Object.create descriptors still compile", async () => {
    const r = await compile(
      `export function test(): number { const o: any = Object.create(null, { a: { value: 1 }, b: { value: 2 } }); return 1; }`,
      { fileName: "test.ts", skipSemanticDiagnostics: true },
    );
    expect(r.success).toBe(true);
  });
});
