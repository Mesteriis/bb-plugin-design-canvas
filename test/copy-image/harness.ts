// Test harness page: mounts the real canvas against a fake CanvasApi (the system boundary).
import { mountCanvas, type CanvasApi } from "../../client/canvas";
import { BB_THEME } from "../../client/styles";
import { t } from "../../client/i18n";

const PNG_RED = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

export const PAGE_A = `<!doctype html><html><head><style>
html{font-size:10px}
body{margin:0;min-height:100vh;background:linear-gradient(#ff0000,#0000ff);font-family:sans-serif;position:relative}
.r{position:absolute;left:20px;top:20px;width:10rem;height:5rem;background:#00ff00}
.v{position:absolute;left:200px;top:0;width:50px;height:50vh;background:#ffffff}
.m{position:absolute;left:0;top:250px;width:100px;height:20px;background:#000000}
@media (max-width:500px){.m{background:#ff00ff}}
.i{position:absolute;left:300px;top:100px;width:20px;height:20px}
.c{position:absolute;left:10px;top:200px;width:120px;height:48px;border:1px solid #000;box-sizing:border-box;background:#ffff00}
.t{position:absolute;left:140px;top:160px;font:20px sans-serif;color:#fff}
</style></head><body>
<div class="r" data-dc-id="rem"></div><div class="v" data-dc-id="vh"></div><div class="m" data-dc-id="mq"></div>
<img class="i" data-dc-id="img" src="data:image/png;base64,${PNG_RED}">
<div class="c" data-dc-id="box"></div><div class="t" data-dc-id="txt">Hello</div>
</body></html>`;

export const PAGE_B = `<!doctype html><html><head><style>
body{margin:0;background:#dddddd;font-family:sans-serif}
.h{position:absolute;left:10px;top:20px;width:100px;height:50px;background:#ff8800}
.s{height:700px}
.w{position:absolute;left:400px;top:300px;width:200px;height:80px;background:#0088ff}
</style></head><body><div class="h" data-dc-id="hero"></div><div class="w" data-dc-id="wide"></div><div class="s"></div></body></html>`;

interface Board { id: string; title: string; file: string; width: number; height?: number; x?: number; y?: number; html: string | null; error: string | null; version: string }
const fake = {
  designs: {
    d1: { title: "One", boards: [
      { id: "a", title: "Board A", file: "a.html", width: 400, height: 300, html: PAGE_A, error: null, version: "1" },
      { id: "b", title: "Board B", file: "b.html", width: 1440, html: PAGE_B, error: null, version: "1" },
    ] as Board[], comments: [] as unknown[], version: 1 },
    d2: { title: "Two", boards: [{ id: "a", title: "Solo A", file: "a.html", width: 400, height: 300, html: PAGE_A, error: null, version: "1" }] as Board[], comments: [] as unknown[], version: 1 },
  } as Record<string, { title: string; boards: Board[]; comments: unknown[]; version: number }>,
  calls: [] as Array<{ kind: string; args: unknown[] }>,
  /** Edit a board of a design and bump versions so the canvas reloads what changed. */
  set(slug: string, id: string, patch: Partial<Board>) {
    const d = this.designs[slug]!;
    const b = d.boards.find((x) => x.id === id)!;
    Object.assign(b, patch);
    b.version = String(Number(b.version) + 1);
    d.version++;
  },
  remove(slug: string, id: string) {
    const d = this.designs[slug]!;
    d.boards = d.boards.filter((b) => b.id !== id);
    d.version++;
  },
  add(slug: string, board: Board) {
    const d = this.designs[slug]!;
    d.boards.push(board);
    d.version++;
  },
};
(window as any).__fake = fake;

function view(slug: string) {
  const d = fake.designs[slug]!;
  return {
    slug,
    manifest: { version: 1, title: d.title, kind: "prototype", artboards: d.boards.map((b) => ({ id: b.id, title: b.title, file: b.file, width: b.width, ...(b.height ? { height: b.height } : {}) })) },
    error: null,
    artboards: d.boards.map((b) => ({ id: b.id, title: b.title, file: b.file, width: b.width, ...(b.height ? { height: b.height } : {}), ...(b.x !== undefined ? { x: b.x, y: b.y } : {}), html: b.html, error: b.error, version: b.version, source: "s" + b.version })),
    comments: d.comments,
    tweakValues: {},
    version: String(d.version),
  } as any;
}

