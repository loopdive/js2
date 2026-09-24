// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5383 — standalone Temporal long tail (S75 lane C). Each `describe` is the
// ≤15-line reduction of one root cause behind a cluster of failing standalone
// `built-ins/Temporal/**` rows, compiled host-free and run with no imports.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile, compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

async function runStandalone(source: string, fileName: string): Promise<Record<string, () => unknown>> {
  const result = await compile(source, {
    target: "standalone",
    allowJs: true,
    fileName,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  expect(result.imports, "#5383 standalone reductions must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return instance.exports as Record<string, () => unknown>;
}

// Root cause 1: `let m = qr(x)` types `m` as the closed record qr returns;
// `m = Jr(e, t)` then assigns Jr's `{date, time}` whose `date` came from an
// untyped parameter — a dynamic `$Object` carried as externref. The field-wise
// struct narrowing tested that externref against the closed `date` record,
// missed, and stored NULL (host mode rebuilt it by name since #5243; the
// host-free lane refused). Polyfill shape: `Duration.prototype.round` →
// `m = Jr({years:0,…}, $o(m.time, …))` → `_r(m)` reads `e.date.years` →
// "Cannot access property on null or undefined" (28 rows).
const RECORD_FROM_DYNAMIC = `
class TD { constructor(s) { this.sec = s; } }
function qr(x) { return { date: { years: 1, months: 2 }, time: new TD(x) }; }
function Jr(e, t) { return { date: e, time: t }; }
export function years() { let m = qr(25); m = Jr({ years: 7, months: 0 }, m.time); return m.date.years; }
export function nested() { let m = qr(25); m = Jr({ years: 7, months: 3 }, m.time); return m.date.months * 100 + m.time.sec; }
export function nullStays() { let m = qr(25); m = Jr(null, m.time); return m.date === null ? 1 : 0; }
`;

describe("#5383 lane C — a dynamic object narrowed into a closed record keeps its data", () => {
  it("standalone: the record field is rebuilt by name instead of nulled", async () => {
    const ex = await runStandalone(RECORD_FROM_DYNAMIC, "issue-5383-record-from-dynamic.js");
    expect(ex.years!()).toBe(7);
    expect(ex.nested!()).toBe(325);
    expect(ex.nullStays!()).toBe(1);
  }, 120_000);
});

// Root cause 2: a JS parameter whose every call site passes a BigInt is typed
// as a bigint-branded i64. Both `typeof` lowerings pushed that i64 straight at
// the externref `__typeof*` helper and the stack fix-up boxed it as a NUMBER,
// so `typeof e` answered "number" and `"bigint" == typeof e` was false. The
// polyfill's `ToNumber` guard (`qe`) is exactly that shape.
const TYPEOF_BIGINT_PARAM = `
function cmp(e) { return "bigint" == typeof e ? 1 : 0; }
function val(e) { const t = typeof e; return t === "bigint" ? 1 : t === "number" ? 2 : 3; }
export function viaCompare() { return cmp(2n); }
export function viaValue() { return val(2n); }
`;

describe("#5383 lane C — typeof a bigint-typed parameter", () => {
  it("standalone: answers bigint in both the comparison and the value form", async () => {
    const ex = await runStandalone(TYPEOF_BIGINT_PARAM, "issue-5383-typeof-bigint-param.js");
    expect(ex.viaCompare!()).toBe(1);
    expect(ex.viaValue!()).toBe(1);
  }, 120_000);
});

// Root cause 3: a `bigint` property is an i64 struct slot. Read through a
// DYNAMIC receiver it boxed as a NUMBER in both dynamic-read paths: the
// `__get_member_<name>` dispatcher's field box (`coercionInstrs` → the numeric
// `coercionPlan` row) and the closed-struct `__extern_get` ladder (which
// skipped i64 slots entirely, so `o[k]` answered undefined). The polyfill's
// `GetRoundingIncrementOption` reads `options.roundingIncrement` this way and
// must see the BigInt to throw the spec's TypeError.
const BIGINT_SLOT_DYNAMIC_READ = `
function kind(v) { return typeof v === "bigint" ? 1 : typeof v === "number" ? 2 : typeof v === "undefined" ? 3 : 4; }
function dot(e) { const t = e.inc; return kind(t); }
function computed(o, k) { return kind(o[k]); }
function mk() { const o = {}; o.inc = 2n; return o; }
export function viaDot() { dot({ inc: 3 }); return dot(mk()); }
export function viaComputed() { const o = { a: 1, inc: 2n }; return computed(o, "inc"); }
export function numberStays() { return dot({ inc: 3 }); }
`;

describe("#5383 lane C — a bigint struct slot read through a dynamic receiver", () => {
  it("standalone: boxes as a BigInt on the dot and the computed path", async () => {
    const ex = await runStandalone(BIGINT_SLOT_DYNAMIC_READ, "issue-5383-bigint-slot-read.js");
    expect(ex.viaDot!()).toBe(1);
    expect(ex.viaComputed!()).toBe(1);
    expect(ex.numberStays!()).toBe(2);
  }, 120_000);
});

// Root cause 4: across a standalone wasm↔wasm link the provider's Phase-3 vote
// sees only ITS OWN struct types. `DEFAULTS` carries an f64 `inc`, so the vote
// narrowed `o.inc` to f64 — and a consumer-built `{ inc: 2n }` / `{ inc: "2" }`
// came back through `__unbox_number` as the NUMBER 2. Polyfill shape:
// `GetRoundingIncrementOption(options)` reads `options.roundingIncrement`, so
// the spec's BigInt TypeError became a RangeError.
const LINK_PROVIDER = `
  const DEFAULTS = { inc: 1 };
  function kind(t) { return typeof t === "bigint" ? 1 : typeof t === "string" ? 2 : typeof t === "number" ? 3 : 4; }
  export const NS = Object.freeze({
    __proto__: null,
    readInc(o) { var t = o.inc; return kind(t); },
    ownDefault() { return DEFAULTS.inc + 10; },
  });`;

const LINK_CONSUMER = `
  export function bigintInc() { return NS.readInc({ inc: 2n }); }
  export function stringInc() { return NS.readInc({ inc: "2" }); }
  export function numberInc() { return NS.readInc({ inc: 2 }); }
  export function absentInc() { return NS.readInc({ other: 2 }); }
  export function ownDefault() { return NS.ownDefault(); }
`;

/** Provider compiled as a linked package, consumer linked against it (the #6600 harness). */
async function linkedPair(provider: string, consumer: string): Promise<Record<string, () => unknown>> {
  const standalone = { target: "standalone" as const, hostBridge: "off" as const };
  const root = mkdtempSync(join(tmpdir(), "issue-5383-tail-"));
  const packageRoot = join(root, "node_modules", "ns5383c");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns5383c", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns5383c";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...standalone,
  } as never);
  expect(built.success, built.errors.map((item) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item) => item.packageName === "ns5383c")!;
  const field = artifact.exportBoundaries!.NS!.field;
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
      "/__main.js": `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\n${consumer}`,
    },
    "/__main.js",
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [artifact.namespace],
      linkedPackageBindings: new Map([[field, { module: artifact.namespace, field }]]),
      ...standalone,
    } as never,
  );
  (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  return instance.exports as unknown as Record<string, () => unknown>;
}

