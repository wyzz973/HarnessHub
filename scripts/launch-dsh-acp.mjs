/** Launch a fixed DSH CLI argv with a private DSH_HOME; credentials remain file references in its patch. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
if (!process.env.HOME || !process.argv[2]) {
  process.stderr.write('Usage: node launch-dsh-acp.mjs <DSH CLI> --profile acp --patch <reference patch>; HOME is required\n');
  process.exit(2);
}
const child = spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit', env: {...process.env, DSH_HOME: join(process.env.HOME, '.dsh'), DSH_TELEMETRY_DISABLED:'1'} });
for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>child.kill(signal));
child.once('error',()=>{ process.exitCode=1; });
child.once('exit',(code)=>{ process.exitCode=code??1; });
