// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as old from "../src/ir/alloc-registry.js";
import * as canonical from "../src/ir/analysis/alloc-registry.js";
import { asAllocSiteId } from "../src/ir/core/nodes.js";
import { IR_CLASS_SHAPE_CELL, irVal, type IrType } from "../src/ir/core/types.js";
import type { AllocRegistrySnapshot } from "../src/ir/analysis/contracts/allocations.js";

const root = resolve(import.meta.dirname, "..");
const oldPath = "src/ir/alloc-registry.ts";
const newPath = "src/ir/analysis/alloc-registry.ts";
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const runtimeExports = ["ALLOC_NAMESPACES", "AllocSiteRegistry", "copyIrPreparationData"] as const;
const typeExports = [
  "AllocSite",
  "AllocRegistryProvenanceSnapshot",
  "AllocRegistryMetadataSnapshot",
  "AllocRegistrySnapshot",
];

// Complete text/docs receipts from 3a119a88b28bb347f4faaaa2146bd991acf61228,
// original blob 4d371d2a98678e2227d770b123685ba7e8a38e78. No historical Git
// objects are required at test time. Tests exercise compatibility, not public
// compiler caller liveness, preparation closure or backend materialization.
const declarationReceipts: readonly { name: string; sha256: string }[] = [
  {
    name: "copyIrPreparationData",
    sha256: "482b87beebe8d0255294c92e1600469f2cfbfb6f6f0bf6f499233d762bf399b5",
  },
  {
    name: "ALLOC_NAMESPACES",
    sha256: "0fc6b0fe791f0f14497c5f05108642e38a1677cff0b92a8306efde0f491a87f1",
  },
  {
    name: "Provenance",
    sha256: "08aa7dc8f638e36b3a917ea7806d2fc132467a53367f8f68bba23b0d2ac154d2",
  },
  {
    name: "assertAllocRegistrySnapshot",
    sha256: "efba2b4b1e49536a4a0a1197f796e8d5053ad682812e165020ce215f91ceb37b",
  },
  {
    name: "AllocSiteRegistry",
    sha256: "56fd2b7f254597aa89c3a0af2be8e1c96796b8a82e008b3805bc1a7fe6e6aa87",
  },
];
const memberReceipts: readonly { name: string; kind: string; sha256: string; initializer: string | null }[] = [
  {
    name: "sites",
    kind: "PropertyDeclaration",
    sha256: "f2e3db15b4612e863ae62a14f21483db213069b331f7b97b153c3e4c8a710c5e",
    initializer: "[]",
  },
  {
    name: "meta",
    kind: "PropertyDeclaration",
    sha256: "205e48f1a0c247408e2e17624afa30102a661a8a5080db519addf1c856144a45",
    initializer: "[]",
  },
  {
    name: "metadataOrder",
    kind: "PropertyDeclaration",
    sha256: "b12009a164bac59306e285c75427862b44d784aa8cd4c4716d1313af7a132be5",
    initializer: null,
  },
  {
    name: "capturePreparationData",
    kind: "MethodDeclaration",
    sha256: "28723cb855f16b748effe1925d85d176ee8521847409c352f80e47a691876c7c",
    initializer: null,
  },
  {
    name: "captureSnapshot",
    kind: "MethodDeclaration",
    sha256: "f8ceac0ba72fe33ba8b8367ae95f7871253dac21b31a7d380f4b278de5df7d07",
    initializer: null,
  },
  {
    name: "restorePreparationData",
    kind: "MethodDeclaration",
    sha256: "f4f5e322e2fef4c2c014f34f70595fa8b75edf3d34ce8efb7f90fba92fa38904",
    initializer: null,
  },
  {
    name: "fromSnapshot",
    kind: "MethodDeclaration",
    sha256: "dd98bbc5300c8b83f58df18584d275f81a78ce7e73c3f1569eaae886e42fe96b",
    initializer: null,
  },
  {
    name: "metadataSnapshot",
    kind: "MethodDeclaration",
    sha256: "bd1f695fd84a47e41225df19cec4c0f445207877e77c33ee2b9ca49e9d42d6c5",
    initializer: null,
  },
  {
    name: "fresh",
    kind: "MethodDeclaration",
    sha256: "405ad2c8ec5864299d5110b0154a739f2c82242cf3cffe7ba61ae6b329b813a0",
    initializer: null,
  },
  {
    name: "isKnown",
    kind: "MethodDeclaration",
    sha256: "3104499601f79326bc26683a5c7e77f5986bd9bdf0fa1432b3852669f3bfb45e",
    initializer: null,
  },
  {
    name: "resolve",
    kind: "MethodDeclaration",
    sha256: "27974f88dcb3f6ae22260ddb3a46e42c0d6696084614b0c69430cd054ddce922",
    initializer: null,
  },
  {
    name: "canonicalIndex",
    kind: "MethodDeclaration",
    sha256: "78ee1b70635b74ea712829ca8bb5ab3e2fd02e6fee9892d30f66b140ac18a891",
    initializer: null,
  },
  {
    name: "alias",
    kind: "MethodDeclaration",
    sha256: "bdb79b546fa5d073f0a0124a3ba0a82c3be0d05667e2b4c349e80b96b47c4218",
    initializer: null,
  },
  {
    name: "retire",
    kind: "MethodDeclaration",
    sha256: "10ef25341179c088d7c983ecfffd1bf3be2a1c1e3d519de4f6daef30d1fb9993",
    initializer: null,
  },
  {
    name: "annotate",
    kind: "MethodDeclaration",
    sha256: "d4a4a5546ab880678d7a75f48e4afb3e977c906896eab2ef9e5a0933d9a12221",
    initializer: null,
  },
  {
    name: "read",
    kind: "MethodDeclaration",
    sha256: "46e11eba38cc8c9c03bf88d001c144585ff2f840184d225b818e10cdbd3bc269",
    initializer: null,
  },
  {
    name: "size",
    kind: "GetAccessor",
    sha256: "fb6e16460fa93c7376f50737872011c90d4bedd0fe7ff1fc193f1b0b32068e9a",
    initializer: null,
  },
  {
    name: "liveSites",
    kind: "MethodDeclaration",
    sha256: "56b06a9c088734e2b7cfc7105eef056f55c429681252de0426ee2b169228485a",
    initializer: null,
  },
  {
    name: "snapshot",
    kind: "MethodDeclaration",
    sha256: "004514d9cc2c4e221d64a9e2b91b476a2ac8e46ccdc2f295f21fc23277f94f77",
    initializer: null,
  },
];

