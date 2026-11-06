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
import { AuthError, InputError } from "../lib/errors.js";
import { printAuthStatusText, printWarnings } from "../lib/format.js";
import { readCookieInput } from "../lib/input.js";
import { isJsonOutput, writeJson, writeText } from "../lib/output.js";
import { runAction } from "../lib/runner.js";

interface SetCookieOptions {
  cookie?: string;
  cookieFile?: string;
  file?: string;
  session?: string;
  xsrf?: string;
  verify?: boolean;
}

export function registerAuthCommand(program: Command): void {
  const auth = program
    .command("auth")
    .description("Manage note.com credentials (Cookie header, env vars, or local file)");

  auth
    .command("set-cookie [cookie]")
    .alias("login")
    .description("Set and store note.com cookies")
    .option("--cookie <cookie>", 'raw Cookie header, or "-" to read stdin')
    .option("--file <path>", 'Cookie header/JSON/Netscape file, or "-" to read stdin')
    .option(
      "--cookie-file <path>",
      'alias of --file (kept for compatibility)'
    )
    .option("--session <value>", `value of the ${"_note_session_v5"} cookie`)
    .option("--xsrf <token>", "value of the XSRF-TOKEN cookie (with --session)")
    .option("--no-verify", "save without contacting note.com")
    .action(
      (cookie: string | undefined, options: SetCookieOptions) =>
        runAction(async () => {
          if (cookie !== undefined && options.cookie !== undefined) {
            throw new InputError("Use either the positional <cookie> or --cookie, not both.");
          }
          if (
            cookie !== undefined &&
            (options.file !== undefined || options.cookieFile !== undefined)
          ) {
            throw new InputError(
              "Use either the positional <cookie> or --file/--cookie-file, not both."
            );
          }
          if (options.file !== undefined && options.cookieFile !== undefined) {
            throw new InputError("Use either --file or --cookie-file, not both.");
          }

          const raw = await readCookieInput({
            ...(cookie !== undefined
              ? { cookie }
              : options.cookie !== undefined
                ? { cookie: options.cookie }
                : {}),
            ...(options.file !== undefined
              ? { cookieFile: options.file }
              : options.cookieFile !== undefined
                ? { cookieFile: options.cookieFile }
                : {}),
            ...(options.session !== undefined ? { session: options.session } : {}),
            ...(options.xsrf !== undefined ? { xsrf: options.xsrf } : {}),
          });
          const cookies = parseCookieInput(raw);
          assertSessionCookie(cookies);
          const jar = new CookieJar(cookies);

          let user: UserInfo | undefined;
          const verified = options.verify !== false;
          if (verified) {
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
              authenticated: verified ? true : null,
              stored: true,
              source: "file",
              credentials_path: getCredentialsPath(),
              user: user ?? null,
              cookie_names: Object.keys(jar.toJSON()).sort(),
              warnings,
              verified,
            });
          } else {
            if (verified) {
              printAuthStatusText({
                authenticated: true,
                source: "file",
                user,
                credentialsPath: getCredentialsPath(),
                warnings,
              });
              writeText(`Cookie saved to ${getCredentialsPath()}.`);
            } else {
              writeText(
                `Cookie saved to ${getCredentialsPath()} (not verified; run "notecli auth status" later).`
              );
              printWarnings(warnings);
            }
          }
        })
    );

  auth
    .command("status")
    .description("Verify the current note.com session")
    .action(
      () =>
        runAction(async () => {
          const credentialsPath = getCredentialsPath();
          let auth: Awaited<ReturnType<typeof loadAuthContext>>;

          try {
            auth = await loadAuthContext();
          } catch (error) {
            if (error instanceof AuthError || error instanceof InputError) {
              if (isJsonOutput()) {
                writeJson({
                  authenticated: false,
                  source: null,
                  credentials_path: credentialsPath,
                  error: { code: error.code, message: error.message },
                });
              } else {
                printAuthStatusText({ authenticated: false });
                process.stderr.write(`notecli: ${error.message}\n`);
              }
              process.exitCode = 3;
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
                warnings: [
                  ...auth.warnings,
                  ...(auth.jar.get(XSRF_COOKIE)
                    ? []
                    : [
                        "XSRF-TOKEN is missing. Reads work, but create/update/publish may fail.",
                      ]),
                ],
              });
            } else {
              printAuthStatusText({
                authenticated: true,
                source: auth.source,
                user,
                credentialsPath: auth.credentialsPath,
                warnings: [
                  ...auth.warnings,
                  ...(auth.jar.get(XSRF_COOKIE)
                    ? []
                    : [
                        "XSRF-TOKEN is missing. Reads work, but create/update/publish may fail.",
                      ]),
                ],
              });
            }
          } catch (error) {
            if (error instanceof AuthError || error instanceof InputError) {
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
              process.exitCode = 3;
              return;
            }
            throw error;
          }
        })
    );

  auth
    .command("logout")
    .alias("clear-cookie")
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
