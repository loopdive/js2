// #5353 — the SHARDED test262 lane's `Temporal` wiring.
//
// #5248 wired the in-process runner and left this lane alone, so the published
// conformance number carried no Temporal gain. These tests guard the four
// invariants that make the sharded wiring safe, none of which is visible in a
// row's verdict until it is already wrong. None of them builds the provider
// (~42 s cold): the seams are the gate, the pre-warm stamp, and two source
// contracts that a bundle rebuild or a refactor can silently break.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readTemporalPrewarmStamp,
  temporalCacheDir,
  test262NeedsTemporalGlobal,
  writeTemporalPrewarmStamp,
} from "../scripts/test262-temporal.mjs";
import { test262NeedsTemporalGlobal as runnerGate } from "./test262-runner.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), "utf-8");

describe("#5353 ONE gate for both lanes", () => {
  it("the in-process runner answers exactly what the shared gate answers", () => {
    // The two lanes score the same corpus and the baseline validator samples one
    // against the other. A gate that drifts does not show up as a bug — it shows
    // up as phantom baseline drift on an unrelated PR (#5248's own note).
    const cases: Array<[string, string[] | undefined]> = [
      ["built-ins/Temporal/Duration/basic.js", undefined],
      ["intl402/Temporal/PlainDate/prototype/toString/basic.js", undefined],
      ["built-ins/Date/prototype/toTemporalInstant/basic.js", ["Temporal"]],
      ["built-ins/Date/prototype/toTemporalInstant/basic.js", undefined],
      ["language/statements/const/basic.js", ["BigInt"]],
    ];
    for (const [path, features] of cases) {
      expect(runnerGate(path, { features })).toBe(test262NeedsTemporalGlobal(path, features));
    }
  });

  it("the shared gate honours an opt-out set AFTER it was imported", () => {
    // Lazy read, not a module-scope const: ESM imports are hoisted, so a
    // consumer that sets the variable in its own module body (the baseline
    // validator does) would otherwise be ignored without a word.
    const previous = process.env.JS2WASM_TEST262_TEMPORAL;
    process.env.JS2WASM_TEST262_TEMPORAL = "0";
    try {
      expect(test262NeedsTemporalGlobal("built-ins/Temporal/Duration/basic.js", undefined)).toBe(false);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST262_TEMPORAL");
      else process.env.JS2WASM_TEST262_TEMPORAL = previous;
    }
  });

  it("resolves the cache dir from JS2WASM_TEMPORAL_CACHE", () => {
    const previous = process.env.JS2WASM_TEMPORAL_CACHE;
    process.env.JS2WASM_TEMPORAL_CACHE = "/tmp/js2wasm-probe-temporal";
    try {
      expect(temporalCacheDir()).toBe("/tmp/js2wasm-probe-temporal");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEMPORAL_CACHE");
      else process.env.JS2WASM_TEMPORAL_CACHE = previous;
    }
  });
});

