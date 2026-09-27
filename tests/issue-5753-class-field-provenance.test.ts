// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/checker/index.js";
import { collectClassDeclaration } from "../src/codegen/class-bodies.js";
import { readClassFieldProvenance } from "../src/codegen/class-field-provenance.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { snapshotSpeculative, rollbackSpeculative } from "../src/codegen/context/speculative.js";
import type { FunctionContext } from "../src/codegen/context/types.js";
import { createEmptyModule, type StructTypeDef } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";
import "../src/codegen/expressions.js";

function collect(source: string, dynamicProto = false) {
  const ast = analyzeSource(source, "class-provenance.ts");
  const ctx = createCodegenContext(createEmptyModule(), ast.checker, { standalone: true, nativeStrings: true });
  if (dynamicProto) ctx.dynamicProtoClasses.add("C");
  for (const statement of ast.sourceFile.statements) {
    if (ts.isClassDeclaration(statement)) collectClassDeclaration(ctx, statement);
  }
  function type(name = "C") {
    const index = ctx.structMap.get(name);
    if (index === undefined) throw new Error(`missing class ${name}`);
    const result = ctx.mod.types[index];
    if (result?.kind !== "struct") throw new Error(`missing physical class ${name}`);
    return result;
  }
  function fact(name: string, className = "C") {
    const layout = type(className);
    const field = layout.fields.find((item) => item.name === name);
    if (!field) throw new Error(`missing ${className}.${name}`);
    return readClassFieldProvenance(ctx, layout, field);
  }
  return { ctx, type, fact };
}

