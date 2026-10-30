# Spec: Tasks view (cross-doc TODOs)

Status: **ready for agent**. Read [AGENTS.md](../../AGENTS.md) first. The UI
design this spec builds on is [tasks-ui-design.md](tasks-ui-design.md); its
clickable prototype is [tasks-ui-prototype.html](tasks-ui-prototype.html).
Code maps: [todo-view.md](todo-view.md), [indexer.md](indexer.md),
[frontend-views.md](frontend-views.md), [building-clients.md](building-clients.md).

## Problem Statement

The user writes checkbox TODOs wherever they happen to be working: meeting
notes, project pages, daily journals. Once the page is closed, the TODOs are
out of sight and forgotten. AFFiNE has no place that gathers TODOs from across
docs, and a TODO has no date or priority, so there is nothing to tell the user
what is due. Their earlier tool (TickTick) solved this with an Inbox of
untriaged tasks and Today / Tomorrow / Next 7 Days views. They want that
workflow without leaving AFFiNE or moving their TODOs out of their notes.

## Solution

A **Tasks** view, reached from the desktop sidebar directly below Journals and
from an Android bottom tab. It lists every unchecked TODO from every
non-trashed, non-template doc in the workspace.

- Every new TODO lands in **Inbox** on its own, with no date.
- The user **triages** each one by giving it a date (and optionally a
  priority). As soon as it has a date, it leaves Inbox; a priority alone keeps
  it in Inbox.
- **Today**, **Tomorrow** and **Next 7 Days** show dated tasks, with overdue
  tasks in a red group. **All tasks** shows every unchecked task, and
  **Completed** shows checked tasks by completion date.
- Ticking a task in the Tasks view ticks the checkbox in the source doc, and
  the other way round. Each task row links back to the exact block in its doc.
- A **+ Add task** field creates TODOs without opening a doc. They are stored
  in a hidden, auto-created `Tasks` doc.
- Date and priority are stored on the TODO block itself, so they sync to every
  device like any other doc edit.

## User Stories

### Finding tasks

1. As a note-taker, I want every checkbox TODO from every doc to appear in one Tasks view, so that I never lose a TODO inside a closed page.
2. As a note-taker, I want a Tasks entry directly below Journals in the desktop sidebar, so that I can reach it in one click.
3. As an Android user, I want a Tasks tab in the bottom tab bar (replacing All docs), so that I can reach my tasks with one tap.
4. As a user, I want All docs to stay reachable on Android after the tab is replaced, so that I lose no existing navigation.
5. As a user, I want the Tasks sidebar entry and tab to show a badge when Inbox is not empty, so that untriaged TODOs pull me back in.
6. As a user, I want TODOs from trashed docs left out, so that deleted work doesn't nag me.
7. As a user, I want TODOs from template docs left out, so that template placeholders don't look like real tasks.
8. As a user, I want a TODO I just typed in a doc to show up in Tasks within seconds, so that I trust the view is complete.
9. As a user, I want the view to work offline on desktop and Android, so that it is there whenever I am.
10. As a user, I want a loading state while the index is still building, so that an empty list isn't mistaken for "no tasks".
11. As a user, I want an error banner with Retry when tasks can't load, so that I know the list is incomplete.

### Inbox and triage

12. As a user, I want any TODO without a date and without a priority to sit in Inbox, so that I have a single list to triage.
13. As a user, I want Inbox grouped by source doc, with the newest doc first, so that related TODOs (e.g. two from the same meeting) sit together.
14. As a user, I want to set a date from quick chips (Today, Tomorrow, Next Monday, In a week), so that triage is one tap.
15. As a user, I want a date picker and a Clear option, so that I can choose any date or remove one.
16. As a user, I want to set a priority (High / Medium / Low / None), so that I can tell what matters most.
17. As a user, I want a task to leave Inbox as soon as it has a date (a priority alone keeps it in Inbox), so that Inbox only holds what is left to schedule.
18. As a user, I want a toast saying where the task went, with Undo for 5 seconds, so that a mis-tap is cheap.
19. As a desktop user, I want calendar and flag buttons to appear when I hover an Inbox row, so that I can triage without opening anything.
20. As a desktop user, I want keyboard triage (`T` today, `M` tomorrow, `D` date picker, `1`/`2`/`3` priority, `Space` toggle, `Enter` details, arrows to move), so that I can clear Inbox without the mouse.
21. As an Android user, I want to tap a row and pick a chip in a bottom sheet, so that triage works one-handed.
22. As a user, I want an Inbox-zero empty state, so that clearing it feels like an accomplishment.

