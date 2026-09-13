// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6416 — `arguments.length` over-reported after an OVER-APPLIED closure call.
//
// The host-facing closure dispatchers `__call_fn_N` / `__call_fn_method_N`
// (`src/codegen/closure-exports.ts`) fill the `arguments` protocol globals
// before their inner `call_ref`: `__argc` = the callee's formal count, and
// `__extras_argv` = a vec of the arguments beyond it. Only a callee that
// actually materialises `arguments` consumes those globals
// (`emitArgumentsVecBody` clears them as it reads them) — and the dispatchers
// never cleared them on the way out. So an over-applied call into a callee
// that ignores `arguments` parked a non-null extras vec in the global, and the
// NEXT `arguments` materialisation anywhere computed
// `totalLen = argc + extrasLen` with somebody else's extras:
//
//     function withArguments(a, b) { return arguments.length; }
//     register('x', () => withArguments.call({}, 1));  // arrow declares 0 params
//     tests[0].body({});                               // …invoked with 1 → extras = [{}]
//                                                      // native 1 · wasm 2
//
// That shape is every npm upstream suite's harness verbatim: the runner calls
// each test callback with an assert object the callback does not declare, so
// the first `arguments` reader inside each test body was contaminated.
//
// The issue as filed blamed the READER (an `arguments` materialisation falling
// back to the formal count). That is wrong, and the controls below pin it: a
// top-level `f.call(t, 1)` answers `1` on the parent commit too. Only the
// count seen INSIDE — or after — an over-applied closure call was wrong.
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

async function runModule(moduleSource: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "js2-6416-"));
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
  const instance = await instantiateWithRuntime(result);
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
    "under-applied .call inside an over-applied body (was ✗: T|2)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', () => withArguments.call({ t: 'T' }, 1));
