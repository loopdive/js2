// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
// Established bootstrap: the legacy registry graph needs the public entry first.
import "../src/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { createEmptyModule } from "../src/ir/types.js";
import { ensureVecElemSet, ensureVecNewSized, ensureHoleyArrayNew } from "../src/codegen/vec-elem-set.js";
import {
  getOrRegisterArrayType,
  getOrRegisterVecBaseType,
  getOrRegisterVecType,
  getOrRegisterHoleyArrayType,
} from "../src/codegen/registry/types.js";
import { HOLE_F64_BITS } from "../src/codegen/value-tags.js";
import { inversePreparedSourceForward } from "./helpers/prepared-source-forward-receipts.js";
import {
  buildVectorGrowStoreBody,
  createVectorBackingArrayType,
  createVectorBaseType,
  createVectorCarrierType,
} from "../src/runtime/wasmgc/values/vector-grow-store.js";

const paths = { donor: "../src/codegen/vec-elem-set.ts", registry: "../src/codegen/registry/types.ts" } as const;
const read = (key: keyof typeof paths) => readFileSync(new URL(paths[key], import.meta.url), "utf8");
const parse = (text: string) => ts.createSourceFile("donor.ts", text, ts.ScriptTarget.Latest, true);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const printer = ts.createPrinter({ removeComments: true });

function normalizedFunction(text: string, name: string): string {
  const sf = parse(text),
    fn = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (!fn?.body) throw new Error("missing exact donor function");
  const transform = ts.transform(fn, [
    (context) => (root) => {
      const visit: ts.Visitor = (node) => {
        if (name === "ensureVecElemSet" && ts.isVariableStatement(node)) {
          const declaration = node.declarationList.declarations[0]!;
          const variable = declaration.name.getText(sf);
          if (["VEC", "IDX", "VAL", "DATA", "NCAP", "NDATA", "OCAP", "OLEN", "body"].includes(variable))
            return undefined;
          if (
            declaration.initializer &&
            ts.isCallExpression(declaration.initializer) &&
            declaration.initializer.expression.getText(sf) === "buildVectorGrowStoreBody"
          )
            return undefined;
          if (variable === "gapFill" || variable === "gapFillInit")
            return ts.factory.createVariableStatement(
              undefined,
              ts.factory.createVariableDeclarationList(
                [
                  ts.factory.createVariableDeclaration(
                    "GAP_FILL_RECEIPT",
                    undefined,
                    undefined,
                    ts.factory.createNumericLiteral(0),
                  ),
                ],
                ts.NodeFlags.Const,
              ),
            );
        }
        if (
          name === "ensureVecElemSet" &&
          node.parent &&
          ts.isObjectLiteralExpression(node.parent) &&
          (ts.isShorthandPropertyAssignment(node) || ts.isPropertyAssignment(node)) &&
          node.name.getText(sf) === "locals"
        )
          return ts.factory.createPropertyAssignment("locals", ts.factory.createIdentifier("LOCALS_RECEIPT"));
        if (
          name !== "ensureVecElemSet" &&
          ts.isCallExpression(node) &&
          node.expression.getText(sf) === "ctx.mod.types.push"
        )
          return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
            ts.factory.createIdentifier("DESCRIPTOR_RECEIPT"),
          ]);
        return ts.visitEachChild(node, visit, context);
      };
      return ts.visitNode(root, visit) as ts.FunctionDeclaration;
    },
  ]);
  try {
    return printer.printNode(ts.EmitHint.Unspecified, transform.transformed[0]!, sf);
  } finally {
    transform.dispose();
  }
}

