// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5197 Slice D — a generic NewPromiseCapability(C) behind
// `Promise.resolve.call(C, x)` and `Promise.reject.call(C, r)`.
//
// §27.2.4.7 and §27.2.4.6 are the same three steps — `NewPromiseCapability(C)`,
// `Call(capability.[[Resolve]] or [[Reject]], undefined, «x»)`, return
// `[[Promise]]` — so the two methods share one emitter and differ only in which
// capability slot the value is handed to.
//
// A SEPARATE file for the same reason the Slice C file is separate: one Vitest
// fork per file with `--max-old-space-size=512`, and every exact row compiles a
// full harness module.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile, instantiateWasm } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

type Lane = "host" | "standalone";

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262");
const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" && existsSync(join(TEST262_ROOT, "harness", "assert.js"));

// Standalone only, deliberately: the whole arm is gated on
// `isStandalonePromiseActive`, so the JS-host lane reaches these rows through
// the host `Promise` and is byte-identical before and after. The compiled
// control below still runs in BOTH lanes, which is what pins that claim.
//
// The exact rows this slice flipped, standalone, measured with
// `scripts/run-test262-paths.mts` over the whole 140-row ES2015
// `built-ins/Promise/**` corpus: 11 pass → 19 pass, 0 regressions.
//
// The last two are downstream, not direct: they observe the
// GetCapabilitiesExecutor's own `length` and extensibility, and the ONLY way
// they reach one is `Promise.resolve.call(NotPromise)` — a one-argument call
// on a custom `C`, which is exactly what this slice admits. They pass because
// Slice B already made that executor a real built-in function object.
const EXACT_ROWS = [
  "built-ins/Promise/resolve/capability-invocation-error.js",
  "built-ins/Promise/resolve/ctx-ctor-throws.js",
  "built-ins/Promise/reject/capability-invocation-error.js",
  "built-ins/Promise/reject/ctx-ctor-throws.js",
  "built-ins/Promise/reject/capability-executor-not-callable.js",
  "built-ins/Promise/reject/S25.4.4.4_A3.1_T1.js",
  "built-ins/Promise/executor-function-extensible.js",
  "built-ins/Promise/executor-function-length.js",
] as const;

// Every observable step of NewPromiseCapability, in one compiled module so the
// mechanism is covered without paying six more harness compiles.
const CAPABILITY_SOURCE = `
  export function test(): number {
    // §27.2.4.7 steps 4-5 — construct C with a GetCapabilitiesExecutor, then
    // call the captured [[Resolve]] with «x».
    let seen: any = null;
    let calls = 0;
    let resolvedWith: any = null;
    const Capturing = function (executor: any) {
      calls += 1;
      seen = executor;
      executor(
        function (v: any) {
          resolvedWith = v;
        },
        function () {},
      );
    };
    Promise.resolve.call(Capturing, 41);
    if (calls !== 1) return 1;
    if (typeof seen !== "function") return 2;
    if (resolvedWith !== 41) return 3;

    // The ONE-argument spelling still runs the whole protocol; the settled
    // value is undefined.
    resolvedWith = 7;
    Promise.resolve.call(Capturing);
    if (calls !== 2) return 4;
    if (resolvedWith !== undefined) return 5;

    // §27.2.4.6 step 4 — reject reaches the OTHER slot, and only that one.
    let rejectedWith: any = null;
    let resolveSlotCalls = 0;
    const RejCapturing = function (executor: any) {
      executor(
        function () {
          resolveSlotCalls += 1;
        },
        function (r: any) {
          rejectedWith = r;
        },
      );
    };
    Promise.reject.call(RejCapturing, 24601);
    if (rejectedWith !== 24601) return 6;
    if (resolveSlotCalls !== 0) return 7;

    // §27.2.1.5 steps 8-9 — IsCallable on both captured slots, checked AFTER C
    // returns. A C that never reaches its formal supplies neither.
    const ZeroArg = function () {};
    let threw = 0;
    try {
      Promise.reject.call(ZeroArg, 4);
    } catch (e) {
      threw = e instanceof TypeError ? 1 : 2;
    }
    if (threw !== 1) return 8;

    // …and a C that supplies non-callables fails the same check.
    const NotCallable = function (executor: any) {
      executor(1, "x");
    };
    threw = 0;
    try {
      Promise.resolve.call(NotCallable, 1);
    } catch (e) {
      threw = e instanceof TypeError ? 1 : 2;
    }
    if (threw !== 1) return 9;

    // §27.2.1.5 step 7 — an abrupt completion out of Construct(C) propagates
    // unchanged, so it is NOT swallowed into a rejected promise.
    const Throwing = function () {
      throw new RangeError("boom");
    };
    threw = 0;
    try {
      Promise.resolve.call(Throwing);
    } catch (e) {
      threw = e instanceof RangeError ? 1 : 2;
    }
    if (threw !== 1) return 10;

    // …and so does one out of the settle call itself (§27.2.4.7 step 6).
    const PoisonResolve = function (executor: any) {
      executor(
        function () {
          throw new RangeError("resolve");
        },
        function () {},
      );
    };
    threw = 0;
    try {
      Promise.resolve.call(PoisonResolve, 1);
    } catch (e) {
      threw = e instanceof RangeError ? 1 : 2;
    }
    if (threw !== 1) return 11;

    // The intrinsic receiver is untouched by all of the above.
    let observed = 0;
    Promise.resolve(3).then(function (v: any) {
      observed = v;
    });
    if (observed !== 0 && observed !== 3) return 12;
    return 0;
  }
`;

async function runExactRow(relativePath: (typeof EXACT_ROWS)[number], lane: Lane) {
  try {
    return await runTest262File(
      join(TEST262_ROOT, "test", relativePath),
      "issue-5197",
      120_000,
      lane === "standalone" ? lane : undefined,
    );
  } finally {
    restoreHostBuiltins();
  }
}

async function runControl(lane: Lane): Promise<number> {
  try {
    const result = await compile(CAPABILITY_SOURCE, {
      fileName: "issue-5197-promise-generic-capability-control.ts",
      ...(lane === "standalone" ? { target: "standalone" as const, nativeStrings: true } : {}),
    });
    expect(
      result.success,
      result.success ? "" : result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n"),
    ).toBe(true);
    if (!result.success) return -1;

    // (#5272) The in-process test262 probe does NOT apply the standalone
    // host-import leak check CI's sharded lane applies, so assert it here —
    // the whole point of this slice is that a custom `C` no longer reaches
    // `env::Promise_resolve` / `env::Promise_reject`.
    if (lane === "standalone") {
      expect(result.imports?.length ?? 0, "standalone control must remain host-free").toBe(0);
    }
    const built = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(
      result.binary,
      built.env,
      built.string_constants,
      built.string_constants16,
    );
    built.setInstance?.(instance);
    return (instance.exports as { test: () => number }).test();
  } finally {
    restoreHostBuiltins();
  }
}

describe("#5197 Slice D — generic NewPromiseCapability(C)", () => {
  it.skipIf(!TEST262_AVAILABLE).each(EXACT_ROWS)(
    "passes the exact standalone Test262 row %s",
    async (relativePath) => {
      const result = await runExactRow(relativePath, "standalone");
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    180_000,
  );

  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: runs NewPromiseCapability(C) for an arbitrary constructor`, async () => {
      await expect(runControl(lane)).resolves.toBe(0);
    });
  }
});
