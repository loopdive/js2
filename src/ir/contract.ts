// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ---------------------------------------------------------------------------
// The IR interchange contract — v5.1 surface (#3030-T1/#3520/#3521).
//
// NORMATIVE artifacts (this module is their code-side anchor):
//   - docs/ir/ir-contract.md          the contract: D1–D5, guarantees,
//                                     node inventory + type rules,
//                                     versioning policy
//   - docs/ir/ir-module.schema.json   JSON Schema for one serialized module
//
// This module deliberately contains ONLY the version constant and the
// document-header / coverage-manifest types — the parts every consumer and
// the (T3) serializer share. The serializer itself (`serializeIrModule` /
// `deserializeIrModule`, `--emit-ir`) is #3030-T3; the verifier-side type
// re-derivation is #3030-T4. Nothing in the compiler imports this module
// yet; it is the frozen surface those slices implement against.
// ---------------------------------------------------------------------------

import type { IrUnitId } from "./identity.js";

/**
 * The IR interchange format version (#3030 D2).
 *
 * - ADDITIVE changes (new node kinds, new optional fields, new enum members
 *   appended at the END of their table) bump the MINOR version.
 * - BREAKING changes (removing/renaming a field or kind, reordering an enum
 *   table, changing a serialized representation) bump the MAJOR version.
 * - Every enum table in the contract (`JsTag`, `IrBinop`/`IrUnop`, effect
 *   facets, IrType kinds, instruction kinds) is APPEND-ONLY with FROZEN
 *   ORDER (the #1852 linear-tag-enum discipline).
 * - The (T5) CI schema snapshot fails any PR that changes the serialized
 *   shape without bumping this constant.
 */
export const IR_FORMAT_VERSION = "5.1";

/**
 * Which pipeline compiled a function's body (#3030 D3.7 — the complete
 * coverage manifest). `"ir"` bodies are serialized under the full contract
 * guarantees; `"legacy"` bodies are compiled by the direct AST→Wasm path
 * (or contain a `raw.wasm` bridge, which embeds backend ops that D4 forbids
 * serializing) and appear in the manifest WITHOUT a serialized body, so a
 * consumer knows exactly what it can analyze. Coverage grows with
 * #2855/#2950/#2949; the contract does not wait for 100%.
 */
export type IrCarrier = "ir" | "legacy";

/** One function's row in the module coverage manifest (#3030 D3.7). */
export interface IrCoverageEntry {
  readonly unitId: IrUnitId;
  /** Compatibility/debug label; structural references never use it as identity. */
  readonly name: string;
  readonly carrier: IrCarrier;
  readonly exported: boolean;
  /**
   * Present iff `carrier === "legacy"`: the machine-readable reason the body
   * is not IR-carried (an ir-fallback bucket name from
   * scripts/ir-fallback-baseline.json, or `"raw-wasm-bridge"` for IR bodies
   * excluded by the D4 raw.wasm rule).
   */
  readonly reason?: string;
}
