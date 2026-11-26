// `gh` calls that survive one transient GitHub error (#7551).
//
// A single HTTP 502 from `gh api` used to fail whole jobs: deploy-pages run
// 45822055293 kept the site on stale numbers for hours over one bad response.
// Server errors (HTTP 5xx, including the artifact blob store behind
// `gh run download`) and network failures are retried with backoff; a client
// error (HTTP 4xx) is a real answer and fails at once.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

export const GH_RETRY_DELAYS_SECONDS = [2, 5, 15];

const SERVER_FAILURE =
  /HTTP 5\d\d|\bstatus(?: code)?:? 5\d\d\b|\b5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)/i;
const NETWORK_FAILURE =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|connection reset|timed? ?out|unexpected EOF|TLS handshake/i;

/** True for a failure worth retrying: a server or network error, never HTTP 4xx. */
export function isTransientGhFailure(error) {
  const text = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  if (/HTTP 4\d\d/.test(text)) return false;
  return SERVER_FAILURE.test(text) || NETWORK_FAILURE.test(text);
}

function sleepSeconds(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

/** The `--dir` a `gh run download` writes into: a failed attempt may leave it half-written. */
function downloadDir(args) {
  const i = args.indexOf("--dir");
  return args[0] === "run" && args[1] === "download" && i >= 0 ? args[i + 1] : undefined;
}

/** Run `gh <args>` and return stdout, retrying transient failures (4 attempts by default). */
export function ghWithRetry(
  args,
  {
    exec = execFileSync,
    sleep = sleepSeconds,
    delays = GH_RETRY_DELAYS_SECONDS,
    log = console.error,
    clean = (dir) => rmSync(dir, { recursive: true, force: true }),
  } = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return exec("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    } catch (error) {
      if (attempt >= delays.length || !isTransientGhFailure(error)) throw error;
      log(
        `gh ${args.slice(0, 2).join(" ")}: transient failure, retry ${attempt + 1}/${delays.length} in ${delays[attempt]} s`,
      );
      const dir = downloadDir(args);
      if (dir) clean(dir);
      sleep(delays[attempt]);
    }
  }
}
