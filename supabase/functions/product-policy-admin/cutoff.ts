// The paid cutoff snapshot the owner endpoint attaches to the FIRST sales activation (U6).
//
// Migration 0016 refuses ANY non-null snapshot at the database (apply_product_policy raises
// "product policy cutoff not enabled"), so "no paid activation" does not depend on this constant. A
// future reviewed migration enables the cutoff write; before it does, the snapshot must be shown in
// the owner preview and bound into the preview hash (today it is in neither).
//
// Owner question 6 is open: which features count as "actually released free" at the first real
// paid activation, and which protected product id the snapshot carries (it must differ from
// `still-pro-v3`). Until the owner answers and reviewed changes set it, this stays null, and an
// activating sales policy answers "cutoff_required", writing nothing. Pausing, resuming, retrying
// or adding a store later never creates a second cutoff: the database keeps at most one write-once
// row per environment.
//
// To set it (only together with the migration that enables the cutoff write): a reviewed change
// replacing null with
//   { product: "<protected product id>", benefits: ["<feature id>", ...] }
// (feature ids sorted, unique, 1 to 32, each matching the packaged build-id pattern), deployed only
// with the separately approved paid activation.

export interface PaidCutoffSnapshot {
  readonly product: string;
  readonly benefits: readonly string[];
}

export const PAID_CUTOFF_SNAPSHOT: PaidCutoffSnapshot | null = null;
