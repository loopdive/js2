// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { expect, it, vi } from "vitest";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";
import { createCrossModuleStructOwners } from "../src/runtime/cross-module-struct-owners.js";

const empty = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

it("does not load the source runtime for a never-linked invocation", async () => {
  const load = vi.fn(() => {
    throw new Error("unexpected source runtime load");
  });
  vi.doMock("../src/linked-provider-runtime.js", load);
  try {
    await instantiateTest262Module(empty, {});
    expect(load).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock("../src/linked-provider-runtime.js");
  }
});

for (const target of ["gc", "standalone"]) {
  it(`retires the supplied runtime before an unlinked ${target} invocation`, async () => {
    const registry = createCrossModuleStructOwners(() => true);
    const object = {};
    const stale = { __struct_field_names: () => "day", __sget_length: () => 0 };
    const current = { __struct_field_names: () => "length", __sget_length: () => 1 };
    let resets = 0;
    const runtime = {
      resetLinkedProjectRegistry: () => {
        resets++;
        registry.reset();
      },
      instantiateLinkedProviders: () => registry.registerModule(stale),
      wireCompiledInstance: () => registry.registerModule({}),
    };
    await instantiateTest262Module(empty, {}, { linkedModules: [{}], linkedRuntime: runtime });
    expect(registry.decoderFor(object, undefined)).toBe(stale);
    expect(registry.decoderFor(object, current)).toBe(stale);
    const marker = Symbol("@@Temporal__GetSlots");
    const realm = globalThis as unknown as Record<symbol, unknown>;
    realm[marker] = "preserve on unlinked invocation";
    try {
      await instantiateTest262Module(empty, {}, { target, linkedRuntime: runtime });
      expect(resets).toBe(2);
      expect(registry.decoderFor(object, current)).toBeUndefined();
      expect(realm[marker]).toBe("preserve on unlinked invocation");
    } finally {
      delete realm[marker];
    }
  });
}

it("keeps linked reset-before-registration order and uses only the supplied runtime", async () => {
  const calls: string[] = [];
  const runtime = {
    resetLinkedProjectRegistry: () => calls.push("reset"),
    instantiateLinkedProviders: () => calls.push("providers"),
    wireCompiledInstance: () => calls.push("consumer"),
  };
  await instantiateTest262Module(empty, {}, { linkedModules: [{}], linkedRuntime: runtime });
  await instantiateTest262Module(empty, {}, { linkedModules: [{}], linkedRuntime: runtime });
  expect(calls).toEqual(["reset", "providers", "consumer", "reset", "providers", "consumer"]);
  const other: string[] = [];
  await instantiateTest262Module(
    empty,
    {},
    { linkedRuntime: { ...runtime, resetLinkedProjectRegistry: () => other.push("reset") } },
  );
  expect(other).toEqual(["reset"]);
  expect(calls).toHaveLength(6);
});

it("retires the registry even when the following unlinked binary is invalid", async () => {
  let resets = 0;
  await expect(
    instantiateTest262Module(
      new Uint8Array([0]),
      {},
      {
        linkedRuntime: {
          resetLinkedProjectRegistry: () => {
            resets++;
          },
        },
      },
    ),
  ).rejects.toThrow();
  expect(resets).toBe(1);
});

it("retains the lazily loaded source runtime identity for the next unlinked invocation", async () => {
  const calls: string[] = [];
  const runtime = {
    resetLinkedProjectRegistry: () => calls.push("reset"),
    instantiateLinkedProviders: () => calls.push("providers"),
    wireCompiledInstance: () => calls.push("consumer"),
  };
  vi.doMock("../src/linked-provider-runtime.js", () => runtime);
  try {
    await instantiateTest262Module(empty, {}, { linkedModules: [{}] });
    await instantiateTest262Module(empty, {});
    expect(calls).toEqual(["reset", "providers", "consumer", "reset"]);
  } finally {
    vi.doUnmock("../src/linked-provider-runtime.js");
  }
});
