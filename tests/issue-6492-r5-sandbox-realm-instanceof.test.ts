// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6492 round 5) `__instanceof(v, "<builtin>")` resolves the RHS by NAME off
// the runtime's own `globalThis`. When a `globalSandbox` is supplied — test262
// gives every row one — construction sites already prefer that realm's
// intrinsics (`_createBoundaryPromiseImport` uses `globalSandbox?.Promise ??
// Promise`), so a promise minted by compiled code is a SANDBOX Promise while
// `globalThis.Promise` is the host's. `v instanceof <host Promise>` is then
// false for a value that genuinely is a promise.
//
// In the linked test262 lane this is the whole of the
// `harness/asyncHelpers-throwsAsync-*` bucket: those rows assert
// `assert(p instanceof Promise)` on the promise the PROVIDER's
// `assert.throwsAsync` returns.

import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const SOURCE = `
  export function isPromise(v: any): number {
    return (v instanceof Promise) ? 1 : 0;
  }
`;

function makeForeignRealm(): { sandbox: Record<string, unknown>; promise: unknown } {
  const sandbox: Record<string, unknown> = Object.create(null);
  vm.createContext(sandbox);
  sandbox.Promise = vm.runInContext("Promise", sandbox as object);
  sandbox.Object = vm.runInContext("Object", sandbox as object);
  sandbox.globalThis = sandbox;
  return { sandbox, promise: vm.runInContext("Promise.resolve(1)", sandbox as object) };
}

describe("#6492 r5 — __instanceof consults the sandbox realm", () => {
  it("answers true for a sandbox-realm promise and keeps every other answer", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-6492-r5-sandbox-realm-instanceof.ts",
      skipSemanticDiagnostics: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);

    const { sandbox, promise } = makeForeignRealm();
    // Premise of the whole test: the two realms really are distinct.
    expect(promise instanceof Promise).toBe(false);
    expect(sandbox.Promise === Promise).toBe(false);

    const imports = buildImports(result.imports, undefined, result.stringPool, {
      globalSandbox: sandbox,
    }) as Record<string, Record<string, (...args: unknown[]) => unknown>>;
    const instanceOf = imports.env?.__instanceof;
    expect(typeof instanceOf).toBe("function");

    // The defect: a sandbox-realm promise must answer `instanceof Promise`.
    expect(instanceOf!(promise, "Promise")).toBe(1);
    // …and so must its `instanceof Object`, via the same sandbox lookup.
    expect(instanceOf!(promise, "Object")).toBe(1);
    // The host realm's own answers are untouched (the arm is ADDITIVE).
    expect(instanceOf!(Promise.resolve(1), "Promise")).toBe(1);
    // No false positive: a plain object is not a promise in either realm.
    expect(instanceOf!({}, "Promise")).toBe(0);
    // A name neither realm defines still answers false rather than throwing.
    expect(instanceOf!(promise, "NoSuchCtorName")).toBe(0);
  });

  it("is a no-op without a sandbox — the single-realm answer is unchanged", async () => {
    const result = await compile(SOURCE, {
      fileName: "issue-6492-r5-sandbox-realm-instanceof-nosandbox.ts",
      skipSemanticDiagnostics: true,
    });
    expect(result.success).toBe(true);

    const { promise } = makeForeignRealm();
    const imports = buildImports(result.imports, undefined, result.stringPool) as Record<
      string,
      Record<string, (...args: unknown[]) => unknown>
    >;
    const instanceOf = imports.env?.__instanceof;
    expect(typeof instanceOf).toBe("function");
    // With no sandbox there is only one realm to ask, and the foreign promise
    // is not of it. This is the pre-existing answer and must not move.
    expect(instanceOf!(promise, "Promise")).toBe(0);
    expect(instanceOf!(Promise.resolve(1), "Promise")).toBe(1);
  });
});
