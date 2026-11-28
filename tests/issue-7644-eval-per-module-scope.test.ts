// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7644 — the runtime-eval push and pull mirror each module's own bindings.
//
// The push and pull copy eval-visible bindings onto the one shared global object, keyed by bare name. With two
// modules that each declare `function f`, they carried one module's `__mod_f`, so the other module's direct eval
// published the wrong `f` and its write was lost. The provider-active flag now carries a source tag: a source that
// holds a direct eval and mirrors a name another source also mirrors enters the provider with its own tag, and the
// push and pull carry each such name once per tagged source, behind a test of that tag. Single-source programs are
// untouched. Node answers are from node 22 on 2026-11-28, running the same sources as `.mjs`.

import { describe, expect, it } from "vitest";

import {
  RUNTIME_EVAL_IMPORT_MODULE,
  instantiateRuntimeEvalNamespace,
  selectCachedRuntimeEvalProvider,
} from "../scripts/runtime-eval-provider.mjs";
import { compileMulti } from "../src/index.js";

const entry = `import { run } from "./dep"; import { run2 } from "./c"; export function main() { return run() * 10 + run2(); }`;
const dep = `function f() { return 3; } export function run() { eval("f = function () { return 4; }"); return f(); }`;
const graph = (c: string, entryText = entry, depText = dep): Record<string, string> => ({
  "entry.ts": entryText,
  "dep.ts": depText,
  "c.ts": c,
});

const EV5 = graph(
  `function f() { return 1; } export function run2() { eval("f = function () { return 2; }"); return f(); }`,
);
const INIT = graph(
  `function f() { return 1; } eval("f = function () { return 2; }"); export function run2() { return f(); }`,
);

/** Rows that answer as node does. */
const FIXED: [name: string, node: number, files: Record<string, string>][] = [
  ["EV5 each module's eval rebinds its own f", 42, EV5],
  [
    "READ2 c's eval reads its own f before rebinding it",
    42,
    graph(
      `function f() { return 1; } export function run2() { eval("f = (function (o) { return function () { return o() + 1; }; })(f)"); return f(); }`,
    ),
  ],
  [
    "NEST a nested direct eval keeps c's tag for the outer eval",
    42,
    graph(
      `function f() { return 1; } function g() { eval("0"); return 0; } export function run2() { eval("g(); f = function () { return 2; }"); return f(); }`,
    ),
  ],
  [
    "NESTIND a nested indirect eval keeps c's tag for the outer eval",
    42,
    graph(
      `function f() { return 1; } function g() { (0, eval)("0"); return 0; } export function run2() { eval("g(); f = function () { return 2; }"); return f(); }`,
    ),
  ],
  [
    "NESTFN a nested new Function keeps c's tag for the outer eval",
    42,
    graph(
      `function f() { return 1; } function g() { new Function("return 0")(); return 0; } export function run2() { eval("g(); f = function () { return 2; }"); return f(); }`,
    ),
  ],
  ["INIT c's eval runs in its module-init code", 42, INIT],
  ["CTRL only dep declares f", 41, graph(`export function run2() { return 1; }`)],
];

/**
 * Stated limits, pinned at the value measured on 2026-11-28 (stacked on #7572). Each row flips to node's answer when
 * its cause is fixed.
 */
const LIMITS: [name: string, measured: number, node: number, files: Record<string, string>][] = [
  // #7647: dep's earlier push left its `f` on the global object as a non-configurable property, and a tag-1 entry
  // pushes nothing for a colliding name but cannot retract that property, so `typeof f` is "function".
  [
    "INDIRECT c's indirect eval sees no module f",
    49,
    41,
    graph(
      `function f() { return 1; } export function run2() { return (0, eval)("typeof f") === "undefined" ? 1 : 9; }`,
    ),
  ],
  // #7647: the same stale property, through `new Function`.
  [
    "NEWFN c's new Function sees no module f",
    49,
    41,
    graph(
      `function f() { return 1; } export function run2() { return new Function("return typeof f")() === "undefined" ? 1 : 9; }`,
    ),
  ],
  // #7647: matches node by accident. `h` runs under tag 1 outside any eval, where nothing is pushed for `f`; it reads
  // c's `f` only because c's eval left that stale property on the global object.
  [
    "LATER an eval-made function called later by c's own code",
    41,
    41,
    graph(
      `function f() { return 1; } export function run2() { const h = eval("(function () { return f(); })"); return [0].map(h)[0]; }`,
    ),
  ],
  // #7646: QuickJS has not written `f = …` back to the global object when the AOT `t()` throws, so the pull on the
  // unwind path reads c's old `f`. The tag half works: dep's part is 4.
  [
    "THROWCB a throw through c's eval, then a callback in dep's eval",
    41,
    42,
    graph(
      `function f() { return 1; } function t() { throw 1; } export function run2() { try { eval("f = function () { return 2; }; t()"); } catch (e) {} return f(); }`,
      `import { run } from "./dep"; import { run2 } from "./c"; export function main() { const a = run2(); return run() * 10 + a; }`,
      `function f() { return 3; } export function run() { eval("f = function () { return 4; }"); const h = eval("(function () { return f(); })"); return [0].map(h)[0]; }`,
    ),
  ],
];

async function wat(files: Record<string, string>, experimentalIR: boolean): Promise<string> {
  const result = await compileMulti(files, "entry.ts", { target: "standalone", experimentalIR, emitWat: true });
  expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
  return result.wat;
}

