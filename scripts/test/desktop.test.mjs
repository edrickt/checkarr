import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureDesktopApp, removeDesktopApp, windowsShortcutScript } from "../lib/desktop.mjs";

const tempHomes = [];

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "checkarr-home-"));
  tempHomes.push(home);
  return home;
}

afterEach(() => {
  for (const home of tempHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const base = {
  root: "/repo/checkarr",
  node: "/opt/node/bin/node",
  version: "1.2.3"
};

/** Stand-in for child_process: records commands and fakes iconutil's output. */
function fakeRun(calls) {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "iconutil") fs.writeFileSync(args[args.indexOf("-o") + 1], "icns-bytes");
  };
}

describe("ensureDesktopApp on macOS", () => {
  it("installs a Launchpad app bundle whose icon runs the launcher", async () => {
    const home = makeHome();
    const calls = [];
    const result = await ensureDesktopApp({
      ...base,
      platform: "darwin",
      home,
      env: {},
      run: fakeRun(calls)
    });

    const app = path.join(home, "Applications", "Checkarr.app");
    expect(result.target).toBe(app);
    expect(result.updated).toBe(true);

    const plist = fs.readFileSync(path.join(app, "Contents", "Info.plist"), "utf8");
    expect(plist).toContain("<key>CFBundleExecutable</key>");
    expect(plist).toContain("<string>Checkarr</string>");
    expect(plist).toContain("<key>CFBundleIconFile</key>");
    expect(plist).toContain("<key>LSUIElement</key>");
    expect(plist).toContain("<string>1.2.3</string>");

    const executable = path.join(app, "Contents", "MacOS", "Checkarr");
    const script = fs.readFileSync(executable, "utf8");
    expect(script).toContain('"/opt/node/bin/node"');
    expect(script).toContain('"/repo/checkarr/scripts/launch.mjs"');
    expect(script).toContain("/opt/node/bin");
    expect(fs.statSync(executable).mode & 0o111).not.toBe(0);

    const iconCall = calls.find((c) => c[0] === "iconutil");
    expect(iconCall[3]).toMatch(/\.iconset$/);
    expect(fs.existsSync(path.join(app, "Contents", "Resources", "Checkarr.icns"))).toBe(true);
    expect(calls.some((c) => c[0] === "iconutil" && c[1] === "-c" && c[2] === "icns")).toBe(true);
  });

  it("puts pnpm's well-known locations on the app's PATH so a first launch can build", async () => {
    const home = makeHome();
    await ensureDesktopApp({ ...base, platform: "darwin", home, env: {}, run: fakeRun([]) });
    const executable = path.join(home, "Applications", "Checkarr.app", "Contents", "MacOS", "Checkarr");
    const script = fs.readFileSync(executable, "utf8");
    expect(script).toContain(path.join(home, ".local", "share", "pnpm"));
    expect(script).toContain("/opt/homebrew/bin");
    expect(script).toContain(path.dirname(base.node));
  });

  it("refreshes nothing when the bundle is already current", async () => {
    const home = makeHome();
    const options = { ...base, platform: "darwin", home, env: {} };
    await ensureDesktopApp({ ...options, run: fakeRun([]) });

    const calls = [];
    const second = await ensureDesktopApp({ ...options, run: fakeRun(calls) });
    expect(second.updated).toBe(false);
    expect(calls).toEqual([]);
  });

  it("removes the bundle and everything in it", async () => {
    const home = makeHome();
    const app = path.join(home, "Applications", "Checkarr.app");
    await ensureDesktopApp({ ...base, platform: "darwin", home, env: {}, run: fakeRun([]) });
    expect(fs.existsSync(app)).toBe(true);

    const result = await removeDesktopApp({ platform: "darwin", home, env: {} });
    expect(result.removed).toContain(app);
    expect(fs.existsSync(app)).toBe(false);
  });
});

describe("ensureDesktopApp on Linux", () => {
  it("installs a desktop entry plus its hicolor icon", async () => {
    const home = makeHome();
    const result = await ensureDesktopApp({
      ...base,
      platform: "linux",
      home,
      env: {},
      run: fakeRun([])
    });

    const share = path.join(home, ".local", "share");
    const desktopFile = path.join(share, "applications", "checkarr.desktop");
    const icon = path.join(share, "icons", "hicolor", "256x256", "apps", "checkarr.png");
    expect(result.target).toBe(desktopFile);
    expect(result.updated).toBe(true);

    const entry = fs.readFileSync(desktopFile, "utf8");
    expect(entry).toMatch(/^\[Desktop Entry\]$/m);
    expect(entry).toMatch(/^Type=Application$/m);
    expect(entry).toMatch(/^Name=Checkarr$/m);
    expect(entry).toMatch(
      /^Exec=\/usr\/bin\/env PATH="[^"]*\/opt\/node\/bin[^"]*" "\/opt\/node\/bin\/node" "\/repo\/checkarr\/scripts\/launch\.mjs"$/m
    );
    expect(entry).toContain(`Icon=${icon}`);
    expect(entry).toMatch(/^Terminal=false$/m);
    expect(fs.statSync(desktopFile).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(icon)).toBe(true);
  });

  it("honors XDG_DATA_HOME and stops writing once installed", async () => {
    const home = makeHome();
    const data = path.join(home, "xdg");
    const options = { ...base, platform: "linux", home, env: { XDG_DATA_HOME: data } };
    const first = await ensureDesktopApp({ ...options, run: fakeRun([]) });
    expect(first.target).toBe(path.join(data, "applications", "checkarr.desktop"));

    const second = await ensureDesktopApp({ ...options, run: fakeRun([]) });
    expect(second.updated).toBe(false);
  });

  it("removes the desktop entry and its icon", async () => {
    const home = makeHome();
    const share = path.join(home, ".local", "share");
    const desktopFile = path.join(share, "applications", "checkarr.desktop");
    const icon = path.join(share, "icons", "hicolor", "256x256", "apps", "checkarr.png");
    await ensureDesktopApp({ ...base, platform: "linux", home, env: {}, run: fakeRun([]) });

    const result = await removeDesktopApp({ platform: "linux", home, env: {} });
    expect(result.removed).toContain(desktopFile);
    expect(result.removed).toContain(icon);
    expect(fs.existsSync(desktopFile)).toBe(false);
    expect(fs.existsSync(icon)).toBe(false);
  });
});

describe("ensureDesktopApp on Windows", () => {
  it("writes an .ico and creates a Start-menu shortcut", async () => {
    const home = makeHome();
    const env = {
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local")
    };
    const calls = [];
    const result = await ensureDesktopApp({ ...base, platform: "win32", home, env, run: fakeRun(calls) });

    const ico = path.join(env.LOCALAPPDATA, "Checkarr", "checkarr.ico");
    const lnk = path.join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Checkarr.lnk");
    expect(result.target).toBe(lnk);
    expect(fs.existsSync(ico)).toBe(true);

    const powershell = calls.find((c) => c[0] === "powershell");
    expect(powershell).toBeDefined();
    const script = powershell[powershell.length - 1];
    expect(script).toContain(lnk);
    expect(script).toContain("/opt/node/bin/node");
    expect(script).toContain("launch.mjs");
  });

  it("rejects platforms it cannot draw an app icon for", async () => {
    const home = makeHome();
    await expect(
      ensureDesktopApp({ ...base, platform: "sunos", home, env: {}, run: fakeRun([]) })
    ).rejects.toThrow(/unsupported/i);
  });
});

describe("windowsShortcutScript", () => {
  it("escapes single quotes so paths with apostrophes survive PowerShell", () => {
    const script = windowsShortcutScript({
      lnkPath: "C:\\Users\\O'Brien\\Checkarr.lnk",
      target: "C:\\node\\node.exe",
      args: '"C:\\checkarr\\scripts\\launch.mjs"',
      workdir: "C:\\checkarr",
      iconPath: "C:\\icon.ico"
    });
    expect(script).toContain("O''Brien");
    expect(script).toContain("TargetPath");
    expect(script).toContain("IconLocation");
    expect(script).toContain("Save()");
  });
});
