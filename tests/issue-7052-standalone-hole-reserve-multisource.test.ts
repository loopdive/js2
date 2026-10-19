// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7052 (from #7019) — a multi-source standalone project whose ONLY array-hole
// trigger is a runtime-keyed store (`obj[value] = true`, axios
// `utils.toObjectSet`) failed to COMPILE: "dynamic array length fill requires
// a pre-reserved Hole global". The pre-scan arms hole-aware reads for such a
// store (the key may be "length"), and the finalize-time dynamic length fill
// (`fillVecLengthDynamicArms`) may only READ `$__hole`. Single-source mints it
// earlier, in `emitVecAccessExports`; the multi-source pipeline runs that pass
// AFTER the fill. The `was ✗` assertions failed on the parent (compile error);
// the control proves the answer is not a constant.
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
  const root = mkdtempSync(join(tmpdir(), "issue-7052-"));
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

describe("#7052 standalone multi-source hole reservation", () => {
  it("compiles and runs a project whose only hole trigger is a runtime-keyed store", async () => {
    const ex = await runStandalone({
      "u.js": `const {isArray} = Array;
const toObjectSet = (arrayOrString, delimiter) => {
  const obj = {};
  const define = (arr) => { arr.forEach((value) => { obj[value] = true; }); };
  isArray(arrayOrString) ? define(arrayOrString) : define(String(arrayOrString).split(delimiter));
  return obj;
};
export default { toObjectSet };
`,
      "entry.ts": `import utils from "./u.js";
export function present(): number { const o: any = utils.toObjectSet(["a", "b"], ","); return o.b === true ? 1 : 0; }
export function split(): number { const o: any = utils.toObjectSet("x,y", ","); return o.y === true ? 1 : 0; }
export function absent(): number { const o: any = utils.toObjectSet(["a", "b"], ","); return o.c === true ? 1 : 0; }
`,
    });
    expect(ex.present()).toBe(1); // was ✗ (compile error)
    expect(ex.split()).toBe(1); // was ✗ (compile error)
    expect(ex.absent()).toBe(0); // control
  });
});
