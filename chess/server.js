const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: '*' } });

// ─── DB (JSON file-based) ────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data.json');

function loadDB() {
  if (!fs.existsSync(DB_PATH)) {
    const init = { users: [], games: [], friendRequests: [] };
    fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
    return init;
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: 'chess-rpi-secret-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);

// Share session with socket.io
io.use((socket, next) => {
  sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// ─── Auth Routes ─────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.length < 3 || password.length < 6)
    return res.json({ ok: false, error: 'Username ≥ 3 chars, password ≥ 6 chars' });

  const db = loadDB();
  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase()))
    return res.json({ ok: false, error: 'Username already taken' });

  const hash = bcrypt.hashSync(password, 10);
  const user = { id: uuidv4(), username, password: hash, rating: 800, wins: 0, losses: 0, draws: 0, friends: [], createdAt: Date.now() };
  db.users.push(user);
  saveDB(db);
  req.session.userId = user.id;
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const db = loadDB();
  const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.json({ ok: false, error: 'Invalid credentials' });
  req.session.userId = user.id;
  res.json({ ok: true, user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ ok: false });
  const db = loadDB();
  const user = db.users.find(u => u.id === req.session.userId);
  if (!user) return res.json({ ok: false });
  res.json({ ok: true, user: publicUser(user) });
});

// ─── Friends Routes ───────────────────────────────────────────────────────────
app.post('/api/friend/request', requireAuth, (req, res) => {
  const { username } = req.body;
  const db = loadDB();
  const me = db.users.find(u => u.id === req.session.userId);
  const target = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!target) return res.json({ ok: false, error: 'User not found' });
  if (target.id === me.id) return res.json({ ok: false, error: "Can't friend yourself" });
  if (me.friends.includes(target.id)) return res.json({ ok: false, error: 'Already friends' });
  const existing = db.friendRequests.find(r =>
    (r.from === me.id && r.to === target.id) || (r.from === target.id && r.to === me.id)
  );
  if (existing) return res.json({ ok: false, error: 'Request already pending' });
  db.friendRequests.push({ id: uuidv4(), from: me.id, to: target.id, createdAt: Date.now() });
  saveDB(db);
  // Notify target via socket if online
  const targetSocket = onlineUsers.get(target.id);
  if (targetSocket) {
    io.to(targetSocket).emit('friendRequest', { from: me.username });
  }
  res.json({ ok: true });
});

app.post('/api/friend/accept', requireAuth, (req, res) => {
  const { requestId } = req.body;
  const db = loadDB();
  const req2 = db.friendRequests.find(r => r.id === requestId && r.to === req.session.userId);
  if (!req2) return res.json({ ok: false, error: 'Request not found' });
  const me = db.users.find(u => u.id === req.session.userId);
  const other = db.users.find(u => u.id === req2.from);
  me.friends.push(other.id);
  other.friends.push(me.id);
  db.friendRequests = db.friendRequests.filter(r => r.id !== requestId);
  saveDB(db);
  const otherSocket = onlineUsers.get(other.id);
  if (otherSocket) io.to(otherSocket).emit('friendAccepted', { username: me.username });
  res.json({ ok: true });
});

app.post('/api/friend/decline', requireAuth, (req, res) => {
  const { requestId } = req.body;
  const db = loadDB();
  db.friendRequests = db.friendRequests.filter(r => !(r.id === requestId && r.to === req.session.userId));
  saveDB(db);
  res.json({ ok: true });
});

app.get('/api/friends', requireAuth, (req, res) => {
  const db = loadDB();
  const me = db.users.find(u => u.id === req.session.userId);
  const friends = db.users.filter(u => me.friends.includes(u.id)).map(u => ({
    ...publicUser(u), online: onlineUsers.has(u.id)
  }));
  const requests = db.friendRequests
    .filter(r => r.to === me.id)
    .map(r => {
      const sender = db.users.find(u => u.id === r.from);
      return { id: r.id, from: sender.username, fromId: r.from };
    });
  res.json({ ok: true, friends, requests });
});