const ORIGINAL_DECLARATIONS = {
  donor: [
    {
      name: "VEC_ELEM_SET_PREFIX",
      sha256: "63da7e9e1db98ac675fa523288fccdf343a12820aa56c9ad6d05014de037ba19",
      retained: true,
    },
    {
      name: "VEC_NEW_SIZED_PREFIX",
      sha256: "bde93877ee17967c1cfdeb1585fde4e669d71c466e81644ddf83e2be02209187",
      retained: true,
    },
    {
      name: "HOLEY_ARRAY_NEW",
      sha256: "ce594f8d66edced31796aa6046bfc93feb2b000e161854ad9dbc6581da1e2c88",
      retained: true,
    },
    {
      name: "ensureHoleyArrayNew",
      sha256: "dc44540f5f166faf8f66f324f520b3048410723a96151a5b7489562dff13d3fa",
      retained: true,
    },
    {
      name: "vecTypeIndexForElement",
      sha256: "83ce8899fdee86879c3e44559e7a4dd5d67e15924be645ce601c0f26a289af8c",
      retained: true,
    },
    {
      name: "ensureVecNewSizedForElement",
      sha256: "84c614bafd3a5e0decfb9094feb8077805da5b239c88c1a4cd5f9aa24c67a5d1",
      retained: true,
    },
    {
      name: "ensureVecElemSetForElement",
      sha256: "ceb27e66bbb4e4603ad24f522fb313c3d424b6db96deefc2afb3db26184327ed",
      retained: true,
    },
    {
      name: "ensureVecNewSized",
      sha256: "08bdd2ca285cbabfc5e0ccce7bbc02976b7917b9b95969146b43e46feb30ad29",
      retained: true,
    },
    {
      name: "ensureVecElemSet",
      sha256: "241349f47b3dce9705c3c62878bc0b4607a7146d25937570bb43e0b3b6a2787b",
      retained: false,
    },
  ],
  registry: [
    {
      name: "registerStructType",
      sha256: "f61916d65496bd57304cdb8f5dff9e4ce5f0f623c23fa966169f3f9dde605311",
      retained: true,
    },
    {
      name: "addFuncType",
      sha256: "a309d38e966a5d1673c6dcec320eed5377b517fb93306e72fdd3773f9c3ff4aa",
      retained: true,
    },
    {
      name: "getOrRegisterArrayType",
      sha256: "58f890ac3c21f18978308c9d2860e50b60cd07943ab8f6ddd0b9886efddf869a",
      retained: false,
    },
    {
      name: "getOrRegisterVecBaseType",
      sha256: "84a8ef3b660721feea565ba3f1fe41b3802b3e5e6f7407b51d174cc69b390b83",
      retained: false,
    },
    {
      name: "isVecBaseSubtype",
      sha256: "731a40aa43c528f2a3206f69e8f75c33e4bced61de9403c3623e3fd94931755a",
      retained: true,
    },
    {
      name: "withSuppressedVecUsage",
      sha256: "b735b4d4c0d313b49eb530231d2e13958e069b5717448ffa053d69d10c1fad7d",
      retained: true,
    },
    {
      name: "getOrRegisterVecType",
      sha256: "04ce4c10ec816b7a13ca4224a4848f4b4546314a3ed6c62209bce0bdfe80d1b9",
      retained: false,
    },
    {
      name: "getOrRegisterHoleyArrayType",
      sha256: "a67da23cdd4122372771fc71f3a830ac45236f6e0611e25623b05891cbdda1c6",
      retained: true,
    },
    {
      name: "getOrRegisterArgumentsVecType",
      sha256: "0e0bc367bef202bd9424f287442e843708e8db64fb7ea52800525f6c5565a85d",
      retained: true,
    },
    {
      name: "isHoleyArrayType",
      sha256: "1a53d6aefb740bfa7095b97eb90d00e32927fcd38515df4b396b82af9d62be1d",
      retained: true,
    },
    {
      name: "getOrRegisterSubviewType",
      sha256: "19cd01d9ecb9fbff104d466a8bc26012771470e2fad2f334a6cbd9bb43eb1c5d",
      retained: true,
    },
    {
      name: "getSubviewArrTypeIdx",
      sha256: "36cdc948e28b0c2af703e026e5ae31f2d0013a76c92e32ed1041e72a96f2ac5f",
      retained: true,
    },
    {
      name: "isSubviewTypeIdx",
      sha256: "6c652ffae30ca70f41a4cd5412b3fd799401463a7704b230610db335e0829d87",
      retained: true,
    },
    {
      name: "getOrRegisterTaViewType",
      sha256: "76ef1f6cdb6f743246c05163489ea9e766dc71cb66bf9985800e1814b07e81c1",
      retained: true,
    },
    {
      name: "isTaViewTypeIdx",
      sha256: "f5d0799c265543e5bbf266c5955a587c1d06d7dcb4439a091fcb71f69cbad1f2",
      retained: true,
    },
    {
      name: "getTaViewName",
      sha256: "69b5092526080087e0b2f24bd0b1d7883efe86a9aa4188e41a2ae6ed85d66b3e",
      retained: true,
    },
    {
      name: "TA_CTOR_KINDS",
      sha256: "e463d8c77082b4209454419e80f4f6e6e5de0e9ef6bd0867271a9111cd1467aa",
      retained: true,
    },
    {
      name: "TA_CTOR_BYTES",
      sha256: "10aa617f7e4d5e4fb1a88e0e3055af6af31525e27a1c8bb414b6c3b8fd29b6e7",
      retained: true,
    },
    {
      name: "taCtorKindOf",
      sha256: "0ed36bb3795fe4b0e668b8a4d3a2b1e43e4f7137162d7551d1835f8cbf188c3d",
      retained: true,
    },
    {
      name: "TA_CTOR_BRAND",
      sha256: "e00e3c3de260d8d73d6e49c85fb013df9a1800ddeff3d56925f2fabd42452a29",
      retained: true,
    },
    {
      name: "getOrRegisterTaCtorType",
      sha256: "27e08f0a72b4cddd3b2b0e165aded9b16f95184dc3043705c5d117552c884e29",
      retained: true,
    },
    {
      name: "getOrRegisterTaDynViewType",
      sha256: "50710f4c16f23b4e1aba77720b84613e501b7977174e8d9f5da6fe336c844bd9",
      retained: true,
    },
    {
      name: "getOrRegisterBoundFnType",
      sha256: "ecbc1fb0a77ebf742cd1cbe3fdb96f5b1c201a67573a50bbab88c61ba0b2d6e4",
      retained: true,
    },
    {
      name: "getOrRegisterResizableAbType",
      sha256: "9518a66e28e9ad013dd078fbefda0fc9eeb3b87006ac58fb44e591f9387b6d23",
      retained: true,
    },
    {
      name: "getOrRegisterTemplateVecType",
      sha256: "c6612aa945819bf098b0ac1f220a62e5daa13189d00d3d1d70d759653d5e39a4",
      retained: true,
    },
    {
      name: "getOrRegisterRefCellType",
      sha256: "0976446f07ccdc56f52edf370d3dd0d29b0ed782ed1e55f9779e38a20c71fe44",
      retained: true,
    },
    {
      name: "refCellValueType",
      sha256: "5cb7fa2f270729d36a996af22b7f7640020a06b6641496ce1f1c2572de2366b9",
      retained: true,
    },
    {
      name: "getArrTypeIdxFromVec",
      sha256: "d5de6b418d7c5670a928e119021e315441ecbe541e5b9ee42db5e65f5a239a54",
      retained: true,
    },
    {
      name: "getOrRegisterErrorStructType",
      sha256: "5e029463531f6b7b65d119b2f6fe7b19c01bf01ea2589f9d40c8ca59c89f4c9e",
      retained: true,
    },
    {
      name: "registerNativeStringTypes",
      sha256: "e6de2fc9648203849e20fe402b07af90a03283b36decd583284253ae70b0aadb",
      retained: true,
    },
  ],
} as const;

