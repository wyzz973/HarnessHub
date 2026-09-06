HarnessHub Windows portable bundle

1. Extract the entire ZIP to a writable directory. Use the bundle matching your Windows CPU architecture.
2. Double-click Start.cmd to open the Gateway and web console (http://127.0.0.1:3330).
3. Model credentials are required for real tasks. No models are called by the commands below:
   hub.cmd doctor --full
   hub.cmd smoke
   hub.cmd engines

Configure DeepSeek V4 Flash:
  In PowerShell, read a key without storing it in your command history:
    $secret = Read-Host 'DeepSeek API key' -AsSecureString
    $env:DEEPSEEK_API_KEY = [Net.NetworkCredential]::new('', $secret).Password
    .\hub.cmd configure --file .\examples\deepseek.json
    .\hub.cmd start
  Keep this terminal open. End with Ctrl+C. Never distribute state/ after entering credentials or running tasks.
  You can also create a Windows encrypted credential through the console and configure its reference.

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
Cursor/Kiro/Antigravity/Qoder can require vendor credentials. Gemini requires a Google-compatible API.
These account/protocol limits cannot be removed by packaging executable files.

This bundle includes fixed Node, engine programs, Python/VC components as needed, PortableGit and the web UI.
No npm/pip/git installation, source compilation or engine download is required on the judge machine.
External model APIs still require network access. Optional browsers/voice/cloud services are not bundled.
ARM64 bundles include x64 Hermes/Kiro components and require Windows 11 x64 emulation.
See THIRD_PARTY_NOTICES.md and each vendor's LICENSE/terms before redistributing vendor components.

All runs, settings, installed tool packages and evaluation evidence live under state/.
Use a fresh extraction for a clean evaluation. Competition-specific requirements and x64 acceptance
must be checked on the actual judge OS; this package alone does not establish competition compliance.
