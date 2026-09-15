import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureTray,
  linuxTrayInvocation,
  macTrayScript,
  readTrayPid,
  stopTray,
  TRAY_MARKER,
  trayPaths,
  windowsTrayLauncher,
  windowsTrayScript
} from "../lib/tray.mjs";

const tempDirs = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "checkarr-tray-"));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const base = {
  root: "/repo/checkarr",
  node: "/opt/node/bin/node",
  home: "/home/oslo",
  env: {}
};

/** Pull the inlined configuration back out of a generated script. */
function configOf(script) {
  const match = script.match(/^const CFG = (\{[\s\S]*?\n\});$/m);
  expect(match, "generated script must inline CFG as JSON").not.toBeNull();
  return JSON.parse(match[1]);
}

describe("trayPaths", () => {
  it("keeps macOS state in the checkout's data directory", () => {
    const paths = trayPaths({ ...base, platform: "darwin" });
    expect(paths.pidFile).toBe("/repo/checkarr/data/checkarr-tray.pid");
    expect(paths.scriptFile).toContain("checkarr-tray.jxa.js");
    expect(paths.logFile).toContain("tray.log");
  });

  it("uses LOCALAPPDATA for the Windows host and its icon", () => {
    const paths = trayPaths({
      ...base,
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\oslo\\AppData\\Local" }
    });
    expect(paths.scriptFile).toBe("C:\\Users\\oslo\\AppData\\Local\\checkarr-tray\\CheckarrTray.ps1");
    expect(paths.launcherFile).toBe("C:\\Users\\oslo\\AppData\\Local\\checkarr-tray\\CheckarrTray.vbs");
    // The marker is what makes a recycled pid identifiable later.
    expect(paths.scriptFile).toContain(TRAY_MARKER);
  });

  it("rejects platforms without a tray host", () => {
    expect(() => trayPaths({ ...base, platform: "aix" })).toThrow(/unsupported platform/i);
  });
});

describe("macTrayScript", () => {
  const config = {
    label: "Checkarr",
    url: "http://127.0.0.1:5656",
    node: "/opt/node/bin/node",
    root: "/repo/checkarr",
    launch: "/repo/checkarr/scripts/launch.mjs",
    stop: "/repo/checkarr/scripts/stop.mjs",
    pidFile: "/repo/checkarr/data/checkarr.pid",
    trayPidFile: "/repo/checkarr/data/checkarr-tray.pid",
    logFile: "/repo/checkarr/data/tray.log",
    serverLog: "/repo/checkarr/data/server.log",
    iconFile: "/repo/checkarr/data/checkarr-tray.png",
    quote: 'weird "path" with $dollars'
  };

  it("carries the configuration verbatim into the JXA program", () => {
    expect(configOf(macTrayScript(config))).toEqual(config);
  });

  it("builds a template status item with open/log/stop menu items", () => {
    const script = macTrayScript(config);
    expect(script).toContain("$.NSStatusBar.systemStatusBar.statusItemWithLength");
    expect(script).toContain("image.setTemplate(true)");
    expect(script).toContain("image.setSize($.NSMakeSize(18, 18))");
    expect(script).toContain("addItem('Open ' + CFG.label, 'openDashboard:')");
    expect(script).toContain("addItem('Open log', 'openLog:')");
    expect(script).toContain("addItem('Stop ' + CFG.label, 'stopEverything:')");
    expect(script).toContain("menu.addItem($.NSMenuItem.separatorItem)");
    // Actions are AppKit target/action, dispatched by the menu.
    expect(script).toContain("'openDashboard:': { types: ['void', ['id']], implementation: openDashboard }");
    expect(script).toContain(
      "'stopEverything:': { types: ['void', ['id']], implementation: stopEverything }"
    );
  });

  it("starts the dashboard when the server is down and exits when stopped", () => {
    const script = macTrayScript(config);
    expect(script).toContain("run(shq(CFG.node) + ' ' + shq(CFG.launch))");
    expect(script).toContain("'/usr/bin/open ' + shq(CFG.url)");
    expect(script).toContain("shSync('/bin/kill -TERM ' + pid");
    expect(script).toContain("$.exit(0)");
    // Paths go through a single-quote helper, never raw interpolation.
    expect(script).toContain("const shq = (value)");
  });
});

