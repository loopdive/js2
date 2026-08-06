// #4179 — top-level `with` statements were silently DROPPED from __module_init.
//
// `collectDeclarations`' module-init collection is an allow-list of statement
// kinds, and `ts.WithStatement` was not in it: a module-level `with (o) { … }`
// matched no arm, so the ENTIRE statement was dropped — the body never
// executed, every write through the object environment was lost, and the
// `var`s inside the body were never hoisted. The same `with` inside a function
// body always worked (the tiering in compileWithStatement is not at fault).
// Same collection-gap family as #2992 (top-level `delete`), #3592 (top-level
// `throw`), #3615 (top-level bare property read).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function runModule(pre: string, ret: string, target?: "standalone"): Promise<any> {
  const src = `${pre}\nexport function test(): any { return ${ret}; }`;
  const result: any = await compile(src, {
    fileName: "test.ts",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    ...(target ? { target } : {}),
  } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  (instance.exports as any).__module_init?.();
  const exp = wrapExports(instance.exports, { signatures: result.exportSignatures });
  return exp.test();
}

describe("#4179 — top-level `with` reaches __module_init", () => {
  it("Tier-1 static write through a top-level with (standalone)", async () => {
    expect(await runModule(`var s = { z: 9 };\nwith (s) { z = 44; }`, `(s as any).z`, "standalone")).toBe(44);
  });

  it("Tier-2 dynamic write through a top-level with (standalone)", async () => {
    expect(
      await runModule(
        `function mk(): any { return { x: 1 }; }\nvar s = mk();\nwith ((s as any) || null) { x = 55; }`,
        `s.x`,
        "standalone",
      ),
    ).toBe(55);
  });

  it("S11.13.2_A5.*_T2 shape: top-level RMW resolves the Reference once (standalone)", async () => {
    // The getter deletes the property mid-read; the write must still land on
    // the with-object (recreating it as a data property), and the outer `x`
    // must stay untouched.
    expect(
      await runModule(
        `var x = 0;\nvar scope = { get x() { delete (this as any).x; return 2; } };\nwith (scope) { x *= 3; }`,
        `(scope as any).x * 100 + x`,
        "standalone",
      ),
    ).toBe(600); // scope.x === 6, x === 0
  });

  it("hoists `var` declarations out of a top-level with body", async () => {
    expect(await runModule(`var s = { z: 7 };\nwith (s) { var hoisted = z; }`, `hoisted`, "standalone")).toBe(7);
  });

  it("top-level with executes on the JS-host lane too", async () => {
    expect(await runModule(`var s = { z: 9 };\nwith (s) { z = 44; }`, `(s as any).z`)).toBe(44);
  });
});
