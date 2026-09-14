// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const donor = "src/codegen/async-frame.ts";
const canonical = "src/runtime/wasmgc/async/frame-engine.ts";
const nativePath = "src/runtime/wasmgc/async/native-await.ts";
const ehPath = "src/wasm/physical/exception-control.ts";
type Reader = (path: string) => string;

const forwardMainFixture = "tests/fixtures/issue-3518-async-frame-forward-main.json";
const forwardMainFixtureHash = "634a00c7f8f13d1146a214572a638c5fd51d9a8a7b5284c5bdb7e834408aade7";
const forwardMainSpanIds = [
  "host-planner-import",
  "resume-undefined-carrier-import",
  "frame-import-abi",
  "frame-import-lookup",
  "frame-import-result",
  "host-combinator-gate",
  "resume-undefined-carrier-type",
  "host-spill-plan",
  "frame-reaction",
] as const;

interface ForwardMainSpan {
  id: (typeof forwardMainSpanIds)[number];
  beforeLine: number;
  afterLine: number;
  before: string[];
  after: string[];
}

interface ForwardMainFixture {
  schema: string;
  path: string;
  before: { sha256: string };
  spans: ForwardMainSpan[];
}

// The original seven fragments retain their independent 06f4cfa4 provenance.
// Two additional fragments are authenticated against delivered main ee2ee090.
// Every inverse fragment still comes from a42660c8; the JSON records each source.
// No runtime Git fallback or candidate-derived expected receipt is permitted.
function readForwardMainFixture(reader: Reader): ForwardMainFixture {
  const text = reader(forwardMainFixture);
  assert.equal(sha(text), forwardMainFixtureHash, "pinned forward-main provenance");
  const fixture = JSON.parse(text) as ForwardMainFixture;
  assert.equal(fixture.schema, "async-frame-forward-main-v1");
  assert.equal(fixture.path, donor);
  assert.deepEqual(
    fixture.spans.map((item) => item.id),
    forwardMainSpanIds,
  );
  return fixture;
}

function inverseProjectMain(text: string, reader: Reader): string {
  const { spans } = readForwardMainFixture(reader);
  let end = 0;
  const changes = spans.map((item) => {
    const after = `${item.after.join("\n")}\n`;
    const before = `${item.before.join("\n")}\n`;
    assert.notEqual(after, before, `nonempty forward main span ${item.id}`);
    assert.equal(text.split(after).length - 1, 1, `exact forward main span ${item.id}`);
    const start = text.indexOf(after);
    assert(start >= end, `ordered disjoint forward main span ${item.id}`);
    end = start + after.length;
    return { start, end, before };
  });
  for (const change of changes.reverse()) text = text.slice(0, change.start) + change.before + text.slice(change.end);
  // Only the admitted spans have changed. The original 0194 reconstruction and
  // its unchanged syntax/comment receipts still govern every remaining byte.
  return text;
}

