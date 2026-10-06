// Approved deletion wording, in one place so every screen shows exactly the same lines.
//
// WITHDRAWAL_OUTCOMES: the v3.2 design system's SharingSetting lines (U5-W2 design §11). They serve
// both the device "stop sharing" erasure (SharingCard) and the account-wide deletion below, which
// reuses them as owner decision 74 approved. Pending is never success: only "deleted" is a success.
//
// SHARED_DATA_COPY: owner decision 74 (U5-W3 design §7, option A), verbatim. The account-wide action
// deletes account data only (owner decision 61), so nothing here may imply that this device's
// signed-out data is deleted. Never "everywhere".

export const WITHDRAWAL_OUTCOMES = {
  requested: {
    tone: "pending",
    text: "Deletion requested. Your shared data hasn't been deleted yet.",
  },
  verifying: {
    tone: "pending",
    text: "Confirming deletion with our providers…",
  },
  deleted: { tone: "success", text: "Your shared data has been deleted." },
  failed: {
    tone: "failed",
    text: "We couldn't send your deletion request. Sharing stays off on this device.",
  },
} as const;

export const WITHDRAWAL_RETRY = "Try again";

export const SHARED_DATA_COPY = {
  label: "Delete shared data on all devices",
  sub: "Stops sharing on every device signed in to this account and deletes what they shared. Your account, settings and purchases stay.",
  confirmTitle: "Delete shared data from all your devices?",
  confirmBody:
    "This turns off sharing on every device signed in to this account and deletes the email and usage data shared while signed in. Your account, settings and purchases stay. Anything a device shared while signed out stays until you turn sharing off on that device.",
  confirm: "Delete shared data",
  cancel: "Cancel",
  stoppedElsewhere: "Sharing was turned off from another device.",
} as const;
