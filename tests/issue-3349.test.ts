// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3349 — the real, unmodified test262 harness file `propertyHelper.js`
// (which 5,229 / 53,406 test262 files `includes:`) previously failed to
// compile ENTIRELY. Merely defining `verifyEnumerable`
// (`test262/harness/propertyHelper.js:423`) — without ever calling it — was
// enough to break codegen with the #2043 late-import index-shift class error
// ("local index out of range … at function 'verifyEnumerable'").
//
// That primary failure is resolved on current main. This is the regression
// guard: (1) the exact minimal repro from the issue (assert.js + sta.js +
// propertyHelper.js wrapped in a function, no call needed) compiles to a
// structurally-valid binary; and (2) a representative sample of real
// propertyHelper-including test262 files run end-to-end through the full
// harness and PASS (not just "compiles").
//
// NOTE: a distinct, still-live instance of the same #2043 class remains in
// `deepEqual.js`'s deeply-nested format/lazyResult closures (a STALE LOCAL
// index, not a funcIdx shift) — tracked separately as #3378. It is explicitly
// a "second, separate confirmation target" in #3349 and is NOT part of this
// issue's acceptance criteria (which are all about propertyHelper).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { runTest262File } from "./test262-runner.ts";

const T262 = join(process.cwd(), "test262");
const HARNESS = join(T262, "harness");

describe("#3349 propertyHelper.js compiles (verifyEnumerable index-shift guard)", () => {
  it.runIf(existsSync(HARNESS))(
    "the minimal repro (assert + sta + propertyHelper, no call) compiles to a valid binary",
    async () => {
      const rd = (f: string) => readFileSync(join(HARNESS, f), "utf8");
      const body = rd("assert.js") + rd("sta.js") + rd("propertyHelper.js") + '\nconsole.log("ok");\n';
      const src = `export function test() {\n${body}\n}`;
      const r = await compile(src, {
        target: "gc",
        fileName: "test.ts",
        skipSemanticDiagnostics: true,
        emitWat: false,
        inferModuleStrictArguments: false,
      } as Parameters<typeof compile>[1]);
      expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(r.binary != null && r.binary.length > 0, "empty binary").toBe(true);
      // Structural validation — the pre-fix failure was a binary-emit RangeError
      // ("local index out of range") that surfaced only at encoding time.
      expect(await WebAssembly.validate(r.binary!), "module failed WebAssembly.validate").toBe(true);
    },
    30000,
  );

  it.runIf(existsSync(T262))(
    "representative propertyHelper-including test262 files run end-to-end and pass",
    async () => {
      const FILES: [rel: string, category: string][] = [
        ["test/built-ins/Object/getOwnPropertySymbols/length.js", "built-ins/Object"],
        ["test/built-ins/Object/getOwnPropertySymbols/name.js", "built-ins/Object"],
        ["test/built-ins/Object/prop-desc.js", "built-ins/Object"],
        ["test/built-ins/Boolean/prototype/S15.6.4_A2.js", "built-ins/Boolean"],
      ];
      for (const [rel, category] of FILES) {
        const abs = join(T262, rel);
        if (!existsSync(abs)) continue; // tolerate submodule pathing drift
        const r = await runTest262File(abs, category, 20000);
        const msg = String(r.error ?? r.reason ?? "");
        expect(r.status, `${rel}: ${r.status} — ${msg}`).toBe("pass");
      }
    },
    60000,
  );
});
