// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6436 — a plain `f(x)` call inherited the AMBIENT `this`.
//
// §10.2.1.2 makes `thisArgument` `undefined` for an ordinary `[[Call]]`, and a
// module body is strict, so there is no global-object substitution. The
// compiler emitted a bare `call $f` and installed nothing, so a callee whose
// `this` resolves through the `__current_this` module global read whatever a
// dispatcher had parked there:
//
//     function withArguments(a, b) { return (this ? this.t : 'NO-THIS') + '|' + arguments.length; }
//     register('x', () => withArguments(1));
//     tests[0].body({});     // native NO-THIS|1 · wasm undefined|1
//
// `tests[0].body(...)` is a METHOD call, so `emitClosureMethodCallExportN`
// installs the receiver for the arrow's body. The arrow inherits it lexically
// and correctly; the plain call it makes must not. The wrong answer was
// SILENT: `this` was a truthy object, so `this ? … : 'NO-THIS'` took the wrong
// branch and read `undefined` off it.
//
// EVERY expectation below was taken from running the same module source under
// native Node (`.tmp/native-6436.mjs`), not assumed. Two of the controls the
// plan proposed were wrong that way: `tests[0].body({t:'T'})` makes `tests[0]`
// — the registry entry — the receiver, not the `{t:'T'}` argument.
//
// Fixtures are plain untyped `.js`, matching how the upstream suites feed
// package code in. Cases marked (was ✗) answered wrongly on the parent commit;
// the controls passed there and must keep passing.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const ENTRY = `import { run } from "./mod.js";\nexport function test(): string { return String((run as unknown as () => unknown)()); }`;