function parse(path: string, text = read(path)) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  expect((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics).toEqual([]);
  return file;
}

function declarationName(node: ts.Statement) {
  if (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node))
    return node.name?.text;
  if (ts.isVariableStatement(node)) return node.declarationList.declarations[0]?.name.getText();
  return undefined;
}

function verifyCanonical(text = read(newPath)) {
  const file = parse(newPath, text);
  const declarations = file.statements.filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node));
  expect(declarations.map(declarationName)).toEqual(declarationReceipts.map((row) => row.name));
  expect(declarations).toHaveLength(5);
  for (const [index, node] of declarations.entries())
    expect(sha(node.getFullText().trim())).toBe(declarationReceipts[index]!.sha256);
  const klass = declarations.find(ts.isClassDeclaration)!;
  expect(klass.name?.text).toBe("AllocSiteRegistry");
  expect(klass.members).toHaveLength(19);
  expect(klass.members.filter(ts.isMethodDeclaration)).toHaveLength(15);
  expect(klass.members.filter(ts.isGetAccessorDeclaration)).toHaveLength(1);
  expect(klass.members.filter(ts.isPropertyDeclaration)).toHaveLength(3);
  expect(klass.members.filter(ts.isConstructorDeclaration)).toHaveLength(0); // Original implicit constructor.
  expect(klass.members.filter(ts.isClassStaticBlockDeclaration)).toHaveLength(0);
  for (const [index, member] of klass.members.entries()) {
    const row = memberReceipts[index]!;
    expect(member.name?.getText()).toBe(row.name);
    expect(ts.SyntaxKind[member.kind]).toBe(row.kind);
    expect(sha(member.getFullText().trim()), row.name).toBe(row.sha256);
    expect(ts.isPropertyDeclaration(member) ? (member.initializer?.getText() ?? null) : null).toBe(row.initializer);
  }
  let functionLikes = 0;
  const visit = (node: ts.Node) => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node)
    )
      functionLikes++;
    ts.forEachChild(node, visit);
  };
  declarations.forEach(visit);
  expect(functionLikes).toBe(28); // Includes ten nested arrows, not an execution count.
  const constants = declarations.filter(ts.isVariableStatement);
  expect(constants).toHaveLength(1);
  expect(sha(constants[0]!.declarationList.declarations[0]!.initializer!.getText())).toBe(
    "0cf758e5c1d454c433e52f6dd764fb55f9382fa4fd7b781a7e7f70494de598b4",
  );
  const imports = file.statements
    .filter(ts.isImportDeclaration)
    .map((node) => (node.moduleSpecifier as ts.StringLiteral).text);
  expect(imports).toEqual(["../core/nodes.js", "../core/types.js", "./contracts/allocations.js"]);
}

