// ============================================================
// 천로역정 (Pilgrim's Progress) — 오늘의 순례길 협동 장애물 코스 — 공유 레벨 데이터
// 지명뿐 아니라 지형 자체를 원작 구조(같은 계단 수, 같은 회전무대 배열 등)를 그대로 베끼지
// 않고 각 구간의 컨셉에 맞게 새로 설계했다 — 침대에서 시작하는 방, 흩어진 책더미, 구불구불한
// 귀갓길과 현관 포치, 울퉁불퉁한 미루기의 계단, 소용돌이치는 나선형 피드, 갈림길 없이 탁 트인
// 방관자의 벌판 등. 움직임 물리와 사람형 캐릭터 리그만 원작 엔진 그대로 재사용한다.
// 서버(Node, 물리 충돌 계산)와 클라이언트(브라우저, 렌더링)가 동일한
// 이 파일을 그대로 불러써서 지형과 장애물의 움직임을 항상 일치시킨다.
// 순수 데이터 + 수학 함수만 포함 (엔진 전용 클래스 사용 금지).
//
// 점프 물리(서버 상수와 맞춤): 최대속도 15, 점프속도 14, 중력 -28
//   => 정점 높이 3.5, 체공시간 1.0s, 최대 수평 도달거리 15
// 안전 마진을 위해 실제 간격은 이보다 훨씬 여유있게 설계한다
//   (같은 높이 점프 간격 ≤ 8, 단차 ≤ 2.0).
// ⚠ 갈림길(fork)에서 넓은 길/좁은 길의 길이가 서로 다르면, 짧은 쪽 레인의 끝과 합류
//   발판 사이에 안전 마진을 넘는 큰 틈이 생겨 그 레인이 통째로 통행 불가능해질 수 있다
//   (실제로 이 실수로 한동안 두 갈림길의 넓은 길이 막혀 있었다 — 아래 bridgeLaneGap 참고).
//   두 레인을 만든 뒤엔 반드시 bridgeLaneGap으로 짧은 쪽을 이어 붙이고 나서 합류 발판을 놓는다.
//
// 모션 타입: bob(상하), slide(1축 왕복), slide2d(두 축을 다른 주기로 왕복 — 예측하기 어려운
//   리사주 궤적), pendulum(축 회전 왕복), rotorY(Y축 연속 회전), carousel(rotorY와 동일, 회전
//   발판용), orbit(중심점 둘레를 원으로 공전 — 필요하면 y도 함께 출렁임), blink(주기적으로
//   멀리 치워져 충돌/시야에서 완전히 사라졌다가 다시 나타남 — 사라지기 직전 warnDuration
//   동안 warn=true를 반환해 클라이언트가 깜빡임 경고를 보여줄 수 있게 한다).
//
// npcs: 퀘스트를 주는 등장인물(선배, 코치, 친구 등 — 모두 현대적 인물로 재해석). 근처에
//   가면 자동으로 퀘스트가 시작되고("다음 경유지까지 시간 안에 도착"), 제한 시간 안에 목표
//   체크포인트에 닿으면 보상(속도/점프 강화, 낙사 방지막)을 받는다. 위치·판정은 서버가
//   관리하고, 텍스트 라벨은 클라이언트가 이 배열에서 그대로 읽어 쓴다.
// villains: 각 구간 테마에 맞는 방해꾼 — 전부 "그림자"라는 이름 계열로 통일해, 실제 괴물이
//   아니라 마음속 감정/압박이 형상화된 것임을 나타낸다(핑계의 그림자, 불안의 그림자, 번아웃,
//   비교의 그림자, 눈치의 그림자). anchor 주변을 서성이다가 플레이어가 chaseRadius 안에
//   들어오면 쫓아오고, 부딪히면 밀쳐낸다(낙사로 이어질 수 있음). anchor에서 너무 멀어지지
//   않도록 리쉬가 걸려있다. 위치는 서버가 매 틱 계산해 상태 브로드캐스트로 보내준다(시간만의
//   순수 함수가 아니라 플레이어 위치에 반응해야 하므로 kinematics와는 별도로 다룬다).
//
// forks: "넓은 길 vs 좁은 길" 갈림길 — 실제 교회 청소년 수련회 대본을 물리 엔진에 이식한 것.
//   각 fork는 진입 지점(entryTrigger)에서 현대적 삶의 딜레마 문구를 1회 보여주고, 그 뒤로
//   물리적으로 갈라진 두 레인(넓은 길/좁은 길)이 있어 플레이어가 실제로 어느 쪽으로 달려가는지가
//   곧 선택이 된다(별도 다이얼로그 UI 없음). 좁은 길 레인이 끝나는 지점 근처에 crossTrigger("십자가
//   아래")가 있어, 그 fork에서 좁은 길을 선택했다면 죄의 짐을 1개 제거할 수 있다. 위치 판정과
//   짐/선택 상태는 서버가 관리한다(플레이어별 상태라 순수 함수로 표현 불가 — villain과 동일한 이유).
// hillGate: 미루기의 계단의 짐-게이트. 죄의 짐이 하나라도 남아있으면 우회 계단(짧고 안전함) 입구에서
//   서버가 밀어내 돌려보내고, 원래의 고된 계단(할 일 뭉치+불안의 그림자)으로만 오르게 한다. 짐을 모두
//   내려놓았다면 우회 계단으로 곧장 오를 수 있다.
// conscienceItems: 안내 없이 길에 놓인 "양심의 선택" — 주우면 조용한 토스트만 뜨고 승리 화면에
//   기록된다. 강제 회수 미션은 없음(디자인 결정).
// ============================================================

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LEVEL = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  const statics = [];
  const kinematics = [];
  const checkpoints = [];
  const npcs = [];
  const villains = [];
  const forks = [];
  const conscienceItems = [];
  let hillGate = null;
  let sid = 0, kid = 0;

  function addStatic(type, pos, size, color) {
    statics.push({ id: 's' + (sid++), type, pos, size, color });
    return statics[statics.length - 1];
  }
  function addKinematic(type, pos, size, color, motion) {
    kinematics.push({ id: 'k' + (kid++), type, pos, size, color, motion });
    return kinematics[kinematics.length - 1];
  }
  function addCheckpoint(id, pos, radius, label) {
    checkpoints.push({ id, pos, radius, label });
  }
  function addNpc(id, pos, def) {
    npcs.push({
      id, pos, radius: def.radius || 4.5, name: def.name, role: def.role,
      questLabel: def.questLabel, targetCpId: def.targetCpId, timeLimit: def.timeLimit,
      rewardType: def.rewardType, rewardValue: def.rewardValue, rewardDuration: def.rewardDuration,
      rewardLabel: def.rewardLabel, robeColor: def.robeColor || '#e9d38a',
    });
  }
  function addVillain(id, anchor, def) {
    villains.push({
      id, anchor, name: def.name, chaseRadius: def.chaseRadius || 14,
      patrolRadius: def.patrolRadius || 3, speed: def.speed || 7,
      hitRadius: def.hitRadius || 1.8, color: def.color || '#3a1a1a', scale: def.scale || 1.3,
      // 부딪혔을 때 밀쳐내는 세기(수평/수직). 기본값은 꽤 강하게(번아웃 등 "진짜 위협"용) —
      // 좁은 발판 위의 그림자처럼 살짝 겁만 줘야 하는 경우엔 개별적으로 약하게 낮춘다.
      knockH: def.knockH || 16, knockV: def.knockV || 9,
      // true면 부딪혔을 때 (부딪힌 반대방향으로 튕겨나가는 대신) 넓은 길 방향(+z)으로
      // 억지로 떠민다 — 유혹은 그냥 아프기만 한 게 아니라 실제로 넓은 길 쪽으로 끌고 간다.
      // 갈림길이 없는 구간의 빌런(예: 번아웃)은 이 값을 안 주면 기존처럼 그냥 밀쳐낸다.
      pullToWide: !!def.pullToWide,
    });
  }
  function addFork(id, def) {
    forks.push({
      id,
      entryTrigger: def.entryTrigger,
      wideTrigger: def.wideTrigger,
      narrowTrigger: def.narrowTrigger,
      crossTrigger: def.crossTrigger,
      dilemmaText: def.dilemmaText,
      // 표지판/토스트에 그대로 쓰이는 "실제 선택지" 문구 — "넓은 길/좁은 길"이라는 추상적
      // 이름만으로는 뭘 고르는 건지 알 수 없으므로, 매 갈림길마다 구체적인 행동으로 적는다.
      wideChoiceLabel: def.wideChoiceLabel,
      narrowChoiceLabel: def.narrowChoiceLabel,
      wideRewardLabel: def.wideRewardLabel || '세상의 보상',
    });
    return forks[forks.length - 1];
  }
  function addConscienceItem(pos) {
    conscienceItems.push({ id: 'c' + conscienceItems.length, pos, radius: 2.2 });
  }

  // x축을 따라 왼쪽 끝(edge) 좌표를 계속 갱신하며 이어붙인다.
  let edge = 0; // 다음에 배치할 구조물의 왼쪽(뒤쪽) x 경계
  let y = 0;    // 현재 발판 표면(top) 높이

  function platform(width, depth, color, zAtCenter = 0) {
    const p = addStatic('box', { x: edge + width / 2, y: y - 0.5, z: zAtCenter }, { x: width, y: 1, z: depth }, color);
    edge += width;
    return p;
  }

  // 짧은 쪽 레인의 끝(shortEdge)에서 합류 지점(targetEdge)까지 안전한 평지 통로로 이어 붙인다
  // (제자리 z, atY 높이). 이미 targetEdge에 도달했거나 넘었으면 아무것도 하지 않는다.
  function bridgeLaneGap(shortEdge, targetEdge, zAt, atY, color = '#5a5044') {
    if (shortEdge >= targetEdge - 0.01) return shortEdge;
    const savedEdge = edge, savedY = y;
    edge = shortEdge; y = atY;
    platform(targetEdge - shortEdge, 6, color, zAt);
    const result = edge;
    edge = savedEdge; y = savedY;
    return result;
  }

  // 갈림길(fork) 구간 공통 오프셋 — 넓은 길은 z=+LANE_Z, 좁은 길은 z=-LANE_Z에 짓는다.
  const LANE_Z = 7;

  // =================================================================
  // ZONE A — 아침의 방 (Morning Room) : 시작 지점 (튜토리얼 — 쉬움)
  // 침대 위에서 시작해 바닥으로 내려선다. 갈림길에서 넓은 길은 침대 턱을 다시 올라 이불
  // 속으로, 좁은 길은 알람시계 두 개를 지그재그로 피해 문지방을 넘어 방을 나선다.
  // =================================================================
  platform(16, 14, '#e8d9b0'); // 침대(이불) — 스폰 지점
  const spawn = { x: 8, y: y + 2, z: 0 };
  y -= 1.5; // 침대에서 바닥으로 내려섬
  platform(14, 14, '#c9b896'); // 방바닥
  addCheckpoint('cp0', { x: edge - 7, y: y + 1, z: 0 }, 7, '아침의 방');

  {
    const forkStart = edge; // 30
    const baseY = y; // -1.5
    addStatic('plane_hazard', { x: forkStart + 15, y: baseY - 7, z: 0 }, { x: 40, y: 1, z: 26 }, '#4a3d2a');

    // 넓은 길: 다시 이불 속으로 — 침대 턱을 살짝 올라 짧고 포근하게 끝난다.
    edge = forkStart; y = baseY;
    platform(6, 6, '#c9b896', LANE_Z);
    y += 1.5;
    const wideEndPiece = platform(9, 6, '#e8d9b0', LANE_Z);
    let edgeWide = edge, yWide = y;

    // 좁은 길: 알람시계 두 개를 지그재그로 피하고, 문지방을 올라 방을 나선다.
    edge = forkStart; y = baseY;
    platform(4, 4, '#8a8478', -LANE_Z);
    edge += 4.3;
    addKinematic('box', { x: edge + 2, y, z: -LANE_Z + 1.4 }, { x: 4, y: 1, z: 4 }, '#c0392b', { // 알람시계 1
      type: 'bob', amplitude: 0.3, speed: 1.3, phase: 0, axis: 'y',
    });
    edge += 4 + 4.3;
    addKinematic('box', { x: edge + 2, y, z: -LANE_Z - 1.4 }, { x: 4, y: 1, z: 4 }, '#c0392b', { // 알람시계 2
      type: 'bob', amplitude: 0.35, speed: 1.6, phase: 1.2, axis: 'y',
    });
    edge += 4 + 4.3;
    platform(4, 4, '#8a8478', -LANE_Z); // 문지방 앞
    y += 1.5; // 문지방을 넘음
    const narrowEndPiece = platform(4, 4, '#8a8478', -LANE_Z);
    let edgeNarrow = edge, yNarrow = y;

    const laneMax = Math.max(edgeWide, edgeNarrow);
    edgeWide = bridgeLaneGap(edgeWide, laneMax, LANE_Z, yWide, '#c9b896');
    edgeNarrow = bridgeLaneGap(edgeNarrow, laneMax, -LANE_Z, yNarrow, '#8a8478');
    edge = laneMax + 2; y = Math.max(yWide, yNarrow);
    platform(12, 24, '#c9b896');

    addFork('fork1', {
      entryTrigger: { pos: { x: forkStart + 3, y: baseY + 1, z: 0 }, radius: 6 },
      wideTrigger: { pos: { x: wideEndPiece.pos.x, y: yWide + 1, z: LANE_Z }, radius: 5 },
      narrowTrigger: { pos: { x: narrowEndPiece.pos.x, y: yNarrow + 1, z: -LANE_Z }, radius: 5 },
      crossTrigger: { pos: { x: edge - 8, y: y + 1, z: -LANE_Z * 0.4 }, radius: 5 },
      dilemmaText: '잠의 유혹 — 밤새 공부하느라 3시간밖에 못 잤다. 주일 아침, 더 잘까 예배로 향할까?',
      wideChoiceLabel: '계속 잔다',
      narrowChoiceLabel: '피곤해도 일어난다',
      wideRewardLabel: '피로 회복의 안락함 (짧은 이동속도 상승)',
    });
    addCheckpoint('cp0b', { x: edge - 6, y: y + 1, z: 0 }, 6, '알람시계를 넘어서다');
  }

  // =================================================================
  // ZONE B — 밀린 과제의 늪 (Swamp of Overdue Homework)
  // 가지런한 지그재그 다리가 아니라, 아무렇게나 흩어진 채 조금씩 다른 높이로 쌓인 책더미를
  // 건너간다 — 뒤로 갈수록 더미가 좁아지고 더 빨리/크게 흔들린다.
  // =================================================================
  addStatic('plane_hazard', { x: edge + 75, y: y - 7, z: 0 }, { x: 165, y: 1, z: 30 }, '#4a3d2a');
  const stoneW0 = 5, stoneWMin = 4.3;
  const stoneGap0 = 4.6, stoneGapMax = 5.8; // 검증된 안전 반경(≤8) 안에서만 넓어짐
  // 흩어진 책더미의 z 오프셋 — 규칙적 지그재그(±3.2 고정)가 아니라 손으로 고른 불규칙 수열.
  // 연속한 두 값의 차가 원작의 최대 스윙(6.4)을 넘지 않도록 검증된 값들.
  const bookZ = [-3.2, 2.8, -2.0, -3.0, 3.2, -1.8, -3.2, 2.4, 3.0, -2.6, -1.5, 3.2, -3.0, 1.8];
  const bookYOff = [0, 0.3, 0.5, 0.2, 0.6, 0.1, 0.4, 0.6, 0.2, 0.5, 0.3, 0.6, 0.1, 0.4]; // 들쭉날쭉 쌓인 높이(≤0.6, 완만)
  const bookColors = ['#c9b06a', '#b89a52', '#d4c07a'];
  edge += 4; // 첫 책더미까지 약간의 助走 간격
  const sloughStones = bookZ.length;
  const swampBaseY = y;
  for (let i = 0; i < sloughStones; i++) {
    const prog = i / (sloughStones - 1);
    const ease = Math.pow(prog, 1.6); // 초반은 여유있게, 후반에 몰아서 어려워짐
    const w = stoneW0 - (stoneW0 - stoneWMin) * ease;
    const gap = stoneGap0 + (stoneGapMax - stoneGap0) * ease;
    const x = edge + w / 2;
    const z = bookZ[i];
    const stackY = swampBaseY + bookYOff[i];
    const amp = 0.25 + ease * 0.35;
    const speed = 1.0 + ease * 0.7;
    addKinematic('box', { x, y: stackY, z }, { x: w, y: 1, z: w }, bookColors[i % bookColors.length], {
      type: 'bob', amplitude: amp, speed, phase: i * 0.8, axis: 'y',
    });
    edge += w + gap;
  }
  edge += 2;
  platform(14, 24, '#8a7a63');
  addCheckpoint('cp1', { x: edge - 7, y: y + 1, z: 0 }, 7, '밀린 과제를 넘어서다');
  addConscienceItem({ x: edge - 7, y: y + 1.3, z: 4 });

  // =================================================================
  // ZONE C — 귀가길의 문 (Gate of Coming Home)
  // 넓은 길(z=+7)은 친구들과 어울려 다니느라 구불구불해진 길(짧고 평탄). 좁은 길(z=-7)은
  // 핑계의 그림자를 피하고 진동하는 휴대폰 알림 2개를 지나, 현관 앞 작은 계단(포치)을
  // 올라 문을 통과해야 한다.
  // =================================================================
  {
    const forkStart = edge;
    const baseY = y;
    addStatic('plane_hazard', { x: forkStart + 26, y: baseY - 7, z: 0 }, { x: 60, y: 1, z: 28 }, '#4a3d2a');

    // 넓은 길: 구불구불한 골목길
    edge = forkStart; y = baseY;
    const wideZs = [7, 8.5, 6, 8, 7];
    let wideEndPiece;
    for (const wz of wideZs) wideEndPiece = platform(6, 7, '#c9a53f', wz);
    let edgeWide = edge, yWide = y;

    // 좁은 길: 핑계의 그림자 + 휴대폰 진동 알림 2개 + 현관 포치 + 문
    edge = forkStart; y = baseY;
    platform(34, 8, '#8a7a63', -LANE_Z);
    addVillain('v-excuse-shadow', { x: forkStart + 8, y: y + 1.4, z: -LANE_Z + 5 }, {
      name: '핑계의 그림자', chaseRadius: 17, patrolRadius: 5, speed: 8.5,
      hitRadius: 1.9, color: '#241018', scale: 1.35, pullToWide: true,
    });
    const gateX = forkStart + 32;
    addStatic('box', { x: gateX, y: y + 6, z: -LANE_Z - 4.2 }, { x: 3, y: 12, z: 2.4 }, '#4a3f33'); // 현관문 기둥
    addStatic('box', { x: gateX, y: y + 6, z: -LANE_Z + 4.2 }, { x: 3, y: 12, z: 2.4 }, '#4a3f33');
    addStatic('box', { x: gateX, y: y + 13, z: -LANE_Z }, { x: 3, y: 2, z: 11 }, '#4a3f33');
    addKinematic('bar', { x: forkStart + 12, y: y + 4.2, z: -LANE_Z }, { x: 1.2, y: 1.2, z: 10 }, '#7a2424', { // 진동 알림
      type: 'pendulum', amplitude: 0.55, speed: 1.9, phase: Math.PI, pivot: 'x',
    });
    addKinematic('bar', { x: forkStart + 22, y: y + 4.5, z: -LANE_Z }, { x: 1.2, y: 1.2, z: 11 }, '#9a2e2e', {
      type: 'pendulum', amplitude: 0.75, speed: 1.4, phase: 0, pivot: 'x',
    });
    y += 1.5; // 현관 앞 포치를 오름
    const narrowEndPiece = platform(18, 8, '#7a6a52', -LANE_Z);
    let edgeNarrow = edge, yNarrow = y;

    const laneMax = Math.max(edgeWide, edgeNarrow);
    edgeWide = bridgeLaneGap(edgeWide, laneMax, LANE_Z, yWide, '#c9a53f');
    edgeNarrow = bridgeLaneGap(edgeNarrow, laneMax, -LANE_Z, yNarrow, '#7a6a52');
    edge = laneMax + 2; y = Math.max(yWide, yNarrow);
    platform(10, 26, '#8a7a63');

    addFork('fork2', {
      entryTrigger: { pos: { x: forkStart + 3, y: baseY + 1, z: 0 }, radius: 6 },
      wideTrigger: { pos: { x: wideEndPiece.pos.x, y: yWide + 1, z: wideEndPiece.pos.z }, radius: 5 },
      narrowTrigger: { pos: { x: narrowEndPiece.pos.x, y: yNarrow + 1, z: -LANE_Z }, radius: 5 },
      crossTrigger: { pos: { x: edge - 7, y: y + 1, z: -LANE_Z * 0.4 }, radius: 5 },
      dilemmaText: '관계의 방 — 부모님과 5시 귀가 약속을 했다. 친구들은 "지금이 피크인데"라며 붙잡는다. 어떻게 할까?',
      wideChoiceLabel: '친구들과 더 논다',
      narrowChoiceLabel: '약속대로 집에 간다',
      wideRewardLabel: '친구들과의 달콤한 시간',
    });
    addCheckpoint('cp2', { x: edge - 6, y: y + 1, z: 0 }, 6, '귀가길의 문을 지나다');
    addNpc('npc-interpreter', { x: edge - 4, y: y + 1, z: 6.5 }, {
      name: '선배', role: '쉼터',
      questLabel: '미루기의 계단 정상까지 40초 안에 도착하세요',
      targetCpId: 'cp3', timeLimit: 40,
      rewardType: 'speed', rewardValue: 1.35, rewardDuration: 14000,
      rewardLabel: '민첩함의 축복 (14초간 이동속도 상승)', robeColor: '#7a5a2e',
    });
  }

  // =================================================================
  // ZONE D — 미루기의 계단 (Stairs of Procrastination) : 죄의 짐 게이트
  // 가지런한 계단이 아니라 폭/높이가 들쭉날쭉한 "치워지지 않은 잡동사니 더미"를 오른다.
  // 짐이 남아있으면(burden>0) 우회 계단(z=+12, 안전) 입구에서 서버가 밀어내 돌려보낸다 —
  // 원래의 고된 계단(z=0, 할 일 뭉치+불안의 그림자)으로만 오를 수 있다.
  // ⚠ 불안의 그림자는 반드시 굴러오는 장애물(roller)이 없는 계단에 둔다 — 두 위협이 겹치면
  // 좁은 발판에서 튕겨나가 지나갈 수 없는 구간이 되어버린다. 넉백도 다른 빌런보다 약하게.
  // =================================================================
  const HILL_LANE_Z = 12;
  const hillWidths = [8, 10, 7, 9, 8, 10, 7, 9, 8];
  const hillRises = [1.8, 1.4, 2.0, 1.5, 1.9, 1.3, 2.0, 1.6, 1.8]; // 전부 ≤2.0
  const hillDepth = 18;
  const hillSteps = hillWidths.length;
  const hillBaseEdge = edge, hillBaseY = y;

  // 우회 계단 (짐 없을 때만 허용) — 같은 지형이지만 장애물 없음
  {
    const savedEdge = edge, savedY = y;
    edge = hillBaseEdge; y = hillBaseY;
    for (let i = 0; i < hillSteps; i++) {
      platform(hillWidths[i], hillDepth, '#8a9a6a', HILL_LANE_Z);
      y += hillRises[i];
    }
    hillGate = {
      shortLaneTrigger: { pos: { x: hillBaseEdge + 4, y: hillBaseY + hillRises[0], z: HILL_LANE_Z }, radius: 5 },
    };
    edge = savedEdge; y = savedY;
  }

  // 고된 계단 (항상 통과 가능, 굴러오는 할 일 뭉치 + 불안의 그림자)
  const hillRollers = [];
  for (let i = 0; i < hillSteps; i++) {
    const w = hillWidths[i];
    platform(w, hillDepth, '#7a6a52');
    y += hillRises[i];
    if (i === 1 || i === 3 || i === 5 || i === 7) {
      hillRollers.push({ x: edge - w / 2, y: y + 2.5, kind: (i === 5) ? 'slide2d' : 'slide' });
    }
    if (i === 0) {
      addVillain('v-anxiety-shadow-1', { x: edge - w / 2, y: y + 1.4, z: 8 }, {
        name: '불안의 그림자', chaseRadius: 5, patrolRadius: 1.5, speed: 6,
        hitRadius: 1.7, color: '#4a3a5a', scale: 1.5, knockH: 10, knockV: 5, pullToWide: true,
      });
    }
    if (i === hillSteps - 1) {
      addVillain('v-anxiety-shadow-2', { x: edge - w / 2, y: y + 1.4, z: -8 }, {
        name: '불안의 그림자', chaseRadius: 5, patrolRadius: 1.5, speed: 6,
        hitRadius: 1.7, color: '#4a3a5a', scale: 1.5, knockH: 10, knockV: 5, pullToWide: true,
      });
    }
  }
  hillRollers.forEach((r, i) => { // 굴러오는 밀린 할 일 뭉치(빨랫감/서류 뭉치)
    if (r.kind === 'slide2d') {
      addKinematic('sphere', { x: r.x, y: r.y, z: 0 }, { r: 2 }, '#6a7a8a', {
        type: 'slide2d', ampX: 2.4, speedX: 1.3, phaseX: 0, ampZ: 5, speedZ: 0.9, phaseZ: 1.4,
      });
    } else {
      addKinematic('sphere', { x: r.x, y: r.y, z: 0 }, { r: 2 }, '#8a7a5a', {
        type: 'slide', amplitude: 5.5, speed: 1.1 + i * 0.2, phase: i * 1.7, axis: 'z',
      });
    }
  });
  platform(16, 40, '#8a7a63'); // 두 계단(z=0, z=+12)을 모두 덮을 만큼 넓게
  addCheckpoint('cp3', { x: edge - 8, y: y + 1, z: 0 }, 8, '미루기의 계단을 오르다');
  addNpc('npc-shining-one', { x: edge - 4, y: y + 1, z: 6.5 }, {
    name: '코치', role: '격려의 목소리',
    questLabel: '불안한 밤을 지나 반대편까지 35초 안에 도착하세요',
    targetCpId: 'cp4', timeLimit: 35,
    rewardType: 'shield', rewardValue: 1, rewardDuration: 0,
    rewardLabel: '용기의 부적 (다음 낙사 1회를 막아줍니다)', robeColor: '#fff3c0',
  });

  // =================================================================
  // ZONE E — 불안한 밤 (Anxious Night)
  // 좁고 어두운 다리: 소용돌이치는 걱정(회전 장대) + 흔들리는 확신(blink)이 두 번 반복되는
  // 구간 + 번아웃의 습격. 시야/조명은 client.js의 ZONE_THEMES에서 가장 어둡게 처리한다.
  // =================================================================
  const bridgeStart = edge;
  addStatic('plane_hazard', { x: bridgeStart + 59, y: y - 7, z: 0 }, { x: 135, y: 1, z: 26 }, '#0a0a0f');
  platform(24, 4.2, '#232019');
  addKinematic('bar', { x: bridgeStart + 8, y: y + 1.5, z: 0 }, { x: 1, y: 1, z: 8 }, '#8c3b2e', {
    type: 'rotorY', speed: 1.0, phase: 0,
  });
  // 첫 번째 "흔들리는 확신" — 사라졌다 나타나기를 반복하는 발판.
  addKinematic('box', { x: edge + 5, y: y - 0.5, z: 0 }, { x: 9, y: 1, z: 4.2 }, '#5a2e2e', {
    type: 'blink', period: 3.2, onDuration: 1.9, warnDuration: 0.7, phase: 0,
  });
  edge += 9;
  platform(26, 4.2, '#232019');
  addKinematic('bar', { x: bridgeStart + 26, y: y + 1.6, z: 0 }, { x: 1, y: 1, z: 9 }, '#8c3b2e', {
    type: 'rotorY', speed: 1.2, phase: 1.4,
  });
  addKinematic('bar', { x: bridgeStart + 38, y: y + 1.7, z: 0 }, { x: 1, y: 1, z: 8 }, '#8c3b2e', {
    type: 'rotorY', speed: 1.35, phase: 2.4,
  });
  platform(20, 4.2, '#232019');
  // 번아웃은 회전 장대(rotorY) 바로 옆에 두지 않는다 — 장대에 맞아 생기는 무적 시간(약 1초) 동안
  // 그대로 지나쳐버려 부딪혀도 아무 반응이 없는 것처럼 보이는 버그가 있었다(위 불안의 그림자
  // 주석과 같은 이유: 두 위협을 겹쳐두면 안 된다). 장대가 없는 이 구간 한가운데로 옮긴다.
  addVillain('v-burnout', { x: edge - 10, y: y + 1.6, z: 0 }, {
    name: '번아웃', chaseRadius: 24, patrolRadius: 6, speed: 10,
    hitRadius: 2.4, color: '#5a0a0a', scale: 1.9,
  });
  // 두 번째 "흔들리는 확신" — 밤이 깊어질수록 더 빨리 흔들린다.
  addKinematic('box', { x: edge + 4.5, y: y - 0.5, z: 0 }, { x: 8, y: 1, z: 4.2 }, '#5a2e2e', {
    type: 'blink', period: 2.6, onDuration: 1.5, warnDuration: 0.6, phase: 1.5,
  });
  edge += 8;
  platform(30, 4.2, '#232019');
  addKinematic('bar', { x: bridgeStart + 90, y: y + 1.5, z: 0 }, { x: 1, y: 1, z: 8 }, '#8c3b2e', {
    type: 'rotorY', speed: 1.55, phase: 0.8,
  });
  addKinematic('bar', { x: bridgeStart + 102, y: y + 1.7, z: 0 }, { x: 1, y: 1, z: 9 }, '#8c3b2e', {
    type: 'rotorY', speed: 1.7, phase: 3.0,
  });
  platform(16, 22, '#8a7a63');
  addCheckpoint('cp4', { x: edge - 8, y: y + 1, z: 0 }, 8, '불안한 밤을 지나다');
  addConscienceItem({ x: edge - 8, y: y + 1.3, z: -5 });
  addNpc('npc-faithful', { x: edge - 4, y: y + 1, z: 6.5 }, {
    name: '친구', role: '함께 걷는 사람',
    questLabel: '피드의 소용돌이를 벗어날 때까지 45초 안에 도착하세요',
    targetCpId: 'cp5', timeLimit: 45,
    rewardType: 'jump', rewardValue: 1.3, rewardDuration: 14000,
    rewardLabel: '용기의 축복 (14초간 점프력 상승)', robeColor: '#4a7a5a',
  });

  // =================================================================
  // ZONE F — 피드의 소용돌이 (Feed Vortex)
  // 원작처럼 회전무대가 일직선으로 늘어선 게 아니라, 좁은 길은 중심점 둘레를 소용돌이치며
  // 내려가는 나선형 피드 카드 5장으로 되어 있다(실제로 "빙글빙글 빨려드는" 느낌). 넓은 길은
  // 같은 높이만큼 완만하게 내려가는 평온한 4단 계단.
  // =================================================================
  const fairSteps = 3;
  for (let i = 0; i < fairSteps; i++) {
    platform(8, 18, '#7a6a52');
    y -= 1.6;
  }
  platform(14, 24, '#c9a53f');

  {
    const forkStart = edge;
    const baseY = y;
    const WIDE_Z = 18; // 나선(z 최대 -11)과 겹치지 않도록 넓은 길은 더 바깥쪽에 둔다
    addStatic('plane_hazard', { x: forkStart + 40, y: baseY - 7, z: 0 }, { x: 90, y: 1, z: 48 }, '#2a1a2a');

    // 넓은 길: 느긋하게 4번 내려가는 평온한 피드 카드
    edge = forkStart; y = baseY;
    let wideEndPiece;
    for (let i = 0; i < 4; i++) {
      wideEndPiece = platform(6.5, 7, i % 2 === 0 ? '#c9527a' : '#4fa9c9', WIDE_Z);
      y -= 1.5;
    }
    let edgeWide = edge, yWide = y;

    // 좁은 길: 중심점 둘레를 도는 나선형 피드 카드 5장 (소용돌이) — 반원을 그리며 내려간다
    edge = forkStart; y = baseY;
    const spiralR = 11, cardR = 4, spiralSteps = 5;
    const cx = forkStart + 15, cz = 0;
    let narrowEndPiece = null, narrowEndX = cx, narrowEndZ = 0;
    for (let j = 0; j < spiralSteps; j++) {
      const theta = -Math.PI + j * (Math.PI / (spiralSteps - 1)); // -180°→0°, z는 항상 ≤0
      const px = cx + spiralR * Math.cos(theta);
      const pz = cz + spiralR * Math.sin(theta);
      const py = baseY - j * 1.5;
      const dir = (j % 2 === 0) ? 1 : -1;
      narrowEndPiece = addKinematic('cylinder', { x: px, y: py, z: pz }, { r: cardR, h: 1 }, ['#c9527a', '#4fa9c9', '#e0b23a', '#8e5ac9', '#c9527a'][j], {
        type: 'carousel', speed: dir * (1.3 + j * 0.2), phase: j * 1.1,
      });
      if (j === 2) {
        addKinematic('sphere', { x: px, y: py + 2.6, z: pz }, { r: 1.1 }, '#3a2a1a', { // 궤도를 도는 알림 배지
          type: 'orbit', radius: cardR * 0.85, speed: 2.1, phase: 0,
        });
        addVillain('v-comparison-shadow', { x: px, y: py + 1.4, z: pz }, {
          name: '비교의 그림자', chaseRadius: 18, patrolRadius: 7, speed: 9,
          hitRadius: 1.8, color: '#4a2a4a', scale: 1.3, pullToWide: true,
        });
      }
      narrowEndX = px; narrowEndZ = pz;
    }
    let edgeNarrow = narrowEndX + cardR, yNarrow = baseY - (spiralSteps - 1) * 1.5;

    const laneMax = Math.max(edgeWide, edgeNarrow) + 2;
    edgeWide = bridgeLaneGap(edgeWide, laneMax, WIDE_Z, yWide, '#4fa9c9');
    // 나선의 마지막 카드(z<0)에서 합류 지점(z=0)까지 완만하게 이어 붙인다
    {
      const savedEdge = edge, savedY = y;
      edge = narrowEndX + cardR; y = yNarrow;
      platform(Math.max(4, laneMax - edge), 6, '#8e5ac9', narrowEndZ * 0.5);
      edgeNarrow = edge;
      edge = savedEdge; y = savedY;
    }
    edgeNarrow = bridgeLaneGap(edgeNarrow, laneMax, 0, yNarrow, '#8e5ac9');

    edge = laneMax; y = Math.min(yWide, yNarrow);
    platform(16, 30, '#8a7a63');

    addFork('fork3', {
      entryTrigger: { pos: { x: forkStart + 4, y: baseY + 1, z: 0 }, radius: 7 },
      wideTrigger: { pos: { x: wideEndPiece.pos.x, y: yWide + 1, z: WIDE_Z }, radius: 6 },
      narrowTrigger: { pos: { x: narrowEndX, y: yNarrow + 1, z: narrowEndZ }, radius: 6 },
      crossTrigger: { pos: { x: edge - 8, y: y + 1, z: -4 }, radius: 6 },
      dilemmaText: 'SNS 유혹 — 설교 중 단톡방 알림이 쉴 새 없이 울린다. 지금 열어볼까, 참고 집중할까?',
      wideChoiceLabel: '메시지를 확인한다',
      narrowChoiceLabel: '참고 집중한다',
      wideRewardLabel: '시원한 방에서의 10분 휴식',
    });
    addCheckpoint('cp5', { x: edge - 8, y: y + 1, z: 0 }, 8, '피드의 소용돌이를 벗어나다');
  }

  // =================================================================
  // ZONE G — 방관자의 벌판 (Field of the Bystander) : 선택④ — 왕따 방관 vs 도움
  // 여기는 갈림길에 레인을 나누지 않는다 — 탁 트인 벌판 하나뿐이다. 혼자인 친구가 한쪽
  // 구석에 서 있고, 그 친구에게 다가가면(=좁은 길) 눈치의 그림자를 견뎌야 하고, 그냥
  // 반대쪽 빠른 출구로 곧장 가면(=넓은 길) 아무 일도 없다. 실제 "알아채고 다가가는" 선택을
  // 그대로 흉내낸 구조.
  // =================================================================
  {
    const fieldStart = edge;
    const baseY = y;
    platform(46, 34, '#8a9a6a'); // 탁 트인 벌판 (하나의 열린 발판, 잠프 구간 없음)

    addNpc('npc-lonely-friend', { x: fieldStart + 24, y: baseY + 1, z: -11 }, {
      name: '혼자인 친구', role: '소외된 반 친구', radius: 6,
      questLabel: '혼자 걷기 외로웠는데, 같이 가줄래?',
      targetCpId: 'cp5b', timeLimit: 999,
      rewardType: 'jump', rewardValue: 1, rewardDuration: 0,
      rewardLabel: '외로움을 함께 나눔', robeColor: '#557a55',
    });
    addVillain('v-side-eye', { x: fieldStart + 30, y: baseY + 1.4, z: -11 }, {
      name: '눈치의 그림자', chaseRadius: 9, patrolRadius: 4, speed: 6,
      hitRadius: 1.6, color: '#4a3a4a', scale: 1.1, knockH: 8, knockV: 4, pullToWide: true,
    });

    edge = fieldStart + 46;
    addFork('fork4', {
      entryTrigger: { pos: { x: fieldStart + 6, y: baseY + 1, z: 0 }, radius: 6 },
      wideTrigger: { pos: { x: fieldStart + 38, y: baseY + 1, z: 11 }, radius: 6 },
      narrowTrigger: { pos: { x: fieldStart + 24, y: baseY + 1, z: -11 }, radius: 6 },
      crossTrigger: { pos: { x: fieldStart + 40, y: baseY + 1, z: -6 }, radius: 6 },
      dilemmaText: '방관자의 벌판 — 조 편성에서 혼자 남은 친구가 눈치를 본다. 조원들은 "모른 척하라"고 한다. 손을 내밀까?',
      wideChoiceLabel: '모르는 척 지나간다',
      narrowChoiceLabel: '다가가서 손을 내민다',
      wideRewardLabel: '무리 없이 지나가는 편안함',
    });
    addCheckpoint('cp5b', { x: fieldStart + 42, y: baseY + 1, z: 0 }, 6, '방관자의 벌판을 지나다');
  }

  // =================================================================
  // ZONE H — 흘러가는 시간 (River of Passing Time)
  // 점점 작아지고 빨라지는 하루하루(연잎) 위로, 서서히 가라앉듯 고도가 내려간다. 후반부로
  // 갈수록 궤적이 두 개의 다른 주기를 섞어 예측하기 어려워진다(=시간이 정신없이 흘러감).
  // 강 한복판에는 원 궤도로 도는 '마감일'이 있다.
  // =================================================================
  addStatic('plane_hazard', { x: edge + 70, y: y - 7, z: 0 }, { x: 155, y: 1, z: 28 }, '#1c4a63');
  const padGap = 6.3; // 안전 반경(≤8) 안에서 고정 — 난이도는 발판 크기/속도로만 올린다
  edge += 4;
  const lilypads = 14;
  const riverBaseY = y;
  for (let i = 0; i < lilypads; i++) {
    const prog = i / (lilypads - 1);
    const padRi = 3.0 - 0.7 * prog; // 갈수록 발판이 작아짐
    const x = edge + padRi;
    const z = prog < 0.6
      ? Math.sin(i * 1.3) * 4.5
      : Math.sin(i * 1.3) * 3.2 + Math.sin(i * 0.7) * 2.0; // 후반부는 두 주기를 섞어 불규칙하게
    const yLevel = riverBaseY - prog * 2.0; // 서서히 가라앉는 느낌(≤2.0 이내 완만한 하강)
    addKinematic('cylinder', { x, y: yLevel, z }, { r: padRi, h: 0.8 }, '#2f7a4e', {
      type: 'bob', amplitude: 0.3 + prog * 0.35, speed: 1.5 + prog * 0.9, phase: i * 0.9, axis: 'y',
    });
    if (i === 5 || i === 10) {
      addKinematic('sphere', { x: x + padRi + 3, y: yLevel + 1.4, z: 0 }, { r: 1.6 }, '#4a3a22', {
        type: 'orbit', radius: 5.5, speed: 1.1 + (i === 10 ? 0.3 : 0), phase: i === 10 ? 1.6 : 0,
      });
    }
    edge += padRi * 2 + padGap;
  }
  y = riverBaseY - 2.0;
  addCheckpoint('cpR', { x: edge + 4, y: y + 1, z: 0 }, 6, '흘러가는 시간을 건너 진짜 쉼을 바라보다');
  addConscienceItem({ x: edge + 4, y: y + 1.5, z: 3 });

  // =================================================================
  // ZONE I — 진짜 쉼 (True Rest) : 목적지
  // 두 줄로 늘어선 기둥이 아니라, 빛 기둥 8개가 목적지를 원형으로 둘러싼 작은 성소(안식처)다.
  // 바깥 마당에서 완만한 계단을 올라 중앙의 둥근 단(檀) 위에 목적지가 있다.
  // =================================================================
  const cityStart = edge;
  platform(30, 40, '#e9d38a'); // 바깥 마당
  y += 1.2; // 중앙 단으로 완만하게 오름
  addStatic('cylinder', { x: cityStart + 45, y: y - 0.6, z: 0 }, { r: 22, h: 1.2 }, '#f4e6b0'); // 둥근 단
  const goalPos = { x: cityStart + 45, y: y + 1, z: 0 };
  const goal = { pos: goalPos, radius: 18 };
  const pillarCount = 8;
  for (let i = 0; i < pillarCount; i++) {
    const a = (i / pillarCount) * Math.PI * 2;
    addStatic('cylinder', {
      x: goalPos.x + Math.cos(a) * 19,
      y: y + 10,
      z: goalPos.z + Math.sin(a) * 19,
    }, { r: 1.6, h: 20 }, '#f4e6b0');
  }
  addCheckpoint('cp6', goalPos, goal.radius, '진짜 쉼 (도착)');

  const fallY = -15;

  // ---------------------------------------------------------------
  // 모든 클라이언트/서버가 공통으로 사용하는 위치 계산 함수.
  // t = 레벨 시작 이후 경과 시간(초). 순수 함수 — 항상 서버와 동일한 결과.
  // visible/warn은 blink 타입에서만 의미가 있다(그 외 타입은 항상 visible=true, warn=false).
  // (villains는 플레이어 위치에 반응하는 AI라 순수 함수로 표현할 수 없어 서버가 매 틱
  //  직접 계산해서 상태 브로드캐스트로 위치를 보내준다 — 여기 포함하지 않는다.)
  // ---------------------------------------------------------------
  function kinematicTransform(piece, t) {
    const m = piece.motion;
    let pos = { x: piece.pos.x, y: piece.pos.y, z: piece.pos.z };
    let angle = { x: 0, y: 0, z: 0 };
    let visible = true;
    let warn = false;

    if (m.type === 'bob') {
      pos.y += Math.sin(m.speed * t + m.phase) * m.amplitude;
    } else if (m.type === 'slide') {
      pos[m.axis] += Math.sin(m.speed * t + m.phase) * m.amplitude;
    } else if (m.type === 'slide2d') {
      pos.x += Math.sin(m.speedX * t + m.phaseX) * m.ampX;
      pos.z += Math.sin(m.speedZ * t + m.phaseZ) * m.ampZ;
    } else if (m.type === 'pendulum') {
      const ang = Math.sin(m.speed * t + m.phase) * m.amplitude;
      if (m.pivot === 'x') angle.x = ang; else angle.z = ang;
    } else if (m.type === 'rotorY') {
      angle.y = (m.speed * t + m.phase) % (Math.PI * 2);
    } else if (m.type === 'carousel') {
      angle.y = (m.speed * t + m.phase) % (Math.PI * 2);
    } else if (m.type === 'orbit') {
      const a = m.speed * t + m.phase;
      pos.x = piece.pos.x + Math.cos(a) * m.radius;
      pos.z = piece.pos.z + Math.sin(a) * m.radius;
      if (m.bobAmplitude) pos.y += Math.sin(a * (m.bobSpeedMul || 1)) * m.bobAmplitude;
    } else if (m.type === 'blink') {
      const period = m.period;
      const cyc = ((t + m.phase) % period + period) % period;
      visible = cyc < m.onDuration;
      const warnStart = m.onDuration - (m.warnDuration || 0.6);
      warn = visible && cyc >= warnStart;
      if (!visible) pos.y -= (m.parkOffset || 60);
    }
    return { pos, angle, visible, warn };
  }

  return {
    spawn, fallY, statics, kinematics, checkpoints, npcs, villains,
    forks, conscienceItems, hillGate, goal, kinematicTransform,
  };
});