### Scheduled views

23. As a user, I want a Today view with tasks due today plus overdue tasks, so that I see everything I should do now.
24. As a user, I want overdue tasks in their own red group, so that slipped tasks stand out.
25. As a user, I want a Tomorrow view, so that I can plan the next day.
26. As a user, I want a Next 7 Days view (overdue, today and the next six days) grouped by day, so that I can see my week.
27. As a user, I want an All tasks view with Scheduled and Inbox groups, so that I see every open task in one place.
28. As a user, I want each view to show its unchecked count in the inner nav (desktop) or chip row (mobile), so that I know how much is in each.
29. As a desktop user, I want the inner nav always visible (no collapse toggle), so that switching views is always one click.
30. As an Android user, I want a sticky, scrollable chip row for switching views, so that switching never needs scrolling back up.
31. As a user, I want group headers to collapse and to remember that per view, so that I can hide groups I don't need.
32. As a user, I want friendly empty states for Today, Tomorrow and Next 7 Days that point me to Inbox, so that an empty day suggests the next step.

### Task rows and details

33. As a user, I want each row to show the TODO text, its date label and its priority, so that I can scan quickly.
34. As a user, I want the checkbox border coloured by priority (grey, blue, orange, red), so that priority reads at a glance.
35. As a user, I want date labels like Today, Tomorrow, `Fri 30 Oct` and a red `2d ago`, so that dates read naturally.
36. As a user, I want each row to show its source doc and the nearest heading above it ("Project Kickoff › TODO"), so that I remember the context.
37. As a user, I want clicking the source line to open the doc scrolled to that block, so that I can jump back to the full context.
38. As a user, I want a detail panel (desktop) or bottom sheet (Android) with title, date, priority and an Open in doc action, so that I can see and edit everything about one task.
39. As a user, I want a TODO's title to be read-only in the Tasks view in v1, so that its text stays owned by its doc.

### Completing tasks

40. As a user, I want ticking a task in Tasks to tick the checkbox in its source doc, so that the two never disagree.
41. As a user, I want ticking a checkbox in a doc to show the task as completed in Tasks, so that either place works.
42. As a user, I want a completed task to stay in place, crossed off and moved below open tasks in its group, so that I see what I got done.
43. As a user, I want an Undo toast after completing, so that an accidental tick is easy to reverse.
44. As a user, I want counts to drop as soon as I complete a task, so that the numbers mean "left to do".
45. As a user, I want a completed dated task to stay visible while its due date is today or later and then disappear, never appearing as overdue, so that old done tasks don't clutter my views.
46. As a user, I want a completed undated task to stay crossed off in Inbox until the end of the day I completed it, so that today's wins stay visible.
47. As a user, I want a Completed view grouped by completion date ("Completed today", "Completed Tuesday, Oct 27") that shows the original due date, so that I can review what I did.
48. As a user, I want unchecking a task to put it back in its normal view, so that reopening works.

### Adding tasks

49. As a user, I want a + Add task field at the top of every view except Completed, so that I can capture a task without opening a doc.
50. As a user, I want tasks added from Today or Tomorrow to get that date, so that adding where I am looking does the right thing.
51. As a user, I want tasks added from other views to land in Inbox, so that capture never forces a decision.
52. As an Android user, I want a floating + button that opens an add sheet, so that capture is one tap.
53. As a user, I want to type `Call bank @tomorrow !high` in the Add task field and have the date and priority set with the tokens removed, so that I can capture and triage in one line.
54. As a user, I want date tokens `today`, `tomorrow`, weekday names, `nextweek`, `+3d` and `YYYY-MM-DD`, and priority tokens `!1`–`!3` / `!low` `!med` `!high`, so that common cases are short to type.
55. As a user, I want quick-added tasks stored in a hidden `Tasks` doc that is created on first use, so that I need no special place for them.
56. As a user, I want the hidden `Tasks` doc kept out of All docs, recents, search, favorites and the sidebar, so that it doesn't clutter my knowledge base.
57. As a user, I want quick-add rows labelled "Quick add" instead of a doc link, so that I know where they live.
58. As a user, I want to edit a quick-add task's title in the Tasks view, so that I can fix it even though its doc is hidden.
59. As a user, I want a setting that reveals the hidden `Tasks` doc, so that my data is recoverable if the view breaks.

### Sync and data

60. As a user with two Windows desktops and an Android phone, I want a date, priority or completion set on one device to appear on the others, so that my task list is the same everywhere.
61. As a user, I want date and priority to stay with the TODO when I move, copy or undo it in the editor, so that the data can't drift from its block.
62. As a user, I want docs that hold TODOs with dates to still open on older clients without losing those dates, so that a mixed-version setup is safe.

