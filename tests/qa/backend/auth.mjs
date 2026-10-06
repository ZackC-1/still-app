// Local Auth helpers for QA runs against the QA stack only:
//   * requestCode: ask Auth to email a one-time code (the real sign-in path, read back from Mailpit);
//   * adminCode:   the fallback that skips email, using Auth's admin "generate link" endpoint with the
//                  local stack's well-known service key (never a hosted key: the URL must be local);
//   * verifyCode:  exchange a code for a session, proving the code works;
//   * createUser:  seed a confirmed disposable user.
// Every URL is checked to be localhost before any request.
import { assertLocalUrl } from "./guard.mjs";

const base = apiUrl => assertLocalUrl(apiUrl, "API URL").replace(/\/+$/, "");
const json = async (response, label) => {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
};

export async function requestCode({ apiUrl, anonKey, email, fetchImpl = fetch }) {
  const response = await fetchImpl(`${base(apiUrl)}/auth/v1/otp`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anonKey },
    body: JSON.stringify({ email, create_user: true }),
  });
  await json(response, "OTP request");
}

/** The one-time code from the admin generate-link endpoint (top level or under `properties`). */
export async function adminCode({ apiUrl, serviceRoleKey, email, fetchImpl = fetch }) {
  const response = await fetchImpl(`${base(apiUrl)}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` },
    body: JSON.stringify({ type: "magiclink", email }),
  });
  const body = await json(response, "generate_link");
  const code = body.email_otp ?? body.properties?.email_otp;
  if (typeof code !== "string" || !/^\d{6,10}$/.test(code)) throw new Error("generate_link returned no email_otp");
  return code;
}

/** Exchange a code for a session. Returns the access token (kept in memory by the caller only). */
export async function verifyCode({ apiUrl, anonKey, email, code, fetchImpl = fetch }) {
  const response = await fetchImpl(`${base(apiUrl)}/auth/v1/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anonKey },
    body: JSON.stringify({ type: "email", email, token: code }),
  });
  const body = await json(response, "OTP verify");
  if (typeof body.access_token !== "string") throw new Error("verify returned no session");
  return body.access_token;
}

export async function createUser({ apiUrl, serviceRoleKey, email, fetchImpl = fetch }) {
  const response = await fetchImpl(`${base(apiUrl)}/auth/v1/admin/users`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}` },
    body: JSON.stringify({ email, email_confirm: true }),
  });
  const body = await json(response, "create user");
  return body.id;
}

/** Call one Edge Function as a signed-in user. Returns `{ status, data }`; the token never leaves memory. */
export async function invokeFunction({ apiUrl, anonKey, accessToken, name, body, fetchImpl = fetch }) {
  const response = await fetchImpl(`${base(apiUrl)}/functions/v1/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: anonKey, authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* a non-JSON body is reported by status only */ }
  return { status: response.status, data };
}

/** Whether the Realtime service answers behind the gateway (any HTTP answer below 500 on its route). */
export async function realtimeAnswers({ apiUrl, anonKey, fetchImpl = fetch }) {
  const response = await fetchImpl(`${base(apiUrl)}/realtime/v1/api/ping`, { headers: { apikey: anonKey } });
  return response.status < 500;
}
