// #3481 — a `symbol[]` must materialise from a HOST symbol array without
// ToNumber-ing its elements.
//
// A symbol VALUE lowers to an i32 id, so `symbol[]` shared the unbranded
// `$__arr_i32` element type with `boolean[]` and the i32 typed-array views.
// `buildElemCoerce` therefore materialised `Object.getOwnPropertySymbols(o)`
// — a real host array of real host Symbols — by `__unbox_number`-ing every
// element, i.e. `Number(Symbol())`, which throws §7.1.4 "Cannot convert a
// Symbol value to a number". It threw at the DECLARATION, before the array was
// read at all, and even when it was never read.
//
// The fix brands the element type (`{kind:"i32", symbol:true}`) and registers
// the branded vec under its own key, so the element coercion can pick the
// existing symbol boundary seam — `__unbox_symbol` in the JS-host lane, which
// resolves the symbol through the SAME per-instance cache `__box_symbol`
// fills, so a symbol the module created round-trips to its own id and
// `syms[0] === sym` holds. Standalone/WASI keep the #2866 `$Symbol`-carrier
// arm untouched.
//
// The `symbolarr` / `roundtrip` cases below FAIL on the base compiler; the
// `guard` cases pass on both sides and are here so a later refactor cannot
// take the shared i32-vec path with it — in particular the materialisation of
// a host array holding a Symbol into a numeric or boolean vec, which must keep
// throwing TypeError.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(body: string, opts: Record<string, unknown> = {}): Promise<any> {
  const src = `export function test(): any { ${body} }`;
  const result: any = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true, ...opts } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures }).test();
}

/**
 * Report `"TypeError"` only for a REAL catchable TypeError. The guards below
 * assert that a Symbol reaching a NUMERIC vec still throws; "something threw"
 * is too weak an assertion for that, because the pre-fix failure mode was also
 * a throw — just at a different place and for a different reason.
 */
async function throwKind(body: string): Promise<string> {
  return await run(`
    try { ${body} } catch (e) {
      if (e instanceof TypeError) { return "TypeError"; }
      const c: any = (e as any) && (e as any).constructor;
      return "other:" + (c && c.name ? c.name : typeof e);
    }
  `);
}