function parse(text: string): ts.SourceFile {
  const file = ts.createSourceFile("receipt.ts", text, ts.ScriptTarget.Latest, true);
  assert.equal(
    (file as ts.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics.length,
    0,
    "invalid live syntax",
  );
  return file;
}
function comments(text: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const result: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia)
      result.push(scanner.getTokenText().replace(/\n[ \t]+/g, "\n"));
  }
  return result;
}
// AST children retain every executable expression, modifier, field and omitted
// array element. Only formatting/trailing punctuation is irrelevant; every
// comment is separately retained, including nested-body and attached JSDoc.
function syntax(node: ts.Node, file: ts.SourceFile): unknown {
  const children: unknown[] = [];
  ts.forEachChild(node, (child) => {
    children.push(syntax(child, file));
  });
  return [ts.SyntaxKind[node.kind], children.length ? children : node.getText(file)];
}
function receipt(text: string): string {
  const file = parse(text);
  return sha(JSON.stringify([file.statements.map((node) => syntax(node, file)), comments(text)]));
}
function nodes(file: ts.SourceFile): ts.Statement[] {
  return file.statements.filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node));
}
function full(node: ts.Node, file: ts.SourceFile): string {
  return file.text.slice(node.getStart(file, true), node.end);
}
function exactly<T>(values: T[], label: string): T {
  assert.equal(values.length, 1, label);
  return values[0]!;
}
function fn(text: string, name: string): ts.FunctionDeclaration {
  return exactly(
    parse(text).statements.filter(
      (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
    ),
    name,
  );
}
function variable(text: string, name: string): string {
  const file = parse(text),
    matches: ts.VariableStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((decl) => ts.isIdentifier(decl.name) && decl.name.text === name)
    )
      matches.push(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return full(exactly(matches, name), file);
}
function span(text: string, start: string, end: string): string {
  assert.equal(text.split(start).length, 2, `unique start ${start}`);
  const from = text.indexOf(start),
    to = text.indexOf(end, from + start.length);
  assert(to > from, `missing end ${end}`);
  return text.slice(from, to);
}
function replace(text: string, before: string, after: string, count = 1): string {
  assert.equal(text.split(before).length - 1, count, `exact mapped edit: ${before}`);
  return text.split(before).join(after);
}
function words(text: string, mapping: Readonly<Record<string, string>>): string {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const changes: { start: number; end: number; text: string }[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.Identifier && Object.hasOwn(mapping, scanner.getTokenText()))
      changes.push({ start: scanner.getTokenPos(), end: scanner.getTextPos(), text: mapping[scanner.getTokenText()]! });
  }
  for (const change of changes.reverse()) text = text.slice(0, change.start) + change.text + text.slice(change.end);
  return text;
}
function calls(text: string, name: string): string[] {
  const file = parse(text),
    result: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name)
      result.push(node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

// Filled from the pinned 0194 donor AST, never from a candidate or Git fallback
// during test execution. Bridge receipts describe only the approved new glue.
const historicalReceipts: Record<string, { statements: number; functions: number; bodies: number; hash: string }> = {
  "src/codegen/async-frame.ts": {
    statements: 51,
    functions: 47,
    bodies: 92,
    hash: "d842bc14445082f874a698a6778286ad511e51e7f7cc446dbe164eedfa0ce9d3",
  },
  "src/codegen/ir-async-frame.ts": {
    statements: 9,
    functions: 7,
    bodies: 38,
    hash: "67f32e9a897e0f947bd24c9d7c4ffd5bc642dfca7673d1e7725cfe4e649f57b7",
  },
  "src/codegen/prepared-native-async-await.ts": {
    statements: 3,
    functions: 2,
    bodies: 3,
    hash: "df4db4ca1c4a1afa58d859e22fba6445b57a7b4f97ed2d1d74b1a788a9a86633",
  },
  "src/ir/try-table.ts": {
    statements: 6,
    functions: 5,
    bodies: 9,
    hash: "1954342a84d58a6bb0d46e31289d3d4f53cfbbd0ada754b66b0cc88b11bbcee8",
  },
};
const bridgeReceipts: Record<string, string> = {
  "state-prefix": "d686c606f05518985d79999f811ba8359793a23bfd40e84e2c4eaf47b3935ace",
  "state-return": "44e76fb4b28037bd503339f7290b0fddf934e0147c9bf7a06ec92fc7a6be1120",
  "dispatch-prefix": "b72d1287adf17c38ea8f44578f631b3d1f292725e4df2d00cca325f5054da20d",
  "finalizer-binding": "c122ce7d88fd2e79b04cd92e6e48af84b397eab067f1b0202034f5be6ace4bb3",
  "state-emission": "a4e7efb3164b2e3e3e1de7d6da14657a7c11f24eb9d55e62b466d7d81029ca17",
  "dispatch-adapter": "01d1a69abc15a5e6908836e063eefd7bd5e90f2cf5b8810933427df7e58c90d2",
  "step-call-0": "abbac8aed116004db2f2630b10368c2b10a16ad246d786507ff04ffa038169b9",
  "step-call-1": "05cde01fdb9831c178a5b020c6a9a40f7d40ee42ce00360bf49a49767843357f",
  "step-signature": "a9f8ed179104aceb09d00df1cd27628a7d211a0b1ef5b1f7d68e25e905511f5e",
  "step-mode": "c5956fe97564015956abd4efacf39a23d7bbe7f3865593b35420005fe8fb0bee",
};
function bridge(label: string, text: string): void {
  assert.equal(receipt(text), bridgeReceipts[label], `unapproved adapter edit: ${label}`);
}

function reconstructFrame(reader: Reader): string {
  const current = inverseProjectMain(reader(donor), reader),
    live = reader(canonical);
  const currentFile = parse(current),
    liveFile = parse(live);
  assert.deepEqual(
    nodes(liveFile).map((node) => (node as ts.FunctionDeclaration | ts.InterfaceDeclaration).name?.text),
    [
      "AsyncFrameStepResources",
      "AsyncFrameStateBody",
      "AsyncFrameStateChainInput",
      "AsyncFrameHandler",
      "AsyncFrameDispatchInput",
      "buildStepAdapterLocals",
      "buildStepAdapterBody",
      "buildAsyncFrameStateChain",
      "buildAsyncFrameDispatch",
    ],
  );
  let owner = full(fn(current, "ensureAsyncResumeFunction"), currentFile);
  const stateBuilder = fn(live, "buildAsyncFrameStateChain");
  assert(stateBuilder.body);
  assert.equal(stateBuilder.body.statements.length, 3);
  bridge("state-prefix", full(stateBuilder.body.statements[0]!, liveFile));
  bridge("state-return", full(stateBuilder.body.statements[2]!, liveFile));
  let arm = full(stateBuilder.body.statements[1]!, liveFile);
  // Preserve the historical explanatory comments that precede the nested fn.
  arm = live.slice(live.indexOf("  // Nested if-chain dispatch"), stateBuilder.body.statements[1]!.end);
  arm = words(arm, { states: "cfg.states", stateTypeIdx: "info.stateTypeIdx", stateField: "STATE_FIELD" });
  arm = replace(
    arm,
    "if (completed !== undefined) {",
    `if (info.asyncGen && info.completedStateId !== undefined) {\n${variable(owner, "completedBody")}`,
  );
  arm = replace(arm, "value: completed.id", "value: info.completedStateId");
  arm = replace(arm, "then: completed.body", "then: completedBody");
  arm = replace(arm, "const then = st.body;", "const then = trackDetached(buildStateBody(st));");

  const dispatchFn = fn(live, "buildAsyncFrameDispatch");
  assert(dispatchFn.body);
  assert.equal(dispatchFn.body.statements.length, 7);
  const prefix = dispatchFn.body.statements
    .slice(0, 4)
    .map((node) => full(node, liveFile))
    .join("\n");
  bridge("dispatch-prefix", prefix);
  const finalizerLoop = dispatchFn.body.statements[4]!;
  assert(ts.isForOfStatement(finalizerLoop) && ts.isBlock(finalizerLoop.statement));
  assert.equal(finalizerLoop.statement.statements.length, 2);
  bridge("finalizer-binding", full(finalizerLoop.statement.statements[0]!, liveFile));
  const guard = words(full(finalizerLoop.statement.statements[1]!, liveFile), { handlers: "cfg.handlers" });
  const start = live.indexOf("  // (#2867 Gap 2) Throw → reject routing.", dispatchFn.getStart(liveFile));
  assert(start > dispatchFn.getStart(liveFile));
  let dispatch = live.slice(start, dispatchFn.body.end - 1);
  dispatch = words(dispatch, { handlers: "cfg.handlers", stateTypeIdx: "info.stateTypeIdx", target: "ctx" });
  dispatch = replace(
    dispatch,
    "completedStateId !== undefined",
    "info.asyncGen && info.completedStateId !== undefined",
  );
  dispatch = replace(
    dispatch,
    "setField(stateField, completedStateId)",
    "setStateI32FromConst(info, frameLocal, STATE_FIELD, info.completedStateId)",
  );
  dispatch = replace(
    dispatch,
    "setField(modeField, nextMode)",
    "setStateI32FromConst(info, frameLocal, MODE_FIELD, MODE_NEXT)",
  );
  dispatch = replace(
    dispatch,
    "setField(stateField, region.catchState)",
    "setStateI32FromConst(info, frameLocal, STATE_FIELD, region.catchState)",
  );
  dispatch = replace(dispatch, "hostGetCaughtIdx !== undefined", "info.host && hostGetCaughtIdx !== undefined", 2);
  dispatch = replace(dispatch, "region.catchBinding !== undefined", "region.catchParamName !== undefined");
  dispatch = replace(
    dispatch,
    "const paramLocal = region.catchBinding.local;",
    "const paramLocal = resumeFctx.localMap.get(region.catchParamName);",
  );
  dispatch = replace(
    dispatch,
    "const spillField = region.catchBinding.spillField;",
    "const spillIdx = info.spillNames.indexOf(region.catchParamName);",
  );
  dispatch = replace(dispatch, "spillField !== undefined", "spillIdx >= 0");
  dispatch = replace(dispatch, "fieldIdx: spillField", "fieldIdx: info.spillFieldOffset + spillIdx");
  const dispatchFile = parse(dispatch),
    returns: ts.ReturnStatement[] = [];
  const findReturns = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, findReturns);
  };
  findReturns(dispatchFile);
  assert.equal(returns.length, 2);
  for (const statement of returns.reverse()) {
    assert(statement.expression);
    dispatch =
      dispatch.slice(0, statement.getStart(dispatchFile)) +
      `resumeFctx.body.push(${statement.expression.getText(dispatchFile)});` +
      dispatch.slice(statement.end);
  }

  const emitted = span(owner, "    const states = cfg.states.map", "    for (const region of cfg.handlers)");
  bridge("state-emission", emitted);
  owner = replace(owner, emitted, "    chain = trackDetached(buildStateArm(0));\n");
  owner = replace(owner, "  const savedFunc = ctx.currentFunc;", `${arm}\n  const savedFunc = ctx.currentFunc;`);
  owner = replace(owner, "const finalizerBodies: Instr[][] = [];", "const catchFinallyInstrs: Instr[] = [];");
  owner = replace(owner, "finalizerBodies.push(fbody);", guard);
  const assembly = span(owner, "  // Resolve bindings only after all finalizers", "  resumePlaceholder.locals =");
  bridge("dispatch-adapter", assembly);
  owner = replace(owner, assembly, `${dispatch}\n`);
  owner = replace(owner, "buildStepAdapterLocals(info.stateTypeIdx)", "buildStepAdapterLocals(info)", 2);
  const stepCalls = calls(owner, "buildStepAdapterBody");
  assert.equal(stepCalls.length, 2);
  for (const [index, call] of stepCalls.entries()) {
    bridge(`step-call-${index}`, call);
    owner = replace(owner, call, `buildStepAdapterBody(info, resumeFuncIdx, /*reject*/ ${index === 1})`);
  }

  let locals = full(fn(live, "buildStepAdapterLocals"), liveFile);
  locals = replace(
    locals,
    "export function buildStepAdapterLocals(stateTypeIdx: number): LocalDef[]",
    "function buildStepAdapterLocals(info: AsyncFrameInfo): { name: string; type: ValType }[]",
  );
  locals = replace(locals, "typeIdx: stateTypeIdx", "typeIdx: info.stateTypeIdx");
  let step = full(fn(live, "buildStepAdapterBody"), liveFile);
  // Signature spelling is formatting-insensitive but its full current AST is
  // checked before restoring the historical source-layer parameter type.
  const signatureEnd = step.indexOf("{\n", step.indexOf("export function"));
  const signature = step.slice(step.indexOf("export function"), signatureEnd);
  bridge("step-signature", signature + "{}");
  step = replace(
    step,
    signature,
    "function buildStepAdapterBody(info: AsyncFrameInfo, resumeFuncIdx: number, reject: boolean): Instr[] ",
  );
  step = replace(step, "resources.stateTypeIdx", "info.stateTypeIdx", 4);
  step = replace(step, "resources.sentField", "SENT_FIELD");
  step = replace(step, "resources.errorField", "ERROR_FIELD");
  step = replace(step, "resources.resumeFuncIdx", "resumeFuncIdx");
  const mode = span(
    step,
    '      { op: "local.get", index: frameLocal },\n      { op: "i32.const", value: resources.throwMode }',
    "\n    );",
  );
  bridge("step-mode", `const mode = [${mode}];`);
  step = replace(step, mode, "      ...setStateI32FromConst(info, frameLocal, MODE_FIELD, 2),");
  return nodes(currentFile)
    .flatMap((node) =>
      ts.isFunctionDeclaration(node) && node.name?.text === "ensureAsyncResumeFunction"
        ? [owner, locals, step]
        : [full(node, currentFile)],
    )
    .join("\n");
}

