// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster D, slice D5 / #5197 R3-7) `Promise.prototype` members read
 * off a native `$Promise` through the dynamic property path, under
 * `--target standalone`.
 *
 * ## The gap
 *
 * A standalone promise is the native `$Promise` struct. A CALL `p.then(f)`
 * lowers straight onto the native reaction machinery, but every VALUE read —
 * `p.then` (the receiver is an externref even when the checker types it
 * `Promise<T>`), `id(p).then`, `p["then"]`, and above all the combinators'
 * `Invoke(nextPromise, "then", …)` (§27.2.4.1.1 step 8.i, §7.3.20), which the
 * D1/D3 drives spell as `__extern_get(next, "then")` — goes through
 * `__extern_get`. That helper had no `$Promise` arm: the carrier's own-property
 * `$bag` answers only OWN keys, so the inherited `%Promise.prototype%.then`
 * was invisible and the read answered `undefined`. `typeof p.then` was
 * `"undefined"`, `p.then === Promise.prototype.then` was false, and a
 * combinator whose `C.resolve` answers a native promise never subscribed to
 * it, so the aggregate never settled.
 *
 * ## The fix — OrdinaryGet over the carrier's implicit chain
 *
 * §10.1.8 OrdinaryGet on a promise walks: its own properties, then its
 * [[Prototype]] — `%Promise.prototype%`, or `C.prototype` for a
 * `class C extends Promise` instance (D4 records that link in the bag's
 * `$proto`). One finalize arm on `__extern_get`, for a `$Promise` receiver and
 * a string key naming a `%Promise.prototype%` member (`then`/`catch`/
 * `finally`):
 *
 *  1. an OWN bag entry (a user `p.then = f`, even one holding `undefined`)
 *     falls through to the existing path, which answers it unchanged;
 *  2. a D4 subclass link answers the member when the class chain has it (a
 *     `then` defined in the class body, or assigned on `C.prototype`);
 *  3. otherwise the answer is `%Promise.prototype%[key]`: the brand's
 *     companion (`__protoidx_get_r`) when the module seeded one — that table is
 *     the live own-property surface of `Promise.prototype`, so a user
 *     `Promise.prototype.then = f` (or a `delete`) is observed — and the
 *     identity-stable member closure singleton otherwise, the same function
 *     object a static `Promise.prototype.then` read yields.
 *
 * The member closures' bodies already exist (the `Promise.prototype` glue,
 * #5197 Slice C): called with a `$Promise` `this` they run the native
 * `then`/`catch`/`finally`. Nothing about the promise machinery changes.
 *
 * ## Demand gate — byte identity for every module that does not read one
 *
 * The closures are minted at compile time by {@link demandPromiseDynamicMember}
 * — from a source VALUE read of `.then`/`.catch`/`.finally` (property or
 * literal-key element access, never a call's callee) in a file that names
 * `Promise`, and from the combinator drives that `Invoke` `then` dynamically.
 * The finalize arm answers only members that were both demanded and minted, so
 * a module with neither emits exactly what it emitted before.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ensurePromiseNativeProtoGlue } from "./array-object-proto.js";
import { builtinBrandOffsetOf } from "./builtin-brands.js";
import { isStandalonePromiseActive } from "./async-scheduler.js";
import { pushBuiltinFnSingletonValueInstrs } from "./builtin-fn-meta.js";
import { ensureStandaloneNativeMethodClosure, seededNativeProtoOwnMembersByBrand } from "./native-proto.js";
import { nativeStringLiteralInstrs } from "./native-strings.js";
import { flushLateImportShifts } from "./shared.js";

/** The `%Promise.prototype%` methods a dynamic read can name (§27.2.5). */
const PROMISE_PROTO_MEMBERS: ReadonlySet<string> = new Set(["catch", "finally", "then"]);

/** §27.2.5.1/.3/.4 — the members' `length` (`lib.es5.d.ts` marks every parameter optional). */
const PROMISE_PROTO_MEMBER_LENGTH: Readonly<Record<string, number>> = { catch: 1, finally: 1, then: 2 };

/**
 * `p.then.length` on a `Promise`-typed receiver, standalone: the spec length.
 * The static `Function.length` fold counts the library signature's leading
 * required parameters — `then(onfulfilled?, onrejected?)` has none, so it
 * answered 0 (S25.4.5.3_A1.1_T2). `undefined` for every other spelling, which
 * keeps its fold; the gc lane is left to its host value path unchanged.
 */
export function promiseProtoMemberSpecLength(ctx: CodegenContext, memberAccess: ts.Expression): number | undefined {
  if (!ctx.standalone || ctx.wasi || !ts.isPropertyAccessExpression(memberAccess)) return undefined;
  const length = PROMISE_PROTO_MEMBER_LENGTH[memberAccess.name.text];
  if (length === undefined || ctx.oracle.builtinReceiverOf(memberAccess.expression) !== "Promise") return undefined;
  return length;
}

/** Members demanded per compilation — the arm's gate, together with funcMap presence. */
const demandedByCtx = new WeakMap<CodegenContext, Set<string>>();
/** Per source file: does it name `Promise` at all? */
const mentionsPromise = new WeakMap<ts.SourceFile, boolean>();