## Implementation Decisions

- **TODO identity.** A task is an `affine:list` block with `type: 'todo'`. Its id is `docId:blockId`. `checked` stays the source of truth for done/not done.
- **Block model change (storage option A).** Add three optional props to the list block, all undefined by default:
  ```ts
  // from the design doc; date-only in v1
  due?: string;          // ISO date 'YYYY-MM-DD', local calendar day, no time
  priority?: 0 | 1 | 2 | 3; // 0/undefined none, 1 low, 2 medium, 3 high
  completedAt?: number;  // epoch ms; set when checked, cleared when unchecked
  ```
  `completedAt` is needed because `meta:updatedAt` changes on any edit. Whoever sets `checked`, whether the Tasks view or the editor's checkbox, keeps `completedAt` in step; that belongs in the list block's toggle logic, not only in the Tasks view. The block schema version may need a bump; check how blocksuite handles additive optional props before bumping.
- **Spike first.** Before building the UI, confirm that a doc whose list blocks carry the new props survives a round trip through an unmodified client and through the import/export adapters without losing the props. If it doesn't, stop and report back; the storage decision depends on it.
- **Indexer carries task fields.** Both extractors (JS reader and the native Rust crawler) emit, for todo list blocks, list `type`, `checked`, `due`, `priority`, `completedAt` and the nearest heading text above the block. They go in the block row's `additional` JSON (not indexed) unless filtering needs an indexed field. Adding indexed `flavour`-plus-type matching is fine if queries need it. Bump both index versions so clients re-index. The native path depends on the external `affine_doc_loader` crate. The preferred approach is to post-process its output in the native crawler; vendoring the crate is the fallback.
- **Trashed and template docs** are filtered out at query time using the workspace's doc metadata, not at index time.
- **New frontend module `tasks`.** It provides one service, the deep module the UI talks to. Its interface, roughly:
  - `view$(viewId)`: grouped rows for `inbox | today | tomorrow | next7 | all | completed`
  - `counts$`: unchecked count per view, plus the Inbox count for the badge
  - `state$`: loading / ready / error, from indexer state
  - `setDue(taskId, due | null)`, `setPriority(taskId, priority | null)`, `toggle(taskId)`, `setTitle(taskId, text)` (quick-add tasks only)
  - `quickAdd(text, { defaultDue? })`: parses tokens, then appends a todo block to the hidden Tasks doc
  - `undo` support for the last triage or toggle, used by the toast

  It reads through the docs-search/indexer layer and writes through the doc module, by opening the source doc and updating the block props. It takes an injectable clock, so "today" is the local calendar day and tests are deterministic.

