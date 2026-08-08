// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4238 slice 1 — the QuickJS eval ENGINE behind the frozen
 * `js2wasm:runtime-eval` seam.
 *
 * SELF-GATING. Default CI has no clang-toolchain guarantee and this lane must
 * NEVER build implicitly, so the suite runs only when a built provider is
 * already reachable:
 *   `JS2WASM_EVAL_ENGINE=quickjs` was requested, OR the keyed artifact
 *   (or `JS2WASM_QUICKJS_ARTIFACT_DIR`) plus the compiled adapter are present
 *   in `.test262-cache`.
 * Otherwise the whole file skips with a message naming the prebuild command.
 *
 * The default-path cases (1–3) are the ones that matter most: they assert that
 * with the flag unset the selector behaves exactly as it did before #4238, and
 * that a bad flag value fails LOUDLY instead of degrading into the NONE tier.
 */
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import {
  computeCompilerBundleHash,
  defaultRuntimeEvalProviderCacheDir,
  instantiateRuntimeEvalNamespace,
  runtimeEvalProviderCacheKey,
  selectCachedRuntimeEvalProvider,
} from "../scripts/runtime-eval-provider.mjs";
import {
  buildQuickjsAdapterSource,
  quickjsAdapterCachePath,
  quickjsArtifactCacheDir,
  quickjsArtifactCacheKey,
  readQuickjsArtifact,
  QUICKJS_ENGINE_IDENTITY_GLOBAL,
} from "../scripts/quickjs-eval-provider.mjs";

const RUNTIME_EVAL_IMPORT_MODULE = "js2wasm:runtime-eval";
const ENGINE_ENV = "JS2WASM_EVAL_ENGINE";

/** Is a fully built quickjs provider reachable without building anything? */
function quickjsProviderAvailable(): string | null {
  try {
    const cacheDir = defaultRuntimeEvalProviderCacheDir();
    const artifactDir =
      process.env.JS2WASM_QUICKJS_ARTIFACT_DIR ?? quickjsArtifactCacheDir(cacheDir, quickjsArtifactCacheKey());
    const artifact = readQuickjsArtifact(artifactDir);
    if (!artifact) return null;
    const key = runtimeEvalProviderCacheKey(buildQuickjsAdapterSource(artifact.abi), computeCompilerBundleHash());
    return existsSync(quickjsAdapterCachePath(cacheDir, key)) ? artifactDir : null;
  } catch {
    return null;
  }
}

/** Run `fn` with `JS2WASM_EVAL_ENGINE` (and friends) temporarily overridden. */
function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * The slice-1 probe module. A plain `target: "standalone"` USER module — it
 * carries none of the adapter's provider-build options, so it is exactly the
 * shape the engine has to serve.
 *
 * Anti-vacuity: every eval source is composed from the runtime `identityName`
 * binding. An all-literal argument is constant-folded and then evaluated at
 * COMPILE time by `tryStaticEvalInline`, which would make these assertions pass
 * without QuickJS ever running. Expected values likewise depend on the in-band
 * engine marker this adapter installs on the QuickJS realm, so no other
 * evaluator (and no compile-time fold) can produce them.
 */
const PROBE_SOURCE = `
  var identityName = ${JSON.stringify(QUICKJS_ENGINE_IDENTITY_GLOBAL)};
  var indirectNumber = 0;
  var engineNameLength = 0;
  var newFunctionOutcome = 0;
  var directEvalOutcome = 0;

  try {
    indirectNumber = (0, eval)("typeof " + identityName + " === 'string' ? 40 + 2 : 0") as number;
  } catch (err) { indirectNumber = -1; }

  try {
    engineNameLength = (0, eval)(identityName + ".length") as number;
  } catch (err) { engineNameLength = -1; }

  try {
    var made: any = new Function("a", "return a + " + 1);
    newFunctionOutcome = 100 + (made(1) as number);
  } catch (err) {
    newFunctionOutcome = err instanceof TypeError ? 1 : 2;
  }

  function callerScope(): number {
    var localX = 7;
    try {
      return eval("localX + " + 1) as number;
    } catch (err) {
      return err instanceof TypeError ? 1 : 2;
    }
  }
  directEvalOutcome = callerScope();

  export function indirectNumberProbe(): number { return indirectNumber; }
  export function engineNameLengthProbe(): number { return engineNameLength; }
  export function newFunctionProbe(): number { return newFunctionOutcome; }
  export function directEvalProbe(): number { return directEvalOutcome; }
`;

const availableArtifactDir = quickjsProviderAvailable();
const engineRequested = process.env[ENGINE_ENV] === "quickjs";
const enabled = engineRequested || availableArtifactDir !== null;

