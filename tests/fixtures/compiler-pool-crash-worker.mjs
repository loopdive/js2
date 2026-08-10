// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Deterministic fixture for #689: one source always kills its worker; all
// other sources complete normally so the replacement process can be probed.
process.on("message", (message) => {
  if (message.source === "__crash_worker__") {
    process.exit(86);
  }
  if (message.execute) {
    process.send({ id: message.id, status: "pass", compileMs: 0, execMs: 0 });
    return;
  }
  process.send({
    id: message.id,
    ok: true,
    binary: Buffer.from([0]).toString("base64"),
    stringPool: [],
    imports: [],
    sourceMap: null,
    compileMs: 0,
  });
});

process.send({ type: "ready", pid: process.pid });