describe("#5383 lane C — a dynamic read inside a linked standalone provider", () => {
  it("keeps the consumer's BigInt / string value instead of the local f64 vote", { timeout: 600_000 }, async () => {
    const ex = await linkedPair(LINK_PROVIDER, LINK_CONSUMER);
    expect(ex.bigintInc!()).toBe(1);
    expect(ex.stringInc!()).toBe(2);
    // Controls: a number stays a number, an absent key stays undefined, and
    // the provider's own struct read is unchanged.
    expect(ex.numberInc!()).toBe(3);
    expect(ex.absentInc!()).toBe(4);
    expect(ex.ownDefault!()).toBe(11);
  });
});

// Root cause 6: call-site parameter inference trusted an `any` IDENTIFIER
// argument as neutral. `fmt(…, "auto")` / `fmt(…, "minute")` then agreed on a
// native-string param, and `fmt(…, p)` — `p` destructured from a record whose
// `precision` is sometimes a number — handed 3 to a string slot, which
// arrived as null: every numeric precision printed "12:34:56." (Temporal's
// `Vn`/`tr`/`Kn` chain, 37 toString rounding rows). Same for an f64
// agreement handed the string "auto" (NaN). The fix that landed is #2917's
// (`forwardedParamAbiType` in param-return-inference.ts); this guard keeps the
// literal-site agreement (`autoStays`) and the numeric direction (`viaNumber`)
// that its own witness does not assert.
const FORWARDED_ANY_IDENTIFIER = `
function frac(ns, digits) { if ("auto" === digits) return ".auto"; if (0 === digits) return ""; return "." + String(ns).padStart(9, "0").slice(0, digits); }
function fmt(s, ns, digits) { return "minute" === digits ? "" + s : s + frac(ns, digits); }
function spec(t) { return { precision: t, unit: "x" }; }
function show(t) { const { precision: p } = spec(t); return fmt(56, 987650000, p); }
function lit() { return fmt(56, 1, "auto") + fmt(56, 1, "minute"); }
function numFrac(ns, d) { return frac(ns, d); }
export function viaString() { return show(3) === "56.987" ? 1 : 0; }
export function autoStays() { return show("auto") === "56.auto" && lit() === "56.auto56" ? 1 : 0; }
export function viaNumber() { return numFrac(5, 2) + frac(987650000, "auto") === ".00.auto" ? 1 : 0; }
`;

