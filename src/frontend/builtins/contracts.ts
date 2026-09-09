// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrType } from "../../ir/core/types.js";

/**
 * #3161 — a self-hosted builtin with an explicit typed signature. The
 * generalized shape behind the `StdlibMathBuiltin` pilot descriptor:
 * positional param types + a typed callee map instead of the pilot's
 * implicit "everything is unary f64".
 *
 * `paramTypes` is positional and override-authoritative: a param whose
 * type has no TS-primitive spelling (externref, `ref_null { typeIdx }`)
 * should be annotated `unknown` in `source` — from-ast's `resolveIrType`
 * defers non-primitive annotations to the override, and REJECTS a
 * primitive annotation that disagrees with it (typo guard).
 * `returnType: null` means void (zero Wasm results; bare `return;` /
 * fall-through tails, statement-position calls only — #1228 / #2856 C4).
 */
export interface SelfHostedFuncDef {
  /** funcMap registration name — also the function's name in `source`. */
  readonly name: string;
  /** Ordinary TS source, IR-claimable subset. */
  readonly source: string;
  /** Positional param IrTypes (may carry ctx-bound typeIdx refs). */
  readonly paramTypes: readonly IrType[];
  /** Return IrType; null == void. */
  readonly returnType: IrType | null;
  /** Typed signatures for every direct callee in `source`. */
  readonly calleeTypes: ReadonlyMap<string, { params: readonly IrType[]; returnType: IrType | null }>;
  /**
   * Optional process-lifetime memo key. Set ONLY for a CONTEXT-FREE def —
   * one whose `paramTypes` / `returnType` / callee sigs carry no ctx-bound
   * `{ typeIdx }` ref (all abstract scalars / string / externref). The
   * memoized `IrFunction` is shared across every compilation, so a def with
   * a ctx-relative type must NOT set this (its typeIdx would leak across
   * contexts). The math family (all `(f64) -> f64`) sets it (keyed by
   * builtin name); the generalized families (raw-array/typeIdx params)
   * leave it unset and rebuild per emission — bounded to once per
   * compilation by `emitSelfHostedFunc`'s funcMap early-return.
   */
  readonly memoKey?: string;
  /**
   * (#3256 Tier-1) Opt-in from-ast dialect for the STRING family: installs a
   * context-free native-strings `stringMethodPlan` resolver at BUILD time so
   * the source may use string method syntax (`s.charCodeAt(i)`,
   * `s.substring(a, b)`) and string-typed params/locals. When emitted through
   * `emitSelfHostedFunc`, the build resolver ALSO carries the live ctx's
   * `resolveString()` (mutated string `let`s bind as slots whose Wasm-local
   * type is the ctx-bound `(ref $AnyString)`), so dialect defs must NOT set
   * `memoKey` — the baked slot typeIdx is only meaningful in the registering
   * CodegenContext. Families that don't set this build exactly as before (no
   * resolver — any accidental string-method use remains a loud error), which
   * keeps the math/timsort/object defs byte-inert by construction.
   */
  readonly dialect?: "native-strings";
}
