// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5381 — extern-class constructors dropped their options bag.
//
// #5355 gave `Intl.DateTimeFormat` a real host receiver; #5378 then routed its
// SECOND argument through `_wrapForHost` so V8 could read the options bag. That
// fix was written as a THIRD NAME on a two-name list (`Request`, `Response`),
// and the list was the bug: those three are not three constructors, they are
// one SHAPE — a host constructor that reads properties off an argument. Every
// other constructor in the shape lost its bag identically and was waiting for
// someone to notice and add a fourth name.
//
// Measured on the #5378 base, this branch, before the change:
//
//   new Intl.NumberFormat("en-US",{minimumFractionDigits:3}).format(1.5)
//                                                    "1.5"      node "1.500"
//   new Intl.ListFormat("en",{type:"disjunction"}).format(["a","b"])
//                                                    "a and b"  node "a or b"
//   new (Intl as any).PluralRules("en-US",{type:"ordinal"}).select(2)
//                                                    "other"    node "two"
//   new (Intl as any).RelativeTimeFormat("en",{numeric:"auto"}).format(-1,"day")
//                                                    "1 day ago" node "yesterday"
//   Reflect.construct(Intl.DateTimeFormat, ["en-US"])
//                        TypeError: Intl.DateTimeFormat called on null or undefined
//
// THREE arms, because the same defect lives on three paths:
//
// 1. `src/runtime.ts`, the registered-extern-class `new` resolver. The
//    per-class `webInitArgIndex` is inverted into a default: every compiled
//    struct argument crosses through `_wrapForHost`, EXCEPT for constructors
//    that consume an argument by another protocol (iterables, buffers,
//    ToPrimitive, the Error family's `cause` identity, Promise's executor) or
//    by identity (`_structArgIdentityCtors`). Fixes NumberFormat/ListFormat and
//    anything registered later, without naming them.
//
// 2. `_marshalHostConstructArg`, the DYNAMIC twin. `new (Intl as any).PluralRules(…)`
//    is not a registered extern class — it lowers to `__construct` on the host
//    function fetched off the `Intl` global (#5206) — so it needed the same
//    default on its own path.
//
// 3. `emitReflectArgs` in `src/codegen/expressions/call-namespace-static.ts`.
//    `Reflect.construct`'s argumentsList is read with CreateListFromArrayLike,
//    so the literal's LENGTH is the argument count — but TypeScript infers the
//    contextual tuple from the TARGET's constructor signature, giving
//    `["en-US"]` the optional 2-tuple type `[locales?, options?]`. The tuple
//    lowering padded it to a 2-field struct and the host ran
//    `new Intl.DateTimeFormat("en-US", null)`. An arity SIGNATURE is not a
//    length; that one position now compiles as a vec.
//
// NOT fixed here, and measured so the bound is honest: the TYPED spellings
// `new Intl.PluralRules(…)` / `RelativeTimeFormat` / `Collator` still answer a
// null receiver. That is the #5355 defect (not registered in
// `extern-declarations.ts`), not this one — the dynamic spelling is what these
// tests use for those two.

import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/** Consumer-only lane: one module, JS host. */
async function run(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "issue-5381.ts", skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => unknown>).test!();
}

/**
 * Linked-provider lane. The options bag is built in one module and the
 * constructor consumes it in another, which is the shape the Temporal provider
 * link takes (#5225: a struct minted by another module must be mirrored against
 * the exports that can DECODE it). A bag that survives the single-module lane
 * can still cross this one opaque, so both lanes are asserted for every case.
 */
async function runLinked(providerBody: string, consumerBody: string): Promise<unknown> {
  const files: Record<string, string> = {
    "./bag.ts": `export function makeBag(): any { ${providerBody} }`,
    "./entry.ts": `import { makeBag } from "./bag.js";
       export function test(): string { ${consumerBody} }`,
  };
  const result = await compileMulti(files, "./entry.ts", { skipSemanticDiagnostics: true });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (instance.exports as Record<string, () => unknown>).test!();
}

