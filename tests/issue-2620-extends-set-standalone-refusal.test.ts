// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2620 (split from #2606 Bug B) — `class X extends Set/Map/WeakMap/WeakSet`
// under `--target standalone`/`wasi` (nativeStrings) had TWO substrate defects:
//
//   A. Host-import leak: even a bare `class MySet extends Set {}` lowered
//      construction through the host-constructible path (these names are in
//      BUILTIN_PARENTS_HOST_CONSTRUCTIBLE), leaking an unsatisfiable
//      `env::__new_Set` import — the module failed to instantiate.
//   B. Late-import index-shift (#2043 class): the synthetic `<Class>_<method>`
//      accessor (`MySet_size`/`MySet_has`) desynced across the
//      addUnionImports/flushLateImportShifts reorder, baking a `-1` global /
//      a stale call funcIdx → invalid Wasm.
//
// The base collections ARE served by the WasmGC-native runtime (#1103a/#2162),
// but a true native SUBCLASS (native `$Map`-backed construction + direct
// `[[SetData]]` set-algebra + native iteration + `instanceof` discrimination —
// the Set/prototype/*/subclass-receiver-methods rows) is the collection-runtime
// substrate, tracked separately (#2162/#2580-M2 lane). Until that lands, a
// standalone subclass of one of these is REFUSED at compile time: a clean
// `Codegen error:` (success:false), never invalid Wasm and never a leaked host
// import (the #1888 dual-mode invariant — "uncertainty ⇒ fail loud").
//
// This guards: (1) the standalone refusal fires (clean CE, no invalid binary,
// no env import leak); (2) gc/host mode is UNAFFECTED (the externClass host path
// still compiles the subclass).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const COLLECTIONS = ["Set", "Map", "WeakMap", "WeakSet"] as const;

/**
 * Standalone: the subclass must be a CLEAN compile error citing #2620 — never a
 * leaked `env::__new_*` import, never invalid Wasm.
 */
async function expectStandaloneRefusal(parent: string, body: string): Promise<void> {
  const src = `class Sub extends ${parent}<number> { ${body} }
    export function test(): number { return 0; }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, `expected a clean refusal, but compile succeeded for extends ${parent}`).toBe(false);
  const errs = r.errors.filter((e) => e.severity === "error").map((e) => e.message);
  expect(
    errs.some((m) => m.includes("#2620")),
    `expected a #2620 refusal for extends ${parent}, got: ${errs.join(" | ")}`,
  ).toBe(true);
  // No env host-import leak survived into the (empty) binary.
  const env = (r.imports ?? []).filter((i: { module?: string }) => i.module === "env");
  expect(env.length, `extends ${parent} leaked env imports: ${env.map((i: any) => i.name).join(",")}`).toBe(0);
}

describe("#2620 standalone subclass-of-native-collection refusal", () => {
  for (const parent of COLLECTIONS) {
    it(`standalone refuses bare class extends ${parent} (was: env.__new_${parent} leak)`, async () => {
      await expectStandaloneRefusal(parent, "");
    });
  }

  it("standalone refuses extends Set with size/has/keys overrides (was: #2043 invalid Wasm)", async () => {
    // The Set/prototype/*/subclass-receiver-methods.js shape that emitted the
    // `MySet_has`/`MySet_size` late-import index-shift invalid Wasm.
    await expectStandaloneRefusal(
      "Set",
      "size(...rest: any[]): any { return rest.length; } has(...rest: any[]): any { return rest.length; } keys(...rest: any[]): any { return rest.length; }",
    );
  });

  it("standalone refusal is a CLEAN compile error — never invalid Wasm, never a host import", async () => {
    const r = await compile(
      `class MySet extends Set<number> {}
       export function test(): number { return 0; }`,
      { target: "standalone" },
    );
    expect(r.success).toBe(false);
    // binary is empty on a failed compile — there is no poisoned module to validate.
    expect(r.binary.length).toBe(0);
  });

  // gc/host mode must be UNAFFECTED — the externClass host path compiles the
  // subclass there (the refusal is nativeStrings-gated only).
  it("gc/host mode still compiles a Set subclass (refusal is standalone-only)", async () => {
    const r = await compile(
      `class MySet extends Set<number> {}
       export function test(): number { const s = new MySet([1, 2]); return 0; }`,
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    // gc/host path may legitimately use the __new_Set host import — that's fine.
    await WebAssembly.compile(r.binary);
  });
});
