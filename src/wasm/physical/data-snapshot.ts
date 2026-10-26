// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
export type PhysicalDataSnapshot =
  | string
  | bigint
  | boolean
  | undefined
  | null
  | { readonly kind: "number"; readonly high: number; readonly low: number }
  | {
      readonly kind: "object";
      readonly tag: string;
      readonly fields: readonly (readonly [string, PhysicalDataSnapshot])[];
    };

/** Immutable expected data only. Never retain live objects or a successful-validation cache. */
export function capturePhysicalDataSnapshot(data: unknown): PhysicalDataSnapshot {
  const active = new Set<object>(),
    numberBits = new DataView(new ArrayBuffer(8));
  const capture = (value: unknown): PhysicalDataSnapshot => {
    if (value === null || value === undefined) return value;
    switch (typeof value) {
      case "string":
      case "boolean":
      case "bigint":
        return value;
      case "number":
        numberBits.setFloat64(0, value, true);
        return Object.freeze({
          kind: "number",
          high: numberBits.getUint32(4, true),
          low: numberBits.getUint32(0, true),
        });
      case "object": {
        if (active.has(value)) throw new Error("cyclic physical descriptor");
        active.add(value);
        const tag = Array.isArray(value) ? `array:${value.length}` : value instanceof Uint8Array ? "bytes" : "object";
        // Object.entries captures ALL sibling values before descending into any child, as dataText does.
        const fields = Object.entries(value).map(([key, entry]) => Object.freeze([key, capture(entry)] as const));
        active.delete(value);
        return Object.freeze({ kind: "object", tag, fields: Object.freeze(fields) });
      }
      default:
        throw new Error("unsupported physical descriptor value");
    }
  };
  return capture(data);
}

/** Walk every live child, even after mismatch: later getters/errors/cycles retain their original precedence. */
export function matchesPhysicalDataSnapshot(data: unknown, expected: PhysicalDataSnapshot): boolean {
  const active = new Set<object>(),
    numberBits = new DataView(new ArrayBuffer(8));
  const matches = (value: unknown, snapshot: PhysicalDataSnapshot): boolean => {
    if (value === null || value === undefined) return value === snapshot;
    switch (typeof value) {
      case "string":
      case "boolean":
      case "bigint":
        return value === snapshot;
      case "number": {
        numberBits.setFloat64(0, value, true);
        const high = numberBits.getUint32(4, true),
          low = numberBits.getUint32(0, true);
        return (
          typeof snapshot === "object" &&
          snapshot !== null &&
          snapshot.kind === "number" &&
          snapshot.high === high &&
          snapshot.low === low
        );
      }
      case "object": {
        if (active.has(value)) throw new Error("cyclic physical descriptor");
        active.add(value);
        const tag = Array.isArray(value) ? `array:${value.length}` : value instanceof Uint8Array ? "bytes" : "object";
        const fields = Object.entries(value),
          prior =
            typeof snapshot === "object" && snapshot !== null && snapshot.kind === "object" ? snapshot : undefined;
        let equal = prior !== undefined && prior.tag === tag && prior.fields.length === fields.length;
        for (let index = 0; index < fields.length; index++) {
          const [key, entry] = fields[index]!;
          const field = prior?.fields[index];
          if (field?.[0] !== key) equal = false;
          if (!matches(entry, field?.[1])) equal = false;
        }
        active.delete(value);
        return equal;
      }
      default:
        throw new Error("unsupported physical descriptor value");
    }
  };
  return matches(data, expected);
}
