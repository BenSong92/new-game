// ============================================================
// 천로역정 협동 장애물 코스 — 클라이언트 (Three.js 렌더링 + Socket.IO 동기화)
// ============================================================

const els = {};
let scene, camera, renderer, clock;
let socket = null;
let myId = null;
let levelStart = 0;
let serverOffset = 0;
let camYaw = Math.PI / 2; // 코스가 +X 방향으로 이어지므로 기본 카메라가 그 방향을 보게 함
const keys = {};
let touchJumpHeld = false; // 점프 버튼을 누르고 있는 동안 true (가변 점프 높이 판정에 필요)
let touchGrabHeld = false; // 잡기 버튼을 누르고 있는 동안 true
let dragging = false, dragPointerId = null, lastPointerX = 0;
const touchMove = { active: false, ix: 0, iz: 0, pointerId: null };

const entities = new Map(); // id -> { mesh, name, color, current:{x,y,z}, target:{x,y,z}, yaw }
const kinematicMeshes = []; // parallel to LEVEL.kinematics
const grabLines = new Map(); // "grabberId|targetId" -> THREE.Line (붙잡고 있는 동안만 존재)

// 구역(체크포인트)마다 하늘/안개/조명을 다르게 해서 천로역정 각 단계의 분위기를 낸다.
// 구역이 바뀔 때 색이 뚝 끊기지 않도록 loop()에서 매 프레임 targetTheme 쪽으로 서서히 보간한다.
// 각 테마는 원작 지명이 아니라 shared/level.js에서 다시 그린 현대적 구간 이름을 따라간다
// (아침의 방 → 밀린 과제의 늪 → 귀가길의 문 → 미루기의 계단 → 불안한 밤 →
//  피드의 소용돌이 → 방관자의 벌판 → 흘러가는 시간 → 진짜 쉼).
const ZONE_THEMES = {
  cp0: { bg: '#d9c9a3', fogNear: 100, fogFar: 380, hemi: '#fff2df', hemiI: 0.95, sun: '#fff0c8', sunI: 0.9 }, // 아침의 방
  cp0b: { bg: '#c9a876', fogNear: 90, fogFar: 350, hemi: '#f2e6c8', hemiI: 0.88, sun: '#f6e2b0', sunI: 0.82 },
  cp1: { bg: '#5c6a52', fogNear: 40, fogFar: 170, hemi: '#c9d3b0', hemiI: 0.6, sun: '#dce8c0', sunI: 0.55 }, // 밀린 과제의 늪
  cp2: { bg: '#bcd7ec', fogNear: 110, fogFar: 420, hemi: '#ffffff', hemiI: 1.05, sun: '#ffffff', sunI: 1.0 }, // 귀가길의 문
  cp3: { bg: '#93887a', fogNear: 90, fogFar: 340, hemi: '#e8dcc8', hemiI: 0.85, sun: '#ffe6b8', sunI: 1.05 }, // 미루기의 계단
  cp4: { bg: '#14161e', fogNear: 20, fogFar: 110, hemi: '#3a3f52', hemiI: 0.5, sun: '#5a6a8c', sunI: 0.4 }, // 불안한 밤
  cp5: { bg: '#c9439a', fogNear: 110, fogFar: 380, hemi: '#ffd7ec', hemiI: 1.05, sun: '#fff0ff', sunI: 1.0 }, // 피드의 소용돌이
  cp5b: { bg: '#7a9a5a', fogNear: 90, fogFar: 340, hemi: '#e6f0c8', hemiI: 0.9, sun: '#eef7cf', sunI: 0.85 }, // 방관자의 벌판
  cpR: { bg: '#1f5a7a', fogNear: 60, fogFar: 260, hemi: '#bfe6ea', hemiI: 0.8, sun: '#dff6ff', sunI: 0.75 }, // 흘러가는 시간
  cp6: { bg: '#f3e6ad', fogNear: 130, fogFar: 460, hemi: '#fff8e0', hemiI: 1.2, sun: '#fff6cf', sunI: 1.15 }, // 진짜 쉼
};
let hemiLight, sunLight;
let targetTheme = ZONE_THEMES.cp0;
const colorCache = new Map();
function cachedColor(hex) {
  let c = colorCache.get(hex);
  if (!c) { c = new THREE.Color(hex); colorCache.set(hex, c); }
  return c;
}
function applyZoneTheme(id) {
  const theme = ZONE_THEMES[id];
  if (theme) targetTheme = theme;
}

window.addEventListener('DOMContentLoaded', init);

function init() {
  cacheDom();
  bindUi();
  bindTouchControls();
  initThree();
  buildLevelMeshes();
  buildNpcMeshes();
  buildConscienceMeshes();
  buildForkSigns();

  window.addEventListener('keydown', (e) => {
    keys[e.key.toLowerCase()] = true;
  });
  window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
  window.addEventListener('resize', onResize);

  fetchRooms();
  roomPollTimer = setInterval(fetchRooms, 4000);

  clock = new THREE.Clock();
  requestAnimationFrame(loop);
}

