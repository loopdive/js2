// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5272 — the in-process original-harness path must apply the SAME standalone
// host-import leak check the sharded worker applies (#2961).
//
// Before this landed, `runTest262File(…, "standalone")` handed a leaked `env::*`
// import to `buildImports`, satisfied it from the JS host and reported whatever
// the test then did — sometimes a pass. So a local before/after measured with
// `scripts/run-test262-paths.mts --standalone` was not the number the
// merge_group would see.
//
// FIXTURE CHOICE — `new SharedArrayBuffer(...)` still emits
// `env::SharedArrayBuffer_new` on `--target standalone` (verified 2026-09-02
// against the committed standalone baseline: 296 rows carry exactly that leak).
// `Promise.all` / `Set` / `WeakMap` used to leak too and no longer do, so if
// this construct ever gains a Wasm-native lowering, the `leaks on standalone
// today` guard below fails FIRST and tells you to move the fixture rather than
// silently vacuating the assertion.

import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { runTest262File, standaloneHostImportError } from "./test262-runner.js";

/** Rows the sharded baseline scores `compile_error` / `host_import_leak`. */
const LEAKY_ROWS = [
  "built-ins/SharedArrayBuffer/prototype/slice/nonconstructor.js",
  "built-ins/Atomics/notify/bad-range.js",
] as const;

/** Control: a standalone row that needs no host import and passes. */
const HOST_FREE_ROW = "built-ins/Proxy/revocable/revoke.js";

const category = (relativePath: string) => relativePath.split("/").slice(0, 2).join("/");

describe("#5272 — runTest262File applies the standalone host-import leak check", () => {
  it("still emits a host import for the fixture construct (guards the rows below)", async () => {
    const result = await compile("const b = new SharedArrayBuffer(8);\n", {
      allowJs: true,
      fileName: "test.js",
      target: "standalone",
    });
    const names = (result.imports ?? []).map((entry) => `${entry.module}::${entry.name}`);
    expect(
      names,
      "SharedArrayBuffer no longer leaks on standalone — pick a construct that does, or stub result.imports",
    ).toContain("env::SharedArrayBuffer_new");
  });

  it.each(LEAKY_ROWS)("scores %s as a host_import_leak compile_error on standalone", async (relativePath) => {
    const result = await runTest262File(
      resolve("test262/test", relativePath),
      category(relativePath),
      undefined,
      "standalone",
    );
    expect(result.status, result.error ?? result.reason).toBe("compile_error");
    expect(result.error).toMatch(/standalone target emitted host imports/);
    expect(result.error).toContain("env::SharedArrayBuffer_new");
  });

  it.each(LEAKY_ROWS)("leaves %s alone on the JS-host lane", async (relativePath) => {
    const result = await runTest262File(resolve("test262/test", relativePath), category(relativePath));
    expect(result.status).not.toBe("compile_error");
    expect(result.error ?? "").not.toMatch(/standalone target emitted host imports/);
  });

  it("still passes a host-free standalone row", async () => {
    const result = await runTest262File(
      resolve("test262/test", HOST_FREE_ROW),
      category(HOST_FREE_ROW),
      undefined,
      "standalone",
    );
    expect(result.status, result.error ?? result.reason).toBe("pass");
  });

  it("reuses the one leak classifier rather than a second copy", () => {
    expect(standaloneHostImportError("standalone", [{ module: "env", name: "SharedArrayBuffer_new" }])).toMatch(
      /standalone target emitted host imports: env::SharedArrayBuffer_new \(#2961\)/,
    );
    expect(standaloneHostImportError(undefined, [{ module: "env", name: "SharedArrayBuffer_new" }])).toBeUndefined();
    expect(standaloneHostImportError("standalone", [])).toBeUndefined();
  });
});
