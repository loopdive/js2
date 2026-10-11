// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";
import { buildIsPrototypeOfBody } from "../src/runtime/wasmgc/values/prototype-chain-bodies.js";
import {
  applyPrototypeChainExtraction,
  prototypeChainReceipt,
  prototypeChainReceiptPath,
} from "./helpers/prototype-chain-extraction.js";
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const receipt = prototypeChainReceipt(),
  current = read(receipt.path),
  donor = applyPrototypeChainExtraction(current, true);
function declaration(source: string, name: string) {
  const ast = ts.createSourceFile("donor.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = ast.statements.filter(
    (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  if (declarations.length !== 1) throw new Error("missing unique donor helper " + name);
  return declarations[0]!.getText(ast);
}
function canonicalizerStatement(source: string): string {
  const ast = ts.createSourceFile("donor.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const owners = ast.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === "buildObjectPrototypeHelpers",
  );
  if (owners.length !== 1 || !owners[0]!.body) throw new Error("missing unique prototype helper owner");
  const statements = owners[0]!.body.statements.filter(
    (node): node is ts.VariableStatement =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (item) => ts.isIdentifier(item.name) && item.name.text === "canonicalizeProtoArg",
      ),
  );
  if (statements.length !== 1 || statements[0]!.declarationList.declarations.length !== 1)
    throw new Error("missing unique canonicalizer statement");
  const list = statements[0]!.declarationList;
  if (!(list.flags & ts.NodeFlags.Const) || !list.declarations[0]!.initializer)
    throw new Error("canonicalizer is not an initialized const");
  return statements[0]!.getText(ast);
}
/** Mocked construction recorder, independent of the real Wasm execution controls. */
function capture(source: string, bits: number, changing = false) {
  const events: unknown[] = [],
    definitions: unknown[] = [];
  let calls = 0;
  const ctx = {
    funcMap: {
      get(name: string) {
        events.push(name);
        calls++;
        return (name === "__fnctor_proto_start" ? bits & 4 : bits & 8) ? (changing ? 100 + calls : 70) : undefined;
      },
    },
  };
  const helpers = [
    "fnctorIsPrototypeOfSeed",
    "classInstanceIsPrototypeOfSeed",
    "fnctorProtoLocal",
    "classInstanceProtoLocal",
  ]
    .map((name) => declaration(source, name))
    .join("\n");
  const block = source.slice(source.indexOf("  // __isPrototypeOf(externref"), source.lastIndexOf("\n}"));
  const bindings = {
    ctx,
    objectTypeIdx: 10,
    objRefNull: { kind: "ref_null", typeIdx: 10 },
    proxyGetTargetIdx: bits & 1 ? 20 : undefined,
    protoFromFunctionIdx: bits & 2 ? 30 : undefined,
    FNCTOR_PROTO_START: "__fnctor_proto_start",
    buildIsPrototypeOfBody,
    registerNative: (...args: unknown[]) => {
      events.push("register");
      definitions.push(args);
    },
  };
  const canonical = canonicalizerStatement(source);
  const js = ts.transpileModule(helpers + canonical + block, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function(...Object.keys(bindings), js)(...Object.values(bindings));
  return { events, definitions };
}
it("reconstructs and replays the complete signed donor", () => {
  expect(receipt.base).toBe("532bbc79de13b9e334d7a4983496d35f98469035");
  expect(applyPrototypeChainExtraction(donor, false)).toBe(current);
});
it.each(Array.from({ length: 16 }, (_, i) => i))("preserves all canonicalizer/seed combinations %s", (bits) =>
  expect(capture(current, bits)).toStrictEqual(capture(donor, bits)),
);
it("retains repeated acquisitions in exact order under changing responses", () => {
  const actual = capture(current, 15, true);
  expect(actual).toStrictEqual(capture(donor, 15, true));
  expect(actual.events).toEqual([
    "__fnctor_proto_start",
    "__fnctor_proto_start",
    "__getPrototypeOf",
    "__fnctor_proto_start",
    "__getPrototypeOf",
    "register",
  ]);
  expect(JSON.stringify(actual.definitions)).toContain('"funcIdx":101');
  expect(JSON.stringify(actual.definitions)).toContain('"funcIdx":103');
});
it("allocates fresh instruction objects on repeated construction", () => {
  const seed = { startIdx: 20, objectTypeIdx: 10, curSlot: 3, targetSlot: 2, protoSlot: 5, candidateSlot: 1 };
  const d = {
    objectTypeIdx: 10,
    objRefNull: { kind: "ref_null" as const, typeIdx: 10 },
    fnctor: seed,
    classInstance: { ...seed, protoSlot: 6 },
  };
  const nodes = (value: unknown): object[] =>
    value && typeof value === "object" ? [value, ...Object.values(value).flatMap(nodes)] : [];
  const a = buildIsPrototypeOfBody(d),
    b = buildIsPrototypeOfBody(d),
    borrowed = new Set(nodes(d.objRefNull));
  const seen = new Set(nodes(a).filter((x) => !borrowed.has(x)));
  expect(nodes(b).some((x) => seen.has(x))).toBe(false);
  expect(a).toEqual(b);
});
it.each(receipt.spans.map((_, i) => i))("rejects missing or altered extraction span %s", (i) => {
  const span = receipt.spans[i]!;
  expect(() => applyPrototypeChainExtraction(current.replace(span.after, span.before), true)).toThrow();
});
it("rejects duplicated extraction text", () =>
  expect(() => applyPrototypeChainExtraction(current + receipt.spans[1]!.after, true)).toThrow());
it("rejects unrelated donor changes", () => expect(() => applyPrototypeChainExtraction(donor + "\n", false)).toThrow());
it("authenticates actual runtime recipe bytes", () =>
  expect(() =>
    applyPrototypeChainExtraction(current, true, (p) => (p === receipt.modules[0]!.path ? read(p) + "\n" : read(p))),
  ).toThrow("builder mismatch"));
it("authenticates the receipt", () =>
  expect(() => prototypeChainReceipt((p) => (p === prototypeChainReceiptPath ? read(p) + "\n" : read(p)))).toThrow(
    "receipt mismatch",
  ));
