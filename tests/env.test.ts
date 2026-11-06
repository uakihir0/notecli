import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadDotEnv } from "../src/lib/env.js";

const TEST_KEY = "NOTECLI_ENV_TEST_VALUE";
const originalValue = process.env[TEST_KEY];

afterEach(() => {
  if (originalValue === undefined) {
    delete process.env[TEST_KEY];
  } else {
    process.env[TEST_KEY] = originalValue;
  }
});

describe("loadDotEnv", () => {
  it("loads .env from the given directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "notecli-env-"));
    await writeFile(join(dir, ".env"), `${TEST_KEY}=from-file\n`);
    delete process.env[TEST_KEY];

    expect(loadDotEnv(dir)).toBe(join(dir, ".env"));
    expect(process.env[TEST_KEY]).toBe("from-file");
  });

  it("does not override an existing environment variable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "notecli-env-"));
    await writeFile(join(dir, ".env"), `${TEST_KEY}=from-file\n`);
    process.env[TEST_KEY] = "from-shell";

    loadDotEnv(dir);
    expect(process.env[TEST_KEY]).toBe("from-shell");
  });

  it("returns null when .env does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "notecli-env-"));
    expect(loadDotEnv(dir)).toBeNull();
  });
});
