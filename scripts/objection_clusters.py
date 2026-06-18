#!/usr/bin/env python3
"""
Top objections (AGENT_FIELDS.md widget #12) — the one coming-soon metric that
can't be done in SQL alone, because inbound objections live in the free-text
`report_complaints` column rather than a structured taxonomy.

Design goal (per request): AI is the LAST 5%.
  1. ClickHouse (`ch` CLI) pulls the raw free-text complaints.            [no AI]
  2. Pure Python explodes the JSON arrays, normalizes, drops empties,
     exact-dedups (with counts), and fuzzy-merges near-duplicates.        [no AI]
  3. Claude Haiku 4.5 is called ONCE per run, only to assign each *unique*
     complaint to a theme. Python does the counting/ranking.             [AI: tiny]

Cost control:
  - Cheap model: claude-haiku-4-5 ($1/MTok in, $5/MTok out).
  - Hard ceiling: $50 cumulative across all runs, tracked in a JSON ledger.
  - Pre-flight: count_tokens + worst-case output cost is checked against the
    remaining budget BEFORE the call; if it would breach the cap, we refuse
    and fall back to the (already-printed) pure-Python clusters.
  - Without ANTHROPIC_API_KEY set, the AI step is skipped entirely and the
    script still prints exact + fuzzy clusters — so it's useful today.

Usage:
  python scripts/objection_clusters.py --ent 7d06f7427 --team 49a06313cf --days 30
  python scripts/objection_clusters.py --ent ... --team ... --no-ai   # clusters only
  python scripts/objection_clusters.py --ent ... --team ... --dry-run # show est. cost, don't call
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

# ── cost model (Haiku 4.5; USD per token) ──────────────────────────────────
MODEL = "claude-haiku-4-5"
PRICE_IN = 1.00 / 1_000_000   # $1.00 / MTok input
PRICE_OUT = 5.00 / 1_000_000  # $5.00 / MTok output
HARD_CAP_USD = 50.00          # cumulative ceiling across all runs
MAX_OUTPUT_TOKENS = 2000      # the AI only emits a compact index→theme map

LEDGER = Path(__file__).resolve().parent / ".objection_ai_ledger.json"

# Near-duplicate threshold for fuzzy merge ("tire bulge" ≈ "bulge in tire").
FUZZY_RATIO = 0.86


def load_env_local() -> None:
    """Populate os.environ from the repo's .env.local for any key not already set (the shell wins).
    Lets you keep ANTHROPIC_API_KEY in .env.local instead of exporting it. No dependency on python-dotenv."""
    env_path = Path(__file__).resolve().parent.parent / ".env.local"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        os.environ.setdefault(key.strip(), val.strip().strip('"').strip("'"))


# ── ledger (the utilisation monitor) ───────────────────────────────────────
def load_ledger() -> dict:
    if LEDGER.exists():
        return json.loads(LEDGER.read_text())
    return {"total_spent_usd": 0.0, "calls": []}


def record_spend(ledger: dict, usd: float, usage: dict, label: str) -> None:
    ledger["total_spent_usd"] = round(ledger["total_spent_usd"] + usd, 6)
    ledger["calls"].append(
        {"ts": datetime.now(timezone.utc).isoformat(), "usd": round(usd, 6), "label": label, **usage}
    )
    LEDGER.write_text(json.dumps(ledger, indent=2))


def cost_of(usage) -> float:
    """USD for one response, honouring cache discounts when present."""
    inp = getattr(usage, "input_tokens", 0) or 0
    out = getattr(usage, "output_tokens", 0) or 0
    cache_read = getattr(usage, "cache_read_input_tokens", 0) or 0
    cache_write = getattr(usage, "cache_creation_input_tokens", 0) or 0
    return (
        inp * PRICE_IN
        + cache_read * PRICE_IN * 0.1
        + cache_write * PRICE_IN * 1.25
        + out * PRICE_OUT
    )


# ── ClickHouse (via the `ch` CLI; one statement per call) ──────────────────
def ch_rows(sql: str) -> list[dict]:
    env = {**os.environ, "CH_FORMAT": "JSONEachRow"}
    out = subprocess.run(["ch", sql], capture_output=True, text=True, env=env)
    if out.returncode != 0:
        sys.exit(f"ch error:\n{out.stderr.strip()}")
    return [json.loads(line) for line in out.stdout.splitlines() if line.strip()]


def fetch_complaints(ent: str, team: str, days: int) -> list[str]:
    sql = f"""
        SELECT report_complaints
        FROM dealer_leads.endcallreports
        WHERE isActive AND NOT __deleted AND NOT isTestCall
          AND enterpriseId = '{ent}' AND teamId = '{team}'
          AND createdAt >= today() - {days}
          AND report_complaints NOT IN ('', '[]', '[""]')
    """.strip()
    rows = ch_rows(sql)
    # report_complaints is a JSON-encoded array string, e.g. '["Bulge in tire",""]'
    items: list[str] = []
    for r in rows:
        raw = r.get("report_complaints") or ""
        try:
            for c in json.loads(raw):
                c = (c or "").strip()
                if c:
                    items.append(c)
        except (json.JSONDecodeError, TypeError):
            continue
    return items


# ── pure-Python clustering (no AI) ─────────────────────────────────────────
def normalize(s: str) -> str:
    return " ".join(s.lower().strip().rstrip(".").split())


def cluster(items: list[str]) -> list[tuple[str, int]]:
    """Exact-dedup, then fuzzy-merge near-duplicates. Returns [(canonical, count)]."""
    exact = Counter(normalize(s) for s in items)
    canonicals: dict[str, int] = {}
    for phrase, count in exact.most_common():  # most frequent wins as canonical
        match = next(
            (c for c in canonicals if difflib.SequenceMatcher(None, c, phrase).ratio() >= FUZZY_RATIO),
            None,
        )
        if match:
            canonicals[match] += count
        else:
            canonicals[phrase] = count
    return sorted(canonicals.items(), key=lambda kv: kv[1], reverse=True)


# ── AI theme labelling (Haiku, once, capped) ───────────────────────────────
THEME_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["themes"],
    "properties": {
        "themes": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["theme", "indices"],
                "properties": {
                    "theme": {"type": "string"},
                    "indices": {"type": "array", "items": {"type": "integer"}},
                },
            },
        }
    },
}


def build_messages(clusters: list[tuple[str, int]]) -> list[dict]:
    numbered = "\n".join(f"{i}. {phrase}" for i, (phrase, _) in enumerate(clusters))
    prompt = (
        "These are unique customer complaints/objections from dealership calls, one per line. "
        "Group them into 6-10 concise, business-readable themes (e.g. 'Pricing', 'Wait time', "
        "'Vehicle availability', 'Parts/repair quality'). Assign every line index to exactly one theme.\n\n"
        f"{numbered}"
    )
    return [{"role": "user", "content": prompt}]


def label_with_ai(clusters: list[tuple[str, int]], ledger: dict, dry_run: bool):
    if not os.environ.get("ANTHROPIC_API_KEY"):
        print("\n[AI skipped] ANTHROPIC_API_KEY not set — showing pure-Python clusters only.")
        return None
    try:
        from anthropic import Anthropic
    except ImportError:
        print("\n[AI skipped] `pip install anthropic` to enable theme labelling.")
        return None

    remaining = HARD_CAP_USD - ledger["total_spent_usd"]
    if remaining <= 0:
        print(f"\n[AI BLOCKED] ${HARD_CAP_USD:.2f} cap reached (spent ${ledger['total_spent_usd']:.4f}). Refusing call.")
        return None

    client = Anthropic()
    messages = build_messages(clusters)

    # Pre-flight: count input tokens, project worst-case cost, check the cap.
    try:
        counted = client.messages.count_tokens(model=MODEL, messages=messages)
        in_tokens = counted.input_tokens
    except Exception as e:  # noqa: BLE001 — count_tokens is best-effort
        print(f"\n[AI warn] count_tokens failed ({e}); estimating from chars.")
        in_tokens = sum(len(m["content"]) for m in messages) // 4

    projected = in_tokens * PRICE_IN + MAX_OUTPUT_TOKENS * PRICE_OUT
    print(
        f"\n[cost] spent ${ledger['total_spent_usd']:.4f} / ${HARD_CAP_USD:.2f} "
        f"· this run ≤ ${projected:.4f} ({in_tokens} in + ≤{MAX_OUTPUT_TOKENS} out)"
    )
    if projected > remaining:
        print(f"[AI BLOCKED] projected ${projected:.4f} would exceed remaining ${remaining:.4f}. Refusing call.")
        return None
    if dry_run:
        print("[dry-run] not calling the API.")
        return None

    resp = client.messages.create(
        model=MODEL,
        max_tokens=MAX_OUTPUT_TOKENS,
        messages=messages,
        output_config={"format": {"type": "json_schema", "schema": THEME_SCHEMA}},
    )
    usd = cost_of(resp.usage)
    record_spend(
        ledger,
        usd,
        {"input_tokens": resp.usage.input_tokens, "output_tokens": resp.usage.output_tokens},
        label=f"objections n={len(clusters)}",
    )
    print(f"[cost] actual ${usd:.4f} · cumulative ${ledger['total_spent_usd']:.4f}")

    text = next((b.text for b in resp.content if getattr(b, "type", None) == "text"), "{}")
    return json.loads(text)["themes"]


# ── presentation ───────────────────────────────────────────────────────────
def main() -> None:
    ap = argparse.ArgumentParser(description="Top objections — clustered, AI-themed, $50-capped.")
    ap.add_argument("--ent", required=True, help="enterpriseId")
    ap.add_argument("--team", required=True, help="teamId")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--no-ai", action="store_true", help="pure-Python clusters only")
    ap.add_argument("--dry-run", action="store_true", help="estimate AI cost, don't call")
    ap.add_argument("--top", type=int, default=20, help="rows to print for raw clusters")
    args = ap.parse_args()
    load_env_local()  # pick up ANTHROPIC_API_KEY from .env.local if it isn't already exported

    items = fetch_complaints(args.ent, args.team, args.days)
    print(f"Pulled {len(items)} complaint phrases ({args.ent}/{args.team}, last {args.days}d).")
    if not items:
        print("No free-text objections in window.")
        return

    clusters = cluster(items)
    print(f"\n── Clusters (pure Python: exact + fuzzy@{FUZZY_RATIO}) — top {args.top} of {len(clusters)} ──")
    for phrase, count in clusters[: args.top]:
        print(f"{count:>4}  {phrase}")

    if args.no_ai:
        return

    ledger = load_ledger()
    themes = label_with_ai(clusters, ledger, args.dry_run)
    if not themes:
        return

    print("\n── Top objections by theme (Haiku-labelled, Python-counted) ──")
    ranked = []
    for t in themes:
        vol = sum(clusters[i][1] for i in t["indices"] if 0 <= i < len(clusters))
        ranked.append((t["theme"], vol, [clusters[i][0] for i in t["indices"] if 0 <= i < len(clusters)]))
    for theme, vol, examples in sorted(ranked, key=lambda x: x[1], reverse=True):
        print(f"{vol:>4}  {theme}")
        for ex in examples[:3]:
            print(f"        · {ex}")


if __name__ == "__main__":
    main()
