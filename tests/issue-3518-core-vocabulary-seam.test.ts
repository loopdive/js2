// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as vocabulary from "../src/ir/core/intrinsic-vocabulary.js";
import * as intrinsics from "../src/ir/intrinsics.js";
import * as intents from "../src/ir/core/async-intents.js";
import * as providers from "../src/ir/async-runtime-providers.js";
import {
  assertUniqueCurrentIrCountedStringAppendSites,
  createIrCountedStringAppendSiteId,
  irCountedStringAppendSiteIdIsCurrent,
  parseIrCountedStringAppendSiteId,
} from "../src/ir/counted-string-append-provenance.js";
import type {
  IrCountedStringAppendSiteId,
  IrCountedStringAppendSiteIdentity,
  IrCountedStringAppendSiteClaim,
} from "../src/shared/contracts/ir-counted-string-identity.js";
import { createIrSourceId, createIrUnitId } from "../src/ir/identity.js";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
function parse(path: string, text = read(path)) {
  const tree = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  expect((tree as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics).toEqual([]);
  return tree;
}
function declarations(tree: ts.SourceFile) {
  return tree.statements.flatMap((node) => {
    const names = ts.isVariableStatement(node)
      ? node.declarationList.declarations.map((declaration) => declaration.name.getText(tree))
      : (ts.isTypeAliasDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node)) &&
          node.name
        ? [node.name.getText(tree)]
        : [];
    return names.map((name) => [name, node.getText(tree)] as const);
  });
}
const digest = (rows: readonly (readonly string[])[]) =>
  createHash("sha256").update(JSON.stringify(rows)).digest("hex");

// Exact declaration-text receipts from acfd3e37b8765c4c4788c1fa94718d62c60e473c
// (PR 5742). Tests need no historical Git objects or new baseline writer.
// Retained rows include private state, all functions/classes and catalog data.
const moves = [
  {
    old: "src/ir/intrinsics.ts",
    canonical: "src/ir/core/intrinsic-vocabulary.ts",
    specifier: "./core/intrinsic-vocabulary.js",
    moved: 12,
    movedHash: "12c95d79325da6795c51cba7511d4e80b33c6138365b7ee104f9e31d82dab8b4",
    retained: 44,
    retainedHash: "6e7eec6bbaef010d054f9f0309cc16f638d35cca139f8b11b85ed456592b4ba6",
  },
  {
    old: "src/ir/async-runtime-providers.ts",
    canonical: "src/ir/core/async-intents.ts",
    specifier: "./core/async-intents.js",
    moved: 3,
    movedHash: "d8a4e132d226ef7959c01860234a0a35006e1c8b274fdc7939184e3d6f64846e",
    retained: 36,
    retainedHash: "258e2df650b4c63de0b980af3cf246be6aa394f6dcb852a026e63fd8b5b31e58",
  },
  {
    old: "src/ir/string-runtime.ts",
    canonical: "src/ir/core/string-types.ts",
    specifier: "./core/string-types.js",
    moved: 2,
    movedHash: "892c6b176ce446d8b0e9f9f61616e822b56b6cf227e5442a1ae0fc4f593adfb5",
    retained: 31,
    retainedHash: "5c81a555626ad6b994806f135f4da8a0d406974245bed7058a8cce0e193417dd",
  },
  {
    old: "src/ir/counted-string-append-provenance.ts",
    canonical: "src/shared/contracts/ir-counted-string-identity.ts",
    specifier: "../shared/contracts/ir-counted-string-identity.js",
    moved: 4,
    movedHash: "3bca63c8b7bc0b8bac48a30aba9af5dfdef3fd9a25fb95d18a5e573adc7cc333",
    retained: 32,
    retainedHash: "43fee73f4c73e2e294c021dd025513a34f2552f58a65f7b3912d2f1b044f07aa",
  },
];
const intrinsicValues = [
  "PURE_MATH_INTRINSIC_IDS",
  "NUMERIC_COERCION_INTRINSIC_IDS",
  "NUMBER_BOUNDARY_INTRINSIC_IDS",
  "BOOLEAN_BOUNDARY_INTRINSIC_IDS",
  "EXTERN_BOUNDARY_INTRINSIC_IDS",
  "INTRINSIC_IDS",
  "INTRINSIC_SIGNATURE_VERSION",
] as const;

function moduleReferences(tree: ts.SourceFile) {
  const references: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier) ||
      ts.isImportTypeNode(node) ||
      ts.isImportEqualsDeclaration(node) ||
      (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")))
    )
      references.push(node.getText(tree));
    ts.forEachChild(node, visit);
  };
  visit(tree);
  expect(tree.referencedFiles).toEqual([]);
  expect(tree.typeReferenceDirectives).toEqual([]);
  return references;
}

