// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6643 (#5383 S65) — `Function.prototype.{apply,call}` on a value a linked
// standalone PROVIDER owns answered `null`, silently, under `--target
// standalone`, while the very same value called directly worked.
//
// ROOT CAUSE (measured, not inferred). `__apply_closure`'s #6420 peer arm is
// unshifted AHEAD of the module's own closure dispatch and fires on
// `peer.callableKind(fn) & 1`. That predicate is NOT a statement about
// OWNERSHIP: the provider's `__is_callable` answers 1 for a CONSUMER-owned
// closure that crossed into it as well. So when `f.apply(thisArg, args)`
// resolves `apply` to the consumer's own `%Function.prototype%` glue (#6630)
// — which it does in any module where `%Function.prototype%` is materialized
// AND `.apply` is read as a value — `__closure_method_call` handed that GLUE
// closure to the bridge, the peer arm claimed it, and the whole operation was
// shipped to the provider, which cannot run a consumer closure and answered
// the null sentinel. The provider function was never entered at all: against
// the real `@js-temporal/polyfill` provider, a deliberately invalid argument
// that MUST throw returned `null` instead (probe `.tmp/s65/probes/p18.js`).
//
// THE FIX, in two parts:
//   1. `object-runtime.ts::fillApplyClosure` — the peer arm additionally
//      requires `__is_callable(fn) == 0`, i.e. "this module does not recognise
//      the callee". The glue then takes its own local dispatch, and the
//      `__apply_closure(target, …)` INSIDE it — where `target` really is
//      provider-owned and locally not callable — takes the peer arm as #6420
//      intended.
//   2. `closures/transferred-native-proto.ts` — the variadic native-proto arm
//      admitted an `$ObjVec` carrier and then re-wrapped its data array with a
//      BARE `ref.cast`. Newly reachable once (1) stops the peer arm from
//      short-circuiting, it turned `<provider callable>.call(…)` into an
//      UNCATCHABLE `illegal cast` trap. The admission predicate now asks
//      whether that cast is sound and declines otherwise.
//   3. `function-proto-invokers.ts` — §20.2.3 step 2 `IsCallable(this)` is
//      `__typeof_function`, which only knows THIS module's carriers, so a
//      provider-owned receiver was rejected outright. The peer's
//      `callableKind` bit 0 is added as a DISJUNCT.
//
// MEASURED by file-copy revert of the four changed files to `32967877d8`
// (2026-09-19); every TOOTH below is the base answer on the left.
//
// Host-free: `hostBridge: "off"` and an EMPTY import object, the #6605/#6625
// convention followed by `tests/issue-6640-link-extends-provider-class.test.ts`,
// whose two-module fixture harness this file reuses.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/**
 * A provider whose namespace publishes a class, a static factory, a bare
 * static and a prototype method as first-class VALUES — the
 * `Temporal.PlainDate` / `Temporal.PlainDate.from` shape reduced to the parts
 * `checkSubclassingIgnoredStatic` actually touches.
 */
const PROVIDER = `
  export class Base {
    constructor(x) { this.x = x; }
    get() { return this.x; }
    static from(x) { return new Base(x); }
    static id(x) { return x; }
  }
  export const NS = Object.freeze({
    __proto__: null,
    Base: Base,
    id: Base.id,
    from: Base.from,
    get: Base.prototype.get,
  });`;

/**
 * Kept VERBATIM as measured — the local `L` mirrors the provider's member
 * NAMES on purpose. A method call is dispatched per name, so a consumer with
 * no local `get` / `from` call site has no `__call_m_get_0` at all and
 * `NS.from(3).get()` cannot dispatch, which is a fixture artefact unrelated to
 * this slice (it answers the same on the base tree).
 *
 * `const fpa = NS.id.apply` is the TRIGGER, not decoration: reading `.apply`
 * off a provider-owned callable is what makes `%Function.prototype%` real in
 * this module and makes every later `f.apply(…)` resolve to the #6630 glue
 * instead of falling through to the link's `methodCall` terminal. Without it
 * the whole table already passes on the base tree (measured — probe
 * `.tmp/s65/probes/p17.js` against the real provider).
 */
const PRELUDE = `
  const fp = Function.prototype;
  const fpa = NS.id.apply;
  function applyNonArrayLike() { try { lf.apply(undefined, 5); return "no-throw"; } catch (e) { return e.message; } }
  function callOnNonCallable() { try { fpa.call(7, undefined); return "no-throw"; } catch (e) { return e.message; } }
  class L {
    constructor(x) { this.x = x; }
    get() { return this.x; }
    static from(x) { return new L(x); }
    static id(x) { return x; }
    inst(a) { return a + 1; }
  }
  function lf(a) { return a * 2; }
`;

