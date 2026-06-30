// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2868 — `--target standalone` emitted an INVALID Wasm binary for modules that
// use decodeURI/encodeURI together with a later-added late import (a thrown user
// class + `e instanceof URIError`, which pulls in `__box_boolean` and an error
// constructor AFTER the URI helper is emitted). The validator rejected
// `__uri_decode`/`__uri_encode` with, e.g.:
//
//   call[0] expected type i32, found extern.convert_any of type (ref extern)
//
// Root cause: the helpers built `throwURIError` as a SHARED `const Instr[]` and
// spread it (`...throwURIError`) at ~13 throw sites. A spread is shallow, so the
// single `{ op:"call", funcIdx: uriErrCtorIdx }` (and the `throw`) Instr OBJECTS
// were aliased at every site. When a late import was added, the index-shift
// walker (`shiftLateImportIndices`) mutates `instr.funcIdx += delta` once per
// occurrence in the body — so the shared call object was shifted ~13× instead of
// once, landing on an out-of-range / wrong-signature function (the
// single-occurrence `__str_flatten` call stayed correct). Fix: make
// `throwURIError` a FACTORY returning fresh Instr objects per call, so each
// emitted `call`/`throw` is an independent object the shift visits exactly once.
//
// `WebAssembly.compile(binary)` is the precise regression check: it validates
// the module structurally and is exactly what threw "invalid Wasm binary"
// pre-fix. A subset is also instantiated+run for functional proof.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(src: string): Promise<Uint8Array> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  return r.binary;
}

/** Compile standalone and assert the emitted binary is structurally VALID. */
async function expectValid(src: string): Promise<void> {
  const binary = await compileStandalone(src);
  // Pre-fix this rejected with "invalid Wasm binary: ... __uri_decode failed".
  await expect(WebAssembly.compile(binary)).resolves.toBeDefined();
}

/** Compile standalone, instantiate with no host imports, and run `test()`. */
async function runStandalone(src: string): Promise<unknown> {
  const binary = await compileStandalone(src);
  const { instance } = await WebAssembly.instantiate(binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2868 standalone URI helpers emit a VALID binary (shared-Instr shift bug)", () => {
  // The thrown user class + `instanceof URIError` adds late imports AFTER
  // `__uri_decode` is emitted — the exact late-import shift that over-shifted the
  // aliased throw/call. This shape reproduced the invalid binary on pre-fix main.
  it("decodeURI in a throw/instanceof guard emits a valid binary", async () => {
    await expectValid(`
      class Test262Error { message: string; constructor(m: string = "") { this.message = m; } }
      function check(): number {
        try { decodeURI("%"); throw new Test262Error("no throw"); }
        catch (e) { if (!(e instanceof URIError)) throw new Test262Error("bad"); }
        return 1;
      }
      export function test(): number { return check(); }
    `);
  });

  it("encodeURI in a throw/instanceof guard emits a valid binary", async () => {
    await expectValid(`
      class Test262Error { message: string; constructor(m: string = "") { this.message = m; } }
      function check(): number {
        var s = encodeURIComponent("a b&c");
        if (s.length === 0) throw new Test262Error("empty");
        try { decodeURI("%"); throw new Test262Error("no throw"); }
        catch (e) { if (!(e instanceof URIError)) throw new Test262Error("bad"); }
        return 1;
      }
      export function test(): number { return check(); }
    `);
  });

  it("decodeURIComponent decodes correctly under standalone (functional)", async () => {
    expect(await runStandalone(`export function test(): number { return decodeURIComponent("a%20b").length; }`)).toBe(
      3,
    ); // "a b"
  });

  it("encodeURIComponent encodes correctly under standalone (functional)", async () => {
    expect(await runStandalone(`export function test(): number { return encodeURIComponent("a b").length; }`)).toBe(5); // "a%20b"
  });

  it("encode/decode round-trip preserves a non-ASCII string under standalone (functional)", async () => {
    // Returned as raw i32 1 (=== true) under direct standalone instantiation
    // (no wrapExports boolean marshalling).
    expect(
      await runStandalone(
        `export function test(): boolean { return decodeURIComponent(encodeURIComponent("héllo")) === "héllo"; }`,
      ),
    ).toBe(1);
  });
});
