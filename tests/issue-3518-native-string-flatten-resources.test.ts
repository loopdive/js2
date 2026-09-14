// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  projectDecoder,
  projectCopyTreeUtf8,
  projectFlattenAdapterStaging,
} from "../scripts/verify-native-scanner-source-preservation.mjs";
import { nativeStringFlattenDonor } from "./fixtures/issue-3518-native-string-flatten-donor.js";
import { createEmptyModule } from "../src/ir/types.js";
import type { Instr } from "../src/wasm/model/instructions.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  reserveNativeStringLiteralResources,
  fillNativeStringLiteralResources,
  requireNativeStringLiteral,
} from "../src/backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeStringFlattenResources,
  fillNativeStringFlattenResources,
  requireNativeStringFlattenReservations,
  requireCompletedNativeStringFlatten,
} from "../src/backend/wasmgc/resources/native-string-flatten.js";

const read = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
function projectedFlattenSource(path: string, project: typeof projectCopyTreeUtf8): string {
  const url = new URL("../" + path, import.meta.url).href;
  return project(read(path), url, url, (s: string) => createHash("sha256").update(s).digest("hex")).text;
}
const parse = (text: string) => ts.createSourceFile("receipt.ts", text, ts.ScriptTarget.Latest, true);
function functionNode(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const fn = sf.statements.find(
    (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name,
  );
  if (!fn?.body) throw Error("missing canonical root " + name);
  return fn;
}
function declaration(block: ts.Block, name: string): ts.VariableStatement {
  const n = block.statements.find(
    (n): n is ts.VariableStatement =>
      ts.isVariableStatement(n) &&
      n.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name),
  );
  if (!n) throw Error("missing declaration " + name);
  return n;
}
// Parser-owned tokens handle template literals; comments are collected at every
// node boundary, deduplicated by source span, including trailing/EOF comments.
function receipt(text: string): string {
  const sf = parse(text),
    tokens: string[] = [],
    comments = new Map<number, string>();
  const visit = (node: ts.Node) => {
    for (const pos of [node.pos, node.end, node.getFullStart()])
      for (const range of [
        ...(ts.getLeadingCommentRanges(text, pos) ?? []),
        ...(ts.getTrailingCommentRanges(text, pos) ?? []),
      ])
        comments.set(range.pos, text.slice(range.pos, range.end));
    const children = node.getChildren(sf);
    if (
      !children.length &&
      node.kind !== ts.SyntaxKind.EndOfFileToken &&
      ![ts.SyntaxKind.CommaToken, ts.SyntaxKind.SemicolonToken].includes(node.kind)
    )
      tokens.push(node.getText(sf));
    else children.forEach(visit);
  };
  visit(sf);
  return JSON.stringify({ tokens, comments: [...comments.values()].sort() });
}

