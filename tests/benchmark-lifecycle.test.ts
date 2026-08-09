// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { buildHistory } from "../benchmarks/report.js";
import {
  landingAuxiliaryRuntimeSource,
  normalizeBatchedRuntimeSamples,
} from "../scripts/lib/landing-runtime-timing.mjs";
import {
  BENCHMARK_ARTIFACT_FILES,
  BENCHMARK_PROVENANCE,
  compareSnapshots,
  packageSnapshot,
  runCli,
  validateInternalSuite,
  validateSnapshot,
} from "../scripts/benchmark-lifecycle.mjs";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";
const TOOL_VERSIONS = {
  node: "v25.7.0",
  platform: "linux",
  arch: "x64",
  pnpm: "10.30.2",
  git: "git version 2.50.0",
  typescript: "5.7.3",
  binaryen: "125.0.0",
  esbuild: "0.25.12",
  wasmtime: "wasmtime 46.0.1",
  rustc: "rustc 1.94.1",
  cargo: "cargo 1.94.1",
  javy: "javy 8.1.1",
  componentizeJs: "0.20.0",
};

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(resolve(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function write(path: string, value: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function writeJson(path: string, value: unknown): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sizeRow(overrides: Record<string, unknown> = {}) {
  return {
    name: "bench",
    label: "benchmark",
    jsSizeRaw: 1_000,
    jsSizeGzip: 500,
    wasmSizeRaw: 1_000,
    wasmSizeGzip: 500,
    hostJsGzip: 500,
    wasmTotalGzip: 1_000,
    jsParseMs: 10,
    wasmCompileMs: 10,
    hostJsParseMs: 10,
    wasmTotalMs: 20,
    ...overrides,
  };
}

function fixtureRoot(): string {
  const root = temporaryRoot("benchmark-lifecycle-source-");
  const results = resolve(root, "benchmarks/results");

  writeJson(resolve(results, "latest.json"), [
    { name: "internal", strategy: "js", medianMs: 100 },
    { name: "internal", strategy: "gc-native", medianMs: 100 },
  ]);
  write(resolve(results, "latest.md"), "# synthetic benchmark\n");
  writeJson(resolve(results, "history.json"), []);
  writeJson(resolve(results, "playground-benchmark-sidebar.json"), [
    { path: "examples/bench.ts", mode: "warm", wasmUs: 100, jsUs: 200 },
  ]);
  writeJson(resolve(results, "playground-benchmark-sidebar-no-jit.json"), [
    { path: "examples/bench.ts", mode: "no-jit", wasmUs: 100, jsUs: 200 },
  ]);
  writeJson(resolve(results, "size-benchmarks.json"), {
    timestamp: "2026-07-29T12:00:00.000Z",
    howItWorks: { sample: sizeRow({ name: "sample" }) },
    benchmarks: [sizeRow()],
  });
  writeJson(resolve(results, "loadtime-benchmarks.json"), {
    timestamp: "2026-07-29T12:00:00.000Z",
    benchmarks: [
      {
        name: "bench",
        label: "benchmark",
        path: "examples/bench.ts",
        exportName: "bench_bench",
        jsUrl: "loadtime/bench.mjs",
        wasmUrl: "loadtime/bench.wasm",
      },
    ],
  });
  writeJson(resolve(results, "wasm-host-wasmtime-hot-runtime.json"), [
    {
      name: "bench",
      scenario: "cold",
      wasmUs: 100,
      jsUs: 200,
      javyUs: 1_100,
      starlingMonkeyUs: 950,
      auxiliaryMeasurement: "measured-current-run",
      lanesProvenance:
        "cold javyUs/starlingMonkeyUs measured by scripts/generate-wasmtime-hot-runtime.mjs with benchmark host",
    },
    {
      name: "bench",
      scenario: "warm",
      wasmUs: 100,
      jsUs: 200,
      javyUs: 1_000,
      starlingMonkeyUs: 900,
      auxiliaryMeasurement: "measured-current-run",
      lanesProvenance:
        "warm javyUs/starlingMonkeyUs measured by scripts/generate-wasmtime-hot-runtime.mjs with benchmark host",
      auxiliaryWarmWrapper: "fixed-runtime-arg-single-entry-batch-no-return-wit",
      auxiliaryWarmBatchIterations: 8,
      javyWarmMode: "rust-wasmtime-fresh-dynamic-plugin-instance-single-entry-batch",
      starlingMonkeyWarmMode: "rust-wasmtime-fresh-component-instance-single-entry-batch",
    },
  ]);
  writeJson(resolve(results, "wasm-host-wasmtime-module-size-per-test.json"), [
    { name: "AOT compiled", path: "bench", value: 1_000, label: "1.0 kB", jsUs: 500 },
    { name: "Interpreter", path: "bench", value: 3_000, label: "3.0 kB", jsUs: 500 },
    { name: "Engine", path: "bench", value: 15_000_000, label: "15.0 MB", jsUs: 500 },
  ]);

  write(resolve(results, "loadtime/bench.mjs"), new Uint8Array(1_000).fill(1));
  write(resolve(results, "loadtime/bench.wasm"), new Uint8Array(1_000).fill(2));
  write(resolve(results, "loadtime/runtime.js"), new Uint8Array(1_000).fill(3));
  write(resolve(results, "loadtime/binaryen.js"), new Uint8Array(1_000).fill(4));
  return root;
}

function packageFixture(root: string): string {
  const snapshot = temporaryRoot("benchmark-lifecycle-snapshot-");
  packageSnapshot({
    root,
    output: snapshot,
    sourceSha: SOURCE_SHA,
    generatedAt: "2026-07-29T12:00:00.000Z",
    toolVersions: TOOL_VERSIONS,
    allowNonGitRoot: true,
  });
  return snapshot;
}

function mutateJson(path: string, mutate: (document: any) => void): void {
  const document = JSON.parse(readFileSync(path, "utf8"));
  mutate(document);
  writeJson(path, document);
}

describe("benchmark artifact lifecycle", () => {
  it("merges sparse timestamp files into history without dropping or duplicating committed points", () => {
    const results = temporaryRoot("benchmark-history-");
    writeJson(resolve(results, "history.json"), [
      { timestamp: "2026-04-01T10:00:00.000Z", benchmarks: { preserved: { js: 1 } } },
      { timestamp: "2026-04-05T19:23:21.684Z", benchmarks: { stale: { js: 2 } } },
      { timestamp: "2026-04-05T19:23:21.684Z", benchmarks: { duplicate: { js: 3 } } },
    ]);
    writeJson(resolve(results, "2026-04-05T19-23-21-684Z.json"), [{ name: "refreshed", strategy: "js", medianMs: 4 }]);

    buildHistory(results);

    const history = JSON.parse(readFileSync(resolve(results, "history.json"), "utf8"));
    expect(history).toEqual([
      { timestamp: "2026-04-01T10:00:00.000Z", benchmarks: { preserved: { js: 1 } } },
      { timestamp: "2026-04-05T19:23:21.684Z", benchmarks: { refreshed: { js: 4 } } },
    ]);
  });

  it("packages the complete fresh artifact set with hashes and honest provenance", () => {
    const snapshot = packageFixture(fixtureRoot());
    const manifest = validateSnapshot(snapshot, SOURCE_SHA);

    expect(manifest.sourceSha).toBe(SOURCE_SHA);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.generatedAt).toBe("2026-07-29T12:00:00.000Z");
    expect(manifest.toolVersions).toEqual(TOOL_VERSIONS);
    expect(manifest.provenance).toEqual(BENCHMARK_PROVENANCE);
    expect(manifest.provenance.carriedForwardMeasurements).toContainEqual(
      expect.stringContaining("Javy and StarlingMonkey"),
    );
    expect(manifest.provenance.unsupportedArtifacts.map((row: { path: string }) => row.path)).toEqual([
      "benchmarks/results/wasm-host-wasmtime-module-size.json",
    ]);
    expect(manifest.artifacts.map((row: { path: string }) => row.path)).toEqual(
      expect.arrayContaining([
        ...BENCHMARK_ARTIFACT_FILES,
        "benchmarks/results/loadtime/bench.mjs",
        "benchmarks/results/loadtime/bench.wasm",
        "benchmarks/results/loadtime/runtime.js",
        "benchmarks/results/loadtime/binaryen.js",
      ]),
    );
    expect(manifest.artifacts.every((row: { sha256: string }) => /^[0-9a-f]{64}$/.test(row.sha256))).toBe(true);
    expect(
      manifest.artifacts.some(
        (row: { path: string }) => row.path === "benchmarks/results/wasm-host-wasmtime-module-size.json",
      ),
    ).toBe(false);
    expect(
      manifest.artifacts.some(
        (row: { path: string }) => row.path === "benchmarks/results/wasm-host-wasmtime-module-size-per-test.json",
      ),
    ).toBe(true);

    const manifestPath = resolve(snapshot, "benchmarks/results/benchmark-manifest.json");
    const validManifestText = readFileSync(manifestPath, "utf8");
    const unavailableToolManifest = JSON.parse(validManifestText);
    unavailableToolManifest.toolVersions.javy = "unavailable";
    writeJson(manifestPath, unavailableToolManifest);
    expect(() => validateSnapshot(snapshot)).toThrow(/missing tool version: javy/);
    write(manifestPath, validManifestText);

    write(resolve(snapshot, "benchmarks/results/loadtime/bench.wasm"), new Uint8Array([0]));
    expect(() => validateSnapshot(snapshot)).toThrow(/integrity mismatch/);
  });

  it("measures auxiliary lanes when selected and supports explicit unchanged-input carry mode", () => {
    const generator = readFileSync(
      resolve(import.meta.dirname, "../scripts/generate-wasmtime-hot-runtime.mjs"),
      "utf8",
    );
    const wrapper = landingAuxiliaryRuntimeSource(
      "export const benchmark = { runtimeArg: 4 };\nexport function run(n) { return n + 1; }\n",
      4,
      8,
    );

    expect(wrapper).toContain("function __benchRun");
    expect(wrapper).toContain("__benchIteration < 8");
    expect(wrapper).toContain("__benchRun(4)");
    expect(normalizeBatchedRuntimeSamples([80, 120], 8)).toEqual([10, 15]);
    expect(generator).toContain("javy warm (single-entry batch");
    expect(generator).toContain("starlingmonkey warm (single-entry batch");
    expect(generator).toContain('AUXILIARY_MODE === "measure"');
    expect(generator).toContain("Carrying forward unchanged Javy and StarlingMonkey controls");
    expect(generator).not.toContain("landingWasmtimeReusedInstanceSamples");
    expect(generator).not.toContain("JAVY_WARM_NUMBERS_MS");
    expect(generator).not.toContain("STARLINGMONKEY_WARM_NUMBERS_MS");
  });

  it("keeps recursive Fibonacci numerically typed for strict IR compilation", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../website/public/benchmarks/competitive/programs/fib-recursive.js"),
      "utf8",
    );

    expect(source).toContain("/** @param {number} n @returns {number} */\nfunction fib(n)");
  });

  it("rejects missing, stale, and unsafe compiled loadtime asset sets", () => {
    const missing = fixtureRoot();
    mutateJson(resolve(missing, "benchmarks/results/loadtime-benchmarks.json"), (document) => {
      document.benchmarks[0].wasmUrl = "loadtime/missing.wasm";
    });
    expect(() => packageFixture(missing)).toThrow(/Missing benchmark artifact/);

    const stale = fixtureRoot();
    write(resolve(stale, "benchmarks/results/loadtime/stale.wasm"), new Uint8Array([0]));
    expect(() => packageFixture(stale)).toThrow(/incomplete or stale/);

    const unsafe = fixtureRoot();
    mutateJson(resolve(unsafe, "benchmarks/results/loadtime-benchmarks.json"), (document) => {
      document.benchmarks[0].jsUrl = "loadtime/../escape.mjs";
    });
    expect(() => packageFixture(unsafe)).toThrow(/safe loadtime/);
  });

  it("refuses to claim a source SHA for a non-Git root outside synthetic-fixture mode", () => {
    expect(() =>
      packageSnapshot({
        root: fixtureRoot(),
        output: temporaryRoot("benchmark-lifecycle-untrusted-source-"),
        sourceSha: SOURCE_SHA,
        generatedAt: "2026-07-29T12:00:00.000Z",
        toolVersions: TOOL_VERSIONS,
      }),
    ).toThrow(/not a Git checkout/);
  });

  it("does not leak a Git hook's repository environment into synthetic fixture roots", () => {
    const previousGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd: resolve(import.meta.dirname, ".."),
      encoding: "utf8",
    }).trim();
    try {
      expect(() => packageFixture(fixtureRoot())).not.toThrow();
    } finally {
      if (previousGitDir === undefined) Reflect.deleteProperty(process.env, "GIT_DIR");
      else process.env.GIT_DIR = previousGitDir;
    }
  });

  it("requires every displayed module-size lane for each program", () => {
    const incomplete = fixtureRoot();
    mutateJson(resolve(incomplete, "benchmarks/results/wasm-host-wasmtime-module-size-per-test.json"), (document) =>
      document.splice(2, 1),
    );
    expect(() => packageFixture(incomplete)).toThrow(/all three displayed lanes/);
  });

  it.each([
    {
      label: "playground-warm",
      file: "playground-benchmark-sidebar.json",
      mutate(document: any) {
        document[0].wasmUs = 150;
        document[0].jsUs = 180;
      },
    },
    {
      label: "playground-no-jit",
      file: "playground-benchmark-sidebar-no-jit.json",
      mutate(document: any) {
        document[0].wasmUs = 150;
        document[0].jsUs = 180;
      },
    },
    {
      label: "wasmtime-hot",
      file: "wasm-host-wasmtime-hot-runtime.json",
      mutate(document: any) {
        document[1].wasmUs = 150;
        document[1].jsUs = 180;
      },
    },
    {
      label: "internal",
      file: "latest.json",
      mutate(document: any) {
        document[0].medianMs = 90;
        document[1].medianMs = 150;
      },
    },
  ])("detects substantial $label primary runtime regressions", ({ label, file, mutate }) => {
    const baseline = packageFixture(fixtureRoot());
    const candidateRoot = fixtureRoot();
    mutateJson(resolve(candidateRoot, "benchmarks/results", file), mutate);
    const report = compareSnapshots(baseline, packageFixture(candidateRoot));
    expect(report.regressions).toContainEqual(expect.stringContaining(label));
  });

  it("compares deterministic size, loadtime timing, and compiled loadtime asset growth", () => {
    const baseline = packageFixture(fixtureRoot());
    const candidateRoot = fixtureRoot();
    mutateJson(resolve(candidateRoot, "benchmarks/results/size-benchmarks.json"), (document) => {
      document.benchmarks[0].wasmSizeRaw = 1_300;
      document.benchmarks[0].wasmTotalMs = 31;
      document.benchmarks[0].wasmCompileMs = 15;
      document.benchmarks[0].jsParseMs = 8;
    });
    mutateJson(
      resolve(candidateRoot, "benchmarks/results/wasm-host-wasmtime-module-size-per-test.json"),
      (document) => {
        document[0].value = 1_300;
      },
    );
    write(resolve(candidateRoot, "benchmarks/results/loadtime/bench.wasm"), new Uint8Array(1_300).fill(2));

    const report = compareSnapshots(baseline, packageFixture(candidateRoot));
    expect(report.regressions).toContainEqual(expect.stringContaining("size benchmarks/bench:wasmSizeRaw"));
    expect(report.regressions).toContainEqual(expect.stringContaining("loadtime benchmarks/bench"));
    expect(report.regressions).toContainEqual(expect.stringContaining("loadtime-asset"));
    expect(report.regressions).toContainEqual(expect.stringContaining("wasmtime-module-size bench:AOT compiled"));
    expect(report.notes).toContainEqual(expect.stringContaining("compile-only benchmarks/bench"));
  });

  it("uses paired JS controls and keeps change-scoped auxiliary runtimes as controls", () => {
    const baseline = packageFixture(fixtureRoot());
    const candidateRoot = fixtureRoot();
    mutateJson(resolve(candidateRoot, "benchmarks/results/playground-benchmark-sidebar.json"), (document) => {
      document[0].wasmUs = 115;
      document[0].jsUs = 190;
    });
    mutateJson(resolve(candidateRoot, "benchmarks/results/wasm-host-wasmtime-hot-runtime.json"), (document) => {
      document[1].javyUs = 100_000;
      document[1].starlingMonkeyUs = 100_000;
    });

    const report = compareSnapshots(baseline, packageFixture(candidateRoot));
    expect(report.regressions).toHaveLength(0);
    expect(report.informational).toContainEqual(expect.stringContaining("change-scoped comparison controls"));
  });

  it("keeps unbatched sub-millisecond internal timings informational", () => {
    const baselineRoot = fixtureRoot();
    mutateJson(resolve(baselineRoot, "benchmarks/results/latest.json"), (document) => {
      document[0].medianMs = 0.01;
      document[1].medianMs = 0.01;
    });
    const candidateRoot = fixtureRoot();
    mutateJson(resolve(candidateRoot, "benchmarks/results/latest.json"), (document) => {
      document[0].medianMs = 0.01;
      document[1].medianMs = 0.02;
    });

    const report = compareSnapshots(packageFixture(baselineRoot), packageFixture(candidateRoot));
    expect(report.regressions).toHaveLength(0);
    expect(report.notes).toContainEqual(expect.stringContaining("sample span below 1ms"));
  });

  it("keeps unbatched sub-millisecond loadtime timings informational", () => {
    const baselineRoot = fixtureRoot();
    mutateJson(resolve(baselineRoot, "benchmarks/results/size-benchmarks.json"), (document) => {
      Object.assign(document.benchmarks[0], {
        jsParseMs: 0.01,
        wasmCompileMs: 0.01,
        hostJsParseMs: 0.01,
        wasmTotalMs: 0.02,
      });
    });
    const candidateRoot = fixtureRoot();
    mutateJson(resolve(candidateRoot, "benchmarks/results/size-benchmarks.json"), (document) => {
      Object.assign(document.benchmarks[0], {
        jsParseMs: 0.01,
        wasmCompileMs: 0.02,
        hostJsParseMs: 0.02,
        wasmTotalMs: 0.04,
      });
    });

    const report = compareSnapshots(packageFixture(baselineRoot), packageFixture(candidateRoot));
    expect(report.regressions.filter((row: string) => row.startsWith("loadtime "))).toHaveLength(0);
    expect(report.notes).toContainEqual(expect.stringContaining("loadtime benchmarks/bench: sample span below 1ms"));
  });

  it("accepts honestly carried auxiliary controls and rejects missing source provenance", () => {
    const root = fixtureRoot();
    mutateJson(resolve(root, "benchmarks/results/wasm-host-wasmtime-hot-runtime.json"), (document) => {
      for (const row of document) {
        row.auxiliaryMeasurement = "carried-forward-unchanged-inputs";
        row.auxiliarySourceSha = SOURCE_SHA;
        row.lanesProvenance = `javyUs/starlingMonkeyUs carried forward. Source: ${SOURCE_SHA}.`;
      }
    });
    const snapshot = packageFixture(root);
    expect(validateSnapshot(snapshot).sourceSha).toBe(SOURCE_SHA);
    const carried = JSON.parse(
      readFileSync(resolve(snapshot, "benchmarks/results/wasm-host-wasmtime-hot-runtime.json"), "utf8"),
    );
    expect(carried[0]).toMatchObject({ javyUs: 1_100, starlingMonkeyUs: 950 });
    expect(carried[1]).toMatchObject({ javyUs: 1_000, starlingMonkeyUs: 900 });

    const invalidRoot = fixtureRoot();
    mutateJson(resolve(invalidRoot, "benchmarks/results/wasm-host-wasmtime-hot-runtime.json"), (document) => {
      document[0].auxiliarySourceSha = "not-a-sha";
      document[0].auxiliaryMeasurement = "carried-forward-unchanged-inputs";
      document[0].lanesProvenance = "javyUs/starlingMonkeyUs carried forward.";
    });
    expect(() => packageFixture(invalidRoot)).toThrow(/missing carry provenance/);
  });

  it("reports candidate omissions and returns the documented compare exit code", () => {
    const baseline = packageFixture(fixtureRoot());
    const candidateRoot = fixtureRoot();
    mutateJson(resolve(candidateRoot, "benchmarks/results/latest.json"), (document) => {
      document.splice(1, 1);
    });
    const candidate = packageFixture(candidateRoot);

    expect(compareSnapshots(baseline, candidate).regressions).toContainEqual(
      expect.stringContaining("missing candidate row"),
    );
    expect(runCli(["compare", "--baseline", baseline, "--candidate", candidate])).toBe(1);
  });

  it("publishes canonical promoted loadtime assets to both Pages destinations", () => {
    const buildPages = readFileSync(resolve(import.meta.dirname, "../scripts/build-pages.js"), "utf8");
    expect(buildPages).toContain(
      'resolvePreferredFileOrNull(\n  join(BENCHMARKS_RESULTS_DIR, "loadtime"),\n  join(PUBLIC_BENCH, "loadtime"),',
    );
    expect(buildPages).toContain('copyDirectory(loadtimeSource, join(TOP_BENCH_RESULTS, "loadtime"))');
    expect(buildPages).toContain('copyDirectory(loadtimeSource, join(PLAYGROUND_BENCHMARKS_RESULTS_DIR, "loadtime"))');
  });

  it("makes refresh freshness fail closed while preserving benchmark history", () => {
    const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/benchmark-refresh.yml"), "utf8");
    const cleanup = workflow.slice(
      workflow.indexOf("- name: Remove checkout-stale benchmark outputs"),
      workflow.indexOf("# Both sides run sequentially"),
    );
    for (const artifact of [
      "latest.json",
      "latest.md",
      "playground-benchmark-sidebar.json",
      "playground-benchmark-sidebar-no-jit.json",
      "size-benchmarks.json",
      "loadtime-benchmarks.json",
      "wasm-host-wasmtime-hot-runtime.json",
      "wasm-host-wasmtime-module-size-per-test.json",
      "loadtime",
    ]) {
      expect(cleanup).toContain(artifact);
    }
    expect(cleanup).not.toContain('"$results/history.json"');
    expect(workflow).toContain("- name: Detect auxiliary benchmark changes");
    expect(workflow).toContain('auxiliary_mode="inherit"');
    expect(workflow).toContain('if [ "${{ github.event_name }}" != "pull_request" ] &&');
    expect(workflow).toContain('[ "${{ github.ref }}" = "refs/heads/main" ] &&');
    expect(workflow).toContain('auxiliary_mode="measure"');
    expect(workflow).toContain('elif [ "${{ github.event_name }}" = "workflow_dispatch" ]; then');
    expect(workflow).toContain("- name: Install and verify pinned Javy");
    expect(workflow).toContain(
      "if: steps.auxiliary.outputs.mode == 'measure' || steps.auxiliary.outputs.legacy_manifest_javy == 'true'",
    );
    expect(workflow).toContain("legacy_manifest_javy");
    expect(workflow).toContain("not-used (auxiliary measurements inherited)");
    expect(workflow).toContain("BENCHMARK_AUXILIARY_RUNTIME_BASELINE");
    expect(workflow).toContain("website/public/benchmarks/competitive/programs");
    expect(workflow).toContain("- name: Detect benchmark timing methodology migration");
    expect(workflow).toContain("steps.timing_methodology.outputs.changed != 'true'");
    expect(workflow).toContain("- name: Record timing methodology migration");
    const comparison = workflow.slice(
      workflow.indexOf("- name: Compare same-run PR base and candidate"),
      workflow.indexOf("- name: Record timing methodology migration"),
    );
    expect(comparison).toContain("continue-on-error: true");
    const promotion = workflow.slice(workflow.indexOf("promote-benchmarks:"));
    expect(promotion).toContain("- name: Checkout trusted measured main revision");
    expect(promotion).toContain("ref: ${{ needs.measure-and-gate.outputs.source_sha }}");
    expect(promotion).not.toContain("ref: main");
  });
});

