// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2527 / #2514 — canonical runtime-type rec-group identity primitive.
//
// Proves the soundness contract of the identity primitive that core-wasm
// module linking (the CHOSEN approach for #2527) depends on:
//
//   (A) Two independent compilations of the SAME source produce the SAME
//       canonical hash — the ABI is reproducible.
//   (B) Two DIFFERENT sources that both exercise the same runtime GC types
//       produce the SAME canonical hash — the runtime types are stable across
//       user programs (this is the whole premise: any two user modules can
//       exchange String/Vec objects through the shared runtime).
//   (C) The hash is name-independent and absolute-index-independent (matches
//       WasmGC isorecursive canonicalization), but order- and
//       structure-sensitive (a perturbed member set / order / shape changes
//       the hash) — so it's a sound proxy for engine canonicalization and a
//       real drift gate.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { analyzeSource } from "../src/checker/index.js";
import { generateModule } from "../src/codegen/index.js";
import type { StructTypeDef, TypeDef, WasmModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  canonicalHashOfTypeGroup,
  extractRuntimeGroup,
  fingerprintRuntimeGroup,
  RUNTIME_RECGROUP_ABI_VERSION,
  RUNTIME_RECGROUP_TYPE_NAMES,
  verifyRuntimeRecGroupBinary,
} from "../src/emit/canonical-recgroup.js";

function modOf(source: string): WasmModule {
  const ast = analyzeSource(source);
  const { module } = generateModule(ast, { nativeStrings: true, canonicalRuntimeTypes: true });
  return module;
}

// Programs that exercise the native-string + vec/array runtime GC types.
const STRING_HEAVY = `
export function f(xs: string[]): string {
  let acc = "";
  for (const x of xs) acc = acc + x;
  return acc + xs.length.toString();
}
`;

const STRING_HEAVY_VARIANT = `
export function greet(names: string[]): string {
  let out = "names:";
  for (let i = 0; i < names.length; i++) {
    out = out + " " + names[i];
  }
  return out;
}
export function tag(s: string): string {
  return "[" + s + "]";
}
`;

