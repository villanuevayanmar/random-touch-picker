const SUPABASE_URL = "https://unfippysnnhlftzzjwka.supabase.co";
const SUPABASE_KEY = "sb_publishable_9D9EgSEOqg7DUm5YtsII3w_5IOKVPH3";

const READY_LOCK_MS = 10000;
const READY_CANCEL_AFTER_MS = 5000;
const READY_RETRY_MS = 5000;
const MOVE_BROADCAST_INTERVAL_MS = 100;
const $ = id => document.getElementById(id);

const setup = $("setup");
const lobby = $("lobby");
const game = $("game");
const playArea = $("playArea");
const touchLayer = $("touchLayer");
const playerNameInput = $("playerName");

const clientId = globalThis.crypto?.randomUUID?.() ||
  (Date.now().toString(36) + Math.random().toString(36).slice(2));

let supabaseClient = null;
let supabaseLoading = null;
let channel = null;
let roomCode = "";
let playerName = "Player";
let isHost = false;
let hostClientId = null;
let hostLeftNoticeShown = false;
let connecting = false;
let leaving = false;
let touchNumber = 0;
let selectionTimer = null;
let readyTicker = null;
let roundStartTimer = null;
let scheduledRoundStartAt = 0;
let moveBroadcastTimer = null;
let roundLocked = false;
let roundResetPending = false;
let roundNumber = 0;
let currentWinner = null;
let colorRotationIndex = -1;
let participantSnapshotReady = false;
let knownParticipants = new Map();
let departureNotices = new Map();

const localTouches = new Map();
const pointerToTouch = new Map();
const activeTouches = new Map();
const pendingMoves = new Map();
const readyStates = new Map();

const TOUCH_COLORS = [
  { name: "Cyan", value: "#21d4fd" },
  { name: "Pink", value: "#ff4d9d" },
  { name: "Lime", value: "#a6ed3b" },
  { name: "Orange", value: "#ff9f43" },
  { name: "Violet", value: "#a78bfa" },
  { name: "Blue", value: "#4f83ff" },
  { name: "Red", value: "#ff5d62" },
  { name: "Gold", value: "#f7d154" },
  { name: "Mint", value: "#40dfb0" },
  { name: "Magenta", value: "#e879f9" }
];