- **View membership rules** (unchecked unless stated): Inbox = no due (priority doesn't matter). Today = due ≤ today, with overdue as its own group. Tomorrow = due today+1. Next 7 Days = due ≤ today+6, grouped by day, overdue first. All = every unchecked task, grouped Scheduled / Inbox. Completed = checked, newest `completedAt` first, grouped by completion day. Completed tasks also stay crossed off in their normal views: a dated task while due ≥ today, an undated task until the end of its completion day. They sort below open tasks in their group and are never shown as overdue.
- **Grouping:** Inbox groups by source doc, newest doc first. The other views group by date. Collapsed group state is per view and per viewer, kept in local UI state.
- **Token parser:** a pure function shared by quick add now and the editor later. It returns `{ text, due?, priority? }` and recognises the tokens listed in the user stories, parsing on completed tokens only.
- **Hidden Tasks doc:** created on first quick add and recorded in workspace-level metadata so every client finds the same doc. It is excluded from All docs, recents, search, favorites and the sidebar, with a setting to show it. It must be created once per workspace even when two devices quick-add at the same time offline. Pick a deterministic id or reconcile duplicates, and record which in the code.
- **Navigation:** route `/tasks` (view chosen in-page; keep the selected view in the URL query so it can be linked). On desktop, a sidebar entry below Journals. On mobile, a `tasks` tab replacing `all`; All docs must stay reachable from home or search. Opening a source uses the existing block-scroll navigation; the detail panel uses AFFiNE's existing right-panel/peek patterns on desktop and a bottom sheet on mobile.
- **Feature flag:** ship behind a feature flag that is on by default in this fork, so it can be turned off if the index misbehaves.
- **UI** uses existing `@affine/component` pieces (checkbox, menu, date picker, toast) and AFFiNE theme tokens. TickTick is only a workflow reference. Strings go in the i18n English resource.
- **Order of work:** (1) props + round-trip spike, (2) extractor + index version bumps, (3) tasks service with tests, (4) desktop UI, (5) Android UI, (6) quick add + hidden doc.

## Decisions made during implementation

Confirmed by the user while building:

- **Android (phase 5):** the undo toast keeps AFFiNE's mobile behaviour (tap the toast, then Undo, within 5 s); no change to the shared notification card. All docs stays reachable through an "All docs" link at the top of mobile home (shown while the Tasks tab replaces it).

- **After the desktop re-test (2026-10-29):** Tasks opens on **Today** by default. Values right after a change come from the live doc, not the index: the index only discovers todo blocks (and gives cold values); docs written from the Tasks view stay open, and their rows are read live, until the index shows the same rows (30 s cap). No optimistic overlay; details in [todo-view.md](todo-view.md).

- **After the desktop hand-test (2026-10-29):** Inbox = no date; a priority alone keeps a task in Inbox (stories 12, 17, 27 updated; the All view's "No date (priority only)" group is gone). The desktop inner nav is always visible, no collapse toggle (story 29). The detail panel must keep showing a task after triage moves it out of the current view, so date and priority can be set in one go.

- **Inbox doc order:** "newest doc first" means newest by the doc's **created** date.
- **Row order inside a group:** open tasks above completed ones; then priority high → low; then the TODO's position in its doc (`additional.order` from the indexer), then doc id for ties across docs.
- **Checked tasks without `completedAt`** (ticked in an unmodified client, or imported/pasted as `[x]`): use the source doc's last-updated date as the completion time, for both the Completed grouping and the "crossed off until the end of the completion day" rule. `checked` stays the source of truth; a stale `completedAt` on an unchecked task is ignored.
- **Empty todos and doc links (2026-10-29):** a todo with blank text and no doc reference is not a task (left out of rows and counts by the projection). A linked-doc reference in a todo's text is a `' '` placeholder, so both extractors record `refs: [offset, docId][]` (UTF-16 offsets) and the row title shows the linked doc's current title there (a journal doc shows its date).
- **Index schema:** unchanged; the service queries `flavour: affine:list` and keeps `additional.listType === 'todo'` rows client-side (see [indexer.md](indexer.md)).

- **Server task list for cloud workspaces (2026-10-30).** Supersedes "server-side indexing or API changes" in Out of Scope.
  - **Why:** with two clients on one cloud workspace, the view only knew the todos in docs a device had downloaded. In testing, the sync socket reset every 20-60 s, and each reset restarted the full doc sync, so a phone never finished it. Ticks made on desktop did not reach the phone, and rows flickered. The Tasks view must not depend on which docs a device has downloaded.
  - **Server:**
    - **Table and extractor:** one task table (workspace, doc, block, text, refs, checked, due, priority, completedAt, updatedAt, plus a per-workspace extractor version), derived from the docs. Docs stay the only source of truth. An extractor runs on `doc.updates.pushed` (debounced per doc), loads the merged doc with `storage.getDoc`, runs the shared task extractor and replaces that doc's rows in one transaction.
    - **Backfill:** a job extracts every doc on the first query or when the extractor version is bumped.
    - **Query:** `tasks(workspaceId)` returns the whole list, filtered by doc read permission, with an "unchanged" signal.
    - **Writes:** `updateTask(workspaceId, docId, blockId, { checked?, due?, priority? })` writes one minimal Yjs delta (`checked` + `completedAt`, `due`, `priority`; null clears) through `pushDocUpdates`, the same way `updateDoc` does (needs Doc.Update). It started as a tick-only `setTaskChecked`. Review found that cloud due/priority writes through the local doc fail on a device that hasn't downloaded the doc, so every cloud write goes through the server.
    - The migration only adds.
  - **Client:**
    - A task source interface, with one view code path. Cloud workspaces use the server list over plain HTTP GraphQL (no realtime topic). Local workspaces keep the indexer path.
    - The cloud source renders the cached list first and refreshes on open, on foreground, after its own writes, on network-online and every 15 s while visible. It never clears the list while loading.
    - **Optimistic writes:** they last until a list fetched after the write shows them, or 30 s at most. A failed write shows an error on the row until a later write or retry succeeds.
    - **Open-doc override:** removed from the cloud path. Cloud rows don't need a local doc record; known trashed and template docs are still filtered.
    - **Servers without the tasks API** (official cloud, unpatched self-hosts) fall back to the local indexer path.
    - **Cache:** the list is cached per server, account and workspace.
  - **Rejected:**
    - **The server search index:** it lacks the task fields and needs Manticore or Elasticsearch, which the standard self-host compose doesn't include.
    - **A realtime delta ledger:** it depends on the unreliable socket.
  - **Spike results** (local Postgres 16, Windows dev machine; throwaway specs, not committed):
    - **`getDoc` sees a push at once.** It merges the snapshot with every pending update under the doc lock. A push that lands while a `getDoc` is in flight is seen by that `getDoc` or the next one; it was never lost.
    - **Timings:**

      | Step                                     | p50      | p95   | max   |
      | ---------------------------------------- | -------- | ----- | ----- |
      | `getDoc`                                 | 10 ms    | 12 ms | 29 ms |
      | `getDoc` with 200 pending updates        | 53 ms    |       |       |
      | Task extraction                          | < 0.5 ms |       |       |
      | Push to extracted rows (in-test emitter) | 10 ms    | 17 ms |       |

      So a ~2 s debounce is set by batching typing, not by read latency.

    - **Server tick delta:** 46 bytes. A client that made concurrent edits (typing in the same block, ticking another) converged byte for byte with the server. So did a replica fed the updates out of order. Applying the delta twice created no duplicates.
    - **Concurrent tick and untick of the same block:** the Yjs client id decides `checked`, and `completedAt` can survive on an unchecked task. The existing rule ("a stale `completedAt` on an unchecked task is ignored") covers it, so the server extractor must apply the same rule.
    - **Server import of `@affine/reader`:** a relative import failed under the server's ava loader ("Invalid or unexpected token"). Phase 1 has to make the extractor importable from the server, for example by moving the task-field code into a module that only depends on `yjs` and adding the server dependency, so that the server, the JS reader and Rust `task_fields.rs` can't drift apart.
    - **Not proven by the spike:** that blocksuite's open editor re-renders the remote `checked` change. That is the normal collaboration path, but it gets checked in the phase 3 hand-test.

## Testing Decisions

- A good test drives a module through its public interface and asserts on what a user would see or what ends up in the doc. It should not depend on how the module is built internally. Tests use fixed clocks, and they build Yjs docs in the test rather than relying on large binary fixtures where possible.
- **Seam 1 (primary): the tasks service.** Build it in a `Framework` with a stubbed indexer (`search$`/`aggregate$`/`state$` returning task rows) and stubbed doc/workspace services, then assert on `view$`, `counts$` and `state$`. This covers every membership rule, overdue and completed-visibility edges around midnight, grouping, trashed/template exclusion, triage leaving Inbox, undo, `quickAdd` with tokens and default dates, and the "create Tasks doc once" rule. Prior art: the docs-search service spec (stubbed indexer inside `Framework`) and the journal module tests.
- **Seam 2: the extractors.** Assert that a todo list block with the new props comes out of both extractors with the same task fields and heading. JS: the `@affine/reader` spec style (build or load a Yjs doc, call `readAllBlocksFromDoc`). Native: the nbstore indexer Rust tests (`crawl_doc_data` on a seeded SQLite doc). Both extractors must produce the same result for the same doc.
- **Round-trip spike** is verified by a test that writes the props, encodes and decodes the doc through the existing adapters, and checks the props are still there.
- UI components are not unit-tested in v1; check them by running the app on desktop and Android (see the build doc). An e2e test for the desktop flow (sidebar → Inbox → set Tomorrow → appears in Tomorrow → tick → source doc checked) is welcome if the existing e2e setup makes it cheap.

## Out of Scope

- Time of day, reminders and notifications (date only in v1).
- Parsing date/priority tokens inside the editor and showing an inline date chip on the block (v2). The trigger choice (extend the `@` menu, new trigger, or literal `@today`) is still open.
- Editing the title of a TODO that lives in a real doc from the Tasks view.
- Swipe actions on mobile.
- Recurring tasks, subtasks, tags/lists/projects, assignees.
- iOS-specific work (the shared mobile UI may work there, but it isn't a target).
- Server-side indexing or API changes (superseded for cloud workspaces by the server task list; see "Decisions made during implementation").
- Syncing with TickTick or other external task tools.

## Further Notes

- Targets: Windows desktop (Electron) and a locally built Android app, both against a self-hosted server. Official store and desktop builds won't have this feature; see the build doc.
- The repo is public: use placeholders for any server URLs in code, tests or docs.
- The design doc lists its remaining open questions. If this spec and the design doc disagree, flag the conflict to the user instead of guessing.
- Test seams (one service seam plus the extractor seam) are proposed here and still need the user to confirm them.
