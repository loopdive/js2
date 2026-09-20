// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6654 (#5383 S72) — a COMPUTED-key method call on an instance of a user class
// that extends a LINKED PROVIDER class lost the receiver and collapsed a
// spread.
//
// The shape is test262 `temporalHelpers.js::checkSubclassConstructorUndefined`,
// reached by every `*/subclassing-ignored.js` row:
//
//   class MySubclass extends construct { constructor() { ++called; super(...constructArgs); } }
//   const instance = new MySubclass();
//   const result = instance[method](...methodArgs);
//
// #6640 makes such a class externref-backed with a runtime provider parent, so
// `instance` IS the carrier the PROVIDER's constructor minted. But the class is
// still a genuine declaration in `ctx.classSet`, so `elemAccessReceiverIsUserClass`
// answers `true` and the user-class arms in `call-tail-dispatch.ts` claim the
// computed call before the spread-capable, receiver-binding #6641 arm sees it.
// Those arms resolve a member by CONSUMER-SIDE struct identity — which a
// provider-minted carrier does not have — and are fixed-arity, so:
//
//   * an inherited method that reads an internal slot runs with `this`
//     unbound (`Duration.prototype.abs` → "Cannot read properties of
//     undefined (reading a class field)"); and
//   * a spread arrives as ONE array argument in formal zero.
//
// The DOT spelling never had either problem — it falls through to the link
// `methodCall` terminal — which is what pins this as a dispatch-ordering
// defect rather than a boundary one, and is why every dot case below is a
// CONTROL. So is every STATICALLY RESOLVED key: measured on the base tree,
// `i["echo"](...A2)` and `i["slot"]()` both already answered correctly, so
// the fix splices only into the RUNTIME-key dispatch and those two are pinned
// as controls rather than claimed as teeth.
//
// MEASURED by file-copy revert of the two changed files to `bccd46c552`
// (2026-09-20), this exact fixture:
//
//   computedSpread   `echo:p,q,undefined:1`                               → `echo:p,q:2`
//   slotComputed     `!Cannot read properties of undefined (…class field)` → `30`
//   checkSI          `echo:p,q,undefined:1`                               → `echo:p,q:2`
//
// Host-free (`hostBridge: "off"`, empty import object), the
// #6605/#6625/#6640/#6644 convention: every value crosses purely in Wasm, with
// no host decode step that could mask a boundary bug.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileMulti, compileProject, instantiateLinkedProject } from "../src/index.js";

const STANDALONE = { target: "standalone" as const, hostBridge: "off" as const };

/**
 * `echo` reports its own `arguments.length`, which is the only way to see a
 * spread that was handed over as one array; `slot` reads an instance field, so
 * an unbound receiver is a thrown TypeError rather than a wrong-looking string.
 */
const PROVIDER = `
  export class Base {
    constructor(a) { this.a = a; }
    get() { return this.a; }
    echo(x, y) { return "echo:" + x + "," + y + ":" + arguments.length; }
    slot() { return this.a * 10; }
    static tag() { return "base"; }
  }
  export const NS = Object.freeze({ __proto__: null, Base: Base });`;

const PRELUDE = `
  function mkSub(construct, a) { class Sub extends construct {} return new Sub(a); }
  const A2 = ["p", "q"];
  // TEETH — computed key on a subclass-of-linked instance.
  function computedSpread(construct, m, args) { const i = mkSub(construct, 3); return String(i[m](...args)); }
  function computedPlain(construct, m) { const i = mkSub(construct, 3); return String(i[m]("p", "q")); }
  function slotComputed(construct, m) { const i = mkSub(construct, 3); return String(i[m]()); }
  function literalComputed(construct) { const i = mkSub(construct, 3); return String(i["slot"]()); }
  function literalSpread(construct, args) { const i = mkSub(construct, 3); return String(i["echo"](...args)); }
  // The verbatim temporalHelpers shape, including the explicit \`super(...)\`.
  function checkSI(construct, method, methodArgs) {
    var called = 0;
    class MySubclass extends construct { constructor() { ++called; super(3); } }
    const instance = new MySubclass();
    const result = instance[method](...methodArgs);
    return called + "/" + String(result);
  }
  // CONTROLS — the dot spelling, a direct provider instance, a local class.
  function dotCall(construct) { const i = mkSub(construct, 3); return String(i.echo("p", "q")); }
  function dotSpread(construct, args) { const i = mkSub(construct, 3); return String(i.echo(...args)); }
  function slotDot(construct) { const i = mkSub(construct, 3); return String(i.slot()); }
  function directComputed(construct, m, args) { const i = new construct(3); return String(i[m](...args)); }
  function directDot(construct) { const i = new construct(3); return String(i.echo("p", "q")); }
  class LocalBase { constructor(x) { this.x = x; } echo(a, b) { return "L:" + a + "," + b + ":" + arguments.length; } }
  class LocalSub extends LocalBase {}
  function localComputedPlain(m) { const i = new LocalSub(3); return String(i[m]("p", "q")); }
`;

