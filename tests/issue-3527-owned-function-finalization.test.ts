// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Owned fills stay locked while the ledger can audit them. The output finalizers
// that rewrite bodies in place (finalizePipelineModule's allocation-owner stamp
// and widening) must run on the released view, and match legacy-fill output.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import {
  acceptPreparedIrProgram,
  emitAcceptedIrProgram,
  emittedSupportFunctionReceipts,
} from "../src/ir/program-consumer.js";
import { widenNonDefaultableTypes } from "../src/compiler/output.js";
import { stampAllocationOwners } from "../src/wasm/physical/allocation-owner.js";
import { isPrivatelyCopiedFrozenArray, releaseOwnedFunctions } from "../src/wasm/physical/owned-function-data.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { emitBinary } from "../src/emit/binary.js";
import { sourceInput, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";
import type { RuntimeManifestPolicy } from "../src/ir/runtime-manifest.js";
import type { WasmModule } from "../src/ir/types.js";

const policy: RuntimeManifestPolicy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  numberBoundary: { box: "unsupported", unbox: "native" },
  booleanBoundary: { box: "native", unbox: "native" },
};

function emitBooleanBox(utf8Storage: boolean) {
  const program = requireProgram(
    prepareWholeIrProgram({
      ...sourceInput({ "./entry.ts": "export function box(value: boolean): any { return value; }" }),
      policy,
      runtimePolicies: [policy],
      nativeStringValueProjection: "standalone-native",
    }),
  );
  const accepted = acceptPreparedIrProgram(program, { ...replayOptions("wasmgc", "standalone"), utf8Storage });
  if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
  return emitAcceptedIrProgram(accepted);
}

/** The in-place steps of finalizePipelineModule, on its released input. */
function finalize(module: WasmModule): Uint8Array {
  const output = releaseOwnedFunctions(module);
  stampAllocationOwners(output, "__allocation_owner");
  widenNonDefaultableTypes(output);
  return emitBinary(output);
}

/** Exactly the prototypes and descriptors copyModuleData and the finalizers accept. */
function plainMutableData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  if (value instanceof Uint8Array) return Object.getPrototypeOf(value) === Uint8Array.prototype;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== (Array.isArray(value) ? Array.prototype : Object.prototype) || !Object.isExtensible(value))
    return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return descriptor.writable === true && plainMutableData(descriptor.value, seen);
  });
}

beforeAll(() => vi.stubEnv("JS2WASM_IR_GVN", "0"));
afterEach(() => vi.restoreAllMocks());
afterAll(() => vi.unstubAllEnvs());

describe("owned fills through output finalization", () => {
  for (const utf8Storage of [false, true]) {
    it(`stamps and widens owned ledger output like legacy fills, utf8=${utf8Storage}`, () => {
      const owned = emitBooleanBox(utf8Storage);
      const ownedBodies = owned.module.functions.filter((fn) => isPrivatelyCopiedFrozenArray(fn.body));
      expect(ownedBodies.length).toBeGreaterThan(0);
      const bytes = finalize(owned.module);

      vi.spyOn(PhysicalModuleReservations.prototype, "fillOwnedFunction").mockImplementation(function (
        this: PhysicalModuleReservations,
        token,
        definition,
      ) {
        this.fillFunction(token, definition);
      });
      const legacy = emitBooleanBox(utf8Storage);
      expect(legacy.module.functions.some((fn) => isPrivatelyCopiedFrozenArray(fn.body))).toBe(false);
      expect(bytes).toEqual(finalize(legacy.module));
      expect(() => new WebAssembly.Module(bytes as BufferSource)).not.toThrow();
    });

    it(`releases plain mutable clones without touching the ledger's owned bodies, utf8=${utf8Storage}`, () => {
      const emitted = emitBooleanBox(utf8Storage);
      expect(() => emittedSupportFunctionReceipts(emitted)).not.toThrow();
      const bodies = emitted.module.functions.map((fn) => fn.body);
      const released = releaseOwnedFunctions(emitted.module);
      expect(released).not.toBe(emitted.module);
      emitted.module.functions.forEach((fn, index) => {
        if (isPrivatelyCopiedFrozenArray(fn.body)) expect(released.functions[index]).not.toBe(fn);
        else expect(released.functions[index]).toBe(fn);
        if (isPrivatelyCopiedFrozenArray(fn.body)) expect(plainMutableData(released.functions[index])).toBe(true);
      });
      finalize(emitted.module);
      // Legacy bodies are shared and rewritten in place, as before; owned ones stay locked.
      emitted.module.functions.forEach((fn, index) => {
        if (isPrivatelyCopiedFrozenArray(bodies[index])) expect(fn.body).toBe(bodies[index]);
      });
      expect(releaseOwnedFunctions(released)).toBe(released);
    });
  }
});
