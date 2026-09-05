// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5330 — `import * as path from 'path'` (BARE builtin specifier, namespace
// form) bound an empty object: `path.join` was `undefined`, `path.sep` was
// `undefined`, `String(path)` was `[object Object]`. The `node:`-prefixed
// spelling of the same import worked.
//
// Root cause is NOT the specifier normalisation it looks like. It is
// `tryEmitCompiledModuleNamespaceObject` (src/codegen/module-namespace-value.ts),
// the optimizer that materializes a namespace object out of a module's compiled
// exports. It asks the CHECKER for those exports, and with no `@types/node` in
// the program a bare builtin specifier resolves to nothing at all —
// `getExportsOfModule` answers `[]`. An empty array is truthy, so the optimizer
// happily built `__new_plain_object()` with no properties and published it as
// the namespace, shadowing the `__node_path` host module thunk the module was
// still importing.
//
// `node:path` escaped only by ACCIDENT: the injected ambient
// `declare module "node:path"` gives it one export whose sole declaration lives
// in a `.d.ts`, which trips the optimizer's "mutable value, decline the whole
// object" arm and falls through to the host binding. The right answer for the
// whole family is to decline up front: a namespace import OF a Node builtin is
// served by the host module object, never by a synthesized one.
//
// Two things this deliberately does NOT change, both asserted below:
//  - a user module that RE-EXPORTS builtin members keeps the `host-member`
//    lowering (its namespace belongs to the user module, not to `node:path`);
//  - named imports from the path shim (`import { join } from 'path'`) still
//    answer `null`. That is a separate defect in the #1791 shim's named
//    bindings, present for the `node:` spelling too, and out of scope here.
//
// Fixtures are untyped `.js` in a two-file project: that is the shape real
// packages present (jest's `jest-haste-map` `fast_path.test.js` and
// `get_mock_name.test.js` are exactly this), and it keeps the test on the
// multi-source lane where the defect lives.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject, type CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function compileFixture(files: Record<string, string>, entry: string): Promise<CompileResult> {
  const root = mkdtempSync(joinPath(tmpdir(), "js2-5330-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = joinPath(root, name);
    mkdirSync(joinPath(target, ".."), { recursive: true });
    writeFileSync(target, source);
  }
  return compileProject(joinPath(root, entry), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
}

async function instantiate(result: CompileResult): Promise<WebAssembly.Exports> {
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

const DEP = `
export function identity(v) { return v; }
`;

function entryFor(specifier: string): string {
  return `
import * as path from '${specifier}';
import { identity } from './dep.js';

export function joined() { return identity(path.join('a', 'b')); }
export function separator() { return String(path.sep); }
export function joinIsFunction() { return typeof path.join === 'function' ? 1 : 0; }
export function relativeOf() { return path.relative('/a/b', '/a/b/c'); }
export function resolveIsString() { return typeof path.resolve('/a', 'b') === 'string' ? 1 : 0; }
`;
}

describe("#5330 namespace import of a bare Node builtin specifier", () => {
  for (const specifier of ["path", "node:path"]) {
    it(`binds the real host module for '${specifier}'`, async () => {
      const result = await compileFixture({ "dep.js": DEP, "main.js": entryFor(specifier) }, "main.js");
      expect(result.success).toBe(true);
      const exports = await instantiate(result);

      // Before the fix the bare row answered: joinIsFunction 0, separator
      // "undefined", and `joined()`/`relativeOf()` threw
      // "join is not a function" / "relative is not a function".
      expect((exports.joinIsFunction as () => number)()).toBe(1);
      expect((exports.joined as () => string)()).toBe("a/b");
      expect((exports.separator as () => string)()).toBe("/");
      expect((exports.relativeOf as () => string)()).toBe("c");
      expect((exports.resolveIsString as () => number)()).toBe(1);
    });
  }

  it("still synthesizes a namespace for a user module that re-exports builtin members", async () => {
    // The decline is scoped to a namespace import OF a builtin. A user module's
    // own namespace keeps the compiled-object lowering, with builtin re-exports
    // served through `__extern_get(__node_<mod>(), prop)`.
    const files = {
      "dep.js": DEP,
      "reexport.js": `
export { join } from 'node:path';
export function twice(v) { return v * 2; }
`,
      "main.js": `
import * as helpers from './reexport.js';
import { identity } from './dep.js';
export function joined() { return identity(helpers.join('a', 'b')); }
export function doubled() { return helpers.twice(21); }
`,
    };
    const result = await compileFixture(files, "main.js");
    expect(result.success).toBe(true);
    const exports = await instantiate(result);
    expect((exports.joined as () => string)()).toBe("a/b");
    expect((exports.doubled as () => number)()).toBe(42);
  });
});
