// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/ts-api.js";
import { buildTypeMap, _internals, lowerTypeToIrType, type LatticeType } from "../src/ir/propagate.js";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { buildIrUnitTypeMap } from "../src/ir/propagate.js";

const marker = { kind: "generator-object" } as LatticeType;
function facts(source: string, checked = true) {
  const name = "generator-planning.js";
  const options = { allowJs: true, noEmit: true, target: ts.ScriptTarget.ESNext };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (file, version, ...rest) =>
    file === name ? ts.createSourceFile(name, source, version, true, ts.ScriptKind.JS) : read(file, version, ...rest);
  const program = ts.createProgram([name], options, host);
  return buildTypeMap(program.getSourceFile(name)!, checked ? program.getTypeChecker() : undefined);
}

describe("generator callable result planning", () => {
  it.each([
    "function* g(){return 7;} for(g of [function(){return 3;}]){} export function test(){return g();}",
    "function* g(){return 7;} async function wrap(){return g();} export function test(){return wrap();}",
  ])("does not make a false IR wrapper claim: %s", async (source) => {
    const result = await compile(source, {
      fileName: "completion.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      trackFallbacks: true,
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.irPostClaimErrors).toEqual([]);
    expect(result.irCompiledFuncs ?? []).not.toContain("test");
  });
  it.each([
    "for(g of [function(){return 3;}]){}",
    "for(g in {key:1}){}",
    "var g=function(){return 3;};",
    "var [g]=[function(){return 3;}];",
    "var {value:g}={value:function(){return 3;}};",
    "for(var g of [function(){return 3;}]){}",
    "for(var [g] of [[function(){return 3;}]]){}",
    "for(var {value:g} of [{value:function(){return 3;}}]){}",
    "for([g] of [[function(){return 3;}]]){}",
    "for({value:g} of [{value:function(){return 3;}}]){}",
    "for({g} of [{g:function(){return 3;}}]){}",
    "for([g = function(){return 3;}] of [[]]){}",
    "for([...g] of [[3]]){}",
    "for({...g} of [{value:3}]){}",
    "for([g] in {key:1}){}",
    "for({value:g} in {key:1}){}",
    "[g]=[function(){return 3;}];",
    "({value:g}={value:function(){return 3;}});",
    "g ||= function(){return 3;};",
    "g++;",
  ])("demotes callable loop/destructuring writes: %s", (write) => {
    const map = facts(`function* g(){return 7;} ${write} function test(){return g();}`);
    expect(map.get("g")?.returnType).not.toEqual(marker);
    expect(map.get("test")?.returnType).not.toEqual(marker);
  });
  it.each([true, false])("does not propagate Promise wrappers as generator objects, checker=%s", (checked) => {
    const map = facts(
      "function* g(){return 7;} async function wrap(){return g();} function test(){return wrap();}",
      checked,
    );
    expect(map.get("g")?.returnType).toEqual(marker);
    expect(map.get("wrap")?.returnType).not.toEqual(marker);
    expect(map.get("test")?.returnType).not.toEqual(marker);
  });
  it("keeps a generator binding when a loop declares a shadow", () => {
    expect(
      facts("function* g(){return 7;} for(let g of [3]){} function test(){return g();}").get("test")?.returnType,
    ).toEqual(marker);
  });
  it("preserves an uninitialized var redeclaration", () => {
    expect(facts("function* g(){return 7;} var g; function test(){return g();}").get("test")?.returnType).toEqual(
      marker,
    );
  });
  it.each(["function other(){var g=3;}", "{let g=3;}", "{const g=3;}"])(
    "preserves distinct lexical binding: %s",
    (shadow) => {
      expect(facts(`function* g(){return 7;} ${shadow} function test(){return g();}`).get("test")?.returnType).toEqual(
        marker,
      );
    },
  );
  it.each(["g.value=3;", "({g:other}={g:3});", "[other=g]=[3];"])(
    "does not confuse binding reads with writes: %s",
    (write) => {
      expect(
        facts(`function* g(){return 7;} let other; ${write} function test(){return g();}`).get("test")?.returnType,
      ).toEqual(marker);
    },
  );
  it.each([false, true])("keeps same-name source identities separate, reverse=%s", (reverse) => {
    const files = new Map([
      ["/a.ts", "export {}; function* same(){return 7;} function owner(){return same();}"],
      ["/b.ts", "export {}; function same(){return 7;} function owner(){return same();}"],
    ]);
    const options = { noLib: true, target: ts.ScriptTarget.ESNext };
    const host = ts.createCompilerHost(options);
    host.getSourceFile = (name, version) =>
      files.has(name) ? ts.createSourceFile(name, files.get(name)!, version, true) : undefined;
    const roots = [...files.keys()];
    if (reverse) roots.reverse();
    const program = ts.createProgram(roots, options, host);
    const sources = roots.map((name) => program.getSourceFile(name)!);
    const checker = program.getTypeChecker();
    const context = buildIrPlanningIdentityContext(
      buildIrUnitInventory(sources, { checker, entrySource: program.getSourceFile("/a.ts")! }),
    );
    const map = buildIrUnitTypeMap(sources, checker, context);
    for (const source of sources) {
      const owner = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "owner")!;
      expect(map.get(context.unitIdByDeclaration.get(owner as ts.FunctionDeclaration)!)?.returnType).toEqual(
        source.fileName === "/a.ts" ? marker : { kind: "f64" },
      );
    }
  });
  it.each([true, false])("separates completion and call result (checker=%s)", (checked) => {
    const map = facts(
      "function test(){const value=wrap();return value;} function wrap(){return g();} function* g(){yield 1;return 7;} function scalar(){return 7;}",
      checked,
    );
    for (const name of ["g", "wrap", "test"]) expect(map.get(name)?.returnType).toEqual(marker);
    expect(map.get("scalar")?.returnType).toEqual({ kind: "f64" });
  });
  it.each(["return 7;", "return 'done';", "return;", ""])("completion %s does not define call result", (completion) => {
    expect(facts(`function* g(){yield 1;${completion}} function test(){return g();}`).get("test")?.returnType).toEqual(
      marker,
    );
  });
  it.each([
    "let value=g();value=7;return value;",
    "let value=g();if(flag)value=7;return value;",
    "const value=g();if(flag)return;return value;",
    "if(flag)return g();",
    "if(flag)return g();return undefined;",
    "if(flag)return g();return 7;",
    "const value=g();{let value=7;return value;}",
    "g=function(){return 7;};return g();",
    "const g=()=>7;return g();",
  ])("does not claim unsupported marker flow: %s", (body) => {
    expect(facts(`function* g(){return 7;} function test(flag){${body}}`).get("test")?.returnType).not.toEqual(marker);
  });
  it("does not promote async generator completions", () => {
    expect(facts("async function* g(){return 7;} function test(){return g();}").get("test")?.returnType).not.toEqual(
      marker,
    );
  });
  it("demotes a callable reassigned outside its wrapper", () => {
    expect(
      facts("function* g(){return 7;} function test(){return g();} g=function(){return 3;};").get("test")?.returnType,
    ).not.toEqual(marker);
  });
  it.each([{ target: "standalone" }, { target: "wasi" }, { strictNoHostImports: true }] as const)(
    "does not introduce host marker admission %j",
    async (mode) => {
      const result = await compile("function* g(){yield* [1,2];return 7;} export function test(){return g();}", {
        fileName: "completion.js",
        allowJs: true,
        skipSemanticDiagnostics: true,
        trackFallbacks: true,
        ...mode,
      });
      expect(result.irCompiledFuncs ?? []).not.toContain("test");
    },
  );
  it.each([
    [{ kind: "unknown" }, "generator-object"],
    [{ kind: "generator-object" }, "generator-object"],
    [{ kind: "dynamic" }, "dynamic"],
    [{ kind: "f64" }, "dynamic"],
    [{ kind: "object", fields: [] }, "dynamic"],
    [{ kind: "union", members: [{ kind: "f64" }, { kind: "bool" }] }, "dynamic"],
  ] as const)("joins marker with %j conservatively", (other, kind) => {
    expect(_internals.join(marker, other as LatticeType).kind).toBe(kind);
    expect(_internals.join(other as LatticeType, marker).kind).toBe(kind);
    expect(lowerTypeToIrType(marker)).toBeNull();
  });
  it.each([
    { fast: false, optimize: 0 },
    { fast: false, optimize: 2 },
    { fast: true, optimize: 0 },
    { fast: true, optimize: 2 },
  ] as const)("executes genuine host IR %j", async (mode) => {
    const result = await compile("function* g(){yield* [1,2];return 7;} export function test(){return g();}", {
      fileName: "completion.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      trackFallbacks: true,
      ...mode,
    });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(result.irCompiledFuncs).toEqual(expect.arrayContaining(["g", "test"]));
    expect(result.irPostClaimErrors).toEqual([]);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const iterator = (instance.exports.test as () => Iterator<unknown>)();
    expect([iterator.next(), iterator.next(), iterator.next(), iterator.next()]).toEqual([
      { value: 1, done: false },
      { value: 2, done: false },
      { value: 7, done: true },
      { value: undefined, done: true },
    ]);
  });
});