describe("#3481 — `symbol[]` materialisation from a host symbol array", () => {
  it("an INFERRED `symbol[]` const does not throw and keeps symbol identity", async () => {
    expect(
      await run(`
      const obj: any = {}; const sym = Symbol("test"); obj[sym] = 1;
      const syms = Object.getOwnPropertySymbols(obj);
      return String(syms.length) + "|" + typeof syms[0] + "|" + String(syms[0] === sym);`),
    ).toBe("1|symbol|true");
  });

  it("an ANNOTATED `symbol[]` behaves the same", async () => {
    expect(
      await run(`
      const obj: any = {}; const sym = Symbol("test"); obj[sym] = 1;
      const syms: symbol[] = Object.getOwnPropertySymbols(obj);
      return String(syms.length) + "|" + String(syms[0] === sym);`),
    ).toBe("1|true");
  });

  it("`readonly symbol[]` behaves the same (readonly has no runtime rep)", async () => {
    expect(
      await run(`
      const obj: any = {}; const sym = Symbol("test"); obj[sym] = 1;
      const syms: readonly symbol[] = Object.getOwnPropertySymbols(obj);
      return String(syms.length) + "|" + String(syms[0] === sym);`),
    ).toBe("1|true");
  });

  it("a description-less Symbol round-trips", async () => {
    expect(
      await run(`
      const obj: any = {}; const sym = Symbol(); obj[sym] = 1;
      const syms: symbol[] = Object.getOwnPropertySymbols(obj);
      return String(syms[0] === sym);`),
    ).toBe("true");
  });

  it("two symbols keep their order and their separate identities", async () => {
    expect(
      await run(`
      const obj: any = {}; const a = Symbol("a"); const b = Symbol("b");
      obj[a] = 1; obj[b] = 2;
      const syms: symbol[] = Object.getOwnPropertySymbols(obj);
      return String(syms.length) + "|" + String(syms[0] === a) + "|" + String(syms[1] === b)
           + "|" + String(syms[0] === b);`),
    ).toBe("2|true|true|false");
  });

  it("a WELL-KNOWN symbol key round-trips to the same symbol", async () => {
    expect(
      await run(`
      const obj: any = {}; obj[Symbol.iterator] = 1;
      const syms: symbol[] = Object.getOwnPropertySymbols(obj);
      return String(syms.length) + "|" + String(syms[0] === Symbol.iterator);`),
    ).toBe("1|true");
  });

  it("a REGISTERED symbol (Symbol.for) round-trips through the registry", async () => {
    expect(
      await run(`
      const obj: any = {}; const r = Symbol.for("reg"); obj[r] = 1;
      const syms: symbol[] = Object.getOwnPropertySymbols(obj);
      return String(syms.length) + "|" + String(syms[0] === Symbol.for("reg"));`),
    ).toBe("1|true");
  });

  it("the DECLARATION alone no longer throws, even when the array is never read", async () => {
    // The pre-fix throw happened while materialising the initializer, so a
    // program that only ever reads `.length` still died. This case pins that
    // the failure was in the materialisation, not in any element read.
    expect(
      await run(`
      const obj: any = {}; obj[Symbol("q")] = 1;
      const syms: symbol[] = Object.getOwnPropertySymbols(obj);
      return String(syms.length);`),
    ).toBe("1");
  });

  it("a DYNAMIC (`any`) read of the vec yields a Symbol, not the raw id", async () => {
    // Exercises the `__vec_get` host-glue export rather than the typed read:
    // without the symbol box arm this answers the integer id.
    expect(
      await run(`
      const obj: any = {}; const sym = Symbol("d"); obj[sym] = 1;
      const syms: symbol[] = Object.getOwnPropertySymbols(obj);
      const dyn: any = syms;
      return typeof dyn[0] + "|" + String(dyn[0] === sym);`),
    ).toBe("symbol|true");
  });

  it("an EMPTY symbol array is still empty", async () => {
    expect(
      await run(`
      const obj: any = {};
      const syms: symbol[] = Object.getOwnPropertySymbols(obj);
      return String(syms.length);`),
    ).toBe("0");
  });
});

describe("#3481 — the two lanes acquire the right imports", () => {
  const SRC = `export function test(): any {
      const obj: any = {}; obj[Symbol("s")] = 1;
      const syms: symbol[] = Object.getOwnPropertySymbols(obj);
      return syms.length; }`;

  async function importNames(opts: Record<string, unknown>): Promise<string[]> {
    const result: any = await compile(SRC, { fileName: "test.ts", skipSemanticDiagnostics: true, ...opts } as any);
    expect(result.binary?.length).toBeGreaterThan(0);
    expect(Array.isArray(result.imports)).toBe(true);
    return (result.imports as any[]).map((i) => (typeof i === "string" ? i : i?.name)).filter(Boolean);
  }

  it("the JS-host lane DOES reach the symbol seam (`__unbox_symbol`)", async () => {
    // The positive half of the pair. Without it the standalone assertion below
    // is near-vacuous: a host-free module imports NOTHING, so "does not import
    // `__unbox_symbol`" would also hold if the whole mechanism were dead.
    expect(await importNames({})).toContain("__unbox_symbol");
  });

  it("the standalone lane acquires NO host import at all", async () => {
    // The brand must not drag the JS-host `__unbox_symbol` into a host-free
    // module: standalone keeps the #2866 `$Symbol`-carrier element read, and
    // the import floor stays at zero.
    const imported = await importNames({ target: "standalone" });
    expect(imported).not.toContain("__unbox_symbol");
    expect(imported).toEqual([]);
  });
});