describe("windowsTrayScript", () => {
  const config = {
    label: "Checkarr",
    url: "http://127.0.0.1:5656",
    node: "C:\\Program Files\\nodejs\\node.exe",
    launch: "C:\\repo\\checkarr\\scripts\\launch.mjs",
    stop: "C:\\repo\\checkarr\\scripts\\stop.mjs",
    pidFile: "C:\\repo\\checkarr\\data\\checkarr.pid",
    trayPidFile: "C:\\repo\\checkarr\\data\\checkarr-tray.pid",
    logFile: "C:\\repo\\checkarr\\data\\tray.log",
    serverLog: "C:\\repo\\checkarr\\data\\server.log",
    iconFile: "C:\\Users\\o'slo\\AppData\\Local\\checkarr-tray\\tray.png"
  };

  it("quotes paths into single-quoted PowerShell strings", () => {
    const script = windowsTrayScript(config);
    expect(script).toContain(`$IconPng = 'C:\\Users\\o''slo\\AppData\\Local\\checkarr-tray\\tray.png'`);
    expect(script).toContain("$Label = 'Checkarr'");
  });

  it("runs a NotifyIcon with the same menu and a hidden server launch", () => {
    const script = windowsTrayScript(config);
    expect(script).toContain("New-Object System.Windows.Forms.NotifyIcon");
    expect(script).toContain("[System.Drawing.Icon]::FromHandle($image.GetHicon())");
    expect(script).toContain('$itemOpen = $menu.Items.Add("Open $Label")');
    expect(script).toContain('$itemStop = $menu.Items.Add("Stop $Label")');
    expect(script).toContain(
      "Start-Process -FilePath $Node -ArgumentList ('\"' + $Launch + '\"') -WindowStyle Hidden"
    );
    expect(script).toContain("Stop-Process -Id $serverPid -Force");
    expect(script).toContain("[System.Windows.Forms.Application]::Run()");
    // One icon per checkout: the host records and checks its own pid.
    expect(script).toContain("Set-Content -Path $TrayPidFile -Value $PID");
  });
});

describe("windowsTrayLauncher", () => {
  it("starts PowerShell hidden and doubles embedded quotes", () => {
    const vbs = windowsTrayLauncher('C:\\Users\\o"slo\\checkarr-tray\\CheckarrTray.ps1');
    expect(vbs).toContain('CreateObject("WScript.Shell").Run "');
    expect(vbs).toContain("-WindowStyle Hidden -File ");
    expect(vbs).toContain('o""slo');
    expect(vbs).toMatch(/, 0, False\r\n/);
  });
});

describe("linuxTrayInvocation", () => {
  it("points yad at the icon, the dashboard, the log, and the stop script", () => {
    const { cmd, args } = linuxTrayInvocation({
      label: "Checkarr",
      node: "/usr/bin/node",
      launch: "/repo/checkarr/scripts/launch.mjs",
      stop: "/repo/checkarr/scripts/stop.mjs",
      opener: "xdg-open",
      serverLog: "/repo/checkarr/data/server.log",
      iconFile: "/repo/checkarr/data/checkarr-tray.png"
    });
    expect(cmd).toBe("yad");
    expect(args).toContain("--notification");
    expect(args).toContain("--image=/repo/checkarr/data/checkarr-tray.png");
    expect(args).toContain('--command="/usr/bin/node" "/repo/checkarr/scripts/launch.mjs"');
    const menu = args.find((a) => a.startsWith("--menu="));
    expect(menu).toContain('Open Checkarr!"/usr/bin/node" "/repo/checkarr/scripts/launch.mjs"');
    expect(menu).toContain('Open log!"xdg-open" "/repo/checkarr/data/server.log"');
    expect(menu).toContain('Stop Checkarr!"/usr/bin/node" "/repo/checkarr/scripts/stop.mjs"');
  });
});