const ADAPTER_SHAPES = [
  ["donor", "ensureVecElemSet", "781a2474556a4b472851f6c92325d560549d2572272e08e713e5e44fa5940df2"],
  ["registry", "getOrRegisterArrayType", "ef19d0d5b623d517dff2b5e517dcae50ca866a6215133b35ae8722ab460d8b22"],
  ["registry", "getOrRegisterVecBaseType", "8da164e7abf6ca79052b8d96e4e30149440d9b6d853c3aae464048511015319f"],
  ["registry", "getOrRegisterVecType", "c5a11ee88d8c7c7d341146708fbf5d9b212f05a0501af93381cb74f2e6282f47"],
] as const;

const layoutForwardPath = "./fixtures/issue-3518-vector-registry-layout-forward.json";
const layoutDonorPath = "./fixtures/issue-3518-native-string-error-donors.json";
const layoutSourcePath = "../src/runtime/wasmgc/values/string-layouts.ts";
const readRelative = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const layoutForwardHash = "a9352c68a14308b47fe61534a0cec083b44e30c09d80f8a04596bdfb482452a2";
interface LayoutFactory {
  name: string;
  header: string;
  call: string;
  extraIndent: number;
  owner: string;
}
interface LayoutForward {
  schema: string;
  registryImport: string;
  canonicalPrefix: string;
  factorySeparator: string;
  canonicalSuffix: string;
  factories: LayoutFactory[];
}

function layoutForward(text = readRelative(layoutForwardPath)): LayoutForward {
  expect(sha(text), "independent layout forward provenance").toBe(layoutForwardHash);
  const fixture = JSON.parse(text) as LayoutForward;
  expect(fixture.schema).toBe("vector-registry-layout-forward-v1");
  expect(fixture.factories).toHaveLength(8);
  return fixture;
}

function exactFunction(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const matches = file.statements.filter(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  expect(matches, `one declaration ${name}`).toHaveLength(1);
  return matches[0]!;
}

// Reconstruct from the actual canonical payload, preserving its comments and
// expressions. Only the declared layout parameter's property-access bases move.
function layoutPayload(file: ts.SourceFile, fn: ts.FunctionDeclaration, spec: LayoutFactory): string {
  expect(file.text.slice(fn.getStart(file), fn.body!.getStart(file)), spec.name).toBe(spec.header);
  expect(fn.body!.statements, `single return ${spec.name}`).toHaveLength(1);
  const statement = fn.body!.statements[0]!;
  expect(ts.isReturnStatement(statement), spec.name).toBe(true);
  const expression = (statement as ts.ReturnStatement).expression!;
  expect(expression && ts.isObjectLiteralExpression(expression), spec.name).toBe(true);
  expect(file.text.slice(fn.body!.getStart(file) + 1, expression.getStart(file))).toBe("\n  return ");
  expect(file.text.slice(expression.end, fn.end)).toBe(";\n}");
  const bases: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    // The inverse introduces ctx; accepting an existing free ctx would conceal
    // a broken canonical binding behind the same reconstructed source text.
    if (ts.isIdentifier(node) && node.text === "ctx") throw new Error("unbound ctx in canonical layout payload");
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "layout")
      bases.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(expression);
  let payload = expression.getText(file);
  for (const base of bases.reverse()) {
    const start = base.getStart(file) - expression.getStart(file);
    payload = payload.slice(0, start) + "ctx" + payload.slice(start + base.getWidth(file));
  }
  return payload.replaceAll("\n", `\n${" ".repeat(spec.extraIndent)}`);
}

