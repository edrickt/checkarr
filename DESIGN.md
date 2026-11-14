# DESIGN.md

Checkarr's visual authority. Operate surface: neutral, dense, precise. No decorative
world — a tool that disappears into the task. This file replaced the previous
ad-hoc styling in the "clean UI" pass.

## Direction

A quiet, utilitarian control panel. One system sans, square edges, hairline rules,
and status color as the only color. Hierarchy comes from type weight, spacing, and
alignment — never from boxes, shadows, gradients, or icon decoration. If a structure
needs a card to be readable, the structure is wrong; use a section rule instead.

Restraint is the commitment. Do not add a hero, an accent color, a logo mark, an
illustration, or motion beyond state feedback.

## Tokens

Use Tailwind's neutral ramp; do not introduce other grays.

| Token                   | Value         | Use                                                  |
| ----------------------- | ------------- | ---------------------------------------------------- |
| Surface                 | `white`       | page and table background                            |
| Recessed                | `neutral-50`  | page-level section bands, table header hover, panels |
| Rule                    | `neutral-200` | dividing lines, table row separators                 |
| Control border          | `neutral-300` | inputs, selects, secondary buttons                   |
| Ink                     | `neutral-900` | headings, primary text, primary button fill          |
| Body                    | `neutral-700` | table values, control labels                         |
| Secondary               | `neutral-600` | descriptions, metadata values                        |
| Muted                   | `neutral-500` | labels, table headers, timestamps (≥4.5:1 — never    |
| `neutral-400` for text) |
| Disabled ink            | `neutral-400` | disabled text only                                   |
| Focus                   | `neutral-900` | 2px outline, 2px offset, on every control            |
| Danger                  | `red-700`     | destructive text, solid confirm button               |

Status colors (dot + optional text, nothing else):

- corrupt `red-600` · suspect `amber-600` · unreachable `violet-600` ·
  missing `sky-600` · purged `fuchsia-600` · unchecked `neutral-400` ·
  healthy `emerald-600`

Rules: no gradients, no colored left borders, no shadows on static content. Shadows
only on overlays (menu, modal, toast), with an offset and soft blur — e.g.
`shadow-[0_8px_24px_-16px_rgb(0,0,0,0.35)]`.

## Type

One family (Tailwind default system stack). Fixed rem scale, ratio ≈1.15.

| Role            | Class                                         |
| --------------- | --------------------------------------------- |
| Page title      | `text-xl font-semibold tracking-tight` (20px) |
| Section title   | `text-sm font-semibold` (14px)                |
| Body / controls | `text-sm` (14px)                              |
| Meta / labels   | `text-xs` (12px)                              |
| Table header    | `text-xs font-medium text-neutral-500`        |

Sentence case everywhere, including table headers and section titles. No uppercase
tracking labels. Numbers in tables use tabular figures (`tabular-nums` on `body` already).
Max two type sizes per component.

## Spacing and layout

- Page container: `mx-auto max-w-6xl px-6 py-8` (header uses the same container).
- Section rhythm: `space-y-10` between page sections; heading to content `12px`
  (`space-y-3`), never the reverse.
- Section = heading row + optional description + content, separated from the next
  section by whitespace only (a `border-t` rule is allowed at the top of a section
  when the sections are dense).
- Table rows: `h-11`, `px-3`, `border-b border-neutral-100`.
- Controls align on a shared height: inputs/selects/buttons `h-8` (sm) or `h-9` (md);
  never mixed heights in one row. Radius: none. Square is the system.

## Components

**Button** (`ui/Button.tsx`). Variants:
`primary` solid `neutral-900`/white; `default` white + `neutral-300` border;
`ghost` borderless, `neutral-600`, `hover:bg-neutral-100`; `danger` solid `red-700`/white
(only final confirm); `dangerOutline` white + `neutral-300` border, `red-700` text and
hover border (destructive triggers in tables and rows). Sizes `sm`/`md`. Every variant
carries `focus-visible:outline-2 outline-offset-2 outline-neutral-900`, a pressed
`active:` background, and disabled at `opacity-40`.

**Input / Select** (`ui/controls.tsx`): `neutral-300` border, white bg, keyboard focus
uses the global 2px `:focus-visible` ring (never `outline-none`), focused border
`neutral-900`; same heights as buttons; placeholder `neutral-500`.

**Menu** (`ui/Menu.tsx`): portal, fixed, white, `neutral-200` border, soft shadow,
items `py-2 text-sm` with optional one-line description in `neutral-500`; danger item
`red-700`; chevron drawn as a 2px SVG (no unicode glyph). Escape / outside click /
arrow keys already handled — preserve.

**Modal** (`ui/Modal.tsx`): centered, white, `neutral-200` border, soft shadow,
`p-5`; max widths per use (detail `max-w-3xl`, confirm `max-w-md`). Header row with
title + close; actions grouped in one row (left-aligned in the detail view). No rounded
corners.

**Toast**: bottom-right, white + `neutral-200` border, kind shown by a leading status
dot and text color (`red-700` for errors), dismiss button; error toasts persist.

**ErrorBanner**: `border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800`.
Query-load errors only; mutation results are toasts.

**Toggle**: square switch (`h-5 w-9`, white square knob, no shadow), `neutral-900`
when on, `neutral-300` border when off, label outside the control. Keep accessible
name.

**Status**: dot + label, label in `neutral-600`, dot in the status color; the dot is
the only color. Counts may use the status text color when they are the focus of the
row (dashboard status rows). Dots are not icons and never replace text.

