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

describe("#5271 step 2 — module-level lexical shadowing", () => {
  it("a top-level for-head `let` does not write the same-spelled top-level binding", async () => {
    // RED on base: `x` reads back "inside" after the loop (the head aliased the global).
    await expectBothLanes(
      `
      let x = 'outside';
      var probeBefore = function() { return x; };
      for (let x = 'inside'; false; ) {}
      LOG("after=" + x);
      LOG("closure=" + probeBefore());
    `,
      ["after=outside", "closure=outside"],
    );
  });

  it("a block `let` stops shadowing the same-spelled global once the block closes", async () => {
    // RED on base: the block-fresh local outlives the block, so `x` reads null.
    await expectBothLanes(
      `
      var probe;
      let x = 'a';
      { let x = 'inside'; probe = function() { return x; }; }
      x = 'outside';
      LOG("outer=" + x);
      LOG("block=" + probe());
    `,
      ["outer=outside", "block=inside"],
    );
  });

  it("a closure built in a block BEFORE the block's `let` captures the block binding", async () => {
    // RED on base: reads the same-spelled module global ("outside").
    await expectBothLanes(
      `
      var probeBlock;
      let x = 'outside';
      { probeBlock = function() { return x; }; let x = 'inside'; }
      LOG("block=" + probeBlock());
    `,
      ["block=inside"],
    );
  });

  it("the same, in a catch block", async () => {
    await expectBothLanes(
      `
      var probeBlock;
      let x = 'outside';
      try { throw 1; } catch (e) { probeBlock = function() { return x; }; let x = 'inside'; }
      LOG("block=" + probeBlock());
    `,
      ["block=inside"],
    );
  });

  it("CreatePerIterationEnvironment runs before the first test (head closure keeps C0)", async () => {
    // RED on base: probeBefore() reads "inside" — the head closure shared the
    // cell the condition mutates.
    await expectBothLanes(
      `
      var probeBefore; var run = true;
      for (let x = 'outside', _ = probeBefore = function() { return x; }; run && (x = 'inside'); ) run = false;
      LOG("head=" + probeBefore());
    `,
      ["head=outside"],
    );
  });

  it("the literal indirect-eval fold is REFUSED under a block shadow", async () => {
    // RED on base: the splice compiled `x` in the module-init frame and read the
    // block shadow ("inside"); indirect eval must resolve in the GLOBAL
    // environment. Neither lane can be RUN here — host `__extern_eval` evaluates
    // in the vitest realm (no global `x`), and the standalone replacement is the
    // runtime-eval TIER, which this pin does not link — so the assertion is that
    // the fold was refused. `eval-code/indirect/lex-env-heritage.js` covers the
    // executed behaviour.
    const compileStandalone = (body: string) =>
      compile(`function LOG(s) { console.log(s); }\n${body}\n`, {
        allowJs: true,
        fileName: "issue-5271-indirect-eval-shadow.js",
        skipSemanticDiagnostics: true,
        target: "standalone",
        nativeStrings: true,
        hostBridge: "always",
        deferTopLevelInit: true,
      });
    const shadowed = await compileStandalone(
      `let x = 'outside';\nvar r;\n{ let x = 'inside'; r = (0,eval)('x;'); }\nLOG("r=" + r);`,
    );
    // The refusal routes to the runtime-eval TIER. (`result.imports` does not
    // list that tier — it is linked below the host-import surface — so the WAT
    // is what says whether the fold happened.)
    expect(shadowed.wat ?? "").toContain("runtime-eval");
    // CONTROL: with no shadow the literal splice still folds, so no tier is
    // pulled in — the refusal is scoped to the shadowing case, not global.
    const unshadowed = await compileStandalone(`let y = 'outside';\nvar r2 = (0,eval)('y;');\nLOG("r2=" + r2);`);
    expect(unshadowed.wat ?? "").not.toContain("runtime-eval");
  });

  it("CONTROL — a plain block `let` that shadows nothing is unchanged", async () => {
    await expectBothLanes(
      `
      { let a = 1; LOG("a=" + a); }
      { let a = 2; LOG("a2=" + a); }
    `,
      ["a=1", "a2=2"],
    );
  });

  it("CONTROL — a top-level `for (let i…)` counter with no outer twin still works", async () => {
    await expectBothLanes(
      `
      var total = 0;
      for (let i = 0; i < 4; i++) total = total + i;
      LOG("total=" + total);
    `,
      ["total=6"],
    );
  });

  it("CONTROL — per-iteration closures still see distinct bindings", async () => {
    await expectBothLanes(
      `
      var fs = [];
      for (let i = 0; i < 3; i++) fs.push(function() { return i; });
      LOG("f0=" + fs[0]());
      LOG("f1=" + fs[1]());
      LOG("f2=" + fs[2]());
    `,
      ["f0=0", "f1=1", "f2=2"],
    );
  });

  it("CONTROL — a `var` inside a block still binds the module global", async () => {
    await expectBothLanes(
      `
      var v = 1;
      { var v = 2; }
      LOG("v=" + v);
    `,
      ["v=2"],
    );
  });

  it("CONTROL — indirect eval with no shadow still folds and reads the global", async () => {
    await expectBothLanes(
      `
      let g1 = 'g';
      LOG("r=" + (0,eval)('g1;'));
    `,
      ["r=g"],
    );
  });

  it("CONTROL — nested same-named for-heads keep their own bindings", async () => {
    await expectBothLanes(
      `
      var out = '';
      for (let i = 0; i < 2; i++) { for (let i = 10; i < 12; i++) out = out + i; out = out + '|'; }
      LOG("out=" + out);
    `,
      ["out=1011|1011|"],
    );
  });
});

