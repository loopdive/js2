// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6683 companion — `ensureAnyHelpers` re-entrancy. Its `ensureObjectRuntime`
// call flushes the native-proto seeders; a provider-linked `%Function%` read
// then builds the globalThis seed, whose `Math.max`/`Math.min` value closures
// bake a call to `__any_to_f64` — which `ensureAnyHelpers` had claimed
// (`anyHelpersEmitted`) but not yet registered. The closures declined, the
// seed kept the `max`/`min` keys with no value, and the compile failed with a
// `__native_globalThis_ensure` stack-balance CE (moment's standalone-dynamic
// lane). Kept in its own file: the provider-linked global seed is
// memory-heavy for a 512MB vitest fork.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

describe("#6683 ensureAnyHelpers re-entrancy", () => {
  it("a globalThis seed built inside ensureAnyHelpers still gets Math.max/min values", async () => {
    // The exported `any` boundary reaches `ensureAnyHelpers` first; the
    // provider-linked `%Function%` read builds the globalThis seed inside it.
    const src = `var F = Function; export function run(a: any){ return Object.getPrototypeOf(a) === F; }`;
    const r = await compile(src, { target: "standalone" } as never);
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(r.binary)).toBe(true);
  });
});
