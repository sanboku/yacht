// オンライン対戦の通信（PeerJS / WebRTC）
// 部屋を作った端末（ホスト）がゲームの状態を持ち、参加者からの操作を受けて全員に配信する。
(function () {
  "use strict";

  const { Game } = window.Yacht;

  const PEER_PREFIX = "sanboku-yacht-";
  const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 紛らわしい文字（I, L, O, 0, 1）を除く
  const CODE_LENGTH = 5;
  const MAX_PLAYERS = 4;
  const CONNECT_TIMEOUT_MS = 15000;
  // 相手が突然いなくなっても WebRTC はすぐには気づけないため、定期的に生存確認を送り合う
  const PING_INTERVAL_MS = 2000;
  const PEER_TIMEOUT_MS = 20000;

  function randomCode() {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    return code;
  }

  function normalizeCode(text) {
    return String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  // 再接続のとき同じ席に戻れるよう、端末ごとの ID を覚えておく
  function clientId() {
    const key = "yacht.clientId";
    try {
      let id = localStorage.getItem(key);
      if (!id) {
        id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(key, id);
      }
      return id;
    } catch {
      return Math.random().toString(36).slice(2);
    }
  }

  function peerErrorMessage(err) {
    switch (err && err.type) {
      case "peer-unavailable": return "部屋が見つかりません。コードを確認してください。";
      case "network":
      case "server-error":
      case "socket-error":
      case "socket-closed": return "通信サーバーに接続できません。電波の良い所で再度お試しください。";
      case "browser-incompatible": return "このブラウザはオンライン対戦に対応していません。";
      default: return "通信エラーが発生しました。";
    }
  }

  // ---- ホスト（部屋を作った人） ----
  // ev: { onReady(code), onUpdate(payload), onError(message) }
  function createHost(name, ev) {
    const players = [{ name, clientId: clientId(), conn: null, connected: true }];
    let game = null;
    let peer = null;
    let code = null;
    let closed = false;

    function publicPlayers() {
      return players.map((p) => ({ name: p.name, connected: p.connected }));
    }

    function payload() {
      return game
        ? { type: "state", players: publicPlayers(), state: game.toState() }
        : { type: "lobby", players: publicPlayers() };
    }

    function broadcast() {
      const msg = payload();
      players.forEach((p, index) => {
        if (p.conn && p.connected) p.conn.send({ ...msg, you: index });
      });
      ev.onUpdate({ ...msg, you: 0 });
    }

    function reject(conn, message) {
      conn.send({ type: "rejected", message });
      setTimeout(() => conn.close(), 500);
    }

    function handleJoin(conn, msg) {
      const name = String(msg.name || "").trim().slice(0, 12) || "ゲスト";
      const existing = players.findIndex((p, i) => i > 0 && p.clientId === msg.clientId);
      if (existing >= 0) {
        const old = players[existing].conn;
        players[existing].conn = conn;
        players[existing].connected = true;
        players[existing].lastSeen = Date.now();
        if (!game) players[existing].name = name;
        if (old && old !== conn) old.close();
      } else if (game) {
        return reject(conn, "ゲームはすでに始まっています。");
      } else if (players.length >= MAX_PLAYERS) {
        return reject(conn, `満員です（最大${MAX_PLAYERS}人）。`);
      } else {
        players.push({ name, clientId: msg.clientId, conn, connected: true, lastSeen: Date.now() });
      }
      broadcast();
    }

    function handleClose(conn) {
      const index = players.findIndex((p) => p.conn === conn);
      if (index < 0 || closed) return;
      if (game) {
        players[index].connected = false;
        players[index].conn = null;
      } else {
        players.splice(index, 1);
      }
      broadcast();
    }

    // 切断中の人の番は、ホストが代わりに進められる
    function canControl(index) {
      if (!game || game.isOver) return false;
      if (index === game.current) return true;
      return index === 0 && !players[game.current].connected;
    }

    function apply(index, action) {
      if (!canControl(index)) return;
      let changed = false;
      if (action.kind === "roll") changed = game.roll();
      else if (action.kind === "hold") { game.toggleHold(Number(action.index)); changed = true; }
      else if (action.kind === "score") changed = game.score(String(action.category));
      if (changed) broadcast();
    }

    function open() {
      code = randomCode();
      peer = new window.Peer(PEER_PREFIX + code);
      peer.on("open", () => ev.onReady(code));
      peer.on("connection", (conn) => {
        conn.on("data", (msg) => {
          if (!msg || typeof msg !== "object") return;
          const sender = players.find((p) => p.conn === conn);
          if (sender) sender.lastSeen = Date.now();
          if (msg.type === "join") handleJoin(conn, msg);
          else if (msg.type === "action") {
            apply(players.findIndex((p) => p.conn === conn), msg);
          }
        });
        conn.on("close", () => handleClose(conn));
        conn.on("error", () => handleClose(conn));
      });
      peer.on("disconnected", () => {
        // シグナリングサーバーとの接続だけが切れた場合は再接続を試みる（対戦中の通信は維持される）
        if (!closed && !peer.destroyed) peer.reconnect();
      });
      peer.on("error", (err) => {
        if (err.type === "unavailable-id") {
          peer.destroy();
          open();
        } else if (err.type !== "peer-unavailable") {
          ev.onError(peerErrorMessage(err));
        }
      });
    }

    const heartbeat = setInterval(() => {
      const now = Date.now();
      players.forEach((p) => {
        if (!p.conn) return;
        if (now - p.lastSeen > PEER_TIMEOUT_MS) {
          const conn = p.conn;
          handleClose(conn);
          conn.close();
        } else {
          p.conn.send({ type: "ping" });
        }
      });
    }, PING_INTERVAL_MS);

    open();

    return {
      get code() { return code; },
      get playerCount() { return players.length; },
      get inProgress() { return !!game && !game.isOver; },
      start() {
        if (players.length < 2) return;
        game = new Game(players.map((p) => p.name));
        broadcast();
      },
      act(action) { apply(0, action); },
      close() {
        closed = true;
        clearInterval(heartbeat);
        if (peer) peer.destroy();
      },
    };
  }

  // ---- ゲスト（部屋に入る人） ----
  // ev: { onUpdate(payload), onError(message), onDisconnect() }
  function createGuest(code, name, ev) {
    let peer = new window.Peer();
    let conn = null;
    let closed = false;
    let joined = false;
    let lastSeen = Date.now();

    const timer = setTimeout(() => {
      if (!joined) fail("部屋に接続できませんでした。コードを確認するか、もう一度お試しください。");
    }, CONNECT_TIMEOUT_MS);

    const heartbeat = setInterval(() => {
      if (!joined || !conn || !conn.open) return;
      if (Date.now() - lastSeen > PEER_TIMEOUT_MS) lost();
      else conn.send({ type: "ping" });
    }, PING_INTERVAL_MS);

    function lost() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      peer.destroy();
      if (joined) ev.onDisconnect();
      else ev.onError("部屋に接続できませんでした。");
    }

    function fail(message) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      clearInterval(heartbeat);
      peer.destroy();
      ev.onError(message);
    }

    peer.on("open", () => {
      conn = peer.connect(PEER_PREFIX + code, { reliable: true });
      conn.on("open", () => conn.send({ type: "join", name, clientId: clientId() }));
      conn.on("data", (msg) => {
        if (!msg || typeof msg !== "object") return;
        lastSeen = Date.now();
        if (msg.type === "ping") return;
        if (msg.type === "rejected") return fail(msg.message);
        joined = true;
        clearTimeout(timer);
        ev.onUpdate(msg);
      });
      conn.on("close", lost);
    });
    peer.on("error", (err) => fail(peerErrorMessage(err)));

    return {
      act(action) {
        if (conn && conn.open) conn.send({ type: "action", ...action });
      },
      close() {
        closed = true;
        clearTimeout(timer);
        clearInterval(heartbeat);
        peer.destroy();
      },
    };
  }

  window.YachtOnline = { createHost, createGuest, normalizeCode, MAX_PLAYERS };
})();
