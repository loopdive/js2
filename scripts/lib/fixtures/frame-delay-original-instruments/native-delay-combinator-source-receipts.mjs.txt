// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Historical AST receipts reconstructed only from mandatory live source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import ts from "typescript";
import { reconstructB1Source } from "./native-delay-combinator-b1-inverse.mjs";

export const donorPath = "src/codegen/promise-combinators.ts";
export const combinatorPath = "src/runtime/wasmgc/promise/combinator-bodies.ts";
export const delayPath = "src/runtime/wasmgc/promise/delay-bodies.ts";
export const delayAdapterPath = "src/codegen/ir-native-promise-delay.ts";
export const allAdapterPath = "src/codegen/ir-native-async-runtime.ts";
export const donorNames = [
  "buildSubscribeLocals",
  "buildSubscribeBody",
  "buildAllFulfillLocals",
  "buildAllFulfillBody",
  "buildSettleWrapperLocals",
  "buildSettleResultBody",
  "buildRaceFulfillBody",
  "buildRejectBody",
];
export const readerAt = (root) => (path) => readFileSync(join(root, path), "utf8");
export function parse(text) {
  const file = ts.createSourceFile("receipt.ts", text, ts.ScriptTarget.Latest, true);
  assert.equal(file.parseDiagnostics.length, 0, "invalid live syntax");
  return file;
}
export function one(values, label) {
  assert.equal(values.length, 1, label);
  return values[0];
}
export function fn(text, name) {
  return one(
    parse(text).statements.filter((node) => ts.isFunctionDeclaration(node) && node.name?.text === name),
    name,
  );
}
export function comments(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text),
    result = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia)
      result.push(scanner.getTokenText().replace(/\n[ \t]+/g, "\n"));
  }
  return result;
}
function syntax(node, file) {
  // Parentheses and comma formatting can change when Prettier moves an arm;
  // retain this original receipt unchanged. semanticReceipt supplements the
  // scalar semantic fields that TypeScript's child visitor does not expose.
  if (ts.isParenthesizedExpression(node)) return syntax(node.expression, file);
  const children = [];
  ts.forEachChild(node, (child) => {
    children.push(syntax(child, file));
  });
  return [ts.SyntaxKind[node.kind], children.length ? children : node.getText(file)];
}
export function receipt(text) {
  const file = parse(text);
  return createHash("sha256")
    .update(JSON.stringify([file.statements.map((node) => syntax(node, file)), comments(text)]))
    .digest("hex");
}
function semanticSyntax(node, file) {
  if (ts.isParenthesizedExpression(node)) return semanticSyntax(node.expression, file);
  const fields = {};
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
    fields.operator = ts.SyntaxKind[node.operator];
  if (ts.isVariableDeclarationList(node))
    fields.declarationFlags =
      node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const | ts.NodeFlags.Using | ts.NodeFlags.AwaitUsing);
  if ("isTypeOnly" in node) fields.isTypeOnly = node.isTypeOnly;
  if (ts.isMetaProperty(node)) fields.keywordToken = ts.SyntaxKind[node.keywordToken];
  if (ts.isExportAssignment(node)) fields.isExportEquals = node.isExportEquals;
  const children = [];
  ts.forEachChild(node, (child) => {
    children.push(semanticSyntax(child, file));
  });
  return [ts.SyntaxKind[node.kind], fields, children.length ? children : node.getText(file)];
}
export function semanticReceipt(text) {
  const file = parse(text);
  return createHash("sha256")
    .update(JSON.stringify([file.statements.map((node) => semanticSyntax(node, file)), comments(text)]))
    .digest("hex");
}
function body(text, name) {
  const node = fn(text, name);
  assert(node.body);
  return node.body.getText();
}
function swap(text, before, after, count = 1) {
  assert.equal(text.split(before).length - 1, count, `exact mapped edit ${before}`);
  return text.split(before).join(after);
}
function replaceNode(text, node, replacement, origin = 0) {
  return text.slice(0, node.pos - origin) + replacement + text.slice(node.end - origin);
}
function returnedArray(node) {
  assert(node.body);
  const last = node.body.statements.at(-1);
  assert(ts.isReturnStatement(last) && last.expression && ts.isArrayLiteralExpression(last.expression));
  return last.expression;
}
function constant(node, name) {
  return one(
    node.body.statements.filter(
      (statement) =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.some((decl) => ts.isIdentifier(decl.name) && decl.name.text === name),
    ),
    name,
  ).getText();
}
function subscription(live, adapter) {
  const current = fn(live, "buildSubscribeBody"),
    dispatch = fn(live, "buildSubscribeDispatchBody"),
    legacy = fn(adapter, "buildSubscribeBody");
  const real = returnedArray(current),
    old = returnedArray(legacy),
    suffix = returnedArray(dispatch);
  assert.equal(real.elements.length, 5);
  assert.equal(old.elements.length, 5);
  assert.equal(suffix.elements.length, 13);
  assert.equal(real.elements[4].getText(), "...buildSubscribeDispatchBody(ids)");
  assert.equal(old.elements[4].getText(), "...buildSubscribeDispatchBody(dispatch)");
  for (let i = 0; i < 3; i++)
    assert.equal(receipt(`[${real.elements[i].getText()}]`), receipt(`[${old.elements[i].getText()}]`));
  const realIf = real.elements[3],
    oldIf = old.elements[3];
  assert(ts.isObjectLiteralExpression(realIf) && ts.isObjectLiteralExpression(oldIf));
  const arm = (object) =>
    one(
      object.properties.filter((prop) => prop.name?.getText() === "else"),
      "normalization else",
    );
  const realElse = arm(realIf),
    oldElse = arm(oldIf);
  assert(ts.isPropertyAssignment(realElse) && ts.isPropertyAssignment(oldElse));
  assert.equal(constant(current, "P"), constant(dispatch, "P"));
  assert.equal(constant(current, "INPUT"), constant(legacy, "INPUT"));
  assert.equal(constant(current, "P"), constant(legacy, "P"));
  const prefixComments = comments(live.slice(realElse.pos, realElse.initializer.getStart()));
  const realExpression = realElse.initializer.getText();
  let prefix = live.slice(real.getStart() + 1, real.elements[4].pos);
  prefix = replaceNode(
    prefix,
    realElse,
    `\nelse: resolveValueFuncIdx >= 0 ? (${prefixComments.join("\n")}\n${realExpression}) : (${oldElse.initializer.getText()})`,
    real.getStart() + 1,
  );
  let result = `{\n${[constant(current, "INPUT"), ...["STATE", "INDEX", "FULFILL_FN", "REJECT_FN", "P", "CAPS", "cbTypeIdx"].map((name) => constant(dispatch, name))].join("\n")}\nreturn [${prefix}${live.slice(suffix.getStart() + 1, suffix.end - 1)}];\n}`;
  result = swap(result, "{ op: ids.bagInit.op }", "closureBagInitInstr()");
  result = swap(result, "ids.resolveValueFuncIdx", "resolveValueFuncIdx");
  result = swap(result, "ids.markRejectionHandledFuncIdx !== undefined", "rt.markRejectionHandledFuncIdx >= 0");
  for (const field of ["callbackTypeIdx", "markRejectionHandledFuncIdx", "enqueueFuncIdx"])
    result = result.replaceAll(`ids.${field}`, `rt.${field}`);
  return result;
}

