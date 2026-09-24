// Installs Still in a running Firefox as a temporary add-on over the remote debugging protocol,
// the same way about:debugging loads one. Firefox must run with -start-debugger-server <port> and
// devtools.debugger.remote-enabled / prompt-connection set (see the capture scripts).
import { connect } from "node:net";

// Minimal remote debugging protocol client: messages are "<length>:<json>".
export function rdp(port) {
  return new Promise((resolveConn, reject) => {
    const sock = connect(port, "127.0.0.1");
    let buf = "";
    const waiters = [];
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      for (;;) {
        const colon = buf.indexOf(":");
        if (colon < 0) break;
        const len = Number(buf.slice(0, colon));
        if (buf.length < colon + 1 + len) break;
        const msg = JSON.parse(buf.slice(colon + 1, colon + 1 + len));
        if (process.env.RDP_DEBUG) console.log("rdp <", JSON.stringify(msg).slice(0, 300));
        buf = buf.slice(colon + 1 + len);
        const i = waiters.findIndex((w) => w.from === msg.from);
        if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
      }
    });
    sock.on("error", reject);
    const request = (to, body) => new Promise((res) => {
      waiters.push({ from: to, resolve: res });
      const json = JSON.stringify({ to, ...body });
      sock.write(`${Buffer.byteLength(json)}:${json}`);
    });
    waiters.push({ from: "root", resolve: () => resolveConn({ request, close: () => sock.end() }) });
  });
}


export async function installStill(port, addonPath) {
  let client;
  for (let i = 0; i < 40 && !client; i++) {
    client = await rdp(port).catch(() => null);
    if (!client) await new Promise((r) => setTimeout(r, 500));
  }
  if (!client) throw new Error("could not reach Firefox's debugger server on port " + port);
  const root = await client.request("root", { type: "getRoot" });
  const res = await client.request(root.addonsActor, { type: "installTemporaryAddon", addonPath });
  client.close();
  if (!res.addon) throw new Error("add-on install failed: " + JSON.stringify(res));
  await new Promise((r) => setTimeout(r, 1500));
  return res.addon.id;
}