describe("#3481 — regression guards on the shared i32-element vec path", () => {
  it("a host array holding a Symbol still throws for `Uint8Array`", async () => {
    expect(await throwKind(`const src: any = [Symbol()]; const t = new Uint8Array(src); return "no-throw";`)).toBe(
      "TypeError",
    );
  });

  it("a host array holding a Symbol still throws for `Uint32Array`", async () => {
    expect(await throwKind(`const src: any = [Symbol()]; const t = new Uint32Array(src); return "no-throw";`)).toBe(
      "TypeError",
    );
  });

  it("a host array holding a Symbol still throws for `Int32Array`", async () => {
    expect(await throwKind(`const src: any = [Symbol()]; const t = new Int32Array(src); return "no-throw";`)).toBe(
      "TypeError",
    );
  });

  it("a host array holding a Symbol still throws for `boolean[]`", async () => {
    expect(await throwKind(`const src: any = [Symbol()]; const a: boolean[] = src; return "no-throw";`)).toBe(
      "TypeError",
    );
  });

  it("a host array holding a Symbol still throws for `number[]`", async () => {
    expect(await throwKind(`const src: any = [Symbol()]; const a: number[] = src; return "no-throw";`)).toBe(
      "TypeError",
    );
  });

  it("`(symbol | number)[]` is NOT branded and keeps the plain i32 vec", async () => {
    // `symbolBrand` requires EVERY non-null/undefined constituent to be a
    // symbol. A mixed element type must not acquire symbol element semantics.
    expect(
      await run(`const mixed: (symbol | number)[] = [1, 2]; return String(mixed.length) + "|" + String(mixed[0]);`),
    ).toBe("2|1");
  });

  it("`boolean[]` materialised from a host array is unaffected", async () => {
    expect(
      await run(`const src: any = [true, false, true]; const a: boolean[] = src;
        return String(a.length) + "|" + String(a[0]) + "|" + String(a[1]);`),
    ).toBe("3|true|false");
  });

  it("`number[]` materialised from a host array is unaffected", async () => {
    expect(await run(`const src: any = [1, 2, 3]; const a: number[] = src; return String(a[0] + a[2]);`)).toBe("4");
  });

  it("numeric typed arrays built from number arrays are unaffected", async () => {
    expect(await run(`const t = new Uint8Array([1, 2, 300]); return String(t[0]) + "|" + String(t[2]);`)).toBe("1|300");
    expect(await run(`const t = new Uint32Array([1, 2, 3]); return String(t[0]) + "|" + String(t[2]);`)).toBe("1|3");
  });

  it("a `string[]` vec materialised from a host array is unaffected", async () => {
    expect(await run(`const src: any = ["a", "b"]; const a: string[] = src; return a.join("-");`)).toBe("a-b");
  });

  it("`Object.getOwnPropertyNames(anyObject).join()` — PRE-EXISTING GAP, pinned as observed", async () => {
    // This answers `""` where the spec says `"a,b"`, on the base compiler and
    // on this branch alike (measured byte-identical). It is pinned at the
    // OBSERVED value rather than the correct one so the guard keeps watching
    // the shared vec path without silently asserting a bug is a feature — if a
    // later fix makes it correct, this expectation must be updated, which is
    // the point. Not this slice's defect: `getOwnPropertyNames` returns
    // `string[]`, which is never branded.
    expect(await run(`const o: any = { a: 1, b: 2 }; return Object.getOwnPropertyNames(o).join(",");`)).toBe("");
  });

  it("a symbol used as a plain property key is unaffected", async () => {
    expect(await run(`const o: any = {}; const s = Symbol("x"); o[s] = 7; return String(o[s]);`)).toBe("7");
  });

  it("`Symbol.keyFor` on a static registered symbol is unaffected", async () => {
    expect(await run(`const r = Symbol.for("k"); return String(Symbol.keyFor(r));`)).toBe("k");
  });

  it("`typeof` a symbol is unaffected", async () => {
    expect(await run(`const s = Symbol("x"); return typeof s;`)).toBe("symbol");
  });
});
