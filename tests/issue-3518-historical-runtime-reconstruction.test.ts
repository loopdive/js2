// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  acceptedHistoricalDeclarations,
  assertCallableExtension,
  callableSourceView,
  assertNamedForward,
  currentDeclarations,
  historicalIntrinsicSource,
  liveSourceReader,
  parseLive,
  type SourceReader,
} from "./helpers/ir-historical-runtime-reconstruction.js";

const read = liveSourceReader(resolve(import.meta.dirname, ".."));
const contract = "src/ir/runtime/contracts/intrinsics.ts";
const core = "src/ir/core/intrinsic-contracts.ts";
const intrinsic = "src/ir/core/intrinsics.ts";
const semantic = "src/ir/analysis/intrinsics.ts";
const verifier = "src/ir/runtime/intrinsic-verification.ts";
const support = "src/ir/intrinsic-support.ts";
const manifest = "src/ir/runtime/manifest.ts";
const attachment = "src/ir/runtime/async-attachment.ts";
const callables = "src/ir/runtime/callable-declarations.ts";
const nativeCallables = "src/ir/runtime/native-async-callables.ts";
const coreCallables = "src/ir/core/async-callables.ts";
const manifestContract = "src/ir/runtime/contracts/manifest.ts";

afterEach(async () => {
  // Repeated synchronous AST receipts must not starve Vitest's task-update RPC.
  await setImmediate();
});

