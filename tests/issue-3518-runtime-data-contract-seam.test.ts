// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  captureGeneratorPredecessorPolicySource,
  beforeGeneratorInventoryPolicySource,
  captureHostCarrierPredecessorPolicySource,
  beforeHostCarrierInventoryPolicySource,
  captureDynamicCodePredecessorPolicySource,
  beforeDynamicCodeInventoryPolicySource,
  captureRuntimePreparationPredecessorPolicySource,
  beforeRuntimePreparationPolicySource,
} from "./helpers/ir-runtime-program-policy-evolution.js";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join as fixtureCaptureJoin } from "node:path";
import { fileURLToPath as fixtureCaptureFileURLToPath } from "node:url";
import {
  captureCanonical489dPredecessorPolicySource,
  captureCanonical3c6PredecessorPolicySource,
  captureCurrentMainInventoryPredecessorPolicySource,
  beforeCanonical3c6InventoryPolicySource,
  beforeCurrentMainInventoryPolicySource,
} from "./helpers/ir-runtime-program-policy-evolution.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import * as asyncSchema from "../src/runtime/contracts/async-provider-schema.js";
import * as hostSchema from "../src/runtime/contracts/host-capability-schema.js";
import * as policy from "../src/runtime/contracts/provider-policy.js";
import * as foundation from "../src/runtime/contracts/index.js";
import * as intrinsicSchema from "../src/ir/runtime/contracts/intrinsics.js";
import * as manifestSchema from "../src/ir/runtime/contracts/manifest.js";
import * as runtimeContracts from "../src/ir/runtime/index.js";
import type {
  CurrentPreparedIrAsyncRuntime,
  PreparedIrAsyncRuntime,
  PreparedIrAsyncRuntimeInput,
} from "../src/ir/runtime/contracts/prepared.js";
import * as oldAsync from "../src/ir/async-runtime-providers.js";
import * as oldIntrinsics from "../src/ir/intrinsics.js";
import * as oldManifest from "../src/ir/runtime-manifest.js";
import {
  asAsyncStateId,
  assertPreparedIrAsyncRuntimeCurrent,
  canonicalPromiseAbi,
  createIrAsyncPlan,
  createPreparedIrAsyncRuntime,
  sealPreparedIrAsyncRuntimeContainers,
  serializeIrAsyncPlan,
} from "../src/ir/async-plan.js";
import { asValueId, irVal } from "../src/ir/core/nodes.js";
import type { IrTypeRef, IrVecLayoutRef } from "../src/ir/core/types.js";
import { createIrBindingId } from "../src/shared/contracts/identity-values.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
import {
  acceptedHistoricalDeclarations,
  assertIntrinsicSpecialization,
  assertNamedForward,
  currentDeclarations,
  receiptRows,
} from "./helpers/ir-historical-runtime-reconstruction.js";

import { readRuntimeContractReceiptSource } from "./helpers/ir-runtime-contract-evolution.js";

import { beforeRuntimePreparationRelocation } from "./helpers/ir-runtime-preparation-relocation.js";

afterEach(async () => {
  // Yield between synchronous source proofs so Vitest can process task-update RPCs.
  await setImmediate();
});

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const historicalRead = (path: string) =>
  readRuntimeContractReceiptSource(path, beforeRuntimePreparationRelocation(read));
const hash = (rows: unknown) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");

// Measured from f95d8a0bf318e857d981863b1018a9d776483a46, source-qualified:
// the two distinct RuntimeFeature declarations must never share a name-only
// lookup. No historical Git object is needed when this suite runs.
// The parent-supplied host schema is mandatory; do not skip on this worker's
// deliberately uncomposed base. Full boundary and source replay gates are
// separately owned by the parent.

const movedReceipts = [
  {
    path: "src/runtime/contracts/async-provider-schema.ts",
    oldPath: "src/ir/async-runtime-providers.ts",
    names: [
      "ASYNC_HOST_CAPABILITY_IDS",
      "AsyncHostCapabilityId",
      "AsyncHostAdapterValueType",
      "ASYNC_CALLBACK_EXCEPTION_POLICY",
      "AsyncCallbackExceptionPolicy",
      "AsyncHostAdapter",
      "PreparedAsyncHostCapabilityId",
      "PreparedAsyncHostAdapter",
      "ASYNC_RUNTIME_PROVIDER_IDS",
      "AsyncRuntimeProviderId",
    ],
    types: 7,
    hash: "b7a151c5853157c9aa74a5f56b446ab30483cdfa9942b78f5964d795bb90afb3",
  },
  {
    path: "src/runtime/contracts/provider-policy.ts",
    oldPath: "src/ir/runtime-manifest.ts",
    names: [
      "RuntimeTarget",
      "RuntimeBackend",
      "NumberBoundaryPolicy",
      "NUMBER_BOUNDARY_POLICY_DISABLED",
      "BooleanBoundaryPolicy",
      "BOOLEAN_BOUNDARY_POLICY_DISABLED",
      "ExternIsUndefinedPolicy",
      "EXTERN_IS_UNDEFINED_POLICY_DISABLED",
      "GeneratorNumberBoxPolicy",
      "GENERATOR_NUMBER_BOX_POLICY_DISABLED",
      "StringComparePolicy",
      "STRING_COMPARE_POLICY_DISABLED",
      "StringEqPolicy",
      "STRING_EQ_POLICY_DISABLED",
      "StringLenPolicy",
      "STRING_LEN_POLICY_DISABLED",
      "StringConcatPolicy",
      "STRING_CONCAT_POLICY_DISABLED",
      "StringCharCodeAtPolicy",
      "STRING_CHAR_CODE_AT_POLICY_DISABLED",
      "StringConcatManyPolicy",
      "STRING_CONCAT_MANY_POLICY_DISABLED",
      "StringConstPolicy",
      "STRING_CONST_POLICY_DISABLED",
      "HostCallbackWrapPolicy",
      "HOST_CALLBACK_WRAP_POLICY_DISABLED",
      "FunctionPrototypeCallPolicy",
      "FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED",
      "RuntimeManifestPolicy",
      "FrozenRuntimeManifestPolicy",
    ],
    types: 17,
    hash: "427cef6e60b0e3328fc6ace4a66eabab7afa466ca917e389101f74b892f8c678",
  },
  {
    path: "src/ir/runtime/contracts/intrinsics.ts",
    oldPath: "src/ir/intrinsics.ts",
    names: [
      "PURE_MATH_RUNTIME_FEATURES",
      "NUMERIC_COERCION_RUNTIME_FEATURES",
      "NUMBER_BOUNDARY_RUNTIME_FEATURES",
      "BOOLEAN_BOUNDARY_RUNTIME_FEATURES",
      "EXTERN_BOUNDARY_RUNTIME_FEATURES",
      "INTRINSIC_RUNTIME_FEATURES",
      "PureMathRuntimeFeature",
      "NumericCoercionRuntimeFeature",
      "NumberBoundaryRuntimeFeature",
      "BooleanBoundaryRuntimeFeature",
      "ExternBoundaryRuntimeFeature",
      "RuntimeFeature",
      "PURE_MATH_HOST_CAPABILITIES",
      "HostCapability",
      "IntrinsicSignature",
      "IntrinsicSourceLocation",
      "IntrinsicUse",
      "IntrinsicDefinition",
      "IntrinsicVerificationCode",
      "IntrinsicVerificationFailure",
    ],
    types: 13,
    hash: "3e3c8fd145f03837dce98ce6b364fabddb88cc98bcc9281304a8a48da009b3f9",
  },
  {
    path: "src/ir/runtime/contracts/manifest.ts",
    oldPath: "src/ir/runtime-manifest.ts",
    names: [
      "RuntimeFeature",
      "HostCapabilityId",
      "RUNTIME_BACKEND_REQUIREMENTS",
      "RuntimeBackendRequirement",
      "PURE_MATH_RUNTIME_PROVIDER_IDS",
      "MathRuntimeProviderId",
      "NUMERIC_COERCION_RUNTIME_PROVIDER_IDS",
      "NumericCoercionRuntimeProviderId",
      "NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS",
      "NumberBoundaryRuntimeProviderId",
      "BOOLEAN_BOUNDARY_RUNTIME_PROVIDER_IDS",
      "BooleanBoundaryRuntimeProviderId",
      "EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS",
      "ExternBoundaryRuntimeProviderId",
      "GENERATOR_NUMBER_BOX_RUNTIME_FEATURES",
      "GeneratorNumberBoxRuntimeFeature",
      "GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS",
      "GeneratorNumberBoxRuntimeProviderId",
      "STRING_COMPARE_RUNTIME_FEATURES",
      "StringCompareRuntimeFeature",
      "STRING_COMPARE_RUNTIME_PROVIDER_IDS",
      "StringCompareRuntimeProviderId",
      "STRING_EQ_RUNTIME_FEATURES",
      "StringEqRuntimeFeature",
      "STRING_EQ_RUNTIME_PROVIDER_IDS",
      "StringEqRuntimeProviderId",
      "STRING_LEN_RUNTIME_FEATURES",
      "StringLenRuntimeFeature",
      "STRING_LEN_RUNTIME_PROVIDER_IDS",
      "StringLenRuntimeProviderId",
      "STRING_CONCAT_RUNTIME_FEATURES",
      "StringConcatRuntimeFeature",
      "STRING_CONCAT_RUNTIME_PROVIDER_IDS",
      "StringConcatRuntimeProviderId",
      "STRING_CHAR_CODE_AT_RUNTIME_FEATURES",
      "StringCharCodeAtRuntimeFeature",
      "STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS",
      "StringCharCodeAtRuntimeProviderId",
      "STRING_CONCAT_MANY_RUNTIME_FEATURES",
      "StringConcatManyRuntimeFeature",
      "STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS",
      "StringConcatManyRuntimeProviderId",
      "STRING_CONCAT_MANY_NATIVE_ARITY",
      "STRING_CONST_RUNTIME_FEATURES",
      "StringConstRuntimeFeature",
      "STRING_CONST_RUNTIME_PROVIDER_IDS",
      "StringConstRuntimeProviderId",
      "HOST_CALLBACK_WRAP_RUNTIME_FEATURES",
      "HostCallbackWrapRuntimeFeature",
      "HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS",
      "HostCallbackWrapRuntimeProviderId",
      "FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES",
      "FunctionPrototypeCallRuntimeFeature",
      "FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS",
      "FunctionPrototypeCallRuntimeProviderId",
      "REFERENCE_ERROR_RUNTIME_FEATURES",
      "ReferenceErrorRuntimeFeature",
      "REFERENCE_ERROR_RUNTIME_PROVIDER_IDS",
      "ReferenceErrorRuntimeProviderId",
      "RuntimeProviderId",
      "RuntimeProviderImplementation",
      "MathRuntimeProviderImplementation",
      "IntrinsicRuntimeProviderImplementation",
      "RuntimeProviderDefinition",
      "RuntimeProviderPlan",
      "RuntimeProviderComponent",
      "FrozenRuntimeManifest",
    ],
    types: 38,
    hash: "e7d1bd5d610126b6dcf945ca5584114b21a779b2803139c357f146cb7a16841e",
  },
  {
    path: "src/ir/runtime/contracts/prepared.ts",
    oldPath: "src/ir/async-plan.ts",
    names: [
      "PreparedIrFunction",
      "PreparedIrModule",
      "PreparedIrAsyncHostAdapter",
      "PreparedIrAsyncRuntimeBase",
      "PreparedIrAsyncRuntime",
      "CurrentPreparedIrAsyncRuntime",
      "PreparedIrAsyncRuntimeInput",
      "PreparedIrRuntimeManifest",
    ],
    types: 8,
    hash: "0481da5a024eb65b509ee9d5e6bbf6325e2ad273e741dcfd4aa713859f6525fa",
  },
] as const;

const retainedReceipts = [
  {
    path: "src/ir/async-runtime-providers.ts",
    declarations: 26,
    functions: 12,
    hash: "e6c4a6e91bf4878715ef9b508342a42f7bd692c7bb8ca32fb33568be13635045",
  },
  {
    path: "src/ir/runtime-manifest.ts",
    declarations: 85,
    functions: 38,
    hash: "3abe53cac71f94ed08ab1c9de8f44bfcc6ca0c254f7d6963bb50e8b572a6f478",
  },
  {
    path: "src/ir/intrinsics.ts",
    declarations: 24,
    functions: 5,
    hash: "eee3f92b352fb705c5addda7f396ce665c329ab53e501cfe1f6d7e0fbd93291f",
  },
  {
    path: "src/ir/async-plan.ts",
    declarations: 48,
    functions: 39,
    hash: "a7aada275dcd9af1111649c58a4fcce678cd018d6b458f431edcf9eb6e61ab77",
  },
  {
    path: "src/ir/intrinsic-support.ts",
    declarations: 41,
    functions: 24,
    hash: "eea4525b21f65d7334af27e6ee195dbbb7ca39b9dd57d5781345b80d60d2e8d7",
  },
] as const;

function parse(path: string, source = read(path)) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  expect((file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics).toEqual([]);
  return file;
}

function declarationName(node: ts.Statement): string | undefined {
  if (
    ts.isTypeAliasDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isFunctionDeclaration(node)
  )
    return node.name?.text;
  if (ts.isVariableStatement(node)) return node.declarationList.declarations[0]?.name.getText();
}

function declarationRows(file: ts.SourceFile, normalizePrepared = false) {
  return file.statements
    .filter((node) => declarationName(node))
    .map((node) => {
      const name = declarationName(node)!;
      let text = node.getText();
      if (normalizePrepared && name === "PreparedIrAsyncRuntimeInput") {
        // Explicitly approved module-only export for the retained implementation.
        expect(text.startsWith("export type ")).toBe(true);
        text = text.replace(/^export /, "");
      }
      if (normalizePrepared && name === "PreparedIrRuntimeManifest") {
        // The old IrFunction import already meant this exact prepared extension.
        expect(text).toContain("readonly functions: readonly PreparedIrFunction[];");
        text = text.replace("readonly PreparedIrFunction[]", "readonly IrFunction[]");
      }
      return [name, (node as ts.Statement & { jsDoc?: readonly ts.JSDoc[] }).jsDoc?.at(-1)?.getText() ?? "", text];
    });
}

