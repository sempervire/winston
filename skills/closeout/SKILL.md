---
name: closeout
description: Safety gate that answers one question - can this session end without losing or dangerously stranding important work (uncommitted or unpushed commits, own stash entries, running operations, half-finished actions)? Use when the user runs /winston:closeout, before ending or handing off a session, or from /winston:handoff. Reports only; fixes nothing.
---

# /winston:closeout

Answer one question:

> **Can this session disappear without losing or dangerously stranding important work?**

This is a safety gate, not cleanup. Ignore harmless stale state, repo hygiene, and
unrelated sessions.

## Output

For this gate, produce one of exactly
three outputs and nothing else — no plan, no progress narration, no list of checks that
passed, no recap, no suggested improvements.

Clear:

> `No blockers.`

Blocked — one bullet per already-known blocker, naming what would be lost and the
smallest action that would preserve it:

> **Blocked:**
> - `<what would be lost or endangered>` — `<smallest preserving action>`

Uncertain, with no confirmed blocker:

> **Uncertain:**
> - `<what could not be established>` — `<what would settle it>`

Report every blocker and material uncertainty already known when the first blocker is
confirmed. Confirming one ends the investigation; it does not suppress what is already in
hand. A material uncertainty alongside a blocker is listed under the `Blocked:` heading,
keeping its own wording and marked as one — `Uncertain — <what could not be
established> — <what would settle it>` — because the two need different answers and an
unmarked bullet gets the wrong one.

**A blocked run is answered by fixing the blocker and running the gate again**, which is
what reaches the checks the first run stopped short of. Reporting is where this command
ends; it fixes nothing itself.

## Bound the investigation

Answer from this session's own context first — what it did, which trees it worked in,
which operations it started. If that already establishes a blocker, report it and
investigate no further.

Otherwise gather the Git facts in one call, covering only the worktrees this session
used:

```sh
git -C /absolute/path/to/tree fetch --prune origin; echo "fetch exit: $?"
git -C /absolute/path/to/tree status -sb; echo "status exit: $?"
git -C /absolute/path/to/tree log --oneline branch-this-session-used --not --remotes --max-count=50; echo "unpushed exit: $?"
git -C /absolute/path/to/tree stash list; echo "stash exit: $?"
```

**Name the branch literally, as the path is named, and repeat the line for each branch
this session committed on.** Not `HEAD`: a session that committed on `fix/a` and then
checked out `staging` to compare reports nothing under `HEAD`. Not `--branches` either —
`refs/heads/*` is shared by every worktree in this clone, so it lists peers' local-only
commits, which are an unrelated session's business exactly as their stash entries are.

`--max-count` bounds the one output here with no natural ceiling; `| head` would not,
because it replaces the exit status this section reads. **A listing that reaches the cap
is a floor, not a count** — say so rather than reporting the number as complete.

**`stash list` is per clone, not per tree** — one call answers for all of them.

**Write the path out literally, once per tree — never a `for` loop over a variable.** A
loop variable is refused by a worktree-isolation guard (where one is installed), which has to be able to see
where the `git` call points.

**The guard also refuses any tree that is not this session's own**, including the shared
checkout, so a session that worked in more than one tree cannot read the others from
here. Settle those from session context — commits this session pushed itself are pushed —
and where context cannot settle one, name that tree as `Uncertain:` rather than dropping
it. Most sessions use one tree and never meet this.

**Every exit status is printed, and nothing is redirected or wrapped in `||`.** A single
`||` fires on any failure, not the one it was written for, and swallows the status while
doing it: a tree that has been removed or mistyped then reads exactly like a clean one.
Read them separately:

- a non-zero **status**, **unpushed** or **stash** exit means that check did not run, so
  nothing about the tree was established — `Uncertain:`;
- a non-zero **fetch** exit — offline, no credential, no such remote — leaves the
  remote-tracking refs as stale as they were. It is `Uncertain:` only when this session
  made commits in that tree and its own context cannot say whether they reached the
  remote. Otherwise it is the harmless gap the Uncertainty section describes, and an
  offline session with nothing of its own at stake still clears.

**`<branch> --not --remotes` is what the unpushed check asks, and `@{u}..HEAD` is not.**
It names every commit on that branch that no remote-tracking ref holds, so it answers
whether the work exists on the remote — which is the actual question — rather than
whether this branch happens to have an upstream configured. A branch pushed with
`git push origin HEAD:name` has no upstream and is perfectly safe; a branch whose remote
was deleted has an upstream and is not. The fetch above is what makes the refs it reads
current; that is why it comes first and is not conditional.

Resolve ownership of a change from session context first, and widen only for a specific
uncertainty that could change the verdict.

Out of scope: scanning unrelated sessions or worktrees, board and issue inventories,
re-reading process documents, and re-running CI, tests, or deployment checks.

## Check

1. **Uncommitted work**
   Block only for important changes belonging to this session.

2. **Unpushed work**
   Block if important commits from this session exist only locally — the commits the
   `--not --remotes` lines listed above, for the branches this session committed on.

   **A missing upstream is not proof of unpushed work, and a present one is not proof
   against it.** Both readings have to be wrong for the check above to be right: a branch
   pushed with `git push origin HEAD:name` carries no upstream and is safe, while a
   branch whose remote was deleted — a merged PR, or a branch-cleanup job pruning it — keeps
   its upstream and its stale tracking ref, and `@{u}..HEAD` reports its commits as
   pushed when they exist nowhere but this worktree. The fetch is what retires that ref.

3. **Running operations**
   Block if killing a process started by this session could lose work, corrupt state, or
   interrupt an important non-repeatable operation.

4. **Local-only state**
   Block if important files, patches, artifacts, or other work exist only in this
   session/environment and would be lost.

   **A stash entry is local-only state, and `status -sb` never shows one.** The stash
   stack is shared with every worktree in this clone and other sessions pop from it, so a
   `stash list` entry this session pushed is the one copy of that work and nobody is
   guarding it. That is what the fourth line above is for.

   **Only this session's own entries count.** The listing shows every session's, and a
   peer's stash is an unrelated session's business — read the tag this session gave its
   own `git stash push -u -m "<unique-tag>"`, and where no entry is recognisably this
   session's, none of them blocks.

5. **Half-finished actions**
   Block if this session started an external or destructive action that is currently
   unsafe to interrupt or repeat.

6. **Conversation-only recovery information**
   Block only for information required to resume safely that exists nowhere but this
   conversation. Not every unfinished thought, and not a handoff summary.

## Uncertainty

A failed check, an unavailable tool, or missing evidence is `Uncertain:` only when what is
missing could conceal important endangered work. A harmless configuration gap is not a
blocker. **This governs every per-check rule above** — where one of them names a failure
as `Uncertain:`, it means when that failure could hide endangered work, never as a reflex.

## Never

Do not merge, deploy, commit, push, prune worktrees, delete branches, clean files, write
notes, fix board state, or perform any repair. Name the smallest preserving action;
performing it is the session's call, not this gate's.

The `git fetch --prune origin` above is the one exception. **Remote-tracking refs are
shared by every worktree in this clone**, so the prune is visible to every other live
session here, and a peer sitting on a branch whose remote was deleted will find its
`@{u}` stops resolving. That is the deleted branch showing through, not damage: the prune
removes only a ref whose remote branch is already gone, and no commit, working tree, or
stash entry is touched.