function inverseStringLayouts(registry: string, canonical: string, forwardText?: string): string {
  const fixture = layoutForward(forwardText);
  const source = parse(registry),
    live = parse(canonical);
  const imports = source.statements.filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) &&
      ((ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === "../../runtime/wasmgc/values/string-layouts.js") ||
        Boolean(
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.some((item) =>
            fixture.factories.some((spec) => spec.name === item.name.text || spec.name === item.propertyName?.text),
          ),
        )),
  );
  expect(imports, "one canonical ordinary layout import").toHaveLength(1);
  expect(imports[0]!.getText(source), "complete canonical layout import").toBe(fixture.registryImport);
  expect(live.statements).toHaveLength(10);
  const functions = live.statements.slice(2);
  expect(functions.map((node) => (ts.isFunctionDeclaration(node) ? node.name?.text : null))).toEqual(
    fixture.factories.map((spec) => spec.name),
  );
  expect(canonical.slice(0, functions[0]!.getStart(live))).toBe(fixture.canonicalPrefix);
  const changes: { start: number; end: number; payload: string }[] = [];
  for (const [index, spec] of fixture.factories.entries()) {
    const fn = functions[index] as ts.FunctionDeclaration;
    expect(canonical.slice(fn.end, functions[index + 1]?.getStart(live) ?? canonical.length)).toBe(
      index === functions.length - 1 ? fixture.canonicalSuffix : fixture.factorySeparator,
    );
    const owner = exactFunction(source, spec.owner);
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "ctx.mod.types.push" &&
        node.arguments.length === 1 &&
        node.arguments[0]!.getText(source) === spec.call
      )
        calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(owner);
    expect(calls, `exact owned layout call ${spec.call}`).toHaveLength(1);
    const argument = calls[0]!.arguments[0]!;
    changes.push({ start: argument.getStart(source), end: argument.end, payload: layoutPayload(live, fn, spec) });
  }
  expect(changes.map((change) => change.start)).toEqual(changes.map((change) => change.start).sort((a, b) => a - b));
  for (const change of changes.reverse())
    registry = registry.slice(0, change.start) + change.payload + registry.slice(change.end);
  return registry;
}

const preparedRegistryFixtureText = readRelative("./fixtures/issue-3518-prepared-registry-types-forward.json");
const preparedRegistryFixtureHash = "b2cf353c1779a8469be0c68eba497321cd1110c0e524c12f6dd357925025c2f9";
const preparedRegistryImport =
  'import type { FieldDef, FuncTypeDef, Instr, StructTypeDef, ValType } from "../../ir/types.js";';

function inversePreparedRegistry(registry: string, fixtureText = preparedRegistryFixtureText): string {
  const restored = inversePreparedSourceForward(registry, fixtureText, preparedRegistryFixtureHash);
  const sf = parse(registry);
  const imports = sf.statements.filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) &&
      ((ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "../../ir/types.js") ||
        Boolean(
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.some((binding) => binding.name.text === "Instr"),
        )),
  );
  expect(imports, "single prepared IR type import").toHaveLength(1);
  expect(imports[0]!.getText(sf), "exact prepared IR type import").toBe(preparedRegistryImport);
  const names = sf.statements.filter(ts.isFunctionDeclaration).map((fn) => fn.name?.text);
  expect(names.filter((name) => name === "taCtorIdentityTestInstrs")).toHaveLength(1);
  const position = names.indexOf("taCtorIdentityTestInstrs");
  expect(names.slice(position - 1, position + 2), "prepared declaration ownership and order").toEqual([
    "getOrRegisterTaCtorType",
    "taCtorIdentityTestInstrs",
    "getOrRegisterTaDynViewType",
  ]);
  return restored;
}

function verifyLayoutInverse(registry = read("registry"), canonical = readRelative(layoutSourcePath)): string {
  const restored = inverseStringLayouts(inversePreparedRegistry(registry), canonical);
  const originalText = readRelative(layoutDonorPath);
  expect(sha(originalText), "unchanged original layout donor fixture").toBe(
    "b579a8d1d0c251ec9a5661f2602da72a90d96991e5915304a013dadc9fc5de61",
  );
  const original = JSON.parse(originalText);
  expect(original.base).toBe("5118637e0e9b34291465230428447e511958faa1");
  expect(original.sources[0].sourceSha256).toBe("0001ca01391b5c85cc16f4db8cde593729dec80843443f7466812c8ea63a8cd5");
  const before = parse(original.sources[0].text),
    after = parse(restored);
  for (const name of ["getOrRegisterErrorStructType", "registerNativeStringTypes"]) {
    const fn = exactFunction(after, name);
    expect(sha(fn.getFullText(after)), name).toBe(
      ORIGINAL_DECLARATIONS.registry.find((row) => row.name === name)!.sha256,
    );
    expect(fn.getText(after), `independent original ${name}`).toBe(exactFunction(before, name).getText(before));
  }
  return restored;
}

