// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7054 (from #7019) — hono's `Hono` constructor installs
// `this.use = (arg1, ...handlers) => { … handlers.forEach(…) }`, and its upstream
// `helper/dev` test builds `new Hono().use('*', mw)` at module init. A callable
// property's synthetic wrapper cannot tell a source `...rest` from a trailing
// array formal, so on `--target standalone` the positional push handed the
// second argument to the rest-vec slot (a failed cast → null) and dropped the
// others: "Array method called on null or undefined" at init. The JS host
// defers to its runtime rest bridge (#5334); host-free, the checker signature's
// own `...rest` is the evidence. Every `was ✗` failed on the parent; the
// controls pin the zero-rest and declared-field shapes.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function runStandalone(files: Record<string, string>): Promise<Record<string, () => unknown>> {
  const root = mkdtempSync(join(tmpdir(), "issue-7054-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), source);
  }
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    runtimeEvalProvider: false,
  } as Parameters<typeof compileProject>[1]);
  expect(result.errors.filter((e) => e.severity === "error").map((e) => e.message)).toEqual([]);
  expect(result.success).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = new WebAssembly.Instance(module, {});
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as unknown as Record<string, () => unknown>;
}

describe("#7054 rest-parameter closures stored in properties", () => {
  it("pack trailing arguments into the rest vec", async () => {
    const ex = await runStandalone({
      "u.js": `export class A {
  use;
  constructor() {
    this.use = (a1, ...hs) => {
      let n = 0;
      hs.forEach((h) => { n += h; });
      return n * 10 + hs.length;
    };
  }
}
export class B {
  constructor() {
    this.use = (a1, ...hs) => hs.length;
  }
}
export const app = new A();
export const atInit = app.use("*", 4, 5);
`,
      "entry.ts": `import { A, B, atInit } from "./u.js";
export function one(): number { return new A().use("*", 3); }
export function two(): number { return new A().use("*", 1, 2); }
export function none(): number { return new A().use("*"); }
export function undeclaredField(): number { return new B().use("*", 1, 2, 3); }
export function init(): number { return atInit; }
`,
    });
    expect(ex.one()).toBe(31); // was ✗ (Array method called on null)
    expect(ex.two()).toBe(32); // was ✗
    expect(ex.undeclaredField()).toBe(3); // was ✗ (null deref)
    expect(ex.init()).toBe(92); // was ✗ (module init threw)
    expect(ex.none()).toBe(0); // control: empty rest
  });
});
