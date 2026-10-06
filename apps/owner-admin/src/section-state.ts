// The status a policy section shows, shared by the rating and sales sections.
import type { Progress } from "./apply-flow.js";

export type SectionState =
  | "idle"
  | Progress
  | "applied"
  | "stale"
  | "failed"
  | "cutoff-refused"
  | "unconfirmed";

export const isBusy = (state: SectionState) => state === "applying" || state === "readback";
