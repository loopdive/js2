// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4098) Native `$Error_struct` own-property substrate.
 *
 * Native Error values are not open `$Object`s, but they already carry a
 * nullable `$props` field (field 5) for user Error-subclass fields. This module
 * makes that field the single ordinary-own-property store for Error expandos
 * too. The helpers are reserved before `__extern_get` / `__extern_set` and the
 * reflective MOP are emitted, then filled after the complete type table exists.
 *
 * Reads and writes deliberately do not recurse through the bag as the receiver:
 * an accessor installed on `err` must observe `this === err`, not the hidden
 * `$Object` sidecar. Data mutation still delegates to `__extern_set` on the bag,
 * so descriptor flags and integrity checks remain owned by the ordinary object
 * runtime rather than being reimplemented here.
 *
 * This is shared runtime ABI, not an AST lowering: prepared IR and legacy
 * callers both reach the same `__extern_*` / descriptor / enumeration helpers.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { CALL_ACCESSOR_GET, CALL_ACCESSOR_SET } from "./accessor-driver.js";
import { undefinedExternInstrs } from "./any-helpers.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addFuncType } from "./registry/types.js";

export const IS_ERROR_PROP_CARRIER = "__is_error_prop_carrier";
export const ERROR_PROP_BAG_LOOKUP = "__error_prop_bag_lookup";
export const ERROR_PROP_BAG_ENSURE = "__error_prop_bag_ensure";
export const ERROR_PROP_GET = "__error_prop_get";
export const ERROR_PROP_SET = "__error_prop_set";

const EXT: ValType = { kind: "externref" };
const I32: ValType = { kind: "i32" };
const ANY: ValType = { kind: "anyref" };
const FLAG_ACCESSOR = 0x08;

/** Reserve stable helper indices before the object-runtime call sites bake them. */
export function reserveErrorPropHelpers(ctx: CodegenContext): void {
  if (!(ctx.standalone || ctx.wasi)) return;
  if (ctx.funcMap.has(IS_ERROR_PROP_CARRIER)) return;

  const reserve = (name: string, params: ValType[], results: ValType[], body: Instr[]): void => {
    const typeIdx = addFuncType(ctx, params, results, `$${name}_type`);
    const funcIdx = mintDefinedFunc(ctx);
    const fn: WasmFunction = { name, typeIdx, locals: [], body, exported: false };
    pushDefinedFunc(ctx, funcIdx, fn);
    ctx.funcMap.set(name, funcIdx);
  };

  reserve(IS_ERROR_PROP_CARRIER, [EXT], [I32], [{ op: "i32.const", value: 0 }]);
  reserve(ERROR_PROP_BAG_LOOKUP, [EXT], [EXT], [{ op: "ref.null.extern" }]);
  reserve(ERROR_PROP_BAG_ENSURE, [EXT], [EXT], [{ op: "ref.null.extern" }]);
  reserve(ERROR_PROP_GET, [EXT, EXT], [EXT], [{ op: "ref.null.extern" }]);
  reserve(ERROR_PROP_SET, [EXT, EXT, EXT], [], []);
}

/**
 * `__extern_set`'s native Error arm. It is terminal only for a real
 * `$Error_struct`; all other non-object receivers fall through unchanged.
 */
export function buildErrorPropSetArm(ctx: CodegenContext): Instr[] {
  const isIdx = ctx.funcMap.get(IS_ERROR_PROP_CARRIER);
  const setIdx = ctx.funcMap.get(ERROR_PROP_SET);
  if (isIdx === undefined || setIdx === undefined) return [];
  return [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: isIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: setIdx },
        { op: "return" },
      ],
    },
  ];
}