function cacheDom() {
  els.lobby = document.getElementById('screen-lobby');
  els.world = document.getElementById('screen-world');
  els.nameInput = document.getElementById('name-input');
  els.roomList = document.getElementById('room-list');
  els.btnNewRoom = document.getElementById('btn-new-room');
  els.btnRefreshRooms = document.getElementById('btn-refresh-rooms');
  els.lobbyStatus = document.getElementById('lobby-status');
  els.canvasWrap = document.getElementById('canvas-wrap');
  els.zoneName = document.getElementById('zone-name');
  els.roster = document.getElementById('roster');
  els.fallenHint = document.getElementById('fallen-hint');
  els.victory = document.getElementById('victory-overlay');
  els.toast = document.getElementById('toast');
  els.joystickBase = document.getElementById('joystick-base');
  els.joystickKnob = document.getElementById('joystick-knob');
  els.jumpButton = document.getElementById('jump-button');
  els.grabButton = document.getElementById('grab-button');
  els.questStatus = document.getElementById('quest-status');
  els.buffStatus = document.getElementById('buff-status');
  els.burdenHud = document.getElementById('burden-hud');
  els.stampHud = document.getElementById('stamp-hud');
  els.victorySummary = document.getElementById('victory-summary');
  els.victoryTitle = document.getElementById('victory-title');
  els.victoryDesc1 = document.getElementById('victory-desc1');
  els.victoryDesc2 = document.getElementById('victory-desc2');
}

function bindTouchControls() {
  const base = els.joystickBase;
  const knob = els.joystickKnob;
  const maxRadius = 42;

  function setKnob(x, y) {
    knob.style.transform = `translate(${x}px, ${y}px)`;
  }

  base.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    touchMove.pointerId = e.pointerId;
    touchMove.active = true;
    base.setPointerCapture(e.pointerId);
  });
  base.addEventListener('pointermove', (e) => {
    if (e.pointerId !== touchMove.pointerId) return;
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const len = Math.hypot(dx, dy);
    if (len > maxRadius) { dx = (dx / len) * maxRadius; dy = (dy / len) * maxRadius; }
    setKnob(dx, dy);
    touchMove.ix = dx / maxRadius;
    touchMove.iz = -dy / maxRadius;
  });
  function releaseJoystick(e) {
    if (e.pointerId !== touchMove.pointerId) return;
    touchMove.active = false;
    touchMove.ix = 0; touchMove.iz = 0; touchMove.pointerId = null;
    setKnob(0, 0);
  }
  base.addEventListener('pointerup', releaseJoystick);
  base.addEventListener('pointercancel', releaseJoystick);

  els.jumpButton.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    touchJumpHeld = true;
  });
  const releaseJumpButton = () => { touchJumpHeld = false; };
  els.jumpButton.addEventListener('pointerup', releaseJumpButton);
  els.jumpButton.addEventListener('pointercancel', releaseJumpButton);
  els.jumpButton.addEventListener('pointerleave', releaseJumpButton);

  els.grabButton.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    touchGrabHeld = true;
  });
  const releaseGrabButton = () => { touchGrabHeld = false; };
  els.grabButton.addEventListener('pointerup', releaseGrabButton);
  els.grabButton.addEventListener('pointercancel', releaseGrabButton);
  els.grabButton.addEventListener('pointerleave', releaseGrabButton);
}

function bindUi() {
  els.btnNewRoom.addEventListener('click', () => joinGame('new'));
  els.btnRefreshRooms.addEventListener('click', fetchRooms);
  els.nameInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // 엔터는 가장 자리가 넉넉한 기존 방으로 바로 입장(없으면 새 방)하는 단축키
    const open = (lastRoomList || []).find((r) => r.count < r.max);
    joinGame(open ? open.id : 'new');
  });
}

// ---------- 방 목록 ----------
let roomPollTimer = null;
let lastRoomList = [];

async function fetchRooms() {
  try {
    const res = await fetch('/api/rooms');
    lastRoomList = await res.json();
    renderRoomList(lastRoomList);
  } catch (e) {
    els.roomList.innerHTML = '<p class="room-list-loading">방 목록을 불러올 수 없습니다.</p>';
  }
}

function renderRoomList(rooms) {
  if (!rooms.length) {
    els.roomList.innerHTML = '<p class="room-list-loading">열린 방이 없습니다 — "새 방 만들기"로 시작해주세요.</p>';
    return;
  }
  els.roomList.innerHTML = rooms.map((r) => {
    const full = r.count >= r.max;
    return `<button class="room-item${full ? ' full' : ''}" data-room-id="${escapeHtml(r.id)}" ${full ? 'disabled' : ''}>방 ${escapeHtml(r.id)} · ${r.count}/${r.max}명${full ? ' (가득 참)' : ''}</button>`;
  }).join('');
  els.roomList.querySelectorAll('.room-item').forEach((btn) => {
    btn.addEventListener('click', () => joinGame(btn.dataset.roomId));
  });
}

