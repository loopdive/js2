// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, vi } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { compile, compileMulti } from "../src/index.js";
import { collectUnsafeEnumeration } from "../src/compiler/enumeration-semantic-safety.js";

const hostFailures = [
  'const o={a:1,b:2};delete o.a;console.log(Object.keys(o).join(","));console.log(o.a);',
  "var a=[1,2,3];delete a[1];console.log(a.length,1 in a,a[1]===undefined);",
  'var o={b:1,2:2,a:3,1:4};delete o.b;o.b=5;console.log(Object.keys(o).join(","));',
  'var p={a:1};var o=Object.create(p);o.b=2;o.a=3;var t="";for(var k in o)t+=k;console.log(t);',
];
const standaloneFailures = [
  'const a={x:1,y:2};const b={...a,z:3};console.log(Object.keys(b).join(","));',
  'const o={a:1,b:2};const keys=[];for(const k in o)keys.push(k);console.log(keys.sort().join(","));',
];
function findings(source: string, standalone = false) {
  const ast = analyzeSource(source, "enumeration.js");
  return collectUnsafeEnumeration(ast.checker, ast.sourceFile, { standalone });
}

describe("#5401: enumeration and deletion carrier safety", () => {
  it.each([
    ["const o={x:1};delete o.x;o.x=2;console.log(o.x);", 2],
    ["const o={x:1};function unused(){delete o.x;}console.log(o.x);", 1],
  ] as const)("executes restored values and separate function scopes: %s", async (source, expected) => {
    expect(findings(source).map((finding) => finding.message)).toEqual([]);
    const result = await compile(source, { fileName: "scope-delete.js", allowJs: true, deferTopLevelInit: true });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const values: unknown[][] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      values.push(args);
    });
    try {
      const imports = result.importObject!;
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      (imports as any).__setInstance?.(instance);
      (instance.exports.__module_init as () => void)();
    } finally {
      spy.mockRestore();
    }
    expect(values).toEqual([[expected]]);
  });
  it.each([
    "const o={x:1};function run(){\ndelete o.x;console.log(o.x);}run();",
    "const o={x:1,y:2};\ndelete o.x;o.x=2;console.log(Object.keys(o));",
    "const o={x:1};\ndelete o.x;const before=o.x;o.x=2;console.log(before);",
    "const o={x:1,y:1};\ndelete o.x;o.y=2;console.log(o.x);",
    "const o={x:1};\ndelete o.x;if(false)o.x=2;console.log(o.x);",
  ])("retains source-located unsupported observations: %s", (source) => {
    const result = findings(source);
    expect(result.map((finding) => finding.id)).toEqual(["JS2WASM_UNSOUND_ENUMERATION"]);
    expect(result[0].node.getText()).toBe("delete o.x");
    expect(result[0].node.getSourceFile().getLineAndCharacterOfPosition(result[0].node.getStart()).line).toBe(1);
  });
  it.each(["obj", "alias"])("executes generic any-carrier deletion through %s", async (receiver) => {
    const source = `export function test():number {
      var obj:any={x:5}; const alias=obj;
      var before=${receiver}.hasOwnProperty("x")?1:0;
      delete ${receiver}.x;
      var after=${receiver}.hasOwnProperty("x")?1:0;
      return before*10+after;
    }`;
    expect(findings(source).map((finding) => finding.message)).toEqual([]);
    const result = await compile(source, { fileName: "generic-delete.ts" });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const imports = result.importObject!;
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    (imports as any).__setInstance?.(instance);
    expect((instance.exports.test as () => number)()).toBe(10);
  });
  it.each(hostFailures)("refuses measured host flow: %s", async (source) => {
    const result = await compile(source, { fileName: "enumeration.js", allowJs: true });
    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.message.includes("JS2WASM_UNSOUND_ENUMERATION"))).toBe(true);
    expect(findings(source, true).map((finding) => finding.message)).toEqual([]);
  });
  it.each(standaloneFailures)("refuses measured standalone flow: %s", async (source) => {
    const result = await compile(source, { fileName: "enumeration.js", allowJs: true, target: "standalone" });
    expect(result.success).toBe(false);
    expect(result.errors.some((error) => error.message.includes("JS2WASM_UNSOUND_ENUMERATION"))).toBe(true);
    expect(findings(source).map((finding) => finding.message)).toEqual([]);
  });
  it("follows aliases and wrappers and anchors the unsupported operation", () => {
    const result = findings("const a={x:1};const alias=(a);\ndelete alias.x;console.log(alias.x);");
    expect(result).toHaveLength(1);
    expect(result[0].node.getText()).toBe("delete alias.x");
    expect(result[0].node.getSourceFile().getLineAndCharacterOfPosition(result[0].node.getStart()).line).toBe(1);
  });
  it("reports dependency locations through compileMulti even when TypeScript errors are skipped", async () => {
    const result = await compileMulti(
      { "main.ts": 'import "./dep";', "dep.ts": "const o={a:1};\ndelete o.a;console.log(o.a);" },
      "main.ts",
      { skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(false);
    const error = result.errors.find((error) => error.message.includes("JS2WASM_UNSOUND_ENUMERATION"));
    expect(error?.file).toContain("dep.ts");
    expect(error?.line).toBe(2);
  });
  it.each([
    "const o={a:1};delete o.a;console.log(o.a===undefined);",
    "const o={a:1};const before=o.a;delete o.a;console.log(before);",
    "const o={a:1,b:2};delete o.a;console.log(o.b);",
    "const o={a:1};const deleted=delete o.a;console.log(deleted);",
    'const o={a:1,b:2};console.log(Object.keys(o).join(","));',
    'const o={a:1,b:2};let s="";for(const k in o)s+=k;console.log(s);',
    'const o={a:1,b:2};const keys=[];for(const k in o)keys.push(k);console.log(keys.join(","));',
    'const keys=["a","b"];console.log(keys.sort().join(","));',
    "const o={a:1};delete o.missing;",
    "const a=[1,2];delete a[9];",
    "let o={a:1};o={b:2};delete o.a;",
    "const Object={create(x){return x}};const o=Object.create({a:1});for(const k in o){}",
  ])("keeps unrelated and supported shapes: %s", (source) => {
    expect(findings(source).map((finding) => finding.message)).toEqual([]);
    expect(findings(source, true).map((finding) => finding.message)).toEqual([]);
  });
  it.each([
    ['const o={a:1,b:2};let s="";for(const k in o)s+=k;console.log(s);', "ab\n"],
    ['const o={a:1,b:2};const keys=[];for(const k in o)keys.push(k);console.log(keys.join(","));', "a,b\n"],
    ['const o={a:1,b:2};delete o.a;console.log(Object.keys(o).join(","));console.log(o.a);', "b\nundefined\n"],
  ])("executes supported standalone control: %s", async (source, expected) => {
    const result = await compile(source, {
      fileName: "enumeration.js",
      allowJs: true,
      target: "standalone",
      hostBridge: "always",
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const length = (instance.exports.__stdout_prepare as () => number)();
    const char = instance.exports.__stdout_char as (index: number) => number;
    expect(Array.from({ length }, (_, index) => String.fromCharCode(char(index))).join("")).toBe(expected);
  });
});
