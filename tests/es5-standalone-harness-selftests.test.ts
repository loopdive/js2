// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4251) HARNESS FIDELITY RATCHET — the standalone-compiled test262 harness
// measured against its OWN self-tests.
//
// `test262/test/harness/*.js` are not conformance tests; they are the harness
// exercising its own helpers. `propertyhelper-verifynotwritable-writable.js`
// asserts that `verifyNotWritable` on a WRITABLE property throws a
// `Test262Error`; `sta.js` asserts that including sta.js really exposes
// `Test262Error`, `Test262Error.prototype.toString` and `$DONOTEVALUATE`. When
// one of these fails, the helper is lying, and every conformance test that
// includes it is measuring something other than what it claims to.
//
// Measured 2026-08-08 on the standalone lane: 44 pass / 116 total. That number
// had no test guarding it, so a helper could rot (or quietly be fixed) with no
// signal. This file pins a curated subset as a RATCHET.
//
// ## How to read a failure here
//
//   - an entry expected `"pass"` now fails  → a real regression; the named
//     harness helper stopped working, and everything that includes it is now
//     measuring less than it reports.
//   - an entry expected `"fail"` now passes → someone FIXED it. That is the
//     good direction: flip the entry to `"pass"` in EXPECTED below, in the same
//     PR, so the ratchet holds the new floor.
//
// Do NOT relax an entry from `"pass"` to `"fail"` to make CI green. That is the
// exact silent rot this file exists to prevent; fix the compiler instead.
//
// ## Why `runTest262File` and not `wrapTest`
//
// `runTest262File` compiles the LITERAL upstream harness
// (`assembleOriginalHarness`) — the real sta.js / assert.js / propertyHelper.js
// sources. The `wrapTest` preamble is a different, TypeScript-shim harness
// whose `verifyNotWritable` / `verifyEnumerable` / `verifyConfigurable` are
// literal `{}` no-ops (`buildPreamble`, tests/test262-runner.ts). Pointing this
// file at the shim would measure the shim, not the compiler.
//
// ## Why the refusal provider is built first
//
// `assembleOriginalHarness` emits a `$262.evalScript` shim (`return
// eval(sourceText)`) into EVERY assembled test, so every module here links
// `js2wasm:runtime-eval`. Without a provider in the cache the module dies at
// instantiation and the link error OVERWRITES the real signature (#4162) —
// every entry would read `"fail"` for the wrong reason.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import {
  buildRuntimeEvalRefusalProviderSource,
  computeCompilerBundleHash,
  defaultRuntimeEvalProviderCacheDir,
  readCachedRuntimeEvalProvider,
  runtimeEvalProviderCacheKey,
  runtimeEvalRefusalCachePath,
  writeCachedRuntimeEvalProvider,
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
} from "../scripts/runtime-eval-provider.mjs";
import { resetTest262RuntimeEvalProviderForTest } from "../scripts/test262-import-object.mjs";
import { runTest262File } from "./test262-runner.js";

const REPO_ROOT = join(__dirname, "..");
const HARNESS_DIR = join(REPO_ROOT, "test262", "test", "harness");
const HARNESS_AVAILABLE = existsSync(join(HARNESS_DIR, "sta.js"));
if (!HARNESS_AVAILABLE && process.env.CI) {
  throw new Error("#4251: test262 harness self-tests missing under CI — this file must not silently skip.");
}

/**
 * Curated canaries, with the status measured on the standalone lane 2026-08-08.
 *
 * The set is deliberately small (each entry compiles the whole assembled
 * harness) and deliberately BIASED toward the negative helpers and `sta.js` —
 * the ones whose failure modes are hardest to notice from a conformance number,
 * because a lying helper does not fail, it just stops checking.
 *
 * `note` is the root cause as diagnosed in plan/issues/4251-*.md, so a reader
 * who flips an entry knows what they are claiming to have fixed.
 */
