import * as HostProcess from "@t3tools/shared/HostProcess";
import { pathSetupCommand } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Prompt } from "effect/cli";

import packageJson from "../../package.json" with { type: "json" };
import { launcherOwnsVersionsDir, windowsShimTarget } from "../cloud/pinnedRuntime.ts";
import { detectCliRunner, resolveEntryPath } from "./invocation.ts";

export class CliInstallError extends Schema.TaggedError<CliInstallError>()("CliInstallError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

/** `<T3 home>/runtime/versions/<version>/t3`: the layout the install scripts and npm launcher share. */
const standaloneRuntime = Effect.gen(function* () {
  const path = yield* Path.Path;
  if (!(yield* HostProcess.IsExecutable)) return Option.none();
  const executable = yield* HostProcess.ExecutablePath;
  const versionsDir = path.dirname(path.dirname(executable));
  const runtimeDir = path.dirname(versionsDir);
  if (path.basename(versionsDir) !== "versions" || path.basename(runtimeDir) !== "runtime") {
    return Option.none();
  }
  return Option.some({ executable, versionsDir, runtimeDir });
});

/** Links this runtime as the `t3` command the way the install scripts do, replacing only our own link. */
export const installCli = Effect.fn("cli.install.install")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const runtime = yield* standaloneRuntime;
  if (Option.isNone(runtime)) {
    return yield* new CliInstallError({
      reason:
        "Only the standalone t3 can install itself. Use `curl -fsSL https://t3.codes/install.sh | sh`, or Settings in the desktop app.",
    });
  }
  const { executable, versionsDir, runtimeDir } = runtime.value;
  const windows = platform === "win32";
  const binDir = environment.T3CODE_INSTALL_BIN_DIR?.trim() || path.join(home, ".local", "bin");
  const name = windows ? "t3.cmd" : "t3";
  const link = path.join(binDir, name);
  const failed = (reason: string) => () => new CliInstallError({ reason });

  const current = windows
    ? yield* fs.readFileString(link).pipe(Effect.map(windowsShimTarget), Effect.option)
    : yield* fs.readLink(link).pipe(
        Effect.map((target) => path.resolve(binDir, target)),
        Effect.option,
      );
  const occupied = Option.isSome(current) || (yield* fs.exists(link));
  if (
    occupied &&
    !(
      Option.isSome(current) &&
      current.value !== undefined &&
      launcherOwnsVersionsDir(path, versionsDir, current.value)
    )
  ) {
    return yield* new CliInstallError({
      reason: `Another t3 is already at ${link}. Remove it, then run this again.`,
    });
  }

  yield* fs
    .makeDirectory(binDir, { recursive: true })
    .pipe(Effect.mapError(failed(`Could not create ${binDir}.`)));
  if (windows) {
    yield* fs
      .writeFileString(link, `@echo off\r\n"${executable}" %*`)
      .pipe(Effect.mapError(failed(`Could not write ${link}.`)));
  } else {
    // Swap a temporary link into place so a running `t3` never sees the command missing.
    const staging = `${link}.${process.pid}.tmp`;
    yield* fs.symlink(executable, staging).pipe(
      Effect.andThen(fs.rename(staging, link)),
      Effect.tapError(() => fs.remove(staging, { force: true }).pipe(Effect.ignore)),
      Effect.mapError(failed(`Could not link ${link}.`)),
    );
  }

  // Pruning keeps what recorded launchers point at; a background service cannot see binDir otherwise.
  const recorded = path.join(
    yield* fs.realPath(binDir).pipe(Effect.orElseSucceed(() => binDir)),
    name,
  );
  const launchersFile = path.join(runtimeDir, "launchers");
  const launchers = yield* fs.readFileString(launchersFile).pipe(Effect.orElseSucceed(() => ""));
  if (!launchers.split(/\r?\n/).includes(recorded)) {
    yield* fs.writeFileString(launchersFile, `${recorded}\n`, { flag: "a" }).pipe(Effect.ignore);
  }

  const same = (entry: string) =>
    windows ? entry.toLowerCase() === binDir.toLowerCase() : entry === binDir;
  const onPath = (environment.PATH ?? environment.Path ?? "").split(windows ? ";" : ":").some(same);
  return {
    link,
    onPath,
    pathCommand: onPath
      ? undefined
      : pathSetupCommand({ directory: binDir, home, shell: environment.SHELL, platform }),
    binDir,
  };
});

