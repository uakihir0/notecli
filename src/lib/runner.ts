import { errorExitCode, errorPayload } from "./errors.js";
import { isJsonOutput } from "./output.js";

export async function runAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    reportError(error);
  }
}

export function reportError(error: unknown): void {
  if (isJsonOutput()) {
    process.stderr.write(`${JSON.stringify(errorPayload(error), null, 2)}\n`);
  } else {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`notecli: ${message}\n`);
  }

  if (process.env.NOTECLI_VERBOSE === "1" && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }

  process.exitCode = errorExitCode(error);
}
