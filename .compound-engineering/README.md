# Compound Engineering configuration

Still uses Compound Engineering in three harnesses:

- Claude Code
- Codex Personal (`~/.codex-personal`)
- Codex Work (`~/.codex-work`)

The plugin and agents are installed separately in each harness. The shared brain lives in this
repository; it is not copied between profile directories. See [`../docs/SHARED-BRAIN.md`](../docs/SHARED-BRAIN.md).

## Repository setup

Copy the example only when local configuration is needed:

```bash
cp .compound-engineering/config.local.example.yaml \
  .compound-engineering/config.local.yaml
```

`config.local.yaml` is ignored by Git. Because all three harnesses use this same checkout, they see
the same local file. A separate worktree needs its own copy if its behavior should differ.

Do not place API keys, credentials, customer data, or production database URLs in this configuration.

## Harness commands

| Purpose | Claude Code | Codex |
|---|---|---|
| Initial project setup | `/ce-setup` | `$ce-setup` |
| Plan | `/ce-plan` | `$ce-plan` |
| Execute | `/ce-work` | `$ce-work` |
| Capture learning | `/ce-compound` | `$ce-compound` |
| Refresh knowledge | `/ce-compound-refresh` | `$ce-compound-refresh` |

Run the skill from the repository or the worktree that owns the task so it reads and writes the
correct branch.

## Codex profile maintenance

The two Codex profiles must be updated independently and with the same `CODEX_HOME` used to launch
that profile:

```bash
for PROFILE in "$HOME/.codex-personal" "$HOME/.codex-work"; do
  CODEX_HOME="$PROFILE" \
    bunx @every-env/compound-plugin install compound-engineering --to codex
done
```

The native plugin itself is managed through `/plugins` inside each Codex profile. After an install or
update, restart that profile before expecting newly added skills to appear.

Update the Claude plugin and both Codex profiles together when practical so all agents follow the
same Compound Engineering behavior.

## Session history

Do not use shared raw session folders as the project brain. The upstream `ce-sessions` discovery
currently knows the standard Codex session path but not the two custom Codex profile paths. The
authoritative cross-harness memory is the committed repository documentation.

If a future workflow needs cross-profile transcript search, implement a read-only discovery adapter
for `~/.codex-personal/sessions/` and `~/.codex-work/sessions/`; do not redirect either profile to a
shared writable session directory.