export function reconstructedBodies(reader) {
  const live = reader(combinatorPath),
    adapter = reader(donorPath),
    delay = reader(delayPath);
  // No surviving-file discovery, Git fallback, missing-root forgiveness, or
  // reordering canonical input into a passing historical order.
  for (const path of [combinatorPath, delayPath, donorPath, delayAdapterPath, allAdapterPath])
    assert(reader(path).length > 0, path);
  assert.deepEqual(
    parse(live)
      .statements.filter(ts.isFunctionDeclaration)
      .map((node) => node.name.text),
    [
      "buildSubscribeLocals",
      "buildSubscribeBody",
      "buildSubscribeDispatchBody",
      "buildAllFulfillLocals",
      "buildAllFulfillBody",
      "buildSettleWrapperLocals",
      "buildSettleResultBody",
      "buildRaceFulfillBody",
      "buildRejectBody",
      "buildNativePromiseCombinatorVectorBody",
    ],
  );
  assert.deepEqual(
    parse(delay)
      .statements.filter(ts.isFunctionDeclaration)
      .map((node) => node.name.text),
    [
      "buildNativePromiseDelayCallbackLocals",
      "buildNativePromiseDelayCallbackBody",
      "buildNativePromiseDelayProviderLocals",
      "buildNativePromiseDelayProviderBody",
    ],
  );
  const rows = donorNames.map((name) => {
    let text = name === "buildSubscribeBody" ? subscription(live, adapter) : body(live, name);
    if (name === "buildAllFulfillBody") text = swap(text, "ids.fulfillFuncIdx", "rt.fulfillFuncIdx");
    if (name === "buildRaceFulfillBody") text = swap(text, "ids, fulfillFuncIdx", "ids, rt.fulfillFuncIdx");
    if (name === "buildRejectBody") text = swap(text, "ids, rejectFuncIdx", "ids, rt.rejectFuncIdx");
    return [name, text];
  });
  let callback = body(delay, "buildNativePromiseDelayCallbackBody");
  for (const [before, after] of Object.entries({
    "resources.capture.captureTypeIdx": "callbackCaptureTypeIdx",
    "resources.capture.promiseFieldIdx": "3",
    "resources.capture.valueFieldIdx": "4",
    "resources.boxNumberFuncIdx": "boxNumberFuncIdx",
    "resources.resolveValueFuncIdx": "resolveValueFuncIdx",
  }))
    callback = callback.replaceAll(before, after);
  rows.push(["delay-callback", callback]);
  rows.push(["delay-callback-locals", body(delay, "buildNativePromiseDelayCallbackLocals")]);
  let locals = body(delay, "buildNativePromiseDelayProviderLocals");
  locals = swap(locals, 'const externref: ValType = { kind: "externref" };', "");
  locals = swap(locals, "typeIdx: promiseTypeIdx", "typeIdx: runtime.promiseTypeIdx");
  rows.push(["delay-provider-locals", locals]);
  let provider = body(delay, "buildNativePromiseDelayProviderBody");
  for (const [before, after] of Object.entries({
    "resources.promiseTypeIdx": "runtime.promiseTypeIdx",
    "resources.capture.captureTypeIdx": "callbackCaptureTypeIdx",
    "resources.timerCallbackFuncIdx": "timerCallbackFuncIdx",
    "resources.timerFuncIdx": "timerFuncIdx",
    "resources.boxNumberFuncIdx": "boxNumberFuncIdx",
    "resources.rejectFuncIdx": "runtime.rejectFuncIdx",
    "resources.exnTagIdx": "exnTagIdx",
    "resources.callbackArity": "0",
    "{ op: resources.bagInit.op }": "closureBagInitInstr()",
  }))
    provider = provider.replaceAll(before, after);
  rows.push(["delay-provider", provider]);
  const vector = fn(live, "buildNativePromiseCombinatorVectorBody");
  assert.equal(vector.body.statements.at(-1).getText(), "return body;");
  let loop = live.slice(vector.body.statements[3].pos, vector.body.statements.at(-1).pos);
  for (const [before, after] of Object.entries({
    "body.push": "fctx.body.push",
    "{ op: ids.bagInit.op }": "closureBagInitInstr()",
    "ids.fulfillFuncIdx": "rt.fulfillFuncIdx",
    "ids.rejectFuncIdx": "rt.rejectFuncIdx",
    "ids.fulfillReactionFuncIdx": "reaction.fulfillIdx",
    "ids.rejectReactionFuncIdx": "reaction.rejectIdx",
    'ids.emptyResult.kind === "fulfill-vector"': 'method === "all" || method === "allSettled"',
    'ids.emptyResult.kind === "reject-aggregate"': 'method === "any"',
    "ids.emptyResult.aggregateErrorFuncIdx": "ids.aggErrNewFuncIdx!",
  }))
    loop = loop.replaceAll(before, after);
  rows.push(["vector-loop", `{${loop}}`]);
  return rows;
}

