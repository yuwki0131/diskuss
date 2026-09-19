const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'diskuss.settings';

const state = { config: null, debateId: null, source: null, turns: new Map(), lastRound: 0, debaters: null };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// 内部キー (AI1 / AI2) を表示用の名前に直す
function displayName(speaker) {
  return state.config.names?.[speaker] ?? speaker;
}

function modelLabel({ provider, model }) {
  const p = state.config.providers.find((x) => x.id === provider);
  const m = p?.models.find((x) => x.id === model);
  return `${p?.label ?? provider} / ${m?.label ?? model}`;
}

function fillModelSelect(select, preferred) {
  for (const p of state.config.providers) {
    const group = document.createElement('optgroup');
    group.label = p.available ? p.label : `${p.label} (未インストール)`;
    group.disabled = !p.available;
    for (const m of p.models) {
      const opt = el('option', null, m.label);
      opt.value = JSON.stringify({ provider: p.id, model: m.id });
      group.append(opt);
    }
    select.append(group);
  }
  const values = [...select.options].filter((o) => !o.parentElement.disabled).map((o) => o.value);
  select.value = preferred.find((v) => values.includes(v)) ?? values[0] ?? '';
}

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

async function init() {
  const res = await fetch('/api/config');
  state.config = await res.json();
  const saved = loadSettings();
  const key = (provider, model) => JSON.stringify({ provider, model });
  fillModelSelect($('model1'), [saved.model1, key('claude', 'claude-sonnet-5')]);
  fillModelSelect($('model2'), [saved.model2, key('codex', ''), key('copilot', ''), key('claude', 'claude-opus-5')]);
  $('observerName').textContent = state.config.observer;
  for (const [n, speaker] of [[1, 'AI1'], [2, 'AI2']]) {
    $(`legend${n}`).textContent = displayName(speaker);
    $(`badge${n}`).textContent = displayName(speaker);
  }
  const { min, max, default: def } = state.config.rounds;
  Object.assign($('maxRounds'), { min, max, value: saved.maxRounds ?? def });
  if (!state.config.providers.some((p) => p.available)) {
    showFormError('claude / codex / copilot のいずれの CLI も見つかりません。');
    $('startBtn').disabled = true;
  }
}

function showFormError(message) {
  $('formError').textContent = message;
  $('formError').hidden = !message;
}

function setStatus(message) {
  $('status').hidden = !message;
  $('statusText').textContent = message ?? '';
}

function scrollToEnd() {
  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 240;
  if (nearBottom) window.scrollTo({ top: document.body.scrollHeight });
}

function turnBubble(speaker, round) {
  const id = `${speaker}-${round}`;
  if (state.turns.has(id)) return state.turns.get(id);
  if (round !== state.lastRound) {
    state.lastRound = round;
    $('timeline').append(el('div', 'round-mark', `— 第${round}ラウンド —`));
  }
  const side = speaker.toLowerCase();
  const turn = el('div', `turn ${side}`);
  const head = el('div', 'turn-head');
  head.append(el('span', 'badge', displayName(speaker)), el('span', null, modelLabel(state.debaters[speaker])));
  const bubble = el('div', 'bubble typing');
  turn.append(head, bubble);
  $('timeline').append(turn);
  state.turns.set(id, bubble);
  return bubble;
}

