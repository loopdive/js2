import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";
import { buildRuntimeEvalRefusalProviderSource } from "../scripts/runtime-eval-provider.mjs";

describe("module bindings precede runtime-eval global lexical sidecars", () => {
  it.each([false, true])("retains ambient lookup but excludes imported bindings: %s", async (ambient) => {
    const result = await compileMulti(
      {
        "/scope/helper.ts": "export let original:number = 42; export function change():void { original = 43; }",
        "/scope/entry.ts": `${ambient ? "declare const selected:number;" : 'import {original as selected} from "./helper.ts";'}
        import {change} from "./helper.ts";
        export function readSelected():number { return selected; }
        export function update():void { change(); }
        export function seed():void {
          (globalThis as any).__js2wasm_runtime_eval_global_dynamic_lexicals__ = {selected: 900, original: 901};
        }
        ${buildRuntimeEvalRefusalProviderSource()}`,
      },
      "/scope/entry.ts",
      {
        target: "standalone",
        deferTopLevelInit: true,
        skipSemanticDiagnostics: true,
        emitWat: true,
        emitWatOnlyFunctions: ["readSelected"],
      },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const actual = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--experimental-wasm-exnref",
          "-e",
          `
      const module = new WebAssembly.Module(require("node:fs").readFileSync(0));
      const e = new WebAssembly.Instance(module, {}).exports;
      e.__module_init(); e.seed(); const before = e.readSelected(); e.update();
      process.stdout.write(JSON.stringify({before, after:e.readSelected(), imports:WebAssembly.Module.imports(module)}));
    `,
        ],
        { input: result.binary, encoding: "utf8" },
      ),
    );
    expect(actual).toEqual({ before: ambient ? 900 : 42, after: ambient ? 900 : 43, imports: [] });
    const body = result.wat.split("(func $readSelected ")[1]?.split("\n  (func ")[0];
    expect(body).toBeDefined();
    expect(body?.includes("__runtime_eval_dynamic_global_obj_")).toBe(ambient);
  });
  it.each(["const", "let", "var"])("preserves a module %s binding", async (kind) => {
    const result = await compileMulti(
      {
        "/scope/helper.ts": `${kind} privateValue:number = 42;
        export function readPrivate():number { return privateValue; }
        export function writePrivate():void { ${kind === "const" ? "" : "privateValue = 43;"} }`,
        "/scope/entry.ts": `import {readPrivate, writePrivate} from "./helper.ts";
        export function read():number { return readPrivate(); }
        export function update():void { writePrivate(); }
        export function seed():void {
          (globalThis as any).__js2wasm_runtime_eval_global_dynamic_lexicals__ = {privateValue: 900};
        }
        ${buildRuntimeEvalRefusalProviderSource()}`,
      },
      "/scope/entry.ts",
      {
        target: "standalone",
        deferTopLevelInit: true,
        skipSemanticDiagnostics: true,
        emitWat: true,
        emitWatOnlyFunctions: ["readPrivate"],
      },
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const actual = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--experimental-wasm-exnref",
          "-e",
          `
      const module = new WebAssembly.Module(require("node:fs").readFileSync(0));
      const e = new WebAssembly.Instance(module, {}).exports;
      e.__module_init();
      const before = e.read(); e.seed(); const after = e.read(); e.update();
      process.stdout.write(JSON.stringify({before, after, updated:e.read(), imports:WebAssembly.Module.imports(module)}));
    `,
        ],
        { input: result.binary, encoding: "utf8" },
      ),
    );
    expect(actual).toEqual({ before: 42, after: 42, updated: kind === "const" ? 42 : 43, imports: [] });
    // Inspect only the selected function, not strings/globals elsewhere in WAT.
    const body = result.wat.split("(func $readPrivate ")[1]?.split("\n  (func ")[0];
    expect(body).toBeDefined();
    expect(body).not.toContain("__runtime_eval_dynamic_global_obj_");
  });
});
