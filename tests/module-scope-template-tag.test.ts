// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// A template tag held in a MODULE-SCOPE binding.
//
// `compileTaggedTemplateExpression`'s closure arm resolved the tag through
// `fctx.localMap` only. A top-level `const tag = (s) => …` is a module GLOBAL,
// not a local of the calling frame, so the lookup missed, the arm reported an
// error and returned null — and a null-valued expression makes the enclosing
// `return` answer `undefined`. The tag was never invoked, and the module
// compiled clean: `` tag`abc` `` silently evaluated to `undefined` while the
// identical arrow declared INSIDE the function worked.

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

async function runProject(files: Record<string, string>): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "js2-template-tag-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  const exports = instance.exports as Record<string, () => unknown>;
  const moduleInit = exports.__module_init;
  if (typeof moduleInit === "function") moduleInit();
  return exports.test();
}

const CALL = `export function test(): any { return tag\`abc\`; }`;

describe("module-scope template tag", () => {
  it("invokes a module-scope arrow tag", async () => {
    expect(await runProject({ "entry.ts": `const tag = (s: any): any => s[0];\n${CALL}` })).toBe("abc");
  });

  it("passes the real strings array, not a placeholder", async () => {
    expect(await runProject({ "entry.ts": `const tag = (s: any): any => s.length;\n${CALL}` })).toBe(1);
  });

  it("invokes a module-scope function-expression tag", async () => {
    expect(await runProject({ "entry.ts": `const tag = function (s: any): any { return s[0]; };\n${CALL}` })).toBe(
      "abc",
    );
  });

  it("invokes a `let`-bound module-scope tag", async () => {
    expect(await runProject({ "entry.ts": `let tag = (s: any): any => s[0];\n${CALL}` })).toBe("abc");
  });

  it("invokes a tag imported from another module", async () => {
    expect(
      await runProject({
        "mod.js": `export const tag = (s) => s[0];\n`,
        "entry.ts": `import { tag } from "./mod.js";\n${CALL}`,
      }),
    ).toBe("abc");
  });

  it("keeps a function-declaration tag working", async () => {
    expect(await runProject({ "entry.ts": `function tag(s: any): any { return s[0]; }\n${CALL}` })).toBe("abc");
  });

  it("keeps a function-local tag working", async () => {
    expect(
      await runProject({
        "entry.ts": `export function test(): any { const tag = (s: any): any => s[0]; return tag\`abc\`; }`,
      }),
    ).toBe("abc");
  });
});
