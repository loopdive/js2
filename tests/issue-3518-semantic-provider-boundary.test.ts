import { captureDenoPostPositionMainPredecessorPolicySource } from "./helpers/ir-deno-post-position-main-successor.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { capturePositionFinallyMainPredecessorPolicySource } from "./helpers/ir-position-finally-main-successor.js";
import { capturePositionClassFieldsMainPredecessorPolicySource } from "./helpers/ir-position-class-fields-main-successor.js";
import { captureSourceMapPositionInventoryPredecessorPolicySource } from "./helpers/ir-source-map-position-inventory-successor.js";
import { captureMainInventoryPredecessorPolicySource } from "./helpers/ir-main-inventory-source-successor.js";
import {
  captureArrayBufferIsViewMainPredecessorPolicy,
  capturePresentationClassificationPredecessorPolicy,
  captureLoweringAnalysisPredecessorPolicy,
  captureWasmGcHelperPredecessorPolicy,
} from "./helpers/ir-runtime-program-policy-evolution.js";
import { captureProgramValidatorPredecessorPolicy } from "./helpers/ir-runtime-program-policy-evolution.js";

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";
import {
  beforeIrValidationPolicyActivations,
  irValidationPolicyActivations,
} from "./helpers/ir-validation-policy-evolution.js";
import {
  captureNestedStackificationPredecessorPolicy,
  captureCanonical489dPredecessorPolicy,
  beforeCanonical3c6InventoryPolicy,
  beforeGeneratorInventoryPolicy,
  beforeHostCarrierInventoryPolicy,
  beforeDynamicCodeInventoryPolicy,
  beforeRuntimePreparationPolicy,
  authenticateNumberPrerequisitePolicy,
  beforeNumberPrerequisitePolicy,
  beforeWellKnownSymbolPolicy,
  beforeIrRuntimeProgramPolicy,
  type MutableIrRuntimeProgramPolicy,
  beforeCurrentMainInventoryPolicy,
} from "./helpers/ir-runtime-program-policy-evolution.js";

