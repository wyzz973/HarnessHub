HarnessHub - Windows 11 ARM64 open-source engines and offline development kit

Use the entire extracted directory. Runtime, engine programs, local tools,
development dependencies and fixed source archives are already included.
The company machine does not run npm/pip/git installation or download engines.
Hermes uses the included x64 Python through Windows 11 x64 emulation.

Company gateway configuration (OpenAI Chat Completions only):
1. Copy examples/company-chat.json to a private local configuration file.
2. Replace model, baseUrl and KIMI_MODEL_MAX_CONTEXT_SIZE with the company model
   contract. The baseUrl is the SDK base, normally ending in /v1, not the full
   /chat/completions route. Do not paste an API key into the JSON.
3. In PowerShell in this directory:
   $secret = Read-Host 'Company model API key' -AsSecureString
   $env:COMPANY_MODEL_API_KEY = [Net.NetworkCredential]::new('', $secret).Password
   .\hub.cmd configure --file C:\private\company-settings.json
   .\hub.cmd start
   Open http://127.0.0.1:3330 and keep this terminal open.
   Windows encrypted references may also be created through the console.

Supported configuration IDs:
  codex, gemini, qwen, pi, mimo, dsh, openclaw, kimi, opencode, hermes
Codex/Gemini use explicit local protocol adapters to Chat Completions.
These preserve supported text and function-tool flows, not all vendor APIs.
Check the repository compatibility and verification records for exact scope.

Local commands that do not call a model:
  .\hub.cmd engines
  .\hub.cmd doctor --full
  .\hub.cmd smoke
  .\hub.cmd tools install --source "$PWD\tools\workspace-tools"
  .\hub.cmd tools use workspace-tools 1.0.0 --engine opencode
  .\hub.cmd tools verify --id workspace-tools --version 1.0.0
Restart after release settings changes. New sessions use the new settings.
If console overrides conflict with a file change, edit the console entry;
history and existing settings are deliberately preserved.

Offline company checkout development (source files stay in your checkout):
  .\Dev.cmd prepare C:\Company\HarnessHub
  .\Dev.cmd typecheck C:\Company\HarnessHub
  .\Dev.cmd build C:\Company\HarnessHub
prepare copies already-bundled dependencies, verifies the bundle and refuses
existing node_modules directories. Lockfile and dependency patches must match.
typecheck checks Gateway/tests; build also compiles the web console.
Preserve existing directories first or
use a separate company checkout. Dependencies added by the company need an
updated offline kit prepared outside the internal network.

Use skills/harnesshub-company-gateway/SKILL.md with the company Agent.
Company gateway code and credentials must stay inside the company network.
Merge the engine/driver/tool changes with the existing company gateway.
Do not replace the company gateway with the public implementation.

Source archives are fixed official Git commits with licenses and hashes.
distribution/source-repositories.json identifies vendor/engine-sources files;
split archives must be reassembled
and verified before extraction. Source does not substitute for build tools:
rebuilding Rust/Python/native engines needs the respective prepared toolchain.
The offline kit supports rebuilding HarnessHub and its web console.

Mutable settings, installed tools, workspaces and evidence live under state/.
Do not upload or redistribute state/ after company configuration or testing.
No company endpoint, company source or user model credential is embedded.
