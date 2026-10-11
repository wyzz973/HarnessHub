import { execFileSync } from "node:child_process";

/** A Darwin group can return EPERM after exit because XNU skips zombies. Every listed group member must be non-running. */
export function exitedGroupSnapshotIsQuiescent(group: number, snapshot: string): boolean {
  if (!Number.isSafeInteger(group) || group<=1 || Buffer.byteLength(snapshot)>4*1024*1024) return false;
  let rows=0;
  for(const line of snapshot.split(/\r?\n/u)) {
    if(!line.trim())continue;
    const match=/^\s*([0-9]+)\s+([A-Za-z<>+N-]{1,16})\s*$/u.exec(line);
    if(!match || !Number.isSafeInteger(Number(match[1])))return false;
    rows++;
    if(Number(match[1])===group && !match[2]!.startsWith("Z"))return false;
  }
  return rows>0;
}
/** Used only after observing this owned root's exit and an EPERM signal. Inventory errors never assert cleanup success. */
export function darwinExitedGroupIsQuiescent(group: number): boolean {
  if(process.platform!=="darwin")return false;
  try { return exitedGroupSnapshotIsQuiescent(group,execFileSync("/bin/ps",["-axo","pgid=,stat="],{encoding:"utf8",timeout:1500,maxBuffer:4*1024*1024})); }
  catch { return false; }
}
