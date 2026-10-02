import { assert, assertEquals, assertMatch } from "@std/assert";
import { Buffer } from "node:buffer";
import { createServer } from "node:tls";
import { once } from "node:events";
import { createAuditConnection } from "./audit.ts";

Deno.test("audit TLS rejects untrusted certificates and hostname mismatches", async () => {
  const temporary = await Deno.makeTempDir({ dir: "/tmp" });
  try {
    for (const hostname of ["localhost", "wrong.example.invalid"]) {
      const generated = await new Deno.Command("openssl", {
        args: [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          `/CN=${hostname}`,
          "-addext",
          `subjectAltName=DNS:${hostname}`,
          "-keyout",
          `${temporary}/key.pem`,
          "-out",
          `${temporary}/cert.pem`,
        ],
        stdout: "null",
        stderr: "null",
      }).output();
      assertEquals(generated.code, 0);
      await Deno.chmod(`${temporary}/key.pem`, 0o600);
      const key = await Deno.readTextFile(`${temporary}/key.pem`);
      const cert = await Deno.readTextFile(`${temporary}/cert.pem`);
      for (
        const trustCertificate of hostname === "localhost"
          ? [true, false]
          : [true]
      ) {
        let acceptedHandshake = false;
        const server = createServer({
          key,
          cert,
          ALPNProtocols: ["postgresql"],
        }, (socket) => {
          acceptedHandshake = true;
          // TLS-only probe: no database, authentication, SQL or customer records exist.
          let startup = true;
          socket.on("data", () => {
            if (startup) {
              startup = false;
              socket.write(
                Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73]),
              );
            } else {
              const body = Buffer.from("SERROR\0CXX000\0MTLS_PROBE\0\0");
              const header = Buffer.alloc(5);
              header[0] = 69;
              header.writeUInt32BE(body.length + 4, 1);
              socket.write(
                Buffer.concat([
                  header,
                  body,
                  Buffer.from([90, 0, 0, 0, 5, 73]),
                ]),
              );
            }
          });
        });
        server.on("tlsClientError", () => {});
        server.listen(0, "localhost");
        await once(server, "listening");
        const address = server.address();
        assert(address && typeof address !== "string");
        const sql = createAuditConnection(
          `postgres://synthetic:synthetic@localhost:${address.port}/synthetic?sslnegotiation=direct&sslmode=require`,
          trustCertificate ? cert : undefined,
        );
        // This fixture speaks only enough wire framing to terminate the TLS probe.
        sql.options.fetch_types = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const failure = await Promise.race([
            sql.unsafe("select 1").then(
              () => "unexpected SQL success",
              (error: Error) => error.message,
            ),
            new Promise<string>((resolve) => {
              timer = setTimeout(() => resolve("TLS probe timed out"), 5_000);
            }),
          ]);
          assertEquals(
            acceptedHandshake,
            trustCertificate && hostname === "localhost",
          );
          assertMatch(
            failure,
            acceptedHandshake
              ? /TLS_PROBE/
              : /certificate|hostname|self.signed|altname/i,
          );
        } finally {
          clearTimeout(timer);
          await sql.end({ timeout: 1 });
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
    }
  } finally {
    await Deno.remove(temporary, { recursive: true });
  }
});