function projected(reader: Reader, path: string): string {
  if (path === donor) return reconstructFrame(reader);
  const text =
    path === "src/codegen/prepared-native-async-await.ts"
      ? reader(nativePath)
      : path === "src/ir/try-table.ts"
        ? reader(ehPath)
        : reader(path);
  const file = parse(text);
  const result = nodes(file)
    .map((node) => full(node, file))
    .join("\n");
  return path === "src/codegen/prepared-native-async-await.ts"
    ? replace(result, "export interface NativeAwaitClassificationOptions", "interface NativeAwaitClassificationOptions")
    : result;
}
function census(text: string) {
  const file = parse(text);
  let bodies = 0,
    classes = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && "body" in node && node.body) bodies++;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) classes++;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return {
    statements: nodes(file).length,
    functions: nodes(file).filter(ts.isFunctionDeclaration).length,
    bodies,
    classes,
    hash: receipt(text),
  };
}
function verifyHistorical(reader: Reader): void {
  assert.deepEqual(Object.keys(historicalReceipts), [
    donor,
    "src/codegen/ir-async-frame.ts",
    "src/codegen/prepared-native-async-await.ts",
    "src/ir/try-table.ts",
  ]);
  // All current owners are mandatory even when a particular historical donor
  // no longer imports them. Missing code can never select a surviving facade.
  for (const path of [
    canonical,
    nativePath,
    ehPath,
    donor,
    "src/codegen/ir-async-frame.ts",
    "src/codegen/prepared-native-async-await.ts",
    "src/ir/try-table.ts",
  ])
    assert(reader(path).length > 0, path);
  for (const [path, expected] of Object.entries(historicalReceipts)) {
    assert.deepEqual(census(projected(reader, path)), { ...expected, classes: 0 }, `historical donor ${path}`);
  }
}

