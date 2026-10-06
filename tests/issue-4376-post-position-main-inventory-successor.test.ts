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
  bytes: 91468,
  sha256: "5cefcbd527eb150994271f851e175a8c9456cc7f4561af478f43bebc29626d38",
};
const receiptPin = {
  bytes: 84983,
  sha256: "40022f15e77df3a987d448b04cd53dcdba95dee3c50b809314e66202a80fca4a",
};
const expected = {
  current: {
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
    main0be: {
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
          index: 710,
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
          index: 712,
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
          index: 843,
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
          index: 880,
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
          index: 945,
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
          index: 961,
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
          index: 1504,
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
          index: 1528,
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
          index: 1664,
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
          index: 1665,
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
          index: 1796,
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
          beforeOffset: 273448,
          afterOffset: 275249,
          before: "",
          after:
            '      "path": "src/codegen/object-model/linked-realm-property-read.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate linked-realm late-import reservation and context-owned function filling from its native read body."\n    },\n    {\n',
        },
        {
          beforeOffset: 273741,
          afterOffset: 275898,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/array/live-array-iterator-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate codegen-context iterator kind and layout selection from the receiver-backed native iterator value body."\n',
        },
        {
          beforeOffset: 315693,
          afterOffset: 318203,
          before: "",
          after:
            '      "path": "src/codegen/closures/ordinary-new-target.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST lexical-target detection and context/local/global registration from ordinary construction target frame instructions."\n    },\n    {\n',
        },
        {
          beforeOffset: 327597,
          afterOffset: 330474,
          before: "",
          after:
            '      "path": "src/codegen/registry/promise-handler-boundary.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned Promise handling boundary export and physical function registration from native handling instructions."\n    },\n    {\n',
        },
        {
          beforeOffset: 334778,
          afterOffset: 338023,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/closures/promoted-capture-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound promoted capture lookup and ref-cell type selection from native capture-value instructions."\n',
        },
        {
          beforeOffset: 348197,
          afterOffset: 351797,
          before: "",
          after:
            '      "path": "src/codegen/closures/rest-only-apply.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate closure/context dispatch, receiver state and exception registration from full-vector rest-call bodies."\n    },\n    {\n',
        },
        {
          beforeOffset: 352962,
          afterOffset: 356907,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/declarations/shared-script-var-access.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned Script binding/global-environment registration and final instruction rewriting from explicit native binding resources."\n',
        },
        {
          beforeOffset: 512884,
          afterOffset: 517217,
          before: "",
          after:
            '      "path": "src/runtime/wasmgc/promise/resolving-pair-bodies.ts",\n      "state": "clean",\n      "layer": "native-runtime"\n    },\n    {\n',
        },
        {
          beforeOffset: 518096,
          afterOffset: 522567,
          before: "",
          after:
            '      "state": "clean",\n      "layer": "wasm-physical"\n    },\n    {\n      "path": "src/wasm/physical/allocation-owner.ts",\n',
        },
        {
          beforeOffset: 543229,
          afterOffset: 547823,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/registry/microtask-drain-boundary.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate scheduler-context and physical export registration from the canonical native microtask drain body."\n    },\n    {\n      "path": "src/codegen/registry/microtask-notification.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned late notification import and index shifting from native scheduling instructions."\n',
        },
        {
          beforeOffset: 581560,
          afterOffset: 586848,
          before: "",
          after:
            '      "path": "src/codegen/registry/promise-rejection-dispatch.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Place context-dependent rejection dispatcher resolution and import/defined-function identity checks behind explicit backend resources."\n    },\n    {\n',
        },
      ],
      fullSemanticAndRawTargetExact: true,
    },
    oldPosition: {
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
          index: 710,
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
          index: 712,
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
          index: 843,
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
          index: 880,
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
          index: 899,
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
          index: 900,
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
          index: 902,
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
          index: 945,
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
          index: 961,
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
          index: 1061,
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
          index: 1504,
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
          index: 1528,
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
          index: 1657,
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
            path: "src/codegen/builtin-subclass-receiver.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1664,
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
          index: 1665,
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
          index: 1785,
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
          index: 1786,
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
          index: 1787,
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
          index: 1796,
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
          beforeOffset: 273122,
          afterOffset: 275249,
          before: "",
          after:
            '      "path": "src/codegen/object-model/linked-realm-property-read.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate linked-realm late-import reservation and context-owned function filling from its native read body."\n    },\n    {\n',
        },
        {
          beforeOffset: 273415,
          afterOffset: 275898,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/array/live-array-iterator-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate codegen-context iterator kind and layout selection from the receiver-backed native iterator value body."\n',
        },
        {
          beforeOffset: 315367,
          afterOffset: 318203,
          before: "",
          after:
            '      "path": "src/codegen/closures/ordinary-new-target.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST lexical-target detection and context/local/global registration from ordinary construction target frame instructions."\n    },\n    {\n',
        },
        {
          beforeOffset: 327271,
          afterOffset: 330474,
          before: "",
          after:
            '      "path": "src/codegen/registry/promise-handler-boundary.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned Promise handling boundary export and physical function registration from native handling instructions."\n    },\n    {\n',
        },
        {
          beforeOffset: 333472,
          afterOffset: 337043,
          before: "",
          after:
            '      "path": "src/codegen/object-model/proxy-forward-carriers.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/object-model/module-namespace-exotic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 333785,
          afterOffset: 338023,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/closures/promoted-capture-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound promoted capture lookup and ref-cell type selection from native capture-value instructions."\n',
        },
        {
          beforeOffset: 347204,
          afterOffset: 351797,
          before: "",
          after:
            '      "path": "src/codegen/closures/rest-only-apply.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate closure/context dispatch, receiver state and exception registration from full-vector rest-call bodies."\n    },\n    {\n',
        },
        {
          beforeOffset: 351969,
          afterOffset: 356907,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/declarations/shared-script-var-access.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned Script binding/global-environment registration and final instruction rewriting from explicit native binding resources."\n',
        },
        {
          beforeOffset: 383494,
          afterOffset: 388820,
          before: "",
          after:
            '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/array/ta-iter-detach.ts",\n',
        },
        {
          beforeOffset: 511573,
          afterOffset: 517217,
          before: "",
          after:
            '      "path": "src/runtime/wasmgc/promise/resolving-pair-bodies.ts",\n      "state": "clean",\n      "layer": "native-runtime"\n    },\n    {\n',
        },
        {
          beforeOffset: 516785,
          afterOffset: 522567,
          before: "",
          after:
            '      "state": "clean",\n      "layer": "wasm-physical"\n    },\n    {\n      "path": "src/wasm/physical/allocation-owner.ts",\n',
        },
        {
          beforeOffset: 539666,
          afterOffset: 545571,
          before: "",
          after:
            '      "path": "src/codegen/object-model/extern-get-string-receiver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 541581,
          afterOffset: 547823,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/registry/microtask-drain-boundary.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate scheduler-context and physical export registration from the canonical native microtask drain body."\n    },\n    {\n      "path": "src/codegen/registry/microtask-notification.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned late notification import and index shifting from native scheduling instructions."\n',
        },
        {
          beforeOffset: 576359,
          afterOffset: 583295,
          before: "",
          after:
            '      "path": "src/codegen/expressions/callable-property-omittable-param.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/closures/host-boolean-callback.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/typeof-import-binding.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 578897,
          afterOffset: 586835,
          before: "",
          after:
            '    },\n    {\n      "path": "src/codegen/registry/promise-rejection-dispatch.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Place context-dependent rejection dispatcher resolution and import/defined-function identity checks behind explicit backend resources."\n',
        },
      ],
      fullSemanticAndRawTargetExact: true,
    },
    oldDeno: {
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
          index: 899,
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
          index: 900,
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
          index: 998,
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
          index: 1061,
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
          index: 1657,
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
            path: "src/codegen/builtin-subclass-receiver.ts",
            state: "unmigrated",
            layer: "mixed-needs-split",
            destination: "backend-wasmgc",
            owner: "3518-coordinator",
            nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
          },
        },
        {
          index: 1785,
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
          index: 1786,
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
          index: 1787,
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
          beforeOffset: 336597,
          afterOffset: 337043,
          before: "",
          after:
            '      "path": "src/codegen/object-model/proxy-forward-carriers.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/object-model/module-namespace-exotic.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 367846,
          afterOffset: 368959,
          before: "",
          after:
            '      "path": "src/codegen/statements/finally-private-local.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "5267",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 387389,
          afterOffset: 388820,
          before: "",
          after:
            '      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/array/ta-iter-detach.ts",\n',
        },
        {
          beforeOffset: 543822,
          afterOffset: 545571,
          before: "",
          after:
            '      "path": "src/codegen/object-model/extern-get-string-receiver.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
        {
          beforeOffset: 581209,
          afterOffset: 583295,
          before: "",
          after:
            '      "path": "src/codegen/expressions/callable-property-omittable-param.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/closures/host-boolean-callback.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/typeof-import-binding.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
        },
      ],
      fullSemanticAndRawTargetExact: true,
    },
  },
} as const;
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

