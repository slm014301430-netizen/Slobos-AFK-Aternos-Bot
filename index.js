"use strict";

const { addLog, getLogs } = require("./logger");
const mineflayer = require("mineflayer");
const { Movements, pathfinder, goals } = require("mineflayer-pathfinder");
const { GoalBlock } = goals;
const config = require("./settings.json");
const express = require("express");
const http = require("http");
const https = require("https");

// ============================================================
// EXPRESS SERVER - Keep Render/Aternos alive
// ============================================================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 5000;

// Bot state tracking
let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false,
};

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>AFK Bot Dashboard</title></head>
    <body>
      <h1>AFK Bot Dashboard</h1>
      <p>Minecraft server bot · Live status</p>
      <p>Server address: <b>${config.server.ip}</b></p>
      <form action="/start" method="POST"><button type="submit">Start bot</button></form>
      <form action="/stop" method="POST"><button type="submit">Stop bot</button></form>
      <p><a href="/tutorial">Setup guide</a> | <a href="/logs">View logs</a></p>
    </body>
    </html>
  `);
});

app.get("/tutorial", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Setup Guide</title></head>
    <body>
      <a href="/">← Back to Dashboard</a>
      <h1>Setup Guide</h1>
      <p>Get your AFK bot running in under 15 minutes.</p>
      <ol>
        <li>Configure Aternos (Paper/Bukkit, Cracked mode, ViaVersion plugins).</li>
        <li>GitHub Setup (Edit settings.json, upload to repo).</li>
        <li>Deploy on Render/Zeabur (npm start).</li>
      </ol>
    </body>
    </html>
  `);
});

app.get("/health", (req, res) => {
  res.json({
    status: botState.connected ? "connected" : "disconnected",
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: bot && bot.entity ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts,
    memoryUsage: process.memoryUsage().heapUsed / 1024 / 1024,
  });
});

app.get("/ping", (req, res) => res.send("pong"));

