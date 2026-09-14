// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as oldBindings from "../src/ir/callable-bindings.js";
import * as bindings from "../src/ir/core/callable-bindings.js";
import * as oldEffects from "../src/ir/effects.js";
import * as effects from "../src/ir/analysis/effects.js";
import * as oldIntrinsics from "../src/ir/intrinsics.js";
import * as catalog from "../src/ir/core/intrinsics.js";
import * as intrinsic from "../src/ir/analysis/intrinsics.js";
import * as oldAsync from "../src/ir/async-plan.js";
import * as asyncPlan from "../src/ir/analysis/async-plan.js";
import * as oldAsyncProviders from "../src/ir/async-runtime-providers.js";
import * as intents from "../src/ir/core/async-intents.js";
import { INTRINSIC_RUNTIME_FEATURES } from "../src/ir/runtime/contracts/intrinsics.js";
import { verifyIrIntrinsicInstruction } from "../src/ir/intrinsic-support.js";
import { asValueId, type IrInstr, type IrInstrIntrinsic } from "../src/ir/core/nodes.js";
import { irVal, type IrType } from "../src/ir/core/types.js";
import type { IntrinsicUse } from "../src/ir/core/intrinsic-contracts.js";
import type { IrAsyncPlan } from "../src/ir/core/async-plan.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// Complete declaration text/docs from b4c116639a7e146e83611a988a8da28d77de9368.
// This fixed 92-declaration subset supplements the parent's 224/118 ledger.
// No Git history is required at runtime. These are preservation controls, not
// public-call witnesses, complete preparation closure or native execution proof.
const receipts = [
  {
    oldPath: "src/ir/callable-bindings.ts",
    path: "src/ir/core/callable-bindings.ts",
    rows: [
      ["IrCallableBindingOwnerId", "87efad10f157c3effd1d5826f328b29def760f4b73557dc96ae7bab627a9b173"],
      ["IR_FNCTOR_CONSTRUCTOR_SUPPORT_ROLE", "e1ef5cfb227a80136142dd76a75dfa188dbd160b157506ba83bd9fd743a8d367"],
      ["requireNonEmpty", "26a31fd75594a06fedf1fa8ff2a895fd03f3e5e10a61c123d2f492e65d330b92"],
      ["compatibilityName", "e3c88f8e01092ecbc3c8664e021929ed55092e6805782872642af573f2c8b710"],
      ["funcRef", "4e9e3395c618c4f264fc269ecb8a1c417885679d9dcd8b86fde3c5f401f60786"],
      ["irUnitCallableBindingId", "5149f2c1a7977a918ec0fb72131f4296c794e78be703fbffde440e47df4d0e58"],
      ["irUnitFuncRef", "a14db2bba0fedf6cae116a70389e1987c22ec4cf4ddfd911b2c40657fed37bac"],
      ["irImportFuncRef", "d75b45e2c953ab76163f744a0cd793be323846f14baefb357edced0be9035316"],
      ["irCapabilityImportFuncRef", "c444138846e2cd5f0589a5b5bf897fa18fb87da4a36866202c0a11df3577368c"],
      ["irRuntimeFuncRef", "7530c79a6afac8cdea9a8b685d60a3f599de7a96ad62f3666cb5e9124b1ddf52"],
      ["irIntrinsicFuncRef", "a0ccabf778e311fd0701c49b8fc84a78462a7cf5f186147bbae4bce2574871a0"],
      ["irSupportFuncRef", "7529ceffdc7d4c0b99afe6ccaea517ae3c8348215f2cd6632c8bd390291f3002"],
      ["irFnctorConstructorBindingId", "5f2af0a5ee6cfcdd20ce42a1b8872481001babfcb7585ba63854e66b5d0a5893"],
      ["irFnctorConstructorFuncRef", "76f42ca8b158f44e0630e4f6f6a0e2f5a9e29e8502cdbc07225d927f7c49c2dc"],
      ["keyPart", "0edb61a4674bb7690cd1b9c3f12a49d59c236f0e52ad6b4564941c2ab2f3ca69"],
      ["irCallableBindingKey", "a6b789ed9131223f969fdfa5848eb6d47de06bd17abbd9d485d41019c964ce0f"],
      ["sameIrCallableBinding", "9805db1b1fd4089e71d091f1539d103056b8d28cee972a72752b1232a11e1393"],
    ],
  },
  {
    oldPath: "src/ir/effects.ts",
    path: "src/ir/analysis/effects.ts",
    rows: [
      ["IrEffects", "78ce9aace2ac6cfb5f1c47ffa5da65ab9076a628a3e37ab65cdaf33605476af6"],
      ["effectsOf", "22e85c1cdc712c8385833a063d55ec991353d2d1d05ad675708ba0051808ea43"],
      ["effectsArePure", "7a72d88b8fd3eb93d7be5959c5963ed83699566eeebaecc4cca2b31d1bbf5a62"],
      ["effectsConflict", "bcbfdc351d541bfa5733197fa9d610e06ad96462a47a67ceab20ccc73365a50d"],
      ["EmissionScheduleViolation", "88149696bc4006fd42ca7fbd02c9372384108573a967830722b5444d27056bfa"],
      ["verifyEmissionSchedule", "f03865e896100cd12fbaf6e7118b47cba8c988c771f2a6014262e39ebdcf980a"],
      ["isSideEffecting", "668bfd625566b625357bc478188c135642fabc1146803a8968c7816e60d5d1a5"],
    ],
  },
  {
    oldPath: "src/ir/intrinsics.ts",
    path: "src/ir/core/intrinsics.ts",
    rows: [
      ["F64_TYPE", "ce3e24322256b699e17e890f485445521074f86498d4bde13d671e584408ee3b"],
      ["I32_TYPE", "7635fb272046cae2796b037acef1db11bb317fc3acb501061eeddff932a6949a"],
      ["U32_TYPE", "d656b0eb6dd225e31c09f5f457cd7eb5d9f387d3a6aa28dcda09d9f7877f459a"],
      ["EXTERNREF_TYPE", "3efb5d99f06ea6ecb3d5197fbc872d90b748361b00fd6a980a175eb7999ba630"],
      ["F64_TO_EXTERNREF_INTRINSIC_SIGNATURE", "f2475943320678df8dad0aaa020bdaba7c70d77b4b99d25b3cf12ab47115b5d0"],
      ["EXTERNREF_TO_F64_INTRINSIC_SIGNATURE", "a54aae6ae02bd4309599b39c6f54423240f07d0621c1619428e01aa13e068815"],
      ["I32_TO_EXTERNREF_INTRINSIC_SIGNATURE", "13da6f7fb63f22146b652102f7307f61d9ea0bb587444fd0ffd1a277ee826d2f"],
      ["EXTERNREF_TO_I32_INTRINSIC_SIGNATURE", "67ec09e88f0c9d0f0d25509bf9951de71d7293ad439ca7dd8027cc45d5e20111"],
      ["EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE", "77f4a180e90c11346a16d0848c36736dc43f1df28e4f325c2a418de3eecb1a7f"],
      ["REF_EXTERN_TYPE", "2b452e92e914ce4f191a5787cc23908e3692d7955d9c63d2a6ea70ed1b0f17f5"],
      [
        "EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE",
        "9b99c6fc9918b5feabf0c75b5f48039061f33d83cdcea52e67fbf12cd9d7b628",
      ],
      ["EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE", "6be4c9f9a390fbc6a07ff04e266566b971ddc7436e3266a2d6a92c377f55571b"],
      ["EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE", "3a8c31a7e8aaa9f797654361755323a74090a04975834b64a5bd96f24afc6ad8"],
      ["F64_TO_U32_INTRINSIC_SIGNATURE", "5bc75e63b2aeffbe0596774957f423b6072741369dd380dd0f081c8323de6550"],
      ["F64_UNARY_INTRINSIC_SIGNATURE", "2278eac98202de2cde52deaa38b9f095763bad65b3e4a297796d1c080bff85f6"],
      ["F64_BINARY_INTRINSIC_SIGNATURE", "777c8d438afefd9ad0203debe8cc0d7a71933c30f2a88d567c9ddbe438bd6015"],
      ["definition", "2b3c98f0e94a012ee1f93c052117ad78d3c3bdba29e3ce90ede1eb4f561f8e09"],
      ["INTRINSIC_DEFINITIONS", "7f139bfe9f6a3b56f9bea3cf7df0e5fc4f2bcba32a7b9964f0e52f4a449cf8b9"],
      ["INTRINSIC_ID_SET", "690313663dd754be6b5cbc0b686d966754fc23603c3407f4afedba338c20c7b9"],
      ["isIntrinsicId", "42521a6996c08d57bba1a1fdd21aad6c221785e743cccb7707d2b45903d28af7"],
    ],
  },
  {
    oldPath: "src/ir/intrinsics.ts",
    path: "src/ir/analysis/intrinsics.ts",
    rows: [
      ["IntrinsicEffectEvidence", "f1c8a4e5a16e47aa7ed9bf29f02d99bdfdaa4cf2ebe4cf51409e5d0aed07db7a"],
      ["intrinsicEffectEvidence", "76860e587590c5d1560184d1c3ba0911cbf2133b97cf6d5e4299813a041c7fdf"],
      ["signatureMismatch", "0e58749590b4dbfa116ddeba00d65903f852d0c2040a66b81cd3cefcc5ca87d6"],
      ["verifyIntrinsicUse", "cc24bee9394079363a79fa561ddcd9f383cffedac47ea74226364865186f7da4"],
    ],
  },
  {
    oldPath: "src/ir/runtime/contracts/intrinsics.ts",
    path: "src/ir/core/intrinsic-contracts.ts",
    rows: [
      ["IntrinsicSignature", "df9a091c5fb4ff64f57f2df9be63ca61a9f29d3ac128bfbfed1329f9b6300ef1"],
      ["IntrinsicSourceLocation", "625c8f4e4f35106576634634240acc4b37243fbfb5a270a1f46f96e835cbc40a"],
      ["IntrinsicUse", "db1618c763eb2946dbb7093447fb1451247e00b8eee53a5abecf0fb05f70ca3c"],
      ["IntrinsicDefinition", "64ba276dfdb3fc156613d8436dea37bec209f32c76a6e9201c9b48a75de90537"],
      ["IntrinsicVerificationCode", "c7a968d62f14a6888e5d116f8044c327b292aa7eb10379d1f9daa4587c78b3b7"],
      ["IntrinsicVerificationFailure", "d1affcd0cdcad04b9985da9d58910936aef07e78f960b3447958d449738d939e"],
    ],
  },
  {
    oldPath: "src/ir/async-plan.ts",
    path: "src/ir/analysis/async-plan.ts",
    rows: [
      ["asAsyncStateId", "2a65dcfd517c8c4d7379ec366f854e274d0224c3d3ee5d4026c3fe832dbe168a"],
      ["asAsyncHandlerId", "4780f8f19dd3f40702f66b653221576a4a7677beb2801375e36be155e05e9013"],
      ["canonicalPromiseAbi", "ca70675fe2a70907501e3c3995d5d7ce1599d9e3edf367abb360396acfa95c52"],
      ["IrAsyncPlanInvariantCode", "a04e2bc3e4d17e3684c4a5a9a169485d6f073a54a9569eb2d798176baa175bf8"],
      ["IrAsyncPlanVerifyError", "3dca1ff525bf8ac3ac8b93f1be013215348e5ead23e55f7310975f5ae769e83d"],
      ["IrAsyncPlanInvariantError", "cf5032ffd7e57bcf112f4c6e904b160f8b4e16946923bd9fd7009ef6316b7b76"],
      ["StateLiveness", "e970365599e489c1b452bd3b855782192036e3abe9257e30910ddd9c26b30950"],
      ["StateEdge", "62cfb57d858a3efd0684dad6598a5abb2b97c82cb551afcfdd74141e1af50a0d"],
      ["runtimeIntentOrder", "c3c6436571b5a32871ad05f564996f11c26d8920d4e1d0479e9d05d0b27f55b1"],
      ["runtimeIntentRank", "355f4b4b92be9ec7d3df6226896d3212a78a729b7bbaa522548fb3c5b5636e17"],
      ["isNonNegativeSafeInteger", "52166de0004153f23547bbed0a2a2bfcecab56c03504746e3342a1d193c6b9c1"],
      ["compareNumber", "b012a9a864ddb0068bdedc1af38b6141e8eac053e4fbfaef8714ac09ab741993"],
      ["sameValueSet", "e09249017f439d61346d1e714bd32232fe8049c21ce6e1fa7034d0f316ac3492"],
      ["describeValues", "ccbe5d3209a2cdc0d893696bd8343c133bf02a5eae6a07275c78fe5b418ced17"],
      ["terminatorUses", "f5ea3d22e25d4bca40f7d70bca11de414040c4d2f388690c54f8a7c37b3ee6f9"],
      ["stateUpdates", "66fcf32eb96223c31f83c367cd93d809a3832da279bdf9f3631a5b51d017bfe3"],
      ["updateMap", "21b1ae475ef1fe3dfe378538fe689c65548fa4caefa60c3119594c57ed65f139"],
      ["stateEdges", "bf6a341d2458689c276346fb275dec69624e73040fa6347ecda79421e70ee4c2"],
      ["stateLiveness", "734ff58105bb365d4079ac9a7f61ce9dfd2144759fa90f2c21e49bd4a336ee01"],
      ["addPurityError", "9830450469d1c4f2ba905e3f7723267c028aafd54903029cebb58453e38e5264"],
      ["verifyPureData", "24657afa62e66c877c20a94ede1074c419f52a649549de4f1c9eec636e1441e3"],
      ["addError", "11bd6244f372128b43c779ec047ecd7ad5edc985dfa9823fb6c626fa253d8fd4"],
      ["AsyncValueChecker", "50eb7a97249542654c7921b00c3719e5ecda65e6b2da1e0482d9e85fb0b7eafb"],
      ["verifyResumeIncomingEdges", "80ab2abea22f92dc90f46f846eeb52ae93fc98a9dee237778e02e2d29f30e628"],
      ["verifySpillUpdates", "067f6e59fab4cd6b9e0e28bffab18d2ba235666184336f0b6ad10cf8b897838c"],
      ["verifyCanonicalPromiseAbi", "145a421f1fea3846ff2f6c81d13509964ea1a47b0ec31434ab6db74f9636efbe"],
      ["irAsyncPlanNeedsNumberBridge", "489d99d6e27541a102eb164c49873a9cf327bd37f86786d74d27afe2d2d4d816"],
      ["requiredRuntimeIntents", "a0b8c0eb0e818be302856c9904f6f1f88f6952310b90d752e72119cf6c378181"],
      ["verifyIrAsyncPlan", "a3907118034d83d9fb106e5a028a79f7a42063ec958ab6fbe7ec009dd3cafcb5"],
      ["assertIrAsyncPlan", "be53618f5066ae5c3cc36b5ab547b5df8cc2e6583c8781fae5af3894848e6e63"],
      ["clonePlanData", "d08ead3ff2c2052ad568ce8d390a8d0eaf7552408b4a414773fa5040361464a4"],
      ["canonicalPlanInput", "39613fb4ab761267c4fb2395bf7f7d792e8181e154f3af93e3fdba87e57dd485"],
      ["createIrAsyncPlan", "b49ca5bc5edcbc7127b32355e053210a5b7cf2c97ef082f803d6f2af608aaedc"],
      ["canonicalJson", "a8374cd47cf9a04ae8234e84583a34c2e97cc5f4251883a205427c80e60db9c1"],
      ["serializeIrAsyncPlan", "27c209c280c6da58305db1f9dcd775d119476b9e973094cb06faacd328d36e81"],
      ["hashIrAsyncPlan", "97451ab26aa5877ddd691b7e56778c428e26bb484a593dd30012125bcef1f705"],
    ],
  },
  {
    oldPath: "src/ir/async-runtime-providers.ts",
    path: "src/ir/core/async-intents.ts",
    rows: [
      ["ASYNC_RUNTIME_FEATURE_SET", "2a66ecd015b8b1ac7aa7021dbcebf6df94a75b7a78b757abd07316767ccbda62"],
      ["isAsyncRuntimeFeature", "fd6d10ff2c701b74543554589655e8e836569d24be4829808a768a06e2da6185"],
    ],
  },
] as const;

