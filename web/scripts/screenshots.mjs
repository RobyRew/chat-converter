// Product screenshots for the landing page (web/public/img): the converter's workspace with a fictional chat, in the
// dark and light themes, desktop (1.5x) and phone (2x), rendered by Playwright's WebKit.
//
// Not part of the build. To regenerate after a UI change:
//   npm run build && npx astro preview --port 4326        (in web/)
//   npx -y playwright@1 install webkit                       (once, anywhere)
//   node scripts/screenshots.mjs http://127.0.0.1:4326 /tmp/shots
//   for f in /tmp/shots/*.png; do cwebp -q 80 -m 6 -sharp_yuv "$f" -o "public/img/$(basename "$f" .png).webp"; done
// Playwright is not a dependency of the site; run it from a folder where it is installed (NODE_PATH or a scratch
// package), as the build never needs it.
import { webkit } from 'playwright';
const BASE = process.argv[2] ?? 'http://127.0.0.1:4326';
const OUT = process.argv[3] ?? '/tmp/shots';
const chat = () => {
  const L = '‎';
  const p = (n) => String(n).padStart(2, '0');
  const at = (d, h, m) => `[${p(d)}/06/2026, ${p(h)}:${p(m)}:00]`;
  const rows = [
    [12, 18, 2, 'Maya Torres', 'Lisbon is booked!! Flights land at 10:40 on Friday'],
    [12, 18, 3, 'Leo Brandt', 'Amazing 🎉 I found a tiny place in Alfama with a terrace'],
    [12, 18, 3, 'Leo Brandt', 'Sending the photos now'],
    [12, 18, 4, 'Leo Brandt', `${L}<attached: 00000001-PHOTO-2026-06-12-18-04-00.jpg>`],
    [12, 18, 6, 'Maya Torres', 'That view 😍 book it before someone else does'],
    [12, 18, 7, 'Leo Brandt', 'Done. Also — tram 28 on Saturday morning?'],
    [12, 18, 9, 'Maya Torres', `${L}<attached: 00000002-AUDIO-2026-06-12-18-09-00.opus>`],
    [13, 9, 15, 'Maya Torres', 'Packing list:\nsunscreen\nthe good camera\nyour terrible hat'],
    [13, 9, 18, 'Leo Brandt', 'The hat stays. Non-negotiable 😎'],
    [13, 9, 19, 'Maya Torres', 'Fine. Pastéis de nata at the airport then'],
    [13, 9, 21, 'Leo Brandt', 'Deal 🥐'],
  ];
  return rows.map(([d, h, m, who, text]) => `${text.startsWith(L) ? L : ''}${at(d, h, m)} ${who}: ${text}`).join('\r\n') + '\r\n';
};
const browser = await webkit.launch();
for (const scheme of ['dark', 'light']) {
  for (const kind of ['desktop', 'phone']) {
    const profile = kind === 'desktop'
      ? { viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1.5 }
      : { viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
    const ctx = await browser.newContext({ ...profile, colorScheme: scheme });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('chat-converter-app[data-view="start"] .cc-drop');
    await page.evaluate(async (text) => {
      const el = document.querySelector('chat-converter-app');
      const photo = new Uint8Array(1_900_000);
      const voice = new Uint8Array(84_000);
      await el.load([
        { path: 'WhatsApp Chat - Maya Torres/_chat.txt', blob: new Blob([text]) },
        { path: 'WhatsApp Chat - Maya Torres/00000001-PHOTO-2026-06-12-18-04-00.jpg', blob: new Blob([photo]) },
        { path: 'WhatsApp Chat - Maya Torres/00000002-AUDIO-2026-06-12-18-09-00.opus', blob: new Blob([voice]) },
      ], 'WhatsApp Chat - Maya Torres');
    }, chat());
    await page.waitForSelector('.cc-app--work .cc-bubble');
    await page.waitForTimeout(900);
    const raw = await page.locator('.cc-app').boundingBox();
    // The phone shot starts a few px lower: the site header's shadow falls on the top edge of the frame.
    const box = kind === 'phone' ? { ...raw, y: raw.y + 4, height: raw.height - 4 } : raw;
    const file = `${OUT}/app-${kind}-${scheme}.png`;
    await page.screenshot({ path: file, clip: box });
    console.log(file, Math.round(box.width), 'x', Math.round(box.height));
    await ctx.close();
  }
}
await browser.close();