const id = asAllocSiteId;
const f64 = irVal({ kind: "f64" });
function expectFailure(run: () => unknown, message: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  if (!(caught instanceof Error)) throw new Error("expected the retained Error refusal");
  expect(caught.message).toBe(message);
}

function snapshot(): AllocRegistrySnapshot {
  return {
    size: 5,
    entries: [
      { state: "aliased", to: id(1) },
      { state: "aliased", to: id(2) },
      { state: "live", site: { id: id(2), kind: "object", type: f64 } },
      { state: "retired" },
      { state: "aliased", to: id(3) },
    ],
    metadata: [
      {
        id: id(2),
        entries: [
          ["future", undefined],
          ["winner", "target"],
        ],
      },
      { id: id(0), entries: [["winner", "source"]] },
    ],
  };
}

describe("allocation ownership runtime relocation", () => {
  it.each(runtimeExports)("preserves the exact old/new %s export identity", (name) => {
    expect(old[name]).toBe(canonical[name]);
  });

  it("retains every declaration, method, getter, private field, initializer and comment", () => {
    verifyCanonical();
  });

  it("leaves only explicit compatibility forwards and no second implementation or initialization", () => {
    const file = parse(oldPath);
    expect(file.statements).toHaveLength(2);
    for (const statement of file.statements) {
      expect(ts.isExportDeclaration(statement)).toBe(true);
      if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause))
        throw new Error("non-explicit facade");
      const target = (statement.moduleSpecifier as ts.StringLiteral).text;
      const names = statement.exportClause.elements.map((element) => {
        expect(element.propertyName).toBeUndefined();
        return element.name.text;
      });
      expect(target).toBe(
        statement.isTypeOnly ? "./analysis/contracts/allocations.js" : "./analysis/alloc-registry.js",
      );
      expect(names.sort()).toEqual([...(statement.isTypeOnly ? typeExports : runtimeExports)].sort());
    }
    expect(Object.keys(old).sort()).toEqual([...runtimeExports].sort());
    expect(Object.keys(canonical).sort()).toEqual([...runtimeExports].sort());
    expect(Object.isFrozen(canonical.ALLOC_NAMESPACES)).toBe(false); // as const was not a runtime freeze.
  });

  it("keeps constructor, static/prototype member identities and independent field initialization", () => {
    expect(old.AllocSiteRegistry.prototype).toBe(canonical.AllocSiteRegistry.prototype);
    expect(Object.getOwnPropertyNames(canonical.AllocSiteRegistry.prototype).sort()).toEqual(
      [
        "constructor",
        "capturePreparationData",
        "captureSnapshot",
        "metadataSnapshot",
        "fresh",
        "isKnown",
        "resolve",
        "canonicalIndex",
        "alias",
        "retire",
        "annotate",
        "read",
        "size",
        "liveSites",
        "snapshot",
      ].sort(),
    );
    for (const name of Object.getOwnPropertyNames(canonical.AllocSiteRegistry.prototype)) {
      const previous = Object.getOwnPropertyDescriptor(old.AllocSiteRegistry.prototype, name)!;
      const current = Object.getOwnPropertyDescriptor(canonical.AllocSiteRegistry.prototype, name)!;
      expect(current.value).toBe(previous.value);
      expect(current.get).toBe(previous.get);
      expect(current.set).toBe(previous.set);
    }
    expect(old.AllocSiteRegistry.restorePreparationData).toBe(canonical.AllocSiteRegistry.restorePreparationData);
    expect(old.AllocSiteRegistry.fromSnapshot).toBe(canonical.AllocSiteRegistry.fromSnapshot);
    const first = new old.AllocSiteRegistry(),
      second = new canonical.AllocSiteRegistry();
    expect(first).toBeInstanceOf(canonical.AllocSiteRegistry);
    expect(second).toBeInstanceOf(old.AllocSiteRegistry);
    expect(Reflect.ownKeys(first)).toEqual(["sites", "meta", "metadataOrder"]);
    expect(Reflect.ownKeys(second)).toEqual(Reflect.ownKeys(first));
    expect(first.size).toBe(0);
    expect(second.size).toBe(0);
    expect(first.fresh("object", f64)).toBe(0);
    expect(first.size).toBe(1);
    expect(second.size).toBe(0);
    expect(second.fresh("object", f64)).toBe(0);
  });

  it("preserves raw alias chains, retired targets, metadata order and next allocation identity", () => {
    const input = snapshot();
    const registry = canonical.AllocSiteRegistry.fromSnapshot(input);
    expect(registry.captureSnapshot()).toEqual(input);
    expect(registry.resolve(id(0))?.id).toBe(2);
    expect(registry.resolve(id(4))).toBeNull();
    expect(registry.isKnown(id(3))).toBe(true);
    expect(registry.isKnown(id(5))).toBe(false);
    expect(registry.captureSnapshot()).toEqual(input); // Lookup must not flatten the raw evidence.
    expect(registry.liveSites().map((site) => site.id)).toEqual([2]);
    expect(registry.fresh("object", f64)).toBe(5);
    expect(registry.size).toBe(6);
  });

  it("keeps alias collision precedence, unknown-ID no-ops and retirement behavior", () => {
    const registry = new canonical.AllocSiteRegistry();
    const left = registry.fresh("object", f64),
      right = registry.fresh("object", f64);
    registry.annotate(left, "winner", "left");
    registry.annotate(right, "winner", "right");
    registry.annotate(left, "future", undefined);
    registry.alias(left, right);
    expect(registry.read(left, "winner")).toBe("right");
    expect(registry.read(right, "winner")).toBe("right");
    expect(registry.snapshot().metadata[0]!.entries).toEqual([
      ["winner", "right"],
      ["future", undefined],
    ]);
    const before = registry.captureSnapshot();
    registry.alias(id(99), right);
    registry.alias(left, id(99));
    registry.retire(id(99));
    registry.annotate(id(99), "ignored", 1);
    expect(registry.captureSnapshot()).toEqual(before);
    registry.retire(right);
    registry.annotate(left, "ignored", 2);
    expect(registry.resolve(left)).toBeNull();
    expect(registry.read(left, "winner")).toBeUndefined();
    expect(registry.liveSites()).toEqual([]);
    expect(registry.size).toBe(2);
  });

  it("jointly captures and restores graph sharing, explicit undefined and unknown metadata", () => {
    const registry = new canonical.AllocSiteRegistry();
    const sharedType: IrType = { kind: "vec", elementType: f64, nullable: true };
    const shared = { value: 7 };
    const site = registry.fresh("array", sharedType);
    const sparse: unknown[] = new Array(3);
    sparse[1] = undefined;
    sparse[2] = shared;
    const metadata = {
      shared,
      sparse,
      present: undefined,
      values: [-0, NaN, Infinity, -Infinity, 9007199254740993n],
      map: new Map([[shared, new Set([shared])]]),
    };
    registry.annotate(site, "unrecognized-future-namespace", metadata);
    const captured = registry.capturePreparationData({ shared, sharedType });
    const restored = old.AllocSiteRegistry.restorePreparationData(captured.allocations, captured.data);
    const value = restored.allocations.read<typeof metadata>(site, "unrecognized-future-namespace")!;
    expect(restored.allocations.resolve(site)!.type).toBe(restored.data.sharedType);
    expect(value.shared).toBe(restored.data.shared);
    expect(value.sparse[2]).toBe(value.shared);
    expect(value.map.keys().next().value).toBe(value.shared);
    expect(value.map.get(value.shared)?.has(value.shared)).toBe(true);
    expect(Object.hasOwn(value.sparse, 0)).toBe(false);
    expect(Object.hasOwn(value.sparse, 1)).toBe(true);
    expect(Object.hasOwn(value, "present")).toBe(true);
    expect(Object.hasOwn(value, "missing")).toBe(false);
    expect(value.values).toEqual(metadata.values);
    expect(restored.allocations.captureSnapshot()).toEqual(captured.allocations);
    shared.value = 9;
    captured.data.shared.value = 10;
    expect(restored.data.shared.value).toBe(7);
  });

  it("preserves recursive class-cell graph identity and record descriptors without normalization", () => {
    // A data-copy unit fixture, not a prepared program or production caller witness.
    const fields: { name: string; type: unknown }[] = [];
    const shape = { [IR_CLASS_SHAPE_CELL]: true, fields };
    const recursive = { kind: "class", shape };
    fields.push({ name: "next", type: recursive });
    const record = Object.create(null);
    Object.defineProperty(record, "hidden", { value: shape, enumerable: false, writable: false, configurable: false });
    Object.preventExtensions(record);
    const copied = canonical.copyIrPreparationData({ shape, recursive, again: recursive, record });
    expect(copied.shape).not.toBe(shape);
    expect(copied.recursive).toBe(copied.again);
    expect(copied.shape.fields[0]!.type).toBe(copied.recursive);
    expect(copied.shape[IR_CLASS_SHAPE_CELL]).toBe(true);
    expect(copied.record.hidden).toBe(copied.shape);
    expect(Object.getPrototypeOf(copied.record)).toBeNull();
    expect(Object.isExtensible(copied.record)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(copied.record, "hidden")).toEqual({
      value: copied.shape,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  });

  it.each([
    ["normal Date", () => new Date(0)],
    ["invalid Date", () => new Date(NaN)],
    ["erased Date", () => Object.setPrototypeOf(new Date(0), null)],
    ["erased invalid Date", () => Object.setPrototypeOf(new Date(NaN), Object.prototype)],
  ] as const)("retains the exact %s refusal without tag getter execution", (_label, make) => {
    let reads = 0;
    const value = Object.defineProperty(make(), Symbol.toStringTag, {
      get() {
        reads++;
        return "Date";
      },
    });
    for (const copy of [old.copyIrPreparationData, canonical.copyIrPreparationData]) {
      expectFailure(() => copy(value), "invalid preparation data: unsupported Date instance");
    }
    expect(reads).toBe(0);
  });

  it("keeps descriptor rejection non-invoking", () => {
    let reads = 0;
    const input = Object.defineProperty({}, "bad", {
      get() {
        reads++;
        return 1;
      },
    });
    expectFailure(() => canonical.copyIrPreparationData(input), "invalid preparation data: accessor bad");
    expect(reads).toBe(0);
  });

  it.each([
    ["denominator", (input: AllocRegistrySnapshot) => ({ ...input, size: 6 }), "denominator"],
    [
      "alias cycle",
      (input: AllocRegistrySnapshot) => ({
        ...input,
        entries: [{ state: "aliased" as const, to: id(0) }, ...input.entries.slice(1)],
      }),
      "broken/cyclic alias 0",
    ],
    [
      "duplicate metadata",
      (input: AllocRegistrySnapshot) => ({ ...input, metadata: [...input.metadata, input.metadata[0]!] }),
      "foreign/duplicate metadata row",
    ],
  ] as const)("retains the exact malformed %s rejection", (_label, change, detail) => {
    for (const Registry of [old.AllocSiteRegistry, canonical.AllocSiteRegistry]) {
      expect(Registry.fromSnapshot(snapshot()).size).toBe(5);
      expectFailure(() => Registry.fromSnapshot(change(snapshot())), `invalid allocation snapshot: ${detail}`);
    }
  });

  it.each([
    ["method body", (text: string) => text.replace("return this.sites.length;", "return 0;")],
    [
      "private field initialization",
      (text: string) => text.replace("sites: Provenance[] = []", "sites: Provenance[] = new Array()"),
    ],
    ["getter", (text: string) => text.replace("get size(): number", "size(): number")],
    ["extra initializer", (text: string) => text + "\nObject.freeze(AllocSiteRegistry);\n"],
    [
      "documentation",
      (text: string) => text.replace("Descriptor-based, graph-preserving", "Different, graph-preserving"),
    ],
  ] as const)("rejects changed %s in the complete relocation receipt", (_label, change) => {
    verifyCanonical();
    const before = read(newPath),
      after = change(before);
    expect(after).not.toBe(before);
    expect(() => verifyCanonical(after)).toThrow();
  });

  it("loads and exercises only canonical allocation/core leaves in a fresh process", () => {
    const script = `
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
const root = realpathSync(process.cwd()), visited = new Set();
registerHooks({ resolve(specifier, context, next) {
  const result = next(specifier, context);
  if (!result.url.startsWith("file:")) throw Error("forbidden allocation dependency: " + result.url);
  const path = relative(root, realpathSync(fileURLToPath(result.url)));
  if (path !== "src/ir/analysis/alloc-registry.ts" && !path.startsWith("src/ir/core/") && !path.startsWith("src/shared/contracts/") && !path.startsWith("src/wasm/model/")) throw Error("forbidden allocation dependency: " + path);
  visited.add(path); return result;
}});
const { AllocSiteRegistry, copyIrPreparationData } = await import("./src/ir/analysis/alloc-registry.ts");
const registry = new AllocSiteRegistry();
const shared = { kind: "val", val: { kind: "f64" } };
const site = registry.fresh("object", shared);
registry.annotate(site, "future", undefined);
const packet = registry.capturePreparationData({ shared });
const restored = AllocSiteRegistry.restorePreparationData(packet.allocations, packet.data);
assert.equal(restored.allocations.resolve(site).type, restored.data.shared);
assert.equal(restored.allocations.size, 1);
assert.equal(copyIrPreparationData({ value: 42 }).value, 42);
await assert.rejects(import("./src/ir/alloc-registry.ts"), /forbidden allocation dependency: src\\/ir\\/alloc-registry.ts/);
await assert.rejects(import("./src/ir/program.ts"), /forbidden allocation dependency: src\\/ir\\/program.ts/);
assert.ok(visited.has("src/ir/analysis/alloc-registry.ts"));
console.log(JSON.stringify({ visited: [...visited].sort(), sites: restored.allocations.size, forbiddenControls: 2 }));
`;
    const result = spawnSync(
      process.execPath,
      ["--max-old-space-size=2048", "--import", "tsx", "--input-type=module", "-e", script],
      { cwd: root, encoding: "utf8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.sites).toBe(1);
    expect(report.forbiddenControls).toBe(2);
    expect(report.visited).toContain("src/ir/analysis/alloc-registry.ts");
  });
});
