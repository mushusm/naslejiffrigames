/**
 * NJ-WhatsApp Games — Socket.IO quiz server with rooms and per-question media.
 */

const express = require('express');
const path = require('path');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// In-memory store (OK for MVP). For production, use Redis/DB.
const rooms = new Map();

function makeRoom() {
  const code = nanoid(6).toUpperCase();
  rooms.set(code, {
    code,
    createdAt: Date.now(),
    hostId: null,
    players: new Map(), // socketId -> { name, score, joinedAt }
    state: 'lobby', // 'lobby' | 'question' | 'answer' | 'ended'
    currentIndex: -1,
    currentQuestionStart: 0,
    questions: [],
    leaderboard: []
  });
  return code;
}

function sanitizeText(s, max = 100) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .slice(0, max)
    .trim();
}

function sanitizeUrl(u, max = 500) {
  return String(u || '')
    .replace(/\s/g, '')
    .slice(0, max)
    .trim();
}

function asPublicRoom(room) {
  return {
    code: room.code,
    state: room.state,
    currentIndex: room.currentIndex,
    questionsCount: room.questions.length,
    leaderboard: room.leaderboard.slice(0, 10).map(({ name, score }) => ({ name, score }))
  };
}

io.on('connection', (socket) => {
  let currentRoomCode = null;
  let role = 'guest'; // 'host' | 'player'

  const joinRoom = (code) => {
    currentRoomCode = code;
    socket.join(code);
  };

  socket.on('host:createRoom', (_, ack) => {
    const code = makeRoom();
    const room = rooms.get(code);
    room.hostId = socket.id;
    role = 'host';
    joinRoom(code);
    ack && ack({ ok: true, code, room: asPublicRoom(room) });
    io.to(code).emit('room:update', asPublicRoom(room));
  });

  socket.on('host:loadQuestions', (payload, ack) => {
    try {
      const room = rooms.get(payload.code);
      if (!room || room.hostId !== socket.id) throw new Error('Not host or room missing');
      const parsed = Array.isArray(payload.questions) ? payload.questions : [];
      const allowedTypes = new Set(['image', 'audio', 'video']);
      room.questions = parsed.slice(0, 50).map((q) => {
        const media = q.media && allowedTypes.has(q.media.type)
          ? { type: q.media.type, url: sanitizeUrl(q.media.url) }
          : null;
        return ({
          text: sanitizeText(q.text, 200),
          options: (q.options || []).slice(0, 6).map((o) => sanitizeText(o, 60)),
          correctIndex: Number.isInteger(q.correctIndex) ? q.correctIndex : 0,
          points: q.points || 1000,
          timeLimit: q.timeLimit || 20,
          media
        });
      });
      ack && ack({ ok: true, count: room.questions.length });
      io.to(room.code).emit('room:update', asPublicRoom(room));
    } catch (e) {
      ack && ack({ ok: false, error: e.message });
    }
  });

  socket.on('player:join', ({ code, name }, ack) => {
    code = sanitizeText(code, 10).toUpperCase();
    name = sanitizeText(name, 20) || 'Player';
    const room = rooms.get(code);
    if (!room) return ack && ack({ ok: false, error: 'Room not found' });
    if (room.state !== 'lobby') return ack && ack({ ok: false, error: 'Game already started' });

    joinRoom(code);
    role = 'player';
    room.players.set(socket.id, { name, score: 0, joinedAt: Date.now() });
    ack && ack({ ok: true, room: asPublicRoom(room) });
    io.to(code).emit('lobby:players', Array.from(room.players.values()).map(p => ({ name: p.name, score: p.score })));
  });

  socket.on('host:start', ({ code }, ack) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return ack && ack({ ok: false, error: 'Not host/room' });
    if (!room.questions.length) return ack && ack({ ok: false, error: 'Load questions first' });
    room.state = 'question';
    room.currentIndex = 0;
    room.currentQuestionStart = Date.now();
    io.to(code).emit('game:question', presentQuestion(room));
    io.to(code).emit('room:update', asPublicRoom(room));
    ack && ack({ ok: true });
  });

  socket.on('host:next', ({ code }, ack) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return ack && ack({ ok: false, error: 'Not host/room' });
    if (room.currentIndex + 1 >= room.questions.length) {
      room.state = 'ended';
      finalizeLeaderboard(room);
      io.to(code).emit('game:ended', room.leaderboard);
      io.to(code).emit('room:update', asPublicRoom(room));
      return ack && ack({ ok: true, ended: true });
    }
    room.state = 'question';
    room.currentIndex += 1;
    room.currentQuestionStart = Date.now();
    resetAnswers(room);
    io.to(code).emit('game:question', presentQuestion(room));
    io.to(code).emit('room:update', asPublicRoom(room));
    ack && ack({ ok: true });
  });

  socket.on('host:reveal', ({ code }, ack) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return ack && ack({ ok: false, error: 'Not host/room' });
    room.state = 'answer';
    scoreQuestion(room);
    io.to(code).emit('game:reveal', {
      correctIndex: currentQ(room).correctIndex,
      leaderboard: room.leaderboard
    });
    io.to(code).emit('room:update', asPublicRoom(room));
    ack && ack({ ok: true });
  });

  socket.on('player:answer', ({ code, index }, ack) => {
    const room = rooms.get((code || '').toUpperCase());
    if (!room || room.state !== 'question') return ack && ack({ ok: false });
    const p = room.players.get(socket.id);
    if (!p) return ack && ack({ ok: false });

    const q = currentQ(room);
    if (!q) return ack && ack({ ok: false });

    if (!q.answers) q.answers = new Map();
    if (q.answers.has(socket.id)) return ack && ack({ ok: false, duplicate: true });

    const timeTaken = (Date.now() - room.currentQuestionStart) / 1000;
    q.answers.set(socket.id, { index: Number(index), timeTaken });
    ack && ack({ ok: true });

    io.to(room.hostId).emit('host:answersCount', q.answers.size);
  });

  socket.on('disconnect', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    if (role === 'player') {
      room.players.delete(socket.id);
      io.to(room.code).emit('lobby:players', Array.from(room.players.values()).map(p => ({ name: p.name, score: p.score })));
    }
    if (role === 'host' && room.hostId === socket.id) {
      room.state = 'ended';
      finalizeLeaderboard(room);
      io.to(room.code).emit('game:ended', room.leaderboard);
    }
  });
});