app.get("/logs", (req, res) => {
  const logs = getLogs();
  const escapeHTML = (str) =>
    str.replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[m]);

  const logCount = logs.length;
  const logHtml = logs.map((l) => {
    const escaped = escapeHTML(l);
    const lower = l.toLowerCase();
    let color = "black";
    if (lower.includes("error") || lower.includes("fail")) color = "red";
    else if (lower.includes("warn")) color = "orange";
    else if (lower.includes("[control]")) color = "blue";
    else if (lower.includes("connect") || lower.includes("join") || lower.includes("spawn")) color = "green";
    return `<div style="color:${color}; font-family:monospace;">${escaped}</div>`;
  }).join("");

  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Bot Logs</title></head>
    <body>
      <a href="/">← Back to Dashboard</a>
      <h1>Bot Logs</h1>
      <p>${logCount} ${logCount === 1 ? "entry" : "entries"}</p>
      <div style="border:1px solid #ccc; padding:10px; max-height:500px; overflow-y:scroll;">
        ${logCount === 0 ? "No log entries yet." : logHtml}
      </div>
    </body>
    </html>
  `);
});

let botRunning = true;

app.post("/start", (req, res) => {
  if (botRunning) return res.json({ success: false, msg: "Already running" });
  botRunning = true;
  createBot();
  addLog("[Control] Bot started");
  res.json({ success: true });
});

app.post("/stop", (req, res) => {
  if (!botRunning) return res.json({ success: false, msg: "Already stopped" });
  botRunning = false;
  if (bot) {
    try { bot.end(); } catch(e) {}
    bot = null;
  }
  if (pendingBot) {
    try { pendingBot.end(); } catch(e) {}
    pendingBot = null;
  }
  clearAllIntervals();
  addLog("[Control] Bot stopped");
  res.json({ success: true });
});
 
app.post("/command", express.json(), (req, res) => {
  const cmd = (req.body.command || "").trim();
  if (!cmd) return res.json({ success: false, msg: "Empty command." });

  addLog(`[Console] > ${cmd}`);

  if (cmd === "/help") {
    const lines = [
      "Available commands:",
      "  /help          - Show this help message",
      "  /pos           - Show bot's current coordinates",
      "  /status        - Show bot connection status",
      "  /say <msg>     - Send a chat message in-game",
      "  /<cmd>         - Send any Minecraft command directly",
    ];
    lines.forEach((l) => addLog(`[Console] ${l}`));
    return res.json({ success: true, msg: lines.join("\n") });
  }

  if (cmd === "/pos" || cmd === "/coords") {
    const pos = bot && bot.entity ? bot.entity.position : null;
    const msg = pos
      ? `Position: X=${Math.floor(pos.x)}  Y=${Math.floor(pos.y)}  Z=${Math.floor(pos.z)}`
      : "Position unavailable (bot not spawned).";
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (cmd === "/status") {
    const status = botState.connected ? "Connected" : "Disconnected";
    const uptime = Math.floor((Date.now() - botState.startTime) / 1000);
    const msg = `Status: ${status} | Uptime: ${uptime}s | Reconnects: ${botState.reconnectAttempts}`;
    addLog(`[Console] ${msg}`);
    return res.json({ success: true, msg });
  }

  if (!bot || typeof bot.chat !== "function") {
    const msg = bot ? "Bot is still connecting..." : "Bot is not running.";
    addLog(`[Console] ${msg}`);
    return res.json({ success: false, msg });
  }

  try {
    bot.chat(cmd);
    addLog(`[Console] Sent to server: ${cmd}`);
    return res.json({ success: true, msg: `Sent: ${cmd}` });
  } catch (err) {
    addLog(`[Console] Error: ${err.message}`);
    return res.json({ success: false, msg: err.message });
  }
});

// FIX: handle port conflict gracefully
const server = app.listen(PORT, "0.0.0.0", () => {
  addLog(`[Server] HTTP server started on port ${server.address().port}`);
});
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    const fallbackPort = PORT + 1;
    addLog(`[Server] Port ${PORT} in use - trying port ${fallbackPort}`);
    server.listen(fallbackPort, "0.0.0.0");
  } else {
    addLog(`[Server] HTTP server error: ${err.message}`);
  }
});

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

// ============================================================
// SELF-PING - Prevent Render from sleeping
// ============================================================
const SELF_PING_INTERVAL = 10 * 60 * 1000;

function startSelfPing() {
  const renderUrl = process.env.RENDER_EXTERNAL_URL;
  if (!renderUrl) {
    addLog("[KeepAlive] No RENDER_EXTERNAL_URL set - self-ping disabled");
    return;
  }
  setInterval(() => {
    const protocol = renderUrl.startsWith("https") ? https : http;
    protocol
      .get(`${renderUrl}/ping`, (res) => {})
      .on("error", (err) => {
        addLog(`[KeepAlive] Self-ping failed: ${err.message}`);
      });
  }, SELF_PING_INTERVAL);
  addLog("[KeepAlive] Self-ping system started (every 10 min)");
}
startSelfPing();

// ============================================================
// MEMORY MONITORING
// ============================================================
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
  addLog(`[Memory] Heap: ${heapMB} MB`);
}, 5 * 60 * 1000);

// ============================================================
// BOT STATE & RECONNECTION LOGIC
// ============================================================
let bot = null;
let pendingBot = null;
let nameChangeTimer = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;
let spawnHandled = false;

function clearBotTimeouts() {
  if (reconnectTimeoutId) {
    clearTimeout(reconnectTimeoutId);
    reconnectTimeoutId = null;
  }
  if (connectionTimeoutId) {
    clearTimeout(connectionTimeoutId);
    connectionTimeoutId = null;
  }
}

let lastDiscordSend = 0;
const DISCORD_RATE_LIMIT_MS = 5000;

function clearAllIntervals() {
  addLog(`[Cleanup] Clearing ${activeIntervals.length} intervals`);
  activeIntervals.forEach((id) => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  if (botState.wasThrottled) {
    botState.wasThrottled = false;
    const throttleDelay = 60000 + Math.floor(Math.random() * 60000);
    addLog(`[Bot] Throttle detected - using extended delay: ${throttleDelay / 1000}s`);
    return throttleDelay;
  }
  const baseDelay = config.utils["auto-reconnect-delay"] || 3000;
  const maxDelay = config.utils["max-reconnect-delay"] || 30000;
  const delay = Math.min(baseDelay * Math.pow(2, botState.reconnectAttempts), maxDelay);
  const jitter = Math.floor(Math.random() * 2000);
  return delay + jitter;
}

// ============================================================
// VITAL LISTENERS (Extracted for Dual-Bot Handoff)
// ============================================================
function attachVitalListeners(b) {
  b.on("kicked", (reason) => {
    const kickReason = typeof reason === "object" ? JSON.stringify(reason) : reason;
    addLog(`[Bot] Kicked: ${kickReason}`);
    botState.connected = false;
    botState.errors.push({ type: "kicked", reason: kickReason, time: Date.now() });
    clearAllIntervals();

    const reasonStr = String(kickReason).toLowerCase();
    if (reasonStr.includes("throttl") || reasonStr.includes("wait before reconnect") || reasonStr.includes("too fast")) {
      botState.wasThrottled = true;
    }
    if (config.discord && config.discord.events && config.discord.events.disconnect) {
      sendDiscordWebhook(`[!] **Kicked**: ${kickReason}`, 0xff0000);
    }
  });

  b.on("end", (reason) => {
    if (b !== bot) return; 
    addLog(`[Bot] Disconnected: ${reason || "Unknown reason"}`);
    botState.connected = false;
    clearAllIntervals();
    spawnHandled = false; 

    if (config.discord && config.discord.events && config.discord.events.disconnect) {
      sendDiscordWebhook(`[-] **Disconnected**: ${reason || "Unknown"}`, 0xf87171);
    }
    scheduleReconnect();
  });

  b.on("error", (err) => {
    const msg = err.message || "";
    addLog(`[Bot] Error: ${msg}`);
    botState.errors.push({ type: "error", message: msg, time: Date.now() });
  });
}

// ============================================================
// HOURLY NAME ROTATION (DUAL-BOT HANDOFF)
// ============================================================
function generateRandomName() {
  const prefixes = ['Kudo', 'Slobo', 'AFK', 'Bot', 'Mine', 'Guest', 'Player'];
  const randomNum = Math.floor(1000 + Math.random() * 9000);
  return `${prefixes[Math.floor(Math.random() * prefixes.length)]}_${randomNum}`;
}

function scheduleNameChange() {
  const ONE_HOUR = 60 * 60 * 1000; 
  
  nameChangeTimer = setTimeout(() => {
    const newName = generateRandomName();
    addLog(`[Rotation] Hourly name change initiated. Connecting as: ${newName}`);
    
    if (pendingBot) {
      try { pendingBot.quit(); } catch(e) {}
      pendingBot = null;
    }

    const botVersion = config.server.version && config.server.version.trim() !== "" ? config.server.version : false;
    
    pendingBot = mineflayer.createBot({
      username: newName,
      password: config["bot-account"].password || undefined,
      auth: config["bot-account"].type,
      host: config.server.ip,
      port: config.server.port,
      version: botVersion,
      hideErrors: true,
      checkTimeoutInterval: 600000,
      viewDistance: "tiny",
    });

    pendingBot.once('spawn', () => {
      addLog(`[Rotation] ${newName} spawned. Handing off in 3 seconds...`); 
      
      if (pendingBot.physics) pendingBot.physics.enabled = false;
      if (pendingBot.settings) pendingBot.settings.viewDistance = 2;
      
      attachVitalListeners(pendingBot);

      setTimeout(() => {
        if (bot) {
          try {
            bot.removeAllListeners(); 
            bot.quit();
          } catch(e) {}
        }
        
        bot = pendingBot;
        pendingBot = null;
        spawnHandled = true; 
        
        const mcData = require("minecraft-data")(bot.version);
        const defaultMove = new Movements(bot, mcData);
        defaultMove.allowFreeMotion = false;
        defaultMove.canDig = false;
        defaultMove.liquidCost = 1000;
        defaultMove.fallDamageCost = 1000;
        
        clearAllIntervals();
        initializeModules(bot, mcData, defaultMove);
        
        addLog(`[Rotation] Handoff complete. Old bot disconnected.`);
        scheduleNameChange();
      }, 3000);
    });

    pendingBot.on('error', (err) => addLog(`[Rotation] Pending bot error: ${err.message}`));
    pendingBot.on('end', () => {
      if (pendingBot) {
        addLog(`[Rotation] Pending bot disconnected before handoff.`);
        pendingBot = null;
      }
    });

  }, ONE_HOUR);
}

// ============================================================
// BOT CREATION
// ============================================================
function createBot() {
  if (isReconnecting) {
    addLog("[Bot] Already reconnecting, skipping...");
    return;
  }

  if (bot) {
    clearAllIntervals();
    try {
      bot.removeAllListeners();
      bot.end();
    } catch (e) {
      addLog("[Cleanup] Error ending previous bot:", e.message);
    }
    bot = null;
  }

  addLog(`[Bot] Creating bot instance...`);
  addLog(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  try {
    const botVersion = config.server.version && config.server.version.trim() !== "" ? config.server.version : false;
    
    bot = mineflayer.createBot({
      username: config["bot-account"].username,
      password: config["bot-account"].password || undefined,
      auth: config["bot-account"].type,
      host: config.server.ip,
      port: config.server.port,
      version: botVersion,
      hideErrors: false,
      checkTimeoutInterval: 600000, 
      viewDistance: "tiny", 
    });

    bot.loadPlugin(pathfinder);

    clearBotTimeouts();
    connectionTimeoutId = setTimeout(() => {
      if (!botState.connected) {
        addLog("[Bot] Connection timeout - no spawn received");
        try {
          bot.removeAllListeners();
          bot.end();
        } catch (e) {}
        bot = null;
        scheduleReconnect();
      }
    }, 150000); 

    spawnHandled = false;
    attachVitalListeners(bot);

    bot.once("spawn", () => {
      if (spawnHandled) return;
      spawnHandled = true;

      clearBotTimeouts();
      botState.connected = true;
      botState.lastActivity = Date.now();
      botState.reconnectAttempts = 0;
      isReconnecting = false;

      if (bot.physics) bot.physics.enabled = false; 
      if (bot.settings) bot.settings.viewDistance = 2; 

      addLog(`[Bot] [+] Successfully spawned on server! (Version: ${bot.version})`);
      if (config.discord && config.discord.events && config.discord.events.connect) {
        sendDiscordWebhook(`[+] **Connected** to \`${config.server.ip}\``, 0x4ade80);
      }

      const mcData = require("minecraft-data")(bot.version);
      const defaultMove = new Movements(bot, mcData);
      defaultMove.allowFreeMotion = false;
      defaultMove.canDig = false;
      defaultMove.liquidCost = 1000;
      defaultMove.fallDamageCost = 1000;

      initializeModules(bot, mcData, defaultMove);

      setTimeout(() => {
        if (bot && botState.connected && config.server["try-creative"]) {
          bot.chat("/gamemode creative");
          addLog("[INFO] Attempted to set creative mode (requires OP)");
        }
      }, 3000);

      bot.on("messagestr", (message) => {
        if (message.includes("commands.gamemode.success.self") || message.includes("Set own game mode to Creative Mode")) {
          addLog("[INFO] Bot is now in Creative Mode.");
        }
      });

      if (nameChangeTimer) clearTimeout(nameChangeTimer);
      scheduleNameChange();
    });

  } catch (err) {
    addLog(`[Bot] Failed to create bot: ${err.message}`);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearBotTimeouts();
  if (isReconnecting) {
    addLog("[Bot] Reconnect already scheduled, skipping duplicate.");
    return;
  }

  isReconnecting = true;
  botState.reconnectAttempts++;

  const delay = getReconnectDelay();
  addLog(`[Bot] Reconnecting in ${delay / 1000}s (attempt #${botState.reconnectAttempts})`);

  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    isReconnecting = false;
    createBot();
  }, delay);
}

