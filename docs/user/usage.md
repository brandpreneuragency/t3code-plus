# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.

## Remaining limits

Open **Limits** from the Usage page. T3 Code reads the latest plan windows from local session
files. Codex reports 5-hour and weekly remaining capacity after a turn. Claude appears when a
session recorded a limit snapshot, usually after a blocked request. Grok Build does not publish
remaining plan limits in session files.

These figures are last-seen, not a live account query. They update after a provider turn writes a
snapshot.
