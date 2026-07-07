const { addLog } = require("./logger");

function randomMs(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function setupLeaveRejoin(bot) {
  let leaveTimer = null;
  let jumpTimer = null;
  let jumpOffTimer = null;
  let stopped = false;
  let lastLogAt = 0;

  function logThrottled(msg, minGapMs = 2000) {
    const now = Date.now();
    if (now - lastLogAt >= minGapMs) {
      lastLogAt = now;
      addLog(msg);
    }
  }

  function cleanup() {
    stopped = true;
    if (leaveTimer) clearTimeout(leaveTimer);
    if (jumpTimer) clearTimeout(jumpTimer);
    if (jumpOffTimer) clearTimeout(jumpOffTimer);
    leaveTimer = jumpTimer = jumpOffTimer = null;
  }

  function scheduleNextJump() {
    if (stopped || !bot.entity) return;

    try {
      bot.setControlState("jump", true);
      jumpOffTimer = setTimeout(() => {
        if (bot && typeof bot.setControlState === "function") {
          bot.setControlState("jump", false);
        }
      }, 300);
    } catch (_) {}

    jumpTimer = setTimeout(scheduleNextJump, randomMs(20000, 5 * 60 * 1000));
  }

  bot.once("spawn", () => {
    cleanup();
    stopped = false;

    const stayTime = randomMs(30 * 60000, 90 * 60000);
    logThrottled(`[LeaveRejoin] Will leave in ${Math.round(stayTime / 1000)}s`);

    scheduleNextJump();

    leaveTimer = setTimeout(() => {
      if (stopped) return;
      logThrottled("[LeaveRejoin] Leaving server (scheduled cycle)");
      cleanup();
      try {
        bot.quit();
      } catch (_) {}
    }, stayTime);
  });

  bot.on("end", cleanup);
  bot.on("kicked", cleanup);
  bot.on("error", cleanup);

  return cleanup;
}

module.exports = setupLeaveRejoin;
