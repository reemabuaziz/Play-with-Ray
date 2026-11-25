import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { Pool } from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const initial = () => ({
  phase: "setup", players: [], names: [], usedNameIds: [], currentPlayerIndex: 0,
  currentName: null, scores: {}, roundTarget: 1000, roundWinners: [], gameNumber: 1,
  timerStartedAt: null, timerDuration: 25, skipsUsed: {}, lastEvent: null
});
const states = new Map();
let activeRoomId = null;
let state = initial();
function roomFile(roomId) { return path.join(dataDir, `${roomId}.json`); }
function loadRoom(roomId) {
  if (states.has(roomId)) return states.get(roomId);
  let roomState = initial();
  try {
    if (!pool && fs.existsSync(roomFile(roomId))) roomState = JSON.parse(fs.readFileSync(roomFile(roomId), "utf8"));
  } catch { roomState = initial(); }
  states.set(roomId, roomState);
  return roomState;
}
function recoverFinishedGame() {
  if (state.phase !== "finished") return false;
  const players = Array.isArray(state.players) ? state.players : [];
  const gameNumber = (Number(state.gameNumber) || 1) + 1;
  state = { ...initial(), players, gameNumber };
  players.forEach(player => { state.scores[player.id] = 0; });
  return true;
}

const persistQueues = new Map();
function persist() {
  const roomId = activeRoomId;
  const savedState = JSON.stringify(state);
  const previous = persistQueues.get(roomId) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    if (pool) {
      await pool.query(
        "INSERT INTO play_with_ray_rooms (room_id, state, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (room_id) DO UPDATE SET state = EXCLUDED.state, updated_at = NOW()",
        [roomId, savedState]
      );
    } else {
      fs.writeFileSync(roomFile(roomId), JSON.stringify(JSON.parse(savedState), null, 2), "utf8");
    }
  });
  persistQueues.set(roomId, next);
  return next;
}
function broadcast() {
  states.set(activeRoomId, state);
  persist().catch(error => console.error("Could not save game state:", error.message));
  io.to(activeRoomId).emit("state", snapshot());
}
function snapshot() {
  return {
    ...state,
    currentName: state.currentName ? { id: state.currentName.id } : null,
    currentPlayer: state.players[state.currentPlayerIndex] || null,
    remainingNames: state.names.filter(n => !state.usedNameIds.includes(n.id)).length,
    publicNames: state.names.map(n => ({ id: n.id, owner: n.owner, used: state.usedNameIds.includes(n.id) })),
    names: state.names.map(n => ({ id: n.id, owner: n.owner, used: state.usedNameIds.includes(n.id) })),
    skipsUsed: { ...state.skipsUsed },
  };
}
function safeText(v) { return String(v ?? "").trim().slice(0, 70); }
function nameKey(value) { return safeText(value).normalize("NFKC").toLowerCase(); }
function randomItem(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function nextTurn() {
  state.timerStartedAt = null;
  state.currentName = null;
  state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
  const unused = state.names.filter(n => !state.usedNameIds.includes(n.id));
  if (!unused.length) {
    state.phase = "finished";
    state.lastEvent = "all_names_used";
  } else {
    state.currentName = randomItem(unused);
    state.usedNameIds.push(state.currentName.id);
    state.phase = "playing";
    state.lastEvent = "turn_started";
  }
}
function advanceWithoutPenalty() {
  nextTurn();
  broadcast();
}
function award(playerId) {
  const player = state.players.find(p => p.id === playerId);
  const explainer = state.players[state.currentPlayerIndex];
  if (!player || !explainer || player.id === explainer.id) return { error: "اختر لاعباً آخر غير الشارح." };
  state.scores[playerId] = (state.scores[playerId] || 0) + 100;
  state.scores[explainer.id] = (state.scores[explainer.id] || 0) + 50;
  const winner = state.players.find(p => (state.scores[p.id] || 0) >= state.roundTarget);
  if (winner) {
    state.roundWinners.push({ playerId: winner.id, name: winner.name, target: state.roundTarget });
    state.phase = "round_winner";
    state.lastEvent = "round_winner";
  } else {
    nextTurn();
  }
  broadcast();
  return { ok: true };
}

app.get("/api/info", (_req, res) => {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const list of Object.values(nets)) for (const n of list || []) {
    if (n.family === "IPv4" && !n.internal) ips.push(n.address);
  }
  res.json({ ips, port: PORT });
});
app.get("/api/state", (_req, res) => res.json(initial()));