function setLobbyBusy(busy) {
  els.btnNewRoom.disabled = busy;
  els.btnRefreshRooms.disabled = busy;
  els.roomList.querySelectorAll('.room-item').forEach((b) => { b.disabled = busy || b.classList.contains('full'); });
}

function joinGame(roomId) {
  if (socket) return;
  setLobbyBusy(true);
  els.lobbyStatus.textContent = '서버에 접속하는 중...';
  socket = io();

  socket.on('connect', () => {
    socket.emit('join', { name: els.nameInput.value, roomId });
  });
  socket.on('connect_error', () => {
    els.lobbyStatus.textContent = '서버에 접속할 수 없습니다. 잠시 후 다시 시도해주세요.';
    socket = null;
    setLobbyBusy(false);
  });
  socket.on('joinError', (data) => {
    els.lobbyStatus.textContent = (data && data.reason === 'full')
      ? '그 방은 방금 가득 찼습니다. 다른 방을 골라주세요.'
      : '입장에 실패했습니다. 다시 시도해주세요.';
    socket.close();
    socket = null;
    setLobbyBusy(false);
    fetchRooms();
  });
  socket.on('joined', (data) => {
    myId = data.id;
    levelStart = data.levelStart;
    els.lobby.classList.add('hidden');
    els.world.classList.remove('hidden');
    clearInterval(roomPollTimer);
  });
  socket.on('roster', renderRoster);
  socket.on('state', onState);
  socket.on('victory', (data) => {
    renderVictorySummary(data);
    applyVictoryMessage(data);
    els.victory.classList.remove('hidden');
    spawnConfetti(140);
  });
  socket.on('toast', (data) => showToast(data && data.text, data && data.duration));
}

// ---------- 승리 축하 연출 ----------
const CONFETTI_COLORS = ['#c99a2e', '#e9d38a', '#c0392b', '#2e7d32', '#1f6fb2', '#8e44ad', '#fff2df'];
function spawnConfetti(count) {
  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece';
    el.style.left = Math.random() * 100 + 'vw';
    el.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    el.style.animationDuration = (2.2 + Math.random() * 1.8) + 's';
    el.style.animationDelay = (Math.random() * 0.6) + 's';
    el.style.transform = `rotate(${Math.random() * 360}deg)`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5200);
  }
}

let toastTimer = null;
function showToast(text, duration) {
  if (!text) return;
  els.toast.textContent = text;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), duration || 3200);
}

// ---------- 승리 화면: 각 순례자의 넓은/좁은 길 선택, 남은 짐, 양심의 선택 기록 요약 ----------
function renderVictorySummary(data) {
  if (!els.victorySummary) return;
  if (!data || !data.players) { els.victorySummary.innerHTML = ''; return; }
  const forkOrder = data.forkOrder || [];
  els.victorySummary.innerHTML = data.players.map((p) => {
    const stamps = forkOrder.map((forkId) => {
      const fork = LEVEL.forks.find((f) => f.id === forkId);
      const choice = p.choices ? p.choices[forkId] : null;
      const cls = choice === 'narrow' ? 'narrow' : (choice === 'wide' ? 'wide' : '');
      const icon = choice === 'narrow' ? '좁' : (choice === 'wide' ? '넓' : '?');
      const label = !fork ? '' : (choice === 'narrow' ? fork.narrowChoiceLabel : (choice === 'wide' ? fork.wideChoiceLabel : '선택 안 함'));
      return `<span class="stamp-item"><span class="stamp-slot ${cls}">${icon}</span><span class="stamp-label">${escapeHtml(label)}</span></span>`;
    }).join('');
    return `
      <div class="victory-player-row">
        <div class="vp-name"><span class="vp-dot" style="background:${p.color}"></span>${escapeHtml(p.name)}</div>
        <div class="vp-stamps">${stamps}</div>
        <div class="vp-note">남은 죄의 짐: ${p.burden}/4 · 양심의 선택: ${p.conscienceCount}/${data.conscienceTotal || 0}</div>
      </div>`;
  }).join('');
}

// 넓은 길을 한 번이라도 골랐는지(burden>0)에 따라 결말 문구를 다르게 보여준다 —
// "좁은 길을 끝까지 걸어온 사람만" 지금의 축하 문구를 보고, 나머지는 다른 문구를 본다.
// 플레이어마다 각자 자신의 기록으로 보므로 같은 화면에서도 사람마다 문구가 다를 수 있다.
function applyVictoryMessage(data) {
  const self = data && data.players && data.players.find((p) => p.id === myId);
  const wentAllNarrow = !!self && self.burden === 0;
  if (!els.victoryTitle) return;
  if (wentAllNarrow) {
    els.victoryTitle.textContent = '진짜 쉼에 도착했습니다';
    els.victoryDesc1.textContent = '"내가 선한 싸움을 싸우고 나의 달려갈 길을 마치고 믿음을 지켰으니"';
    els.victoryDesc2.textContent = '좁은 길을 끝까지 걸어왔습니다. 모든 짐을 내려놓고 도착했습니다!';
  } else {
    const burden = self ? self.burden : 4;
    els.victoryTitle.textContent = '도착은 했지만...';
    els.victoryDesc1.textContent = '넓은 길에서 잠깐은 편했지만, 죄의 짐은 끝내 다 내려놓지 못했습니다.';
    els.victoryDesc2.textContent = `남은 죄의 짐: ${burden}/4 — 다음엔 좁은 길로 한번 걸어보는 건 어떨까요?`;
  }
}