app.post('/api/friend/challenge', requireAuth, (req, res) => {
  const { friendId } = req.body;
  const db = loadDB();
  const me = db.users.find(u => u.id === req.session.userId);
  const friend = db.users.find(u => u.id === friendId);
  if (!friend || !me.friends.includes(friendId)) return res.json({ ok: false, error: 'Not friends' });
  const targetSocket = onlineUsers.get(friendId);
  if (!targetSocket) return res.json({ ok: false, error: 'Friend is offline' });
  const challengeId = uuidv4();
  pendingChallenges.set(challengeId, { from: me.id, to: friendId, ts: Date.now() });
  io.to(targetSocket).emit('challenge', { challengeId, from: me.username });
  res.json({ ok: true, challengeId });
});

// ─── Game History ─────────────────────────────────────────────────────────────
app.get('/api/games', requireAuth, (req, res) => {
  const db = loadDB();
  const myGames = db.games
    .filter(g => (g.whiteId === req.session.userId || g.blackId === req.session.userId) && g.status === 'finished')
    .sort((a, b) => b.endedAt - a.endedAt)
    .slice(0, 20)
    .map(g => {
      const white = db.users.find(u => u.id === g.whiteId);
      const black = db.users.find(u => u.id === g.blackId);
      return { id: g.id, white: white?.username, black: black?.username, result: g.result, endedAt: g.endedAt };
    });
  res.json({ ok: true, games: myGames });
});

// ─── In-memory State ──────────────────────────────────────────────────────────
const onlineUsers = new Map();    // userId -> socketId
const matchmakingQueue = [];      // [{ userId, socketId, rating }]
const activeGames = new Map();    // gameId -> gameState
const pendingChallenges = new Map(); // challengeId -> { from, to, ts }
const userCurrentGame = new Map(); // userId -> gameId

// ─── Chess Logic ──────────────────────────────────────────────────────────────
// Simple but complete chess implementation
const PIECES = {
  wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
  bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟'
};

function initBoard() {
  const b = Array(8).fill(null).map(() => Array(8).fill(null));
  const order = ['R','N','B','Q','K','B','N','R'];
  for (let c = 0; c < 8; c++) {
    b[0][c] = 'b' + order[c];
    b[1][c] = 'bP';
    b[6][c] = 'wP';
    b[7][c] = 'w' + order[c];
  }
  return b;
}

function inBounds(r, c) { return r >= 0 && r < 8 && c >= 0 && c < 8; }
function pieceColor(p) { return p ? p[0] : null; }
function opponent(color) { return color === 'w' ? 'b' : 'w'; }

function pawnMoves(board, r, c, color, enPassant) {
  const moves = [];
  const dir = color === 'w' ? -1 : 1;
  const startRow = color === 'w' ? 6 : 1;
  if (inBounds(r+dir, c) && !board[r+dir][c]) {
    moves.push([r+dir, c]);
    if (r === startRow && !board[r+2*dir][c]) moves.push([r+2*dir, c]);
  }
  for (const dc of [-1, 1]) {
    if (inBounds(r+dir, c+dc)) {
      if (board[r+dir][c+dc] && pieceColor(board[r+dir][c+dc]) !== color)
        moves.push([r+dir, c+dc]);
      if (enPassant && enPassant[0] === r+dir && enPassant[1] === c+dc)
        moves.push([r+dir, c+dc]);
    }
  }
  return moves;
}

function slidingMoves(board, r, c, color, dirs) {
  const moves = [];
  for (const [dr, dc] of dirs) {
    let nr = r+dr, nc = c+dc;
    while (inBounds(nr, nc)) {
      if (!board[nr][nc]) { moves.push([nr, nc]); }
      else { if (pieceColor(board[nr][nc]) !== color) moves.push([nr, nc]); break; }
      nr += dr; nc += dc;
    }
  }
  return moves;
}