describe("#5383 lane C — an any identifier argument does not prove a string/scalar parameter", () => {
  it("standalone: the forwarded number reaches the string-agreed param intact", async () => {
    const ex = await runStandalone(FORWARDED_ANY_IDENTIFIER, "issue-5383-forwarded-any-identifier.js");
    expect(ex.viaString!()).toBe(1);
    expect(ex.autoStays!()).toBe(1);
    expect(ex.viaNumber!()).toBe(1);
  }, 120_000);
});

// Root cause 5:`for (const x of H.ISO.list())` first compiles the iterable
// TENTATIVELY (is it a vec?). With runtime-eval dynamic globals the method call
// emits a guarded cast, which records its anyref backup slot on the fctx; the
// probe rolls its locals back but kept that record. The body's next null guard
// (`NS.P.from`) then read the truncated slot — re-allocated as externref — with
// `ref.test <struct>`: invalid wasm in `__module_init_chunk_N` (13 Temporal
// rows: every `TemporalHelpers.ISO.*Strings*()` loop).
const FOR_OF_PROBE_ROLLBACK = `
var $262 = { evalScript: function (s) { return __js2wasm_global_script_eval(s); } };
var H = { ISO: { list() { return ["ab", "cde"]; } } };
var NS = { P: { from(x) { return { len: x.length }; } } };
var total = 0;
for (const input of H.ISO.list()) {
  const p = NS.P.from(input);
  total += p.len;
}
export function t1() { return total; }
`;

describe("#5383 lane C — a rolled-back for-of probe does not leak its guarded-cast backup", () => {
  it("standalone: the module validates", async () => {
    const result = await compileMulti({ "/main.js": FOR_OF_PROBE_ROLLBACK }, "/main.js", {
      target: "standalone",
      allowJs: true,
      hostBridge: "off",
      skipSemanticDiagnostics: true,
    } as never);
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(() => new WebAssembly.Module(result.binary)).not.toThrow();
  }, 120_000);
});

// Root cause 7: `recv.valueOf()` on an `any` receiver lowers to
// `__dyn_valueOf`, which ran a receiver's own `valueOf` only for the module's
// own `$Object` carrier and answered Object.prototype.valueOf (identity) for
// anything else. Across a standalone link the receiver is the PEER's object —
// a Temporal instance whose prototype `valueOf` must throw a TypeError — so all
// eight `*/prototype/valueOf/basic.js` rows saw no exception.
const VALUEOF_PROVIDER = `
class Stamp {
  constructor(n) { this.n = n; }
  valueOf() { throw new TypeError("no valueOf"); }
}
class Plain { constructor(n) { this.n = n; } }
export const NS = { stamp: new Stamp(1), plain: new Plain(2) };
`;
const VALUEOF_CONSUMER = `
function kind(f) { try { f(); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; } }
export function throwsOwn() { const s = NS.stamp; return kind(() => s.valueOf()); }
export function plainIdentity() { const p = NS.plain; return p.valueOf() === p ? 1 : 0; }
`;