const repository = resolve(import.meta.dirname, "..");
// Fixed specification population, independent of discovered imports and policy.
const historicalGroups = {
  foundation: [
    "source-origin",
    "ir-identity",
    "identity-values",
    "ir-counted-string-identity",
    "ir-preparation-failure",
    "ir-unit-inventory",
  ].map((x) => `src/shared/contracts/${x}.ts`),
  "wasm-model": ["src/wasm/model/instructions.ts", "src/wasm/model/module-records.ts"],
  "wasm-physical": [
    "src/wasm/physical/function-handles.ts",
    "src/wasm/physical/function-types.ts",
    "src/wasm/physical/module-reservations.ts",
    "src/wasm/physical/exception-control.ts",
    "src/wasm/physical/type-layout.ts",
  ],
  "native-runtime": [
    "src/runtime/wasmgc/async/microtask-queue-bodies.ts",
    "src/runtime/wasmgc/promise/settlement-bodies.ts",
    "src/runtime/wasmgc/async/frame-engine.ts",
    "src/runtime/wasmgc/async/native-await.ts",
    "src/runtime/wasmgc/promise/delay-bodies.ts",
    "src/runtime/wasmgc/promise/combinator-bodies.ts",
  ],
  "ir-core": [
    "types",
    "fnctor-shapes",
    "value-references",
    "capability-provenance",
    "tag-refinement",
    "nodes",
    "dialect/js",
    "async-plan",
    "intrinsic-vocabulary",
    "async-intents",
    "string-types",
    "binding-key-primitives",
    "intrinsic-contracts",
    "intrinsics",
    "callable-bindings",
    "async-callables",
    "vector-runtime",
  ].map((x) => `src/ir/core/${x}.ts`),
  "ir-analysis": ["contracts/allocations", "alloc-registry", "effects", "intrinsics", "async-plan"].map(
    (x) => `src/ir/analysis/${x}.ts`,
  ),
  "ir-passes": ["src/ir/passes/contracts/gvn.ts"],
  "ir-runtime": [
    "index",
    "contracts/intrinsics",
    "contracts/manifest",
    "contracts/prepared",
    "host-capabilities",
    "async-providers",
    "callable-declarations",
    "manifest",
    "async-attachment",
    "intrinsic-verification",
    "native-async-callables",
    "vector-callables",
  ].map((x) => `src/ir/runtime/${x}.ts`),
  "ir-program": [
    "abi-inventory",
    "abi",
    "startup",
    "abi-lookup",
    "callable-bindings",
    "controls",
    "index",
    "input-contracts",
    "prepared-contracts",
    "errors",
    "data",
    "input",
  ].map((x) => `src/ir/program/${x}.ts`),
  "runtime-contracts": ["host-capability-schema", "async-provider-schema", "provider-policy", "index"].map(
    (x) => `src/runtime/contracts/${x}.ts`,
  ),
};
const physicalVectorAdditions = [
  "src/ir/program/native-vector-resources.ts",
  "src/runtime/wasmgc/values/vector-grow-store.ts",
  "src/backend/wasmgc/resources/native-vectors.ts",
];
const vectorGroups = {
  ...historicalGroups,
  "ir-program": [...historicalGroups["ir-program"], physicalVectorAdditions[0]!],
  "native-runtime": [...historicalGroups["native-runtime"], physicalVectorAdditions[1]!],
  "backend-wasmgc": [physicalVectorAdditions[2]!],
};
const resolutionAdditions = [
  "src/runtime/wasmgc/promise/resolution-bodies.ts",
  "src/runtime/wasmgc/promise/thenable-bodies.ts",
];
const resolutionGroups = {
  ...vectorGroups,
  "native-runtime": [...vectorGroups["native-runtime"], ...resolutionAdditions],
};
const promiseResourceAdditions = [
  "src/ir/program/native-promise-resources.ts",
  "src/backend/wasmgc/resources/native-promises.ts",
];
const promiseGroups = {
  ...resolutionGroups,
  "ir-program": [...resolutionGroups["ir-program"], promiseResourceAdditions[0]!],
  "backend-wasmgc": [...resolutionGroups["backend-wasmgc"], promiseResourceAdditions[1]!],
};
const stringErrorAdditions = [
  "src/runtime/wasmgc/values/string-layouts.ts",
  "src/runtime/wasmgc/values/string-literal-bodies.ts",
  "src/runtime/wasmgc/values/error-bodies.ts",
  "src/backend/wasmgc/resources/native-string-literals.ts",
  "src/backend/wasmgc/resources/native-errors.ts",
];
const stringErrorGroups = {
  ...promiseGroups,
  "native-runtime": [...promiseGroups["native-runtime"], ...stringErrorAdditions.slice(0, 3)],
  "backend-wasmgc": [...promiseGroups["backend-wasmgc"], ...stringErrorAdditions.slice(3)],
};
const nativeValueAdditions = [
  "src/ir/program/native-value-resources.ts",
  "src/runtime/wasmgc/values/primitive-layouts.ts",
  "src/runtime/wasmgc/values/number-bodies.ts",
  "src/backend/wasmgc/resources/native-values.ts",
];
const nativeValueGroups = {
  ...stringErrorGroups,
  "ir-program": [...stringErrorGroups["ir-program"], nativeValueAdditions[0]!],
  "native-runtime": [...stringErrorGroups["native-runtime"], ...nativeValueAdditions.slice(1, 3)],
  "backend-wasmgc": [...stringErrorGroups["backend-wasmgc"], nativeValueAdditions[3]!],
};
const scannerAdditions = [
  "src/wasm/model/instruction-walk.ts",
  "src/runtime/wasmgc/values/string-number-grammar.ts",
  "src/runtime/wasmgc/values/decimal-scale-bodies.ts",
  "src/runtime/wasmgc/values/string-number-bodies.ts",
  "src/runtime/wasmgc/values/string-flatten-bodies.ts",
  "src/runtime/wasmgc/values/string-utf8-decode-bodies.ts",
  "src/backend/wasmgc/resources/native-string-number.ts",
  "src/backend/wasmgc/resources/native-string-flatten.ts",
];
const scannerGroups = {
  ...nativeValueGroups,
  "wasm-model": [...nativeValueGroups["wasm-model"], scannerAdditions[0]!],
  "native-runtime": [...nativeValueGroups["native-runtime"], ...scannerAdditions.slice(1, 6)],
  "backend-wasmgc": [...nativeValueGroups["backend-wasmgc"], ...scannerAdditions.slice(6)],
};
const argumentVectorAdditions = [
  "src/runtime/wasmgc/values/argument-vector-bodies.ts",
  "src/backend/wasmgc/resources/native-argument-vectors.ts",
];
const argumentVectorGroups = {
  ...nativeValueGroups,
  "native-runtime": [...nativeValueGroups["native-runtime"], argumentVectorAdditions[0]!],
  "backend-wasmgc": [...nativeValueGroups["backend-wasmgc"], argumentVectorAdditions[1]!],
};
const closureAdditions = [
  "src/runtime/wasmgc/values/closure-layouts.ts",
  "src/backend/wasmgc/resources/native-closures.ts",
];
const closureGroups = {
  ...argumentVectorGroups,
  "native-runtime": [...argumentVectorGroups["native-runtime"], closureAdditions[0]!],
  "backend-wasmgc": [...argumentVectorGroups["backend-wasmgc"], closureAdditions[1]!],
};
const demandAdditions = ["src/ir/program/native-string-value-demands.ts"];
const priorGroups = {
  ...scannerGroups,
  "ir-program": [...scannerGroups["ir-program"], ...demandAdditions],
  "native-runtime": [...scannerGroups["native-runtime"], argumentVectorAdditions[0]!, closureAdditions[0]!],
  "backend-wasmgc": [...scannerGroups["backend-wasmgc"], argumentVectorAdditions[1]!, closureAdditions[1]!],
};
const declarationAdditions = [
  "src/runtime/wasmgc/values/native-resource-declaration-types.ts",
  "src/backend/wasmgc/resources/native-resource-declarations.ts",
];
const publishedDeclarationGroups = {
  ...scannerGroups,
  "native-runtime": [...scannerGroups["native-runtime"], declarationAdditions[0]!],
  "backend-wasmgc": [...scannerGroups["backend-wasmgc"], declarationAdditions[1]!],
};
const declarationGroups = {
  ...priorGroups,
  "native-runtime": [...priorGroups["native-runtime"], declarationAdditions[0]!],
  "backend-wasmgc": [...priorGroups["backend-wasmgc"], declarationAdditions[1]!],
};
const aggregateAdditions = ["src/backend/wasmgc/program/native-string-values.ts"];
const mainGroups = {
  ...declarationGroups,
  "backend-wasmgc": [...declarationGroups["backend-wasmgc"], ...aggregateAdditions],
};
const formatterGroups = {
  "frontend-ts": ["src/frontend/builtins/contracts.ts"],
  "ir-core": ["src/ir/core/type-references.ts"],
  "ir-program": ["src/ir/program/runtime-support.ts", "src/ir/program/formatter-support.ts"],
};
const formatterAdditions = Object.values(formatterGroups).flat();
const groups = {
  ...mainGroups,
  "frontend-ts": formatterGroups["frontend-ts"],
  "ir-core": [...mainGroups["ir-core"], ...formatterGroups["ir-core"]],
  "ir-program": [...mainGroups["ir-program"], ...formatterGroups["ir-program"]],
};
const required = Object.values(groups).flat();
// Keep the historical 102-owner receipt archival; main now requires four
// canonical formatter contracts, each present once in the current fixture.
const semanticCallableAdditions = [
  "src/ir/runtime/number-conversion-callable.ts",
  "src/ir/runtime/ordinary-object-callables.ts",
];
// Fixed realm-join dependency census, reviewed from actual imports. The
// historical fixture population and signed policy receipts remain unchanged.
const realmFixtureAdditions = {
  "ir-program": ["src/ir/program/native-realm-requirements.ts"],
  "backend-wasmgc": [
    "src/backend/wasmgc/program/native-realm-literals.ts",
    "src/backend/wasmgc/resources/native-builtin-function-requests.ts",
    "src/backend/wasmgc/resources/native-object-descriptors.ts",
    "src/backend/wasmgc/resources/native-string-descriptor-selection.ts",
    "src/backend/wasmgc/resources/native-object-storage.ts",
    "src/backend/wasmgc/resources/native-object-same-value.ts",
    "src/backend/wasmgc/resources/native-string-exotic-own-descriptors.ts",
    "src/backend/wasmgc/resources/native-object-access.ts",
    "src/backend/wasmgc/resources/native-bigint.ts",
    "src/backend/wasmgc/resources/native-string-equality.ts",
    "src/backend/wasmgc/resources/native-primitive-wrapper-layouts.ts",
    "src/backend/wasmgc/resources/native-object-layouts.ts",
    "src/backend/wasmgc/resources/native-symbol-carrier.ts",
    "src/backend/wasmgc/resources/native-object-access-declarations.ts",
    "src/backend/wasmgc/resources/native-realm-object-layouts.ts",
  ],
  "runtime-contracts": ["src/runtime/contracts/native-realm-catalog.ts"],
  "native-runtime": [
    "src/runtime/wasmgc/values/ordinary-object-descriptor-common.ts",
    "src/runtime/wasmgc/values/ordinary-object-descriptor-definitions.ts",
    "src/runtime/wasmgc/values/ordinary-object-descriptor-data.ts",
    "src/runtime/wasmgc/values/ordinary-object-descriptor-accessor.ts",
    "src/runtime/wasmgc/values/closure-receiver-bodies.ts",
    "src/runtime/wasmgc/values/ordinary-object-storage-definitions.ts",
    "src/runtime/wasmgc/values/object-same-value-body.ts",
    "src/runtime/wasmgc/values/string-exotic-bodies.ts",
    "src/runtime/wasmgc/values/string-exotic-define-body.ts",
    "src/runtime/wasmgc/values/ordinary-object-storage-bodies.ts",
    "src/runtime/wasmgc/values/ordinary-object-key-definitions.ts",
    "src/runtime/wasmgc/values/ordinary-object-access-bodies.ts",
    "src/runtime/wasmgc/values/bigint-carrier-body.ts",
    "src/runtime/wasmgc/values/bigint-carrier-layouts.ts",
    "src/runtime/wasmgc/values/bigint-finalized-layouts.ts",
    "src/runtime/wasmgc/values/string-equality-body.ts",
    "src/runtime/wasmgc/values/primitive-wrapper-layouts.ts",
    "src/runtime/wasmgc/values/realm-object-layouts.ts",
    "src/runtime/wasmgc/values/object-key-bodies.ts",
    "src/runtime/wasmgc/values/object-layouts.ts",
    "src/runtime/wasmgc/values/symbol-carrier-bodies.ts",
    "src/runtime/wasmgc/values/closure-capture-layouts.ts",
  ],
};
const priorLiveFixtureGroups = {
  ...groups,
  "runtime-contracts": [
    ...groups["runtime-contracts"],
    "src/runtime/contracts/js-value-tags.ts",
    ...realmFixtureAdditions["runtime-contracts"],
  ],
  "ir-runtime": [
    ...groups["ir-runtime"],
    ...semanticCallableAdditions,
    "src/ir/runtime/closure-invocation-callables.ts",
  ],
  "ir-core": [
    ...groups["ir-core"],
    "src/ir/core/string-callables.ts",
    "src/ir/core/closure-invocation-callables.ts",
    "src/ir/core/type-key.ts",
  ],
  "ir-program": [
    ...groups["ir-program"],
    ...realmFixtureAdditions["ir-program"],
    "src/ir/program/native-string-output-requirements.ts",
    "src/ir/program/population.ts",
    "src/ir/program/abi-signatures.ts",
    "src/ir/program/callable-results.ts",
    "src/ir/program/native-source-closure-requirements.ts",
    "src/ir/program/native-ref-cell-requirements.ts",
    "src/ir/program/runtime-abi-identity.ts",
    "src/ir/program/native-promise-inventory.ts",
    "src/ir/program/native-object-access-requirements.ts",
    "src/ir/program/native-object-result-values.ts",
    "src/ir/program/native-object-result-requirements.ts",
    "src/ir/program/native-getter-invocation-requirements.ts",
    "src/ir/program/native-invocation-requirements.ts",
  ],
  "native-runtime": [
    ...groups["native-runtime"],
    ...realmFixtureAdditions["native-runtime"],
    "src/runtime/wasmgc/values/boolean-bodies.ts",
    "src/runtime/wasmgc/values/bigint-primitive-bodies.ts",
    "src/runtime/wasmgc/values/string-concat-bodies.ts",
    "src/runtime/wasmgc/values/stdout-bodies.ts",
  ],
  "backend-wasmgc": [
    ...groups["backend-wasmgc"],
    ...realmFixtureAdditions["backend-wasmgc"],
    "src/backend/wasmgc/resources/native-booleans.ts",
    "src/backend/wasmgc/program/native-string-output.ts",
    "src/backend/wasmgc/resources/native-string-output.ts",
    "src/backend/wasmgc/program/native-invocation-abi.ts",
    "src/backend/wasmgc/program/native-primitive-boundary-abi.ts",
  ],
};
const priorLiveRequired = Object.values(priorLiveFixtureGroups).flat();
// Fixed actual source-map validator dependency closure, independently reviewed.
// Keep the prior live population and every historical mutation matrix unchanged.
const sourceMapValidatorFixtureAdditions = {
  "ir-program": [
    "src/ir/program/validation.ts",
    "src/ir/program/runtime-abi.ts",
    "src/ir/program/class-layouts.ts",
    "src/ir/program/allocations.ts",
    "src/ir/program/runtime-support-dependencies.ts",
    "src/ir/program/runtime-validation.ts",
    "src/ir/program/owner.ts",
    "src/ir/program/draft-abi-lookup.ts",
    "src/ir/program/runtime-demands.ts",
    "src/ir/program/runtime-manifest.ts",
  ],
  "ir-core": [
    "src/ir/core/global-binding-keys.ts",
    "src/ir/core/type-binding-keys.ts",
    "src/ir/core/declared-types.ts",
    "src/ir/core/tag-domain.ts",
    "src/ir/core/fnctor-abi.ts",
    "src/ir/core/string-runtime.ts",
    "src/ir/core/runtime-symbols.ts",
  ],
  "ir-runtime": [
    "src/ir/runtime/verify.ts",
    "src/ir/runtime/producer.ts",
    "src/ir/runtime/js-tag-domain.ts",
    "src/ir/runtime/generator-support.ts",
    "src/ir/runtime/intrinsic-preparation.ts",
  ],
  foundation: [
    "src/shared/contracts/ir-counted-string-site-id.ts",
    "src/shared/contracts/ir-preparation-errors.ts",
    "src/shared/contracts/string-surrogate.ts",
  ],
  "ir-analysis": [
    "src/ir/analysis/dominance.ts",
    "src/ir/analysis/ownership.ts",
    "src/ir/analysis/escape.ts",
    "src/ir/analysis/encoding.ts",
    "src/ir/analysis/alloc-verification.ts",
    "src/ir/analysis/lattice.ts",
  ],
};
const validatorLiveFixtureGroups = {
  ...priorLiveFixtureGroups,
  "ir-program": [...priorLiveFixtureGroups["ir-program"], ...sourceMapValidatorFixtureAdditions["ir-program"]],
  "ir-core": [...priorLiveFixtureGroups["ir-core"], ...sourceMapValidatorFixtureAdditions["ir-core"]],
  "ir-runtime": [...priorLiveFixtureGroups["ir-runtime"], ...sourceMapValidatorFixtureAdditions["ir-runtime"]],
  foundation: [...priorLiveFixtureGroups["foundation"], ...sourceMapValidatorFixtureAdditions["foundation"]],
  "ir-analysis": [...priorLiveFixtureGroups["ir-analysis"], ...sourceMapValidatorFixtureAdditions["ir-analysis"]],
};
const validatorLiveRequired = Object.values(validatorLiveFixtureGroups).flat();
// Fixed Deno Promise owners required by the actual native body imports.
const denoNativeFixtureAdditions = [
  "src/runtime/wasmgc/promise/reaction-order-bodies.ts",
  "src/runtime/wasmgc/promise/rejection-event-bodies.ts",
  "src/runtime/wasmgc/promise/resolving-pair-bodies.ts",
] as const;
const remainderLiveFixtureAddition = "src/ir/runtime/number-remainder-callables.ts";
const liveFixtureGroups = {
  ...validatorLiveFixtureGroups,
  "ir-runtime": [...validatorLiveFixtureGroups["ir-runtime"], remainderLiveFixtureAddition],
  "native-runtime": [...validatorLiveFixtureGroups["native-runtime"], ...denoNativeFixtureAdditions],
};
const liveRequired = Object.values(liveFixtureGroups).flat();
// Ordered additions independently reviewed at published policy 1eaa57abc,
// and checked against local composition 19a0a9bd8c2c.
// This is the full current layer contract, not the bounded live fixture.
const currentLayerGroups = {
  ...groups,
  "ir-program": [...groups["ir-program"], "src/ir/program/native-number-format-requirements.ts"],
  "native-runtime": [
    ...groups["native-runtime"],
    "src/runtime/wasmgc/values/number-ryu-tables.ts",
    "src/runtime/wasmgc/values/number-ryu-bodies.ts",
    "src/runtime/wasmgc/values/number-ryu-digits.ts",
    "src/runtime/wasmgc/values/number-ryu-to-buffer.ts",
    "src/runtime/wasmgc/values/number-ryu-signatures.ts",
    "src/runtime/wasmgc/values/number-format-bodies.ts",
    "src/runtime/wasmgc/values/number-format-radix-bodies.ts",
    "src/runtime/wasmgc/values/string-concat-bodies.ts",
    "src/runtime/wasmgc/values/stdout-bodies.ts",
    "src/runtime/wasmgc/promise/delay-combinator-layouts.ts",
  ],
  "backend-wasmgc": [
    ...groups["backend-wasmgc"],
    "src/backend/wasmgc/program/native-number-format.ts",
    "src/backend/wasmgc/resources/native-number-ryu.ts",
    "src/backend/wasmgc/resources/native-number-format.ts",
    "src/backend/wasmgc/resources/native-delay-combinator.ts",
  ],
};
// Archival graph receipt: 102 modules, 391 edges (248 type-only / 143 runtime).
// This is not a fresh historical execution; expanded current sources are measured below.