// ============================================================
// MODULE INITIALIZATION
// ============================================================
function initializeModules(bot, mcData, defaultMove) {
  addLog("[Modules] Initializing all modules...");

  if (config.utils["auto-auth"] && config.utils["auto-auth"].enabled) {
    const password = config.utils["auto-auth"].password;
    let authHandled = false;

    const tryAuth = (type) => {
      if (authHandled || !bot || !botState.connected) return;
      authHandled = true;
      if (type === "register") {
        bot.chat(`/register ${password} ${password}`);
        addLog("[Auth] Detected register prompt - sent /register");
      } else {
        bot.chat(`/login ${password}`);
        addLog("[Auth] Detected login prompt - sent /login");
      }
    };

    bot.on("messagestr", (message) => {
      if (authHandled) return;
      const msg = message.toLowerCase();
      if (msg.includes("/register") || msg.includes("register ") || msg.includes("지정된 비밀번호")) {
        tryAuth("register");
      } else if (msg.includes("/login") || msg.includes("login ") || msg.includes("로그인")) {
        tryAuth("login");
      }
    });

    setTimeout(() => {
      if (!authHandled && bot && botState.connected) {
        addLog("[Auth] No prompt detected after 10s, sending /login as failsafe");
        bot.chat(`/login ${password}`);
        authHandled = true;
      }
    }, 10000);
  }

  if (config.utils["chat-messages"] && config.utils["chat-messages"].enabled) {
    const messages = config.utils["chat-messages"].messages;
    if (config.utils["chat-messages"].repeat) {
      let i = 0;
      addInterval(() => {
        if (bot && botState.connected) {
          bot.chat(messages[i]);
          botState.lastActivity = Date.now();
          i = (i + 1) % messages.length;
        }
      }, config.utils["chat-messages"]["repeat-delay"] * 1000);
    } else {
      messages.forEach((msg, idx) => {
        setTimeout(() => {
          if (bot && botState.connected) bot.chat(msg);
        }, idx * 1000);
      });
    }
  }

  if (config.position && config.position.enabled && !(config.movement && config.movement["circle-walk"] && config.movement["circle-walk"].enabled)) {
    bot.pathfinder.setMovements(defaultMove);
    bot.pathfinder.setGoal(new GoalBlock(config.position.x, config.position.y, config.position.z));
    addLog("[Position] Navigating to configured position...");
  }

  if (config.utils["anti-afk"] && config.utils["anti-afk"].enabled) {
    addInterval(() => {
      if (!bot || !botState.connected) return;
      try { bot.swingArm(); } catch (e) {}
    }, 10000 + Math.floor(Math.random() * 50000));

    addInterval(() => {
      if (!bot || !botState.connected) return;
      try {
        const slot = Math.floor(Math.random() * 9);
        bot.setQuickBarSlot(slot);
      } catch (e) {}
    }, 30000 + Math.floor(Math.random() * 90000));

    addInterval(() => {
      if (!bot || !botState.connected || typeof bot.setControlState !== "function") return;
      if (Math.random() > 0.9) {
        let count = 2 + Math.floor(Math.random() * 4);
        const doTeabag = () => {
          if (count <= 0) return;
          try {
            bot.setControlState("sneak", true);
            setTimeout(() => {
              if (bot && typeof bot.setControlState === "function") bot.setControlState("sneak", false);
              count--;
              setTimeout(doTeabag, 150);
            }, 150);
          } catch (e) {}
        };
        doTeabag();
      }
    }, 120000 + Math.floor(Math.random() * 180000));

    if (!(config.movement && config.movement["circle-walk"] && config.movement["circle-walk"].enabled)) {
      addInterval(() => {
        if (!bot || !botState.connected || typeof bot.setControlState !== "function") return;
        try {
          const yaw = Math.random() * Math.PI * 2;
          bot.look(yaw, 0, true); 
          bot.setControlState("forward", true);
          setTimeout(() => {
            if (bot && typeof bot.setControlState === "function") bot.setControlState("forward", false);
          }, 500 + Math.floor(Math.random() * 1500));
          botState.lastActivity = Date.now();
        } catch (e) {
          addLog("[AntiAFK] Walk error:", e.message);
        }
      }, 120000 + Math.floor(Math.random() * 360000));
    }

    if (config.utils["anti-afk"].sneak) {
      try {
        if (typeof bot.setControlState === "function") bot.setControlState("sneak", true);
      } catch (e) {}
    }
  }

  if (config.movement && config.movement.enabled !== false) {
    if (config.movement["circle-walk"] && config.movement["circle-walk"].enabled) {
      startCircleWalk(bot, defaultMove);
    }
    if (config.movement["random-jump"] && config.movement["random-jump"].enabled && !(config.movement["circle-walk"] && config.movement["circle-walk"].enabled)) {
      startRandomJump(bot);
    }
    if (config.movement["look-around"] && config.movement["look-around"].enabled) {
      startLookAround(bot);
    }
  }

  if (config.modules.avoidMobs && !config.modules.combat) avoidMobs(bot);
  if (config.modules.combat) combatModule(bot, mcData);
  if (config.modules.beds) bedModule(bot, mcData);
  if (config.modules.chat) chatModule(bot);

  addLog("[Modules] All modules initialized!");
}

