#!/usr/bin/env python3
"""Offline, opt-in guard inserter for a copied watcher file.

Default is dry-run. --apply writes only after the copied source matches the
sanitized BASE_WHERE / fetch_rows shape. The documented production path is
refused before the file is read. This tool does not start, stop, or reload a
watcher and does not open PostgreSQL.

The messageTimestamp filter is not provenance isolation. Both SQL predicates
are required, on the candidate predicate and on the hydrate query.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

GUARD_STATUS = "COALESCE(status, '') <> 'HISTORY'"
GUARD_PROVENANCE = "COALESCE(message->'_evolutionRecovery'->>'provenance', '') <> 'on-demand-history'"
GUARDS = (GUARD_STATUS, GUARD_PROVENANCE)
MARKERS = ('"instanceId"', '"messageTimestamp"', "fromMe", '"messageType"')
FORBIDDEN_PATHS = {"/home/box/wa-watch/wa_watch.py"}
QUEUE_NAMES = ("pending_ids", "retry_queue", "wake_queue", "candidate_queue")
HYDRATE_NEEDLES = ('"instanceId"', "key->>'id'")

BACKUP_SUFFIX = ".bak-watcher-guard"
SIDECAR_SUFFIX = ".watcher-guard-backup.json"


def forbidden(path: Path) -> bool:
    resolved = path.resolve().as_posix()
    return resolved in FORBIDDEN_PATHS or resolved.endswith("/wa-watch/wa_watch.py")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def assignment_spans(text: str, name: str) -> list[re.Match[str]]:
    return list(re.finditer(rf"(?m)^[ \t]*{name}[ \t]*=[ \t]*", text))


def extract_expression(text: str, start: int) -> tuple[str, int, int] | None:
    """Return (literal contents, content_start, content_end) for a supported RHS."""
    if text.startswith('"""', start) or text.startswith("'''", start):
        quote = text[start : start + 3]
        end = text.find(quote, start + 3)
        if end < 0:
            return None
        return text[start + 3 : end], start + 3, end, "triple"
    if text.startswith("(", start):
        depth = 0
        i = start
        pieces: list[str] = []
        while i < len(text):
            char = text[i]
            if char == "(":
                depth += 1
                i += 1
                continue
            if char == ")":
                depth -= 1
                if depth == 0:
                    return "".join(pieces), start, i + 1, "paren"
                i += 1
                continue
            if char in " \t\r\n":
                i += 1
                continue
            if text.startswith("#", i):
                newline = text.find("\n", i)
                i = len(text) if newline < 0 else newline + 1
                continue
            if char in ("'", '"'):
                triple = text.startswith(char * 3, i)
                quote = char * 3 if triple else char
                end = i + len(quote)
                body: list[str] = []
                while end < len(text) and not text.startswith(quote, end):
                    if text[end] == "\\":
                        nxt = text[end + 1] if end + 1 < len(text) else ""
                        body.append({"n": "\n", "t": "\t", "\\": "\\", "'": "'", '"': '"'}.get(nxt, nxt))
                        end += 2
                        continue
                    body.append(text[end])
                    end += 1
                if not text.startswith(quote, end):
                    return None
                pieces.append("".join(body))
                i = end + len(quote)
                continue
            return None
        if depth == 0:
            return "".join(pieces), start, i, "paren"
        return None
    return None


def function_span(text: str, name: str) -> tuple[int, int] | None:
    matches = list(re.finditer(rf"(?m)^def {name}\s*\(.*\)\s*:", text))
    if len(matches) != 1:
        return None
    start = matches[0].start()
    rest = text[matches[0].end() :]
    nxt = re.search(r"(?m)^(def |class )", rest)
    end = len(text) if nxt is None else matches[0].end() + nxt.start()
    return start, end


def string_literals(body: str) -> list[tuple[int, int, str]]:
    found: list[tuple[int, int, str]] = []
    i = 0
    while i < len(body):
        if body[i] not in ("'", '"'):
            i += 1
            continue
        triple = body.startswith(body[i] * 3, i)
        quote = body[i] * 3 if triple else body[i]
        end = i + len(quote)
        chars: list[str] = []
        while end < len(body) and not body.startswith(quote, end):
            if body[end] == "\\":
                chars.append(body[end : end + 2])
                end += 2
                continue
            chars.append(body[end])
            end += 1
        if not body.startswith(quote, end):
            break
        found.append((i, end + len(quote), "".join(chars)))
        i = end + len(quote)
    return found


