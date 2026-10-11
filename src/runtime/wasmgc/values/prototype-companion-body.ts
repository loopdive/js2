// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr } from "../../../wasm/model/instructions.js";

export interface PrototypeCompanionSeedCall {
  readonly offset: number;
  readonly functionIndex: number;
}
export interface PrototypeCompanionBodyResources {
  readonly tableGlobalIdx: number;
  readonly tableArrTypeIdx: number;
  readonly newPlainObjectIdx: number;
  readonly brandCount: number;
  readonly forceCreateOffsets: readonly number[];
  readonly seedCalls: readonly PrototypeCompanionSeedCall[];
}

/** Publish the table, then the companion slot, before invoking its seeder. */
export function buildPrototypeCompanionBody(d: PrototypeCompanionBodyResources): Instr[] {
  return [
    // (#2175 V2-S3b-1) A brand with a SEEDER always materializes its companion,
    // even on a pure read. Both read probes (`__protoidx_get_k` /
    // `__protoidx_has_k`) call in with `create = 0` — correct for #4176, where a
    // companion only exists once the program has WRITTEN to that prototype, so
    // "absent slot" genuinely means "nothing stored". A seeded brand inverts
    // that: its own members are waiting to be installed and the slot is absent
    // only because nobody has asked yet. Forcing `create = 1` for exactly the
    // seeded offsets makes the read paths self-materializing without changing
    // behaviour for any unseeded brand (whose slot keeps its create-on-write
    // rule) — and, because both probes go through here, GET and `in` agree by
    // construction instead of by accident.
    ...buildForceCreateArms(d.forceCreateOffsets, 0, 1),
    { op: "global.get", index: d.tableGlobalIdx },
    { op: "local.set", index: 2 },
    { op: "local.get", index: 2 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "ref.null.extern" }, { op: "return" }],
        },
        { op: "i32.const", value: d.brandCount },
        { op: "array.new_default", typeIdx: d.tableArrTypeIdx },
        { op: "local.set", index: 2 },
        { op: "local.get", index: 2 },
        { op: "global.set", index: d.tableGlobalIdx },
      ],
    },
    // c = arr[whichOff]
    { op: "local.get", index: 2 },
    { op: "ref.as_non_null" },
    { op: "local.get", index: 0 },
    { op: "array.get", typeIdx: d.tableArrTypeIdx },
    { op: "local.set", index: 3 },
    // absent && create → mint a plain $Object companion into the slot
    { op: "local.get", index: 3 },
    { op: "ref.is_null" },
    { op: "local.get", index: 1 },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "call", funcIdx: d.newPlainObjectIdx },
        { op: "local.set", index: 3 },
        { op: "local.get", index: 2 },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 0 },
        { op: "local.get", index: 3 },
        { op: "array.set", typeIdx: d.tableArrTypeIdx },
        // (#2175 V2-S3b-1) Seed the fresh companion with the brand's BUILTIN
        // own members, so a `$NativeProto` flowing as a runtime value answers
        // `p.exec` / `TypedArray.prototype.find` through the ordinary consult.
        // Placed AFTER the slot store, which is what makes it re-entrancy-safe:
        // a seeder body calls `__defineProperty_value`/`_accessor`, whose own
        // #4176 write arms can route back into `__protoidx_companion` for the
        // same offset — by then the slot is non-null, so that re-entry takes
        // the cached path instead of minting a second companion and recursing.
        ...buildSeedArms(d.seedCalls, 0, 3),
      ],
    },
    { op: "local.get", index: 3 },
  ];
}

function buildForceCreateArms(offsets: readonly number[], whichOffLocal: number, createLocal: number): Instr[] {
  const arms: Instr[] = [];
  for (const off of offsets) {
    arms.push(
      { op: "local.get", index: whichOffLocal },
      { op: "i32.const", value: off },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: createLocal },
        ],
      },
    );
  }
  return arms;
}

function buildSeedArms(
  seeders: readonly PrototypeCompanionSeedCall[],
  whichOffLocal: number,
  companionLocal: number,
): Instr[] {
  const arms: Instr[] = [];
  for (const { offset: off, functionIndex: funcIdx } of seeders) {
    arms.push(
      { op: "local.get", index: whichOffLocal },
      { op: "i32.const", value: off },
      { op: "i32.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: companionLocal },
          { op: "call", funcIdx },
        ],
      },
    );
  }
  return arms;
}
