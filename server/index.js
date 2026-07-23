// ============================================================
// 천로역정 협동 장애물 코스 — 서버 (권위 있는 물리 시뮬레이션)
// ============================================================

const path = require('path');
const express = require('express');
const { Server } = require('socket.io');
const CANNON = require('cannon-es');
const LEVEL = require('../shared/level.js');

const PORT = process.env.PORT || 3000;
const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const MAX_SPEED = 15;
const PLAYER_RADIUS = 1.4;
const GROUP_GROUND = 1;
const GROUP_PLAYER = 2;

// ---------- 마리오풍 점프 보정 ----------
const JUMP_SPEED = 14;          // 점프 버튼을 끝까지 눌렀을 때 초기 상승 속도
const COYOTE_MS = 120;          // 발판에서 떨어진 뒤에도 점프를 허용하는 유예시간
const JUMP_BUFFER_MS = 150;     // 착지 직전에 미리 누른 점프를 기억해두는 시간
const SHORT_HOP_CUT = 0.45;     // 상승 중 점프 버튼을 일찍 떼면 상승 속도에 곱하는 배율 (가변 점프 높이)
const GRAVITY_RISE = 28;        // 상승 구간 중력
const GRAVITY_FALL = 42;        // 하강 구간 중력 (더 강하게 — 스냅감 있는 낙하)
const GRAVITY_APEX = 12;        // 정점 부근 중력 (살짝 붕 뜨는 행타임)
const APEX_VY_THRESHOLD = 4;    // 이 속도 이하일 때 "정점 부근"으로 간주
// 접지 판정이 네트워크 지연/타이밍 오차로 순간적으로 흔들려도(레이캐스트 노이즈 등)
// 같은 점프 도중 점프가 여러 번 겹쳐 발사되어 비정상적으로 높이 뛰는 것을 막는 안전장치
const MIN_JUMP_INTERVAL_MS = 300;

const COLORS = ['#c0392b', '#2e7d32', '#1f6fb2', '#c99a2e', '#8e44ad', '#16a085', '#d35400', '#7f8c8d'];

// ---------- 방(room) ----------
// 부하 테스트 결과 한 방에 60Hz 틱이 안정적으로 유지되는 인원은 약 10~15명이었다.
// 방 하나당 최대 인원을 10명으로 제한하고, 꽉 차면 새 방을 만들거나 다른 방을 고르게 한다.
// 방 개수 자체는 (빈 방은 즉시 정리되므로) 사실상 문제가 안 되지만, 폭주 방지용 상한을 둔다.
const MAX_PLAYERS_PER_ROOM = 10;
const MAX_ROOMS = 20;
const rooms = new Map(); // roomId -> Room
let roomSeq = 0;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));
app.get('/api/rooms', (req, res) => {
  res.json(Array.from(rooms.values()).map((r) => ({
    id: r.id, count: r.players.size, max: MAX_PLAYERS_PER_ROOM,
  })));
});
const httpServer = require('http').createServer(app);
const io = new Server(httpServer);

// ---------- physics materials ----------
// Material은 world에 종속되지 않으므로(월드마다 다시 만들 필요 없이) 모든 방이 공유한다.
// 캐릭터는 매 틱 속도를 직접 지정해서 움직이므로(마찰로 가감속하지 않음),
// 기본 마찰이 남아있으면 지면과의 접촉 마찰이 매 스텝 속도를 갉아먹어
// 실제 이동속도가 MAX_SPEED보다 한참 느려지는 문제가 생긴다. 마찰/반발 0으로 고정.
const groundMaterial = new CANNON.Material('ground');
const playerMaterial = new CANNON.Material('player');

