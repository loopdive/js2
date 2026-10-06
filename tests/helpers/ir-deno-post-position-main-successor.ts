// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
export const denoPostPositionMainSuccessorReceiptPath = "tests/helpers/ir-deno-post-position-main-successor.json";
type Reader = (path: string) => string;
const receiptBytes = 72255;
const receiptSha256 = "500e54c202e92cbf0164974840e90f2f00db49994a0cb8523600fc45779d15c0";
const expected = {
  schema: "fixed-deno-post-position-main-successor-v1",
  coordinateUnit: "utf8-byte",
  current: {
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
  },
  mainLineage: {
    before: {
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
        index: 709,
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
        index: 711,
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
        index: 842,
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
        index: 879,
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
        index: 900,
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
        index: 943,
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
        index: 959,
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
        index: 1501,
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
        index: 1525,
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
        index: 1660,
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
        index: 1661,
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
        index: 1792,
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
        beforeOffset: 273122,
        afterOffset: 274923,
        before: "",
        after:
          '      "path": "src/codegen/object-model/linked-realm-property-read.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate linked-realm late-import reservation and context-owned function filling from its native read body."\n    },\n    {\n',
      },
      {
        beforeOffset: 273415,
        afterOffset: 275572,
        before: "",
        after:
          '    },\n    {\n      "path": "src/codegen/array/live-array-iterator-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate codegen-context iterator kind and layout selection from the receiver-backed native iterator value body."\n',
      },
      {
        beforeOffset: 315367,
        afterOffset: 317877,
        before: "",
        after:
          '      "path": "src/codegen/closures/ordinary-new-target.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST lexical-target detection and context/local/global registration from ordinary construction target frame instructions."\n    },\n    {\n',
      },
      {
        beforeOffset: 327271,
        afterOffset: 330148,
        before: "",
        after:
          '      "path": "src/codegen/registry/promise-handler-boundary.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned Promise handling boundary export and physical function registration from native handling instructions."\n    },\n    {\n',
      },
      {
        beforeOffset: 334118,
        afterOffset: 337363,
        before: "",
        after:
          '    },\n    {\n      "path": "src/codegen/closures/promoted-capture-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound promoted capture lookup and ref-cell type selection from native capture-value instructions."\n',
      },
      {
        beforeOffset: 347537,
        afterOffset: 351137,
        before: "",
        after:
          '      "path": "src/codegen/closures/rest-only-apply.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate closure/context dispatch, receiver state and exception registration from full-vector rest-call bodies."\n    },\n    {\n',
      },
      {
        beforeOffset: 352302,
        afterOffset: 356247,
        before: "",
        after:
          '    },\n    {\n      "path": "src/codegen/declarations/shared-script-var-access.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned Script binding/global-environment registration and final instruction rewriting from explicit native binding resources."\n',
      },
      {
        beforeOffset: 511906,
        afterOffset: 516239,
        before: "",
        after:
          '      "path": "src/runtime/wasmgc/promise/resolving-pair-bodies.ts",\n      "state": "clean",\n      "layer": "native-runtime"\n    },\n    {\n',
      },
      {
        beforeOffset: 517118,
        afterOffset: 521589,
        before: "",
        after:
          '      "state": "clean",\n      "layer": "wasm-physical"\n    },\n    {\n      "path": "src/wasm/physical/allocation-owner.ts",\n',
      },
      {
        beforeOffset: 541914,
        afterOffset: 546508,
        before: "",
        after:
          '    },\n    {\n      "path": "src/codegen/registry/microtask-drain-boundary.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate scheduler-context and physical export registration from the canonical native microtask drain body."\n    },\n    {\n      "path": "src/codegen/registry/microtask-notification.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned late notification import and index shifting from native scheduling instructions."\n',
      },
      {
        beforeOffset: 580245,
        afterOffset: 585533,
        before: "",
        after:
          '      "path": "src/codegen/registry/promise-rejection-dispatch.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Place context-dependent rejection dispatcher resolution and import/defined-function identity checks behind explicit backend resources."\n    },\n    {\n',
      },
    ],
    fullSemanticAndRawTargetExact: true,
  },
  mainPredecessor: {
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
        index: 709,
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
        index: 711,
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
        index: 842,
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
        index: 879,
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
        index: 898,
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
          path: "src/codegen/object-model/proxy-trap-read.ts",
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
        index: 943,
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
        index: 959,
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
        index: 1501,
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
        index: 1525,
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
        index: 1660,
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
        index: 1661,
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
        index: 1781,
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
        index: 1782,
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
        index: 1783,
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
        index: 1792,
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
        beforeOffset: 273122,
        afterOffset: 274923,
        before: "",
        after:
          '      "path": "src/codegen/object-model/linked-realm-property-read.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate linked-realm late-import reservation and context-owned function filling from its native read body."\n    },\n    {\n',
      },
      {
        beforeOffset: 273415,
        afterOffset: 275572,
        before: "",
        after:
          '    },\n    {\n      "path": "src/codegen/array/live-array-iterator-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate codegen-context iterator kind and layout selection from the receiver-backed native iterator value body."\n',
      },
      {
        beforeOffset: 315367,
        afterOffset: 317877,
        before: "",
        after:
          '      "path": "src/codegen/closures/ordinary-new-target.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST lexical-target detection and context/local/global registration from ordinary construction target frame instructions."\n    },\n    {\n',
      },
      {
        beforeOffset: 327271,
        afterOffset: 330148,
        before: "",
        after:
          '      "path": "src/codegen/registry/promise-handler-boundary.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned Promise handling boundary export and physical function registration from native handling instructions."\n    },\n    {\n',
      },
      {
        beforeOffset: 333472,
        afterOffset: 336717,
        before: "",
        after:
          '      "path": "src/codegen/object-model/proxy-forward-carriers.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
      },
      {
        beforeOffset: 333785,
        afterOffset: 337363,
        before: "",
        after:
          '    },\n    {\n      "path": "src/codegen/closures/promoted-capture-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound promoted capture lookup and ref-cell type selection from native capture-value instructions."\n',
      },
      {
        beforeOffset: 347204,
        afterOffset: 351137,
        before: "",
        after:
          '      "path": "src/codegen/closures/rest-only-apply.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate closure/context dispatch, receiver state and exception registration from full-vector rest-call bodies."\n    },\n    {\n',
      },
      {
        beforeOffset: 351969,
        afterOffset: 356247,
        before: "",
        after:
          '    },\n    {\n      "path": "src/codegen/declarations/shared-script-var-access.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned Script binding/global-environment registration and final instruction rewriting from explicit native binding resources."\n',
      },
      {
        beforeOffset: 511573,
        afterOffset: 516239,
        before: "",
        after:
          '      "path": "src/runtime/wasmgc/promise/resolving-pair-bodies.ts",\n      "state": "clean",\n      "layer": "native-runtime"\n    },\n    {\n',
      },
      {
        beforeOffset: 516785,
        afterOffset: 521589,
        before: "",
        after:
          '      "state": "clean",\n      "layer": "wasm-physical"\n    },\n    {\n      "path": "src/wasm/physical/allocation-owner.ts",\n',
      },
      {
        beforeOffset: 541581,
        afterOffset: 546508,
        before: "",
        after:
          '    },\n    {\n      "path": "src/codegen/registry/microtask-drain-boundary.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate scheduler-context and physical export registration from the canonical native microtask drain body."\n    },\n    {\n      "path": "src/codegen/registry/microtask-notification.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned late notification import and index shifting from native scheduling instructions."\n',
      },
      {
        beforeOffset: 576359,
        afterOffset: 581980,
        before: "",
        after:
          '      "path": "src/codegen/expressions/callable-property-omittable-param.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/closures/host-boolean-callback.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/typeof-import-binding.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
      },
      {
        beforeOffset: 578897,
        afterOffset: 585520,
        before: "",
        after:
          '    },\n    {\n      "path": "src/codegen/registry/promise-rejection-dispatch.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Place context-dependent rejection dispatcher resolution and import/defined-function identity checks behind explicit backend resources."\n',
      },
    ],
    fullSemanticAndRawTargetExact: true,
  },
  denoPredecessor: {
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
        index: 898,
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
          path: "src/codegen/object-model/proxy-trap-read.ts",
          state: "unmigrated",
          layer: "mixed-needs-split",
          destination: "backend-wasmgc",
          owner: "3518-coordinator",
          nextBoundary: "Separate AST/context-driven generation, physical resources and generated native runtime.",
        },
      },
      {
        index: 996,
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
        index: 1781,
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
        index: 1782,
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
        index: 1783,
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
        beforeOffset: 82963,
        afterOffset: 82963,
        before: "",
        after:
          '      "state": "clean",\n      "layer": "ir-program"\n    },\n    {\n      "path": "src/ir/program/source-map-position.ts",\n',
      },
      {
        beforeOffset: 336597,
        afterOffset: 336717,
        before: "",
        after:
          '      "path": "src/codegen/object-model/proxy-forward-carriers.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
      },
      {
        beforeOffset: 367720,
        afterOffset: 368173,
        before: "",
        after:
          '      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/statements/finally-private-local.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "5267",\n',
      },
      {
        beforeOffset: 581209,
        afterOffset: 581980,
        before: "",
        after:
          '      "path": "src/codegen/expressions/callable-property-omittable-param.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/closures/host-boolean-callback.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n      "path": "src/codegen/expressions/typeof-import-binding.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST/context-driven generation, physical resources and generated native runtime."\n    },\n    {\n',
      },
    ],
    fullSemanticAndRawTargetExact: true,
  },
} as const;
type Receipt = typeof expected;
type Profile =
  | Receipt["current"]
  | Receipt["mainPredecessor"]["before"]
  | Receipt["denoPredecessor"]["before"]
  | Receipt["mainLineage"]["before"];