function renderRoster(list) {
  els.roster.innerHTML = '';
  list.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'roster-item' + (p.arrived ? ' arrived' : '');
    row.innerHTML = `<span class="roster-dot" style="background:${p.color}"></span><span>${escapeHtml(p.name)}</span>${p.arrived ? '<span class="roster-check">✔</span>' : ''}`;
    els.roster.appendChild(row);
  });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ---------- three.js ----------
function initThree() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9fb8c9);
  scene.fog = new THREE.Fog(0x9fb8c9, 120, 420);

  camera = new THREE.PerspectiveCamera(62, 1, 0.5, 1500);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  els.canvasWrap.appendChild(renderer.domElement);
  onResize();

  hemiLight = new THREE.HemisphereLight(0xffffff, 0x554433, 0.95);
  scene.add(hemiLight);
  sunLight = new THREE.DirectionalLight(0xfff3d6, 0.85);
  sunLight.position.set(150, 260, 100);
  scene.add(sunLight);

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (dragging) return;
    dragging = true;
    dragPointerId = e.pointerId;
    lastPointerX = e.clientX;
  });
  window.addEventListener('pointerup', (e) => {
    if (e.pointerId === dragPointerId) { dragging = false; dragPointerId = null; }
  });
  window.addEventListener('pointercancel', (e) => {
    if (e.pointerId === dragPointerId) { dragging = false; dragPointerId = null; }
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragPointerId) return;
    const dx = e.clientX - lastPointerX;
    lastPointerX = e.clientX;
    camYaw -= dx * 0.006;
  });
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function makeTextSprite(text, { size = 26, color = '#2a2016', bg = 'rgba(251,242,221,0.85)', scale = 8 } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const padding = 12;
  ctx.font = `bold ${size}px sans-serif`;
  const width = Math.ceil(ctx.measureText(text).width) + padding * 2;
  const height = size + padding * 2;
  canvas.width = width; canvas.height = height;
  ctx.font = `bold ${size}px sans-serif`;
  if (bg) {
    ctx.fillStyle = bg;
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(0, 0, width, height, 10); ctx.fill(); }
    else ctx.fillRect(0, 0, width, height);
  }
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, width / 2, height / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const aspect = width / height;
  sprite.scale.set(scale * aspect, scale, 1);
  return sprite;
}

// ---------- level geometry ----------
function buildLevelMeshes() {
  LEVEL.statics.forEach((piece) => {
    const mesh = buildPieceMesh(piece);
    if (mesh) {
      mesh.position.set(piece.pos.x, piece.pos.y, piece.pos.z);
      scene.add(mesh);
    }
  });
  LEVEL.kinematics.forEach((piece) => {
    const mesh = buildPieceMesh(piece);
    scene.add(mesh);
    kinematicMeshes.push(mesh);
  });
}

function buildPieceMesh(piece) {
  const mat = new THREE.MeshLambertMaterial({ color: piece.color || '#8a7a63' });
  if (piece.motion && piece.motion.type === 'blink') {
    mat.transparent = true; // 사라지기 직전 경고로 반투명하게 깜빡여야 하므로
  }
  if (piece.type === 'box' || piece.type === 'bar') {
    return new THREE.Mesh(new THREE.BoxGeometry(piece.size.x, piece.size.y, piece.size.z), mat);
  }
  if (piece.type === 'cylinder') {
    return new THREE.Mesh(new THREE.CylinderGeometry(piece.size.r, piece.size.r, piece.size.h, 20), mat);
  }
  if (piece.type === 'sphere') {
    return new THREE.Mesh(new THREE.SphereGeometry(piece.size.r, 16, 12), mat);
  }
  if (piece.type === 'plane_hazard') {
    mat.transparent = true;
    mat.opacity = 0.92;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(piece.size.x, piece.size.z), mat);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  }
  return null;
}

// ---------- player figures ----------
// 서버(server/index.js)의 PLAYER_RADIUS와 반드시 일치해야 함 — 물리 구체 중심(로컬 y=0)을
// 기준으로 발이 지면(y=-PLAYER_RADIUS)에 닿도록 캐릭터를 정렬한다.
const PLAYER_RADIUS = 1.4;

