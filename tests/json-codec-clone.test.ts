import { describe, expect, it } from "vitest";

import { deepCloneInstrs } from "../src/codegen/json-codec-native.ts";

describe("JSON codec instruction cloning", () => {
  it("preserves BigInt operands while expanding shared instruction nodes", () => {
    const shared = { op: "i64.const", value: 42n } as const;
    const body = [
      shared,
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [shared],
      },
    ];

    const clone = deepCloneInstrs(body);
    const clonedConst = clone[0] as { op: string; value: bigint };
    const nestedConst = (clone[1] as { body: Array<{ op: string; value: bigint }> }).body[0];

    expect(clonedConst.value).toBe(42n);
    expect(nestedConst.value).toBe(42n);
    expect(clonedConst).not.toBe(shared);
    expect(nestedConst).not.toBe(shared);
    expect(nestedConst).not.toBe(clonedConst);
  });
});
