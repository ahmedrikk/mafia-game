const socket = io();

let myId = null;
let myRole = null;
let roomCode = null;
let isHost = false;
let currentPhase = 'lobby';
let players = [];
let selectedTarget = null;
let hasActed = false;

// Screen management
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function createRoom() {
  const name = document.getElementById('player-name').value.trim();
  if (!name) return showToast('Enter your name', 'error');
  socket.emit('create-room', { playerName: name });
}

function joinRoom() {
  const name = document.getElementById('player-name').value.trim();
  const code = document.getElementById('room-code').value.trim();
  if (!name) return showToast('Enter your name', 'error');
  if (!code) return showToast('Enter room code', 'error');
  socket.emit('join-room', { code, playerName: name });
}

function startGame() {
  socket.emit('start-game');
}

// Socket events
socket.on('room-created', ({ code, playerId }) => {
  roomCode = code;
  myId = playerId;
  isHost = true;
  showLobby(code);
});

socket.on('room-joined', ({ code, playerId }) => {
  roomCode = code;
  myId = playerId;
  isHost = false;
  showLobby(code);
});

socket.on('update-players', (playersList) => {
  players = playersList;
  renderLobbyPlayers(playersList);
  const me = playersList.find(p => p.id === myId);
  if (me?.host) {
    isHost = true;
    document.getElementById('start-btn').classList.remove('hidden');
  }
});

socket.on('game-started', ({ role, description, mafiaTeam, phase, players: gamePlayers }) => {
  myRole = role;
  players = gamePlayers;
  showScreen('screen-game');

  document.getElementById('role-badge').textContent = role;
  document.getElementById('role-badge').style.borderColor = getRoleColor(role);

  let msg = `You are a <strong>${role}</strong>. ${description}`;
  if (mafiaTeam) {
    msg += `<br><br>Your Mafia partners: <strong>${mafiaTeam.join(', ')}</strong>`;
  }
  document.getElementById('narrator').innerHTML = msg;

  log('Game started! Your role: ' + role);
  renderGamePlayers(players);
});

socket.on('phase-change', ({ phase, round, message, killed, saved, detectiveResult, players: gamePlayers, activeRoles }) => {
  currentPhase = phase;
  hasActed = false;
  selectedTarget = null;
  players = gamePlayers || players;

  document.getElementById('phase-badge').textContent = `${phase.toUpperCase()} ${round}`;

  let narratorText = message;
  const me = players.find(p => p.id === myId);

  if (phase === 'day') {
    document.getElementById('chat-input-area').style.display = 'flex';

    if (killed) {
      narratorText += `<br><br><strong style="color: var(--danger)">${killed}</strong> was found dead during the night.`;
      log(`${killed} was killed during the night.`);
      addChatMessage('System', `${killed} was found dead! ☠️`, 'death');
    } else if (saved) {
      narratorText += `<br><br>No one died. The Doctor saved someone!`;
      log('The Doctor saved the Mafia target.');
      addChatMessage('System', 'No one died tonight! The Doctor made a save.', 'system');
    } else {
      narratorText += `<br><br>No one died during the night.`;
    }

    if (detectiveResult && detectiveResult.detectiveId === myId) {
      narratorText += `<br><br><strong>Investigation Result:</strong> ${detectiveResult.name} is ${detectiveResult.isMafia ? '<span style="color: var(--danger)">MAFIA</span>' : '<span style="color: var(--success)">NOT MAFIA</span>'}`;
    }

    if (!me?.alive) {
      narratorText += `<br><br><em>You are dead. You can observe but not participate.</em>`;
      document.getElementById('chat-input-area').style.display = 'none';
    }

    showDayActions();
  } else if (phase === 'night') {
    document.getElementById('chat-input-area').style.display = 'none';

    if (!me?.alive) {
      narratorText = 'You are dead. Close your eyes and rest...';
    } else {
      if (myRole === 'Mafia' && activeRoles?.mafia) {
        narratorText += '<br><br>Choose someone to eliminate.';
      } else if (myRole === 'Doctor' && activeRoles?.doctor) {
        narratorText += '<br><br>Choose someone to save (can be yourself).';  
      } else if (myRole === 'Detective' && activeRoles?.detective) {
        narratorText += '<br><br>Choose someone to investigate.';
      } else {
        narratorText += '<br><br>Close your eyes and wait...';
      }
    }

    showNightActions(activeRoles);
  }

  document.getElementById('narrator').innerHTML = narratorText;
  renderGamePlayers(players);
});

