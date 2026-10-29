# Tasks view: UI design

Status: **reviewed; two items open (below)**. Design only; no data or indexer work yet.
Companion prototype: [tasks-ui-prototype.html](tasks-ui-prototype.html) (open in a
browser; desktop and Android layouts, clickable). Background:
[todo-view.md](todo-view.md), [frontend-views.md](frontend-views.md).

## Goals

- Every unchecked TODO from every doc is visible in one place, so none is forgotten.
- New TODOs need zero effort: they appear in an Inbox on their own.
- Triage is fast: one or two taps to give a TODO a date and/or priority.
- Looks native to AFFiNE (dark theme, `@affine/component` menu, checkbox,
  date-picker), uses TickTick only as a workflow reference.

## Entry points

| Platform | Placement                                                                                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop  | `Tasks` menu item directly below `Journals` in `components/root-app-sidebar/index.tsx` (new `TasksButton` next to `AppSidebarJournalButton`). Shows the Inbox count as a small badge when > 0. Route `/tasks`.                                                                        |
| Android  | New tab `tasks` in `mobile/components/app-tabs/data.tsx` that **replaces the `all` (All docs) tab** (order: home, journal, **tasks**, new). Route `/tasks`. Badge dot when Inbox > 0. All docs must stay reachable another way (home screen or search); check this when implementing. |

## Navigation inside Tasks

**Decision (proposed): desktop uses an inner left list; mobile uses a chip row.**

- Desktop: the AFFiNE sidebar already holds workspace navigation, so a second tab
  strip would be crowded. A 210px inner nav (as in TickTick) holds:
  Inbox, Today, Tomorrow, Next 7 Days, then a divider, then All tasks and
  Completed. Each shows an unchecked count (Completed shows its checked count). The nav is always visible.
- Mobile: no inner sidebar. A horizontally scrollable chip row under the title:
  Inbox, Today, Tomorrow, Next 7 Days, All, Done, each with a count. The chip
  row is sticky.

Count rules (unchecked tasks only, in non-trashed docs):

| View        | Contains                                                               |
| ----------- | ---------------------------------------------------------------------- |
| Inbox       | no date (any priority)                                                 |
| Today       | due today **or overdue** (overdue gets its own red group)              |
| Tomorrow    | due tomorrow                                                           |
| Next 7 Days | overdue + today + next 6 days, grouped by day                          |
| All tasks   | everything unchecked: Scheduled, Inbox                                 |
| Completed   | all checked tasks, newest completion first, grouped by completion date |

## Task row

```
[ ] Title of the todo (single line, ellipsis)            Tomorrow  ⚑
    ▢ Source doc › Heading above the block
```

- **Checkbox**: AFFiNE checkbox. Border colour encodes priority (none = grey,
  low = blue, medium = orange, high = red), as in TickTick.
- **Title**: plain text of the block. One line on desktop, up to two on mobile.
- **Source line**: doc icon, doc title, nearest heading above the block
  ("Project Kickoff › TODO"). Clicking it opens the doc scrolled to the block
  (`navigation/utils.ts` `blockIds`). This is the "link back to the page".
- **Right side**: date label (`Today`, `Tomorrow`, `Fri 30 Oct`, red `2d ago`
  when overdue; date only in v1), priority flag. In Inbox rows, hovering swaps
  these for two buttons: calendar and flag.
- Inbox groups rows **by source doc** (so the two "Project Kickoff" TODOs sit
  together), newest doc first. Other views group by date. Group headers are
  collapsible and the state is remembered per view.
- Row click opens the detail panel (desktop right panel, mobile bottom sheet).

## Setting a date or priority (triage)

One shared editor, shown in three places: hover popover (desktop Inbox), detail
panel (desktop), bottom sheet (mobile).

- **Date**: chips `Today`, `Tomorrow`, `Next Monday`, `In a week`, plus a date
  picker (reuse `@affine/component` `date-picker`) and `Clear`.
