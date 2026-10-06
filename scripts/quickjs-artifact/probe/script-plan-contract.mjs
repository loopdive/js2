// Frozen before execution: 22 original Q1 sources + 20 P1 lifecycle cases.
// Names are decoded parser facts; ordinals are raw array indices, duplicates stay.
import { createHash } from "node:crypto";

const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const records = (...rows) => rows.map(([name, kind, origin = 0], ordinal) => ({ name, kind, origin, ordinal }));
const row = (id, source, raw, strict = false, extra = {}) => ({
  id,
  source,
  sourceSha256: createHash("sha256").update(source).digest("hex"),
  expected: { raw, strict, error: null, bodyEffect: 0, ownPropertyPublication: false, ...extra },
  status: "NOT_RUN",
});
const syntax = { strict: null, error: "SyntaxError", projection: [] };

export const SCRIPT_PLAN_CASES = freeze(
  [
    row("Q1-empty", ";", []),
    row("Q1-fresh-var-effect", "var fresh = (globalThis.__probe_body_effect__ = 1);", records(["fresh", 0])),
    row("Q1-fresh-function", "function freshFn() { return 1; }", records(["freshFn", 1])),
    row("Q1-builtin-var", "var Array;", records(["Array", 0])),
    row("Q1-builtin-function", "function Array() { return 1; }", records(["Array", 1])),
    row("Q1-readonly-Infinity", "var Infinity;", records(["Infinity", 0])),
    row("Q1-escaped-readonly-Infinity", "var \\u0049nfinity;", records(["Infinity", 0])),
    row("Q1-readonly-NaN", "var NaN;", records(["NaN", 0])),
    row("Q1-readonly-undefined", "var undefined;", records(["undefined", 0])),
    row("Q1-unicode-var", "var π;", records(["π", 0])),
    row("Q1-astral-function", "function 𝒜() { return 1; }", records(["𝒜", 1])),
    row("Q1-escaped-fresh", "var \\u0061;", records(["a", 0])),
    row("Q1-duplicate-var", "var duplicate; var duplicate;", records(["duplicate", 0], ["duplicate", 0]), false, {
      projection: [["duplicate", "var"]],
    }),
    row("Q1-var-and-function", "var both; function both() { return 1; }", records(["both", 0], ["both", 1]), false, {
      projection: [["both", "function"]],
    }),
    row("Q1-sloppy-block-function", "{ function blockFn() {} }", records(["blockFn", 0, 1])),
    row("Q1-strict-var", '"use strict"; var strictVar;', records(["strictVar", 0]), true),
    row("Q1-strict-block", '"use strict"; { function blockFn() {} } var strictVar;', records(["strictVar", 0]), true),
    row("Q1-lexical-builtin-shadow", "let Array;", records(["Array", 2]), false, { projection: [] }),
    row("Q1-lexical-collision", "let collision; var collision;", [], null, syntax),
    row("Q1-syntax-error", "var =;", [], null, syntax),
    row("Q1-strict-with", '"use strict"; with ({}) {}', [], null, syntax),
    row(
      "Q1-leading-body-effect",
      "globalThis.__probe_body_effect__ = 1; var afterEffect;",
      records(["afterEffect", 0]),
    ),
    row("mutable-let", "let mutable = (globalThis.__probe_body_effect__ = 1);", records(["mutable", 2])),
    row("immutable-const", "const immutable = (globalThis.__probe_body_effect__ = 1);", records(["immutable", 3])),
    row(
      "mutable-class",
      "class MutableClass extends (globalThis.__probe_body_effect__ = 1, Object) {}",
      records(["MutableClass", 2]),
    ),
    row(
      "destructure-bound-names",
      "var {first: \\u0061, nested: [b, ...c]} = (globalThis.__probe_body_effect__ = 1, {first: 1, nested: [2, 3]});",
      records(["a", 0], ["b", 0], ["c", 0]),
    ),
    row(
      "for-var-bound-names",
      "for (var [loopA, loopB] of (globalThis.__probe_body_effect__ = 1, [[2, 3]])) { globalThis.__probe_loop_effect__ = 1; }",
      records(["loopA", 0], ["loopB", 0]),
    ),
    row(
      "duplicate-functions",
      "function duplicateFn() { return 1; } function duplicateFn() { return 2; } globalThis.__probe_body_effect__++; duplicateFn;",
      records(["duplicateFn", 1], ["duplicateFn", 1]),
      false,
      {
        protocol: "identity",
        completion: "same-as-global-function",
        selectedFunctionResult: 2,
        afterEvalBodyEffect: 1,
      },
    ),
    row(
      "var-function-var",
      "var mixed; function mixed() { return 3; } var mixed; globalThis.__probe_body_effect__++; mixed;",
      records(["mixed", 0], ["mixed", 1], ["mixed", 0]),
      false,
      {
        protocol: "identity",
        completion: "same-as-global-function",
        selectedFunctionResult: 3,
        afterEvalBodyEffect: 1,
      },
    ),
    row(
      "nested-function-local",
      "function outer() { var inside; function inner() {} let local; }",
      records(["outer", 1]),
    ),
    row("strict-block-local", '"use strict"; { function localBlock() {} let blockLexical; }', [], true),
    row("directive-continuation", '"use strict"\n+ 1; var continued;', records(["continued", 0])),
    row("invalid-index", "var indexed;", records(["indexed", 0]), false, {
      protocol: "invalid-index",
      invalidIndices: [-1, 1],
      scalarResult: -1,
      errorBrand: "RangeError",
      nameResult: "owned-exception",
      preservedPlanCount: 1,
    }),
    row("foreign-context", "var owned;", records(["owned", 0]), false, {
      protocol: "foreign-context",
      rejectedOperations: ["count", "strict", "kind", "origin", "name", "eval", "free"],
      errorBrand: "TypeError",
      preservedOwnerCount: 1,
      preservedUnrelatedCount: 1,
    }),
    row("stale-id-after-free", "var stale;", records(["stale", 0]), false, {
      protocol: "stale-id-after-free",
      errorBrand: "TypeError",
      replacementId: "strictly-greater",
      zeroFreeResult: 0,
      preservedUnrelatedCount: 1,
    }),
    row("stale-id-after-context-free", "var staleContext;", records(["staleContext", 0]), false, {
      protocol: "stale-id-after-context-free",
      steps: [
        "free owning context through shim",
        "create a new live context",
        "reject old ID using new context",
        "prove unrelated plan usable",
      ],
      errorBrand: "TypeError",
      replacementId: "strictly-greater",
      preservedUnrelatedCount: 1,
    }),
    row("discard-ready", "var discarded = (globalThis.__probe_body_effect__ = 1);", records(["discarded", 0]), false, {
      protocol: "discard-ready",
      freeResult: 0,
      afterFreeBodyEffect: 0,
      afterFreeOwnProperty: false,
    }),
    row(
      "normal-consume-once",
      "function actualFn() { return 7; } globalThis.__probe_body_effect__++; actualFn;",
      records(["actualFn", 1]),
      false,
      {
        protocol: "normal-consume-once",
        completion: "same-as-global-function",
        selectedFunctionResult: 7,
        afterEvalBodyEffect: 1,
        secondEvalError: "TypeError",
        afterSecondEvalBodyEffect: 1,
        readableAfterConsume: true,
      },
    ),
    row(
      "throw-consume-once",
      "var retained; function retainedFn() { return 8; } globalThis.__probe_body_effect__++; throw globalThis.__probe_throw_marker__;",
      records(["retained", 0], ["retainedFn", 1]),
      false,
      {
        protocol: "throw-consume-once",
        exception: "same-as-seeded-marker",
        afterEvalBodyEffect: 1,
        retainedBindings: ["retained", "retainedFn"],
        selectedFunctionResult: 8,
        secondEvalError: "TypeError",
        afterSecondEvalBodyEffect: 1,
        readableAfterConsume: true,
      },
    ),
    row(
      "source-buffer-reuse",
      "var originalBuffer = 9; globalThis.__probe_body_effect__++; originalBuffer;",
      records(["originalBuffer", 0]),
      false,
      { protocol: "source-buffer-reuse", replacement: "throw 99;", completion: 9, afterEvalBodyEffect: 1 },
    ),
    row(
      "context-plan-cleanup",
      "var contextOwned; function contextFn() {} let contextLexical;",
      records(["contextOwned", 0], ["contextFn", 1], ["contextLexical", 2]),
      false,
      {
        protocol: "context-plan-cleanup",
        readyPlans: 2,
        consumedPlans: 1,
        privateLiveAfterContextFree: 0,
        unrelatedPlansPreserved: 1,
      },
    ),
    row(
      "runtime-plan-cleanup",
      "var runtimeOwned; function runtimeFn() {} const runtimeLexical = 1;",
      records(["runtimeOwned", 0], ["runtimeFn", 1], ["runtimeLexical", 3]),
      false,
      {
        protocol: "runtime-plan-cleanup",
        contexts: 2,
        readyPlans: 2,
        consumedPlans: 1,
        steps: [
          "create two contexts and three plans",
          "consume one plan and release its completion",
          "observe three plan nodes before cleanup",
          "free both contexts through shim",
          "observe zero target runtime plan nodes",
          "free runtime with no live contexts",
          "prove unrelated runtime plan usable",
        ],
        testBuildBackstopSteps: [
          "create two contexts and three plans",
          "consume one plan and release its completion",
          "observe three plan nodes and owned atoms",
          "invoke private runtime plan cleanup hook while contexts are live",
          "observe zero target nodes and atoms with unrelated runtime preserved",
          "free both contexts normally",
          "free runtime normally",
        ],
        privateLiveAfterRuntimeFree: 0,
        unrelatedRuntimePlansPreserved: 1,
      },
    ),
  ].map((entry) => ({
    ...entry,
    expected: {
      ...entry.expected,
      projection:
        entry.expected.projection ??
        Array.from(
          new Map(
            entry.expected.raw
              .filter((r) => r.kind < 2)
              .map((r) => [
                r.name,
                [r.name, entry.expected.raw.some((x) => x.name === r.name && x.kind === 1) ? "function" : "var"],
              ]),
          ).values(),
        ),
    },
  })),
);

