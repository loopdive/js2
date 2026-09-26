// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it } from "vitest";
import { packedFunctionCallLayout } from "../src/codegen/function-proto-call.js";
import type { CodegenContext, FunctionContext } from "../src/codegen/context/types.js";

function fixture() {
  return {
    ctx: {
      targetProfile: { target: "standalone" },
      exportsConsumedByWasm: false,
      linkedNamespaces: new Set<string>(),
      vecTypeMap: new Map([["externref", 1]]),
      mod: {
        types: [
          { kind: "array", element: { kind: "externref" } },
          { kind: "struct", fields: [{ type: { kind: "i32" } }, { type: { kind: "ref_null", typeIdx: 0 } }] },
        ],
      },
    },
    fctx: {
      params: [
        { type: { kind: "ref", typeIdx: 2 } },
        { type: { kind: "externref" } },
        { type: { kind: "ref_null", typeIdx: 1 } },
      ],
    },
  };
}

const variants: [string, (f: ReturnType<typeof fixture>) => void][] = [
  [
    "WASI",
    ({ ctx }) => {
      ctx.targetProfile.target = "wasi";
    },
  ],
  [
    "GC native regime",
    ({ ctx }) => {
      ctx.targetProfile.target = "gc";
    },
  ],
  [
    "provider",
    ({ ctx }) => {
      ctx.exportsConsumedByWasm = true;
    },
  ],
  [
    "linked consumer",
    ({ ctx }) => {
      ctx.linkedNamespaces.add("js2wasm:npm:peer");
    },
  ],
  [
    "noncanonical vector",
    ({ ctx }) => {
      ctx.vecTypeMap.set("externref", 3);
    },
  ],
  [
    "non-reference argument",
    ({ fctx }) => {
      fctx.params[2].type.kind = "externref";
    },
  ],
  [
    "wrong arity",
    ({ fctx }) => {
      fctx.params.pop();
    },
  ],
  [
    "wrong self",
    ({ fctx }) => {
      fctx.params[0].type.kind = "externref";
    },
  ],
  [
    "wrong receiver",
    ({ fctx }) => {
      fctx.params[1].type.kind = "i32";
    },
  ],
  [
    "wrong length",
    ({ ctx }) => {
      ctx.mod.types[1].fields![0].type.kind = "f64";
    },
  ],
  [
    "wrong element",
    ({ ctx }) => {
      ctx.mod.types[0].element!.kind = "f64";
    },
  ],
];

it("recognizes the exact vector layout without mutating context", () => {
  const f = fixture();
  const before = structuredClone(f);
  expect(packedFunctionCallLayout(f.ctx as unknown as CodegenContext, f.fctx as unknown as FunctionContext)).toEqual({
    vecTypeIdx: 1,
  });
  expect(f).toEqual(before);
});

it.each(variants)("declines %s without mutating context", (_name, mutate) => {
  const f = fixture();
  mutate(f);
  const before = structuredClone(f);
  expect(
    packedFunctionCallLayout(f.ctx as unknown as CodegenContext, f.fctx as unknown as FunctionContext),
  ).toBeUndefined();
  expect(f).toEqual(before);
});