describe("class field provenance is producer-only source evidence", () => {
  it.each([
    ["ordinary", "x = 1", "x", "public"],
    ["dollar", "$", "$", "public"],
    ["double underscore", "__public = 1", "__public", "public"],
    ["mangled-looking public", "__priv_x = 1", "__priv_x", "public"],
    ["private", "#x = 1", "__priv_x", "private"],
    ["private then public", "#x = 1; __priv_x = 2", "__priv_x", "ambiguous"],
    ["public then private", "__priv_x = 2; #x = 1", "__priv_x", "ambiguous"],
    ["duplicate public", "x; x; x = 1", "x", "public"],
    ["assignment", "constructor() { this.x = 1; }", "x", "public"],
    ["assignment and declaration", "x; constructor() { this.x = 1; }", "x", "public"],
    ["assignment-private collision", "#x; constructor() { this.__priv_x = 1; }", "__priv_x", "ambiguous"],
    ["private-assignment collision", "#x; __priv_x; constructor() { this.#x = 1; }", "__priv_x", "ambiguous"],
    ["synthetic tag collision", "__tag = 1", "__tag", "ambiguous"],
  ])("records %s through the real collector", (_label, members, field, kind) => {
    const result = collect(`class C { ${members} }`);
    expect(result.fact(field)?.kind).toBe(kind);
    if (kind !== "ambiguous") expect(result.fact(field)?.sources.length).toBeGreaterThan(0);
  });

  it("keeps every skipped declaration/assignment observation", () => {
    const result = collect("class C { x; x; constructor() { this.x = 1; this.x = 2; } }");
    expect(result.fact("x")?.sources).toHaveLength(4);
    expect(result.fact("x")?.kind).toBe("public");
  });

  it("inherits actual fields without poisoning parents or siblings", () => {
    const result = collect(`
      class Base { #x = 1; $; }
      class C extends Base { __priv_x = 2; constructor() { super(); this.$ = 1; } }
      class Sibling extends Base {}
    `);
    const parentField = result.type("Base").fields.find((field) => field.name === "__priv_x")!;
    expect(result.type().fields).toContain(parentField);
    expect(result.type("Sibling").fields).toContain(parentField);
    expect(result.fact("__priv_x")?.kind).toBe("ambiguous");
    expect(result.fact("__priv_x", "Base")?.kind).toBe("private");
    expect(result.fact("__priv_x", "Sibling")?.kind).toBe("private");
    expect(result.fact("$")?.sources).toHaveLength(2);
  });

  it("records compiler additions, never certifying later shape slots", () => {
    const result = collect("class C {}", true);
    for (const name of ["__tag", "__shape_brand", "__proto__"]) {
      expect(result.fact(name)?.kind).toBe("synthetic");
    }
    const shape = { name: "$shape", type: { kind: "i32" as const }, mutable: true };
    result.type().fields.push(shape);
    expect(readClassFieldProvenance(result.ctx, result.type(), shape)).toBeUndefined();
  });

  it("does not collect static or unsupported nested constructor assignments", () => {
    const result = collect("class C { static x = 1; constructor() { if (true) { this.y = 2; } } }");
    expect(result.type().fields.map((field) => field.name)).not.toContain("x");
    expect(result.type().fields.map((field) => field.name)).not.toContain("y");
  });

  it("keeps a reused dynamic-prototype slot ambiguous, not public", () => {
    expect(collect("class C { __proto__; }", true).fact("__proto__")?.kind).toBe("ambiguous");
    expect(collect("class C { __proto__; }").fact("__proto__")?.kind).toBe("public");
  });

  it("retains registration across the existing speculative rollback lifecycle", () => {
    const result = collect("class Base { $; }");
    const fctx = {
      params: [],
      locals: [],
      localMap: new Map(),
      body: [],
      labelMap: new Map(),
    } as unknown as FunctionContext;
    const snapshot = snapshotSpeculative(result.ctx, fctx);
    const ast = analyzeSource("class C {}", "speculative-class.ts");
    const declaration = ast.sourceFile.statements[0];
    if (!declaration || !ts.isClassDeclaration(declaration)) throw new Error("missing class");
    collectClassDeclaration(result.ctx, declaration);
    const layout = result.type();
    rollbackSpeculative(result.ctx, fctx, snapshot);
    expect(result.type()).toBe(layout);
    expect(result.fact("__tag")?.kind).toBe("synthetic");
    expect(result.fact("$", "Base")?.kind).toBe("public");
  });

  it("requires current type ownership, exact field membership and context", () => {
    const result = collect("class C { $; }");
    const layout = result.type();
    const field = layout.fields.find((item) => item.name === "$")!;
    const foreign = collect("class C { $; }");
    expect(readClassFieldProvenance(foreign.ctx, layout, field)).toBeUndefined();
    expect(readClassFieldProvenance(result.ctx, foreign.type(), field)).toBeUndefined();
    foreign.ctx.mod.types[foreign.ctx.structMap.get("C")!] = layout;
    foreign.ctx.structFields.set("C", layout.fields);
    expect(readClassFieldProvenance(foreign.ctx, layout, field)).toBeUndefined();
    expect(readClassFieldProvenance(result.ctx, layout, { ...field })).toBeUndefined();
    const index = result.ctx.structMap.get("C")!;
    result.ctx.mod.types[index] = { ...layout };
    expect(readClassFieldProvenance(result.ctx, layout, field)).toBeUndefined();
    expect(readClassFieldProvenance(result.ctx, result.ctx.mod.types[index] as StructTypeDef, field)).toBeUndefined();
    result.ctx.mod.types[index] = layout;
    expect(readClassFieldProvenance(result.ctx, layout, field)?.kind).toBe("public");
    result.ctx.structFields.set("C", [...layout.fields]);
    expect(readClassFieldProvenance(result.ctx, layout, field)).toBeUndefined();
    result.ctx.structFields.set("C", layout.fields);
    layout.fields.splice(layout.fields.indexOf(field), 1, { ...field });
    expect(readClassFieldProvenance(result.ctx, layout, field)).toBeUndefined();
    expect(result.fact("$")).toBeUndefined();
  });

  it("keeps inherited fields without a current parent record unknown", () => {
    const result = collect("class Base { $; }");
    const index = result.ctx.structMap.get("Base")!;
    result.ctx.mod.types[index] = { ...result.type("Base") };
    const ast = analyzeSource("class C extends Base {}", "unknown-parent.ts");
    const declaration = ast.sourceFile.statements[0];
    if (!declaration || !ts.isClassDeclaration(declaration)) throw new Error("missing class");
    collectClassDeclaration(result.ctx, declaration);
    expect(result.fact("$")?.kind).toBe("unknown");
  });
});
