#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command, CommanderError, Option } from "commander";

import { registerArticleCommands } from "./commands/articles.js";
import { registerAuthCommand } from "./commands/auth.js";
import { reportError } from "./lib/runner.js";
import { isJsonOutput, setOutputFormat, type OutputFormat } from "./lib/output.js";
import { VERSION } from "./lib/version.js";

let commanderUsageOutput = "";

export function buildProgram(): Command {
  const program = new Command();
  commanderUsageOutput = "";

  program
    .name("notecli")
    .description(
      "Manage note.com articles from the command line. Designed for both humans and AI agents."
    )
    .version(VERSION, "-v, --version", "print the version and exit")
    .addOption(
      new Option("--format <format>", "output format (default: json when stdout is not a TTY)").choices([
        "json",
        "text",
      ])
    )
    .option("--json", "shorthand for --format json")
    .option("--verbose", "include error details and stack traces")
    .showHelpAfterError("(run with --help for usage)")
    .addHelpText(
      "after",
      `
Examples:
  $ notecli auth set-cookie --file ~/.note-cookies
  $ notecli auth set-cookie '_note_session_v5=...; XSRF-TOKEN=...'
  $ notecli auth status
  $ notecli list --status draft --limit 20
  $ notecli get n1234567890ab --json
  $ printf '# Hello\\n\\nWorld' | notecli create --title "Hello" --json
  $ notecli update n1234567890ab --stdin < article.md
  $ notecli publish n1234567890ab
  $ notecli delete n1234567890ab --yes
  $ notecli preview n1234567890ab --json

Agent notes:
  - JSON is emitted automatically when stdout is not a TTY. Use --format text to override.
  - Errors are written to stderr as {"error":{"code","message",...}} in JSON mode.
  - Exit codes: 2 usage, 3 auth, 4 not found, 5 rate limited, 6 API, 7 invalid input.
  - Article bodies can be read from stdin with --stdin or --body -.
  - Deletion requires --yes unless an interactive TTY confirmation is available.
  - Cookie values are never printed.
`
    );

  program.exitOverride();
  program.configureOutput({
    writeErr: (text) => {
      if (isJsonOutput()) {
        commanderUsageOutput += text;
      } else {
        process.stderr.write(text);
      }
    },
  });

  program.hook("preAction", (_thisCommand, actionCommand) => {
    const options = actionCommand.optsWithGlobals<{
      format?: string;
      json?: boolean;
      verbose?: boolean;
    }>();

    const format: OutputFormat | undefined =
      options.json === true
        ? "json"
        : options.format === "json" || options.format === "text"
          ? options.format
          : undefined;

    setOutputFormat(format);
    process.env.NOTECLI_VERBOSE = options.verbose === true ? "1" : "0";
  });

  registerAuthCommand(program);
  registerArticleCommands(program);

  return program;
}

async function main(): Promise<void> {
  applyEarlyOutputFormat(process.argv);
  const program = buildProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version" ||
        error.exitCode === 0
      ) {
        process.exitCode = 0;
        return;
      }

      if (isJsonOutput() && commanderUsageOutput.trim()) {
        const firstLine = commanderUsageOutput.trim().split("\n")[0];
        process.stderr.write(
          `${JSON.stringify(
            { error: { code: "usage_error", message: firstLine } },
            null,
            2
          )}\n`
        );
      }
      process.exitCode = 2;
      return;
    }

    reportError(error);
  }
}

/**
 * Set the output format before Commander parses. Some usage errors occur before
 * the preAction hook runs, and agents still need a JSON error payload.
 */
function applyEarlyOutputFormat(argv: string[]): void {
  if (argv.includes("--json")) {
    setOutputFormat("json");
    return;
  }

  const formatIndex = argv.indexOf("--format");
  const inlineFormat = argv.find((arg) => arg.startsWith("--format="));
  const value =
    formatIndex >= 0
      ? argv[formatIndex + 1]
      : inlineFormat !== undefined
        ? inlineFormat.slice("--format=".length)
        : undefined;

  if (value === "json" || value === "text") {
    setOutputFormat(value);
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((error: unknown) => {
    reportError(error);
  });
}
