// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6651 slice V0 — the remaining `bfnid` exact-identity sites take U1b's
 * linked-module signature guard.
 *
 * U1b (PR #6525) found that a `bfnid` is a MODULE-LOCAL type index: in a
 * canonically linked module (`canonicalRuntimeRecGroup`, e.g. the standalone
 * Temporal provider and its consumer) a peer's builtin closure passes the
 * structural family `ref.test`, and its `bfnid` — the PEER's own type index —
 * can equal one of ours. U1b guarded the three `transferred-native-proto.ts`
 * arms; this slice routes the other four compare sites through the same
 * `linkedSignatureGuard` (now in `builtin-fn-meta.ts`):
 *
 *  1. `char-at-transfer.ts` — the transferred `String.prototype.<m>` arm of
 *     `__apply_closure`. It used to call the LOCAL member body on a match, so
 *     linked it now also calls THROUGH field 0 (the peer's own function).
 *  2. `apply-closure-variadic-builtin.ts` — the `Math.max`/`Math.min`/
 *     `String.fromCharCode` identity in `__apply_closure`.
 *  3. `object-runtime.ts` — `exactMetaArm`, shared by `__builtinfn_get_meta`
 *     / `_gopd` / `_delete` / `_push_ownnames` (pinned on `get_meta`, the one
 *     the probes keep live; the others are the same factory).
 *  4. `ta-dyn-mop.ts` — the dyn-view [[Get]] refusal-closure filter in
 *     `__extern_get`.
 *
 * Each site is checked twice: linked ⇒ every compare is followed by the guard;
 * unlinked ⇒ none is (unlinked bytes unchanged). Eval-free, no imports.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function build(source: string, linked: boolean): Promise<{ wat: string; run: unknown }> {
  const result = await compile(source, {
    target: "standalone",
    skipSemanticDiagnostics: true,
    emitWat: true,
    canonicalRuntimeTypes: linked,
  } as never);
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return { wat: (result as { wat?: string }).wat ?? "", run: (instance.exports.run as () => unknown)() };
}

/** Whitespace-normalised body of `(func $<name> …)`. */
function funcBody(wat: string, name: string): string {
  const start = wat.indexOf(`(func $${name} `);
  expect(start, `${name} present`).toBeGreaterThanOrEqual(0);
  const end = wat.indexOf("\n  (func ", start + 1);
  return wat.slice(start, end < 0 ? undefined : end).replace(/\s+/g, " ");
}

/** The guard as `linkedSignatureGuard` emits it, cast to type `T` (group 1 of the caller). */
const guard = (self: string, cast: string): string =>
  `(?: ${self} ref\\.cast \\(ref ${cast}\\) struct\\.get ${cast} 0 ref\\.test \\(ref \\d+\\) i32\\.and)?`;

function countArms(body: string, re: RegExp, guardGroup: number): { arms: number; guarded: number } {
  let arms = 0;
  let guarded = 0;
  for (const match of body.matchAll(re)) {
    arms++;
    if (match[guardGroup]) guarded++;
  }
  return { arms, guarded };
}

const SELF0 = "local\\.get 0 any\\.convert_extern";

describe("#6651 V0 — site 1: transferred String.prototype arm of __apply_closure", () => {
  const SOURCE = `
    export function run(): number {
      const o: any = { v: 1 };
      o.p = String.prototype.charAt;
      const r: any = o.p.call("abc", 1);
      return r === "b" ? 1 : 0;
    }`;
  // bfnid compare, optional guard, then the arm's own `if` (not an i32 result).
  const ARM = new RegExp(
    `struct\\.get (\\d+) 4 i32\\.const \\1 i32\\.eq(${guard(SELF0, "\\1")}) \\(if \\(then ([^]*?) return`,
    "g",
  );
  function arms(wat: string): { arms: number; guarded: number; callRef: number } {
    const body = funcBody(wat, "__apply_closure");
    let callRef = 0;
    for (const m of body.matchAll(ARM)) if (/call_ref/.test(m[3]!)) callRef++;
    return { ...countArms(body, ARM, 2), callRef };
  }

  it("linked: guarded, and the matched closure is called through its own field 0", async () => {
    const { wat, run } = await build(SOURCE, true);
    const a = arms(wat);
    expect(a.arms).toBeGreaterThanOrEqual(1);
    expect(a.guarded).toBe(a.arms);
    expect(a.callRef).toBe(a.arms);
    expect(run).toBe(1);
  });

  it("unlinked: no guard, direct call (bytes unchanged)", async () => {
    const { wat, run } = await build(SOURCE, false);
    const a = arms(wat);
    expect(a.arms).toBeGreaterThanOrEqual(1);
    expect(a.guarded).toBe(0);
    expect(a.callRef).toBe(0);
    expect(run).toBe(1);
  });
});

describe("#6651 V0 — site 2: variadic builtin identity in __apply_closure", () => {
  const SOURCE = `
    export function run(): number {
      const m: any = Math.max;
      const r: any = m.apply(null, [3, 9, 1]);
      return r === 9 ? 1 : 0;
    }`;
  // The identity's compare closes an `(if (result i32)` then-branch.
  const ARM = new RegExp(`struct\\.get (\\d+) 4 i32\\.const \\1 i32\\.eq(${guard(SELF0, "\\1")}) \\) \\(else`, "g");

  for (const linked of [true, false]) {
    it(`${linked ? "linked: guarded" : "unlinked: unguarded"}`, async () => {
      const { wat, run } = await build(SOURCE, linked);
      const a = countArms(funcBody(wat, "__apply_closure"), ARM, 2);
      expect(a.arms).toBeGreaterThanOrEqual(1);
      expect(a.guarded).toBe(linked ? a.arms : 0);
      expect(run).toBe(1);
    });
  }
});

describe("#6651 V0 — site 3: builtin-fn metadata arms (exactMetaArm)", () => {
  const SOURCE = `
    export function run(): number {
      const f: any = Math.max;
      const k: any = "name";
      return f[k] === "max" ? 1 : 0;
    }`;
  const ARM = new RegExp(`struct\\.get (\\d+) 4 i32\\.const \\1 i32\\.eq(${guard("local\\.get 2", "\\1")}) \\(if`, "g");

  for (const linked of [true, false]) {
    it(`${linked ? "linked: guarded" : "unlinked: unguarded"} in __builtinfn_get_meta`, async () => {
      const { wat, run } = await build(SOURCE, linked);
      const a = countArms(funcBody(wat, "__builtinfn_get_meta"), ARM, 2);
      expect(a.arms).toBeGreaterThanOrEqual(1);
      expect(a.guarded).toBe(linked ? a.arms : 0);
      expect(run).toBe(1);
    });
  }
});

describe("#6651 V0 — site 4: dyn-view refusal-closure filter in __extern_get", () => {
  const SOURCE = `
    export function run(): number {
      const v: any = (Float64Array.prototype as any).sort;
      const TA: any = Float64Array;
      const sample: any = new TA([42, 43, 44]);
      const s: any = sample.sort;
      return (typeof s === "function" ? 1 : 0) + (typeof v === "function" ? 2 : 0);
    }`;
  // Per family, the ladder stores the bfnid in `__tam_bfnid` and compares it to
  // each refusal id: `struct.get F 4 local.tee B i32.const N i32.eq`, then
  // `local.get B i32.const N i32.eq` for every further id of that family.
  function compares(body: string): { arms: number; guarded: number } {
    const head = /struct\.get \d+ 4 local\.(?:tee|set) (\d+)(?: local\.get \1)? i32\.const \d+ i32\.eq/.exec(body);
    expect(head, "refusal filter present").not.toBeNull();
    const bfnLocal = head![1];
    const re = new RegExp(
      `(?:struct\\.get \\d+ 4 local\\.(?:tee|set) ${bfnLocal}(?: local\\.get ${bfnLocal})?|local\\.get ${bfnLocal}) i32\\.const \\d+ i32\\.eq(${guard(
        "local\\.get \\d+ any\\.convert_extern",
        "\\d+",
      )})`,
      "g",
    );
    return countArms(body, re, 1);
  }

  for (const linked of [true, false]) {
    it(`${linked ? "linked: every refusal id guarded" : "unlinked: unguarded"}`, async () => {
      const { wat, run } = await build(SOURCE, linked);
      const a = compares(funcBody(wat, "__extern_get"));
      expect(a.arms).toBeGreaterThanOrEqual(1);
      expect(a.guarded).toBe(linked ? a.arms : 0);
      expect(run).toBe(2);
    });
  }
});
