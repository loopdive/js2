import { createIrNativeNumberUndefinedOptimizationPolicyReader } from "./helpers/ir-native-number-undefined-optimization-policy-successor.js";
import { createIrNativeNumberUndefinedInventoryReader } from "./helpers/ir-native-number-undefined-inventory-successor.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  captureDenoPostPositionMainPredecessorPolicySource as mainRaw,
  captureDenoPostPositionMainPredecessorPolicy as mainData,
  captureDenoPostPositionDenoPredecessorPolicySource as denoRaw,
  captureDenoPostPositionDenoPredecessorPolicy as denoData,
  denoPostPositionMainSuccessorReceiptPath as receiptPath,
} from "./helpers/ir-deno-post-position-main-successor.js";
// Complete fixed source/receipt pins are independently frozen after formatting.
const helperPin = {
  bytes: 289068,
  sha256: "700deb486f038201c233fbefa03abc544959ce59a2f99b7a1f876355604af2e7",
};
const receiptPin = {
  bytes: 285722,
  sha256: "307877cb7bfcf9b8f9469aafb7f78a076154fee03af5856fe6eac36616f239df",
};
const expected = {
  current: {
    source: {
      bytes: 599721,
      sha256: "644219143ca7262a03ae74c559b1dcc9bd20c0bdc6b8f09a059d659523d93d53",
      gitBlob: "c24af976b5c991c28e7ccafaf87f0ec656f3fff0",
    },
    fileCount: 1874,
    dataSha256: "a9cc77299f6be3429c683658652690617f51dbebb2d03beb7d77a59a95ab6ccb",
    filesSha256: "d5b19f87d6ce25f504f08f6300d87df1eb98281b2665bb4d8fefa9529a0e60c6",
    nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
  },
  main46caf: {
    source: {
      bytes: 592414,
      sha256: "3e798a5670fa54a947a11268b8035c2256b91800c3e73c5cff73c95e78dfe20f",
      gitBlob: "51244622dc2b35a60237ce300dd93070a36e1416",
    },
    fileCount: 1850,
    dataSha256: "2f325d9966a6b5dd5e3670b158d47500656938c8d9acd8e15e8b7e32f4989e54",
    filesSha256: "4331909543f475287332cebbf1c7c202be4a37855dfe40ebd39ad9cffe60d1ff",
    nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
  },
  main0be: {
    source: {
      bytes: 591767,
      sha256: "437f7935fc2817ce570790f6658d598990ab0aa75d2fdd17896b0d3c5368e6aa",
      gitBlob: "1ac401078eb2a8c188a55af6f37f42b863857118",
    },
    fileCount: 1848,
    dataSha256: "eeaf9efb72a16c44878555447043375512901b8a9aa18005d07ae7c51c8d65cb",
    filesSha256: "0ca29de4c8e92861c2507fc0afb07f19faea04e8132fab4c863b869b4a699d0e",
    nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
  },
  main58d: {
    source: {
      bytes: 591096,
      sha256: "af43508deba915273295751c8bc0487e5febb8c36bd8ced5a22dde06cde2d898",
      gitBlob: "1e939d20897d184052de927cf5f5804a7418dfa3",
    },
    fileCount: 1846,
    dataSha256: "94fc067472238cc6a70058ba772c49cf52cd7a33ceea6a6fce6ea289a548fa51",
    filesSha256: "f9fdea78085035b3bbc8ca16d25bea04a2bd5883219f00bc0cc09b93334b894d",
    nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
  },
  main6998: {
    source: {
      bytes: 590770,
      sha256: "b606727c951331096a458b46ef344e8042018089b04e0e1fa587d7045fad3d13",
      gitBlob: "126b9da52886d6c153271005953d87816189f19f",
    },
    fileCount: 1845,
    dataSha256: "4e5ff60c7e6357c7fddfc3e96997107b20eea9e3b5f04a8e076c8ed45c64be99",
    filesSha256: "a4e41dd90b18f9df122e6ba96d80bd00da465cc2c3393ff7e822657eb12c6a61",
    nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
  },
  oldPosition: {
    source: {
      bytes: 589117,
      sha256: "58ae19c3c96ecbb3ebe43ec81cfb1d244a0c15e80c7da6000becb58d44834857",
      gitBlob: "e775a64483ace95ca46b0d65221cff9cf84c4500",
    },
    fileCount: 1840,
    dataSha256: "fbda107633bdaef0fbfe9775f02503c850b7ccbd21ae5872ed2b14f5c0698368",
    filesSha256: "b1482d905e51a1b9836b6fa218e3ecf6dc66bb6241347400e0479e9872ce4f92",
    nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
  },
  oldDeno: {
    source: {
      bytes: 594346,
      sha256: "4ee416b75193d78ec696ac0d21e9328cee842602f6926cf3223e6de0dc703f7a",
      gitBlob: "e70ee1b32f53de5d5935aa0ac52987959effc64a",
    },
    fileCount: 1856,
    dataSha256: "5f5afeb67c06edff1727dedda43820f8a66b92f8b3351b9e5a81d264822396c7",
    filesSha256: "fb880095aab466a486a6b34d17c2f9587a89fa11c87d77f68bc25b938bf187e9",
    nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
  },
  projections: {
    main46caf: {
      before: {
        source: {
          bytes: 592414,
          sha256: "3e798a5670fa54a947a11268b8035c2256b91800c3e73c5cff73c95e78dfe20f",
          gitBlob: "51244622dc2b35a60237ce300dd93070a36e1416",
        },
        fileCount: 1850,
        dataSha256: "2f325d9966a6b5dd5e3670b158d47500656938c8d9acd8e15e8b7e32f4989e54",
        filesSha256: "4331909543f475287332cebbf1c7c202be4a37855dfe40ebd39ad9cffe60d1ff",
        nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
      },
      removedRows: [
        {
          index: 47,
          row: {
            path: "src/runtime/wasmgc/promise/reaction-order-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
          previous: {
            path: "src/backend/wasmgc/resources/native-promises.ts",
            state: "clean",
            layer: "backend-wasmgc",
          },
          next: {
            path: "src/runtime/wasmgc/promise/rejection-event-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
        },
        {
          index: 48,
          row: {
            path: "src/runtime/wasmgc/promise/rejection-event-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
          previous: {
            path: "src/runtime/wasmgc/promise/reaction-order-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
          next: {
            path: "src/runtime/wasmgc/promise/resolution-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
        },
        {
          index: 196,
          row: {
            path: "src/codegen/array/array-fill-proto-value.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate context-bound Array.fill argument coercion and prototype-call emission from reusable native body construction.",
          },
          previous: {
            path: "src/codegen/array-element-typing.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/array-filter-length-set.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 268,
          row: {
            path: "src/codegen/expressions/builtin-native-dyn-construct.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate context-bound Array and Promise dynamic construction, late imports and builtin identity reservation from native construction bodies.",
          },
          previous: {
            path: "src/codegen/builtin-instance-key-presence.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/builtin-nonwritable-write.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 327,
          row: {
            path: "src/codegen/object-model/closed-carrier-prototype-status.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "native-runtime",
            owner: "3518-coordinator",
            nextBoundary:
              "Place the allocation-free closed-carrier prototype-status body in its canonical native runtime owner and replace the legacy instruction-type import.",
          },
          previous: {
            path: "src/codegen/class-value-construct.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/closed-method-dispatch.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 329,
          row: {
            path: "src/codegen/object-model/closed-object-prototype-edges.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate codegen-context prototype edge registration and physical function/global allocation from native prototype bodies.",
          },
          previous: {
            path: "src/codegen/closed-method-dispatch.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/closed-struct-extern-set.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 396,
          row: {
            path: "src/codegen/declarations/assigned-shape-divergent-objects.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/declarations/array-rebind-element-widening.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/declarations/declared-nested-write.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 711,
          row: {
            path: "src/codegen/object-model/linked-realm-property-read.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate linked-realm late-import reservation and context-owned function filling from its native read body.",
          },
          previous: {
            path: "src/codegen/linear-uint8-signatures.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/literals.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 713,
          row: {
            path: "src/codegen/array/live-array-iterator-value.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate codegen-context iterator kind and layout selection from the receiver-backed native iterator value body.",
          },
          previous: {
            path: "src/codegen/literals.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/map-runtime.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 751,
          row: {
            path: "src/codegen/object-model/native-proto-reparent.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate the AST pre-scan predicate and codegen-context gate from the finalize-time native prototype arms and physical function allocation.",
          },
          previous: {
            path: "src/codegen/object-model/native-carrier-get-prototype.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/object-model/primitive-carrier-test.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 846,
          row: {
            path: "src/codegen/closures/ordinary-new-target.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate AST lexical-target detection and context/local/global registration from ordinary construction target frame instructions.",
          },
          previous: {
            path: "src/codegen/objvec-array-proto.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/ordinary-to-primitive-probe.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 883,
          row: {
            path: "src/codegen/registry/promise-handler-boundary.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate context-owned Promise handling boundary export and physical function registration from native handling instructions.",
          },
          previous: {
            path: "src/codegen/promise-executor.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/promise-native-iterator-result.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 905,
          row: {
            path: "src/codegen/closures/promoted-capture-value.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate context-bound promoted capture lookup and ref-cell type selection from native capture-value instructions.",
          },
          previous: {
            path: "src/codegen/object-model/proxy-trap-read.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/closures/proxy-trap-closure-return.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 948,
          row: {
            path: "src/codegen/closures/rest-only-apply.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate closure/context dispatch, receiver state and exception registration from full-vector rest-call bodies.",
          },
          previous: {
            path: "src/codegen/resolved-callee-guard.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/ret-unbox-abi.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 964,
          row: {
            path: "src/codegen/declarations/shared-script-var-access.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate context-owned Script binding/global-environment registration and final instruction rewriting from explicit native binding resources.",
          },
          previous: {
            path: "src/codegen/shapeless-object-type.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/shared.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1053,
          row: {
            path: "src/codegen/object-model/struct-optional-widen.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/struct-hierarchy-layout.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/super-write-grown-keys.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1509,
          row: {
            path: "src/runtime/wasmgc/promise/resolving-pair-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
          previous: {
            path: "src/runtime/wasmgc/promise/combinator-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
          next: {
            path: "src/runtime/wasmgc/promise/settlement-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
        },
        {
          index: 1533,
          row: {
            path: "src/wasm/physical/allocation-owner.ts",
            state: "clean",
            layer: "wasm-physical",
          },
          previous: {
            path: "src/wasm/physical/type-layout.ts",
            state: "clean",
            layer: "wasm-physical",
          },
          next: {
            path: "src/wasm/physical/exception-control.ts",
            state: "clean",
            layer: "wasm-physical",
          },
        },
        {
          index: 1663,
          row: {
            path: "src/codegen/object-model/extern-get-object-key.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/object-model/extern-get-string-receiver.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/builtin-subclass-receiver.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1670,
          row: {
            path: "src/codegen/registry/microtask-drain-boundary.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate scheduler-context and physical export registration from the canonical native microtask drain body.",
          },
          previous: {
            path: "src/codegen/hash-bucket-dispatch.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/registry/microtask-notification.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate context-owned late notification import and index shifting from native scheduling instructions.",
          },
        },
        {
          index: 1671,
          row: {
            path: "src/codegen/registry/microtask-notification.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate context-owned late notification import and index shifting from native scheduling instructions.",
          },
          previous: {
            path: "src/codegen/registry/microtask-drain-boundary.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate scheduler-context and physical export registration from the canonical native microtask drain body.",
          },
          next: {
            path: "src/codegen/missing-super-replay.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1802,
          row: {
            path: "src/codegen/registry/promise-rejection-dispatch.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Place context-dependent rejection dispatcher resolution and import/defined-function identity checks behind explicit backend resources.",
          },
          previous: {
            path: "src/codegen/promise-subclass-proto-link.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/promise-species-then.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1872,
          row: {
            path: "src/ir/runtime/number-remainder-callables.ts",
            state: "clean",
            layer: "ir-runtime",
          },
          previous: {
            path: "src/compiler/ir-program-presentation.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "compiler",
            owner: "3525-prepared-presentation",
            nextBoundary:
              "Separate AST declaration capture and finalizer presentation from prepared-program output association before compiler-layer activation.",
          },
          next: {
            path: "src/wasm/physical/number-remainder.ts",
            state: "clean",
            layer: "wasm-physical",
          },
        },
        {
          index: 1873,
          row: {
            path: "src/wasm/physical/number-remainder.ts",
            state: "clean",
            layer: "wasm-physical",
          },
          previous: {
            path: "src/ir/runtime/number-remainder-callables.ts",
            state: "clean",
            layer: "ir-runtime",
          },
          next: undefined,
        },
      ],
      rawSpans: [
        {
          beforeOffset: 78283,
          afterOffset: 78283,
          before: "",
          after:
            '      "path": "src/runtime/wasmgc/promise/reaction-order-bodies.ts",\n      "state": "clean",\n      "layer": "native-runtime"\n    },\n    {\n      "path": "src/runtime/wasmgc/promise/rejection-event-bodies.ts",\n      "state": "clean",\n      "layer": "native-runtime"\n    },\n    {\n',
        },
        {
          beforeOffset: 109441,
          afterOffset: 109718,
          before: "",
          after:
            '      "path": "src/codegen/array/array-fill-proto-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound Array.fill argument coercion and prototype-call emission from reusable native body construction."\n    },\n    {\n',
        },
        {
          beforeOffset: 132026,
          afterOffset: 132660,
          before: "",
          after:
            '      "path": "src/codegen/expressions/builtin-native-dyn-construct.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound Array and Promise dynamic construction, late imports and builtin identity reservation from native construction bodies."\n    },\n    {\n',
        },
        {
          beforeOffset: 150523,
          afterOffset: 151548,
          before: "",
          after:
            '      "path": "src/codegen/object-model/closed-carrier-prototype-status.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "native-runtime",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Place the allocation-free closed-carrier prototype-status body in its canonical native runtime owner and replace the legacy instruction-type import."\n    },\n    {\n',
        },
        {
          beforeOffset: 150830,
          afterOffset: 152257,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/object-model/closed-object-prototype-edges.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate codegen-context prototype edge registration and physical function/global allocation from native prototype bodies."\n',
        },
        {
          beforeOffset: 171745,
          afterOffset: 173546,
          before: "",
          after:
            '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/declarations/assigned-shape-divergent-objects.ts",\n',
        },
        {
          beforeOffset: 273448,
          afterOffset: 275592,
          before: "",
          after:
            '      "path": "src/codegen/object-model/linked-realm-property-read.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate linked-realm late-import reservation and context-owned function filling from its native read body."\n    },\n    {\n',
        },
        {
          beforeOffset: 273741,
          afterOffset: 276241,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/array/live-array-iterator-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate codegen-context iterator kind and layout selection from the receiver-backed native iterator value body."\n',
        },
        {
          beforeOffset: 285703,
          afterOffset: 288556,
          before: "",
          after:
            '      "path": "src/codegen/object-model/native-proto-reparent.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate the AST pre-scan predicate and codegen-context gate from the finalize-time native prototype arms and physical function allocation."\n    },\n    {\n',
        },
        {
          beforeOffset: 316026,
          afterOffset: 319262,
          before: "",
          after:
            '      "path": "src/codegen/closures/ordinary-new-target.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST lexical-target detection and context/local/global registration from ordinary construction target frame instructions."\n    },\n    {\n',
        },
        {
          beforeOffset: 327930,
          afterOffset: 331533,
          before: "",
          after:
            '      "path": "src/codegen/registry/promise-handler-boundary.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned Promise handling boundary export and physical function registration from native handling instructions."\n    },\n    {\n',
        },
        {
          beforeOffset: 335111,
          afterOffset: 339082,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/closures/promoted-capture-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound promoted capture lookup and ref-cell type selection from native capture-value instructions."\n',
        },
        {
          beforeOffset: 348530,
          afterOffset: 352856,
          before: "",
          after:
            '      "path": "src/codegen/closures/rest-only-apply.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate closure/context dispatch, receiver state and exception registration from full-vector rest-call bodies."\n    },\n    {\n',
        },
        {
          beforeOffset: 353295,
          afterOffset: 357966,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/declarations/shared-script-var-access.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned Script binding/global-environment registration and final instruction rewriting from explicit native binding resources."\n',
        },
        {
          beforeOffset: 381345,
          afterOffset: 386404,
          before: "",
          after:
            '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/object-model/struct-optional-widen.ts",\n',
        },
        {
          beforeOffset: 513531,
          afterOffset: 518922,
          before: "",
          after:
            '      "path": "src/runtime/wasmgc/promise/resolving-pair-bodies.ts",\n      "state": "clean",\n      "layer": "native-runtime"\n    },\n    {\n',
        },
        {
          beforeOffset: 518743,
          afterOffset: 524272,
          before: "",
          after:
            '      "state": "clean",\n      "layer": "wasm-physical"\n    },\n    {\n      "path": "src/wasm/physical/allocation-owner.ts",\n',
        },
        {
          beforeOffset: 541961,
          afterOffset: 547613,
          before: "",
          after:
            '      "path": "src/codegen/object-model/extern-get-object-key.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 543876,
          afterOffset: 549860,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/registry/microtask-drain-boundary.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate scheduler-context and physical export registration from the canonical native microtask drain body."\n    },\n    {\n      "path": "src/codegen/registry/microtask-notification.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned late notification import and index shifting from native scheduling instructions."\n',
        },
        {
          beforeOffset: 582207,
          afterOffset: 588885,
          before: "",
          after:
            '      "path": "src/codegen/registry/promise-rejection-dispatch.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Place context-dependent rejection dispatcher resolution and import/defined-function identity checks behind explicit backend resources."\n    },\n    {\n',
        },
        {
          beforeOffset: 592407,
          afterOffset: 599464,
          before: "",
          after:
            ',\n    {\n      "path": "src/ir/runtime/number-remainder-callables.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n    },\n    {\n      "path": "src/wasm/physical/number-remainder.ts",\n      "state": "clean",\n      "layer": "wasm-physical"\n    }',
        },
      ],
      fullSemanticAndRawTargetExact: true,
    },
    oldPosition: {
      before: {
        source: {
          bytes: 589117,
          sha256: "58ae19c3c96ecbb3ebe43ec81cfb1d244a0c15e80c7da6000becb58d44834857",
          gitBlob: "e775a64483ace95ca46b0d65221cff9cf84c4500",
        },
        fileCount: 1840,
        dataSha256: "fbda107633bdaef0fbfe9775f02503c850b7ccbd21ae5872ed2b14f5c0698368",
        filesSha256: "b1482d905e51a1b9836b6fa218e3ecf6dc66bb6241347400e0479e9872ce4f92",
        nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
      },
      removedRows: [
        {
          index: 47,
          row: {
            path: "src/runtime/wasmgc/promise/reaction-order-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
          previous: {
            path: "src/backend/wasmgc/resources/native-promises.ts",
            state: "clean",
            layer: "backend-wasmgc",
          },
          next: {
            path: "src/runtime/wasmgc/promise/rejection-event-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
        },
        {
          index: 48,
          row: {
            path: "src/runtime/wasmgc/promise/rejection-event-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
          previous: {
            path: "src/runtime/wasmgc/promise/reaction-order-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
          next: {
            path: "src/runtime/wasmgc/promise/resolution-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
        },
        {
          index: 196,
          row: {
            path: "src/codegen/array/array-fill-proto-value.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate context-bound Array.fill argument coercion and prototype-call emission from reusable native body construction.",
          },
          previous: {
            path: "src/codegen/array-element-typing.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/array-filter-length-set.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 268,
          row: {
            path: "src/codegen/expressions/builtin-native-dyn-construct.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate context-bound Array and Promise dynamic construction, late imports and builtin identity reservation from native construction bodies.",
          },
          previous: {
            path: "src/codegen/builtin-instance-key-presence.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/builtin-nonwritable-write.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 327,
          row: {
            path: "src/codegen/object-model/closed-carrier-prototype-status.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "native-runtime",
            owner: "3518-coordinator",
            nextBoundary:
              "Place the allocation-free closed-carrier prototype-status body in its canonical native runtime owner and replace the legacy instruction-type import.",
          },
          previous: {
            path: "src/codegen/class-value-construct.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/closed-method-dispatch.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 329,
          row: {
            path: "src/codegen/object-model/closed-object-prototype-edges.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate codegen-context prototype edge registration and physical function/global allocation from native prototype bodies.",
          },
          previous: {
            path: "src/codegen/closed-method-dispatch.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/closed-struct-extern-set.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 381,
          row: {
            path: "src/codegen/classes/missing-super-return.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/classes/ctor-return-override.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/custom-iterable.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 396,
          row: {
            path: "src/codegen/declarations/assigned-shape-divergent-objects.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/declarations/array-rebind-element-widening.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/declarations/declared-nested-write.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 711,
          row: {
            path: "src/codegen/object-model/linked-realm-property-read.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate linked-realm late-import reservation and context-owned function filling from its native read body.",
          },
          previous: {
            path: "src/codegen/linear-uint8-signatures.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/literals.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 713,
          row: {
            path: "src/codegen/array/live-array-iterator-value.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate codegen-context iterator kind and layout selection from the receiver-backed native iterator value body.",
          },
          previous: {
            path: "src/codegen/literals.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/map-runtime.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 751,
          row: {
            path: "src/codegen/object-model/native-proto-reparent.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate the AST pre-scan predicate and codegen-context gate from the finalize-time native prototype arms and physical function allocation.",
          },
          previous: {
            path: "src/codegen/object-model/native-carrier-get-prototype.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/object-model/primitive-carrier-test.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 752,
          row: {
            path: "src/codegen/object-model/primitive-carrier-test.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/object-model/native-proto-reparent.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate the AST pre-scan predicate and codegen-context gate from the finalize-time native prototype arms and physical function allocation.",
          },
          next: {
            path: "src/codegen/native-construct.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 846,
          row: {
            path: "src/codegen/closures/ordinary-new-target.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate AST lexical-target detection and context/local/global registration from ordinary construction target frame instructions.",
          },
          previous: {
            path: "src/codegen/objvec-array-proto.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/ordinary-to-primitive-probe.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 883,
          row: {
            path: "src/codegen/registry/promise-handler-boundary.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate context-owned Promise handling boundary export and physical function registration from native handling instructions.",
          },
          previous: {
            path: "src/codegen/promise-executor.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/promise-native-iterator-result.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 902,
          row: {
            path: "src/codegen/object-model/proxy-forward-carriers.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/object-model/proxy-get-iterator.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/object-model/module-namespace-exotic.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 903,
          row: {
            path: "src/codegen/object-model/module-namespace-exotic.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/object-model/proxy-forward-carriers.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/object-model/proxy-trap-read.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 905,
          row: {
            path: "src/codegen/closures/promoted-capture-value.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate context-bound promoted capture lookup and ref-cell type selection from native capture-value instructions.",
          },
          previous: {
            path: "src/codegen/object-model/proxy-trap-read.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/closures/proxy-trap-closure-return.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 948,
          row: {
            path: "src/codegen/closures/rest-only-apply.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate closure/context dispatch, receiver state and exception registration from full-vector rest-call bodies.",
          },
          previous: {
            path: "src/codegen/resolved-callee-guard.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/ret-unbox-abi.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 964,
          row: {
            path: "src/codegen/declarations/shared-script-var-access.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate context-owned Script binding/global-environment registration and final instruction rewriting from explicit native binding resources.",
          },
          previous: {
            path: "src/codegen/shapeless-object-type.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/shared.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1053,
          row: {
            path: "src/codegen/object-model/struct-optional-widen.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/struct-hierarchy-layout.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/super-write-grown-keys.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1065,
          row: {
            path: "src/codegen/array/ta-iter-detach.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/ta-hof-map-filter.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/tagged-template-arguments.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1157,
          row: {
            path: "src/compiler/for-head-parser-compat.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "compiler",
            owner: "3518-coordinator",
            nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
          },
          previous: {
            path: "src/compiler/early-errors/tdz.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "compiler",
            owner: "3518-coordinator",
            nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
          },
          next: {
            path: "src/compiler/ground-call-fold.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "compiler",
            owner: "3518-coordinator",
            nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
          },
        },
        {
          index: 1509,
          row: {
            path: "src/runtime/wasmgc/promise/resolving-pair-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
          previous: {
            path: "src/runtime/wasmgc/promise/combinator-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
          next: {
            path: "src/runtime/wasmgc/promise/settlement-bodies.ts",
            state: "clean",
            layer: "native-runtime",
          },
        },
        {
          index: 1533,
          row: {
            path: "src/wasm/physical/allocation-owner.ts",
            state: "clean",
            layer: "wasm-physical",
          },
          previous: {
            path: "src/wasm/physical/type-layout.ts",
            state: "clean",
            layer: "wasm-physical",
          },
          next: {
            path: "src/wasm/physical/exception-control.ts",
            state: "clean",
            layer: "wasm-physical",
          },
        },
        {
          index: 1662,
          row: {
            path: "src/codegen/object-model/extern-get-string-receiver.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/string-wrapper-dynamic-length.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/object-model/extern-get-object-key.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1663,
          row: {
            path: "src/codegen/object-model/extern-get-object-key.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/object-model/extern-get-string-receiver.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/builtin-subclass-receiver.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1670,
          row: {
            path: "src/codegen/registry/microtask-drain-boundary.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate scheduler-context and physical export registration from the canonical native microtask drain body.",
          },
          previous: {
            path: "src/codegen/hash-bucket-dispatch.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/registry/microtask-notification.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate context-owned late notification import and index shifting from native scheduling instructions.",
          },
        },
        {
          index: 1671,
          row: {
            path: "src/codegen/registry/microtask-notification.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate context-owned late notification import and index shifting from native scheduling instructions.",
          },
          previous: {
            path: "src/codegen/registry/microtask-drain-boundary.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate scheduler-context and physical export registration from the canonical native microtask drain body.",
          },
          next: {
            path: "src/codegen/missing-super-replay.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1791,
          row: {
            path: "src/codegen/expressions/callable-property-omittable-param.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/expressions/dispatch-extern-arg-bridge.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/closures/host-boolean-callback.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1792,
          row: {
            path: "src/codegen/closures/host-boolean-callback.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/expressions/callable-property-omittable-param.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/expressions/typeof-import-binding.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1793,
          row: {
            path: "src/codegen/expressions/typeof-import-binding.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/closures/host-boolean-callback.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/expressions/dispatch-vec-result-bridge.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1802,
          row: {
            path: "src/codegen/registry/promise-rejection-dispatch.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Place context-dependent rejection dispatcher resolution and import/defined-function identity checks behind explicit backend resources.",
          },
          previous: {
            path: "src/codegen/promise-subclass-proto-link.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/promise-species-then.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1872,
          row: {
            path: "src/ir/runtime/number-remainder-callables.ts",
            state: "clean",
            layer: "ir-runtime",
          },
          previous: {
            path: "src/compiler/ir-program-presentation.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "compiler",
            owner: "3525-prepared-presentation",
            nextBoundary:
              "Separate AST declaration capture and finalizer presentation from prepared-program output association before compiler-layer activation.",
          },
          next: {
            path: "src/wasm/physical/number-remainder.ts",
            state: "clean",
            layer: "wasm-physical",
          },
        },
        {
          index: 1873,
          row: {
            path: "src/wasm/physical/number-remainder.ts",
            state: "clean",
            layer: "wasm-physical",
          },
          previous: {
            path: "src/ir/runtime/number-remainder-callables.ts",
            state: "clean",
            layer: "ir-runtime",
          },
          next: undefined,
        },
      ],
      rawSpans: [
        {
          beforeOffset: 78283,
          afterOffset: 78283,
          before: "",
          after:
            '      "path": "src/runtime/wasmgc/promise/reaction-order-bodies.ts",\n      "state": "clean",\n      "layer": "native-runtime"\n    },\n    {\n      "path": "src/runtime/wasmgc/promise/rejection-event-bodies.ts",\n      "state": "clean",\n      "layer": "native-runtime"\n    },\n    {\n',
        },
        {
          beforeOffset: 109441,
          afterOffset: 109718,
          before: "",
          after:
            '      "path": "src/codegen/array/array-fill-proto-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound Array.fill argument coercion and prototype-call emission from reusable native body construction."\n    },\n    {\n',
        },
        {
          beforeOffset: 132026,
          afterOffset: 132660,
          before: "",
          after:
            '      "path": "src/codegen/expressions/builtin-native-dyn-construct.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound Array and Promise dynamic construction, late imports and builtin identity reservation from native construction bodies."\n    },\n    {\n',
        },
        {
          beforeOffset: 150523,
          afterOffset: 151548,
          before: "",
          after:
            '      "path": "src/codegen/object-model/closed-carrier-prototype-status.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "native-runtime",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Place the allocation-free closed-carrier prototype-status body in its canonical native runtime owner and replace the legacy instruction-type import."\n    },\n    {\n',
        },
        {
          beforeOffset: 150830,
          afterOffset: 152257,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/object-model/closed-object-prototype-edges.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate codegen-context prototype edge registration and physical function/global allocation from native prototype bodies."\n',
        },
        {
          beforeOffset: 166964,
          afterOffset: 168765,
          before: "",
          after:
            '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/classes/missing-super-return.ts",\n',
        },
        {
          beforeOffset: 171419,
          afterOffset: 173546,
          before: "",
          after:
            '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/declarations/assigned-shape-divergent-objects.ts",\n',
        },
        {
          beforeOffset: 273122,
          afterOffset: 275592,
          before: "",
          after:
            '      "path": "src/codegen/object-model/linked-realm-property-read.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate linked-realm late-import reservation and context-owned function filling from its native read body."\n    },\n    {\n',
        },
        {
          beforeOffset: 273415,
          afterOffset: 276241,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/array/live-array-iterator-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate codegen-context iterator kind and layout selection from the receiver-backed native iterator value body."\n',
        },
        {
          beforeOffset: 285112,
          afterOffset: 288291,
          before: "",
          after:
            '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 285112,
          afterOffset: 288556,
          before: "",
          after:
            '      "path": "src/codegen/object-model/native-proto-reparent.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate the AST pre-scan predicate and codegen-context gate from the finalize-time native prototype arms and physical function allocation."\n    },\n    {\n',
        },
        {
          beforeOffset: 285112,
          afterOffset: 288939,
          before: "",
          after: '      "path": "src/codegen/object-model/primitive-carrier-test.ts",\n',
        },
        {
          beforeOffset: 315367,
          afterOffset: 319262,
          before: "",
          after:
            '      "path": "src/codegen/closures/ordinary-new-target.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST lexical-target detection and context/local/global registration from ordinary construction target frame instructions."\n    },\n    {\n',
        },
        {
          beforeOffset: 327271,
          afterOffset: 331533,
          before: "",
          after:
            '      "path": "src/codegen/registry/promise-handler-boundary.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned Promise handling boundary export and physical function registration from native handling instructions."\n    },\n    {\n',
        },
        {
          beforeOffset: 333472,
          afterOffset: 338102,
          before: "",
          after:
            '      "path": "src/codegen/object-model/proxy-forward-carriers.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/object-model/module-namespace-exotic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 333785,
          afterOffset: 339082,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/closures/promoted-capture-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound promoted capture lookup and ref-cell type selection from native capture-value instructions."\n',
        },
        {
          beforeOffset: 347204,
          afterOffset: 352856,
          before: "",
          after:
            '      "path": "src/codegen/closures/rest-only-apply.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate closure/context dispatch, receiver state and exception registration from full-vector rest-call bodies."\n    },\n    {\n',
        },
        {
          beforeOffset: 351969,
          afterOffset: 357966,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/declarations/shared-script-var-access.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned Script binding/global-environment registration and final instruction rewriting from explicit native binding resources."\n',
        },
        {
          beforeOffset: 380019,
          afterOffset: 386404,
          before: "",
          after:
            '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/object-model/struct-optional-widen.ts",\n',
        },
        {
          beforeOffset: 383759,
          afterOffset: 390476,
          before: "",
          after:
            '      "path": "src/codegen/array/ta-iter-detach.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 412225,
          afterOffset: 419260,
          before: "",
          after:
            '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Review the frontend, orchestration, runtime and shared-contract split before migration."\n    },\n    {\n      "path": "src/compiler/for-head-parser-compat.ts",\n',
        },
        {
          beforeOffset: 511573,
          afterOffset: 518922,
          before: "",
          after:
            '      "path": "src/runtime/wasmgc/promise/resolving-pair-bodies.ts",\n      "state": "clean",\n      "layer": "native-runtime"\n    },\n    {\n',
        },
        {
          beforeOffset: 516785,
          afterOffset: 524272,
          before: "",
          after:
            '      "state": "clean",\n      "layer": "wasm-physical"\n    },\n    {\n      "path": "src/wasm/physical/allocation-owner.ts",\n',
        },
        {
          beforeOffset: 539666,
          afterOffset: 547276,
          before: "",
          after:
            '      "path": "src/codegen/object-model/extern-get-string-receiver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 539666,
          afterOffset: 547613,
          before: "",
          after:
            '      "path": "src/codegen/object-model/extern-get-object-key.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 541581,
          afterOffset: 549860,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/registry/microtask-drain-boundary.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate scheduler-context and physical export registration from the canonical native microtask drain body."\n    },\n    {\n      "path": "src/codegen/registry/microtask-notification.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned late notification import and index shifting from native scheduling instructions."\n',
        },
        {
          beforeOffset: 576359,
          afterOffset: 585332,
          before: "",
          after:
            '      "path": "src/codegen/expressions/callable-property-omittable-param.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/closures/host-boolean-callback.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/typeof-import-binding.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 578897,
          afterOffset: 588872,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/registry/promise-rejection-dispatch.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Place context-dependent rejection dispatcher resolution and import/defined-function identity checks behind explicit backend resources."\n',
        },
        {
          beforeOffset: 589110,
          afterOffset: 599464,
          before: "",
          after:
            ',\n    {\n      "path": "src/ir/runtime/number-remainder-callables.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n    },\n    {\n      "path": "src/wasm/physical/number-remainder.ts",\n      "state": "clean",\n      "layer": "wasm-physical"\n    }',
        },
      ],
      fullSemanticAndRawTargetExact: true,
    },
    oldDeno: {
      before: {
        source: {
          bytes: 594346,
          sha256: "4ee416b75193d78ec696ac0d21e9328cee842602f6926cf3223e6de0dc703f7a",
          gitBlob: "e70ee1b32f53de5d5935aa0ac52987959effc64a",
        },
        fileCount: 1856,
        dataSha256: "5f5afeb67c06edff1727dedda43820f8a66b92f8b3351b9e5a81d264822396c7",
        filesSha256: "fb880095aab466a486a6b34d17c2f9587a89fa11c87d77f68bc25b938bf187e9",
        nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
      },
      removedRows: [
        {
          index: 87,
          row: {
            path: "src/ir/program/source-map-position.ts",
            state: "clean",
            layer: "ir-program",
          },
          previous: {
            path: "src/ir/program/errors.ts",
            state: "clean",
            layer: "ir-program",
          },
          next: {
            path: "src/ir/program/data.ts",
            state: "clean",
            layer: "ir-program",
          },
        },
        {
          index: 381,
          row: {
            path: "src/codegen/classes/missing-super-return.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/classes/ctor-return-override.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/custom-iterable.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 396,
          row: {
            path: "src/codegen/declarations/assigned-shape-divergent-objects.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/declarations/array-rebind-element-widening.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/declarations/declared-nested-write.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 751,
          row: {
            path: "src/codegen/object-model/native-proto-reparent.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate the AST pre-scan predicate and codegen-context gate from the finalize-time native prototype arms and physical function allocation.",
          },
          previous: {
            path: "src/codegen/object-model/native-carrier-get-prototype.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/object-model/primitive-carrier-test.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 752,
          row: {
            path: "src/codegen/object-model/primitive-carrier-test.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/object-model/native-proto-reparent.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary:
              "Separate the AST pre-scan predicate and codegen-context gate from the finalize-time native prototype arms and physical function allocation.",
          },
          next: {
            path: "src/codegen/native-construct.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 902,
          row: {
            path: "src/codegen/object-model/proxy-forward-carriers.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/object-model/proxy-get-iterator.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/object-model/module-namespace-exotic.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 903,
          row: {
            path: "src/codegen/object-model/module-namespace-exotic.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/object-model/proxy-forward-carriers.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/object-model/proxy-trap-read.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1001,
          row: {
            path: "src/codegen/statements/finally-private-local.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "5267",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/statements/exceptions.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/statements/finally-ran-guard.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1053,
          row: {
            path: "src/codegen/object-model/struct-optional-widen.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/struct-hierarchy-layout.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/super-write-grown-keys.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1065,
          row: {
            path: "src/codegen/array/ta-iter-detach.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/ta-hof-map-filter.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/tagged-template-arguments.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1157,
          row: {
            path: "src/compiler/for-head-parser-compat.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "compiler",
            owner: "3518-coordinator",
            nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
          },
          previous: {
            path: "src/compiler/early-errors/tdz.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "compiler",
            owner: "3518-coordinator",
            nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
          },
          next: {
            path: "src/compiler/ground-call-fold.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "compiler",
            owner: "3518-coordinator",
            nextBoundary: "Review the frontend, orchestration, runtime and shared-contract split before migration.",
          },
        },
        {
          index: 1662,
          row: {
            path: "src/codegen/object-model/extern-get-string-receiver.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/string-wrapper-dynamic-length.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/object-model/extern-get-object-key.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1663,
          row: {
            path: "src/codegen/object-model/extern-get-object-key.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/object-model/extern-get-string-receiver.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/builtin-subclass-receiver.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1791,
          row: {
            path: "src/codegen/expressions/callable-property-omittable-param.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/expressions/dispatch-extern-arg-bridge.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/closures/host-boolean-callback.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1792,
          row: {
            path: "src/codegen/closures/host-boolean-callback.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/expressions/callable-property-omittable-param.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/expressions/typeof-import-binding.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1793,
          row: {
            path: "src/codegen/expressions/typeof-import-binding.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          previous: {
            path: "src/codegen/closures/host-boolean-callback.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
          next: {
            path: "src/codegen/expressions/dispatch-vec-result-bridge.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1872,
          row: {
            path: "src/ir/runtime/number-remainder-callables.ts",
            state: "clean",
            layer: "ir-runtime",
          },
          previous: {
            path: "src/compiler/ir-program-presentation.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "compiler",
            owner: "3525-prepared-presentation",
            nextBoundary:
              "Separate AST declaration capture and finalizer presentation from prepared-program output association before compiler-layer activation.",
          },
          next: {
            path: "src/wasm/physical/number-remainder.ts",
            state: "clean",
            layer: "wasm-physical",
          },
        },
        {
          index: 1873,
          row: {
            path: "src/wasm/physical/number-remainder.ts",
            state: "clean",
            layer: "wasm-physical",
          },
          previous: {
            path: "src/ir/runtime/number-remainder-callables.ts",
            state: "clean",
            layer: "ir-runtime",
          },
          next: undefined,
        },
      ],
      rawSpans: [
        {
          beforeOffset: 83028,
          afterOffset: 83028,
          before: "",
          after:
            '      "path": "src/ir/program/source-map-position.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n',
        },
        {
          beforeOffset: 168645,
          afterOffset: 168765,
          before: "",
          after:
            '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/classes/missing-super-return.ts",\n',
        },
        {
          beforeOffset: 173100,
          afterOffset: 173546,
          before: "",
          after:
            '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/declarations/assigned-shape-divergent-objects.ts",\n',
        },
        {
          beforeOffset: 287767,
          afterOffset: 288556,
          before: "",
          after:
            '      "path": "src/codegen/object-model/native-proto-reparent.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate the AST pre-scan predicate and codegen-context gate from the finalize-time native prototype arms and physical function allocation."\n    },\n    {\n',
        },
        {
          beforeOffset: 287767,
          afterOffset: 288939,
          before: "",
          after:
            '      "path": "src/codegen/object-model/primitive-carrier-test.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 336597,
          afterOffset: 338102,
          before: "",
          after:
            '      "path": "src/codegen/object-model/proxy-forward-carriers.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/object-model/module-namespace-exotic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 367846,
          afterOffset: 370018,
          before: "",
          after:
            '      "path": "src/codegen/statements/finally-private-local.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "5267",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 383914,
          afterOffset: 386404,
          before: "",
          after:
            '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/object-model/struct-optional-widen.ts",\n',
        },
        {
          beforeOffset: 387389,
          afterOffset: 390211,
          before: "",
          after:
            '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/array/ta-iter-detach.ts",\n',
        },
        {
          beforeOffset: 416120,
          afterOffset: 419260,
          before: "",
          after:
            '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Review the frontend, orchestration, runtime and shared-contract split before migration."\n    },\n    {\n      "path": "src/compiler/for-head-parser-compat.ts",\n',
        },
        {
          beforeOffset: 543822,
          afterOffset: 547276,
          before: "",
          after:
            '      "path": "src/codegen/object-model/extern-get-string-receiver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 543822,
          afterOffset: 547613,
          before: "",
          after:
            '      "path": "src/codegen/object-model/extern-get-object-key.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 581209,
          afterOffset: 585332,
          before: "",
          after:
            '      "path": "src/codegen/expressions/callable-property-omittable-param.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/closures/host-boolean-callback.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/typeof-import-binding.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 594339,
          afterOffset: 599464,
          before: "",
          after:
            ',\n    {\n      "path": "src/ir/runtime/number-remainder-callables.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n    },\n    {\n      "path": "src/wasm/physical/number-remainder.ts",\n      "state": "clean",\n      "layer": "wasm-physical"\n    }',
        },
      ],
      fullSemanticAndRawTargetExact: true,
    },
  },
} as const;

const former1873Profile = {
  source: {
    bytes: 599338,
    sha256: "7432d603d0af52d765647dd80c2e3db5f671ca7c40a07f48206a90876cd90f1b",
    gitBlob: "5bff2ad57ecfd67e1eb087f4126c9bf3d111b04f",
  },
  fileCount: 1873,
  dataSha256: "4770a667062d663af75232e4f700354b011b1d1976a9ef4fe0c1a2b81fa46f1e",
  filesSha256: "ce4d3c87fef433f5919e432d96f621c00cd7af94f6aff65f31b216414db632c5",
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
} as const;
const e24Main1872Profile = {
  source: {
    bytes: 599471,
    sha256: "199c6db85b6848fbd8f729dd45fc780086d079b73e777af3aa45d1279c376d80",
    gitBlob: "6db24a0e7690ee0565ad3f02cb223a3af6752671",
  },
  fileCount: 1872,
  dataSha256: "914427f0d69342e3fb379664820a50d7b2dfd593d73e1232665f7be502fcc4ad",
  filesSha256: "f30c76d3c781014000205295ccfbdbe162086dbd707cf2a181f0f961eb4a95a6",
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
} as const;
const e24Insertions = [
  {
    beforeOffset: 288556,
    afterOffset: 288556,
    before: "",
    after:
      '      "path": "src/codegen/object-model/native-proto-reparent.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate the AST pre-scan predicate and codegen-context gate from the finalize-time native prototype arms and physical function allocation."\n    },\n    {\n',
  },
] as const;
const e24RemainderInsertions = [
  {
    beforeOffset: 599464,
    afterOffset: 599464,
    before: "",
    after:
      ',\n    {\n      "path": "src/ir/runtime/number-remainder-callables.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n    },\n    {\n      "path": "src/wasm/physical/number-remainder.ts",\n      "state": "clean",\n      "layer": "wasm-physical"\n    }',
  },
] as const;
const e24FactoredOldSpan = {
  beforeOffset: 285112,
  afterOffset: 288291,
  before: "",
  after:
    '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/object-model/primitive-carrier-test.ts",\n',
} as const;
const former1872Profile = {
  source: {
    bytes: 599006,
    sha256: "89271aaacc5bb80516e5ace874945529561a755c045cb4224afc9403814f00d1",
    gitBlob: "67d856f545a15c6a55b18cc9ced67fc15bb38946",
  },
  fileCount: 1872,
  dataSha256: "2c167ab1cdff4e017c6197e456adde6ee5449830b1d85e95e2631d768e2e492a",
  filesSha256: "48e3f104d708ee7a90ead8e88ac8bcbb59fdcb9b38fa0dd7d6c4ec197488ad6f",
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
} as const;
const fccMain1871Profile = {
  source: {
    bytes: 599088,
    sha256: "0ae46e7f8b29199a8779ddd32be7a33d44de8b5cadba4e4755ce4b3d4d5c2741",
    gitBlob: "da3285282a5f971acaf1c6a7902e67cde909868c",
  },
  fileCount: 1871,
  dataSha256: "9c58916ec3c6e418afdb90108396badd256ca21d4f0dd1883cd07bc1de939617",
  filesSha256: "76fae65a2cfea8c7b6aa4b9dd8579d2360c8ed6ad1b340884bbd940a003a83ee",
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
} as const;
const fccInsertions = [
  {
    beforeOffset: 547230,
    afterOffset: 547230,
    before: "",
    after:
      '      "path": "src/codegen/object-model/extern-get-object-key.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
  },
] as const;
const fccRemainderInsertions = [
  {
    beforeOffset: 599081,
    afterOffset: 599081,
    before: "",
    after:
      ',\n    {\n      "path": "src/ir/runtime/number-remainder-callables.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n    },\n    {\n      "path": "src/wasm/physical/number-remainder.ts",\n      "state": "clean",\n      "layer": "wasm-physical"\n    }',
  },
] as const;
const checkpoint1870Profile = {
  source: {
    bytes: 598331,
    sha256: "a524ce190ef6fc619b92539c328e52b7abe5692d362238d11f4e4082953a6d33",
    gitBlob: "c71e86bc69a505c376c7ae44dfafedbb6bdf41ba",
  },
  fileCount: 1870,
  dataSha256: "5a645d16548efe08cf48aaca516395f9b1daa6ca422a36f5324fcf2caf642c1a",
  filesSha256: "fca6999b15194212637c395e81534200d235f763d2393ae9afa873559eca57fd",
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
} as const;
const prior1871Profile = {
  source: {
    bytes: 598663,
    sha256: "9da336fb5d7b967cac681510c8569edd4bea93e6144badaea6fbf2354c46c0dc",
    gitBlob: "023e0d9032a4d242c62f88a07fea02c26df5ded9",
  },
  fileCount: 1871,
  dataSha256: "4ccc6b779e834e4890dc9caa48e543a2f0b380ab72efa23f800ad26940968846",
  filesSha256: "c4bb2d7a49436d5b15f608d31a86f575dd4038ac0372ddde9d0bfe4014f20842",
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
} as const;
const upstream1870Profile = {
  source: {
    bytes: 598756,
    sha256: "81769768ad70e56b541e3845051ef47f6b65aed794cb712072c6cd7394aa8975",
    gitBlob: "e7d126f0b20994338bcf4a16190c382e286451b7",
  },
  fileCount: 1870,
  dataSha256: "3c57dd13ef55c6039af568ee9694daf66b28f6a1bdc0d5b2d07e3513db1d7f78",
  filesSha256: "e69682e69329a3fd90036c0affa2de339b997a2080170e6f94b44181a17c342f",
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
} as const;
const incomingInsertions = [
  {
    beforeOffset: 173546,
    afterOffset: 173546,
    before: "",
    after:
      '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/declarations/assigned-shape-divergent-objects.ts",\n',
  },
  {
    beforeOffset: 385678,
    afterOffset: 386021,
    before: "",
    after:
      '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/object-model/struct-optional-widen.ts",\n',
  },
] as const;
const currentRemainderInsertions = [
  {
    beforeOffset: 598749,
    afterOffset: 598749,
    before: "",
    after:
      ',\n    {\n      "path": "src/ir/runtime/number-remainder-callables.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n    },\n    {\n      "path": "src/wasm/physical/number-remainder.ts",\n      "state": "clean",\n      "layer": "wasm-physical"\n    }',
  },
] as const;
const former1868Profile = {
  source: {
    bytes: 598081,
    sha256: "72ae9374fd01afa852e48d3ded9f1b6dc805b055e7f18035e86d964aced31e93",
    gitBlob: "d9203627fc082fb37e845a5fb43a077716400cc9",
  },
  fileCount: 1868,
  dataSha256: "094008c6228edbc91791ba3bb5d632ab4d70b92dc8bb576f9ce861b750c7551c",
  filesSha256: "d2a0c67c95068f8c77ec70e37cb9e0864039c4e5f856fcf24d07f2c4cadf3079",
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
} as const;
const remainderInsertions = [
  {
    beforeOffset: 598074,
    afterOffset: 598074,
    before: "",
    after:
      ',\n    {\n      "path": "src/ir/runtime/number-remainder-callables.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n    },\n    {\n      "path": "src/wasm/physical/number-remainder.ts",\n      "state": "clean",\n      "layer": "wasm-physical"\n    }',
  },
] as const;
const current1866Profile = {
  source: {
    bytes: 597434,
    sha256: "458d779de0e7078b08626a240c936bfd710f6b5f18453b19f9b4ddd4ede8246a",
    gitBlob: "a8a8b1b4379d3f76f027bb2da266035c06f3da6b",
  },
  fileCount: 1866,
  dataSha256: "c1b08aa3ff4d3d2bd76767632b7c9350df3d70fc7ed2aee4a1097709c3493b12",
  filesSha256: "494e0568de07f06daab8b88a53bb3e09d3a6d3e07671edf224b4aefe95aaf7ff",
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
} as const;
const current46Insertions = [
  {
    beforeOffset: 288213,
    afterOffset: 288213,
    before: "",
    after:
      '      "path": "src/codegen/object-model/primitive-carrier-test.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
  },
  {
    beforeOffset: 417869,
    afterOffset: 418202,
    before: "",
    after:
      '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Review the frontend, orchestration, runtime and shared-contract split before migration."\n    },\n    {\n      "path": "src/compiler/for-head-parser-compat.ts",\n',
  },
] as const;
const main46Insertions = [
  {
    beforeOffset: 285703,
    afterOffset: 285703,
    before: "",
    after:
      '      "path": "src/codegen/object-model/primitive-carrier-test.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
  },
  {
    beforeOffset: 413536,
    afterOffset: 413869,
    before: "",
    after:
      '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Review the frontend, orchestration, runtime and shared-contract split before migration."\n    },\n    {\n      "path": "src/compiler/for-head-parser-compat.ts",\n',
  },
] as const;

const current1864Profile = {
  source: {
    bytes: 596763,
    sha256: "b14d7e1d560ab263f0cfbdd1ae4d90e8f84a8aeba082296e58a497152ae5b848",
    gitBlob: "2c57eed9dcc9da1fd752899b11709082002355a7",
  },
  fileCount: 1864,
  dataSha256: "2e6ecbd9f31bc736b13996c281cb1896bbb946c193a3bc427f8218ced615f314",
  filesSha256: "8ca6ab83fad1a29c5f0e82a75383a7629c27a9ee3b35c5ffef485c845e798448",
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
} as const;
const current0beInsertions = [
  {
    beforeOffset: 337376,
    afterOffset: 337376,
    before: "",
    after:
      '      "path": "src/codegen/object-model/module-namespace-exotic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
  },
  {
    beforeOffset: 545237,
    afterOffset: 545571,
    before: "",
    after:
      '      "path": "src/codegen/object-model/extern-get-string-receiver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
  },
] as const;
const main0beInsertions = [
  {
    beforeOffset: 334131,
    afterOffset: 334131,
    before: "",
    after:
      '      "path": "src/codegen/object-model/module-namespace-exotic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
  },
  {
    beforeOffset: 540643,
    afterOffset: 540977,
    before: "",
    after:
      '      "path": "src/codegen/object-model/extern-get-string-receiver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
  },
] as const;
const originalIndices = {
  "src/runtime/wasmgc/promise/reaction-order-bodies.ts": 47,
  "src/runtime/wasmgc/promise/rejection-event-bodies.ts": 48,
  "src/codegen/array/array-fill-proto-value.ts": 196,
  "src/codegen/expressions/builtin-native-dyn-construct.ts": 268,
  "src/codegen/object-model/closed-carrier-prototype-status.ts": 327,
  "src/codegen/object-model/closed-object-prototype-edges.ts": 329,
  "src/codegen/classes/missing-super-return.ts": 381,
  "src/codegen/object-model/linked-realm-property-read.ts": 710,
  "src/codegen/array/live-array-iterator-value.ts": 712,
  "src/codegen/closures/ordinary-new-target.ts": 843,
  "src/codegen/registry/promise-handler-boundary.ts": 880,
  "src/codegen/object-model/proxy-forward-carriers.ts": 899,
  "src/codegen/closures/promoted-capture-value.ts": 901,
  "src/codegen/closures/rest-only-apply.ts": 944,
  "src/codegen/declarations/shared-script-var-access.ts": 960,
  "src/codegen/array/ta-iter-detach.ts": 1060,
  "src/runtime/wasmgc/promise/resolving-pair-bodies.ts": 1503,
  "src/wasm/physical/allocation-owner.ts": 1527,
  "src/codegen/registry/microtask-drain-boundary.ts": 1662,
  "src/codegen/registry/microtask-notification.ts": 1663,
  "src/codegen/expressions/callable-property-omittable-param.ts": 1783,
  "src/codegen/closures/host-boolean-callback.ts": 1784,
  "src/codegen/expressions/typeof-import-binding.ts": 1785,
  "src/codegen/registry/promise-rejection-dispatch.ts": 1794,
  "src/ir/program/source-map-position.ts": 87,
  "src/codegen/statements/finally-private-local.ts": 997,
  "src/codegen/object-model/module-namespace-exotic.ts": 900,
  "src/codegen/object-model/extern-get-string-receiver.ts": 1657,
  "src/ir/runtime/number-remainder-callables.ts": 1868,
  "src/wasm/physical/number-remainder.ts": 1869,
  "src/codegen/object-model/primitive-carrier-test.ts": 750,
  "src/compiler/for-head-parser-compat.ts": 1154,
  "src/codegen/declarations/assigned-shape-divergent-objects.ts": 396,
  "src/codegen/object-model/struct-optional-widen.ts": 1052,
  "src/codegen/object-model/extern-get-object-key.ts": "f087-1662",
  "src/codegen/object-model/native-proto-reparent.ts": "e24-751",
} as const;

const formerCurrentProfile = {
  source: {
    bytes: 596437,
    sha256: "a93b6e37ab492e3b3cb591e1f10a394291580bd1aea17b2b01062244e977a966",
    gitBlob: "20c80a1be26998bb19127f3c1104db8f05e57c35",
  },
  fileCount: 1863,
  dataSha256: "7c86de710df485d944c4b908cf6932ffcf04cdce994961ff05ecb753033f683b",
  filesSha256: "40ddff4b9aba0299374989a10af7714f2477c6c2c3e36cc7eb47d08c71a24429",
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
} as const;
const formerCurrentInsertion = {
  offset: 169058,
  literal:
    'lasses/missing-super-return.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/c',
} as const;
const formerMainInsertion = {
  offset: 167257,
  literal:
    'lasses/missing-super-return.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/c',
} as const;

const previousCurrentProfile = {
  source: {
    bytes: 596119,
    sha256: "99b1c972702656d37aa70a993953b367efba19f3907eb76aed83864c1b77442e",
    gitBlob: "9e8d4f0cac4690e7ccb1daf2e5cf85dd5339b0f4",
  },
  fileCount: 1862,
  dataSha256: "098ac5f16c3568e524c69fd8df087808f08b743f63db26fe9603824f09a4988c",
  filesSha256: "eb22b758ec730e77ffe380a09ad7bd6e2558324cc563079aa665a8077745ac11",
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
} as const;
const main431Profile = {
  source: {
    bytes: 590452,
    sha256: "31dbefa4d9ed8b3d429932c96d936315b08d0d1457080e9cabbb7aa7f5ffe584",
    gitBlob: "13d33314077927422c0cd8ee3d6e985941f50371",
  },
  fileCount: 1844,
  dataSha256: "d91a4ea2b43b1a9231781598896f4aa75c311c87beffb032eb9ebe6d6bcf4835",
  filesSha256: "ccb7ab96d5c7a6c948ae57831eafc9bc0431def62e820435e3451b1b5cf9ba86",
  nonFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
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
} as const;
const previousCurrentInsertion = {
  offset: 388452,
  literal:
    'array/ta-iter-detach.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/',
} as const;
const main431Insertion = {
  offset: 384119,
  literal:
    'array/ta-iter-detach.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/',
} as const;

const currentDomainExpected = {
  schema: "fixed-native-current-domain-20261014-v1",
  current: {
    source: {
      bytes: 631801,
      sha256: "8f88968d6821cf2ced8ebac1cde913de0dd81e34122a45e5d07295ab5e197a53",
      gitBlob: "f0426fdd6abfa00fd3351f96e1a8d0ced77a9055",
    },
    fileCount: 1997,
    dataSha256: "c78333d68e266116bad972f1a2034328ad8149bcd731dc573f8edb215d3606a0",
    filesSha256: "369a775c5ae714ce35db7656bc656d5e087c660292212508588317ecc7f422a2",
    nonFilesSha256: "55a72bc549a5ebc2351631c574fe518c1457a48fd36f57550f13a3dc74917faf",
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
  },
  before: {
    bytes: 599721,
    sha256: "644219143ca7262a03ae74c559b1dcc9bd20c0bdc6b8f09a059d659523d93d53",
    gitBlob: "c24af976b5c991c28e7ccafaf87f0ec656f3fff0",
  },
  removedRows: [
    {
      index: 4,
      row: {
        path: "src/ir/backend/vector-element-access.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Common vector get/store lowering preserves target emission and exact fixed-construction bounds; mixed emitter/handle contracts remain, so this helper does not establish pure-IR or compiler graph closure.",
      },
      previous: {
        path: "src/codegen/object-model/ports.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/runtime/wasmgc/values/string-create-body.ts",
        state: "clean",
        layer: "native-runtime",
      },
    },
    {
      index: 123,
      row: {
        path: "src/checker/js-collection-inference.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "3518-coordinator",
        nextBoundary:
          "New #6651 V12 leaf of src/checker/index.ts (synthetic ambient root for `.js` checker programs); it depends only on the TS wrapper and moves with its parent when the checker's TS-wrapper dependencies are separated at frontend closure.",
      },
      previous: {
        path: "src/checker/inhouse-oracle.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate existing TS-wrapper, module-resolution and mixed identity/type/planning dependencies before frontend closure. This file was already unmigrated before the contracts-only frontend activation; no source behavior changed.",
      },
      next: {
        path: "src/checker/language-service.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate existing TS-wrapper, module-resolution and mixed identity/type/planning dependencies before frontend closure. This file was already unmigrated before the contracts-only frontend activation; no source behavior changed.",
      },
    },
    {
      index: 156,
      row: {
        path: "src/codegen-linear/runtime/string-slice.ts",
        state: "unmigrated",
        layer: "legacy-linear",
      },
      previous: {
        path: "src/codegen-linear/runtime.ts",
        state: "unmigrated",
        layer: "legacy-linear",
      },
      next: {
        path: "src/codegen-linear/simd.ts",
        state: "unmigrated",
        layer: "legacy-linear",
      },
    },
    {
      index: 199,
      row: {
        path: "src/codegen/array/array-search-core.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Pure instruction builders for the array-like search scan; move to the backend once the late-import funcIdx resolution is a backend service.",
      },
      previous: {
        path: "src/codegen/array-element-typing.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/array/array-search-proto-value.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-bound argument-vector unpacking and late-import registration from the shared array-like search core.",
      },
    },
    {
      index: 200,
      row: {
        path: "src/codegen/array/array-search-proto-value.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-bound argument-vector unpacking and late-import registration from the shared array-like search core.",
      },
      previous: {
        path: "src/codegen/array/array-search-core.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Pure instruction builders for the array-like search scan; move to the backend once the late-import funcIdx resolution is a backend service.",
      },
      next: {
        path: "src/codegen/array/array-generic-value-bodies.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-bound late-import registration from the reusable array-like pop/shift/toString body construction.",
      },
    },
    {
      index: 201,
      row: {
        path: "src/codegen/array/array-generic-value-bodies.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-bound late-import registration from the reusable array-like pop/shift/toString body construction.",
      },
      previous: {
        path: "src/codegen/array/array-search-proto-value.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-bound argument-vector unpacking and late-import registration from the shared array-like search core.",
      },
      next: {
        path: "src/codegen/array/array-copy-methods-value.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-bound argument coercion and late-import registration from the reusable change-array-by-copy body construction.",
      },
    },
    {
      index: 202,
      row: {
        path: "src/codegen/array/array-copy-methods-value.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-bound argument coercion and late-import registration from the reusable change-array-by-copy body construction.",
      },
      previous: {
        path: "src/codegen/array/array-generic-value-bodies.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-bound late-import registration from the reusable array-like pop/shift/toString body construction.",
      },
      next: {
        path: "src/codegen/array/array-sort-value.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction.",
      },
    },
    {
      index: 203,
      row: {
        path: "src/codegen/array/array-sort-value.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction.",
      },
      previous: {
        path: "src/codegen/array/array-copy-methods-value.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-bound argument coercion and late-import registration from the reusable change-array-by-copy body construction.",
      },
      next: {
        path: "src/codegen/array/array-fill-proto-value.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-bound Array.fill argument coercion and prototype-call emission from reusable native body construction.",
      },
    },
    {
      index: 244,
      row: {
        path: "src/codegen/async-frame-binding-continuity.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/async-await-hoist.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/async-cps-ast.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 339,
      row: {
        path: "src/codegen/object-model/generator-function-proto-arm.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate codegen-context generator-function identity registration and physical function/global allocation from the native [[Prototype]] arm bodies.",
      },
      previous: {
        path: "src/codegen/object-model/closed-object-prototype-edges.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate codegen-context prototype edge registration and physical function/global allocation from native prototype bodies.",
      },
      next: {
        path: "src/codegen/closed-struct-extern-set.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 349,
      row: {
        path: "src/codegen/closures/apply-extras-tail.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/closures.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/closures/arrow-phases.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 353,
      row: {
        path: "src/codegen/closures/closure-binding-identity.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/closures/capture-source-slot.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/closures/closure-dispatch-rest.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 356,
      row: {
        path: "src/codegen/closures/closure-type-sources.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/closures/closure-header-layout.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/closures/conditional-capture-box.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 449,
      row: {
        path: "src/codegen/expressions/identifier-receiver-slot.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/dynamic-proto.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/dynamic-read-narrowing.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 472,
      row: {
        path: "src/codegen/expressions/builtin-static-patched-call.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/expressions/builtin-class-names.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/expressions/builtin-prototype-constructor.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 585,
      row: {
        path: "src/codegen/fnctor-call-grown-fields.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/fnctor-array-prototype.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/fnctor-cold-tail.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 591,
      row: {
        path: "src/codegen/analysis/fnctor-ctor-self-dynamic.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/fnctor-ctor-param-types.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/fnctor-escape-gate.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 593,
      row: {
        path: "src/codegen/fnctor-fast-get.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/fnctor-escape-gate.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/fnctor-field-provenance.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 602,
      row: {
        path: "src/codegen/fnctor-struct-proto-hop.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/fnctor-presence-bits.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/fnctor-twin-captures.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 732,
      row: {
        path: "src/codegen/array/in-array-carrier.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/literals.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/array/live-array-iterator-value.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate codegen-context iterator kind and layout selection from the receiver-backed native iterator value body.",
      },
    },
    {
      index: 924,
      row: {
        path: "src/codegen/object-model/global-var-binding-exotic.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/object-model/module-namespace-exotic.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/object-model/proxy-trap-read.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 927,
      row: {
        path: "src/codegen/closures/function-intrinsic-construct.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate the AST callee-shape admission from the injected %Function% identity-arm instruction assembly.",
      },
      previous: {
        path: "src/codegen/closures/promoted-capture-value.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate context-bound promoted capture lookup and ref-cell type selection from native capture-value instructions.",
      },
      next: {
        path: "src/codegen/expressions/primitive-newtarget-default.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate the AST construct-target classification from the [[SetPrototypeOf]] instruction assembly.",
      },
    },
    {
      index: 928,
      row: {
        path: "src/codegen/expressions/primitive-newtarget-default.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate the AST construct-target classification from the [[SetPrototypeOf]] instruction assembly.",
      },
      previous: {
        path: "src/codegen/closures/function-intrinsic-construct.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate the AST callee-shape admission from the injected %Function% identity-arm instruction assembly.",
      },
      next: {
        path: "src/codegen/expressions/uncalled-shim-eval.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Move the AST-only reachability query into a frontend analysis module.",
      },
    },
    {
      index: 929,
      row: {
        path: "src/codegen/expressions/uncalled-shim-eval.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Move the AST-only reachability query into a frontend analysis module.",
      },
      previous: {
        path: "src/codegen/expressions/primitive-newtarget-default.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Separate the AST construct-target classification from the [[SetPrototypeOf]] instruction assembly.",
      },
      next: {
        path: "src/codegen/object-model/construct-default-proto.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 930,
      row: {
        path: "src/codegen/object-model/construct-default-proto.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/expressions/uncalled-shim-eval.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Move the AST-only reachability query into a frontend analysis module.",
      },
      next: {
        path: "src/codegen/closures/proxy-trap-closure-return.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 998,
      row: {
        path: "src/codegen/expressions/spread-elem-extern.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/spread-arg-list.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/stack-balance.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 1000,
      row: {
        path: "src/codegen/expressions/standalone-any-length.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/stack-balance.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/standalone-class-instance-proto.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 1080,
      row: {
        path: "src/codegen/object-model/struct-field-name-tags.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/struct-hierarchy-layout.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/object-model/struct-optional-widen.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 1133,
      row: {
        path: "src/codegen/array/vec-receiver-identity.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      previous: {
        path: "src/codegen/array/vec-elem-fidelity.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
      next: {
        path: "src/codegen/vec-externref-hole-presence.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
      },
    },
    {
      index: 1355,
      row: {
        path: "src/ir/lowering/string-operations.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "3518-coordinator",
        nextBoundary:
          "Generic string operation orchestration uses an injected emitter and only type-imports the clean semantic IR nodes and the still-unmigrated string emitter contract; establish a complete generic lowering contract closure before activation.",
      },
      previous: {
        path: "src/ir/lower-generic.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Generic implementation no longer selects a concrete emitter, but Wasm-shaped branches, resolver callbacks and mixed IR dependencies remain; this cycle removal is not pure-IR or whole-compiler closure.",
      },
      next: {
        path: "src/ir/lower.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Explicit old-path compatibility facade re-exports canonical generic lowering, Wasm assembly, constants and types; no implementations or factories remain here. Retain legacy consumers until their independent migration.",
      },
    },
    {
      index: 1516,
      row: {
        path: "src/runtime/native-regime-view.ts",
        state: "unmigrated",
        layer: "legacy-host",
      },
      previous: {
        path: "src/runtime/native-function-source.ts",
        state: "unmigrated",
        layer: "legacy-host",
      },
      next: {
        path: "src/runtime/process-capability.ts",
        state: "unmigrated",
        layer: "legacy-host",
      },
    },
    {
      index: 1517,
      row: {
        path: "src/runtime/process-capability.ts",
        state: "unmigrated",
        layer: "legacy-host",
      },
      previous: {
        path: "src/runtime/native-regime-view.ts",
        state: "unmigrated",
        layer: "legacy-host",
      },
      next: {
        path: "src/runtime/object-create-class-instance.ts",
        state: "unmigrated",
        layer: "legacy-host",
      },
    },
    {
      index: 1522,
      row: {
        path: "src/runtime/promise-try-polyfill.ts",
        state: "unmigrated",
        layer: "legacy-host",
      },
      previous: {
        path: "src/runtime/raw-exports-struct-authority.ts",
        state: "unmigrated",
        layer: "legacy-host",
      },
      next: {
        path: "src/runtime/standalone-dom-string-bridge.ts",
        state: "unmigrated",
        layer: "legacy-host",
      },
    },
    {
      index: 1547,
      row: {
        path: "src/shared/contracts/linear-memory-layout.ts",
        state: "clean",
        layer: "foundation",
      },
      previous: {
        path: "src/shared/contracts/identity-values.ts",
        state: "clean",
        layer: "foundation",
      },
      next: {
        path: "src/shared/contracts/ir-identity.ts",
        state: "clean",
        layer: "foundation",
      },
    },
    {
      index: 1881,
      row: {
        path: "src/ir/analysis/allocation-evidence/contracts.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/analysis/alloc-verification.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/effect-rules.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1882,
      row: {
        path: "src/ir/analysis/allocation-evidence/effect-rules.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/contracts.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/census.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1883,
      row: {
        path: "src/ir/analysis/allocation-evidence/census.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/effect-rules.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/metadata.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1884,
      row: {
        path: "src/ir/analysis/allocation-evidence/metadata.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/census.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/verify.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1885,
      row: {
        path: "src/ir/analysis/allocation-evidence/verify.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/metadata.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/runtime/verify.ts",
        state: "clean",
        layer: "ir-runtime",
      },
    },
    {
      index: 1888,
      row: {
        path: "src/ir/program/allocation-body-validation.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/program/allocations.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/program/class-layouts.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1914,
      row: {
        path: "src/shared/intl-locale-canonicalization.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Keep this pure, data-injected locale parser as unactivated migration debt until a separately-owned backend/wasmgc integration supplies a pinned generated source table, observable generic locale-list semantics, %Intl% identity, and native error exposure.",
      },
      previous: {
        path: "src/wasm/physical/number-remainder.ts",
        state: "clean",
        layer: "wasm-physical",
      },
      next: {
        path: "src/shared/contracts/compile-target.ts",
        state: "clean",
        layer: "foundation",
      },
    },
    {
      index: 1915,
      row: {
        path: "src/shared/contracts/compile-target.ts",
        state: "clean",
        layer: "foundation",
      },
      previous: {
        path: "src/shared/intl-locale-canonicalization.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "3518-coordinator",
        nextBoundary:
          "Keep this pure, data-injected locale parser as unactivated migration debt until a separately-owned backend/wasmgc integration supplies a pinned generated source table, observable generic locale-list semantics, %Intl% identity, and native error exposure.",
      },
      next: {
        path: "src/shared/contracts/compile-target-policy.ts",
        state: "clean",
        layer: "foundation",
      },
    },
    {
      index: 1916,
      row: {
        path: "src/shared/contracts/compile-target-policy.ts",
        state: "clean",
        layer: "foundation",
      },
      previous: {
        path: "src/shared/contracts/compile-target.ts",
        state: "clean",
        layer: "foundation",
      },
      next: {
        path: "src/ir/analysis/allocations/snapshot.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1917,
      row: {
        path: "src/ir/analysis/allocations/snapshot.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/shared/contracts/compile-target-policy.ts",
        state: "clean",
        layer: "foundation",
      },
      next: {
        path: "src/ir/analysis/linear/contracts/allocation-facts.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1918,
      row: {
        path: "src/ir/analysis/linear/contracts/allocation-facts.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/analysis/allocations/snapshot.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/analysis/linear/allocation-facts.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1919,
      row: {
        path: "src/ir/analysis/linear/allocation-facts.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/analysis/linear/contracts/allocation-facts.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/analysis/linear-memory-from-facts.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1920,
      row: {
        path: "src/ir/analysis/linear-memory-from-facts.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/analysis/linear/allocation-facts.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/program/linear-allocation-facts.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1921,
      row: {
        path: "src/ir/program/linear-allocation-facts.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/analysis/linear-memory-from-facts.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/program/linear-allocation-validation.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1922,
      row: {
        path: "src/ir/program/linear-allocation-validation.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/program/linear-allocation-facts.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/program/linear-allocation-outcome.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1923,
      row: {
        path: "src/ir/program/linear-allocation-outcome.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/program/linear-allocation-validation.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/program/linear-memory-demand.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1924,
      row: {
        path: "src/ir/program/linear-memory-demand.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/program/linear-allocation-outcome.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/runtime/target-admission.ts",
        state: "clean",
        layer: "ir-runtime",
      },
    },
    {
      index: 1925,
      row: {
        path: "src/ir/runtime/target-admission.ts",
        state: "clean",
        layer: "ir-runtime",
      },
      previous: {
        path: "src/ir/program/linear-memory-demand.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/program-sync-vectors.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Genuine synchronous checker-bound vector signatures and complete source-owner expression facts. Retain frontend debt until shared source preparation relocation; no physical representation.",
      },
    },
    {
      index: 1926,
      row: {
        path: "src/ir/program-sync-vectors.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Genuine synchronous checker-bound vector signatures and complete source-owner expression facts. Retain frontend debt until shared source preparation relocation; no physical representation.",
      },
      previous: {
        path: "src/ir/runtime/target-admission.ts",
        state: "clean",
        layer: "ir-runtime",
      },
      next: {
        path: "src/ir/program/linear-vector-flow.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1927,
      row: {
        path: "src/ir/program/linear-vector-flow.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/program-sync-vectors.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Genuine synchronous checker-bound vector signatures and complete source-owner expression facts. Retain frontend debt until shared source preparation relocation; no physical representation.",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/vector-call-profile.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1928,
      row: {
        path: "src/ir/analysis/allocation-evidence/vector-call-profile.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/program/linear-vector-flow.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/native-source-selection.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Checker-bound source selectors and genuine logical vector collector; preserve frontend ownership until source preparation moves to frontend/ts. No physical representation or pure IR claim.",
      },
    },
    {
      index: 1929,
      row: {
        path: "src/ir/native-source-selection.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Checker-bound source selectors and genuine logical vector collector; preserve frontend ownership until source preparation moves to frontend/ts. No physical representation or pure IR claim.",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/vector-call-profile.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/ast-vector-representation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Compatibility carrier reads for actual backend vector handles at the existing source bridge; native prepared vectors retain logical element types. Relocate with source preparation; no pure IR or backend-independent physical claim.",
      },
    },
    {
      index: 1930,
      row: {
        path: "src/ir/ast-vector-representation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Compatibility carrier reads for actual backend vector handles at the existing source bridge; native prepared vectors retain logical element types. Relocate with source preparation; no pure IR or backend-independent physical claim.",
      },
      previous: {
        path: "src/ir/native-source-selection.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Checker-bound source selectors and genuine logical vector collector; preserve frontend ownership until source preparation moves to frontend/ts. No physical representation or pure IR claim.",
      },
      next: {
        path: "src/ir/program-body-resources.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-program",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate shared body carriers from concrete WasmGC resource selection while retaining the sole physical reservation and common emission attempt.",
      },
    },
    {
      index: 1931,
      row: {
        path: "src/ir/program-body-resources.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-program",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate shared body carriers from concrete WasmGC resource selection while retaining the sole physical reservation and common emission attempt.",
      },
      previous: {
        path: "src/ir/ast-vector-representation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Compatibility carrier reads for actual backend vector handles at the existing source bridge; native prepared vectors retain logical element types. Relocate with source preparation; no pure IR or backend-independent physical claim.",
      },
      next: {
        path: "src/ir/program/physical-startup.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1932,
      row: {
        path: "src/ir/program/physical-startup.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/program-body-resources.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-program",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate shared body carriers from concrete WasmGC resource selection while retaining the sole physical reservation and common emission attempt.",
      },
      next: {
        path: "src/codegen-linear/runtime/arena/bump-allocation.ts",
        state: "compatibility-adapter",
        layer: "legacy-linear",
        reason: "Identity-preserving direct reexports of canonical physical Linear runtime body builders.",
      },
    },
    {
      index: 1933,
      row: {
        path: "src/codegen-linear/runtime/arena/bump-allocation.ts",
        state: "compatibility-adapter",
        layer: "legacy-linear",
        reason: "Identity-preserving direct reexports of canonical physical Linear runtime body builders.",
      },
      previous: {
        path: "src/ir/program/physical-startup.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/codegen-linear/runtime/arrays/constructor.ts",
        state: "compatibility-adapter",
        layer: "legacy-linear",
        reason: "Identity-preserving direct reexports of canonical physical Linear runtime body builders.",
      },
    },
    {
      index: 1934,
      row: {
        path: "src/codegen-linear/runtime/arrays/constructor.ts",
        state: "compatibility-adapter",
        layer: "legacy-linear",
        reason: "Identity-preserving direct reexports of canonical physical Linear runtime body builders.",
      },
      previous: {
        path: "src/codegen-linear/runtime/arena/bump-allocation.ts",
        state: "compatibility-adapter",
        layer: "legacy-linear",
        reason: "Identity-preserving direct reexports of canonical physical Linear runtime body builders.",
      },
      next: {
        path: "src/ir/backend/vector-representation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate common logical vector carriers from concrete legacy and GC type coordinates with real runtime reservations.",
      },
    },
    {
      index: 1935,
      row: {
        path: "src/ir/backend/vector-representation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate common logical vector carriers from concrete legacy and GC type coordinates with real runtime reservations.",
      },
      previous: {
        path: "src/codegen-linear/runtime/arrays/constructor.ts",
        state: "compatibility-adapter",
        layer: "legacy-linear",
        reason: "Identity-preserving direct reexports of canonical physical Linear runtime body builders.",
      },
      next: {
        path: "src/wasm/physical/linear-bump-allocation.ts",
        state: "clean",
        layer: "wasm-physical",
      },
    },
    {
      index: 1936,
      row: {
        path: "src/wasm/physical/linear-bump-allocation.ts",
        state: "clean",
        layer: "wasm-physical",
      },
      previous: {
        path: "src/ir/backend/vector-representation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate common logical vector carriers from concrete legacy and GC type coordinates with real runtime reservations.",
      },
      next: {
        path: "src/wasm/physical/linear-array-constructor.ts",
        state: "clean",
        layer: "wasm-physical",
      },
    },
    {
      index: 1937,
      row: {
        path: "src/wasm/physical/linear-array-constructor.ts",
        state: "clean",
        layer: "wasm-physical",
      },
      previous: {
        path: "src/wasm/physical/linear-bump-allocation.ts",
        state: "clean",
        layer: "wasm-physical",
      },
      next: {
        path: "src/wasm/physical/linear-vector-initialization.ts",
        state: "clean",
        layer: "wasm-physical",
      },
    },
    {
      index: 1938,
      row: {
        path: "src/wasm/physical/linear-vector-initialization.ts",
        state: "clean",
        layer: "wasm-physical",
      },
      previous: {
        path: "src/wasm/physical/linear-array-constructor.ts",
        state: "clean",
        layer: "wasm-physical",
      },
      next: {
        path: "src/frontend/program-origin.ts",
        state: "clean",
        layer: "frontend-ts",
      },
    },
    {
      index: 1939,
      row: {
        path: "src/frontend/program-origin.ts",
        state: "clean",
        layer: "frontend-ts",
      },
      previous: {
        path: "src/wasm/physical/linear-vector-initialization.ts",
        state: "clean",
        layer: "wasm-physical",
      },
      next: {
        path: "src/frontend/program-origin-census.ts",
        state: "clean",
        layer: "frontend-ts",
      },
    },
    {
      index: 1940,
      row: {
        path: "src/frontend/program-origin-census.ts",
        state: "clean",
        layer: "frontend-ts",
      },
      previous: {
        path: "src/frontend/program-origin.ts",
        state: "clean",
        layer: "frontend-ts",
      },
      next: {
        path: "src/frontend/program-origin-host.ts",
        state: "clean",
        layer: "frontend-ts",
      },
    },
    {
      index: 1941,
      row: {
        path: "src/frontend/program-origin-host.ts",
        state: "clean",
        layer: "frontend-ts",
      },
      previous: {
        path: "src/frontend/program-origin-census.ts",
        state: "clean",
        layer: "frontend-ts",
      },
      next: {
        path: "src/frontend/ts5-trace.ts",
        state: "clean",
        layer: "frontend-ts",
      },
    },
    {
      index: 1942,
      row: {
        path: "src/frontend/ts5-trace.ts",
        state: "clean",
        layer: "frontend-ts",
      },
      previous: {
        path: "src/frontend/program-origin-host.ts",
        state: "clean",
        layer: "frontend-ts",
      },
      next: {
        path: "src/shared/contracts/environment-value.ts",
        state: "clean",
        layer: "foundation",
      },
    },
    {
      index: 1943,
      row: {
        path: "src/shared/contracts/environment-value.ts",
        state: "clean",
        layer: "foundation",
      },
      previous: {
        path: "src/frontend/ts5-trace.ts",
        state: "clean",
        layer: "frontend-ts",
      },
      next: {
        path: "src/ir/program/startup-validation.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1944,
      row: {
        path: "src/ir/program/startup-validation.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/shared/contracts/environment-value.ts",
        state: "clean",
        layer: "foundation",
      },
      next: {
        path: "src/wasm/physical/linear-body-batch-exception-tag.ts",
        state: "clean",
        layer: "wasm-physical",
      },
    },
    {
      index: 1945,
      row: {
        path: "src/wasm/physical/linear-body-batch-exception-tag.ts",
        state: "clean",
        layer: "wasm-physical",
      },
      previous: {
        path: "src/ir/program/startup-validation.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/backend/linear-body-batch-resources.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Body-batch orchestration still combines canonical IR demand inspection with injected legacy adapter ports. Physical exception-tag custody now uses the canonical Wasm-only provider; establish remaining semantic/provider consumer closure before layer activation. No whole-preflight or whole-compiler closure is established.",
      },
    },
    {
      index: 1946,
      row: {
        path: "src/ir/backend/linear-body-batch-resources.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Body-batch orchestration still combines canonical IR demand inspection with injected legacy adapter ports. Physical exception-tag custody now uses the canonical Wasm-only provider; establish remaining semantic/provider consumer closure before layer activation. No whole-preflight or whole-compiler closure is established.",
      },
      previous: {
        path: "src/wasm/physical/linear-body-batch-exception-tag.ts",
        state: "clean",
        layer: "wasm-physical",
      },
      next: {
        path: "src/backend/linear/program/contracts.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
    },
    {
      index: 1947,
      row: {
        path: "src/backend/linear/program/contracts.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      previous: {
        path: "src/ir/backend/linear-body-batch-resources.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Body-batch orchestration still combines canonical IR demand inspection with injected legacy adapter ports. Physical exception-tag custody now uses the canonical Wasm-only provider; establish remaining semantic/provider consumer closure before layer activation. No whole-preflight or whole-compiler closure is established.",
      },
      next: {
        path: "src/backend/linear/program/memory.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
    },
    {
      index: 1948,
      row: {
        path: "src/backend/linear/program/memory.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      previous: {
        path: "src/backend/linear/program/contracts.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      next: {
        path: "src/backend/linear/program/reference-error.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
    },
    {
      index: 1949,
      row: {
        path: "src/backend/linear/program/reference-error.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      previous: {
        path: "src/backend/linear/program/memory.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      next: {
        path: "src/codegen-linear/runtime/arrays/forwarding-resolver.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "legacy-linear",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
    },
    {
      index: 1950,
      row: {
        path: "src/codegen-linear/runtime/arrays/forwarding-resolver.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "legacy-linear",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      previous: {
        path: "src/backend/linear/program/reference-error.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      next: {
        path: "src/codegen-linear/runtime/vector-initialization.ts",
        state: "unmigrated",
        layer: "legacy-linear",
        reason:
          "Identity-preserving direct reexport of the complete canonical physical f64 vector initialization body.",
      },
    },
    {
      index: 1951,
      row: {
        path: "src/codegen-linear/runtime/vector-initialization.ts",
        state: "unmigrated",
        layer: "legacy-linear",
        reason:
          "Identity-preserving direct reexport of the complete canonical physical f64 vector initialization body.",
      },
      previous: {
        path: "src/codegen-linear/runtime/arrays/forwarding-resolver.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "legacy-linear",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      next: {
        path: "src/compiler/ir-program-startup-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
    },
    {
      index: 1952,
      row: {
        path: "src/compiler/ir-program-startup-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      previous: {
        path: "src/codegen-linear/runtime/vector-initialization.ts",
        state: "unmigrated",
        layer: "legacy-linear",
        reason:
          "Identity-preserving direct reexport of the complete canonical physical f64 vector initialization body.",
      },
      next: {
        path: "src/compiler/native-linear-pipeline.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
    },
    {
      index: 1953,
      row: {
        path: "src/compiler/native-linear-pipeline.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      previous: {
        path: "src/compiler/ir-program-startup-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      next: {
        path: "src/ir/backend/linear-exceptions.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
    },
    {
      index: 1954,
      row: {
        path: "src/ir/backend/linear-exceptions.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      previous: {
        path: "src/compiler/native-linear-pipeline.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      next: {
        path: "src/ir/program-reference-error.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
    },
    {
      index: 1955,
      row: {
        path: "src/ir/program-reference-error.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      previous: {
        path: "src/ir/backend/linear-exceptions.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      next: {
        path: "src/ir/runtime/reference-error-callable.ts",
        state: "clean",
        layer: "ir-runtime",
      },
    },
    {
      index: 1956,
      row: {
        path: "src/ir/runtime/reference-error-callable.ts",
        state: "clean",
        layer: "ir-runtime",
      },
      previous: {
        path: "src/ir/program-reference-error.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation.",
      },
      next: {
        path: "src/ir/program/physical-diagnostics.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1957,
      row: {
        path: "src/ir/program/physical-diagnostics.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/runtime/reference-error-callable.ts",
        state: "clean",
        layer: "ir-runtime",
      },
      next: {
        path: "src/ir/program-linear-memory.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate descriptive canonical Linear planning from backend resource selection while preserving authenticated issuance.",
      },
    },
    {
      index: 1958,
      row: {
        path: "src/ir/program-linear-memory.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate descriptive canonical Linear planning from backend resource selection while preserving authenticated issuance.",
      },
      previous: {
        path: "src/ir/program/physical-diagnostics.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/compiler/ir-program-error-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate authenticated completed-resource presentation from the shared consumer while preserving the original emission and exact ownership census.",
      },
    },
    {
      index: 1959,
      row: {
        path: "src/compiler/ir-program-error-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate authenticated completed-resource presentation from the shared consumer while preserving the original emission and exact ownership census.",
      },
      previous: {
        path: "src/ir/program-linear-memory.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "wasm-physical",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate descriptive canonical Linear planning from backend resource selection while preserving authenticated issuance.",
      },
      next: {
        path: "src/compiler/ir-program-memory-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate authenticated completed-resource presentation from the shared consumer while preserving the original emission and exact ownership census.",
      },
    },
    {
      index: 1960,
      row: {
        path: "src/compiler/ir-program-memory-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate authenticated completed-resource presentation from the shared consumer while preserving the original emission and exact ownership census.",
      },
      previous: {
        path: "src/compiler/ir-program-error-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate authenticated completed-resource presentation from the shared consumer while preserving the original emission and exact ownership census.",
      },
      next: {
        path: "src/ir/program/physical-vector-carriers.ts",
        state: "clean",
        layer: "ir-program",
        owner: "6920-session-b-native-takeover",
      },
    },
    {
      index: 1961,
      row: {
        path: "src/ir/program/physical-vector-carriers.ts",
        state: "clean",
        layer: "ir-program",
        owner: "6920-session-b-native-takeover",
      },
      previous: {
        path: "src/compiler/ir-program-memory-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Separate authenticated completed-resource presentation from the shared consumer while preserving the original emission and exact ownership census.",
      },
      next: {
        path: "src/shared/contracts/prepared-ir-data.ts",
        state: "clean",
        layer: "foundation",
        owner: "6920-session-b-native-takeover",
      },
    },
    {
      index: 1962,
      row: {
        path: "src/shared/contracts/prepared-ir-data.ts",
        state: "clean",
        layer: "foundation",
        owner: "6920-session-b-native-takeover",
      },
      previous: {
        path: "src/ir/program/physical-vector-carriers.ts",
        state: "clean",
        layer: "ir-program",
        owner: "6920-session-b-native-takeover",
      },
      next: {
        path: "src/shared/contracts/prepared-ir-invariant-error.ts",
        state: "clean",
        layer: "foundation",
        owner: "6920-session-b-native-takeover",
      },
    },
    {
      index: 1963,
      row: {
        path: "src/shared/contracts/prepared-ir-invariant-error.ts",
        state: "clean",
        layer: "foundation",
        owner: "6920-session-b-native-takeover",
      },
      previous: {
        path: "src/shared/contracts/prepared-ir-data.ts",
        state: "clean",
        layer: "foundation",
        owner: "6920-session-b-native-takeover",
      },
      next: {
        path: "src/shared/contracts/ir-class-shape-marker.ts",
        state: "clean",
        layer: "foundation",
        owner: "6920-session-b-native-takeover",
      },
    },
    {
      index: 1964,
      row: {
        path: "src/shared/contracts/ir-class-shape-marker.ts",
        state: "clean",
        layer: "foundation",
        owner: "6920-session-b-native-takeover",
      },
      previous: {
        path: "src/shared/contracts/prepared-ir-invariant-error.ts",
        state: "clean",
        layer: "foundation",
        owner: "6920-session-b-native-takeover",
      },
      next: {
        path: "src/shared/contracts/native-string-resource-keys.ts",
        state: "clean",
        layer: "foundation",
        owner: "6920-session-b-native-takeover",
      },
    },
    {
      index: 1965,
      row: {
        path: "src/shared/contracts/native-string-resource-keys.ts",
        state: "clean",
        layer: "foundation",
        owner: "6920-session-b-native-takeover",
      },
      previous: {
        path: "src/shared/contracts/ir-class-shape-marker.ts",
        state: "clean",
        layer: "foundation",
        owner: "6920-session-b-native-takeover",
      },
      next: {
        path: "src/ir/program/native-primitive-boundary-abi.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1966,
      row: {
        path: "src/ir/program/native-primitive-boundary-abi.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/shared/contracts/native-string-resource-keys.ts",
        state: "clean",
        layer: "foundation",
        owner: "6920-session-b-native-takeover",
      },
      next: {
        path: "src/ir/program/physical-body-requirements.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1967,
      row: {
        path: "src/ir/program/physical-body-requirements.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/program/native-primitive-boundary-abi.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/program/prepared-linear-memory-contracts.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1968,
      row: {
        path: "src/ir/program/prepared-linear-memory-contracts.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/program/physical-body-requirements.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/program/physical-body-resource-contracts.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1969,
      row: {
        path: "src/ir/program/physical-body-resource-contracts.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/program/prepared-linear-memory-contracts.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/runtime/contracts/native-resource-declarations.ts",
        state: "clean",
        layer: "runtime-contracts",
      },
    },
    {
      index: 1970,
      row: {
        path: "src/runtime/contracts/native-resource-declarations.ts",
        state: "clean",
        layer: "runtime-contracts",
      },
      previous: {
        path: "src/ir/program/physical-body-resource-contracts.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/program/native-primitive-boundary-contracts.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1971,
      row: {
        path: "src/ir/program/native-primitive-boundary-contracts.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/runtime/contracts/native-resource-declarations.ts",
        state: "clean",
        layer: "runtime-contracts",
      },
      next: {
        path: "src/ir/core/native-conditional-type.ts",
        state: "clean",
        layer: "ir-core",
      },
    },
    {
      index: 1972,
      row: {
        path: "src/ir/core/native-conditional-type.ts",
        state: "clean",
        layer: "ir-core",
      },
      previous: {
        path: "src/ir/program/native-primitive-boundary-contracts.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/structured-vector-facts.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1973,
      row: {
        path: "src/ir/analysis/allocation-evidence/structured-vector-facts.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/core/native-conditional-type.ts",
        state: "clean",
        layer: "ir-core",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/structured-vector-body.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1974,
      row: {
        path: "src/ir/analysis/allocation-evidence/structured-vector-body.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/structured-vector-facts.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/structured-vector-profile.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1975,
      row: {
        path: "src/ir/analysis/allocation-evidence/structured-vector-profile.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/structured-vector-body.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/native-control-producer.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1976,
      row: {
        path: "src/ir/analysis/allocation-evidence/native-control-producer.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/structured-vector-profile.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/native-vector-mutation-proof.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Checker-bound native mutation proof; move with source preparation to frontend/ts. No physical layout or pure IR claim.",
      },
    },
    {
      index: 1977,
      row: {
        path: "src/ir/native-vector-mutation-proof.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Checker-bound native mutation proof; move with source preparation to frontend/ts. No physical layout or pure IR claim.",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/native-control-producer.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/native-vector-mutation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Checker-bound native logical mutation lowering; move with source preparation to frontend/ts. No physical layout or pure IR claim.",
      },
    },
    {
      index: 1978,
      row: {
        path: "src/ir/native-vector-mutation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Checker-bound native logical mutation lowering; move with source preparation to frontend/ts. No physical layout or pure IR claim.",
      },
      previous: {
        path: "src/ir/native-vector-mutation-proof.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Checker-bound native mutation proof; move with source preparation to frontend/ts. No physical layout or pure IR claim.",
      },
      next: {
        path: "src/ir/logical-vector-source-facts.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Existing owned logical source facts and consumption checks, extracted unchanged from the frontend driver; move with source preparation to frontend/ts.",
      },
    },
    {
      index: 1979,
      row: {
        path: "src/ir/logical-vector-source-facts.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Existing owned logical source facts and consumption checks, extracted unchanged from the frontend driver; move with source preparation to frontend/ts.",
      },
      previous: {
        path: "src/ir/native-vector-mutation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Checker-bound native logical mutation lowering; move with source preparation to frontend/ts. No physical layout or pure IR claim.",
      },
      next: {
        path: "src/compiler/native-vector-global-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-native-preparation",
        nextBoundary:
          "Actual native internal global capture and canonical source/issued storage joins; frontend presentation debt remains.",
      },
    },
    {
      index: 1980,
      row: {
        path: "src/compiler/native-vector-global-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-native-preparation",
        nextBoundary:
          "Actual native internal global capture and canonical source/issued storage joins; frontend presentation debt remains.",
      },
      previous: {
        path: "src/ir/logical-vector-source-facts.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Existing owned logical source facts and consumption checks, extracted unchanged from the frontend driver; move with source preparation to frontend/ts.",
      },
      next: {
        path: "src/ir/backend/native-global-read.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "6920-native-preparation",
        nextBoundary:
          "Bounded native program global read emission through issued storage endpoint; no layout/source ownership or completion claim.",
      },
    },
    {
      index: 1981,
      row: {
        path: "src/ir/backend/native-global-read.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "6920-native-preparation",
        nextBoundary:
          "Bounded native program global read emission through issued storage endpoint; no layout/source ownership or completion claim.",
      },
      previous: {
        path: "src/compiler/native-vector-global-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-native-preparation",
        nextBoundary:
          "Actual native internal global capture and canonical source/issued storage joins; frontend presentation debt remains.",
      },
      next: {
        path: "src/ir/module-binding-declarations.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Original complete checker/oracle declaration query and cache subsystem; moved without changing calls or bodies. Remains source preparation debt.",
      },
    },
    {
      index: 1982,
      row: {
        path: "src/ir/module-binding-declarations.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Original complete checker/oracle declaration query and cache subsystem; moved without changing calls or bodies. Remains source preparation debt.",
      },
      previous: {
        path: "src/ir/backend/native-global-read.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "6920-native-preparation",
        nextBoundary:
          "Bounded native program global read emission through issued storage endpoint; no layout/source ownership or completion claim.",
      },
      next: {
        path: "src/ir/native-module-vector-source.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Actual checker-owned module const literal facts; move with source preparation. No backend resources or pure IR admission.",
      },
    },
    {
      index: 1983,
      row: {
        path: "src/ir/native-module-vector-source.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Actual checker-owned module const literal facts; move with source preparation. No backend resources or pure IR admission.",
      },
      previous: {
        path: "src/ir/module-binding-declarations.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Original complete checker/oracle declaration query and cache subsystem; moved without changing calls or bodies. Remains source preparation debt.",
      },
      next: {
        path: "src/ir/withdrawn-unit-references.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-program",
        owner: "6920-native-preparation",
        nextBoundary:
          "Complete existing unit reference census relocated with preserved public reexport; no architecture activation claim.",
      },
    },
    {
      index: 1984,
      row: {
        path: "src/ir/withdrawn-unit-references.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-program",
        owner: "6920-native-preparation",
        nextBoundary:
          "Complete existing unit reference census relocated with preserved public reexport; no architecture activation claim.",
      },
      previous: {
        path: "src/ir/native-module-vector-source.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-native-preparation",
        nextBoundary:
          "Actual checker-owned module const literal facts; move with source preparation. No backend resources or pure IR admission.",
      },
      next: {
        path: "src/ir/backend/instruction-uses.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-native-preparation",
        nextBoundary:
          "Complete existing generic instruction SSA-use census moved byte-identically out of lowering; retain actual consumers and historical grammar, no architecture activation claim.",
      },
    },
    {
      index: 1985,
      row: {
        path: "src/ir/backend/instruction-uses.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-native-preparation",
        nextBoundary:
          "Complete existing generic instruction SSA-use census moved byte-identically out of lowering; retain actual consumers and historical grammar, no architecture activation claim.",
      },
      previous: {
        path: "src/ir/withdrawn-unit-references.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-program",
        owner: "6920-native-preparation",
        nextBoundary:
          "Complete existing unit reference census relocated with preserved public reexport; no architecture activation claim.",
      },
      next: {
        path: "src/ir/program/native-module-vector-context.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1986,
      row: {
        path: "src/ir/program/native-module-vector-context.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/backend/instruction-uses.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "ir-core",
        owner: "6920-native-preparation",
        nextBoundary:
          "Complete existing generic instruction SSA-use census moved byte-identically out of lowering; retain actual consumers and historical grammar, no architecture activation claim.",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/module-vector-globals.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1987,
      row: {
        path: "src/ir/analysis/allocation-evidence/module-vector-globals.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/ir/program/native-module-vector-context.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/ir/program/native-vector-growth-source.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1988,
      row: {
        path: "src/ir/program/native-vector-growth-source.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/module-vector-globals.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/ir/program/native-vector-store-proof.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1989,
      row: {
        path: "src/ir/program/native-vector-store-proof.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/program/native-vector-growth-source.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/wasm/physical/linear-vector-append.ts",
        state: "clean",
        layer: "wasm-physical",
      },
    },
    {
      index: 1990,
      row: {
        path: "src/wasm/physical/linear-vector-append.ts",
        state: "clean",
        layer: "wasm-physical",
      },
      previous: {
        path: "src/ir/program/native-vector-store-proof.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: {
        path: "src/wasm/physical/gc-vector-append.ts",
        state: "clean",
        layer: "wasm-physical",
      },
    },
    {
      index: 1991,
      row: {
        path: "src/wasm/physical/gc-vector-append.ts",
        state: "clean",
        layer: "wasm-physical",
      },
      previous: {
        path: "src/wasm/physical/linear-vector-append.ts",
        state: "clean",
        layer: "wasm-physical",
      },
      next: {
        path: "src/ir/analysis/allocation-evidence/numeric-append-protocol.ts",
        state: "clean",
        layer: "ir-analysis",
      },
    },
    {
      index: 1992,
      row: {
        path: "src/ir/analysis/allocation-evidence/numeric-append-protocol.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      previous: {
        path: "src/wasm/physical/gc-vector-append.ts",
        state: "clean",
        layer: "wasm-physical",
      },
      next: {
        path: "src/ir/runtime/numeric-vector-callables.ts",
        state: "clean",
        layer: "ir-runtime",
      },
    },
    {
      index: 1993,
      row: {
        path: "src/ir/runtime/numeric-vector-callables.ts",
        state: "clean",
        layer: "ir-runtime",
      },
      previous: {
        path: "src/ir/analysis/allocation-evidence/numeric-append-protocol.ts",
        state: "clean",
        layer: "ir-analysis",
      },
      next: {
        path: "src/compiler/native-numeric-append-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-native-preparation",
        nextBoundary:
          "Canonical append DATA joined to immutable completed support and physical ABI; frontend presentation debt remains.",
      },
    },
    {
      index: 1994,
      row: {
        path: "src/compiler/native-numeric-append-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-native-preparation",
        nextBoundary:
          "Canonical append DATA joined to immutable completed support and physical ABI; frontend presentation debt remains.",
      },
      previous: {
        path: "src/ir/runtime/numeric-vector-callables.ts",
        state: "clean",
        layer: "ir-runtime",
      },
      next: {
        path: "src/ir/program-native-vector-emission.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Injected common emission coordination retains original GC and Linear reservation owners; move with the consumer after separating portable origin lookup from target resource ports.",
      },
    },
    {
      index: 1995,
      row: {
        path: "src/ir/program-native-vector-emission.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Injected common emission coordination retains original GC and Linear reservation owners; move with the consumer after separating portable origin lookup from target resource ports.",
      },
      previous: {
        path: "src/compiler/native-numeric-append-presentation.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-native-preparation",
        nextBoundary:
          "Canonical append DATA joined to immutable completed support and physical ABI; frontend presentation debt remains.",
      },
      next: {
        path: "src/compiler/native-ir-dts.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Source-free native scalar declarations derive from immutable semantic ABI and authentic current emissions; Prepared program and consumer imports retain migration debt until their complete import closure is separated.",
      },
    },
    {
      index: 1996,
      row: {
        path: "src/compiler/native-ir-dts.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Source-free native scalar declarations derive from immutable semantic ABI and authentic current emissions; Prepared program and consumer imports retain migration debt until their complete import closure is separated.",
      },
      previous: {
        path: "src/ir/program-native-vector-emission.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "backend-wasmgc",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Injected common emission coordination retains original GC and Linear reservation owners; move with the consumer after separating portable origin lookup from target resource ports.",
      },
      next: null,
    },
  ],
  layerFields: [
    {
      layerIndex: 0,
      layerId: "foundation",
      field: "minModules",
      before: 9,
      after: 10,
    },
    {
      layerIndex: 0,
      layerId: "foundation",
      field: "entries",
      before: [
        "src/shared/contracts/source-origin.ts",
        "src/shared/contracts/ir-identity.ts",
        "src/shared/contracts/identity-values.ts",
        "src/shared/contracts/ir-counted-string-identity.ts",
        "src/shared/contracts/ir-preparation-failure.ts",
        "src/shared/contracts/ir-unit-inventory.ts",
        "src/shared/contracts/ir-preparation-errors.ts",
        "src/shared/contracts/ir-counted-string-site-id.ts",
        "src/shared/contracts/string-surrogate.ts",
      ],
      after: [
        "src/shared/contracts/source-origin.ts",
        "src/shared/contracts/ir-identity.ts",
        "src/shared/contracts/identity-values.ts",
        "src/shared/contracts/ir-counted-string-identity.ts",
        "src/shared/contracts/ir-preparation-failure.ts",
        "src/shared/contracts/ir-unit-inventory.ts",
        "src/shared/contracts/ir-preparation-errors.ts",
        "src/shared/contracts/ir-counted-string-site-id.ts",
        "src/shared/contracts/string-surrogate.ts",
        "src/shared/contracts/linear-memory-layout.ts",
      ],
    },
    {
      layerIndex: 4,
      layerId: "frontend-ts",
      field: "roots",
      before: [
        "src/frontend/builtins/contracts.ts",
        "src/frontend/builtins/prepare-string-output.ts",
        "src/frontend/typescript.ts",
      ],
      after: [
        "src/frontend/builtins/contracts.ts",
        "src/frontend/builtins/prepare-string-output.ts",
        "src/frontend/typescript.ts",
        "src/frontend/program-origin.ts",
        "src/frontend/program-origin-census.ts",
        "src/frontend/program-origin-host.ts",
        "src/frontend/ts5-trace.ts",
      ],
    },
    {
      layerIndex: 4,
      layerId: "frontend-ts",
      field: "entries",
      before: [
        "src/frontend/builtins/contracts.ts",
        "src/frontend/builtins/prepare-string-output.ts",
        "src/frontend/typescript.ts",
      ],
      after: [
        "src/frontend/builtins/contracts.ts",
        "src/frontend/builtins/prepare-string-output.ts",
        "src/frontend/typescript.ts",
        "src/frontend/program-origin.ts",
        "src/frontend/program-origin-census.ts",
        "src/frontend/program-origin-host.ts",
        "src/frontend/ts5-trace.ts",
      ],
    },
    {
      layerIndex: 6,
      layerId: "ir-analysis",
      field: "roots",
      before: [
        "src/ir/analysis/contracts",
        "src/ir/analysis/alloc-registry.ts",
        "src/ir/analysis/effects.ts",
        "src/ir/analysis/intrinsics.ts",
        "src/ir/analysis/async-plan.ts",
        "src/ir/analysis/lattice.ts",
        "src/ir/analysis/ownership.ts",
        "src/ir/analysis/encoding.ts",
        "src/ir/analysis/escape.ts",
        "src/ir/analysis/dominance.ts",
        "src/ir/analysis/alloc-verification.ts",
        "src/ir/analysis/nested-stackification.ts",
        "src/ir/analysis/backend-legality.ts",
      ],
      after: [
        "src/ir/analysis/contracts",
        "src/ir/analysis/allocation-evidence",
        "src/ir/analysis/alloc-registry.ts",
        "src/ir/analysis/effects.ts",
        "src/ir/analysis/intrinsics.ts",
        "src/ir/analysis/async-plan.ts",
        "src/ir/analysis/lattice.ts",
        "src/ir/analysis/ownership.ts",
        "src/ir/analysis/encoding.ts",
        "src/ir/analysis/escape.ts",
        "src/ir/analysis/dominance.ts",
        "src/ir/analysis/alloc-verification.ts",
        "src/ir/analysis/nested-stackification.ts",
        "src/ir/analysis/backend-legality.ts",
        "src/ir/analysis/allocations/snapshot.ts",
        "src/ir/analysis/linear/contracts/allocation-facts.ts",
        "src/ir/analysis/linear/allocation-facts.ts",
        "src/ir/analysis/linear-memory-from-facts.ts",
      ],
    },
    {
      layerIndex: 6,
      layerId: "ir-analysis",
      field: "minModules",
      before: 14,
      after: 19,
    },
    {
      layerIndex: 6,
      layerId: "ir-analysis",
      field: "entries",
      before: [
        "src/ir/analysis/contracts/allocations.ts",
        "src/ir/analysis/alloc-registry.ts",
        "src/ir/analysis/effects.ts",
        "src/ir/analysis/intrinsics.ts",
        "src/ir/analysis/async-plan.ts",
        "src/ir/analysis/lattice.ts",
        "src/ir/analysis/ownership.ts",
        "src/ir/analysis/encoding.ts",
        "src/ir/analysis/escape.ts",
        "src/ir/analysis/dominance.ts",
        "src/ir/analysis/alloc-verification.ts",
        "src/ir/analysis/nested-stackification.ts",
        "src/ir/analysis/contracts/linear-memory-layout.ts",
        "src/ir/analysis/backend-legality.ts",
      ],
      after: [
        "src/ir/analysis/contracts/allocations.ts",
        "src/ir/analysis/alloc-registry.ts",
        "src/ir/analysis/effects.ts",
        "src/ir/analysis/intrinsics.ts",
        "src/ir/analysis/async-plan.ts",
        "src/ir/analysis/lattice.ts",
        "src/ir/analysis/ownership.ts",
        "src/ir/analysis/encoding.ts",
        "src/ir/analysis/escape.ts",
        "src/ir/analysis/dominance.ts",
        "src/ir/analysis/alloc-verification.ts",
        "src/ir/analysis/nested-stackification.ts",
        "src/ir/analysis/contracts/linear-memory-layout.ts",
        "src/ir/analysis/backend-legality.ts",
        "src/ir/analysis/allocation-evidence/contracts.ts",
        "src/ir/analysis/allocation-evidence/effect-rules.ts",
        "src/ir/analysis/allocation-evidence/census.ts",
        "src/ir/analysis/allocation-evidence/metadata.ts",
        "src/ir/analysis/allocation-evidence/verify.ts",
        "src/ir/analysis/allocations/snapshot.ts",
        "src/ir/analysis/linear/contracts/allocation-facts.ts",
        "src/ir/analysis/linear/allocation-facts.ts",
        "src/ir/analysis/linear-memory-from-facts.ts",
      ],
    },
    {
      layerIndex: 9,
      layerId: "ir-program",
      field: "minModules",
      before: 48,
      after: 49,
    },
    {
      layerIndex: 9,
      layerId: "ir-program",
      field: "entries",
      before: [
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
      after: [
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
        "src/ir/program/allocation-body-validation.ts",
      ],
    },
  ],
  rawSpans: [
    {
      beforeOffset: 1366,
      afterOffset: 1366,
      before: '        "src/shared/contracts/string-surrogate.ts"\n',
      after:
        '        "src/shared/contracts/string-surrogate.ts",\n        "src/shared/contracts/linear-memory-layout.ts"\n',
    },
    {
      beforeOffset: 1426,
      afterOffset: 1482,
      before: '      "minModules": 9\n',
      after: '      "minModules": 10\n',
    },
    {
      beforeOffset: 2552,
      afterOffset: 2609,
      before: '        "src/frontend/typescript.ts"\n',
      after:
        '        "src/frontend/typescript.ts",\n        "src/frontend/program-origin.ts",\n        "src/frontend/program-origin-census.ts",\n        "src/frontend/program-origin-host.ts",\n        "src/frontend/ts5-trace.ts"\n',
    },
    {
      beforeOffset: 2745,
      afterOffset: 2977,
      before: '        "src/frontend/typescript.ts"\n',
      after:
        '        "src/frontend/typescript.ts",\n        "src/frontend/program-origin.ts",\n        "src/frontend/program-origin-census.ts",\n        "src/frontend/program-origin-host.ts",\n        "src/frontend/ts5-trace.ts"\n',
    },
    {
      beforeOffset: 4300,
      afterOffset: 4707,
      before: "",
      after: '        "src/ir/analysis/allocation-evidence",\n',
    },
    {
      beforeOffset: 4760,
      afterOffset: 5214,
      before: '        "src/ir/analysis/backend-legality.ts"\n',
      after:
        '        "src/ir/analysis/backend-legality.ts",\n        "src/ir/analysis/allocations/snapshot.ts",\n        "src/ir/analysis/linear/contracts/allocation-facts.ts",\n        "src/ir/analysis/linear/allocation-facts.ts",\n        "src/ir/analysis/linear-memory-from-facts.ts"\n',
    },
    {
      beforeOffset: 5431,
      afterOffset: 6109,
      before: '        "src/ir/analysis/backend-legality.ts"\n',
      after:
        '        "src/ir/analysis/backend-legality.ts",\n        "src/ir/analysis/allocation-evidence/contracts.ts",\n        "src/ir/analysis/allocation-evidence/effect-rules.ts",\n        "src/ir/analysis/allocation-evidence/census.ts",\n        "src/ir/analysis/allocation-evidence/metadata.ts",\n        "src/ir/analysis/allocation-evidence/verify.ts",\n        "src/ir/analysis/allocations/snapshot.ts",\n        "src/ir/analysis/linear/contracts/allocation-facts.ts",\n        "src/ir/analysis/linear/allocation-facts.ts",\n        "src/ir/analysis/linear-memory-from-facts.ts"\n',
    },
    {
      beforeOffset: 5486,
      afterOffset: 6684,
      before: '      "minModules": 14\n',
      after: '      "minModules": 19\n',
    },
    {
      beforeOffset: 9261,
      afterOffset: 10459,
      before: '        "src/ir/program/validation.ts"\n',
      after: '        "src/ir/program/validation.ts",\n        "src/ir/program/allocation-body-validation.ts"\n',
    },
    {
      beforeOffset: 9309,
      afterOffset: 10563,
      before: '      "minModules": 48\n',
      after: '      "minModules": 49\n',
    },
    {
      beforeOffset: 72469,
      afterOffset: 73723,
      before: "",
      after:
        '      "path": "src/ir/backend/vector-element-access.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Common vector get/store lowering preserves target emission and exact fixed-construction bounds; mixed emitter/handle contracts remain, so this helper does not establish pure-IR or compiler graph closure."\n    },\n    {\n',
    },
    {
      beforeOffset: 89936,
      afterOffset: 91627,
      before: "",
      after:
        '      "path": "src/checker/js-collection-inference.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "3518-coordinator",\n      "nextBoundary": "New #6651 V12 leaf of src/checker/index.ts (synthetic ambient root for `.js` checker programs); it depends only on the TS wrapper and moves with its parent when the checker\'s TS-wrapper dependencies are separated at frontend closure."\n    },\n    {\n',
    },
    {
      beforeOffset: 96963,
      afterOffset: 99117,
      before: "",
      after:
        '      "state": "unmigrated",\n      "layer": "legacy-linear"\n    },\n    {\n      "path": "src/codegen-linear/runtime/string-slice.ts",\n',
    },
    {
      beforeOffset: 109718,
      afterOffset: 112005,
      before: "",
      after:
        '      "path": "src/codegen/array/array-search-core.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Pure instruction builders for the array-like search scan; move to the backend once the late-import funcIdx resolution is a backend service."\n    },\n    {\n      "path": "src/codegen/array/array-search-proto-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound argument-vector unpacking and late-import registration from the shared array-like search core."\n    },\n    {\n      "path": "src/codegen/array/array-generic-value-bodies.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound late-import registration from the reusable array-like pop/shift/toString body construction."\n    },\n    {\n      "path": "src/codegen/array/array-copy-methods-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound argument coercion and late-import registration from the reusable change-array-by-copy body construction."\n    },\n    {\n      "path": "src/codegen/array/array-sort-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound late-import registration and comparator coercion from the reusable array-like sort body construction."\n    },\n    {\n',
    },
    {
      beforeOffset: 122215,
      afterOffset: 126310,
      before: "",
      after:
        '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/async-frame-binding-continuity.ts",\n',
    },
    {
      beforeOffset: 152644,
      afterOffset: 157067,
      before: "",
      after:
        '      "path": "src/codegen/object-model/generator-function-proto-arm.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate codegen-context generator-function identity registration and physical function/global allocation from the native [[Prototype]] arm bodies."\n    },\n    {\n',
    },
    {
      beforeOffset: 155489,
      afterOffset: 160310,
      before: "",
      after:
        '      "path": "src/codegen/closures/apply-extras-tail.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
    },
    {
      beforeOffset: 156464,
      afterOffset: 161609,
      before: "",
      after:
        '      "path": "src/codegen/closures/closure-binding-identity.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
    },
    {
      beforeOffset: 156855,
      afterOffset: 162331,
      before: "",
      after:
        '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/closures/closure-type-sources.ts",\n',
    },
    {
      beforeOffset: 186886,
      afterOffset: 192689,
      before: "",
      after:
        '      "path": "src/codegen/expressions/identifier-receiver-slot.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
    },
    {
      beforeOffset: 193675,
      afterOffset: 199812,
      before: "",
      after:
        '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/builtin-static-patched-call.ts",\n',
    },
    {
      beforeOffset: 230617,
      afterOffset: 237091,
      before: "",
      after:
        '      "path": "src/codegen/fnctor-call-grown-fields.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
    },
    {
      beforeOffset: 232210,
      afterOffset: 239006,
      before: "",
      after:
        '      "path": "src/codegen/analysis/fnctor-ctor-self-dynamic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
    },
    {
      beforeOffset: 232261,
      afterOffset: 239388,
      before: "",
      after:
        '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/fnctor-fast-get.ts",\n',
    },
    {
      beforeOffset: 234831,
      afterOffset: 242271,
      before: "",
      after:
        '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/fnctor-struct-proto-hop.ts",\n',
    },
    {
      beforeOffset: 275989,
      afterOffset: 283750,
      before: "",
      after:
        '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/array/in-array-carrier.ts",\n',
    },
    {
      beforeOffset: 338769,
      afterOffset: 346850,
      before: "",
      after:
        '      "path": "src/codegen/object-model/global-var-binding-exotic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
    },
    {
      beforeOffset: 339437,
      afterOffset: 347854,
      before: "",
      after:
        '    },\n    {\n      "path": "src/codegen/closures/function-intrinsic-construct.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate the AST callee-shape admission from the injected %Function% identity-arm instruction assembly."\n    },\n    {\n      "path": "src/codegen/expressions/primitive-newtarget-default.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate the AST construct-target classification from the [[SetPrototypeOf]] instruction assembly."\n    },\n    {\n      "path": "src/codegen/expressions/uncalled-shim-eval.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Move the AST-only reachability query into a frontend analysis module."\n    },\n    {\n      "path": "src/codegen/object-model/construct-default-proto.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n',
    },
    {
      beforeOffset: 360895,
      afterOffset: 370652,
      before: "",
      after:
        '      "path": "src/codegen/expressions/spread-elem-extern.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
    },
    {
      beforeOffset: 360941,
      afterOffset: 371026,
      before: "",
      after:
        '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/standalone-any-length.ts",\n',
    },
    {
      beforeOffset: 386669,
      afterOffset: 397085,
      before: "",
      after:
        '      "path": "src/codegen/object-model/struct-field-name-tags.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
    },
    {
      beforeOffset: 402909,
      afterOffset: 413658,
      before: "",
      after:
        '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/array/vec-receiver-identity.ts",\n',
    },
    {
      beforeOffset: 469528,
      afterOffset: 480602,
      before: "",
      after:
        '      "path": "src/ir/lowering/string-operations.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Generic string operation orchestration uses an injected emitter and only type-imports the clean semantic IR nodes and the still-unmigrated string emitter contract; establish a complete generic lowering contract closure before activation."\n    },\n    {\n',
    },
    {
      beforeOffset: 515987,
      afterOffset: 527523,
      before: "",
      after:
        '      "path": "src/runtime/native-regime-view.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n    {\n      "path": "src/runtime/process-capability.ts",\n      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n    {\n',
    },
    {
      beforeOffset: 516437,
      afterOffset: 528217,
      before: "",
      after:
        '      "state": "unmigrated",\n      "layer": "legacy-host"\n    },\n    {\n      "path": "src/runtime/promise-try-polyfill.ts",\n',
    },
    {
      beforeOffset: 519674,
      afterOffset: 531578,
      before: "",
      after:
        '      "state": "clean",\n      "layer": "foundation"\n    },\n    {\n      "path": "src/shared/contracts/linear-memory-layout.ts",\n',
    },
    {
      beforeOffset: 596100,
      afterOffset: 608131,
      before: "",
      after:
        '      "path": "src/ir/analysis/allocation-evidence/contracts.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/effect-rules.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/census.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/metadata.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/verify.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n',
    },
    {
      beforeOffset: 596254,
      afterOffset: 608941,
      before: "",
      after:
        '      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/allocation-body-validation.ts",\n',
    },
    {
      beforeOffset: 599709,
      afterOffset: 612523,
      before: "",
      after:
        '    },\n    {\n      "path": "src/shared/intl-locale-canonicalization.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Keep this pure, data-injected locale parser as unactivated migration debt until a separately-owned backend/wasmgc integration supplies a pinned generated source table, observable generic locale-list semantics, %Intl% identity, and native error exposure."\n    },\n    {\n      "path": "src/shared/contracts/compile-target.ts",\n      "state": "clean",\n      "layer": "foundation"\n    },\n    {\n      "path": "src/shared/contracts/compile-target-policy.ts",\n      "state": "clean",\n      "layer": "foundation"\n    },\n    {\n      "path": "src/ir/analysis/allocations/snapshot.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/linear/contracts/allocation-facts.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/linear/allocation-facts.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/linear-memory-from-facts.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/program/linear-allocation-facts.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/linear-allocation-validation.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/linear-allocation-outcome.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/linear-memory-demand.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/runtime/target-admission.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n    },\n    {\n      "path": "src/ir/program-sync-vectors.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "6920-native-preparation",\n      "nextBoundary": "Genuine synchronous checker-bound vector signatures and complete source-owner expression facts. Retain frontend debt until shared source preparation relocation; no physical representation."\n    },\n    {\n      "path": "src/ir/program/linear-vector-flow.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/vector-call-profile.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/native-source-selection.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "6920-native-preparation",\n      "nextBoundary": "Checker-bound source selectors and genuine logical vector collector; preserve frontend ownership until source preparation moves to frontend/ts. No physical representation or pure IR claim."\n    },\n    {\n      "path": "src/ir/ast-vector-representation.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "6920-native-preparation",\n      "nextBoundary": "Compatibility carrier reads for actual backend vector handles at the existing source bridge; native prepared vectors retain logical element types. Relocate with source preparation; no pure IR or backend-independent physical claim."\n    },\n    {\n      "path": "src/ir/program-body-resources.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "ir-program",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Separate shared body carriers from concrete WasmGC resource selection while retaining the sole physical reservation and common emission attempt."\n    },\n    {\n      "path": "src/ir/program/physical-startup.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/codegen-linear/runtime/arena/bump-allocation.ts",\n      "state": "compatibility-adapter",\n      "layer": "legacy-linear",\n      "reason": "Identity-preserving direct reexports of canonical physical Linear runtime body builders."\n    },\n    {\n      "path": "src/codegen-linear/runtime/arrays/constructor.ts",\n      "state": "compatibility-adapter",\n      "layer": "legacy-linear",\n      "reason": "Identity-preserving direct reexports of canonical physical Linear runtime body builders."\n    },\n    {\n      "path": "src/ir/backend/vector-representation.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "ir-core",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Separate common logical vector carriers from concrete legacy and GC type coordinates with real runtime reservations."\n    },\n    {\n      "path": "src/wasm/physical/linear-bump-allocation.ts",\n      "state": "clean",\n      "layer": "wasm-physical"\n    },\n    {\n      "path": "src/wasm/physical/linear-array-constructor.ts",\n      "state": "clean",\n      "layer": "wasm-physical"\n    },\n    {\n      "path": "src/wasm/physical/linear-vector-initialization.ts",\n      "state": "clean",\n      "layer": "wasm-physical"\n    },\n    {\n      "path": "src/frontend/program-origin.ts",\n      "state": "clean",\n      "layer": "frontend-ts"\n    },\n    {\n      "path": "src/frontend/program-origin-census.ts",\n      "state": "clean",\n      "layer": "frontend-ts"\n    },\n    {\n      "path": "src/frontend/program-origin-host.ts",\n      "state": "clean",\n      "layer": "frontend-ts"\n    },\n    {\n      "path": "src/frontend/ts5-trace.ts",\n      "state": "clean",\n      "layer": "frontend-ts"\n    },\n    {\n      "path": "src/shared/contracts/environment-value.ts",\n      "state": "clean",\n      "layer": "foundation"\n    },\n    {\n      "path": "src/ir/program/startup-validation.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/wasm/physical/linear-body-batch-exception-tag.ts",\n      "state": "clean",\n      "layer": "wasm-physical"\n    },\n    {\n      "path": "src/ir/backend/linear-body-batch-resources.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "wasm-physical",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Body-batch orchestration still combines canonical IR demand inspection with injected legacy adapter ports. Physical exception-tag custody now uses the canonical Wasm-only provider; establish remaining semantic/provider consumer closure before layer activation. No whole-preflight or whole-compiler closure is established."\n    },\n    {\n      "path": "src/backend/linear/program/contracts.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "wasm-physical",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation."\n    },\n    {\n      "path": "src/backend/linear/program/memory.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "wasm-physical",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation."\n    },\n    {\n      "path": "src/backend/linear/program/reference-error.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "wasm-physical",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation."\n    },\n    {\n      "path": "src/codegen-linear/runtime/arrays/forwarding-resolver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "legacy-linear",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation."\n    },\n    {\n      "path": "src/codegen-linear/runtime/vector-initialization.ts",\n      "state": "unmigrated",\n      "layer": "legacy-linear",\n      "reason": "Identity-preserving direct reexport of the complete canonical physical f64 vector initialization body."\n    },\n    {\n      "path": "src/compiler/ir-program-startup-presentation.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation."\n    },\n    {\n      "path": "src/compiler/native-linear-pipeline.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation."\n    },\n    {\n      "path": "src/ir/backend/linear-exceptions.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "ir-core",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation."\n    },\n    {\n      "path": "src/ir/program-reference-error.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "ir-core",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Retain actual shared consumer/runtime recipe ownership and audit the complete source-free import closure before layer activation."\n    },\n    {\n      "path": "src/ir/runtime/reference-error-callable.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n    },\n    {\n      "path": "src/ir/program/physical-diagnostics.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program-linear-memory.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "wasm-physical",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Separate descriptive canonical Linear planning from backend resource selection while preserving authenticated issuance."\n    },\n    {\n      "path": "src/compiler/ir-program-error-presentation.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Separate authenticated completed-resource presentation from the shared consumer while preserving the original emission and exact ownership census."\n    },\n    {\n      "path": "src/compiler/ir-program-memory-presentation.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Separate authenticated completed-resource presentation from the shared consumer while preserving the original emission and exact ownership census."\n    },\n    {\n      "path": "src/ir/program/physical-vector-carriers.ts",\n      "state": "clean",\n      "layer": "ir-program",\n      "owner": "6920-session-b-native-takeover"\n    },\n    {\n      "path": "src/shared/contracts/prepared-ir-data.ts",\n      "state": "clean",\n      "layer": "foundation",\n      "owner": "6920-session-b-native-takeover"\n    },\n    {\n      "path": "src/shared/contracts/prepared-ir-invariant-error.ts",\n      "state": "clean",\n      "layer": "foundation",\n      "owner": "6920-session-b-native-takeover"\n    },\n    {\n      "path": "src/shared/contracts/ir-class-shape-marker.ts",\n      "state": "clean",\n      "layer": "foundation",\n      "owner": "6920-session-b-native-takeover"\n    },\n    {\n      "path": "src/shared/contracts/native-string-resource-keys.ts",\n      "state": "clean",\n      "layer": "foundation",\n      "owner": "6920-session-b-native-takeover"\n    },\n    {\n      "path": "src/ir/program/native-primitive-boundary-abi.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/physical-body-requirements.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/prepared-linear-memory-contracts.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/physical-body-resource-contracts.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/runtime/contracts/native-resource-declarations.ts",\n      "state": "clean",\n      "layer": "runtime-contracts"\n    },\n    {\n      "path": "src/ir/program/native-primitive-boundary-contracts.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/core/native-conditional-type.ts",\n      "state": "clean",\n      "layer": "ir-core"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/structured-vector-facts.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/structured-vector-body.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/structured-vector-profile.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/native-control-producer.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/native-vector-mutation-proof.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "6920-native-preparation",\n      "nextBoundary": "Checker-bound native mutation proof; move with source preparation to frontend/ts. No physical layout or pure IR claim."\n    },\n    {\n      "path": "src/ir/native-vector-mutation.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "6920-native-preparation",\n      "nextBoundary": "Checker-bound native logical mutation lowering; move with source preparation to frontend/ts. No physical layout or pure IR claim."\n    },\n    {\n      "path": "src/ir/logical-vector-source-facts.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "6920-native-preparation",\n      "nextBoundary": "Existing owned logical source facts and consumption checks, extracted unchanged from the frontend driver; move with source preparation to frontend/ts."\n    },\n    {\n      "path": "src/compiler/native-vector-global-presentation.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "6920-native-preparation",\n      "nextBoundary": "Actual native internal global capture and canonical source/issued storage joins; frontend presentation debt remains."\n    },\n    {\n      "path": "src/ir/backend/native-global-read.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "6920-native-preparation",\n      "nextBoundary": "Bounded native program global read emission through issued storage endpoint; no layout/source ownership or completion claim."\n    },\n    {\n      "path": "src/ir/module-binding-declarations.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "6920-native-preparation",\n      "nextBoundary": "Original complete checker/oracle declaration query and cache subsystem; moved without changing calls or bodies. Remains source preparation debt."\n    },\n    {\n      "path": "src/ir/native-module-vector-source.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "6920-native-preparation",\n      "nextBoundary": "Actual checker-owned module const literal facts; move with source preparation. No backend resources or pure IR admission."\n    },\n    {\n      "path": "src/ir/withdrawn-unit-references.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "ir-program",\n      "owner": "6920-native-preparation",\n      "nextBoundary": "Complete existing unit reference census relocated with preserved public reexport; no architecture activation claim."\n    },\n    {\n      "path": "src/ir/backend/instruction-uses.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "ir-core",\n      "owner": "6920-native-preparation",\n      "nextBoundary": "Complete existing generic instruction SSA-use census moved byte-identically out of lowering; retain actual consumers and historical grammar, no architecture activation claim."\n    },\n    {\n      "path": "src/ir/program/native-module-vector-context.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/module-vector-globals.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/program/native-vector-growth-source.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/native-vector-store-proof.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/wasm/physical/linear-vector-append.ts",\n      "state": "clean",\n      "layer": "wasm-physical"\n    },\n    {\n      "path": "src/wasm/physical/gc-vector-append.ts",\n      "state": "clean",\n      "layer": "wasm-physical"\n    },\n    {\n      "path": "src/ir/analysis/allocation-evidence/numeric-append-protocol.ts",\n      "state": "clean",\n      "layer": "ir-analysis"\n    },\n    {\n      "path": "src/ir/runtime/numeric-vector-callables.ts",\n      "state": "clean",\n      "layer": "ir-runtime"\n    },\n    {\n      "path": "src/compiler/native-numeric-append-presentation.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "6920-native-preparation",\n      "nextBoundary": "Canonical append DATA joined to immutable completed support and physical ABI; frontend presentation debt remains."\n    },\n    {\n      "path": "src/ir/program-native-vector-emission.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Injected common emission coordination retains original GC and Linear reservation owners; move with the consumer after separating portable origin lookup from target resource ports."\n    },\n    {\n      "path": "src/compiler/native-ir-dts.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "compiler",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Source-free native scalar declarations derive from immutable semantic ABI and authentic current emissions; Prepared program and consumer imports retain migration debt until their complete import closure is separated."\n',
    },
  ],
} as const;
const root = resolve(import.meta.dirname, "..");
const read = (path: string): string =>
  createIrNativeNumberUndefinedInventoryReader(
    createIrNativeNumberUndefinedOptimizationPolicyReader((currentPath) =>
      readFileSync(resolve(root, currentPath), "utf8"),
    ),
  )(path);
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const nextCurrentDomainExpected = {
  before: {
    source: {
      bytes: 631801,
      sha256: "8f88968d6821cf2ced8ebac1cde913de0dd81e34122a45e5d07295ab5e197a53",
      gitBlob: "f0426fdd6abfa00fd3351f96e1a8d0ced77a9055",
    },
    fileCount: 1997,
    dataSha256: "c78333d68e266116bad972f1a2034328ad8149bcd731dc573f8edb215d3606a0",
    filesSha256: "369a775c5ae714ce35db7656bc656d5e087c660292212508588317ecc7f422a2",
    nonFilesSha256: "55a72bc549a5ebc2351631c574fe518c1457a48fd36f57550f13a3dc74917faf",
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
  },
  current: {
    source: {
      bytes: 633127,
      sha256: "60bfda84dda819fc45e60ebb370e06d6007001f5885f2a934f24c3c5c1757dc7",
      gitBlob: "9e3ef20082947f200844fb79f4f5476c83653e5c",
    },
    fileCount: 2001,
    dataSha256: "168eeef9253d3bdb6b8b6880adfafbf4ceb1e73f755e5121be336da06eae064c",
    filesSha256: "a9032453c2cf3b3357c640c637e856b863184d0434d45792dd4f4128fb425cc9",
    nonFilesSha256: "55a72bc549a5ebc2351631c574fe518c1457a48fd36f57550f13a3dc74917faf",
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
  },
  removedRows: [
    {
      index: 1997,
      row: {
        path: "src/ir/source-class-plans.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "3522-b-native-class-producer",
        nextBoundary:
          "Original checker/AST class census, source type/default/initializer and allocation-site plans; no pure IR classification until source preparation moves to frontend/ts.",
      },
      previous: {
        path: "src/compiler/native-ir-dts.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "compiler",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Source-free native scalar declarations derive from immutable semantic ABI and authentic current emissions; Prepared program and consumer imports retain migration debt until their complete import closure is separated.",
      },
      next: {
        path: "src/ir/source-class-lowering.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "3522-b-native-class-producer",
        nextBoundary:
          "Original class member orchestration and non-synthetic implicit constructor entry remain frontend lowering; separate source adapters from neutral typed DATA.",
      },
    },
    {
      index: 1998,
      row: {
        path: "src/ir/source-class-lowering.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "3522-b-native-class-producer",
        nextBoundary:
          "Original class member orchestration and non-synthetic implicit constructor entry remain frontend lowering; separate source adapters from neutral typed DATA.",
      },
      previous: {
        path: "src/ir/source-class-plans.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "3522-b-native-class-producer",
        nextBoundary:
          "Original checker/AST class census, source type/default/initializer and allocation-site plans; no pure IR classification until source preparation moves to frontend/ts.",
      },
      next: {
        path: "src/ir/program/class-preparation.ts",
        state: "clean",
        layer: "ir-program",
      },
    },
    {
      index: 1999,
      row: {
        path: "src/ir/program/class-preparation.ts",
        state: "clean",
        layer: "ir-program",
      },
      previous: {
        path: "src/ir/source-class-lowering.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "3522-b-native-class-producer",
        nextBoundary:
          "Original class member orchestration and non-synthetic implicit constructor entry remain frontend lowering; separate source adapters from neutral typed DATA.",
      },
      next: {
        path: "src/ir/native-vector-undefined-provenance.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Checker-symbol native numeric defined-value provenance retains TypeScript AST authority; migrate with source lowering, never infer runtime absence from unboxed carriers.",
      },
    },
    {
      index: 2000,
      row: {
        path: "src/ir/native-vector-undefined-provenance.ts",
        state: "unmigrated",
        layer: "mixed-needs-split",
        destination: "frontend-ts",
        owner: "6920-session-b-native-takeover",
        nextBoundary:
          "Checker-symbol native numeric defined-value provenance retains TypeScript AST authority; migrate with source lowering, never infer runtime absence from unboxed carriers.",
      },
      previous: {
        path: "src/ir/program/class-preparation.ts",
        state: "clean",
        layer: "ir-program",
      },
      next: null,
    },
  ],
  layerFields: [],
  rawSpans: [
    {
      beforeOffset: 631794,
      afterOffset: 631794,
      before: "",
      after:
        ',\n    {\n      "path": "src/ir/source-class-plans.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "3522-b-native-class-producer",\n      "nextBoundary": "Original checker/AST class census, source type/default/initializer and allocation-site plans; no pure IR classification until source preparation moves to frontend/ts."\n    },\n    {\n      "path": "src/ir/source-class-lowering.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "3522-b-native-class-producer",\n      "nextBoundary": "Original class member orchestration and non-synthetic implicit constructor entry remain frontend lowering; separate source adapters from neutral typed DATA."\n    },\n    {\n      "path": "src/ir/program/class-preparation.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/native-vector-undefined-provenance.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "6920-session-b-native-takeover",\n      "nextBoundary": "Checker-symbol native numeric defined-value provenance retains TypeScript AST authority; migrate with source lowering, never infer runtime absence from unboxed carriers."\n    }',
    },
  ],
} as const;
const previousReceiptPin = {
  bytes: 278016,
  sha256: "8afb3f54711de600001d43d64402dc7d982e2d131b6e633eff4ac36b4faefa8d",
} as const;
const classOnlyProfile = {
  source: {
    bytes: 632708,
    sha256: "ac111a9b28070be385d4460a9db59f54845e3ba9d409367e2fcf5838f04ac732",
    gitBlob: "853624406b84dc45aad13a8dc28f27010a322726",
  },
  fileCount: 2000,
  dataSha256: "3cbfea7bd0b221f15d3ec78ddaba5a66c2ec50427e899e1079236af2d8c4431c",
  filesSha256: "f90f0d9cbd8b4231b2d130c4d3447f9e87d9e6652b029e6e25899d9be6474ff6",
  nonFilesSha256: "55a72bc549a5ebc2351631c574fe518c1457a48fd36f57550f13a3dc74917faf",
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
} as const;
const classOnlyInsertion =
  ',\n    {\n      "path": "src/ir/source-class-plans.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "3522-b-native-class-producer",\n      "nextBoundary": "Original checker/AST class census, source type/default/initializer and allocation-site plans; no pure IR classification until source preparation moves to frontend/ts."\n    },\n    {\n      "path": "src/ir/source-class-lowering.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "frontend-ts",\n      "owner": "3522-b-native-class-producer",\n      "nextBoundary": "Original class member orchestration and non-synthetic implicit constructor entry remain frontend lowering; separate source adapters from neutral typed DATA."\n    },\n    {\n      "path": "src/ir/program/class-preparation.ts",\n      "state": "clean",\n      "layer": "ir-program"\n    }';
type Policy = Record<string, unknown> & { files: Record<string, unknown>[] };
type Profile =
  | typeof nextCurrentDomainExpected.current
  | typeof classOnlyProfile
  | typeof currentDomainExpected.current
  | typeof expected.current
  | typeof former1873Profile
  | typeof e24Main1872Profile
  | typeof former1872Profile
  | typeof fccMain1871Profile
  | typeof checkpoint1870Profile
  | typeof prior1871Profile
  | typeof upstream1870Profile
  | typeof former1868Profile
  | typeof current1866Profile
  | typeof expected.main46caf
  | typeof expected.main0be
  | typeof current1864Profile
  | typeof expected.main58d
  | typeof expected.main6998
  | typeof expected.oldPosition
  | typeof expected.oldDeno
  | typeof previousCurrentProfile
  | typeof main431Profile
  | typeof formerCurrentProfile;
function profile(raw: string, target: Profile): Policy {
  expect(Buffer.byteLength(raw)).toBe(target.source.bytes);
  expect(sha(raw)).toBe(target.source.sha256);
  expect(
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(raw)}\0`)
      .update(raw)
      .digest("hex"),
  ).toBe(target.source.gitBlob);
  const data = JSON.parse(raw) as Policy;
  expect(Object.keys(data)).toEqual(target.topLevelKeys);
  expect(data.files).toHaveLength(target.fileCount);
  expect(sha(JSON.stringify(data))).toBe(target.dataSha256);
  expect(sha(JSON.stringify(data.files))).toBe(target.filesSha256);
  expect(sha(JSON.stringify(Object.fromEntries(Object.entries(data).filter(([key]) => key !== "files"))))).toBe(
    target.nonFilesSha256,
  );
  return data;
}
function pin(path: string, target: { bytes: number; sha256: string }) {
  const raw = read(path);
  expect(Buffer.byteLength(raw)).toBe(target.bytes);
  expect(sha(raw)).toBe(target.sha256);
}
function undo58d(
  raw: string,
  insertion: { readonly offset: number; readonly literal: string },
  target: Profile,
): string {
  const bytes = Buffer.from(raw),
    inserted = Buffer.from(insertion.literal);
  expect(bytes.subarray(insertion.offset, insertion.offset + inserted.length)).toEqual(inserted);
  const previous = Buffer.concat([
    bytes.subarray(0, insertion.offset),
    bytes.subarray(insertion.offset + inserted.length),
  ]).toString("utf8");
  profile(previous, target);
  expect(
    Buffer.concat([
      Buffer.from(previous).subarray(0, insertion.offset),
      inserted,
      Buffer.from(previous).subarray(insertion.offset),
    ]).toString("utf8"),
  ).toBe(raw);
  return previous;
}
function undo0be(
  raw: string,
  spans: readonly {
    readonly beforeOffset: number;
    readonly afterOffset: number;
    readonly before: string;
    readonly after: string;
  }[],
  target: Profile,
): string {
  let previous = Buffer.from(raw);
  for (const span of [...spans].reverse()) {
    const inserted = Buffer.from(span.after);
    expect(span.before).toBe("");
    expect(previous.subarray(span.afterOffset, span.afterOffset + inserted.length)).toEqual(inserted);
    previous = Buffer.concat([
      previous.subarray(0, span.afterOffset),
      previous.subarray(span.afterOffset + inserted.length),
    ]);
  }
  profile(previous.toString("utf8"), target);
  let replay = previous;
  for (const span of [...spans].reverse())
    replay = Buffer.concat([
      replay.subarray(0, span.beforeOffset),
      Buffer.from(span.after),
      replay.subarray(span.beforeOffset),
    ]);
  expect(replay.toString("utf8")).toBe(raw);
  return previous.toString("utf8");
}
function former1873(raw: string): string {
  return undo0be(historicalRaw(raw), e24Insertions, former1873Profile);
}
function former1872(raw: string): string {
  return undo0be(former1873(raw), fccInsertions, former1872Profile);
}
function checkpoint1870(raw: string): string {
  return undo0be(former1872(raw), incomingInsertions, checkpoint1870Profile);
}
function prior1871(raw: string): string {
  return undo0be(former1872(raw), [incomingInsertions[0]], prior1871Profile);
}
function former1868(raw: string): string {
  return undo0be(checkpoint1870(raw), remainderInsertions, former1868Profile);
}
function independent(
  raw: string,
  which: "main46caf" | "main0be" | "main58d" | "main6998" | "oldPosition" | "oldDeno",
): string {
  raw = historicalRaw(raw);
  if (which === "main0be") return undo0be(independent(raw, "main46caf"), main46Insertions, expected.main0be);
  if (which === "main58d") return undo0be(independent(raw, "main0be"), main0beInsertions, expected.main58d);
  if (which === "main6998") return undo58d(independent(raw, "main58d"), formerMainInsertion, expected.main6998);
  const current = profile(raw, expected.current),
    projection = expected.projections[which],
    bytes = Buffer.from(raw);
  const chunks: Buffer[] = [];
  let beforeEnd = 0,
    afterEnd = 0;
  for (const span of projection.rawSpans) {
    expect(Number.isSafeInteger(span.beforeOffset)).toBe(true);
    expect(Number.isSafeInteger(span.afterOffset)).toBe(true);
    expect(span.beforeOffset).toBeGreaterThanOrEqual(beforeEnd);
    expect(span.afterOffset).toBeGreaterThanOrEqual(afterEnd);
    expect(span.beforeOffset - beforeEnd).toBe(span.afterOffset - afterEnd);
    const before = Buffer.from(span.before),
      after = Buffer.from(span.after);
    expect(span.beforeOffset + before.length).toBeLessThanOrEqual(expected[which].source.bytes);
    expect(span.afterOffset + after.length).toBeLessThanOrEqual(bytes.length);
    expect(bytes.subarray(span.afterOffset, span.afterOffset + after.length)).toEqual(after);
    chunks.push(bytes.subarray(afterEnd, span.afterOffset), before);
    beforeEnd = span.beforeOffset + before.length;
    afterEnd = span.afterOffset + after.length;
  }
  chunks.push(bytes.subarray(afterEnd));
  const previous = Buffer.concat(chunks);
  const before = profile(previous.toString("utf8"), expected[which]);
  const replay: Buffer[] = [];
  beforeEnd = 0;
  for (const span of projection.rawSpans) {
    const old = Buffer.from(span.before);
    expect(previous.subarray(span.beforeOffset, span.beforeOffset + old.length)).toEqual(old);
    replay.push(previous.subarray(beforeEnd, span.beforeOffset), Buffer.from(span.after));
    beforeEnd = span.beforeOffset + old.length;
  }
  replay.push(previous.subarray(beforeEnd));
  expect(Buffer.concat(replay)).toEqual(bytes);
  const semantic = structuredClone(current);
  for (const row of projection.removedRows) {
    expect(current.files[row.index]).toEqual(row.row);
    expect(current.files[row.index - 1]).toEqual(row.previous);
    expect(current.files[row.index + 1]).toEqual(row.next);
  }
  for (const row of [...projection.removedRows].reverse()) semantic.files.splice(row.index, 1);
  expect(semantic).toEqual(before);
  for (const row of projection.removedRows) semantic.files.splice(row.index, 0, structuredClone(row.row));
  expect(semantic).toEqual(current);
  return previous.toString("utf8");
}
/** Test-side inverse, independently frozen; never used to approve production input. */
function historicalRaw(raw: string): string {
  raw = nextHistoricalRaw(raw);
  if (sha(raw) !== currentDomainExpected.current.source.sha256) return raw;
  const current = profile(raw, currentDomainExpected.current);
  const bytes = Buffer.from(raw),
    chunks: Buffer[] = [];
  let end = 0;
  for (const span of currentDomainExpected.rawSpans) {
    const after = Buffer.from(span.after);
    expect(bytes.subarray(span.afterOffset, span.afterOffset + after.length)).toEqual(after);
    chunks.push(bytes.subarray(end, span.afterOffset), Buffer.from(span.before));
    end = span.afterOffset + after.length;
  }
  chunks.push(bytes.subarray(end));
  const historical = Buffer.concat(chunks).toString("utf8");
  const before = profile(historical, expected.current);
  const semantic = structuredClone(current);
  const layers = semantic.layers as Record<string, unknown>[];
  for (const row of currentDomainExpected.removedRows) {
    expect(semantic.files[row.index]).toEqual(row.row);
    expect(semantic.files[row.index - 1] ?? null).toEqual(row.previous);
    expect(semantic.files[row.index + 1] ?? null).toEqual(row.next);
  }
  for (const row of [...currentDomainExpected.removedRows].reverse()) semantic.files.splice(row.index, 1);
  for (const field of currentDomainExpected.layerFields) {
    expect(layers[field.layerIndex]!.id).toBe(field.layerId);
    expect(layers[field.layerIndex]![field.field]).toEqual(field.after);
    layers[field.layerIndex]![field.field] = structuredClone(field.before);
  }
  expect(semantic).toEqual(before);
  for (const field of currentDomainExpected.layerFields)
    layers[field.layerIndex]![field.field] = structuredClone(field.after);
  for (const row of currentDomainExpected.removedRows) semantic.files.splice(row.index, 0, structuredClone(row.row));
  expect(semantic).toEqual(current);
  const forward: Buffer[] = [];
  end = 0;
  const old = Buffer.from(historical);
  for (const span of currentDomainExpected.rawSpans) {
    expect(old.subarray(span.beforeOffset, span.beforeOffset + Buffer.byteLength(span.before)).toString()).toBe(
      span.before,
    );
    forward.push(old.subarray(end, span.beforeOffset), Buffer.from(span.after));
    end = span.beforeOffset + Buffer.byteLength(span.before);
  }
  forward.push(old.subarray(end));
  expect(Buffer.concat(forward)).toEqual(bytes);
  return historical;
}
/** Independent finite next-stage inverse; production never reads this test authority. */
function nextHistoricalRaw(raw: string): string {
  if (sha(raw) !== nextCurrentDomainExpected.current.source.sha256) return raw;
  const current = profile(raw, nextCurrentDomainExpected.current);
  const bytes = Buffer.from(raw),
    chunks: Buffer[] = [];
  let beforeEnd = 0,
    afterEnd = 0;
  for (const span of nextCurrentDomainExpected.rawSpans) {
    const before = Buffer.from(span.before),
      after = Buffer.from(span.after);
    expect(Number.isSafeInteger(span.beforeOffset)).toBe(true);
    expect(Number.isSafeInteger(span.afterOffset)).toBe(true);
    expect(span.beforeOffset).toBeGreaterThanOrEqual(beforeEnd);
    expect(span.afterOffset).toBeGreaterThanOrEqual(afterEnd);
    expect(span.beforeOffset - beforeEnd).toBe(span.afterOffset - afterEnd);
    expect(span.beforeOffset + before.length).toBeLessThanOrEqual(nextCurrentDomainExpected.before.source.bytes);
    expect(span.afterOffset + after.length).toBeLessThanOrEqual(bytes.length);
    expect(bytes.subarray(span.afterOffset, span.afterOffset + after.length)).toEqual(after);
    chunks.push(bytes.subarray(afterEnd, span.afterOffset), before);
    beforeEnd = span.beforeOffset + before.length;
    afterEnd = span.afterOffset + after.length;
  }
  chunks.push(bytes.subarray(afterEnd));
  const prior = Buffer.concat(chunks),
    previous = profile(prior.toString("utf8"), nextCurrentDomainExpected.before);
  const semantic = structuredClone(current);
  for (const row of nextCurrentDomainExpected.removedRows) {
    expect(semantic.files[row.index]).toEqual(row.row);
    expect(semantic.files[row.index - 1] ?? null).toEqual(row.previous);
    expect(semantic.files[row.index + 1] ?? null).toEqual(row.next);
  }
  for (const row of [...nextCurrentDomainExpected.removedRows].reverse()) semantic.files.splice(row.index, 1);
  expect(semantic).toEqual(previous);
  for (const row of nextCurrentDomainExpected.removedRows)
    semantic.files.splice(row.index, 0, structuredClone(row.row));
  expect(semantic).toEqual(current);
  const replay: Buffer[] = [];
  beforeEnd = 0;
  for (const span of nextCurrentDomainExpected.rawSpans) {
    const before = Buffer.from(span.before);
    expect(prior.subarray(span.beforeOffset, span.beforeOffset + before.length)).toEqual(before);
    replay.push(prior.subarray(beforeEnd, span.beforeOffset), Buffer.from(span.after));
    beforeEnd = span.beforeOffset + before.length;
  }
  replay.push(prior.subarray(beforeEnd));
  expect(Buffer.concat(replay)).toEqual(bytes);
  return prior.toString("utf8");
}

function historicalIndex(index: number): number {
  if (index === expected.current.fileCount) return nextCurrentDomainExpected.current.fileCount;
  let position = index;
  for (const row of currentDomainExpected.removedRows) if (row.index <= position) position++;
  return position;
}
function healthy() {
  pin("tests/helpers/ir-deno-post-position-main-successor.ts", helperPin);
  pin(receiptPath, receiptPin);
  const raw = read("scripts/compiler-boundaries.json"),
    current = profile(raw, nextCurrentDomainExpected.current);
  const main = independent(raw, "oldPosition"),
    deno = independent(raw, "oldDeno");
  independent(raw, "main6998");
  for (const [capture, target] of [
    [mainRaw, main],
    [denoRaw, deno],
  ] as const) {
    let reads = 0;
    expect(
      capture(raw, (p) => {
        expect(p).toBe(receiptPath);
        reads++;
        return read(p);
      }),
    ).toBe(target);
    expect(reads).toBe(1);
  }
  expect(mainData(current)).toEqual(JSON.parse(main));
  expect(denoData(current)).toEqual(JSON.parse(deno));
  return { raw, current, main, deno };
}
function freeze(value: unknown): void {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
}
describe("fixed post-position main and Deno predecessor routes", () => {
  // Let runner RPC replies progress between complete, restored synchronous cases.
  afterEach(async () => {
    await setImmediate();
  });

  it("independently proves all three complete inverses and replays", () => {
    healthy();
    expect(
      expected.projections.main46caf.removedRows.filter(
        (row) => row.index < 1872 && row.index !== 396 && row.index !== 1053 && row.index !== 1663 && row.index !== 751,
      ),
    ).toHaveLength(18);
    expect(expected.projections.main46caf.removedRows).toHaveLength(24);
    expect(
      expected.projections.oldPosition.removedRows.filter(
        (row) => row.index < 1872 && row.index !== 396 && row.index !== 1053 && row.index !== 1663 && row.index !== 751,
      ),
    ).toHaveLength(28);
    expect(expected.projections.oldPosition.removedRows).toHaveLength(34);
    expect(
      expected.projections.oldDeno.removedRows.filter(
        (row) => row.index < 1872 && row.index !== 396 && row.index !== 1053 && row.index !== 1663 && row.index !== 751,
      ),
    ).toHaveLength(12);
    expect(expected.projections.oldDeno.removedRows).toHaveLength(18);
  });
  it("detaches both semantic routes and preserves every frozen input byte", () => {
    const { current } = healthy();
    const retained = JSON.stringify(current);
    freeze(current);
    for (const capture of [mainData, denoData]) {
      const result = capture(current);
      expect(result).not.toBe(current);
      expect(result.files).not.toBe(current.files);
    }
    expect(JSON.stringify(current)).toBe(retained);
  });
  for (const route of ["main", "deno"] as const) {
    const rawCapture = route === "main" ? mainRaw : denoRaw,
      dataCapture = route === "main" ? mainData : denoData;
    it(`${route} refuses the exact stale previousCurrent profile as current`, () => {
      const { raw: fresh } = healthy();
      const raw = undo58d(
        undo0be(
          undo0be(former1868(fresh), current46Insertions, current1866Profile),
          current0beInsertions,
          current1864Profile,
        ),
        formerCurrentInsertion,
        formerCurrentProfile,
      );
      const bytes = Buffer.from(raw);
      const offset = previousCurrentInsertion.offset;
      const inserted = Buffer.from(previousCurrentInsertion.literal);
      expect(bytes.subarray(offset, offset + inserted.length)).toEqual(inserted);
      const stale = Buffer.concat([bytes.subarray(0, offset), bytes.subarray(offset + inserted.length)]).toString(
        "utf8",
      );
      profile(stale, previousCurrentProfile);
      expect(() => rawCapture(stale)).toThrow(/complete raw source profile mismatch/);
      expect(() => dataCapture(JSON.parse(stale))).toThrow(/complete policy profile mismatch/);
    });
    it(`${route} refuses the exact stale main431 profile as current`, () => {
      const { raw } = healthy();
      const main = independent(raw, "main6998");
      const bytes = Buffer.from(main);
      const offset = main431Insertion.offset;
      const inserted = Buffer.from(main431Insertion.literal);
      expect(bytes.subarray(offset, offset + inserted.length)).toEqual(inserted);
      const stale = Buffer.concat([bytes.subarray(0, offset), bytes.subarray(offset + inserted.length)]).toString(
        "utf8",
      );
      profile(stale, main431Profile);
      expect(() => rawCapture(stale)).toThrow(/complete raw source profile mismatch/);
      expect(() => dataCapture(JSON.parse(stale))).toThrow(/complete policy profile mismatch/);
    });
    it(`${route} refuses the exact stale formerCurrent1863 profile as current`, () => {
      const { raw } = healthy();
      const stale = undo58d(
        undo0be(
          undo0be(former1868(raw), current46Insertions, current1866Profile),
          current0beInsertions,
          current1864Profile,
        ),
        formerCurrentInsertion,
        formerCurrentProfile,
      );
      expect(() => rawCapture(stale)).toThrow(/complete raw source profile mismatch/);
      expect(() => dataCapture(JSON.parse(stale))).toThrow(/complete policy profile mismatch/);
    });
    for (const epoch of ["oldPosition", "oldDeno", "main6998", "main58d"] as const)
      it(`${route} refuses the exact stale ${epoch} profile as current`, () => {
        const { raw } = healthy(),
          stale = independent(raw, epoch);
        expect(() => rawCapture(stale)).toThrow(/complete raw source profile mismatch/);
        expect(() => dataCapture(JSON.parse(stale))).toThrow(/complete policy profile mismatch/);
      });
    it(`${route} refuses the exact stale formerCurrent1864 profile as current`, () => {
      const { raw } = healthy();
      const stale = undo0be(
        undo0be(former1868(raw), current46Insertions, current1866Profile),
        current0beInsertions,
        current1864Profile,
      );
      expect(() => rawCapture(stale)).toThrow(/complete raw source profile mismatch/);
      expect(() => dataCapture(JSON.parse(stale))).toThrow(/complete policy profile mismatch/);
    });
    it(`${route} accepts fresh current1866 after exact two-row insertion replay`, () => {
      const { raw, current } = healthy();
      const stale = undo0be(
        undo0be(former1868(raw), current46Insertions, current1866Profile),
        current0beInsertions,
        current1864Profile,
      );
      expect(
        Buffer.byteLength(undo0be(former1868(raw), current46Insertions, current1866Profile)) - Buffer.byteLength(stale),
      ).toBe(671);
      expect(rawCapture(raw)).toBe(independent(raw, route === "main" ? "oldPosition" : "oldDeno"));
      expect(dataCapture(current)).toEqual(JSON.parse(rawCapture(raw)));
    });
    it(`${route} refuses the exact stale formerCurrent1866 profile as current`, () => {
      const { raw } = healthy();
      const stale = undo0be(former1868(raw), current46Insertions, current1866Profile);
      expect(() => rawCapture(stale)).toThrow(/complete raw source profile mismatch/);
      expect(() => dataCapture(JSON.parse(stale))).toThrow(/complete policy profile mismatch/);
    });
    it(`${route} accepts fresh current1868 after exact two-row insertion replay`, () => {
      const { raw, current } = healthy();
      const stale = undo0be(former1868(raw), current46Insertions, current1866Profile);
      expect(Buffer.byteLength(former1868(raw)) - Buffer.byteLength(stale)).toBe(647);
      expect(rawCapture(raw)).toBe(independent(raw, route === "main" ? "oldPosition" : "oldDeno"));
      expect(dataCapture(current)).toEqual(JSON.parse(rawCapture(raw)));
    });
    it(`${route} accepts productive current1870 and reciprocally preserves the complete former1868 epoch`, () => {
      const { raw, current } = healthy();
      const checkpoint = checkpoint1870(raw);
      const previous = former1868(raw);
      const checkpointData = profile(checkpoint, checkpoint1870Profile);
      expect(Buffer.byteLength(checkpoint) - Buffer.byteLength(previous)).toBe(250);
      const before = profile(previous, former1868Profile);
      expect(checkpointData.files.slice(0, former1868Profile.fileCount)).toEqual(before.files);
      expect(checkpointData.files.slice(former1868Profile.fileCount)).toEqual(
        expected.projections.oldPosition.removedRows.slice(-2).map((row) => row.row),
      );
      expect(checkpointData.files).toHaveLength(1870);
      expect(Object.fromEntries(Object.entries(checkpointData).filter(([key]) => key !== "files"))).toEqual(
        Object.fromEntries(Object.entries(before).filter(([key]) => key !== "files")),
      );
      expect(rawCapture(raw)).toBe(independent(raw, route === "main" ? "oldPosition" : "oldDeno"));
      expect(dataCapture(current)).toEqual(JSON.parse(rawCapture(raw)));
    });
    it(`${route} refuses the exact stale formerCurrent1868 profile as current`, () => {
      const { raw } = healthy();
      const stale = former1868(raw);
      expect(() => rawCapture(stale)).toThrow(/complete raw source profile mismatch/);
      expect(() => dataCapture(JSON.parse(stale))).toThrow(/complete policy profile mismatch/);
      healthy();
    });
    it(`${route} refuses new-row accessors and hidden data without observation and restores healthy input`, () => {
      const { raw, current } = healthy();
      const original = JSON.stringify(current);
      for (const index of [1872, 1873]) {
        for (const kind of ["accessor", "hidden data"] as const) {
          const mutant = structuredClone(current);
          let touched = 0,
            reads = 0;
          const descriptor =
            kind === "accessor"
              ? {
                  enumerable: true,
                  get() {
                    touched++;
                    throw new Error("new-row getter observed");
                  },
                }
              : { value: "clean", enumerable: false };
          Object.defineProperty(mutant.files[historicalIndex(index)]!, "state", descriptor);
          expect(() =>
            dataCapture(mutant, (path) => {
              reads++;
              return read(path);
            }),
          ).toThrow(/accessor or hidden field/);
          expect(touched).toBe(0);
          expect(reads).toBe(0);
          expect(JSON.stringify(current)).toBe(original);
          expect(dataCapture(current)).toEqual(JSON.parse(rawCapture(raw)));
        }
      }
      healthy();
    });
    it(`${route} accepts productive current1872 with complete prior1871 and checkpoint1870 inverse/replay`, () => {
      const { raw, current } = healthy();
      const previous = former1872(raw),
        previousData = profile(previous, former1872Profile),
        checkpoint = checkpoint1870(raw),
        prior = prior1871(raw);
      expect(Buffer.byteLength(previous) - Buffer.byteLength(checkpoint)).toBe(675);
      expect(Buffer.byteLength(previous) - Buffer.byteLength(prior)).toBe(343);
      const checkpointData = profile(checkpoint, checkpoint1870Profile),
        priorData = profile(prior, prior1871Profile);
      const incomingMain = undo0be(previous, currentRemainderInsertions, upstream1870Profile);
      const base = former1868(raw);
      expect(undo0be(incomingMain, incomingInsertions, former1868Profile)).toBe(base);
      expect(checkpointData.files).toEqual(previousData.files.filter((_, index) => index !== 396 && index !== 1052));
      expect(priorData.files).toEqual(previousData.files.filter((_, index) => index !== 396));
      expect(rawCapture(raw)).toBe(independent(raw, route === "main" ? "oldPosition" : "oldDeno"));
      expect(dataCapture(current)).toEqual(JSON.parse(rawCapture(raw)));
    });
    for (const [epoch, derive] of [
      ["checkpoint1870", checkpoint1870],
      ["prior1871", prior1871],
    ] as const)
      it(`${route} refuses exact stale ${epoch} incoming predecessor as current`, () => {
        const { raw } = healthy();
        const stale = derive(raw);
        expect(() => rawCapture(stale)).toThrow(/complete raw source profile mismatch/);
        expect(() => dataCapture(JSON.parse(stale))).toThrow(/complete policy profile mismatch/);
        healthy();
      });
    it(`${route} refuses both incoming-row accessors and hidden data with zero observation and healthy restoration`, () => {
      const { raw, current } = healthy();
      const original = JSON.stringify(current);
      for (const index of [396, 1053])
        for (const kind of ["accessor", "hidden data"] as const) {
          const mutant = structuredClone(current);
          let touched = 0,
            reads = 0;
          Object.defineProperty(
            mutant.files[index]!,
            "state",
            kind === "accessor"
              ? {
                  enumerable: true,
                  get() {
                    touched++;
                    throw new Error("incoming getter observed");
                  },
                }
              : { value: "unmigrated", enumerable: false },
          );
          expect(() =>
            dataCapture(mutant, (path) => {
              reads++;
              return read(path);
            }),
          ).toThrow(/accessor or hidden field/);
          expect(touched).toBe(0);
          expect(reads).toBe(0);
          expect(JSON.stringify(current)).toBe(original);
          expect(dataCapture(current)).toEqual(JSON.parse(rawCapture(raw)));
        }
      healthy();
    });
    it(`${route} accepts productive current1873 with complete former1872 inverse/replay and commuting remainder append`, () => {
      const { raw, current } = healthy();
      const previousCurrent = former1873(raw),
        previousCurrentData = profile(previousCurrent, former1873Profile),
        previous = former1872(raw),
        before = profile(previous, former1872Profile);
      expect(Buffer.byteLength(previousCurrent) - Buffer.byteLength(previous)).toBe(332);
      expect(previousCurrentData.files.filter((_, index) => index !== 1662)).toEqual(before.files);
      expect(
        Object.fromEntries(
          Object.entries(profile(historicalRaw(raw), expected.current)).filter(([key]) => key !== "files"),
        ),
      ).toEqual(Object.fromEntries(Object.entries(before).filter(([key]) => key !== "files")));
      const upstream = undo0be(previousCurrent, fccRemainderInsertions, fccMain1871Profile);
      expect(undo0be(upstream, fccInsertions, upstream1870Profile)).toBe(
        undo0be(previous, currentRemainderInsertions, upstream1870Profile),
      );
      expect(rawCapture(raw)).toBe(independent(raw, route === "main" ? "oldPosition" : "oldDeno"));
      expect(dataCapture(current)).toEqual(JSON.parse(rawCapture(raw)));
      healthy();
    });
    it(`${route} refuses exact stale former1872 as current and restores healthy current1873`, () => {
      const { raw } = healthy();
      const stale = former1872(raw);
      expect(() => rawCapture(stale)).toThrow(/complete raw source profile mismatch/);
      expect(() => dataCapture(JSON.parse(stale))).toThrow(/complete policy profile mismatch/);
      healthy();
    });
    it(`${route} refuses f087 incoming-row accessors and hidden data with zero observation and healthy restoration`, () => {
      const { raw, current } = healthy();
      const original = JSON.stringify(current);
      for (const kind of ["accessor", "hidden data"] as const) {
        const mutant = structuredClone(current);
        let touched = 0,
          reads = 0;
        Object.defineProperty(
          mutant.files[historicalIndex(1663)]!,
          "state",
          kind === "accessor"
            ? {
                enumerable: true,
                get() {
                  touched++;
                  throw new Error("f087 row getter observed");
                },
              }
            : { value: "unmigrated", enumerable: false },
        );
        expect(() =>
          dataCapture(mutant, (path) => {
            reads++;
            return read(path);
          }),
        ).toThrow(/accessor or hidden field/);
        expect(touched).toBe(0);
        expect(reads).toBe(0);
        expect(JSON.stringify(current)).toBe(original);
        expect(dataCapture(current)).toEqual(JSON.parse(rawCapture(raw)));
      }
      healthy();
    });
    it(`${route} accepts productive current1874 with exact former1873 inverse/replay, split old333 span and commuting remainder append`, () => {
      const { raw, current } = healthy();
      const previous = former1873(raw),
        before = profile(previous, former1873Profile);
      const historical = historicalRaw(raw);
      expect(Buffer.byteLength(historical) - Buffer.byteLength(previous)).toBe(383);
      expect(profile(historical, expected.current).files.filter((_, index) => index !== 751)).toEqual(before.files);
      expect(
        Object.fromEntries(
          Object.entries(profile(historicalRaw(raw), expected.current)).filter(([key]) => key !== "files"),
        ),
      ).toEqual(Object.fromEntries(Object.entries(before).filter(([key]) => key !== "files")));
      const upstream = undo0be(historical, e24RemainderInsertions, e24Main1872Profile);
      expect(undo0be(upstream, e24Insertions, fccMain1871Profile)).toBe(
        undo0be(previous, fccRemainderInsertions, fccMain1871Profile),
      );
      const prefix = expected.projections.oldPosition.rawSpans.find((span) => span.afterOffset === 288291)!,
        suffix = expected.projections.oldPosition.rawSpans.find((span) => span.afterOffset === 288939)!;
      expect(Buffer.byteLength(prefix.after)).toBe(265);
      expect(Buffer.byteLength(suffix.after)).toBe(68);
      expect(prefix.after + suffix.after).toBe(e24FactoredOldSpan.after);
      expect(
        Buffer.from(previous)
          .subarray(e24FactoredOldSpan.afterOffset, e24FactoredOldSpan.afterOffset + 333)
          .toString(),
      ).toBe(e24FactoredOldSpan.after);
      expect(rawCapture(raw)).toBe(independent(raw, route === "main" ? "oldPosition" : "oldDeno"));
      expect(dataCapture(current)).toEqual(JSON.parse(rawCapture(raw)));
      healthy();
    });
    it(`${route} refuses exact stale former1873 as current and restores healthy current1874`, () => {
      const { raw } = healthy();
      const stale = former1873(raw);
      expect(() => rawCapture(stale)).toThrow(/complete raw source profile mismatch/);
      expect(() => dataCapture(JSON.parse(stale))).toThrow(/complete policy profile mismatch/);
      healthy();
    });
    it(`${route} refuses e24 incoming-row accessors and hidden data with zero observation and healthy restoration`, () => {
      const { raw, current } = healthy();
      const original = JSON.stringify(current);
      for (const kind of ["accessor", "hidden data"] as const) {
        const mutant = structuredClone(current);
        let touched = 0,
          reads = 0;
        Object.defineProperty(
          mutant.files[historicalIndex(751)]!,
          "state",
          kind === "accessor"
            ? {
                enumerable: true,
                get() {
                  touched++;
                  throw new Error("e24 row getter observed");
                },
              }
            : { value: "unmigrated", enumerable: false },
        );
        expect(() =>
          dataCapture(mutant, (path) => {
            reads++;
            return read(path);
          }),
        ).toThrow(/accessor or hidden field/);
        expect(touched).toBe(0);
        expect(reads).toBe(0);
        expect(JSON.stringify(current)).toBe(original);
        expect(dataCapture(current)).toEqual(JSON.parse(rawCapture(raw)));
      }
      healthy();
    });
    it(`${route} refuses the exact stale main1850 profile as current`, () => {
      const { raw } = healthy();
      const stale = independent(raw, "main46caf");
      expect(() => rawCapture(stale)).toThrow(/complete raw source profile mismatch/);
      expect(() => dataCapture(JSON.parse(stale))).toThrow(/complete policy profile mismatch/);
    });
    for (const kind of ["duplicate", "missing", "reordered", "foreign", "non-files", "ordered keys"] as const)
      it(`${route} refuses complete semantic ${kind} drift`, () => {
        const { current } = healthy();
        const mutant = structuredClone(current);
        if (kind === "duplicate") mutant.files.push({ ...mutant.files[0] });
        if (kind === "missing") mutant.files.pop();
        if (kind === "reordered") [mutant.files[0], mutant.files[1]] = [mutant.files[1]!, mutant.files[0]!];
        if (kind === "foreign") mutant.files[0]!.path = "src/foreign.ts";
        if (kind === "non-files") mutant.description = "foreign";
        const input = kind === "ordered keys" ? Object.fromEntries(Object.entries(mutant).reverse()) : mutant;
        expect(() => dataCapture(input)).toThrow(/complete policy profile mismatch/);
        expect(() => rawCapture(JSON.stringify(input))).toThrow(/complete raw source profile mismatch/);
      });
    for (const projection of ["oldPosition", "oldDeno"] as const)
      for (const row of expected.projections[projection].removedRows)
        for (const location of ["row", "previous", "next"] as const)
          it(`${route} refuses ${projection} ${originalIndices[row.row.path as keyof typeof originalIndices] ?? (row.row.path === "src/codegen/object-model/extern-get-object-key.ts" ? "f087-1662" : row.index)} ${location} profile drift`, () => {
            const { raw, current } = healthy(),
              mutant = structuredClone(current),
              index = historicalIndex(row.index + (location === "previous" ? -1 : location === "next" ? 1 : 0));
            if (index === mutant.files.length) {
              expect(location).toBe("next");
              expect(row.index).toBe(expected.current.fileCount - 1);
              expect(row.next).toBeUndefined();
              mutant.files.push({ path: "src/foreign-boundary.ts", state: "foreign", layer: "ir-runtime" });
            } else mutant.files[index]!.state = "foreign";
            expect(() => dataCapture(mutant)).toThrow(/complete policy profile mismatch/);
            if (
              row.row.path === "src/codegen/object-model/extern-get-object-key.ts" ||
              row.row.path === "src/codegen/object-model/native-proto-reparent.ts"
            ) {
              expect(dataCapture(current)).toEqual(JSON.parse(rawCapture(raw)));
              healthy();
            }
          });
    for (const kind of ["whitespace", "span"] as const)
      it(`${route} refuses raw ${kind} drift`, () => {
        const { raw } = healthy();
        const offset = expected.projections.oldPosition.rawSpans[0]!.afterOffset;
        const mutant =
          kind === "whitespace"
            ? raw + "\n"
            : raw.slice(0, offset) + (raw[offset] === " " ? "*" : " ") + raw.slice(offset + 1);
        expect(() => rawCapture(mutant)).toThrow(/complete raw source profile mismatch/);
      });
    for (const kind of [
      "getter",
      "coercion",
      "hole",
      "boxed",
      "nonplain",
      "symbol",
      "hidden",
      "hidden index",
      "cycle",
    ] as const)
      it(`${route} refuses malicious ${kind} without observation`, () => {
        const { raw, current } = healthy();
        let touched = 0;
        const mutant: any = structuredClone(current);
        if (kind === "getter")
          Object.defineProperty(mutant, "files", {
            get() {
              touched++;
              throw new Error("getter");
            },
            enumerable: true,
          });
        if (kind === "coercion")
          mutant.files[0].state = {
            toString() {
              touched++;
              return "clean";
            },
          };
        if (kind === "hole") Reflect.deleteProperty(mutant.files, "1");
        if (kind === "boxed") mutant.files[0].state = new String("clean");
        if (kind === "nonplain") Object.setPrototypeOf(mutant, Date.prototype);
        if (kind === "symbol") mutant[Symbol("foreign")] = true;
        if (kind === "hidden") Object.defineProperty(mutant, "hidden", { value: true });
        if (kind === "hidden index")
          Object.defineProperty(mutant.files, "1", { value: mutant.files[1], enumerable: false });
        if (kind === "cycle") mutant.cycle = mutant;
        let reads = 0;
        expect(() =>
          dataCapture(mutant, (p) => {
            reads++;
            return read(p);
          }),
        ).toThrow();
        expect(touched).toBe(0);
        expect(reads).toBe(0);
        if (kind === "boxed") {
          expect(() =>
            rawCapture(new String(raw) as never, (p) => {
              reads++;
              return read(p);
            }),
          ).toThrow(/primitive string/);
          expect(reads).toBe(0);
        }
      });
    for (const kind of ["wrong path", "missing", "corrupt", "span", "nonprimitive", "absent"] as const)
      it(`${route} authenticates ${kind} receipt afresh after warm capture`, () => {
        const { raw } = healthy();
        let reads = 0;
        const good = read(receiptPath);
        expect(rawCapture(raw)).toBe(route === "main" ? independent(raw, "oldPosition") : independent(raw, "oldDeno"));
        const reader = (p: string): string => {
          reads++;
          if (kind === "wrong path") return read("tests/helpers/ir-position-finally-main-successor.json");
          if (kind === "missing") throw new Error("missing");
          if (kind === "corrupt") return good + "\n";
          if (kind === "nonprimitive") return new String(good) as never;
          if (kind === "span") {
            const receipt = JSON.parse(good);
            receipt.mainPredecessor.rawSpans[0].afterOffset++;
            return JSON.stringify(receipt);
          }
          return good;
        };
        expect(() => rawCapture(raw, kind === "absent" ? (null as never) : reader)).toThrow();
        expect(reads).toBe(kind === "absent" ? 0 : 1);
        healthy();
      });
    for (const kind of ["missing", "corrupt"] as const)
      it(`${route} refuses physically ${kind} receipt after warm capture and restores exact original`, () => {
        const { raw } = healthy();
        const path = resolve(root, receiptPath),
          original = readFileSync(path);
        mkdirSync(resolve(root, ".tmp"), { recursive: true });
        const dir = mkdtempSync(resolve(root, ".tmp", "post-position-receipt-")),
          backup = resolve(dir, "receipt.json");
        try {
          if (kind === "missing") renameSync(path, backup);
          else writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
          expect(() => rawCapture(raw)).toThrow();
          expect(() => dataCapture(JSON.parse(raw))).toThrow();
        } finally {
          if (existsSync(backup)) renameSync(backup, path);
          else writeFileSync(path, original);
          expect(readFileSync(path)).toEqual(original);
          rmSync(dir, { recursive: true, force: true });
        }
        healthy();
      });
    it(`${route} faults actual current policy after warm capture and restores exact original bytes`, () => {
      const { raw } = healthy();
      const path = resolve(root, "scripts/compiler-boundaries.json"),
        original = readFileSync(path);
      try {
        writeFileSync(path, original + "\n");
        expect(() => rawCapture(read("scripts/compiler-boundaries.json"))).toThrow(
          /complete raw source profile mismatch/,
        );
        const mutant = JSON.parse(raw) as Policy;
        mutant.files[0]!.state = "foreign";
        writeFileSync(path, JSON.stringify(mutant));
        expect(() => dataCapture(JSON.parse(read("scripts/compiler-boundaries.json")))).toThrow(
          /complete policy profile mismatch/,
        );
      } finally {
        writeFileSync(path, original);
        expect(readFileSync(path)).toEqual(original);
      }
      healthy();
    });
  }
});

describe("fixed native 1997-row outer domain", () => {
  afterEach(async () => {
    await setImmediate();
  });
  it("independently authenticates all 123 rows, nine layer fields, 39 raw spans and four unchanged predecessor routes", () => {
    const { raw, current, main, deno } = healthy();
    expect(currentDomainExpected.removedRows).toHaveLength(123);
    expect(currentDomainExpected.layerFields).toHaveLength(9);
    expect(currentDomainExpected.rawSpans).toHaveLength(39);
    expect(historicalRaw(raw)).toHaveLength(expected.current.source.bytes);
    const receipt = JSON.parse(read(receiptPath));
    expect(receipt.currentDomain).toEqual(currentDomainExpected);
    const { currentDomain: _outer, nextCurrentDomain: _next, ...historical } = receipt;
    const oldReceipt = JSON.stringify(historical, null, 2) + "\n";
    expect(Buffer.byteLength(oldReceipt)).toBe(116203);
    expect(sha(oldReceipt)).toBe("c5cc132cfb850bf29da5da8932312547df04a1faa4af60385131550d520c0248");
    expect(mainData(current)).toEqual(JSON.parse(main));
    expect(denoData(current)).toEqual(JSON.parse(deno));
  });
  for (const added of currentDomainExpected.removedRows)
    it(`refuses inserted current-domain row ${added.row.path} mutations and restores all four routes`, () => {
      const raw = read("scripts/compiler-boundaries.json"),
        current = JSON.parse(raw) as Policy;
      for (const kind of ["changed", "missing", "duplicate", "reordered"] as const) {
        const mutant = structuredClone(current);
        if (kind === "changed") mutant.files[added.index]!.state = "foreign";
        if (kind === "missing") mutant.files.splice(added.index, 1);
        if (kind === "duplicate") mutant.files.splice(added.index, 0, { ...mutant.files[added.index] });
        if (kind === "reordered")
          [mutant.files[added.index], mutant.files[added.index - 1]] = [
            mutant.files[added.index - 1]!,
            mutant.files[added.index]!,
          ];
        for (const capture of [mainData, denoData])
          expect(() => capture(mutant)).toThrow(/complete policy profile mismatch/);
        for (const capture of [mainRaw, denoRaw])
          expect(() => capture(JSON.stringify(mutant))).toThrow(/complete raw source profile mismatch/);
      }
      expect(mainData(current)).toEqual(JSON.parse(mainRaw(raw)));
      expect(denoData(current)).toEqual(JSON.parse(denoRaw(raw)));
    });
  for (const field of currentDomainExpected.layerFields)
    it(`refuses finite layer ${field.layerId}.${field.field} mutations with exact restored forward/inverse`, () => {
      const raw = read("scripts/compiler-boundaries.json"),
        current = JSON.parse(raw) as Policy;
      for (const kind of ["wrong", "missing", "extra-field", "layer-id", "reordered"] as const) {
        const mutant = structuredClone(current),
          layers = mutant.layers as Record<string, unknown>[];
        const layer = layers[field.layerIndex]!;
        if (kind === "wrong")
          layer[field.field] = typeof field.after === "number" ? field.after + 1 : [...field.after].reverse();
        if (kind === "missing") delete layer[field.field];
        if (kind === "extra-field") layer.foreign = true;
        if (kind === "layer-id") layer.id = "foreign";
        if (kind === "reordered")
          [layers[field.layerIndex], layers[(field.layerIndex + 1) % layers.length]] = [
            layers[(field.layerIndex + 1) % layers.length]!,
            layer,
          ];
        for (const capture of [mainData, denoData])
          expect(() => capture(mutant)).toThrow(/complete policy profile mismatch/);
        for (const capture of [mainRaw, denoRaw])
          expect(() => capture(JSON.stringify(mutant))).toThrow(/complete raw source profile mismatch/);
      }
      expect(mainData(current)).toEqual(JSON.parse(mainRaw(raw)));
      expect(denoData(current)).toEqual(JSON.parse(denoRaw(raw)));
    });
  it("rejects the preserved 1874 endpoint as current without inferring approval from warm captures", () => {
    const raw = read("scripts/compiler-boundaries.json"),
      old = historicalRaw(raw);
    for (const capture of [mainRaw, denoRaw]) {
      expect(capture(raw)).toBeTypeOf("string");
      expect(() => capture(old)).toThrow(/complete raw source profile mismatch/);
      expect(capture(raw)).toBeTypeOf("string");
    }
    for (const capture of [mainData, denoData])
      expect(() => capture(JSON.parse(old))).toThrow(/complete policy profile mismatch/);
  });
  it("requires unchanged current-domain authority after warm success and checks every finite span independently", () => {
    const raw = read("scripts/compiler-boundaries.json"),
      good = read(receiptPath);
    for (const capture of [mainRaw, denoRaw]) {
      expect(capture(raw)).toBeTypeOf("string");
      for (const [index] of currentDomainExpected.rawSpans.entries()) {
        const receipt = JSON.parse(good);
        receipt.currentDomain.rawSpans[index].afterOffset++;
        let reads = 0;
        expect(() =>
          capture(raw, () => {
            reads++;
            return JSON.stringify(receipt);
          }),
        ).toThrow(/fixed current-domain receipt pin mismatch/);
        expect(reads).toBe(1);
      }
      for (const field of currentDomainExpected.layerFields) {
        const receipt = JSON.parse(good);
        const actual = receipt.currentDomain.layerFields.find(
          (row: { layerId: string; field: string }) => row.layerId === field.layerId && row.field === field.field,
        );
        actual.before = actual.after;
        expect(() => capture(raw, () => JSON.stringify(receipt))).toThrow(/fixed current-domain receipt pin mismatch/);
      }
      expect(capture(raw)).toBeTypeOf("string");
    }
  });
  it("refuses finite layer accessors, holes and symbols before authority IO without observing hostile values", () => {
    const raw = read("scripts/compiler-boundaries.json"),
      current = JSON.parse(raw) as Policy;
    for (const kind of ["getter", "hole", "symbol", "hidden", "cycle"] as const) {
      const mutant = structuredClone(current),
        layers = mutant.layers as Record<string, unknown>[];
      let touched = 0,
        reads = 0;
      if (kind === "getter")
        Object.defineProperty(layers[0]!, "entries", {
          enumerable: true,
          get() {
            touched++;
            throw Error("observed hostile layer");
          },
        });
      if (kind === "hole") Reflect.deleteProperty(layers, "0");
      if (kind === "symbol") Reflect.set(layers[0]!, Symbol("foreign"), 1);
      if (kind === "hidden") Object.defineProperty(layers[0]!, "foreign", { value: 1, enumerable: false });
      if (kind === "cycle") layers[0]!.foreign = mutant;
      for (const capture of [mainData, denoData])
        expect(() =>
          capture(mutant, () => {
            reads++;
            return read(receiptPath);
          }),
        ).toThrow();
      expect(touched).toBe(0);
      expect(reads).toBe(0);
      expect(JSON.parse(raw)).toEqual(current);
    }
  });
});

describe("fixed native 2001-row next outer domain", () => {
  afterEach(async () => {
    await setImmediate();
  });
  it("authenticates actual four-route source and complete four-row inverse while preserving every prior authority", () => {
    const { raw, current, main, deno } = healthy();
    const previous = nextHistoricalRaw(raw);
    profile(previous, currentDomainExpected.current);
    expect(nextCurrentDomainExpected.removedRows).toHaveLength(4);
    expect(nextCurrentDomainExpected.layerFields).toHaveLength(0);
    expect(nextCurrentDomainExpected.rawSpans).toHaveLength(1);
    expect(historicalIndex(expected.current.fileCount)).toBe(2001);
    expect(JSON.parse(previous).files).toHaveLength(1997);
    const receipt = JSON.parse(read(receiptPath));
    expect(receipt.nextCurrentDomain).toEqual(nextCurrentDomainExpected);
    const { nextCurrentDomain: _next, ...prior } = receipt;
    const priorText = JSON.stringify(prior, null, 2) + "\n";
    expect(Buffer.byteLength(priorText)).toBe(previousReceiptPin.bytes);
    expect(sha(priorText)).toBe(previousReceiptPin.sha256);
    expect(mainData(current)).toEqual(JSON.parse(main));
    expect(denoData(current)).toEqual(JSON.parse(deno));
    for (const capture of [mainData, denoData]) {
      let reads = 0;
      expect(
        capture(current, (p) => {
          expect(p).toBe(receiptPath);
          reads++;
          return read(p);
        }),
      ).toEqual(JSON.parse(capture === mainData ? main : deno));
      expect(reads).toBe(1);
    }
  });
  for (const added of nextCurrentDomainExpected.removedRows)
    it(`refuses next-domain row ${added.row.path} mutations and restores all four routes`, () => {
      const { raw, current, main, deno } = healthy();
      const retained = JSON.stringify(current);
      for (const kind of ["changed", "missing", "duplicate", "reordered", "neighbor", "extra"] as const) {
        const mutant = structuredClone(current);
        if (kind === "changed") mutant.files[added.index]!.state = "foreign";
        if (kind === "missing") mutant.files.splice(added.index, 1);
        if (kind === "duplicate") mutant.files.splice(added.index, 0, { ...mutant.files[added.index] });
        if (kind === "reordered")
          [mutant.files[added.index], mutant.files[added.index - 1]] = [
            mutant.files[added.index - 1]!,
            mutant.files[added.index]!,
          ];
        if (kind === "neighbor") mutant.files[added.index - 1]!.owner = "foreign";
        if (kind === "extra")
          mutant.files.push({ path: "src/unknown-next-domain.ts", state: "clean", layer: "ir-core" });
        for (const capture of [mainData, denoData])
          expect(() => capture(mutant)).toThrow(/complete policy profile mismatch/);
        for (const capture of [mainRaw, denoRaw])
          expect(() => capture(JSON.stringify(mutant))).toThrow(/complete raw source profile mismatch/);
      }
      expect(JSON.stringify(current)).toBe(retained);
      expect(mainRaw(raw)).toBe(main);
      expect(denoRaw(raw)).toBe(deno);
      expect(mainData(current)).toEqual(JSON.parse(main));
      expect(denoData(current)).toEqual(JSON.parse(deno));
    });
  for (const epoch of ["checkpoint1997", "class2000"] as const)
    it(`rejects authentic ${epoch} as current and restores genuine next input`, () => {
      const { raw } = healthy();
      let old = nextHistoricalRaw(raw);
      if (epoch === "class2000") {
        const span = nextCurrentDomainExpected.rawSpans[0];
        old = Buffer.concat([
          Buffer.from(old).subarray(0, span.beforeOffset),
          Buffer.from(classOnlyInsertion),
          Buffer.from(old).subarray(span.beforeOffset),
        ]).toString("utf8");
        profile(old, classOnlyProfile);
      } else profile(old, currentDomainExpected.current);
      for (const capture of [mainRaw, denoRaw]) {
        expect(() => capture(old)).toThrow(/complete raw source profile mismatch/);
        expect(capture(raw)).toBeTypeOf("string");
      }
      for (const capture of [mainData, denoData])
        expect(() => capture(JSON.parse(old))).toThrow(/complete policy profile mismatch/);
    });
  it("refuses changed next raw bytes, whitespace, truncation and unknown append without changing current source", () => {
    const { raw } = healthy(),
      offset = nextCurrentDomainExpected.rawSpans[0].afterOffset;
    for (const mutant of [
      raw + "\n",
      raw.slice(0, -1),
      raw.slice(0, offset) + " " + raw.slice(offset),
      raw.slice(0, offset + 8) + "x" + raw.slice(offset + 9),
      " " + raw,
    ])
      for (const capture of [mainRaw, denoRaw])
        expect(() => capture(mutant)).toThrow(/complete raw source profile mismatch/);
    healthy();
  });
  it("refuses changed next and preserved receipt authority afresh after warm success", () => {
    const { raw, current } = healthy(),
      good = read(receiptPath);
    for (const target of ["next-offset", "next-row", "next-before", "old-offset", "old-row", "old-layer"] as const) {
      const receipt = JSON.parse(good);
      if (target === "next-offset") receipt.nextCurrentDomain.rawSpans[0].afterOffset++;
      if (target === "next-row") receipt.nextCurrentDomain.removedRows[0].row.owner = "foreign";
      if (target === "next-before") receipt.nextCurrentDomain.before.source.sha256 = "foreign";
      if (target === "old-offset") receipt.currentDomain.rawSpans[0].afterOffset++;
      if (target === "old-row") receipt.currentDomain.removedRows[0].row.owner = "foreign";
      if (target === "old-layer") receipt.currentDomain.layerFields[0].before = "foreign";
      const mutant = JSON.stringify(receipt);
      for (const capture of [mainRaw, denoRaw]) {
        expect(capture(raw)).toBeTypeOf("string");
        let reads = 0;
        expect(() =>
          capture(raw, (p) => {
            expect(p).toBe(receiptPath);
            reads++;
            return mutant;
          }),
        ).toThrow(/fixed current-domain receipt pin mismatch/);
        expect(reads).toBe(1);
      }
      for (const capture of [mainData, denoData]) {
        let reads = 0;
        expect(() =>
          capture(current, () => {
            reads++;
            return mutant;
          }),
        ).toThrow(/fixed current-domain receipt pin mismatch/);
        expect(reads).toBe(1);
      }
    }
    healthy();
  });
  it("refuses next-row getters, hidden fields, symbols, holes and cycles before authority IO without observation", () => {
    const { current } = healthy();
    const index = nextCurrentDomainExpected.removedRows[0].index;
    for (const kind of ["getter", "hidden", "symbol", "hole", "cycle"] as const) {
      const mutant = structuredClone(current);
      let touched = 0,
        reads = 0;
      if (kind === "getter")
        Object.defineProperty(mutant.files[index]!, "owner", {
          enumerable: true,
          get() {
            touched++;
            throw new Error("hostile");
          },
        });
      if (kind === "hidden") Object.defineProperty(mutant.files[index]!, "foreign", { value: true });
      if (kind === "symbol") Object.defineProperty(mutant.files[index]!, Symbol("foreign"), { value: true });
      if (kind === "hole") Reflect.deleteProperty(mutant.files, String(index));
      if (kind === "cycle") mutant.files[index]!.cycle = mutant;
      const before = Object.getOwnPropertyDescriptors(mutant.files[index] ?? mutant.files);
      for (const capture of [mainData, denoData])
        expect(() =>
          capture(mutant, () => {
            reads++;
            return read(receiptPath);
          }),
        ).toThrow();
      expect(touched).toBe(0);
      expect(reads).toBe(0);
      expect(Object.getOwnPropertyDescriptors(mutant.files[index] ?? mutant.files)).toEqual(before);
    }
    healthy();
  });
});