function parse(path: string, text = read(path)) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  expect((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics).toEqual([]);
  return file;
}

function declarationName(node: ts.Statement): string | undefined {
  if (ts.isVariableStatement(node)) return node.declarationList.declarations[0]?.name.getText();
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node)
  )
    return node.name?.text;
  return undefined;
}

function preservedText(path: string, node: ts.Statement): string {
  const name = declarationName(node);
  const text = node.getFullText().trim();
  // Only the three type specializations approved in the published plan.
  // Bodies, initializers, member text, documentation and declaration order
  // are not printed/reformatted/normalized.
  if (path === "src/ir/core/intrinsic-contracts.ts" && name === "IntrinsicDefinition") {
    expect(text).toContain("IntrinsicDefinition<Feature extends string>");
    expect(text).toContain("readonly feature: Feature;");
    return text
      .replace("IntrinsicDefinition<Feature extends string>", "IntrinsicDefinition")
      .replace("readonly feature: Feature;", "readonly feature: RuntimeFeature;");
  }
  if (path === "src/ir/core/intrinsics.ts" && name === "definition") {
    expect(ts.isFunctionDeclaration(node)).toBe(true);
    const fn = node as ts.FunctionDeclaration;
    expect(fn.parameters.map((parameter) => parameter.getText())).toEqual([
      "id: IntrinsicId",
      "signature: IntrinsicSignature",
      "feature: IntrinsicId = id",
    ]);
    expect(fn.type?.getText()).toBe("IntrinsicDefinition<IntrinsicId>");
    return (
      "function definition(id: IntrinsicId, signature: IntrinsicSignature, feature: RuntimeFeature = id): IntrinsicDefinition " +
      fn.body!.getText()
    );
  }
  if (path === "src/ir/core/intrinsics.ts" && name === "INTRINSIC_DEFINITIONS") {
    expect(text).toContain("Readonly<Record<IntrinsicId, IntrinsicDefinition<IntrinsicId>>>");
    return text.replace("IntrinsicDefinition<IntrinsicId>", "IntrinsicDefinition");
  }
  return text;
}

