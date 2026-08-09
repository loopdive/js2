import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

/**
 * #2572 — statement-form `for (const k in o)` over a dynamic (`$Object`)
 * receiver used to leak the `env.__for_in_*` host imports under
 * `--target standalone` / WASI: the module validated but could not instantiate
 * (no JS host to satisfy the imports). It now routes through the native object
 * runtime (`__object_keys` + `__extern_length`/`__extern_get_idx`/`__extern_has`),
 * mirroring standalone `Object.keys`, so it is host-free, spec-ordered (#1837),
 * tombstone-aware (delete), and honours per-visit liveness (#2066). A closed
 * WasmGC struct keeps the exact static-unroll path.
 */
async function runStandalone(source: string): Promise<{ ret: number; leaked: string[]; valid: boolean }> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e: any) => e.message).join("\n")).toBe(true);
  const valid = WebAssembly.validate(r.binary);
  const mod = await WebAssembly.compile(r.binary);
  const leaked = WebAssembly.Module.imports(mod)
    .filter((i) => i.module === "env" && /^__for_in_/.test(i.name))
    .map((i) => i.name);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ret = (instance.exports as Record<string, () => number>).run();
  return { ret, leaked, valid };
}

describe("#2572 — standalone for-in over a dynamic object (no host-import leak)", () => {
  it("for-in over an `any` object instantiates and counts own keys", async () => {
    const { ret, leaked, valid } = await runStandalone(
      `export function run(): number { const o: any = { a: 1, b: 2 }; let n = 0; for (const k in o) n++; return n; }`,
    );
    expect(valid).toBe(true);
    expect(leaked).toEqual([]); // no env.__for_in_* imports leaked
    expect(ret).toBe(2);
  });

  it("enumerates keys in insertion order (#1837)", async () => {
    // acc = ('a'=97) then ('b'=98) → 97*100 + 98 = 9798
    const { ret, leaked } = await runStandalone(
      `export function run(): number { const o: any = { a: 1, b: 2 }; let acc = 0; for (const k in o) { acc = acc * 100 + k.charCodeAt(0); } return acc; }`,
    );
    expect(leaked).toEqual([]);
    expect(ret).toBe(9798);
  });

  it("omits a key deleted before the loop (tombstone-aware)", async () => {
    // a,c survive after `delete o.b` → 97*100 + 99 = 9799
    const { ret, leaked } = await runStandalone(
      `export function run(): number { const o: any = { a: 1, b: 2, c: 3 }; delete o.b; let acc = 0; for (const k in o) { acc = acc * 100 + k.charCodeAt(0); } return acc; }`,
    );
    expect(leaked).toEqual([]);
    expect(ret).toBe(9799);
  });

  it("includes a key added at runtime", async () => {
    const { ret, leaked } = await runStandalone(
      `export function run(): number { const o: any = { a: 1 }; o.b = 2; let n = 0; for (const k in o) n++; return n; }`,
    );
    expect(leaked).toEqual([]);
    expect(ret).toBe(2);
  });

  it("skips a key deleted during enumeration (#2066 per-visit liveness)", async () => {
    // on visiting 'a' we delete 'b'; only a,c are observed → 9799
    const { ret, leaked } = await runStandalone(
      `export function run(): number { const o: any = { a: 1, b: 2, c: 3 }; let acc = 0; for (const k in o) { acc = acc * 100 + k.charCodeAt(0); if (k === "a") delete o.b; } return acc; }`,
    );
    expect(leaked).toEqual([]);
    expect(ret).toBe(9799);
  });

  it("reads the value for each enumerated key", async () => {
    const { ret, leaked } = await runStandalone(
      `export function run(): number { const o: any = { a: 1, b: 2 }; let sum = 0; for (const k in o) { sum += (o[k] as number); } return sum; }`,
    );
    expect(leaked).toEqual([]);
    expect(ret).toBe(3);
  });

  it("keeps a reused hoisted var as a dynamic property key", async () => {
    const { ret, leaked } = await runStandalone(`
      function cloneLike(config: any): number {
        let copied = 0;
        for (propName in config) {
          if (propName === "className" && config[propName] === "new") copied = 1;
        }
        var propName = arguments.length - 2;
        return copied * 10 + propName;
      }

      export function run(): number {
        return cloneLike({ key: "after", className: "new" } as any);
      }
    `);
    expect(leaked).toEqual([]);
    expect(ret).toBe(9);
  });

  it("a closed-shape (interface) receiver enumerates its fields via the static path", async () => {
    const { ret, leaked, valid } = await runStandalone(
      `interface P { a: number; b: number; } export function run(): number { const o: P = { a: 1, b: 2 }; let n = 0; for (const k in o) n++; return n; }`,
    );
    expect(valid).toBe(true);
    expect(leaked).toEqual([]);
    expect(ret).toBe(2);
  });
});