describe("callable deltas retained beneath the checked clock/vector composition", () => {
  it.each(["#indexProviders", "#selectProvider"])(
    "rejects valid-syntax native validation moved after existing checks in %s",
    (name) => {
      acceptedCallablePositive();
      const row = currentDeclarations(manifest, read).find((entry) => entry.name === "RuntimeManifestBuilder")!;
      if (!ts.isClassDeclaration(row.node)) throw Error("missing live builder");
      const method = row.node.members.find((member) => member.name?.getText() === name);
      if (!method || !ts.isMethodDeclaration(method) || !method.body) throw Error("missing live method");
      let statements = method.body.statements;
      let start = 1;
      if (name === "#indexProviders") {
        const loop = statements.find(ts.isForOfStatement);
        if (!loop || !ts.isBlock(loop.statement)) throw Error("missing actual provider loop");
        statements = loop.statement.statements;
        start = 0;
      }
      const first = statements[start]!,
        second = statements[start + 1]!,
        next = statements[start + 2]!;
      expect(ts.isVariableStatement(first)).toBe(true);
      expect(ts.isIfStatement(second)).toBe(true);
      expect(ts.isIfStatement(next)).toBe(true);
      const changed = mutation(
        manifest,
        (text) =>
          text.slice(0, first.getFullStart()) +
          next.getFullText(row.file) +
          first.getFullText(row.file) +
          second.getFullText(row.file) +
          text.slice(next.end),
      );
      parseLive(manifest, changed); // valid syntax, not a parser-rejection surrogate
      expect(() => acceptedCallablePositive(changed)).toThrow();
    },
  );

  it("keeps current 6/21/7/82/75/37 populations separate from historical receipts", () => {
    acceptedCallablePositive();
    for (const [path, count] of [
      [coreCallables, 6],
      [nativeCallables, 21],
      [callables, 7],
      [manifest, 82],
      [manifestContract, 75],
      [support, 37],
    ] as const)
      expect(currentDeclarations(path, read)).toHaveLength(count);
    expect(
      acceptedHistoricalDeclarations(manifestContract, read).filter(
        (row) => row.kind === "type" || row.kind === "interface",
      ),
    ).toHaveLength(38);
  });

  const addedDeclarations = [
    [coreCallables, "IR_NATIVE_PROMISE_DELAY_FN"],
    [coreCallables, "IR_ASYNC_PROMISE_ALL_NATIVE_FN"],
    [coreCallables, "IR_ASYNC_CLOCK_SNAPSHOT_FN"],
    [coreCallables, "IR_ASYNC_NUMBER_TO_STRING_FN"],
    [coreCallables, "IR_ASYNC_CONSOLE_LOG_STRING_FN"],
    [coreCallables, "IR_ASYNC_STRING_CONCAT_5_FN"],
    [nativeCallables, "F64"],
    [nativeCallables, "EXTERNREF"],
    [nativeCallables, "PROMISE"],
    [nativeCallables, "STRING"],
    [nativeCallables, "PROMISE_VECTOR"],
    [nativeCallables, "declaration"],
    [nativeCallables, "NATIVE_ASYNC_CALLABLE_DECLARATIONS"],
    [nativeCallables, "irNativeAsyncCallableDeclaration"],
    [nativeCallables, "irRuntimeCallableHasNoSlot"],
    [nativeCallables, "PROMISE_DEPENDENCIES"],
    [nativeCallables, "NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS"],
    [nativeCallables, "nativeAsyncProviderMismatch"],
    [nativeCallables, "nativeAsyncCallablePolicyMismatch"],
    [nativeCallables, "IrNativeAsyncCallableError"],
    [nativeCallables, "IrNativeAsyncCallableDemand"],
    [nativeCallables, "buffers"],
    [nativeCallables, "nativeAsyncCallableValueTypes"],
    [nativeCallables, "nativeAsyncCallMismatch"],
    [nativeCallables, "collectNativeAsyncCallableDemands"],
    [nativeCallables, "assertNativeAsyncCallableDemands"],
    [nativeCallables, "assertNativeAsyncRuntimeCallables"],
    [manifestContract, "NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES"],
    [manifestContract, "NativeAsyncCallableRuntimeFeature"],
    [manifestContract, "NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS"],
    [manifestContract, "NativeAsyncCallableRuntimeProviderId"],
    [callables, "REFERENCE_ERROR_SIGNATURE"],
    [callables, "REFERENCE_ERROR_RUNTIME_PROVIDERS"],
  ] as const;

  for (const change of ["missing", "renamed", "duplicate", "reorder", "changed"] as const)
    it.each(addedDeclarations)("rejects " + change + " live addition %s#%s", (path, name) => {
      acceptedCallablePositive();
      const rows = currentDeclarations(path, read);
      // A last declaration is swapped with its predecessor, never silently skipped.
      const selected = change === "reorder" && rows.at(-1)!.name === name ? rows.at(-2)!.name : name;
      const changed =
        change === "changed"
          ? mutation(path, (text) => {
              const row = rows.find((entry) => entry.name === name)!;
              const altered = row.text.replace(
                /\b(export|const|function|interface|class|type)\b/,
                "$& /* changed declaration */",
              );
              expect(altered).not.toBe(row.text);
              return text.slice(0, row.node.getStart()) + altered + text.slice(row.node.end);
            })
          : declarationMutation(path, selected, change);
      expect(() => acceptedCallablePositive(changed)).toThrow();
    });

  // Exact live insertion sites, not already-normalized historical rows. Each
  // chunk is individually deleted, duplicated, reordered and changed.
  const insertionSites = [
    [manifest, "    ...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,\n"],
    [manifest, "  ...NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES,\n"],
    [manifest, "  ...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS,\n"],
    [manifest, "  resolveProvider(feature: NativeAsyncCallableRuntimeFeature): RuntimeProviderDefinition;\n"],
    [
      manifest,
      '      const nativeMismatch = nativeAsyncProviderMismatch(provider) ?? vectorProviderMismatch(provider);\n      if (nativeMismatch)\n        throw new RuntimeManifestInvariantError(\n          "provider-signature-mismatch",\n          nativeMismatch,\n          provider.feature,\n          provider.feature,\n        );\n',
    ],
    [
      manifest,
      '    const nativePolicyMismatch = NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES.some((entry) => entry === feature)\n      ? nativeAsyncCallablePolicyMismatch(feature, this.#policy)\n      : vectorCallablePolicyMismatch(feature, this.#policy);\n    if (nativePolicyMismatch)\n      throw new RuntimeManifestInvariantError("provider-target-unavailable", nativePolicyMismatch);\n',
    ],
    [
      support,
      "  /** Explicit complete whole-program scan. Omission retains historical automatic demand behavior. */\n  readonly builtinDemands?: readonly IrNativeAsyncCallableDemand[];\n",
    ],
    [support, "  if (input.builtinDemands) assertNativeAsyncCallableDemands(input.functions, input.builtinDemands);\n"],
    [
      support,
      '              if (declaration?.feature === "error.reference.construct") runtimeCallFeatures.add(declaration.feature);\n',
    ],
    [
      support,
      '  for (const demand of input.builtinDemands ?? [])\n    for (const use of demand.uses) {\n      const mismatch = nativeAsyncCallablePolicyMismatch(use.feature, input.policy);\n      if (mismatch)\n        throw new RuntimeManifestInvariantError("provider-target-unavailable", mismatch, use.feature, use.feature);\n      runtimeCallFeatures.add(use.feature);\n    }\n',
    ],
    [
      support,
      "          const attached = attachAsyncRuntime(\n            attachProviders(fn, providers, manifest.hostCapabilityRecords, projectClocks),\n          );\n          if (input.builtinDemands) assertNativeAsyncRuntimeCallables(attached);\n          return attached;\n",
    ],
    [manifestContract, "  | NativeAsyncCallableRuntimeFeature\n"],
    [manifestContract, "  | NativeAsyncCallableRuntimeProviderId\n"],
    [
      manifestContract,
      '  | {\n      /** Authenticated standalone constant projection; never a callable or frame service. */\n      readonly kind: "standalone-clock-zero";\n    }\n',
    ],
    [callables, "    : (irNativeAsyncCallableDeclaration(ref) ?? irVectorCallableDeclaration(ref));\n"],
  ] as const;
  for (const change of ["missing", "duplicate", "reorder", "changed"] as const)
    it.each(insertionSites.map(([path, chunk], index) => ({ path, chunk, index })))(
      "rejects " + change + " insertion $index in $path",
      ({ path, chunk }) => {
        const changed = mutation(path, (text) => {
          expect(text.split(chunk)).toHaveLength(2);
          if (change === "missing") return text.replace(chunk, "");
          if (change === "duplicate") return text.replace(chunk, chunk + chunk);
          if (change === "changed")
            return text.replace(
              chunk,
              chunk.replace(/\S/, (token) => "/* changed delta */" + token),
            );
          const at = text.indexOf(chunk),
            end = at + chunk.length;
          const nextEnd = text.indexOf("\n", end);
          expect(nextEnd).toBeGreaterThan(end);
          return text.slice(0, at) + text.slice(end, nextEnd + 1) + chunk + text.slice(nextEnd + 1);
        });
        expect(() => acceptedCallablePositive(changed)).toThrow();
      },
    );

  it.each([
    [
      coreCallables,
      "Logical bindings, not backend function names",
      "Changed logical bindings, not backend function names",
    ],
    [nativeCallables, '"scheduler.enqueue",', '"scheduler.drain",'],
    [nativeCallables, "Object.freeze(dependencies)", "Object.freeze([])"],
    [nativeCallables, "actual.nullable === false", "actual.nullable === true"],
    [nativeCallables, "irTypeEquals({ ...actual, nullable: true }, expected)", "true"],
    [nativeCallables, "readonly unitId: IrUnitId;", "readonly unitId?: IrUnitId;"],
    [nativeCallables, 'this.name = "IrNativeAsyncCallableError"', 'this.name = "OtherError"'],
    [manifest, "nativeAsyncProviderMismatch(provider)", "nativeAsyncProviderMismatch(this.#providers[0]!)"],
    [
      manifest,
      "nativeAsyncCallablePolicyMismatch(feature, this.#policy)",
      "nativeAsyncCallablePolicyMismatch(feature, {})",
    ],
    [
      manifest,
      "resolveProvider(feature: NativeAsyncCallableRuntimeFeature)",
      "resolveProvider(feature: RuntimeFeature)",
    ],
    [
      manifest,
      "resolveProvider(feature: NativeAsyncCallableRuntimeFeature): RuntimeProviderDefinition;",
      "resolveProvider(feature: NativeAsyncCallableRuntimeFeature): undefined;",
    ],
    [manifest, "...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,", "...REFERENCE_ERROR_RUNTIME_PROVIDERS,"],
    [manifest, "...NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES,", "...PURE_MATH_RUNTIME_FEATURES,"],
    [manifest, "...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS,", "...PURE_MATH_RUNTIME_PROVIDER_IDS,"],
    [support, "readonly builtinDemands?:", "readonly builtinDemands:"],
    [support, "Explicit complete whole-program scan.", "Incomplete whole-program scan."],
    [
      support,
      "assertNativeAsyncCallableDemands(input.functions, input.builtinDemands)",
      "assertNativeAsyncCallableDemands([], input.builtinDemands)",
    ],
    [
      support,
      "nativeAsyncCallablePolicyMismatch(use.feature, input.policy)",
      "nativeAsyncCallablePolicyMismatch(use.feature, {})",
    ],
    [support, "runtimeCallFeatures.add(use.feature)", 'runtimeCallFeatures.add("math.sin")'],
    [support, "assertNativeAsyncRuntimeCallables(attached)", "assertNativeAsyncRuntimeCallables(fn)"],
    [support, "return attached;", "return fn;"],
    [callables, "ref: irRuntimeFuncRef(referenceError.field)", 'ref: irRuntimeFuncRef("wrong")'],
    [callables, "params: semanticTypes(referenceError.params)", "params: []"],
    [callables, "result: REFERENCE_ERROR_DECLARATION.results[0]!", "result: REFERENCE_ERROR_DECLARATION.params[0]!"],
    [callables, 'id: "native.error.reference.construct"', 'id: "host.error.reference.construct"'],
    [callables, 'symbol: "__new_ReferenceError"', 'symbol: "__wrong_ReferenceError"'],
    [callables, 'ref.binding.symbol === "__new_ReferenceError"', 'ref.binding.symbol === "__wrong_ReferenceError"'],
    [callables, "? REFERENCE_ERROR_DECLARATION", "? undefined"],
    [manifestContract, "Whole-program builtin demands;", "Changed builtin demands;"],
    [manifestContract, '"native.async.delay",', '"native.async.wrong",'],
    [manifest, '#state: BuilderState = "open"', '#state: BuilderState = "failed"'],
    [verifier, "post-freeze provider binding.", "changed provider binding."],
  ] as const)("rejects exact live callable delta mutation %s: %s", (path, before, after) => {
    const changed = mutation(path, (text) => text.replace(before, after));
    expect(() => acceptedCallablePositive(changed)).toThrow();
  });

  it.each([coreCallables, nativeCallables, callables, manifestContract, manifest, support])(
    "requires canonical file %s even when history does not copy it",
    (path) => {
      acceptedCallablePositive();
      const missing: SourceReader = (file) => {
        if (file === path) throw Error("missing mandatory canonical " + path);
        return read(file);
      };
      expect(() => acceptedCallablePositive(missing)).toThrow(/missing mandatory canonical/);
    },
  );

  it.each([
    [
      manifest,
      "import { REFERENCE_ERROR_SIGNATURE, REFERENCE_ERROR_RUNTIME_PROVIDERS }",
      "import type { REFERENCE_ERROR_SIGNATURE, REFERENCE_ERROR_RUNTIME_PROVIDERS }",
    ],
    [manifest, "export { REFERENCE_ERROR_RUNTIME_PROVIDERS }", "export type { REFERENCE_ERROR_RUNTIME_PROVIDERS }"],
    [
      manifest,
      "export { REFERENCE_ERROR_RUNTIME_PROVIDERS }",
      "export { REFERENCE_ERROR_SIGNATURE as REFERENCE_ERROR_RUNTIME_PROVIDERS }",
    ],
    [manifest, 'from "./callable-declarations.js"', 'from "./wrong-declarations.js"'],
    [callables, 'from "./native-async-callables.js"', 'from "../wrong-callables.js"'],
    [nativeCallables, 'from "../core/async-callables.js"', 'from "../async-semantic-runtime.js"'],
  ] as const)("rejects changed exact value/type forwarding %s", (path, before, after) => {
    const changed = mutation(path, (text) => text.replace(before, after));
    expect(() => acceptedCallablePositive(changed)).toThrow();
  });

  it.each([coreCallables, nativeCallables, callables, manifestContract, manifest, support])(
    "rejects new imports, stars, duplicate forwarding and future clock/vector additions in %s",
    (path) => {
      for (const extra of [
        '\nimport type { FutureClock } from "../clock.js";',
        '\nexport * from "./native-async-callables.js";',
        '\nexport { REFERENCE_ERROR_RUNTIME_PROVIDERS } from "./callable-declarations.js";',
        "\nexport function futureVectorDemands() { return []; }",
      ]) {
        const changed = mutation(path, (text) => text + extra);
        expect(() => acceptedCallablePositive(changed)).toThrow();
      }
    },
  );
});

