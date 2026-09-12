// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5341 — `fn.call(thisArg, …)` DROPPED the receiver whenever the supplied
// argument count did not exactly equal the callee's formal count.
//
// The receiver-correct trampoline (#3796) is only reached through
// `resolveNamedThisCallTarget`, whose admission gate demanded
// `userArguments.length === declaration.parameters.length`. Every other arity
// fell through to the ordinary `.call` lowering, which evaluates `thisArg` and
// then literally `drop`s it — a silent wrong answer, not a refusal. The callee
// therefore read the AMBIENT receiver.
//
//     function f(fns, response) { const c = this || defaults; … }
//     f.call({ data: '' }, fns)          // 1 argument, 2 formals → this lost
//
// That is axios' `lib/core/transformData.js` verbatim. `const config = this ||
// defaults` picked up `defaults`, `context.data` answered `undefined`, and the
// transformer chain produced `'undefinedfoo'` instead of `'foo'` — six axios
// unit tests across `core/transformData` and `transformResponse`.
//
// The fixtures are plain untyped `.js`, matching how the upstream npm suites
// feed package code in: a typed fixture routes the call through a different
// lowering and proves nothing here. Cases marked (was ✗) answered wrongly on
// the parent commit; the controls passed there and must keep passing.

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
  const root = mkdtempSync(join(tmpdir(), "js2-5341-"));
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

/** [name, module source, expected]. */
const cases: Array<[string, string, string]> = [
  // ── the reported repro: axios transformData, reduced ────────────────────────
  [
    "axios transformData shape: 1 argument into 2 formals (was ✗: 'undefinedfoo')",
    `const defaults = { data: 'DEFAULTS' };
function transformData(fns, response) {
  const config = this || defaults;
  const context = response || config;
  let data = context.data;
  fns.forEach(function transform(fn) { data = fn.call(config, data); });
  return data;
}
export function run() {
  return transformData.call({ data: '' }, [(v) => v + 'f', (v) => v + 'o', (v) => v + 'o']);
}`,
    "foo",
  ],
  [
    "one argument short (was ✗: NO-THIS)",
    `function f(a, b) { return (this ? this.t : 'NO-THIS') + '|' + String(a) + '|' + String(b); }
export function run() { return f.call({ t: 'T' }, 1); }`,
    "T|1|undefined",
  ],
  [
    "no arguments at all into one formal (was ✗: NO-THIS)",
    `function f(a) { return (this ? this.t : 'NO-THIS') + '|' + String(a); }
export function run() { return f.call({ t: 'T' }); }`,
    "T|undefined",
  ],
  [
    "under-applied .apply (was ✗: NO-THIS)",
    `function f(a, b) { return (this ? this.t : 'NO-THIS') + '|' + String(a) + '|' + String(b); }
export function run() { return f.apply({ t: 'T' }, [1]); }`,
    "T|1|undefined",
  ],
  [
    "bare .apply(thisArg) with no argv (was ✗: NO-THIS)",
    `function f(a, b) { return (this ? this.t : 'NO-THIS') + '|' + String(a) + '|' + String(b); }
export function run() { return f.apply({ t: 'T' }); }`,
    "T|undefined|undefined",
  ],
  [
    "immediately-invoked under-applied bind (was ✗: NO-THIS)",
    `function f(a, b) { return (this ? this.t : 'NO-THIS') + '|' + String(a) + '|' + String(b); }
export function run() { return f.bind({ t: 'T' })(1); }`,
    "T|1|undefined",
  ],
  [
    "over-applied .call (was ✗: NO-THIS)",
    `function f(a, b) { return (this ? this.t : 'NO-THIS') + '|' + String(a) + '|' + String(b); }
export function run() { return f.call({ t: 'T' }, 1, 2, 3); }`,
    "T|1|2",
  ],
  [
    "rest declaration, nothing supplied for the leading formal (was ✗: NO-THIS)",
    `function f(a, ...more) { return (this ? this.t : 'NO-THIS') + '|' + String(a) + '|' + more.length; }
export function run() { return f.call({ t: 'T' }); }`,
    "T|undefined|0",
  ],
  // ── controls: green on the parent, must stay green ──────────────────────────
  [
    "control: exact arity",
    `function f(a, b) { return (this ? this.t : 'NO-THIS') + '|' + String(a) + '|' + String(b); }
export function run() { return f.call({ t: 'T' }, 1, 2); }`,
    "T|1|2",
  ],
  [
    "control: rest declaration at exact-or-more arity",
    `function f(a, ...more) { return (this ? this.t : 'NO-THIS') + '|' + String(a) + '|' + more.length; }
export function run() { return f.call({ t: 'T' }, 1, 2, 3); }`,
    "T|1|2",
  ],
  [
    "control: callee that ignores `this` still just gets padded arguments",
    `function f(a, b) { return String(a) + '|' + String(b); }
export function run() { return f.call({ t: 'T' }, 1); }`,
    "1|undefined",
  ],
  [
    "control: under-applied call with an absent receiver is unchanged",
    `function f(a, b) { return (this ? this.t : 'NO-THIS') + '|' + String(a) + '|' + String(b); }
export function run() { return f(1); }`,
    "NO-THIS|1|undefined",
  ],
  [
    "control: the receiver is restored after the under-applied call returns",
    `function inner(a, b) { return (this ? this.t : 'NO-THIS') + String(a) + String(b); }
function outer() { const got = inner.call({ t: 'I' }, 1); return got + '/' + (this ? this.t : 'NO-THIS'); }
export function run() { return outer.call({ t: 'O' }); }`,
    "I1undefined/O",
  ],
  [
    "control: the receiver is restored when the under-applied call throws",
    `function boom(a, b) { if (this.fail) throw new Error('x'); return String(a) + String(b); }
function outer() {
  try { boom.call({ fail: true }, 1); } catch (e) { return 'caught/' + (this ? this.t : 'NO-THIS'); }
  return 'no-throw';
}
export function run() { return outer.call({ t: 'O' }); }`,
    "caught/O",
  ],
];

describe("#5341 under- and over-applied `.call` keeps its receiver", () => {
  for (const [name, source, expected] of cases) {
    it(name, async () => {
      await expect(runModule(source)).resolves.toBe(expected);
    });
  }

  // Anti-vacuity: the harness must be able to SEE a wrong receiver. If the
  // fixture shape silently stopped exercising `.call` at all, this case would
  // pass by accident along with everything above.
  it("anti-vacuity control: a genuinely absent receiver still reads as absent", async () => {
    await expect(
      runModule(
        `function f(a, b) { return (this ? this.t : 'NO-THIS') + '|' + String(a); }
export function run() { const g = f; return g(1) + '#' + f.call({ t: 'T' }, 1); }`,
      ),
    ).resolves.toBe("NO-THIS|1#T|1");
  });
});
