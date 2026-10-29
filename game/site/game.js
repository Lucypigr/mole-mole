'use strict';
// 賽爾號 單機版 — standalone browser game built on SeerAPI data (see game/tools/build_data.py).

const $ = (s, el = document) => el.querySelector(s);
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const STAT_NAMES = ['體力', '攻擊', '防禦', '特攻', '特防', '速度'];
const STAGE_NAMES = ['攻擊', '防禦', '特攻', '特防', '速度', '命中'];
const SAVE_KEY = 'seer-offline-save-v1';
const STARTERS = [1, 4, 7];

let D = null;          // packed game data
let S = null;          // save state
let battle = null;     // current battle

// ---------------------------------------------------------------- data helpers
const pet = id => D.pets[id];
const skill = id => D.skills[id];
const comboName = id => D.combos[id] ? D.combos[id].name : '?';
const bodyImg = id => `img/body/${id}.webp`;
const headImg = id => `img/head/${id}.webp`;

function typeMult(skillCombo, defCombo) {
  const atk = D.combos[skillCombo].t, def = D.combos[defCombo].t;
  let total = 0;
  for (const a of atk) {
    let m = 1;
    for (const d of def) m *= (D.types[a].rel[d] ?? 1);
    total += m;
  }
  return total / atk.length;
}

function expForLevel(lv) { return Math.floor(lv * lv * lv * 0.8); }

function calcStats(m) {
  const p = pet(m.id), n = D.natures[m.nature];
  return p.base.map((b, i) => {
    const raw = Math.floor((b * 2 + m.iv + Math.floor(m.ev[i] / 4)) * m.lv / 100);
    if (i === 0) return raw + m.lv + 10;
    return Math.floor((raw + 5) * (1 + (n.m[i] || 0) / 100));
  });
}

function skillsAt(id, lv) { return pet(id).learn.filter(([l]) => l <= lv).map(([, s]) => s); }

function makeMon(id, lv) {
  const m = { id, lv, exp: expForLevel(lv), iv: rnd(0, 31), ev: [0, 0, 0, 0, 0, 0],
    nature: rnd(0, D.natures.length - 1), skills: [] };
  const known = [...new Set(skillsAt(id, lv))].slice(-4);
  m.skills = known.map(s => ({ id: s, pp: skill(s).pp }));
  m.stats = calcStats(m);
  m.hp = m.stats[0];
  return m;
}

function refresh(m) {
  const old = m.stats ? m.stats[0] : 0;
  m.stats = calcStats(m);
  m.hp = clamp(m.hp + (m.stats[0] - old), 0, m.stats[0]);
}

function healAll() {
  for (const m of S.party) { m.hp = m.stats[0]; m.skills.forEach(s => s.pp = skill(s.id).pp); }
}

// ---------------------------------------------------------------- zones
const ZONES = [
  { key: 'base', name: '賽爾號 太空站', safe: true },
  { key: 'z1', name: '克洛斯星', types: [1, 8, 4, 5], lv: [2, 6], boss: 12, sky: '#4f8f3a', ground: '#6fb24d', grass: '#3f7f2a' },
  { key: 'z2', name: '海洋星', types: [2, 9], lv: [10, 16], boss: 20, sky: '#245c8f', ground: '#d9c58a', grass: '#3a8fb0' },
  { key: 'z3', name: '火山星', types: [3, 7], lv: [18, 24], boss: 28, sky: '#5a2018', ground: '#8a5a3a', grass: '#b34a1a' },
  { key: 'z4', name: '雲霄星', types: [4, 5, 12], lv: [26, 32], boss: 36, sky: '#7fa8d8', ground: '#e4ecf5', grass: '#a8c8f0' },
  { key: 'z5', name: '赫爾卡星', types: [6, 10, 11], lv: [34, 42], boss: 46, sky: '#3a3f4f', ground: '#7f8899', grass: '#5a6a8a' },
  { key: 'z6', name: '暗影星域', types: [13, 14, 15, 16], lv: [45, 55], boss: 60, sky: '#1a1030', ground: '#3a2a5a', grass: '#5a2a7a' },
];

const MAP_W = 20, MAP_H = 14, TILE = 32;
// # wall, ~ water/lava, " encounter grass, . floor, T tree/rock
const PLANET_MAP = [
  '####################',
  '#..""""""...TT"""".#',
  '#..""""""....T"""".#',
  '#....""".......""..#',
  '#TT.......~~~.....T#',
  '#"""".....~~~..""""#',
  '#"""""....~~~."""""#',
  '#""""".........""""#',
  '#...........TT.....#',
  '#.""""..T.......""T#',
  '#.""""""......"""".#',
  '#..""""....""""""..#',
  '#..................#',
  '####################',
];
const BASE_MAP = [
  '####################',
  '#..................#',
  '#.====.......====..#',
  '#.====.......====..#',
  '#..................#',
  '#..................#',
  '#......======......#',
  '#......======......#',
  '#..................#',
  '#..................#',
  '#.====........====.#',
  '#.====........====.#',
  '#..................#',
  '####################',
];

// NPCs per zone: x,y,kind
function zoneNpcs(zi) {
  if (zi === 0) return [
    { x: 3, y: 5, kind: 'heal', label: '醫療艙' },
    { x: 15, y: 5, kind: 'shop', label: '補給站' },
    { x: 3, y: 9, kind: 'storage', label: '精靈倉庫' },
    { x: 15, y: 9, kind: 'teleport', label: '傳送艙' },
    { x: 9, y: 4, kind: 'guide', label: '船長' },
  ];
  return [
    { x: 1, y: 12, kind: 'teleport', label: '返回飛船' },
    { x: 18, y: 12, kind: 'boss', label: '星球守護者' },
    { x: 9, y: 12, kind: 'heal', label: '補給點' },
  ];
}

// wild pool for a zone
const poolCache = {};
function zonePool(zi) {
  if (poolCache[zi]) return poolCache[zi];
  const z = ZONES[zi];
  const prevEvo = {};
  for (const [id, p] of Object.entries(D.pets)) if (p.evo) prevEvo[p.evo[1]] = p.evo[0];
  const fits = id => D.combos[pet(id).type].t.some(t => z.types.includes(t));
  const ok = [];
  for (const [k, p] of Object.entries(D.pets)) {
    const id = +k;
    if (p.rare || p.anim || p.catch <= 0 || !fits(id)) continue;
    const minLv = prevEvo[id] || 0;
    if (minLv > z.lv[1]) continue;
    if (p.evo && p.evo[0] < z.lv[0] - 2) continue;
    if (!p.evo && !minLv && p.base.reduce((a, b) => a + b) > 480) continue;
    ok.push(id);
  }
  if (ok.length < 5) {
    // thin zone: also allow any ordinary pet of the zone's types regardless of evolution stage
    for (const [k, p] of Object.entries(D.pets)) {
      const id = +k;
      if (!ok.includes(id) && !p.rare && !p.anim && p.catch > 0 && fits(id) && p.base.reduce((a, b) => a + b) <= 520) ok.push(id);
    }
  }
  poolCache[zi] = ok.length ? ok : Object.keys(D.pets).map(Number).filter(id => fits(id) && pet(id).first);
  return poolCache[zi];
}

