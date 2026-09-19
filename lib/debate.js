// 討論の進行: 立場の設定 → ラウンド制の討論 → オブザーバーによる収束判定 → 最終判定
import { callModel, OBSERVER } from './providers.js';

export const MIN_ROUNDS = 2;
export const DEFAULT_MAX_ROUNDS = 5;
export const MAX_ROUNDS_LIMIT = 10;

const SPEAKERS = ['AI1', 'AI2'];
// 討論者の呼び名。画面表示とプロンプトの両方で使う (内部のキーは AI1 / AI2 のまま)
export const NAMES = { AI1: 'プラトン', AI2: 'アリストテレス' };

// 討論者の口調の指定
const TONE =
  '文体は常体 (だ・である調) とし、敬語や「です・ます」は使わないでください。' +
  '「〜と思います」「〜ではないでしょうか」のような婉曲表現やクッション言葉は避け、言い切る断定口調で、歯切れよく論じてください。';

const OBSERVER_SYSTEM =
  'あなたは討論の公平なオブザーバー兼審判です。発言者がどのAIモデルであるかは考慮せず、議論の中身だけで判断します。' +
  '指示された JSON オブジェクトだけを出力し、前置きやコードフェンス、補足説明は一切付けません。';

function debaterSystem(name, opponent) {
  return (
    `あなたは討論者「${name}」です。与えられた立場から、相手「${opponent}」と日本語で討論します。` +
    '名前は単なる呼び名なので、その人物になりきる必要はありません。' +
    `${TONE}` +
    'ツールやファイル操作は使わず、発言本文だけを出力してください。見出し・話者名・前置きは不要です。'
  );
}

function formatTranscript(turns) {
  if (!turns.length) return '(まだ発言はありません)';
  return turns.map((t) => `【${NAMES[t.speaker]}・第${t.round}ラウンド】\n${t.text}`).join('\n\n');
}

function debaterPrompt({ topic, stances, speaker, round, maxRounds, turns }) {
  const me = stances[speaker];
  const opponent = speaker === 'AI1' ? 'AI2' : 'AI1';
  const isOpening = !turns.some((t) => t.speaker === speaker);
  const task = isOpening
    ? 'これはあなたの最初の発言です。自分の立場の中心となる主張と根拠を明確に述べてください。' +
      (turns.length ? '相手の直前の発言にも触れてください。' : '')
    : '相手の直前の発言に具体的に反論しつつ、自分の主張を補強してください。既出の論点の繰り返しは避け、新しい根拠・具体例・視点を加えてください。' +
      '相手の指摘が妥当な場合は部分的に認めて構いませんが、自分の立場は維持してください。';

  return [
    `# 議論テーマ\n${topic}`,
    `# あなた (${NAMES[speaker]}) の立場\n${me.position}\n${me.brief}`,
    `# 相手 (${NAMES[opponent]}) の立場\n${stances[opponent].position}`,
    `# これまでの議論\n${formatTranscript(turns)}`,
    `# 指示\n現在は第${round}ラウンド (最大${maxRounds}ラウンド) です。${task}\n${TONE}\n400字程度までで、発言本文だけを書いてください。`,
  ].join('\n\n');
}

function stancePrompt(topic, fixed) {
  const given = SPEAKERS.filter((s) => fixed[s]).map((s) => `${s} (${NAMES[s]}): ${fixed[s]}`);
  const fixedNote = given.length
    ? `\n\n# ユーザーが指定した立場 (position にそのまま使い、もう一方はこれと対立する立場にすること)\n${given.join('\n')}`
    : '';
  return `次の議論テーマについて、2人のAI (AI1「${NAMES.AI1}」と AI2「${NAMES.AI2}」) が討論します。名前は単なる呼び名で、立場の内容とは無関係です。討論が噛み合い、かつ実りあるものになるよう、互いに対立する2つの立場を設定してください。
賛否が分かれるテーマなら賛成/反対、選択肢を比べるテーマならそれぞれの選択肢、というようにテーマに合わせて決めます。どちらか一方が明らかに不利にならないようにしてください。

# 議論テーマ
${topic}${fixedNote}

# 出力形式 (この JSON だけを出力)
{"AI1": {"position": "立場を一文で", "brief": "その立場で重視すべき論点の指針を1〜2文で"}, "AI2": {"position": "...", "brief": "..."}}`;
}

function progressPrompt({ topic, stances, turns, round, maxRounds }) {
  return `以下の討論を観察し、議論が煮詰まったかどうかを判定してください。

「conclude」とするのは次のいずれかの場合です:
- 主要な論点が出尽くし、新しい論点や根拠がほとんど出なくなった
- 同じ主張の繰り返しになっている
- 両者の見解が実質的に収束した、または一方の優位が明確になった
まだ検討に値する重要な論点が残っている、あるいは直前の反論への応答が必要なら「continue」とします。

# 議論テーマ
${topic}

# 立場
${NAMES.AI1}: ${stances.AI1.position}
${NAMES.AI2}: ${stances.AI2.position}

# これまでの議論 (第${round}ラウンドまで終了 / 最大${maxRounds}ラウンド)
${formatTranscript(turns)}

# 出力形式 (この JSON だけを出力)
{"status": "continue または conclude", "reason": "判断理由を一文で"}`;
}