describe("0194 historical bodies reconstructed from mandatory current owners", () => {
  it("preserves all four donor populations, nested bodies and original receipts", () => verifyHistorical(read));
  for (const path of [canonical, nativePath, ehPath, "src/codegen/ir-async-frame.ts"]) {
    it(`rejects missing ${path}`, () =>
      expect(() =>
        verifyHistorical((file) => {
          if (file === path) throw new Error("missing canonical source");
          return read(file);
        }),
      ).toThrow());
  }
  for (const [name, path, before, after] of [
    ["state order", canonical, "buildStateArm(i + 1)", "buildStateArm(i + 2)"],
    ["state body", canonical, "const then = st.body;", 'const then: Instr[] = [{ op: "unreachable" }];'],
    ["callback", canonical, "funcIdx: resources.resumeFuncIdx", "funcIdx: 0"],
    ["branch depth", canonical, 'op: "br", depth: 2', 'op: "br", depth: 1'],
    ["mode", canonical, "setField(modeField, nextMode)", "setField(modeField, 2)"],
    ["completed arm", canonical, "then: completed.body", 'then: [{ op: "unreachable" }]'],
    ["spill", donor, "info.spillFieldOffset + spillIdx", "info.spillFieldOffset + spillIdx + 1"],
    [
      "finalizer order",
      donor,
      "for (const region of cfg.handlers)",
      "for (const region of [...cfg.handlers].reverse())",
    ],
    ["parent metadata", donor, "parent: region.parent", "parent: 0"],
    ["state tracking", donor, "body: trackDetached(buildStateBody(st))", "body: buildStateBody(st)"],
    ["chain tracking", donor, "chain = trackDetached(", "chain = ("],
    ["tag branch algorithm", ehPath, "instr.depth += delta", "instr.depth += delta + 1"],
    ["await nested callback", nativePath, "funcIdx: options.enqueueFuncIdx", "funcIdx: options.rejectStepFuncIdx"],
    ["documentation", canonical, "Step-adapter locals:", "Altered locals:"],
    ["selected prepared state", "src/codegen/ir-async-frame.ts", "runtime.states[index]", "runtime.states[0]"],
  ]) {
    it(`detects changed live ${name}`, () => {
      expect(read(path!).includes(before!)).toBe(true);
      expect(() =>
        verifyHistorical((file) => (file === path ? read(file).replace(before!, after!) : read(file))),
      ).toThrow();
    });
  }
});

