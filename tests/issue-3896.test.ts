/**
 * #3896 — private generator methods (`class C { *#m() {} }`) must route to the
 * native standalone lowering instead of the eager host-buffer path.
 *
 * Kill-switched: restore `!ts.isPrivateIdentifier(decl.name)` in
 * `isNativeGeneratorCandidate` and every case below emits
 * `__create_generator` / `__gen_*` / `__get_caught_exception`, so
 * `WebAssembly.instantiate(binary, {})` throws
 * `Import #0 "env": module is not an object or function`. Verified 2026-07-31.
 *
 * NOTE ON INSTRUMENT: `runTest262File(..., "standalone")` cannot be used for
 * this question — it supplies the host imports, so a leaking module still
 * scores `pass` (measured pre/post byte-identical, see #3893). The only valid
 * checks are the import-set scan and instantiating with NO import object.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

const HOST_GEN = /__create_generator|__gen_create_buffer|__gen_next|__gen_push|__get_caught_exception/;

async function build(src: string): Promise<Uint8Array> {
  const r = (await compile(src, { fileName: "t.ts", target: "standalone" })) as unknown as {
    success: boolean;
    binary: Uint8Array;
    errors?: unknown;
  };
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  return r.binary;
}

async function runHostFree(src: string): Promise<number | undefined> {
  const binary = await build(src);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(binary);
  expect(text.match(HOST_GEN), "emitted host generator imports").toBeNull();
  // Instantiating with no imports is the second half of the assertion.
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports as { test?: () => number }).test?.();
}

describe("#3896 private generator methods route native in the standalone lane", () => {
  it("instance private generator", async () => {
    expect(
      await runHostFree(
        `class C { *#p() { yield 7; }
           run(): number { return this.#p().next().value as number; } }
         export function test(): number { return new C().run(); }`,
      ),
    ).toBe(7);
  });

  it("private generator with a binding-pattern param", async () => {
    expect(
      await runHostFree(
        `class C { *#p({ x }: { x: number }) { yield x; }
           run(): number { return this.#p({ x: 5 }).next().value as number; } }
         export function test(): number { return new C().run(); }`,
      ),
    ).toBe(5);
  });

  it("static private generator", async () => {
    expect(
      await runHostFree(
        `class C { static *#p() { yield 3; }
           static run(): number { return C.#p().next().value as number; } }
         export function test(): number { return C.run(); }`,
      ),
    ).toBe(3);
  });

  it("private generator resumes across two yields", async () => {
    expect(
      await runHostFree(
        `class C { *#p(a: number) { yield a; yield a + 1; }
           run(): number {
             const it = this.#p(4);
             const x = it.next().value as number;
             const y = it.next().value as number;
             return x * 10 + y;
           } }
         export function test(): number { return new C().run(); }`,
      ),
    ).toBe(45);
  });

  it("CONTROL — public generator method is unaffected", async () => {
    expect(
      await runHostFree(
        `class C { *m() { yield 9; }
           run(): number { return this.m().next().value as number; } }
         export function test(): number { return new C().run(); }`,
      ),
    ).toBe(9);
  });

  it("CONTROL — private non-generator method is unaffected", async () => {
    expect(
      await runHostFree(
        `class C { #m(): number { return 2; }
           run(): number { return this.#m(); } }
         export function test(): number { return new C().run(); }`,
      ),
    ).toBe(2);
  });

  /**
   * The bail this fix narrows exists to exclude computed/string-named
   * OBJECT-LITERAL methods. Those must stay excluded — the fix is safe by
   * construction (a private name cannot appear in an object literal), and this
   * pins that the intended scope did not widen.
   */
  it("CONTROL — string/computed-named object-literal generators stay excluded", async () => {
    for (const src of [
      `export function test(): number { const o = { *"m"() { yield 1; } }; return (o as any).m().next().value as number; }`,
      `export function test(): number { const k = "m"; const o = { *[k]() { yield 1; } }; return (o as any).m().next().value as number; }`,
    ]) {
      const text = new TextDecoder("utf-8", { fatal: false }).decode(await build(src));
      expect(text.match(HOST_GEN), "expected the (#2571) bail to still exclude this shape").not.toBeNull();
    }
  });
});
