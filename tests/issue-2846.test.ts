// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2846 — compiled-acorn corrupted BigInt literals (parsed/marshalled as f64,
// losing the value AND the `bigint` digit string past 2^53).
//
// Root cause: the function-type dedup key (`funcTypeKey`) and equality
// (`valTypeEq`) in `src/codegen/registry/types.ts` IGNORED the `bigint` flag on
// `{ kind: "i64"; bigint?: boolean }`. A bigint-returning function (acorn's
// `stringToBigInt`, signature `(externref) -> i64:big`) therefore DEDUPLICATED
// onto a previously-registered plain `(externref) -> i64` FuncTypeDef. At the
// call site `getWasmFuncReturnType` then read `results[0]` from that shared,
// UNBRANDED def and handed the caller a plain i64, which boxed to the host via
// `__box_number` (`f64.convert_i64_s`) → precision loss past 2^53
// (`9007199254740993n` → `9007199254740992`). acorn derives the node's `bigint`
// STRING field from that rounded number, so both reported symptoms share the
// one root cause. This is the SAME brand-propagation hole #2795 fixed for the
// boolean/symbol i32 brand, one Wasm slot down.
//
// Fix (2 LOC): emit a distinct `:big` dedup-key suffix for a bigint-branded i64
// in `funcTypeKey`, and add an i64 `bigint`-brand equality check to `valTypeEq`
// so structural-match callers do not re-merge the two.
//
// The unit test below pins the dedup chokepoint directly: a branded i64 result
// must NOT collapse onto a plain i64 result. (On unfixed `main` they share a
// type index — the exact collision that corrupted the value.) The end-to-end
// cases guard BigInt round-trips through the codegen.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { createEmptyModule, type ValType } from "../src/ir/types.js";
import { createCodegenContext } from "../src/codegen/index.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import { compileAndInstantiate } from "../src/runtime.js";

function makeDummyChecker(): ts.TypeChecker {
  return {} as unknown as ts.TypeChecker;
}

describe("#2846 bigint-branded i64 func-type stays distinct in dedup", () => {
  it("a branded (externref)->i64:big result does NOT dedup onto plain (externref)->i64", () => {
    const ctx = createCodegenContext(createEmptyModule(), makeDummyChecker());
    const params: ValType[] = [{ kind: "externref" }];
    const plain: ValType[] = [{ kind: "i64" }];
    const branded: ValType[] = [{ kind: "i64", bigint: true } as ValType];

    const plainIdx = addFuncType(ctx, params, plain, "plain_i64");
    const brandedIdx = addFuncType(ctx, params, branded, "bigint_i64");

    // On unfixed main these collapse to the SAME index (brand-blind key) — the
    // collision that made getWasmFuncReturnType return a plain i64 for acorn's
    // stringToBigInt. With the fix they are distinct FuncTypeDefs.
    expect(brandedIdx).not.toBe(plainIdx);

    // The branded def must actually carry the brand on its result ValType.
    const brandedDef = ctx.mod.types[brandedIdx];
    expect(brandedDef?.kind).toBe("func");
    if (brandedDef?.kind === "func") {
      expect(brandedDef.results[0]?.kind).toBe("i64");
      expect((brandedDef.results[0] as { bigint?: boolean }).bigint).toBe(true);
    }
  });

  it("re-registering the SAME branded i64 signature is still deduped (idempotent)", () => {
    const ctx = createCodegenContext(createEmptyModule(), makeDummyChecker());
    const params: ValType[] = [{ kind: "externref" }];
    const branded: ValType[] = [{ kind: "i64", bigint: true } as ValType];
    const a = addFuncType(ctx, params, branded, "b1");
    const b = addFuncType(ctx, params, branded, "b2");
    expect(b).toBe(a);
  });

  it("native plain i64 signatures keep deduping unchanged (no brand growth)", () => {
    const ctx = createCodegenContext(createEmptyModule(), makeDummyChecker());
    const params: ValType[] = [{ kind: "i64" }];
    const plain: ValType[] = [{ kind: "i64" }];
    const a = addFuncType(ctx, params, plain, "p1");
    const b = addFuncType(ctx, params, plain, "p2");
    expect(b).toBe(a);
  });
});

describe("#2846 BigInt values round-trip exact (no f64 precision loss)", () => {
  // 9007199254740993 === 2^53 + 1 — the smallest integer float64 cannot
  // represent; rounding to ...992 is the tell-tale that the value passed
  // through an f64 during marshalling.
  const HARD = "9007199254740993";

  it("a BigInt literal past 2^53 stored in an `any` field is exact", async () => {
    const ex = (await compileAndInstantiate(`
      export function test(): any {
        const n: any = {};
        n.value = 9007199254740993n;
        return n.value;
      }
    `)) as { test(): unknown };
    const v = ex.test();
    expect(typeof v).toBe("bigint");
    expect((v as bigint).toString()).toBe(HARD);
  });

  it("BigInt(string) returned from a function preserves the value and the brand", async () => {
    const ex = (await compileAndInstantiate(`
      function toBig(s: string): bigint { return BigInt(s); }
      export function value(): bigint { return toBig("${HARD}"); }
      export function isBig(): boolean { return typeof toBig("5") === "bigint"; }
    `)) as { value(): unknown; isBig(): unknown };
    const v = ex.value();
    expect(typeof v).toBe("bigint");
    expect((v as bigint).toString()).toBe(HARD);
    // The brand surviving the function return means typeof reads "bigint".
    expect(Boolean(ex.isBig())).toBe(true);
  });

  it("keeps arbitrary-width BigInt exact across a nullable function return", async () => {
    const huge = "340282366920938463463374607431768211456";
    const ex = (await compileAndInstantiate(`
      function stringToBigInt(s: string) {
        if (s.length === 0) return null;
        return BigInt(s);
      }

      export function value(): any {
        return stringToBigInt("${huge}");
      }

      export function missing(): any {
        return stringToBigInt("");
      }
    `)) as { value(): unknown; missing(): unknown };

    expect(ex.value()).toBe(BigInt(huge));
    expect(ex.missing()).toBeNull();
  });
});
