import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

describe("optional reference results in eval-enabled modules", () => {
  for (const nested of [false, true])
    it.each(["string", "number[]", "{message:string}"])(
      `preserves undefined beside %s (nested=${nested})`,
      async (type) => {
        const value = type === "string" ? '"ok"' : type === "number[]" ? "[1,2]" : '{message:"ok"}';
        const encode = `function encode(value:any):${type}|undefined { if(typeof value==='undefined')return undefined; return ${value}; }`;
        const result = await compileMulti(
          {
            "/probe/main.ts": `
      ${nested ? "" : encode}
      export function absent():any { return undefined; }
      export function present():any { return 42; }
      export function check(value:any):number { ${nested ? encode : ""} const encoded=encode(value); return encoded===undefined?1:encoded===null?2:3; }
      export function demand(source:any):any { return (0,eval)(source); }
    `,
          },
          "/probe/main.ts",
          {
            target: "standalone",
            platform: "deno",
            skipSemanticDiagnostics: true,
            deferTopLevelInit: true,
          },
        );
        expect(result.success, JSON.stringify(result.errors)).toBe(true);
        const module = new WebAssembly.Module(result.binary as BufferSource);
        const imports: WebAssembly.Imports = {};
        for (const { module: namespace, name, kind } of WebAssembly.Module.imports(module)) {
          expect(kind).toBe("function");
          (imports[namespace] ??= {})[name] = () => {
            throw Error("unexpected eval provider call");
          };
        }
        const e = new WebAssembly.Instance(module, imports).exports as Record<string, (...args: any[]) => any>;
        e.__module_init?.();
        expect(e.check(e.absent())).toBe(1);
        expect(e.check(e.present())).toBe(3);
      },
    );
});
