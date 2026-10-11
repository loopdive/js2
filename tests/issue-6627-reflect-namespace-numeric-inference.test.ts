// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6627 (#5383 S40) — the whole-program `numericFunctions` name-keyed
// oracle (`src/codegen/numeric-property-analysis.ts`, #4122) treated a
// `Reflect.get(...)` / `Reflect.has(...)` / … call as "some class's
// same-named method", because its only test for a bare-identifier RECEIVER
// was `ts.isIdentifier(recv)` — true for `Reflect` too. That created a
// SELF-REINFORCING FIXPOINT for any object-literal method literally named
// `get` (the near-universal Proxy trap name, and the exact shape
// `TemporalHelpers.propertyBagObserver`'s `get` trap uses): the set starts
// with "get" seeded true (every function of that name, optimistically);
// `Reflect.get(...)`'s own return asks `numericFunctions.has("get")`, which
// answers true (the trap's own disqualification hasn't run yet), which is
// exactly what keeps the trap's `result` local classified numeric — "get"
// never earns its own removal.
//
// The visible defect: a `var v = h.get(...)` (or a `var result =
// Reflect.get(...)` local inside the trap itself) gets an f64 slot instead
// of externref/string. Downstream that produces either a WRONG VALUE (a
// string result silently unboxed to a number, or vice-versa) or a genuine
// WASM VALIDATION TRAP ("struct.get … found local.get of type f64") when the
// corrupted local later flows into a `.length`-style struct read expecting a
// string.
//
// Standalone only (`nativeStrings`, the wasm-native `--target standalone`
// dispatcher family) — the gc/host lane's Reflect.get compiles through a
// different, unaffected `env::__reflect_*` host import and never runs this
// analysis pass at all.
//
// NOTE ON SCOPE: this fix is REAL and independently verified (reduced from
// #5383's target bucket), but it does NOT move that bucket — the real
// corpus's "Proxy get trap is not callable" failures reproduce identically
// with and without it (see #5383 S40 findings / the handover note). It is
// filed and merged on its own merits.
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

describe("#6627 — Reflect.X(...) must not seed the numericFunctions name-keyed oracle", () => {
  it("fix-witness: a `get` trap's local, defined from Reflect.get, keeps its string identity through a struct-typed caller local (base tree: WASM validation trap)", async () => {
    // Minimal reduction: an object-literal method literally named `get`,
    // called directly (`h.get(...)`, the closed-struct dispatch path), whose
    // body stores `Reflect.get(...)`'s result in a local before returning it.
    // The caller then reads `.length` off the call's result — which needs the
    // native-string struct representation, not an f64 slot.
    const out = await run(
      `
      export function probe() {
        var h = {
          get(target, key, receiver) {
            var result = Reflect.get(target, key, receiver);
            return result;
          }
        };
        var target = { overflow: "reject" };
        var v = h.get(target, "overflow", target);
        return typeof v === "string" ? v.length : -99;
      }
      `,
      ["probe"],
    );
    expect(out.probe).toBe(6); // "reject".length
  });

  it("fix-witness twin: a Proxy get trap (arbitrary arity/shape) whose body routes the read through a local before returning (base tree: dereferencing a null pointer)", async () => {
    const out = await run(
      `
      export function probe() {
        var options = new Proxy({ overflow: "reject" }, {
          get(target, key, receiver) {
            var result = Reflect.get(target, key, receiver);
            return result;
          }
        });
        var v = options.overflow;
        return typeof v === "string" ? v.length : -99;
      }
      `,
      ["probe"],
    );
    expect(out.probe).toBe(6);
  });

  it("control: a method literally named `get` that does NOT call Reflect.X still dispatches (unaffected, unchanged both trees)", async () => {
    const out = await run(
      `
      export function probe() {
        var h = {
          get(target, key) {
            var result = target[key];
            return result;
          }
        };
        var target = { overflow: "reject" };
        var v = h.get(target, "overflow");
        return typeof v === "string" ? v.length : -99;
      }
      `,
      ["probe"],
    );
    expect(out.probe).toBe(6);
  });

  it("control: a genuinely NUMERIC user method literally named `get` is still narrowed to f64 (the oracle's positive case, unaffected)", async () => {
    const out = await run(
      `
      export function probe() {
        var h = {
          get(key) {
            var result = key;
            return result;
          }
        };
        var v = h.get(7);
        return v + 1;
      }
      `,
      ["probe"],
    );
    expect(out.probe).toBe(8);
  });

  it("control: Math/Date's own explicit numeric arms are unaffected by the new namespace exclusion", async () => {
    const out = await run(
      `
      export function probe() {
        var v = Math.max(3, 9);
        return v + 1;
      }
      `,
      ["probe"],
    );
    expect(out.probe).toBe(10);
  });
});
