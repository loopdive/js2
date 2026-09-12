// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6420 — a class VALUE keeps its `typeof "function"` tag and [[Construct]],
// but is not callable. This exercises the shared host-free predicate through
// both the ordinary dynamic-call route and #5350's object-literal super route.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

async function compileStandalone(source: string) {
  const result = await compile(source, {
    target: "standalone",
    hostBridge: "off",
    allowJs: true,
    skipSemanticDiagnostics: true,
    fileName: "issue-6420.ts",
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  return (await WebAssembly.instantiate(module, {})).exports as Record<string, () => unknown>;
}

describe("#6420 — a local class VALUE is a typeof-function but not callable", () => {
  it("rejects direct and super calls while preserving typeof, new, and plain-object rejection", async () => {
    const exports = await compileStandalone(`
      class K { constructor(n) { this.n = n; } }
      function isFunction(v: any) { return typeof v === "function" ? 1 : 0; }
      function invoke(v: any) { return v(); }
      function construct(C: any) { return new C(41).n; }
      export function probe() {
        var n = 0;
        n += isFunction(K);
        try { invoke(K); } catch (e) { n += e instanceof TypeError ? 2 : 20; }
        var proto: any = { v: K };
        var o: any = { __proto__: proto, m() { return super.v(); } };
        try { o.m(); } catch (e) { n += e instanceof TypeError ? 4 : 40; }
        if (construct(K) === 41) n += 8;
        try { invoke({}); } catch (e) { n += e instanceof TypeError ? 16 : 160; }
        return n;
      }
    `);
    expect(exports.probe!()).toBe(31);
  }, 300_000);

  it("continues to call ordinary, bound, arrow, getter, generator, async, and builtin values", async () => {
    const exports = await compileStandalone(`
      function ordinary() { return 1; }
      function* generator() { yield 1; }
      async function asyncFunction() { return 1; }
      const getter = { get value() { return () => 4; } };
      function invoke(v: any) { v(); return 1; }
      function invoke2(v: any, a: any, b: any) { v(a, b); return 1; }
      export function ordinaryControl() { return invoke(ordinary); }
      export function boundControl() { return invoke(ordinary.bind(null)); }
      export function arrowControl() { return invoke(() => 2); }
      export function getterControl() { return invoke(getter.value); }
      export function generatorControl() { return invoke(generator); }
      export function asyncControl() { return invoke(asyncFunction); }
      export function builtinControl() { return invoke2(Math.max, 2, 5); }
    `);
    expect({
      ordinary: exports.ordinaryControl!(),
      bound: exports.boundControl!(),
      arrow: exports.arrowControl!(),
      getter: exports.getterControl!(),
      generator: exports.generatorControl!(),
      async: exports.asyncControl!(),
      builtin: exports.builtinControl!(),
    }).toEqual({ ordinary: 1, bound: 1, arrow: 1, getter: 1, generator: 1, async: 1, builtin: 1 });
  }, 300_000);
});

describe("#6420 — a linked provider publishes distinct call and construct bits", () => {
  it(
    "keeps a provider class tag/constructor and rejects its direct call while admitting a provider callable",
    { timeout: 300_000 },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "issue-6420-linked-"));
      try {
        const packageRoot = join(root, "node_modules", "provider6420");
        mkdirSync(packageRoot, { recursive: true });
        writeFileSync(
          join(packageRoot, "package.json"),
          JSON.stringify({ name: "provider6420", version: "0.0.0", main: "index.js" }),
        );
        writeFileSync(
          join(packageRoot, "index.js"),
          `
          class K { constructor(n) { this.n = n; } }
          function callable() { return 17; }
          // Keep the provider's generic closure bridge live: a foreign
          // callable is routed back through that owner-side dispatcher.
          function force(v) { return v(); }
          force(callable);
          export const NS = Object.freeze({ __proto__: null, K, callable });
        `,
        );
        const entry = join(root, "entry.js");
        writeFileSync(entry, `import { NS } from "provider6420"; export function __probe() { return typeof NS; }`);

        const standalone = { target: "standalone" as const, hostBridge: "off" as const };
        const built = await compileProject(entry, {
          allowJs: true,
          skipSemanticDiagnostics: true,
          packageCacheDir: join(root, "providers"),
          ...standalone,
        });
        expect(built.success, built.errors.map((error) => error.message).join("\n")).toBe(true);
        expect(built.linkPlan?.mode).toBe("separate");
        const artifact = (built.linkedModules ?? []).find((candidate) => candidate.packageName === "provider6420")!;
        const field = artifact.exportBoundaries!.NS!.field;
        const consumerEntry = "/__main.js";
        const result = await compileMulti(
          {
            "/__provider_stub.ts": `export declare function ${field}(): any;`,
            [consumerEntry]: `
            import { ${field} } from "/__provider_stub";
            const NS = ${field}();
            function invoke(v: any) { return v(); }
            function construct(C: any) { return new C(9).n; }
            export function typeofK() { return typeof NS.K === "function" ? 1 : 0; }
            export function callK() {
              try { invoke(NS.K); return 0; } catch (e) { return e instanceof TypeError ? 2 : 3; }
            }
            export function callCallable() { return invoke(NS.callable); }
            export function newK() { return construct(NS.K); }
          `,
          },
          consumerEntry,
          {
            allowJs: true,
            skipSemanticDiagnostics: true,
            canonicalRuntimeTypes: true,
            sharedExceptionTag: true,
            link: [artifact.namespace],
            linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
            ...standalone,
          },
        );
        (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        const { instance } = await instantiateLinkedProject(result, {});
        const exports = instance.exports as unknown as Record<string, () => unknown>;
        expect({
          typeofK: exports.typeofK!(),
          callK: exports.callK!(),
          callCallable: exports.callCallable!(),
          newK: exports.newK!(),
        }).toEqual({ typeofK: 1, callK: 2, callCallable: 17, newK: 9 });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
