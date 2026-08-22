// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4612 — an unannotated return position whose LEGACY carrier is a #4155
// fnctor-instance struct must be declined BEFORE the claim.
//
// The #2949 slice-3b contract for an unannotated `dynamic` position is that its
// carrier equals the one legacy gives the same declaration. #4155 (PR #4116,
// commit 269c26a80) flipped `fnctorTypedInstancesEnabled()` on by default, and
// legacy then resolves a position whose CHECKER type is an approved-standalone
// function-style-constructor instance to that fnctor's reserved
// `$__fnctor_<Name>` struct. The IR reads the propagated lattice, never the
// checker, so it still says `dynamic` — and the claim died at the
// `abi-signature-parity` guard instead of at selection.
//
// Measured on the #2949 runtime-dynamic acorn driver: `tokenizer` withdrew with
// IR `(externref, externref) -> externref` against legacy
// `(externref, externref) -> (ref null $__fnctor_Parser)`.
//
// The fixture is acorn's exact shape, reduced: a `var F = function F(){}`
// fnctor with a `new this(...)` static (which is always `reconstruct`, so `F`
// is escape-gate approved and gets a reserved struct) plus the top-level
// delegating wrapper that returns it. `countOf` is the control: same shape,
// same static-call delegation, but a non-fnctor result, so it must keep its
// claim.
//
// The file is compiled as `.mjs` on purpose — TypeScript only applies its
// JS expando/`prototype` assignment inference (which is what makes the checker
// answer `Parser` for `new this(...)`) to JavaScript files.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const FNCTOR_RETURN = `
var Parser = function Parser(options, input) {
  this.options = options;
  this.input = input;
  this.pos = 0;
};

Parser.prototype.advance = function () {
  this.pos = this.pos + 1;
};

Parser.tokenizer = function tokenizer (input, options) {
  return new this(options, input)
};

Parser.countOf = function countOf (input) {
  return input.length
};

function tokenizer(input, options) {
  return Parser.tokenizer(input, options)
}

function countOf(input) {
  return Parser.countOf(input)
}

/** @returns {number} */
export function run() {
  var p = tokenizer("abc", 1);
  p.advance();
  return p.pos + countOf("abcd");
}
`;

async function compileFixture(target: "gc" | "standalone", fileName: string) {
  const result = await compile(FNCTOR_RETURN, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    fileName,
    target,
    trackIrOutcomes: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  return result;
}

function outcomeFor(result: Awaited<ReturnType<typeof compileFixture>>, name: string) {
  return result.irOutcomes?.find((outcome) => outcome.displayName === name);
}

describe("#4612 fnctor-instance return position", () => {
  it("declines the delegating wrapper at selection, never at the parity guard", async () => {
    const result = await compileFixture("standalone", "issue-4612-fnctor-return.mjs");

    // The whole point: a SELECT-stage decline, not a `resolve`-stage
    // `abi-signature-parity` withdrawal.
    expect(outcomeFor(result, "tokenizer"), JSON.stringify(result.irOutcomes, null, 2)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      code: "return-type-not-resolvable",
      irBodyEmitted: false,
      legacyBodyEmitted: true,
    });
    expect(
      (result.irOutcomes ?? []).filter((outcome) => outcome.code === "abi-signature-parity"),
      "no unit may withdraw on ABI parity for this fixture",
    ).toEqual([]);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps the non-fnctor sibling claimed — the decline is scoped to the refined carrier", async () => {
    const result = await compileFixture("standalone", "issue-4612-fnctor-control.mjs");

    expect(result.irCompiledFuncs, JSON.stringify(result.irOutcomes, null, 2)).toContain("countOf");
    expect(result.irCompiledFuncs).not.toContain("tokenizer");
  });

  it("does not fire on the JS-host lane — #4155 refines instances in standalone only", async () => {
    // `resolveFnctorInstanceType` returns null off-standalone, so legacy keeps
    // its externref instance carrier and the two front-ends still agree; the
    // new gate must stay silent there. This lane declines the wrapper for its
    // own unrelated reason, and the return-type gate is evaluated BEFORE the
    // body-shape one (measured: on standalone, acorn's `kw` moves from
    // `body-shape-rejected` to `return-type-not-resolvable`), so seeing
    // `body-shape-rejected` here IS the proof the gate did not fire.
    const result = await compileFixture("gc", "issue-4612-fnctor-host.mjs");

    expect(outcomeFor(result, "tokenizer"), JSON.stringify(result.irOutcomes, null, 2)).toMatchObject({
      kind: "unsupported",
      stage: "select",
      code: "body-shape-rejected",
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  });

  it("keeps the legacy body value-correct across the declined boundary", async () => {
    const result = await compileFixture("standalone", "issue-4612-fnctor-runtime.mjs");
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    const init = instance.exports.__module_init as (() => void) | undefined;
    if (typeof init === "function") init();

    // one `advance()` on a fresh instance, plus `"abcd".length`.
    expect((instance.exports.run as () => number)()).toBe(5);
  });
});
