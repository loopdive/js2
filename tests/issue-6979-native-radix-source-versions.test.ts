// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { NATIVE_RADIX_SOURCES, type NativeRadixSourceVersion } from "../src/runtime/contracts/number-format-sources.js";
import { numToStringRadixDef, numToStringRadixDefForVersion } from "../src/stdlib/number-format.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareNumberFormatRuntimeSupport } from "../src/frontend/builtins/prepare-number-format.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { assertIrRuntimeSupport, irRuntimeSupportOccurrences } from "../src/ir/program/runtime-support.js";
import { canonicalNativeRadixBody } from "../src/ir/program/formatter-canonical-bodies.generated.js";
import { describeNativeRadixBody } from "../src/ir/program/formatter-body-identity.js";
import { preparedIrDataMismatch } from "../src/ir/program/data.js";
import { forEachInstrDeep, type IrInstr } from "../src/ir/core/nodes.js";
import { requireProgram, typedOptions } from "./helpers/typed-program-fixtures.js";

const policy = {
  backend: "wasmgc",
  target: "standalone",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
} as const;
const original = readFileSync(new URL("../website/playground/examples/js/async.ts", import.meta.url), "utf8");
function fixture(version: NativeRadixSourceVersion, displaced = false) {
  const entry = displaced ? "./renamed.ts" : "./entry.ts";
  const text = (displaced ? 'export function padding(): string { return "preceding allocation"; }\n' : "") + original;
  const ast = analyzeMultiSource({ [entry]: text }, entry);
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    deferTopLevelInit: false,
    promiseDelayProjection: "standalone-native",
    asyncFamilyProjection: "standalone-native",
  });
  if (source.kind !== "prepared") throw Error(source.detail);
  const support = prepareNumberFormatRuntimeSupport(source, policy, version)!;
  const packet = captureTypedIrProgramInput(source, support);
  assertIrRuntimeSupport(packet, packet.runtimeSupport);
  const program = requireProgram(prepareTypedIrProgram(packet, { ...typedOptions, policy, runtimePolicies: [policy] }));
  return { packet, program };
}
const fixtures = new Map<string, ReturnType<typeof fixture>>();
beforeAll(async () => {
  for (const version of [1, 2] as const)
    for (const displaced of [false, true]) {
      fixtures.set(`${version}:${displaced}`, fixture(version, displaced));
      await setImmediate();
    }
}, 120000);
afterEach(() => setImmediate());
const selected = (version: NativeRadixSourceVersion, displaced = false) => fixtures.get(`${version}:${displaced}`)!;
function instructions(packet: ReturnType<typeof fixture>["packet"]) {
  const batch = packet.runtimeSupport!.batches[0]!,
    rows: IrInstr[] = [];
  for (const block of batch.implementation.body.blocks)
    for (const root of block.instrs) forEachInstrDeep(root, (i) => rows.push(i));
  return { batch, rows };
}