const EXPECTED: ReadonlyArray<{ file: string; status: "pass" | "fail"; note: string }> = [
  // ── sta.js: the harness's own identity contract ────────────────────────────
  {
    file: "sta.js",
    status: "pass",
    note: "FIXED by #4480 S1 (every ordinary function now owns a materialised .prototype); was #4251 RC2. Flipped 2026-08-16 per the ratchet's own instruction.",
  },

  // ── negative property helpers: must THROW, and the throw must be identifiable
  {
    file: "propertyhelper-verifynotwritable-writable.js",
    status: "pass",
    note: "fixed by #4262 — the error-ctor carrier now resolves `err.constructor` through the SAME global `compileIdentifierValueRead` prefers (`$__mod_<name>`), so the identity matches the harness's own declaration.",
  },
  {
    file: "propertyhelper-verifynotenumerable-enumerable.js",
    status: "pass",
    note: "fixed by #4262 — the error-ctor carrier now resolves `err.constructor` through the SAME global `compileIdentifierValueRead` prefers (`$__mod_<name>`), so the identity matches the harness's own declaration.",
  },
  {
    file: "propertyhelper-verifynotconfigurable-configurable.js",
    status: "pass",
    note: "fixed by #4262 — the error-ctor carrier now resolves `err.constructor` through the SAME global `compileIdentifierValueRead` prefers (`$__mod_<name>`), so the identity matches the harness's own declaration.",
  },
  {
    file: "propertyhelper-verifywritable-not-writable.js",
    status: "pass",
    note: "fixed by #4262 — the error-ctor carrier now resolves `err.constructor` through the SAME global `compileIdentifierValueRead` prefers (`$__mod_<name>`), so the identity matches the harness's own declaration.",
  },
  {
    file: "propertyhelper-verifyenumerable-not-enumerable.js",
    status: "pass",
    note: "fixed by #4262 — the error-ctor carrier now resolves `err.constructor` through the SAME global `compileIdentifierValueRead` prefers (`$__mod_<name>`), so the identity matches the harness's own declaration.",
  },

  // ── positive property helpers that ALREADY work — these are the ones a
  //    descriptor change is most likely to break, so they are the load-bearing
  //    "pass" entries in this file.
  {
    file: "propertyhelper-verifywritable-writable.js",
    status: "pass",
    note: "isWritable's write-then-compare works standalone; a descriptor regression breaks this first.",
  },
  {
    file: "propertyhelper-verifyenumerable-enumerable.js",
    status: "pass",
    note: "for-in based isEnumerable works standalone.",
  },
  {
    file: "propertyhelper-verifyconfigurable-configurable.js",
    status: "pass",
    note: "isConfigurable's delete-then-hasOwn works standalone (the sloppy delete TypeError is swallowed by the helper's own try/catch).",
  },
  {
    file: "propertyhelper-verifynotwritable-not-writable-strict.js",
    status: "pass",
    note: "the non-throwing half of the negative helper — proves the helper is reached at all.",
  },
  {
    file: "propertyhelper-verifynotenumerable-not-enumerable.js",
    status: "pass",
    note: "non-throwing half.",
  },
  {
    file: "propertyhelper-verifynotconfigurable-not-configurable.js",
    status: "pass",
    note: "non-throwing half.",
  },
  {
    file: "propertyhelper-verifyconfigurable-not-configurable.js",
    status: "pass",
    note: "fixed by #4262 — the error-ctor carrier now resolves `err.constructor` through the SAME global `compileIdentifierValueRead` prefers (`$__mod_<name>`), so the identity matches the harness's own declaration.",
  },

  // ── assert.throws: the single most-included harness helper ─────────────────
  {
    file: "assert-throws-custom.js",
    status: "pass",
    note: "assert.throws against a user-declared error constructor.",
  },
  {
    file: "assert-throws-native.js",
    status: "pass",
    note: "assert.throws against a builtin error constructor — builtin .constructor identity DOES work standalone.",
  },
  {
    file: "assert-throws-custom-typeerror.js",
    status: "pass",
    note: "FIXED upstream (shadow-yield family, #4482-era); was #4251 RC1. Flipped 2026-08-16 per the ratchet's own instruction.",
  },

  // ── compareArray / verifyProperty representative entries ──────────────────
  {
    file: "compare-array-samevalue.js",
    status: "pass",
    note: "FIXED upstream (function .name/.prototype substrate, #4437/#4480-era); was #4251 RC1. Flipped 2026-08-16 per the ratchet's own instruction.",
  },
  {
    file: "verifyProperty-restore.js",
    status: "pass",
    note: "fixed by #4230's descriptor-bag work (flipped when the wave-3 merge landed); was the verifyProperty restore/configurable family.",
  },
];

