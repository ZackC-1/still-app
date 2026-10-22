import type postgres from "postgres";
import { PgPurchaseOperationStore, type PurchaseOperation, type PurchaseOperationStore } from "./purchase-operation-store.ts";
export type { PurchaseOperationStatus as QaPurchaseOperationStatus } from "./purchase-operation-store.ts";
export type QaPurchaseOperation = PurchaseOperation<"sandbox">;
export type QaPurchaseOperationStore = PurchaseOperationStore<"sandbox">;
/** QA deployment never selects the production ledger or accepts production receipts. */
export class PgQaPurchaseOperationStore extends PgPurchaseOperationStore<"sandbox"> {
  constructor(sql: ReturnType<typeof postgres>) { super(sql, "sandbox"); }
}