def guard_counts(text: str) -> dict[str, int]:
    return {guard: text.count(guard) for guard in GUARDS}


def needs_guards(text: str) -> bool:
    counts = guard_counts(text)
    return all(count == 0 for count in counts.values())


def already_guarded(text: str) -> bool:
    counts = guard_counts(text)
    return all(count == 1 for count in counts.values())


def partial_guard(text: str) -> bool:
    counts = guard_counts(text)
    return any(count > 0 for count in counts.values()) and not already_guarded(text)


def append_guards(literal: str) -> str:
    suffix = "\nAND " + "\nAND ".join(GUARDS) + "\n"
    return literal.rstrip() + suffix


def replace_span(text: str, start: int, end: int, replacement: str) -> str:
    return text[:start] + replacement + text[end:]


def analyze(text: str) -> dict:
    reasons: list[str] = []
    base_matches = assignment_spans(text, "BASE_WHERE")
    if len(base_matches) != 1:
        reasons.append(f"expected exactly one BASE_WHERE assignment, found {len(base_matches)}")
        return {"ok": False, "reasons": reasons}
    base = extract_expression(text, base_matches[0].end())
    if base is None:
        reasons.append("BASE_WHERE layout is not a single triple-quoted string or parenthesized string concatenation")
        return {"ok": False, "reasons": reasons}
    literal, content_start, content_end, _kind = base
    missing = [marker for marker in MARKERS if marker not in literal]
    if missing:
        reasons.append("BASE_WHERE is missing documented markers: " + ", ".join(missing))
    if partial_guard(literal):
        reasons.append("BASE_WHERE contains a partial history guard; refusing to guess which copy to keep")

    candidate = function_span(text, "candidate_ids")
    if candidate is None:
        reasons.append("expected exactly one candidate_ids function")
    elif "BASE_WHERE" not in text[candidate[0] : candidate[1]]:
        reasons.append("candidate_ids does not reference BASE_WHERE")

    hydrate = function_span(text, "fetch_rows")
    hydrate_literal = None
    if hydrate is None:
        reasons.append("expected exactly one fetch_rows function")
    else:
        body = text[hydrate[0] : hydrate[1]]
        if any(needle not in body for needle in HYDRATE_NEEDLES):
            reasons.append("fetch_rows does not show the documented instanceId and key->>'id' lookup")
        hits = [item for item in string_literals(body) if "key->>'id'" in item[2]]
        if len(hits) != 1:
            reasons.append(f"expected exactly one fetch_rows SQL literal containing key->>'id', found {len(hits)}")
        else:
            rel_start, rel_end, sql = hits[0]
            upper = sql.upper()
            if '"INSTANCEID"' not in upper and '"instanceId"' not in sql:
                reasons.append("fetch_rows SQL literal does not include instanceId")
            if "WHERE" not in upper:
                reasons.append("fetch_rows SQL literal has no WHERE")
            if any(token in upper for token in ("ORDER BY", "GROUP BY", "LIMIT")):
                reasons.append("fetch_rows SQL literal has trailing clauses; appending AND would be ambiguous")
            if partial_guard(sql):
                reasons.append("fetch_rows SQL contains a partial history guard")
            hydrate_literal = (hydrate[0] + rel_start, hydrate[0] + rel_end, sql)

    message_hits = [match.start() for match in re.finditer(r'"Message"', text)]
    covered: list[tuple[int, int]] = []
    if candidate is not None:
        covered.append(candidate)
    if hydrate is not None:
        covered.append(hydrate)
    extras = []
    for pos in message_hits:
        if not any(start <= pos < end for start, end in covered):
            line = text.count("\n", 0, pos) + 1
            extras.append(line)
    if extras:
        reasons.append("unexpected Message query outside BASE_WHERE and fetch_rows at lines " + ", ".join(map(str, extras)))

    queues = [name for name in QUEUE_NAMES if re.search(rf"\b{name}\b", text)]
    if queues:
        reasons.append("unsanitized queue symbols present: " + ", ".join(queues))

    base_state = "missing"
    hydrate_state = "missing"
    if base is not None and not missing and not partial_guard(literal):
        base_state = "guarded" if already_guarded(literal) else "open" if needs_guards(literal) else "partial"
    elif base is not None:
        base_state = "partial" if partial_guard(literal) else "open"
    if hydrate_literal is not None and not partial_guard(hydrate_literal[2]):
        hydrate_state = (
            "guarded" if already_guarded(hydrate_literal[2]) else "open" if needs_guards(hydrate_literal[2]) else "partial"
        )
    elif hydrate_literal is not None:
        hydrate_state = "partial"
    if base_state != hydrate_state:
        reasons.append("BASE_WHERE and fetch_rows guard states do not match")
    elif base_state not in ("open", "guarded"):
        reasons.append("history guard is not in a single writable state")

    return {
        "ok": not reasons and base_state in ("open", "guarded") and hydrate_state in ("open", "guarded"),
        "reasons": reasons,
        "base": None
        if base is None
        else {
            "start": content_start,
            "end": content_end,
            "literal": literal,
            "state": base_state,
            "kind": _kind,
        },
        "hydrate": None
        if hydrate_literal is None
        else {
            "start": hydrate_literal[0],
            "end": hydrate_literal[1],
            "literal": hydrate_literal[2],
            "state": hydrate_state,
        },
        "coverage": {
            "baseWhere": base_state == "guarded",
            "fetchRowsSql": hydrate_state == "guarded",
            "timestampFilterIsNotProvenanceIsolation": True,
            "unproven": "No sanitized inventory of in-memory queues was provided. Restarting the watcher is not part of this tool.",
        },
    }


