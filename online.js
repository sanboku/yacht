// オンライン対戦の通信（公開 MQTT ブローカー経由のメッセージ中継）
// 部屋を作った端末（ホスト）がゲームの状態を持ち、参加者からの操作を受けて全員に配信する。
// 端末同士を直接つながないので、モバイル回線やアプリの切り替えがあっても通信が途切れにくい。
(function () {
  "use strict";

  const { Game } = window.Yacht;

  // どれかが落ちていても遊べるよう、複数のブローカーに同時につないで全部に送る（受信側で重複を除く）
  const BROKERS = [
    { name: "EMQX", url: "wss://broker.emqx.io:8084/mqtt" },
    { name: "HiveMQ", url: "wss://broker.hivemq.com:8884/mqtt" },
    { name: "Mosquitto", url: "wss://test.mosquitto.org:8081/mqtt" },
  ];
  const TOPIC_ROOT = "sanboku-yacht/v2";
  const CODE_LENGTH = 4;
  const MAX_PLAYERS = 4;
  const BROKER_TIMEOUT_MS = 10000; // どのブローカーにもつながらないときに諦めるまで
  const HEARTBEAT_MS = 2500; // この間隔で状態（ホスト）や生存確認（ゲスト）を送り続ける
  const PEER_TIMEOUT_MS = 12000; // これだけ相手から届かなければ切断とみなす
  const SLOW_JOIN_MS = 6000; // 参加に時間がかかっていると知らせるまで

  function randomId(length = 12) {
    let id = "";
    for (let i = 0; i < length; i++) id += Math.floor(Math.random() * 36).toString(36);
    return id;
  }

  function randomCode() {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += Math.floor(Math.random() * 10);
    return code;
  }

  // 全角数字（１２３４）や空白・ハイフン混じりで入力されても数字だけを取り出す
  function normalizeCode(text) {
    return String(text || "").normalize("NFKC").replace(/[^0-9]/g, "");
  }

  // 再接続のとき同じ席に戻れるよう、端末ごとの ID を覚えておく
  function clientId() {
    const key = "yacht.clientId";
    try {
      let id = localStorage.getItem(key);
      if (!id) {
        id = randomId(16);
        localStorage.setItem(key, id);
      }
      return id;
    } catch {
      return randomId(16);
    }
  }

  // 複数ブローカーへの接続をまとめて、1本の通信路のように扱う
  // handlers: { onMessage(topic, msg), onConnect(), onFail() }
  function createRelay(subscribeTopic, handlers) {
    const seen = new Set();
    const seenOrder = [];
    let everConnected = false;

    const clients = [];
    BROKERS.forEach(({ url }) => {
      const client = window.mqtt.connect(url, {
        clientId: "yacht_" + randomId(),
        clean: true,
        keepalive: 30,
        reconnectPeriod: 2000,
        connectTimeout: BROKER_TIMEOUT_MS,
        protocolVersion: 4,
      });
      client.on("connect", () => {
        client.subscribe(subscribeTopic, { qos: 0 });
        everConnected = true;
        handlers.onConnect();
      });
      client.on("message", (topic, payload) => {
        let msg;
        try { msg = JSON.parse(payload.toString()); } catch { return; }
        if (!msg || typeof msg !== "object" || typeof msg.mid !== "string") return;
        if (seen.has(msg.mid)) return; // もう片方のブローカーから届いた同じメッセージ
        seen.add(msg.mid);
        seenOrder.push(msg.mid);
        if (seenOrder.length > 500) seen.delete(seenOrder.shift());
        handlers.onMessage(topic, msg);
      });
      client.on("error", () => { /* 再接続は mqtt.js が自動で行う */ });
      clients.push(client);
    });

    const failTimer = setTimeout(() => {
      if (!everConnected) handlers.onFail();
    }, BROKER_TIMEOUT_MS + 2000);

    // スマホでアプリを切り替えて戻ってきたら、すぐにつなぎ直す
    function onVisible() {
      if (document.visibilityState !== "visible") return;
      clients.forEach((c) => { if (!c.connected && !c.disconnecting) c.reconnect(); });
    }
    document.addEventListener("visibilitychange", onVisible);

    return {
      send(topic, msg) {
        const payload = JSON.stringify({ ...msg, mid: randomId(16) });
        clients.forEach((c) => { if (c.connected) c.publish(topic, payload, { qos: 0 }); });
      },
      get connected() { return clients.some((c) => c.connected); },
      close() {
        clearTimeout(failTimer);
        document.removeEventListener("visibilitychange", onVisible);
        clients.forEach((c) => c.end(true));
      },
    };
  }

  const hostTopic = (code) => `${TOPIC_ROOT}/${code}/host`;
  const guestTopic = (code, id) => `${TOPIC_ROOT}/${code}/c/${id}`;

  const CONNECT_ERROR = "通信サーバーに接続できません。電波の良い所で再度お試しください。";

  // ---- ホスト（部屋を作った人） ----
  // ev: { onReady(code), onUpdate(payload), onError(message) }
  function createHost(name, ev) {
    const code = randomCode();
    const hostId = randomId();
    const players = [{ name, clientId: clientId(), connected: true, lastSeen: Infinity }];
    let game = null;
    let seq = 0;
    let ready = false;
    let closed = false;

    function publicPlayers() {
      return players.map((p) => ({ name: p.name, connected: p.connected }));
    }

    function payload() {
      return game
        ? { type: "state", players: publicPlayers(), state: game.toState() }
        : { type: "lobby", players: publicPlayers() };
    }

    // local: ホスト自身の画面も更新するか（定期配信のときは変化がないので更新しない）
    function broadcast(local = true) {
      if (closed) return;
      const msg = { ...payload(), host: hostId, seq: ++seq };
      players.forEach((p, index) => {
        if (index > 0) relay.send(guestTopic(code, p.clientId), { ...msg, you: index });
      });
      if (local) ev.onUpdate({ ...msg, you: 0 });
    }

    // ゲストは参加リクエストを生存確認として送り続ける
    function handleJoin(msg) {
      const playerName = String(msg.name || "").trim().slice(0, 12) || "ゲスト";
      const existing = players.findIndex((p, i) => i > 0 && p.clientId === msg.from);
      if (existing >= 0) {
        const player = players[existing];
        player.lastSeen = Date.now();
        const renamed = !game && player.name !== playerName;
        if (renamed) player.name = playerName;
        if (renamed || !player.connected) {
          player.connected = true;
          broadcast();
        }
        return;
      }
      if (game) {
        return relay.send(guestTopic(code, msg.from), { type: "rejected", message: "ゲームはすでに始まっています。" });
      } else if (players.length >= MAX_PLAYERS) {
        return relay.send(guestTopic(code, msg.from), { type: "rejected", message: `満員です（最大${MAX_PLAYERS}人）。` });
      } else {
        players.push({ name: playerName, clientId: msg.from, connected: true, lastSeen: Date.now() });
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

    function handleMessage(_topic, msg) {
      if (typeof msg.from !== "string") return;
      if (msg.type === "join") return handleJoin(msg);
      const index = players.findIndex((p, i) => i > 0 && p.clientId === msg.from);
      if (index >= 0 && msg.type === "action") apply(index, msg);
    }

    const relay = createRelay(hostTopic(code), {
      onMessage: handleMessage,
      onConnect() {
        if (!ready) {
          ready = true;
          ev.onReady(code);
        }
        broadcast(); // つなぎ直したときも最新の状態を配り直す
      },
      onFail() { ev.onError(CONNECT_ERROR); },
    });

    // 定期的に最新の状態を配る（取りこぼしの回復と、ゲストへの生存通知を兼ねる）
    const heartbeat = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (let i = players.length - 1; i > 0; i--) {
        const p = players[i];
        if (!p.connected || now - p.lastSeen <= PEER_TIMEOUT_MS) continue;
        if (game) p.connected = false;
        else players.splice(i, 1); // 待合室で抜けた人は外す
        changed = true;
      }
      if (changed || players.length > 1) broadcast(changed);
    }, HEARTBEAT_MS);

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
        relay.close();
      },
    };
  }

  // ---- ゲスト（部屋に入る人） ----
  // ev: { onUpdate(payload), onError(message), onHostLost(lost: boolean), onWaiting() }
  function createGuest(code, name, ev) {
    const me = clientId();
    let joined = false;
    let closed = false;
    let hostId = null;
    let lastSeq = 0;
    let lastSeen = Date.now();
    let hostLost = false;
    let lastView = "";
    const startedAt = Date.now();

    function finish(message) {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      relay.close();
      ev.onError(message);
    }

    const relay = createRelay(guestTopic(code, me), {
      onMessage(_topic, msg) {
        if (closed) return;
        if (msg.type === "rejected") return finish(msg.message);
        if (msg.type !== "lobby" && msg.type !== "state") return;
        // ホストが部屋を作り直した場合は番号を振り直す。古い（順番が前後した）状態は捨てる
        if (msg.host !== hostId) { hostId = msg.host; lastSeq = 0; }
        if (msg.seq <= lastSeq) return;
        lastSeq = msg.seq;
        lastSeen = Date.now();
        joined = true;
        if (hostLost) { hostLost = false; ev.onHostLost(false); }
        // 定期配信で内容が変わっていなければ描き直さない（操作中のタップを取りこぼさないため）
        const view = JSON.stringify([msg.type, msg.you, msg.players, msg.state]);
        if (view === lastView) return;
        lastView = view;
        ev.onUpdate(msg);
      },
      onConnect() {
        if (!joined) relay.send(hostTopic(code), { type: "join", from: me, name });
      },
      onFail() { finish(CONNECT_ERROR); },
    });

    // 参加リクエストを送り続ける。参加前はホストがアプリを切り替えていても戻れば応答でき、
    // 参加後はホストへの生存確認になる。ホストからの音沙汰がなければ知らせる
    const heartbeat = setInterval(() => {
      if (joined && !hostLost && Date.now() - lastSeen > PEER_TIMEOUT_MS) {
        hostLost = true;
        ev.onHostLost(true);
      }
      if (!relay.connected) return;
      relay.send(hostTopic(code), { type: "join", from: me, name });
      // ホストのスマホが画面オフなどで止まっている間も、諦めずに送り続ける（キャンセルは画面から）
      if (!joined && Date.now() - startedAt > SLOW_JOIN_MS) ev.onWaiting();
    }, HEARTBEAT_MS);

    return {
      act(action) {
        relay.send(hostTopic(code), { type: "action", from: me, ...action });
      },
      close() {
        closed = true;
        clearInterval(heartbeat);
        relay.close();
      },
    };
  }

  window.YachtOnline = { createHost, createGuest, normalizeCode, MAX_PLAYERS };
})();
