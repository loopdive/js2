// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4655) `Array.prototype.toLocaleString` asks each element for `toString`,
// not `toLocaleString`.
//
//   var n = 0, obj = { toLocaleString: function () { n++; return "L"; } };
//   [obj, obj].toLocaleString();   // was "[object Object],[object Object]", n === 0
//                                  // spec: "L,L", n === 2
//
// Since #2863 Phase 2 the standalone/wasi lane dispatched `toLocaleString` into
// the `join`/`toString` lowering because the locale-independent separator is
// the same comma. That is right about the SEPARATOR and wrong about the
// ELEMENT: §23.1.3.32 step 6.c.i is `ToString(? Invoke(nextElement,
// "toLocaleString"))`.
//
// ## Why the CONTROLS are the point of this file
//
// "The element's own method is not consulted" is a plausible root that would
// have been WRONG, and only a control distinguishes it: `[o, o].toString()`
// with `o = { toString: … }` calls `o.toString` twice on base. The reflective
// element dispatch works; the wrong METHOD NAME was being asked for. Every
// residual below therefore carries the positive control that pins its root to
// the specific claim rather than to the general area (campaign brief,
// methodology 8) — several of them exist because the control REFUTED the
// attribution recorded in a prior lane's issue file.
//
// ## Why these pins drive `runTest262File`, not a bare `compile()`
//
// Same reason as #4485/#4621/#4639/#4640/#4641: the test262 lane injects a
// harness (`deferTopLevelInit`, the `$262` prelude, a tag-bearing
// `Test262Error`) that changes which lowering fires, and a bare probe disagrees
// with the lane in both directions.
//
// ## Why every pin below is loop-carried
//
// A pin that asserts a shape is not a pin that exercises the shape. The array
// under test is BUILT in a loop from a runtime-carried counter, so no
// constant-folding pass can answer `arr.toLocaleString()` without emitting the
// element step. Verified by reverting `src/codegen/array-methods.ts` +
// `array-tolocalestring.ts` from the `.tmp/base-*` copies — see
// `## Test Results` in the issue file for the per-pin before/after.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(HARNESS);

/**
 * (#4003 CI-LOAD MITIGATION, copied from `tests/issue-4621.test.ts` where it is
 * measured A/B.) `runTest262File` compiles AND runs a standalone module
 * synchronously inside the vitest worker; a couple of dozen back to back starve
 * the worker's event loop, so queued birpc reporter calls miss their deadline
 * and vitest aborts with `Timeout calling "onTaskUpdate"` — exiting NONZERO
 * while every assertion PASSED.
 */
afterEach(async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
});

/** A runtime-carried counter, so no arm below can be constant-folded away. */
const LOOP_CARRIED = `var __n = 0; for (var __i = 0; __i < 3; __i++) { __n += __i; } /* __n === 3 */`;

function pinRow(rel: string, note?: string): void {
  it.skipIf(!TEST262)(`${rel}${note ? ` — ${note}` : ""}`, { timeout: 60_000 }, async () => {
    const abs = join(__dirname, "..", "test262", "test", rel);
    const r = await runTest262File(abs, "issue-4655", 30_000, "standalone");
    expect(`${r.status}: ${r.error ?? ""}`).toBe("pass: ");
  });
}

/**
 * A pin whose SOURCE is synthetic — no test262 row covers the shape — run
 * through `runTest262File` so it gets the same injected harness every corpus
 * pin does. `runTest262File` takes any absolute path.
 */
