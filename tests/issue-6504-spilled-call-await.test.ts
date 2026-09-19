// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6504 — `await` as a CALL ARGUMENT: the spill continuation.
//
// Until round 29 `planLinearAwaits` declined `o.m(await x)`, so the body fell to
// the legacy synchronous pass-through, which compiles `await` as a NO-OP. The
// visible form was `assert.sameValue(await thenable, 42)` comparing the THENABLE
// against 42 — a silent wrong value, not an error.
//
// The fix evaluates the callee reference and the preceding arguments BEFORE the
// suspension, spills them into frame fields, and calls the spilled callee on
// resume. That makes evaluation ORDER the thing under test, not just the final
// value: the thenable's `then` runs arbitrary code between the two halves, so
// anything the implementation re-reads after the resume is observably wrong even
// when the value happens to come out right. Each case below is written so BOTH
// the old no-op behaviour AND a naive recompile-the-statement resume fail it.
//
// Verdict protocol: the body's assertions run inside an async IIFE whose promise
// nobody handles, so a failed assertion surfaces as an `unhandledRejection`
// carrying the assertion message. This is used instead of the harness's
// `asyncTest`/`$DONE` because that needs the runner's completion plumbing, which
// a unit test does not have.
//
// Every body ends with a deliberate `assert(false, SENTINEL)` and every case
// expects EXACTLY that one failure. "No rejections" would NOT be a safe pass
// condition here: under the pre-round-29 behaviour the channel is silent —
// measured, by disabling the lane gate — because the legacy pass-through's
// rejection never reaches an unhandled promise (that silence is #6504's defect
// B). A test that passed on an empty array would therefore pass vacuously
// against the very bug it guards. Requiring the sentinel proves the body RAN TO
// ITS LAST LINE and that every assertion before it held.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import * as linkedRuntime from "../src/linked-provider-runtime.js";
import { buildImports } from "../src/runtime.js";
import { buildHarnessProvider, compileHarnessLinkedBody } from "../src/test262-harness-provider.js";
import { assembleLinkedHarness } from "./test262-original-harness.js";
import { parseMeta } from "./test262-runner.js";

// @ts-expect-error -- untyped runner helper
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