describe("final clock/vector source before reverse-composition historical acceptance", () => {
  const coreVector = "src/ir/core/vector-runtime.ts";
  const vector = "src/ir/runtime/vector-callables.ts";
  const vectorFacade = "src/ir/vector-runtime.ts";
  const clockValidation = "src/ir/program-runtime-validation.ts";
  const importSpans = [
    [
      "src/ir/intrinsic-support.ts",
      'import {\n  assertVectorCallableDemands,\n  vectorCallablePolicyMismatch,\n  type IrVectorCallableDemand,\n} from "./runtime/vector-callables.js";',
    ],
    ["src/ir/runtime/callable-declarations.ts", 'import { irVectorCallableDeclaration } from "./vector-callables.js";'],
    [
      "src/ir/runtime/manifest.ts",
      'import {\n  NUMBER_BOUNDARY_POLICY_DISABLED,\n  BOOLEAN_BOUNDARY_POLICY_DISABLED,\n  EXTERN_IS_UNDEFINED_POLICY_DISABLED,\n  GENERATOR_NUMBER_BOX_POLICY_DISABLED,\n  STRING_COMPARE_POLICY_DISABLED,\n  STRING_EQ_POLICY_DISABLED,\n  STRING_LEN_POLICY_DISABLED,\n  STRING_CONCAT_POLICY_DISABLED,\n  STRING_CHAR_CODE_AT_POLICY_DISABLED,\n  STRING_CONCAT_MANY_POLICY_DISABLED,\n  STRING_CONST_POLICY_DISABLED,\n  HOST_CALLBACK_WRAP_POLICY_DISABLED,\n  FUNCTION_PROTOTYPE_CALL_POLICY_DISABLED,\n  type RuntimeTarget,\n  type RuntimeBackend,\n  type NumberBoundaryPolicy,\n  type BooleanBoundaryPolicy,\n  type ExternIsUndefinedPolicy,\n  type GeneratorNumberBoxPolicy,\n  type StringComparePolicy,\n  type StringEqPolicy,\n  type StringLenPolicy,\n  type StringConcatPolicy,\n  type StringCharCodeAtPolicy,\n  type StringConcatManyPolicy,\n  type StringConstPolicy,\n  type HostCallbackWrapPolicy,\n  type FunctionPrototypeCallPolicy,\n  type RuntimeManifestPolicy,\n  type FrozenRuntimeManifestPolicy,\n} from "../../runtime/contracts/provider-policy.js";',
    ],
    [
      "src/ir/runtime/manifest.ts",
      'import {\n  RUNTIME_BACKEND_REQUIREMENTS,\n  PURE_MATH_RUNTIME_PROVIDER_IDS,\n  NUMERIC_COERCION_RUNTIME_PROVIDER_IDS,\n  NUMBER_BOUNDARY_RUNTIME_PROVIDER_IDS,\n  BOOLEAN_BOUNDARY_RUNTIME_PROVIDER_IDS,\n  EXTERN_BOUNDARY_RUNTIME_PROVIDER_IDS,\n  GENERATOR_NUMBER_BOX_RUNTIME_FEATURES,\n  GENERATOR_NUMBER_BOX_RUNTIME_PROVIDER_IDS,\n  STRING_COMPARE_RUNTIME_FEATURES,\n  STRING_COMPARE_RUNTIME_PROVIDER_IDS,\n  STRING_EQ_RUNTIME_FEATURES,\n  STRING_EQ_RUNTIME_PROVIDER_IDS,\n  STRING_LEN_RUNTIME_FEATURES,\n  STRING_LEN_RUNTIME_PROVIDER_IDS,\n  STRING_CONCAT_RUNTIME_FEATURES,\n  STRING_CONCAT_RUNTIME_PROVIDER_IDS,\n  STRING_CHAR_CODE_AT_RUNTIME_FEATURES,\n  STRING_CHAR_CODE_AT_RUNTIME_PROVIDER_IDS,\n  STRING_CONCAT_MANY_RUNTIME_FEATURES,\n  STRING_CONCAT_MANY_RUNTIME_PROVIDER_IDS,\n  STRING_CONCAT_MANY_NATIVE_ARITY,\n  STRING_CONST_RUNTIME_FEATURES,\n  STRING_CONST_RUNTIME_PROVIDER_IDS,\n  HOST_CALLBACK_WRAP_RUNTIME_FEATURES,\n  HOST_CALLBACK_WRAP_RUNTIME_PROVIDER_IDS,\n  FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES,\n  FUNCTION_PROTOTYPE_CALL_RUNTIME_PROVIDER_IDS,\n  REFERENCE_ERROR_RUNTIME_FEATURES,\n  REFERENCE_ERROR_RUNTIME_PROVIDER_IDS,\n  VECTOR_CALLABLE_RUNTIME_FEATURES,\n  VECTOR_CALLABLE_RUNTIME_PROVIDER_IDS,\n  NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES,\n  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS,\n  type RuntimeFeature,\n  type HostCapabilityId,\n  type RuntimeBackendRequirement,\n  type NumberBoundaryRuntimeProviderId,\n  type BooleanBoundaryRuntimeProviderId,\n  type ExternBoundaryRuntimeProviderId,\n  type GeneratorNumberBoxRuntimeFeature,\n  type GeneratorNumberBoxRuntimeProviderId,\n  type StringCompareRuntimeFeature,\n  type StringCompareRuntimeProviderId,\n  type StringEqRuntimeFeature,\n  type StringEqRuntimeProviderId,\n  type StringLenRuntimeFeature,\n  type StringLenRuntimeProviderId,\n  type StringConcatRuntimeFeature,\n  type StringConcatRuntimeProviderId,\n  type StringCharCodeAtRuntimeFeature,\n  type StringCharCodeAtRuntimeProviderId,\n  type StringConcatManyRuntimeFeature,\n  type StringConcatManyRuntimeProviderId,\n  type StringConstRuntimeFeature,\n  type StringConstRuntimeProviderId,\n  type HostCallbackWrapRuntimeFeature,\n  type HostCallbackWrapRuntimeProviderId,\n  type FunctionPrototypeCallRuntimeFeature,\n  type FunctionPrototypeCallRuntimeProviderId,\n  type ReferenceErrorRuntimeFeature,\n  type NativeAsyncCallableRuntimeFeature,\n  type VectorCallableRuntimeFeature,\n  type RuntimeProviderId,\n  type RuntimeProviderImplementation,\n  type RuntimeProviderDefinition,\n  type RuntimeProviderPlan,\n  type RuntimeProviderComponent,\n  type FrozenRuntimeManifest,\n} from "./contracts/manifest.js";',
    ],
    [
      "src/ir/runtime/manifest.ts",
      'import {\n  VECTOR_CALLABLE_RUNTIME_PROVIDERS,\n  vectorProviderMismatch,\n  vectorCallablePolicyMismatch,\n} from "./vector-callables.js";',
    ],
    [
      "src/ir/runtime/manifest.ts",
      'import {\n  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,\n  nativeAsyncProviderMismatch,\n  nativeAsyncCallablePolicyMismatch,\n} from "./native-async-callables.js";',
    ],
    [
      "src/ir/intrinsic-support.ts",
      'import {\n  assertNativeAsyncCallableDemands,\n  assertNativeAsyncRuntimeCallables,\n  nativeAsyncCallablePolicyMismatch,\n  nativeAsyncProviderMismatch,\n  type IrNativeAsyncCallableDemand,\n} from "./runtime/native-async-callables.js";',
    ],
  ] as const;
  for (const change of ["missing", "duplicate", "movement", "type-only"] as const)
    it.each(importSpans)("rejects " + change + " current import inversion in %s", (path, before) => {
      const changed = mutation(path, (text) => {
        expect(text.split(before)).toHaveLength(2);
        if (change === "missing") return text.replace(before, "");
        if (change === "duplicate") return text.replace(before, before + "\n" + before);
        if (change === "type-only") return text.replace(before, before.replace("import {", "import type {"));
        const at = text.indexOf(before),
          end = at + before.length;
        const next = parseLive(path, read).statements.find((node) => node.getStart() > at)!;
        expect(next.getStart()).toBeGreaterThanOrEqual(end);
        return text.slice(0, at) + text.slice(end, next.end) + "\n" + before + text.slice(next.end);
      });
      expect(() => acceptedCallablePositive(changed)).toThrow();
    });
  const abiCaller = "src/ir/program-runtime-abi.ts";
  const runtimeCaller = "src/ir/runtime-program-manifest.ts";

  it("pins explicit intermediate views, overload ordinals and exact historical denominators", () => {
    acceptedCallablePositive();
    const middle = callableSourceView(read, "pre-vector-clock");
    const preClockView = callableSourceView(read, "pre-clock-callable");
    const census = (source: SourceReader) => {
      const file = parseLive(manifestContract, source);
      return [
        file.statements.filter(
          (node) => ts.isVariableStatement(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node),
        ).length,
        file.statements.filter((node) => ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)).length,
      ];
    };
    expect(census(read)).toEqual([75, 42]);
    expect(census(middle)).toEqual([71, 40]);
    expect(census(preClockView)).toEqual([71, 40]);
    expect(middle(support)).toContain('Object.hasOwn(nested, "alloc")');
    expect(preClockView(support)).not.toContain('Object.hasOwn(nested, "alloc")');
    expect(middle(support)).not.toContain("vectorDemands");
    expect(preClockView(support)).toContain("builtinDemands");
    const builderCensus = (source: SourceReader) => {
      const file = parseLive(manifest, source);
      const builder = file.statements.find(
        (node) => ts.isClassDeclaration(node) && node.name?.text === "RuntimeManifestBuilder",
      );
      if (!builder || !ts.isClassDeclaration(builder)) throw Error("missing actual builder");
      return [
        builder.members.length,
        builder.members.filter((member) => ts.isMethodDeclaration(member) && !member.body).length,
      ];
    };
    expect(builderCensus(read)).toEqual([37, 6]);
    expect(builderCensus(middle)).toEqual([36, 5]);
    expect(builderCensus(preClockView)).toEqual([36, 5]);
    for (const source of [middle, preClockView]) {
      const file = parseLive(support, source);
      const overloads = file.statements.filter(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === "prepareIrRuntimeManifest",
      );
      const live = currentDeclarations(support, read).filter((row) => row.name === "prepareIrRuntimeManifest");
      expect(overloads).toHaveLength(3);
      expect(overloads.slice(0, 2).map((node) => node.getText())).toEqual(live.slice(0, 2).map((row) => row.text));
    }
    for (const [path, count, functions] of [
      [coreVector, 10, 5],
      [vector, 12, 6],
      [clockValidation, 3, 3],
    ] as const) {
      const rows = currentDeclarations(path, read);
      expect(rows).toHaveLength(count);
      expect(rows.filter((row) => row.kind === "function")).toHaveLength(functions);
    }
    const error = currentDeclarations(vector, read).find((row) => row.name === "IrVectorCallableError")!;
    if (!ts.isClassDeclaration(error.node)) throw Error("missing actual vector error class");
    expect(error.node.members.filter(ts.isConstructorDeclaration)).toHaveLength(1);
    const facade = parseLive(vectorFacade, read);
    const exports = facade.statements.filter(ts.isExportDeclaration);
    expect(exports).toHaveLength(2);
    expect(
      exports.map((node) =>
        node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements.length : -1,
      ),
    ).toEqual([8, 1]);
    expect(exports.map((node) => node.isTypeOnly)).toEqual([false, true]);
  });

  const extensionRows = [
    [manifestContract, "VECTOR_CALLABLE_RUNTIME_FEATURES"],
    [manifestContract, "VectorCallableRuntimeFeature"],
    [manifestContract, "VECTOR_CALLABLE_RUNTIME_PROVIDER_IDS"],
    [manifestContract, "VectorCallableRuntimeProviderId"],
    ["src/ir/core/vector-runtime.ts", "IR_VEC_ELEM_SET_PREFIX"],
    ["src/ir/core/vector-runtime.ts", "IR_VEC_NEW_SIZED_PREFIX"],
    ["src/ir/core/vector-runtime.ts", "IR_HOLEY_ARRAY_NEW"],
    ["src/ir/core/vector-runtime.ts", "IR_HOLEY_ARRAY_ELEM_SET"],
    ["src/ir/core/vector-runtime.ts", "IrVectorRuntimeElementKind"],
    ["src/ir/core/vector-runtime.ts", "irVectorRuntimeElementKind"],
    ["src/ir/core/vector-runtime.ts", "requireRuntimeElementKind"],
    ["src/ir/core/vector-runtime.ts", "irVecElemSetSymbol"],
    ["src/ir/core/vector-runtime.ts", "irVecNewSizedSymbol"],
    ["src/ir/core/vector-runtime.ts", "parseIrVectorRuntimeElement"],
    ["src/ir/runtime/vector-callables.ts", "EXTERNREF"],
    ["src/ir/runtime/vector-callables.ts", "SYMBOL"],
    ["src/ir/runtime/vector-callables.ts", "VECTOR_CALLABLE_DECLARATION"],
    ["src/ir/runtime/vector-callables.ts", "irVectorCallableDeclaration"],
    ["src/ir/runtime/vector-callables.ts", "VECTOR_CALLABLE_RUNTIME_PROVIDERS"],
    ["src/ir/runtime/vector-callables.ts", "vectorProviderMismatch"],
    ["src/ir/runtime/vector-callables.ts", "vectorCallablePolicyMismatch"],
    ["src/ir/runtime/vector-callables.ts", "IrVectorCallableError"],
    ["src/ir/runtime/vector-callables.ts", "IrVectorCallableDemand"],
    ["src/ir/runtime/vector-callables.ts", "buffers"],
    ["src/ir/runtime/vector-callables.ts", "collectVectorCallableDemands"],
    ["src/ir/runtime/vector-callables.ts", "assertVectorCallableDemands"],
    ["src/ir/program-runtime-validation.ts", "assertPreparedIrSemanticRuntimeSeparation"],
    ["src/ir/program-runtime-validation.ts", "assertClockProjection"],
    ["src/ir/program-runtime-validation.ts", "assertPreparedIrRuntimeProjection"],
    ["src/ir/program-runtime-abi.ts", "prepareIrProgramRuntimeCallables"],
    ["src/ir/runtime-program-manifest.ts", "prepareWholeProgramRuntimeManifest"],
  ] as const;
  for (const change of ["missing", "duplicate", "reorder", "changed"] as const)
    it.each(extensionRows)("rejects " + change + " mandatory current extension %s#%s", (path, name) => {
      acceptedCallablePositive();
      const rows = currentDeclarations(path, read);
      let changed: SourceReader;
      if (change === "changed") {
        const row = rows.find((entry) => entry.name === name)!;
        changed = mutation(path, (text) => {
          const altered = row.text.replace(
            /\b(export|const|function|interface|class|type)\b/,
            "$& /* changed current extension */",
          );
          expect(altered).not.toBe(row.text);
          return text.slice(0, row.node.getStart()) + altered + text.slice(row.node.end);
        });
      } else {
        const selected = change === "reorder" && rows.at(-1)!.name === name ? rows.at(-2)!.name : name;
        changed = declarationMutation(path, selected, change);
      }
      expect(() => acceptedCallablePositive(changed)).toThrow();
    });

  const reversibleSpans = [
    {
      stage: "vector",
      index: 0,
      path: "src/ir/intrinsic-support.ts",
      before:
        "  readonly builtinDemands?: readonly IrNativeAsyncCallableDemand[];\n  /** Separate complete vector-callable occurrence census; omission preserves legacy selection. */\n  readonly vectorDemands?: readonly IrVectorCallableDemand[];\n}",
    },
    {
      stage: "vector",
      index: 1,
      path: "src/ir/intrinsic-support.ts",
      before:
        "  if (input.builtinDemands) assertNativeAsyncCallableDemands(input.functions, input.builtinDemands);\n  if (input.vectorDemands) assertVectorCallableDemands(input.functions, input.vectorDemands);\n  const uses: Array<{",
    },
    {
      stage: "vector",
      index: 2,
      path: "src/ir/intrinsic-support.ts",
      before:
        '      runtimeCallFeatures.add(use.feature);\n    }\n  for (const demand of input.vectorDemands ?? [])\n    for (const use of demand.uses) {\n      const mismatch = vectorCallablePolicyMismatch(use.feature, input.policy);\n      if (mismatch)\n        throw new RuntimeManifestInvariantError("provider-target-unavailable", mismatch, use.feature, use.feature);\n      runtimeCallFeatures.add(use.feature);\n    }\n  if (\n    !input.includeEmpty &&',
    },
    {
      stage: "vector",
      index: 3,
      path: "src/ir/runtime/callable-declarations.ts",
      before:
        "    ? REFERENCE_ERROR_DECLARATION\n    : (irNativeAsyncCallableDeclaration(ref) ?? irVectorCallableDeclaration(ref));",
    },
    {
      stage: "vector",
      index: 4,
      path: "src/ir/runtime/contracts/manifest.ts",
      before:
        "  | NativeAsyncCallableRuntimeFeature\n  | VectorCallableRuntimeFeature\n  | ReferenceErrorRuntimeFeature;",
    },
    {
      stage: "vector",
      index: 5,
      path: "src/ir/runtime/contracts/manifest.ts",
      before:
        "  | NativeAsyncCallableRuntimeProviderId\n  | VectorCallableRuntimeProviderId\n  | AsyncRuntimeProviderId;",
    },
    {
      stage: "vector",
      index: 6,
      path: "src/ir/runtime/manifest.ts",
      before:
        "    ...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,\n    ...VECTOR_CALLABLE_RUNTIME_PROVIDERS,\n    ...ASYNC_RUNTIME_PROVIDERS,",
    },
    {
      stage: "vector",
      index: 7,
      path: "src/ir/runtime/manifest.ts",
      before:
        "  ...NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES,\n  ...VECTOR_CALLABLE_RUNTIME_FEATURES,\n  ...ASYNC_RUNTIME_FEATURES,",
    },
    {
      stage: "vector",
      index: 8,
      path: "src/ir/runtime/manifest.ts",
      before:
        "  ...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS,\n  ...VECTOR_CALLABLE_RUNTIME_PROVIDER_IDS,\n  ...ASYNC_RUNTIME_PROVIDER_IDS,",
    },
    {
      stage: "vector",
      index: 9,
      path: "src/ir/runtime/manifest.ts",
      before:
        "  resolveProvider(feature: NativeAsyncCallableRuntimeFeature): RuntimeProviderDefinition;\n  resolveProvider(feature: VectorCallableRuntimeFeature): RuntimeProviderDefinition;\n  resolveProvider(feature: RuntimeFeature): RuntimeProviderDefinition {",
    },
    {
      stage: "vector",
      index: 10,
      path: "src/ir/runtime/manifest.ts",
      before:
        "    for (const provider of this.#providers) {\n      const nativeMismatch = nativeAsyncProviderMismatch(provider) ?? vectorProviderMismatch(provider);\n      if (nativeMismatch)",
    },
    {
      stage: "vector",
      index: 11,
      path: "src/ir/runtime/manifest.ts",
      before:
        "    const nativePolicyMismatch = NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES.some((entry) => entry === feature)\n      ? nativeAsyncCallablePolicyMismatch(feature, this.#policy)\n      : vectorCallablePolicyMismatch(feature, this.#policy);\n    if (nativePolicyMismatch)",
    },
    {
      stage: "clock",
      index: 0,
      path: "src/ir/intrinsic-support.ts",
      before:
        "function projectStandaloneAsyncStateInstr(instr: IrInstr): IrInstr {\n  const nested = mapNestedBuffers(instr, (buffer) => mapArray(buffer, projectStandaloneAsyncStateInstr));",
    },
    {
      stage: "clock",
      index: 1,
      path: "src/ir/intrinsic-support.ts",
      before:
        '    throw new Error("standalone async clock snapshot has a malformed semantic call");\n  }\n  if (Object.hasOwn(nested, "alloc")) {\n    throw new Error("standalone async clock snapshot cannot carry allocation metadata");\n  }\n  return {',
    },
    {
      stage: "clock",
      index: 2,
      path: "src/ir/intrinsic-support.ts",
      before:
        '    resultType: nested.resultType,\n    ...(Object.hasOwn(nested, "site") ? { site: nested.site } : {}),',
    },
    {
      stage: "clock",
      index: 3,
      path: "src/ir/intrinsic-support.ts",
      before:
        "  capabilityRecords: readonly RuntimeHostCapabilityRecord[],\n  projectClocks = false,\n): IrFunction {\n  const blocks = mapArray(fn.blocks, (block) => {",
    },
    {
      stage: "clock",
      index: 4,
      path: "src/ir/intrinsic-support.ts",
      before:
        "  const blocks = mapArray(fn.blocks, (block) => {\n    const attached = attachProvidersToBuffer(block.instrs, providers, capabilityRecords);\n    const instrs = projectClocks ? mapArray(attached, projectStandaloneAsyncStateInstr) : attached;\n    return instrs === block.instrs ? block : { ...block, instrs };",
    },
    {
      stage: "clock",
      index: 5,
      path: "src/ir/intrinsic-support.ts",
      before:
        '  const manifest = builder.freeze();\n  // The explicit whole-program demand vector is the compatibility boundary.\n  // Authenticate the selected frozen row by contents, not catalogue object identity.\n  const projectClocks =\n    input.builtinDemands?.some((demand) => demand.uses.some((use) => use.feature === "async.native.clock-zero")) ??\n    false;\n  if (projectClocks) {\n    const clockProviders = manifest.providers.filter(\n      (provider) =>\n        provider.feature === "async.native.clock-zero" ||\n        provider.id === "native.async.clock-zero" ||\n        provider.implementation.kind === "standalone-clock-zero",\n    );\n    const mismatch = nativeAsyncCallablePolicyMismatch("async.native.clock-zero", manifest.policy);\n    if (mismatch) throw new Error(mismatch);\n    if (clockProviders.length !== 1 || nativeAsyncProviderMismatch(clockProviders[0]!) !== undefined)\n      throw new Error("standalone async clock snapshot requires the unique canonical frozen clock provider");\n  }\n  const providers = new Map<IrInstrIntrinsic["id"], RuntimeProviderPlan>();',
    },
    {
      stage: "clock",
      index: 6,
      path: "src/ir/intrinsic-support.ts",
      before:
        "        const attached = attachProvidersToBuffer(state.body, providers, manifest.hostCapabilityRecords);\n        const body = nativeProjection ? mapArray(attached, projectStandaloneAsyncStateInstr) : attached;\n        return body === state.body ? state : Object.freeze({ ...state, body });",
    },
    {
      stage: "clock",
      index: 7,
      path: "src/ir/intrinsic-support.ts",
      before:
        "        try {\n          const attached = attachAsyncRuntime(\n            attachProviders(fn, providers, manifest.hostCapabilityRecords, projectClocks),\n          );\n          if (input.builtinDemands)",
    },
  ] as const;
  for (const change of ["missing", "duplicate", "movement", "changed"] as const)
    it.each(reversibleSpans)("rejects " + change + " $stage inverse span $index", ({ path, before }) => {
      const changed = mutation(path, (text) => {
        expect(text.split(before)).toHaveLength(2);
        if (change === "missing") return text.replace(before, "");
        if (change === "duplicate") return text.replace(before, before + "\n" + before);
        if (change === "changed")
          return text.replace(
            before,
            before.replace(/\S/, (token) => "/* changed inverse */" + token),
          );
        const at = text.indexOf(before),
          end = at + before.length,
          nextEnd = text.indexOf("\n", end + 1);
        expect(nextEnd).toBeGreaterThan(end);
        return text.slice(0, at) + text.slice(end, nextEnd + 1) + before + text.slice(nextEnd + 1);
      });
      expect(() => acceptedCallablePositive(changed)).toThrow();
    });

  it.each([
    [coreVector, "return value?.kind", "return false && value?.kind"],
    [coreVector, '"vector element store"', '"wrong vector operation"'],
    [vector, "nullable: true", "nullable: false"],
    [vector, 'feature: "js.vector.elem-set.externref"', 'feature: "async.native.all"'],
    [vector, "dependencies: Object.freeze([])", 'dependencies: Object.freeze(["scheduler.drain"])'],
    [
      vector,
      'policy.backend === "wasmgc" && policy.target === "standalone"',
      'policy.backend === "wasmgc" || policy.target === "standalone"',
    ],
    [vector, "let ordinal = 0;", "let ordinal = 1;"],
    [vector, "owners.add(fn.unitId)", "owners.add(functions[0]!.unitId)"],
    [vector, "JSON.stringify(demands[index])", "JSON.stringify(entry)"],
    [vector, 'this.name = "IrVectorCallableError"', 'this.name = "OtherError"'],
    [support, "readonly vectorDemands?:", "readonly vectorDemands:"],
    [
      support,
      "assertVectorCallableDemands(input.functions, input.vectorDemands)",
      "assertVectorCallableDemands([], input.vectorDemands)",
    ],
    [
      support,
      "vectorCallablePolicyMismatch(use.feature, input.policy)",
      "vectorCallablePolicyMismatch(use.feature, {})",
    ],
    [support, "for (const demand of input.vectorDemands ?? [])", "for (const demand of input.builtinDemands ?? [])"],
    [manifest, "vectorProviderMismatch(provider)", "vectorProviderMismatch(this.#providers[0]!)"],
    [manifest, "vectorCallablePolicyMismatch(feature, this.#policy)", "vectorCallablePolicyMismatch(feature, {})"],
    [
      manifest,
      "resolveProvider(feature: VectorCallableRuntimeFeature): RuntimeProviderDefinition;",
      "resolveProvider(feature: VectorCallableRuntimeFeature): undefined;",
    ],
    [manifest, "...VECTOR_CALLABLE_RUNTIME_PROVIDERS,", "...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,"],
    [manifest, "...VECTOR_CALLABLE_RUNTIME_FEATURES,", "...NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES,"],
    [manifest, "...VECTOR_CALLABLE_RUNTIME_PROVIDER_IDS,", "...NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS,"],
    [
      callables,
      "?? irVectorCallableDeclaration(ref)",
      "?? irVectorCallableDeclaration({ ...ref, binding: {kind: 'runtime', symbol: ''} })",
    ],
    [support, 'Object.hasOwn(nested, "alloc")', 'Object.hasOwn(nested, "site")'],
    [support, 'Object.hasOwn(nested, "site") ? { site: nested.site } : {}', "nested.site ? { site: nested.site } : {}"],
    [support, 'value: { kind: "f64", value: 0 }', 'value: { kind: "f64", value: -0 }'],
    [support, "projectClocks = false", "projectClocks = true"],
    [
      support,
      "projectClocks ? mapArray(attached, projectStandaloneAsyncStateInstr) : attached",
      "projectClocks ? attached : attached",
    ],
    [support, "clockProviders.length !== 1", "clockProviders.length > 1"],
    [support, "nativeAsyncProviderMismatch(clockProviders[0]!) !== undefined", "false"],
    [support, 'use.feature === "async.native.clock-zero"', 'use.feature === "async.native.delay"'],
    [
      support,
      "attachProviders(fn, providers, manifest.hostCapabilityRecords, projectClocks)",
      "attachProviders(fn, providers, manifest.hostCapabilityRecords, false)",
    ],
    [
      support,
      "nativeProjection ? mapArray(attached, projectStandaloneAsyncStateInstr) : attached",
      "nativeProjection ? attached : attached",
    ],
    [clockValidation, "assertClockProjection(program, projection);", ""],
    [clockValidation, "nativeAsyncProviderMismatch(providers[0]!) !== undefined", "false"],
    [clockValidation, "providers.length !== 1", "providers.length > 1"],
    [clockValidation, 'Object.hasOwn(original, "alloc")', "false"],
    [
      clockValidation,
      'Object.hasOwn(original, "site") ? { site: original.site } : {}',
      "original.site ? { site: original.site } : {}",
    ],
    [clockValidation, "!Object.is(selected.value.value, 0)", "selected.value.value !== 0"],
    [clockValidation, "if (before.length !== after.length)", "if (false)"],
    [clockValidation, "if (fn.unitId !== selected.unitId)", "if (false)"],
    [clockValidation, "compare(state.body, physical.body", "compare(state.body, state.body"],
    [abiCaller, "collectVectorCallableDemands([fn]);", "collectVectorCallableDemands([]);"],
    [abiCaller, " && !(error instanceof IrVectorCallableError)", ""],
    [
      runtimeCaller,
      "vectorDemands.push(collectVectorCallableDemands([fn])[0]!);",
      "collectVectorCallableDemands([fn]);",
    ],
    [runtimeCaller, "vectorDemands: Object.freeze(vectorDemands)", "vectorDemands: Object.freeze([])"],
    [runtimeCaller, " && !(error instanceof IrVectorCallableError)", ""],
  ] as const)("rejects semantic current clock/vector mutation %s: %s", (path, before, after) => {
    const changed = mutation(path, (text) => text.replace(before, after));
    expect(() => acceptedCallablePositive(changed)).toThrow();
  });

  it.each([coreVector, vector, vectorFacade, clockValidation, abiCaller, runtimeCaller])(
    "requires the live extension owner %s",
    (path) => {
      acceptedCallablePositive();
      const changed: SourceReader = (file) => {
        if (file === path) throw Error("missing composed canonical " + path);
        return read(file);
      };
      expect(() => acceptedCallablePositive(changed)).toThrow(/missing composed canonical/);
    },
  );

  it.each([
    [vectorFacade, "export {", "export type {"],
    [vectorFacade, "export type { IrVectorRuntimeElementKind }", "export { IrVectorRuntimeElementKind }"],
    [vectorFacade, "./core/vector-runtime.js", "./wrong-vector-runtime.js"],
    [manifest, "type VectorCallableRuntimeFeature,", "VectorCallableRuntimeFeature,"],
    [manifest, "type RuntimeTarget,", "RuntimeTarget,"],
    [support, "type IrVectorCallableDemand,", "IrVectorCallableDemand,"],
    [support, "  nativeAsyncProviderMismatch,", "  type nativeAsyncProviderMismatch,"],
    [
      abiCaller,
      "collectVectorCallableDemands, IrVectorCallableError",
      "collectVectorCallableDemands, type IrVectorCallableError",
    ],
    [runtimeCaller, "  IrVectorCallableError,", "  type IrVectorCallableError,"],
  ] as const)("rejects changed exact composed forwarding %s", (path, before, after) => {
    const changed = mutation(path, (text) => text.replaceAll(before, after));
    expect(() => acceptedCallablePositive(changed)).toThrow();
  });
});