// Animated pets of the zone's types: guardian aces and rare wild encounters.
function animPool(zi) {
  const z = ZONES[zi];
  const all = Object.keys(D.pets).map(Number).filter(id => pet(id).anim);
  const fit = all.filter(id => D.combos[pet(id).type].t.some(t => z.types.includes(t)));
  return fit.length ? fit : all;
}

function bossTeam(zi) {
  const z = ZONES[zi];
  const cands = Object.entries(D.pets).map(([k, p]) => [+k, p])
    .filter(([id, p]) => !p.rare && !p.anim && !p.evo && D.combos[p.type].t.some(t => z.types.includes(t)))
    .sort((a, b) => b[1].base.reduce((x, y) => x + y) - a[1].base.reduce((x, y) => x + y));
  const strongest = cands.filter(([, p]) => p.base.reduce((x, y) => x + y) <= 560);
  const team = (strongest.length ? strongest : cands).slice(0, 2).map(([id]) => id);
  const aces = animPool(zi);
  if (aces.length) team.push(aces[(zi * 7) % aces.length]);
  return team.map((id, i) => makeMon(id, z.boss - (team.length - 1 - i) * 2));
}

// ---------------------------------------------------------------- save
function newSave(name, starter) {
  return {
    name, zone: 0, x: 9, y: 9, dir: 'down', money: 500, badges: 0,
    party: [makeMon(starter, 6)], box: [],
    bag: { capsule: 10, superCapsule: 0, potion: 5, superPotion: 0, ppAid: 0 },
    seen: { [starter]: 1 }, caught: { [starter]: 1 },
  };
}
function save(quiet) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); if (!quiet) toast('已存檔'); }
  catch (e) { toast('存檔失敗：' + e.message); }
}
function loadSave() {
  try { const raw = localStorage.getItem(SAVE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// ---------------------------------------------------------------- UI helpers
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}
function modal(html, onMount) {
  const m = $('#modal'); m.hidden = false;
  $('.box', m).innerHTML = html;
  if (onMount) onMount($('.box', m));
}
function closeModal() { $('#modal').hidden = true; }
const isModalOpen = () => !$('#modal').hidden;
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function hpColor(r) { return r > .5 ? 'var(--hp)' : r > .2 ? 'var(--hp-mid)' : 'var(--hp-low)'; }
function hpBar(m) {
  const r = m.hp / m.stats[0];
  return `<div class="bar"><i style="width:${r * 100}%;background:${hpColor(r)}"></i></div>`;
}
function ask(title, text, options) {
  return new Promise(res => {
    modal(`<h2>${title}</h2><p>${text}</p><div class="row">${options.map((o, i) => `<button data-i="${i}">${o}</button>`).join('')}</div>`, box => {
      box.querySelectorAll('button').forEach(b => b.onclick = () => { closeModal(); res(+b.dataset.i); });
    });
  });
}
function petCard(m, extra = '') {
  return `<div class="card" data-uid="${extra}"><img src="${headImg(m.id)}" alt=""><b>${esc(pet(m.id).name)}</b>
    <div>Lv.${m.lv} · ${comboName(pet(m.id).type)}</div>${hpBar(m)}<small>${m.hp}/${m.stats[0]}</small></div>`;
}

// ---------------------------------------------------------------- world rendering
const cv = $('#world'), ctx = cv.getContext('2d');
let mapRows = PLANET_MAP;
const imgCache = {};
function getImg(src) {
  if (!imgCache[src]) { const i = new Image(); i.src = src; imgCache[src] = i; }
  return imgCache[src];
}

function tileAt(x, y) { return (mapRows[y] || '#')[x] || '#'; }
function npcAt(x, y) { return zoneNpcs(S.zone).find(n => n.x === x && n.y === y); }
function walkable(x, y) {
  const t = tileAt(x, y);
  if (t === '#' || t === '~' || t === 'T' || t === '=') return false;
  return !npcAt(x, y);
}

function drawPlayer(px, py, dir, t) {
  // original explorer sprite: round helmet with visor, backpack, little antenna
  const bob = Math.sin(t / 120) * 1.5;
  ctx.save(); ctx.translate(px + 16, py + 18 + bob);
  ctx.fillStyle = '#0005'; ctx.beginPath(); ctx.ellipse(0, 12 - bob, 10, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#e07a2e'; ctx.fillRect(-8, 0, 16, 11);
  ctx.fillStyle = '#7a3f12'; if (dir !== 'down') ctx.fillRect(-10, 1, 3, 8);
  ctx.fillStyle = '#f1f4f8'; ctx.beginPath(); ctx.arc(0, -5, 10, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#30405a'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#2bb5c9';
  const vx = dir === 'left' ? -4 : dir === 'right' ? 4 : 0;
  if (dir !== 'up') { ctx.beginPath(); ctx.ellipse(vx, -5, 6, 4, 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.strokeStyle = '#30405a'; ctx.beginPath(); ctx.moveTo(0, -15); ctx.lineTo(3, -21); ctx.stroke();
  ctx.fillStyle = '#ffb547'; ctx.beginPath(); ctx.arc(3, -21, 2, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawNpc(n) {
  const px = n.x * TILE, py = n.y * TILE;
  const colors = { heal: '#4cd97b', shop: '#ffb547', storage: '#56ccf2', teleport: '#bb6bd9', guide: '#f2f2f2', boss: '#eb5757' };
  ctx.fillStyle = '#0006'; ctx.fillRect(px + 2, py + 26, 28, 5);
  ctx.fillStyle = colors[n.kind] || '#fff';
  if (n.kind === 'teleport') {
    ctx.beginPath(); ctx.ellipse(px + 16, py + 16, 13, 13, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff8'; ctx.beginPath(); ctx.ellipse(px + 16, py + 16, 7, 7, 0, 0, Math.PI * 2); ctx.fill();
  } else if (n.kind === 'boss') {
    const team = S.badges >= S.zone ? null : 1;
    ctx.globalAlpha = team ? 1 : .4;
    ctx.beginPath(); ctx.moveTo(px + 16, py + 2); ctx.lineTo(px + 30, py + 28); ctx.lineTo(px + 2, py + 28); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('!', px + 16, py + 24);
    ctx.globalAlpha = 1;
  } else {
    ctx.fillRect(px + 4, py + 4, 24, 24);
    ctx.fillStyle = '#0b1426'; ctx.fillRect(px + 8, py + 8, 16, 10);
    ctx.fillStyle = colors[n.kind]; ctx.fillRect(px + 10, py + 10, 12, 2);
  }
  ctx.fillStyle = '#fff'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(n.label, px + 16, py - 3);
}

const stars = Array.from({ length: 60 }, () => [Math.random() * 640, Math.random() * 448, Math.random() * 1.5 + .3]);
function render(t) {
  const z = ZONES[S.zone];
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (z.safe) {
    ctx.fillStyle = '#060b18'; ctx.fillRect(0, 0, 640, 448);
    ctx.fillStyle = '#fff'; for (const [x, y, r] of stars) { ctx.globalAlpha = .4 + .4 * Math.sin(t / 600 + x); ctx.fillRect(x, y, r, r); }
    ctx.globalAlpha = 1;
  }
  for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
    const c = tileAt(x, y), px = x * TILE, py = y * TILE;
    if (z.safe) {
      if (c === '#') { ctx.fillStyle = '#2a3b5c'; ctx.fillRect(px, py, TILE, TILE); ctx.fillStyle = '#3a5a8c'; ctx.fillRect(px, py, TILE, 3); }
      else if (c === '=') { ctx.fillStyle = '#1d3156'; ctx.fillRect(px, py, TILE, TILE); ctx.fillStyle = '#56ccf233'; ctx.fillRect(px + 2, py + 2, TILE - 4, TILE - 4); }
      else { ctx.fillStyle = (x + y) % 2 ? '#c6d2e3' : '#b8c6da'; ctx.fillRect(px, py, TILE, TILE); }
      continue;
    }
    ctx.fillStyle = z.ground; ctx.fillRect(px, py, TILE, TILE);
    if (c === '#') { ctx.fillStyle = z.sky; ctx.fillRect(px, py, TILE, TILE); ctx.fillStyle = '#0003'; ctx.fillRect(px, py + 24, TILE, 8); }
    else if (c === '~') { ctx.fillStyle = S.zone === 3 ? '#e2541c' : '#2f6fd6'; ctx.fillRect(px, py, TILE, TILE);
      ctx.fillStyle = '#fff3'; ctx.fillRect(px + ((t / 40 + y * 7) % 28), py + 10, 6, 2); }
    else if (c === 'T') { ctx.fillStyle = '#0004'; ctx.beginPath(); ctx.ellipse(px + 16, py + 28, 12, 4, 0, 0, 7); ctx.fill();
      ctx.fillStyle = z.grass; ctx.beginPath(); ctx.arc(px + 16, py + 14, 13, 0, 7); ctx.fill();
      ctx.fillStyle = '#fff2'; ctx.beginPath(); ctx.arc(px + 12, py + 9, 5, 0, 7); ctx.fill(); }
    else if (c === '"') { ctx.fillStyle = z.grass;
      for (let i = 0; i < 4; i++) { const gx = px + 4 + i * 7, sway = Math.sin(t / 300 + x + i) * 2;
        ctx.beginPath(); ctx.moveTo(gx, py + 28); ctx.lineTo(gx + 3 + sway, py + 10 + (i % 2) * 5); ctx.lineTo(gx + 6, py + 28); ctx.fill(); } }
  }
  for (const n of zoneNpcs(S.zone)) drawNpc(n);
  // follower pet head
  const lead = S.party.find(m => m.hp > 0) || S.party[0];
  if (lead && follow) { const im = getImg(headImg(lead.id)); if (im.complete && im.naturalWidth) ctx.drawImage(im, follow.x * TILE + 4, follow.y * TILE + 4, 24, 24); }
  drawPlayer(anim.x * TILE, anim.y * TILE - 4, S.dir, t);
}

// ---------------------------------------------------------------- movement
const anim = { x: 9, y: 9 };
let follow = null;
let moving = false;
const held = new Set();
let stepsSinceBattle = 0;

function enterZone(zi, x, y) {
  S.zone = zi; S.x = x; S.y = y; anim.x = x; anim.y = y; follow = { x, y: y + 1 };
  mapRows = zi === 0 ? BASE_MAP : PLANET_MAP;
  $('#hud-zone').textContent = `${ZONES[zi].name}${ZONES[zi].lv ? `（Lv.${ZONES[zi].lv[0]}-${ZONES[zi].lv[1]}）` : ''}`;
  updateHud();
}
function updateHud() { $('#hud-money').textContent = `賽爾豆 ${S.money} · 徽章 ${S.badges}/6`; }

async function step(dir) {
  if (moving || battle || isModalOpen()) return;
  S.dir = dir;
  const dx = { left: -1, right: 1 }[dir] || 0, dy = { up: -1, down: 1 }[dir] || 0;
  const nx = S.x + dx, ny = S.y + dy;
  if (!walkable(nx, ny)) return;
  moving = true;
  const ox = S.x, oy = S.y;
  for (let i = 1; i <= 6; i++) { anim.x = ox + dx * i / 6; anim.y = oy + dy * i / 6; await sleep(18); }
  follow = { x: ox, y: oy };
  S.x = nx; S.y = ny; anim.x = nx; anim.y = ny;
  moving = false;
  if (tileAt(nx, ny) === '"' && !ZONES[S.zone].safe) {
    stepsSinceBattle++;
    if (Math.random() < 0.08 + stepsSinceBattle * 0.01) { stepsSinceBattle = 0; held.clear(); startWild(); }
  }
}

function interact() {
  if (moving || battle || isModalOpen()) return;
  const dx = { left: -1, right: 1 }[S.dir] || 0, dy = { up: -1, down: 1 }[S.dir] || 0;
  const n = npcAt(S.x + dx, S.y + dy);
  if (!n) return;
  held.clear();
  ({ heal: npcHeal, shop: npcShop, storage: openStorage, teleport: npcTeleport, guide: npcGuide, boss: npcBoss })[n.kind]();
}

function npcHeal() { healAll(); save(true); toast('精靈已全部恢復！（已自動存檔）'); }
function npcGuide() {
  modal(`<h2>船長</h2><p>歡迎登艦，${esc(S.name)}！走進星球上的草叢就會遇到野生精靈。</p>
    <p>用膠囊捕捉精靈，擊敗每顆星球的「星球守護者」可以拿到徽章並解鎖下一顆星球。集滿 6 枚徽章就能成為傳說中的賽爾！</p>
    <p>操作：方向鍵 / WASD 移動，空白鍵 / Enter 與面前的設施互動。</p>
    <div class="row"><button id="ok">知道了</button></div>`, b => $('#ok', b).onclick = closeModal);
}
function npcTeleport() {
  if (S.zone !== 0) { enterZone(0, 9, 9); save(true); return; }
  const btns = ZONES.slice(1).map((z, i) => {
    const locked = i > S.badges;
    return `<button data-z="${i + 1}" ${locked ? 'disabled' : ''}>${z.name}<br><small>Lv.${z.lv[0]}-${z.lv[1]}${locked ? ' 🔒' : S.badges > i ? ' ✓' : ''}</small></button>`;
  }).join('');
  modal(`<h2>傳送艙</h2><p>選擇目的地星球。擊敗守護者後解鎖下一顆。</p><div class="row">${btns}<button id="x">取消</button></div>`, b => {
    b.querySelectorAll('[data-z]').forEach(el => el.onclick = () => { closeModal(); enterZone(+el.dataset.z, 2, 12); save(true); });
    $('#x', b).onclick = closeModal;
  });
}
async function npcBoss() {
  const zi = S.zone;
  const beaten = S.badges >= zi;
  const ch = await ask('星球守護者', beaten ? '你已經打敗過我了。要再來一場切磋嗎？（不再給予徽章）' : `想取得${ZONES[zi].name}的徽章，就先打敗我的精靈吧！`, ['挑戰', '再準備一下']);
  if (ch !== 0) return;
  startBattle(bossTeam(zi), { trainer: true, boss: zi });
}

const SHOP = [
  ['capsule', '精靈膠囊', 100, '捕捉野生精靈'],
  ['superCapsule', '高級膠囊', 300, '捕捉率 ×2'],
  ['potion', '體力藥劑', 80, '恢復 50 點體力'],
  ['superPotion', '高級體力藥劑', 250, '恢復 200 點體力'],
  ['ppAid', '活力藥劑', 200, '恢復一隻精靈全部 PP'],
];
const ITEM_NAMES = Object.fromEntries(SHOP.map(([k, n]) => [k, n]));
function npcShop() {
  modal(`<h2>補給站</h2><p>賽爾豆：<b id="money">${S.money}</b></p><div class="grid">${SHOP.map(([k, n, p, d]) =>
    `<div class="card" data-k="${k}"><b>${n}</b><div>${p} 豆</div><small>${d}</small><div>持有 <span>${S.bag[k] || 0}</span></div></div>`).join('')}</div>
    <div class="row"><button id="x">離開</button></div>`, b => {
    b.querySelectorAll('[data-k]').forEach(c => c.onclick = () => {
      const it = SHOP.find(s => s[0] === c.dataset.k);
      if (S.money < it[2]) return toast('賽爾豆不足');
      S.money -= it[2]; S.bag[it[0]] = (S.bag[it[0]] || 0) + 1;
      $('span', c).textContent = S.bag[it[0]]; $('#money', b).textContent = S.money; updateHud();
    });
    $('#x', b).onclick = closeModal;
  });
}

// ---------------------------------------------------------------- party / storage / dex
function petDetail(m, back) {
  const p = pet(m.id), n = D.natures[m.nature];
  const next = expForLevel(m.lv + 1);
  modal(`<h2>${esc(p.name)} <small>Lv.${m.lv}</small></h2><div class="detail"><img src="${bodyImg(m.id)}" alt="">
    <div><table>
      <tr><td>屬性</td><td>${comboName(p.type)}</td></tr>
      <tr><td>性格</td><td>${n.name}（${n.des}）</td></tr>
      <tr><td>個體值</td><td>${m.iv}</td></tr>
      <tr><td>經驗</td><td>${m.exp} / ${next}</td></tr>
      ${m.stats.map((v, i) => `<tr><td>${STAT_NAMES[i]}</td><td>${i ? v : `${m.hp} / ${v}`}</td></tr>`).join('')}
      ${p.evo ? `<tr><td>進化</td><td>Lv.${p.evo[0]} → ${esc(pet(p.evo[1]).name)}</td></tr>` : ''}
    </table>
    <h3>技能</h3><table>${m.skills.map(s => { const k = skill(s.id);
      return `<tr><td>${esc(k.name)}</td><td>${comboName(k.type)} · ${k.cat === 4 ? '屬性' : '威力 ' + k.pow} · PP ${s.pp}/${k.pp}</td></tr>
      ${k.info ? `<tr><td></td><td><small>${esc(k.info)}</small></td></tr>` : ''}`; }).join('')}</table></div></div>
    <div class="row"><button id="x">返回</button></div>`, b => $('#x', b).onclick = back || closeModal);
}

function openParty(opts = {}) {
  return new Promise(res => {
    const draw = (sel = -1) => modal(`<h2>${opts.title || '我的精靈'}</h2><p>${opts.hint || '點選查看詳情；可在倉庫中整理隊伍。'}</p>
      <div class="grid">${S.party.map((m, i) => petCard(m, i)).join('')}</div>
      <div class="row">${opts.pick ? '' : '<button id="up">設為首發</button><button id="info">詳情</button>'}<button id="x">${opts.cancel || '關閉'}</button></div>`, b => {
      b.querySelectorAll('.card').forEach(c => {
        const i = +c.dataset.uid;
        if (i === sel) c.classList.add('sel');
        c.onclick = () => {
          if (opts.pick) { if (opts.filter && !opts.filter(S.party[i])) return toast(opts.filterMsg || '不能選擇'); closeModal(); res(i); }
          else draw(i);
        };
      });
      $('#x', b).onclick = () => { closeModal(); res(-1); };
      if (!opts.pick) {
        $('#up', b).disabled = sel < 1; $('#info', b).disabled = sel < 0;
        $('#up', b).onclick = () => { const [m] = S.party.splice(sel, 1); S.party.unshift(m); draw(0); };
        $('#info', b).onclick = () => petDetail(S.party[sel], () => draw(sel));
      }
    });
    draw();
  });
}

function openStorage() {
  const draw = () => modal(`<h2>精靈倉庫</h2><p>隊伍（最多 6 隻）— 點選放入倉庫</p>
    <div class="grid" id="party">${S.party.map((m, i) => petCard(m, i)).join('')}</div>
    <p>倉庫（${S.box.length}）— 點選加入隊伍</p><div class="grid" id="box">${S.box.map((m, i) => petCard(m, i)).join('') || '<small>空空如也</small>'}</div>
    <div class="row"><button id="x">關閉</button></div>`, b => {
    $('#party', b).querySelectorAll('.card').forEach(c => c.onclick = () => {
      if (S.party.length <= 1) return toast('隊伍至少要有一隻精靈');
      S.box.push(...S.party.splice(+c.dataset.uid, 1)); draw();
    });
    $('#box', b).querySelectorAll('.card').forEach(c => c.onclick = () => {
      if (S.party.length >= 6) return toast('隊伍已滿');
      const [m] = S.box.splice(+c.dataset.uid, 1); m.hp = m.stats[0]; m.skills.forEach(s => s.pp = skill(s.id).pp);
      S.party.push(m); draw();
    });
    $('#x', b).onclick = closeModal;
  });
  draw();
}

function openDex() {
  const ids = Object.keys(D.pets).map(Number).sort((a, b) => a - b);
  const caught = Object.keys(S.caught).length, seen = Object.keys(S.seen).length;
  modal(`<h2>精靈圖鑑</h2><p>已見 ${seen} · 已捕捉 ${caught} · 共 ${ids.length}</p><div class="grid">${ids.map(id => {
    const known = S.seen[id];
    return `<div class="card ${known ? '' : 'unknown'}"><img loading="lazy" src="${headImg(id)}" alt="">
      <b>${known ? esc(pet(id).name) : '？？？'}</b><div>No.${id}${S.caught[id] ? ' ●' : ''}</div>
      ${known ? `<small>${comboName(pet(id).type)}</small>` : ''}</div>`; }).join('')}</div>
    <div class="row"><button id="x">關閉</button></div>`, b => $('#x', b).onclick = closeModal);
}

function openBag() {
  const items = SHOP.filter(([k]) => S.bag[k] > 0);
  modal(`<h2>背包</h2><div class="grid">${items.map(([k, n, , d]) => `<div class="card" data-k="${k}"><b>${n}</b> ×${S.bag[k]}<br><small>${d}</small></div>`).join('') || '<small>沒有道具</small>'}</div>
    <div class="row"><button id="x">關閉</button></div>`, b => {
    b.querySelectorAll('[data-k]').forEach(c => c.onclick = async () => {
      const k = c.dataset.k;
      if (k.includes('apsule')) return toast('膠囊只能在野外戰鬥中使用');
      const i = await openParty({ pick: true, title: '對哪隻精靈使用？', cancel: '取消' });
      if (i >= 0) { const msg = useItemOn(k, S.party[i]); toast(msg); }
      openBag();
    });
    $('#x', b).onclick = closeModal;
  });
}

function useItemOn(k, m) {
  if (m.hp <= 0 && k !== 'ppAid') return '戰鬥不能狀態的精靈無法使用';
  S.bag[k]--;
  if (k === 'potion' || k === 'superPotion') {
    const amt = k === 'potion' ? 50 : 200, before = m.hp;
    m.hp = Math.min(m.stats[0], m.hp + amt);
    return `${pet(m.id).name} 恢復了 ${m.hp - before} 點體力`;
  }
  if (k === 'ppAid') { m.skills.forEach(s => s.pp = skill(s.id).pp); return `${pet(m.id).name} 的 PP 全部恢復了`; }
  return '';
}

// ---------------------------------------------------------------- battle
function fighter(m, side) {
  return { m, side, stages: [0, 0, 0, 0, 0, 0], status: null, statusTurns: 0, leech: 0, streak: { id: 0, n: 0 } };
}

function startWild() {
  if (ZONES[S.zone].safe) return;
  const z = ZONES[S.zone];
  if (Math.random() < 0.06) {
    const rare = pick(animPool(S.zone));
    if (rare) { toast('發現稀有精靈！'); return startBattle([makeMon(rare, z.lv[1] + 2)], { wild: true }); }
  }
  const id = pick(zonePool(S.zone));
  let lv = rnd(z.lv[0], z.lv[1]);
  // a wild pet below its evolution level would not exist: evolve forward
  let wid = id;
  while (pet(wid).evo && lv >= pet(wid).evo[0]) wid = pet(wid).evo[1];
  startBattle([makeMon(wid, lv)], { wild: true });
}

function startBattle(foes, opts) {
  const lead = S.party.findIndex(m => m.hp > 0);
  if (lead < 0) { toast('你的精靈都無法戰鬥了！'); return; }
  battle = { ...opts, foes, foeIdx: 0, me: fighter(S.party[lead], 'me'), foe: fighter(foes[0], 'foe'),
    participants: new Set([S.party[lead]]), busy: false, over: false };
  foes.forEach(f => S.seen[f.id] = 1);
  clearAnims();
  $('#battle').hidden = false;
  $('#log').innerHTML = '';
  renderBattle();
  log(opts.wild ? `野生的 ${pet(foes[0].id).name} 出現了！` : `星球守護者派出了 ${pet(foes[0].id).name}！`);
  log(`去吧，${pet(battle.me.m.id).name}！`);
  showCommands();
}

// Animated pets are drawn on a full-arena canvas per side; others use the static body image.
const ANIM_HOME = { me: { x: .26, y: .94, w: .34, h: .42 }, foe: { x: .74, y: .46, w: .3, h: .38 } };
function setAnim(f) {
  const cv = $(`#anim-${f.side}`), img = $(`#battle .${f.side} .sprite`);
  const animId = pet(f.m.id).anim;
  const cur = cv._anim;
  if (cur && cur.petId === f.m.id) { f.anim = cur; return; }
  if (cur) { cur.destroy(); cv._anim = null; cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); }
  f.anim = null;
  cv.classList.remove('faint');
  img.classList.remove('hidden-by-anim');
  if (!animId) return;
  img.classList.add('hidden-by-anim');
  const want = f.m.id;
  loadAnim(animId).then(data => {
    if (!battle || battle[f.side] !== f || f.m.id !== want) return;
    const a = new PetAnim(cv, data, { flip: f.side === 'foe', home: ANIM_HOME[f.side] });
    a.petId = want; cv._anim = a; f.anim = a;
    if (a.has('appear')) a.play('appear');
  }).catch(() => img.classList.remove('hidden-by-anim'));
}
function clearAnims() {
  for (const side of ['me', 'foe']) {
    const cv = $(`#anim-${side}`);
    if (cv._anim) { cv._anim.destroy(); cv._anim = null; }
    cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
    cv.classList.remove('faint');
  }
}
// Plays the attacker's move animation; resolves at the hit frame (or at once without animation).
function attackAnim(f, k) {
  if (!f.anim) return Promise.resolve();
  const seq = k.cat === 1 || !f.anim.has('sa') ? 'attack' : 'sa';
  return new Promise(res => { f.anim.play(seq, res); setTimeout(res, 4000); });
}
function hitAnim(f) {
  const img = $(`#battle .${f.side} .sprite`);
  img.classList.remove('hit'); void img.offsetWidth; img.classList.add('hit');
  if (f.anim) f.anim.play('hited');
}
function faintAnim(f) {
  $(`#battle .${f.side} .sprite`).classList.add('faint');
  $(`#anim-${f.side}`).classList.add('faint');
}

function renderSide(f) {
  if (f.anim === undefined || (f.anim && f.anim.petId !== f.m.id)) setAnim(f);
  const el = $(`#battle .${f.side}`), m = f.m, p = pet(m.id);
  const img = $('.sprite', el);
  if (!img.src.endsWith(bodyImg(m.id))) { img.src = bodyImg(m.id); img.classList.remove('faint'); }
  $('.name', el).textContent = p.name;
  $('.lv', el).textContent = 'Lv.' + m.lv;
  $('.type', el).textContent = comboName(p.type);
  const st = { para: '麻痺', poison: '中毒', burn: '燒傷', freeze: '凍傷', fear: '害怕', tired: '疲憊' }[f.status] || '';
  const stg = f.stages.map((v, i) => v ? `${STAGE_NAMES[i]}${v > 0 ? '+' : ''}${v}` : '').filter(Boolean).join(' ');
  $('.status', el).textContent = [st, stg].filter(Boolean).join(' · ');
  const r = m.hp / m.stats[0], bar = $('.bar i', el);
  bar.style.width = r * 100 + '%'; bar.style.background = hpColor(r);
  $('.hp', el).textContent = `${m.hp} / ${m.stats[0]}`;
  if (f.side === 'me') {
    const a = expForLevel(m.lv), b = expForLevel(m.lv + 1);
    $('.exp i', el).style.width = clamp((m.exp - a) / (b - a), 0, 1) * 100 + '%';
  }
}
function renderBattle() { renderSide(battle.me); renderSide(battle.foe); }

async function log(msg) {
  const l = $('#log');
  const d = document.createElement('div'); d.textContent = msg; l.appendChild(d);
  while (l.children.length > 3) l.firstChild.remove();
  await sleep(550);
}

function showCommands(mode = 'main') {
  const c = $('#cmd'), me = battle.me;
  if (mode === 'main') {
    c.innerHTML = me.m.skills.map((s, i) => { const k = skill(s.id);
      return `<button data-s="${i}" ${s.pp <= 0 ? 'disabled' : ''} title="${esc(k.info)}">${esc(k.name)}<small>${comboName(k.type)} · ${k.cat === 4 ? '屬性' : '威力' + k.pow} · ${s.pp}/${k.pp}</small></button>`;
    }).join('') + `<button data-a="bag">道具</button><button data-a="switch">換精靈</button><button data-a="catch" ${battle.wild ? '' : 'disabled'}>捕捉</button><button data-a="run">${battle.wild ? '逃跑' : '認輸'}</button>`;
    if (me.m.skills.every(s => s.pp <= 0)) c.innerHTML = `<button class="wide" data-s="-1">掙扎（沒有 PP 了）</button>` + c.innerHTML;
  }
  c.querySelectorAll('button').forEach(b => b.onclick = () => onCommand(b.dataset));
}
function lockCommands() { $('#cmd').querySelectorAll('button').forEach(b => b.disabled = true); }

async function onCommand(ds) {
  if (battle.busy) return;
  if (ds.s !== undefined) return runTurn({ kind: 'skill', idx: +ds.s });
  if (ds.a === 'run') {
    if (!battle.wild) { const c = await ask('認輸', '確定要放棄這場挑戰嗎？', ['認輸', '繼續戰鬥']); if (c === 0) endBattle('lose'); return; }
    return runTurn({ kind: 'run' });
  }
  if (ds.a === 'switch') {
    const i = await openParty({ pick: true, title: '換上哪隻精靈？', cancel: '取消',
      filter: m => m.hp > 0 && m !== battle.me.m, filterMsg: '這隻精靈無法出戰' });
    if (i >= 0) runTurn({ kind: 'switch', idx: i });
    return;
  }
  if (ds.a === 'catch') {
    const opts = ['capsule', 'superCapsule'].filter(k => S.bag[k] > 0);
    if (!opts.length) return toast('沒有膠囊了');
    const c = await ask('捕捉', '使用哪種膠囊？', [...opts.map(k => `${ITEM_NAMES[k]} ×${S.bag[k]}`), '取消']);
    if (c < opts.length) runTurn({ kind: 'catch', item: opts[c] });
    return;
  }
  if (ds.a === 'bag') {
    const opts = ['potion', 'superPotion', 'ppAid'].filter(k => S.bag[k] > 0);
    if (!opts.length) return toast('沒有可用的道具');
    const c = await ask('道具', '使用哪個道具？', [...opts.map(k => `${ITEM_NAMES[k]} ×${S.bag[k]}`), '取消']);
    if (c >= opts.length) return;
    const i = await openParty({ pick: true, title: '對哪隻精靈使用？', cancel: '取消' });
    if (i >= 0) runTurn({ kind: 'item', item: opts[c], target: S.party[i] });
  }
}

function aiChoose(f) {
  const usable = f.m.skills.map((s, i) => [s, i]).filter(([s]) => s.pp > 0);
  if (!usable.length) return { kind: 'skill', idx: -1 };
  // weight damaging moves by expected damage, keep some randomness
  const scored = usable.map(([s, i]) => {
    const k = skill(s.id);
    const v = k.cat === 4 ? 30 : k.pow * typeMult(k.type, pet(battle.me.m.id).type) * (D.combos[k.type].t.some(t => D.combos[pet(f.m.id).type].t.includes(t)) ? 1.5 : 1);
    return [i, v * (0.6 + Math.random() * 0.8)];
  }).sort((a, b) => b[1] - a[1]);
  return { kind: 'skill', idx: scored[0][0] };
}

const stageMult = s => s >= 0 ? (2 + s) / 2 : 2 / (2 - s);

function speedOf(f) {
  let v = f.m.stats[5] * stageMult(f.stages[4]);
  if (f.status === 'para') v /= 2;
  return v;
}

async function runTurn(action) {
  battle.busy = true; lockCommands();
  const me = battle.me, foe = battle.foe;
  const foeAct = aiChoose(foe);

  // non-skill actions go first
  if (action.kind === 'run') {
    const chance = clamp(0.5 + (speedOf(me) - speedOf(foe)) / (speedOf(foe) * 2 + 1), 0.3, 0.95);
    if (Math.random() < chance) { await log('成功逃跑了！'); return endBattle('run'); }
    await log('逃跑失敗！');
  } else if (action.kind === 'switch') {
    await log(`${pet(me.m.id).name}，回來吧！`);
    battle.me = fighter(S.party[action.idx], 'me'); battle.participants.add(battle.me.m);
    renderBattle(); await log(`去吧，${pet(battle.me.m.id).name}！`);
  } else if (action.kind === 'item') {
    await log(useItemOn(action.item, action.target)); renderBattle();
  } else if (action.kind === 'catch') {
    S.bag[action.item]--;
    await log(`扔出了${ITEM_NAMES[action.item]}！`);
    if (tryCatch(foe, action.item === 'superCapsule' ? 2 : 1)) {
      faintAnim(foe);
      await log(`捕捉成功！${pet(foe.m.id).name} 成為了你的夥伴！`);
      return endBattle('catch');
    }
    await log('膠囊晃了晃……精靈掙脫了！');
  }

  const order = [];
  if (action.kind === 'skill') {
    const pm = action.idx >= 0 ? skill(me.m.skills[action.idx].id).pri : 0;
    const pf = foeAct.idx >= 0 ? skill(foe.m.skills[foeAct.idx].id).pri : 0;
    const meFirst = pm !== pf ? pm > pf : speedOf(me) !== speedOf(foe) ? speedOf(me) > speedOf(foe) : Math.random() < .5;
    order.push(...(meFirst ? [[battle.me, action, battle.foe], [battle.foe, foeAct, battle.me]] : [[battle.foe, foeAct, battle.me], [battle.me, action, battle.foe]]));
  } else {
    order.push([battle.foe, foeAct, battle.me]);
  }

  for (const [a, act, d] of order) {
    if (a.m.hp <= 0 || d.m.hp <= 0) continue;
    await useSkill(a, act.idx, d);
    renderBattle();
    if (await checkFaint()) return;
  }
  // end-of-turn effects
  for (const f of [battle.me, battle.foe]) {
    if (f.m.hp <= 0) continue;
    if (f.status === 'poison' || f.status === 'burn') {
      const dmg = Math.max(1, Math.floor(f.m.stats[0] / 8));
      f.m.hp = Math.max(0, f.m.hp - dmg);
      await log(`${pet(f.m.id).name} 受到${f.status === 'burn' ? '燒傷' : '中毒'}傷害 ${dmg}`);
    }
    if (f.leech > 0) {
      const o = f === battle.me ? battle.foe : battle.me;
      const dmg = Math.max(1, Math.floor(f.m.stats[0] / 8));
      f.m.hp = Math.max(0, f.m.hp - dmg); f.leech--;
      if (o.m.hp > 0) o.m.hp = Math.min(o.m.stats[0], o.m.hp + dmg);
      await log(`${pet(f.m.id).name} 被吸取了 ${dmg} 點體力`);
    }
    if (f.status && --f.statusTurns <= 0) { f.status = null; }
    renderBattle();
  }
  if (await checkFaint()) return;
  battle.busy = false; showCommands();
}

function tryCatch(f, mult) {
  const m = f.m, p = pet(m.id);
  const hpF = (3 * m.stats[0] - 2 * m.hp) / (3 * m.stats[0]);
  const statusF = f.status ? 1.5 : 1;
  // animated pets are endgame species with catch rate 0 in the source data; keep them catchable
  const base = Math.max(p.catch, p.anim ? 25 : 3);
  const chance = clamp((base * mult * hpF * statusF) / 255, 0.02, 1);
  return Math.random() < chance;
}

async function useSkill(a, idx, d) {
  const an = pet(a.m.id).name;
  if (['para', 'freeze', 'fear', 'tired'].includes(a.status)) {
    await log(`${an} ${{ para: '麻痺了', freeze: '被凍住了', fear: '害怕得', tired: '太疲憊' }[a.status]}，無法行動！`);
    return;
  }
  let k, slot = null;
  if (idx < 0) k = { name: '掙扎', pow: 50, acc: 100, crit: 0, pri: 0, hit: true, cat: 1, type: 8, fx: [[6, [4]]] };
  else { slot = a.m.skills[idx]; k = skill(slot.id); slot.pp--; }
  await log(`${an} 使用了「${k.name}」！`);

  const fx = Object.fromEntries(k.fx.map(([id, args]) => [id, args]));
  const accMult = stageMult(a.stages[5]);
  if (!k.hit && Math.random() * 100 > k.acc * accMult) { await log('但是沒有命中！'); a.streak = { id: 0, n: 0 }; return; }
  if (fx[7] && d.m.hp <= a.m.hp) { await log('但是沒有效果！'); return; }

  // consecutive power-up
  if (slot && a.streak.id === slot.id) a.streak.n++; else a.streak = { id: slot ? slot.id : 0, n: 0 };

  await attackAnim(a, k);
  if (k.cat !== 4 && k.pow > 0) {
    let pow = k.pow;
    if (fx[2] && d.m.hp < d.m.stats[0] / 2) pow *= 2;
    if (fx[9]) pow = Math.min(fx[9][1] || pow, pow + (fx[9][0] || 0) * a.streak.n);
    const hits = fx[31] ? fx[31][0] || 1 : 1;
    let total = 0;
    for (let h = 0; h < hits && d.m.hp > 0; h++) {
      const phys = k.cat === 1;
      let atk = a.m.stats[phys ? 1 : 3] * stageMult(a.stages[phys ? 0 : 2]);
      const def = d.m.stats[phys ? 2 : 4] * stageMult(d.stages[phys ? 1 : 3]);
      if (phys && a.status === 'burn') atk /= 2;
      const stab = D.combos[k.type].t.some(t => D.combos[pet(a.m.id).type].t.includes(t)) ? 1.5 : 1;
      const tm = typeMult(k.type, pet(d.m.id).type);
      const crit = Math.random() * 100 < (k.crit || 6.25);
      let dmg = Math.floor(((2 * a.m.lv / 5 + 2) * pow * atk / def / 50 + 2) * stab * tm * (crit ? 1.5 : 1) * rnd(217, 255) / 255);
      if (tm > 0) dmg = Math.max(1, dmg); else dmg = 0;
      if (fx[29]) dmg += fx[29][0] || 0;
      if (fx[8] && dmg >= d.m.hp) dmg = d.m.hp - 1;
      d.m.hp = Math.max(0, d.m.hp - dmg); total += dmg;
      hitAnim(d);
      renderBattle();
      if (crit) await log('擊中要害！');
      if (h === 0) { if (tm >= 2) await log('效果拔群！'); else if (tm === 0) await log('完全沒有效果……'); else if (tm < 1) await log('效果不太好……'); }
    }
    if (hits > 1) await log(`連續攻擊 ${hits} 次！`);
    await log(`造成了 ${total} 點傷害`);
    if (fx[1] && total > 0) { const h = Math.floor(total / 2); a.m.hp = Math.min(a.m.stats[0], a.m.hp + h); await log(`${an} 恢復了 ${h} 點體力`); }
    if (fx[6] && total > 0) { const r = Math.max(1, Math.floor(total / (fx[6][0] || 4))); a.m.hp = Math.max(0, a.m.hp - r); await log(`${an} 受到 ${r} 點反彈傷害`); }
  }
  if (fx[7]) { d.m.hp = a.m.hp; await log(`${pet(d.m.id).name} 的體力被削減到和對手相同！`); }
  if (fx[3]) { a.stages = a.stages.map(v => Math.max(0, v)); await log(`${an} 解除了能力下降`); }
  for (const [eid, args] of k.fx) await applyStatFx(eid, args, a, d);
  if (fx[13] && d.m.hp > 0 && !D.combos[pet(d.m.id).type].t.includes(1)) { d.leech = fx[13][0] || 5; await log(`${pet(d.m.id).name} 被寄生了！`); }
  const statusFx = { 10: ['para', 2, '麻痺'], 11: ['poison', 3, '中毒'], 12: ['burn', 3, '燒傷'], 14: ['freeze', 2, '凍傷'], 15: ['fear', 1, '害怕'] };
  for (const [eid, [st, turns, label]] of Object.entries(statusFx)) {
    if (fx[eid] && d.m.hp > 0 && !d.status && Math.random() * 100 < (fx[eid][0] ?? 100)) {
      d.status = st; d.statusTurns = turns + 1; await log(`${pet(d.m.id).name} ${label}了！`);
    }
  }
  if (fx[20] && Math.random() * 100 < (fx[20][0] ?? 100)) { a.status = 'tired'; a.statusTurns = (fx[20][1] || 1) + 1; await log(`${an} 疲憊了！`); }
  renderBattle();
}

async function applyStatFx(eid, args, a, d) {
  if (eid !== 4 && eid !== 5) return;
  const [stat, chance, delta] = args;
  if (stat === undefined || stat > 5 || Math.random() * 100 >= (chance ?? 100)) return;
  const t = eid === 4 ? a : d;
  if (t.m.hp <= 0) return;
  const before = t.stages[stat];
  t.stages[stat] = clamp(before + delta, -6, 6);
  if (t.stages[stat] === before) return;
  await log(`${pet(t.m.id).name} 的${STAGE_NAMES[stat]}${delta > 0 ? '提升' : '下降'}了${Math.abs(delta) > 1 ? '很多' : ''}！`);
}

async function checkFaint() {
  const { me, foe } = battle;
  if (foe.m.hp <= 0) {
    faintAnim(foe);
    await log(`${pet(foe.m.id).name} 倒下了！`);
    await giveExp(foe.m);
    battle.foeIdx++;
    if (battle.foeIdx < battle.foes.length) {
      battle.foe = fighter(battle.foes[battle.foeIdx], 'foe');
      battle.participants = new Set([battle.me.m]);
      renderBattle(); await log(`星球守護者派出了 ${pet(battle.foe.m.id).name}！`);
      battle.busy = false; showCommands(); return true;
    }
    await endBattle('win'); return true;
  }
  if (me.m.hp <= 0) {
    faintAnim(me);
    await log(`${pet(me.m.id).name} 倒下了！`);
    if (!S.party.some(m => m.hp > 0)) { await endBattle('lose'); return true; }
    const i = await openParty({ pick: true, title: '派出下一隻精靈', cancel: '（必須選擇）', filter: m => m.hp > 0, filterMsg: '這隻精靈無法出戰' });
    const idx = i >= 0 ? i : S.party.findIndex(m => m.hp > 0);
    battle.me = fighter(S.party[idx], 'me'); battle.participants.add(battle.me.m);
    renderBattle(); await log(`去吧，${pet(battle.me.m.id).name}！`);
    battle.busy = false; showCommands(); return true;
  }
  return false;
}

async function giveExp(foeMon) {
  const alive = [...battle.participants].filter(m => m.hp > 0 && S.party.includes(m));
  if (!alive.length) return;
  const base = Math.floor(pet(foeMon.id).exp * foeMon.lv / 7 * (battle.trainer ? 1.5 : 1));
  const each = Math.max(1, Math.floor(base / alive.length));
  for (const m of alive) {
    m.exp += each;
    pet(foeMon.id).base.forEach((_, i) => { m.ev[i] = Math.min(255, m.ev[i] + (i === 1 || i === 3 ? 1 : 0)); });
    await log(`${pet(m.id).name} 獲得了 ${each} 點經驗`);
    while (m.lv < 100 && m.exp >= expForLevel(m.lv + 1)) {
      m.lv++; refresh(m);
      await log(`${pet(m.id).name} 升到了 Lv.${m.lv}！`);
      for (const [l, sid] of pet(m.id).learn) if (l === m.lv) await learnSkill(m, sid);
    }
    if (battle.me.m === m) renderBattle();
  }
}

async function learnSkill(m, sid) {
  if (m.skills.some(s => s.id === sid)) return;
  const k = skill(sid);
  if (m.skills.length < 4) { m.skills.push({ id: sid, pp: k.pp }); await log(`${pet(m.id).name} 學會了「${k.name}」！`); return; }
  const c = await ask('學習新技能', `${pet(m.id).name} 想學習「${k.name}」（${comboName(k.type)} · ${k.cat === 4 ? '屬性' : '威力' + k.pow}）。<br><small>${esc(k.info)}</small><br>要忘記哪個技能？`,
    [...m.skills.map(s => skill(s.id).name), '不學習']);
  if (c < 4) { const old = skill(m.skills[c].id).name; m.skills[c] = { id: sid, pp: k.pp }; await log(`${pet(m.id).name} 忘記了「${old}」，學會了「${k.name}」！`); }
}

async function endBattle(result) {
  battle.over = true;
  const wasBoss = battle.boss;
  if (result === 'win') {
    const reward = battle.foes.reduce((s, f) => s + f.lv * (battle.trainer ? 40 : 8), 0);
    S.money += reward; await log(`獲得了 ${reward} 賽爾豆！`);
    if (wasBoss && S.badges < wasBoss) {
      S.badges = wasBoss;
      await log(`取得了${ZONES[wasBoss].name}徽章！`);
    }
  }
  if (result === 'catch') {
    const m = battle.foe.m;
    m.skills.forEach(s => s.pp = skill(s.id).pp);
    S.caught[m.id] = 1;
    if (S.party.length < 6) S.party.push(m); else { S.box.push(m); await log('隊伍已滿，已傳送到倉庫'); }
  }
  if (result === 'lose') {
    await log('你的精靈全部倒下了……被緊急傳送回飛船');
    S.money = Math.floor(S.money / 2);
  }
  await sleep(500);
  $('#battle').hidden = true;
  clearAnims();
  battle = null;
  if (result === 'lose') { healAll(); enterZone(0, 9, 9); }
  // evolutions
  for (const m of S.party) {
    const p = pet(m.id);
    if (p.evo && m.lv >= p.evo[0]) {
      const to = p.evo[1];
      const c = await ask('進化', `<img src="${headImg(m.id)}" width="80"> → <img src="${headImg(to)}" width="80"><br>${p.name} 要進化成 ${pet(to).name} 了！`, ['進化', '先不要']);
      if (c === 0) {
        m.id = to; refresh(m); S.seen[to] = 1; S.caught[to] = 1;
        for (const [l, sid] of pet(to).learn) if (l <= m.lv && !m.skills.some(s => s.id === sid) && l === m.lv) await learnSkill(m, sid);
        toast(`進化成了 ${pet(to).name}！`);
      }
    }
  }
  updateHud(); save(true);
  if (wasBoss && result === 'win' && S.badges >= 6) victoryScreen();
}

function victoryScreen() {
  modal(`<h2>恭喜！</h2><p>${esc(S.name)} 集齊了 6 枚星球徽章，成為了傳說中的賽爾！</p>
    <p>你仍然可以繼續探索、捕捉精靈、完成圖鑑。</p><div class="row"><button id="x">繼續冒險</button></div>`, b => $('#x', b).onclick = closeModal);
}

// ---------------------------------------------------------------- input & boot
const KEYMAP = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right' };
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (KEYMAP[e.key]) { held.add(KEYMAP[e.key]); e.preventDefault(); }
  if (e.key === ' ' || e.key === 'Enter') { interact(); e.preventDefault(); }
  if (e.key === 'Escape' && isModalOpen() && !battle) closeModal();
});
addEventListener('keyup', e => { if (KEYMAP[e.key]) held.delete(KEYMAP[e.key]); });
document.querySelectorAll('#pad [data-dir]').forEach(b => {
  const d = b.dataset.dir;
  const on = e => { e.preventDefault(); if (d === 'act') interact(); else held.add(d); };
  const off = e => { e.preventDefault(); held.delete(d); };
  b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off);
});
document.querySelectorAll('#hud [data-act]').forEach(b => b.onclick = () => {
  if (battle || !S) return;
  ({ party: () => openParty(), bag: openBag, dex: openDex, save: () => save() })[b.dataset.act]();
});

addEventListener('resize', () => document.querySelectorAll('#battle .arena').forEach(cv => cv._anim && cv._anim.fit()));

function loop(t) {
  if (S) {
    if (!moving && !battle && !isModalOpen()) for (const d of ['up', 'down', 'left', 'right']) if (held.has(d)) { step(d); break; }
    render(t);
  }
  requestAnimationFrame(loop);
}

function titleScreen() {
  const existing = loadSave();
  modal(`<h2>賽爾號 · 單機版</h2>
    <p>非官方粉絲作品，使用 SeerAPI 整理的公開資料與素材。所有精靈圖像與資料版權歸上海淘米網絡科技有限公司所有，僅供學習交流。</p>
    <div class="row">${existing ? `<button id="cont">繼續遊戲（${esc(existing.name)} · 徽章 ${existing.badges}）</button>` : ''}<button id="new">新遊戲</button></div>`, b => {
    if (existing) $('#cont', b).onclick = () => { S = existing; closeModal(); enterZone(S.zone, S.x, S.y); };
    $('#new', b).onclick = () => newGame(!!existing);
  });
}

async function newGame(overwrite) {
  if (overwrite) { const c = await ask('新遊戲', '會覆蓋目前的存檔，確定嗎？', ['確定', '取消']); if (c) return titleScreen(); }
  let chosen = STARTERS[0];
  modal(`<h2>新的賽爾</h2><p>你的名字：</p><input type="text" id="nm" maxlength="12" value="小賽爾">
    <p>選擇你的第一隻精靈：</p><div class="grid">${STARTERS.map(id => `<div class="card big ${id === chosen ? 'sel' : ''}" data-id="${id}">
      <img src="${bodyImg(id)}" alt=""><b>${esc(pet(id).name)}</b><div>${comboName(pet(id).type)}</div></div>`).join('')}</div>
    <div class="row"><button id="go">出發！</button></div>`, b => {
    b.querySelectorAll('[data-id]').forEach(c => c.onclick = () => {
      chosen = +c.dataset.id; b.querySelectorAll('[data-id]').forEach(x => x.classList.toggle('sel', x === c));
    });
    $('#go', b).onclick = () => {
      S = newSave(($('#nm', b).value || '小賽爾').trim(), chosen);
      closeModal(); enterZone(0, 9, 9); save(true); npcGuide();
    };
  });
}

(async function boot() {
  ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('載入資料中…', 320, 224);
  D = await (await fetch('data.json')).json();
  requestAnimationFrame(loop);
  titleScreen();
})();
