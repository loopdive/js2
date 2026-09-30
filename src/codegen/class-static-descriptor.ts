// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6767 step 1) The reflective view of a class OBJECT's declared static
 * methods and accessors — standalone.
 *
 * ## The defect, measured on `eb57f327` (standalone, `.tmp/6767/p11.js`,
 * `.tmp/6767/p13.js`)
 *
 * ```js
 * class C { static sm(){} static get sx(){} static get rx(){ return this._x; } }
 * function g(o, k) { return Object.getOwnPropertyDescriptor(o, k); }
 * ```
 *
 * | probe                                         | base        | node |
 * | --------------------------------------------- | ----------- | ---- |
 * | `g(C, "sm")` / `gOPD(C, "sm")`                 | `undefined` | `{value, writable: true, enumerable: false, configurable: true}` |
 * | `g(C, "sx")` / `gOPD(C, "sx")`                 | `undefined` | `{get, set: undefined, enumerable: false, configurable: true}` |
 * | `hasOwnProperty.call(C, "sm")` (bound, untyped) | `false`     | `true` |
 *
 * `Object.getOwnPropertyNames(C)` and the TYPED `C.hasOwnProperty("sm")` already
 * answered from compile-time metadata, so the class object contradicted itself.
 * The test262 `definition/{methods,accessors,getters-prop-desc,setters-prop-desc,
 * numeric-property-names}.js` rows all ask through a helper
 * (`assertMethodDescriptor(object, name)`, `verifyProperty`), i.e. with a
 * RUNTIME receiver and key — so a compile-time fold at the call site cannot
 * reach them. The native reflection helpers have to answer.
 *
 * ## Why a separate `$Object` and not the #5195 static sidecar
 *
 * The class object is a `$ClassName` struct singleton (#3976), not an
 * `$Object`, so the natives have nowhere to look. The static sidecar
 * (`class-static-sidecar.ts`) is an `$Object` with nearly the right entries,
 * but it is the wrong store to reuse here, for two reasons:
 *
 *  - it exists only for classes a runtime-key READ may land on (#5383 S2i
 *    demand);
 *  - it deliberately omits accessor halves that READ their receiver, because
 *    the #5195 read arm used to invoke an installed half with the sidecar
 *    itself as the receiver (an illegal cast) — and `accessors.js`'s
 *    `static get staticX() { return this._x; }` is exactly such a half.
 *
 * So each class with a declared static method or accessor gets its own
 * lazily-built VIEW `$Object` (`__static_view_<C>`), emitted by the sidecar's
 * own emitter in `"reflective-view"` mode (the same method values and §15.7.14
 * attributes). The view never escapes and never becomes a receiver.
 *
 * ## Why the arms cover the whole MOP and not only reflection (measured)
 *
 * The first cut answered `__getOwnPropertyDescriptor` / `__hasOwnProperty`
 * only, and regressed `tests/issue-5318-r4-computed-accessor-keys.test.ts`
 * (`P[x || "k"]` → -1 where base answers 9): the #5195 lookup arms in
 * `__extern_get` / `__extern_has` / `__extern_set` delegate a class-object
 * key to the static sidecar only when `__hasOwnProperty` says the key is NOT
 * own — the sidecar stood in for the "own static surface" by being treated as
 * a prototype. Once a declared static reads as own (which it is, §15.7.14), the
 * delegation stops, so the view has to answer the read, `in` and the setter
 * write itself. It does so in FRONT of those arms (this fill runs after them),
 * with the class object as the receiver an accessor half sees.
 *
 * ## What each helper answers, for `recv === <C's class-object singleton>`
 *
 * | helper | on a key the view holds |
 * | --- | --- |
 * | `__getOwnPropertyDescriptor` | the view's descriptor for the key |
 * | `__hasOwnProperty`, `__object_hasOwn`, `__extern_has` | 1 |
 * | `__extern_get` | `__reflect_get_receiver(view, key, recv)` |
 * | `__extern_set` | a declared SETTER runs with `recv`; anything else falls through |
 *
 * Every other key falls through to the unmodified body, so `name`/`length`/
 * `prototype` (the #4770 arms) and module-scope `C.p = v` cells (#6651 C,
 * prepended after these) keep their own answers. A key tombstoned by
 * `delete C[k]` (#4098 — the class object is a `$ClassName` struct, so the
 * instance tombstone substrate already records it) also falls through:
 * `verifyProperty`'s `isConfigurable` deletes and then asks `hasOwnProperty`,
 * and must read "absent".
 *
 * A class with a RUNTIME-keyed static gets no view: such a member can land on
 * a folded key at ClassDefinitionEvaluation, and only the sidecar's install
 * order gets that right (#5318 r4 finding 1).
 *
 * ## Bounded divergences (recorded, not closed)
 *
 *  - The view is a snapshot of the DECLARED members. A later write through the
 *    typed path (`C.sm = 5`) or `Object.defineProperty(C, "sm", …)` does not
 *    reach it, so reflection keeps reporting the declared value. Base reported
 *    `undefined` for the same question, so nothing that answered correctly
 *    changes.
 *  - A dynamic WRITE to a static METHOD key (`C[k] = v`) still drops, as on
 *    base (a closed struct has no expando store, #4194), so a later dynamic
 *    read keeps answering the declared method.
 *  - `gOPD(C, "sm").value === C.sm` is still false: the typed `C.sm` read
 *    materializes a fresh closure per read site (`C.sm === C.sm` is false on
 *    base too), so no single value could satisfy it.
 *  - A static accessor sharing its name with an INSTANCE accessor of the same
 *    class shares one function slot with it (#5195 cluster B item 5,
 *    `class-bodies.ts` accessor registration), so the view carries the
 *    instance half for it — the same wrong half the typed `C.x` read already
 *    runs.
 *
 * ## Gate
 *
 * Standalone only, and only for a class that declares a static method with a
 * body or a static accessor. The views are minted with the #5383 S2i static
 * builders — before the closure-arity dispatchers are emitted, for the reason
 * `mintStandaloneClassStaticBuilders` documents — and the arms are prepended at
 * the late class-object MOP fill, after every competing prefix.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { ts } from "../ts-api.js";
import { hasStaticModifier } from "./ast-modifiers.js";
import { resolveInstallableClassMemberName } from "./class-bodies.js";
import { emitClassStaticMemberObject } from "./class-static-sidecar.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { INSTANCE_FIELD_DELETED } from "./instance-tombstones.js";
import { nativeStringLiteralInstrs } from "./native-string-literals.js";
import { nextModuleGlobalIdx } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";

/** Classes whose reflective view was minted, per compilation. */
const viewsByCtx = new WeakMap<CodegenContext, string[]>();

function viewGlobalName(className: string): string {
  return `__static_view_${className}`;
}

function viewBuilderName(className: string): string {
  return `__class_static_view_build_${className}`;
}

/**
 * (#6767) True when `Object.getOwnPropertyDescriptor(<C>, "<propName>")` names
 * a declared static member of `className` that the reflective view answers.
 * The literal-key fold (`call-builtin-static.ts`) asks this to route the
 * question to the native instead of folding it to `undefined`. Off standalone
 * it is exactly the pre-#6767 static-METHOD test, so the host lane's bytes do
 * not move.
 */
export function isClassStaticReflectiveMember(ctx: CodegenContext, className: string, propName: string): boolean {
  if (ctx.classStaticMethodNames.get(className)?.includes(propName)) return true;
  return ctx.standalone === true && ctx.staticAccessorSet.has(`${className}_${propName}`);
}

function declaresReflectableStatic(decl: ts.ClassLikeDeclaration): boolean {
  return decl.members.some((member) => {
    if (!hasStaticModifier(member)) return false;
    if (ts.isMethodDeclaration(member)) return member.body !== undefined;
    return ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member);
  });
}

/**
 * Mint `__class_static_view_build_<C>()` and its `__static_view_<C>` global for
 * every class with a declared static method or accessor. Called from
 * `mintStandaloneClassStaticBuilders` so both finalize paths run it at the one
 * position that precedes the closure-arity dispatcher emission.
 */
export function mintClassStaticReflectiveViews(ctx: CodegenContext): void {
  if (!ctx.standalone || viewsByCtx.has(ctx)) return;
  const minted: string[] = [];
  viewsByCtx.set(ctx, minted);
  // No object runtime ⇒ no reflective native to answer through, and no `$Object`
  // to build the view from.
  if (ctx.funcMap.get("__getOwnPropertyDescriptor") === undefined) return;
  let voidTypeIdx: number | undefined;
  for (const className of [...ctx.classSet].sort()) {
    const decl = ctx.classDeclarationMap.get(className);
    if (decl === undefined || !declaresReflectableStatic(decl)) continue;
    if (ctx.classObjectGlobals.get(className) === undefined || ctx.structMap.get(className) === undefined) continue;
    // A runtime-keyed static can land on a folded key at ClassDefinitionEvaluation
    // (`static k(){} static get [x || "k"](){}`), so a view of the folded members
    // would answer a key that member replaced. Such a class keeps its #5195
    // sidecar as the one static store and gets no view.
    if ((ctx.classDynamicMembers.get(className) ?? []).some((member) => member.isStatic)) continue;
    const builderName = viewBuilderName(className);
    if (ctx.funcMap.has(builderName)) continue;

    const viewGlobalIdx = nextModuleGlobalIdx(ctx);
    ctx.mod.globals.push({
      name: viewGlobalName(className),
      type: { kind: "externref" },
      mutable: true,
      init: [{ op: "ref.null.extern" }],
    });
    const builderFctx: FunctionContext = {
      name: builderName,
      params: [],
      locals: [],
      localMap: new Map(),
      returnType: null,
      body: [],
      blockDepth: 0,
      breakStack: [],
      continueStack: [],
      labelMap: new Map(),
      savedBodies: [],
    };
    const emitted = emitClassStaticMemberObject(
      ctx,
      builderFctx,
      className,
      (member) => resolveInstallableClassMemberName(ctx, className, decl, member),
      viewGlobalIdx,
      "reflective-view",
    );
    // A decline leaves the global in place, harmlessly null (closure singletons
    // the attempt allocated make popping it unsound — same rule as the S2i
    // builders); no builder is registered, so no arm is emitted for the class.
    if (!emitted) continue;
    builderFctx.body.push({ op: "drop" });
    voidTypeIdx ??= addFuncType(ctx, [], [], "$class_static_view_build_type");
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name: builderName,
      typeIdx: voidTypeIdx,
      locals: builderFctx.locals,
      body: builderFctx.body,
      exported: false,
    });
    ctx.funcMap.set(builderName, funcIdx);
    minted.push(className);
  }
}