function replaceOne(text: string, before: string, after: string): string {
  expect(text.split(before), `one mutation target ${before}`).toHaveLength(2);
  const changed = text.replace(before, after);
  expect(changed).not.toBe(text);
  return changed;
}

describe("independently authenticated string/Error extraction in the vector registry", () => {
  it("reconstructs both unchanged original receipts from all eight live factory payloads", () => {
    const restored = verifyLayoutInverse();
    expect(restored).not.toBe(read("registry"));
    expect(layoutForward().factories).toHaveLength(8);
  });
  it.each([
    [
      "createErrorStructType",
      '{ name: "stack", type: { kind: "externref" }, mutable: true }',
      '{ name: "stack", type: { kind: "externref" }, mutable: false }',
    ],
    ["createStringDataType", 'element: { kind: "i16" }', 'element: { kind: "i8" }'],
    ["createAnyStringType", "mutable: false", "mutable: true"],
    ["createNativeStringType", "layout.nativeStrDataTypeIdx", "layout.anyStrTypeIdx"],
    [
      "createConsStringType",
      '{ name: "left", type: { kind: "ref", typeIdx: layout.anyStrTypeIdx }, mutable: true }',
      '{ name: "left", type: { kind: "ref", typeIdx: layout.anyStrTypeIdx }, mutable: false }',
    ],
    [
      "createHashedStringType",
      '{ name: "cacheProps", type: { kind: "anyref" }, mutable: true }',
      '{ name: "cacheProps", type: { kind: "externref" }, mutable: true }',
    ],
    ["createUtf8StringDataType", 'element: { kind: "i8" }', 'element: { kind: "i16" }'],
    [
      "createUtf8StringType",
      '{ name: "off", type: { kind: "i32" }, mutable: false }',
      '{ name: "off", type: { kind: "i32" }, mutable: true }',
    ],
  ])("detects changed live %s descriptor", (name, before, after) => {
    verifyLayoutInverse();
    const canonical = readRelative(layoutSourcePath),
      file = parse(canonical),
      fn = exactFunction(file, name!);
    const changed =
      canonical.slice(0, fn.getStart(file)) + replaceOne(fn.getText(file), before!, after!) + canonical.slice(fn.end);
    expect(() => verifyLayoutInverse(read("registry"), changed)).toThrow();
  });
  it.each([
    [
      "import source",
      'from "../../runtime/wasmgc/values/string-layouts.js";',
      'from "../../runtime/wasmgc/values/other-layouts.js";',
    ],
    ["import kind", "import {\n  createErrorStructType,", "import type {\n  createErrorStructType,"],
    ["layout argument", "createNativeStringType(ctx)", "createNativeStringType({ ...ctx })"],
    ["UTF8 condition", "if (ctx.utf8Storage)", "if (!ctx.utf8Storage)"],
    ["Error cache publication", "ctx.errorStructTypeIdx = idx;", "ctx.errorStructTypeIdx = 0;"],
  ])("rejects changed %s without accepting a new receipt", (_name, before, after) => {
    verifyLayoutInverse();
    expect(() => verifyLayoutInverse(replaceOne(read("registry"), before!, after!))).toThrow();
  });
  it("rejects a removed canonical factory", () => {
    verifyLayoutInverse();
    const canonical = readRelative(layoutSourcePath),
      file = parse(canonical),
      fn = exactFunction(file, "createErrorStructType");
    const changed = canonical.slice(0, fn.getStart(file)) + canonical.slice(fn.end);
    expect(changed).not.toBe(canonical);
    expect(() => verifyLayoutInverse(read("registry"), changed)).toThrow();
  });
  it("rejects an extra executable statement before the canonical return", () => {
    verifyLayoutInverse();
    const canonical = readRelative(layoutSourcePath);
    const changed = replaceOne(
      canonical,
      "export function createErrorStructType(): TypeDef {\n  return",
      "export function createErrorStructType(): TypeDef {\n  console.log('unexpected');\n  return",
    );
    expect(() => verifyLayoutInverse(read("registry"), changed)).toThrow("single return createErrorStructType");
  });
  it("rejects an unbound ctx read that would collide with the layout inverse", () => {
    verifyLayoutInverse();
    const canonical = readRelative(layoutSourcePath),
      file = parse(canonical),
      fn = exactFunction(file, "createNativeStringType");
    const changed =
      canonical.slice(0, fn.getStart(file)) +
      replaceOne(fn.getText(file), "layout.nativeStrDataTypeIdx", "ctx.nativeStrDataTypeIdx") +
      canonical.slice(fn.end);
    expect(() => verifyLayoutInverse(read("registry"), changed)).toThrow("unbound ctx in canonical layout payload");
  });
  it("rejects a differently quoted duplicate canonical namespace import", () => {
    verifyLayoutInverse();
    const changed =
      read("registry") + "\nimport * as extraLayouts from '../../runtime/wasmgc/values/string-layouts.js';\n";
    expect(changed).not.toBe(read("registry"));
    expect(() => verifyLayoutInverse(changed)).toThrow("one canonical ordinary layout import");
  });
});

