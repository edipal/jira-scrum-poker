import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple, Union
import sys

from lintel.events import read_events

REVIEWER_ROLES: Set[str] = {
    "po-reviewer",
    "architect-reviewer",
    "qa-reviewer",
    "dev-reviewer",
}

ALL_KNOWN_ROLES: Set[str] = REVIEWER_ROLES | {
    "po",
    "architect",
    "qa",
    "dev",
    "arbiter",
    "final-reviewer",
}

_STAGE_SEQ_DIR_RE = re.compile(
    r"^(?:(?P<role>[a-z-]+)-)?(?P<stage>r\d+|p\d+|phase-\d+|docs|final|plan)-(?P<seq>\d+)$"
)


def _extract_finding_scope_and_run(f_path: Path, task_id: str) -> Tuple[str, str, str]:
    """Return (role_scope, stage_scope, normalized_run_id) for a findings.json path.

    Scopes finding IDs (like 'F1') to their reviewer role and stage loop so that
    independent loops (e.g. po-reviewer/r0-1 vs po-reviewer/docs-1 or qa-reviewer/p1-1)
    do not collide on generic IDs while multi-round loops (r0-1 vs r0-2, dev/r1 vs dev/r2,
    runs/run-1 vs runs/run-2) still aggregate under the same scope key.
    """
    run_dir = f_path.parent.name
    parent_above = f_path.parent.parent.name if f_path.parent.parent else ""
    role_scope = (
        parent_above
        if parent_above not in (task_id, "runs", "tasks", "state", "")
        else ""
    )
    stage_scope = ""
    norm_run = run_dir
    m = _STAGE_SEQ_DIR_RE.match(run_dir)
    if m:
        stage_scope = m.group("stage")
        norm_run = f"{stage_scope}-{m.group('seq')}"
        cand_role = m.group("role")
        if not role_scope and cand_role in ALL_KNOWN_ROLES:
            role_scope = cand_role
    return (role_scope, stage_scope, norm_run)

REVIEWER_TO_WRITER: Dict[str, str] = {
    "po-reviewer": "po",
    "architect-reviewer": "architect",
    "qa-reviewer": "qa",
    "dev-reviewer": "dev",
}

EXIT_NO_TESTS = 3


def _is_gate_failed(status: Optional[str], exit_code: Optional[int]) -> bool:
    """Determine whether a gate or test group run counts as a failure."""
    if exit_code == 0 or status == "no-tests":
        return False
    if status == "red":
        return True
    if exit_code == EXIT_NO_TESTS:
        return False
    return exit_code is not None

def get_tasks_dir(repo_root: Path) -> Path:
    return repo_root / ".lintel" / "tasks"


def _load_finished_tasks_map(state_dir: Path) -> Dict[str, Dict[str, Any]]:
    fin_file = state_dir / "finished.json"
    if not fin_file.is_file():
        return {}
    try:
        doc = json.loads(fin_file.read_text(encoding="utf-8"))
        if isinstance(doc, dict):
            return {
                str(rec["id"]): rec
                for rec in doc.get("tasks", [])
                if isinstance(rec, dict) and rec.get("id")
            }
    except Exception:
        pass
    return {}


def run_stats(repo_root: Union[str, Path], task_id: Optional[str] = None, as_json: bool = False) -> None:
    root = Path(repo_root).resolve()
    stats_data = compute_stats(root, task_id)
    format_stats(stats_data, as_json)