function acceptedCallablePositive(source: SourceReader = read): void {
  assertCallableExtension(source);
  for (const path of [callables, manifestContract, "src/ir/runtime-manifest.ts", support])
    acceptedHistoricalDeclarations(path, source);
}

function mutation(path: string, edit: (text: string) => string): SourceReader {
  // A broken positive may never make mutation controls look green.
  acceptedCallablePositive();
  const before = read(path),
    after = edit(before);
  expect(after, "control must actually alter " + path).not.toBe(before);
  return (file) => (file === path ? after : read(file));
}

function declarationMutation(
  path: string,
  name: string,
  change: "missing" | "renamed" | "duplicate" | "reorder",
  ordinal = 0,
): SourceReader {
  const rows = currentDeclarations(path, read);
  const at = rows.findIndex((row) => row.name === name && row.ordinal === ordinal);
  expect(at).toBeGreaterThanOrEqual(0);
  const { node, file } = rows[at]!;
  return mutation(path, (text) => {
    if (change === "missing") return text.slice(0, node.getFullStart()) + text.slice(node.end);
    if (change === "duplicate") return text + "\n" + node.getFullText(file);
    if (change === "renamed")
      return text.slice(0, node.getStart()) + node.getText(file).replace(name, "Renamed" + name) + text.slice(node.end);
    const next = rows[at + 1]!.node;
    return text.slice(0, node.getFullStart()) + next.getFullText(file) + node.getFullText(file) + text.slice(next.end);
  });
}

