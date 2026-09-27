// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Instr } from "../src/ir/types.js";
import type { CodegenContext, FunctionContext } from "../src/codegen/context/types.js";
const hooks = vi.hoisted(() => ({
  trace: [] as string[],
  ensure: vi.fn(),
  reserve: vi.fn(),
  allocate: vi.fn(),
  seed: vi.fn(),
}));
vi.mock("../src/codegen/object-runtime.js", () => ({ ensureObjectRuntime: hooks.ensure }));
vi.mock("../src/codegen/builtin-static-globals.js", () => ({
  reserveBuiltinConstructorIdentityGlobal: hooks.reserve,
}));
vi.mock("../src/codegen/context/locals.js", () => ({ allocLocal: hooks.allocate }));
vi.mock("../src/codegen/builtin-ctor-own-props.js", () => ({
  pushBuiltinCtorOwnPropSeed: hooks.seed,
}));
import { emitPreparedBuiltinConstructorIdentityRead } from "../src/codegen/builtin-constructor-prepared.js";

function fixture() {
  const body: Instr[] = [];
  const ctx = {
    funcMap: new Map([["__new_plain_object", 7]]),
    liveBodies: new Set<Instr[]>(),
  } as unknown as CodegenContext;
  const frame = { body, locals: [] } as unknown as FunctionContext;
  return { ctx, frame, body };
}
beforeEach(() => {
  vi.resetAllMocks();
  hooks.trace.length = 0;
  hooks.ensure.mockImplementation(() => {
    hooks.trace.push("runtime");
  });
  hooks.reserve.mockImplementation(() => {
    hooks.trace.push("reserve");
    return 3;
  });
  hooks.allocate.mockImplementation((frame: FunctionContext) => {
    hooks.trace.push("local");
    frame.locals.push({ name: "test-constructor-local", type: { kind: "externref" } });
    return frame.locals.length - 1;
  });
  hooks.seed.mockImplementation(() => {
    hooks.trace.push("seed");
  });
});