// cannon-es는 body.aabb를 "다른 바디와 한 번이라도 broadphase 페어링된 뒤"에야 채운다
// (body.updateAABB()를 직접 부르지 않는 한). 새로 만든 static/kinematic 바디가
// 마침 그 첫 페어링 기회를 놓치면(예: 아직 초기화 안 된 aabb끼리 비교해 "너무 멀다"고
// 오판하는 경우), raycastClosest가 그 바디를 영원히 후보에서 빠뜨려 접지 판정이
// 계속 false로 나온다 — "좁은 문" 구간에서 점프가 전혀 안 되던 버그의 원인이었다.
// 생성 직후 명시적으로 updateAABB()를 호출해 이 문제를 근본적으로 막는다.
function makeStaticBody(world, piece) {
  if (piece.type === 'plane_hazard') return null; // 시각 전용, 충돌체 없음
  let shape;
  if (piece.type === 'box') {
    shape = new CANNON.Box(new CANNON.Vec3(piece.size.x / 2, piece.size.y / 2, piece.size.z / 2));
  } else if (piece.type === 'cylinder') {
    shape = new CANNON.Cylinder(piece.size.r, piece.size.r, piece.size.h, 16);
  } else {
    return null;
  }
  const body = new CANNON.Body({
    mass: 0, shape, material: groundMaterial,
    collisionFilterGroup: GROUP_GROUND, collisionFilterMask: GROUP_PLAYER,
  });
  body.position.set(piece.pos.x, piece.pos.y, piece.pos.z);
  world.addBody(body);
  body.updateAABB(); // 위 주석 참고 — 생성 직후 명시적으로 갱신해야 함
  return body;
}

// 'bar'(진자/회전 장대)와 'sphere'(롤러, 궤도 장애물)는 카논 물리 바디를 만들지 않는다 —
// 우리 이동 모델은 매 틱 velocity.x/z를 입력값으로 강제 지정하는데, 빠르게 움직이는
// kinematic 바디에 대한 카논의 충돌 반응(밀어내기)이 바로 다음 틱에 그 강제 지정으로
// 덮어써져 사실상 무력화된다 — 실제로 최소 재현 스크립트로 "플레이어가 롤러를 그냥
// 뚫고 지나가는" 것을 확인했다("장애물이 그냥 통과된다"는 버그 리포트의 원인).
// 대신 아래 updateHazards()에서 매 틱 순수 거리 계산으로 직접 충돌/넉백을 처리한다
// (이미 검증된 빌런 시스템과 동일한 패턴). 'box'/'cylinder'(발판류 — 늪 디딤돌, 회전
// 무대, 연잎 등 위에 올라서는 것들)는 그대로 카논 물리를 쓴다 — 수직으로 서있는
// 상호작용은 별도 테스트로 정상 작동을 확인했고, 굳이 바꿀 이유가 없다.
function makeKinematicBody(world, piece) {
  let shape;
  if (piece.type === 'box') {
    shape = new CANNON.Box(new CANNON.Vec3(piece.size.x / 2, piece.size.y / 2, piece.size.z / 2));
  } else if (piece.type === 'cylinder') {
    shape = new CANNON.Cylinder(piece.size.r, piece.size.r, piece.size.h, 16);
  } else {
    return null; // bar, sphere 등은 아래 hazardKinematics에서 별도 처리
  }
  const body = new CANNON.Body({
    mass: 0,
    type: CANNON.Body.KINEMATIC,
    shape,
    material: groundMaterial,
    collisionFilterGroup: GROUP_GROUND,
    collisionFilterMask: GROUP_PLAYER,
  });
  body.position.set(piece.pos.x, piece.pos.y, piece.pos.z);
  world.addBody(body);
  body.updateAABB();
  return body;
}

// 순수 거리 계산으로 직접 충돌을 처리하는 "위험물" 종류 (bar: 회전/진자 장대, sphere: 롤러·궤도 장애물).
// 바디가 없는 순수 데이터라 방마다 다시 만들 필요 없이 전부 공유한다.
const hazardKinematics = LEVEL.kinematics.filter((p) => p.type === 'bar' || p.type === 'sphere');
const HAZARD_KNOCK_H = 12, HAZARD_KNOCK_V = 6; // 빌런보다는 약하게 — 성난 몬스터가 아니라 환경 장애물이므로
const _hazardQ = new CANNON.Quaternion();
const _hazardRel = new CANNON.Vec3();