function currentQ(room) { return room.questions[room.currentIndex]; }
function resetAnswers(room) { const q = currentQ(room); if (q) q.answers = new Map(); }
function presentQuestion(room) {
  const q = currentQ(room);
  return {
    index: room.currentIndex,
    total: room.questions.length,
    text: q.text,
    options: q.options,
    timeLimit: q.timeLimit,
    media: q.media || null
  };
}
function scoreQuestion(room) {
  const q = currentQ(room);
  if (!q) return;
  const entries = Array.from(q.answers || new Map());
  const correct = entries.filter(([_, ans]) => ans.index === q.correctIndex)
                         .sort((a, b) => a[1].timeTaken - b[1].timeTaken);
  const base = q.points || 1000; const n = correct.length || 1;
  correct.forEach(([socketId], i) => {
    const player = room.players.get(socketId); if (!player) return;
    const factor = (n - i) / n; player.score += Math.round(base * factor);
  });
  finalizeLeaderboard(room);
}
function finalizeLeaderboard(room) {
  room.leaderboard = Array.from(room.players.values())
    .sort((a, b) => b.score - a.score)
    .map(({ name, score }) => ({ name, score }));
}

httpServer.listen(PORT, () => {
  console.log(`NJ-WhatsApp Games server running on http://localhost:${PORT}`);
});