const api: CanvasApi = {
  listDesigns: async () => ({ initialized: true, designs: Object.entries(fake.designs).map(([slug, d]) => ({ slug, title: d.title, kind: null, artboards: d.boards.length, openComments: 0, error: null })), version: "l" }),
  getDesign: async (slug) => view(slug),
  getDesignVersion: async (slug) => String(fake.designs[slug]!.version),
  addComment: async () => { throw new Error("n/a"); },
  updateComment: async () => { throw new Error("n/a"); },
  deleteComment: async () => {},
  markSent: async () => {},
  moveElement: async (slug, id, dcId, style) => { fake.calls.push({ kind: "move", args: [id, dcId, style] }); return { source: "s", version: "self" + fake.calls.length }; },
  editText: async (slug, id, target, before, after) => { fake.calls.push({ kind: "text", args: [id, before, after] }); return { source: "s", version: "self" + fake.calls.length }; },
  saveTweaks: async () => ({ values: {}, versions: {} }),
  moveArtboard: async (slug, id, pos) => { fake.calls.push({ kind: "board", args: [id, pos] }); const b = fake.designs[slug]!.boards.find((x) => x.id === id)!; if (pos) { b.x = pos.x; b.y = pos.y; } else { delete b.x; delete b.y; } },
  sendToAgent: async () => {},
  startDesign: async () => {},
  renameDesign: async () => {},
  deleteDesign: async () => "",
  exportDesign: async () => ({ fileName: "x.zip", base64: "" }),
  importDesign: async () => ({ slug: "x", title: "x", kept: [] }),
  pickZip: async () => null,
};

const params = new URLSearchParams(location.search);
const host = document.getElementById("host")!;
(window as any).__canvas = mountCanvas({ host, t, api, theme: BB_THEME, initialSlug: params.get("slug") ?? "d1", onSlugChange: () => {}, pollMs: 300 });

// In-page pixel helpers: read the clipboard's PNG and measure it.
const h: any = ((window as any).__h = {});
h.read = async () => {
  const items = await navigator.clipboard.read();
  const item = items[0]!;
  const type = item.types.find((x) => x === "image/png");
  if (!type) return { error: "no png: " + item.types.join(",") , count: items.length };
  const blob = await item.getType("image/png");
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width; c.height = bmp.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(bmp, 0, 0);
  h.img = { c, ctx, blob, w: bmp.width, h: bmp.height };
  return { w: bmp.width, h: bmp.height, count: items.length, types: item.types };
};
h.px = (x: number, y: number) => Array.from(h.img.ctx.getImageData(x, y, 1, 1).data);
h.pxRef = (x: number, y: number) => Array.from(h.ref.ctx.getImageData(x, y, 1, 1).data);
h.alpha = (x: number, y: number, w: number, hh: number) => { const d = h.img.ctx.getImageData(x, y, w, hh).data; let max = 0; for (let i = 3; i < d.length; i += 4) max = Math.max(max, d[i]!); return max; };
h.stats = () => {
  const { ctx, w, h: hh } = h.img;
  const d = ctx.getImageData(0, 0, w, hh).data;
  const corner = [d[0], d[1], d[2], d[3]];
  let diff = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 7) { n++; if (d[i] !== corner[0] || d[i+1] !== corner[1] || d[i+2] !== corner[2] || d[i+3] !== corner[3]) diff++; }
  return { diffPct: (diff / n) * 100, corner };
};
h.colorBox = (rgb: number[]) => {
  const { ctx, w, h: hh } = h.img;
  const d = ctx.getImageData(0, 0, w, hh).data;
  let x0 = w, y0 = hh, x1 = -1, y1 = -1;
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (d[i] === rgb[0] && d[i+1] === rgb[1] && d[i+2] === rgb[2] && d[i+3] === 255) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
  return x1 < 0 ? null : { w: x1 - x0 + 1, h: y1 - y0 + 1, x: x0, y: y0 };
};
h.b64 = async () => { const buf = new Uint8Array(await h.img.blob.arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000)); return btoa(s); };
h.loadRef = async (b64: string) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i); const bmp = await createImageBitmap(new Blob([u], { type: "image/png" })); const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height; const ctx = c.getContext("2d")!; ctx.drawImage(bmp, 0, 0); h.ref = { ctx, w: bmp.width, h: bmp.height }; return { w: bmp.width, h: bmp.height }; };
h.equalToRef = () => { const a = h.img.ctx.getImageData(0, 0, h.img.w, h.img.h).data; const b = h.ref.ctx.getImageData(0, 0, h.ref.w, h.ref.h).data; if (a.length !== b.length) return { equal: false, why: "size" }; let bad = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 0) bad++; return { equal: bad === 0, bad }; };
// Keep this image as the reference for a later comparison
h.keepAsRef = () => { h.ref = { ctx: h.img.ctx, w: h.img.w, h: h.img.h }; };