// ---------------------------------------------------------------------------
// #3904 prerequisite — failed-strategy rows are legal in latest.json
// ---------------------------------------------------------------------------
//
// `benchmark-refresh.yml` validates a PR's candidate snapshot with the
// BASELINE's copy of `benchmark-lifecycle.mjs`, so a PR cannot weaken its own
// gate. That means an artifact FORMAT change cannot go green in the same PR
// that teaches the validator about it — the validator has to land on `main`
// first. These tests pin the tolerant behaviour so the harness change can
// follow safely.

describe("validateInternalSuite — failed strategy rows (#3904 prerequisite)", () => {
  const ok = [
    { name: "string/split", strategy: "js", medianMs: 0.25 },
    { name: "string/split", strategy: "gc-native", medianMs: 0.87 },
  ];

  it("accepts a well-formed suite with no failed rows", () => {
    expect(() => validateInternalSuite(ok)).not.toThrow();
  });

  it("accepts a failed row carrying zero timings and an error message", () => {
    const rows = [
      ...ok,
      {
        name: "string/split",
        strategy: "linear-memory",
        medianMs: 0,
        status: "failed",
        error: "memory access out of bounds",
      },
    ];
    expect(() => validateInternalSuite(rows)).not.toThrow();
  });

  it("still rejects a zero median on a row that does NOT declare failure", () => {
    const rows = [...ok, { name: "string/split", strategy: "linear-memory", medianMs: 0 }];
    expect(() => validateInternalSuite(rows)).toThrow(/medianMs must be a positive number/);
  });

  it("requires a failed row to explain itself", () => {
    const rows = [...ok, { name: "string/split", strategy: "linear-memory", medianMs: 0, status: "failed" }];
    expect(() => validateInternalSuite(rows)).toThrow(/error must be a non-empty message/);
  });

  it("refuses a failed JS reference row — the baseline must always measure", () => {
    const rows = [{ name: "string/split", strategy: "js", medianMs: 0, status: "failed", error: "boom" }];
    expect(() => validateInternalSuite(rows)).toThrow(/JS baseline must always measure/);
  });
});