describe("#5271 step 3 — `with` HasBinding applies @@unscopables (standalone)", () => {
  it("a true-coercing @@unscopables entry blocks the object-environment binding", async () => {
    // RED on base: standalone gated `with` on HasProperty alone, so `x` read 1.
    await expectBothLanes(
      `
      var x = 2;
      var env = { x: 1 };
      env[Symbol.unscopables] = { x: true };
      with (env) { LOG("x=" + x); }
    `,
      ["x=2"],
    );
  });

  // The next two are STANDALONE-only pins. Both shapes are also wrong in the
  // JS-host lane on this tree (host answers `x=2` for a FALSY entry, and never
  // propagates a throwing getter), but that is the `env::__with_has_binding`
  // host import's own behaviour — untouched by #5271, which only adds the
  // standalone twin. Pinning the host lane here would encode a separate bug.
  it("a falsy @@unscopables entry does NOT block it", async () => {
    expect(
      await runStandalone(`
      var x = 2;
      var env = { x: 1 };
      env[Symbol.unscopables] = { x: false };
      with (env) { LOG("x=" + x); }
    `),
    ).toEqual(["x=1"]);
  });

  it("a throwing @@unscopables getter propagates out of the lookup", async () => {
    expect(
      await runStandalone(`
      var x = 2;
      var env = { x: 1 };
      var thrown = 'none';
      Object.defineProperty(env, Symbol.unscopables, { get: function() { throw new TypeError('boom'); } });
      try { with (env) { x; } } catch (e) { thrown = e.name; }
      LOG("thrown=" + thrown);
    `),
    ).toEqual(["thrown=TypeError"]);
  });

  it("CONTROL — an ordinary `with` with no @@unscopables still reads the env property", async () => {
    await expectBothLanes(
      `
      var a = 'outer';
      var env = { a: 'inner', b: 'only-inner' };
      with (env) { LOG("a=" + a); LOG("b=" + b); }
      LOG("after=" + a);
    `,
      ["a=inner", "b=only-inner", "after=outer"],
    );
  });

  it("CONTROL — a name absent from the env still cascades to the outer binding", async () => {
    await expectBothLanes(
      `
      var outerOnly = 'outer';
      var env = { other: 1 };
      with (env) { LOG("v=" + outerOnly); }
    `,
      ["v=outer"],
    );
  });

  it("CONTROL — a `with` write still lands on the env property", async () => {
    await expectBothLanes(
      `
      var w = 'outer';
      var env = { w: 'inner' };
      with (env) { w = 'written'; }
      LOG("env=" + env.w);
      LOG("outer=" + w);
    `,
      ["env=written", "outer=outer"],
    );
  });
});