function buildPlayerFigure(color) {
  const g = new THREE.Group();
  const cloth = new THREE.MeshLambertMaterial({ color });
  const skin = new THREE.MeshLambertMaterial({ color: '#e0b088' });

  const groundY = -PLAYER_RADIUS;
  const legLen = 1.6, hipY = groundY + legLen;
  const torsoH = 1.4, torsoTop = hipY + torsoH;
  const armLen = 1.4, shoulderY = torsoTop - 0.1;
  const headR = 0.6, headY = torsoTop + headR;

  const torso = new THREE.Mesh(new THREE.BoxGeometry(1.5, torsoH, 0.85), cloth);
  torso.position.y = hipY + torsoH / 2;
  g.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(headR, 14, 10), skin);
  head.position.y = headY;
  g.add(head);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.36, 8),
    new THREE.MeshLambertMaterial({ color: '#2a2016' })
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, headY, headR * 0.9);
  g.add(nose);

  function makeLimb(length, r1, r2, x, y, mat) {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, length, 8), mat);
    mesh.position.y = -length / 2;
    pivot.add(mesh);
    g.add(pivot);
    return pivot;
  }

  const leftLeg = makeLimb(legLen, 0.24, 0.2, -0.45, hipY, cloth);
  const rightLeg = makeLimb(legLen, 0.24, 0.2, 0.45, hipY, cloth);
  const leftArm = makeLimb(armLen, 0.18, 0.16, -0.92, shoulderY, skin);
  const rightArm = makeLimb(armLen, 0.18, 0.16, 0.92, shoulderY, skin);

  g.userData.limbs = { leftLeg, rightLeg, leftArm, rightArm };
  g.userData.headTopY = headY + headR;
  return g;
}

// ---------- NPC (퀘스트를 주는 원작 등장인물) ----------
const npcMeshes = new Map(); // id -> { mesh, status, statusSprite }

function buildNpcFigure(npc) {
  const mesh = buildPlayerFigure(npc.robeColor);
  const label = makeTextSprite(npc.name, { scale: 1.15, bg: 'rgba(255,243,192,0.92)' });
  label.position.y = mesh.userData.headTopY + 0.5;
  mesh.add(label);
  return mesh;
}

const NPC_STATUS_ICON = { available: '!', active: '…', completed: '✔' };
const NPC_STATUS_COLOR = { available: '#ffe066', active: '#8fd3ff', completed: '#8fe38f' };

function setNpcStatus(entry, status) {
  if (entry.status === status) return;
  entry.status = status;
  if (entry.statusSprite) { entry.mesh.remove(entry.statusSprite); entry.statusSprite = null; }
  const icon = NPC_STATUS_ICON[status];
  if (!icon) return;
  const sprite = makeTextSprite(icon, { size: 34, scale: 1.6, bg: NPC_STATUS_COLOR[status], color: '#2a1a06' });
  sprite.position.y = entry.mesh.userData.headTopY + 1.5;
  entry.mesh.add(sprite);
  entry.statusSprite = sprite;
}

function buildNpcMeshes() {
  LEVEL.npcs.forEach((npc) => {
    const mesh = buildNpcFigure(npc);
    mesh.position.set(npc.pos.x, npc.pos.y, npc.pos.z);
    scene.add(mesh);
    npcMeshes.set(npc.id, { mesh, status: null, statusSprite: null });
  });
}

// ---------- 양심의 선택: 안내 없이 놓인 작은 물건 (수집돼도 특별한 시각효과 없음) ----------
function buildConscienceMeshes() {
  // 바닥 자연물처럼 보이지 않게, 누가 봐도 "떨어진 쓰레기"로 읽히는 색/형태(찌그러져 나뒹구는
  // 캔)를 쓴다 — 뭘 하는 물건인지는 여전히 설명하지 않는다.
  const geo = new THREE.CylinderGeometry(0.32, 0.32, 0.55, 10);
  const mat = new THREE.MeshLambertMaterial({ color: '#c0392b' });
  LEVEL.conscienceItems.forEach((item) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(item.pos.x, item.pos.y, item.pos.z);
    mesh.rotation.set(Math.PI / 2 + 0.2, 0.5, 0.3); // 쓰러져 굴러다니는 캔처럼 눕혀놓기
    scene.add(mesh);
  });
}

// ---------- 갈림길 레인 입구 표지판: "넓은 길/좁은 길" 대신 실제로 뭘 선택하는지 그대로 보여준다 ----------
function buildForkSigns() {
  LEVEL.forks.forEach((fork) => {
    const wideSign = makeTextSprite(fork.wideChoiceLabel || '넓은 길', { scale: 3.4, bg: 'rgba(201,165,63,0.9)', color: '#2a1a06' });
    wideSign.position.set(fork.wideTrigger.pos.x, fork.wideTrigger.pos.y + 3.5, fork.wideTrigger.pos.z);
    scene.add(wideSign);
    const narrowSign = makeTextSprite(fork.narrowChoiceLabel || '좁은 길', { scale: 3.4, bg: 'rgba(74,63,51,0.9)', color: '#fce9bb' });
    narrowSign.position.set(fork.narrowTrigger.pos.x, fork.narrowTrigger.pos.y + 3.5, fork.narrowTrigger.pos.z);
    scene.add(narrowSign);
  });
}

// ---------- 빌런 (구간 테마에 맞는 방해꾼 — 서버가 위치를 계산해 상태로 보내준다) ----------
const villainEntities = new Map(); // id -> { mesh, current:{x,y,z}, target:{x,y,z} }

