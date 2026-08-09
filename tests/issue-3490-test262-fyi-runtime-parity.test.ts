// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { TEST262_FYI_RUNTIME_CONTRACT, enforceTest262FyiRuntime } from "../scripts/test262-fyi-runtime.mjs";

const requiredApiSupport = Object.fromEntries(
  TEST262_FYI_RUNTIME_CONTRACT.capabilities.uint8ArrayBase64Hex.map((name) => [name, true]),
);

const node25Runtime = {
  runtime: "node",
  version: "v25.9.0",
  node: "25.9.0",
  v8: "14.1.146.11-node.25",
  icu: "78.2",
  unicode: "17.0",
  capabilities: {
    unicode17RegExpData: true,
    uint8ArrayBase64Hex: true,
  },
  apiSupport: requiredApiSupport,
};

const node24Runtime = {
  runtime: "node",
  version: "v24.4.1",
  node: "24.4.1",
  v8: "13.6.233.10-node.17",
  icu: "77.1",
  unicode: "16.0",
  capabilities: {
    unicode17RegExpData: false,
    uint8ArrayBase64Hex: false,
  },
  apiSupport: Object.fromEntries(
    TEST262_FYI_RUNTIME_CONTRACT.capabilities.uint8ArrayBase64Hex.map((name) => [name, false]),
  ),
};

describe("#3490 Test262 FYI runtime parity", () => {
  it("accepts the Node 25 / Unicode 17 capability shape used by baseline CI", () => {
    const metadata = enforceTest262FyiRuntime({ actual: node25Runtime });

    expect(metadata).toMatchObject({
      id: "test262-fyi-node25-unicode17-v1",
      mode: "authoritative-comparison",
      authoritative: true,
      comparable: true,
      compatible: true,
      mismatches: [],
    });
  });

  it("rejects the known Node 24 / Unicode 16 shape with remediation before a run", () => {
    expect(() => enforceTest262FyiRuntime({ actual: node24Runtime })).toThrowError(
      /Authoritative Test262 FYI comparisons require test262-fyi-node25-unicode17-v1[\s\S]*Detected Node v24\.4\.1[\s\S]*pnpm run test:262:fyi/,
    );
  });

  it("allows an opt-in smoke sample while marking it non-authoritative and non-comparable", () => {
    const metadata = enforceTest262FyiRuntime({ actual: node24Runtime, authoritative: false });

    expect(metadata).toMatchObject({
      mode: "non-authoritative-smoke",
      authoritative: false,
      comparable: false,
      compatible: false,
    });
    expect(metadata.mismatches).toHaveLength(4);
  });

  it("persists the required contract and actual runtime versions in report metadata", () => {
    const metadata = JSON.parse(JSON.stringify(enforceTest262FyiRuntime({ actual: node25Runtime })));

    expect(metadata.required).toEqual(TEST262_FYI_RUNTIME_CONTRACT);
    expect(metadata.actual).toMatchObject({
      version: "v25.9.0",
      v8: "14.1.146.11-node.25",
      icu: "78.2",
      unicode: "17.0",
      capabilities: {
        unicode17RegExpData: true,
        uint8ArrayBase64Hex: true,
      },
    });
  });
});