describe("independently authenticated prepared registry addition", () => {
  it("inverts the exact ordered addition before checking the unchanged historical registry", () => {
    const restored = inversePreparedRegistry(read("registry"));
    expect(sha(restored)).toBe("8e30d0c98c75cb4feb3924050fe02a6e911eb0e9b459391ba2598fcd96b19979");
    verifyLayoutInverse();
  });
  const importMutations: [string, (source: string) => string][] = [
    [
      "missing Instr",
      (source) => replaceOne(source, preparedRegistryImport, preparedRegistryImport.replace(", Instr", "")),
    ],
    [
      "value import",
      (source) => replaceOne(source, preparedRegistryImport, preparedRegistryImport.replace("import type", "import")),
    ],
    [
      "retargeted import",
      (source) =>
        replaceOne(
          source,
          preparedRegistryImport,
          preparedRegistryImport.replace("../../ir/types.js", "../../ir/other.js"),
        ),
    ],
    [
      "renamed Instr",
      (source) =>
        replaceOne(source, preparedRegistryImport, preparedRegistryImport.replace("Instr,", "Instr as OtherInstr,")),
    ],
    ["duplicate decoded route", (source) => source + "\nimport type * as DuplicateIR from '../../ir/types.js';\n"],
    ["shadowed Instr binding", (source) => source + '\nimport type { Instr } from "./different-types.js";\n'],
  ];
  it.each(importMutations)("refuses the %s", (_name, mutate) => {
    inversePreparedRegistry(read("registry"));
    const mutated = mutate(read("registry"));
    expect(mutated).not.toBe(read("registry"));
    expect(() => inversePreparedRegistry(mutated)).toThrow();
  });
  const declarationMutations: [string, (source: string) => string][] = [
    [
      "missing declaration",
      (source) => {
        const record = JSON.parse(preparedRegistryFixtureText).spans[1];
        return replaceOne(source, record.after, record.before);
      },
    ],
    [
      "duplicated declaration span",
      (source) => {
        const record = JSON.parse(preparedRegistryFixtureText).spans[1];
        return replaceOne(source, record.after, record.after + record.after);
      },
    ],
    [
      "wrong brand",
      (source) => replaceOne(source, '{ op: "i32.const", value: TA_CTOR_BRAND },', '{ op: "i32.const", value: 0 },'),
    ],
    [
      "wrong brand field",
      (source) =>
        replaceOne(
          source,
          '{ op: "struct.get", typeIdx: taCtorTypeIdx, fieldIdx: 1 },',
          '{ op: "struct.get", typeIdx: taCtorTypeIdx, fieldIdx: 0 },',
        ),
    ],
    [
      "moved declaration",
      (source) => {
        const sf = parse(source),
          fn = exactFunction(sf, "taCtorIdentityTestInstrs");
        const text = fn.getFullText(sf);
        return text + replaceOne(source, text, "");
      },
    ],
  ];
  it.each(declarationMutations)("refuses the %s", (_name, mutate) => {
    inversePreparedRegistry(read("registry"));
    const mutated = mutate(read("registry"));
    expect(mutated).not.toBe(read("registry"));
    expect(() => inversePreparedRegistry(mutated)).toThrow();
  });
  it("refuses edited forward provenance without replacing the original receipts", () => {
    inversePreparedRegistry(read("registry"));
    expect(() => inversePreparedRegistry(read("registry"), preparedRegistryFixtureText + " ")).toThrow(
      "fixture digest mismatch",
    );
  });
});

