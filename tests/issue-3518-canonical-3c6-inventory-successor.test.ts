// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { captureProgramValidatorPredecessorPolicySource } from "./helpers/ir-runtime-program-policy-evolution.js";
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
  captureNestedStackificationPredecessorPolicySource,
  authenticateCanonical3c6InventoryEvolution,
  beforeCanonical3c6InventoryPolicy,
  captureCanonical489dPredecessorPolicySource,
  beforeCanonical3c6InventoryPolicySource,
  beforeCurrentMainInventoryPolicy,
  beforeCurrentMainInventoryPolicySource,
  type MutableIrRuntimeProgramPolicy as Policy,
} from "./helpers/ir-runtime-program-policy-evolution.js";
// Literal independent expected values precede every inspected mutation.
const expected = {
  schema: 1,
  kind: "fixed-canonical-3c6-inventory-only-successor",
  provenance: {
    checkpoint: "25ddc095e2b789a645e3e807633c6bf17cc1380d",
    previousMain: "a93d489420fac74aaba490a249f51251f90584c2",
    incomingMain: "3c6fcfc6e4c8bd06fd7528d30593eb988387f0e8",
    planSha256: "5304e7c8902058ab6ee6b4cc6ca13b55844fdbaad01ea6d2177be60d7851b666",
    inventoryOnly: true,
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
  helperPrefix: {
    path: "tests/helpers/ir-runtime-program-policy-evolution.ts",
    bytes: 117269,
    sha256: "36c66ebee18b28209e7c3083873d76eec538b48f98753e8a09dac8ce44499180",
    gitBlob: "71b4f3d4686092f7ce7d8cc53ae3f5aa9bfa98d1",
  },
  predecessorReceipt: {
    path: "tests/helpers/ir-runtime-program-policy-main-inventory-20261002.json",
    bytes: 12856,
    sha256: "b14b779229974856210fb3907aab7c7d0d97537c3f9d8a6324b083f3b3ef8c5e",
    gitBlob: "ca01bda74a7eca6a10fe1c65f7c352897f2c6187",
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
  raw: {
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
  },
} as const;
const receiptPath = "tests/helpers/ir-runtime-program-policy-canonical-3c6.json";
const helperPath = "tests/helpers/ir-runtime-program-policy-evolution.ts";
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const raw = (): string => {
  const text = captureCanonical489dPredecessorPolicySource(
    captureNestedStackificationPredecessorPolicySource(
      captureProgramValidatorPredecessorPolicySource(read("scripts/compiler-boundaries.json")),
    ),
  );
  expect(Buffer.byteLength(text)).toBe(577771);
  expect(sha(text)).toBe("2573c40f37d35a8996dab8cfb7ac5c94ef1b57be0f664845878b21e2b516777a");
  return text;
};
const policy = (): Policy => JSON.parse(raw());
function reject(p: Policy): void {
  expect(() => beforeCanonical3c6InventoryPolicy(p)).toThrow(
    "canonical 3c6 inventory evolution: complete policy profile mismatch",
  );
}
function receiptMutant(change: (r: any) => void): void {
  const r = clone(expected);
  change(r);
  const text = JSON.stringify(r, null, 2) + "\n";
  expect(text).not.toBe(read(receiptPath));
  expect(() => authenticateCanonical3c6InventoryEvolution(text)).toThrow("receipt digest mismatch");
}
const physical = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const physicalFaultAuthorities = [receiptPath, helperPath];
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
  const scratch = resolve(import.meta.dirname, "../.tmp/c1-main-epoch/canonical-inventory-authority-faults");
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
describe("fixed inventory-only canonical 3c6 successor", () => {
  it("binds the exact fixed receipt and inventory-only authority domain", () => {
    expect(Buffer.byteLength(read(receiptPath))).toBe(64620);
    expect(sha(read(receiptPath))).toBe("4a9cd6bd5109ab1cd3cbb1050066ef18377bb5e686f9f3111d572123fbc9127c");
    expect(authenticateCanonical3c6InventoryEvolution()).toEqual(expected);
    expect(Object.keys(expected)).not.toContain("sourcePins");
    expect(expected.rowChanges).toHaveLength(26);
    expect(expected.raw.spans).toHaveLength(19);
  });
  it("derives genuine1782 raw/semantic predecessors and replays all26 additions", () => {
    const text = raw(),
      p = policy();
    const previousRaw = beforeCanonical3c6InventoryPolicySource(text);
    const previous = beforeCanonical3c6InventoryPolicy(p);
    expect(JSON.parse(previousRaw)).toEqual(previous);
    expect(Buffer.byteLength(previousRaw)).toBe(569224);
    expect(sha(previousRaw)).toBe("68b09ea540cbd7c40c2d42d66071b5c096a992729afa865d143bba5d8f894c91");
    expect(previous.files).toHaveLength(1782);
    expect(beforeCurrentMainInventoryPolicy(previous).files).toHaveLength(1780);
    expect(JSON.parse(beforeCurrentMainInventoryPolicySource(previousRaw))).toEqual(
      beforeCurrentMainInventoryPolicy(previous),
    );
    const replay = clone(previous);
    expected.rowChanges.forEach((change, inserted) =>
      replay.files.splice(change.beforeIndex + inserted, 0, clone(change.row)),
    );
    expect(replay).toEqual(p);
  });
  it("preserves all retained rows/layers/history/edges and C2a ownership", () => {
    const p = policy(),
      previous = beforeCanonical3c6InventoryPolicy(p);
    expect(p.layers).toEqual(previous.layers);
    expect(p.activationHistory).toEqual(previous.activationHistory);
    expect(p.allowedEdges).toEqual(previous.allowedEdges);
    expect(p.files.filter((row) => !expected.rowChanges.some((change) => change.row.path === row.path))).toEqual(
      previous.files,
    );
    expect(p.files[1807]).toEqual(previous.files[1781]);
    expect(p.files[1807]!.path).toBe("src/ir/runtime/intrinsic-preparation.ts");
  });
  for (const change of expected.rowChanges) {
    it(`refuses missing row ${change.row.path}`, () => {
      const p = policy();
      p.files.splice(change.currentIndex, 1);
      reject(p);
    });
    it(`refuses duplicate row ${change.row.path}`, () => {
      const p = policy();
      p.files.splice(change.currentIndex, 0, clone(change.row));
      reject(p);
    });
    it(`refuses changed six ownership fields ${change.row.path}`, () => {
      for (const key of Object.keys(change.row)) {
        const p = policy();
        p.files[change.currentIndex]![key] += " changed";
        reject(p);
      }
    });
    it(`refuses row schema/order changes ${change.row.path}`, () => {
      const p = policy();
      p.files[change.currentIndex] = Object.fromEntries(Object.entries(p.files[change.currentIndex]!).reverse());
      reject(p);
      const q = policy();
      q.files[change.currentIndex]!.extra = "unapproved";
      reject(q);
    });
    it(`refuses neighbor and reordered membership ${change.row.path}`, () => {
      const p = policy();
      p.files[change.currentIndex - 1]!.path += " changed";
      reject(p);
      const q = policy();
      [q.files[change.currentIndex], q.files[change.currentIndex + 1]] = [
        q.files[change.currentIndex + 1]!,
        q.files[change.currentIndex]!,
      ];
      reject(q);
    });
    it(`refuses receipt coordinates and neighbors ${change.row.path}`, () => {
      const index = expected.rowChanges.indexOf(change);
      for (const key of ["beforeIndex", "currentIndex"]) receiptMutant((r) => r.rowChanges[index][key]++);
      for (const key of ["beforePrevious", "beforeNext", "currentPrevious", "currentNext"])
        receiptMutant((r) => (r.rowChanges[index][key].path += " changed"));
    });
  }
  for (const [index, span] of expected.raw.spans.entries()) {
    it(`refuses missing/duplicate/reordered raw insertion group ${index}`, () => {
      const text = raw();
      for (const mutant of [
        text.slice(0, span.afterOffset) + text.slice(span.afterOffset + span.after.length),
        text.slice(0, span.afterOffset) + span.after + text.slice(span.afterOffset),
        text.slice(0, span.afterOffset) +
          text.slice(span.afterOffset + span.after.length, 577644) +
          span.after +
          text.slice(577644),
      ])
        expect(() => beforeCanonical3c6InventoryPolicySource(mutant)).toThrow(
          "canonical complete raw source profile mismatch",
        );
    });
    it(`refuses receipt span coordinate/text confusion ${index}`, () => {
      for (const key of ["beforeOffset", "afterOffset"]) receiptMutant((r) => r.raw.spans[index][key]++);
      for (const key of ["before", "after", "beforeSha256", "afterSha256"])
        receiptMutant((r) => (r.raw.spans[index][key] += " changed"));
    });
  }
  for (const key of [
    "schema",
    "kind",
    "provenance",
    "before",
    "current",
    "helperPrefix",
    "predecessorReceipt",
    "rowChanges",
    "raw",
  ]) {
    it(`refuses receipt field/domain mutation ${key}`, () => {
      receiptMutant((r) => {
        delete r[key];
      });
    });
  }
  it("refuses unknown receipt fields and reordered addition/groups", () => {
    receiptMutant((r) => {
      r.sourcePins = [];
    });
    receiptMutant((r) => r.rowChanges.reverse());
    receiptMutant((r) => r.raw.spans.reverse());
  });
  it("refuses unrelated retained rows and top-level field changes", () => {
    const p = policy();
    p.files[0]!.path += " changed";
    reject(p);
    const q = policy();
    q.activationHistory.reverse();
    reject(q);
    const r = policy();
    r.extra = "unexpected";
    reject(r);
  });
  it("refuses stale1782 and double-projected domains", () => {
    const p = beforeCanonical3c6InventoryPolicy(policy());
    expect(() => beforeCanonical3c6InventoryPolicy(p)).toThrow("complete policy profile mismatch");
    const text = beforeCanonical3c6InventoryPolicySource(raw());
    expect(() => beforeCanonical3c6InventoryPolicySource(text)).toThrow(
      "canonical complete raw source profile mismatch",
    );
  });
  it("freshly rereads accepted caller mutations without caching or normalization", () => {
    const p = policy();
    const first = beforeCanonical3c6InventoryPolicy(p);
    p.files[expected.rowChanges[0].currentIndex]!.owner = "changed";
    reject(p);
    expect(first.files).toHaveLength(1782);
    expect(beforeCanonical3c6InventoryPolicy(policy())).toEqual(first);
  });
  for (const path of physicalFaultAuthorities)
    for (const kind of ["mutation", "missing"] as const)
      for (const api of ["receipt", "semantic", "raw"] as const) {
        it(`freshly refuses ${kind} physical ${path} through ${api} after success`, () => {
          const p = policy(),
            text = raw();
          authenticateCanonical3c6InventoryEvolution();
          beforeCanonical3c6InventoryPolicy(p);
          beforeCanonical3c6InventoryPolicySource(text);
          const action = () => {
            if (api === "receipt") authenticateCanonical3c6InventoryEvolution();
            else if (api === "semantic") beforeCanonical3c6InventoryPolicy(p);
            else beforeCanonical3c6InventoryPolicySource(text);
          };
          withAuthorityFault(path, kind, () => {
            if (kind === "missing") expectMissingAuthority(action, path);
            else
              expect(action).toThrow(
                path === receiptPath
                  ? "receipt digest mismatch"
                  : "complete canonical predecessor helper prefix changed",
              );
          });
          action();
        });
      }
  for (const value of [null, 7, {}, new String("boxed")]) {
    it(`primitive raw refusal precedes missing authority ${Object.prototype.toString.call(value)}`, () => {
      const text = raw();
      withAuthorityFault(receiptPath, "missing", () => {
        expectMissingAuthority(() => beforeCanonical3c6InventoryPolicySource(text), receiptPath);
        expect(() => beforeCanonical3c6InventoryPolicySource(value as string)).toThrow(
          "raw input must be a primitive string",
        );
      });
    });
  }
  it("accessor refusal precedes authority IO and does not execute getters", () => {
    const p = policy();
    let calls = 0;
    Object.defineProperty(p, "files", {
      enumerable: true,
      get: () => {
        calls++;
        throw new Error("getter ran");
      },
    });
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => authenticateCanonical3c6InventoryEvolution(), receiptPath);
      expect(() => beforeCanonical3c6InventoryPolicy(p)).toThrow("policy evolution:");
      expect(calls).toBe(0);
    });
  });
  it("proxy descriptor refusal precedes missing authority", () => {
    const p = new Proxy(policy(), {
      ownKeys() {
        throw new Error("canonical descriptor trap");
      },
    });
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => authenticateCanonical3c6InventoryEvolution(), receiptPath);
      expect(() => beforeCanonical3c6InventoryPolicy(p)).toThrow("canonical descriptor trap");
    });
  });
  it("cycle refusal precedes missing authority", () => {
    const p = policy();
    p.cycle = p;
    withAuthorityFault(receiptPath, "missing", () => {
      expectMissingAuthority(() => authenticateCanonical3c6InventoryEvolution(), receiptPath);
      expect(() => beforeCanonical3c6InventoryPolicy(p)).toThrow("policy evolution:");
    });
  });
  for (const value of [null, 7, "primitive", [], true]) {
    it(`semantic primitive/array refusal precedes missing authority ${Object.prototype.toString.call(value)}`, () => {
      withAuthorityFault(receiptPath, "missing", () => {
        expectMissingAuthority(() => authenticateCanonical3c6InventoryEvolution(), receiptPath);
        expect(() => beforeCanonical3c6InventoryPolicy(value)).toThrow("policy input must be a plain object");
      });
    });
  }
  it("hidden/symbol/sparse/inherited descriptors refuse before missing authority", () => {
    const hidden = policy();
    Object.defineProperty(hidden, "hidden", { value: 1, enumerable: false });
    const symbol = policy();
    Object.defineProperty(symbol, Symbol("key"), {
      value: 1,
      enumerable: true,
    });
    const sparse = policy();
    Reflect.deleteProperty(sparse.files, "0");
    const inherited = Object.create(policy());
    for (const value of [hidden, symbol, sparse, inherited])
      withAuthorityFault(receiptPath, "missing", () => {
        expectMissingAuthority(() => authenticateCanonical3c6InventoryEvolution(), receiptPath);
        expect(() => beforeCanonical3c6InventoryPolicy(value)).toThrow("policy evolution:");
      });
  });
});
