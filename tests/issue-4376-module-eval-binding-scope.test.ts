import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { ts } from "../src/ts-api.js";
import type { TypeOracle } from "../src/checker/oracle.js";
import {
  buildIrRuntimeEvalBoundaryPlan,
  runtimeEvalMayRebindModuleScope,
} from "../src/ir/runtime-eval-boundary-plan.js";
import { compileMulti } from "../src/index.js";
import { buildRuntimeEvalRefusalProviderSource } from "../scripts/runtime-eval-provider.mjs";

const oracle = { valueDeclarationOf: () => undefined } as unknown as TypeOracle;
const source = (path: string, text: string) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
describe("module-private function eval visibility", () => {
  it("does not expose one module to another module's direct eval", () => {
    const files = [
      source("/a/same.ts", "export {}; function hidden() {}"),
      source("/b/same.ts", "export {}; eval(code);"),
    ];
    const plan = buildIrRuntimeEvalBoundaryPlan(files, oracle);
    expect(plan.sites.some((s) => s.kind === "direct-eval")).toBe(true);
    expect(runtimeEvalMayRebindModuleScope(plan, files[0]!, 0)).toBe(false);
    expect(runtimeEvalMayRebindModuleScope(plan, files[1]!, 1)).toBe(true);
    expect(runtimeEvalMayRebindModuleScope(plan, files[0]!, -1)).toBe(true);
  });
  it.each(["(0, eval)(code)", "new Function(code)", "const alias = eval; alias(code)"])(
    "excludes indirect code: %s",
    (expression) => {
      const file = source("/module.ts", "export {}; " + expression);
      const plan = buildIrRuntimeEvalBoundaryPlan([file], oracle);
      expect(plan.unknownDynamicSource).toBe(true);
      expect(runtimeEvalMayRebindModuleScope(plan, file, 0)).toBe(false);
    },
  );
  it("retains direct eval and script scope conservatively", () => {
    for (const text of ["export {}; eval(code);", "function hidden() {}; (0, eval)(code);"]) {
      const file = source("/scope.ts", text);
      expect(runtimeEvalMayRebindModuleScope(buildIrRuntimeEvalBoundaryPlan([file], oracle), file, 0)).toBe(true);
    }
  });
  it.each([false, true])("keeps actual reassignment semantics: %s", async (mutable) => {
    const helper =
      "const offsets:number[] = [1]; function hidden(x:number):number { return x + offsets[0]; } export function call(x:number):number { return hidden(x); } export function alias(x:number):number { const f = hidden; return f(x); }" +
      (mutable ? "export function replace():void { hidden = (x:number):number => x + 7; }" : "");
    const entry =
      "import {call, alias" +
      (mutable ? ", replace" : "") +
      '} from "./helper.ts"; export function run(x:number):number{return call(x)+alias(x);}' +
      (mutable ? "export function update():void {replace();}" : "") +
      "export function dynamicEntry(code:any):any{return (0,eval)(code);}" +
      buildRuntimeEvalRefusalProviderSource();
    const result = await compileMulti({ "/probe/helper.ts": helper, "/probe/entry.ts": entry }, "/probe/entry.ts", {
      target: "standalone",
      deferTopLevelInit: true,
      skipSemanticDiagnostics: true,
      emitWat: true,
      emitWatOnlyFunctions: ["run"],
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.wat.includes("(global $__mod_hidden ")).toBe(mutable);
    // The repository's fork configuration overrides parent Node flags.
    // Give the execution child its required Wasm exception feature explicitly.
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--experimental-wasm-exnref",
          "-e",
          `
      const module = new WebAssembly.Module(require("node:fs").readFileSync(0));
      const e = new WebAssembly.Instance(module, {}).exports;
      e.__module_init();
      const before = e.run(41);
      let after = null;
      if (e.update) { e.update(); after = e.run(41); }
      process.stdout.write(JSON.stringify({imports: WebAssembly.Module.imports(module), before, after}));
    `,
        ],
        { input: result.binary, encoding: "utf8" },
      ),
    );
    expect(output).toEqual({ imports: [], before: 84, after: mutable ? 96 : null });
  });
});
