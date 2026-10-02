import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { strFromU8, unzipSync } from "fflate";
import { appendWorkshopLayers, buildDwgPackage, detectClosedSpaces, sanitizeLayerName } from "../src/dxf-workshop.js";

type ParserConstructor = new () => { parseSync(source: string): { entities: Array<{ type: string; layer?: string; shape?: boolean; vertices?: unknown[] }> } | null };
const DxfParser = createRequire(import.meta.url)("dxf-parser") as ParserConstructor;

const emptyDxf = [
  "0", "SECTION", "2", "HEADER", "0", "ENDSEC",
  "0", "SECTION", "2", "TABLES",
  "0", "TABLE", "2", "LAYER", "70", "1",
  "0", "LAYER", "2", "0", "70", "0", "62", "7", "6", "CONTINUOUS",
  "0", "ENDTAB", "0", "ENDSEC",
  "0", "SECTION", "2", "ENTITIES", "0", "ENDSEC", "0", "EOF", "",
].join("\n");

test("creates an AutoCAD layer and a closed polyline for a delimited space", () => {
  const exported = appendWorkshopLayers(emptyDxf, [{
    id: "zone-1", level: "R+2", layer: "Carrelage 60/60",
    points: [{ x: 0, y: 0 }, { x: 12, y: 0 }, { x: 12, y: 8 }, { x: 0, y: 8 }],
  }]);

  const parsed = new DxfParser().parseSync(exported);
  assert.ok(parsed);
  const contour = parsed.entities.find(entity => entity.type === "LWPOLYLINE");
  assert.equal(contour?.layer, "Carrelage 60-60");
  assert.equal(contour?.shape, true);
  assert.equal(contour?.vertices?.length, 4);
  assert.match(exported, /0\r\nLAYER\r\n5\r\n[0-9A-F]+\r\n330\r\n[0-9A-F]+\r\n100\r\nAcDbSymbolTableRecord\r\n100\r\nAcDbLayerTableRecord\r\n2\r\nCarrelage 60-60/);
  assert.match(exported, /0\r\nLWPOLYLINE\r\n5\r\n[0-9A-F]+\r\n330\r\n[0-9A-F]+\r\n100\r\nAcDbEntity\r\n8\r\nCarrelage 60-60\r\n100\r\nAcDbPolyline/);
  assert.match(exported, /0\r\nTABLE\r\n2\r\nLAYER\r\n70\r\n2\r\n/);
});

test("exports DXF files whose group codes are padded and use old Mac line endings", () => {
  const padded=emptyDxf.split("\n").map((line,index)=>index%2===0&&line?line.padStart(3," "):line).join("\r");
  const exported=appendWorkshopLayers(padded,[{id:"zone-2",level:"RDC",layer:"Piscine",points:[{x:0,y:0},{x:4,y:0},{x:4,y:3},{x:0,y:3}]}]);
  const parsed=new DxfParser().parseSync(exported);
  assert.equal(parsed?.entities.find(entity=>entity.type==="LWPOLYLINE")?.layer,"Piscine");
  assert.match(exported,/  0\r\nSECTION/);
});

test("sanitizes characters forbidden in AutoCAD layer names", () => {
  assert.equal(sanitizeLayerName("  Couloir / BOH:*  "), "Couloir - BOH--");
  assert.equal(sanitizeLayerName("Carreaux 30*30"), "Carreaux 30x30");
  assert.equal(sanitizeLayerName(""), "ZONE");
  const longName=sanitizeLayerName("ESCALIERS ÉVACUATION — "+"revêtement antidérapant ".repeat(20));
  assert.ok(new TextEncoder().encode(longName).length<=120);
  assert.match(longName,/^ESCALIERS ÉVACUATION/);
});

test("prepares a local AutoCAD package for a real DWG conversion", () => {
  const files=unzipSync(buildDwgPackage(emptyDxf,"Plan SS-1.dxf",[{id:"zone",level:"SS-1",layer:"Carrelage 60/60",points:[{x:1,y:2},{x:3,y:2},{x:3,y:4}]}],[{name:"Carrelage 60/60",colorIndex:3}]));
  assert.equal(strFromU8(files["Plan SS-1-calques-original.dxf"]),emptyDxf);
  const manifest=JSON.parse(strFromU8(files["delimitations.json"]));
  assert.equal(manifest.outputFile,"Plan SS-1-calques.dwg");
  assert.equal(manifest.layers[0].name,"Carrelage 60-60");
  assert.deepEqual(manifest.zones[0].points,[{x:1,y:2},{x:3,y:2},{x:3,y:4}]);
  assert.match(strFromU8(files["convertir-en-dwg.ps1"]),/AutoCAD\.Application/);
  assert.match(strFromU8(files["convertir-en-dwg.ps1"]),/AddLightWeightPolyline/);
  assert.match(strFromU8(files["convertir-en-dwg.ps1"]),/SaveAs\(\$dwg, 64\)/);
  assert.match(strFromU8(files["convertir-en-dwg.ps1"]),/ERREUR_CONVERSION\.txt/);
  assert.match(strFromU8(files["CONVERTIR_EN_DWG.cmd"]),/convertir-en-dwg\.ps1/);
});

test("automatically detects named closed spaces and their nearest levels", () => {
  const rectangle=(x:number,y:number,layer:string)=>({type:"LWPOLYLINE",layer,shape:true,vertices:[{x,y},{x:x+8,y},{x:x+8,y:y+5},{x,y:y+5}]});
  const model={entities:[
    rectangle(0,0,"ZONE"),rectangle(100,0,"SDB"),
    {type:"MTEXT",text:"R+2",position:{x:-2,y:7}},
    {type:"MTEXT",text:"CHAMBRE 201",position:{x:4,y:2}},
    {type:"MTEXT",text:"R+3",position:{x:98,y:7}},
    {type:"MTEXT",text:"Salle de bain",position:{x:104,y:2}},
  ]};

  const result=detectClosedSpaces(model);
  assert.equal(result.zones.length,2);
  assert.deepEqual(result.levels,["R+2","R+3"]);
  assert.deepEqual(result.zones.map(zone=>[zone.level,zone.layer]),[["R+2","Chambre"],["R+3","Salle de bain"]]);
});

test("ignores open geometry and unnamed technical contours", () => {
  const result=detectClosedSpaces({entities:[
    {type:"LWPOLYLINE",layer:"MURS",vertices:[{x:0,y:0},{x:5,y:0},{x:5,y:5}]},
    {type:"LWPOLYLINE",layer:"0",shape:true,vertices:[{x:10,y:0},{x:15,y:0},{x:15,y:5},{x:10,y:5}]},
  ]});
  assert.equal(result.zones.length,0);
});

test("detects general named spaces instead of limiting detection to rooms", () => {
  const rectangle=(x:number,label:string)=>[
    {type:"LWPOLYLINE",layer:"ZONE",shape:true,vertices:[{x,y:0},{x:x+12,y:0},{x:x+12,y:8},{x,y:8}]},
    {type:"MTEXT",text:label,position:{x:x+6,y:4}},
  ];
  const result=detectClosedSpaces({entities:[...rectangle(0,"Piscine extérieure"),...rectangle(20,"Local technique"),...rectangle(40,"Stockage BOH")]},"RDC");
  assert.deepEqual(result.zones.map(zone=>zone.layer),["Piscine extérieure","Local technique","Stockage BOH"]);
  assert.ok(result.zones.every(zone=>zone.level==="RDC"));
});