function identity(): IrCountedStringAppendSiteIdentity {
  const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "vocabulary.ts" });
  return Object.freeze({
    sourceId,
    ownerUnitId: createIrUnitId({ sourceId, lexicalOwnerId: null, kind: "top-level-function", ordinal: 0 }),
    loopStart: 17,
    loopEnd: 43,
  });
}

describe("#3518 canonical core vocabulary seam", () => {
  it.each(moves)("moves exactly $moved declarations from $old and preserves everything retained", (move) => {
    const canonical = declarations(parse(move.canonical));
    const retained = declarations(parse(move.old));
    expect(canonical).toHaveLength(move.moved);
    expect(new Set(canonical.map(([name]) => name)).size).toBe(move.moved);
    expect(digest(canonical)).toBe(move.movedHash);
    expect(retained).toHaveLength(move.retained);
    expect(digest(retained)).toBe(move.retainedHash);
    expect(retained.filter(([name]) => canonical.some(([movedName]) => movedName === name))).toEqual([]);
    const publicNames = canonical.map(([name]) => name).filter((name) => name !== "irCountedStringAppendSiteIdBrand");
    const forwarded = parse(move.old).statements.flatMap((node) => {
      if (
        !ts.isExportDeclaration(node) ||
        !node.moduleSpecifier ||
        node.moduleSpecifier.getText() !== JSON.stringify(move.specifier)
      )
        return [];
      expect(node.exportClause && ts.isNamedExports(node.exportClause)).toBe(true);
      if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return [];
      return node.exportClause.elements.map((element) => {
        expect(element.propertyName?.text ?? element.name.text).toBe(element.name.text);
        return element.name.text;
      });
    });
    expect(forwarded.sort()).toEqual(publicNames.sort());
  });

  it.each(intrinsicValues)("re-exports the single canonical %s runtime value", (name) => {
    expect(intrinsics[name]).toBe(vocabulary[name]);
    if (Array.isArray(vocabulary[name])) expect(Object.isFrozen(vocabulary[name])).toBe(true);
  });

  it("preserves closed intrinsic tuple order, existing guard and definition consumers", () => {
    expect(Object.keys(vocabulary).sort()).toEqual([...intrinsicValues].sort());
    expect(vocabulary.PURE_MATH_INTRINSIC_IDS).toHaveLength(33);
    expect(vocabulary.INTRINSIC_IDS).toHaveLength(38);
    expect(new Set(vocabulary.INTRINSIC_IDS).size).toBe(38);
    expect(vocabulary.INTRINSIC_IDS).toEqual([
      ...vocabulary.NUMERIC_COERCION_INTRINSIC_IDS,
      ...vocabulary.NUMBER_BOUNDARY_INTRINSIC_IDS,
      ...vocabulary.BOOLEAN_BOUNDARY_INTRINSIC_IDS,
      ...vocabulary.EXTERN_BOUNDARY_INTRINSIC_IDS,
      ...vocabulary.PURE_MATH_INTRINSIC_IDS,
    ]);
    for (const id of vocabulary.INTRINSIC_IDS) {
      expect(intrinsics.isIntrinsicId(id)).toBe(true);
      expect(intrinsics.INTRINSIC_DEFINITIONS[id].id).toBe(id);
      expect(intrinsics.INTRINSIC_DEFINITIONS[id].signature.version).toBe(vocabulary.INTRINSIC_SIGNATURE_VERSION);
    }
    for (const invalid of ["math.random", "math.reduce-trig", "host.math.pow", ""])
      expect(intrinsics.isIntrinsicId(invalid)).toBe(false);
    expect(intrinsics.PURE_MATH_RUNTIME_FEATURES).toContain("math.reduce-trig");
  });

  it("retains the verbatim Math certification quote and canonical math.pow tuple evidence", () => {
    const source = read(moves[0]!.canonical);
    expect(source).toContain("exact-arity f64 Math surface certified by");
    expect(source).toContain('"math.pow",');
    expect(vocabulary.PURE_MATH_INTRINSIC_IDS).toContain("math.pow");
  });

  it.each(["ASYNC_RUNTIME_FEATURES", "ASYNC_OPTIONAL_RUNTIME_FEATURES"] as const)(
    "keeps %s frozen, shared and consumed by the existing feature guard",
    (name) => {
      expect(providers[name]).toBe(intents[name]);
      expect(Object.isFrozen(intents[name])).toBe(true);
      for (const feature of intents[name]) expect(providers.isAsyncRuntimeFeature(feature)).toBe(true);
    },
  );

  it("does not confuse semantic async features with provider IDs or capability IDs", () => {
    expect(Object.keys(intents).sort()).toEqual(["ASYNC_OPTIONAL_RUNTIME_FEATURES", "ASYNC_RUNTIME_FEATURES"]);
    expect(intents.ASYNC_RUNTIME_FEATURES).toHaveLength(7);
    expect(intents.ASYNC_OPTIONAL_RUNTIME_FEATURES).toEqual(["value.undefined", "promise.number.bridge"]);
    for (const invalid of ["native.scheduler.enqueue", "host.scheduler.enqueue", "async.promise.react", ""]) {
      expect(providers.isAsyncRuntimeFeature(invalid)).toBe(false);
    }
  });

  it("has no upward module edges: three import-free leaves and only canonical F0 identity/source-origin", () => {
    for (const move of moves.slice(0, 3)) expect(moduleReferences(parse(move.canonical))).toEqual([]);
    expect(moduleReferences(parse(moves[3]!.canonical))).toEqual([
      'import type { IrSourceId, IrUnitId } from "./ir-identity.js";',
    ]);
    expect(moduleReferences(parse("src/shared/contracts/ir-identity.ts"))).toEqual([
      'import type { CompilerSourceProducer } from "./source-origin.js";',
    ]);
    expect(moduleReferences(parse("src/shared/contracts/source-origin.ts"))).toEqual([]);
  });

  it("loads all four canonical leaves with old facades and providers barred in a fresh process", () => {
    const paths = moves.map((move) => move.canonical);
    const script = `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      import { realpathSync } from 'node:fs';
      import { relative } from 'node:path';
      import { fileURLToPath } from 'node:url';
      const root = realpathSync(process.cwd()), visited = new Set();
      const allowed = new Set(${JSON.stringify(paths)});
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (!result.url.startsWith('file:')) throw Error('forbidden dependency: ' + result.url);
        const path = relative(root, realpathSync(fileURLToPath(result.url)));
        if (!allowed.has(path)) throw Error('forbidden dependency: ' + path);
        visited.add(path);
        return result;
      }});
      const vocabulary = await import('./src/ir/core/intrinsic-vocabulary.ts');
      const intents = await import('./src/ir/core/async-intents.ts');
      const strings = await import('./src/ir/core/string-types.ts');
      const identity = await import('./src/shared/contracts/ir-counted-string-identity.ts');
      assert.equal(vocabulary.INTRINSIC_IDS.length, 38);
      assert.equal(intents.ASYNC_RUNTIME_FEATURES.length, 7);
      assert.deepEqual(Object.keys(strings), []);
      assert.deepEqual(Object.keys(identity), []);
      await assert.rejects(import('./src/ir/intrinsics.ts'), /forbidden dependency:/);
      await assert.rejects(import('./src/ir/async-runtime-providers.ts'), /forbidden dependency:/);
      console.log(JSON.stringify([...visited].sort()));
    `;
    const child = spawnSync(
      process.execPath,
      ["--max-old-space-size=2048", "--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr + child.stdout).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(paths.sort());
  });

  it("round-trips canonical source/owner/span fields through the unmoved provenance authority", () => {
    const original = identity();
    const siteId: IrCountedStringAppendSiteId = createIrCountedStringAppendSiteId(original);
    const claim: IrCountedStringAppendSiteClaim = { ...original, siteId };
    expect(parseIrCountedStringAppendSiteId(siteId)).toEqual(original);
    expect(Object.isFrozen(parseIrCountedStringAppendSiteId(siteId))).toBe(true);
    expect(irCountedStringAppendSiteIdIsCurrent(siteId, original)).toBe(true);
    expect(() => assertUniqueCurrentIrCountedStringAppendSites([claim])).not.toThrow();
    expect(() => assertUniqueCurrentIrCountedStringAppendSites([claim, claim])).toThrow(
      "duplicate counted-string append site",
    );
    expect(() => assertUniqueCurrentIrCountedStringAppendSites([{ ...claim, loopEnd: original.loopEnd + 1 }])).toThrow(
      "detached",
    );
  });

  it("preserves one nominal brand, exact type joins, readonly fields and closed literal unions", () => {
    const path = resolve(root, ".tmp/issue-3518-core-vocabulary-type-probe.ts");
    // Use the actual explicit old forwarders as a bounded type surface. This
    // checks their type identities without typechecking unrelated old catalogs.
    const forwarders = new Map(
      moves.map((move) => [
        resolve(root, move.old),
        parse(move.old)
          .statements.filter(
            (node) =>
              ts.isExportDeclaration(node) && node.moduleSpecifier?.getText() === JSON.stringify(move.specifier),
          )
          .map((node) => node.getText())
          .join("\n"),
      ]),
    );
    const pairs = [
      [
        "I",
        [
          "NumberBoundaryIntrinsicId",
          "BooleanBoundaryIntrinsicId",
          "ExternBoundaryIntrinsicId",
          "IntrinsicId",
          "IntrinsicSignatureVersion",
        ],
      ],
      ["A", ["AsyncRuntimeFeature"]],
      ["S", ["IrStringEncoding", "IrStringConcatMode"]],
      ["P", ["IrCountedStringAppendSiteId", "IrCountedStringAppendSiteIdentity", "IrCountedStringAppendSiteClaim"]],
    ] as const;
    const negative = [
      ["site = 'unbranded';", 2322],
      ["site = sourceId;", 2322],
      ["site = unitId;", 2322],
      ["sourceId = site;", 2322],
      ["unitId = sourceId;", 2322],
      ["numberId = 'js.boolean.box';", 2322],
      ["booleanId = 'js.number.box';", 2322],
      ["externId = 'math.abs';", 2322],
      ["intrinsicId = 'math.reduce-trig';", 2322],
      ["feature = 'native.scheduler.enqueue';", 2820],
      ["encoding = 'utf16';", 2820],
      ["concatMode = 'mutable';", 2820],
      ["version = 2;", 2322],
      ["identity.sourceId = sourceId;", 2540],
      ["identity.ownerUnitId = unitId;", 2540],
      ["identity.loopStart = 1;", 2540],
      ["identity.loopEnd = 2;", 2540],
      ["claim.siteId = 'changed';", 2540],
      ["mathIds.push('math.abs');", 2339],
    ] as const;
    const text = `
      ${moves
        .map(
          (move, index) => `import type * as Old${pairs[index]![0]} from '../${move.old.replace(/\.ts$/, ".js")}';
      import type * as New${pairs[index]![0]} from '../${move.canonical.replace(/\.ts$/, ".js")}';`,
        )
        .join("\n")}
      import type { IrSourceId, IrUnitId } from '../src/shared/contracts/ir-identity.js';
      type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
      type Assert<T extends true> = T;
      ${pairs.flatMap(([prefix, names]) => names.map((name) => `type Equal${name} = Assert<Same<Old${prefix}.${name}, New${prefix}.${name}>>;`)).join("\n")}
      ${intrinsicValues.map((name) => `type Equal${name} = Assert<Same<typeof OldI.${name}, typeof NewI.${name}>>;`).join("\n")}
      type EqualRequiredFeatures = Assert<Same<typeof OldA.ASYNC_RUNTIME_FEATURES, typeof NewA.ASYNC_RUNTIME_FEATURES>>;
      type EqualOptionalFeatures = Assert<Same<typeof OldA.ASYNC_OPTIONAL_RUNTIME_FEATURES, typeof NewA.ASYNC_OPTIONAL_RUNTIME_FEATURES>>;
      declare let sourceId: IrSourceId, unitId: IrUnitId;
      declare let site: NewP.IrCountedStringAppendSiteId, oldSite: OldP.IrCountedStringAppendSiteId;
      site = oldSite; oldSite = site;
      const identity: NewP.IrCountedStringAppendSiteIdentity = { sourceId, ownerUnitId: unitId, loopStart: 1, loopEnd: 2 };
      const claim: NewP.IrCountedStringAppendSiteClaim = { ...identity, siteId: 'untrusted claims intentionally accept strings' };
      declare let numberId: NewI.NumberBoundaryIntrinsicId, booleanId: NewI.BooleanBoundaryIntrinsicId, externId: NewI.ExternBoundaryIntrinsicId;
      declare let intrinsicId: NewI.IntrinsicId, feature: NewA.AsyncRuntimeFeature, version: NewI.IntrinsicSignatureVersion;
      declare let encoding: NewS.IrStringEncoding, concatMode: NewS.IrStringConcatMode;
      declare let mathIds: typeof NewI.PURE_MATH_INTRINSIC_IDS;
      ${negative.map(([statement]) => "// @ts-expect-error deliberate closed-contract control\n" + statement).join("\n")}
    `;
    const diagnostics = (content: string) => {
      const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      };
      const host = ts.createCompilerHost(options);
      const getSourceFile = host.getSourceFile.bind(host);
      host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
        const replacement = fileName === path ? content : forwarders.get(fileName);
        return replacement === undefined
          ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
          : ts.createSourceFile(fileName, replacement, languageVersion, true);
      };
      return ts.getPreEmitDiagnostics(ts.createProgram([path], options, host));
    };
    expect(
      diagnostics(text).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    ).toEqual([]);
    const failures = diagnostics(text.replaceAll("@ts-expect-error", "negative control"));
    expect(failures.map((diagnostic) => diagnostic.code)).toEqual(negative.map(([, code]) => code));
    expect(failures.every((diagnostic) => diagnostic.file?.fileName === path)).toBe(true);
  });
});