- **Priority**: chips High / Medium / Low / None.
- As soon as a date is set, the row leaves Inbox (a priority alone keeps it there). A toast says where
  it went ("Scheduled for Tomorrow · left Inbox") with **Undo** (5s).
- Keyboard (desktop, row focused): `T` today, `M` tomorrow, `D` date picker,
  `1`/`2`/`3` priority low/medium/high, `Space` toggle, `Enter` open detail.
  Arrow keys move between rows, so the Inbox can be cleared without the mouse.
- Mobile v1: tap row, tap a chip. Swipe actions are a later nicety.

## Toggling a checkbox

- Writes `checked` on the source list block through the `doc/` module, so the
  source doc updates and syncs like any other edit.
- The row stays where it is, shown **crossed off**, so the user can see that it
  was done. An Undo toast shows for 5s. Counts only count unchecked tasks, so
  they drop immediately.
- A completed task stays visible (crossed off, sorted below open tasks in its
  group) in Today, Tomorrow, Next 7 Days, All tasks and Inbox for as long as it
  is not in the past:
  - dated task: visible while its due date is today or later; once the due date
    has passed it disappears from those views, including Overdue (never shown
    as overdue once done);
  - undated task (Inbox): visible until the end of the day it was completed.
- Completed view lists every completed task, newest first, grouped by
  **completion date** ("Completed today", "Completed Tuesday, Oct 27"), with the
  original due date shown on the row.
- Unchecking reopens it in its normal view.
- Needs a stored `completedAt` date (see storage below).

## Detail panel

Desktop right panel (the workbench right sidebar, 320px default, resizable) or mobile bottom sheet: title, date and priority
editor, source box (doc, heading, **Open in doc**). The title is read-only in v1
(edit it in the doc); inline editing needs rich-text round-tripping and is
deferred.

## Add task

`+ Add task` field at the top of every view except Completed. Enter creates the
TODO in Inbox, with the date pre-filled when added from Today or Tomorrow.
On mobile a floating `+` opens a bottom sheet with the same field.

The new TODO is appended to a dedicated `Tasks` doc, auto-created on first use.
That doc is a data store only and is **hidden from the user**: excluded from All
docs, recents, search, favorites and the sidebar. Consequences:

- Rows from it show "Quick add" instead of a source doc link, and have no
  "Open in doc".
- Since the doc cannot be opened to edit, the **title of a quick-add task is
  editable inside the Tasks view** (plain text, detail panel / sheet). Titles of
  TODOs that live in real docs stay read-only in v1 and are edited in their doc.
- It is still a normal doc underneath (sync, backup); keep an escape hatch such
  as a "Show Tasks doc" toggle in settings in case the view breaks.

The field also understands the inline syntax below.

## Empty states

| Where                              | Illustration + copy                                                         | Action      |
| ---------------------------------- | --------------------------------------------------------------------------- | ----------- |
| Inbox (all triaged)                | "Inbox zero. Every checkbox from your docs has a date."                     | none        |
| Today                              | "Nothing due today. Enjoy it, or pull something in from the Inbox."         | Go to Inbox |
| Tomorrow / Next 7 Days             | "Nothing planned…"                                                          | Go to Inbox |
| All tasks (workspace has no TODOs) | "No tasks yet. Type `[ ]` in any doc to make a checkbox, or add one above." | Add a task  |
| Completed                          | "No completed tasks"                                                        | none        |
| Loading (indexer still syncing)    | skeleton rows, 3 groups                                                     | none        |
| Error / indexer not ready          | inline banner "Couldn't load tasks" + Retry                                 | Retry       |

## Where date and priority are stored

Decided: option A (see recommendation). All options keep `checked` on the existing list block.
Option A therefore adds three optional props: `due`, `priority` and
`completedAt` (date set when checked, cleared when unchecked; the Completed view
needs it, and `meta:updatedAt` is not reliable because any later edit changes it).