describe("immediate materialized constructor transfer", () => {
  it("constructs once in legacy order and retains the actual seeded subtree", () => {
    const { ctx, frame, body } = fixture();
    let seeded: Instr[] | undefined;
    const marker: Instr = { op: "nop" };
    hooks.seed.mockImplementation((_ctx, current: FunctionContext) => {
      hooks.trace.push("seed");
      seeded = current.body;
      expect(ctx.liveBodies.has(body)).toBe(true);
      expect(ctx.liveBodies.has(seeded)).toBe(true);
      expect(seeded.map((i) => i.op)).toEqual(["call", "local.set", "local.get", "global.set"]);
      expect(seeded).toEqual([
        { op: "call", funcIdx: 7 },
        { op: "local.set", index: 0 },
        { op: "local.get", index: 0 },
        { op: "global.set", index: 3 },
      ]);
      current.body.push(marker);
    });
    expect(emitPreparedBuiltinConstructorIdentityRead(ctx, frame, "Promise")).toEqual({ kind: "externref" });
    expect(hooks.trace).toEqual(["runtime", "reserve", "local", "seed"]);
    expect(hooks.ensure).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(hooks.reserve).toHaveBeenCalledExactlyOnceWith(ctx, "Promise");
    expect(hooks.allocate).toHaveBeenCalledExactlyOnceWith(frame, "__builtin_ctor_Promise_obj_0", {
      kind: "externref",
    });
    expect(hooks.seed).toHaveBeenCalledExactlyOnceWith(ctx, frame, "Promise", 0);
    expect(body.map((i) => i.op)).toEqual(["global.get", "ref.is_null", "if", "global.get"]);
    const guard = body[2];
    expect(guard?.op).toBe("if");
    if (guard?.op !== "if") throw new Error("Missing lazy guard");
    expect(guard.then).toBe(seeded);
    expect(guard.then.at(-1)).toBe(marker);
    expect(body).toEqual([
      { op: "global.get", index: 3 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: seeded, else: [] },
      { op: "global.get", index: 3 },
    ]);
    expect(ctx.liveBodies.size).toBe(0);
    expect(frame.body).toBe(body);
  });

  it("does no registration or local allocation after seed completion", () => {
    const { ctx, frame } = fixture();
    const forbidden = () => {
      throw new Error("registration after preparation");
    };
    hooks.seed.mockImplementation(() => {
      hooks.ensure.mockImplementation(forbidden);
      hooks.reserve.mockImplementation(forbidden);
      hooks.allocate.mockImplementation(forbidden);
      hooks.seed.mockImplementation(forbidden);
    });
    expect(() => emitPreparedBuiltinConstructorIdentityRead(ctx, frame, "Promise")).not.toThrow();
    expect(frame.body).toHaveLength(4);
    expect(hooks.seed).toHaveBeenCalledTimes(1);
  });

  it("preserves borrowed outer membership on success", () => {
    const { ctx, frame, body } = fixture();
    ctx.liveBodies.add(body);
    emitPreparedBuiltinConstructorIdentityRead(ctx, frame, "Number");
    expect([...ctx.liveBodies]).toEqual([body]);
  });

  it.each([false, true])("restores body and owned memberships on throw (borrowed=%s)", (borrowed) => {
    const { ctx, frame, body } = fixture();
    if (borrowed) ctx.liveBodies.add(body);
    const failure = new Error("seed failed");
    hooks.seed.mockImplementation(() => {
      throw failure;
    });
    expect(() => emitPreparedBuiltinConstructorIdentityRead(ctx, frame, "Symbol")).toThrow(failure);
    expect(frame.body).toBe(body);
    expect(body).toEqual([]);
    expect([...ctx.liveBodies]).toEqual(borrowed ? [body] : []);
    // This boundary does not pretend to rewind frame allocations.
    expect(frame.locals).toHaveLength(1);
  });

  it("materializes a fresh fragment and local for each immediate read", () => {
    const { ctx, frame } = fixture();
    emitPreparedBuiltinConstructorIdentityRead(ctx, frame, "Int8Array");
    emitPreparedBuiltinConstructorIdentityRead(ctx, frame, "Int8Array");
    expect(frame.body).toHaveLength(8);
    const first = frame.body[2],
      second = frame.body[6];
    if (first?.op !== "if" || second?.op !== "if") throw new Error("Missing guards");
    expect(first.then).not.toBe(second.then);
    expect(first.then).toEqual([
      { op: "call", funcIdx: 7 },
      { op: "local.set", index: 0 },
      { op: "local.get", index: 0 },
      { op: "global.set", index: 3 },
    ]);
    expect(second.then).toEqual([
      { op: "call", funcIdx: 7 },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 1 },
      { op: "global.set", index: 3 },
    ]);
    expect(hooks.allocate).toHaveBeenNthCalledWith(2, frame, "__builtin_ctor_Int8Array_obj_1", { kind: "externref" });
    expect(hooks.seed).toHaveBeenNthCalledWith(2, ctx, frame, "Int8Array", 1);
    expect(frame.locals).toHaveLength(2);
    expect(hooks.seed).toHaveBeenCalledTimes(2);
  });

  it("preserves outer roots through actual nested constructor preparation", () => {
    const { ctx, frame, body } = fixture();
    const tail: Instr = { op: "nop" };
    let outerInit: Instr[] | undefined;
    let nestedInit: Instr[] | undefined;
    let depth = 0;
    hooks.seed.mockImplementation(() => {
      if (depth === 0) {
        depth++;
        outerInit = frame.body;
        expect(ctx.liveBodies.has(body)).toBe(true);
        expect(ctx.liveBodies.has(outerInit)).toBe(true);
        emitPreparedBuiltinConstructorIdentityRead(ctx, frame, "Number");
        expect(frame.body).toBe(outerInit);
        expect(ctx.liveBodies.has(body)).toBe(true);
        expect(ctx.liveBodies.has(outerInit)).toBe(true);
        expect(ctx.liveBodies.size).toBe(2);
        expect(nestedInit).toBeDefined();
        expect(ctx.liveBodies.has(nestedInit!)).toBe(false);
        const nestedGuard = outerInit[6];
        if (nestedGuard?.op !== "if") throw new Error("Missing nested guard");
        expect(nestedGuard.then).toBe(nestedInit);
        expect(outerInit.slice(4)).toEqual([
          { op: "global.get", index: 3 },
          { op: "ref.is_null" },
          { op: "if", blockType: { kind: "empty" }, then: nestedInit, else: [] },
          { op: "global.get", index: 3 },
        ]);
        outerInit.push(tail);
        depth--;
      } else {
        expect(depth).toBe(1);
        nestedInit = frame.body;
        expect(ctx.liveBodies.size).toBe(3);
        expect(ctx.liveBodies.has(body)).toBe(true);
        expect(ctx.liveBodies.has(outerInit!)).toBe(true);
        expect(ctx.liveBodies.has(nestedInit)).toBe(true);
      }
    });
    emitPreparedBuiltinConstructorIdentityRead(ctx, frame, "Promise");
    expect(hooks.seed).toHaveBeenCalledTimes(2);
    expect(hooks.seed).toHaveBeenNthCalledWith(2, ctx, frame, "Number", 1);
    const guard = body[2];
    if (guard?.op !== "if") throw new Error("Missing outer guard");
    expect(guard.then).toBe(outerInit);
    expect(guard.then.at(-1)).toBe(tail);
    expect(frame.body).toBe(body);
    expect(ctx.liveBodies.size).toBe(0);
  });

  it("preserves nonempty destination and original error identity on seed throw", () => {
    const { ctx, frame, body } = fixture();
    const sentinel: Instr = { op: "i32.const", value: 91 };
    body.push(sentinel);
    ctx.liveBodies.add(body);
    const failure = new Error("original seed error");
    hooks.seed.mockImplementation(() => {
      throw failure;
    });
    let caught: unknown;
    try {
      emitPreparedBuiltinConstructorIdentityRead(ctx, frame, "Symbol");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(failure);
    expect(frame.body).toBe(body);
    expect(body).toEqual([sentinel]);
    expect(body[0]).toBe(sentinel);
    expect([...ctx.liveBodies]).toEqual([body]);
  });
});
