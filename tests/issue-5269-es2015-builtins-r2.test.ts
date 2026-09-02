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
    ...(lane === "standalone" ? { target: "standalone" as const } : { hostBridge: "always" as const }),
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
    return String((error as { message?: unknown })?.message ?? error);
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
  bothLanes(
    "H-2 a later obj[Symbol.toPrimitive] = fn write is observed",
    `var called = 0;
     var obj = { valueOf: function () { return Infinity; }, toString: function () { return Infinity; } };
     obj[Symbol.toPrimitive] = function () { called += 1; return 42; };
     ${check("isNaN(obj)", "false")}
     ${check("called", "1")}`,
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