function verifyReceipt(receipt: (typeof receipts)[number], text = read(receipt.path)) {
  const file = parse(receipt.path, text);
  const declarations = file.statements.filter((node) => declarationName(node) !== undefined);
  const selectedNames = receipt.rows.map(([name]) => name);
  const additions =
    receipt.path === "src/ir/analysis/intrinsics.ts"
      ? ["verifyIrIntrinsicSignature"]
      : receipt.path === "src/ir/core/async-intents.ts"
        ? ["ASYNC_RUNTIME_FEATURES", "ASYNC_OPTIONAL_RUNTIME_FEATURES", "AsyncRuntimeFeature"]
        : [];
  expect(declarations.map(declarationName)).toEqual(
    receipt.path === "src/ir/core/async-intents.ts"
      ? [...additions, ...selectedNames]
      : [...selectedNames, ...additions],
  );
  for (const [name, expected] of receipt.rows) {
    const matches = declarations.filter((node) => declarationName(node) === name);
    expect(matches, name).toHaveLength(1);
    expect(sha(preservedText(receipt.path, matches[0]!)), name).toBe(expected);
  }
}

const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });
const EXTERN: IrType = irVal({ kind: "externref" });
const identity = createTestIrFunctionIdentityFactory("semantic-verification-ownership");
const owner = identity.unit(0);
const v = asValueId;
const s = asyncPlan.asAsyncStateId;
const h = asyncPlan.asAsyncHandlerId;

