import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileProject } from "../src/index.js";

/**
 * (#6858) `typeof` of an imported function binding under `--target standalone`.
 *
 * Filed on upstream/main `b6324ee6d1`, where `typeof css === "function"` read
 * false for `import { css } from "./sheet.js"`. It no longer reproduces on
 * `ee58c1aa26` (re-measured 2026-10-16 while bisecting #6855, which turned out
 * to be an unrelated module-resolution defect). This file pins the issue's
 * acceptance rows so the fold cannot silently regress: the bare imported
 * binding, the same function through an object, a re-exported alias and a
 * default-exported function all answer "function"; the anti-vacuity control
 * is an imported non-function (`export const n = 1` → "number"), which a
 * blanket "every import is a function" fold would get wrong.
 */

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const SHEET = `
export function css(strings) { return strings.join(""); }
export const n = 1;
export default function dflt() { return 2; }
export { css as g };
`;

const MAIN = `
import dflt, { css, n, g } from "./sheet.js";
const ns = { css };
export function direct() { return typeof css === "function" ? 1 : 0; }
export function viaObj() { return typeof ns.css === "function" ? 1 : 0; }
export function aliased() { return typeof g === "function" ? 1 : 0; }
export function viaDefault() { return typeof dflt === "function" ? 1 : 0; }
export function nonFunction() { return typeof n === "number" ? 1 : typeof n === "function" ? 2 : 0; }
`;

describe("#6858 typeof an imported function binding (--target standalone)", () => {
  it("answers 'function' for imported functions and 'number' for an imported const", async () => {
    const root = mkdtempSync(join(tmpdir(), "js2-6858-"));
    roots.push(root);
    writeFileSync(join(root, "sheet.js"), SHEET);
    writeFileSync(join(root, "main.js"), MAIN);
    const result = await compileProject(join(root, "main.js"), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "standalone",
    });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.direct()).toBe(1);
    expect(ex.viaObj()).toBe(1);
    expect(ex.aliased()).toBe(1);
    expect(ex.viaDefault()).toBe(1);
    expect(ex.nonFunction()).toBe(1);
  });
});