function knightMoves(board, r, c, color) {
  return [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]
    .map(([dr,dc]) => [r+dr,c+dc])
    .filter(([nr,nc]) => inBounds(nr,nc) && pieceColor(board[nr][nc]) !== color);
}

function kingMoves(board, r, c, color) {
  return [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]
    .map(([dr,dc]) => [r+dr,c+dc])
    .filter(([nr,nc]) => inBounds(nr,nc) && pieceColor(board[nr][nc]) !== color);
}

function rawMoves(board, r, c, enPassant) {
  const p = board[r][c]; if (!p) return [];
  const color = p[0], type = p[1];
  if (type === 'P') return pawnMoves(board, r, c, color, enPassant);
  if (type === 'N') return knightMoves(board, r, c, color);
  if (type === 'K') return kingMoves(board, r, c, color);
  if (type === 'R') return slidingMoves(board, r, c, color, [[0,1],[0,-1],[1,0],[-1,0]]);
  if (type === 'B') return slidingMoves(board, r, c, color, [[1,1],[1,-1],[-1,1],[-1,-1]]);
  if (type === 'Q') return slidingMoves(board, r, c, color, [[0,1],[0,-1],[1,0],[-1,0],[1,1],[1,-1],[-1,1],[-1,-1]]);
  return [];
}

function findKing(board, color) {
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (board[r][c] === color+'K') return [r, c];
  return null;
}

function isInCheck(board, color) {
  const [kr, kc] = findKing(board, color);
  const opp = opponent(color);
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (pieceColor(board[r][c]) === opp) {
        const mvs = rawMoves(board, r, c, null);
        if (mvs.some(([mr,mc]) => mr === kr && mc === kc)) return true;
      }
  return false;
}

function applyMove(board, from, to, promotion = 'Q') {
  const b = board.map(r => [...r]);
  const piece = b[from[0]][from[1]];
  b[to[0]][to[1]] = piece;
  b[from[0]][from[1]] = null;
  // Promotion
  if (piece[1] === 'P' && (to[0] === 0 || to[0] === 7))
    b[to[0]][to[1]] = piece[0] + promotion;
  return b;
}

function legalMoves(board, r, c, enPassant, castling) {
  const piece = board[r][c]; if (!piece) return [];
  const color = piece[0];
  const candidates = rawMoves(board, r, c, enPassant);
  const legal = candidates.filter(([tr, tc]) => {
    const nb = applyMove(board, [r,c], [tr,tc]);
    return !isInCheck(nb, color);
  });
  // Castling
  if (piece[1] === 'K' && castling) {
    const row = color === 'w' ? 7 : 0;
    if (r === row && c === 4) {
      if (castling[color+'K'] && !board[row][5] && !board[row][6] &&
          board[row][7] === color+'R' && !isInCheck(board, color) &&
          !isInCheck(applyMove(board,[row,4],[row,5]),color) &&
          !isInCheck(applyMove(board,[row,4],[row,6]),color))
        legal.push([row, 6]);
      if (castling[color+'Q'] && !board[row][3] && !board[row][2] && !board[row][1] &&
          board[row][0] === color+'R' && !isInCheck(board, color) &&
          !isInCheck(applyMove(board,[row,4],[row,3]),color) &&
          !isInCheck(applyMove(board,[row,4],[row,2]),color))
        legal.push([row, 2]);
    }
  }
  return legal;
}

function hasAnyLegalMove(board, color, enPassant, castling) {
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      if (pieceColor(board[r][c]) === color)
        if (legalMoves(board, r, c, enPassant, castling).length > 0) return true;
  return false;
}