function sanitizeName(value) {
  return String(value || "")
    .replace(/[^A-Za-z0-9 _.-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 18);
}

try {
  const savedName = localStorage.getItem("random-touch-picker-name");
  if (savedName && playerNameInput) playerNameInput.value = sanitizeName(savedName);
} catch {
  // Storage may be unavailable in private or embedded browsers.
}

function getPlayerName() {
  playerName = sanitizeName(playerNameInput?.value) || "Player";
  if (playerNameInput) playerNameInput.value = playerName;
  try {
    localStorage.setItem("random-touch-picker-name", playerName);
  } catch {
    // The current session can still use the name without storage.
  }
  return playerName;
}

async function ensureSupabase() {
  if (supabaseClient) return supabaseClient;

  if (!supabaseLoading) {
    supabaseLoading = (async () => {
      const sources = [
        "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm",
        "https://esm.sh/@supabase/supabase-js@2"
      ];
      let lastError = null;

      for (const source of sources) {
        try {
          const sdk = await import(source);
          if (typeof sdk.createClient !== "function") {
            throw new Error("The Supabase module did not export createClient.");
          }
          supabaseClient = sdk.createClient(SUPABASE_URL, SUPABASE_KEY, {
            realtime: { params: { log_level: "info" } }
          });
          console.info("[Touch Picker] Supabase client initialized from", source);
          return supabaseClient;
        } catch (error) {
          lastError = error;
          console.error("[Touch Picker] Supabase module failed:", source, error);
        }
      }

      throw new Error(
        "Could not load Supabase. Check this device's connection or content blocker. " +
        describeRealtimeError(lastError)
      );
    })().catch(error => {
      supabaseLoading = null;
      throw error;
    });
  }

  return supabaseLoading;
}

function showError(message) {
  $("error").textContent = message;
}

function describeRealtimeError(error) {
  if (!error) return "";
  const parts = [];
  if (error.message) parts.push(error.message);
  if (error.cause?.message) parts.push("Cause: " + error.cause.message);
  if (error.code) parts.push("Code: " + error.code);
  if (parts.length) return parts.join(" — ");
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function showRoomNotice(message) {
  const notice = $("roomNotice");
  if (!notice) return;
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(showRoomNotice.timer);
  showRoomNotice.timer = setTimeout(() => {
    notice.hidden = true;
  }, 3500);
}

function notifyDeparture(id, name) {
  if (!id || id === clientId) return;
  const now = Date.now();
  const previous = departureNotices.get(id) || 0;
  if (now - previous < 5000) return;
  departureNotices.set(id, now);
  showRoomNotice((name || "A player") + " left the room.");
}

function clearSelectionTimer() {
  if (selectionTimer !== null) clearTimeout(selectionTimer);
  selectionTimer = null;
}

function clearRoundStartTimer() {
  if (roundStartTimer !== null) clearTimeout(roundStartTimer);
  roundStartTimer = null;
  scheduledRoundStartAt = 0;
}

function clearReadyTicker() {
  if (readyTicker !== null) clearInterval(readyTicker);
  readyTicker = null;
}

function clearMoveBroadcast() {
  if (moveBroadcastTimer !== null) clearTimeout(moveBroadcastTimer);
  moveBroadcastTimer = null;
  pendingMoves.clear();
}

function point(event) {
  const rect = playArea.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
    y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
  };
}

function markerFor(touch) {
  let marker = touchLayer.querySelector('[data-id="' + CSS.escape(touch.id) + '"]');
  if (!marker) {
    marker = document.createElement("div");
    marker.className = "touch-marker";
    marker.dataset.id = touch.id;
    touchLayer.appendChild(marker);
  }
  marker.style.setProperty("--touch-color", touch.color || "#888888");
  marker.style.left = (touch.x * playArea.clientWidth) + "px";
  marker.style.top = (touch.y * playArea.clientHeight) + "px";
  return marker;
}

function drawAllTouches() {
  touchLayer.replaceChildren();
  for (const touch of activeTouches.values()) markerFor(touch);
  if (currentWinner) {
    const winnerMarker = touchLayer.querySelector('[data-id="' + CSS.escape(currentWinner.id) + '"]');
    winnerMarker?.classList.add("winner");
    for (const marker of touchLayer.querySelectorAll(".touch-marker")) {
      if (marker.dataset.id !== currentWinner.id) marker.classList.add("faded");
    }
  }
}

function chooseTouchColor() {
  const counts = new Map(TOUCH_COLORS.map(color => [color.value, 0]));
  for (const touch of activeTouches.values()) {
    if (touch.color && counts.has(touch.color)) {
      counts.set(touch.color, counts.get(touch.color) + 1);
    }
  }

  const unused = TOUCH_COLORS.find(color => counts.get(color.value) === 0);
  if (unused) {
    colorRotationIndex = TOUCH_COLORS.indexOf(unused);
    return unused;
  }

  const leastUsed = Math.min(...counts.values());
  for (let offset = 1; offset <= TOUCH_COLORS.length; offset++) {
    const index = (colorRotationIndex + offset + TOUCH_COLORS.length) % TOUCH_COLORS.length;
    const color = TOUCH_COLORS[index];
    if (counts.get(color.value) === leastUsed) {
      colorRotationIndex = index;
      return color;
    }
  }
  return TOUCH_COLORS[0];
}

function assignTouchColor(touch) {
  const color = chooseTouchColor();
  const coloredTouch = {
    ...touch,
    color: color.value,
    colorName: color.name,
    clientId: touch.clientId || clientId,
    playerName: touch.playerName || playerName
  };
  activeTouches.set(coloredTouch.id, coloredTouch);

  for (const localTouch of localTouches.values()) {
    if (localTouch.id === coloredTouch.id) {
      localTouch.color = coloredTouch.color;
      localTouch.colorName = coloredTouch.colorName;
    }
  }
  markerFor(coloredTouch);
  return coloredTouch;
}

function getPresenceRecords() {
  if (!channel) return [];
  const unique = new Map();
  for (const presence of Object.values(channel.presenceState()).flat()) {
    if (presence?.clientId && !unique.has(presence.clientId)) {
      unique.set(presence.clientId, presence);
    }
  }
  return Array.from(unique.values());
}

// Presence is tracked once on join. Touches, readiness, and movement use Broadcast.
async function trackRoomPresence() {
  if (!channel) return;
  const status = await channel.track({
    clientId,
    displayName: playerName,
    role: isHost ? "host" : "player",
    joinedAt: Date.now()
  });
  if (status !== "ok") {
    throw new Error("Could not register room presence: " + status);
  }
}

async function sendTouch(type, touch) {
  if (!channel) return false;
  try {
    const status = await channel.send({
      type: "broadcast",
      event: "touch",
      payload: { type, clientId, roundNumber, touch }
    });
    if (status !== "ok") console.error("Touch broadcast failed:", status);
    return status === "ok";
  } catch (error) {
    console.error("Touch broadcast failed:", error);
    return false;
  }
}

async function sendRound(type, data = {}) {
  if (!channel) return false;
  try {
    const status = await channel.send({
      type: "broadcast",
      event: "round",
      payload: { type, clientId, ...data }
    });
    if (status !== "ok") console.error("Room broadcast failed:", type, status);
    return status === "ok";
  } catch (error) {
    console.error("Room broadcast failed:", type, error);
    return false;
  }
}

function sendRoomState(targetClientId = null) {
  if (!isHost || !channel) return;
  const now = Date.now();
  const readiness = Array.from(readyStates.entries()).map(([id, state]) => ({
    clientId: id,
    ready: state.ready === true,
    readyAge: state.ready && state.readyAt ? Math.max(0, now - state.readyAt) : 0,
    retryRemaining: state.retryAt ? Math.max(0, state.retryAt - now) : 0
  }));

  void sendRound("room-state", {
    targetClientId,
    roundNumber,
    roundLocked,
    winner: currentWinner,
    touches: Array.from(activeTouches.values()),
    readiness
  });
}

function renderDeviceReadiness(records = getPresenceRecords()) {
  const list = $("deviceList");
  const summary = $("readySummary");
  const button = $("readyButton");
  if (!list || !summary || !button) return;

  const devices = [...records].sort((a, b) =>
    String(a.displayName || "Player").localeCompare(String(b.displayName || "Player")) ||
    String(a.clientId).localeCompare(String(b.clientId))
  );
  const now = Date.now();
  const readyCount = devices.filter(device =>
    readyStates.get(device.clientId)?.ready === true
  ).length;
  const allReady = devices.length > 0 && readyCount === devices.length;

  if (allReady) {
    const latestLockAt = Math.max(...devices.map(device => {
      const state = readyStates.get(device.clientId);
      return state.readyAt + READY_LOCK_MS;
    }));
    summary.textContent = "Everyone ready · " +
      Math.max(0, Math.ceil((latestLockAt - now) / 1000)) + "s";
  } else {
    summary.textContent = readyCount + " of " + devices.length + " ready";
  }

  list.replaceChildren();
  devices.forEach(device => {
    const row = document.createElement("div");
    row.className = "device-row";

    const label = document.createElement("span");
    const name = device.displayName || "Player";
    label.textContent = name + (device.clientId === clientId ? " (you)" : "");

    const status = document.createElement("strong");
    const state = readyStates.get(device.clientId) || { ready: false, readyAt: 0, retryAt: 0 };
    let statusText = "WAITING";
    let statusClass = "device-waiting";
    if (state.ready) {
      const elapsed = now - state.readyAt;
      statusClass = "device-ready";
      if (elapsed < READY_CANCEL_AFTER_MS) {
        statusText = "READY · " + Math.ceil((READY_CANCEL_AFTER_MS - elapsed) / 1000) + "s";
      } else if (elapsed < READY_LOCK_MS) {
        statusText = "READY · CANCEL";
      } else {
        statusText = "READY · LOCKED";
      }
    } else if (state.retryAt > now) {
      statusText = "RETRY IN " + Math.ceil((state.retryAt - now) / 1000) + "s";
    }

    status.textContent = statusText;
    status.className = statusClass;
    row.append(label, status);
    list.appendChild(row);
  });

  const mine = readyStates.get(clientId) || { ready: false, readyAt: 0, retryAt: 0 };
  const elapsed = mine.ready ? now - mine.readyAt : 0;
  if (roundResetPending) {
    button.disabled = true;
    button.textContent = "STARTING…";
  } else if (!roundLocked) {
    button.disabled = true;
    button.textContent = "I'M READY";
  } else if (mine.ready && elapsed < READY_CANCEL_AFTER_MS) {
    button.disabled = true;
    button.textContent = "CANCEL READY IN " +
      Math.ceil((READY_CANCEL_AFTER_MS - elapsed) / 1000) + "s";
  } else if (mine.ready && elapsed < READY_LOCK_MS) {
    button.disabled = false;
    button.textContent = "CANCEL READY";
  } else if (mine.ready) {
    button.disabled = true;
    button.textContent = "READY LOCKED ✓";
  } else if (mine.retryAt > now) {
    button.disabled = true;
    button.textContent = "READY AGAIN IN " +
      Math.ceil((mine.retryAt - now) / 1000) + "s";
  } else {
    button.disabled = false;
    button.textContent = "I'M READY";
  }

  const hint = $("readyHint");
  if (mine.ready && elapsed < READY_CANCEL_AFTER_MS) {
    hint.textContent = "Ready locks in 10 seconds. Cancel becomes available after 5 seconds.";
  } else if (mine.ready && elapsed < READY_LOCK_MS) {
    hint.textContent = "You can cancel now. Ready locks in " +
      Math.ceil((READY_LOCK_MS - elapsed) / 1000) + " seconds.";
  } else if (mine.ready) {
    hint.textContent = "Your Ready is locked. The next round starts when everyone is locked in.";
  } else if (mine.retryAt > now) {
    hint.textContent = "You can press Ready again in " +
      Math.ceil((mine.retryAt - now) / 1000) + " seconds.";
  } else {
    hint.textContent = "The next round starts after everyone has been Ready for 10 seconds.";
  }
}

function startReadyTicker() {
  if (readyTicker !== null) return;
  readyTicker = setInterval(() => {
    renderDeviceReadiness();
    if (isHost) startNextRoundIfReady();
  }, 250);
}

function startNextRoundIfReady(records = getPresenceRecords()) {
  if (!isHost || !roundLocked || roundResetPending) return;
  const participants = records.filter(record => record.clientId);
  if (!participants.length) {
    clearRoundStartTimer();
    return;
  }

  const states = participants.map(record => readyStates.get(record.clientId));
  if (states.some(state => !state || state.ready !== true || !state.readyAt)) {
    clearRoundStartTimer();
    renderDeviceReadiness(records);
    return;
  }

  const startAt = Math.max(...states.map(state => state.readyAt + READY_LOCK_MS));
  if (startAt > Date.now()) {
    if (roundStartTimer !== null && scheduledRoundStartAt === startAt) return;
    clearRoundStartTimer();
    scheduledRoundStartAt = startAt;
    roundStartTimer = setTimeout(() => {
      roundStartTimer = null;
      scheduledRoundStartAt = 0;
      startNextRoundIfReady();
    }, Math.max(0, startAt - Date.now()) + 30);
    return;
  }

  clearRoundStartTimer();
  roundResetPending = true;
  renderDeviceReadiness(records);
  const nextRoundNumber = roundNumber + 1;
  void sendRound("reset", { roundNumber: nextRoundNumber }).then(sent => {
    if (sent && roundNumber < nextRoundNumber) {
      resetRound(nextRoundNumber);
    } else if (!sent) {
      roundResetPending = false;
      $("readyHint").textContent = "Could not start the next round. Check the connection and try again.";
      renderDeviceReadiness();
    }
  });
}

function applyReadyEvent(payload) {
  if (!payload || Number(payload.roundNumber) !== roundNumber || !roundLocked) return;
  const id = payload.clientId;
  if (!id || !getPresenceRecords().some(record => record.clientId === id)) return;

  if (payload.type === "ready") {
    readyStates.set(id, { ready: true, readyAt: Date.now(), retryAt: 0 });
  } else if (payload.type === "cancel-ready") {
    readyStates.set(id, {
      ready: false,
      readyAt: 0,
      retryAt: Date.now() + READY_RETRY_MS
    });
  }

  renderDeviceReadiness();
  if (isHost) startNextRoundIfReady();
}

function resetRound(nextRoundNumber = roundNumber + 1) {
  if (!Number.isSafeInteger(nextRoundNumber) || nextRoundNumber <= roundNumber) return;
  clearSelectionTimer();
  clearRoundStartTimer();
  clearReadyTicker();
  clearMoveBroadcast();
  activeTouches.clear();
  localTouches.clear();
  pointerToTouch.clear();
  touchLayer.replaceChildren();
  roundNumber = nextRoundNumber;
  roundLocked = false;
  currentWinner = null;
  roundResetPending = false;
  colorRotationIndex = -1;
  readyStates.clear();
  for (const record of getPresenceRecords()) {
    readyStates.set(record.clientId, { ready: false, readyAt: 0, retryAt: 0 });
  }
  readyStates.set(clientId, { ready: false, readyAt: 0, retryAt: 0 });
  $("roundResult").hidden = true;
  $("readyHint").textContent = "The next round starts when everyone is ready.";
  renderDeviceReadiness();
}

function scheduleSelection() {
  if (!isHost || roundLocked) return;
  clearSelectionTimer();
  selectionTimer = setTimeout(async () => {
    selectionTimer = null;
    await flushTouchMoves();
    const candidates = Array.from(activeTouches.values());
    if (!candidates.length || roundLocked) return;
    const winner = candidates[Math.floor(Math.random() * candidates.length)];
    const sent = await sendRound("winner", { winner, roundNumber });
    if (!sent) {
      console.error("Winner was selected locally but could not be broadcast.");
      showRoomNotice("Connection issue: the result may not reach everyone.");
    }
    showWinner(winner);
  }, 5000);
}

function showWinner(winner) {
  if (!winner) return;
  const selected = typeof winner === "string" ? activeTouches.get(winner) : winner;
  if (!selected?.id) return;

  if (roundLocked && currentWinner?.id === selected.id) {
    renderDeviceReadiness();
    return;
  }

  clearSelectionTimer();
  clearRoundStartTimer();
  currentWinner = {
    ...selected,
    clientId: selected.clientId || clientId,
    playerName: selected.playerName || playerName,
    colorName: selected.colorName || "Unknown"
  };
  roundLocked = true;
  roundResetPending = false;
  readyStates.clear();
  for (const record of getPresenceRecords()) {
    readyStates.set(record.clientId, { ready: false, readyAt: 0, retryAt: 0 });
  }
  readyStates.set(clientId, { ready: false, readyAt: 0, retryAt: 0 });

  activeTouches.set(currentWinner.id, currentWinner);
  for (const touch of activeTouches.values()) {
    const marker = markerFor(touch);
    marker.classList.toggle("winner", touch.id === currentWinner.id);
    marker.classList.toggle("faded", touch.id !== currentWinner.id);
  }

  const colorName = currentWinner.colorName;
  const winnerName = currentWinner.playerName || "Player";
  const localWinner = currentWinner.clientId === clientId;

  $("resultTitle").textContent = localWinner ? "YOU'RE CHOSEN!" : "NOT CHOSEN";
  $("resultMessage").textContent = localWinner
    ? "Your " + colorName + " touch was selected."
    : winnerName + " was chosen.";
  $("winnerColorLabel").textContent = colorName.toUpperCase();
  $("winnerPlayerLabel").textContent = winnerName;
  $("winnerSwatch").style.backgroundColor = currentWinner.color || "#ffffff";
  $("roundResult").hidden = false;

  startReadyTicker();
  renderDeviceReadiness();
}

function applyTouchEvent(payload) {
  if (!payload || payload.clientId === clientId || !payload.touch) return;
  if (Number(payload.roundNumber) !== roundNumber) return;
  const touch = payload.touch;
  const ownerId = touch.clientId || payload.clientId;

  if (payload.type === "start") {
    if (roundLocked) return;
    const incoming = {
      ...touch,
      clientId: ownerId,
      playerName: touch.playerName || knownParticipants.get(ownerId)?.displayName || "Player"
    };

    if (isHost) {
      incoming.color = null;
      incoming.colorName = null;
      activeTouches.set(incoming.id, incoming);
      markerFor(incoming);
      scheduleSelection();
      const colored = assignTouchColor(incoming);
      void sendTouch("color", colored);
    } else {
      if (!incoming.color) {
        const color = chooseTouchColor();
        incoming.color = color.value;
        incoming.colorName = color.name;
      }
      activeTouches.set(incoming.id, incoming);
      markerFor(incoming);
    }
  } else if (payload.type === "color") {
    const existing = activeTouches.get(touch.id);
    const colored = {
      ...existing,
      ...touch,
      clientId: ownerId,
      playerName: touch.playerName || existing?.playerName || "Player"
    };
    activeTouches.set(colored.id, colored);
    for (const localTouch of localTouches.values()) {
      if (localTouch.id === colored.id) {
        localTouch.color = colored.color;
        localTouch.colorName = colored.colorName;
      }
    }
    markerFor(colored);
  } else if (payload.type === "end") {
    if (roundLocked) return;
    activeTouches.delete(touch.id);
    touchLayer.querySelector('[data-id="' + CSS.escape(touch.id) + '"]')?.remove();
    if (isHost && activeTouches.size === 0) clearSelectionTimer();
  }
}

function applyMoveBatch(payload) {
  if (!payload || payload.clientId === clientId || Number(payload.roundNumber) !== roundNumber) return;
  if (roundLocked || !Array.isArray(payload.moves)) return;
  for (const move of payload.moves) {
    const touch = activeTouches.get(move.id);
    if (!touch) continue;
    touch.x = move.x;
    touch.y = move.y;
    markerFor(touch);
  }
}

function queueTouchMove(touch) {
  pendingMoves.set(touch.id, { id: touch.id, x: touch.x, y: touch.y });
  if (moveBroadcastTimer === null) {
    moveBroadcastTimer = setTimeout(() => {
      moveBroadcastTimer = null;
      void flushTouchMoves();
    }, MOVE_BROADCAST_INTERVAL_MS);
  }
}

async function flushTouchMoves() {
  if (moveBroadcastTimer !== null) clearTimeout(moveBroadcastTimer);
  moveBroadcastTimer = null;
  if (!pendingMoves.size) return true;
  const moves = Array.from(pendingMoves.values());
  pendingMoves.clear();
  return sendRound("moves", { roundNumber, moves });
}

function syncPresence() {
  if (!channel) return;
  const records = getPresenceRecords();
  const current = new Map(records.map(record => [record.clientId, record]));
  const added = [];

  if (participantSnapshotReady) {
    for (const [id, previous] of knownParticipants) {
      if (!current.has(id)) notifyDeparture(id, previous.displayName);
    }
  }

  for (const [id, record] of current) {
    if (!knownParticipants.has(id) && id !== clientId) added.push(record);
    if (!readyStates.has(id)) readyStates.set(id, { ready: false, readyAt: 0, retryAt: 0 });
  }
  for (const id of readyStates.keys()) {
    if (!current.has(id) && id !== clientId) readyStates.delete(id);
  }

  knownParticipants = current;
  participantSnapshotReady = true;

  const host = records.find(record => record.role === "host");
  if (host) hostClientId = host.clientId;
  else if (!isHost && hostClientId && !current.has(hostClientId) && !hostLeftNoticeShown) {
    hostLeftNoticeShown = true;
    showRoomNotice("The room host left. This room cannot select another winner.");
  }

  renderDeviceReadiness(records);
  if (isHost && added.length) sendRoomState();
  if (isHost) startNextRoundIfReady(records);
}

function applyRoomState(payload) {
  if (!payload || (payload.targetClientId && payload.targetClientId !== clientId)) return;
  if (hostClientId && payload.clientId !== hostClientId) return;
  const incomingRound = Number(payload.roundNumber);
  if (!Number.isSafeInteger(incomingRound) || incomingRound < roundNumber) return;

  if (incomingRound > roundNumber) resetRound(incomingRound);

  if (payload.roundLocked && payload.winner) {
    activeTouches.clear();
    for (const touch of (payload.touches || [])) {
      if (touch?.id) activeTouches.set(touch.id, touch);
    }
    showWinner(payload.winner);
    activeTouches.clear();
    for (const touch of (payload.touches || [])) {
      if (touch?.id) activeTouches.set(touch.id, touch);
    }
    drawAllTouches();
  } else if (!roundLocked) {
    activeTouches.clear();
    for (const touch of (payload.touches || [])) {
      if (touch?.id) activeTouches.set(touch.id, touch);
    }
    drawAllTouches();
  }

  if (Array.isArray(payload.readiness)) {
    for (const item of payload.readiness) {
      if (!item?.clientId) continue;
      readyStates.set(item.clientId, {
        ready: item.ready === true,
        readyAt: item.ready ? Date.now() - Math.max(0, Number(item.readyAge) || 0) : 0,
        retryAt: item.retryRemaining ? Date.now() + Math.max(0, Number(item.retryRemaining)) : 0
      });
    }
  }
  renderDeviceReadiness();
  if (isHost) startNextRoundIfReady();
}

function receiveRound(payload) {
  if (!payload) return;

  if (payload.type === "state-request") {
    if (isHost) sendRoomState(payload.clientId);
    return;
  }
  if (payload.type === "room-state") {
    applyRoomState(payload);
    return;
  }
  if (payload.type === "leave") {
    notifyDeparture(payload.clientId, payload.displayName);
    return;
  }
  if (payload.clientId === clientId) return;

  if (payload.type === "winner" && Number(payload.roundNumber) === roundNumber) {
    showWinner(payload.winner);
  } else if (payload.type === "reset") {
    const nextRoundNumber = Number(payload.roundNumber);
    if (Number.isSafeInteger(nextRoundNumber) && nextRoundNumber > roundNumber) {
      resetRound(nextRoundNumber);
    }
  } else if (payload.type === "moves") {
    applyMoveBatch(payload);
  } else if (payload.type === "ready" || payload.type === "cancel-ready") {
    applyReadyEvent(payload);
  }
}

function enterGame() {
  lobby.hidden = true;
  setup.hidden = true;
  game.hidden = false;
}

function hasHost() {
  return getPresenceRecords().some(presence => presence.role === "host");
}

async function waitForHost(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasHost()) return true;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  return hasHost();
}

