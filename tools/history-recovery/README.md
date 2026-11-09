# Watcher guard tool (offline copy only)

Opt-in inserter for the sanitized `BASE_WHERE` / `fetch_rows` shape. It does not open PostgreSQL, does not read `/home/box/wa-watch/wa_watch.py`, and does not restart a process.

Direction of history recovery remains **older than the anchor**. A guarded watcher does not mean the missed outage window was fully recovered.

## Prerequisites

- Python 3.9+ standard library only. No pip packages, no Node, no database.
- A **copy** of the watcher. Do not pass the live path. The tool refuses `*/wa-watch/wa_watch.py` before reading it.

## Commands

```bash
python3 watcher_guard.py --target /path/to/copied_watcher.py
python3 watcher_guard.py --target /path/to/copied_watcher.py --apply
python3 watcher_guard.py --target /path/to/copied_watcher.py --rollback
python3 -m unittest test_watcher_guard.py
```

Dry-run is the default. `--apply` is the only write. The first apply stores `copied_watcher.py.bak-watcher-guard` and a checksum sidecar. A second apply does not duplicate the predicates. `--rollback` restores the backed-up bytes and then refuses a second rollback.

## What it edits, and only when the shape is exact

Both sites must be unambiguous. Otherwise nothing is written.

1. One `BASE_WHERE` assignment whose text is a triple-quoted string or a parenthesized concatenation of string literals, containing `"instanceId"`, `"messageTimestamp"`, `fromMe`, and `"messageType"`.
2. One `candidate_ids` function that references `BASE_WHERE`.
3. One `fetch_rows` function with one SQL literal that contains `WHERE`, `"instanceId"`, and `key->>'id'`, and does not contain `ORDER BY`, `GROUP BY`, or `LIMIT`.

The inserted predicates, on **both** sites, are:

```sql
AND COALESCE(status, '') <> 'HISTORY'
AND COALESCE(message->'_evolutionRecovery'->>'provenance', '') <> 'on-demand-history'
```

Existing `fromMe`, timestamp, jid, and `messageType` text is left in place. `messageTimestamp >= since` is not provenance isolation: a recovered row with a recent timestamp still matches the old filter. The new predicates are what exclude it.

`fetch_rows` is patched because an id chosen before the guard, or already sitting in a candidate list, is loaded there with no status filter. The SQL recheck drops that row at hydrate time. This does **not** see queues whose names are absent from the contract.

## Fail closed

Rejected, with the file unchanged:

- zero or several `BASE_WHERE` assignments
- missing documented marker or a non-literal right-hand side
- only one of the two predicates already present
- another `"Message"` query outside `candidate_ids` and `fetch_rows`
- `pending_ids`, `retry_queue`, `wake_queue`, or `candidate_queue`
- the live watcher path

## Still unknown — do not invent

Until a sanitized excerpt is supplied, this tool will not claim the real box file matches:

- the exact `BASE_WHERE` quoting if it is not one of the two literal shapes
- the exact `fetch_rows` SQL if the lookup is split across fragments or has `ORDER BY` / `LIMIT`
- whether `fetch_rows` can return an already built object instead of re-reading SQL
- any other in-memory list that wakes without calling `fetch_rows`

Deployment stays **BLOCKED** until the owner separately authorizes applying the reviewed copy and reloading the watcher. This tool does not do that reload.
