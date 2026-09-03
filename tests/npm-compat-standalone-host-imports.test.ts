// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3781) The npm-compat standalone perf lane fails a package outright when its
// binary retains ANY host import ("standalone binary retained N host import(s)"),
// which is why react/redux had a JS-host trend line and no standalone one. Two
// codegen arms leaked such imports from ordinary library code:
//
//   * `process.env.<x>` — a Node gate every published CJS bundle carries.
//   * a method call on an `any` receiver whose name happens to be declared by
//     some lib.dom interface (redux's `store.getState()` first-matched
//     `NavigationHistoryEntry.getState`).
//
// Both are pinned here by compiling and asking the MODULE what it imports —
// the same question the perf lane asks — rather than by inspecting codegen.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Every non-`string_constants` import the standalone binary retains. */
async function standaloneHostImports(source: string): Promise<string[]> {
  const result = await compile(source, {
    fileName: "m.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors?.map((e) => e.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary!);
  return WebAssembly.Module.imports(module)
    .filter((entry) => entry.module !== "string_constants")
    .map((entry) => `${entry.module}.${entry.name}`);
}

describe("#3781 — a standalone binary keeps no host imports for ordinary library code", () => {
  it("reads `process.env` without the `__get_process_env` host import", async () => {
    expect(
      await standaloneHostImports(`
        export function f() { return process.env.NODE_ENV === "production" ? 1 : 2; }
      `),
    ).toEqual([]);
  });

  it("keeps the JS-host lane's `process.env` import (host mode is unchanged)", async () => {
    const result = await compile(`export function f() { return process.env.NODE_ENV === "production" ? 1 : 2; }`, {
      fileName: "m.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
    });
    expect(result.success).toBe(true);
    const imports = WebAssembly.Module.imports(await WebAssembly.compile(result.binary!)).map((e) => e.name);
    expect(imports).toContain("__get_process_env");
  });

  it("dispatches an `any`-receiver method natively instead of binding a lib.dom extern", async () => {
    // redux's shape: `createStore` returns an object literal, and the call site
    // types the receiver as `any`. `getState` is also declared by lib.dom's
    // NavigationHistoryEntry, whose `env` import no standalone instance can
    // satisfy.
    expect(
      await standaloneHostImports(`
        function createStore(reducer) {
          var currentState = reducer(undefined, { type: "INIT" });
          function getState() { return currentState; }
          function dispatch(action) { currentState = reducer(currentState, action); return action; }
          return { dispatch: dispatch, getState: getState };
        }
        export function g() {
          var store = createStore(function (s, a) { return (s || 0) + 1; });
          store.dispatch({ type: "x" });
          return store.getState();
        }
      `),
    ).toEqual([]);
  });
});
