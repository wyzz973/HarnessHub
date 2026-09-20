HarnessHub Windows portable bundle

1. Extract the entire ZIP to a writable directory. Use the bundle matching your Windows CPU architecture.
2. Double-click Start.cmd to open the Gateway and web console (http://127.0.0.1:3330).
3. Model credentials are required for real tasks. No models are called by the commands below:
   hub.cmd doctor --full
   hub.cmd smoke
   hub.cmd engines

Unified model: every engine uses only the one model configured in HarnessHub; engine-specific API
keys, logins and subscriptions are not used. Sources, highest priority first:
  1. Environment of the starting window (not written to disk):
       $env:HARNESSHUB_MODEL = "<upstream model id>"
       $env:HARNESSHUB_MODEL_BASE_URL = "https://<model gateway>/v1"   (required with HARNESSHUB_MODEL)
       $env:HARNESSHUB_MODEL_API_KEY = "<key value>"
     Optional: HARNESSHUB_MODEL_PROTOCOL (openai-completions), HARNESSHUB_MODEL_CONTEXT_WINDOW,
     HARNESSHUB_MODEL_MAX_OUTPUT_TOKENS.
  2. hub.cmd model set --model ID --base-url URL --api-key-env NAME   (hub.cmd model show to check)
  3. The top-level "model" of a settings file applied with hub.cmd configure (example below).
The upstream must be a streaming OpenAI Chat Completions endpoint.

Configure DeepSeek V4 Flash with the bundled settings example:
  In PowerShell, read a key without storing it in your command history:
    $secret = Read-Host 'DeepSeek API key' -AsSecureString
    $env:DEEPSEEK_API_KEY = [Net.NetworkCredential]::new('', $secret).Password
    .\hub.cmd configure --file .\examples\deepseek.json
    .\hub.cmd start
  Keep this terminal open. End with Ctrl+C. Never distribute state/ after entering credentials or running tasks.
  You can also create a Windows encrypted credential through the console and configure its reference.

Competition bundles also contain gateway.cmd: set AGENT_ENGINE (for example opencode) and the
unified model, then run .\gateway.cmd. It serves the competition API on http://localhost:6217 and
starts the console on http://127.0.0.1:3330 (see README-COMPETITION.txt).
Diagnostic logs (JSON Lines, secrets redacted): <data dir>\logs\gateway.log and one
backends\<sessionId>\diagnostics\engine.log per Session; HARNESSHUB_LOG_LEVEL=debug adds payload
excerpts. In competition bundles .\Collect-Logs.cmd packs them into logs-<time>.zip.

Preinstalled Tool Packs (competition bundles): the packs listed in tool-packs\preinstalled.json are
applied to every compatible engine by Start.cmd / hub.cmd start and gateway.cmd before the first
start finishes; nothing has to be installed. A pack is applied once per content: packs you unbind
later stay unbound, a changed pack is applied again. HARNESSHUB_PREINSTALL_TOOL_PACKS=0 disables it
(any value other than 0 or 1 is rejected). Problems never stop the Gateway; they are printed once
and logged as toolpack.preinstall in the Gateway log. GET /v1/tool-packs marks them preinstalled.

Install a bundled tool package in PowerShell from the extracted directory:
  .\hub.cmd tools install --source "$PWD\tools\workspace-tools"
  .\hub.cmd tools use workspace-tools 1.0.0 --engine opencode
  .\hub.cmd tools verify --id workspace-tools --version 1.0.0
  .\hub.cmd tools unuse --id workspace-tools --version 1.0.0 --engine opencode
  .\hub.cmd tools remove --id workspace-tools --version 1.0.0
  Restart the service after changing release settings. New sessions use the new configuration.
  If the console has an overriding engine configuration, CLI changes fail explicitly.
  Edit that engine in the console or use a fresh extraction; existing history is preserved.

Pi/OpenClaw use native extensions/skills instead of session MCP; unsupported bindings fail explicitly.
Kimi uses the official noninteractive CLI because its ACP mode requires vendor OAuth.
With a unified model, Cursor/Kiro/Antigravity/Qoder are disabled because they cannot be routed
through it; without one they can require vendor credentials.
These account/protocol limits cannot be removed by packaging executable files.

This bundle includes fixed Node, engine programs, Python/VC components as needed, PortableGit and the web UI.
No npm/pip/git installation, source compilation or engine download is required on the judge machine.
External model APIs still require network access. Optional browsers/voice/cloud services are not bundled.
ARM64 bundles include x64 Hermes/Kiro components and require Windows 11 x64 emulation.
See THIRD_PARTY_NOTICES.md and each vendor's LICENSE/terms before redistributing vendor components.

All runs, settings, installed tool packages and evaluation evidence live under state/.
Use a fresh extraction for a clean evaluation. Competition-specific requirements and x64 acceptance
must be checked on the actual judge OS; this package alone does not establish competition compliance.
