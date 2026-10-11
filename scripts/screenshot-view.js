// Screenshot a full-page view (options | airdrops). usage: node scripts/screenshot-view.js <view> [out]
// Logs in with SITE_USER / SITE_PASSWORD from the environment when the site is password protected.
const { chromium } = require('playwright-core');
(async () => {
  const view = process.argv[2] || 'options';
  const out = process.argv[3] || `${__dirname}/../screenshot-${view}.png`;
  const base = process.env.BASE || 'http://localhost:8000';
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: +process.env.W || 1600, height: +process.env.H || 1000 } });
  await page.goto(`${base}/?view=${view}`, { waitUntil: 'domcontentloaded' });
  if (/\/login/.test(page.url())) {
    await page.fill('input[name=user]', process.env.SITE_USER || 'martin');
    await page.fill('input[name=password]', process.env.SITE_PASSWORD || '');
    await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
    await page.goto(`${base}/?view=${view}`, { waitUntil: 'domcontentloaded' });
  }
  if (process.env.SEED) await page.evaluate((s) => { localStorage.setItem('st.airdrop.track.v1', s); }, process.env.SEED);
  if (process.env.SEED) await page.reload({ waitUntil: 'domcontentloaded' });
  const sel = view === 'options' ? '#optOut table' : '#adOut table';
  await page.waitForSelector(sel, { timeout: 90000 }).catch(() => console.log('wait timeout'));
  if (process.env.ACT) await page.evaluate(process.env.ACT);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: out });
  console.log('saved', out);
  await browser.close();
})();