async function connect(code, host) {
  showError("Loading Supabase Realtime client…");
  await ensureSupabase();
  roomCode = code;
  playerName = getPlayerName();
  isHost = host;
  hostClientId = host ? clientId : null;
  hostLeftNoticeShown = false;
  roundNumber = 0;
  roundLocked = false;
  currentWinner = null;
  readyStates.clear();
  knownParticipants.clear();
  participantSnapshotReady = false;
  departureNotices.clear();

  channel = supabaseClient.channel("touch-picker-" + roomCode, {
    config: {
      broadcast: { self: false, ack: true },
      presence: { key: clientId }
    }
  });

  channel
    .on("broadcast", { event: "touch" }, ({ payload }) => applyTouchEvent(payload))
    .on("broadcast", { event: "round" }, ({ payload }) => receiveRound(payload))
    .on("presence", { event: "sync" }, syncPresence);

  try {
    showError("Connecting to Supabase Realtime…");
    await new Promise((resolve, reject) => {
      let settled = false;
      let lastStatus = "waiting";
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Realtime connection timed out after 12 seconds (last status: " + lastStatus + ")."));
      }, 12000);

      channel.subscribe((status, subscriptionError) => {
        lastStatus = status;
        console.info("[Touch Picker] Realtime status:", status, subscriptionError || "");
        if (status === "SUBSCRIBED" && !settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if (
          (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") &&
          !settled
        ) {
          settled = true;
          clearTimeout(timeout);
          const detail = describeRealtimeError(subscriptionError);
          reject(new Error(
            "Realtime connection failed (" + status + "). " +
            (detail || "Check the network connection and Supabase Realtime service.")
          ));
        }
      });
    });

    showError("Registering this device in the room…");
    await trackRoomPresence();
    readyStates.set(clientId, { ready: false, readyAt: 0, retryAt: 0 });

    if (host) {
      $("roomCode").textContent = roomCode;
      setup.hidden = true;
      lobby.hidden = false;
      return;
    }

    showError("Checking the room code…");
    if (!await waitForHost()) {
      throw new Error("Room not found. Check the code and try again.");
    }
    const hostRecord = getPresenceRecords().find(record => record.role === "host");
    hostClientId = hostRecord?.clientId || null;

    enterGame();
    void sendRound("state-request", {});
  } catch (error) {
    const failedChannel = channel;
    channel = null;
    roomCode = "";
    isHost = false;
    hostClientId = null;
    if (failedChannel && supabaseClient) {
      try {
        await supabaseClient.removeChannel(failedChannel);
      } catch (cleanupError) {
        console.error("Failed to clean up unsuccessful room channel:", cleanupError);
      }
    }
    throw error;
  }
}

