/**
 * The sync line's time, after "Synced ·" (owner, 19 Oct): "Today at 2:10 PM", "Yesterday at
 * 2:10 PM", otherwise the date, "Oct 15 at 2:24 PM". Plain Date arithmetic lives here, outside
 * the Svelte component, so the component holds no mutable Date of its own.
 */
export function formatSyncTime(date: Date, now: Date = new Date()): string {
  const clock = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (sameDay(date, now)) return `Today at ${clock}`;
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (sameDay(date, yesterday)) return `Yesterday at ${clock}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${clock}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}
