// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export const DATE_HOST_METHOD_UNHANDLED = Symbol("date-host-method-unhandled");

/** The compiler's in-band sentinel for a Date whose time value is NaN. */
const INVALID_TIMESTAMP = -0x8000000000000000n;

/**
 * (#5208) Read the time value of the compiler-owned WasmGC Date carrier.
 *
 * Classification is the module's own `ref.test $__Date` (published as
 * `__\0js2_is_date` by `emitDateHostBridge`), never a duck-type on a
 * `timestamp` FIELD: WasmGC canonicalises structurally identical types, so a
 * field-shape test cannot separate a Date from any other one-i64 carrier, and
 * a NAME test cannot see through the erasure to externref (#5354).
 *
 * Returns `undefined` — not NaN — when `value` is not the carrier, so a genuine
 * Invalid Date stays distinguishable from "this was never a Date".
 */
export function wasmDateCarrierValue(
  value: unknown,
  exports: Record<string, Function> | undefined,
  isWasmStruct: (value: unknown) => boolean,
): number | undefined {
  if (!exports || value == null || typeof value !== "object" || !isWasmStruct(value)) return undefined;
  const isDate = exports["__\0js2_is_date"] as ((value: unknown) => number) | undefined;
  const dateValue = exports["__\0js2_date_value"] as ((value: unknown) => bigint) | undefined;
  if (typeof isDate !== "function" || typeof dateValue !== "function") return undefined;
  try {
    if (isDate(value) !== 1) return undefined;
    const raw = dateValue(value);
    return raw === INVALID_TIMESTAMP ? NaN : Number(raw);
  } catch {
    // A cross-module struct the reader cannot decode: not our carrier here.
    return undefined;
  }
}

/**
 * (#5208) The host VIEW of a Date carrier. See `wasmDateHostView`.
 *
 * Lives here rather than in `runtime.ts` because this module already owns the
 * carrier protocol, and the host-import-policy ratchet exists to keep exactly
 * this kind of logic OUT of `runtime.ts`.
 */
const _dateHostViews = new WeakMap<object, Date>();

/**
 * (#5208) Present the compiler-owned WasmGC Date carrier to the host as a real
 * `Date`, or `undefined` when `value` is not that carrier.
 *
 * WHY a boundary marshal rather than a compiled-side change: the compiled
 * representation of a `Date` is `$__Date`, one MUTABLE i64 timestamp, and the
 * standalone lane (#1343 date-native) owns it — there is no host `Date` to be
 * had in a pure-Wasm binary. What was wrong was only the HOST VIEW: the generic
 * struct marshaller presented the carrier as a data proxy, which ToNumber's to
 * NaN, so every host operation needing the time value failed —
 * `Intl.DateTimeFormat.prototype.formatToParts(new Date(e))`, the shape the
 * `@js-temporal/polyfill`'s `getCalendarParts` uses, threw
 * `RangeError: Invalid time value`.
 *
 * IDENTITY-CACHED **and** RE-SYNCED, which is neither of the two obvious
 * choices:
 *   - Minting a fresh `Date` per crossing would be an identity regression —
 *     the generic marshaller caches its host view per struct, so a host-side
 *     reference comparison that answers "same object" today would start
 *     answering "different".
 *   - Snapshotting once (the shape `_nativeErrorToHost` uses, where name and
 *     message are immutable) would go STALE: the carrier's field is mutable, so
 *     a compiled `d.setUTCFullYear(...)` between two crossings must be visible
 *     to the second one.
 * So the cached host Date is re-pointed at the carrier's current timestamp on
 * every crossing. A `Date` is a value; nothing else about it is cached.
 *
 * `onCreate` lets the caller register the reverse mapping it owns, so handing
 * the host view back into compiled code recovers the ORIGINAL carrier instead
 * of forking its identity.
 */
export function wasmDateHostView(
  value: unknown,
  exports: Record<string, Function> | undefined,
  isWasmStruct: (value: unknown) => boolean,
  onCreate?: (hostDate: Date, carrier: object) => void,
): Date | undefined {
  const ms = wasmDateCarrierValue(value, exports, isWasmStruct);
  if (ms === undefined) return undefined;
  const carrier = value as object;
  const cached = _dateHostViews.get(carrier);
  if (cached !== undefined) {
    cached.setTime(ms);
    return cached;
  }
  const hostDate = new Date(ms);
  _dateHostViews.set(carrier, hostDate);
  onCreate?.(hostDate, carrier);
  return hostDate;
}

/** Invoke a native Date method for the compiler-owned WasmGC Date carrier. */
export function tryCallWasmDateHostMethod(
  obj: unknown,
  method: string,
  args: unknown[],
  exports: Record<string, Function> | undefined,
  isWasmStruct: (value: unknown) => boolean,
): unknown {
  if (!exports || !isWasmStruct(obj)) return DATE_HOST_METHOD_UNHANDLED;
  const ms = wasmDateCarrierValue(obj, exports, isWasmStruct);
  if (ms === undefined) return DATE_HOST_METHOD_UNHANDLED;

  const invalidTimestamp = INVALID_TIMESTAMP;
  const hostDate = new Date(ms);
  const dateMethod = (hostDate as unknown as Record<string, any>)[method];
  if (typeof dateMethod !== "function") return DATE_HOST_METHOD_UNHANDLED;
  const result = dateMethod.apply(hostDate, args);
  if (method.startsWith("set")) {
    const setDateValue = exports["__\0js2_date_set_value"] as ((value: unknown, timestamp: bigint) => void) | undefined;
    if (typeof setDateValue === "function") {
      const timestamp = hostDate.getTime();
      setDateValue(obj, Number.isNaN(timestamp) ? invalidTimestamp : BigInt(Math.trunc(timestamp)));
    }
  }
  return result;
}
