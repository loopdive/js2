// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3053 U1 — wire the U0 carrier helper into the IR member-read path.
//
// U0 (#3053) built the byte-inert `__dyn_member_get(recv, key) -> carrier`
// primitive (+ the internal `__carrier_recv_to_extern` tag-6 peel), latched off
// via `ctx.usesDynMemberGet`. U1 is the THIN WIRING that lets the IR emit a
// dynamic member read `recv.name` / `recv[key]` as a bare `[call
// __dyn_member_get]` and flips that latch:
//
//   - a new IR node `dyn.member_get{recv, key}` (both `dynamic` carriers, result
//     `dynamic`) — builder `emitDynMemberGet`, verifier rules, lower.ts arm;
//   - `IrDynamicLowering.emitMemberGet()` / `emitElementGet()` → `[call
//     __dyn_member_get]`, resolved BY NAME, flipping `ctx.usesDynMemberGet`;
//   - `preregisterDynamicSupport` registers the helper up-front so the name
//     resolves at Phase-3 emit time (the finalize `ensureDynMemberGet` runs too
//     late for that);
//   - the from-ast `lowerPropertyAccess` / `lowerElementAccess` dynamic-receiver
//     arms produce the node.
//
// BYTE-INERT-OFF-PATH: the IR selector's move-only scan (`select.ts`
// `dynamicUsesAreMoveOnly`) still REJECTS a dyn receiver in a member read, so no
// from-ast producer reaches the node in a CLAIMED function until S5.P (U2) opens
// the scan. `prove-emit-identity` is 39/39 IDENTICAL vs the U0 base. These tests
// therefore exercise the wired path DIRECTLY (hand-built nodes + the production
// handle over a real CodegenContext), not through a full source compile.
//
// The RUNTIME value+tag preservation of the helper itself (object→tag-6
// identity, string→tag-5, number→tag-3, re-read composition) is proven by U0's
// `tests/issue-3053-u0-dyn-member-get.test.ts`; U1 proves the WIRING resolves
// the right helper by name, in the right operand order, and flips the latch.
//
// Aligned configs only: `standalone ⟹ fast` (create-context.ts), so the gc
// `$AnyValue` carrier (`makeDynamicLowering` `ctx.fast`) and U0's gc helper body
// (`ensureDynMemberGet` `ctx.standalone || ctx.wasi`) match in standalone/wasi,
// and the host externref carrier + host wrapper match in default mode. The
// `fast && !standalone` playground mode carrier-alignment is a U2 prerequisite
// (see the issue's U1 notes) and is NOT exercised here — it never emits a
// `dyn.member_get` while the selector scan is closed.

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { ensureAnyHelpers } from "../src/codegen/any-helpers.js";
// Side-effect import: registers the `flushLateImportShifts` codegen delegate
// that `addUnionImports` requires (same pattern as the #2949 S5 tests).
import "../src/codegen/expressions.js";
import { addUnionImports, createCodegenContext } from "../src/codegen/index.js";
import { ensureObjectRuntime } from "../src/codegen/object-runtime.js";
import { ensureDynMemberGet } from "../src/codegen/dyn-read.js";
import type { CodegenContext } from "../src/codegen/context/types.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import {
  asBlockId,
  asValueId,
  irDynamic,
  irVal,
  lowerIrFunctionToWasm,
  makeDynamicLowering,
  verifyIrFunction,
  type IrFunction,
  type IrLowerResolver,
  type IrType,
  type IrValueId,
} from "../src/ir/index.js";
import type { FuncTypeDef, Instr } from "../src/ir/types.js";
import { createEmptyModule } from "../src/ir/types.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3053-u1-ir-member-read");
const DYN: IrType = irDynamic();
const F64: IrType = irVal({ kind: "f64" });

// ---------------------------------------------------------------------------
// Contexts — real production ctx with `__dyn_member_get` registered the same
// way `preregisterDynamicSupport` does (object runtime + any helpers, then the
// latched `ensureDynMemberGet`).
// ---------------------------------------------------------------------------