const callableAdditions = ["src/ir/core/async-callables.ts", "src/ir/runtime/native-async-callables.ts"];
const vectorAdditions = ["src/ir/core/vector-runtime.ts", "src/ir/runtime/vector-callables.ts"];
const typeLayoutAdditions = ["src/wasm/physical/type-layout.ts"];
const delayCombinatorAdditions = [
  "src/runtime/wasmgc/promise/delay-bodies.ts",
  "src/runtime/wasmgc/promise/combinator-bodies.ts",
];
const settlementAdditions = ["src/runtime/wasmgc/promise/settlement-bodies.ts"];
const frameAdditions = [
  "src/runtime/wasmgc/async/frame-engine.ts",
  "src/runtime/wasmgc/async/native-await.ts",
  "src/wasm/physical/exception-control.ts",
];
const physicalAdditions = [
  "src/wasm/model/module-records.ts",
  "src/wasm/physical/function-types.ts",
  "src/wasm/physical/module-reservations.ts",
];
const additions = [
  "src/ir/core/intrinsic-contracts.ts",
  "src/ir/core/intrinsics.ts",
  "src/ir/core/callable-bindings.ts",
  "src/ir/analysis/effects.ts",
  "src/ir/analysis/intrinsics.ts",
  "src/ir/analysis/async-plan.ts",
  "src/ir/runtime/host-capabilities.ts",
  "src/ir/runtime/async-providers.ts",
  "src/ir/runtime/callable-declarations.ts",
  "src/ir/runtime/manifest.ts",
  "src/ir/runtime/async-attachment.ts",
  "src/ir/runtime/intrinsic-verification.ts",
];
const policy = () => {
  const actual = beforeRuntimePreparationPolicy(
    beforeDynamicCodeInventoryPolicy(
      beforeHostCarrierInventoryPolicy(
        beforeGeneratorInventoryPolicy(
          beforeCurrentMainInventoryPolicy(
            beforeCanonical3c6InventoryPolicy(
              captureCanonical489dPredecessorPolicy(
                captureNestedStackificationPredecessorPolicy(
                  captureProgramValidatorPredecessorPolicy(
                    captureWasmGcHelperPredecessorPolicy(
                      captureLoweringAnalysisPredecessorPolicy(
                        capturePresentationClassificationPredecessorPolicy(
                          captureArrayBufferIsViewMainPredecessorPolicy(
                            JSON.parse(
                              captureMainInventoryPredecessorPolicySource(
                                captureSourceMapPositionInventoryPredecessorPolicySource(
                                  capturePositionClassFieldsMainPredecessorPolicySource(
                                    capturePositionFinallyMainPredecessorPolicySource(
                                      captureDenoPostPositionMainPredecessorPolicySource(
                                        readFileSync(resolve(repository, "scripts/compiler-boundaries.json"), "utf8"),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  authenticateNumberPrerequisitePolicy(actual);
  return actual;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Preserve the exact published prerequisite composition as an ordered subsequence,
// alongside the complete delivered-main history. The first two records retain
// their original entry ordering, even where the active populations now agree.
const originalCompositionOffsets = [
  0, 1, 3, 4, 7, 8, 10, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37,
  38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62,
];
function assertOriginalComposition(history: unknown[]) {
  const original = originalCompositionOffsets.map((index) => history[index]);
  expect(digest(original)).toBe("4aa271504137eac71e91ef4956fc1b3fe6ced60bd3262c3375046c11d9f0b329");
  expect(digest([...original.slice(2, 9), ...original.slice(13)])).toBe(
    "4040a7108cfae3cc4746d38c1f68167d51556ba84d9a8f2f6fb44534ccb08680",
  );
  expect(digest([...original.slice(9, 13), ...original.slice(13)])).toBe(
    "dfd3286a35182705e7d692244e756c3b592803831013232a5c0f2f71cdf8e9ac",
  );
}
function assertNewActivations(history: unknown[]) {
  expect(history.slice(0, 3)).toEqual(
    Object.entries(formatterGroups).map(([layer, entries]) => ({ layer, entries, minModules: entries.length })),
  );
  // Keep the full delivered main history and all its original digest checks.
  history = history.slice(3);
  assertOriginalComposition(history);
  history = history.slice(2);
  // The combined declaration and both published 9ccad45c additions precede
  // the exact complete activation history independently read from eac9f741.
  expect(history[0]).toEqual({
    layer: "backend-wasmgc",
    entries: mainGroups["backend-wasmgc"],
    minModules: mainGroups["backend-wasmgc"].length,
  });
  expect(history[1]).toEqual({
    layer: "backend-wasmgc",
    entries: [...publishedDeclarationGroups["backend-wasmgc"], ...aggregateAdditions],
    minModules: publishedDeclarationGroups["backend-wasmgc"].length + aggregateAdditions.length,
  });
  expect(history[2]).toEqual({
    layer: "ir-program",
    entries: mainGroups["ir-program"],
    minModules: mainGroups["ir-program"].length,
  });
  expect(digest(history.slice(1, 3))).toBe("025f946401a0b57c22705361d4b69f314cad7e0c2aa856dcf0834fe74858ea3a");
  history = history.slice(3);
  expect(digest(history)).toBe("476fd97c07cd737123d32db1a0e4c7647e4993d5aa44b5726ebf35ca073bca47");
  expect(history.slice(0, 2)).toEqual(
    (["native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: declarationGroups[layer],
      minModules: declarationGroups[layer].length,
    })),
  );
  history = history.slice(2);
  expect(history.slice(0, 2)).toEqual(
    (["native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: publishedDeclarationGroups[layer],
      minModules: publishedDeclarationGroups[layer].length,
    })),
  );
  history = history.slice(2);
  expect(history[0]).toEqual({
    layer: "ir-program",
    entries: priorGroups["ir-program"],
    minModules: priorGroups["ir-program"].length,
  });
  history = history.slice(1);
  expect(history.slice(0, 3)).toEqual(
    (["wasm-model", "native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: priorGroups[layer],
      minModules: priorGroups[layer].length,
    })),
  );
  history = history.slice(3);
  expect(history.slice(0, 3)).toEqual(
    (["wasm-model", "native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: scannerGroups[layer],
      minModules: scannerGroups[layer].length,
    })),
  );
  history = history.slice(3);
  expect(history.slice(0, 2)).toEqual(
    (["native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: closureGroups[layer],
      minModules: closureGroups[layer].length,
    })),
  );
  history = history.slice(2);
  expect(history.slice(0, 2)).toEqual(
    (["native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: argumentVectorGroups[layer],
      minModules: argumentVectorGroups[layer].length,
    })),
  );
  history = history.slice(2);
  expect(history.slice(0, 3)).toEqual(
    (["ir-program", "native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: nativeValueGroups[layer],
      minModules: nativeValueGroups[layer].length,
    })),
  );
  history = history.slice(3);
  expect(history.slice(0, 2)).toEqual(
    (["native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: stringErrorGroups[layer],
      minModules: stringErrorGroups[layer].length,
    })),
  );
  history = history.slice(2);
  expect(history.slice(0, 2)).toEqual(
    (["ir-program", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: promiseGroups[layer],
      minModules: promiseGroups[layer].length,
    })),
  );
  history = history.slice(2);
  expect(history[0]).toEqual({
    layer: "native-runtime",
    entries: resolutionGroups["native-runtime"],
    minModules: 9,
  });
  history = history.slice(1);
  expect(history.slice(0, 3)).toEqual(
    (["ir-program", "native-runtime", "backend-wasmgc"] as const).map((layer) => ({
      layer,
      entries: vectorGroups[layer],
      minModules: vectorGroups[layer].length,
    })),
  );
  history = history.slice(3);
  expect(history.slice(0, 2)).toEqual(
    (["ir-core", "ir-runtime"] as const).map((layer) => ({
      layer,
      entries: historicalGroups[layer],
      minModules: historicalGroups[layer].length,
    })),
  );
  history = history.slice(2);
  expect(history.slice(0, 2)).toEqual(
    (["ir-core", "ir-runtime"] as const).map((layer) => ({
      layer,
      entries: historicalGroups[layer].filter((path) => !vectorAdditions.includes(path)),
      minModules: historicalGroups[layer].length - 1,
    })),
  );
  history = history.slice(2);
  expect(history[0]).toEqual({ layer: "wasm-physical", entries: historicalGroups["wasm-physical"], minModules: 5 });
  expect(history[1]).toEqual({ layer: "native-runtime", entries: historicalGroups["native-runtime"], minModules: 6 });
  expect(history.slice(2, 4)).toEqual(
    (["native-runtime", "wasm-physical"] as const).map((layer) => ({
      layer,
      entries: historicalGroups[layer].filter(
        (path) =>
          ![...delayCombinatorAdditions, ...typeLayoutAdditions, ...callableAdditions, ...vectorAdditions].includes(
            path,
          ),
      ),
      minModules: historicalGroups[layer].filter(
        (path) =>
          ![...delayCombinatorAdditions, ...typeLayoutAdditions, ...callableAdditions, ...vectorAdditions].includes(
            path,
          ),
      ).length,
    })),
  );
  expect(history.slice(4, 10)).toEqual(
    (["native-runtime", "wasm-model", "wasm-physical", "ir-core", "ir-analysis", "ir-runtime"] as const).map(
      (layer) => ({
        layer,
        entries: historicalGroups[layer].filter(
          (path) =>
            ![
              ...frameAdditions,
              ...delayCombinatorAdditions,
              ...typeLayoutAdditions,
              ...callableAdditions,
              ...vectorAdditions,
            ].includes(path),
        ),
        minModules: historicalGroups[layer].filter(
          (path) =>
            ![
              ...frameAdditions,
              ...delayCombinatorAdditions,
              ...typeLayoutAdditions,
              ...callableAdditions,
              ...vectorAdditions,
            ].includes(path),
        ).length,
      }),
    ),
  );
}
// Exact intervening signed composition: preserve the original 75-record proof below.
const interveningActivations = [
  {
    layer: "backend-wasmgc",
    entries: [
      "src/backend/wasmgc/async/prepared-async-frame-adapter.ts",
      "src/backend/wasmgc/resources/prepared-async-frame.ts",
    ],
    minModules: 2,
  },
  {
    layer: "ir-program",
    entries: [
      "src/ir/program/async-frame-setup.ts",
      "src/ir/program/prepared-async-frame-plan.ts",
      "src/ir/program/abi-signatures.ts",
    ],
    minModules: 3,
  },
  {
    layer: "native-runtime",
    entries: [
      "src/runtime/wasmgc/async/frame-defaults.ts",
      "src/runtime/wasmgc/async/prepared-async-frame-engine.ts",
      "src/runtime/wasmgc/async/prepared-async-frame-types.ts",
    ],
    minModules: 3,
  },
  {
    layer: "ir-core",
    entries: ["src/ir/core/type-binding-keys.ts", "src/ir/core/type-key.ts"],
    minModules: 2,
  },
  {
    layer: "ir-program",
    entries: ["src/ir/program/host-async-dynamic.ts"],
    minModules: 1,
  },
  {
    layer: "ir-program",
    entries: ["src/ir/program/host-import-plan.ts", "src/ir/program/host-number-boundary-setup.ts"],
    minModules: 2,
  },
];
const booleanAdditions = {
  "native-runtime": "src/runtime/wasmgc/values/boolean-bodies.ts",
  "backend-wasmgc": "src/backend/wasmgc/resources/native-booleans.ts",
} as const;
const signedLayerComposition = {
  foundation: {
    entriesSha256: "0c82c6ef1e9cdc4a3d5ac23b84e58dffd8b547794d84f236107234a0e7efff19",
    minModules: 6,
  },
  "wasm-model": {
    entriesSha256: "3d5f9da2f25cea8676407c56c2a2bfbf6496fa96c985fd91a646062f79ba5ef1",
    minModules: 3,
  },
  "wasm-physical": {
    entriesSha256: "bedf46dac03a20c813a9484e17c2dcfd9489b284333c3d3edd15c635706f1e7d",
    minModules: 5,
  },
  "frontend-ts": {
    entriesSha256: "e1ffbf692bc76068c856f9df56c5b6927ee997d6058e0f72df9d67a3e47c9e6f",
    minModules: 3,
  },
  "ir-core": {
    entriesSha256: "230571170e29dd9625543d48bb80d89834bbdf875f908e5e5e1df44da3b25e23",
    minModules: 21,
  },
  "ir-analysis": {
    entriesSha256: "f20e2aaaa3707ddf1213f93be9a36f41704ed01da9324358d99c72b7ac941401",
    minModules: 5,
  },
  "ir-passes": {
    entriesSha256: "75104b0b06c8b28202b9495496c29f3218451aeb90bd8568efe7d7ea3f5b3b4d",
    minModules: 1,
  },
  "ir-runtime": {
    entriesSha256: "d2d39ae1bf77938b93d9e69fff4cabee6ada2bf7413be2fce70514400f18a11a",
    minModules: 12,
  },
  "ir-program": {
    entriesSha256: "a781a3ebad443020dd73fbce212704e467d6b869f7139864f78f71586a92bb4e",
    minModules: 27,
  },
  "runtime-contracts": {
    entriesSha256: "9d116d868df3fc66877e007063dd4a1073fb8e43e1341a17bf684d05940bfe01",
    minModules: 5,
  },
  "backend-wasmgc": {
    entriesSha256: "ee02751a4e8399ca9f8207ec3c90ddbfbae63fe6e61127fbad5a44f7f13e76f4",
    minModules: 23,
  },
  "native-runtime": {
    entriesSha256: "27addaaf4efcbad980f1ade89b9e620687b868b4c8047afbe59ff10aa004323b",
    minModules: 50,
  },
} as const;
// Independently matched to signed cb64af7b's additions over fdaa; the
// existing 97ee composition and its original per-layer digests stay intact.
const mergedInvocationAdditions: Readonly<Record<string, readonly string[]>> = {
  "ir-core": ["src/ir/core/closure-invocation-callables.ts"],
  "ir-runtime": ["src/ir/runtime/closure-invocation-callables.ts"],
  "ir-program": [
    "src/ir/program/callable-results.ts",
    "src/ir/program/native-source-closure-requirements.ts",
    "src/ir/program/population.ts",
    "src/ir/program/native-ref-cell-requirements.ts",
    "src/ir/program/native-invocation-requirements.ts",
  ],
  "backend-wasmgc": [
    "src/backend/wasmgc/resources/native-source-closures.ts",
    "src/backend/wasmgc/resources/native-ref-cells.ts",
    "src/backend/wasmgc/program/native-invocation-abi.ts",
    "src/backend/wasmgc/resources/native-invocation.ts",
    "src/backend/wasmgc/resources/native-source-closure-callables.ts",
  ],
  "native-runtime": [
    "src/runtime/wasmgc/values/closure-apply-body.ts",
    "src/runtime/wasmgc/values/closure-argument-bodies.ts",
    "src/runtime/wasmgc/values/closure-capture-layouts.ts",
    "src/runtime/wasmgc/values/closure-invocation-bodies.ts",
    "src/runtime/wasmgc/values/closure-invocation-types.ts",
    "src/runtime/wasmgc/values/closure-method-body.ts",
    "src/runtime/wasmgc/values/closure-receiver-bodies.ts",
    "src/runtime/wasmgc/values/closure-result-bodies.ts",
    "src/runtime/wasmgc/values/ref-cell-layouts.ts",
    "src/runtime/wasmgc/values/closure-vector-apply-body.ts",
  ],
};
// Independently authenticated against signed B890cd3b5 and its parent;
// overlap with the existing ordinary-object catalogue is excluded.
const mergedObjectStorageAdditions: Readonly<Record<string, readonly string[]>> = {
  "ir-program": ["src/ir/program/native-object-access-requirements.ts"],
  "backend-wasmgc": [
    "src/backend/wasmgc/resources/native-object-access-declarations.ts",
    "src/backend/wasmgc/resources/native-object-access.ts",
    "src/backend/wasmgc/resources/native-object-storage.ts",
  ],
  "native-runtime": [
    "src/runtime/wasmgc/values/object-same-value-body.ts",
    "src/runtime/wasmgc/values/ordinary-object-access-bodies.ts",
    "src/runtime/wasmgc/values/ordinary-object-descriptor-accessor.ts",
    "src/runtime/wasmgc/values/ordinary-object-descriptor-common.ts",
    "src/runtime/wasmgc/values/ordinary-object-descriptor-data.ts",
    "src/runtime/wasmgc/values/ordinary-object-key-definitions.ts",
    "src/runtime/wasmgc/values/ordinary-object-storage-bodies.ts",
    "src/runtime/wasmgc/values/ordinary-object-storage-definitions.ts",
  ],
};
// Add only the current getter/result proof leaves; signed layer receipts and
// the complete historical activation sequence remain unchanged below.
const getterResultAdditions = [
  "src/ir/program/native-getter-invocation-requirements.ts",
  "src/ir/program/native-object-result-requirements.ts",
  "src/ir/program/native-object-result-values.ts",
];
const mergedInvocationActivations = [
  {
    layer: "ir-program",
    entries: [
      "src/ir/program/callable-results.ts",
      "src/ir/program/native-source-closure-requirements.ts",
      "src/ir/program/population.ts",
    ],
    minModules: 3,
  },
  {
    layer: "backend-wasmgc",
    entries: ["src/backend/wasmgc/resources/native-source-closures.ts"],
    minModules: 1,
  },
  {
    layer: "native-runtime",
    entries: [
      "src/runtime/wasmgc/values/closure-apply-body.ts",
      "src/runtime/wasmgc/values/closure-argument-bodies.ts",
      "src/runtime/wasmgc/values/closure-capture-layouts.ts",
      "src/runtime/wasmgc/values/closure-invocation-bodies.ts",
      "src/runtime/wasmgc/values/closure-invocation-types.ts",
      "src/runtime/wasmgc/values/closure-method-body.ts",
      "src/runtime/wasmgc/values/closure-receiver-bodies.ts",
      "src/runtime/wasmgc/values/closure-result-bodies.ts",
    ],
    minModules: 8,
  },
];
const sourceContractActivations = [
  {
    layer: "foundation",
    entries: [
      "src/shared/contracts/ir-preparation-errors.ts",
      "src/shared/contracts/ir-counted-string-site-id.ts",
      "src/shared/contracts/string-surrogate.ts",
    ],
    minModules: 3,
  },
  {
    layer: "ir-core",
    entries: [
      "src/ir/core/global-binding-keys.ts",
      "src/ir/core/declared-types.ts",
      "src/ir/core/fnctor-abi.ts",
      "src/ir/core/tag-domain.ts",
      "src/ir/core/string-runtime.ts",
      "src/ir/core/runtime-symbols.ts",
      "src/ir/core/date-callables.ts",
    ],
    minModules: 7,
  },
  {
    layer: "ir-runtime",
    entries: ["src/ir/runtime/js-tag-domain.ts", "src/ir/runtime/producer.ts"],
    minModules: 2,
  },
];

// Authenticate the additive prefix before examining the unchanged old history.
function assertCurrentActivations(history: unknown[]) {
  history = beforeIrValidationPolicyActivations(history);
  expect(history).toHaveLength(91);
  expect(history.slice(88)).toEqual(sourceContractActivations);
  history = history.slice(0, 88);
  expect(history).toHaveLength(88);
  expect(history.slice(85)).toEqual(mergedInvocationActivations);
  expect(history.slice(75, 81)).toEqual(interveningActivations);
  expect(history.slice(81, 83)).toEqual(
    Object.entries(booleanAdditions).map(([layer, path]) => ({ layer, entries: [path], minModules: 1 })),
  );
  expect(history[83]).toEqual({
    layer: "native-runtime",
    entries: ["src/runtime/wasmgc/values/bigint-primitive-bodies.ts"],
    minModules: 1,
  });
  expect(history[84]).toEqual({ layer: "ir-runtime", entries: semanticCallableAdditions, minModules: 2 });
  history = history.slice(0, 75);
  expect(history).toHaveLength(75);
  // Exact d132 records remain an ordered subsequence; all main records remain
  // a contiguous suffix. Original hashes and record order stay independent.
  const offsets = [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 19, 20, 22, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37,
    38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66,
    67, 68, 69, 70, 71, 72, 73, 74,
  ];
  const published = offsets.map((index) => history[index]);
  expect(published).toHaveLength(68);
  expect(digest(published)).toBe("645fd9f35c7495ac3effdad394a4fb807f15b77fd5d97f93d30ae3b6ad988b1c");
  expect(digest(published.slice(0, 12))).toBe("527f561bf9497c469352d9671615d33740b5ed95d17815c5cadb206d45711e07");
  const historical = published.slice(12);
  expect(historical).toHaveLength(56);
  expect(digest(historical.slice(32))).toBe("3437a59aacf39df9dffcafa8099ac9f47c0f43a7a0ecc423df4c1fe3e638f002");
  expect(digest(historical.slice(38))).toBe("a6d07b900b0837832707ce083202ab6ffa40f0bbe6bfce25f3062270882b26da");
  const main = history.slice(9);
  expect(main).toHaveLength(66);
  assertNewActivations(main);
  return main;
}

const scratch: string[] = [];
afterEach(async () => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
  // Each detector invocation is synchronous. Let worker result acknowledgments
  // drain between controls instead of starving RPC for the entire population.
  await setImmediate();
});

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "js2-semantic-provider-boundary-"));
  scratch.push(root);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(resolve(root, path)), { recursive: true });
    writeFileSync(resolve(root, path), text);
  };
  const p = policy();
  p.requireGitProvenance = false;
  p.layers = p.layers.map((layer: { id: string; roots: string[] }) => {
    const entries = liveFixtureGroups[layer.id as keyof typeof liveFixtureGroups];
    return entries
      ? { ...layer, status: "active", required: true, entries, minModules: entries.length }
      : { id: layer.id, roots: layer.roots, status: "debt" };
  });
  p.files = Object.entries(liveFixtureGroups).flatMap(([layer, paths]) =>
    paths.map((path) => ({ path, layer, state: "clean" })),
  );
  p.activationHistory = Object.entries(liveFixtureGroups).map(([layer, entries]) => ({
    layer,
    entries,
    minModules: entries.length,
  }));
  p.moves = [];
  p.evidence = [];
  p.nonModules = [];
  p.externalPackages = [];
  p.externalAssets = [];
  for (const path of liveRequired) put(path, readFileSync(resolve(repository, path), "utf8"));
  put(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: { "@forbidden": ["src/forbidden.ts"] },
      },
      include: ["src"],
    }),
  );
  const run = (mode = "inventory") => {
    put("policy.json", JSON.stringify(p));
    const child = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=2048",
        resolve(repository, "scripts/check-compiler-boundaries.mjs"),
        "--root",
        root,
        "--config",
        "policy.json",
        "--mode",
        mode,
      ],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    return { status: child.status, report: JSON.parse(child.stdout) };
  };
  const append = (path: string, text: string) => put(path, readFileSync(resolve(root, path), "utf8") + "\n" + text);
  return { root, p, put, append, run };
}

type FixtureRun = ReturnType<ReturnType<typeof fixture>["run"]>;
type FixtureEdge = { from: string; to?: string; typeOnly: boolean };
function edgePopulation(edges: FixtureEdge[]) {
  return {
    edges: edges.length,
    typeOnly: edges.filter((edge) => edge.typeOnly).length,
    runtime: edges.filter((edge) => !edge.typeOnly).length,
  };
}

function assertLiveFixtureClosure(r: FixtureRun) {
  expect(r.status, JSON.stringify(r.report.errors)).toBe(0);
  expect(r.report.errors).toEqual([]);
  expect(r.report.graphComplete).toBe(true);
  expect(r.report.inventoryValid).toBe(true);
  for (const field of ["unknownEdges", "unresolvedEdges", "forbiddenEdges", "transitiveViolations"])
    expect(r.report[field]).toEqual([]);
  expect(required).toHaveLength(106);
  expect(priorLiveRequired).toHaveLength(174);
  expect(new Set(priorLiveRequired).size).toBe(174);
  const additions = Object.values(sourceMapValidatorFixtureAdditions).flat();
  expect(additions).toHaveLength(31);
  expect(new Set(additions).size).toBe(31);
  const added = new Set(additions);
  expect(priorLiveRequired.filter((path) => added.has(path))).toEqual([]);
  expect(validatorLiveRequired).toHaveLength(205);
  expect(new Set(validatorLiveRequired).size).toBe(205);
  expect(denoNativeFixtureAdditions).toHaveLength(3);
  expect(new Set(denoNativeFixtureAdditions).size).toBe(3);
  const denoAdded = new Set<string>(denoNativeFixtureAdditions);
  expect(validatorLiveRequired.filter((path) => denoAdded.has(path))).toEqual([]);
  expect(liveRequired).toHaveLength(208 + 1);
  expect(new Set(liveRequired).size).toBe(208 + 1);
  expect(validatorLiveRequired).not.toContain(remainderLiveFixtureAddition);
  expect(liveRequired.filter((path) => !denoAdded.has(path) && path !== remainderLiveFixtureAddition)).toEqual(
    validatorLiveRequired,
  );
  expect(validatorLiveFixtureGroups["native-runtime"]).toHaveLength(48);
  expect(liveFixtureGroups["native-runtime"]).toHaveLength(51);
  for (const [layer, paths] of Object.entries(liveFixtureGroups)) {
    expect(paths.filter((path) => !denoAdded.has(path) && path !== remainderLiveFixtureAddition)).toEqual(
      validatorLiveFixtureGroups[layer as keyof typeof validatorLiveFixtureGroups],
    );
    expect(
      paths.filter((path) => !added.has(path) && !denoAdded.has(path) && path !== remainderLiveFixtureAddition),
    ).toEqual(priorLiveFixtureGroups[layer as keyof typeof priorLiveFixtureGroups]);
    expect(r.report.counts.byLayer[layer]).toBe(paths.length);
    expect(
      r.report.modules
        .filter((module: { layer: string }) => module.layer === layer)
        .map((module: { path: string }) => module.path)
        .sort(),
    ).toEqual([...paths].sort());
  }
  expect(r.report.counts.total).toBe(208 + 1);
  expect(r.report.modules).toHaveLength(208 + 1);
  const edges: FixtureEdge[] = r.report.edges;
  const remainderEdges: FixtureEdge[] = [
    { from: "src/ir/runtime/callable-declarations.ts", to: remainderLiveFixtureAddition, typeOnly: false },
    { from: "src/ir/runtime/intrinsic-preparation.ts", to: remainderLiveFixtureAddition, typeOnly: false },
    { from: remainderLiveFixtureAddition, to: "src/ir/core/callable-bindings.ts", typeOnly: false },
    { from: remainderLiveFixtureAddition, to: "src/ir/core/value-references.ts", typeOnly: true },
    { from: remainderLiveFixtureAddition, to: "src/ir/core/types.ts", typeOnly: true },
    { from: remainderLiveFixtureAddition, to: "src/ir/runtime/callable-declarations.ts", typeOnly: true },
    { from: remainderLiveFixtureAddition, to: "src/ir/runtime/contracts/manifest.ts", typeOnly: true },
  ];
  const orderedEdges = (values: FixtureEdge[]) =>
    values
      .map(({ from, to, typeOnly }) => ({ from, to, typeOnly }))
      .sort((left, right) => left.from.localeCompare(right.from) || left.to!.localeCompare(right.to!));
  expect(
    orderedEdges(
      edges.filter((edge) => edge.from === remainderLiveFixtureAddition || edge.to === remainderLiveFixtureAddition),
    ),
  ).toEqual(orderedEdges(remainderEdges));
  expect(edgePopulation(remainderEdges)).toEqual({ edges: 7, typeOnly: 4, runtime: 3 });
  // This runtime edge is load-bearing: CLI exit zero alone admits its bypass.
  expect(
    edges.filter((edge) => edge.from === "src/ir/program/input.ts" && edge.to === "src/ir/program/validation.ts"),
  ).toEqual([expect.objectContaining({ typeOnly: false })]);
  expect({ edges: r.report.resolvedEdgeCount, ...r.report.counts.resolvedEdgesByType }).toEqual({
    edges: 988 + 7,
    typeOnly: 480 + 4,
    runtime: 508 + 3,
  });
  expect(edgePopulation(edges)).toEqual({ edges: 988 + 7, typeOnly: 480 + 4, runtime: 508 + 3 });
  const validator = new Set(validatorLiveRequired);
  const validatorEdges = edges.filter(
    (edge) => validator.has(edge.from) && edge.to !== undefined && validator.has(edge.to),
  );
  expect(edgePopulation(validatorEdges)).toEqual({ edges: 977, typeOnly: 476, runtime: 501 });
  const denoEdges = edges.filter(
    (edge) =>
      !validatorEdges.includes(edge) &&
      edge.from !== remainderLiveFixtureAddition &&
      edge.to !== remainderLiveFixtureAddition,
  );
  expect(edgePopulation(denoEdges)).toEqual({ edges: 11, typeOnly: 4, runtime: 7 });
  const expectedDenoEdges = [
    {
      from: "src/runtime/wasmgc/async/native-await.ts",
      to: "src/runtime/wasmgc/promise/rejection-event-bodies.ts",
      typeOnly: false,
    },
    {
      from: "src/runtime/wasmgc/promise/combinator-bodies.ts",
      to: "src/runtime/wasmgc/promise/rejection-event-bodies.ts",
      typeOnly: false,
    },
    {
      from: "src/runtime/wasmgc/promise/reaction-order-bodies.ts",
      to: "src/wasm/model/instructions.ts",
      typeOnly: true,
    },
    {
      from: "src/runtime/wasmgc/promise/rejection-event-bodies.ts",
      to: "src/wasm/model/instructions.ts",
      typeOnly: true,
    },
    {
      from: "src/runtime/wasmgc/promise/resolution-bodies.ts",
      to: "src/runtime/wasmgc/promise/rejection-event-bodies.ts",
      typeOnly: false,
    },
    {
      from: "src/runtime/wasmgc/promise/resolution-bodies.ts",
      to: "src/runtime/wasmgc/promise/resolving-pair-bodies.ts",
      typeOnly: false,
    },
    {
      from: "src/runtime/wasmgc/promise/resolving-pair-bodies.ts",
      to: "src/wasm/model/instructions.ts",
      typeOnly: true,
    },
    {
      from: "src/runtime/wasmgc/promise/resolving-pair-bodies.ts",
      to: "src/runtime/wasmgc/promise/resolution-bodies.ts",
      typeOnly: true,
    },
    {
      from: "src/runtime/wasmgc/promise/resolving-pair-bodies.ts",
      to: "src/runtime/wasmgc/promise/rejection-event-bodies.ts",
      typeOnly: false,
    },
    {
      from: "src/runtime/wasmgc/promise/settlement-bodies.ts",
      to: "src/runtime/wasmgc/promise/reaction-order-bodies.ts",
      typeOnly: false,
    },
    {
      from: "src/runtime/wasmgc/promise/settlement-bodies.ts",
      to: "src/runtime/wasmgc/promise/rejection-event-bodies.ts",
      typeOnly: false,
    },
  ] as const;
  const endpoints = (edge: FixtureEdge) => ({ from: edge.from, to: edge.to, typeOnly: edge.typeOnly });
  const edgeOrder = (a: ReturnType<typeof endpoints>, b: ReturnType<typeof endpoints>) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b));
  expect(denoEdges.map(endpoints).sort(edgeOrder)).toEqual([...expectedDenoEdges].sort(edgeOrder));
  const prior = new Set(priorLiveRequired);
  const priorEdges = validatorEdges.filter(
    (edge) => prior.has(edge.from) && edge.to !== undefined && prior.has(edge.to),
  );
  expect(edgePopulation(priorEdges)).toEqual({ edges: 783, typeOnly: 404, runtime: 379 });
  const schemaEdges = priorEdges.filter(
    (edge) => edge.from === "src/ir/core/nodes.ts" && edge.to === "src/shared/contracts/ir-unit-inventory.ts",
  );
  expect(schemaEdges).toEqual([expect.objectContaining({ typeOnly: true })]);
  // Report-derived bounded historical population, after exactly one known type edge.
  expect(edgePopulation(priorEdges.filter((edge) => edge !== schemaEdges[0]))).toEqual({
    edges: 782,
    typeOnly: 403,
    runtime: 379,
  });
  expect(edgePopulation(validatorEdges.filter((edge) => !priorEdges.includes(edge)))).toEqual({
    edges: 194,
    typeOnly: 72,
    runtime: 122,
  });
  for (const module of r.report.modules) {
    expect(module.state).toBe("clean");
    expect(module.hash).toBe(
      createHash("sha256")
        .update(readFileSync(resolve(repository, module.path)))
        .digest("hex"),
    );
  }
}