// ORIGINAL_EVIDENCE is populated once from the pinned donor, never from the
// reconstructed candidate. BRIDGE_EVIDENCE separately pins new projection glue.
export const ORIGINAL_EVIDENCE = {
  buildSubscribeLocals: "6250dba8140c4eb19e869d984c25ffcf89aaf64cd1726344ff1be8850d144fed",
  buildSubscribeBody: "764d288804a270eee6b840b610e9e103b136b496a098481c490eef3c7282af5b",
  buildAllFulfillLocals: "19da2332ee0e025f396556bc49f29940a4127b16a10568162350ff1502459f0f",
  buildAllFulfillBody: "5610aa3ac6deb101a646b210d7b4c9b0a5afae5446f461b9f7fd308d2365320b",
  buildSettleWrapperLocals: "73d8ef0afc450b478128f4c964201fd237415ce01b629dc45ac7bc579d16e02f",
  buildSettleResultBody: "7a88ff8cfeac9ef182ebd2dde5b1a2c631b646808d1f0b7a18228acaeed8b296",
  buildRaceFulfillBody: "67fb1d9ad3bfda1ec6e36d9c815fdcfefd311bedc880bf37d50c0fcb17e97690",
  buildRejectBody: "92b7659c9cc8317f818652892fbf12d0ca4856531a12abede5a7299a132bc86d",
  "delay-callback": "2cd408f7bd91133a9c12b684a4b0e51f22ee90f06dca3fae8d89b4dd9878ba04",
  "delay-callback-locals": "123be3fc33db5a99c68f15da5a4acc3a2a99903c684c84e50625ec9a806832d7",
  "delay-provider-locals": "65ad3e02b14f3f4bf298349a3a92ca68a9880bd6ae861798af239d6add2bbe7d",
  "delay-provider": "5223ae8c30c0be2ac7f8078e32ebedd6182ad807bff54741a8c6f15776244bfa",
  "vector-loop": "defafde0bb670f6826e528a72ac04384094c6e40a724726c189aa1dfbf9a1a26",
};
export const BRIDGE_EVIDENCE = {
  "src/runtime/wasmgc/promise/combinator-bodies.ts": "98f3672f240c59a7f4d178ca974a5221f523eee8d78f2710264f07974eb7e0ad",
  "src/runtime/wasmgc/promise/delay-bodies.ts": "3ff9e8d601288d0104851e75e28dd91652a3e1e9d6cd28956588f85e924a3ebd",
  "src/codegen/promise-combinators.ts": "e4e93c4bd65d41e0c18fe6c63b33c5204084a3dd7073b3f050f405eec62d7f05",
  "src/codegen/ir-native-promise-delay.ts": "47464e85dbfb8b946fc1e693909936e6adc15eaeb89eaf1320d5879154f7f21a",
  "src/codegen/ir-native-async-runtime.ts": "a3ca0c45860f72df8804113d4e15b8621363e84c4a7c9ed0999e5e065755675f",
};

// Supplemental historical evidence derived from e3a01efa44f68da1b93c16b1a728d0ba099183f9.
// The original thirteen hashes above remain unchanged.
export const ORIGINAL_SEMANTIC_EVIDENCE = {
  buildSubscribeLocals: "5f5f0eddaef8fa23895ff6dfb668139bcbb2b495ac010b098c1ec069bcddb019",
  buildSubscribeBody: "3e48429629493cc5df741ff8e3078e5a9df4bd99f7006e696ebd0c3007bf799c",
  buildAllFulfillLocals: "b16066b826c152eb437bd6424bc6bea7eca79650adeb30df3683ef1ece319202",
  buildAllFulfillBody: "12205c4903ba6c8ddf78798fbc585c11ed0670215c73726523c6c9bfe1e76923",
  buildSettleWrapperLocals: "de7baaef7752270ed0da77d4027bf952744ad9d836b9829074853ea80f230744",
  buildSettleResultBody: "7f006d7ebe2e3c09b9841761f074291081466ea05660f9101afd3b45586a4a0a",
  buildRaceFulfillBody: "046a935d7da5ee44677cfcb566289750b9492f0fc7a5488604f4be2e4a3acf6b",
  buildRejectBody: "b3bfb1c8d297a56146b278cef4d5802fad1d626686dfee5e133855bef9643683",
  "delay-callback": "740e83b58b7f32420f2ccdeb6fd24b01321bb32394416b47ddfe45fe38bef572",
  "delay-callback-locals": "b529915872973d4e6063157e9beb80227a9d82ef14b51599c0bb2c0afeaf8d5c",
  "delay-provider-locals": "972b5b9846d8e826ca033863371e5c296231a8a8d3e858a26c2726b8edd4df7f",
  "delay-provider": "ddf85023559938880116398f5c7614f69479c72ca1266e928843fb85feb8c507",
  "vector-loop": "377d023895ba77a5b0db3b38a28686f407d0061755bb153e58f0ec4f871ca346",
};

