# Competition Full Access

The Competition Full Bundle intentionally keeps the ordinary HarnessHub safety policy unchanged while offering an explicit competition-only break-glass mode.

- `gateway.cmd` and `Start-Competition.cmd` set `HARNESSHUB_FULL_ACCESS=1`.
- `gateway-safe.cmd` clears the switch and preserves normal permission handling.
- ACP permission requests are auto-approved only while the switch is enabled.
- Harness-specific adapters may translate the switch to their native full-access/YOLO mode.
- `Install-Tool-Pack.cmd` installs one local Capability Pack containing Skill, MCP and/or CLI capabilities, verifies it, preflights selected bundled engines, and saves only compatible bindings.

Full Access does not bypass provider authentication, model availability, operating-system ACLs, or engine-specific protocol limitations.