function renderVerdict({ verdict, endReason }) {
  const side = verdict.winner.toLowerCase();
  const card = el('div', 'card verdict');
  card.append(
    el('div', 'verdict-label', `オブザーバーの判定 (${state.config.observer})`),
    el('div', `winner ${side}`, `勝者: ${displayName(verdict.winner)}`),
    el('div', 'winner-sub', modelLabel(state.debaters[verdict.winner])),
  );
  const section = (title, text, className) => {
    if (!text) return;
    card.append(el('h3', null, title), el('p', className, text));
  };
  section('決め手', verdict.reason);
  section('議論のサマリ', verdict.summary);
  if (verdict.ai1_evaluation || verdict.ai2_evaluation) {
    const grid = el('div', 'evaluations');
    for (const [name, text] of [[displayName('AI1'), verdict.ai1_evaluation], [displayName('AI2'), verdict.ai2_evaluation]]) {
      const col = el('div');
      col.append(el('h3', null, `${name}の評価`), el('p', null, text ?? ''));
      grid.append(col);
    }
    card.append(grid);
  }
  section('結論', verdict.conclusion, 'conclusion');
  card.append(el('div', 'verdict-foot', `討論終了の理由: ${endReason}`));
  $('timeline').append(card);
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'started':
      state.debaters = ev.debaters;
      $('arenaTopic').textContent = ev.topic;
      $('modelName1').textContent = modelLabel(ev.debaters.AI1);
      $('modelName2').textContent = modelLabel(ev.debaters.AI2);
      break;
    case 'phase':
      setStatus(ev.message);
      break;
    case 'stances':
      $('stanceText1').textContent = ev.stances.AI1.position;
      $('stanceText2').textContent = ev.stances.AI2.position;
      $('stances').hidden = false;
      break;
    case 'turn_start':
      setStatus(`${displayName(ev.speaker)}が発言しています (第${ev.round}ラウンド)`);
      turnBubble(ev.speaker, ev.round);
      break;
    case 'delta':
      turnBubble(ev.speaker, ev.round).textContent += ev.delta;
      break;
    case 'turn_end': {
      const bubble = turnBubble(ev.speaker, ev.round);
      bubble.textContent = ev.text;
      bubble.classList.remove('typing');
      break;
    }
    case 'observer_note':
      $('timeline').append(
        el('div', 'observer-note', `オブザーバー: ${ev.concluded ? '議論が煮詰まったと判断しました' : '討論を続行します'} — ${ev.reason}`),
      );
      break;
    case 'verdict':
      renderVerdict(ev);
      break;
    case 'saved':
      $('timeline').append(el('div', 'observer-note', `記録を保存しました: ${ev.file}`));
      break;
    case 'error':
      $('timeline').append(el('p', 'error', `エラー: ${ev.message}`));
      for (const bubble of state.turns.values()) bubble.classList.remove('typing');
      break;
    case 'done':
      state.source?.close();
      setStatus(null);
      $('cancelBtn').hidden = true;
      $('newBtn').hidden = false;
      break;
  }
  scrollToEnd();
}

// 討論の画面に切り替えてイベントの購読を始める。URL の # に ID を残し、再読み込みしても復帰できるようにする。
function openDebate(id) {
  state.debateId = id;
  location.hash = id;
  $('setup').hidden = true;
  $('arena').hidden = false;
  let received = false;
  state.source = new EventSource(`/api/debates/${id}/events`);
  state.source.onmessage = (msg) => {
    received = true;
    handleEvent(JSON.parse(msg.data));
  };
  state.source.onerror = () => {
    if (received) return;
    // サーバー再起動などで討論が残っていない場合は入力画面に戻る
    state.source.close();
    history.replaceState(null, '', location.pathname);
    $('setup').hidden = false;
    $('arena').hidden = true;
  };
}

$('setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  showFormError('');
  const settings = { model1: $('model1').value, model2: $('model2').value, maxRounds: Number($('maxRounds').value) };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  $('startBtn').disabled = true;
  try {
    const res = await fetch('/api/debates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: $('topic').value,
        ai1: JSON.parse(settings.model1),
        ai2: JSON.parse(settings.model2),
        stance1: $('stance1').value,
        stance2: $('stance2').value,
        maxRounds: settings.maxRounds,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    openDebate(body.id);
  } catch (err) {
    showFormError(err.message);
  } finally {
    $('startBtn').disabled = false;
  }
});

$('cancelBtn').addEventListener('click', () => {
  $('cancelBtn').disabled = true;
  fetch(`/api/debates/${state.debateId}/cancel`, { method: 'POST' });
});

$('newBtn').addEventListener('click', () => {
  history.replaceState(null, '', location.pathname);
  location.reload();
});

init()
  .then(() => {
    if (location.hash.length > 1) openDebate(location.hash.slice(1));
  })
  .catch((err) => showFormError(`初期化に失敗しました: ${err.message}`));