// This is current approved projection-glue evidence, NOT historical evidence.
export const BRIDGE_SEMANTIC_EVIDENCE = {
  "src/runtime/wasmgc/promise/combinator-bodies.ts": "97584369936e253a8bd3e1ed3f3bcbbb81fc700262e1d674bc3f7c27a1bf6bd7",
  "src/runtime/wasmgc/promise/delay-bodies.ts": "634f7d228a0e9e2efba61057817fa485183f12b4f3c16ebfca6fd29cbd069d54",
  "src/codegen/promise-combinators.ts": "2617112376ea029d8c9c76db63c83e1f3fcb3332df231ca4bc7ac662ba4dc64b",
  "src/codegen/ir-native-promise-delay.ts": "5d402fc54839a19fd8f508d69802e976a221021507cabab7d9c74a6d9008e8aa",
  "src/codegen/ir-native-async-runtime.ts": "10bdad408fd424dfcf64af2981c8aaa1e803ad8d8e85850daea8e7d8f01266b9",
};

// Fixed source-qualified original declarations, including attached JSDoc,
// complete nested bodies, declaration kind and same-name occurrence ordinal.
export const RETAINED_DECLARATIONS = [
  {
    path: "src/codegen/promise-combinators.ts",
    name: "isNativeCombinatorMethod",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "de11b40a6ce6f31baffd5f866bf5955952945d091c82f8b0d9fc07114c9edfdd",
    semanticReceipt: "42ceeeefd81f424004cf991226dd6a07b2f15fc082b7ad9ef823812dc1a22a10",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "buildCustomCapabilityExecutorInstrs",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "6b1c4aab14539702f118d693bcd4d69ab12645fd7ee50c083797e06b43d636a0",
    semanticReceipt: "903b2b462d87940547ed41acfbd2cb39d02d09d9dca43250f3c45e59f32a88de",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "customCapabilityTypeError",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "6debe1d91230ef310e67b8b0ed6677f6c12a5719c4d731f7604792ca6babf2f9",
    semanticReceipt: "81093b9ab427d0feddb14f5cf069fc6c04e5b3a50600f8a0f7c89e6e9b54d077",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "ensureCustomCapabilityRuntime",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "a7d0f831ee826c02b77be6dcfe1dde40caae1f33a74d6a46432094e0b8dbc606",
    semanticReceipt: "9e1163e13b68c368c207d5a1a323d7f3b10459ee457874218f6dc8aa60ea052a",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "emitStandalonePromiseCustomCapabilityCheck",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "075f06046bf6945ebe775ac1fe2a624013108b0b33b8b3ef83098a213a1ef433",
    semanticReceipt: "6c5e4453934455ae68420bc7a144094ccd6da3da3e2d34f4db9bf83f820d45ab",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "emitStandalonePromiseCustomSettle",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "fd96ed2a65b3cf53b5cfdf7e43e06f85749a5767e08cf4e15acf2e7940fa6ee3",
    semanticReceipt: "c05104d6888519f6e8d91210607135996c2055bf7f7bfb7fbf2ba68889733f9e",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "registerStruct",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "181281d6dcd6616356586997a74dc7102a33cddd14b93d33de51d1fbc6666b38",
    semanticReceipt: "8048dc9e57536c2ab12328316444228a19f5e067dee888027dce755f9a864906",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "ensureSettledAnyCombinators",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "7b25d72c982311513b9e5a660acc5e36edef5aa37c974d32ce0599492aff16c0",
    semanticReceipt: "2a076b4621573f5055113a3b2ecc89bc140dfa006615eb4e68222fe1e4635533",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "combinatorReactionFns",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "fe4e30527da062f5ce8edff1b741f0a47da7f909ad051250d34ed9d475f9dbce",
    semanticReceipt: "d7ee706eebea46c1102beff0a557188ac1fe54368d2290800031f0d987839cd7",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "buildSettledWrapperLocals",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "d43567fa90dc3d54d2a4363e2b93f77aaa89a1e306f868966283b11d137f6b8a",
    semanticReceipt: "e9d04bbffa53dad2aa07d5dabb032aea6b6d67c2cd742e6baf5db0577c6b8ae8",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "buildAllSettledBody",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "37bff1120677e2769ec8ee7472ac099b4767eb64f539a22d1231d1454a649cd6",
    semanticReceipt: "55a64dd356e632b1ab17422480ddc72b6e7409f3731c84003379776ad08598e2",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "buildAnyRejectBody",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "20119ee893a34509bc0e008ad9cc87d901bb6e998a2d1240cd038bd684ea71ff",
    semanticReceipt: "3ef4198466b8fde7c3af83c09fe62fd7b00e3326a84042482cbbf0e665fa26a3",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "buildNewAggregateErrorBody",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "ed19b5f11aad1b974e91eb2f51356834c7692fb9dcd9383fc41334705342c55d",
    semanticReceipt: "85b9ce00765ae84b6d298a9723f6dbf541fc884a8d0e198e1d960f62fe28bba5",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "emitStandalonePromiseCombinator",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "358e4214330b1ad89ecb59eb4a65dfa5a643bdf171f411035df651e724cf1a78",
    semanticReceipt: "d6dcb494bd7cd1d6e8a61d858102fdf0b5004c801d5cfc3efd80730e5f0446d4",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "resolveExternrefVecArg",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "4b3407b71cfc2f988529a2d758bad07c6803e821552588544b165a2115b6d856",
    semanticReceipt: "b162732ccb492ecd367086b56c91f56085d4e289ec4ac8f4d084d922b64879ac",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "toVecStringArmAvailable",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "6b4f8467fc5f0f3720e4d776b55bf5224338c97595fbbf6534f7f839fe02f3bb",
    semanticReceipt: "d893d24735d1ba74ac76d02ce4ee83dc543af8c8f62dc61ab5e00103f7bdd649",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "ensureCombinatorToVec",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "44c647a97bce159f095206aa0b3d00b6267d35597a56df71bc947083d4920d47",
    semanticReceipt: "0047b04ca6cbb59d73034555f5bb53570abed1c40b79c66e43e61523c08c8bd5",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "buildToVecCommonHead",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "e7e36fdc899a7f8e170f61d025289d535e81155a06b0778a77bfe7cacb6a340f",
    semanticReceipt: "48c79e6b96fc328dca8545621fe6467c8228c8c96b1087844202f0dd2836b798",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "buildToVecStringArm",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "eb80557e191bbc8bf4d328e617e8256c128fe4dc2cd2d83537842730723f2210",
    semanticReceipt: "e05d02d1a012610b6004f72e3418ac55ca79016c7693a2a52f27df70d331f867",
  },
  {
    path: "src/codegen/promise-combinators.ts",
    name: "fillCombinatorToVec",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "312680075e7459b85e85584f0bf8fc69195ae762b3d23c4994e0f4acb029848b",
    semanticReceipt: "137d13f5a700bc01f3073f607d7bada937e571e79c1983c32901530cb756546f",
  },
  {
    path: "src/codegen/ir-native-promise-delay.ts",
    name: "requireUnoccupiedProviderName",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "00799efee7fdd45d1af82771de87b2aa71e026c0f69f198319a843568fcfdbd7",
    semanticReceipt: "51d48e71b910d0fe0e29401b0ef3ab57d1d8f29d4e5fe70fc2f012ae62209fe4",
  },
  {
    path: "src/codegen/ir-native-promise-delay.ts",
    name: "hasUnoccupiedProviderName",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "13eb0825948f00038066269a525a5a4d935c360e10a6cb96b9796970695ee207",
    semanticReceipt: "ede4d7a90519eb3510de7691d36594732aaaef20a7e0f44e478673684e244eca",
  },
  {
    path: "src/codegen/ir-native-promise-delay.ts",
    name: "hasExactIrNativePromiseDelayProvider",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "47cbc9ab0cd3db586a7319697baf23fa719b3fc6d70e4b7139c382ab7cbded61",
    semanticReceipt: "8274160252b142dd5248e387191f2819019766b26e67ed53950addf8e978b8f5",
  },
  {
    path: "src/codegen/ir-native-promise-delay.ts",
    name: "canEnsureIrNativePromiseDelayProvider",
    kind: "FunctionDeclaration",
    occurrence: 0,
    receipt: "d103eb3884592c2d73242247229b6b5b96c07de1cd2ef6eb089d91cb67c492bd",
    semanticReceipt: "2b051fdcfba3b2342f21577e42eb0d01c6982846ab675d0254fb723fbf196d32",
  },
];
const CURRENT_OWNER_FUNCTIONS = {
  "src/codegen/promise-combinators.ts": [
    "isNativeCombinatorMethod",
    "buildCustomCapabilityExecutorInstrs",
    "customCapabilityTypeError",
    "ensureCustomCapabilityRuntime",
    "emitStandalonePromiseCustomCapabilityCheck",
    "emitStandalonePromiseCustomSettle",
    "registerStruct",
    "ensureCombinatorFunctions",
    "ensureSettledAnyCombinators",
    "combinatorReactionFns",
    "buildSubscribeBody",
    "combinatorBagInit",
    "buildSettledWrapperLocals",
    "buildAllSettledBody",
    "buildAnyRejectBody",
    "buildNewAggregateErrorBody",
    "emitStandalonePromiseCombinator",
    "resolveExternrefVecArg",
    "emitStandalonePromiseCombinatorRuntime",
    "toVecStringArmAvailable",
    "ensureCombinatorToVec",
    "buildToVecCommonHead",
    "buildToVecStringArm",
    "fillCombinatorToVec",
  ],
  "src/codegen/ir-native-promise-delay.ts": [
    "requireUnoccupiedProviderName",
    "hasUnoccupiedProviderName",
    "hasExactIrNativePromiseDelayProvider",
    "canEnsureIrNativePromiseDelayProvider",
    "ensureIrNativePromiseDelayProvider",
  ],
};

