// Screenshot the Perp Desk News pulse strip + Grok news feed. usage: BASE=http://localhost:8130 node scripts/screenshot-grok.js [out]
const { chromium } = require('playwright-core');
(async () => {
  const out = process.argv[2] || `${__dirname}/../screenshot-grok.png`;
  const base = process.env.BASE || 'http://localhost:8130';
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  await page.goto(`${base}/?view=command`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#gkBody .gkrow', { timeout: 90000 }).catch(() => console.log('wait timeout'));
  await page.evaluate(() => { document.querySelector('#pdTabs button[data-t=ob]')?.click(); });
  await page.waitForTimeout(800);
  await page.evaluate(() => { const c = [...document.querySelectorAll('#gkPulse .gkchip[data-k]')].find((x) => /📰/.test(x.textContent)) || document.querySelector('#gkPulse .gkchip[data-k]'); c?.click(); document.querySelector('#gkBody .gkrow')?.click(); });
  await page.waitForTimeout(800);
  const pd = await page.$('#perpDesk'); await pd.scrollIntoViewIfNeeded();
  const a = await pd.boundingBox(); const b = await (await page.$('#grokNews')).boundingBox();
  await page.screenshot({ path: out, fullPage: true, clip: { x: 0, y: a.y, width: 1600, height: Math.min(2400, b.y + b.height - a.y) } });
  const g = await page.$('#grokNews'); await g.scrollIntoViewIfNeeded(); await page.waitForTimeout(300); await g.screenshot({ path: out.replace(/\.png$/, '-feed.png') });
  console.log('saved', out); await browser.close();
})();
