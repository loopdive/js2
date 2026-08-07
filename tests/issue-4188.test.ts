// #4188 — top-level `Math.<p> = v` / `JSON.<p> = v` expando writes were
// silently DROPPED from __module_init (standalone).
//
// `collectDeclarations`' module-init collection is an allow-list keyed on the
// assignment's root identifier; `Math`/`JSON` are neither module globals nor
// top-level functions, so the whole statement matched no arm and vanished —
// the same collection-gap family as #1268 / #2671 / #2992 / #3366 / #3468 /
// #3592 / #3615 / #4179. The write itself has been compilable since #2907: the
// bare identifier resolves to the native namespace-carrier `$Object` singleton
// and the write-arm routes through `__extern_set` onto it. Only the top-level
// collection dropped it.
//
// The observable damage was the 46-file test262 Math/JSON descriptor-carrier
// cluster (`Math.value = "Math"; Object.defineProperty(obj, "p", Math)` read
// back an EMPTY descriptor). Measured on this fix: +38 of those 46 pass; the
// 8 residual are the separate "of prototype object" inheritance family
// (`Object.prototype.value = …` reaching Math via [[Get]] — #4160 territory).
//
// Results are compared INSIDE the module (numbers out): a native string
// returned raw over the boundary is an opaque struct to JS in this harness.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function runModule(pre: string, ret: string): Promise<any> {
  const src = `${pre}\nexport function test(): any { return ${ret}; }`;
  const result: any = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    target: "standalone",
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  (instance.exports as any).__module_init?.();
  const exp = wrapExports(instance.exports, { signatures: result.exportSignatures });
  return exp.test();
}

describe("#4188 — top-level namespace-carrier expando writes reach __module_init (standalone)", () => {
  it("Math data-descriptor carrier: the test262 15.2.3.6-3-144 shape", async () => {
    expect(
      await runModule(
        `var obj: any = {};\nMath.value = "Math";\nObject.defineProperty(obj, "property", Math);`,
        `obj.property === "Math" ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it("JSON accessor-descriptor carrier: the 15.2.3.6-3-226 shape", async () => {
    expect(
      await runModule(
        `var obj: any = {};\n(JSON as any).get = function () { return "jsonGetProperty"; };\nObject.defineProperty(obj, "property", JSON as any);`,
        `obj.property === "jsonGetProperty" ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it("the write lands as an own property visible to hasOwnProperty / gOPN", async () => {
    expect(
      await runModule(
        `(Math as any).zz = 7;\nvar names: any = Object.getOwnPropertyNames(Math);\nvar hit = false;\nfor (var i = 0; i < names.length; i++) { if (names[i] === "zz") hit = true; }`,
        `(hit && (Math as any).hasOwnProperty("zz")) ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it("a top-level function shadowing the namespace name still wins (guard)", async () => {
    // `Math` here is a top-level FUNCTION; the namespace keep-arm must decline
    // (topLevelFunctionNames guard) and the #3468 F1 function-static keep must
    // land the write on the function object, not on any builtin carrier.
    expect(await runModule(`function Math(): any { return 0; }\n(Math as any).value = 3;`, `(Math as any).value`)).toBe(
      3,
    );
  });

  it("same write inside a function body keeps working (was never broken)", async () => {
    expect(
      await runModule(
        `function poke(): void { (JSON as any).marker = 11; }\npoke();`,
        `(JSON as any).hasOwnProperty("marker") ? 1 : 0`,
      ),
    ).toBe(1);
  });
});