function verifyRetainedDeclarationsRaw(reader) {
  assert.equal(RETAINED_DECLARATIONS.length, 24);
  const result = [];
  for (const [path, count] of [
    [donorPath, 20],
    [delayAdapterPath, 4],
  ]) {
    const text = reader(path),
      file = parse(text);
    const expected = RETAINED_DECLARATIONS.filter((row) => row.path === path);
    assert.equal(expected.length, count, "fixed retained denominator " + path);
    const declarations = file.statements.filter(ts.isFunctionDeclaration);
    // Account for the separately mapped donor functions too: no replacement,
    // extra overload, renamed owner, or order change can disappear in a filter.
    assert.deepEqual(
      declarations.map((node) => node.name?.text),
      CURRENT_OWNER_FUNCTIONS[path],
      "current declaration order " + path,
    );
    const names = new Set(expected.map((row) => row.name));
    const selected = declarations.filter((node) => names.has(node.name?.text));
    assert.deepEqual(
      selected.map((node) => node.name.text),
      expected.map((row) => row.name),
      "original retained declaration order " + path,
    );
    for (const node of selected) {
      const full = text.slice(node.getStart(file, true), node.end);
      const row = {
        path,
        name: node.name.text,
        kind: ts.SyntaxKind[node.kind],
        occurrence: declarations
          .slice(0, declarations.indexOf(node))
          .filter((previous) => previous.name?.text === node.name.text).length,
        receipt: receipt(full),
        semanticReceipt: semanticReceipt(full),
      };
      result.push(row);
    }
  }
  assert.deepEqual(result, RETAINED_DECLARATIONS, "original retained declaration ledger");
  return { combinator: 20, delay: 4 };
}

