import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.platform === 'darwin') {
  mkdirSync('dist/native', {recursive:true});
  const result = spawnSync('/usr/bin/swiftc', ['scripts/native/keychain.swift', '-o', 'dist/native/harnesshub-keychain'], {stdio:'inherit'});
  if (result.error || result.status !== 0) process.exit(1);
} else {
  console.log('macOS Keychain backend unavailable on this platform; environment/file references remain supported.');
}