function reconstruct(adapter: string, flatten: string, decoder: string): string {
  const sf = parse(adapter),
    cf = parse(flatten),
    uf = parse(
      projectDecoder(
        decoder,
        "/src/runtime/wasmgc/values/string-utf8-decode-bodies.ts",
        "/src/runtime/wasmgc/values/string-utf8-decode-bodies.ts",
        (s) => createHash("sha256").update(s).digest("hex"),
      ).text,
    );
  for (const canonical of [cf, uf])
    for (const statement of canonical.statements) {
      if (ts.isImportDeclaration(statement)) {
        if (
          !statement.importClause?.isTypeOnly ||
          !["../../../wasm/model/instructions.js", "./string-layouts.js"].includes(
            (statement.moduleSpecifier as ts.StringLiteral).text,
          )
        )
          throw Error("forbidden canonical dependency");
      } else if (!ts.isFunctionDeclaration(statement) && !ts.isInterfaceDeclaration(statement))
        throw Error("unexpected canonical module statement");
    }
  if (
    cf.statements.filter(ts.isFunctionDeclaration).length !== 3 ||
    uf.statements.filter(ts.isFunctionDeclaration).length !== 1
  )
    throw Error("canonical function population differs");
  const emit = functionNode(sf, "emitStrFlattenHelpers");
  const blocks = emit
    .body!.statements.filter((n) => ts.isBlock(n) || ts.isIfStatement(n))
    .map((n) => (ts.isIfStatement(n) ? (n.thenStatement as ts.Block) : (n as ts.Block)));
  if (blocks.length !== 3) throw Error("flatten registration population differs");
  const builders = [
    functionNode(cf, "buildStringCopyTreeDefinition"),
    functionNode(uf, "buildStringUtf8ToFlatDefinition"),
    functionNode(cf, "buildStringFlattenDefinition"),
  ];
  // Headers and execution order are obligations too: reconstructing only body
  // and locals would otherwise discard defaults, async/generator modifiers,
  // early returns, duplicate declarations and reordered initialization.
  const headers = [
    "export function buildStringCopyTreeDefinition(layout: NativeStringLayout, worklistTypeIndex: number): { locals: LocalDef[]; body: Instr[] }",
    "export function buildStringUtf8ToFlatDefinition(layout: NativeStringLayout): { locals: LocalDef[]; body: Instr[] }",
    "export function buildStringFlattenDefinition(layout: NativeStringLayout, resources: StringFlattenResources): { locals: LocalDef[]; body: Instr[] }",
  ];
  const statementOrder = [
    [
      "layout",
      "wlArrTypeIdx",
      "wlArrRefNull",
      "FLAT",
      "FLAT_OFF",
      "FLAT_LEN",
      "CUR",
      "WL",
      "WL_TOP",
      "NEW_WL",
      "body",
      "return",
    ],
    ["layout", "strDataRef", "body", "return"],
    ["layout", "strDataRef", "flatStrRef", "copyTreeIdx", "utf8ToFlatIdx", "body", "return"],
  ];
  for (const [i, builder] of builders.entries()) {
    const source = i === 1 ? uf : cf;
    if (receipt(source.text.slice(builder.getStart(source), builder.body!.getStart(source))) !== receipt(headers[i]!))
      throw Error("changed canonical builder header");
    const order = builder.body!.statements.map((statement) => {
      if (ts.isReturnStatement(statement)) return "return";
      if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1)
        return "unexpected";
      const name = statement.declarationList.declarations[0]!.name;
      return ts.isObjectBindingPattern(name) ? "layout" : name.getText(source);
    });
    if (JSON.stringify(order) !== JSON.stringify(statementOrder[i]))
      throw Error("changed canonical builder statement/return order");
  }
  const edits: [number, number, string][] = [];
  const normalized = (s: string) => receipt(s);
  const expectedCalls = [
    "const definition = buildStringCopyTreeDefinition(ctx, wlArrTypeIdx);",
    "const definition = buildStringUtf8ToFlatDefinition(ctx);",
    'const definition = buildStringFlattenDefinition(ctx, { copyTree: copyTreeIdx, emptyLiteralGlobalIndex: emptyInstrs[0].index, utf8Decoder: ctx.utf8Storage && ctx.utf8StrTypeIdx >= 0 && utf8ToFlatIdx !== undefined ? { kind: "present", handle: utf8ToFlatIdx } : { kind: "absent" } });',
  ];
  const restore = (text: string, i: number) =>
    text
      .replaceAll("layout.", "ctx.")
      .replace(
        /flattenConsBody\(\s*layout,\s*strDataTypeIdx,\s*strTypeIdx,\s*anyStrTypeIdx,\s*copyTreeIdx,\s*resources\.emptyLiteralGlobalIndex,?\s*\)/g,
        "flattenConsBody(ctx, strDataTypeIdx, strTypeIdx, anyStrTypeIdx, copyTreeIdx)",
      )
      .replace(
        i === 2 ? "ctx.utf8StrTypeIdx >= 0 && utf8ToFlatIdx !== undefined" : "__never__",
        "ctx.utf8Storage && ctx.utf8StrTypeIdx >= 0 && utf8ToFlatIdx !== undefined",
      );
  for (let i = 0; i < 3; i++) {
    const block = blocks[i]!,
      builder = builders[i]!,
      bs = i === 1 ? uf : cf;
    const allowed =
      i === 0
        ? ["body", "FLAT", "FLAT_OFF", "FLAT_LEN", "CUR", "WL", "WL_TOP", "NEW_WL", "wlArrRefNull", "wlArrTypeIdx"]
        : i === 1
          ? ["body", "strDataRef"]
          : ["body", "strDataRef", "flatStrRef", "copyTreeIdx", "utf8ToFlatIdx"];
    for (const statement of builder.body!.statements) {
      if (ts.isReturnStatement(statement)) continue;
      if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1)
        throw Error("unexpected canonical builder statement");
      const variable = statement.declarationList.declarations[0]!;
      if (ts.isObjectBindingPattern(variable.name)) {
        const fields =
          i === 0
            ? "nativeStrTypeIdx: strTypeIdx, nativeStrDataTypeIdx: strDataTypeIdx, anyStrTypeIdx, consStrTypeIdx"
            : i === 1
              ? "nativeStrTypeIdx: strTypeIdx, nativeStrDataTypeIdx: strDataTypeIdx"
              : "nativeStrTypeIdx: strTypeIdx, nativeStrDataTypeIdx: strDataTypeIdx, anyStrTypeIdx";
        if (normalized(statement.getText(bs)) !== normalized(`const { ${fields} } = layout;`))
          throw Error("changed layout projection");
      }
      if (!ts.isObjectBindingPattern(variable.name) && !allowed.includes(variable.name.getText(bs)))
        throw Error("unexpected canonical builder declaration");
      if (variable.name.getText(bs) === "copyTreeIdx" && variable.initializer?.getText(bs) !== "resources.copyTree")
        throw Error("changed copy dependency");
      if (variable.name.getText(bs) === "wlArrTypeIdx" && variable.initializer?.getText(bs) !== "worklistTypeIndex")
        throw Error("changed worklist dependency");
      const fixed: Record<string, string> = {
        strDataRef: 'const strDataRef: ValType = {kind:"ref",typeIdx:strDataTypeIdx};',
        flatStrRef: 'const flatStrRef: ValType = {kind:"ref",typeIdx:strTypeIdx};',
        utf8ToFlatIdx:
          'const utf8ToFlatIdx = resources.utf8Decoder.kind === "present" ? resources.utf8Decoder.handle : undefined;',
      };
      const expected = fixed[variable.name.getText(bs)];
      if (expected && normalized(statement.getText(bs)) !== normalized(expected))
        throw Error("changed canonical dependency projection");
    }
    const definition = declaration(block, "definition");
    if (normalized(definition.getText(sf)) !== normalized(expectedCalls[i]!))
      throw Error("changed canonical adapter call");
    let body = restore(declaration(builder.body!, "body").getText(bs), i);
    if (i === 0) {
      const constants = ["FLAT", "FLAT_OFF", "FLAT_LEN", "CUR", "WL", "WL_TOP", "NEW_WL"]
        .map((name) => declaration(builder.body!, name).getText(bs))
        .join("\n");
      body = constants + "\n" + body;
      const wl = declaration(block, "wlArrTypeIdx");
      edits.push([wl.end, wl.end, "\n" + declaration(builder.body!, "wlArrRefNull").getText(bs)]);
    }
    edits.push([definition.getStart(sf), definition.end, body]);
    const ret = builder.body!.statements.find(ts.isReturnStatement)!;
    if (!ret.expression || !ts.isObjectLiteralExpression(ret.expression))
      throw Error("missing canonical definition return");
    const local = ret.expression.properties.find((n) => n.name?.getText(bs) === "locals") as ts.PropertyAssignment;
    if (
      ret.expression.properties.length !== 2 ||
      !ret.expression.properties.some((n) => ts.isShorthandPropertyAssignment(n) && n.name.text === "body")
    )
      throw Error("changed canonical definition result");
    const push = block.statements.find(
      (n) =>
        ts.isExpressionStatement(n) &&
        ts.isCallExpression(n.expression) &&
        n.expression.expression.getText(sf) === "pushDefinedFunc",
    ) as ts.ExpressionStatement;
    const obj = (push.expression as ts.CallExpression).arguments[2] as ts.ObjectLiteralExpression;
    for (const name of ["locals", "body"]) {
      const prop = obj.properties.find((n) => n.name?.getText(sf) === name)!;
      if (normalized(prop.getText(sf)) !== normalized(`${name}: definition.${name}`))
        throw Error("changed canonical registration operand");
      edits.push([
        prop.getStart(sf),
        prop.end,
        name === "body" ? "body" : "locals: " + restore(local.initializer.getText(bs), i),
      ]);
    }
  }
  const empty = declaration(blocks[2]!, "emptyInstrs");
  if (normalized(empty.getText(sf)) !== normalized('const emptyInstrs = nativeStringLiteralInstrs(ctx, "");'))
    throw Error("changed empty literal demand");
  const guard = blocks[2]!.statements.find(ts.isIfStatement)!;
  if (
    normalized(guard.getText(sf)) !==
    normalized(
      'if (emptyInstrs.length !== 1 || emptyInstrs[0]?.op !== "global.get") throw new Error("native string flatten: empty literal must be a global");',
    )
  )
    throw Error("changed empty literal guard");
  edits.push([empty.getStart(sf), empty.end, ""], [guard.getStart(sf), guard.end, ""]);
  const cons = functionNode(cf, "flattenConsBody")
    .getText(cf)
    .replace("layout: NativeStringLayout", "ctx: CodegenContext")
    .replace("copyTreeIdx: FuncHandle,", "copyTreeIdx: number,")
    .replace(/\s*emptyLiteralGlobalIndex: number,/, "")
    .replaceAll("layout.", "ctx.")
    .replace(
      'const emptyInstrs: Instr[] = [{ op: "global.get", index: emptyLiteralGlobalIndex }];',
      'const emptyInstrs = nativeStringLiteralInstrs(ctx, "");',
    );
  const insert = adapter.indexOf("/**\n * Rope flattening:");
  if (insert < 0) throw Error("missing retained flatten documentation");
  edits.push([insert, insert, cons + "\n\n"]);
  const imports = sf.statements
    .filter(ts.isImportDeclaration)
    .filter((n) => n.moduleSpecifier.getText(sf).includes("/values/string-"));
  if (imports.length !== 2) throw Error("canonical import population differs");
  const expectedImports = [
    'import { buildStringCopyTreeDefinition, buildStringFlattenDefinition } from "../runtime/wasmgc/values/string-flatten-bodies.js";',
    'import { buildStringUtf8ToFlatDefinition } from "../runtime/wasmgc/values/string-utf8-decode-bodies.js";',
  ];
  for (const [i, statement] of imports.entries())
    if (receipt(statement.getText(sf)) !== receipt(expectedImports[i]!))
      throw Error("changed canonical adapter import route/binding");
  edits.push(
    [imports[0]!.getStart(sf), imports[0]!.end, 'import type { CodegenContext } from "./context/types.js";'],
    [imports[1]!.getStart(sf), imports[1]!.end, ""],
  );
  let result = adapter;
  for (const [a, b, text] of edits.sort((a, b) => b[0] - a[0])) result = result.slice(0, a) + text + result.slice(b);
  // Fixed reviewed extraction receipt, not a candidate-derived golden. Combined
  // with the complete original donor inverse this covers every canonical byte
  // not transplanted into that donor (module header, interfaces, imports, order,
  // builder wrappers and return syntax). Decoder bytes are already pinned by
  // projectDecoder, including the sole approved semantic delta.
  if (
    createHash("sha256").update(flatten).digest("hex") !==
    "f40b6b18f92c8bbba588efc72bd075a1e93c2cfe3fbe4939f3019fe6825a5bdf"
  )
    throw Error("changed complete canonical extraction receipt");
  return result;
}
describe("mandatory live flatten donor reconstruction", () => {
  const adapterPath = "src/codegen/native-strings-core.ts",
    flattenPath = "src/runtime/wasmgc/values/string-flatten-bodies.ts",
    decoderPath = "src/runtime/wasmgc/values/string-utf8-decode-bodies.ts";
  // First authenticate and invert only the two approved semantic/staging deltas.
  // The original donor, wrapper/header, token and comment controls below remain unchanged.
  const current = () =>
    [
      projectedFlattenSource(adapterPath, projectFlattenAdapterStaging),
      projectedFlattenSource(flattenPath, projectCopyTreeUtf8),
      read(decoderPath),
    ] as const;
  const verify = (rows: readonly [string, string, string]) =>
    expect(receipt(reconstruct(...rows))).toBe(receipt(nativeStringFlattenDonor));
  it("retains all three donor functions, nested bodies, locals, comments and registration order", () => {
    expect(createHash("sha256").update(nativeStringFlattenDonor).digest("hex")).toBe(
      "e695b22c961f85570a5b574264b399f8bfab6fd67bfd4721325c53e9afecb407",
    );
    expect(parse(nativeStringFlattenDonor).statements.filter(ts.isFunctionDeclaration)).toHaveLength(3);
    verify(current());
  });
  for (const [index, from, to] of [
    [0, 'ctx.funcMap.set("__str_flatten", funcIdx);', 'ctx.funcMap.set("__str_flatten", 0);'],
    [1, "value: 16", "value: 32"],
    [1, "fieldIdx: 2", "fieldIdx: 1"],
    [2, "value: 0x80", "value: 0x81"],
  ] as const)
    it(`rejects live mutation ${index}:${from}`, () => {
      const rows = [...current()] as [string, string, string];
      verify(rows);
      expect(rows[index]).toContain(from);
      rows[index] = rows[index].replace(from, to);
      expect(() => verify(rows)).toThrow();
    });
  it("rejects deleted canonical roots", () => {
    const rows = current();
    verify(rows);
    expect(() => verify([rows[0], "", rows[2]])).toThrow("canonical function population differs");
  });
  it("rejects forbidden type-only facade imports", () => {
    const rows = current();
    verify(rows);
    expect(() =>
      verify([rows[0], rows[1].replace("../../../wasm/model/instructions.js", "../../../ir/types.js"), rows[2]]),
    ).toThrow("forbidden canonical dependency");
  });
  for (const [from, to] of [
    ["../runtime/wasmgc/values/string-flatten-bodies.js", "../runtime/wasmgc/values/string-forged-bodies.js"],
    ["../runtime/wasmgc/values/string-utf8-decode-bodies.js", "../runtime/wasmgc/values/string-foreign-decoder.js"],
    ["  buildStringCopyTreeDefinition,", "  buildStringCopyTreeDefinition as substitutedCopyTree,"],
  ] as const)
    it("rejects substituted live import " + from, () => {
      const rows = current();
      verify(rows);
      const changed = rows[0].replace(from, to);
      expect(changed).not.toBe(rows[0]);
      expect(() => verify([changed, rows[1], rows[2]])).toThrow("changed canonical adapter import route/binding");
    });
  for (const [name, from, to, error] of [
    [
      "async header",
      "export function buildStringCopyTreeDefinition(",
      "export async function buildStringCopyTreeDefinition(",
      "changed canonical builder header",
    ],
    [
      "parameter default",
      "worklistTypeIndex: number,",
      "worklistTypeIndex: number = 0,",
      "changed canonical builder header",
    ],
    ["parameter name", "worklistTypeIndex: number,", "foreignTypeIndex: number,", "changed canonical builder header"],
    [
      "declaration order",
      "  const FLAT = 3;\n  const FLAT_OFF = 4;",
      "  const FLAT_OFF = 4;\n  const FLAT = 3;",
      "changed canonical builder statement/return order",
    ],
    [
      "early return",
      "  const FLAT = 3;",
      "  return { locals: [], body: [] };\n  const FLAT = 3;",
      "changed canonical builder statement/return order",
    ],
    [
      "extra statement",
      "  const FLAT = 3;",
      "  void 0;\n  const FLAT = 3;",
      "changed canonical builder statement/return order",
    ],
    [
      "module header",
      "Copyright (c) 2026 Loopdive",
      "Copyright (c) 2025 Loopdive",
      "changed complete canonical extraction receipt",
    ],
    [
      "discarded documentation",
      "    body,\n  };\n}\nexport interface",
      "    body,\n  };\n}\n/* extra discarded documentation */\nexport interface",
      "changed complete canonical extraction receipt",
    ],
  ] as const)
    it("rejects discarded builder obligation: " + name, () => {
      const rows = current();
      verify(rows);
      const changed = rows[1].replace(from, to);
      expect(changed).not.toBe(rows[1]);
      expect(() => verify([rows[0], changed, rows[2]])).toThrow(error);
    });
  it("rejects a substituted builder return after the positive inverse", () => {
    const rows = current();
    verify(rows);
    const changed = rows[1].replace("    body,\n  };", "    body: [],\n  };");
    expect(changed).not.toBe(rows[1]);
    expect(() => verify([rows[0], changed, rows[2]])).toThrow("changed canonical definition result");
  });
  it("rejects reordered return properties after the positive inverse", () => {
    const rows = current();
    verify(rows);
    const sf = parse(rows[1]);
    const ret = functionNode(sf, "buildStringCopyTreeDefinition").body!.statements.find(ts.isReturnStatement)!;
    const object = ret.expression as ts.ObjectLiteralExpression;
    const replacement =
      "{ " +
      [...object.properties]
        .reverse()
        .map((p) => p.getText(sf))
        .join(", ") +
      " }";
    const changed = rows[1].slice(0, object.getStart(sf)) + replacement + rows[1].slice(object.end);
    expect(changed).not.toBe(rows[1]);
    expect(() => verify([rows[0], changed, rows[2]])).toThrow("changed complete canonical extraction receipt");
  });
  for (const kind of [
    "type-only",
    "extra binding",
    "swapped routes",
    "default binding",
    "namespace binding",
    "import attributes",
  ] as const)
    it("rejects non-exact canonical import: " + kind, () => {
      const rows = current();
      verify(rows);
      let changed = rows[0];
      const decoderImport =
        'import { buildStringUtf8ToFlatDefinition } from "../runtime/wasmgc/values/string-utf8-decode-bodies.js";';
      if (kind === "type-only")
        changed = changed.replace(decoderImport, decoderImport.replace("import {", "import type {"));
      else if (kind === "extra binding")
        changed = changed.replace(
          "  buildStringCopyTreeDefinition,",
          "  buildStringCopyTreeDefinition, foreignBinding,",
        );
      else if (kind === "swapped routes")
        changed = changed
          .replace("string-flatten-bodies.js", "TEMP_ROUTE")
          .replace("string-utf8-decode-bodies.js", "string-flatten-bodies.js")
          .replace("TEMP_ROUTE", "string-utf8-decode-bodies.js");
      else if (kind === "default binding")
        changed = changed.replace("{ buildStringUtf8ToFlatDefinition }", "buildStringUtf8ToFlatDefinition");
      else if (kind === "namespace binding")
        changed = changed.replace("{ buildStringUtf8ToFlatDefinition }", "* as buildStringUtf8ToFlatDefinition");
      else changed = changed.replace(decoderImport, decoderImport.slice(0, -1) + ' with { type: "json" };');
      expect(changed).not.toBe(rows[0]);
      expect(() => verify([changed, rows[1], rows[2]])).toThrow("changed canonical adapter import route/binding");
    });
  for (const [from, to] of [
    ["export function buildStringCopyTreeDefinition(", "export function* buildStringCopyTreeDefinition("],
    ["export function buildStringCopyTreeDefinition(", "export default function buildStringCopyTreeDefinition("],
    ["export function buildStringCopyTreeDefinition(", "function buildStringCopyTreeDefinition("],
    ["worklistTypeIndex: number,", "...worklistTypeIndex: number[],"],
    ["body: Instr[] } {", "body: readonly Instr[] } {"],
  ] as const)
    it("rejects non-exact builder header: " + to, () => {
      const rows = current();
      verify(rows);
      const changed = rows[1].replace(from, to);
      expect(changed).not.toBe(rows[1]);
      expect(() => verify([rows[0], changed, rows[2]])).toThrow("changed canonical builder header");
    });
  it("rejects a duplicate final return", () => {
    const rows = current();
    verify(rows);
    const sf = parse(rows[1]),
      builder = functionNode(sf, "buildStringCopyTreeDefinition");
    const ret = builder.body!.statements.find(ts.isReturnStatement)!;
    const changed = rows[1].slice(0, ret.end) + "\n" + ret.getText(sf) + rows[1].slice(ret.end);
    expect(() => verify([rows[0], changed, rows[2]])).toThrow("changed canonical builder statement/return order");
  });
});

