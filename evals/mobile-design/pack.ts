// @effect-diagnostics nodeBuiltinImport:off - Builds image files with sharp and Node filesystem APIs.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import sharp from "sharp";

import type { DesktopShot } from "./capture-desktop.ts";
import type { FlowResult, MobileShot } from "./capture-mobile.ts";
import {
  AXES,
  DEVICE_CLASSES,
  FLOWS,
  PANEL,
  POSES,
  SCENES,
  type PanelMember,
  type Pose,
} from "./cases.ts";

const MAX_WIDTH = 2400;
const MAX_TILE_HEIGHT = 1400;
const LABEL_HEIGHT = 44;
const GAP = 24;

interface Tile {
  readonly file: string;
  readonly label: string;
}

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Lays tiles out in one row, scaled to a shared height, each with a label above it. */
async function contactSheet(
  tiles: ReadonlyArray<Tile>,
): Promise<{ readonly data: Buffer; readonly width: number; readonly height: number }> {
  const images = await Promise.all(
    tiles.map(async (tile) => ({ ...tile, meta: await sharp(tile.file).metadata() })),
  );
  const ratios = images.map((image) => (image.meta.width ?? 1) / (image.meta.height ?? 1));
  const widthBudget = MAX_WIDTH - GAP * (images.length + 1);
  const height = Math.floor(
    Math.min(MAX_TILE_HEIGHT, widthBudget / ratios.reduce((sum, ratio) => sum + ratio, 0)),
  );
  const widths = ratios.map((ratio) => Math.round(ratio * height));
  const sheetWidth = widths.reduce((sum, width) => sum + width, 0) + GAP * (images.length + 1);
  const sheetHeight = height + LABEL_HEIGHT + GAP * 2;
  let x = GAP;
  const layers = await Promise.all(
    images.map(async (image, index) => {
      const left = x;
      x += widths[index]! + GAP;
      const input = await sharp(image.file).resize(widths[index], height).png().toBuffer();
      const label = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${widths[index]}" height="${LABEL_HEIGHT}"><text x="0" y="30" font-family="Helvetica, Arial, sans-serif" font-size="26" fill="#d4d4d4">${escapeXml(image.label)}</text></svg>`,
      );
      return [
        { input: label, left, top: GAP },
        { input, left, top: GAP + LABEL_HEIGHT },
      ];
    }),
  );
  const data = await sharp({
    create: { width: sheetWidth, height: sheetHeight, channels: 3, background: "#1c1c1e" },
  })
    .composite(layers.flat())
    .png()
    .toBuffer();
  return { data, width: sheetWidth, height: sheetHeight };
}

async function writeImage(data: Buffer, destination: string) {
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  await NodeFSP.writeFile(destination, data);
}

/** Poses whose screenshots share a shape, so they sit well side by side. */
function shapeGroup(pose: Pose): string {
  if (pose.device === "iphone")
    return pose.orientation === "landscape" ? "iphone-landscape" : "iphone";
  if (pose.device === "duo") return `duo-${pose.fold}`;
  return `ipad-${pose.orientation}`;
}

export interface PackEntry {
  readonly file: string;
  readonly scene: string;
  readonly view: string;
}

/**
 * Writes the reviewer pack: contact sheets per scene and device shape, desktop pairs, flow
 * filmstrips, and the brief. Nothing in it says which build it shows.
 */
