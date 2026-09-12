// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as oldProgram from "../src/ir/program.js";
import * as oldInput from "../src/ir/program-input.js";
import * as data from "../src/ir/program/data.js";
import * as errors from "../src/ir/program/errors.js";
import * as admission from "../src/ir/program/input.js";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import { IR_CLASS_SHAPE_CELL } from "../src/ir/core/types.js";
import { captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { sourcePacket, startupFiles, typedOptions } from "./helpers/typed-program-fixtures.js";
import { createTestIrClassId } from "./helpers/ir-identities.js";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Pinned to 3a119a88b28bb347f4faaaa2146bd991acf61228. Complete bodies,
// documentation, private members and initialization, not just declaration names.
// A's real canonical registry is a mandatory composed prerequisite; no skip,
// historical fallback or synthetic registry implementation is permitted.

interface ClassReceipt {
  readonly name: string;
  readonly members: readonly { readonly name: string; readonly kind: string; readonly hash: string }[];
}
interface MovedReceipt {
  readonly path: string;
  readonly old: string;
  readonly names: readonly string[];
  readonly count: number;
  readonly functions: number;
  readonly initializers: readonly string[];
  readonly classes: readonly ClassReceipt[];
  readonly hash: string;
}
interface RetainedReceipt {
  readonly path: string;
  readonly originalOrder: readonly string[];
  readonly originalCount: number;
  readonly originalFunctions: number;
  readonly originalHash: string;
  readonly count: number;
  readonly functions: number;
  readonly initializers: readonly string[];
  readonly variables: readonly string[];
  readonly classes: readonly ClassReceipt[];
  readonly hash: string;
}

const movedReceipts: readonly MovedReceipt[] = [
  {
    path: "src/ir/program/errors.ts",
    old: "src/ir/program.ts",
    names: ["PreparedIrProgramInvariantCode", "PreparedIrProgramInvariantError"],
    count: 2,
    functions: 0,
    initializers: [],
    classes: [
      {
        name: "PreparedIrProgramInvariantError",
        members: [
          {
            name: "constructor",
            kind: "Constructor",
            hash: "9483380a644ace7188f22a6b3c10cf91a09860b9e50692a190e9fcf244843a9d",
          },
        ],
      },
    ],
    hash: "1414fa3b89f861c80a937b2ef7cb7ac12b715b60def3c9389bf502ee9889d6bf",
  },
  {
    path: "src/ir/program/data.ts",
    old: "src/ir/program.ts",
    names: [
      "FrozenMap",
      "FrozenSet",
      "Object.freeze(FrozenMap.prototype);",
      "Object.freeze(FrozenMap);",
      "Object.freeze(FrozenSet.prototype);",
      "Object.freeze(FrozenSet);",
      "preparedIrReadonlyMap",
      "preparedIrDataMismatch",
      "invalidPreparedData",
      "isRecursiveIrClassShape",
      "immutableCopy",
      "freezePreparedIrValue",
      "hasNativeCollectionState",
      "freezePreparedIrRuntimeValue",
    ],
    count: 14,
    functions: 8,
    initializers: [
      "Object.freeze(FrozenMap.prototype);",
      "Object.freeze(FrozenMap);",
      "Object.freeze(FrozenSet.prototype);",
      "Object.freeze(FrozenSet);",
    ],
    classes: [
      {
        name: "FrozenMap",
        members: [
          {
            name: "#map",
            kind: "PropertyDeclaration",
            hash: "934825a44007e1083e3842efeecdcc225e33cf24e5f8676b31e719704c010835",
          },
          {
            name: "constructor",
            kind: "Constructor",
            hash: "e0d35474a267c2ad76ecabfc34251284b0069fe6513300a3b091eb1fab31f944",
          },
          {
            name: "size",
            kind: "GetAccessor",
            hash: "68f5be8639c52f48d461fade7fd737928644b0daecb70f085c821202d6410804",
          },
          {
            name: "has",
            kind: "MethodDeclaration",
            hash: "f06bf70baa871eb982e600abcc1df2f9441917589fe0e4ec0c69d8e7e9e242f0",
          },
          {
            name: "get",
            kind: "MethodDeclaration",
            hash: "af5f5e707197ca2cc9152c8d3207f3690d2f4c8857ae29f5452139e5194865f3",
          },
          {
            name: "forEach",
            kind: "MethodDeclaration",
            hash: "07761eaaf603abc3239ffd648644cf1fb68a90f7d0b6980f1e30c7b7f48a976d",
          },
          {
            name: "entries",
            kind: "MethodDeclaration",
            hash: "6d2c7e84e4395c72b979ee707ab43888e8360cb38494fbdde839c6d477566bbf",
          },
          {
            name: "keys",
            kind: "MethodDeclaration",
            hash: "9e9554c2cf3838fcc99e970940fe6874e4bf1ab05b37d0398e1d2fb3b442be38",
          },
          {
            name: "values",
            kind: "MethodDeclaration",
            hash: "17dbf4a506cb8fb01020f9be4234c6ebdb5f1ba9e40d5336633a6f8179aeb886",
          },
          {
            name: "[Symbol.iterator]",
            kind: "MethodDeclaration",
            hash: "f039847f1f4949aed89ea510ba6611021143fd576d85c5ca6204668ad761720a",
          },
          {
            name: "[Symbol.toStringTag]",
            kind: "GetAccessor",
            hash: "0f17c6be19c6a3f880fab72e65c12be7a91b57ad9f10df59d5c1f523bb2c2599",
          },
        ],
      },
      {
        name: "FrozenSet",
        members: [
          {
            name: "#set",
            kind: "PropertyDeclaration",
            hash: "dbfb5ca6c2755933a8eb68200e8cf08540de627085c2d14666e98805c548dc10",
          },
          {
            name: "constructor",
            kind: "Constructor",
            hash: "74170d2fefa6c97495f19a46c7553aa8be8c6a3ac55614b572838c11a1e472dc",
          },
          {
            name: "size",
            kind: "GetAccessor",
            hash: "2a2e888b66dbe970fea10ac238e7ec6396480b01de5ca3df7401d25bda2b2343",
          },
          {
            name: "has",
            kind: "MethodDeclaration",
            hash: "b0d382802c5a1bdc6b353fab0c3db547479248dec7a776d648917d8f9177a232",
          },
          {
            name: "forEach",
            kind: "MethodDeclaration",
            hash: "ab295f9ef10740e2ec45abfbce2c7c2daeb0e6ebcfac3cf55d02487ebc141396",
          },
          {
            name: "entries",
            kind: "MethodDeclaration",
            hash: "05500bbdc3c0864bdff35b4737d152d9b6ad468fa3a2f513f462cbf4f8686ae6",
          },
          {
            name: "keys",
            kind: "MethodDeclaration",
            hash: "ca82cbc34454fa90eb0e97e3be2a5bc30b4cb694ce7220c84f396463b352c9fe",
          },
          {
            name: "values",
            kind: "MethodDeclaration",
            hash: "42129d4bac2fb77aaa2a6cd0502455ecc044f430d47aec26b1e3243c9bc93178",
          },
          {
            name: "[Symbol.iterator]",
            kind: "MethodDeclaration",
            hash: "62340f669ccb787797a2e93d09500d9fffa142e500182824abf406312a4c88b9",
          },
          {
            name: "[Symbol.toStringTag]",
            kind: "GetAccessor",
            hash: "b59f34fa700e9b5321335c9c6a80f2ce8e9967866a3962063425b3a38ee5bd92",
          },
        ],
      },
    ],
    hash: "f335ccff8843bce84f00070df0f3afb023f748b8c21dbf14b80fc0a854181d0e",
  },
  {
    path: "src/ir/program/input.ts",
    old: "src/ir/program-input.ts",
    names: ["invalid", "fields", "dense", "assertGlobalStorage", "ownTypedIrProgramInput", "ownTypedIrProgramOptions"],
    count: 6,
    functions: 6,
    initializers: [],
    classes: [],
    hash: "33bb1e427b4290da77315ae6657e146aa87d83ea2d4e0bf0e243f23ef6185bb7",
  },
] as const;

const retainedReceipts: readonly RetainedReceipt[] = [
  {
    path: "src/ir/program.ts",
    originalOrder: [
      "PreparedIrBackendOptions",
      "acceptedPreparedIrProgramBrand",
      "AcceptedPreparedIrProgram",
      "PreparedIrBackendAcceptance",
      "EmittedPreparedIrProgram",
      "preparedIrProgramOwner",
      "preparedIrProgramAbiLookup",
      "PreparedIrCandidateRoute",
      "PreparedIrEmitter",
      "PreparedIrProgramInvariantCode",
      "PreparedIrProgramInvariantError",
      "PreparedIrAssertedOptimizationEvidence",
      "PreparedIrAssertedBackendLegality",
      "PreparedIrCandidateBase",
      "PreparedIrIrCandidate",
      "PreparedIrDirectCandidate",
      "PreparedIrInvariantCandidate",
      "PreparedIrUnitCandidate",
      "PreparedIrComponentCandidate",
      "PreparedIrSupportIntentKind",
      "PreparedIrSupportIntentCandidate",
      "PreparedIrAllocationKind",
      "PreparedIrAllocationCandidate",
      "PreparedIrProvenanceRole",
      "PreparedIrProvenanceCandidate",
      "PreparedIrCandidateAbiSnapshot",
      "PreparedIrEmissionLedgerEntry",
      "PreparedIrStagedBody",
      "PreparedIrCandidatePublication",
      "PreparedIrCandidateProgram",
      "FrozenMap",
      "FrozenSet",
      "Object.freeze(FrozenMap.prototype);",
      "Object.freeze(FrozenMap);",
      "Object.freeze(FrozenSet.prototype);",
      "Object.freeze(FrozenSet);",
      "preparedIrReadonlyMap",
      "preparedIrDataMismatch",
      "invalidPreparedData",
      "isRecursiveIrClassShape",
      "immutableCopy",
      "freezePreparedIrValue",
      "hasNativeCollectionState",
      "freezePreparedIrRuntimeValue",
      "MutableLedgerEntry",
      "EMISSION_TRANSACTION_CAPABILITY",
      "PreparedIrEmissionTransaction",
      "Object.freeze(PreparedIrEmissionTransaction.prototype);",
      "Object.freeze(PreparedIrEmissionTransaction);",
      "PreparedIrCandidateProgramInput",
      "ownCandidate",
      "expectedCandidateRoute",
      "createPreparedIrCandidateProgram",
    ],
    originalCount: 53,
    originalFunctions: 13,
    originalHash: "0cecfde6532cfec329507200e65f8dde5618e39db095de2cca271eca64b67ae9",
    count: 37,
    functions: 5,
    initializers: [
      "Object.freeze(PreparedIrEmissionTransaction.prototype);",
      "Object.freeze(PreparedIrEmissionTransaction);",
    ],
    variables: [
      "declare const acceptedPreparedIrProgramBrand: unique symbol;",
      'const EMISSION_TRANSACTION_CAPABILITY = Symbol("PreparedIrProgram.beginEmission");',
    ],
    classes: [
      {
        name: "PreparedIrEmissionTransaction",
        members: [
          {
            name: "#program",
            kind: "PropertyDeclaration",
            hash: "dba18574c3751673a89efc05e2fae7f951c1302797083ca44e1849e6178a1f00",
          },
          {
            name: "#staged",
            kind: "PropertyDeclaration",
            hash: "b30ff113f0c2b6bb4e680336ad3f881bede48d08243c9e062b5dde6c3e0622a3",
          },
          {
            name: "#ledger",
            kind: "PropertyDeclaration",
            hash: "8aed11920cd1500e48a4a5e17fb2c990d0860872e4f3e3187a0fce5b276dbafa",
          },
          {
            name: "#state",
            kind: "PropertyDeclaration",
            hash: "92c305dc93aac0a93a9991f530bead630ad2f9960db920f1add47c736ecaf7c5",
          },
          {
            name: "#publication",
            kind: "PropertyDeclaration",
            hash: "3f5aab0f9828b4df66057ace35639f539190bf93dccc55cbfd48cddfb4a0c605",
          },
          {
            name: "constructor",
            kind: "Constructor",
            hash: "bcbc3daf7b13105c14c32b28f9ffd4492f2fa08e55a2cbd1e9d582471b4ede12",
          },
          {
            name: "open",
            kind: "MethodDeclaration",
            hash: "9f6f14e8c8b202e18d2392d266bb64d0000ea1c281c3123ac42a652889473ab5",
          },
          {
            name: "publication",
            kind: "GetAccessor",
            hash: "161ccd4227e90933bd7b166b704071b111b2a0b3b9c84a2a135ffc06290b4c51",
          },
          {
            name: "ledger",
            kind: "GetAccessor",
            hash: "15966c020dab863d2d6d688318273b910a04f5ad1ce7401f4decd80bb0795d47",
          },
          {
            name: "emitIr",
            kind: "MethodDeclaration",
            hash: "90d8b0afb1a0df04924815f9632eb4ff0657f69115951ff710a50d2e2c6ec2fd",
          },
          {
            name: "emitDirect",
            kind: "MethodDeclaration",
            hash: "6f498ce32081c4753d1b964d963fc9407a7fb69e3bb5ddbc4fb354acd767319e",
          },
          {
            name: "failEmission",
            kind: "MethodDeclaration",
            hash: "fdb4f7b414feeb49e5c5d58d67e236f008b4d3d7cc72083b3b92f6640dfa4205",
          },
          {
            name: "publish",
            kind: "MethodDeclaration",
            hash: "0432ad932492a98a9d990114c350f8687b1201b23a052167fb20606363937863",
          },
          {
            name: "#stage",
            kind: "MethodDeclaration",
            hash: "e97b9065b4852a189346277138a1d1e1ff833e3ae1af74ea87bb7c73075184c8",
          },
          {
            name: "#assertDirection",
            kind: "MethodDeclaration",
            hash: "1119447fdf29191041aafcc064cbdac127a2c448af8e02fea939b50b40abafde",
          },
          {
            name: "#assertOpen",
            kind: "MethodDeclaration",
            hash: "4269ea050a71eaa6f804cdbaedc04b12e5c07bf8919c363f4efdc7756e2ec681",
          },
          {
            name: "#abort",
            kind: "MethodDeclaration",
            hash: "f1b08bb7aba805066b97ec49acc6211582fb1df3a60b75d573a5b2928c5c5ca6",
          },
          {
            name: "#ledgerSnapshot",
            kind: "MethodDeclaration",
            hash: "b7ae535d33b7f27892b3a5ce8981bd8e11b8531a061e122227cc172c998e6c32",
          },
        ],
      },
    ],
    hash: "93e2b0494cde4895ae9f9be225a67579b580cb78b6c895ca9d64afab6229bc70",
  },
  {
    path: "src/ir/program-input.ts",
    originalOrder: [
      "invalid",
      "fields",
      "dense",
      "assertGlobalStorage",
      "ownTypedIrProgramInput",
      "ownTypedIrProgramOptions",
    ],
    originalCount: 6,
    originalFunctions: 6,
    originalHash: "33bb1e427b4290da77315ae6657e146aa87d83ea2d4e0bf0e243f23ef6185bb7",
    count: 0,
    functions: 0,
    initializers: [],
    variables: [],
    classes: [],
    hash: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  },
] as const;

function parse(path: string, source = read(path)) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  expect((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics).toEqual([]);
  return file;
}
function statements(file: ts.SourceFile) {
  return file.statements.filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node));
}
function key(node: ts.Statement): string {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node)
  )
    return node.name?.text ?? node.getText();
  if (ts.isVariableStatement(node)) return node.declarationList.declarations[0]!.name.getText();
  return node.getText();
}
function preservedText(node: ts.Statement, canonical = false) {
  let text = node
    .getFullText()
    .trim()
    .replace(/^\/\/ Copyright[^\n]*\n\s*/, "");
  if (canonical && key(node) === "invalidPreparedData") {
    expect(text.startsWith("export function ")).toBe(true);
    text = text.replace(/^export /, "");
  }
  return text;
}
function memberRows(node: ts.ClassDeclaration) {
  return node.members.map((member) => ({
    name: ts.isConstructorDeclaration(member) ? "constructor" : member.name?.getText(),
    kind: ts.SyntaxKind[member.kind],
    hash: digest(member.getFullText().trim()),
  }));
}

