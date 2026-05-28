(function () {
  'use strict';

  const REFRESH_MS  = 2000;
  const PLAYERS_API = '/api/map/players';
  const SKIN_API    = id => `/api/game/skin/image/${id}`;
  const CHUNK_API   = (y, x, z) => `/api/map/chunk/${y}/${x}/${z}?t=${Date.now()}`;
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
  let visible       = true;
  let minimised     = false;

  let webhookUrl    = localStorage.getItem('fsvr-webhook-url') || '';
  let lastMessageId = localStorage.getItem('fsvr-last-msg-id') || '';

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
      skinCache[skinId] = c.toToDataURL ? c.toDataURL() : null;
      try {
        skinCache[skinId] = c.toDataURL();
        const fc = document.createElement('canvas');
        fc.width = img.naturalWidth || 64;
        fc.height = img.naturalHeight || 64;
        fc.getContext('2d').drawImage(img, 0, 0);
        fullSkinCache[skinId] = fc.toDataURL();
      } catch(e) {}
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

  // ── Webhook Delivery ───────────────────────────────────────────────────────
  async function sendWebhookPayload(payload, preferEdit = false) {
    if (!webhookUrl) {
      toast('❌ No Webhook URL set!');
      return;
    }
    try {
      let url = webhookUrl;
      let method = 'POST';
      if (preferEdit && lastMessageId) {
        url = `${webhookUrl}/messages/${lastMessageId}`;
        method = 'PATCH';
      } else {
        url = `${webhookUrl}?wait=true`;
      }
      const response = await fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        if (method === 'POST') {
          const data = await response.json();
          if (data && data.id) {
            lastMessageId = data.id;
            localStorage.setItem('fsvr-last-msg-id', lastMessageId);
          }
        }
        toast(method === 'PATCH' ? '🔄 Webhook Edited/Updated!' : '🚀 New Webhook Dispatched!');
      } else {
        if (method === 'PATCH') {
          lastMessageId = '';
          localStorage.removeItem('fsvr-last-msg-id');
          await sendWebhookPayload(payload, false);
        } else {
          toast(`⚠️ Webhook rejected: ${response.status}`);
        }
      }
    } catch (e) {
      toast('❌ Network error processing webhook request');
    }
  }

  function doWebhookSingle(p) {
    const pos = getPos(p);
    const skinUrl = p.SkinId ? window.location.origin + SKIN_API(p.SkinId) : 'None';
    const playerUid = p.id || '—';
    const payload = {
      embeds: [{
        title: `👤 Player Report: ${p.Username}`,
        color: 6513919,
        fields: [
          { name: '🆔 System ID',     value: `\`${playerUid}\``,                              inline: true },
          { name: '📍 Coordinates',   value: `X: ${pos.x} | Y: ${pos.y} | Z: ${pos.z}`,      inline: true },
          { name: '⏳ Playtime',       value: p.PlayTime || 'Unknown',                          inline: true },
          { name: '⚡ Ping',           value: `${Math.round(p.ping || 0)} ms`,                 inline: true },
          { name: '🖼️ Skin URL',      value: skinUrl,                                           inline: false }
        ],
        timestamp: new Date().toISOString()
      }]
    };
    sendWebhookPayload(payload, false);
  }

  function doWebhookAll() {
    if (!players.length) return toast('❌ No player metrics available to send');
    let description = '';
    players.forEach(p => {
      const pos = getPos(p);
      const skinUrl = p.SkinId ? window.location.origin + SKIN_API(p.SkinId) : 'None';
      const playerUid = p.id || '—';
      description += `\`[ID: ${playerUid}]\` **${p.Username}** • XYZ: \`${pos.x}, ${pos.y}, ${pos.z}\` • Ping: \`${Math.round(p.ping||0)}ms\` • [Skin](${skinUrl})\n`;
    });
    const payload = {
      embeds: [{
        title: `🌐 Server Dump — Live Roster Status (${players.length} Online)`,
        color: 2278750,
        description: description.substring(0, 4000),
        footer: { text: lastMessageId ? "Auto-updating continuous message board" : "Initial status broadcast" },
        timestamp: new Date().toISOString()
      }]
    };
    sendWebhookPayload(payload, true);
  }

  // ── Chunk Webhook ──────────────────────────────────────────────────────────
  async function doWebhookChunk() {
    if (!webhookUrl) return toast('❌ No Webhook URL set!');

    const rx = Math.floor(Math.random() * 41) - 20;
    const rz = Math.floor(Math.random() * 41) - 20;
    const ry = 0;
    const url = window.location.origin + CHUNK_API(ry, rx, rz);

    toast(`🗺️ Fetching chunk (${rx}, ${ry}, ${rz})…`);

    try {
      const res = await fetch(url);
      if (!res.ok) return toast(`⚠️ Chunk fetch failed: ${res.status}`);

      const blob = await res.blob();

      const formData = new FormData();
      const embedPayload = {
        embeds: [{
          title: `🗺️ Random Map Chunk — (${rx}, ${ry}, ${rz})`,
          color: 1752220,
          description: `Chunk coordinates: **X: ${rx} · Y: ${ry} · Z: ${rz}**\nCache token: \`${Date.now()}\``,
          image: { url: 'attachment://chunk.png' },
          footer: { text: `FactionSVR Map · ${new Date().toLocaleString()}` },
          timestamp: new Date().toISOString()
        }]
      };
      formData.append('payload_json', JSON.stringify(embedPayload));
      formData.append('files[0]', blob, 'chunk.png');

      // No Content-Type header — browser sets multipart boundary automatically
      const response = await fetch(`${webhookUrl}?wait=true`, {
        method: 'POST',
        body: formData
      });

      if (response.ok) {
        toast(`✅ Chunk (${rx}, ${ry}, ${rz}) sent!`);
      } else {
        const errText = await response.text();
        console.warn('[fsvr] chunk webhook error:', errText);
        toast(`⚠️ Webhook rejected: ${response.status}`);
      }
    } catch (e) {
      console.error('[fsvr] chunk webhook exception:', e);
      toast('❌ Error sending chunk to webhook');
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  function doGoto(p) {
    if (typeof map === 'undefined') return toast('❌ Map interface layer not found');
    const pos = p.Pose?.Head?.Position;
    if (!pos) return toast('No coordinates available for ' + p.Username);
    map.flyTo(gameToLeaflet(pos[0], pos[2]), BASE_ZOOM, { duration: 0.8 });
    toast('📍 Adjusting map focus onto: ' + p.Username);
  }

  function doDownloadSkin(p) {
    if (!p.SkinId) return toast('No skin asset signature for ' + p.Username);
    loadFaceCrop(p.SkinId, () => {
      const full = fullSkinCache[p.SkinId];
      if (!full) return toast('Asset generation pending — re-attempt shortly');
      const a = document.createElement('a');
      a.href = full;
      a.download = p.Username + '_skin.png';
      a.click();
      toast('⬇️ Localized file: ' + p.Username);
    });
  }

  function doCopySkinUrl(p) {
    if (!p.SkinId) return toast('No skin configuration present for ' + p.Username);
    const url = window.location.origin + SKIN_API(p.SkinId);
    navigator.clipboard.writeText(url).then(() => toast('📋 Copied skin endpoint path for ' + p.Username));
  }

  function doDownloadAll() {
    const ws = players.filter(p => p.SkinId);
    if (!ws.length) return toast('No skins accessible to process');
    if (!window.JSZip) {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload = () => doZip(ws);
      document.head.appendChild(s);
    } else {
      doZip(ws);
    }
  }

  function doZip(ws) {
    const zip = new window.JSZip();
    let done = 0;
    toast('📦 Assembling structural package file for ' + ws.length + ' assets…');
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
            toast('✅ Archive generated: ' + ws.length + ' skin models');
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
          selectedId = null;
          view = 'list';
        }
        render();
      }
    } catch (e) {}
  }

  // ── Sort/filter ────────────────────────────────────────────────────────────
  function getSorted() {
    let list = players.filter(p =>
      !searchQuery || p.Username.toLowerCase().includes(searchQuery)
    );
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
    if (view === 'list')   renderList();
    if (view === 'detail') renderDetail();
  }

  function renderCount() {
    const el = document.getElementById('fsvr-count');
    if (el) el.textContent = players.length + ' active';
  }

  // ── LIST VIEW ──────────────────────────────────────────────────────────────
  function renderList() {
    const body = document.getElementById('fsvr-body');
    if (!body) return;
    const list = getSorted();

    let html = '';

    // Webhook config zone
    html += `<div style="padding:6px 12px;display:flex;flex-direction:column;gap:4px;border-bottom:1px solid rgba(255,255,255,0.07);background:rgba(0,0,0,0.2);">`;
    html += `<div style="display:flex;justify-content:space-between;align-items:center;">`;
    html += `<label style="font-size:10px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">Discord Webhook Gateway</label>`;
    if (lastMessageId) {
      html += `<span id="fsvr-clear-msg" style="font-size:9px;color:#f43f5e;cursor:pointer;font-weight:bold;">[Reset Board Message]</span>`;
    }
    html += `</div>`;
    html += `<input id="fsvr-webhook-input" type="password" placeholder="Insert operational webhook secure token path..." value="${webhookUrl}"
      style="width:100%;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:4px 8px;color:#a5b4fc;font-size:11px;outline:none;box-sizing:border-box;">`;
    html += `</div>`;

    // Toolbar
    html += `<div style="padding:8px 12px;display:flex;gap:6px;flex-direction:column;border-bottom:1px solid rgba(255,255,255,0.07);flex-shrink:0;">`;
    html += `<input id="fsvr-search-input" type="text" placeholder="🔍 Filter identity database…" value="${searchQuery}"
      style="width:100%;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:6px 10px;color:#e8e8f0;font-size:13px;outline:none;box-sizing:border-box;">`;
    html += `<div style="display:flex;gap:6px;flex-wrap:wrap;">`;
    html += `<select id="fsvr-sort-sel" style="flex:1;min-width:70px;background:rgba(255,255,255,0.07);border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 8px;color:#e8e8f0;font-size:12px;outline:none;">
      <option value="playtime" ${sortKey==='playtime'?'selected':''}>Playtime ↓</option>
      <option value="ping"     ${sortKey==='ping'?'selected':''}>Ping ↑</option>
      <option value="name"     ${sortKey==='name'?'selected':''}>Name A–Z</option>
      <option value="x"        ${sortKey==='x'?'selected':''}>X axis</option>
      <option value="z"        ${sortKey==='z'?'selected':''}>Z axis</option>
    </select>`;
    html += `<button id="fsvr-dl-all-btn"  style="${pillBtn('#6366f1')}">⬇️ Pack Skins</button>`;
    html += `<button id="fsvr-hook-all-btn" style="${pillBtn('#06b6d4')}">${lastMessageId ? '🔄 Live Update' : '📢 Hook All'}</button>`;
    html += `<button id="fsvr-chunk-btn"   style="${pillBtn('#f59e0b')}">🗺️ Chunk Test</button>`;
    html += `</div></div>`;

    // Player list
    html += `<ul id="fsvr-list" style="list-style:none;margin:0;padding:0;overflow-y:auto;flex:1;">`;
    if (!list.length) {
      html += `<li style="padding:20px;text-align:center;color:#666;font-size:13px;">No active index found</li>`;
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
          border-left:3px solid ${sel ? '#6366f1' : 'transparent'};
        ">
          <canvas data-skinid="${p.SkinId||''}" class="fsvr-face"
            width="8" height="8"
            style="width:26px;height:26px;image-rendering:pixelated;border-radius:4px;background:#2a2a3e;flex-shrink:0;"></canvas>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${sel?'#a5b4fc':'#e8e8f0'};">${p.Username} <span style="font-size:10px;color:#555;font-weight:normal;">#${p.id||'—'}</span></div>
            <div style="font-size:11px;color:#888;margin-top:1px;">X:${pos.x} Z:${pos.z} · ${p.PlayTime||'—'}</div>
          </div>
          <div title="${Math.round(p.ping||0)}ms" style="width:8px;height:8px;border-radius:50%;background:${pc};flex-shrink:0;"></div>
          <span style="font-size:10px;color:#555;">›</span>
        </li>`;
      });
    }
    html += `</ul>`;

    body.innerHTML = html;

    // Wire up webhook input
    const whi = document.getElementById('fsvr-webhook-input');
    if (whi) whi.addEventListener('input', e => {
      webhookUrl = e.target.value.trim();
      localStorage.setItem('fsvr-webhook-url', webhookUrl);
    });

    const clr = document.getElementById('fsvr-clear-msg');
    if (clr) clr.addEventListener('click', () => {
      lastMessageId = '';
      localStorage.removeItem('fsvr-last-msg-id');
      toast('🗑️ Tracking ID purged! Next dump creates a new message.');
      renderList();
    });

    const si = document.getElementById('fsvr-search-input');
    if (si) si.addEventListener('input', e => { searchQuery = e.target.value.toLowerCase().trim(); renderList(); });

    const ss = document.getElementById('fsvr-sort-sel');
    if (ss) ss.addEventListener('change', e => { sortKey = e.target.value; renderList(); });

    const da = document.getElementById('fsvr-dl-all-btn');
    if (da) da.addEventListener('click', doDownloadAll);

    const ha = document.getElementById('fsvr-hook-all-btn');
    if (ha) ha.addEventListener('click', doWebhookAll);

    const ch = document.getElementById('fsvr-chunk-btn');
    if (ch) ch.addEventListener('click', doWebhookChunk);

    // Row hover + click
    body.querySelectorAll('.fsvr-row').forEach(row => {
      row.addEventListener('mouseenter', () => { if (selectedId !== row.dataset.pid) row.style.background = 'rgba(255,255,255,0.05)'; });
      row.addEventListener('mouseleave', () => { if (selectedId !== row.dataset.pid) row.style.background = 'transparent'; });
      row.addEventListener('click', () => {
        selectedId = row.dataset.pid;
        view = 'detail';
        render();
      });
    });

    // Skin face crops
    body.querySelectorAll('.fsvr-face').forEach(canvas => {
      const skinId = canvas.dataset.skinid;
      if (!skinId) return;
      loadFaceCrop(skinId, url => {
        if (!url) return;
        const img = new Image();
        img.onload = () => {
          const ctx = canvas.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, 0, 0, 8, 8);
        };
        img.src = url;
      });
    });
  }

  // ── DETAIL VIEW ────────────────────────────────────────────────────────────
  function renderDetail() {
    const body = document.getElementById('fsvr-body');
    const p    = getSelected();
    if (!p) { view = 'list'; return renderList(); }
    const pos = getPos(p);
    const pc  = pingColor(p.ping || 0);
    const playerUid = p.id || '—';

    body.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;">
        <button id="fsvr-back" style="background:none;border:none;color:#aaa;font-size:18px;cursor:pointer;line-height:1;padding:0 4px;">←</button>
        <span style="font-weight:700;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Viewing: ${p.Username}</span>
      </div>

      <div style="overflow-y:auto;flex:1;padding:14px 14px 6px;">

        <div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
          <canvas id="fsvr-big-face" width="64" height="64"
            style="width:72px;height:72px;image-rendering:pixelated;border-radius:8px;background:#2a2a3e;border:2px solid rgba(255,255,255,0.1);flex-shrink:0;"></canvas>
          <div>
            <div style="font-size:18px;font-weight:700;color:#e8e8f0;">${p.Username}</div>
            <div style="font-size:12px;color:#6366f1;font-weight:bold;margin-top:3px;">ID Parameter: ${playerUid}</div>
            <div style="font-size:12px;margin-top:4px;">
              <span style="color:${pc};font-weight:600;">${Math.round(p.ping||0)} ms</span>
              <span style="color:#555;"> · </span>
              <span style="color:#aaa;">${p.PlayTime || '—'}</span>
            </div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px;margin-bottom:14px;">
          ${statCard('Axis X', pos.x)}
          ${statCard('Axis Y', pos.y)}
          ${statCard('Axis Z', pos.z)}
        </div>

        <div style="font-size:11px;color:#444;word-break:break-all;margin-bottom:14px;line-height:1.5;">
          ${p.SkinId ? 'Skin Signature Hash: ' + p.SkinId : '<span style="color:#555">No skin structural profile</span>'}
        </div>

        <div style="display:flex;flex-direction:column;gap:7px;padding-bottom:14px;">
          <button data-action="goto"    style="${actionBtn('#3b82f6')}">📍  Go to player on map</button>
          <button data-action="hookone" style="${actionBtn('#06b6d4')}">📢  Send Info to Webhook (With ID)</button>
          <button data-action="chunk"   style="${actionBtn('#f59e0b')}">🗺️  Send Random Map Chunk to Webhook</button>
          ${p.SkinId ? `<button data-action="skin"    style="${actionBtn('#22c55e')}">⬇️  Download skin PNG</button>` : ''}
          ${p.SkinId ? `<button data-action="copyurl" style="${actionBtn('#8b5cf6')}">📋  Copy skin URL</button>` : ''}
          ${p.SkinId ? `<button data-action="skinall" style="${actionBtn('#f59e0b')}">📦  Download all online skins</button>` : ''}
        </div>

      </div>
    `;

    document.getElementById('fsvr-back').onclick = () => { view = 'list'; render(); };

    body.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('mouseenter', () => btn.style.opacity = '0.8');
      btn.addEventListener('mouseleave', () => btn.style.opacity = '1');
      btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'goto')    doGoto(p);
        if (action === 'hookone') doWebhookSingle(p);
        if (action === 'chunk')   doWebhookChunk();
        if (action === 'skin')    doDownloadSkin(p);
        if (action === 'copyurl') doCopySkinUrl(p);
        if (action === 'skinall') doDownloadAll();
      });
    });

    if (p.SkinId) {
      loadFaceCrop(p.SkinId, () => {
        const full = fullSkinCache[p.SkinId];
        if (!full) return;
        const c = document.getElementById('fsvr-big-face');
        if (!c) return;
        const img = new Image();
        img.onload = () => {
          const ctx = c.getContext('2d');
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(img, 0, 0, 64, 64);
        };
        img.src = full;
      });
    }
  }

  function statCard(label, value) {
    return `<div style="background:rgba(255,255,255,0.06);border-radius:6px;padding:8px;text-align:center;">
      <div style="font-size:10px;color:#666;margin-bottom:3px;">${label}</div>
      <div style="font-size:13px;font-weight:600;color:#e8e8f0;">${value}</div>
    </div>`;
  }

  function actionBtn(color) {
    return `width:100%;padding:10px 14px;border-radius:8px;background:${color}18;color:${color};
    font-size:13px;font-weight:600;cursor:pointer;border:1px solid ${color}40;text-align:left;
    transition:opacity 0.15s;`;
  }

  function pillBtn(color) {
    return `background:${color}20;border:1px solid ${color}50;border-radius:6px;padding:5px 10px;
    color:${color};font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;`;
  }

  // ── Panel show/hide ────────────────────────────────────────────────────────
  function showPanel()   { const p = document.getElementById('fsvr-menu'); if (p) p.style.display = 'flex'; visible = true; }
  function hidePanel()   { const p = document.getElementById('fsvr-menu'); if (p) p.style.display = 'none';  visible = false; }
  function togglePanel() { visible ? hidePanel() : showPanel(); }

  function setMinimised(v) {
    minimised = v;
    const body = document.getElementById('fsvr-body');
    const btn  = document.getElementById('fsvr-min');
    const menu = document.getElementById('fsvr-menu');
    if (body) body.style.display = v ? 'none' : 'flex';
    if (btn)  btn.textContent    = v ? '+' : '−';
    if (menu) menu.style.maxHeight = v ? 'none' : '560px';
  }

  // ── Build panel ────────────────────────────────────────────────────────────
  function buildPanel() {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes fsvr-pulse{0%,100%{opacity:1}50%{opacity:.35}}
      #fsvr-list::-webkit-scrollbar,#fsvr-body::-webkit-scrollbar{width:4px}
      #fsvr-list::-webkit-scrollbar-thumb,#fsvr-body::-webkit-scrollbar-thumb{background:rgba(255,255,255,.13);border-radius:3px}
      #fsvr-list::-webkit-scrollbar-track,#fsvr-body::-webkit-scrollbar-track{background:transparent}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'fsvr-menu';
    panel.style.cssText = `
      position:fixed;top:80px;right:16px;width:310px;
      background:rgba(15,15,24,0.97);border:1px solid rgba(255,255,255,0.11);
      border-radius:14px;color:#e8e8f0;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      z-index:9999;display:flex;flex-direction:column;max-height:590px;
      box-shadow:0 12px 40px rgba(0,0,0,0.7);user-select:none;overflow:hidden;
    `;

    panel.innerHTML = `
      <div id="fsvr-titlebar" style="display:flex;align-items:center;padding:10px 12px;gap:8px;
        border-bottom:1px solid rgba(255,255,255,0.08);cursor:grab;flex-shrink:0;">
        <div style="width:8px;height:8px;border-radius:50%;background:#22c55e;animation:fsvr-pulse 1.5s infinite;flex-shrink:0;"></div>
        <span style="font-weight:700;font-size:14px;flex:1;letter-spacing:0.3px;">FactionSVR Dashboard</span>
        <span id="fsvr-count" style="font-size:11px;color:#555;"></span>
        <button id="fsvr-min"   title="Minimise" style="${tbBtn()}">−</button>
        <button id="fsvr-close" title="Close (Ctrl+Q)" style="${tbBtn()}">✕</button>
      </div>
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

  // ── Drag ───────────────────────────────────────────────────────────────────
  function makeDraggable(el, handle) {
    let sx, sy, ox, oy;
    handle.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
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

  // ── Keyboard ───────────────────────────────────────────────────────────────
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.key === 'q') { e.preventDefault(); togglePanel(); }
  });

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    buildPanel();
    fetchPlayers();
    setInterval(fetchPlayers, REFRESH_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