// ============================================================
// MOVEMENT HELPERS
// ============================================================
function startCircleWalk(bot, defaultMove) {
  const radius = config.movement["circle-walk"].radius;
  let angle = 0;
  let lastPathTime = 0;

  addInterval(() => {
    if (!bot || !botState.connected) return;
    const now = Date.now();
    if (now - lastPathTime < 2000) return;
    lastPathTime = now;
    try {
      const x = bot.entity.position.x + Math.cos(angle) * radius;
      const z = bot.entity.position.z + Math.sin(angle) * radius;
      bot.pathfinder.setMovements(defaultMove);
      bot.pathfinder.setGoal(new GoalBlock(Math.floor(x), Math.floor(bot.entity.position.y), Math.floor(z)));
      angle += Math.PI / 4;
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog("[CircleWalk] Error:", e.message);
    }
  }, config.movement["circle-walk"].speed);
}

function startRandomJump(bot) {
  addInterval(() => {
    if (!bot || !botState.connected || typeof bot.setControlState !== "function") return;
    try {
      bot.setControlState("jump", true);
      setTimeout(() => {
        if (bot && typeof bot.setControlState === "function") bot.setControlState("jump", false);
      }, 300);
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog("[RandomJump] Error:", e.message);
    }
  }, config.movement["random-jump"].interval);
}

