// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6867 — two root causes behind 9 of jest's 20 failing upstream unit tests.
//
// 1. OPTIONAL-FIELD WIDENING (jest `expectationResultFactory`, 6 tests). A
//    local whose shape omits some OPTIONAL properties of the parameter type —
//      const options = { matcherName: 'm', passed: true };
//      expectationResultFactory(options);   // param: { …; error?: any; … }
//    — lowers to a different WasmGC struct than the parameter. The call
//    boundary's guarded downcast between the two unrelated structs failed, so
//    the callee received NULL and trapped ("dereferencing a null pointer").
//    The coercion now keeps the value when it already IS the target struct and
//    otherwise projects it, completing the absent optional fields with JS
//    `undefined`. A missing REQUIRED field still declines.
//
// 2. TUPLE REST THROUGH AN ANY-TYPED CALL (jest `queueRunner`, 5 tests). The
//    dynamic-call ladder treated a `...args: [Error]` carrier (#5329) as one
//    ordinary ref formal: `next()` passed a typed null (null deref on
//    `args[0]`) and `next(err)` `ref.cast` the Error to the tuple struct
//    ("illegal cast"). The arm now builds the tuple from the call arguments.
//
// WHY `.ts` AND NOT UNTYPED `.js`: both triggers ARE type annotations — an
// optional property (`k?: T`) and a tuple rest — which have no untyped
// spelling. The two-file project shape is kept.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject, type CompileResult } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function compileFixture(files: Record<string, string>, entry: string): Promise<CompileResult> {
  const root = mkdtempSync(join(tmpdir(), "js2-6867-"));
  roots.push(root);
  for (const [name, source] of Object.entries(files)) {
    const target = join(root, name);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, source);
  }
  return compileProject(join(root, entry), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
}

async function instantiate(result: CompileResult): Promise<Record<string, () => unknown>> {
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return instance.exports as unknown as Record<string, () => unknown>;
}

// expectationResultFactory's shape: a typed options parameter with optional
// members, destructured by a helper, read back field by field.
const FACTORY = `
export type Options = {
  matcherName: string;
  passed: boolean;
  actual?: any;
  error?: any;
  message?: string | null;
};
function messageFormatter({ error, message, passed }: Options): string {
  if (passed) return 'Passed.';
  if (message) return message;
  return 'thrown: ' + String(error);
}
export default function factory(options: Options) {
  return { matcherName: options.matcherName, message: messageFormatter(options), error: options.error };
}
export function rename(options: Options): void {
  options.matcherName = 'renamed';
}
`;

const FACTORY_ENTRY = `
import factory, { rename, type Options } from './factory.js';

// Widened: the local omits optional members of Options.
export function passedLocal(): string {
  const options = { matcherName: 'm', passed: true };
  return factory(options).message;
}
export function failedLocal(): string {
  const options = { actual: 'Fail', matcherName: 'm', passed: false };
  const result = factory(options);
  return result.message + '|' + typeof result.error;
}
// Control (already green before #6867): a literal argument is built as the
// expected struct directly (#4394).
export function literalArgument(): string {
  return factory({ matcherName: 'm', passed: false, message: 'lit' }).message;
}
// Identity control: a value that already IS the target struct is passed by
// reference, so a write through the callee stays visible to the caller.
export function sameShapeIdentity(): string {
  const options: Options = { matcherName: 'm', passed: true };
  rename(options);
  return options.matcherName;
}
`;

const RUNNER = `
export function runQueue(fns: Array<(done: any) => void>): string {
  const log: string[] = [];
  for (const fn of fns) {
    const next = function (...args: [Error]) {
      const err = args[0];
      log.push(err ? 'err:' + err.message : 'ok');
    };
    fn(next);
  }
  return log.join(',');
}
`;

const RUNNER_ENTRY = `
import { runQueue } from './runner.js';
export function zeroArgs(): string {
  return runQueue([(next: any) => next(), (next: any) => next()]);
}
export function errorArg(): string {
  return runQueue([(next: any) => next(new Error('boom')), (next: any) => next()]);
}
`;

describe("#6867 optional-field widening at a typed-ref coercion", () => {
  it("passes a local that omits optional members (absent members read undefined)", async () => {
    const result = await compileFixture({ "factory.ts": FACTORY, "main.ts": FACTORY_ENTRY }, "main.ts");
    expect(result.success).toBe(true);
    const exports = await instantiate(result);
    // Before #6867 both calls trapped with "dereferencing a null pointer".
    expect(exports.passedLocal!()).toBe("Passed.");
    expect(exports.failedLocal!()).toBe("thrown: undefined|undefined");
  });

  it("keeps the established literal-argument and same-shape paths (controls)", async () => {
    const result = await compileFixture({ "factory.ts": FACTORY, "main.ts": FACTORY_ENTRY }, "main.ts");
    expect(result.success).toBe(true);
    const exports = await instantiate(result);
    expect(exports.literalArgument!()).toBe("lit");
    expect(exports.sameShapeIdentity!()).toBe("renamed");
  });
});

describe("#6867 tuple rest formal through an any-typed call", () => {
  it("builds the tuple from zero or one dynamic argument", async () => {
    const result = await compileFixture({ "runner.ts": RUNNER, "main.ts": RUNNER_ENTRY }, "main.ts");
    expect(result.success).toBe(true);
    const exports = await instantiate(result);
    // Before #6867: zeroArgs → "dereferencing a null pointer", errorArg →
    // "illegal cast".
    expect(exports.zeroArgs!()).toBe("ok,ok");
    expect(exports.errorArg!()).toBe("err:boom,ok");
  });
});
