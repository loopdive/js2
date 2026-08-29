// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5186 — the #1058 hard stack-balance refusal fired on a body that the repair
// pass provably never touches. A terminal throw sequence is stack-polymorphic,
// so producers share ONE such array between an `{kind:"empty"}` `if` arm and a
// `{kind:"val", externref}` `if` arm; the preflight read the two block-type
// contexts as a disagreement and failed the whole function's compile.
//
// The guard the refusal exists for is unchanged: a body whose repair really
// does depend on the incoming block context is still refused (third case), and
// so is a body reached from two different FUNCTIONS (fourth case) — local
// indices are resolved against the owner there, which no terminator makes safe.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { stackBalance } from "../src/codegen/stack-balance.js";
import type { CodegenError } from "../src/codegen/context/types.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

/** Minimal module skeleton around a caller-supplied function list. */
function moduleWith(functions: unknown[]): WasmModule {
  return {
    types: [{ kind: "func", params: [], results: [] }],
    imports: [],
    functions,
    globals: [],
    tags: [{ typeIdx: 0 }],
    funcOrdinalToPosition: [],
  } as unknown as WasmModule;
}

describe("#5186 shared stack-polymorphic body across block contexts", () => {
  it("accepts one terminal throw body reached from an empty and a valued if arm", () => {
    // The exact shape measured in the failing modules: the SAME physical array
    // is `then` of a void `if` and `then` of an externref-valued `if`.
    const throwBody: Instr[] = [
      { op: "global.get", index: 0 },
      { op: "extern.convert_any" },
      { op: "throw", tagIdx: 0 },
    ];
    const mod = moduleWith([
      {
        name: "makeNativeError",
        typeIdx: 0,
        locals: [],
        body: [
          { op: "i32.const", value: 1 },
          { op: "if", blockType: { kind: "empty" }, then: throwBody, else: [] },
          { op: "i32.const", value: 1 },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: throwBody,
            else: [{ op: "ref.null.extern" }],
          },
          { op: "drop" },
        ],
      },
    ]);

    const diagnostics: CodegenError[] = [];
    stackBalance(mod, diagnostics);

    expect(diagnostics.map((error) => error.message).join("\n")).not.toMatch(
      /incompatible control-flow or function-local contexts/,
    );
    expect(mod.codegenErrors ?? []).toEqual([]);
    // The shared body is stack-polymorphic, so the pass must leave it alone
    // rather than append a drop for one owner and a value for the other.
    expect(throwBody).toEqual([
      { op: "global.get", index: 0 },
      { op: "extern.convert_any" },
      { op: "throw", tagIdx: 0 },
    ]);
  });

  it("still refuses a shared body whose repair DOES depend on the block context", () => {
    // No terminator: `fixBranch` would append a `drop` for the empty arm and
    // leave the value for the i32 arm. Refusing remains correct.
    const leaf: Instr[] = [{ op: "i32.const", value: 1 }];
    const mod = moduleWith([
      {
        name: "ambiguous",
        typeIdx: 0,
        locals: [],
        body: [
          { op: "block", blockType: { kind: "val", type: { kind: "i32" } }, body: leaf },
          { op: "drop" },
          { op: "block", blockType: { kind: "empty" }, body: leaf },
        ],
      },
    ]);

    const diagnostics: CodegenError[] = [];
    stackBalance(mod, diagnostics);

    expect(diagnostics.map((error) => error.message).join("\n")).toMatch(
      /incompatible control-flow or function-local contexts/,
    );
    expect(leaf).toEqual([{ op: "i32.const", value: 1 }]);
  });

  it("still refuses a terminal throw body shared across two functions", () => {
    // Cross-function sharing is a DIFFERENT hazard — the local/call-arg/
    // struct.new repairs resolve indices against the owning function — and is
    // deliberately NOT relaxed by the stack-polymorphism argument.
    const throwBody: Instr[] = [
      { op: "global.get", index: 0 },
      { op: "throw", tagIdx: 0 },
    ];
    const mod = moduleWith([
      { name: "a", typeIdx: 0, locals: [], body: [{ op: "block", blockType: { kind: "empty" }, body: throwBody }] },
      { name: "b", typeIdx: 0, locals: [], body: [{ op: "block", blockType: { kind: "empty" }, body: throwBody }] },
    ]);

    const diagnostics: CodegenError[] = [];
    stackBalance(mod, diagnostics);

    expect(diagnostics.map((error) => error.message).join("\n")).toMatch(
      /incompatible control-flow or function-local contexts/,
    );
  });

  it("compiles the construct-owner + plain-call-owner source shape (standalone)", async () => {
    // Reduced from test262 `harness/nativeErrors.js` `makeNativeError`: one
    // callee reached as `new Ctor(...)` and as `Ctor(...)`. The TypedArray use
    // is load-bearing — it is what makes codegen emit the `$__ta_ctor`
    // [[Call]] arm whose terminal throw is the shared array.
    const result = await compile(
      `
      function makeNativeError(Ctor: any, msg: string): any {
        let e: any;
        if (msg.length > 0) {
          e = new Ctor(msg);
        }
        if (msg.length > 1) {
          e = Ctor(msg);
        }
        return e;
      }

      const buf = new Int8Array(4);
      buf[0] = 1;

      export function test(): number {
        const err = makeNativeError(TypeError, "x");
        return err !== null && buf[0] === 1 ? 1 : 0;
      }
      `,
      { target: "standalone", nativeStrings: true } as never,
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    await expect(WebAssembly.compile(result.binary)).resolves.toBeInstanceOf(WebAssembly.Module);
  });
});
