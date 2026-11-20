How tightly to write a delegate's brief depends on its tier. A brief is the whole of what the delegate knows.

## mid tier (fairly loose)
The goal and why it matters, the context it cannot find on its own, the constraints, and what done looks like. Leave the route to it: over-specifying costs tokens and removes the judgment you are paying for.

## small tier (a notch tighter)
Name the files or area, list the steps in order when order matters, give the output shape, and say what not to touch. Say when to stop and report instead of improvising. One task per delegate.

## bulk tier (exact)
One mechanical rule set, stated exactly, with two or three input and output examples. Split the data into batches small enough that a bad batch is cheap to redo, have each batch write its own output, and sample the results before merging. Never ask this tier to decide what the rules are.

## Every brief
- End with what to report: what changed (files), what it ran and the exact result (test command and pass/fail counts), and anything it could not do. Ask for facts, not a summary of effort.
- When the project has tests, say which command to run before reporting.
- Long briefs go in a file in the scratch area; the brief points at it.
- Several delegates editing one repository: give each its own git worktree (`git worktree add`), or run them one after another. Merge their branches yourself, then run the tests once on the result.

## Checking a report
Read the diff (`git diff` or the files it names), rerun the test command it claims, or open the output. If the claim and the check disagree, the check wins: fix it, or send it back one tier up with what was wrong.

## Telling the person
In your answer, one line: how many delegates ran, on which models, and what you checked (for example "3 delegates (2 on the small tier, 1 on mid); checked: tests pass, diffs read"). Report only what happened.
