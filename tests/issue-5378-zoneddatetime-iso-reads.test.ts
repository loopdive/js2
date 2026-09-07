// #5378 — every linked-Temporal `ZonedDateTime` calendar/time field read
// (`year`, `month`, `day`, `daysInMonth`, `offsetNanoseconds`, `toPlainDate()`)
// threw `RangeError: infinity is out of range`, ISO calendar and UTC included,
// while `epochMilliseconds` read correctly.
//
// The Step-1 ladder (recorded in the issue file) localised TWO independent
// primitives on the epoch -> ISO-parts path, both reduced below with no Temporal
// in sight. Neither is Temporal-specific; Temporal is just the consumer that
// happens to need both in one call.
//
//  (1) OPTIONAL-PROPERTY READ. The polyfill's time-zone resolver returns one of
//      two object shapes and its caller reads a property only one of them
//      carries:
//        function Rt(e){ return isOffset(e) ? {offsetMinutes: n} : {tzName: e} }
//        const n = Rt(e).offsetMinutes; return void 0 !== n ? 6e10*n : named(e)
//      The checker types that read `number | undefined`; codegen collapsed it to
//      a bare f64, so the ABSENT property came back NaN, `void 0 !== NaN` took
//      the fixed-offset branch, and the offset became `6e10 * NaN`.
//
//  (2) Intl.DateTimeFormat OPTIONS BAG. The named-time-zone path's only source
//      of wall-clock parts is
//        new Intl.DateTimeFormat("en-us", {timeZone, hour12:false, era:"short",
//          year/month/day/hour/minute/second:"numeric"}).format(ms)
//      split into 7 `\w+` runs. The options object reached V8 as an opaque
//      WasmGC struct, so the host read NO properties from it and fell back to
//      the en-US default (year/month/day only): 3 parts, not 7.
//
// Both are needed. With only (1) fixed the `RangeError: infinity is out of
// range` becomes `RangeError: expected 7 parts in "1/1/2024` (measured, A/B).
//
// The consumer-only controls at the bottom passed on base already — that is
// what makes this the optional-read + options-bag seam rather than a Date,
// BigInt or arithmetic gap.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

/**
 * Provider side — the two primitives, plus the composed
 * `GetNamedTimeZoneOffsetNanoseconds` the polyfill actually evaluates.
 *
 * `EPOCH_MS` is 2024-01-01T12:34:00Z, the instant the issue's ladder used.
 */
const PROVIDER_SOURCE = `
var EPOCH_MS = 1704112440000;

// (1) the polyfill's \`Rt\` / \`Fn\` pair, verbatim in shape.
function Rt(id) { return /^[+-]/.test(id) ? { offsetMinutes: 60 } : { tzName: id }; }
export function optionalReadTypeof(id) { return typeof Rt(id).offsetMinutes; }
export function optionalReadIsUndefined(id) { return Rt(id).offsetMinutes === undefined ? 1 : 0; }
export function offsetBranch(id) {
  var n = Rt(id).offsetMinutes;
  return void 0 !== n ? "FIXED:" + String(6e10 * n) : "NAMED";
}

// (2) the Intl options bag.
function formatter(id) {
  return new Intl.DateTimeFormat("en-us", {
    timeZone: id, hour12: false, era: "short",
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric",
  });
}
// typeof, not the value: ICU resolves "numeric" to "2-digit" under hourCycle
// h23, and that mapping is ICU-version-dependent. Present vs absent is the fact.
export function resolvedHour(id) { return typeof formatter(id).resolvedOptions().hour; }
export function resolvedEra(id) { return typeof formatter(id).resolvedOptions().era; }
export function formatPartCount(id) { return formatter(id).format(EPOCH_MS).split(/[^\\w]+/).length; }

// the composed thing: GetNamedTimeZoneOffsetNanoseconds("UTC", EPOCH_MS) === 0.
function utcEpochMs(y, mo, d, h, mi, s, ms) {
  var lo = y % 400;
  var cycles = (y - lo) / 400;
  var date = new Date;
  date.setUTCHours(h, mi, s, ms);
  date.setUTCFullYear(lo, mo - 1, d);
  return date.getTime() + 12622780800000 * cycles;
}
export function namedZoneOffsetNs(id) {
  var n = Rt(id).offsetMinutes;
  if (void 0 !== n) return 6e10 * n;
  var parts = formatter(id).format(EPOCH_MS).split(/[^\\w]+/);
  if (parts.length !== 7) throw new RangeError("expected 7 parts, got " + parts.length);
  var month = +parts[0], day = +parts[1], year = +parts[2];
  var hour = "24" === parts[4] ? 0 : +parts[4];
  var minute = +parts[5], second = +parts[6];
  var msec = EPOCH_MS % 1000;
  if (msec < 0) msec += 1000;
  return 1e6 * (utcEpochMs(year, month, day, hour, minute, second, msec) - EPOCH_MS);
}

// consumer-only controls — green on BOTH sides of the fix.
export function dateGetters() {
  var d = new Date(EPOCH_MS);
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()].join(",");
}
export function bigintDivide() { return Number(1704112440000000000n / 1000000n); }
export function plainObjectMiss() { var o = { tzName: "UTC" }; return typeof o.offsetMinutes; }
`;

