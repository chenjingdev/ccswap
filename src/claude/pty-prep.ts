import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { platform, arch } from "node:os";

let prepared = false;

/**
 * On macOS/Linux, pnpm 10 sometimes drops the executable bit on node-pty's
 * `spawn-helper`, causing `posix_spawnp failed.` at runtime. We ensure it's
 * executable before the first PTY spawn.
 */
export function preparePty(): void {
  if (prepared) return;
  prepared = true;
  if (platform() === "win32") return;
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("node-pty/package.json");
    const prebuildDir = join(dirname(pkgPath), "prebuilds", `${platform()}-${arch()}`);
    const helper = join(prebuildDir, "spawn-helper");
    const st = statSync(helper);
    if ((st.mode & 0o111) === 0) {
      chmodSync(helper, 0o755);
    }
  } catch {
    // if not found we'll fail later with a clearer error
  }
}