/** Nonempty semantic fixture: one suspension, a live spill and a catch edge.
 * It is not a source-produced compiler-execution witness. */
function plan(): IrAsyncPlan {
  return {
    schemaVersion: 1,
    ownerUnitId: owner,
    kind: "async-function",
    abi: asyncPlan.canonicalPromiseAbi(F64),
    entry: s(0),
    params: [
      { value: v(0), type: EXTERN },
      { value: v(1), type: F64 },
    ],
    values: [
      { value: v(0), type: EXTERN },
      { value: v(1), type: F64 },
      { value: v(2), type: F64 },
      { value: v(3), type: F64 },
      { value: v(4), type: EXTERN },
    ],
    spills: [{ value: v(1), type: F64, storage: "slot" }],
    states: [
      {
        id: s(0),
        body: [],
        terminator: {
          kind: "suspend",
          awaited: v(0),
          resume: { state: s(1), value: v(2) },
          rejected: { kind: "handler", handler: h(0) },
          live: [v(1)],
        },
      },
      {
        id: s(1),
        resume: { value: v(2), type: F64, source: "fulfilled" },
        body: [{ kind: "binary", op: "f64.add", lhs: v(1), rhs: v(2), result: v(3), resultType: F64 }],
        terminator: { kind: "resolve", value: v(3) },
      },
      {
        id: s(2),
        resume: { value: v(4), type: EXTERN, source: "rejected" },
        body: [],
        terminator: { kind: "reject", reason: v(4) },
      },
    ],
    handlers: [{ id: h(0), kind: "catch", entry: s(2), parent: null }],
    runtimeIntents: [...intents.ASYNC_RUNTIME_FEATURES, "promise.number.bridge"],
  };
}

function instruction(): IrInstrIntrinsic {
  return { kind: "intrinsic", id: "math.pow", version: 1, args: [v(0), v(1)], result: v(2), resultType: F64 };
}

function use(): IntrinsicUse {
  return {
    id: "math.pow",
    version: 1,
    argumentTypes: [F64, F64],
    resultType: F64,
    location: { file: "semantic-fixture.js", line: 2, column: 3 },
  };
}

describe("semantic implementation preservation", () => {
  it.each(receipts)("preserves every selected $oldPath declaration in $path", (receipt) => verifyReceipt(receipt));

  it("keeps the fixed denominator and rejects deleted, duplicated and changed implementations", () => {
    expect(receipts.map((receipt) => receipt.rows.length)).toEqual([17, 7, 20, 4, 6, 36, 2]);
    expect(receipts.reduce((sum, receipt) => sum + receipt.rows.length, 0)).toBe(92);
    const receipt = receipts.find((item) => item.path === "src/ir/analysis/intrinsics.ts")!;
    const source = read(receipt.path);
    const file = parse(receipt.path);
    const evidence = file.statements.find((node) => declarationName(node) === "IntrinsicEffectEvidence")!;
    expect(() => verifyReceipt(receipt, source.slice(0, evidence.pos) + source.slice(evidence.end))).toThrow();
    expect(() => verifyReceipt(receipt, source + "\n" + evidence.getFullText())).toThrow();
    expect(source).toContain("return this.#pure;");
    expect(() => verifyReceipt(receipt, source.replace("return this.#pure;", "return true;"))).toThrow();
    expect(source).toContain("Object.freeze(this);");
    expect(() => verifyReceipt(receipt, source.replace("Object.freeze(this);", ""))).toThrow();
  });

  it("retains every evidence member and the async error parameter-property constructor", () => {
    const evidence = parse("src/ir/analysis/intrinsics.ts").statements.find(ts.isClassDeclaration)!;
    expect(evidence.members.map((member) => [ts.SyntaxKind[member.kind], member.name?.getText()])).toEqual([
      ["PropertyDeclaration", "#pure"],
      ["Constructor", undefined],
      ["MethodDeclaration", "fromInstruction"],
      ["MethodDeclaration", "isPure"],
    ]);
    expect(evidence.members.filter(ts.isPropertyDeclaration).map((member) => member.initializer)).toEqual([undefined]);
    const error = parse("src/ir/analysis/async-plan.ts").statements.find(ts.isClassDeclaration)!;
    expect(error.members).toHaveLength(1);
    const constructorDecl = error.members[0] as ts.ConstructorDeclaration;
    expect(constructorDecl.parameters.map((parameter) => parameter.getText())).toEqual([
      "readonly errors: readonly IrAsyncPlanVerifyError[]",
    ]);
  });

  it("pins the exact extracted signature prefix, not an empty success adapter", () => {
    const file = parse("src/ir/analysis/intrinsics.ts");
    const fn = file.statements.find(
      (node) => declarationName(node) === "verifyIrIntrinsicSignature",
    ) as ts.FunctionDeclaration;
    const prefix = fn
      .body!.statements.slice(0, -1)
      .map((node) => node.getFullText())
      .join("");
    expect(sha(prefix)).toBe("d93a5baaee36c5c5be52864d1e5c2499f2922f54de44af7b5e78e1943a2ede74");
    expect(fn.body!.statements.at(-1)?.getText()).toBe("return errors;");
  });
});

