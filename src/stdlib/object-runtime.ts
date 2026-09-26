// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Self-hosted Object-runtime builtins (#3160 — porffor model, object family
 * slice 1). Ordinary TS source in the IR-claimable subset, compiled through
 * the compiler's own pipeline by the generalized driver
 * (`src/codegen/stdlib-selfhost.ts`) and registered where the hand-emitted
 * `Instr[]` bodies used to be pushed (`ensureObjectRuntime`).
 *
 * SLICE SCOPE — the two PUREST helpers: thin compositions over funcMap
 * helpers registered earlier (`__new_plain_object`, `__extern_length`,
 * `__extern_get_idx`, `__extern_set`, `__getOwnPropertyNames`,
 * `__getOwnPropertyDescriptor`) with NO `$Object`/`$PropEntry` struct access
 * or identity/proto/MOP entanglement. Deeper helpers (assign's raw-table
 * walk, Object.is SameValue, integrity predicates) stay hand-written — they
 * need Precursor D (typed struct intrinsics), a later slice per
 * `plan/self-hosting-scale-up.md` (family #8).
 *
 * DIALECT: externref params/returns have no TS-primitive spelling → annotate
 * `unknown` (the driver's `paramTypes`/`returnType` overrides are
 * authoritative — from-ast defers non-primitive annotations). Loop
 * counters/lengths are `: number` (f64); `__extern_get_idx` takes the f64
 * index directly (the hand bodies passed `f64.convert_i32_s(i)` — an f64
 * counter is the identical value). Every callee is registered before emit
 * (leaf-first). Behaviour mirrors the deleted hand bodies step-for-step
 * (same enumeration order, same per-key `__extern_set`); verified by
 * tests/issue-3160.test.ts + #2042 suites, host byte-inert.
 */

import type { SelfHostedFuncDef } from "../codegen/stdlib-selfhost.js";
import { irVal, type IrType } from "../ir/nodes.js";

const EXT: IrType = irVal({ kind: "externref" });
const F64: IrType = irVal({ kind: "f64" });

type Sig = { params: readonly IrType[]; returnType: IrType | null };

/**
 * Shared iteration/composition callees. `__extern_set` is VOID (returns
 * `null`); the numeric index into `__extern_get_idx` is f64 (declare it f64
 * — the driver validates call args by exact IrType equality).
 */
const COMMON_CALLEES: ReadonlyArray<[string, Sig]> = [
  ["__new_plain_object", { params: [], returnType: EXT }],
  ["__extern_length", { params: [EXT], returnType: F64 }],
  ["__extern_get_idx", { params: [EXT, F64], returnType: EXT }],
  ["__extern_set", { params: [EXT, EXT, EXT], returnType: null }],
];

/**
 * `Object.getOwnPropertyDescriptors(obj)` — a fresh plain object mapping each
 * own key to its descriptor. Enumerates own keys via
 * `__getOwnPropertyNames` and, per key, sets
 * `out[key] = __getOwnPropertyDescriptor(obj, key)`.
 *
 * (#6651 H3) …then the SYMBOL keys, via `__getOwnPropertySymbols`. §20.1.2.9
 * step 3 walks `? O.[[OwnPropertyKeys]]()`, which is OrdinaryOwnPropertyKeys —
 * integer indices, then strings in creation order, then SYMBOLS in creation
 * order. Only the string half was walked, so an object whose own keys are all
 * symbols produced `{}`: measured standalone, `Reflect.ownKeys(gOPDs(obj))` was
 * `[]` where the spec wants `[symA, symB]`. The two loops in this order ARE
 * that key order, and the singular `__getOwnPropertySymbols` is already the
 * carrier-correct reader (#2866 PR1), so no new symbol machinery is introduced.
 * A non-object receiver
 * yields `{}` (the loop runs zero times — `__getOwnPropertyNames` returns an
 * empty vec). Same enumeration + per-key descriptor builder as the singular
 * `getOwnPropertyDescriptor`, so accessor-vs-data shape and attribute flags
 * stay consistent.
 */
const GET_OWN_PROPERTY_DESCRIPTORS_SOURCE = `
export function __object_getOwnPropertyDescriptors(obj: unknown): unknown {
  const out = __new_plain_object();
  const names = __getOwnPropertyNames(obj);
  const cap: number = __extern_length(names);
  let i: number = 0;
  while (i < cap) {
    const key = __extern_get_idx(names, i);
    __extern_set(out, key, __getOwnPropertyDescriptor(obj, key));
    i = i + 1;
  }
  const syms = __getOwnPropertySymbols(obj);
  const scap: number = __extern_length(syms);
  let j: number = 0;
  while (j < scap) {
    const skey = __extern_get_idx(syms, j);
    __extern_set(out, skey, __getOwnPropertyDescriptor(obj, skey));
    j = j + 1;
  }
  return out;
}
`;

/**
 * `Object.fromEntries(entries)` where `entries` is a `$ObjVec` of `[key,value]`
 * pair `$ObjVec`s (the call site normalises a literal array-of-pairs into this
 * indexable shape before calling). Builds a fresh plain object and, per pair,
 * sets `out[pair[0]] = pair[1]` via `__extern_set` (which ToPropertyKeys the
 * key). Iterates via `__extern_length` / `__extern_get_idx`.
 */
const FROM_ENTRIES_SOURCE = `
export function __object_fromEntries(entries: unknown): unknown {
  const out = __new_plain_object();
  const len: number = __extern_length(entries);
  let i: number = 0;
  while (i < len) {
    const pair = __extern_get_idx(entries, i);
    const key = __extern_get_idx(pair, 0);
    const val = __extern_get_idx(pair, 1);
    __extern_set(out, key, val);
    i = i + 1;
  }
  return out;
}
`;

/**
 * The self-hosted object-runtime slice-1 builtins, keyed by funcMap name.
 * `ensureObjectRuntime` emits each via `emitSelfHostedFunc(ctx, def)` in place
 * of the deleted hand body, AFTER the six shared callees are registered.
 */
export const SELF_HOSTED_OBJECT_RUNTIME: ReadonlyMap<string, SelfHostedFuncDef> = new Map([
  [
    "__object_getOwnPropertyDescriptors",
    {
      name: "__object_getOwnPropertyDescriptors",
      source: GET_OWN_PROPERTY_DESCRIPTORS_SOURCE,
      paramTypes: [EXT],
      returnType: EXT,
      calleeTypes: new Map<string, Sig>([
        ...COMMON_CALLEES,
        ["__getOwnPropertyNames", { params: [EXT], returnType: EXT }],
        ["__getOwnPropertySymbols", { params: [EXT], returnType: EXT }],
        ["__getOwnPropertyDescriptor", { params: [EXT, EXT], returnType: EXT }],
      ]),
    },
  ],
  [
    "__object_fromEntries",
    {
      name: "__object_fromEntries",
      source: FROM_ENTRIES_SOURCE,
      paramTypes: [EXT],
      returnType: EXT,
      calleeTypes: new Map<string, Sig>(COMMON_CALLEES),
    },
  ],
]);
