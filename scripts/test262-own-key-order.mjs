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