export function verifyRetainedDeclarations(reader) {
  return verifyRetainedDeclarationsRaw((path) => reconstructB1Source(path, reader));
}

export function verifyHistorical(liveReader) {
  // B1 is mandatory live input. Invert only its checked extraction before
  // applying the unchanged original body, declaration and bridge receipts.
  const reader = (path) => reconstructB1Source(path, liveReader);
  const rows = reconstructedBodies(reader);
  assert.deepEqual(
    rows.map(([name]) => name),
    Object.keys(ORIGINAL_EVIDENCE),
  );
  for (const [name, text] of rows) assert.equal(receipt(text), ORIGINAL_EVIDENCE[name], `historical body ${name}`);
  assert.deepEqual(Object.keys(ORIGINAL_SEMANTIC_EVIDENCE), Object.keys(ORIGINAL_EVIDENCE));
  for (const [name, text] of rows)
    assert.equal(semanticReceipt(text), ORIGINAL_SEMANTIC_EVIDENCE[name], `historical semantic body ${name}`);
  verifyRetainedDeclarationsRaw(reader);
  for (const [path, expected] of Object.entries(BRIDGE_EVIDENCE))
    assert.equal(receipt(reader(path)), expected, `live glue/schema ${path}`);
  assert.deepEqual(Object.keys(BRIDGE_SEMANTIC_EVIDENCE), Object.keys(BRIDGE_EVIDENCE));
  for (const [path, expected] of Object.entries(BRIDGE_SEMANTIC_EVIDENCE))
    assert.equal(semanticReceipt(reader(path)), expected, `live semantic glue/schema ${path}`);
  return { historicalDonors: 8, delayRows: 4, vectorLoops: 1, sharedDispatchHelpers: 1 };
}