describe("pinned incoming main changes before historical reconstruction", () => {
  it("requires all nine independently pinned forward spans before checking the original receipts", () => {
    const fixture = readForwardMainFixture(read);
    expect(fixture.spans.map((item) => item.id)).toEqual(forwardMainSpanIds);
    const projected = inverseProjectMain(read(donor), read);
    expect(projected).not.toBe(read(donor));
    expect(sha(projected)).toBe(fixture.before.sha256);
    verifyHistorical(read);
  });
  it("rejects missing forward source provenance", () => {
    expect(() =>
      verifyHistorical((path) => {
        if (path === forwardMainFixture) throw new Error("missing pinned forward-main fixture");
        return read(path);
      }),
    ).toThrow("missing pinned forward-main fixture");
  });
  it("rejects a changed forward fixture instead of accepting a candidate-derived receipt", () => {
    const changed = replace(read(forwardMainFixture), '"afterLine": 41', '"afterLine": 42');
    expect(() => verifyHistorical((path) => (path === forwardMainFixture ? changed : read(path)))).toThrow(
      "pinned forward-main provenance",
    );
  });
  it("rejects a duplicated incoming reaction span before inverse projection", () => {
    const reaction = readForwardMainFixture(read).spans.find((item) => item.id === "frame-reaction")!;
    const changed = read(donor) + `${reaction.after.join("\n")}\n`;
    expect(() => verifyHistorical((path) => (path === donor ? changed : read(path)))).toThrow(
      "exact forward main span frame-reaction",
    );
  });
  for (const [name, before, after] of [
    ["module source", 'from "./async-cps.js";', 'from "./other-planner.js";'],
    ["import kind", "import {\n", "import type {\n"],
  ]) {
    it(`rejects changed incoming host-planner ${name}`, () => {
      const imported = readForwardMainFixture(read).spans.find((item) => item.id === "host-planner-import")!;
      const original = `${imported.after.join("\n")}\n`;
      const changedImport = replace(original, before!, after!);
      expect(changedImport).not.toBe(original);
      const changed = replace(read(donor), original, changedImport);
      expect(() => verifyHistorical((path) => (path === donor ? changed : read(path)))).toThrow(
        "exact forward main span host-planner-import",
      );
    });
  }
  for (const [name, before, after] of [
    ["module source", 'from "./index.js";', 'from "./other-carrier.js";'],
    ["import kind", "import {", "import type {"],
  ]) {
    it(`rejects changed incoming resume-carrier ${name}`, () => {
      const imported = readForwardMainFixture(read).spans.find(
        (item) => item.id === "resume-undefined-carrier-import",
      )!;
      const original = `${imported.after.join("\n")}\n`;
      const changedImport = replace(original, before!, after!);
      expect(changedImport).not.toBe(original);
      const changed = replace(read(donor), original, changedImport);
      expect(() => verifyHistorical((path) => (path === donor ? changed : read(path)))).toThrow(
        "exact forward main span resume-undefined-carrier-import",
      );
    });
  }
  const corruptions: Record<(typeof forwardMainSpanIds)[number], (text: string) => string> = {
    "host-planner-import": (text) => replace(text, "  isHostAsyncLane,", "  isHostAsyncLane as alteredHostLane,"),
    "resume-undefined-carrier-import": (text) =>
      replace(
        text,
        "varBindingNeedsExternrefForUndefined }",
        "varBindingNeedsExternrefForUndefined as alteredCarrier }",
      ),
    "resume-undefined-carrier-type": (text) =>
      replace(text, 'return { kind: "externref" };', 'return { kind: "i32" };'),
    "frame-import-abi": (text) => replace(text, "then2FrameIdx?: number;", "then2FrameIdx?: string;"),
    "frame-import-lookup": (text) => replace(text, 'get("Promise_then2_frame")', 'get("Promise_then2")'),
    "frame-import-result": (text) => replace(text, "? { then2FrameIdx }", "? { then2FrameIdx: then2Idx }"),
    // The admitted forward fragment is the comment replacing the deleted gate.
    // Injecting a gate after it must still fail the ORIGINAL remainder receipt.
    "host-combinator-gate": (text) => `${text}  if (linear.segments.length === 1) return false;\n`,
    "host-spill-plan": (text) => replace(text, "isHostAsyncLane(ctx)", "false"),
    "frame-reaction": (text) => replace(text, "index: resultPromiseLocal", "index: awaitedLocal"),
  };
  for (const item of readForwardMainFixture(read).spans) {
    const after = `${item.after.join("\n")}\n`;
    const before = `${item.before.join("\n")}\n`;
    it(`rejects removal of the landed ${item.id} change`, () => {
      const changed = replace(read(donor), after, before);
      expect(changed).not.toBe(read(donor));
      expect(() => verifyHistorical((path) => (path === donor ? changed : read(path)))).toThrow(
        `exact forward main span ${item.id}`,
      );
    });
    it(`rejects semantic corruption of the landed ${item.id} change`, () => {
      const corrupt = corruptions[item.id](after);
      expect(corrupt).not.toBe(after);
      const changed = replace(read(donor), after, corrupt);
      expect(() => verifyHistorical((path) => (path === donor ? changed : read(path)))).toThrow();
    });
  }
});

