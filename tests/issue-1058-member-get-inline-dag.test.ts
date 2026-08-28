// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, expect, it } from "vitest";

import { planGuardReuse } from "../src/codegen/ic-guard-reuse.js";
import { inlineMemberGetCallSites, rewriteInstrs } from "../src/codegen/member-get-inline-ic.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import type { Instr, WasmFunction } from "../src/ir/types.js";

const originalGuardReuse = process.env.JS2WASM_IC_GUARD_REUSE;

afterEach(() => {
  if (originalGuardReuse === undefined) Reflect.deleteProperty(process.env, "JS2WASM_IC_GUARD_REUSE");
  else process.env.JS2WASM_IC_GUARD_REUSE = originalGuardReuse;
});

function inlineContext(functions: WasmFunction[]): CodegenContext {
  return {
    mod: {
      types: [
        { kind: "func", params: [{ kind: "externref" }], results: [{ kind: "externref" }] },
        {
          kind: "func",
          params: [{ kind: "externref" }, { kind: "i32" }],
          results: [{ kind: "externref" }],
        },
        { kind: "struct", name: "Carrier", fields: [{ name: "value", type: { kind: "externref" }, mutable: true }] },
      ],
      imports: [],
      functions,
    },
    numImportFuncs: 0,
    funcMap: new Map([["__get_member_value", 7]]),
    structMap: new Map([["Carrier", 2]]),
    structFields: new Map([["Carrier", [{ name: "value", type: { kind: "externref" }, mutable: true }]]]),
    shapeIdByStructName: new Map(),
    memberGetDispatchNames: new Set(["value"]),
    memberGetTypedF64DispatchNames: new Set(),
    classSet: new Set(),
    classExprNameMap: new Map(),
    classAccessorSet: new Set(),
    staticAccessorSet: new Set(),
    classParentMap: new Map(),
  } as unknown as CodegenContext;
}

it("#1058 rewrites a shared member-get instruction DAG once", () => {
  const leaf: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: 7 },
  ];
  let shared = leaf;
  for (let depth = 0; depth < 28; depth++) {
    shared = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
  }

  const fn: WasmFunction = { name: "target", typeIdx: 0, locals: [], body: shared };
  const ctx = {
    mod: {
      types: [{ kind: "func", params: [{ kind: "externref" }], results: [] }],
    },
  } as unknown as CodegenContext;
  const stats = { patched: 0, declinedProducer: 0 };

  rewriteInstrs(
    ctx,
    fn,
    fn.body,
    new Map([
      [
        7,
        {
          propName: "value",
          resultType: { kind: "externref" },
          structTypeIdx: 1,
          fieldIdx: 0,
          armTail: [],
        },
      ],
    ]),
    () => 1,
    stats,
    undefined,
    new WeakSet<Instr[]>(),
  );

  expect(stats).toEqual({ patched: 1, declinedProducer: 0 });
  expect(leaf.filter((instr) => instr.op === "if")).toHaveLength(1);
});

it("#1058 declines guard reuse inside a multiply-parented instruction DAG", () => {
  process.env.JS2WASM_IC_GUARD_REUSE = "1";

  const leaderCall: Instr = { op: "call", funcIdx: 7 };
  const followerCall: Instr = { op: "call", funcIdx: 7 };
  const leaf: Instr[] = [{ op: "local.get", index: 0 }, followerCall];
  let shared = leaf;
  for (let depth = 0; depth < 28; depth++) {
    shared = [{ op: "if", blockType: { kind: "empty" }, then: shared, else: shared }];
  }

  // The first incoming edge has a matching leader. The later edge follows a
  // receiver write and therefore must not read that leader's cached guard/cast.
  // Because both edges reference the same instruction array, rewriting it from
  // either incoming state would affect both.
  const body: Instr[] = [
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 0 }, leaderCall, { op: "block", blockType: { kind: "empty" }, body: shared }],
      else: [],
    },
    { op: "local.get", index: 1 },
    { op: "local.set", index: 0 },
    { op: "block", blockType: { kind: "empty" }, body: shared },
  ];

  const reuse = planGuardReuse(
    body,
    (index) => (index === 0 || index === 1 ? "externref" : undefined),
    (instr) => (instr.op === "call" && instr.funcIdx === 7 ? 1 : undefined),
  );

  // The shared follower is conservatively left as a full IC, so the lone
  // unshared call has no follower and no reuse plan is needed at all.
  expect(reuse).toBeUndefined();
});

it("#1058 declines member-get inlining for shared bodies before allocating function-local scratch", () => {
  process.env.JS2WASM_INLINE_PROP_IC = "1";
  const leaf: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: 7 },
  ];
  const first: WasmFunction = { name: "first", typeIdx: 0, locals: [], body: leaf };
  const second: WasmFunction = {
    name: "second",
    typeIdx: 1,
    locals: [
      { name: "paddingA", type: { kind: "i32" } },
      { name: "paddingB", type: { kind: "i64" } },
    ],
    body: leaf,
  };
  const ctx = inlineContext([first, second]);

  inlineMemberGetCallSites(ctx);

  expect(first.locals).toEqual([]);
  expect(second.locals).toHaveLength(2);
  expect(leaf).toEqual([
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: 7 },
  ]);
});

it("#1058 declines production member-get inlining on a depth-28 multiply-parented DAG", () => {
  process.env.JS2WASM_INLINE_PROP_IC = "1";
  const leaf: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: 7 },
  ];
  let body = leaf;
  for (let depth = 0; depth < 28; depth++) {
    body = [{ op: "if", blockType: { kind: "empty" }, then: body, else: body }];
  }
  const fn: WasmFunction = { name: "target", typeIdx: 0, locals: [], body };

  inlineMemberGetCallSites(inlineContext([fn]));

  expect(fn.locals).toEqual([]);
  expect(leaf).toEqual([
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: 7 },
  ]);
});
