// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice Str (review round 2) — the scoped string emitter realises only an authenticated occurrence of its
// owner's executable projection. The Prepared presentation attaches no string provider, so only a forged emission
// request reaches these checks: each test issues one (wrong owner, wrong provider, a length provider that is no
// carrier field) through `preparedNativeStringResolver`, beside the accepted request it was forged from.
import { describe, expect, it } from "vitest";
import { createEmptyModule } from "../src/ir/types.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import { reserveNativeStringLiteralTypes } from "../src/backend/wasmgc/resources/native-string-literals.js";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import { deriveNativeStringOutputRequirements } from "../src/ir/program/native-string-output-requirements.js";
import { prepareIrProgramSources, captureTypedIrProgramInput } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";
import { sourceInput, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import {
  planNativeStringValuePhysical,
  reserveNativeStringValueResources,
  fillNativeStringValueResources,
  preparedNativeStringResolver,
} from "../src/backend/wasmgc/program/native-string-values.js";

const SOURCE =
  "function cat(a: string, b: string): string { return a + b; }\n" +
  "function eq(a: string, b: string): boolean { return a === b; }\n" +
  "function len(a: string): number { return a.length; }\n" +
  "export function run(): number { return len(cat('a', 'b')) + (eq('a', 'b') ? 1 : 0); }";
const OUTSIDE = /outside the closed owner projection/;

function emitter(len: "native" | "host" = "native") {
  const policy = {
    target: "standalone",
    backend: "wasmgc",
    stringConst: { storage: "native" },
    stringEq: { eq: "native" },
    stringLen: { len },
    stringConcat: { concat: "native" },
  } as const;
  const source = prepareIrProgramSources({
    ...sourceInput({ "./entry.ts": SOURCE }),
    policy,
    nativeStringValueProjection: "standalone-native",
  });
  if (source.kind !== "prepared") throw new Error(source.detail);
  const program = requireProgram(
    prepareTypedIrProgram(captureTypedIrProgramInput(source), { ...typedOptions, policy, runtimePolicies: [policy] }),
  );
  const demands = collectNativeStringValueDemands(program, program.runtime[0]!);
  const outcome = planNativeStringValuePhysical(demands, { representation: "native-string", utf8Storage: false });
  if (outcome.kind !== "planned") throw new Error("expected a planned string setup");
  const tx = new PhysicalModuleReservations(createEmptyModule());
  const types = reserveNativeStringLiteralTypes(tx, outcome.plan.key, false);
  const outputRequirements = deriveNativeStringOutputRequirements(demands, { emptyIdentity: true });
  if ("kind" in outputRequirements) throw new Error(outputRequirements.detail);
  const pack = reserveNativeStringValueResources(tx, { demands, plan: outcome.plan, outputRequirements }, types);
  tx.freezeReservations();
  fillNativeStringValueResources(tx, pack);
  // The executable occurrence of each kind, and the unit that owns it.
  const occurrence = (kind: string) => {
    const index = demands.occurrences.findIndex(
      (row) => row.instruction.kind === kind && demands.buffers[row.bufferIndex]!.view === "projection",
    );
    const row = demands.occurrences[index]!;
    return { instruction: row.instruction, owner: demands.buffers[row.bufferIndex]!.ownerUnitId };
  };
  const resolver = (owner: Parameters<typeof preparedNativeStringResolver>[2]) =>
    preparedNativeStringResolver(tx, pack, owner);
  const run = demands.owners.find(
    (row) => !["string.eq", "string.len", "string.concat"].some((kind) => occurrence(kind).owner === row.unitId),
  )!.unitId;
  return { pack, tx, occurrence, resolver, run };
}

describe("#7354 Str — forged emission requests through preparedNativeStringResolver", () => {
  const s = emitter();
  const eq = s.occurrence("string.eq");
  const len = s.occurrence("string.len");
  const cat = s.occurrence("string.concat");
  const alloc = cat.instruction.kind === "string.concat" ? cat.instruction.alloc : undefined;
  const foreign = irIntrinsicFuncRef("__foreign_provider");

  it("realises each operation for its own owner", () => {
    expect(s.resolver(eq.owner).emitStringEquals()).toEqual([{ op: "call", funcIdx: s.pack.equality!.equals.handle }]);
    expect(s.resolver(len.owner).emitStringLen()).toEqual([
      { op: "struct.get", typeIdx: s.pack.strings.layout.anyStrTypeIdx, fieldIdx: 0 },
    ]);
    expect(s.resolver(cat.owner).emitStringConcat!(alloc, "immutable")).toEqual([
      { op: "call", funcIdx: s.pack.output!.concat.handle },
    ]);
  });

  it.each([
    ["string.eq", () => s.resolver(s.run).emitStringEquals()],
    ["string.len", () => s.resolver(s.run).emitStringLen()],
    ["string.concat", () => s.resolver(s.run).emitStringConcat!(alloc, "immutable")],
    ["string.eq of another owner's occurrence", () => s.resolver(len.owner).emitStringEquals()],
  ])("refuses %s requested by an owner that has no such occurrence", (_, request) => {
    expect(request).toThrow(OUTSIDE);
  });

  it.each([
    ["string.eq", () => s.resolver(eq.owner).emitStringEquals(foreign)],
    ["string.len", () => s.resolver(len.owner).emitStringLen(undefined, { kind: "callable", target: foreign })],
    ["string.concat", () => s.resolver(cat.owner).emitStringConcat!(alloc, "immutable", foreign)],
  ])("refuses %s requested with a provider its occurrence does not carry", (_, request) => {
    expect(request).toThrow(OUTSIDE);
  });

  it("refuses string.len when the selected length provider is no carrier field", () => {
    const host = emitter("host");
    expect(() => host.resolver(host.occurrence("string.len").owner).emitStringLen()).toThrow(/carrier field/);
  });
});