// box(회전/진자 장대)는 회전을 고려해 로컬 좌표계로 변환한 뒤 가장 가까운 점을 구하고,
// sphere(롤러 등)는 단순 중심간 거리로 판정한다.
function hazardHitDistSq(piece, pos, angle, playerPos) {
  if (piece.type === 'sphere') {
    const dx = playerPos.x - pos.x, dy = playerPos.y - pos.y, dz = playerPos.z - pos.z;
    const r = piece.size.r + PLAYER_RADIUS;
    const distSq = dx * dx + dy * dy + dz * dz;
    return { hit: distSq < r * r, pushX: dx, pushZ: dz };
  }
  // bar: 회전된 박스 — 플레이어 위치를 박스의 로컬 좌표계로 변환
  _hazardQ.setFromEuler(angle.x, angle.y, angle.z);
  _hazardRel.set(playerPos.x - pos.x, playerPos.y - pos.y, playerPos.z - pos.z);
  const local = _hazardQ.inverse().vmult(_hazardRel);
  const hx = piece.size.x / 2, hy = piece.size.y / 2, hz = piece.size.z / 2;
  const cx = Math.max(-hx, Math.min(hx, local.x));
  const cy = Math.max(-hy, Math.min(hy, local.y));
  const cz = Math.max(-hz, Math.min(hz, local.z));
  const dx = local.x - cx, dy = local.y - cy, dz = local.z - cz;
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq >= PLAYER_RADIUS * PLAYER_RADIUS) return { hit: false };
  // 가장 가까운 점을 다시 월드 좌표로 돌려서 미는 방향을 구한다
  const closestWorld = _hazardQ.vmult(new CANNON.Vec3(cx, cy, cz));
  return { hit: true, pushX: playerPos.x - (pos.x + closestWorld.x), pushZ: playerPos.z - (pos.z + closestWorld.z) };
}

// ---------- checkpoint / npc lookup (읽기 전용 참조 데이터라 방마다 다시 만들 필요 없음) ----------
const cpIndex = {};
LEVEL.checkpoints.forEach((cp, i) => { cpIndex[cp.id] = i; });
const npcById = {};
LEVEL.npcs.forEach((n) => { npcById[n.id] = n; });

function clampNum(v, lo, hi) {
  v = typeof v === 'number' && !isNaN(v) ? v : 0;
  return Math.max(lo, Math.min(hi, v));
}