function startLookAround(bot) {
  addInterval(() => {
    if (!bot || !botState.connected) return;
    try {
      const yaw = Math.random() * Math.PI * 2 - Math.PI;
      const pitch = (Math.random() * Math.PI) / 2 - Math.PI / 4;
      bot.look(yaw, pitch, false);
      botState.lastActivity = Date.now();
    } catch (e) {
      addLog("[LookAround] Error:", e.message);
    }
  }, config.movement["look-around"].interval);
}

// ============================================================
// CUSTOM MODULES
// ============================================================
function avoidMobs(bot) {
  const safeDistance = 5;
  addInterval(() => {
    if (!bot || !botState.connected || typeof bot.setControlState !== "function") return;
    try {
      const entities = Object.values(bot.entities).filter(
        (e) => e.type === "mob" || (e.type === "player" && e.username !== bot.username)
      );
      for (const e of entities) {
        if (!e.position) continue;
        const distance = bot.entity.position.distanceTo(e.position);
        if (distance < safeDistance) {
          bot.setControlState("back", true);
          setTimeout(() => {
            if (bot && typeof bot.setControlState === "function") bot.setControlState("back", false);
          }, 500);
          break;
        }
      }
    } catch (e) {
      addLog("[AvoidMobs] Error:", e.message);
    }
  }, 2000);
}