// One fresh process per explicit compiler root. This is public-source
// preservation, NOT whole-program async admission or physical acceptance.
// The complete public artifact is recorded; only its documented lazy
// importObject getter is represented by descriptor shape, never invoked.
const publicArmSource = String.raw`
import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const [rootArgument, arm] = process.argv.slice(1);
const root = realpathSync(rootArgument);
const hash = x => createHash("sha256").update(x).digest("hex");
const read = path => readFileSync(join(root, path), "utf8");
const urls = [];
const observe = event => console.log("FRAME_BODY_PROGRESS=" + JSON.stringify(event));
// Same idle-await contract as the existing source recorder: failure if all
// work disappears while an operation is unsettled, never a timer or kill.
async function awaitStep(promise, context) {
  observe({kind:"await-start",...context});
  let rejectIdle;
  const idle = new Promise((_,reject) => {rejectIdle=reject;});
  const onIdle = () => {const error=new Error("recorder await became idle: " + context.phase);error.code="ERR_RECORDER_UNSETTLED_AWAIT";error.context=context;rejectIdle(error);};
  process.once("beforeExit",onIdle);
  try {const value=await Promise.race([promise,idle]);observe({kind:"await-completed",...context});return value;}
  catch(error){observe({kind:"await-failed",...context,error:{name:error.name,message:error.message,code:error.code}});throw error;}
  finally{process.removeListener("beforeExit",onIdle);}
}
async function load(path) { const url = pathToFileURL(join(root, path)).href; urls.push(url); return awaitStep(import(url),{phase:"import",url}); }
function snapshot() {
  const rows = [];
  function walk(path) {
    for (const entry of readdirSync(join(root, path), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path + "/" + entry.name;
      if (entry.isDirectory()) walk(file);
      else { assert(entry.isFile(), "unexpected source symlink " + file); rows.push([file, hash(readFileSync(join(root,file)))]); }
    }
  }
  walk("src"); assert(rows.length > 1000); return rows;
}
const before = snapshot();
if (arm === "baseline") {
  assert.equal(execFileSync("git", ["diff", "0194b64c246d2b5beab2db00af33a73498e2eb6e", "--", "src"], {cwd:root, encoding:"utf8"}), "");
  assert.equal(execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "src"], {cwd:root, encoding:"utf8"}), "");
}
const compiler = await load("src/index.ts");
const runtime = await load("src/runtime.ts");
const { evidenceValue } = await load("tests/helpers/semantic-provider-source-receipts.mjs");
const ts = (await load("node_modules/typescript/lib/typescript.js")).default;
function template(path, callName, needle, argument) {
  const file = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true), matches=[];
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callName && node.arguments.length > 0 && ts.isNoSubstitutionTemplateLiteral(node.arguments[0]) && node.arguments[0].text.includes(needle) && (argument === undefined || (node.arguments.length > 1 && ts.isStringLiteral(node.arguments[1]) && node.arguments[1].text === argument))) matches.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(file); assert.equal(matches.length,1,"one grounded fixture " + path + ":" + needle); return matches[0];
}
const familyPath = "website/playground/examples/js/async.ts";
let family = read(familyPath);
for (const name of ["fetchUser", "fetchAllSequential", "fetchAllParallel"]) {
  assert.equal(family.split("async function " + name).length,2);
  family = family.replace("async function " + name,"export async function " + name);
}
const fixtures = [
  {id:"family",path:familyPath,source:family,target:"standalone",action:"family"},
  {id:"multi-await",path:"tests/issue-2906-async-multiawait.test.ts",call:"instantiateWasi",needle:"cap = a * 100 + b",target:"standalone",action:"cap",getter:"getCap",expected:4142},
  {id:"try-catch",path:"tests/issue-2906-3c-trycatch.test.ts",call:"driveCap",needle:'const x = await Promise.reject(new Error("boom"))',argument:"standalone",target:"standalone",action:"cap",getter:"getCap",expected:42},
  {id:"try-finally",path:"tests/issue-2906-gap3-tryfinally.test.ts",call:"instantiateWasi",needle:"ran = 99",target:"standalone",action:"cap",getter:"getRan",expected:99},
  {id:"late-import",path:"tests/issue-2710-late-bind.test.ts",call:"compileToWasm",needle:"async function fetchA()",target:"gc",action:"host",expected:130},
];
for (const fixture of fixtures) {
  if (!fixture.source) fixture.source = template(fixture.path,fixture.call,fixture.needle,fixture.argument);
  fixture.sourceFileSha256 = hash(read(fixture.path)); fixture.sourceSha256 = hash(fixture.source);
}
function dataResult(result) {
  const data = {};
  for (const key of Reflect.ownKeys(result)) {
    assert.equal(typeof key,"string");
    const d = Object.getOwnPropertyDescriptor(result,key);
    if (key === "importObject") {
      assert(!("value" in d) && typeof d.get === "function", "exact documented importObject accessor");
      data[key] = {lazyImportObject:true,enumerable:d.enumerable,configurable:d.configurable,hasSetter:!!d.set};
    } else { assert("value" in d,"unassessed result accessor " + key); data[key] = key === "binary" ? {$bytes:Buffer.from(d.value).toString("base64")} : d.value; }
  }
  return evidenceValue(data);
}
function functionAt(ex,name) { assert.equal(typeof ex[name],"function","missing executed export " + name); return ex[name]; }
async function instantiate(result, action) {
  const jobs=[],events=[];let ordinal=0;
  const imports=runtime.buildCompiledImports(result, {setTimeout(callback,delay,...args) {
    const id=ordinal++; events.push(["start",id,delay]);
    if ((action === "sequential-reject" || action === "parallel-reject") && id === 1) { events.push(["reject",id]); throw new Error("injected timer registration failure at 1"); }
    const fire=()=>{events.push(["fire",id]);callback(...args);}; jobs.push(fire);
    if(action === "non-i31" && id === 0)fire();
    return id+1;
  }});
  const instantiatedBinary=Buffer.from(result.binary).toString("base64");
  const {instance}=await awaitStep(WebAssembly.instantiate(result.binary,imports),{phase:"instantiate",action});
  imports.setInstance?.(instance);
  return {instance,ex:instance.exports,jobs,events,instantiatedBinary};
}
function vector(ex, ids) {
  const allocate=functionAt(ex,"__new_vec_f64"), set=functionAt(ex,"__vec_set_byte"), get=functionAt(ex,"__vec_get");
  const vec=allocate(ids.length); ids.forEach((v,i)=>set(vec,i,v)); ids.forEach((v,i)=>assert.equal(get(vec,i),v)); return vec;
}
async function executeFamily(result) {
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map(x=>x.module+"."+x.name),["env.__timer_set_timeout"]);
  for(const owner of ["fetchUser","fetchAllSequential","fetchAllParallel","main"]) {
    const rows=result.irOutcomes.filter(x=>x.unitKind==="function"&&x.displayName===owner);assert.equal(rows.length,1);
    assert.equal(rows[0].kind,"emitted");assert.equal(rows[0].irBodyEmitted,true);assert.equal(rows[0].legacyBodyEmitted,false);
  }
  const values=[];
  for(const action of ["pending-70","non-i31","sequential","parallel-reverse","empty","sequential-reject","parallel-reject","undefined"]) {
    const h=await instantiate(result,action),ex=h.ex,state=functionAt(ex,"__promise_boundary_state"),value=functionAt(ex,"__promise_boundary_value");
    const drain=functionAt(ex,"__drain_microtasks");
    if(action==="non-i31") {
      assert.equal(typeof ex.__promise_boundary_observe,"undefined");
      const promise=runtime.wrapCompiledExports(result,h.instance).fetchUser(300000000);
      assert.equal(h.jobs.length,1);assert.deepEqual(h.events.map(x=>x[0]),["start","fire"]);
      const actual=await awaitStep(promise,{phase:"wrapped-non-i31",action});assert.equal(actual,3000000000);
      values.push({action,actual,events:h.events,instantiatedBinary:h.instantiatedBinary});continue;
    }
    if(action==="empty") {
      const empty=vector(ex,[]),sequential=functionAt(ex,"fetchAllSequential")(empty),parallel=functionAt(ex,"fetchAllParallel")(empty);
      // #4574: the no-await sequential path settles now; the parallel await
      // resumes only through the native microtask queue, even for Promise.all([]).
      const before=[state(sequential),state(parallel)];assert.deepEqual(before,[1,0]);assert.deepEqual([value(sequential),value(parallel)],[0,null]);assert.equal(h.jobs.length,0);
      drain();const actual=[value(sequential),value(parallel)];assert.deepEqual(actual,[0,0]);assert.deepEqual([state(sequential),state(parallel)],[1,1]);
      values.push({action,before,actual,events:h.events,instantiatedBinary:h.instantiatedBinary});continue;
    }
    const ids=[3,1,2];
    let promise;
    if(action==="pending-70") promise=functionAt(ex,"fetchUser")(7);
    else if(action==="undefined") promise=functionAt(ex,"main")();
    else promise=functionAt(ex,action.startsWith("sequential")?"fetchAllSequential":"fetchAllParallel")(vector(ex,ids));
    if(action==="parallel-reject")drain();
    const before=state(promise);assert.equal(before,action==="parallel-reject"?2:0);
    const timeline=[{state:before,jobs:h.jobs.length}];
    if(action==="pending-70") {assert.equal(h.jobs.length,1);h.jobs[0]();}
    else if(action==="undefined") {
      assert.equal(h.jobs.length,1);
      for(let i=0;i<5;i++){assert.equal(h.jobs.length,i+1);h.jobs[i]();timeline.push({state:state(promise),jobs:h.jobs.length});}
      assert.equal(h.jobs.length,10);
      for(let i=9;i>=5;i--)h.jobs[i]();
    } else if(action==="sequential") {
      for(let i=0;i<3;i++){assert.equal(h.jobs.length,i+1);h.jobs[i]();timeline.push({state:state(promise),jobs:h.jobs.length});}
    } else if(action==="sequential-reject") {assert.equal(h.jobs.length,1);h.jobs[0]();assert.equal(h.jobs.length,1);}
    else {assert.equal(h.jobs.length,action==="parallel-reject"?2:3);for(let i=h.jobs.length-1;i>=0;i--)h.jobs[i]();}
    drain();const after=state(promise),raw=value(promise);let actual;
    if(action.endsWith("reject")){assert.equal(after,2);assert.equal(raw,null);actual=null;}
    else {assert.equal(after,1);if(action==="undefined"){assert.equal(functionAt(ex,"__dynamic_boundary_tag")(raw),2);actual={$undefined:true};}else {actual=raw;assert.equal(actual,action==="pending-70"?70:60);}}
    const expectedStdout="async/await demo\nsequential sum = 150 (took ~0ms)\nparallel  sum = 150 (took ~0ms)\ndone\n";
    let stdout,postDeliveryStdout;
    if(action==="undefined") {
      const length=functionAt(ex,"__stdout_prepare")();stdout="";
      for(let i=0;i<length;i++)stdout+=String.fromCharCode(functionAt(ex,"__stdout_char")(i));
      assert.equal(stdout,expectedStdout);
    }
    // Repeated timer delivery cannot re-run a completed continuation.
    const completedJobs=[...h.jobs];for(const fire of completedJobs)fire();drain();assert.equal(h.jobs.length,completedJobs.length);assert.equal(state(promise),after);
    if(action!=="undefined")assert.equal(value(promise),actual);
    else {
      assert.equal(functionAt(ex,"__dynamic_boundary_tag")(value(promise)),2);
      const length=functionAt(ex,"__stdout_prepare")();postDeliveryStdout="";
      for(let i=0;i<length;i++)postDeliveryStdout+=String.fromCharCode(functionAt(ex,"__stdout_char")(i));
      assert.equal(postDeliveryStdout,expectedStdout);assert.equal(postDeliveryStdout,stdout);
    }
    values.push({action,before,after,actual,timeline,events:h.events,...(stdout===undefined?{}:{stdout,postDeliveryStdout}),instantiatedBinary:h.instantiatedBinary});
  }
  return values;
}
const rows=[];
for(const fixture of fixtures) {
  const row={id:fixture.id,fixture};rows.push(row);
  observe({kind:"row-start",id:fixture.id});
  try {
    const result=await awaitStep(compiler.compile(fixture.source,{fileName:"frame-body-"+fixture.id+".ts",target:fixture.target,experimentalIR:true,trackFallbacks:true,trackIrOutcomes:true,skipSemanticDiagnostics:true,emitWat:true,...(fixture.action==="family"?{hostBridge:"always"}:{})}),{phase:"compile",id:fixture.id});
    row.result=dataResult(result);row.binary=Buffer.from(result.binary).toString("base64");row.wat=result.wat;
    assert.equal(result.success,true,JSON.stringify(result.errors));assert.equal(WebAssembly.validate(result.binary),true);
    assert.equal(result.irPostClaimErrors?.length??0,0);
    row.imports=WebAssembly.Module.imports(new WebAssembly.Module(result.binary));row.exports=WebAssembly.Module.exports(new WebAssembly.Module(result.binary));
    if(fixture.action==="family") row.values=await executeFamily(result);
    else {
      const h=await instantiate(result,fixture.action);
      let actual,beforeValue;
      if(fixture.action==="host")actual=await awaitStep(runtime.wrapCompiledExports(result,h.instance).main(),{phase:"host-execution",id:fixture.id});
      else {beforeValue=functionAt(h.ex,"kick")();for(let i=0;i<8;i++)functionAt(h.ex,"__drain_microtasks")();actual=functionAt(h.ex,fixture.getter)();}
      assert.equal(actual,fixture.expected);row.values=[{actual,...(beforeValue===undefined?{}:{before:beforeValue}),instantiatedBinary:h.instantiatedBinary}];
    }
    row.kind="executed";
  } catch(error) {row.kind="failed";row.error={name:error.name,message:error.message,...(error.code===undefined?{}:{code:error.code}),...(error.context===undefined?{}:{context:error.context})};}
  observe({kind:"row-completed",id:fixture.id,verdict:row.kind});
}
assert.equal(rows.length,5);assert.deepEqual(snapshot(),before,"source changed during measurement");
console.log("FRAME_BODY_RECEIPT="+JSON.stringify({schema:"frame-body-source-preservation-v1",root,arm,urls,sourceFiles:before,fixtures,rows,closureCertified:false,physicalAcceptanceCertified:false,retirementCertified:false}));
`;

