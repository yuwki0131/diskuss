// ローカルにインストールされた AI CLI (claude / codex / copilot) を
// 非対話モードで呼び出すためのラッパー。
// どの CLI もツール無効・空の作業ディレクトリで実行し、純粋なテキスト生成器として使う。
import { spawn, execFile } from 'node:child_process';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const OBSERVER = { provider: 'claude', model: 'claude-fable-5-1', label: 'Claude Fable 5.1' };

const CALL_TIMEOUT_MS = 10 * 60 * 1000;

const FALLBACK_MODELS = {
  claude: [
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ],
  codex: [{ id: '', label: 'Codex 既定モデル' }],
  copilot: [{ id: '', label: 'Copilot 既定モデル' }],
};

let workDirPromise;
// CLI がリポジトリの中身を読まないよう、空の一時ディレクトリで実行する
function workDir() {
  workDirPromise ??= mkdtemp(join(tmpdir(), 'diskuss-'));
  return workDirPromise;
}

async function isInstalled(cmd) {
  try {
    await execFileP(cmd, ['--version'], { timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

async function codexModels() {
  try {
    const raw = await readFile(join(homedir(), '.codex', 'models_cache.json'), 'utf8');
    const data = JSON.parse(raw);
    const list = (Array.isArray(data) ? data : data.models ?? [])
      .filter((m) => m && m.slug && m.visibility !== 'hide')
      .map((m) => ({ id: m.slug, label: m.display_name || m.slug }));
    if (list.length) return [...FALLBACK_MODELS.codex, ...list];
  } catch {}
  return FALLBACK_MODELS.codex;
}

async function copilotModels() {
  try {
    const { stdout } = await execFileP('copilot', ['help', 'config'], { timeout: 20000 });
    const lines = stdout.split('\n');
    const start = lines.findIndex((l) => /^\s*`model`:/.test(l));
    const list = [];
    for (let i = start + 1; start >= 0 && i < lines.length; i++) {
      const m = lines[i].match(/^\s*-\s*"([^"]+)"\s*$/);
      if (!m) break;
      list.push({ id: m[1], label: m[1] });
    }
    if (list.length) return [...FALLBACK_MODELS.copilot, ...list];
  } catch {}
  return FALLBACK_MODELS.copilot;
}

// UI に出す選択肢。インストールされていない CLI は available: false になる。
export async function listProviders() {
  const [claudeOk, codexOk, copilotOk] = await Promise.all(['claude', 'codex', 'copilot'].map(isInstalled));
  return [
    { id: 'claude', label: 'Claude Code', available: claudeOk, models: FALLBACK_MODELS.claude },
    { id: 'codex', label: 'Codex CLI', available: codexOk, models: codexOk ? await codexModels() : FALLBACK_MODELS.codex },
    { id: 'copilot', label: 'GitHub Copilot CLI', available: copilotOk, models: copilotOk ? await copilotModels() : FALLBACK_MODELS.copilot },
  ];
}

function buildCommand(provider, model, system, prompt) {
  switch (provider) {
    case 'claude':
      return {
        cmd: 'claude',
        args: [
          '-p',
          ...(model ? ['--model', model] : []),
          '--system-prompt', system,
          '--tools', '',
          '--strict-mcp-config',
          '--disable-slash-commands',
          '--no-session-persistence',
          '--output-format', 'stream-json',
          '--include-partial-messages',
          '--verbose',
        ],
        stdin: prompt,
      };
    case 'codex':
      return {
        cmd: 'codex',
        args: [
          'exec',
          ...(model ? ['-m', model] : []),
          '--skip-git-repo-check',
          '--ephemeral',
          '-s', 'read-only',
          '--color', 'never',
          '--json',
          '-',
        ],
        stdin: `${system}\n\n${prompt}`,
      };
    case 'copilot':
      return {
        cmd: 'copilot',
        args: [
          '-p', `${system}\n\n${prompt}`,
          ...(model ? ['--model', model] : []),
          '-s',
          '--no-color',
          '--no-custom-instructions',
          '--no-ask-user',
          '--disable-builtin-mcps',
          '--available-tools=',
          '--output-format', 'json',
        ],
        stdin: '',
      };
    default:
      throw new Error(`未対応のプロバイダです: ${provider}`);
  }
}

// 各 CLI の JSONL イベントから本文を取り出す。
// delta: 逐次テキスト / full: 確定した全文 / error: CLI が報告したエラー
function parseEvent(provider, ev) {
  if (provider === 'claude') {
    if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
      return { delta: ev.event.delta.text };
    }
    if (ev.type === 'result') {
      return ev.is_error ? { error: String(ev.result ?? ev.subtype ?? 'unknown error') } : { full: ev.result };
    }
  } else if (provider === 'codex') {
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') return { message: ev.item.text };
    if (ev.type === 'error') return { error: ev.message };
    if (ev.type === 'turn.failed') return { error: ev.error?.message ?? 'turn failed' };
  } else if (provider === 'copilot') {
    if (ev.type === 'assistant.message_delta') return { delta: ev.data?.deltaContent };
    if (ev.type === 'assistant.message') return { message: ev.data?.content };
    if (ev.type === 'session.error' || ev.type === 'error') return { error: ev.data?.message ?? ev.message ?? 'unknown error' };
  }
  return {};
}

// CLI を 1 回呼び出して応答テキストを返す。onDelta があればストリーミングで通知する。
export async function callModel({ provider, model, system, prompt, onDelta, signal }) {
  const { cmd, args, stdin } = buildCommand(provider, model, system, prompt);
  const cwd = await workDir();

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let streamed = '';
    let deltaSinceMessage = false;
    const messages = [];
    let full = null;
    let cliError = null;
    let stderr = '';
    let buf = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      child.kill('SIGTERM');
      finish(reject, new Error('中断されました'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error(`${cmd} の応答がタイムアウトしました`));
    }, CALL_TIMEOUT_MS);

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort);

    const handleLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      const r = parseEvent(provider, ev);
      if (r.delta) {
        streamed += r.delta;
        deltaSinceMessage = true;
        onDelta?.(r.delta);
      }
      if (r.message) {
        // delta を出さない CLI (codex) は、確定メッセージをまとめて通知する
        if (!deltaSinceMessage) {
          const piece = (streamed ? '\n\n' : '') + r.message;
          streamed += piece;
          onDelta?.(piece);
        }
        messages.push(r.message);
        deltaSinceMessage = false;
      }
      if (r.full != null) full = r.full;
      if (r.error) cliError = r.error;
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', (err) => finish(reject, new Error(`${cmd} を起動できません: ${err.message}`)));
    child.on('close', (code) => {
      handleLine(buf);
      const text = (full ?? (messages.length ? messages.join('\n\n') : streamed)).trim();
      if (cliError && !text) return finish(reject, new Error(`${cmd}: ${cliError}`));
      if (!text) {
        const detail = stderr.trim().split('\n').slice(-5).join('\n');
        return finish(reject, new Error(`${cmd} から応答を得られませんでした (exit ${code})${detail ? `\n${detail}` : ''}`));
      }
      finish(resolve, text);
    });

    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}
