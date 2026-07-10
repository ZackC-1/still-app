// Pragmatic syntactic email check used to gate the sign-in CTA before issuing an auth request.
// It is deliberately lenient — a non-empty local part, a single @, and a dotted domain — not a
// deliverability guarantee. The point is to stop an obviously-malformed address from triggering a
// failing backend round-trip (and the confusing error that follows), not to reject valid-but-exotic
// addresses. Shared by SignInSheet (button gating + inline hint) and the controller (so a
// programmatic caller can't fire the doomed request either).
export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}