function ensureVillainEntity(v) {
  let e = villainEntities.get(v.id);
  if (!e) {
    const def = LEVEL.villains.find((d) => d.id === v.id) || {};
    const mesh = buildPlayerFigure(def.color || '#3a1a1a');
    mesh.scale.setScalar(def.scale || 1.3);
    const label = makeTextSprite(def.name || '???', { scale: 1.0, bg: 'rgba(90,10,10,0.85)', color: '#ffe0e0' });
    label.position.y = mesh.userData.headTopY + 0.5;
    mesh.add(label);
    scene.add(mesh);
    e = { mesh, current: { ...v.pos }, target: { ...v.pos } };
    villainEntities.set(v.id, e);
  }
  e.target.x = v.pos.x; e.target.y = v.pos.y; e.target.z = v.pos.z;
  return e;
}

function animateWalk(e, dt) {
  const dx = e.current.x - (e.prevX ?? e.current.x);
  const dz = e.current.z - (e.prevZ ?? e.current.z);
  e.prevX = e.current.x; e.prevZ = e.current.z;
  const speed = Math.hypot(dx, dz) / Math.max(dt, 0.0001);
  const intensity = Math.min(1, speed / 7);
  e.walkPhase = (e.walkPhase || 0) + Math.min(speed, 22) * dt * 0.4;
  const swing = Math.sin(e.walkPhase) * 0.9 * intensity;
  const limbs = e.mesh.userData.limbs;
  if (!limbs) return;
  limbs.leftLeg.rotation.x = swing;
  limbs.rightLeg.rotation.x = -swing;
  limbs.leftArm.rotation.x = -swing * 0.75;
  limbs.rightArm.rotation.x = swing * 0.75;
}

function ensureEntity(p) {
  let e = entities.get(p.id);
  if (!e) {
    const mesh = buildPlayerFigure(p.color);
    const label = makeTextSprite(p.name, { scale: 1.1 });
    label.position.y = mesh.userData.headTopY + 0.5;
    mesh.add(label);
    scene.add(mesh);
    e = { mesh, current: { ...p.pos }, target: { ...p.pos }, yaw: p.yaw || 0, name: p.name };
    entities.set(p.id, e);
  }
  e.target.x = p.pos.x; e.target.y = p.pos.y; e.target.z = p.pos.z;
  e.yaw = p.yaw;
  return e;
}

// ---------- 양심의 선택(쓰레기): 주운 만큼 캐릭터 등에 실제로 매달려 붙어있는 것처럼 표시 ----------
const trashAttachGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.32, 8);
const trashAttachMat = new THREE.MeshLambertMaterial({ color: '#c0392b' });

function syncTrashAttachments(players) {
  players.forEach((p) => {
    const e = entities.get(p.id);
    if (!e) return;
    if (!e.trashGroup) {
      e.trashGroup = new THREE.Group();
      e.trashGroup.position.set(0, 2.0, -0.55); // 등 쪽에 짊어진 것처럼
      e.mesh.add(e.trashGroup);
      e.trashCount = 0;
    }
    const count = p.conscienceCount || 0;
    if (count === e.trashCount) return;
    while (e.trashGroup.children.length < count) {
      const i = e.trashGroup.children.length;
      const can = new THREE.Mesh(trashAttachGeo, trashAttachMat);
      can.rotation.set(Math.PI / 2 + (i % 3) * 0.35, i * 0.8, 0.25);
      can.position.set(((i % 3) - 1) * 0.26, Math.floor(i / 3) * 0.28, 0);
      e.trashGroup.add(can);
    }
    while (e.trashGroup.children.length > count) {
      e.trashGroup.remove(e.trashGroup.children[e.trashGroup.children.length - 1]);
    }
    e.trashCount = count;
  });
}

// ---------- 잡기: 붙잡고 있는 동안 두 사람 사이에 줄을 그려준다 ----------
function syncGrabLines(players) {
  const activeKeys = new Set();
  players.forEach((p) => {
    if (!p.grabbing) return;
    const key = p.id + '|' + p.grabbing;
    activeKeys.add(key);
    if (!grabLines.has(key)) {
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const mat = new THREE.LineBasicMaterial({ color: '#ff5533', linewidth: 3 });
      const line = new THREE.Line(geo, mat);
      scene.add(line);
      grabLines.set(key, line);
    }
  });
  Array.from(grabLines.keys()).forEach((key) => {
    if (!activeKeys.has(key)) {
      scene.remove(grabLines.get(key));
      grabLines.delete(key);
    }
  });
}

function updateGrabLinePositions() {
  grabLines.forEach((line, key) => {
    const [fromId, toId] = key.split('|');
    const a = entities.get(fromId), b = entities.get(toId);
    if (!a || !b) return;
    const pos = line.geometry.attributes.position;
    pos.setXYZ(0, a.current.x, a.current.y + 1.5, a.current.z);
    pos.setXYZ(1, b.current.x, b.current.y + 1.5, b.current.z);
    pos.needsUpdate = true;
  });
}

