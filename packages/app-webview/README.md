# Apple app webview

The web UI loaded by the iOS and macOS host app. `src/main.ts` wires the shared Svelte UI,
Apple session orchestrator and native bridge; domain behavior lives in [core](../core/README.md).

From the repository root:

- `pnpm --filter @still/app-webview build`: generate the ignored `dist/` consumed by Xcode.
- `pnpm --filter @still/app-webview typecheck`: check TypeScript and Svelte wiring.
- `pnpm --filter @still/app-webview dev`: preview web UI during development; a browser preview
  does not supply the Apple native bridge or certify native flows.

Use [.env.example](.env.example) for configuration names and the
[Apple build guide](../../apps/apple/scripts/README.md) for complete builds. This package is the
in-app webview; the public marketing website is maintained under `docs/`.
