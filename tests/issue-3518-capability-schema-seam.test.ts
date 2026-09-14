// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as schema from "../src/runtime/contracts/host-capability-schema.js";
import * as catalog from "../src/ir/runtime-host-capabilities.js";
import { ASYNC_HOST_CAPABILITY_RECORDS, asAsyncHostAdapter } from "../src/ir/async-runtime-providers.js";
import { assertNamedForward } from "./helpers/ir-historical-runtime-reconstruction.js";

const root = resolve(import.meta.dirname, "..");
const schemaPath = "src/runtime/contracts/host-capability-schema.ts";
const oldPath = "src/ir/runtime-host-capabilities.ts";
const canonicalPath = "src/ir/runtime/host-capabilities.ts";
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

// Exact declaration + attached documentation receipts measured from
// 16498efb481cb022ee5c4dcc9bb137b6d4c91a50, source blob
// a6e1ddb276407b25677b3a69a006f6470d89589c. No historical git object is needed
// at test time. Deliberate future schema changes must review these receipts.
const declarationHashes = {
  RUNTIME_HOST_CAPABILITY_FUNC_IDS: "e306259b714b4c39b829dc697d28f42b14801f123ee62d038b9dd0a06729a2f9",
  RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_IDS: "aae1710f5cfdf266b5d2c3d3b9daddc2d3da20e7949c7fc5aa6c3c723526a181",
  RUNTIME_HOST_CAPABILITY_GLOBAL_IDS: "05a13450c6caa7c600202a1ab1ac7e36ff248f32e657d03dbd30f47a340835bf",
  RUNTIME_HOST_CAPABILITY_EXPORT_IDS: "640d5cd0bd3926c3df7b2b6f67d03723f030338159d44bfd5c91d6e0236880e1",
  RuntimeHostCapabilityFuncId: "48db2d2c4af7a4f7102f7cb18149bb27d174367b4557a8d6039651116183cd5d",
  RuntimeHostCapabilityFuncFamilyId: "a5c782c60bb3f65a96534c47f47513b80eb7d8c176317879b07d01b160836a17",
  RuntimeHostCapabilityGlobalId: "1ce1a0ef94bffd77a54015d6a95eded60101541f6854daf6db2a4f97fb97a671",
  RuntimeHostCapabilityExportId: "87d786f538c0fcf39a098f0ccd66292d79b7edfaef94231db33eb6f666220947",
  RuntimeHostCapabilityId: "a8089d35683016485af2a6e31a38914545fa1a2f4ecf4820c5ff9399ee905dd6",
  RUNTIME_HOST_CAPABILITY_IDS: "cdc4d7e0897336ae642b720f90ab33c1dc9c5cd125f63c8a5883644218fe88ae",
  RuntimeHostCapabilityValueType: "97523d5901898db97cc21824dd0b129b8a1c2ecf0ba3b6b9f692f4e000386cb8",
  RUNTIME_HOST_CAPABILITY_FUNC_MODULES: "2a34df0165f7271e686eedeb9a61138e53817dec5737278e6017d2e0ad82d53c",
  RUNTIME_HOST_CAPABILITY_GLOBAL_MODULES: "0689f54dfdb29eed6a5c8b270163aa853e1494094d750a26ae13865839f740cf",
  RuntimeHostCapabilityFuncModule: "8332b654be7750990d3f496ec2ab1f3b6c7aff92cca05acbfbf0f1b709feb2fe",
  RuntimeHostCapabilityGlobalModule: "9e8d7706526f45bfb1a3117b5a096b6c3f870a428cc9927493dcb74e7e357a5d",
  RUNTIME_HOST_CAPABILITY_KINDS: "9b5c1784abe1923af34f589cf188d8b36528428face91df25b7043e1d21e39d9",
  RuntimeHostCapabilityKind: "74ae7c6d67e7f37f3a11b37e3abf4e5d62c55d34ef7f99e1b5cf7725364bd031",
  RUNTIME_HOST_CAPABILITY_FIELD_SCHEMES: "7fda2f265e09d4e2a5e94a52b922ca53a829ee4ffd049a8018cef9ebf18aa582",
  RuntimeHostCapabilityFieldScheme: "cd73f2faf966a8daa86151d4368739932ab6bb959b50443252bd9a8fda953b6d",
  RuntimeHostCapabilityGlobalField: "1c34ffadfe56163e28d1e208752b940f63f82279000aa60e6cb8aa96417e166a",
  RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_FIELD_SCHEMES: "a86918d09fe7240bf3b391cdcde4bebefd01b82ac018b0f5e1c4ae62645b62c0",
  RuntimeHostCapabilityFuncFamilyFieldScheme: "73c2bf844bf571e7168fc089254f92f3ee9e6625dca06f7a2d05d5a1e12b6076",
  RUNTIME_HOST_CAPABILITY_EXPORT_PUBLICATIONS: "ec316299abf542507c0b72e027abe1b429a67d574c609e06d3e3daeb12f1dd45",
  RuntimeHostCapabilityExportPublication: "1e4f1c9efa0421b177680cbcae8010976e1a3db9019f9c5880412a4dcf5e2a1a",
  RUNTIME_HOST_CAPABILITY_HOST_SELECTION_ENV_VARS: "bb2ad1f116576f77e807e575c97ec7fa42fb2eaa65349a3a77948a55e3e96a01",
  RuntimeHostCapabilityHostSelectionEnvVar: "4d20d24c468bfd250bfe31c0ecdab0291c1a646563838a818f28a82022e7ba1f",
  RUNTIME_HOST_CAPABILITY_HOST_SELECTIONS: "45b30bbc520fb7d1c3b2342a9a673a6e9a3c9ee42ce6abd5a5409ef30a1981cb",
  RuntimeHostCapabilityHostSelectionCondition: "b7f9a283196976bbb35c7074088203f948c797f9584dfab0aef98c22445a4fa2",
  RuntimeHostCapabilityHostSelection: "5c3dc2789cc8d2745c7ee94082cf81e8c3bc87c01998186d91a02d29f191f547",
  RuntimeHostCapabilityFuncFamilyField: "4c6981f6f8257ae9a705af1be15402d5fcd4cbd240f561cc840aff78f7350c51",
  RuntimeHostCapabilityFuncFamilyParams: "9286d7dfef0383cf51e007b1c9a700907866ddb798c56a1148678bce82ffa978",
  HOST_CALLBACK_EXCEPTION_POLICY: "b6ba839ae9332d763dce717df72b5b5c73eafc0d24e951b607d1950251e83bac",
  HostCallbackExceptionPolicy: "d9de2f8e8440a1938fb034d72d709a9110dcfb2ac98c9eab7426e6bf4d157ded",
  RuntimeHostCapabilityFuncRecord: "6b854fa968280a81b1c0510f0544d2081ff20e910f6ccecda8d073d3de01a90c",
  RuntimeHostCapabilityGlobalRecord: "3cf65a1e352c9c554b9bcbc7543375b456a07b46a31049dcd7eea486e9d94394",
  RuntimeHostCapabilityFuncFamilyRecord: "f7a66a84124df67619e7752211251103d17a6ff9a76d3e67caee6509ca960923",
  RuntimeHostCapabilityExportRecord: "56bcb96599e24427cc080066039216b0dabfd42400a5e680b408e80ce48f042c",
  RuntimeHostCapabilityRecord: "62877aa9d1f465377294246678e44ec550bb58c9a078cd0d699dd06e0a315c09",
  ResolvedRuntimeHostCapabilityFuncFamilyRow: "ab6c9212fc12c9641855229ffd7b7451b8ac86afe8f9d47338e753418b40af64",
} as const;
const typeNames = [
  "RuntimeHostCapabilityFuncId",
  "RuntimeHostCapabilityFuncFamilyId",
  "RuntimeHostCapabilityGlobalId",
  "RuntimeHostCapabilityExportId",
  "RuntimeHostCapabilityId",
  "RuntimeHostCapabilityValueType",
  "RuntimeHostCapabilityFuncModule",
  "RuntimeHostCapabilityGlobalModule",
  "RuntimeHostCapabilityKind",
  "RuntimeHostCapabilityFieldScheme",
  "RuntimeHostCapabilityGlobalField",
  "RuntimeHostCapabilityFuncFamilyFieldScheme",
  "RuntimeHostCapabilityExportPublication",
  "RuntimeHostCapabilityHostSelectionEnvVar",
  "RuntimeHostCapabilityHostSelectionCondition",
  "RuntimeHostCapabilityHostSelection",
  "RuntimeHostCapabilityFuncFamilyField",
  "RuntimeHostCapabilityFuncFamilyParams",
  "RuntimeHostCapabilityFuncRecord",
  "RuntimeHostCapabilityGlobalRecord",
  "RuntimeHostCapabilityFuncFamilyRecord",
  "RuntimeHostCapabilityExportRecord",
  "RuntimeHostCapabilityRecord",
  "HostCallbackExceptionPolicy",
  "ResolvedRuntimeHostCapabilityFuncFamilyRow",
] as const;
const constantNames = [
  "RUNTIME_HOST_CAPABILITY_FUNC_IDS",
  "RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_IDS",
  "RUNTIME_HOST_CAPABILITY_GLOBAL_IDS",
  "RUNTIME_HOST_CAPABILITY_EXPORT_IDS",
  "RUNTIME_HOST_CAPABILITY_IDS",
  "RUNTIME_HOST_CAPABILITY_FUNC_MODULES",
  "RUNTIME_HOST_CAPABILITY_GLOBAL_MODULES",
  "RUNTIME_HOST_CAPABILITY_KINDS",
  "RUNTIME_HOST_CAPABILITY_FIELD_SCHEMES",
  "RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_FIELD_SCHEMES",
  "RUNTIME_HOST_CAPABILITY_EXPORT_PUBLICATIONS",
  "RUNTIME_HOST_CAPABILITY_HOST_SELECTION_ENV_VARS",
  "RUNTIME_HOST_CAPABILITY_HOST_SELECTIONS",
  "HOST_CALLBACK_EXCEPTION_POLICY",
] as const;

