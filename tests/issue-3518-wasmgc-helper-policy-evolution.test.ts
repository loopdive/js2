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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureLoweringAnalysisPredecessorPolicySource,
  captureWasmGcHelperPredecessorPolicy,
  captureWasmGcHelperPredecessorPolicySource,
  captureProgramValidatorPredecessorPolicy,
  captureProgramValidatorPredecessorPolicySource,
  type MutableIrRuntimeProgramPolicy,
} from "./helpers/ir-runtime-program-policy-evolution.js";
type Policy = MutableIrRuntimeProgramPolicy & { moves: { from: string; to: string }[] };
// Independently frozen root receipt/profile/source literals; never learned from candidate outputs.
const expected = {
  schema: 1,
  kind: "fixed-wasmgc-helper-owners-policy-relocation",
  provenance: {
    canonicalMain: "445233d34c32c22b1bdb3b4ca28faa61635c102b",
    planSha256: "41948d8bff679aad62ed649020eae0b55211095f21e293aa592edb0833cc5d49",
    sourceFreezeSha256: "5e5e193cf0662662335a0df563da8960dccfd3c10de9f70c1394a44012c92369",
    legacyRetained: true,
  },
  before: {
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
    moveCount: 7,
    movesSha256: "5f954546a4c59d7ff270ce190dd78541c16be488d1dbb9e76ef1171900fa4dbb",
  },
  current: {
    source: {
      bytes: 583163,
      sha256: "0ec45a8b2c003e0b4baf84556f8612e20fca88a3d48f81a13f8cf43ac113fdd0",
      gitBlob: "391b2701b382df0af5a42536fd61a830fd596eb4",
    },
    dataSha256: "f7ed5862d447d03557ed0e2a61060d143fcc9f2036e02120ac56839829082a83",
    fileCount: 1822,
    filesSha256: "1c23754ff749eb559320fa01408ba5891f9f7f264f2fb890284ed252459e4053",
    activationCount: 103,
    activationHistorySha256: "17888cd13913d430ce7b5338ee4b686e2c4f8f9a8ffb08934a5ba80b187c661a",
    layersSha256: "1987cb65521762925d57f822787a854b154297f98b3e736f1487154ebcf084d2",
    allowedEdgesSha256: "efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7",
    moveCount: 10,
    movesSha256: "8d85e70962ba34d74c9cabd9731601995ecc14434608a5d5deff99b186187224",
  },
  helperPrefix: {
    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
    bytes: 292423,
    sha256: "22e2dc2bd4ca495a661708f7ef4591aa77567ac55889bd19fb845788e32d21f4",
    gitBlob: "eb100dc9b4152f493d0d6584aeeb983cb724bc4d",
  },
  predecessorReceipt: {
    path: "tests/helpers/ir-runtime-program-policy-program-validator.json",
    bytes: 29027,
    sha256: "e16eae0411ed069a37bb8e8073004e5ac2a31cecd9d3d983fe9080a313958014",
    gitBlob: "1876d590ab03f55a912241230213c1c67984e4ab",
  },
  sourceInputs: [
    {
      path: "src/ir/lowering-dynamic-scratch.ts",
      bytes: 213,
      sha256: "a087a447591e5758eef6c3129d9711c58daec904e688b84a92dfec7cd47f6c5d",
      gitBlob: "fbe45239aa609ec2934abbd28bc34c50f46b57d9",
      mode: 420,
    },
    {
      path: "src/backend/wasmgc/lowering/dynamic-scratch.ts",
      bytes: 1386,
      sha256: "bbc60c9112858b01761a78fc2433af1cb1652cc047eebefc7d1e3f2fac5f75b4",
      gitBlob: "1dcf2d7394c1068972500e507e51b88f1dc9c1ac",
      mode: 420,
    },
    {
      path: "src/ir/backend/wasm-int32-coercion.ts",
      bytes: 256,
      sha256: "c3d4b0ea7b116f3dba3a12e7af6b07d6997f26fb6ac56410f0d8cca27202df5b",
      gitBlob: "e9d345d7053355444512bba265f7f15357277bc4",
      mode: 420,
    },
    {
      path: "src/backend/wasmgc/lowering/wasm-int32-coercion.ts",
      bytes: 3802,
      sha256: "bbd5114361f4efafbfd44945de8c4978c212605a7414c5392986fc282fe25325",
      gitBlob: "7b4a05e4327d70e41347178499f9297dca15019b",
      mode: 420,
    },
    {
      path: "src/ir/backend/wasm-math-minmax.ts",
      bytes: 238,
      sha256: "dfe54c9960961ed930c22410cfc94b1f2f7e609e03e356e5538bc2c4a48fb9ad",
      gitBlob: "c0c8f788489da89e09c37108c72661d450edd4a3",
      mode: 420,
    },
    {
      path: "src/backend/wasmgc/lowering/wasm-math-minmax.ts",
      bytes: 1688,
      sha256: "1a510ac3a491a4a4bca6676bd0a89454538d076c4d5d5e047c14505380a68d44",
      gitBlob: "158e0eaff28d5d3d6756ec588a706e3d4b1a38f0",
      mode: 420,
    },
  ],
  sourcePairs: [
    {
      donor: "src/ir/lowering-dynamic-scratch.ts",
      owner: "src/backend/wasmgc/lowering/dynamic-scratch.ts",
      before: {
        bytes: 1346,
        sha256: "e70eaec584d4fca7d2d17f9ce496536626e7fb287cd018c91705ca12f6b5d609",
        gitBlob: "633d0ee61485acbce8737d02aff50c0e17a7f6fc",
      },
      facade:
        '// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\n\nexport {\n  createIrDynamicScratchLocals,\n  type IrDynamicScratchLocals,\n} from "../backend/wasmgc/lowering/dynamic-scratch.js";\n',
      importRoutes: [
        {
          before: "./nodes.js",
          current: "../../../ir/core/types.js",
        },
        {
          before: "./types.js",
          current: "../../../wasm/model/instructions.js",
        },
      ],
      valueExports: ["createIrDynamicScratchLocals"],
      typeExports: ["IrDynamicScratchLocals"],
    },
    {
      donor: "src/ir/backend/wasm-int32-coercion.ts",
      owner: "src/backend/wasmgc/lowering/wasm-int32-coercion.ts",
      before: {
        bytes: 3778,
        sha256: "23cf996416285cf8495c2c6977396c9c81eaf2af79d8c15f1c8d6ef6f05da2a0",
        gitBlob: "da813f57a66c14ef2dab8adf3fedaeb5318cd8df",
      },
      facade:
        '// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\n\nexport {\n  emitWasmInt32Coercion,\n  emitWasmMathClz32,\n  emitWasmMathImul,\n  type WasmInt32CoercionScratch,\n} from "../../backend/wasmgc/lowering/wasm-int32-coercion.js";\n',
      importRoutes: [
        {
          before: "../types.js",
          current: "../../../wasm/model/instructions.js",
        },
      ],
      valueExports: ["emitWasmInt32Coercion", "emitWasmMathClz32", "emitWasmMathImul"],
      typeExports: ["WasmInt32CoercionScratch"],
    },
    {
      donor: "src/ir/backend/wasm-math-minmax.ts",
      owner: "src/backend/wasmgc/lowering/wasm-math-minmax.ts",
      before: {
        bytes: 1664,
        sha256: "76a3e201e5ed64e768963facfd87fdaedba31b0bcbd3b73300eb647237c4f822",
        gitBlob: "914463166562ceeb8d345b2b835013f8f0f0b7cc",
      },
      facade:
        '// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.\n\nexport {\n  emitWasmMathMinMax,\n  type WasmMathMinMaxScratch,\n  type WasmMathMinMaxOperation,\n} from "../../backend/wasmgc/lowering/wasm-math-minmax.js";\n',
      importRoutes: [
        {
          before: "../types.js",
          current: "../../../wasm/model/instructions.js",
        },
      ],
      valueExports: ["emitWasmMathMinMax"],
      typeExports: ["WasmMathMinMaxScratch", "WasmMathMinMaxOperation"],
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
    layerIndex: 11,
    beforeLayer: {
      id: "backend-wasmgc",
      status: "active",
      roots: ["src/backend/wasmgc"],
      required: true,
      entries: [
        "src/backend/wasmgc/resources/native-vectors.ts",
        "src/backend/wasmgc/resources/native-promises.ts",
        "src/backend/wasmgc/resources/native-string-literals.ts",
        "src/backend/wasmgc/resources/native-errors.ts",
        "src/backend/wasmgc/resources/native-values.ts",
        "src/backend/wasmgc/resources/native-string-number.ts",
        "src/backend/wasmgc/resources/native-string-flatten.ts",
        "src/backend/wasmgc/resources/native-argument-vectors.ts",
        "src/backend/wasmgc/resources/native-closures.ts",
        "src/backend/wasmgc/resources/native-resource-declarations.ts",
        "src/backend/wasmgc/program/native-string-values.ts",
        "src/backend/wasmgc/program/native-number-format.ts",
        "src/backend/wasmgc/resources/native-number-ryu.ts",
        "src/backend/wasmgc/resources/native-number-format.ts",
        "src/backend/wasmgc/resources/native-delay-combinator.ts",
        "src/backend/wasmgc/async/prepared-async-frame-adapter.ts",
        "src/backend/wasmgc/resources/prepared-async-frame.ts",
        "src/backend/wasmgc/program/native-string-output-abi.ts",
        "src/backend/wasmgc/program/native-string-output.ts",
        "src/backend/wasmgc/resources/native-string-output.ts",
        "src/backend/wasmgc/resources/native-object-layouts.ts",
        "src/backend/wasmgc/resources/native-string-equality.ts",
        "src/backend/wasmgc/resources/native-symbol-carrier.ts",
        "src/backend/wasmgc/resources/native-booleans.ts",
        "src/backend/wasmgc/resources/native-source-closures.ts",
        "src/backend/wasmgc/resources/native-ref-cells.ts",
        "src/backend/wasmgc/program/native-invocation-abi.ts",
        "src/backend/wasmgc/resources/native-invocation.ts",
        "src/backend/wasmgc/resources/native-source-closure-callables.ts",
        "src/backend/wasmgc/resources/native-object-access-declarations.ts",
        "src/backend/wasmgc/resources/native-object-access.ts",
        "src/backend/wasmgc/resources/native-object-storage.ts",
        "src/backend/wasmgc/resources/native-bigint.ts",
        "src/backend/wasmgc/resources/native-object-same-value.ts",
        "src/backend/wasmgc/resources/native-object-descriptors.ts",
        "src/backend/wasmgc/resources/native-prototype-layouts.ts",
        "src/backend/wasmgc/resources/native-prototype-seeder-bindings.ts",
        "src/backend/wasmgc/resources/native-object-get.ts",
        "src/backend/wasmgc/program/native-primitive-boundary-abi.ts",
        "src/backend/wasmgc/resources/native-primitive-wrapper-layouts.ts",
        "src/backend/wasmgc/resources/native-primitive-wrapper-storage.ts",
        "src/backend/wasmgc/resources/native-builtin-function-requests.ts",
        "src/backend/wasmgc/resources/native-builtin-functions.ts",
        "src/backend/wasmgc/resources/native-invocation-substrate.ts",
        "src/backend/wasmgc/program/native-realm-literals.ts",
        "src/backend/wasmgc/program/native-realm.ts",
        "src/backend/wasmgc/resources/native-realm-object-layouts.ts",
        "src/backend/wasmgc/resources/native-object-realm.ts",
        "src/backend/wasmgc/resources/native-mixed-object-access.ts",
        "src/backend/wasmgc/resources/native-well-known-symbols.ts",
        "src/backend/wasmgc/resources/native-bigint-number.ts",
        "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",
      ],
      minModules: 52,
    },
    currentLayer: {
      id: "backend-wasmgc",
      status: "active",
      roots: ["src/backend/wasmgc"],
      required: true,
      entries: [
        "src/backend/wasmgc/resources/native-vectors.ts",
        "src/backend/wasmgc/resources/native-promises.ts",
        "src/backend/wasmgc/resources/native-string-literals.ts",
        "src/backend/wasmgc/resources/native-errors.ts",
        "src/backend/wasmgc/resources/native-values.ts",
        "src/backend/wasmgc/resources/native-string-number.ts",
        "src/backend/wasmgc/resources/native-string-flatten.ts",
        "src/backend/wasmgc/resources/native-argument-vectors.ts",
        "src/backend/wasmgc/resources/native-closures.ts",
        "src/backend/wasmgc/resources/native-resource-declarations.ts",
        "src/backend/wasmgc/program/native-string-values.ts",
        "src/backend/wasmgc/program/native-number-format.ts",
        "src/backend/wasmgc/resources/native-number-ryu.ts",
        "src/backend/wasmgc/resources/native-number-format.ts",
        "src/backend/wasmgc/resources/native-delay-combinator.ts",
        "src/backend/wasmgc/async/prepared-async-frame-adapter.ts",
        "src/backend/wasmgc/resources/prepared-async-frame.ts",
        "src/backend/wasmgc/program/native-string-output-abi.ts",
        "src/backend/wasmgc/program/native-string-output.ts",
        "src/backend/wasmgc/resources/native-string-output.ts",
        "src/backend/wasmgc/resources/native-object-layouts.ts",
        "src/backend/wasmgc/resources/native-string-equality.ts",
        "src/backend/wasmgc/resources/native-symbol-carrier.ts",
        "src/backend/wasmgc/resources/native-booleans.ts",
        "src/backend/wasmgc/resources/native-source-closures.ts",
        "src/backend/wasmgc/resources/native-ref-cells.ts",
        "src/backend/wasmgc/program/native-invocation-abi.ts",
        "src/backend/wasmgc/resources/native-invocation.ts",
        "src/backend/wasmgc/resources/native-source-closure-callables.ts",
        "src/backend/wasmgc/resources/native-object-access-declarations.ts",
        "src/backend/wasmgc/resources/native-object-access.ts",
        "src/backend/wasmgc/resources/native-object-storage.ts",
        "src/backend/wasmgc/resources/native-bigint.ts",
        "src/backend/wasmgc/resources/native-object-same-value.ts",
        "src/backend/wasmgc/resources/native-object-descriptors.ts",
        "src/backend/wasmgc/resources/native-prototype-layouts.ts",
        "src/backend/wasmgc/resources/native-prototype-seeder-bindings.ts",
        "src/backend/wasmgc/resources/native-object-get.ts",
        "src/backend/wasmgc/program/native-primitive-boundary-abi.ts",
        "src/backend/wasmgc/resources/native-primitive-wrapper-layouts.ts",
        "src/backend/wasmgc/resources/native-primitive-wrapper-storage.ts",
        "src/backend/wasmgc/resources/native-builtin-function-requests.ts",
        "src/backend/wasmgc/resources/native-builtin-functions.ts",
        "src/backend/wasmgc/resources/native-invocation-substrate.ts",
        "src/backend/wasmgc/program/native-realm-literals.ts",
        "src/backend/wasmgc/program/native-realm.ts",
        "src/backend/wasmgc/resources/native-realm-object-layouts.ts",
        "src/backend/wasmgc/resources/native-object-realm.ts",
        "src/backend/wasmgc/resources/native-mixed-object-access.ts",
        "src/backend/wasmgc/resources/native-well-known-symbols.ts",
        "src/backend/wasmgc/resources/native-bigint-number.ts",
        "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",
        "src/backend/wasmgc/lowering/dynamic-scratch.ts",
        "src/backend/wasmgc/lowering/wasm-int32-coercion.ts",
        "src/backend/wasmgc/lowering/wasm-math-minmax.ts",
      ],
      minModules: 55,
    },
    facades: [
      {
        index: 1296,
        before: {
          path: "src/ir/lowering-dynamic-scratch.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        current: {
          path: "src/ir/lowering-dynamic-scratch.ts",
          state: "compatibility-adapter",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent.",
        },
        beforePrevious: {
          path: "src/ir/lower.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit old-path compatibility facade re-exports canonical generic lowering, Wasm assembly, constants and types; no implementations or factories remain here. Retain legacy consumers until their independent migration.",
        },
        beforeNext: {
          path: "src/ir/math-runtime-providers.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        currentPrevious: {
          path: "src/ir/lower.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit old-path compatibility facade re-exports canonical generic lowering, Wasm assembly, constants and types; no implementations or factories remain here. Retain legacy consumers until their independent migration.",
        },
        currentNext: {
          path: "src/ir/math-runtime-providers.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
      },
      {
        index: 1218,
        before: {
          path: "src/ir/backend/wasm-int32-coercion.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        current: {
          path: "src/ir/backend/wasm-int32-coercion.ts",
          state: "compatibility-adapter",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent.",
        },
        beforePrevious: {
          path: "src/ir/backend/string-contract.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        beforeNext: {
          path: "src/ir/backend/wasm-math-minmax.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        currentPrevious: {
          path: "src/ir/backend/string-contract.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        currentNext: {
          path: "src/ir/backend/wasm-math-minmax.ts",
          state: "compatibility-adapter",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent.",
        },
      },
      {
        index: 1219,
        before: {
          path: "src/ir/backend/wasm-math-minmax.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        current: {
          path: "src/ir/backend/wasm-math-minmax.ts",
          state: "compatibility-adapter",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent.",
        },
        beforePrevious: {
          path: "src/ir/backend/wasm-int32-coercion.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary: "Separate pure IR contracts from frontend inventory and physical/backend dependencies.",
        },
        beforeNext: {
          path: "src/ir/backend/lower-contracts.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary:
            "Canonical lowering resolver/result types without implementation imports; existing IR-node and physical layout type dependencies still prevent a pure-contract certification.",
        },
        currentPrevious: {
          path: "src/ir/backend/wasm-int32-coercion.ts",
          state: "compatibility-adapter",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary:
            "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent.",
        },
        currentNext: {
          path: "src/ir/backend/lower-contracts.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "ir-core",
          owner: "3518-coordinator",
          nextBoundary:
            "Canonical lowering resolver/result types without implementation imports; existing IR-node and physical layout type dependencies still prevent a pure-contract certification.",
        },
      },
    ],
    fileBeforeTail: {
      path: "src/ir/program/validation.ts",
      state: "clean",
      layer: "ir-program",
    },
    fileAppends: [
      {
        path: "src/backend/wasmgc/lowering/dynamic-scratch.ts",
        state: "clean",
        layer: "backend-wasmgc",
      },
      {
        path: "src/backend/wasmgc/lowering/wasm-int32-coercion.ts",
        state: "clean",
        layer: "backend-wasmgc",
      },
      {
        path: "src/backend/wasmgc/lowering/wasm-math-minmax.ts",
        state: "clean",
        layer: "backend-wasmgc",
      },
    ],
    beforeMoveCount: 7,
    moveBeforeTail: {
      from: "src/ir/program-abi-contracts.ts",
      to: "src/ir/program/abi-signatures.ts",
    },
    moveAppends: [
      {
        from: "src/ir/lowering-dynamic-scratch.ts",
        to: "src/backend/wasmgc/lowering/dynamic-scratch.ts",
      },
      {
        from: "src/ir/backend/wasm-int32-coercion.ts",
        to: "src/backend/wasmgc/lowering/wasm-int32-coercion.ts",
      },
      {
        from: "src/ir/backend/wasm-math-minmax.ts",
        to: "src/backend/wasmgc/lowering/wasm-math-minmax.ts",
      },
    ],
    beforeActivationCount: 102,
    activationBeforeTail: {
      layer: "ir-runtime",
      entries: ["src/ir/runtime/intrinsic-preparation.ts"],
      minModules: 1,
    },
    activationAppend: {
      layer: "backend-wasmgc",
      entries: [
        "src/backend/wasmgc/lowering/dynamic-scratch.ts",
        "src/backend/wasmgc/lowering/wasm-int32-coercion.ts",
        "src/backend/wasmgc/lowering/wasm-math-minmax.ts",
      ],
      minModules: 55,
    },
  },
  raw: {
    offsetUnit: "utf8-byte",
    spans: [
      {
        role: "fixed-delta-0",
        beforeOffset: 13386,
        afterOffset: 13386,
        before: '        "src/backend/wasmgc/resources/native-number-primitive-classifier.ts"\n',
        after:
          '        "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",\n        "src/backend/wasmgc/lowering/dynamic-scratch.ts",\n        "src/backend/wasmgc/lowering/wasm-int32-coercion.ts",\n        "src/backend/wasmgc/lowering/wasm-math-minmax.ts"\n',
      },
      {
        role: "fixed-delta-1",
        beforeOffset: 13472,
        afterOffset: 13651,
        before: '      "minModules": 52\n',
        after: '      "minModules": 55\n',
      },
      {
        role: "fixed-delta-2",
        beforeOffset: 67229,
        afterOffset: 67408,
        before: "",
        after:
          '    },\n    {\n      "layer": "backend-wasmgc",\n      "entries": [\n        "src/backend/wasmgc/lowering/dynamic-scratch.ts",\n        "src/backend/wasmgc/lowering/wasm-int32-coercion.ts",\n        "src/backend/wasmgc/lowering/wasm-math-minmax.ts"\n      ],\n      "minModules": 55\n',
      },
      {
        role: "fixed-delta-3",
        beforeOffset: 68368,
        afterOffset: 68822,
        before: "",
        after:
          '    },\n    {\n      "from": "src/ir/lowering-dynamic-scratch.ts",\n      "to": "src/backend/wasmgc/lowering/dynamic-scratch.ts"\n    },\n    {\n      "from": "src/ir/backend/wasm-int32-coercion.ts",\n      "to": "src/backend/wasmgc/lowering/wasm-int32-coercion.ts"\n    },\n    {\n      "from": "src/ir/backend/wasm-math-minmax.ts",\n      "to": "src/backend/wasmgc/lowering/wasm-math-minmax.ts"\n',
      },
      {
        role: "fixed-delta-4",
        beforeOffset: 433760,
        afterOffset: 434600,
        before: '      "state": "unmigrated",\n',
        after: '      "state": "compatibility-adapter",\n',
      },
      {
        role: "fixed-delta-5",
        beforeOffset: 433825,
        afterOffset: 434676,
        before: '      "destination": "ir-core",\n',
        after: '      "destination": "backend-wasmgc",\n',
      },
      {
        role: "fixed-delta-6",
        beforeOffset: 433892,
        afterOffset: 434750,
        before:
          '      "nextBoundary": "Separate pure IR contracts from frontend inventory and physical/backend dependencies."\n',
        after:
          '      "nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."\n',
      },
      {
        role: "fixed-delta-7",
        beforeOffset: 434067,
        afterOffset: 435008,
        before: '      "state": "unmigrated",\n',
        after: '      "state": "compatibility-adapter",\n',
      },
      {
        role: "fixed-delta-8",
        beforeOffset: 434132,
        afterOffset: 435084,
        before: '      "destination": "ir-core",\n',
        after: '      "destination": "backend-wasmgc",\n',
      },
      {
        role: "fixed-delta-9",
        beforeOffset: 434199,
        afterOffset: 435158,
        before:
          '      "nextBoundary": "Separate pure IR contracts from frontend inventory and physical/backend dependencies."\n',
        after:
          '      "nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."\n',
      },
      {
        role: "fixed-delta-10",
        beforeOffset: 458259,
        afterOffset: 459301,
        before: '      "state": "unmigrated",\n',
        after: '      "state": "compatibility-adapter",\n',
      },
      {
        role: "fixed-delta-11",
        beforeOffset: 458324,
        afterOffset: 459377,
        before: '      "destination": "ir-core",\n',
        after: '      "destination": "backend-wasmgc",\n',
      },
      {
        role: "fixed-delta-12",
        beforeOffset: 458391,
        afterOffset: 459451,
        before:
          '      "nextBoundary": "Separate pure IR contracts from frontend inventory and physical/backend dependencies."\n',
        after:
          '      "nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."\n',
      },
      {
        role: "fixed-delta-13",
        beforeOffset: 581604,
        afterOffset: 582747,
        before: "",
        after:
          '    },\n    {\n      "path": "src/backend/wasmgc/lowering/dynamic-scratch.ts",\n      "state": "clean",\n      "layer": "backend-wasmgc"\n    },\n    {\n      "path": "src/backend/wasmgc/lowering/wasm-int32-coercion.ts",\n      "state": "clean",\n      "layer": "backend-wasmgc"\n    },\n    {\n      "path": "src/backend/wasmgc/lowering/wasm-math-minmax.ts",\n      "state": "clean",\n      "layer": "backend-wasmgc"\n',
      },
    ],
  },
} as const;
const olderBefore = {
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
} as const;
const fixedRawFaults = [
  {
    index: 0,
    omission: {
      offset: 13386,
      before:
        '        "src/backend/wasmgc/resources/native-number-primitive-classifier.ts",\n        "src/backend/wasmgc/lowering/dynamic-scratch.ts",\n        "src/backend/wasmgc/lowering/wasm-int32-coercion.ts",\n        "src/backend/wasmgc/lowering/wasm-math-minmax.ts"\n',
      after: '        "src/backend/wasmgc/resources/native-number-primitive-classifier.ts"\n',
    },
    duplicate: {
      offset: 13394,
      before: '"src/backend/wasmgc/resources/native-number-primitive-classifier.ts"',
      after:
        '"src/backend/wasmgc/resources/native-number-primitive-classifier.ts","src/backend/wasmgc/resources/native-number-primitive-classifier.ts"',
    },
    literalReorder: [
      {
        offset: 13394,
        before: '"src/backend/wasmgc/resources/native-number-primitive-classifier.ts"',
        after: '"entries"',
      },
      {
        offset: 67460,
        before: '"entries"',
        after: '"src/backend/wasmgc/resources/native-number-primitive-classifier.ts"',
      },
    ],
  },
  {
    index: 1,
    omission: {
      offset: 13651,
      before: '      "minModules": 55\n',
      after: '      "minModules": 52\n',
    },
    duplicate: {
      offset: 13657,
      before: '"minModules": 55',
      after: '"minModules": 55,"minModules": 55',
    },
    literalReorder: [
      {
        offset: 13657,
        before: '"minModules": 55',
        after: '"layer": "backend-wasmgc"',
      },
      {
        offset: 67427,
        before: '"layer": "backend-wasmgc"',
        after: '"minModules": 55',
      },
    ],
  },
  {
    index: 2,
    omission: {
      offset: 67408,
      before:
        '    },\n    {\n      "layer": "backend-wasmgc",\n      "entries": [\n        "src/backend/wasmgc/lowering/dynamic-scratch.ts",\n        "src/backend/wasmgc/lowering/wasm-int32-coercion.ts",\n        "src/backend/wasmgc/lowering/wasm-math-minmax.ts"\n      ],\n      "minModules": 55\n',
      after: "",
    },
    duplicate: {
      offset: 67427,
      before: '"layer": "backend-wasmgc"',
      after: '"layer": "backend-wasmgc","layer": "backend-wasmgc"',
    },
    literalReorder: [
      {
        offset: 67427,
        before: '"layer": "backend-wasmgc"',
        after: '"minModules": 55',
      },
      {
        offset: 13657,
        before: '"minModules": 55',
        after: '"layer": "backend-wasmgc"',
      },
    ],
  },
  {
    index: 3,
    omission: {
      offset: 68822,
      before:
        '    },\n    {\n      "from": "src/ir/lowering-dynamic-scratch.ts",\n      "to": "src/backend/wasmgc/lowering/dynamic-scratch.ts"\n    },\n    {\n      "from": "src/ir/backend/wasm-int32-coercion.ts",\n      "to": "src/backend/wasmgc/lowering/wasm-int32-coercion.ts"\n    },\n    {\n      "from": "src/ir/backend/wasm-math-minmax.ts",\n      "to": "src/backend/wasmgc/lowering/wasm-math-minmax.ts"\n',
      after: "",
    },
    duplicate: {
      offset: 68841,
      before: '"from": "src/ir/lowering-dynamic-scratch.ts"',
      after: '"from": "src/ir/lowering-dynamic-scratch.ts","from": "src/ir/lowering-dynamic-scratch.ts"',
    },
    literalReorder: [
      {
        offset: 68841,
        before: '"from": "src/ir/lowering-dynamic-scratch.ts"',
        after: '"minModules": 55',
      },
      {
        offset: 13657,
        before: '"minModules": 55',
        after: '"from": "src/ir/lowering-dynamic-scratch.ts"',
      },
    ],
  },
  {
    index: 4,
    omission: {
      offset: 434600,
      before: '      "state": "compatibility-adapter",\n',
      after: '      "state": "unmigrated",\n',
    },
    duplicate: {
      offset: 434606,
      before: '"state": "compatibility-adapter"',
      after: '"state": "compatibility-adapter","state": "compatibility-adapter"',
    },
    literalReorder: [
      {
        offset: 434606,
        before: '"state": "compatibility-adapter"',
        after: '"minModules": 55',
      },
      {
        offset: 13657,
        before: '"minModules": 55',
        after: '"state": "compatibility-adapter"',
      },
    ],
  },
  {
    index: 5,
    omission: {
      offset: 434676,
      before: '      "destination": "backend-wasmgc",\n',
      after: '      "destination": "ir-core",\n',
    },
    duplicate: {
      offset: 434682,
      before: '"destination": "backend-wasmgc"',
      after: '"destination": "backend-wasmgc","destination": "backend-wasmgc"',
    },
    literalReorder: [
      {
        offset: 434682,
        before: '"destination": "backend-wasmgc"',
        after: '"minModules": 55',
      },
      {
        offset: 13657,
        before: '"minModules": 55',
        after: '"destination": "backend-wasmgc"',
      },
    ],
  },
  {
    index: 6,
    omission: {
      offset: 434750,
      before:
        '      "nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."\n',
      after:
        '      "nextBoundary": "Separate pure IR contracts from frontend inventory and physical/backend dependencies."\n',
    },
    duplicate: {
      offset: 434756,
      before:
        '"nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."',
      after:
        '"nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent.","nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."',
    },
    literalReorder: [
      {
        offset: 434756,
        before:
          '"nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."',
        after: '"minModules": 55',
      },
      {
        offset: 13657,
        before: '"minModules": 55',
        after:
          '"nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."',
      },
    ],
  },
  {
    index: 7,
    omission: {
      offset: 435008,
      before: '      "state": "compatibility-adapter",\n',
      after: '      "state": "unmigrated",\n',
    },
    duplicate: {
      offset: 435014,
      before: '"state": "compatibility-adapter"',
      after: '"state": "compatibility-adapter","state": "compatibility-adapter"',
    },
    literalReorder: [
      {
        offset: 435014,
        before: '"state": "compatibility-adapter"',
        after: '"minModules": 55',
      },
      {
        offset: 13657,
        before: '"minModules": 55',
        after: '"state": "compatibility-adapter"',
      },
    ],
  },
  {
    index: 8,
    omission: {
      offset: 435084,
      before: '      "destination": "backend-wasmgc",\n',
      after: '      "destination": "ir-core",\n',
    },
    duplicate: {
      offset: 435090,
      before: '"destination": "backend-wasmgc"',
      after: '"destination": "backend-wasmgc","destination": "backend-wasmgc"',
    },
    literalReorder: [
      {
        offset: 435090,
        before: '"destination": "backend-wasmgc"',
        after: '"minModules": 55',
      },
      {
        offset: 13657,
        before: '"minModules": 55',
        after: '"destination": "backend-wasmgc"',
      },
    ],
  },
  {
    index: 9,
    omission: {
      offset: 435158,
      before:
        '      "nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."\n',
      after:
        '      "nextBoundary": "Separate pure IR contracts from frontend inventory and physical/backend dependencies."\n',
    },
    duplicate: {
      offset: 435164,
      before:
        '"nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."',
      after:
        '"nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent.","nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."',
    },
    literalReorder: [
      {
        offset: 435164,
        before:
          '"nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."',
        after: '"minModules": 55',
      },
      {
        offset: 13657,
        before: '"minModules": 55',
        after:
          '"nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."',
      },
    ],
  },
  {
    index: 10,
    omission: {
      offset: 459301,
      before: '      "state": "compatibility-adapter",\n',
      after: '      "state": "unmigrated",\n',
    },
    duplicate: {
      offset: 459307,
      before: '"state": "compatibility-adapter"',
      after: '"state": "compatibility-adapter","state": "compatibility-adapter"',
    },
    literalReorder: [
      {
        offset: 459307,
        before: '"state": "compatibility-adapter"',
        after: '"minModules": 55',
      },
      {
        offset: 13657,
        before: '"minModules": 55',
        after: '"state": "compatibility-adapter"',
      },
    ],
  },
  {
    index: 11,
    omission: {
      offset: 459377,
      before: '      "destination": "backend-wasmgc",\n',
      after: '      "destination": "ir-core",\n',
    },
    duplicate: {
      offset: 459383,
      before: '"destination": "backend-wasmgc"',
      after: '"destination": "backend-wasmgc","destination": "backend-wasmgc"',
    },
    literalReorder: [
      {
        offset: 459383,
        before: '"destination": "backend-wasmgc"',
        after: '"minModules": 55',
      },
      {
        offset: 13657,
        before: '"minModules": 55',
        after: '"destination": "backend-wasmgc"',
      },
    ],
  },
  {
    index: 12,
    omission: {
      offset: 459451,
      before:
        '      "nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."\n',
      after:
        '      "nextBoundary": "Separate pure IR contracts from frontend inventory and physical/backend dependencies."\n',
    },
    duplicate: {
      offset: 459457,
      before:
        '"nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."',
      after:
        '"nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent.","nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."',
    },
    literalReorder: [
      {
        offset: 459457,
        before:
          '"nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."',
        after: '"minModules": 55',
      },
      {
        offset: 13657,
        before: '"minModules": 55',
        after:
          '"nextBoundary": "Explicit identity-preserving compatibility exports for the canonical WasmGC lowering owner; retain existing callers until the complete IR path is tested and equivalent."',
      },
    ],
  },
  {
    index: 13,
    omission: {
      offset: 582747,
      before:
        '    },\n    {\n      "path": "src/backend/wasmgc/lowering/dynamic-scratch.ts",\n      "state": "clean",\n      "layer": "backend-wasmgc"\n    },\n    {\n      "path": "src/backend/wasmgc/lowering/wasm-int32-coercion.ts",\n      "state": "clean",\n      "layer": "backend-wasmgc"\n    },\n    {\n      "path": "src/backend/wasmgc/lowering/wasm-math-minmax.ts",\n      "state": "clean",\n      "layer": "backend-wasmgc"\n',
      after: "",
    },
    duplicate: {
      offset: 582766,
      before: '"path": "src/backend/wasmgc/lowering/dynamic-scratch.ts"',
      after:
        '"path": "src/backend/wasmgc/lowering/dynamic-scratch.ts","path": "src/backend/wasmgc/lowering/dynamic-scratch.ts"',
    },
    literalReorder: [
      {
        offset: 582766,
        before: '"path": "src/backend/wasmgc/lowering/dynamic-scratch.ts"',
        after: '"minModules": 55',
      },
      {
        offset: 13657,
        before: '"minModules": 55',
        after: '"path": "src/backend/wasmgc/lowering/dynamic-scratch.ts"',
      },
    ],
  },
] as const;
const receiptPath = "tests/helpers/ir-runtime-program-policy-wasmgc-helper-owners.json";
const helperPath = "tests/helpers/ir-runtime-program-policy-evolution.ts";
const receiptSha256 = "8e241366cd828fa0511dd399fbe127213808c8872dbd97ee536d89544de30b8b";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const blob = (value: Buffer) => createHash("sha1").update(`blob ${value.length}\0`).update(value).digest("hex");
const raw = () =>
  captureLoweringAnalysisPredecessorPolicySource(
    readFileSync(new URL("../scripts/compiler-boundaries.json", import.meta.url), "utf8"),
  );
const policy = () => JSON.parse(raw()) as Policy;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const physical = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const physicalFaultAuthorities = [
  receiptPath,
  expected.predecessorReceipt.path,
  helperPath,
  ...expected.sourceInputs.map((pin) => pin.path),
];
afterEach(async () => {
  await setImmediate();
});
function assertPin(
  bytes: Buffer,
  pin: { readonly bytes: number; readonly sha256: string; readonly gitBlob: string },
): void {
  expect(bytes.length).toBe(pin.bytes);
  expect(sha(bytes)).toBe(pin.sha256);
  expect(blob(bytes)).toBe(pin.gitBlob);
}
function profile(p: Policy, current: boolean): void {
  const pin = current ? expected.current : expected.before;
  expect(Object.keys(p)).toEqual(expected.topLevelKeys);
  expect(sha(JSON.stringify(p))).toBe(pin.dataSha256);
  expect(p.files).toHaveLength(pin.fileCount);
  expect(sha(JSON.stringify(p.files))).toBe(pin.filesSha256);
  expect(p.layers[expected.delta.layerIndex]).toEqual(
    current ? expected.delta.currentLayer : expected.delta.beforeLayer,
  );
  expect(sha(JSON.stringify(p.layers))).toBe(pin.layersSha256);
  expect(p.activationHistory).toHaveLength(pin.activationCount);
  expect(sha(JSON.stringify(p.activationHistory))).toBe(pin.activationHistorySha256);
  expect(sha(JSON.stringify(p.allowedEdges))).toBe(pin.allowedEdgesSha256);
  expect(p.moves).toHaveLength(pin.moveCount);
  expect(sha(JSON.stringify(p.moves))).toBe(pin.movesSha256);
  for (const row of expected.delta.facades) {
    expect(p.files[row.index]).toEqual(current ? row.current : row.before);
    expect(Object.keys(p.files[row.index]!)).toEqual(Object.keys(current ? row.current : row.before));
    expect(p.files[row.index - 1]).toEqual(current ? row.currentPrevious : row.beforePrevious);
    expect(p.files[row.index + 1]).toEqual(current ? row.currentNext : row.beforeNext);
  }
  expect(p.files.slice(expected.before.fileCount)).toEqual(current ? expected.delta.fileAppends : []);
  expect(p.moves.slice(expected.delta.beforeMoveCount)).toEqual(current ? expected.delta.moveAppends : []);
  expect(p.activationHistory.slice(expected.delta.beforeActivationCount)).toEqual(
    current ? [expected.delta.activationAppend] : [],
  );
}
function reciprocal(text: string, forward: boolean): string {
  const bytes = Buffer.from(text);
  assertPin(bytes, forward ? expected.before.source : expected.current.source);
  const pieces: Buffer[] = [];
  let used = 0;
  for (const span of expected.raw.spans) {
    const at = forward ? span.beforeOffset : span.afterOffset;
    const from = Buffer.from(forward ? span.before : span.after),
      to = Buffer.from(forward ? span.after : span.before);
    expect(at).toBeGreaterThanOrEqual(used);
    expect(bytes.subarray(at, at + from.length).equals(from)).toBe(true);
    pieces.push(bytes.subarray(used, at), to);
    used = at + from.length;
  }
  pieces.push(bytes.subarray(used));
  const result = Buffer.concat(pieces);
  assertPin(result, forward ? expected.current.source : expected.before.source);
  return result.toString();
}
function changeRaw(
  text: string,
  edits: readonly { readonly offset: number; readonly before: string; readonly after: string }[],
): string {
  let bytes = Buffer.from(text);
  for (const e of [...edits].sort((a, b) => b.offset - a.offset)) {
    const from = Buffer.from(e.before);
    expect(bytes.subarray(e.offset, e.offset + from.length).equals(from)).toBe(true);
    bytes = Buffer.concat([bytes.subarray(0, e.offset), Buffer.from(e.after), bytes.subarray(e.offset + from.length)]);
  }
  const result = bytes.toString();
  expect(() => JSON.parse(result)).not.toThrow();
  expect(result).not.toBe(text);
  return result;
}
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
  const scratch = resolve(import.meta.dirname, "../.tmp/wasmgc-helper-owners/preservation-writer/authority-faults");
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
        ? { bytes: 28909, sha256: receiptSha256 }
        : path === helperPath
          ? expected.helperPrefix
          : path === expected.predecessorReceipt.path
            ? expected.predecessorReceipt
            : expected.sourceInputs.find((item) => item.path === path)!;
    const authenticated = path === helperPath ? original.subarray(0, 292423) : original;
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

const apis = [
  { name: "semantic", run: (text: string): Policy => captureWasmGcHelperPredecessorPolicy(JSON.parse(text)) as Policy },
  {
    name: "raw",
    run: (text: string): Policy => JSON.parse(captureWasmGcHelperPredecessorPolicySource(text)) as Policy,
  },
] as const;
describe("fixed three WasmGC helper owners policy predecessor capture", () => {
  it("authenticates the independently fixed receipt and complete current domain", () => {
    const bytes = readFileSync(physical(receiptPath));
    expect(bytes.length).toBe(28909);
    expect(sha(bytes)).toBe(receiptSha256);
    expect(JSON.parse(bytes.toString())).toEqual(expected);
    assertPin(Buffer.from(raw()), expected.current.source);
    profile(policy(), true);
    expect(physicalFaultAuthorities).toHaveLength(9);
    expect(new Set(physicalFaultAuthorities).size).toBe(9);
  });
  it("recovers genuine445 raw bytes and replays all14 spans before unchanged old API", () => {
    const text = raw(),
      before = captureWasmGcHelperPredecessorPolicySource(text);
    expect(before).toBe(reciprocal(text, false));
    expect(reciprocal(before, true)).toBe(text);
    profile(JSON.parse(before), false);
    const earlier = captureProgramValidatorPredecessorPolicySource(before);
    assertPin(Buffer.from(earlier), olderBefore.source);
    expect(sha(JSON.stringify(JSON.parse(earlier)))).toBe(olderBefore.dataSha256);
  });
  it("detaches semantic input and independently replays rows layer history and moves", () => {
    const input = policy(),
      saved = JSON.stringify(input),
      before = captureWasmGcHelperPredecessorPolicy(input) as Policy;
    profile(before, false);
    expect(JSON.stringify(input)).toBe(saved);
    expect(before).not.toBe(input);
    expect(before.files).not.toBe(input.files);
    const replay = clone(before),
      d = expected.delta;
    replay.layers[d.layerIndex] = clone(d.currentLayer) as unknown as Policy["layers"][number];
    for (const row of d.facades) replay.files[row.index] = clone(row.current);
    replay.files.push(...clone(d.fileAppends));
    replay.moves.push(...clone(d.moveAppends));
    replay.activationHistory.push(clone(d.activationAppend) as unknown as Policy["activationHistory"][number]);
    profile(replay, true);
    expect(replay).toEqual(input);
    expect(before.moves).toEqual(input.moves.slice(0, 7));
    expect(before.activationHistory).toEqual(input.activationHistory.slice(0, 102));
    expect(sha(JSON.stringify(captureProgramValidatorPredecessorPolicy(before)))).toBe(olderBefore.dataSha256);
  });
  it("proves all three actual full donor inverses canonical replays and exact facades", () => {
    for (const pair of expected.sourcePairs) {
      const owner = readFileSync(physical(pair.owner), "utf8");
      expect(readFileSync(physical(pair.donor), "utf8")).toBe(pair.facade);
      let donor = owner;
      for (const route of pair.importRoutes) {
        const from = JSON.stringify(route.current);
        expect(donor.split(from)).toHaveLength(2);
        donor = donor.replace(from, JSON.stringify(route.before));
      }
      assertPin(Buffer.from(donor), pair.before);
      let replay = donor;
      for (const route of pair.importRoutes)
        replay = replay.replace(JSON.stringify(route.before), JSON.stringify(route.current));
      expect(replay).toBe(owner);
    }
    for (const pin of expected.sourceInputs) {
      assertPin(readFileSync(physical(pin.path)), pin);
      expect(lstatSync(physical(pin.path)).mode & 0o7777).toBe(pin.mode);
    }
  });
  for (const api of apis) {
    it(`${api.name} refuses stale445 while the unchanged program-validator API accepts it`, () => {
      const before = reciprocal(raw(), false);
      expect(() => api.run(before)).toThrow(/complete (policy|raw source) profile mismatch/);
      expect(() => captureProgramValidatorPredecessorPolicySource(before)).not.toThrow();
      expect(() => api.run(raw())).not.toThrow();
    });
  }
  const mutations: readonly [string, (p: Policy) => void][] = [
    [
      "retained description",
      (p) => {
        p.description = String(p.description) + " independent";
      },
    ],
    [
      "missing owner",
      (p) => {
        p.files.pop();
      },
    ],
    [
      "duplicate owner",
      (p) => {
        p.files.push(clone(expected.delta.fileAppends[0]));
      },
    ],
    [
      "reordered owners",
      (p) => {
        p.files.splice(1819, 3, ...p.files.slice(1819).reverse());
      },
    ],
    [
      "donor state",
      (p) => {
        p.files[expected.delta.facades[0].index]!.state = "unmigrated";
      },
    ],
    [
      "donor extra key",
      (p) => {
        p.files[expected.delta.facades[1].index]!.unexpected = "no";
      },
    ],
    [
      "owner extra key",
      (p) => {
        p.files[1819]!.unexpected = "no";
      },
    ],
    [
      "facade neighbor",
      (p) => {
        p.files[expected.delta.facades[2].index - 1]!.path += "-changed";
      },
    ],
    [
      "backend entry",
      (p) => {
        p.layers[11]!.entries!.pop();
      },
    ],
    [
      "backend floor",
      (p) => {
        p.layers[11]!.minModules = 54;
      },
    ],
    [
      "old activation prefix",
      (p) => {
        p.activationHistory[0]!.minModules++;
      },
    ],
    [
      "new activation tail",
      (p) => {
        p.activationHistory[102]!.entries.reverse();
      },
    ],
    [
      "missing activation tail",
      (p) => {
        p.activationHistory.pop();
      },
    ],
    [
      "old move prefix",
      (p) => {
        p.moves[0]!.to += "-changed";
      },
    ],
    [
      "move tail order",
      (p) => {
        p.moves.splice(7, 3, ...p.moves.slice(7).reverse());
      },
    ],
    [
      "extra move",
      (p) => {
        p.moves.push(clone(expected.delta.moveAppends[0]));
      },
    ],
    [
      "allowed edge",
      (p) => {
        expect(p.allowedEdges["ir-runtime"]).not.toContain("frontend-ts");
        p.allowedEdges["ir-runtime"]!.push("frontend-ts");
      },
    ],
    [
      "extra top-level field",
      (p) => {
        p.unexpected = true;
      },
    ],
  ];
  for (const api of apis)
    it.each(mutations)(`${api.name} refuses exact current-domain %s drift`, (_name, mutate) => {
      const p = policy(),
        before = JSON.stringify(p);
      mutate(p);
      const text = JSON.stringify(p);
      expect(text).not.toBe(before);
      expect(() => JSON.parse(text)).not.toThrow();
      expect(() => api.run(text)).toThrow(/complete (policy|raw source) profile mismatch/);
      expect(() => api.run(raw())).not.toThrow();
    });
  it("raw refuses whitespace drift", () => {
    expect(() => captureWasmGcHelperPredecessorPolicySource(raw() + "\n")).toThrow(
      "complete raw source profile mismatch",
    );
    expect(() => captureWasmGcHelperPredecessorPolicySource(raw())).not.toThrow();
  });
  it("raw refuses a one-byte valid-JSON retained-field change", () => {
    const text = raw(),
      needle = '"schema": "compiler-boundaries-v1"';
    expect(text).toContain(needle);
    expect(text.split(needle)).toHaveLength(2);
    const changed = text.replace(needle, '"schema": "compiler-boundaries-v2"');
    expect(changed).not.toBe(text);
    const originalBytes = Buffer.from(text),
      changedBytes = Buffer.from(changed);
    expect(changedBytes.length).toBe(originalBytes.length);
    expect([...originalBytes].filter((byte, index) => byte !== changedBytes[index])).toHaveLength(1);
    expect(() => JSON.parse(changed)).not.toThrow();
    expect(() => captureWasmGcHelperPredecessorPolicySource(changed)).toThrow("complete raw source profile mismatch");
  });
  for (const fault of fixedRawFaults) {
    it(`raw refuses fixed span ${fault.index} omission`, () => {
      const text = changeRaw(raw(), [fault.omission]);
      expect(() => captureWasmGcHelperPredecessorPolicySource(text)).toThrow("complete raw source profile mismatch");
    });
    it(`raw refuses fixed span ${fault.index} duplicated literal`, () => {
      const text = changeRaw(raw(), [fault.duplicate]);
      expect(() => captureWasmGcHelperPredecessorPolicySource(text)).toThrow("complete raw source profile mismatch");
    });
    it(`raw refuses fixed span ${fault.index} reordered literal`, () => {
      const text = changeRaw(raw(), fault.literalReorder);
      expect(() => captureWasmGcHelperPredecessorPolicySource(text)).toThrow("complete raw source profile mismatch");
    });
  }
  const hostileSemantic: readonly [string, () => unknown, RegExp][] = [
    ["primitive", () => null, /plain object/],
    ["boxed", () => new String("policy"), /foreign prototype/],
    [
      "cyclic",
      () => {
        const p: Record<string, unknown> = {};
        p.self = p;
        return p;
      },
      /cyclic policy/,
    ],
    [
      "sparse",
      () => {
        const p = policy();
        Reflect.deleteProperty(p.files, "0");
        return p;
      },
      /array holes|array hole/,
    ],
    [
      "symbol",
      () => {
        const p = policy();
        Object.defineProperty(p, Symbol("hidden"), { value: 1, enumerable: true });
        return p;
      },
      /symbol policy key/,
    ],
    [
      "hidden",
      () => {
        const p = policy();
        Object.defineProperty(p, "hidden", { value: 1, enumerable: false });
        return p;
      },
      /hidden policy field/,
    ],
  ];
  it.each(hostileSemantic)(
    "semantic rejects %s before missing receipt with valid ENOENT witness",
    (_name, make, diagnostic) => {
      const good = raw();
      const bad = make();
      withAuthorityFault(receiptPath, "missing", () => {
        expectMissingAuthority(() => captureWasmGcHelperPredecessorPolicy(JSON.parse(good)), receiptPath);
        expect(() => captureWasmGcHelperPredecessorPolicy(bad)).toThrow(diagnostic);
      });
      expect(() => captureWasmGcHelperPredecessorPolicy(policy())).not.toThrow();
    },
  );
  it("semantic refuses accessor without getter invocation before missing receipt", () => {
    const p = policy();
    let reads = 0;
    Object.defineProperty(p, "trap", {
      enumerable: true,
      get() {
        reads++;
        throw new Error("sentinel invocation");
      },
    });
    const good = raw();
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => captureWasmGcHelperPredecessorPolicy(JSON.parse(good)), receiptPath);
      expect(() => captureWasmGcHelperPredecessorPolicy(p)).toThrow(/accessor|hidden policy field/);
      expect(reads).toBe(0);
    });
    expect(reads).toBe(0);
    expect(() => captureWasmGcHelperPredecessorPolicy(policy())).not.toThrow();
  });
  const hostileRaw: readonly [string, unknown][] = [
    ["boxed", new String("policy")],
    ["null", null],
    ["undefined", undefined],
    ["number", 1],
    ["boolean", true],
    ["array", []],
  ];
  it.each(hostileRaw)("raw rejects %s before missing receipt with valid ENOENT witness", (_name, bad) => {
    const good = raw();
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => captureWasmGcHelperPredecessorPolicySource(good), receiptPath);
      expect(() => captureWasmGcHelperPredecessorPolicySource(bad as string)).toThrow(
        "raw input must be a primitive string",
      );
    });
    expect(() => captureWasmGcHelperPredecessorPolicySource(raw())).not.toThrow();
  });
  for (const api of apis)
    for (const kind of ["missing", "mutation"] as const)
      it.each(physicalFaultAuthorities)(`${api.name} reauthenticates ${kind} %s after warm success`, (path) => {
        const input = raw();
        profile(api.run(input), false);
        withAuthorityFault(path, kind, () => {
          if (kind === "missing") expectMissingAuthority(() => api.run(input), path);
          else
            expect(() => api.run(input)).toThrow(
              path === helperPath
                ? /full-file pin changed/
                : path === receiptPath
                  ? /receipt digest mismatch/
                  : path === expected.predecessorReceipt.path
                    ? /predecessor receipt changed/
                    : /current source changed/,
            );
        });
        profile(api.run(raw()), false);
      });
});
