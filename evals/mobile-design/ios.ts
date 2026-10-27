// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side simulator automation uses Node subprocess and timing APIs directly.

import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  normalizeIosSimulator,
  readPngDimensions,
  suppressIosSystemFollowUps,
  type ShowcaseEnvironment,
} from "../../scripts/mobile-showcase.ts";
import {
  SHOWCASE_ENVIRONMENTS,
  SHOWCASE_THREADS,
} from "../../scripts/mobile-showcase-environment.ts";
import { SIMULATORS, type DeviceClassId, type Pose, type StepAction } from "./cases.ts";

const BUNDLE_ID = "com.t3tools.t3code";
const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../..");
const AGENT_DEVICE = NodePath.join(
  REPO_ROOT,
  "scripts/node_modules/agent-device/bin/agent-device.mjs",
);

export const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function run(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly allowFailure?: boolean;
    readonly timeoutMs?: number;
    readonly cwd?: string;
  } = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: options.timeoutMs ?? 120_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !options.allowFailure)
        reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr || stdout}`));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

const simctl = (...args: ReadonlyArray<string>) => run("xcrun", ["simctl", ...args]);

export interface SnapshotNode {
  readonly ref?: string;
  /** agent-device's role name, such as `button`, `text`, `text-view` or `navigation-bar`. */
  readonly kind?: string;
  readonly label?: string;
  readonly rect?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly hittable?: boolean;
}
export interface Snapshot {
  readonly nodes: ReadonlyArray<SnapshotNode>;
  readonly viewport: { readonly width: number; readonly height: number };
}

/** Where each `{thread:<id>}` lives: seeded and live fixture threads, by environment. */
export type LinkTargets = ReadonlyMap<
  string,
  { readonly environmentId: string; readonly threadId: string }
>;

export function linkTargets(environments: ReadonlyArray<ShowcaseEnvironment>): LinkTargets {
  const threads = new Map<string, { environmentId: string; threadId: string }>();
  for (const [index, environment] of SHOWCASE_ENVIRONMENTS.entries()) {
    const started = environments[index];
    if (!started) throw new Error(`Environment ${environment.id} did not start.`);
    for (const thread of SHOWCASE_THREADS) {
      if ((environment.projectIds as ReadonlyArray<string>).includes(thread.projectId))
        threads.set(thread.id, { environmentId: started.environmentId, threadId: thread.id });
    }
    for (const [id, threadId] of started.liveThreadIds)
      threads.set(id, { environmentId: started.environmentId, threadId });
  }
  return threads;
}

export function expandPath(path: string, targets: LinkTargets): string {
  return path.replaceAll(/\{thread:([^}]+)\}/g, (_, id: string) => {
    const thread = targets.get(id);
    if (!thread) throw new Error(`Unknown thread '${id}'.`);
    return `${thread.environmentId}/${encodeURIComponent(thread.threadId)}`;
  });
}

/** One simulator this run created, driven with simctl for system state and agent-device for UI. */
export class Simulator {
  readonly device: DeviceClassId;
  readonly udid: string;
  private readonly session: string;

  private constructor(device: DeviceClassId, udid: string, session: string) {
    this.device = device;
    this.udid = udid;
    this.session = session;
  }

  /** Creates a dedicated simulator on the newest runtime, so runs never touch shared devices. */
  static async create(device: DeviceClassId, runId: string): Promise<Simulator> {
    const spec = SIMULATORS[device];
    const udid = (
      await simctl(
        "create",
        `${spec.name} ${runId}`,
        `com.apple.CoreSimulator.SimDeviceType.${spec.type}`,
      )
    ).stdout.trim();
    const simulator = new Simulator(device, udid, `t3-design-${device}-${runId}`);
    await suppressIosSystemFollowUps(udid);
    await simctl("boot", udid);
    await simctl("bootstatus", udid, "-b");
    return simulator;
  }

  async delete() {
    await this.agent(["close"]).catch(() => undefined);
    await simctl("shutdown", this.udid).catch(() => undefined);
    await simctl("delete", this.udid).catch(() => undefined);
  }

  async install(appPath: string) {
    await normalizeIosSimulator("dark", this.udid);
    await simctl("install", this.udid, appPath);
  }

  async dataContainer(): Promise<string> {
    return (await simctl("get_app_container", this.udid, BUNDLE_ID, "data")).stdout.trim();
  }

  /**
   * Loads the JS straight from Metro. The dev menu's preferences hide its tools button and
   * launch sheet; the same flags on --initialUrl do not reach them.
   */
  async launch(metroUrl: string) {
    for (const [key, value] of [
      ["EXDevMenuShowFloatingActionButton", "NO"],
      ["EXDevMenuShowsAtLaunch", "NO"],
      ["EXDevMenuIsOnboardingFinished", "YES"],
    ] as const) {
      await simctl("spawn", this.udid, "defaults", "write", BUNDLE_ID, key, "-bool", value);
    }
    const loaded = /^(Chats|Add environment|New chat|Search threads)$/;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Launch arguments only reach a fresh process, so start it before agent-device attaches.
      await simctl(
        "launch",
        ...(attempt > 0 ? ["--terminate-running-process"] : []),
        this.udid,
        BUNDLE_ID,
        "--initialUrl",
        metroUrl,
      );
      // The first snapshot attaches the agent-device session, which can take minutes.
      await this.agent(["open", BUNDLE_ID], 600_000);
      const snapshot = await this.waitFor(
        new RegExp(`${loaded.source}|^Reload$`),
        "the app to load",
        180_000,
      ).catch(() => null);
      if (snapshot && this.find(snapshot, loaded)) return;
      if (snapshot) await this.tap(/^Reload$/).catch(() => undefined);
    }
    throw new Error("The app did not load from Metro.");
  }

  async pair(pairingUrls: ReadonlyArray<string>, firstThreadTitle: RegExp) {
    for (const pairingUrl of pairingUrls) {
      const query = new URLSearchParams({ pairingUrl, autoConnect: "1" });
      // Pairing runs once per device, so it can wait out a slow host.
      await this.openUrl(`t3code://connections/new?${query}`, 180_000);
      await delay(4_000);
    }
    await this.waitFor(firstThreadTitle, "the paired thread list", 180_000);
  }

  /** iOS asks before a link opens the app; accept the prompt once it shows. */
  async openUrl(url: string, timeoutMs = 60_000) {
    await simctl("openurl", this.udid, url);
    // A busy host can take seconds per XCTest call, and the prompt itself can be late.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const accepted = await this.agent(["alert", "accept"]).then(
        () => true,
        () => false,
      );
      if (accepted) return;
      await delay(500);
    }
  }

  async agent(args: ReadonlyArray<string>, timeoutMs = 180_000): Promise<Record<string, unknown>> {
    const { stdout, stderr } = await run(
      process.execPath,
      [
        AGENT_DEVICE,
        ...args,
        "--platform",
        "ios",
        "--udid",
        this.udid,
        "--session",
        this.session,
        "--json",
      ],
      { allowFailure: true, timeoutMs },
    );
    let parsed: { success?: boolean; data?: Record<string, unknown>; error?: { message?: string } };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new Error(`agent-device ${args[0]}: ${(stderr || stdout).slice(-400)}`);
    }
    if (!parsed.success)
      throw new Error(`agent-device ${args.join(" ")}: ${parsed.error?.message}`);
    return parsed.data ?? {};
  }

  async snapshot(): Promise<Snapshot> {
    // The first command of a session attaches it to the app.
    const data = await this.agent(["snapshot"]).catch(async () => {
      await this.agent(["open", BUNDLE_ID]);
      return this.agent(["snapshot"]);
    });
    return data as unknown as Snapshot;
  }

  find(snapshot: Snapshot, label: RegExp): SnapshotNode | undefined {
    const onScreen = (node: SnapshotNode) =>
      node.rect !== undefined &&
      node.rect.y + node.rect.height > 0 &&
      node.rect.y < snapshot.viewport.height;
    const matches = snapshot.nodes.filter((node) => label.test(node.label ?? "") && onScreen(node));
    return matches.find((node) => node.hittable) ?? matches[0];
  }

  async waitFor(label: RegExp, what: string, timeoutMs = 20_000): Promise<Snapshot> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const snapshot = await this.snapshot().catch(() => null);
      if (snapshot && this.find(snapshot, label)) return snapshot;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (${label})`);
      await delay(750);
    }
  }

  async press(node: SnapshotNode) {
    if (!node.rect) throw new Error(`${node.label ?? "element"} has no frame`);
    const { x, y, width, height } = node.rect;
    // Refs can be refused when agent-device thinks the element is covered; the centre still takes a tap.
    await this.agent(["press", `@${node.ref}`]).catch(() =>
      this.agent(["press", String(Math.round(x + width / 2)), String(Math.round(y + height / 2))]),
    );
  }

  async tap(label: RegExp) {
    const node = this.find(await this.waitFor(label, `'${label.source}'`), label);
    if (!node) throw new Error(`nothing labelled ${label}`);
    await this.press(node);
  }

  /** The composer is a native text view with no label: the lowest editable field on screen. */
  async focusComposer() {
    const snapshot = await this.snapshot();
    const composer = snapshot.nodes
      .filter((node) => (node.kind === "text-view" || node.kind === "text-field") && node.rect)
      .toSorted((a, b) => b.rect!.y - a.rect!.y)[0];
    if (!composer) throw new Error("no composer on screen");
    await this.press(composer);
  }

  async perform(step: StepAction, targets: LinkTargets) {
    if ("link" in step) await this.openUrl(`t3code://${expandPath(step.link, targets)}`);
    else if ("tap" in step) await this.tap(new RegExp(step.tap));
    else if ("type" in step) await this.agent(["type", step.type]);
    else if ("scroll" in step) await this.agent(["scroll", step.scroll]);
    else await this.focusComposer();
    await delay(1_200);
  }

  /** Backs out of sheets, pushed screens and the keyboard until the thread list shows. */
  async home(threadListLabel: RegExp) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const snapshot = await this.snapshot();
      // A thread's back button is labelled with the tab it returns to, so only count it up top.
      const back = snapshot.nodes.find(
        (node) =>
          node.kind === "button" &&
          (/^(Back|Close|Done|Cancel)$/.test(node.label ?? "") ||
            (node.label === "Chats" && (node.rect?.y ?? Infinity) < snapshot.viewport.height / 4)),
      );
      if (!back && this.find(snapshot, threadListLabel)) {
        await this.agent(["keyboard", "dismiss"]).catch(() => undefined);
        // Start every scene from the top of the list.
        await this.agent(["scroll", "up"]).catch(() => undefined);
        await delay(600);
        return;
      }
      // Another tab, such as Settings, shows no back button; its tab bar returns to Chats.
      const chatsTab = snapshot.nodes.find(
        (node) =>
          node.kind === "button" &&
          node.label === "Chats" &&
          (node.rect?.y ?? 0) > snapshot.viewport.height * 0.75,
      );
      if (back) await this.press(back);
      else if (chatsTab) await this.press(chatsTab);
      else await this.agent(["back"]).catch(() => undefined);
      await delay(1_000);
    }
    throw new Error("could not return to the thread list");
  }

  /** Applies the pose's system settings to the running app. */
  async applyPose(pose: Pose) {
    await simctl("ui", this.udid, "appearance", pose.appearance);
    await simctl("ui", this.udid, "content_size", pose.textSize ?? "large");
    if (pose.fold) {
      await this.agent(["fold", pose.fold]);
      await delay(2_500);
    }
    // A fold sets the Duo's shape itself.
    if (!pose.fold) await this.orient(pose.orientation ?? "portrait");
  }

  /** agent-device names rotations from the natural orientation, so try each until the shape fits. */
  private async orient(shape: "portrait" | "landscape") {
    const fits = async () => {
      const { width, height } = (await this.snapshot()).viewport;
      return width > height === (shape === "landscape");
    };
    if (await fits()) return;
    for (const name of shape === "landscape"
      ? ["landscape-left", "landscape-right"]
      : ["portrait"]) {
      await this.agent(["orientation", name]);
      await delay(2_000);
      if (await fits()) return;
    }
    throw new Error(`could not rotate to ${shape}`);
  }

  async screenshot(destination: string, pose: Pose) {
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await simctl(
      "io",
      this.udid,
      "screenshot",
      ...(pose.fold ? ["--display", pose.fold === "closed" ? "1" : "3"] : []),
      destination,
    );
    // Headless displays stay portrait when the device rotates.
    const landscape = pose.orientation === "landscape" || pose.fold === "open";
    const { width, height } = readPngDimensions(await NodeFSP.readFile(destination));
    if (landscape && height > width) {
      await run("sips", ["--rotate", pose.fold ? "90" : "270", destination]);
    }
  }
}
