@AGENTS.md

# Claude Code note

Compound Engineering skills use slash-command syntax in Claude Code, such as `/ce-plan`, `/ce-work`,
and `/ce-compound`. The shared instructions and repository knowledge in `AGENTS.md` remain the source
of truth across Claude Code and both Codex profiles.

Read `docs/MEMORY.md` for the shared Mem0 workflow. Retrieve Still context at the start of substantive
work and save concise decisions, verified outcomes and handoffs at checkpoints. Use the same
`still-app` user/app scope as Codex, with `agent_id: claude-code` on writes and no agent filter on
shared reads. Do not fall back to a global skill's unrelated project namespace.
