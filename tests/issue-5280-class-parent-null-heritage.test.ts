/**
 * #5280 — `class C extends null` must RECORD its null heritage in the
 * host-side class-parent registry.
 *
 * The registry is process-global and keyed by class NAME. A sharded test262
 * worker runs hundreds of files in one process and `C` is one of the corpus's
 * most common class names, so dropping a null registration left the previous
 * file's `C` parent in place: `class C extends null`'s SuperCall then applied
 * a stale constructor instead of throwing TypeError, and when that stale parent
 * resolved back into the current module's own `C` the SuperCall re-entered
 * itself unboundedly — "Maximum call stack size exceeded", bucket signature
 * 96690aa5e0efb4ff, three unrelated PRs parked on 2026-09-02.
 *
 * These are unit tests of the registry itself, which is where the defect was;
 * the end-to-end witness is the test262 row, verified by running
 * `.../subclass/derived-class-return-override-catch-super.js` and then
 * `.../subclass/class-definition-null-proto-super.js` in one shard worker.
 */
import { describe, expect, it } from "vitest";
import {
  MISS,
  getClassParent,
  registerClassParent,
  registerClassParentLazy,
  rememberClassParent,
  registerClassObject,
  resolveClassStaticParent,
} from "../src/runtime/class-static-parent.js";

let seq = 0;
/** Unique per test — the registry is module-global and never cleared. */
const freshName = () => `C_5280_${seq++}`;

describe("#5280 class-static-parent null heritage", () => {
  it("records an explicit null parent so it overrides an earlier same-name class", () => {
    const name = freshName();
    class Base {}
    registerClassParent(name, Base);
    expect(getClassParent(name)).toBe(Base);

    // The next file declares `class <name> extends null`. Before #5280 this
    // was a no-op and `Base` kept the entry — the whole bug.
    registerClassParent(name, null);
    expect(getClassParent(name)).toBeNull();
  });

  it("treats undefined heritage the same as null", () => {
    const name = freshName();
    class Base {}
    registerClassParent(name, Base);
    registerClassParent(name, undefined);
    expect(getClassParent(name)).toBeNull();
  });

  it("still reports an unregistered name as undefined, not null", () => {
    // `undefined` (never registered) and `null` (`extends null`) are different
    // answers and callers distinguish them.
    expect(getClassParent(freshName())).toBeUndefined();
  });

  it("does not let a stale lazy property-access resolver override an explicit null", () => {
    const name = freshName();
    class Stale {}
    registerClassParentLazy(name, () => Stale);
    expect(getClassParent(name)).toBe(Stale);

    const name2 = freshName();
    registerClassParentLazy(name2, () => Stale);
    registerClassParent(name2, null);
    expect(getClassParent(name2)).toBeNull();
  });

  it("keeps ordinary non-null registration and memoization unchanged", () => {
    const name = freshName();
    class Base {}
    class Other {}
    registerClassParent(name, Base);
    expect(getClassParent(name)).toBe(Base);
    rememberClassParent(name, Other);
    expect(getClassParent(name)).toBe(Other);
    // A null-valued remember is still ignored (it is a memoization hint, not a
    // heritage declaration).
    rememberClassParent(name, null);
    expect(getClassParent(name)).toBe(Other);
  });

  it("reports MISS for static inheritance through a null parent", () => {
    const name = freshName();
    const classObj = {};
    registerClassObject(classObj, name);
    registerClassParent(name, null);
    expect(resolveClassStaticParent(classObj, "anything", undefined, (v) => v)).toBe(MISS);
  });
});