socket.on('action-confirmed', ({ message }) => {
  showToast(message, 'success');
  hasActed = true;
  document.getElementById('action-panel').innerHTML = '<p style="color: var(--text-muted)">Action submitted. Waiting for others...</p>';
});

socket.on('vote-update', ({ votes }) => {
  renderGamePlayers(players, votes);
});

socket.on('voting-result', ({ eliminated, eliminatedRole, tie, message, votes }) => {
  let resultText = '';
  if (tie) {
    resultText = message;
    addChatMessage('System', 'The vote was tied! No one is eliminated.', 'system');
  } else if (eliminated) {
    resultText = `<strong style="color: var(--danger)">${eliminated}</strong> (${eliminatedRole}) was eliminated by the village!`;
    addChatMessage('System', `${eliminated} (${eliminatedRole}) was voted out! ☠️`, 'death');
    log(`${eliminated} was voted out. They were ${eliminatedRole}.`);
  }

  if (votes) {
    resultText += '<br><br>Vote count:<br>' + votes.map(v => `${v.name}: ${v.count}`).join('<br>');
  }

  document.getElementById('narrator').innerHTML = resultText;
  document.getElementById('action-panel').innerHTML = '<p style="color: var(--text-muted)">Next round starting soon...</p>';
});

socket.on('game-over', ({ winner, eliminated, eliminatedRole, players: finalPlayers }) => {
  showScreen('screen-end');
  document.getElementById('winner-text').textContent = `${winner} Win!`;
  document.getElementById('winner-text').style.color = winner === 'Mafia' ? 'var(--danger)' : 'var(--success)';

  let msg = winner === 'Mafia' 
    ? 'The Mafia has taken over the village.' 
    : 'The village has eliminated all Mafia members.';
  if (eliminated) msg += ` ${eliminated} (${eliminatedRole}) was the final elimination.`;
  document.getElementById('end-message').textContent = msg;

  const container = document.getElementById('final-roles');
  container.innerHTML = finalPlayers.map(p => `
    <div class="role-reveal">
      <div style="font-size: 1.2rem; font-weight: 700;">${p.name}</div>
      <div class="role-name">${p.role}</div>
      <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem;">${p.alive ? 'Survived' : 'Died'}</div>
    </div>
  `).join('');
});

socket.on('new-message', ({ name, text }) => {
  addChatMessage(name, text);
});

socket.on('error', (msg) => {
  showToast(msg, 'error');
});

// UI Functions
function showLobby(code) {
  showScreen('screen-lobby');
  document.getElementById('lobby-code').textContent = code;
}

function renderLobbyPlayers(list) {
  const container = document.getElementById('lobby-players');
  container.innerHTML = list.map(p => `
    <div class="player-card ${p.host ? 'host' : ''}">
      <div class="player-avatar">${p.name[0].toUpperCase()}</div>
      <div style="font-weight: 600;">${p.name}</div>
      ${p.host ? '<div style="font-size: 0.8rem; color: var(--accent); margin-top: 0.25rem;">Host</div>' : ''}
    </div>
  `).join('');
}

function renderGamePlayers(gamePlayers, votes = []) {
  const container = document.getElementById('players-list');
  const voteMap = new Map(votes.map(v => [v.target, true]));
  const me = gamePlayers.find(p => p.id === myId);

  container.innerHTML = gamePlayers.map(p => {
    const isDead = !p.alive;
    const isMe = p.id === myId;
    const canSelect = !isDead && !isMe && me?.alive && !hasActed && currentPhase === 'night' && ['Mafia', 'Doctor', 'Detective'].includes(myRole);
    const canVote = !isDead && !isMe && me?.alive && currentPhase === 'day' && !hasActed;

    return `
      <div class="game-player-card ${isDead ? 'dead' : ''} ${voteMap.has(p.name) ? 'voted' : ''} ${selectedTarget === p.id ? 'selected' : ''}"
           onclick="${canSelect || canVote ? `selectPlayer('${p.id}')` : ''}">
        <div class="status-icon">${isDead ? '💀' : (isMe ? '👤' : '👥')}</div>
        <div style="font-weight: 600; ${isMe ? 'color: var(--accent);' : ''}">${p.name} ${isMe ? '(You)' : ''}</div>
        ${!isDead && canSelect ? '<div style="font-size: 0.75rem; color: var(--primary); margin-top: 0.5rem;">Click to select</div>' : ''}
        ${!isDead && canVote ? '<div style="font-size: 0.75rem; color: var(--warning); margin-top: 0.5rem;">Click to vote</div>' : ''}
      </div>
    `;
  }).join('');
}