function verdictPrompt({ topic, stances, turns }) {
  return `以下の討論が終了しました。オブザーバーとして議論を総括し、どちらに軍配が上がったかを判定してください。
判定は主張の説得力、根拠の質、相手の反論への応答の的確さに基づいて行い、必ず${NAMES.AI1}か${NAMES.AI2}のどちらかを勝者にしてください (引き分けは不可)。
そのうえで、この討論を踏まえた議論テーマへの「一つの答え」を結論として示してください。

# 議論テーマ
${topic}

# 立場
${NAMES.AI1}: ${stances.AI1.position}
${NAMES.AI2}: ${stances.AI2.position}

# 討論の全記録
${formatTranscript(turns)}

# 出力形式 (この JSON だけを出力。各値は日本語のプレーンテキストで、文体は常体・断定口調)
{"summary": "議論の流れと主要な論点の要約 (300〜500字)", "ai1_evaluation": "${NAMES.AI1}の議論の強みと弱み", "ai2_evaluation": "${NAMES.AI2}の議論の強みと弱み", "winner": "${NAMES.AI1} または ${NAMES.AI2}", "reason": "勝敗を分けた決め手", "conclusion": "討論を踏まえたテーマへの最終的な答え"}`;
}

// モデルの出力から最初の JSON オブジェクトを取り出す
export function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('JSON が見つかりません');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('JSON が閉じていません');
}

async function askObserver(prompt, validate, signal) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = await callModel({ ...OBSERVER, system: OBSERVER_SYSTEM, prompt, signal });
    try {
      const data = extractJson(text);
      validate(data);
      return data;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`オブザーバーの出力を解釈できませんでした: ${lastError.message}`);
}

function validateStances(d) {
  for (const s of SPEAKERS) {
    if (typeof d?.[s]?.position !== 'string' || !d[s].position.trim()) throw new Error(`${s} の立場がありません`);
    d[s].brief = typeof d[s].brief === 'string' ? d[s].brief : '';
  }
}

function validateVerdict(d) {
  // 勝者は名前で返ってくるので内部のキー (AI1 / AI2) に直す
  const w = String(d?.winner ?? '').replace(/\s/g, '');
  const key = SPEAKERS.find((s) => w === NAMES[s] || w.toUpperCase() === s);
  if (!key) throw new Error('winner が討論者の名前ではありません');
  d.winner = key;
  if (typeof d.summary !== 'string' || !d.summary.trim()) throw new Error('summary がありません');
}

// 討論を最初から最後まで自動で進める。進行状況は emit(type, data) で通知する。
export async function runDebate({ topic, debaters, maxRounds, fixedStances = {}, emit, signal }) {
  let stances;
  if (SPEAKERS.every((s) => fixedStances[s])) {
    stances = Object.fromEntries(SPEAKERS.map((s) => [s, { position: fixedStances[s], brief: '' }]));
  } else {
    emit('phase', { phase: 'stances', message: 'オブザーバーが両者の立場を設定しています' });
    stances = await askObserver(stancePrompt(topic, fixedStances), validateStances, signal);
    for (const s of SPEAKERS) if (fixedStances[s]) stances[s].position = fixedStances[s];
  }
  emit('stances', { stances });

  const turns = [];
  let endReason = `最大ラウンド数 (${maxRounds}) に達しました`;

  for (let round = 1; round <= maxRounds; round++) {
    for (const speaker of SPEAKERS) {
      emit('turn_start', { speaker, round });
      const text = await callModel({
        ...debaters[speaker],
        system: debaterSystem(speaker, speaker === 'AI1' ? 'AI2' : 'AI1'),
        prompt: debaterPrompt({ topic, stances, speaker, round, maxRounds, turns }),
        onDelta: (delta) => emit('delta', { speaker, round, delta }),
        signal,
      });
      turns.push({ speaker, round, text });
      emit('turn_end', { speaker, round, text });
    }

    if (round >= MIN_ROUNDS && round < maxRounds) {
      emit('phase', { phase: 'checking', message: 'オブザーバーが議論の進み具合を確認しています' });
      let check;
      try {
        check = await askObserver(progressPrompt({ topic, stances, turns, round, maxRounds }), () => {}, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        check = { status: 'continue', reason: '進行判定に失敗したため続行します' };
      }
      const concluded = String(check.status).toLowerCase().includes('conclude');
      emit('observer_note', { round, concluded, reason: String(check.reason ?? '') });
      if (concluded) {
        endReason = String(check.reason ?? '議論が煮詰まりました');
        break;
      }
    }
  }

  emit('phase', { phase: 'verdict', message: 'オブザーバーが議論を総括し、判定しています' });
  const verdict = await askObserver(verdictPrompt({ topic, stances, turns }), validateVerdict, signal);
  emit('verdict', { verdict, endReason });
  return { topic, debaters, stances, turns, verdict, endReason };
}

export function toMarkdown({ topic, debaters, stances, turns, verdict, endReason }) {
  const name = (s) => `${NAMES[s]} (${debaters[s].provider}${debaters[s].model ? ` / ${debaters[s].model}` : ''})`;
  return [
    `# ${topic}`,
    `- ${name('AI1')}: ${stances.AI1.position}\n- ${name('AI2')}: ${stances.AI2.position}\n- オブザーバー: ${OBSERVER.label}`,
    '## 討論',
    ...turns.map((t) => `### ${NAMES[t.speaker]}・第${t.round}ラウンド\n\n${t.text}`),
    '## 判定',
    `**勝者: ${NAMES[verdict.winner]}**\n\n${verdict.reason ?? ''}`,
    `### サマリ\n\n${verdict.summary}`,
    `### 各者の評価\n\n- ${NAMES.AI1}: ${verdict.ai1_evaluation ?? ''}\n- ${NAMES.AI2}: ${verdict.ai2_evaluation ?? ''}`,
    `### 結論\n\n${verdict.conclusion ?? ''}`,
    `_討論終了の理由: ${endReason}_`,
  ].join('\n\n') + '\n';
}
