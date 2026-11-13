// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7019 — axios module init trapped on `--target standalone` with
// "dereferencing a null pointer" at `utils.toObjectSet([...])`. An omitted
// argument whose CALLER-side slot is a non-null ref — JSDoc `@param {string}
// delimiter` lowers to `(ref $AnyString)`, and JavaScript callers may omit any
// argument — was padded with `ref.null; ref.as_non_null`: an unconditional trap,
// although every `ref` slot is widened to nullable before emission
// (`widenNonDefaultableTypes`) and the callee tests absence with `ref.is_null`.
// Each `was ✗` call trapped on the parent; the `control` calls pass an explicit
// argument and must keep answering 0.
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
  const root = mkdtempSync(join(tmpdir(), "issue-7019-"));
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

describe("#7019 omitted non-null-ref argument", () => {
  it("reaches the callee as absent instead of trapping", async () => {
    const ex = await runStandalone({
      "u.js": `/**
 * @param {string} d
 */
const f = (a, d) => (d === undefined ? 1 : 0);
/**
 * @param {string} d
 */
export function g(a, d) { return d === undefined ? 1 : 0; }
/**
 * @param {string} d
 */
const h = function (a, d) { return d === undefined ? 1 : 0; };
export default { f, g, h };
`,
      "entry.ts": `import u, { g } from "./u.js";
export function viaArrowProp(): number { return u.f(1); }
export function viaDeclProp(): number { return u.g(1); }
export function viaFnExprProp(): number { return u.h(1); }
export function viaDirect(): number { return g(1); }
export function passedArrowProp(): number { return u.f(1, "x"); }
export function passedDirect(): number { return g(1, "x"); }
`,
    });
    expect(ex.viaArrowProp()).toBe(1); // was ✗ (null deref)
    expect(ex.viaDeclProp()).toBe(1); // was ✗
    expect(ex.viaFnExprProp()).toBe(1); // was ✗
    expect(ex.viaDirect()).toBe(1); // was ✗
    expect(ex.passedArrowProp()).toBe(0); // control
    expect(ex.passedDirect()).toBe(0); // control
  });
});
