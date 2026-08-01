// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2029 — standalone primitive-wrapper SUBCLASS emitted invalid Wasm; #3972 —
 * it now constructs natively.
 *
 * ORIGINAL DEFECT. `class N extends Number {}` / `extends Boolean {}` under
 * `--target standalone` emitted invalid Wasm. Number/Boolean are in
 * `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`, so `super()`/`new Sub()` lowered to
 * `call $__new_Number`/`$__new_Boolean` — but those standalone internals take an
 * **f64** arg while the synthetic `<Class>_new` forwarder passes its externref
 * local, so the module failed to validate (`N_new: call param types must match`)
 * and died at instantiate.
 *
 * #2029's fix was a compile-time REFUSAL (clean CE, never invalid Wasm — the
 * #1888 dual-mode invariant), which was the right answer to an ABI mismatch with
 * no available substrate.
 *
 * #3972 removes the mismatch instead of refusing it.
 * `emitStandaloneWrapperSuperCtor` registers a DEFINED
 * `(externref x n) -> externref` shim that ignores the forwarder's externref
 * args and supplies the f64 itself, so the forwarder's signature is honoured and
 * a REAL native wrapper box (a `$Object` carrying [[PrimitiveValue]]) comes back.
 * The refusal is therefore retired, not narrowed — see the #2620 collection
 * refusal, which IS merely narrowed because it still guards a real gap.
 *
 * WHAT THIS FILE PINS. Deliberately NOT just "no longer refuses" — rewriting a
 * refusal test into a permissive one is how a regression gets laundered. Each
 * case asserts the STRONGER property the fix actually claims: compiles, emits
 * ZERO host imports, instantiates against an EMPTY import object, and answers
 * `instanceof` correctly at runtime. The #2029 invalid-Wasm defect would fail
 * the instantiate step, so this is a strictly tighter guard than the refusal it
 * replaces.
 *
 * SCOPE (identity, per #3972): the wrapped primitive is the spec's no-argument
 * value (+0 / false), not the constructor argument. Per §21.1.1.1 / §20.3.1.1 a
 * subclass `new Sub()` with no argument sets [[NumberData]] +0 / [[BooleanData]]
 * false, so the no-argument form pinned here is exactly right; honouring
 * `new Sub(5)` is deferred follow-up work.
 */

const WRAPPERS = ["Number", "Boolean"] as const;

/** Compile standalone/wasi and assert host-free + instantiable + correct identity. */
async function expectNativeWrapperSubclass(parent: string, target: "standalone" | "wasi"): Promise<void> {
  const src =
    `class N extends ${parent} {}\n` +
    `export function test(): number { const n = new N(); return (n instanceof N) && (n instanceof ${parent}) ? 1 : 0; }\n`;
  const r = await compile(src, { target });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);

  // No leaked host import — the whole point of #3972 for this family. Under
  // wasi the module legitimately carries wasi_snapshot_preview1 imports, so
  // only `env::` (the JS-host namespace) must be empty.
  const labels = r.imports.map((im) => `${im.module}::${im.name}`);
  expect(
    labels.filter((l) => l.startsWith("env::")),
    `extends ${parent} (${target}) leaked host imports: ${labels.join(", ")}`,
  ).toEqual([]);

  // The #2029 defect was invalid Wasm — it survived serialization and died
  // here, so instantiating is the load-bearing assertion, not a formality.
  if (target === "standalone") {
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.test!(), `extends ${parent} instanceof answered incorrectly`).toBe(1);
  }
}

describe("#2029/#3972 primitive-wrapper subclass standalone", () => {
  for (const parent of WRAPPERS) {
    it(`'class N extends ${parent}' compiles host-free and instantiates under --target standalone`, async () => {
      await expectNativeWrapperSubclass(parent, "standalone");
    });

    it(`'class N extends ${parent}' compiles host-free under --target wasi`, async () => {
      await expectNativeWrapperSubclass(parent, "wasi");
    });

    it(`still COMPILES 'class N extends ${parent}' in default (gc / JS-host) mode`, async () => {
      // The native arm is standalone/wasi-gated — gc mode keeps the existing
      // externref-backed host path, which compiles fine and must stay
      // byte-identical in behaviour.
      const src = `class N extends ${parent} {}\nexport function test(): boolean { const n = new N(); return n instanceof N; }\n`;
      const r = await compile(src, {});
      expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    });

    it(`'class N extends ${parent}' with a declared method compiles host-free (standalone)`, async () => {
      const src =
        `class N extends ${parent} { extra(): number { return 7; } }\n` +
        `export function test(): number { const n = new N(); return n.extra(); }\n`;
      const r = await compile(src, { target: "standalone" });
      expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
      const labels = r.imports.map((im) => `${im.module}::${im.name}`);
      expect(labels.filter((l) => l.startsWith("env::"))).toEqual([]);
      const { instance } = await WebAssembly.instantiate(r.binary, {});
      const ex = instance.exports as Record<string, () => number>;
      expect(ex.test!()).toBe(7);
    });
  }

  it("does NOT refuse 'class S extends String' standalone — it already worked", async () => {
    // String's __new_String(externref)->externref always matched the forwarder,
    // so it was never in the refused set. Kept as a regression guard: #3972
    // must not disturb the rung that already worked.
    const src = `class S extends String {}\nexport function test(): number { const s = new S(); return s instanceof S ? 1 : 0; }\n`;
    const r = await compile(src, { target: "standalone" });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const labels = r.imports.map((im) => `${im.module}::${im.name}`);
    expect(
      labels.filter((l) => l.startsWith("env::")),
      `unexpected env:: imports: ${labels.join(", ")}`,
    ).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    const ex = instance.exports as Record<string, () => number>;
    expect(ex.test!()).toBe(1);
  });
});