async function runLinkedStrings(provider: string, prelude: string, expressions: string[]): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "issue-6643-"));
  const packageRoot = join(root, "node_modules", "ns6643");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6643", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6643";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item: { message: string }) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item: { packageName: string }) => item.packageName === "ns6643")!;
  const field = (artifact as { exportBoundaries: { NS: { field: string } } }).exportBoundaries.NS.field;
  const consumerEntry = "/__main.js";
  const probes = expressions
    .map(
      (expr, i) =>
        `export function prepare${i}() { try { __s = "" + (${expr}); } catch (e) { __s = "!" + (e && e.message ? e.message : e); } return __s.length; }\n`,
    )
    .join("");
  const result = await compileMulti(
    {
      "/__ns_stub.ts": `export declare function ${field}(): any;\n`,
      [consumerEntry]:
        `import { ${field} } from "/__ns_stub";\nconst NS = ${field}();\nlet __s = "";\n${prelude}\n${probes}` +
        `export function at(i) { return __s.charCodeAt(i); }\n`,
    },
    consumerEntry,
    {
      allowJs: true,
      skipSemanticDiagnostics: true,
      canonicalRuntimeTypes: true,
      link: [(artifact as { namespace: string }).namespace],
      linkedPackageBindings: new Map([[field, { module: (artifact as { namespace: string }).namespace, field }]]),
      ...STANDALONE,
    } as never,
  );
  (result as { linkedModules?: unknown[] }).linkedModules = [artifact];
  expect(result.success, result.errors.map((item) => item.message).join("\n")).toBe(true);
  const { instance } = await instantiateLinkedProject(result, {});
  const exports = instance.exports as unknown as Record<string, (i?: number) => number>;
  const out: string[] = [];
  for (let index = 0; index < expressions.length; index++) {
    const length = exports[`prepare${index}`]!();
    let answer = "";
    for (let at = 0; at < length; at++) answer += String.fromCharCode(exports.at!(at));
    out.push(answer);
  }
  return out;
}

/** TEETH — the base-tree answer for each of these is in the trailing comment. */
const TEETH: ReadonlyArray<readonly [string, string]> = [
  // A bare provider-owned static, every invoker spelling.       base: "null"
  ["NS.id.apply(undefined, [3])", "3"],
  ["NS.id.call(undefined, 3)", "3"],
  // A non-undefined `thisArg` is ignored, as §20.2.3.1 requires. base: "null"
  ["NS.id.apply(7, [3])", "3"],
  // A provider FACTORY through apply/call: the returned value is a real
  // provider instance whose own method answers.   base: "!Cannot read properties of undefined (reading 'get')"
  ["NS.from.apply(undefined, [3]).get()", "3"],
  ["NS.from.call(undefined, 3).get()", "3"],
  // §20.2.3 step 2 on the glue value itself: a non-callable receiver must
  // throw, and did not — the guard silently answered undefined. base: "no-throw"
  ["callOnNonCallable()", "Function.prototype.apply called on non-callable receiver"],
];

/** CONTROLS — must not move. */
const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  // The trigger itself, and what it makes true.
  ["typeof Function.prototype.apply", "function"],
  ["typeof NS.id.apply", "function"],
  ["NS.id.apply === Function.prototype.apply", "true"],
  // Direct calls across the link, unchanged.
  ["NS.id(3)", "3"],
  ["NS.from(3).get()", "3"],
  ["new NS.Base(4).get()", "4"],
  // `bind` already worked (a separate `__bind_dyn` carrier) and still does.
  ["NS.id.bind(undefined)(3)", "3"],
  // LOCAL callables keep the module's own dispatch — the property the #6420
  // peer arm's new conjunct exists to preserve.
  ["lf.apply(undefined, [21])", "42"],
  ["lf.call(undefined, 21)", "42"],
  ["lf.bind(undefined)(21)", "42"],
  ["L.prototype.inst.apply(new L(0), [1])", "2"],
  ["new L(9).get()", "9"],
  // §20.2.3.1 step 3 — CreateListFromArrayLike still rejects a primitive
  // `argArray` (#6493), rather than degrading to a zero-argument call.
  ["applyNonArrayLike()", "CreateListFromArrayLike called on non-object"],
];

/**
 * RESIDUALS — still WRONG after this slice, pinned so the claim "this fixes
 * `apply`/`call` on a provider-owned method value" stays honest about what it
 * does not fix.
 *
 * A provider PROTOTYPE method invoked with an explicit provider instance as
 * `thisArg` reaches the provider (base answered a silent `null`; it now raises
 * a catchable error) but its `this` does not bind to that instance. That is
 * the #5383 S2h receiver-carrier gap, not this one: the peer `apply` terminal
 * is the provider's own `__apply_closure`, which binds `this` through the
 * PROVIDER's `__current_this`, and a method-closure singleton read out through
 * `memberGet` carries no receiver.
 */
const RESIDUALS: ReadonlyArray<readonly [string, string]> = [
  ["NS.get.apply(new NS.Base(4), [])", "!Cannot read properties of undefined (reading a class field)"],
  ["NS.get.call(new NS.Base(4))", "!Cannot read properties of undefined (reading a class field)"],
  // `Reflect.apply` across the link refuses its argumentsList — unchanged by
  // this slice (base answers the same), tracked with the rest of #5383.
  ["Reflect.apply(NS.id, undefined, [3])", "!Reflect.apply argumentsList is not an object"],
];

describe("#6643 — `Function.prototype.{apply,call}` on a linked provider's method value", () => {
  it("invokes the provider function, with its arguments, and keeps every local route unchanged", async () => {
    const cases = [...TEETH, ...CONTROLS, ...RESIDUALS];
    const answers = await runLinkedStrings(
      PROVIDER,
      PRELUDE,
      cases.map(([expr]) => expr),
    );
    const actual: Record<string, string> = {};
    const expected: Record<string, string> = {};
    cases.forEach(([expr, want], index) => {
      actual[expr] = answers[index]!;
      expected[expr] = want;
    });
    expect(actual).toEqual(expected);
  }, 600000);
});
