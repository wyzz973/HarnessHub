const args = process.argv.slice(2);
process.stdout.write(JSON.stringify({ tool: "echo", args, cwd: process.cwd() }) + "\n");
