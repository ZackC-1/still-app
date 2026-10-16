import { SettingsStorageRecovery } from "./atomic-settings.js";

/** The Still app's native host id (its bundle id); Safari ignores it but the API requires it. */
export const SAFARI_NATIVE_APP = "com.chartash.still";

/**
 * How long a Safari page waits for one native reply before treating it as lost, and, separately,
 * how long a message may wait for its turn before it is dropped unsent.
 */
export const SAFARI_NATIVE_REPLY_BOUND_MS = 8_000;

// ISS-0050: a Safari extension page must not overlap its own native messages. Quick taps in a
// Safari popup overlapped a settings intent with the read its own projection write triggered, with
// the next tap's intent and with the popup's two-second account-status poll. An overlapped message
// failed, the page held every switch as "Settings are unavailable." and recovered only at its next
// timed read. The Apple app's in-process handler never overlapped this way and never froze.
//
// So every native message an extension page sends goes through one channel per page (per runtime
// object). A message is sent at once when nothing is outstanding. Otherwise it waits until the
// outstanding message is answered or that message's reply bound passes (it is then lost), so a
// slow reply never overlaps the next message. A caller that stops waiting does not free the
// channel early; the host still has its message. A message that cannot be sent within the reply
// bound of being queued is dropped unsent, so no caller waits behind a hung host indefinitely.
interface Channel {
  outstanding: object | null;
  sentAt: number;
  readonly queue: Array<() => void>;
  waitTimer: ReturnType<typeof setTimeout> | undefined;
}
const channels = new WeakMap<object, Channel>();

// A queued message waits a little longer than an outstanding one can stay outstanding, so a lost
// reply frees the channel before the message behind it gives up.
const QUEUE_WAIT_BOUND_MS = SAFARI_NATIVE_REPLY_BOUND_MS + 250;

type NativeRuntime = { sendNativeMessage(application: string, message: unknown): Promise<unknown> };

// Safari exposes the same runtime as both `browser` and `chrome`.
function nativeRuntime(): NativeRuntime | null {
  const scope = globalThis as unknown as Record<"browser" | "chrome", { runtime?: Partial<NativeRuntime> } | undefined>;
  for (const runtime of [scope.browser?.runtime, scope.chrome?.runtime])
    if (runtime && typeof runtime.sendNativeMessage === "function") return runtime as NativeRuntime;
  return null;
}

/** Send the next queued message, or, while one is outstanding, wait at most until it counts as lost. */
function pump(channel: Channel): void {
  if (channel.queue.length === 0) {
    clearTimeout(channel.waitTimer);
    channel.waitTimer = undefined;
    return;
  }
  if (channel.outstanding === null) {
    clearTimeout(channel.waitTimer);
    channel.waitTimer = undefined;
    channel.queue.shift()!();
    return;
  }
  // Timers exist only while a message is actually waiting.
  if (channel.waitTimer !== undefined) return;
  const remaining = Math.max(0, SAFARI_NATIVE_REPLY_BOUND_MS - (Date.now() - channel.sentAt));
  channel.waitTimer = setTimeout(() => {
    channel.waitTimer = undefined;
    channel.outstanding = null; // its reply is lost
    pump(channel);
  }, remaining);
}

/**
 * Send one native message on this page's Safari channel. A caller that aborts, or that cannot be
 * sent within the reply bound of queuing, is dropped without sending anything. Once sent, the
 * caller gets the host's reply, or `native-authority-unavailable` when the host refuses it or does
 * not answer within the reply bound. Nothing is ever sent twice.
 */
export function sendSafariNativeMessage(message: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const runtime = nativeRuntime();
  if (!runtime) return Promise.reject(new SettingsStorageRecovery("native-authority-unavailable"));
  let lane = channels.get(runtime);
  if (!lane) {
    lane = { outstanding: null, sentAt: 0, queue: [], waitTimer: undefined };
    channels.set(runtime, lane);
  }
  const channel = lane;
  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", unavailable);
      const queued = channel.queue.indexOf(send);
      if (queued >= 0) {
        channel.queue.splice(queued, 1);
        pump(channel);
      }
      outcome();
    };
    function unavailable(): void {
      finish(() => reject(new SettingsStorageRecovery("native-authority-unavailable")));
    }
    function send(): void {
      clearTimeout(timer);
      const token = {};
      channel.outstanding = token;
      channel.sentAt = Date.now();
      let sent: Promise<unknown>;
      try {
        sent = Promise.resolve(runtime!.sendNativeMessage(SAFARI_NATIVE_APP, message));
      } catch (error) {
        sent = Promise.reject(error);
      }
      timer = setTimeout(unavailable, SAFARI_NATIVE_REPLY_BOUND_MS);
      void sent.then((reply) => finish(() => resolve(reply)), unavailable).finally(() => {
        if (channel.outstanding !== token) return;
        channel.outstanding = null;
        pump(channel);
      });
    }
    if (signal?.aborted) {
      unavailable();
      return;
    }
    signal?.addEventListener("abort", unavailable, { once: true });
    if (channel.outstanding === null && channel.queue.length === 0) {
      send();
      return;
    }
    channel.queue.push(send);
    pump(channel);
    timer = setTimeout(unavailable, QUEUE_WAIT_BOUND_MS);
  });
}