/** Fill the Error carrier predicate, sidecar accessors, and receiver-aware get/set. */
export function fillErrorPropHelpers(ctx: CodegenContext): void {
  const errTypeIdx = ctx.errorStructTypeIdx;
  const types = ctx.objectRuntimeTypes;
  if (errTypeIdx < 0 || !types) return;
  const { objectTypeIdx, propEntryTypeIdx } = types;
  const newObjectIdx = ctx.funcMap.get("__new_plain_object");
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const externSetIdx = ctx.funcMap.get("__extern_set");
  const lookupIdx = ctx.funcMap.get(ERROR_PROP_BAG_LOOKUP);
  const ensureIdx = ctx.funcMap.get(ERROR_PROP_BAG_ENSURE);
  const callGetIdx = ctx.funcMap.get(CALL_ACCESSOR_GET);
  const callSetIdx = ctx.funcMap.get(CALL_ACCESSOR_SET);
  const setDecideIdx = ctx.funcMap.get("__extern_set_decide");
  const setOwnIdx = ctx.funcMap.get("__extern_set_own");
  const setResultGlobalIdx = ctx.externSetResultGlobalIdx;
  if (
    newObjectIdx === undefined ||
    objFindIdx === undefined ||
    externSetIdx === undefined ||
    lookupIdx === undefined ||
    ensureIdx === undefined ||
    callGetIdx === undefined ||
    callSetIdx === undefined
  ) {
    return;
  }

  const setFn = (name: string, locals: { name: string; type: ValType }[], body: Instr[]): void => {
    const idx = ctx.funcMap.get(name);
    if (idx === undefined) return;
    const fn = definedFuncAt(ctx, idx);
    if (!fn) return;
    fn.locals = locals;
    fn.body = body;
  };
  const errorRef = (anyLocal: number): Instr[] => [
    { op: "local.get", index: anyLocal },
    { op: "ref.cast", typeIdx: errTypeIdx },
  ];
  const requireError = (anyLocal: number, miss: Instr[]): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: anyLocal },
    { op: "ref.test", typeIdx: errTypeIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: miss },
  ];
  const nullMiss = (): Instr[] => [{ op: "ref.null.extern" }, { op: "return" }];

  setFn(
    IS_ERROR_PROP_CARRIER,
    [{ name: "any", type: ANY }],
    [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "ref.test", typeIdx: errTypeIdx }],
  );

  // `$props` lookup is query-only: merely inspecting an Error must not allocate.
  setFn(
    ERROR_PROP_BAG_LOOKUP,
    [{ name: "any", type: ANY }],
    [...requireError(1, nullMiss()), ...errorRef(1), { op: "struct.get", typeIdx: errTypeIdx, fieldIdx: 5 }],
  );

  setFn(
    ERROR_PROP_BAG_ENSURE,
    [
      { name: "any", type: ANY },
      { name: "err", type: { kind: "ref_null", typeIdx: errTypeIdx } },
      { name: "bag", type: EXT },
    ],
    [
      ...requireError(1, nullMiss()),
      ...errorRef(1),
      { op: "local.set", index: 2 },
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: errTypeIdx, fieldIdx: 5 },
      { op: "local.tee", index: 3 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "ref.as_non_null" },
          { op: "call", funcIdx: newObjectIdx },
          { op: "local.tee", index: 3 },
          { op: "struct.set", typeIdx: errTypeIdx, fieldIdx: 5 },
        ],
      },
      { op: "local.get", index: 3 },
    ],
  );

  const GET_BAG = 3;
  const GET_ENTRY = 4;
  const GET_GETTER = 5;
  setFn(
    ERROR_PROP_GET,
    [
      { name: "any", type: ANY },
      { name: "bag", type: EXT },
      { name: "entry", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
      { name: "getter", type: EXT },
    ],
    [
      ...requireError(2, nullMiss()),
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: lookupIdx },
      { op: "local.tee", index: GET_BAG },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: nullMiss() },
      { op: "local.get", index: GET_BAG },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: GET_ENTRY },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: nullMiss() },
      { op: "local.get", index: GET_ENTRY },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: FLAG_ACCESSOR },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: GET_ENTRY },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
          { op: "extern.convert_any" },
          { op: "local.tee", index: GET_GETTER },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [...(undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" }]), { op: "return" }],
          },
          { op: "local.get", index: 0 },
          { op: "local.get", index: GET_GETTER },
          { op: "call", funcIdx: callGetIdx },
          { op: "return" },
        ],
      },
      { op: "local.get", index: GET_ENTRY },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
      { op: "extern.convert_any" },
    ],
  );

  const SET_BAG = 4;
  const SET_ENTRY = 5;
  const SET_SETTER = 6;
  const sharedSetAvailable = setDecideIdx !== undefined && setOwnIdx !== undefined && setResultGlobalIdx !== undefined;
  setFn(
    ERROR_PROP_SET,
    sharedSetAvailable
      ? [
          { name: "any", type: ANY },
          { name: "bag", type: EXT },
          { name: "decision", type: I32 },
        ]
      : [
          { name: "any", type: ANY },
          { name: "bag", type: EXT },
          { name: "entry", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
          { name: "setter", type: EXT },
        ],
    sharedSetAvailable
      ? [
          ...requireError(3, [{ op: "return" }]),
          // Query the existing own bag first.  The shared decision receives
          // this nullable layer and only an allowed miss may ensure it.
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: lookupIdx },
          { op: "local.set", index: 4 },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 4 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: setDecideIdx! },
          { op: "local.tee", index: 5 },
          { op: "i32.const", value: 2 }, // SET_DECISION_HANDLED
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 1 }, { op: "global.set", index: setResultGlobalIdx! }, { op: "return" }],
          },
          { op: "local.get", index: 5 },
          { op: "i32.const", value: 3 }, // SET_DECISION_REFUSED
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 2 }, { op: "global.set", index: setResultGlobalIdx! }, { op: "return" }],
          },
          { op: "local.get", index: 4 },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: ensureIdx },
              { op: "local.set", index: 4 },
            ],
          },
          { op: "local.get", index: 4 },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "empty" },
            // A missing side-bag allocation is an unadmitted
            // representation boundary, not an OrdinarySet refusal.
            then: [{ op: "return" }],
          },
          { op: "local.get", index: 4 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: setOwnIdx! },
          { op: "global.set", index: setResultGlobalIdx! },
        ]
      : [
          ...requireError(3, [{ op: "return" }]),
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: ensureIdx },
          { op: "local.tee", index: SET_BAG },
          { op: "ref.is_null" },
          { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
          { op: "local.get", index: SET_BAG },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: objFindIdx },
          { op: "local.tee", index: SET_ENTRY },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: SET_ENTRY },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
              { op: "i32.const", value: FLAG_ACCESSOR },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: SET_ENTRY },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
                  { op: "extern.convert_any" },
                  { op: "local.tee", index: SET_SETTER },
                  { op: "ref.is_null" },
                  { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: SET_SETTER },
                  { op: "local.get", index: 2 },
                  { op: "call", funcIdx: callSetIdx },
                  { op: "return" },
                ],
              },
            ],
          },
          { op: "local.get", index: SET_BAG },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: externSetIdx },
        ],
  );
}
