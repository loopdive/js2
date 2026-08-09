// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3509 — standalone may compile an ordinary deferred function containing
// import() without a host loader. Reaching the import still throws; executable
// dynamic module evaluation remains #3494.
import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

type CompileResult = Awaited<ReturnType<typeof compile>>;

function importNames(result: CompileResult): string[] {
  return result.imports.map((entry) => `${entry.module}.${entry.name}`);
}

function expectNoDynamicImportHost(result: CompileResult): void {
  expect(importNames(result)).not.toContain("env.__dynamic_import");
}

const OFFICIAL_SUFFIX_SHAPES = [
  {
    suffix: "import-attributes-trailing-comma-first",
    expression: `import("./empty_FIXTURE.js",)`,
  },
  {
    suffix: "import-attributes-trailing-comma-second",
    expression: `import("./empty_FIXTURE.js", {},)`,
  },
  {
    suffix: "nested-imports",
    expression: `import(import(import("./empty_FIXTURE.js")))`,
  },
  {
    suffix: "script-code-valid",
    expression: `import("./empty_FIXTURE.js")`,
  },
] as const;

describe("#3509 standalone deferred dynamic import", () => {
  it.each(
    OFFICIAL_SUFFIX_SHAPES.flatMap(({ suffix, expression }) => [
      {
        path: `nested-arrow-${suffix}.js`,
        declaration: `let f = () => { ${expression}; };`,
      },
      {
        path: `nested-arrow-assignment-expression-${suffix}.js`,
        declaration: `let f = () => ${expression};`,
      },
    ]),
  )("compiles the uncalled official shape $path and reaches test", async ({ path, declaration }) => {
    const result = await compile(
      `${declaration}
       export function test() { return 1; }`,
      {
        allowJs: true,
        fileName: path,
        skipSemanticDiagnostics: true,
        target: "standalone",
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expectNoDynamicImportHost(result);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(1);
  });

  it.each([
    { kind: "ordinary arrow", callee: `() => { import("./empty_FIXTURE.js"); return 1; }` },
    { kind: "ordinary function expression", callee: `function () { import("./empty_FIXTURE.js"); return 1; }` },
  ])("throws deterministically when an equivalent $kind is invoked", async ({ callee }) => {
    const result = await compile(
      `export function test() {
         return (${callee})();
       }`,
      { experimentalIR: false, skipSemanticDiagnostics: true, target: "standalone" },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expectNoDynamicImportHost(result);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const noResult = Symbol("dynamic import did not return");
    let returned: unknown = noResult;
    expect(() => {
      returned = (instance.exports.test as () => unknown)();
    }).toThrow();
    expect(returned, "unsupported import returned a false Promise/namespace value").toBe(noResult);
  });

  it("keeps an executed async IIFE on the explicit unsupported path", async () => {
    const result = await compile(
      `export function test() {
         (async () => { await import("./empty_FIXTURE.js"); })();
         return 1;
       }`,
      { skipSemanticDiagnostics: true, target: "standalone" },
    );

    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.message.includes("Standalone dynamic import is unsupported"))).toBe(
      true,
    );
    expectNoDynamicImportHost(result);
  });

  it("keeps an executed with-body import on the explicit unsupported path", async () => {
    const result = await compile(
      `export function test() {
         with ({}) { import("./empty_FIXTURE.js"); }
         return 1;
       }`,
      {
        allowJs: true,
        fileName: "nested-with-script-code-valid.js",
        inferModuleStrictArguments: false,
        skipSemanticDiagnostics: true,
        target: "standalone",
      },
    );

    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.message.includes("Standalone dynamic import is unsupported"))).toBe(
      true,
    );
    expectNoDynamicImportHost(result);
  });

  it("keeps the executable top-level-await module graph on #3494", async () => {
    const result = await compileMulti(
      {
        "./module-graphs-does-not-hang.js": `
          import "./module-graphs-parent-tla_FIXTURE.js";
          function $DONE() {}
          await import("./module-graphs-grandparent-tla_FIXTURE.js");
          $DONE();
        `,
        "./module-graphs-grandparent-tla_FIXTURE.js": `import "./module-graphs-parent-tla_FIXTURE.js";`,
        "./module-graphs-parent-tla_FIXTURE.js": `import "./tla_FIXTURE.js";`,
        "./tla_FIXTURE.js": `await 0;`,
      },
      "./module-graphs-does-not-hang.js",
      { allowJs: true, target: "standalone" },
    );

    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.message.includes("Standalone dynamic import is unsupported"))).toBe(
      true,
    );
    expectNoDynamicImportHost(result);
  });

  it("preserves host dynamic-import lowering", async () => {
    const result = await compile(`export function test(): void { void import("./target.js"); }`, {
      skipSemanticDiagnostics: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(importNames(result)).toContain("env.__dynamic_import");
  });
});