/**
 * Mint the `%Promise.prototype%.<member>` closure and record that the module
 * reads it dynamically. Standalone only (the gc lane reads a host promise's
 * `then` through the host), idempotent, and safe mid-expression: the late
 * import flush repairs `fctx`'s live bodies.
 */
export function demandPromiseDynamicMember(ctx: CodegenContext, member: string, fctx: FunctionContext | null): void {
  if (!ctx.standalone || ctx.wasi || !PROMISE_PROTO_MEMBERS.has(member)) return;
  if (!isStandalonePromiseActive(ctx)) return;
  let demanded = demandedByCtx.get(ctx);
  if (demanded?.has(member)) return;
  const brand = ensurePromiseNativeProtoGlue(ctx);
  if (brand === undefined) return;
  if (!ensureStandaloneNativeMethodClosure(ctx, brand, member, "method")) return;
  if (!demanded) demandedByCtx.set(ctx, (demanded = new Set()));
  demanded.add(member);
  flushLateImportShifts(ctx, fctx);
}

/** `p.then` / `p["then"]` in VALUE position — the name, or `undefined`. */
function dynamicReadMemberName(expr: ts.Expression): string | undefined {
  let name: string | undefined;
  if (ts.isPropertyAccessExpression(expr)) {
    if (!ts.isIdentifier(expr.name)) return undefined;
    name = expr.name.text;
  } else if (ts.isElementAccessExpression(expr)) {
    const key = expr.argumentExpression;
    if (!key || !ts.isStringLiteralLike(key)) return undefined;
    name = key.text;
  } else {
    return undefined;
  }
  if (!PROMISE_PROTO_MEMBERS.has(name)) return undefined;
  // A call's callee is lowered by the call compiler (the native `.then(...)`
  // bridge), not by this read — only a VALUE read reaches `__extern_get`.
  const parent = expr.parent;
  if (parent && ts.isCallExpression(parent) && parent.expression === expr) return undefined;
  return name;
}

function fileMentionsPromise(node: ts.Node): boolean {
  const sourceFile = ts.getOriginalNode(node).getSourceFile() as ts.SourceFile | undefined;
  if (!sourceFile) return false;
  let answer = mentionsPromise.get(sourceFile);
  if (answer === undefined) {
    answer = sourceFile.text.includes("Promise");
    mentionsPromise.set(sourceFile, answer);
  }
  return answer;
}

/**
 * Source hook: a VALUE read of a `%Promise.prototype%` member name, in a file
 * that names `Promise`, demands that member's closure. Emits nothing into
 * `fctx.body` itself.
 */
export function notePromiseDynamicMemberRead(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): void {
  if (!ctx.standalone || ctx.wasi) return;
  const member = dynamicReadMemberName(expr);
  if (member === undefined || !fileMentionsPromise(expr)) return;
  demandPromiseDynamicMember(ctx, member, fctx);
}

/**
 * `Invoke(nextPromise, "then", …)` sites that normally subscribe a native
 * `$Promise` directly (the D2 observable pipeline) must instead perform the
 * real Get when the program can have replaced `%Promise.prototype%.then`.
 * True — with the `then` closure demanded — exactly when some source writes a
 * `.prototype.then` (the pre-scan member set, #4492 wave-5).
 */
export function promiseProtoThenMayBeReplaced(ctx: CodegenContext, fctx: FunctionContext | null): boolean {
  if (!ctx.standalone || ctx.wasi) return false;
  // The observable pipeline's generic Invoke reads `then` off any value —
  // a native promise returned by a user `C.resolve` included.
  demandPromiseDynamicMember(ctx, "then", fctx);
  return ctx.protoNamedWrittenMembers.has("then") && demandedByCtx.get(ctx)?.has("then") === true;
}

/**
 * `if (the Promise companion has an OWN entry for key) return get_r(obj, key)`
 * — probes the Promise brand's companion only (never `Object.prototype`'s,
 * which `%Promise.prototype%` shadows) and never mints it. `[]` when the
 * proto-property store is not live in this module.
 */
function writtenMemberArm(
  ctx: CodegenContext,
  d: { protoGetIdx: number | undefined; objFindIdx: number; objectTypeIdx: number; anyLocal: number },
): Instr[] {
  const companionIdx = ctx.funcMap.get("__protoidx_companion");
  const promiseOff = builtinBrandOffsetOf("Promise");
  if (d.protoGetIdx === undefined || companionIdx === undefined || promiseOff === undefined) return [];
  return [
    { op: "i32.const", value: promiseOff },
    { op: "i32.const", value: 0 },
    { op: "call", funcIdx: companionIdx },
    { op: "any.convert_extern" },
    { op: "local.tee", index: d.anyLocal },
    { op: "ref.test", typeIdx: d.objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: d.anyLocal },
        { op: "ref.cast", typeIdx: d.objectTypeIdx },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: d.objFindIdx },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: d.protoGetIdx },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

