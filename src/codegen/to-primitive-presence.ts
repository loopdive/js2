// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

// These are the existing private prototype-store ABI names, not external providers.
const PROTOIDX_COMPANION = "__protoidx_companion";
const PROTOIDX_NORM_KEY = "__protoidx_norm_key";
const PROTOIDX_HAS_K = "__protoidx_has_k";
const PROTOIDX_BRAND_OFF = "__protoidx_brand_off";
const PROTOIDX_HAS_R = "__protoidx_has_r";
/** The ToPrimitive call site binds this stable reservation, never early absence. */
const TO_PRIMITIVE_PRESENCE = "__to_primitive_companion_presence";
const PRESENCE_FILL_NAMES = [
  PROTOIDX_COMPANION,
  PROTOIDX_NORM_KEY,
  PROTOIDX_HAS_K,
  PROTOIDX_BRAND_OFF,
  PROTOIDX_HAS_R,
] as const;
interface PresenceFunctionReceipt {
  readonly fn: WasmFunction;
  readonly type: CodegenContext["mod"]["types"][number];
  readonly body: Instr[];
  readonly locals: WasmFunction["locals"];
  readonly graph: readonly PresenceGraphNode[];
}
interface ToPrimitivePresenceCapture {
  readonly reservation: PresenceFunctionReceipt;
  completion?: {
    readonly kind: "absent" | "call";
    readonly bridge: PresenceFunctionReceipt;
    readonly dependencies: readonly PresenceFunctionReceipt[];
  };
}
function protoIndexPresenceDemanded(ctx: CodegenContext): boolean {
  return (
    ctx.standalone && !!(ctx.protoIndexDirty || ctx.protoNamedDirty || ctx.protoMemberDirty || ctx.moduleUsesDynTaView)
  );
}

interface PresenceGraphNode {
  readonly object: object;
  readonly prototype: object | null;
  readonly keys: readonly PropertyKey[];
  readonly descriptors: PropertyDescriptorMap;
  readonly numbers: ReadonlyMap<PropertyKey, bigint>;
}

function presenceNumberBits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
}

/** Retain the real plain-data graph, including alias identity and scalar bits. */
function presenceGraph(...roots: object[]): readonly PresenceGraphNode[] {
  const rows: PresenceGraphNode[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (typeof value === "function") throw new Error("ToPrimitive presence data contains executable content");
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype && prototype !== Array.prototype)
      throw new Error("ToPrimitive presence data is not a plain descriptor");
    seen.add(value);
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const numbers = new Map<PropertyKey, bigint>();
    rows.push({ object: value, prototype, keys, descriptors, numbers });
    for (const key of keys) {
      const descriptor = Reflect.get(descriptors, key) as PropertyDescriptor;
      if (!Object.hasOwn(descriptor, "value")) throw new Error("ToPrimitive presence data contains an accessor");
      if (typeof descriptor.value === "number") numbers.set(key, presenceNumberBits(descriptor.value));
      visit(descriptor.value);
    }
  };
  for (const root of roots) visit(root);
  return rows;
}

function assertPresenceGraphCurrent(rows: readonly PresenceGraphNode[]): void {
  for (const row of rows) {
    const keys = Reflect.ownKeys(row.object);
    if (
      Object.getPrototypeOf(row.object) !== row.prototype ||
      keys.length !== row.keys.length ||
      keys.some((key, index) => key !== row.keys[index])
    )
      throw new Error("ToPrimitive companion presence target or content changed");
    for (const key of keys) {
      const expected = Reflect.get(row.descriptors, key) as PropertyDescriptor;
      const actual = Object.getOwnPropertyDescriptor(row.object, key)!;
      if (
        !Object.hasOwn(actual, "value") ||
        !Object.is(actual.value, expected.value) ||
        actual.writable !== expected.writable ||
        actual.enumerable !== expected.enumerable ||
        actual.configurable !== expected.configurable ||
        (typeof actual.value === "number" && presenceNumberBits(actual.value) !== row.numbers.get(key))
      )
        throw new Error("ToPrimitive companion presence target or content changed");
    }
  }
}

