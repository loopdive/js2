// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// `import * as ns from "./mod.js"` on the multi-file compile paths.
//
// Before `rewriteMultiNamespaceImports`, the namespace binding did not exist in
// `generateMultiModule` at all: `ns` reached codegen unbound, every `ns.member`
// lowered to a dynamic extern call on a `ref.null extern` receiver, and the
// compile SUCCEEDED — the failure only showed up at run time as "Cannot read
// properties of null". Every assertion below is an end-to-end run, because a
// compile-success assertion is exactly what failed to catch this.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const roots: string[] = [];

afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function runProject(files: Record<string, string>, entry = "entry.ts"): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "js2-ns-import-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  const result = await compileProject(join(root, entry), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, () => unknown>).test();
}

const MOD_JS = `export function f(s) { return s.length; }\nexport const N = 7;\n`;
const MOD_TS = `export function f(s: string): number { return s.length; }\nexport const N = 7;\n`;

describe("multi-file namespace imports", () => {
  it("calls a namespace-imported function from a JS module", async () => {
    expect(
      await runProject({
        "mod.js": MOD_JS,
        "entry.ts": `import * as m from "./mod.js";\nexport function test(): number { return m.f("abc"); }`,
      }),
    ).toBe(3);
  });

  it("calls a namespace-imported function from a TS module", async () => {
    expect(
      await runProject({
        "mod.ts": MOD_TS,
        "entry.ts": `import * as m from "./mod.js";\nexport function test(): number { return m.f("abcd"); }`,
      }),
    ).toBe(4);
  });

  it("reads a namespace-imported const", async () => {
    expect(
      await runProject({
        "mod.ts": MOD_TS,
        "entry.ts": `import * as m from "./mod.js";\nexport function test(): number { return m.N; }`,
      }),
    ).toBe(7);
  });

  it("follows `export * from` when resolving the namespace's members", async () => {
    expect(
      await runProject({
        "leaf.js": MOD_JS,
        "mod.js": `export * from "./leaf.js";\n`,
        "entry.ts": `import * as m from "./mod.js";\nexport function test(): number { return m.f("abcde"); }`,
      }),
    ).toBe(5);
  });

  it("keeps working when the member access spans lines", async () => {
    expect(
      await runProject({
        "mod.js": MOD_JS,
        "entry.ts": `import * as m from "./mod.js";\nexport function test(): number { return m\n  .f("ab"); }`,
      }),
    ).toBe(2);
  });

  it("does not disturb a local binding that shadows the namespace name", async () => {
    // `m` is rebound inside `test`, so `m.f` there is the LOCAL object. A
    // rewrite that ignored shadowing would read the module's export instead.
    expect(
      await runProject({
        "mod.js": MOD_JS,
        "entry.ts": `import * as m from "./mod.js";
export function test(): number {
  const m = { f: (s: string): number => s.length * 10 };
  return m.f("abc");
}`,
      }),
    ).toBe(30);
  });

  it("leaves the source byte-identical in length so offsets do not move", async () => {
    const { rewriteMultiNamespaceImports } = await import("../src/multi-namespace-import.js");
    const entry = `import * as m from "./mod.js";\nexport function test(): number { return m.f("abc"); }`;
    const rewritten = rewriteMultiNamespaceImports({
      "./entry.ts": entry,
      "./mod.js": MOD_JS,
    })["./entry.ts"];
    const original = entry.split("\n");
    const produced = rewritten.split("\n");
    expect(produced[0]).toHaveLength(original[0].length);
    expect(produced[1]).toHaveLength(original[1].length);
    expect(produced[1]).toContain("m$f(");
  });

  it("leaves an out-of-graph specifier alone", async () => {
    // node: builtins are host module objects (#4422), not graph modules. The
    // rewrite must not invent named imports for them.
    const { rewriteMultiNamespaceImports } = await import("../src/multi-namespace-import.js");
    const entry = `import * as os from "node:os";\nexport function test(): number { return os.cpus().length; }`;
    expect(rewriteMultiNamespaceImports({ "./entry.ts": entry })["./entry.ts"]).toBe(entry);
  });

  it("leaves the namespace alone when it is used as a value", async () => {
    const { rewriteMultiNamespaceImports } = await import("../src/multi-namespace-import.js");
    const entry = `import * as m from "./mod.js";\nexport function test(): unknown { return Object.keys(m); }`;
    expect(rewriteMultiNamespaceImports({ "./entry.ts": entry, "./mod.js": MOD_JS })["./entry.ts"]).toBe(entry);
  });

  it("leaves the namespace alone when a member is not an export of the target", async () => {
    const { rewriteMultiNamespaceImports } = await import("../src/multi-namespace-import.js");
    const entry = `import * as m from "./mod.js";\nexport function test(): unknown { return m.missing; }`;
    expect(rewriteMultiNamespaceImports({ "./entry.ts": entry, "./mod.js": MOD_JS })["./entry.ts"]).toBe(entry);
  });
});
