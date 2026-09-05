// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5324 — a LIFTED frame (arrow / function expression) must pop the function
// names it hoists, exactly as `compileFunctionBody` already does for a
// FunctionDeclaration body (#4456).
//
// `nestedFuncDeclNeedsShadow` deliberately shadows an outer same-named
// registration when a frame hoists its own `function f`, so the nested one gets
// its own slot instead of aliasing the outer's. Only the FunctionDeclaration
// body-compile paths in `function-body.ts` opened a matching
// `beginNestedFunctionNameScope`, so a shadow taken inside a lifted ARROW frame
// was NEVER popped: `ctx.funcMap` / `ctx.funcMapOwnerDecl` stayed bound to that
// frame's private function for the rest of the compile.
//
// Two distinct symptoms, both covered below:
//
//  1. WRONG CALL TARGET (single or multi source): after the arrow frame closes,
//     an outer `f(...)` call resolves to the nested function.
//
//  2. COMPILE FAILURE (multi source only): the multi-source driver compiles the
//     accumulated `__module_init` during the FIRST source's pass — i.e. BEFORE
//     the entry source's own top-level bodies. The hijack is therefore still
//     live when `compileDeclarations` resolves the slot for the top-level
//     `function f`, whose body is then emitted into the nested function. When
//     the two declarations have DIFFERENT arities the emitted `local.get <n>`
//     exceeds the nested signature and codegen reports
//     `stack-balance invariant (entry)`. Equal arities produced no error and a
//     silently wrong body, which is why the arity-mismatched shape is the one
//     that surfaced (redux `applyMiddleware.spec.ts`, 0/5).
//
// Fixtures are untyped `.js` deliberately. Annotating the parameters routes the
// call sites through a different, statically-typed arm that never consults the
// name-keyed `funcMap`, and the test then passes with and without the fix.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject, type CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function compileFixture(files: Record<string, string>, entry: string): Promise<CompileResult> {
  const root = mkdtempSync(join(tmpdir(), "js2-5324-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, source);
  }
  return compileProject(join(root, entry), {
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

const SIBLING = "export const k = 1;\n";

describe("#5324 lifted frames pop the function names they hoist", () => {
  it("compiles a multi-source graph where a lifted arrow shadows a top-level function of another arity", async () => {
    // The pre-fix failure is a whole-module CODEGEN error, so assert on the
    // compile result rather than on behaviour.
    const result = await compileFixture(
      {
        "dep.js": SIBLING,
        "entry.js": `
import { k } from './dep.js';
let heldName = "";
let heldBody = null;
function shim(name, body) { heldName = name; heldBody = body; }
shim("t", () => {
  function shim(x) { return x * 2; }
  return shim(21);
});
export function name() { return String(heldName); }
export function value() { return Number(heldBody()); }
export function sibling() { return k; }
`,
      },
      "entry.js",
    );
    expect(result.success, result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")).toBe(true);

    const exports = await instantiate(result);
    // Anti-vacuity: the outer 2-param declaration really did keep its own body
    // and arity — it received BOTH arguments and stored them.
    expect((exports.name as () => string)()).toBe("t");
    expect((exports.value as () => number)()).toBe(42);
    expect((exports.sibling as () => number)()).toBe(1);
  });

  it("restores the outer binding after a lifted arrow frame closes", async () => {
    const result = await compileFixture(
      {
        "entry.js": `
let seen = "";
function pick(a, b) { seen = "outer:" + String(a) + "," + String(b); return 0; }
const frame = () => {
  function pick(x) { seen = "inner:" + String(x); return 1; }
  return pick(9);
};
export function insideFrame() { return frame(); }
export function seenAfterFrame() { return seen; }
export function outsideFrame() { return pick(1, 2); }
export function seenAfterOuter() { return seen; }
`,
      },
      "entry.js",
    );
    expect(result.success, result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")).toBe(true);

    const exports = await instantiate(result);
    // Inside the arrow the INNER declaration wins …
    expect((exports.insideFrame as () => number)()).toBe(1);
    expect((exports.seenAfterFrame as () => string)()).toBe("inner:9");
    // … and outside it the top-level one is back. Pre-fix this returned 1 and
    // wrote "inner:1": the module-level name stayed bound to the lifted frame's
    // private function.
    expect((exports.outsideFrame as () => number)()).toBe(0);
    expect((exports.seenAfterOuter as () => string)()).toBe("outer:1,2");
  });

  it("keeps two sibling frames' same-named declarations separate", async () => {
    const result = await compileFixture(
      {
        "entry.js": `
let log = [];
function tag(a) { log.push("outer/" + String(a)); return "O"; }
const f1 = () => { function tag(a, b) { log.push("i1/" + String(a) + String(b)); return "1"; } return tag(1, 2); };
const f2 = () => { function tag() { log.push("i2"); return "2"; } return tag(); };
export function run() { return String(f1()) + String(f2()) + String(tag(5)); }
export function trace() { return log.join("|"); }
`,
      },
      "entry.js",
    );
    expect(result.success, result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")).toBe(true);

    const exports = await instantiate(result);
    expect((exports.run as () => string)()).toBe("12O");
    expect((exports.trace as () => string)()).toBe("i1/12|i2|outer/5");
  });
});