const IMPORTED = [
  "optionalReadTypeof",
  "optionalReadIsUndefined",
  "offsetBranch",
  "resolvedHour",
  "resolvedEra",
  "formatPartCount",
  "namedZoneOffsetNs",
  "dateGetters",
  "bigintDivide",
  "plainObjectMiss",
] as const;

const CONSUMER_PROBES = `
export function pOptionalTypeofMiss() { return optionalReadTypeof("UTC"); }
export function pOptionalTypeofHit() { return optionalReadTypeof("+01:00"); }
export function pOptionalIsUndefined() { return optionalReadIsUndefined("UTC"); }
export function pOffsetBranchNamed() { return offsetBranch("UTC"); }
export function pOffsetBranchFixed() { return offsetBranch("+01:00"); }
export function pResolvedHour() { return resolvedHour("UTC"); }
export function pResolvedEra() { return resolvedEra("UTC"); }
export function pFormatPartCount() { return formatPartCount("UTC"); }
export function pNamedZoneOffsetNs() { return namedZoneOffsetNs("UTC"); }
export function pDateGetters() { return dateGetters(); }
export function pBigintDivide() { return bigintDivide(); }
export function pPlainObjectMiss() { return plainObjectMiss(); }
`;

/**
 * Every probe's expected answer. Identical for both lanes.
 *
 * Measured on base (2026-09-07, both lanes, identical): `pOptionalTypeofMiss`
 * "number", `pOffsetBranchNamed` "FIXED:NaN", `pResolvedHour`/`pResolvedEra`
 * "undefined", `pFormatPartCount` 3, `pNamedZoneOffsetNs` NaN. The other six
 * rows were already correct.
 *
 * `pOptionalIsUndefined` being among the already-correct six is the sharpest
 * part of the base picture: `x === undefined` answered TRUE for the same read
 * that `typeof x` called "number" and that `void 0 !== x` treated as present.
 * The comparison path coerces the sentinel properly; the value path did not.
 */
const EXPECTED: Record<string, unknown> = {
  pOptionalTypeofMiss: "undefined",
  pOptionalTypeofHit: "number",
  pOptionalIsUndefined: 1,
  pOffsetBranchNamed: "NAMED",
  pOffsetBranchFixed: "FIXED:3600000000000",
  pResolvedHour: "string",
  pResolvedEra: "string",
  pFormatPartCount: 7,
  pNamedZoneOffsetNs: 0,
  pDateGetters: "2024,0,1,12,34",
  pBigintDivide: 1704112440000,
  pPlainObjectMiss: "undefined",
};

function readAll(exports: Record<string, unknown>): Record<string, unknown> {
  const observed: Record<string, unknown> = {};
  for (const name of Object.keys(EXPECTED)) {
    try {
      observed[name] = (exports[name] as (() => unknown) | undefined)?.();
    } catch (error) {
      observed[name] = `THREW: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return observed;
}

describe("#5378 — the epoch -> ISO-parts primitives a linked Temporal ZonedDateTime read needs", () => {
  it("a separately linked package resolves a named time zone's offset", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-5378-"));
    const packageRoot = join(root, "node_modules", "zone5378");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "zone5378", version: "0.0.0", main: "index.js" }),
    );
    writeFileSync(join(packageRoot, "index.js"), PROVIDER_SOURCE);
    const entry = join(root, "main.js");
    writeFileSync(entry, `import { ${IMPORTED.join(", ")} } from "zone5378";\n${CONSUMER_PROBES}`);

    const result = await compileProject(entry, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      packageCacheDir: join(root, "providers"),
    });
    expect(result.success).toBe(true);
    // Load-bearing: a `bundled` plan would inline the package and silently test
    // the single-module lane twice.
    expect(result.linkPlan?.mode).toBe("separate");

    const { instance } = await instantiateLinkedProject(result);
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });

  it("the single-module control answers identically", { timeout: 300_000 }, async () => {
    const entry = "/main.js";
    const result = await compileMulti(
      {
        "/provider.js": PROVIDER_SOURCE,
        [entry]: `import { ${IMPORTED.join(", ")} } from "./provider";\n${CONSUMER_PROBES}`,
      },
      entry,
      { allowJs: true, skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    // No package edge, so nothing is linked — this is the control.
    expect(result.linkedModules ?? []).toHaveLength(0);

    const imports = result.importObject as WebAssembly.Imports & { __setInstance?: (i: WebAssembly.Instance) => void };
    const { instance } = await WebAssembly.instantiate(result.binary as unknown as BufferSource, imports);
    imports.__setInstance?.(instance);
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    expect(readAll(instance.exports as unknown as Record<string, unknown>)).toEqual(EXPECTED);
  });
});