// ─── Game Management ──────────────────────────────────────────────────────────
function createGame(whiteId, blackId, whiteSocket, blackSocket) {
  const gameId = uuidv4();
  const db = loadDB();
  const white = db.users.find(u => u.id === whiteId);
  const black = db.users.find(u => u.id === blackId);

  const game = {
    id: gameId,
    whiteId, blackId,
    whiteName: white.username,
    blackName: black.username,
    whiteRating: white.rating,
    blackRating: black.rating,
    board: initBoard(),
    turn: 'w',
    timers: { w: 20*60, b: 20*60 }, // seconds
    lastTick: Date.now(),
    enPassant: null,
    castling: { wK: true, wQ: true, bK: true, bQ: true },
    status: 'active', // active | finished
    result: null, // '1-0' | '0-1' | '1/2-1/2'
    moves: [],
    startedAt: Date.now()
  };

  activeGames.set(gameId, game);
  userCurrentGame.set(whiteId, gameId);
  userCurrentGame.set(blackId, gameId);

  // Save game record
  const dbGame = { id: gameId, whiteId, blackId, status: 'active', startedAt: Date.now() };
  const dbRef = loadDB();
  dbRef.games.push(dbGame);
  saveDB(dbRef);

  // Start timer
  game.timerInterval = setInterval(() => tickTimer(gameId), 1000);

  return game;
}

function tickTimer(gameId) {
  const game = activeGames.get(gameId);
  if (!game || game.status !== 'active') return;
  const now = Date.now();
  const elapsed = (now - game.lastTick) / 1000;
  game.lastTick = now;
  game.timers[game.turn] -= elapsed;
  if (game.timers[game.turn] <= 0) {
    game.timers[game.turn] = 0;
    endGame(gameId, game.turn === 'w' ? '0-1' : '1-0', 'timeout');
  } else {
    io.to(gameId).emit('timerUpdate', { timers: game.timers });
  }
}

function endGame(gameId, result, reason) {
  const game = activeGames.get(gameId);
  if (!game || game.status === 'finished') return;
  clearInterval(game.timerInterval);
  game.status = 'finished';
  game.result = result;
  game.endedAt = Date.now();

  // Update ratings (simple Elo)
  const db = loadDB();
  const white = db.users.find(u => u.id === game.whiteId);
  const black = db.users.find(u => u.id === game.blackId);
  if (white && black) {
    const [wDelta, bDelta] = eloUpdate(white.rating, black.rating, result);
    white.rating = Math.max(100, white.rating + wDelta);
    black.rating = Math.max(100, black.rating + bDelta);
    if (result === '1-0') { white.wins++; black.losses++; }
    else if (result === '0-1') { black.wins++; white.losses++; }
    else { white.draws++; black.draws++; }
    // Update game record
    const dbGame = db.games.find(g => g.id === gameId);
    if (dbGame) { dbGame.status = 'finished'; dbGame.result = result; dbGame.endedAt = game.endedAt; }
    saveDB(db);
  }

  userCurrentGame.delete(game.whiteId);
  userCurrentGame.delete(game.blackId);

  io.to(gameId).emit('gameOver', { result, reason, timers: game.timers });
}

function eloUpdate(rA, rB, result) {
  const K = 32;
  const expA = 1 / (1 + Math.pow(10, (rB - rA) / 400));
  const scoreA = result === '1-0' ? 1 : result === '0-1' ? 0 : 0.5;
  const delta = Math.round(K * (scoreA - expA));
  return [delta, -delta];
}