interface PublicArm {
  schema: string;
  root: string;
  arm: string;
  urls: string[];
  sourceFiles: [string, string][];
  fixtures: unknown[];
  rows: {
    id: string;
    kind: string;
    binary: string;
    wat: string;
    result: unknown;
    error?: unknown;
    values: { instantiatedBinary: string; action?: string }[];
  }[];
  closureCertified: boolean;
  physicalAcceptanceCertified: boolean;
  retirementCertified: boolean;
}
async function executeArm(compilerRoot: string, arm: "baseline" | "candidate", directory: string): Promise<PublicArm> {
  const child = spawn(
    process.execPath,
    ["--max-old-space-size=2048", "--import", "tsx", "--input-type=module", "-e", publicArmSource, compilerRoot, arm],
    {
      cwd: compilerRoot,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const started = {
    arm,
    root: realpathSync(compilerRoot),
    pid: child.pid,
    node: process.execPath,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(directory, `${arm}-started.json`), JSON.stringify(started, null, 2));
  console.log(`frame-body child ${arm}: pid=${child.pid}; root=${compilerRoot}; progress=${directory}`);
  let output = "",
    pendingLine = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    appendFileSync(join(directory, `${arm}.log`), chunk);
    pendingLine += chunk;
    const lines = pendingLine.split("\n");
    pendingLine = lines.pop()!;
    for (const line of lines)
      if (line.startsWith("FRAME_BODY_PROGRESS=")) {
        const progress = line.slice("FRAME_BODY_PROGRESS=".length);
        appendFileSync(join(directory, `${arm}-progress.jsonl`), progress + "\n");
        console.log(`${arm}: ${progress}`);
      }
  });
  child.stderr.on("data", (chunk: string) => appendFileSync(join(directory, `${arm}.stderr.log`), chunk));
  await new Promise<void>((resolveTerminal, rejectTerminal) => {
    child.once("error", (error) => {
      writeFileSync(join(directory, `${arm}-terminal.json`), JSON.stringify({ ...started, error: error.message }));
      rejectTerminal(error);
    });
    child.once("close", (code, signal) => {
      writeFileSync(
        join(directory, `${arm}-terminal.json`),
        JSON.stringify({ ...started, code, signal, completedAt: new Date().toISOString() }, null, 2),
      );
      if (code !== 0 || signal !== null)
        rejectTerminal(
          new Error(`${arm} child terminated code=${code} signal=${signal}; retained evidence ${directory}`),
        );
      else resolveTerminal();
    });
  });
  const lines = output.split("\n").filter((line) => line.startsWith("FRAME_BODY_RECEIPT="));
  const report = JSON.parse(exactly(lines, `${arm} terminal receipt`).slice("FRAME_BODY_RECEIPT=".length)) as PublicArm;
  writeFileSync(join(directory, `${arm}.json`), JSON.stringify(report, null, 2));
  return report;
}
function validateArm(report: PublicArm, expectedRoot: string): void {
  expect(report.schema).toBe("frame-body-source-preservation-v1");
  expect(report.root).toBe(realpathSync(expectedRoot));
  expect(report.urls.slice(0, 2)).toEqual([
    new URL(`file://${report.root}/src/index.ts`).href,
    new URL(`file://${report.root}/src/runtime.ts`).href,
  ]);
  expect(report.sourceFiles.length).toBeGreaterThan(1000);
  expect(report.rows.map((row) => row.id)).toEqual([
    "family",
    "multi-await",
    "try-catch",
    "try-finally",
    "late-import",
  ]);
  for (const row of report.rows) {
    expect(row.kind, JSON.stringify({ id: row.id, error: row.error })).toBe("executed");
    expect(Buffer.from(row.binary, "base64").length).toBeGreaterThan(8);
    expect(row.wat.length).toBeGreaterThan(0);
    expect(row.values).toHaveLength(row.id === "family" ? 8 : 1);
    if (row.id === "family")
      expect(row.values.map((value) => value.action)).toEqual([
        "pending-70",
        "non-i31",
        "sequential",
        "parallel-reverse",
        "empty",
        "sequential-reject",
        "parallel-reject",
        "undefined",
      ]);
    for (const value of row.values) expect(value.instantiatedBinary).toBe(row.binary);
  }
  expect(report.closureCertified).toBe(false);
  expect(report.physicalAcceptanceCertified).toBe(false);
  expect(report.retirementCertified).toBe(false);
}
describe("public-source preservation controls, not async physical acceptance", () => {
  it("executes five live fixtures and eight family scenarios against independent current-root oracles", async () => {
    const baseline = process.env.JS2WASM_FRAME_BODY_BASELINE_ROOT;
    mkdirSync(join(root, ".tmp"), { recursive: true });
    const directory = mkdtempSync(join(root, ".tmp", "frame-body-preservation-"));
    const after = await executeArm(root, "candidate", directory);
    validateArm(after, root);
    if (baseline !== undefined) {
      assert.notEqual(realpathSync(baseline), realpathSync(root), "baseline cannot be the candidate");
      // Explicit historical mode only. Serial children, no timeout/automatic kill.
      const before = await executeArm(baseline, "baseline", directory);
      validateArm(before, baseline);
      expect(after.fixtures).toEqual(before.fixtures);
      expect(after.rows).toEqual(before.rows);
      writeFileSync(
        join(directory, "verdict.json"),
        JSON.stringify({
          currentRootOracles: true,
          historicalPair: "passed",
          artifacts: 5,
          executionsPerRoot: 12,
          physicalAcceptanceCertified: false,
          retirementCertified: false,
        }),
      );
      console.log(
        `preservation-only: 5 paired artifacts / 12 executed rows per root; evidence ${directory}; physical acceptance NOT CERTIFIED`,
      );
    } else {
      writeFileSync(
        join(directory, "verdict.json"),
        JSON.stringify({
          currentRootOracles: true,
          historicalPair: "NOT_RUN",
          artifacts: 5,
          executions: 12,
          physicalAcceptanceCertified: false,
          retirementCertified: false,
        }),
      );
      console.log(
        `current-root only: 5 artifacts / 12 executed rows; historical pair NOT RUN (set JS2WASM_FRAME_BODY_BASELINE_ROOT explicitly); evidence ${directory}; physical acceptance NOT CERTIFIED`,
      );
    }
    // No paired test is skipped or counted: its verdict is explicitly NOT_RUN
    // unless the caller supplies the immutable historical compiler root.
  }, 0);
});