function reserve(utf8Storage = false) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const strings = reserveNativeStringLiteralResources(tx, {
    key: "strings",
    utf8Storage,
    literals: [
      { value: "", encoding: "wtf16" },
      { value: "x42y", encoding: "wtf16" },
      ...(utf8Storage ? [{ value: "Aé€😀", encoding: "utf8-guaranteed" as const }] : []),
    ],
  });
  const pack = reserveNativeStringFlattenResources(tx, "flatten", strings);
  return { module, tx, strings, pack };
}
function filled(utf8 = false) {
  const state = reserve(utf8);
  state.tx.freezeReservations();
  fillNativeStringLiteralResources(state.tx, state.strings);
  fillNativeStringFlattenResources(state.tx, state.pack);
  expect(requireCompletedNativeStringFlatten(state.tx, state.pack, state.strings)).toBe(state.pack);
  return state;
}

describe("native flatten resource authentication", () => {
  it("admits the issued pack before freeze without claiming completion", () => {
    const { tx, pack, strings } = reserve();
    expect(requireNativeStringFlattenReservations(tx, pack)).toBe(pack);
    expect(tx.state).toBe("reserving");
    expect(() => requireCompletedNativeStringFlatten(tx, pack, strings)).toThrow("missing canonical fill");
  });
  it("retains copy/decoder/flatten reservation order", () => {
    const { module, pack } = reserve(true);
    expect(module.functions.map((f) => f.name)).toEqual(["__str_copy_tree", "__str_utf8_to_flat", "__str_flatten"]);
    expect(pack.utf8Decoder).not.toBeNull();
  });
  it("rejects cloned packs after a genuine reservation positive", () => {
    const { tx, pack } = reserve();
    expect(requireNativeStringFlattenReservations(tx, pack)).toBe(pack);
    expect(() => requireNativeStringFlattenReservations(tx, { ...pack })).toThrow("foreign or forged");
  });
  it("rejects a foreign transaction after a genuine positive", () => {
    const a = reserve(),
      b = reserve();
    expect(requireNativeStringFlattenReservations(a.tx, a.pack)).toBe(a.pack);
    expect(() => requireNativeStringFlattenReservations(b.tx, a.pack)).toThrow("foreign or forged");
  });
  it("rejects a different completed string pack", () => {
    const a = filled(),
      b = filled();
    expect(() => requireCompletedNativeStringFlatten(a.tx, a.pack, b.strings)).toThrow("foreign string dependency");
  });
  it("refuses missing string fill before filling any flatten body", () => {
    filled();
    const { tx, pack, module } = reserve();
    tx.freezeReservations();
    expect(() => fillNativeStringFlattenResources(tx, pack)).toThrow();
    expect(module.functions.every((f) => f.body.length === 0)).toBe(true);
  });
  it("refuses missing own fill despite completed strings", () => {
    filled();
    const { tx, pack, strings } = reserve();
    tx.freezeReservations();
    fillNativeStringLiteralResources(tx, strings);
    expect(() => requireCompletedNativeStringFlatten(tx, pack, strings)).toThrow("missing canonical fill");
  });
  it("rejects a duplicate fill", () => {
    const { tx, pack } = filled();
    expect(() => fillNativeStringFlattenResources(tx, pack)).toThrow("duplicate fill");
  });
  it("requires an explicit UTF-16 empty demand even when a UTF-8 empty exists", () => {
    filled(true);
    const module = createEmptyModule(),
      tx = new PhysicalModuleReservations(module);
    const strings = reserveNativeStringLiteralResources(tx, {
      key: "utf8-only",
      utf8Storage: true,
      literals: [{ value: "", encoding: "ascii" }],
    });
    expect(() => reserveNativeStringFlattenResources(tx, "flatten", strings)).toThrow("missing literal");
  });
  it("rejects forged string ownership before reserving flatten resources", () => {
    const { tx, strings, module } = reserve();
    const count = module.functions.length;
    expect(() => reserveNativeStringFlattenResources(tx, "forged", { ...strings })).toThrow("foreign or forged");
    expect(module.functions.length).toBe(count);
  });
  it("rejects a changed completed UTF-8 decoder", () => {
    const { tx, pack, strings } = filled(true);
    expect(pack.utf8Decoder).not.toBeNull();
    pack.utf8Decoder!.object.body = [{ op: "unreachable" }];
    expect(() => requireCompletedNativeStringFlatten(tx, pack, strings)).toThrow();
  });
  for (const field of ["body", "locals"] as const)
    it(`rejects changed completed ${field}`, () => {
      const { tx, pack, strings } = filled();
      if (field === "body") pack.flatten.object.body = [{ op: "unreachable" }];
      else pack.flatten.object.locals = [];
      expect(() => requireCompletedNativeStringFlatten(tx, pack, strings)).toThrow();
    });
  it("rejects mutation of the completed empty literal", () => {
    const { tx, pack, strings } = filled();
    pack.emptyLiteral.object.init = [{ op: "unreachable" }];
    expect(() => requireCompletedNativeStringFlatten(tx, pack, strings)).toThrow();
  });
  it("rejects reordered completed functions", () => {
    const { tx, pack, strings, module } = filled();
    [module.functions[0], module.functions[1]] = [module.functions[1]!, module.functions[0]!];
    expect(() => requireCompletedNativeStringFlatten(tx, pack, strings)).toThrow("reordered");
  });
  it("rejects a correctly named constant-return substitute for completed copy-tree", () => {
    const { tx, pack, strings } = filled();
    expect(pack.copyTree.object.name).toBe("__str_copy_tree");
    pack.copyTree.object.body = [{ op: "i32.const", value: 0 }];
    expect(() => requireCompletedNativeStringFlatten(tx, pack, strings)).toThrow("altered completed function");
  });
});

