// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4773 — the #4491 wave-4 vec-identity withdrawal, made per-argument.
 *
 * The wave-4 rule withdraws a `__vec_*` parameter narrowing whenever the module
 * is descriptor-dirty (`overlayRouteActive`). That flag is MODULE-WIDE: acorn's
 * one `Object.defineProperties(Parser.prototype, prototypeAccessors)` withdrew
 * every vec-param narrowing in the file, costing `isInAstralSet` its claim and,
 * through the callers that then failed body-shape / call-graph-closure, five IR
 * claims on the #2949 runtime-dynamic driver (31/43 → 26/43 emitted).
 *
 * #4773 keeps the rule and narrows its TRIGGER to a whitelist: the narrowing
 * survives only when every argument reaching the parameter is a
 * provenance-closed module-level array literal — bound once, never aliased,
 * never stored into, referenced ONLY as an argument at this one parameter
 * position — and the callee merely reads it. A descriptor cannot reach an
 * object nothing else can reference.
 *
 * Both directions are pinned here, and BOTH by executing the operation:
 *  - **must-pass**: in a genuinely descriptor-dirty module, the closed literal
 *    keeps its narrowing AND computes the right answer.
 *  - **must-withdraw**: the moment the array becomes reachable — a descriptor
 *    on it, an alias, a second callee, a store through the parameter — the
 *    narrowing withdraws and the descriptor is HONOURED. These tests protect
 *    #4491's invariant; they are the reason this change is a whitelist rather
 *    than a relaxation.
 *
 * Every fixture carries the same unrelated accessor descriptor (`accessorBag`
 * on `host`), so `overlayRouteActive` is true in ALL of them. `hostHidden()`
 * asserts that — a fixture that stopped being descriptor-dirty would make the
 * must-withdraw cases vacuous.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** An accessor descriptor unrelated to the array — this is what makes the module dirty. */
const DIRTY_PRELUDE = `
var accessorBag = { hidden: { configurable: true } };
accessorBag.hidden.get = function () { return 42 };
var host = {};
Object.defineProperties(host, accessorBag);
`;

/** acorn's `isInAstralSet` shape, reduced: a read-only vec parameter fed by a module-level literal. */
const CLOSED_LITERAL = `
var astralStart = [0, 11, 2, 25, 2, 18];
function isInSet(code, set) {
  var pos = 0;
  for (var i = 0; i < set.length; i += 2) {
    pos += set[i];
    if (pos > code) { return false }
    pos += set[i + 1];
    if (pos >= code) { return true }
  }
  return false
}
export function probe(c) { return isInSet(c, astralStart) ? 1 : 0 }
export function hostHidden() { return host.hidden }
`;

const PROBE_INPUTS = [0, 5, 11, 12, 40];

interface Compiled {
  outcome: string;
  probe: number[];
  hostHidden: unknown;
}

async function compileFixture(source: string): Promise<Compiled> {
  const result = await compile(source, {
    fileName: "fixture.mjs",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
    trackIrOutcomes: true,
  });
  expect(
    result.success,
    `Compile failed:\n${(result.errors ?? []).map((e) => `  L${e.line}: ${e.message}`).join("\n")}`,
  ).toBe(true);
  const unit = (result.irOutcomes ?? []).find((o) => o.displayName === "isInSet");
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports.__module_init as (() => void) | undefined)?.();
  const probeFn = instance.exports.probe as (c: number) => number;
  return {
    outcome: unit === undefined ? "absent" : unit.kind === "emitted" ? "EMITTED" : `${unit.stage}:${unit.code}`,
    probe: PROBE_INPUTS.map((c) => probeFn(c)),
    hostHidden: (instance.exports.hostHidden as (() => unknown) | undefined)?.(),
  };
}

