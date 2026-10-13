import * as realFs from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CompilerPool } from "../../scripts/compiler-pool.js";
import { FixtureController, finite, pending, workerPath } from "./fixture-controller.js";

const unused = () => {
  throw new Error("Unexpected compiler/provider invocation in completion fixture");
};
interface Scenario {
  id: string;
  drainTimeout?: boolean;
  closeFailure?: boolean;
  primitiveFailure?: "undefined" | "null";
  occupiedMarker?: boolean;
}
async function scenario(options: Scenario) {
  const controller = new FixtureController();
  // Retain every owned fixture directory and result; no test-data deletion.
  const directory = realFs.mkdtempSync(join(tmpdir(), "compiler-pool-completion-"));
  const prefix = `shutdown-${randomUUID()}`;
  const fixturePath = join(directory, "excluded-proposal.js");
  realFs.writeFileSync(fixturePath, "// actual controlled discovery input\n", { flag: "wx" });
  const keys = [
    "COMPILER_POOL_CLOSE_FIXTURE_MODE",
    "RUN_TIMESTAMP",
    "TEST262_RESULT_PREFIX",
    "COMPILER_POOL_SIZE",
    "TEST262_TARGET",
    "TEST262_COMPILER_PATH",
    "TEST262_SEMANTIC_PROVIDERS",
    "TEST262_INCLUDE_PROPOSALS",
    "TEST262_REALM_CANARY",
    "TEST262_STANDALONE_LINKED",
    "TEST262_ORACLE_MODE",
    "JS2WASM_TEMPORAL_CACHE",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const oldUnhandled = new Set(process.listeners("unhandledRejection"));
  const modules = [
    "vitest",
    "fs",
    "../../scripts/compiler-pool.js",
    "../test262-runner.js",
    "../test262-original-harness.js",
    "../../scripts/test262-import-object.mjs",
  ];
  let before: (() => unknown) | undefined, after: (() => unknown) | undefined;
  let timeout: unknown, pool: CompilerPool | undefined, jsonlFd: number | undefined;
  let hasPrimary = false,
    primary: unknown;
  const errors: unknown[] = [];
  const callbacks: (() => Promise<void>)[] = [],
    ownedFds = new Set<number>();
  const writes: { path: string; options: unknown }[] = [],
    closeAttempts: number[] = [];
  const marker = join(directory, `${prefix}-results-${options.id}.shard-1-of-1.complete.json`);
  const redirect = (path: any) =>
    typeof path === "string" && (path.includes("benchmarks/results") || path.endsWith(".test262-cache"))
      ? join(directory, basename(path))
      : path;
  try {
    Object.assign(process.env, {
      COMPILER_POOL_CLOSE_FIXTURE_MODE: "held",
      RUN_TIMESTAMP: options.id,
      TEST262_RESULT_PREFIX: prefix,
      COMPILER_POOL_SIZE: "1",
      TEST262_TARGET: "standalone",
      TEST262_COMPILER_PATH: "legacy",
      TEST262_SEMANTIC_PROVIDERS: "auto",
      JS2WASM_TEMPORAL_CACHE: join(directory, "temporal"),
    });
    Reflect.deleteProperty(process.env, "TEST262_INCLUDE_PROPOSALS");
    Reflect.deleteProperty(process.env, "TEST262_STANDALONE_LINKED");
    Reflect.deleteProperty(process.env, "TEST262_ORACLE_MODE");
    vi.resetModules();
    vi.doMock("vitest", () => ({
      beforeAll: (callback: () => unknown) => {
        before = callback;
      },
      afterAll: (callback: () => unknown, cap: unknown) => {
        after = callback;
        timeout = cap;
      },
      describe: { concurrent: (_name: string, callback: () => void) => callback() },
      it: (_name: string, callback: () => Promise<void>) => callbacks.push(callback),
    }));
    vi.doMock("../../scripts/compiler-pool.js", () => ({
      CompilerPool: class ActualFixturePool extends CompilerPool {
        private injectPrimitive = options.primitiveFailure !== undefined;
        constructor(size: number, kind: "compile" | "unified") {
          super(size, kind, workerPath);
          pool = this;
          controller.observe(this);
        }
        shutdown() {
          if (this.injectPrimitive) {
            this.injectPrimitive = false;
            // Fault seam on the actual original registered hook, not a copied algorithm.
            return Promise.reject(options.primitiveFailure === "null" ? null : undefined);
          }
          if (options.drainTimeout) controller.expectedTimeoutPools.add(this);
          return super.shutdown(options.drainTimeout ? 80 : 5_000);
        }
      },
    }));
    vi.doMock("fs", () => ({
      ...realFs,
      mkdirSync: (path: any, opts: any) => realFs.mkdirSync(redirect(path), opts),
      openSync: (path: any, flags: any, mode: any) => {
        const fd = realFs.openSync(redirect(path), flags, mode);
        if (String(path).includes(prefix)) {
          jsonlFd = fd;
          ownedFds.add(fd);
        }
        return fd;
      },
      closeSync: (fd: number) => {
        closeAttempts.push(fd);
        realFs.closeSync(fd);
        ownedFds.delete(fd);
        // Delegate the owned close, then immediately double-close that same FD
        // synchronously. No intervening await or fabricated I/O error.
        if (options.closeFailure && fd === jsonlFd) realFs.closeSync(fd);
      },
      writeFileSync: (path: any, data: any, opts: any) => {
        writes.push({ path: redirect(path), options: opts });
        return realFs.writeFileSync(redirect(path), data, opts);
      },
    }));
    vi.doMock("../test262-runner.js", () => ({
      discoverTest262TestFiles: () => [
        { category: "lifecycle", filePath: fixturePath, relPath: "language/lifecycle/proposal.js" },
      ],
      getTest262ExactManifestFile: () => undefined,
      matchesPathFilter: () => true,
      parseMeta: () => ({ features: [], flags: [], includes: [] }),
      classifyTestScope: () => ({ official: false, scope: "proposal" }),
      classifyError: unused,
      createTestSandbox: unused,
      extractWasmExceptionMessage: unused,
      isModuleGoal: unused,
      isScriptGoal: unused,
      shouldSkip: unused,
      standaloneHostImportError: unused,
      test262FixtureRelativePath: unused,
    }));
    vi.doMock("../test262-original-harness.js", () => ({
      assembleOriginalHarness: unused,
      assembleNativeHarness: unused,
      assembleLinkedHarness: unused,
    }));
    vi.doMock("../../scripts/test262-import-object.mjs", () => ({
      instantiateTest262Module: unused,
      TEST262_DYNAMIC_CODE_POLICY: "unused",
    }));
    const shared = await import("../test262-shared.js");
    shared.runTest262Chunk(0, 1);
    expect(callbacks).toHaveLength(1);
    expect(timeout).toBe(10_000);
    before!();
    await finite(pool!.ready(), "actual beforeAll ready");
    await callbacks[0]();
    if (options.occupiedMarker) realFs.writeFileSync(marker, "retained original marker\n", { flag: "wx" });
    const hook = after!() as Promise<void>,
      state = pending(hook);
    const result = hook.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const proc = controller.first(pool!);
    if (!options.primitiveFailure) {
      await controller.message(proc, "signal");
      expect(state.settled).toBe(false);
      expect(writes).toHaveLength(0);
      expect(realFs.existsSync(marker)).toBe(Boolean(options.occupiedMarker));
      if (!options.drainTimeout) {
        controller.release(proc);
        await finite(controller.children.get(proc)!.done, "actual hook child close");
      }
    }
    const outcome = await finite(result, "original registered afterAll");
    expect(closeAttempts).toEqual([jsonlFd]);
    if (options.drainTimeout || options.closeFailure || options.primitiveFailure) {
      expect(outcome.ok).toBe(false);
      expect(writes).toHaveLength(0);
      expect(realFs.existsSync(marker)).toBe(false);
      if (outcome.ok) throw new Error("Expected exact hook rejection");
      const original = options.primitiveFailure === "null" ? null : undefined;
      if (options.closeFailure && (options.drainTimeout || options.primitiveFailure)) {
        expect(outcome.error).toBeInstanceOf(AggregateError);
        const ordered = (outcome.error as AggregateError).errors;
        if (options.primitiveFailure) expect(ordered[0]).toBe(original);
        else expect(ordered[0]).toMatchObject({ name: "CompilerPoolShutdownTimeoutError" });
        expect(ordered[1]).toMatchObject({ code: "EBADF" });
      } else if (options.primitiveFailure) expect(outcome.error).toBe(original);
      else if (options.drainTimeout) expect(outcome.error).toMatchObject({ name: "CompilerPoolShutdownTimeoutError" });
      else expect(outcome.error).toMatchObject({ code: "EBADF" });
    } else if (options.occupiedMarker) {
      expect(outcome).toMatchObject({ ok: false, error: { code: "EEXIST" } });
      expect(realFs.readFileSync(marker, "utf8")).toBe("retained original marker\n");
    } else {
      expect(outcome).toEqual({ ok: true });
      expect(writes).toEqual([{ path: marker, options: { flag: "wx" } }]);
      expect(JSON.parse(realFs.readFileSync(marker, "utf8"))).toMatchObject({
        schema: "test262-shard-completion-v2",
        registeredTests: 1,
        callbacksStarted: 1,
        callbacksSettled: 1,
        allCallbacksSettled: true,
        canonicalVerdicts: 0,
        exclusions: { proposal: { count: 1, paths: ["language/lifecycle/proposal.js"] } },
      });
    }
  } catch (error) {
    hasPrimary = true;
    primary = error;
  } finally {
    for (const module of modules)
      try {
        vi.doUnmock(module);
      } catch (error) {
        errors.push(error);
      }
    for (const listener of process.listeners("unhandledRejection"))
      if (!oldUnhandled.has(listener)) process.off("unhandledRejection", listener);
    for (const fd of ownedFds)
      try {
        realFs.closeSync(fd);
      } catch (error) {
        errors.push(error);
      }
    for (const key of keys) {
      if (previous[key] === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = previous[key];
    }
    try {
      await controller.cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    if (hasPrimary) throw new AggregateError([primary, ...errors], "Hook and owned cleanup failed");
    throw new AggregateError(errors, "Hook owned cleanup failed");
  }
  if (hasPrimary) throw primary;
}

describe.sequential("Test262 actual registered shutdown completion hook", () => {
  it.each<Scenario>([
    { id: "held-success" },
    { id: "drain-timeout", drainTimeout: true },
    { id: "real-close-EBADF", closeFailure: true },
    { id: "ordered-drain-close", drainTimeout: true, closeFailure: true },
    { id: "thrown-undefined", primitiveFailure: "undefined" },
    { id: "thrown-null", primitiveFailure: "null" },
    { id: "ordered-undefined-close", primitiveFailure: "undefined", closeFailure: true },
    { id: "exclusive-marker", occupiedMarker: true },
  ])("$id retains exact outcomes and completion boundary", scenario, 10_000);
});
