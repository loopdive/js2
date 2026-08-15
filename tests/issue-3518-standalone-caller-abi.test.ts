// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3518 — standalone lane, caller-direction call-graph closure precision.
 *
 * Outside JS-host mode the selector demotes a claimed function that has an
 * unclaimed LOCAL caller unless `legacyCallerAbiIsProjected` certifies that both
 * front-ends derive the SAME wasm signature. That certification excluded
 * `string` positions, so a fully-annotated string-returning leaf was demoted
 * with `call-graph-closure` purely because one of its callers was unclaimable —
 * measured on the standalone lane as `calendar.ts::mname`.
 *
 * These tests pin (a) the newly-claimed family, (b) that the JS-host lane is
 * structurally untouched, and (c) the tightenings that keep the certified
 * surface a proof rather than an optimism.
 */
import { describe, expect, it } from "vitest";

import { ts } from "../src/ts-api.js";
import { compile } from "../src/index.js";
import { hasFullyAnnotatedScalarAbi } from "../src/codegen/ir-legacy-caller-abi.js";

/**
 * A string-returning fully-annotated leaf (`mname`) whose only local caller
 * (`label`) is body-shape-rejected in every mode. This is `calendar.ts`'s
 * topology reduced to the one edge under test.
 */
const LEAF_WITH_LEGACY_CALLER = `
function mname(m: number): string {
  if (m === 0) return "Jan";
  if (m === 1) return "Feb";
  return "Dec";
}

function label(m: number): string {
  const parts: string[] = [];
  parts.push(mname(m));
  return parts.join("/");
}

export function test(): number {
  return label(1).length;
}
`;

async function compileFixture(source: string, standalone: boolean) {
  return compile(source, {
    fileName: "fixture.ts",
    trackIrOutcomes: true,
    ...(standalone ? { target: "standalone" as const } : {}),
  });
}

function outcomeFor(result: Awaited<ReturnType<typeof compile>>, displayName: string) {
  return result.irOutcomes?.find((outcome) => outcome.displayName === displayName);
}

function declarationOf(source: string, name: string): ts.FunctionDeclaration {
  const sourceFile = ts.createSourceFile("abi.ts", source, ts.ScriptTarget.ES2020, true);
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`no function ${name} in fixture`);
  return declaration;
}

/** Production wiring hands in the real legacy override; none of these bodies trip it. */
const CERTIFYING_EVIDENCE = { returnCarrierIsOverridden: () => false };

describe("#3518 standalone caller-direction closure", () => {
  it("claims a string-returning leaf whose local caller stays on the direct path", async () => {
    const result = await compileFixture(LEAF_WITH_LEGACY_CALLER, true);

    expect(result.success).toBe(true);
    expect(result.irCompiledFuncs).toContain("mname");
    expect(outcomeFor(result, "mname")?.kind).toBe("emitted");
    // The caller is genuinely unclaimed — otherwise the closure is untested.
    expect(outcomeFor(result, "label")?.kind).toBe("unsupported");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("emits a valid module and the correct string result across the mixed-front-end call", async () => {
    const result = await compileFixture(LEAF_WITH_LEGACY_CALLER, true);

    expect(result.binary).toBeDefined();
    // A cross-signature `call` between the IR-claimed callee and its legacy
    // caller would fail validation here — this is the assertion the closure
    // exists to protect.
    expect(WebAssembly.validate(result.binary!)).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary!, {});
    // label(1) === "Feb" → length 3.
    expect((instance.exports as { test(): number }).test()).toBe(3);
  });

  it("leaves the JS-host lane's selection unchanged", async () => {
    const standalone = await compileFixture(LEAF_WITH_LEGACY_CALLER, true);
    const host = await compileFixture(LEAF_WITH_LEGACY_CALLER, false);

    // Host mode never consults the certification (`demoteOnLegacyCaller` is
    // false there), so it claimed `mname` before this change and still does —
    // the two lanes now agree on this shape.
    expect(host.irCompiledFuncs).toContain("mname");
    expect(host.irCompiledFuncs).toEqual(standalone.irCompiledFuncs);
    expect(outcomeFor(host, "label")?.kind).toBe("unsupported");
  });

  it("claims calendar.ts::mname on the standalone lane without post-claim demotion", async () => {
    const { readFileSync } = await import("node:fs");
    const entry = "website/playground/examples/dom/calendar.ts";
    const result = await compile(readFileSync(entry, "utf8"), {
      fileName: entry,
      trackIrOutcomes: true,
      target: "standalone",
    });

    expect(result.success).toBe(true);
    expect(result.irCompiledFuncs).toContain("mname");
    expect(outcomeFor(result, "mname")?.kind).toBe("emitted");
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(WebAssembly.validate(result.binary!)).toBe(true);
  });
});

describe("#3518 certified legacy-caller ABI surface", () => {
  it("certifies string positions, which both front-ends key on the same carrier fields", () => {
    const source = `
      function ret(m: number): string { return "x"; }
      function param(s: string): number { return s.length; }
      function both(s: string, n: number): string { return s; }
    `;
    for (const name of ["ret", "param", "both"]) {
      expect(hasFullyAnnotatedScalarAbi(declarationOf(source, name), CERTIFYING_EVIDENCE)).toBe(true);
    }
  });

  it("keeps certifying the pre-existing scalar and void surface", () => {
    const source = `
      function scalar(a: number, b: boolean): number { return a; }
      function arr(xs: number[]): boolean { return true; }
      function nothing(a: number): void {}
    `;
    for (const name of ["scalar", "arr", "nothing"]) {
      expect(hasFullyAnnotatedScalarAbi(declarationOf(source, name), CERTIFYING_EVIDENCE)).toBe(true);
    }
  });

  it("refuses positions whose legacy carrier the annotation does not predict", () => {
    const source = `
      function implicitParam(a): number { return 1; }
      function optional(a?: number): number { return 1; }
      function defaulted(a: number = 1): number { return 1; }
      function rest(...a: number[]): number { return 1; }
      function destructured({ a }: any): number { return 1; }
      function generic<T>(a: number): number { return 1; }
      function stringArray(xs: string[]): number { return 1; }
      function objectParam(o: object): number { return 1; }
      function noReturnType(a: number) { return 1; }
      async function asyncFn(a: number): Promise<number> { return 1; }
      function* gen(a: number): number { return 1; }
    `;
    const names = [
      "implicitParam",
      "optional",
      "defaulted",
      "rest",
      "destructured",
      "generic",
      "stringArray",
      "objectParam",
      "noReturnType",
      "asyncFn",
      "gen",
    ];
    for (const name of names) {
      expect(hasFullyAnnotatedScalarAbi(declarationOf(source, name), CERTIFYING_EVIDENCE), name).toBe(false);
    }
  });

  it("refuses a value-returning declaration when legacy overrides the return carrier", () => {
    const declaration = declarationOf(`function ret(m: number): string { return "x"; }`, "ret");

    expect(hasFullyAnnotatedScalarAbi(declaration, { returnCarrierIsOverridden: () => true })).toBe(false);
    // No evidence at all is also a refusal: an un-wired caller must not inherit
    // an exemption it has not proven.
    expect(hasFullyAnnotatedScalarAbi(declaration)).toBe(false);
  });

  it("certifies a void return without needing return-carrier evidence", () => {
    // Legacy short-circuits on `isVoidType` before any carrier override, so the
    // void arm is proven by construction.
    expect(hasFullyAnnotatedScalarAbi(declarationOf(`function v(a: number): void {}`, "v"))).toBe(true);
  });
});
