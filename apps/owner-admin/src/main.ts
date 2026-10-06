// Owner page entry: wiring only. With no public configuration compiled in, the page shows the
// neutral "Not available here" and never creates a client.
import { mount } from "svelte";
import "@still/core/ui/v3/design/styles.css";
import App from "./App.svelte";
import { AdminClient, httpTransport } from "./admin-client.js";
import { supabaseOwnerAuth } from "./auth.js";

const url = __STILL_SUPABASE_URL__;
const anonKey = __STILL_SUPABASE_ANON_KEY__;
const auth = url && anonKey ? supabaseOwnerAuth(url, anonKey) : null;
const client = auth
  ? new AdminClient(
      httpTransport({
        functionUrl: `${url}/functions/v1/product-policy-admin`,
        anonKey,
        accessToken: () => auth.accessToken(),
      }),
    )
  : null;

mount(App, { target: document.getElementById("app")!, props: { auth, client } });