const reportInstalled = Effect.fn("cli.install.report")(function* (
  installed: Effect.Success<ReturnType<typeof installCli>>,
) {
  yield* Console.log(`Installed t3 ${packageJson.version} at ${installed.link}.`);
  if (installed.onPath) return yield* Console.log("Run `t3` to get started.");
  if (installed.pathCommand === undefined) {
    return yield* Console.log(`Add ${installed.binDir} to your PATH, then run \`t3\`.`);
  }
  yield* Console.log(`${installed.binDir} is not on your PATH yet. Add it with:`);
  yield* Console.log(`  ${installed.pathCommand}`);
  yield* Console.log("Then open a new terminal and run `t3`.");
});

export const installCommand = Command.make("install").pipe(
  Command.withDescription(
    "Install this version as the `t3` command, so you can run t3 without npx.",
  ),
  Command.withHandler(() => installCli().pipe(Effect.flatMap(reportInstalled))),
);

/** Saying no lasts until the next minor release: `0.2` covers `0.2.5` and `0.2.6-nightly.…`. */
const minorRelease = (version: string) => version.split(".").slice(0, 2).join(".");

const SKIPPED_ARGUMENTS = new Set(["help", "--help", "-h", "--version", "install", "uninstall"]);

/**
 * Before a command run through npx, pnpm dlx, or bunx at a terminal, asks to install the `t3`
 * command. Yes is the default; no is saved in the T3 home per minor release.
 */
export const offerCliInstall = Effect.fn("cli.install.offer")(function* <E, R>(input: {
  readonly args: ReadonlyArray<string>;
  readonly interactive: boolean;
  readonly confirm: Effect.Effect<boolean, E, R>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  if (!input.interactive || environment.CI || environment.SUDO_USER) return;
  if (input.args.some((arg) => SKIPPED_ARGUMENTS.has(arg))) return;
  const runner = detectCliRunner(yield* resolveEntryPath);
  if (runner === null) return;
  const runtime = yield* standaloneRuntime;
  if (Option.isNone(runtime)) return;
  const { runtimeDir } = runtime.value;
  // An installed `t3` that is older, or skipped with T3CODE_USE_NPM, still means no prompt.
  const launchers = yield* fs
    .readFileString(path.join(runtimeDir, "launchers"))
    .pipe(Effect.orElseSucceed(() => ""));
  for (const launcher of [
    ...launchers.split(/\r?\n/).filter(Boolean),
    path.join(path.dirname(runtimeDir), "bin", "t3"),
  ]) {
    if (yield* fs.exists(launcher).pipe(Effect.orElseSucceed(() => false))) return;
  }
  const declinedFile = path.join(runtimeDir, "install-prompt-declined");
  const declined = yield* fs.readFileString(declinedFile).pipe(Effect.orElseSucceed(() => ""));
  const minor = minorRelease(packageJson.version);
  if (declined.trim() === minor) return;

  if (!(yield* input.confirm)) {
    yield* fs.writeFileString(declinedFile, `${minor}\n`).pipe(Effect.ignore);
    return yield* Console.log(`Skipped. Run \`${runner} t3 install\` any time.\n`);
  }
  yield* installCli().pipe(
    Effect.flatMap(reportInstalled),
    Effect.catch((error) => Console.error(`Could not install t3: ${error.message}`)),
  );
  yield* Console.log("");
});

export const confirmCliInstall = Prompt.run(
  Prompt.Confirm({
    message: "Install the t3 command? Then you can run `t3` without npx.",
    initial: true,
  }),
);
