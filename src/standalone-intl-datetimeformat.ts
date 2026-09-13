// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// standalone-intl-datetimeformat.ts (#6442, #5383 S9) — a Wasm-native,
// host-free `Intl.DateTimeFormat` for the TABLE-FREE time zones, emitted as
// JavaScript SOURCE and prepended to the @js-temporal/polyfill provider under
// `--target standalone` / `--target wasi`.
//
// Why source and not codegen. Measured on the linked bundle (157,546 B): the
// polyfill never sees the compiler's `Intl`. The S2c shim declares a
// module-scoped `const Intl = {...}` in the provider's own compilation unit, so
// every `Intl.DateTimeFormat` in the bundle resolves to that LEXICAL binding. A
// `new Intl.DateTimeFormat` arm in `src/codegen/` would be shadowed and could
// not move a single row. (Standalone user code is a different, still-open gap:
// the `Intl` global itself is absent — #5206.)
//
// Why `format`, not `formatToParts`. Also measured, and the opposite of the
// obvious guess. The ZonedDateTime offset path is
// `Fn → lr → ur → br → ht(tz).format(epochMs)`, and `br` parses the result by
// `split(/[^\w]+/)` into exactly SEVEN word tokens — month, day, year, era,
// hour, minute, second — inverting the era itself (`o = 1 - o` for `B…`). So
// the load-bearing contract is the en-US *string* `M/D/Y AD, HH:MM:SS`, not a
// parts array. `formatToParts` is implemented too (it is the spec surface and
// the polyfill probes `"formatToParts" in ai.prototype`), but nothing on the
// fixed-offset path reads it.
//
// The bound this KEEPS. #5355 refuses `Intl.DateTimeFormat` in standalone
// because there is no ICU in pure Wasm. That bound is about CLDR/tzdata tables;
// `UTC` and the fixed-offset `Etc/GMT±N` zones need no tables at all, so they
// are answered here and *everything else still refuses*, with the same
// catchable `RangeError` as before. A refusal is what `hr`'s `try/catch`
// already expects, so an unsupported zone behaves exactly as it did.
//
// Every accepted spelling, canonical id, offset sign and format string below
// was measured against the real ICU implementation (`.tmp/s9/tz-probe*.mjs`,
// `fmt-probe.mjs`), not derived from the spec — including the three traps:
// `Etc/GMT+1` is UTC−1 (POSIX sign), `gmt+1` without the `Etc/` prefix is
// REJECTED while `gmt+0` is accepted, and a leading zero (`Etc/GMT+01`) is
// rejected.

/**
 * The JS source of the standalone `Intl.DateTimeFormat` replacement, as a set
 * of top-level declarations. `className` is the binding the caller puts in its
 * `Intl` object literal; the helpers are `__js2wasm_`-prefixed so they cannot
 * collide with the bundle's 340 top-level bindings.
 */