const root = resolve(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
type Policy = Record<string, unknown> & { files: Record<string, unknown>[] };
type Profile =
  | typeof expected.current
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
function independent(raw: string, which: "main0be" | "main58d" | "main6998" | "oldPosition" | "oldDeno"): string {
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
function healthy() {
  pin("tests/helpers/ir-deno-post-position-main-successor.ts", helperPin);
  pin(receiptPath, receiptPin);
  const raw = read("scripts/compiler-boundaries.json"),
    current = profile(raw, expected.current);
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
    expect(expected.projections.main0be.removedRows).toHaveLength(18);
    expect(expected.projections.oldPosition.removedRows).toHaveLength(26);
    expect(expected.projections.oldDeno.removedRows).toHaveLength(10);
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
        undo0be(fresh, current0beInsertions, current1864Profile),
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
        undo0be(raw, current0beInsertions, current1864Profile),
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
      const stale = undo0be(raw, current0beInsertions, current1864Profile);
      expect(() => rawCapture(stale)).toThrow(/complete raw source profile mismatch/);
      expect(() => dataCapture(JSON.parse(stale))).toThrow(/complete policy profile mismatch/);
    });
    it(`${route} accepts fresh current1866 after exact two-row insertion replay`, () => {
      const { raw, current } = healthy();
      const stale = undo0be(raw, current0beInsertions, current1864Profile);
      expect(Buffer.byteLength(raw) - Buffer.byteLength(stale)).toBe(671);
      expect(rawCapture(raw)).toBe(independent(raw, route === "main" ? "oldPosition" : "oldDeno"));
      expect(dataCapture(current)).toEqual(JSON.parse(rawCapture(raw)));
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
          it(`${route} refuses ${projection} ${originalIndices[row.row.path as keyof typeof originalIndices] ?? row.index} ${location} profile drift`, () => {
            const { current } = healthy(),
              mutant = structuredClone(current),
              index = row.index + (location === "previous" ? -1 : location === "next" ? 1 : 0);
            mutant.files[index]!.state = "foreign";
            expect(() => dataCapture(mutant)).toThrow(/complete policy profile mismatch/);
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
