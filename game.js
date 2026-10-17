// ヨットのルールと得点計算（画面に依存しない純粋なロジック）
(function (root) {
  "use strict";

  const UPPER_BONUS_THRESHOLD = 63;
  const UPPER_BONUS = 35;
  const MAX_ROLLS = 3;

  const CATEGORIES = [
    { id: "ones", name: "エース", section: "upper", hint: "1の目の合計" },
    { id: "twos", name: "デュース", section: "upper", hint: "2の目の合計" },
    { id: "threes", name: "トレイ", section: "upper", hint: "3の目の合計" },
    { id: "fours", name: "フォー", section: "upper", hint: "4の目の合計" },
    { id: "fives", name: "ファイブ", section: "upper", hint: "5の目の合計" },
    { id: "sixes", name: "シックス", section: "upper", hint: "6の目の合計" },
    { id: "choice", name: "チョイス", section: "lower", hint: "全ての目の合計" },
    { id: "fourKind", name: "フォーダイス", section: "lower", hint: "同じ目4つ以上：全ての目の合計" },
    { id: "fullHouse", name: "フルハウス", section: "lower", hint: "同じ目3つ＋2つ：全ての目の合計" },
    { id: "smallStraight", name: "S.ストレート", section: "lower", hint: "4つ連続：15点" },
    { id: "largeStraight", name: "B.ストレート", section: "lower", hint: "5つ連続：30点" },
    { id: "yacht", name: "ヨット", section: "lower", hint: "5つ全て同じ目：50点" },
  ];

  function counts(dice) {
    const c = [0, 0, 0, 0, 0, 0, 0];
    for (const d of dice) c[d]++;
    return c;
  }

  function sum(dice) {
    return dice.reduce((a, b) => a + b, 0);
  }

  function hasRun(c, length) {
    let run = 0;
    for (let v = 1; v <= 6; v++) {
      run = c[v] > 0 ? run + 1 : 0;
      if (run >= length) return true;
    }
    return false;
  }

  function scoreFor(categoryId, dice) {
    const c = counts(dice);
    const sorted = c.slice(1).filter((n) => n > 0).sort((a, b) => b - a);
    switch (categoryId) {
      case "ones": return c[1] * 1;
      case "twos": return c[2] * 2;
      case "threes": return c[3] * 3;
      case "fours": return c[4] * 4;
      case "fives": return c[5] * 5;
      case "sixes": return c[6] * 6;
      case "choice": return sum(dice);
      case "fourKind": return sorted[0] >= 4 ? sum(dice) : 0;
      case "fullHouse": return sorted[0] === 3 && sorted[1] === 2 ? sum(dice) : 0;
      case "smallStraight": return hasRun(c, 4) ? 15 : 0;
      case "largeStraight": return hasRun(c, 5) ? 30 : 0;
      case "yacht": return sorted[0] === 5 ? 50 : 0;
      default: throw new Error("unknown category: " + categoryId);
    }
  }

  function upperSubtotal(sheet) {
    return CATEGORIES.filter((cat) => cat.section === "upper")
      .reduce((total, cat) => total + (sheet[cat.id] ?? 0), 0);
  }

  function bonus(sheet) {
    return upperSubtotal(sheet) >= UPPER_BONUS_THRESHOLD ? UPPER_BONUS : 0;
  }

  function total(sheet) {
    const all = CATEGORIES.reduce((t, cat) => t + (sheet[cat.id] ?? 0), 0);
    return all + bonus(sheet);
  }

  // 手番の順番をランダムに決める（Fisher–Yates シャッフル）
  function shuffledOrder(count) {
    const order = [...Array(count).keys()];
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order;
  }

  function rollDie(random) {
    return Math.floor(random() * 6) + 1;
  }

  // ゲーム全体の状態を管理する
  class Game {
    // order: 手番の順番（players の添字の並び）。省略時はランダム
    constructor(playerNames, random = Math.random, order = shuffledOrder(playerNames.length)) {
      this.random = random;
      this.rollId = 0;
      this.players = playerNames.map((name) => ({ name, sheet: {} }));
      this.order = order;
      this.turn = 0; // order の何番目の人の番か
      this.current = order[0];
      this.round = 1;
      this.newTurn();
    }

    // オンライン対戦で送受信するための状態
    toState() {
      return {
        players: this.players, order: this.order, turn: this.turn, current: this.current, round: this.round,
        dice: this.dice, held: this.held, rollsLeft: this.rollsLeft, rollId: this.rollId,
      };
    }

    static fromState(state, random = Math.random) {
      const game = Object.create(Game.prototype);
      Object.assign(game, JSON.parse(JSON.stringify(state)), { random });
      return game;
    }

    newTurn() {
      this.dice = [1, 1, 1, 1, 1];
      this.held = [false, false, false, false, false];
      this.rollsLeft = MAX_ROLLS;
    }

    get player() {
      return this.players[this.current];
    }

    get hasRolled() {
      return this.rollsLeft < MAX_ROLLS;
    }

    get isOver() {
      return this.round > CATEGORIES.length;
    }

    canRoll() {
      return !this.isOver && this.rollsLeft > 0;
    }

    roll() {
      if (!this.canRoll()) return false;
      this.dice = this.dice.map((d, i) => (this.held[i] ? d : rollDie(this.random)));
      this.rollsLeft--;
      this.rollId++;
      return true;
    }

    toggleHold(index) {
      if (!this.hasRolled || this.rollsLeft === 0 || this.isOver) return;
      this.held[index] = !this.held[index];
    }

    canScore(categoryId) {
      return !this.isOver && this.hasRolled && this.player.sheet[categoryId] === undefined;
    }

    score(categoryId) {
      if (!this.canScore(categoryId)) return false;
      this.player.sheet[categoryId] = scoreFor(categoryId, this.dice);
      this.turn++;
      if (this.turn >= this.order.length) {
        this.turn = 0;
        this.round++;
      }
      this.current = this.order[this.turn];
      this.newTurn();
      return true;
    }

    ranking() {
      return this.players
        .map((p) => ({ name: p.name, total: total(p.sheet) }))
        .sort((a, b) => b.total - a.total);
    }
  }

  const api = {
    CATEGORIES, MAX_ROLLS, UPPER_BONUS, UPPER_BONUS_THRESHOLD,
    scoreFor, upperSubtotal, bonus, total, Game,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.Yacht = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
