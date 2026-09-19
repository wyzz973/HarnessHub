# Competition Full Access

The Competition Full Bundle keeps the ordinary HarnessHub safety policy unchanged and offers an explicit competition-only break-glass mode for unattended evaluation.

- `gateway.cmd` and `Start-Competition.cmd` in the bundle set `HARNESSHUB_FULL_ACCESS=1`; the offline kit's `Start-Competition.cmd` starts `competition\gateway.cmd`, so it uses the same mode.
- `gateway-safe.cmd` clears the switch and keeps normal permission prompts and denials.
- While the switch is on, ACP permission requests are approved automatically, and `POST /session/{id}/prompt_async` also approves pending permissions while it waits, so no human interaction is needed.
- Native modes: Codex starts in `agent-full-access`, Gemini and Qwen use `--approval-mode yolo`, Hermes uses `HERMES_YOLO_MODE=1`, DSH uses `DSH_PERMISSION_MODE=danger-full-access` (its default `workspace-write` sandbox runs the shell under a restricted token on Windows, where starting any external program fails with "Access is denied"). OpenCode, MiMo, Pi and OpenClaw rely on the ACP approval (OpenClaw's private exec policy is widened by its bundled launcher); OpenCode no longer receives `OPENCODE_PERMISSION`, which made fixed OpenCode runs fail, and MiMo no longer receives `--yolo`, which `mimo acp` rejects before ACP initialize.
- The engine is chosen once per Gateway start with `AGENT_ENGINE` (or `--engine`); every engine uses only the unified model configured through `HARNESSHUB_MODEL*`, never its own API key, login or subscription.
- `Install-Tool-Pack.cmd --source <directory, mcp.json or cli.json> --engines all` installs one local Tool Pack (Skill, MCP and/or CLI), verifies it, preflights every selected bundled engine and saves only compatible bindings; MCP servers and CLI tools run in each Session's own directory.

Full Access does not bypass model availability, operating-system ACLs or engine-specific protocol limitations, and it is not an operating-system sandbox: engines run with the permissions of the current Windows user.
