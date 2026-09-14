// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Synthetic contract tests only: no compiler or historical fixture executes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { TARGET } from "./issue-5807-observation-trace.mjs";
import {
  interventionOverlay,
  assertArm,
  assertInterventionEnvironment,
  MODE_ENV,
  OVERLAY_PATHS,
} from "./issue-5807-registry-intervention.mjs";

const observed = Object.freeze({
  "src/runtime.ts":
    "export function resetLinkedProjectRegistry(): void {\n  _crossModuleStructs.reset();\n  resetMirrorOwners();\n}\n",
  "scripts/test262-worker.mjs": "// original worker\n    const importObj = buildImports(\n      result.imports);\n",
  "scripts/compiler-pool.ts": "original pool",
  "scripts/test262-import-object.mjs": "original import assembly",
  "src/runtime/cross-module-struct-owners.ts": "original decoder registry",
  "scripts/issue-5807-observation-runtime.mjs": "original observer",
});

test("original control preserves every observation-only source byte", () => {
  assert.deepEqual(interventionOverlay("original", observed), observed);
});
test("sham and reset source outputs are exactly equal", () => {
  assert.deepEqual(interventionOverlay("sham", observed), interventionOverlay("reset", observed));
});
test("overlay changes only the two approved paths", () => {
  for (const arm of ["sham", "reset"]) {
    const result = interventionOverlay(arm, observed);
    assert.deepEqual(Object.keys(result).sort(), Object.keys(observed).sort());
    assert.deepEqual(
      Object.keys(result)
        .filter((path) => result[path] !== observed[path])
        .sort(),
      [...OVERLAY_PATHS].sort(),
    );
  }
});
test("overlay does not mutate its input map", () => {
  const before = JSON.stringify(observed);
  interventionOverlay("reset", observed);
  assert.equal(JSON.stringify(observed), before);
});
test("diagnostic export invokes only the decoder registration reset", () => {
  const result = interventionOverlay("reset", observed)["src/runtime.ts"];
  const added = result.slice(0, result.indexOf("export function resetLinkedProjectRegistry"));
  assert.match(
    added,
    /export function __issue5807ResetDecoderRegistry\(\): void \{\s*_crossModuleStructs\.reset\(\);\s*\}/,
  );
  assert.doesNotMatch(added, /resetLinkedProjectRegistry\(|resetMirror|resetTemporal|\.owners|\.states/);
  assert.ok(result.endsWith(observed["src/runtime.ts"]));
});
test("worker uses the existing runtime bundle and an admitted runtime switch", () => {
  const result = interventionOverlay("reset", observed)["scripts/test262-worker.mjs"];
  assert.match(result, /process\.env\.REPLAY_REGISTRY_INTERVENTION_MODE/);
  assert.match(result, /if \(__5807interventionMode === "reset"\) runtimeBundle\.__issue5807ResetDecoderRegistry\(\)/);
  assert.doesNotMatch(result, /compilerBundle\.__issue5807|resetLinkedProjectRegistry\(|resetTemporalRealmGlobals\(/);
  assert.ok(
    result.indexOf("runtimeBundle.__issue5807ResetDecoderRegistry()") <
      result.indexOf("const importObj = buildImports("),
  );
});
test("hook refuses linked, Temporal, non-original-harness or non-gc targets", () => {
  const result = interventionOverlay("sham", observed)["scripts/test262-worker.mjs"];
  assert.match(result, /__5807linked !== 0/);
  assert.match(result, /msg\.temporal === true/);
  assert.match(result, /!originalHarness/);
  assert.match(result, /msg\.target !== "gc"/);
  assert.match(result, /target !== undefined/);
});
for (const arm of ["original", "sham", "reset"]) {
  test(`environment accepts exact installed ${arm} mode`, () =>
    assertInterventionEnvironment(arm, { [MODE_ENV]: arm }));
  test(`environment rejects missing ${arm} mode`, () => assert.throws(() => assertInterventionEnvironment(arm, {})));
  for (const other of ["original", "sham", "reset"].filter((value) => value !== arm)) {
    test(`environment rejects installed ${arm} with ${other} switch`, () =>
      assert.throws(() => assertInterventionEnvironment(arm, { [MODE_ENV]: other })));
  }
}
test("unknown arms are rejected", () => {
  for (const arm of [undefined, "", "both", "production"]) {
    assert.throws(() => assertArm(arm));
    assert.throws(() => interventionOverlay(arm, observed));
  }
});
test("missing and duplicate runtime anchors reject", () => {
  for (const source of ["", observed["src/runtime.ts"].repeat(2)]) {
    assert.throws(() => interventionOverlay("sham", { ...observed, "src/runtime.ts": source }));
  }
});
test("missing and duplicate worker anchors reject", () => {
  for (const source of ["", observed["scripts/test262-worker.mjs"].repeat(2)]) {
    assert.throws(() => interventionOverlay("reset", { ...observed, "scripts/test262-worker.mjs": source }));
  }
});

function executeSyntheticHook(mode, overrides = {}) {
  const calls = [];
  const context = {
    process: { env: { [MODE_ENV]: mode } },
    msg: { __observation5807: { path: TARGET }, temporal: false, target: "gc" },
    result: { linkedModules: [], imports: [] },
    originalHarness: true,
    target: undefined,
    observation: { emit: (event) => calls.push(event) },
    runtimeBundle: { __issue5807ResetDecoderRegistry: () => calls.push("reset") },
    buildImports: () => calls.push("buildImports"),
    ...overrides,
  };
  runInNewContext(interventionOverlay("sham", observed)["scripts/test262-worker.mjs"], context);
  return calls;
}
test("executed sham hook observes but never resets", () => {
  assert.deepEqual(executeSyntheticHook("sham"), ["intervention-before", "intervention-after", "buildImports"]);
});
test("executed active hook resets exactly once before import construction", () => {
  assert.deepEqual(executeSyntheticHook("reset"), [
    "intervention-before",
    "reset",
    "intervention-after",
    "buildImports",
  ]);
});
test("strict target uses the same reset seam", () => {
  assert.deepEqual(
    executeSyntheticHook("reset", { msg: { __observation5807: { path: TARGET + " [strict rerun]" }, target: "gc" } }),
    ["intervention-before", "reset", "intervention-after", "buildImports"],
  );
});
test("seed and nearby labels never receive a reset", () => {
  for (const path of ["test/built-ins/Temporal/seed.js", TARGET + " [retry]", TARGET + ".other"]) {
    assert.deepEqual(executeSyntheticHook("reset", { msg: { __observation5807: { path } } }), ["buildImports"]);
  }
});
test("executed target hook rejects all inadmissible execution conditions", () => {
  for (const overrides of [
    { result: { linkedModules: [{}] } },
    { msg: { __observation5807: { path: TARGET }, temporal: true } },
    { originalHarness: false },
    { target: "standalone" },
    { target: "gc" },
    { msg: { __observation5807: { path: TARGET }, target: "standalone" } },
    { msg: { __observation5807: { path: TARGET } } },
  ])
    assert.throws(() => executeSyntheticHook("reset", overrides), /invalid decoder-only/);
});
test("executed worker rejects unknown or missing runtime modes", () => {
  for (const mode of [undefined, "original", "typo"])
    assert.throws(() => executeSyntheticHook(mode), /invalid registry intervention environment/);
});

for (const pin of ["129e3efd4530ae1be56dbf5fdea54ddbbd87443e", "efa0908e09998c73da592fba32708c7ecca8d6e5"]) {
  test(`hook accepts actual pinned GC normalization at ${pin}`, () => {
    const source = execFileSync("git", ["show", `${pin}:scripts/test262-worker.mjs`], { encoding: "utf8" });
    const matches = [...source.matchAll(/function compileTargetFromMessage\(target\) \{[^}]+\}/g)];
    assert.equal(matches.length, 1);
    const target = runInNewContext(`${matches[0][0]}; compileTargetFromMessage("gc")`);
    assert.equal(target, undefined);
    assert.deepEqual(executeSyntheticHook("reset", { target }), [
      "intervention-before",
      "reset",
      "intervention-after",
      "buildImports",
    ]);
  });
}
