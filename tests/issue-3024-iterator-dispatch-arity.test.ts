// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3024 — iterator `next`/`return` dispatcher emitted a call one argument short
 * for a user iterator method with a formal parameter.
 *
 * `emitMethodDispatch` (src/codegen/index.ts) generates the module-level
 * `__call_next` / `__call_return` dispatchers (`(externref) -> externref`). For
 * each user struct with a `<struct>_next` / `<struct>_return` method it emitted
 * `local.get; ref.cast; call <method>` — only the receiver. A user iterator
 * method with a formal parameter (`next(value)` / `return(value)`) has an EXTRA
 * wasm param, so the call was one argument short → `not enough arguments on the
 * stack for call (need 2, got 1)` = invalid Wasm. Parameterless `next()` was fine.
 *
 * Fix pads each param beyond the receiver with the "missing trailing arg" default
 * (undefined for an externref value param; type default otherwise). Byte-inert
 * for parameterless iterator methods (`extraParams = []`).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { runTest262File } from "./test262-runner.ts";

const T262 = join(process.cwd(), "test262");

async function validates(src: string): Promise<{ ok: boolean; msg: string }> {
  const r: any = await compile(src, { fileName: "t.ts" });
  if (!r.success) return { ok: false, msg: `compile failed: ${(r.errors ?? [])[0]?.message ?? "?"}` };
  if (WebAssembly.validate(r.binary)) return { ok: true, msg: "" };
  let msg = "invalid";
  try {
    await WebAssembly.compile(r.binary);
  } catch (e: any) {
    msg = String(e.message).split("\n")[0];
  }
  return { ok: false, msg };
}

const iter = (method: string) => `
class C {
  ${method}
  [Symbol.iterator]() { return this; }
}
var c = new C();
for (const x of c) { break; }
`;

describe("#3024 — iterator next/return dispatcher arity", () => {
  it("user iterator method with a formal param validates (next(value)/return(value))", async () => {
    for (const method of [
      "next(v: number) { return { value: v, done: true }; }",
      "next(v) { return { value: v, done: true }; }",
      "next() { return { value: 1, done: false }; }\n  return(v: number) { return { value: v, done: true }; }",
    ]) {
      const { ok, msg } = await validates(iter(method));
      expect(ok, `${msg}\n---\n${method}`).toBe(true);
    }
  });

  it("parameterless iterator method still validates (byte-inert path)", async () => {
    const { ok, msg } = await validates(iter("next() { return { value: 1, done: true }; }"));
    expect(ok, msg).toBe(true);
  });

  const FILES: [rel: string, category: string][] = [
    ["test/built-ins/Iterator/zip/iterables-iteration.js", "built-ins/Iterator"],
    ["test/built-ins/Iterator/zip/iterator-zip-iteration.js", "built-ins/Iterator"],
    ["test/built-ins/Iterator/zipKeyed/iterator-zip-iteration.js", "built-ins/Iterator"],
    [
      "test/built-ins/AsyncFromSyncIteratorPrototype/next/absent-value-not-passed.js",
      "built-ins/AsyncFromSyncIteratorPrototype",
    ],
    [
      "test/built-ins/AsyncFromSyncIteratorPrototype/return/absent-value-not-passed.js",
      "built-ins/AsyncFromSyncIteratorPrototype",
    ],
  ];

  it.runIf(existsSync(T262))(
    "representative test262 files no longer emit invalid Wasm (were compile_error / instantiate-fail)",
    async () => {
      for (const [rel, category] of FILES) {
        const abs = join(T262, rel);
        if (!existsSync(abs)) continue;
        const r = await runTest262File(abs, category, 20000);
        const msg = String(r.error ?? r.reason ?? "");
        expect(msg, `${rel}: ${r.status} — ${msg}`).not.toMatch(/invalid Wasm binary|Compiling function/i);
      }
    },
    60000,
  );
});
