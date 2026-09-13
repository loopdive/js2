// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6414 — `hono/dist/adapter/cloudflare-pages/index.js` compiled to a binary the
// engine REJECTED:
//
//   Compiling function #318:"__async_resume_fanon_467" failed:
//     struct.set[1] expected type i32, found local.get of type externref
//
// The shape is hono's `handleMiddleware`: `let response = void 0;` assigned from
// an `await` and then read after a LATER await, so the binding is spilled into
// the async frame.
//
//   * The frame FIELD was typed from `checker.getTypeAtLocation(response)`. A
//     `void 0` initializer pins the declared type to pure `undefined` (unlike a
//     bare `undefined` initializer, which TS gives evolving-`any`), and
//     `resolveWasmType(undefined)` is **i32**.
//   * The resume function re-compiles the same declaration through the var-decl
//     path, where #2806's `varBindingNeedsExternrefForUndefined` routes a
//     void-EXPRESSION initializer to an **externref** slot.
//
// So `storeSpills` wrote `local.get <externref>` into an i32 field. Both halves
// now agree because `resumeBindingValType` consults the same #2806 predicate.
//
// Anti-vacuity: the `let response;` control uses the identical body and is valid
// BOTH before and after the fix, so a green run cannot come from the fixture
// simply failing to build an async frame.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compileProject, validateEmittedBinary } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

const roots: string[] = [];
afterAll(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** Untyped package half — `x`/`m` are `any`, exactly like the hono adapter. */
function moduleSource(declaration: string): string {
  return `export async function id(v) { return v; }
export async function handle(x) {
  ${declaration}
  try { response = await id(x); } catch (e) { response = -1; }
  await id(0);
  return response;
}
export async function handleNoTry(x) {
  ${declaration}
  response = await id(x);
  await id(0);
  return response;
}`;
}

const ENTRY = `import { handle, handleNoTry } from "./mod.js";
const call = handle as unknown as (x: unknown) => Promise<unknown>;
const callNoTry = handleNoTry as unknown as (x: unknown) => Promise<unknown>;
export function runTry(): Promise<unknown> { return call(42); }
export function runNoTry(): Promise<unknown> { return callNoTry(42); }`;

type Target = "gc" | "standalone";

async function compileShape(declaration: string, target: Target) {
  const root = mkdtempSync(join(tmpdir(), "js2-6414-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), moduleSource(declaration));
  writeFileSync(join(root, "entry.ts"), ENTRY);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target,
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

describe("#6414 void-expression initializer on an async-frame spill", () => {
  it("emits a VALID module for `let response = void 0` (gc)", async () => {
    const result = await compileShape("let response = void 0;", "gc");
    const validation = validateEmittedBinary(result.binary);
    expect(validation.valid, validation.detail ?? "").toBe(true);
  });

  // The plan expected the standalone lane to already validate; it did not — the
  // native drive layer shares the same layout, so the one-function fix covers it.
  it("emits a VALID module for `let response = void 0` (standalone)", async () => {
    const result = await compileShape("let response = void 0;", "standalone");
    const validation = validateEmittedBinary(result.binary);
    expect(validation.valid, validation.detail ?? "").toBe(true);
  });

  it("carries the awaited value across the LATER await, not just a well-typed slot", async () => {
    const result = await compileShape("let response = void 0;", "gc");
    const instance = await instantiateWithRuntime(result);
    const exports = instance.exports as Record<string, () => Promise<unknown>>;
    expect(await exports.runTry!()).toBe(42);
    expect(await exports.runNoTry!()).toBe(42);
  });

  // Anti-vacuity control: same body, `let response;` — valid on the parent too.
  it("control: `let response;` is valid (before AND after the fix)", async () => {
    const result = await compileShape("let response;", "gc");
    const validation = validateEmittedBinary(result.binary);
    expect(validation.valid, validation.detail ?? "").toBe(true);
    const instance = await instantiateWithRuntime(result);
    const exports = instance.exports as Record<string, () => Promise<unknown>>;
    expect(await exports.runTry!()).toBe(42);
  });
});
