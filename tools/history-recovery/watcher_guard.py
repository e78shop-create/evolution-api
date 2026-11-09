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


def _unescape(body: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(body):
        if body[i] == "\\" and i + 1 < len(body):
            nxt = body[i + 1]
            out.append({"n": "\n", "t": "\t", "\\": "\\", "'": "'", '"': '"'}.get(nxt, nxt))
            i += 2
            continue
        out.append(body[i])
        i += 1
    return "".join(out)


def read_string(text: str, i: int) -> tuple[str, int] | None:
    if i >= len(text) or text[i] not in ("'", '"'):
        return None
    triple = text.startswith(text[i] * 3, i)
    quote = text[i] * 3 if triple else text[i]
    end = i + len(quote)
    raw: list[str] = []
    while end < len(text) and not text.startswith(quote, end):
        if text[end] == "\\" and end + 1 < len(text):
            raw.append(text[end : end + 2])
            end += 2
            continue
        raw.append(text[end])
        end += 1
    if not text.startswith(quote, end):
        return None
    return _unescape("".join(raw)), end + len(quote)


def skip_ws_comments(text: str, i: int) -> int:
    while i < len(text):
        if text[i] in " \t\r\n":
            i += 1
            continue
        if text.startswith("#", i):
            newline = text.find("\n", i)
            i = len(text) if newline < 0 else newline + 1
            continue
        break
    return i


class StaticExpr:
    def __init__(self, value: str, end: int, last_token_end: int):
        self.value = value
        self.end = end
        self.last_token_end = last_token_end
        self.dynamic = False


class DynamicExpr:
    def __init__(self, end: int, sql_like: bool):
        self.end = end
        self.dynamic = True
        self.sql_like = sql_like
        self.value = ""
        self.last_token_end = end


def _sql_fragment(value: str) -> bool:
    upper = value.upper()
    return (
        "KEY->>'ID'" in upper
        or '"INSTANCEID"' in upper
        or "INSTANCEID" in upper
        or bool(re.search(r'(?i)\b(from|join)\s+"Message"', value))
        or "WHERE" in upper
    )


def parse_static_expr(text: str, i: int) -> StaticExpr | DynamicExpr | None:
    i = skip_ws_comments(text, i)
    parts, i, last_end, saw_piece, dynamic = _parse_static_terms(text, i)
    if not saw_piece:
        return None
    value = "".join(parts)
    if dynamic:
        return DynamicExpr(i, _sql_fragment(value))
    return StaticExpr(value, i, last_end)


def _parse_static_terms(text: str, i: int) -> tuple[list[str], int, int, bool, bool]:
    parts: list[str] = []
    saw = False
    last_end = i
    while True:
        i = skip_ws_comments(text, i)
        if i < len(text) and text[i] == "(":
            inner, i, last_end, inner_saw, inner_dynamic = _parse_static_terms(text, i + 1)
            i = skip_ws_comments(text, i)
            if i >= len(text) or text[i] != ")" or not inner_saw or inner_dynamic:
                return parts + inner, i, last_end, True, True
            i += 1
            parts.extend(inner)
            saw = True
            last_end = i
        elif i < len(text) and text[i] in ("'", '"'):
            lit = read_string(text, i)
            if lit is None:
                return parts, i, last_end, True, True
            parts.append(lit[0])
            i = lit[1]
            last_end = i
            saw = True
        elif not saw:
            return parts, i, last_end, False, False
        else:
            break
        j = skip_ws_comments(text, i)
        if j < len(text) and text[j] == "+":
            nxt = skip_ws_comments(text, j + 1)
            if nxt >= len(text) or text[nxt] not in ("'", '"', "("):
                return parts, nxt, last_end, True, True
            i = nxt
            continue
        if j < len(text) and text[j] in ("'", '"', "("):
            i = j
            continue
        return parts, j, last_end, True, False


def is_message_query(value: str) -> bool:
    return re.search(r'(?i)\b(from|join)\s+"Message"', value) is not None


def is_hydrate_sql(value: str) -> bool:
    if re.search(r"(?i)\b(ORDER BY|GROUP BY|LIMIT)\b", value):
        return False
    return '"instanceId"' in value and "key->>'id'" in value and "WHERE" in value.upper() and is_message_query(value)


def _walk_exprs(body: str) -> list[StaticExpr | DynamicExpr]:
    found: list[StaticExpr | DynamicExpr] = []
    i = 0
    while i < len(body):
        if body.startswith("#", i):
            newline = body.find("\n", i)
            i = len(body) if newline < 0 else newline + 1
            continue
        if body.startswith(("f'", 'f"', "F'", 'F"'), i):
            lit = read_string(body, i + 1)
            if lit is None:
                i += 1
                continue
            found.append(DynamicExpr(lit[1], _sql_fragment(lit[0]) or "key->>'id'" in lit[0]))
            i = lit[1]
            continue
        if body[i] in ("'", '"'):
            expr = parse_static_expr(body, i)
            if expr is None:
                i += 1
                continue
            j = skip_ws_comments(body, expr.end)
            if not expr.dynamic and body.startswith(".format(", j):
                expr = DynamicExpr(j + len(".format("), _sql_fragment(expr.value))
            elif not expr.dynamic and j < len(body) and body[j] == "%" and not body.startswith("%>", j):
                expr = DynamicExpr(j + 1, _sql_fragment(expr.value))
            found.append(expr)
            i = expr.end
            continue
        i += 1
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
    hydrate_expr: StaticExpr | None = None
    if hydrate is None:
        reasons.append("expected exactly one fetch_rows function")
    else:
        body = text[hydrate[0] : hydrate[1]]
        dynamic_sql = False
        matches: list[StaticExpr] = []
        for expr in _walk_exprs(body):
            if expr.dynamic:
                if getattr(expr, "sql_like", False):
                    dynamic_sql = True
                continue
            if is_hydrate_sql(expr.value) or (
                _sql_fragment(expr.value) and ("key->>'id'" in expr.value or is_message_query(expr.value))
            ):
                if is_hydrate_sql(expr.value):
                    matches.append(expr)
                elif re.search(r"(?i)\b(ORDER BY|GROUP BY|LIMIT)\b", expr.value):
                    reasons.append("fetch_rows SQL has ORDER BY, GROUP BY, or LIMIT; appending AND would be ambiguous")
                elif "key->>'id'" in expr.value or is_message_query(expr.value):
                    reasons.append(
                        "fetch_rows SQL is static but does not contain where, \"instanceId\", and key->>'id' together"
                    )
        if dynamic_sql:
            reasons.append("fetch_rows SQL concatenation is dynamic; only string literals joined by + or parentheses are accepted")
        if len(matches) != 1 and not any("fetch_rows SQL" in reason for reason in reasons):
            reasons.append(f"expected exactly one statically evaluable fetch_rows lookup, found {len(matches)}")
        elif len(matches) == 1:
            chosen = matches[0]
            if partial_guard(chosen.value):
                reasons.append("fetch_rows SQL contains a partial history guard")
            else:
                hydrate_expr = chosen

    extras = []
    for expr in _walk_exprs(text):
        if expr.dynamic or not is_message_query(expr.value):
            continue
        pos = expr.last_token_end
        if candidate is not None and candidate[0] <= pos < candidate[1]:
            continue
        if hydrate is not None and hydrate[0] <= pos < hydrate[1]:
            continue
        extras.append(text.count("\n", 0, pos) + 1)
    if extras:
        reasons.append(
            "unexpected SQL against \"Message\" outside candidate_ids and fetch_rows at lines " + ", ".join(map(str, extras))
        )

    queues = [name for name in QUEUE_NAMES if re.search(rf"\b{name}\b", text)]
    if queues:
        reasons.append("unsanitized queue symbols present: " + ", ".join(queues))

    base_state = "missing"
    hydrate_state = "missing"
    if base is not None and not missing and not partial_guard(literal):
        base_state = "guarded" if already_guarded(literal) else "open" if needs_guards(literal) else "partial"
    elif base is not None:
        base_state = "partial" if partial_guard(literal) else "open"
    if hydrate_expr is not None and not partial_guard(hydrate_expr.value):
        hydrate_state = (
            "guarded" if already_guarded(hydrate_expr.value) else "open" if needs_guards(hydrate_expr.value) else "partial"
        )
    elif hydrate_expr is not None:
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
        if hydrate_expr is None
        else {
            "insert_at": hydrate[0] + hydrate_expr.last_token_end,
            "literal": hydrate_expr.value,
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
    guard_concat = (
        ' + (" AND '
        + GUARD_STATUS
        + '"\n    " AND '
        + GUARD_PROVENANCE
        + '")'
    )
    spans = [
        (base["start"], base["end"], base_replacement),
        (hydrate["insert_at"], hydrate["insert_at"], guard_concat),
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