describe("historical runtime receipts after checked extension reconstruction from mandatory live sources", () => {
  it.each([
    [contract, 20, 0],
    ["src/ir/async-runtime-providers.ts", 26, 12],
    ["src/ir/runtime-manifest.ts", 85, 38],
    ["src/ir/intrinsics.ts", 24, 5],
    ["src/ir/async-plan.ts", 48, 39],
    [support, 41, 24],
    [callables, 5, 2],
    [manifestContract, 67, 0],
  ] as const)("accepts original unchanged receipt %s (%i declarations/%i functions)", (path, count, functions) => {
    const rows = acceptedHistoricalDeclarations(path, read);
    expect(rows).toHaveLength(count);
    expect(rows.filter((row) => row.kind === "function")).toHaveLength(functions);
    expect(new Set(rows.map((row) => [row.path, row.kind, row.name, row.ordinal].join("#"))).size).toBe(count);
  });

  it("retains the three overload records with their individual source-qualified ordinals", () => {
    const rows = acceptedHistoricalDeclarations(support, read).filter((row) => row.name === "prepareIrRuntimeManifest");
    expect(rows.map(({ path, kind, ordinal }) => [path, kind, ordinal])).toEqual([
      [support, "function", 0],
      [support, "function", 1],
      [support, "function", 2],
    ]);
    expect(rows.map(({ node }) => ts.isFunctionDeclaration(node) && Boolean(node.body))).toEqual([false, false, true]);
  });

  it("rebases exactly the two live core imports without putting core contracts into historical graph population", () => {
    const source = historicalIntrinsicSource(read);
    const file = parseLive(contract, () => source);
    expect(file.statements.filter(ts.isImportDeclaration).map((node) => node.getText())).toEqual([
      'import type { IntrinsicId, IntrinsicSignatureVersion } from "../../core/intrinsic-vocabulary.js";',
      'import type { IrType } from "../../core/types.js";',
    ]);
    expect(file.statements.filter(ts.isExportDeclaration)).toHaveLength(0);
    expect(source).not.toContain("intrinsic-contracts.js");
    expect(source).not.toContain("CoreIntrinsicDefinition");
  });

  it.each(["missing", "renamed", "duplicate", "reorder"] as const)(
    "rejects a %s live core declaration before producing a fixture",
    (change) => {
      historicalIntrinsicSource(read);
      const changed = declarationMutation(core, "IntrinsicSignature", change);
      expect(() => historicalIntrinsicSource(changed)).toThrow();
    },
  );

  it.each([0, 1, 2])("rejects deletion of overload occurrence %i", (ordinal) => {
    const changed = declarationMutation(support, "prepareIrRuntimeManifest", "missing", ordinal);
    expect(() => acceptedHistoricalDeclarations(support, changed)).toThrow();
  });

  it.each(["renamed", "duplicate"] as const)("rejects a %s overload", (change) => {
    const changed = declarationMutation(support, "prepareIrRuntimeManifest", change, 1);
    expect(() => acceptedHistoricalDeclarations(support, changed)).toThrow();
  });

  it.each([
    [core, "Feature extends string", "Feature extends number"],
    [core, "readonly feature: Feature;", "feature: Feature;"],
    [core, "readonly feature: Feature;", ""],
    [core, "readonly id: IntrinsicId;", "readonly id?: IntrinsicId;"],
    [core, "readonly column: number;", "readonly column: string;"],
    [contract, "CoreIntrinsicDefinition<RuntimeFeature>", "CoreIntrinsicDefinition<string>"],
    [contract, "Provider requirements reachable", "Changed provider documentation reachable"],
    [contract, "IntrinsicDefinition as CoreIntrinsicDefinition", "IntrinsicUse as CoreIntrinsicDefinition"],
    [contract, "../../core/intrinsic-contracts.js", "../../core/wrong-contracts.js"],
    [core, "./types.js", "./wrong-types.js"],
    [core, "IntrinsicId, IntrinsicSignatureVersion", "IntrinsicId, WrongVersion"],
  ])("rejects live contract change %s: %s", (path, before, after) => {
    historicalIntrinsicSource(read);
    const changed = mutation(path!, (text) => text.replaceAll(before!, after!));
    expect(() => historicalIntrinsicSource(changed)).toThrow();
  });

  it.each([core, contract])("rejects forbidden extra imports, exports and syntax in %s", (path) => {
    historicalIntrinsicSource(read);
    for (const extra of [
      '\nimport type { Program } from "../../program.js";',
      '\nexport type { Extra } from "../../program.js";',
      '\nimport extra = require("../../program.js");',
      "\nconst extra = import(globalThis.toString());",
      "\nexport interface Malformed {",
    ]) {
      const changed = mutation(path, (text) => text + extra);
      expect(() => historicalIntrinsicSource(changed)).toThrow();
    }
  });

  it("fails when mandatory core contracts are absent even though the historical fixture does not copy that module", () => {
    historicalIntrinsicSource(read);
    const missing: SourceReader = (path) => {
      if (path === core) throw new Error("missing mandatory current core contract");
      return read(path);
    };
    expect(() => historicalIntrinsicSource(missing)).toThrow(/missing mandatory/);
  });

  it.each([
    [
      intrinsic,
      '"math.sin": definition("math.sin", F64_UNARY_INTRINSIC_SIGNATURE)',
      '"math.sin": definition("math.cos", F64_UNARY_INTRINSIC_SIGNATURE)',
      "src/ir/intrinsics.ts",
    ],
    [intrinsic, "Record typing makes an added ID fail closed.", "Changed table documentation.", "src/ir/intrinsics.ts"],
    [
      intrinsic,
      "return Object.freeze({ id, signature, feature });",
      "return { id, signature, feature };",
      "src/ir/intrinsics.ts",
    ],
    [intrinsic, "function definition(", "function* definition(", "src/ir/intrinsics.ts"],
    [manifest, '#state: BuilderState = "open"', '#state: BuilderState = "failed"', "src/ir/runtime-manifest.ts"],
    [manifest, 'this.#state = "building";', 'this.#state = "failed";', "src/ir/runtime-manifest.ts"],
    [attachment, "if (!previous) preparedManifestByPlan.delete(input.plan);", "", "src/ir/async-plan.ts"],
    ["src/ir/intrinsics.ts", "= canonicalIntrinsicDefinitions;", "= {} as never;", "src/ir/intrinsics.ts"],
  ])("rejects changed initializer/body/private field/documentation in %s", (path, before, after, historical) => {
    acceptedHistoricalDeclarations(historical!, read);
    const changed = mutation(path!, (text) => text.replace(before!, after!));
    expect(() => acceptedHistoricalDeclarations(historical!, changed)).toThrow();
  });

  it.each([
    [semantic, "export function verifyIrIntrinsicSignature", "export async function verifyIrIntrinsicSignature"],
    [semantic, "export function verifyIrIntrinsicSignature", "export function* verifyIrIntrinsicSignature"],
    [semantic, "export function verifyIrIntrinsicSignature", "function verifyIrIntrinsicSignature"],
    [semantic, "return errors;", "return [];"],
    [verifier, "const errors = [...verifyIrIntrinsicSignature(instr, typeOf)];", "const errors: string[] = [];"],
    [verifier, "verifyIrIntrinsicSignature(instr, typeOf)", "verifyIrIntrinsicSignature(instr, new Map())"],
    [verifier, "binding.symbol !== instr.id", "binding.symbol === instr.id"],
    [
      verifier,
      "Verify the closed semantic signature and any post-freeze provider binding.",
      "Changed wrapper documentation.",
    ],
    [verifier, "return errors;", "errors.length = 0; return errors;"],
  ])("rejects altered semantic result/adapter/provider suffix in %s", (path, before, after) => {
    const changed = mutation(path!, (text) => text.replace(before!, after!));
    expect(() => acceptedHistoricalDeclarations(support, changed)).toThrow();
  });

  it("rejects reordered provider suffix statements rather than canonicalizing them", () => {
    const file = parseLive(verifier, read),
      fn = file.statements.find(
        (node) => ts.isFunctionDeclaration(node) && node.name?.text === "verifyIrIntrinsicInstruction",
      ) as ts.FunctionDeclaration;
    expect(fn.body!.statements).toHaveLength(4);
    const first = fn.body!.statements[1]!,
      second = fn.body!.statements[2]!;
    expect(ts.isIfStatement(first)).toBe(true);
    expect(ts.isIfStatement(second)).toBe(true);
    const changed = mutation(
      verifier,
      (text) =>
        text.slice(0, first.getFullStart()) +
        second.getFullText(file) +
        first.getFullText(file) +
        text.slice(second.end),
    );
    expect(() => acceptedHistoricalDeclarations(support, changed)).toThrow();
  });

  it.each([
    [intrinsic, "F64_TYPE", "src/ir/intrinsics.ts"],
    [semantic, "IntrinsicEffectEvidence", "src/ir/intrinsics.ts"],
    [manifest, "ALL_TARGETS", "src/ir/runtime-manifest.ts"],
    [attachment, "preparedManifestByPlan", "src/ir/async-plan.ts"],
  ])("rejects reordered canonical declarations from %s", (path, name, historical) => {
    acceptedHistoricalDeclarations(historical!, read);
    const changed = declarationMutation(path!, name!, "reorder");
    expect(() => acceptedHistoricalDeclarations(historical!, changed)).toThrow(/current declaration order/);
  });

  it.each(["star", "wrong target", "duplicate", "renamed", "local replacement"] as const)(
    "rejects a %s live forwarding hop",
    (change) => {
      const path = "src/ir/async-runtime-providers.ts",
        owner = "src/ir/runtime/async-providers.ts",
        name = "ASYNC_RUNTIME_PROVIDERS";
      assertNamedForward(path, owner, name, false, read);
      const changed = mutation(path, (text) => {
        if (change === "star") return text + '\nexport * from "./runtime/async-providers.js";';
        if (change === "wrong target") return text.replaceAll("./runtime/async-providers.js", "./wrong.js");
        if (change === "duplicate")
          return text + '\nexport { ASYNC_RUNTIME_PROVIDERS } from "./runtime/async-providers.js";';
        if (change === "renamed")
          return text.replace("  ASYNC_RUNTIME_PROVIDERS,", "  WRONG as ASYNC_RUNTIME_PROVIDERS,");
        return text + "\nexport const ASYNC_RUNTIME_PROVIDERS = [];";
      });
      expect(() => assertNamedForward(path, owner, name, false, changed)).toThrow();
    },
  );
});
