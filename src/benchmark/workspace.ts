import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  benchmarkHash,
  type BenchmarkAttempt,
  type BenchmarkTask,
} from "../domain/benchmark.js";
import { HubError } from "../domain/errors.js";

const maximumFixtureBytes = 8 * 1024 * 1024;

/** Uses portable relative file names so the same dataset cannot alias files on macOS or Windows. */
export function validateFixtures(task: BenchmarkTask): void {
  const names: string[] = [];
  let bytes = 0;
  for (const fixture of task.fixtureFiles ?? []) {
    const components = fixture.path.split("/");
    if (
      components.some(
        (component) =>
          !component ||
          component === "." ||
          component === ".." ||
          /[\\\u0000-\u001f<>:"|?*]/u.test(component) ||
          /[. ]$/u.test(component) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(component),
      )
    )
      throw new HubError(
        "INVALID_BENCHMARK_FIXTURE",
        "Fixture paths must be safe portable relative file names",
      );
    const name = fixture.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (
      names.some(
        (other) =>
          other === name ||
          other.startsWith(`${name}/`) ||
          name.startsWith(`${other}/`),
      )
    )
      throw new HubError(
        "INVALID_BENCHMARK_FIXTURE",
        "Fixture paths must not overlap or alias",
      );
    names.push(name);
    bytes += Buffer.byteLength(fixture.text);
  }
  if (bytes > maximumFixtureBytes)
    throw new HubError(
      "INVALID_BENCHMARK_FIXTURE",
      "Fixture contents exceed 8 MiB per task",
    );
  for (const output of task.input.outputs ?? []) {
    const name = output.path.normalize("NFC").toLocaleLowerCase("en-US");
    if (
      names.some(
        (fixture) =>
          fixture === name ||
          fixture.startsWith(`${name}/`) ||
          name.startsWith(`${fixture}/`),
      )
    )
      throw new HubError(
        "INVALID_BENCHMARK_FIXTURE",
        "Outputs must not overwrite or overlap initial fixture files",
      );
  }
}

/** Materializes dataset-owned text only into a new exclusive workspace and records exact initial bytes. */
export async function initializeFixtures(
  directory: string,
  task: BenchmarkTask,
): Promise<NonNullable<BenchmarkAttempt["initialFiles"]>> {
  const files: NonNullable<BenchmarkAttempt["initialFiles"]> = [];
  for (const fixture of task.fixtureFiles ?? []) {
    const destination = path.join(directory, ...fixture.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, fixture.text, { flag: "wx", mode: 0o600 });
    files.push({
      path: fixture.path,
      size: Buffer.byteLength(fixture.text),
      sha256: benchmarkHash(fixture.text),
    });
  }
  return files;
}

/** Before submission checks the entire initial manifest, including bytes, extra files/directories and symlinks. */
export async function checkWorkspace(
  attempt: BenchmarkAttempt,
  initial: boolean,
): Promise<void> {
  const reject = () =>
    new HubError(
      "BENCHMARK_WORKSPACE_POLLUTED",
      "Attempt workspace must retain its identity and exact initial file manifest",
      409,
    );
  const location = attempt.workspace.path;
  const metadata = await lstat(location);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (await realpath(location)) !== location
  )
    throw reject();
  if (!initial) return;
  const expected = attempt.initialFiles ?? [];
  const datasetFiles = attempt.task.fixtureFiles ?? [];
  if (
    expected.length !== datasetFiles.length ||
    datasetFiles.some(
      (file) =>
        !expected.some(
          (entry) =>
            entry.path === file.path &&
            entry.size === Buffer.byteLength(file.text) &&
            entry.sha256 === benchmarkHash(file.text),
        ),
    )
  )
    throw reject();
  const directories = new Set<string>();
  for (const file of expected) {
    const parts = file.path.split("/");
    for (let count = 1; count < parts.length; count++)
      directories.add(parts.slice(0, count).join("/"));
  }
  const found = new Set<string>();
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(path.join(location, relative), {
      withFileTypes: true,
    })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw reject();
      if (entry.isDirectory()) {
        if (!directories.has(name)) throw reject();
        await walk(name);
      } else {
        const file = expected.find((candidate) => candidate.path === name);
        if (!entry.isFile() || !file) throw reject();
        const bytes = await readFile(path.join(location, name));
        if (bytes.length !== file.size || benchmarkHash(bytes) !== file.sha256)
          throw reject();
        found.add(name);
      }
    }
  }
  await walk("");
  if (found.size !== expected.length) throw reject();
}
