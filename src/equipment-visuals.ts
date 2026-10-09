// A small, separated palette leaves red exclusively for missing equipment data.
// Eight textures make repeated colours distinguishable even in monochrome exports.
export const EQUIPMENT_PALETTE = ["#0069B5", "#13804A", "#E8CE00", "#7839A8", "#D87500", "#624328"] as const;
export const EQUIPMENT_MOTIFS = ["diagonal", "reverse", "horizontal", "vertical", "dots", "grid", "crosshatch", "checker"] as const;

export type EquipmentVisual = { color: string; pattern: number; code: number };

export function equipmentVisuals(tipNames: string[]): Map<string, EquipmentVisual> {
  const tips = [...new Set(tipNames)].sort();
  return new Map(tips.map((tip, index) => {
    const group = Math.floor(index / EQUIPMENT_PALETTE.length);
    return [tip, {
      color: EQUIPMENT_PALETTE[(index + group) % EQUIPMENT_PALETTE.length],
      pattern: group % EQUIPMENT_MOTIFS.length,
      code: index + 1,
    }];
  }));
}

export function motifInk(color: string): string {
  const channels = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16) / 255);
  const luminance = channels.map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * luminance[0] + .7152 * luminance[1] + .0722 * luminance[2] > .31 ? "#172019" : "#ffffff";
}
