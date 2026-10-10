import { DirectorySessionBindingFactory, prepareConfiguration } from "../../dist/src/infrastructure/session/binding-factory.js";
import { SqliteWorkspaceLeaseProvider } from "../../dist/src/infrastructure/session/workspace-lease.js";
import { dirname, join } from "node:path";
import { inventory } from "../../dist/src/infrastructure/catalog/inventory-composition.js";
import { LocalHarnessManagement } from "../../dist/src/infrastructure/management/service.js";
import { SqliteSessionStore } from "../../dist/src/infrastructure/session/sqlite-store.js";
const [root, manifest, validate] = process.argv.slice(2);
const store = new SqliteSessionStore(root);
const management = new LocalHarnessManagement(root, { assertOwner: () => store.assertOwner(), ownerGeneration: store.ownerGeneration });
try {
  const observed = await inventory({ ...(manifest ? { manifest } : {}), searchDirs: [], packageRoots: [], pathOnly: true, managedResolver: management });
  const control = observed.report.harnesses.find(h => h.id === "codex").controls.find(c => c.id === "codex-native");
  let defaultSelection = null, explicitSelection = null;
  if (validate) {
    const factory = new DirectorySessionBindingFactory(new SqliteWorkspaceLeaseProvider(join(root, "leases")), () => store.assertOwner(), undefined, management);
    const config = await prepareConfiguration({ workspace: dirname(root), pathOnly: true, ...(manifest ? { manifestPath: manifest } : {}) });
    try { defaultSelection = (await factory.validate({ harnessId: "codex" }, config)).controlId; }
    catch (error) { if (!String(error.message).includes("multiple available controls")) throw error; defaultSelection = "requires-explicit-control"; }
    explicitSelection = (await factory.validate({ harnessId: "codex", controlId: "codex-acp-npm" }, config)).controlId;
  }
  process.stdout.write(JSON.stringify({ defaultSelection, explicitSelection, state: control.state, source: control.installation.selected?.source ?? null, command: control.command, managedCount: observed.managedBindings.size }) + "\n");
} finally { await management.shutdown(); store.close(); }
