// watchdog.js - 守护"守护进程"的双保险（GitHub Actions cron 每 15 分钟跑）
// 独立于 CF Worker（opensea-watch）：
//   1. ping 主 Worker 的 /?key=...&mode=ping 端点
//   2. 连续 2 次无响应 → 判定主 Worker 失效 → 接管接力（dispatch 停摆 repo）+ TG 告警
//   3. 主 Worker 恢复后自动让位
// 通过 GitHub Actions 的 workflow 调度，与 CF 完全独立（CF 失效也能接管，停摆最多 ~30 分钟）
const fs = require('fs');

const MAIN_WORKER_URL = process.env.MAIN_WORKER_URL; // 含 ?key=...&mode=ping
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const GH_TOKENS = JSON.parse(process.env.GH_TOKENS || '{}'); // {账号: token}（GitHub 禁 GITHUB_ 前缀，用 GH_TOKENS）
const REPOS = JSON.parse(process.env.REPOS || '{}'); // {账号: [{c, repo}]}
const STATE_FILE = process.env.STATE_FILE || '/tmp/watchdog-state.json'; // GitHub Actions 用 /tmp

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) {}
}

async function api(method, url, token, body) {
  const opts = {
    method, headers: { 'Authorization': 'Bearer ' + token, 'User-Agent': 'opensea-watchdog', 'Accept': 'application/vnd.github+json' },
  };
  if (body) opts.headers['Content-Type'] = 'application/json';
  const r = await fetch(url, opts);
  return { status: r.status };
}

async function sendTG(text) {
  try {
    await fetch('https://api.telegram.org/bot' + TG_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text }),
    });
  } catch (e) {}
}

async function takeover() {
  let triggered = 0;
  for (const [account, token] of Object.entries(GH_TOKENS)) {
    const repoList = REPOS[account] || [];
    const checks = await Promise.all(repoList.map(async ({ c, repo }) => {
      try {
        const r = await fetch('https://api.github.com/repos/' + account + '/' + repo + '/actions/runs?per_page=1', {
          headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'opensea-watchdog' },
        });
        if (r.status !== 200) return { repo, need: false };
        const runs = await r.json();
        const run = (runs.workflow_runs || [])[0];
        if (!run) return { repo, need: true };
        if (run.status === 'in_progress' || run.status === 'pending' || run.status === 'queued') return { repo, need: false };
        if (run.status === 'completed') {
          if (run.conclusion === 'success') {
            const endMin = (Date.now() - new Date(run.updated_at).getTime()) / 60000;
            return { repo, need: endMin > 10 };
          }
          return { repo, need: true };
        }
        return { repo, need: false };
      } catch (e) {
        return { repo, need: false };
      }
    }));
    for (const { repo, need } of checks) {
      if (!need) continue;
      try {
        const st = await api('POST', 'https://api.github.com/repos/' + account + '/' + repo + '/actions/workflows/sell.yml/dispatches', token, { ref: 'main' });
        if (st.status === 204 || st.status === 201 || st.status === 200) triggered++;
      } catch (e) {}
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return triggered;
}

(async () => {
  const now = Date.now();
  let mainAlive = false;
  // 1. ping 主 Worker
  if (MAIN_WORKER_URL) {
    try {
      const r = await fetch(MAIN_WORKER_URL, { signal: AbortSignal.timeout(8000) });
      mainAlive = r.ok;
    } catch (e) { mainAlive = false; }
  }

  const state = loadState();
  const out = { alive: mainAlive };

  if (mainAlive) {
    // 主 Worker 存活：清零失败计数；若之前接管过则告知恢复
    state.failCount = 0;
    if (state.active === 1) {
      state.active = 0;
      await sendTG('✅ [watchdog] 主守护已恢复，备用守护让位');
    }
    out.action = 'main-alive';
  } else {
    // 主 Worker 无响应
    state.failCount = (state.failCount || 0) + 1;
    if (state.failCount >= 2) {
      // 连续 2 次（约 30 分钟）→ 接管接力
      const wasActive = state.active === 1;
      state.active = 1;
      const n = await takeover();
      if (!wasActive) await sendTG('🚨 [watchdog] 主守护失效！备用守护接管接力');
      if (n > 0) await sendTG('⚡ [watchdog] 接管完成：接力 ' + n + ' 个 repo');
      out.action = 'takeover';
      out.relayCount = n;
    } else {
      out.action = 'main-miss-' + state.failCount;
    }
  }
  saveState(state);
  console.log(JSON.stringify(out));
})();
