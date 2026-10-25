import './rules.js';

const R = globalThis.XiangqiRules;
const ROOM_RE = /^[A-Z0-9]{4,8}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

const IDLE_MS = 24 * 60 * 60 * 1000;    // 房间闲置 24 小时自动清理
const SEAT_IDLE_MS = 5 * 60 * 1000;     // 座位离线 5 分钟后允许他人接管
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_MSGS = 120;

function isCell(v) {
  return Array.isArray(v) &&
    v.length === 2 &&
    Number.isInteger(v[0]) &&
    Number.isInteger(v[1]);
}

function attachmentOf(ws) {
  try {
    return ws.deserializeAttachment();
  } catch (e) {
    return null;
  }
}

function emptyState(room) {
  return {
    room,
    board: R.createBoard(),
    turn: 'r',
    log: [],
    lastMove: null,
    winner: null,
    reason: '',
    check: false,
    revision: 0,
    seats: { r: null, b: null },
    seatSeen: { r: 0, b: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

function normalizeState(state) {
  if (!state || typeof state !== 'object') return null;
  if (!Array.isArray(state.board) || state.board.length !== R.ROWS) return null;
  if (!state.seats || typeof state.seats !== 'object') state.seats = { r: null, b: null };
  if (state.seats.r === undefined) state.seats.r = null;
  if (state.seats.b === undefined) state.seats.b = null;
  // 旧数据没有 seatSeen，给个"刚在线"的默认值，避免座位被立刻接管
  if (!state.seatSeen || typeof state.seatSeen !== 'object') {
    state.seatSeen = { r: Date.now(), b: Date.now() };
  }
  if (state.seatSeen.r === undefined) state.seatSeen.r = Date.now();
  if (state.seatSeen.b === undefined) state.seatSeen.b = Date.now();
  if (!Array.isArray(state.log)) state.log = [];
  if (typeof state.revision !== 'number') state.revision = 0;
  if (state.turn !== 'r' && state.turn !== 'b') state.turn = 'r';
  if (state.winner !== 'r' && state.winner !== 'b') state.winner = null;
  if (typeof state.reason !== 'string') state.reason = '';
  if (typeof state.check !== 'boolean') state.check = false;
  if (state.lastMove === undefined) state.lastMove = null;
  return state;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const origin = request.headers.get('Origin');
      if (origin) {
        let originHost = '';
        try { originHost = new URL(origin).host; } catch (e) { originHost = ''; }
        if (originHost !== url.host) return new Response('Origin not allowed', { status: 403 });
      }

      const room = (url.searchParams.get('room') || '').toUpperCase();
      if (!ROOM_RE.test(room)) return new Response('Invalid room code', { status: 400 });

      const id = env.ROOMS.idFromName(room);
      return env.ROOMS.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};

export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = null;
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get('state');
      this.state = normalizeState(stored);
    });
  }

  async save() {
    if (!this.state) return;
    await this.ctx.storage.put('state', this.state);
    // 每次活动续期；闲置超过 IDLE_MS 后由 alarm 回收
    await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
  }

  // 房间闲置回收：还有人在线就续期，否则过期清空
  async alarm() {
    if (this.ctx.getWebSockets().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
      return;
    }
    const saved = await this.ctx.storage.get('state');
    const last = (saved && saved.updatedAt) || 0;
    const remain = last + IDLE_MS - Date.now();
    if (remain > 0) {
      await this.ctx.storage.setAlarm(Date.now() + remain);
      return;
    }
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    this.state = null;
  }

  present() {
    const joined = { r: false, b: false };
    for (const ws of this.ctx.getWebSockets()) {
      const att = attachmentOf(ws);
      if (att && (att.side === 'r' || att.side === 'b')) joined[att.side] = true;
    }
    return joined;
  }

  seatsTaken() {
    const seats = this.state.seats || { r: null, b: null };
    return { r: !!seats.r, b: !!seats.b };
  }

  publicState() {
    const s = this.state;
    return {
      type: 'state',
      room: s.room,
      seatsTaken: this.seatsTaken(),
      joined: this.present(),
      board: s.board,
      turn: s.turn,
      winner: s.winner,
      reason: s.reason,
      check: !!s.check,
      lastMove: s.lastMove,
      log: s.log,
      revision: s.revision || 0
    };
  }

  broadcast() {
    if (!this.state) return;
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const base = this.publicState();
    for (const ws of sockets) {
      const att = attachmentOf(ws);
      if (!att || (att.side !== 'r' && att.side !== 'b')) continue;
      try {
        ws.send(JSON.stringify(Object.assign({}, base, { you: att.side })));
      } catch (e) { /* socket already gone */ }
    }
  }

  rejectSocket(server, message) {
    try {
      this.ctx.acceptWebSocket(server);
      server.send(JSON.stringify({ type: 'error', message, fatal: true }));
      server.close(4001, 'rejected');
    } catch (e) { /* ignore */ }
  }

  sendError(ws, message) {
    try {
      ws.send(JSON.stringify({ type: 'error', message }));
    } catch (e) { /* socket already gone */ }
  }

  async acceptConnection(room, token, create, join, server) {
    let side = null;
    const now = Date.now();
    if (this.state) {
      if (this.state.seats.r === token) side = 'r';
      else if (this.state.seats.b === token) side = 'b';
    }

    if (side) {
      // 老玩家重连，刷新在线时间
      this.state.seatSeen[side] = now;
      this.state.updatedAt = now;
      await this.save();
    } else {
      if (create) {
        if (this.state) {
          this.rejectSocket(server, '房间码已被占用，请重新创建');
          return false;
        }
        this.state = emptyState(room);
        this.state.seats.r = token;
        this.state.seatSeen.r = now;
        side = 'r';
      } else if (join) {
        if (!this.state || !this.state.seats.r) {
          this.rejectSocket(server, '房间不存在或已过期');
          return false;
        }
        if (!this.state.seats.b) {
          this.state.seats.b = token;
          this.state.seatSeen.b = now;
          side = 'b';
        } else {
          // 两个座位都有人：只有"确实离线且超时"的座位才允许新人接管
          // （seatSeen 只在连接/断开时刷新，不能单独用来判断在线状态）
          const live = { r: false, b: false };
          for (const sock of this.ctx.getWebSockets()) {
            const a = attachmentOf(sock);
            if (a && (a.side === 'r' || a.side === 'b')) live[a.side] = true;
          }
          const seen = this.state.seatSeen;
          const idleR = now - (seen.r || 0);
          const idleB = now - (seen.b || 0);
          const canR = !live.r && idleR > SEAT_IDLE_MS;
          const canB = !live.b && idleB > SEAT_IDLE_MS;
          let took = null;
          if (canR && (!canB || idleR >= idleB)) took = 'r';
          else if (canB) took = 'b';
          if (!took) {
            this.rejectSocket(server, '房间已满');
            return false;
          }
          this.state.seats[took] = token;
          this.state.seatSeen[took] = now;
          side = took;
        }
      } else {
        this.rejectSocket(server, '房间不存在或席位已失效');
        return false;
      }
      this.state.updatedAt = now;
      await this.save();
    }

    this.ctx.acceptWebSocket(server);
    try { server.serializeAttachment({ token, side }); } catch (e) { /* ignore */ }

    for (const other of this.ctx.getWebSockets()) {
      if (other === server) continue;
      const att = attachmentOf(other);
      if (att && att.token === token) {
        try { other.close(4002, 'replaced'); } catch (e) { /* ignore */ }
      }
    }

    this.broadcast();
    return true;
  }

  async fetch(request) {
    await this.ready;

    const url = new URL(request.url);
    if (url.pathname !== '/ws') return new Response('Not found', { status: 404 });
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const params = url.searchParams;
    const room = (params.get('room') || '').toUpperCase();
    if (!ROOM_RE.test(room)) return new Response('Invalid room code', { status: 400 });

    const token = params.get('token') || '';
    if (!TOKEN_RE.test(token)) return new Response('Invalid token', { status: 400 });

    const create = params.get('create') === '1';
    const join = params.get('join') === '1';

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    await this.acceptConnection(room, token, create, join, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const att = attachmentOf(ws);
    if (!att || (att.side !== 'r' && att.side !== 'b')) {
      try { ws.close(1008, 'no seat'); } catch (e) { /* ignore */ }
      return;
    }
    if (typeof message !== 'string') return;
    if (message.length > 2000) {
      this.sendError(ws, '消息过长');
      return;
    }

    // 每条连接独立限流
    const now = Date.now();
    if (!att.win || now - att.win > RATE_WINDOW_MS) {
      att.win = now;
      att.n = 0;
    }
    att.n++;
    try { ws.serializeAttachment(att); } catch (e) { /* ignore */ }
    if (att.n > RATE_MAX_MSGS) {
      this.sendError(ws, '操作太频繁，请稍后再试');
      return;
    }

    let data;
    try { data = JSON.parse(message); } catch (e) {
      this.sendError(ws, '消息格式不正确');
      return;
    }
    if (!data || typeof data !== 'object') return;

    if (data.type === 'ping') {
      try { ws.send('{"type":"pong"}'); } catch (e) { /* ignore */ }
      return;
    }
    if (data.type !== 'move') return;

    await this.handleMove(ws, att.side, data);
  }

  async handleMove(ws, side, data) {
    const s = this.state;
    if (!s) {
      this.sendError(ws, '房间不存在');
      return;
    }
    if (s.winner) {
      this.sendError(ws, '对局已结束');
      return;
    }

    const joined = this.present();
    if (!joined.r || !joined.b) {
      this.sendError(ws, '对方不在线，暂时不能落子');
      return;
    }
    if (s.turn !== side) {
      this.sendError(ws, '还没轮到你走棋');
      return;
    }
    if (!isCell(data.from) || !isCell(data.to)) {
      this.sendError(ws, '落子坐标无效');
      return;
    }

    const [fr, fc] = data.from;
    const [tr, tc] = data.to;
    if (!R.inBoard(fr, fc) || !R.inBoard(tr, tc)) {
      this.sendError(ws, '落子坐标无效');
      return;
    }

    const piece = s.board[fr][fc];
    if (!piece || piece.side !== side) {
      this.sendError(ws, '起点没有你的棋子');
      return;
    }

    let legal = false;
    try {
      legal = R.legalMovesFor(s.board, fr, fc)
        .some(([r, c]) => r === tr && c === tc);
    } catch (e) {
      legal = false;
    }
    if (!legal) {
      this.sendError(ws, '这步棋不合规则');
      return;
    }

    const text = R.formatMove(s.board, piece, fr, fc, tr, tc);
    s.board[tr][tc] = piece;
    s.board[fr][fc] = null;
    s.lastMove = { fr, fc, tr, tc };
    s.log.push({ side, text });
    s.turn = R.other(side);

    const status = R.gameStatus(s.board, s.turn);
    s.check = status.check;
    s.winner = status.winner;
    s.reason = status.reason;
    s.revision = (s.revision || 0) + 1;
    s.updatedAt = Date.now();

    await this.save();
    this.broadcast();
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // 连接已在关闭流程中，这里不要再调 ws.close()，否则会抛 "already in CLOSING state"
    const att = attachmentOf(ws);
    if (att && this.state && this.state.seatSeen && (att.side === 'r' || att.side === 'b')) {
      this.state.seatSeen[att.side] = Date.now();
      try { await this.save(); } catch (e) { /* ignore */ }
    }
    this.broadcast();
  }

  async webSocketError(ws, error) {
    this.broadcast();
  }
}