export async function buildPack(input: {
  readonly outDirectory: string;
  readonly shots: ReadonlyArray<MobileShot>;
  readonly flows: ReadonlyArray<FlowResult>;
  readonly desktop: ReadonlyArray<DesktopShot>;
  readonly referencesDirectory: string;
  readonly panel: ReadonlyArray<PanelMember>;
}): Promise<{ readonly brief: string }> {
  const pack = NodePath.join(input.outDirectory, "pack");
  await NodeFSP.rm(pack, { recursive: true, force: true });
  await NodeFSP.mkdir(pack, { recursive: true });
  const at = (file: string) => NodePath.join(input.outDirectory, file);
  const entries: PackEntry[] = [];

  for (const scene of SCENES) {
    // A capture that missed its ready state shows the harness, not the design; run.ts lists it.
    const shots = input.shots.filter((shot) => shot.scene === scene.id && !shot.problem);
    const groups = new Map<string, Tile[]>();
    for (const shot of shots) {
      const pose = POSES.find((candidate) => candidate.id === shot.pose);
      if (!pose) continue;
      const group = shapeGroup(pose);
      groups.set(group, [...(groups.get(group) ?? []), { file: at(shot.file), label: pose.label }]);
    }
    for (const [group, tiles] of groups) {
      const file = NodePath.join("screens", group, `${scene.id}.png`);
      await writeImage((await contactSheet(tiles)).data, NodePath.join(pack, file));
      entries.push({ file, scene: scene.title, view: group });
    }
    const desktop = input.desktop.find((shot) => shot.scene === scene.id && !shot.problem);
    if (desktop) {
      const phone = shots.find((shot) => shot.pose === "iphone-dark");
      const tablet = shots.find((shot) => shot.pose === "ipad-landscape-dark");
      const file = NodePath.join("desktop", `${scene.id}.png`);
      const pair = await contactSheet([
        { file: at(desktop.file), label: "Desktop web, 1440×900" },
        ...(tablet ? [{ file: at(tablet.file), label: "iPad landscape" }] : []),
        ...(phone ? [{ file: at(phone.file), label: "iPhone" }] : []),
      ]);
      await writeImage(pair.data, NodePath.join(pack, file));
      entries.push({ file, scene: scene.title, view: "desktop pair" });
    }
  }

  const flowRows: string[] = [];
  for (const result of input.flows) {
    const flow = FLOWS.find((candidate) => candidate.id === result.flow);
    if (!flow || result.frames.length === 0) continue;
    const file = NodePath.join("flows", `${flow.id}.png`);
    // Rows of five keep each phone frame large enough to read.
    const rows = await Promise.all(
      Array.from({ length: Math.ceil(result.frames.length / 5) }, (_, row) =>
        contactSheet(
          result.frames.slice(row * 5, row * 5 + 5).map((frame, index) => ({
            file: at(frame.file),
            label: `${row * 5 + index}. ${frame.action}`,
          })),
        ),
      ),
    );
    let top = 0;
    const filmstrip = await sharp({
      create: {
        width: Math.max(...rows.map((row) => row.width)),
        height: rows.reduce((sum, row) => sum + row.height, 0),
        channels: 3,
        background: "#1c1c1e",
      },
    })
      .composite(
        rows.map((row) => {
          const layer = { input: row.data, left: 0, top };
          top += row.height;
          return layer;
        }),
      )
      .png()
      .toBuffer();
    await writeImage(filmstrip, NodePath.join(pack, file));
    entries.push({ file, scene: flow.title, view: "flow" });
    flowRows.push(
      `| ${flow.title} | ${result.taps} | ${result.screens} | \`${file}\`${result.problem ? ` (stopped early: ${result.problem.split("\n")[0]})` : ""} |`,
    );
  }

  const references = await NodeFSP.readdir(input.referencesDirectory).catch(() => []);
  const referenceImages = references.filter((name) => /\.(png|jpe?g)$/i.test(name));
  if (referenceImages.length > 0) {
    await NodeFSP.mkdir(NodePath.join(pack, "references"), { recursive: true });
    for (const name of referenceImages) {
      await NodeFSP.copyFile(
        NodePath.join(input.referencesDirectory, name),
        NodePath.join(pack, "references", name),
      );
    }
  }

  const template = await NodeFSP.readFile(NodePath.join(import.meta.dirname, "brief.md"), "utf8");
  const brief = template
    .replace(
      "{{SCREENS}}",
      entries
        .filter((entry) => entry.view !== "flow")
        .map((entry) => `- \`${entry.file}\`: ${entry.scene} (${entry.view})`)
        .join("\n"),
    )
    .replace(
      "{{FLOWS}}",
      flowRows.length > 0
        ? ["| Task | Taps | Screens | Filmstrip |", "| --- | --- | --- | --- |", ...flowRows].join(
            "\n",
          )
        : "No flows were captured this round.",
    )
    .replace(
      "{{REFERENCES}}",
      referenceImages.length > 0
        ? referenceImages.map((name) => `- \`references/${name}\``).join("\n")
        : "No reference screenshots of the Codex or Claude iOS apps are in this pack. Judge that axis from what you know of those apps, and say so.",
    )
    .replace(
      "{{AXES}}",
      AXES.map((axis) => `- \`${axis.id}\`: **${axis.label}**: ${axis.description}.`).join("\n"),
    )
    .replace(
      "{{DEVICES}}",
      DEVICE_CLASSES.map((device) => `- \`${device.id}\`: ${device.label}`).join("\n"),
    )
    .replace(
      "{{JSON}}",
      JSON.stringify(
        {
          scores: Object.fromEntries(
            DEVICE_CLASSES.map((device) => [
              device.id,
              Object.fromEntries(AXES.map((axis) => [axis.id, 0])),
            ]),
          ),
          fixes: ["…", "…", "…", "…", "…"],
        },
        null,
        2,
      ),
    );
  const briefFile = NodePath.join(pack, "brief.md");
  await NodeFSP.writeFile(briefFile, brief);
  await NodeFSP.writeFile(
    NodePath.join(input.outDirectory, "council.json"),
    `${JSON.stringify(
      {
        brief: briefFile,
        scores: NodePath.join(input.outDirectory, "scores"),
        panel: input.panel.map((member) => ({ member, ...PANEL[member] })),
      },
      null,
      2,
    )}\n`,
  );
  return { brief: briefFile };
}