async function runConnection(action, busyLabel) {
  if (connecting) return;
  connecting = true;
  const createButton = $("createRoom");
  const joinButton = $("joinRoom");
  const createLabel = createButton.textContent;
  const joinLabel = joinButton.textContent;
  createButton.disabled = true;
  joinButton.disabled = true;
  createButton.textContent = busyLabel === "create" ? "Creating..." : createLabel;
  joinButton.textContent = busyLabel === "join" ? "Joining..." : joinLabel;

  try {
    showError(busyLabel === "create"
      ? "Creating room and connecting to Realtime…"
      : "Joining room and connecting to Realtime…");
    await action();
    showError("");
  } catch (error) {
    console.error("Room connection failed:", error);
    showError(error.message || describeRealtimeError(error) || "Could not connect to the room.");
  } finally {
    connecting = false;
    createButton.disabled = false;
    joinButton.disabled = false;
    createButton.textContent = createLabel;
    joinButton.textContent = joinLabel;
  }
}

async function leaveRoom() {
  if (leaving) return;
  leaving = true;
  const oldCode = roomCode;
  const oldChannel = channel;

  try {
    if (oldChannel) {
      await sendRound("leave", { displayName: playerName });
      channel = null;
      await supabaseClient.removeChannel(oldChannel);
    }
  } catch (error) {
    console.error("Error while leaving room:", error);
  }

  clearSelectionTimer();
  clearRoundStartTimer();
  clearReadyTicker();
  clearMoveBroadcast();
  activeTouches.clear();
  localTouches.clear();
  pointerToTouch.clear();
  readyStates.clear();
  touchLayer.replaceChildren();
  roomCode = "";
  isHost = false;
  hostClientId = null;
  roundNumber = 0;
  roundLocked = false;
  currentWinner = null;
  knownParticipants.clear();
  participantSnapshotReady = false;

  game.hidden = true;
  lobby.hidden = true;
  setup.hidden = false;
  showError(oldCode ? "You left room " + oldCode + "." : "");
  leaving = false;
}

