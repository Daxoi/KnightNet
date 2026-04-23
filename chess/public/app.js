/* ══════════════════════════════════════════════════════
   KnightNet — Chess Client
   ══════════════════════════════════════════════════════ */

const PIECE_UNICODE = {
  wK:'♔', wQ:'♕', wR:'♖', wB:'♗', wN:'♘', wP:'♙',
  bK:'♚', bQ:'♛', bR:'♜', bB:'♝', bN:'♞', bP:'♟'
};

// ─── State ────────────────────────────────────────────────────
let me = null;
let socket = null;
let game = null; // { gameId, board, turn, timers, color, opponent, castling }
let selectedSq = null;
let legalMovesMap = {};   // "r,c" -> [[r,c],...]
let pendingPromotion = null;
let inQueue = false;
let lastMove = null;

// ─── Init ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  const res = await api('/api/me');
  if (res.ok) {
    me = res.user;
    enterLobby();
  } else {
    showScreen('authScreen');
  }

  // Enter key support on auth forms
  ['loginUser','loginPass'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => { if (e.key==='Enter') login(); });
  });
  ['regUser','regPass'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => { if (e.key==='Enter') register(); });
  });
});

// ─── Auth ─────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById('loginTab').classList.toggle('active', tab==='login');
  document.getElementById('registerTab').classList.toggle('active', tab==='register');
  document.getElementById('loginForm').classList.toggle('hidden', tab!=='login');
  document.getElementById('registerForm').classList.toggle('hidden', tab!=='register');
  document.getElementById('loginError').textContent = '';
  document.getElementById('regError').textContent = '';
}

async function login() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const res = await api('/api/login', { username, password });
  if (res.ok) { me = res.user; enterLobby(); }
  else document.getElementById('loginError').textContent = res.error;
}

async function register() {
  const username = document.getElementById('regUser').value.trim();
  const password = document.getElementById('regPass').value;
  const res = await api('/api/register', { username, password });
  if (res.ok) { me = res.user; enterLobby(); }
  else document.getElementById('regError').textContent = res.error;
}

async function logout() {
  await api('/api/logout', {});
  me = null;
  if (socket) { socket.disconnect(); socket = null; }
  game = null;
  inQueue = false;
  showScreen('authScreen');
}

// ─── Lobby ────────────────────────────────────────────────────
function enterLobby() {
  document.getElementById('sidebarName').textContent = me.username;
  document.getElementById('sidebarRating').textContent = me.rating + ' ELO';
  document.getElementById('sidebarAvatar').textContent = me.username[0].toUpperCase();

  showScreen('lobbyScreen');
  showPanel('play');
  connectSocket();
  loadProfile();
  loadFriends();
}

function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(name + 'Panel').classList.add('active');
  const navIdx = ['play','friends','profile'].indexOf(name);
  document.querySelectorAll('.nav-item')[navIdx]?.classList.add('active');

  if (name === 'profile') loadProfile();
  if (name === 'friends') loadFriends();
}