/**
 * Make the refusal provider available in the shared cache, compiling it if the
 * prebuild step has not run in this checkout. Idempotent and cache-keyed — the
 * same write `scripts/build-runtime-eval-provider.mjs --refusal-only` performs.
 */
async function ensureRefusalProviderCached(): Promise<void> {
  const source = buildRuntimeEvalRefusalProviderSource();
  const key = runtimeEvalProviderCacheKey(source, computeCompilerBundleHash());
  const dir = defaultRuntimeEvalProviderCacheDir();
  if (readCachedRuntimeEvalProvider(dir, key, runtimeEvalRefusalCachePath)) return;
  const r = await compile(source, RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS);
  expect(r.success, "refusal provider must compile").toBe(true);
  writeCachedRuntimeEvalProvider(dir, key, r.binary!, runtimeEvalRefusalCachePath);
  resetTest262RuntimeEvalProviderForTest();
}

describe.skipIf(!HARNESS_AVAILABLE)("#4251 standalone harness self-tests", () => {
  beforeAll(async () => {
    await ensureRefusalProviderCached();
  }, 600_000);

  // (#4003) CI-LOAD MITIGATION — not a fix, and not cosmetic.
  //
  // `runTest262File` compiles AND runs a standalone module synchronously inside
  // the vitest worker. Nineteen of those back to back (~73s total, 5-6s for the
  // propertyHelper entries) starve the worker's event loop, so the birpc
  // reporter calls queued during those blocking spans miss their deadline and
  // vitest aborts the whole run with
  //   Error: [vitest-worker]: Timeout calling "onTaskUpdate"
  // exiting NONZERO while every assertion PASSED (19/19). Observed twice
  // consecutively on PR #4258 (73.35s and 72.71s runs), and tracked as a
  // general pre-commit/CI problem by #4003. The `--pool=forks --singleFork
  // --no-file-parallelism` flags the changed-root-tests hook already passes do
  // NOT help: the contention is inside the single worker, not across workers.
  //
  // Yielding a macrotask between tests lets the pending RPC responses drain.
  // Two rounds because a single `setImmediate` still lands ahead of some
  // queued I/O callbacks (same reason tests/test262-runner.ts uses two).
  //
  // Measured A/B locally, same flags CI uses, 2026-08-09:
  //   without this hook → exit 1, 19/19 assertions pass, 1 onTaskUpdate error
  //   with    this hook → exit 0, 19/19 assertions pass, 0 errors
  // The mitigated run was the SLOWER of the two (98.3s of test time vs 86.5s),
  // so it is not passing merely by being under lighter load.
  //
  // The DURABLE fix is the tests/dogfood/acorn.test.ts (#1710) pattern: run the
  // compile in a CHILD PROCESS so it never touches the worker thread at all.
  // That is a restructure of this canary suite and deliberately out of scope
  // for this PR — see the handoff note on #4003.
  afterEach(async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  });

  for (const { file, status, note } of EXPECTED) {
    it(`${file} — expected ${status}`, { timeout: 180_000 }, async () => {
      const result = (await runTest262File(join(HARNESS_DIR, file), "harness-selftest", 60_000, "standalone")) as {
        status: string;
        error?: string;
      };
      // A `skip` is never an acceptable answer here: these files carry no
      // proposal/feature gate, so a skip means the runner's filter changed
      // underneath us and the entry is no longer measuring anything.
      expect(result.status, `${file} must not be skipped by the runner`).not.toBe("skip");

      const actual = result.status === "pass" ? "pass" : "fail";
      expect(
        actual,
        actual === "fail"
          ? `REGRESSION: ${file} now fails.\n  root cause on record: ${note}\n  runner said: ${result.error ?? "(no detail)"}\n` +
              `  Do NOT relax this entry to "fail" — fix the compiler.`
          : `FIXED: ${file} now PASSES. Flip its EXPECTED entry to "pass" in this file, in the same PR.\n  root cause that was on record: ${note}`,
      ).toBe(status);
    });
  }

  it("the recorded floor is non-trivial", () => {
    // Guards against the file being hollowed out into an all-"fail" table,
    // which would ratchet nothing.
    const passing = EXPECTED.filter((e) => e.status === "pass").length;
    expect(passing, "at least 6 canaries must be recorded as passing").toBeGreaterThanOrEqual(6);
  });
});
