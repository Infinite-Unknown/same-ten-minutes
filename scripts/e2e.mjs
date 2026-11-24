// End-to-end check of the built site, driven by keyboard only, the way a judge or a
// screen-reader user would. Run `npm run build && npm run preview -- --port 4173` first.
//
//   CHROME_PATH=/path/to/chrome node scripts/e2e.mjs [http://localhost:4173/] [out-dir]
//
// Saves screenshots of each step and fails on any console error.

import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:4173/';
const out = process.argv[3] ?? 'assets';
mkdirSync(out, { recursive: true });
const executablePath = process.env.CHROME_PATH;
if (!executablePath) {
  console.error('Set CHROME_PATH to a Chrome or Chromium binary.');
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath,
  // never touch the OS keychain
  args: ['--use-mock-keychain', '--password-store=basic', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(e.message));

let failed = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`);
  if (!ok) failed++;
};
const sentence = () => page.locator('#sentence').textContent();
const waitSentence = async (pred, ms = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = (await sentence()) ?? '';
    if (pred(s)) return s;
    await page.waitForTimeout(200);
  }
  return (await sentence()) ?? '';
};
/** press Tab until the focused element matches, up to n presses */
const tabTo = async (pred, n = 60) => {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(pred)) return true;
  }
  return false;
};

await page.goto(url);

// 1. first load plays the first sample place
let s = await waitSentence((x) => x.includes('%'));
check(/a wheelchair user reaches \d+% of the street/.test(s), `first load computes a result: "${s.slice(0, 90)}…"`);
const gap = await page.locator('#gap-num').textContent();
check(s.includes(`${gap}%`), `gap figure (${gap}%) matches the spoken sentence`);
await page.screenshot({ path: `${out}/01-first-load.png` });

// 2. keyboard: choose the second sample place
const chips = await page.locator('.chip').allTextContents();
check(chips.length >= 2, `sample places listed: ${chips.join(' | ')}`);
const second = chips[1].split(' ').slice(0, 2).join(' ');
check(await tabTo(`document.activeElement?.classList.contains('chip') && document.activeElement.textContent.startsWith(${JSON.stringify(second)})`), `Tab reaches the "${second}" chip`);
await page.keyboard.press('Enter');
s = await waitSentence((x) => x.includes(second.split(' ')[0]));
check(s.includes(second.split(' ')[0]), `Enter on the chip recomputes for ${second}`);
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/02-second-place.png` });

// 3. keyboard: apply the top fix
check(await tabTo(`document.activeElement?.classList.contains('fix')`), 'Tab reaches the first "Fix first" option');
const before = Number(await page.locator('#gap-num').textContent());
await page.keyboard.press('Enter');
s = await waitSentence((x) => x.startsWith('With '));
const after = Number(await page.locator('#gap-num').textContent());
check(s.startsWith('With ') && after >= before, `top fix applied: ${before}% -> ${after}%`);
check((await page.locator('.fix').first().getAttribute('aria-pressed')) === 'true', 'fix button reports aria-pressed=true');
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/03-top-fix.png` });

// 4. keyboard: change the time budget with arrow keys in the radio group
await page.focus('#b10');
await page.keyboard.press('ArrowRight');
s = await waitSentence((x) => x.includes('in 15 minutes'));
check(s.includes('in 15 minutes'), 'arrow key in the time group switches to 15 minutes and recomputes');
await page.screenshot({ path: `${out}/04-fifteen-minutes.png` });

// 5. keyboard: focus the map and drop the pin at its centre with Enter
await page.focus('.maplibregl-canvas');
await page.keyboard.press('ArrowUp');
await page.waitForTimeout(400);
await page.keyboard.press('Enter');
s = await waitSentence((x) => x.startsWith('From this spot'));
check(s.startsWith('From this spot'), 'Enter on the focused map drops the pin at the centre');
check(/#-?\d+\.\d+,-?\d+\.\d+,15/.test(page.url()), `the address holds the pin and budget: ${new URL(page.url()).hash}`);

// 6. the shared link restores the same result
const link = page.url();
const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page2.goto(link);
const t0 = Date.now();
let s2 = '';
while (Date.now() - t0 < 20000 && !s2.includes('%')) {
  s2 = (await page2.locator('#sentence').textContent()) ?? '';
  await page2.waitForTimeout(200);
}
check(s2 === s, 'opening the copied link reproduces the same sentence');
await page2.close();

check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' / ') : ''}`);
await browser.close();
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