let prevSelfPos = null;
let hasArrivedBefore = false;
function onState(data) {
  serverOffset = data.serverNow - Date.now();

  const seen = new Set();
  data.players.forEach((p) => {
    seen.add(p.id);
    ensureEntity(p);
  });

  // 접속이 끊긴 플레이어 정리
  Array.from(entities.keys()).forEach((id) => {
    if (!seen.has(id)) {
      const e = entities.get(id);
      scene.remove(e.mesh);
      entities.delete(id);
    }
  });

  (data.villains || []).forEach((v) => ensureVillainEntity(v));
  syncGrabLines(data.players);
  syncTrashAttachments(data.players);

  const self = data.players.find((p) => p.id === myId);
  if (self) {
    if (prevSelfPos) {
      const dist = Math.hypot(self.pos.x - prevSelfPos.x, self.pos.y - prevSelfPos.y, self.pos.z - prevSelfPos.z);
      if (dist > 10) showFallenHint();
    }
    prevSelfPos = { ...self.pos };
    const cp = LEVEL.checkpoints[self.checkpoint];
    if (cp) {
      els.zoneName.textContent = cp.label;
      applyZoneTheme(cp.id);
    }
    updateQuestHud(self);
    updateBuffHud(self, data.players);
    updateBurdenHud(self);
    updateStampHud(self);
    if (self.arrived && !hasArrivedBefore) {
      hasArrivedBefore = true;
      showToast('진짜 쉼에 도착했습니다! 다른 순례자들을 기다려주세요...');
      spawnConfetti(45);
    }
  }
}

function updateQuestHud(self) {
  if (self.quest) {
    const npc = LEVEL.npcs.find((n) => n.id === self.quest.npcId);
    if (npc) {
      const remain = Math.max(0, Math.ceil((self.quest.deadline - (Date.now() + serverOffset)) / 1000));
      els.questStatus.textContent = `${npc.name}: ${npc.questLabel} (${remain}초)`;
      els.questStatus.classList.remove('hidden');
    }
  } else {
    els.questStatus.classList.add('hidden');
  }
  LEVEL.npcs.forEach((npc) => {
    const entry = npcMeshes.get(npc.id);
    if (!entry) return;
    let status = 'available';
    if (self.completedQuests && self.completedQuests.includes(npc.id)) status = 'completed';
    else if (self.quest && self.quest.npcId === npc.id) status = 'active';
    setNpcStatus(entry, status);
  });
}

function updateBuffHud(self, players) {
  const now = Date.now() + serverOffset;
  const chips = [];
  if (self.buffs) {
    if (self.buffs.speedUntil > now) chips.push(`⚡ 속도 강화 ${Math.ceil((self.buffs.speedUntil - now) / 1000)}초`);
    if (self.buffs.jumpUntil > now) chips.push(`⬆ 점프 강화 ${Math.ceil((self.buffs.jumpUntil - now) / 1000)}초`);
    if (self.buffs.shield) chips.push('🛡 천상의 갑주');
  }
  if (self.grabbing) {
    const target = players && players.find((p) => p.id === self.grabbing);
    chips.push(`🤝 ${target ? target.name : '누군가'}을(를) 붙잡는 중`);
  }
  if (self.grabbedBy) {
    const grabber = players && players.find((p) => p.id === self.grabbedBy);
    chips.push(`⚠ ${grabber ? grabber.name : '누군가'}에게 붙잡힘`);
  }
  if (self.conscienceCount > 0) {
    chips.push(`🗑 쓰레기 ${self.conscienceCount}개 (이동속도·점프력 +${self.conscienceCount * 2}%)`);
  }
  els.buffStatus.innerHTML = chips.map((c) => `<span class="buff-chip">${escapeHtml(c)}</span>`).join('');
}

let burdenHudCount = -1;
function updateBurdenHud(self) {
  const burden = typeof self.burden === 'number' ? self.burden : 4;
  if (burden === burdenHudCount) return;
  burdenHudCount = burden;
  let html = '';
  for (let i = 0; i < 4; i++) {
    html += `<span class="burden-icon${i < burden ? '' : ' removed'}"></span>`;
  }
  els.burdenHud.innerHTML = html;
}

let stampHudKey = '';
function updateStampHud(self) {
  const choices = self.choices || {};
  const key = LEVEL.forks.map((f) => choices[f.id] || '?').join(',');
  if (key === stampHudKey) return;
  stampHudKey = key;
  els.stampHud.innerHTML = LEVEL.forks.map((f) => {
    const c = choices[f.id];
    const cls = c === 'narrow' ? 'narrow' : (c === 'wide' ? 'wide' : '');
    const icon = c === 'narrow' ? '좁' : (c === 'wide' ? '넓' : '?');
    const label = c === 'narrow' ? f.narrowChoiceLabel : (c === 'wide' ? f.wideChoiceLabel : '아직 선택 전');
    return `<span class="stamp-slot ${cls}" title="${escapeHtml(label)}">${icon}</span>`;
  }).join('');
}

