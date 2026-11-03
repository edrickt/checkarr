import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const commandFile = path.join(root, "Checkarr.command");

describe("Checkarr.command double-click launcher", () => {
  it("exists, is executable, and hands off to pnpm start", () => {
    expect(fs.existsSync(commandFile)).toBe(true);
    expect(fs.statSync(commandFile).mode & 0o111).not.toBe(0);

    const script = fs.readFileSync(commandFile, "utf8");
    expect(script).not.toContain("\r");
    expect(script.split("\n")[0]).toBe("#!/bin/sh");
    expect(script).toContain("pnpm install");
    expect(script).toContain("pnpm start");
    expect(script).toContain('cd "$(dirname "$0")"');
  });
});
