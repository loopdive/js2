// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7427 — a built-in member read through its TypeScript property symbol is keyed like the native-prototype tables
// (`@@1` for `[Symbol.iterator]`), never by TypeScript's escaped `__@iterator@<id>`.
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { memberKeyForProperty } from "../src/checker/well-known-symbol-keys.js";
import { getWellKnownSymbolId, resolveWellKnownSymbol } from "../src/codegen/literals.js";
import { ts } from "../src/frontend/typescript.js";
import { compile } from "../src/index.js";

/** The member key of each property of the object type `o` declares. */
function memberKeys(source: string): (string | undefined)[] {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const declaration = ast.entryFile.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((d) => ts.isIdentifier(d.name) && d.name.text === "o")!;
  const type = ast.checker.getTypeAtLocation(declaration.name);
  return type.getProperties().map((property) => memberKeyForProperty(ast.checker, property));
}

/** The text of every native string literal in a module's WAT. */
function stringLiterals(wat: string): string[] {
  return [...wat.matchAll(/\(global \$__strlit_\d+ \(ref null \d+\) \(([^)]*?)array\.new_fixed/g)].map((match) =>
    String.fromCharCode(...[...match[1]!.matchAll(/i32\.const (-?\d+)/g)].slice(2).map((unit) => Number(unit[1]))),
  );
}

describe("#7427 — the member key of a property symbol", () => {
  it("is @@<id> for a well-known symbol, the name for a string key, undefined for a user symbol", () => {
    const keys = memberKeys(
      `const k: unique symbol = Symbol("k");
       export const o = { [Symbol.iterator]() {}, [Symbol.replace]: 1, [k]: 2, plain: 3 };`,
    );
    expect(keys).toEqual(["@@1", "@@8", undefined, "plain"]);
  });

  it("answers the library's own [Symbol.iterator] member as @@1", () => {
    const keys = memberKeys(`export const o: { [Symbol.iterator](): Iterator<string> } = "ab";`);
    expect(keys).toEqual(["@@1"]);
  });
});

describe("#7427 — one well-known-symbol table", () => {
  it.each([
    ["iterator", 1],
    ["matchAll", 15],
  ])("%s has id %i", (name, id) => {
    expect(getWellKnownSymbolId(name)).toBe(id);
    expect(resolveWellKnownSymbol(name)).toBe(`@@${name}`);
  });

  it.each(["toString", "constructor", "hasOwnProperty"])("%s is not a well-known symbol", (name) => {
    expect(getWellKnownSymbolId(name)).toBeUndefined();
    expect(resolveWellKnownSymbol(name)).toBeUndefined();
  });
});

describe("#7427 — String.prototype[Symbol.iterator] reached reflectively", () => {
  it("emits no refusal naming TypeScript's escaped key", async () => {
    const result = await compile(
      `export function run(): number { const it: any = String.prototype[Symbol.iterator].call("ab"); return it ? 1 : 0; }`,
      { target: "standalone", emitWat: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(stringLiterals(result.wat ?? "").filter((text) => text.includes("__@"))).toEqual([]);
  });
});
