// Whether this module was run directly, rather than imported.
//
// The obvious check -- comparing `import.meta.url` to `file://${process.argv[1]}` -- is
// wrong whenever the path reaches the file through a symlink: Node resolves the real path
// for `import.meta`, while `process.argv[1]` keeps whatever the caller typed. On macOS
// `/tmp` is a symlink to `/private/tmp`, so a script run from there compares
// `file:///private/tmp/…` against `file:///tmp/…`, the check silently fails, and the program
// exits 0 having done nothing at all. A plugin cache directory can sit behind a symlink on
// any platform, so both paths are resolved before comparing.

import { realpathSync } from "node:fs";

export function isMainModule(moduleFilename) {
  const entry = process.argv[1];
  if (!entry || !moduleFilename) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(moduleFilename) === real(entry);
}