async function runSource(name: string, source: string): Promise<string> {
  const dir = join(__dirname, "..", ".tmp", "issue-4655-pins");
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${name}.js`);
  writeFileSync(abs, source);
  const r = await runTest262File(abs, "issue-4655", 30_000, "standalone");
  return `${r.status}: ${r.error ?? ""}`;
}

function pinSource(name: string, source: string, note: string): void {
  it.skipIf(!TEST262)(`${name} — ${note}`, { timeout: 60_000 }, async () => {
    expect(await runSource(name, source)).toBe("pass: ");
  });
}

/** An `it.fails` residual: the shape STILL fails, and the suite says so. */
function failSource(name: string, source: string, note: string): void {
  it.skipIf(!TEST262).fails(`RESIDUAL ${name} — ${note}`, { timeout: 60_000 }, async () => {
    expect(await runSource(name, source)).toBe("pass: ");
  });
}

describe("#4655 — the element step of Array.prototype.toLocaleString", () => {
  pinRow(
    "built-ins/Array/prototype/toLocaleString/S15.4.4.3_A1_T1.js",
    "the element's own toLocaleString is invoked once per non-nullish element",
  );
  pinRow(
    "built-ins/Array/prototype/toLocaleString/S15.4.4.3_A3_T1.js",
    "…including at an index inherited from Array.prototype",
  );

  pinSource(
    "element-invoke",
    `${LOOP_CARRIED}
     var n = 0;
     var obj = { toLocaleString: function () { n++; return "L" + __n; } };
     var arr = [];
     for (var i = 0; i < __n; i++) { arr[i] = obj; }
     var s = arr.toLocaleString();
     assert.sameValue(n, 3, "invocations: " + n);
     assert.sameValue(s, "L3,L3,L3", "rendered: " + s);`,
    "invoked once per element, result is ToString of the return value",
  );

  pinSource(
    "nullish-elements-render-empty",
    `${LOOP_CARRIED}
     var n = 0;
     var obj = { toLocaleString: function () { n++; return "L"; } };
     var arr = [undefined, obj, null, obj, obj];
     var s = arr.toLocaleString();
     assert.sameValue(n, 3, "invocations: " + n);
     assert.sameValue(s, ",L,,L,L", "rendered: " + s);`,
    "§23.1.3.32 step 6.c skips undefined/null without invoking anything",
  );

  pinSource(
    "reserved-arguments-are-not-a-separator",
    `${LOOP_CARRIED}
     var obj = { toLocaleString: function () { return "L"; } };
     var arr = [];
     for (var i = 0; i < __n - 1; i++) { arr[i] = obj; }
     var s = arr.toLocaleString("|", { useGrouping: false });
     assert.sameValue(s, "L,L", "locales/options must not be read as join's separator: " + s);`,
    "toLocaleString(locales, options) is not join(separator)",
  );

  pinSource(
    "borrowed-receiver",
    `${LOOP_CARRIED}
     var n = 0;
     var obj = { toLocaleString: function () { n++; return "L"; } };
     var arr = [];
     for (var i = 0; i < __n - 1; i++) { arr[i] = obj; }
     var s = Array.prototype.toLocaleString.call(arr);
     assert.sameValue(n, 2, "invocations through the borrow: " + n);
     assert.sameValue(s, "L,L", "rendered: " + s);`,
    "the Array.prototype.<m>.call synthetic rewrite reaches the same lowering",
  );

  // ── CONTROLS: what the fix must NOT have changed ────────────────────────
  //
  // The first is the control that refuted the obvious root. It passes on BOTH
  // arms; it is here so that a future change which "fixes" element dispatch in
  // general — rather than the method NAME — cannot repair the pins above while
  // silently rerouting `toString`.
  pinSource(
    "control-toString-stays-reflective",
    `${LOOP_CARRIED}
     var m = 0;
     var o = { toString: function () { m++; return "T"; } };
     var arr = [];
     for (var i = 0; i < __n - 1; i++) { arr[i] = o; }
     // ONE call: the invocation count is the assertion, so re-calling inside a
     // failure message would double it (that mistake made this control red
     // while the compiler was answering correctly).
     var ts = arr.toString();
     assert.sameValue(ts, "T,T", "toString: " + ts);
     assert.sameValue(m, 2, "toString invocations: " + m);`,
    "CONTROL — Array.prototype.toString still asks the element for toString",
  );

  pinSource(
    "control-join-separator-unchanged",
    `${LOOP_CARRIED}
     var arr = [];
     for (var i = 0; i < __n; i++) { arr[i] = i; }
     assert.sameValue(arr.join("|"), "0|1|2", "join: " + arr.join("|"));
     assert.sameValue(arr.join(), "0,1,2", "default join: " + arr.join());
     assert.sameValue(arr.toString(), "0,1,2", "toString: " + arr.toString());`,
    "CONTROL — join still reads its first argument as the separator",
  );

  pinSource(
    "control-numeric-tolocalestring-unchanged",
    `${LOOP_CARRIED}
     var arr = [];
     for (var i = 0; i < __n; i++) { arr[i] = i + 1; }
     assert.sameValue(arr.toLocaleString(), "1,2,3", "numeric: " + arr.toLocaleString());
     var flags = [];
     for (var j = 0; j < __n - 1; j++) { flags[j] = j === 0; }
     assert.sameValue(flags.toLocaleString(), "true,false", "boolean: " + flags.toLocaleString());`,
    "CONTROL — the primitive element arms are deliberately untouched",
  );
});

describe("#4655 — measured residuals, each with the control that pins its root", () => {
  // ── R1. PRIMITIVE element arms do not Invoke ────────────────────────────
  // Root: the f64/i32/boolean arms render through `number_toString` / a native
  // "true"/"false" literal, so an OVERRIDDEN primitive prototype method is
  // invisible. Owner: #4655 follow-on (needs per-element boxing on those arms —
  // deliberately declined here, see array-tolocalestring.ts "Deliberate scope").
  // test262 `toLocaleString/primitive_this_value{,_getter}.js`.
  failSource(
    "R1-primitive-prototype-override",
    `${LOOP_CARRIED}
     Boolean.prototype.toString = function () { return "B" + __n; };
     var arr = [];
     for (var i = 0; i < __n - 1; i++) { arr[i] = i === 0; }
     var s = arr.toLocaleString();
     assert.sameValue(s, "B3,B3", "overridden Boolean.prototype.toString: " + s);`,
    "an overridden PRIMITIVE prototype method is not consulted by the element step",
  );
  // POSITIVE CONTROL for R1 — without it, a future change that stopped
  // rendering booleans at all would "repair" the pin above and read as green.
  pinSource(
    "R1-control-unoverridden-boolean",
    `${LOOP_CARRIED}
     var arr = [];
     for (var i = 0; i < __n - 1; i++) { arr[i] = i === 0; }
     assert.sameValue(arr.toLocaleString(), "true,false", "boolean: " + arr.toLocaleString());`,
    "CONTROL for R1 — an UN-overridden boolean element still renders true/false",
  );

  // ── R2. `Array.prototype.toLocaleString` read as a VALUE ────────────────
  // Root: the builtin-as-value carrier family. Owner: dev-4515 cluster C1 —
  // the SAME error text as `Array.prototype.concat` as a value, which that lane
  // owns. test262 `toLocaleString/{resizable-buffer,
  // user-provided-tolocalestring-grow,-shrink}.js`.
  failSource(
    "R2-tolocalestring-as-a-value",
    `${LOOP_CARRIED}
     var f = Array.prototype.toLocaleString;
     var arr = [];
     for (var i = 0; i < __n; i++) { arr[i] = i; }
     assert.sameValue(f.call(arr), "0,1,2", "read as a value then called");`,
    "reading Array.prototype.toLocaleString as a VALUE throws (dev-4515 cluster C1)",
  );
  // POSITIVE CONTROL for R2 — the CALL spelling works, so R2 is about the read,
  // not about the method.
  pinSource(
    "R2-control-direct-call",
    `${LOOP_CARRIED}
     var arr = [];
     for (var i = 0; i < __n; i++) { arr[i] = i; }
     assert.sameValue(Array.prototype.toLocaleString.call(arr), "0,1,2", "direct call");`,
    "CONTROL for R2 — the same method CALLED (not read) works",
  );

  // ── R3. A nullish element coerced into a REUSED numeric carrier ─────────
  // This corrects #4641's residual R4, which recorded the root as "a `null`
  // element materializes as `f64.const 0`, needs a third sNaN payload". The
  // control below is the refutation: the SAME expression standing alone renders
  // ",1,,3" and answers `x[2] === null` TRUE. The defect is carrier SELECTION
  // for a reassigned variable whose wasm type was fixed by an earlier numeric
  // array — #3580's union-collapse at the local/var slot. test262
  // `toString/S15.4.4.2_A1_T2.js`.
  failSource(
    "R3-nullish-into-a-reused-numeric-carrier",
    `${LOOP_CARRIED}
     var x = new Array(0, 1, 2, __n);
     x = Array(undefined, 1, null, __n);
     assert.sameValue(x.toString(), ",1,,3", "reused carrier: " + x.toString());`,
    "a null element assigned into a var already typed number[] renders 0 (#3580, not a missing NULL payload)",
  );
  // POSITIVE CONTROL for R3 — the discriminator. It PASSES, which is what makes
  // R3 a statement about the variable rather than about `null` elements.
  pinSource(
    "R3-control-standalone-expression",
    `${LOOP_CARRIED}
     var y = Array(undefined, 1, null, __n);
     assert.sameValue(y.toString(), ",1,,3", "standalone: " + y.toString());
     assert.sameValue(y[2], null, "element identity");
     assert.sameValue(typeof y[2], "object", "element typeof");`,
    "CONTROL for R3 — the SAME expression in a fresh var is fully correct",
  );

  // ── R4. concat loses hole / inherited-index resolution ──────────────────
  // MEASURED: a hole and an `Array.prototype[k]`-inherited index are both
  // correct when read directly (the control below) and both become a plain NaN
  // after crossing `concat` — `typeof arr[0]` is `"number"` where the spec says
  // `"undefined"`, and `arr.join("|")` renders `"NaN|1|NaN"`.
  // SUSPECTED ROOT (labelled, not asserted — I did not falsify it): the §23.1.3.1
  // loop pushes into a `$ObjVec` of externref while the result SLOT is still
  // statically `number[]`. The one observation that would discriminate is
  // whether the value INSIDE the container is already NaN or only becomes one
  // on the way out; `join` on the result also says NaN, which is evidence
  // AGAINST a pure read-side unbox and was not chased further.
  // test262 `concat/S15.4.4.4_A1_T4.js`, `A3_T{1,2,3}.js`. Owner: value-rep /
  // the concat result-carrier slice.
  failSource(
    "R4-concat-loses-the-hole",
    `${LOOP_CARRIED}
     var x = [, __n];
     var arr = x.concat([], [, ]);
     assert.sameValue(arr.length, 3, "length: " + arr.length);
     assert.sameValue(arr[0], undefined, "hole through concat: " + String(arr[0]));`,
    "a hole crossing concat becomes NaN — the result slot is still number[]",
  );
  // POSITIVE CONTROL for R4 — the hole itself is represented correctly; only
  // the trip through concat loses it.
  pinSource(
    "R4-control-hole-read-directly",
    `${LOOP_CARRIED}
     var x = [, __n];
     assert.sameValue(x[0], undefined, "direct hole read");
     assert.sameValue(typeof x[0], "undefined", "direct hole typeof");
     assert.sameValue(x.join("|"), "|3", "direct hole join: " + x.join("|"));`,
    "CONTROL for R4 — the same hole read WITHOUT concat is already correct",
  );

  // ── R5. `length` whose valueOf is INHERITED ─────────────────────────────
  // Narrowed, NOT rooted — stated as a hypothesis per the brief's methodology
  // 8. #4641's R7 recorded this as "`length` is an OBJECT needing ToPrimitive";
  // the control below refutes that: an OWN `valueOf` on the length object works
  // end-to-end through the same `Array.prototype.forEach.call`. What is left is
  // the inherited-via-constructor-prototype case, and an inherited `valueOf` is
  // reachable in isolation (`String(child.valueOf())` answers 2, `child * 1`
  // answers 2), so the miss is specific to the array-like `length` read.
  // test262 `forEach/15.4.4.18-3-23.js`. Owner: unclaimed — see the issue.
  failSource(
    "R5-array-like-length-with-inherited-valueOf",
    `${LOOP_CARRIED}
     var proto = { valueOf: function () { return 2; } };
     var Con = function () {};
     Con.prototype = proto;
     var child = new Con();
     child.toString = function () { return "1"; };
     var seen = "";
     var obj = { 0: 11, 1: 9, length: child };
     Array.prototype.forEach.call(obj, function (v, i) { seen += i + ":" + v + ";"; });
     assert.sameValue(seen, "0:11;1:9;", "visited: " + seen);`,
    "an array-like whose length has an INHERITED valueOf visits no index",
  );
  // POSITIVE CONTROL for R5 — the OWN-valueOf twin, which is what makes R5 a
  // claim about inheritance rather than about ToPrimitive on `length`.
  pinSource(
    "R5-control-own-valueOf-length",
    `${LOOP_CARRIED}
     var lenObj = { valueOf: function () { return 2; } };
     var seen = "";
     var obj = { 0: 11, 1: 9, length: lenObj };
     Array.prototype.forEach.call(obj, function (v, i) { seen += i + ":" + v + ";"; });
     assert.sameValue(seen, "0:11;1:9;", "visited: " + seen);`,
    "CONTROL for R5 — an OWN valueOf on the length object works end to end",
  );

  // ── R6. heterogeneous array elements are read back as objects ───────────
  // Root: the #1888 / #2141-S4 tag-5 boxing lie. This is what actually blocks
  // `filter/15.4.4.20-9-b-*`, not the descriptor MOP: measured with NO
  // `Object.defineProperty` anywhere, `[0,1,2,"last"].filter(() => true)`
  // answers `[0,1,[object Object],[object Object]]`.
  failSource(
    "R6-heterogeneous-element-tag",
    `${LOOP_CARRIED}
     var arr = [0, 1, 2, "last"];
     var out = arr.filter(function () { return true; });
     assert.sameValue(out.length, 4, "length: " + out.length);
     assert.sameValue(out[2], 2, "numeric element survives: " + String(out[2]));
     assert.sameValue(out[3], "last", "string element survives: " + String(out[3]));`,
    "a heterogeneous element reads back as [object Object] (#1888 / #2141-S4)",
  );
  // POSITIVE CONTROL for R6 — the HOMOGENEOUS twin, including the
  // mid-iteration `length` shrink that a prior lane suspected. It passes, which
  // is what isolates R6 to element representation.
  pinSource(
    "R6-control-homogeneous-filter-with-length-shrink",
    `${LOOP_CARRIED}
     var arr = [0, 1, 2, __n];
     Object.defineProperty(arr, "0", {
       get: function () { arr.length = 3; return 0; },
       configurable: true
     });
     var out = arr.filter(function () { return true; });
     assert.sameValue(out.length, 3, "length: " + out.length);
     assert.sameValue(out[2], 2, "element: " + String(out[2]));`,
    "CONTROL for R6 — a HOMOGENEOUS filter whose getter shrinks length is already correct",
  );

  // ── R7. a `length` accessor on an object that is BORROWED as an array-like ─
  // `filter/15.4.4.20-9-b-2.js`. The throw is
  // `TypeError: Cannot redefine property: configurable attribute of a
  // non-configurable property`, which reads like the #4491 descriptor MOP —
  // and is NOT. §10.1.6.3 step 4.a is behaving correctly; the object simply
  // already HAS a non-configurable `length` before user code runs. Caught the
  // throw and read the descriptor back:
  //   value=0, get=undefined, writable=true, enumerable=false, configurable=false
  // — that is §10.4.2's ARRAY-exotic length, on a `{}`.
  //
  // Seven probes, varying one axis at a time (`.tmp/probes/dp-length-*.js`).
  // Only the LAST combination fails, which is why no single-axis attribution
  // survives:
  //   accessor named "length" on a plain {}                        pass
  //   the same accessor named "len"                                pass
  //   after a top-level numeric-index write obj[2]="x"             pass
  //   after a top-level NAMED write obj.foo="x"                    pass
  //   getter body itself writes obj[2] (no borrow in the module)   pass
  //   plain getter + a later Array.prototype.filter.call(obj)      pass
  //   getter writes obj[2]  AND  a later filter borrow             FAIL
  // Owner: array-like borrow carrier selection (value-rep), NOT #4491.
  failSource(
    "R7-length-accessor-on-a-borrowed-array-like",
    `${LOOP_CARRIED}
     var obj = {};
     var threw = "";
     try {
       Object.defineProperty(obj, "length", {
         get: function () { obj[2] = "length"; return __n; },
         configurable: true
       });
     } catch (e) { threw = String(e); }
     var out = Array.prototype.filter.call(obj, function () { return true; });
     assert.sameValue(threw, "", "defineProperty(length) threw: " + threw);`,
    "a self-writing length accessor + an array-like borrow pre-seeds Array's own non-configurable length",
  );
  // POSITIVE CONTROLS for R7 — the two single-axis halves. Both pass, which is
  // what makes R7 a claim about the COMBINATION rather than about accessors on
  // `length`, or about borrowing, either of which would have been the easy
  // (wrong) attribution.
  pinSource(
    "R7-control-self-writing-getter-without-a-borrow",
    `${LOOP_CARRIED}
     var obj = {};
     Object.defineProperty(obj, "length", {
       get: function () { obj[2] = "length"; return __n; },
       configurable: true
     });
     assert.sameValue(obj.length, 3, "length: " + obj.length);`,
    "CONTROL for R7 — the same self-writing length accessor, with NO array-like borrow",
  );
  pinSource(
    "R7-control-borrow-without-a-self-writing-getter",
    `${LOOP_CARRIED}
     var obj = {};
     Object.defineProperty(obj, "length", {
       get: function () { return __n; },
       configurable: true
     });
     var out = Array.prototype.filter.call(obj, function () { return true; });
     assert.sameValue(obj.length, 3, "length: " + obj.length);`,
    "CONTROL for R7 — the same borrow, with a length getter that does NOT write",
  );

  // ── R8. the array element step's ToString is not `String()`'s ─────────────
  // `toString/S15.4.4.2_A1_T4.js` expects §7.1.1 OrdinaryToPrimitive to THROW
  // when neither `valueOf` nor `toString` returns a primitive. It does — for
  // `String(o)` (the control below). The ARRAY element step renders the empty
  // string and throws nothing, so the join/toString/toLocaleString element tail
  // (`__extern_toString`) and `String()` are two different ToString
  // implementations that disagree on this case.
  //
  // NOT fixed here on purpose: the element tail is shared with `join`, so
  // re-pointing it moves `join`'s bytes, and this issue's fix is deliberately
  // byte-neutral for `join`/`toString` (see `## Fix` in the issue file). The
  // next step is to measure re-pointing the tail at whatever `String()` lowers
  // to, on the same two-arm sweep this issue used.
  failSource(
    "R8-array-element-tostring-must-propagate-the-toprimitive-throw",
    `${LOOP_CARRIED}
     var both = { valueOf: function () { return {}; }, toString: function () { return {}; } };
     var arr = [];
     for (var i = 0; i < __n - 2; i++) { arr[i] = both; }
     var threw = "";
     try { var s = arr.toString(); threw = "no throw, got '" + s + "'"; }
     catch (e) { threw = e instanceof TypeError ? "TypeError" : "other:" + e; }
     assert.sameValue(threw, "TypeError", "element ToPrimitive: " + threw);`,
    "an element whose valueOf AND toString both return objects renders '' instead of throwing",
  );
  // POSITIVE CONTROL for R8 — the SAME object through `String()`. It throws
  // correctly, which is what makes R8 a claim about the element tail rather
  // than about ToPrimitive.
  pinSource(
    "R8-control-String-does-throw",
    `${LOOP_CARRIED}
     var both = { valueOf: function () { return {}; }, toString: function () { return {}; } };
     var threw = "";
     try { var s = String(both); threw = "no throw, got '" + s + "'"; }
     catch (e) { threw = e instanceof TypeError ? "TypeError" : "other:" + e; }
     assert.sameValue(threw, "TypeError", "String(): " + threw);
     assert.sameValue(__n, 3, "loop-carried");`,
    "CONTROL for R8 — String() on the same object DOES throw a TypeError",
  );

  // ── R9. ToPropertyKey does not use ToPrimitive's valueOf fallback ─────────
  // `Array/S15.4_A1.1_T9.js`. An object key whose `toString` returns an OBJECT
  // must fall back to `valueOf` (§7.1.19 → §7.1.1.1 step 3). Through `String()`
  // it does (the control); in KEY position the write lands nowhere.
  // Owner: computed-member key coercion (core-semantics), not this issue.
  failSource(
    "R9-property-key-toprimitive-fallback",
    `${LOOP_CARRIED}
     var o = { valueOf: function () { return __n - 2; }, toString: function () { return {}; } };
     var x = [];
     x[o] = 0;
     assert.sameValue(x[1], 0, "key must be '1': x[1] is " + String(x[1]));`,
    "an object property key whose toString returns an object ignores valueOf",
  );
  // POSITIVE CONTROL for R9 — the same object through `String()`, which is what
  // isolates R9 to the KEY position.
  pinSource(
    "R9-control-String-uses-the-fallback",
    `${LOOP_CARRIED}
     var o = { valueOf: function () { return __n - 2; }, toString: function () { return {}; } };
     assert.sameValue(String(o), "1", "String(o): " + String(o));`,
    "CONTROL for R9 — String() on the same object DOES fall back to valueOf",
  );
});