// ─── Matchmaking ──────────────────────────────────────────────────────────────
function tryMatchmake() {
  // Clean stale entries
  const now = Date.now();
  for (let i = matchmakingQueue.length - 1; i >= 0; i--) {
    const entry = matchmakingQueue[i];
    if (!onlineUsers.has(entry.userId) || now - entry.joinedAt > 5 * 60 * 1000)
      matchmakingQueue.splice(i, 1);
  }

  if (matchmakingQueue.length < 2) return;

  // Match closest ratings
  matchmakingQueue.sort((a, b) => a.rating - b.rating);
  const a = matchmakingQueue.shift();
  const b = matchmakingQueue.shift();

  const coinflip = Math.random() < 0.5;
  const whiteId = coinflip ? a.userId : b.userId;
  const blackId = coinflip ? b.userId : a.userId;
  const whiteSocket = onlineUsers.get(whiteId);
  const blackSocket = onlineUsers.get(blackId);

  const game = createGame(whiteId, blackId, whiteSocket, blackSocket);

  const db = loadDB();
  const white = db.users.find(u => u.id === whiteId);
  const black = db.users.find(u => u.id === blackId);

  const payload = {
    gameId: game.id,
    board: game.board,
    turn: game.turn,
    timers: game.timers,
    castling: game.castling
  };

  const whiteSocket2 = onlineUsers.get(whiteId);
  const blackSocket2 = onlineUsers.get(blackId);

  if (whiteSocket2) {
    io.to(whiteSocket2).emit('gameStart', { ...payload, color: 'w', opponent: black.username, opponentRating: black.rating });
    io.sockets.sockets.get(whiteSocket2)?.join(game.id);
  }
  if (blackSocket2) {
    io.to(blackSocket2).emit('gameStart', { ...payload, color: 'b', opponent: white.username, opponentRating: white.rating });
    io.sockets.sockets.get(blackSocket2)?.join(game.id);
  }
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const userId = socket.request.session?.userId;
  if (!userId) { socket.disconnect(); return; }

  onlineUsers.set(userId, socket.id);

  // Rejoin active game if any
  const activeGameId = userCurrentGame.get(userId);
  if (activeGameId) {
    socket.join(activeGameId);
    const game = activeGames.get(activeGameId);
    if (game) {
      socket.emit('gameRejoin', {
        gameId: game.id,
        board: game.board,
        turn: game.turn,
        timers: game.timers,
        castling: game.castling,
        color: game.whiteId === userId ? 'w' : 'b',
        opponent: game.whiteId === userId ? game.blackName : game.whiteName,
        opponentRating: game.whiteId === userId ? game.blackRating : game.whiteRating
      });
    }
  }

  socket.on('joinQueue', () => {
    if (userCurrentGame.has(userId)) {
      socket.emit('error', 'Already in a game');
      return;
    }
    const db = loadDB();
    const user = db.users.find(u => u.id === userId);
    if (!user) return;
    if (!matchmakingQueue.find(e => e.userId === userId))
      matchmakingQueue.push({ userId, socketId: socket.id, rating: user.rating, joinedAt: Date.now() });
    socket.emit('queueJoined', { position: matchmakingQueue.length });
    tryMatchmake();
  });

  socket.on('leaveQueue', () => {
    const idx = matchmakingQueue.findIndex(e => e.userId === userId);
    if (idx >= 0) matchmakingQueue.splice(idx, 1);
    socket.emit('queueLeft');
  });

  socket.on('move', ({ gameId, from, to, promotion }) => {
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'active') return;
    const color = game.whiteId === userId ? 'w' : 'b';
    if (game.turn !== color) return;

    const legal = legalMoves(game.board, from[0], from[1], game.enPassant, game.castling);
    if (!legal.some(([r,c]) => r === to[0] && c === to[1])) {
      socket.emit('illegalMove'); return;
    }

    const piece = game.board[from[0]][from[1]];

    // En passant capture
    let newBoard = game.board.map(r => [...r]);
    newBoard[to[0]][to[1]] = piece;
    newBoard[from[0]][from[1]] = null;

    // Handle en passant capture
    if (piece[1] === 'P' && game.enPassant && to[0] === game.enPassant[0] && to[1] === game.enPassant[1])
      newBoard[from[0]][to[1]] = null;

    // Castling move
    if (piece[1] === 'K') {
      const row = color === 'w' ? 7 : 0;
      if (from[1] === 4 && to[1] === 6) { newBoard[row][5] = color+'R'; newBoard[row][7] = null; }
      if (from[1] === 4 && to[1] === 2) { newBoard[row][3] = color+'R'; newBoard[row][0] = null; }
      game.castling[color+'K'] = false;
      game.castling[color+'Q'] = false;
    }
    if (piece[1] === 'R') {
      if (from[1] === 7) game.castling[color+'K'] = false;
      if (from[1] === 0) game.castling[color+'Q'] = false;
    }

    // Promotion
    if (piece[1] === 'P' && (to[0] === 0 || to[0] === 7))
      newBoard[to[0]][to[1]] = color + (promotion || 'Q');

    // En passant tracking
    game.enPassant = (piece[1] === 'P' && Math.abs(to[0] - from[0]) === 2)
      ? [(from[0] + to[0]) / 2, to[1]] : null;

    game.board = newBoard;
    game.moves.push({ from, to, piece, ts: Date.now() });
    game.lastTick = Date.now();

    const opp = opponent(color);
    game.turn = opp;

    // Check game end
    const inCheck = isInCheck(newBoard, opp);
    const hasMove = hasAnyLegalMove(newBoard, opp, game.enPassant, game.castling);

    let gameOver = null;
    if (!hasMove) {
      gameOver = inCheck
        ? { result: color === 'w' ? '1-0' : '0-1', reason: 'checkmate' }
        : { result: '1/2-1/2', reason: 'stalemate' };
    }

    io.to(gameId).emit('boardUpdate', {
      board: newBoard,
      turn: game.turn,
      timers: game.timers,
      inCheck,
      lastMove: { from, to }
    });

    if (gameOver) endGame(gameId, gameOver.result, gameOver.reason);
  });

  socket.on('getLegalMoves', ({ gameId, from }) => {
    const game = activeGames.get(gameId);
    if (!game) return;
    const moves = legalMoves(game.board, from[0], from[1], game.enPassant, game.castling);
    socket.emit('legalMoves', { from, moves });
  });

  socket.on('resign', ({ gameId }) => {
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'active') return;
    const color = game.whiteId === userId ? 'w' : 'b';
    endGame(gameId, color === 'w' ? '0-1' : '1-0', 'resignation');
  });

  socket.on('offerDraw', ({ gameId }) => {
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'active') return;
    const oppId = game.whiteId === userId ? game.blackId : game.whiteId;
    const oppSocket = onlineUsers.get(oppId);
    if (oppSocket) io.to(oppSocket).emit('drawOffer', { gameId });
  });

  socket.on('acceptDraw', ({ gameId }) => {
    endGame(gameId, '1/2-1/2', 'agreement');
  });

  socket.on('challengeAccept', ({ challengeId }) => {
    const challenge = pendingChallenges.get(challengeId);
    if (!challenge || challenge.to !== userId) return;
    pendingChallenges.delete(challengeId);
    const fromSocket = onlineUsers.get(challenge.from);
    const toSocket = onlineUsers.get(challenge.to);
    const game = createGame(challenge.from, challenge.to, fromSocket, toSocket);
    const db = loadDB();
    const white = db.users.find(u => u.id === challenge.from);
    const black = db.users.find(u => u.id === challenge.to);
    const payload = { gameId: game.id, board: game.board, turn: game.turn, timers: game.timers, castling: game.castling };
    if (fromSocket) { io.to(fromSocket).emit('gameStart', { ...payload, color: 'w', opponent: black.username, opponentRating: black.rating }); io.sockets.sockets.get(fromSocket)?.join(game.id); }
    if (toSocket) { io.to(toSocket).emit('gameStart', { ...payload, color: 'b', opponent: white.username, opponentRating: white.rating }); io.sockets.sockets.get(toSocket)?.join(game.id); }
  });

  socket.on('challengeDecline', ({ challengeId }) => {
    const challenge = pendingChallenges.get(challengeId);
    if (!challenge || challenge.to !== userId) return;
    pendingChallenges.delete(challengeId);
    const fromSocket = onlineUsers.get(challenge.from);
    if (fromSocket) io.to(fromSocket).emit('challengeDeclined');
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(userId);
    const idx = matchmakingQueue.findIndex(e => e.userId === userId);
    if (idx >= 0) matchmakingQueue.splice(idx, 1);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ ok: false, error: 'Not logged in' });
  next();
}

function publicUser(u) {
  return { id: u.id, username: u.username, rating: u.rating, wins: u.wins, losses: u.losses, draws: u.draws };
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`♟  Chess server running on http://0.0.0.0:${PORT}`);
});
