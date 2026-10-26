import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import { installCli, offerCliInstall } from "./install.ts";

const VERSION = packageJson.version;

/** A standalone runtime in a temp T3 home, started by the npm launcher from an npx cache. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-install-" });
  const runtimeDir = path.join(root, ".t3/runtime");
  const executable = path.join(runtimeDir, "versions", VERSION, "t3");
  yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
  yield* fs.writeFileString(executable, "");
  const npmPackage = path.join(root, ".npm/_npx/abc/node_modules/t3");
  yield* fs.makeDirectory(path.join(npmPackage, "bin"), { recursive: true });
  yield* fs.writeFileString(
    path.join(npmPackage, "package.json"),
    JSON.stringify({ name: "t3", version: VERSION }),
  );
  const binDir = path.join(root, "bin");
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.HomeDirectory, root),
      Effect.provideService(HostProcess.IsExecutable, true),
      Effect.provideService(HostProcess.ExecutablePath, executable),
      Effect.provideService(HostProcess.Environment, {
        PATH: "/usr/bin",
        SHELL: "/bin/zsh",
        T3CODE_INSTALL_BIN_DIR: binDir,
        T3CODE_NPM_LAUNCHER_PATH: path.join(npmPackage, "bin/t3.mjs"),
      }),
    );
  return { root, runtimeDir, executable, link: path.join(binDir, "t3"), provide };
});

it.layer(NodeServices.layer)("t3 install", (it) => {
  it.effect("links the running runtime, records it, and never replaces another t3", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, runtimeDir, executable, link, provide } = yield* setup;

      const older = path.join(runtimeDir, "versions/0.0.1/t3");
      yield* fs.makeDirectory(path.dirname(link), { recursive: true });
      yield* fs.symlink(older, link);
      const installed = yield* provide(installCli());
      assert.equal(yield* fs.readLink(link), executable);
      assert.isFalse(installed.onPath);
      assert.equal(installed.pathCommand, `echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc`);

      yield* provide(installCli());
      const recorded = yield* fs.readFileString(path.join(runtimeDir, "launchers"));
      assert.equal(recorded, `${yield* fs.realPath(path.join(root, "bin"))}/t3\n`);

      yield* fs.remove(link);
      yield* fs.writeFileString(link, "#!/bin/sh\n");
      const error = yield* provide(installCli()).pipe(Effect.flip);
      assert.include(error.message, "Another t3 is already at");
      assert.equal(yield* fs.readFileString(link), "#!/bin/sh\n");
    }).pipe(Effect.scoped),
  );

  it.effect("asks npx users without a t3 command once per minor release and installs on yes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { runtimeDir, executable, link, provide } = yield* setup;
      let asked = 0;
      const offer = (answer: boolean, args: ReadonlyArray<string> = ["connect"]) =>
        provide(
          offerCliInstall({
            args,
            interactive: true,
            confirm: Effect.sync(() => {
              asked += 1;
              return answer;
            }),
          }),
        );

      yield* offer(false, ["connect", "--help"]);
      assert.equal(asked, 0);

      yield* offer(false);
      yield* offer(false);
      assert.equal(asked, 1);
      assert.isFalse(yield* fs.exists(link));

      yield* fs.writeFileString(path.join(runtimeDir, "install-prompt-declined"), "0.0\n");
      yield* offer(true);
      assert.equal(asked, 2);
      assert.equal(yield* fs.readLink(link), executable);

      yield* fs.remove(path.join(runtimeDir, "install-prompt-declined"));
      yield* offer(true);
      assert.equal(asked, 2);
    }).pipe(Effect.scoped),
  );
});