const valueModules: Readonly<
  Record<
    string,
    {
      readonly canonical: Readonly<Record<string, unknown>>;
      readonly historical: Readonly<Record<string, unknown>>;
      readonly barrel: Readonly<Record<string, unknown>>;
    }
  >
> = {
  "src/runtime/contracts/async-provider-schema.ts": {
    canonical: asyncSchema,
    historical: oldAsync,
    barrel: foundation,
  },
  "src/runtime/contracts/provider-policy.ts": {
    canonical: policy,
    historical: oldManifest,
    barrel: foundation,
  },
  "src/ir/runtime/contracts/intrinsics.ts": {
    canonical: intrinsicSchema,
    historical: oldIntrinsics,
    barrel: runtimeContracts,
  },
  "src/ir/runtime/contracts/manifest.ts": {
    canonical: manifestSchema,
    historical: oldManifest,
    barrel: runtimeContracts,
  },
};
const valueCases = movedReceipts.flatMap((receipt) =>
  receipt.names.filter((name) => name === name.toUpperCase()).map((name) => ({ path: receipt.path, name })),
);

const identities = createTestIrFunctionIdentityFactory("runtime-data-contract-seam");
function authenticatedFixture() {
  const identity = identities.next("resolveNumber"),
    value = asValueId(0),
    f64 = irVal({ kind: "f64" });
  const plan = createIrAsyncPlan({
    schemaVersion: 1,
    ownerUnitId: identity.unitId,
    kind: "async-function",
    abi: canonicalPromiseAbi(f64),
    entry: asAsyncStateId(0),
    params: [{ value, type: f64 }],
    values: [{ value, type: f64 }],
    spills: [],
    handlers: [],
    states: [{ id: asAsyncStateId(0), body: [], terminator: { kind: "resolve", value } }],
    runtimeIntents: oldAsync.ASYNC_RUNTIME_FEATURES,
  });
  const builder = new oldManifest.RuntimeManifestBuilder({ target: "standalone", backend: "wasmgc" });
  for (const feature of plan.runtimeIntents) builder.requestFeature(feature);
  const manifest = builder.freeze();
  const providers = Object.freeze(
    manifest.providers.filter((provider) => plan.runtimeIntents.some((intent) => intent === provider.feature)),
  );
  const input: PreparedIrAsyncRuntimeInput = {
    kind: "standalone-native-wasmgc",
    plan,
    manifest,
    providers,
    backendRequirements: oldManifest.projectRuntimeBackendRequirements(providers),
    states: plan.states,
    adapters: Object.freeze([] as const),
  };
  const runtime: CurrentPreparedIrAsyncRuntime = createPreparedIrAsyncRuntime(input);
  const current = (attachment: PreparedIrAsyncRuntime = runtime) =>
    assertPreparedIrAsyncRuntimeCurrent(identity.unitId, identity.name, plan, attachment);
  return { identity, plan, manifest, providers, input, runtime, current };
}

describe("#3518 canonical runtime data-contract seam", () => {
  it.each(movedReceipts)("checks historical $path receipt after checked extension reconstruction", (receipt) => {
    const reconstructed =
      receipt.path === "src/ir/runtime/contracts/intrinsics.ts" ||
      receipt.path === "src/ir/runtime/contracts/manifest.ts"
        ? acceptedHistoricalDeclarations(receipt.path, historicalRead)
        : undefined;
    const file = reconstructed
        ? parse(receipt.path, reconstructed.map((row) => (row.doc ? row.doc + "\n" : "") + row.text).join("\n\n"))
        : parse(receipt.path, historicalRead(receipt.path)),
      rows = declarationRows(file, receipt.path.endsWith("/prepared.ts"));
    expect(rows.map(([name]) => name)).toEqual(receipt.names);
    expect(
      file.statements.filter((node) => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)),
    ).toHaveLength(receipt.types);
    expect(hash(rows)).toBe(receipt.hash);
    expect(file.statements.filter(ts.isFunctionDeclaration)).toHaveLength(0);
    // Real-row positive controls: removal, rename, text/field changes and
    // documentation changes all break the measured declaration receipt.
    expect(rows.length).toBeGreaterThan(0);
    expect(hash(rows.slice(1))).not.toBe(receipt.hash);
    expect(hash(rows.map((row, index) => (index ? row : ["renamed", ...row.slice(1)])))).not.toBe(receipt.hash);
    expect(hash(rows.map((row, index) => (index ? row : [row[0], row[1], row[2] + "\nchanged"])))).not.toBe(
      receipt.hash,
    );
    expect(hash(rows.map((row, index) => (index ? row : [row[0], row[1] + "\nchanged", row[2]])))).not.toBe(
      receipt.hash,
    );
  });

  it.each(retainedReceipts)(
    "checks historical retained $path receipt after checked extension reconstruction",
    (receipt) => {
      const records = acceptedHistoricalDeclarations(receipt.path, historicalRead),
        rows = receiptRows(records);
      expect(rows).toHaveLength(receipt.declarations);
      expect(records.filter((record) => ts.isFunctionDeclaration(record.node))).toHaveLength(receipt.functions);
      expect(hash(rows)).toBe(receipt.hash);
      expect(hash(rows.slice(1))).not.toBe(receipt.hash);
      expect(read(receipt.path).match(/Copyright \(c\) 2026 Loopdive/g)).toHaveLength(1);
    },
  );

  it("keeps the complete moved/retained denominators and the one currentness authority", () => {
    expect(movedReceipts.reduce((count, receipt) => count + receipt.names.length, 0)).toBe(135);
    expect(retainedReceipts.reduce((count, receipt) => count + receipt.declarations, 0)).toBe(224);
    expect(retainedReceipts.reduce((count, receipt) => count + receipt.functions, 0)).toBe(118);
    expect(valueCases).toHaveLength(52);
    const old = parse("src/ir/async-plan.ts");
    const historical = acceptedHistoricalDeclarations("src/ir/async-plan.ts", historicalRead);
    expect(historical.filter((row) => ts.isFunctionDeclaration(row.node))).toHaveLength(39);
    const authority = currentDeclarations("src/ir/runtime/async-attachment.ts", read);
    expect(authority.filter((row) => row.name === "preparedManifestByPlan")).toHaveLength(1);
    expect(read("src/ir/runtime/async-attachment.ts").match(/new WeakMap/g)).toHaveLength(1);
    for (const path of ["src/ir/async-plan.ts", "src/ir/analysis/async-plan.ts"]) {
      expect(read(path)).not.toContain("new WeakMap");
      expect(declarationRows(parse(path)).some(([name]) => name === "preparedManifestByPlan")).toBe(false);
    }
    expect(read("src/ir/analysis/async-plan.ts").match(/Backend-neutral async suspension plan\./g)).toHaveLength(1);
    expect(read("src/ir/runtime/manifest.ts").match(/Deterministic R6 semantic-runtime manifest/g)).toHaveLength(1);
    for (const receipt of movedReceipts) {
      expect(read(receipt.path)).not.toContain("new WeakMap");
    }
    const prepared = parse("src/ir/runtime/contracts/prepared.ts");
    const base = prepared.statements.find((node) => declarationName(node) === "PreparedIrAsyncRuntimeBase");
    expect(base && ts.isInterfaceDeclaration(base)).toBe(true);
    if (!base || !ts.isInterfaceDeclaration(base)) throw Error("missing private base");
    expect(base.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false).toBe(false);
    const legacyExports = old.statements
      .filter(ts.isExportDeclaration)
      .flatMap((node) =>
        node.exportClause && ts.isNamedExports(node.exportClause)
          ? node.exportClause.elements.map((entry) => entry.name.text)
          : [],
      );
    expect(legacyExports).not.toContain("PreparedIrAsyncRuntimeInput");
    expect(read("src/ir/runtime/index.ts")).not.toContain("PreparedIrAsyncRuntimeInput");
  });

  it.each(movedReceipts)("forwards each $path name only from its exact defining owner", (receipt) => {
    for (const name of receipt.names) {
      if (name === "PreparedIrAsyncRuntimeBase" || name === "PreparedIrAsyncRuntimeInput") continue;
      const oldPath = name === "PreparedIrRuntimeManifest" ? "src/ir/intrinsic-support.ts" : receipt.oldPath;
      const chain = [oldPath];
      if (oldPath === "src/ir/async-runtime-providers.ts") chain.push("src/ir/runtime/async-providers.ts");
      if (oldPath === "src/ir/runtime-manifest.ts") chain.push("src/ir/runtime/manifest.ts");
      chain.push(receipt.path);
      if (
        [
          "IntrinsicSignature",
          "IntrinsicSourceLocation",
          "IntrinsicUse",
          "IntrinsicVerificationCode",
          "IntrinsicVerificationFailure",
        ].includes(name)
      )
        chain.push("src/ir/core/intrinsic-contracts.ts");
      for (let hop = 0; hop < chain.length - 1; hop++)
        assertNamedForward(chain[hop]!, chain[hop + 1]!, name, name !== name.toUpperCase(), read);
      if (name === "IntrinsicDefinition") assertIntrinsicSpecialization(read);
    }
  });

  it.each(valueCases)("retains the same old/canonical/barrel $name object", ({ path, name }) => {
    const modules = valueModules[path];
    if (!modules) throw Error("missing value module " + path);
    const canonical = modules.canonical[name];
    expect(canonical).toBeDefined();
    expect(modules.historical[name]).toBe(canonical);
    expect(modules.barrel[name]).toBe(canonical);
    expect(Object.isFrozen(canonical)).toBe(true);
  });

  it("reuses the canonical callback policy and exact capability/provider catalogs", () => {
    expect(asyncSchema.ASYNC_CALLBACK_EXCEPTION_POLICY).toBe(hostSchema.HOST_CALLBACK_EXCEPTION_POLICY);
    expect(foundation.HOST_CALLBACK_EXCEPTION_POLICY).toBe(hostSchema.HOST_CALLBACK_EXCEPTION_POLICY);
    expect(oldAsync.ASYNC_HOST_CAPABILITY_RECORDS.map((record) => record.capability)).toEqual([
      ...asyncSchema.ASYNC_HOST_CAPABILITY_IDS,
    ]);
    for (const record of oldAsync.ASYNC_HOST_CAPABILITY_RECORDS) {
      expect(oldAsync.resolveAsyncHostCapabilityRecord(oldAsync.ASYNC_HOST_CAPABILITY_RECORDS, record.capability)).toBe(
        record,
      );
    }
    expect(new Set(oldAsync.ASYNC_RUNTIME_PROVIDERS.map((provider) => provider.id))).toEqual(
      new Set(asyncSchema.ASYNC_RUNTIME_PROVIDER_IDS),
    );
    expect(intrinsicSchema.PURE_MATH_RUNTIME_FEATURES).not.toBe(manifestSchema.PURE_MATH_RUNTIME_PROVIDER_IDS);
    expect(manifestSchema.STRING_CONCAT_MANY_NATIVE_ARITY).toEqual({ min: 3, max: 8 });
  });

  it("keeps both barrels explicit and contract-only", () => {
    for (const path of ["src/runtime/contracts/index.ts", "src/ir/runtime/index.ts"]) {
      const file = parse(path);
      expect(file.statements.length).toBeGreaterThan(0);
      for (const node of file.statements) {
        expect(ts.isExportDeclaration(node)).toBe(true);
        if (!ts.isExportDeclaration(node)) throw Error("barrel contains implementation");
        expect(node.exportClause && ts.isNamedExports(node.exportClause)).toBe(true);
        expect(node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)).toBe(true);
        if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) throw Error("missing barrel target");
        expect(node.moduleSpecifier.text.startsWith("./")).toBe(true);
        expect(node.moduleSpecifier.text).not.toMatch(/\.\.\/|async-plan|runtime-manifest|intrinsic-support/);
      }
    }
    expect(Object.keys(runtimeContracts).sort()).toEqual(
      valueCases
        .filter((entry) => entry.path.startsWith("src/ir/"))
        .map((entry) => entry.name)
        .sort(),
    );
    const foundationNames = [
      ...Object.keys(hostSchema),
      ...valueCases.filter((entry) => entry.path.startsWith("src/runtime/")).map((entry) => entry.name),
    ].sort();
    expect(Object.keys(foundation).sort()).toEqual(foundationNames);
    for (const receipt of movedReceipts) {
      const file = parse(receipt.path);
      for (const node of file.statements.filter(ts.isImportDeclaration)) {
        const module = node.moduleSpecifier;
        if (!ts.isStringLiteral(module)) throw Error("nonliteral static import");
        expect(module.text).not.toMatch(
          /async-runtime-providers|runtime-host-capabilities|runtime-manifest|intrinsic-support|program|codegen/,
        );
      }
    }
  });

  it("preserves standalone authentication, exact provider order and seal identity", () => {
    const { plan, manifest, providers, runtime, current } = authenticatedFixture();
    expect(providers).toHaveLength(7);
    expect(providers.every((provider) => manifest.providers.includes(provider))).toBe(true);
    expect(runtime.providers).toBe(providers);
    expect(runtime.plan).toBe(plan);
    expect(runtime.manifest).toBe(manifest);
    expect(current()).toBe(runtime);
    expect(sealPreparedIrAsyncRuntimeContainers(runtime)).toBe(runtime);
    expect(runtime.kind).toBe("standalone-native-wasmgc");
    expect(runtime.adapters).toEqual([]);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(manifest)).toBe(true);
    const serialized = serializeIrAsyncPlan(plan);
    expect(serializeIrAsyncPlan(plan)).toBe(serialized);
  });

  it("rejects a copied manifest or semantic plan instead of granting shape-based authority", () => {
    const { identity, plan, manifest, runtime, current } = authenticatedFixture();
    expect(() => current(Object.freeze({ ...runtime, manifest: Object.freeze({ ...manifest }) }))).toThrow(
      /authenticated frozen manifest/,
    );
    const copiedPlan = createIrAsyncPlan(plan);
    expect(copiedPlan).not.toBe(plan);
    expect(serializeIrAsyncPlan(copiedPlan)).toBe(serializeIrAsyncPlan(plan));
    expect(() =>
      assertPreparedIrAsyncRuntimeCurrent(
        identity.unitId,
        identity.name,
        copiedPlan,
        Object.freeze({ ...runtime, plan: copiedPlan }),
      ),
    ).toThrow(/authenticated frozen manifest/);
  });

  it("rejects copied/reordered providers and mutable layouts while retaining logical-type identity when sealed", () => {
    const { plan, runtime, current } = authenticatedFixture();
    const copiedProviders = Object.freeze(runtime.providers.map((provider) => Object.freeze({ ...provider })));
    expect(() => current(Object.freeze({ ...runtime, providers: copiedProviders }))).toThrow(/exact providers/);
    expect(() =>
      current(Object.freeze({ ...runtime, providers: Object.freeze([...runtime.providers].reverse()) })),
    ).toThrow(/exact providers/);
    // A copy-on-write envelope is not itself authority. The original plan /
    // manifest / provider joins remain the validator's source of truth.
    const logicalType = plan.values[0]!.type;
    const typeRef = (ordinal: number): IrTypeRef => ({
      kind: "type",
      name: "layout-" + ordinal,
      binding: {
        kind: "support",
        bindingId: createIrBindingId({
          ownerId: plan.ownerUnitId,
          domain: "type",
          role: "runtime-contract-layout",
          ordinal,
        }),
      },
    });
    const layout: IrVecLayoutRef = {
      carrierType: typeRef(0),
      dataType: typeRef(1),
      lengthFieldIndex: 0,
      dataFieldIndex: 1,
    };
    const updated = { ...runtime, typeLayouts: [{ logicalType, layout }] };
    expect(() => current(updated)).toThrow(/mutable attachment/);
    const sealed = sealPreparedIrAsyncRuntimeContainers(updated);
    expect(sealed.typeLayouts?.[0]?.logicalType).toBe(logicalType);
    expect(sealed.typeLayouts?.[0]?.layout).toBe(layout);
    expect(current(sealed)).toBe(sealed);
    expect(sealPreparedIrAsyncRuntimeContainers(sealed)).toBe(sealed);
  });

  it("retains failed-authentication rollback without publishing a second authority", () => {
    const { input } = authenticatedFixture();
    const plan = createIrAsyncPlan(input.plan);
    const valid: PreparedIrAsyncRuntimeInput = { ...input, plan };
    expect(() => createPreparedIrAsyncRuntime({ ...valid, providers: Object.freeze([]) })).toThrow(/exact providers/);
    const runtime = createPreparedIrAsyncRuntime(valid);
    expect(assertPreparedIrAsyncRuntimeCurrent(plan.ownerUnitId, "rollback", plan, runtime)).toBe(runtime);
    expect(() => createPreparedIrAsyncRuntime({ ...valid, manifest: Object.freeze({ ...valid.manifest }) })).toThrow(
      /already attached to another frozen manifest/,
    );
  });
});

