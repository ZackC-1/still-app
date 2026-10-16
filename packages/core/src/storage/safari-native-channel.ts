import { SettingsStorageRecovery } from "./atomic-settings.js";

/** The Still app's native host id (its bundle id); Safari ignores it but the API requires it. */
export const SAFARI_NATIVE_APP = "com.chartash.still";

/** How long a Safari page waits for one native reply before treating it as lost. */
export const SAFARI_NATIVE_REPLY_BOUND_MS = 8_000;

/**
 * How long an unanswered message keeps the page's channel busy for a message waiting behind it.
 * Ordinary replies arrive well within it, so they never overlap; a lost reply delays the next
 * message by at most this long instead of the whole reply bound.
 */
export const SAFARI_NATIVE_BUSY_BOUND_MS = 2_000;

// ISS-0050: a Safari extension page must not overlap its own native messages. Quick taps in a
// Safari popup overlapped a settings intent with the read its own projection write triggered, with
// the next tap's intent and with the popup's two-second account-status poll. An overlapped message
// failed, the page held every switch as "Settings are unavailable." and recovered only at its next
// timed read. The Apple app's in-process handler never overlapped this way and never froze. So
// every native message an extension page sends about settings or the account goes through one
// channel per page (per runtime object): sent at once when nothing is outstanding, otherwise
// queued until the outstanding message is answered or the busy bound passes. A caller that stops
// waiting does not free the channel early; its message is still outstanding at the host.
interface Channel {
  outstanding: object | null;
  sentAt: number;
  readonly queue: Array<() => void>;
  busyTimer: ReturnType<typeof setTimeout> | undefined;
}
const channels = new WeakMap<object, Channel>();

type NativeRuntime = { sendNativeMessage(application: string, message: unknown): Promise<unknown> };

// Safari exposes the same runtime as both `chrome` and `browser`.
function nativeRuntime(): NativeRuntime {
  const scope = globalThis as unknown as Record<"chrome" | "browser", { runtime?: unknown } | undefined>;
  return (scope.chrome?.runtime ?? scope.browser?.runtime) as NativeRuntime;
}

function pump(channel: Channel): void {
  if (channel.queue.length === 0) {
    clearTimeout(channel.busyTimer);
    channel.busyTimer = undefined;
    return;
  }
  if (channel.outstanding === null) {
    clearTimeout(channel.busyTimer);
    channel.busyTimer = undefined;
    channel.queue.shift()!();
    return;
  }
  if (channel.busyTimer !== undefined) return;
  // A message is waiting behind an unanswered one: stop waiting once the busy bound has passed.
  const remaining = Math.max(0, SAFARI_NATIVE_BUSY_BOUND_MS - (Date.now() - channel.sentAt));
  channel.busyTimer = setTimeout(() => {
    channel.busyTimer = undefined;
    channel.outstanding = null;
    pump(channel);
  }, remaining);
}

/**
 * Send one native message on this page's Safari channel. A caller that aborts while waiting for its
 * turn is dropped without sending anything. Once sent, the caller gets the host's reply, or
 * `native-authority-unavailable` when the host refuses it or does not answer within the reply
 * bound. Nothing is ever sent twice.
 */
export function sendSafariNativeMessage(message: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const runtime = nativeRuntime();
  let channel = channels.get(runtime);
  if (!channel) {
    channel = { outstanding: null, sentAt: 0, queue: [], busyTimer: undefined };
    channels.set(runtime, channel);
  }
  const lane = channel;
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let replyBound: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(replyBound);
      signal?.removeEventListener("abort", onAbort);
      outcome();
    };
    const unavailable = () => finish(() => reject(new SettingsStorageRecovery("native-authority-unavailable")));
    const send = () => {
      if (settled) return pump(lane);
      const token = {};
      lane.outstanding = token;
      lane.sentAt = Date.now();
      let sent: Promise<unknown>;
      try {
        sent = Promise.resolve(runtime.sendNativeMessage(SAFARI_NATIVE_APP, message));
      } catch (error) {
        sent = Promise.reject(error);
      }
      replyBound = setTimeout(unavailable, SAFARI_NATIVE_REPLY_BOUND_MS);
      void sent.then((reply) => finish(() => resolve(reply)), unavailable).finally(() => {
        if (lane.outstanding !== token) return;
        lane.outstanding = null;
        pump(lane);
      });
    };
    const onAbort = () => {
      const queued = lane.queue.indexOf(send);
      if (queued >= 0) lane.queue.splice(queued, 1);
      unavailable();
      pump(lane);
    };
    if (signal?.aborted) {
      unavailable();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    lane.queue.push(send);
    pump(lane);
  });
}
