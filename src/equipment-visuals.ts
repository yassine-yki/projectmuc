// Muted architectural tones keep the plan readable; codes and sparse motifs
// distinguish repeated colours without turning every room into a bright tile.
export const EQUIPMENT_PALETTE = ["#8AADC2", "#9DBB8F", "#D6B65B", "#B199C9", "#CD9074", "#7E6A52"] as const;
export const EQUIPMENT_MOTIFS = ["diagonal", "reverse", "horizontal", "vertical", "dots", "grid", "crosshatch", "ring"] as const;
export const EQUIPMENT_MOTIF_INK = "#46514d";

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
