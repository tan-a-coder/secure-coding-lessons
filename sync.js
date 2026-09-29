(function () {
  "use strict";
  var CFG = window.PACE_CONFIG || { pastebox: { endpoint: "" } };
  var ENDPOINT = (CFG.pastebox && CFG.pastebox.endpoint || "").replace(/\/+$/, "");
  var TIMEOUT = (CFG.pastebox && CFG.pastebox.timeoutMs) || 10000;
  var HEARTBEAT_MS = CFG.heartbeatMs || 30000;

  var LS_KEY = "secops_game_profile";

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "d" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function slug(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group-0";
  }

  function getProfile() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* corrupted — rebuild */ }
    return { teamName: "Group 0", playerName: "", deviceId: uid() };
  }

  function setProfile(p) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(p)); } catch (e) { /* private mode */ }
  }

  function teamKey() { return slug(getProfile().teamName); }

  function timed(url, opts) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
    opts = opts || {};
    opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (r) {
      clearTimeout(t);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).catch(function (e) { clearTimeout(t); throw e; });
  }

  function board() {
    if (!ENDPOINT) return Promise.reject(new Error("no endpoint configured"));
    return timed(ENDPOINT + "?action=board", { cache: "no-store" });
  }

  function post(action, obj) {
    if (!ENDPOINT) return Promise.reject(new Error("no endpoint configured"));
    return timed(ENDPOINT + "?action=" + action, {
      method: "POST",
      headers: { "Content-Type": "text/plain" }, // simple request — no preflight
      body: JSON.stringify(obj)
    });
  }

  // Read-modify-write. patch = {scoreDelta, solved?, accuracy?, game?}
  // The board's current team doc is the merge base (multi-device teams).
  function reportTeam(patch) {
    var profile = getProfile();
    var key = teamKey();
    var now = Date.now();
    var delta = patch.scoreDelta || 0;
    return board().then(function (all) {
      var cur = (all && all[key]) || {};
      var deviceId = profile.deviceId;
      var players = cur.players || {};
      var p = players[deviceId] || { player: profile.playerName || "anonymous", score: 0, correct: 0, attempts: 0, solved: {}, lastActionTs: 0 };
      p.player = profile.playerName || "anonymous";
      p.score = (p.score || 0) + delta;
      if (delta > 0) p.correct = (p.correct || 0) + 1;
      p.attempts = (p.attempts || 0) + 1;
      if (patch.solved) p.solved = Object.assign({}, p.solved, patch.solved);
      p.lastActionTs = now;
      players[deviceId] = p;
      var doc = {
        teamKey: key,
        team: profile.teamName,
        player: profile.playerName || "anonymous",
        game: patch.game || "game",
        session: (CFG.pastebox && CFG.pastebox.session) || "?",
        score: (cur.score || 0) + delta,
        accuracy: patch.accuracy !== undefined ? patch.accuracy : (cur.accuracy || 0),
        lastActionTs: now,
        solved: Object.assign({}, cur.solved || {}, patch.solved || {}),
        history: (cur.history || []).concat(delta ? [{ ts: now, delta: delta }] : []).slice(-200),
        updatedBy: profile.deviceId,
        heartbeatTs: now,
        players: players
      };
      if (patch.score !== undefined) doc.score = patch.score;
      return post("upsert", doc).then(function () { return doc; });
    });
  }

  function heartbeat() {
    if (!ENDPOINT) return;
    post("heartbeat", { teamKey: teamKey(), heartbeatTs: Date.now() })
      .catch(function () { /* offline — fine */ });
  }

  setInterval(heartbeat, HEARTBEAT_MS);

  // ---- registration modal (zero-friction) ---------------------
  function registerModal(opts) {
    opts = opts || {};
    var profile = getProfile();
    var modal = document.createElement("div");
    modal.style.cssText = "position:fixed;inset:0;background:rgba(6,10,16,.92);display:flex;align-items:center;justify-content:center;z-index:9999;font-family:system-ui,sans-serif";
    var datalist = (CFG.defaultTeams || []).map(function (t) {
      return '<option value="' + t.replace(/"/g, "&quot;") + '">';
    }).join("");
    modal.innerHTML =
      '<div style="background:#111822;border:1px solid #1e2a3a;border-radius:14px;padding:26px;width:min(420px,90vw);color:#d7e2ee">' +
      '<h2 style="margin:0 0 4px;font-size:20px;color:#38e1ff">Register your team</h2>' +
      '<p style="margin:0 0 18px;font-size:13px;color:#7d8ea3">Scores are attributed to this team and shown on the instructor dashboard.</p>' +
      '<label style="display:block;font-size:12px;color:#7d8ea3;margin-bottom:4px">Team name</label>' +
      '<input id="p-reg-team" list="p-reg-groups" value="' + profile.teamName.replace(/"/g, "&quot;") + '" style="width:100%;padding:9px 10px;border-radius:8px;border:1px solid #1e2a3a;background:#0b0f14;color:#d7e2ee;font-size:14px;margin-bottom:12px;box-sizing:border-box">' +
      '<datalist id="p-reg-groups">' + datalist + '</datalist>' +
      '<label style="display:block;font-size:12px;color:#7d8ea3;margin-bottom:4px">Player name <span style="opacity:.6">(optional)</span></label>' +
      '<input id="p-reg-player" value="' + (profile.playerName || "").replace(/"/g, "&quot;") + '" placeholder="anonymous" style="width:100%;padding:9px 10px;border-radius:8px;border:1px solid #1e2a3a;background:#0b0f14;color:#d7e2ee;font-size:14px;margin-bottom:18px;box-sizing:border-box">' +
      '<button id="p-reg-ok" style="width:100%;padding:11px;border-radius:8px;border:none;background:#38e1ff;color:#04121a;font-weight:700;font-size:15px;cursor:pointer">Start playing</button>' +
      '<p style="margin:12px 0 0;font-size:11px;color:#4a5a6a">Stored locally only. Change anytime via the ⚙ icon.</p>' +
      '</div>';
    document.body.appendChild(modal);
    document.getElementById("p-reg-team").focus();
    document.getElementById("p-reg-ok").onclick = function () {
      profile.teamName = document.getElementById("p-reg-team").value.trim() || "Group 0";
      profile.playerName = document.getElementById("p-reg-player").value.trim();
      setProfile(profile);
      modal.remove();
      heartbeat();
      if (opts.onRegister) opts.onRegister(profile);
    };
  }

  window.PACE = window.PACE || {};
  window.PACE.sync = {
    getProfile: getProfile,
    setProfile: setProfile,
    teamKey: teamKey,
    reportTeam: reportTeam,
    heartbeat: heartbeat,
    registerModal: registerModal,
    slug: slug,
    ENDPOINT: ENDPOINT,
    ready: !!ENDPOINT
  };
})();