function presenceFunctionReceipt(ctx: CodegenContext, fn: WasmFunction): PresenceFunctionReceipt {
  const type = ctx.mod.types[fn.typeIdx];
  if (!type) throw new Error("ToPrimitive companion presence signature is missing");
  return { fn, type, body: fn.body, locals: fn.locals, graph: presenceGraph(fn, type) };
}

function assertPresenceFunctionCurrent(ctx: CodegenContext, receipt: PresenceFunctionReceipt): void {
  const fn = receipt.fn;
  const index = ctx.funcMap.get(fn.name);
  if (
    index === undefined ||
    definedFuncAt(ctx, index) !== fn ||
    ctx.mod.types[fn.typeIdx] !== receipt.type ||
    fn.body !== receipt.body ||
    fn.locals !== receipt.locals
  )
    throw new Error("ToPrimitive companion presence target or content changed");
  assertPresenceGraphCurrent(receipt.graph);
}

function findFn(ctx: CodegenContext, name: string): WasmFunction | undefined {
  const idx = ctx.funcMap.get(name);
  return idx === undefined ? undefined : definedFuncAt(ctx, idx);
}

/** Each factory owns its receipts; no instance can complete another's reservation. */
class ToPrimitivePresenceOwner {
  readonly #captures = new WeakMap<CodegenContext, ToPrimitivePresenceCapture>();
  readonly #reservations = new WeakMap<CodegenContext, ReadonlyMap<string, PresenceFunctionReceipt>>();
  readonly #batches = new WeakMap<object, { ctx: CodegenContext; receipts: Map<string, PresenceFunctionReceipt> }>();
  readonly #fillInputs = new WeakMap<object, { ctx: CodegenContext; receipts: readonly PresenceFunctionReceipt[] }>();

  createReservations(ctx: CodegenContext): object {
    const token = Object.freeze({});
    this.#batches.set(token, { ctx, receipts: new Map<string, PresenceFunctionReceipt>() });
    return token;
  }