describe("#5353 the pre-warm stamp", () => {
  it("round-trips, and a missing stamp reads as null rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "js2wasm-temporal-stamp-"));
    try {
      expect(readTemporalPrewarmStamp(dir)).toBeNull();
      expect(readTemporalPrewarmStamp(join(dir, "does-not-exist"))).toBeNull();
      writeTemporalPrewarmStamp(dir, {
        key: "abc123",
        namespace: "js2wasm:npm:@js-temporal/polyfill:abc123",
        bytes: 2_028_477,
        buildMs: 41_641,
        cacheHit: false,
      });
      const stamp = readTemporalPrewarmStamp(dir);
      expect(stamp?.key).toBe("abc123");
      expect(typeof stamp?.generatedAt).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#5353 the sharded worker's refusals", () => {
  const worker = read("scripts", "test262-worker.mjs");

  it("never builds the provider without a matching pre-warm stamp", () => {
    // A fork is killed at 30 s and a cold build is ~42 s. Building here would
    // not be slow, it would time out — in every fork, for every Temporal row.
    // The stamp is what makes `buildTemporalProvider` a ~1 s cache read.
    const loader = worker.slice(worker.indexOf("async function getWorkerTemporalProvider"));
    const body = loader.slice(0, loader.indexOf("\nasync function doCompile"));
    expect(body).toContain("readTemporalPrewarmStamp");
    expect(body.indexOf("readTemporalPrewarmStamp")).toBeLessThan(body.indexOf("buildTemporalProvider("));
    expect(body).toContain("temporalProviderCacheKey");
  });

  it("links only on the HOST lane", () => {
    // The provider is `--target gc` with the JS host adapter. Under
    // `--target standalone` its imports trip this worker's own #2961 guard
    // ("standalone target emitted host imports"), which would convert honest
    // standalone failures into compile_errors against the #1897 floor.
    expect(worker).toMatch(/msg\.temporal === true && target === undefined/);
  });

  it("routes provider registration through the runtime copy its imports came from", () => {
    // `registerLinkedProviderModule` writes into `src/runtime.ts`'s module-level
    // #5225 decoder registry. The worker carries TWO bundled copies of the
    // runtime (one inside compiler-bundle.mjs); registering in the copy that did
    // not build the import object leaves the reader's registry empty, which does
    // not throw — it silently answers a cross-module struct field with the
    // reader's `ref.test`-miss default of 0.
    expect(worker).toContain("linkedRuntime: runtimeBundle");
    expect(worker).toContain("linkedModules: result.linkedModules ?? []");
    const importObject = read("scripts", "test262-import-object.mjs");
    expect(importObject).toContain("options.linkedRuntime ??");
  });

  it("feature-detects the bundle exports instead of importing them by name", () => {
    // Several helper scripts still esbuild `src/index.ts` / `src/runtime.ts`
    // directly. A named import of a missing export is a LOAD-time error, which
    // would take the whole sharded lane down over an optional feature.
    expect(worker).toMatch(/import \* as compilerBundle from "\.\/compiler-bundle\.mjs"/);
    expect(worker).toMatch(/import \* as runtimeBundle from "\.\/runtime-bundle\.mjs"/);
    expect(worker).toContain("function temporalWiringAvailable()");
  });
});

describe("#5353 the bundles publish what the worker needs", () => {
  it("the compiler bundle entry re-exports the provider builder", () => {
    const entry = read("scripts", "compiler-bundle-entry.ts");
    for (const name of ["buildTemporalProvider", "compileWithTemporalGlobal", "temporalProviderCacheKey"]) {
      expect(entry).toContain(name);
    }
  });

  it("the runtime bundle entry re-exports the linked-provider lifecycle", () => {
    const entry = read("scripts", "runtime-bundle-entry.ts");
    expect(entry).toContain("instantiateLinkedProviders");
    expect(entry).toContain("wireCompiledInstance");
    expect(entry).toContain('export * from "../src/runtime.ts"');
  });

  it("every test262 bundle build uses the ENTRIES, not src/ directly", () => {
    // A build that bypasses the entries produces a bundle without the provider,
    // and the worker then degrades EVERY Temporal row to the unlinked lane —
    // silently, apart from one stderr line.
    for (const file of [
      join(".github", "workflows", "test262-sharded.yml"),
      join("scripts", "run-test262-vitest.sh"),
    ]) {
      const source = read(file);
      expect(source).not.toContain("esbuild src/runtime.ts");
      expect(source).not.toContain("esbuild src/index.ts");
    }
  });
});

describe("#5353 the parent pre-warms before the fork pool starts", () => {
  it("the sharded workflow builds the provider in its own job and hands shards the cache", () => {
    const workflow = read(".github", "workflows", "test262-sharded.yml");
    expect(workflow).toContain("scripts/prewarm-temporal-provider.mjs");
    expect(workflow).toContain("temporal-provider-${{ github.run_id }}");
    // Both shard jobs must depend on it, or a shard races an artifact that is
    // not there yet and silently runs unlinked.
    expect(
      workflow.match(/needs: \[changes, mg-artifact-probe, runtime-eval-provider, temporal-provider\]/),
    ).not.toBeNull();
    expect(workflow.match(/needs: \[changes, runtime-eval-provider, temporal-provider\]/)).not.toBeNull();
    expect(workflow).toContain("JS2WASM_TEMPORAL_CACHE: .test262-cache/temporal");
  });

  it("the local test262 entry point pre-warms too", () => {
    const script = read("scripts", "run-test262-vitest.sh");
    expect(script).toContain("node scripts/prewarm-temporal-provider.mjs");
    expect(script).toContain("JS2WASM_TEMPORAL_CACHE");
  });

  it("the pool forwards the parent's per-row decision to the worker", () => {
    const pool = read("scripts", "compiler-pool.ts");
    expect(pool).toContain("temporal: opts.temporal || false");
    const shared = read("tests", "test262-shared.ts");
    // Host lane only, and computed from the shared gate.
    expect(shared).toContain("IS_HOST_LANE && test262NeedsTemporalGlobal(relPath, meta.features)");
    // Every runTest call site — primary, poison retry, timeout retry — must
    // carry it, or a retried row is scored against a different realm than the
    // attempt it replaces.
    expect(shared.match(/temporal: needsTemporal/g)?.length).toBe(3);
  });
});