describe("#4773 — provenance-closed vec parameter keeps its narrowing", () => {
  it("MUST-PASS: a closed module-level literal keeps the narrowing in a descriptor-dirty module", async () => {
    const compiled = await compileFixture(DIRTY_PRELUDE + CLOSED_LITERAL);
    // The module really is descriptor-dirty — otherwise this test proves nothing.
    expect(compiled.hostHidden).toBe(42);
    // The narrowing survived, so the unit is claimed rather than withdrawing on
    // `param-type-not-resolvable` (which is what the module-wide rule caused).
    expect(compiled.outcome).toBe("EMITTED");
    // …and still computes what JavaScript computes.
    expect(compiled.probe).toEqual([1, 1, 1, 0, 1]);
  });

  it("MUST-WITHDRAW: a descriptor ON the array withdraws it, and the getter is honoured", async () => {
    const source = `${DIRTY_PRELUDE}${CLOSED_LITERAL}
Object.defineProperty(astralStart, "1", { get: function () { return 999 } });
`;
    const compiled = await compileFixture(source);
    expect(compiled.hostHidden).toBe(42);
    expect(compiled.outcome).toBe("select:param-type-not-resolvable");
    // The soundness assertion: the accessor at index 1 must be visible THROUGH
    // the parameter. A carrier copy would answer the raw backing slot (11) and
    // give [1, 1, 1, 0, 1] — the descriptor-free answer.
    expect(compiled.probe).toEqual([1, 1, 1, 1, 1]);
  });

  it("MUST-WITHDRAW: an alias of the array withdraws it", async () => {
    const source = `${DIRTY_PRELUDE}${CLOSED_LITERAL}
var aliasOfAstral = astralStart;
export function aliasLength() { return aliasOfAstral.length }
`;
    const compiled = await compileFixture(source);
    expect(compiled.hostHidden).toBe(42);
    // `astralStart` is now referenced outside an argument position, so it is
    // not provenance-closed and the array is reachable for a later descriptor.
    expect(compiled.outcome).toBe("select:param-type-not-resolvable");
  });

  it("MUST-WITHDRAW: passing the array to a SECOND function withdraws it", async () => {
    const source = `${DIRTY_PRELUDE}${CLOSED_LITERAL}
function alsoTakes(set) { return set.length }
export function second() { return alsoTakes(astralStart) }
`;
    const compiled = await compileFixture(source);
    expect(compiled.hostHidden).toBe(42);
    // The closure clause: the array must flow into this ONE parameter position
    // only. `alsoTakes` could descriptor-touch it.
    expect(compiled.outcome).toBe("select:param-type-not-resolvable");
  });

  it("MUST-WITHDRAW: a STORE through the parameter withdraws it", async () => {
    const source = `${DIRTY_PRELUDE}
var astralStart = [0, 11, 2, 25, 2, 18];
function isInSet(code, set) {
  set[0] = code;
  var pos = 0;
  for (var i = 0; i < set.length; i += 2) {
    pos += set[i];
    if (pos > code) { return false }
    pos += set[i + 1];
    if (pos >= code) { return true }
  }
  return false
}
export function probe(c) { return isInSet(c, astralStart) ? 1 : 0 }
export function hostHidden() { return host.hidden }
`;
    const compiled = await compileFixture(source);
    expect(compiled.hostHidden).toBe(42);
    // The callee is no longer read-only, so the argument is not provably
    // descriptor-free for the callee's own lifetime.
    expect(compiled.outcome).toBe("select:param-type-not-resolvable");
  });

  it("MUST-WITHDRAW: a non-literal element (an identifier) withdraws it", async () => {
    const source = `${DIRTY_PRELUDE}
var seed = 11;
var astralStart = [0, seed, 2, 25, 2, 18];
function isInSet(code, set) {
  var pos = 0;
  for (var i = 0; i < set.length; i += 2) {
    pos += set[i];
    if (pos > code) { return false }
    pos += set[i + 1];
    if (pos >= code) { return true }
  }
  return false
}
export function probe(c) { return isInSet(c, astralStart) ? 1 : 0 }
export function hostHidden() { return host.hidden }
`;
    const compiled = await compileFixture(source);
    expect(compiled.hostHidden).toBe(42);
    // Only a literal of primitive elements is admitted — an identifier element
    // is a value this analysis does not model.
    expect(compiled.outcome).toBe("select:param-type-not-resolvable");
  });

  it("MUST-WITHDRAW: an EXPORTED array withdraws it", async () => {
    const source = `${DIRTY_PRELUDE}
export var astralStart = [0, 11, 2, 25, 2, 18];
function isInSet(code, set) {
  var pos = 0;
  for (var i = 0; i < set.length; i += 2) {
    pos += set[i];
    if (pos > code) { return false }
    pos += set[i + 1];
    if (pos >= code) { return true }
  }
  return false
}
export function probe(c) { return isInSet(c, astralStart) ? 1 : 0 }
export function hostHidden() { return host.hidden }
`;
    const compiled = await compileFixture(source);
    expect(compiled.hostHidden).toBe(42);
    // An exported binding is reachable from OUTSIDE the module, so nothing in
    // this file can prove a descriptor never lands on it.
    expect(compiled.outcome).toBe("select:param-type-not-resolvable");
  });

  it("MUST-WITHDRAW: an `eval` anywhere in the file withdraws it", async () => {
    const source = `${DIRTY_PRELUDE}${CLOSED_LITERAL}
export function evalKind() { return typeof eval === "function" ? 1 : 0 }
`;
    const compiled = await compileFixture(source);
    expect(compiled.hostHidden).toBe(42);
    // `eval("Object.defineProperty(astralStart, …)")` names the binding inside a
    // STRING, where no identifier scan can see it. A file containing `eval` (or
    // `with`) therefore has no provenance-closed names at all.
    expect(compiled.outcome).toBe("select:param-type-not-resolvable");
  });

  it("the JS-host lane is untouched — the rule is standalone-only", async () => {
    const result = await compile(DIRTY_PRELUDE + CLOSED_LITERAL, {
      fileName: "fixture.mjs",
      allowJs: true,
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(true);
    // `overlayRouteActive` requires `ctx.standalone`, so neither the wave-4
    // withdrawal nor this whitelist can fire here at all.
    const unit = (result.irOutcomes ?? []).find((o) => o.displayName === "isInSet");
    expect(unit?.kind).toBe("emitted");
  });
});
