import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { tasksByZone, type ProgressRecord } from "./model.js";

const TEMPLATE_PATH = "/mixed-use-avancement-template.xlsx";
const TRACKING_SHEET = "xl/worksheets/sheet2.xml";
const GRAPH_SHEETS = ["xl/worksheets/sheet3.xml", "xl/worksheets/sheet4.xml"];
const allTaskColumns = Object.values(tasksByZone).flatMap(tasks => tasks.map(task => task.sourceColumn)).filter(column => /^[A-Z]+$/.test(column));

export type ExcelProgressTask = { key: string; active: boolean; record: ProgressRecord };
export type ExcelExportOptions = { visibleColumns?: Iterable<string>; date?: Date };

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cellPattern(reference: string): RegExp {
  return new RegExp(`<c\\b(?![^>]*\\/>)([^>]*\\br="${escapeRegex(reference)}"[^>]*)>[\\s\\S]*?<\\/c>`);
}

function setNumericCell(xml: string, reference: string, value: number): string {
  const pattern=cellPattern(reference);
  const emptyPattern=new RegExp(`<c\\b([^>]*\\br="${escapeRegex(reference)}"[^>]*)\\/>`);
  const target=pattern.test(xml) ? pattern : emptyPattern.test(xml) ? emptyPattern : null;
  if(!target) throw new Error(`Cellule Excel introuvable : ${reference}`);
  return xml.replace(target,(_match,attributes:string)=>{
    const numericAttributes=attributes.replace(/\s+t="[^"]*"/g,"");
    return `<c${numericAttributes}><v>${Number.isInteger(value) ? value : value.toFixed(4).replace(/0+$/,"")}</v></c>`;
  });
}

function numberText(value:number):string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/,"");
}

