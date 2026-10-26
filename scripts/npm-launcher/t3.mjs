#!/usr/bin/env node
// Share the installer's runtime cache; pre-0.0.41 services re-enter here over IPC.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { version } = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"),
);

const SUPPORTED = ["darwin-arm64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];

function t3Home() {
  const raw = (process.env.T3CODE_HOME || "").trim();
  if (raw === "") return path.join(os.homedir(), ".t3");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

async function get(url) {
  const response = await fetch(url);
  if (response.status === 404) {
    throw new Error(
      `${url} does not exist yet. If ${version} was just released, try again in a few minutes.`,
    );
  }
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  return response;
}

async function download(url, file) {
  const response = await get(url);
  const total = Number(response.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const out = fs.openSync(file, "w");
  const tty = process.stderr.isTTY;
  let received = 0;
  let shown = -1;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      fs.writeSync(out, chunk);
      received += chunk.byteLength;
      // Redraw once per percent (or per MB without a length), not per chunk.
      const step = total ? Math.floor((received * 100) / total) : Math.floor(received / 1048576);
      if (tty && step !== shown) {
        shown = step;
        const percent = total ? ` ${step}%` : "";
        process.stderr.write(
          `\r\x1b[2Kt3: downloading T3 Code ${version}${percent} (${(received / 1048576).toFixed(1)} MB)`,
        );
      }
    }
  } finally {
    fs.closeSync(out);
    if (tty) process.stderr.write("\r\x1b[2K");
  }
  return hash.digest("hex");
}

async function install(dir, key) {
  const archive = `t3-${version}-${key}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
  const base = (
    process.env.T3CODE_RELEASE_BASE_URL || "https://github.com/pingdotgg/t3code/releases/download"
  ).replace(/\/+$/, "");
  const sums = await (await get(`${base}/v${version}/SHA256SUMS`)).text();
  const expected = /^([0-9a-f]{64})\s+\*?(.+)$/im;
  const line = sums
    .split(/\r?\n/)
    .map((l) => expected.exec(l.trim()))
    .find((m) => m && m[2] === archive);
  if (!line) throw new Error(`${archive} is not listed in the release's SHA256SUMS`);

  // Stage beside the destination and rename atomically to avoid half-installed versions.
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const staging = fs.mkdtempSync(`${dir}.staging-`);
  try {
    const file = path.join(staging, archive);
    if ((await download(`${base}/v${version}/${archive}`, file)) !== line[1].toLowerCase()) {
      throw new Error(`checksum mismatch for ${archive}`);
    }
    // Windows' own tar.exe reads zip; a Git-for-Windows tar on PATH cannot.
    const tar =
      process.platform === "win32" ? `${process.env.SystemRoot}\\System32\\tar.exe` : "tar";
    const extract = spawnSync(tar, ["-xf", file, "-C", staging, "--strip-components=1"], {
      stdio: "inherit",
    });
    if (extract.status !== 0) throw new Error(`could not extract ${archive}`);
    fs.rmSync(file);
    fs.writeFileSync(path.join(staging, ".install-complete"), `${version}\n`);
    publish(staging, dir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const isComplete = (dir, expected = version) => {
  try {
    return fs.readFileSync(path.join(dir, ".install-complete"), "utf8").trim() === expected;
  } catch {
    return false;
  }
};

/** Preserve concurrently published complete installs; replace only incomplete folders without the completion marker. */
function publish(staging, dir) {
  try {
    fs.renameSync(staging, dir);
  } catch (error) {
    if (isComplete(dir)) return;
    if (!fs.existsSync(dir)) throw error;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
  }
}

/** Release order: numeric base, then a release above its prereleases, then prerelease fields. */
function compareVersions(left, right) {
  const parse = (value) => {
    const [base, pre = ""] = value.split("+")[0].split(/-(.*)/s);
    return { base: base.split(".").map(Number), pre: pre === "" ? [] : pre.split(".") };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) if (a.base[i] !== b.base[i]) return a.base[i] - b.base[i];
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const [x, y] = [a.pre[i], b.pre[i]];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const [xn, yn] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (xn && yn) return Number(x) - Number(y);
    if (xn !== yn) return xn ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The newest `t3` installed in this home: launchers the install scripts and `t3 install` record,
 * plus the desktop app's launcher, which names its version in a comment.
 */
function newestInstalled(home) {
  const runtime = path.join(home, "runtime");
  const found = [];
  try {
    const versions = path.join(runtime, "versions");
    const base = process.platform === "win32" ? versions : fs.realpathSync(versions);
    for (const launcher of fs
      .readFileSync(path.join(runtime, "launchers"), "utf8")
      .split(/\r?\n/)) {
      try {
        const target =
          process.platform === "win32"
            ? /^"([^"]+)"/m.exec(fs.readFileSync(launcher, "utf8"))?.[1]
            : fs.realpathSync(launcher);
        const relative = target ? path.relative(base, target) : "..";
        const installed = relative.split(path.sep)[0];
        if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
        if (!isComplete(path.join(versions, installed), installed)) continue;
        // A Windows `t3.cmd` needs a shell; its target does not.
        found.push({
          version: installed,
          command: process.platform === "win32" ? target : launcher,
        });
      } catch {}
    }
  } catch {}
  if (process.platform !== "win32") {
    const shim = path.join(home, "bin", "t3");
    try {
      const desktop = /^# T3 Code version: (\S+)$/m.exec(fs.readFileSync(shim, "utf8"))?.[1];
      if (desktop) found.push({ version: desktop, command: shim });
    } catch {}
  }
  return found.sort((a, b) => compareVersions(b.version, a.version))[0];
}

function note(message) {
  if (process.stderr.isTTY) process.stderr.write(`t3: ${message}\n`);
}

async function main() {
  const key = `${process.platform}-${process.arch}`;
  if (!SUPPORTED.includes(key)) {
    throw new Error(
      `no T3 Code CLI build is available for ${key} (supported: ${SUPPORTED.join(", ")}).\n` +
        "The desktop app is at https://github.com/pingdotgg/t3code/releases",
    );
  }
  const home = t3Home();
  // Service IPC and signals must reach the child; terminal Ctrl-C already does, so do not forward SIGINT twice.
  const ipc = process.send !== undefined;
  const installed = ipc || process.env.T3CODE_USE_NPM === "1" ? undefined : newestInstalled(home);
  if (installed && compareVersions(installed.version, version) >= 0) {
    note(
      `using your installed t3 ${installed.version}. Run \`t3\` directly next time, or set T3CODE_USE_NPM=1 for npm's ${version}.`,
    );
    const { T3CODE_NPM_LAUNCHER_PATH: _, ...env } = process.env;
    return run(installed.command, env, ipc);
  }
  if (installed) {
    note(
      `your installed t3 ${installed.version} is older than ${version}, so npm's ${version} runs.`,
    );
  }
  const dir = path.join(home, "runtime", "versions", version);
  if (!isComplete(dir)) await install(dir, key);
  // The executable lives in the T3 home, so this is how it knows npm launched it.
  run(
    path.join(dir, process.platform === "win32" ? "t3.exe" : "t3"),
    { ...process.env, T3CODE_NPM_LAUNCHER_PATH: import.meta.filename },
    ipc,
  );
}

function run(executable, env, ipc) {
  const child = spawn(executable, process.argv.slice(2), {
    stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
    env,
  });
  if (ipc) {
    process.on("message", (message) => child.connected && child.send(message));
    child.on("message", (message) => process.connected && process.send(message));
    process.on("disconnect", () => child.connected && child.disconnect());
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => (ipc || signal !== "SIGINT") && child.kill(signal));
  }
  child.on("error", (error) => fail(error));
  child.on("exit", (code, signal) =>
    process.exit(code ?? 128 + (os.constants.signals[signal] || 1)),
  );
}

function fail(error) {
  process.stderr.write(`t3: ${error.message}\n`);
  process.exit(1);
}

await main().catch(fail);
