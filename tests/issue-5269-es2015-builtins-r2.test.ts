// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #5269 — ES2015 standalone residual pass over the Function / Error / Symbol /
// String / JSON / Number built-ins (wave 2 of #5156 / #5152).
//
// ── Why these cases are shaped the way they are ───────────────────────────
// Every case is a SCRIPT (no `export`) that signals failure by throwing, so
// completing `__module_init` IS the pass — the same harness #4207 uses, and for
// the same reason: a top-level `export` makes TypeScript call the source a
// module, module code is strict throughout, and strictness changes `this`
// binding for several of the receivers under test.
//
// `standalone` is the lane this issue is about, and it additionally asserts the
// module imports NOTHING from `env`: every body here must be Wasm-native, and
// the test262 runner does NOT apply that check to the original-harness variant
// (#5272), so a host-import leak would otherwise be invisible here too. The
// `host` lane runs the cases whose lowering is SHARED between the two (the JSON
// dispatch gates, the object-literal host-path decision, the `.call`/`.apply`
// arm), because a change there can regress host mode with no standalone row
// noticing.
import { describe, expect, it } from "vitest";
// (#3613) The ONE wasm-exception renderer — the same module `test262-runner.ts`
// and `test262-worker.mjs` use. Without it a standalone failure reports the
// opaque "[object WebAssembly.Exception]" instead of the assertion text: the
// thrown payload is a WasmGC struct that `String()` cannot touch.
import { renderHarnessThrownText } from "../scripts/lib/wasm-exn-render.mjs";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Lane = "standalone" | "host";