interface ViewEntry {
  structTypeIdx: number;
  classObjectGlobalIdx: number;
  viewGlobalIdx: number;
  builderIdx: number;
}

/**
 * Resolve every minted view against the LIVE maps: global indices move when a
 * global import is added after minting, and funcMap/classObjectGlobals are the
 * shift-maintained records. The view global is found by name for the same
 * reason.
 */
function liveViewEntries(ctx: CodegenContext): ViewEntry[] {
  const out: ViewEntry[] = [];
  for (const className of viewsByCtx.get(ctx) ?? []) {
    const structTypeIdx = ctx.structMap.get(className);
    const classObjectGlobalIdx = ctx.classObjectGlobals.get(className);
    const builderIdx = ctx.funcMap.get(viewBuilderName(className));
    const position = ctx.mod.globals.findIndex((global) => global.name === viewGlobalName(className));
    if (structTypeIdx === undefined || classObjectGlobalIdx === undefined || builderIdx === undefined || position < 0) {
      continue;
    }
    out.push({ structTypeIdx, classObjectGlobalIdx, viewGlobalIdx: ctx.numImportGlobals + position, builderIdx });
  }
  return out;
}

type MopFn = { locals: { name: string; type: ValType }[]; body: Instr[] };

/**
 * Prepend the identity-guarded view arms to the object MOP natives. Runs with
 * the #4770 / #6651 C class-object fills, after every competing prefix.
 */
