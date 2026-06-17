// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2090 — the stack-repair pass must not invent a value for a missing slot of
 * unrecoverable type. Previously it pushed a "safe default" `ref.null.extern`,
 * masking the producing codegen bug as a silent null. It now records the site
 * and `stackBalance` converts it into a structured hard compile error
 * (surfaced via `mod.codegenErrors`).
 *
 * Report 04 §5 Phase 1 concluded there is no legitimate trigger from real TS
 * input, so we drive the arm directly with a hand-built module: a `block` whose
 * type-indexed (multi-value) block type expects more results than its body
 * produces. That forces the type-indexed missing-slot path the old code patched
 * with an invented null.
 */
import { describe, expect, it } from "vitest";
import { stackBalance } from "../src/codegen/stack-balance.js";
import type { WasmModule } from "../src/ir/types.js";

function emptyModule(): WasmModule {
  return {
    types: [],
    imports: [],
    functions: [],
    globals: [],
    exports: [],
    memories: [],
    tables: [],
    elements: [],
    dataSegments: [],
    tags: [],
  } as unknown as WasmModule;
}

describe("#2090 stack-balance refuses to invent a value", () => {
  it("records a structured compile error for a missing slot of unrecoverable (type-indexed) type", () => {
    const mod = emptyModule();
    // type 0: the function signature () -> i32
    // type 1: a multi-value block type (i32, i32) used as a `block` result type
    //         whose body produces nothing → forces the type-indexed missing arm.
    mod.types.push({ kind: "func", name: "$f", params: [], results: [{ kind: "i32" }] });
    mod.types.push({ kind: "func", name: "$mv", params: [], results: [{ kind: "i32" }, { kind: "i32" }] });

    mod.functions.push({
      name: "victim",
      typeIdx: 0,
      locals: [],
      // A block typed to produce TWO values (type idx 1) but whose body pushes
      // none. fixBranch sees expected=2, actual=0, blockType.kind==="type" →
      // the #2090 arm. Then the function still needs an i32 to satisfy its own
      // result; the recorded error fails the compile regardless.
      body: [{ op: "block", blockType: { kind: "type", typeIdx: 1 }, body: [] }, { op: "drop" }],
      exported: false,
    } as never);

    stackBalance(mod);

    const errs = (mod as { codegenErrors?: { message: string }[] }).codegenErrors ?? [];
    const hit = errs.find((e) => /#2090/.test(e.message) && /victim/.test(e.message));
    expect(hit, `expected a #2090 structured error, got: ${JSON.stringify(errs)}`).toBeTruthy();
    expect(hit!.message).toMatch(/refuses to invent a value|mask a producing codegen bug/i);
  });

  it("does NOT record an error for a legitimate known-type missing slot (typed zero default)", () => {
    const mod = emptyModule();
    mod.types.push({ kind: "func", name: "$f", params: [], results: [{ kind: "i32" }] });
    // A val-typed (i32) block whose body produces nothing — this is the
    // LEGITIMATE arm: the repair pass fills it with `i32.const 0`, no error.
    mod.functions.push({
      name: "ok",
      typeIdx: 0,
      locals: [],
      body: [{ op: "block", blockType: { kind: "val", type: { kind: "i32" } }, body: [] }],
      exported: false,
    } as never);

    stackBalance(mod);

    const errs = (mod as { codegenErrors?: { message: string }[] }).codegenErrors ?? [];
    expect(errs.filter((e) => /#2090/.test(e.message))).toEqual([]);
  });
});