// ─── Socket ───────────────────────────────────────────────────
function connectSocket() {
  if (socket) return;
  socket = io();

  socket.on('connect', () => {});

  socket.on('gameStart', (data) => startGame(data));
  socket.on('gameRejoin', (data) => startGame(data));

  socket.on('boardUpdate', ({ board, turn, timers, inCheck, lastMove: lm }) => {
    if (!game) return;
    game.board = board;
    game.turn = turn;
    game.timers = timers;
    lastMove = lm;
    renderBoard();
    updateClocks(true);
    if (inCheck) highlightCheck();
    selectedSq = null;
    legalMovesMap = {};
  });

  socket.on('timerUpdate', ({ timers }) => {
    if (!game) return;
    game.timers = timers;
    updateClocks(false);
  });

  socket.on('gameOver', ({ result, reason, timers }) => {
    if (!game) return;
    game.timers = timers;
    updateClocks(false);
    clearInterval(game._localTimer);
    const myColor = game.color;
    let msg, title;
    if (result === '1/2-1/2') { title = 'Draw!'; msg = reasonText(reason); }
    else if ((result === '1-0' && myColor === 'w') || (result === '0-1' && myColor === 'b')) {
      title = '🏆 You Win!'; msg = reasonText(reason);
    } else { title = '💀 You Lose'; msg = reasonText(reason); }
    showModal(title, msg, [
      { label: 'Return to Lobby', action: returnToLobby, primary: true }
    ]);
    game = null;
  });

  socket.on('illegalMove', () => toast('Illegal move', 'error'));
  socket.on('queueJoined', () => {});
  socket.on('queueLeft',   () => {});

  socket.on('legalMoves', ({ from, moves }) => {
    legalMovesMap[from[0]+','+from[1]] = moves;
    renderBoard();
  });

  socket.on('drawOffer', ({ gameId }) => {
    showModal('Draw Offered', 'Your opponent is offering a draw.', [
      { label: 'Accept', action: () => { socket.emit('acceptDraw', { gameId }); closeModal(); }, primary: true },
      { label: 'Decline', action: closeModal }
    ]);
  });

  socket.on('friendRequest', ({ from }) => {
    toast(`${from} sent you a friend request!`, 'success');
    loadFriends();
    updateFriendsBadge();
  });

  socket.on('friendAccepted', ({ username }) => {
    toast(`${username} accepted your friend request!`, 'success');
    loadFriends();
  });

  socket.on('challenge', ({ challengeId, from }) => {
    showModal(`Challenge from ${from}`, `${from} wants to play chess with you!`, [
      { label: 'Accept', action: () => { socket.emit('challengeAccept', { challengeId }); closeModal(); }, primary: true },
      { label: 'Decline', action: () => { socket.emit('challengeDecline', { challengeId }); closeModal(); } }
    ]);
  });

  socket.on('challengeDeclined', () => toast('Challenge declined', 'warning'));

  socket.on('error', (msg) => toast(msg, 'error'));
}

// ─── Matchmaking ──────────────────────────────────────────────
function toggleQueue() {
  if (!inQueue) {
    inQueue = true;
    document.getElementById('queueBtn').classList.add('hidden');
    document.getElementById('queueStatus').classList.remove('hidden');
    socket.emit('joinQueue');
  } else {
    inQueue = false;
    document.getElementById('queueBtn').classList.remove('hidden');
    document.getElementById('queueStatus').classList.add('hidden');
    socket.emit('leaveQueue');
  }
}

// ─── Game Start ───────────────────────────────────────────────
function startGame(data) {
  inQueue = false;
  document.getElementById('queueBtn').classList.remove('hidden');
  document.getElementById('queueStatus').classList.add('hidden');

  game = {
    gameId: data.gameId,
    board: data.board,
    turn: data.turn,
    timers: data.timers,
    color: data.color,
    opponent: data.opponent,
    opponentRating: data.opponentRating,
    castling: data.castling
  };
  lastMove = null;
  selectedSq = null;
  legalMovesMap = {};

  // Set up player bars
  const myColor = game.color;
  const oppColor = myColor === 'w' ? 'b' : 'w';

  document.getElementById('topName').textContent = game.opponent;
  document.getElementById('topRating').textContent = (game.opponentRating || '?') + ' ELO';
  document.getElementById('topAvatar').textContent = game.opponent[0].toUpperCase();

  document.getElementById('bottomName').textContent = me.username + ' (You)';
  document.getElementById('bottomRating').textContent = me.rating + ' ELO';
  document.getElementById('bottomAvatar').textContent = me.username[0].toUpperCase();

  showScreen('gameScreen');
  renderBoard();
  updateClocks(true);
  toast(`Game started! You are ${myColor === 'w' ? 'White ♔' : 'Black ♚'}`, 'success');
}

function returnToLobby() {
  closeModal();
  game = null;
  showScreen('lobbyScreen');
  loadProfile();
  // Re-fetch me for updated rating
  api('/api/me').then(r => {
    if (r.ok) {
      me = r.user;
      document.getElementById('sidebarRating').textContent = me.rating + ' ELO';
      loadProfile();
    }
  });
}