describe("#5383 lane C — valueOf() on a linked peer's object runs the peer's method", () => {
  it("the peer's throwing valueOf throws; a peer without one stays identity", { timeout: 600_000 }, async () => {
    const ex = await linkedPair(VALUEOF_PROVIDER, VALUEOF_CONSUMER);
    expect(ex.throwsOwn!()).toBe(1);
    expect(ex.plainIdentity!()).toBe(1);
  });
});

// Root cause 8: `const props = {}` whose property is written only LATER
// (`props.minute = 30`) was widened into a closed struct allocated with
// `minute` already present (a numeric slot at 0). A callee handed `props`
// before the write saw `props.minute === 0` and `"minute" in props`, so
// Temporal's property-bag reader found a time unit on an empty bag and never
// threw its TypeError (9 `plaintime-propertybag-no-time-units` rows).
const USE_BEFORE_WRITE = `
function rd(b) { return b.minute === undefined ? 1 : 0; }
function hs(b) { return ("minute" in b) ? 1 : 0; }
function ks(b) { return Object.keys(b).length; }
const props = {};
const r1 = rd(props), r2 = hs(props), r3 = ks(props);
props.minute = 30;
export function absentRead() { return r1; }
export function absentIn() { return r2; }
export function absentKeys() { return r3; }
export function afterWrite() { return props.minute + rd(props) * 10 + hs(props) * 100 + ks(props) * 1000; }
`;

describe("#5383 lane C — an empty object used before its first property write", () => {
  it("standalone: the not-yet-written property is absent, then present", async () => {
    const ex = await runStandalone(USE_BEFORE_WRITE, "use-before-write.js");
    expect(ex.absentRead!()).toBe(1);
    expect(ex.absentIn!()).toBe(0);
    expect(ex.absentKeys!()).toBe(0);
    expect(ex.afterWrite!()).toBe(1130);
  }, 120_000);
});

// Root cause 9: the consumer's `__extern_method_call` asks the provider's
// method-call terminal first, and takes a `null` answer to mean "not my
// receiver". A provider method that RETURNS null fell through to the local
// miss path and threw "called value is not a function"
// (`ZonedDateTime#getTimeZoneTransition` on UTC / offset zones, 3 rows).
const NULL_METHOD_PROVIDER = `
class Zone {
  constructor(n) { this.n = n; }
  transition(dir) { if (dir === "next") return null; return { at: this.n }; }
}
export const NS = { zone: new Zone(7) };
`;
const NULL_METHOD_CONSUMER = `
function kind(f) { try { return f(); } catch (e) { return e instanceof TypeError ? -1 : -2; } }
export function nullResult() { const z = NS.zone; return kind(() => (z.transition("next") === null ? 1 : 0)); }
export function objectResult() { const z = NS.zone; return kind(() => z.transition("prev").at); }
export function localMissStillThrows() { const z = NS.zone; return kind(() => z.missing()); }
`;

// Root cause 10: an `any`-receiver `includes`/`startsWith`/`endsWith` lowers
// through the guarded native-string dispatch, whose i32 result carried no
// boolean brand, so storing it anywhere `any` boxed it as the NUMBER 0/1:
// `monthCode.endsWith("L") === false` was false (4 `no-leap-months` rows).
const STRING_PREDICATE_ANY = `
function mk() { return { s: "M03" }; }
var o = mk();
function get(x) { return x.s; }
export function ends() { const r = get(o).endsWith("L"); return r === false ? 1 : typeof r === "number" ? 2 : 3; }
export function starts() { const r = get(o).startsWith("M"); return r === true ? 1 : typeof r === "number" ? 2 : 3; }
export function incl() { return typeof get(o).includes("0") === "boolean" ? 1 : 0; }
`;

