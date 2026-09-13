/**
 * Unhandled host-promise rejections, attributed to the test that caused them.
 *
 * Node's default `unhandled-rejections=throw` mode terminates the process when
 * a rejected promise is never observed. In this harness both lanes execute
 * upstream test bodies — the Wasm lane in a disposable compile worker, the
 * native oracle in the driver process — so ONE unobserved host rejection used
 * to cost a whole file: the worker died mid-run, the parent found no JSON on
 * stdout, and every test of that file (including the ones that had already
 * passed) was recorded as failed with a null error. #5362's bisect spent its
 * budget on exactly that shape: hono's `src/utils/cookie.test.ts` read 24/35
 * -> 0/35 because one `crypto.subtle.importKey` call rejected unobserved.
 *
 * Installing a listener switches Node to "report, don't terminate", which is
 * only half the fix: the reason still has to land on a test. These helpers own
 * that half — capture the reasons, hand them to the sequential test loop at a
 * point where the event loop has actually reported them, and fold them into
 * the settled result of the test that was running.
 */

/** A rejection reason as a single line of report text. */
export function rejectionText(reason) {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }
  return String(reason);
}

/**
 * Capture unhandled rejections for later attribution instead of dying on them.
 *
 * `drain()` yields one full event-loop turn before taking what it captured.
 * That turn is load-bearing, not politeness: Node reports a rejection as
 * unhandled only after the microtask queue drains, and a sequential test loop
 * made of `await`s never leaves that queue on its own. Without the turn, a
 * rejection leaked by test 1 is first observed after test N and attributed to
 * the wrong test.
 */
export function createUnhandledRejectionSink({ label = "dogfood", stream = process.stderr } = {}) {
  const pending = [];
  const pendingUncaught = [];
  const onRejection = (reason) => {
    const text = rejectionText(reason);
    pending.push(text);
    // Printed once, here. Attribution below may decline to overwrite an
    // existing failure reason, so this is the record that never gets dropped.
    stream.write(`[${label}] unhandled host rejection: ${text}\n`);
  };
  const onUncaught = (error) => {
    const text = rejectionText(error);
    pendingUncaught.push(text);
    stream.write(`[${label}] uncaught host exception: ${text}\n`);
  };
  let armed = false;
  process.on("unhandledRejection", onRejection);
  const takeAfterOneTurn = async (queue) => {
    await new Promise((resolve) => setImmediate(resolve));
    return queue.splice(0, queue.length);
  };
  return {
    async drain() {
      return takeAfterOneTurn(pending);
    },
    /**
     * Start capturing `uncaughtException` — deliberately NOT on by default.
     *
     * (#6424) A stray host timer scheduled by a guest test throws outside every
     * awaited body, so without a listener Node kills the whole worker and the
     * file reads 0/N. But an uncaught exception is more often a HARNESS bug
     * (bad import object, compiler crash) than guest behaviour, and swallowing
     * one of those replaces a readable fast failure with a worker timeout — the
     * worker would never reach its `emit`. So the listener is armed only for
     * the window in which a test is actually running, and the returned
     * `disarm()` puts the fast-fail behaviour back for compile, instantiation,
     * module init, teardown and emit.
     */
    armUncaughtExceptions() {
      if (armed) return () => {};
      armed = true;
      process.on("uncaughtException", onUncaught);
      let disarmed = false;
      return () => {
        if (disarmed) return;
        disarmed = true;
        armed = false;
        process.off("uncaughtException", onUncaught);
      };
    },
    async drainUncaught() {
      return takeAfterOneTurn(pendingUncaught);
    },
    dispose() {
      process.off("unhandledRejection", onRejection);
      process.off("uncaughtException", onUncaught);
      armed = false;
    },
  };
}

/**
 * Fold captured rejection reasons into one test's settled result.
 *
 * A test that already failed keeps its own reason. #5823's async-resume guard
 * turns an uncatchable wasm trap into a rejection of the frame's result
 * promise, so those failures arrive through the test's own error channel; a
 * second, identical-looking "unhandled rejection: ..." on top of them would be
 * a double report of one defect.
 *
 * `kind` names the channel the reasons came from, so an uncaught host
 * exception (#6424) reads as itself rather than borrowing the rejection label.
 */
export function attributeRejections({ reasons, passed, error, late = false, kind = "unhandled rejection" }) {
  if (reasons.length === 0) return { passed, error };
  const text = `${kind}${late ? " (late)" : ""}: ${reasons.join("; ")}`;
  if (!passed) return { passed, error: error || text };
  return { passed: false, error: text };
}

/** The module-level `runtimeError` text for rejections owned by no test, or null. */
export function moduleRejectionText(reasons) {
  return reasons && reasons.length > 0 ? `unhandled rejection: ${reasons.join("; ")}` : null;
}
