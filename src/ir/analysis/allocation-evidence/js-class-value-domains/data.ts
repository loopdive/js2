// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createPreparedIrDataRecord } from "../../../../shared/contracts/prepared-ir-data.js";
function key(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `bigint:${value}`;
  if (typeof value === "number" && !Number.isFinite(value)) return `number:${value}`;
  if (Array.isArray(value)) return `[${value.map(key).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${key((value as Record<string, unknown>)[name])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}
function ownData<T>(input: T): T {
  const ancestors = new Set<object>();
  const visit = (value: unknown): unknown => {
    if (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint"
    )
      return value;
    if (typeof value !== "object") throw new TypeError("native class value domains require own DATA");
    if (ancestors.has(value)) throw new TypeError("native class value domains reject cyclic DATA");
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null)
      throw new TypeError("native class value domains require plain DATA");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((name) => typeof name !== "string" || !("value" in descriptors[name])))
      throw new TypeError("native class value domains reject accessors");
    ancestors.add(value);
    const result: Record<string, unknown> | unknown[] = array ? [] : createPreparedIrDataRecord();
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || Object.keys(descriptors).length !== length + 1)
        throw new TypeError("native class value domains reject sparse arrays");
      for (let i = 0; i < length; i++) {
        const field = descriptors[String(i)];
        if (!field) throw new TypeError("native class value domains reject sparse arrays");
        (result as unknown[]).push(visit(field.value));
      }
    } else
      for (const [name, descriptor] of Object.entries(descriptors))
        (result as Record<string, unknown>)[name] = visit(descriptor.value);
    ancestors.delete(value);
    return result;
  };
  return visit(input) as T;
}
export {
  key as nativeJsClassValueDataKey,
  frozen as freezeNativeJsClassValueData,
  ownData as copyNativeJsClassValueData,
};
