// ゲーム画面（ステータス・得点表・サイコロ）の描画。1台モードとオンラインモードで共用する。
(function () {
  "use strict";

  const { CATEGORIES, UPPER_BONUS, UPPER_BONUS_THRESHOLD,
    scoreFor, upperSubtotal, bonus, total } = window.Yacht;

  // サイコロの目ごとのピップ位置（3x3 グリッドのセル番号 0〜8）
  const PIPS = {
    1: [4],
    2: [2, 6],
    3: [2, 4, 6],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };

  const $ = (id) => document.getElementById(id);

  // 画面全体のお祝い演出（ボーナス獲得・ヨット成立）
  const CONFETTI_COLORS = ["#e9f99d", "#7a2be2", "#c9a2f2", "#f0a070", "#ffffff"];
  function celebrate(kind, playerName) {
    const overlay = document.createElement("div");
    overlay.className = `celebrate celebrate-${kind}`;
    overlay.setAttribute("aria-live", "assertive");
    const burst = document.createElement("div");
    burst.className = "celebrate-burst";
    overlay.appendChild(burst);

    const text = document.createElement("div");
    text.className = "celebrate-text";
    const title = document.createElement("p");
    title.className = "celebrate-title";
    title.textContent = kind === "yacht" ? "YACHT!" : "BONUS";
    const sub = document.createElement("p");
    sub.className = "celebrate-sub";
    sub.textContent = kind === "yacht" ? `${playerName} ＋50` : `${playerName} ＋${UPPER_BONUS}`;
    text.append(title, sub);
    overlay.appendChild(text);

    // 紙吹雪
    const pieces = kind === "yacht" ? 70 : 40;
    for (let i = 0; i < pieces; i++) {
      const piece = document.createElement("span");
      piece.className = "confetti";
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      piece.style.animationDelay = `${Math.random() * 0.4}s`;
      piece.style.animationDuration = `${1.4 + Math.random() * 1.2}s`;
      piece.style.setProperty("--drift", `${(Math.random() - 0.5) * 160}px`);
      piece.style.setProperty("--spin", `${(Math.random() - 0.5) * 1080}deg`);
      if (i % 3 === 0) piece.style.borderRadius = "50%";
      overlay.appendChild(piece);
    }

    document.body.appendChild(overlay);
    if (navigator.vibrate) navigator.vibrate(kind === "yacht" ? [60, 40, 120] : 60);
    setTimeout(() => overlay.remove(), kind === "yacht" ? 2800 : 2200);
  }

  // handlers: { onRoll(), onHold(index), onScore(categoryId) }
  function createBoard(handlers) {
    const statusEl = $("status");
    const diceEl = $("dice");
    const rollBtn = $("roll");
    const sheetEl = $("scoresheet");
    let lastRollId = null;
    let lastSheets = null; // お祝い演出の判定用：前回描画したときの得点表
    let pendingTimer = null;

    rollBtn.addEventListener("click", () => handlers.onRoll());

    // view: { canAct: 自分が操作できるか, myIndex: 自分の列（オンラインのみ）, note: 補足メッセージ }
    function render(game, view) {
      clearTimeout(pendingTimer);
      const animate = lastRollId !== null && game.rollId !== lastRollId;
      lastRollId = game.rollId;
      renderStatus(game, view);
      renderDice(game, view, animate);
      renderSheet(game, view);
      detectCelebrations(game);
    }

    function reset() {
      lastRollId = null;
      lastSheets = null;
    }

    // ボーナス獲得・ヨット成立を、前回の得点表との差分から見つけて演出する
    function detectCelebrations(game) {
      const sheets = game.players.map((p) => ({ ...p.sheet }));
      if (lastSheets && lastSheets.length === sheets.length) {
        game.players.forEach((p, i) => {
          const before = lastSheets[i];
          if (before.yacht === undefined && p.sheet.yacht === 50) celebrate("yacht", p.name);
          else if (bonus(before) === 0 && bonus(p.sheet) > 0) celebrate("bonus", p.name);
        });
      }
      lastSheets = sheets;
    }

    // オンライン対戦で、ホストからの返事を待つ間も押した手応えを出す（ラグ対策）
    // 返事が来れば render で描き直される。届かなかったときのため一定時間で元に戻す
    function showPending(game, view, kind) {
      if (kind === "roll") {
        diceEl.querySelectorAll(".die:not(.held)").forEach((d) => d.classList.add("rolling-loop"));
      }
      rollBtn.disabled = true;
      sheetEl.querySelectorAll(".cell-btn").forEach((b) => { b.disabled = true; });
      diceEl.querySelectorAll(".die").forEach((b) => { b.disabled = true; });
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => render(game, view), 4000);
    }

    // 上部にはラウンド数だけを出す（通信が途切れたときなどの補足があるときだけ2行目に表示）
    function renderStatus(game, view) {
      rollBtn.textContent = `振る（残り ${game.rollsLeft} 回）`;
      rollBtn.disabled = !view.canAct || !game.canRoll();
      const round = Math.min(game.round, CATEGORIES.length);
      statusEl.innerHTML = "";
      const roundEl = document.createElement("span");
      roundEl.className = "round";
      roundEl.textContent = `ROUND ${round} / ${CATEGORIES.length}`;
      statusEl.appendChild(roundEl);
      if (view.note && !game.isOver) {
        const noteEl = document.createElement("span");
        noteEl.className = "status-note";
        noteEl.textContent = view.note;
        statusEl.appendChild(noteEl);
      }
    }

    function renderDice(game, view, animate) {
      diceEl.innerHTML = "";
      const holdable = view.canAct && game.hasRolled && game.rollsLeft > 0 && !game.isOver;
      game.dice.forEach((value, i) => {
        const btn = document.createElement("button");
        btn.className = "die";
        btn.dataset.value = value;
        const label = game.hasRolled ? `${value}${game.held[i] ? "（キープ中）" : ""}` : "未投擲";
        btn.setAttribute("aria-label", `サイコロ${i + 1}: ${label}`);
        if (!game.hasRolled) btn.classList.add("blank");
        if (game.held[i]) btn.classList.add("held");
        if (animate && !game.held[i]) btn.classList.add("rolling");
        btn.disabled = !holdable;
        for (let c = 0; c < 9; c++) {
          const slot = document.createElement("span");
          if (PIPS[value].includes(c)) slot.className = "pip";
          btn.appendChild(slot);
        }
        btn.addEventListener("click", () => handlers.onHold(i));
        diceEl.appendChild(btn);
      });
    }

    // 名前（最大4文字）が列からはみ出すときは、収まるまで文字を少し小さくする
    function fitNames(headRow) {
      [...headRow.children].slice(1).forEach((th) => {
        let size = parseFloat(getComputedStyle(th).fontSize);
        while (th.scrollWidth > th.clientWidth && size > 8) {
          size -= 0.5;
          th.style.fontSize = `${size}px`;
        }
      });
    }

    function cell(text, className) {
      const td = document.createElement("td");
      td.textContent = text;
      if (className) td.className = className;
      return td;
    }

    function renderSheet(game, view) {
      sheetEl.innerHTML = "";

      const thead = document.createElement("thead");
      const headRow = document.createElement("tr");
      headRow.appendChild(document.createElement("th")).textContent = "役";
      // 列は手番の順に並べる
      const columns = (game.order || game.players.map((_, i) => i)).map((i) => [game.players[i], i]);
      const isCurrent = (i) => i === game.current && !game.isOver;
      columns.forEach(([p, i]) => {
        const th = document.createElement("th");
        th.textContent = p.name;
        const classes = [];
        if (isCurrent(i)) classes.push("current-player", "cur");
        if (i === view.myIndex) classes.push("me");
        if (p.connected === false) classes.push("offline");
        th.className = classes.join(" ");
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      sheetEl.appendChild(thead);
      requestAnimationFrame(() => fitNames(headRow));

      const tbody = document.createElement("tbody");

      const addCategoryRow = (cat) => {
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.scope = "row";
        th.textContent = cat.name;
        th.title = cat.hint;
        tr.appendChild(th);

        columns.forEach(([p, i]) => {
          const recorded = p.sheet[cat.id];
          const curClass = isCurrent(i) ? "cur" : "";
          if (recorded !== undefined) {
            tr.appendChild(cell(String(recorded), curClass));
          } else if (isCurrent(i) && game.canScore(cat.id)) {
            const td = document.createElement("td");
            td.className = curClass;
            const btn = document.createElement("button");
            const preview = scoreFor(cat.id, game.dice);
            btn.className = "cell-btn" + (preview > 0 ? " good" : "");
            btn.textContent = preview;
            btn.disabled = !view.canAct;
            btn.setAttribute("aria-label", `${cat.name}に${preview}点を記入`);
            btn.addEventListener("click", () => handlers.onScore(cat.id));
            td.appendChild(btn);
            tr.appendChild(td);
          } else {
            tr.appendChild(cell("", curClass));
          }
        });
        tbody.appendChild(tr);
      };

      const addSummaryRow = (label, valueFn, className) => {
        const tr = document.createElement("tr");
        tr.className = className;
        const th = document.createElement("th");
        th.scope = "row";
        th.textContent = label;
        tr.appendChild(th);
        columns.forEach(([p, i]) => tr.appendChild(cell(valueFn(p.sheet), isCurrent(i) ? "cur" : "")));
        tbody.appendChild(tr);
      };

      CATEGORIES.filter((c) => c.section === "upper").forEach(addCategoryRow);
      addSummaryRow(`ボーナス`, (s) => {
        const b = bonus(s);
        return b > 0 ? `+${UPPER_BONUS}` : `${upperSubtotal(s)}/${UPPER_BONUS_THRESHOLD}`;
      }, "subtotal");
      CATEGORIES.filter((c) => c.section === "lower").forEach(addCategoryRow);
      addSummaryRow("合計", (s) => String(total(s)), "total");

      sheetEl.appendChild(tbody);
    }

    return { render, reset, showPending };
  }

  window.YachtBoard = { createBoard };
})();
