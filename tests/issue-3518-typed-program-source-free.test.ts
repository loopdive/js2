// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { encodeTypedPacket, decodeTypedPacket } from "./helpers/typed-program-transport.mjs";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { copyIrPreparationData } from "../src/ir/alloc-registry.js";
import { IR_CLASS_SHAPE_CELL } from "../src/ir/core/types.js";

describe("fresh-process typed preparation boundary", () => {
  it("losslessly transports non-JSON metadata graphs, descriptors, holes and the canonical recursive brand", () => {
    const shared = Object.create(null);
    const shape = { [IR_CLASS_SHAPE_CELL]: true, self: undefined as unknown };
    shape.self = shape;
    const sparse = new Array(3);
    sparse[1] = undefined;
    sparse[2] = shared;
    const data = {
      sparse,
      shared,
      again: shared,
      shape,
      map: new Map([[shared, new Set([shared])]]),
      values: [undefined, -0, NaN, Infinity, -Infinity, 99n],
    };
    Object.defineProperty(shared, "hidden", {
      value: undefined,
      writable: false,
      enumerable: false,
      configurable: false,
    });
    Object.preventExtensions(shared);
    const encoded = encodeTypedPacket(data),
      decoded = decodeTypedPacket(encoded);
    expect(decoded).toEqual(copyIrPreparationData(data));
    expect(encodeTypedPacket(decoded)).toBe(encoded);
    expect(decoded.again).toBe(decoded.shared);
    expect(decoded.shape.self).toBe(decoded.shape);
    expect(decoded.shape[IR_CLASS_SHAPE_CELL]).toBe(true);
    expect(decoded.sparse[2]).toBe(decoded.shared);
    expect(Object.hasOwn(decoded.sparse, 0)).toBe(false);
    expect(Object.hasOwn(decoded.sparse, 1)).toBe(true);
    expect(Object.getOwnPropertyDescriptors(decoded.shared)).toEqual(Object.getOwnPropertyDescriptors(shared));
    expect(Object.getPrototypeOf(decoded.shared)).toBeNull();
    expect(Object.isExtensible(decoded.shared)).toBe(false);
    expect([...decoded.map.keys()][0]).toBe(decoded.shared);
  });

  it.each([false, true])("prepares real standalone input with forbidden-load positive control=%s", (probe) => {
    const root = resolve(import.meta.dirname, "..");
    const directory = mkdtempSync(join(tmpdir(), "typed-program-source-free-"));
    try {
      const { packet } = sourcePacket();
      const text = encodeTypedPacket({ input: packet, options: typedOptions });
      const restored = decodeTypedPacket(text);
      expect(restored.input).toEqual(packet);
      expect(encodeTypedPacket(restored)).toBe(text); // before preparation, not just final output
      const expected = encodePreparedIrProgram(requireProgram(prepareTypedIrProgram(packet, typedOptions)));
      const packetFile = join(directory, "packet.json"),
        census = join(directory, "census.jsonl");
      writeFileSync(packetFile, text);
      writeFileSync(census, "");
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "tests/helpers/typed-program-source-free.mjs",
          packetFile,
          census,
          ...(probe ? ["--probe-forbidden-import"] : []),
        ],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
          env: {
            ...process.env,
            NODE_OPTIONS: "--max-old-space-size=2048",
            JS2WASM_IR_GVN_DEBUG: "1",
            JS2WASM_IR_GVN: "poison",
          },
        },
      );
      expect(child.error).toBeUndefined();
      const report = JSON.parse(child.stdout);
      expect(report.roundTripBeforePreparation, child.stderr || report.error).toBe(true);
      expect(report.encoded).toBe(expected);
      expect(report.sourceUnits).toBe(2);
      expect(report.bodies).toBeGreaterThanOrEqual(2);
      expect(report.loaded.some((row: { url: string }) => row.url.endsWith("/src/ir/program-prepare-ir.ts"))).toBe(
        true,
      );
      expect(report.loaded.some((row: { url: string }) => row.url.endsWith("/src/ir/program-codec.ts"))).toBe(true);
      expect(report.runtime.node).toBe(process.version);
      if (probe) {
        expect(child.status).toBe(1);
        expect(report.ok).toBe(false);
        expect(report.error).toMatch(/forbidden typed-preparation load.*ts-api/);
      } else {
        expect(child.status, report.error || child.stderr).toBe(0);
        expect(report.ok).toBe(true);
        expect(report.observations).toBe(0);
        expect(report.newExitListeners).toBe(0);
        expect(child.stderr).toBe("");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