describe("#5383 lane C — a string predicate on an any receiver answers a boolean", () => {
  it("standalone: endsWith / startsWith / includes stay booleans", async () => {
    const ex = await runStandalone(STRING_PREDICATE_ANY, "string-predicate-any.js");
    expect(ex.ends!()).toBe(1);
    expect(ex.starts!()).toBe(1);
    expect(ex.incl!()).toBe(1);
  }, 120_000);
});

// Root cause 11: the provider's class-construct trampoline padded a MISSING
// argument with the formal's zero value, so a defaulted `f64` formal never
// saw the omitted-argument sentinel its default prologue keys on:
// `new NS.PlainMonthDay(5, 2)` ran with `referenceISOYear = 0` instead of
// `= 1972` (21 PlainMonthDay rows). The fix that landed is #6668's
// (`missingArgInstrs` in standalone-class-construct.ts); this guard covers the
// LINKED provider/consumer pair, which #6668's single-module witness does not.
const DEFAULT_PARAM_PROVIDER = `
function num(x) { return +x; }
class P { constructor(e, n = "iso", r = 1972) { this.m = num(e); this.c = n; this.y = num(r); } }
export const NS = { P };
`;
const DEFAULT_PARAM_CONSUMER = `
export function omitted() { return new NS.P(5).y; }
export function omittedAfterString() { return new NS.P(5, "x").y; }
export function passed() { return new NS.P(5, "x", 1980).y; }
export function stringDefault() { return new NS.P(5).c === "iso" ? 1 : 0; }
`;

describe("#5383 lane C — a linked class constructor's defaulted parameter", () => {
  it("an omitted argument runs the default; a passed one is kept", { timeout: 600_000 }, async () => {
    const ex = await linkedPair(DEFAULT_PARAM_PROVIDER, DEFAULT_PARAM_CONSUMER);
    expect(ex.omitted!()).toBe(1972);
    expect(ex.omittedAfterString!()).toBe(1972);
    expect(ex.passed!()).toBe(1980);
    expect(ex.stringDefault!()).toBe(1);
  });
});

// Root cause 12: `<any> op <bigint>` was a compile-time "provable mix" in
// standalone and always threw, so a BigInt read through an untyped boundary
// could not be used: `Temporal.Now.instant().epochNanoseconds / 1000000n`.
const ANY_BIGINT_OPERAND = `
function k(e) { return e instanceof TypeError ? -60 : -50; }
function id(x) { return x; }
export function div() { const e = id(10n); return Number(e / 5n); }
export function subRight() { const e = id(7n); return Number(20n - e); }
export function pow() { const e = id(2n); return Number(e ** 10n); }
export function numberStillThrows() { try { const e = id(3); return Number(e * 5n); } catch (e) { return k(e); } }
export function stringStillThrows() { try { const e = id("7"); return Number(5n - e); } catch (e) { return k(e); } }
`;

describe("#5383 lane C — an any operand that is a BigInt at runtime", () => {
  it("standalone: the BigInt operator runs; a non-BigInt still throws the mix TypeError", async () => {
    const ex = await runStandalone(ANY_BIGINT_OPERAND, "any-bigint-operand.js");
    expect(ex.div!()).toBe(2);
    expect(ex.subRight!()).toBe(13);
    expect(ex.pow!()).toBe(1024);
    expect(ex.numberStillThrows!()).toBe(-60);
    expect(ex.stringStillThrows!()).toBe(-60);
  }, 120_000);
});

describe("#5383 lane C — a linked peer method that returns null", () => {
  it("answers null instead of throwing; a missing method still throws", { timeout: 600_000 }, async () => {
    const ex = await linkedPair(NULL_METHOD_PROVIDER, NULL_METHOD_CONSUMER);
    expect(ex.nullResult!()).toBe(1);
    expect(ex.objectResult!()).toBe(7);
    expect(ex.localMissStillThrows!()).toBe(-1);
  });
});
