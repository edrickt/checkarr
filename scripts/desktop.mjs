#!/usr/bin/env node
// Install or remove the app-drawer icon for this checkout:
//   pnpm app:install     -> ~/Applications/Checkarr.app (macOS), a .desktop
//                           entry (Linux), a Start-menu shortcut (Windows)
//   pnpm app:uninstall   -> remove it again
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDesktopApp, removeDesktopApp } from "./lib/desktop.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "install";
const pretty = (target) => target.replace(os.homedir(), "~");

try {
  if (command === "install") {
    const result = await ensureDesktopApp({ root });
    console.log(`${result.updated ? "installed" : "already up to date"}: ${pretty(result.target)}`);
  } else if (command === "uninstall") {
    const result = await removeDesktopApp();
    if (result.removed.length === 0) {
      console.log("no Checkarr desktop icon found");
    } else {
      for (const target of result.removed) console.log(`removed: ${pretty(target)}`);
    }
  } else {
    console.error("usage: node scripts/desktop.mjs [install|uninstall]");
    process.exit(2);
  }
} catch (err) {
  console.error(`could not ${command} the desktop icon: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