const clientDist = path.resolve(__dirname, "../client/dist");
if (fs.existsSync(path.join(clientDist, "index.html"))) {
  app.use(express.static(clientDist));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

io.on("connection", async socket => {
  const requestedRoom = String(socket.handshake.query.roomId || "");
  const roomId = /^[a-zA-Z0-9-]{8,80}$/.test(requestedRoom) ? requestedRoom : crypto.randomUUID();
  if (pool && !states.has(roomId)) {
    const { rows } = await pool.query("SELECT state FROM play_with_ray_rooms WHERE room_id = $1", [roomId]);
    states.set(roomId, rows[0]?.state || initial());
  }
  activeRoomId = roomId;
  state = loadRoom(roomId);
  if (recoverFinishedGame()) {
    states.set(roomId, state);
    persist().catch(error => console.error("Could not save game state:", error.message));
  }
  socket.join(roomId);
  socket.emit("room-ready", { roomId });
  socket.emit("state", snapshot());

  socket.on("register-player", ({ name }, cb = () => {}) => {
    activeRoomId = roomId;
    state = loadRoom(roomId);
    if (state.phase !== "setup") return cb({ error: "التسجيل مغلق حالياً." });
    const clean = safeText(name);
    if (!clean) return cb({ error: "اكتب اسم اللاعب." });
    if (state.players.length >= 10) return cb({ error: "الحد الأعلى 10 لاعبين." });
    if (state.players.some(p => p.name.toLowerCase() === clean.toLowerCase())) return cb({ error: "هذا الاسم مسجل بالفعل." });
    const player = { id: crypto.randomUUID(), name: clean };
    state.players.push(player);
    state.scores[player.id] = 0;
    broadcast();
    cb({ ok: true, player });
  });

  socket.on("submit-names", ({ playerId, names }, cb = () => {}) => {
    activeRoomId = roomId;
    state = loadRoom(roomId);
    if (state.phase !== "setup") return cb({ error: "انتهى وقت إدخال الأسماء." });
    const player = state.players.find(p => p.id === playerId);
    if (!player) return cb({ error: "اختر اسمك من قائمة اللاعبين أولاً." });
    const clean = (Array.isArray(names) ? names : []).map(safeText).filter(Boolean);
    const submittedKeys = new Set();
    for (const name of clean) {
      const key = nameKey(name);
      if (submittedKeys.has(key) || state.names.some(existing => nameKey(existing.value) === key)) {
        return cb({ error: `الاسم «${name}» مكرر. اختر اسماً مختلفاً.` });
      }
      submittedKeys.add(key);
    }
    if (clean.length < 5 || clean.length > 20) return cb({ error: "أدخل من 5 إلى 20 اسماً." });
    const existingByPlayer = state.names.filter(n => n.owner === playerId).length;
    if (existingByPlayer + clean.length > 20) return cb({ error: "وصلت للحد الأعلى 20 اسماً لهذا اللاعب." });
    if (state.names.length + clean.length > 100) return cb({ error: "وصلتم إلى الحد الأعلى 100 اسم." });
    clean.forEach(name => state.names.push({ id: crypto.randomUUID(), value: name, owner: playerId }));
    broadcast();
    cb({ ok: true, added: clean.length });
  });

  socket.on("start-game", (_payload, cb = () => {}) => {
    activeRoomId = roomId;
    state = loadRoom(roomId);
    if (state.phase !== "setup") return cb({ error: "اللعبة بدأت بالفعل." });
    if (state.players.length < 2) return cb({ error: "أضف لاعبين اثنين على الأقل." });
    if (state.players.some(p => state.names.filter(n => n.owner === p.id).length < 5)) return cb({ error: "يجب أن يضيف كل لاعب 5 أسماء على الأقل." });
    if (!state.names.length) return cb({ error: "أدخلوا الأسماء أولاً." });
    state.usedNameIds = [];
    state.currentPlayerIndex = 0;
    state.roundTarget = 1000;
    state.roundWinners = [];
    state.players.forEach(p => state.scores[p.id] = 0);
    state.currentName = randomItem(state.names);
    state.usedNameIds.push(state.currentName.id);
    state.phase = "playing";
    state.lastEvent = "game_started";
    broadcast();
    cb({ ok: true });
  });

  socket.on("reveal-current", ({ playerId }, cb = () => {}) => {
    activeRoomId = roomId;
    state = loadRoom(roomId);
    const currentPlayer = state.players[state.currentPlayerIndex];
    if (state.phase !== "playing" || !state.currentName) return cb({ error: "لا يوجد اسم حالي للكشف." });
    if (!currentPlayer || currentPlayer.id !== playerId) return cb({ error: "هذا ليس دورك حالياً." });
    if (!state.timerStartedAt) {
      state.timerStartedAt = Date.now();
      state.lastEvent = "timer_started";
      broadcast();
    }
    cb({ ok: true, secret: state.currentName.value });
  });

  socket.on("start-timer", (_payload, cb = () => {}) => {
    activeRoomId = roomId;
    state = loadRoom(roomId);
    if (state.phase !== "playing" || state.timerStartedAt) return cb({ error: "لا يمكن بدء المؤقت الآن." });
    state.timerStartedAt = Date.now();
    state.lastEvent = "timer_started";
    broadcast(); cb({ ok: true });
  });

  socket.on("skip-turn", ({ playerId }, cb = () => {}) => {
    activeRoomId = roomId;
    state = loadRoom(roomId);
    const currentPlayer = state.players[state.currentPlayerIndex];
    if (state.phase !== "playing" || !currentPlayer) return cb({ error: "لا توجد جولة نشطة." });
    if (currentPlayer.id !== playerId) return cb({ error: "هذا ليس دورك حالياً." });
    if (state.skipsUsed[playerId]) return cb({ error: "استخدمت التخطي في هذه الجولة بالفعل." });
    state.skipsUsed[playerId] = true;
    state.lastEvent = "turn_skipped";
    advanceWithoutPenalty();
    cb({ ok: true });
  });

  socket.on("cheat-player", ({ playerId }, cb = () => {}) => {
    activeRoomId = roomId;
    state = loadRoom(roomId);
    if (state.phase !== "playing") return cb({ error: "لا توجد جولة نشطة." });
    const player = state.players.find(p => p.id === playerId);
    if (!player) return cb({ error: "اختر لاعباً صحيحاً." });
    state.scores[playerId] = (state.scores[playerId] || 0) - 100;
    state.lastEvent = "cheat_penalty";
    broadcast();
    cb({ ok: true });
  });

  socket.on("award-player", ({ playerId }, cb = () => {}) => {
    activeRoomId = roomId;
    state = loadRoom(roomId);
    if (state.phase !== "playing") return cb({ error: "لا توجد جولة نشطة." });
    const result = award(playerId); cb(result);
  });

  socket.on("no-one-guessed", (_payload, cb = () => {}) => {
    activeRoomId = roomId;
    state = loadRoom(roomId);
    if (state.phase !== "playing") return cb({ error: "لا توجد جولة نشطة." });
    const explainer = state.players[state.currentPlayerIndex];
    if (explainer) state.scores[explainer.id] = (state.scores[explainer.id] || 0) - 100;
    nextTurn(); broadcast(); cb({ ok: true });
  });

  socket.on("continue-round", (_payload, cb = () => {}) => {
    activeRoomId = roomId;
    state = loadRoom(roomId);
    if (state.phase !== "round_winner") return cb({ error: "لا توجد نهاية راوند." });
    if (!state.names.some(n => !state.usedNameIds.includes(n.id))) {
      state.phase = "finished"; state.lastEvent = "all_names_used"; broadcast(); return cb({ ok: true });
    }
    state.roundTarget += 1000;
    state.skipsUsed = {};
    state.phase = "playing";
    nextTurn(); broadcast(); cb({ ok: true });
  });

  socket.on("new-game", ({ keepPlayers }, cb = () => {}) => {
    activeRoomId = roomId;
    state = loadRoom(roomId);
    const players = keepPlayers ? [...state.players] : [];
    const gameNumber = (Number(state.gameNumber) || 1) + 1;
    state = initial();
    state.players = players;
    state.gameNumber = gameNumber;
    players.forEach(p => state.scores[p.id] = 0);
    broadcast(); cb({ ok: true });
  });

  socket.on("remove-player", ({ playerId }, cb = () => {}) => {
    activeRoomId = roomId;
    state = loadRoom(roomId);
    if (state.phase !== "setup") return cb({ error: "يمكن تعديل اللاعبين قبل بدء اللعبة فقط." });
    state.players = state.players.filter(p => p.id !== playerId);
    state.names = state.names.filter(n => n.owner !== playerId);
    delete state.scores[playerId];
    broadcast(); cb({ ok: true });
  });

  socket.on("end-save", (_payload, cb = () => {}) => {
    activeRoomId = roomId;
    state = loadRoom(roomId);
    persist().then(() => cb({ ok: true })).catch(() => cb({ error: "تعذر حفظ اللعبة حالياً." }));
  });

  socket.on("reset-all", (_payload, cb = () => {}) => {
    activeRoomId = roomId;
    state = loadRoom(roomId);
    state = initial(); broadcast(); cb({ ok: true });
  });
});

async function start() {
  if (pool) {
    await pool.query("CREATE TABLE IF NOT EXISTS play_with_ray_rooms (room_id TEXT PRIMARY KEY, state JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  }
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Play With Ray server listening on port ${PORT}`);
  });
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    void (async () => {
      try {
        for (const [roomId, roomState] of states) {
          activeRoomId = roomId;
          state = roomState;
          await persist();
        }
      } catch (error) { console.error("Could not save before shutdown:", error.message); }
      if (pool) await pool.end().catch(error => console.error("Could not close database:", error.message));
      io.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 25_000).unref();
    })();
  });
}

start().catch(error => {
  console.error("Could not start Play With Ray:", error);
  process.exit(1);
});