function combatModule(bot, mcData) {
  let lastAttackTime = 0;
  let lockedTarget = null;
  let lockedTargetExpiry = 0;

  bot.on("physicsTick", () => {
    if (!bot || !botState.connected) return;
    if (!config.combat["attack-mobs"]) return;

    const now = Date.now();
    if (now - lastAttackTime < 620) return;

    try {
      if (lockedTarget && now < lockedTargetExpiry && bot.entities[lockedTarget.id] && lockedTarget.position) {
        const dist = bot.entity.position.distanceTo(lockedTarget.position);
        if (dist < 4) {
          bot.attack(lockedTarget);
          lastAttackTime = now;
          return;
        } else {
          lockedTarget = null;
        }
      }

      const mobs = Object.values(bot.entities).filter(
        (e) => e.type === "mob" && e.position && bot.entity.position.distanceTo(e.position) < 4
      );
      if (mobs.length > 0) {
        lockedTarget = mobs[0];
        lockedTargetExpiry = now + 3000; 
        bot.attack(lockedTarget);
        lastAttackTime = now;
      }
    } catch (e) {
      addLog("[Combat] Error:", e.message);
    }
  });

  bot.on("health", () => {
    if (!config.combat["auto-eat"]) return;
    try {
      if (bot.food < 14) {
        const food = bot.inventory.items().find((i) => i.foodPoints && i.foodPoints > 0);
        if (food) {
          bot.equip(food, "hand").then(() => bot.consume()).catch((e) => addLog("[AutoEat] Error:", e.message));
        }
      }
    } catch (e) {
      addLog("[AutoEat] Error:", e.message);
    }
  });
}

