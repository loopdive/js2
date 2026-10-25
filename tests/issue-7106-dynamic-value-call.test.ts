// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 Stage 4 (M3) — a bare call through a dynamic value (assert.throws'
// `func()`) lowers through the native IsCallable + `__apply_closure` runtime
// with an undefined receiver; the closure's catch parameter is the dynamic
// carrier on the host-free lanes (main's `catchIsCarrier`), so `typeof thrown`,
// `thrown === null` and `thrown.constructor` lower too. The assert.throws-shaped initializer (Test262Error
// replaced by a plain throw — Stage 3c owns that constructor) is a prepared IR
// body; every result is checked against node.

import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";

const OPTIONS = {
  target: "standalone",
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
} as const;

function row(result: CompileResult, name: string) {
  const rows = (result.irOutcomes ?? []).filter((entry) => entry.displayName === name);
  expect(rows, JSON.stringify(result.irOutcomes)).toHaveLength(1);
  return rows[0]!;
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

const DYNAMIC_CALL = `/** @returns {number} */ function subject() { return 0; }
subject.run = function (func, message) {
  try {
    func();
  } catch (thrown) {
    return;
  }
  throw message;
};
export function run() {
  var n = 0;
  var called = 0;
  try { subject.run(function () { called += 1; throw 1; }, "no"); n += 1; } catch (e) { n += 10; }
  try { subject.run(function () { called += 100; }, "no"); n += 1000; } catch (e) { if (e === "no") n += 10000; }
  try { subject.run(5, "no"); n += 100000; } catch (e) { n += 1000000; }
  try { subject.run(function () { if (this !== undefined) called += 10000; throw 2; }, "no"); } catch (e) { n += 5; }
  return n + called * 10000000;
}`;

const THROWS = `/** @returns {number} */ function subject() { return 0; }
subject.throws = function (expectedErrorConstructor, func, message) {
  var expectedName, actualName;
  if (typeof func !== "function") {
    throw 'assert.throws requires two arguments: the error constructor ' +
      'and a function to run';
    return;
  }
  if (message === undefined) {
    message = '';
  } else {
    message += ' ';
  }

  try {
    func();
  } catch (thrown) {
    if (typeof thrown !== 'object' || thrown === null) {
      message += 'Thrown value was not an object!';
      throw message;
    } else if (thrown.constructor !== expectedErrorConstructor) {
      expectedName = expectedErrorConstructor.name;
      actualName = thrown.constructor.name;
      if (expectedName === actualName) {
        message += 'Expected a ' + expectedName + ' but got a different error constructor with the same name';
      } else {
        message += 'Expected a ' + expectedName + ' but got a ' + actualName;
      }
      throw message;
    }
    return;
  }

  message += 'Expected a ' + expectedErrorConstructor.name + ' to be thrown but no exception was thrown at all';
  throw message;
};
export function run() {
  var n = 0;
  try { subject.throws(TypeError, function () { null.x; }); n += 1; } catch (e) { n += 10; }
  try { subject.throws(TypeError, function () {}); n += 100; } catch (e) { if (e === "Expected a TypeError to be thrown but no exception was thrown at all") n += 1000; }
  try { subject.throws(RangeError, function () { null.x; }, "m"); n += 10000; } catch (e) { if (e === "m Expected a RangeError but got a TypeError") n += 100000; }
  try { subject.throws(TypeError, function () { throw 1; }); } catch (e) { if (e === "Thrown value was not an object!") n += 1000000; }
  return n;
}`;

describe("#7106 Stage 4 — calls through a dynamic value", () => {
  it("calls, refuses a non-callable with TypeError, and leaves `this` undefined in the callee", async () => {
    const result = await compile(DYNAMIC_CALL, OPTIONS);
    expect(row(result, "<module-init>")).toMatchObject({
      irBodyEmitted: true,
      legacyBodyEmitted: false,
      preparedComponentId: expect.any(String),
    });
    expect(node(DYNAMIC_CALL)).toBe(1010110001);
    expect(await initializeAndRun(result)).toBe(1010110001);
  }, 35_000);

  it("prepares an assert.throws-shaped initializer (dynamic catch binding) and agrees with node", async () => {
    const result = await compile(THROWS, OPTIONS);
    expect(row(result, "<module-init>")).toMatchObject({
      irBodyEmitted: true,
      legacyBodyEmitted: false,
      preparedComponentId: expect.any(String),
    });
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(node(THROWS)).toBe(1101001);
    expect(await initializeAndRun(result)).toBe(1101001);
  }, 35_000);

  // The arm is reachable only through a planned member closure, and the plan
  // exists only on the native-first, non-fast lanes (`native-dynamic-value-call`).
  // The same shape claims on standalone and stays legacy — refused at select,
  // before any claim — on host-assisted gc and on the fast lane.
  it("admits the call only where the capability holds (no claim-then-demote elsewhere)", async () => {
    const standalone = await compile(DYNAMIC_CALL, OPTIONS);
    expect(row(standalone, "<module-init>")).toMatchObject({ irBodyEmitted: true, legacyBodyEmitted: false });
    for (const lane of [
      { target: "gc", semanticProviders: "host-assisted" },
      { target: "standalone", fast: true },
    ] as const) {
      const result = await compile(DYNAMIC_CALL, { ...OPTIONS, ...lane });
      expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
      expect(row(result, "<module-init>"), JSON.stringify(lane)).toMatchObject({
        irBodyEmitted: false,
        legacyBodyEmitted: true,
        stage: "select",
        code: "body-shape-rejected",
      });
      expect(result.irPostClaimErrors ?? [], JSON.stringify(lane)).toEqual([]);
    }
  }, 60_000);
});
