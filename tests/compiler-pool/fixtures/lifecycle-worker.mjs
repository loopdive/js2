// A real IPC worker: SIGTERM is acknowledged, then the test releases it.
import { fork } from "node:child_process";
const mode = process.env.COMPILER_POOL_CLOSE_FIXTURE_MODE ?? "held";
process.on("SIGTERM", () => process.send?.({ type: "signal", pid: process.pid }));
process.on("message", (message) => {
  if (message.type === "release") {
    if (mode === "pipe") {
      const holder = fork(new URL("./pipe-holder.mjs", import.meta.url), [], {
        stdio: ["ignore", process.stdout, "inherit", "ipc"],
        execArgv: [],
      });
      holder.once("message", (ready) => {
        process.send?.({ type: "holder", pid: holder.pid, parentPid: process.pid, ready });
        process.exit(0);
      });
    } else process.exit(0);
    return;
  }
  const result = message.execute
    ? { id: message.id, status: "pass", compileMs: 0, execMs: 0 }
    : { id: message.id, ok: true, binary: "AA==", stringPool: [], imports: [], sourceMap: null, compileMs: 0 };
  if (message.source === "recycle") Object.assign(result, { recycle: true, recycleReason: "real fixture recycle" });
  process.send?.(result);
});
process.send?.({ type: "ready", pid: process.pid });
