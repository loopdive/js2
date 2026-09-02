// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5271) ES2015 standalone — statements + language semantics, r2 residual pass.
 *
 * One pin per mechanism the wave touches, in BOTH lanes (`--target standalone`
 * and the default JS-host lane), plus a CONTROL for the ordinary case of every
 * mechanism — a plain `let` in a block that shadows nothing, a destructuring
 * pattern with no elisions, a generator drained by a rest element, and so on.
 * The controls are the half that catches collateral damage: the row lists only
 * cover the broken shapes.
 *
 * Output is read back host-free through the module's own `__stdout_prepare` /
 * `__stdout_char` exports (#3469) — the channel the test262 runner uses; a
 * standalone module cannot hand a string to the host any other way. Every
 * standalone pin also asserts the module imports NOTHING (the #5272 leak rule:
 * a standalone pass is only honest when it is host-import-free).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runLinesFor(body: string, target: "standalone" | undefined): Promise<string[]> {
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5271-es2015-statements-r2.js",
    skipSemanticDiagnostics: true,
    ...(target ? { target, nativeStrings: true } : {}),
    hostBridge: "always",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  if (target === "standalone") {
    // #5272 leak rule: a standalone module that imports anything is not a pass.
    expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const exports = instance.exports as Record<string, (...args: number[]) => number>;
    let threw = false;
    try {
      exports.__module_init!();
    } catch {
      threw = true;
    }
    // Standalone cannot hand a string to the host: read the module's own
    // `__stdout_*` channel (#3469), the same one the test262 runner uses.
    const length = exports.__stdout_prepare!() | 0;
    let sink = "";
    for (let i = 0; i < length; i++) sink += String.fromCharCode(exports.__stdout_char!(i) & 0xffff);
    const lines = sink.split("\n").filter((l) => l.length > 0);
    if (threw) lines.push("THREW");
    return lines;
  }
  // JS-host lane: link the compiler's own import object and capture `console.log`.
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  let threw = false;
  try {
    const { instance } = await WebAssembly.instantiate(result.binary, result.importObject!);
    const exports = instance.exports as Record<string, (...args: number[]) => number>;
    try {
      exports.__module_init!();
    } catch {
      threw = true;
    }
  } finally {
    console.log = originalLog;
  }
  if (threw) lines.push("THREW");
  return lines;
}

/** Standalone lane (the wave's target). */
const runStandalone = (body: string) => runLinesFor(body, "standalone");
/** JS-host lane — the same source must answer identically. */
const runHost = (body: string) => runLinesFor(body, undefined);

/** Assert both lanes print exactly `expected`. */
async function expectBothLanes(body: string, expected: string[]): Promise<void> {
  expect(await runStandalone(body), "standalone lane").toEqual(expected);
  expect(await runHost(body), "js-host lane").toEqual(expected);
}

describe("#5271 step 1 — elision-only array patterns step the iterator exactly once", () => {
  it("`let [,] = g()` resumes the generator once and stops (RED on base: second === 1)", async () => {
    await expectBothLanes(
      `
      var first = 0, second = 0;
      function* g() { first = first + 1; yield 1; second = second + 1; }
      let [,] = g();
      LOG("first=" + first);
      LOG("second=" + second);
    `,
      ["first=1", "second=0"],
    );
  });

  it("a two-hole pattern steps twice, not to completion", async () => {
    await expectBothLanes(
      `
      var steps = 0, after = 0;
      function* g() { steps = steps + 1; yield 1; steps = steps + 1; yield 2; after = after + 1; }
      let [, ,] = g();
      LOG("steps=" + steps);
      LOG("after=" + after);
    `,
      ["steps=2", "after=0"],
    );
  });

  it("CONTROL — a named-element pattern still binds its values (no elision involved)", async () => {
    await expectBothLanes(
      `
      function* g() { yield 10; yield 20; yield 30; }
      let [a, b] = g();
      LOG("a=" + a);
      LOG("b=" + b);
    `,
      ["a=10", "b=20"],
    );
  });

  it("CONTROL — a REST element keeps the unbounded drain (the -1 sentinel path)", async () => {
    await expectBothLanes(
      `
      var after = 0;
      function* g() { yield 1; yield 2; yield 3; after = after + 1; }
      let [x, ...rest] = g();
      LOG("x=" + x);
      LOG("restLen=" + rest.length);
      LOG("rest1=" + rest[1]);
      LOG("after=" + after);
    `,
      ["x=1", "restLen=2", "rest1=3", "after=1"],
    );
  });

  it("CONTROL — a plain array literal destructure with an elision is unchanged", async () => {
    await expectBothLanes(
      `
      let [, second] = [1, 2, 3];
      LOG("second=" + second);
    `,
      ["second=2"],
    );
  });

  it("CONTROL — defaults past the generator's end still fire", async () => {
    await expectBothLanes(
      `
      function* g() { yield 7; }
      let [p, q = 99] = g();
      LOG("p=" + p);
      LOG("q=" + q);
    `,
      ["p=7", "q=99"],
    );
  });
});