describe("canonical export identities and complete catalogs", () => {
  it.each(Object.keys(bindings) as (keyof typeof bindings)[])("forwards callable %s without a wrapper", (name) => {
    expect(oldBindings[name]).toBe(bindings[name]);
  });
  it("keeps the callable export denominator, provenance and compatibility names", () => {
    expect(Object.keys(bindings)).toHaveLength(12);
    expect(Object.keys(oldBindings).sort()).toEqual(Object.keys(bindings).sort());
    const left = bindings.irUnitFuncRef({ unitId: owner, name: "left" });
    const right = bindings.irUnitFuncRef({ unitId: owner, name: "right" });
    expect(bindings.sameIrCallableBinding(left.binding, right.binding)).toBe(true);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.binding)).toBe(true);
    const plain = bindings.irImportFuncRef("env", "f");
    const capability = bindings.irCapabilityImportFuncRef("env", "f", "cap", "provider");
    expect(bindings.sameIrCallableBinding(plain.binding, capability.binding)).toBe(false);
    expect(() => bindings.irImportFuncRef("", "f")).toThrow("import module must be a non-empty string");
    expect(() =>
      Reflect.apply(bindings.irCallableBindingKey, undefined, [
        { kind: "import", module: "env", field: "f", capabilityId: "cap" },
      ]),
    ).toThrow("callable import capability and provider provenance must be paired");
  });
  it("forwards all five effect functions and every intrinsic signature/catalog object", () => {
    expect(Object.keys(effects)).toHaveLength(5);
    for (const name of Object.keys(effects) as (keyof typeof effects)[]) expect(oldEffects[name]).toBe(effects[name]);
    for (const name of Object.keys(catalog) as (keyof typeof catalog)[])
      expect(oldIntrinsics[name]).toBe(catalog[name]);
    expect(oldIntrinsics.IntrinsicEffectEvidence).toBe(intrinsic.IntrinsicEffectEvidence);
    expect(oldIntrinsics.intrinsicEffectEvidence).toBe(intrinsic.intrinsicEffectEvidence);
    expect(oldIntrinsics.verifyIntrinsicUse).toBe(intrinsic.verifyIntrinsicUse);
    expect(Object.keys(catalog.INTRINSIC_DEFINITIONS)).toEqual(catalog.INTRINSIC_IDS);
    expect(catalog.INTRINSIC_IDS).toHaveLength(38);
    expect(Object.isFrozen(catalog.INTRINSIC_DEFINITIONS)).toBe(true);
    for (const [id, row] of Object.entries(catalog.INTRINSIC_DEFINITIONS)) {
      expect(row.feature).toBe(id);
      expect(Object.isFrozen(row)).toBe(true);
      expect(Object.isFrozen(row.signature)).toBe(true);
      expect(Object.isFrozen(row.signature.params)).toBe(true);
      expect(oldIntrinsics.INTRINSIC_DEFINITIONS[row.id]).toBe(row);
    }
    expect(INTRINSIC_RUNTIME_FEATURES).toContain("math.reduce-trig");
    expect(catalog.isIntrinsicId("math.reduce-trig")).toBe(false);
  });
  it("forwards semantic async exports through B's composed historical facade", () => {
    const names = [
      "asAsyncStateId",
      "asAsyncHandlerId",
      "canonicalPromiseAbi",
      "IrAsyncPlanInvariantError",
      "irAsyncPlanNeedsNumberBridge",
      "verifyIrAsyncPlan",
      "assertIrAsyncPlan",
      "createIrAsyncPlan",
      "serializeIrAsyncPlan",
      "hashIrAsyncPlan",
    ] as const;
    expect(Object.keys(asyncPlan).sort()).toEqual([...names].sort());
    for (const name of names) expect(oldAsync[name], name).toBe(asyncPlan[name]);
    expect(oldAsyncProviders.isAsyncRuntimeFeature).toBe(intents.isAsyncRuntimeFeature);
    expect(oldAsyncProviders.ASYNC_RUNTIME_FEATURES).toBe(intents.ASYNC_RUNTIME_FEATURES);
    expect(oldAsyncProviders.ASYNC_OPTIONAL_RUNTIME_FEATURES).toBe(intents.ASYNC_OPTIONAL_RUNTIME_FEATURES);
    for (const feature of [...intents.ASYNC_RUNTIME_FEATURES, ...intents.ASYNC_OPTIONAL_RUNTIME_FEATURES])
      expect(intents.isAsyncRuntimeFeature(feature)).toBe(true);
    expect(intents.isAsyncRuntimeFeature("Promise_resolve")).toBe(false);
  });
});

