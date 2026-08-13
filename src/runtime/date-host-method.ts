// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export const DATE_HOST_METHOD_UNHANDLED = Symbol("date-host-method-unhandled");

/** Invoke a native Date method for the compiler-owned WasmGC Date carrier. */
export function tryCallWasmDateHostMethod(
  obj: unknown,
  method: string,
  args: unknown[],
  exports: Record<string, Function> | undefined,
  isWasmStruct: (value: unknown) => boolean,
): unknown {
  if (!exports || !isWasmStruct(obj)) return DATE_HOST_METHOD_UNHANDLED;
  const isDate = exports["__\0js2_is_date"] as ((value: unknown) => number) | undefined;
  const dateValue = exports["__\0js2_date_value"] as ((value: unknown) => bigint) | undefined;
  if (typeof isDate !== "function" || typeof dateValue !== "function" || isDate(obj) !== 1) {
    return DATE_HOST_METHOD_UNHANDLED;
  }

  const invalidTimestamp = -0x8000000000000000n;
  const raw = dateValue(obj);
  const hostDate = new Date(raw === invalidTimestamp ? NaN : Number(raw));
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