$("createRoom").addEventListener("click", () => {
  void runConnection(() => connect(randomCode(), true), "create");
});

$("joinRoom").addEventListener("click", async () => {
  const code = $("roomInput").value.trim().toUpperCase();
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) {
    showError("Enter a valid 6-character room code.");
    return;
  }
  await runConnection(() => connect(code, false), "join");
});

$("roomInput").addEventListener("input", () => {
  $("roomInput").value = $("roomInput").value.toUpperCase()
    .replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0, 6);
});

playerNameInput?.addEventListener("input", () => {
  playerNameInput.value = sanitizeName(playerNameInput.value);
});

$("copyCode").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(roomCode);
    $("copyCode").textContent = "Copied";
    setTimeout(() => { $("copyCode").textContent = "Copy code"; }, 1000);
  } catch {
    $("lobbyError").textContent = "Room code: " + roomCode;
  }
});

$("enterGame").addEventListener("click", enterGame);
$("readyButton").addEventListener("click", () => {
  if (!roundLocked || roundResetPending) return;
  const now = Date.now();
  const mine = readyStates.get(clientId) || { ready: false, readyAt: 0, retryAt: 0 };

  if (mine.ready) {
    const elapsed = now - mine.readyAt;
    if (elapsed < READY_CANCEL_AFTER_MS || elapsed >= READY_LOCK_MS) return;
    const previousReadyState = { ...mine };
    readyStates.set(clientId, {
      ready: false,
      readyAt: 0,
      retryAt: now + READY_RETRY_MS
    });
    clearRoundStartTimer();
    renderDeviceReadiness();
    void sendRound("cancel-ready", { roundNumber }).then(sent => {
      if (!sent) {
        readyStates.set(clientId, previousReadyState);
        renderDeviceReadiness();
        showRoomNotice("Cancel could not sync. Your Ready status was restored.");
        if (isHost) startNextRoundIfReady();
      }
    });
    return;
  }

  if (mine.retryAt > now) return;
  readyStates.set(clientId, { ready: true, readyAt: now, retryAt: 0 });
  renderDeviceReadiness();
  void sendRound("ready", { roundNumber }).then(sent => {
    if (!sent && readyStates.get(clientId)?.ready) {
      readyStates.set(clientId, { ready: false, readyAt: 0, retryAt: 0 });
      renderDeviceReadiness();
      showRoomNotice("Ready could not sync. Please try again.");
    } else if (isHost) {
      startNextRoundIfReady();
    }
  });
});

