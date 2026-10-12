// 画面の描画と操作
(function () {
  "use strict";

  const { CATEGORIES, UPPER_BONUS, UPPER_BONUS_THRESHOLD,
    scoreFor, upperSubtotal, bonus, total, Game } = window.Yacht;

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
  const setupEl = $("setup");
  const gameEl = $("game");
  const countEl = $("player-count");
  const namesEl = $("name-fields");
  const statusEl = $("status");
  const diceEl = $("dice");
  const rollBtn = $("roll");
  const sheetEl = $("scoresheet");
  const resultEl = $("result");

  let game = null;
  let lastNames = [];

  function renderNameFields() {
    const n = Number(countEl.value);
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

  function startGame(names) {
    lastNames = names;
    game = new Game(names);
    setupEl.classList.add("hidden");
    gameEl.classList.remove("hidden");
    render();
  }

  function renderDice(animate) {
    diceEl.innerHTML = "";
    game.dice.forEach((value, i) => {
      const btn = document.createElement("button");
      btn.className = "die";
      btn.dataset.value = value;
      const label = game.hasRolled ? `${value}${game.held[i] ? "（キープ中）" : ""}` : "未投擲";
      btn.setAttribute("aria-label", `サイコロ${i + 1}: ${label}`);
      if (!game.hasRolled) btn.classList.add("blank");
      if (game.held[i]) btn.classList.add("held");
      if (animate && !game.held[i]) btn.classList.add("rolling");
      btn.disabled = !game.hasRolled || game.rollsLeft === 0;
      for (let cell = 0; cell < 9; cell++) {
        const slot = document.createElement("span");
        if (PIPS[value].includes(cell)) slot.className = "pip";
        btn.appendChild(slot);
      }
      btn.addEventListener("click", () => {
        game.toggleHold(i);
        renderDice(false);
      });
      diceEl.appendChild(btn);
    });
  }

  function renderStatus() {
    rollBtn.textContent = `振る（残り ${game.rollsLeft} 回）`;
    rollBtn.disabled = !game.canRoll();
    if (game.isOver) {
      statusEl.textContent = "ゲーム終了！";
      return;
    }
    const roundText = `ラウンド ${game.round} / ${CATEGORIES.length}`;
    const who = game.players.length > 1 ? `${game.player.name} の番 ・ ` : "";
    let action;
    if (!game.hasRolled) action = "サイコロを振ってください";
    else if (game.rollsLeft > 0) action = `あと ${game.rollsLeft} 回振れます。得点表から役を選んで記入もできます`;
    else action = "得点表から役を選んで記入してください";
    statusEl.textContent = `${roundText} ・ ${who}${action}`;
  }

  function cell(text, className) {
    const td = document.createElement("td");
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  function renderSheet() {
    sheetEl.innerHTML = "";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headRow.appendChild(document.createElement("th")).textContent = "役";
    game.players.forEach((p, i) => {
      const th = document.createElement("th");
      th.textContent = p.name;
      if (i === game.current && !game.isOver) th.className = "current-player";
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
      const hint = document.createElement("span");
      hint.className = "cat-hint";
      hint.textContent = cat.hint;
      th.appendChild(hint);
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
          btn.setAttribute("aria-label", `${cat.name}に${preview}点を記入`);
          btn.addEventListener("click", () => {
            game.score(cat.id);
            render();
            if (game.isOver) showResult();
          });
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
      tr.appendChild(cell(label));
      game.players.forEach((p) => tr.appendChild(cell(valueFn(p.sheet))));
      tbody.appendChild(tr);
    };

    CATEGORIES.filter((c) => c.section === "upper").forEach(addCategoryRow);
    addSummaryRow("小計", (s) => `${upperSubtotal(s)} / ${UPPER_BONUS_THRESHOLD}`, "subtotal");
    addSummaryRow(`ボーナス (+${UPPER_BONUS})`, (s) => String(bonus(s)), "subtotal");
    CATEGORIES.filter((c) => c.section === "lower").forEach(addCategoryRow);
    addSummaryRow("合計", (s) => String(total(s)), "total");

    sheetEl.appendChild(tbody);
  }

  function render(animate = false) {
    renderStatus();
    renderDice(animate);
    renderSheet();
  }

  function showResult() {
    const rankingEl = $("ranking");
    rankingEl.innerHTML = "";
    game.ranking().forEach((r) => {
      const li = document.createElement("li");
      li.textContent = `${r.name}：${r.total}点`;
      rankingEl.appendChild(li);
    });
    resultEl.showModal();
  }

  countEl.addEventListener("change", renderNameFields);

  $("start").addEventListener("click", () => {
    const names = [...namesEl.querySelectorAll("input")]
      .map((input, i) => input.value.trim() || `プレイヤー${i + 1}`);
    startGame(names);
  });

  rollBtn.addEventListener("click", () => {
    if (game.roll()) render(true);
  });

  $("again").addEventListener("click", () => {
    resultEl.close();
    startGame(lastNames);
  });

  $("to-setup").addEventListener("click", () => {
    resultEl.close();
    gameEl.classList.add("hidden");
    setupEl.classList.remove("hidden");
  });

  renderNameFields();
})();
