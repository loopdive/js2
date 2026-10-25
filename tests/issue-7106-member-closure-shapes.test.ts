// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 Stage 4 (M4) — two member-closure shapes of the test262 harness:
//   - a THROW-ONLY body (sta.js's `Test262Error.thrower = function (message)
//     { throw … }`): the oracle return is `never` (reported unresolvable) and
//     legacy registers it with no result, so it takes the void plan;
//   - a conditional VALUE joining a dynamic parameter with a literal
//     (assert.compareArray's `message = message === undefined ? '' : message`).
// Both initializers are prepared IR bodies and agree with node.
//
// (#7113 review) The refusal rows pin the selector's side of the contract:
// the shapes the producer cannot lower are refused at select, with no
// post-claim withdrawal, on standalone and on gc native-first alike.

import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";

const OPTIONS = {
  target: "standalone",
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
} as const;

function requirePreparedInit(result: CompileResult): void {
  const rows = (result.irOutcomes ?? []).filter((entry) => entry.displayName === "<module-init>");
  expect(rows, JSON.stringify(result.irOutcomes)).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    irBodyEmitted: true,
    legacyBodyEmitted: false,
    preparedComponentId: expect.any(String),
  });
}

async function initializeAndRun(result: CompileResult): Promise<number> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports.__module_init as () => void)();
  return (instance.exports.run as () => number)();
}

function node(source: string): number {
  return new Function(`"use strict";\n${source.replace(/\bexport /g, "")}\nreturn run();`)() as number;
}

describe("#7106 Stage 4 — harness member-closure shapes", () => {
  it("plans a throw-only member closure as void", async () => {
    const source = `/** @returns {number} */ function subject() { return 0; }
subject.thrower = function (message) { throw message; };
export function run() {
  var n = 0;
  try { subject.thrower("x"); } catch (e) { if (e === "x") n += 1; }
  try { subject.thrower(); } catch (e) { if (e === undefined) n += 10; }
  return n;
}`;
    const result = await compile(source, OPTIONS);
    requirePreparedInit(result);
    expect(node(source)).toBe(11);
    expect(await initializeAndRun(result)).toBe(11);
  }, 35_000);

  it("joins a dynamic parameter and a literal in a conditional value", async () => {
    const source = `/** @returns {number} */ function subject() { return 0; }
subject.cmp = function (actual, expected, message) {
  message = message === undefined ? '' : message;
  if (actual === expected) return;
  throw message;
};
subject.pick = function (value, fallback) {
  var chosen = value ? value : 7;
  throw chosen;
};
export function run() {
  var n = 0;
  try { subject.cmp(1, 2); } catch (e) { if (e === "") n += 10; }
  try { subject.cmp(1, 2, "m"); } catch (e) { if (e === "m") n += 100; }
  try { subject.cmp(1, 1, "m"); n += 1000; } catch (e) { n += 5; }
  try { subject.pick(0); } catch (e) { if (e === 7) n += 10000; }
  try { subject.pick("v"); } catch (e) { if (e === "v") n += 100000; }
  return n;
}`;
    const result = await compile(source, OPTIONS);
    requirePreparedInit(result);
    // (`run` itself demotes on a pre-existing `e === "m"` string/dynamic compare.)
    expect((result.irPostClaimErrors ?? []).filter((error) => error.func === "<module-init>")).toEqual([]);
    expect(node(source)).toBe(111110);
    expect(await initializeAndRun(result)).toBe(111110);
  }, 35_000);

  // Each row is a planned member closure whose body the producer would
  // withdraw after the claim; the selector refuses it first. `node` is the
  // oracle for the legacy body that then runs.
  const REFUSED: readonly [name: string, body: string, calls: string, reason: string, expected: number][] = [
    [
      "throw of a numeric literal in a throw-only body (void plan)",
      `function (message) { throw 42; }`,
      `try { subject.f(0); } catch (e) { if (e === 42) n += 1; }`,
      "body-shape-rejected",
      1,
    ],
    [
      "throw of a numeric literal after a conditional throw",
      `function (message) { if (message) { throw message; } throw 1; }`,
      `try { subject.f(0); } catch (e) { if (e === 1) n += 1; } try { subject.f("y"); } catch (e) { if (e === "y") n += 2; }`,
      "body-shape-rejected",
      3,
    ],
    [
      "dynamic-arm conditional flowing into a typed slot",
      `function (m, k) { if (k === 9) return; var n = 5; n = m ? m : 1; throw n; }`,
      `try { subject.f(0); } catch (e) { if (e === 1) n += 1; } try { subject.f("s"); } catch (e) { if (e === "s") n += 2; }`,
      "operand-coercion-unsupported",
      3,
    ],
    [
      "dynamic parameter joined with undefined",
      `function (m, k) { if (k === 9) return; var r = m ? m : undefined; throw r; }`,
      `try { subject.f(0); } catch (e) { if (e === undefined) n += 1; }`,
      "body-shape-rejected",
      1,
    ],
  ];

  it.each(REFUSED)(
    "refuses at select, without a post-claim withdrawal: %s",
    async (_name, body, calls, reason, expected) => {
      const source = `/** @returns {number} */ function subject() { return 0; }
subject.f = ${body};
export function run() { var n = 0; ${calls} return n; }`;
      expect(node(source)).toBe(expected);
      for (const lane of [{ target: "standalone" }, { target: "gc" }] as const) {
        const result = await compile(source, { ...OPTIONS, ...lane });
        expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
        const rows = (result.irOutcomes ?? []).filter((entry) => entry.displayName === "<module-init>");
        expect(rows, JSON.stringify(lane)).toHaveLength(1);
        expect(rows[0], JSON.stringify(lane)).toMatchObject({
          irBodyEmitted: false,
          legacyBodyEmitted: true,
          stage: "select",
          code: reason,
        });
        expect(
          (result.irPostClaimErrors ?? []).filter((error) => error.func !== "run"),
          JSON.stringify(lane),
        ).toEqual([]);
        if (lane.target === "standalone") expect(await initializeAndRun(result)).toBe(expected);
      }
    },
    60_000,
  );

  // The planner mints no member-closure plan on host-assisted gc, so the
  // conditional program is refused at select there and its bytes are the
  // legacy bytes — measured identical to the base of this change
  // (sha256[0:12] 9a516be80340 on both trees, 2026-10-25).
  it("leaves the host-assisted gc lane untouched (no plan, no claim)", async () => {
    const source = `/** @returns {number} */ function subject() { return 0; }
subject.cmp = function (actual, expected, message) {
  message = message === undefined ? '' : message;
  if (actual === expected) return;
  throw message;
};
export function run() { var n = 0; try { subject.cmp(1, 2); } catch (e) { if (e === "") n += 10; } return n; }`;
    const result = await compile(source, { ...OPTIONS, target: "gc", semanticProviders: "host-assisted" });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const rows = (result.irOutcomes ?? []).filter((entry) => entry.displayName === "<module-init>");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      irBodyEmitted: false,
      legacyBodyEmitted: true,
      stage: "select",
      code: "body-shape-rejected",
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
  }, 35_000);
});
