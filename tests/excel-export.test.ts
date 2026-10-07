import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { buildProgressWorkbook } from "../src/excel-export.js";

function numericCell(xml:string,reference:string):number {
  const escaped=reference.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const match=xml.match(new RegExp(`<c\\b[^>]*\\br="${escaped}"[^>]*>[\\s\\S]*?<v>([^<]+)<\\/v>[\\s\\S]*?<\\/c>`));
  if(!match)throw new Error(`Missing ${reference}`);
  return Number(match[1]);
}

test("Excel export preserves the template and writes current progress for every floor",async()=>{
  const template=new Uint8Array(await readFile(join(process.cwd(),"public","mixed-use-avancement-template.xlsx")));
  const input=unzipSync(template);
  const output=unzipSync(buildProgressWorkbook(template,[
    {key:"201:bathroom:plumbing-supply",active:true,record:{progress:54,blocked:false,note:"",startDate:"",endDate:""}},
    {key:"201:bedroom:partitions",active:true,record:{progress:25,blocked:false,note:"",startDate:"",endDate:""}},
    {key:"525:bedroom:joinery",active:true,record:{progress:80,blocked:false,note:"",startDate:"",endDate:""}},
  ]));
  const xml=strFromU8(output["xl/worksheets/sheet2.xml"]);
  assert.equal(numericCell(xml,"E5"),0.54);
  assert.equal(numericCell(xml,"AN5"),0.25);
  assert.equal(numericCell(xml,"D133"),525);
  assert.equal(numericCell(xml,"BT133"),0.8);
  assert.match(xml,/E\$5:E\$133/);
  const bathroomGraphs=strFromU8(output["xl/worksheets/sheet3.xml"]);
  assert.doesNotMatch(bathroomGraphs,/<c\b[^>]*\br="I3"/); // Hidden H column removes the Cloisons table.
  for(const name of Object.keys(input).filter(name=>name!=="xl/calcChain.xml"))assert.ok(output[name],`preserved ${name}`);
  assert.equal(output["xl/calcChain.xml"],undefined);
  assert.doesNotMatch(strFromU8(output["[Content_Types].xml"]),/calcChain/);
  assert.doesNotMatch(strFromU8(output["xl/_rels/workbook.xml.rels"]),/calcChain/);
  assert.equal(Object.keys(output).filter(name=>name.startsWith("xl/charts/")).length,
    Object.keys(input).filter(name=>name.startsWith("xl/charts/")).length);
});

test("Excel export removes graph blocks for hidden tasks and recalculates partial groups",async()=>{
  const template=new Uint8Array(await readFile(join(process.cwd(),"public","mixed-use-avancement-template.xlsx")));
  const visible=["F","K","L","M","O","P","Q","Z","AN","AR","AS","AX","AY","AZ","BA","BC","BD","BE","BF","BG","BH"];
  const output=unzipSync(buildProgressWorkbook(template,[],visible));
  const bathroom=strFromU8(output["xl/worksheets/sheet3.xml"]);
  const bedroom=strFromU8(output["xl/worksheets/sheet4.xml"]);

  assert.doesNotMatch(bathroom,/<c\b[^>]*\br="A3"/); // Plomberie sol is entirely hidden in the workbook.
  assert.doesNotMatch(bathroom,/<c\b[^>]*\br="I3"/); // Cloisons SDB is entirely hidden.
  assert.doesNotMatch(bathroom,/<mergeCell\b[^>]*\bref="I3:O3"/);
  assert.match(bathroom,/SUM\('Suivi des Chambres'!K5:K44\)\/\(COUNT\('Suivi des Chambres'!\$D\$5:\$D\$44\)\*1\)/);
  assert.match(bathroom,/SUM\('Suivi des Chambres'!K109:K133\)/);
  assert.doesNotMatch(bathroom,/<c\b[^>]*\br="I15"/); // Peinture FP is entirely hidden.

  assert.doesNotMatch(bedroom,/<c\b[^>]*\br="I3"/); // Électricité cloisons is entirely hidden.
  assert.match(bedroom,/SUM\('Suivi des Chambres'!AS5:AS44,'Suivi des Chambres'!AX5:AZ44\)/);
  assert.match(bedroom,/SUM\('Suivi des Chambres'!BA5:BA44\)/);
  assert.doesNotMatch(bedroom,/<c\b[^>]*\br="I21"/); // Réception is hidden / invalid in the source workbook.
});

test("the legacy Dressage Excel column keeps NOUR INOV progress",async()=>{
  const template=new Uint8Array(await readFile(join(process.cwd(),"public","mixed-use-avancement-template.xlsx")));
  const record=(progress:number)=>({progress,blocked:false,note:"",startDate:"",endDate:""});
  const output=unzipSync(buildProgressWorkbook(template,[
    {key:"201:bathroom:wall-render",active:true,record:record(35)},
    {key:"201:bathroom:wall-render-benthami",active:true,record:record(80)},
  ]));
  assert.equal(numericCell(strFromU8(output["xl/worksheets/sheet2.xml"]),"O5"),0.35);
});
