// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// `typeof x` on a parameter that is also used numerically.
//
// `inferParamTypeFromBody` narrowed an implicit-`any` parameter to `f64` on the
// strength of one numeric use, treating only `??` / `??=` as observing the
// difference an f64 slot cannot carry. `typeof` observes exactly the same
// difference: an omitted argument pads the slot with `0`, so `typeof size`
// answers `"number"` where the program requires `"undefined"`. And because the
// `typeof` lowering takes an externref, the narrowed parameter did not merely
// answer wrongly — it emitted an INVALID MODULE:
//
//   Compiling function "f" failed: call[0] expected type externref,
//   found local.get of type f64
//
// The shape is webpack's `formatSize`; the arrow spelling of the same body was
// already correct, so this only aligns the declaration form with it.

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

/** The guard body: a `typeof` test followed by a numeric comparison. */
const GUARD_BODY = `{ if (typeof size !== "number") return "unknown"; if (size <= 0) return "zero"; return "n"; }`;

async function runProject(files: Record<string, string>, entry = "entry.ts"): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "js2-typeof-param-"));
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
  // The defect showed up here, not at compile time: instantiation is what
  // rejects the invalid module.
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("typeof on a numerically-used parameter", () => {
  it("keeps a same-file function declaration undefined-capable", async () => {
    expect(
      await runProject({
        "entry.ts": `function f(size) ${GUARD_BODY}\nexport function test(): any { return (f as any)(); }`,
      }),
    ).toBe("unknown");
  });

  it("keeps a cross-module ESM function declaration undefined-capable", async () => {
    expect(
      await runProject({
        "mod.js": `export function f(size) ${GUARD_BODY}\n`,
        "entry.ts": `import { f } from "./mod.js";\nexport function test(): any { return (f as any)(); }`,
      }),
    ).toBe("unknown");
  });

  it("keeps a CommonJS `module.exports` function undefined-capable", async () => {
    expect(
      await runProject({
        "mod.js": `function f(size) ${GUARD_BODY}\nmodule.exports = f;\n`,
        "entry.ts": `import f from "./mod.js";\nexport function test(): any { return (f as any)(); }`,
      }),
    ).toBe("unknown");
  });

  it("still takes the numeric arms when an argument IS supplied", async () => {
    const files = {
      "mod.js": `export function f(size) ${GUARD_BODY}\n`,
      "entry.ts": `import { f } from "./mod.js";\nexport function test(): any { return [f(5), f(0), f(-1)]; }`,
    };
    expect(await runProject(files)).toEqual(["n", "zero", "zero"]);
  });

  it("leaves a purely numeric parameter narrowed", async () => {
    // No `typeof`, so the f64 narrowing is still the right call — this asserts
    // the gate did not widen every numerically-used parameter.
    expect(
      await runProject({
        "entry.ts": `function g(n) { if (n <= 0) return "zero"; return "n"; }\nexport function test(): any { return [g(1), g(0)]; }`,
      }),
    ).toEqual(["n", "zero"]);
  });
});
