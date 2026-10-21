// Screenshot Martin's Calls (owner ⋯ menu). usage: BASE=http://localhost:8123 node scripts/screenshot-mycalls.js [out] [W]
// Logs in with SITE_USER / SITE_PASSWORD from the environment when the site is password protected. MOBILE=1 for a phone viewport.
const { chromium } = require('playwright-core');
(async () => {
  const out = process.argv[2] || `${__dirname}/../screenshot-mycalls.png`;
  const base = process.env.BASE || 'http://localhost:8000';
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage(process.env.MOBILE ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true } : { viewport: { width: +process.env.W || 1500, height: +process.env.H || 1100 } });
  await page.goto(`${base}/?view=mycalls`, { waitUntil: 'domcontentloaded' });
  if (/\/login/.test(page.url())) {
    await page.fill('input[name=user]', process.env.SITE_USER || 'martin');
    await page.fill('input[name=password]', process.env.SITE_PASSWORD || '');
    await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
    await page.goto(`${base}/?view=mycalls`, { waitUntil: 'domcontentloaded' });
  }
  await page.waitForSelector('#mcOut .mc', { timeout: 60000 }).catch(() => console.log('no cards (guest or no data)'));
  await page.waitForFunction(() => [...document.querySelectorAll('#mcOut .mcnow')].every((e) => e.textContent.trim() !== '…'), null, { timeout: 30000 }).catch(() => console.log('live price wait timeout'));
  if (process.env.OPEN) await page.evaluate(() => document.querySelectorAll('#viewMycalls details').forEach((d) => (d.open = true)));
  if (process.env.MENU) { await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500); await page.click('#ownerMenu .ownerbtn').catch(() => console.log('no owner menu')); }
  await page.waitForTimeout(1200);
  await page.screenshot({ path: out, fullPage: process.env.FULL === '1' });
  console.log('saved', out);
  await browser.close();
})();