/** Real string constructors feed the actual owned copy/flatten bodies; no scanner stand-in. */
function execute(utf8 = false) {
  const state = reserve(utf8),
    { tx, pack, strings, module } = state,
    l = strings.layout;
  const probe = tx.reserveFunction("probe", "probe", { params: [{ kind: "i32" }], results: [{ kind: "i32" }] });
  const rope = tx.reserveFunction("rope", "rope", { params: [{ kind: "i32" }], results: [{ kind: "i32" }] });
  tx.freezeReservations();
  fillNativeStringLiteralResources(tx, strings);
  fillNativeStringFlattenResources(tx, pack);
  const literal = requireNativeStringLiteral(tx, strings, utf8 ? "Aé€😀" : "x42y", utf8 ? "utf8-guaranteed" : "wtf16");
  if (literal.kind !== "global") throw Error("expected actual literal global");
  const load: Instr[] = [{ op: "global.get", index: tx.physicalIndex(literal.global) }];
  // The UTF-16 view uses a nonzero flat offset and length two.
  const view: Instr[] = utf8
    ? load
    : [
        { op: "i32.const", value: 2 },
        { op: "i32.const", value: 1 },
        ...load,
        { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 2 },
        { op: "struct.new", typeIdx: l.nativeStrTypeIdx },
      ];
  tx.fillFunction(probe, {
    locals: [],
    body: [
      ...view,
      { op: "call", funcIdx: pack.flatten.handle },
      { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 0 },
      ...(!utf8 ? ([{ op: "i32.const", value: 1 }, { op: "i32.add" }] as Instr[]) : []),
      { op: "array.get_u", typeIdx: l.nativeStrDataTypeIdx },
    ],
  });
  const leaf: Instr[] = [
    { op: "i32.const", value: 1 },
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 65 },
    { op: "array.new_fixed", typeIdx: l.nativeStrDataTypeIdx, length: 1 },
    { op: "struct.new", typeIdx: l.nativeStrTypeIdx },
  ];
  tx.fillFunction(rope, {
    locals: [
      { name: "s", type: { kind: "ref_null", typeIdx: l.anyStrTypeIdx } },
      { name: "i", type: { kind: "i32" } },
      { name: "first", type: { kind: "ref_null", typeIdx: l.nativeStrTypeIdx } },
    ],
    body: [
      ...leaf,
      { op: "local.set", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 2 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 2 },
              { op: "local.get", index: 0 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 2 },
              { op: "i32.add" },
              { op: "local.get", index: 1 },
              { op: "ref.as_non_null" },
              ...leaf,
              { op: "struct.new", typeIdx: l.consStrTypeIdx },
              { op: "local.set", index: 1 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 1 },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: pack.flatten.handle },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: pack.flatten.handle },
      { op: "local.get", index: 3 },
      { op: "ref.eq" },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 0 },
      { op: "i32.const", value: 100 },
      { op: "i32.mul" },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: l.nativeStrTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 0 },
      { op: "array.get_u", typeIdx: l.nativeStrDataTypeIdx },
      { op: "i32.add" },
      { op: "i32.mul" },
    ],
  });
  tx.defineExport("export:probe", "probe", probe);
  tx.defineExport("export:rope", "rope", rope);
  requireCompletedNativeStringFlatten(tx, pack, strings);
  tx.seal();
  const bytes = emitBinary(module),
    compiled = new WebAssembly.Module(bytes as BufferSource);
  expect(WebAssembly.Module.imports(compiled)).toEqual([]);
  return new WebAssembly.Instance(compiled).exports as unknown as {
    probe(index: number): number;
    rope(depth: number): number;
  };
}
describe("actual owned flatten execution", () => {
  it("executes a genuine UTF-8 flatten pack in a fresh process with legacy/frontend imports forbidden", () => {
    const script = String.raw`
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      import { pathToFileURL } from "node:url";
      const seen = new Set();
      registerHooks({ resolve(specifier, context, next) {
        const result = next(specifier, context);
        if (/\/src\/(codegen|checker|frontend)\//.test(result.url) || /\/src\/ir\/program-source\./.test(result.url)) throw Error("forbidden frontend/legacy import " + result.url);
        if (result.url.includes("/src/")) seen.add(result.url);
        return result;
      }});
      const load = p => import(pathToFileURL(process.cwd() + "/" + p).href);
      const { PhysicalModuleReservations } = await load("src/wasm/physical/module-reservations.ts");
      const strings = await load("src/backend/wasmgc/resources/native-string-literals.ts");
      const flatten = await load("src/backend/wasmgc/resources/native-string-flatten.ts");
      const { emitBinary } = await load("src/emit/binary.ts");
      const module = { types:[], imports:[], functions:[], exports:[], tables:[], elements:[], globals:[], tags:[], stringPool:[], externClasses:[], nodeBuiltinModules:new Set(), platformCapabilityImportProvenance:new Map(), stringLiteralValues:new Map(), asyncFunctions:new Set(), declaredFuncRefs:[], funcOrdinalToPosition:[], memories:[], dataSegments:[] };
      const tx = new PhysicalModuleReservations(module);
      const s = strings.reserveNativeStringLiteralResources(tx, {key:"fresh",utf8Storage:true,literals:[{value:"",encoding:"wtf16"},{value:"é",encoding:"utf8-guaranteed"}]});
      const f = flatten.reserveNativeStringFlattenResources(tx,"flatten",s);
      const probe = tx.reserveFunction("probe","probe",{params:[],results:[{kind:"i32"}]});
      tx.freezeReservations(); strings.fillNativeStringLiteralResources(tx,s); flatten.fillNativeStringFlattenResources(tx,f);
      const literal = strings.requireNativeStringLiteral(tx,s,"é","utf8-guaranteed");
      assert.equal(literal.kind,"global");
      tx.fillFunction(probe,{locals:[],body:[{op:"global.get",index:tx.physicalIndex(literal.global)},{op:"call",funcIdx:f.flatten.handle},{op:"struct.get",typeIdx:s.layout.nativeStrTypeIdx,fieldIdx:2},{op:"i32.const",value:0},{op:"array.get_u",typeIdx:s.layout.nativeStrDataTypeIdx}]});
      tx.defineExport("export:probe","probe",probe);flatten.requireCompletedNativeStringFlatten(tx,f,s);tx.seal();
      const compiled = new WebAssembly.Module(emitBinary(module));assert.deepEqual(WebAssembly.Module.imports(compiled),[]);
      const run = new WebAssembly.Instance(compiled).exports.probe;
      assert.equal(run(),233);assert.equal(run(),233);
      assert([...seen].some(p=>p.endsWith("string-flatten-bodies.ts")));
      assert([...seen].some(p=>p.endsWith("string-utf8-decode-bodies.ts")));
      console.log(JSON.stringify({outcomes:[233,233],canonicalRoots:2}));
    `;
    const child = spawnSync(
      process.execPath,
      ["--max-old-space-size=2048", "--import", "tsx", "--input-type=module", "-e", script],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        encoding: "utf8",
        env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
      },
    );
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual({ outcomes: [233, 233], canonicalRoots: 2 });
  });
  it("retains nonzero flat offsets", () => {
    const x = execute();
    expect(x.probe(0)).toBe(52);
    expect(x.probe(1)).toBe(50);
  });
  for (const depth of [1, 17, 40, 1000])
    it(`flattens and memoizes depth ${depth}`, () => {
      const x = execute();
      expect(x.rope(depth)).toBe((depth + 1) * 100 + 65);
      expect(x.rope(depth)).toBe((depth + 1) * 100 + 65);
    });
  it("decodes selected UTF-8 including astral code points", () => {
    const x = execute(true);
    expect([0, 1, 2, 3, 4].map((i) => x.probe(i))).toEqual([65, 233, 8364, 55357, 56832]);
  });
});

