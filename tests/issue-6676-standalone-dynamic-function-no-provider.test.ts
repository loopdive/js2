// #6676 — lodash-es on --target standalone retained
// `js2wasm:runtime-eval.__runtime_new_function` / `__runtime_apply_interpreted`
// from two shapes: `_root.js`'s constant `Function('return this')()` global
// probe, and `template.js`'s genuinely dynamic `Function(keys, src)`.
//  - The constant probe now folds to the realm's global object (no provider).
//  - With `runtimeEvalProvider: false` (a zero-import deployment) a dynamic
//    body throws EvalError in-module instead of importing the interpreter.
//    Without the option the provider import is unchanged (control).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";

async function compileStandalone(files: Record<string, string>, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "issue-6676-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const result = await compileProject(join(dir, "main.js"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    ...extra,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  return { module, imports: WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`) };
}

async function run(module: WebAssembly.Module) {
  const instance = await WebAssembly.instantiate(module, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as Record<string, (...args: unknown[]) => unknown>;
}

const ROOT_LIKE = `
var freeSelf = typeof self == 'object' && self && self.Object === Object && self;
var root = freeSelf || Function('return this')();
var root2 = new Function("return this;")();
export function rootIsGlobal() { return (root === globalThis ? 1 : 0) + (root2 === globalThis ? 10 : 0); }
`;

const TEMPLATE_LIKE = `
export function compileTemplate(keys, source) { return Function(keys, 'return ' + source); }
export function runTemplate(source) { return Function('a', 'return ' + source)(1); }
export function constructTemplate(source) { return new Function('a', 'return ' + source); }
`;

const MAIN = `
import { rootIsGlobal } from "./root.js";
import { compileTemplate, runTemplate, constructTemplate } from "./template.js";
export function root() { return rootIsGlobal(); }
function classify(f) { try { f(); return 0; } catch (e) { return e instanceof EvalError ? 1 : 2; } }
export function valueForm() { return classify(() => compileTemplate('a', 'a + 1')); }
export function immediateForm() { return classify(() => runTemplate('a + 1')); }
export function newForm() { return classify(() => constructTemplate('a + 1')); }
export function argsEvaluatedFirst() {
  let seen = 0;
  try { Function((seen = 1, 'a'), 'return ' + seen); } catch (e) { return seen === 1 && e instanceof EvalError ? 1 : 2; }
  return 3;
}
`;

const FILES = { "root.js": ROOT_LIKE, "template.js": TEMPLATE_LIKE, "main.js": MAIN };

describe("#6676 — standalone dynamic Function without a runtime-eval provider", () => {
  it("Function('return this')() folds to the global object without the provider", async () => {
    const { module, imports } = await compileStandalone({
      "root.js": ROOT_LIKE,
      "main.js": `import { rootIsGlobal } from "./root.js";\nexport function root() { return rootIsGlobal(); }\n`,
    });
    expect(imports).toEqual([]);
    expect((await run(module)).root()).toBe(11);
  });

  it("runtimeEvalProvider: false — zero imports, dynamic bodies throw EvalError", async () => {
    const { module, imports } = await compileStandalone(FILES, { runtimeEvalProvider: false });
    expect(imports).toEqual([]);
    const ex = await run(module);
    expect(ex.root()).toBe(11);
    expect(ex.valueForm()).toBe(1);
    expect(ex.immediateForm()).toBe(1);
    expect(ex.newForm()).toBe(1);
    expect(ex.argsEvaluatedFirst()).toBe(1);
  });

  it("default standalone still links the runtime-eval provider for dynamic bodies (control)", async () => {
    const { imports } = await compileStandalone(FILES);
    expect(imports).toContain("js2wasm:runtime-eval.__runtime_new_function");
  });

  it("runtimeEvalProvider: false is refused off the standalone target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-6676-gc-"));
    writeFileSync(join(dir, "main.js"), "export function f() { return 1; }\n");
    await expect(
      compileProject(join(dir, "main.js"), { allowJs: true, target: "gc", runtimeEvalProvider: false }),
    ).rejects.toThrow(/runtimeEvalProvider: false requires target: "standalone"/);
  });
});
