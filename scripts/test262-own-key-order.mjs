// (#6492 r19) Own-key ORDER restore for the test262 worker's shared intrinsics.
//
// Its own module (rather than a `test262-worker.mjs` local) because the worker
// `process.send`s at load and therefore cannot be imported from a unit test —
// same reason `test262-sandbox-globals.mjs` lives on its own.
//
// ## Why value-restore is not enough
//
// `restoreBuiltins()` restores a static's VALUE. test262's `verifyProperty`
// probes configurability with `delete obj[key]` and does NOT put the key back,
// so the next re-definition appends it at the END of the own-key order.
// `built-ins/Promise/property-order.js` asserts `name` comes directly after
// `length` in `Object.getOwnPropertyNames(Promise)` and therefore reads a
// PRECEDING row's deletion. This was invisible until #6492 r18 made the
// sandbox share the host `%Promise%`; before that each row read its own copy.

/**
 * Restore `obj`'s own-key order to `snapOrder`, best effort.
 *
 * The comparison ignores keys the snapshot does not know about, so a test's
 * leftover additions never force a rebuild. From the first divergence onward
 * every snapshot key is deleted and re-defined in snapshot order.
 *
 * ## What it guarantees, exactly
 *
 * The CONFIGURABLE keys come back in their pristine relative order. A
 * NON-configurable key (`Promise.prototype`, a function's `prototype`) cannot
 * be deleted, so it acts as a fixed point and may end up ahead of keys that
 * originally preceded it. That is a deliberate limit, not an oversight: no
 * sequence of deletes and defines can move a non-configurable key, so the
 * alternative is to leave the whole object unrepaired. The row this exists for
 * — `property-order.js` — asserts a relation between two configurable keys
 * (`name` directly after `length`), which the guarantee above covers.
 *
 * Everything is best effort; nothing here recycles the fork.
 *
 * @param {object} obj target intrinsic
 * @param {Array<string|symbol>} snapOrder own keys in pristine order
 * @param {Map<string|symbol, PropertyDescriptor|undefined>} snapDescriptors pristine descriptors
 */
export function restoreOwnKeyOrder(obj, snapOrder, snapDescriptors) {
  let current;
  try {
    current = Reflect.ownKeys(obj).filter((k) => snapDescriptors.has(k));
  } catch {
    return;
  }
  let firstDiff = -1;
  for (let i = 0; i < snapOrder.length; i++) {
    if (current[i] !== snapOrder[i]) {
      firstDiff = i;
      break;
    }
  }
  if (firstDiff === -1 && current.length === snapOrder.length) return;
  if (firstDiff === -1) firstDiff = snapOrder.length;

  for (let i = firstDiff; i < snapOrder.length; i++) {
    const key = snapOrder[i];
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(obj, key);
    } catch {
      continue;
    }
    if (desc && desc.configurable) {
      try {
        delete obj[key];
      } catch {}
    }
  }
  for (let i = firstDiff; i < snapOrder.length; i++) {
    const key = snapOrder[i];
    const desc = snapDescriptors.get(key);
    if (!desc) continue;
    // A non-configurable survivor could not be deleted; leave it in place.
    if (Object.prototype.hasOwnProperty.call(obj, key)) continue;
    try {
      Object.defineProperty(obj, key, desc);
    } catch {}
  }
}

/** Capture `obj`'s pristine own-key order plus every own descriptor. */
export function snapshotOwnKeyOrder(obj) {
  const order = Reflect.ownKeys(obj);
  const descriptors = new Map(order.map((k) => [k, Object.getOwnPropertyDescriptor(obj, k)]));
  return { order, descriptors };
}

// ---------------------------------------------------------------------------
// (#6492 r20) Symbol-keyed own properties and getter METADATA.
//
// Two restore gaps the value/order lists above do not cover, both visible as
// permanent `#1957` realm-canary drift on a full `built-ins/Promise/` slice:
//
//   Promise.prototype.Symbol(Symbol.toStringTag):deleted
//   Promise.Symbol(Symbol.species)<get>.length:deleted
//
// The first is a SYMBOL-keyed own property — `_METHOD_SNAPSHOTS` and
// `_STATIC_SNAPSHOTS` list string keys only. The second is a sub-property of a
// GETTER FUNCTION: test262's `verifyProperty` deletes `length`/`name` to probe
// configurability and does not put them back, and the #3470 function-metadata
// restore walks methods, not accessor `get`/`set` functions. Both matter only
// because the sandbox now SHARES these objects with the host (#6492 r18).

/**
 * Capture every own symbol-keyed descriptor, plus the `name`/`length`
 * sub-properties of every own function on the object — accessor `get`/`set`
 * AND plain method values. The method half closes the three
 * `Promise.prototype.{then,catch,finally}:changed` canary lines, which are
 * metadata drift on an UNCHANGED function identity (a `verifyProperty` row
 * deleted the function's own `name`), not a replaced method.
 */
export function snapshotSymbolAndAccessorMeta(obj) {
  const symbols = new Map();
  const accessorMeta = [];
  if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) return { symbols, accessorMeta };
  for (const sym of Object.getOwnPropertySymbols(obj)) {
    symbols.set(sym, Object.getOwnPropertyDescriptor(obj, sym));
  }
  for (const key of Reflect.ownKeys(obj)) {
    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(obj, key);
    } catch {
      continue;
    }
    for (const role of ["get", "set", "value"]) {
      const fn = desc?.[role];
      if (typeof fn !== "function") continue;
      for (const meta of ["name", "length"]) {
        const metaDesc = Object.getOwnPropertyDescriptor(fn, meta);
        if (metaDesc) accessorMeta.push([fn, meta, metaDesc]);
      }
    }
  }
  return { symbols, accessorMeta };
}

/**
 * Put both back, best effort. A symbol key is re-defined when it is missing or
 * its descriptor no longer matches; accessor metadata is re-defined only when
 * the sub-property is GONE (a test that legitimately redefines `name` on its
 * own function is not this snapshot's business — these are the host's own
 * functions).
 */
export function restoreSymbolAndAccessorMeta(obj, snapshot) {
  if (!snapshot) return;
  for (const [sym, desc] of snapshot.symbols) {
    if (!desc) continue;
    let cur;
    try {
      cur = Object.getOwnPropertyDescriptor(obj, sym);
    } catch {
      continue;
    }
    if (cur && cur.value === desc.value && cur.get === desc.get && cur.set === desc.set) continue;
    try {
      Object.defineProperty(obj, sym, desc);
    } catch {}
  }
  for (const [fn, meta, desc] of snapshot.accessorMeta) {
    if (Object.prototype.hasOwnProperty.call(fn, meta)) continue;
    try {
      Object.defineProperty(fn, meta, desc);
    } catch {}
  }
}
