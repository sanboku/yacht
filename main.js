// 画面遷移と、1台モード／オンラインモードの制御
(function () {
  "use strict";

  const { CATEGORIES, Game, total } = window.Yacht;
  const { createBoard } = window.YachtBoard;
  const Online = window.YachtOnline;

  const $ = (id) => document.getElementById(id);
  const SCREENS = ["screen-home", "screen-local", "screen-online", "screen-lobby", "screen-game"];

  function show(screenId) {
    SCREENS.forEach((id) => $(id).classList.toggle("hidden", id !== screenId));
  }

  function storageGet(key) {
    try { return localStorage.getItem(key) || ""; } catch { return ""; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* 保存できなくても動作には影響しない */ }
  }

  // ---- 画面に対する操作は現在のモード（controller）に振り分ける ----
  let controller = null;

  const board = createBoard({
    onRoll: () => controller && controller.act({ kind: "roll" }),
    onHold: (index) => controller && controller.act({ kind: "hold", index }),
    onScore: (category) => controller && controller.act({ kind: "score", category }),
  });

  function startBoard() {
    board.reset();
    show("screen-game");
  }

  function showResult(game, { canRestart, note }) {
    const rankingEl = $("ranking");
    rankingEl.innerHTML = "";
    game.players
      .map((p) => ({ name: p.name, total: total(p.sheet) }))
      .sort((a, b) => b.total - a.total)
      .forEach((r) => {
        const li = document.createElement("li");
        li.textContent = `${r.name}：${r.total}点`;
        rankingEl.appendChild(li);
      });
    $("again").classList.toggle("hidden", !canRestart);
    $("result-note").textContent = note || "";
    if (!$("result").open) $("result").showModal();
  }

  function closeDialogs() {
    document.querySelectorAll("dialog[open]").forEach((d) => d.close());
  }

  function notice(text) {
    $("notice-text").textContent = text;
    if (!$("notice").open) $("notice").showModal();
  }

  // オンライン対戦中は画面が自動で消えないようにする（消えるとページが止まり、通信できなくなるため）
  let wakeLock = null;
  let wantAwake = false;
  async function keepAwake(on) {
    wantAwake = on;
    try {
      if (on && !wakeLock && navigator.wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch { /* 対応していない端末では何もしない */ }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wantAwake) keepAwake(true);
  });

  function goHome() {
    if (controller) controller.dispose();
    controller = null;
    keepAwake(false);
    setBusy(false);
    $("online-wait").textContent = "";
    $("join-room").textContent = "部屋に入る";
    closeDialogs();
    document.title = "YACHT";
    history.replaceState(null, "", location.pathname);
    show("screen-home");
  }

  // ---- 1台モード ----
  function renderNameFields() {
    const namesEl = $("name-fields");
    const n = Number($("player-count").value);
    const prev = [...namesEl.querySelectorAll("input")].map((i) => i.value);
    namesEl.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const label = document.createElement("label");
      label.className = "field";
      label.textContent = `プレイヤー${i + 1}`;
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 12;
      input.placeholder = `プレイヤー${i + 1}`;
      input.value = prev[i] ?? "";
      label.appendChild(input);
      namesEl.appendChild(label);
    }
  }

  function startLocal(names) {
    const game = new Game(names);
    const render = () => board.render(game, { canAct: true });
    controller = {
      act(action) {
        if (action.kind === "roll") game.roll();
        else if (action.kind === "hold") game.toggleHold(action.index);
        else if (action.kind === "score") game.score(action.category);
        render();
        if (game.isOver) showResult(game, { canRestart: true });
      },
      restart() { startLocal(names); },
      inProgress: () => !game.isOver && (game.round > 1 || game.hasRolled),
      dispose() {},
    };
    startBoard();
    render();
  }

  // ---- オンラインモード ----
  function onlineName() {
    const name = $("online-name").value.trim();
    storageSet("yacht.name", name);
    return name || "ゲスト";
  }

  function onlineError(message) {
    $("online-error").textContent = message;
  }

  function setBusy(busy) {
    $("create-room").disabled = busy;
    $("join-room").disabled = busy;
  }

  function inviteUrl(code) {
    return `${location.origin}${location.pathname}?room=${code}`;
  }

  function renderLobby(players, myIndex, isHost) {
    const list = $("lobby-players");
    list.innerHTML = "";
    players.forEach((p, i) => {
      const li = document.createElement("li");
      li.textContent = p.name;
      const tags = [];
      if (i === 0) tags.push("ホスト");
      if (i === myIndex) tags.push("あなた");
      if (tags.length) {
        const span = document.createElement("span");
        span.className = "tag";
        span.textContent = `（${tags.join("・")}）`;
        li.appendChild(span);
      }
      list.appendChild(li);
    });
    $("lobby-start").classList.toggle("hidden", !isHost);
    $("lobby-keep").classList.toggle("hidden", !isHost);
    $("lobby-start").disabled = players.length < 2;
    $("lobby-wait").textContent = isHost
      ? (players.length < 2 ? "参加者を待っています…" : `${players.length}人で始められます（最大${Online.MAX_PLAYERS}人）`)
      : "ホストが開始するのを待っています…";
  }

  // ホスト・ゲスト共通：受け取った状態を画面に反映する
  function makeOnlineView(isHost) {
    let game = null;
    let last = null;
    let wasMyTurn = false;
    let hostLost = false;
    const LOST_NOTE = "ホストの応答を待っています…";

    function update(msg) {
      last = msg;
      const myIndex = msg.you;
      if (msg.type === "lobby") {
        renderLobby(msg.players, myIndex, isHost);
        if (hostLost) $("lobby-wait").textContent = LOST_NOTE;
        show("screen-lobby");
        return;
      }
      if (msg.type !== "state") return;

      const isNewGame = !game || msg.state.rollId < game.rollId;
      game = Game.fromState(msg.state);
      game.players.forEach((p, i) => { p.connected = msg.players[i].connected; });
      if (isNewGame) {
        if ($("result").open) $("result").close();
        startBoard();
      }

      const currentOffline = !msg.players[game.current].connected;
      const myTurn = !game.isOver && game.current === myIndex;
      const proxy = isHost && !game.isOver && currentOffline;
      board.render(game, {
        canAct: myTurn || proxy,
        myIndex,
        note: hostLost ? LOST_NOTE
          : proxy ? `${game.player.name}が切断中のため代わりに操作できます` : "",
      });

      // 自分の番になったら知らせる
      document.title = myTurn ? "▶ あなたの番 - YACHT" : "YACHT";
      if (myTurn && !wasMyTurn && navigator.vibrate) navigator.vibrate(80);
      wasMyTurn = myTurn;

      if (game.isOver) {
        showResult(game, {
          canRestart: isHost,
          note: isHost ? "" : "ホストが「もう一度」を押すと再戦が始まります",
        });
      }
    }

    return {
      update,
      // ゲスト：ホストからの通信が途絶えた／戻ったことを表示に反映する
      setHostLost(lost) {
        hostLost = lost;
        if (last) update(last);
      },
    };
  }

  function hostRoom() {
    onlineError("");
    setBusy(true);
    const view = makeOnlineView(true);
    const host = Online.createHost(onlineName(), {
      onReady(code) {
        setBusy(false);
        $("lobby-code").textContent = code;
        $("invite").classList.remove("hidden");
        $("share-done").textContent = "";
        history.replaceState(null, "", `?room=${code}`);
      },
      onUpdate: view.update,
      onError(message) {
        setBusy(false);
        if (controller !== hostController) return;
        if (host.inProgress) {
          notice(message);
        } else {
          host.close();
          controller = null;
          keepAwake(false);
          onlineError(message);
          show("screen-online");
        }
      },
    });
    const hostController = {
      act: (action) => host.act(action),
      restart: () => host.start(),
      inProgress: () => host.inProgress,
      dispose: () => host.close(),
    };
    controller = hostController;
    keepAwake(true);
    $("lobby-code").textContent = "…";
    $("invite").classList.add("hidden");
    renderLobby([{ name: onlineName() }], 0, true);
    show("screen-lobby");
  }

  function joinRoom(code) {
    code = Online.normalizeCode(code);
    if (code.length !== 4) {
      onlineError("部屋コード（4桁の数字）を入力してください。");
      return;
    }
    $("room-code").value = code;
    onlineError("");
    setBusy(true);
    $("join-room").textContent = "接続中…";
    const view = makeOnlineView(false);
    let joined = false;
    const guest = Online.createGuest(code, onlineName(), {
      onUpdate(msg) {
        if (!joined) {
          joined = true;
          setBusy(false);
          $("online-wait").textContent = "";
          $("join-room").textContent = "部屋に入る";
          $("lobby-code").textContent = code;
          $("invite").classList.remove("hidden");
          history.replaceState(null, "", `?room=${code}`);
        }
        view.update(msg);
      },
      onWaiting() {
        $("join-room").textContent = "ホストの応答を待っています…";
        $("online-wait").textContent = "ホストのスマホで待合室の画面が開いたままになっているか確認してください。やめるときは「戻る」を押してください。";
      },
      onError(message) {
        setBusy(false);
        $("join-room").textContent = "部屋に入る";
        if (controller !== guestController) return;
        controller = null;
        keepAwake(false);
        $("online-wait").textContent = "";
        closeDialogs();
        onlineError(message);
        show("screen-online");
      },
      onHostLost(lost) {
        if (controller === guestController) view.setHostLost(lost);
      },
    });
    const guestController = {
      act: (action) => guest.act(action),
      restart() {},
      inProgress: () => true,
      dispose: () => guest.close(),
    };
    controller = guestController;
    keepAwake(true);
  }

  async function shareInvite() {
    const code = $("lobby-code").textContent;
    const url = inviteUrl(code);
    const text = `YACHTで遊ぼう！ 部屋コード: ${code}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "YACHT", text, url });
        return;
      }
      await navigator.clipboard.writeText(`${text}\n${url}`);
      $("share-done").textContent = "招待リンクをコピーしました";
    } catch (err) {
      if (err && err.name === "AbortError") return;
      $("share-done").textContent = url;
    }
  }

  // ---- ルール表 ----
  function renderRulesTable() {
    const table = $("rules-table");
    CATEGORIES.forEach((cat) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = cat.name;
      const td = document.createElement("td");
      td.textContent = cat.hint;
      tr.append(th, td);
      table.appendChild(tr);
    });
  }

  // ---- イベント ----
  $("go-local").addEventListener("click", () => show("screen-local"));
  $("go-online").addEventListener("click", () => { onlineError(""); show("screen-online"); });
  document.querySelectorAll(".go-home").forEach((b) => b.addEventListener("click", goHome));
  document.querySelectorAll(".open-rules").forEach((b) => b.addEventListener("click", () => $("rules").showModal()));
  document.querySelectorAll(".close-dialog").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

  $("player-count").addEventListener("change", renderNameFields);
  $("local-start").addEventListener("click", () => {
    const names = [...$("name-fields").querySelectorAll("input")]
      .map((input, i) => input.value.trim() || `P${i + 1}`);
    startLocal(names);
  });

  $("create-room").addEventListener("click", hostRoom);
  $("join-room").addEventListener("click", () => joinRoom($("room-code").value));
  $("room-code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom($("room-code").value); });
  $("share-invite").addEventListener("click", shareInvite);
  $("lobby-start").addEventListener("click", () => controller && controller.restart());
  $("lobby-leave").addEventListener("click", goHome);

  $("quit").addEventListener("click", () => {
    if (!controller || !controller.inProgress() || confirm("ゲームをやめてトップに戻りますか？")) goHome();
  });
  $("again").addEventListener("click", () => {
    $("result").close();
    if (controller) controller.restart();
  });
  $("result-home").addEventListener("click", goHome);
  $("notice-ok").addEventListener("click", () => $("notice").close());

  // 対戦中にページを閉じそうになったら確認する
  window.addEventListener("beforeunload", (e) => {
    if (controller && controller.inProgress()) e.preventDefault();
  });

  renderNameFields();
  renderRulesTable();
  $("online-name").value = storageGet("yacht.name");

  // 招待リンク（?room=XXXXX）から開いたときは、そのまま参加画面へ
  const roomFromUrl = Online.normalizeCode(new URLSearchParams(location.search).get("room"));
  if (roomFromUrl) {
    $("room-code").value = roomFromUrl;
    show("screen-online");
    (storageGet("yacht.name") ? $("join-room") : $("online-name")).focus();
  } else {
    show("screen-home");
  }
})();
