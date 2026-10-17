const test = require("node:test");
const assert = require("node:assert/strict");
const { scoreFor, total, bonus, Game, CATEGORIES, truncateName } = require("../game.js");

test("上段の役は該当する目の合計", () => {
  assert.equal(scoreFor("ones", [1, 1, 2, 3, 1]), 3);
  assert.equal(scoreFor("sixes", [6, 6, 6, 2, 1]), 18);
  assert.equal(scoreFor("fours", [1, 2, 3, 5, 6]), 0);
});

test("チョイスは全ての目の合計", () => {
  assert.equal(scoreFor("choice", [1, 2, 3, 4, 6]), 16);
});

test("フォーダイス", () => {
  assert.equal(scoreFor("fourKind", [3, 3, 3, 3, 5]), 17);
  assert.equal(scoreFor("fourKind", [2, 2, 2, 2, 2]), 10);
  assert.equal(scoreFor("fourKind", [3, 3, 3, 5, 5]), 0);
});

test("フルハウスは3つ＋2つのみ", () => {
  assert.equal(scoreFor("fullHouse", [2, 2, 5, 5, 5]), 19);
  assert.equal(scoreFor("fullHouse", [5, 5, 5, 5, 5]), 0);
  assert.equal(scoreFor("fullHouse", [5, 5, 5, 5, 2]), 0);
});

test("ストレート", () => {
  assert.equal(scoreFor("smallStraight", [1, 2, 3, 4, 6]), 15);
  assert.equal(scoreFor("smallStraight", [3, 4, 5, 6, 6]), 15);
  assert.equal(scoreFor("smallStraight", [1, 2, 3, 5, 6]), 0);
  assert.equal(scoreFor("largeStraight", [2, 3, 4, 5, 6]), 30);
  assert.equal(scoreFor("largeStraight", [5, 1, 4, 3, 2]), 30);
  assert.equal(scoreFor("largeStraight", [1, 2, 3, 4, 6]), 0);
  assert.equal(scoreFor("smallStraight", [5, 1, 4, 3, 2]), 15);
});

test("ヨット", () => {
  assert.equal(scoreFor("yacht", [4, 4, 4, 4, 4]), 50);
  assert.equal(scoreFor("yacht", [4, 4, 4, 4, 3]), 0);
});

test("上段63点以上でボーナス35点", () => {
  const sheet = { ones: 3, twos: 6, threes: 9, fours: 12, fives: 15, sixes: 18 };
  assert.equal(bonus(sheet), 35);
  assert.equal(total(sheet), 63 + 35);
  assert.equal(bonus({ ...sheet, sixes: 17 }), 0);
});

test("ゲーム進行：振る回数・キープ・手番交代・終了", () => {
  let n = 0;
  const seq = [0.0, 0.2, 0.4, 0.6, 0.9]; // 1,2,3,4,6
  const game = new Game(["A", "B"], () => seq[n++ % seq.length], [0, 1]);

  assert.equal(game.canScore("choice"), false, "振る前は記入できない");
  game.toggleHold(0);
  assert.equal(game.held[0], false, "振る前はキープできない");

  game.roll();
  assert.deepEqual(game.dice, [1, 2, 3, 4, 6]);
  game.toggleHold(0);
  game.roll();
  assert.equal(game.dice[0], 1, "キープしたサイコロは変わらない");
  game.roll();
  assert.equal(game.canRoll(), false, "3回まで");

  assert.ok(game.score("choice"));
  assert.equal(game.player.name, "B");
  assert.equal(game.rollsLeft, 3);

  // 全ラウンド消化
  while (!game.isOver) {
    game.roll();
    const open = CATEGORIES.find((c) => game.player.sheet[c.id] === undefined);
    game.score(open.id);
  }
  assert.equal(game.round, CATEGORIES.length + 1);
  assert.equal(game.ranking().length, 2);
  assert.equal(game.score("yacht"), false);
});

test("状態の保存と復元", () => {
  const game = new Game(["A", "B"], Math.random, [0, 1]);
  game.roll();
  game.toggleHold(2);
  game.score("choice");
  game.roll();
  const copy = Game.fromState(JSON.parse(JSON.stringify(game.toState())));
  assert.deepEqual(copy.toState(), game.toState());
  assert.equal(copy.player.name, "B");
  assert.ok(copy.canScore("yacht"));
  assert.ok(copy.roll());
  assert.equal(copy.rollId, game.rollId + 1);
});

test("手番の順番はランダムで、order の順に回る", () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const g = new Game(["A", "B", "C"]);
    assert.deepEqual([...g.order].sort(), [0, 1, 2]);
    seen.add(g.order.join(""));
  }
  assert.equal(seen.size, 6, "3人なら6通りすべての順番が出る");

  const game = new Game(["A", "B", "C"], Math.random, [2, 0, 1]);
  const turns = [];
  for (let i = 0; i < 4; i++) {
    turns.push(game.player.name);
    game.roll();
    game.score(CATEGORIES.find((c) => game.player.sheet[c.id] === undefined).id);
  }
  assert.deepEqual(turns, ["C", "A", "B", "C"]);
  assert.equal(game.round, 2);
  assert.deepEqual(Game.fromState(game.toState()).order, [2, 0, 1]);
});

test("名前は見た目の文字数で4文字まで", () => {
  assert.equal(truncateName("たなかたろう"), "たなかた");
  assert.equal(truncateName("  abc  "), "abc");
  assert.equal(truncateName("😀😀😀😀😀"), "😀😀😀😀");
  assert.equal(truncateName("がぎぐげご"), "がぎぐげ");
  assert.equal(truncateName("A B ", false), "A B ");
  assert.equal(truncateName(undefined), "");
});