// ─── Board Rendering ──────────────────────────────────────────
function renderBoard() {
  const board = document.getElementById('chessBoard');
  board.innerHTML = '';
  if (!game) return;

  const flipped = game.color === 'b';
  const allLegal = Object.values(legalMovesMap).flat();

  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const r = flipped ? 7 - row : row;
      const c = flipped ? 7 - col : col;

      const sq = document.createElement('div');
      sq.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
      sq.dataset.r = r;
      sq.dataset.c = c;

      // Last move highlight
      if (lastMove && ((lastMove.from[0]===r && lastMove.from[1]===c) || (lastMove.to[0]===r && lastMove.to[1]===c)))
        sq.classList.add('last-move');

      // Selected
      if (selectedSq && selectedSq[0]===r && selectedSq[1]===c)
        sq.classList.add('selected');

      // Legal move targets
      const key = selectedSq ? selectedSq[0]+','+selectedSq[1] : null;
      if (key && legalMovesMap[key]) {
        const legal = legalMovesMap[key];
        if (legal.some(([lr,lc]) => lr===r && lc===c)) {
          sq.classList.add(game.board[r][c] ? 'can-capture' : 'can-move');
        }
      }

      // Coordinates
      if (!flipped ? c === 0 : c === 7) {
        const rank = document.createElement('span');
        rank.className = 'coord-label coord-rank';
        rank.textContent = 8 - r;
        rank.style.color = (r+0) % 2 === 0 ? 'var(--sq-dark)' : 'var(--sq-light)';
        sq.appendChild(rank);
      }
      if (!flipped ? r === 7 : r === 0) {
        const file = document.createElement('span');
        file.className = 'coord-label coord-file';
        file.textContent = 'abcdefgh'[c];
        file.style.color = (r+c) % 2 === 0 ? 'var(--sq-dark)' : 'var(--sq-light)';
        sq.appendChild(file);
      }

      // Piece
      const piece = game.board[r][c];
      if (piece && PIECE_UNICODE[piece]) {
        const span = document.createElement('span');
        span.className = 'piece';
        span.textContent = PIECE_UNICODE[piece];
        sq.appendChild(span);
      }

      sq.addEventListener('click', () => onSquareClick(r, c));
      board.appendChild(sq);
    }
  }
}

function onSquareClick(r, c) {
  if (!game || game.status === 'finished') return;
  if (game.turn !== game.color) return;

  const piece = game.board[r][c];

  // If a square is selected, try to move
  if (selectedSq) {
    const key = selectedSq[0]+','+selectedSq[1];
    const legal = legalMovesMap[key] || [];
    const isLegal = legal.some(([lr,lc]) => lr===r && lc===c);

    if (isLegal) {
      // Check promotion
      const movingPiece = game.board[selectedSq[0]][selectedSq[1]];
      if (movingPiece && movingPiece[1]==='P' && (r===0 || r===7)) {
        pendingPromotion = { from: [selectedSq[0], selectedSq[1]], to: [r, c] };
        showPromotion(game.color);
        return;
      }
      sendMove(selectedSq, [r, c]);
      selectedSq = null;
      legalMovesMap = {};
      renderBoard();
      return;
    }

    // Clicked own piece - re-select
    if (piece && piece[0] === game.color) {
      selectedSq = [r, c];
      legalMovesMap = {};
      renderBoard();
      socket.emit('getLegalMoves', { gameId: game.gameId, from: [r, c] });
      return;
    }

    // Clicked elsewhere - deselect
    selectedSq = null;
    legalMovesMap = {};
    renderBoard();
    return;
  }

  // Select a piece
  if (piece && piece[0] === game.color) {
    selectedSq = [r, c];
    legalMovesMap = {};
    renderBoard();
    socket.emit('getLegalMoves', { gameId: game.gameId, from: [r, c] });
  }
}

function sendMove(from, to, promotion) {
  socket.emit('move', { gameId: game.gameId, from, to, promotion: promotion || null });
}

function showPromotion(color) {
  const pieces = ['Q','R','B','N'];
  const symbols = color === 'w'
    ? ['♕','♖','♗','♘']
    : ['♛','♜','♝','♞'];
  const container = document.getElementById('promotionPieces');
  container.innerHTML = '';
  pieces.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'promo-option';
    div.textContent = symbols[i];
    div.onclick = () => {
      document.getElementById('promotionModal').classList.add('hidden');
      sendMove(pendingPromotion.from, pendingPromotion.to, p);
      pendingPromotion = null;
      selectedSq = null;
      legalMovesMap = {};
    };
    container.appendChild(div);
  });
  document.getElementById('promotionModal').classList.remove('hidden');
}

