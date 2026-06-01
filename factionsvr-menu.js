(function () {
  'use strict';

  const REFRESH_MS  = 2000;
  const PLAYERS_API = '/api/map/players';
  const SKIN_API    = id => `/api/game/skin/image/${id}`;
  const CHUNK_SIZE  = 16;
  const TILE_SIZE   = 256;
  const BASE_ZOOM   = 8;

  let players       = [];
  let skinCache     = {};
  let fullSkinCache = {};
  let selectedId    = null;
  let sortKey       = 'playtime';
  let searchQuery   = '';
  let view          = 'list';
  let activeTab     = 'players';
  let visible       = true;
  let minimised     = false;

  let consolePlayer      = null;
  let consolePickerOpen  = false;
  let consoleLog         = [];       // { ts, type, text }[]
  let spamIntervals      = {};       // groupIdx -> intervalId
  const MAX_LOG          = 120;

  // ── CMD_GROUPS ─────────────────────────────────────────────────────────────
  const CMD_GROUPS = [
    {
      group: 'Map navigation',
      icon: '🗺️',
      cmds: [
        { label: 'Print centre & zoom level',
          code: `(()=>{const c=map.getCenter();const z=map.getZoom();return 'Centre: lat='+c.lat.toFixed(4)+' lng='+c.lng.toFixed(4)+' | Zoom: '+z})()` },
        { label: 'Print current game X/Z from view',
          code: `(()=>{const c=map.getCenter();const u=(256/Math.pow(2,8))/16;return 'Game coords → X:'+Math.round(c.lng/u)+' Z:'+Math.round(-c.lat/u)})()` },
        { label: 'Zoom in one step',
          code: `map.zoomIn(); 'Zoomed in → '+map.getZoom()` },
        { label: 'Zoom out one step',
          code: `map.zoomOut(); 'Zoomed out → '+map.getZoom()` },
        { label: 'Set zoom to 5',
          code: `map.setZoom(5); 'Zoom set to 5'` },
        { label: 'Set zoom to 8 (default)',
          code: `map.setZoom(8); 'Zoom set to 8'` },
        { label: 'Fly to world origin (0, 0)',
          code: `map.flyTo(gameToLeaflet(0,0),map.getZoom()); 'Flying to 0,0'` },
        { label: 'Pan to world origin instantly',
          code: `map.panTo([0,0]); 'Panned to origin'` },
        { label: 'Force map size recalculation',
          code: `map.invalidateSize(); 'Map size invalidated'` },
        { label: 'Get map bounds',
          code: `(()=>{const b=map.getBounds();return 'Bounds: SW('+b.getSouthWest().lat.toFixed(2)+','+b.getSouthWest().lng.toFixed(2)+') NE('+b.getNorthEast().lat.toFixed(2)+','+b.getNorthEast().lng.toFixed(2)+')'})()` },
        { label: 'List all map layer types',
          code: `(()=>{const types=[];map.eachLayer(l=>types.push(l.constructor.name||'Unknown'));return 'Layers: '+types.join(', ')})()` },
        { label: 'Count total map layers',
          code: `(()=>{let n=0;map.eachLayer(()=>n++);return 'Total layers: '+n})()` },
      ]
    },
    {
      group: 'Tiles',
      icon: '🧱',
      cmds: [
        { label: 'Redraw tile layer',
          code: `tileLayer.redraw(); 'Tile layer redrawn'` },
        { label: 'Cache-bust & redraw tiles',
          code: `cacheBuster=Date.now(); tileLayer.redraw(); 'Cache busted: '+cacheBuster` },
        { label: 'Redraw all layers',
          code: `(()=>{let n=0;map.eachLayer(l=>{if(l.redraw){l.redraw();n++;}});return 'Redrawn '+n+' layers'})()` },
        { label: 'Get tile layer URL template',
          code: `(()=>{return tileLayer._url||tileLayer.options&&tileLayer.options.url||'URL not found'})()` },
        { label: 'Get tile layer opacity',
          code: `(()=>{return 'Tile opacity: '+(tileLayer.options&&tileLayer.options.opacity!==undefined?tileLayer.options.opacity:'default (1)')})()` },
        { label: 'Set tile opacity to 0.5 (dimmed)',
          code: `tileLayer.setOpacity(0.5); 'Tile opacity set to 0.5'` },
        { label: 'Set tile opacity to 1 (full)',
          code: `tileLayer.setOpacity(1); 'Tile opacity set to 1'` },
      ]
    },
    {
      group: 'All players',
      icon: '👥',
      cmds: [
        { label: 'Count online players',
          code: `'Players online: '+playerMarkers.size` },
        { label: 'Print all online usernames',
          code: `(()=>{const names=Array.from(playerMarkers.keys());return names.length?names.join(', '):'No players online'})()` },
        { label: 'Print XYZ for all players',
          code: `(()=>{return Array.from(playerMarkers.values()).map(m=>{const p=m.playerData.Pose.Head.Position;return m.playerData.Username+': X'+Math.round(p[0])+' Y'+Math.round(p[1])+' Z'+Math.round(p[2])}).join(' | ')})()` },
        { label: 'Print ping for all players',
          code: `(()=>{return Array.from(playerMarkers.values()).map(m=>m.playerData.Username+': '+(m.playerData.ping||0)+'ms').join(' | ')})()` },
        { label: 'Print playtime for all players',
          code: `(()=>{return Array.from(playerMarkers.values()).map(m=>m.playerData.Username+': '+(m.playerData.PlayTime||'—')).join(' | ')})()` },
        { label: 'Find player with lowest ping',
          code: `(()=>{const arr=Array.from(playerMarkers.values());if(!arr.length)return 'No players';const best=arr.reduce((a,b)=>(a.playerData.ping||999)<(b.playerData.ping||999)?a:b);return 'Lowest ping: '+best.playerData.Username+' ('+best.playerData.ping+'ms)'})()` },
        { label: 'Find player with highest ping',
          code: `(()=>{const arr=Array.from(playerMarkers.values());if(!arr.length)return 'No players';const worst=arr.reduce((a,b)=>(a.playerData.ping||0)>(b.playerData.ping||0)?a:b);return 'Highest ping: '+worst.playerData.Username+' ('+worst.playerData.ping+'ms)'})()` },
        { label: 'Average ping across all players',
          code: `(()=>{const arr=Array.from(playerMarkers.values());if(!arr.length)return 'No players';const avg=arr.reduce((s,m)=>s+(m.playerData.ping||0),0)/arr.length;return 'Average ping: '+Math.round(avg)+'ms'})()` },
        { label: 'Who has been online longest',
          code: `(()=>{function pt(s){if(!s)return 0;let m=0;const h=s.match(/(\\d+)\\s*h/i),mn=s.match(/(\\d+)\\s*m/i);if(h)m+=parseInt(h[1])*60;if(mn)m+=parseInt(mn[1]);return m;}const arr=Array.from(playerMarkers.values());if(!arr.length)return 'No players';const top=arr.reduce((a,b)=>pt(a.playerData.PlayTime)>pt(b.playerData.PlayTime)?a:b);return 'Longest session: '+top.playerData.Username+' ('+top.playerData.PlayTime+')'})()` },
        { label: 'Refresh player data now',
          code: `fetchPlayers(); 'Player refresh triggered'` },
        { label: 'Highlight all marker elements with red outline',
          code: `(()=>{const els=document.querySelectorAll('.player-marker');els.forEach(e=>e.style.outline='2px solid red');return 'Highlighted '+els.length+' markers'})()` },
        { label: 'Remove all marker highlights',
          code: `(()=>{const els=document.querySelectorAll('.player-marker');els.forEach(e=>e.style.outline='');return 'Cleared '+els.length+' highlights'})()` },
        { label: 'Clear all player markers from map',
          code: `updatePlayers([]); 'All markers cleared'` },
        { label: 'Dump full player data array as JSON',
          code: `(()=>{const data=Array.from(playerMarkers.values()).map(m=>m.playerData);return JSON.stringify(data,null,2)})()` },
      ]
    },
    {
      group: 'Target player',
      icon: '🎯',
      cmds: [
        { label: 'Print all data for player',
          code: `(()=>{const m=Array.from(playerMarkers.values()).find(m=>m.playerData.Username==='{{USERNAME}}');return m?JSON.stringify(m.playerData,null,2):'Player not found'})()`,
          needsUser: true },
        { label: 'Print game coordinates (X Y Z)',
          code: `(()=>{const m=Array.from(playerMarkers.values()).find(m=>m.playerData.Username==='{{USERNAME}}');if(!m)return 'Not found';const p=m.playerData.Pose.Head.Position;return '{{USERNAME}} → X:'+Math.round(p[0])+' Y:'+Math.round(p[1])+' Z:'+Math.round(p[2])})()`,
          needsUser: true },
        { label: 'Print ping',
          code: `(()=>{const m=Array.from(playerMarkers.values()).find(m=>m.playerData.Username==='{{USERNAME}}');return m?'{{USERNAME}} ping: '+(m.playerData.ping||0)+'ms':'Not found'})()`,
          needsUser: true },
        { label: 'Print playtime',
          code: `(()=>{const m=Array.from(playerMarkers.values()).find(m=>m.playerData.Username==='{{USERNAME}}');return m?'{{USERNAME}} playtime: '+(m.playerData.PlayTime||'—'):'Not found'})()`,
          needsUser: true },
        { label: 'Print head rotation (yaw/pitch)',
          code: `(()=>{const m=Array.from(playerMarkers.values()).find(m=>m.playerData.Username==='{{USERNAME}}');if(!m)return 'Not found';const r=m.playerData.Pose&&m.playerData.Pose.Head&&m.playerData.Pose.Head.Rotation;return r?'{{USERNAME}} head rotation: '+JSON.stringify(r.map(v=>Math.round(v))):'No rotation data'})()`,
          needsUser: true },
        { label: 'Print full pose data',
          code: `(()=>{const m=Array.from(playerMarkers.values()).find(m=>m.playerData.Username==='{{USERNAME}}');return m&&m.playerData.Pose?JSON.stringify(m.playerData.Pose,null,2):'No pose data'})()`,
          needsUser: true },
        { label: 'Print skin ID',
          code: `(()=>{const m=Array.from(playerMarkers.values()).find(m=>m.playerData.Username==='{{USERNAME}}');return m?('Skin ID: '+(m.playerData.SkinId||'none')):'Not found'})()`,
          needsUser: true },
        { label: 'Jump map to player (instant)',
          code: `(()=>{const m=playerMarkers.get('{{USERNAME}}');if(!m)return 'Not found';map.setView(m.getLatLng(),map.getZoom());return 'Jumped to {{USERNAME}}'})()`,
          needsUser: true },
        { label: 'Fly map to player (animated)',
          code: `(()=>{const m=Array.from(playerMarkers.values()).find(m=>m.playerData.Username==='{{USERNAME}}');if(!m)return 'Not found';focusOnPlayer(m.playerData);return 'Flying to {{USERNAME}}'})()`,
          needsUser: true },
        { label: 'Start following player (saves id as window.fsvrFollow)',
          code: `(()=>{if(window.fsvrFollow)clearInterval(window.fsvrFollow);window.fsvrFollow=setInterval(()=>{const m=Array.from(playerMarkers.values()).find(m=>m.playerData.Username==='{{USERNAME}}');m&&map.setView(m.getLatLng(),map.getZoom(),{animate:false})},100);return 'Following {{USERNAME}} — run clearInterval(window.fsvrFollow) to stop'})()`,
          needsUser: true },
        { label: 'Stop following player',
          code: `(()=>{if(window.fsvrFollow){clearInterval(window.fsvrFollow);window.fsvrFollow=null;return 'Follow stopped';}return 'Not following anyone'})()`,
          needsUser: false },
        { label: 'Print Leaflet LatLng for player',
          code: `(()=>{const m=playerMarkers.get('{{USERNAME}}');return m?'LatLng: '+JSON.stringify(m.getLatLng()):'Not found'})()`,
          needsUser: true },
        { label: 'Reload skin for player',
          code: `(()=>{const m=Array.from(playerMarkers.values()).find(m=>m.playerData.Username==='{{USERNAME}}');if(!m)return 'Not found';m.loadedSkinId='';updatePlayerMarker(m,m.playerData);return 'Skin reload triggered for {{USERNAME}}'})()`,
          needsUser: true },
        { label: 'Print skin API URL',
          code: `(()=>{return window.location.origin+'/api/game/skin/image/{{SKINID}}'})()`,
          needsSkin: true },
        { label: 'Distance from map centre to player',
          code: `(()=>{const m=Array.from(playerMarkers.values()).find(m=>m.playerData.Username==='{{USERNAME}}');if(!m)return 'Not found';const p=m.playerData.Pose.Head.Position;const c=map.getCenter();const u=(256/Math.pow(2,8))/16;const cx=c.lng/u;const cz=-c.lat/u;const dx=p[0]-cx;const dz=p[2]-cz;return '{{USERNAME}} is '+Math.round(Math.sqrt(dx*dx+dz*dz))+' blocks from view centre'})()`,
          needsUser: true },
      ]
    },
    {
      group: 'Skins & textures',
      icon: '🎨',
      cmds: [
        { label: 'Count cached skin textures',
          code: `(()=>{try{return 'Skin cache: '+headTextureCache.size+' textures'}catch(e){return 'headTextureCache not found'}})()` },
        { label: 'List cached skin IDs',
          code: `(()=>{try{return Array.from(headTextureCache.keys()).join(', ')||'Cache empty'}catch(e){return 'headTextureCache not found'}})()` },
        { label: 'Clear all cached skin textures',
          code: `(()=>{try{const n=headTextureCache.size;headTextureCache.clear();loadedListSkins.clear();return 'Cleared '+n+' cached skins'}catch(e){return 'Error: '+e.message}})()` },
        { label: 'Reload all skins from server',
          code: `(()=>{try{headTextureCache.clear();loadedListSkins.clear();fetchPlayers();return 'Reloading all skins…'}catch(e){return 'Error: '+e.message}})()` },
        { label: 'Count players with skins vs without',
          code: `(()=>{const arr=Array.from(playerMarkers.values());const withSkin=arr.filter(m=>m.playerData.SkinId).length;return withSkin+' with skin, '+(arr.length-withSkin)+' without'})()` },
        { label: 'List all players missing a skin',
          code: `(()=>{const arr=Array.from(playerMarkers.values()).filter(m=>!m.playerData.SkinId);return arr.length?'No skin: '+arr.map(m=>m.playerData.Username).join(', '):'All players have skins'})()` },
      ]
    },
    {
      group: 'API & network',
      icon: '🌐',
      cmds: [
        { label: 'Fetch raw player API response',
          code: `(async()=>{try{const r=await fetch('/api/map/players');const d=await r.json();return 'API status: '+r.status+' | success: '+d.success+' | count: '+(d.players&&d.players.length)}catch(e){return 'Fetch failed: '+e.message}})()` },
        { label: 'Fetch raw response and print first player',
          code: `(async()=>{try{const r=await fetch('/api/map/players');const d=await r.json();const p=d.players&&d.players[0];return p?JSON.stringify(p,null,2):'No players in response'}catch(e){return 'Error: '+e.message}})()` },
        { label: 'Check skin API for selected player',
          code: `(async()=>{try{const url='/api/game/skin/image/{{SKINID}}';const r=await fetch(url,{method:'HEAD'});return 'Skin API response: '+r.status+' '+r.statusText+' | URL: '+url}catch(e){return 'Error: '+e.message}})()`,
          needsSkin: true },
        { label: 'List all cookies',
          code: `(()=>{return document.cookie||'No cookies found'})()` },
        { label: 'List localStorage keys & sizes',
          code: `(()=>{if(!localStorage.length)return 'localStorage is empty';return Array.from({length:localStorage.length},(_,i)=>{const k=localStorage.key(i);return k+' ('+localStorage.getItem(k).length+' chars)'}).join(' | ')})()` },
        { label: 'List sessionStorage keys',
          code: `(()=>{if(!sessionStorage.length)return 'sessionStorage is empty';return Array.from({length:sessionStorage.length},(_,i)=>sessionStorage.key(i)).join(', ')})()` },
        { label: 'Check WebSocket connections on page',
          code: `(()=>{const sockets=Object.values(window).filter(v=>v instanceof WebSocket);return sockets.length?sockets.map(s=>'WS: '+s.url+' state:'+s.readyState).join(' | '):'No active WebSockets found on window'})()` },
      ]
    },
    {
      group: 'Page & DOM',
      icon: '📄',
      cmds: [
        { label: 'Print page title & URL',
          code: `(()=>{return 'Title: '+document.title+' | URL: '+location.href})()` },
        { label: 'Count DOM elements on page',
          code: `(()=>{return 'DOM elements: '+document.querySelectorAll('*').length})()` },
        { label: 'Count canvas elements',
          code: `(()=>{return 'Canvas elements: '+document.querySelectorAll('canvas').length})()` },
        { label: 'Count script tags loaded',
          code: `(()=>{return 'Script tags: '+document.querySelectorAll('script').length})()` },
        { label: 'Print viewport size',
          code: `(()=>{return 'Viewport: '+window.innerWidth+'×'+window.innerHeight})()` },
        { label: 'Print device pixel ratio',
          code: `(()=>{return 'Device pixel ratio: '+window.devicePixelRatio})()` },
        { label: 'Print user agent',
          code: `(()=>{return navigator.userAgent})()` },
        { label: 'Check if page is focused',
          code: `(()=>{return 'Page focused: '+document.hasFocus()})()` },
        { label: 'Print memory usage (Chrome only)',
          code: `(()=>{if(!performance.memory)return 'performance.memory not available';const m=performance.memory;return 'JS heap: '+Math.round(m.usedJSHeapSize/1048576)+'MB used / '+Math.round(m.jsHeapSizeLimit/1048576)+'MB limit'})()` },
      ]
    },
    {
      group: 'Sidebar',
      icon: '📋',
      cmds: [
        { label: 'Toggle sidebar',
          code: `toggleSidebar(); 'Sidebar toggled'` },
        { label: 'Force sidebar open',
          code: `sidebarOpen=true; map.invalidateSize(); 'Sidebar opened'` },
        { label: 'Force sidebar closed',
          code: `sidebarOpen=false; map.invalidateSize(); 'Sidebar closed'` },
        { label: 'Check sidebar state',
          code: `(()=>{return 'Sidebar is: '+(sidebarOpen?'open':'closed')})()` },
      ]
    },
    {
      group: 'Debug & inspection',
      icon: '🔍',
      cmds: [
        { label: 'List all FactionSVR-related window globals',
          code: `(()=>{const keys=Object.keys(window).filter(k=>['map','playerMarkers','tileLayer','headTextureCache','loadedListSkins','fetchPlayers','updatePlayers','focusOnPlayer','updatePlayerMarker','cacheBuster','sidebarOpen','toggleSidebar','gameToLeaflet'].includes(k));return 'Found: '+keys.join(', ')})()` },
        { label: 'Inspect map object type & options',
          code: `(()=>{return 'Map type: '+(map&&map.constructor&&map.constructor.name)+' | options: '+JSON.stringify(map&&map.options)})()` },
        { label: 'Check Leaflet version',
          code: `(()=>{return 'Leaflet version: '+(L&&L.version||'not found')})()` },
        { label: 'Count marker icons loaded',
          code: `(()=>{const icons=document.querySelectorAll('.leaflet-marker-icon');return 'Leaflet marker icons in DOM: '+icons.length})()` },
        { label: 'Check if JSZip is loaded',
          code: `(()=>{return 'JSZip: '+(window.JSZip?'loaded (v'+window.JSZip.version+')':'not loaded')})()` },
        { label: 'Print cacheBuster value',
          code: `(()=>{return 'cacheBuster: '+(typeof cacheBuster!=='undefined'?cacheBuster:'not defined')})()` },
        { label: 'Print all window keys (alphabetical)',
          code: `(()=>{return Object.keys(window).sort().join(', ')})()` },
      ]
    },
    {
      group: 'Fun / chaos',
      icon: '🎲',
      cmds: [
        { label: 'Hop to random player every 1.5 s',
          code: `(()=>{const id=setInterval(()=>{const arr=Array.from(playerMarkers.values());const m=arr[Math.floor(Math.random()*arr.length)];m&&focusOnPlayer(m.playerData)},1500);window.fsvrChaos=id;return 'Random hop started — clearInterval(window.fsvrChaos) to stop'})()` },
        { label: 'Stop random hop',
          code: `(()=>{if(window.fsvrChaos){clearInterval(window.fsvrChaos);window.fsvrChaos=null;return 'Chaos stopped';}return 'Nothing running'})()` },
        { label: 'Spin map zoom in/out loop',
          code: `(()=>{let dir=1;const id=setInterval(()=>{if(map.getZoom()>=10)dir=-1;if(map.getZoom()<=4)dir=1;dir>0?map.zoomIn():map.zoomOut()},800);window.fsvrZoomLoop=id;return 'Zoom loop started — clearInterval(window.fsvrZoomLoop) to stop'})()` },
        { label: 'Stop zoom loop',
          code: `(()=>{if(window.fsvrZoomLoop){clearInterval(window.fsvrZoomLoop);window.fsvrZoomLoop=null;return 'Zoom loop stopped';}return 'Nothing running'})()` },
        { label: 'Flash all player markers randomly',
          code: `(()=>{const els=document.querySelectorAll('.player-marker');if(!els.length)return 'No markers found';const colors=['#ff0000','#00ff00','#0000ff','#ffff00','#ff00ff','#00ffff'];const id=setInterval(()=>{els.forEach(e=>e.style.outline='3px solid '+colors[Math.floor(Math.random()*colors.length)])},200);window.fsvrFlash=id;return 'Flash started — clearInterval(window.fsvrFlash) to stop'})()` },
        { label: 'Stop flashing markers',
          code: `(()=>{if(window.fsvrFlash){clearInterval(window.fsvrFlash);document.querySelectorAll('.player-marker').forEach(e=>e.style.outline='');window.fsvrFlash=null;return 'Flash stopped';}return 'Nothing running'})()` },
      ]
    },
  ];

  // ── Coord helpers ──────────────────────────────────────────────────────────
  function gameToLeaflet(x, z) {
    const upb = (TILE_SIZE / Math.pow(2, BASE_ZOOM)) / CHUNK_SIZE;
    return [-z * upb, x * upb];
  }
  function parsePlaytime(s) {
    if (!s) return 0;
    let m = 0;
    const h = s.match(/(\d+)\s*h/i), mn = s.match(/(\d+)\s*m/i);
    if (h) m += parseInt(h[1]) * 60;
    if (mn) m += parseInt(mn[1]);
    return m;
  }
  function getPos(p) {
    const pos = p.Pose?.Head?.Position;
    return pos ? { x: Math.round(pos[0]), y: Math.round(pos[1]), z: Math.round(pos[2]) } : { x:0, y:0, z:0 };
  }
  function pingColor(ms) {
    if (ms < 80)  return '#22c55e';
    if (ms < 150) return '#f59e0b';
    return '#ef4444';
  }
  function getSelected() {
    return players.find(p => String(p.id || p.Username) === selectedId) || null;
  }
  function getConsolePlayer() {
    return consolePlayer ? players.find(p => p.Username === consolePlayer) : null;
  }

  // ── Skin loading ───────────────────────────────────────────────────────────
  function loadFaceCrop(skinId, cb) {
    if (!skinId) return cb(null);
    if (skinCache[skinId]) return cb(skinCache[skinId]);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = 8;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8);
      skinCache[skinId] = c.toDataURL();
      const fc = document.createElement('canvas');
      fc.width = img.naturalWidth || 64;
      fc.height = img.naturalHeight || 64;
      fc.getContext('2d').drawImage(img, 0, 0);
      fullSkinCache[skinId] = fc.toDataURL();
      cb(skinCache[skinId]);
    };
    img.onerror = () => cb(null);
    img.src = SKIN_API(skinId);
  }

  // ── Toast ──────────────────────────────────────────────────────────────────
  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('fsvr-toast');
    if (!el) return;
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 3000);
  }

  // ── Console output log ─────────────────────────────────────────────────────
  function logToConsole(type, text) {
    const ts = new Date().toLocaleTimeString('en', { hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit' });
    consoleLog.push({ ts, type, text: String(text) });
    if (consoleLog.length > MAX_LOG) consoleLog.shift();
    flushConsoleOutput();
  }

  function flushConsoleOutput() {
    const out = document.getElementById('fsvr-output');
    if (!out) return;
    out.innerHTML = consoleLog.map(entry => {
      const color = entry.type === 'error' ? '#f87171'
                  : entry.type === 'info'  ? '#93c5fd'
                  : entry.type === 'warn'  ? '#fbbf24'
                  : '#86efac';
      return `<div style="margin-bottom:3px;word-break:break-all;"><span style="color:#444;font-size:10px;margin-right:6px;">${entry.ts}</span><span style="color:${color};">${escHtml(entry.text)}</span></div>`;
    }).join('');
    out.scrollTop = out.scrollHeight;
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Run command ────────────────────────────────────────────────────────────
  function runCmd(rawCode, needsUser, needsSkin) {
    let code = rawCode;
    if (needsUser) {
      if (!consolePlayer) { toast('⚠️ Select a player first'); return; }
      code = code.replaceAll('{{USERNAME}}', consolePlayer);
    }
    if (needsSkin) {
      const cp = getConsolePlayer();
      if (!cp || !cp.SkinId) { toast('⚠️ Selected player has no skin'); return; }
      code = code.replaceAll('{{SKINID}}', cp.SkinId);
    }

    navigator.clipboard.writeText(code).catch(() => {});

    // Run and capture result
    try {
      const result = (0, eval)(code);
      if (result && typeof result.then === 'function') {
        result.then(v => {
          if (v !== undefined) logToConsole('ok', v);
        }).catch(e => logToConsole('error', 'Async error: ' + e.message));
      } else if (result !== undefined) {
        logToConsole('ok', result);
      } else {
        logToConsole('info', '✓ ' + code.slice(0, 60) + (code.length > 60 ? '…' : ''));
      }
    } catch (e) {
      logToConsole('error', 'Error: ' + e.message);
    }
  }

  function runAllInGroup(gi) {
    const group = CMD_GROUPS[gi];
    const cpName = consolePlayer;
    let ran = 0;
    group.cmds.forEach((cmd, ci) => {
      const needsP = !!(cmd.needsUser || cmd.needsSkin);
      if (needsP && !cpName) return;
      const cp = getConsolePlayer();
      if (cmd.needsSkin && (!cp || !cp.SkinId)) return;
      logToConsole('info', '▶ ' + cmd.label);
      runCmd(cmd.code, !!cmd.needsUser, !!cmd.needsSkin);
      ran++;
    });
    if (!ran) logToConsole('warn', 'No runnable commands in "' + group.group + '" (select a player?)');
  }

  function toggleSpamGroup(gi) {
    if (spamIntervals[gi]) {
      clearInterval(spamIntervals[gi]);
      delete spamIntervals[gi];
      logToConsole('warn', '⏹ Spam stopped for group: ' + CMD_GROUPS[gi].group);
      refreshSpamButtons();
      return;
    }
    logToConsole('warn', '⚡ Spam started for group: ' + CMD_GROUPS[gi].group);
    spamIntervals[gi] = setInterval(() => {
      runAllInGroup(gi);
    }, 1500);
    refreshSpamButtons();
  }

  function refreshSpamButtons() {
    document.querySelectorAll('[data-spam-gi]').forEach(btn => {
      const gi = parseInt(btn.dataset.spamGi);
      btn.textContent = spamIntervals[gi] ? '⏹ Stop spam' : '⚡ Spam';
      btn.style.color = spamIntervals[gi] ? '#f87171' : '#f59e0b';
      btn.style.borderColor = spamIntervals[gi] ? '#f8717150' : '#f59e0b50';
    });
  }

  // ── Player panel actions ───────────────────────────────────────────────────
  function doGoto(p) {
    if (typeof map === 'undefined') return toast('❌ Map not found');
    const pos = p.Pose?.Head?.Position;
    if (!pos) return toast('No position for ' + p.Username);
    map.flyTo(gameToLeaflet(pos[0], pos[2]), BASE_ZOOM, { duration: 0.8 });
    toast('📍 Flying to ' + p.Username);
  }
  function doDownloadSkin(p) {
    if (!p.SkinId) return toast('No skin for ' + p.Username);
    loadFaceCrop(p.SkinId, () => {
      const full = fullSkinCache[p.SkinId];
      if (!full) return toast('Skin not cached yet — try again');
      const a = document.createElement('a');
      a.href = full;
      a.download = p.Username + '_skin.png';
      a.click();
      toast('⬇️ Downloaded skin: ' + p.Username);
    });
  }
  function doCopySkinUrl(p) {
    if (!p.SkinId) return toast('No skin for ' + p.Username);
    const url = window.location.origin + SKIN_API(p.SkinId);
    navigator.clipboard.writeText(url).then(() => toast('📋 Copied skin URL for ' + p.Username));
  }
  function doDownloadAll() {
    const ws = players.filter(p => p.SkinId);
    if (!ws.length) return toast('No skins available');
    if (!window.JSZip) {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload = () => doZip(ws);
      document.head.appendChild(s);
    } else { doZip(ws); }
  }
  function doZip(ws) {
    const zip = new window.JSZip();
    let done = 0;
    toast('📦 Building zip…');
    ws.forEach(p => {
      loadFaceCrop(p.SkinId, () => {
        const full = fullSkinCache[p.SkinId];
        if (full) zip.file(p.Username + '.png', full.split(',')[1], { base64: true });
        if (++done === ws.length) {
          zip.generateAsync({ type: 'blob' }).then(blob => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'factionsvr_skins.zip';
            a.click();
            toast('✅ Downloaded ' + ws.length + ' skins');
          });
        }
      });
    });
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────
  async function fetchPlayers() {
    try {
      const res  = await fetch(PLAYERS_API);
      const data = await res.json();
      if (data.success && Array.isArray(data.players)) {
        players = data.players;
        if (selectedId && !players.find(p => String(p.id || p.Username) === selectedId)) {
          selectedId = null; view = 'list';
        }
        if (consolePlayer && !players.find(p => p.Username === consolePlayer)) {
          consolePlayer = null;
        }
        render();
      }
    } catch (e) { /* silent */ }
  }

  function getSorted() {
    let list = players.filter(p => !searchQuery || p.Username.toLowerCase().includes(searchQuery));
    list.sort((a, b) => {
      if (sortKey === 'playtime') return parsePlaytime(b.PlayTime) - parsePlaytime(a.PlayTime);
      if (sortKey === 'ping')     return (a.ping||0) - (b.ping||0);
      if (sortKey === 'name')     return a.Username.localeCompare(b.Username);
      if (sortKey === 'x')        return getPos(a).x - getPos(b).x;
      if (sortKey === 'z')        return getPos(a).z - getPos(b).z;
      return 0;
    });
    return list;
  }

  // ── Master render ──────────────────────────────────────────────────────────
  function render() {
    renderCount();
    renderTabBar();
    if (activeTab === 'players') {
      if (view === 'list')   renderList();
      if (view === 'detail') renderDetail();
    } else if (activeTab === 'console') {
      // only full-rebuild if not already showing console
      if (!document.getElementById('fsvr-output')) renderConsole();
      else refreshConsolePlayerChip();
    }
  }

  function renderCount() {
    const el = document.getElementById('fsvr-count');
    if (el) el.textContent = players.length + ' online';
  }

  function renderTabBar() {
    const tb = document.getElementById('fsvr-tabbar');
    if (!tb) return;
    tb.innerHTML = `
      <button data-tab="players" style="${tabBtn(activeTab==='players')}">👥 Players</button>
      <button data-tab="console" style="${tabBtn(activeTab==='console')}">⌨️ Console</button>
    `;
    tb.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        activeTab = btn.dataset.tab;
        if (activeTab === 'players') view = 'list';
        render();
      });
    });
  }

  function tabBtn(active) {
    return `flex:1;padding:7px 0;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;
    background:${active ? 'rgba(99,102,241,0.22)' : 'transparent'};
    color:${active ? '#a5b4fc' : '#666'};transition:background 0.15s,color 0.15s;`;
  }

  // ── LIST VIEW ─────────────────────────────────────────────────────────────
  function renderList() {
    const body = document.getElementById('fsvr-body');
    if (!body) return;
    const list = getSorted();
    let html = '';

    html += `<div style="padding:8px 12px;display:flex;gap:6px;flex-direction:column;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;">
      <input id="fsvr-search-input" type="text" placeholder="🔍 Search…" value="${searchQuery}"
        style="width:100%;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:6px 10px;color:#e8e8f0;font-size:13px;outline:none;box-sizing:border-box;">
      <div style="display:flex;gap:6px;">
        <select id="fsvr-sort-sel" style="flex:1;background:#1a1a2e;border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 8px;color:#e8e8f0;font-size:12px;outline:none;">
          <option value="playtime" ${sortKey==='playtime'?'selected':''} style="background:#1a1a2e;color:#e8e8f0;">Playtime ↓</option>
          <option value="ping"     ${sortKey==='ping'?'selected':''} style="background:#1a1a2e;color:#e8e8f0;">Ping ↑</option>
          <option value="name"     ${sortKey==='name'?'selected':''} style="background:#1a1a2e;color:#e8e8f0;">Name A–Z</option>
          <option value="x"        ${sortKey==='x'?'selected':''} style="background:#1a1a2e;color:#e8e8f0;">X coord</option>
          <option value="z"        ${sortKey==='z'?'selected':''} style="background:#1a1a2e;color:#e8e8f0;">Z coord</option>
        </select>
        <button id="fsvr-dl-all-btn" style="${pillBtn('#6366f1')}">⬇️ All skins</button>
      </div>
    </div>`;

    html += `<ul id="fsvr-list" style="list-style:none;margin:0;padding:0;overflow-y:auto;flex:1;">`;
    if (!list.length) {
      html += `<li style="padding:20px;text-align:center;color:#666;font-size:13px;">No players found</li>`;
    } else {
      list.forEach(p => {
        const id  = String(p.id || p.Username);
        const pos = getPos(p);
        const pc  = pingColor(p.ping || 0);
        const sel = selectedId === id;
        html += `<li data-pid="${id}" class="fsvr-row" style="
          display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;
          border-bottom:1px solid rgba(255,255,255,0.05);transition:background 0.12s;
          background:${sel ? 'rgba(99,102,241,0.18)' : 'transparent'};
          border-left:3px solid ${sel ? '#6366f1' : 'transparent'};">
          <canvas data-skinid="${p.SkinId||''}" class="fsvr-face" width="8" height="8"
            style="width:26px;height:26px;image-rendering:pixelated;border-radius:4px;background:#2a2a3e;flex-shrink:0;"></canvas>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${sel?'#a5b4fc':'#e8e8f0'};">${p.Username}</div>
            <div style="font-size:11px;color:#888;margin-top:1px;">X:${pos.x} Z:${pos.z} · ${p.PlayTime||'—'}</div>
          </div>
          <div title="${Math.round(p.ping||0)}ms" style="width:8px;height:8px;border-radius:50%;background:${pc};flex-shrink:0;"></div>
          <span style="font-size:10px;color:#555;">›</span>
        </li>`;
      });
    }
    html += `</ul>`;
    body.innerHTML = html;

    const si = document.getElementById('fsvr-search-input');
    if (si) si.addEventListener('input', e => { searchQuery = e.target.value.toLowerCase().trim(); renderList(); });
    const ss = document.getElementById('fsvr-sort-sel');
    if (ss) ss.addEventListener('change', e => { sortKey = e.target.value; renderList(); });
    const da = document.getElementById('fsvr-dl-all-btn');
    if (da) da.addEventListener('click', doDownloadAll);

    body.querySelectorAll('.fsvr-row').forEach(row => {
      row.addEventListener('mouseenter', () => { if (selectedId !== row.dataset.pid) row.style.background = 'rgba(255,255,255,0.05)'; });
      row.addEventListener('mouseleave', () => { if (selectedId !== row.dataset.pid) row.style.background = 'transparent'; });
      row.addEventListener('click', () => { selectedId = row.dataset.pid; view = 'detail'; render(); });
    });

    body.querySelectorAll('.fsvr-face').forEach(canvas => {
      const skinId = canvas.dataset.skinid;
      if (!skinId) return;
      loadFaceCrop(skinId, url => {
        if (!url) return;
        const img = new Image();
        img.onload = () => { const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0, 8, 8); };
        img.src = url;
      });
    });
  }

  // ── DETAIL VIEW ───────────────────────────────────────────────────────────
  function renderDetail() {
    const body = document.getElementById('fsvr-body');
    const p    = getSelected();
    if (!p) { view = 'list'; return renderList(); }
    const pos = getPos(p);
    const pc  = pingColor(p.ping || 0);

    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;">
        <button id="fsvr-back" style="background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;line-height:1;padding:0 4px;">←</button>
        <span style="font-weight:700;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.Username}</span>
      </div>
      <div style="overflow-y:auto;flex:1;padding:14px 14px 6px;">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
          <canvas id="fsvr-big-face" width="64" height="64"
            style="width:72px;height:72px;image-rendering:pixelated;border-radius:8px;background:#2a2a3e;border:2px solid rgba(255,255,255,0.1);flex-shrink:0;"></canvas>
          <div>
            <div style="font-size:18px;font-weight:700;color:#e8e8f0;">${p.Username}</div>
            <div style="font-size:12px;color:#888;margin-top:3px;">ID: ${p.id || '—'}</div>
            <div style="font-size:12px;margin-top:4px;">
              <span style="color:${pc};font-weight:600;">${Math.round(p.ping||0)} ms</span>
              <span style="color:#555;"> · </span>
              <span style="color:#aaa;">${p.PlayTime || '—'}</span>
            </div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-bottom:14px;">
          ${statCard('X', pos.x)}${statCard('Y', pos.y)}${statCard('Z', pos.z)}
        </div>
        <div style="font-size:11px;color:#444;word-break:break-all;margin-bottom:14px;line-height:1.5;">
          ${p.SkinId ? 'Skin ID: ' + p.SkinId : '<span style="color:#555">No skin</span>'}
        </div>
        <div style="display:flex;flex-direction:column;gap:7px;padding-bottom:14px;">
          <button data-action="goto"    style="${actionBtn('#3b82f6')}">📍  Go to player on map</button>
          ${p.SkinId ? `<button data-action="skin"    style="${actionBtn('#22c55e')}">⬇️  Download skin PNG</button>` : ''}
          ${p.SkinId ? `<button data-action="copyurl" style="${actionBtn('#8b5cf6')}">📋  Copy skin URL</button>` : ''}
          ${p.SkinId ? `<button data-action="skinall" style="${actionBtn('#f59e0b')}">📦  Download all skins zip</button>` : ''}
          <button data-action="console" style="${actionBtn('#6366f1')}">⌨️  Set as Console target</button>
        </div>
      </div>
    `;

    document.getElementById('fsvr-back').onclick = () => { view = 'list'; render(); };

    body.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('mouseenter', () => btn.style.opacity = '0.8');
      btn.addEventListener('mouseleave', () => btn.style.opacity = '1');
      btn.addEventListener('click', () => {
        const a = btn.dataset.action;
        if (a === 'goto')    doGoto(p);
        if (a === 'skin')    doDownloadSkin(p);
        if (a === 'copyurl') doCopySkinUrl(p);
        if (a === 'skinall') doDownloadAll();
        if (a === 'console') {
          consolePlayer = p.Username;
          activeTab = 'console';
          render();
          toast('⌨️ Console target: ' + p.Username);
        }
      });
    });

    if (p.SkinId) {
      loadFaceCrop(p.SkinId, () => {
        const full = fullSkinCache[p.SkinId];
        if (!full) return;
        const c = document.getElementById('fsvr-big-face');
        if (!c) return;
        const img = new Image();
        img.onload = () => { const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0, 64, 64); };
        img.src = full;
      });
    }
  }

  // ── CONSOLE VIEW ──────────────────────────────────────────────────────────
  function renderConsole() {
    const body = document.getElementById('fsvr-body');
    if (!body) return;
    const cpName = consolePlayer;

    let html = '';

    // ── Player chip / picker ──
    html += `<div id="fsvr-console-header" style="padding:8px 10px;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;position:relative;">`;
    html += buildPlayerChipHtml(cpName);
    html += `</div>`;

    // ── Output area ──
    html += `<div style="flex-shrink:0;border-bottom:1px solid rgba(255,255,255,0.07);">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 10px 2px;">
        <span style="font-size:10px;color:#444;text-transform:uppercase;letter-spacing:0.5px;">Output</span>
        <button id="fsvr-clear-log" style="background:none;border:none;color:#444;font-size:10px;cursor:pointer;padding:2px 4px;">clear</button>
      </div>
      <div id="fsvr-output" style="height:80px;overflow-y:auto;padding:4px 10px 6px;font-family:monospace;font-size:11px;line-height:1.5;"></div>
    </div>`;

    // ── Commands ──
    html += `<div id="fsvr-cmd-scroll" style="overflow-y:auto;flex:1;padding:4px 0;">`;

    CMD_GROUPS.forEach((group, gi) => {
      const hasUser = group.cmds.some(c => c.needsUser || c.needsSkin);
      const locked  = hasUser && !cpName;
      const spamming = !!spamIntervals[gi];

      html += `<div class="fsvr-cmd-group" style="margin-bottom:2px;">`;
      html += `<div style="padding:5px 10px 3px;display:flex;align-items:center;gap:6px;position:sticky;top:0;background:#0f0f18;z-index:1;">
        <span style="font-size:10px;font-weight:700;color:#555;text-transform:uppercase;letter-spacing:0.7px;flex:1;">${group.icon} ${group.group}${locked?' <span style="color:#f59e0b;font-size:9px;">(need player)</span>':''}</span>
        <button data-do-all="${gi}" style="${groupActionBtn('#22c55e')}">▶ All</button>
        <button data-spam-gi="${gi}" style="${groupActionBtn(spamming?'#f87171':'#f59e0b')}">${spamming?'⏹ Stop':'⚡ Spam'}</button>
      </div>`;

      group.cmds.forEach((cmd, ci) => {
        const needsP   = !!(cmd.needsUser || cmd.needsSkin);
        const disabled = needsP && !cpName;
        html += `<button data-gi="${gi}" data-ci="${ci}" class="fsvr-cmd-btn" style="
          display:block;width:100%;text-align:left;
          padding:7px 10px 7px 14px;
          border:none;border-bottom:1px solid rgba(255,255,255,0.03);
          background:transparent;
          color:${disabled ? '#3a3a4a' : '#b0b0c8'};
          font-size:12px;cursor:${disabled ? 'default' : 'pointer'};
          transition:background 0.1s,color 0.1s;"
        >${needsP ? '<span style="color:#6366f1;margin-right:5px;font-size:9px;">👤</span>' : '<span style="margin-right:5px;font-size:9px;color:#2a2a3e;">·</span>'}${cmd.label}</button>`;
      });

      html += `</div>`;
    });

    html += `</div>`;
    body.innerHTML = html;

    // wire output clear
    document.getElementById('fsvr-clear-log').onclick = () => { consoleLog = []; flushConsoleOutput(); };

    flushConsoleOutput();
    bindConsoleEvents();
  }

  function buildPlayerChipHtml(cpName) {
    const cp = cpName ? players.find(p => p.Username === cpName) : null;
    let html = `<div style="font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:5px;">Target player</div>`;
    html += `<div id="fsvr-player-chip" style="
      display:flex;align-items:center;gap:8px;
      background:#1a1a2e;border:1px solid rgba(255,255,255,0.12);
      border-radius:7px;padding:6px 10px;cursor:pointer;
      transition:border-color 0.15s;" title="Click to change player">`;

    if (cp) {
      html += `<canvas id="fsvr-cp-face" data-skinid="${cp.SkinId||''}" width="8" height="8"
        style="width:20px;height:20px;image-rendering:pixelated;border-radius:3px;background:#2a2a3e;flex-shrink:0;"></canvas>`;
      html += `<span style="flex:1;color:#e8e8f0;font-size:12px;font-weight:600;">${cp.Username}</span>`;
      const pos = getPos(cp);
      html += `<span style="color:#555;font-size:10px;">X:${pos.x} Z:${pos.z}</span>`;
      html += `<span style="color:#6366f1;font-size:11px;">✎</span>`;
    } else {
      html += `<span style="flex:1;color:#555;font-size:12px;">— click to select player —</span>`;
      html += `<span style="color:#6366f1;font-size:11px;">▾</span>`;
    }
    html += `</div>`;

    // inline dropdown (visible when open)
    if (consolePickerOpen) {
      html += `<div id="fsvr-player-dropdown" style="
        position:absolute;left:10px;right:10px;top:100%;
        background:#12121e;border:1px solid rgba(255,255,255,0.15);
        border-radius:8px;z-index:100;max-height:160px;overflow-y:auto;
        box-shadow:0 8px 24px rgba(0,0,0,0.6);">`;
      html += `<div data-pick="" style="padding:7px 10px;font-size:12px;color:#555;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.05);">— none —</div>`;
      players.forEach(p => {
        const sel = p.Username === cpName;
        html += `<div data-pick="${p.Username}" style="
          display:flex;align-items:center;gap:8px;
          padding:6px 10px;font-size:12px;cursor:pointer;
          background:${sel?'rgba(99,102,241,0.18)':'transparent'};
          color:${sel?'#a5b4fc':'#ccc'};
          border-bottom:1px solid rgba(255,255,255,0.04);">
          <canvas data-dpface="${p.SkinId||''}" width="8" height="8"
            style="width:18px;height:18px;image-rendering:pixelated;border-radius:3px;background:#2a2a3e;flex-shrink:0;"></canvas>
          ${p.Username}
        </div>`;
      });
      html += `</div>`;
    }

    return html;
  }

  function refreshConsolePlayerChip() {
    const header = document.getElementById('fsvr-console-header');
    if (!header) return;
    header.innerHTML = buildPlayerChipHtml(consolePlayer);
    bindChipEvents();
    loadChipFaces();
    // re-colour buttons
    const cpName = consolePlayer;
    document.querySelectorAll('.fsvr-cmd-btn').forEach(btn => {
      const gi = parseInt(btn.dataset.gi);
      const ci = parseInt(btn.dataset.ci);
      const cmd = CMD_GROUPS[gi].cmds[ci];
      const needsP = !!(cmd.needsUser || cmd.needsSkin);
      const disabled = needsP && !cpName;
      btn.style.color = disabled ? '#3a3a4a' : '#b0b0c8';
      btn.style.cursor = disabled ? 'default' : 'pointer';
    });
  }

  function bindConsoleEvents() {
    bindChipEvents();
    loadChipFaces();

    // command buttons
    document.querySelectorAll('.fsvr-cmd-btn').forEach(btn => {
      const gi = parseInt(btn.dataset.gi);
      const ci = parseInt(btn.dataset.ci);
      const cmd = CMD_GROUPS[gi].cmds[ci];
      const needsP = !!(cmd.needsUser || cmd.needsSkin);
      if (needsP && !consolePlayer) return;
      btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(99,102,241,0.08)'; btn.style.color = '#e8e8f0'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent'; btn.style.color = '#b0b0c8'; });
      btn.addEventListener('click', () => runCmd(cmd.code, !!cmd.needsUser, !!cmd.needsSkin));
    });

    // do-all buttons
    document.querySelectorAll('[data-do-all]').forEach(btn => {
      btn.addEventListener('click', () => runAllInGroup(parseInt(btn.dataset.doAll)));
    });

    // spam buttons
    document.querySelectorAll('[data-spam-gi]').forEach(btn => {
      btn.addEventListener('click', () => toggleSpamGroup(parseInt(btn.dataset.spamGi)));
    });
  }

  function bindChipEvents() {
    const chip = document.getElementById('fsvr-player-chip');
    if (chip) {
      chip.addEventListener('click', () => {
        consolePickerOpen = !consolePickerOpen;
        refreshConsolePlayerChip();
      });
    }
    // dropdown picks
    document.querySelectorAll('[data-pick]').forEach(row => {
      row.addEventListener('mouseenter', () => row.style.background = 'rgba(255,255,255,0.06)');
      row.addEventListener('mouseleave', () => {
        const sel = row.dataset.pick === consolePlayer;
        row.style.background = sel ? 'rgba(99,102,241,0.18)' : 'transparent';
      });
      row.addEventListener('click', e => {
        e.stopPropagation();
        consolePlayer = row.dataset.pick || null;
        consolePickerOpen = false;
        refreshConsolePlayerChip();
      });
    });
  }

  function loadChipFaces() {
    // main chip face
    const cpFace = document.getElementById('fsvr-cp-face');
    if (cpFace && cpFace.dataset.skinid) {
      loadFaceCrop(cpFace.dataset.skinid, url => {
        if (!url) return;
        const c = document.getElementById('fsvr-cp-face');
        if (!c) return;
        const img = new Image();
        img.onload = () => { const ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0, 8, 8); };
        img.src = url;
      });
    }
    // dropdown faces
    document.querySelectorAll('[data-dpface]').forEach(canvas => {
      const skinId = canvas.dataset.dpface;
      if (!skinId) return;
      loadFaceCrop(skinId, url => {
        if (!url) return;
        const img = new Image();
        img.onload = () => { const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(img, 0, 0, 8, 8); };
        img.src = url;
      });
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function statCard(label, value) {
    return `<div style="background:rgba(255,255,255,0.06);border-radius:6px;padding:8px;text-align:center;">
      <div style="font-size:10px;color:#666;margin-bottom:3px;">${label}</div>
      <div style="font-size:13px;font-weight:600;color:#e8e8f0;">${value}</div>
    </div>`;
  }
  function actionBtn(color) {
    return `width:100%;padding:10px 14px;border-radius:8px;background:${color}18;color:${color};
    font-size:13px;font-weight:600;cursor:pointer;border:1px solid ${color}40;text-align:left;transition:opacity 0.15s;`;
  }
  function pillBtn(color) {
    return `background:${color}20;border:1px solid ${color}50;border-radius:6px;padding:5px 10px;
    color:${color};font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;`;
  }
  function groupActionBtn(color) {
    return `background:${color}15;border:1px solid ${color}50;border-radius:5px;padding:3px 7px;
    color:${color};font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;`;
  }

  // ── Panel show/hide ────────────────────────────────────────────────────────
  function showPanel()   { const p = document.getElementById('fsvr-menu'); if (p) p.style.display = 'flex'; visible = true; }
  function hidePanel()   { const p = document.getElementById('fsvr-menu'); if (p) p.style.display = 'none';  visible = false; }
  function togglePanel() { visible ? hidePanel() : showPanel(); }

  function setMinimised(v) {
    minimised = v;
    const body   = document.getElementById('fsvr-body');
    const tabbar = document.getElementById('fsvr-tabbar');
    const btn    = document.getElementById('fsvr-min');
    const menu   = document.getElementById('fsvr-menu');
    if (body)   body.style.display   = v ? 'none' : 'flex';
    if (tabbar) tabbar.style.display = v ? 'none' : 'flex';
    if (btn)    btn.textContent      = v ? '+' : '−';
    if (menu)   menu.style.maxHeight = v ? 'none' : '600px';
  }

  // ── Build panel ────────────────────────────────────────────────────────────
  function buildPanel() {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes fsvr-pulse{0%,100%{opacity:1}50%{opacity:.35}}
      #fsvr-list::-webkit-scrollbar,#fsvr-body::-webkit-scrollbar,#fsvr-cmd-scroll::-webkit-scrollbar,#fsvr-output::-webkit-scrollbar,#fsvr-player-dropdown::-webkit-scrollbar{width:3px}
      #fsvr-list::-webkit-scrollbar-thumb,#fsvr-body::-webkit-scrollbar-thumb,#fsvr-cmd-scroll::-webkit-scrollbar-thumb,#fsvr-output::-webkit-scrollbar-thumb,#fsvr-player-dropdown::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:3px}
      #fsvr-list::-webkit-scrollbar-track,#fsvr-body::-webkit-scrollbar-track,#fsvr-cmd-scroll::-webkit-scrollbar-track,#fsvr-output::-webkit-scrollbar-track,#fsvr-player-dropdown::-webkit-scrollbar-track{background:transparent}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'fsvr-menu';
    panel.style.cssText = `
      position:fixed;top:80px;right:16px;width:330px;
      background:#0f0f18;border:1px solid rgba(255,255,255,0.11);
      border-radius:14px;color:#e8e8f0;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      z-index:9999;display:flex;flex-direction:column;max-height:600px;
      box-shadow:0 12px 40px rgba(0,0,0,0.7);user-select:none;overflow:hidden;
    `;

    panel.innerHTML = `
      <div id="fsvr-titlebar" style="display:flex;align-items:center;padding:10px 12px;gap:8px;
        border-bottom:1px solid rgba(255,255,255,0.08);cursor:grab;flex-shrink:0;">
        <div style="width:8px;height:8px;border-radius:50%;background:#22c55e;animation:fsvr-pulse 1.5s infinite;flex-shrink:0;"></div>
        <span style="font-weight:700;font-size:14px;flex:1;letter-spacing:0.3px;">FactionSVR</span>
        <span id="fsvr-count" style="font-size:11px;color:#555;"></span>
        <button id="fsvr-min"   title="Minimise" style="${tbBtn()}">−</button>
        <button id="fsvr-close" title="Close (Ctrl+Q)" style="${tbBtn()}">✕</button>
      </div>
      <div id="fsvr-tabbar" style="display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;"></div>
      <div id="fsvr-body" style="display:flex;flex-direction:column;overflow:hidden;flex:1;"></div>
    `;

    const toastEl = document.createElement('div');
    toastEl.id = 'fsvr-toast';
    toastEl.style.cssText = `
      position:fixed;bottom:22px;right:20px;
      background:rgba(15,15,24,0.96);border:1px solid rgba(255,255,255,0.13);
      border-radius:9px;padding:9px 15px;font-size:13px;color:#e8e8f0;
      z-index:10000;opacity:0;transition:opacity .3s;pointer-events:none;
      font-family:-apple-system,sans-serif;max-width:260px;
    `;

    document.body.appendChild(panel);
    document.body.appendChild(toastEl);

    document.getElementById('fsvr-close').onclick = hidePanel;
    document.getElementById('fsvr-min').onclick   = () => setMinimised(!minimised);

    makeDraggable(panel, document.getElementById('fsvr-titlebar'));
    render();
  }

  function tbBtn() {
    return 'background:none;border:none;color:#666;font-size:15px;cursor:pointer;padding:1px 4px;line-height:1;';
  }

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy;
    handle.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
      handle.style.cursor = 'grabbing';
      el.style.right = 'auto'; el.style.bottom = 'auto';
      el.style.left = ox + 'px'; el.style.top = oy + 'px';
      const move = e => { el.style.left = (ox+e.clientX-sx)+'px'; el.style.top = (oy+e.clientY-sy)+'px'; };
      const up   = () => { handle.style.cursor='grab'; document.removeEventListener('mousemove',move); document.removeEventListener('mouseup',up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup',   up);
    });
  }

  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'q') { e.preventDefault(); togglePanel(); }
  });

  function init() {
    buildPanel();
    fetchPlayers();
    setInterval(fetchPlayers, REFRESH_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