describe("complete donor/registry preservation", () => {
  it.each(["donor", "registry"] as const)("retains every declaration and original order in %s", (key) => {
    const sf = parse(key === "registry" ? verifyLayoutInverse() : read(key)),
      declarations = sf.statements.filter((s) => !ts.isImportDeclaration(s));
    const name = (s: ts.Statement) =>
      ts.isVariableStatement(s)
        ? s.declarationList.declarations[0]!.name.getText(sf)
        : ts.isFunctionDeclaration(s)
          ? s.name?.text
          : undefined;
    expect(declarations.map(name)).toEqual(ORIGINAL_DECLARATIONS[key].map((r) => r.name));
    for (const receipt of ORIGINAL_DECLARATIONS[key])
      if (receipt.retained) {
        const declaration = declarations.find((s) => name(s) === receipt.name)!;
        expect(sha(declaration.getFullText(sf)), receipt.name).toBe(receipt.sha256);
      }
    expect(ORIGINAL_DECLARATIONS[key].filter((r) => r.retained)).toHaveLength(key === "donor" ? 8 : 27);
  });
  it.each(ADAPTER_SHAPES)("preserves %s %s allocation/cache/publication control flow", (key, name, expected) => {
    expect(sha(normalizedFunction(read(key), name))).toBe(expected);
  });
  it("pins exact closed-data selection and builder resource forwarding before normalization", () => {
    const sf = parse(read("donor")),
      fn = sf.statements.find(
        (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "ensureVecElemSet",
      )!;
    const statements = fn.body!.statements.filter(ts.isVariableStatement);
    const rows = statements.filter((s) =>
      ["gapFill", "{ locals, body }"].includes(s.declarationList.declarations[0]!.name.getText(sf)),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((s) => sha(s.getText(sf)))).toEqual([
      "41a7364246c28fb754a95e6b3f203a32209be89a64e18460d19551d8f71b8d93",
      "23960d6e026071292017b91ab91979116cfcddc0ffd6b09185f471a76675dd06",
    ]);
    expect(read("donor")).not.toContain("currentFunc");
  });
  it.each([
    ["donor", "ensureVecElemSet", "ctx.funcMap.set(name, funcIdx);", "ctx.funcMap.set(name, sigIdx);"],
    ["donor", "ensureVecElemSet", "if (existing !== undefined) return existing;", "if (existing) return existing;"],
    ["registry", "getOrRegisterVecType", "if (!ctx.suppressVecUsageFlag)", "if (ctx.suppressVecUsageFlag)"],
    [
      "registry",
      "getOrRegisterArrayType",
      "ctx.arrayTypeMap.set(cacheKey, idx);",
      "ctx.arrayTypeMap.set(elemKind, idx);",
    ],
  ] as const)("detects live adapter mutation in %s/%s", (key, name, before, after) => {
    const source = read(key);
    // Restrict the mutation to the named declaration, not an earlier sibling cache check.
    const sf = parse(source),
      fn = sf.statements.find(
        (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
      )!;
    const changed =
      source.slice(0, fn.pos) + source.slice(fn.pos, fn.end).replace(before, after) + source.slice(fn.end);
    expect(changed).not.toBe(source);
    expect(normalizedFunction(changed, name)).not.toBe(normalizedFunction(source, name));
  });
});

function context(standalone = true) {
  return createCodegenContext(createEmptyModule(), ts.createProgram([], {}).getTypeChecker(), { standalone });
}

describe("real legacy adapters retain dense and hole behavior", () => {
  it.each(["dense-externref", "dense-f64", "hole-global", "f64-hole"] as const)(
    "publishes the exact pure body and preserves cache hits: %s",
    (kind) => {
      const ctx = context();
      ctx.usesArrayHoles = kind === "hole-global" || kind === "f64-hole";
      const index =
        kind === "hole-global"
          ? getOrRegisterHoleyArrayType(ctx)
          : getOrRegisterVecType(ctx, kind === "dense-externref" ? "externref" : "f64");
      const carrier = ctx.mod.types[index]!;
      if (carrier.kind !== "struct") throw new Error("fixture carrier");
      const data = carrier.fields[1]!.type;
      if (data.kind !== "ref" && data.kind !== "ref_null") throw new Error("fixture backing array");
      const counts = { functions: ctx.mod.functions.length, globals: ctx.mod.globals.length };
      const id = ensureVecElemSet(ctx, index);
      expect(id).not.toBeNull();
      const fn = ctx.mod.functions.find((f) => f.name === "__vec_elem_set_" + index)!;
      expect(fn).toBeDefined();
      expect(ctx.mod.functions).toHaveLength(counts.functions + 1);
      const gapFill =
        kind === "hole-global"
          ? { kind: "hole-global" as const, globalIndex: ctx.holeGlobalIdx! }
          : kind === "f64-hole"
            ? { kind: "f64-hole" as const, bits: HOLE_F64_BITS }
            : { kind: "default" as const };
      expect({ body: fn.body, locals: fn.locals }).toEqual(
        buildVectorGrowStoreBody({
          carrierTypeIndex: kind === "hole-global" ? carrier.superTypeIdx! : index,
          arrayTypeIndex: data.typeIdx,
          exceptionTagIndex: ctx.exnTagIdx,
          gapFill,
        }),
      );
      expect(ctx.mod.globals.length - counts.globals).toBe(kind === "hole-global" ? 1 : 0);
      if (kind === "f64-hole") expect(ctx.f64HoleMarkerEmitted).toBe(true);
      const types = ctx.mod.types.length,
        tags = ctx.mod.tags.length,
        globals = ctx.mod.globals.length;
      expect(ensureVecElemSet(ctx, index)).toBe(id);
      expect(ctx.mod.types).toHaveLength(types);
      expect(ctx.mod.tags).toHaveLength(tags);
      expect(ctx.mod.globals).toHaveLength(globals);
      expect(ctx.mod.functions).toHaveLength(counts.functions + 1);
      expect(ctx.mod.functions.find((f) => f.name === fn.name)).toBe(fn);
    },
  );
  it("keeps hole allocation before tag/signature and publishes function before cache", () => {
    const ctx = context(),
      index = getOrRegisterHoleyArrayType(ctx),
      events: string[] = [];
    const typesPush = ctx.mod.types.push.bind(ctx.mod.types),
      globalsPush = ctx.mod.globals.push.bind(ctx.mod.globals);
    const tagsPush = ctx.mod.tags.push.bind(ctx.mod.tags),
      functionsPush = ctx.mod.functions.push.bind(ctx.mod.functions);
    const mapSet = ctx.funcMap.set.bind(ctx.funcMap);
    ctx.mod.types.push = (...items) => {
      events.push(...items.map((t) => "type:" + t.kind));
      return typesPush(...items);
    };
    ctx.mod.globals.push = (...items) => {
      events.push("hole-global");
      return globalsPush(...items);
    };
    ctx.mod.tags.push = (...items) => {
      events.push("tag");
      return tagsPush(...items);
    };
    ctx.mod.functions.push = (...items) => {
      events.push("function");
      return functionsPush(...items);
    };
    ctx.funcMap.set = (key, value) => {
      events.push("func-cache:" + key);
      return mapSet(key, value);
    };
    ensureVecElemSet(ctx, index);
    expect(events).toEqual([
      "type:struct",
      "hole-global",
      "type:func",
      "tag",
      "type:func",
      "function",
      "func-cache:__vec_elem_set_" + index,
    ]);
    events.length = 0;
    ensureVecElemSet(ctx, index);
    expect(events).toEqual([]);
  });
  it("preserves base/array/carrier descriptor and bookkeeping object ownership", () => {
    const ctx = context();
    const base = getOrRegisterVecBaseType(ctx);
    expect(ctx.mod.types[base]).toEqual(createVectorBaseType());
    for (const kind of ["f64", "externref", "i8_byte"] as const) {
      const element = kind === "i8_byte" ? { kind: "i8" as const } : { kind };
      const index = getOrRegisterVecType(ctx, kind, element),
        array = getOrRegisterArrayType(ctx, kind, element);
      expect(ctx.mod.types[array]).toEqual(createVectorBackingArrayType("__arr_" + kind, element));
      const expected = createVectorCarrierType({
        name: "__vec_" + kind,
        baseTypeIndex: base,
        arrayTypeIndex: array,
        ...(kind === "i8_byte" ? { final: true } : {}),
      });
      expect(ctx.mod.types[index]).toEqual(expected);
      expect(ctx.structMap.get(expected.name)).toBe(index);
      expect(ctx.typeIdxToStructName.get(index)).toBe(expected.name);
      expect(ctx.structFields.get(expected.name)).toEqual(expected.fields);
      const carrier = ctx.mod.types[index]!;
      if (carrier.kind !== "struct") throw new Error("fixture carrier");
      expect(ctx.structFields.get(expected.name)).not.toBe(carrier.fields);
    }
    expect(ctx.usesVecValue).toBe(true);
  });
  it("retains reference element normalization and distinct reference caches", () => {
    const ctx = context(),
      before = ctx.mod.types.length;
    const a = getOrRegisterArrayType(ctx, "ref", { kind: "ref", typeIdx: 901 });
    const b = getOrRegisterArrayType(ctx, "ref", { kind: "ref", typeIdx: 902 });
    expect(ctx.mod.types).toHaveLength(before + 2);
    expect(a).not.toBe(b);
    expect(ctx.mod.types[a]).toEqual(createVectorBackingArrayType("__arr_ref_901", { kind: "ref_null", typeIdx: 901 }));
    expect(getOrRegisterArrayType(ctx, "ref_null", { kind: "ref_null", typeIdx: 901 })).toBe(a);
  });
  it("retains invalid-carrier and packed-element refusals without allocation", () => {
    const ctx = context(),
      packed = getOrRegisterVecType(ctx, "i8_byte", { kind: "i8" });
    const types = ctx.mod.types.length,
      funcs = ctx.mod.functions.length;
    expect(ensureVecElemSet(ctx, -1)).toBeNull();
    expect(ensureVecElemSet(ctx, packed)).toBeNull();
    expect(ctx.mod.types).toHaveLength(types);
    expect(ctx.mod.functions).toHaveLength(funcs);
  });
  it("retains both untouched sized allocators and their caches", () => {
    const ctx = context(),
      dense = getOrRegisterVecType(ctx, "f64");
    const first = ensureVecNewSized(ctx, dense),
      holey = ensureHoleyArrayNew(ctx);
    expect(first).not.toBeNull();
    expect(holey).not.toBe(first);
    const count = ctx.mod.functions.length;
    expect(ensureVecNewSized(ctx, dense)).toBe(first);
    expect(ensureHoleyArrayNew(ctx)).toBe(holey);
    expect(ctx.mod.functions).toHaveLength(count);
  });
});
