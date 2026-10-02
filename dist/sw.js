const CACHE="pistache-shell-44cf84346f53248d";
const PLAN_CACHE='pistache-plans-v1';
const FILES=["/index.html","/favicon.svg","/vendor/dxf-parser.js","/mixed-use-avancement-template.xlsx","/assets/html2canvas-BQ1lBxEY.js","/assets/index-2Gn5rzHD.css","/assets/index-CRzU9wL0.js","/assets/index.es-MB6BSmWj.js","/assets/jspdf.es.min-6-crLqmG.js","/assets/purify.es-Bvo9QlJ8.js"];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('pistache-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin)return;
  const path=url.pathname==='/'?'/index.html':url.pathname;
  if(path.startsWith('/projects/')&&/\.(dxf|png)$/.test(path)){event.respondWith((async()=>{const plans=await caches.open(PLAN_CACHE);const cached=await plans.match(event.request);if(cached)return cached;try{const response=await fetch(event.request);if(response.ok)await plans.put(event.request,response.clone());return response;}catch{return Response.error();}})());return;}
  if(!FILES.includes(path))return;
  event.respondWith((async()=>{const cache=await caches.open(CACHE);
    if(path==='/index.html'){try{const response=await fetch(event.request);if(response.ok)await cache.put('/index.html',response.clone());return response;}catch{ return (await cache.match('/index.html'))||Response.error(); }}
    const cached=await cache.match(path);return cached||fetch(event.request);
  })());
});
