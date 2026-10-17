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

  // handlers: { onRoll(), onHold(index), onScore(categoryId) }
  function createBoard(handlers) {
    const statusEl = $("status");
    const diceEl = $("dice");
    const rollBtn = $("roll");
    const sheetEl = $("scoresheet");
    let lastRollId = null;

    rollBtn.addEventListener("click", () => handlers.onRoll());

    // view: { canAct: 自分が操作できるか, myIndex: 自分の列（オンラインのみ）, note: 補足メッセージ }
    function render(game, view) {
      const animate = lastRollId !== null && game.rollId !== lastRollId;
      lastRollId = game.rollId;
      renderStatus(game, view);
      renderDice(game, view, animate);
      renderSheet(game, view);
    }

    function reset() {
      lastRollId = null;
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
      game.players.forEach((p, i) => {
        const th = document.createElement("th");
        th.textContent = p.name;
        const classes = [];
        if (i === game.current && !game.isOver) classes.push("current-player");
        if (i === view.myIndex) classes.push("me");
        if (p.connected === false) classes.push("offline");
        th.className = classes.join(" ");
        headRow.appendChild(th);
      });
      thead.appendChild(headRow);
      sheetEl.appendChild(thead);

      const tbody = document.createElement("tbody");

      const addCategoryRow = (cat) => {
        const tr = document.createElement("tr");
        const th = document.createElement("th");
        th.scope = "row";
        th.textContent = cat.name;
        th.title = cat.hint;
        tr.appendChild(th);

        game.players.forEach((p, i) => {
          const recorded = p.sheet[cat.id];
          if (recorded !== undefined) {
            tr.appendChild(cell(String(recorded)));
          } else if (i === game.current && game.canScore(cat.id)) {
            const td = document.createElement("td");
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
            tr.appendChild(cell(""));
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
        game.players.forEach((p) => tr.appendChild(cell(valueFn(p.sheet))));
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

    return { render, reset };
  }

  window.YachtBoard = { createBoard };
})();