def compute_stats(repo_root: Path, task_id: Optional[str] = None) -> Dict[str, Any]:
    tasks_dir = get_tasks_dir(repo_root)
    state_dir = repo_root / ".lintel" / "state"
    finished_map = _load_finished_tasks_map(state_dir)

    task_dirs = []
    if task_id:
        target = tasks_dir / task_id if tasks_dir.is_dir() else None
        state_target = state_dir / task_id if state_dir.is_dir() else None
        has_target_events = bool(target and target.is_dir() and (target / "events.jsonl").is_file())
        has_state_files = bool(
            state_target
            and state_target.is_dir()
            and (
                (state_target / "events.jsonl").is_file()
                or (state_target / "task.json").is_file()
                or (state_target / "checks.json").is_file()
            )
        )
        if target and target.is_dir() and (has_target_events or has_state_files):
            task_dirs.append(target)
        elif state_target and state_target.is_dir():
            task_dirs.append(state_target)
        elif target and target.is_dir():
            task_dirs.append(target)
        elif task_id in finished_map:
            task_dirs.append(tasks_dir / task_id)
        else:
            try:
                from lintel import git
                ls_res = git.run_git(
                    ["ls-tree", "-r", "--name-only", f"lintel/{task_id}", "--", f".lintel/tasks/{task_id}"],
                    repo_root,
                    check=False,
                )
                if ls_res.returncode == 0 and ls_res.stdout.strip():
                    task_dirs.append(tasks_dir / task_id)
            except Exception:
                pass
    else:
        discovered_tasks: Dict[str, Path] = {}
        if tasks_dir.is_dir():
            for d in sorted(tasks_dir.iterdir()):
                if not d.is_dir() or d.name.startswith("."):
                    continue
                has_events = (d / "events.jsonl").is_file()
                has_state_events = state_dir.is_dir() and (state_dir / d.name / "events.jsonl").is_file()
                has_state_task = state_dir.is_dir() and (state_dir / d.name / "task.json").is_file()
                has_state_checks = state_dir.is_dir() and (state_dir / d.name / "checks.json").is_file()
                if has_events or has_state_events or has_state_task or has_state_checks:
                    discovered_tasks[d.name] = d

        if state_dir.is_dir():
            for d in sorted(state_dir.iterdir()):
                if not d.is_dir() or d.name.startswith("."):
                    continue
                if d.name not in discovered_tasks:
                    if (d / "events.jsonl").is_file() or (d / "task.json").is_file() or (d / "checks.json").is_file():
                        discovered_tasks[d.name] = d

        for tid in finished_map:
            if tid not in discovered_tasks:
                discovered_tasks[tid] = tasks_dir / tid

        task_dirs = list(discovered_tasks.values())

    if not task_dirs:
        return _empty_stats()

    stats = _empty_stats()
    stats["tasks"] = len(task_dirs)

    shared_audit_events = None
    state_audit = state_dir / "audit.jsonl"
    if state_audit.is_file():
        try:
            from lintel.audit import parse_audit_log
            shared_audit_events = parse_audit_log(state_audit)
        except Exception:
            shared_audit_events = None

    for t_dir in task_dirs:
        _process_task(
            t_dir,
            stats,
            repo_root,
            shared_audit_events=shared_audit_events,
            finished_map=finished_map,
        )

    # Normalize aggregate time per step across all processed tasks
    ts = stats["time_per_step"]
    if ts["count"] > 0:
        ts["mean_sec"] = ts["total_duration_sec"] / ts["count"]
    else:
        ts["mean_sec"] = 0.0
    if ts["min_sec"] == float('inf') or ts["count"] == 0:
        ts["min_sec"] = 0.0

    # Process insights/recommendations based on stats
    _generate_insights(stats)

    return stats

def _empty_stats() -> Dict[str, Any]:
    return {
        "tasks": 0,
        "rounds_per_pair_and_phase": defaultdict(lambda: defaultdict(int)),
        "stall_reasons": defaultdict(int),
        "arbiter_rulings": defaultdict(int),
        "human_decisions": defaultdict(int),
        "time_per_step": {
            "total_duration_sec": 0.0,
            "count": 0,
            "min_sec": 0.0,
            "max_sec": 0.0,
            "mean_sec": 0.0,
        },
        "red_gate_runs": {
            "exit_codes": defaultdict(int),
            "failed_groups": defaultdict(int),
        },
        "recurring_findings": 0,
        "crossings_by_role": defaultdict(lambda: defaultdict(int)),
        "models_by_role": defaultdict(lambda: defaultdict(int)),
        "insights": []
    }