async function compile(moduleSource: string) {
  const root = mkdtempSync(join(tmpdir(), "js2-6436-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), moduleSource);
  writeFileSync(join(root, "entry.ts"), ENTRY);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

async function runModule(moduleSource: string): Promise<string> {
  const instance = await instantiateWithRuntime(await compile(moduleSource));
  return String((instance.exports as Record<string, () => unknown>).test());
}

/** The reported reader: reports its receiver tag and its `arguments.length`. */
const WITH_ARGUMENTS = `function withArguments(a, b) { return (this ? this.t : 'NO-THIS') + '|' + arguments.length; }`;

/** The upstream-harness shape, reduced: a registry over-applied on replay. */
const HARNESS = `const tests = [];
function register(name, body) { tests.push({ name: name, body: body }); }`;

/** [name, module source, expected]. */
const cases: Array<[string, string, string]> = [
  // ── the reported repro and its siblings ────────────────────────────────────
  [
    "the repro: plain call inside an over-applied body (was ✗: undefined|1)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', () => withArguments(1));
export function run() { return tests[0].body({}); }`,
    "NO-THIS|1",
  ],
  [
    "`.call(undefined, 1)` in the same window (was ✗: undefined|1)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', () => withArguments.call(undefined, 1));
export function run() { return tests[0].body({}); }`,
    "NO-THIS|1",
  ],
  [
    "`.apply(undefined, [1])` in the same window (was ✗: undefined|1)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', () => withArguments.apply(undefined, [1]));
export function run() { return tests[0].body({}); }`,
    "NO-THIS|1",
  ],
  [
    "a dispatched function EXPRESSION plain-calls (was ✗: undefined|1)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', function () { return withArguments(1); });
export function run() { return tests[0].body({}); }`,
    "NO-THIS|1",
  ],
  [
    "plain call inside a METHOD call inside the window (was ✗: undefined|1)",
    `${WITH_ARGUMENTS}
${HARNESS}
const o = { m: function () { return withArguments(1); } };
register('x', () => o.m());
export function run() { return tests[0].body({}); }`,
    "NO-THIS|1",
  ],
  [
    "the enclosing method's own `this` survives the plain call (was ✗: O|1/O)",
    `${WITH_ARGUMENTS}
${HARNESS}
const o = { t: 'O', m: function () { return withArguments(1) + '/' + this.t; } };
register('x', () => o.m());
export function run() { return tests[0].body({}); }`,
    "NO-THIS|1/O",
  ],
  [
    "the dispatcher's receiver is RESTORED after the plain call (was ✗: undefined|1/x)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', function () { const a = withArguments(1); return a + '/' + String(this.name); });
export function run() { return tests[0].body({}); }`,
    "NO-THIS|1/x",
  ],
  [
    "restore is exception-safe: a throwing plain call caught inside the body (was ✗: undefined|1/x)",
    `${WITH_ARGUMENTS}
function boom() { throw new Error('x'); }
${HARNESS}
register('x', function () { try { boom(); } catch (e) {} return withArguments(1) + '/' + String(this.name); });
export function run() { return tests[0].body({ t: 'T' }); }`,
    "NO-THIS|1/x",
  ],
  [
    "optional call `f?.(1)` inside the window (was ✗: undefined|1)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', () => withArguments?.(1));
export function run() { return tests[0].body({}); }`,
    "NO-THIS|1",
  ],
  [
    "plain call in TAIL position inside the window (was ✗: undefined|1)",
    `${WITH_ARGUMENTS}
function tail() { return withArguments(1); }
${HARNESS}
register('x', () => tail());
export function run() { return tests[0].body({}); }`,
    "NO-THIS|1",
  ],
  // ── controls: green on the parent, must stay green ─────────────────────────
  [
    "control: `.call({t:'T'}, 1)` in the window still installs T (#5341)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', () => withArguments.call({ t: 'T' }, 1));
export function run() { return tests[0].body({}); }`,
    "T|1",
  ],
  [
    "control: `.apply({t:'T'}, [1])` in the window still installs T (#3983)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', () => withArguments.apply({ t: 'T' }, [1]));
export function run() { return tests[0].body({}); }`,
    "T|1",
  ],
  [
    "control: `.bind({t:'T'})(1)` in the window still installs T (#4203)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', () => withArguments.bind({ t: 'T' })(1));
export function run() { return tests[0].body({}); }`,
    "T|1",
  ],
  [
    "control: a dispatched fn-expr sees the registry entry as its receiver",
    `${HARNESS}
register('x', function () { return String(this.name); });
export function run() { return tests[0].body({ t: 'T' }); }`,
    "x",
  ],
  [
    "control: class-method caller, plain call reads no receiver",
    `${WITH_ARGUMENTS}
class C { m() { return withArguments(1); } }
export function run() { return new C().m(); }`,
    "NO-THIS|1",
  ],
  [
    "control: object-literal-method caller, plain call reads no receiver",
    `${WITH_ARGUMENTS}
const o = { m: function () { return withArguments(1); } };
export function run() { return o.m(); }`,
    "NO-THIS|1",
  ],
  [
    "control: plain call through a closure PARAMETER was already right",
    `${WITH_ARGUMENTS}
function invoke(body) { return body({}); }
export function run() { return invoke(() => withArguments(1)); }`,
    "NO-THIS|1",
  ],
  [
    "control: top-level plain call was already right",
    `${WITH_ARGUMENTS}
export function run() { return withArguments(1); }`,
    "NO-THIS|1",
  ],
  [
    "control: plain call AFTER the window was already right",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', () => 0);
export function run() { tests[0].body({}); return withArguments(1); }`,
    "NO-THIS|1",
  ],
  [
    "control: a `this`-free callee is unaffected",
    `function plain(a) { return 'P|' + a; }
${HARNESS}
register('x', () => plain(1));
export function run() { return tests[0].body({}); }`,
    "P|1",
  ],
  [
    "control: an HOF `thisArg` still reaches its callback (#2152)",
    `function tagged(v) { return this.t + v; }
export function run() { return [1].map(tagged, { t: 'H' })[0]; }`,
    "H1",
  ],
];

describe("#6436 — a plain call installs `undefined`, not the ambient receiver", () => {
  for (const [name, source, expected] of cases) {
    it(name, async () => {
      expect(await runModule(source)).toBe(expected);
    });
  }

  // Anti-cost / anti-vacuity: the trampoline is minted ONLY for a callee that
  // actually reads its own `this`. Were it minted unconditionally, every case
  // above would pass for the wrong reason — the assertion would no longer be
  // about the receiver at all.
  it("mints no `__named_plain_call_` helper for a `this`-free callee", async () => {
    const withThis = await compile(`${WITH_ARGUMENTS}
${HARNESS}
register('x', () => withArguments(1));
export function run() { return tests[0].body({}); }`);
    const thisFree = await compile(`function plain(a) { return 'P|' + a; }
${HARNESS}
register('x', () => plain(1));
export function run() { return tests[0].body({}); }`);
    expect(withThis.wat).toContain("__named_plain_call_withArguments");
    expect(thisFree.wat).not.toContain("__named_plain_call_");
  });
});
