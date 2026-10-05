import test from "node:test";
import assert from "node:assert/strict";
import { EQUIPMENT_RECORDS, equipmentIsDefined, equipmentRecord } from "../src/equipment-data.js";

test("imports the equipment rows from both Excel workbooks", () => {
  assert.equal(EQUIPMENT_RECORDS.filter((record) => record.equipment === "headboard" && record.category === "junior").length, 30);
  assert.equal(EQUIPMENT_RECORDS.filter((record) => record.equipment === "headboard" && record.category === "standard").length, 94);
  assert.equal(EQUIPMENT_RECORDS.filter((record) => record.equipment === "wardrobe" && record.category === "junior").length, 30);
});

test("propagates merged TIP EXCEL and PRODUCT CODE cells", () => {
  assert.deepEqual(
    { tip: equipmentRecord("headboard", 403)?.tipExcel, product: equipmentRecord("headboard", 403)?.productCode },
    { tip: "RO.ML05.1-2-L", product: "RO.ML05.1" },
  );
  assert.deepEqual(
    { tip: equipmentRecord("headboard", 330)?.tipExcel, product: equipmentRecord("headboard", 330)?.productCode },
    { tip: "RO.ML02-L-160B", product: "RO.ML02-H2390" },
  );
  assert.deepEqual(
    { tip: equipmentRecord("wardrobe", 213)?.tipExcel, product: equipmentRecord("wardrobe", 213)?.productCode },
    { tip: "RO.ML01-L-116", product: "RO.ML01" },
  );
});

test("keeps missing or question-marked values undefined", () => {
  assert.equal(equipmentIsDefined(equipmentRecord("wardrobe", 503)), false);
  const questionable = EQUIPMENT_RECORDS.find((record) => record.productCode === null && record.tipExcel === null);
  assert.ok(questionable);
});
