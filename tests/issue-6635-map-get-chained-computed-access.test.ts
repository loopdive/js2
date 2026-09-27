// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6635 (S50 of #5383) — `Map`/`WeakMap.prototype.get()`'s return value is
// reported as `{kind:"anyref"}` by `tryCompileNativeMapMethodCall`
// (`src/codegen/map-runtime.ts`). Used DIRECTLY as the object of a COMPUTED
// member access with no intervening local variable — `someMap.get(k)
// [computedKey]` for a read, `someMap.get(k)[computedKey] = v` for a write —
// the anyref value never reached any arm of `compileElementAccessBody` /
// `compileExternSetFallback` (both only recognized `externref`/`f64`/`i32`/
// `ref`/`ref_null`). The read side fell to `reportError(...); return null;`
// in `compileElementAccessBody`, which the #1919 speculative-rollback wrapper
// in `expressions.ts` silently converts into a discarded diagnostic + a
// TS-static-type-derived DEFAULT value — for an unresolvable computed-member
// type that default is a bare `ref.null`, observable as JS `null`, not
// `undefined`. The write side fell to the same `reportError` fallback in
// `compileExternSetFallback`, silently dropping the write instead of ever
// reaching `__extern_set`.
//
// Fix: both `compileElementAccessBody` (property-access.ts) and
// `compileExternSetFallback` (expressions/assignment.ts) now treat an
// `anyref` object the same way they already treat `ref`/`ref_null`/`externref`
// — a single `extern.convert_any` widens it onto the SAME, already-correct
// externref read/write pipeline (`__extern_get`/`__extern_set`), which is
// what every other object receiver already uses.
//
// This is a REAL, verified defect and the fix is answer-preserving (an
// `anyref` receiver previously only ever hit the broken fallback, so this is
// strictly additive). It is NOT, on its own, sufficient to close #5383's two
// named target rows (`Temporal/PlainDate/from/argument-object-valid.js`,
// `…/argument-string.js`) — the real polyfill's calendar-era read reaches
// `Map.get()` results only through a DEVIRTUALIZED closed-method-dispatch
// call (`$__call_m_isoToDate_2`), whose return value is already coerced to
// `externref` before the receiver of the final `[t]` read — see "### S50
// findings" in plan/issues/5383-standalone-temporal-provider.md for the WAT
// evidence and the next lane's reduction boundary.
//
// Standalone only — this is `ctx.nativeStrings`-gated Map codegen
// (`tryCompileNativeMapMethodCall` returns `undefined` when `!ctx.nativeStrings`).
import { describe, expect, it } from "vitest";
import { compileMulti, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

async function run(body: string, fns: string[]): Promise<Record<string, unknown>> {
  const result = await compileMulti({ "/__main.js": body }, "/__main.js", {
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...STANDALONE,
  } as never);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  const exports = instance.exports as unknown as Record<string, () => unknown>;
  const out: Record<string, unknown> = {};
  for (const name of fns) out[name] = exports[name]!();
  return out;
}

describe("#6635 — Map/WeakMap.get() chained computed member access (anyref receiver)", () => {
  it("fix-witness: READ — someMap.get(k)[computedKey] returns the stored value, not undefined/null", async () => {
    const out = await run(
      `
      const V = new WeakMap();
      const r = {};
      const seed = Object.create(null);
      V.set(r, seed);
      seed["slot-x"] = 42;
      export function probeChainedRead() {
        const v = V.get(r)["slot-x"];
        return v === 42 ? 1 : (v === undefined ? 2 : 3);
      }
      `,
      ["probeChainedRead"],
    );
    expect(out.probeChainedRead).toBe(1);
  });

  it("fix-witness: WRITE — someMap.get(k)[computedKey] = v actually persists the write", async () => {
    const out = await run(
      `
      const V = new WeakMap();
      const r = {};
      V.set(r, Object.create(null));
      export function probeChainedWriteRead() {
        V.get(r)["slot-x"] = 42;
        const v = V.get(r)["slot-x"];
        return v === 42 ? 1 : (v === undefined ? 2 : 3);
      }
      `,
      ["probeChainedWriteRead"],
    );
    expect(out.probeChainedWriteRead).toBe(1);
  });

  // NOTE: optional-chained bracket access (`compileOptionalElementAccess`) is
  // a SEPARATE codegen path this fix does not touch, and it already handled
  // an anyref base correctly before this fix (verified: passes on both the
  // pre-fix and post-fix tree) — so this is a REAL-SHAPE confirmation, not a
  // fix-witness. Included because it is the closest match to the real
  // polyfill's `re(e,t){const n=Q(e)?.[t];...}`.
  it("control: optional-chained READ — someMap.get(k)?.[computedKey] (the real polyfill's exact shape, re(e,t){const n=Q(e)?.[t];...}) — already correct pre-fix", async () => {
    const out = await run(
      `
      const V = new WeakMap();
      function Q(o) { return V.get(o); }
      function re(o, t) {
        const n = Q(o)?.[t];
        if (n === undefined) throw new TypeError("Missing internal slot " + t);
        return n;
      }
      const r = {};
      V.set(r, Object.create(null));
      function oe(o, t, n) {
        const rr = Q(o);
        rr[t] = n;
      }
      oe(r, "slot-x", 42);
      export function probeOptionalChained() {
        const v = re(r, "slot-x");
        return v === 42 ? 1 : (v === undefined ? 2 : (v === null ? 3 : 4));
      }
      `,
      ["probeOptionalChained"],
    );
    expect(out.probeOptionalChained).toBe(1);
  });

  it("control: a plain function call (non-Map) chained with a computed access was ALREADY correct — unaffected by the fix", async () => {
    const out = await run(
      `
      const n = Object.create(null);
      function getDict() { return n; }
      export function probe() {
        getDict()["slot-x"] = 42;
        const v = getDict()["slot-x"];
        return v === 42 ? 1 : (v === undefined ? 2 : 3);
      }
      `,
      ["probe"],
    );
    expect(out.probe).toBe(1);
  });

  it("control: Map.get() stashed into a local variable before member access was ALREADY correct — unaffected by the fix", async () => {
    const out = await run(
      `
      const V = new Map();
      const r = {};
      V.set(r, Object.create(null));
      export function probe() {
        const d = V.get(r);
        d["slot-x"] = 42;
        const v = d["slot-x"];
        return v === 42 ? 1 : (v === undefined ? 2 : 3);
      }
      `,
      ["probe"],
    );
    expect(out.probe).toBe(1);
  });

  it("control: Map.get() holding a PRIMITIVE value was ALREADY correct — unaffected by the fix", async () => {
    const out = await run(
      `
      const V = new Map();
      const r = {};
      V.set(r, 42);
      export function probe() {
        const v = V.get(r);
        return v === 42 ? 1 : (v === undefined ? 2 : 3);
      }
      `,
      ["probe"],
    );
    expect(out.probe).toBe(1);
  });
});