/**
 * Compile `provider` as an npm package, link a consumer that stringifies each
 * expression in turn, and read the answers back host-free — the
 * `runLinkedStrings` shape shared with `tests/issue-6644-*`.
 */
async function runLinkedStrings(provider: string, prelude: string, expressions: string[]): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "issue-6654-"));
  const packageRoot = join(root, "node_modules", "ns6654");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "ns6654", version: "0.0.0", main: "index.js" }),
  );
  writeFileSync(join(packageRoot, "index.js"), provider);
  const entry = join(root, "entry.js");
  writeFileSync(entry, `import { NS } from "ns6654";\nexport function __probe() { return typeof NS; }\n`);
  const built = await compileProject(entry, {
    allowJs: true,
    skipSemanticDiagnostics: true,
    packageCacheDir: join(root, "providers"),
    ...STANDALONE,
  } as never);
  expect(built.success, built.errors.map((item: { message: string }) => item.message).join("\n")).toBe(true);
  const artifact = (built.linkedModules ?? []).find((item: { packageName: string }) => item.packageName === "ns6654")!;
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

/** TEETH — each answered wrong on the reverted base. */
const TEETH: ReadonlyArray<readonly [string, string]> = [
  // A runtime spread reaches the inherited provider method as arguments, not as
  // one array. Base: `echo:p,q,undefined:1`.
  ["computedSpread(NS.Base, 'echo', A2)", "echo:p,q:2"],
  // The receiver is bound, so an inherited method may read an internal slot.
  // Base: `!Cannot read properties of undefined (reading a class field)`.
  ["slotComputed(NS.Base, 'slot')", "30"],
  // The verbatim test262 helper shape — the subclass constructor still runs
  // exactly once. Base: `1/echo:p,q,undefined:1`.
  ["checkSI(NS.Base, 'echo', A2)", "1/echo:p,q:2"],
];

/** CONTROLS — must not move. */
const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  // A computed key with a fixed argument list already worked.
  ["computedPlain(NS.Base, 'echo')", "echo:p,q:2"],
  // A STATICALLY RESOLVED key already worked on both counts — which is why the
  // fix splices only into the runtime-key dispatch. These pin that.
  ["literalComputed(NS.Base)", "30"],
  ["literalSpread(NS.Base, A2)", "echo:p,q:2"],
  // Every DOT spelling already reached the link `methodCall` terminal.
  ["dotCall(NS.Base)", "echo:p,q:2"],
  ["dotSpread(NS.Base, A2)", "echo:p,q:2"],
  ["slotDot(NS.Base)", "30"],
  // A DIRECT provider instance is not a user class at all.
  ["directComputed(NS.Base, 'echo', A2)", "echo:p,q:2"],
  ["directDot(NS.Base)", "echo:p,q:2"],
  // A plain LOCAL `extends` keeps its existing lowering — the new arm consults
  // the linked-dynamic-parent registry, which a local class is never in.
  ["localComputedPlain('echo')", "L:p,q:2"],
  // Construction and inherited reads through the link, unchanged.
  ["mkSub(NS.Base, 3).get()", "3"],
  ["String(mkSub(NS.Base, 3).a)", "3"],
  ["NS.Base.tag()", "base"],
];

describe("#6654 — computed-key method call on an instance of a subclass of a linked provider class", () => {
  it("binds the receiver and expands a runtime spread", async () => {
    const cases = [...TEETH, ...CONTROLS];
    const answers = await runLinkedStrings(
      PROVIDER,
      PRELUDE,
      cases.map(([expr]) => expr),
    );
    const actual = cases.map(([expr], index) => `${index}:${expr} => ${answers[index]!}`);
    const expected = cases.map(([expr, want], index) => `${index}:${expr} => ${want}`);
    expect(actual).toEqual(expected);
  });
});