def patched_text(text: str, report: dict) -> str | None:
    if not report["ok"]:
        return None
    base = report["base"]
    hydrate = report["hydrate"]
    if base["state"] == "guarded" and hydrate["state"] == "guarded":
        return text
    if base["state"] != "open" or hydrate["state"] != "open":
        return None
    base_replacement = append_guards(base["literal"])
    if base["kind"] == "paren":
        if '"""' in base_replacement:
            return None
        base_replacement = '"""' + base_replacement + '"""'
    elif base["kind"] != "triple":
        return None
    spans = [
        (base["start"], base["end"], base_replacement),
        (hydrate["start"], hydrate["end"], _replace_literal(text, hydrate, append_guards(hydrate["literal"]))),
    ]
    spans.sort(key=lambda item: item[0], reverse=True)
    updated = text
    for start, end, replacement in spans:
        updated = replace_span(updated, start, end, replacement)
    return updated


def _replace_literal(text: str, hydrate: dict, new_body: str) -> str:
    raw = text[hydrate["start"] : hydrate["end"]]
    if raw.startswith('"""') or raw.startswith("'''"):
        quote = raw[:3]
        return quote + new_body + quote
    if raw.startswith("'") or raw.startswith('"'):
        return raw[0] + new_body + raw[0]
    raise ValueError("hydrate literal quotes are ambiguous")


def public_report(mode: str, changed: bool, report: dict, extra: dict | None = None) -> dict:
    payload = {
        "mode": mode,
        "ok": report["ok"],
        "changed": changed,
        "reasons": report["reasons"],
        "coverage": report.get("coverage", {}),
        "deployment": "BLOCKED",
        "direction": "older-than-anchor",
        "fullOutageRecoveryGuaranteed": False,
    }
    if extra:
        payload.update(extra)
    return payload


