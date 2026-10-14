// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";
import { emitBinary } from "../src/emit/binary.js";
import type { IrLowerResolver } from "../src/ir/backend/lower-contracts.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import * as invocation from "../src/ir/program-native-invocation.js";
import { subscribePreparedIrProgram } from "../src/ir/program-observation.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";
import { requireProgram, scalarFiles, sourceInput } from "./helpers/typed-program-fixtures.js";

afterEach(() => vi.restoreAllMocks());

function acceptedSource(decoded: boolean) {
  const prepared = requireProgram(prepareWholeIrProgram(sourceInput(scalarFiles)));
  const program = decoded ? decodePreparedIrProgram(encodePreparedIrProgram(prepared)) : prepared;
  const accepted = acceptPreparedIrProgram(program, replayOptions("wasmgc", "standalone"));
  if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
  return accepted;
}

function captureRealLowering(failAfterBody = false) {
  const captured: IrLowerResolver[] = [];
  const original = invocation.fillPreparedPrimaryUnit;
  vi.spyOn(invocation, "fillPreparedPrimaryUnit").mockImplementation((...args) => {
    const resolver = args[4];
    // Read an authentic, currently active resolver. No test IR or resource is minted.
    expect(() => resolver.resolveVecForElement!({ kind: "f64" })).not.toThrow();
    captured.push(resolver);
    original(...args);
    if (failAfterBody) throw new Error("construction failure after real body fill");
  });
  return captured;
}

function requireRevoked(captured: readonly IrLowerResolver[]) {
  expect(captured.length).toBeGreaterThan(0);
  for (const resolver of captured)
    expect(() => resolver.resolveVecForElement!({ kind: "f64" })).toThrow(/emission attempt is no longer active/);
}

describe("native memory bindings use the common whole-emission lifetime", () => {
  for (const decoded of [false, true]) {
    it(`revokes captured source bindings after actual successful execution, decoded=${decoded}`, async () => {
      const accepted = acceptedSource(decoded);
      const captured = captureRealLowering();
      const emitted = emitAcceptedIrProgram(accepted);
      expect(captured).toHaveLength(accepted.runtime.prepared.functions.length);
      const { instance } = await WebAssembly.instantiate(new Uint8Array(emitBinary(emitted.module)));
      const main = instance.exports.main;
      if (typeof main !== "function") throw new Error("missing genuine source export main");
      expect(main()).toBe(42);
      requireRevoked(captured);
      expect(() => emitAcceptedIrProgram(accepted)).toThrow(/already emitted/);
    });

    it(`revokes bindings on a failure after real lowering, decoded=${decoded}`, () => {
      const accepted = acceptedSource(decoded);
      const captured = captureRealLowering(true);
      expect(() => emitAcceptedIrProgram(accepted)).toThrow(/construction failure after real body fill/);
      requireRevoked(captured);
      expect(() => emitAcceptedIrProgram(accepted)).toThrow(/already emitted/);
    });

    it(`revokes bindings when the completion observer throws, decoded=${decoded}`, () => {
      const accepted = acceptedSource(decoded);
      const captured = captureRealLowering();
      const sentinel = new Error("completion observer failure control");
      const unsubscribe = subscribePreparedIrProgram((event) => {
        if (event.program === accepted.program && event.phase === "emitted") throw sentinel;
      });
      try {
        expect(() => emitAcceptedIrProgram(accepted)).toThrow(sentinel);
        requireRevoked(captured);
        expect(() => emitAcceptedIrProgram(accepted)).toThrow(/already emitted/);
      } finally {
        unsubscribe();
      }
    });
  }
});
