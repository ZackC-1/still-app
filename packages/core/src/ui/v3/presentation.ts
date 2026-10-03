import {
  FEATURE_REGISTRY,
  type FeatureId,
  type ServiceId,
  type SettingsV2,
  type BenefitAccessSnapshot,
} from "@still/shared-types";

/** Presentation labels/order only. Feature identity, defaults and tier remain registry-owned. */
export function rowsFor(service: ServiceId) {
  const rows = FEATURE_REGISTRY.filter((row) => row.service === service);
  if (service === "instagram") {
    const position = (row: (typeof rows)[number]) => {
      if (row.tier === "free") return 0;
      if (row.id === "instagram.stories") return 1;
      if (row.id === "instagram.explore") return 2;
      return FEATURE_REGISTRY.indexOf(row);
    };
    rows.sort((a, b) => position(a) - position(b));
  }
  return rows.map((row) => ({
    ...row,
    label:
      row.tier === "free"
        ? service === "youtube"
          ? "Shorts"
          : "Reels"
        : row.name,
  }));
}

export interface DesktopPopupProps {
  settings: SettingsV2;
  access: BenefitAccessSnapshot;
  browser: "Chrome" | "Firefox";
  onGlobalChange: (next: boolean) => void;
  onServiceChange: (service: ServiceId, next: boolean) => void;
  onFeatureChange: (feature: FeatureId, next: boolean) => void;
  onSignIn?: () => void;
  onSettings: () => void;
  privacyUrl: string;
  /** Trusted caller supplies this only when an actual eligible purchase flow exists. */
  onPurchase?: () => void;
  account?: {
    address: string;
    status?: {
      tone: "pending" | "success" | "failed" | "caution" | "info";
      text: string;
      retry?: () => void;
    };
  };
  sectionMemory?: {
    read: () => ServiceId | null;
    write: (service: ServiceId | null) => void;
  };
  services?: readonly ServiceId[];
  features?: readonly FeatureId[];
  labels?: Partial<Record<FeatureId, string>>;
  heroTitle?: string;
}