// Each row is run independently, then disarmed and recovered. Fault controls
// exist only in the identified test build; they are absent from shipped Wasm.
export const SCRIPT_PLAN_ALLOCATION_CASES = freeze(
  [
    ["native-plan-header", "compile", 1],
    ["native-record-array", "compile", 2],
    ["source-buffer-staging", "compile", 3],
    ["shim-registry-node", "compile", 4],
    ["owned-name-result-cell", "name", 5],
    ["eval-result-cell", "eval", 6],
    ["post-capture-compilation", "compile", 7],
  ].map(([id, operation, faultSite]) => ({
    id,
    operation,
    faultSite,
    source: "var allocated; function allocatedFn() { return 11; } globalThis.__probe_body_effect__++; allocatedFn;",
    sourceSha256: createHash("sha256")
      .update("var allocated; function allocatedFn() { return 11; } globalThis.__probe_body_effect__++; allocatedFn;")
      .digest("hex"),
    expected: {
      returnValue: 0,
      pendingError: "InternalError",
      noPartialPublishedPlan: true,
      bodyEffect: 0,
      globalsUnchanged: true,
      privateResourcesBalanced: true,
      unrelatedPlanUsable: true,
      readyOnCellFailure: faultSite === 5 || faultSite === 6,
      populatedCaptureUnwound: faultSite === 7,
      recovery: {
        raw: records(["allocated", 0], ["allocatedFn", 1]),
        completion: "same-as-global-function",
        functionResult: 11,
        bodyEffect: 1,
      },
    },
    status: "NOT_RUN",
  })),
);

export const SCRIPT_PLAN_ARTIFACT_CASES = freeze([
  { id: "old-artifact-old-adapter", requiredVersion: 0, expected: "accept" },
  { id: "new-artifact-old-adapter", requiredVersion: 0, expected: "accept" },
  { id: "old-artifact-producer", requiredVersion: 1, expected: "reject" },
  ...[
    "wrong-pin",
    "edited-preimage",
    "partial-patch",
    "second-application",
    "patch-digest",
    "manifest-schema",
    "postimage-digest",
    "missing-export",
    "wrong-signature",
    "wrong-version",
    "advertised-absent",
    "unadvertised-present",
    "missing-provenance",
    "binary-digest",
    "abi-digest",
    "patch-provenance",
  ].map((id) => ({ id, expected: "reject" })),
]);