function bedModule(bot, mcData) {
  let isTryingToSleep = false;

  addInterval(async () => {
    if (!bot || !botState.connected) return;
    if (!config.beds["place-night"]) return; 

    try {
      const isNight = bot.time.timeOfDay >= 12500 && bot.time.timeOfDay < 23500;
      if (isNight && !bot.isSleeping && !isTryingToSleep) {
        const bedBlock = bot.findBlock({
          matching: (block) => block.name.includes("bed"),
          maxDistance: 8,
        });

        if (bedBlock) {
          isTryingToSleep = true;
          try {
            await bot.sleep(bedBlock); 
            addLog("[Bed] Sleeping...");
          } catch (e) {}
          finally {
            isTryingToSleep = false;
          }
        }
      }
    } catch (e) {
      isTryingToSleep = false;
      addLog("[Bed] Error:", e.message);
    }
  }, 10000);
}

function chatModule(bot) {
  bot.on("chat", (username, message) => {
    if (!bot || username === bot.username) return;

    try {
      if (config.discord && config.discord.enabled && config.discord.events && config.discord.events.chat) {
        sendDiscordWebhook(`💬 **${username}**: ${message}`, 0x7289da);
      }

      if (config.chat && config.chat.respond) {
        const lowerMsg = message.toLowerCase();
        if (lowerMsg.includes("hello") || lowerMsg.includes("hi")) {
          bot.chat(`Hello, ${username}!`);
        }
        if (message.startsWith("!tp ")) {
          const target = message.split(" ")[1];
          if (target) bot.chat(`/tp ${target}`);
        }
      }
    } catch (e) {
      addLog("[Chat] Error:", e.message);
    }
  });
}

// ============================================================
// CONSOLE COMMANDS
// ============================================================
const readline = require("readline");
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  if (!bot || !botState.connected) {
    addLog("[Console] Bot not connected");
    return;
  }

  const trimmed = line.trim();
  if (trimmed.startsWith("say ")) {
    bot.chat(trimmed.slice(4));
  } else if (trimmed.startsWith("cmd ")) {
    bot.chat("/" + trimmed.slice(4));
  } else if (trimmed === "status") {
    addLog(`Connected: ${botState.connected}, Uptime: ${formatUptime(Math.floor((Date.now() - botState.startTime) / 1000))}`);
  } else {
    bot.chat(trimmed);
  }
});

