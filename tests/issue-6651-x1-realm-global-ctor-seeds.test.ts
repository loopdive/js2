// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 lane X1 — the standalone realm global (`globalThis`) must expose the
 * SAME carrier for `Symbol` / `ArrayBuffer` / `DataView` / `Promise` that the
 * bare identifier read already produced.
 *
 * Probed on `origin/main` @ 0d119cbcfb with one standalone module reading
 * `{ X: globalThis.X }` for 21 builtin names: 17 answered a real carrier and
 * exactly these four answered null, while `Symbol` / `{ S: Symbol }.S` and
 * `{ S: Symbol }.S.iterator === Symbol.iterator` all already worked. So the
 * defect was never the carrier — it was that the realm-global SEED
 * (`appendStandaloneGlobalConstructorSeeds`) never installed these four names.
 *
 * Why it is worth a test: the test262 host object shim builds its foreign realm
 * global by MEMBER reads off `globalThis`
 * (`scripts/test262-fyi-runtime.js::createRealm`), never by bare-identifier
 * reads — deliberately, per that file's own comment. So every
 * `built-ins/Symbol/<wk>/cross-realm.js` row read `undefined.iterator` and died
 * before its assertion. The `cross-realm` shape below is the one the corpus
 * actually uses.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.run as () => number)();
}

describe("#6651 X1 — standalone realm-global constructor seeds", () => {
  it("exposes Symbol / ArrayBuffer / DataView / Promise as own realm-global properties", async () => {
    await expect(
      runStandalone(`
        declare const globalThis: any;
        export function run(): number {
          const g: any = globalThis;
          let n = 0;
          if (g.Symbol !== null && g.Symbol !== undefined) n += 1;
          if (g.ArrayBuffer !== null && g.ArrayBuffer !== undefined) n += 2;
          if (g.DataView !== null && g.DataView !== undefined) n += 4;
          if (g.Promise !== null && g.Promise !== undefined) n += 8;
          return n;
        }
      `),
    ).resolves.toBe(15);
  });

  it("gives the realm-global carrier the same identity as the bare read", async () => {
    await expect(
      runStandalone(`
        declare const globalThis: any;
        export function run(): number {
          const g: any = globalThis;
          let n = 0;
          if (g.Symbol === Symbol) n += 1;
          if (g.ArrayBuffer === ArrayBuffer) n += 2;
          if (g.DataView === DataView) n += 4;
          if (g.Promise === Promise) n += 8;
          return n;
        }
      `),
    ).resolves.toBe(15);
  });

  it("reproduces the cross-realm well-known-symbol shape the corpus uses", async () => {
    // `built-ins/Symbol/{iterator,for,species,…}/cross-realm.js`, with the
    // harness shim's realm global inlined: a plain object whose members come
    // from MEMBER reads off `globalThis`.
    await expect(
      runStandalone(`
        declare const globalThis: any;
        export function run(): number {
          const realmGlobal: any = { Symbol: globalThis.Symbol };
          const OSymbol: any = realmGlobal.Symbol;
          let n = 0;
          if (OSymbol.iterator === Symbol.iterator) n += 1;
          if (OSymbol.species === Symbol.species) n += 2;
          if (OSymbol.toPrimitive === Symbol.toPrimitive) n += 4;
          if (OSymbol.unscopables === Symbol.unscopables) n += 8;
          return n;
        }
      `),
    ).resolves.toBe(15);
  });
});
