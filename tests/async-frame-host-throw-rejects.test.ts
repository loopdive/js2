// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// An async function that has NO try/catch of its own must still reject its
// result promise when a FOREIGN JS exception is raised while it resumes.
//
// The canonical shape is a method call on an `any` receiver: it leaves through
// `__extern_method_call`, the host calls the compiled member back in, and that
// member throws. The exception is not `$exn`-tagged, so it is invisible to the
// state machine's `catch $exn`. #3587 added a `catch_all` arm for exactly this
// — but only to the ROUTED dispatcher (the one emitted when the body carries
// its own try/catch region). A body with no try/catch takes the other branch,
// which had no `catch_all`, so the exception escaped the machine and the
// result promise STRANDED PENDING.
//
// Stranding is worse than a wrong answer: the awaiting caller never settles,
// and the escaping throw becomes an unhandled rejection that kills the host
// process. In the dogfood lane that costs a whole file — hono's
// `utils/body.test.ts` lost all 37 results to one such throw (#5322).
//
// The await must be HOST-driven (a real `setTimeout` promise) to reproduce: an
// `await Promise.resolve(1)` resumes without a host promise reaction and the
// throw stays inside wasm, where the `$exn` arm already caught it.

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

// Untyped package half: `o` is `any`, so `o.boom()` dispatches through the host.
const MOD = `export async function run(o) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return o.boom();
}
export async function runOk(o) {
  await new Promise((resolve) => setTimeout(resolve, 0));
  return o.fine();
}`;

const ENTRY = `import { run, runOk } from "./mod.js";
const call = run as unknown as (o: unknown) => Promise<unknown>;
const callOk = runOk as unknown as (o: unknown) => Promise<unknown>;
export function test(): Promise<unknown> {
  const o = {
    boom: () => { throw new Error("kaboom"); },
    fine: () => "ok",
  };
  return call(o);
}
export function testOk(): Promise<unknown> {
  const o = {
    boom: () => { throw new Error("kaboom"); },
    fine: () => "ok",
  };
  return callOk(o);
}`;

async function settle(exportName: "test" | "testOk"): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "js2-async-host-throw-"));
  roots.push(root);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "mod.js"), MOD);
  writeFileSync(join(root, "entry.ts"), ENTRY);
  const result = await compileProject(join(root, "entry.ts"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform: "node",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  const promise = (instance.exports as Record<string, () => Promise<unknown>>)[exportName]();
  // A stranded frame never settles, so race it rather than hanging the suite:
  // "STRANDED" is exactly the pre-fix answer and makes the failure legible.
  return await Promise.race([
    Promise.resolve(promise).then(
      (value) => `resolved:${String(value)}`,
      (error) => `rejected:${String((error as Error)?.message ?? error)}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("STRANDED"), 3000)),
  ]);
}

describe("async frame resumed across a host await", () => {
  it("rejects its promise when a host-invoked member throws", async () => {
    expect(await settle("test")).toBe("rejected:kaboom");
  });

  it("still resolves normally when the member returns", async () => {
    expect(await settle("testOk")).toBe("resolved:ok");
  });
});
