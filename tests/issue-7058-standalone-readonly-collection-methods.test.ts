// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7058 (from #7019) — a value typed `ReadonlyMap` / `ReadonlySet` (stylelint
// annotates every `new Map(…)` in `reference/keywords.mjs` with JSDoc
// `@type {ReadonlyMap<…>}`) is the same native `$Map` / `$Set` on
// `--target standalone`, but those interface names are not extern classes, so
// the native collection dispatch was skipped and `m.values()` fell to the
// generic `__call_m_values_0` ladder: "called value is not a function" during
// module init. Every `was ✗` threw on the parent; the controls (`size`, `has`,
// and a `Map`-typed receiver) already answered and must keep answering.
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
  const root = mkdtempSync(join(tmpdir(), "issue-7058-"));
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

describe("#7058 ReadonlyMap / ReadonlySet receivers", () => {
  it("dispatch to the native collection methods", async () => {
    const ex = await runStandalone({
      "m.mjs": `/** @type {ReadonlyMap<string, string>} */
const m = new Map([['a', 'b'], ['c', 'd']]);
/** @type {ReadonlySet<string>} */
const s = new Set(['x', 'y', 'z']);
/** @type {Map<string, string>} */
const plain = new Map([['a', 'b']]);
/** @type {ReadonlySet<string>} */
export const fromValues = new Set(m.values());
export function values() { return [...m.values()].length; }
export function keys() { return [...m.keys()].join(''); }
export function setValues() { return [...s.values()].length; }
export function size() { return m.size; }
export function has() { return m.has('c') && s.has('y') ? 1 : 0; }
export function plainValues() { return [...plain.values()].length; }
`,
      "entry.ts": `import { fromValues, values, keys, setValues, size, has, plainValues } from "./m.mjs";
export function init(): number { return fromValues.has("d") ? 1 : 0; }
export function v(): number { return values(); }
export function k(): number { return keys() === "ac" ? 1 : 0; }
export function sv(): number { return setValues(); }
export function sz(): number { return size(); }
export function h(): number { return has(); }
export function pv(): number { return plainValues(); }
`,
    });
    expect(ex.init()).toBe(1); // was ✗ (module init threw)
    expect(ex.v()).toBe(2); // was ✗
    expect(ex.k()).toBe(1); // was ✗
    expect(ex.sv()).toBe(3); // was ✗
    expect(ex.sz()).toBe(2); // control
    expect(ex.h()).toBe(1); // control
    expect(ex.pv()).toBe(1); // control
  });
});
