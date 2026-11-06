import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load `.env` from the current working directory, without overriding variables
 * that were already set in the shell. Returns the loaded path, or null.
 *
 * Node 20.12+ provides process.loadEnvFile(); older Node versions simply skip
 * automatic loading and can still use NOTE_COOKIE / NOTE_COOKIE_FILE.
 */
export function loadDotEnv(cwd = process.cwd()): string | null {
  const path = resolve(cwd, ".env");
  if (!existsSync(path)) {
    return null;
  }

  const loader = (
    process as NodeJS.Process & {
      loadEnvFile?: (path?: string) => void;
    }
  ).loadEnvFile;

  if (typeof loader !== "function") {
    return null;
  }

  try {
    loader.call(process, path);
    return path;
  } catch {
    return null;
  }
}
