// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4195 — the dynamic-eval refusal named a target that supports it, and fired
 * twice per top-level call site.
 *
 * Both halves were found by compiling a hand-written file with the published
 * `js2wasm@0.68.0`, and both reproduced identically on main.
 *
 * A. The message read "not supported in --target standalone/wasi".
 *    `--standalone` is the ONE no-JS-host target that does support dynamic
 *    eval: the provider gate is `if (!ctx.standalone) return undefined` in
 *    runtime-eval-provider.ts, so a standalone build emits the
 *    `js2wasm:runtime-eval` imports and never reaches the refusal. Naming it
 *    in the refusal pointed users away from the working flag.
 *
 * B. One top-level `eval` produced two identical diagnostics, two produced
 *    four, and an `eval` inside a function produced one. The asymmetry is the
 *    diagnosis: `compileDeclarations` runs `compileModuleInitBody()` twice
 *    (pass 1 seeds closure/setup discovery, pass 2 emits against the final
 *    inlinable-function registry). Pass 1's body is discarded, but `ctx.errors`
 *    was the one piece of pass-1 state nothing reset.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const DYNAMIC_EVAL_ONE = `function id(s) { return s; }
var a = eval(id("1+1"));
`;

const DYNAMIC_EVAL_TWO = `function id(s) { return s; }
var a = eval(id("1+1"));
var b = eval(id("2+2"));
`;

// `f` must actually be reached — an uncalled body is never compiled, so
// without the call site this fixture measures nothing.
const DYNAMIC_EVAL_IN_FUNCTION = `function id(s) { return s; }
function f() { return eval(id("1+1")); }
var a = f();
`;

async function evalWarnings(source: string, target: "wasi" | "standalone") {
  const result = await compile(source, { fileName: "test.js", target, allowJs: true });
  return (result.errors ?? []).filter((e) => e.message.includes("dynamic eval"));
}

describe("#4195 dynamic-eval refusal", () => {
  describe("B — one diagnostic per call site", () => {
    it("emits exactly one warning for a single TOP-LEVEL eval (was 2)", async () => {
      expect(await evalWarnings(DYNAMIC_EVAL_ONE, "wasi")).toHaveLength(1);
    });

    it("emits exactly two warnings for two top-level evals (was 4)", async () => {
      expect(await evalWarnings(DYNAMIC_EVAL_TWO, "wasi")).toHaveLength(2);
    });

    it("still emits exactly one for an eval inside a function", async () => {
      // The control: function bodies were never double-compiled, so this arm
      // was already correct and must not change.
      expect(await evalWarnings(DYNAMIC_EVAL_IN_FUNCTION, "wasi")).toHaveLength(1);
    });
  });

  describe("A — the message names the condition that actually applies", () => {
    it("names wasi, not standalone, and points at the flag that works", async () => {
      const [warning] = await evalWarnings(DYNAMIC_EVAL_ONE, "wasi");
      expect(warning).toBeDefined();
      expect(warning!.message).toContain("--target wasi");
      expect(warning!.message).toContain("--standalone");
      // The regression being pinned: the old string claimed standalone could
      // not do this.
      expect(warning!.message).not.toContain("not supported in --target standalone");
    });

    it("does not refuse dynamic eval under --standalone at all", async () => {
      // The measurement behind (A): standalone materializes the provider ABI,
      // so there is no refusal to word correctly in the first place.
      expect(await evalWarnings(DYNAMIC_EVAL_ONE, "standalone")).toHaveLength(0);
    });
  });

  it("static eval still folds on every target — no refusal, no provider", async () => {
    // Guards the boundary the two paths share: a constant-string argument is
    // spliced at compile time (#1163) and must never reach either arm.
    for (const target of ["wasi", "standalone"] as const) {
      expect(await evalWarnings('var r = eval("1 + 1");\n', target)).toHaveLength(0);
    }
  });
});