describe("#2527 canonical runtime rec-group identity primitive", () => {
  it("(A) is reproducible: same source compiled twice ⇒ same fingerprint", () => {
    const a = fingerprintRuntimeGroup(modOf(STRING_HEAVY));
    const b = fingerprintRuntimeGroup(modOf(STRING_HEAVY));
    expect(a.count).toBeGreaterThan(0); // the program actually uses runtime GC types
    expect(b).toEqual(a);
    expect(a.abiVersion).toBe(RUNTIME_RECGROUP_ABI_VERSION);
  });

  it("(B) is stable across different user programs that use the same runtime types", () => {
    const a = fingerprintRuntimeGroup(modOf(STRING_HEAVY));
    const b = fingerprintRuntimeGroup(modOf(STRING_HEAVY_VARIANT));
    // The runtime types both programs share must canonicalize identically: the
    // intersection of their member sets must hash equal. Since DCE may prune a
    // type one program doesn't use, compare on the shared subset by recomputing
    // a hash over the members common to both, preserving each module's order.
    const common = new Set(a.members.filter((m) => b.members.includes(m)));
    expect(common.size).toBeGreaterThan(0);

    function subsetHash(mod: WasmModule): string {
      const members = extractRuntimeGroup(mod).filter((m) => common.has(m.name));
      return canonicalHashOfTypeGroup(
        members.map((m) => m.def),
        members.map((m) => m.absIndex),
      );
    }
    expect(subsetHash(modOf(STRING_HEAVY_VARIANT))).toBe(subsetHash(modOf(STRING_HEAVY)));
  });

  it("(C1) is name-independent and absolute-index-independent", () => {
    // Build a tiny synthetic group: a struct referencing an array, twice.
    // The two copies differ ONLY in type names and absolute placement; the
    // canonical hash must be equal.
    const groupA: TypeDef[] = [
      { kind: "array", name: "$dataA", element: { kind: "i16" }, mutable: true },
      {
        kind: "struct",
        name: "$strA",
        fields: [
          { name: "len", type: { kind: "i32" }, mutable: false },
          { name: "data", type: { kind: "ref_null", typeIdx: 100 }, mutable: false },
        ],
      } as StructTypeDef,
    ];
    const groupB: TypeDef[] = [
      { kind: "array", name: "$ZZ_renamed", element: { kind: "i16" }, mutable: true },
      {
        kind: "struct",
        name: "$other_name",
        fields: [
          { name: "length", type: { kind: "i32" }, mutable: false },
          // points to the array member (abs 200 = local 0), mirroring groupA.
          { name: "payload", type: { kind: "ref_null", typeIdx: 200 }, mutable: false },
        ],
      } as StructTypeDef,
    ];
    // group A laid out at absolute [100,101]; group B at [200,201].
    const hashA = canonicalHashOfTypeGroup(groupA as never, [100, 101]);
    const hashB = canonicalHashOfTypeGroup(groupB as never, [200, 201]);
    expect(hashB).toBe(hashA);
  });

  it("(C2) is order-sensitive", () => {
    const t0: TypeDef = { kind: "array", name: "$a", element: { kind: "i16" }, mutable: true };
    const t1: TypeDef = { kind: "array", name: "$b", element: { kind: "f64" }, mutable: true };
    const fwd = canonicalHashOfTypeGroup([t0, t1] as never, [0, 1]);
    const rev = canonicalHashOfTypeGroup([t1, t0] as never, [0, 1]);
    expect(rev).not.toBe(fwd);
  });

  it("(C3) is structure-sensitive (field mutability / element type matter)", () => {
    const immutable: TypeDef = { kind: "array", name: "$a", element: { kind: "i16" }, mutable: false };
    const mutable: TypeDef = { kind: "array", name: "$a", element: { kind: "i16" }, mutable: true };
    expect(canonicalHashOfTypeGroup([mutable] as never, [0])).not.toBe(
      canonicalHashOfTypeGroup([immutable] as never, [0]),
    );

    const i16el: TypeDef = { kind: "array", name: "$a", element: { kind: "i16" }, mutable: true };
    const f64el: TypeDef = { kind: "array", name: "$a", element: { kind: "f64" }, mutable: true };
    expect(canonicalHashOfTypeGroup([i16el] as never, [0])).not.toBe(canonicalHashOfTypeGroup([f64el] as never, [0]));
  });

  it("(C4) distinguishes intra-group ref topology from external refs", () => {
    // Same struct shape, but one points to a group member (local r0), the other
    // to an out-of-group type (external x). These must hash differently.
    const arr: TypeDef = { kind: "array", name: "$d", element: { kind: "i16" }, mutable: true };
    const structIntra: StructTypeDef = {
      kind: "struct",
      name: "$s",
      fields: [{ name: "data", type: { kind: "ref_null", typeIdx: 0 }, mutable: false }],
    };
    const structExtern: StructTypeDef = {
      kind: "struct",
      name: "$s",
      fields: [{ name: "data", type: { kind: "ref_null", typeIdx: 999 }, mutable: false }],
    };
    const intra = canonicalHashOfTypeGroup([arr, structIntra] as never, [0, 1]);
    const extern = canonicalHashOfTypeGroup([arr, structExtern] as never, [0, 1]);
    expect(extern).not.toBe(intra);
  });

  it("extractRuntimeGroup only returns ABI-listed runtime types", () => {
    const mod = modOf(STRING_HEAVY);
    const members = extractRuntimeGroup(mod);
    for (const m of members) {
      expect(RUNTIME_RECGROUP_TYPE_NAMES).toContain(m.name);
    }
    // No duplicates, indices strictly increasing (emission order preserved).
    for (let i = 1; i < members.length; i++) {
      expect(members[i]!.absIndex).toBeGreaterThan(members[i - 1]!.absIndex);
    }
  });

  it("verifies the emitted recursive group from raw Wasm bytes", () => {
    const mod = modOf(STRING_HEAVY);
    const fingerprint = fingerprintRuntimeGroup(mod);
    const verification = verifyRuntimeRecGroupBinary(emitBinary(mod), fingerprint);
    expect(verification.valid, verification.detail).toBe(true);
    expect(verification.abiVersion).toBe(RUNTIME_RECGROUP_ABI_VERSION);
    expect(verification.count).toBe(fingerprint.count);
    expect(verification.end! - verification.start! + 1).toBe(fingerprint.count);

    // A provider/consumer drift must be observable even when the Wasm bytes
    // remain otherwise parseable. This is the fail-safe gate used after
    // optional Binaryen optimization.
    const drifted = verifyRuntimeRecGroupBinary(emitBinary(mod), {
      ...fingerprint,
      hash: fingerprint.hash.replace(/^./, fingerprint.hash[0] === "0" ? "1" : "0"),
    });
    expect(drifted.valid).toBe(false);
  });

  it("keeps the frozen group scoped to explicit core-Wasm link boundaries", async () => {
    const legacy = await compile(`export function value(): string { return "legacy"; }`, {
      target: "standalone",
      emitWat: false,
    });
    expect(legacy.success, legacy.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(legacy.runtimeRecGroupFingerprint).toBeUndefined();

    const linked = await compile(`export function value(): string { return "linked"; }`, {
      target: "standalone",
      canonicalRuntimeTypes: true,
      emitWat: false,
    });
    expect(linked.success, linked.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(linked.runtimeRecGroupFingerprint?.abiVersion).toBe(RUNTIME_RECGROUP_ABI_VERSION);
  });

  it("publishes and consumes the explicit js2wasm:runtime number ABI", async () => {
    const provider = await compile("", {
      target: "standalone",
      nativeStrings: true,
      runtimeProvider: true,
      emitWat: false,
    });
    expect(provider.success, provider.errors.map((error) => error.message).join("; ")).toBe(true);
    const providerModule = new WebAssembly.Module(provider.binary);
    expect(WebAssembly.Module.imports(providerModule)).toHaveLength(0);
    const providerExports = new Set(WebAssembly.Module.exports(providerModule).map((entry) => entry.name));
    for (const name of [
      "number_toString",
      "number_toString_radix",
      "number_toFixed",
      "number_toPrecision",
      "number_toExponential",
    ]) {
      expect(providerExports.has(name), `provider export ${name} missing`).toBe(true);
    }

    const consumer = await compile(`export function format(value: number): string { return value.toString(); }`, {
      nativeStrings: true,
      link: ["js2wasm:runtime"],
      emitWat: false,
    });
    expect(consumer.success, consumer.errors.map((error) => error.message).join("; ")).toBe(true);
    const consumerModule = new WebAssembly.Module(consumer.binary);
    expect(WebAssembly.Module.imports(consumerModule)).toContainEqual({
      module: "js2wasm:runtime",
      name: "number_toString",
      kind: "function",
    });
    expect(consumer.runtimeRecGroupFingerprint?.abiVersion).toBe(RUNTIME_RECGROUP_ABI_VERSION);

    // The import/export signatures and canonical rec-group must agree in the
    // engine, not merely in the metadata. Instantiation is the link-time ABI
    // check used by the provider build canary.
    const providerInstance = new WebAssembly.Instance(providerModule, {});
    const consumerImports = consumer.importObject ?? {};
    consumerImports["js2wasm:runtime"] = providerInstance.exports;
    const consumerInstance = new WebAssembly.Instance(consumerModule, consumerImports);
    expect(typeof consumerInstance.exports.format).toBe("function");
    // Execute the cross-module path as well: the provider returns a native
    // string object through externref and the consumer casts it to its local
    // `$AnyString`. A mismatch in the canonical rec group traps here.
    const formatted = (consumerInstance.exports.format as (value: number) => unknown)(42);
    expect(formatted).toBeDefined();
  });
});