$("leaveRoom").addEventListener("click", () => {
  if (window.confirm("Leave this room?")) void leaveRoom();
});
$("leaveLobby").addEventListener("click", () => {
  if (window.confirm("Leave this room?")) void leaveRoom();
});

playArea.addEventListener("pointerdown", async event => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  event.preventDefault();
  try {
    playArea.setPointerCapture(event.pointerId);
  } catch {
    // Pointer capture can fail in some embedded browsers.
  }
  if (roundLocked) return;

  const p = point(event);
  const color = chooseTouchColor();
  const id = clientId + ":" + event.pointerId + ":" + (++touchNumber);
  const touch = {
    id,
    clientId,
    playerName,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    x: p.x,
    y: p.y,
    color: color.value,
    colorName: color.name
  };

  localTouches.set(event.pointerId, touch);
  pointerToTouch.set(event.pointerId, id);
  activeTouches.set(id, touch);
  markerFor(touch);
  if (isHost) scheduleSelection();
  await sendTouch("start", touch);
});

playArea.addEventListener("pointermove", event => {
  const id = pointerToTouch.get(event.pointerId);
  if (!id || roundLocked) return;
  event.preventDefault();

  const touch = localTouches.get(event.pointerId);
  if (!touch) return;
  const p = point(event);
  touch.x = p.x;
  touch.y = p.y;
  activeTouches.set(id, touch);
  markerFor(touch);
  queueTouchMove(touch);
});

async function finishTouch(event) {
  const id = pointerToTouch.get(event.pointerId);
  if (!id) return;

  pointerToTouch.delete(event.pointerId);
  localTouches.delete(event.pointerId);
  if (roundLocked) return;

  activeTouches.delete(id);
  touchLayer.querySelector('[data-id="' + CSS.escape(id) + '"]')?.remove();
  await flushTouchMoves();
  await sendTouch("end", { id });
  if (isHost && activeTouches.size === 0) clearSelectionTimer();
}

playArea.addEventListener("pointerup", finishTouch);
playArea.addEventListener("pointercancel", finishTouch);

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () =>
    chars[Math.floor(Math.random() * chars.length)]
  ).join("");
}

window.addEventListener("pagehide", () => {
  clearSelectionTimer();
  clearRoundStartTimer();
  clearReadyTicker();
  clearMoveBroadcast();
  if (channel && supabaseClient) {
    void supabaseClient.removeChannel(channel);
  }
});