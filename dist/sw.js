const CACHE="pistache-shell-b4d666e86e3aa32f";
const PLAN_CACHE='pistache-plans-v1';
const FILES=["/index.html","/favicon.svg","/vendor/dxf-parser.js","/mixed-use-avancement-template.xlsx","/assets/equipment-map-ZvLXK5uX.js","/assets/html2canvas-Dn6bw578.js","/assets/index-BGj8Amcz.css","/assets/index-BpVcIvlh.js","/assets/index.es-BrLPsK0K.js","/assets/jspdf.es.min-BB2lUjWo.js","/assets/purify.es-Bvo9QlJ8.js","/assets/rolldown-runtime-hePW80VL.js"];
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
