// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { capture5883InventoryPredecessorPolicySource } from "./helpers/ir-5883-inventory-source-successor.js";
import { captureMainInventoryPredecessorPolicySource } from "./helpers/ir-main-inventory-source-successor.js";
import {
  captureArrayBufferIsViewMainPredecessorPolicySource,
  capturePresentationClassificationPredecessorPolicySource,
  captureLoweringAnalysisPredecessorPolicySource,
  captureWasmGcHelperPredecessorPolicySource,
} from "./helpers/ir-runtime-program-policy-evolution.js";
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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureProgramValidatorPredecessorPolicy,
  captureProgramValidatorPredecessorPolicySource,
  captureNestedStackificationPredecessorPolicySource,
  type MutableIrRuntimeProgramPolicy as Policy,
} from "./helpers/ir-runtime-program-policy-evolution.js";
// Independent fixed root-receipt literals, never learned from API returns or mutants.
const expected = {
  schema: 1,
  kind: "fixed-program-validator-policy-relocation",
  provenance: {
    canonicalMain: "39fd7b7d44c9bc6f9be47ddd1f7fd75196a7d5f1",
    planSha256: "06584cb400881d178483f569e9e0ff26d61276012f9def060c8b70e533d3f02f",
    legacyRetained: true,
  },
  before: {
    source: {
      bytes: 580511,
      sha256: "81a0d94238a16cb762befa909ff057fc55d2da720996cf04af196bdd50cff7b2",
      gitBlob: "dfedad8b2e98a9479409b351db8399a342505e19",
    },
    dataSha256: "d0891226c6e20ecf3868f9979a39b68722fe240a6e3394ea953c86ab1d1754de",
    fileCount: 1814,
    filesSha256: "a7fa1f5391015e87db1b70f61b965b737c0e32f917be41630e40dcf75337cef6",
    activationCount: 102,
    activationHistorySha256: "9a7e77fdc8c67fc0683879feb8bac8a9ef7854e9b083ac0c7e9affa4ddb24020",
    layersSha256: "e7246f81b16f524db95bddcb8bf0d01faf17834948744b2a3a4bdd79b912984e",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  current: {
    source: {
      bytes: 581616,
      sha256: "8f686f0798e4d07255346360daaba21bd24f72d868bb7850f34bf0aa8c5d66a9",
      gitBlob: "d6c1b9f0fcc9775f791a4c30b2e1056b69e34761",
    },
    dataSha256: "81a8fd3af0cbb9e82b89e1f05b3d731585d69472d4e1edd9dad80e0b9a21c50b",
    fileCount: 1819,
    filesSha256: "00c376929d4a8cd2a36c890f29fae0bb4f877dfe57034cfbd2fc6f872d630ec6",
    activationCount: 102,
    activationHistorySha256: "9a7e77fdc8c67fc0683879feb8bac8a9ef7854e9b083ac0c7e9affa4ddb24020",
    layersSha256: "08c5f625965b12541ccea85120abd644891a589be067c53f3dadcf7233f0e4ab",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
  },
  helperPrefix: {
    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
    bytes: 254018,
    sha256: "5130184ffe112a67a58081ed9074e5f2097ad9400279390ab8f9a825b4952bbe",
    gitBlob: "a2ea1676f20284a27c3a24d9d720d3ed53b5ebe0",
  },
  predecessorReceipt: {
    path: "tests/helpers/ir-runtime-program-policy-nested-stackification.json",
    bytes: 15523,
    sha256: "b88978d331ba72939f67a78f0091cf32b746c5ac276e29ecb24b3adbc98efdf3",
    gitBlob: "ad6d069f625c09dd58dfbd73f9cefeaebab4e22b",
  },
  sourceReceipt: {
    path: "tests/helpers/ir-program-validator-relocation.json",
    bytes: 27069,
    sha256: "816848c32744e8ec3e2c414a27420b4a0339e35d815b5002db4754f11104ff92",
    gitBlob: "77cba8ae7e0892930fc6fe30cd6f851b0104a4e3",
  },
  sourcePins: [
    {
      path: "src/ir/program-runtime-demands.ts",
      bytes: 474,
      sha256: "6af11b258faefd71a5602a021cdb8524f6d7bd804764e6ec7914440575f4fc39",
      gitBlob: "fce0ec1086445fba84a0e720c51b7e06405f2ed6",
    },
    {
      path: "src/ir/program-runtime-abi.ts",
      bytes: 363,
      sha256: "cec827cc20299610d6351e050cce5e9d3bd5198c9b334eb95253b96372ed7247",
      gitBlob: "307f5fd4b31c10c0bea32892e5d1c0c80e938188",
    },
    {
      path: "src/ir/runtime-program-manifest.ts",
      bytes: 450,
      sha256: "9d6a11bb96ce4dde466d92baf2945ca2c9a877ee5124a93ebaccac5118e44c56",
      gitBlob: "57fa674a5e7368c19cbc10e0ca608711b3889a55",
    },
    {
      path: "src/ir/program-runtime-validation.ts",
      bytes: 302,
      sha256: "8dbc664c29166cade8867d58f5bddb3af3e12d9e98c25aea2a9f8ce9c7ac7e9b",
      gitBlob: "604c5aa1638a98e23a745c957d13dab304a88ee7",
    },
    {
      path: "src/ir/program-validation.ts",
      bytes: 236,
      sha256: "b64454a7c97179e8efdab677049fb0f231ba3b6ce731bff602b231406d2dd098",
      gitBlob: "fbcd84648424059795285aa45f85020e564ed2ba",
    },
    {
      path: "src/ir/program/runtime-demands.ts",
      bytes: 13467,
      sha256: "74bfbc2fa49f6ce33fc5b4970a7dd0a5def4a6a17b009032321fce13cdfabf85",
      gitBlob: "cd7cfebb496ebf51d3bcc8bb5fbcd665607c5e4d",
    },
    {
      path: "src/ir/program/runtime-abi.ts",
      bytes: 4522,
      sha256: "65fcb7d226b260f30f517ae0f0a55117f5f5f99dcaef2c83219a466ee79cad4e",
      gitBlob: "670b421735b57cda583340acab33067a43e97811",
    },
    {
      path: "src/ir/program/runtime-manifest.ts",
      bytes: 12179,
      sha256: "069795708c8134e2bf69f17ed9f546a2f63c9f3494889213e6c26b211388f470",
      gitBlob: "11202df8cb0c5c1f5cb4bf34e27927365591242b",
    },
    {
      path: "src/ir/program/runtime-validation.ts",
      bytes: 8248,
      sha256: "1aa7bc3520b1c88483821d96fa41c633bb02e9082c6e6993605847ef296cd13f",
      gitBlob: "51ee28bc9e2e12bb392c6c680ce526256fdb4d65",
    },
    {
      path: "src/ir/program/validation.ts",
      bytes: 19448,
      sha256: "572aab2d72f9eabf322347e90c3d13e25f690a44fa3cede1ac5666dcd1674354",
      gitBlob: "18e65c59b175e01412683b4c0b977513bde868fe",
    },
  ],
  topLevelKeys: [
    "schema",
    "description",
    "sourceRoot",
    "tsconfig",
    "requireGitProvenance",
    "externalAssets",
    "frontendWrapper",
    "moduleExtensions",
    "layers",
    "allowedEdges",
    "externalPackages",
    "activationHistory",
    "nonModules",
    "moves",
    "evidence",
    "files",
  ],
  delta: {
    layerIndex: 9,
    beforeLayer: {
      id: "ir-program",
      status: "active",
      roots: ["src/ir/program"],
      required: true,
      entries: [
        "src/ir/program/abi-inventory.ts",
        "src/ir/program/abi.ts",
        "src/ir/program/startup.ts",
        "src/ir/program/abi-lookup.ts",
        "src/ir/program/callable-bindings.ts",
        "src/ir/program/controls.ts",
        "src/ir/program/index.ts",
        "src/ir/program/input-contracts.ts",
        "src/ir/program/prepared-contracts.ts",
        "src/ir/program/errors.ts",
        "src/ir/program/data.ts",
        "src/ir/program/input.ts",
        "src/ir/program/native-vector-resources.ts",
        "src/ir/program/native-promise-resources.ts",
        "src/ir/program/native-value-resources.ts",
        "src/ir/program/native-string-value-demands.ts",
        "src/ir/program/runtime-support.ts",
        "src/ir/program/formatter-support.ts",
        "src/ir/program/native-number-format-requirements.ts",
        "src/ir/program/async-frame-setup.ts",
        "src/ir/program/prepared-async-frame-plan.ts",
        "src/ir/program/abi-signatures.ts",
        "src/ir/program/host-async-dynamic.ts",
        "src/ir/program/host-import-plan.ts",
        "src/ir/program/host-number-boundary-setup.ts",
        "src/ir/program/runtime-abi-identity.ts",
        "src/ir/program/native-string-output-requirements.ts",
        "src/ir/program/callable-results.ts",
        "src/ir/program/native-source-closure-requirements.ts",
        "src/ir/program/population.ts",
        "src/ir/program/native-ref-cell-requirements.ts",
        "src/ir/program/native-invocation-requirements.ts",
        "src/ir/program/native-object-access-requirements.ts",
        "src/ir/program/native-getter-invocation-requirements.ts",
        "src/ir/program/native-object-result-requirements.ts",
        "src/ir/program/native-object-result-values.ts",
        "src/ir/program/native-prototype-requirements.ts",
        "src/ir/program/native-realm-requirements.ts",
        "src/ir/program/allocations.ts",
        "src/ir/program/class-layouts.ts",
        "src/ir/program/owner.ts",
        "src/ir/program/draft-abi-lookup.ts",
        "src/ir/program/runtime-support-dependencies.ts",
      ],
      minModules: 43,
    },
    currentLayer: {
      id: "ir-program",
      status: "active",
      roots: ["src/ir/program"],
      required: true,
      entries: [
        "src/ir/program/abi-inventory.ts",
        "src/ir/program/abi.ts",
        "src/ir/program/startup.ts",
        "src/ir/program/abi-lookup.ts",
        "src/ir/program/callable-bindings.ts",
        "src/ir/program/controls.ts",
        "src/ir/program/index.ts",
        "src/ir/program/input-contracts.ts",
        "src/ir/program/prepared-contracts.ts",
        "src/ir/program/errors.ts",
        "src/ir/program/data.ts",
        "src/ir/program/input.ts",
        "src/ir/program/native-vector-resources.ts",
        "src/ir/program/native-promise-resources.ts",
        "src/ir/program/native-value-resources.ts",
        "src/ir/program/native-string-value-demands.ts",
        "src/ir/program/runtime-support.ts",
        "src/ir/program/formatter-support.ts",
        "src/ir/program/native-number-format-requirements.ts",
        "src/ir/program/async-frame-setup.ts",
        "src/ir/program/prepared-async-frame-plan.ts",
        "src/ir/program/abi-signatures.ts",
        "src/ir/program/host-async-dynamic.ts",
        "src/ir/program/host-import-plan.ts",
        "src/ir/program/host-number-boundary-setup.ts",
        "src/ir/program/runtime-abi-identity.ts",
        "src/ir/program/native-string-output-requirements.ts",
        "src/ir/program/callable-results.ts",
        "src/ir/program/native-source-closure-requirements.ts",
        "src/ir/program/population.ts",
        "src/ir/program/native-ref-cell-requirements.ts",
        "src/ir/program/native-invocation-requirements.ts",
        "src/ir/program/native-object-access-requirements.ts",
        "src/ir/program/native-getter-invocation-requirements.ts",
        "src/ir/program/native-object-result-requirements.ts",
        "src/ir/program/native-object-result-values.ts",
        "src/ir/program/native-prototype-requirements.ts",
        "src/ir/program/native-realm-requirements.ts",
        "src/ir/program/allocations.ts",
        "src/ir/program/class-layouts.ts",
        "src/ir/program/owner.ts",
        "src/ir/program/draft-abi-lookup.ts",
        "src/ir/program/runtime-support-dependencies.ts",
        "src/ir/program/runtime-demands.ts",
        "src/ir/program/runtime-abi.ts",
        "src/ir/program/runtime-manifest.ts",
        "src/ir/program/runtime-validation.ts",
        "src/ir/program/validation.ts",
      ],
      minModules: 48,
    },
    facades: [
      {
        index: 1353,
        before: {
          path: "src/ir/program-runtime-abi.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        current: {
          path: "src/ir/program-runtime-abi.ts",
          state: "compatibility-adapter",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit identity-preserving compatibility exports for the canonical prepared-program owner; retain existing callers until the complete IR path is tested and equivalent.",
        },
        beforePrevious: {
          path: "src/ir/program-prepare-ir.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Separate the complete type closure of typed preparation, program ABI/population, validation and authenticated runtime projections before placement in ir-program; preserve explicit controls and transaction-owned allocations.",
        },
        beforeNext: {
          path: "src/ir/program-runtime-demands.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        currentPrevious: {
          path: "src/ir/program-prepare-ir.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Separate the complete type closure of typed preparation, program ABI/population, validation and authenticated runtime projections before placement in ir-program; preserve explicit controls and transaction-owned allocations.",
        },
        currentNext: {
          path: "src/ir/program-runtime-demands.ts",
          state: "compatibility-adapter",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit identity-preserving compatibility exports for the canonical prepared-program owner; retain existing callers until the complete IR path is tested and equivalent.",
        },
      },
      {
        index: 1354,
        before: {
          path: "src/ir/program-runtime-demands.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        current: {
          path: "src/ir/program-runtime-demands.ts",
          state: "compatibility-adapter",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit identity-preserving compatibility exports for the canonical prepared-program owner; retain existing callers until the complete IR path is tested and equivalent.",
        },
        beforePrevious: {
          path: "src/ir/program-runtime-abi.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        beforeNext: {
          path: "src/ir/program-runtime-validation.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        currentPrevious: {
          path: "src/ir/program-runtime-abi.ts",
          state: "compatibility-adapter",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit identity-preserving compatibility exports for the canonical prepared-program owner; retain existing callers until the complete IR path is tested and equivalent.",
        },
        currentNext: {
          path: "src/ir/program-runtime-validation.ts",
          state: "compatibility-adapter",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit identity-preserving compatibility exports for the canonical prepared-program owner; retain existing callers until the complete IR path is tested and equivalent.",
        },
      },
      {
        index: 1355,
        before: {
          path: "src/ir/program-runtime-validation.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        current: {
          path: "src/ir/program-runtime-validation.ts",
          state: "compatibility-adapter",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit identity-preserving compatibility exports for the canonical prepared-program owner; retain existing callers until the complete IR path is tested and equivalent.",
        },
        beforePrevious: {
          path: "src/ir/program-runtime-demands.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        beforeNext: {
          path: "src/ir/program-source.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "frontend-ts",
          owner: "3518-coordinator",
          nextBoundary:
            "Place source preparation under frontend/ts with explicit typed IR output contracts; separate AST/checker inventory and source carriers from pure prepared-program data. Preserve pending P edits; no whole-file move is authorized by this inventory entry.",
        },
        currentPrevious: {
          path: "src/ir/program-runtime-demands.ts",
          state: "compatibility-adapter",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit identity-preserving compatibility exports for the canonical prepared-program owner; retain existing callers until the complete IR path is tested and equivalent.",
        },
        currentNext: {
          path: "src/ir/program-source.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "frontend-ts",
          owner: "3518-coordinator",
          nextBoundary:
            "Place source preparation under frontend/ts with explicit typed IR output contracts; separate AST/checker inventory and source carriers from pure prepared-program data. Preserve pending P edits; no whole-file move is authorized by this inventory entry.",
        },
      },
      {
        index: 1358,
        before: {
          path: "src/ir/program-validation.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Place prepared-data validation in ir/program after splitting mixed inventory and program contracts; retain complete ABI, population and runtime checks without importing frontend or physical/backend authority.",
        },
        current: {
          path: "src/ir/program-validation.ts",
          state: "compatibility-adapter",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit identity-preserving compatibility exports for the canonical prepared-program owner; retain existing callers until the complete IR path is tested and equivalent.",
        },
        beforePrevious: {
          path: "src/ir/program-startup-proof.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        beforeNext: {
          path: "src/ir/program.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Complete src/ir/program/index.ts with pure prepared data/ABI only after splitting frontend inventory/module-init/outcome edges, backend acceptance and emission contracts, and deferred LinearOptions. Preserve runtime validation/transaction behavior through explicit boundaries; no whole-file relocation or clean declaration.",
        },
        currentPrevious: {
          path: "src/ir/program-startup-proof.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        currentNext: {
          path: "src/ir/program.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Complete src/ir/program/index.ts with pure prepared data/ABI only after splitting frontend inventory/module-init/outcome edges, backend acceptance and emission contracts, and deferred LinearOptions. Preserve runtime validation/transaction behavior through explicit boundaries; no whole-file relocation or clean declaration.",
        },
      },
      {
        index: 1372,
        before: {
          path: "src/ir/runtime-program-manifest.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Move complete whole-program runtime ownership and manifest preparation into ir/program after separating its implementation dependencies.",
        },
        current: {
          path: "src/ir/runtime-program-manifest.ts",
          state: "compatibility-adapter",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit identity-preserving compatibility exports for the canonical prepared-program owner; retain existing callers until the complete IR path is tested and equivalent.",
        },
        beforePrevious: {
          path: "src/ir/runtime-manifest.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        beforeNext: {
          path: "src/ir/runtime-program-producers.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Move complete whole-program runtime producer ownership into ir/program; ir/runtime must not depend on program population contracts.",
        },
        currentPrevious: {
          path: "src/ir/runtime-manifest.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        currentNext: {
          path: "src/ir/runtime-program-producers.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-program",
          owner: "3518-coordinator",
          nextBoundary:
            "Move complete whole-program runtime producer ownership into ir/program; ir/runtime must not depend on program population contracts.",
        },
      },
    ],
    addedRowIndex: 1814,
    addedRows: [
      {
        path: "src/ir/program/runtime-abi.ts",
        state: "clean",
        layer: "ir-program",
      },
      {
        path: "src/ir/program/runtime-demands.ts",
        state: "clean",
        layer: "ir-program",
      },
      {
        path: "src/ir/program/runtime-manifest.ts",
        state: "clean",
        layer: "ir-program",
      },
      {
        path: "src/ir/program/runtime-validation.ts",
        state: "clean",
        layer: "ir-program",
      },
      {
        path: "src/ir/program/validation.ts",
        state: "clean",
        layer: "ir-program",
      },
    ],
    addedRowPrevious: {
      path: "src/ir/runtime/intrinsic-preparation.ts",
      state: "clean",
      layer: "ir-runtime",
    },
    activationHistoryUnchanged: true,
    movesUnchanged: true,
  },
  rawSpans: [
    {
      beforeOffset: 8868,
      afterOffset: 8868,
      before: '        "src/ir/program/runtime-support-dependencies.ts"\n',
      after:
        '        "src/ir/program/runtime-support-dependencies.ts",\n        "src/ir/program/runtime-demands.ts",\n        "src/ir/program/runtime-abi.ts",\n        "src/ir/program/runtime-manifest.ts",\n        "src/ir/program/runtime-validation.ts",\n        "src/ir/program/validation.ts"\n',
    },
    {
      beforeOffset: 8934,
      afterOffset: 9154,
      before: '      "minModules": 43\n',
      after: '      "minModules": 48\n',
    },
    {
      beforeOffset: 477455,
      afterOffset: 477675,
      before: '      "state": "unmigrated",\n',
      after: '      "state": "compatibility-adapter",\n',
    },
    {
      beforeOffset: 477520,
      afterOffset: 477751,
      before: '      "destination": "ir-core",\n',
      after: '      "destination": "ir-program",\n',
    },
    {
      beforeOffset: 477587,
      afterOffset: 477821,
      before:
        '      "nextBoundary": "Separate pure IR contracts from frontend inventory and physical/backend dependencies."\n',
      after:
        '      "nextBoundary": "Explicit identity-preserving compatibility exports for the canonical prepared-program owner; retain existing callers until the complete IR path is tested and equivalent."\n',
    },
    {
      beforeOffset: 477761,
      afterOffset: 478079,
      before: '      "state": "unmigrated",\n',
      after: '      "state": "compatibility-adapter",\n',
    },
    {
      beforeOffset: 477826,
      afterOffset: 478155,
      before: '      "destination": "ir-core",\n',
      after: '      "destination": "ir-program",\n',
    },
    {
      beforeOffset: 477893,
      afterOffset: 478225,
      before:
        '      "nextBoundary": "Separate pure IR contracts from frontend inventory and physical/backend dependencies."\n',
      after:
        '      "nextBoundary": "Explicit identity-preserving compatibility exports for the canonical prepared-program owner; retain existing callers until the complete IR path is tested and equivalent."\n',
    },
    {
      beforeOffset: 478070,
      afterOffset: 478486,
      before: '      "state": "unmigrated",\n',
      after: '      "state": "compatibility-adapter",\n',
    },
    {
      beforeOffset: 478135,
      afterOffset: 478562,
      before: '      "destination": "ir-core",\n',
      after: '      "destination": "ir-program",\n',
    },
    {
      beforeOffset: 478202,
      afterOffset: 478632,
      before:
        '      "nextBoundary": "Separate pure IR contracts from frontend inventory and physical/backend dependencies."\n',
      after:
        '      "nextBoundary": "Explicit identity-preserving compatibility exports for the canonical prepared-program owner; retain existing callers until the complete IR path is tested and equivalent."\n',
    },
    {
      beforeOffset: 479142,
      afterOffset: 479656,
      before: '      "state": "unmigrated",\n',
      after: '      "state": "compatibility-adapter",\n',
    },
    {
      beforeOffset: 479277,
      afterOffset: 479802,
      before:
        '      "nextBoundary": "Place prepared-data validation in ir/program after splitting mixed inventory and program contracts; retain complete ABI, population and runtime checks without importing frontend or physical/backend authority."\n',
      after:
        '      "nextBoundary": "Explicit identity-preserving compatibility exports for the canonical prepared-program owner; retain existing callers until the complete IR path is tested and equivalent."\n',
    },
    {
      beforeOffset: 483997,
      afterOffset: 484483,
      before: '      "state": "unmigrated",\n',
      after: '      "state": "compatibility-adapter",\n',
    },
    {
      beforeOffset: 484132,
      afterOffset: 484629,
      before:
        '      "nextBoundary": "Move complete whole-program runtime ownership and manifest preparation into ir/program after separating its implementation dependencies."\n',
      after:
        '      "nextBoundary": "Explicit identity-preserving compatibility exports for the canonical prepared-program owner; retain existing callers until the complete IR path is tested and equivalent."\n',
    },
    {
      beforeOffset: 580499,
      afterOffset: 581029,
      before: "",
      after:
        '    },\n    {\n      "path": "src/ir/program/runtime-abi.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/runtime-demands.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/runtime-manifest.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/runtime-validation.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/validation.ts",\n      "state": "clean",\n      "layer": "ir-program"\n',
    },
  ],
} as const;
const receiptPath = "tests/helpers/ir-runtime-program-policy-program-validator.json";
const helperPath = "tests/helpers/ir-runtime-program-policy-evolution.ts";
const authorityPath = "tests/helpers/ir-c1-authority.json";
const receiptSha256 = "e16eae0411ed069a37bb8e8073004e5ac2a31cecd9d3d983fe9080a313958014";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const raw = () =>
  captureWasmGcHelperPredecessorPolicySource(
    captureLoweringAnalysisPredecessorPolicySource(
      capturePresentationClassificationPredecessorPolicySource(
        captureArrayBufferIsViewMainPredecessorPolicySource(
          captureMainInventoryPredecessorPolicySource(
            capture5883InventoryPredecessorPolicySource(
              readFileSync(new URL("../scripts/compiler-boundaries.json", import.meta.url), "utf8"),
            ),
          ),
        ),
      ),
    ),
  );
const policy = () => JSON.parse(raw()) as Policy;
afterEach(async () => {
  await setImmediate();
});
function profile(p: Policy, current: boolean): void {
  const pin = current ? expected.current : expected.before;
  expect(Object.keys(p)).toEqual(expected.topLevelKeys);
  expect(sha(JSON.stringify(p))).toBe(pin.dataSha256);
  expect(p.files).toHaveLength(pin.fileCount);
  expect(sha(JSON.stringify(p.files))).toBe(pin.filesSha256);
  expect(p.activationHistory).toHaveLength(102);
  expect(sha(JSON.stringify(p.activationHistory))).toBe(pin.activationHistorySha256);
  expect(sha(JSON.stringify(p.layers))).toBe(pin.layersSha256);
  expect(sha(JSON.stringify(p.allowedEdges))).toBe(pin.allowedEdgesSha256);
  expect(p.moves).toHaveLength(7);
}
function reciprocal(text: string, forward: boolean): string {
  const bytes = Buffer.from(text);
  const pieces: Buffer[] = [];
  let consumed = 0;
  for (const span of expected.rawSpans) {
    const offset = forward ? span.beforeOffset : span.afterOffset;
    const from = Buffer.from(forward ? span.before : span.after);
    const to = Buffer.from(forward ? span.after : span.before);
    expect(offset).toBeGreaterThanOrEqual(consumed);
    expect(bytes.subarray(offset, offset + from.length).equals(from)).toBe(true);
    pieces.push(bytes.subarray(consumed, offset), to);
    consumed = offset + from.length;
  }
  pieces.push(bytes.subarray(consumed));
  return Buffer.concat(pieces).toString();
}
const physical = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const physicalFaultAuthorities = [
  receiptPath,
  helperPath,
  expected.predecessorReceipt.path,
  expected.sourceReceipt.path,
  authorityPath,
  ...expected.sourcePins.map((p) => p.path),
];
function expectMissingAuthority(action: () => void, path: string): void {
  let caught = false;
  let failure: unknown;
  try {
    action();
  } catch (error) {
    caught = true;
    failure = error;
  }
  expect(caught).toBe(true);
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
  const scratch = resolve(import.meta.dirname, "../.tmp/validator-owner/preservation-policy-writer/authority-faults");
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
    const pin =
      path === receiptPath
        ? { bytes: 29027, sha256: receiptSha256 }
        : path === helperPath
          ? expected.helperPrefix
          : path === expected.predecessorReceipt.path
            ? expected.predecessorReceipt
            : path === expected.sourceReceipt.path
              ? expected.sourceReceipt
              : path === authorityPath
                ? { bytes: original.length, sha256: sha(original) }
                : path === "src/ir/program/validation.ts"
                  ? { bytes: 45816, sha256: "33cba90b606278805766b4eb739214c31dd84babafb873773f3e92f60c470231" }
                  : expected.sourcePins.find((item) => item.path === path)!;
    const authenticated = path === helperPath ? original.subarray(0, 254018) : original;
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

describe("fixed five-owner program validator policy predecessor capture", () => {
  it("authenticates the independent fixed receipt and complete current profiles", () => {
    const bytes = readFileSync(physical(receiptPath));
    expect(bytes.length).toBe(29027);
    expect(sha(bytes)).toBe(receiptSha256);
    expect(JSON.parse(bytes.toString())).toEqual(expected);
    const text = raw();
    expect(Buffer.byteLength(text)).toBe(581616);
    expect(sha(text)).toBe("8f686f0798e4d07255346360daaba21bd24f72d868bb7850f34bf0aa8c5d66a9");
    profile(JSON.parse(text), true);
  });
  it("recovers the exact original raw bytes and independently replays all16 spans", () => {
    const text = raw();
    const predecessor = captureProgramValidatorPredecessorPolicySource(text);
    expect(Buffer.byteLength(predecessor)).toBe(580511);
    expect(sha(predecessor)).toBe("81a0d94238a16cb762befa909ff057fc55d2da720996cf04af196bdd50cff7b2");
    expect(predecessor).toBe(reciprocal(text, false));
    expect(reciprocal(predecessor, true)).toBe(text);
    profile(JSON.parse(predecessor), false);
  });
  it("detaches semantic operands and proves exact five rows/layer/history reciprocity", () => {
    const value = policy(),
      before = JSON.stringify(value),
      result = captureProgramValidatorPredecessorPolicy(value);
    profile(result, false);
    expect(JSON.stringify(value)).toBe(before);
    expect(result).not.toBe(value);
    expect(result.files).not.toBe(value.files);
    const replay = JSON.parse(JSON.stringify(result)) as Policy;
    const d = expected.delta;
    replay.layers[d.layerIndex] = JSON.parse(JSON.stringify(d.currentLayer));
    for (const row of d.facades) replay.files[row.index] = JSON.parse(JSON.stringify(row.current));
    replay.files.push(...JSON.parse(JSON.stringify(d.addedRows)));
    profile(replay, true);
    expect(replay).toEqual(value);
    expect(result.activationHistory).toEqual(value.activationHistory);
    expect(result.moves).toEqual(value.moves);
  });
  it("refuses the stale predecessor while the unchanged old D1 API admits it", () => {
    const before = reciprocal(raw(), false);
    expect(() => captureNestedStackificationPredecessorPolicySource(before)).not.toThrow();
    expect(() => captureProgramValidatorPredecessorPolicySource(before)).toThrow(
      "complete raw source profile mismatch",
    );
    expect(() => captureProgramValidatorPredecessorPolicy(JSON.parse(before))).toThrow(
      "complete policy profile mismatch",
    );
    expect(() => captureNestedStackificationPredecessorPolicySource(raw())).toThrow();
  });
  const mutations: readonly [string, (p: Policy) => void][] = [
    [
      "program floor",
      (p) => {
        p.layers[9]!.minModules = 47;
      },
    ],
    [
      "program entry order",
      (p) => {
        p.layers[9]!.entries.reverse();
      },
    ],
    [
      "program root",
      (p) => {
        p.layers[9]!.roots.push("src/frontend");
      },
    ],
    [
      "allowed edge",
      (p) => {
        p.allowedEdges["ir-program"]!.push("frontend-ts");
      },
    ],
    [
      "history order",
      (p) => {
        p.activationHistory.reverse();
      },
    ],
    [
      "move order",
      (p) => {
        p.moves!.reverse();
      },
    ],
    [
      "unrelated retained field",
      (p) => {
        p.description += " changed";
      },
    ],
    [
      "extra top field",
      (p) => {
        (p as unknown as Record<string, unknown>).unexpected = true;
      },
    ],
    [
      "new row membership",
      (p) => {
        p.files.pop();
      },
    ],
    [
      "new row duplication",
      (p) => {
        p.files.push({ ...p.files[p.files.length - 1]! });
      },
    ],
    [
      "new row order",
      (p) => {
        const last = p.files.pop()!;
        p.files.splice(1814, 0, last);
      },
    ],
    [
      "new row extra schema",
      (p) => {
        p.files[1814]!.unexpected = "field";
      },
    ],
    [
      "new row layer",
      (p) => {
        p.files[1814]!.layer = "ir-runtime";
      },
    ],
    [
      "extra clean row",
      (p) => {
        p.files.push({ path: "src/ir/program/foreign.ts", state: "clean", layer: "ir-program" });
      },
    ],
    [
      "facade schema",
      (p) => {
        p.files[expected.delta.facades[0]!.index]!.unexpected = "field";
      },
    ],
    [
      "facade owner",
      (p) => {
        p.files[expected.delta.facades[0]!.index]!.owner = "foreign";
      },
    ],
    [
      "facade neighbor",
      (p) => {
        p.files[expected.delta.facades[0]!.index - 1]!.path = "foreign.ts";
      },
    ],
    [
      "facade duplication",
      (p) => {
        p.files.push({ ...p.files[expected.delta.facades[0]!.index]! });
      },
    ],
  ];
  for (const [name, change] of mutations)
    it(`refuses semantic ${name}`, () => {
      const p = policy(),
        original = JSON.stringify(p);
      change(p);
      expect(JSON.stringify(p)).not.toBe(original);
      expect(() => captureProgramValidatorPredecessorPolicy(p)).toThrow("complete policy profile mismatch");
    });
  it("refuses a real sparse semantic array rather than an undefined assignment", () => {
    const p = policy();
    const n = p.activationHistory.length;
    expect(Reflect.deleteProperty(p.activationHistory, "1")).toBe(true);
    expect(p.activationHistory.length).toBe(n);
    expect(Object.hasOwn(p.activationHistory, 1)).toBe(false);
    expect(() => captureProgramValidatorPredecessorPolicy(p)).toThrow(/array holes|array hole/);
  });
  const invalid: readonly [string, boolean, () => unknown, RegExp][] = [
    ["raw boxed", true, () => new String(raw()), /primitive string/],
    ["raw number", true, () => 3, /primitive string/],
    ["semantic null", false, () => null, /plain object/],
    ["semantic boxed", false, () => new String("x"), /foreign prototype/],
    ["semantic undefined", false, () => undefined, /non-JSON/],
    ["semantic array", false, () => [], /plain object/],
    ["semantic symbol", false, () => ({ [Symbol("x")]: 1 }), /symbol policy key/],
    [
      "semantic cycle",
      false,
      () => {
        const p: Record<string, unknown> = {};
        p.self = p;
        return p;
      },
      /cyclic/,
    ],
    [
      "semantic getter",
      false,
      () =>
        Object.defineProperty({}, "x", {
          enumerable: true,
          get() {
            throw Error("getter must not run");
          },
        }),
      /accessor/,
    ],
    ["semantic hidden", false, () => Object.defineProperty({}, "x", { value: 1 }), /hidden/],
    ["semantic bigint", false, () => ({ x: 1n }), /non-JSON/],
  ];
  for (const [name, isRaw, make, message] of invalid)
    it(`refuses ${name} before missing authority with a real positive witness`, () => {
      const text = raw(),
        good = JSON.parse(text);
      const operand = make();
      withAuthorityFault(receiptPath, "missing", () => {
        expect(() =>
          isRaw
            ? captureProgramValidatorPredecessorPolicySource(operand as string)
            : captureProgramValidatorPredecessorPolicy(operand),
        ).toThrow(message);
        expectMissingAuthority(() => {
          if (isRaw) captureProgramValidatorPredecessorPolicySource(text);
          else captureProgramValidatorPredecessorPolicy(good);
        }, receiptPath);
      });
    });
  for (const [index, span] of expected.rawSpans.entries())
    for (const kind of ["missing", "duplicate", "relocated"] as const)
      it(`refuses raw span${index} ${kind}`, () => {
        const b = Buffer.from(raw()),
          start = span.afterOffset,
          part = Buffer.from(span.after),
          end = start + part.length;
        expect(b.subarray(start, end).equals(part)).toBe(true);
        const mutant =
          kind === "missing"
            ? Buffer.concat([b.subarray(0, start), b.subarray(end)])
            : kind === "duplicate"
              ? Buffer.concat([b.subarray(0, start), part, b.subarray(start)])
              : Buffer.concat([part, b.subarray(0, start), b.subarray(end)]);
        expect(mutant.equals(b)).toBe(false);
        expect(() => captureProgramValidatorPredecessorPolicySource(mutant.toString())).toThrow(
          "complete raw source profile mismatch",
        );
      });
  it("refuses whitespace-only raw drift although parsed current data is unchanged", () => {
    const text = raw(),
      changed = " " + text;
    expect(JSON.parse(changed)).toEqual(JSON.parse(text));
    expect(() => captureProgramValidatorPredecessorPolicySource(changed)).toThrow(
      "complete raw source profile mismatch",
    );
  });
  const apis = [
    { name: "semantic", run: (text: string) => captureProgramValidatorPredecessorPolicy(JSON.parse(text)) },
    { name: "raw", run: (text: string) => JSON.parse(captureProgramValidatorPredecessorPolicySource(text)) as Policy },
  ];
  for (const path of physicalFaultAuthorities)
    for (const kind of ["missing", "mutation"] as const)
      for (const api of apis)
        it(`fresh ${api.name} refuses ${kind} ${path} after success`, () => {
          const text = raw();
          profile(api.run(text), false);
          withAuthorityFault(path, kind, () => {
            if (kind === "missing")
              expectMissingAuthority(() => {
                api.run(text);
              }, path);
            else {
              const message =
                path === receiptPath
                  ? "receipt digest mismatch"
                  : path === helperPath
                    ? "complete predecessor helper prefix changed"
                    : path === expected.predecessorReceipt.path
                      ? "predecessor receipt changed"
                      : path === expected.sourceReceipt.path
                        ? "source receipt changed"
                        : path === authorityPath
                          ? "manifest digest mismatch"
                          : /complete source pin mismatch|full-file pin changed|length\/SHA256/;
              expect(() => api.run(text)).toThrow(message);
            }
          });
          profile(api.run(text), false);
        });
});
