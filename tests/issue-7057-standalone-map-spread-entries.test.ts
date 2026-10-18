// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7057 (from #7019) — `[...map]` on `--target standalone` chose the result
// vec's element carrier from the Map's FIRST TYPE ARGUMENT (the key type), but
// a Map iterates `[key, value]` entries. With string keys the literal became a
// native-string vec and every materialized entry hit `ref.cast $AnyString`:
// "illegal cast" in stylelint's `reference/keywords.mjs` module init
// (`new Map([...byProperty].map(([p, m]) => [p, new Set(m.values())]))`).
// Every `was ✗` trapped on the parent; the controls (Set and array spreads,
// whose first type argument IS the element) must keep their answers.
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
  const root = mkdtempSync(join(tmpdir(), "issue-7057-"));
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

describe("#7057 spreading a Map yields entries", () => {
  it("uses an entry carrier, not the key type", async () => {
    const ex = await runStandalone({
      "m.mjs": `export const byProp = new Map([
  ['caption-side', new Map([['top', 'block-start'], ['bottom', 'block-end']])],
  ['clear', new Map([['left', 'inline-start']])],
]);
export const flow = new Map([...byProp].map(([property, mapping]) => [property, mapping.size]));
export function count() { return [...byProp].length; }
export function firstKey() { return [...byProp][0][0]; }
export function innerSize() { const e = [...byProp][1]; return e[1].size; }
export function setSpread() { return [...new Set(['a', 'b', 'a'])].length; }
export function arraySpread() { return [...['x', 'y']].length; }
`,
      "entry.ts": `import { flow, count, firstKey, innerSize, setSpread, arraySpread } from "./m.mjs";
export function initFlow(): number { return flow.get("caption-side"); }
export function entries(): number { return count(); }
export function key(): number { return firstKey() === "caption-side" ? 1 : 0; }
export function inner(): number { return innerSize(); }
export function set(): number { return setSpread(); }
export function arr(): number { return arraySpread(); }
`,
    });
    expect(ex.initFlow()).toBe(2); // was ✗ (module init: illegal cast)
    expect(ex.entries()).toBe(2); // was ✗
    expect(ex.key()).toBe(1); // was ✗
    expect(ex.inner()).toBe(1); // was ✗
    expect(ex.set()).toBe(2); // control
    expect(ex.arr()).toBe(2); // control
  });
});
