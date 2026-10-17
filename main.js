// 画面遷移と、1台モード／オンラインモードの制御
(function () {
  "use strict";

  const { CATEGORIES, Game, total, truncateName, MAX_NAME_LENGTH } = window.Yacht;
  const { createBoard } = window.YachtBoard;
  const Online = window.YachtOnline;

  const $ = (id) => document.getElementById(id);
  const SCREENS = ["screen-home", "screen-local", "screen-online", "screen-lobby", "screen-game"];

  function show(screenId) {
    SCREENS.forEach((id) => $(id).classList.toggle("hidden", id !== screenId));
  }

  function currentScreen() {
    return SCREENS.find((id) => !$(id).classList.contains("hidden"));
  }

  // ---- 画面の履歴 ----
  // 画面を進めるたびにブラウザの履歴にも積むので、iOS の左端スワイプや
  // Android の戻るボタンで1つ前の画面に戻れる。history.state = { screen, depth }
  // アプリ側から戻したとき（確認や後片付けが済んでいる）。"home" ならトップを表示する
  let silentPop = false;

  function depth() {
    return (history.state && history.state.depth) || 0;
  }

  // 次の画面へ進む。待合室からゲームへは置き換える（戻ると待合室ではなくオンライン設定画面へ）
  function goTo(screenId) {
    const from = currentScreen();
    if (from === screenId) return;
    if (from === "screen-lobby") {
      history.replaceState({ screen: screenId, depth: depth() }, "", location.href);
    } else {
      history.pushState({ screen: screenId, depth: depth() + 1 }, "", location.href);
    }
    show(screenId);
  }

  // 1つ前の画面へ戻る（左上の矢印と同じ動き）
  function goBack() {
    if (depth() > 0) history.back();
    else goHome();
  }

  // アプリ側から前の画面へ戻す（オンラインで部屋に入れなかったときなど）
  function backTo(screenId) {
    if (currentScreen() === screenId) return;
    if (depth() > 0) {
      silentPop = true;
      history.back();
    } else {
      history.replaceState({ screen: screenId, depth: 0 }, "", location.href);
      show(screenId);
    }
  }

  window.addEventListener("popstate", (e) => {
    const target = (e.state && e.state.screen) || "screen-home";
    if (silentPop) {
      const toHome = silentPop === "home";
      silentPop = false;
      if (toHome) {
        // 招待リンクから開いた場合は最初の画面がオンライン設定なので、トップに置き換える
        history.replaceState({ screen: "screen-home", depth: 0 }, "", location.pathname);
        show("screen-home");
      } else {
        show(target);
      }
      return;
    }
    const from = currentScreen();
    const leavingPlay = from === "screen-game" || from === "screen-lobby";
    // 待合室では常に、対戦画面では対戦中だけ確認する
    const inLobby = from === "screen-lobby";
    const needConfirm = leavingPlay && controller && (inLobby || controller.inProgress());
    if (needConfirm && !confirm(inLobby ? "部屋から退出しますか？" : "ゲームをやめますか？")) {
      // 戻るのを取り消して、今の画面にとどまる
      history.pushState({ screen: from, depth: depth() + 1 }, "", location.href);
      return;
    }
    if (leavingPlay) leaveSession();
    closeDialogs();
    // 進む操作で、もう終わったゲームや部屋の画面に来た場合はトップへ
    if ((target === "screen-game" || target === "screen-lobby") && !controller) {
      history.replaceState({ screen: "screen-home", depth: depth() }, "", location.href);
      show("screen-home");
      return;
    }
    show(target);
  });

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
    goTo("screen-game");
  }

  function showResult(game, options) {
    // お祝い演出が出ている間は、終わってから結果を出す
    if (document.querySelector(".celebrate")) {
      setTimeout(() => showResult(game, options), 600);
      return;
    }
    const { canRestart, note } = options;
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

  // 対戦や部屋から抜けるときの後片付け
  function leaveSession() {
    if (controller) controller.dispose();
    controller = null;
    keepAwake(false);
    setBusy(false);
    $("online-wait").textContent = "";
    $("join-room").textContent = "部屋に入る";
    closeDialogs();
    document.title = "YACHT";
  }

  // トップへ戻る（履歴もトップまで巻き戻す）
  function goHome() {
    leaveSession();
    if (depth() > 0) {
      silentPop = "home";
      history.go(-depth());
    } else {
      history.replaceState({ screen: "screen-home", depth: 0 }, "", location.pathname);
      show("screen-home");
    }
  }

  // 名前の入力欄は4文字まで。日本語の変換中は待ち、確定した時点で切り詰める
  // （maxlength は絵文字を2文字と数えたり、変換中に超えられたりするため、自前でも制限する）
  function limitNameInput(input) {
    const clamp = () => {
      const limited = truncateName(input.value, false);
      if (limited !== input.value) input.value = limited;
    };
    input.maxLength = MAX_NAME_LENGTH * 2; // 絵文字（内部では2文字扱い）も4つ入るように
    input.addEventListener("input", (e) => { if (!e.isComposing) clamp(); });
    input.addEventListener("compositionend", clamp);
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
      const caption = document.createElement("span");
      caption.className = "field-label";
      caption.textContent = `プレイヤー${i + 1}`;
      label.appendChild(caption);
      const input = document.createElement("input");
      input.type = "text";
      input.className = "name-input";
      input.placeholder = `P${i + 1}`;
      input.value = prev[i] ?? "";
      limitNameInput(input);
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
    const name = truncateName($("online-name").value);
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

    let lastOpts = null;

    function update(msg) {
      last = msg;
      const myIndex = msg.you;
      if (msg.type === "lobby") {
        renderLobby(msg.players, myIndex, isHost);
        if (hostLost) $("lobby-wait").textContent = LOST_NOTE;
        goTo("screen-lobby");
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
      lastOpts = {
        canAct: myTurn || proxy,
        myIndex,
        note: hostLost ? LOST_NOTE
          : proxy ? `${game.player.name}が切断中のため代わりに操作できます` : "",
      };
      board.render(game, lastOpts);

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
      // ゲスト：操作をホストに送ると同時に、返事を待たずに見た目へ反映する（ラグ対策）
      pending(action) {
        if (!game || !lastOpts || !lastOpts.canAct || game.isOver) return;
        if (action.kind === "hold") {
          game.toggleHold(action.index);
          board.render(game, lastOpts);
        } else {
          board.showPending(game, lastOpts, action.kind);
        }
      },
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
        history.replaceState(history.state, "", `?room=${code}`);
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
          backTo("screen-online");
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
    goTo("screen-lobby");
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
          history.replaceState(history.state, "", `?room=${code}`);
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
        backTo("screen-online");
      },
      onHostLost(lost) {
        if (controller === guestController) view.setHostLost(lost);
      },
    });
    const guestController = {
      act(action) {
        view.pending(action);
        guest.act(action);
      },
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
  $("go-local").addEventListener("click", () => goTo("screen-local"));
  $("go-online").addEventListener("click", () => { onlineError(""); goTo("screen-online"); });
  document.querySelectorAll(".go-home").forEach((b) => b.addEventListener("click", goBack));
  document.querySelectorAll(".open-rules").forEach((b) => b.addEventListener("click", () => $("rules").showModal()));
  document.querySelectorAll(".close-dialog").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

  // 人数は丸いボタンの並びで選ぶ（選択中はチェック付きのライム色）
  function renderCountChoices() {
    const select = $("player-count");
    const box = $("count-choices");
    box.innerHTML = "";
    [...select.options].forEach((opt) => {
      const btn = document.createElement("button");
      const selected = opt.value === select.value;
      btn.className = "choice" + (selected ? " selected" : "");
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(selected));
      btn.textContent = opt.textContent;
      btn.addEventListener("click", () => {
        select.value = opt.value;
        select.dispatchEvent(new Event("change"));
      });
      box.appendChild(btn);
    });
  }

  $("player-count").addEventListener("change", () => {
    renderCountChoices();
    renderNameFields();
  });
  $("local-start").addEventListener("click", () => {
    const names = [...$("name-fields").querySelectorAll("input")]
      .map((input, i) => truncateName(input.value) || `P${i + 1}`);
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

  renderCountChoices();
  renderNameFields();
  renderRulesTable();
  $("online-name").value = truncateName(storageGet("yacht.name"));
  limitNameInput($("online-name"));

  // 招待リンク（?room=XXXXX）から開いたときは、そのまま参加画面へ
  const roomFromUrl = Online.normalizeCode(new URLSearchParams(location.search).get("room"));
  const firstScreen = roomFromUrl ? "screen-online" : "screen-home";
  history.replaceState({ screen: firstScreen, depth: 0 }, "", location.href);
  show(firstScreen);
  if (roomFromUrl) {
    $("room-code").value = roomFromUrl;
    (storageGet("yacht.name") ? $("join-room") : $("online-name")).focus();
  }
})();