// ============================================================
// Room — 방 하나당 독립된 물리 월드/플레이어 목록/틱 루프를 갖는다.
// 방끼리는 서로의 존재를 모른다(브로드캐스트도 io.to(room.id)로 그 방에만 보낸다).
// ============================================================
class Room {
  constructor(id) {
    this.id = id;
    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0) });
    // SAPBroadphase는 특정 상황(레이캐스트의 aabbQuery 등)에서 실제로 겹쳐있는데도
    // 후보에서 빠뜨리는 경우가 있었다 — 바디 수가 적어(수십 개) 성능 차이가 미미하므로
    // 항상 정확한 NaiveBroadphase로 교체.
    this.world.broadphase = new CANNON.NaiveBroadphase();
    this.world.allowSleep = false;
    this.world.addContactMaterial(new CANNON.ContactMaterial(groundMaterial, playerMaterial, {
      friction: 0, restitution: 0,
    }));

    // LEVEL.statics/kinematics와 같은 순서로 나란히 대응하는 이 방 전용 바디 배열.
    // (예전엔 piece.body에 직접 붙였는데, 방이 여러 개면 서로 덮어써서 안 된다.)
    this.staticBodies = LEVEL.statics.map((p) => makeStaticBody(this.world, p));
    this.kinematicBodies = LEVEL.kinematics.map((p) => makeKinematicBody(this.world, p));

    this.villainStates = LEVEL.villains.map((v) => ({
      ...v,
      pos: { x: v.anchor.x, y: v.anchor.y, z: v.anchor.z },
      patrolPhase: Math.random() * Math.PI * 2,
    }));

    this.players = new Map(); // socketId -> player state
    this.colorCursor = 0;
    this.victoryFired = false;
    this.levelStart = Date.now();
    this.lastTickTime = Date.now();

    this.interval = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  elapsed() { return (Date.now() - this.levelStart) / 1000; }

  spawnPosition() {
    const jitter = () => (Math.random() - 0.5) * 3;
    return { x: LEVEL.spawn.x + jitter(), y: LEVEL.spawn.y + 2, z: LEVEL.spawn.z + jitter() };
  }

  createPlayer(socket, name) {
    const pos = this.spawnPosition();
    const shape = new CANNON.Sphere(PLAYER_RADIUS);
    const body = new CANNON.Body({
      mass: 5,
      shape,
      material: playerMaterial,
      position: new CANNON.Vec3(pos.x, pos.y, pos.z),
      fixedRotation: true,
      linearDamping: 0,
      angularDamping: 0,
      collisionFilterGroup: GROUP_PLAYER,
      collisionFilterMask: GROUP_GROUND,
    });
    this.world.addBody(body);
    body.updateAABB();

    const color = COLORS[this.colorCursor % COLORS.length];
    this.colorCursor++;

    const player = {
      id: socket.id,
      socket,
      name: name && name.trim() ? name.trim().slice(0, 16) : '순례자',
      color,
      body,
      yaw: 0,
      input: { x: 0, z: 0, jump: false },
      prevInputJump: false,
      wasGrounded: false,
      lastGroundedAt: -Infinity,
      jumpBufferedAt: -Infinity,
      jumpFiredThisContact: false,
      lastJumpFiredAt: 0,
      jumpCut: false,
      lastCheckpoint: 'cp0',
      lastCheckpointPos: { ...LEVEL.spawn, y: LEVEL.spawn.y + 2 },
      arrived: false,
      quest: null,
      completedQuests: new Set(),
      burden: 4,
      choices: {},
      seenForks: new Set(),
      crossedForks: new Set(),
      conscienceCollected: new Set(),
      hillGateBounceUntil: 0,
      buffSpeedMult: 1, buffSpeedUntil: 0,
      buffJumpMult: 1, buffJumpUntil: 0,
      shield: false,
      invulnerableUntil: 0,
    };
    this.players.set(socket.id, player);
    return player;
  }

  removePlayer(socket) {
    const p = this.players.get(socket.id);
    if (!p) return;
    this.world.removeBody(p.body);
    this.players.delete(socket.id);
  }

  broadcastRoster() {
    io.to(this.id).emit('roster', Array.from(this.players.values()).map((p) => ({
      id: p.id, name: p.name, color: p.color, arrived: p.arrived,
    })));
  }

  isGrounded(body) {
    const from = new CANNON.Vec3(body.position.x, body.position.y - PLAYER_RADIUS + 0.05, body.position.z);
    const to = new CANNON.Vec3(body.position.x, body.position.y - PLAYER_RADIUS - 0.55, body.position.z);
    const result = new CANNON.RaycastResult();
    this.world.raycastClosest(from, to, { collisionFilterMask: GROUP_GROUND }, result);
    return result.hasHit;
  }

  applyReward(p, npc) {
    const now = Date.now();
    if (npc.rewardType === 'speed') {
      p.buffSpeedMult = npc.rewardValue;
      p.buffSpeedUntil = now + npc.rewardDuration;
    } else if (npc.rewardType === 'jump') {
      p.buffJumpMult = npc.rewardValue;
      p.buffJumpUntil = now + npc.rewardDuration;
    } else if (npc.rewardType === 'shield') {
      p.shield = true;
    }
    p.socket.emit('toast', { text: `${npc.name}에게서 보상을 받았습니다: ${npc.rewardLabel}` });
  }

  // ---------- 퀘스트: NPC 근처에 가면 자동 수락, 목표 체크포인트에 제한시간 안에 닿으면 완료 ----------
  updateQuests(now) {
    this.players.forEach((p) => {
      if (!p.quest) {
        for (const npc of LEVEL.npcs) {
          if (p.completedQuests.has(npc.id)) continue;
          const dx = p.body.position.x - npc.pos.x;
          const dz = p.body.position.z - npc.pos.z;
          if (Math.hypot(dx, dz) < npc.radius) {
            p.quest = { npcId: npc.id, deadline: now + npc.timeLimit * 1000 };
            p.socket.emit('toast', { text: `${npc.name}: ${npc.questLabel}` });
            break;
          }
        }
      }
      if (p.quest) {
        const npc = npcById[p.quest.npcId];
        if (!npc) { p.quest = null; return; }
        if (cpIndex[p.lastCheckpoint] >= cpIndex[npc.targetCpId]) {
          p.completedQuests.add(npc.id);
          this.applyReward(p, npc);
          p.quest = null;
        } else if (now > p.quest.deadline) {
          p.socket.emit('toast', { text: `${npc.name}의 퀘스트에 실패했습니다 — 다시 찾아가면 재도전할 수 있습니다.` });
          p.quest = null;
        }
      }
    });
  }

  // ---------- 넓은 길/좁은 길 갈림길: 진입 안내 → 레인 선택 감지 → 십자가에서 짐 제거 ----------
  updateForks(now) {
    this.players.forEach((p) => {
      for (const fork of LEVEL.forks) {
        if (!p.seenForks.has(fork.id)) {
          const dx = p.body.position.x - fork.entryTrigger.pos.x;
          const dz = p.body.position.z - fork.entryTrigger.pos.z;
          if (Math.hypot(dx, dz) < fork.entryTrigger.radius) {
            p.seenForks.add(fork.id);
            p.socket.emit('toast', { text: fork.dilemmaText, duration: 5200 });
          }
        }
        if (!p.choices[fork.id]) {
          const wdx = p.body.position.x - fork.wideTrigger.pos.x;
          const wdz = p.body.position.z - fork.wideTrigger.pos.z;
          const ndx = p.body.position.x - fork.narrowTrigger.pos.x;
          const ndz = p.body.position.z - fork.narrowTrigger.pos.z;
          if (Math.hypot(wdx, wdz) < fork.wideTrigger.radius) {
            p.choices[fork.id] = 'wide';
            p.buffSpeedMult = FORK_WIDE_BUFF_MULT;
            p.buffSpeedUntil = now + FORK_WIDE_BUFF_MS;
            p.socket.emit('toast', { text: `선택: ${fork.wideChoiceLabel} — ${fork.wideRewardLabel}` });
          } else if (Math.hypot(ndx, ndz) < fork.narrowTrigger.radius) {
            p.choices[fork.id] = 'narrow';
            p.socket.emit('toast', { text: `선택: ${fork.narrowChoiceLabel}` });
          }
        }
        if (p.choices[fork.id] === 'narrow' && p.burden > 0 && !p.crossedForks.has(fork.id)) {
          const cdx = p.body.position.x - fork.crossTrigger.pos.x;
          const cdz = p.body.position.z - fork.crossTrigger.pos.z;
          if (Math.hypot(cdx, cdz) < fork.crossTrigger.radius) {
            p.crossedForks.add(fork.id);
            p.burden -= 1;
            p.socket.emit('toast', { text: `십자가 아래에서 죄의 짐을 내려놓았습니다 (남은 짐 ${p.burden}/4)` });
          }
        }
      }
    });
  }

  // ---------- 고난의 언덕 짐-게이트: 짐이 남아있으면 우회 계단 입구에서 밀어낸다 ----------
  updateHillGate(now) {
    const gate = LEVEL.hillGate;
    if (!gate) return;
    this.players.forEach((p) => {
      if (p.burden <= 0) return;
      if (now < p.hillGateBounceUntil) return;
      const dx = p.body.position.x - gate.shortLaneTrigger.pos.x;
      const dz = p.body.position.z - gate.shortLaneTrigger.pos.z;
      if (Math.hypot(dx, dz) < gate.shortLaneTrigger.radius) {
        p.body.velocity.x = -HILL_GATE_KNOCK_H;
        p.body.velocity.z = 0;
        p.body.velocity.y = HILL_GATE_KNOCK_V;
        p.hillGateBounceUntil = now + HILL_GATE_COOLDOWN_MS;
        p.socket.emit('toast', { text: '짐이 아직 남아 있습니다 — 고난의 계단으로 돌아가야 합니다.' });
      }
    });
  }

  // ---------- 양심의 선택: 안내 없이 놓인 아이템, 조용히 기록만 (강제 회수 없음) ----------
  updateConscience(now) {
    this.players.forEach((p) => {
      for (const item of LEVEL.conscienceItems) {
        if (p.conscienceCollected.has(item.id)) continue;
        const dx = p.body.position.x - item.pos.x;
        const dy = p.body.position.y - item.pos.y;
        const dz = p.body.position.z - item.pos.z;
        if (dx * dx + dy * dy + dz * dz < item.radius * item.radius) {
          p.conscienceCollected.add(item.id);
          p.socket.emit('toast', { text: '무언가를 정리했습니다.' });
        }
      }
    });
  }

  updateHazards(t, now) {
    this.players.forEach((p) => {
      if (now < p.invulnerableUntil) return;
      for (const piece of hazardKinematics) {
        const { pos, angle } = LEVEL.kinematicTransform(piece, t);
        const result = hazardHitDistSq(piece, pos, angle, p.body.position);
        if (result.hit) {
          const d = Math.hypot(result.pushX, result.pushZ) || 1;
          p.body.velocity.x = (result.pushX / d) * HAZARD_KNOCK_H;
          p.body.velocity.z = (result.pushZ / d) * HAZARD_KNOCK_H;
          p.body.velocity.y = HAZARD_KNOCK_V;
          p.invulnerableUntil = now + 700;
          break;
        }
      }
    });
  }

  // ---------- 빌런 AI: anchor 주변을 서성이다 플레이어가 가까이 오면 쫓아온다 ----------
  updateVillains(simDt, now) {
    this.villainStates.forEach((v) => {
      let nearest = null, nearestDist = Infinity;
      this.players.forEach((p) => {
        const dx = p.body.position.x - v.anchor.x;
        const dz = p.body.position.z - v.anchor.z;
        if (Math.hypot(dx, dz) < v.chaseRadius) {
          const pd = Math.hypot(p.body.position.x - v.pos.x, p.body.position.z - v.pos.z);
          if (pd < nearestDist) { nearestDist = pd; nearest = p; }
        }
      });
      if (nearest) {
        const dx = nearest.body.position.x - v.pos.x;
        const dz = nearest.body.position.z - v.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        const step = Math.min(d, v.speed * simDt);
        v.pos.x += (dx / d) * step;
        v.pos.z += (dz / d) * step;
      } else {
        v.patrolPhase += simDt * 0.6;
        v.pos.x = v.anchor.x + Math.sin(v.patrolPhase) * v.patrolRadius;
        v.pos.z = v.anchor.z + Math.cos(v.patrolPhase * 0.7) * v.patrolRadius;
      }
      const ax = v.pos.x - v.anchor.x, az = v.pos.z - v.anchor.z;
      const ad = Math.hypot(ax, az);
      const leash = v.chaseRadius * 1.15;
      if (ad > leash) {
        v.pos.x = v.anchor.x + (ax / ad) * leash;
        v.pos.z = v.anchor.z + (az / ad) * leash;
      }
    });

    this.players.forEach((p) => {
      if (now < p.invulnerableUntil) return;
      for (const v of this.villainStates) {
        const dx = p.body.position.x - v.pos.x;
        const dy = p.body.position.y - v.pos.y;
        const dz = p.body.position.z - v.pos.z;
        const hitR = v.hitRadius + PLAYER_RADIUS;
        if (dx * dx + dy * dy + dz * dz < hitR * hitR) {
          if (v.pullToWide) {
            const dSign = dx === 0 ? 1 : Math.sign(dx);
            p.body.velocity.x = dSign * v.knockH * 0.35;
            p.body.velocity.z = v.knockH;
            p.body.velocity.y = v.knockV;
            p.socket.emit('toast', { text: `${v.name}에게 붙잡혀 넓은 길 쪽으로 떠밀렸습니다!` });
          } else {
            const d = Math.hypot(dx, dz) || 1;
            p.body.velocity.x = (dx / d) * v.knockH;
            p.body.velocity.z = (dz / d) * v.knockH;
            p.body.velocity.y = v.knockV;
            p.socket.emit('toast', { text: `${v.name}에게 당했습니다!` });
          }
          p.invulnerableUntil = now + 1500;
          break;
        }
      }
    });
  }

  checkAllArrived() {
    if (this.victoryFired) return;
    const list = Array.from(this.players.values());
    if (list.length === 0) return;
    if (list.every((p) => p.arrived)) {
      this.victoryFired = true;
      io.to(this.id).emit('victory', {
        players: list.map((p) => ({
          id: p.id, name: p.name, color: p.color,
          burden: p.burden, choices: p.choices, conscienceCount: p.conscienceCollected.size,
        })),
        conscienceTotal: LEVEL.conscienceItems.length,
        forkOrder: LEVEL.forks.map((f) => f.id),
      });
    }
  }

  // ---------- fixed-step simulation loop (방마다 독립) ----------
  // Windows에서는 setInterval(16.7ms)이 타이머 해상도 문제로 실제로는 더 느리게(약 30Hz)
  // 호출되는 경우가 있다. world.step에 고정 DT만 넘기면 그만큼 시뮬레이션 전체가 "슬로우
  // 모션"처럼 느려지므로(이동 속도·점프 궤적 모두 영향), 실제 경과 시간을 측정해서 필요한
  // 만큼 서브스텝을 돌린다.
  tick() {
    const t = this.elapsed();
    const now = Date.now();
    const timeSinceLastCalled = (now - this.lastTickTime) / 1000;
    this.lastTickTime = now;

    this.kinematicBodies.forEach((body, i) => {
      if (!body) return;
      const piece = LEVEL.kinematics[i];
      const { pos, angle } = LEVEL.kinematicTransform(piece, t);
      body.position.set(pos.x, pos.y, pos.z);
      body.quaternion.setFromEuler(angle.x, angle.y, angle.z);
    });

    const simDt = Math.min(timeSinceLastCalled, DT * 5); // cannon의 maxSubSteps(5)와 동일하게 캡핑

    this.players.forEach((p) => {
      const grounded = this.isGrounded(p.body);
      if (grounded && !p.wasGrounded) {
        p.jumpFiredThisContact = false;
      }
      if (grounded) {
        p.lastGroundedAt = now;
        p.jumpCut = false;
      }
      p.wasGrounded = grounded;

      if (p.input.jump && !p.prevInputJump) {
        p.jumpBufferedAt = now;
      }
      p.prevInputJump = p.input.jump;

      const burdenMult = 1 - p.burden * 0.035;
      const speedMult = (now < p.buffSpeedUntil ? p.buffSpeedMult : 1) * burdenMult;
      p.body.velocity.x = p.input.x * MAX_SPEED * speedMult;
      p.body.velocity.z = p.input.z * MAX_SPEED * speedMult;

      const withinCoyote = now - p.lastGroundedAt <= COYOTE_MS;
      const jumpRequested = p.input.jump || (now - p.jumpBufferedAt <= JUMP_BUFFER_MS);
      const cooldownOk = now - (p.lastJumpFiredAt || 0) >= MIN_JUMP_INTERVAL_MS;

      if (withinCoyote && jumpRequested && !p.jumpFiredThisContact && cooldownOk) {
        const jumpMult = (now < p.buffJumpUntil ? p.buffJumpMult : 1) * burdenMult;
        p.body.velocity.y = JUMP_SPEED * jumpMult;
        p.jumpFiredThisContact = true;
        p.lastJumpFiredAt = now;
        p.jumpBufferedAt = -Infinity;
        p.lastGroundedAt = -Infinity;
        p.jumpCut = false;
      } else if (!p.input.jump && p.body.velocity.y > 0 && !p.jumpCut) {
        p.body.velocity.y *= SHORT_HOP_CUT;
        p.jumpCut = true;
      }

      let g;
      if (p.body.velocity.y > APEX_VY_THRESHOLD) g = GRAVITY_RISE;
      else if (p.body.velocity.y < -APEX_VY_THRESHOLD) g = GRAVITY_FALL;
      else g = GRAVITY_APEX;
      p.body.velocity.y -= g * simDt;
    });

    this.world.step(DT, timeSinceLastCalled, 5);
    this.updateVillains(simDt, now);
    this.updateHazards(t, now);
    this.updateForks(now);
    this.updateHillGate(now);
    this.updateConscience(now);

    this.players.forEach((p) => {
      if (p.body.position.y < LEVEL.fallY) {
        if (p.shield) {
          p.shield = false;
          p.body.position.y = LEVEL.fallY + 20;
          p.body.velocity.set(0, 0, 0);
          p.socket.emit('toast', { text: '천상의 갑주가 낙사를 막아주었습니다!' });
        } else {
          const rp = p.lastCheckpointPos;
          p.body.position.set(rp.x, rp.y, rp.z);
          p.body.velocity.set(0, 0, 0);
        }
      }

      for (const cp of LEVEL.checkpoints) {
        const dx = p.body.position.x - cp.pos.x;
        const dz = p.body.position.z - cp.pos.z;
        if (Math.hypot(dx, dz) < cp.radius) {
          if (cpIndex[cp.id] > cpIndex[p.lastCheckpoint]) {
            p.lastCheckpoint = cp.id;
            p.lastCheckpointPos = { x: cp.pos.x, y: cp.pos.y + 1.5, z: cp.pos.z };
          }
        }
      }

      if (!p.arrived) {
        const dx = p.body.position.x - LEVEL.goal.pos.x;
        const dz = p.body.position.z - LEVEL.goal.pos.z;
        if (Math.hypot(dx, dz) < LEVEL.goal.radius) {
          p.arrived = true;
          this.broadcastRoster();
          this.checkAllArrived();
        }
      }
    });

    this.updateQuests(now);

    io.to(this.id).emit('state', {
      serverNow: Date.now(),
      players: Array.from(this.players.values()).map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        pos: { x: p.body.position.x, y: p.body.position.y, z: p.body.position.z },
        yaw: p.yaw,
        checkpoint: cpIndex[p.lastCheckpoint],
        arrived: p.arrived,
        quest: p.quest ? { npcId: p.quest.npcId, deadline: p.quest.deadline } : null,
        completedQuests: Array.from(p.completedQuests),
        burden: p.burden,
        choices: p.choices,
        conscienceCount: p.conscienceCollected.size,
        buffs: {
          speedUntil: p.buffSpeedUntil,
          jumpUntil: p.buffJumpUntil,
          shield: p.shield,
        },
      })),
      villains: this.villainStates.map((v) => ({ id: v.id, pos: v.pos })),
    });
  }

  destroy() {
    clearInterval(this.interval);
    rooms.delete(this.id);
  }
}

