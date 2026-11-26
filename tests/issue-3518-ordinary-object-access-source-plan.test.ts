// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { ts } from "../src/frontend/typescript.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareOrdinaryObjectAccessResolver } from "../src/frontend/builtins/prepare-ordinary-object-access.js";
function prepare(source: string, extra: Record<string, string> = {}, name?: string) {
  const ast = analyzeMultiSource({ "./entry.ts": source, ...extra }, "./entry.ts");
  const root = ast.entryFile.statements
    .filter(ts.isFunctionDeclaration)
    .find((declaration) => name === undefined || declaration.name?.text === name);
  if (!root) throw new Error("missing function");
  const sites: ts.PropertyAccessExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) sites.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  expect(sites.length).toBeGreaterThan(0);
  return { ast, sites, resolver: prepareOrdinaryObjectAccessResolver(ast.checker, ast.sourceFiles, root, () => false) };
}
const expected = { key: "value", resultType: { kind: "val", val: { kind: "f64" } } };
describe("source-owned ordinary property reads", () => {
  it("plans an explicit numeric getter read with frozen metadata", () => {
    const p = prepare("export function run(){const object={get value(){return 7;}};return object.value;}");
    const row = p.resolver.preparedOrdinaryPropertyRead(p.sites[0]!);
    expect(row).toEqual(expected);
    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row!.resultType)).toBe(true);
  });
  it("admits an actual bare object-literal receiver", () => {
    const p = prepare("export function run(){return {get value(){return 7;}}.value;}");
    expect(p.resolver.preparedOrdinaryPropertyRead(p.sites[0]!)).toEqual(expected);
  });
  it.each([
    "export function run(){let object={get value(){return 7;}};return object.value;}",
    "export function run(){const source={get value(){return 7;}};const object=source;return object.value;}",
    "export function run(object:{value:number}){return object.value;}",
    "export function run(){const object={get value(){return 'seven';}};return object.value;}",
    "export function run(){const object={get value(){return 7;}};return object?.value;}",
  ])("refuses an unproven receiver/carrier: %s", (source) => {
    const p = prepare(source);
    expect(p.sites.map(p.resolver.preparedOrdinaryPropertyRead)).toEqual([undefined]);
  });
  // (#7354 O1) A data-only literal whose binding is only read as `o.k` holds its own initializers: its reads are
  // planned too, through the binding the checker resolves (here the inner one).
  it.each([
    "export function run(){const object={value:7};return object.value;}",
    "export function run(){var object={value:7};return object.value;}",
    "export function run(){const object={['value']:7};return object.value;}",
    "export function run(){const object={get value(){return 7;}};{const object={value:9};return object.value;}}",
  ])("admits a data-only literal receiver: %s", (source) => {
    const p = prepare(source);
    expect(p.sites.map(p.resolver.preparedOrdinaryPropertyRead)).toEqual([expected]);
  });
  // (#7354 O1) Any other use of the binding may change a property after the literal stored it, or hands the object
  // to code that may: the reference scan refuses every read through it. Each program is the admitted one plus one
  // such use (none: the control).
  const withUse = (use: string, binding = "const") =>
    prepare(
      `function set(o:{value:number}){o.value=2;}export function run(){${binding} object={value:7};${use}return object.value;}`,
      {},
      "run",
    );
  it("admits the program the refusals below extend", () => {
    const p = withUse("");
    expect(p.sites.map(p.resolver.preparedOrdinaryPropertyRead)).toEqual([expected]);
  });
  it.each([
    ["a member write", "object.value=2;"],
    ["a compound member write", "object.value+=2;"],
    ["a member update", "object.value++;"],
    ["a parenthesized member write", "(object.value)=2;"],
    ["a destructuring write to a member", "[object.value]=[2];"],
    ["an element write", "object['value']=2;"],
    ["a call argument", "set(object);"],
    ["an alias", "const other=object;other.value=2;"],
    ["a shorthand member of another literal", "const outer={object};"],
    ["a spread into another literal", "const copy={...object};"],
    ["a closure capture that writes", "const write=()=>{object.value=2;};write();"],
  ])("refuses a data-only literal whose binding has %s", (_label, use) => {
    const p = withUse(use);
    expect(p.sites.map(p.resolver.preparedOrdinaryPropertyRead)).toEqual(p.sites.map(() => undefined));
  });
  it("refuses a var-bound data-only literal that another literal holds by shorthand", () => {
    const p = withUse("var outer={object};", "var");
    expect(p.sites.map(p.resolver.preparedOrdinaryPropertyRead)).toEqual([undefined]);
  });
  it("refuses imported descriptor receiver", () => {
    const p = prepare('import {object} from "./other";export function run(){return object.value;}', {
      "./other.ts": "export const object={get value(){return 7;}};",
    });
    expect(p.resolver.preparedOrdinaryPropertyRead(p.sites[0]!)).toBeUndefined();
  });
  it("rejects identical cloned access and foreign population", () => {
    const source = "export function run(){const object={get value(){return 7;}};return object.value;}";
    const p = prepare(source),
      clone = prepare(source);
    expect(p.resolver.preparedOrdinaryPropertyRead(p.sites[0]!)).toEqual(expected);
    expect(p.resolver.preparedOrdinaryPropertyRead(clone.sites[0]!)).toBeUndefined();
    const declaration = clone.ast.entryFile.statements.find(ts.isFunctionDeclaration)!;
    expect(
      prepareOrdinaryObjectAccessResolver(
        p.ast.checker,
        p.ast.sourceFiles,
        declaration,
        () => false,
      ).preparedOrdinaryPropertyRead(clone.sites[0]!),
    ).toBeUndefined();
  });
  it("accepts genuine module statements without making a synthetic source", () => {
    const ast = analyzeMultiSource(
      { "./entry.ts": "const object={get value(){return 7;}};export const result=object.value;" },
      "./entry.ts",
    );
    const statement = ast.entryFile.statements[1];
    if (!statement || !ts.isVariableStatement(statement)) throw new Error("missing statement");
    const access = statement.declarationList.declarations[0]?.initializer;
    if (!access || !ts.isPropertyAccessExpression(access)) throw new Error("missing property read");
    expect(
      prepareOrdinaryObjectAccessResolver(
        ast.checker,
        ast.sourceFiles,
        [statement],
        () => false,
      ).preparedOrdinaryPropertyRead(access),
    ).toEqual(expected);
  });
});
