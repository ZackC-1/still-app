// The alarm that sends quietly recorded analytics (see extension-host.ts). It fires at a random time
// between one and six hours after a background start that queued something quietly, so the moment
// events reach PostHog has nothing to do with when the person opened a supported site. An alarm
// already set is left alone: the first quiet event of a stretch decides the time.

export const QUIET_FLUSH_ALARM = "still-analytics-quiet-flush";
const MIN_MINUTES = 60;
const MAX_MINUTES = 360;

interface AlarmsApi {
  get(name: string): Promise<unknown>;
  create(name: string, info: { delayInMinutes: number }): unknown;
}

export function quietFlushDelayMinutes(random: () => number = Math.random): number {
  return MIN_MINUTES + Math.floor(random() * (MAX_MINUTES - MIN_MINUTES));
}

export function requestQuietFlush(alarms: AlarmsApi | undefined, random: () => number = Math.random): void {
  if (!alarms) return;
  void Promise.resolve(alarms.get(QUIET_FLUSH_ALARM))
    .then((existing) => {
      if (!existing) return alarms.create(QUIET_FLUSH_ALARM, { delayInMinutes: quietFlushDelayMinutes(random) });
    })
    .catch(() => {});
}
