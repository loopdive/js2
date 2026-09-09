// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, TypeHandle, Instr, LocalDef } from "../../../wasm/model/instructions.js";

export interface PromiseAnyValueLayout {
  readonly typeIdx: TypeHandle;
  readonly tagFieldIdx: number;
  readonly refFieldIdx: number;
  readonly externFieldIdx: number;
}

/** Ordered inventory supplied at finalization, never inferred from absent inputs.
 * Prepared callers must account for the complete selected resource population
 * before certifying an empty array or null carrier.
 */
export interface PromiseThenableInventory {
  readonly finalized: true;
  readonly peelFuncIdx: FuncHandle | undefined;
  readonly methodTypeIdxs: readonly TypeHandle[];
  readonly accessors: readonly { readonly typeIdx: TypeHandle; readonly getGlobal: number }[];
  readonly callAccessorGetIdx: FuncHandle | undefined;
  readonly fields: readonly { readonly typeIdx: TypeHandle; readonly fieldIdx: number }[];
  readonly closureWrapperTypeIdxs: readonly TypeHandle[];
  readonly openObject: {
    readonly typeIdx: TypeHandle;
    readonly externGetFuncIdx: FuncHandle;
    readonly thenStringInstrs: readonly Instr[];
  } | null;
}

export function buildPromisePeelValue(layout: PromiseAnyValueLayout | null): { locals: LocalDef[]; body: Instr[] } {
  if (layout === undefined) throw new Error("Promise AnyValue inventory is missing");
  if (layout === null) return { locals: [], body: [{ op: "local.get", index: 0 }] };
  const anyValueTypeIdx = layout.typeIdx;
  const AV_TAG = layout.tagFieldIdx;
  const AV_REF = layout.refFieldIdx;
  const AV_EXT = layout.externFieldIdx;
  const peelAnyLocal = 1;
  const locals: LocalDef[] = [{ name: "__any", type: { kind: "anyref" } }];
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: 0 }, { op: "return" }],
    },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: peelAnyLocal },
    { op: "local.get", index: peelAnyLocal },
    { op: "ref.test", typeIdx: anyValueTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // tag 6 (object) → extern.convert_any(refval)
        { op: "local.get", index: peelAnyLocal },
        { op: "ref.cast", typeIdx: anyValueTypeIdx },
        { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: AV_TAG },
        { op: "i32.const", value: 6 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: peelAnyLocal },
            { op: "ref.cast", typeIdx: anyValueTypeIdx },
            { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: AV_REF },
            { op: "extern.convert_any" },
            { op: "return" },
          ],
        },
        // tag 5 (string/extern payload) → externval
        { op: "local.get", index: peelAnyLocal },
        { op: "ref.cast", typeIdx: anyValueTypeIdx },
        { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: AV_TAG },
        { op: "i32.const", value: 5 },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: peelAnyLocal },
            { op: "ref.cast", typeIdx: anyValueTypeIdx },
            { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: AV_EXT },
            { op: "return" },
          ],
        },
      ],
    },
    { op: "local.get", index: 0 },
  ];
  return { locals, body };
}

