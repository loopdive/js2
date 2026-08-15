// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

/**
 * #4493 — one declared shape must not become two WasmGC struct types.
 *
 * Found by #4451: once that fix made the module valid, its interface-typed
 * repro threw `RuntimeError: illegal cast` at run time, and the same construct
 * with no callback at all threw a `WebAssembly.Exception`.
 *
 * ROOT CAUSE — the cast is the symptom, the duplicate type is the defect.
 * TypeScript gives a nested object literal its OWN fresh anonymous type even
 * under a contextual named type: in
 *
 *   const sigs: Record<string, ExportSignature> = { a: { arity: 1 } };
 *
 * property `a` is typed as the fresh `{ arity: number }`, not as
 * `ExportSignature`. `ensureStructForType` deduped that only against other
 * ANONYMOUS shapes, so the module carried `$ExportSignature` AND `__anon_N`
 * for one declared shape. WasmGC canonicalization hid it — identical layouts
 * are one runtime type — until the #2853 shape-branding pass appended a
 * `$shapeBrand` field to the `__anon_N` half (it "collides" with
 * `$ExportSignature` under the shallow layout key). From then on every
 * consumer typed by the DECLARED name failed its `ref.test` (→ null → "Cannot
 * access property on null or undefined", or a null-deref) or its `ref.cast`
 * (→ "illegal cast").
 *
 * `Object.entries` is only the loudest surface: it hands the record to the
 * host, the values come back as the SAME GC structs (the data-struct host
 * bridge preserves identity — that is not the bug), and the destructured
 * `sig` slot is typed by the interface, so it is where the mismatch lands.
 * Passing a record value to an interface-typed parameter and assigning it to
 * an interface-typed local were broken identically, with no host round-trip
 * involved at all — which is why the fix is at the type-registration site
 * (`publishDeclaredShapesForDedup`) and not in the entries lowering.
 */

const IFACE = `interface ExportSignature { arity: number; }\n`;
const REC = `  const sigs: Record<string, ExportSignature> = { a: { arity: 1 }, b: { arity: 2 } };\n`;

async function run(src: string): Promise<Record<string, unknown>> {
  const result = await compile(src, {});
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return instance.exports as unknown as Record<string, unknown>;
}

describe("#4493 — a record's interface-typed values keep one struct identity", () => {
  it("Object.entries yields values whose fields read correctly", async () => {
    // The headline repro. Before the fix: WebAssembly.Exception (the
    // destructured `sig` was null, so `sig.arity` threw "Cannot access
    // property on null or undefined"). No callback is involved.
    const ex = await run(
      `${IFACE}export function main(): number {\n${REC}  let total = 0;\n` +
        `  for (const [name, sig] of Object.entries(sigs)) { total += sig.arity + name.length; }\n` +
        `  return total;\n}\n`,
    );
    // (1 + 1) + (2 + 1)
    expect((ex.main as () => number)()).toBe(5);
  });

  it("Object.values yields values whose fields read correctly", async () => {
    const ex = await run(
      `${IFACE}export function main(): number {\n${REC}  let total = 0;\n` +
        `  for (const v of Object.values(sigs)) { total += v.arity; }\n  return total;\n}\n`,
    );
    expect((ex.main as () => number)()).toBe(3);
  });

  it("Object.keys and for-in still enumerate the record", async () => {
    // Both were already correct (keys are strings; for-in reads back through
    // the record's own field slots) — pinned as the negative control that the
    // dedup does not disturb the enumeration surfaces.
    const ex = await run(
      `${IFACE}export function main(): number {\n${REC}  let total = 0;\n` +
        `  for (const k of Object.keys(sigs)) { total += k.length; }\n` +
        `  for (const k in sigs) { total += sigs[k].arity; }\n  return total;\n}\n`,
    );
    expect((ex.main as () => number)()).toBe(5);
  });

  it("a record value satisfies an interface-typed parameter and local", async () => {
    // No host round-trip at all: this is the same duplicate-type defect
    // reached without `Object.*`. Before the fix the parameter path trapped
    // with "dereferencing a null pointer" and the local threw.
    const ex = await run(
      `${IFACE}function take(s: ExportSignature): number { return s.arity; }\n` +
        `export function main(): number {\n${REC}  const local: ExportSignature = sigs.a;\n` +
        `  return take(sigs.b) * 10 + local.arity;\n}\n`,
    );
    expect((ex.main as () => number)()).toBe(21);
  });

  it("holds when an unrelated same-layout differently-keyed shape is present", async () => {
    // The reason this is fixed at the registration site rather than in the
    // shape-brand pass. A shape MUST be branded apart from any same-layout
    // differently-keyed shape, so a single extra literal like `{ beforeExpr:
    // 7 }` re-separates a merely brand-exempted `__anon_N` from its declared
    // twin. Not minting the duplicate is immune to that.
    const ex = await run(
      `${IFACE}export function main(): string {\n${REC}  const other = { beforeExpr: 7 };\n` +
        `  let out = "";\n  for (const [n, s] of Object.entries(sigs)) { out += n + s.arity; }\n` +
        `  return out + "|" + other.beforeExpr;\n}\n`,
    );
    expect((ex.main as () => string)()).toBe("a1b2|7");
  });

  it("does not make differently-keyed shapes alias (#2853 bug A stays fixed)", async () => {
    // The dedup merges shapes only when field NAMES, wasm types and
    // mutability all match, so a differently-keyed same-layout shape is still
    // a distinct type: reading the interface's key off it must not return its
    // own field at the same offset.
    const ex = await run(
      `${IFACE}export function main(): string {\n${REC}  const other: any = { beforeExpr: 7 };\n` +
        `  let out = "";\n  for (const [n, s] of Object.entries(sigs)) { out += n + s.arity; }\n` +
        `  return out + "|" + (other.arity === undefined || other.arity === null ? "-" : "ALIAS");\n}\n`,
    );
    expect((ex.main as () => string)()).toBe("a1b2|-");
  });

  it("#4451's interface-slot construct now runs (was: illegal cast)", async () => {
    // The flip #4451 could not make: its runtime-value assertion had to use
    // the ARRAY-typed slot because this interface-typed twin threw
    // `RuntimeError: illegal cast` on the host round-trip. Both slots now
    // carry through.
    //
    // NB the assertion is on insertion order, not sorted order. The
    // comparator's DESTRUCTURED parameters arrive null inside the `__cb_N`
    // host-callback wrapper, so the sort is a no-op — a separate, pre-existing
    // defect that reproduces identically for `Record<string, string>`,
    // `Record<string, number>` and `Record<string, number[]>` on unpatched
    // main, i.e. independent of both this fix and the value type. #4451 made
    // the same choice for the same reason.
    const ex = await run(`
      interface Sig {
        readonly result: string;
      }

      export function main(): string {
        const sigs: Record<string, Sig> = { b: { result: "B" }, a: { result: "A" } };
        let out = "";
        for (const [name, sig] of Object.entries(sigs).sort(([left], [right]) => (left < right ? -1 : 1))) {
          out += name + sig.result;
        }
        return out;
      }
    `);
    expect((ex.main as () => string)()).toBe("bBaA");
  });
});
