const SUPABASE_URL = "https://unfippysnnhlftzzjwka.supabase.co";
const SUPABASE_KEY = "sb_publishable_9D9EgSEOqg7DUm5YtsII3w_5IOKVPH3";

const $ = (id) => document.getElementById(id);
const setup = $("setup");
const lobby = $("lobby");
const game = $("game");
const playArea = $("playArea");
const touchLayer = $("touchLayer");

const clientId = globalThis.crypto?.randomUUID?.() ||
  (Date.now().toString(36) + Math.random().toString(36).slice(2));
let supabase = null;
let supabaseLoading = null;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      script.remove();
      reject(new Error("Could not load " + url));
    };
    document.head.appendChild(script);
  });
}

async function ensureSupabase() {
  if (supabase) return supabase;

  if (!supabaseLoading) {
    supabaseLoading = (async () => {
      const sources = [
        "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
        "https://unpkg.com/@supabase/supabase-js@2"
      ];
      let lastError = null;

      for (const source of sources) {
        try {
          if (!window.supabase?.createClient) {
            await loadScript(source);
          }
          if (!window.supabase?.createClient) {
            throw new Error("The CDN loaded but did not expose supabase.createClient.");
          }
          supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
            realtime: { params: { log_level: "info" } }
          });
          console.info("[Touch Picker] Supabase client initialized.");
          return supabase;
        } catch (error) {
          lastError = error;
          console.error("[Touch Picker] Supabase SDK source failed:", source, error);
        }
      }

      throw new Error(
        "Could not load the Supabase client from either CDN. " +
        describeRealtimeError(lastError)
      );
    })().catch(error => {
      supabaseLoading = null;
      throw error;
    });
  }

  return supabaseLoading;
}

let channel = null;
let roomCode = "";
let isHost = false;
let touchNumber = 0;
let selectionTimer = null;
let roundLocked = false;
let lastMoveSent = 0;
let presenceQueue = Promise.resolve();

const localTouches = new Map();
const pointerToTouch = new Map();
const activeTouches = new Map();

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({length: 6}, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function touchColor(id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return "hsl(" + ((hash >>> 0) % 360) + " 100% 65%)";
}

function showError(message) { $("error").textContent = message; }

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

function clearTimer() {
  if (selectionTimer !== null) clearTimeout(selectionTimer);
  selectionTimer = null;
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
    marker.style.setProperty("--touch-color", touch.color);
    touchLayer.appendChild(marker);
  }
  marker.style.left = (touch.x * playArea.clientWidth) + "px";
  marker.style.top = (touch.y * playArea.clientHeight) + "px";
  return marker;
}

function drawAllTouches() {
  touchLayer.replaceChildren();
  for (const touch of activeTouches.values()) markerFor(touch);
}

// Serialize Presence writes so rapid multi-touch events cannot overwrite a newer snapshot.
function updatePresence() {
  if (!channel) return Promise.resolve();
  const target = channel;
  presenceQueue = presenceQueue.catch(() => {}).then(async () => {
    if (channel !== target) return;
    const touches = Array.from(localTouches.values()).map(t => ({
      id: t.id, x: t.x, y: t.y, color: t.color
    }));
    const status = await target.track({
      clientId,
      role: isHost ? "host" : "player",
      touches
    });
    if (status !== "ok") {
      const error = new Error("Supabase Presence registration returned: " + status);
      error.code = "PRESENCE_TRACK_" + String(status).toUpperCase().replace(/[^A-Z]+/g, "_");
      console.error("Presence update failed:", error);
      throw error;
    }
  });
  return presenceQueue;
}

function refreshPresence() {
  void updatePresence().catch(error => {
    console.error("Could not update room presence:", error);
  });
}

async function sendTouch(type, touch) {
  if (!channel) return;
  const status = await channel.send({
    type: "broadcast",
    event: "touch",
    payload: { type, clientId, touch }
  });
  if (status !== "ok") {
    console.error("Touch broadcast failed:", status);
  }
}

async function sendRound(type, data = {}) {
  if (!channel) return;
  const status = await channel.send({
    type: "broadcast",
    event: "round",
    payload: { type, clientId, ...data }
  });
  if (status !== "ok") {
    console.error("Round broadcast failed:", status);
  }
}

function resetRound() {
  clearTimer();
  activeTouches.clear();
  localTouches.clear();
  pointerToTouch.clear();
  touchLayer.replaceChildren();
  roundLocked = false;
  refreshPresence();
}

function beginNewRoundIfNeeded() {
  if (roundLocked) resetRound();
}

function scheduleSelection() {
  if (!isHost || roundLocked) return;
  clearTimer();
  selectionTimer = setTimeout(() => {
    selectionTimer = null;
    const candidates = Array.from(activeTouches.values());
    if (!candidates.length || roundLocked) return;
    const winner = candidates[Math.floor(Math.random() * candidates.length)];
    roundLocked = true;
    void sendRound("winner", { touchId: winner.id });
    showWinner(winner.id);
  }, 5000);
}

function showWinner(winnerId) {
  roundLocked = true;
  clearTimer();
  for (const touch of activeTouches.values()) {
    const marker = touchLayer.querySelector('[data-id="' + CSS.escape(touch.id) + '"]');
    if (!marker) continue;
    marker.classList.toggle("winner", touch.id === winnerId);
    marker.classList.toggle("faded", touch.id !== winnerId);
  }
}