export function run() { return tests[0].body({}); }`,
    "T|1",
  ],
  [
    "under-applied .apply inside an over-applied body (was ✗: T|2)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', () => withArguments.apply({ t: 'T' }, [1]));
export function run() { return tests[0].body({}); }`,
    "T|1",
  ],
  [
    "immediately-invoked under-applied bind inside an over-applied body (was ✗: T|2)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', () => withArguments.bind({ t: 'T' })(1));
export function run() { return tests[0].body({}); }`,
    "T|1",
  ],
  [
    "exact-arity .call inside an over-applied body (was ✗: T|3)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', () => withArguments.call({ t: 'T' }, 1, 2));
export function run() { return tests[0].body({}); }`,
    "T|2",
  ],
  [
    "plain direct call inside an over-applied body (was ✗: 2)",
    `function counted(a, b) { return arguments.length; }
${HARNESS}
register('x', () => counted(1));
export function run() { return tests[0].body({}); }`,
    "1",
  ],
  [
    "`arguments[1]` is absent, not the leaked extra (was ✗: 2|[object Object])",
    `function probe(a, b) { return String(arguments.length) + '|' + String(arguments[1]); }
${HARNESS}
register('x', () => probe.call({ t: 'T' }, 1));
export function run() { return tests[0].body({}); }`,
    "1|undefined",
  ],
  [
    "stale AFTER the over-applied closure returned (was ✗: 2)",
    `function counted(a, b) { return arguments.length; }
${HARNESS}
register('x', () => 0);
export function run() { tests[0].body({}); return counted(1); }`,
    "1",
  ],
  [
    "over-applied closure reached through a parameter (was ✗: T|2)",
    `${WITH_ARGUMENTS}
function invoke(body) { return body({}); }
export function run() { return invoke(() => withArguments.call({ t: 'T' }, 1)); }`,
    "T|1",
  ],
  [
    "two over-applied bodies in a row do not accumulate (was ✗: T|2)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('a', () => 0);
register('b', () => withArguments.call({ t: 'T' }, 1));
export function run() { tests[0].body({}); return tests[1].body({}); }`,
    "T|1",
  ],
  [
    "dynamic closure-ref call reading `arguments` after an over-applied body (was ✗: 2)",
    `function counted(a, b) { return arguments.length; }
${HARNESS}
register('x', () => 0);
export function run() { tests[0].body({}); const g = counted; return g(1); }`,
    "1",
  ],
  [
    "dynamic closure-ref call reading `arguments` inside an over-applied body (was ✗: 2)",
    `function counted(a, b) { return arguments.length; }
${HARNESS}
register('x', () => { const g = counted; return g(1); });
export function run() { return tests[0].body({}); }`,
    "1",
  ],
  [
    "array callback reading `arguments` after an over-applied body (was ✗: 2)",
    `${HARNESS}
register('x', () => 0);
function counted(a, b) { return arguments.length; }
export function run() { tests[0].body({}); return [1].map(function (v) { return counted(v); })[0]; }`,
    "1",
  ],
  [
    "under-applied call to a closure VARIABLE inside an over-applied body (was ✗: 2)",
    `${HARNESS}
const counted = function (a, b) { return arguments.length; };
register('x', () => counted(1));
export function run() { return tests[0].body({}); }`,
    "1",
  ],
  [
    "under-applied call to a closure VARIABLE after an over-applied body (was ✗: 2)",
    `${HARNESS}
register('x', () => 0);
const counted = function (a, b) { return arguments.length; };
export function run() { tests[0].body({}); return counted(1); }`,
    "1",
  ],
  [
    "object-literal method reading `arguments` after an over-applied body (was ✗: 2)",
    `${HARNESS}
register('x', () => 0);
const o = { m: function (a, b) { return arguments.length; } };
export function run() { tests[0].body({}); return o.m(1); }`,
    "1",
  ],
  [
    "built-in `forEach` over-applies its callback, then an `arguments` reader (was ✗: 2)",
    `function counted(a, b) { return arguments.length; }
export function run() { [1].forEach(() => {}); return counted(1); }`,
    "1",
  ],
  // ── controls: green on the parent, must stay green ─────────────────────────
  [
    "control: exact-arity replay leaves the count alone",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', () => withArguments.call({ t: 'T' }, 1));
export function run() { return tests[0].body(); }`,
    "T|1",
  ],
  [
    "control: over-applied .call still carries its own extras (extras ABI unchanged)",
    `${WITH_ARGUMENTS}
${HARNESS}
register('x', () => withArguments.call({ t: 'T' }, 1, 2, 3));
export function run() { return tests[0].body({}); }`,
    "T|3",
  ],
  [
    "control: top-level under-applied .call was already right",
    `${WITH_ARGUMENTS}
export function run() { return withArguments.call({ t: 'T' }, 1); }`,
    "T|1",
  ],
  [
    "control: the over-applied closure's OWN arguments.length still sees the extra",
    `${HARNESS}
register('x', function () { return arguments.length; });
export function run() { return tests[0].body({}); }`,
    "1",
  ],
  [
    "control: a callee that ignores `arguments` still gets its padded formals",
    `function padded(a, b) { return String(a) + '|' + String(b); }
${HARNESS}
register('x', () => padded.call({ t: 'T' }, 1));
export function run() { return tests[0].body({}); }`,
    "1|undefined",
  ],
];

describe("#6416 over-applied closure dispatch no longer leaks `__extras_argv`", () => {
  for (const [name, source, expected] of cases) {
    it(name, async () => {
      await expect(runModule(source)).resolves.toBe(expected);
    });
  }

  // Anti-vacuity: every case above depends on the replay actually being
  // OVER-APPLIED — a fixture that quietly stopped passing the surplus argument
  // would make all of them pass for the wrong reason. A rest parameter counts
  // what really arrived, so this reads 0 the moment the shape stops biting.
  it("anti-vacuity control: the replay really does over-apply the body", async () => {
    await expect(
      runModule(
        `${HARNESS}
register('x', (...more) => more.length);
export function run() { return String(tests[0].body({})) + '/' + String(tests[0].body()); }`,
      ),
    ).resolves.toBe("1/0");
  });
});