export function buildPromiseThenableClassifier(resources: PromiseThenableInventory): {
  locals: LocalDef[];
  body: Instr[];
} {
  if (
    resources.finalized !== true ||
    !Array.isArray(resources.methodTypeIdxs) ||
    !Array.isArray(resources.accessors) ||
    !Array.isArray(resources.fields) ||
    !Array.isArray(resources.closureWrapperTypeIdxs) ||
    resources.openObject === undefined
  )
    throw new Error("Promise thenable inventory is not finalized");
  if (resources.accessors.length && resources.callAccessorGetIdx === undefined)
    throw new Error("Promise accessor inventory requires its getter binding");
  const {
    peelFuncIdx: peelIdx,
    methodTypeIdxs,
    accessors,
    fields,
    closureWrapperTypeIdxs,
    openObject,
    callAccessorGetIdx,
  } = resources;
  const peeledLocalIdx = 1; // param 0 = value externref
  const anyLocalIdx = 2;
  const thenAnyLocalIdx = 3;
  const body: Instr[] = [
    // peeled = __promise_peel_value(value) — classify the RAW payload.
    { op: "local.get", index: 0 },
    ...((peelIdx !== undefined ? [{ op: "call", funcIdx: peelIdx }] : []) satisfies Instr[]),
    { op: "local.set", index: peeledLocalIdx },
    // null externref (JS null / absent) → not a thenable.
    { op: "local.get", index: peeledLocalIdx },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 0 }, { op: "return" }],
    },
    { op: "local.get", index: peeledLocalIdx },
    { op: "any.convert_extern" },
    { op: "local.set", index: anyLocalIdx },
  ];

  // Shared tail: test the externref left on the stack against the closure
  // base wrappers; 1 on a hit, else 0.
  const closureTest = (loadThen: Instr[]): Instr[] => [
    ...loadThen,
    { op: "any.convert_extern" },
    { op: "local.set", index: thenAnyLocalIdx },
    ...closureWrapperTypeIdxs.flatMap((typeIdx): Instr[] => [
      { op: "local.get", index: thenAnyLocalIdx },
      { op: "ref.test", typeIdx },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "i32.const", value: 1 }, { op: "return" }] },
    ]),
    { op: "i32.const", value: 0 },
    { op: "return" },
  ];

  // Closed-struct METHOD arms — a compiled `then` method is always callable.
  const seenMethodType = new Set<number>();
  for (const entry of methodTypeIdxs.map((typeIdx) => ({ typeIdx }))) {
    if (seenMethodType.has(entry.typeIdx)) continue;
    seenMethodType.add(entry.typeIdx);
    body.push({ op: "local.get", index: anyLocalIdx });
    body.push({ op: "ref.test", typeIdx: entry.typeIdx });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
    });
  }

  // Closed-struct ACCESSOR arms (#1888 S5c) — MUST run BEFORE the field arms:
  // `Object.defineProperty(o, 'then', {get})` on a closed-struct target stores
  // the getter closure in a per-(struct,prop) module GLOBAL
  // (`ctx.structAccessorClosure`), invisible to `__extern_get` — while the
  // struct may ALSO carry a pre-shaped (runtime-null) `then` FIELD that would
  // wrongly classify it non-thenable if tested first. Spec Get REQUIRES running
  // the getter here — a poisoned getter must throw OUT of this predicate
  // (resolve-poisoned-then), and a returned closure classifies the value as a
  // thenable. A runtime-null getter global (define-site never executed) falls
  // through to the field/$Object arms below.
  if (callAccessorGetIdx !== undefined) {
    for (const { typeIdx: structTypeIdx, getGlobal } of accessors) {
      const entry = { getGlobal };
      body.push({ op: "local.get", index: anyLocalIdx });
      body.push({ op: "ref.test", typeIdx: structTypeIdx });
      body.push({
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "global.get", index: entry.getGlobal },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: closureTest([
              // then = getter.call(value) — §7.3.2 GetV via the S5b driver.
              { op: "local.get", index: peeledLocalIdx },
              { op: "global.get", index: entry.getGlobal },
              { op: "call", funcIdx: callAccessorGetIdx },
            ]),
          },
        ],
      });
    }
  }

  // Closed-struct FIELD arms — `{ then: <value> }`: callable iff the stored
  // value is a closure.
  for (const fe of fields) {
    body.push({ op: "local.get", index: anyLocalIdx });
    body.push({ op: "ref.test", typeIdx: fe.typeIdx });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: closureTest([
        { op: "local.get", index: anyLocalIdx },
        { op: "ref.cast", typeIdx: fe.typeIdx },
        { op: "struct.get", typeIdx: fe.typeIdx, fieldIdx: fe.fieldIdx },
      ]),
    });
  }

  // Open `$Object` arm — spec Get (runs accessors; a poisoned getter throws
  // OUT of this predicate) + closure test.
  const externGetIdx = openObject?.externGetFuncIdx;
  const objectTypeIdx = openObject?.typeIdx;
  if (externGetIdx !== undefined && objectTypeIdx !== undefined) {
    body.push({ op: "local.get", index: anyLocalIdx });
    body.push({ op: "ref.test", typeIdx: objectTypeIdx });
    body.push({
      op: "if",
      blockType: { kind: "empty" },
      then: closureTest([
        { op: "local.get", index: peeledLocalIdx },
        ...structuredClone(openObject!.thenStringInstrs),
        { op: "call", funcIdx: externGetIdx },
      ]),
    });
  }

  body.push({ op: "i32.const", value: 0 });
  const locals: LocalDef[] = [
    { name: "__peeled", type: { kind: "externref" } },
    { name: "__any", type: { kind: "anyref" } },
    { name: "__thenAny", type: { kind: "anyref" } },
  ];
  return { locals, body };
}