function parse(path: string, text = read(path)) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) {
    throw new Error("malformed source: " + path);
  }
  return file;
}

function declarationName(node: ts.Statement): string | undefined {
  if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isFunctionDeclaration(node)) {
    return node.name?.text;
  }
  if (ts.isVariableStatement(node)) return node.declarationList.declarations[0]?.name.getText();
  return undefined;
}

function attachedDoc(node: ts.Statement) {
  return (node as ts.Statement & { jsDoc?: readonly ts.JSDoc[] }).jsDoc?.at(-1);
}

function declarationText(node: ts.Statement, file: ts.SourceFile) {
  return file.text.slice(attachedDoc(node)?.pos ?? node.getStart(), node.end);
}

function verifySchema(text = read(schemaPath)) {
  const file = parse(schemaPath, text);
  const types = file.statements.filter((node) => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node));
  const constants = file.statements.filter(ts.isVariableStatement);
  expect(types.map(declarationName).sort()).toEqual([...typeNames].sort());
  expect(constants.map(declarationName).sort()).toEqual([...constantNames].sort());
  expect(file.statements).toHaveLength(39);
  expect(types).toHaveLength(25);
  expect(constants).toHaveLength(14);
  for (const node of file.statements) {
    const name = declarationName(node) as keyof typeof declarationHashes;
    expect(digest(declarationText(node, file)), name).toBe(declarationHashes[name]);
  }
  return file;
}

