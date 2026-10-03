import type postgres from "postgres";
import { createSettingsAnchorIdentity } from "./settings-anchor.ts";
import type { SettingsStore } from "./settings-store.ts";

/** Only still_settings_writer credentials belong here; never service_role/entitlement writer. */
export class PgSettingsStore implements SettingsStore {
  constructor(private readonly sql: ReturnType<typeof postgres>) {}
  async locked<T>(
    subject: string,
    work: Parameters<SettingsStore["locked"]>[1],
  ): Promise<T> {
    try {
      return await this.sql.begin(async (tx) => {
        await tx`select pg_catalog.set_config('request.jwt.claim.sub', ${subject}, true)`;
        const identity = createSettingsAnchorIdentity();
        const key = Array.from(
          identity.key,
          (v) => v.toString(16).padStart(2, "0"),
        ).join("");
        const rows =
          await tx`select private.lock_settings(${subject}::uuid, ${identity.lineage}::uuid, ${key}) as state`;
        const state = rows[0]?.state;
        if (!state) throw new Error("Missing locked settings state");
        const anchor = {
          subject,
          lineage: state.lineage as string,
          revision: Number(state.revision),
          key: Uint8Array.from(
            (state.key as string).match(/../g)!,
            (byte) => parseInt(byte, 16),
          ),
        };
        return await work({
          anchor,
          raw: state.settings,
          empty: state.empty,
          updatedAt: state.updated_at
            ? new Date(state.updated_at).toISOString()
            : null,
          writeId: state.write_id,
          now: Number(state.now),
          claim: async (writeId, body) => {
            const result =
              await tx`select private.claim_settings_write(${subject}::uuid, ${writeId}::uuid, ${body}::jsonb) as status`;
            return result[0]!.status;
          },
          commit: async (settings, writeId, receiptRevision, operations) => {
            await tx`select private.commit_settings(${subject}::uuid, ${anchor.lineage}::uuid, ${anchor.revision}::bigint, ${
              JSON.stringify(state.settings)
            }::jsonb, ${
              JSON.stringify(settings)
            }::jsonb, ${writeId}::uuid, ${receiptRevision}::bigint, ${
              JSON.stringify(operations)
            }::jsonb)`;
          },
        });
      }) as T;
    } catch {
      // postgres errors may contain SQL parameters and the private key. Never send/log them.
      throw new Error("Settings storage unavailable");
    }
  }
}