function highlightCheck() {
  const color = game.turn;
  const board = document.getElementById('chessBoard');
  const squares = board.querySelectorAll('.square');
  squares.forEach(sq => {
    const r = parseInt(sq.dataset.r);
    const c = parseInt(sq.dataset.c);
    if (game.board[r] && game.board[r][c] === color+'K')
      sq.classList.add('in-check');
  });
}

// ─── Clocks ───────────────────────────────────────────────────
function updateClocks(animated) {
  if (!game) return;
  const myColor = game.color;
  const oppColor = myColor === 'w' ? 'b' : 'w';

  const myTime  = game.timers[myColor];
  const oppTime = game.timers[oppColor];

  document.getElementById('bottomClock').textContent = formatTime(myTime);
  document.getElementById('topClock').textContent    = formatTime(oppTime);

  document.getElementById('bottomClock').classList.toggle('active', game.turn === myColor);
  document.getElementById('topClock').classList.toggle('active',    game.turn === oppColor);
  document.getElementById('bottomClock').classList.toggle('danger', myTime  < 30 && game.turn === myColor);
  document.getElementById('topClock').classList.toggle('danger',    oppTime < 30 && game.turn === oppColor);
}

function formatTime(secs) {
  if (secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m.toString().padStart(2,'0') + ':' + s.toString().padStart(2,'0');
}

// ─── Game Controls ────────────────────────────────────────────
function offerDraw() {
  if (!game) return;
  showModal('Offer Draw?', 'Send a draw offer to your opponent?', [
    { label: 'Send Offer', action: () => { socket.emit('offerDraw', { gameId: game.gameId }); closeModal(); toast('Draw offered'); }, primary: true },
    { label: 'Cancel', action: closeModal }
  ]);
}

function confirmResign() {
  if (!game) return;
  showModal('Resign?', 'Are you sure you want to resign this game?', [
    { label: 'Resign', action: () => { socket.emit('resign', { gameId: game.gameId }); closeModal(); }, danger: true },
    { label: 'Cancel', action: closeModal }
  ]);
}

// ─── Friends ──────────────────────────────────────────────────
async function loadFriends() {
  const res = await api('/api/friends');
  if (!res.ok) return;

  const { friends, requests } = res;

  // Pending requests
  const reqSection = document.getElementById('friendRequestsSection');
  const reqList = document.getElementById('friendRequestsList');
  reqList.innerHTML = '';
  if (requests.length > 0) {
    reqSection.classList.remove('hidden');
    requests.forEach(req => {
      const div = document.createElement('div');
      div.className = 'request-item';
      div.innerHTML = `
        <div class="friend-avatar">${req.from[0].toUpperCase()}</div>
        <div class="request-name">${req.from}</div>
        <button class="accept-btn" onclick="acceptFriend('${req.id}')">Accept</button>
        <button class="decline-btn" onclick="declineFriend('${req.id}')">Decline</button>
      `;
      reqList.appendChild(div);
    });
  } else {
    reqSection.classList.add('hidden');
  }

  // Update badge
  const badge = document.getElementById('friendsBadge');
  if (requests.length > 0) {
    badge.textContent = requests.length;
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }

  // Friends list
  const list = document.getElementById('friendsList');
  const noFriends = document.getElementById('noFriends');
  list.innerHTML = '';
  if (friends.length === 0) {
    noFriends.style.display = 'block';
  } else {
    noFriends.style.display = 'none';
    friends.forEach(f => {
      const div = document.createElement('div');
      div.className = 'friend-item';
      const statusDot = f.online ? '<div class="online-dot" title="Online"></div>' : '<div class="offline-dot" title="Offline"></div>';
      const challengeBtn = f.online ? `<button class="challenge-btn" onclick="challengeFriend('${f.id}')">Challenge</button>` : '';
      div.innerHTML = `
        <div class="friend-avatar">${f.username[0].toUpperCase()}</div>
        <div>
          <div class="friend-name">${f.username}</div>
          <div class="friend-rating">${f.rating} ELO</div>
        </div>
        ${challengeBtn}
        ${statusDot}
      `;
      list.appendChild(div);
    });
  }
}

async function sendFriendRequest() {
  const username = document.getElementById('friendSearchInput').value.trim();
  if (!username) return;
  const res = await api('/api/friend/request', { username });
  const el = document.getElementById('friendRequestResult');
  el.textContent = res.ok ? `Friend request sent to ${username}!` : res.error;
  el.style.color = res.ok ? 'var(--accent)' : '#ff6b6b';
  if (res.ok) document.getElementById('friendSearchInput').value = '';
}

async function acceptFriend(requestId) {
  const res = await api('/api/friend/accept', { requestId });
  if (res.ok) { toast('Friend added!', 'success'); loadFriends(); }
}

async function declineFriend(requestId) {
  const res = await api('/api/friend/decline', { requestId });
  if (res.ok) loadFriends();
}

async function challengeFriend(friendId) {
  const res = await api('/api/friend/challenge', { friendId });
  if (res.ok) toast('Challenge sent!', 'success');
  else toast(res.error, 'error');
}

function updateFriendsBadge() {
  api('/api/friends').then(res => {
    if (!res.ok) return;
    const badge = document.getElementById('friendsBadge');
    if (res.requests.length > 0) {
      badge.textContent = res.requests.length;
      badge.style.display = 'inline';
    } else {
      badge.style.display = 'none';
    }
  });
}

// ─── Profile ──────────────────────────────────────────────────
async function loadProfile() {
  const res = await api('/api/me');
  if (res.ok) me = res.user;

  document.getElementById('profileName').textContent = me.username;
  document.getElementById('profileRating').textContent = me.rating + ' ELO';
  document.getElementById('profileAvatar').textContent = me.username[0].toUpperCase();
  document.getElementById('statWins').textContent   = me.wins;
  document.getElementById('statLosses').textContent = me.losses;
  document.getElementById('statDraws').textContent  = me.draws;

  const gRes = await api('/api/games');
  const histEl = document.getElementById('gameHistory');
  histEl.innerHTML = '';
  if (gRes.ok && gRes.games.length > 0) {
    gRes.games.forEach(g => {
      const isWhite = g.white === me.username;
      const result = g.result === '1/2-1/2' ? 'draw'
        : ((g.result === '1-0') === isWhite) ? 'win' : 'loss';
      const opp = isWhite ? g.black : g.white;
      const div = document.createElement('div');
      div.className = 'game-history-item';
      div.innerHTML = `
        <span class="game-result-badge result-${result}">${result === 'win' ? 'Win' : result === 'loss' ? 'Loss' : 'Draw'}</span>
        <span>vs ${opp}</span>
        <span style="margin-left:auto;color:var(--text-muted);font-size:13px">${timeAgo(g.endedAt)}</span>
      `;
      histEl.appendChild(div);
    });
  } else {
    histEl.innerHTML = '<div class="empty-state">No games played yet!</div>';
  }
}

// ─── Modal ────────────────────────────────────────────────────
function showModal(title, body, actions) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalBody').textContent = body;
  const actEl = document.getElementById('modalActions');
  actEl.innerHTML = '';
  actions.forEach(a => {
    const btn = document.createElement('button');
    btn.textContent = a.label;
    btn.className = a.primary ? 'btn-primary' : a.danger ? 'btn-danger' : 'btn-secondary';
    btn.onclick = a.action;
    actEl.appendChild(btn);
  });
  document.getElementById('modalOverlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.add('hidden');
}

// ─── Screen Management ────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ─── Toast ────────────────────────────────────────────────────
function toast(msg, type='') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'slideOut 0.25s ease forwards';
    setTimeout(() => el.remove(), 260);
  }, 3000);
}

// ─── Helpers ──────────────────────────────────────────────────
async function api(url, body) {
  const opts = { headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) {
    opts.method = 'POST';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  return res.json();
}

function reasonText(reason) {
  const map = {
    checkmate: 'by Checkmate', stalemate: 'by Stalemate', timeout: 'on Time',
    resignation: 'by Resignation', agreement: 'by Agreement'
  };
  return map[reason] || reason;
}

function timeAgo(ts) {
  if (!ts) return '';
  const d = (Date.now() - ts) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d/60) + 'm ago';
  if (d < 86400) return Math.floor(d/3600) + 'h ago';
  return Math.floor(d/86400) + 'd ago';
}
