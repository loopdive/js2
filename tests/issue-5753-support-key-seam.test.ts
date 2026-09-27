// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as core from "../src/ir/core/support-key.js";
import * as planner from "../src/codegen/program-abi-type-planning.js";
import { canonicalProgramAbiValType } from "../src/wasm/model/abi-value-key.js";
import { canonicalProgramAbiValType as oldValueExport } from "../src/codegen/program-abi-signatures.js";
import { ProgramAbiInvariantError } from "../src/shared/contracts/program-abi-error.js";
import { irTypeBindingKey } from "../src/ir/core/type-binding-keys.js";
import { irCallableBindingKey, irFnctorConstructorFuncRef } from "../src/ir/core/callable-bindings.js";
import { orderedObjectFields } from "../src/ir/core/object-layout.js";
import { irSupportRef, type IrType, type IrClosureSignature } from "../src/ir/core/types.js";
import { irSupportTypeRef } from "../src/ir/core/type-references.js";
import { createIrSourceId, createIrUnitId, createIrClassId } from "../src/ir/identity.js";
import type { ValType } from "../src/wasm/model/instructions.js";

const root = resolve(import.meta.dirname, "..");
const base = "b7521221b4b7ca22f95d28671314d785815cb4f0";
// Source receipts measured at C = 634a5e1e1b89a28fbbfa76a8e6c971742f825d11.
// Use its committed source donor so the uncommitted C tree need not survive integration.
const plannerPath = "src/codegen/program-abi-type-planning.ts";
const valuePath = "src/codegen/program-abi-signatures.ts";
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const blob = (revision: string, path: string) =>
  execFileSync("git", ["show", `${revision}:${path}`], { cwd: root, encoding: "utf8" });
