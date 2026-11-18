---
name: canvas
description: Draw UI designs as HTML artboards on the Design canvas, then revise them from the user's comments. Use when the user asks for a design, wireframe, prototype, mockup or screen, or runs /canvas.
---

# Design canvas

`/canvas` with nothing after it: call `design_open` so the canvas shows beside this chat, and say so in one line.
`/canvas <what to design>`: do steps 1 and 2 for that brief.

1. Start with `design_create` (slug, title, kind, artboards). It makes `design/<slug>/` with a placeholder page per artboard and opens the canvas; read `design/README.md` for the conventions.
2. Overwrite each placeholder with a complete, self-contained HTML page: local CSS, images and fonts only (the canvas blocks the network), and a `data-dc-id` on every element the user may move or comment on. Show 2 or 3 variants as artboards in one group when the request leaves room.
3. Expose values worth tuning with `design_set_tweaks`, each driving a CSS custom property the pages read, and link `tweaks.css` last in `<head>`.
4. The user comments on the canvas and sends the comments as one message. Revise the pages, then call `design_resolve_comments` with each comment and one line on what you changed.
5. `design_list` and `design_read` show what exists and what is still open.

If these tools are not available in this thread (a workspace that has not used the canvas yet), create `design/canvas.json` containing `{"version": 1}` and follow the file layout in `design/README.md` (write it from the layout above if it is missing). The tools appear in threads started after that.