// Public-source preservation, not physical admission. One fresh child per
// explicit compiler root, with terminal/progress receipts and no kill timer.
export const publicArmSource = String.raw`
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
const observe = event => console.log("DELAY_COMBINATOR_PROGRESS=" + JSON.stringify(event));
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
  assert.equal(execFileSync("git", ["diff", "1cb0f5c7f36be14d7be7eb4592973aea84a8c4e5", "--", "src"], {cwd:root, encoding:"utf8"}), "");
  assert.equal(execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", "src"], {cwd:root, encoding:"utf8"}), "");
}
const compiler = await load("src/index.ts");
const runtime = await load("src/runtime.ts");
const { evidenceValue } = await load("tests/helpers/semantic-provider-source-receipts.mjs");
const ts = (await load("node_modules/typescript/lib/typescript.js")).default;
function template(path, callName, needle) {
  const file=ts.createSourceFile(path,read(path),ts.ScriptTarget.Latest,true),matches=[];
  assert.equal(file.parseDiagnostics.length,0);
  function literal(node) {
    if(ts.isNoSubstitutionTemplateLiteral(node) || ts.isStringLiteral(node))return node.text;
    assert(ts.isTemplateExpression(node),"grounded literal template");
    let value=node.head.text;
    for(const span of node.templateSpans) {
      assert(ts.isIdentifier(span.expression) && span.expression.text==="PRELUDE","only published PRELUDE interpolation");
      value+=constant(path,"PRELUDE")+span.literal.text;
    }
    return value;
  }
  function visit(node) {
    if(ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text===callName && node.arguments.length>0) {
      const argument=node.arguments[0];
      if(ts.isNoSubstitutionTemplateLiteral(argument)||ts.isTemplateExpression(argument)) {
        const source=literal(argument); if(source.includes(needle))matches.push(source);
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(file);assert.equal(matches.length,1,"one grounded fixture "+path+":"+needle);return matches[0];
}
function constant(path,name) {
  const file=ts.createSourceFile(path,read(path),ts.ScriptTarget.Latest,true),matches=[];
  for(const statement of file.statements)if(ts.isVariableStatement(statement))
    for(const declaration of statement.declarationList.declarations)
      if(ts.isIdentifier(declaration.name)&&declaration.name.text===name)matches.push(declaration.initializer);
  assert.equal(matches.length,1,"one mandatory constant "+name);
  assert(ts.isNoSubstitutionTemplateLiteral(matches[0])||ts.isStringLiteral(matches[0]));return matches[0].text;
}
function exactEdit(source,before,after) {
  assert.equal(source.split(before).length,2,"one explicit source derivation "+before);return source.replace(before,after);
}
const familyPath = "website/playground/examples/js/async.ts";
let family = read(familyPath);
for (const name of ["fetchUser", "fetchAllSequential", "fetchAllParallel"]) {
  assert.equal(family.split("async function " + name).length,2);
  family = family.replace("async function " + name,"export async function " + name);
}
const fixtures = [
  {id:"family",path:familyPath,source:family,target:"standalone",action:"family",derivation:"export three existing family helpers"},
  {id:"delay",path:"tests/issue-4573-standalone-native-promise-delay.test.ts",constant:"EXACT_DELAY",action:"delay"},
  {id:"race-vector",path:"tests/issue-2867-gap4.test.ts",call:"runWasi",needle:"const a = [Promise.resolve(5), Promise.resolve(9)]",action:"read",expected:{getVal:5,getRj:0}},
  {id:"all-settled-vector",path:"tests/issue-3137.test.ts",call:"runStandaloneHostFree",needle:"rs[1].value === 5",action:"test",expected:1},
  {id:"any-vector",path:"tests/issue-3137.test.ts",call:"runStandaloneHostFree",needle:"Promise.resolve(9)",action:"test",expected:1},
  {id:"empty-all-settled",path:"tests/issue-3137.test.ts",call:"runStandaloneHostFree",needle:"rs.length === 0",action:"test",expected:1},
  {id:"empty-any",path:"tests/issue-3137.test.ts",call:"runStandaloneHostFree",needle:"Promise.any([])",action:"test",expected:1},
  {id:"invalid-before-empty",path:"tests/issue-2867-gap4.test.ts",call:"runWasi",needle:"const x: any = 1;",action:"read",expected:{getFf:0,getRj:2}},
  {id:"grown-vector",path:"tests/issue-2867-gap4.test.ts",call:"runWasi",needle:"arr[0]*100 + arr[1]*10 + arr[2]",action:"read",expected:{getVal:123,getRj:0},
    edits:[["Promise.all(a).then","a.push(Promise.resolve(4)); a.push(Promise.resolve(5)); a.pop(); a.pop();\nPromise.all(a).then"],
           ["val = arr[0]*100 + arr[1]*10 + arr[2]","val = arr.length === 3 ? arr[0]*100 + arr[1]*10 + arr[2] : -1"]]},
  {id:"thenable-all",path:"tests/issue-3125.test.ts",call:"runWasi",needle:"resolve(42); } };",action:"test",expected:1,
    edits:[["Promise.resolve(thenable)","Promise.all([thenable])"],["(val === 42)","(val[0] === 42)"]]},
  {id:"poisoned-then-all",path:"tests/issue-3125-widen.test.ts",call:"runWidenStandalone",needle:"Promise.resolve(poisoned).then",action:"test",expected:1,
    edits:[["Promise.resolve(poisoned)","Promise.all([poisoned])"]]},
];
for(const fixture of fixtures) {
  fixture.target="standalone";
  if(!fixture.source) fixture.source=fixture.constant?constant(fixture.path,fixture.constant):template(fixture.path,fixture.call,fixture.needle);
  fixture.groundedSourceSha256=hash(fixture.source);
  for(const [before,after] of fixture.edits??[])fixture.source=exactEdit(fixture.source,before,after);
  if(fixture.action==="read") {
    fixture.derivation="existing runWasi harness, standalone target"+(fixture.edits?"; explicit push/pop length probe":"");
    fixture.source="let ff=0;let rj=0;let val=0;\n"+fixture.source+"\nexport function getFf():number{return ff;}\nexport function getRj():number{return rj;}\nexport function getVal():number{return val;}";
  } else if(fixture.call==="runStandaloneHostFree")fixture.source="declare function __drain_microtasks(): void;\n"+fixture.source;
  fixture.sourceFileSha256=hash(read(fixture.path));fixture.sourceSha256=hash(fixture.source);
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
    if (((action === "sequential-reject" || action === "parallel-reject") && id === 1) || action === "delay-reject") { events.push(["reject",id]); throw new Error("injected timer registration failure at 1"); }
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
async function executeDelay(result) {
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).map(x=>x.module+"."+x.name),["env.__timer_set_timeout"]);
  const outcomes=result.irOutcomes.filter(x=>x.unitKind==="function"&&x.displayName==="delay");
  assert.equal(outcomes.length,1);assert.equal(outcomes[0].kind,"emitted");assert.equal(outcomes[0].irBodyEmitted,true);assert.equal(outcomes[0].legacyBodyEmitted,false);
  const h=await instantiate(result,"delay"),ex=h.ex,state=functionAt(ex,"__promise_boundary_state"),value=functionAt(ex,"__promise_boundary_value");
  const slow=functionAt(ex,"delay")(25,111),fast=functionAt(ex,"delay")(1,222);
  const before=[state(fast),state(slow)];assert.deepEqual(before,[0,0]);assert.equal(h.jobs.length,2);
  h.jobs[1]();const afterFast=[state(fast),state(slow),value(fast),value(slow)];assert.deepEqual(afterFast,[1,0,222,null]);
  h.jobs[1]();assert.deepEqual([state(fast),state(slow),value(fast),value(slow)],afterFast);
  h.jobs[0]();const afterSlow=[state(fast),state(slow),value(fast),value(slow)];assert.deepEqual(afterSlow,[1,1,222,111]);
  const rejected=await instantiate(result,"delay-reject"),p=functionAt(rejected.ex,"delay")(1,73);
  const rejection=[functionAt(rejected.ex,"__promise_boundary_state")(p),functionAt(rejected.ex,"__promise_boundary_value")(p)];
  assert.deepEqual(rejection,[2,null]);
  return [{action:"concurrent-delay",before,afterFast,afterSlow,events:h.events,instantiatedBinary:h.instantiatedBinary},
    {action:"registration-rejection",rejection,events:rejected.events,instantiatedBinary:rejected.instantiatedBinary}];
}
const rows=[];
for(const fixture of fixtures) {
  const row={id:fixture.id,fixture};rows.push(row);observe({kind:"row-start",id:fixture.id});
  try {
    const result=await awaitStep(compiler.compile(fixture.source,{fileName:"delay-combinator-"+fixture.id+".ts",target:"standalone",experimentalIR:true,trackFallbacks:true,trackIrOutcomes:true,skipSemanticDiagnostics:true,emitWat:true,...(fixture.action==="family"?{hostBridge:"always"}:{})}),{phase:"compile",id:fixture.id});
    row.result=dataResult(result);row.binary=Buffer.from(result.binary).toString("base64");row.wat=result.wat;
    assert.equal(result.success,true,JSON.stringify(result.errors));assert.equal(WebAssembly.validate(result.binary),true);assert.equal(result.irPostClaimErrors?.length??0,0);
    const module=new WebAssembly.Module(result.binary);
    row.imports=WebAssembly.Module.imports(module);row.exports=WebAssembly.Module.exports(module);
    if(fixture.action==="family")row.values=await executeFamily(result);
    else if(fixture.action==="delay")row.values=await executeDelay(result);
    else {
      assert.deepEqual(row.imports,[],"native combinator source has no host imports");
      const h=await instantiate(result,fixture.action);let actual;
      if(fixture.action==="test")actual=functionAt(h.ex,"test")();
      else {
        functionAt(h.ex,"run")();functionAt(h.ex,"__drain_microtasks")();
        actual=Object.fromEntries(Object.keys(fixture.expected).map(name=>[name,functionAt(h.ex,name)()]));
      }
      assert.deepEqual(actual,fixture.expected);row.values=[{actual,instantiatedBinary:h.instantiatedBinary}];
    }
    row.kind="executed";
  }catch(error){row.kind="failed";row.error={name:error.name,message:error.message,...(error.code===undefined?{}:{code:error.code}),...(error.context===undefined?{}:{context:error.context})};}
  observe({kind:"row-completed",id:fixture.id,verdict:row.kind});
}
assert.equal(rows.length,11);assert.deepEqual(snapshot(),before,"source changed during measurement");
console.log("DELAY_COMBINATOR_RECEIPT="+JSON.stringify({schema:"delay-combinator-source-preservation-v1",root,arm,urls,sourceFiles:before,fixtures,rows,closureCertified:false,physicalAcceptanceCertified:false,retirementCertified:false}));

`;