const CACHE = mkdtempSync(join(tmpdir(), "js2wasm-6504-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  emitWat: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

const HEADER = "/*---\ndescription: 6504 spilled-call await\n---*/\n";

/** Proves the async body reached its last line; see the protocol note above. */
const SENTINEL = "__6504_reached_end__";

/** Run `body` on the linked lane; resolve to every failure it reported. */
async function failures(body: string): Promise<string[]> {
  const source = HEADER + body;
  const assembly = assembleLinkedHarness(source, parseMeta(source));
  const provider = await buildHarnessProvider({
    harnessPrefix: assembly.harnessPrefix,
    cacheDir: CACHE,
    compileOptions: OPTIONS,
  });
  const result = await compileHarnessLinkedBody(provider, assembly.primary.body, {
    ...OPTIONS,
    strict: assembly.primary.strict,
  });
  if (!result.success) return [`compile_error: ${(result.errors ?? [])[0]?.message ?? "unknown"}`];

  const seen: string[] = [];
  const onRejection = (error: unknown): void => {
    seen.push(String((error as { message?: string })?.message ?? error));
  };
  process.on("unhandledRejection", onRejection);
  try {
    const importObject = buildImports(result.imports as never, { console }, result.stringPool as never);
    try {
      await instantiateTest262Module(result.binary, importObject, {
        linkedModules: result.linkedModules ?? [],
        runDeferredInit: true,
        linkedRuntime,
      });
    } catch (error) {
      seen.push(`threw: ${String((error as { message?: string })?.message ?? error)}`);
    }
    // Let the microtask queue (the thenable jobs and the resume steps) drain.
    for (let i = 0; i < 25; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return seen;
}

describe("#6504 — await in a call argument, resolved through the spill continuation", () => {
  it("the verdict channel reports a real failure (control)", async () => {
    // The sentinel protocol rests on this: a failed assertion inside the body
    // must reach the rejection channel. Measured with the lane gate forced off,
    // this case reports ZERO failures — which is why no case below may treat an
    // empty array as a pass.
    const seen = await failures(
      `var thenable = { then: function (resolve) { resolve(42); } };
(async function () { assert.sameValue(await thenable, 99, "control"); })();
`,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("control");
  });

  it("the value is the thenable's RESOLVED value, not the thenable", async () => {
    // The exact shape of `language/expressions/await/await-awaits-thenables.js`.
    // Pre-round-29 this compared `[object Object]` against 42.
    expect(
      await failures(
        `var thenable = { then: function (resolve) { resolve(42); } };
(async function () {
  assert.sameValue(await thenable, 42, "resolved value");
  assert(false, "__6504_reached_end__");
})();
`,
      ),
    ).toEqual([SENTINEL]);
  });

  it("the CALLEE is the one read before the suspension, even when `then` reassigns it", async () => {
    // `obj.m` is replaced from inside the thenable's `then` — after the callee
    // reference is evaluated, before the call happens. Spec order evaluates the
    // callee reference first, so the ORIGINAL function must run. A
    // recompile-the-statement resume calls the replacement and logs "new".
    expect(
      await failures(
        `var log = [];
var obj = { m: function (v) { log.push("old:" + v); } };
var thenable = {
  then: function (resolve) {
    obj.m = function (v) { log.push("new:" + v); };
    resolve(7);
  },
};
(async function () {
  obj.m(await thenable);
  assert.sameValue(log.join(","), "old:7", "pre-suspension callee wins");
  assert(false, "__6504_reached_end__");
})();
`,
      ),
    ).toEqual([SENTINEL]);
  });

  it("the RECEIVER is evaluated exactly once, before the suspension", async () => {
    // A getter-valued receiver source counts its reads. Compiling the callee
    // expression whole on the resume path would evaluate `holder.o` a second
    // time; reading the method off the already-evaluated receiver value cannot.
    expect(
      await failures(
        `var reads = 0;
var target = { m: function () {} };
var holder = { get o() { reads += 1; return target; } };
var thenable = { then: function (resolve) { resolve(1); } };
(async function () {
  holder.o.m(await thenable);
  assert.sameValue(reads, 1, "receiver evaluated once");
  assert(false, "__6504_reached_end__");
})();
`,
      ),
    ).toEqual([SENTINEL]);
  });

  it("arguments evaluate left-to-right ACROSS the suspension", async () => {
    // `a` is left of the await and must be evaluated before it; `b` is right of
    // it and must be evaluated after it settles. Both are getters, so the order
    // is recorded rather than inferred — and all three values must arrive in
    // their source positions.
    expect(
      await failures(
        `var log = [];
var src = {
  get a() { log.push("a"); return 1; },
  get b() { log.push("b"); return 3; },
};
var thenable = { then: function (resolve) { log.push("then"); resolve(2); } };
var seen = null;
function sink(x, y, z) { seen = [x, y, z].join("-"); }
(async function () {
  sink(src.a, await thenable, src.b);
  assert.sameValue(log.join(","), "a,then,b", "left-to-right across the suspension");
  assert.sameValue(seen, "1-2-3", "all three arguments arrive in their source positions");
  assert(false, "__6504_reached_end__");
})();
`,
      ),
    ).toEqual([SENTINEL]);
  });

  it("a MUTABLE identifier callee is read before the suspension too", async () => {
    // The pre-existing replay arm admits only a single-`const` callee, because
    // re-reading one is provably the same value. A `var` is not, so this shape
    // used to decline into the no-op pass-through; now it is spilled.
    expect(
      await failures(
        `var log = [];
var f = function (v) { log.push("old:" + v); };
var thenable = {
  then: function (resolve) {
    f = function (v) { log.push("new:" + v); };
    resolve(5);
  },
};
(async function () {
  f(await thenable);
  assert.sameValue(log.join(","), "old:5", "pre-suspension binding read wins");
  assert(false, "__6504_reached_end__");
})();
`,
      ),
    ).toEqual([SENTINEL]);
  });

  it("a rejected await propagates the reason instead of calling the spilled callee", async () => {
    // The spills are live at the suspension; the reject path must abandon them
    // rather than call through with the rejection reason as the argument. The
    // body has no `catch` on purpose — see the next case for why — so the
    // rejection itself is the verdict: the reason reaches the channel, and the
    // sentinel on the following line does NOT, because the body never gets
    // there.
    expect(
      await failures(
        `var bad = { then: function (res, rej) { rej(new TypeError("nope")); } };
function sink() {}
(async function () {
  sink(await bad);
  assert(false, "__6504_reached_end__");
})();
`,
      ),
    ).toEqual(["nope"]);
  });

  // ── round 31: the await NESTED inside an argument ────────────────────────

  it("an await inside an INDEX operand spills the base and indexes on resume", async () => {
    // `[22,33]?.[await p]` — the round-26 `nested-operand` bucket. The base is
    // evaluated before the suspension; the element GET happens on resume,
    // which is where source order puts it.
    expect(
      await failures(
        `var p1 = Promise.resolve(1);
(async function () {
  assert.sameValue([22, 33]?.[await p1], 33, "index operand");
  assert(false, "__6504_reached_end__");
})();
`,
      ),
    ).toEqual([SENTINEL]);
  });

  it("an await inside an ARRAY LITERAL element keeps the earlier elements' order", async () => {
    // `[44, await p]?.[1]` — element 0 is evaluated (and spilled) before the
    // suspension; the array is built on resume.
    expect(
      await failures(
        `var log = [];
var src = { get first() { log.push("first"); return 44; } };
var p55 = Promise.resolve(55);
(async function () {
  assert.sameValue([src.first, await p55]?.[1], 55, "array element operand");
  assert.sameValue(log.join(","), "first", "the earlier element ran once, before the await");
  assert(false, "__6504_reached_end__");
})();
`,
      ),
    ).toEqual([SENTINEL]);
  });

  it("an await as a BINARY operand spills the left side once, before the suspension", async () => {
    // `f(src.n + await p)` — the left operand is a getter, so a resume that
    // recompiled it would run it twice and the count would say so.
    expect(
      await failures(
        `var reads = 0;
var src = { get n() { reads += 1; return 1; } };
var p2 = Promise.resolve(2);
var seen = null;
function sink(v) { seen = v; }
(async function () {
  sink(src.n + await p2);
  assert.sameValue(seen, 3, "the operator ran on resume with both values");
  assert.sameValue(reads, 1, "the left operand was evaluated exactly once");
  assert(false, "__6504_reached_end__");
})();
`,
      ),
    ).toEqual([SENTINEL]);
  });

  it("an optional chain with a non-nullish base decides the short-circuit BEFORE suspending", async () => {
    // The base is an array literal, so the chain never short-circuits — but the
    // nullish test is still emitted pre-suspension, and this case pins that it
    // does not disturb the ordinary path.
    expect(
      await failures(
        `var log = [];
var p0 = Promise.resolve(0);
(async function () {
  assert.sameValue([9]?.[await p0], 9, "non-nullish optional base");
  assert(false, "__6504_reached_end__");
})();
`,
      ),
    ).toEqual([SENTINEL]);
  });

  it("a base whose nullishness is not syntactically settled is REFUSED, not guessed", async () => {
    // `var b = undefined; b?.[await x]` — the short-circuit machinery is
    // correct here (measured: the operand is never evaluated), but the chain is
    // constant-folded ahead of the operand substitution and the result lowers
    // as f64 `0`. Rather than ship that wrong value, the planner refuses the
    // shape and it keeps its pre-round-31 decline — which this channel reports
    // as silence. If a later round fixes the fold, THIS case flips to
    // [SENTINEL] and must be rewritten.
    expect(
      await failures(
        `var ran = false;
function mk() { ran = true; return Promise.reject(new Error("must not run")); }
(async function () {
  var base = undefined;
  assert.sameValue(base?.[await mk()], undefined, "short-circuit value");
  assert(false, "__6504_reached_end__");
})();
`,
      ),
    ).toEqual([]);
  });

  it("try/catch ACROSS the await is deliberately NOT in this round's scope", async () => {
    // `try { o.m(await x) } catch {}` leaves the linear planner entirely: the
    // try/catch analysis owns it, and that path builds its own CFG states which
    // carry no spill hooks — so `lowerChunk` must NOT admit a spilled call, or
    // the plan would describe a call the emitter never emits. It does not (its
    // `LowerState` leaves `allowSpilledCall` unset), so this shape keeps its
    // PRE-round-29 behaviour exactly.
    //
    // That behaviour is still wrong (#6504 remains open for it) and this case
    // pins the boundary rather than blessing it: the body reports NOTHING —
    // neither the assertion nor the sentinel — because the legacy pass-through
    // swallows both. If a later round widens the try/catch path, this case is
    // the one that must be rewritten, and its failure is the reminder.
    expect(
      await failures(
        `var called = false;
function sink() { called = true; }
var bad = { then: function (res, rej) { rej(new TypeError("nope")); } };
(async function () {
  var caught = null;
  try { sink(await bad); } catch (e) { caught = e; }
  assert.sameValue(called, false, "not reached on the legacy path");
  assert(false, "__6504_reached_end__");
})();
`,
      ),
    ).toEqual([]);
  });
});