| Option                    | How                                                                                                           | Pros                                                                                                                                                                                            | Cons                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Block props**        | Add optional `due` (ISO date; time of day is out of scope for v1) and `priority` (0-3) props to `affine:list` | Travels with the block (move, copy, export, undo/redo). Already syncs to desktop and Android through Yjs. The indexer can read it straight off the block. Editor can render a date chip inline. | Model change in `blocksuite`; need to confirm unknown props survive on older clients and in import/export adapters; touches the shared editor. |
| **B. Side store**         | A workspace-level map keyed by `docId:blockId`                                                                | No block-model change; easy to ship and iterate.                                                                                                                                                | Orphans when blocks are deleted or copied; needs GC; invisible in the doc; extra sync surface; ids differ when a doc is duplicated.            |
| **C. Inline text syntax** | Parse `@tomorrow !high` out of the TODO text                                                                  | Fully portable (Markdown export is lossless); no model change.                                                                                                                                  | Fragile parsing, clutters the text, bad on mobile keyboards, hard to edit via UI.                                                              |

**Recommendation: A**, with `priority` and a date-only `due` first (time of day
later). It is the only option where the data cannot drift away from its block,
and it gives the best Android story. Verify before committing: a spike that
older clients keep the props on round trip.

## Inline text syntax as an input method

Requirement: while writing or editing a TODO title (in a doc or in the Add task
field), typing a token such as `@today` or `!high` is recognised, the token text
is removed, and the date or priority is set.

This does **not** change the storage recommendation. It is option C used as an
_input shortcut_ on top of option A: the token never persists in the text, it is
parsed into block props. Storage stays A.

Behaviour:

- Parsed when the token is completed (space or Enter after it) or on blur, only
  inside a `todo` list block. The token is deleted from the text and the props
  are set; the editor shows a small date/priority chip on the block.
- Date tokens: `today`, `tomorrow`, weekday names, `nextweek`, `+3d`,
  `YYYY-MM-DD`. Priority tokens: `!1` `!2` `!3` or `!low` `!med` `!high`.
- One undo step reverts both the props and restores the typed token.
- Same parser powers the Add task field, so `Call bank @tomorrow !high` files
  straight into Tomorrow.
- **Conflict to resolve**: in AFFiNE `@` already opens the mention / link-doc
  menu. Options: (1) extend that menu with a "Date" section (Today, Tomorrow, …)
  and parse only when the user picks it, (2) use a different trigger such as
  `//today`, or (3) parse a literal `@today` only when it is not selected from
  the menu. Recommendation: (1) for the editor, plus plain-text parsing in the
  Add task field where there is no mention menu.
- Scope: parsing inside the editor changes the shared `blocksuite` list block,
  so it is **postponed to v2**. v1 ships the Add task field parser (it is a plain
  input, so it is cheap) and the pickers. v2 adds in-editor parsing and the
  inline chip.

## Decisions

Confirmed by the user:

1. Add task writes into a dedicated, auto-created `Tasks` doc.
2. Date and priority are stored as block props (option A), with inline text
   syntax as an input method (see above).
3. Date only in v1, no time of day or reminders.
4. TODOs in trashed docs and template docs are excluded.

Proposed, not yet reviewed:

5. Tasks lives in the main sidebar under Journals, and as an Android tab replacing All docs.
6. Inner left nav on desktop, chip row on mobile.
7. Inbox = no date; setting a date removes it, a priority alone doesn't; undo toast.
8. Overdue is shown in Today and Next 7 Days as a red group.
9. Completing a task keeps it crossed off in its view until its date has passed; Completed view shows the completion date (user change).
10. Title is read-only in the Tasks view in v1, except quick-add tasks, whose doc is hidden.
11. Inbox grouped by source doc; other views by date.
12. Inline tokens in the editor are v2; the Add task field parser is v1 (user change).
13. The `Tasks` doc is hidden from All docs, search and sidebar (user change).
14. Undated completed Inbox tasks stay crossed off until the end of the day they were completed (confirmed).
15. Quick-add task titles are editable in the Tasks view (confirmed).

## Open questions

- Trigger for date tokens in the editor: extend the `@` menu, a new trigger, or
  literal `@today`?
- Before building: spike that older clients preserve the new block props.
