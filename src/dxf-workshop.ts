import { detectLegendHatchZones } from "./dxf-legend.js";
import { strToU8, zipSync } from "fflate";

type Point={x:number;y:number};
type Zone={id:string;level:string;layer:string;points:Point[];colorIndex?:number;trueColor?:number;color?:string};
type LayerColor={colorIndex?:number;trueColor?:number;color?:string};
type WorkshopDraft={fileName:string;levels:string[];layers:string[];zones:Zone[];layerColors?:Record<string,LayerColor>};
type Bounds={minX:number;minY:number;maxX:number;maxY:number};
type DetectedText={text:string;point:Point};
export type WorkshopDetection={zones:Zone[];levels:string[];layers:string[];closedCount:number};

declare global { interface Window { DxfParser:new()=>{parseSync:(source:string)=>any}; } }

const byId=<T extends Element=HTMLElement>(id:string)=>document.getElementById(id) as unknown as T;
const escapeHtml=(value:string)=>value.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
const numberValue=(value:number)=>Number(value).toFixed(4).replace(/\.0+$/,"");
let projectId="mixed-use",canEdit=false,initialized=false,source="",fileName="",dxf:any=null;
let levels=["NIVEAU"],layers:string[]=[],zones:Zone[]=[],activePoints:Point[]=[],tool:"draw"|"pan"="draw";
let layerColors:Record<string,LayerColor>={};
let bounds:Bounds={minX:0,minY:0,maxX:100,maxY:100},view={x:0,y:-100,width:100,height:100};
let panStart:{x:number;y:number;viewX:number;viewY:number}|null=null;
let detectionSummary="Aucun plan analysé.";

