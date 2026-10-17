// X 侧可见性探针：起壳 + 喂真实 repos + 挂 25s，期间外部 GetImage 读球带
const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const WORK = '/home/hy/WorkBuddy/2026-10-17-12-49-03/.workbuddy';
const TMP = path.join(WORK, 'tmp');
const ELECTRON = path.join(WORK, 'electron-runtime', 'node_modules', 'electron', 'dist', 'electron');
const e = { ...process.env };
delete e.ELECTRON_RUN_AS_NODE; delete e.NODE_OPTIONS;
e.BRANCH_ORBS_HTML = path.join(ROOT, 'shell', 'orbs.html');
e.BRANCH_ORBS_USER_DATA = fs.mkdtempSync(path.join(TMP, 'ud-'));
e.BRANCH_ORBS_LOG = '/var/tmp/bo-tmp/xprobe-shell.log';
e.BRANCH_ORBS_TEST = '1';
e.TMPDIR = TMP;
const REPOS = [
  { root: '/x/proj', name: 'proj', branch: 'main', changed: 3, added: 42, deleted: 7, ahead: 2, behind: 0,
    lastCommit: { subject: 'probe', when: 'now', author: 'hy' }, isActive: true },
];
(async () => {
  const app = await electron.launch({
    cwd: ROOT, executablePath: ELECTRON,
    args: ['shell', '--ozone-platform=x11', '--no-sandbox', '--disable-dev-shm-usage'],
    env: e,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(700);
  await app.evaluate(({}, r) => {
    global.__orbsDriver({ type: 'config', cfg: { dock: 'bottom', size: 30, gap: 8, sink: 0.32, offset: 0, showCard: true, drag: true } });
    global.__orbsDriver({ type: 'repos', repos: r });
  }, REPOS);
  await page.waitForTimeout(2500);
  console.log('PROBE_READY window=' + JSON.stringify((await app.evaluate(() => global.__orbsState())).bounds));
  await page.waitForTimeout(45000); // 挂住给外部读 X
  await app.close();
  console.log('DONE');
})().catch((err) => { console.error(err); process.exit(1); });
