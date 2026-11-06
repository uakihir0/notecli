export type OutputFormat = "json" | "text";

let forcedFormat: OutputFormat | undefined;

/**
 * Select the output format.
 *
 * Priority:
 *   1. --json / --format on the command line
 *   2. NOTE_OUTPUT=json|text
 *   3. JSON when stdout is not a TTY, text otherwise
 */
export function setOutputFormat(format: OutputFormat | undefined): void {
  forcedFormat = format;
}

export function getOutputFormat(): OutputFormat {
  if (forcedFormat !== undefined) {
    return forcedFormat;
  }

  const configured = process.env.NOTE_OUTPUT?.toLowerCase();
  if (configured === "json" || configured === "text") {
    return configured;
  }

  return process.stdout.isTTY ? "text" : "json";
}

export function isJsonOutput(): boolean {
  return getOutputFormat() === "json";
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeText(value: string): void {
  process.stdout.write(value.endsWith("\n") ? value : `${value}\n`);
}