function section(source: string, start: string, end: string) {
  expect(source.split(start)).toHaveLength(2);
  expect(source.split(end)).toHaveLength(2);
  return source.slice(source.indexOf(start), source.indexOf(end)).trim();
}
const originalPlanner = blob(base, plannerPath);
const originalValue = blob(base, valuePath);
const supportBody = section(
  originalPlanner,
  "function canonicalClosureSupportIrType",
  "/** True when every index-bearing",
);
const valueBody = section(
  originalValue,
  "export function canonicalProgramAbiValType",
  "function canonicalProgramAbiField",
);
const names = [
  "canonicalProgramAbiClosureSignatureKey",
  "canonicalProgramAbiClosureLayoutKey",
  "canonicalProgramAbiRefCellKey",
  "canonicalProgramAbiObjectShapeKey",
] as const;
// Execute the pinned pre-relocation bodies, never the new compatibility exports.
const js = ts.transpileModule(valueBody + "\n" + supportBody, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const old = new Function(
  "exports",
  "ProgramAbiInvariantError",
  "irTypeBindingKey",
  "irCallableBindingKey",
  "orderedObjectFields",
  js + "\nreturn exports;",
)({}, ProgramAbiInvariantError, irTypeBindingKey, irCallableBindingKey, orderedObjectFields) as Pick<
  typeof core,
  (typeof names)[number]
> & { canonicalProgramAbiValType: typeof canonicalProgramAbiValType };

const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "support-seam.ts" });
const unitId = createIrUnitId({ sourceId, lexicalOwnerId: null, kind: "top-level-function", ordinal: 0 });
const classId = createIrClassId({ sourceId, lexicalOwnerId: null, declarationKind: "declaration", ordinal: 0 });
const ref = irSupportTypeRef(unitId, "seam", "display");
const scalar: IrType = { kind: "val", val: { kind: "i32" } };
const signature: IrClosureSignature = { params: [scalar], returnType: null };
function object(type: IrType): Extract<IrType, { kind: "object" }> {
  return { kind: "object", shape: { fields: [{ name: "value", type }] } };
}
function result(fn: () => unknown) {
  try {
    return { value: fn() };
  } catch (error) {
    return {
      error,
      constructor: (error as Error).constructor,
      name: (error as Error).name,
      code: (error as ProgramAbiInvariantError).code,
      message: (error as Error).message,
    };
  }
}
function parity(type: IrType) {
  const calls = [
    () => [old.canonicalProgramAbiRefCellKey(type), core.canonicalProgramAbiRefCellKey(type)],
    () => [old.canonicalProgramAbiObjectShapeKey(object(type)), core.canonicalProgramAbiObjectShapeKey(object(type))],
    () => [
      old.canonicalProgramAbiClosureSignatureKey({ params: [type], returnType: type }),
      core.canonicalProgramAbiClosureSignatureKey({ params: [type], returnType: type }),
    ],
    () => [
      old.canonicalProgramAbiClosureLayoutKey(signature, [type, type], "authority"),
      core.canonicalProgramAbiClosureLayoutKey(signature, [type, type], "authority"),
    ],
  ];
  for (const call of calls) {
    const [before, after] = call();
    expect(after).toBe(before);
  }
}
const vals: ValType[] = [
  { kind: "i32" },
  { kind: "i32", boolean: true },
  { kind: "i32", symbol: true },
  { kind: "i32", boolean: true, symbol: true },
  { kind: "i64" },
  { kind: "i64", bigint: false },
  { kind: "i64", bigint: true },
  { kind: "f32" },
  { kind: "f64" },
  { kind: "f64", undefSentinel: true },
  { kind: "v128" },
  { kind: "i8" },
  { kind: "i16" },
  { kind: "funcref" },
  { kind: "externref" },
  { kind: "ref_extern" },
  { kind: "eqref" },
  { kind: "anyref" },
];
const variants: [string, IrType][] = [
  ...vals.map((val, i): [string, IrType] => [`scalar ${i} ${val.kind}`, { kind: "val", val }]),
  ["unsigned", { kind: "val", val: { kind: "i32" }, signed: false }],
  ["explicit signed", { kind: "val", val: { kind: "i32" }, signed: true }],
  ["symbolic ref", { kind: "val", val: { kind: "ref", typeIdx: 3 }, typeRef: ref }],
  ["symbolic nullable ref", { kind: "val", val: { kind: "ref_null", typeIdx: 9 }, typeRef: ref }],
  ["string", { kind: "string" }],
  ["vector", { kind: "vec", elementType: scalar, nullable: false }],
  ["nullable vector", { kind: "vec", elementType: scalar, nullable: true }],
  ["object", object(scalar)],
  [
    "declared ordered methods",
    {
      kind: "object",
      shape: {
        allocationKind: "declared",
        fields: [
          { name: "a", type: scalar, sourceMethodSignature: "method-a" },
          { name: "b", type: { kind: "string" } },
        ],
        fieldOrder: ["b", "a"],
      },
    },
  ],
  ["closure", { kind: "closure", signature }],
  ["callable", { kind: "callable", signature: { params: [], returnType: scalar } }],
  ["class", { kind: "class", shape: { classId, className: "Nominal", fields: [], methods: [] } }],
  ["extern", { kind: "extern", className: "Date" }],
  [
    "fnctor",
    {
      kind: "fnctor",
      shape: {
        kind: "fnctor-shape",
        sourceId,
        constructorUnitId: unitId,
        constructorName: "Ctor",
        constructorTarget: irFnctorConstructorFuncRef(unitId, "Ctor"),
        reservedLayout: ref,
        fields: [],
        captures: [],
        userParamTypes: [],
        hiddenIdentity: false,
        constructorIdentity: { unitId, paramIndex: 0 },
      },
    },
  ],
  ["union order", { kind: "union", members: [scalar, { kind: "string" }, scalar] }],
  ["boxed", { kind: "boxed", inner: scalar }],
  ["dynamic default", { kind: "dynamic" }],
  ["dynamic tag", { kind: "dynamic", tag: 7 as Extract<IrType, { kind: "dynamic" }>["tag"] }],
];