/** Demanded members whose closure exists, sorted. */
function answerableMembers(ctx: CodegenContext, brand: number): string[] {
  const demanded = demandedByCtx.get(ctx);
  if (!demanded) return [];
  return [...demanded].filter((member) => ctx.funcMap.has(`__proto_method_${brand}_${member}`)).sort();
}

/**
 * Finalize: prepend the `$Promise` receiver arm onto `__extern_get`. MUST run
 * before `unshiftExternGetProtoCacheArm`, which has to stay the body's prefix.
 * No-op unless a member was demanded.
 */
export function unshiftExternGetPromiseMemberArm(ctx: CodegenContext): void {
  if (!ctx.standalone || ctx.wasi) return;
  const brand = ctx.builtinBrandMap?.get("Promise");
  const promiseTypeIdx = ctx.structMap.get("$Promise");
  const objTypes = ctx.objectRuntimeTypes;
  if (brand === undefined || promiseTypeIdx === undefined || objTypes === undefined) return;
  const members = answerableMembers(ctx, brand);
  if (members.length === 0) return;
  const fn = ctx.mod.functions.find((candidate) => candidate.name === "__extern_get");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const anyStr = ctx.anyStrTypeIdx;
  const promiseDef = ctx.mod.types[promiseTypeIdx];
  const bagField = promiseDef?.kind === "struct" ? promiseDef.fields.findIndex((f) => f.name === "$bag") : -1;
  if (!fn || strFlattenIdx === undefined || strEqualsIdx === undefined || objFindIdx === undefined) return;
  if (anyStr < 0 || bagField < 0) return;
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const externHasIdx = ctx.funcMap.get("__extern_has");
  const protoGetIdx = ctx.funcMap.get("__protoidx_get_r");
  const seeded = new Set(seededNativeProtoOwnMembersByBrand(ctx).get(brand) ?? []);
  const { objectTypeIdx } = objTypes;

  const keyLocal = 2 + fn.locals.length;
  const anyLocal = keyLocal + 1;
  const bagLocal = anyLocal + 1;
  const newLocals: { name: string; type: ValType }[] = [
    { name: "pdk", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } },
    { name: "pda", type: { kind: "anyref" } },
    { name: "pdb", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
  ];
  const keyIs = (member: string): Instr[] => [
    { op: "local.get", index: keyLocal },
    { op: "ref.as_non_null" },
    ...nativeStringLiteralInstrs(ctx, member),
    { op: "call", funcIdx: strEqualsIdx },
  ];

  // Step 3 — `%Promise.prototype%[key]`, per member.
  const protoLadder: Instr[] = [];
  for (const member of members) {
    let value: Instr[];
    if (protoGetIdx !== undefined && seeded.has(member)) {
      // The seeded companion is the live own-property table of the prototype.
      value = [
        { op: "local.get", index: 0 },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: protoGetIdx },
      ];
    } else {
      // Idempotent: resolves the minted closure, emits nothing new.
      const closure = ensureStandaloneNativeMethodClosure(ctx, brand, member, "method");
      if (!closure) continue;
      value = [
        // Unseeded, but the program may have WRITTEN the member onto
        // `Promise.prototype` (`Promise.prototype.then = f` lands in the brand
        // companion): an entry there is the live value.
        ...writtenMemberArm(ctx, { protoGetIdx, objFindIdx, objectTypeIdx, anyLocal }),
        ...pushBuiltinFnSingletonValueInstrs(ctx, closure),
        { op: "extern.convert_any" },
      ];
    }
    protoLadder.push(...keyIs(member), {
      op: "if",
      blockType: { kind: "empty" },
      then: [...value, { op: "return" }],
    });
  }
  if (protoLadder.length === 0) return;

  let isMember: Instr[] = [];
  for (const member of members) {
    isMember = isMember.length === 0 ? keyIs(member) : [...isMember, ...keyIs(member), { op: "i32.or" }];
  }

  // Step 2 — a D4 subclass instance: `bag.$proto` is `C.prototype`.
  const subclassArm: Instr[] =
    externGetIdx === undefined || externHasIdx === undefined
      ? []
      : [
          { op: "local.get", index: bagLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: bagLocal },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
              { op: "extern.convert_any" },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: externHasIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: bagLocal },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: 1 },
                  { op: "call", funcIdx: externGetIdx },
                  { op: "return" },
                ],
              },
            ],
          },
        ];

  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: promiseTypeIdx },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStr },
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStr },
    { op: "call", funcIdx: strFlattenIdx },
    { op: "local.set", index: keyLocal },
    ...isMember,
    { op: "i32.eqz" },
    { op: "br_if", depth: 0 },
    // Step 1 — an OWN entry shadows: leave it to the existing bag path.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: promiseTypeIdx },
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: bagField },
    { op: "any.convert_extern" },
    { op: "local.tee", index: anyLocal },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        { op: "local.set", index: bagLocal },
        { op: "local.get", index: bagLocal },
        { op: "ref.as_non_null" },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: objFindIdx },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        { op: "br_if", depth: 1 },
        ...subclassArm,
      ],
    },
    ...protoLadder,
  ];
  fn.locals.push(...newLocals);
  fn.body.unshift({ op: "block", blockType: { kind: "empty" }, body });
}
