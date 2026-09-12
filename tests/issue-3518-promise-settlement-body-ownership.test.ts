// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as bodies from "../src/runtime/wasmgc/promise/settlement-bodies.js";
import type { Instr } from "../src/wasm/model/instructions.js";

const root = resolve(import.meta.dirname, "..");
const canonicalPath = "src/runtime/wasmgc/promise/settlement-bodies.ts";
const schedulerPath = "src/codegen/async-scheduler.ts";
const notePath = "src/codegen/unhandled-rejection.ts";
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const parse = (text: string) => ts.createSourceFile("receipt.ts", text, ts.ScriptTarget.Latest, true);
const constantNames = [
  "PROMISE_STATE_PENDING",
  "PROMISE_STATE_FULFILLED",
  "PROMISE_STATE_REJECTED",
  "DENO_PROMISE_HOOK_INIT",
  "DENO_PROMISE_HOOK_BEFORE",
  "DENO_PROMISE_HOOK_AFTER",
  "DENO_PROMISE_HOOK_RESOLVE",
] as const;
// Original complete signatures are data receipts, not copied executable bodies.
// b4 ancestry is irrelevant: this fixed denominator is pinned to e3de0f3ff7.
// No permanent test requires historical Git objects.
const originalHeaders: Record<string, string> = {
  buildDenoPromiseHookCall:
    "export function buildDenoPromiseHookCall(\n  ctx: CodegenContext,\n  kind:\n    | typeof DENO_PROMISE_HOOK_INIT\n    | typeof DENO_PROMISE_HOOK_BEFORE\n    | typeof DENO_PROMISE_HOOK_AFTER\n    | typeof DENO_PROMISE_HOOK_RESOLVE,\n  promiseInstrs: Instr[],\n  parentInstrs?: Instr[],\n): Instr[] ",
  buildPromiseSettleLocals: "function buildPromiseSettleLocals(callbackTypeIdx: number): LocalDef[] ",
  buildPromiseSettleBody:
    "function buildPromiseSettleBody(\n  ctx: CodegenContext,\n  state: AsyncSchedulerState,\n  promiseTypeIdx: number,\n  callbackTypeIdx: number,\n  settledState: typeof PROMISE_STATE_FULFILLED | typeof PROMISE_STATE_REJECTED,\n): Instr[] ",
  buildIdentityWrapperLocals: "function buildIdentityWrapperLocals(capsTypeIdx: number): LocalDef[] ",
  buildIdentityWrapperBody:
    "function buildIdentityWrapperBody(ctx: CodegenContext, capsTypeIdx: number, settleFuncIdx: number): Instr[] ",
  buildNoteUnhandledRejection:
    "export function buildNoteUnhandledRejection(state: AsyncSchedulerState, promiseOnStack: Instr[]): Instr[] ",
};
// Independently pinned canonical headers. Check these before substituting an
// original header: reconstruction must not conceal a changed public contract.
const canonicalHeaders: Record<string, string> = {
  buildDenoPromiseHookCall:
    "export function buildDenoPromiseHookCall(\n  resources: PromiseHookResources,\n  kind:\n    | typeof DENO_PROMISE_HOOK_INIT\n    | typeof DENO_PROMISE_HOOK_BEFORE\n    | typeof DENO_PROMISE_HOOK_AFTER\n    | typeof DENO_PROMISE_HOOK_RESOLVE,\n  promiseInstrs: Instr[],\n): Instr[] ",
  buildPromiseSettleLocals: "export function buildPromiseSettleLocals(callbackTypeIdx: TypeHandle): LocalDef[] ",
  buildPromiseSettleBody:
    "export function buildPromiseSettleBody(\n  state: PromiseSettleResources,\n  settledState: typeof PROMISE_STATE_FULFILLED | typeof PROMISE_STATE_REJECTED,\n): Instr[] ",
  buildIdentityWrapperLocals: "export function buildIdentityWrapperLocals(capsTypeIdx: TypeHandle): LocalDef[] ",
  buildIdentityWrapperBody: "export function buildIdentityWrapperBody(resources: IdentityReactionResources): Instr[] ",
  buildNoteUnhandledRejection:
    "export function buildNoteUnhandledRejection(\n  state: { readonly unhandledHeadGlobalIdx: number; readonly unhandledNodeTypeIdx: number },\n  promiseOnStack: Instr[],\n): Instr[] ",
};
const retained: readonly (readonly [string, string, string])[] = [
  [
    "src/codegen/async-scheduler.ts",
    "getOrInitState",
    "69bc9e91f5ced43ff493e28748d87cff17887c57e1fea966e7586cdaaa79bacf",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "getOrRegisterPromiseType",
    "f47b79fa01aedfc8ac490923656dbde0357c200dce11ad8009aa3203e6869295",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "getOrRegisterMicrotaskQueueType",
    "6a1a6bca59dde8f7eda50b66b849e3ed52ae3a984c0007295f2e598dea5a8d98",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "getOrRegisterPromiseCallbackType",
    "a56e4a9032c3bb0314ac4bd2c517642cc115a7365531a432416e1386f1543756",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "getOrRegisterThenCapsType",
    "a60b4950f2b2b6d7545da33cc50aeedab151bec5cdb325e56edfe53926121f84",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "ensureMicrotaskQueue",
    "0d4f2d117929619ca0e777121d812f199f285c8b75c1623ab776917b43415391",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildPromiseSettleClosureInstrs",
    "5857d6bff99cf0d35940ebfea0118a151b638503027fda590207e9bfde39772f",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "ensurePromiseExecutorClosures",
    "b0118c53db9c84af815cdaa1d642f918e4e5e7ec1d871b793f194fd20593015f",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "ensurePromiseThenableSubstrate",
    "1cf3e0b6b8d4180141de2082098a249f9af072a8528c661ad188a979165064b5",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildPromiseResolveValueLocals",
    "d90c4513170dd2bf91c6a171d9434805d82b6a6e20b0dbca7cc7bb00e6d9933c",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildPromiseResolveValueBody",
    "50160876d4d857d402abafbaaa494df3874a67ed2cf2ecb2f2610e2617b963f4",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "ensureUnionHelpersForThenWrapper",
    "8283841a7bfc54afbbe711ad82b535313f849850989536dd8b4ea8f798b31582",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "pushDefaultForType",
    "01eedcafa47e5aa4f0f7fa0fb9794f2af5d4892b1128d111763bbe8e19364f79",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "pushExternrefLocalAsType",
    "2eff940d9857be7cbc7f26d764110ae30f7ece354a49c75c66585095d0e948f9",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "coerceStackValueToExternref",
    "00a065d1f2e2f456f86933a6b58cb70a5961557dc26a70dc06d9b315a065f1be",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitThenWrapperFunction",
    "047a28ebd0f95fa4bffc1e6e19b57c5918cd1468b06c1ad5b245d6467a8c4700",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "ensureDynamicThenWrapper",
    "c17993ca287daea1bc8bc6ccc58228073b6a16260d71145388f6e0f9a187a627",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitMicrotaskEnqueue",
    "7883b9e813f5ae0dc9b177be5abed90d64f5813c5fcd2b5e84156193c9cc6bfd",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitDrainMicrotasks",
    "949778ac4cca29a080cb92f3de7f5067bc0e634b247d00e447d59811a4f1621a",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "exportDrainMicrotasksIfRegistered",
    "4fe3f0f69ae6996e9473ea66091d5c06e73142eedc69aea3fe940ff7655f9046",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "ensureNativePromiseBoundaryBridge",
    "962adfaf352cd1140a35164b30f18359260d6e2ed134a5c50a57e8be45c6145b",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "exportPromiseBoundaryIfRegistered",
    "4557c3a5613fcba215daaea2a8630d15499a890f6ec9ae9ffc71d8c349f12134",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "ensureAsyncDriveRuntime",
    "562910c102848f2f7667faca0a9e6cc02cf6ca6bb82bf6731f93ca0e1109fec7",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "getDrainFuncIdxForWasiStart",
    "39dd13960866b4c3d9a1aacddab549e44f493836019c266b2804175933ff2e93",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "ensureTimerHeap",
    "38db8cb79bf6297a1c2d367e3e28ce1ea0204c4fb0cae1531c5470ce1314ebf6",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildTimerGrowLocals",
    "903e63ff93c5609020bcb896956b401bb5523501070bb3e2ab0d9ee8f89c8f2c",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildTimerGrowBody",
    "9f0775911083628a54ababb10b3c65b8c502a4a3e9f87c3cc11219f6fd1ba81f",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildTimerAddBody",
    "8a2ec93d9ffc2a10d62cbdc222665e5fd0f613ca58c7328d254ab7a4084d99d6",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildTimerCancelBody",
    "df0f198d35968f86d592dd0e4123378d3fe06180490076c29bce61582a02ca1f",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildTimerPeekLocals",
    "b0d26ebc9c3b90fc3b0bf87846f12e048284a4b76e92d6a0c766a3b638d255ae",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildTimerPeekBody",
    "1b99e695a457c2db083eaabc744c0ca6a06af2a4519b17544c73cadec30c04e2",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildTimerFireLocals",
    "6b0915735ff9b07d0cbbfc2264eae3288d7591fd4830638069d5680b56d98975",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildTimerFireBody",
    "586e204ac02d931492e19709fb27e00c72458213793691df311a1fec4f7a3d88",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildRunLoopNowBody",
    "df5d8cd2f0e066ebd504b761691f8765af860aef3d4d3c1796fdb42431390a13",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildRunLoopLocals",
    "85dbfd119255e5847bf71ae7007d5b8ba6e35e3ce799ad3e3d0db24670eedb52",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildRunLoopBody",
    "28bdfd27bb84a100bb93944c08ba8a50d1e03f9b9c2dd37e22a12088a18c5857",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildRunLoopBodyWithFdReactor",
    "3584b2f88cda4741f290ebce35a73c35031ca454c706cbbabbc283e81c165a74",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildStdinDrainLocals",
    "79a7c1218cee73576a9f73b0035be7196e08b78faf4e726bb038c848aab2bd98",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildStdinDrainBody",
    "91506fc5b73f7213b4adf18e51119acd5f1972f005c18e6f08e58a3b3d83b31f",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildPollFd0Locals",
    "50514fea58a0521ac99d52fd90e8c05103ea03c6ed48fbaa5a9f9135164144aa",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "buildPollFd0OrClockBody",
    "aca5668a6133afa0a7d2a9a0dbbc213461fae0ca2fb277eb9e8e74f727e89663",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitStdinReadByte",
    "8ad411c1a26647b10365e8269fa22a682b467b0e48570e663b70ddc790be372e",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitStdinAvailable",
    "9c21d593173ec8fded680c9fc9c23225737ae0729a9fb138ef7fbe6c6e5b1937",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitStdinEof",
    "118f86db9387f3e34df4e812e04248dbc0d8bbac1d699385e3c4c4dc48ab5b04",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitStdinStop",
    "c49f01a99535e7104d708652050706f36ab333c38093f9fabb368a3e3ed91098",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "isStdinReactorActive",
    "ba817affa124d47d91e9959edbc2fe48d98fcbd76b7ff3e922f762c61e392bce",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitStdinSetReader",
    "f995eea49ac49f6d7c16008e6804324360d7a30a23d4c29e243e59cbb3d2efbe",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "enableStdinReactor",
    "a0ad386b186c9f1db64e17881b7f4b7faf4de9f3e91752dc9c13025f421c05b5",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitTimerAdd",
    "bb30b95698b53d174589d259fc7d2f5cf385d0fa2e7e359ff447bf11dc3eed9a",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitTimerCancel",
    "f1a1852291f4f8536e34634ec4678268fff5874f38d03ae2c3c31e6b37144f5b",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "getRunLoopNowFuncIdx",
    "2f81f564fca528644f86873abcf2d4b96c3bbe0876822b94bb3c1e54835d0051",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitTimerCallbackWrapper",
    "579eebe5cf09d53633c0f4513d198ddc8bcc7c1283897cd4bc2ec45ade7e7cb0",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "getRunLoopFuncIdxForWasiStart",
    "92eb8149e650e5017acfdaaf5b6e5d4c12de5f84d50cd60737ccc542c5378d85",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitStandalonePromiseResolve",
    "5c0aa24ffc4cd304ffa515da77ce819b2e433d4aeedfb910f821dc5fff3bc510",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitStandalonePromiseReject",
    "bf838aede66ddc52cddab03d16423304032b7da47995a58fc9f237fdcdd64de1",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitStandalonePromiseThen",
    "6496dc53cdf1956ea2cfb7a6553915755dcbb2acfb5846f74c08851d6044ccfc",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "ensurePromiseFinallyRuntime",
    "6e58cd390b4f4a1897aad4c663056c190a6d680f662196fa36f23253d650c9e7",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitFinallyWrapperFunction",
    "f9a789518e6c219b1e32204ebf4fdae057417c17442c2594f89e5af55c49ca73",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "ensureDynamicFinallyWrapper",
    "dfe5f2f973e4f4152d5dc2b1bfcd39f85320f440b5fd458abf10bb1194567c98",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "emitStandalonePromiseFinally",
    "e1eaa5946b526f4849bdfeaff0a7982b8b120f1ab1905e1e9d0b895becfe2938",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "isStandalonePromiseActive",
    "769a3187d462a4774398c4b3c3388d7d83032322bff6fd906dcb43c2a4cb3933",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "widenAsyncGenFallback",
    "393c988d534533481628c9da52cefb2386e6a4dfc4ac645f416e1df338cfb2af",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "isStandaloneThenChainNativeActive",
    "618b253629df6345b6499d1387bdde76cb8e440466d7877594ce28bb3b10b63e",
  ],
  [
    "src/codegen/async-scheduler.ts",
    "shiftAsyncSideChannelFuncIdxs",
    "676933d962670c766cd732918dcbc75544f9c2f56bd51f7feb6bb944ab19593b",
  ],
  [
    "src/codegen/unhandled-rejection.ts",
    "ensureUnhandledRejectionTracking",
    "fc1ed28a82007aa87a00dc7cb7b273203ee9d3c7563cefdb8626c88041ed4cc5",
  ],
  [
    "src/codegen/unhandled-rejection.ts",
    "ensureUnhandledRejectionReporter",
    "f20d574811b60725e12870700af5b2512e423b1de94254ff83f1f9fe0871648c",
  ],
];
const functionNames = [
  "buildDenoPromiseHookCall",
  "buildPromiseSettleLocals",
  "buildPromiseSettleBody",
  "buildIdentityWrapperLocals",
  "buildIdentityWrapperBody",
  "buildNoteUnhandledRejection",
];
function fn(text: string, name: string): ts.FunctionDeclaration {
  const found = parse(text).statements.filter(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  assert.equal(found.length, 1, "mandatory function " + name);
  assert(found[0]!.body, "mandatory implementation " + name);
  return found[0]!;
}
function once(text: string, before: string, after: string): string {
  assert.equal(text.split(before).length, 2, "exact resource adaptation " + before);
  return text.replace(before, after);
}
function originalText(node: ts.FunctionDeclaration): string {
  const name = node.name!.text;
  assert.equal(node.asteriskToken, undefined, "canonical builder must not become a generator");
  assert.deepEqual(
    node.modifiers?.map((modifier) => modifier.kind),
    [ts.SyntaxKind.ExportKeyword],
    "canonical builder modifiers must remain exactly export",
  );
  assert.equal(
    node.getSourceFile().text.slice(node.getStart(), node.body!.getStart()),
    canonicalHeaders[name],
    "exact canonical signature before original-header reconstruction: " + name,
  );
  let body = node.body!.getText();
  if (name === "buildPromiseSettleBody") {
    body = once(body, "\n  const { promiseTypeIdx, callbackTypeIdx } = state;", "");
    body = once(
      body,
      'buildDenoPromiseHookCall(state.resolveHook, DENO_PROMISE_HOOK_RESOLVE, [\n      { op: "local.get", index: promiseLocal },\n    ])',
      'buildDenoPromiseHookCall(ctx, DENO_PROMISE_HOOK_RESOLVE, [{ op: "local.get", index: promiseLocal }])',
    );
  }
  if (name === "buildIdentityWrapperBody") {
    body = once(body, "\n  const { capsTypeIdx, settleFuncIdx } = resources;", "");
    body = once(body, "buildDenoPromiseHookCall(resources.beforeHook,", "buildDenoPromiseHookCall(ctx,");
    body = once(body, "buildDenoPromiseHookCall(resources.afterHook,", "buildDenoPromiseHookCall(ctx,");
  }
  if (name === "buildDenoPromiseHookCall") {
    body = once(
      body,
      "  if (resources === undefined) return [];",
      "  const dispatchFuncIdx = ctx.funcMap.get(DENO_PROMISE_HOOK_DISPATCH);\n  if (dispatchFuncIdx === undefined) return [];",
    );
    body = once(
      body,
      "...resources.parentExternInstrs,",
      '...(parentInstrs === undefined\n      ? canonicalUndefinedExternInstrs(ctx)\n      : [...parentInstrs, { op: "extern.convert_any" } satisfies Instr]),',
    );
    body = once(body, "funcIdx: resources.dispatchFuncIdx", "funcIdx: dispatchFuncIdx");
  }
  return originalHeaders[name] + body;
}
function declarationReceipt(text: string): string {
  const sf = parse(text);
  const implementations = sf.statements.filter(ts.isFunctionDeclaration);
  assert.deepEqual(
    implementations.map((n) => n.name?.text),
    functionNames,
  );
  const constants = sf.statements.filter(ts.isVariableStatement);
  assert.deepEqual(
    constants.map((n) => n.declarationList.declarations[0]!.name.getText()),
    constantNames,
  );
  const rows = [...constants, ...implementations].map((node) => {
    const name = ts.isFunctionDeclaration(node)
      ? node.name!.text
      : node.declarationList.declarations[0]!.name.getText();
    const docs = ((node as ts.Node & { jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? [])
      .map((doc) => doc.getText())
      .join("\n");
    return [
      name === "buildNoteUnhandledRejection" ? notePath : schedulerPath,
      name,
      docs,
      ts.isFunctionDeclaration(node) ? originalText(node) : node.getText(),
    ];
  });
  assert.equal(rows.length, 13);
  return sha(JSON.stringify(rows));
}
function requireDeclarationReceipt(text: string) {
  assert.equal(declarationReceipt(text), "cbd5fdf3e0bddf7af4bf4b361302ff34f0457e6980ed36d388f42a78d087595c");
}
function requireBindings(text: string, noteText = read(notePath)) {
  const sf = parse(text);
  const imports = sf.statements
    .filter(ts.isImportDeclaration)
    .filter(
      (n) =>
        ts.isStringLiteral(n.moduleSpecifier) &&
        n.moduleSpecifier.text === "../runtime/wasmgc/promise/settlement-bodies.js",
    );
  assert.equal(imports.length, 1);
  assert(imports[0]!.importClause);
  assert.equal(imports[0]!.importClause!.isTypeOnly, false);
  assert.equal(imports[0]!.importClause!.name, undefined);
  const named = imports[0]!.importClause!.namedBindings;
  assert(named && ts.isNamedImports(named));
  assert.deepEqual(
    named.elements.map((n) => [n.isTypeOnly, n.propertyName?.text ?? n.name.text, n.name.text]),
    [
      ...constantNames.map((name) => [false, name, name]),
      ...[
        "buildPromiseSettleLocals",
        "buildPromiseSettleBody",
        "buildIdentityWrapperLocals",
        "buildIdentityWrapperBody",
      ].map((name) => [false, name, name]),
      [false, "buildDenoPromiseHookCall", "buildPromiseHookInstructions"],
      ...["PromiseHookResources", "PromiseSettleResources", "IdentityReactionResources"].map((name) => [
        true,
        name,
        name,
      ]),
    ],
  );
  for (const name of [
    "buildPromiseSettleLocals",
    "buildPromiseSettleBody",
    "buildIdentityWrapperLocals",
    "buildIdentityWrapperBody",
  ])
    assert(!sf.statements.some((n) => ts.isFunctionDeclaration(n) && n.name?.text === name), "duplicated body " + name);
  const exported = sf.statements
    .filter(ts.isExportDeclaration)
    .filter(
      (n) =>
        n.moduleSpecifier &&
        ts.isStringLiteral(n.moduleSpecifier) &&
        n.moduleSpecifier.text === "../runtime/wasmgc/promise/settlement-bodies.js",
    );
  assert.equal(exported.length, 1);
  assert.equal(exported[0]!.isTypeOnly, false);
  assert(exported[0]!.exportClause && ts.isNamedExports(exported[0]!.exportClause));
  assert.deepEqual(
    exported[0]!.exportClause.elements.map((n) => [n.isTypeOnly, n.propertyName?.text ?? n.name.text, n.name.text]),
    constantNames.map((name) => [false, name, name]),
  );
  let allocator = fn(text, "ensurePromiseSettleFunctions").getText();
  const settle =
    /buildPromiseSettleBody\(\s*bindPromiseSettleResources\(ctx, state, promiseTypeIdx, callbackTypeIdx\),\s*(PROMISE_STATE_\w+),?\s*\)/g;
  assert.equal([...allocator.matchAll(settle)].length, 2);
  allocator = allocator.replace(settle, "buildPromiseSettleBody(ctx, state, promiseTypeIdx, callbackTypeIdx, $1)");
  const identity = /buildIdentityWrapperBody\(bindIdentityReactionResources\(ctx, capsTypeIdx, (state\.\w+)\)\)/g;
  assert.equal([...allocator.matchAll(identity)].length, 2);
  allocator = allocator.replace(identity, "buildIdentityWrapperBody(ctx, capsTypeIdx, $1)");
  const original = fn(allocator, "ensurePromiseSettleFunctions");
  assert.equal(
    sha(ts.createPrinter().printNode(ts.EmitHint.Unspecified, original, original.getSourceFile())),
    "89a0b01740cc4c89a5796ce698d8e0c8e0fd4ca37482c0f5f5ee37f22868f232",
  );
  assert.equal(
    fn(text, "buildDenoPromiseHookCall").body!.getText(),
    "{\n  return buildPromiseHookInstructions(bindPromiseHookResources(ctx, parentInstrs), kind, promiseInstrs);\n}",
  );
  const noteImports = parse(noteText)
    .statements.filter(ts.isImportDeclaration)
    .filter(
      (n) =>
        ts.isStringLiteral(n.moduleSpecifier) &&
        n.moduleSpecifier.text === "../runtime/wasmgc/promise/settlement-bodies.js",
    );
  assert.equal(noteImports.length, 1);
  const noteClause = noteImports[0]!.importClause;
  assert(noteClause);
  assert.equal(noteClause.isTypeOnly, false);
  assert.equal(noteClause.name, undefined);
  assert(noteClause.namedBindings && ts.isNamedImports(noteClause.namedBindings));
  assert.deepEqual(
    noteClause.namedBindings.elements.map((n) => [n.isTypeOnly, n.propertyName?.text ?? n.name.text, n.name.text]),
    [[false, "buildNoteUnhandledRejection", "buildUnhandledRejectionInstructions"]],
  );
  assert.equal(
    fn(noteText, "buildNoteUnhandledRejection").body!.getText(),
    "{\n  return buildUnhandledRejectionInstructions(state, promiseOnStack);\n}",
  );
  const queue = sf.statements
    .filter(ts.isImportDeclaration)
    .find(
      (n) =>
        ts.isStringLiteral(n.moduleSpecifier) &&
        n.moduleSpecifier.text === "../runtime/wasmgc/async/microtask-queue-bodies.js",
    );
  assert(queue?.importClause?.namedBindings && ts.isNamedImports(queue.importClause.namedBindings));
  assert.equal(queue.importClause.isTypeOnly, false);
  assert.equal(queue.importClause.name, undefined);
  assert.deepEqual(
    queue.importClause.namedBindings.elements.map((n) => [
      n.isTypeOnly,
      n.propertyName?.text ?? n.name.text,
      n.name.text,
    ]),
    ["buildGrowLocals", "buildGrowBody", "buildEnqueueBody", "buildDrainLocals", "buildDrainBody"]
      .map((name) => [false, name, name])
      .concat([[true, "PreparedNativeMicrotaskReservations", "PreparedNativeMicrotaskReservations"]]),
  );
}
// Calibration executes exactly the selected CURRENT adapter declarations with
// controlled dependencies. It is not a production-caller witness; source-pair
// execution lives in the companion file.
function adapters(undefinedInstructions: (ctx: any) => Instr[]) {
  const names = [
    "bindPromiseHookResources",
    "bindPromiseSettleResources",
    "bindIdentityReactionResources",
    "buildDenoPromiseHookCall",
  ];
  const declarations = names
    .map((name) =>
      fn(read(schedulerPath), name)
        .getText()
        .replace(/^export /, ""),
    )
    .join("\n");
  const js = ts.transpileModule(declarations, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return new Function(
    "canonicalUndefinedExternInstrs",
    "buildPromiseHookInstructions",
    "DENO_PROMISE_HOOK_DISPATCH",
    js + "\nreturn { " + names.join(",") + " };",
  )(undefinedInstructions, bodies.buildDenoPromiseHookCall, "__v8x_dispatch_promise_hook");
}
const resource = {
  promiseTypeIdx: 11,
  callbackTypeIdx: 12,
  enqueueFuncIdx: 13,
  resolveHook: undefined,
  unhandledHeadGlobalIdx: -1,
  unhandledNodeTypeIdx: -1,
};
describe("native Promise settlement canonical ownership (not full runtime closure)", () => {
  it("requires six executable declarations and all seven original constant receipts", () => {
    requireDeclarationReceipt(read(canonicalPath));
    expect(Object.keys(bodies).sort()).toEqual([...constantNames, ...functionNames].sort());
  });
  it.each([
    ["missing owner", ""],
    [
      "missing function",
      read(canonicalPath).replace("export function buildPromiseSettleBody", "export function lostSettleBody"),
    ],
    ["changed constant", read(canonicalPath).replace("PROMISE_STATE_PENDING = 0", "PROMISE_STATE_PENDING = 9")],
    ["changed callback field", read(canonicalPath).replace("fieldIdx: 4", "fieldIdx: 3")],
    [
      "reordered guard operands",
      read(canonicalPath).replace(
        '{ op: "local.get", index: promiseLocal },\n    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },',
        '{ op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },\n    { op: "local.get", index: promiseLocal },',
      ),
    ],
    ["changed branch", read(canonicalPath).replace('op: "br_if", depth: 1', 'op: "br_if", depth: 0')],
    [
      "changed result",
      read(canonicalPath).replace(
        'then: [{ op: "local.get", index: valueLocal }',
        'then: [{ op: "local.get", index: promiseLocal }',
      ),
    ],
  ])("rejects declaration mutation: %s", (_name, changed) =>
    expect(() => requireDeclarationReceipt(changed)).toThrow(),
  );
  it.each(
    functionNames.flatMap((name) => {
      const node = fn(read(canonicalPath), name);
      const header = node.getSourceFile().text.slice(node.getStart(), node.body!.getStart());
      return [
        [name + ": async", header.replace("export function", "export async function")],
        [name + ": generator", header.replace("function ", "function* ")],
        [name + ": missing export", header.replace("export ", "")],
        [name + ": extra parameter", header.replace("(", "(injected: unknown, ")],
        [name + ": return contract", header.replace(/: (Instr|LocalDef)\[\] $/, ": unknown ")],
      ].map(([label, changedHeader]) => [label, once(read(canonicalPath), header, changedHeader!)]);
    }),
  )("rejects live canonical header mutation: %s", (_label, changed) =>
    expect(() => requireDeclarationReceipt(changed!)).toThrow(),
  );
  it("preserves allocator order, handle targets, real canonical imports and queue imports", () =>
    requireBindings(read(schedulerPath)));
  it.each([
    [
      "missing import",
      read(schedulerPath).replace('from "../runtime/wasmgc/promise/settlement-bodies.js"', 'from "./missing.js"'),
    ],
    ["renamed import", read(schedulerPath).replace("  buildIdentityWrapperBody,", "  missingIdentityWrapperBody,")],
    [
      "fulfill adopts via resolve-value",
      read(schedulerPath).replace(
        "bindIdentityReactionResources(ctx, capsTypeIdx, state.promiseResolveValueFuncIdx)",
        "bindIdentityReactionResources(ctx, capsTypeIdx, state.promiseFulfillFuncIdx)",
      ),
    ],
    [
      "reject must reject",
      read(schedulerPath).replace(
        "bindIdentityReactionResources(ctx, capsTypeIdx, state.promiseRejectFuncIdx)",
        "bindIdentityReactionResources(ctx, capsTypeIdx, state.promiseResolveValueFuncIdx)",
      ),
    ],
  ])("rejects caller mutation: %s", (_name, changed) => expect(() => requireBindings(changed)).toThrow());
  it.each([
    [
      "scheduler type-only clause",
      schedulerPath,
      "import {\n  PROMISE_STATE_PENDING,",
      "import type {\n  PROMISE_STATE_PENDING,",
    ],
    ["scheduler type-only specifier", schedulerPath, "  buildPromiseSettleBody,", "  type buildPromiseSettleBody,"],
    [
      "scheduler source alias",
      schedulerPath,
      "  buildPromiseSettleBody,",
      "  buildIdentityWrapperBody as buildPromiseSettleBody,",
    ],
    [
      "constant type-only export clause",
      schedulerPath,
      "export {\n  PROMISE_STATE_PENDING,",
      "export type {\n  PROMISE_STATE_PENDING,",
    ],
    [
      "constant type-only export specifier",
      schedulerPath,
      "export {\n  PROMISE_STATE_PENDING,",
      "export {\n  type PROMISE_STATE_PENDING,",
    ],
    [
      "constant source alias",
      schedulerPath,
      "export {\n  PROMISE_STATE_PENDING,",
      "export {\n  PROMISE_STATE_REJECTED as PROMISE_STATE_PENDING,",
    ],
    [
      "note type-only clause",
      notePath,
      "import { buildNoteUnhandledRejection as",
      "import type { buildNoteUnhandledRejection as",
    ],
    [
      "note type-only specifier",
      notePath,
      "import { buildNoteUnhandledRejection as",
      "import { type buildNoteUnhandledRejection as",
    ],
    ["note source alias", notePath, "import { buildNoteUnhandledRejection as", "import { buildPromiseSettleBody as"],
    ["note target alias", notePath, "as buildUnhandledRejectionInstructions }", "as unrelatedInstructions }"],
  ])("rejects type-erased or substituted forwarding: %s", (_label, path, before, after) => {
    const changed = once(read(path!), before!, after!);
    expect(() =>
      requireBindings(
        path === schedulerPath ? changed : read(schedulerPath),
        path === notePath ? changed : read(notePath),
      ),
    ).toThrow();
  });
  it("keeps the canonical owner on the one import-free instruction-model leaf", () => {
    const sf = parse(read(canonicalPath));
    const imports = sf.statements.filter(ts.isImportDeclaration);
    expect(imports).toHaveLength(1);
    expect(imports[0]!.importClause!.isTypeOnly).toBe(true);
    expect((imports[0]!.moduleSpecifier as ts.StringLiteral).text).toBe("../../../wasm/model/instructions.js");
    const leaf = parse(read("src/wasm/model/instructions.ts"));
    expect(leaf.statements.filter((n) => ts.isImportDeclaration(n) || ts.isExportDeclaration(n))).toEqual([]);
    expect(read(canonicalPath)).not.toMatch(/CodegenContext|AsyncSchedulerState|=>\s*Instr|import\(/);
  });
  it.each(retained)("retains %s :: %s unchanged", (path, name, hash) => {
    expect(sha(fn(read(path), name).getText())).toBe(hash);
  });
  it("does not allocate undefined when dispatcher is absent, even with parent operands", () => {
    let calls = 0;
    const adapter = adapters(() => {
      calls++;
      throw new Error("must not allocate");
    });
    const ctx = { funcMap: new Map() };
    expect(adapter.buildDenoPromiseHookCall(ctx, 0, [], [])).toEqual([]);
    expect(adapter.buildDenoPromiseHookCall(ctx, 0, [])).toEqual([]);
    expect(calls).toBe(0);
  });
  it("captures settlement fields after resolve preparation, retaining earlier type arguments", () => {
    const state = { ...resource };
    const events: string[] = [];
    const ctx = {
      funcMap: {
        get() {
          events.push("lookup");
          return 20;
        },
      },
    };
    const adapter = adapters(() => {
      events.push("undefined");
      state.enqueueFuncIdx = 99;
      state.unhandledHeadGlobalIdx = 31;
      state.unhandledNodeTypeIdx = 32;
      return [{ op: "ref.null.extern" }];
    });
    const bound = adapter.bindPromiseSettleResources(ctx, state, 11, 12);
    expect(events).toEqual(["lookup", "undefined"]);
    expect(bound).toMatchObject({
      promiseTypeIdx: 11,
      callbackTypeIdx: 12,
      enqueueFuncIdx: 99,
      unhandledHeadGlobalIdx: 31,
      unhandledNodeTypeIdx: 32,
    });
    expect(bound.resolveHook.dispatchFuncIdx).toBe(20);
  });
  it("captures the identity target before distinct before/after preparation and never shares their mutable nodes", () => {
    const events: string[] = [];
    let target = 17;
    let dispatch = 20;
    const ctx = {
      funcMap: {
        get() {
          events.push("lookup");
          return dispatch++;
        },
      },
    };
    const adapter = adapters(() => {
      events.push("undefined");
      target = 99;
      return [{ op: "global.get", index: target }];
    });
    const bound = adapter.bindIdentityReactionResources(ctx, 11, target);
    expect(events).toEqual(["lookup", "undefined", "lookup", "undefined"]);
    expect(bound.settleFuncIdx).toBe(17);
    expect(bound.beforeHook.dispatchFuncIdx).toBe(20);
    expect(bound.afterHook.dispatchFuncIdx).toBe(21);
    expect(bound.beforeHook.parentExternInstrs[0]).not.toBe(bound.afterHook.parentExternInstrs[0]);
    const result = bodies.buildIdentityWrapperBody(bound);
    expect(result.filter((n) => n.op === "call").map((n) => n.funcIdx)).toEqual([20, 17, 21]);
  });
  it("preserves supplied parent conversion without undefined allocation", () => {
    const adapter = adapters(() => {
      throw new Error("unexpected allocation");
    });
    const parent: Instr[] = [{ op: "local.get", index: 8 }];
    const promise: Instr[] = [{ op: "local.get", index: 9 }];
    const got = adapter.buildDenoPromiseHookCall(
      { funcMap: new Map([["__v8x_dispatch_promise_hook", 20]]) },
      0,
      promise,
      parent,
    );
    expect(got).toEqual([
      { op: "f64.const", value: 0 },
      ...promise,
      { op: "extern.convert_any" },
      ...parent,
      { op: "extern.convert_any" },
      { op: "call", funcIdx: 20 },
    ]);
    expect(parent).toEqual([{ op: "local.get", index: 8 }]);
  });
  it.each([
    [-1, -1],
    [-1, 3],
    [3, -1],
    [3, 4],
  ])("preserves independent negative tracking fields %i/%i", (head, node) => {
    const got = bodies.buildNoteUnhandledRejection({ unhandledHeadGlobalIdx: head, unhandledNodeTypeIdx: node }, [
      { op: "local.get", index: 0 },
    ]);
    expect(got.length).toBe(head < 0 || node < 0 ? 0 : 6);
    const settled = bodies.buildPromiseSettleBody(
      { ...resource, unhandledHeadGlobalIdx: head, unhandledNodeTypeIdx: node },
      2,
    );
    expect(settled.some((n) => n.op === "if" && n.then.some((i) => i.op === "global.set"))).toBe(
      head >= 0 && node >= 0,
    );
  });
  it("emits resolve hook before the one-shot guard and detaches before the callback loop", () => {
    const got = bodies.buildPromiseSettleBody(
      { ...resource, resolveHook: { dispatchFuncIdx: 20, parentExternInstrs: [{ op: "ref.null.extern" }] } },
      1,
    );
    expect(got.findIndex((n) => n.op === "call")).toBeLessThan(got.findIndex((n) => n.op === "if"));
    expect(got.findIndex((n) => n.op === "struct.set" && n.fieldIdx === 2)).toBeLessThan(
      got.findIndex((n) => n.op === "block"),
    );
    expect(got.at(-1)).toEqual({ op: "local.get", index: 1 });
  });
});
