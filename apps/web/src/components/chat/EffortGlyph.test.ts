import { describe, expect, it } from "vite-plus/test";

import { resolveEffortGlyph } from "./EffortGlyph";

const descriptor = (ids: ReadonlyArray<string>, promptInjectedValues?: ReadonlyArray<string>) => ({
  id: "effort",
  label: "Reasoning",
  type: "select" as const,
  options: ids.map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) })),
  ...(promptInjectedValues ? { promptInjectedValues } : {}),
});

describe("resolveEffortGlyph", () => {
  const claude = descriptor(
    ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"],
    ["ultrathink"],
  );

  it("fills bars up to the current level and leaves workflow levels off the scale", () => {
    expect(resolveEffortGlyph(claude, "xhigh")).toEqual({ count: 5, filled: 4, special: null });
  });

  it("names Ultracode and Ultrathink instead of drawing a level", () => {
    expect(resolveEffortGlyph(claude, "ultracode")?.special).toBe("Ultracode");
    expect(resolveEffortGlyph(claude, "ultrathink")?.special).toBe("Ultrathink");
  });

  it("draws an off level as zero filled bars", () => {
    expect(resolveEffortGlyph(descriptor(["off", "low", "high"]), "off")).toEqual({
      count: 2,
      filled: 0,
      special: null,
    });
  });

  it("falls back to the word when the value is unknown or the scale has one level", () => {
    expect(resolveEffortGlyph(claude, "unknown")).toBeNull();
    expect(resolveEffortGlyph(descriptor(["high"]), "high")).toBeNull();
  });
});
