// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #5346 — `fn?.(…)` silently did not call `fn` when `fn` was a VALUE.
 *
 * `compileOptionalDirectCall` resolves the callee through `ctx.closureMap` and
 * `ctx.funcMap`, both keyed by the callee's NAME. A parameter holding a
 * callback is in neither, and the unresolved arm pushed
 * `defaultValueInstrs(resultType)`. That is not a missed optimisation: the call
 * never happened, and the expression evaluated to null. Every
 * `onEnter?.(x)` / `options.hook?.(x)` written as a parameter was a no-op.
 *
 * Measured on prettier@3.8.1: `traverseDoc`'s `onEnter?.(doc)` never fired, so
 * `isEmptyDoc` answered `true` for every input and
 * `tests/unit/is-empty-doc.js` was 7/16 — all nine failures the same
 * `true != false`. With this fix the suite goes 101/151 -> 105/151
 * (is-empty-doc 7 -> 10, doc-builders 40 -> 41).
 *
 * The fix hands the call back to `compileCallExpression` — the ordinary,
 * non-optional lowering — with the REAL AST node. An earlier attempt used a
 * `ts.factory.createCallExpression` twin and every one of these fixtures failed
 * to compile: a synthesized node has no parent, so `getSourceFile()` on it is
 * `undefined` and the func-value-wrapper registration reads `.fileName` off it.
 * A `WeakSet` keeps the optional gate from routing the real node back.
 *
 * Fixtures are untyped `.js` across two modules on purpose: annotating
 * `onEnter` gives it a call signature the by-name resolution can sometimes
 * satisfy, and the test then passes with and without the fix.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** prettier's `traverseDoc` shape: the callback arrives as a parameter. */
const WALK_MODULE = `
export const state = { bumps: 0 };

export function bump() {
  state.bumps += 1;
  return "arg";
}

export function walk(items, onEnter) {
  onEnter?.(items);
  return 0;
}

/** The argument is built INSIDE the callee, so a short-circuit is observable. */
export function walkBumping(onEnter) {
  onEnter?.(bump());
  return state.bumps;
}
`;

const MAIN_MODULE = `
import { state, walk, walkBumping } from "./walk.js";

var calls = 0;
var seenLength = 0;

function record(value) {
  calls += 1;
  seenLength = String(value).length;
}

export function invokesAValueCallee() {
  calls = 0;
  walk("a", record);
  return calls;
}

export function passesTheArgument() {
  seenLength = 0;
  walk("abcd", record);
  return seenLength;
}

export function nullishCalleeSkipsTheArguments() {
  state.bumps = 0;
  return walkBumping(undefined);
}

export function nonNullishCalleeEvaluatesTheArguments() {
  state.bumps = 0;
  return walkBumping(record);
}
`;

/**
 * Guard. A callee the by-name resolution DOES answer — a module-level function
 * declaration — must keep its existing lowering. Passes on the parent commit
 * too, and fails if the re-entry is applied where the static path was already
 * correct.
 */
const STATIC_CALLEE_MODULE = `
var hits = 0;

function hook() {
  hits += 1;
  return 0;
}

export function callsAStaticCallee() {
  hits = 0;
  hook?.();
  return hits;
}
`;

/** Anti-vacuity control: plain arithmetic through the same harness. */
const CONTROL_MODULE = `
export function control() {
  return 3 + 4;
}
`;

function entryFor(module: string, names: readonly string[]): string {
  const imports = `import { ${[...names].sort().join(", ")} } from "./${module}";`;
  const wrappers = names.map((name) => `export function via_${name}(): number { return ${name}(); }`);
  return `${imports}\n${wrappers.join("\n")}\n`;
}

async function instantiate(
  files: Readonly<Record<string, string>>,
  entryModule: string,
  names: readonly string[],
): Promise<WebAssembly.Exports> {
  const root = mkdtempSync(join(tmpdir(), "js2-5346-opt-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, name), source);
  writeFileSync(join(root, "entry.ts"), entryFor(entryModule, names));
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports;
}

const call = (exports: WebAssembly.Exports, name: string): number => (exports[`via_${name}`] as () => number)();

const PROJECT = { "walk.js": WALK_MODULE, "main.js": MAIN_MODULE };
const NAMES = [
  "invokesAValueCallee",
  "passesTheArgument",
  "nullishCalleeSkipsTheArguments",
  "nonNullishCalleeEvaluatesTheArguments",
] as const;

describe("#5346 `fn?.(…)` calls a callee that is a value, not a known name", () => {
  it("invokes a callback held in a parameter", async () => {
    // Parent commit: 0 — the call was replaced by a default value.
    const exports = await instantiate(PROJECT, "main.js", NAMES);
    expect(call(exports, "invokesAValueCallee")).toBe(1);
  });

  it("passes the argument through to that callback", async () => {
    // Parent commit: 0, for the same reason.
    const exports = await instantiate(PROJECT, "main.js", NAMES);
    expect(call(exports, "passesTheArgument")).toBe(4);
  });

  it("still short-circuits without evaluating the arguments", async () => {
    // The half of `?.` that was already correct and must stay correct: the
    // argument is built inside the callee, so a leak would show up as 1.
    const exports = await instantiate(PROJECT, "main.js", NAMES);
    expect(call(exports, "nullishCalleeSkipsTheArguments")).toBe(0);
  });

  it("evaluates the arguments exactly once for a non-nullish callee", async () => {
    // Parent commit: 0. The unresolved arm never compiled the arguments
    // either — they are only emitted inside the two resolved branches — so the
    // whole expression, side effects included, evaluated to nothing.
    const exports = await instantiate(PROJECT, "main.js", NAMES);
    expect(call(exports, "nonNullishCalleeEvaluatesTheArguments")).toBe(1);
  });

  it("leaves a statically-resolvable callee on its existing path", async () => {
    const exports = await instantiate({ "hook.js": STATIC_CALLEE_MODULE }, "hook.js", ["callsAStaticCallee"]);
    expect(call(exports, "callsAStaticCallee")).toBe(1);
  });

  it("control: the harness reports a wrong answer rather than passing blank", async () => {
    const exports = await instantiate({ "control.js": CONTROL_MODULE }, "control.js", ["control"]);
    expect(call(exports, "control")).toBe(7);
  });
});