export const fixtureIds = [
  "family",
  "delay",
  "race-vector",
  "all-settled-vector",
  "any-vector",
  "empty-all-settled",
  "empty-any",
  "invalid-before-empty",
  "grown-vector",
  "thenable-all",
  "poisoned-then-all",
];
export const familyActions = [
  "pending-70",
  "non-i31",
  "sequential",
  "parallel-reverse",
  "empty",
  "sequential-reject",
  "parallel-reject",
  "undefined",
];
export async function executeArm(compilerRoot, arm, directory) {
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
  writeFileSync(join(directory, arm + "-started.json"), JSON.stringify(started, null, 2));
  console.log("delay/combinator child " + arm + ": pid=" + child.pid + "; progress=" + directory);
  let output = "",
    pendingLine = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    pendingLine += chunk;
    appendFileSync(join(directory, arm + ".log"), chunk);
    const lines = pendingLine.split("\n");
    pendingLine = lines.pop();
    for (const line of lines)
      if (line.startsWith("DELAY_COMBINATOR_PROGRESS=")) {
        const progress = line.slice("DELAY_COMBINATOR_PROGRESS=".length);
        appendFileSync(join(directory, arm + "-progress.jsonl"), progress + "\n");
        console.log(arm + ": " + progress);
      }
  });
  child.stderr.on("data", (chunk) => appendFileSync(join(directory, arm + ".stderr.log"), chunk));
  await new Promise((resolveTerminal, rejectTerminal) => {
    child.once("error", (error) => {
      writeFileSync(join(directory, arm + "-terminal.json"), JSON.stringify({ ...started, error: error.message }));
      rejectTerminal(error);
    });
    child.once("close", (code, signal) => {
      writeFileSync(
        join(directory, arm + "-terminal.json"),
        JSON.stringify({ ...started, code, signal, completedAt: new Date().toISOString() }, null, 2),
      );
      if (code !== 0 || signal !== null)
        rejectTerminal(
          new Error(arm + " child terminated code=" + code + " signal=" + signal + "; evidence " + directory),
        );
      else resolveTerminal();
    });
  });
  const line = one(
    output.split("\n").filter((value) => value.startsWith("DELAY_COMBINATOR_RECEIPT=")),
    arm + " terminal receipt",
  );
  const report = JSON.parse(line.slice("DELAY_COMBINATOR_RECEIPT=".length));
  writeFileSync(join(directory, arm + ".json"), JSON.stringify(report, null, 2));
  return report;
}
export function validateArm(report, expectedRoot) {
  assert.equal(report.schema, "delay-combinator-source-preservation-v1");
  assert.equal(report.root, realpathSync(expectedRoot));
  assert.deepEqual(report.urls.slice(0, 2), [
    new URL("file://" + report.root + "/src/index.ts").href,
    new URL("file://" + report.root + "/src/runtime.ts").href,
  ]);
  assert(report.sourceFiles.length > 1000);
  assert.deepEqual(
    report.fixtures.map((fixture) => fixture.id),
    fixtureIds,
  );
  assert.deepEqual(
    report.rows.map((row) => row.id),
    fixtureIds,
  );
  let executions = 0;
  for (const [index, row] of report.rows.entries()) {
    assert.equal(row.kind, "executed", JSON.stringify({ id: row.id, error: row.error }));
    assert.deepEqual(row.fixture, report.fixtures[index]);
    assert(Buffer.from(row.binary, "base64").length > 8);
    assert(row.wat.length > 0);
    assert.match(row.fixture.sourceFileSha256, /^[0-9a-f]{64}$/);
    assert.equal(createHash("sha256").update(row.fixture.source).digest("hex"), row.fixture.sourceSha256);
    assert(row.fixture.source.length > 0);
    assert.equal(row.values.length, row.id === "family" ? 8 : row.id === "delay" ? 2 : 1);
    if (row.id === "family")
      assert.deepEqual(
        row.values.map((value) => value.action),
        familyActions,
      );
    if (row.id === "delay")
      assert.deepEqual(
        row.values.map((value) => value.action),
        ["concurrent-delay", "registration-rejection"],
      );
    for (const value of row.values) assert.equal(value.instantiatedBinary, row.binary);
    executions += row.values.length;
  }
  assert.equal(executions, 19);
  assert.equal(report.closureCertified, false);
  assert.equal(report.physicalAcceptanceCertified, false);
  assert.equal(report.retirementCertified, false);
}
