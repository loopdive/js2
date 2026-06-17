// #2163 — standalone Symbol() creation leaked a host import.
//
// `Symbol()` / `Symbol(desc)` lowers to a unique i32 counter id, and (#1467) it
// also called `env::__symbol_register_desc` to register the description with the
// JS host so a later `__box_symbol(id)` could reconstruct `Symbol(desc)`. That
// host call was emitted UNCONDITIONALLY, so under `--target standalone` /
// `--target wasi` the module carried an unsatisfiable `env::__symbol_register_desc`
// import and failed to instantiate — making EVERY `Symbol()` call a runtime
// failure standalone (the foundational slice of the Symbol standalone gap).
//
// Fix (src/codegen/literals.ts compileSymbolCall): the description registration
// is a pure JS-host fast path — the symbol value itself is just the i32 id,
// which is all `typeof s === "symbol"` and symbol identity/distinctness need.
// Gate the host registration on JS-host mode; standalone only evaluates the
// description argument for side effects.
//
// (Out of this slice: `.description`, `Symbol.for`/`keyFor` registry, and
// `Symbol#toString` still need native description storage — separate slices.)
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  // No host-import leak for the Symbol-creation path.
  const leaked = (r.imports ?? []).filter((i) => /__symbol_register_desc|__box_symbol/.test(i.name));
  expect(
    leaked.map((i) => i.name),
    "no symbol host-import leak",
  ).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#2163 standalone Symbol() creation (no host-import leak)", () => {
  it("Symbol() constructs and typeof is 'symbol'", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const s = Symbol(); return typeof s === "symbol" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("Symbol(desc) constructs (description arg evaluated for side effects)", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const s = Symbol("hi"); return typeof s === "symbol" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("two Symbols are distinct values", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a = Symbol("z"); const b = Symbol("z"); return a === b ? 1 : 0; }`,
      ),
    ).toBe(0);
  });

  it("a Symbol equals itself", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a = Symbol("z"); const b = a; return a === b ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("Symbol() with a side-effecting description arg still evaluates it", async () => {
    // The description expression must still run (spec: ToString(description)).
    expect(
      await runStandalone(
        `export function run(): number { let n = 0; const f = (): string => { n = 7; return "d"; }; const s = Symbol(f()); return typeof s === "symbol" ? n : -1; }`,
      ),
    ).toBe(7);
  });

  it("well-known Symbol.iterator is a symbol", async () => {
    expect(
      await runStandalone(`export function run(): number { return typeof Symbol.iterator === "symbol" ? 1 : 0; }`),
    ).toBe(1);
  });
});