const supportRefArm =
  '      case "support-ref":\n        if (type.ref?.kind !== "type" || type.ref.binding?.kind !== "support" || typeof type.nullable !== "boolean") {\n          throw new ProgramAbiInvariantError(\n            "type-remap-mismatch",\n            "support-ref requires a support type reference and boolean nullability",\n          );\n        }\n        try {\n          return { kind: "support-ref", typeRef: irTypeBindingKey(type.ref.binding), nullable: type.nullable };\n        } catch {\n          throw new ProgramAbiInvariantError("type-remap-mismatch", "support-ref has an invalid support type binding");\n        }\n';
const unknownKindArm =
  '      default: {\n        const exhaustive: never = type;\n        throw new ProgramAbiInvariantError(\n          "type-remap-mismatch",\n          `unknown closure support IR type kind ${(exhaustive as { kind?: unknown }).kind ?? "<missing>"}`,\n        );\n      }\n';
function verifySupportDelta(source: string) {
  expect(source.split(supportRefArm)).toHaveLength(2);
  expect(source.split(unknownKindArm)).toHaveLength(2);
  const restored = source.replace(supportRefArm, "").replace(unknownKindArm, "");
  expect(restored.slice(restored.indexOf("function canonicalClosureSupportIrType")).trim()).toBe(supportBody);
}
describe("support key mechanical relocation", () => {
  it("pins the independent old C implementation and exact relocated bodies", () => {
    expect(createHash("sha256").update(originalPlanner).digest("hex")).toBe(
      "4475f4faf2e05e5db84f3d233382a6bd5f6ffa027a1f5746248f2936afb36f21",
    );
    expect(createHash("sha256").update(originalValue).digest("hex")).toBe(
      "70e64b2f5e88f6d19bd2e532d3c4bae3b54301a3d8bbd506f174d85aeec8cd73",
    );
    verifySupportDelta(read("src/ir/core/support-key.ts"));
    expect(
      read("src/wasm/model/abi-value-key.ts")
        .slice(read("src/wasm/model/abi-value-key.ts").indexOf("export function canonicalProgramAbiValType"))
        .trim(),
    ).toBe(valueBody);
  });
  it("preserves all public function identities and connects the actual object allocator", () => {
    for (const name of names) expect(planner[name]).toBe(core[name]);
    expect(oldValueExport).toBe(canonicalProgramAbiValType);
    const integration = read("src/ir/integration.ts");
    expect(integration).toContain('import { canonicalProgramAbiObjectShapeKey } from "./core/support-key.js";');
    expect(integration).toContain('const key = canonicalProgramAbiObjectShapeKey({ kind: "object", shape });');
    expect(integration).not.toContain('from "../codegen/program-abi-type-planning.js"');
    expect((integration.match(/from ["']\.\.\/codegen\//g) ?? []).length).toBeLessThanOrEqual(45);
  });
  it.each(variants)("preserves exact bytes for %s in every public context", (_name, type) => parity(type));
  it.each([...vals, { kind: "ref", typeIdx: 1 }, { kind: "ref_null", typeIdx: 4 }] as ValType[])(
    "preserves Wasm value bytes for %j",
    (val) => {
      expect(canonicalProgramAbiValType(val)).toBe(old.canonicalProgramAbiValType(val));
    },
  );
  it("preserves null result, DOM suffix, shared acyclic objects, and remapped physical refs", () => {
    for (const returnType of [null, scalar])
      for (const authority of [undefined, "", "dom-authority"]) {
        const sig = { params: [scalar, scalar], returnType };
        expect(core.canonicalProgramAbiClosureLayoutKey(sig, [scalar, scalar], authority)).toBe(
          old.canonicalProgramAbiClosureLayoutKey(sig, [scalar, scalar], authority),
        );
      }
    const physical = (index: number, name: string): IrType => ({
      kind: "val",
      val: { kind: "ref", typeIdx: index },
      typeRef: { ...ref, name },
    });
    expect(core.canonicalProgramAbiRefCellKey(physical(1, "a"))).toBe(
      core.canonicalProgramAbiRefCellKey(physical(99, "b")),
    );
  });
  it("preserves exact existing refusal constructors, codes and messages", () => {
    const recursive = object(scalar);
    (recursive.shape.fields as { name: string; type: IrType }[]).push({ name: "self", type: recursive });
    const sig: IrClosureSignature = { params: [], returnType: null };
    (sig.params as IrType[]).push({ kind: "closure", signature: sig });
    const invalid: IrType[] = [
      { kind: "val", val: { kind: "ref", typeIdx: 0 } },
      { kind: "val", val: { kind: "ref_null", typeIdx: 0 } },
      { kind: "val", val: { kind: "i32" }, typeRef: ref },
      recursive,
      { kind: "closure", signature: sig },
    ];
    for (const type of invalid) {
      const before = result(() => old.canonicalProgramAbiRefCellKey(type));
      const after = result(() => core.canonicalProgramAbiRefCellKey(type));
      expect(before.error).toBeInstanceOf(ProgramAbiInvariantError);
      expect(after.constructor).toBe(before.constructor);
      expect(after.name).toBe(before.name);
      expect(after.code).toBe(before.code);
      expect(after.message).toBe(before.message);
    }
  });
  it("accepts nominal recursive carriers without traversing their fields", () => {
    for (const [, type] of variants.filter(([, type]) => type.kind === "class" || type.kind === "fnctor")) {
      if (type.kind !== "class" && type.kind !== "fnctor") throw new Error("invalid nominal fixture");
      (type.shape.fields as { name: string; type: IrType }[]).push({ name: "self", type });
      parity(type);
    }
  });
});

describe("original support-ref identity loss (retained historical failure)", () => {
  const support = irSupportRef(ref, false);
  it("old top-level payload silently returns undefined", () => {
    expect(old.canonicalProgramAbiRefCellKey(support)).toBeUndefined();
  });
  it("old object field silently omits its type", () => {
    expect(old.canonicalProgramAbiObjectShapeKey(object(support))).toBe(
      '{"kind":"object","fields":[{"name":"value"}]}',
    );
  });
  it("old capture silently becomes JSON null", () => {
    expect(old.canonicalProgramAbiClosureLayoutKey({ params: [], returnType: null }, [support])).toBe(
      '{"signature":{"params":[],"returnType":null},"captures":[null]}',
    );
  });
});

describe("explicit support-ref repair", () => {
  const supportRefs = [ref, irSupportTypeRef(unitId, "other-seam", "display")];
  const cases = supportRefs.flatMap((ref) => [false, true].map((nullable) => irSupportRef(ref, nullable)));
  const placements: [string, (type: IrType) => string, (payload: object) => string][] = [
    ["ref-cell payload", core.canonicalProgramAbiRefCellKey, (payload) => JSON.stringify(payload)],
    [
      "object field",
      (type) => core.canonicalProgramAbiObjectShapeKey(object(type)),
      (payload) => JSON.stringify({ kind: "object", fields: [{ name: "value", type: payload }] }),
    ],
    [
      "closure parameter",
      (type) => core.canonicalProgramAbiClosureSignatureKey({ params: [type], returnType: null }),
      (payload) => JSON.stringify({ params: [payload], returnType: null }),
    ],
    [
      "closure result",
      (type) => core.canonicalProgramAbiClosureSignatureKey({ params: [], returnType: type }),
      (payload) => JSON.stringify({ params: [], returnType: payload }),
    ],
    [
      "capture array",
      (type) => core.canonicalProgramAbiClosureLayoutKey({ params: [], returnType: null }, [type, type]),
      (payload) => JSON.stringify({ signature: { params: [], returnType: null }, captures: [payload, payload] }),
    ],
    [
      "union nesting",
      (type) => core.canonicalProgramAbiRefCellKey({ kind: "union", members: [type, type] }),
      (payload) => JSON.stringify({ kind: "union", members: [payload, payload] }),
    ],
    [
      "boxed nesting",
      (type) => core.canonicalProgramAbiRefCellKey({ kind: "boxed", inner: { kind: "boxed", inner: type } }),
      (payload) => JSON.stringify({ kind: "boxed", inner: { kind: "boxed", inner: payload } }),
    ],
  ];
  it.each(placements)("retains exact new grammar, identity and nullability in %s", (_name, serialize, expected) => {
    const keys = cases.map((type) => {
      const key = serialize(type);
      expect(key).toBe(
        expected({ kind: "support-ref", typeRef: irTypeBindingKey(type.ref.binding), nullable: type.nullable }),
      );
      const renamed = irSupportRef({ ...type.ref, name: "renamed compatibility label" }, type.nullable);
      expect(serialize(renamed)).toBe(key);
      return key;
    });
    expect(new Set(keys).size).toBe(4);
  });
  it.each([
    ["missing reference", { ref: undefined }],
    ["wrong reference kind", { ref: { ...ref, kind: "func" } }],
    ["missing binding", { ref: { ...ref, binding: undefined } }],
    ["source binding", { ref: { ...ref, binding: { ...ref.binding, kind: "source" } } }],
    ["runtime binding", { ref: { ...ref, binding: { ...ref.binding, kind: "runtime", symbol: "x" } } }],
    ["empty binding ID", { ref: { ...ref, binding: { ...ref.binding, bindingId: "" } } }],
    ["foreign binding domain", { ref: { ...ref, binding: { ...ref.binding, bindingId: "ir-binding:v1:global:x" } } }],
    ["non-string binding ID", { ref: { ...ref, binding: { ...ref.binding, bindingId: 3 } } }],
    ["missing nullability", { nullable: undefined }],
    ["numeric nullability", { nullable: 0 }],
    ["string nullability", { nullable: "false" }],
  ])("rejects malformed support-ref: %s after a valid positive", (_name, delta) => {
    const valid = irSupportRef(ref, false);
    expect(core.canonicalProgramAbiRefCellKey(valid)).toBe(
      JSON.stringify({ kind: "support-ref", typeRef: irTypeBindingKey(ref.binding), nullable: false }),
    );
    const malformed = { ...valid, ...delta } as unknown as IrType;
    for (const [, serialize] of placements) {
      const failure = result(() => serialize(malformed));
      expect(failure.error).toBeInstanceOf(ProgramAbiInvariantError);
      expect(failure.code).toBe("type-remap-mismatch");
    }
  });
  it.each(["future-kind", undefined, 3])("exhaustively refuses unknown IR kind %s", (kind) => {
    const type = { kind } as unknown as IrType;
    expect(old.canonicalProgramAbiRefCellKey(type)).toBeUndefined();
    const failure = result(() => core.canonicalProgramAbiRefCellKey(type));
    expect(failure.error).toBeInstanceOf(ProgramAbiInvariantError);
    expect(failure.code).toBe("type-remap-mismatch");
    expect(failure.message).toBe(`unknown closure support IR type kind ${kind ?? "<missing>"}`);
  });
  it("rejects mutations both inside and outside the explicitly reviewed repair", () => {
    const source = read("src/ir/core/support-key.ts");
    verifySupportDelta(source);
    expect(() =>
      verifySupportDelta(source.replace('kind: "support-ref", typeRef:', 'kind: "support-ref", wrong:')),
    ).toThrow();
    expect(() =>
      verifySupportDelta(source.replace("signed: type.signed ?? true", "signed: type.signed ?? false")),
    ).toThrow();
  });
});

const allowed = [
  "src/ir/core/support-key.ts",
  "src/ir/core/types.ts",
  "src/ir/core/type-binding-keys.ts",
  "src/ir/core/callable-bindings.ts",
  "src/ir/core/object-layout.ts",
  "src/ir/core/binding-key-primitives.ts",
  "src/ir/core/fnctor-shapes.ts",
  "src/ir/core/value-references.ts",
  "src/ir/core/tag-refinement.ts",
  "src/ir/core/capability-provenance.ts",
  "src/shared/contracts/identity-values.ts",
  "src/shared/contracts/ir-identity.ts",
  "src/shared/contracts/source-origin.ts",
  "src/shared/contracts/program-abi-error.ts",
  "src/wasm/model/abi-value-key.ts",
  "src/wasm/model/instructions.ts",
].sort();
function closure(injection = "") {
  const visited = new Set<string>();
  const visit = (path: string) => {
    if (!allowed.includes(path)) throw new Error("forbidden dependency: " + path);
    if (visited.has(path)) return;
    visited.add(path);
    const source = ts.createSourceFile(
      path,
      read(path) + (path.endsWith("support-key.ts") ? injection : ""),
      ts.ScriptTarget.Latest,
      true,
    );
    if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length > 0) {
      throw new Error("unknown dependency: invalid syntax");
    }
    const walk = (node: ts.Node) => {
      let spec: ts.Node | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier;
      if (ts.isImportTypeNode(node)) {
        if (!ts.isLiteralTypeNode(node.argument)) throw new Error("unknown dependency");
        spec = node.argument.literal;
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      )
        spec = node.arguments[0];
      if (spec) {
        if (!ts.isStringLiteral(spec) || !spec.text.startsWith(".")) throw new Error("unknown dependency");
        visit(relative(root, resolve(root, dirname(path), spec.text.replace(/\.js$/, ".ts"))));
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  };
  visit("src/ir/core/support-key.ts");
  return [...visited].sort();
}
describe("support serializer dependency closure", () => {
  it("loads and executes only the exact runtime leaves in a fresh process", () => {
    const runtime = [
      "src/ir/core/support-key.ts",
      "src/ir/core/type-binding-keys.ts",
      "src/ir/core/binding-key-primitives.ts",
      "src/ir/core/callable-bindings.ts",
      "src/ir/core/object-layout.ts",
      "src/shared/contracts/identity-values.ts",
      "src/shared/contracts/program-abi-error.ts",
      "src/wasm/model/abi-value-key.ts",
    ].sort();
    const script = `
      import { registerHooks } from "node:module";
      import { fileURLToPath } from "node:url";
      import { realpathSync } from "node:fs";
      import { relative } from "node:path";
      const root = realpathSync(process.cwd());
      const allowed = new Set(${JSON.stringify(runtime)});
      const visited = new Set();
      registerHooks({ resolve(specifier, context, next) {
        const resolved = next(specifier, context);
        if (!resolved.url.startsWith("file:")) throw new Error("forbidden runtime dependency");
        const path = relative(root, realpathSync(fileURLToPath(resolved.url)));
        if (!allowed.has(path)) throw new Error("forbidden runtime dependency: " + path);
        visited.add(path);
        return resolved;
      }});
      const core = await import("./src/ir/core/support-key.ts");
      const key = core.canonicalProgramAbiRefCellKey({ kind: "string" });
      console.log(JSON.stringify({ key, visited: [...visited].sort() }));
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ key: '{"kind":"string"}', visited: runtime });
  });
  it("pins the full type and value closure", () => expect(closure()).toEqual(allowed));
  it.each([
    'import type { CodegenContext } from "../../codegen/context/types.js";',
    'export * from "../program/abi.js";',
    'import "../nodes.js";',
    'import "../../ts-api.js";',
    "const hidden = import(variable);",
    "import {",
  ])("rejects injected dependency %s after a valid positive", (injection) => {
    expect(closure()).toEqual(allowed);
    expect(() => closure(injection)).toThrow(/dependency/);
  });
});