describe("semantic diagnostics and shared effect authority", () => {
  it("preserves cache identity, conflict ordering and schedule violations", () => {
    const readSlot: IrInstr = { kind: "slot.read", slotIndex: 4, result: v(0), resultType: F64 };
    const writeSlot: IrInstr = { kind: "slot.write", slotIndex: 4, value: v(0), result: null, resultType: null };
    const cache = new Map();
    const readEffect = effects.effectsOf(readSlot, cache);
    expect(effects.effectsOf(readSlot, cache)).toBe(readEffect);
    expect(effects.effectsArePure(readEffect)).toBe(false);
    expect(effects.effectsConflict(readEffect, effects.effectsOf(writeSlot))).toBe(true);
    expect(effects.verifyEmissionSchedule([readSlot, writeSlot], [0, 1], [false, false], () => [])).toEqual([]);
    expect(effects.verifyEmissionSchedule([readSlot, writeSlot], [1, 0], [true, false], () => [])).toEqual([
      {
        defIndex: 0,
        pastIndex: 1,
        reason: "deferred slot.read@0 (emits at 1) crosses conflicting slot.write@1 (emits at 0)",
      },
    ]);
    expect(effects.isSideEffecting(writeSlot)).toBe(true);
  });
  it("accepts only pure evidence from the one private-field class", () => {
    const proof = intrinsic.intrinsicEffectEvidence(instruction());
    expect(proof).toBeInstanceOf(oldIntrinsics.IntrinsicEffectEvidence);
    expect(Object.isFrozen(proof)).toBe(true);
    expect(proof.isPure()).toBe(true);
    expect(intrinsic.verifyIntrinsicUse(use(), proof)).toBeUndefined();
    const impure = intrinsic.IntrinsicEffectEvidence.fromInstruction({
      kind: "slot.write",
      slotIndex: 0,
      value: v(0),
      result: null,
      resultType: null,
    });
    expect(impure.isPure()).toBe(false);
    const refusal = {
      code: "intrinsic-effect-mismatch",
      detail: "math.pow is certified pure but its IR effect authority reports observable effects",
    };
    expect(intrinsic.verifyIntrinsicUse(use(), impure)).toEqual(refusal);
    expect(Reflect.apply(intrinsic.verifyIntrinsicUse, undefined, [use(), { isPure: () => true }])).toEqual(refusal);
    expect(() => Reflect.apply(intrinsic.IntrinsicEffectEvidence.prototype.isPure, {}, [])).toThrow(TypeError);
  });
  it("keeps first-failure ordering for use identity, location, version, signature and effects", () => {
    const proof = intrinsic.intrinsicEffectEvidence(instruction());
    expect(intrinsic.verifyIntrinsicUse(Object.assign(use(), { id: "unknown" }), proof)).toEqual({
      code: "unknown-intrinsic",
      detail: "unknown intrinsic unknown",
    });
    expect(
      intrinsic.verifyIntrinsicUse(
        Object.assign(use(), { location: { file: "", line: 0, column: -1 }, version: 2 }),
        proof,
      ),
    ).toEqual({ code: "invalid-intrinsic-location", detail: "math.pow has an invalid source location" });
    expect(intrinsic.verifyIntrinsicUse(Object.assign(use(), { version: 2, argumentTypes: [] }), proof)).toEqual({
      code: "intrinsic-version-mismatch",
      detail: "math.pow uses signature v2; expected v1",
    });
    expect(intrinsic.verifyIntrinsicUse({ ...use(), argumentTypes: [] }, proof)).toEqual({
      code: "intrinsic-signature-mismatch",
      detail: "math.pow expects 2 argument(s), received 0",
    });
  });
  it("preserves signature diagnostic order and appends provider diagnostics afterward", () => {
    const bad = Object.assign(instruction(), {
      version: 2,
      args: [v(0), v(1), v(3)],
      resultType: I32,
      provider: { kind: "callable" as const, target: bindings.irRuntimeFuncRef("foreign") },
    });
    const types = new Map([
      [v(0), I32],
      [v(1), F64],
    ]);
    const semantic = [
      "math.pow uses signature v2; expected v1",
      "math.pow expects 2 argument(s), got 3",
      "math.pow argument 0 does not match its v2 signature",
      "math.pow result does not match its v2 signature",
    ];
    expect(intrinsic.verifyIrIntrinsicSignature(bad, types)).toEqual(semantic);
    expect(verifyIrIntrinsicInstruction(bad, types)).toEqual([
      ...semantic,
      "math.pow callable provider target runtime:foreign is not an admitted physical provider",
    ]);
    expect(intrinsic.verifyIrIntrinsicSignature(instruction(), new Map())).toEqual([]); // Existing absent-type handling.
    expect(() => intrinsic.verifyIrIntrinsicSignature(Object.assign(instruction(), { id: "unknown" }), types)).toThrow(
      TypeError,
    ); // Preserve malformed-ID failure rather than inventing a diagnostic.
  });
});