describe("#5271 step 4 — for-in lexical head (standalone)", () => {
  // STANDALONE-only. The JS-host lane of THIS pin harness enumerates nothing for
  // an object-literal receiver (`for (var k in { a: 1 })` prints an empty
  // accumulator) — verified by a file-copy A/B against the branch base, so it is
  // pre-existing and unrelated to #5271. Pinning it here would encode that bug.
  it("an array-pattern head destructures the KEY STRING's code units", async () => {
    // RED on base: both elements bound `null`.
    expect(
      await runStandalone(`
      var seen = 'none';
      for (var [a, b] in { ab: null }) { seen = a + '|' + b; }
      LOG("seen=" + seen);
    `),
    ).toEqual(["seen=a|b"]);
  });

  it("a duplicate name in a `var` head lets the LAST element win", async () => {
    expect(
      await runStandalone(`
      var last = 'none';
      for (var [x, x] in { ab: null }) { last = x; }
      LOG("last=" + last);
    `),
    ).toEqual(["last=b"]);
  });

  it("an element past the key's end takes its DEFAULT", async () => {
    expect(
      await runStandalone(`
      var out = 'none';
      for (let [p, q = 'dflt'] in { z: 0 }) { out = p + '|' + q; }
      LOG("out=" + out);
    `),
    ).toEqual(["out=z|dflt"]);
  });

  it("the head's bound names are in TDZ while the RECEIVER is evaluated", async () => {
    // RED on base: `{ x }` read the outer `x` instead of throwing.
    expect(
      await runStandalone(`
      var threw = 'no';
      try { (function() { let x = 1; for (let x in { x }) {} })(); } catch (e) { threw = e.name; }
      LOG("threw=" + threw);
    `),
    ).toEqual(["threw=ReferenceError"]);
  });

  it("a lexical head does not leak past the loop over a closed-shape receiver", async () => {
    // RED on base: the static-unroll path never restored the outer binding.
    expect(
      await runStandalone(`
      let x = 'outside';
      for (let x in { i: 0 }) ;
      LOG("x=" + x);
    `),
    ).toEqual(["x=outside"]);
  });

  it("CONTROL — a plain identifier head still enumerates every own key", async () => {
    expect(
      await runStandalone(`
      var acc = '';
      for (var k in { a: 1, b: 2 }) acc = acc + k;
      LOG("acc=" + acc);
    `),
    ).toEqual(["acc=ab"]);
  });

  it("CONTROL — a `let` head still binds the key per iteration and is readable in the body", async () => {
    expect(
      await runStandalone(`
      var acc = '';
      var obj = { p: 1, q: 2 };
      for (let k in obj) acc = acc + k + obj[k];
      LOG("acc=" + acc);
    `),
    ).toEqual(["acc=p1q2"]);
  });

  it("CONTROL — a `for…in` over an array still yields its index keys", async () => {
    expect(
      await runStandalone(`
      var acc = '';
      for (var i in ['a', 'b', 'c']) acc = acc + i;
      LOG("acc=" + acc);
    `),
    ).toEqual(["acc=012"]);
  });

  it("CONTROL — a nullish receiver still yields zero iterations", async () => {
    expect(
      await runStandalone(`
      var n = 0;
      for (var k in null) n = n + 1;
      for (var k2 in undefined) n = n + 1;
      LOG("n=" + n);
    `),
    ).toEqual(["n=0"]);
  });
});