export function fillClassStaticReflectiveArms(ctx: CodegenContext): void {
  if (!ctx.standalone) return;
  const entries = liveViewEntries(ctx);
  if (entries.length === 0) return;
  const gopdIdx = ctx.funcMap.get("__getOwnPropertyDescriptor");
  const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty");
  const reflectGetIdx = ctx.funcMap.get("__reflect_get_receiver");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  // All four are object-runtime natives registered together; without the
  // receiver-preserving read the view could not serve `__extern_get` (a half
  // would run with the view as `this`), and the read must be served — see the
  // module header — so a module missing one gets no arms at all.
  if (gopdIdx === undefined || hasOwnIdx === undefined || reflectGetIdx === undefined || externGetIdx === undefined) {
    return;
  }
  const deletedIdx = ctx.funcMap.get(INSTANCE_FIELD_DELETED);

  /**
   * `if (recv === C's class object && !deleted(recv, key)) { build view;
   *    if (hasOwn(view, key)) { hit } }` — one arm per class.
   */
  const prepend = (fn: MopFn | undefined, paramCount: number, hit: (entry: ViewEntry) => Instr[]): void => {
    if (!fn) return;
    const recvLocal = paramCount + fn.locals.length;
    fn.locals.push({ name: "__cls_view_recv", type: { kind: "anyref" } });
    const arms: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: recvLocal },
    ];
    for (const entry of entries) {
      const answer: Instr[] = [
        { op: "global.get", index: entry.viewGlobalIdx },
        { op: "ref.is_null" },
        { op: "if", blockType: { kind: "empty" }, then: [{ op: "call", funcIdx: entry.builderIdx }] },
        { op: "global.get", index: entry.viewGlobalIdx },
        { op: "local.get", index: 1 },
        { op: "call", funcIdx: hasOwnIdx },
        { op: "if", blockType: { kind: "empty" }, then: hit(entry) },
      ];
      const screened: Instr[] =
        deletedIdx === undefined
          ? answer
          : [
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: deletedIdx },
              { op: "i32.eqz" },
              { op: "if", blockType: { kind: "empty" }, then: answer },
            ];
      arms.push(
        { op: "local.get", index: recvLocal },
        { op: "ref.test", typeIdx: entry.structTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "global.get", index: entry.classObjectGlobalIdx },
            { op: "any.convert_extern" },
            { op: "ref.cast_null", typeIdx: entry.structTypeIdx },
            { op: "local.get", index: recvLocal },
            { op: "ref.cast_null", typeIdx: entry.structTypeIdx },
            { op: "ref.eq" },
            { op: "if", blockType: { kind: "empty" }, then: screened },
          ],
        },
      );
    }
    fn.body.unshift(...arms);
  };

  const find = (name: string): MopFn | undefined => ctx.mod.functions.find((candidate) => candidate.name === name);
  prepend(find("__getOwnPropertyDescriptor"), 2, (entry) => [
    { op: "global.get", index: entry.viewGlobalIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: gopdIdx },
    { op: "return" },
  ]);
  for (const name of ["__hasOwnProperty", "__object_hasOwn", "__extern_has"]) {
    prepend(find(name), 2, () => [{ op: "i32.const", value: 1 }, { op: "return" }]);
  }
  // The READ, with the class object as the receiver an accessor half sees.
  prepend(find("__extern_get"), 2, (entry) => [
    { op: "global.get", index: entry.viewGlobalIdx },
    { op: "local.get", index: 1 },
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: reflectGetIdx },
    { op: "return" },
  ]);
  prependSetterArm(ctx, find("__extern_set"), prepend, gopdIdx, externGetIdx);
}

