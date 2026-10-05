import seed from "../../../rules/seed.json";
import { DEFAULT_SETTINGS, type SignedRuleSet, type StillSettings } from "@still/shared-types";

export const ruleSet = seed as unknown as SignedRuleSet;

export function settings(over: Partial<StillSettings> = {}): StillSettings {
  return { ...DEFAULT_SETTINGS, ...over };
}