def emit(payload: dict, code: int) -> int:
    sys.stdout.write(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return code


def read_refused(path: Path) -> dict | None:
    if forbidden(path):
        return {
            "mode": "refused",
            "ok": False,
            "changed": False,
            "reasons": ["refusing the documented watcher path; copy the file off the box before dry-run or apply"],
            "deployment": "BLOCKED",
            "direction": "older-than-anchor",
            "fullOutageRecoveryGuaranteed": False,
        }
    return None


def cmd_check(path: Path, apply: bool) -> int:
    refused = read_refused(path)
    if refused:
        return emit(refused, 3)
    original = path.read_bytes()
    text = original.decode("utf-8")
    report = analyze(text)
    updated = patched_text(text, report)
    if not report["ok"] or updated is None:
        return emit(public_report("dry-run" if not apply else "apply", False, report), 2)
    changed = updated != text
    if not apply:
        return emit(
            public_report("dry-run", False, report, {"wouldChange": changed, "alreadyApplied": not changed}),
            0,
        )
    if not changed:
        return emit(public_report("apply", False, report, {"alreadyApplied": True}), 0)
    backup = Path(str(path) + BACKUP_SUFFIX)
    sidecar = Path(str(path) + SIDECAR_SUFFIX)
    if sidecar.exists() or backup.exists():
        report["reasons"].append("backup already exists; rollback or remove it before another apply")
        report["ok"] = False
        return emit(public_report("apply", False, report), 2)
    backup.write_bytes(original)
    sidecar.write_text(
        json.dumps({"sha256": sha256(original), "backup": backup.name}, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary = path.with_suffix(path.suffix + ".watcher-guard.tmp")
    temporary.write_text(updated, encoding="utf-8")
    temporary.replace(path)
    return emit(public_report("apply", True, analyze(updated)), 0)


def cmd_rollback(path: Path) -> int:
    refused = read_refused(path)
    if refused:
        return emit(refused, 3)
    sidecar = Path(str(path) + SIDECAR_SUFFIX)
    backup = Path(str(path) + BACKUP_SUFFIX)
    if not sidecar.exists() or not backup.exists():
        return emit(
            {
                "mode": "rollback",
                "ok": False,
                "changed": False,
                "reasons": ["backup sidecar is missing"],
                "deployment": "BLOCKED",
                "direction": "older-than-anchor",
                "fullOutageRecoveryGuaranteed": False,
            },
            2,
        )
    meta = json.loads(sidecar.read_text(encoding="utf-8"))
    payload = backup.read_bytes()
    if sha256(payload) != meta.get("sha256"):
        return emit(
            {
                "mode": "rollback",
                "ok": False,
                "changed": False,
                "reasons": ["backup checksum does not match the sidecar"],
                "deployment": "BLOCKED",
                "direction": "older-than-anchor",
                "fullOutageRecoveryGuaranteed": False,
            },
            2,
        )
    path.write_bytes(payload)
    sidecar.unlink()
    return emit(
        {
            "mode": "rollback",
            "ok": True,
            "changed": True,
            "reasons": [],
            "deployment": "BLOCKED",
            "direction": "older-than-anchor",
            "fullOutageRecoveryGuaranteed": False,
        },
        0,
    )


def legacy_candidate(row: dict, since: int, skip_types: set[str]) -> bool:
    """Documented pre-guard filters. Timestamp is not a history-provenance check."""
    if row.get("messageTimestamp", -1) < since:
        return False
    from_me = row.get("fromMe")
    if from_me is None:
        from_me = False
    if from_me is not False:
        return False
    if row.get("jidAllowed") is not True:
        return False
    if row.get("messageType") in skip_types:
        return False
    return True


def guarded_candidate(row: dict, since: int, skip_types: set[str]) -> bool:
    if not legacy_candidate(row, since, skip_types):
        return False
    status = row.get("status") or ""
    provenance = ""
    message = row.get("message")
    if isinstance(message, dict):
        recovery = message.get("_evolutionRecovery") or {}
        if isinstance(recovery, dict):
            provenance = recovery.get("provenance") or ""
    if status == "HISTORY":
        return False
    if provenance == "on-demand-history":
        return False
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Dry-run or apply the watcher history guard on a copied file.")
    parser.add_argument("--target", required=True)
    parser.add_argument("--apply", action="store_true", help="Write the copied file. Dry-run is the default.")
    parser.add_argument("--rollback", action="store_true")
    args = parser.parse_args(argv)
    path = Path(args.target)
    if args.apply and args.rollback:
        return emit(
            {
                "mode": "refused",
                "ok": False,
                "changed": False,
                "reasons": ["apply and rollback are mutually exclusive"],
                "deployment": "BLOCKED",
            },
            2,
        )
    if args.rollback:
        return cmd_rollback(path)
    return cmd_check(path, apply=args.apply)


if __name__ == "__main__":
    sys.exit(main())
