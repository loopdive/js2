// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6412 — an engine-activated async function's Promise carrier was baked into
// its Wasm signature only when its own BODY compiled, so a caller compiled
// EARLIER read a stale result type.
//
// `collectDeclarations` registers an async declaration with the UNWRAPPED
// `Promise<T>` type (for an object-literal return, the anonymous struct);
// `maybeActivateAsync` later rewrites that to `externref` when the state
// machine activates. A call site compiled before the callee's body — i.e. a
// caller that textually PRECEDES the callee — reads the pre-rewrite signature
// through `funcSignatureOf` and, to feed its `await` (which wants externref),
// wraps the call in `extern.convert_any`. The rewrite then leaves
// `extern.convert_any (call $callee)` over a value that is ALREADY externref:
//
//   CompileError: Compiling function #212:"__async_resume_fimportPublicKey"
//                 failed: extern.convert_any[0] expected type anyref,
//                 found call of type externref
//
// Pure declaration-ORDER bug: hono's `dist/utils/jwt/jws.js` declares
// `importPublicKey` before `exportPublicJwkFrom`, which took three hono subpath
// modules (`utils/jwt`, `middleware/jwk`, `middleware/jwt`) from compiled to
// engine-rejected. Swapping the two declarations is already valid, which is
// what hid this — Case B below is that control.
//
// Sources are plain untyped `.js` behind a two-file project, matching how the
// upstream suites feed package code in.

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

const ENTRY = `import { outer } from "./mod.js";
const call = outer as unknown as (k: unknown) => Promise<unknown>;
export function test(): Promise<unknown> {
  return call({ type: "private", kty: "RSA", alg: "RS256" });
}`;

/** `outer` (the caller) FIRST — the defect shape. */
const CALLER_FIRST = `export async function outer(key) {
  if (key.type === "private") {
    key = await inner(key);
  }
  const r = await tail(key);
  return r.kty + "/" + r.key_ops[0];
}

async function tail(k) {
  return k;
}

async function inner(privateKey) {
  const jwk = await tail(privateKey);
  return { kty: jwk.kty, alg: jwk.alg, key_ops: ["verify"] };
}`;

/** Same module, callee FIRST — the anti-vacuity control (valid before and after). */
const CALLEE_FIRST = `async function tail(k) {
  return k;
}

async function inner(privateKey) {
  const jwk = await tail(privateKey);
  return { kty: jwk.kty, alg: jwk.alg, key_ops: ["verify"] };
}

export async function outer(key) {
  if (key.type === "private") {
    key = await inner(key);
  }
  const r = await tail(key);
  return r.kty + "/" + r.key_ops[0];
}`;

type Target = "gc" | "wasi" | "standalone";

async function compileModule(moduleSource: string, target: Target) {
  const root = mkdtempSync(join(tmpdir(), "js2-6412-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), moduleSource);
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

/** Compile, then assert the ENGINE accepts the module — the failure was validation-only. */
async function expectValid(moduleSource: string, target: Target): Promise<void> {
  const result = await compileModule(moduleSource, target);
  const validation = validateEmittedBinary(result.binary);
  expect(validation.valid, validation.detail ?? "engine rejected the emitted module").toBe(true);
}

describe("#6412 async callee declared after its caller", () => {
  // Case A — fails on the parent commit on all three lanes.
  for (const target of ["gc", "wasi", "standalone"] as const) {
    it(`emits a valid module when the async callee is declared last (${target})`, async () => {
      await expectValid(CALLER_FIRST, target);
    });
  }

  // Case B — control: already valid on the parent, must stay valid.
  for (const target of ["gc", "wasi", "standalone"] as const) {
    it(`stays valid when the async callee is declared first (${target})`, async () => {
      await expectValid(CALLEE_FIRST, target);
    });
  }

  // Case C — the call result really is the Promise (its fulfillment is the
  // object), not a mistyped struct: `outer` reads the awaited fields IN WASM.
  it("resolves the awaited object through the forward-referenced callee", async () => {
    const result = await compileModule(CALLER_FIRST, "gc");
    const instance = await instantiateWithRuntime(result);
    const value = await (instance.exports as Record<string, () => Promise<unknown>>).test!();
    expect(value).toBe("RSA/verify");
  });
});