describe("nonempty async plan preservation", () => {
  it("preserves suspension/spill/handler data, canonical ordering, deep freeze and exact old serialization/hash", () => {
    const input = plan();
    expect(input.states).toHaveLength(3);
    expect(input.spills).toHaveLength(1);
    expect(input.handlers).toHaveLength(1);
    expect(input.states.flatMap((state) => state.body)).toHaveLength(1);
    expect(asyncPlan.verifyIrAsyncPlan(input)).toEqual([]);
    expect(asyncPlan.irAsyncPlanNeedsNumberBridge(input)).toBe(true);
    const reversed = {
      ...input,
      values: [...input.values].reverse(),
      states: [...input.states].reverse(),
      runtimeIntents: [...input.runtimeIntents].reverse(),
    };
    const canonical = asyncPlan.createIrAsyncPlan(reversed);
    expect(canonical).not.toBe(input);
    expect(Object.getPrototypeOf(canonical)).toBeNull();
    expect(Object.isFrozen(canonical.states[1]!.body[0])).toBe(true);
    expect(canonical.states.map((state) => state.id)).toEqual([0, 1, 2]);
    expect(asyncPlan.serializeIrAsyncPlan(reversed)).toBe(oldAsync.serializeIrAsyncPlan(input));
    expect(asyncPlan.hashIrAsyncPlan(reversed)).toBe(oldAsync.hashIrAsyncPlan(input));
    expect(asyncPlan.hashIrAsyncPlan(reversed)).toMatch(/^ir-async-plan:v1:[0-9a-f]{16}$/);
    expect(asyncPlan.serializeIrAsyncPlan(canonical)).toBe(asyncPlan.serializeIrAsyncPlan(input));
    expect(asyncPlan.hashIrAsyncPlan({ ...input, ownerUnitId: identity.unit(1) })).not.toBe(
      asyncPlan.hashIrAsyncPlan(input),
    );
  });
  it("retains exact missing-spill and liveness diagnostics", () => {
    const missing = { ...plan(), spills: [] };
    expect(asyncPlan.verifyIrAsyncPlan(missing)).toEqual([
      { code: "missing-spill", message: "live value 1 has no frame spill" },
    ]);
    expect(asyncPlan.verifyIrAsyncPlan(missing)).toEqual(oldAsync.verifyIrAsyncPlan(missing));
    const input = plan();
    const first = input.states[0]!;
    if (first.terminator.kind !== "suspend") throw new Error("fixture lost suspension");
    const wrong = {
      ...input,
      states: [{ ...first, terminator: { ...first.terminator, live: [] } }, ...input.states.slice(1)],
    };
    expect(asyncPlan.verifyIrAsyncPlan(wrong)).toEqual([
      { code: "liveness-mismatch", message: "state 0 live set [] must equal [1]", state: s(0) },
    ]);
    expect(asyncPlan.verifyIrAsyncPlan(wrong)).toEqual(oldAsync.verifyIrAsyncPlan(wrong));
  });
  it("retains complete missing-intent diagnostic ordering and invariant error contents", () => {
    const input = { ...plan(), runtimeIntents: [] };
    const required = [
      "promise.capability.create",
      "promise.resolve",
      "promise.react",
      "scheduler.enqueue",
      "scheduler.drain",
      "promise.settle.fulfill",
      "promise.settle.reject",
    ];
    const errors = required.map((intent) => ({
      code: "missing-runtime-intent",
      message: "runtime intent " + intent + " is required",
    }));
    expect(asyncPlan.verifyIrAsyncPlan(input)).toEqual(errors);
    expect(asyncPlan.verifyIrAsyncPlan(input)).toEqual(oldAsync.verifyIrAsyncPlan(input));
    let caught: unknown;
    try {
      asyncPlan.assertIrAsyncPlan(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(asyncPlan.IrAsyncPlanInvariantError);
    expect(caught).toBeInstanceOf(oldAsync.IrAsyncPlanInvariantError);
    if (!(caught instanceof asyncPlan.IrAsyncPlanInvariantError)) throw new Error("expected invariant");
    expect(caught.errors).toEqual(errors);
    expect(caught.message).toBe(errors.map((error) => error.code + ": " + error.message).join("\n"));
    expect(caught.name).toBe("IrAsyncPlanInvariantError");
    expect(Object.isFrozen(caught.errors)).toBe(true);
  });
  it("does not admit source-node fields or undefined metadata", () => {
    const input = Object.assign(plan(), { sourceNode: undefined });
    const expected = [
      {
        code: "forbidden-data",
        path: "$plan.sourceNode",
        message: "property sourceNode crosses the async-plan boundary",
      },
      { code: "forbidden-data", path: "$plan.sourceNode", message: "contains non-data value undefined" },
    ];
    expect(asyncPlan.verifyIrAsyncPlan(input)).toEqual(expected);
    expect(asyncPlan.verifyIrAsyncPlan(input)).toEqual(oldAsync.verifyIrAsyncPlan(input));
    expect(() => asyncPlan.createIrAsyncPlan(input)).toThrow(asyncPlan.IrAsyncPlanInvariantError);
  });
});

// Await a real checker child so TypeScript cannot block Vitest's RPC loop.
// Compile the complete imported canonical/compatibility closure of these
// virtual roots with the repository's options. This is not whole-project
// typecheck; no diagnostic from any imported module is discarded.
const compilerChild = [
  'const ts = require("typescript");',
  'const { resolve } = require("node:path");',
  'let input = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", chunk => { input += chunk; });',
  'process.stdin.on("end", () => {',
  "  try {",
  "    const { root, entries } = JSON.parse(input);",
  '    if (resolve(process.cwd()) !== root) throw new Error("foreign compiler root");',
  '    const configPath = resolve(root, "tsconfig.json");',
  "    const config = ts.readConfigFile(configPath, ts.sys.readFile);",
  "    const parsed = ts.parseJsonConfigFileContent(config.config ?? {}, ts.sys, root, undefined, configPath);",
  "    const sources = new Map(entries);",
  "    const options = { ...parsed.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined, rootDir: root };",
  "    const host = ts.createCompilerHost(options);",
  "    const originalGet = host.getSourceFile.bind(host);",
  "    host.getSourceFile = (path, version, onError, fresh) => sources.has(path)",
  "      ? ts.createSourceFile(path, sources.get(path), version, true) : originalGet(path, version, onError, fresh);",
  "    const program = ts.createProgram({ rootNames: [...sources.keys()], options, host });",
  "    const diagnostics = [...(config.error ? [config.error] : []), ...parsed.errors, ...ts.getPreEmitDiagnostics(program)];",
  "    process.stdout.write(JSON.stringify({",
  "      fixtureTexts: [...sources.keys()].map(path => [path, program.getSourceFile(path)?.text]),",
  "      loadedFiles: program.getSourceFiles().map(file => file.fileName),",
  "      diagnostics: diagnostics.map(d => ({ code: d.code, file: d.file?.fileName,",
  "        line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null,",
  '        message: ts.flattenDiagnosticMessageText(d.messageText, "\\n") })),',
  "    }));",
  "  } catch (error) { process.stderr.write(error.stack ?? String(error)); process.exitCode = 1; }",
  "});",
].join("\n");

interface Compilation {
  fixtureTexts: readonly (readonly [string, string])[];
  loadedFiles: readonly string[];
  diagnostics: readonly { code: number; file?: string; line: number | null; message: string }[];
}

async function compileCompatibility(entries: readonly (readonly [string, string])[]): Promise<Compilation> {
  return await new Promise((resolveCompilation, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=2048", "--input-type=commonjs", "-e", compilerChild], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let error: Error | undefined;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (failure) => {
      error = failure;
    });
    child.stdin.on("error", (failure) => {
      error ??= failure;
    });
    child.on("close", (code, signal) => {
      if (error || code !== 0 || signal !== null || stderr.length > 0) {
        reject(
          new Error("type fixture child failed: " + JSON.stringify({ code, signal, error: error?.message, stderr })),
        );
        return;
      }
      try {
        resolveCompilation(JSON.parse(stdout) as Compilation);
      } catch (failure) {
        reject(new Error("invalid type fixture report: " + String(failure) + "\n" + stdout));
      }
    });
    child.stdin.end(JSON.stringify({ root, entries }));
  });
}

