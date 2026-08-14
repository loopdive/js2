// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4408 — every case the old whole-string `isWeaker` predicate got wrong.
//
// It tested the entire answer against four literals, so it only worked for
// scalar answers. On a 2,137-input corpus it reported 908 "conflicts"; the
// same rows classified structurally are 136 same-meaning, 306 in-house-weaker,
// 366 checker-weaker and 100 genuine. Each mis-classification below is pinned
// with a literal answer pair taken from that run, so the predicate cannot
// regress to string equality.
import { describe, expect, it } from "vitest";
import { classifyDivergence } from "../src/checker/divergence-classifier.ts";

describe("#4408 divergence classifier", () => {
  it("treats identical answers as agreement", () => {
    expect(classifyDivergence("typeFactOf", "number", "number")).toBe("same-meaning");
  });

  it("sees an abstention nested inside a signature", () => {
    // 374 of the original 908 conflicts were this shape.
    expect(classifyDivergence("signatureOf", "(any)->boolean#1", "(unresolvable)->unresolvable#1")).toBe(
      "inhouse-weaker",
    );
    expect(
      classifyDivergence(
        "signatureOf",
        "(any,number,array<any>)->boolean#3",
        "(unresolvable,unresolvable,unresolvable)->unresolvable#3",
      ),
    ).toBe("inhouse-weaker");
  });

  it("sees an abstention nested inside a generic fact", () => {
    expect(classifyDivergence("typeFactOf", "array<number>", "array<any>")).toBe("inhouse-weaker");
  });

  it("reads `any` and `unresolvable` as the same non-answer", () => {
    // Neither carries static information for a wasm lowerer.
    expect(classifyDivergence("typeFactOf", "any", "unresolvable")).toBe("same-meaning");
    expect(classifyDivergence("typeFactOf", "array<unresolvable>", "array<any>")).toBe("same-meaning");
    expect(classifyDivergence("signatureOf", "(any)->any#1", "(unresolvable)->unresolvable#1")).toBe("same-meaning");
  });

  it("knows which boolean polarity is the abstention, per query", () => {
    // `false` = "I cannot prove this is boolean-producing".
    expect(classifyDivergence("isBooleanProducing", "true", "false")).toBe("inhouse-weaker");
    // `true` = "I cannot resolve this identifier" — the opposite polarity.
    expect(classifyDivergence("isUnresolvableIdentifier", "false", "true")).toBe("inhouse-weaker");
    // ...and the reverse direction is the in-house backend claiming more.
    expect(classifyDivergence("isUnresolvableIdentifier", "true", "false")).toBe("checker-weaker");
  });

  it("recognises an empty list as an abstention on either side", () => {
    expect(classifyDivergence("declarationsOf", "[261@10]", "[]")).toBe("inhouse-weaker");
    // The `with` corpus hits: the CHECKER declines and the in-house backend
    // commits (#4409).
    expect(classifyDivergence("declarationsOf", "[]", "[261@1795]")).toBe("checker-weaker");
  });

  it("separates checker-weaker from genuine conflict", () => {
    // The checker declines; in-house names a declaration. Adjudicate (#4410).
    expect(classifyDivergence("valueDeclarationOf", "undefined", "263@132")).toBe("checker-weaker");
    // Both name a declaration, and they differ — a real disagreement.
    expect(classifyDivergence("valueDeclarationOf", "263@1719", "263@1567")).toBe("genuine-conflict");
  });

  it("keeps incompatible facts as genuine conflicts", () => {
    expect(classifyDivergence("signatureOf", "(number)->number#1", "(string)->string#1")).toBe("genuine-conflict");
    expect(classifyDivergence("typeFactOf", "tuple<number,number,number>", "array<number>")).toBe("genuine-conflict");
    expect(classifyDivergence("staticJsTypeOf", "string", "number")).toBe("genuine-conflict");
  });

  it("treats a thrown candidate answer as a conflict, never as weakening", () => {
    expect(classifyDivergence("typeFactOf", "number", "<threw>")).toBe("genuine-conflict");
  });

  it("does not merge composites of different arity", () => {
    expect(classifyDivergence("signatureOf", "(any,any)->any#2", "(unresolvable)->unresolvable#1")).toBe(
      "genuine-conflict",
    );
  });
});
