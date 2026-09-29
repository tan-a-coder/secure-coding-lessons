(function () {
  "use strict";
  var CFG = window.PACE_CONFIG || { pastebox: { endpoint: "" } };
  var ENDPOINT = (CFG.pastebox && CFG.pastebox.endpoint || "").replace(/\/+$/, "");
  var TIMEOUT = (CFG.pastebox && CFG.pastebox.timeoutMs) || 15000;
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

  function timed(url, opts, retriesLeft) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, TIMEOUT);
    opts = opts || {};
    opts.signal = ctrl.signal;
    return fetch(url, opts).then(function (r) {
      clearTimeout(t);
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).catch(function (e) {
      clearTimeout(t);
      // The Apps Script endpoint answers in 1.5-8s and intermittently 404s, returns an
      // empty body, or drops the connection. Retry only when re-sending cannot
      // double-count: reads always, writes only when the caller pushes cumulative state.
      if (retriesLeft > 0) {
        var waits = [800, 2500, 7000];            // ride out a bad minute
        var wait = waits[Math.min(3 - retriesLeft, waits.length - 1)];
        return new Promise(function (res) { setTimeout(res, wait); })
          .then(function () { return timed(url, opts, retriesLeft - 1); });
      }
      throw e;
    });
  }

  function board() {
    if (!ENDPOINT) return Promise.reject(new Error("no endpoint configured"));
    return timed(ENDPOINT + "?action=board", { cache: "no-store" }, 3);
  }

  function post(action, obj) {
    if (!ENDPOINT) return Promise.reject(new Error("no endpoint configured"));
    return timed(ENDPOINT + "?action=" + action, {
      method: "POST",
      headers: { "Content-Type": "text/plain" }, // simple request — no preflight
      body: JSON.stringify(obj)
    }, (obj && obj.stats) ? 3 : 0);
  }

  // Read-modify-write against the board's team doc (the merge base for
  // multi-device teams). patch = {scoreDelta, solved?, accuracy?, game?}
  // plus, from games that track their own totals:
  //   stats     = {score, correct, attempts}  absolute for THIS device
  //   solvedAll = {lessonId: true, ...}       every lesson this device has solved
  //
  // Two pushes in flight at once would both read the same base and the later
  // POST would wipe the earlier one — silent score loss under rapid play. So
  // every merge runs through one chain, and callers that push absolutes make a
  // lost push self-heal on the next one.
  var chain = Promise.resolve();
  var pending = null;                            // newest cumulative patch

  function enqueue(fn) {
    var run = chain.then(fn, fn);
    chain = run.catch(function () { /* a failed push must not break the chain */ });
    return run;
  }

  function mergeTeam(patch) {
    var profile = getProfile();
    var key = teamKey();
    var now = Date.now();
    var delta = patch.scoreDelta || 0;
    return board().then(function (all) {
      var cur = (all && all[key]) || {};
      var deviceId = profile.deviceId;
      var players = cur.players || {};
      var p = players[deviceId] || { player: profile.playerName || "anonymous", score: 0, correct: 0, attempts: 0, solved: {}, lastActionTs: 0 };
      var prevScore = p.score || 0;
      p.player = profile.playerName || "anonymous";
      if (patch.stats) {
        p.score = patch.stats.score || 0;
        p.correct = patch.stats.correct || 0;
        p.attempts = patch.stats.attempts || 0;
      } else {
        p.score = prevScore + delta;
        if (delta > 0) p.correct = (p.correct || 0) + 1;
        p.attempts = (p.attempts || 0) + 1;
      }
      var added = patch.solvedAll || patch.solved;
      if (added) p.solved = Object.assign({}, p.solved, added);
      p.lastActionTs = now;
      players[deviceId] = p;
      var step = p.score - prevScore;              // what THIS device just contributed
      var doc = {
        teamKey: key,
        team: profile.teamName,
        player: profile.playerName || "anonymous",
        game: patch.game || "game",
        session: (CFG.pastebox && CFG.pastebox.session) || "?",
        score: Math.max(0, (cur.score || 0) + step),
        accuracy: patch.accuracy !== undefined ? patch.accuracy : (cur.accuracy || 0),
        lastActionTs: now,
        solved: Object.assign({}, cur.solved || {}, added || {}),
        history: (cur.history || []).concat(step ? [{ ts: now, delta: step }] : []).slice(-200),
        updatedBy: profile.deviceId,
        heartbeatTs: now,
        players: players
      };
      if (patch.score !== undefined) doc.score = patch.score;
      return post("upsert", doc).then(function () { return doc; });
    });
  }

  function reportTeam(patch) {
    if (patch && patch.stats) {
      // Cumulative callers send their WHOLE state, so while a push is in flight a
      // newer one makes the older redundant — coalesce rather than queue a backlog.
      // This is what keeps a slow endpoint (2–8s per call) from falling behind play.
      pending = patch;
      return enqueue(function () {
        if (!pending) return Promise.resolve(null);
        var p = pending;
        pending = null;
        return mergeTeam(p);
      });
    }
    return enqueue(function () { return mergeTeam(patch); });
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
