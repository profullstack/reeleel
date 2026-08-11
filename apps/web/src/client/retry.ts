/**
 * When a dropped chunk is worth trying again.
 *
 * Chunking already makes an upload resumable, but resuming was a thing a human
 * had to press. That is a fine story for a 200 MB import and a hopeless one for
 * a 10 GB one: over the tens of minutes a file that size is in flight, at least
 * one chunk will lose its connection, and an upload that stops dead at 40%
 * waiting to be noticed is indistinguishable from an upload that failed.
 *
 * What actually happens in front of the server is that the platform edge hangs
 * up when the app stalls writing to a network-backed volume for long enough.
 * The bytes already on disk are still good and the offset still says where to
 * carry on from — the only thing missing was anyone trying. So the driver
 * retries in place, and this decides which failures are worth retrying.
 *
 * Kept apart from the uploader itself because it is the part with the rules in
 * it, and rules are worth testing without a DOM.
 */

/**
 * How long one chunk may keep failing before the upload gives up and asks for
 * help. Generous on purpose: a stalled writer on the server is released by its
 * own stall timeout, and quitting sooner would abandon an upload that was about
 * to recover on its own.
 */
export const CHUNK_RETRY_BUDGET_MS = 3 * 60 * 1000;

/**
 * Failures that mean "not now" rather than "not ever".
 *
 * `UPLOAD_BUSY` is the subtle one. When the edge hangs up, the server does not
 * find out until its own read stalls, so for a while it is still writing a
 * chunk whose client is already gone. A retry arriving in that window is
 * refused — and must be, because two writers on one part file would interleave
 * and produce a video that is corrupt in a way nothing downstream can see.
 * Waiting is the correct response, not failing.
 */
const RETRYABLE_CODES = new Set([
  'NETWORK',
  'UPLOAD_BUSY',
  'UPLOAD_STALLED',
  'UPLOAD_ABORTED',
  'UPLOAD_OFFSET_MISMATCH',
]);

/**
 * Whether a failed chunk should be sent again.
 *
 * Status is consulted as well as code because the failure that started all of
 * this never reaches the application at all: the edge answers 502 itself, and
 * the body it returns carries no code of ours.
 */
export const isRetryable = (code: string, status: number): boolean => {
  // A user pressing Pause or Cancel is an instruction, not a fault.
  if (code === 'ABORTED') return false;
  // A full disk is reported as 507, inside the 5xx band, and is exactly the
  // failure that resending will not fix — it only fills the disk faster.
  if (code === 'DISK_SPACE_LOW') return false;
  if (RETRYABLE_CODES.has(code)) return true;
  // 0 is XHR's way of saying the connection never produced a response.
  if (status === 0) return true;
  if (status === 408 || status === 429) return true;
  // Deliberately the gateway band and not all of 5xx: the failures worth
  // resending are the ones between the browser and the app, not a server
  // saying it cannot store this.
  return status >= 500 && status <= 504;
};

/**
 * How long to keep asking about an import whose answer went missing. Longer
 * than a chunk's budget because the work behind it is bounded by the size of
 * the file rather than by one request, and a multi-gigabyte file takes a while
 * to probe.
 */
export const IMPORT_RETRY_BUDGET_MS = 10 * 60 * 1000;

/**
 * Whether a request failed without the application ever answering it.
 *
 * A narrower question than {@link isRetryable}, and the right one for a step
 * that is safe to repeat only because it never really ran. A 500 is an answer:
 * the import was attempted and failed, and asking again just fails again.
 * A 502 from the edge is the absence of one.
 */
export const isLostAnswer = (code: string, status: number): boolean => {
  if (code === 'ABORTED') return false;
  if (code === 'NETWORK') return true;
  return status === 0 || status === 502 || status === 503 || status === 504;
};

/**
 * How long to wait before attempt `attempt` (1 = the first retry).
 *
 * Backs off to a plateau rather than growing without bound: the wait exists to
 * let a stalled server finish, not to punish the upload, and a 10 GB import has
 * no time to spare on idle minutes.
 */
export const backoffMs = (attempt: number): number => {
  const step = 500 * 2 ** Math.max(0, attempt - 1);
  return Math.min(step, 10_000);
};
