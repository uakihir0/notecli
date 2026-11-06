import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { InputError } from "./errors.js";

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readFileOrStdin(path: string): Promise<string> {
  if (path === "-") {
    return readStdin();
  }
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new InputError(
      `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export interface BodyOptions {
  body?: string;
  file?: string;
  stdin?: boolean;
}

/**
 * Resolve an article body from --body, --file, or stdin.
 *
 * For updates, callers should only call this when the user explicitly supplied
 * one of those options. Otherwise omitting the body would unexpectedly erase it.
 */
export async function resolveBody(
  options: BodyOptions,
  behavior: { autoStdin: boolean }
): Promise<string | undefined> {
  const sources = [
    options.body !== undefined,
    options.file !== undefined,
    options.stdin === true,
  ].filter(Boolean).length;

  if (sources > 1) {
    throw new InputError("Use only one of --body, --file, or --stdin.");
  }

  if (options.file !== undefined) {
    return readFileOrStdin(options.file);
  }
  if (options.body !== undefined) {
    return options.body === "-" ? readStdin() : options.body;
  }
  if (options.stdin === true) {
    return readStdin();
  }
  if (behavior.autoStdin && !process.stdin.isTTY) {
    return readStdin();
  }
  return undefined;
}

export async function readCookieInput(options: {
  cookie?: string;
  cookieFile?: string;
  session?: string;
  xsrf?: string;
}): Promise<string> {
  if (options.session !== undefined) {
    if (options.cookie !== undefined || options.cookieFile !== undefined) {
      throw new InputError("Use either --session/--xsrf or --cookie/--cookie-file, not both.");
    }
    const parts = [`_note_session_v5=${options.session.trim()}`];
    if (options.xsrf !== undefined && options.xsrf.trim() !== "") {
      parts.push(`XSRF-TOKEN=${options.xsrf.trim()}`);
    }
    return parts.join("; ");
  }

  if (options.xsrf !== undefined) {
    throw new InputError("--xsrf requires --session.");
  }

  if (options.cookie !== undefined && options.cookieFile !== undefined) {
    throw new InputError("Use only one of --cookie and --cookie-file.");
  }

  if (options.cookie !== undefined) {
    return options.cookie === "-" ? readStdin() : options.cookie;
  }

  if (options.cookieFile !== undefined) {
    return readFileOrStdin(options.cookieFile);
  }

  const envCookie = process.env.NOTE_COOKIE;
  if (envCookie !== undefined && envCookie.trim() !== "") {
    return envCookie;
  }

  const envCookieFile = process.env.NOTE_COOKIE_FILE;
  if (envCookieFile !== undefined && envCookieFile.trim() !== "") {
    return readFileOrStdin(envCookieFile);
  }

  if (!process.stdin.isTTY) {
    return readStdin();
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  try {
    process.stderr.write(
      "Paste the note.com Cookie header (input is visible; prefer --cookie-file or NOTE_COOKIE).\n"
    );
    const answer = await readline.question("Cookie: ");
    return answer;
  } finally {
    readline.close();
  }
}

export async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new InputError(
      `Refusing to continue without confirmation. Pass --yes to ${message}.`
    );
  }

  const readline = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await readline.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