const FORK_WIDE_BUFF_MULT = 1.2, FORK_WIDE_BUFF_MS = 6000;
const HILL_GATE_KNOCK_H = 10, HILL_GATE_KNOCK_V = 5, HILL_GATE_COOLDOWN_MS = 1200;

// ---------- 방 배정 ----------
// requestedId === 'new' 면 새 방을 강제로 만든다. 특정 방 id를 요청했는데 존재하고 자리가
// 있으면 그 방으로. 그 외(없음/꽉 참/존재하지 않음)엔 자리 있는 첫 방을 찾고, 없으면 새로 만든다.
function resolveRoom(requestedId) {
  if (requestedId && requestedId !== 'new') {
    const r = rooms.get(requestedId);
    if (r && r.players.size < MAX_PLAYERS_PER_ROOM) return r;
    if (r) return null; // 명시적으로 요청한 방이 꽉 참 — 자동으로 다른 방에 넣지 않고 실패 처리
  }
  if (requestedId !== 'new') {
    for (const r of rooms.values()) {
      if (r.players.size < MAX_PLAYERS_PER_ROOM) return r;
    }
  }
  if (rooms.size >= MAX_ROOMS) return null;
  const id = String(++roomSeq);
  const room = new Room(id);
  rooms.set(id, room);
  return room;
}

// ---------- socket.io ----------
io.on('connection', (socket) => {
  socket.on('join', (data) => {
    const requestedId = data && data.roomId;
    const room = resolveRoom(requestedId);
    if (!room) {
      socket.emit('joinError', { reason: 'full' });
      return;
    }
    socket.join(room.id);
    socket.data.roomId = room.id;
    const player = room.createPlayer(socket, data && data.name);
    socket.emit('joined', {
      id: socket.id, spawn: player.lastCheckpointPos, color: player.color,
      levelStart: room.levelStart, roomId: room.id,
    });
    room.broadcastRoster();
  });

  socket.on('input', (data) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (!p || !data) return;
    p.input.x = clampNum(data.x, -1, 1);
    p.input.z = clampNum(data.z, -1, 1);
    p.input.jump = !!data.jump;
    p.yaw = typeof data.yaw === 'number' ? data.yaw : p.yaw;
  });

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    room.removePlayer(socket);
    if (room.players.size === 0) {
      room.destroy(); // 빈 방은 즉시 정리 — 틱 루프가 계속 도는 걸 막는다
    } else {
      room.broadcastRoster();
      room.checkAllArrived();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Pilgrim's Progress server listening on http://localhost:${PORT}`);
});
