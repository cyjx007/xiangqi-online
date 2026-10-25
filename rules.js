(function (root) {
  'use strict';

  const ROWS = 10;
  const COLS = 9;
  const NUM_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const HORSE = [[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]];
  const PIECES = {
    K: { r: '帅', b: '将' },
    A: { r: '仕', b: '士' },
    B: { r: '相', b: '象' },
    N: { r: '马', b: '马' },
    R: { r: '车', b: '车' },
    C: { r: '炮', b: '炮' },
    P: { r: '兵', b: '卒' }
  };

  function other(side) {
    return side === 'r' ? 'b' : 'r';
  }

  function inBoard(r, c) {
    return r >= 0 && r < ROWS && c >= 0 && c < COLS;
  }

  function inPalace(r, c, side) {
    if (c < 3 || c > 5) return false;
    return side === 'r' ? r >= 7 && r <= 9 : r >= 0 && r <= 2;
  }

  function crossedRiver(r, side) {
    return side === 'r' ? r <= 4 : r >= 5;
  }

  function createBoard() {
    const b = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    const back = ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R'];
    back.forEach((type, c) => {
      b[0][c] = { type, side: 'b' };
      b[9][c] = { type, side: 'r' };
    });
    [1, 7].forEach(c => {
      b[2][c] = { type: 'C', side: 'b' };
      b[7][c] = { type: 'C', side: 'r' };
    });
    [0, 2, 4, 6, 8].forEach(c => {
      b[3][c] = { type: 'P', side: 'b' };
      b[6][c] = { type: 'P', side: 'r' };
    });
    return b;
  }

  function pseudoMoves(b, r, c) {
    const p = b[r][c];
    if (!p) return [];
    const out = [];
    const add = (rr, cc) => {
      if (!inBoard(rr, cc)) return;
      const t = b[rr][cc];
      if (t && t.side === p.side) return;
      out.push([rr, cc]);
    };

    switch (p.type) {
      case 'K':
        for (const [dr, dc] of DIRS) {
          if (inPalace(r + dr, c + dc, p.side)) add(r + dr, c + dc);
        }
        break;
      case 'A':
        for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          if (inPalace(r + dr, c + dc, p.side)) add(r + dr, c + dc);
        }
        break;
      case 'B':
        for (const [dr, dc] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
          const rr = r + dr;
          const cc = c + dc;
          if (!inBoard(rr, cc)) continue;
          if (p.side === 'r' ? rr < 5 : rr > 4) continue;
          if (b[r + dr / 2][c + dc / 2]) continue;
          add(rr, cc);
        }
        break;
      case 'N':
        for (const [dr, dc] of HORSE) {
          const rr = r + dr;
          const cc = c + dc;
          if (!inBoard(rr, cc)) continue;
          const lr = r + (Math.abs(dr) === 2 ? dr / 2 : 0);
          const lc = c + (Math.abs(dc) === 2 ? dc / 2 : 0);
          if (b[lr][lc]) continue;
          add(rr, cc);
        }
        break;
      case 'R':
        for (const [dr, dc] of DIRS) {
          let rr = r + dr;
          let cc = c + dc;
          while (inBoard(rr, cc)) {
            const t = b[rr][cc];
            if (!t) {
              out.push([rr, cc]);
            } else {
              if (t.side !== p.side) out.push([rr, cc]);
              break;
            }
            rr += dr;
            cc += dc;
          }
        }
        break;
      case 'C':
        for (const [dr, dc] of DIRS) {
          let rr = r + dr;
          let cc = c + dc;
          let screen = false;
          while (inBoard(rr, cc)) {
            const t = b[rr][cc];
            if (!screen) {
              if (!t) out.push([rr, cc]);
              else screen = true;
            } else if (t) {
              if (t.side !== p.side) out.push([rr, cc]);
              break;
            }
            rr += dr;
            cc += dc;
          }
        }
        break;
      case 'P': {
        const fwd = p.side === 'r' ? -1 : 1;
        add(r + fwd, c);
        if (crossedRiver(r, p.side)) {
          add(r, c - 1);
          add(r, c + 1);
        }
        break;
      }
    }
    return out;
  }

  function kingPos(b, side) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = b[r][c];
        if (p && p.type === 'K' && p.side === side) return [r, c];
      }
    }
    return null;
  }

  function kingsFacing(b) {
    const kr = kingPos(b, 'r');
    const kb = kingPos(b, 'b');
    if (!kr || !kb || kr[1] !== kb[1]) return false;
    const col = kr[1];
    const lo = Math.min(kr[0], kb[0]);
    const hi = Math.max(kr[0], kb[0]);
    for (let r = lo + 1; r < hi; r++) {
      if (b[r][col]) return false;
    }
    return true;
  }

  function isAttacked(b, r, c, bySide) {
    for (let rr = 0; rr < ROWS; rr++) {
      for (let cc = 0; cc < COLS; cc++) {
        const p = b[rr][cc];
        if (!p || p.side !== bySide) continue;
        for (const [tr, tc] of pseudoMoves(b, rr, cc)) {
          if (tr === r && tc === c) return true;
        }
      }
    }
    return false;
  }

  function inCheck(b, side) {
    const k = kingPos(b, side);
    return k ? isAttacked(b, k[0], k[1], other(side)) : false;
  }

  function legalMovesFor(b, r, c) {
    const p = b[r][c];
    if (!p) return [];
    return pseudoMoves(b, r, c).filter(([tr, tc]) => {
      const cap = b[tr][tc];
      b[tr][tc] = p;
      b[r][c] = null;
      const bad = kingsFacing(b) || inCheck(b, p.side);
      b[r][c] = p;
      b[tr][tc] = cap;
      return !bad;
    });
  }

  function hasAnyLegalMove(b, side) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = b[r][c];
        if (p && p.side === side && legalMovesFor(b, r, c).length > 0) return true;
      }
    }
    return false;
  }

  function fileNum(side, c) {
    return side === 'r' ? COLS - c : c + 1;
  }

  function numStr(side, n) {
    return side === 'r' ? NUM_CN[n - 1] : String(n);
  }

  function formatMove(b, p, fr, fc, tr, tc) {
    const side = p.side;
    const name = PIECES[p.type][side];
    let prefix = '';

    if ('RNCP'.includes(p.type)) {
      const same = [];
      for (let r = 0; r < ROWS; r++) {
        const q = b[r][fc];
        if (q && q.side === side && q.type === p.type) same.push(r);
      }
      if (same.length >= 2) {
        same.sort((a, b2) => a - b2);
        const idx = side === 'r' ? same.indexOf(fr) : same.length - 1 - same.indexOf(fr);
        if (same.length === 2) prefix = idx === 0 ? '前' : '后';
        else if (same.length === 3) prefix = ['前', '中', '后'][idx];
        else prefix = idx === 0 ? '前' : idx === same.length - 1 ? '后' : NUM_CN[idx];
      }
    }

    const base = prefix ? prefix + name : name + numStr(side, fileNum(side, fc));

    let action;
    if (tr === fr) {
      action = '平' + numStr(side, fileNum(side, tc));
    } else {
      const forward = side === 'r' ? tr < fr : tr > fr;
      action = forward ? '进' : '退';
      action += 'NBA'.includes(p.type)
        ? numStr(side, fileNum(side, tc))
        : numStr(side, Math.abs(tr - fr));
    }
    return base + action;
  }

  function gameStatus(b, side) {
    const check = inCheck(b, side);
    const over = !hasAnyLegalMove(b, side);
    return {
      over,
      check,
      winner: over ? other(side) : null,
      reason: over ? (check ? '将死' : '困毙') : ''
    };
  }

  root.XiangqiRules = {
    ROWS,
    COLS,
    PIECES,
    other,
    inBoard,
    createBoard,
    pseudoMoves,
    kingPos,
    kingsFacing,
    inCheck,
    legalMovesFor,
    hasAnyLegalMove,
    formatMove,
    gameStatus
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
