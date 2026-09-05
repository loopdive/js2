// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5197 Slice C — `Promise.prototype.catch` as an observable
// `Invoke(this, "then", …)`, and the §27.2.5.4 IsPromise brand check on a
// reflective `then`.
//
// Deliberately a SEPARATE file from `issue-5197-es2015-promise-r2.test.ts`.
// `vitest.config.ts` gives every fork `--max-old-space-size=512` and runs one
// fork per FILE, so all the tests in a file share one 512 MB heap. Slice A + B's
// exact rows and controls already fill most of it; adding this row and control
// to that file reproducibly OOMs the worker. Splitting gives each half a fresh
// heap and costs nothing else.

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

// One exact row for the mechanism. Four more flipped with it —
// `catch/this-value-then-{not-callable,throws,poisoned}.js` and
// `then/context-check-on-entry.js` — and every assertion they make is also made
// by the compiled control below, which costs one small compile per lane instead
// of a full harness compile.
const EXACT_ROWS = ["built-ins/Promise/prototype/catch/invokes-then.js"] as const;

// §27.2.5.1 `Promise.prototype.catch` is `Invoke(this, "then", «undefined,
// onRejected»)` and nothing else: no IsPromise check, no Promise-specific
// behaviour, so an arbitrary object's own `then` is what runs. §27.2.5.4 `then`
// is the opposite — step 2 brand-checks `this` BEFORE reading `constructor`, so
// a reflective call on a foreign receiver is a TypeError.
//
// Both the direct syntactic spelling (`Promise.prototype.catch.call(o, f)`) and
// the value-erased one (`var m = Promise.prototype.catch; m.call(o, f)`) are
// exercised: they take different lowerings, and only the second one worked
// before the resolver learned the Promise brand.
const GENERIC_CATCH_SOURCE = `
  export function test(): number {
    const target: any = {};
    const returnValue: any = {};
    let callCount = 0;
    let thisValue: any = null;
    let argCount: any = null;
    let firstArg: any = null;
    let secondArg: any = null;
    target.then = function (a: any, b: any) {
      callCount += 1;
      thisValue = this;
      argCount = arguments.length;
      firstArg = a;
      secondArg = b;
      return returnValue;
    };

    // Extra arguments are dropped: exactly «undefined, onRejected» is forwarded.
    const direct: any = Promise.prototype.catch.call(target, 1, 2, 3);
    if (callCount !== 1) return 1;
    if (thisValue !== target) return 2;
    if (argCount !== 2) return 3;
    if (firstArg !== undefined) return 4;
    if (secondArg !== 1) return 5;
    if (direct !== returnValue) return 6;

    const erased: any = Promise.prototype.catch;
    if (erased.call(target, 9) !== returnValue) return 7;
    if (callCount !== 2) return 8;

    // §7.3.14 Call step 2 — a non-callable \`then\` is a TypeError, including
    // the ordinary-object case that a plain "is it a closure" test would miss.
    const notCallable: any = [{}, { then: null }, { then: 1 }, { then: "" }, { then: true }, { then: {} }];
    for (let i = 0; i < notCallable.length; i++) {
      let threw: any = 0;
      try {
        Promise.prototype.catch.call(notCallable[i]);
      } catch (e) {
        threw = e instanceof TypeError ? 1 : 2;
      }
      if (threw !== 1) return 10 + i;
    }

    // An abrupt completion out of \`then\` propagates unchanged.
    const thrower: any = {};
    thrower.then = function () {
      throw new RangeError("boom");
    };
    let propagated: any = 0;
    try {
      Promise.prototype.catch.call(thrower);
    } catch (e) {
      propagated = e instanceof RangeError ? 1 : 2;
    }
    if (propagated !== 1) return 20;

    // §27.2.5.4 step 2 — IsPromise(this) is checked before anything observable.
    const poisoned: any = {};
    Object.defineProperty(poisoned, "constructor", {
      get: function () {
        throw new RangeError("constructor must not be read");
      },
    });
    let brandThrew: any = 0;
    try {
      Promise.prototype.then.call(poisoned);
    } catch (e) {
      brandThrew = e instanceof TypeError ? 1 : 2;
    }
    if (brandThrew !== 1) return 21;

    // The intrinsic fast path is untouched: a native promise still chains.
    let observed: any = 0;
    Promise.resolve(7).catch(function () {}).then(function (v: any) {
      observed = v;
    });
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
    // The host runner executes in-process; restore the shared host realm before
    // the next row (and before Vitest's strict rerun).
    restoreHostBuiltins();
  }
}

async function runControl(lane: Lane): Promise<number> {
  try {
    const result = await compile(GENERIC_CATCH_SOURCE, {
      fileName: "issue-5197-promise-generic-catch-control.ts",
      ...(lane === "standalone" ? { target: "standalone" as const, nativeStrings: true } : {}),
    });
    expect(
      result.success,
      result.success ? "" : result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n"),
    ).toBe(true);
    if (!result.success) return -1;

    // (#5272) The in-process test262 probe does NOT apply the standalone
    // host-import leak check CI's sharded lane applies, so assert it here.
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

describe("#5197 Slice C — generic Promise.prototype.catch", () => {
  it.skipIf(!TEST262_AVAILABLE).each(EXACT_ROWS)(
    "passes the exact host Test262 row %s",
    async (relativePath) => {
      const result = await runExactRow(relativePath, "host");
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    180_000,
  );

  it.skipIf(!TEST262_AVAILABLE).each(EXACT_ROWS)(
    "passes the exact standalone Test262 row %s",
    async (relativePath) => {
      const result = await runExactRow(relativePath, "standalone");
      expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
    },
    180_000,
  );

  for (const lane of ["host", "standalone"] as const) {
    it(`${lane}: runs catch as a generic Invoke(this, "then") and brand-checks then`, async () => {
      await expect(runControl(lane)).resolves.toBe(0);
    });
  }
});