function draftKey(){return `muc-dxf-workshop:${projectId}`;}
function resetWorkshop(){source="";fileName="";dxf=null;levels=["NIVEAU"];layers=[];zones=[];activePoints=[];layerColors={};localStorage.removeItem(draftKey());}
function persist(){localStorage.setItem(draftKey(),JSON.stringify({fileName,levels,layers,zones,layerColors} satisfies WorkshopDraft));}
function message(value:string,error=false){const node=byId("workshopStatus");node.textContent=value;node.classList.toggle("error",error);}
function colorFor(value:string){let hash=0;for(const char of value)hash=(hash*31+char.charCodeAt(0))>>>0;return `hsl(${hash%360} 58% 46%)`;}
function cleanText(entity:any){return String(entity.text||entity.string||entity.value||"").replace(/\\P/g," ").replace(/\\[A-Za-z][^;]*;/g,"").replace(/[{}]/g,"").replace(/\s+/g," ").trim();}
function entityPoint(entity:any){return entity.position||entity.startPoint||entity.vertices?.[0]||null;}
function allPoints(model:any):Point[]{
  const result:Point[]=[];
  const visit=(entities:any[],depth=0)=>{if(depth>6)return;for(const entity of entities||[]){
    for(const point of entity.vertices||entity.controlPoints||[])if(Number.isFinite(point.x)&&Number.isFinite(point.y))result.push({x:point.x,y:point.y});
    if(entity.center&&Number.isFinite(entity.radius))result.push({x:entity.center.x-entity.radius,y:entity.center.y-entity.radius},{x:entity.center.x+entity.radius,y:entity.center.y+entity.radius});
    const point=entityPoint(entity);if(point&&Number.isFinite(point.x)&&Number.isFinite(point.y))result.push({x:point.x,y:point.y});
    if(entity.type==="INSERT"&&model.blocks?.[entity.name])visit(model.blocks[entity.name].entities,depth+1);
  }};visit(model.entities);return result;
}
function computeBounds(model:any):Bounds{
  const headerMin=model.header?.$EXTMIN,headerMax=model.header?.$EXTMAX;
  if(headerMin&&headerMax&&Number.isFinite(headerMin.x)&&Number.isFinite(headerMax.x)&&headerMax.x>headerMin.x&&headerMax.y>headerMin.y)return {minX:headerMin.x,minY:headerMin.y,maxX:headerMax.x,maxY:headerMax.y};
  const points=allPoints(model);if(!points.length)return {minX:0,minY:0,maxX:100,maxY:100};
  const minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x)),minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y));
  const padding=Math.max(maxX-minX,maxY-minY)*.02||1;return {minX:minX-padding,minY:minY-padding,maxX:maxX+padding,maxY:maxY+padding};
}
function distance(a:Point,b:Point){return Math.hypot(a.x-b.x,a.y-b.y);}
function polygonArea(points:Point[]){let sum=0;for(let index=0;index<points.length;index++){const current=points[index],next=points[(index+1)%points.length];sum+=current.x*next.y-next.x*current.y;}return Math.abs(sum/2);}
function polygonCenter(points:Point[]){return {x:points.reduce((sum,point)=>sum+point.x,0)/points.length,y:points.reduce((sum,point)=>sum+point.y,0)/points.length};}
function pointInPolygon(point:Point,polygon:Point[]){let inside=false;for(let index=0,previous=polygon.length-1;index<polygon.length;previous=index++){const a=polygon[index],b=polygon[previous];if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)inside=!inside;}return inside;}
function levelName(value:string){return value.match(/\b(?:SS\s*-?\s*\d+|RDC|R\s*\+\s*\d+|N(?:IVEAU)?\s*0?\d+)\b/i)?.[0]?.replace(/\s+/g,"").toUpperCase()||"";}
function usefulLayer(value:string){const normalized=value.trim(),generic=/^(?:0|DEFPOINTS?|ZONES?|ESPACES?|CONTOURS?|POLYLINES?|HATCH|HACHURES?|TEXTES?|ANNOTATIONS?|COTES?|DIMENSIONS?|MURS?|WALLS?|A-WALL)$/i;return normalized&&!generic.test(normalized)?normalized:"";}
function inferredLayer(texts:string[],sourceLayer:string){
  const joined=texts.join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase();
  if(/SALLE\s+DE\s+BAIN|\bSDB\b/.test(joined))return "Salle de bain";
  if(/\bCHAMBRE\b/.test(joined))return "Chambre";
  const namedArea=texts.find(text=>/\bCOULOIR\b|\bCIRCULATION\b|\bHALL\b|\bPISCINE\b/i.test(text));if(namedArea)return namedArea.trim();
  const label=texts.find(text=>/[A-Za-zÀ-ÿ]{3}/.test(text)&&!levelName(text)&&!/^\s*(?:\d+(?:[.,]\d+)?\s*(?:M[²2]?|CM|MM)?|CHAMBRE\s*\d+|STANDARD|SUITE(?:\s+(?:JUNIOR|EXECUTIVE))?)\s*$/i.test(text))?.trim();
  if(label)return label;
  return usefulLayer(sourceLayer);
}
export function detectClosedSpaces(model:any,fallbackLevel="NIVEAU"):WorkshopDetection{
  const texts:DetectedText[]=(model?.entities||[]).filter((entity:any)=>["TEXT","MTEXT"].includes(entity.type)&&entityPoint(entity)).map((entity:any)=>({text:cleanText(entity),point:entityPoint(entity)})).filter((item:DetectedText)=>item.text);
  const levelTexts=texts.map(item=>({...item,level:levelName(item.text)})).filter(item=>item.level);
  const detectedLevels=[...new Set(levelTexts.map(item=>item.level))];
  const planBounds=computeBounds(model),planArea=Math.max(1,(planBounds.maxX-planBounds.minX)*(planBounds.maxY-planBounds.minY));
  const candidates=(model?.entities||[]).filter((entity:any)=>["LWPOLYLINE","POLYLINE"].includes(entity.type)&&entity.vertices?.length>=3).map((entity:any)=>{
    let points:Point[]=entity.vertices.map((point:any)=>({x:Number(point.x),y:Number(point.y)})).filter((point:Point)=>Number.isFinite(point.x)&&Number.isFinite(point.y));
    if(points.length<3)return null;
    const diagonal=Math.hypot(Math.max(...points.map(point=>point.x))-Math.min(...points.map(point=>point.x)),Math.max(...points.map(point=>point.y))-Math.min(...points.map(point=>point.y)));
    const closed=Boolean(entity.shape||entity.isClosed)||distance(points[0],points[points.length-1])<=Math.max(diagonal*.02,1e-5);if(!closed)return null;
    if(distance(points[0],points[points.length-1])<=Math.max(diagonal*.02,1e-5))points=points.slice(0,-1);if(points.length<3)return null;
    const area=polygonArea(points);if(area<=planArea*1e-9||area>=planArea*.75)return null;
    const center=polygonCenter(points),contained=texts.filter(item=>pointInPolygon(item.point,points)).sort((a,b)=>distance(center,a.point)-distance(center,b.point)).map(item=>item.text),layer=inferredLayer(contained,String(entity.layer||""));if(!layer)return null;
    const level=levelTexts.length?[...levelTexts].sort((a,b)=>distance(center,a.point)-distance(center,b.point))[0].level:fallbackLevel;
    return {id:"auto-"+String(entity.handle||crypto.randomUUID()),level,layer,points,area,center};
  }).filter(Boolean) as Array<Zone&{area:number;center:Point}>;
  const unique=candidates.filter((zone,index,list)=>list.findIndex(other=>other.layer.toLocaleLowerCase("fr")===zone.layer.toLocaleLowerCase("fr")&&Math.abs(other.area-zone.area)<=Math.max(1e-6,zone.area*.002)&&distance(other.center,zone.center)<=Math.max(1e-5,Math.sqrt(zone.area)*.01))===index).slice(0,3000);
  const resultZones:Zone[]=unique.map(({area:_area,center:_center,...zone})=>zone),resultLevels=detectedLevels.length?detectedLevels:[fallbackLevel];
  return {zones:resultZones,levels:resultLevels,layers:[...new Set(resultZones.map(zone=>zone.layer))].sort((a,b)=>a.localeCompare(b,"fr",{numeric:true})),closedCount:candidates.length};
}
function pointsPath(points:Point[],close=false){return points.length?`M ${points.map(point=>`${numberValue(point.x)} ${numberValue(point.y)}`).join(" L ")}${close?" Z":""}`:"";}
function curvedPoints(entity:any){const start=entity.type==="CIRCLE"?0:entity.startAngle||0;let length=entity.type==="CIRCLE"?Math.PI*2:entity.angleLength;if(!Number.isFinite(length)||length<=0)length+=Math.PI*2;const segments=Math.max(18,Math.ceil(Math.abs(length)/(Math.PI/24)));return Array.from({length:segments+1},(_,index)=>({x:entity.center.x+Math.cos(start+length*index/segments)*entity.radius,y:entity.center.y+Math.sin(start+length*index/segments)*entity.radius}));}
function entitySvg(entity:any,blocks:any,ancestors:string[]=[]):string{
  if(entity.inPaperSpace)return "";
  if(entity.type==="INSERT"||entity.type==="DIMENSION"){
    const name=entity.type==="INSERT"?entity.name:entity.block,block=blocks?.[name];if(!block||ancestors.includes(name)||ancestors.length>6)return "";
    const content=(block.entities||[]).map((part:any)=>entitySvg(part,blocks,[...ancestors,name])).join("");if(!content)return "";
    if(entity.type==="DIMENSION")return `<g>${content}</g>`;
    const position=entity.position||{x:0,y:0},base=block.position||{x:0,y:0};
    return `<g transform="translate(${numberValue(position.x)} ${numberValue(position.y)}) rotate(${numberValue(entity.rotation||0)}) scale(${numberValue(entity.xScale||1)} ${numberValue(entity.yScale||1)}) translate(${numberValue(-base.x)} ${numberValue(-base.y)})">${content}</g>`;
  }
  if(entity.type==="LINE")return `<path d="${pointsPath(entity.vertices||[])}"/>`;
  if(["LWPOLYLINE","POLYLINE"].includes(entity.type))return `<path d="${pointsPath(entity.vertices||[],Boolean(entity.shape))}"/>`;
  if(["ARC","CIRCLE"].includes(entity.type)&&entity.center)return `<path d="${pointsPath(curvedPoints(entity),entity.type==="CIRCLE")}"/>`;
  if(entity.type==="SPLINE"&&entity.controlPoints?.length)return `<path d="${pointsPath(entity.controlPoints)}"/>`;
  return "";
}
function renderSvg(){
  const svg=byId<SVGSVGElement>("workshopSvg");svg.setAttribute("viewBox",`${view.x} ${view.y} ${view.width} ${view.height}`);
  if(!dxf){svg.innerHTML="";byId("workshopEmpty").hidden=false;return;}
  byId("workshopEmpty").hidden=true;
  const architecture=(dxf.entities||[]).map((entity:any)=>entitySvg(entity,dxf.blocks||{})).join("");
  const texts=(dxf.entities||[]).filter((entity:any)=>["TEXT","MTEXT"].includes(entity.type)&&entityPoint(entity)).map((entity:any)=>{const point=entityPoint(entity),text=cleanText(entity);return text?`<text x="${numberValue(point.x)}" y="${numberValue(-point.y)}">${escapeHtml(text)}</text>`:"";}).join("");
  const saved=zones.map(zone=>`<path class="workshop-zone" style="--zone:${zone.color||colorFor(zone.layer)}" d="${pointsPath(zone.points,true)}"><title>${escapeHtml(zone.level)} · ${escapeHtml(zone.layer)}</title></path>`).join("");
  const active=activePoints.length?`<path class="workshop-active-zone" d="${pointsPath(activePoints)}"/>${activePoints.map((point,index)=>`<circle data-active-point="${index}" cx="${numberValue(point.x)}" cy="${numberValue(point.y)}" r="${numberValue(Math.max(view.width,view.height)*.004)}"/>`).join("")}`:"";
  svg.innerHTML=`<g class="workshop-architecture" transform="scale(1 -1)">${architecture}</g><g class="workshop-zones" transform="scale(1 -1)">${saved}${active}</g><g class="workshop-texts">${texts}</g>`;
}
function renderControls(){
  const level=byId<HTMLSelectElement>("workshopLevel"),layer=byId<HTMLSelectElement>("workshopLayer");
  const selectedLevel=level.value||levels[0],selectedLayer=layer.value;
  level.innerHTML=levels.map(item=>`<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join("");level.value=levels.includes(selectedLevel)?selectedLevel:levels[0];
  layer.innerHTML=layers.length?layers.map(item=>`<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join(""):'<option value="">Ajoutez un élément de légende</option>';if(layers.includes(selectedLayer))layer.value=selectedLayer;
  byId("workshopZoneList").innerHTML=zones.length?zones.map((zone,index)=>`<article><i style="--zone:${zone.color||colorFor(zone.layer)}"></i><span><strong>${escapeHtml(zone.layer)}</strong><small>${escapeHtml(zone.level)} · ${zone.points.length} sommets</small></span><button type="button" data-workshop-delete="${index}">Supprimer</button></article>`).join(""):'<p class="access-hint">Aucun contour fermé.</p>';
  byId("workshopPlanTitle").textContent=fileName||"Aucun plan importé";byId("workshopPlanSummary").textContent=`${zones.length} contour(s) · ${layers.length} calque(s)`;
  byId("workshopDetectionSummary").textContent=detectionSummary;
  byId("workshopDraw").classList.toggle("active",tool==="draw");byId("workshopPan").classList.toggle("active",tool==="pan");
  byId("workshopSvg").classList.toggle("panning",tool==="pan");
}
function render(){renderControls();renderSvg();}
function fit(){view={x:bounds.minX,y:-bounds.maxY,width:Math.max(1,bounds.maxX-bounds.minX),height:Math.max(1,bounds.maxY-bounds.minY)};renderSvg();}
function svgPoint(event:PointerEvent){const svg=byId<SVGSVGElement>("workshopSvg"),matrix=svg.getScreenCTM();if(!matrix)return null;const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(matrix.inverse());return {x:point.x,y:-point.y};}
function closeContour(){
  if(activePoints.length<3){message("Ajoutez au moins trois points avant de fermer le contour.",true);return;}
  const layer=byId<HTMLSelectElement>("workshopLayer").value,level=byId<HTMLSelectElement>("workshopLevel").value;
  if(!layer){message("Choisissez d’abord un élément de légende.",true);return;}
  zones.push({id:crypto.randomUUID(),level,layer,points:[...activePoints],...layerColors[layer]});activePoints=[];persist();render();message(`Contour ajouté au calque « ${layer} » (${level}).`);
}
function shortLayerName(value:string,maxBytes=120){
  const encoder=new TextEncoder();if(encoder.encode(value).length<=maxBytes)return value;
  let hash=2166136261;for(const character of value){hash^=character.codePointAt(0)||0;hash=Math.imul(hash,16777619);}
  const suffix=`-${(hash>>>0).toString(16).toUpperCase().padStart(8,"0")}`,limit=maxBytes-encoder.encode(suffix).length;let prefix="";
  for(const character of value){if(encoder.encode(prefix+character).length>limit)break;prefix+=character;}
  return `${prefix.trimEnd()}${suffix}`;
}
function sanitizeLayerName(value:string){const clean=value.normalize("NFC").replace(/(\d)\s*[*×]\s*(\d)/g,"$1x$2").replace(/[<>\\/:;?*|="]/g,"-").replace(/\s+/g," ").trim()||"ZONE";return shortLayerName(clean);}
function layerRecord(name:string,handle:string,owner:string,colorIndex=3,trueColor?:number){return `0\nLAYER\n5\n${handle}\n330\n${owner}\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n2\n${name}\n70\n0\n62\n${Math.max(1,Math.min(255,colorIndex))}\n${Number.isFinite(trueColor)?`420\n${trueColor}\n`:""}6\nContinuous\n370\n-3\n`;}
function polylineRecord(zone:Zone,handle:string,owner:string){const name=sanitizeLayerName(zone.layer);return `0\nLWPOLYLINE\n5\n${handle}\n330\n${owner}\n100\nAcDbEntity\n8\n${name}\n100\nAcDbPolyline\n90\n${zone.points.length}\n70\n1\n43\n0.0\n${zone.points.map(point=>`10\n${numberValue(point.x)}\n20\n${numberValue(point.y)}\n`).join("")}`;}
function normalizeAsciiDxf(original:string){
  return original.replace(/^\uFEFF/,"").replace(/\r\n?/g,"\n").replace(/^(?:[ \t]*\n)+/,"");
}
function dxfPairs(value:string){const lines=value.split("\n"),pairs:Array<{code:string;value:string}>=[];for(let index=0;index<lines.length-1;index+=2)pairs.push({code:lines[index].trim(),value:lines[index+1].trim()});return pairs;}
export function appendWorkshopLayers(original:string,inputZones:Zone[],inputLayers:Array<{name:string;colorIndex?:number;trueColor?:number}>=[]){
  let result=normalizeAsciiDxf(original);const definitions=new Map<string,LayerColor>();for(const layer of inputLayers)definitions.set(sanitizeLayerName(layer.name),{colorIndex:layer.colorIndex||3,trueColor:layer.trueColor});for(const zone of inputZones){const name=sanitizeLayerName(zone.layer),existing=definitions.get(name);definitions.set(name,{colorIndex:zone.colorIndex||existing?.colorIndex||3,trueColor:zone.trueColor??existing?.trueColor});}
  const layerTable=/(^|\n)([ \t]*0\n[ \t]*TABLE[ \t]*\n[ \t]*2\n[ \t]*LAYER[ \t]*\n[\s\S]*?)(\n[ \t]*0\n[ \t]*ENDTAB[ \t]*(?:\n|$))/i;
  const tableMatch=layerTable.exec(result);if(!tableMatch)throw new Error("La table des calques du DXF est introuvable.");
  const tableBody=tableMatch[2],tablePairs=dxfPairs(tableBody),existingLayers=new Set<string>();let readingLayer=false;for(const pair of tablePairs){if(pair.code==="0")readingLayer=pair.value.toUpperCase()==="LAYER";else if(readingLayer&&pair.code==="2"){existingLayers.add(pair.value.toLocaleUpperCase("fr"));readingLayer=false;}}
  for(const name of [...definitions.keys()])if(existingLayers.has(name.toLocaleUpperCase("fr")))definitions.delete(name);
  let nextHandle=dxfPairs(result).filter(pair=>pair.code==="5"&&/^[0-9A-F]+$/i.test(pair.value)).reduce((maximum,pair)=>{const value=BigInt(`0x${pair.value}`);return value>maximum?value:maximum;},0n)+1n;
  const handle=()=>{const value=nextHandle.toString(16).toUpperCase();nextHandle++;return value;};
  const tableOwner=tablePairs.find(pair=>pair.code==="5")?.value||"0",layerEntries=[...definitions].map(([name,definition])=>layerRecord(name,handle(),tableOwner,definition.colorIndex,definition.trueColor)).join("");
  result=result.replace(layerTable,(_all,prefix,body,end)=>{const count=existingLayers.size+definitions.size;let updated=body.replace(/([ \t]*100\nAcDbSymbolTable\n[ \t]*70\n)[^\n]+/i,(_match:string,head:string)=>`${head}${count}`);if(updated===body)updated=body.replace(/([ \t]*0\n[ \t]*TABLE\n[ \t]*2\nLAYER\n(?:[ \t]*5\n[^\n]+\n)?[ \t]*70\n)[^\n]+/i,(_match:string,head:string)=>`${head}${count}`);return `${prefix}${updated}\n${layerEntries.trimEnd()}${end}`;});
  const marker=/(^|\n)[ \t]*0\n[ \t]*SECTION[ \t]*\n[ \t]*2\n[ \t]*ENTITIES[ \t]*(?:\n|$)/i.exec(result);if(!marker)throw new Error("La section ENTITIES du DXF est introuvable. Vérifiez qu’il s’agit bien d’un DXF ASCII et non d’un DWG renommé.");
  const offset=marker.index+marker[0].length,remainder=result.slice(offset),endMarker=/(^|\n)[ \t]*0\n[ \t]*ENDSEC[ \t]*(?:\n|$)/i.exec(remainder);if(!endMarker)throw new Error("La fin de la section ENTITIES est introuvable.");
  const entitySection=remainder.slice(0,endMarker.index),owners=dxfPairs(entitySection).filter(pair=>pair.code==="330"&&/^[0-9A-F]+$/i.test(pair.value)).map(pair=>pair.value),ownerCounts=new Map<string,number>();for(const owner of owners)ownerCounts.set(owner,(ownerCounts.get(owner)||0)+1);const entityOwner=[...ownerCounts].sort((a,b)=>b[1]-a[1])[0]?.[0]||"0";
  const end=offset+endMarker.index+(endMarker[0].startsWith("\n")?1:0),records=inputZones.map(zone=>polylineRecord(zone,handle(),entityOwner)).join("");
  result=result.slice(0,end)+records+result.slice(end);result=result.replace(/([ \t]*9\n\$HANDSEED\n[ \t]*5\n)[ \t]*[0-9A-F]+/i,`$1${nextHandle.toString(16).toUpperCase()}`);return result.replace(/\n/g,"\r\n");
}
const dwgConverterScript=`$ErrorActionPreference = 'Stop'
$folder = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestFile = Join-Path $folder 'delimitations.json'
$manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
$dxf = Get-Item -LiteralPath (Join-Path $folder $manifest.sourceFile)
$dwg = Join-Path $folder $manifest.outputFile
$errorFile = Join-Path $folder 'ERREUR_CONVERSION.txt'
Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue
$document = $null
try {
  Write-Host 'Ouverture du DXF original dans AutoCAD...'
  $autocad = New-Object -ComObject AutoCAD.Application
  $autocad.Visible = $true
  $lastOpenError = $null
  for ($attempt = 1; $attempt -le 10 -and -not $document; $attempt++) {
    try { $document = $autocad.Documents.Open($dxf.FullName, $false) }
    catch { $lastOpenError = $_; Start-Sleep -Seconds 2 }
  }
  if (-not $document) { throw $lastOpenError }
  Write-Host 'Creation des calques et des contours...'
  foreach ($layer in $manifest.layers) {
    try { $cadLayer = $document.Layers.Item([string]$layer.name) }
    catch { $cadLayer = $document.Layers.Add([string]$layer.name) }
    if ($layer.colorIndex -ge 1 -and $layer.colorIndex -le 255) { $cadLayer.Color = [int16]$layer.colorIndex }
  }
  foreach ($zone in $manifest.zones) {
    if ($zone.points.Count -lt 3) { continue }
    [double[]]$coordinates = [double[]]::new($zone.points.Count * 2)
    for ($index = 0; $index -lt $zone.points.Count; $index++) {
      $coordinates[$index * 2] = [double]$zone.points[$index].x
      $coordinates[$index * 2 + 1] = [double]$zone.points[$index].y
    }
    $polyline = $document.ModelSpace.AddLightWeightPolyline($coordinates)
    $polyline.Closed = $true
    $polyline.Layer = [string]$zone.layer
  }
  Write-Host 'Creation du fichier DWG...'
  $document.SaveAs($dwg, 64)
  Write-Host "DWG cree : $dwg"
} catch {
  ($_ | Format-List * -Force | Out-String) | Set-Content -LiteralPath $errorFile -Encoding UTF8
  Write-Host "Conversion impossible : $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Le detail est enregistre dans : $errorFile" -ForegroundColor Yellow
  exit 1
} finally {
  if ($document) { try { $document.Close($false) } catch {} }
}
`;
const dwgConverterCommand=`@echo off\r\nchcp 65001 >nul\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0convertir-en-dwg.ps1"\r\nif errorlevel 1 (\r\n  echo.\r\n  echo La conversion a echoue. Verifiez qu AutoCAD est installe puis relancez ce fichier.\r\n) else (\r\n  echo.\r\n  echo Conversion terminee. Le fichier DWG se trouve dans ce dossier.\r\n)\r\npause\r\n`;
export function buildDwgPackage(dxfContent:string,inputName:string,inputZones:Zone[]=[],inputLayers:Array<{name:string;colorIndex?:number;trueColor?:number}>=[]){
  const base=(inputName.replace(/\.dxf$/i,"").replace(/[<>:\"/\\|?*]/g,"-").replace(/[ .]+$/g,"")||"plan")+"-calques";
  const sourceFile=`${base}-original.dxf`,definitions=new Map<string,{name:string;colorIndex:number;trueColor?:number}>();
  for(const layer of inputLayers){const name=sanitizeLayerName(layer.name);definitions.set(name,{name,colorIndex:layer.colorIndex||3,trueColor:layer.trueColor});}
  for(const zone of inputZones){const name=sanitizeLayerName(zone.layer),previous=definitions.get(name);definitions.set(name,{name,colorIndex:zone.colorIndex||previous?.colorIndex||3,trueColor:zone.trueColor??previous?.trueColor});}
  const manifest={sourceFile,outputFile:`${base}.dwg`,layers:[...definitions.values()],zones:inputZones.map(zone=>({layer:sanitizeLayerName(zone.layer),points:zone.points.map(point=>({x:point.x,y:point.y}))}))};
  const readme=`EXPORT DWG - PROJET MUC\r\n\r\n1. Extrayez tout le contenu de ce ZIP dans un dossier.\r\n2. Double-cliquez sur CONVERTIR_EN_DWG.cmd.\r\n3. AutoCAD ouvre le DXF original, ajoute les calques et contours, puis cree ${base}.dwg.\r\n\r\nAutoCAD pour Windows doit etre installe sur ce PC.\r\n`;
  return zipSync({[sourceFile]:strToU8(dxfContent),"delimitations.json":strToU8(JSON.stringify(manifest,null,2)),"convertir-en-dwg.ps1":strToU8(dwgConverterScript),"CONVERTIR_EN_DWG.cmd":strToU8(dwgConverterCommand),"LISEZ-MOI.txt":strToU8(readme)},{level:6});
}
function download(content:string|Uint8Array,type:string,name:string){const link=document.createElement("a");link.href=URL.createObjectURL(new Blob([content as BlobPart],{type}));link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(link.href),1000);}
function detectMetadata(){
  const texts:string[]=(dxf.entities||[]).filter((entity:any)=>["TEXT","MTEXT"].includes(entity.type)).map(cleanText).filter((text:string)=>text.length>=2&&text.length<=120);
  const detectedLevels=[...new Set(texts.map((text:string)=>text.match(/\b(?:SS\s*-?\s*\d+|RDC|R\s*\+\s*\d+|N(?:IVEAU)?\s*0?\d+)\b/i)?.[0]?.replace(/\s+/g,"").toUpperCase()).filter(Boolean))] as string[];
  if(detectedLevels.length)levels=[...new Set([...levels,...detectedLevels])];
  const suggestions:string[]=[...new Set<string>(texts.filter((text:string)=>!/^\d+(?:[.,]\d+)?$/.test(text)&&!detectedLevels.includes(text.toUpperCase())))].sort((a,b)=>a.localeCompare(b,"fr",{numeric:true})).slice(0,250);
  byId("workshopDetectedTexts").innerHTML=suggestions.map(text=>`<option value="${escapeHtml(text)}"></option>`).join("");
}
function runAutomaticDetection(replace=true){
  if(!dxf){message("Importez d’abord un fichier DXF.",true);return;}
  const selected=byId<HTMLSelectElement>("workshopLevel").value,fallback=levels.find(level=>level!=="NIVEAU")||selected||levels[0]||"NIVEAU",legend=detectLegendHatchZones(source,dxf,fallback),detected=legend.entries.length?null:detectClosedSpaces(dxf,fallback);
  if(legend.entries.length){layers=legend.entries.map(entry=>entry.name);layerColors=Object.fromEntries(legend.entries.map(entry=>[entry.name,{colorIndex:entry.colorIndex,trueColor:entry.trueColor,color:entry.color}]));if(replace)zones=legend.zones;detectionSummary=`Légende reconnue : ${legend.entries.length} calque(s) et ${legend.zones.length} contour(s) trouvés par correspondance des hachures et couleurs.`;}
  else if(detected){levels=[...new Set([...levels,...detected.levels])];layers=[...new Set([...layers,...detected.layers])].sort((a,b)=>a.localeCompare(b,"fr",{numeric:true}));if(replace)zones=detected.zones;detectionSummary=`Aucune table de légende détectée. ${detected.zones.length} espace(s) nommé(s) reconnu(s) par leur géométrie.`;}
  activePoints=[];persist();render();
  const count=legend.entries.length?legend.zones.length:detected?.zones.length||0;message(count?"Analyse terminée : les motifs de la légende ont été associés aux zones similaires du plan.":legend.entries.length?"La légende est reconnue et ses calques seront créés, mais aucun motif identique n’a été trouvé dans le plan.":"Aucune légende exploitable ni aucun espace nommé n’a été reconnu.",!count);
}
async function importFile(file:File){
  if(!file.name.toLowerCase().endsWith(".dxf")){message("Exportez d’abord le plan AutoCAD au format DXF.",true);return;}
  source=await file.text();try{dxf=new window.DxfParser().parseSync(source);if(!dxf)throw new Error("DXF vide");fileName=file.name;bounds=computeBounds(dxf);fit();detectMetadata();runAutomaticDetection(true);}catch(error){dxf=null;message(`DXF illisible : ${error instanceof Error?error.message:String(error)}`,true);render();}
}
function initialize(){
  if(initialized)return;initialized=true;
  byId<HTMLInputElement>("workshopFile").addEventListener("change",event=>{const file=(event.target as HTMLInputElement).files?.[0];if(file)void importFile(file);});
  byId("workshopAutoDetect").addEventListener("click",()=>runAutomaticDetection(true));
  byId("workshopAddLevel").addEventListener("submit",event=>{event.preventDefault();const input=byId<HTMLInputElement>("workshopLevelName"),value=input.value.trim();if(value&&!levels.includes(value)){levels.push(value);input.value="";persist();renderControls();}});
  byId("workshopAddLegend").addEventListener("submit",event=>{event.preventDefault();const input=byId<HTMLInputElement>("workshopLegendName"),value=input.value.trim();if(value&&!layers.includes(value)){layers.push(value);input.value="";persist();renderControls();byId<HTMLSelectElement>("workshopLayer").value=value;}});
  byId("workshopDraw").addEventListener("click",()=>{tool="draw";renderControls();});byId("workshopPan").addEventListener("click",()=>{tool="pan";renderControls();});
  byId("workshopClose").addEventListener("click",closeContour);byId("workshopUndoPoint").addEventListener("click",()=>{activePoints.pop();renderSvg();});
  byId("workshopDeleteZone").addEventListener("click",()=>{if(zones.length){zones.pop();persist();render();message("Dernier contour supprimé.");}});
  byId("workshopClear").addEventListener("click",()=>{if(zones.length&&confirm("Supprimer tous les contours de ce brouillon ?")){zones=[];activePoints=[];persist();render();message("Tous les contours ont été supprimés.");}});
  byId("workshopZoneList").addEventListener("click",event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>("[data-workshop-delete]");if(!button)return;zones.splice(Number(button.dataset.workshopDelete),1);persist();render();message("Contour supprimé.");});
  byId("workshopExportDwg").addEventListener("click",()=>{if(!source)return message("Importez le DXF original avant de préparer le DWG.",true);if(!layers.length)return message("Aucun élément de légende n’a été reconnu.",true);try{const base=fileName.replace(/\.dxf$/i,"")||"plan",definitions=layers.map(name=>({name,colorIndex:layerColors[name]?.colorIndex,trueColor:layerColors[name]?.trueColor}));download(buildDwgPackage(source,fileName,zones,definitions),"application/zip",`${base}-DWG.zip`);message("Paquet DWG prêt. AutoCAD ouvrira le plan original puis ajoutera directement les calques et contours.");}catch(error){message(error instanceof Error?error.message:String(error),true);}});
  byId("workshopExportDxf").addEventListener("click",()=>{if(!source)return message("Importez le DXF original avant l’export.",true);if(!layers.length)return message("Aucun élément de légende n’a été reconnu.",true);try{download(appendWorkshopLayers(source,zones,layers.map(name=>({name,colorIndex:layerColors[name]?.colorIndex,trueColor:layerColors[name]?.trueColor}))),"application/dxf",`${fileName.replace(/\.dxf$/i,"")}-calques.dxf`);message("DXF exporté avec les calques et contours détectés depuis la légende.");}catch(error){message(error instanceof Error?error.message:String(error),true);}});
  byId("workshopExportJson").addEventListener("click",()=>download(JSON.stringify({fileName,levels,layers,zones,layerColors},null,2),"application/json",`${fileName.replace(/\.dxf$/i,"")||"plan"}-delimitations.json`));
  const svg=byId<SVGSVGElement>("workshopSvg");svg.addEventListener("pointerdown",event=>{if(!dxf||!canEdit)return;if(tool==="pan"){panStart={x:event.clientX,y:event.clientY,viewX:view.x,viewY:view.y};svg.setPointerCapture(event.pointerId);return;}const point=svgPoint(event);if(!point)return;const threshold=Math.max(view.width,view.height)*.015;if(activePoints.length>=3&&Math.hypot(point.x-activePoints[0].x,point.y-activePoints[0].y)<threshold)return closeContour();activePoints.push(point);renderSvg();message(`${activePoints.length} point(s). Touchez le premier point ou « Fermer le contour ».`);});
  svg.addEventListener("pointermove",event=>{if(!panStart||tool!=="pan")return;view.x=panStart.viewX-(event.clientX-panStart.x)*view.width/svg.clientWidth;view.y=panStart.viewY-(event.clientY-panStart.y)*view.height/svg.clientHeight;renderSvg();});
  const stopPan=()=>{panStart=null;};svg.addEventListener("pointerup",stopPan);svg.addEventListener("pointercancel",stopPan);
  svg.addEventListener("wheel",event=>{if(!dxf)return;event.preventDefault();const factor=event.deltaY>0?1.15:.87,point=svgPoint(event as unknown as PointerEvent);if(!point)return;const cursorY=-point.y,rx=(point.x-view.x)/view.width,ry=(cursorY-view.y)/view.height;view.width*=factor;view.height*=factor;view.x=point.x-rx*view.width;view.y=cursorY-ry*view.height;renderSvg();},{passive:false});
}

export function openDxfWorkshop(nextProjectId:string,editable:boolean){projectId=nextProjectId;canEdit=editable;initialize();resetWorkshop();detectionSummary="Aucun plan analysé.";render();message("Importez un fichier DXF : la détection démarrera automatiquement.");}

export {sanitizeLayerName};