describe("#3518 compiled runtime data joins", () => {
  it("resolves all 81 public old/new types, canonical joins and eleven negative controls", () => {
    const filename = resolve(root, ".tmp/runtime-data-type-contract.ts");
    const source = [
      "import type * as Prepared from '../src/ir/runtime/contracts/prepared.js';",
      "import type * as Runtime from '../src/ir/runtime/index.js';",
      "import type * as Core from '../src/ir/core/nodes.js';",
      "import type * as CoreTypes from '../src/ir/core/types.js';",
      "import type * as OldPrepared from '../src/ir/async-plan.js';",
      "import type * as OldSupport from '../src/ir/intrinsic-support.js';",
      "import type * as Host from '../src/runtime/contracts/host-capability-schema.js';",
      "import type * as Foundation from '../src/runtime/contracts/index.js';",
      "type Equal<A,B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
      "type Check<T extends true> = T;",
      "import type * as Old0 from '../src/ir/async-runtime-providers.js';",
      "import type * as New0 from '../src/runtime/contracts/async-provider-schema.js';",
      "type Match0_AsyncHostCapabilityId = Check<Equal<Old0.AsyncHostCapabilityId, New0.AsyncHostCapabilityId>>;",
      "type Match0_AsyncHostAdapterValueType = Check<Equal<Old0.AsyncHostAdapterValueType, New0.AsyncHostAdapterValueType>>;",
      "type Match0_AsyncCallbackExceptionPolicy = Check<Equal<Old0.AsyncCallbackExceptionPolicy, New0.AsyncCallbackExceptionPolicy>>;",
      "type Match0_AsyncHostAdapter = Check<Equal<Old0.AsyncHostAdapter, New0.AsyncHostAdapter>>;",
      "type Match0_PreparedAsyncHostCapabilityId = Check<Equal<Old0.PreparedAsyncHostCapabilityId, New0.PreparedAsyncHostCapabilityId>>;",
      "type Match0_PreparedAsyncHostAdapter = Check<Equal<Old0.PreparedAsyncHostAdapter, New0.PreparedAsyncHostAdapter>>;",
      "type Match0_AsyncRuntimeProviderId = Check<Equal<Old0.AsyncRuntimeProviderId, New0.AsyncRuntimeProviderId>>;",
      "import type * as Old1 from '../src/ir/runtime-manifest.js';",
      "import type * as New1 from '../src/runtime/contracts/provider-policy.js';",
      "type Match1_RuntimeTarget = Check<Equal<Old1.RuntimeTarget, New1.RuntimeTarget>>;",
      "type Match1_RuntimeBackend = Check<Equal<Old1.RuntimeBackend, New1.RuntimeBackend>>;",
      "type Match1_NumberBoundaryPolicy = Check<Equal<Old1.NumberBoundaryPolicy, New1.NumberBoundaryPolicy>>;",
      "type Match1_BooleanBoundaryPolicy = Check<Equal<Old1.BooleanBoundaryPolicy, New1.BooleanBoundaryPolicy>>;",
      "type Match1_ExternIsUndefinedPolicy = Check<Equal<Old1.ExternIsUndefinedPolicy, New1.ExternIsUndefinedPolicy>>;",
      "type Match1_GeneratorNumberBoxPolicy = Check<Equal<Old1.GeneratorNumberBoxPolicy, New1.GeneratorNumberBoxPolicy>>;",
      "type Match1_StringComparePolicy = Check<Equal<Old1.StringComparePolicy, New1.StringComparePolicy>>;",
      "type Match1_StringEqPolicy = Check<Equal<Old1.StringEqPolicy, New1.StringEqPolicy>>;",
      "type Match1_StringLenPolicy = Check<Equal<Old1.StringLenPolicy, New1.StringLenPolicy>>;",
      "type Match1_StringConcatPolicy = Check<Equal<Old1.StringConcatPolicy, New1.StringConcatPolicy>>;",
      "type Match1_StringCharCodeAtPolicy = Check<Equal<Old1.StringCharCodeAtPolicy, New1.StringCharCodeAtPolicy>>;",
      "type Match1_StringConcatManyPolicy = Check<Equal<Old1.StringConcatManyPolicy, New1.StringConcatManyPolicy>>;",
      "type Match1_StringConstPolicy = Check<Equal<Old1.StringConstPolicy, New1.StringConstPolicy>>;",
      "type Match1_HostCallbackWrapPolicy = Check<Equal<Old1.HostCallbackWrapPolicy, New1.HostCallbackWrapPolicy>>;",
      "type Match1_FunctionPrototypeCallPolicy = Check<Equal<Old1.FunctionPrototypeCallPolicy, New1.FunctionPrototypeCallPolicy>>;",
      "type Match1_RuntimeManifestPolicy = Check<Equal<Old1.RuntimeManifestPolicy, New1.RuntimeManifestPolicy>>;",
      "type Match1_FrozenRuntimeManifestPolicy = Check<Equal<Old1.FrozenRuntimeManifestPolicy, New1.FrozenRuntimeManifestPolicy>>;",
      "import type * as Old2 from '../src/ir/intrinsics.js';",
      "import type * as New2 from '../src/ir/runtime/contracts/intrinsics.js';",
      "type Match2_PureMathRuntimeFeature = Check<Equal<Old2.PureMathRuntimeFeature, New2.PureMathRuntimeFeature>>;",
      "type Match2_NumericCoercionRuntimeFeature = Check<Equal<Old2.NumericCoercionRuntimeFeature, New2.NumericCoercionRuntimeFeature>>;",
      "type Match2_NumberBoundaryRuntimeFeature = Check<Equal<Old2.NumberBoundaryRuntimeFeature, New2.NumberBoundaryRuntimeFeature>>;",
      "type Match2_BooleanBoundaryRuntimeFeature = Check<Equal<Old2.BooleanBoundaryRuntimeFeature, New2.BooleanBoundaryRuntimeFeature>>;",
      "type Match2_ExternBoundaryRuntimeFeature = Check<Equal<Old2.ExternBoundaryRuntimeFeature, New2.ExternBoundaryRuntimeFeature>>;",
      "type Match2_RuntimeFeature = Check<Equal<Old2.RuntimeFeature, New2.RuntimeFeature>>;",
      "type Match2_HostCapability = Check<Equal<Old2.HostCapability, New2.HostCapability>>;",
      "type Match2_IntrinsicSignature = Check<Equal<Old2.IntrinsicSignature, New2.IntrinsicSignature>>;",
      "type Match2_IntrinsicSourceLocation = Check<Equal<Old2.IntrinsicSourceLocation, New2.IntrinsicSourceLocation>>;",
      "type Match2_IntrinsicUse = Check<Equal<Old2.IntrinsicUse, New2.IntrinsicUse>>;",
      "type Match2_IntrinsicDefinition = Check<Equal<Old2.IntrinsicDefinition, New2.IntrinsicDefinition>>;",
      "type Match2_IntrinsicVerificationCode = Check<Equal<Old2.IntrinsicVerificationCode, New2.IntrinsicVerificationCode>>;",
      "type Match2_IntrinsicVerificationFailure = Check<Equal<Old2.IntrinsicVerificationFailure, New2.IntrinsicVerificationFailure>>;",
      "import type * as Old3 from '../src/ir/runtime-manifest.js';",
      "import type * as New3 from '../src/ir/runtime/contracts/manifest.js';",
      "type Match3_RuntimeFeature = Check<Equal<Old3.RuntimeFeature, New3.RuntimeFeature>>;",
      "type Match3_HostCapabilityId = Check<Equal<Old3.HostCapabilityId, New3.HostCapabilityId>>;",
      "type Match3_RuntimeBackendRequirement = Check<Equal<Old3.RuntimeBackendRequirement, New3.RuntimeBackendRequirement>>;",
      "type Match3_MathRuntimeProviderId = Check<Equal<Old3.MathRuntimeProviderId, New3.MathRuntimeProviderId>>;",
      "type Match3_NumericCoercionRuntimeProviderId = Check<Equal<Old3.NumericCoercionRuntimeProviderId, New3.NumericCoercionRuntimeProviderId>>;",
      "type Match3_NumberBoundaryRuntimeProviderId = Check<Equal<Old3.NumberBoundaryRuntimeProviderId, New3.NumberBoundaryRuntimeProviderId>>;",
      "type Match3_BooleanBoundaryRuntimeProviderId = Check<Equal<Old3.BooleanBoundaryRuntimeProviderId, New3.BooleanBoundaryRuntimeProviderId>>;",
      "type Match3_ExternBoundaryRuntimeProviderId = Check<Equal<Old3.ExternBoundaryRuntimeProviderId, New3.ExternBoundaryRuntimeProviderId>>;",
      "type Match3_GeneratorNumberBoxRuntimeFeature = Check<Equal<Old3.GeneratorNumberBoxRuntimeFeature, New3.GeneratorNumberBoxRuntimeFeature>>;",
      "type Match3_GeneratorNumberBoxRuntimeProviderId = Check<Equal<Old3.GeneratorNumberBoxRuntimeProviderId, New3.GeneratorNumberBoxRuntimeProviderId>>;",
      "type Match3_StringCompareRuntimeFeature = Check<Equal<Old3.StringCompareRuntimeFeature, New3.StringCompareRuntimeFeature>>;",
      "type Match3_StringCompareRuntimeProviderId = Check<Equal<Old3.StringCompareRuntimeProviderId, New3.StringCompareRuntimeProviderId>>;",
      "type Match3_StringEqRuntimeFeature = Check<Equal<Old3.StringEqRuntimeFeature, New3.StringEqRuntimeFeature>>;",
      "type Match3_StringEqRuntimeProviderId = Check<Equal<Old3.StringEqRuntimeProviderId, New3.StringEqRuntimeProviderId>>;",
      "type Match3_StringLenRuntimeFeature = Check<Equal<Old3.StringLenRuntimeFeature, New3.StringLenRuntimeFeature>>;",
      "type Match3_StringLenRuntimeProviderId = Check<Equal<Old3.StringLenRuntimeProviderId, New3.StringLenRuntimeProviderId>>;",
      "type Match3_StringConcatRuntimeFeature = Check<Equal<Old3.StringConcatRuntimeFeature, New3.StringConcatRuntimeFeature>>;",
      "type Match3_StringConcatRuntimeProviderId = Check<Equal<Old3.StringConcatRuntimeProviderId, New3.StringConcatRuntimeProviderId>>;",
      "type Match3_StringCharCodeAtRuntimeFeature = Check<Equal<Old3.StringCharCodeAtRuntimeFeature, New3.StringCharCodeAtRuntimeFeature>>;",
      "type Match3_StringCharCodeAtRuntimeProviderId = Check<Equal<Old3.StringCharCodeAtRuntimeProviderId, New3.StringCharCodeAtRuntimeProviderId>>;",
      "type Match3_StringConcatManyRuntimeFeature = Check<Equal<Old3.StringConcatManyRuntimeFeature, New3.StringConcatManyRuntimeFeature>>;",
      "type Match3_StringConcatManyRuntimeProviderId = Check<Equal<Old3.StringConcatManyRuntimeProviderId, New3.StringConcatManyRuntimeProviderId>>;",
      "type Match3_StringConstRuntimeFeature = Check<Equal<Old3.StringConstRuntimeFeature, New3.StringConstRuntimeFeature>>;",
      "type Match3_StringConstRuntimeProviderId = Check<Equal<Old3.StringConstRuntimeProviderId, New3.StringConstRuntimeProviderId>>;",
      "type Match3_HostCallbackWrapRuntimeFeature = Check<Equal<Old3.HostCallbackWrapRuntimeFeature, New3.HostCallbackWrapRuntimeFeature>>;",
      "type Match3_HostCallbackWrapRuntimeProviderId = Check<Equal<Old3.HostCallbackWrapRuntimeProviderId, New3.HostCallbackWrapRuntimeProviderId>>;",
      "type Match3_FunctionPrototypeCallRuntimeFeature = Check<Equal<Old3.FunctionPrototypeCallRuntimeFeature, New3.FunctionPrototypeCallRuntimeFeature>>;",
      "type Match3_FunctionPrototypeCallRuntimeProviderId = Check<Equal<Old3.FunctionPrototypeCallRuntimeProviderId, New3.FunctionPrototypeCallRuntimeProviderId>>;",
      "type Match3_ReferenceErrorRuntimeFeature = Check<Equal<Old3.ReferenceErrorRuntimeFeature, New3.ReferenceErrorRuntimeFeature>>;",
      "type Match3_ReferenceErrorRuntimeProviderId = Check<Equal<Old3.ReferenceErrorRuntimeProviderId, New3.ReferenceErrorRuntimeProviderId>>;",
      "type Match3_RuntimeProviderId = Check<Equal<Old3.RuntimeProviderId, New3.RuntimeProviderId>>;",
      "type Match3_RuntimeProviderImplementation = Check<Equal<Old3.RuntimeProviderImplementation, New3.RuntimeProviderImplementation>>;",
      "type Match3_MathRuntimeProviderImplementation = Check<Equal<Old3.MathRuntimeProviderImplementation, New3.MathRuntimeProviderImplementation>>;",
      "type Match3_IntrinsicRuntimeProviderImplementation = Check<Equal<Old3.IntrinsicRuntimeProviderImplementation, New3.IntrinsicRuntimeProviderImplementation>>;",
      "type Match3_RuntimeProviderDefinition = Check<Equal<Old3.RuntimeProviderDefinition, New3.RuntimeProviderDefinition>>;",
      "type Match3_RuntimeProviderPlan = Check<Equal<Old3.RuntimeProviderPlan, New3.RuntimeProviderPlan>>;",
      "type Match3_RuntimeProviderComponent = Check<Equal<Old3.RuntimeProviderComponent, New3.RuntimeProviderComponent>>;",
      "type Match3_FrozenRuntimeManifest = Check<Equal<Old3.FrozenRuntimeManifest, New3.FrozenRuntimeManifest>>;",
      "import type * as Old4 from '../src/ir/async-plan.js';",
      "import type * as New4 from '../src/ir/runtime/contracts/prepared.js';",
      "type Match4_PreparedIrFunction = Check<Equal<Old4.PreparedIrFunction, New4.PreparedIrFunction>>;",
      "type Match4_PreparedIrModule = Check<Equal<Old4.PreparedIrModule, New4.PreparedIrModule>>;",
      "type Match4_PreparedIrAsyncHostAdapter = Check<Equal<Old4.PreparedIrAsyncHostAdapter, New4.PreparedIrAsyncHostAdapter>>;",
      "type Match4_PreparedIrAsyncRuntime = Check<Equal<Old4.PreparedIrAsyncRuntime, New4.PreparedIrAsyncRuntime>>;",
      "type Match4_CurrentPreparedIrAsyncRuntime = Check<Equal<Old4.CurrentPreparedIrAsyncRuntime, New4.CurrentPreparedIrAsyncRuntime>>;",
      "type Match4_PreparedIrRuntimeManifest = Check<Equal<OldSupport.PreparedIrRuntimeManifest, New4.PreparedIrRuntimeManifest>>;",
      "type PreparedFunctions = Check<Equal<Prepared.PreparedIrRuntimeManifest['functions'][number], Prepared.PreparedIrFunction>>;",
      "type PreparedModuleFunctions = Check<Equal<Prepared.PreparedIrModule['functions'][number], Prepared.PreparedIrFunction>>;",
      "type CoreModuleFunctions = Check<Equal<Core.IrModule['functions'][number], Core.IrFunction>>;",
      "type Attachment = Check<Equal<Prepared.PreparedIrFunction['asyncRuntime'], Prepared.PreparedIrAsyncRuntime | undefined>>;",
      "type LayoutIdentity = Check<Equal<NonNullable<Prepared.PreparedIrAsyncRuntime['typeLayouts']>[number]['logicalType'], CoreTypes.IrType>>;",
      "type RuntimeBarrel = Check<Equal<Runtime.PreparedIrRuntimeManifest, Prepared.PreparedIrRuntimeManifest>>;",
      "type IntrinsicFeatureAlias = Check<Equal<Runtime.IntrinsicRuntimeFeature, New2.RuntimeFeature>>;",
      "type CompleteFeatureAlias = Check<Equal<Runtime.RuntimeFeature, New3.RuntimeFeature>>;",
      "type FoundationPolicy = Check<Equal<Foundation.RuntimeManifestPolicy, New1.RuntimeManifestPolicy>>;",
      "type NarrowAsync = Check<Equal<New0.AsyncHostAdapterValueType, 'externref' | 'i32'>>;",
      "type EmptyMathCapabilities = Check<Equal<New2.HostCapability, never>>;",
      "type HostNeverGlobal = Check<Equal<Extract<Host.RuntimeHostCapabilityRecord<'number.box'>, {kind:'global'}>['capability'], never>>;",
      "type NativeAdapters = Check<Equal<Extract<Prepared.PreparedIrAsyncRuntime, {kind:'standalone-native-wasmgc'}>['adapters'], readonly []>>;",
      "declare const fn: Prepared.PreparedIrFunction;",
      "declare const manifest: New3.FrozenRuntimeManifest;",
      "declare const signature: New2.IntrinsicSignature;",
      "declare const input: Prepared.PreparedIrAsyncRuntimeInput;",
      "const optional: Prepared.PreparedIrFunction = {} as Core.IrFunction;",
      "const semantic: Core.IrFunction = fn;",
      "const maybeSignature: New2.IntrinsicSignature | undefined = ({} as New3.RuntimeProviderDefinition).signature;",
      "const currentPlan = input.plan;",
      "// @ts-expect-error semantic core cannot acquire a prepared attachment",
      "semantic.asyncRuntime;",
      "// @ts-expect-error historical API must not expose the formerly private input helper",
      "type HistoricalInputLeak = OldPrepared.PreparedIrAsyncRuntimeInput;",
      "// @ts-expect-error the private runtime base stays private",
      "type BaseLeak = Prepared.PreparedIrAsyncRuntimeBase;",
      "// @ts-expect-error input helper is not part of the contract barrel API",
      "type BarrelInputLeak = Runtime.PreparedIrAsyncRuntimeInput;",
      "// @ts-expect-error async projection cannot widen to f64",
      "const widened: New0.AsyncHostAdapterValueType = 'f64';",
      "// @ts-expect-error frozen provider population remains readonly",
      "manifest.providers.push({} as New3.RuntimeProviderDefinition);",
      "// @ts-expect-error signature result remains readonly",
      "signature.result = {} as CoreTypes.IrType;",
      "// @ts-expect-error signature params remain readonly",
      "signature.params.push({} as CoreTypes.IrType);",
      "// @ts-expect-error a function capability cannot occupy the global provider arm",
      "const badGlobal: New3.RuntimeProviderImplementation = {kind:'host-global', capability:'number.box'};",
      "// @ts-expect-error native runtime cannot acquire host adapters",
      "const badNative: Prepared.PreparedIrAsyncRuntime = {kind:'standalone-native-wasmgc', states:[], adapters:[{} as Prepared.PreparedIrAsyncHostAdapter]};",
      "// @ts-expect-error symbolic callable brands cannot become plain strings",
      "const badTarget: Prepared.PreparedIrAsyncHostAdapter['target'] = 'callable';",
    ].join("\n");
    const check = (text: string) => {
      const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: ["node"],
      };
      const host = ts.createCompilerHost(options),
        original = host.getSourceFile.bind(host);
      host.getSourceFile = (path, version, onError, fresh) =>
        path === filename
          ? ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
          : original(path, version, onError, fresh);
      const program = ts.createProgram([filename], options, host);
      const file = program.getSourceFile(filename);
      if (!file) throw Error("missing checked type fixture");
      // Diagnose the actual imported canonical declarations too: a missing
      // import must not be hidden by a same-shaped historical type alias.
      const canonical = [
        ...movedReceipts.map((receipt) => receipt.path),
        "src/runtime/contracts/host-capability-schema.ts",
        "src/runtime/contracts/index.ts",
        "src/ir/runtime/index.ts",
      ].map((path) => {
        const file = program.getSourceFile(resolve(root, path));
        if (!file) throw Error("missing canonical source " + path);
        return file;
      });
      return [
        ...program.getOptionsDiagnostics(),
        ...[file, ...canonical].flatMap((file) => [
          ...program.getSyntacticDiagnostics(file),
          ...program.getSemanticDiagnostics(file),
        ]),
      ];
    };
    const diagnostics = check(source);
    expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
    const rejected = check(source.replaceAll("@ts-expect-error", "negative control"));
    expect(rejected).toHaveLength(11);
    expect(rejected.every((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)).toBe(true);
  }, 60_000);
});

