import { mkdir, readFile, writeFile } from "node:fs/promises";

let mode = "";
for await (const chunk of process.stdin) mode += String(chunk);
if (mode === "missing") process.stdout.write("No file produced");
else {
  const input = JSON.parse(await readFile("input.json", "utf8")) as {
    values: number[];
  };
  await mkdir("results", { recursive: true });
  await writeFile(
    "results/summary.json",
    JSON.stringify({
      sum: input.values.reduce((a, b) => a + b, 0),
      count: input.values.length,
    }),
  );
  await writeFile("results/raw.bin", Buffer.from([0, 255, 128, 10]));
  process.stdout.write("Computed and wrote two outputs");
}
