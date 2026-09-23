// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as oldHost from "../src/ir/runtime-host-capabilities.js";
import * as host from "../src/ir/runtime/host-capabilities.js";
import * as oldProviders from "../src/ir/async-runtime-providers.js";
import * as providers from "../src/ir/runtime/async-providers.js";
import * as oldCallables from "../src/ir/runtime-callable-declarations.js";
import * as callables from "../src/ir/runtime/callable-declarations.js";
import * as oldManifest from "../src/ir/runtime-manifest.js";
import * as manifest from "../src/ir/runtime/manifest.js";
import * as oldPlan from "../src/ir/async-plan.js";
import * as semanticPlan from "../src/ir/analysis/async-plan.js";
import * as attachment from "../src/ir/runtime/async-attachment.js";
import { verifyIrIntrinsicInstruction as historicalVerify } from "../src/ir/intrinsic-support.js";
import { verifyIrIntrinsicInstruction } from "../src/ir/runtime/intrinsic-verification.js";
import { verifyIrIntrinsicSignature, intrinsicEffectEvidence } from "../src/ir/analysis/intrinsics.js";
import { INTRINSIC_DEFINITIONS } from "../src/ir/core/intrinsics.js";
import { ASYNC_RUNTIME_FEATURES, isAsyncRuntimeFeature } from "../src/ir/core/async-intents.js";
import { asValueId, type IrInstrIntrinsic, type IrInstr } from "../src/ir/core/nodes.js";
import { irVal, type IrType, type IrTypeRef } from "../src/ir/core/types.js";
import { irImportFuncRef, irIntrinsicFuncRef, irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import { createIrBindingId } from "../src/shared/contracts/identity-values.js";
import type { IntrinsicId } from "../src/ir/core/intrinsic-vocabulary.js";
import type { PreparedIrAsyncRuntime, PreparedIrAsyncRuntimeInput } from "../src/ir/runtime/contracts/prepared.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
import { currentDeclarations, historicalRuntimeDeclarations } from "./helpers/ir-historical-runtime-reconstruction.js";

const root = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const hash = (rows: unknown): string => createHash("sha256").update(JSON.stringify(rows)).digest("hex");

// Pinned from b4c116639a7e146e83611a988a8da28d77de9368. Tests do not need Git.
// These are original declaration ordinals, including overload declarations.
// A's canonical semantic files are mandatory in the composed checkpoint;
// absence is a failure, never a skip or a reason to manufacture a stub.
const receipts = [
  {
    name: "runtime-host-capabilities",
    names: [
      "RUNTIME_HOST_CAPABILITY_ID_SET",
      "RUNTIME_HOST_CAPABILITY_FUNC_ID_SET",
      "RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_ID_SET",
      "RUNTIME_HOST_CAPABILITY_GLOBAL_ID_SET",
      "RUNTIME_HOST_CAPABILITY_EXPORT_ID_SET",
      "isRuntimeHostCapabilityId",
      "isRuntimeHostCapabilityFuncId",
      "isRuntimeHostCapabilityFuncFamilyId",
      "isRuntimeHostCapabilityGlobalId",
      "isRuntimeHostCapabilityExportId",
      "RUNTIME_HOST_CAPABILITY_VALUE_TYPES",
      "RUNTIME_HOST_CAPABILITY_FUNC_MODULE_SET",
      "RUNTIME_HOST_CAPABILITY_GLOBAL_MODULE_SET",
      "RUNTIME_HOST_CAPABILITY_KIND_SET",
      "RUNTIME_HOST_CAPABILITY_FIELD_SCHEME_SET",
      "RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_FIELD_SCHEME_SET",
      "RUNTIME_HOST_CAPABILITY_EXPORT_PUBLICATION_SET",
      "RUNTIME_HOST_CAPABILITY_HOST_SELECTION_ENV_VAR_SET",
      "RUNTIME_HOST_CAPABILITY_HOST_SELECTION_SET",
      "RUNTIME_HOST_CAPABILITY_FUNC_FAMILY_MIN_ARITY",
      "RuntimeHostCapabilityFuncOptions",
      "funcRecord",
      "freezeHostSelection",
      "record",
      "funcFamilyRecord",
      "exportRecord",
      "globalRecord",
      "RUNTIME_HOST_CAPABILITY_RECORDS",
      "RECORD_BY_ID",
      "CANONICAL_RECORDS",
      "compareCapabilityRecords",
      "describeRecord",
      "assertExactKeys",
      "assertValueTypes",
      "assertRuntimeHostCapabilityRecord",
      "assertHostSelection",
      "assertExportCapabilityRecord",
      "assertFuncFamilyCapabilityRecord",
      "assertGlobalCapabilityRecord",
      "assertCanonicalRuntimeHostCapabilityRecord",
      "asCallableRuntimeHostCapabilityRecord",
      "canonicalizeRuntimeHostCapabilityCatalog",
      "resolveRuntimeHostCapabilityRecord",
      "resolveRuntimeHostCapabilityFuncFamilyRecord",
      "resolveRuntimeHostCapabilityGlobalRecord",
      "resolveRuntimeHostCapabilityExportRecord",
      "resolveRuntimeHostCapabilityFuncRecord",
      "HOST_CALLBACK_WRAP_CAPABILITY_RECORD",
    ],
    functions: 28,
    hash: "e08e835fd7f81bbcf22b2d8946ad08635b389aabee5033f1197ad0ec49936f2d",
    classes: [],
  },
  {
    name: "async-runtime-providers",
    names: [
      "ASYNC_RUNTIME_FEATURE_SET",
      "isAsyncRuntimeFeature",
      "ASYNC_HOST_CAPABILITY_ID_SET",
      "isAsyncHostCapabilityId",
      "asAsyncHostAdapter",
      "ASYNC_HOST_CAPABILITY_RECORDS",
      "assertAsyncHostCapabilityRecord",
      "assertCanonicalAsyncHostCapabilityRecord",
      "resolveAsyncHostCapabilityRecord",
      "isPreparedAsyncHostCapabilityId",
      "asPreparedAsyncHostAdapter",
      "assertCanonicalPreparedAsyncHostCapabilityRecord",
      "ASYNC_HOST_ADAPTERS",
      "ASYNC_OPTIONAL_HOST_ADAPTERS",
      "capabilities",
      "HOST_TARGET",
      "STANDALONE_TARGET",
      "WASMGC_BACKEND",
      "NO_DEPENDENCIES",
      "NO_HOST_CAPABILITIES",
      "HOST_CAPABILITY_IMPLEMENTATION",
      "HOST_MANAGED_IMPLEMENTATION",
      "NATIVE_MANAGED_IMPLEMENTATION",
      "provider",
      "nativeProvider",
      "ASYNC_RUNTIME_PROVIDERS",
    ],
    functions: 12,
    hash: "d79d6b3bf631cefc74ceb7694bd6018fc10945f92cb58ff6f314087404ea8848",
    classes: [],
  },
  {
    name: "runtime-callable-declarations",
    names: [
      "IrRuntimeCallableDeclaration",
      "semanticTypes",
      "referenceError",
      "REFERENCE_ERROR_DECLARATION",
      "irRuntimeCallableDeclaration",
    ],
    functions: 2,
    hash: "584ba8934231641c22ad19ba6da19c8297f0b44796b79b686e6d1c10e09db0d6",
    classes: [],
  },
  {
    name: "runtime-manifest",
    names: [
      "projectRuntimeBackendRequirements",
      "RuntimeManifestInvariantCode",
      "RuntimeManifestInvariantError",
      "ALL_TARGETS",
      "ALL_BACKENDS",
      "REFERENCE_ERROR_DECLARATION",
      "REFERENCE_ERROR_SIGNATURE",
      "RUNTIME_FEATURE_SIGNATURES",
      "provider",
      "NUMERIC_COERCION_RUNTIME_PROVIDERS",
      "numberBoundaryProvider",
      "NUMBER_BOUNDARY_RUNTIME_PROVIDERS",
      "BOOLEAN_BOUNDARY_RUNTIME_PROVIDERS",
      "EXTERN_BOUNDARY_RUNTIME_PROVIDERS",
      "GENERATOR_NUMBER_BOX_RUNTIME_PROVIDERS",
      "STRING_COMPARE_RUNTIME_PROVIDERS",
      "stringCompareProviderId",
      "STRING_COMPARE_FEATURE_SET",
      "isStringCompareFeature",
      "STRING_EQ_RUNTIME_PROVIDERS",
      "stringEqProviderId",
      "STRING_EQ_FEATURE_SET",
      "isStringEqFeature",
      "STRING_LEN_RUNTIME_PROVIDERS",
      "stringLenProviderId",
      "STRING_LEN_FEATURE_SET",
      "isStringLenFeature",
      "STRING_CONCAT_RUNTIME_PROVIDERS",
      "STRING_CONCAT_OWNED_RUNTIME_FEATURE",
      "stringConcatProviderId",
      "STRING_CONCAT_FEATURE_SET",
      "isStringConcatFeature",
      "STRING_CHAR_CODE_AT_RUNTIME_PROVIDERS",
      "STRING_CONCAT_MANY_RUNTIME_PROVIDERS",
      "stringCharCodeAtProviderId",
      "STRING_CHAR_CODE_AT_FEATURE_SET",
      "isStringCharCodeAtFeature",
      "stringConcatManyProviderId",
      "STRING_CONST_RUNTIME_PROVIDERS",
      "stringConstProviderId",
      "STRING_CONST_FEATURE_SET",
      "isStringConstFeature",
      "STRING_CONCAT_MANY_FEATURE_SET",
      "isStringConcatManyFeature",
      "stringConcatManyArityCap",
      "generatorNumberBoxProviderId",
      "GENERATOR_NUMBER_BOX_FEATURE_SET",
      "isGeneratorNumberBoxFeature",
      "booleanBoundaryProviderId",
      "BOOLEAN_BOUNDARY_FEATURE_SET",
      "isBooleanBoundaryFeature",
      "externIsUndefinedProviderId",
      "EXTERN_BOUNDARY_FEATURE_SET",
      "isExternBoundaryFeature",
      "numberBoundaryProviderId",
      "NUMBER_BOUNDARY_FEATURE_SET",
      "isNumberBoundaryFeature",
      "PROVIDERS_BY_FEATURE",
      "PURE_MATH_RUNTIME_PROVIDERS",
      "HOST_CALLBACK_WRAP_RUNTIME_PROVIDERS",
      "hostCallbackWrapProviderId",
      "HOST_CALLBACK_WRAP_FEATURE_SET",
      "isHostCallbackWrapFeature",
      "FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDERS",
      "functionPrototypeCallProviderId",
      "FUNCTION_PROTOTYPE_CALL_FEATURE_SET",
      "isFunctionPrototypeCallFeature",
      "REFERENCE_ERROR_RUNTIME_PROVIDERS",
      "RUNTIME_PROVIDERS",
      "FEATURE_SET",
      "PROVIDER_ID_SET",
      "HOST_CAPABILITY_ID_SET",
      "TARGET_SET",
      "BACKEND_SET",
      "isRuntimeFeature",
      "compareStrings",
      "signatureEquals",
      "cloneProvider",
      "cycleKey",
      "useOrder",
      "stronglyConnectedComponents",
      "buildProviderComponents",
      "RuntimeManifestBuilderOptions",
      "BuilderState",
      "RuntimeManifestBuilder",
    ],
    functions: 38,
    hash: "3b6894dd5db09155ae12edb92c2cc97a8256da6b1d2e9461fdf10ceace77df9d",
    classes: [
      {
        name: "RuntimeManifestInvariantError",
        members: 3,
        hash: "200c062afd0ba92c8930a889c5cbfde37507a44e36f701862294519ab64d8f2b",
      },
      {
        name: "RuntimeManifestBuilder",
        members: 35,
        hash: "de8d95ce9b19e5090fdce975c8c21ca5a802235d34e9356722e70f747ad1ccbd",
      },
    ],
  },
  {
    name: "async-plan",
    names: [
      "asAsyncStateId",
      "asAsyncHandlerId",
      "canonicalPromiseAbi",
      "preparedManifestByPlan",
      "runtimeAttachmentError",
      "sameOrderedStrings",
      "expectedAsyncProviders",
      "assertFrozenProvider",
      "freezePreparedIrAsyncStateBody",
      "isPreparedIrAsyncStateBodyFrozen",
      "sealPreparedIrAsyncStates",
      "assertPreparedIrAsyncRuntimeCurrent",
      "createPreparedIrAsyncRuntime",
      "sealPreparedIrAsyncRuntimeContainers",
      "IrAsyncPlanInvariantCode",
      "IrAsyncPlanVerifyError",
      "IrAsyncPlanInvariantError",
      "StateLiveness",
      "StateEdge",
      "runtimeIntentOrder",
      "runtimeIntentRank",
      "isNonNegativeSafeInteger",
      "compareNumber",
      "sameValueSet",
      "describeValues",
      "terminatorUses",
      "stateUpdates",
      "updateMap",
      "stateEdges",
      "stateLiveness",
      "addPurityError",
      "verifyPureData",
      "addError",
      "AsyncValueChecker",
      "verifyResumeIncomingEdges",
      "verifySpillUpdates",
      "verifyCanonicalPromiseAbi",
      "preparedIrAsyncFrameCapabilityFailure",
      "irAsyncPlanNeedsNumberBridge",
      "requiredRuntimeIntents",
      "verifyIrAsyncPlan",
      "assertIrAsyncPlan",
      "clonePlanData",
      "canonicalPlanInput",
      "createIrAsyncPlan",
      "canonicalJson",
      "serializeIrAsyncPlan",
      "hashIrAsyncPlan",
    ],
    functions: 39,
    hash: "e5ae8637ae9d13e4b64f91ac7c888d1f5b67458a0d375d59f5f1dd002148181c",
    classes: [
      {
        name: "IrAsyncPlanInvariantError",
        members: 1,
        hash: "5cde880d962b051bb92d4483fc0ce7a3b2ec7e7635d5a238a9cd1b67a4652b18",
      },
    ],
  },
  {
    name: "intrinsic-support",
    names: [
      "BACKEND_COMPOSITE_BY_INTRINSIC",
      "callableBindingKey",
      "ADMITTED_CALLABLE_TARGETS",
      "projectStandaloneAsyncStateInstr",
      "verifyIrIntrinsicInstruction",
      "mapArray",
      "valueTypesOf",
      "providerAttachment",
      "GENERATOR_NUMBER_BOX_RUNTIME_FEATURE",
      "preparedGeneratorNumberBoxProvider",
      "STRING_COMPARE_RUNTIME_FEATURE",
      "preparedStringCompareProvider",
      "STRING_EQ_RUNTIME_FEATURE",
      "preparedStringEqProvider",
      "STRING_LEN_RUNTIME_FEATURE",
      "preparedStringLenProvider",
      "STRING_CONCAT_RUNTIME_FEATURE",
      "STRING_CONCAT_OWNED_RUNTIME_FEATURE",
      "stringConcatFeatureFor",
      "preparedStringConcatProvider",
      "STRING_CHAR_CODE_AT_RUNTIME_FEATURE",
      "preparedStringCharCodeAtProvider",
      "STRING_CONCAT_MANY_RUNTIME_FEATURE",
      "preparedStringConcatManyProvider",
      "STRING_CONST_RUNTIME_FEATURE",
      "STRING_CONST_UTF16_RUNTIME_FEATURE",
      "stringConstFeatureFor",
      "preparedStringConstProvider",
      "HOST_CALLBACK_WRAP_RUNTIME_FEATURE",
      "FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURE",
      "preparedHostCallbackWrapProvider",
      "preparedFunctionPrototypeCallProvider",
      "sameProvider",
      "attachProvidersToBuffer",
      "attachProviders",
      "IrRuntimeManifestDemands",
      "PrepareIrRuntimeManifestInput",
      "IrRuntimeFunctionPreparationError",
      "prepareIrRuntimeManifest",
      "prepareIrRuntimeManifest",
      "prepareIrRuntimeManifest",
    ],
    functions: 24,
    hash: "99e018d0528edacb7ae76323f077efaa5c3528091f0aa88a4b15a1d6a036562c",
    classes: [
      {
        name: "IrRuntimeFunctionPreparationError",
        members: 1,
        hash: "d456b271f751ab2dd0bff29f4425384e9a1cefb247616bde01efb54b463463b0",
      },
    ],
  },
] as const;

const destinations: Record<string, readonly string[]> = {
  "runtime-host-capabilities": ["src/ir/runtime/host-capabilities.ts"],
  "runtime-callable-declarations": ["src/ir/runtime/callable-declarations.ts"],
  "runtime-manifest": ["src/ir/runtime/manifest.ts"],
  "async-runtime-providers": ["src/ir/runtime/async-providers.ts", "src/ir/core/async-intents.ts"],
  "async-plan": ["src/ir/analysis/async-plan.ts", "src/ir/runtime/async-attachment.ts"],
  "intrinsic-support": ["src/ir/intrinsic-support.ts", "src/ir/runtime/intrinsic-verification.ts"],
};

function parse(path: string, overrides: ReadonlyMap<string, string> = new Map()): ts.SourceFile {
  const file = ts.createSourceFile(
    path,
    overrides.get(path) ?? read(path),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if ((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length !== 0)
    throw new Error("syntax error in " + path);
  return file;
}

function declarations(file: ts.SourceFile): readonly ts.Statement[] {
  return file.statements.filter((node) => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node));
}

function nameOf(node: ts.Statement, file: ts.SourceFile): string {
  if (ts.isVariableStatement(node))
    return node.declarationList.declarations.map((entry) => entry.name.getText(file)).join(",");
  if ("name" in node && node.name && ts.isIdentifier(node.name as ts.Node)) return (node.name as ts.Identifier).text;
  throw new Error("unnamed declaration in " + file.fileName);
}

function verifyLedger(receipt: (typeof receipts)[number], overrides: ReadonlyMap<string, string> = new Map()): void {
  const source = (path: string) => overrides.get(path) ?? read(path);
  // Current source order is checked before the independent historical order.
  for (const path of destinations[receipt.name]!) currentDeclarations(path, source);
  const rows =
    receipt.name === "runtime-host-capabilities"
      ? currentDeclarations("src/ir/runtime/host-capabilities.ts", source)
      : historicalRuntimeDeclarations(
          receipt.name === "runtime-callable-declarations"
            ? "src/ir/runtime/callable-declarations.ts"
            : "src/ir/" + receipt.name + ".ts",
          source,
        );
  if (JSON.stringify(rows.map((row) => row.name)) !== JSON.stringify(receipt.names))
    throw new Error("historical declaration order changed");
  const reconstructed = rows.map((row) => {
    // Reparse the normalized declaration, including live ordinary comments.
    // row.node can otherwise still contain the current extra class overload.
    const leading = row.file.text.slice(row.node.getFullStart(), row.node.getStart());
    const file = parse(row.path, new Map([[row.path, leading + row.text]]));
    if (file.statements.length !== 1) throw new Error("reconstructed declaration population changed");
    const node = file.statements[0]!;
    return { name: row.name, file, node, text: node.getFullText(file).trim() };
  });
  if (reconstructed.filter(({ node }) => ts.isFunctionDeclaration(node)).length !== receipt.functions)
    throw new Error("function denominator changed");
  if (hash(reconstructed.map(({ text }) => text)) !== receipt.hash) throw new Error("declaration receipt changed");
  for (const census of receipt.classes) {
    const entry = reconstructed.find(({ name }) => name === census.name)!;
    if (
      !ts.isClassDeclaration(entry.node) ||
      entry.node.members.length !== census.members ||
      hash(entry.node.members.map((member) => member.getFullText(entry.file).trim())) !== census.hash
    )
      throw new Error("member/initializer receipt changed for " + census.name);
  }
}

describe("provider ownership historical receipts after checked extension reconstruction", () => {
  it.each(receipts)("retains the complete $name declaration/member/initializer ledger", (receipt) => {
    verifyLedger(receipt);
  });

  it("retains 253 declarations/143 function declarations without replacing the parent's 224/118 ledger", () => {
    expect(receipts.reduce((sum, receipt) => sum + receipt.names.length, 0)).toBe(253);
    expect(receipts.reduce((sum, receipt) => sum + receipt.functions, 0)).toBe(143);
    // The parent also reconstructs intrinsics (24/5); B's four shared groups
    // are 200/113. Host capabilities and runtime callables add 53/30 here.
    const shared = receipts.filter(
      (receipt) => !["runtime-host-capabilities", "runtime-callable-declarations"].includes(receipt.name),
    );
    expect(shared.reduce((sum, receipt) => sum + receipt.names.length, 0)).toBe(200);
    expect(shared.reduce((sum, receipt) => sum + receipt.functions, 0)).toBe(113);
  });

  it.each(["missing", "renamed", "duplicate", "body", "initializer"] as const)(
    "the source receipt rejects a %s implementation mutation",
    (kind) => {
      const receipt = receipts.find((entry) => entry.name === "runtime-manifest")!;
      verifyLedger(receipt);
      const path = destinations[receipt.name]![0]!;
      const file = parse(path);
      const node = declarations(file).find((entry) => nameOf(entry, file) === "RuntimeManifestBuilder")!;
      const original = read(path);
      let changed: string;
      if (kind === "missing") changed = original.slice(0, node.getFullStart()) + original.slice(node.end);
      else if (kind === "duplicate") changed = original + "\n" + node.getFullText(file);
      else if (kind === "renamed")
        changed = original.replace("export class RuntimeManifestBuilder", "export class RenamedRuntimeManifestBuilder");
      else if (kind === "initializer")
        changed = original.replace('#state: BuilderState = "open"', '#state: BuilderState = "failed"');
      else changed = original.replace('this.#state = "building";', 'this.#state = "failed";');
      expect(changed).not.toBe(original);
      expect(() => verifyLedger(receipt, new Map([[path, changed]]))).toThrow();
    },
  );

  it.each(Object.values(destinations).flat())(
    "rejects reordered live declarations in %s before reconstructing history",
    (path) => {
      const file = parse(path),
        original = read(path),
        nodes = declarations(file);
      const first = nodes[0]!,
        second = nodes[1]!;
      const changed =
        original.slice(0, first.getFullStart()) +
        second.getFullText(file) +
        first.getFullText(file) +
        original.slice(second.end);
      expect(changed).not.toBe(original);
      const receipt = receipts.find((entry) => destinations[entry.name]!.includes(path))!;
      verifyLedger(receipt);
      expect(() => verifyLedger(receipt, new Map([[path, changed]]))).toThrow(/current declaration order/);
    },
  );

  it("rejects removal of failed-first-registration rollback cleanup from live source", () => {
    const path = "src/ir/runtime/async-attachment.ts",
      original = read(path);
    const changed = original.replace("if (!previous) preparedManifestByPlan.delete(input.plan);", "");
    expect(changed).not.toBe(original);
    const receipt = receipts.find((entry) => entry.name === "async-plan")!;
    verifyLedger(receipt);
    expect(() => verifyLedger(receipt, new Map([[path, changed]]))).toThrow(/declaration receipt changed/);
  });

  it("rejects an empty-success combined verifier independently of historical reconstruction", () => {
    const receipt = receipts.find((entry) => entry.name === "intrinsic-support")!;
    verifyLedger(receipt);
    const path = "src/ir/runtime/intrinsic-verification.ts";
    const file = parse(path);
    const node = file.statements.find(
      (entry): entry is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(entry) && entry.name?.text === "verifyIrIntrinsicInstruction",
    )!;
    const original = read(path);
    const changed = original.slice(0, node.body!.getStart(file)) + "{ return []; }" + original.slice(node.body!.end);
    expect(changed).not.toBe(original);
    expect(() => verifyLedger(receipt, new Map([[path, changed]]))).toThrow(/exact semantic prefix/);
  });

  it("keeps the current 37-member/six-overload builder census separate from historical 35/four", () => {
    const file = parse("src/ir/runtime/manifest.ts");
    const builder = file.statements.find(
      (entry): entry is ts.ClassDeclaration =>
        ts.isClassDeclaration(entry) && entry.name?.text === "RuntimeManifestBuilder",
    )!;
    expect(
      builder.members.map((member) =>
        ts.isConstructorDeclaration(member) ? "constructor" : member.name!.getText(file),
      ),
    ).toEqual([
      "#policy",
      "#uses",
      "#requestedFeatures",
      "#providers",
      "#hostCapabilityRecords",
      "#addedDependencies",
      "#declaredCycles",
      "#plannedIntrinsicIds",
      "#plannedProviderIds",
      "#plannedHostCapabilityIds",
      "#providerPlans",
      "#state",
      "#manifest",
      "constructor",
      "addIntrinsicUse",
      "requestFeature",
      "registerProvider",
      "addProviderDependency",
      "declareProviderCycle",
      "freeze",
      "manifest",
      "resolveProvider",
      "resolveProvider",
      "resolveProvider",
      "resolveProvider",
      "resolveProvider",
      "resolveProvider",
      "resolveProvider",
      "assertIntrinsicPlanned",
      "assertProviderPlanned",
      "assertHostCapabilityPlanned",
      "#buildManifest",
      "#indexProviders",
      "#selectProvider",
      "#assertKnownFeature",
      "#assertMutable",
      "#assertFrozen",
    ]);
    expect(builder.members.filter(ts.isPropertyDeclaration)).toHaveLength(13);
    expect(
      builder.members
        .filter((member) => ts.isPropertyDeclaration(member) && member.initializer)
        .map((member) => member.name!.getText(file)),
    ).toEqual([
      "#uses",
      "#requestedFeatures",
      "#addedDependencies",
      "#declaredCycles",
      "#plannedIntrinsicIds",
      "#plannedProviderIds",
      "#plannedHostCapabilityIds",
      "#providerPlans",
      "#state",
    ]);
    expect(builder.members.filter((member) => ts.isMethodDeclaration(member) && member.body)).toHaveLength(16);
    expect(builder.members).toHaveLength(37);
    expect(builder.members.filter((member) => ts.isMethodDeclaration(member) && !member.body)).toHaveLength(6);
    expect(builder.members.filter(ts.isConstructorDeclaration)).toHaveLength(1);
    expect(builder.members.filter(ts.isGetAccessorDeclaration)).toHaveLength(1);
  });

  it("retains exactly one attachment WeakMap and no implementation in the five complete facades", () => {
    const file = parse("src/ir/runtime/async-attachment.ts");
    expect(declarations(file).filter((entry) => nameOf(entry, file) === "preparedManifestByPlan")).toHaveLength(1);
    for (const path of [
      "runtime-host-capabilities",
      "async-runtime-providers",
      "runtime-callable-declarations",
      "runtime-manifest",
      "async-plan",
    ]) {
      expect(declarations(parse("src/ir/" + path + ".ts"))).toEqual([]);
    }
  });
});

describe("canonical provider identities and catalogs", () => {
  it.each([
    { name: "host", historical: oldHost, canonical: host },
    { name: "async providers", historical: oldProviders, canonical: providers },
    { name: "callables", historical: oldCallables, canonical: callables },
    { name: "manifest", historical: oldManifest, canonical: manifest },
    { name: "async plan", historical: oldPlan, canonical: { ...semanticPlan, ...attachment } },
  ])("forwards every existing $name value by identity", ({ historical, canonical }) => {
    const names = Object.keys(historical).sort();
    expect(names.length).toBeGreaterThan(0);
    const added = historical === oldCallables ? ["REFERENCE_ERROR_RUNTIME_PROVIDERS", "REFERENCE_ERROR_SIGNATURE"] : [];
    expect([...names, ...added].sort()).toEqual(Object.keys(canonical).sort());
    for (const name of names) {
      expect(Reflect.get(canonical, name)).toBeDefined();
      expect(Reflect.get(historical, name)).toBe(Reflect.get(canonical, name));
    }
    if (historical === oldCallables) {
      expect(names).toEqual(["irRuntimeCallableDeclaration"]);
      expect(callables.REFERENCE_ERROR_RUNTIME_PROVIDERS).toBe(manifest.REFERENCE_ERROR_RUNTIME_PROVIDERS);
      expect(callables.REFERENCE_ERROR_SIGNATURE).toBe(
        manifest.RUNTIME_FEATURE_SIGNATURES["error.reference.construct"],
      );
    }
  });

  it("shares the semantic guard and combined verifier with their historical paths", () => {
    expect(providers.isAsyncRuntimeFeature).toBe(isAsyncRuntimeFeature);
    expect(historicalVerify).toBe(verifyIrIntrinsicInstruction);
    expect(isAsyncRuntimeFeature("promise.number.bridge")).toBe(true);
    expect(isAsyncRuntimeFeature("async.promise.resolve")).toBe(false);
  });

  it("retains canonical capability objects, order and async narrowing", () => {
    expect(host.RUNTIME_HOST_CAPABILITY_RECORDS.length).toBeGreaterThan(0);
    expect(providers.ASYNC_HOST_CAPABILITY_RECORDS).toEqual(
      host.RUNTIME_HOST_CAPABILITY_RECORDS.filter((record) => providers.isAsyncHostCapabilityId(record.capability)),
    );
    for (const record of providers.ASYNC_HOST_CAPABILITY_RECORDS) {
      expect(host.RUNTIME_HOST_CAPABILITY_RECORDS).toContain(record);
      expect(() => host.assertCanonicalRuntimeHostCapabilityRecord(record)).not.toThrow();
      expect(() => host.assertCanonicalRuntimeHostCapabilityRecord(Object.freeze({ ...record }))).toThrow(
        /canonical catalog record/,
      );
    }
    const boolean = host.resolveRuntimeHostCapabilityFuncRecord(host.RUNTIME_HOST_CAPABILITY_RECORDS, "boolean.box");
    expect(() => providers.asAsyncHostAdapter(boolean)).toThrow(/not an async capability/);
    const number = host.resolveRuntimeHostCapabilityFuncRecord(host.RUNTIME_HOST_CAPABILITY_RECORDS, "number.box");
    expect(providers.asPreparedAsyncHostAdapter(number)).toBe(number);
    const global = host.RUNTIME_HOST_CAPABILITY_RECORDS.find((record) => record.kind === "global")!;
    expect(() => host.asCallableRuntimeHostCapabilityRecord(global)).toThrow(/not a callable/);
  });

  it("retains the central ReferenceError ABI and structural callable binding", () => {
    const record = host.resolveRuntimeHostCapabilityFuncRecord(
      host.RUNTIME_HOST_CAPABILITY_RECORDS,
      "error.reference.construct",
    );
    const declaration = callables.irRuntimeCallableDeclaration(irRuntimeFuncRef(record.field))!;
    expect(declaration.feature).toBe("error.reference.construct");
    expect(declaration.params).toEqual(record.params.map((kind) => ({ kind: "val", val: { kind } })));
    expect(callables.irRuntimeCallableDeclaration(irImportFuncRef("env", record.field))).toBeUndefined();
    expect(callables.irRuntimeCallableDeclaration({ ...declaration.ref, name: "diagnostic rename" })).toBe(declaration);
  });
});

const F64 = irVal({ kind: "f64" });
const I32 = irVal({ kind: "i32" });
const value = asValueId(0);
function instruction(id: IntrinsicId = "math.sin"): IrInstrIntrinsic {
  return {
    kind: "intrinsic",
    id,
    version: 1,
    args: [value],
    result: asValueId(1),
    resultType: INTRINSIC_DEFINITIONS[id].signature.result,
  };
}
function addUse(builder: manifest.RuntimeManifestBuilder, id: IntrinsicId = "math.sin"): void {
  const instr = instruction(id),
    signature = INTRINSIC_DEFINITIONS[id].signature;
  builder.addIntrinsicUse(
    {
      id,
      version: 1,
      argumentTypes: signature.params,
      resultType: signature.result,
      location: { file: "provider-ownership.ts", line: 1, column: 0 },
    },
    intrinsicEffectEvidence(instr),
  );
}
const nativePolicy = { target: "standalone", backend: "wasmgc" } as const;
const invariant = (code: manifest.RuntimeManifestInvariantCode) =>
  expect.objectContaining({ code, kind: "invariant", stage: "verify" });

describe("combined intrinsic verification", () => {
  it("keeps semantic diagnostics before physical-provider diagnostics", () => {
    const instr: IrInstrIntrinsic = {
      ...instruction("math.pow"),
      version: 2 as IrInstrIntrinsic["version"],
      args: [value, value, value],
      resultType: I32,
      provider: { kind: "callable", target: irImportFuncRef("bad", "target") },
    };
    const types = new Map([[value, I32]]);
    expect(verifyIrIntrinsicInstruction(instr, types)).toEqual([
      "math.pow uses signature v2; expected v1",
      "math.pow expects 2 argument(s), got 3",
      "math.pow argument 0 does not match its v2 signature",
      "math.pow argument 1 does not match its v2 signature",
      "math.pow result does not match its v2 signature",
      "math.pow callable provider target import:bad:target is not an admitted physical provider",
    ]);
    expect(verifyIrIntrinsicSignature(instr, types)).toEqual(verifyIrIntrinsicInstruction(instr, types).slice(0, 5));
  });

  it("preserves missing-type handling and malformed-ID throws", () => {
    expect(verifyIrIntrinsicInstruction(instruction(), new Map())).toEqual([]);
    expect(() => verifyIrIntrinsicInstruction({ ...instruction(), id: "unknown" as IntrinsicId }, new Map())).toThrow(
      TypeError,
    );
  });

  it.each([
    {
      provider: { kind: "callable", target: irIntrinsicFuncRef("math.cos") },
      message: /retain the semantic intrinsic binding/,
    },
    {
      provider: { kind: "callable", target: irRuntimeFuncRef("__wrong") },
      message: /not an admitted physical provider/,
    },
    {
      provider: { kind: "backend-composite", operation: "math.min" },
      message: /does not admit a backend composite provider/,
    },
  ] satisfies readonly { provider: IrInstrIntrinsic["provider"]; message: RegExp }[])(
    "rejects a wrong provider $provider.kind",
    ({ provider, message }) => {
      expect(verifyIrIntrinsicInstruction({ ...instruction(), provider }, new Map([[value, F64]])).join("\n")).toMatch(
        message,
      );
    },
  );

  it("retains exact composite operation authentication", () => {
    const instr = { ...instruction("math.max"), args: [value, value] };
    expect(
      verifyIrIntrinsicInstruction(
        { ...instr, provider: { kind: "backend-composite", operation: "math.max" } },
        new Map([[value, F64]]),
      ),
    ).toEqual([]);
    expect(
      verifyIrIntrinsicInstruction(
        { ...instr, provider: { kind: "backend-composite", operation: "math.min" } },
        new Map([[value, F64]]),
      ),
    ).toEqual(["math.max backend composite provider must use math.max, got math.min"]);
  });
});

describe("manifest lifecycle and provider graph", () => {
  it("retains provider-only trig closure, deterministic order and selected object identities", () => {
    const builder = new manifest.RuntimeManifestBuilder(nativePolicy);
    addUse(builder);
    const frozen = builder.freeze();
    expect(frozen.features).toEqual(["math.reduce-trig", "math.sin"]);
    expect(frozen.providers.map((provider) => provider.id)).toEqual(["selfhost.math.reduce-trig", "selfhost.math.sin"]);
    expect(builder.manifest).toBe(frozen);
    expect(frozen.providers).toContain(builder.resolveProvider("math.sin"));
    expect(builder.resolveProvider("math.sin").signature).toBe(INTRINSIC_DEFINITIONS["math.sin"].signature);
    expect(() => builder.assertIntrinsicPlanned("math.sin")).not.toThrow();
    expect(() => builder.assertProviderPlanned("selfhost.math.sin")).not.toThrow();
  });

  it("preserves failed-freeze terminal state and exact invariant identity", () => {
    const builder = new manifest.RuntimeManifestBuilder(nativePolicy, { providers: [] });
    expect(() => builder.manifest).toThrow(invariant("manifest-not-frozen"));
    addUse(builder);
    expect(() => builder.freeze()).toThrow(invariant("missing-runtime-provider"));
    expect(() => builder.requestFeature("math.cos")).toThrow(invariant("manifest-build-failed"));
    expect(() => builder.freeze()).toThrow(oldManifest.RuntimeManifestInvariantError);
    expect(() => builder.resolveProvider("math.sin")).toThrow(invariant("manifest-not-frozen"));
  });

  it("rejects every late mutation and unplanned lookup", () => {
    const builder = new manifest.RuntimeManifestBuilder(nativePolicy);
    addUse(builder);
    builder.freeze();
    for (const mutate of [
      () => builder.requestFeature("math.cos"),
      () => addUse(builder, "math.cos"),
      () => builder.registerProvider(manifest.RUNTIME_PROVIDERS[0]!),
      () => builder.addProviderDependency("math.sin", "math.cos"),
      () => builder.declareProviderCycle(["math.sin"]),
      () => builder.freeze(),
    ])
      expect(mutate).toThrow(invariant("manifest-frozen"));
    expect(() => builder.resolveProvider("math.cos")).toThrow(invariant("late-unplanned-feature"));
    expect(() => builder.assertIntrinsicPlanned("math.cos")).toThrow(invariant("late-unplanned-intrinsic"));
    expect(() => builder.assertProviderPlanned("backend.f64.abs")).toThrow(invariant("late-unplanned-provider"));
    expect(() => builder.assertHostCapabilityPlanned("host.random")).toThrow(
      invariant("late-unplanned-host-capability"),
    );
  });

  it("retains declared-cycle ordering and refuses undeclared cycles", () => {
    const build = (cycle?: readonly manifest.RuntimeFeature[]) => {
      const builder = new manifest.RuntimeManifestBuilder(nativePolicy);
      addUse(builder);
      builder.addProviderDependency("math.reduce-trig", "math.sin");
      if (cycle) builder.declareProviderCycle(cycle);
      return builder.freeze();
    };
    expect(() => build()).toThrow(invariant("undeclared-provider-cycle"));
    expect(build(["math.sin", "math.reduce-trig"])).toEqual(build(["math.reduce-trig", "math.sin"]));
  });

  it("retains unavailable-policy refusal and rejects mixed backend projection", () => {
    const builder = new manifest.RuntimeManifestBuilder(nativePolicy);
    builder.requestFeature("js.number.box");
    expect(() => builder.freeze()).toThrow(invariant("provider-target-unavailable"));
    const hostProvider = providers.ASYNC_RUNTIME_PROVIDERS.find(
      (provider) => provider.implementation.kind === "host-managed",
    )!;
    const nativeProvider = providers.ASYNC_RUNTIME_PROVIDERS.find(
      (provider) => provider.implementation.kind === "native-managed",
    )!;
    expect(hostProvider).toBeDefined();
    expect(nativeProvider).toBeDefined();
    expect(() => manifest.projectRuntimeBackendRequirements([hostProvider, nativeProvider])).toThrow(
      invariant("invalid-backend-requirement-projection"),
    );
    expect(() => manifest.projectRuntimeBackendRequirements([nativeProvider, hostProvider])).toThrow(
      invariant("invalid-backend-requirement-projection"),
    );
  });

  it("retains derived concat ceilings and the exact family validator", () => {
    const record = host.RUNTIME_HOST_CAPABILITY_RECORDS.find((entry) => entry.capability === "string.concat.many")!;
    expect(record.kind).toBe("func-family");
    expect(manifest.stringConcatManyArityCap("host")).toBe(Infinity);
    expect(manifest.stringConcatManyArityCap("native")).toBe(manifest.STRING_CONCAT_MANY_NATIVE_ARITY.max);
    expect(
      host.resolveRuntimeHostCapabilityFuncFamilyRecord(host.RUNTIME_HOST_CAPABILITY_RECORDS, "string.concat.many", 3)
        .params,
    ).toHaveLength(3);
    for (const arity of [2, 3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        host.resolveRuntimeHostCapabilityFuncFamilyRecord(
          host.RUNTIME_HOST_CAPABILITY_RECORDS,
          "string.concat.many",
          arity,
        ),
      ).toThrow();
    }
    expect(
      () =>
        new manifest.RuntimeManifestBuilder({
          ...nativePolicy,
          stringConcat: { concat: "host" },
          stringConcatMany: { batch: "native" },
        }),
    ).toThrow(/disagrees/);
  });
});

const identities = createTestIrFunctionIdentityFactory("provider-verification-ownership");
function runtimeFixture(target: "standalone" | "host" = "standalone") {
  const identity = identities.next("resolveNumber");
  const plan = semanticPlan.createIrAsyncPlan({
    schemaVersion: 1,
    ownerUnitId: identity.unitId,
    kind: "async-function",
    abi: semanticPlan.canonicalPromiseAbi(F64),
    entry: semanticPlan.asAsyncStateId(0),
    params: [{ value, type: F64 }],
    values: [{ value, type: F64 }],
    spills: [],
    handlers: [],
    states: [{ id: semanticPlan.asAsyncStateId(0), body: [], terminator: { kind: "resolve", value } }],
    runtimeIntents: ASYNC_RUNTIME_FEATURES,
  });
  const builder = new manifest.RuntimeManifestBuilder({ target, backend: "wasmgc" });
  for (const intent of plan.runtimeIntents) builder.requestFeature(intent);
  const frozen = builder.freeze();
  const selected = Object.freeze(
    frozen.providers.filter((provider) => plan.runtimeIntents.some((intent) => intent === provider.feature)),
  );
  const input: PreparedIrAsyncRuntimeInput =
    target === "standalone"
      ? {
          kind: "standalone-native-wasmgc",
          plan,
          manifest: frozen,
          providers: selected,
          backendRequirements: manifest.projectRuntimeBackendRequirements(selected),
          states: plan.states,
          adapters: Object.freeze([] as const),
        }
      : {
          kind: "host-wasmgc",
          plan,
          manifest: frozen,
          providers: selected,
          backendRequirements: manifest.projectRuntimeBackendRequirements(selected),
          states: plan.states,
          adapters: Object.freeze(
            frozen.hostCapabilityRecords.map((record) => {
              const callable = providers.asPreparedAsyncHostAdapter(record);
              return Object.freeze({
                capability: callable.capability,
                record: callable,
                target: irImportFuncRef(callable.module, callable.field, callable.field),
              });
            }),
          ),
        };
  const runtime = attachment.createPreparedIrAsyncRuntime(input);
  const current = (candidate: PreparedIrAsyncRuntime = runtime) =>
    attachment.assertPreparedIrAsyncRuntimeCurrent(identity.unitId, identity.name, plan, candidate);
  return { identity, plan, input, runtime, current };
}

describe("one authenticated async attachment authority", () => {
  it.each(["standalone", "host"] as const)("retains exact %s joins and unchanged sealing identity", (target) => {
    const { plan, input, runtime, current } = runtimeFixture(target);
    expect(input.providers).toHaveLength(7);
    expect(current()).toBe(runtime);
    expect(runtime.plan).toBe(plan);
    expect(runtime.manifest).toBe(input.manifest);
    expect(runtime.providers).toBe(input.providers);
    expect(attachment.sealPreparedIrAsyncRuntimeContainers(runtime)).toBe(runtime);
    expect(attachment.preparedIrAsyncFrameCapabilityFailure(runtime)).toBeUndefined();
    expect(semanticPlan.serializeIrAsyncPlan(plan)).toBe(oldPlan.serializeIrAsyncPlan(plan));
  });

  it.each([
    "provider order",
    "provider clone",
    "stale manifest",
    "missing requirements",
    "mutable body",
    "mutable layout",
  ] as const)("rejects %s without granting new authority", (kind) => {
    const { runtime, current } = runtimeFixture();
    let changed: PreparedIrAsyncRuntime;
    if (kind === "provider order")
      changed = Object.freeze({ ...runtime, providers: Object.freeze([...runtime.providers].reverse()) });
    else if (kind === "provider clone")
      changed = Object.freeze({
        ...runtime,
        providers: Object.freeze(runtime.providers.map((provider) => Object.freeze({ ...provider }))),
      });
    else if (kind === "stale manifest")
      changed = Object.freeze({ ...runtime, manifest: Object.freeze({ ...runtime.manifest }) });
    else if (kind === "missing requirements")
      changed = Object.freeze({ ...runtime, backendRequirements: Object.freeze([]) });
    else if (kind === "mutable layout") changed = Object.freeze({ ...runtime, typeLayouts: [] });
    else
      changed = Object.freeze({
        ...runtime,
        states: Object.freeze(runtime.states.map((state) => Object.freeze({ ...state, body: [...state.body] }))),
      });
    expect(() => current(changed)).toThrow();
  });

  it("rejects wrong owners and a shape-equal but unauthenticated plan", () => {
    const { plan, runtime } = runtimeFixture();
    const foreign = identities.next("foreign");
    expect(() => attachment.assertPreparedIrAsyncRuntimeCurrent(foreign.unitId, foreign.name, plan, runtime)).toThrow(
      /exact semantic plan owner/,
    );
    const clone = semanticPlan.createIrAsyncPlan(plan);
    expect(semanticPlan.serializeIrAsyncPlan(clone)).toBe(semanticPlan.serializeIrAsyncPlan(plan));
    expect(() =>
      attachment.assertPreparedIrAsyncRuntimeCurrent(
        plan.ownerUnitId,
        "clone",
        clone,
        Object.freeze({ ...runtime, plan: clone }),
      ),
    ).toThrow(/authenticated frozen manifest/);
  });

  it("rejects detached host records and incomplete adapters", () => {
    const { runtime, current } = runtimeFixture("host");
    const adapters = runtime.adapters;
    expect(adapters.length).toBeGreaterThan(0);
    const detached = Object.freeze({
      ...runtime,
      adapters: Object.freeze(
        adapters.map((adapter) => Object.freeze({ ...adapter, record: Object.freeze({ ...adapter.record }) })),
      ),
    }) as PreparedIrAsyncRuntime;
    expect(() => current(detached)).toThrow(/canonical catalog record/);
    expect(() => current(Object.freeze({ ...runtime, adapters: Object.freeze([] as const) }))).toThrow(
      /adapters; expected/,
    );
  });

  it("rolls back failed first registration, permits retry and preserves an existing association on failure", () => {
    const { input } = runtimeFixture();
    const plan = semanticPlan.createIrAsyncPlan(input.plan);
    const rejected = { ...input, plan };
    expect(() => attachment.createPreparedIrAsyncRuntime({ ...rejected, providers: Object.freeze([]) })).toThrow(
      /exact providers/,
    );
    const retryBuilder = new manifest.RuntimeManifestBuilder({ target: "standalone", backend: "wasmgc" });
    for (const intent of plan.runtimeIntents) retryBuilder.requestFeature(intent);
    const retryManifest = retryBuilder.freeze();
    const retryProviders = Object.freeze(
      retryManifest.providers.filter((provider) => plan.runtimeIntents.some((intent) => intent === provider.feature)),
    );
    expect(retryManifest).not.toBe(rejected.manifest);
    expect(retryManifest).toEqual(rejected.manifest);
    const valid = {
      ...rejected,
      manifest: retryManifest,
      providers: retryProviders,
      backendRequirements: manifest.projectRuntimeBackendRequirements(retryProviders),
    };
    const runtime = attachment.createPreparedIrAsyncRuntime(valid);
    const current = () => attachment.assertPreparedIrAsyncRuntimeCurrent(plan.ownerUnitId, "retry", plan, runtime);
    expect(current()).toBe(runtime);
    expect(runtime.manifest).toBe(retryManifest);
    expect(runtime.providers).toBe(retryProviders);
    expect(() =>
      attachment.assertPreparedIrAsyncRuntimeCurrent(
        plan.ownerUnitId,
        "rejected",
        plan,
        Object.freeze({ ...runtime, manifest: rejected.manifest }),
      ),
    ).toThrow(/authenticated frozen manifest/);
    expect(() => attachment.createPreparedIrAsyncRuntime({ ...valid, providers: Object.freeze([]) })).toThrow(
      /exact providers/,
    );
    expect(current()).toBe(runtime);
    expect(() =>
      attachment.createPreparedIrAsyncRuntime({ ...valid, manifest: Object.freeze({ ...valid.manifest }) }),
    ).toThrow(/already attached/);
    expect(current()).toBe(runtime);
  });

  it("freezes rewritten state bodies in place and preserves logical/layout identities", () => {
    const { plan, runtime, current } = runtimeFixture();
    const body: IrInstr[] = [
      { kind: "const", value: { kind: "f64", value: 1 }, result: asValueId(7), resultType: F64 },
    ];
    const typeRef = (ordinal: number): IrTypeRef => ({
      kind: "type",
      name: "layout-" + ordinal,
      binding: {
        kind: "support",
        bindingId: createIrBindingId({ ownerId: plan.ownerUnitId, domain: "type", role: "provider-layout", ordinal }),
      },
    });
    const layout = { carrierType: typeRef(0), dataType: typeRef(1), lengthFieldIndex: 0, dataFieldIndex: 1 };
    const logicalType: IrType = plan.values[0]!.type;
    const changed = { ...runtime, states: [{ ...runtime.states[0]!, body }], typeLayouts: [{ logicalType, layout }] };
    expect(() => current(changed)).toThrow(/mutable attachment/);
    const sealed = attachment.sealPreparedIrAsyncRuntimeContainers(changed);
    expect(sealed.states[0]!.body).toBe(body);
    expect(Object.isFrozen(body)).toBe(true);
    expect(Object.isFrozen(body[0])).toBe(true);
    expect(sealed.typeLayouts![0]!.logicalType).toBe(logicalType);
    expect(sealed.typeLayouts![0]!.layout).toBe(layout);
    expect(sealed.plan).toBe(plan);
    expect(sealed.providers).toBe(runtime.providers);
    expect(current(sealed)).toBe(sealed);
    expect(attachment.sealPreparedIrAsyncRuntimeContainers(sealed)).toBe(sealed);
  });
});