  #reservationBatch(ctx: CodegenContext, token: object): Map<string, PresenceFunctionReceipt> {
    const batch = this.#batches.get(token);
    if (!batch || batch.ctx !== ctx) throw new Error("ToPrimitive presence reservation batch is not owned");
    return batch.receipts;
  }

  recordReservation(ctx: CodegenContext, token: object, name: string, fn: WasmFunction): void {
    this.#reservationBatch(ctx, token).set(name, presenceFunctionReceipt(ctx, fn));
  }

  installReservations(ctx: CodegenContext, token: object): void {
    this.#reservations.set(ctx, this.#reservationBatch(ctx, token));
  }

  needsReservation(ctx: CodegenContext): boolean {
    return this.#captures.has(ctx) && protoIndexPresenceDemanded(ctx);
  }

  /** The registered body stays unreachable until the existing finalizer completes it. */
  capture(ctx: CodegenContext): {
    readonly kind: "call";
    readonly hasIdx: number;
  } {
    const previous = this.#captures.get(ctx);
    if (previous) {
      this.assertCurrent(ctx);
      return { kind: "call", hasIdx: ctx.funcMap.get(TO_PRIMITIVE_PRESENCE)! };
    }
    if (ctx.funcMap.has(TO_PRIMITIVE_PRESENCE))
      throw new Error("ToPrimitive companion presence reservation already exists without its owner");
    const ext: ValType = { kind: "externref" };
    const typeIdx = addFuncType(ctx, [ext, ext], [{ kind: "i32" }], "$to_primitive_companion_presence_type");
    const hasIdx = mintDefinedFunc(ctx);
    const fn: WasmFunction = {
      name: TO_PRIMITIVE_PRESENCE,
      typeIdx,
      locals: [],
      body: [{ op: "unreachable" }],
      exported: false,
    };
    pushDefinedFunc(ctx, hasIdx, fn);
    ctx.funcMap.set(TO_PRIMITIVE_PRESENCE, hasIdx);
    this.#captures.set(ctx, { reservation: presenceFunctionReceipt(ctx, fn) });
    return { kind: "call", hasIdx };
  }

  assertCurrent(ctx: CodegenContext): void {
    const captured = this.#captures.get(ctx);
    if (!captured) return;
    const completed = captured.completion;
    assertPresenceFunctionCurrent(ctx, completed?.bridge ?? captured.reservation);
    if (!completed) return;
    if (completed.kind === "absent") {
      if (ctx.protoIndexStoreReserved || protoIndexPresenceDemanded(ctx) || ctx.funcMap.has(PROTOIDX_HAS_R))
        throw new Error("ToPrimitive companion absence became stale after completed finalization");
    } else {
      if (!ctx.protoIndexStoreReserved || !ctx.protoIndexStoreFilled)
        throw new Error("ToPrimitive companion presence completed store state changed");
      for (const receipt of completed.dependencies) assertPresenceFunctionCurrent(ctx, receipt);
    }
  }

  /** Capture the actual selected descriptors before their canonical fill steps. */
  captureFillInputs(ctx: CodegenContext): object | undefined {
    if (!this.#captures.has(ctx)) return undefined;
    const reservations = this.#reservations.get(ctx);
    const receipts = PRESENCE_FILL_NAMES.map((name) => {
      const receipt = reservations?.get(name);
      if (!receipt) throw new Error("ToPrimitive companion presence dependency has no reservation receipt");
      assertPresenceFunctionCurrent(ctx, receipt);
      return receipt;
    });
    const token = Object.freeze({});
    this.#fillInputs.set(token, { ctx, receipts: Object.freeze(receipts) });
    return token;
  }

  #filledInputs(ctx: CodegenContext, token: object): readonly PresenceFunctionReceipt[] {
    const input = this.#fillInputs.get(token);
    if (
      !input ||
      input.ctx !== ctx ||
      input.receipts.length !== PRESENCE_FILL_NAMES.length ||
      input.receipts.some((receipt, index) => receipt.fn.name !== PRESENCE_FILL_NAMES[index])
    )
      throw new Error("ToPrimitive presence fill input is not owned");
    return input.receipts;
  }

  /** No flag or matching signature can substitute for the executed fill chain. */
  complete(ctx: CodegenContext, token?: object): void {
    const filled = token === undefined ? undefined : this.#filledInputs(ctx, token);
    const captured = this.#captures.get(ctx);
    if (!captured) return;
    this.assertCurrent(ctx);
    if (captured.completion) return;
    if (!filled && (ctx.protoIndexStoreReserved || protoIndexPresenceDemanded(ctx) || ctx.funcMap.has(PROTOIDX_HAS_R)))
      throw new Error("ToPrimitive companion presence dependency was not filled");
    const dependencies = (filled ?? []).map((prior) => {
      const current = findFn(ctx, prior.fn.name);
      if (current !== prior.fn || current.body === prior.body)
        throw new Error("ToPrimitive companion presence dependency was not filled");
      return presenceFunctionReceipt(ctx, current);
    });
    const fn = captured.reservation.fn;
    fn.body = filled
      ? [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: ctx.funcMap.get(PROTOIDX_HAS_R)! },
        ]
      : [{ op: "i32.const", value: 0 }];
    captured.completion = {
      kind: filled ? "call" : "absent",
      bridge: presenceFunctionReceipt(ctx, fn),
      dependencies,
    };
    this.assertCurrent(ctx);
  }
}

/** The production instance stays private inside proto-index-store.ts. */
export function createToPrimitivePresenceOwner() {
  return new ToPrimitivePresenceOwner();
}
