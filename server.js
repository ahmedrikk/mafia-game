const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Debug: log the working directory
console.log('__dirname:', __dirname);
console.log('public path:', path.join(__dirname, 'public'));

app.use(express.static(path.join(__dirname, 'public')));

// Explicit fallback for root path
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

const rooms = new Map();
const ROLES = ['Mafia', 'Mafia', 'Doctor', 'Detective', 'Villager', 'Villager', 'Villager', 'Villager'];

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getRoleDescription(role) {
  const desc = {
    'Mafia': 'Eliminate villagers at night. Deceive during the day.',
    'Doctor': 'Choose someone to save from the Mafia each night.',
    'Detective': 'Investigate one player each night to learn if they are Mafia.',
    'Villager': 'Find and vote out the Mafia during the day.'
  };
  return desc[role] || 'Survive and help your team.';
}

function checkWinCondition(room) {
  const alivePlayers = room.players.filter(p => p.alive);
  const aliveMafia = alivePlayers.filter(p => p.role === 'Mafia');
  const aliveVillagers = alivePlayers.filter(p => p.role !== 'Mafia');

  if (aliveMafia.length === 0) return 'Villagers';
  if (aliveMafia.length >= aliveVillagers.length) return 'Mafia';
  return null;
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('create-room', ({ playerName }) => {
    const code = generateRoomCode();
    const room = {
      code,
      players: [{ id: socket.id, name: playerName, host: true, alive: true }],
      phase: 'lobby',
      round: 0,
      votes: new Map(),
      nightActions: new Map(),
      messages: []
    };
    rooms.set(code, room);
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room-created', { code, playerId: socket.id });
    io.to(code).emit('update-players', room.players);
  });

  socket.on('join-room', ({ code, playerName }) => {
    const room = rooms.get(code.toUpperCase());
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }
    if (room.phase !== 'lobby') {
      socket.emit('error', 'Game already started');
      return;
    }
    if (room.players.find(p => p.name === playerName)) {
      socket.emit('error', 'Name already taken in this room');
      return;
    }

    const player = { id: socket.id, name: playerName, host: false, alive: true };
    room.players.push(player);
    socket.join(code);
    socket.roomCode = code;
    socket.emit('room-joined', { code, playerId: socket.id });
    io.to(code).emit('update-players', room.players);
  });

  socket.on('start-game', () => {
    const room = rooms.get(socket.roomCode);
    if (!room || !room.players.find(p => p.id === socket.id)?.host) return;
    if (room.players.length < 4) {
      socket.emit('error', 'Need at least 4 players');
      return;
    }

    const roles = shuffle(ROLES.slice(0, room.players.length));
    room.players.forEach((p, i) => {
      p.role = roles[i];
      p.alive = true;
    });

    room.phase = 'night';
    room.round = 1;
    room.nightActions.clear();
    room.votes.clear();

    room.players.forEach(p => {
      const mafiaTeam = p.role === 'Mafia' 
        ? room.players.filter(x => x.role === 'Mafia').map(x => x.name)
        : null;

      io.to(p.id).emit('game-started', {
        role: p.role,
        description: getRoleDescription(p.role),
        mafiaTeam,
        phase: 'night',
        players: room.players.map(x => ({ id: x.id, name: x.name, alive: x.alive }))
      });
    });

    startNightPhase(room);
  });

  function startNightPhase(room) {
    room.phase = 'night';
    room.nightActions.clear();
    room.messages = [];

    const alivePlayers = room.players.filter(p => p.alive);
    const mafiaAlive = alivePlayers.filter(p => p.role === 'Mafia');
    const doctorAlive = alivePlayers.filter(p => p.role === 'Doctor');
    const detectiveAlive = alivePlayers.filter(p => p.role === 'Detective');

    io.to(room.code).emit('phase-change', {
      phase: 'night',
      round: room.round,
      message: 'Night falls... everyone close your eyes.',
      activeRoles: {
        mafia: mafiaAlive.length > 0,
        doctor: doctorAlive.length > 0,
        detective: detectiveAlive.length > 0
      }
    });
  }

  function startDayPhase(room) {
    room.phase = 'day';
    room.votes.clear();

    const actions = room.nightActions;
    const mafiaTarget = actions.get('mafia-kill');
    const doctorSave = actions.get('doctor-save');
    const detectiveCheck = actions.get('detective-check');

    let killed = null;
    let saved = false;
    let detectiveResult = null;

    if (mafiaTarget) {
      if (doctorSave && doctorSave.target === mafiaTarget.target) {
        saved = true;
      } else {
        const target = room.players.find(p => p.id === mafiaTarget.target);
        if (target) {
          target.alive = false;
          killed = target.name;
        }
      }
    }

    if (detectiveCheck) {
      const target = room.players.find(p => p.id === detectiveCheck.target);
      if (target) {
        detectiveResult = {
          name: target.name,
          isMafia: target.role === 'Mafia'
        };
      }
    }

    const winner = checkWinCondition(room);
    if (winner) {
      io.to(room.code).emit('game-over', {
        winner,
        players: room.players.map(p => ({ name: p.name, role: p.role, alive: p.alive }))
      });
      room.phase = 'ended';
      return;
    }

    io.to(room.code).emit('phase-change', {
      phase: 'day',
      round: room.round,
      message: 'Morning breaks...',
      killed,
      saved,
      detectiveResult: detectiveResult ? { ...detectiveResult, detectiveId: detectiveCheck.id } : null,
      players: room.players.map(p => ({ id: p.id, name: p.name, alive: p.alive }))
    });
  }

  socket.on('night-action', ({ action, targetId }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'night') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.alive) return;

    if (action === 'kill' && player.role === 'Mafia') {
      room.nightActions.set('mafia-kill', { id: socket.id, target: targetId });
      socket.emit('action-confirmed', { message: 'You have chosen your target.' });
      checkNightEnd(room);
    } else if (action === 'save' && player.role === 'Doctor') {
      room.nightActions.set('doctor-save', { id: socket.id, target: targetId });
      socket.emit('action-confirmed', { message: 'You have chosen someone to save.' });
      checkNightEnd(room);
    } else if (action === 'investigate' && player.role === 'Detective') {
      room.nightActions.set('detective-check', { id: socket.id, target: targetId });
      const target = room.players.find(p => p.id === targetId);
      socket.emit('action-confirmed', { 
        message: `Investigation complete: ${target.name} is ${target.role === 'Mafia' ? 'MAFIA' : 'NOT MAFIA'}.` 
      });
      checkNightEnd(room);
    }
  });

  function checkNightEnd(room) {
    const alivePlayers = room.players.filter(p => p.alive);
    const mafiaNeeded = alivePlayers.filter(p => p.role === 'Mafia').length > 0 ? 1 : 0;
    const doctorNeeded = alivePlayers.filter(p => p.role === 'Doctor').length > 0 ? 1 : 0;
    const detectiveNeeded = alivePlayers.filter(p => p.role === 'Detective').length > 0 ? 1 : 0;

    let completed = 0;
    if (room.nightActions.has('mafia-kill') || mafiaNeeded === 0) completed++;
    if (room.nightActions.has('doctor-save') || doctorNeeded === 0) completed++;
    if (room.nightActions.has('detective-check') || detectiveNeeded === 0) completed++;

    if (completed === 3) {
      setTimeout(() => startDayPhase(room), 2000);
    }
  }

  socket.on('vote', ({ targetId }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'day') return;

    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || !voter.alive) return;

    room.votes.set(socket.id, targetId);

    const aliveCount = room.players.filter(p => p.alive).length;
    if (room.votes.size === aliveCount) {
      resolveVoting(room);
    } else {
      io.to(room.code).emit('vote-update', { 
        votes: Array.from(room.votes.entries()).map(([voter, target]) => ({
          voter: room.players.find(p => p.id === voter)?.name,
          target: room.players.find(p => p.id === target)?.name
        }))
      });
    }
  });

  function resolveVoting(room) {
    const voteCounts = new Map();
    room.votes.forEach((targetId) => {
      voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1);
    });

    let maxVotes = 0;
    let eliminated = null;
    let tie = false;

    voteCounts.forEach((count, targetId) => {
      if (count > maxVotes) {
        maxVotes = count;
        eliminated = targetId;
        tie = false;
      } else if (count === maxVotes) {
        tie = true;
      }
    });

    if (!tie && eliminated) {
      const player = room.players.find(p => p.id === eliminated);
      if (player) player.alive = false;

      const winner = checkWinCondition(room);
      if (winner) {
        io.to(room.code).emit('game-over', {
          winner,
          eliminated: player?.name,
          eliminatedRole: player?.role,
          players: room.players.map(p => ({ name: p.name, role: p.role, alive: p.alive }))
        });
        room.phase = 'ended';
        return;
      }

      io.to(room.code).emit('voting-result', {
        eliminated: player?.name,
        eliminatedRole: player?.role,
        votes: Array.from(voteCounts.entries()).map(([id, count]) => ({
          name: room.players.find(p => p.id === id)?.name,
          count
        }))
      });

      room.round++;
      setTimeout(() => startNightPhase(room), 5000);
    } else {
      io.to(room.code).emit('voting-result', {
        tie: true,
        message: 'The vote is tied! No one is eliminated.',
        votes: Array.from(voteCounts.entries()).map(([id, count]) => ({
          name: room.players.find(p => p.id === id)?.name,
          count
        }))
      });
      room.round++;
      setTimeout(() => startNightPhase(room), 5000);
    }
  }

  socket.on('send-message', ({ text }) => {
    const room = rooms.get(socket.roomCode);
    if (!room || room.phase !== 'day') return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.alive) return;

    const msg = { name: player.name, text, time: Date.now() };
    room.messages.push(msg);
    io.to(room.code).emit('new-message', msg);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const room = rooms.get(socket.roomCode);
    if (room) {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        rooms.delete(socket.roomCode);
      } else {
        if (room.phase === 'lobby') {
          io.to(socket.roomCode).emit('update-players', room.players);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mafia server running on port ${PORT}`);
});