describe("exact approved decoder offset delta", () => {
  const path = "src/runtime/wasmgc/values/string-utf8-decode-bodies.ts";
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  for (const [name, from, to] of [
    ["ignored offset", 'op: "local.tee", index: 5', 'op: "local.set", index: 5'],
    ["wrong field", "utf8StrTypeIdx, fieldIdx: 2", "utf8StrTypeIdx, fieldIdx: 1"],
    ["missing end add", '    { op: "i32.add" },\n', ""],
    ["wrong cursor end", 'op: "local.set", index: 2 }, // end', 'op: "local.set", index: 5 }, // end'],
    [
      "continuation read",
      'index: 5 },\n                    { op: "i32.const", value: 1',
      'index: 5 },\n                    { op: "i32.const", value: 2',
    ],
    ["output offset", 'value: 0 },\n    { op: "local.get", index: 4', 'value: 1 },\n    { op: "local.get", index: 4'],
  ] as const)
    it("rejects " + name + " after complete positive inverse", () => {
      const source = read(path);
      expect(
        receipt(
          reconstruct(
            projectedFlattenSource("src/codegen/native-strings-core.ts", projectFlattenAdapterStaging),
            projectedFlattenSource("src/runtime/wasmgc/values/string-flatten-bodies.ts", projectCopyTreeUtf8),
            source,
          ),
        ),
      ).toBe(receipt(nativeStringFlattenDonor));
      expect(sha(projectDecoder(source, "/" + path, "/" + path, sha).text)).toBe(
        "bced4ba015efad207b0e2fbce7f3dfb7da4a0782f9fbc5c8625bea45133f9ac6",
      );
      const changed = source.replace(from, to);
      expect(changed).not.toBe(source);
      expect(() => projectDecoder(changed, "/" + path, "/" + path, sha)).toThrow(
        "decoder projection input hash differs",
      );
    });
});