// Independently fixed capture profiles and inverse coordinates; no expected value is learned from an action.
const fixtureCaptureEpochs = [
  {
    name: "canonical3c6",
    receiptPath: "tests/helpers/ir-runtime-program-policy-canonical-3c6.json",
    current: {
      source: {
        bytes: 577771,
        sha256: "2573c40f37d35a8996dab8cfb7ac5c94ef1b57be0f664845878b21e2b516777a",
        gitBlob: "8a7a71945ac6c7728c43cd91ae80a8c270b444cf",
      },
      dataSha256: "4cf6541e0c4677135d54cc2aa47b29763122e4fc416caff66c6165d3cb1e33ac",
      fileCount: 1808,
      filesSha256: "63c4be5ba7d77abd122bbcd55f8273e1fd9ee7a9e59fe522d374d3a0f8c1f54b",
      activationCount: 101,
      activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
      layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
      allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    },
    before: {
      source: {
        bytes: 569224,
        sha256: "68b09ea540cbd7c40c2d42d66071b5c096a992729afa865d143bba5d8f894c91",
        gitBlob: "6dfe8603219039d3be53ff7c8804dbd58fa8534a",
      },
      dataSha256: "e0f089362ce0e56697978858e2d2ab1767b9cf53425f60b76a8cd2d5d17f8057",
      fileCount: 1782,
      filesSha256: "d9bb59233a38f7e4f074e54b9f1b22761fff2fc00b7805a62e910b4a1fefa02e",
      activationCount: 101,
      activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
      layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
      allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    },
    rowChanges: [
      {
        operation: "addition",
        beforeIndex: 1,
        currentIndex: 1,
        row: {
          path: "src/codegen/object-model/native-names.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/backend/wasmgc/resources/native-string-own-keys.ts",
          state: "clean",
          layer: "backend-wasmgc",
        },
        beforeNext: {
          path: "src/runtime/wasmgc/values/string-create-body.ts",
          state: "clean",
          layer: "native-runtime",
        },
        currentPrevious: {
          path: "src/backend/wasmgc/resources/native-string-own-keys.ts",
          state: "clean",
          layer: "backend-wasmgc",
        },
        currentNext: {
          path: "src/codegen/object-model/ports.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 1,
        currentIndex: 2,
        row: {
          path: "src/codegen/object-model/ports.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/backend/wasmgc/resources/native-string-own-keys.ts",
          state: "clean",
          layer: "backend-wasmgc",
        },
        beforeNext: {
          path: "src/runtime/wasmgc/values/string-create-body.ts",
          state: "clean",
          layer: "native-runtime",
        },
        currentPrevious: {
          path: "src/codegen/object-model/native-names.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/runtime/wasmgc/values/string-create-body.ts",
          state: "clean",
          layer: "native-runtime",
        },
      },
      {
        operation: "addition",
        beforeIndex: 186,
        currentIndex: 188,
        row: {
          path: "src/codegen/array/array-ctor-this.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/array-concat-spec.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/array-element-typing.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/array-concat-spec.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/array/array-copywithin-native.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 186,
        currentIndex: 189,
        row: {
          path: "src/codegen/array/array-copywithin-native.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/array-concat-spec.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/array-element-typing.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/array/array-ctor-this.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/array-element-typing.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 199,
        currentIndex: 203,
        row: {
          path: "src/codegen/array/array-length-holes.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/array-length-define.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/array-like-hof-arms.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/array-length-define.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/array/array-like-exotic-arms.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 199,
        currentIndex: 204,
        row: {
          path: "src/codegen/array/array-like-exotic-arms.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/array-length-define.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/array-like-hof-arms.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/array/array-length-holes.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/array-like-hof-arms.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 215,
        currentIndex: 221,
        row: {
          path: "src/codegen/array/array-set-length-coercion.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/array-reduce-fusion.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/array-species.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/array-reduce-fusion.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/array-species.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 218,
        currentIndex: 225,
        row: {
          path: "src/codegen/array/array-unscopables.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/array-tolocalestring.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/ast-modifiers.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/array-tolocalestring.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/ast-modifiers.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 240,
        currentIndex: 248,
        row: {
          path: "src/codegen/expressions/bool-to-locale-string.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/binary-ops.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/bound-fn-meta.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/binary-ops.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/bound-fn-meta.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 394,
        currentIndex: 403,
        row: {
          path: "src/codegen/object-model/define-rejection-channel.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/default-expression-import-global.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/define-properties-map.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/default-expression-import-global.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/define-properties-map.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 421,
        currentIndex: 431,
        row: {
          path: "src/codegen/expressions/eval-param-scope-hoist.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/escape-native.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/exec-census.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/escape-native.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/exec-census.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 598,
        currentIndex: 609,
        row: {
          path: "src/codegen/helpers/core-delegates.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/helpers/body-uses-arguments.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/helpers/is-strict-function.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/helpers/body-uses-arguments.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/helpers/is-strict-function.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 599,
        currentIndex: 611,
        row: {
          path: "src/codegen/helpers/reserved-helper-funcs.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/helpers/is-strict-function.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/helpers/sloppy-this-global.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/helpers/is-strict-function.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/helpers/sloppy-this-global.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 752,
        currentIndex: 765,
        row: {
          path: "src/codegen/expressions/tagged-template-standalone.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/new-target.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/node-fs-api.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/new-target.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/expressions/eval-spread-args.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 752,
        currentIndex: 766,
        row: {
          path: "src/codegen/expressions/eval-spread-args.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/new-target.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/node-fs-api.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/expressions/tagged-template-standalone.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/expressions/with-call-binding.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 752,
        currentIndex: 767,
        row: {
          path: "src/codegen/expressions/with-call-binding.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/new-target.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/node-fs-api.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/expressions/eval-spread-args.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/expressions/new-target-value.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 752,
        currentIndex: 768,
        row: {
          path: "src/codegen/expressions/new-target-value.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/new-target.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/node-fs-api.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/expressions/with-call-binding.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/node-fs-api.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 765,
        currentIndex: 782,
        row: {
          path: "src/codegen/object-model/object-assign-primitive-operands.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/numeric-property-analysis.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/object-builtin-effects.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/numeric-property-analysis.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/object-builtin-effects.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 774,
        currentIndex: 792,
        row: {
          path: "src/codegen/object-model/object-literal-reflective-escape.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/object-literal-method-receiver.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/object-literal-super-base.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/object-literal-method-receiver.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/object-literal-super-base.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 776,
        currentIndex: 795,
        row: {
          path: "src/codegen/object-model/object-own-key-order.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/object-method-arguments-first.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/object-ops.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/object-method-arguments-first.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/object-ops.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 782,
        currentIndex: 802,
        row: {
          path: "src/codegen/object-model/object-proto-to-locale-string.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/object-proto-proto-accessor.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/object-proto-symbol-tag.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/object-proto-proto-accessor.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/object-proto-symbol-tag.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 853,
        currentIndex: 874,
        row: {
          path: "src/codegen/object-model/proxy-own-keys-surfaces.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/proven-receiver-stats.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/proxy-revoker-meta.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/proven-receiver-stats.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/proxy-revoker-meta.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 854,
        currentIndex: 876,
        row: {
          path: "src/codegen/object-model/proxy-trap-read.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/proxy-revoker-meta.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/proxy-value-provenance.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/proxy-revoker-meta.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/closures/proxy-trap-closure-return.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 854,
        currentIndex: 877,
        row: {
          path: "src/codegen/closures/proxy-trap-closure-return.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/proxy-revoker-meta.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/proxy-value-provenance.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/object-model/proxy-trap-read.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/proxy-value-provenance.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 885,
        currentIndex: 909,
        row: {
          path: "src/codegen/registry/expression-helper-delegates.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/registry/error-types.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/registry/import-collector-delegates.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/registry/error-types.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/registry/import-collector-delegates.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 1043,
        currentIndex: 1068,
        row: {
          path: "src/codegen/array/vec-elem-fidelity.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/vec-elem-set.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/vec-externref-hole-presence.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/vec-elem-set.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/vec-externref-hole-presence.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
    ],
    spans: [
      {
        beforeOffset: 69036,
        afterOffset: 69036,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/native-names.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/object-model/ports.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "6be0fb04739b754a7f50bf450cd01cec25c061f041003a403a039a743da0017f",
      },
      {
        beforeOffset: 104800,
        afterOffset: 105439,
        before: "",
        after:
          '    {\n      "path": "src/codegen/array/array-ctor-this.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/array/array-copywithin-native.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "c731d5d5c9c42752c7e098cf02f4ae3893217a11c97077e16fc418b0dfb479d4",
      },
      {
        beforeOffset: 108936,
        afterOffset: 110221,
        before: "",
        after:
          '    {\n      "path": "src/codegen/array/array-length-holes.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/array/array-like-exotic-arms.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "e5b2d9bb9aec6179fd397926a09ffbb6a04fa3015cc1f6152639964a5a87a76d",
      },
      {
        beforeOffset: 114021,
        afterOffset: 115954,
        before: "",
        after:
          '    {\n      "path": "src/codegen/array/array-set-length-coercion.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "c8a7823cc1be16dd39275af6dec1cd8f13bd13fe9cd57f6dfe1845a02966f549",
      },
      {
        beforeOffset: 114966,
        afterOffset: 117228,
        before: "",
        after:
          '    {\n      "path": "src/codegen/array/array-unscopables.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "603fe9fc583b01ba787756d9afd2a8c1e61c6130c2b0340f3f3dfba835e0c372",
      },
      {
        beforeOffset: 121907,
        afterOffset: 124490,
        before: "",
        after:
          '    {\n      "path": "src/codegen/expressions/bool-to-locale-string.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "4da948be46bd65ddcd75a21872b553f4eed52d6875dff60168910f129947f86d",
      },
      {
        beforeOffset: 171443,
        afterOffset: 174357,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/define-rejection-channel.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "24537fa712dd09f177d5d32474b6e2af1679f82ec4414d1834bec73b561f2e32",
      },
      {
        beforeOffset: 179963,
        afterOffset: 183212,
        before: "",
        after:
          '    {\n      "path": "src/codegen/expressions/eval-param-scope-hoist.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "928f90277d70f5212a917ad9c601b7f1a0e08c595b1f86a3c9eccfa86aa75c38",
      },
      {
        beforeOffset: 237496,
        afterOffset: 241077,
        before: "",
        after:
          '    {\n      "path": "src/codegen/helpers/core-delegates.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "f96df65aa7cc3761181a2e68114cd385286d8d3ac3b797e82fa80e5d3c99f226",
      },
      {
        beforeOffset: 237820,
        afterOffset: 241721,
        before: "",
        after:
          '    {\n      "path": "src/codegen/helpers/reserved-helper-funcs.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "6002f7640c0b6aeffee63de7300b69d13d4fecf7be24c21ca119a5b057715ca3",
      },
      {
        beforeOffset: 286683,
        afterOffset: 290911,
        before: "",
        after:
          '    {\n      "path": "src/codegen/expressions/tagged-template-standalone.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/eval-spread-args.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/with-call-binding.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/new-target-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "8de8cb51aae005e2062a170c9dba13fee55686cdb69a29dbcaeaa845578bc723",
      },
      {
        beforeOffset: 290823,
        afterOffset: 296366,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/object-assign-primitive-operands.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "64b94561dbcf9a53a1f46ac715f8501d236f95069300cba25be312bb3c8d4a10",
      },
      {
        beforeOffset: 293741,
        afterOffset: 299627,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/object-literal-reflective-escape.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "1fb830f0b73779cc378965875ad42c2ecf36639b5c454ca194b7b9d46a2003ba",
      },
      {
        beforeOffset: 294391,
        afterOffset: 300620,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/object-own-key-order.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "af03537eacf5d449707fd2461cc8843129f6c52df2b6b3008d8a293fe87cc587",
      },
      {
        beforeOffset: 296338,
        afterOffset: 302898,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/object-proto-to-locale-string.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "76ad31f6e991ea380a8730f0f4e3349a5ebcbe1c7b34769c707bb02f6a012351",
      },
      {
        beforeOffset: 319888,
        afterOffset: 326788,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/proxy-own-keys-surfaces.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "f03516a6ccac11d6e96570e496bcc37b54b58e584aaee379ced1a60746aa5e9e",
      },
      {
        beforeOffset: 320204,
        afterOffset: 327438,
        before: "",
        after:
          '    {\n      "path": "src/codegen/object-model/proxy-trap-read.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/closures/proxy-trap-closure-return.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "7c7f2d68418490f9bf5d95cf750eaa7eb73509f8b8bb672b7e957fcbd4e637dd",
      },
      {
        beforeOffset: 330067,
        afterOffset: 337959,
        before: "",
        after:
          '    {\n      "path": "src/codegen/registry/expression-helper-delegates.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "871b4b3b57f55e42355db6063a765f124f2534e19626a3979a0880f33b79041f",
      },
      {
        beforeOffset: 380579,
        afterOffset: 388805,
        before: "",
        after:
          '    {\n      "path": "src/codegen/array/vec-elem-fidelity.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "13111644dc4adb4a0ba27984ae918ced035d3a9389669665dc5ad3bb7f9d6ff7",
      },
    ],
    api: captureCanonical3c6PredecessorPolicySource,
    full: beforeCanonical3c6InventoryPolicySource,
  },
  {
    name: "currentMain",
    receiptPath: "tests/helpers/ir-runtime-program-policy-main-inventory-20261002.json",
    current: {
      source: {
        bytes: 569224,
        sha256: "68b09ea540cbd7c40c2d42d66071b5c096a992729afa865d143bba5d8f894c91",
        gitBlob: "6dfe8603219039d3be53ff7c8804dbd58fa8534a",
      },
      dataSha256: "e0f089362ce0e56697978858e2d2ab1767b9cf53425f60b76a8cd2d5d17f8057",
      fileCount: 1782,
      filesSha256: "d9bb59233a38f7e4f074e54b9f1b22761fff2fc00b7805a62e910b4a1fefa02e",
      activationCount: 101,
      activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
      layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
      allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    },
    before: {
      source: {
        bytes: 568552,
        sha256: "64103a2fb337874fd435614d461bdd0d46cdfdc8a8dbd61603a4c7cbaf3915ff",
        gitBlob: "b9b8b1787cc202906c4e76cebc598cf460a7f0ae",
      },
      dataSha256: "2f35e7e2045dd0d024a13b48c8f413fc7fb9e74c63503fafee4e56993d1da1a6",
      fileCount: 1780,
      filesSha256: "bcd724252a8ff0cdf6799b01f7e0b9eeceead2c6a3e1f49f9625de233b6710e6",
      activationCount: 101,
      activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
      layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
      allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    },
    rowChanges: [
      {
        operation: "addition",
        beforeIndex: 366,
        currentIndex: 366,
        row: {
          path: "src/codegen/class-builtin-species-read.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/date-parse-native.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/date-proto-to-primitive.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/date-parse-native.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/date-proto-to-json.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 366,
        currentIndex: 367,
        row: {
          path: "src/codegen/date-proto-to-json.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/date-parse-native.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/date-proto-to-primitive.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/class-builtin-species-read.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/date-proto-to-primitive.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "addition",
        beforeIndex: 512,
        currentIndex: 514,
        row: {
          path: "src/codegen/expressions/to-primitive-method-call.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforePrevious: {
          path: "src/codegen/expressions/this-keyword.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        beforeNext: {
          path: "src/codegen/expressions/transferred-native-proto-call.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentPrevious: {
          path: "src/codegen/expressions/this-keyword.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        currentNext: {
          path: "src/codegen/expressions/transferred-native-proto-call.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        operation: "removal",
        beforeIndex: 1381,
        currentIndex: 1384,
        row: {
          path: "src/runtime-containment.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "compiler",
          owner: "3518-coordinator",
          nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
        },
        beforePrevious: {
          path: "src/resolve/consumer-driven-barrels.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "compiler",
          owner: "3518-coordinator",
          nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
        },
        beforeNext: {
          path: "src/runtime-eval.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "compiler",
          owner: "3518-coordinator",
          nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
        },
        currentPrevious: {
          path: "src/resolve/consumer-driven-barrels.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "compiler",
          owner: "3518-coordinator",
          nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
        },
        currentNext: {
          path: "src/runtime-eval.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "compiler",
          owner: "3518-coordinator",
          nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
        },
      },
    ],
    spans: [
      {
        beforeOffset: 162175,
        afterOffset: 162175,
        before: "",
        after:
          '    {\n      "path": "src/codegen/class-builtin-species-read.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/date-proto-to-json.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "6f6dd24f93539ececc43e1423a466543e5e42e4051f56b33b3954e1c5da0193c",
      },
      {
        beforeOffset: 209899,
        afterOffset: 210539,
        before: "",
        after:
          '    {\n      "path": "src/codegen/expressions/to-primitive-method-call.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        afterSha256: "c7a524e5649650927432dc4be13732268461780e960355dc3b45faf2a4b4db31",
      },
      {
        beforeOffset: 485383,
        afterOffset: 486357,
        before:
          '    {\n      "path": "src/runtime-containment.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Review the frontend, orchestration, runtime and shared-contract split before migration."\n    },\n',
        after: "",
        beforeSha256: "45f82bcd707e361470f6ea1ee6543cb54c2a0f5dd248c5b1583499a7b3b38cce",
        afterSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    ],
    api: captureCurrentMainInventoryPredecessorPolicySource,
    full: beforeCurrentMainInventoryPolicySource,
  },
];
const fixtureCapturePhysical = (path: string): string =>
  fixtureCaptureFileURLToPath(new URL(`../${path}`, import.meta.url));
const fixtureCaptureFaultPaths = [
  "tests/helpers/ir-runtime-program-policy-canonical-3c6.json",
  "tests/helpers/ir-runtime-program-policy-main-inventory-20261002.json",
  "tests/helpers/ir-runtime-program-policy-evolution.ts",
];
function fixtureCaptureExpectMissing(action: () => void, path: string): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "ENOENT", path: fixtureCapturePhysical(path) });
}
/** Synchronous, checkout-exclusive real faults; retain recovery bytes/lock on any unsafe restore. */
function fixtureCaptureWithFault(path: string, kind: "mutation" | "missing", action: () => void, byte: 0 = 0): void {
  if (!fixtureCaptureFaultPaths.includes(path)) throw new Error("unapproved current-main authority fault: " + path);
  if (
    ![0].includes(byte) ||
    (byte !== 0 && (path !== "tests/helpers/ir-runtime-program-policy-evolution.ts" || kind !== "mutation"))
  )
    throw new Error("unapproved current-main authority fault byte");
  const target = fixtureCapturePhysical(path);
  const scratch = resolve(import.meta.dirname, "../.tmp/c1-main-epoch/number-two-stage-capture-authority-faults");
  mkdirSync(scratch, { recursive: true });
  const lock = fixtureCaptureJoin(scratch, "checkout.lock");
  // Exclusive creation fails closed if another operation owns this checkout.
  const descriptor = openSync(lock, "wx", 0o600);
  closeSync(descriptor);
  let backupDirectory: string | undefined;
  let backup: string | undefined;
  let restored = true;
  const failures: unknown[] = [];
  const cleanupRestoredFault = (): void => {
    if (backup) {
      // Missing-input restoration renames the sole original out of this operation directory.
      try {
        lstatSync(backup);
        unlinkSync(backup);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    if (backupDirectory) rmdirSync(backupDirectory);
    unlinkSync(lock);
  };
  try {
    const initial = lstatSync(target);
    if (!initial.isFile() || initial.isSymbolicLink())
      throw new Error("authority target must be a regular non-symlink file: " + target);
    const original = readFileSync(target);
    const mode = initial.mode & 0o7777;
    const mutated = Buffer.from(original);
    if (mutated.length === 0) throw new Error("empty authority target: " + target);
    if (byte >= mutated.length) throw new Error("authority fault byte outside target");
    mutated[byte] = mutated[byte]! ^ 1;
    backupDirectory = mkdtempSync(fixtureCaptureJoin(scratch, "operation-"));
    backup = fixtureCaptureJoin(backupDirectory, "original");
    const recovery = backup;
    writeFileSync(lock, JSON.stringify({ path, kind, backup }) + "\n", {
      flag: "r+",
    });
    const verifyTarget = (bytes: Buffer): void => {
      const stat = lstatSync(target);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.ino !== initial.ino ||
        stat.dev !== initial.dev ||
        (stat.mode & 0o7777) !== mode ||
        !readFileSync(target).equals(bytes)
      )
        throw new Error("unexpected authority edit; refusing to overwrite: " + target);
    };
    const restoreFault = (): void => {
      const saved = lstatSync(recovery);
      if (
        !saved.isFile() ||
        saved.isSymbolicLink() ||
        (saved.mode & 0o7777) !== mode ||
        !readFileSync(recovery).equals(original)
      )
        throw new Error("recovery copy differs from captured authority");
      if (kind === "mutation") {
        verifyTarget(mutated);
        writeFileSync(target, original);
        chmodSync(target, mode);
      } else {
        fixtureCaptureExpectMissing(() => {
          lstatSync(target);
        }, path);
        if (saved.ino !== initial.ino || saved.dev !== initial.dev)
          throw new Error("renamed authority identity changed");
        renameSync(recovery, target);
        chmodSync(target, mode);
      }
      verifyTarget(original);
      restored = true;
    };
    verifyTarget(original);
    if (kind === "mutation") {
      writeFileSync(recovery, original, { flag: "wx", mode });
      chmodSync(recovery, mode);
    }
    restored = false;
    try {
      if (kind === "mutation") {
        writeFileSync(target, mutated);
        chmodSync(target, mode);
        verifyTarget(mutated);
        if (byte === 0) {
          expect(mutated[0]).not.toBe(original[0]);
          expect(mutated.subarray(1).equals(original.subarray(1))).toBe(true);
        } else {
          expect(mutated[byte]).not.toBe(original[byte]);
          expect(mutated.subarray(0, byte).equals(original.subarray(0, byte))).toBe(true);
          expect(mutated.subarray(byte + 1).equals(original.subarray(byte + 1))).toBe(true);
        }
      } else {
        renameSync(target, recovery);
        fixtureCaptureExpectMissing(() => {
          readFileSync(target);
        }, path);
        expect(() => lstatSync(target)).toThrow(/ENOENT/);
      }
      action();
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        restoreFault();
      } catch (error) {
        failures.push(
          new Error(
            "authority restoration failed; recovery retained at " + backup + "; checkout lock retained at " + lock,
            { cause: error },
          ),
        );
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    if (restored) {
      try {
        cleanupRestoredFault();
      } catch (error) {
        failures.push(
          new Error("authority cleanup failed; checkout lock/recovery retained at " + lock + " / " + backup, {
            cause: error,
          }),
        );
      }
    }
  }
  // Propagate only after every safe restoration/cleanup path has completed.
  if (failures.length > 1) throw new AggregateError(failures, "authority operation and recovery failures: " + target);
  if (failures.length === 1) throw failures[0];
}

const fixtureCaptureSha = (text: string): string => createHash("sha256").update(text).digest("hex");
const fixtureCapturePin = (text: string) => {
  const b = Buffer.from(text, "utf8");
  return {
    bytes: b.length,
    sha256: fixtureCaptureSha(text),
    gitBlob: createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex"),
  };
};
const fixtureCaptureRead = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
function fixtureCaptureInput(epoch: (typeof fixtureCaptureEpochs)[number]): string {
  const outer = captureCanonical489dPredecessorPolicySource(fixtureCaptureRead("scripts/compiler-boundaries.json"));
  const raw = epoch.name === "canonical3c6" ? outer : captureCanonical3c6PredecessorPolicySource(outer);
  expect(fixtureCapturePin(raw)).toEqual(epoch.current.source);
  return raw;
}
function fixtureCaptureIndependentInverse(raw: string, epoch: (typeof fixtureCaptureEpochs)[number]): string {
  const bytes = Buffer.from(raw, "utf8");
  const pieces: Buffer[] = [];
  let consumed = 0;
  for (const span of epoch.spans) {
    const from = Buffer.from(span.after, "utf8");
    expect(bytes.subarray(span.afterOffset, span.afterOffset + from.length).equals(from)).toBe(true);
    pieces.push(bytes.subarray(consumed, span.afterOffset), Buffer.from(span.before, "utf8"));
    consumed = span.afterOffset + from.length;
  }
  pieces.push(bytes.subarray(consumed));
  return Buffer.concat(pieces).toString("utf8");
}
function fixtureCaptureSpanMutation(
  raw: string,
  epoch: (typeof fixtureCaptureEpochs)[number],
  kind: "omission" | "duplication" | "valid reorder",
): string {
  const spans = epoch.spans.filter((s) => s.after.length > 0);
  expect(spans.length).toBeGreaterThanOrEqual(2);
  const a = spans[0]!,
    b = spans[1]!;
  const bytes = Buffer.from(raw, "utf8");
  const size = Buffer.byteLength(a.after);
  let result: Buffer;
  if (kind === "omission")
    result = Buffer.concat([bytes.subarray(0, a.afterOffset), bytes.subarray(a.afterOffset + size)]);
  else if (kind === "duplication")
    result = Buffer.concat([bytes.subarray(0, a.afterOffset), Buffer.from(a.after), bytes.subarray(a.afterOffset)]);
  else
    result = Buffer.concat([
      bytes.subarray(0, a.afterOffset),
      Buffer.from(b.after),
      bytes.subarray(a.afterOffset + size, b.afterOffset),
      Buffer.from(a.after),
      bytes.subarray(b.afterOffset + Buffer.byteLength(b.after)),
    ]);
  const changed = result.toString("utf8");
  expect(changed).not.toBe(raw);
  expect(() => JSON.parse(changed)).not.toThrow();
  return changed;
}
describe("#3518 runtime policy fixture capture", () => {
  for (const epoch of fixtureCaptureEpochs) {
    it(`${epoch.name} independently proves full raw and semantic predecessor equal to original API`, () => {
      const raw = fixtureCaptureInput(epoch);
      const output = epoch.api(raw);
      expect(fixtureCapturePin(output)).toEqual(epoch.before.source);
      expect(output).toBe(epoch.full(raw));
      expect(output).toBe(fixtureCaptureIndependentInverse(raw, epoch));
      const original = JSON.parse(raw),
        semantic = JSON.parse(raw);
      if (epoch.name === "canonical3c6") {
        for (const change of [...epoch.rowChanges].reverse()) semantic.files.splice(change.currentIndex, 1);
      } else {
        semantic.files.splice(1384, 0, epoch.rowChanges[3]!.row);
        for (const index of [514, 367, 366]) semantic.files.splice(index, 1);
      }
      expect(JSON.parse(output)).toEqual(semantic);
      expect(semantic.files).toHaveLength(epoch.before.fileCount);
      expect(fixtureCaptureSha(JSON.stringify(semantic))).toBe(epoch.before.dataSha256);
      for (const [key, pin] of [
        ["files", epoch.before.filesSha256],
        ["activationHistory", epoch.before.activationHistorySha256],
        ["layers", epoch.before.layersSha256],
        ["allowedEdges", epoch.before.allowedEdgesSha256],
      ] as const)
        expect(fixtureCaptureSha(JSON.stringify(semantic[key]))).toBe(pin);
      const replay = JSON.parse(JSON.stringify(semantic));
      if (epoch.name === "canonical3c6") {
        for (const [inserted, change] of epoch.rowChanges.entries())
          replay.files.splice(change.beforeIndex + inserted, 0, change.row);
      } else {
        replay.files.splice(1381, 1);
        for (const change of epoch.rowChanges.slice(0, 3)) replay.files.splice(change.currentIndex, 0, change.row);
      }
      expect(replay).toEqual(original);
    });
    it(`${epoch.name} refuses boxed string before missing receipt witness`, () => {
      const input = fixtureCaptureInput(epoch);
      fixtureCaptureWithFault(epoch.receiptPath, "missing", () => {
        expect(() => epoch.api(new String(input) as unknown as string)).toThrow(/raw input must be a primitive string/);
      });
      expect(fixtureCapturePin(epoch.api(input))).toEqual(epoch.before.source);
    });
    it(`${epoch.name} refuses stale predecessor`, () => {
      const input = fixtureCaptureInput(epoch);
      const old = epoch.api(input);
      expect(() => epoch.api(old)).toThrow(/raw source profile mismatch/);
    });
    it(`${epoch.name} refuses valid JSON retained row mutation`, () => {
      const input = fixtureCaptureInput(epoch);
      const p = JSON.parse(input);
      p.files[0].path += "-mutated";
      const changed = JSON.stringify(p);
      expect(changed).not.toBe(input);
      expect(() => epoch.api(changed)).toThrow(/raw source profile mismatch/);
    });
    it(`${epoch.name} refuses raw whitespace mutation`, () => {
      const input = fixtureCaptureInput(epoch);
      expect(() => epoch.api(input + "\n")).toThrow(/raw source profile mismatch/);
    });
    for (const kind of ["omission", "duplication", "valid reorder"] as const)
      it(`${epoch.name} refuses original domain span ${kind}`, () => {
        const input = fixtureCaptureInput(epoch);
        const changed = fixtureCaptureSpanMutation(input, epoch, kind);
        expect(() => epoch.api(changed)).toThrow(/raw source profile mismatch/);
      });
    for (const path of [epoch.receiptPath, "tests/helpers/ir-runtime-program-policy-evolution.ts"])
      for (const kind of ["missing", "mutation"] as const)
        it(`${epoch.name} freshly refuses ${kind} physical ${path} after success`, () => {
          const input = fixtureCaptureInput(epoch);
          expect(fixtureCapturePin(epoch.api(input))).toEqual(epoch.before.source);
          fixtureCaptureWithFault(path, kind, () => {
            if (kind === "missing") fixtureCaptureExpectMissing(() => epoch.api(input), path);
            else
              expect(() => epoch.api(input)).toThrow(
                path === epoch.receiptPath ? /receipt digest mismatch/ : /complete .*prefix changed/,
              );
          });
          expect(fixtureCapturePin(epoch.api(input))).toEqual(epoch.before.source);
        });
  }
});

// Independent literal profiles, rows and spans copied from the four immutable receipts.
const fourStageCaptureEpochs = [
  {
    name: "generator",
    receiptPath: "tests/helpers/ir-runtime-program-policy-generator-eager-refusal.json",
    before: {
      source: {
        bytes: 568231,
        sha256: "f3af1f31d813eaef9bd2b955466390616e9549f36e1e7ffffdcead812a611ac3",
        gitBlob: "d61ee74048fa3d16c2986fd3e448d234f4e5594b",
      },
      dataSha256: "89780e5ff7c660518ca92981369dab0e341b77e55f02f8e23d2312b615a97856",
      fileCount: 1779,
      filesSha256: "ced3f8116817be3978f55f438b657ca6b36ec8d50827db92bd7d708c2940853b",
      activationCount: 101,
      activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
      layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
      allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    },
    current: {
      source: {
        bytes: 568552,
        sha256: "64103a2fb337874fd435614d461bdd0d46cdfdc8a8dbd61603a4c7cbaf3915ff",
        gitBlob: "b9b8b1787cc202906c4e76cebc598cf460a7f0ae",
      },
      dataSha256: "2f35e7e2045dd0d024a13b48c8f413fc7fb9e74c63503fafee4e56993d1da1a6",
      fileCount: 1780,
      filesSha256: "bcd724252a8ff0cdf6799b01f7e0b9eeceead2c6a3e1f49f9625de233b6710e6",
      activationCount: 101,
      activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
      layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
      allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    },
    additions: [
      {
        fileIndex: 1615,
        beforeIndex: 1615,
        row: {
          path: "src/codegen/generator-eager-refusal.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        previous: {
          path: "src/codegen/fnctor-instance-names.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        next: {
          path: "src/codegen/generator-function-dynamic.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        sourcePin: {
          path: "src/codegen/generator-eager-refusal.ts",
          bytes: 10619,
          sha256: "b44d14368759f11f18b11d75d2a5abb93fc448e0dc5cb7d8501eb0afe6272535",
        },
        rawSpan: {
          beforeOffset: 529175,
          afterOffset: 529175,
          before:
            '    {\n      "path": "src/codegen/generator-function-dynamic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
          after:
            '    {\n      "path": "src/codegen/generator-eager-refusal.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/generator-function-dynamic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
          beforeSha256: "eaa7278e51f6b98fed1c30f4ba59a0db4736a03c489c860549288c0aa3c1ad1d",
          afterSha256: "44584a36ba540f0e339e6e15bda22765c85db81114312d418cbec9041f086da3",
        },
      },
    ],
    spans: [
      {
        beforeOffset: 529175,
        afterOffset: 529175,
        before:
          '    {\n      "path": "src/codegen/generator-function-dynamic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        after:
          '    {\n      "path": "src/codegen/generator-eager-refusal.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/generator-function-dynamic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "eaa7278e51f6b98fed1c30f4ba59a0db4736a03c489c860549288c0aa3c1ad1d",
        afterSha256: "44584a36ba540f0e339e6e15bda22765c85db81114312d418cbec9041f086da3",
      },
    ],
    runtimeLayer: null,
    fileAppend: null,
    activationAppend: null,
    api: captureGeneratorPredecessorPolicySource,
    full: beforeGeneratorInventoryPolicySource,
  },
  {
    name: "host",
    receiptPath: "tests/helpers/ir-runtime-program-policy-host-carrier.json",
    before: {
      source: {
        bytes: 567908,
        sha256: "5c1c4a16928b421c112eb81180a315d31e116ff442a40375e8c6efb4f220c685",
        gitBlob: "59bdd78821afa174b9273c100a03ec79713249b4",
      },
      dataSha256: "65b382b173594abd15ffdef1a51f96daf017f4d91bd60e47f6308da434ab97b3",
      fileCount: 1778,
      filesSha256: "c306548d8e3f44695a102d10ef8a9503860e39ef6168719f88f874f616563f54",
      activationCount: 101,
      activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
      layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
      allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    },
    current: {
      source: {
        bytes: 568231,
        sha256: "f3af1f31d813eaef9bd2b955466390616e9549f36e1e7ffffdcead812a611ac3",
        gitBlob: "d61ee74048fa3d16c2986fd3e448d234f4e5594b",
      },
      dataSha256: "89780e5ff7c660518ca92981369dab0e341b77e55f02f8e23d2312b615a97856",
      fileCount: 1779,
      filesSha256: "ced3f8116817be3978f55f438b657ca6b36ec8d50827db92bd7d708c2940853b",
      activationCount: 101,
      activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
      layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
      allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    },
    additions: [
      {
        fileIndex: 605,
        beforeIndex: 605,
        row: {
          path: "src/codegen/host-carrier-to-primitive.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        previous: {
          path: "src/codegen/host-bridge-exports.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        next: {
          path: "src/codegen/host-fnctor-method-driver.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        sourcePin: {
          path: "src/codegen/host-carrier-to-primitive.ts",
          bytes: 14025,
          sha256: "6f74bd8c4b97789a1dbfe92dc18dd6e71e11860b0e8efd913c523bca032ce504",
        },
        rawSpan: {
          beforeOffset: 239710,
          afterOffset: 239710,
          before:
            '    {\n      "path": "src/codegen/host-fnctor-method-driver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
          after:
            '    {\n      "path": "src/codegen/host-carrier-to-primitive.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/host-fnctor-method-driver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
          beforeSha256: "3e551509901b9201393becb318e31b2c40e5a8be0d17fa97975556e33dda6bdc",
          afterSha256: "84ec8fc955578c6b77c59141a048c9233b0be087e2e45d3f5a11eb2e275a36db",
        },
      },
    ],
    spans: [
      {
        beforeOffset: 239710,
        afterOffset: 239710,
        before:
          '    {\n      "path": "src/codegen/host-fnctor-method-driver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        after:
          '    {\n      "path": "src/codegen/host-carrier-to-primitive.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/host-fnctor-method-driver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "3e551509901b9201393becb318e31b2c40e5a8be0d17fa97975556e33dda6bdc",
        afterSha256: "84ec8fc955578c6b77c59141a048c9233b0be087e2e45d3f5a11eb2e275a36db",
      },
    ],
    runtimeLayer: null,
    fileAppend: null,
    activationAppend: null,
    api: captureHostCarrierPredecessorPolicySource,
    full: beforeHostCarrierInventoryPolicySource,
  },
  {
    name: "dynamic",
    receiptPath: "tests/helpers/ir-runtime-program-policy-dynamic-code.json",
    before: {
      source: {
        bytes: 567465,
        sha256: "92d653aff02d823339071f24721b803d88da4f31bdbd721859b0ac48b6c9c7f7",
        gitBlob: "70b280c7cf2a56cbd5cbfa88b484b57414d2ef7c",
      },
      dataSha256: "28ae111b7b9f0f6eda144d5d57beaf76fd5c7617b474846d39409a56cc196e08",
      fileCount: 1776,
      filesSha256: "ca4d9d7d5c999a4e742abd7773d847f1652ca8fe995a491a594fca1e5cf37a1a",
      activationCount: 101,
      activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
      layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
      allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    },
    current: {
      source: {
        bytes: 567908,
        sha256: "5c1c4a16928b421c112eb81180a315d31e116ff442a40375e8c6efb4f220c685",
        gitBlob: "59bdd78821afa174b9273c100a03ec79713249b4",
      },
      dataSha256: "65b382b173594abd15ffdef1a51f96daf017f4d91bd60e47f6308da434ab97b3",
      fileCount: 1778,
      filesSha256: "c306548d8e3f44695a102d10ef8a9503860e39ef6168719f88f874f616563f54",
      activationCount: 101,
      activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
      layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
      allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    },
    additions: [
      {
        fileIndex: 202,
        beforeIndex: 202,
        row: {
          path: "src/codegen/array-method-arg-order.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        previous: {
          path: "src/codegen/array-literal-any-carrier.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        next: {
          path: "src/codegen/array-method-host.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
        sourcePin: {
          path: "src/codegen/array-method-arg-order.ts",
          bytes: 6032,
          sha256: "9a4527970fd0fd12f7f0fc7210e92a63f64872b143c4d5bc5931ea0f8be03f0b",
        },
        rawSpan: {
          beforeOffset: 109891,
          afterOffset: 109891,
          before:
            '    {\n      "path": "src/codegen/array-method-host.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
          after:
            '    {\n      "path": "src/codegen/array-method-arg-order.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/array-method-host.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
          beforeSha256: "4cf17df2ddb36ff6c0a270a0c0f4542cccca6806d155c1f8720027ed04030a22",
          afterSha256: "c1c44f40e1731fe2ae2adef0e0ee5d357fcdf8388d9f311bf2ca20982ccf2cb1",
        },
      },
      {
        fileIndex: 1404,
        beforeIndex: 1403,
        row: {
          path: "src/runtime/dynamic-code-policy.ts",
          state: "unmigrated",
          layer: "legacy-host",
        },
        previous: {
          path: "src/runtime/dom-capability-adapter.ts",
          state: "unmigrated",
          layer: "legacy-host",
        },
        next: {
          path: "src/runtime/dynamic-function-import.ts",
          state: "unmigrated",
          layer: "legacy-host",
        },
        sourcePin: {
          path: "src/runtime/dynamic-code-policy.ts",
          bytes: 3863,
          sha256: "afad7fbda3469347671a99f6564de57d45e135c0dee989da5b6f0c1d249ad5af",
        },
        rawSpan: {
          beforeOffset: 488814,
          afterOffset: 489134,
          before:
            '    {\n      "path": "src/runtime/dynamic-function-import.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n',
          after:
            '    {\n      "path": "src/runtime/dynamic-code-policy.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n    {\n      "path": "src/runtime/dynamic-function-import.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n',
          beforeSha256: "8705064bdfb67310ae65cb3203cc2d97840244bcf27f229d71e2f3707e5ed240",
          afterSha256: "254eeb01645faa832948ed42ca47120523a67c845ac23da752f1d129971fced1",
        },
      },
    ],
    spans: [
      {
        beforeOffset: 109891,
        afterOffset: 109891,
        before:
          '    {\n      "path": "src/codegen/array-method-host.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        after:
          '    {\n      "path": "src/codegen/array-method-arg-order.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/array-method-host.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n',
        beforeSha256: "4cf17df2ddb36ff6c0a270a0c0f4542cccca6806d155c1f8720027ed04030a22",
        afterSha256: "c1c44f40e1731fe2ae2adef0e0ee5d357fcdf8388d9f311bf2ca20982ccf2cb1",
      },
      {
        beforeOffset: 488814,
        afterOffset: 489134,
        before:
          '    {\n      "path": "src/runtime/dynamic-function-import.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n',
        after:
          '    {\n      "path": "src/runtime/dynamic-code-policy.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n    {\n      "path": "src/runtime/dynamic-function-import.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n',
        beforeSha256: "8705064bdfb67310ae65cb3203cc2d97840244bcf27f229d71e2f3707e5ed240",
        afterSha256: "254eeb01645faa832948ed42ca47120523a67c845ac23da752f1d129971fced1",
      },
    ],
    runtimeLayer: null,
    fileAppend: null,
    activationAppend: null,
    api: captureDynamicCodePredecessorPolicySource,
    full: beforeDynamicCodeInventoryPolicySource,
  },
  {
    name: "C2a",
    receiptPath: "tests/helpers/ir-runtime-program-policy-runtime-preparation.json",
    before: {
      source: {
        bytes: 567166,
        sha256: "8213f6d2d3bf112544ca2aa50b68e585f4ba2c1f9795acc240c9e8495712e7df",
        gitBlob: "0d90f336925232fd22c98c438121b93e7e5bcf52",
      },
      dataSha256: "5dea4a676b8ddbc6fc50c7c77446e799ee4db12f4113c1fdf4edff33de848b21",
      fileCount: 1775,
      filesSha256: "82448a8b5bf6373b7ef203924f3ac4f0d33e69ca1df77b322812b63613fe8bec",
      activationCount: 100,
      activationHistorySha256: "f6716a46656b3e4e7292e6d6c2cfdb5681becc9fb0e688ebad01a49c48d044ab",
      layersSha256: "ab456c917964e4e4d51c7110ce854e8c8648827a72eb4e6e61e2d74dc7f08a05",
      allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    },
    current: {
      source: {
        bytes: 567465,
        sha256: "92d653aff02d823339071f24721b803d88da4f31bdbd721859b0ac48b6c9c7f7",
        gitBlob: "70b280c7cf2a56cbd5cbfa88b484b57414d2ef7c",
      },
      dataSha256: "28ae111b7b9f0f6eda144d5d57beaf76fd5c7617b474846d39409a56cc196e08",
      fileCount: 1776,
      filesSha256: "ca4d9d7d5c999a4e742abd7773d847f1652ca8fe995a491a594fca1e5cf37a1a",
      activationCount: 101,
      activationHistorySha256: "9629c457a160096e70c35fc3a986abbd8eca145ac4eb688995194d6c29c83650",
      layersSha256: "3f66bbff64c157092a04740c644ae17d476d7d168faa1bd23629f97492e0c4f7",
      allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    },
    additions: [],
    spans: [
      {
        role: "runtime-layer-tail",
        beforeOffset: 6444,
        afterOffset: 6444,
        before: '        "src/ir/runtime/generator-support.ts"\n      ],\n      "minModules": 19\n',
        after:
          '        "src/ir/runtime/generator-support.ts",\n        "src/ir/runtime/intrinsic-preparation.ts"\n      ],\n      "minModules": 20\n',
        beforeSha256: "30d6b3d2844adec2c20019162f41b792554a8318ffaf593562dfe64a9b2984db",
        afterSha256: "0fb91016dca1d3ba652a1e1c1622f4a486292e82384be2e46a08a01dfc86d058",
      },
      {
        role: "activation-history-tail",
        beforeOffset: 65731,
        afterOffset: 65782,
        before:
          '        "src/runtime/wasmgc/values/bigint-to-number-body.ts",\n        "src/runtime/wasmgc/values/number-from-value-body.ts"\n      ],\n      "minModules": 2\n    },\n    {\n      "layer": "backend-wasmgc",\n      "entries": [\n        "src/backend/wasmgc/resources/native-bigint-number.ts",\n        "src/backend/wasmgc/resources/native-number-primitive-classifier.ts"\n      ],\n      "minModules": 2\n',
        after:
          '        "src/runtime/wasmgc/values/bigint-to-number-body.ts",\n        "src/runtime/wasmgc/values/number-from-value-body.ts"\n      ],\n      "minModules": 2\n    },\n    {\n      "layer": "backend-wasmgc",\n      "entries": [\n        "src/backend/wasmgc/resources/native-bigint-number.ts",\n        "src/backend/wasmgc/resources/native-number-primitive-classifier.ts"\n      ],\n      "minModules": 2\n    },\n    {\n      "layer": "ir-runtime",\n      "entries": ["src/ir/runtime/intrinsic-preparation.ts"],\n      "minModules": 1\n',
        beforeSha256: "0e51cdca0a46e556233d7346ebbcbe9d8c6013789926f4392698734146ecc610",
        afterSha256: "a014b410b320473b7b40780c7b6b88ecd10c39bdbdfaf1fffb89af040add274f",
      },
      {
        role: "files-tail",
        beforeOffset: 566806,
        afterOffset: 566983,
        before:
          '      "state": "clean",\n      "layer": "native-runtime"\n    },\n    {\n      "path": "src/backend/wasmgc/resources/native-bigint-number.ts",\n      "state": "clean",\n      "layer": "backend-wasmgc"\n    },\n    {\n      "path": "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",\n      "state": "clean",\n      "layer": "backend-wasmgc"\n',
        after:
          '      "state": "clean",\n      "layer": "native-runtime"\n    },\n    {\n      "path": "src/backend/wasmgc/resources/native-bigint-number.ts",\n      "state": "clean",\n      "layer": "backend-wasmgc"\n    },\n    {\n      "path": "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",\n      "state": "clean",\n      "layer": "backend-wasmgc"\n    },\n    {\n      "path": "src/ir/runtime/intrinsic-preparation.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n',
        beforeSha256: "690dc5485a5f7cabaf4cc1cbdca969dfafd96a79976728b6e4a1eacbddfb244c",
        afterSha256: "5b58f77c2d14008613ef192e5ed99eda9e3c4d414e6f8b9cb7f2a9e9e0ccfd4c",
      },
    ],
    runtimeLayer: {
      index: 8,
      id: "ir-runtime",
      beforeEntries: 19,
      currentEntries: 20,
      beforeMinModules: 19,
      currentMinModules: 20,
      beforeClassified: 19,
      currentClassified: 20,
    },
    fileAppend: {
      path: "src/ir/runtime/intrinsic-preparation.ts",
      state: "clean",
      layer: "ir-runtime",
    },
    activationAppend: {
      layer: "ir-runtime",
      entries: ["src/ir/runtime/intrinsic-preparation.ts"],
      minModules: 1,
    },
    api: captureRuntimePreparationPredecessorPolicySource,
    full: beforeRuntimePreparationPolicySource,
  },
] as const;
const fourStageCaptureFaultPaths = [
  "tests/helpers/ir-runtime-program-policy-generator-eager-refusal.json",
  "tests/helpers/ir-runtime-program-policy-host-carrier.json",
  "tests/helpers/ir-runtime-program-policy-dynamic-code.json",
  "tests/helpers/ir-runtime-program-policy-runtime-preparation.json",
  "tests/helpers/ir-runtime-program-policy-evolution.ts",
];
/** Synchronous, checkout-exclusive real faults; retain recovery bytes/lock on any unsafe restore. */
function fourStageCaptureWithFault(path: string, kind: "mutation" | "missing", action: () => void, byte: 0 = 0): void {
  if (!fourStageCaptureFaultPaths.includes(path)) throw new Error("unapproved current-main authority fault: " + path);
  if (
    ![0].includes(byte) ||
    (byte !== 0 && (path !== "tests/helpers/ir-runtime-program-policy-evolution.ts" || kind !== "mutation"))
  )
    throw new Error("unapproved current-main authority fault byte");
  const target = fixtureCapturePhysical(path);
  const scratch = resolve(import.meta.dirname, "../.tmp/c1-main-epoch/number-two-stage-capture-authority-faults");
  mkdirSync(scratch, { recursive: true });
  const lock = fixtureCaptureJoin(scratch, "checkout.lock");
  // Exclusive creation fails closed if another operation owns this checkout.
  const descriptor = openSync(lock, "wx", 0o600);
  closeSync(descriptor);
  let backupDirectory: string | undefined;
  let backup: string | undefined;
  let restored = true;
  const failures: unknown[] = [];
  const cleanupRestoredFault = (): void => {
    if (backup) {
      // Missing-input restoration renames the sole original out of this operation directory.
      try {
        lstatSync(backup);
        unlinkSync(backup);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    if (backupDirectory) rmdirSync(backupDirectory);
    unlinkSync(lock);
  };
  try {
    const initial = lstatSync(target);
    if (!initial.isFile() || initial.isSymbolicLink())
      throw new Error("authority target must be a regular non-symlink file: " + target);
    const original = readFileSync(target);
    const mode = initial.mode & 0o7777;
    const mutated = Buffer.from(original);
    if (mutated.length === 0) throw new Error("empty authority target: " + target);
    if (byte >= mutated.length) throw new Error("authority fault byte outside target");
    mutated[byte] = mutated[byte]! ^ 1;
    backupDirectory = mkdtempSync(fixtureCaptureJoin(scratch, "operation-"));
    backup = fixtureCaptureJoin(backupDirectory, "original");
    const recovery = backup;
    writeFileSync(lock, JSON.stringify({ path, kind, backup }) + "\n", {
      flag: "r+",
    });
    const verifyTarget = (bytes: Buffer): void => {
      const stat = lstatSync(target);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.ino !== initial.ino ||
        stat.dev !== initial.dev ||
        (stat.mode & 0o7777) !== mode ||
        !readFileSync(target).equals(bytes)
      )
        throw new Error("unexpected authority edit; refusing to overwrite: " + target);
    };
    const restoreFault = (): void => {
      const saved = lstatSync(recovery);
      if (
        !saved.isFile() ||
        saved.isSymbolicLink() ||
        (saved.mode & 0o7777) !== mode ||
        !readFileSync(recovery).equals(original)
      )
        throw new Error("recovery copy differs from captured authority");
      if (kind === "mutation") {
        verifyTarget(mutated);
        writeFileSync(target, original);
        chmodSync(target, mode);
      } else {
        fixtureCaptureExpectMissing(() => {
          lstatSync(target);
        }, path);
        if (saved.ino !== initial.ino || saved.dev !== initial.dev)
          throw new Error("renamed authority identity changed");
        renameSync(recovery, target);
        chmodSync(target, mode);
      }
      verifyTarget(original);
      restored = true;
    };
    verifyTarget(original);
    if (kind === "mutation") {
      writeFileSync(recovery, original, { flag: "wx", mode });
      chmodSync(recovery, mode);
    }
    restored = false;
    try {
      if (kind === "mutation") {
        writeFileSync(target, mutated);
        chmodSync(target, mode);
        verifyTarget(mutated);
        if (byte === 0) {
          expect(mutated[0]).not.toBe(original[0]);
          expect(mutated.subarray(1).equals(original.subarray(1))).toBe(true);
        } else {
          expect(mutated[byte]).not.toBe(original[byte]);
          expect(mutated.subarray(0, byte).equals(original.subarray(0, byte))).toBe(true);
          expect(mutated.subarray(byte + 1).equals(original.subarray(byte + 1))).toBe(true);
        }
      } else {
        renameSync(target, recovery);
        fixtureCaptureExpectMissing(() => {
          readFileSync(target);
        }, path);
        expect(() => lstatSync(target)).toThrow(/ENOENT/);
      }
      action();
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        restoreFault();
      } catch (error) {
        failures.push(
          new Error(
            "authority restoration failed; recovery retained at " + backup + "; checkout lock retained at " + lock,
            { cause: error },
          ),
        );
      }
    }
  } catch (error) {
    failures.push(error);
  } finally {
    if (restored) {
      try {
        cleanupRestoredFault();
      } catch (error) {
        failures.push(
          new Error("authority cleanup failed; checkout lock/recovery retained at " + lock + " / " + backup, {
            cause: error,
          }),
        );
      }
    }
  }
  // Propagate only after every safe restoration/cleanup path has completed.
  if (failures.length > 1) throw new AggregateError(failures, "authority operation and recovery failures: " + target);
  if (failures.length === 1) throw failures[0];
}

function fourStageCaptureInput(epoch: (typeof fourStageCaptureEpochs)[number]): string {
  let source = captureCurrentMainInventoryPredecessorPolicySource(
    captureCanonical3c6PredecessorPolicySource(
      captureCanonical489dPredecessorPolicySource(fixtureCaptureRead("scripts/compiler-boundaries.json")),
    ),
  );
  if (epoch.name !== "generator") source = captureGeneratorPredecessorPolicySource(source);
  if (epoch.name === "dynamic" || epoch.name === "C2a") source = captureHostCarrierPredecessorPolicySource(source);
  if (epoch.name === "C2a") source = captureDynamicCodePredecessorPolicySource(source);
  expect(fixtureCapturePin(source)).toEqual(epoch.current.source);
  return source;
}
function fourStageCaptureIndependentRaw(
  raw: string,
  epoch: (typeof fourStageCaptureEpochs)[number],
  forward: boolean,
): string {
  const bytes = Buffer.from(raw, "utf8");
  expect(fixtureCapturePin(raw)).toEqual(forward ? epoch.before.source : epoch.current.source);
  const pieces: Buffer[] = [];
  let consumed = 0;
  for (const span of epoch.spans) {
    const at = forward ? span.beforeOffset : span.afterOffset;
    const from = forward ? span.before : span.after;
    const to = forward ? span.after : span.before;
    const fragment = Buffer.from(from, "utf8");
    expect(at).toBeGreaterThanOrEqual(consumed);
    expect(Buffer.byteLength(raw.slice(0, at))).toBe(at);
    expect(bytes.subarray(at, at + fragment.length).equals(fragment)).toBe(true);
    expect(raw.indexOf(from)).toBe(at);
    expect(raw.lastIndexOf(from)).toBe(at);
    expect(fixtureCaptureSha(from)).toBe(forward ? span.beforeSha256 : span.afterSha256);
    pieces.push(bytes.subarray(consumed, at), Buffer.from(to, "utf8"));
    consumed = at + fragment.length;
  }
  pieces.push(bytes.subarray(consumed));
  const output = Buffer.concat(pieces).toString("utf8");
  expect(fixtureCapturePin(output)).toEqual(forward ? epoch.current.source : epoch.before.source);
  return output;
}
function fourStageCaptureSpanMutation(
  raw: string,
  epoch: (typeof fourStageCaptureEpochs)[number],
  kind: "omission" | "duplication" | "valid reorder",
): string {
  const span = epoch.spans[0]!;
  expect(raw.slice(span.afterOffset, span.afterOffset + span.after.length)).toBe(span.after);
  let replacement: string;
  if (kind === "omission") replacement = span.before;
  else if (epoch.name === "C2a") {
    const previous = '        "src/ir/runtime/generator-support.ts"';
    const added = '        "src/ir/runtime/intrinsic-preparation.ts"';
    const pair = previous + ",\n" + added;
    expect(span.after.split(pair)).toHaveLength(2);
    replacement = span.after.replace(pair, kind === "duplication" ? pair + ",\n" + added : added + ",\n" + previous);
  } else {
    expect(span.after.endsWith(span.before)).toBe(true);
    const added = span.after.slice(0, span.after.length - span.before.length);
    expect(added.length).toBeGreaterThan(0);
    replacement = kind === "duplication" ? added + span.after : span.before + added;
  }
  const changed = raw.slice(0, span.afterOffset) + replacement + raw.slice(span.afterOffset + span.after.length);
  expect(changed).not.toBe(raw);
  expect(() => JSON.parse(changed)).not.toThrow();
  return changed;
}
describe("#3518 four-stage runtime policy fixture capture", () => {
  for (const epoch of fourStageCaptureEpochs) {
    it(`${epoch.name} independently proves fixed full profiles, local inverse and original full API`, () => {
      const input = fourStageCaptureInput(epoch);
      const output = epoch.api(input);
      expect(fixtureCapturePin(output)).toEqual(epoch.before.source);
      expect(output).toBe(epoch.full(input));
      expect(output).toBe(fourStageCaptureIndependentRaw(input, epoch, false));
      expect(fourStageCaptureIndependentRaw(output, epoch, true)).toBe(input);
      const current = JSON.parse(input);
      const before = JSON.parse(input);
      if (epoch.name === "C2a") {
        expect(current.files.slice(1775)).toEqual([epoch.fileAppend]);
        expect(current.activationHistory.slice(100)).toEqual([epoch.activationAppend]);
        expect(current.files.filter((row: { layer: string }) => row.layer === "ir-runtime")).toHaveLength(20);
        const layer = before.layers[8];
        expect(layer.id).toBe("ir-runtime");
        expect(layer.status).toBe("active");
        expect(layer.required).toBe(true);
        expect(layer.roots).toEqual(["src/ir/runtime"]);
        expect(layer.entries).toHaveLength(20);
        expect(layer.entries.slice(19)).toEqual([epoch.fileAppend.path]);
        expect(layer.minModules).toBe(20);
        before.files.length = 1775;
        before.activationHistory.length = 100;
        layer.entries.length = 19;
        layer.minModules = 19;
      } else {
        for (const addition of epoch.additions) {
          expect(Object.keys(current.files[addition.fileIndex])).toEqual(Object.keys(addition.row));
          expect(current.files[addition.fileIndex - 1]).toEqual(addition.previous);
          expect(current.files[addition.fileIndex]).toEqual(addition.row);
          expect(current.files[addition.fileIndex + 1]).toEqual(addition.next);
          expect(current.files.filter((row: { path: string }) => row.path === addition.row.path)).toHaveLength(1);
        }
        for (const addition of [...epoch.additions].reverse()) before.files.splice(addition.fileIndex, 1);
      }
      expect(JSON.parse(output)).toEqual(before);
      expect(before.files).toHaveLength(epoch.before.fileCount);
      expect(before.activationHistory).toHaveLength(epoch.before.activationCount);
      expect(fixtureCaptureSha(JSON.stringify(before))).toBe(epoch.before.dataSha256);
      for (const [key, expected] of [
        ["files", epoch.before.filesSha256],
        ["activationHistory", epoch.before.activationHistorySha256],
        ["layers", epoch.before.layersSha256],
        ["allowedEdges", epoch.before.allowedEdgesSha256],
      ] as const)
        expect(fixtureCaptureSha(JSON.stringify(before[key]))).toBe(expected);
      const replay = JSON.parse(JSON.stringify(before));
      if (epoch.name === "C2a") {
        expect(replay.files).toHaveLength(1775);
        expect(replay.activationHistory).toHaveLength(100);
        expect(replay.layers[8].entries).toHaveLength(19);
        expect(replay.layers[8].minModules).toBe(19);
        replay.files.push(epoch.fileAppend);
        replay.activationHistory.push(epoch.activationAppend);
        replay.layers[8].entries.push(epoch.fileAppend.path);
        replay.layers[8].minModules = 20;
      } else {
        // Both dynamic predecessor neighbor pairs are checked before any insertion.
        for (const addition of epoch.additions) {
          expect(replay.files[addition.beforeIndex - 1]).toEqual(addition.previous);
          expect(replay.files[addition.beforeIndex]).toEqual(addition.next);
        }
        for (const [inserted, addition] of epoch.additions.entries())
          replay.files.splice(addition.beforeIndex + inserted, 0, addition.row);
      }
      expect(replay).toEqual(current);
      expect(fixtureCaptureSha(JSON.stringify(replay))).toBe(epoch.current.dataSha256);
    });
    it(`${epoch.name} refuses boxed string before missing receipt witness`, () => {
      const input = fourStageCaptureInput(epoch);
      fourStageCaptureWithFault(epoch.receiptPath, "missing", () => {
        expect(() => epoch.api(new String(input) as unknown as string)).toThrow(/raw input must be a primitive string/);
      });
      expect(fixtureCapturePin(epoch.api(input))).toEqual(epoch.before.source);
    });
    it(`${epoch.name} refuses stale predecessor`, () => {
      const input = fourStageCaptureInput(epoch);
      const stale = epoch.api(input);
      expect(() => epoch.api(stale)).toThrow(/complete raw source profile mismatch/);
    });
    it(`${epoch.name} refuses valid JSON retained row mutation`, () => {
      const input = fourStageCaptureInput(epoch);
      const value = JSON.parse(input);
      value.files[0].path += "-four-stage-mutant";
      const changed = JSON.stringify(value);
      expect(changed).not.toBe(input);
      expect(() => epoch.api(changed)).toThrow(/complete raw source profile mismatch/);
    });
    it(`${epoch.name} refuses raw whitespace mutation`, () => {
      const input = fourStageCaptureInput(epoch);
      expect(() => epoch.api(input + "\n")).toThrow(/complete raw source profile mismatch/);
    });
    for (const kind of ["omission", "duplication", "valid reorder"] as const)
      it(`${epoch.name} refuses fixed raw span ${kind}`, () => {
        const input = fourStageCaptureInput(epoch);
        const changed = fourStageCaptureSpanMutation(input, epoch, kind);
        expect(() => epoch.api(changed)).toThrow(/complete raw source profile mismatch/);
      });
    for (const path of [epoch.receiptPath, "tests/helpers/ir-runtime-program-policy-evolution.ts"])
      for (const kind of ["missing", "mutation"] as const)
        it(`${epoch.name} freshly refuses ${kind} physical ${path} after success`, () => {
          const input = fourStageCaptureInput(epoch);
          expect(fixtureCapturePin(epoch.api(input))).toEqual(epoch.before.source);
          fourStageCaptureWithFault(path, kind, () => {
            if (kind === "missing") fixtureCaptureExpectMissing(() => epoch.api(input), path);
            else
              expect(() => epoch.api(input)).toThrow(
                path === epoch.receiptPath
                  ? /receipt digest mismatch/
                  : /full-file pin changed: tests\/helpers\/ir-runtime-program-policy-evolution\.ts/,
              );
          });
          expect(fixtureCapturePin(epoch.api(input))).toEqual(epoch.before.source);
        });
  }
});