describe("semantic verification and provider ownership boundary", () => {
  it("pins the original 70 modules plus seven Promise/vector and five string/error owners without relaxing historical policy", () => {
    expect(required).toHaveLength(106);
    expect(new Set(required).size).toBe(106);
    expect(callableAdditions).toHaveLength(2);
    expect(vectorAdditions).toHaveLength(2);
    expect(typeLayoutAdditions).toHaveLength(1);
    expect(delayCombinatorAdditions).toHaveLength(2);
    expect(frameAdditions).toHaveLength(3);
    expect(physicalAdditions).toHaveLength(3);
    expect(settlementAdditions).toHaveLength(1);
    expect(
      required.filter(
        (path) =>
          ![
            ...physicalAdditions,
            ...settlementAdditions,
            ...frameAdditions,
            ...delayCombinatorAdditions,
            ...typeLayoutAdditions,
            ...callableAdditions,
            ...vectorAdditions,
            ...physicalVectorAdditions,
            ...resolutionAdditions,
            ...promiseResourceAdditions,
            ...stringErrorAdditions,
            ...nativeValueAdditions,
            ...scannerAdditions,
            ...demandAdditions,
            ...argumentVectorAdditions,
            ...closureAdditions,
            ...declarationAdditions,
            ...aggregateAdditions,
            ...formatterAdditions,
          ].includes(path),
      ),
    ).toHaveLength(56);
    expect(additions).toHaveLength(12);
    expect(new Set(additions).size).toBe(12);
    for (const path of [
      ...additions,
      ...physicalAdditions,
      ...settlementAdditions,
      ...frameAdditions,
      ...delayCombinatorAdditions,
      ...typeLayoutAdditions,
      ...callableAdditions,
      ...vectorAdditions,
      ...physicalVectorAdditions,
      ...resolutionAdditions,
      ...promiseResourceAdditions,
      ...stringErrorAdditions,
      ...nativeValueAdditions,
      ...scannerAdditions,
      ...demandAdditions,
      ...argumentVectorAdditions,
      ...closureAdditions,
      ...declarationAdditions,
      ...aggregateAdditions,
      ...formatterAdditions,
    ])
      expect(required).toContain(path);
    const p = policy();
    authenticateNumberPrerequisitePolicy(p);
    assertCurrentActivations(
      beforeIrRuntimeProgramPolicy(beforeWellKnownSymbolPolicy(beforeNumberPrerequisitePolicy(p))).activationHistory,
    );
    expect(digest(p.allowedEdges)).toBe("efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7");
    for (const [id, entries] of Object.entries(currentLayerGroups)) {
      const layer = p.layers.find((row: { id: string }) => row.id === id);
      const added = booleanAdditions[id as keyof typeof booleanAdditions];
      const additions: string[] = added ? [added] : [];
      if (id === "native-runtime") additions.push("src/runtime/wasmgc/values/bigint-primitive-bodies.ts");
      if (id === "ir-runtime") additions.push(...semanticCallableAdditions);
      additions.push(...(mergedInvocationAdditions[id] ?? []));
      additions.push(...(mergedObjectStorageAdditions[id] ?? []));
      if (id === "ir-program") additions.push(...getterResultAdditions);
      if (id === "ir-program") additions.push("src/ir/program/native-prototype-requirements.ts");
      if (id === "native-runtime")
        additions.push(
          "src/runtime/wasmgc/values/prototype-companion-body.ts",
          "src/runtime/wasmgc/values/prototype-key-normalization-body.ts",
          "src/runtime/wasmgc/values/prototype-read-bodies.ts",
          "src/runtime/wasmgc/values/prototype-receiver-bodies.ts",
        );
      if (id === "backend-wasmgc")
        additions.push(
          "src/backend/wasmgc/resources/native-bigint.ts",
          "src/backend/wasmgc/resources/native-object-same-value.ts",
          "src/backend/wasmgc/resources/native-object-descriptors.ts",
          "src/backend/wasmgc/resources/native-prototype-layouts.ts",
          "src/backend/wasmgc/resources/native-prototype-seeder-bindings.ts",
          "src/backend/wasmgc/resources/native-object-get.ts",
        );
      if (id === "native-runtime")
        additions.push(
          "src/runtime/wasmgc/values/bigint-carrier-body.ts",
          "src/runtime/wasmgc/values/bigint-carrier-layouts.ts",
          "src/runtime/wasmgc/values/bigint-finalized-layouts.ts",
          "src/runtime/wasmgc/values/ordinary-object-descriptor-definitions.ts",
          "src/runtime/wasmgc/values/prototype-layouts.ts",
          "src/runtime/wasmgc/values/prototype-singleton-bodies.ts",
          "src/runtime/wasmgc/values/own-property-bodies.ts",
          "src/runtime/wasmgc/values/prototype-seeder-bodies.ts",
          "src/runtime/wasmgc/values/prototype-chain-bodies.ts",
        );
      if (id === "runtime-contracts")
        additions.push("src/runtime/contracts/builtin-brands.ts", "src/runtime/contracts/collection-kind.ts");
      if (id === "backend-wasmgc") additions.push("src/backend/wasmgc/program/native-primitive-boundary-abi.ts");
      if (id === "native-runtime")
        additions.push(
          "src/runtime/wasmgc/values/primitive-wrapper-layouts.ts",
          "src/runtime/wasmgc/values/primitive-wrapper-bodies.ts",
        );
      if (id === "backend-wasmgc")
        additions.push(
          "src/backend/wasmgc/resources/native-primitive-wrapper-layouts.ts",
          "src/backend/wasmgc/resources/native-primitive-wrapper-storage.ts",
        );
      if (id === "native-runtime") additions.push("src/runtime/wasmgc/values/to-object-body.ts");
      if (id === "native-runtime")
        additions.push(
          "src/runtime/wasmgc/values/object-prototype-method-bodies.ts",
          "src/runtime/wasmgc/values/object-prototype-accessor-bodies.ts",
          "src/runtime/wasmgc/values/object-constructor-body.ts",
        );
      if (id === "runtime-contracts") additions.push("src/runtime/contracts/js-value-tags.ts");
      if (id === "backend-wasmgc")
        additions.push(
          "src/backend/wasmgc/resources/native-builtin-function-requests.ts",
          "src/backend/wasmgc/resources/native-builtin-functions.ts",
        );
      if (id === "backend-wasmgc") additions.push("src/backend/wasmgc/resources/native-invocation-substrate.ts");
      if (id === "native-runtime")
        additions.push(
          "src/runtime/wasmgc/values/builtin-function-layouts.ts",
          "src/runtime/wasmgc/values/builtin-function-bodies.ts",
          "src/runtime/wasmgc/values/builtin-function-property-bodies.ts",
          "src/runtime/wasmgc/values/builtin-function-prototype-bodies.ts",
        );
      if (id === "native-runtime")
        additions.push(
          "src/runtime/wasmgc/values/create-list-from-array-like-body.ts",
          "src/runtime/wasmgc/values/function-prototype-invoker-bodies.ts",
        );
      if (id === "runtime-contracts") additions.push("src/runtime/contracts/native-realm-catalog.ts");
      if (id === "ir-program") additions.push("src/ir/program/native-realm-requirements.ts");
      if (id === "backend-wasmgc")
        additions.push(
          "src/backend/wasmgc/program/native-realm-literals.ts",
          "src/backend/wasmgc/program/native-realm.ts",
        );
      if (id === "native-runtime") additions.push("src/runtime/wasmgc/values/realm-object-layouts.ts");
      if (id === "backend-wasmgc") additions.push("src/backend/wasmgc/resources/native-realm-object-layouts.ts");
      if (id === "backend-wasmgc") additions.push("src/backend/wasmgc/resources/native-object-realm.ts");
      if (id === "native-runtime") additions.push("src/runtime/wasmgc/values/mixed-object-access-bodies.ts");
      if (id === "backend-wasmgc") additions.push("src/backend/wasmgc/resources/native-mixed-object-access.ts");
      const contracts = sourceContractActivations.find((record) => record.layer === id);
      if (contracts) additions.push(...contracts.entries);
      const validation = irValidationPolicyActivations.find((record) => record.layer === id);
      if (validation) additions.push(...validation.entries);
      if (id === "ir-program")
        additions.push(
          "src/ir/program/owner.ts",
          "src/ir/program/draft-abi-lookup.ts",
          "src/ir/program/runtime-support-dependencies.ts",
        );
      if (id === "ir-runtime") additions.push("src/ir/runtime/generator-support.ts");
      if (id === "runtime-contracts") additions.push("src/runtime/contracts/well-known-symbols.ts");
      if (id === "backend-wasmgc") additions.push("src/backend/wasmgc/resources/native-well-known-symbols.ts");
      if (id === "native-runtime")
        additions.push(
          "src/runtime/wasmgc/values/bigint-to-number-body.ts",
          "src/runtime/wasmgc/values/number-from-value-body.ts",
        );
      if (id === "backend-wasmgc")
        additions.push(
          "src/backend/wasmgc/resources/native-bigint-number.ts",
          "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",
        );
      const signedEntries = additions.length ? layer.entries.slice(0, -additions.length) : layer.entries;
      if (additions.length) expect(layer.entries.slice(-additions.length)).toEqual(additions);
      const receipt = signedLayerComposition[id as keyof typeof signedLayerComposition];
      expect(digest(signedEntries)).toBe(receipt.entriesSha256);
      expect(layer).toMatchObject({
        status: "active",
        required: true,
        minModules: receipt.minModules + additions.length,
      });
      expect(signedEntries.filter((path: string) => entries.includes(path))).toEqual(entries);
      for (const path of layer.entries)
        expect(p.files.filter((row: { path: string }) => row.path === path)).toEqual([
          { path, state: "clean", layer: id },
        ]);
    }
  });

  it("loads the complete actual canonical type-and-value closure", () => {
    assertLiveFixtureClosure(fixture().run());
  });

  it("refuses an omitted current remainder leaf at both actual import sites and restores a fresh healthy graph", () => {
    const f = fixture();
    assertLiveFixtureClosure(f.run());
    const copied = readFileSync(resolve(f.root, remainderLiveFixtureAddition));
    const actual = readFileSync(resolve(repository, remainderLiveFixtureAddition));
    expect(copied.equals(actual)).toBe(true);
    try {
      rmSync(resolve(f.root, remainderLiveFixtureAddition));
      const missing = f.run();
      expect(missing.status).toBe(1);
      expect(missing.report.inventoryValid).toBe(false);
      for (const owner of ["src/ir/runtime/callable-declarations.ts", "src/ir/runtime/intrinsic-preparation.ts"]) {
        expect(missing.report.errors).toContainEqual({
          code: "unresolved-module",
          detail: owner + ": ./number-remainder-callables.js",
        });
      }
      expect(missing.report.errors.some((error: { code: string }) => error.code === "forbidden-transitive-path")).toBe(
        true,
      );
    } finally {
      f.put(remainderLiveFixtureAddition, copied.toString("utf8"));
    }
    expect(readFileSync(resolve(f.root, remainderLiveFixtureAddition)).equals(copied)).toBe(true);
    expect(readFileSync(resolve(repository, remainderLiveFixtureAddition)).equals(actual)).toBe(true);
    assertLiveFixtureClosure(f.run());
  });

  it("rejects bypass of the actual input-to-source-map-validator dependency", () => {
    const f = fixture();
    assertLiveFixtureClosure(f.run());
    const path = "src/ir/program/input.ts";
    const original = readFileSync(resolve(repository, path), "utf8");
    const actualImport = 'import { assertPreparedSourceMap } from "./validation.js";';
    expect(original.split(actualImport)).toHaveLength(2);
    for (const replacement of ["", 'import type { assertPreparedSourceMap } from "./validation.js";']) {
      f.put(path, original.replace(actualImport, replacement));
      const bypass = f.run();
      expect(bypass.status).toBe(0);
      expect(bypass.report.errors).toEqual([]);
      expect(
        bypass.report.edges.filter(
          (edge: FixtureEdge) => edge.from === path && edge.to === "src/ir/program/validation.ts" && !edge.typeOnly,
        ),
      ).toEqual([]);
      expect({ edges: bypass.report.resolvedEdgeCount, ...bypass.report.counts.resolvedEdgesByType }).toEqual(
        replacement === ""
          ? { edges: 987 + 7, typeOnly: 480 + 4, runtime: 507 + 3 }
          : { edges: 988 + 7, typeOnly: 481 + 4, runtime: 507 + 3 },
      );
      expect(() => assertLiveFixtureClosure(bypass)).toThrow();
      f.put(path, original);
      assertLiveFixtureClosure(f.run());
    }
  });

  it.each(["delete", "reorder", "layer", "entries", "minimum", "extra"] as const)(
    "rejects %s corruption of the independently pinned twelve-record prefix",
    (mutation) => {
      const history = beforeIrRuntimeProgramPolicy(
        beforeWellKnownSymbolPolicy(beforeNumberPrerequisitePolicy(policy())),
      ).activationHistory;
      assertCurrentActivations(history);
      const before = digest(history);
      if (mutation === "delete") history.splice(0, 1);
      if (mutation === "reorder") [history[0], history[1]] = [history[1], history[0]];
      if (mutation === "layer") history[0].layer = "ir-core";
      if (mutation === "entries") history[0].entries.pop();
      if (mutation === "minimum") history[0].minModules--;
      if (mutation === "extra") history.splice(0, 0, structuredClone(history[0]));
      expect(digest(history)).not.toBe(before);
      expect(() => assertCurrentActivations(history)).toThrow();
    },
  );

  it.each([81, 82, 83, 84])("rejects a changed primitive composition record %i", (index) => {
    const history = beforeIrRuntimeProgramPolicy(
      beforeWellKnownSymbolPolicy(beforeNumberPrerequisitePolicy(policy())),
    ).activationHistory;
    assertCurrentActivations(history);
    history[index].entries[0] += ".lookalike";
    expect(() => assertCurrentActivations(history)).toThrow();
  });

  it.each([85, 86, 87])("rejects changed merged invocation record %i", (index) => {
    const history = beforeIrRuntimeProgramPolicy(
      beforeWellKnownSymbolPolicy(beforeNumberPrerequisitePolicy(policy())),
    ).activationHistory;
    assertCurrentActivations(history);
    history[index].entries[0] += ".lookalike";
    expect(() => assertCurrentActivations(history)).toThrow();
  });

  it.each([88, 89, 90])("rejects changed source contract activation %i", (index) => {
    const history = beforeIrRuntimeProgramPolicy(
      beforeWellKnownSymbolPolicy(beforeNumberPrerequisitePolicy(policy())),
    ).activationHistory;
    assertCurrentActivations(history);
    history[index].entries[0] += ".lookalike";
    expect(() => assertCurrentActivations(history)).toThrow();
  });

  function assertModelOnlyDeclarations(text: string) {
    const source = ts.createSourceFile("declarations.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports: string[] = [];
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        expect(statement.importClause?.isTypeOnly).toBe(true);
        expect(ts.isStringLiteral(statement.moduleSpecifier)).toBe(true);
        imports.push((statement.moduleSpecifier as ts.StringLiteral).text);
      } else {
        expect(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)).toBe(true);
      }
    }
    expect(imports).toEqual(["../../../wasm/model/instructions.js", "../../../wasm/model/module-records.js"]);
    const visit = (node: ts.Node): void => {
      expect(ts.isImportTypeNode(node)).toBe(false);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  it("keeps the actual declaration contract erased and model-only", () => {
    assertModelOnlyDeclarations(readFileSync(resolve(repository, declarationAdditions[0]!), "utf8"));
  });

  it.each([
    'import { extra } from "../../../wasm/model/instructions.js";',
    'import type { Extra } from "../../../wasm/physical/module-reservations.js";',
    'export type Extra = import("../../../wasm/physical/module-reservations.js").TypeReservation;',
    "export const runtimeValue = 1;",
  ])("rejects declaration-contract coupling: %s", (mutation) => {
    const text = readFileSync(resolve(repository, declarationAdditions[0]!), "utf8");
    assertModelOnlyDeclarations(text);
    expect(() => assertModelOnlyDeclarations(text + "\n" + mutation)).toThrow();
  });

  it.each(
    [0, 1, 2].flatMap((index) =>
      (["delete", "reorder", "layer", "entries", "minimum"] as const).map((mutation) => ({ index, mutation })),
    ),
  )("rejects $mutation corruption of formatter activation record $index", ({ index, mutation }) => {
    const history = assertCurrentActivations(
      beforeIrRuntimeProgramPolicy(beforeWellKnownSymbolPolicy(beforeNumberPrerequisitePolicy(policy())))
        .activationHistory,
    ) as MutableIrRuntimeProgramPolicy["activationHistory"];
    assertNewActivations(history);
    const before = digest(history);
    if (mutation === "delete") history.splice(index, 1);
    if (mutation === "reorder") [history[index], history[index + 1]] = [history[index + 1], history[index]];
    if (mutation === "layer") history[index].layer = "ir-analysis";
    if (mutation === "entries") history[index].entries.pop();
    if (mutation === "minimum") history[index].minModules--;
    expect(digest(history), "mutation must alter the formatter activation record").not.toBe(before);
    expect(() => assertNewActivations(history)).toThrow();
  });

  it.each(["delete", "reorder", "layer", "entries", "minimum"] as const)(
    "rejects %s corruption of the new activation records",
    (mutation) => {
      const history = assertCurrentActivations(
        beforeIrRuntimeProgramPolicy(beforeWellKnownSymbolPolicy(beforeNumberPrerequisitePolicy(policy())))
          .activationHistory,
      ) as MutableIrRuntimeProgramPolicy["activationHistory"];
      assertNewActivations(history);
      const before = digest(history);
      if (mutation === "delete") history.splice(5, 1);
      if (mutation === "reorder") [history[5], history[6]] = [history[6], history[5]];
      if (mutation === "layer") history[5].layer = "ir-core";
      if (mutation === "entries") history[5].entries.pop();
      if (mutation === "minimum") history[5].minModules--;
      expect(digest(history), "mutation must alter the accepted activation records").not.toBe(before);
      expect(() => assertNewActivations(history)).toThrow();
    },
  );

  it.each(
    (
      [
        ["published backend", 6],
        ["published demand", 7],
        ["refreshed parent", 8],
      ] as const
    ).flatMap(([owner, index]) =>
      (["delete", "reorder", "layer", "entries", "minimum"] as const).map((mutation) => ({
        owner,
        index,
        mutation,
      })),
    ),
  )("rejects $mutation corruption of the $owner activation record", ({ index, mutation }) => {
    const history = assertCurrentActivations(
      beforeIrRuntimeProgramPolicy(beforeWellKnownSymbolPolicy(beforeNumberPrerequisitePolicy(policy())))
        .activationHistory,
    ) as MutableIrRuntimeProgramPolicy["activationHistory"];
    assertNewActivations(history);
    const before = digest(history);
    if (mutation === "delete") history.splice(index, 1);
    if (mutation === "reorder") [history[index], history[index + 1]] = [history[index + 1], history[index]];
    if (mutation === "layer") history[index].layer = "ir-core";
    if (mutation === "entries") history[index].entries.pop();
    if (mutation === "minimum") history[index].minModules--;
    expect(digest(history), "mutation must alter the authenticated parent record").not.toBe(before);
    expect(() => assertNewActivations(history)).toThrow();
  });

  it.each(
    [0, 2, 9].flatMap((offset) =>
      (["delete", "reorder", "layer", "entries", "minimum"] as const).map((mutation) => ({ offset, mutation })),
    ),
  )("rejects $mutation corruption of original prerequisite activation records at $offset", ({ offset, mutation }) => {
    const history = assertCurrentActivations(
      beforeIrRuntimeProgramPolicy(beforeWellKnownSymbolPolicy(beforeNumberPrerequisitePolicy(policy())))
        .activationHistory,
    ) as MutableIrRuntimeProgramPolicy["activationHistory"];
    assertNewActivations(history);
    const index = 3 + originalCompositionOffsets[offset]!;
    const next = 3 + originalCompositionOffsets[offset + 1]!;
    const before = digest(history);
    if (mutation === "delete") history.splice(index, 1);
    if (mutation === "reorder") [history[index], history[next]] = [history[next], history[index]];
    if (mutation === "layer") history[index].layer = "ir-core";
    if (mutation === "entries") history[index].entries.pop();
    if (mutation === "minimum") history[index].minModules--;
    expect(digest(history), "mutation must alter the original prerequisite record").not.toBe(before);
    expect(() => assertNewActivations(history)).toThrow();
  });

  it("rejects an upward runtime dependency from the native string/value aggregate", () => {
    const f = fixture();
    const path = aggregateAdditions[0]!;
    f.put("src/forbidden.ts", "export const hidden = 1;");
    f.p.files.push({ path: "src/forbidden.ts", layer: "frontend-ts", state: "unmigrated" });
    f.append(path, 'import { hidden } from "@forbidden";');
    const r = f.run();
    expect(r.status).toBe(1);
    expect(r.report.forbiddenEdges).toContainEqual(
      expect.objectContaining({ from: path, to: "src/forbidden.ts", typeOnly: false }),
    );
  });

  it.each([
    ...additions,
    ...physicalAdditions,
    ...settlementAdditions,
    ...frameAdditions,
    ...delayCombinatorAdditions,
    ...typeLayoutAdditions,
    ...callableAdditions,
    ...vectorAdditions,
    ...physicalVectorAdditions,
    ...resolutionAdditions,
    ...promiseResourceAdditions,
    ...stringErrorAdditions,
    ...nativeValueAdditions,
    ...scannerAdditions,
    ...demandAdditions,
    ...argumentVectorAdditions,
    ...closureAdditions,
    ...declarationAdditions,
    ...aggregateAdditions,
    ...formatterAdditions,
  ])("rejects deleting %s and its classification", (path) => {
    const f = fixture();
    rmSync(resolve(f.root, path));
    f.p.files = f.p.files.filter((row: { path: string }) => row.path !== path);
    for (const mode of ["inventory", "complete"]) {
      const r = f.run(mode);
      expect(r.status).not.toBe(0);
      expect(r.report.errors.map((e: { code: string }) => e.code)).toContain("missing-activated-root");
    }
  });

  it.each([
    ...additions,
    ...physicalAdditions,
    ...settlementAdditions,
    ...frameAdditions,
    ...delayCombinatorAdditions,
    ...typeLayoutAdditions,
    ...callableAdditions,
    ...vectorAdditions,
    ...physicalVectorAdditions,
    ...resolutionAdditions,
    ...promiseResourceAdditions,
    ...stringErrorAdditions,
    ...nativeValueAdditions,
    ...scannerAdditions,
    ...demandAdditions,
    ...argumentVectorAdditions,
    ...closureAdditions,
    ...declarationAdditions,
    ...aggregateAdditions,
    ...formatterGroups["ir-core"],
    ...formatterGroups["ir-program"],
  ])("rejects an aliased frontend type dependency from %s", (path) => {
    const f = fixture();
    f.put("src/forbidden.ts", "export interface Hidden { value: number }");
    f.p.files.push({ path: "src/forbidden.ts", layer: "frontend-ts", state: "unmigrated" });
    f.append(path, 'export type { Hidden } from "@forbidden";');
    const r = f.run();
    expect(r.status).toBe(1);
    expect(r.report.forbiddenEdges).toContainEqual(
      expect.objectContaining({ from: path, to: "src/forbidden.ts", typeOnly: true }),
    );
  });

  it("rejects a backend implementation dependency from the frontend formatter contract", () => {
    const f = fixture();
    assertLiveFixtureClosure(f.run());
    const path = formatterGroups["frontend-ts"][0]!;
    const original = readFileSync(resolve(repository, path), "utf8");
    f.put("src/forbidden.ts", "export interface Hidden { value: number }");
    f.p.files.push({ path: "src/forbidden.ts", layer: "backend-wasmgc", state: "unmigrated" });
    f.append(path, 'export type { Hidden } from "@forbidden";');
    const r = f.run();
    expect(r.status).toBe(1);
    expect(r.report.forbiddenEdges).toContainEqual(
      expect.objectContaining({ from: path, to: "src/forbidden.ts", typeOnly: true }),
    );
    expect(r.report.transitiveViolations).not.toEqual([]);
    expect(r.report.counts.total).toBe(209 + 1);
    expect({ edges: r.report.resolvedEdgeCount, ...r.report.counts.resolvedEdgesByType }).toEqual({
      edges: 989 + 7,
      typeOnly: 481 + 4,
      runtime: 508 + 3,
    });
    f.put(path, original);
    f.p.files.pop();
    rmSync(resolve(f.root, "src/forbidden.ts"));
    assertLiveFixtureClosure(f.run());
  });

  for (const [source, field] of [
    ["const target = globalThis.toString(); import(target);", "unknownEdges"],
    ['export type { Missing } from "./missing-owner.js";', "unresolvedEdges"],
  ] as const) {
    it.each([
      ...additions,
      ...physicalAdditions,
      ...settlementAdditions,
      ...frameAdditions,
      ...delayCombinatorAdditions,
      ...typeLayoutAdditions,
      ...callableAdditions,
      ...vectorAdditions,
      ...physicalVectorAdditions,
      ...resolutionAdditions,
      ...promiseResourceAdditions,
      ...stringErrorAdditions,
      ...nativeValueAdditions,
      ...scannerAdditions,
      ...demandAdditions,
      ...argumentVectorAdditions,
      ...closureAdditions,
      ...declarationAdditions,
      ...aggregateAdditions,
      ...formatterAdditions,
    ])(`reports ${field} from %s instead of treating it as closed`, (path) => {
      const f = fixture();
      f.append(path, source);
      const r = f.run();
      expect(r.status).toBe(1);
      expect(r.report[field]).toContainEqual(expect.objectContaining({ from: path }));
    });
  }

  it.each(additions)("rejects a runtime dependency on the historical facade from %s", (path) => {
    const f = fixture();
    const facade = "src/ir/intrinsics.ts";
    f.put(facade, readFileSync(resolve(repository, facade), "utf8"));
    const classification = policy().files.filter((row: { path: string }) => row.path === facade);
    expect(classification).toHaveLength(1);
    f.p.files.push(classification[0]);
    f.append(path, 'import "../intrinsics.js";');
    const r = f.run();
    expect(r.status).toBe(1);
    expect(r.report.forbiddenEdges).toContainEqual(
      expect.objectContaining({ from: path, to: facade, typeOnly: false }),
    );
  });

  for (const [layer, source, typeOnly] of [
    ["compiler", 'import { hidden } from "@forbidden";', false],
    ["backend-wasmgc", 'export * from "@forbidden";', false],
    ["wasm-physical", 'type HiddenPhysical = typeof import("@forbidden").hidden;', true],
    ["ir-program", 'export { hidden } from "@forbidden";', false],
  ] as const) {
    it.each(["src/ir/core/intrinsics.ts", "src/ir/analysis/intrinsics.ts", "src/ir/runtime/intrinsic-verification.ts"])(
      `rejects ${layer} dependency syntax from %s`,
      (path) => {
        const f = fixture();
        f.put("src/forbidden.ts", "export const hidden = 1;");
        f.p.files.push({ path: "src/forbidden.ts", layer, state: "unmigrated" });
        f.append(path, source);
        const r = f.run();
        expect(r.status).toBe(1);
        expect(r.report.forbiddenEdges).toContainEqual(
          expect.objectContaining({ from: path, to: "src/forbidden.ts", typeOnly }),
        );
      },
    );
  }

  it.each(["effects", "intrinsics", "async-plan"])(
    "rejects runtime provider dependencies from semantic analysis/%s",
    (name) => {
      const f = fixture();
      const path = `src/ir/analysis/${name}.ts`;
      f.append(path, 'export { RUNTIME_PROVIDERS } from "../runtime/manifest.js";');
      const r = f.run();
      expect(r.status).toBe(1);
      expect(r.report.forbiddenEdges).toContainEqual(
        expect.objectContaining({ from: path, to: "src/ir/runtime/manifest.ts", typeOnly: false }),
      );
    },
  );

  it.each(["ir-core", "ir-analysis", "ir-runtime"] as const)(
    "rejects whole-group deletion of %s despite policy demotion",
    (id) => {
      const f = fixture();
      for (const path of groups[id]) rmSync(resolve(f.root, path));
      f.p.files = f.p.files.filter((row: { layer: string }) => row.layer !== id);
      const layer = f.p.layers.find((row: { id: string }) => row.id === id);
      layer.status = "debt";
      layer.required = false;
      layer.entries = [];
      layer.minModules = 0;
      for (const mode of ["inventory", "complete"]) {
        const r = f.run(mode);
        expect(r.status).not.toBe(0);
        expect(r.report.errors).toContainEqual({ code: "activation-demoted", detail: id });
      }
    },
  );
});