function selectPlayer(id) {
  selectedTarget = id;
  renderGamePlayers(players);

  const panel = document.getElementById('action-panel');
  const target = players.find(p => p.id === id);

  if (currentPhase === 'night') {
    let action = '';
    if (myRole === 'Mafia') action = 'kill';
    else if (myRole === 'Doctor') action = 'save';
    else if (myRole === 'Detective') action = 'investigate';

    panel.innerHTML = `
      <p>Selected: <strong>${target.name}</strong></p>
      <button class="action-btn" onclick="submitAction('${action}', '${id}')">Confirm ${action.charAt(0).toUpperCase() + action.slice(1)}</button>
      <button class="action-btn" onclick="cancelSelection()">Cancel</button>
    `;
  } else if (currentPhase === 'day') {
    panel.innerHTML = `
      <p>Voting for: <strong>${target.name}</strong></p>
      <button class="action-btn" onclick="submitVote('${id}')">Confirm Vote</button>
      <button class="action-btn" onclick="cancelSelection()">Cancel</button>
    `;
  }
}

function cancelSelection() {
  selectedTarget = null;
  renderGamePlayers(players);
  if (currentPhase === 'night') showNightActions();
  else showDayActions();
}

function submitAction(action, targetId) {
  socket.emit('night-action', { action, targetId });
}

function submitVote(targetId) {
  socket.emit('vote', { targetId });
  hasActed = true;
  document.getElementById('action-panel').innerHTML = '<p style="color: var(--text-muted)">Vote submitted. Waiting for others...</p>';
}

function showNightActions(activeRoles) {
  const panel = document.getElementById('action-panel');
  const me = players.find(p => p.id === myId);

  if (!me?.alive) {
    panel.innerHTML = '<p style="color: var(--text-muted)">You are dead.</p>';
    return;
  }

  if (myRole === 'Mafia' && activeRoles?.mafia) {
    panel.innerHTML = '<p style="color: var(--danger)">Select a player to eliminate.</p>';
  } else if (myRole === 'Doctor' && activeRoles?.doctor) {
    panel.innerHTML = '<p style="color: var(--success)">Select a player to save.</p>';
  } else if (myRole === 'Detective' && activeRoles?.detective) {
    panel.innerHTML = '<p style="color: var(--secondary)">Select a player to investigate.</p>';
  } else {
    panel.innerHTML = '<p style="color: var(--text-muted)">Close your eyes. Wait for your turn...</p>';
  }
}

function showDayActions() {
  const panel = document.getElementById('action-panel');
  const me = players.find(p => p.id === myId);

  if (!me?.alive) {
    panel.innerHTML = '<p style="color: var(--text-muted)">You are observing as a ghost.</p>';
    return;
  }

  panel.innerHTML = '<p style="color: var(--accent)">Discuss in chat, then click a player to vote for elimination.</p>';
}

function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('send-message', { text });
  input.value = '';
}

function addChatMessage(name, text, type = '') {
  const container = document.getElementById('chat-messages');
  const msg = document.createElement('div');
  msg.className = `message ${type}`;
  msg.innerHTML = `<div class="msg-name">${name}</div><div class="msg-text">${text}</div>`;
  container.appendChild(msg);
  container.scrollTop = container.scrollHeight;
}

function log(text) {
  const container = document.getElementById('log-entries');
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  container.prepend(entry);
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function getRoleColor(role) {
  const colors = {
    'Mafia': 'var(--danger)',
    'Doctor': 'var(--success)',
    'Detective': 'var(--secondary)',
    'Villager': 'var(--accent)'
  };
  return colors[role] || 'var(--text-muted)';
}

// Enter key support
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('player-name')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') createRoom();
  });
  document.getElementById('room-code')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') joinRoom();
  });
  document.getElementById('chat-input')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
  });
});
