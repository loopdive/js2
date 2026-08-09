// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3494 — compileMulti has no deferred module records or namespace objects.
// Until those exist, standalone import() must fail explicitly instead of
// emitting an unusable env.__dynamic_import or manufacturing a fulfilled
// placeholder that would false-pass the FYI reproducer.
import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

function importNames(result: Awaited<ReturnType<typeof compileMulti>>): string[] {
  return result.imports.map((entry) => `${entry.module}.${entry.name}`);
}

describe("#3494 standalone literal internal dynamic import", () => {
  it("reports the official module-graphs-does-not-hang blocker without leaking a host loader", async () => {
    const result = await compileMulti(
      {
        "./module-graphs-does-not-hang.js": `
          import "./module-graphs-parent-tla_FIXTURE.js";
          function $DONE() {}
          await import("./module-graphs-grandparent-tla_FIXTURE.js");
          $DONE();
        `,
        "./module-graphs-grandparent-tla_FIXTURE.js": `
          import "./module-graphs-parent-tla_FIXTURE.js";
        `,
        "./module-graphs-parent-tla_FIXTURE.js": `
          import "./tla_FIXTURE.js";
        `,
        "./tla_FIXTURE.js": `await 0;`,
      },
      "./module-graphs-does-not-hang.js",
      { allowJs: true, target: "standalone" },
    );

    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.message.includes("Standalone dynamic import is unsupported"))).toBe(
      true,
    );
    expect(importNames(result)).not.toContain("env.__dynamic_import");
  });

  it.todo("evaluates an internal graph once and returns a stable module namespace through a native Promise");

  it.each([
    {
      name: "non-literal specifier",
      files: {
        "entry.ts": `const path = "./empty.ts"; export function run(): void { void import(path); }`,
        "empty.ts": `export {};`,
      },
    },
    {
      name: "missing target",
      files: { "entry.ts": `export function run(): void { void import("./missing.ts"); }` },
    },
    {
      name: "target with a runtime body",
      files: {
        "entry.ts": `export function run(): void { void import("./body.ts"); }`,
        "body.ts": `let evaluated = 1; void evaluated;`,
      },
    },
    {
      name: "import attributes",
      files: {
        "entry.ts": `export function run(): void { void import("./empty.ts", { with: { type: "json" } }); }`,
        "empty.ts": `export {};`,
      },
    },
  ])("rejects $name explicitly", async ({ files }) => {
    const result = await compileMulti(files, "entry.ts", {
      target: "standalone",
      skipSemanticDiagnostics: true,
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.message.includes("Standalone dynamic import is unsupported"))).toBe(
      true,
    );
    expect(importNames(result)).not.toContain("env.__dynamic_import");
  });

  it("rejects standalone single-source import() rather than producing an unusable host import", async () => {
    const result = await compile(`export function run(): void { void import("./target.js"); }`, {
      target: "standalone",
    });

    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.message.includes("Standalone dynamic import is unsupported"))).toBe(
      true,
    );
  });

  it("preserves the existing host dynamic-import lowering", async () => {
    const result = await compileMulti(
      {
        "entry.ts": `export function run(): void { void import("./target.ts"); }`,
        "target.ts": `export {};`,
      },
      "entry.ts",
    );

    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(importNames(result)).toContain("env.__dynamic_import");
  });
});
