// Waits for the newest GitHub Actions run of the release workflow and prints the result (and failing step).
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const repo = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).updateRepo;
const token = fs.readFileSync(path.join(ROOT, '.github-token'), 'utf8').trim();
const api = async p => (await fetch(`https://api.github.com/repos/${repo}${p}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'PocketSignals' } })).json();
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const t0 = Date.now();
  // Only runs started at most 2 minutes before this script (the newest push), never an older finished one.
  const since = t0 - 2 * 60 * 1000;
  while (Date.now() - t0 < 15 * 60 * 1000) {
    const runs = await api('/actions/runs?per_page=5');
    const run = (runs.workflow_runs || []).find(r => new Date(r.created_at).getTime() >= since);
    if (run) {
      process.stdout.write(`\r${Math.round((Date.now() - t0) / 1000)}s  #${run.run_number} ${run.status} ${run.conclusion || ''}      `);
      if (run.status === 'completed') {
        console.log('\n' + run.html_url);
        const jobs = await api(`/actions/runs/${run.id}/jobs`);
        for (const j of jobs.jobs || []) for (const s of j.steps || []) console.log(`  ${s.conclusion === 'success' ? '✓' : s.conclusion === 'skipped' ? '-' : '✗'} ${s.name}`);
        process.exit(run.conclusion === 'success' ? 0 : 1);
      }
    }
    await sleep(15000);
  }
  console.log('\nZeitüberschreitung');
})();