// ============================================================
// DISCORD WEBHOOK INTEGRATION
// ============================================================
function sendDiscordWebhook(content, color = 0x0099ff) {
  if (!config.discord || !config.discord.enabled || !config.discord.webhookUrl || config.discord.webhookUrl.includes("YOUR_DISCORD")) return;

  const now = Date.now();
  if (now - lastDiscordSend < DISCORD_RATE_LIMIT_MS) {
    addLog("[Discord] Rate limited - skipping webhook");
    return;
  }
  lastDiscordSend = now;

  const protocol = config.discord.webhookUrl.startsWith("https") ? https : http;
  const urlParts = new URL(config.discord.webhookUrl);

  const payload = JSON.stringify({
    username: config.name,
    embeds: [
      {
        description: content,
        color: color,
        timestamp: new Date().toISOString(),
        footer: { text: "Slobos AFK Bot" },
      },
    ],
  });

  const options = {
    hostname: urlParts.hostname,
    port: 443,
    path: urlParts.pathname + urlParts.search,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload, "utf8"),
    },
  };

  const req = protocol.request(options, (res) => {});
  req.on("error", (e) => {
    addLog(`[Discord] Error sending webhook: ${e.message}`);
  });
  req.write(payload);
  req.end();
}

// ============================================================
// CRASH RECOVERY - IMMORTAL MODE
// ============================================================
process.on("uncaughtException", (err) => {
  const msg = err.message || "Unknown";
  addLog(`[FATAL] Uncaught Exception: ${msg}`);
  botState.errors.push({ type: "uncaught", message: msg, time: Date.now() });

  if (botState.errors.length > 100) botState.errors = botState.errors.slice(-50);

  const isNetworkError =
    msg.includes("PartialReadError") || msg.includes("ECONNRESET") || msg.includes("EPIPE") ||
    msg.includes("ETIMEDOUT") || msg.includes("timed out") || msg.includes("write after end") ||
    msg.includes("This socket has been ended");

  if (isNetworkError) addLog("[FATAL] Known network/protocol error - recovering gracefully...");

  clearAllIntervals();
  botState.connected = false;

  if (isReconnecting) {
    addLog("[FATAL] isReconnecting was stuck - resetting before crash recovery");
    isReconnecting = false;
    if (reconnectTimeoutId) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
  }

  setTimeout(() => { scheduleReconnect(); }, isNetworkError ? 5000 : 10000);
});

process.on("unhandledRejection", (reason) => {
  const msg = String(reason);
  addLog(`[FATAL] Unhandled Rejection: ${msg}`);
  botState.errors.push({ type: "rejection", message: msg, time: Date.now() });
  if (botState.errors.length > 100) botState.errors = botState.errors.slice(-50);

  const isNetworkError =
    msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("EPIPE") ||
    msg.includes("ENOTFOUND") || msg.includes("timed out") || msg.includes("PartialReadError");

  if (isNetworkError && !isReconnecting) {
    addLog("[FATAL] Network rejection — triggering reconnect...");
    clearAllIntervals();
    botState.connected = false;
    
    if (bot) { try { bot.end(); } catch (_) {} bot = null; }
    if (pendingBot) { try { pendingBot.end(); } catch (_) {} pendingBot = null; }
    if (nameChangeTimer) { clearTimeout(nameChangeTimer); nameChangeTimer = null; }
    
    scheduleReconnect();
  }
});

process.on("SIGTERM", () => { addLog("[System] SIGTERM received — ignoring, bot will stay alive."); });
process.on("SIGINT", () => { addLog("[System] SIGINT received — ignoring, bot will stay alive."); });

// ============================================================
// START THE BOT
// ============================================================
addLog("=".repeat(50));
addLog("  Minecraft AFK Bot v2.5 - Bug-Fixed Edition");
addLog("=".repeat(50));
addLog(`Server: ${config.server.ip}:${config.server.port}`);
addLog(`Version: ${config.server.version}`);
addLog(`Auto-Reconnect: ${config.utils["auto-reconnect"] ? "Enabled" : "Disabled"}`);
addLog("=".repeat(50));

createBot();
