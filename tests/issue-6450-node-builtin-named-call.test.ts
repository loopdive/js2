// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6450 — a direct CALL of a node-builtin NAMED import compiled to null on the
// `--platform node` lane.
//
// `registerNodeBuiltinImports` binds `import { createHash } from 'node:crypto'`
// as a MEMBER of the `__node_crypto` module thunk, and the VALUE read has had
// an arm for that since #4616. The CALL position had none, so
// `compileIdentifierCall` fell through to the bare-name `closureMap`/`funcMap`
// ladder — which is keyed across the WHOLE linked graph:
//
//   - `entry.js` + `lib.js`: `lib.js` exports a same-named async `createHash`
//     (hono's own `src/utils/crypto.ts` shape), so the call reached THAT
//     function and its Promise answered `update is not a function`. A
//     cross-module name leak, not TS shadowing.
//   - `solo.js`: nothing to reach, so the ladder hit its graceful
//     `ref.null.extern` default and `.update` threw off null.
//
// Both are now `__extern_method_call(__node_crypto(), "createHash", [args])`,
// which also binds `this` to the module object.

import { createHash as nodeCreateHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compileProject } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const ENTRY = fileURLToPath(new URL("./fixtures/issue-6450/entry.js", import.meta.url));
const SOLO = fileURLToPath(new URL("./fixtures/issue-6450/solo.js", import.meta.url));
const NAMED_CRYPTO = fileURLToPath(new URL("./fixtures/issue-6450/named-crypto/entry.js", import.meta.url));

/** The native oracle every Wasm digest below is compared against. */
const NATIVE_SHA256_A = nodeCreateHash("sha256").update("a").digest("hex");

type Compiled = {
  readonly importNames: readonly string[];
  readonly exports: WebAssembly.Exports;
};

async function compile(entry: string, platform: "node" | "web" = "node"): Promise<Compiled> {
  const result = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "gc",
    platform,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildCompiledImports(result, {}) as Record<string, unknown> & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports.setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (imports.__setInstance as ((i: WebAssembly.Instance) => void) | undefined)?.(instance);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return {
    importNames: ((result.imports ?? []) as readonly { readonly name: string }[]).map((entry) => entry.name),
    exports: instance.exports,
  };
}

describe("#6450 — calling a node-builtin named import", () => {
  it("routes `createHash('sha256')` through the module thunk when a same-named graph function exists", async () => {
    const compiled = await compile(ENTRY);
    const hex = compiled.exports.hex as () => string;
    // Parent: threw `update is not a function` — lib.js's async export was
    // called instead, and a Promise has no `.update`.
    expect(hex()).toBe(NATIVE_SHA256_A);
  });

  it("routes the bare-`'crypto'` one-file reduction the same way", async () => {
    const compiled = await compile(SOLO);
    const hex = compiled.exports.hex as () => string;
    // Parent: threw reading `update` of null — the graceful `ref.null.extern`
    // default served the call.
    expect(hex()).toBe(NATIVE_SHA256_A);
  });

  it("answers a real uuid for a second named import from the same module", async () => {
    const compiled = await compile(ENTRY);
    const uuid = compiled.exports.uuid as () => string;
    // Parent: `null`. `randomUUID` was null for exactly the same reason —
    // the `__nodefn__` typed stubs only exist in the single-file lane.
    const value = uuid();
    expect(value).toHaveLength(36);
    expect(value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  // Anti-vacuity control 1: the new arm must claim ONLY the import binding. If
  // it ever widened to the bare name, lib.js's own async function would be
  // replaced by a `crypto.createHash` call and this would stop returning the
  // library's string (or throw on the unknown algorithm).
  it("leaves a same-named call that really does resolve to a graph function alone", async () => {
    const compiled = await compile(ENTRY);
    const viaLib = compiled.exports.viaLib as (data: string) => Promise<string>;
    await expect(viaLib("abc")).resolves.toBe("lib:SHA-256:abc");
  });

  // Anti-vacuity control 2: the imports the arm is supposed to emit. Without
  // them the digests above could only have come from somewhere else.
  it("emits the module thunk and the generic method bridge", async () => {
    const compiled = await compile(ENTRY);
    expect(compiled.importNames).toContain("__node_crypto");
    expect(compiled.importNames).toContain("__extern_method_call");
    // The single-file `compile()` lane lowers the name to a raw `env.createHash`
    // import with no classifier entry. The project lane must never do that.
    expect(compiled.importNames).not.toContain("createHash");
  });

  // hono's real shape: the sibling async module is itself NAMED `crypto.js`, and
  // the checker's resolved signature for the builtin call lands on its async
  // arrow — so the async-call repair wrapped the builtin's Hash in
  // `Promise_resolve`. Parent (with the call routing above): still
  // `update is not a function`.
  it("does not async-wrap the builtin call when a graph module named `crypto.js` exports an async `createHash`", async () => {
    const compiled = await compile(NAMED_CRYPTO);
    expect((compiled.exports.hex as () => string)()).toBe(NATIVE_SHA256_A);
    // Anti-vacuity: the library's own async function is still async.
    await expect((compiled.exports.viaLib as (data: string) => Promise<string>)("abc")).resolves.toBe(
      "lib:SHA-256:abc",
    );
  });
});