/** The text of one function of `text`, up to the next function. */
function funcText(text: string, name: string): string {
  const start = text.indexOf(`(func $${name} `);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n  (func $", start + 1);
  return text.slice(start, end < 0 ? undefined : end);
}

/** The absolute indices of the globals named `name`: imported globals come first. */
function globalIndices(text: string, name: string): number[] {
  const declared = [...text.matchAll(/^ {2}\((?:import "[^"]*" "[^"]*" \()?global \$(\S+)/gm)].map((m) => m[1]);
  return declared.flatMap((global, index) => (global === name ? [index] : []));
}

/** Each `if` arm on `tag == T` in `body`, as [T, the arm's first global index matching `op`]. */
function tagArms(body: string, op: "global.get" | "global.set"): [number, number][] {
  const arms = [...body.matchAll(/i32\.const (\d+)\s+i32\.eq\s+\(if\s+\(then([\s\S]*?)\n {6}\)\n {4}\)/g)];
  return arms.map((arm) => [Number(arm[1]), Number(new RegExp(`${op} (\\d+)`).exec(arm[2]!)?.[1])]);
}

describe("#7644 push and pull per tagged source (structure)", () => {
  for (const experimentalIR of [false, true]) {
    it(`EV5 carries both modules' __mod_f behind tag arms, ir=${experimentalIR}`, async () => {
      const text = await wat(EV5, experimentalIR);
      const modF = globalIndices(text, "__mod_f");
      expect(modF).toHaveLength(2);
      const pull = tagArms(funcText(text, "__runtime_eval_pull_globals"), "global.set");
      expect(new Set(pull.map(([tag]) => tag)).size).toBe(2);
      expect(pull.map(([, global]) => global).sort()).toEqual([...modF].sort());
      const push = tagArms(funcText(text, "__runtime_eval_push_globals"), "global.get");
      expect(push.map(([, global]) => global).sort()).toEqual([...modF].sort());
      // The provider call is protected so a throw through it still pulls and restores the caller's tag.
      expect(funcText(text, "run2")).toMatch(/__runtime_eval_unwind_/);
    });

    it(`INIT sets c's own tag at its module-init eval, ir=${experimentalIR}`, async () => {
      const text = await wat(INIT, experimentalIR);
      const active = globalIndices(text, "__runtime_eval_provider_active")[0];
      const cGlobal = Math.max(...globalIndices(text, "__mod_f"));
      const pull = tagArms(funcText(text, "__runtime_eval_pull_globals"), "global.set");
      const cTag = pull.find(([, global]) => global === cGlobal)?.[0];
      const dGlobal = Math.min(...globalIndices(text, "__mod_f"));
      const dTag = pull.find(([, global]) => global === dGlobal)?.[0];
      expect(cTag).toBeDefined();
      const sets = (body: string): number[] =>
        [...body.matchAll(new RegExp(`i32\\.const (\\d+)\\s+global\\.set ${active}\\b`, "g"))].map((m) => Number(m[1]));
      const init = funcText(text, "__module_init");
      const run = funcText(text, "run");
      expect([sets(init), sets(run)].map((tags) => tags.filter((tag) => tag > 1))).toEqual([[cTag], [dTag]]);
    });
  }

  it("single-source output has no tag compare", async () => {
    const text = await wat(
      {
        "entry.ts": `function f() { return 1; } export function main() { eval("f = function () { return 2; }"); return f(); }`,
      },
      false,
    );
    expect(text).not.toMatch(/__runtime_eval_saved_tag_|__runtime_eval_unwind_/);
    const active = globalIndices(text, "__runtime_eval_provider_active")[0];
    const tagCompare = new RegExp(`global\\.get ${active}\\s+i32\\.const \\d+\\s+i32\\.eq`);
    for (const helper of ["__runtime_eval_push_globals", "__runtime_eval_pull_globals"]) {
      expect(funcText(text, helper)).not.toMatch(tagCompare);
    }
  });
});

// The answers need a real eval engine. Unit CI builds only the refusal provider, so this runs where QuickJS is built
// (the standalone test262 lane, or a box with JS2WASM_QUICKJS_ARTIFACT_DIR set and the adapter built).
let quickjs: ReturnType<typeof selectCachedRuntimeEvalProvider> | undefined;
try {
  const selection = selectCachedRuntimeEvalProvider();
  if (selection.engine === "quickjs") quickjs = selection;
} catch {
  quickjs = undefined;
}

async function runMain(files: Record<string, string>, experimentalIR: boolean): Promise<number> {
  const result = await compileMulti(files, "entry.ts", { target: "standalone", experimentalIR });
  expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(result.binary), {
    [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(quickjs!.bundle),
  } as WebAssembly.Imports);
  (instance.exports as { _start?: () => void })._start?.();
  return (instance.exports.main as () => number)();
}

describe.skipIf(!quickjs)("#7644 eval per module, run under QuickJS", () => {
  it.each(FIXED)("%s", async (_name, node, files) => {
    for (const experimentalIR of [false, true]) expect(await runMain(files, experimentalIR)).toBe(node);
  });
  it.each(LIMITS)("%s (stated limit: %d, node %d)", async (_name, measured, _node, files) => {
    for (const experimentalIR of [false, true]) expect(await runMain(files, experimentalIR)).toBe(measured);
  });
});
