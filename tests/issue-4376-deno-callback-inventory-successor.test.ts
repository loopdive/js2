import { captureDenoPostPositionDenoPredecessorPolicySource } from "./helpers/ir-deno-post-position-main-successor.js";
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Independent test-only policy-source proof, not compiler or runtime acceptance.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { captureDenoClassFieldsMainPredecessorPolicySource } from "./helpers/ir-deno-class-fields-main-successor.js";
import { captureMainInventoryPredecessorPolicy } from "./helpers/ir-main-inventory-source-successor.js";
import {
  captureDenoCallbackInventoryPredecessorPolicy,
  captureDenoCallbackInventoryPredecessorPolicySource,
} from "./helpers/ir-deno-callback-inventory-successor.js";

// Independent literals reconstructed from exact old/current source bytes and the frozen row specification.
const expected = {
  before: {
    bytes: 588351,
    sha256: "4b442f641a2a99fd4abffc5ef85271858f4a3ae2337fcde8c380fba076a22d05",
    gitBlob: "c5da824f89dded25e85e7e315825d2d61d97f906",
    fileCount: 1837,
    dataSha256: "56532a3cda4a9a8ec083fc0ebb7d38300fe754dd8f7cc4d49c20784ae77f05e0",
    filesSha256: "fdd1e7da8bc2decab20f41771aa30b724a3ecda1929f590f286e2f530171be9c",
    rootWithoutFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
  },
  current: {
    bytes: 594018,
    sha256: "59752f826a8a2298966e4bbae6ec29e15a168f7e45fb58379dbb923ccd2f2694",
    gitBlob: "dfd1b16089d1d66982e0eef5d79b50f74fd6d869",
    fileCount: 1855,
    dataSha256: "07d3bc5470d5864ae6f1e7d199eed523b382119aace6366db92804a7c7c63380",
    filesSha256: "f30f8e6a86c56fc16e6c9ad768d52930b70f73beef57feffae69ad932d5bf78c",
    rootWithoutFilesSha256: "3a4788461bc5c6757c931554be0ec6218711f00814f580d9bb70d26a5929c1ce",
  },
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
  spans: [
    {
      beforeOffset: 78277,
      afterOffset: 78277,
      before: "",
      after:
        '    {\n      "path": "src/runtime/wasmgc/promise/reaction-order-bodies.ts",\n      "state": "clean",\n      "layer": "native-runtime"\n    },\n',
    },
    {
      beforeOffset: 78277,
      afterOffset: 78415,
      before: "",
      after:
        '    {\n      "path": "src/runtime/wasmgc/promise/rejection-event-bodies.ts",\n      "state": "clean",\n      "layer": "native-runtime"\n    },\n',
    },
    {
      beforeOffset: 109315,
      afterOffset: 109592,
      before: "",
      after:
        '    {\n      "path": "src/codegen/array/array-fill-proto-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound Array.fill argument coercion and prototype-call emission from reusable native body construction."\n    },\n',
    },
    {
      beforeOffset: 131900,
      afterOffset: 132534,
      before: "",
      after:
        '    {\n      "path": "src/codegen/expressions/builtin-native-dyn-construct.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound Array and Promise dynamic construction, late imports and builtin identity reservation from native construction bodies."\n    },\n',
    },
    {
      beforeOffset: 150397,
      afterOffset: 151422,
      before: "",
      after:
        '    {\n      "path": "src/codegen/object-model/closed-carrier-prototype-status.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "native-runtime",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Place the allocation-free closed-carrier prototype-status body in its canonical native runtime owner and replace the legacy instruction-type import."\n    },\n',
    },
    {
      beforeOffset: 150717,
      afterOffset: 152144,
      before: "",
      after:
        '    {\n      "path": "src/codegen/object-model/closed-object-prototype-edges.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate codegen-context prototype edge registration and physical function/global allocation from native prototype bodies."\n    },\n',
    },
    {
      beforeOffset: 272996,
      afterOffset: 274797,
      before: "",
      after:
        '    {\n      "path": "src/codegen/object-model/linked-realm-property-read.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate linked-realm late-import reservation and context-owned function filling from its native read body."\n    },\n',
    },
    {
      beforeOffset: 273302,
      afterOffset: 275459,
      before: "",
      after:
        '    {\n      "path": "src/codegen/array/live-array-iterator-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate codegen-context iterator kind and layout selection from the receiver-backed native iterator value body."\n    },\n',
    },
    {
      beforeOffset: 315241,
      afterOffset: 317751,
      before: "",
      after:
        '    {\n      "path": "src/codegen/closures/ordinary-new-target.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate AST lexical-target detection and context/local/global registration from ordinary construction target frame instructions."\n    },\n',
    },
    {
      beforeOffset: 327145,
      afterOffset: 330022,
      before: "",
      after:
        '    {\n      "path": "src/codegen/registry/promise-handler-boundary.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned Promise handling boundary export and physical function registration from native handling instructions."\n    },\n',
    },
    {
      beforeOffset: 333672,
      afterOffset: 336917,
      before: "",
      after:
        '    {\n      "path": "src/codegen/closures/promoted-capture-value.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-bound promoted capture lookup and ref-cell type selection from native capture-value instructions."\n    },\n',
    },
    {
      beforeOffset: 347078,
      afterOffset: 350678,
      before: "",
      after:
        '    {\n      "path": "src/codegen/closures/rest-only-apply.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate closure/context dispatch, receiver state and exception registration from full-vector rest-call bodies."\n    },\n',
    },
    {
      beforeOffset: 351856,
      afterOffset: 355801,
      before: "",
      after:
        '    {\n      "path": "src/codegen/declarations/shared-script-var-access.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned Script binding/global-environment registration and final instruction rewriting from explicit native binding resources."\n    },\n',
    },
    {
      beforeOffset: 511129,
      afterOffset: 515462,
      before: "",
      after:
        '    {\n      "path": "src/runtime/wasmgc/promise/resolving-pair-bodies.ts",\n      "state": "clean",\n      "layer": "native-runtime"\n    },\n',
    },
    {
      beforeOffset: 516409,
      afterOffset: 520880,
      before: "",
      after:
        '    {\n      "path": "src/wasm/physical/allocation-owner.ts",\n      "state": "clean",\n      "layer": "wasm-physical"\n    },\n',
    },
    {
      beforeOffset: 541150,
      afterOffset: 545744,
      before: "",
      after:
        '    {\n      "path": "src/codegen/registry/microtask-drain-boundary.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate scheduler-context and physical export registration from the canonical native microtask drain body."\n    },\n',
    },
    {
      beforeOffset: 541150,
      afterOffset: 546094,
      before: "",
      after:
        '    {\n      "path": "src/codegen/registry/microtask-notification.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Separate context-owned late notification import and index shifting from native scheduling instructions."\n    },\n',
    },
    {
      beforeOffset: 578138,
      afterOffset: 583426,
      before: "",
      after:
        '    {\n      "path": "src/codegen/registry/promise-rejection-dispatch.ts",\n      "state": "unmigrated",\n      "layer": "mixed-needs-split",\n      "destination": "backend-wasmgc",\n      "owner": "3518-coordinator",\n      "nextBoundary": "Place context-dependent rejection dispatcher resolution and import/defined-function identity checks behind explicit backend resources."\n    },\n',
    },
  ],
  added: [
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
      index: 195,
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
      index: 267,
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
      index: 326,
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
      index: 328,
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
      index: 708,
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
      index: 710,
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
      index: 841,
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
      index: 878,
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
      index: 941,
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
      index: 957,
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
      index: 1498,
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
      index: 1522,
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
      index: 1658,
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
} as const;
const root = resolve(import.meta.dirname, "..");
const sourcePath = "scripts/compiler-boundaries.json";
const receiptPath = "tests/helpers/ir-deno-callback-inventory-successor.json";
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
type Row = Record<string, unknown> & { path: string };
type Policy = Record<string, unknown> & { files: Row[] };
function profile(value: Policy, which: "current" | "before") {
  const pin = expected[which];
  expect(Object.keys(value)).toEqual(expected.topLevelKeys);
  expect(value.files).toHaveLength(pin.fileCount);
  expect(sha(JSON.stringify(value))).toBe(pin.dataSha256);
  expect(sha(JSON.stringify(value.files))).toBe(pin.filesSha256);
  expect(sha(JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key]) => key !== "files"))))).toBe(
    pin.rootWithoutFilesSha256,
  );
}
function independentRawBefore(current: string): string {
  expect(Buffer.byteLength(current)).toBe(expected.current.bytes);
  expect(sha(current)).toBe(expected.current.sha256);
  expect(
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(current)}\0`)
      .update(current)
      .digest("hex"),
  ).toBe(expected.current.gitBlob);
  const bytes = Buffer.from(current),
    parts: Buffer[] = [];
  let cursor = 0;
  for (const span of expected.spans) {
    expect(span.before).toBe("");
    expect(bytes.subarray(span.afterOffset, span.afterOffset + Buffer.byteLength(span.after)).toString("utf8")).toBe(
      span.after,
    );
    parts.push(bytes.subarray(cursor, span.afterOffset), Buffer.from(span.before));
    cursor = span.afterOffset + Buffer.byteLength(span.after);
  }
  parts.push(bytes.subarray(cursor));
  const before = Buffer.concat(parts).toString("utf8");
  expect(Buffer.byteLength(before)).toBe(expected.before.bytes);
  expect(sha(before)).toBe(expected.before.sha256);
  expect(
    createHash("sha1")
      .update(`blob ${Buffer.byteLength(before)}\0`)
      .update(before)
      .digest("hex"),
  ).toBe(expected.before.gitBlob);
  const old = Buffer.from(before),
    replay: Buffer[] = [];
  cursor = 0;
  for (const span of expected.spans) {
    replay.push(old.subarray(cursor, span.beforeOffset), Buffer.from(span.after));
    cursor = span.beforeOffset;
  }
  replay.push(old.subarray(cursor));
  expect(Buffer.concat(replay).toString("utf8")).toBe(current);
  return before;
}
function independentPolicyBefore(current: Policy): Policy {
  profile(current, "current");
  const indices = new Set<number>();
  for (const { index, row } of expected.added) {
    expect(current.files[index]).toEqual(row);
    const literal = expected.added.find((added) => added.index === index)!;
    expect(current.files[index - 1]).toEqual(literal.previous);
    expect(current.files[index + 1]).toEqual(literal.next);
    indices.add(index);
  }
  const before = { ...current, files: current.files.filter((_row, index) => !indices.has(index)) };
  profile(before, "before");
  return before;
}
function authorityReader() {
  const trace: string[] = [];
  return {
    trace,
    read: (path: string): string => {
      trace.push(path);
      return read(path);
    },
  };
}
function healthy() {
  const receipt = read(receiptPath),
    helper = read("tests/helpers/ir-deno-callback-inventory-successor.ts");
  expect(Buffer.byteLength(receipt)).toBe(27453);
  expect(sha(receipt)).toBe("b35c6b605ea4fd36f7c5cb2a4b46aff8eee49de4cfb675aa78a0d1dc5934e7d9");
  expect(Buffer.byteLength(helper)).toBe(26807);
  expect(sha(helper)).toBe("8d43afc143b05b21d1606d61dc57e4540ac8923a370a8b20f0254e137bbfcdb3");
  const current = captureDenoClassFieldsMainPredecessorPolicySource(
      captureDenoPostPositionDenoPredecessorPolicySource(read(sourcePath)),
    ),
    before = independentRawBefore(current),
    input = JSON.parse(current) as Policy;
  const sourceAuthority = authorityReader(),
    semanticAuthority = authorityReader();
  expect(captureDenoCallbackInventoryPredecessorPolicySource(current, sourceAuthority.read)).toBe(before);
  expect(captureDenoCallbackInventoryPredecessorPolicy(input, semanticAuthority.read)).toEqual(
    independentPolicyBefore(input),
  );
  expect(sourceAuthority.trace).toEqual([receiptPath]);
  expect(semanticAuthority.trace).toEqual([receiptPath]);
  return { current, before, input };
}
function freezeGraph(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
    if ("value" in descriptor) freezeGraph(descriptor.value);
  Object.freeze(value);
}

describe("fixed Deno callback inventory successor independent proof", () => {
  it("independently binds all eighteen source insertions and eighteen exact rows with full before/current replay", () => {
    const { current, before, input } = healthy();
    expect(expected.spans).toHaveLength(18);
    expect(expected.added).toHaveLength(18);
    expect(JSON.parse(before)).toEqual(independentPolicyBefore(input));
    console.info(
      "Deno callback inventory proof-only",
      JSON.stringify({
        currentBytes: Buffer.byteLength(current),
        historicalBytes: Buffer.byteLength(before),
        currentRows: input.files.length,
        historicalRows: JSON.parse(before).files.length,
        spans: expected.spans.length,
        addedRows: expected.added.length,
      }),
    );
  });
  it("preserves every retained field and row, detaches output and leaves a frozen actual operand unchanged", () => {
    const { input } = healthy();
    const retained = JSON.stringify(input),
      expectedBefore = independentPolicyBefore(input);
    freezeGraph(input);
    const result = captureDenoCallbackInventoryPredecessorPolicy(input) as Policy;
    expect(result).toEqual(expectedBefore);
    expect(result).not.toBe(input);
    for (const key of expected.topLevelKeys) if (key !== "files") expect(result[key]).toEqual(input[key]);
    expect(result.files).not.toBe(input.files);
    for (let index = 0; index < result.files.length; index++)
      expect(result.files[index]).not.toBe(expectedBefore.files[index]);
    expect(JSON.stringify(input)).toBe(retained);
  });
  for (const kind of ["tail edit", "changed retained field", "already historical operand"] as const)
    it(`refuses raw ${kind} after healthy capture and observes exact restoration`, () => {
      const witness = healthy();
      const data = JSON.parse(witness.current);
      data.description += " mutant";
      const mutant =
        kind === "tail edit"
          ? witness.current + "\n"
          : kind === "changed retained field"
            ? JSON.stringify(data)
            : witness.before;
      expect(() => captureDenoCallbackInventoryPredecessorPolicySource(mutant)).toThrow(
        /complete raw source profile mismatch/,
      );
      healthy();
    });
  for (const [name, mutate] of [
    [
      "omitted added row",
      (data) => {
        data.files.splice(expected.added[0].index, 1);
      },
    ],
    [
      "duplicated added row",
      (data) => {
        data.files.splice(expected.added[0].index, 0, structuredClone(data.files[expected.added[0].index]));
      },
    ],
    [
      "renamed added row",
      (data) => {
        data.files[expected.added[0].index].path += ".renamed";
      },
    ],
    [
      "changed retained row path",
      (data) => {
        data.files[0].path += ".mutant";
      },
    ],
    [
      "reordered current rows",
      (data) => {
        const index = expected.added[0].index;
        [data.files[index], data.files[index + 1]] = [data.files[index + 1], data.files[index]];
      },
    ],
    [
      "changed retained top-level field",
      (data) => {
        data.description = "mutant";
      },
    ],
    [
      "changed non-files boundary rules",
      (data) => {
        data.allowedEdges = {};
      },
    ],
    [
      "unexpected top-level field",
      (data) => {
        data.unrelated = true;
      },
    ],
  ] satisfies [string, (data: Policy) => void][])
    it(`refuses semantic ${name} between genuine healthy captures`, () => {
      const { input } = healthy();
      mutate(input);
      expect(() => captureDenoCallbackInventoryPredecessorPolicy(input)).toThrow(/complete policy profile mismatch/);
      healthy();
    });
  for (const kind of ["top-level getter", "row getter", "array element getter", "sparse array"] as const)
    it(`refuses ${kind} before authority IO or getter execution`, () => {
      const { input } = healthy();
      let calls = 0;
      if (kind === "top-level getter") {
        const value = input.files;
        Object.defineProperty(input, "files", {
          get() {
            calls++;
            return value;
          },
        });
      }
      if (kind === "row getter") {
        const value = input.files[0].owner;
        Object.defineProperty(input.files[0], "owner", {
          get() {
            calls++;
            return value;
          },
        });
      }
      if (kind === "array element getter") {
        const value = input.files[3];
        Object.defineProperty(input.files, "3", {
          get() {
            calls++;
            return value;
          },
        });
      }
      if (kind === "sparse array") Reflect.deleteProperty(input.files, "3");
      const authority = authorityReader();
      expect(() => captureDenoCallbackInventoryPredecessorPolicy(input, authority.read)).toThrow();
      expect(calls).toBe(0);
      expect(authority.trace).toEqual([]);
      healthy();
    });
  for (const lane of ["raw", "semantic"] as const)
    it(`rejects boxed ${lane} data without coercion or authority IO`, () => {
      const { current } = healthy();
      let calls = 0;
      const boxed = Object(current);
      Object.defineProperty(boxed, Symbol.toPrimitive, {
        get() {
          calls++;
          return () => {
            calls++;
            return current;
          };
        },
      });
      const authority = authorityReader();
      expect(() =>
        lane === "raw"
          ? captureDenoCallbackInventoryPredecessorPolicySource(boxed as string, authority.read)
          : captureDenoCallbackInventoryPredecessorPolicy(boxed, authority.read),
      ).toThrow();
      expect(calls).toBe(0);
      expect(authority.trace).toEqual([]);
      healthy();
    });
  for (const kind of ["corrupt", "missing"] as const)
    it(`refuses a physically ${kind} fixed receipt after warm capture and restores exact original bytes`, () => {
      const witness = healthy();
      const path = resolve(root, receiptPath),
        original = readFileSync(path),
        originalHash = sha(original);
      const scratchRoot = resolve(root, ".tmp", "pr6341-inventory/authority-faults");
      mkdirSync(scratchRoot, { recursive: true });
      const directory = mkdtempSync(resolve(scratchRoot, "proof-")),
        backup = resolve(directory, "receipt-original.json");
      let moved = false;
      try {
        if (kind === "missing") {
          renameSync(path, backup);
          moved = true;
        } else writeFileSync(path, Buffer.concat([original, Buffer.from("\n")]));
        expect(() => captureDenoCallbackInventoryPredecessorPolicySource(witness.current)).toThrow(
          kind === "missing" ? /ENOENT/ : /fixed receipt pin mismatch/,
        );
        expect(() => captureDenoCallbackInventoryPredecessorPolicy(witness.input)).toThrow(
          kind === "missing" ? /ENOENT/ : /fixed receipt pin mismatch/,
        );
      } finally {
        if (moved) renameSync(backup, path);
        else writeFileSync(path, original);
        expect(sha(readFileSync(path))).toBe(originalHash);
        expect(readFileSync(path)).toEqual(original);
        rmSync(directory, { recursive: true, force: true });
      }
      healthy();
    });
});

describe("Deno callback inventory fresh source and authority controls", () => {
  it("passes the exact predecessor into the unchanged eleven-row inverse", () => {
    const { current, before } = healthy();
    expect(captureMainInventoryPredecessorPolicy(JSON.parse(before)).files).toHaveLength(1826);
    expect(captureDenoCallbackInventoryPredecessorPolicySource(current)).toBe(before);
  });
  for (const lane of ["raw", "semantic"] as const)
    for (const kind of ["malformed", "boxed", "missing", "absent reader"] as const)
      it(`rejects ${kind} authority on the ${lane} channel with exact fresh read counts`, () => {
        const { current, input } = healthy();
        let reads = 0;
        const reader = (path: string): string => {
          reads++;
          expect(path).toBe(receiptPath);
          if (kind === "missing") throw new Error("missing fixed receipt");
          return kind === "boxed" ? (Object(read(path)) as string) : "{";
        };
        expect(() =>
          lane === "raw"
            ? captureDenoCallbackInventoryPredecessorPolicySource(
                current,
                kind === "absent reader" ? (null as never) : reader,
              )
            : captureDenoCallbackInventoryPredecessorPolicy(input, kind === "absent reader" ? (null as never) : reader),
        ).toThrow();
        expect(reads).toBe(kind === "absent reader" ? 0 : 1);
        healthy();
      });
  it("rejects a physically corrupted full policy after healthy capture and observes exact restored bytes", () => {
    const witness = healthy();
    // Authenticate the outer current epoch before staging the original own-step physical fault.
    const directory = mkdtempSync(resolve(root, ".tmp", "deno-own-policy-fault-"));
    const path = resolve(directory, "compiler-boundaries.json");
    writeFileSync(path, witness.current);
    const original = readFileSync(path);
    try {
      const mutant = JSON.parse(original.toString("utf8"));
      mutant.files[expected.added[0].index].path += ".corrupt";
      writeFileSync(path, JSON.stringify(mutant));
      const rawAuthority = authorityReader(),
        semanticAuthority = authorityReader();
      expect(() =>
        captureDenoCallbackInventoryPredecessorPolicySource(readFileSync(path, "utf8"), rawAuthority.read),
      ).toThrow(/complete raw source profile mismatch/);
      expect(() =>
        captureDenoCallbackInventoryPredecessorPolicy(JSON.parse(readFileSync(path, "utf8")), semanticAuthority.read),
      ).toThrow(/complete policy profile mismatch/);
      expect(rawAuthority.trace).toEqual([receiptPath]);
      expect(semanticAuthority.trace).toEqual([receiptPath]);
    } finally {
      writeFileSync(path, original);
      expect(readFileSync(path)).toEqual(original);
      expect(captureDenoCallbackInventoryPredecessorPolicySource(readFileSync(path, "utf8"))).toBe(witness.before);
      rmSync(directory, { recursive: true, force: true });
    }
    healthy();
  });
});

it("authenticates all thirteen final transported rows before old-path mutants and restoration", () => {
  const mappings = [
    {
      before: "src/codegen/array-fill-proto-value.ts",
      after: "src/codegen/array/array-fill-proto-value.ts",
      index: 195,
    },
    {
      before: "src/codegen/builtin-native-dyn-construct.ts",
      after: "src/codegen/expressions/builtin-native-dyn-construct.ts",
      index: 267,
    },
    {
      before: "src/codegen/closed-carrier-prototype-status.ts",
      after: "src/codegen/object-model/closed-carrier-prototype-status.ts",
      index: 326,
    },
    {
      before: "src/codegen/closed-object-prototype-edges.ts",
      after: "src/codegen/object-model/closed-object-prototype-edges.ts",
      index: 328,
    },
    {
      before: "src/codegen/linked-realm-property-read.ts",
      after: "src/codegen/object-model/linked-realm-property-read.ts",
      index: 708,
    },
    {
      before: "src/codegen/live-array-iterator-value.ts",
      after: "src/codegen/array/live-array-iterator-value.ts",
      index: 710,
    },
    {
      before: "src/codegen/microtask-drain-boundary.ts",
      after: "src/codegen/registry/microtask-drain-boundary.ts",
      index: 1657,
    },
    {
      before: "src/codegen/microtask-notification.ts",
      after: "src/codegen/registry/microtask-notification.ts",
      index: 1658,
    },
    {
      before: "src/codegen/ordinary-new-target.ts",
      after: "src/codegen/closures/ordinary-new-target.ts",
      index: 841,
    },
    {
      before: "src/codegen/promise-handler-boundary.ts",
      after: "src/codegen/registry/promise-handler-boundary.ts",
      index: 878,
    },
    {
      before: "src/codegen/promise-rejection-dispatch.ts",
      after: "src/codegen/registry/promise-rejection-dispatch.ts",
      index: 1785,
    },
    {
      before: "src/codegen/rest-only-apply.ts",
      after: "src/codegen/closures/rest-only-apply.ts",
      index: 941,
    },
    {
      before: "src/codegen/shared-script-var-access.ts",
      after: "src/codegen/declarations/shared-script-var-access.ts",
      index: 957,
    },
  ] as const;
  expect(mappings).toHaveLength(13);
  let measured = 0;
  for (const mapping of mappings) {
    const witness = healthy();
    expect(witness.input.files.filter((row) => row.path === mapping.after)).toHaveLength(1);
    expect(witness.input.files[mapping.index]!.path).toBe(mapping.after);
    expect(witness.input.files.filter((row) => row.path === mapping.before)).toEqual([]);
    expect(existsSync(resolve(root, mapping.after))).toBe(true);
    expect(existsSync(resolve(root, mapping.before))).toBe(false);
    const mutant = structuredClone(witness.input);
    mutant.files[mapping.index]!.path = mapping.before;
    const authority = authorityReader();
    expect(() => captureDenoCallbackInventoryPredecessorPolicy(mutant, authority.read)).toThrow(
      "complete policy profile mismatch",
    );
    expect(authority.trace).toEqual([receiptPath]);
    const oldPathRaw = witness.current.replace('"path": "' + mapping.after + '"', '"path": "' + mapping.before + '"');
    expect(oldPathRaw).not.toBe(witness.current);
    expect(() => captureDenoCallbackInventoryPredecessorPolicySource(oldPathRaw)).toThrow(
      "complete raw source profile mismatch",
    );
    healthy();
    measured++;
  }
  expect(measured).toBe(13);
});