type Projection = Receipt["mainPredecessor"] | Receipt["denoPredecessor"] | Receipt["mainLineage"];
function fail(detail: string): never {
  throw new Error("Deno post-position main successor: " + detail);
}
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function captureData(value: unknown, active = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") return fail("non-JSON data");
  if (active.has(value)) return fail("cyclic data");
  const array = Array.isArray(value),
    prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    return fail("plain owned data required");
  active.add(value);
  try {
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0 || Reflect.ownKeys(value).length !== length + 1)
        return fail("array holes or extra fields");
      const copy: unknown[] = [];
      for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
          return fail("array accessor, hidden index or hole");
        copy.push(captureData(descriptor.value, active));
      }
      return copy;
    }
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return fail("symbol field");
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) return fail("accessor or hidden field");
      Object.defineProperty(copy, key, {
        value: captureData(descriptor.value, active),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return copy;
  } finally {
    active.delete(value);
  }
}
function authenticate(readAuthority: Reader): Receipt {
  if (typeof readAuthority !== "function") return fail("authority reader required");
  const raw = readAuthority(denoPostPositionMainSuccessorReceiptPath);
  if (typeof raw !== "string") return fail("primitive authority text required");
  if (Buffer.byteLength(raw) !== receiptBytes || sha(raw) !== receiptSha256) return fail("fixed receipt pin mismatch");
  const receipt = JSON.parse(raw) as Receipt;
  if (!same(receipt, expected)) return fail("fixed receipt profile/rows/spans mismatch");
  return receipt;
}
const defaultRead: Reader = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
function profile(value: Record<string, unknown>, target: Profile): void {
  if (
    !same(Object.keys(value), target.topLevelKeys) ||
    sha(JSON.stringify(value)) !== target.dataSha256 ||
    !Array.isArray(value.files) ||
    value.files.length !== target.fileCount ||
    sha(JSON.stringify(value.files)) !== target.filesSha256 ||
    sha(JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "files")))) !==
      target.nonFilesSha256
  )
    fail("complete policy profile mismatch");
}
function beforeSemantic(
  current: Record<string, unknown>,
  receipt: Receipt,
  projection: Projection,
): Record<string, unknown> {
  profile(current, receipt.current);
  const files = current.files as unknown[];
  for (const added of projection.removedRows) {
    if (
      !same(files[added.index], added.row) ||
      !same(files[added.index - 1], added.previous) ||
      !same(files[added.index + 1], added.next)
    )
      fail("fixed inserted row/order mismatch");
  }
  const before = { ...current, files: [...files] };
  for (const added of [...projection.removedRows].reverse()) before.files.splice(added.index, 1);
  profile(before, projection.before);
  const replay = { ...before, files: [...before.files] };
  for (const added of projection.removedRows) replay.files.splice(added.index, 0, added.row);
  profile(replay, receipt.current);
  if (!same(replay, current)) fail("semantic reciprocal mismatch");
  return before;
}
function pin(raw: Buffer, target: Profile["source"]): void {
  if (
    raw.length !== target.bytes ||
    sha(raw) !== target.sha256 ||
    createHash("sha1").update(`blob ${raw.length}\0`).update(raw).digest("hex") !== target.gitBlob
  )
    fail("complete raw source profile mismatch");
}
function beforeRaw(raw: string, receipt: Receipt, projection: Projection): string {
  const current = Buffer.from(raw);
  pin(current, receipt.current.source);
  const inverse: Buffer[] = [];
  let beforeEnd = 0,
    afterEnd = 0;
  for (const span of projection.rawSpans) {
    if (
      !Number.isSafeInteger(span.beforeOffset) ||
      !Number.isSafeInteger(span.afterOffset) ||
      span.beforeOffset < beforeEnd ||
      span.afterOffset < afterEnd ||
      span.beforeOffset - beforeEnd !== span.afterOffset - afterEnd
    )
      fail("raw inverse coordinates mismatch");
    const before = Buffer.from(span.before),
      after = Buffer.from(span.after);
    if (
      span.beforeOffset + before.length > projection.before.source.bytes ||
      span.afterOffset + after.length > current.length ||
      !current.subarray(span.afterOffset, span.afterOffset + after.length).equals(after)
    )
      fail("raw inverse span mismatch");
    inverse.push(current.subarray(afterEnd, span.afterOffset), before);
    beforeEnd = span.beforeOffset + before.length;
    afterEnd = span.afterOffset + after.length;
  }
  inverse.push(current.subarray(afterEnd));
  const before = Buffer.concat(inverse);
  pin(before, projection.before.source);
  const forward: Buffer[] = [];
  beforeEnd = 0;
  for (const span of projection.rawSpans) {
    const old = Buffer.from(span.before);
    if (!before.subarray(span.beforeOffset, span.beforeOffset + old.length).equals(old))
      fail("raw replay span mismatch");
    forward.push(before.subarray(beforeEnd, span.beforeOffset), Buffer.from(span.after));
    beforeEnd = span.beforeOffset + old.length;
  }
  forward.push(before.subarray(beforeEnd));
  const replay = Buffer.concat(forward);
  pin(replay, receipt.current.source);
  if (!replay.equals(current)) fail("raw reciprocal mismatch");
  const semantic = beforeSemantic(JSON.parse(raw) as Record<string, unknown>, receipt, projection);
  if (!same(JSON.parse(before.toString("utf8")), semantic)) fail("raw/semantic inverse mismatch");
  return before.toString("utf8");
}
export function captureDenoPostPositionMainPredecessorPolicy(
  value: unknown,
  readAuthority: Reader = defaultRead,
): Record<string, unknown> {
  const current = captureData(value);
  if (!current || typeof current !== "object" || Array.isArray(current))
    return fail("policy input must be a plain object");
  const receipt = authenticate(readAuthority);
  beforeSemantic(current as Record<string, unknown>, receipt, receipt.mainLineage);
  return beforeSemantic(current as Record<string, unknown>, receipt, receipt.mainPredecessor);
}
export function captureDenoPostPositionMainPredecessorPolicySource(
  raw: string,
  readAuthority: Reader = defaultRead,
): string {
  if (typeof raw !== "string") return fail("raw input must be a primitive string");
  const receipt = authenticate(readAuthority);
  beforeRaw(raw, receipt, receipt.mainLineage);
  return beforeRaw(raw, receipt, receipt.mainPredecessor);
}
export function captureDenoPostPositionDenoPredecessorPolicy(
  value: unknown,
  readAuthority: Reader = defaultRead,
): Record<string, unknown> {
  const current = captureData(value);
  if (!current || typeof current !== "object" || Array.isArray(current))
    return fail("policy input must be a plain object");
  const receipt = authenticate(readAuthority);
  beforeSemantic(current as Record<string, unknown>, receipt, receipt.mainLineage);
  return beforeSemantic(current as Record<string, unknown>, receipt, receipt.denoPredecessor);
}
export function captureDenoPostPositionDenoPredecessorPolicySource(
  raw: string,
  readAuthority: Reader = defaultRead,
): string {
  if (typeof raw !== "string") return fail("raw input must be a primitive string");
  const receipt = authenticate(readAuthority);
  beforeRaw(raw, receipt, receipt.mainLineage);
  return beforeRaw(raw, receipt, receipt.denoPredecessor);
}
