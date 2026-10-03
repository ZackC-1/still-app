import postgres from "postgres";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { createSettingsAnchorIdentity } from "./settings-anchor.ts";
import {
  type LockedSettingsRow,
  type SettingsStore,
  SettingsWriteHold,
} from "./settings-store.ts";

/** Only still_settings_writer credentials belong here; never service_role/entitlement writer. */
export class PgSettingsStore implements SettingsStore {
  constructor(private readonly sql: ReturnType<typeof postgres>) {}
  async locked<T>(
    subject: string,
    work: (row: LockedSettingsRow) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      signal?.throwIfAborted();
      return await this.sql.begin(async (tx) => {
        signal?.throwIfAborted();
        async function run<R>(
          query: PromiseLike<R> & { cancel?: () => void },
        ): Promise<R> {
          signal?.throwIfAborted();
          const cancel = () => {
            query.cancel?.();
          };
          signal?.addEventListener("abort", cancel, { once: true });
          try {
            const result = await query;
            signal?.throwIfAborted();
            return result;
          } finally {
            signal?.removeEventListener("abort", cancel);
          }
        }
        await run(
          tx`select pg_catalog.set_config('request.jwt.claim.sub', ${subject}, true), pg_catalog.set_config('lock_timeout', '1s', true), pg_catalog.set_config('statement_timeout', '2s', true), pg_catalog.set_config('idle_in_transaction_session_timeout', '5s', true)`,
        );
        const identity = createSettingsAnchorIdentity();
        const key = bytesToHex(identity.key);
        const rows = await run(
          tx`select private.lock_settings(${subject}::uuid, ${identity.lineage}::uuid, ${key}) as state`,
        );
        const state = rows[0]?.state;
        if (!state) throw new Error("Missing locked settings state");
        if (state.numeric_supported === false) {
          throw new SettingsWriteHold("bounds");
        }
        const anchor = {
          subject,
          lineage: state.lineage as string,
          revision: Number(state.revision),
          key: hexToBytes(state.key as string),
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
            const result = await run(
              // postgres infers JSONB OIDs and serializes values again. These are already
              // serialized JSON bytes; bind as text before the server parses JSONB once.
              tx`select private.claim_settings_write(${subject}::uuid, ${writeId}::uuid, ${body}::text::jsonb) as status`,
            );
            return result[0]!.status;
          },
          commit: async (settings, writeId, receiptRevision, operations) => {
            await run(
              tx`select private.commit_settings(${subject}::uuid, ${anchor.lineage}::uuid, ${anchor.revision}::bigint, ${state.settings_text}::text::jsonb, ${
                JSON.stringify(settings)
              }::text::jsonb, ${writeId}::uuid, ${receiptRevision}::bigint, ${
                JSON.stringify(operations)
              }::text::jsonb)`,
            );
          },
        }).then((result) => {
          signal?.throwIfAborted();
          return result;
        });
      }) as T;
    } catch (error) {
      // begin has rolled back before this trusted, parameter-free signal escapes.
      if (error instanceof SettingsWriteHold) throw error;
      // The private commit helper raises only this parameter-free code for a final
      // raw canonical hold. begin has already rolled back the claimed identity.
      if (error instanceof postgres.PostgresError && error.code === "PST01") {
        throw new SettingsWriteHold("bounds");
      }
      // postgres errors may contain SQL parameters and the private key. Never send/log them.
      throw new Error("Settings storage unavailable");
    }
  }
}