describe("explicit historical and integer-fast-path native radix source versions", () => {
  it("retains both exact source pins and unchanged default stdlib definition", () => {
    const type = selected(2).packet.runtimeSupport!.batches[0]!.scratch.type;
    for (const version of [1, 2] as const) {
      const row = NATIVE_RADIX_SOURCES[version],
        def = numToStringRadixDefForVersion(type, version);
      expect(def.source).toBe(row.source);
      expect(Buffer.byteLength(def.source)).toBe(row.provenance.utf8Bytes);
      expect(createHash("sha256").update(def.source).digest("hex")).toBe(row.provenance.sha256);
    }
    expect(numToStringRadixDef(type)).toEqual(numToStringRadixDefForVersion(type, 2));
    expect(NATIVE_RADIX_SOURCES[1].provenance.utf8Bytes).toBe(1618);
    expect(NATIVE_RADIX_SOURCES[2].provenance.utf8Bytes).toBe(2226);
  });

  for (const version of [1, 2] as const) {
    it(`reauthenticates genuine version${version} through codec replay and a different original source/allocation space`, () => {
      const base = selected(version),
        shifted = selected(version, true);
      const a = base.packet.runtimeSupport!.batches[0]!,
        b = shifted.packet.runtimeSupport!.batches[0]!;
      expect(a.kind).toBe(`number-format-radix-v${version}`);
      expect(a.source).toEqual(NATIVE_RADIX_SOURCES[version].provenance);
      expect(a.sourceId).not.toBe(b.sourceId);
      expect(a.literals.map((row) => row.alloc)).not.toEqual(b.literals.map((row) => row.alloc));
      for (const f of [base, shifted]) {
        const decoded = decodePreparedIrProgram(encodePreparedIrProgram(f.program));
        const batch = decoded.runtimeSupport!.batches[0]!;
        expect(batch.kind).toBe(a.kind);
        expect(batch.source).toEqual(a.source);
        expect(
          preparedIrDataMismatch(
            describeNativeRadixBody(batch.implementation.body, batch.sourceId),
            canonicalNativeRadixBody(version),
          ),
        ).toBeUndefined();
      }
    });

    it.each(["constant", "branch", "call-argument", "literal", "allocation-sharing", "own-undefined-field"] as const)(
      `refuses version${version} %s corruption even after refreshing the caller's receipts`,
      (change) => {
        const packet = structuredClone(selected(version).packet),
          { batch, rows } = instructions(packet);
        assertIrRuntimeSupport(packet, packet.runtimeSupport);
        if (change === "constant") {
          const row = rows.find((i) => i.kind === "const" && i.value.kind === "f64" && i.value.value === 48)!;
          if (row.kind !== "const") throw Error("missing actual digit constant");
          Reflect.set(row.value, "value", 49);
        } else if (change === "branch") {
          const row = rows.find((i) => i.kind === "if.stmt")!;
          if (row.kind !== "if.stmt") throw Error("missing actual guard");
          const oldThen = row.then;
          Reflect.set(row, "then", row.else);
          Reflect.set(row, "else", oldThen);
        } else if (change === "call-argument") {
          const row = rows.find((i) => i.kind === "call" && i.target.name === "__nfd_set")!;
          if (row.kind !== "call") throw Error("missing actual buffer write");
          Reflect.set(row, "args", [row.args[0], row.args[2], row.args[1]]);
        } else if (change === "literal") {
          Reflect.set(rows.find((i) => i.kind === "string.const")!, "value", "not-NaN");
        } else if (change === "allocation-sharing") {
          const allocated = rows.filter((i) => i.alloc !== undefined);
          expect(allocated.length).toBeGreaterThan(2);
          Reflect.set(allocated[1]!, "alloc", allocated[0]!.alloc);
        } else Reflect.set(rows[0]!, "unexpected", undefined);
        Object.assign(batch, irRuntimeSupportOccurrences(batch.implementation.body));
        expect(() => assertIrRuntimeSupport(packet, packet.runtimeSupport)).toThrow(
          "noncanonical radix body for source version",
        );
      },
    );

    it(`refuses coherent version${version} body relabeling with the other valid source digest`, () => {
      const packet = structuredClone(selected(version).packet),
        batch = packet.runtimeSupport!.batches[0]!,
        other = version === 1 ? 2 : 1;
      assertIrRuntimeSupport(packet, packet.runtimeSupport);
      Reflect.set(batch, "kind", `number-format-radix-v${other}`);
      Reflect.set(batch, "source", NATIVE_RADIX_SOURCES[other].provenance);
      expect(() => assertIrRuntimeSupport(packet, packet.runtimeSupport)).toThrow(
        "noncanonical radix body for source version",
      );
    });
  }

  it("cannot mutate private canonical expectations through returned descriptive data", () => {
    const expected = canonicalNativeRadixBody(2) as { blocks: unknown[] };
    expected.blocks.length = 0;
    expect((canonicalNativeRadixBody(2) as { blocks: unknown[] }).blocks.length).toBeGreaterThan(0);
    const f = selected(2);
    assertIrRuntimeSupport(f.packet, f.packet.runtimeSupport);
  });
  it("refuses unknown codec versions rather than interpreting them as the default", () => {
    const program = structuredClone(selected(2).program);
    Reflect.set(program.runtimeSupport!.batches[0]!, "kind", "number-format-radix-v999");
    expect(() => decodePreparedIrProgram(encodePreparedIrProgram(program))).toThrow(
      "unsupported runtime support batch",
    );
  });
});
