// Runs the Copy-as-image checks in Chromium headless shell. Usage: node run.mjs [testName ...]
// Needs: bun, playwright-core (PLAYWRIGHT_CORE or /tmp/claude-1001/shot/node_modules/playwright-core).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const core = process.env.PLAYWRIGHT_CORE ?? "/tmp/claude-1001/shot/node_modules/playwright-core";
const { chromium } = await import(path.join(core, "index.mjs"));
const OUT = process.env.EVIDENCE ?? path.join(here, "evidence");
mkdirSync(OUT, { recursive: true });
const bundle = path.join(OUT, "harness.bundle.js");
execFileSync("bun", ["build", path.join(here, "harness.ts"), "--outfile", bundle, "--target", "browser"], { stdio: "inherit" });

const shellRoot = path.join(homedir(), ".cache/ms-playwright");
const shellDir = readdirSync(shellRoot).filter((d) => d.startsWith("chromium_headless_shell-")).sort().pop();
const exe = path.join(shellRoot, shellDir, "chrome-headless-shell-linux64/chrome-headless-shell");
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });

const ORIGIN = "https://dc.test";
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}#host{position:fixed;inset:0}</style></head><body><div id="host"></div><script type="module" src="/bundle.js"></script></body></html>`;

const results = [];
function check(test, name, ok, detail = "") {
  results.push({ test, name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${test} ${name}${detail ? " — " + detail : ""}`);
}
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

async function open(opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1600, height: 900 },
    deviceScaleFactor: 2,
    locale: opts.locale ?? "en-US",
    permissions: opts.permissions === null ? [] : ["clipboard-read", "clipboard-write"],
  });
  await context.route(`${ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/bundle.js") return route.fulfill({ contentType: "text/javascript", body: readFileSync(bundle) });
    return route.fulfill({ contentType: "text/html", body: PAGE });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${ORIGIN}/?slug=${opts.slug ?? "d1"}`);
  await page.waitForFunction((n) => document.querySelectorAll(".dc-board-frame").length >= n, opts.frames ?? (opts.slug === "d2" ? 1 : 2));
  const h = { page, context, errors };
  await ready(h);
  return h;
}
const frameOf = (page, id) => {
  const handle = page.locator(`[data-board=${id}] iframe`);
  return handle;
};
async function ready(h) {
  // every frame has run its runtime (the canvas flags it ready; the harness waits on the overlay host)
  for (let i = 0; i < 100; i++) {
    const ok = await h.page.evaluate(() => [...document.querySelectorAll(".dc-board-frame")].length > 0);
    if (ok && h.page.frames().filter((f) => f !== h.page.mainFrame()).length >= (await h.page.locator(".dc-board-frame").count())) break;
    await h.page.waitForTimeout(100);
  }
  await h.page.waitForTimeout(600);
  await recordSelections(h);
}
/** Log the selection messages each frame receives, so tests can see the elements the canvas selected. */
async function recordSelections(h) {
  for (const f of h.page.frames()) {
    if (f === h.page.mainFrame()) continue;
    await f.evaluate(() => {
      if (window.__sel) return;
      window.__sel = [];
      window.addEventListener("message", (e) => { if (e.data && e.data.type === "selection") window.__sel.push(e.data.dcIds); });
    }).catch(() => {});
  }
}
async function frameById(h, id) {
  const handle = await h.page.locator(`[data-board=${id}] iframe`).elementHandle();
  return handle.contentFrame();
}
async function state(h) {
  const boards = await h.page.$$eval(".dc-board.dc-selected", (n) => n.map((x) => x.dataset.board));
  const els = {};
  for (const id of ["a", "b"]) {
    const f = await frameById(h, id).catch(() => null);
    if (!f) continue;
    const log = await f.evaluate(() => window.__sel ?? []).catch(() => []);
    els[id] = log.length ? log[log.length - 1] : [];
  }
  // The selection-only copy lives in the right-click menu; "disabled" now means "nothing selected".
  const disabled = boards.length === 0 && Object.values(els).every((list) => list.length === 0);
  return { boards, els, disabled };
}
const copyBtn = (h) => h.page.locator("button[data-tip='Copy canvas as image'], button[data-tip='复制画布为图片']");
async function toastText(h, timeout = 20000) {
  await h.page.waitForSelector(".dc-toast", { timeout });
  return h.page.$eval(".dc-toast", (n) => n.textContent);
}
async function clearToast(h) { await h.page.evaluate(() => document.querySelector(".dc-toast")?.remove()); }
/** Copies the current selection through the right-click menu, opened on an item already selected. */
async function copyViaButton(h) {
  await clearToast(h);
  let s = await state(h);
  for (let i = 0; i < 20 && s.disabled; i++) { await h.page.waitForTimeout(100); s = await state(h); }
  if (s.boards.length) {
    await h.page.locator(`[data-board=${s.boards[0]}] .dc-board-label`).click({ button: "right", position: { x: 6, y: 6 } });
  } else {
    const [board, ids] = Object.entries(s.els).find(([, list]) => list.length);
    // Right-click the visible middle of the element: it may stick out of its artboard.
    const f = await frameById(h, board);
    const e = await f.locator(`[data-dc-id=${ids[ids.length - 1]}]`).boundingBox();
    const fr = await h.page.locator(`[data-board=${board}] iframe`).boundingBox();
    const x0 = Math.max(e.x, fr.x), x1 = Math.min(e.x + e.width, fr.x + fr.width);
    const y0 = Math.max(e.y, fr.y), y1 = Math.min(e.y + e.height, fr.y + fr.height);
    await h.page.mouse.click((x0 + x1) / 2, (y0 + y1) / 2, { button: "right" });
  }
  await h.page.locator(".dc-menu .dc-menu-pick", { hasText: /Copy as image|复制为图片/ }).click();
  return toastText(h);
}
/** The toolbar copies the whole canvas; used where every artboard is the selection anyway. */
async function copyCanvas(h) {
  await clearToast(h);
  await copyBtn(h).click();
  return toastText(h);
}
async function readClip(h) {
  await h.page.bringToFront();
  return h.page.evaluate(() => window.__h.read());
}
async function save(h, name) {
  const b64 = await h.page.evaluate(() => window.__h.b64());
  writeFileSync(path.join(OUT, name), Buffer.from(b64, "base64"));
}
const pxs = (h, pts) => h.page.evaluate((p) => p.map(([x, y]) => window.__h.px(x, y)), pts);
const clickEl = (h, board, dc, opts = {}) => frameById(h, board).then((f) => f.locator(`[data-dc-id=${dc}]`).click(opts));
const clickTitle = (h, board, opts = {}) => h.page.locator(`[data-board=${board}] .dc-board-label`).click({ position: { x: 6, y: 6 }, ...opts });
async function shot(h, name) { await h.page.screenshot({ path: path.join(OUT, name) }); }
async function setZoom(h, label) {
  for (let i = 0; i < 12; i++) {
    const cur = await h.page.$eval(".dc-zoom", (n) => n.textContent);
    if (cur === label) return;
    const target = parseInt(label);
    await h.page.locator(parseInt(cur) > target ? "button[data-tip='Zoom out']" : "button[data-tip='Zoom in']").click();
    await h.page.waitForTimeout(100);
  }
  throw new Error("zoom did not reach " + label);
}
const tests = {};

// ---- T7 selection states
tests.T7 = async () => {
  const h = await open();
  let s = await state(h);
  check("T7", "empty selection: button disabled", s.disabled && s.boards.length === 0);
  await clickTitle(h, "a");
  s = await state(h);
  check("T7", "title click selects artboard, button enabled", s.boards.join() === "a" && !s.disabled, JSON.stringify(s));
  await clickEl(h, "b", "hero", { modifiers: ["Shift"] });
  await h.page.waitForTimeout(150);
  s = await state(h);
  check("T7", "shift-click element in B adds it (2 items across artboards)", s.boards.join() === "a" && s.els.b.join() === "hero", JSON.stringify(s));
  await clickEl(h, "b", "hero", { modifiers: ["Shift"] });
  await h.page.waitForTimeout(150);
  s = await state(h);
  check("T7", "shift-click again removes it", s.els.b.length === 0 && s.boards.join() === "a", JSON.stringify(s));
  await clickEl(h, "b", "wide");
  await h.page.waitForTimeout(150);
  s = await state(h);
  check("T7", "plain click replaces selection", s.boards.length === 0 && s.els.b.join() === "wide" && s.els.a.length === 0, JSON.stringify(s));
  // shift on a title adds the artboard
  await clickTitle(h, "a", { modifiers: ["Shift"] });
  s = await state(h);
  check("T7", "shift-click title adds artboard to element selection", s.boards.join() === "a" && s.els.b.join() === "wide", JSON.stringify(s));
  // Escape with focus in host
  await h.page.locator(".dc-root").focus();
  await h.page.keyboard.press("Escape");
  await h.page.waitForTimeout(150);
  s = await state(h);
  check("T7", "Escape (focus in host) clears", s.boards.length === 0 && s.els.b.length === 0 && s.disabled, JSON.stringify(s));
  // Escape with focus inside the frame
  await clickEl(h, "b", "hero");
  await h.page.waitForTimeout(100);
  await h.page.keyboard.press("Escape");
  await h.page.waitForTimeout(200);
  s = await state(h);
  check("T7", "Escape (focus in frame) clears", s.els.b.length === 0 && s.disabled, JSON.stringify(s));
  // click on empty canvas clears
  await clickTitle(h, "a");
  await h.page.mouse.click(800, 880);
  await h.page.waitForTimeout(150);
  s = await state(h);
  check("T7", "click on empty canvas clears", s.boards.length === 0 && s.disabled, JSON.stringify(s));
  // pan drag does not clear
  await clickTitle(h, "a");
  await h.page.mouse.move(800, 860);
  await h.page.mouse.down();
  await h.page.mouse.move(850, 870, { steps: 5 });
  await h.page.mouse.up();
  s = await state(h);
  check("T7", "background pan drag does not clear", s.boards.join() === "a", JSON.stringify(s));
  await h.errors.length && console.log("errors", h.errors);
  check("T7", "no console errors", h.errors.length === 0, h.errors.join("|"));
  await h.context.close();
};


const COMMENT = (id, dc) => ({ id, number: 1, status: "pending", body: "note", createdAt: "2026-01-01T00:00:00Z", anchor: { artboardId: "a", dcId: dc, path: "body", tag: "div", text: "", rect: { x: 20, y: 20, width: 100, height: 50 } } });
async function waitFrames(h, n) { await h.page.waitForFunction((k) => document.querySelectorAll(".dc-board-frame").length === k, n); await h.page.waitForTimeout(900); await recordSelections(h); }

// ---- T1 fidelity
tests.T1 = async () => {
  const h = await open({ slug: "d2" });
  const zoom = await h.page.$eval(".dc-zoom", (n) => n.textContent);
  check("T1", "d2 fits at 100%", zoom === "100%", zoom);
  await clickTitle(h, "a");
  const toast = await copyViaButton(h);
  check("T1", "toast copied", toast === "Copied as image", toast);
  const dims = await readClip(h);
  check("T1", "artboard A PNG is 800x600", dims.w === 800 && dims.h === 600, JSON.stringify(dims));
  const box = await h.page.evaluate(() => window.__h.colorBox([0, 255, 0]));
  check("T1", "10rem x 5rem box = 200x100 px at 2x (html font-size 10px)", box && box.w === 200 && box.h === 100, JSON.stringify(box));
  const shotBuf = await frameOf(h.page, "a").screenshot();
  writeFileSync(path.join(OUT, "T1-frame-screenshot.png"), shotBuf);
  await save(h, "T1-copy-A.png");
  const ref = await h.page.evaluate((b) => window.__h.loadRef(b), shotBuf.toString("base64"));
  check("T1", "reference screenshot is 800x600", ref.w === 800 && ref.h === 600, JSON.stringify(ref));
  const pts = [[350, 30], [700, 300], [760, 500], [140, 90], [450, 280], [450, 340], [100, 520], [620, 220]];
  const a = await h.page.evaluate((p) => p.map(([x, y]) => [window.__h.px(x, y), window.__h.pxRef(x, y)]), pts);
  const bad = a.filter(([x, y]) => !near(x, y, 8));
  check("T1", "8 sample pixels within +-8 of the live frame", bad.length === 0, JSON.stringify(bad.length ? bad : a.map(([x]) => x)));
  const [vhIn, vhOut, mq, img] = await pxs(h, [[450, 280], [450, 320], [100, 520], [620, 220]]);
  check("T1", "50vh box ends at 150px (white inside 140, not at 160)", near(vhIn, [255, 255, 255, 255], 2) && !near(vhOut, [255, 255, 255, 255], 20), JSON.stringify([vhIn, vhOut]));
  check("T1", "@media (max-width:500px) applies (magenta)", near(mq, [255, 0, 255, 255], 2), JSON.stringify(mq));
  check("T1", "data: image drawn (red)", near(img, [255, 0, 0, 255], 4), JSON.stringify(img));
  await h.context.close();
};

// ---- T2 overlay excluded, T3 zoom independence
tests.T2 = async () => {
  const h = await open({ slug: "d2" });
  await clickTitle(h, "a");
  await copyViaButton(h);
  await readClip(h);
  await h.page.evaluate(() => window.__h.keepAsRef());
  // Everything the runtime can draw: pin, grid, hover, selection
  await h.page.evaluate(() => { const d = window.__fake.designs.d2; d.comments = [JSON.parse(JSON.stringify({ id: "c1", number: 1, status: "pending", body: "n", anchor: { artboardId: "a", dcId: "rem", path: "body", tag: "div", text: "", rect: { x: 20, y: 20, width: 100, height: 50 } } }))]; d.version++; });
  await h.page.waitForTimeout(1200);
  await h.page.locator(".dc-root").focus();
  await h.page.keyboard.press("Shift+G");
  await clickEl(h, "a", "rem");
  await clickEl(h, "a", "box", { trial: false });
  const f = await frameById(h, "a");
  await f.locator("[data-dc-id=rem]").hover();
  await h.page.waitForTimeout(300);
  await clickTitle(h, "a", { modifiers: ["Shift"] });
  await f.locator("[data-dc-id=rem]").hover();
  const live = await frameOf(h.page, "a").screenshot();
  writeFileSync(path.join(OUT, "T2-frame-with-overlays.png"), live);
  await copyViaButton(h);
  await readClip(h);
  await save(h, "T2-copy-with-overlays.png");
  const same = await h.page.evaluate(() => window.__h.equalToRef());
  check("T2", "copy with pin, grid, hover and selection drawn equals the clean copy", same.equal, JSON.stringify(same));
  await h.page.evaluate((b) => window.__h.loadRef(b), live.toString("base64"));
  const differs = await h.page.evaluate(() => !window.__h.equalToRef().equal);
  check("T2", "overlay really was on screen (live frame differs from the copy)", differs);
  await h.context.close();
};

tests.T3 = async () => {
  const h = await open({ slug: "d2" });
  await clickTitle(h, "a");
  await setZoom(h, "25%");
  await copyCanvas(h);
  const d1 = await readClip(h);
  await h.page.evaluate(() => window.__h.keepAsRef());
  await setZoom(h, "400%");
  await copyCanvas(h);
  const d2 = await readClip(h);
  check("T3", "both zooms give 800x600", d1.w === 800 && d1.h === 600 && d2.w === 800 && d2.h === 600, JSON.stringify([d1, d2]));
  const same = await h.page.evaluate(() => window.__h.equalToRef());
  check("T3", "pixel-equal at 25% and 400%", same.equal, JSON.stringify(same));
  await h.context.close();
};

tests.T4 = async () => {
  const h = await open({ slug: "d2" });
  await clickEl(h, "a", "box");
  await copyViaButton(h);
  const d = await readClip(h);
  check("T4", "component 120x48 -> 240x96", d.w === 240 && d.h === 96, JSON.stringify(d));
  const [c00, c11, c22, cEnd, cMid] = await pxs(h, [[0, 0], [1, 1], [2, 2], [239, 95], [120, 48]]);
  check("T4", "1px border is exactly 2 device px, black", near(c00, [0, 0, 0, 255], 2) && near(c11, [0, 0, 0, 255], 2) && near(cEnd, [0, 0, 0, 255], 2), JSON.stringify([c00, c11, cEnd]));
  check("T4", "inside the border is the fill (yellow), crisp", near(c22, [255, 255, 0, 255], 2) && near(cMid, [255, 255, 0, 255], 2), JSON.stringify([c22, cMid]));
  await save(h, "T4-component.png");
  await h.context.close();
};

tests.T5 = async () => {
  const h = await open({ slug: "d2" });
  await h.page.evaluate((html) => window.__fake.set("d2", "a", { html }), PAGE_A_CTRL());
  await waitFrames(h, 1);
  await clickTitle(h, "a");
  const toast = await copyViaButton(h);
  check("T5", "page text with U+000C and U+0008 copies", toast === "Copied as image", toast);
  const d = await readClip(h);
  const st = await h.page.evaluate(() => window.__h.stats());
  console.log("T5 px", JSON.stringify(await pxs(h, [[0, 0], [5, 5], [400, 300], [790, 590], [0, 599], [799, 0]])));
  check("T5", "PNG 800x600 and non-blank", d.w === 800 && d.h === 600 && st.diffPct > 1, JSON.stringify([d, st]));
  await h.context.close();
};
function PAGE_A_CTRL() { return `<!doctype html><html><body style="margin:0;background:#336699"><p style="color:#fff;font:24px sans-serif">A\u000cB\u0008C\u0001D</p><div data-dc-id="x" style="width:50px;height:50px;background:#f00"></div></body></html>`; }

tests.T6 = async () => {
  const h = await open();
  await h.page.evaluate(() => window.__fake.set("d1", "b", { html: `<!doctype html><html><body style="margin:0;background:#dddddd"><div style="height:25000px"></div></body></html>` }));
  await h.page.waitForTimeout(2000);
  await clickTitle(h, "b");
  const toast = await copyViaButton(h);
  check("T6", "toast reports the scale (82%)", /82%/.test(toast), toast);
  const d = await readClip(h);
  check("T6", "PNG ~1180x16384, side <= 16384, area <= 67,108,864", d.w >= 1178 && d.w <= 1182 && d.h === 16384 && d.w * d.h <= 67108864, JSON.stringify(d));
  const [near_bottom, top] = await pxs(h, [[200, d.h - 50], [200, 50]]);
  check("T6", "pixel 50px above the bottom is painted (not blank)", near_bottom[3] === 255 && near(near_bottom, [221, 221, 221, 255], 3), JSON.stringify([near_bottom, top]));
  await h.context.close();
};

// ---- T8, T9, T10, T11, T12, T13
tests.T8 = async () => {
  const h = await open();
  await clickTitle(h, "a");
  await copyViaButton(h);
  const a = await readClip(h);
  await h.page.evaluate(() => window.__h.keepAsRef());
  await clickEl(h, "a", "rem", { modifiers: ["Shift"] });
  await h.page.waitForTimeout(150);
  const s = await state(h);
  check("T8", "selection holds the artboard and its component", s.boards.join() === "a" && s.els.a.join() === "rem", JSON.stringify(s));
  await copyViaButton(h);
  const b = await readClip(h);
  const same = await h.page.evaluate(() => window.__h.equalToRef());
  check("T8", "copy equals the A-only copy (component deduped)", a.w === b.w && a.h === b.h && same.equal, JSON.stringify([a, b, same]));
  await h.context.close();
};

tests.T9 = async () => {
  const h = await open();
  await clickTitle(h, "a");
  await clickEl(h, "b", "hero", { modifiers: ["Shift"] });
  await h.page.waitForTimeout(150);
  const toast = await copyViaButton(h);
  const d = await readClip(h);
  check("T9", "composite is 1212x600", d.w === 1212 && d.h === 600, JSON.stringify([d, toast]));
  const alpha = await h.page.evaluate(() => window.__h.alpha(820, 0, 180, 600));
  check("T9", "gap between the two is transparent (alpha 0)", alpha === 0, "max alpha " + alpha);
  const [inA, inHero] = await pxs(h, [[100, 500], [1112, 90]]);
  check("T9", "artboard region and component region both painted", inA[3] === 255 && near(inHero, [255, 136, 0, 255], 3), JSON.stringify([inA, inHero]));
  await save(h, "T9-composite.png");
  await h.context.close();
};

tests.T19 = async () => {
  const h = await open();
  await h.page.waitForTimeout(300);
  check("T19", "toolbar button enabled with nothing selected", !(await copyBtn(h).isDisabled()));
  await clearToast(h);
  await copyBtn(h).click();
  const toast = await toastText(h);
  const d = await readClip(h);
  const width = await h.page.evaluate(() => {
    const boards = [...document.querySelectorAll(".dc-board")].map((n) => n.getBoundingClientRect());
    return boards.length;
  });
  check("T19", "toolbar copies every artboard: composite starts at A and ends at B's right edge (3872 wide)", d.w === 3872 && width === 2, JSON.stringify([d, toast]));
  check("T19", "selection unchanged by the canvas copy", (await state(h)).disabled);
  await save(h, "T19-canvas.png");
  await h.context.close();
};

tests.T10 = async () => {
  const h = await open();
  await clickTitle(h, "a");
  await h.page.evaluate(() => window.__fake.set("d1", "b", { x: 60000, y: 32 }));
  await h.page.waitForTimeout(1200);
  await h.page.mouse.move(800, 600);
  for (let i = 0; i < 6; i++) {
    const box = await h.page.locator("[data-board=b] .dc-board-label").boundingBox();
    if (box.x > 20 && box.x < 1400 && box.y > 60 && box.y < 850) break;
    await h.page.mouse.wheel(box.x - 700, box.y - 400);
    await h.page.waitForTimeout(200);
  }
  await clickTitle(h, "b", { modifiers: ["Shift"] });
  const s = await state(h);
  check("T10", "A and B both selected", s.boards.length === 2, JSON.stringify(s));
  const toast = await copyCanvas(h);
  const d = await readClip(h);
  check("T10", "copy succeeds with a scale percentage in the toast", /scaled to \d+%/.test(toast), toast);
  check("T10", "PNG side <= 16384 and area <= 67,108,864", d.w <= 16384 && d.h <= 16384 && d.w * d.h <= 67108864 && d.w > 1000, JSON.stringify(d));
  await h.context.close();
};

tests.T11 = async () => {
  const h = await open();
  await clickTitle(h, "a");
  await clickEl(h, "b", "wide", { modifiers: ["Shift"] });
  await h.page.waitForTimeout(150);
  await h.page.evaluate(() => window.__fake.remove("d1", "a"));
  await h.page.waitForTimeout(1500);
  let s = await state(h);
  check("T11", "deleting A leaves only B's element selected", s.boards.length === 0 && s.els.b.join() === "wide" && !s.disabled, JSON.stringify(s));
  const toast = await copyViaButton(h);
  const d = await readClip(h);
  check("T11", "copy still works (400x160)", toast === "Copied as image" && d.w === 400 && d.h === 160, JSON.stringify([toast, d]));
  await h.page.evaluate(() => window.__fake.set("d1", "b", {}));
  await h.page.waitForTimeout(1800);
  s = await state(h);
  check("T11", "reloading B drops its entries; button disabled", s.disabled, JSON.stringify(s));
  check("T11", "no console errors", h.errors.length === 0, h.errors.join("|"));
  await h.context.close();
};

tests.T12 = async () => {
  const h = await open();
  await h.page.evaluate(() => window.__fake.add("d1", { id: "c", title: "Broken C", file: "c.html", width: 300, height: 200, html: null, error: "file missing", version: "1" }));
  await h.page.waitForSelector(".dc-board-error");
  await clickTitle(h, "c");
  await clickTitle(h, "a", { modifiers: ["Shift"] });
  const toast = await copyViaButton(h);
  check("T12", "toast copies and names the skipped artboard", /Copied as image/.test(toast) && /Broken C/.test(toast), toast);
  const d = await readClip(h);
  check("T12", "PNG holds the ready artboard only (800x600)", d.w === 800 && d.h === 600, JSON.stringify(d));
  await clickTitle(h, "c");
  const t2 = await copyViaButton(h);
  check("T12", "only an unready artboard -> 'Nothing selected is loaded yet'", t2 === "Nothing selected is loaded yet", t2);
  const d2 = await readClip(h);
  check("T12", "clipboard unchanged", d2.w === 800 && d2.h === 600, JSON.stringify(d2));
  // A frame that never answers
  await (await frameById(h, "a")).evaluate(() => { window.Image = function () { return { set src(v) {} }; }; });
  await clickTitle(h, "a");
  const started = Date.now();
  const t3 = await copyViaButton(h);
  const took = Date.now() - started;
  check("T12", "silent frame -> copyTimeout after ~15s, no hang", t3 === "The artboard didn't answer" && took > 14000 && took < 19000, `${t3} after ${took}ms`);
  await h.context.close();
};

tests.T13 = async () => {
  let h = await open({ permissions: null });
  await clickTitle(h, "a");
  let toast = await copyViaButton(h);
  check("T13", "no clipboard permission -> copyFailed toast with a reason", /^Couldn't copy the image: .+/.test(toast), toast);
  let s = await state(h);
  check("T13", "selection kept after failure", s.boards.join() === "a" && !s.disabled, JSON.stringify(s));
  await h.context.close();
  h = await open();
  await clickTitle(h, "a");
  await h.page.evaluate(() => Object.defineProperty(navigator.clipboard, "write", { configurable: true, value: async () => { throw new DOMException("Write permission denied.", "NotAllowedError"); } }));
  toast = await copyViaButton(h);
  check("T13", "write rejecting with NotAllowedError -> reason in toast", toast === "Couldn't copy the image: Write permission denied.", toast);
  await h.page.evaluate(() => delete navigator.clipboard.write);
  toast = await copyViaButton(h);
  const d = await readClip(h);
  check("T13", "retry after granting succeeds", toast === "Copied as image" && d.w === 800, JSON.stringify([toast, d]));
  await h.context.close();
};


const MENU = "[data-testid=design-canvas-context-menu]";
const menuOpen = (h) => h.page.locator(MENU).count().then((n) => n > 0);
async function rightClickEl(h, board, dc, opts = {}) { const f = await frameById(h, board); await f.locator(`[data-dc-id=${dc}]`).click({ button: "right", ...opts }); await h.page.waitForTimeout(250); }

tests.T14 = async () => {
  const h = await open();
  await rightClickEl(h, "b", "hero");
  let s = await state(h);
  check("T14", "right-click element outside selection selects it alone and opens the menu", s.els.b.join() === "hero" && (await menuOpen(h)), JSON.stringify(s));
  const hb = await (await h.page.locator("[data-board=b] iframe").elementHandle()).boundingBox();
  const mb = await h.page.locator(MENU).boundingBox();
  const zoom = parseInt(await h.page.$eval(".dc-zoom", (n) => n.textContent)) / 100;
  const px = hb.x + (10 + 50) * zoom, py = hb.y + (20 + 25) * zoom;
  check("T14", "menu opens at the pointer", Math.abs(mb.x - px) < 14 && Math.abs(mb.y - py) < 14, JSON.stringify({ mb, px, py }));
  await shot(h, "T14-context-menu.png");
  await h.page.keyboard.press("Escape");
  check("T14", "Escape closes the menu", !(await menuOpen(h)));
  // inside a 2-item selection keeps it
  await clickTitle(h, "a");
  await clickEl(h, "b", "hero", { modifiers: ["Shift"] });
  await rightClickEl(h, "b", "hero");
  s = await state(h);
  check("T14", "right-click inside a 2-item selection keeps it", s.boards.join() === "a" && s.els.b.join() === "hero" && (await menuOpen(h)), JSON.stringify(s));
  await rightClickEl(h, "b", "wide");
  s = await state(h);
  check("T14", "right-click outside it replaces it", s.boards.length === 0 && s.els.b.join() === "wide", JSON.stringify(s));
  // click inside a focused frame closes
  const f = await frameById(h, "b");
  await f.locator("[data-dc-id=hero]").click();
  await h.page.waitForTimeout(200);
  check("T14", "click inside the frame closes the menu", !(await menuOpen(h)));
  // unnamed page area -> that artboard
  const fbox = await h.page.locator("[data-board=b] iframe").boundingBox();
  await h.page.mouse.click(fbox.x + 300 * zoom, fbox.y + 500 * zoom, { button: "right" });
  await h.page.waitForTimeout(250);
  s = await state(h);
  check("T14", "right-click on unnamed page area selects that artboard", s.boards.join() === "b" && (await menuOpen(h)), JSON.stringify(s));
  // outside host click closes
  await h.page.mouse.click(800, 880);
  await h.page.waitForTimeout(150);
  check("T14", "host outside click closes the menu", !(await menuOpen(h)));
  // title right-click
  await h.page.locator("[data-board=a] .dc-board-label").click({ button: "right", position: { x: 6, y: 6 } });
  await h.page.waitForTimeout(200);
  s = await state(h);
  check("T14", "right-click on artboard title selects it and opens the menu", s.boards.join() === "a" && (await menuOpen(h)), JSON.stringify(s));
  // Copy via menu closes it and copies
  await clearToast(h);
  await h.page.locator(`${MENU} button`).click();
  const toast = await toastText(h);
  const d = await readClip(h);
  check("T14", "menu item copies (800x600) and closes the menu", toast === "Copied as image" && d.w === 800 && !(await menuOpen(h)), JSON.stringify([toast, d]));
  // edge clamping
  await h.page.evaluate(() => {
    const r = document.querySelector(".dc-viewport").getBoundingClientRect();
    document.querySelector("[data-board=a] .dc-board-label").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.right - 2, clientY: r.bottom - 2 }));
  });
  await h.page.waitForTimeout(200);
  const vp = await h.page.locator(".dc-viewport").boundingBox();
  const m2 = await h.page.locator(MENU).boundingBox();
  check("T14", "menu at the bottom-right corner stays inside the viewport", m2.x >= vp.x + 3 && m2.y >= vp.y + 3 && m2.x + m2.width <= vp.x + vp.width - 3 && m2.y + m2.height <= vp.y + vp.height - 3, JSON.stringify({ m2, vp }));
  await h.page.keyboard.press("Escape");
  // Preview keeps native behaviour
  await h.page.locator(".dc-root").focus();
  await h.page.keyboard.press("p");
  await h.page.waitForTimeout(200);
  const prevented = await f.evaluate(() => { const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); document.body.dispatchEvent(e); return e.defaultPrevented; });
  check("T14", "Preview: native context menu untouched, no host menu", prevented === false && !(await menuOpen(h)));
  check("T14", "no console errors", h.errors.length === 0, h.errors.join("|"));
  await h.context.close();
};

tests.T15 = async () => {
  const h = await open({ slug: "d2" });
  const calls = () => h.page.evaluate(() => window.__fake.calls.map((c) => c.kind));
  const f = await frameById(h, "a");
  const box = await f.locator("[data-dc-id=rem]").boundingBox();
  await h.page.mouse.move(box.x + 20, box.y + 20);
  await h.page.mouse.down();
  await h.page.mouse.move(box.x + 50, box.y + 40, { steps: 6 });
  await h.page.mouse.up();
  await h.page.waitForTimeout(600);
  check("T15", "element drag writes once", (await calls()).join() === "move", (await calls()).join());
  await h.page.keyboard.press("Control+z");
  await h.page.waitForTimeout(600);
  check("T15", "Ctrl+Z from inside the frame undoes (second write)", (await calls()).join() === "move,move", (await calls()).join());
  await h.page.keyboard.press("Control+Shift+z");
  await h.page.waitForTimeout(600);
  check("T15", "redo writes again", (await calls()).length === 3, (await calls()).join());
  // arrow nudge
  await h.page.evaluate(() => (window.__fake.calls.length = 0));
  await f.locator("[data-dc-id=vh]").click();
  await h.page.keyboard.press("ArrowRight");
  await h.page.waitForTimeout(500);
  await h.page.keyboard.press("Shift+ArrowDown");
  await h.page.waitForTimeout(500);
  const mv = await h.page.evaluate(() => window.__fake.calls.map((c) => c.args[2]));
  check("T15", "arrow nudges 1px and Shift+arrow 10px", JSON.stringify(mv) === JSON.stringify([{ left: "201px", top: "0px" }, { left: "201px", top: "10px" }]), JSON.stringify(mv));
  // text edit
  await h.page.evaluate(() => (window.__fake.calls.length = 0));
  await f.locator("[data-dc-id=txt]").dblclick();
  await h.page.waitForTimeout(200);
  await h.page.keyboard.type("Bye");
  await h.page.keyboard.press("Enter");
  await h.page.waitForTimeout(500);
  const te = await h.page.evaluate(() => window.__fake.calls.map((c) => [c.kind, c.args[2]]));
  check("T15", "double-click text edit + Enter writes the text", JSON.stringify(te) === JSON.stringify([["text", "Bye"]]), JSON.stringify(te));
  // board title drag
  await h.page.evaluate(() => (window.__fake.calls.length = 0));
  const lb = await h.page.locator("[data-board=a] .dc-board-label").boundingBox();
  await h.page.mouse.move(lb.x + 6, lb.y + 6);
  await h.page.mouse.down();
  await h.page.mouse.move(lb.x + 66, lb.y + 46, { steps: 6 });
  await h.page.mouse.up();
  await h.page.waitForTimeout(500);
  check("T15", "artboard title drag moves the artboard", (await calls()).join() === "board", (await calls()).join());
  // pin click opens the popover
  await h.page.evaluate(() => { const d = window.__fake.designs.d2; d.comments = [{ id: "c1", number: 1, status: "pending", body: "n", anchor: { artboardId: "a", dcId: "rem", path: "body", tag: "div", text: "", rect: { x: 20, y: 20, width: 100, height: 50 } } }]; d.version++; });
  await h.page.waitForTimeout(1500);
  const fb = await frameOf(h.page, "a").boundingBox();
  const z = parseInt(await h.page.$eval(".dc-zoom", (n) => n.textContent)) / 100;
  // the element was moved (left/top changes) by the earlier drag/undo/redo: aim at the pin's anchor
  const rb = await f.locator("[data-dc-id=rem]").boundingBox();
  await h.page.mouse.click(rb.x + rb.width, Math.max(rb.y, fb.y + 14 * z));
  await h.page.waitForTimeout(300);
  check("T15", "pin click in Move opens the comment popover", (await h.page.locator(".dc-popover").count()) === 1);
  // tools clear selection
  await h.page.keyboard.press("Escape");
  await clickTitle(h, "a");
  await h.page.locator(".dc-root").focus();
  await h.page.keyboard.press("h");
  await h.page.waitForTimeout(200);
  let s = await state(h);
  check("T15", "switching tool (H) clears the selection", s.boards.length === 0 && s.disabled, JSON.stringify(s));
  await h.page.keyboard.press("v");
  await h.context.close();
  // design switch clears
  const g = await open();
  await clickTitle(g, "a");
  await g.page.locator(".dc-picker").click();
  await g.page.locator(".dc-menu-pick", { hasText: "Two" }).click();
  await g.page.waitForTimeout(1200);
  s = await state(g);
  check("T15", "switching designs clears the selection", s.boards.length === 0 && s.disabled, JSON.stringify(s));
  await g.context.close();
};

tests.T16 = async () => {
  for (const [locale, tip, width] of [["en-US", "Copy canvas as image", 360], ["en-US", "Copy canvas as image", 1600], ["zh-CN", "复制画布为图片", 360], ["zh-CN", "复制画布为图片", 1600]]) {
    const h = await open({ viewport: { width, height: 800 }, locale });
    const b = await h.page.locator(`button[data-tip='${tip}']`).boundingBox();
    check("T16", `${locale} @${width}: copy button visible with tooltip '${tip}'`, b && b.x >= 0 && b.x + b.width <= width && b.height > 20, JSON.stringify(b));
    if (width === 360) {
      await clickTitle(h, "a");
      await h.page.evaluate(() => Object.defineProperty(navigator.clipboard, "write", { configurable: true, value: async () => { throw new Error("x".repeat(300)); } }));
      await copyBtn(h).click();
      await toastText(h);
      const tb = await h.page.locator(".dc-toast").boundingBox();
      check("T16", `${locale} @360: long copyFailed reason wraps inside the toast`, tb.x >= 0 && tb.x + tb.width <= 360 && tb.height > 40, JSON.stringify(tb));
    }
    await h.page.screenshot({ path: path.join(OUT, `T16-${locale}-${width}.png`) });
    await h.context.close();
  }
};

const SOLO = (body, css = "") => `<!doctype html><html><head><style>${css}</style></head><body>${body}</body></html>`;
async function soloCopy(h, html, select) {
  await h.page.evaluate((x) => window.__fake.set("d2", "a", { html: x }), html);
  await waitFrames(h, 1);
  await select();
  const toast = await copyViaButton(h);
  return { toast, d: await readClip(h) };
}

tests.T17 = async () => {
  // R-blocker 1: a viewport-relative component on a fixed-height artboard
  let h = await open({ slug: "d2" });
  let r = await soloCopy(h, SOLO('<div style="height:700px"></div><div data-dc-id="g" style="position:absolute;left:150px;top:50vh;width:100px;height:30px;background:#0f0"></div>', "body{margin:0;background:#fff}"), () => clickEl(h, "a", "g"));
  let [c] = await pxs(h, [[100, 30]]);
  check("T17", "50vh component on 400x300 with a 700px spacer: 200x60, green centre", r.d.w === 200 && r.d.h === 60 && near(c, [0, 255, 0, 255], 3), JSON.stringify([r, c]));
  await save(h, "T17-vh-component.png");
  await h.context.close();
  // blocker 2: a component crossing the artboard's left edge
  h = await open({ slug: "d2" });
  r = await soloCopy(h, SOLO('<div data-dc-id="e" style="position:absolute;left:-20px;top:10px;width:120px;height:48px;background:#f00"></div>', "body{margin:0;background:#fff}"), () => clickEl(h, "a", "e", { position: { x: 90, y: 24 } }));
  const [out, inn] = await pxs(h, [[10, 48], [100, 48]]);
  check("T17", "component at left:-20px: 240x96, whole box red (cropped part included)", r.d.w === 240 && r.d.h === 96 && near(out, [255, 0, 0, 255], 3) && near(inn, [255, 0, 0, 255], 3), JSON.stringify([r, out, inn]));
  await save(h, "T17-edge-component.png");
  await h.context.close();
  // blocker 2b: a component larger than the frame is tiled whole
  h = await open({ slug: "d2" });
  r = await soloCopy(h, SOLO('<div data-dc-id="big" style="position:absolute;left:0;top:0;width:900px;height:700px;background:linear-gradient(90deg,#f00,#00f)"></div>', "body{margin:0}"), () => clickEl(h, "a", "big", { position: { x: 50, y: 50 } }));
  const [t1, t2, t3] = await pxs(h, [[10, 10], [1790, 1390], [900, 1000]]);
  check("T17", "900x700 component on a 400x300 frame: 1800x1400, no seams or blank tiles", r.d.w === 1800 && r.d.h === 1400 && t1[3] === 255 && t2[3] === 255 && t3[3] === 255 && t1[0] > 240 && t2[2] > 240, JSON.stringify([r.d, t1, t2, t3]));
  await h.context.close();
  // blocker 3: a grid document root
  h = await open({ slug: "d2" });
  r = await soloCopy(h, SOLO("", "html{display:grid;place-items:center;height:100%;background:#fff}body{margin:0;width:50px;height:50px;background:#f00}"), () => clickTitle(h, "a"));
  const [mid, corner] = await pxs(h, [[400, 300], [20, 20]]);
  const live = await (await frameById(h, "a")).evaluate(() => { const r = document.body.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
  check("T17", "grid html root: copy centre is red like the live frame", r.d.w === 800 && r.d.h === 600 && near(mid, [255, 0, 0, 255], 3) && near(corner, [255, 255, 255, 255], 3) && Math.abs(live[0] - 200) < 2 && Math.abs(live[1] - 150) < 2, JSON.stringify([r.d, mid, corner, live]));
  await save(h, "T17-grid-root.png");
  await h.context.close();
};

tests.T18 = async () => {
  const h = await open();
  await h.page.locator("[data-board=a] .dc-board-label").click({ button: "right", position: { x: 6, y: 6 } });
  await h.page.waitForTimeout(200);
  await clearToast(h);
  await h.page.locator(`${MENU} button`).click();
  await toastText(h);
  let s = await state(h);
  check("T18", "after the menu copy the artboard is selected", s.boards.join() === "a" && !s.disabled, JSON.stringify(s));
  await h.page.keyboard.press("Escape");
  s = await state(h);
  check("T18", "Escape right after copying from the menu clears the selection", s.boards.length === 0 && s.disabled, JSON.stringify(s));
  check("T18", "no console errors", h.errors.length === 0, h.errors.join("|"));
  await h.context.close();
};

for (const name of (process.argv.length > 2 ? process.argv.slice(2) : Object.keys(tests))) {
  try { await tests[name](); } catch (e) { check(name, "threw", false, String(e.stack ?? e)); }
}
await browser.close();
writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
