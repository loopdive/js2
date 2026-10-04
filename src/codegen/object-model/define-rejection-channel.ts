// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6770 S4) The boolean FAILURE channel of [[DefineOwnProperty]] for the
 * standalone descriptor appliers.
 *
 * The native `__defineProperty_value` / `__defineProperty_accessor` (the
 * `Object.defineProperty` MOP) run ValidateAndApplyPropertyDescriptor
 * (§10.1.6.3) and THROW a TypeError on every rejection — which is exactly
 * `Object.defineProperty`'s §20.1.2.4 step 5 (`? DefinePropertyOrThrow`). But
 * `Reflect.defineProperty` (§28.1.3 step 4) must RETURN the boolean instead:
 *
 * ```js
 * var o = {}; o.p2 = 42; Object.freeze(o);
 * Reflect.defineProperty(o, "p2", {value: 43});   // main: throws TypeError   spec: false
 * ```
 *
 * A separate "would this be rejected?" predicate would duplicate the whole
 * §10.1.6.3 decision tree (and drift from it). Instead the appliers keep
 * throwing, and every rejection PARKS its TypeError in one module global
 * right before the throw (`descriptorTypeError`'s `rejectionGlobal`,
 * ordinary-object-descriptor-common.ts). A caller that wants the boolean wraps
 * the applier call in {@link catchDefineRejectionAsFalse}: it clears the global,
 * runs the call, and on a caught exception answers `false` only when the
 * payload IS the parked TypeError; anything else — a descriptor getter's own
 * throw during ToPropertyDescriptor, a proxy trap's — is rethrown untouched.
 * The identity test (not "is the global set") keeps a nested define that was
 * rejected and caught inside a user getter from turning an unrelated later
 * throw into `false`.
 *
 * Reusable: any caller of an applier that owes a boolean (`Reflect.set`'s
 * define step, the #6771 Array `CreateDataProperty` sites) wraps the same way.
 * Standalone only; the host lane's appliers are JS imports.
 */
import type { Instr } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { ensureExnTag } from "../registry/physical-imports.js";
import { bound } from "./ports.js"; // (#6770/#6797) core helpers, injected — keeps this leaf out of the import SCC

const buildStandardTryTable = bound("buildStandardTryTable");
const ensureExternStrictEqHelper = bound("ensureExternStrictEqHelper");
const nextModuleGlobalIdx = bound("nextModuleGlobalIdx");

const GLOBAL_NAME = "__define_rejection";

/**
 * The global's CURRENT absolute index, resolved by name at every call — never
 * cached: a later import-global insertion shifts module globals, and a cached
 * index is the stale-slot bug `fixupModuleGlobalIndices` lists six times.
 */
function rejectionGlobalIdx(ctx: CodegenContext): number | undefined {
  const pos = ctx.mod.globals.findIndex((g) => g.name === GLOBAL_NAME);
  return pos < 0 ? undefined : ctx.numImportGlobals + pos;
}

/** The externref global a rejected define parks its TypeError in (standalone only). */
export function ensureDefineRejectionGlobal(ctx: CodegenContext): number | undefined {
  if (!ctx.standalone) return undefined;
  const existing = rejectionGlobalIdx(ctx);
  if (existing !== undefined) return existing;
  const idx = nextModuleGlobalIdx(ctx);
  ctx.mod.globals.push({
    name: GLOBAL_NAME,
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  return idx;
}

/**
 * `Reflect.defineProperty`'s boolean over an applier call already emitted at
 * `fctx.body[applierStart..]` (leaving the applier's externref): lift it out,
 * append the truthiness test (a `$Proxy` trap's booleanish result, else the always
 * truthy receiver) and re-emit it inside the rejection catch. Returns false —
 * having changed nothing — when the channel is unavailable.
 */
export function definePropertyBooleanFrom(
  ctx: CodegenContext,
  fctx: FunctionContext,
  applierStart: number,
  isTruthyIdx: number | undefined,
): boolean {
  if (!ctx.standalone || isTruthyIdx === undefined || rejectionGlobalIdx(ctx) === undefined) return false;
  const call = fctx.body.splice(applierStart);
  call.push({ op: "call", funcIdx: isTruthyIdx });
  fctx.body.push(...catchDefineRejectionAsFalse(ctx, fctx, call));
  return true;
}

/**
 * Wrap `call` — instructions leaving the i32 `true` of a define that did not
 * throw — so a define REJECTION answers `0`. Returns `call` unchanged when the
 * channel is unavailable (non-standalone, or no strict-equality helper).
 */
function catchDefineRejectionAsFalse(ctx: CodegenContext, fctx: FunctionContext, call: Instr[]): Instr[] {
  const globalIdx = rejectionGlobalIdx(ctx);
  const strictEqIdx = ensureExternStrictEqHelper(ctx);
  if (globalIdx === undefined || strictEqIdx === undefined) return call;
  const tagIdx = ensureExnTag(ctx);
  const result = allocLocal(fctx, `__defrej_r_${fctx.locals.length}`, { kind: "i32" });
  const payload = allocLocal(fctx, `__defrej_e_${fctx.locals.length}`, { kind: "externref" });
  return [
    { op: "ref.null.extern" },
    { op: "global.set", index: globalIdx },
    buildStandardTryTable(
      { kind: "empty" },
      [...call, { op: "local.set", index: result }],
      [
        {
          kind: "catch",
          tagIdx,
          payloadType: { kind: "externref" },
          body: [
            { op: "local.tee", index: payload },
            { op: "global.get", index: globalIdx },
            { op: "call", funcIdx: strictEqIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "i32.const", value: 0 },
                { op: "local.set", index: result },
              ],
              else: [
                { op: "local.get", index: payload },
                { op: "throw", tagIdx },
              ],
            },
          ],
        },
      ],
    ),
    { op: "local.get", index: result },
  ];
}
