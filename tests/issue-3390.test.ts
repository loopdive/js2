// #3390 slice 1 — `Promise.<combinator>.call(recv, …)` with a STATICALLY
// non-constructor receiver throws a synchronous TypeError (§27.2.4.1 step 2,
// IsConstructor, before the iterable is touched). On the standalone/wasi lane
// the host fallback (`Promise_all` etc.) previously leaked; this emits the
// native `__exn`-tag TypeError instead — host-free.
//
// Covers the test262 `built-ins/Promise/{all,allSettled,race,any}/ctx-non-ctor`
// + `ctx-non-object` cohort (8 files → pass). Constructor / global-`Promise` /
// dynamic receivers fall through to the existing host path (correct-or-legacy);
// the gc/host lane is byte-identical.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

interface Ex {
  test: () => number;
}

const COMBINATORS = ["all", "allSettled", "race", "any"] as const;

/** Compile standalone; assert host-free; run `test()` which returns 2 iff a
 *  TypeError was thrown by the combinator `.call`. */
async function throwsTypeError(body: string): Promise<number> {
  const src = `
    export function test(): number {
      var code = 0;
      try { ${body} } catch (e) { code = (e instanceof TypeError) ? 2 : 1; }
      return code;
    }`;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as unknown as Ex).test();
}

/** Compile and report whether the module requests any `env::` host import. */
async function envImports(src: string, target: "standalone" | "wasi" | undefined): Promise<string[]> {
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  return (r.imports ?? []).map((i) => `${i.module}.${i.name}`).filter((n) => n.startsWith("env."));
}

describe("#3390 slice 1 — non-constructor combinator .call receiver → native TypeError", () => {
  for (const m of COMBINATORS) {
    it(`${m}: non-object receivers (undefined/null/primitive/Symbol) throw TypeError host-free`, async () => {
      expect(await throwsTypeError(`Promise.${m}.call(undefined, []);`)).toBe(2);
      expect(await throwsTypeError(`Promise.${m}.call(null, []);`)).toBe(2);
      expect(await throwsTypeError(`Promise.${m}.call(86, []);`)).toBe(2);
      expect(await throwsTypeError(`Promise.${m}.call('string', []);`)).toBe(2);
      expect(await throwsTypeError(`Promise.${m}.call(true, []);`)).toBe(2);
      expect(await throwsTypeError(`Promise.${m}.call(Symbol(), []);`)).toBe(2);
    });

    it(`${m}: callable non-constructors (eval, arrow) throw TypeError host-free`, async () => {
      expect(await throwsTypeError(`Promise.${m}.call(eval);`)).toBe(2);
      expect(await throwsTypeError(`Promise.${m}.call(() => {}, []);`)).toBe(2);
    });

    it(`${m}: empty-object receiver throws TypeError host-free`, async () => {
      expect(await throwsTypeError(`Promise.${m}.call({}, []);`)).toBe(2);
    });

    it(`${m}: no receiver (undefined) throws TypeError host-free`, async () => {
      expect(await throwsTypeError(`Promise.${m}.call();`)).toBe(2);
    });
  }

  it("does NOT touch the iterable: a would-throw getter side effect never runs", async () => {
    // If the combinator iterated the argument, the poisoned iterator getter
    // would run; the TypeError must be the receiver's, thrown before iteration.
    const v = await throwsTypeError(`
      var iterated = 0;
      var poison: any = { get length() { iterated = 1; throw new Error("iterated"); } };
      Promise.all.call(undefined, poison);
    `);
    // TypeError from the receiver check (code 2), not the Error from iteration (code 1).
    expect(v).toBe(2);
  });

  it("fall-through: direct `Promise.all([])` stays native host-free (unchanged)", async () => {
    expect(await envImports(`export async function f() { await Promise.all([]); }`, "standalone")).toEqual([]);
  });

  it("fall-through: a real subclass-constructor receiver still routes to host (correct-or-legacy)", async () => {
    const imports = await envImports(
      `class SubPromise extends Promise {}
       export function f() { return Promise.all.call(SubPromise, []); }`,
      "standalone",
    );
    expect(imports.length).toBeGreaterThan(0);
  });

  it("fall-through: global `Promise` receiver is slice 2, not slice 1 — stays host", async () => {
    const imports = await envImports(`export function f() { return Promise.all.call(Promise, []); }`, "standalone");
    expect(imports.length).toBeGreaterThan(0);
  });

  it("host (gc) lane is unchanged: a slice-1 shape still uses the host path", async () => {
    const imports = await envImports(
      `export function f() { try { Promise.all.call(undefined, []); } catch (e) {} return 0; }`,
      undefined,
    );
    expect(imports.length).toBeGreaterThan(0);
  });
});