const dataFunctions = [
  "preparedIrReadonlyMap",
  "preparedIrDataMismatch",
  "freezePreparedIrValue",
  "freezePreparedIrRuntimeValue",
] as const;

describe("#3518 program ownership implementation seam", () => {
  it.each(movedReceipts)("preserves complete $path bodies, classes, private fields and initialization", (receipt) => {
    const nodes = statements(parse(receipt.path));
    expect(nodes.map(key)).toEqual(receipt.names);
    expect(nodes).toHaveLength(receipt.count);
    expect(nodes.filter(ts.isFunctionDeclaration)).toHaveLength(receipt.functions);
    expect(nodes.filter(ts.isExpressionStatement).map((node) => node.getText())).toEqual(receipt.initializers);
    expect(nodes.filter(ts.isClassDeclaration).map((node) => ({ name: key(node), members: memberRows(node) }))).toEqual(
      receipt.classes,
    );
    const rows = nodes.map((node) => preservedText(node, true));
    expect(digest(rows)).toBe(receipt.hash);
    // Nonempty actual-body controls prevent silent deletion or initialization
    // removal from being reported as preserved.
    expect(rows.length).toBeGreaterThan(0);
    expect(digest(rows.slice(1))).not.toBe(receipt.hash);
    expect(digest([...rows.slice(1), rows[0]])).not.toBe(receipt.hash);
    expect(digest(rows.map((row, i) => (i ? row : row + "\nchanged")))).not.toBe(receipt.hash);
  });

  it.each(retainedReceipts)(
    "reconstructs $path in its original order without dropping retained statements",
    (receipt) => {
      const nodes = statements(parse(receipt.path));
      expect(nodes).toHaveLength(receipt.count);
      expect(nodes.filter(ts.isFunctionDeclaration)).toHaveLength(receipt.functions);
      expect(nodes.filter(ts.isExpressionStatement).map((node) => node.getText())).toEqual(receipt.initializers);
      expect(nodes.filter(ts.isVariableStatement).map((node) => node.getText())).toEqual(receipt.variables);
      expect(
        nodes.filter(ts.isClassDeclaration).map((node) => ({ name: key(node), members: memberRows(node) })),
      ).toEqual(receipt.classes);
      expect(digest(nodes.map((node) => preservedText(node)))).toBe(receipt.hash);
      const moved = movedReceipts
        .filter((row) => row.old === receipt.path)
        .flatMap((row) => statements(parse(row.path)));
      const combined = [...nodes, ...moved];
      expect(combined).toHaveLength(receipt.originalCount);
      expect(combined.filter(ts.isFunctionDeclaration)).toHaveLength(receipt.originalFunctions);
      expect(new Set(combined.map(key)).size).toBe(combined.length);
      const byKey = new Map(combined.map((node) => [key(node), node]));
      const reconstructed = receipt.originalOrder.map((name) => {
        const node = byKey.get(name);
        if (!node) throw Error("missing original statement " + name);
        return preservedText(node, moved.includes(node));
      });
      expect(digest(reconstructed)).toBe(receipt.originalHash);
    },
  );

  it.each(dataFunctions)("forwards the exact historical %s function object", (name) => {
    expect(oldProgram[name]).toBe(data[name]);
  });

  it("forwards both admission functions and the same invariant constructor", () => {
    expect(oldInput.ownTypedIrProgramInput).toBe(admission.ownTypedIrProgramInput);
    expect(oldInput.ownTypedIrProgramOptions).toBe(admission.ownTypedIrProgramOptions);
    expect(oldProgram.PreparedIrProgramInvariantError).toBe(errors.PreparedIrProgramInvariantError);
    const error = new errors.PreparedIrProgramInvariantError("invalid-prepared-data", "owned evidence");
    expect(error).toBeInstanceOf(oldProgram.PreparedIrProgramInvariantError);
    expect(error).toBeInstanceOf(Error);
    expect([error.name, error.code, error.message]).toEqual([
      "PreparedIrProgramInvariantError",
      "invalid-prepared-data",
      "owned evidence",
    ]);
    expect(Object.hasOwn(oldProgram, "invalidPreparedData")).toBe(false);
    expect(Object.keys(data).sort()).toEqual([...dataFunctions, "invalidPreparedData"].sort());
    expect(Object.keys(admission).sort()).toEqual(["ownTypedIrProgramInput", "ownTypedIrProgramOptions"]);
    expect(Object.keys(errors)).toEqual(["PreparedIrProgramInvariantError"]);
  });

  it("keeps all four collection freezes and the old emission authority separate", () => {
    expect(movedReceipts.reduce((n, row) => n + row.count, 0)).toBe(22);
    expect(movedReceipts.reduce((n, row) => n + row.functions, 0)).toBe(14);
    expect(movedReceipts.flatMap((row) => row.classes).flatMap((row) => row.members)).toHaveLength(22);
    const file = parse("src/ir/program.ts");
    expect(
      file.statements
        .filter(ts.isImportDeclaration)
        .some(
          (node) => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./program-validation.js",
        ),
    ).toBe(true);
    const text = read("src/ir/program/data.ts");
    expect(text).not.toContain("EMISSION_TRANSACTION_CAPABILITY");
    expect(text).not.toContain("assertPreparedIrProgram");
    expect(text).not.toContain("PreparedIrEmissionTransaction");
    const expectedImports = [
      [],
      ["../core/types.js", "./errors.js"],
      ["../analysis/alloc-registry.js", "./data.js", "./errors.js", "./input-contracts.js"],
    ];
    for (const [index, row] of movedReceipts.entries()) {
      expect(
        parse(row.path)
          .statements.filter(ts.isImportDeclaration)
          .map((node) => {
            if (!ts.isStringLiteral(node.moduleSpecifier)) throw Error("nonliteral canonical import");
            return node.moduleSpecifier.text;
          }),
      ).toEqual(expectedImports[index]);
      expect(read(row.path)).not.toMatch(/process\.env/);
    }
    expect(read("src/ir/program/input.ts")).toContain('from "../analysis/alloc-registry.js"');
  });

  it("preserves FrozenMap construction, private state, getters, all iteration surfaces and callback receiver", () => {
    const first = { value: 1 },
      second = { value: 2 };
    const entries: [string, typeof first][] = [
      ["b", first],
      ["a", second],
    ];
    const map = data.preparedIrReadonlyMap(entries);
    const legacy = oldProgram.preparedIrReadonlyMap(entries);
    entries.reverse();
    expect(map.size).toBe(2);
    expect(map.has("b")).toBe(true);
    expect(map.has("missing")).toBe(false);
    expect(map.get("b")).toBe(first);
    expect(map.get("missing")).toBeUndefined();
    expect([...map.entries()]).toEqual([
      ["b", first],
      ["a", second],
    ]);
    expect([...map.keys()]).toEqual(["b", "a"]);
    expect([...map.values()]).toEqual([first, second]);
    expect([...map]).toEqual([...map.entries()]);
    const receiver = { calls: [] as string[] };
    map.forEach(function (this: typeof receiver, value, key, owner) {
      expect(this).toBe(receiver);
      expect(owner).toBe(map);
      expect(value).toBe(map.get(key));
      this.calls.push(key);
    }, receiver);
    expect(receiver.calls).toEqual(["b", "a"]);
    const prototype = Object.getPrototypeOf(map);
    expect(prototype).toBe(Object.getPrototypeOf(legacy));
    expect(Object.isFrozen(prototype)).toBe(true);
    expect(Object.isFrozen(prototype.constructor)).toBe(true);
    expect(Object.isFrozen(map)).toBe(true);
    expect(Object.prototype.toString.call(map)).toBe("[object FrozenMap]");
    expect(Reflect.ownKeys(map)).toEqual([]);
    expect("set" in map).toBe(false);
    expect(() => Map.prototype.set.call(map, "x", first)).toThrow(TypeError);
  });

  it("preserves FrozenSet private state and every read surface without exposing mutation", () => {
    const set = data.freezePreparedIrValue(new Set(["b", "a", "b"])) as ReadonlySet<string>;
    const legacy = oldProgram.freezePreparedIrValue(new Set(["b", "a"])) as ReadonlySet<string>;
    expect(set.size).toBe(2);
    expect(set.has("a")).toBe(true);
    expect(set.has("missing")).toBe(false);
    expect([...set.entries()]).toEqual([
      ["b", "b"],
      ["a", "a"],
    ]);
    expect([...set.keys()]).toEqual(["b", "a"]);
    expect([...set.values()]).toEqual(["b", "a"]);
    expect([...set]).toEqual(["b", "a"]);
    const receiver = { calls: [] as string[] };
    set.forEach(function (this: typeof receiver, value, again, owner) {
      expect(this).toBe(receiver);
      expect(again).toBe(value);
      expect(owner).toBe(set);
      this.calls.push(value);
    }, receiver);
    expect(receiver.calls).toEqual(["b", "a"]);
    const prototype = Object.getPrototypeOf(set);
    expect(prototype).toBe(Object.getPrototypeOf(legacy));
    expect(Object.isFrozen(prototype)).toBe(true);
    expect(Object.isFrozen(prototype.constructor)).toBe(true);
    expect(Object.isFrozen(set)).toBe(true);
    expect(Reflect.ownKeys(set)).toEqual([]);
    expect(Object.prototype.toString.call(set)).toBe("[object FrozenSet]");
    expect("add" in set).toBe(false);
    expect(() => Set.prototype.add.call(set, "x")).toThrow(TypeError);
  });

  it("retains immutable copying and exact data comparison including explicit undefined and ordered collections", () => {
    const value = {
      absent: undefined,
      values: [NaN, -0, 7n],
      map: new Map([
        ["b", 2],
        ["a", 1],
      ]),
      set: new Set([2, 1]),
    };
    Object.defineProperty(value, "hidden", { value: undefined, enumerable: false });
    const owned = data.freezePreparedIrValue(value) as typeof value;
    expect(owned).not.toBe(value);
    expect(Object.isFrozen(owned)).toBe(true);
    expect(Object.isFrozen(owned.values)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(owned, "hidden")).toEqual({
      value: undefined,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    expect(data.preparedIrDataMismatch(value, owned)).toBeUndefined();
    expect(data.preparedIrDataMismatch({ x: undefined }, {})).toBe("$root (field population)");
    expect(data.preparedIrDataMismatch(-0, 0)).toBe("$root");
    expect(data.preparedIrDataMismatch(NaN, NaN)).toBeUndefined();
    expect(
      data.preparedIrDataMismatch(
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
        owned.map,
      ),
    ).toContain(".entries");
    expect(data.preparedIrDataMismatch(new Set([1, 2]), owned.set)).toContain(".values");
    expect(data.preparedIrDataMismatch([], {})).toBe("$root (array kind)");
    expect(data.preparedIrDataMismatch(new Date(0), {})).toBe("$root (non-data object)");
  });

  it("keeps recursive class cells and in-place runtime identity rather than creating a second authority", () => {
    const fields: { name: string; type: { kind: "class"; shape: object } }[] = [];
    const shape = {
      [IR_CLASS_SHAPE_CELL]: true,
      classId: createTestIrClassId("program-ownership-recursion", 0),
      className: "Node",
      fields,
      methods: [],
      constructorParams: [],
    };
    fields.push({ name: "next", type: { kind: "class", shape } });
    const copied = data.freezePreparedIrValue(shape) as typeof shape;
    expect(copied).not.toBe(shape);
    expect(copied.fields[0]!.type.shape).toBe(copied);
    expect(copied[IR_CLASS_SHAPE_CELL]).toBe(true);
    expect(data.preparedIrDataMismatch(shape, copied)).toBeUndefined();
    const shared = { absent: undefined };
    const attachment = {
      plan: shared,
      manifest: shared,
      layouts: [shape],
      providers: data.preparedIrReadonlyMap([["p", shared]]),
    };
    expect(data.freezePreparedIrRuntimeValue(attachment)).toBe(attachment);
    expect(attachment.plan).toBe(shared);
    expect(attachment.manifest).toBe(shared);
    expect(attachment.providers.get("p")).toBe(shared);
    expect(attachment.layouts[0]).toBe(shape);
    expect(shape.fields[0]!.type.shape).toBe(shape);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shape)).toBe(true);
    const cycle: { next?: object } = {};
    cycle.next = cycle;
    expect(() => data.freezePreparedIrValue(cycle)).toThrow(/acyclic outside exact IR class shapes/);
    expect(() => data.freezePreparedIrRuntimeValue(cycle)).toThrow(/acyclic outside exact IR class shapes/);
    expect(() => data.freezePreparedIrRuntimeValue({ map: new Map() })).toThrow(/mutable or executable context state/);
    expect(() => data.freezePreparedIrValue({ run() {} })).toThrow(errors.PreparedIrProgramInvariantError);
  });

  it("admits actual source/startup ownership and returns a detached transaction", () => {
    const { packet } = sourcePacket(startupFiles);
    expect(packet.inventory.sources).toHaveLength(2);
    expect(packet.inventory.terminalUnits).toHaveLength(3);
    expect(packet.globals).toHaveLength(2);
    const owned = admission.ownTypedIrProgramInput(packet);
    expect(owned.allocations).toBeInstanceOf(AllocSiteRegistry);
    expect(owned.input).not.toBe(packet);
    expect(owned.input.ir).not.toBe(packet.ir);
    expect(data.preparedIrDataMismatch(owned.input, packet)).toBeUndefined();
    const [global, ...rest] = packet.globals;
    if (!global) throw Error("missing source global");
    const reader = packet.ir.functions.find((fn) => fn.name === "read");
    if (!reader) throw Error("missing real non-startup owner control");
    expect(() =>
      admission.ownTypedIrProgramInput({
        ...packet,
        globals: [{ ...global, identity: { ...global.identity, storageOwnerUnitId: reader.unitId } }, ...rest],
      }),
    ).toThrow(/exact inventoried source storage owner/);
  });

  it("jointly preserves IR/site/metadata sharing, raw aliases, retirement, row order and next allocation id", () => {
    const { source } = sourcePacket();
    const fn = source.ir.functions.find((fn) => fn.params.length);
    if (!fn) throw Error("missing real source parameter");
    const type = fn.params[0]!.type;
    const ids = Array.from({ length: 5 }, () => source.allocations.fresh("object", type));
    const [first, second, target, retired, other] = ids;
    if (
      first === undefined ||
      second === undefined ||
      target === undefined ||
      retired === undefined ||
      other === undefined
    )
      throw Error("missing allocation controls");
    source.allocations.alias(first, second);
    source.allocations.alias(second, target);
    source.allocations.retire(retired);
    source.allocations.annotate(target, "future", { type, owner: fn, absent: undefined });
    source.allocations.annotate(target, "explicit-undefined", undefined);
    source.allocations.annotate(other, "second-row", undefined);
    const packet = captureTypedIrProgramInput(source);
    const ordered = {
      ...packet,
      allocations: { ...packet.allocations, metadata: [...packet.allocations.metadata].reverse() },
    };
    const owned = admission.ownTypedIrProgramInput(ordered);
    const ownedFn = owned.input.ir.functions.find((candidate) => candidate.unitId === fn.unitId)!;
    expect(owned.allocations.resolve(first)).toBe(owned.allocations.resolve(target));
    expect(owned.allocations.resolve(second)).toBe(owned.allocations.resolve(target));
    expect(owned.allocations.resolve(retired)).toBeNull();
    expect(owned.allocations.resolve(target)!.type).toBe(ownedFn.params[0]!.type);
    const metadata = owned.allocations.read<{ type: unknown; owner: unknown; absent: undefined }>(target, "future")!;
    expect(metadata.owner).toBe(ownedFn);
    expect(metadata.type).toBe(ownedFn.params[0]!.type);
    expect(Object.hasOwn(metadata, "absent")).toBe(true);
    expect(owned.allocations.captureSnapshot()).toEqual(ordered.allocations);
    expect(owned.allocations.captureSnapshot().metadata.map((row) => row.id)).toEqual(
      ordered.allocations.metadata.map((row) => row.id),
    );
    expect(owned.allocations.fresh("object", type)).toBe(packet.allocations.size);
    expect(source.allocations.size).toBe(packet.allocations.size);
    // Unknown namespaces are preserved by admission; parent retains the
    // separate final semantic-rejection controls. This is not allocation execution.
  });

  it("retains exact resolved controls and refuses missing controls or policy populations", () => {
    const owned = admission.ownTypedIrProgramOptions(typedOptions);
    expect(owned).not.toBe(typedOptions);
    expect(owned).toEqual(typedOptions);
    expect(() => admission.ownTypedIrProgramOptions({ ...typedOptions, controls: {} } as never)).toThrow(
      /missing or foreign fields/,
    );
    expect(() =>
      admission.ownTypedIrProgramOptions({
        ...typedOptions,
        controls: { ...typedOptions.controls, ownership: undefined },
      } as never),
    ).toThrow(/complete explicit controls/);
    expect(() => admission.ownTypedIrProgramOptions({ ...typedOptions, runtimePolicies: [] })).toThrow(
      /omit the source preparation policy/,
    );
    expect(() =>
      admission.ownTypedIrProgramOptions({
        ...typedOptions,
        runtimePolicies: [typedOptions.policy, typedOptions.policy],
      }),
    ).toThrow("runtime policies duplicate a backend/target pair or omit the source preparation policy");
  });
});
