import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

// #1623: When a module-level `any`-typed binding lowers to an `externref`
// global, downstream coercions (e.g. a computed class-member key reading
// that global) must not wrap the value in `extern.convert_any` a second
// time — that op expects an anyref operand and Wasm rejects the module
// with `expected type anyref, found global.get of type externref`.

async function instantiates(src: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) return { ok: false, reason: `CE: ${r.errors[0]?.message ?? "unknown"}` };
  try {
    const imports = new Proxy({}, { get: () => new Proxy({}, { get: () => () => undefined }) });
    await WebAssembly.instantiate(r.binary, imports as never);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `instantiate: ${(e as Error).message}` };
  }
}

describe("#1623 extern.convert_any over already-externref operand", () => {
  it("computed class-member key read from externref global yields valid Wasm", async () => {
    const src = `
let __fail: number = 0;
let computed: any;

export function test(): number {
  computed = 'h';
  try {
    class C {
      static f = 'test262';
      static 'g';
      static 0 = 'bar';
      static [computed];
    }
    let c = new C();
  } catch (e) {
    if (!__fail) __fail = -1;
    throw e;
  }
  return 1;
}
`;
    const result = await instantiates(src);
    expect(result).toEqual({ ok: true });
  });

  it("subclass of externref-backed parent — global.get + extern.convert_any chain", async () => {
    // The S15.7.1/subclass binding shape, condensed: an externref global is
    // assigned a host-constructed value and then read back inside the test
    // function body. Pre-#1623 the fixup pass missed the import-side global
    // index and left a redundant extern.convert_any in the body.
    const src = `
let g: any;

export function test(): number {
  g = {};
  let x: any = g;
  try { return 1; } catch (e) { return -1; }
}
`;
    const result = await instantiates(src);
    expect(result).toEqual({ ok: true });
  });
});