it("actually compiles legacy/core types, wider runtime features and located negative controls", async () => {
  const imports =
    [
      'import * as Core from "../src/ir/core/intrinsic-contracts.js";',
      'import * as Runtime from "../src/ir/runtime/contracts/intrinsics.js";',
      'import * as Legacy from "../src/ir/intrinsics.js";',
      'import * as Catalog from "../src/ir/core/intrinsics.js";',
      'import * as Intrinsic from "../src/ir/analysis/intrinsics.js";',
      'import * as Effects from "../src/ir/analysis/effects.js";',
      'import * as OldEffects from "../src/ir/effects.js";',
      'import * as Bindings from "../src/ir/core/callable-bindings.js";',
      'import * as OldBindings from "../src/ir/callable-bindings.js";',
    ].join("\n") + "\n";
  const pairs = [
    "IntrinsicSignature",
    "IntrinsicSourceLocation",
    "IntrinsicUse",
    "IntrinsicVerificationCode",
    "IntrinsicVerificationFailure",
  ].flatMap((name) => [
    ["Core." + name, "Runtime." + name],
    ["Core." + name, "Legacy." + name],
  ]);
  pairs.push(
    ["Runtime.IntrinsicDefinition", "Core.IntrinsicDefinition<Runtime.RuntimeFeature>"],
    ["Legacy.IntrinsicDefinition", "Runtime.IntrinsicDefinition"],
    ["OldEffects.IrEffects", "Effects.IrEffects"],
    ["OldEffects.EmissionScheduleViolation", "Effects.EmissionScheduleViolation"],
    ["typeof Legacy.IntrinsicEffectEvidence", "typeof Intrinsic.IntrinsicEffectEvidence"],
  );
  expect(pairs).toHaveLength(15);
  const equalities = pairs.map(
    ([left, right], index) => "const identity" + index + ": Equal<" + left + ", " + right + "> = true;",
  );
  const positive =
    imports +
    [
      "type Equal<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
      ...equalities,
      'const providerOnly: Runtime.IntrinsicDefinition = { id: "math.sin", signature: Catalog.F64_UNARY_INTRINSIC_SIGNATURE, feature: "math.reduce-trig" };',
      "const oldProviderOnly: Legacy.IntrinsicDefinition = providerOnly;",
      "const coreWide: Core.IntrinsicDefinition<Runtime.RuntimeFeature> = oldProviderOnly;",
      "const runtimeTable: Readonly<Record<Catalog.IntrinsicId, Runtime.IntrinsicDefinition>> = Catalog.INTRINSIC_DEFINITIONS;",
      "const oldTable: typeof Legacy.INTRINSIC_DEFINITIONS = runtimeTable;",
      "const bindingApi: typeof OldBindings = Bindings;",
      "const reverseBindingApi: typeof Bindings = OldBindings;",
      "const effectApi: typeof OldEffects = Effects;",
      "const reverseEffectApi: typeof Effects = OldEffects;",
      "const effectVerifier: typeof Legacy.verifyIntrinsicUse = Intrinsic.verifyIntrinsicUse;",
      "void [coreWide, oldTable, bindingApi, reverseBindingApi, effectApi, reverseEffectApi, effectVerifier];",
    ].join("\n");
  const negatives = [
    {
      name: "provider-only-is-not-an-intrinsic",
      code: 2322,
      body: 'const invalid: Catalog.IntrinsicId = "math.reduce-trig";',
    },
    {
      name: "feature-remains-required",
      code: 2741,
      body: 'const invalid: Runtime.IntrinsicDefinition = { id: "math.sin", signature: Catalog.F64_UNARY_INTRINSIC_SIGNATURE };',
    },
    {
      name: "runtime-vocabulary-is-closed",
      code: 2322,
      body: 'const invalid: Runtime.RuntimeFeature = "not-a-feature";',
    },
    {
      name: "feature-remains-readonly",
      code: 2540,
      body: 'declare const row: Runtime.IntrinsicDefinition; row.feature = "math.sin";',
    },
    { name: "generic-feature-is-a-string", code: 2344, body: "type Invalid = Core.IntrinsicDefinition<number>;" },
    {
      name: "evidence-constructor-remains-private",
      code: 2673,
      body: "const invalid = new Intrinsic.IntrinsicEffectEvidence();",
    },
    {
      name: "wide-runtime-row-cannot-narrow-to-core",
      code: 2322,
      body: "declare const row: Runtime.IntrinsicDefinition; const invalid: Core.IntrinsicDefinition<Catalog.IntrinsicId> = row;",
    },
    { name: "core-row-requires-feature-parameter", code: 2314, body: "type Invalid = Core.IntrinsicDefinition;" },
  ] as const;
  expect(negatives).toHaveLength(8);
  const positivePath = resolve(root, "tests/__semantic-types-positive.ts");
  const entries: [string, string][] = [
    [positivePath, positive],
    ...negatives.map((item): [string, string] => [
      resolve(root, "tests/__semantic-types-" + item.name + ".ts"),
      imports + item.body + "\n",
    ]),
  ];
  const report = await compileCompatibility(entries);
  expect(report.fixtureTexts).toEqual(entries);
  for (const path of [
    "src/ir/core/intrinsic-contracts.ts",
    "src/ir/core/intrinsics.ts",
    "src/ir/analysis/intrinsics.ts",
    "src/ir/analysis/effects.ts",
    "src/ir/core/callable-bindings.ts",
    "src/ir/runtime/contracts/intrinsics.ts",
    "src/ir/intrinsics.ts",
    "src/ir/effects.ts",
    "src/ir/callable-bindings.ts",
  ])
    expect(report.loadedFiles).toContain(resolve(root, path));
  // Assert the entire diagnostic vector, not just diagnostics matching probes.
  expect(report.diagnostics.map(({ code, file, line }) => ({ code, file, line }))).toEqual(
    negatives
      .map((item) => ({
        code: item.code,
        file: resolve(root, "tests/__semantic-types-" + item.name + ".ts"),
        line: imports.split("\n").length,
      }))
      .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0)),
  );
  expect(report.diagnostics.every((diagnostic) => diagnostic.message.length > 0)).toBe(true);
}, 120_000);