describe("ensureTray", () => {
  it("reuses a live tray instead of stacking a second icon", async () => {
    const root = makeRoot();
    const paths = trayPaths({ platform: "darwin", root, home: base.home, env: {} });
    fs.mkdirSync(path.dirname(paths.pidFile), { recursive: true });
    fs.writeFileSync(paths.pidFile, String(process.pid));
    let spawned = 0;
    const result = await ensureTray({
      platform: "darwin",
      root,
      node: base.node,
      spawnImpl: () => {
        spawned += 1;
        return { pid: 1, unref() {} };
      },
      commandOf: () => "osascript -l JavaScript /repo/checkarr/data/checkarr-tray.jxa.js"
    });
    expect(result.started).toBe(false);
    expect(result.reason).toBe("already running");
    expect(spawned).toBe(0);
  });

  it("writes the host, icon, and pid file on macOS", async () => {
    const root = makeRoot();
    const calls = [];
    const result = await ensureTray({
      platform: "darwin",
      root,
      node: base.node,
      spawnImpl: (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return { pid: 4242, unref() {} };
      },
      commandOf: () => ""
    });

    const paths = trayPaths({ platform: "darwin", root, home: base.home, env: {} });
    expect(result.started).toBe(true);
    expect(result.pid).toBe(4242);
    expect(calls[0].cmd).toBe("osascript");
    expect(calls[0].args).toEqual(["-l", "JavaScript", paths.scriptFile]);
    expect(calls[0].options.detached).toBe(true);
    expect(fs.readFileSync(paths.pidFile, "utf8")).toBe("4242");
    expect(readTrayPid(paths)).toBe(4242);
    expect(fs.readFileSync(paths.scriptFile, "utf8")).toContain("NSStatusBar");
    expect(fs.readFileSync(paths.iconFile).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
    expect(fs.existsSync(paths.logFile)).toBe(true);
  });

  it("waits for the Windows host to record its pid, and reports when it never does", async () => {
    const root = makeRoot();
    // The real trayPaths() builds Windows separators; the host running this
    // test is POSIX, so point the writer at plain temp paths instead.
    const actual = trayPaths({ platform: "win32", root, home: "C:\\Users\\oslo", env: {} });
    const data = path.join(root, "data");
    const store = path.join(root, "store");
    const paths = {
      ...actual,
      // Override everything the host writes to: the inherited paths carry
      // win32 separators and would land outside the temp root on a POSIX test
      // host (on a real Windows host trayPaths() is already correct).
      data,
      store,
      pidFile: path.join(data, "checkarr-tray.pid"),
      logFile: path.join(data, "tray.log"),
      iconFile: path.join(store, "tray.png"),
      scriptFile: path.join(store, "CheckarrTray.ps1"),
      launcherFile: path.join(store, "CheckarrTray.vbs")
    };
    const calls = [];
    const options = {
      platform: "win32",
      root,
      node: base.node,
      paths,
      spawnImpl: (cmd, args) => {
        calls.push({ cmd, args });
        return { pid: 99, unref() {} };
      },
      commandOf: () => "",
      sleep: async () => {}
    };

    // A blocked or crashed PowerShell host never writes the pid file.
    const blocked = await ensureTray(options);
    expect(blocked.started).toBe(false);
    expect(blocked.reason).toMatch(/notification-area host did not start/);
    expect(calls[0].cmd).toBe("wscript.exe");
    expect(calls[0].args).toEqual([paths.launcherFile]);
    expect(fs.readFileSync(paths.scriptFile, "utf8")).toContain("NotifyIcon");
    expect(fs.readFileSync(paths.launcherFile, "utf8")).toContain("WScript.Shell");

    // A healthy host records its own pid just after it starts.
    const healthy = await ensureTray({
      ...options,
      spawnImpl: (cmd, args) => {
        calls.push({ cmd, args });
        fs.writeFileSync(paths.pidFile, "4242");
        return { pid: 99, unref() {} };
      }
    });
    expect(healthy.started).toBe(true);
    expect(healthy.pid).toBe(4242);
  });

  it("degrades quietly on Linux without yad", async () => {
    const root = makeRoot();
    const result = await ensureTray({
      platform: "linux",
      root,
      node: base.node,
      hasCommand: () => false,
      spawnImpl: () => {
        throw new Error("must not spawn");
      }
    });
    expect(result.started).toBe(false);
    expect(result.reason).toMatch(/yad/i);
  });
});

describe("stopTray", () => {
  const writePid = (root, pid) => {
    const paths = trayPaths({ platform: "darwin", root, home: base.home, env: {} });
    fs.mkdirSync(path.dirname(paths.pidFile), { recursive: true });
    fs.writeFileSync(paths.pidFile, String(pid));
    return paths;
  };

  it("stops a live tray and clears its pid file", async () => {
    const root = makeRoot();
    const paths = writePid(root, 4242);
    const calls = [];
    const kill = (pid, signal) => {
      calls.push([pid, signal]);
      // the process dies on SIGTERM, so the follow-up check throws
      if (signal === 0 && calls.some(([, s]) => s === "SIGTERM")) throw new Error("ESRCH");
    };
    const result = await stopTray({
      platform: "darwin",
      root,
      kill,
      commandOf: () => "osascript -l JavaScript /repo/checkarr/data/checkarr-tray.jxa.js",
      sleep: async () => {}
    });
    expect(result).toEqual({ platform: "darwin", stopped: true, pid: 4242 });
    expect(calls).toContainEqual([4242, "SIGTERM"]);
    expect(calls.some(([, s]) => s === "SIGKILL")).toBe(false);
    expect(fs.existsSync(paths.pidFile)).toBe(false);
  });

  it("leaves a pid that is not the tray alone", async () => {
    const root = makeRoot();
    const paths = writePid(root, process.pid);
    const calls = [];
    const result = await stopTray({
      platform: "darwin",
      root,
      kill: (pid, signal) => calls.push([pid, signal]),
      commandOf: () => "/usr/bin/something-else --flag",
      sleep: async () => {}
    });
    expect(result.stopped).toBe(false);
    expect(calls.some(([, s]) => s === "SIGTERM")).toBe(false);
    expect(fs.existsSync(paths.pidFile)).toBe(false);
  });
});
