// `gh` calls that survive one transient GitHub error (#7551).
//
// A single HTTP 502 from `gh api` used to fail whole jobs: deploy-pages run
// 45822055293 kept the site on stale numbers for hours over one bad response.
// Server errors (HTTP 5xx) and network failures are retried with backoff; a
// client error (HTTP 4xx) is a real answer and fails at once.
import { execFileSync } from "node:child_process";

export const GH_RETRY_DELAYS_SECONDS = [2, 5, 15];

const NETWORK_FAILURE =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|connection reset|timed? ?out|unexpected EOF|TLS handshake/i;

/** True for a failure worth retrying: HTTP 5xx or a network error, never HTTP 4xx. */
export function isTransientGhFailure(error) {
  const text = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  if (/HTTP 4\d\d/.test(text)) return false;
  return /HTTP 5\d\d/.test(text) || NETWORK_FAILURE.test(text);
}

function sleepSeconds(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

/** Run `gh <args>` and return stdout, retrying transient failures (4 attempts by default). */
export function ghWithRetry(
  args,
  { exec = execFileSync, sleep = sleepSeconds, delays = GH_RETRY_DELAYS_SECONDS, log = console.error } = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return exec("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    } catch (error) {
      if (attempt >= delays.length || !isTransientGhFailure(error)) throw error;
      log(
        `gh ${args.slice(0, 2).join(" ")}: transient failure, retry ${attempt + 1}/${delays.length} in ${delays[attempt]} s`,
      );
      sleep(delays[attempt]);
    }
  }
}
