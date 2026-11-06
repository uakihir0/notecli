#!/usr/bin/env node
import { Command, CommanderError } from "commander";

import { VERSION } from "./lib/version.js";
import { setOutputFormat, type OutputFormat } from "./lib/output.js";

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("notecli")
    .description(
      "Manage note.com articles from the command line. Designed for both humans and AI agents."
    )
    .version(VERSION, "-v, --version", "print the version and exit")
    .option(
      "--format <format>",
      "output format: json or text (default: json when stdout is not a TTY)"
    )
    .option("--json", "shorthand for --format json")
    .option("--verbose", "include error details and stack traces")
    .showHelpAfterError("(run with --help for usage)")
    .addHelpText(
      "after",
      `
Examples:
  $ notecli auth login --cookie-file ~/.note-cookies
  $ notecli list --status draft --json
  $ notecli get n1234567890ab
  $ printf '# Hello\\n\\nWorld' | notecli create --title "Hello" --json
  $ notecli publish n1234567890ab --yes

Agent notes:
  - JSON is emitted automatically when stdout is not a TTY. Use --format text to override.
  - Article bodies can be read from stdin by omitting --body/--file, or by passing "-".
  - Errors are written to stderr as {"error":{"code","message",...}} in JSON mode.
  - Cookie values are never printed.
`
    );

  program.exitOverride();

  program.hook("preAction", (thisCommand) => {
    const options = thisCommand.opts<{
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

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      // Help and version are not failures.
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`notecli: ${message}\n`);
  process.exitCode = 1;
});
