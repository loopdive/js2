// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import ts from "typescript";
import {
  beforeSourceMapProgramValidatorRelocation,
  captureSourceMapProgramValidatorRelocation,
  programValidatorRelocationReceiptPath,
  type ProgramValidatorDonorPath,
  type ProgramValidatorCurrentPath,
} from "./helpers/ir-program-validator-relocation.js";
import { reconstructRuntimeContractReceiptSources } from "./helpers/ir-runtime-contract-evolution.js";
import { beforeRuntimePreparationRelocation } from "./helpers/ir-runtime-preparation-relocation.js";
import { captureC1CurrentPopulation } from "./helpers/ir-c1-current-source.js";
import { reconstructRuntimeProgramRelocationPopulation } from "./helpers/ir-runtime-program-relocation.js";
const expected = {
  schema: "ir-program-validator-relocation-v1",
  baseMain: "39fd7b7d44c9bc6f9be47ddd1f7fd75196a7d5f1",
  coordinateUnit: "utf8-byte",
  currentPaths: [
    "src/ir/program-runtime-demands.ts",
    "src/ir/program/runtime-demands.ts",
    "src/ir/program-runtime-abi.ts",
    "src/ir/program/runtime-abi.ts",
    "src/ir/runtime-program-manifest.ts",
    "src/ir/program/runtime-manifest.ts",
    "src/ir/program-runtime-validation.ts",
    "src/ir/program/runtime-validation.ts",
    "src/ir/program-validation.ts",
    "src/ir/program/validation.ts",
  ],
  pairs: [
    {
      donorPath: "src/ir/program-runtime-demands.ts",
      implementationPath: "src/ir/program/runtime-demands.ts",
      before: {
        path: "src/ir/program-runtime-demands.ts",
        bytes: 13421,
        sha256: "e3b2d8e2adc4dbee309050dd9085ef710949422e1b94789cdc3138b1737caf32",
        gitBlob: "7ab4f93af694716ae532c1fb598f35fa42e067f5",
      },
      facade: {
        path: "src/ir/program-runtime-demands.ts",
        bytes: 474,
        sha256: "6af11b258faefd71a5602a021cdb8524f6d7bd804764e6ec7914440575f4fc39",
        gitBlob: "fce0ec1086445fba84a0e720c51b7e06405f2ed6",
      },
      implementation: {
        path: "src/ir/program/runtime-demands.ts",
        bytes: 13467,
        sha256: "74bfbc2fa49f6ce33fc5b4970a7dd0a5def4a6a17b009032321fce13cdfabf85",
        gitBlob: "cd7cfebb496ebf51d3bcc8bb5fbcd665607c5e4d",
      },
      facadeText:
        '// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\n\n/** Compatibility exports; implementation belongs to the prepared-program owner. */\nexport {\n  irStringCompareDemand,\n  irStringEqDemand,\n  irStringLenDemand,\n  irStringConcatDemand,\n  irHostCallbackWrapDemand,\n  irFunctionPrototypeCallDemand,\n  irStringConstDemand,\n  irStringCharCodeAtDemand,\n  irStringConcatManyDemand,\n  irProgramRuntimeDemands,\n} from "./program/runtime-demands.js";\n',
      valueExports: [
        "irStringCompareDemand",
        "irStringEqDemand",
        "irStringLenDemand",
        "irStringConcatDemand",
        "irHostCallbackWrapDemand",
        "irFunctionPrototypeCallDemand",
        "irStringConstDemand",
        "irStringCharCodeAtDemand",
        "irStringConcatManyDemand",
        "irProgramRuntimeDemands",
      ],
      typeExports: [],
      segments: [
        {
          kind: "unchanged",
          beforeStart: 0,
          beforeEnd: 85,
          afterStart: 0,
          afterEnd: 85,
          beforeSha256: "56bf88dc4c3a627fc20affb2ea7a4b4b8792a9cdf66df0f0d07691edc0a298f5",
          afterSha256: "56bf88dc4c3a627fc20affb2ea7a4b4b8792a9cdf66df0f0d07691edc0a298f5",
        },
        {
          kind: "imports",
          beforeStart: 85,
          beforeEnd: 578,
          afterStart: 85,
          afterEnd: 624,
          beforeSha256: "5b6d7869b0d9669e642290d87b66d6fe2823f3ea0ef5e9225c18ff9026c15f3e",
          afterSha256: "fc5483b2ccfda5bd85a24dfb4e858d36e7db1e9f9380f9136b93af29901181b9",
          beforeText:
            'import { forEachInstrDeep, type IrFunction, type IrInstr } from "./nodes.js";\nimport {\n  IR_STRING_COMPARE_FN,\n  JSSTR_CHARCODEAT_FN,\n  NATIVE_CHARCODEAT_FN,\n  FUNCTION_PROTOTYPE_CALL_HELPER,\n} from "./runtime-symbols.js";\nimport { IR_ASYNC_STRING_CONCAT_5_FN } from "./async-semantic-runtime.js";\nimport { parseIrStringConcatManyArity } from "./string-runtime.js";\nimport { irGeneratorNumberBoxDemand } from "./generator-support.js";\nimport { hasLoneSurrogate } from "../string-surrogate.js";',
          afterText:
            'import { forEachInstrDeep, type IrFunction, type IrInstr } from "../core/nodes.js";\nimport {\n  IR_STRING_COMPARE_FN,\n  JSSTR_CHARCODEAT_FN,\n  NATIVE_CHARCODEAT_FN,\n  FUNCTION_PROTOTYPE_CALL_HELPER,\n} from "../core/runtime-symbols.js";\nimport { IR_ASYNC_STRING_CONCAT_5_FN } from "../core/async-callables.js";\nimport { parseIrStringConcatManyArity } from "../core/string-runtime.js";\nimport { irGeneratorNumberBoxDemand } from "../runtime/generator-support.js";\nimport { hasLoneSurrogate } from "../../shared/contracts/string-surrogate.js";',
        },
        {
          kind: "unchanged",
          beforeStart: 578,
          beforeEnd: 13421,
          afterStart: 624,
          afterEnd: 13467,
          beforeSha256: "e2eb6ff1795a5f10cc36cf88a0a68b9c5a62745fe53d60bed68e1488d0ee7f22",
          afterSha256: "e2eb6ff1795a5f10cc36cf88a0a68b9c5a62745fe53d60bed68e1488d0ee7f22",
        },
      ],
    },
    {
      donorPath: "src/ir/program-runtime-abi.ts",
      implementationPath: "src/ir/program/runtime-abi.ts",
      before: {
        path: "src/ir/program-runtime-abi.ts",
        bytes: 4475,
        sha256: "0f8eb92a65a87a4fe0275aa4e90f88a600f3f598f9278fd01edd198fff4c41a4",
        gitBlob: "d10bd411a6030ba898b8febe5bf3d0ff1d99e35f",
      },
      facade: {
        path: "src/ir/program-runtime-abi.ts",
        bytes: 363,
        sha256: "cec827cc20299610d6351e050cce5e9d3bd5198c9b334eb95253b96372ed7247",
        gitBlob: "307f5fd4b31c10c0bea32892e5d1c0c80e938188",
      },
      implementation: {
        path: "src/ir/program/runtime-abi.ts",
        bytes: 4522,
        sha256: "65fcb7d226b260f30f517ae0f0a55117f5f5f99dcaef2c83219a466ee79cad4e",
        gitBlob: "670b421735b57cda583340acab33067a43e97811",
      },
      facadeText:
        '// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\n\n/** Compatibility exports; implementation belongs to the prepared-program owner. */\nexport {\n  preparedIrRuntimeAbiAnchor,\n  preparedIrRuntimeCallableBindingId,\n  assertPreparedIrRuntimeCallableDeclaration,\n  prepareIrProgramRuntimeCallables,\n} from "./program/runtime-abi.js";\n',
      valueExports: [
        "preparedIrRuntimeAbiAnchor",
        "preparedIrRuntimeCallableBindingId",
        "assertPreparedIrRuntimeCallableDeclaration",
        "prepareIrProgramRuntimeCallables",
      ],
      typeExports: [],
      segments: [
        {
          kind: "unchanged",
          beforeStart: 0,
          beforeEnd: 85,
          afterStart: 0,
          afterEnd: 85,
          beforeSha256: "56bf88dc4c3a627fc20affb2ea7a4b4b8792a9cdf66df0f0d07691edc0a298f5",
          afterSha256: "56bf88dc4c3a627fc20affb2ea7a4b4b8792a9cdf66df0f0d07691edc0a298f5",
        },
        {
          kind: "imports",
          beforeStart: 85,
          beforeEnd: 832,
          afterStart: 85,
          afterEnd: 887,
          beforeSha256: "6f2ad837e59a1290f2f9a13bda7933c43ebfc93351c826cbcc59b3ff617e9979",
          afterSha256: "a831bb5697337ad64b828f7f57001a843d57b8b9be1d9c8faabd0394e5797dae",
          beforeText:
            'import { irCallableBindingKey } from "./callable-bindings.js";\nimport { forEachInstrDeep } from "./nodes.js";\nimport { assertPreparedIrProgramPopulation } from "./program-population.js";\nimport { preparedIrDataMismatch, preparedIrProgramOwner, PreparedIrProgramInvariantError } from "./program.js";\nimport type { PreparedIrProgramFailure, PreparedIrProgramProducerInput } from "./program/prepared-contracts.js";\nimport { irRuntimeCallableDeclaration, type IrRuntimeCallableDeclaration } from "./runtime-callable-declarations.js";\nimport { collectNativeAsyncCallableDemands, IrNativeAsyncCallableError } from "./runtime/native-async-callables.js";\nimport { collectVectorCallableDemands, IrVectorCallableError } from "./runtime/vector-callables.js";',
          afterText:
            'import { irCallableBindingKey } from "../core/callable-bindings.js";\nimport { forEachInstrDeep } from "../core/nodes.js";\nimport { assertPreparedIrProgramPopulation } from "./population.js";\nimport { preparedIrDataMismatch } from "./data.js";\nimport { preparedIrProgramOwner } from "./owner.js";\nimport { PreparedIrProgramInvariantError } from "./errors.js";\nimport type { PreparedIrProgramFailure, PreparedIrProgramProducerInput } from "./prepared-contracts.js";\nimport { irRuntimeCallableDeclaration, type IrRuntimeCallableDeclaration } from "../runtime/callable-declarations.js";\nimport { collectNativeAsyncCallableDemands, IrNativeAsyncCallableError } from "../runtime/native-async-callables.js";\nimport { collectVectorCallableDemands, IrVectorCallableError } from "../runtime/vector-callables.js";',
        },
        {
          kind: "unchanged",
          beforeStart: 832,
          beforeEnd: 1017,
          afterStart: 887,
          afterEnd: 1072,
          beforeSha256: "d80c74eaac2aea497f164ab3fe84b5e41c594c0f5028967002749c5c33e60780",
          afterSha256: "d80c74eaac2aea497f164ab3fe84b5e41c594c0f5028967002749c5c33e60780",
        },
        {
          kind: "export-module",
          beforeStart: 1017,
          beforeEnd: 1052,
          afterStart: 1072,
          afterEnd: 1099,
          beforeSha256: "57326bf80adf3127eacc9747436d31aa882422135db3ed97d3c3ac020b373f99",
          afterSha256: "ed9c03efe7634641cd7a7edbbd74ad2c90fd8baab276930c1be958cec24b718d",
          beforeText: '"./program/runtime-abi-identity.js"',
          afterText: '"./runtime-abi-identity.js"',
        },
        {
          kind: "unchanged",
          beforeStart: 1052,
          beforeEnd: 4475,
          afterStart: 1099,
          afterEnd: 4522,
          beforeSha256: "c56fd4e9ee43c5f0466fd6b1e428bba2a30efb1805dabcbe96b965e736ffb7f6",
          afterSha256: "c56fd4e9ee43c5f0466fd6b1e428bba2a30efb1805dabcbe96b965e736ffb7f6",
        },
      ],
    },
    {
      donorPath: "src/ir/runtime-program-manifest.ts",
      implementationPath: "src/ir/program/runtime-manifest.ts",
      before: {
        path: "src/ir/runtime-program-manifest.ts",
        bytes: 12069,
        sha256: "d9698e66ad1d048e51dd58f6a5b47b2adf65a61da1787c5d543b1ac6437036a9",
        gitBlob: "bd80eecc4f6937a72757ea0124bea7af92e3cf27",
      },
      facade: {
        path: "src/ir/runtime-program-manifest.ts",
        bytes: 450,
        sha256: "9d6a11bb96ce4dde466d92baf2945ca2c9a877ee5124a93ebaccac5118e44c56",
        gitBlob: "57fa674a5e7368c19cbc10e0ca608711b3889a55",
      },
      implementation: {
        path: "src/ir/program/runtime-manifest.ts",
        bytes: 12179,
        sha256: "069795708c8134e2bf69f17ed9f546a2f63c9f3494889213e6c26b211388f470",
        gitBlob: "11202df8cb0c5c1f5cb4bf34e27927365591242b",
      },
      facadeText:
        '// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\n\n/** Compatibility exports; implementation belongs to the prepared-program owner. */\nexport {\n  locatedFailure,\n  invariant,\n  checkFunctionPopulation,\n  prepareWholeProgramRuntimeManifest,\n} from "./program/runtime-manifest.js";\nexport type {\n  PrepareWholeProgramRuntimeManifestInput,\n  PreparedWholeProgramRuntimeManifest,\n} from "./program/runtime-manifest.js";\n',
      valueExports: ["locatedFailure", "invariant", "checkFunctionPopulation", "prepareWholeProgramRuntimeManifest"],
      typeExports: ["PrepareWholeProgramRuntimeManifestInput", "PreparedWholeProgramRuntimeManifest"],
      segments: [
        {
          kind: "unchanged",
          beforeStart: 0,
          beforeEnd: 196,
          afterStart: 0,
          afterEnd: 196,
          beforeSha256: "0b89fed9b126252c7b2c2eadeb81f14efde3ff2a956418b51e9767ea75bf6d91",
          afterSha256: "0b89fed9b126252c7b2c2eadeb81f14efde3ff2a956418b51e9767ea75bf6d91",
        },
        {
          kind: "imports",
          beforeStart: 196,
          beforeEnd: 2313,
          afterStart: 196,
          afterEnd: 2423,
          beforeSha256: "94ce5f02ddef1d6cc8ba339d0c2c8f1924b3e5e5afa0cb76108c3f10d5bcbe9c",
          afterSha256: "1c053f5affe0ffe78fc66d90cbdfe52545accec0b79acde8d330e990a10ac0ef",
          beforeText:
            'import {\n  assertPreparedIrAsyncRuntimeCurrent,\n  preparedIrAsyncFrameCapabilityFailure,\n} from "./runtime/async-attachment.js";\nimport { irAsyncPlanNeedsNumberBridge } from "./analysis/async-plan.js";\nimport type { IrUnitId } from "../shared/contracts/ir-identity.js";\nimport {\n  IrRuntimeFunctionPreparationError,\n  prepareIrRuntimeManifest,\n  type IrRuntimeManifestDemands,\n} from "./intrinsic-support.js";\nimport type { PreparedIrRuntimeManifest } from "./runtime/contracts/prepared.js";\nimport { INTRINSIC_DEFINITIONS } from "./core/intrinsics.js";\nimport type { IntrinsicSourceLocation } from "./core/intrinsic-contracts.js";\nimport { forEachInstrDeep } from "./nodes.js";\nimport type { PreparedIrFunction as IrFunction } from "./runtime/contracts/prepared.js";\nimport { classifyIrFailure, IrInvariantError } from "./outcomes.js";\nimport type { IrPreparationFailure } from "../shared/contracts/ir-preparation-failure.js";\nimport { PreparedIrProgramInvariantError, preparedIrProgramOwner, preparedIrReadonlyMap } from "./program.js";\nimport type { PreparedIrProgramFailure, PreparedIrProgramProducerInput } from "./program/prepared-contracts.js";\nimport { assertPreparedIrProgramPopulation } from "./program-population.js";\nimport { irRuntimeCallableDeclaration } from "./runtime/callable-declarations.js";\nimport {\n  collectNativeAsyncCallableDemands,\n  IrNativeAsyncCallableError,\n  type IrNativeAsyncCallableDemand,\n} from "./runtime/native-async-callables.js";\nimport {\n  collectVectorCallableDemands,\n  IrVectorCallableError,\n  type IrVectorCallableDemand,\n} from "./runtime/vector-callables.js";\nimport {\n  FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES,\n  GENERATOR_NUMBER_BOX_RUNTIME_FEATURES,\n  HOST_CALLBACK_WRAP_RUNTIME_FEATURES,\n  STRING_CHAR_CODE_AT_RUNTIME_FEATURES,\n  STRING_COMPARE_RUNTIME_FEATURES,\n  STRING_CONCAT_MANY_RUNTIME_FEATURES,\n  STRING_CONCAT_RUNTIME_FEATURES,\n  STRING_CONST_RUNTIME_FEATURES,\n  STRING_EQ_RUNTIME_FEATURES,\n  STRING_LEN_RUNTIME_FEATURES,\n  RuntimeManifestInvariantError,\n} from "./runtime/manifest.js";\nimport type { RuntimeFeature } from "./runtime/contracts/manifest.js";',
          afterText:
            'import {\n  assertPreparedIrAsyncRuntimeCurrent,\n  preparedIrAsyncFrameCapabilityFailure,\n} from "../runtime/async-attachment.js";\nimport { irAsyncPlanNeedsNumberBridge } from "../analysis/async-plan.js";\nimport type { IrUnitId } from "../../shared/contracts/ir-identity.js";\nimport {\n  IrRuntimeFunctionPreparationError,\n  prepareIrRuntimeManifest,\n  type IrRuntimeManifestDemands,\n} from "../runtime/intrinsic-preparation.js";\nimport type { PreparedIrRuntimeManifest } from "../runtime/contracts/prepared.js";\nimport { INTRINSIC_DEFINITIONS } from "../core/intrinsics.js";\nimport type { IntrinsicSourceLocation } from "../core/intrinsic-contracts.js";\nimport { forEachInstrDeep } from "../core/nodes.js";\nimport type { PreparedIrFunction as IrFunction } from "../runtime/contracts/prepared.js";\nimport { classifyIrFailure, IrInvariantError } from "../../shared/contracts/ir-preparation-errors.js";\nimport type { IrPreparationFailure } from "../../shared/contracts/ir-preparation-failure.js";\nimport { PreparedIrProgramInvariantError } from "./errors.js";\nimport { preparedIrProgramOwner } from "./owner.js";\nimport { preparedIrReadonlyMap } from "./data.js";\nimport type { PreparedIrProgramFailure, PreparedIrProgramProducerInput } from "./prepared-contracts.js";\nimport { assertPreparedIrProgramPopulation } from "./population.js";\nimport { irRuntimeCallableDeclaration } from "../runtime/callable-declarations.js";\nimport {\n  collectNativeAsyncCallableDemands,\n  IrNativeAsyncCallableError,\n  type IrNativeAsyncCallableDemand,\n} from "../runtime/native-async-callables.js";\nimport {\n  collectVectorCallableDemands,\n  IrVectorCallableError,\n  type IrVectorCallableDemand,\n} from "../runtime/vector-callables.js";\nimport {\n  FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES,\n  GENERATOR_NUMBER_BOX_RUNTIME_FEATURES,\n  HOST_CALLBACK_WRAP_RUNTIME_FEATURES,\n  STRING_CHAR_CODE_AT_RUNTIME_FEATURES,\n  STRING_COMPARE_RUNTIME_FEATURES,\n  STRING_CONCAT_MANY_RUNTIME_FEATURES,\n  STRING_CONCAT_RUNTIME_FEATURES,\n  STRING_CONST_RUNTIME_FEATURES,\n  STRING_EQ_RUNTIME_FEATURES,\n  STRING_LEN_RUNTIME_FEATURES,\n  RuntimeManifestInvariantError,\n} from "../runtime/manifest.js";\nimport type { RuntimeFeature } from "../runtime/contracts/manifest.js";',
        },
        {
          kind: "unchanged",
          beforeStart: 2313,
          beforeEnd: 12069,
          afterStart: 2423,
          afterEnd: 12179,
          beforeSha256: "d6dd8ea16fb04b911a4ad04c3934b33f472750c9c69e69601279730fb16e2c35",
          afterSha256: "d6dd8ea16fb04b911a4ad04c3934b33f472750c9c69e69601279730fb16e2c35",
        },
      ],
    },
    {
      donorPath: "src/ir/program-runtime-validation.ts",
      implementationPath: "src/ir/program/runtime-validation.ts",
      before: {
        path: "src/ir/program-runtime-validation.ts",
        bytes: 8186,
        sha256: "bb4006f9bcdf641f665b6b1ee10ea6fd8ced30e168d09faf8439358d574f2b0c",
        gitBlob: "0e514564a61e077baaba01048ad5ca6a5688ebd9",
      },
      facade: {
        path: "src/ir/program-runtime-validation.ts",
        bytes: 302,
        sha256: "8dbc664c29166cade8867d58f5bddb3af3e12d9e98c25aea2a9f8ce9c7ac7e9b",
        gitBlob: "604c5aa1638a98e23a745c957d13dab304a88ee7",
      },
      implementation: {
        path: "src/ir/program/runtime-validation.ts",
        bytes: 8248,
        sha256: "1aa7bc3520b1c88483821d96fa41c633bb02e9082c6e6993605847ef296cd13f",
        gitBlob: "51ee28bc9e2e12bb392c6c680ce526256fdb4d65",
      },
      facadeText:
        '// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\n\n/** Compatibility exports; implementation belongs to the prepared-program owner. */\nexport {\n  assertPreparedIrSemanticRuntimeSeparation,\n  assertPreparedIrRuntimeProjection,\n} from "./program/runtime-validation.js";\n',
      valueExports: ["assertPreparedIrSemanticRuntimeSeparation", "assertPreparedIrRuntimeProjection"],
      typeExports: [],
      segments: [
        {
          kind: "unchanged",
          beforeStart: 0,
          beforeEnd: 85,
          afterStart: 0,
          afterEnd: 85,
          beforeSha256: "56bf88dc4c3a627fc20affb2ea7a4b4b8792a9cdf66df0f0d07691edc0a298f5",
          afterSha256: "56bf88dc4c3a627fc20affb2ea7a4b4b8792a9cdf66df0f0d07691edc0a298f5",
        },
        {
          kind: "imports",
          beforeStart: 85,
          beforeEnd: 816,
          afterStart: 85,
          afterEnd: 878,
          beforeSha256: "b9eca45a4ae6039c0321ca3029a83ebf61bc786c5dd5ded6b55f0ca9efc5da4c",
          afterSha256: "20f024a9b071597be685c6c293b2c7b80ad5d9d93f3df983fe79db3b5f4ca66d",
          beforeText:
            'import { assertPreparedIrAsyncRuntimeCurrent } from "./async-plan.js";\nimport { forEachInstrDeep, forEachNestedBuffer, type IrInstr } from "./nodes.js";\nimport { IR_ASYNC_CLOCK_SNAPSHOT_FN } from "./core/async-callables.js";\nimport { nativeAsyncCallablePolicyMismatch, nativeAsyncProviderMismatch } from "./runtime/native-async-callables.js";\nimport { preparedIrDraftAbiLookup } from "./program-abi-contracts.js";\nimport { irProgramRuntimeDemands } from "./program-runtime-demands.js";\nimport { prepareWholeProgramRuntimeManifest } from "./runtime-program-manifest.js";\nimport {\n  preparedIrDataMismatch,\n  PreparedIrProgramInvariantError,\n  type PreparedIrProgram,\n  type PreparedIrProgramRuntimeProjection,\n} from "./program.js";',
          afterText:
            'import { assertPreparedIrAsyncRuntimeCurrent } from "../runtime/async-attachment.js";\nimport { forEachInstrDeep, forEachNestedBuffer, type IrInstr } from "../core/nodes.js";\nimport { IR_ASYNC_CLOCK_SNAPSHOT_FN } from "../core/async-callables.js";\nimport { nativeAsyncCallablePolicyMismatch, nativeAsyncProviderMismatch } from "../runtime/native-async-callables.js";\nimport { preparedIrDraftAbiLookup } from "./draft-abi-lookup.js";\nimport { irProgramRuntimeDemands } from "./runtime-demands.js";\nimport { prepareWholeProgramRuntimeManifest } from "./runtime-manifest.js";\nimport { preparedIrDataMismatch } from "./data.js";\nimport { PreparedIrProgramInvariantError } from "./errors.js";\nimport { type PreparedIrProgram, type PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";',
        },
        {
          kind: "unchanged",
          beforeStart: 816,
          beforeEnd: 8186,
          afterStart: 878,
          afterEnd: 8248,
          beforeSha256: "5ebc05d9ff2cbf3ad907c39c0f3541a58bc8fe062b519e0d4da07af7646ba197",
          afterSha256: "5ebc05d9ff2cbf3ad907c39c0f3541a58bc8fe062b519e0d4da07af7646ba197",
        },
      ],
    },
    {
      donorPath: "src/ir/program-validation.ts",
      implementationPath: "src/ir/program/validation.ts",
      before: {
        path: "src/ir/program-validation.ts",
        bytes: 19427,
        sha256: "816c404e96f8e9a5782d5c51714f0aec0592967bb13f1e09ca50f3f29c2c3299",
        gitBlob: "46d2679da3f750ac01b54b40cc33ba9ae2eb29ba",
      },
      facade: {
        path: "src/ir/program-validation.ts",
        bytes: 236,
        sha256: "b64454a7c97179e8efdab677049fb0f231ba3b6ce731bff602b231406d2dd098",
        gitBlob: "fbcd84648424059795285aa45f85020e564ed2ba",
      },
      implementation: {
        path: "src/ir/program/validation.ts",
        bytes: 19448,
        sha256: "572aab2d72f9eabf322347e90c3d13e25f690a44fa3cede1ac5666dcd1674354",
        gitBlob: "18e65c59b175e01412683b4c0b977513bde868fe",
      },
      facadeText:
        '// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\n\n/** Compatibility exports; implementation belongs to the prepared-program owner. */\nexport { assertPreparedIrProgram } from "./program/validation.js";\n',
      valueExports: ["assertPreparedIrProgram"],
      typeExports: [],
      segments: [
        {
          kind: "unchanged",
          beforeStart: 0,
          beforeEnd: 85,
          afterStart: 0,
          afterEnd: 85,
          beforeSha256: "56bf88dc4c3a627fc20affb2ea7a4b4b8792a9cdf66df0f0d07691edc0a298f5",
          afterSha256: "56bf88dc4c3a627fc20affb2ea7a4b4b8792a9cdf66df0f0d07691edc0a298f5",
        },
        {
          kind: "imports",
          beforeStart: 85,
          beforeEnd: 1841,
          afterStart: 85,
          afterEnd: 1862,
          beforeSha256: "14f341730dd4b5256b0624579eefe29a069c79d5ae6e093657eedac4322f9ded",
          afterSha256: "79621be69e14513f2d244ebc6959e4e3a161d4840aed24942b076a34d8120994",
          beforeText:
            'import { irCallableBindingKey, irUnitCallableBindingId } from "./callable-bindings.js";\nimport { irGlobalBindingKey, irTypeBindingKey } from "./abi-bindings.js";\nimport { irBindingKey } from "./declared-types.js";\nimport { forEachInstrDeep } from "./nodes.js";\nimport type { IrDeclaredSignature } from "./core/nodes.js";\nimport type { IrType } from "./core/types.js";\nimport { ProgramAbiMap } from "./program-abi.js";\nimport { preparedIrProgramCallableResults } from "./program-callable-contract.js";\nimport {\n  preparedIrCallableSignature,\n  preparedIrClassLayoutKey,\n  preparedIrDataKey,\n  preparedIrTypeKey,\n} from "./program-abi-contracts.js";\nimport { assertPreparedIrProgramPopulation } from "./program-population.js";\nimport { preparedIrDataMismatch, PreparedIrProgramInvariantError } from "./program.js";\nimport type { PreparedIrAbiEntry, PreparedIrProgram } from "./program/prepared-contracts.js";\nimport {\n  prepareIrProgramRuntimeCallables,\n  preparedIrRuntimeAbiAnchor,\n  preparedIrRuntimeCallableBindingId,\n} from "./program-runtime-abi.js";\nimport { verifyIrFunction, type IrVerificationOptions } from "./verify.js";\nimport { assertPreparedIrClassLayouts } from "./program-class-layouts.js";\nimport { assertPreparedIrProgramAllocations } from "./program-allocations.js";\nimport { assertIrRuntimeSupport } from "./program/runtime-support.js";\nimport { numberFormatRadixSupportDeclarations } from "./program/formatter-support.js";\nimport { assertPreparedIrRuntimeSupportDependencies } from "./prepared-component-dependencies.js";\nimport { irRuntimeCallableHasNoSlot } from "./runtime/native-async-callables.js";\nimport {\n  assertPreparedIrRuntimeProjection,\n  assertPreparedIrSemanticRuntimeSeparation,\n} from "./program-runtime-validation.js";',
          afterText:
            'import { irCallableBindingKey, irUnitCallableBindingId } from "../core/callable-bindings.js";\nimport { irGlobalBindingKey } from "../core/global-binding-keys.js";\nimport { irTypeBindingKey } from "../core/type-binding-keys.js";\nimport { irBindingKey } from "../core/declared-types.js";\nimport { forEachInstrDeep } from "../core/nodes.js";\nimport type { IrDeclaredSignature } from "../core/nodes.js";\nimport type { IrType } from "../core/types.js";\nimport { ProgramAbiMap } from "./abi.js";\nimport { preparedIrProgramCallableResults } from "./callable-results.js";\nimport {\n  preparedIrCallableSignature,\n  preparedIrClassLayoutKey,\n  preparedIrDataKey,\n  preparedIrTypeKey,\n} from "./abi-signatures.js";\nimport { assertPreparedIrProgramPopulation } from "./population.js";\nimport { preparedIrDataMismatch } from "./data.js";\nimport { PreparedIrProgramInvariantError } from "./errors.js";\nimport type { PreparedIrAbiEntry, PreparedIrProgram } from "./prepared-contracts.js";\nimport {\n  prepareIrProgramRuntimeCallables,\n  preparedIrRuntimeAbiAnchor,\n  preparedIrRuntimeCallableBindingId,\n} from "./runtime-abi.js";\nimport { verifyIrFunction, type IrVerificationOptions } from "../runtime/verify.js";\nimport { assertPreparedIrClassLayouts } from "./class-layouts.js";\nimport { assertPreparedIrProgramAllocations } from "./allocations.js";\nimport { assertIrRuntimeSupport } from "./runtime-support.js";\nimport { numberFormatRadixSupportDeclarations } from "./formatter-support.js";\nimport { assertPreparedIrRuntimeSupportDependencies } from "./runtime-support-dependencies.js";\nimport { irRuntimeCallableHasNoSlot } from "../runtime/native-async-callables.js";\nimport { assertPreparedIrRuntimeProjection, assertPreparedIrSemanticRuntimeSeparation } from "./runtime-validation.js";',
        },
        {
          kind: "unchanged",
          beforeStart: 1841,
          beforeEnd: 19427,
          afterStart: 1862,
          afterEnd: 19448,
          beforeSha256: "378d8a643901dee7e3bb1e1e8a4fc5312ff04d3cbcd92d5e3c81d16ecbc6bf6d",
          afterSha256: "378d8a643901dee7e3bb1e1e8a4fc5312ff04d3cbcd92d5e3c81d16ecbc6bf6d",
        },
      ],
    },
  ],
} as const;
const receiptPath = programValidatorRelocationReceiptPath;
const receiptSha256 = "816848c32744e8ec3e2c414a27420b4a0339e35d815b5002db4754f11104ff92";
const read = (path: string): string => {
  const packageRoot = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
  return readFileSync(
    path.startsWith("typescript-package/")
      ? resolve(packageRoot, path.slice("typescript-package/".length))
      : new URL(`../${path}`, import.meta.url),
    "utf8",
  );
};
const faultPins = [
  { path: receiptPath, bytes: 27069, sha256: receiptSha256 },
  ...expected.pairs.flatMap((pair) => [
    pair.facade,
    pair.implementation.path === "src/ir/program/validation.ts"
      ? {
          ...pair.implementation,
          bytes: 45816,
          sha256: "33cba90b606278805766b4eb739214c31dd84babafb873773f3e92f60c470231",
        }
      : pair.implementation,
  ]),
];
const sha = (source: string | Buffer): string => createHash("sha256").update(source).digest("hex");
function assertPin(
  source: string,
  pin: { readonly bytes: number; readonly sha256: string; readonly gitBlob: string },
): void {
  expect(Buffer.byteLength(source)).toBe(pin.bytes);
  expect(sha(source)).toBe(pin.sha256);
  expect(
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(source)}\0`)
      .update(source)
      .digest("hex"),
  ).toBe(pin.gitBlob);
}
function independentInverse(pair: (typeof expected.pairs)[number], source: string): string {
  const bytes = Buffer.from(source);
  return Buffer.concat(
    pair.segments.map((segment) =>
      segment.kind === "unchanged"
        ? bytes.subarray(segment.afterStart, segment.afterEnd)
        : Buffer.from(segment.beforeText),
    ),
  ).toString("utf8");
}
function independentReplay(pair: (typeof expected.pairs)[number], source: string): string {
  const bytes = Buffer.from(source);
  return Buffer.concat(
    pair.segments.map((segment) =>
      segment.kind === "unchanged"
        ? bytes.subarray(segment.beforeStart, segment.beforeEnd)
        : Buffer.from(segment.afterText),
    ),
  ).toString("utf8");
}
const physical = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const physicalFaultAuthorities = faultPins.map((pin) => pin.path);
function expectMissingAuthority(action: () => void, path: string): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "ENOENT", path: physical(path) });
}
/** Synchronous, checkout-exclusive real faults; retain recovery bytes/lock on any unsafe restore. */
function withAuthorityFault(path: string, kind: "mutation" | "missing", action: () => void, byte: 0 = 0): void {
  if (!physicalFaultAuthorities.includes(path)) throw new Error("unapproved current-main authority fault: " + path);
  if (
    ![0].includes(byte) ||
    (byte !== 0 && (path !== "tests/helpers/ir-runtime-program-policy-evolution.ts" || kind !== "mutation"))
  )
    throw new Error("unapproved current-main authority fault byte");
  const target = physical(path);
  const scratch = resolve(import.meta.dirname, "../.tmp/validator-owner/preservation-writer/source-authority-faults");
  mkdirSync(scratch, { recursive: true });
  const lock = join(scratch, "checkout.lock");
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
    const pin = faultPins.find((pin) => pin.path === path)!;
    const authenticated = "prefix" in pin ? original.subarray(0, pin.bytes) : original;
    expect(authenticated.length).toBe(pin.bytes);
    expect(createHash("sha256").update(authenticated).digest("hex")).toBe(pin.sha256);
    const mode = initial.mode & 0o7777;
    const mutated = Buffer.from(original);
    if (mutated.length === 0) throw new Error("empty authority target: " + target);
    if (byte >= mutated.length) throw new Error("authority fault byte outside target");
    mutated[byte] = mutated[byte]! ^ 1;
    backupDirectory = mkdtempSync(join(scratch, "operation-"));
    backup = join(backupDirectory, "original");
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
        expectMissingAuthority(() => {
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
        expectMissingAuthority(() => {
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

afterEach(async () => {
  await setImmediate();
});
describe("fixed program validator source relocation", () => {
  it("binds the independently fixed receipt and captures exactly ten sources in order each time", () => {
    const trace: string[] = [];
    const readLive = (path: string) => {
      trace.push(path);
      return read(path);
    };
    const first = captureProgramValidatorRelocation(readLive),
      second = captureProgramValidatorRelocation(readLive);
    const operation = [
      "tests/helpers/ir-program-validator-relocation.ts",
      "tests/helpers/ir-source-map-schema-source-epoch.json",
      "tests/helpers/ir-program-validator-relocation.ts",
      receiptPath,
      ...expected.currentPaths,
    ];
    expect(trace).toEqual([...operation, ...operation]);
    expect(Buffer.byteLength(read(receiptPath))).toBe(27069);
    expect(sha(read(receiptPath))).toBe(receiptSha256);
    expect(JSON.parse(read(receiptPath))).toEqual(expected);
    expect(Object.isFrozen(first)).toBe(true);
    for (const pair of expected.pairs) expect(first.readBefore(pair.donorPath)).toBe(second.readBefore(pair.donorPath));
  });
  for (const pair of expected.pairs) {
    it(`independently proves predecessor and two current replays for ${pair.donorPath}`, () => {
      const captured = captureProgramValidatorRelocation(read);
      const actualImplementation = read(pair.implementationPath);
      const implementation = captured.readRelocationCurrent(pair.implementationPath),
        facade = read(pair.donorPath);
      expect(captured.readCurrent(pair.implementationPath)).toBe(actualImplementation);
      const original = independentInverse(pair, implementation);
      assertPin(original, pair.before);
      assertPin(implementation, pair.implementation);
      assertPin(facade, pair.facade);
      expect(captured.readBefore(pair.donorPath)).toBe(original);
      expect(captured.readCurrent(pair.donorPath)).toBe(facade);
      expect(captured.readRelocationCurrent(pair.implementationPath)).toBe(implementation);
      expect(independentReplay(pair, original)).toBe(implementation);
      expect(facade).toBe(pair.facadeText);
      const parsed = ts.createSourceFile(pair.donorPath, facade, ts.ScriptTarget.Latest, true);
      const values: string[] = [],
        types: string[] = [];
      for (const statement of parsed.statements) {
        expect(ts.isExportDeclaration(statement)).toBe(true);
        if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause))
          throw new Error("explicit facade exports required");
        expect(statement.moduleSpecifier?.getText(parsed)).toBe(
          JSON.stringify("./program/" + pair.implementationPath.split("/").at(-1)!.replace(/\.ts$/, ".js")),
        );
        for (const element of statement.exportClause.elements)
          (statement.isTypeOnly || element.isTypeOnly ? types : values).push(element.name.text);
      }
      expect(values).toEqual(pair.valueExports);
      expect(types).toEqual(pair.typeExports);
    });
    for (const path of [pair.donorPath, pair.implementationPath]) {
      for (const kind of ["mutation", "missing"] as const) {
        it(`refuses warm physical ${kind} of ${path} without accepting a cached capture`, () => {
          captureProgramValidatorRelocation(read);
          withAuthorityFault(path, kind, () => {
            if (kind === "missing")
              expectMissingAuthority(() => {
                captureProgramValidatorRelocation(read);
              }, path);
            else
              expect(() => captureProgramValidatorRelocation(read)).toThrow(
                "program validator relocation: complete source pin mismatch",
              );
          });
          captureProgramValidatorRelocation(read);
        });
      }
    }
    it(`refuses an import-role mutation for ${pair.implementationPath}`, () => {
      const source = read(pair.implementationPath),
        span = pair.segments.find((segment) => segment.kind === "imports")!;
      const bytes = Buffer.from(source),
        mutant = Buffer.from(bytes);
      mutant[span.afterStart] = mutant[span.afterStart]! ^ 1;
      expect(() =>
        captureProgramValidatorRelocation((path) =>
          path === pair.implementationPath ? mutant.toString("utf8") : read(path),
        ),
      ).toThrow("complete source pin mismatch");
    });
    it(`refuses body/docs outside changed imports for ${pair.implementationPath}`, () => {
      const source = read(pair.implementationPath),
        mutant = source + "\n// changed private implementation\n";
      expect(() =>
        captureProgramValidatorRelocation((path) => (path === pair.implementationPath ? mutant : read(path))),
      ).toThrow("complete source pin mismatch");
    });
    it(`refuses an alternate forwarding witness for ${pair.donorPath}`, () => {
      const mutant = read(pair.donorPath).replace("export {", "export * as alternate from");
      expect(mutant).not.toBe(read(pair.donorPath));
      expect(() =>
        captureProgramValidatorRelocation((path) => (path === pair.donorPath ? mutant : read(path))),
      ).toThrow("complete source pin mismatch");
    });
  }
  for (const kind of ["mutation", "missing"] as const) {
    it(`refuses warm physical ${kind} of the fixed new receipt`, () => {
      captureProgramValidatorRelocation(read);
      withAuthorityFault(receiptPath, kind, () => {
        if (kind === "missing")
          expectMissingAuthority(() => {
            captureProgramValidatorRelocation(read);
          }, receiptPath);
        else expect(() => captureProgramValidatorRelocation(read)).toThrow("immutable receipt bytes mismatch");
      });
    });
  }
  it("refuses boxed, empty and unknown source domains without delegates hiding failures", () => {
    for (const invalid of [Object(read(receiptPath)), "", undefined])
      expect(() => captureProgramValidatorRelocation(() => invalid as string)).toThrow(
        "nonempty primitive text required",
      );
    const capture = captureProgramValidatorRelocation(read);
    expect(() => capture.readBefore("src/ir/other.ts" as ProgramValidatorDonorPath)).toThrow(
      "unexpected predecessor domain",
    );
    expect(() => capture.readCurrent(receiptPath as ProgramValidatorCurrentPath)).toThrow("unexpected current domain");
  });
  const receiptMutations: readonly [string, (receipt: Record<string, unknown>) => void][] = [
    [
      "unknown field",
      (value) => {
        value.extra = true;
      },
    ],
    [
      "missing pairs",
      (value) => {
        Reflect.deleteProperty(value, "pairs");
      },
    ],
    [
      "reordered paths",
      (value) => {
        (value.currentPaths as string[]).reverse();
      },
    ],
    [
      "duplicate path",
      (value) => {
        const paths = value.currentPaths as string[];
        paths[1] = paths[0]!;
      },
    ],
    [
      "extra pair",
      (value) => {
        const pairs = value.pairs as unknown[];
        pairs.push(pairs[0]);
      },
    ],
    [
      "missing coordinate coverage",
      (value) => {
        const pairs = value.pairs as { segments: { beforeStart: number }[] }[];
        pairs[0]!.segments[0]!.beforeStart = 1;
      },
    ],
    [
      "overlapping coordinates",
      (value) => {
        const pairs = value.pairs as { segments: { afterStart: number }[] }[];
        pairs[0]!.segments[1]!.afterStart = 0;
      },
    ],
    [
      "wrong coordinate unit",
      (value) => {
        value.coordinateUnit = "utf16-text";
      },
    ],
  ];
  for (const [name, change] of receiptMutations) {
    it(`refuses fixed receipt ${name} at the immutable raw authority boundary`, () => {
      const mutant = JSON.parse(read(receiptPath)) as Record<string, unknown>;
      change(mutant);
      const text = JSON.stringify(mutant);
      expect(() => captureProgramValidatorRelocation((path) => (path === receiptPath ? text : read(path)))).toThrow(
        "immutable receipt bytes mismatch",
      );
    });
  }
  it("delegates only unrelated reads after the complete inverse has succeeded", () => {
    const view = beforeProgramValidatorRelocation((path) => (path === "unrelated" ? "unrelated raw" : read(path)));
    expect(view("unrelated")).toBe("unrelated raw");
    for (const pair of expected.pairs) assertPin(view(pair.donorPath), pair.before);
  });
  it("admits actual current sources but lets post-capture historical mutations reach the old guard", () => {
    const historicalReader = beforeRuntimePreparationRelocation(beforeProgramValidatorRelocation(read));
    expect(reconstructRuntimeContractReceiptSources(historicalReader).size).toBe(27);
    const path = "src/ir/program-runtime-abi.ts",
      source = historicalReader(path);
    expect(() =>
      reconstructRuntimeContractReceiptSources((requested) =>
        requested === path ? source + "\n// old-domain mutant\n" : historicalReader(requested),
      ),
    ).toThrow("runtime contract evolution: complete source SHA256/length mismatch");
  });
});

describe("C1 validator relocation channel separation", () => {
  for (const path of ["src/ir/program-runtime-abi.ts", "src/ir/program-validation.ts"] as const) {
    it(`refuses bad population ${path} with healthy authority`, () => {
      const positive = captureC1CurrentPopulation(read, read);
      expect(positive.observedCurrentPins.find((item) => item.path === path)?.pin.sha256).toBe(sha(read(path)));
      expect(() =>
        captureC1CurrentPopulation(
          (requested) => (requested === path ? read(path) + "\n// population-only mutation\n" : read(requested)),
          read,
        ),
      ).toThrow("population source differs from current validator facade");
    });
    it(`keeps altered post-capture historical ${path} on its unchanged old guard`, () => {
      const captured = captureC1CurrentPopulation(read, read),
        mutant = new Map(captured.historicalPopulation);
      mutant.set(path, mutant.get(path)! + "\n// detached historical mutation\n");
      expect(() => reconstructRuntimeProgramRelocationPopulation(mutant, captured.receiptText)).toThrow(
        /length\/SHA256/,
      );
    });
  }
  for (const path of ["src/ir/program/runtime-abi.ts", "src/ir/program-validation.ts", receiptPath]) {
    it(`refuses bad authority ${path} while raw population is healthy`, () => {
      captureC1CurrentPopulation(read, read);
      expect(() =>
        captureC1CurrentPopulation(read, (requested) =>
          requested === path ? read(path) + "\n// authority mutation\n" : read(requested),
        ),
      ).toThrow("program validator relocation:");
    });
  }
  it("performs a fresh source capture on a second C1 call after a live authority change", () => {
    captureC1CurrentPopulation(read, read);
    let changed = false;
    const authority = (path: string): string =>
      path === "src/ir/program/runtime-abi.ts" && changed ? read(path) + "\n// new operation\n" : read(path);
    captureC1CurrentPopulation(read, authority);
    changed = true;
    expect(() => captureC1CurrentPopulation(read, authority)).toThrow("complete source pin mismatch");
  });
});

function captureProgramValidatorRelocation(readLive: (path: string) => string) {
  if (typeof readLive !== "function") throw new Error("program validator relocation: physical reader required");
  assertSourceMapValidatorComponent(readLive);
  return captureSourceMapProgramValidatorRelocation(readLive);
}

// Fresh whole component authentication precedes each explicit source-epoch bridge.
function assertSourceMapValidatorComponent(readLive: (path: string) => string): void {
  const path = "tests/helpers/ir-program-validator-relocation.ts";
  const text = readLive(path);
  if (typeof text !== "string" || text.length === 0)
    throw new Error("program validator relocation: nonempty primitive text required: " + path);
  if (
    Buffer.byteLength(text) !== 46642 ||
    createHash("sha256").update(text).digest("hex") !==
      "6e32ca208775e8eeae765bf3345cdd3cb1e0f40a1784f684afd9c4dff3a4cfe0"
  )
    throw new Error("program validator relocation: complete source pin mismatch: " + path);
}
function beforeProgramValidatorRelocation(readLive: (path: string) => string): (path: string) => string {
  if (typeof readLive !== "function") throw new Error("program validator relocation: physical reader required");
  assertSourceMapValidatorComponent(readLive);
  return beforeSourceMapProgramValidatorRelocation(readLive);
}
