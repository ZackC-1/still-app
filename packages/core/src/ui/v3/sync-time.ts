/**
 * The last successful sync time as the Chrome popup shows it (DesktopPopup.svelte, ISS-0056):
 * "Oct 15, 2:24 PM" in the person's locale. The Apple app's sync card uses it so both read alike.
 */
export function formatLastSynced(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