export function standaloneIntlDateTimeFormatSource(className: string, refusal: string): string {
  const deny = JSON.stringify([
    "weekday",
    "timeZoneName",
    "dateStyle",
    "timeStyle",
    "fractionalSecondDigits",
    "hourCycle",
    "calendar",
    "numberingSystem",
    "dayPeriod",
  ]);
  return `// #6442 — standalone Intl.DateTimeFormat, table-free zones only.
const __js2wasm_dtf_UTC = ["utc", "gmt", "gmt0", "gmt+0", "gmt-0", "greenwich", "zulu", "universal"];
const __js2wasm_dtf_DENY = ${deny};
function __js2wasm_dtf_lower(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : String.fromCharCode(c);
  }
  return out;
}
function __js2wasm_dtf_refuse(what) {
  throw new RangeError(${JSON.stringify(refusal)} + " (" + what + ")");
}
// Resolve a time-zone name to { id, offsetMinutes }, or undefined when it needs
// tzdata. Mirrors ICU exactly for the table-free set; see the header.
function __js2wasm_dtf_zone(name) {
  const lower = __js2wasm_dtf_lower(name);
  const etc = lower.slice(0, 4) === "etc/";
  const rest = etc ? lower.slice(4) : lower;
  for (let i = 0; i < __js2wasm_dtf_UTC.length; i++) {
    if (rest === __js2wasm_dtf_UTC[i]) return { id: "UTC", offsetMinutes: 0 };
  }
  if (!etc || rest.slice(0, 3) !== "gmt") return undefined;
  const sign = rest.slice(3, 4);
  if (sign !== "+" && sign !== "-") return undefined;
  const digits = rest.slice(4);
  if (digits.length < 1 || digits.length > 2) return undefined;
  for (let i = 0; i < digits.length; i++) {
    const c = digits.charCodeAt(i);
    if (c < 48 || c > 57) return undefined;
  }
  if (digits.charCodeAt(0) === 48) return undefined;
  const n = +digits;
  if (sign === "+" ? n > 12 : n > 14) return undefined;
  return { id: "Etc/GMT" + sign + digits, offsetMinutes: sign === "+" ? -60 * n : 60 * n };
}
// Proleptic-Gregorian civil date from a day number (Hinnant's civil_from_days),
// with the two divisions that can straddle zero done by exact remainder so the
// result is right for the whole ±8.64e15 ms range, not just for recent dates.
function __js2wasm_dtf_civil(days) {
  const z = days + 719468;
  let doe = z % 146097;
  let era = (z - doe) / 146097;
  if (doe < 0) {
    doe += 146097;
    era -= 1;
  }
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: yoe + era * 400 + (month <= 2 ? 1 : 0), month: month, day: day };
}
function __js2wasm_dtf_fields(value, offsetMinutes) {
  if (typeof value !== "number" || !(value >= -8640000000000000 && value <= 8640000000000000)) {
    throw new RangeError("Date value out of bounds");
  }
  const ms = value + offsetMinutes * 60000;
  let rem = ms % 86400000;
  let days = (ms - rem) / 86400000;
  if (rem < 0) {
    rem += 86400000;
    days -= 1;
  }
  const civil = __js2wasm_dtf_civil(days);
  return {
    year: civil.year <= 0 ? 1 - civil.year : civil.year,
    era: civil.year <= 0 ? "BC" : "AD",
    month: civil.month,
    day: civil.day,
    hour: Math.floor(rem / 3600000),
    minute: Math.floor(rem / 60000) % 60,
    second: Math.floor(rem / 1000) % 60,
  };
}
function __js2wasm_dtf_str(n) {
  return \`\${n}\`;
}
function __js2wasm_dtf_pad(n) {
  const s = __js2wasm_dtf_str(n);
  return n < 10 ? "0" + s : s;
}
function __js2wasm_dtf_present(v) {
  return v === undefined ? 0 : 1;
}
class ${className} {
  constructor(locales, options) {
    let locale = "en-US";
    if (locales !== undefined) {
      if (typeof locales !== "string") __js2wasm_dtf_refuse("locale");
      const lower = __js2wasm_dtf_lower(locales);
      if (lower === "en") locale = "en";
      else if (lower !== "en-us") __js2wasm_dtf_refuse("locale " + locales);
    }
    const o = options === undefined ? {} : options;
    if (typeof o !== "object" || o === null) __js2wasm_dtf_refuse("options");
    for (let i = 0; i < __js2wasm_dtf_DENY.length; i++) {
      if (o[__js2wasm_dtf_DENY[i]] !== undefined) __js2wasm_dtf_refuse("option " + __js2wasm_dtf_DENY[i]);
    }
    if (o.hour12 !== undefined && o.hour12 !== false) __js2wasm_dtf_refuse("hour12");
    if (o.era !== undefined && o.era !== "short") __js2wasm_dtf_refuse("era " + o.era);
    const names = ["year", "month", "day", "hour", "minute", "second"];
    for (let i = 0; i < names.length; i++) {
      const v = o[names[i]];
      if (v !== undefined && v !== "numeric" && v !== "2-digit") __js2wasm_dtf_refuse(names[i] + " " + v);
    }
    const dateCount =
      __js2wasm_dtf_present(o.year) + __js2wasm_dtf_present(o.month) + __js2wasm_dtf_present(o.day);
    const timeCount =
      __js2wasm_dtf_present(o.hour) + __js2wasm_dtf_present(o.minute) + __js2wasm_dtf_present(o.second);
    // The en-US pattern differs for every partial field set, so only the two
    // shapes whose string this can reproduce exactly are admitted: the ICU
    // DEFAULT (bare y/m/d — what \`Uo()\` builds to read the system zone) and a
    // full date with hh:mm[:ss] — what \`ht()\` builds for the offset path.
    if (dateCount !== 0 && dateCount !== 3) __js2wasm_dtf_refuse("partial date fields");
    if (timeCount === 1 || (timeCount === 2 && o.second !== undefined)) __js2wasm_dtf_refuse("partial time fields");
    if (dateCount === 0 && timeCount !== 0) __js2wasm_dtf_refuse("time-only");
    const tz = o.timeZone === undefined ? "UTC" : o.timeZone;
    if (typeof tz !== "string") __js2wasm_dtf_refuse("timeZone");
    const zone = __js2wasm_dtf_zone(tz);
    if (zone === undefined) throw new RangeError("Invalid time zone specified: " + tz);
    this._locale = locale;
    this._zone = zone;
    this._era = o.era !== undefined;
    this._time = timeCount;
  }
  format(value) {
    const f = __js2wasm_dtf_fields(value, this._zone.offsetMinutes);
    let out = __js2wasm_dtf_str(f.month) + "/" + __js2wasm_dtf_str(f.day) + "/" + __js2wasm_dtf_str(f.year);
    if (this._era) out += " " + f.era;
    if (this._time > 0) out += ", " + __js2wasm_dtf_pad(f.hour) + ":" + __js2wasm_dtf_pad(f.minute);
    if (this._time > 2) out += ":" + __js2wasm_dtf_pad(f.second);
    return out;
  }
  formatToParts(value) {
    const f = __js2wasm_dtf_fields(value, this._zone.offsetMinutes);
    const parts = [
      { type: "month", value: __js2wasm_dtf_str(f.month) },
      { type: "literal", value: "/" },
      { type: "day", value: __js2wasm_dtf_str(f.day) },
      { type: "literal", value: "/" },
      { type: "year", value: __js2wasm_dtf_str(f.year) },
    ];
    if (this._era) {
      parts.push({ type: "literal", value: " " });
      parts.push({ type: "era", value: f.era });
    }
    if (this._time > 0) {
      parts.push({ type: "literal", value: ", " });
      parts.push({ type: "hour", value: __js2wasm_dtf_pad(f.hour) });
      parts.push({ type: "literal", value: ":" });
      parts.push({ type: "minute", value: __js2wasm_dtf_pad(f.minute) });
    }
    if (this._time > 2) {
      parts.push({ type: "literal", value: ":" });
      parts.push({ type: "second", value: __js2wasm_dtf_pad(f.second) });
    }
    return parts;
  }
  resolvedOptions() {
    const r = {
      locale: this._locale,
      calendar: "gregory",
      numberingSystem: "latn",
      timeZone: this._zone.id,
    };
    if (this._time > 0) {
      r.hourCycle = "h23";
      r.hour12 = false;
    }
    if (this._era) r.era = "short";
    r.year = "numeric";
    r.month = "numeric";
    r.day = "numeric";
    if (this._time > 0) {
      r.hour = "2-digit";
      r.minute = "2-digit";
    }
    if (this._time > 2) r.second = "2-digit";
    return r;
  }
  formatRange() {
    __js2wasm_dtf_refuse("formatRange");
  }
  formatRangeToParts() {
    __js2wasm_dtf_refuse("formatRangeToParts");
  }
}
`;
}