def _process_task(
    task_dir: Path,
    stats: Dict[str, Any],
    repo_root: Path,
    shared_audit_events: Optional[List[Any]] = None,
    finished_map: Optional[Dict[str, Dict[str, Any]]] = None,
) -> None:
    task_id = task_dir.name
    state_task_dir = repo_root / ".lintel" / "state" / task_id
    tasks_task_dir = repo_root / ".lintel" / "tasks" / task_id

    fin_rec = (finished_map or {}).get(task_id, {})
    t_data: Dict[str, Any] = dict(fin_rec) if isinstance(fin_rec, dict) and fin_rec else {"id": task_id}
    t_data.setdefault("id", task_id)

    for task_json in (
        state_task_dir / "task.json",
        task_dir / "task.json",
        tasks_task_dir / "task.json",
    ):
        if task_json.is_file():
            try:
                with open(task_json, "r", encoding="utf-8") as f:
                    loaded_td = json.load(f)
                    if isinstance(loaded_td, dict):
                        t_data = loaded_td
                        break
            except Exception:
                pass

    if isinstance(fin_rec, dict):
        for k in ("head", "branch", "finished_at"):
            if not t_data.get(k) and fin_rec.get(k):
                t_data[k] = fin_rec[k]

    candidate_refs = list(
        dict.fromkeys(
            str(r)
            for r in (
                t_data.get("head"),
                fin_rec.get("head") if isinstance(fin_rec, dict) else None,
                t_data.get("branch"),
                f"lintel/{task_id}",
            )
            if r
        )
    )

    # 0. Find events.jsonl
    events_file: Optional[Path] = None
    for cand_ev in (
        task_dir / "events.jsonl",
        tasks_task_dir / "events.jsonl",
        state_task_dir / "events.jsonl",
    ):
        if cand_ev.is_file() and cand_ev.stat().st_size > 0:
            events_file = cand_ev
            break

    events: List[Dict[str, Any]] = []
    if events_file and events_file.is_file():
        events = read_events(events_file)
    else:
        try:
            from lintel import git
            for git_ref in candidate_refs:
                show_res = git.run_git(
                    ["show", f"{git_ref}:.lintel/tasks/{task_id}/events.jsonl"],
                    repo_root,
                    check=False,
                )
                if show_res.returncode == 0 and show_res.stdout.strip():
                    for line in show_res.stdout.splitlines():
                        line = line.strip()
                        if line:
                            try:
                                parsed_ev = json.loads(line)
                                if isinstance(parsed_ev, dict):
                                    events.append(parsed_ev)
                            except Exception:
                                pass
                    if events:
                        break
        except Exception:
            pass

    finding_occurrences: Dict[Tuple[str, str, str], Set[str]] = defaultdict(set)  # (role, stage, fid) -> runs
    counted_model_runs: Set[str] = set()

    for ev in events:
        event_type = ev.get("event")
        role = ev.get("role")
        stage = ev.get("stage")
        run = ev.get("run")

        # 1. Rounds (PLAN §3.9)
        if event_type == "done" and role and stage:
            if role in REVIEWER_ROLES:
                verdict = ev.get("verdict")
                is_valid_verdict = verdict in ("approve", "changes") or verdict is None
                is_counted = ev.get("row") != "T-STL-10"
                if is_valid_verdict and is_counted:
                    pair = REVIEWER_TO_WRITER.get(role, role.replace("-reviewer", ""))
                    stats["rounds_per_pair_and_phase"][stage][pair] += 1

        # 1b. Models used by role
        if event_type == "done" and role:
            model_used = ev.get("model_name") or ev.get("model_tier")
            if model_used:
                stats["models_by_role"][str(role)][str(model_used)] += 1
                if run:
                    counted_model_runs.add(str(run))

        # 2. Stall reasons
        if event_type == "stall" and ev.get("stall_reason"):
            stats["stall_reasons"][ev["stall_reason"]] += 1

        # 3. Arbiter rulings
        if event_type == "ruling" and ev.get("verdict"):
            stats["arbiter_rulings"][ev["verdict"]] += 1

        # 4. Human decisions
        if event_type == "decide" and ev.get("decision"):
            stats["human_decisions"][ev["decision"]] += 1

        # 5. Time per step (support non-negative duration dur >= 0)
        dur = ev.get("duration_seconds")
        if dur is not None and dur >= 0:
            ts = stats["time_per_step"]
            dur_float = float(dur)
            ts["total_duration_sec"] += dur_float
            if ts["count"] == 0 or dur_float < ts["min_sec"]:
                ts["min_sec"] = dur_float
            if dur_float > ts["max_sec"]:
                ts["max_sec"] = dur_float
            ts["count"] += 1

        # 6a. Red gate runs (events fallback for synthetic test fixtures)
        if event_type in ("check", "deliver"):
            gate = ev.get("gate")
            if gate:
                code = gate.get("exit_code")
                gate_stat = gate.get("status")
                if code is not None and _is_gate_failed(gate_stat, code):
                    stats["red_gate_runs"]["exit_codes"][code] += 1
                if code != 0:
                    for g_name, g_res in gate.items():
                        if g_name in ("exit_code", "status"): continue
                        if isinstance(g_res, dict):
                            g_code = g_res.get("exit") if g_res.get("exit") is not None else g_res.get("exit_code")
                            g_stat = g_res.get("status")
                            if _is_gate_failed(g_stat, g_code):
                                stats["red_gate_runs"]["failed_groups"][g_name] += 1
                        elif isinstance(g_res, int):
                            eff_stat = gate_stat if (code == g_res or code is None) else None
                            if _is_gate_failed(eff_stat, g_res):
                                stats["red_gate_runs"]["failed_groups"][g_name] += 1

    # 6b. Red gate runs from checks.json (§9.9)
    state_checks = state_task_dir / "checks.json"
    checks_file = state_checks if state_checks.is_file() else (task_dir / "checks.json")
    if checks_file.is_file():
        try:
            with open(checks_file, "r", encoding="utf-8") as f:
                checks_doc = json.load(f)
            if isinstance(checks_doc, dict):
                for c in checks_doc.get("checks", []):
                    if not isinstance(c, dict):
                        continue
                    res = c.get("result") or c.get("status")
                    top_exit = c.get("exit_code") if c.get("exit_code") is not None else c.get("exit")
                    groups = c.get("groups") or {}

                    top_exit_failed = top_exit is not None and _is_gate_failed(res, top_exit)
                    run_exit_codes = set()
                    if top_exit_failed:
                        run_exit_codes.add(top_exit)

                    has_group_fail = False
                    if isinstance(groups, dict):
                        for g_name, g_info in groups.items():
                            if isinstance(g_info, dict):
                                g_code = g_info.get("exit") if g_info.get("exit") is not None else g_info.get("exit_code")
                                g_stat = g_info.get("status")
                                if _is_gate_failed(g_stat, g_code):
                                    has_group_fail = True
                                    stats["red_gate_runs"]["failed_groups"][g_name] += 1
                                    if top_exit is None and g_code is not None:
                                        run_exit_codes.add(g_code)
                            elif isinstance(g_info, int):
                                eff_stat = res if (top_exit == g_info or top_exit is None) else None
                                if _is_gate_failed(eff_stat, g_info):
                                    has_group_fail = True
                                    stats["red_gate_runs"]["failed_groups"][g_name] += 1
                                    if top_exit is None:
                                        run_exit_codes.add(g_info)

                    is_red = (res == "red") or top_exit_failed or has_group_fail
                    if is_red and not run_exit_codes:
                        run_exit_codes.add(1)

                    for code in run_exit_codes:
                        stats["red_gate_runs"]["exit_codes"][code] += 1
        except Exception:
            pass

    # 7. Recurring findings (search task_dir, tasks_task_dir, and state_task_dir/runs)
    findings_files: Set[Path] = set()
    for base_d in (tasks_task_dir, task_dir):
        if base_d.is_dir():
            for fpath in base_d.rglob("findings.json"):
                findings_files.add(fpath.resolve())
    if state_task_dir.is_dir():
        runs_dir = state_task_dir / "runs"
        search_dir = runs_dir if runs_dir.is_dir() else state_task_dir
        for fpath in search_dir.rglob("findings.json"):
            findings_files.add(fpath.resolve())

    def _record_findings_items(fdata: Any, f_path: Path) -> None:
        role_scope, stage_scope, norm_run = _extract_finding_scope_and_run(f_path, task_id)
        items = []
        if isinstance(fdata, dict) and "findings" in fdata:
            items = fdata["findings"]
        elif isinstance(fdata, list):
            items = fdata
        if isinstance(items, list):
            for item in items:
                if isinstance(item, dict) and "id" in item:
                    status = item.get("status")
                    if status in ("fixed", "withdrawn"):
                        continue
                    fid = str(item["id"])
                    if fid:
                        finding_occurrences[(role_scope, stage_scope, fid)].add(norm_run)

    for f_file in sorted(findings_files):
        try:
            with open(f_file, "r", encoding="utf-8") as f:
                fdata = json.load(f)
                _record_findings_items(fdata, f_file)
        except Exception:
            pass

    if not findings_files:
        try:
            from lintel import git
            for git_ref in candidate_refs:
                ls_res = git.run_git(
                    ["ls-tree", "-r", "--name-only", str(git_ref), "--", f".lintel/tasks/{task_id}"],
                    repo_root,
                    check=False,
                )
                if ls_res.returncode == 0 and ls_res.stdout.strip():
                    found_any = False
                    for rel_path in sorted(ls_res.stdout.splitlines()):
                        rel_path = rel_path.strip()
                        if rel_path.endswith("/findings.json"):
                            show_res = git.run_git(
                                ["show", f"{git_ref}:{rel_path}"],
                                repo_root,
                                check=False,
                            )
                            if show_res.returncode == 0 and show_res.stdout.strip():
                                fdata = json.loads(show_res.stdout)
                                _record_findings_items(fdata, Path(rel_path))
                                found_any = True
                    if found_any:
                        break
        except Exception:
            pass

    for _scope_key, runs in finding_occurrences.items():
        if len(runs) > 1:
            stats["recurring_findings"] += 1

    # 7b. Fallback to state runs/*.json for models_by_role when not already recorded via events
    if state_task_dir.is_dir():
        runs_dir = state_task_dir / "runs"
        if runs_dir.is_dir():
            for rfile in sorted(runs_dir.glob("*.json")):
                try:
                    with open(rfile, "r", encoding="utf-8") as rf:
                        rdata = json.load(rf)
                    if isinstance(rdata, dict) and rdata.get("state") == "done":
                        rid = str(rdata.get("id") or rfile.stem)
                        rrole = rdata.get("role")
                        rmodel = rdata.get("model_name") or rdata.get("model_tier")
                        if rrole and rmodel and rid not in counted_model_runs:
                            stats["models_by_role"][str(rrole)][str(rmodel)] += 1
                            counted_model_runs.add(rid)
                except Exception:
                    pass

    # 8. Audit crossings by role (PLAN §3.10, TASKS M4-04)
    state_audit = repo_root / ".lintel" / "state" / "audit.jsonl"
    audit_file = task_dir / "audit.jsonl"
    if not audit_file.is_file():
        state_task_audit = state_task_dir / "audit.jsonl"
        if state_task_audit.is_file():
            audit_file = state_task_audit
        elif state_audit.is_file():
            audit_file = state_audit
        else:
            audit_file = None

    cfg = None
    cfg_file = repo_root / ".lintel" / "config.jsonc"
    if cfg_file.is_file():
        try:
            from lintel.config import load_config
            cfg = load_config(cfg_file, workspace_root=repo_root)
        except Exception:
            pass

    findings = []
    try:
        from lintel.audit import detect_crossings
        if audit_file and audit_file.is_file():
            audit_ev_arg: Any = (
                shared_audit_events
                if (audit_file == state_audit and shared_audit_events is not None)
                else audit_file
            )
            findings = detect_crossings(
                repo_root=repo_root,
                audit_events=audit_ev_arg,
                task_data=t_data,
                config=cfg,
            )
        else:
            findings = detect_crossings(
                repo_root=repo_root,
                task_data=t_data,
                config=cfg,
            )
    except Exception:
        findings = []

    if findings:
        for f in findings:
            if getattr(f, "kind", "crossing") == "crossing":
                role = getattr(f, "role", None) or "unknown"
                sev = getattr(f, "severity", None) or "crossing"
                stats["crossings_by_role"][role][sev] += 1
    elif audit_file and audit_file.is_file():
        # Fallback to reading pre-committed crossing records from audit.jsonl
        try:
            with open(audit_file, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line_str = line.strip()
                    if not line_str:
                        continue
                    try:
                        rec = json.loads(line_str)
                    except Exception:
                        continue
                    if not isinstance(rec, dict):
                        continue
                    if rec.get("kind") == "crossing":
                        role = rec.get("role") or "unknown"
                        sev = rec.get("severity") or "crossing"
                        stats["crossings_by_role"][role][sev] += 1
        except Exception:
            pass

def _generate_insights(stats: Dict[str, Any]) -> None:
    ins = stats["insights"]
    if stats["recurring_findings"] > 5:
        ins.append("High number of recurring findings detected. Consider reviewing reviewer personas (QA, Dev-Reviewer) for unclear guidance or writers (Dev, QA) for skill deficits.")
    
    for code, count in stats["red_gate_runs"]["exit_codes"].items():
        if count > 5:
            ins.append(f"Gate exit code {code} occurred {count} times. Look into DEV stubs or local test configuration.")
            
    for stall_reason, count in stats["stall_reasons"].items():
        if count > 2:
            ins.append(f"Frequent stalls due to '{stall_reason}'. Check loop configuration (maxRounds).")

def format_stats(stats: Dict[str, Any], as_json: bool) -> None:
    if as_json:
        def _to_dict(d):
            if isinstance(d, defaultdict):
                return {k: _to_dict(v) for k, v in d.items()}
            return d
        
        out = _to_dict(stats)
        if "time_per_step" in out:
            ts_out = out["time_per_step"]
            if ts_out.get("min_sec") == float('inf') or ts_out.get("count", 0) == 0:
                ts_out["min_sec"] = 0.0
        sys.stdout.write(json.dumps(out, indent=2) + "\n")
        return
        
    sys.stdout.write("=== Lintel Task Statistics ===\n\n")
    sys.stdout.write(f"Tasks processed: {stats['tasks']}\n\n")
    
    sys.stdout.write("1. Rounds per Pair and Phase:\n")
    for phase, pairs in stats["rounds_per_pair_and_phase"].items():
        sys.stdout.write(f"  Phase: {phase}\n")
        for pair, count in pairs.items():
            sys.stdout.write(f"    {pair}: {count}\n")
    if not stats["rounds_per_pair_and_phase"]:
        sys.stdout.write("  (none)\n")
        
    sys.stdout.write("\n2. Stall Reasons:\n")
    for reason, count in stats["stall_reasons"].items():
        sys.stdout.write(f"  {reason}: {count}\n")
    if not stats["stall_reasons"]:
        sys.stdout.write("  (none)\n")
        
    sys.stdout.write("\n3. Arbiter Rulings:\n")
    for ruling, count in stats["arbiter_rulings"].items():
        sys.stdout.write(f"  {ruling}: {count}\n")
    if not stats["arbiter_rulings"]:
        sys.stdout.write("  (none)\n")
        
    sys.stdout.write("\n4. Human Decisions:\n")
    for dec, count in stats["human_decisions"].items():
        sys.stdout.write(f"  {dec}: {count}\n")
    if not stats["human_decisions"]:
        sys.stdout.write("  (none)\n")
        
    ts = stats["time_per_step"]
    min_sec = ts.get("min_sec", 0.0)
    if min_sec == float('inf') or ts.get("count", 0) == 0:
        min_sec = 0.0
    sys.stdout.write("\n5. Time per Step (seconds):\n")
    sys.stdout.write(f"  Mean: {ts.get('mean_sec', 0.0):.2f}\n")
    sys.stdout.write(f"  Min:  {min_sec:.2f}\n")
    sys.stdout.write(f"  Max:  {ts.get('max_sec', 0.0):.2f}\n")
    sys.stdout.write(f"  Total steps with duration: {ts.get('count', 0)}\n")
    
    sys.stdout.write("\n6. Red Gate Runs:\n")
    sys.stdout.write("  Exit Codes:\n")
    for code, count in stats["red_gate_runs"]["exit_codes"].items():
        sys.stdout.write(f"    {code}: {count}\n")
    sys.stdout.write("  Failed Groups:\n")
    for grp, count in stats["red_gate_runs"]["failed_groups"].items():
        sys.stdout.write(f"    {grp}: {count}\n")
    if not stats["red_gate_runs"]["exit_codes"] and not stats["red_gate_runs"]["failed_groups"]:
        sys.stdout.write("  (none)\n")
        
    sys.stdout.write(f"\n7. Recurring Findings: {stats['recurring_findings']}\n")
    
    sys.stdout.write("\n8. Audit Crossings by Role:\n")
    for role, severities in stats["crossings_by_role"].items():
        sys.stdout.write(f"  Role: {role}\n")
        for sev, count in severities.items():
            sys.stdout.write(f"    {sev}: {count}\n")
    if not stats["crossings_by_role"]:
        sys.stdout.write("  (none)\n")

    sys.stdout.write("\n9. Models Used by Role:\n")
    for role, models in stats.get("models_by_role", {}).items():
        sys.stdout.write(f"  Role: {role}\n")
        for mname, count in models.items():
            sys.stdout.write(f"    {mname}: {count}\n")
    if not stats.get("models_by_role"):
        sys.stdout.write("  (none)\n")
        
    sys.stdout.write("\n=== Persona & Skill Insights ===\n")
    for ins in stats["insights"]:
        sys.stdout.write(f"- {ins}\n")
    if not stats["insights"]:
        sys.stdout.write("- No specific insights derived from current stats.\n")
