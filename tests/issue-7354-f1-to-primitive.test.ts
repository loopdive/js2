// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 F1 — OrdinaryToPrimitive beside callable values (D6) and member writes of Object.prototype's data keys (D4).
// Each accepted program runs twice: with node's answer (returns) and with a wrong one (throws).
import { describe, expect, it } from "vitest";
import { runPrepared } from "./helpers/prepared-node-agreement.js";

const SLOW = 240_000;

async function agrees(source: string, wrong: string): Promise<void> {
  expect(() => new Function(source)()).not.toThrow();
  expect(() => new Function(wrong)()).toThrow();
  expect(await runPrepared(source)).toBe("returned");
  expect(await runPrepared(wrong)).toBe("threw");
}

describe("#7354 F1 — ToPrimitive and Object.prototype's keys", () => {
  // In a program with function values a held `toString` is tested for callability: a non-callable one is skipped,
  // the realm's `valueOf` answers the object, and the conversion throws a TypeError, as without them.
  const NON_CALLABLE =
    'var g = function () {}; var o = { toString: 1 }; var threw = 0; try { var s = "" + o; } catch (e) { threw = 1; }\n';
  it(
    "throws a TypeError for a non-callable toString beside function values",
    () => agrees(`${NON_CALLABLE}if (threw !== 1 || !g) throw 1;`, `${NON_CALLABLE}if (threw !== 0) throw 1;`),
    SLOW,
  );

  // ToString's hint is "string": `toString` first, so the realm's answers "[object Object]" before `valueOf` is
  // consulted, callable or not (`+` calls it first, tests/issue-7354-f2-calls-through-values).
  const STRING_HINT = "var o = { valueOf: function () { return 2; } }; var s = String(o);\n";
  it(
    "converts with the string hint, never reaching a callable valueOf",
    () => agrees(`${STRING_HINT}if (s !== "[object Object]") throw 1;`, `${STRING_HINT}if (s !== "2") throw 1;`),
    SLOW,
  );

  // D4: OrdinarySet of a key Object.prototype holds as a writable data property creates an own property, which the
  // conversion then finds (not callable, so a TypeError).
  const DATA_KEYS =
    'var p = {}; p.toString = 1; p.valueOf = 2; p.constructor = 3; var threw = 0; try { var s = "" + p; } catch (e) { threw = 1; }\n';
  it(
    "writes Object.prototype's data keys as own properties",
    () => agrees(`${DATA_KEYS}if (threw !== 1) throw 1;`, `${DATA_KEYS}if (threw !== 0) throw 1;`),
    SLOW,
  );
});