function applyTouchEvent(payload) {
  if (!payload || payload.clientId === clientId || !payload.touch) return;
  const touch = payload.touch;

  if (payload.type === "start") {
    beginNewRoundIfNeeded();
    activeTouches.set(touch.id, touch);
    markerFor(touch);
    if (isHost) scheduleSelection();
  } else if (payload.type === "move") {
    const current = activeTouches.get(touch.id);
    if (!current || roundLocked) return;
    current.x = touch.x;
    current.y = touch.y;
    markerFor(current);
  } else if (payload.type === "end") {
    // After selection, keep the chosen marker visible even if a release event
    // arrives late from another device.
    if (roundLocked) return;
    activeTouches.delete(touch.id);
    touchLayer.querySelector('[data-id="' + CSS.escape(touch.id) + '"]')?.remove();
    if (isHost && activeTouches.size === 0) clearTimer();
  }
}

function syncPresence() {
  if (roundLocked || !channel) return;
  const state = channel.presenceState();
  const next = new Map();

  for (const presences of Object.values(state)) {
    for (const presence of presences) {
      for (const touch of (presence.touches || [])) {
        next.set(touch.id, {
          id: touch.id,
          clientId: presence.clientId,
          x: touch.x,
          y: touch.y,
          color: touch.color
        });
      }
    }
  }

  activeTouches.clear();
  for (const [id, touch] of next) activeTouches.set(id, touch);
  drawAllTouches();
  if (isHost && activeTouches.size === 0) clearTimer();
}

function receiveRound(payload) {
  if (!payload || payload.clientId === clientId) return;
  if (payload.type === "winner") showWinner(payload.touchId);
  if (payload.type === "reset") resetRound();
}

function enterGame() {
  lobby.hidden = true;
  setup.hidden = true;
  game.hidden = false;
}

function hasHost() {
  return Object.values(channel.presenceState())
    .flat()
    .some(presence => presence.role === "host");
}

async function waitForHost(timeoutMs = 6000) {
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
  isHost = host;
  channel = supabase.channel("touch-picker-" + roomCode, {
    config: { broadcast: { self: false }, presence: { key: clientId } }
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
          console.error("Realtime subscription failed:", status, subscriptionError);
          const detail = describeRealtimeError(subscriptionError);
          reject(new Error(
            "Realtime connection failed (" + status + "). " +
            (detail || "Check the network connection and Supabase Realtime service.")
          ));
        }
      });
    });

    showError("Registering room presence…");
    await updatePresence();

    if (host) {
      $("roomCode").textContent = roomCode;
      setup.hidden = true;
      lobby.hidden = false;
      return;
    }

    if (!await waitForHost()) {
      throw new Error("Room not found. Check the code and try again.");
    }

    await updatePresence();
    enterGame();
  } catch (error) {
    const failedChannel = channel;
    channel = null;
    roomCode = "";
    isHost = false;
    if (failedChannel && supabase) {
      try {
        await supabase.removeChannel(failedChannel);
      } catch (cleanupError) {
        console.error("Failed to clean up unsuccessful room channel:", cleanupError);
      }
    }
    throw error;
  }
}

let connecting = false;

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

playArea.addEventListener("pointerdown", async event => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  event.preventDefault();
  try {
    playArea.setPointerCapture(event.pointerId);
  } catch {
    // Synthetic or unsupported pointer capture; normal pointer events still work.
  }

  if (roundLocked) beginNewRoundIfNeeded();

  const p = point(event);
  const id = clientId + ":" + event.pointerId + ":" + (++touchNumber);
  // Every pointer is an independent contestant. A device can therefore
  // contribute several simultaneous fingers, limited only by its hardware/browser.
  const touch = {
    id,
    clientId,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    x: p.x,
    y: p.y,
    color: touchColor(id)
  };

  localTouches.set(event.pointerId, touch);
  pointerToTouch.set(event.pointerId, id);
  activeTouches.set(id, touch);
  markerFor(touch);

  // Start the host timer at touch-down; each additional new touch restarts it.
  if (isHost) scheduleSelection();
  refreshPresence();
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

  const now = performance.now();
  if (now - lastMoveSent < 30) return;
  lastMoveSent = now;
  void sendTouch("move", touch);
});

async function finishTouch(event) {
  const id = pointerToTouch.get(event.pointerId);
  if (!id) return;

  pointerToTouch.delete(event.pointerId);
  localTouches.delete(event.pointerId);

  // Keep the selected colour displayed after the finger is released,
  // but clear the presence snapshot so it cannot leak into the next round.
  refreshPresence();
  if (roundLocked) return;

  activeTouches.delete(id);
  touchLayer.querySelector('[data-id="' + CSS.escape(id) + '"]')?.remove();
  await sendTouch("end", { id });
  if (isHost && activeTouches.size === 0) clearTimer();
}

playArea.addEventListener("pointerup", finishTouch);
playArea.addEventListener("pointercancel", finishTouch);

window.addEventListener("pagehide", () => {
  clearTimer();
  if (channel) void supabase.removeChannel(channel);
});