function makeStandaloneCtxWithHelper(): CodegenContext {
  const ctx = createCodegenContext(createEmptyModule(), {} as unknown as ts.TypeChecker, {
    // `fast` drives the gc carrier (`makeDynamicLowering` `ctx.fast`); `standalone`
    // drives U0's gc helper body (`ensureDynMemberGet` `ctx.standalone || wasi`).
    // The production `target: "standalone"` normalization sets both — pass both
    // explicitly here so the handle and the helper agree on the gc `$AnyValue`
    // carrier (a raw `createCodegenContext` does NOT derive `fast` from
    // `standalone`; only the `compile()` target-normalization does).
    fast: true,
    standalone: true,
  });
  ensureObjectRuntime(ctx); // __extern_get / __box_* / $Object
  ensureAnyHelpers(ctx); // $AnyValue + __any_* (incl. the honest classifier deps)
  ctx.usesDynMemberGet = true; // the latch U1's emit method flips at a call site
  ensureDynMemberGet(ctx);
  return ctx;
}

function makeHostCtxWithHelper(): CodegenContext {
  const ctx = createCodegenContext(createEmptyModule(), {} as unknown as ts.TypeChecker, {});
  ensureObjectRuntime(ctx); // host `__extern_get` (the wrapper's callee)
  addUnionImports(ctx);
  ctx.usesDynMemberGet = true;
  ensureDynMemberGet(ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// Node shape + construction guard + verifier backstop
// ---------------------------------------------------------------------------

describe("#3053 U1 — emitDynMemberGet builds a verifier-clean dyn.member_get node", () => {
  it("appends a dyn.member_get node with a dynamic result and registers typeOf", () => {
    const b = new IrFunctionBuilder(identities.next("read1"), [DYN], true);
    const recv = b.addParam("recv", DYN);
    const key = b.addParam("key", DYN);
    b.openBlock();
    const r = b.emitDynMemberGet(recv, key);
    expect(b.typeOf(r)).toEqual(DYN);
    b.terminate({ kind: "return", values: [r] });
    const fn = b.finish();
    const [node] = fn.blocks[0].instrs;
    expect(node).toMatchObject({ kind: "dyn.member_get", recv, key, result: r, resultType: DYN });
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("rejects a non-dynamic receiver at construction (carrier-only)", () => {
    const b = new IrFunctionBuilder(identities.next("readBadRecv"), [DYN], true);
    const recv = b.addParam("recv", F64);
    const key = b.addParam("key", DYN);
    b.openBlock();
    expect(() => b.emitDynMemberGet(recv, key)).toThrow(/recv operand .* is not dynamic/);
  });

  it("rejects a non-dynamic key at construction (carrier-only)", () => {
    const b = new IrFunctionBuilder(identities.next("readBadKey"), [DYN], true);
    const recv = b.addParam("recv", DYN);
    const key = b.addParam("key", F64);
    b.openBlock();
    expect(() => b.emitDynMemberGet(recv, key)).toThrow(/key operand .* is not dynamic/);
  });

  it("a hand-crafted dyn.member_get with a concrete operand fails the verifier (defense in depth)", () => {
    const b = new IrFunctionBuilder(identities.next("readVerify"), [DYN], true);
    const recv = b.addParam("recv", DYN);
    const concrete = b.addParam("c", F64);
    b.openBlock();
    b.terminate({ kind: "return", values: [recv] });
    const fn = b.finish();
    const bad: IrFunction = {
      ...fn,
      blocks: [
        {
          ...fn.blocks[0],
          // key is a concrete f64 — the verifier must catch it even though the
          // builder guard was bypassed.
          instrs: [{ kind: "dyn.member_get", recv, key: concrete, result: 999, resultType: DYN } as never],
        },
      ],
    };
    const errs = verifyIrFunction(bad);
    expect(errs.some((e) => /dyn\.member_get key must be a dynamic/.test(e.message))).toBe(true);
  });

  it("a hand-crafted dyn.member_get with a non-dynamic RESULT fails the verifier", () => {
    const b = new IrFunctionBuilder(identities.next("readVerifyRes"), [DYN], true);
    const recv = b.addParam("recv", DYN);
    const key = b.addParam("key", DYN);
    b.openBlock();
    b.terminate({ kind: "return", values: [recv] });
    const fn = b.finish();
    const bad: IrFunction = {
      ...fn,
      blocks: [
        {
          ...fn.blocks[0],
          instrs: [{ kind: "dyn.member_get", recv, key, result: 999, resultType: F64 } as never],
        },
      ],
    };
    const errs = verifyIrFunction(bad);
    expect(errs.some((e) => /dyn\.member_get result must be a dynamic/.test(e.message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Handle → helper routing: emitMemberGet / emitElementGet resolve the SAME
// `__dyn_member_get` by name and flip the latch (both aligned strategies).
// ---------------------------------------------------------------------------

describe("#3053 U1 — IrDynamicLowering.emitMemberGet/emitElementGet → [call __dyn_member_get]", () => {
  it("standalone (gc): both emit a single bare call to __dyn_member_get and flip the latch", () => {
    const ctx = makeStandaloneCtxWithHelper();
    const idx = ctx.funcMap.get("__dyn_member_get");
    expect(idx).toBeDefined();
    // U0's internal peel is present too (proves the gc body registered, not the host wrapper).
    expect(ctx.funcMap.get("__carrier_recv_to_extern")).toBeDefined();

    const dyn = makeDynamicLowering(ctx)!;
    expect(dyn.strategy).toBe("gc");

    ctx.usesDynMemberGet = false; // prove emitMemberGet re-flips it
    const memberOps = dyn.emitMemberGet();
    expect(memberOps).toEqual([{ op: "call", funcIdx: idx }]);
    expect(ctx.usesDynMemberGet).toBe(true);

    ctx.usesDynMemberGet = false;
    const elementOps = dyn.emitElementGet();
    expect(elementOps).toEqual([{ op: "call", funcIdx: idx }]);
    expect(ctx.usesDynMemberGet).toBe(true);
  });

  it("host: both emit a single bare call to the __dyn_member_get wrapper and flip the latch", () => {
    const ctx = makeHostCtxWithHelper();
    const idx = ctx.funcMap.get("__dyn_member_get");
    expect(idx).toBeDefined();
    // Host mode is the thin externref wrapper — no gc peel helper.
    expect(ctx.funcMap.get("__carrier_recv_to_extern")).toBeUndefined();

    const dyn = makeDynamicLowering(ctx)!;
    expect(dyn.strategy).toBe("host");

    ctx.usesDynMemberGet = false;
    expect(dyn.emitMemberGet()).toEqual([{ op: "call", funcIdx: idx }]);
    expect(ctx.usesDynMemberGet).toBe(true);

    ctx.usesDynMemberGet = false;
    expect(dyn.emitElementGet()).toEqual([{ op: "call", funcIdx: idx }]);
    expect(ctx.usesDynMemberGet).toBe(true);
  });

  it("emitMemberGet throws a clear error when the helper was not pre-registered", () => {
    // Contract: the handle resolves by NAME and REQUIRES preregisterDynamicSupport
    // to have registered the helper. A ctx without it must fail loudly, not
    // silently emit a dangling call.
    const ctx = createCodegenContext(createEmptyModule(), {} as unknown as ts.TypeChecker, { standalone: true });
    ensureAnyHelpers(ctx);
    const dyn = makeDynamicLowering(ctx)!;
    expect(() => dyn.emitMemberGet()).toThrow(/__dyn_member_get not registered/);
  });
});

// ---------------------------------------------------------------------------
// lower.ts arm: recv, then key, then the handle's call ops — the S5.4 read
// order. Driven by a stub handle so the arm is proven independently of the
// real helper registration.
// ---------------------------------------------------------------------------

function fnWithMemberGet(recvFirst: boolean): IrFunction {
  // f(recv: dyn, key: dyn) -> dyn { return recv[key]; }
  const recv = asValueId(0);
  const key = asValueId(1);
  const result = asValueId(2);
  void recvFirst;
  return {
    ...identities.next("memberRead"),
    params: [
      { value: recv, type: DYN, name: "recv" },
      { value: key, type: DYN, name: "key" },
    ],
    resultTypes: [DYN],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [{ kind: "dyn.member_get", recv, key, result, resultType: DYN }],
        terminator: { kind: "return", values: [result] },
      },
    ],
    exported: true,
    valueCount: 3,
  };
}

/** A resolver whose dynamic handle emits a recognizable sentinel call. */
function stubResolver(ctx: CodegenContext, sentinel: number): IrLowerResolver {
  const real = makeDynamicLowering(ctx)!;
  return {
    resolveFunc: (ref) => {
      const idx = ctx.funcMap.get(ref.name);
      if (idx === undefined) throw new Error(`stub resolver: unknown func ${ref.name}`);
      return idx;
    },
    resolveGlobal: () => {
      throw new Error("stub resolver: no globals");
    },
    resolveType: () => {
      throw new Error("stub resolver: no type refs");
    },
    internFuncType: (t: FuncTypeDef) => addFuncType(ctx, t.params, t.results, t.name),
    resolveDynamic: () => real.carrier,
    resolveDynamicLowering: () => ({
      ...real,
      emitMemberGet: () => [{ op: "call", funcIdx: sentinel } as Instr],
      emitElementGet: () => [{ op: "call", funcIdx: sentinel } as Instr],
    }),
  };
}

describe("#3053 U1 — lower.ts drives the handle: [recv][key][call] in order", () => {
  it("lowers dyn.member_get to recv, key, then the handle's member-get ops", () => {
    const ctx = makeStandaloneCtxWithHelper();
    const SENTINEL = 0xbeef;
    const { func } = lowerIrFunctionToWasm(fnWithMemberGet(true), stubResolver(ctx, SENTINEL));
    // The two params are locals 0 (recv) and 1 (key). The read pushes recv,
    // then key, then the sentinel call — the __dyn_member_get(recv, key) order.
    const callIdx = func.body.findIndex((op) => op.op === "call" && (op as { funcIdx: number }).funcIdx === SENTINEL);
    expect(callIdx).toBeGreaterThanOrEqual(2);
    const getsBeforeCall = func.body
      .slice(0, callIdx)
      .filter((op) => op.op === "local.get")
      .map((op) => (op as { index: number }).index);
    // recv (local 0) is pushed before key (local 1), immediately before the call.
    expect(getsBeforeCall.slice(-2)).toEqual([0, 1]);
  });

  it("lower throws if a dyn.member_get operand is not dynamic (producer-bug backstop)", () => {
    const ctx = makeStandaloneCtxWithHelper();
    const recv = asValueId(0);
    const badKey = asValueId(1);
    const result = asValueId(2);
    const fn: IrFunction = {
      ...identities.next("badRead"),
      params: [
        { value: recv, type: DYN, name: "recv" },
        { value: badKey, type: F64, name: "key" }, // concrete key
      ],
      resultTypes: [DYN],
      blocks: [
        {
          id: asBlockId(0),
          blockArgs: [],
          blockArgTypes: [],
          instrs: [{ kind: "dyn.member_get", recv, key: badKey, result, resultType: DYN }],
          terminator: { kind: "return", values: [result] },
        },
      ],
      exported: true,
      valueCount: 3,
    };
    expect(() => lowerIrFunctionToWasm(fn, stubResolver(ctx, 1))).toThrow(/dyn\.member_get operands must be dynamic/);
  });
});
