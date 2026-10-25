(() => {
  'use strict';

  const Q = globalThis.XiangqiRules;
  if (!Q) return;

  const ROWS = Q.ROWS;
  const COLS = Q.COLS;
  const CELL = 64;
  const M = 42;
  const W = (COLS - 1) * CELL + M * 2;
  const H = (ROWS - 1) * CELL + M * 2;
  const R = 27;
  const DPR = Math.min(window.devicePixelRatio || 1, 2);
  const SIDE_NAME = { r: '红方', b: '黑方' };
  const ROOM_RE = /^[A-Z0-9]{4,8}$/;
  const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const onlineAvailable = location.protocol === 'http:' || location.protocol === 'https:';

  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  canvas.width = W * DPR;
  canvas.height = H * DPR;

  const turnDot = document.getElementById('turnDot');
  const turnText = document.getElementById('turnText');
  const hintText = document.getElementById('hintText');
  const logBody = document.getElementById('logBody');
  const undoBtn = document.getElementById('undoBtn');
  const restartBtn = document.getElementById('restartBtn');
  const actionsRow = document.getElementById('actionsRow');
  const subtitle = document.getElementById('subtitle');
  const modeNote = document.getElementById('modeNote');
  const noteText = document.getElementById('noteText');
  const onlineCard = document.getElementById('onlineCard');
  const setupPanel = document.getElementById('setupPanel');
  const activePanel = document.getElementById('activePanel');
  const roomInput = document.getElementById('roomInput');
  const joinBtn = document.getElementById('joinBtn');
  const createBtn = document.getElementById('createBtn');
  const setupMsg = document.getElementById('setupMsg');
  const roomCode = document.getElementById('roomCode');
  const copyBtn = document.getElementById('copyBtn');
  const connDot = document.getElementById('connDot');
  const connBadge = document.getElementById('connBadge');
  const seatsEl = document.getElementById('seats');
  const onlineMsg = document.getElementById('onlineMsg');
  const leaveBtn = document.getElementById('leaveBtn');
  const modeButtons = Array.from(document.querySelectorAll('.tab'));

  const S = {
    mode: 'local',
    selected: null,
    targets: [],
    local: {
      board: Q.createBoard(),
      turn: 'r',
      log: [],
      lastMove: null,
      winner: null,
      reason: '',
      check: false,
      history: []
    },
    online: {
      board: Q.createBoard(),
      turn: 'r',
      log: [],
      lastMove: null,
      winner: null,
      reason: '',
      check: false,
      room: '',
      token: '',
      mySide: null,
      joined: { r: false, b: false },
      seatsTaken: { r: false, b: false },
      conn: 'idle',
      pending: false,
      error: '',
      socket: null,
      timer: null,
      retry: 0,
      connectSeq: 0,
      shouldReconnect: false,
      revision: 0
    }
  };

  function view() {
    return S.mode === 'local' ? S.local : S.online;
  }

  function cloneBoard(b) {
    return b.map(row => row.map(p => (p ? { type: p.type, side: p.side } : null)));
  }

  function clearSelection() {
    S.selected = null;
    S.targets = [];
  }

  function formatMove(b, p, fr, fc, tr, tc) {
    return Q.formatMove(b, p, fr, fc, tr, tc);
  }

  /* ---------- local game ---------- */

  function playLocal(fr, fc, tr, tc) {
    const g = S.local;
    const p = g.board[fr][fc];
    if (!p || p.side !== g.turn) return;
    if (!Q.legalMovesFor(g.board, fr, fc).some(([r, c]) => r === tr && c === tc)) return;

    const text = formatMove(g.board, p, fr, fc, tr, tc);
    g.history.push({
      board: cloneBoard(g.board),
      turn: g.turn,
      log: g.log.slice(),
      lastMove: g.lastMove ? { ...g.lastMove } : null
    });

    g.board[tr][tc] = p;
    g.board[fr][fc] = null;
    g.lastMove = { fr, fc, tr, tc };
    g.log.push({ side: p.side, text });
    g.turn = Q.other(g.turn);

    const st = Q.gameStatus(g.board, g.turn);
    g.check = st.check;
    g.winner = st.winner;
    g.reason = st.reason;

    clearSelection();
    updateUI();
    render();
  }

  function undoLocal() {
    const g = S.local;
    if (!g.history.length) return;
    const s = g.history.pop();
    g.board = cloneBoard(s.board);
    g.turn = s.turn;
    g.log = s.log;
    g.lastMove = s.lastMove;
    g.winner = null;
    g.reason = '';
    g.check = Q.inCheck(g.board, g.turn);
    clearSelection();
    updateUI();
    render();
  }

  function restartLocal() {
    const g = S.local;
    g.board = Q.createBoard();
    g.turn = 'r';
    g.log = [];
    g.lastMove = null;
    g.winner = null;
    g.reason = '';
    g.check = false;
    g.history = [];
    clearSelection();
  }

  /* ---------- online state ---------- */

  function setSetupMsg(text, danger) {
    setupMsg.textContent = text || '';
    setupMsg.className = 'online-msg' + (danger ? ' danger' : '');
  }

  function newToken() {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  function newRoomCode() {
    const bytes = new Uint8Array(5);
    crypto.getRandomValues(bytes);
    let s = '';
    for (const b of bytes) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
    return s;
  }

  function normalizeRoom(v) {
    return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  }

  function wsUrl(room, token, action) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const q = new URLSearchParams();
    q.set('room', room);
    q.set('token', token);
    q.set(action, '1');
    return proto + '//' + location.host + '/ws?' + q.toString();
  }

  function saveSession() {
    const o = S.online;
    if (!o.room || !o.token) return;
    try {
      sessionStorage.setItem('xq-session', JSON.stringify({ room: o.room, token: o.token }));
    } catch (e) { /* storage disabled */ }
  }

  function saveMode() {
    try {
      sessionStorage.setItem('xq-mode', S.mode);
    } catch (e) { /* storage disabled */ }
  }

  function stopConnection() {
    const o = S.online;
    o.shouldReconnect = false;
    o.connectSeq++;
    if (o.timer) {
      clearTimeout(o.timer);
      o.timer = null;
    }
    if (o.socket) {
      const ws = o.socket;
      o.socket = null;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch (e) { /* already closed */ }
    }
    o.conn = 'idle';
  }

  function resetOnlineGame() {
    const o = S.online;
    o.board = Q.createBoard();
    o.turn = 'r';
    o.log = [];
    o.lastMove = null;
    o.winner = null;
    o.reason = '';
    o.check = false;
    o.pending = false;
    o.error = '';
    o.mySide = null;
    o.joined = { r: false, b: false };
    o.seatsTaken = { r: false, b: false };
    o.revision = 0;
  }

  function startOnline(kind) {
    if (!onlineAvailable) return;
    const o = S.online;

    let code;
    if (kind === 'create') {
      code = newRoomCode();
    } else {
      code = normalizeRoom(roomInput.value);
      if (!ROOM_RE.test(code)) {
        setSetupMsg('请输入 4-8 位房间码', true);
        roomInput.focus();
        return;
      }
    }

    let token = '';
    try {
      const stored = sessionStorage.getItem('xq-token:' + code) || '';
      if (TOKEN_RE.test(stored)) token = stored;
    } catch (e) { /* storage disabled */ }
    if (!token) token = newToken();

    stopConnection();
    resetOnlineGame();
    S.mode = 'online';
    S.selected = null;
    S.targets = [];
    o.room = code;
    o.token = token;
    o.retry = 0;
    o.shouldReconnect = true;
    o.conn = 'connecting';

    try { sessionStorage.setItem('xq-token:' + code, token); } catch (e) { /* storage disabled */ }
    saveSession();
    saveMode();
    setSetupMsg('');
    connect(kind);
    updateUI();
    render();
  }

  function connect(action) {
    const o = S.online;
    if (!o.room || !o.token) return;

    const seq = ++o.connectSeq;
    if (o.socket) {
      const ws = o.socket;
      o.socket = null;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch (e) { /* already closed */ }
    }
    if (o.timer) {
      clearTimeout(o.timer);
      o.timer = null;
    }

    o.conn = o.retry > 0 ? 'reconnecting' : 'connecting';
    o.error = '';
    updateUI();

    let ws;
    try {
      ws = new WebSocket(wsUrl(o.room, o.token, action));
    } catch (e) {
      o.conn = 'closed';
      o.error = '无法建立连接';
      scheduleReconnect();
      return;
    }
    o.socket = ws;

    ws.onopen = () => {
      if (seq !== o.connectSeq) return;
      o.retry = 0;
      if (o.conn !== 'online') {
        o.conn = 'online';
        updateUI();
      }
    };

    ws.onmessage = (ev) => {
      if (seq === o.connectSeq) handleMessage(ev.data);
    };

    ws.onclose = (ev) => {
      if (seq !== o.connectSeq) return;
      o.socket = null;
      o.pending = false;
      if (!o.shouldReconnect) {
        o.conn = 'closed';
        updateUI();
        return;
      }
      if (ev.code === 4002) {
        showSetup('该席位已在其他窗口连接');
        return;
      }
      scheduleReconnect();
    };

    ws.onerror = () => { /* close event follows */ };
  }

  function scheduleReconnect() {
    const o = S.online;
    if (!o.shouldReconnect || !o.room) return;
    o.conn = 'reconnecting';
    o.pending = false;
    if (o.timer) clearTimeout(o.timer);
    const delay = Math.min(8000, 1000 * Math.pow(2, Math.min(o.retry, 3)));
    o.retry++;
    o.timer = setTimeout(() => {
      o.timer = null;
      if (o.shouldReconnect && o.room && S.mode === 'online') connect('join');
    }, delay);
    updateUI();
  }

  function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'pong') return;

    if (msg.type === 'error') {
      const text = typeof msg.message === 'string' ? msg.message : '操作被拒绝';
      if (msg.fatal) {
        showSetup(text);
      } else {
        const o = S.online;
        o.error = text;
        o.pending = false;
        updateUI();
      }
      return;
    }

    if (msg.type === 'state') applyState(msg);
  }

  function applyState(msg) {
    if (!Array.isArray(msg.board) || msg.board.length !== ROWS) return;
    if (msg.you !== 'r' && msg.you !== 'b') return;
    for (const row of msg.board) {
      if (!Array.isArray(row) || row.length !== COLS) return;
    }

    const o = S.online;
    o.room = typeof msg.room === 'string' && ROOM_RE.test(msg.room) ? msg.room : o.room;
    o.mySide = msg.you;
    o.joined = {
      r: !!(msg.joined && msg.joined.r),
      b: !!(msg.joined && msg.joined.b)
    };
    o.seatsTaken = {
      r: !!(msg.seatsTaken && msg.seatsTaken.r),
      b: !!(msg.seatsTaken && msg.seatsTaken.b)
    };
    o.board = cloneBoard(msg.board);
    o.turn = msg.turn === 'b' ? 'b' : 'r';
    o.log = Array.isArray(msg.log)
      ? msg.log
        .filter(m => m && (m.side === 'r' || m.side === 'b') && typeof m.text === 'string')
        .map(m => ({ side: m.side, text: m.text }))
      : [];
    o.lastMove = msg.lastMove && typeof msg.lastMove === 'object' ? msg.lastMove : null;
    o.winner = msg.winner === 'r' || msg.winner === 'b' ? msg.winner : null;
    o.reason = typeof msg.reason === 'string' ? msg.reason : '';
    o.check = !!msg.check;
    o.revision = Number(msg.revision) || 0;
    o.conn = 'online';
    o.pending = false;
    o.error = '';
    o.retry = 0;

    if (o.room && o.token) {
      try { sessionStorage.setItem('xq-token:' + o.room, o.token); } catch (e) { /* storage disabled */ }
    }
    saveSession();
    clearSelection();
    updateUI();
    render();
  }

  function showSetup(message) {
    const o = S.online;
    const room = o.room;
    stopConnection();
    if (room) {
      try { sessionStorage.removeItem('xq-token:' + room); } catch (e) { /* storage disabled */ }
    }
    try { sessionStorage.removeItem('xq-session'); } catch (e) { /* storage disabled */ }
    o.room = '';
    o.token = '';
    o.timer = null;
    o.retry = 0;
    resetOnlineGame();
    o.conn = 'idle';
    S.mode = 'online';
    saveMode();
    clearSelection();
    setSetupMsg(message, true);
    updateUI();
    render();
    roomInput.focus();
  }

  function leaveRoom() {
    const o = S.online;
    const room = o.room;
    stopConnection();
    if (room) {
      try { sessionStorage.removeItem('xq-token:' + room); } catch (e) { /* storage disabled */ }
    }
    try { sessionStorage.removeItem('xq-session'); } catch (e) { /* storage disabled */ }
    o.room = '';
    o.token = '';
    o.timer = null;
    o.retry = 0;
    resetOnlineGame();
    o.conn = 'idle';
    clearSelection();
    setSetupMsg('已离开房间', false);
    updateUI();
    render();
  }

  function restoreSession() {
    if (!onlineAvailable) return false;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem('xq-session') || 'null'); } catch (e) { return false; }
    if (!saved || !ROOM_RE.test(saved.room || '') || !TOKEN_RE.test(saved.token || '')) return false;

    const o = S.online;
    resetOnlineGame();
    o.room = saved.room;
    o.token = saved.token;
    o.shouldReconnect = true;
    o.retry = 0;
    o.conn = 'idle';
    roomInput.value = saved.room;
    return true;
  }

  function onlineHint(v) {
    const o = S.online;
    if (!o.room) return { text: '创建或加入房间后开始对局', cls: 'hint' };
    if (o.error) return { text: o.error, cls: 'hint danger' };
    if (o.conn === 'connecting') return { text: '正在进入房间…', cls: 'hint' };
    if (o.conn === 'reconnecting') return { text: '连接中断，正在自动重连…', cls: 'hint danger' };
    if (o.conn === 'closed') return { text: '连接已断开', cls: 'hint danger' };
    if (!o.mySide) return { text: '正在进入房间…', cls: 'hint' };

    const other = Q.other(o.mySide);
    if (!o.seatsTaken[other]) {
      return {
        text: o.mySide === 'r' ? '等待对手加入，把房间码发给对方' : '等待对方开始…',
        cls: 'hint'
      };
    }
    if (!o.joined[other]) return { text: '对方暂时离线，等待重连…', cls: 'hint danger' };
    if (!o.joined[o.mySide]) return { text: '正在同步房间状态…', cls: 'hint' };
    if (o.pending) return { text: '正在校验落子…', cls: 'hint' };
    if (v.turn !== o.mySide) return { text: '等待对方走棋', cls: 'hint' };
    if (v.check) return { text: '将军！必须应将', cls: 'hint danger' };
    return { text: '轮到你走棋，点击棋子选择', cls: 'hint' };
  }

  function canPickOnline(v) {
    const o = S.online;
    return o.conn === 'online' &&
      !o.pending &&
      !!o.mySide &&
      o.mySide === v.turn &&
      o.joined.r &&
      o.joined.b;
  }

  /* ---------- UI ---------- */

  function renderOnlineCard() {
    onlineCard.hidden = S.mode !== 'online';
    if (S.mode !== 'online') return;

    const o = S.online;
    setupPanel.hidden = !!o.room;
    activePanel.hidden = !o.room;
    if (!o.room) return;

    roomCode.textContent = o.room;

    const connMap = {
      idle: ['', '未连接'],
      connecting: ['wait', '连接中…'],
      online: ['on', '已连接'],
      reconnecting: ['wait', '重连中…'],
      closed: ['', '已断开']
    };
    const conn = connMap[o.conn] || connMap.idle;
    connDot.className = 'conn-dot ' + conn[0];
    connBadge.textContent = conn[1];

    seatsEl.innerHTML = ['r', 'b'].map(side => {
      const taken = o.seatsTaken[side];
      const online = o.joined[side];
      const stateText = !taken ? '空位' : (online ? '在线' : '离线');
      const stateCls = !taken ? '' : (online ? ' on' : ' off');
      const you = o.mySide === side ? '<span class="you-tag">你</span>' : '';
      return '<div class="seat">' +
        '<span class="seat-dot ' + (side === 'r' ? 'red' : 'black') + '"></span>' +
        '<span class="seat-name">' + SIDE_NAME[side] + '</span>' +
        you +
        '<span class="seat-state' + stateCls + '">' + stateText + '</span>' +
        '</div>';
    }).join('');

    let msg = o.error;
    let danger = !!o.error;
    if (!msg) {
      if (o.conn === 'connecting') {
        msg = '正在进入房间…';
      } else if (o.conn === 'reconnecting') {
        msg = '网络中断，正在自动重连…';
        danger = true;
      } else if (o.conn === 'closed') {
        msg = '连接已断开，请离开房间后重试';
        danger = true;
      } else if (!o.joined.r || !o.joined.b) {
        msg = '把房间码发给好友，对方加入后即可开始。';
      }
    }
    onlineMsg.textContent = msg || '';
    onlineMsg.className = 'online-msg' + (danger ? ' danger' : '');
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function renderLog(v) {
    if (!v.log.length) {
      logBody.innerHTML = '<div class="log-empty">暂无着法</div>';
      return;
    }
    const rows = [];
    for (let i = 0; i < v.log.length; i += 2) {
      const a = v.log[i];
      const b = v.log[i + 1];
      rows.push(
        '<div class="log-row"><span class="idx">' + (i / 2 + 1) + '</span>' +
        '<span class="mv red">' + (a ? escapeHtml(a.text) : '') + '</span>' +
        '<span class="mv black">' + (b ? escapeHtml(b.text) : '') + '</span></div>'
      );
    }
    logBody.innerHTML = rows.join('');
    logBody.scrollTop = logBody.scrollHeight;
  }

  function updateUI() {
    const v = view();
    const side = v.winner || v.turn;
    const cls = side === 'r' ? 'red' : 'black';

    turnDot.className = 'dot ' + cls;
    turnText.className = 'turn-text ' + cls;

    if (v.winner) {
      turnText.textContent = SIDE_NAME[v.winner] + '胜';
      hintText.className = 'hint over';
      hintText.textContent = v.reason === '将死' ? '将军无解，对局结束' : '无子可动，对局结束';
    } else {
      turnText.textContent = SIDE_NAME[v.turn] + '走棋';
      if (S.mode === 'local') {
        hintText.className = v.check ? 'hint danger' : 'hint';
        hintText.textContent = v.check ? '将军！必须应将' : '点击棋子选择，再点击落点';
      } else {
        const h = onlineHint(v);
        hintText.className = h.cls;
        hintText.textContent = h.text;
      }
    }

    actionsRow.hidden = S.mode !== 'local';
    undoBtn.disabled = S.mode !== 'local' || S.local.history.length === 0;
    restartBtn.disabled = S.mode !== 'local';

    for (const btn of modeButtons) {
      const active = btn.dataset.mode === S.mode;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }

    subtitle.textContent = S.mode === 'local'
      ? '本地双人对弈 · 无需联网'
      : '联机对战 · 服务器校验每一步落子';
    noteText.textContent = S.mode === 'local'
      ? '规则：将死或困毙均判负；将帅不可在同一直线上照面。点击棋子后，绿点表示可走位置，红圈表示可吃子。'
      : '联机模式：每一步都由服务器校验后再广播；双方都在线时才能落子。对局结束后可离开房间、重新创建房间再战。';

    renderOnlineCard();
    renderLog(v);
  }

  function setMode(mode) {
    if (mode === 'online' && !onlineAvailable) return;
    if (mode === S.mode) return;
    S.mode = mode;
    clearSelection();
    saveMode();

    if (mode === 'online') {
      const o = S.online;
      if (o.room && !o.socket && o.shouldReconnect) {
        o.conn = 'connecting';
        o.retry = 0;
        connect('join');
      }
    }

    updateUI();
    render();
  }

  /* ---------- interaction ---------- */

  function isOwnTurnPiece(v, p) {
    if (!p) return false;
    if (S.mode === 'local') return p.side === v.turn;
    return p.side === S.online.mySide && canPickOnline(v);
  }

  function handleClick(ev) {
    const v = view();
    if (v.winner) return;
    const hit = cellAt(ev);
    if (!hit) return;
    const { r, c } = hit;

    if (S.mode === 'local') {
      const p = v.board[r][c];
      if (S.selected) {
        if (S.selected.r === r && S.selected.c === c) {
          clearSelection();
          render();
          return;
        }
        if (S.targets.some(([tr, tc]) => tr === r && tc === c)) {
          playLocal(S.selected.r, S.selected.c, r, c);
          return;
        }
      }
      if (p && p.side === v.turn) {
        S.selected = { r, c };
        S.targets = Q.legalMovesFor(v.board, r, c);
      } else {
        clearSelection();
      }
      render();
      return;
    }

    const o = S.online;
    if (o.conn !== 'online' || !o.mySide) return;

    const p = v.board[r][c];
    const canPlay = canPickOnline(v);

    if (canPlay && S.selected) {
      if (S.selected.r === r && S.selected.c === c) {
        clearSelection();
        render();
        return;
      }
      if (S.targets.some(([tr, tc]) => tr === r && tc === c)) {
        const from = [S.selected.r, S.selected.c];
        clearSelection();
        o.pending = true;
        o.error = '';
        try {
          o.socket.send(JSON.stringify({ type: 'move', from, to: [r, c] }));
        } catch (e) {
          o.pending = false;
          o.error = '发送失败，请重试';
        }
        updateUI();
        render();
        return;
      }
    }

    if (canPlay && p && p.side === o.mySide) {
      S.selected = { r, c };
      S.targets = Q.legalMovesFor(v.board, r, c);
    } else {
      clearSelection();
    }
    render();
  }

  function handleMove(ev) {
    const v = view();
    let pointer = false;
    if (!v.winner) {
      const hit = cellAt(ev);
      if (hit) {
        const p = v.board[hit.r][hit.c];
        pointer = isOwnTurnPiece(v, p) ||
          S.targets.some(([tr, tc]) => tr === hit.r && tc === hit.c);
      }
    }
    canvas.style.cursor = pointer ? 'pointer' : 'default';
  }

  /* ---------- drawing ---------- */

  function cellAt(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * (W / rect.width);
    const y = (ev.clientY - rect.top) * (H / rect.height);
    const c = Math.round((x - M) / CELL);
    const r = Math.round((y - M) / CELL);
    if (!Q.inBoard(r, c)) return null;
    const dx = x - (M + c * CELL);
    const dy = y - (M + r * CELL);
    if (Math.hypot(dx, dy) > CELL * 0.62) return null;
    return { r, c };
  }

  function xy(r, c) {
    return { x: M + c * CELL, y: M + r * CELL };
  }

  function roundRect(g, x, y, w, h, radius) {
    g.beginPath();
    g.moveTo(x + radius, y);
    g.arcTo(x + w, y, x + w, y + h, radius);
    g.arcTo(x + w, y + h, x, y + h, radius);
    g.arcTo(x, y + h, x, y, radius);
    g.arcTo(x, y, x + w, y, radius);
    g.closePath();
  }

  function buildBoardLayer() {
    const off = document.createElement('canvas');
    off.width = W * DPR;
    off.height = H * DPR;
    const g = off.getContext('2d');
    g.scale(DPR, DPR);

    const bg = g.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#f8ead0');
    bg.addColorStop(0.5, '#f2dfba');
    bg.addColorStop(1, '#e9d1a4');
    g.fillStyle = bg;
    g.fillRect(0, 0, W, H);

    g.save();
    g.globalAlpha = 0.06;
    for (let i = 0; i < 26; i++) {
      const y = 16 + i * 25.5;
      g.strokeStyle = i % 2 ? '#8a6636' : '#fffdf5';
      g.lineWidth = i % 3 === 0 ? 2 : 1;
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(W * 0.3, y + 7, W * 0.65, y - 6, W, y + 3);
      g.stroke();
    }
    g.restore();

    const right = M + (COLS - 1) * CELL;
    const bottom = M + (ROWS - 1) * CELL;

    g.strokeStyle = 'rgba(92,58,24,.85)';
    g.lineWidth = 2.4;
    g.strokeRect(M - 13, M - 13, right - M + 26, bottom - M + 26);
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(92,58,24,.75)';
    g.strokeRect(M, M, right - M, bottom - M);

    const line = (x1, y1, x2, y2) => {
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    };

    g.strokeStyle = 'rgba(108,72,34,.72)';
    g.lineWidth = 1.2;
    g.lineCap = 'round';

    for (let r = 0; r < ROWS; r++) {
      line(M, M + r * CELL, right, M + r * CELL);
    }
    for (let c = 0; c < COLS; c++) {
      const x = M + c * CELL;
      if (c === 0 || c === COLS - 1) {
        line(x, M, x, bottom);
      } else {
        line(x, M, x, M + 4 * CELL);
        line(x, M + 5 * CELL, x, bottom);
      }
    }

    line(M + 3 * CELL, M, M + 5 * CELL, M + 2 * CELL);
    line(M + 5 * CELL, M, M + 3 * CELL, M + 2 * CELL);
    line(M + 3 * CELL, M + 7 * CELL, M + 5 * CELL, M + 9 * CELL);
    line(M + 5 * CELL, M + 7 * CELL, M + 3 * CELL, M + 9 * CELL);

    const marks = [
      [2, 1], [2, 7], [7, 1], [7, 7],
      [3, 0], [3, 2], [3, 4], [3, 6], [3, 8],
      [6, 0], [6, 2], [6, 4], [6, 6], [6, 8]
    ];
    for (const [r, c] of marks) {
      const { x, y } = xy(r, c);
      const o = 6;
      const len = 8;
      for (const dx of [-1, 1]) {
        for (const dy of [-1, 1]) {
          if ((c === 0 && dx < 0) || (c === COLS - 1 && dx > 0)) continue;
          const sx = x + dx * o;
          const sy = y + dy * o;
          line(sx, sy, sx + dx * len, sy);
          line(sx, sy, sx, sy + dy * len);
        }
      }
    }

    g.save();
    g.fillStyle = 'rgba(112,74,32,.68)';
    g.font = '600 31px "KaiTi","STKaiti","Kaiti SC","SimSun",serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const ry = M + 4.5 * CELL;
    g.fillText('楚  河', M + 2 * CELL, ry);
    g.fillText('漢  界', M + 6 * CELL, ry);
    g.restore();

    return off;
  }

  function drawPiece(g, r, c, p) {
    const { x, y } = xy(r, c);
    const color = p.side === 'r' ? '#a32020' : '#20242c';

    g.save();

    g.beginPath();
    g.arc(x, y + 3, R, 0, Math.PI * 2);
    g.fillStyle = 'rgba(70,45,20,.28)';
    g.fill();

    const grad = g.createRadialGradient(x - R * 0.35, y - R * 0.45, R * 0.15, x, y, R);
    grad.addColorStop(0, '#fffdf6');
    grad.addColorStop(0.65, '#f7ecd3');
    grad.addColorStop(1, '#e3caa0');
    g.beginPath();
    g.arc(x, y, R, 0, Math.PI * 2);
    g.fillStyle = grad;
    g.fill();

    g.lineWidth = 2.2;
    g.strokeStyle = color;
    g.stroke();

    g.beginPath();
    g.arc(x, y, R - 5, 0, Math.PI * 2);
    g.lineWidth = 1;
    g.strokeStyle = p.side === 'r' ? 'rgba(163,32,32,.35)' : 'rgba(32,36,44,.32)';
    g.stroke();

    g.fillStyle = color;
    g.font = '700 32px "KaiTi","STKaiti","Kaiti SC","SimSun",serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(Q.PIECES[p.type][p.side], x, y + 1);

    g.restore();
  }

  const boardLayer = buildBoardLayer();

  function drawGameOver(g, winner, reason) {
    g.save();
    g.fillStyle = 'rgba(26,22,18,.52)';
    g.fillRect(0, 0, W, H);

    const bw = 300;
    const bh = 140;
    const bx = (W - bw) / 2;
    const by = (H - bh) / 2;

    roundRect(g, bx, by, bw, bh, 20);
    g.fillStyle = 'rgba(253,247,235,.97)';
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(160,120,60,.5)';
    g.stroke();

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = winner === 'r' ? '#a32020' : '#20242c';
    g.font = '700 40px "KaiTi","STKaiti","Kaiti SC","SimSun",serif';
    g.fillText(SIDE_NAME[winner] + '胜', W / 2, by + 56);

    g.fillStyle = 'rgba(80,62,42,.85)';
    g.font = '400 15px "PingFang SC","Microsoft YaHei",system-ui,sans-serif';
    g.fillText(reason === '将死' ? '将死无解 · 对局结束' : '困毙无子可动 · 对局结束', W / 2, by + 100);

    g.restore();
  }

  function render() {
    const v = view();

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(boardLayer, 0, 0, W, H);

    if (v.lastMove) {
      for (const [r, c] of [[v.lastMove.fr, v.lastMove.fc], [v.lastMove.tr, v.lastMove.tc]]) {
        const { x, y } = xy(r, c);
        ctx.save();
        ctx.strokeStyle = 'rgba(212,146,44,.8)';
        ctx.lineWidth = 2.5;
        roundRect(ctx, x - 31, y - 31, 62, 62, 9);
        ctx.stroke();
        ctx.restore();
      }
    }

    for (const [r, c] of S.targets) {
      const { x, y } = xy(r, c);
      if (v.board[r][c]) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, R + 4, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(190,48,48,.75)';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, 7.5, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(36,110,72,.5)';
        ctx.fill();
        ctx.restore();
      }
    }

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = v.board[r][c];
        if (p) drawPiece(ctx, r, c, p);
      }
    }

    if (S.selected) {
      const { x, y } = xy(S.selected.r, S.selected.c);
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, R + 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#e0a53e';
      ctx.lineWidth = 3;
      ctx.shadowColor = 'rgba(224,165,62,.85)';
      ctx.shadowBlur = 12;
      ctx.stroke();
      ctx.restore();
    }

    if (v.check && !v.winner) {
      const k = Q.kingPos(v.board, v.turn);
      if (k) {
        const { x, y } = xy(k[0], k[1]);
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, R + 6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(210,45,45,.9)';
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 5]);
        ctx.shadowColor = 'rgba(210,45,45,.8)';
        ctx.shadowBlur = 14;
        ctx.stroke();
        ctx.restore();
      }
    }

    if (v.winner) drawGameOver(ctx, v.winner, v.reason);
  }

  /* ---------- copy ---------- */

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    ta.remove();
  }

  function copyRoom() {
    const o = S.online;
    if (!o.room) return;
    const done = () => {
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.textContent = '复制'; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(o.room).then(done).catch(() => {
        fallbackCopy(o.room);
        done();
      });
    } else {
      fallbackCopy(o.room);
      done();
    }
  }

  /* ---------- wire up ---------- */

  for (const btn of modeButtons) {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
    if (btn.dataset.mode === 'online' && !onlineAvailable) {
      btn.disabled = true;
      btn.title = '联机模式需要部署后通过 http(s) 访问';
    }
  }
  if (!onlineAvailable) modeNote.hidden = false;

  roomInput.addEventListener('input', () => {
    roomInput.value = normalizeRoom(roomInput.value);
    setSetupMsg('');
  });
  roomInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') startOnline('join');
  });
  joinBtn.addEventListener('click', () => startOnline('join'));
  createBtn.addEventListener('click', () => startOnline('create'));
  copyBtn.addEventListener('click', copyRoom);
  leaveBtn.addEventListener('click', leaveRoom);

  canvas.addEventListener('click', handleClick);
  canvas.addEventListener('mousemove', handleMove);
  undoBtn.addEventListener('click', undoLocal);
  restartBtn.addEventListener('click', () => {
    restartLocal();
    updateUI();
    render();
  });

  document.addEventListener('keydown', (ev) => {
    if (S.mode !== 'local') return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      undoLocal();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const o = S.online;
    if (S.mode !== 'online' || !o.room) return;
    if (o.shouldReconnect && !o.socket) {
      clearTimeout(o.timer);
      o.timer = null;
      o.retry = 0;
      o.conn = 'connecting';
      connect('join');
    }
  });

  window.addEventListener('online', () => {
    const o = S.online;
    if (S.mode === 'online' && o.room && o.shouldReconnect && !o.socket) {
      clearTimeout(o.timer);
      o.timer = null;
      o.retry = 0;
      connect('join');
    }
  });

  /* ---------- init ---------- */

  const params = new URLSearchParams(location.search);
  const roomParam = normalizeRoom(params.get('room') || '');
  if (roomParam) roomInput.value = roomParam;

  let startMode = 'local';
  try {
    if (sessionStorage.getItem('xq-mode') === 'online' && onlineAvailable) startMode = 'online';
  } catch (e) { /* storage disabled */ }

  restartLocal();
  const restored = restoreSession();
  if (restored) {
    S.mode = startMode;
    if (S.mode === 'online') {
      const o = S.online;
      o.conn = 'connecting';
      connect('join');
    }
  } else if (roomParam && onlineAvailable) {
    S.mode = 'online';
  }

  updateUI();
  render();
})();