function setNumericCells(xml:string,values:Map<string,number>):string {
  const missing=new Set(values.keys());
  const result=xml.replace(/<c\b([^>]*?\br="([A-Z]+\d+)"[^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,(match,attributes:string,reference:string)=>{
    const value=values.get(reference);
    if(value===undefined)return match;
    missing.delete(reference);
    return `<c${attributes.replace(/\s+t="[^"]*"/g,"")}><v>${numberText(value)}</v></c>`;
  });
  if(missing.size)throw new Error(`Cellules Excel introuvables : ${[...missing].slice(0,5).join(", ")}`);
  return result;
}

function appendRoom525(xml: string): string {
  if(/<c\b[^>]*\br="D\d+"[^>]*>\s*<v>525<\/v>/.test(xml)) return xml;
  const juniorSource=xml.match(/<row\b([^>]*\br="130"[^>]*)>([\s\S]*?)<\/row>/);
  const lastRow=xml.match(/<row\b[^>]*\br="132"[^>]*>[\s\S]*?<\/row>/);
  if(!juniorSource || !lastRow) throw new Error("Les lignes R+5 du modèle Excel sont introuvables.");
  const cloned=`<row${juniorSource[1].replace(/\br="130"/, 'r="133"')}>${juniorSource[2].replace(/([A-Z]+)130/g,"$1"+"133")}</row>`;
  const extended=xml.replace(lastRow[0],lastRow[0]+cloned).replace(/<dimension ref="A1:BT132"\/>/,'<dimension ref="A1:BT133"/>');
  return setNumericCell(extended,"D133",525);
}

function roomRows(xml: string): Map<number,number> {
  const result=new Map<number,number>();
  for(const match of xml.matchAll(/<c\b(?![^>]*\/>)([^>]*)>([\s\S]*?)<\/c>/g)) {
    const reference=match[1].match(/\br="D(\d+)"/);
    const value=match[2].match(/<v>(\d+)<\/v>/);
    if(reference&&value)result.set(Number(value[1]),Number(reference[1]));
  }
  return result;
}

function requestFullCalculation(xml: string): string {
  return xml.replace(/<calcPr\b([^>]*)\/>/,(_match,attributes:string)=>{
    const cleaned=attributes.replace(/\s+(calcMode|fullCalcOnLoad|forceFullCalc)="[^"]*"/g,"");
    return `<calcPr${cleaned} calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>`;
  });
}

function removeCalculationChain(files:ReturnType<typeof unzipSync>):void {
  delete files["xl/calcChain.xml"];
  const contentTypes="[Content_Types].xml";
  if(files[contentTypes]) {
    const xml=strFromU8(files[contentTypes]).replace(/<Override\b[^>]*\bPartName="\/xl\/calcChain\.xml"[^>]*\/>/g,"");
    files[contentTypes]=strToU8(xml);
  }
  const relationships="xl/_rels/workbook.xml.rels";
  if(files[relationships]) {
    const xml=strFromU8(files[relationships]).replace(/<Relationship\b[^>]*\bTarget="(?:\.\.\/)?calcChain\.xml"[^>]*\/>/g,"");
    files[relationships]=strToU8(xml);
  }
}

function workbookVisibleColumns(xml:string):Set<string> {
  const hidden=new Set<string>();
  for(const match of xml.matchAll(/<col\b([^>]*)\/>/g)) {
    if(!/\bhidden="1"/.test(match[1]))continue;
    const min=Number(match[1].match(/\bmin="(\d+)"/)?.[1]);
    const max=Number(match[1].match(/\bmax="(\d+)"/)?.[1]);
    if(!Number.isFinite(min)||!Number.isFinite(max))continue;
    for(let index=min;index<=max;index++)hidden.add(columnName(index));
  }
  return new Set(allTaskColumns.filter(column=>!hidden.has(column)));
}

function columnNumber(column:string):number {
  return [...column].reduce((value,letter)=>value*26+letter.charCodeAt(0)-64,0);
}

function columnName(number:number):string {
  let result="";
  for(let value=number;value>0;value=Math.floor((value-1)/26))result=String.fromCharCode((value-1)%26+65)+result;
  return result;
}

function columnsBetween(first:string,last:string):string[] {
  const columns:string[]=[];
  for(let index=columnNumber(first);index<=columnNumber(last);index++)columns.push(columnName(index));
  return columns;
}

function contiguousRanges(columns:string[]):[string,string][] {
  const ranges:[string,string][]=[];
  for(const column of columns) {
    const previous=ranges.at(-1);
    if(previous && columnNumber(column)===columnNumber(previous[1])+1)previous[1]=column;
    else ranges.push([column,column]);
  }
  return ranges;
}

function graphBlockXml(xml:string,startColumn:string,titleRow:number):string {
  const start=columnNumber(startColumn),end=start+6,lastRow=titleRow+4;
  return [...xml.matchAll(/<c\b(?=[^>]*\br="([A-Z]+)(\d+)")[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)]
    .filter(match=>{
      const column=columnNumber(match[1]),row=Number(match[2]);
      return column>=start&&column<=end&&row>=titleRow&&row<=lastRow;
    }).map(match=>match[0]).join("");
}

function removeGraphBlock(xml:string,startColumn:string,titleRow:number):string {
  const start=columnNumber(startColumn),end=start+6,lastRow=titleRow+4;
  const outside=(reference:string)=>{
    const match=reference.match(/^([A-Z]+)(\d+)$/);
    if(!match)return true;
    const column=columnNumber(match[1]),row=Number(match[2]);
    return column<start||column>end||row<titleRow||row>lastRow;
  };
  return xml
    .replace(/<c\b(?=[^>]*\br="([A-Z]+)(\d+)")[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g,(cell,_column,_row)=>outside(`${_column}${_row}`)?cell:"")
    .replace(/<mergeCell\b[^>]*\bref="([A-Z]+\d+):([A-Z]+\d+)"[^>]*\/>/g,(merge,first,last)=>outside(first)||outside(last)?merge:"");
}

function filterGraphFormula(formula:string,visibleColumns:Set<string>):string {
  return formula.replace(
    /SUM\('Suivi des Chambres'!([A-Z]+)(\d+):([A-Z]+)(\d+)\)\/\(COUNT\('Suivi des Chambres'!\$D\$(\d+):\$D\$(\d+)\)\*COLUMNS\('Suivi des Chambres'![A-Z]+:[A-Z]+\)\)/g,
    (_match,first,startRow,last,endRow,countStart,countEnd)=>{
      const visible=columnsBetween(first,last).filter(column=>visibleColumns.has(column));
      const ranges=contiguousRanges(visible).map(([rangeStart,rangeEnd])=>
        `'Suivi des Chambres'!${rangeStart}${startRow}:${rangeEnd}${endRow}`);
      return `SUM(${ranges.join(",")})/(COUNT('Suivi des Chambres'!$D$${countStart}:$D$${countEnd})*${visible.length})`;
    },
  );
}

function filterGraphSheet(xml:string,visibleColumns:Set<string>):string {
  const starts=["A","I","Q"];
  for(let titleRow=3;titleRow<=33;titleRow+=6) {
    for(const startColumn of starts) {
      const block=graphBlockXml(xml,startColumn,titleRow);
      if(!block)continue;
      const source=block.match(/'Suivi des Chambres'!([A-Z]+)\d+:([A-Z]+)\d+/);
      if(!source || !columnsBetween(source[1],source[2]).some(column=>visibleColumns.has(column))) {
        xml=removeGraphBlock(xml,startColumn,titleRow);
        continue;
      }
      const start=columnNumber(startColumn),end=start+6,lastRow=titleRow+4;
      xml=xml.replace(/<c\b(?=[^>]*\br="([A-Z]+)(\d+)")[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g,(cell,column,row)=>{
        const number=columnNumber(column),rowNumber=Number(row);
        return number>=start&&number<=end&&rowNumber>=titleRow&&rowNumber<=lastRow
          ? cell.replace(/<f>([\s\S]*?)<\/f>/g,(_formulaTag,formula)=>`<f>${filterGraphFormula(formula,visibleColumns)}</f>`)
          : cell;
      });
    }
  }
  return xml;
}

export function buildProgressWorkbook(template: Uint8Array, tasks: ExcelProgressTask[], visibleColumns:Iterable<string>=allTaskColumns): Uint8Array {
  const files=unzipSync(template);
  if(!files[TRACKING_SHEET]) throw new Error("La feuille Suivi des Chambres est absente du modèle.");
  // The legacy O column belongs to NOUR INOV. Correct its old Dressage
  // headings in the exported copy; BENTHAMI has a separate app task.
  const stringsPath="xl/sharedStrings.xml";
  if(files[stringsPath]) {
    let strings=strFromU8(files[stringsPath]);
    strings=strings.replaceAll("<t>Dressage mur</t>","<t>Enduit ciment — NOUR INOV</t>")
      .replaceAll("<t>Dressage</t>","<t>Enduit ciment</t>")
      .replaceAll("<t>DRESSAGE</t>","<t>ENDUIT CIMENT</t>");
    files[stringsPath]=strToU8(strings);
  }
  // Removed graph formulas must not leave stale cell references in Excel's
  // calculation chain. Excel rebuilds this optional index on first open.
  removeCalculationChain(files);
  let sheet=appendRoom525(strFromU8(files[TRACKING_SHEET]));
  const columnsVisibleInTemplate=workbookVisibleColumns(sheet);
  const rows=roomRows(sheet);
  if(!rows.has(525)) throw new Error("La chambre 525 n’a pas pu être ajoutée à l’export.");

  // Start with a clean export so stale values from the template can never be
  // mistaken for current application progress.
  const values=new Map<string,number>();
  for(const row of rows.values()) {
    for(const column of allTaskColumns) values.set(`${column}${row}`,0);
  }

  for(const task of tasks) {
    if(!task.active) continue;
    const [roomText,zone,code]=task.key.split(":");
    const row=rows.get(Number(roomText));
    const definition=tasksByZone[zone as keyof typeof tasksByZone]?.find(item=>item.id===code);
    if(!row || !definition || !allTaskColumns.includes(definition.sourceColumn)) continue;
    values.set(`${definition.sourceColumn}${row}`,Math.max(0,Math.min(100,task.record.progress))/100);
  }
  sheet=setNumericCells(sheet,values);
  files[TRACKING_SHEET]=strToU8(sheet);

  const visible=new Set([...visibleColumns].filter(column=>columnsVisibleInTemplate.has(column)));
  for(const name of GRAPH_SHEETS) {
    if(files[name])files[name]=strToU8(filterGraphSheet(strFromU8(files[name]),visible));
  }

  // Extend formulas and chart sources to include the added R+5 room.
  for(const [name,content] of Object.entries(files)) {
    if(!name.endsWith(".xml") || name===TRACKING_SHEET) continue;
    let xml=strFromU8(content);
    if(GRAPH_SHEETS.includes(name))xml=xml.replace(/('Suivi des Chambres'![A-Z]+109:[A-Z]+)132/g,"$1"+"133");
    if(xml.includes("$132")) xml=xml.replace(/\$132/g,"$133");
    if(name==="xl/workbook.xml") xml=requestFullCalculation(xml);
    files[name]=strToU8(xml);
  }
  files[TRACKING_SHEET]=strToU8(sheet.replace(/\$132/g,"$133"));
  return zipSync(files,{level:6});
}

export async function downloadProgressWorkbook(tasks: ExcelProgressTask[], options:ExcelExportOptions={}): Promise<void> {
  const response=await fetch(TEMPLATE_PATH,{cache:"no-cache"});
  if(!response.ok) throw new Error(`Modèle Excel indisponible (${response.status}).`);
  const output=buildProgressWorkbook(new Uint8Array(await response.arrayBuffer()),tasks,options.visibleColumns);
  const bytes=new Uint8Array(output.byteLength);bytes.set(output);
  const blob=new Blob([bytes.buffer],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
  const url=URL.createObjectURL(blob);
  const link=document.createElement("a");
  link.href=url;
  const exportedAt=options.date || new Date();
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-CA",{
    timeZone:"Africa/Casablanca",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23",
  }).formatToParts(exportedAt).filter(part=>part.type!=="literal").map(part=>[part.type,part.value]));
  link.download=`Projet-MUC-avancement-${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}${parts.second}.xlsx`;
  document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
