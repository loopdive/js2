// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// A callable PARAMETER of a function stored as an object/class MEMBER must
// still dispatch when the argument arrives as a host JS function.
//
// Package code compiled from published `.js` has `any`-typed receivers, so
// `formData.forEach(cb)` goes out through `__extern_method_call`; the host
// marshals the inline arrow into a `createNativeFunctionCallbackBridge`
// function and hands THAT to the compiled member. The member's callable-param
// dispatch guard-casts the incoming externref to the closure-wrapper struct,
// the cast nulls out (a bridge is not a wasm closure struct), and the
// following `struct.get` traps "dereferencing a null pointer" — an UNCATCHABLE
// wasm trap that kills the whole module, not a recoverable TypeError.
//
// #4616 already routed this shape to the `__call_function` host arm, but only
// for the `MethodDeclaration` spelling. The three other spellings of the same
// construct — a property whose initializer is an arrow or a function
// expression, and a class field arrow — kept trapping:
//
//     { forEach(cb) {…} }              // worked  (#4616)
//     { forEach: function (cb) {…} }   // trapped
//     { forEach: (cb) => {…} }         // trapped
//     class C { forEach = (cb) => {…} }// trapped
//
// Witness: hono's `utils/body.test.ts` stubs `request.formData()` with
// `({ forEach: (cb) => { cb(file, 'file', data) } }) as FormData` and hands it
// to the package's `convertFormDataToBodyData`. The trap aborted the whole
// 37-test file before a single result was recorded.
//
// The fixtures are plain untyped `.js` for the package half — that is what
// makes the receiver `any` and sends the call through the host. Annotating the
// parameter `: any` instead of a function type routes to a different dispatch
// arm entirely, which is why the last case below passes with AND without the
// fix and must not be mistaken for coverage.

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

// Untyped package half: `formData` is `any`, so `formData.forEach(...)` leaves
// through the host and the inline arrow crosses as a host callback bridge.
const MOD = `export function collect(formData) {
  const form = {};
  formData.forEach((value, key) => {
    form[key] = value;
  });
  return form;
}`;

async function runEntry(entrySource: string): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), "js2-member-callable-param-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), MOD);
  writeFileSync(join(root, "entry.ts"), entrySource);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, () => unknown>).test();
}

const PRELUDE = `import { collect } from "./mod.js";
type Visit = (value: string, key: string, parent: unknown) => void;
const gather = collect as unknown as (source: unknown) => Record<string, string>;`;

describe("callable param of an object/class member receiving a host callback", () => {
  it("dispatches through an object-literal property arrow", async () => {
    expect(
      await runEntry(`${PRELUDE}
export function test(): string {
  const source = { forEach: (cb: Visit) => { cb("V", "k", null); } };
  return String(gather(source).k);
}`),
    ).toBe("V");
  });

  it("dispatches through an object-literal property function expression", async () => {
    expect(
      await runEntry(`${PRELUDE}
export function test(): string {
  const source = { forEach: function (cb: Visit) { cb("V", "k", null); } };
  return String(gather(source).k);
}`),
    ).toBe("V");
  });

  it("dispatches through a class field arrow", async () => {
    expect(
      await runEntry(`${PRELUDE}
class Source {
  forEach = (cb: Visit): void => { cb("V", "k", null); };
}
export function test(): string {
  return String(gather(new Source()).k);
}`),
    ).toBe("V");
  });

  it("still dispatches through a method shorthand (the #4616 arm)", async () => {
    expect(
      await runEntry(`${PRELUDE}
export function test(): string {
  const source = { forEach(cb: Visit) { cb("V", "k", null); } };
  return String(gather(source).k);
}`),
    ).toBe("V");
  });

  // Negative control. An `any`-typed parameter has no call signature, so the
  // call never reaches the callable-param dispatch this issue is about. It
  // passes identically with and without the fix — keep it to document that an
  // `any` annotation is NOT a substitute for the typed cases above.
  it("control: an `any`-typed parameter takes a different arm and already worked", async () => {
    expect(
      await runEntry(`${PRELUDE}
export function test(): string {
  const source = { forEach: (cb: any) => { cb("V", "k", null); } };
  return String(gather(source).k);
}`),
    ).toBe("V");
  });
});
