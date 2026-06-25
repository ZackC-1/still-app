import { type JwtPayload, signEs256, signHs256 } from "./jwt.ts";

// Shared test token minting. Real Supabase user tokens carry iss/aud/role; mint test tokens with the
// same standard claims so the iss/aud/role validation (verifyJwt) exercises the production shape.
// Tests that need a malformed/wrong claim override it explicitly (e.g. `mintHs256({ role: "anon" }, …)`).

export const TEST_PROJECT_URL = "https://test-project.supabase.co";
export const TEST_ISS = `${TEST_PROJECT_URL}/auth/v1`;

/** The expected-claims config a handler under test should be given (matches the minted tokens). */
export const TEST_EXPECTED_CLAIMS = {
  iss: TEST_ISS,
  aud: "authenticated",
  role: "authenticated",
} as const;

const STANDARD_CLAIMS: JwtPayload = {
  iss: TEST_ISS,
  aud: "authenticated",
  role: "authenticated",
};

/** Mint an HS256 user token with standard authenticated claims; overrides win (set iss/aud/role/exp). */
export function mintHs256(payload: JwtPayload, secret: string): Promise<string> {
  return signHs256({ ...STANDARD_CLAIMS, ...payload }, secret);
}

/** Mint an ES256 user token (hosted shape) with standard authenticated claims. */
export function mintEs256(payload: JwtPayload, privateKey: CryptoKey, kid: string): Promise<string> {
  return signEs256({ ...STANDARD_CLAIMS, ...payload }, privateKey, kid);
}
