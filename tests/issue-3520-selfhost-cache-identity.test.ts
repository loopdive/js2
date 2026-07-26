// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { buildSelfHostedIr, type SelfHostedFuncDef } from "../src/codegen/stdlib-selfhost.js";
import { irVal } from "../src/ir/nodes.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const F64 = irVal({ kind: "f64" });
const irIdentities = createTestIrFunctionIdentityFactory("issue-3520-selfhost-cache-identity");
const CACHE_FIRST_ID = irIdentities.unit(0);
const CACHE_SECOND_ID = irIdentities.unit(1);
const ELIGIBILITY_SEED_ID = irIdentities.unit(2);
const RESOLVER_REJECT_ID = irIdentities.unit(3);
const TYPE_INDEX_REJECT_ID = irIdentities.unit(4);
const CONTEXT_FIRST_ID = irIdentities.unit(5);
const CONTEXT_SECOND_ID = irIdentities.unit(6);
const FINGERPRINT_FIRST_ID = irIdentities.unit(7);
const FINGERPRINT_SECOND_ID = irIdentities.unit(8);

describe("#3520 self-host cache eligibility", () => {
  it("materializes a fresh artifact with the requested identity on every cache hit", () => {
    const def: SelfHostedFuncDef = {
      name: "__issue3520_context_free",
      source: "export function __issue3520_context_free(value: number): number { return value + 1; }",
      paramTypes: [F64],
      returnType: F64,
      calleeTypes: new Map(),
      memoKey: "issue-3520/cache-identity/v1",
    };

    const first = buildSelfHostedIr(def, CACHE_FIRST_ID);
    const second = buildSelfHostedIr(def, CACHE_SECOND_ID);

    expect(first).not.toBe(second);
    expect(first.unitId).toBe(CACHE_FIRST_ID);
    expect(second.unitId).toBe(CACHE_SECOND_ID);
    expect(second.blocks).toBe(first.blocks);
  });

  it("rejects resolver and type-index ineligibility before consulting an existing cache entry", () => {
    const def: SelfHostedFuncDef = {
      name: "__issue3520_eligibility",
      source: "export function __issue3520_eligibility(value: number): number { return value; }",
      paramTypes: [F64],
      returnType: F64,
      calleeTypes: new Map(),
      memoKey: "issue-3520/eligibility-before-cache/v1",
    };
    buildSelfHostedIr(def, ELIGIBILITY_SEED_ID);

    expect(() => buildSelfHostedIr(def, RESOLVER_REJECT_ID, {})).toThrow(
      "sets memoKey but was built with a ctx-bound resolver",
    );
    expect(() =>
      buildSelfHostedIr(
        {
          ...def,
          paramTypes: [irVal({ kind: "ref_null", typeIdx: 41 })],
          returnType: irVal({ kind: "ref_null", typeIdx: 41 }),
        },
        TYPE_INDEX_REJECT_ID,
      ),
    ).toThrow("sets memoKey but carries a context-relative type index");
  });

  it("keeps nonmemoized context-relative artifacts distinct", () => {
    const makeDef = (typeIdx: number): SelfHostedFuncDef => ({
      name: "__issue3520_context_bound",
      source: "export function __issue3520_context_bound(value: unknown): unknown { return value; }",
      paramTypes: [irVal({ kind: "ref_null", typeIdx })],
      returnType: irVal({ kind: "ref_null", typeIdx }),
      calleeTypes: new Map(),
    });

    const first = buildSelfHostedIr(makeDef(41), CONTEXT_FIRST_ID);
    const second = buildSelfHostedIr(makeDef(99), CONTEXT_SECOND_ID);

    expect(first).not.toBe(second);
    expect(first.unitId).toBe(CONTEXT_FIRST_ID);
    expect(second.unitId).toBe(CONTEXT_SECOND_ID);
    expect(first.params[0]?.type).toEqual(irVal({ kind: "ref_null", typeIdx: 41 }));
    expect(second.params[0]?.type).toEqual(irVal({ kind: "ref_null", typeIdx: 99 }));
    expect(first.resultTypes).toEqual([irVal({ kind: "ref_null", typeIdx: 41 })]);
    expect(second.resultTypes).toEqual([irVal({ kind: "ref_null", typeIdx: 99 })]);
  });

  it("rejects memo-key fingerprint collisions", () => {
    const first: SelfHostedFuncDef = {
      name: "__issue3520_fingerprint",
      source: "export function __issue3520_fingerprint(value: number): number { return value; }",
      paramTypes: [F64],
      returnType: F64,
      calleeTypes: new Map(),
      memoKey: "issue-3520/fingerprint-collision/v1",
    };
    const collision: SelfHostedFuncDef = {
      ...first,
      source: "export function __issue3520_fingerprint(value: number): number { return value + 1; }",
    };

    buildSelfHostedIr(first, FINGERPRINT_FIRST_ID);
    expect(() => buildSelfHostedIr(collision, FINGERPRINT_SECOND_ID)).toThrow("was reused for a different template");
  });
});