describe.skipIf(!enabled)("#4238 slice 1 — quickjs eval engine (flag-gated)", () => {
  describe("flag plumbing (default path is untouched)", () => {
    it("case 1 — with no flag the selection is the pre-existing interpreter/refusal tier", () => {
      const selection = withEnv({ [ENGINE_ENV]: undefined }, () => selectCachedRuntimeEvalProvider());
      expect(selection.engine).not.toBe("quickjs");
      expect(["interpreter", "refusal", "none"]).toContain(selection.engine);
      expect(selection.message).not.toMatch(/QUICKJS/);
      expect(selection.message).toMatch(/^(INTERPRETER|REFUSAL|NONE)/);
      // The quickjs bundle descriptor is absent, so every existing consumer
      // (which destructures only `module`/`message`) is unaffected.
      expect((selection as { bundle?: unknown }).bundle).toBeUndefined();
    });

    it("case 2 — an unknown engine value throws loudly (never degrades to NONE)", () => {
      expect(() => withEnv({ [ENGINE_ENV]: "v8" }, () => selectCachedRuntimeEvalProvider())).toThrow(
        /JS2WASM_EVAL_ENGINE="v8" is not a known eval engine/,
      );
      // Explicitly NOT a NONE-tier selection object: the throw must escape the
      // selector's try/catch, or a typo would silently disable eval.
      expect(() => withEnv({ [ENGINE_ENV]: "" }, () => selectCachedRuntimeEvalProvider())).toThrow(
        /is not a known eval engine/,
      );
    });

    it("case 3 — flag set + artifact missing is a hard error naming the prebuild command", () => {
      const empty = mkdtempSync(join(tmpdir(), "js2wasm-qjs-empty-"));
      expect(() =>
        withEnv({ [ENGINE_ENV]: "quickjs", JS2WASM_QUICKJS_ARTIFACT_DIR: empty }, () =>
          selectCachedRuntimeEvalProvider(),
        ),
      ).toThrow(/node scripts\/build-quickjs-eval-provider\.mjs/);
    });

    it("TEST262_DISABLE_RUNTIME_EVAL_PROVIDER wins over the engine flag", () => {
      const selection = withEnv({ [ENGINE_ENV]: "quickjs", TEST262_DISABLE_RUNTIME_EVAL_PROVIDER: "1" }, () =>
        selectCachedRuntimeEvalProvider(),
      );
      expect(selection.engine).toBe("none");
      expect(selection.module).toBeNull();
    });
  });

  describe("end-to-end through the frozen js2wasm:runtime-eval seam", () => {
    let probe: Record<string, () => number>;
    let selection: { engine?: string; message?: string; bundle?: unknown };

    beforeAll(async () => {
      selection = withEnv(
        {
          [ENGINE_ENV]: "quickjs",
          ...(availableArtifactDir ? { JS2WASM_QUICKJS_ARTIFACT_DIR: availableArtifactDir } : {}),
        },
        () => selectCachedRuntimeEvalProvider(),
      ) as typeof selection;

      const compiled = await compile(PROBE_SOURCE, {
        fileName: "quickjs-eval-provider-probe.ts",
        target: "standalone",
        experimentalIR: false,
        skipSemanticDiagnostics: true,
      });
      expect(compiled.success).toBe(true);
      const module = new WebAssembly.Module(compiled.binary!);
      // The probe must actually cross the seam, or it verifies nothing.
      expect(WebAssembly.Module.imports(module).some((i) => i.module === RUNTIME_EVAL_IMPORT_MODULE)).toBe(true);
      const instance = new WebAssembly.Instance(module, {
        [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(selection.bundle),
      });
      (instance.exports as { _start?: () => void })._start?.();
      probe = instance.exports as unknown as Record<string, () => number>;
    }, 120_000);

    it("case 9 — engine selection is observable (selection.engine + message)", () => {
      expect(selection.engine).toBe("quickjs");
      expect(selection.message).toMatch(/^QUICKJS \(artifact [0-9a-f]{12}, adapter key [0-9a-f]{16}\)/);
      expect(selection.message).toMatch(/NOT CI-comparable/);
    });

    it("case 4 — indirect eval of a number literal runs inside QuickJS (slice-1 done-signal)", () => {
      // 42 only if QuickJS evaluated the source against the realm this adapter
      // set up; any other outcome (interpreter, static fold, refusal) gives 0
      // or -1.
      expect(probe.indirectNumberProbe!()).toBe(42);
    });

    it("case 9 (in-band) — evaluated code can read the engine-identity global", () => {
      // "quickjs".length — a real QuickJS string on the realm's globalThis.
      expect(probe.engineNameLengthProbe!()).toBe(7);
    });

    it("case 11 — the not-yet-implemented tiers return typed, catchable TypeErrors", () => {
      // 1 = caught a TypeError. 2 = caught something else. 101 = `new Function`
      // actually worked (it must not — that is slice 2).
      expect(probe.newFunctionProbe!()).toBe(1);
      expect(probe.directEvalProbe!()).toBe(1);
    });
  });
});

if (!enabled) {
  // eslint-disable-next-line no-console
  console.error(
    "[#4238] quickjs eval-engine lane SKIPPED — no built provider. Run: " +
      "node scripts/build-quickjs-eval-provider.mjs (needs clang-18/cmake/git/curl + network), " +
      "or set JS2WASM_QUICKJS_ARTIFACT_DIR to a prebuilt artifact dir.",
  );
}