/**
 * The WRITE: a declared static SETTER runs with the class object as receiver.
 * Every other hit — a method (data property), a getter-only accessor — falls
 * through to the unmodified `__extern_set` body, which keeps its previous
 * answer for them.
 */
function prependSetterArm(
  ctx: CodegenContext,
  fn: MopFn | undefined,
  prepend: (fn: MopFn | undefined, paramCount: number, hit: (entry: ViewEntry) => Instr[]) => void,
  gopdIdx: number,
  externGetIdx: number,
): void {
  const callSetterIdx = ctx.funcMap.get("__call_accessor_set");
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  if (!fn || callSetterIdx === undefined || isUndefinedIdx === undefined) return;
  const setterLocal = 3 + fn.locals.length;
  fn.locals.push({ name: "__cls_view_setter", type: { kind: "externref" } });
  prepend(fn, 3, (entry) => [
    { op: "global.get", index: entry.viewGlobalIdx },
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: gopdIdx },
    // Raw native literal (standalone forces `nativeStrings`), as the sibling
    // #4770 / #6651 C arms do — no string-pool global for a finalize-time key.
    ...nativeStringLiteralInstrs(ctx, "set"),
    { op: "extern.convert_any" },
    { op: "call", funcIdx: externGetIdx },
    { op: "local.tee", index: setterLocal },
    { op: "ref.is_null" },
    { op: "local.get", index: setterLocal },
    { op: "call", funcIdx: isUndefinedIdx },
    { op: "i32.or" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: setterLocal },
        { op: "local.get", index: 2 },
        { op: "call", funcIdx: callSetterIdx },
        { op: "return" },
      ],
    },
  ]);
}
