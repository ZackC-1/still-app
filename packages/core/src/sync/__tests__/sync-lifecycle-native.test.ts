// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { WKWebViewStorageAdapter } from "../../storage/wkwebview-adapter.js";
import { B, drain, harness } from "./support/sync-lifecycle-harness.js";

// Requires macOS/Swift. This executes the real store and bridge; it does not certify WebKit,
// physical-device lifecycle, App Group notifications, or signing.
describe.skipIf(process.platform !== "darwin")(
  "Swift settings bridge lifecycle isolation",
  () => {
    let temporary: string;
    let executable: string;
    beforeAll(async () => {
      temporary = await mkdtemp(join(tmpdir(), "still-sync-native-"));
      executable = join(temporary, "bridge");
      const root = resolve(import.meta.dirname, "../../../../..");
      // swiftc requires main.swift for the executable's top-level statements.
      await copyFile(
        join(import.meta.dirname, "support/sync-native-main.swift"),
        join(temporary, "main.swift"),
      );
      await promisify(execFile)("swiftc", [
        ...["StillSettings", "SharedSettingsStore", "SettingsBridge"].map(
          (name) =>
            join(root, "apps/apple/StillKit/Sources/StillKit", `${name}.swift`),
        ),
        join(temporary, "main.swift"),
        "-module-cache-path",
        join(temporary, "module-cache"),
        "-o",
        executable,
      ]);
    }, 60_000);
    afterAll(async () => {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    });

    it("keeps B's native record and next upload intact after A's late response", async () => {
      const native = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
      const queue: {
        resolve: (reply: string) => void;
        reject: (error: Error) => void;
      }[] = [];
      const lines = createInterface({ input: native.stdout });
      lines.on("line", (line) => queue.shift()?.resolve(line));
      const failPending = (error: Error) => {
        for (const pending of queue.splice(0)) pending.reject(error);
      };
      native.on("error", failPending);
      native.on("exit", () => failPending(new Error("Native bridge exited")));
      const storage = new WKWebViewStorageAdapter({
        webkit: {
          messageHandlers: {
            still: {
              postMessage: (message) =>
                new Promise<string>((resolveReply, reject) => {
                  queue.push({ resolve: resolveReply, reject });
                  native.stdin.write(JSON.stringify(message) + "\n");
                }),
            },
          },
        },
      });
      try {
        const h = harness(storage);
        await h.cache.hydrate();
        h.cache.watch();
        await h.session.verifyCode("alice@example.invalid", "synthetic");
        const late = h.holdWrite();
        await h.cache.setGlobalOn(false);
        await late.started;
        await h.session.signOut();
        await h.session.verifyCode("bob@example.invalid", "synthetic");
        const before = await storage.get();
        expect(before).toMatchObject({
          settings: { globalOn: true },
          syncMetadata: { version: 1 },
        });
        late.resolve();
        await drain();
        expect(await storage.get()).toEqual(before);
        expect((await h.session.getState()).userId).toBe(B);
        await h.cache.setService("instagram", false);
        await drain();
        expect(h.writes.at(-1)).toMatchObject({
          owner: B,
          settings: { globalOn: true },
        });
        expect((await storage.get())?.settings.globalOn).toBe(true);
      } finally {
        lines.close();
        native.kill();
      }
    });
  },
);
