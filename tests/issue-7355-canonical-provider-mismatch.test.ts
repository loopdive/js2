// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7355 — the families that share `canonicalProviderMismatch` compare provider rows as data (`sameData`), not by
// `JSON.stringify`: a `toJSON` forgery or an extra `undefined` field is a mismatch, and key order is not.
import { describe, expect, it } from "vitest";
import type { RuntimeProviderDefinition } from "../src/ir/runtime/contracts/manifest.js";
import {
  DYNAMIC_VALUE_RUNTIME_PROVIDERS,
  dynamicValueProviderMismatch,
} from "../src/ir/runtime/dynamic-value-callables.js";
import {
  NUMBER_REMAINDER_RUNTIME_PROVIDERS,
  numberRemainderProviderMismatch,
} from "../src/ir/runtime/number-remainder-callables.js";
import {
  ORDINARY_OBJECT_RUNTIME_PROVIDERS,
  ordinaryObjectProviderMismatch,
} from "../src/ir/runtime/ordinary-object-callables.js";

const FAMILIES = [
  ["ordinary object", ORDINARY_OBJECT_RUNTIME_PROVIDERS, ordinaryObjectProviderMismatch],
  ["dynamic value", DYNAMIC_VALUE_RUNTIME_PROVIDERS, dynamicValueProviderMismatch],
  ["number remainder", NUMBER_REMAINDER_RUNTIME_PROVIDERS, numberRemainderProviderMismatch],
] as const;

const reversed = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;

describe.each(FAMILIES)("#7355 — %s providers compare as data", (_, rows, mismatch) => {
  const row: RuntimeProviderDefinition = rows[0]!;

  it("accepts the canonical row and the same row with its keys reordered", () => {
    expect(mismatch(row)).toBeUndefined();
    expect(mismatch({ ...row, implementation: reversed(row.implementation) })).toBeUndefined();
  });

  it("rejects a toJSON forgery of the signature and of the implementation", () => {
    const forged = { kind: "runtime-callable", symbol: "__forged" };
    expect(mismatch({ ...row, signature: { toJSON: () => row.signature } } as never)).toMatch(/signature mismatch/);
    expect(
      mismatch({ ...row, implementation: Object.assign(forged, { toJSON: () => row.implementation }) } as never),
    ).toMatch(/implementation mismatch/);
  });

  it("rejects an extra field, even one holding undefined", () => {
    expect(mismatch({ ...row, implementation: { ...row.implementation, extra: undefined } } as never)).toMatch(
      /implementation mismatch/,
    );
  });
});
