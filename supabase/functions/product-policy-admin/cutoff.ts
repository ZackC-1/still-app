// The paid cutoff snapshot the owner endpoint attaches to the FIRST sales activation (U6).
//
// Owner question 6 is open: which features count as "actually released free" at the first real
// paid activation, and which protected product id the snapshot carries (it must differ from
// `still-pro-v3`). Until the owner answers and a reviewed change sets it, this stays null, and
// migration 0016 refuses any sales policy that would activate a sale ("cutoff_required"), writing
// nothing. Pausing, resuming, retrying or adding a store later never creates a second cutoff: the
// database keeps at most one write-once row per environment.
//
// To set it: a reviewed code change replacing null with
//   { product: "<protected product id>", benefits: ["<feature id>", ...] }
// (feature ids sorted, unique, 1 to 32, each matching the packaged build-id pattern), deployed only
// with the separately approved paid activation.

export interface PaidCutoffSnapshot {
  readonly product: string;
  readonly benefits: readonly string[];
}

export const PAID_CUTOFF_SNAPSHOT: PaidCutoffSnapshot | null = null;
