import test from "node:test";
import assert from "node:assert/strict";
import { EQUIPMENT_RECORDS, equipmentIsDefined } from "../src/equipment-data.js";
import { EQUIPMENT_MOTIFS, EQUIPMENT_PALETTE, equipmentVisuals, motifInk } from "../src/equipment-visuals.js";

test("each equipment typology has its own colour and motif combination", () => {
  for (const equipment of ["headboard", "wardrobe", "bar", "vanity"]) {
    const tips = EQUIPMENT_RECORDS.filter((record) => record.equipment === equipment && equipmentIsDefined(record)).flatMap((record) => record.tipExcel ? [record.tipExcel] : []);
    const visuals = [...equipmentVisuals(tips).values()];
    assert.equal(new Set(visuals.map(({ color, pattern }) => `${color}:${pattern}`)).size, visuals.length);
    assert.ok(visuals.every(({ color, pattern }) => EQUIPMENT_PALETTE.includes(color as typeof EQUIPMENT_PALETTE[number]) && pattern < EQUIPMENT_MOTIFS.length));
    assert.ok(visuals.every(({ color }) => color.toLowerCase() !== "#ff003c"));
    for (let index = 1; index < visuals.length; index += 1) assert.notEqual(visuals[index].color, visuals[index - 1].color);
  }
});

test("light fills get dark motifs and dark fills get white motifs", () => {
  assert.equal(motifInk("#E8CE00"), "#172019");
  assert.equal(motifInk("#0069B5"), "#ffffff");
});
