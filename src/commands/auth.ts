import { Command } from "commander";

import { NoteApiClient } from "../lib/api.js";
import {
  clearCredentials,
  getCredentialsPath,
  loadAuthContext,
  saveCredentials,
  type UserInfo,
} from "../lib/config.js";
import {
  assertSessionCookie,
  CookieJar,
  parseCookieInput,
  XSRF_COOKIE,
} from "../lib/cookies.js";
import { AuthError, NotecliError } from "../lib/errors.js";
import { printAuthStatusText } from "../lib/format.js";
import { readCookieInput } from "../lib/input.js";
import { isJsonOutput, writeJson, writeText } from "../lib/output.js";
import { runAction } from "../lib/runner.js";

interface LoginOptions {
  cookie?: string;
  cookieFile?: string;
  session?: string;
  xsrf?: string;
  verify?: boolean;
}

interface StatusOptions {
  json?: boolean;
}

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage note.com credentials (Cookie header, env vars, or local file)");

  auth
    .command("login")
    .description("Validate and store note.com cookies")
    .option("--cookie <cookie>", 'raw Cookie header, or "-" to read stdin')
    .option("--cookie-file <path>", 'Cookie header/JSON/Netscape file, or "-" to read stdin')
    .option("--session <value>", `value of the ${"_note_session_v5"} cookie`)
    .option("--xsrf <token>", "value of the XSRF-TOKEN cookie (with --session)")
    .option("--no-verify", "save without contacting note.com")
    .action(
      (options: LoginOptions) =>
        runAction(async () => {
          const raw = await readCookieInput(options);
          const cookies = parseCookieInput(raw);
          assertSessionCookie(cookies);
          const jar = new CookieJar(cookies);

          let user: UserInfo | undefined;
          if (options.verify !== false) {
            const client = new NoteApiClient(jar);
            user = await client.getCurrentUser();
          }

          await saveCredentials(jar.toJSON(), user);
          const warnings: string[] = [];
          if (!jar.get(XSRF_COOKIE)) {
            warnings.push(
              "XSRF-TOKEN is missing. Read operations may work, but create/update/publish may fail. " +
                "Copy the full Cookie header from your browser."
            );
          }

          if (isJsonOutput()) {
            writeJson({
              authenticated: true,
              source: "file",
              credentials_path: getCredentialsPath(),
              user: user ?? null,
              cookie_names: Object.keys(jar.toJSON()).sort(),
              warnings,
            });
          } else {
            printAuthStatusText({
              authenticated: true,
              source: "file",
              user,
              credentialsPath: getCredentialsPath(),
              warnings,
            });
            writeText(`Credentials saved to ${getCredentialsPath()}.`);
          }
        })
    );

  auth
    .command("status")
    .description("Verify the current note.com session")
    .action(
      (_options: StatusOptions) =>
        runAction(async () => {
          const credentialsPath = getCredentialsPath();
          let auth: Awaited<ReturnType<typeof loadAuthContext>>;

          try {
            auth = await loadAuthContext();
          } catch (error) {
            if (error instanceof AuthError) {
              if (isJsonOutput()) {
                writeJson({
                  authenticated: false,
                  source: null,
                  credentials_path: credentialsPath,
                  error: { code: error.code, message: error.message },
                });
              } else {
                printAuthStatusText({ authenticated: false });
                writeText("Set NOTE_COOKIE/NOTE_COOKIE_FILE or run \"notecli auth login\".");
              }
              process.exitCode = error.exitCode;
              return;
            }
            throw error;
          }

          try {
            const client = new NoteApiClient(auth.jar);
            const user = await client.getCurrentUser();

            if (auth.source === "file") {
              await saveCredentials(auth.jar.toJSON(), user, auth.credentialsPath);
            }

            if (isJsonOutput()) {
              writeJson({
                authenticated: true,
                source: auth.source,
                credentials_path: auth.credentialsPath,
                user,
                cookie_names: Object.keys(auth.jar.toJSON()).sort(),
                warnings: auth.warnings,
              });
            } else {
              printAuthStatusText({
                authenticated: true,
                source: auth.source,
                user,
                credentialsPath: auth.credentialsPath,
                warnings: auth.warnings,
              });
            }
          } catch (error) {
            if (error instanceof AuthError) {
              if (isJsonOutput()) {
                writeJson({
                  authenticated: false,
                  source: auth.source,
                  credentials_path: auth.credentialsPath,
                  error: { code: error.code, message: error.message },
                  warnings: auth.warnings,
                });
              } else {
                printAuthStatusText({ authenticated: false });
                process.stderr.write(`notecli: ${error.message}\n`);
              }
              process.exitCode = error.exitCode;
              return;
            }
            if (error instanceof NotecliError) {
              throw error;
            }
            throw error;
          }
        })
    );

  auth
    .command("logout")
    .description("Remove the locally stored credentials file")
    .action(
      () =>
        runAction(async () => {
          const removed = await clearCredentials();
          const envPresent = Boolean(
            process.env.NOTE_COOKIE?.trim() || process.env.NOTE_COOKIE_FILE?.trim()
          );

          if (isJsonOutput()) {
            writeJson({
              authenticated: false,
              credentials_removed: removed,
              credentials_path: getCredentialsPath(),
              env_credentials_present: envPresent,
            });
          } else {
            writeText(
              removed
                ? `Removed ${getCredentialsPath()}.`
                : `No credentials file found at ${getCredentialsPath()}.`
            );
            if (envPresent) {
              writeText(
                "NOTE_COOKIE or NOTE_COOKIE_FILE is still set; commands will continue to use it."
              );
            }
          }
        })
    );
}