describe("#5381 — extern-class constructors marshal their options bag", () => {
  describe("consumer-only (single module)", () => {
    it("Intl.NumberFormat honours minimumFractionDigits", async () => {
      // Base: "1.5" — V8 read no properties off the opaque struct and applied
      // the en-US default.
      expect(
        await run(`export function test(): string {
          return String(new Intl.NumberFormat("en-US", { minimumFractionDigits: 3 }).format(1.5));
        }`),
      ).toBe("1.500");
    });

    it("Intl.NumberFormat honours a bag held in a local, not just an inline literal", async () => {
      // The inline literal and the variable take different codegen routes to
      // the same host constructor; base measured "1.5" for both.
      expect(
        await run(`export function test(): string {
          const options = { minimumFractionDigits: 3 };
          return String(new Intl.NumberFormat("en-US", options).format(1.5));
        }`),
      ).toBe("1.500");
    });

    it("Intl.ListFormat honours type: disjunction", async () => {
      // Base: "a and b" (the conjunction default).
      expect(
        await run(`export function test(): string {
          return String(new Intl.ListFormat("en", { type: "disjunction" }).format(["a", "b"]));
        }`),
      ).toBe("a or b");
    });

    it("Intl.PluralRules honours type: ordinal (dynamic spelling)", async () => {
      // Base: "other" — the cardinal default. Dynamic spelling because the
      // typed one is still a #5355 shell (see the header note).
      expect(
        await run(`export function test(): string {
          return String(new (Intl as any).PluralRules("en-US", { type: "ordinal" }).select(2));
        }`),
      ).toBe("two");
    });

    it("Intl.RelativeTimeFormat honours numeric: auto (dynamic spelling)", async () => {
      // Base: "1 day ago" — the numeric:"always" default.
      expect(
        await run(`export function test(): string {
          return String(new (Intl as any).RelativeTimeFormat("en", { numeric: "auto" }).format(-1, "day"));
        }`),
      ).toBe("yesterday");
    });

    it("Intl.DateTimeFormat keeps its #5378 bag (the arm this generalises)", async () => {
      expect(
        await run(`export function test(): string {
          return String(new Intl.DateTimeFormat("en-US", {
            timeZone: "UTC", hour: "numeric", minute: "numeric", hour12: false,
          }).format(0));
        }`),
      ).toBe("00:00");
    });

    it("Intl.DateTimeFormat called WITHOUT new constructs (§15.1.2)", async () => {
      // Reported as a null-pointer trap when #5381 was filed; #5355's
      // registration had already fixed it by the time this branch measured it.
      // Asserted so it cannot silently regress.
      expect(
        await run(`export function test(): string {
          return String(Intl.DateTimeFormat("en-US").format(0));
        }`),
      ).toBe("1/1/1970");
    });

    it("Intl.NumberFormat called WITHOUT new still honours its bag", async () => {
      expect(
        await run(`export function test(): string {
          return String(Intl.NumberFormat("en-US", { minimumFractionDigits: 3 }).format(1.5));
        }`),
      ).toBe("1.500");
    });

    it("Reflect.construct(Intl.DateTimeFormat, [locale]) constructs", async () => {
      // Base: TypeError "Intl.DateTimeFormat called on null or undefined" — the
      // one-element literal was padded to the contextual 2-tuple, so the host
      // saw an explicit `null` options argument.
      expect(
        await run(`export function test(): string {
          return String(Reflect.construct(Intl.DateTimeFormat, ["en-US"]).format(0));
        }`),
      ).toBe("1/1/1970");
    });

    it("Reflect.construct passes a bag through when one IS supplied", async () => {
      expect(
        await run(`export function test(): string {
          return String(Reflect.construct(Intl.NumberFormat, ["en-US", { minimumFractionDigits: 3 }]).format(1.5));
        }`),
      ).toBe("1.500");
    });

    it("Reflect.construct still gives a one-element list exactly one argument", async () => {
      // The complement of the padding fix: the literal's length is the argument
      // count, so a one-element list must NOT become two.
      expect(
        await run(`export function test(): string {
          const r: any = Reflect.construct(Array, ["en-US"]);
          return String(r.length) + "|" + String(r[0]);
        }`),
      ).toBe("1|en-US");
    });

    it("CONTROL — the Request init dictionary is unchanged", async () => {
      // `Request`/`Response` were the original members of the arm this
      // generalises. Their behaviour must be bit-identical, not merely similar.
      expect(
        await run(`export function test(): string {
          const r: any = new Request("https://example.test/x", { method: "POST" });
          return String(r.method) + "|" + String(r.url);
        }`),
      ).toBe("POST|https://example.test/x");
    });

    it("CONTROL — Error `cause` keeps OBJECT IDENTITY, not a mirror", async () => {
      // §20.5.8.1 installs the cause verbatim. The Error family is deliberately
      // excluded from the new default for exactly this reason; if it were not,
      // `e.cause === obj` would start comparing a proxy against the struct.
      expect(
        await run(`export function test(): string {
          const obj = { tag: 1 };
          const e: any = new Error("boom", { cause: obj });
          return String(e.cause === obj);
        }`),
      ).toBe("true");
    });

    it("CONTROL — Map still consumes its iterable, not a property mirror", async () => {
      expect(
        await run(`export function test(): string {
          const m = new Map<string, number>([["a", 1], ["b", 2]]);
          return String(m.size) + "|" + String(m.get("b"));
        }`),
      ).toBe("2|2");
    });
  });

  describe("through a linked provider (bag minted in another module)", () => {
    it("Intl.NumberFormat honours a cross-module bag", async () => {
      expect(
        await runLinked(
          `return { minimumFractionDigits: 3 };`,
          `return String(new Intl.NumberFormat("en-US", makeBag()).format(1.5));`,
        ),
      ).toBe("1.500");
    });

    it("Intl.ListFormat honours a cross-module bag", async () => {
      expect(
        await runLinked(
          `return { type: "disjunction" };`,
          `return String(new Intl.ListFormat("en", makeBag()).format(["a", "b"]));`,
        ),
      ).toBe("a or b");
    });

    it("Intl.PluralRules honours a cross-module bag", async () => {
      expect(
        await runLinked(
          `return { type: "ordinal" };`,
          `return String(new (Intl as any).PluralRules("en-US", makeBag()).select(2));`,
        ),
      ).toBe("two");
    });

    it("Intl.RelativeTimeFormat honours a cross-module bag", async () => {
      expect(
        await runLinked(
          `return { numeric: "auto" };`,
          `return String(new (Intl as any).RelativeTimeFormat("en", makeBag()).format(-1, "day"));`,
        ),
      ).toBe("yesterday");
    });

    it("Intl.DateTimeFormat honours a cross-module bag", async () => {
      expect(
        await runLinked(
          `return { timeZone: "UTC", hour: "numeric", minute: "numeric", hour12: false };`,
          `return String(new Intl.DateTimeFormat("en-US", makeBag()).format(0));`,
        ),
      ).toBe("00:00");
    });

    it("Intl.DateTimeFormat without `new` honours a cross-module bag", async () => {
      expect(
        await runLinked(
          `return { timeZone: "UTC", hour: "numeric", minute: "numeric", hour12: false };`,
          `return String(Intl.DateTimeFormat("en-US", makeBag()).format(0));`,
        ),
      ).toBe("00:00");
    });

    it("CONTROL — the Request init dictionary is unchanged across the link", async () => {
      expect(
        await runLinked(
          `return { method: "POST" };`,
          `const r: any = new Request("https://example.test/x", makeBag()); return String(r.method);`,
        ),
      ).toBe("POST");
    });
  });
});