async function runLane(body: string, lane: Lane): Promise<string | null> {
  const result = await compile(body, {
    allowJs: true,
    fileName: "issue-5269.js",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
    deferTopLevelInit: true,
    // `hostBridge: "always"` on BOTH lanes, exactly as `test262-runner.ts`
    // compiles them (#4035). Standalone defaults to `hostBridge: "off"`, which
    // drops the `__exn_render_*` exports (#2962) — and without those a native
    // throw arrives here as an unreadable WasmGC struct, so every standalone
    // failure would report the opaque "non-stringifiable payload" label instead
    // of the assertion text. It adds EXPORTS, not imports, so the zero-`env`
    // assertion above still means what it says.
    hostBridge: "always" as const,
    ...(lane === "standalone" ? { target: "standalone" as const } : {}),
  } as Parameters<typeof compile>[1]);
  expect(result.success, JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
  expect(WebAssembly.validate(result.binary), "module must be valid Wasm").toBe(true);
  const module = new WebAssembly.Module(result.binary);
  if (lane === "standalone") {
    expect(
      WebAssembly.Module.imports(module)
        .filter((i) => i.module === "env")
        .map((i) => i.name),
      "standalone module must not import from env",
    ).toEqual([]);
  }
  // The host lane needs the FULL runtime import surface — the same builder the
  // test262 runner uses, not a hand-written subset (a missing name surfaces as
  // a LinkError that reads like a codegen failure).
  const imports = buildImports(result.imports, undefined, result.stringPool) as WebAssembly.Imports & {
    setInstance?: (i: WebAssembly.Instance) => void;
  };
  // `WebAssembly.instantiate(Module, …)` resolves to the Instance itself — the
  // `{ module, instance }` shape is the BYTES overload only.
  const instance = (await WebAssembly.instantiate(module, imports)) as unknown as WebAssembly.Instance;
  imports.setInstance?.(instance);
  try {
    (instance.exports as Record<string, () => void>).__module_init?.();
    return null;
  } catch (error) {
    return renderHarnessThrownText(error, instance);
  }
}

/**
 * `expr` must stringify to `want`, else throw with what it actually was.
 * Never wrap a value that may be `undefined`/`null` in `String(...)` on the
 * standalone lane — the null externref carrier traps inside `__str_concat`;
 * use `typeof` or a comparison expression instead.
 */
const check = (expr: string, want: string) =>
  `var __r = ${expr}; if (String(__r) !== ${JSON.stringify(want)}) { throw new Error("got " + String(__r)); }`;

function hostOnly(name: string, body: string): void {
  it(`${name} — host`, async () => {
    expect(await runLane(body, "host")).toBeNull();
  });
}

function standaloneOnly(name: string, body: string): void {
  it(`${name} — standalone`, async () => {
    expect(await runLane(body, "standalone")).toBeNull();
  });
}

function bothLanes(name: string, body: string): void {
  standaloneOnly(name, body);
  it(`${name} — host`, async () => {
    expect(await runLane(body, "host")).toBeNull();
  });
}

describe("#5269 Step G — JSON residue", () => {
  // G-4. §25.5.2 step 11: a Symbol value has no serialisation, so the result is
  // the JS value `undefined` — NOT the string "null" the codec used to render.
  bothLanes(
    "G-4 JSON.stringify(symbol) is undefined",
    `var sym = Symbol("d");
     var r = JSON.stringify(sym);
     if (r !== undefined) { throw new Error("expected undefined"); }`,
  );

  // G-1. Zero arguments is a legal call: ToString(undefined) is "undefined",
  // which the ECMA-404 grammar rejects — a catchable SyntaxError, not the
  // compile-time `__get_builtin` refusal it used to be.
  bothLanes(
    "G-1 JSON.parse() throws a catchable SyntaxError",
    `var caught = "none";\ntry { JSON.parse(); } catch (e) { caught = e.constructor.name; }\n${check("caught", "SyntaxError")}`,
  );

  // G-1. §25.5.1 step 1 ToString(text) runs for EVERY text, so a non-string
  // primitive parses as its string form instead of hitting the refusal.
  bothLanes("G-1 JSON.parse coerces a null text", check("JSON.parse(null)", "null"));

  // G-2. A Proxy value is walked through its traps instead of rendering as the
  // literal `null`. Standalone-only: the host lane hands the same source to a
  // real JS Proxy, whose invariant checks reject this handler's synthetic
  // descriptor — that is the host engine's behaviour, not this lowering's.
  standaloneOnly(
    "G-2 JSON.stringify walks a Proxy of an object through ownKeys/get",
    `var p = new Proxy({}, {
       getOwnPropertyDescriptor: function () { return { value: 1, writable: true, enumerable: true, configurable: true }; },
       get: function () { return 1; },
       ownKeys: function () { return ["a", "b"]; }
     });
     ${check("JSON.stringify(p)", '{"a":1,"b":1}')}
     ${check("JSON.stringify({ l1: p })", '{"l1":{"a":1,"b":1}}')}`,
  );

  // G-2. A revoked proxy is a TypeError, not the literal "null".
  bothLanes(
    "G-2 JSON.stringify of a revoked proxy throws a TypeError",
    `var h = Proxy.revocable({}, {});
     h.revoke();
     var caught = "none";
     try { JSON.stringify(h.proxy); } catch (e) { caught = e.constructor.name; }
     ${check("caught", "TypeError")}`,
  );

  // G-3. §25.5.2 step 4: a non-callable, non-array replacer is IGNORED — it is
  // not an error, and it must not suppress the value.
  bothLanes(
    "G-3 a non-array object replacer is ignored",
    `${check("JSON.stringify({ key: [1] }, {})", '{"key":[1]}')}
     ${check('JSON.stringify({ key: [1] }, "")', '{"key":[1]}')}`,
  );

  // G-3. An array replacer that is NOT a literal is classified at RUNTIME and
  // filters the key set (statically only a call signature or an array literal
  // was recognised, so this shape used to refuse).
  bothLanes(
    "G-3 a dynamic array replacer filters keys",
    `var replacer = ["b"];\n${check("JSON.stringify({ a: 1, b: 2 }, replacer)", '{"b":2}')}`,
  );

  // G-5 (IsArray recursing through a proxy-of-proxy in the InternalizeJSON walk)
  // is covered by `built-ins/JSON/parse/revived-proxy.js`, which this change
  // flips. It has no self-contained fixture here: a trapless Proxy over a CLOSED
  // typed-vec target does not forward its reads at all (measured — `p["0"]` and
  // `p["length"]` both answer `undefined` through `__extern_get`), which is a
  // Proxy-carrier gap outside this issue, and it would make such a fixture
  // assert the gap rather than the recursion.
});

describe("#5269 Step H — [Symbol.toPrimitive] literals take the open-object path", () => {
  // H-1. `_hasRuntimeComputedKey` deliberately keeps well-known-symbol keys on
  // the closed-struct path, where the runtime ToPrimitive probe (#5102) — which
  // looks the method up as `__box_symbol(3)` on a `$Object` — cannot see the
  // `@@3` FIELD at all. So the walker skipped `@@toPrimitive` and fell through
  // to `toString`. Only id 3 is widened.
  bothLanes(
    "H-1 a [Symbol.toPrimitive] literal is reached by the runtime walker",
    `var calls = "";
     var obj = {
       [Symbol.toPrimitive]: function () { calls += "sym"; return 42; },
       valueOf: function () { calls += "valueOf"; return 1; },
       toString: function () { calls += "toString"; return "s"; }
     };
     ${check("isNaN(obj)", "false")}
     ${check("calls", "sym")}`,
  );

  // H-1 must NOT widen to every well-known symbol — a `[Symbol.iterator]()`
  // METHOD literal keeps the closed-struct `@@1` field the iterator arm reads,
  // and the member is still reachable under its real Symbol key.
  //
  // The assertion is a member READ, not a `for…of`: measured by A/B on
  // `literals.ts`, a `for…of` over such a literal throws on the standalone lane
  // on this change AND on its base alike, so it would assert that gap rather
  // than this step's narrowness.
  bothLanes(
    "H-1 PRECONDITION: a [Symbol.iterator]() method literal keeps its member",
    `var it = {
       [Symbol.iterator]() {
         var i = 0;
         return { next: function () { i++; return i < 3 ? { value: i, done: false } : { value: undefined, done: true }; } };
       }
     };
     ${check("typeof it[Symbol.iterator]", "function")}`,
  );

  // H-2. The handler is installed by MUTATION, so the literal has to be opened
  // by a module-scope pre-scan — a symbol-keyed write onto a closed struct has
  // nowhere to land and was silently dropped.
  // STANDALONE only. The host half of this used to pass, but only because the
  // H-1 predicates were ungated — which is precisely the F2 regression
  // (`${o}` answering "[object Object]"). With them gated, the host lane answers
  // `called=0` again, BYTE-IDENTICAL to base (A/B'd against the reviewer's base
  // tree). node answers 1, so the host lane's @@toPrimitive-after-the-fact write
  // is a pre-existing gap this issue does not close; buying it back cost far
  // more than it was worth.
  standaloneOnly(
    "H-2 a later obj[Symbol.toPrimitive] = fn write is observed",
    `var called = 0;
     var obj = { valueOf: function () { return Infinity; }, toString: function () { return Infinity; } };
     obj[Symbol.toPrimitive] = function () { called += 1; return 42; };
     ${check("isNaN(obj)", "false")}
     ${check("called", "1")}`,
  );
  // The host lane still agrees about the VALUE, which is what @@toPrimitive is
  // for; only the call count differs.
  hostOnly(
    "H-2 the host lane agrees about the coerced value",
    `var obj = { valueOf: function () { return Infinity; }, toString: function () { return Infinity; } };
     obj[Symbol.toPrimitive] = function () { return 42; };
     ${check("isNaN(obj)", "false")}`,
  );
});

describe("#5269 Step A — the Symbol namespace is reified", () => {
  // A-1. The `__builtin_ctor_Symbol` carrier had ZERO own properties, so every
  // RUNTIME descriptor query `propertyHelper.js` makes — its receiver is an
  // untyped harness parameter, so no syntactic synthesis can fire — answered
  // "absent" while the syntactic read answered the symbol.
  standaloneOnly(
    "A-1 the well-known symbols are own, non-writable, non-configurable props",
    `function ho(a, b) { return Object.prototype.hasOwnProperty.call(a, b); }
     ${check("ho(Symbol, 'iterator')", "true")}
     ${check("ho(Symbol, 'toPrimitive')", "true")}
     ${check("typeof Symbol.iterator", "symbol")}
     var d = Object.getOwnPropertyDescriptor(Symbol, "iterator");
     ${check("d.writable", "false")}
     ${check("d.enumerable", "false")}
     ${check("d.configurable", "false")}
     ${check("d.value === Symbol.iterator", "true")}`,
  );

  // A-6. §20.4.2.6 step 1 — a non-Symbol argument is a TypeError, not a silent
  // coercion into the i32 id lane that answered `undefined`.
  standaloneOnly(
    "A-6 Symbol.keyFor(non-symbol) throws a TypeError",
    `var caught = 0;
     try { Symbol.keyFor(null); } catch (e) { if (e instanceof TypeError) caught++; }
     try { Symbol.keyFor(""); } catch (e) { if (e instanceof TypeError) caught++; }
     try { Symbol.keyFor({}); } catch (e) { if (e instanceof TypeError) caught++; }
     ${check("caught", "3")}`,
  );
});

describe("#5269 Step B — Symbol.prototype and wrapper semantics", () => {
  // B-a. §7.1.18 ToObject(symbol) is a Symbol wrapper, so gPO answers
  // %Symbol.prototype%. It used to answer `null`, and every reflective read off
  // that result then dereferenced a null.
  standaloneOnly(
    "B-a Object.getPrototypeOf(symbol) is Symbol.prototype",
    `var sym = Symbol("d");\n${check("Object.getPrototypeOf(sym) === Symbol.prototype", "true")}`,
  );

  // B-b. §20.4.3.5 — the glue was built without a `symbolTag`, so the tag
  // seeder never ran and the property was absent.
  // Read through the descriptor rather than the element access: a direct
  // `Symbol.prototype[Symbol.toStringTag]` read is a separate lowering
  // (`<Builtin>.prototype[Symbol.X]`) that this step does not touch.
  standaloneOnly(
    "B-b Symbol.prototype[Symbol.toStringTag] is an own 'Symbol' data property",
    `function ho(a, b) { return Object.prototype.hasOwnProperty.call(a, b); }
     ${check("ho(Symbol.prototype, Symbol.toStringTag)", "true")}
     var d = Object.getOwnPropertyDescriptor(Symbol.prototype, Symbol.toStringTag);
     ${check("d.value", "Symbol")}
     ${check("d.writable", "false")}
     ${check("d.enumerable", "false")}
     ${check("d.configurable", "true")}`,
  );

  // B-c. SymbolDescriptiveString through the reflective body — the same builder
  // the implicit `String(sym)` path uses, so the two cannot drift.
  standaloneOnly(
    "B-c Symbol.prototype.toString renders Symbol(<desc>)",
    `var sym = Symbol("66");\n${check("sym.toString()", "Symbol(66)")}\n${check("String(sym)", "Symbol(66)")}`,
  );

  // B-d. §6.2.5.6 PutValue on a primitive base writes to a THROWAWAY wrapper:
  // sloppy is a no-op and the read is `undefined`; strict is a TypeError.
  standaloneOnly(
    "B-d a sloppy write to a symbol receiver is a no-op and the read is undefined",
    `var sym = Symbol("66");
     sym.a = 0;
     ${check("typeof sym.a", "undefined")}`,
  );

  standaloneOnly(
    "B-d a STRICT write to a symbol receiver throws a TypeError",
    `"use strict";
     var sym = Symbol("66");
     var caught = "none";
     try { sym.a = 0; } catch (e) { caught = e.constructor.name; }
     ${check("caught", "TypeError")}`,
  );
});

describe("#5269 Step C — Proxy in the callable ToString cascade", () => {
  // C-1. A Proxy is not a closure STRUCT, so the §20.2.3.5 step-3 constant that
  // `installCompiledClosureToStringArm` answers never claimed it and the value
  // fell to `__to_primitive`, rendering the string "undefined".
  standaloneOnly(
    "C-1 a callable Proxy stringifies to the NativeFunction form",
    `var p = new Proxy(function () {}, {});
     ${check('("" + p).indexOf("native code") >= 0', "true")}
     ${check('String(p).indexOf("native code") >= 0', "true")}`,
  );
});

describe("#5269 Step L — an Error instance's own `message`", () => {
  // §20.5.1.1 step 4 creates `message` as an own data property, but the value
  // lives in `$Error_struct` field 1, not in the `$props` bag — so the own walk
  // could not see it and `hasOwnProperty` answered false while `err.message`
  // read the string. The arm is narrow by construction: an `$Error_struct`
  // receiver, the key `"message"`, and a non-null field.
  standaloneOnly(
    "L presence, descriptor and delete all agree about message",
    `function ho(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
     var err = new Error("my-message");
     ${check("ho(err, 'message')", "true")}
     var d = Object.getOwnPropertyDescriptor(err, "message");
     ${check("d.value", "my-message")}
     ${check("d.writable", "true")}
     ${check("d.enumerable", "false")}
     ${check("d.configurable", "true")}
     delete err["message"];
     ${check("ho(err, 'message')", "false")}`,
  );

  // `new Error()` passes no argument, so §20.5.1.1 step 4 does not run and there
  // is NO own `message` — the arm must fall through for a null field.
  standaloneOnly(
    "L PRECONDITION: new Error() has no own message",
    `function ho(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
     var err = new Error();
     ${check("ho(err, 'message')", "false")}`,
  );
});

describe("#5269 Step J — reflective Number.prototype.toPrecision", () => {
  // J-1. The DIRECT spelling has been native for a long time; the reflective
  // VALUE had no body, so `makeGlue`'s ladder answered the refusal — a
  // TypeError where §21.1.3.5 step 5 demands a RangeError. All three arguments
  // below coerce to a precision outside 1-100 (a function and `{}` are NaN →
  // ToIntegerOrInfinity 0).
  standaloneOnly(
    "J-1 an out-of-range precision is a RangeError, not the refusal TypeError",
    `var toPrecision = Number.prototype.toPrecision;
     var caught = 0;
     try { toPrecision.call(1, function () {}); } catch (e) { if (e instanceof RangeError) caught++; }
     try { toPrecision.call(1, NaN); } catch (e) { if (e instanceof RangeError) caught++; }
     try { toPrecision.call(1, {}); } catch (e) { if (e instanceof RangeError) caught++; }
     ${check("caught", "3")}`,
  );

  // §21.1.3.5 step 2 — an ABSENT precision is `ToString(x)`, not a RangeError.
  // Under the #2106 `$undefined`-singleton regime an absent argument arrives as
  // a NON-null singleton, so a bare `ref.is_null` would miss it and step 3
  // would coerce it to NaN → 0 → RangeError.
  standaloneOnly(
    "J-1 an absent precision is ToString(x), not a RangeError — reflective",
    `var toPrecision = Number.prototype.toPrecision;
     ${check("toPrecision.call(1)", "1")}`,
  );
  standaloneOnly(
    "J-1 an absent precision is ToString(x), not a RangeError — direct",
    `${check("(123.456).toPrecision()", "123.456")}`,
  );

  // …and the in-range answer is the SAME formatter the direct spelling calls.
  standaloneOnly(
    "J-1 an in-range precision formats, and an incompatible receiver throws",
    `var toPrecision = Number.prototype.toPrecision;
     ${check("toPrecision.call(123.456, 4)", "123.5")}
     ${check("(123.456).toPrecision(4)", "123.5")}
     var caught = "none";
     try { toPrecision.call({}, 4); } catch (e) { caught = e.constructor.name; }
     ${check("caught", "TypeError")}`,
  );
});

describe("#5269 Step E-2 — SuppressedError constructs without a JS host", () => {
  // The whole point of this step is the ZERO-`env`-import assertion in
  // `runLane`: before it, merely writing `new SuppressedError(...)` put
  // `env::__new_SuppressedError` in a standalone module, and the row died at
  // the #2961 leak check as a compile_error — no assertion ever ran. So these
  // cases fail on the import list first and on the semantics second.
  standaloneOnly(
    "E-2 new SuppressedError carries error / suppressed / message / name",
    `var a = new Error("inner");
     var b = new Error("outer");
     var e = new SuppressedError(a, b, "both");
     ${check("e.error === a", "true")}
     ${check("e.suppressed === b", "true")}
     ${check("e.message", "both")}
     ${check("e.name", "SuppressedError")}`,
  );

  // §20.5.10.1 called WITHOUT `new` constructs just the same.
  standaloneOnly(
    "E-2 SuppressedError called as a function constructs too",
    `var a = new Error("i");
     var b = new Error("j");
     var e = SuppressedError(a, b, "m");
     ${check("e.message", "m")}
     if (e.error !== a) { throw new Error("error slot"); }
     if (e.suppressed !== b) { throw new Error("suppressed slot"); }`,
  );

  // Step 5 — an ABSENT message stores nothing, so the struct's `$message` field
  // stays null. What that field READS BACK as is a separate, pre-existing
  // question and NOT asserted here: measured 2026-09-02, an `$Error_struct`
  // with a null `$message` and a NON-null `$props` sidecar answers the string
  // "null" through `__extern_get`, where `new Error()` (whose `$props` IS null)
  // answers undefined. An arbitrary absent key on the same value answers
  // undefined correctly, so the defect is the `message` arm in
  // `fillExternGetErrorProps`, not the sidecar — see the issue's findings.
  // Asserting the spec answer here would fail; asserting "null" would enshrine
  // the bug. So this case pins only what E-2 itself is responsible for.
  standaloneOnly(
    "E-2 an absent message still yields a well-formed SuppressedError",
    `var a = new Error("i");
     var b = new Error("j");
     var e = new SuppressedError(a, b);
     ${check("e.name", "SuppressedError")}
     if (e.error !== a) { throw new Error("error slot"); }
     if (e.suppressed !== b) { throw new Error("suppressed slot"); }`,
  );

  // Step 6, InstallErrorCause — keyed on HasProperty, not truthiness.
  standaloneOnly(
    "E-2 options.cause is installed when present",
    `var a = new Error("i");
     var e = new SuppressedError(a, a, "m", { cause: 42 });
     ${check("e.cause", "42")}
     var f = new SuppressedError(a, a, "m");
     ${check("f.cause === undefined", "true")}`,
  );

  // The harness shape that made this a compile_error: a `typeof` guard plus a
  // construction, which is all `nativeErrors.js` does.
  standaloneOnly(
    "E-2 the nativeErrors.js harness shape compiles host-free",
    `var seen = "no";
     if (typeof SuppressedError !== "undefined") {
       var a = new Error("i");
       var e = new SuppressedError(a, a, "m");
       seen = e.name;
     }
     ${check("seen", "SuppressedError")}`,
  );
});

// ---------------------------------------------------------------------------
// Adversarial-review regression pins (2026-09-02). Each of these FAILED on the
// branch as first written and is the exact shape the reviewer's repro used.
// ---------------------------------------------------------------------------

describe("#5269 F1 — a replacer must not knock a primitive off the primitive fold", () => {
  // The G-3 `replacerObservable` gate diverted every non-nullish replacer onto
  // the codec route, which has no arm for a bare primitive and answered `null`.
  // Measured against the G cluster with the gate on and off: it bought ZERO
  // rows (8 of 13 either way), so it is gone. Values are node's.
  const REPLACER = "var id = function (k, v) { return v; };\n";
  standaloneOnly("F1 r1 — a number", `${REPLACER}${check("JSON.stringify(1, id)", "1")}`);
  standaloneOnly("F1 r3 — a boolean with a space arg", `${REPLACER}${check("JSON.stringify(true, id, 2)", "true")}`);
  // Not `check()`: the helper's own rule — never `String(...)` a possibly-
  // undefined value on the standalone lane, where the null externref carrier
  // does not stringify to "undefined". Compare the value itself, as G-4 does.
  standaloneOnly(
    "F1 r5 — undefined",
    `${REPLACER}var r = JSON.stringify(undefined, id);
     if (r !== undefined) { throw new Error("expected undefined"); }`,
  );
  standaloneOnly("F1 w1 — a variable-bound number", `${REPLACER}var n = 1;\n${check("JSON.stringify(n, id)", "1")}`);
  standaloneOnly("F1 w6 — a string space arg", `${REPLACER}${check("JSON.stringify(2, id, '  ')", "2")}`);

  standaloneOnly(
    "F1 a non-callable and an array replacer likewise",
    `${check("JSON.stringify(3, {})", "3")}
     ${check("JSON.stringify(1.5, ['a'])", "1.5")}`,
  );

  // r6 pins the SHAPE of the remaining gap, not a wish. For a primitive the
  // replacer's RETURN is still ignored, so this answers `1` where node answers
  // `"wrapped:1"` — pre-existing on both lanes and out of scope here. What must
  // never come back is `"wrapped:null"`, i.e. the replacer being handed a null
  // value, which is what the regression produced.
  standaloneOnly(
    "F1 r6 — the replacer never sees a nulled-out primitive",
    `var r = JSON.stringify(1, function (k, v) { return "wrapped:" + v; });
     if (String(r).indexOf("null") >= 0) { throw new Error("replacer saw null: " + r); }
     ${check("r", "1")}`,
  );
});

describe("#5269 F2 — a [Symbol.toPrimitive] literal keeps host-lane semantics", () => {
  // `objectLiteralForcesHostPath` gained two H-1 predicates with no
  // `ctx.standalone` gate, so on the HOST lane the literal was pushed onto the
  // host-object path — where `__extern_toString` calls `v.toString()` and never
  // consults @@toPrimitive. `${o}` and `String(o)` answered "[object Object]".
  // Both predicates are standalone-only now; host output is byte-identical to
  // base (verified by A/B against the reviewer's base tree, including its
  // trailing throw).
  bothLanes(
    "F2 h1 — template literal uses @@toPrimitive with hint 'string'",
    `var o = { [Symbol.toPrimitive](h) { return "s-" + h; }, x: 1 };
     ${check("`${o}`", "s-string")}`,
  );
  bothLanes(
    "F2 h2 — String() likewise",
    `var o = { [Symbol.toPrimitive](h) { return "s-" + h; }, x: 1 };
     ${check("String(o)", "s-string")}`,
  );
  bothLanes(
    "F2 h9 — a later-assigned @@toPrimitive is still preferred over own toString",
    `var o = { [Symbol.toPrimitive](h) { return "tp-" + h; }, toString: function () { return "ts"; } };
     ${check("`${o}`", "tp-string")}
     ${check("String(o)", "tp-string")}`,
  );
});

describe("#5269 F2 — the host binary must not gain the open-object path", () => {
  // The behavioural pins above say the ANSWER is right again. This one pins the
  // SHAPE of the host binary, which is what actually regressed: forcing the
  // literal onto the host-object path pulled the open-object/host-coercion
  // helpers into every host compile of such a file. On the regressed tree the
  // import list gained `__extern_toString`, `__make_getter_callback`,
  // `__new_plain_object`, `__extern_get` and `__extern_is_object`; on base — and
  // now — none of the five is present. This is the durable form of the
  // "host output is byte-identical to base" check: a sha can only be compared
  // against a base tree that is not available from inside the suite, whereas the
  // marker set is exactly what the regression added and is stable across
  // unrelated codegen churn.
  const HOST_OPEN_OBJECT_MARKERS = [
    "__extern_toString",
    "__make_getter_callback",
    "__new_plain_object",
    "__extern_is_object",
    // (#5269 R2-7) `__extern_get` was named in the comment above but missing
    // from the list — the control was checking four of the five markers the
    // regression added.
    "__extern_get",
  ];

  it("F2 a [Symbol.toPrimitive] literal does not drag in the host-object helpers — host", async () => {
    const result = await compile(
      `var o = { [Symbol.toPrimitive](h) { return "s-" + h; }, x: 1 };
       var s = \`\${o}\`;`,
      {
        allowJs: true,
        fileName: "issue-5269-f2-shape.js",
        skipSemanticDiagnostics: true,
        inferModuleStrictArguments: false,
        deferTopLevelInit: true,
        hostBridge: "always" as const,
      } as Parameters<typeof compile>[1],
    );
    expect(result.success, JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
    const names = WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
      .filter((i) => i.module === "env")
      .map((i) => i.name);
    expect(names.filter((n) => HOST_OPEN_OBJECT_MARKERS.includes(n))).toEqual([]);
  });
});

describe("#5269 F3 — never answer where the base compiler refused", () => {
  // The dynamic-replacer route opened a var-bound closed struct with
  // `materializeStructAsDynamicObject`, a SHALLOW open-up: a nested literal was
  // copied across as a closed struct no codec arm recognises, and
  // SerializeJSONObject silently dropped the key —
  // `var o = {a:1,b:{c:2}}; JSON.stringify(o, {})` answered `{"a":1}` where the
  // base compiler REFUSED the shape (#1599). A nested shape refuses again; a
  // FLAT one still materializes and answers correctly.
  standaloneOnly(
    "F3 s34 — a flat var-bound object still materializes for an object replacer",
    `var o = { a: 1, b: 2 };
     ${check("JSON.stringify(o, {})", '{"a":1,"b":2}')}`,
  );

  // (#5269 R2-1) The first F3 cut tested only the property initializer's
  // syntactic KIND, so it saw through the BINDING but not the property VALUE:
  // six more spellings still dropped the nested key. Each of these compiled and
  // answered `{"a":1}` where node answers `{"a":1,"b":{"c":2}}` and base refused
  // outright. Refusing is the accepted outcome; answering wrongly is not — the
  // same invariant the direct-literal pin below encodes.
  for (const [name, src] of [
    ["via an identifier", "var inner = { c: 2 };\nvar o = { a: 1, b: inner };"],
    ["via a shorthand", "var b = { c: 2 };\nvar o = { a: 1, b };"],
    ["via parentheses", "var o = { a: 1, b: ({ c: 2 }) };"],
    ["via a const binding", "const inner = { c: 2 };\nvar o = { a: 1, b: inner };"],
    ["via a call result", "function f() { return { c: 2 }; }\nvar o = { a: 1, b: f() };"],
    ["via a conditional", "var o = { a: 1, b: true ? { c: 2 } : { d: 3 } };"],
  ] as ReadonlyArray<readonly [string, string]>) {
    it(`F3 R2-1 — a nested object ${name} refuses rather than dropping a key — standalone`, async () => {
      const program = `${src}\n       var r = JSON.stringify(o, {});\n       if (r !== '{"a":1,"b":{"c":2}}') { throw new Error("wrong: " + r); }`;
      const result = await compile(program, {
        allowJs: true,
        fileName: "issue-5269-r21.js",
        skipSemanticDiagnostics: true,
        inferModuleStrictArguments: false,
        deferTopLevelInit: true,
        hostBridge: "always" as const,
        target: "standalone" as const,
      } as Parameters<typeof compile>[1]);
      if (!result.success) return; // refusal — what base did
      expect(await runLane(program, "standalone")).toBeNull();
    });
  }

  // The regression itself was a NESTED shape compiling and answering `{"a":1}`.
  // It cannot be pinned as an expected string, because the sanctioned outcome is
  // a compile-time REFUSAL (what base did). So pin the invariant instead:
  // refusing is fine, answering wrongly is not. This fails on the regressed tree
  // — which compiled happily and dropped the `b` key — and passes now.
  it("F3 s34 — a nested var-bound object refuses rather than dropping a key — standalone", async () => {
    const src = `var o = { a: 1, b: { c: 2 } };
       var r = JSON.stringify(o, {});
       if (r !== '{"a":1,"b":{"c":2}}') { throw new Error("wrong: " + r); }`;
    const result = await compile(src, {
      allowJs: true,
      fileName: "issue-5269-f3-nested.js",
      skipSemanticDiagnostics: true,
      inferModuleStrictArguments: false,
      deferTopLevelInit: true,
      hostBridge: "always" as const,
      target: "standalone" as const,
    } as Parameters<typeof compile>[1]);
    // A refusal is the accepted outcome (#1599), and is what base produced.
    if (!result.success) return;
    // If it DOES compile, the answer must be right — no silent key drop.
    expect(await runLane(src, "standalone")).toBeNull();
  });
});

describe("#5269 R2-4 — an open-object array element keeps its text", () => {
  // An array literal whose element is an OPEN object (one on the host-object
  // path) picked a CLOSED `$__anon_N` vec carrier that the open object does not
  // fit, and the element was silently lost. Measured on standalone BEFORE the
  // fix, identically on this branch and on base:
  //
  //   var g = { get a() { return 1; } };
  //   String([g][0])      -> "undefined"   (node: "[object Object]")
  //   [g, g].join("-")    -> "-"           (node: "[object Object]-[object Object]")
  //
  // So this is a PRE-EXISTING hole, not one #5269 opened — but H-1 made
  // `[Symbol.toPrimitive]` literals join that class, which is how `[w].join()`
  // regressed from "[object Object]" to "". Widening the carrier to externref
  // fixes the whole class; these pins cover both members.
  standaloneOnly(
    "R2-4 j1/j2 — join renders a [Symbol.toPrimitive] element via ToPrimitive",
    `var w = { [Symbol.toPrimitive](h) { return "P<" + h + ">"; } };
     ${check("[w].join()", "P<string>")}
     ${check("[w].join('-')", "P<string>")}`,
  );

  standaloneOnly(
    "R2-4 String([w]) and a multi-element join agree",
    `var w = { [Symbol.toPrimitive](h) { return "P<" + h + ">"; } };
     ${check("String([w])", "P<string>")}
     ${check("[w, w].join(',')", "P<string>,P<string>")}`,
  );

  // The pre-existing member of the same class: an accessor forces the literal
  // open too, and base lost this element just as thoroughly.
  standaloneOnly(
    "R2-4 an accessor-forced open object also keeps its text",
    `var g = { get a() { return 1; } };
     ${check("[g].join()", "[object Object]")}
     ${check("String([g][0])", "[object Object]")}
     ${check("[g, g].join('-')", "[object Object]-[object Object]")}`,
  );
});
