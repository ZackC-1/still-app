// The owner page's view of the two remote policies. Bodies are parsed with the shared grammar
// (@still/shared-types/product-policy, the same parser the server and every client use), so the page
// never invents a field the server would refuse. Drafts carry only the namespace fields; the server
// adds the envelope (schema, environment, revision) and renders the canonical body itself.
import {
  DEFERRED_PRODUCT_POLICY_SURFACES,
  parseProductPolicy,
  PRODUCT_POLICY_SURFACES,
  SALES_CHANNELS,
  type ProductPolicyBuild,
  type ProductPolicyEnvironment,
  type ProductPolicySurface,
  type SalesChannel,
  type SalesOffer,
} from "@still/shared-types/product-policy";

export type Surface = ProductPolicySurface;
export const SURFACES = PRODUCT_POLICY_SURFACES;
export const isDeferred = (surface: Surface) => DEFERRED_PRODUCT_POLICY_SURFACES.includes(surface);

export interface RatingModel {
  readonly master: boolean;
  readonly surfaces: Readonly<Record<Surface, boolean>>;
  /** The packaged-build allowlist. This page never edits it; it is carried through unchanged. */
  readonly builds: readonly ProductPolicyBuild[];
}

export interface SalesModel {
  /** The one sales switch: the remote master and both reviewed channels together. */
  readonly on: boolean;
  readonly channels: Readonly<Record<SalesChannel, { readonly enabled: boolean; readonly offer: SalesOffer }>>;
  readonly builds: readonly ProductPolicyBuild[];
}

const OFFER: SalesOffer = "still-pro-v3";
const ascii = new TextEncoder();

/** No policy on record (revision 0) is Off everywhere. */
export const RATING_OFF: RatingModel = Object.freeze({
  master: false,
  surfaces: Object.freeze(Object.fromEntries(SURFACES.map((s) => [s, false])) as Record<Surface, boolean>),
  builds: Object.freeze([]),
});
export const SALES_OFF: SalesModel = Object.freeze({
  on: false,
  channels: Object.freeze(
    Object.fromEntries(SALES_CHANNELS.map((c) => [c, Object.freeze({ enabled: false, offer: OFFER })])) as SalesModel["channels"],
  ),
  builds: Object.freeze([]),
});

function parse(namespace: "rating" | "sales", environment: ProductPolicyEnvironment, body: string, revision: number) {
  try {
    const policy = parseProductPolicy(namespace, ascii.encode(body));
    return policy.environment === environment && policy.revision === revision ? policy : null;
  } catch {
    return null;
  }
}

/** The rating model for a stored body, or null when the body doesn't parse for this binding. */
export function ratingFromBody(environment: ProductPolicyEnvironment, body: string | null, revision: number): RatingModel | null {
  if (body === null) return revision === 0 ? RATING_OFF : null;
  const policy = parse("rating", environment, body, revision);
  if (!policy || !("master" in policy)) return null;
  return { master: policy.master, surfaces: { ...policy.surfaces }, builds: policy.builds };
}

export function salesFromBody(environment: ProductPolicyEnvironment, body: string | null, revision: number): SalesModel | null {
  if (body === null) return revision === 0 ? SALES_OFF : null;
  const policy = parse("sales", environment, body, revision);
  if (!policy || !("salesEnabled" in policy)) return null;
  return { on: policy.salesEnabled, channels: policy.channels, builds: policy.builds };
}

/** The namespace fields the admin function's `preview` accepts as `draft`. */
export function ratingDraft(model: RatingModel) {
  return {
    master: model.master,
    surfaces: Object.fromEntries(SURFACES.map((s) => [s, model.surfaces[s]])),
    builds: model.builds.map((b) => ({ surface: b.surface, build: b.build })),
  };
}

/** One switch: on means the remote master and both reviewed channels are on; off turns all three
 * off. The offer is always the one reviewed offer. Builds are carried through unchanged. */
export function salesDraft(model: SalesModel) {
  return {
    salesEnabled: model.on,
    channels: Object.fromEntries(SALES_CHANNELS.map((c) => [c, { enabled: model.on, offer: OFFER }])),
    builds: model.builds.map((b) => ({ surface: b.surface, build: b.build })),
  };
}

export type AllowanceKey = "global" | Surface;

/** The keys whose draft differs from the current server state. Deferred surfaces never change. */
export function changedAllowances(current: RatingModel, draft: RatingModel): AllowanceKey[] {
  const keys: AllowanceKey[] = [];
  if (current.master !== draft.master) keys.push("global");
  for (const s of SURFACES) if (!isDeferred(s) && current.surfaces[s] !== draft.surfaces[s]) keys.push(s);
  return keys;
}

/** Where prompts are allowed after Apply, by the same rule the server and clients use: master on,
 * the surface on, the surface not deferred, and a packaged build for it on the allowlist. */
export function liveSurfaces(model: RatingModel): Surface[] {
  if (!model.master) return [];
  return SURFACES.filter((s) => !isDeferred(s) && model.surfaces[s] && model.builds.some((b) => b.surface === s));
}
