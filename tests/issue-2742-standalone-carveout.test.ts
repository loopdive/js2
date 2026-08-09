// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2742) Standalone `String.prototype` superseded-wiring carve-out.
 *
 * The #2875 reflective member bodies intercept ahead of #3254's corrected
 * borrowed-receiver path. For five members that interception is strictly worse,
 * so `emitStringProtoMemberBody` refuses them and lets the caller fall through.
 *
 * These tests pin the SHAPE of that decision, not the test262 counts:
 *  - the five carve-out members must reach the corrected path (measured +18/-0);
 *  - the eight deliberately-excluded members must STAY wired, because their
 *    wired bodies carry `RequireObjectCoercible` that legacy lacks — unwiring
 *    them regressed 13 test262 files (5 `*-not-obj-coercible`, 8 trimStart/
 *    trimEnd this-value files).
 *
 * If someone "simplifies" the member set, the second block below fails first.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../src/codegen/array-object-proto.ts", import.meta.url)), "utf-8");

function carveOutSet(): Set<string> {
  const m = /SUPERSEDED_BY_BORROWED_PATH\s*=\s*new Set\(\[([^\]]*)\]\)/.exec(SRC);
  if (!m?.[1]) throw new Error("SUPERSEDED_BY_BORROWED_PATH not found — did the carve-out move?");
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1] as string));
}

describe("#2742 standalone String.prototype superseded-wiring carve-out", () => {
  it("carves out exactly the five members the A/B measured as +18/-0", () => {
    // Measured over 450 String/prototype files, same box/run/list, both arms
    // from one tree: +18 fail->pass, 0 pass->fail, 0 off-target moves.
    expect([...carveOutSet()].sort()).toEqual(["codePointAt", "endsWith", "includes", "startsWith", "trim"].sort());
  });

  it("keeps every member whose wired body is still load-bearing", () => {
    const set = carveOutSet();
    // Unwiring ANY of these regressed test262 in the measured A/B:
    //   charCodeAt / indexOf / lastIndexOf / trimStart / trimEnd
    //     -> `this-value-not-obj-coercible` (wired body does
    //        RequireObjectCoercible; the legacy path does not)
    //   trimStart / trimEnd
    //     -> this-value-{boolean,number,whitespace,line-terminator}
    //   at / substring / charAt -> no signal or bespoke body
    for (const member of [
      "charCodeAt",
      "indexOf",
      "lastIndexOf",
      "trimStart",
      "trimEnd",
      "at",
      "substring",
      "charAt",
    ]) {
      expect(set.has(member), `${member} must stay wired — see the #2742 A/B ledger`).toBe(false);
    }
  });

  it("routes the carve-out members through the refusal, not a native body", () => {
    // The refusal return is what makes the caller fall through to #3254's
    // receiverOverride; a wired body would intercept instead.
    expect(SRC).toMatch(
      /SUPERSEDED_BY_BORROWED_PATH\.has\(member\)\)\s*return emitProtoMemberBodyRefusal\(ctx, fctx, "String", member\)/,
    );
  });

  it("does not leave the experimental kill switch in the tree", () => {
    // The env-gated switch was scaffolding for the A/B arms; arm D re-ran the
    // whole 450 with it deleted and matched arm C on 450/450 files.
    expect(SRC).not.toMatch(/JS2WASM_KILL_STRING_WIRING/);
  });
});
