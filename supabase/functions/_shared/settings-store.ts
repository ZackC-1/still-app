import {
  migrateSettingsV2,
  serializeSettingsV2,
} from "../../../packages/core/src/storage/settings-v2.ts";
import { mergeSettingsField } from "../../../packages/core/src/sync/field-order.ts";
import {
  MAX_SETTINGS_REVISION,
  SETTINGS_FIELDS,
  type SettingsField,
  type SettingsV2,
} from "@still/shared-types";
import type { UntrustedSettingsOperationRequest } from "../../../packages/shared-types/src/settings-operation.ts";
import {
  issueSettingsAnchorReceipt,
  type SettingsAnchorState,
  verifySettingsAnchorReceipt,
} from "./settings-anchor.ts";

/** This port's callback and commit run on the SAME locked database transaction. */
export interface LockedSettingsRow {
  readonly anchor: SettingsAnchorState;
  readonly raw: unknown;
  readonly empty: boolean;
  readonly updatedAt: string | null;
  readonly writeId: string | null;
  readonly now: number;
  claim(
    writeId: string,
    body: string,
  ): Promise<"new" | "duplicate" | "conflict">;
  commit(
    settings: SettingsV2,
    writeId: string,
    receiptRevision: number,
    operations: UntrustedSettingsOperationRequest["operations"],
  ): Promise<void>;
}
export interface SettingsStore {
  locked<T>(
    subject: string,
    work: (row: LockedSettingsRow) => Promise<T>,
  ): Promise<T>;
}
export type SettingsSyncResult =
  | {
    status: "ready";
    protocol: 2;
    empty: boolean;
    settings: SettingsV2;
    settingsVersion: number;
    settingsServerUpdatedAt: string | null;
    writeId: string | null;
    lineage: string;
    receipt: Awaited<ReturnType<typeof issueSettingsAnchorReceipt>>;
  }
  | { status: "hold"; reason: string }
  | {
    status: "rejected";
    reason: "receipt" | "operation-base" | "write-id-conflict";
  };

function value(settings: SettingsV2, field: SettingsField): boolean {
  if (field === "globalOn") return settings.globalOn;
  const [group, ...rest] = field.split(".");
  return (settings[group!] as Record<string, boolean>)[rest.join(".")]!;
}
function assign(
  settings: SettingsV2,
  field: SettingsField,
  enabled: boolean,
): void {
  if (field === "globalOn") {
    (settings as Record<string, unknown>).globalOn = enabled;
  } else {
    const [group, ...rest] = field.split(".");
    (settings[group!] as Record<string, unknown>)[rest.join(".")] = enabled;
  }
}

/** Shared parser/migrator/order are the only interpretation authorities. No rank is allocated here. */
export function syncSettings(
  store: SettingsStore,
  subject: string,
  request: UntrustedSettingsOperationRequest | null,
): Promise<SettingsSyncResult> {
  return store.locked(subject, async (row) => {
    const revision = row.anchor.revision;
    if (
      !Number.isSafeInteger(revision) || revision < 0 ||
      revision > MAX_SETTINGS_REVISION
    ) {
      return { status: "hold", reason: "revision" };
    }
    const migrated = migrateSettingsV2(
      row.raw,
      row.empty ? { kind: "proven-fresh" } : {
        kind: "acknowledged-account",
        revision,
      },
    );
    if (migrated.status !== "ready") {
      return { status: "hold", reason: migrated.reason };
    }
    let settings = migrated.settings;
    let finalRevision = revision;
    let writeId = row.writeId;
    let updatedAt = row.updatedAt;
    let empty = row.empty;
    if (
      SETTINGS_FIELDS.some((field) =>
        settings.clocks[field].baseRevision > revision && !migrated.migrated
      )
    ) {
      return { status: "hold", reason: "future-stamp" };
    }
    if (request) {
      if (
        request.expectedLineage !== row.anchor.lineage ||
        !await verifySettingsAnchorReceipt(request.receipt, row.anchor)
      ) {
        return { status: "rejected", reason: "receipt" };
      }
      if (
        request.operations.some((op) =>
          op.baseRevision !== request.receipt.revision && op.baseRevision !== 0
        )
      ) {
        return { status: "rejected", reason: "operation-base" };
      }
      const claimed = await row.claim(request.writeId, JSON.stringify(request));
      if (claimed === "conflict") {
        return { status: "rejected", reason: "write-id-conflict" };
      }
      if (claimed === "new") {
        const candidate = JSON.parse(
          serializeSettingsV2(settings),
        ) as SettingsV2;
        for (const op of request.operations) {
          const merged = mergeSettingsField({
            value: value(candidate, op.path),
            stamp: candidate.clocks[op.path],
          }, {
            value: op.value,
            stamp: { baseRevision: op.baseRevision, localStep: op.localStep },
          });
          assign(candidate, op.path, merged.value);
          (candidate.clocks as Record<string, unknown>)[op.path] = merged.stamp;
        }
        if (serializeSettingsV2(candidate) !== serializeSettingsV2(settings)) {
          if (revision === MAX_SETTINGS_REVISION) {
            return { status: "hold", reason: "revision-saturated" };
          }
          (candidate as Record<string, unknown>).updatedAt = row.now;
          // Bound the complete merged JSON again; retained future data can approach the parser limit.
          const checked = migrateSettingsV2(candidate, {
            kind: "readable-local",
          });
          if (checked.status !== "ready") {
            return { status: "hold", reason: checked.reason };
          }
          await row.commit(
            checked.settings,
            request.writeId,
            request.receipt.revision,
            request.operations,
          );
          settings = checked.settings;
          finalRevision++;
          writeId = request.writeId;
          updatedAt = new Date(row.now).toISOString();
          empty = false;
        }
      }
    }
    return {
      status: "ready",
      protocol: 2,
      empty,
      settings,
      settingsVersion: finalRevision,
      settingsServerUpdatedAt: updatedAt,
      writeId,
      lineage: row.anchor.lineage,
      receipt: await issueSettingsAnchorReceipt({
        ...row.anchor,
        revision: finalRevision,
      }),
    };
  });
}