let fallenTimer = null;
function showFallenHint() {
  els.fallenHint.classList.remove('hidden');
  clearTimeout(fallenTimer);
  fallenTimer = setTimeout(() => els.fallenHint.classList.add('hidden'), 2200);
}

// ---------- input & camera ----------
function computeMoveVec() {
  let ix = (keys['d'] || keys['arrowright'] ? 1 : 0) - (keys['a'] || keys['arrowleft'] ? 1 : 0);
  let iz = (keys['w'] || keys['arrowup'] ? 1 : 0) - (keys['s'] || keys['arrowdown'] ? 1 : 0);
  if (touchMove.active) { ix = touchMove.ix; iz = touchMove.iz; }
  if (ix === 0 && iz === 0) return { x: 0, z: 0 };
  const fx = Math.sin(camYaw), fz = Math.cos(camYaw);
  const rx = -Math.cos(camYaw), rz = Math.sin(camYaw);
  let x = fx * iz + rx * ix;
  let z = fz * iz + rz * ix;
  const len = Math.hypot(x, z) || 1;
  return { x: x / len, z: z / len };
}

function sendInput() {
  if (!socket || !myId) return;
  const move = computeMoveVec();
  const e = entities.get(myId);
  if (e && (move.x !== 0 || move.z !== 0)) {
    e.yaw = Math.atan2(move.x, move.z);
  }
  const jumpHeld = !!keys[' '] || touchJumpHeld;
  const grabHeld = !!keys['e'] || touchGrabHeld;
  socket.emit('input', { x: move.x, z: move.z, jump: jumpHeld, grab: grabHeld, yaw: e ? e.yaw : 0 });
}

// ---------- loop ----------
function loop() {
  const dt = Math.min(0.05, clock.getDelta());

  if (myId) {
    sendInput();

    const t = (Date.now() + serverOffset - levelStart) / 1000;
    LEVEL.kinematics.forEach((piece, i) => {
      const { pos, angle, warn } = LEVEL.kinematicTransform(piece, t);
      const mesh = kinematicMeshes[i];
      mesh.position.set(pos.x, pos.y, pos.z);
      mesh.rotation.set(angle.x, angle.y, angle.z);
      if (piece.motion.type === 'blink') {
        // 사라지기 직전 깜빡이는 경고 — 사라진 뒤에는 위치 자체가 멀리 치워지므로 별도 처리 불필요
        mesh.material.opacity = warn ? (0.35 + 0.35 * Math.abs(Math.sin(t * 16))) : 1;
      }
    });

    // 구역 분위기(하늘/안개/조명)를 목표 테마 쪽으로 서서히 보간
    const themeSmooth = 1 - Math.pow(0.02, dt);
    scene.background.lerp(cachedColor(targetTheme.bg), themeSmooth);
    scene.fog.color.copy(scene.background);
    scene.fog.near += (targetTheme.fogNear - scene.fog.near) * themeSmooth;
    scene.fog.far += (targetTheme.fogFar - scene.fog.far) * themeSmooth;
    hemiLight.color.lerp(cachedColor(targetTheme.hemi), themeSmooth);
    hemiLight.intensity += (targetTheme.hemiI - hemiLight.intensity) * themeSmooth;
    sunLight.color.lerp(cachedColor(targetTheme.sun), themeSmooth);
    sunLight.intensity += (targetTheme.sunI - sunLight.intensity) * themeSmooth;

    const smooth = 1 - Math.pow(0.001, dt);
    entities.forEach((e) => {
      e.current.x += (e.target.x - e.current.x) * smooth;
      e.current.y += (e.target.y - e.current.y) * smooth;
      e.current.z += (e.target.z - e.current.z) * smooth;
      e.mesh.position.set(e.current.x, e.current.y, e.current.z);
      e.mesh.rotation.y = e.yaw;
      animateWalk(e, dt);
    });

    villainEntities.forEach((e) => {
      e.current.x += (e.target.x - e.current.x) * smooth;
      e.current.y += (e.target.y - e.current.y) * smooth;
      e.current.z += (e.target.z - e.current.z) * smooth;
      const ddx = e.current.x - (e.prevX ?? e.current.x);
      const ddz = e.current.z - (e.prevZ ?? e.current.z);
      if (Math.hypot(ddx, ddz) > 0.002) e.mesh.rotation.y = Math.atan2(ddx, ddz);
      e.mesh.position.set(e.current.x, e.current.y, e.current.z);
      animateWalk(e, dt); // 내부에서 prevX/prevZ를 이번 프레임 값으로 갱신함
    });

    updateGrabLinePositions();

    const self = entities.get(myId);
    if (self) {
      const dist = 26, height = 13;
      const camX = self.current.x - Math.sin(camYaw) * dist;
      const camZ = self.current.z - Math.cos(camYaw) * dist;
      camera.position.set(camX, self.current.y + height, camZ);
      camera.lookAt(self.current.x, self.current.y + 3, self.current.z);
    }

    renderer.render(scene, camera);
  }

  requestAnimationFrame(loop);
}
