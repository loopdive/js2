// #5243 — an object argument arrives as `null`, and the callee's destructuring
// parameter reports it as `Cannot destructure 'null' or 'undefined'`.
//
// THE RULE (measured on this branch's merge base, 2026-08-31 — the #5242 branch
// tip 93972f5691):
//
//   An object literal with a SPREAD has no statically closed shape, so
//   `objectLiteralSpreadTakesHostPath` builds it on the HOST and hands back an
//   `externref`. The enclosing function's INFERRED type, however, is the
//   concrete `__anon_*` record struct. The two meet in `coerceType`'s
//   `externref → ref/ref_null` arm, whose `ref.test` fails — a host object is
//   not a WasmGC struct — and whose fallback was a bare `ref.null`.
//
//   So `function widen(d) { const p = partsOf(d); return { ...p, days: d.days }; }`
//   returned **null**, silently, and the failure surfaced wherever that value
//   was next USED. Reached through the dynamic method bridge
//   (`__extern_method_call` → `__call_fn_method_3` → the callee) it surfaced as
//   the callee's own destructuring guard firing, which is why it read as a
//   bridge defect.
//
// Base / after for every probe below (`b1`/`b2` are the dynamic-bridge rows,
// `d` the direct control, `s1`/`s2` read the record without calling anything):
//
//                     BASE                                      AFTER
//   spreadIsObject    "NULL"                                 → "3/1"
//   spreadIsObject2   "NULL"                                 → "5/4"
//   viaBridge         THREW "Cannot destructure 'null' or    → "D|1,2,0,3|constrain"
//                      'undefined'"
//   viaBridgeOther    same throw                             → "T|0,0,0,5|reject"
//   viaDirect         same throw                             → "D|1,2,0,3|constrain"
//
// The `viaDirect` row is load-bearing and is the reason the fix is NOT in the
// bridge: a plain `calendars.iso.dateAdd(…)` — no dynamic dispatch at all —
// fails identically on base. The bridge was the messenger.
//
// TWO caller record shapes on ONE forwarding parameter (`widenDate` produces
// `{years, months, weeks, days}`, `widenTime` produces `{hours, minutes, days}`)
// because a single shape would be satisfied by any fix that merely made the
// callee's parameter type match its one call site.
//
// Reproduced against the polyfill it was found in: on this same base,
// `Temporal.PlainDate.from("2020-03-04").add({days: 1})` throws that message
// from the ISO calendar's `dateAdd(e, {years = 0, …}, i)` in BOTH the
// single-module and the provider lane. See the PR body for those measurements —
// they are not asserted here because a Temporal compile is ~40 s.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

/**
 * The provider half. `calendarFor` returns an `any`, so `cal.dateAdd(…)` is a
 * genuine dynamic method call (the `__extern_method_call` lane), while
 * `calendars.iso.dateAdd(…)` next to it is resolved statically — the control.
 */
const PROVIDER_SOURCE = `
const calendars = {};

function calendarFor(id) { return calendars[id]; }

calendars.iso = {
  dateAdd(base, { years = 0, months = 0, weeks = 0, days = 0 }, options) {
    return base + "|" + years + "," + months + "," + weeks + "," + days + "|" + String(options);
  },
};

function datePartsOf(d) { return { years: d.y, months: d.m, weeks: 0 }; }
function timePartsOf(d) { return { hours: d.h, minutes: 0 }; }

/** The forwarding shape: a host-path spread whose result is typed as a record. */
function widenDate(d) { const p = datePartsOf(d); return { ...p, days: d.days }; }
function widenTime(d) { const p = timePartsOf(d); return { ...p, days: d.days }; }

export function spreadIsObject() {
  const r = widenDate({ y: 1, m: 2, days: 3 });
  return r === null ? "NULL" : String(r.days) + "/" + String(r.years);
}
export function spreadIsObject2() {
  const r = widenTime({ h: 4, days: 5 });
  return r === null ? "NULL" : String(r.days) + "/" + String(r.hours);
}

export function viaBridge() {
  const cal = calendarFor("iso");
  return cal.dateAdd("D", widenDate({ y: 1, m: 2, days: 3 }), "constrain");
}
export function viaBridgeOtherShape() {
  const cal = calendarFor("iso");
  return cal.dateAdd("T", widenTime({ h: 4, days: 5 }), "reject");
}
export function viaDirect() {
  return calendars.iso.dateAdd("D", widenDate({ y: 1, m: 2, days: 3 }), "constrain");
}
`;

const CONSUMER = `
import { spreadIsObject, spreadIsObject2, viaBridge, viaBridgeOtherShape, viaDirect } from "./provider";
export function s1() { return spreadIsObject(); }
export function s2() { return spreadIsObject2(); }
export function b1() { return viaBridge(); }
export function b2() { return viaBridgeOtherShape(); }
export function d() { return viaDirect(); }
`;

const EXPECTED: Record<string, unknown> = {
  s1: "3/1",
  s2: "5/4",
  b1: "D|1,2,0,3|constrain",
  b2: "T|0,0,0,5|reject",
  d: "D|1,2,0,3|constrain",
};

describe("#5243 — an object argument through the dynamic method bridge", () => {
  it("arrives as a real record, for two different caller shapes", { timeout: 300_000 }, async () => {
    const entry = "/main.js";
    const result = await compileMulti({ "/provider.js": PROVIDER_SOURCE, [entry]: CONSUMER }, entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
    });
    expect(result.success).toBe(true);
    // No package edge — this is single-module lowering, not a provider seam.
    expect(result.linkedModules ?? []).toHaveLength(0);

    const imports = result.importObject as WebAssembly.Imports & {
      __setInstance?: (i: WebAssembly.Instance) => void;
    };
    const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
    imports.__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();

    const observed: Record<string, unknown> = {};
    for (const name of Object.keys(EXPECTED)) {
      try {
        observed[name] = (instance.exports as unknown as Record<string, () => unknown>)[name]?.();
      } catch (error) {
        observed[name] = `THREW: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    expect(observed).toEqual(EXPECTED);
  });
});