function typeDiagnostics(source: string) {
  const fileName = resolve(root, ".tmp/capability-schema-contract.ts");
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2022.d.ts"],
  };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
    path === fileName
      ? ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
      : original(path, languageVersion, onError, shouldCreateNewSourceFile);
  return ts.getPreEmitDiagnostics(ts.createProgram([fileName], options, host));
}

describe("capability schema relocation", () => {
  it.each(constantNames)("retains the exact old-path %s binding", (name) => {
    expect(catalog[name]).toBe(schema[name]);
    if (Array.isArray(schema[name])) expect(Object.isFrozen(schema[name])).toBe(true);
  });

  it("contains exactly the original 25 types and 14 constants, without imports or implementation declarations", () => {
    verifySchema();
    expect(Object.keys(schema).sort()).toEqual([...constantNames].sort());
  });

  it.each([
    [
      "removed declaration",
      (text: string) =>
        text.replace("export type HostCallbackExceptionPolicy = typeof HOST_CALLBACK_EXCEPTION_POLICY;", ""),
    ],
    ["changed literal", (text: string) => text.replace('"async.callback.wrap"', '"async.callback.changed"')],
    ["changed documentation", (text: string) => text.replace("CLOSED source of truth", "different source of truth")],
    ["extra declaration", (text: string) => text + "\nexport type Extra = string;\n"],
    ["malformed declaration", (text: string) => text + "\nexport {\n"],
  ] as const)("rejects a %s in the declaration receipt control", (_name, perturb) => {
    verifySchema(); // The detector must accept the populated, unmodified source first.
    expect(() => verifySchema(perturb(read(schemaPath)))).toThrow();
  });

  it("leaves all 48 catalog/private/function declarations and their documentation unchanged", () => {
    const file = parse(canonicalPath);
    const declarations = file.statements.filter((node) => declarationName(node) !== undefined);
    expect(declarations).toHaveLength(48);
    expect(declarations.filter(ts.isFunctionDeclaration)).toHaveLength(28);
    const rows = declarations.map((node) => [
      declarationName(node),
      attachedDoc(node)?.getText() ?? "",
      node.getText(),
    ]);
    expect(digest(JSON.stringify(rows))).toBe("46aa565f9b3ee7ea0c807768e5210d8012d04df69d69cb7a3ffe0e22d18fd724");
    expect(declarations.map(declarationName)).toContain("RUNTIME_HOST_CAPABILITY_RECORDS");
    expect(declarations.map(declarationName)).toContain("HOST_CALLBACK_WRAP_CAPABILITY_RECORD");
    for (const name of [...typeNames, ...constantNames]) {
      expect(declarations.map(declarationName)).not.toContain(name);
    }
    const exports = file.statements.filter(ts.isExportDeclaration);
    expect(exports).toHaveLength(2);
    for (const node of exports) {
      expect(node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)).toBe(true);
      if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) throw Error("missing schema owner");
      expect(resolve(dirname(resolve(root, canonicalPath)), node.moduleSpecifier.text.replace(/\.js$/, ".ts"))).toBe(
        resolve(root, schemaPath),
      );
      expect(node.exportClause && ts.isNamedExports(node.exportClause)).toBe(true);
    }
    for (const name of typeNames) assertNamedForward(canonicalPath, schemaPath, name, true, read);
    for (const name of constantNames) assertNamedForward(canonicalPath, schemaPath, name, false, read);
    const facade = parse(oldPath);
    expect(facade.statements).toHaveLength(2);
    expect(facade.statements.every(ts.isExportDeclaration)).toBe(true);
    const names = [
      ...typeNames.map((name) => ({ name, typeOnly: true })),
      ...constantNames.map((name) => ({ name, typeOnly: false })),
      ...declarations
        .filter(
          (node) =>
            ts.canHaveModifiers(node) &&
            ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
        )
        .map((node) => ({
          name: declarationName(node)!,
          typeOnly: ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node),
        })),
    ];
    for (const { name, typeOnly } of names) assertNamedForward(oldPath, canonicalPath, name, typeOnly, read);
    expect(
      facade.statements
        .filter(ts.isExportDeclaration)
        .flatMap((node) =>
          node.exportClause && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements.map((entry) => entry.name.text)
            : [],
        )
        .sort(),
    ).toEqual(names.map(({ name }) => name).sort());
  });

  it("loads the import-free schema alone in a fresh process", () => {
    const script = [
      "import assert from 'node:assert/strict';",
      "import { registerHooks } from 'node:module';",
      "import { realpathSync } from 'node:fs';",
      "import { relative } from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "const root = realpathSync(process.cwd()), visited = new Set();",
      "registerHooks({ resolve(specifier, context, next) {",
      "  const result = next(specifier, context);",
      "  if (!result.url.startsWith('file:')) throw Error('forbidden dependency: ' + result.url);",
      "  const path = relative(root, realpathSync(fileURLToPath(result.url)));",
      "  if (path !== 'src/runtime/contracts/host-capability-schema.ts') throw Error('forbidden dependency: ' + path);",
      "  visited.add(path); return result;",
      "}});",
      "const schema = await import('./src/runtime/contracts/host-capability-schema.ts');",
      "assert.equal(schema.RUNTIME_HOST_CAPABILITY_IDS.length, 32);",
      "assert.equal(Object.isFrozen(schema.RUNTIME_HOST_CAPABILITY_IDS), true);",
      "await assert.rejects(import('./src/ir/runtime-host-capabilities.ts'), /forbidden dependency:/);",
      "console.log(JSON.stringify([...visited]));",
    ].join("\n");
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status, child.stderr + child.stdout).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([schemaPath]);
  });

  it("preserves all 32 IDs, their ordering, and the mutually exclusive runtime kind guards", () => {
    const parts = [
      [schema.RUNTIME_HOST_CAPABILITY_FUNC_IDS, catalog.isRuntimeHostCapabilityFuncId],
      [schema.RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_IDS, catalog.isRuntimeHostCapabilityFuncFamilyId],
      [schema.RUNTIME_HOST_CAPABILITY_GLOBAL_IDS, catalog.isRuntimeHostCapabilityGlobalId],
      [schema.RUNTIME_HOST_CAPABILITY_EXPORT_IDS, catalog.isRuntimeHostCapabilityExportId],
    ] as const;
    expect(parts.map(([ids]) => ids.length)).toEqual([21, 3, 2, 6]);
    const all = parts.flatMap(([ids]) => [...ids]);
    expect(new Set(all).size).toBe(32);
    expect(schema.RUNTIME_HOST_CAPABILITY_IDS).toEqual([...all].sort());
    for (const id of schema.RUNTIME_HOST_CAPABILITY_IDS) {
      expect(catalog.isRuntimeHostCapabilityId(id)).toBe(true);
      expect(parts.filter(([ids]) => (ids as readonly string[]).includes(id))).toHaveLength(1);
      for (const [ids, guard] of parts) expect(guard(id)).toBe((ids as readonly string[]).includes(id));
    }
    expect(catalog.isRuntimeHostCapabilityId("unregistered.capability")).toBe(false);
    for (const [, guard] of parts) expect(guard("unregistered.capability")).toBe(false);
  });

  it("keeps the full catalog canonical and rejects structurally exact reconstructed records", () => {
    const original = catalog.RUNTIME_HOST_CAPABILITY_RECORDS;
    expect(original).toHaveLength(32);
    expect(original.map((row) => row.capability)).toEqual(schema.RUNTIME_HOST_CAPABILITY_IDS);
    expect(Object.isFrozen(original)).toBe(true);
    const reordered = catalog.canonicalizeRuntimeHostCapabilityCatalog([...original].reverse());
    expect(Object.isFrozen(reordered)).toBe(true);
    for (const [index, row] of original.entries()) {
      expect(Object.isFrozen(row)).toBe(true);
      expect(reordered[index]).toBe(row);
      expect(catalog.resolveRuntimeHostCapabilityRecord(original, row.capability)).toBe(row);
      expect(() => catalog.assertCanonicalRuntimeHostCapabilityRecord(row)).not.toThrow();
      const rebuilt = { ...row };
      expect(() => catalog.assertRuntimeHostCapabilityRecord(rebuilt)).not.toThrow();
      expect(() => catalog.assertCanonicalRuntimeHostCapabilityRecord(rebuilt)).toThrow(
        "not the canonical catalog record",
      );
      expect(() => catalog.resolveRuntimeHostCapabilityRecord([rebuilt], row.capability)).toThrow(
        "not the canonical catalog record",
      );
    }
    expect(() => catalog.canonicalizeRuntimeHostCapabilityCatalog(original.slice(1))).toThrow("incomplete");
    expect(() => catalog.canonicalizeRuntimeHostCapabilityCatalog([...original, original[0]])).toThrow("duplicates");
    expect(catalog.HOST_CALLBACK_WRAP_CAPABILITY_RECORD).toBe(
      catalog.resolveRuntimeHostCapabilityFuncRecord(original, "async.callback.wrap"),
    );
    expect(catalog.HOST_CALLBACK_WRAP_CAPABILITY_RECORD.exceptionPolicy).toBe(schema.HOST_CALLBACK_EXCEPTION_POLICY);
  });

  it("keeps synthesized family rows distinct and preserves leading parameters, shared results, and arity guards", () => {
    const records = catalog.RUNTIME_HOST_CAPABILITY_RECORDS;
    const family = catalog.resolveRuntimeHostCapabilityRecord(records, "callable.host_call.fixed");
    const concrete = catalog.resolveRuntimeHostCapabilityFuncFamilyRecord(records, "callable.host_call.fixed", 2);
    expect(concrete).toEqual({
      module: "env",
      field: "__call_function_2",
      params: ["externref", "externref", "externref", "externref"],
      results: ["externref"],
    });
    expect(concrete).not.toHaveProperty("capability");
    expect(concrete).not.toHaveProperty("kind");
    expect(family.kind === "func-family" && concrete.results === family.results).toBe(true);
    expect(Object.isFrozen(concrete)).toBe(true);
    expect(Object.isFrozen(concrete.params)).toBe(true);
    expect(() => catalog.assertCanonicalRuntimeHostCapabilityRecord(concrete)).toThrow();
    expect(() => catalog.resolveRuntimeHostCapabilityFuncFamilyRecord(records, "callable.host_call.fixed", 5)).toThrow(
      "does not cover arity",
    );
    expect(() => catalog.resolveRuntimeHostCapabilityFuncFamilyRecord(records, "string.concat.many", 2)).toThrow(
      "does not cover arity",
    );
    expect(catalog.resolveRuntimeHostCapabilityFuncFamilyRecord(records, "string.concat.many", 9).params).toHaveLength(
      9,
    );
    for (const invalid of [-1, 0.5, NaN, Infinity]) {
      expect(() =>
        catalog.resolveRuntimeHostCapabilityFuncFamilyRecord(records, "callable.host_call.fixed", invalid),
      ).toThrow("does not cover arity");
    }
  });

  it("preserves the async projection's eight exact catalog objects and rejects every non-async record", () => {
    expect(ASYNC_HOST_CAPABILITY_RECORDS).toHaveLength(8);
    for (const row of catalog.RUNTIME_HOST_CAPABILITY_RECORDS) {
      if (row.capability.startsWith("async.")) {
        expect(asAsyncHostAdapter(row)).toBe(row);
        expect(ASYNC_HOST_CAPABILITY_RECORDS.find((entry) => entry.capability === row.capability)).toBe(row);
        expect(
          row.kind === "func" &&
            [...row.params, ...row.results].every((value) => value === "externref" || value === "i32"),
        ).toBe(true);
      } else {
        expect(() => asAsyncHostAdapter(row)).toThrow("not an async capability");
      }
    }
    expect(() => asAsyncHostAdapter({ ...catalog.HOST_CALLBACK_WRAP_CAPABILITY_RECORD, params: ["f64"] })).toThrow(
      "cannot carry value type f64",
    );
  });

  it("compiles old/new generic compatibility and all four record discriminants, with real negative controls", () => {
    const source = [
      "import type * as New from '../src/runtime/contracts/host-capability-schema.js';",
      "import type * as Old from '../src/ir/runtime-host-capabilities.js';",
      ...typeNames.map((name) => "{ let old!: Old." + name + "; let next: New." + name + " = old; old = next; }"),
      "type Narrow = New.RuntimeHostCapabilityFuncRecord<'async.callback.wrap', 'externref' | 'i32'>;",
      "let narrow!: Narrow; let oldNarrow: Old.RuntimeHostCapabilityFuncRecord<'async.callback.wrap', 'externref' | 'i32'> = narrow; narrow = oldNarrow;",
      "let all!: New.RuntimeHostCapabilityRecord;",
      "let func!: New.RuntimeHostCapabilityFuncRecord; all = func;",
      "let global!: New.RuntimeHostCapabilityGlobalRecord; all = global;",
      "let family!: New.RuntimeHostCapabilityFuncFamilyRecord; all = family;",
      "let exported!: New.RuntimeHostCapabilityExportRecord; all = exported;",
      "let resolved!: New.ResolvedRuntimeHostCapabilityFuncFamilyRow<'externref'>;",
      "let narrowed!: New.RuntimeHostCapabilityRecord<'number.box', 'f64' | 'externref'>;",
      "if (narrowed.kind === 'func') { const id: 'number.box' = narrowed.capability; }",
      "function discriminate(row: New.RuntimeHostCapabilityRecord): string {",
      " switch (row.kind) {",
      " case 'func': return row.module + row.field + row.params.length;",
      " case 'func-family': return row.module + row.field.prefix + row.params.repeat;",
      " case 'global': return row.module + row.field.scheme + row.valueType;",
      " case 'export': return row.name + row.alias + row.publication;",
      " default: { const unreachable: never = row; return unreachable; }",
      " }}",
      "// @ts-expect-error a family is not a concrete callable ID",
      "type BadFamily = New.RuntimeHostCapabilityFuncRecord<'string.concat.many'>;",
      "// @ts-expect-error global IDs cannot be callables",
      "type BadGlobal = New.RuntimeHostCapabilityFuncRecord<'string.const'>;",
      "// @ts-expect-error export IDs cannot be callables",
      "type BadExport = New.RuntimeHostCapabilityFuncRecord<'callable.export.arity'>;",
      "// @ts-expect-error value generic stays closed",
      "type BadValue = New.RuntimeHostCapabilityFuncFamilyParams<'i64'>;",
      "// @ts-expect-error narrowed async ABI cannot carry f64",
      "const invalidParams: Narrow['params'] = ['f64'];",
      "// @ts-expect-error synthesized rows lack canonical identity and kind",
      "all = resolved;",
      "// @ts-expect-error export direction has no module namespace",
      "exported.module;",
      "// @ts-expect-error the global namespace is not a func namespace",
      "const moduleName: New.RuntimeHostCapabilityFuncModule = 'string_constants';",
      "// @ts-expect-error literal field derivation is not an arity derivation",
      "const fieldScheme: New.RuntimeHostCapabilityFuncFamilyFieldScheme = 'literal';",
      "// @ts-expect-error host selection is a closed declared condition",
      "const selection: New.RuntimeHostCapabilityHostSelectionCondition = 'zero';",
    ].join("\n");
    const valid = typeDiagnostics(source);
    expect(valid.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, "\n"))).toEqual([]);
    const invalid = typeDiagnostics(source.replaceAll("@ts-expect-error", "negative control"));
    expect(invalid).toHaveLength(10);
    expect(invalid.every((entry) => entry.category === ts.DiagnosticCategory.Error)).toBe(true);
  });
});
