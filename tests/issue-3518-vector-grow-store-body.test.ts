// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  buildVectorGrowStoreBody,
  createVectorBaseType,
  createVectorBackingArrayType,
  createVectorCarrierType,
  type VectorGrowStoreGapFill,
} from "../src/runtime/wasmgc/values/vector-grow-store.js";
import type { Instr, LocalDef } from "../src/wasm/model/instructions.js";

const read = () => readFileSync(new URL("../src/runtime/wasmgc/values/vector-grow-store.ts", import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const parse = (text: string) => ts.createSourceFile("vector.ts", text, ts.ScriptTarget.Latest, true);

/** Recover the exact old expression, then authenticate against pre-extraction receipts.
 * No historical Git object, legacy context, or hand-maintained duplicate builder is required.
 */
function donorExpressions(text = read()) {
  const sf = parse(text);
  const functions = sf.statements.filter(ts.isFunctionDeclaration);
  expect(functions.map((fn) => fn.name!.text)).toEqual([
    "gapFillInstructions",
    "buildVectorGrowStoreBody",
    "createVectorBaseType",
    "createVectorBackingArrayType",
    "createVectorCarrierType",
  ]);
  const fn = functions.find((fn) => fn.name!.text === "buildVectorGrowStoreBody")!;
  expect(fn.asteriskToken).toBeUndefined();
  expect(fn.modifiers?.map((m) => m.kind)).toEqual([ts.SyntaxKind.ExportKeyword]);
  expect(fn.parameters.map((p) => p.getText(sf))).toEqual(["resources: VectorGrowStoreResources"]);
  expect(fn.type?.getText(sf)).toBe("{ locals: LocalDef[]; body: Instr[] }");
  const statements = fn.body!.statements;
  const name = (s: ts.Statement) =>
    ts.isVariableStatement(s) ? s.declarationList.declarations[0]!.name.getText(sf) : undefined;
  const first = statements.findIndex((s) => name(s) === "VEC"),
    last = statements.findIndex((s) => name(s) === "body");
  expect(statements.slice(first, last + 1).map(name)).toEqual([
    "VEC",
    "IDX",
    "VAL",
    "DATA",
    "NCAP",
    "NDATA",
    "OCAP",
    "OLEN",
    "body",
  ]);
  const movedConstruction = statements
    .slice(first, last + 1)
    .map((s) => s.getFullText(sf))
    .join("")
    .replaceAll("hasGapFill", "holeyCarrier || f64HoleCarrier");
  // The donor had one additional blank line after function reservation.
  // Restore only that extraction-boundary byte, not arbitrary whitespace.
  const construction = "\n" + movedConstruction;
  expect(sha(construction)).toBe("68501b8e4599a28a8be525081a0a892a007f7eda34dc5c672054fd900f9b8cf4");
  const returns = statements.filter(ts.isReturnStatement);
  expect(returns).toHaveLength(1);
  const result = returns[0]!.expression!;
  if (!ts.isObjectLiteralExpression(result)) throw new Error("expected exact local/body record");
  expect(result.properties.map((p) => p.name?.getText(sf))).toEqual(["locals", "body"]);
  const property = result.properties[0]!;
  if (!ts.isPropertyAssignment(property)) throw new Error("expected explicit locals");
  const locals = property.initializer.getText(sf).replaceAll("hasGapFill", "holeyCarrier || f64HoleCarrier");
  expect(sha(locals)).toBe("28423084cec961f57ece3591ea8f431141e68083162b2e5d354dc3be1522a883");
  return { construction, locals };
}

function originalBody(fill: VectorGrowStoreGapFill, indices: readonly [number, number, number]) {
  const { construction, locals } = donorExpressions();
  const js = ts.transpileModule(`${construction}\nreturn {locals: ${locals}, body};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const original = new Function(
    "carrierTypeIdx",
    "arrTypeIdx",
    "tagIdx",
    "holeyCarrier",
    "f64HoleCarrier",
    "gapFillInit",
    js,
  );
  const gap: Instr[] =
    fill.kind === "default"
      ? []
      : fill.kind === "hole-global"
        ? [{ op: "global.get", index: fill.globalIndex }, { op: "extern.convert_any" }]
        : [{ op: "i64.const", value: fill.bits }, { op: "f64.reinterpret_i64" }];
  return original(...indices, fill.kind === "hole-global", fill.kind === "f64-hole", gap) as {
    locals: LocalDef[];
    body: Instr[];
  };
}

const fills: readonly VectorGrowStoreGapFill[] = [
  { kind: "default" },
  { kind: "hole-global", globalIndex: 17 },
  { kind: "f64-hole", bits: 0x7ff8000000000001n },
];

describe("exact vector donor body and local construction", () => {
  it("pins complete expression/local receipts and declaration headers", () => {
    donorExpressions();
  });
  it.each(["async function buildVectorGrowStoreBody", "function* buildVectorGrowStoreBody"])(
    "rejects changed canonical header %s",
    (header) => {
      expect(() => donorExpressions(read().replace("function buildVectorGrowStoreBody", header))).toThrow();
    },
  );
  it.each(["i32.ge_s", "array.copy", "$ocap"])("rejects live donor mutation %s", (token) => {
    expect(() => donorExpressions(read().replace(token, token + "_changed"))).toThrow();
  });
  it.each(
    fills.flatMap((fill) =>
      [
        [4, 8, 3],
        [41, 22, 0],
      ].map((indices) => ({ fill, indices })),
    ),
  )("matches the old complete body for $fill.kind at $indices", ({ fill, indices }) => {
    const coordinates = indices as [number, number, number];
    const current = buildVectorGrowStoreBody({
      carrierTypeIndex: coordinates[0],
      arrayTypeIndex: coordinates[1],
      exceptionTagIndex: coordinates[2],
      gapFill: fill,
    });
    expect(current).toEqual(originalBody(fill, coordinates));
    expect(current.locals.map((l) => l.name)).toEqual(
      fill.kind === "default"
        ? ["$data", "$ncap", "$ndata", "$ocap"]
        : ["$data", "$ncap", "$ndata", "$ocap", "$oldlen"],
    );
  });
  it("returns independent fresh output without mutating frozen resource data", () => {
    const resources = Object.freeze({
      carrierTypeIndex: 5,
      arrayTypeIndex: 7,
      exceptionTagIndex: 2,
      gapFill: Object.freeze({ kind: "default" as const }),
    });
    const first = buildVectorGrowStoreBody(resources),
      second = buildVectorGrowStoreBody(resources);
    expect(first).toEqual(second);
    expect(first.body).not.toBe(second.body);
    expect(first.locals).not.toBe(second.locals);
    first.body.pop();
    first.locals.pop();
    expect(second).toEqual(originalBody(resources.gapFill, [5, 7, 2]));
  });
  it("has only type imports from the physical model and no context/runtime dependency", () => {
    const imports = parse(read()).statements.filter(ts.isImportDeclaration);
    expect(imports.map((i) => [i.importClause?.isTypeOnly, i.moduleSpecifier.getText()])).toEqual([
      [true, '"../../../wasm/model/instructions.js"'],
      [true, '"../../../wasm/model/module-records.js"'],
    ]);
    expect(read()).not.toMatch(/CodegenContext|currentFunc|process\.|globalThis\./);
  });
});

describe("shared vector type descriptors", () => {
  it("preserves the one open mutable length-prefix base", () => {
    expect(createVectorBaseType()).toEqual({
      kind: "struct",
      name: "__vec_base",
      superTypeIdx: -1,
      fields: [{ name: "length", type: { kind: "i32" }, mutable: true }],
    });
    expect(createVectorBaseType()).not.toBe(createVectorBaseType());
  });
  it.each(["externref", "f64", "i32", "i8"] as const)("preserves exact backing-array element %s", (kind) => {
    const element = { kind };
    const descriptor = createVectorBackingArrayType(`__arr_${kind}`, element);
    expect(descriptor).toEqual({ kind: "array", name: `__arr_${kind}`, element, mutable: true });
    expect(descriptor.element).toBe(element);
  });
  it.each([undefined, false, true])(
    "preserves carrier metadata final=%s without inventing missing properties",
    (final) => {
      const descriptor = createVectorCarrierType({
        name: "__vec_test",
        baseTypeIndex: 2,
        arrayTypeIndex: 6,
        ...(final === undefined ? {} : { final }),
      });
      expect(descriptor).toEqual({
        kind: "struct",
        name: "__vec_test",
        superTypeIdx: 2,
        ...(final === undefined ? {} : { final }),
        fields: [
          { name: "length", type: { kind: "i32" }, mutable: true },
          { name: "data", type: { kind: "ref", typeIdx: 6 }, mutable: true },
        ],
      });
      expect(Object.hasOwn(descriptor, "final")).toBe(final !== undefined);
    },
  );
});