**Icons**: authored inline SVG, 1.5px stroke, 14px box, currentColor. No emoji or
unicode glyphs as icons. If a control needs an icon that cannot be drawn in one path,
use a text label instead.

## Navigation and shell

- Sticky top bar, 56px, white, `border-b border-neutral-200`, same container.
  Left: wordmark `Checkarr` (`text-[15px] font-semibold tracking-tight`) then tabs.
  Tabs: 14px, `neutral-600`, active `neutral-900 font-medium` with a 2px
  `neutral-900` underline; inactive `hover:text-neutral-900`.
  Right: scan state (running chip or `N files`) in `text-xs text-neutral-500`.
- Scan progress lives in a second row of the header while active: state, counts,
  full-width 2px progress track (`neutral-900` fill), percent, Cancel (dangerOutline, sm).
- Tab switches are hash routes; keep.

## Screen IA

### Dashboard — guided sequence (top to bottom)

1. **Page header**: title "Library health"; subtitle with checked/total and last
   check ("22 of 26 files checked · last scan 2h ago" — exact copy can vary); right:
   library scope `Select` ("All libraries" + source names).
2. **Scan section** (the primary action, first thing after the header):
   - Row: primary `Scan library ▾` (DropdownButton with the scan scopes + everything,
     counts and descriptions in items), then secondary `Sync library`.
   - A one-line explanation of what a scan does. While a scan runs the buttons are
     disabled and the persistent header strip carries the state, counts and cancel.
3. **Needs attention**: corrupt / suspect / unreachable as rows:
   `dot + label + count | one-line meaning | Review (ghost link) | Delete & re-search
(dangerOutline, disabled at 0)`. Section-level overflow menu (kebab, text label
   "More") holds the rare "Delete everything in scope…" action with confirm.
4. *_Waiting on the *arr*_: missing / purged as rows:
   `dot + label + count | meaning | Review | Search now` (default button; disabled at 0).
   This is where purged items become searchable. Missing and purged are separate rows
   so the search action is explicit about what it targets.
5. **Library**: unchecked and healthy counts as a compact two-item line, each linking to
   the filtered library; total tracked.
6. **Footer**: one compact last-scan line (when, scope, files, issues — or "No scan has
   run yet") followed by the "How checks work" `<details>`.
7. **No sources**: replace the sections with a setup block: numbered steps (add source →
   sync → scan), one primary "Add a source" action. No cards.

All counts are click-through links to the Library with that status and the current
library scope. Keep the scope in the hash.

### Library

- Toolbar row: search input (flex-grow, `Search title or path`), status select, source
  select, then result count right. Controls share height.
- Table: sticky header, hairline rows, status dot+label, title with muted subtitle,
  quality, size, duration, source, checked (relative with absolute title). Numeric
  columns right-aligned with tabular figures. Sortable headers are buttons with a drawn
  caret, active column in `neutral-900`.
- Row click opens the detail modal; the actions menu stops propagation.
- Row menu: Details; Re-check now; **Search now** (missing/purged only); Delete &
  re-search (only when the file is on disk: corrupt/suspect/unreachable/healthy/unchecked
  with a path). Disabled items carry a one-line reason.
- Footer: "1–50 of 2,400" + rows-per-page + Prev/Next.
- Empty states: filtered → "No files match" + `Clear filters` (ghost); no data → "No files
  yet — sync your libraries from the Dashboard" + link.
- While a scan runs the table may poll and show a quiet "Checking…" hint; do not add a
  second progress bar.

### File detail modal

Header: title, subtitle, status, Close. Body order: actions row (Search now for
missing/purged, Re-check now, Delete & re-search, Jump to middle only when playable)
→ non-playable explanation or player → metadata grid (status, source, quality, size,
duration, container, video, audio, checked) with 12px muted labels → path → ffmpeg
findings in a `neutral-50` code block with `neutral-600` mono text; error text `red-700`.
Square, no rounded corners.

### Settings

Four sections, each `text-sm font-semibold` heading + one-line muted description:

1. **Libraries** — source rows: type + name + URL, last sync (relative, error in
   `red-700`), enable toggle, actions `Test connection` / `Sync` / `Edit` / `Remove`
   (dangerOutline). Add-source form: labelled fields (Type, Name, URL, API key),
   primary "Add source". Editing expands in place with labelled fields and Save/Cancel.
2. **Checker** — Concurrency (1–32) with inline validation, ffmpeg path, ffprobe path,
   each with a visible label and a `text-xs text-neutral-500` help line; resolved
   binaries shown as a muted mono line that wraps.
3. **Path mappings** — explanation line, rows of From/To inputs with labelled columns
   and Remove; Add mapping.
4. **Network & server** — local broadcasting row (toggle + explanation + HOST warning),
   current listen address, Restart server (default) with confirm. Save changes at the
   end of the form that owns it (checker settings), disabled until dirty.

### Motion and states

Motion only for state: 150ms color/border transitions, 200ms progress width, 150ms
menu/modal fade (opacity + 2px translate). No page-load sequences, no staggered
reveals. Every control has hover, focus-visible, active, disabled, and loading
(in-button text change, e.g. "Scanning…") states. Loading content uses quiet
skeleton lines, not spinners.

### Accessibility

- All controls keyboard reachable; focus-visible ring everywhere; menus and modals
  already trap focus.
- Icon-only controls get `aria-label`. Sortable headers expose `aria-sort`. Status is
  never communicated by color alone (dot + label).
- Contrast: body and placeholder ≥4.5:1. `neutral-500` is the darkest muted text allowed.
- Tables have a caption or an accessible name; row actions name their row
  ("Actions for <title>").
