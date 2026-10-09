/** Map Node host labels to the upstream registry labels; no release/version matrix is implied. */
export function catalogTarget(platform: string = process.platform, architecture: string = process.arch): string {
  const os = platform === "win32" ? "windows" : platform;
  const arch = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : architecture;
  if (!["darwin", "linux", "windows"].includes(os) || !["aarch64", "x86_64"].includes(arch))
    throw new Error("unsupported catalog host: " + platform + "/" + architecture);
  return os + "-" + arch;
}

