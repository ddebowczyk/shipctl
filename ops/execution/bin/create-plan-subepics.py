#!/usr/bin/env python3
"""Render, materialize, and verify a plan-backed Beads epic hierarchy."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import yaml
from jinja2 import Environment, StrictUndefined


REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_CONFIG = (
    REPO_ROOT / "var/execution/agent-module-control-plane/epic.yaml"
)
KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")
NUMBER_PATTERN = re.compile(
    r"^[+-]?[0-9]+(?:\.[0-9]+)?(?:e[+-]?[0-9]+)?$", re.IGNORECASE
)
ISSUE_INDEX: dict[str, list[dict[str, Any]]] | None = None


class ExecutionConfigError(RuntimeError):
    """Raised when source configuration or materialized state is invalid."""


class IndentedSafeDumper(yaml.SafeDumper):
    def increase_indent(self, flow: bool = False, indentless: bool = False) -> Any:
        return super().increase_indent(flow, False)


class OutputParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        output = "json" if "--output" in sys.argv and "json" in sys.argv else "toon"
        emit(
            {
                "status": "error",
                "operation": "parse",
                "error": {"code": "usage", "message": message},
            },
            output,
        )
        raise SystemExit(2)


def quote_toon_string(value: str, delimiter: str = ",") -> str:
    must_quote = (
        value == ""
        or value[0] in " \t-#"
        or value[-1] in " \t"
        or value in {"true", "false", "null"}
        or NUMBER_PATTERN.fullmatch(value) is not None
        or any(character in value for character in ':"\\[]{}')
        or delimiter in value
        or any(ord(character) < 32 for character in value)
    )
    return json.dumps(value, ensure_ascii=False) if must_quote else value


def toon_key(value: str) -> str:
    return value if KEY_PATTERN.fullmatch(value) else json.dumps(value, ensure_ascii=False)


def toon_scalar(value: Any, delimiter: str = ",") -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        return str(value).lower()
    return quote_toon_string(str(value), delimiter)


def encode_toon_object(value: dict[str, Any], depth: int = 0) -> list[str]:
    indent = "  " * depth
    lines: list[str] = []
    for key, item in value.items():
        encoded_key = toon_key(str(key))
        if isinstance(item, dict):
            lines.append(f"{indent}{encoded_key}:")
            lines.extend(encode_toon_object(item, depth + 1))
            continue
        if isinstance(item, list):
            if not item:
                lines.append(f"{indent}{encoded_key}: []")
                continue
            if all(not isinstance(entry, (dict, list)) for entry in item):
                values = ",".join(toon_scalar(entry) for entry in item)
                lines.append(f"{indent}{encoded_key}[{len(item)}]: {values}")
                continue
            if all(isinstance(entry, dict) for entry in item):
                fields = list(item[0].keys())
                uniform = all(list(entry.keys()) == fields for entry in item)
                primitive = all(
                    not isinstance(cell, (dict, list))
                    for entry in item
                    for cell in entry.values()
                )
                if uniform and primitive:
                    header = ",".join(toon_key(str(field)) for field in fields)
                    lines.append(
                        f"{indent}{encoded_key}[{len(item)}]{{{header}}}:"
                    )
                    for entry in item:
                        row = ",".join(toon_scalar(entry[field]) for field in fields)
                        lines.append(f"{indent}  {row}")
                    continue
            raise ExecutionConfigError(
                f"TOON output does not support mixed nested list at {key}"
            )
        lines.append(f"{indent}{encoded_key}: {toon_scalar(item)}")
    return lines


def emit(payload: dict[str, Any], output: str) -> None:
    if output == "json":
        rendered = json.dumps(payload, ensure_ascii=False, indent=2)
    else:
        rendered = "\n".join(encode_toon_object(payload))
    sys.stdout.write(rendered)


def load_yaml(path: Path) -> dict[str, Any]:
    try:
        value = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as error:
        raise ExecutionConfigError(f"cannot read YAML {path}: {error}") from error
    if not isinstance(value, dict):
        raise ExecutionConfigError(f"YAML root must be an object: {path}")
    return value


def repo_path(raw_path: str, *, must_exist: bool = False) -> Path:
    path = (REPO_ROOT / raw_path).resolve()
    if not path.is_relative_to(REPO_ROOT):
        raise ExecutionConfigError(f"path escapes repository: {raw_path}")
    if must_exist and not path.exists():
        raise ExecutionConfigError(f"required path does not exist: {raw_path}")
    return path


def require_keys(value: dict[str, Any], keys: set[str], source: Path) -> None:
    missing = sorted(keys - value.keys())
    if missing:
        raise ExecutionConfigError(f"{source} is missing keys: {', '.join(missing)}")


def load_configuration(config_path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    config = load_yaml(config_path)
    require_keys(
        config,
        {
            "schema_version",
            "plan_id",
            "title",
            "overall_goal",
            "plan_root",
            "phases_dir",
            "template",
            "rendered_dir",
            "actions_root",
            "state_file",
            "parent",
        },
        config_path,
    )
    if config["schema_version"] != 1:
        raise ExecutionConfigError(f"unsupported schema version in {config_path}")

    plan_root = repo_path(str(config["plan_root"]), must_exist=True)
    phases_dir = repo_path(str(config["phases_dir"]), must_exist=True)
    repo_path(str(config["template"]), must_exist=True)
    repo_path(str(config["rendered_dir"]))
    actions_root = repo_path(str(config["actions_root"]))
    repo_path(str(config["state_file"]))

    phase_paths = sorted(phases_dir.glob("*.yaml"))
    if not phase_paths:
        raise ExecutionConfigError(f"no phase YAML files found in {phases_dir}")

    phases: list[dict[str, Any]] = []
    phase_keys: set[str] = set()
    sequences: set[int] = set()
    configured_documents: set[Path] = set()
    phase_required = {
        "schema_version",
        "sequence",
        "key",
        "phase_label",
        "title",
        "role",
        "document",
        "action_plan_dir",
    }
    for phase_path in phase_paths:
        phase = load_yaml(phase_path)
        require_keys(phase, phase_required, phase_path)
        if phase["schema_version"] != 1:
            raise ExecutionConfigError(f"unsupported schema version in {phase_path}")
        if phase["role"] not in {"governance", "phase"}:
            raise ExecutionConfigError(f"invalid role in {phase_path}: {phase['role']}")
        if not isinstance(phase["sequence"], int) or phase["sequence"] < 1:
            raise ExecutionConfigError(f"invalid sequence in {phase_path}")
        if phase["key"] in phase_keys:
            raise ExecutionConfigError(f"duplicate phase key: {phase['key']}")
        if phase["sequence"] in sequences:
            raise ExecutionConfigError(f"duplicate phase sequence: {phase['sequence']}")

        document = (plan_root / str(phase["document"])).resolve()
        if document.parent != plan_root or document.suffix != ".md":
            raise ExecutionConfigError(
                f"phase document is not a Markdown chapter in plan root: {document}"
            )
        action_plan_path = (actions_root / str(phase["action_plan_dir"])).resolve()
        if not action_plan_path.is_relative_to(actions_root):
            raise ExecutionConfigError(
                f"action plan path escapes actions root: {action_plan_path}"
            )
        phase["source_yaml"] = phase_path
        phase["document_path"] = document
        phase["document"] = str(document.relative_to(REPO_ROOT))
        phase["action_plan_dir"] = str(action_plan_path.relative_to(REPO_ROOT))
        phase_keys.add(str(phase["key"]))
        sequences.add(int(phase["sequence"]))
        configured_documents.add(document)
        phases.append(phase)

    phases.sort(key=lambda phase: phase["sequence"])
    expected_sequences = list(range(1, len(phases) + 1))
    if [phase["sequence"] for phase in phases] != expected_sequences:
        raise ExecutionConfigError("phase sequences must form one ordered chain from 1")

    plan_documents = {path.resolve() for path in plan_root.glob("*.md")}
    if configured_documents != plan_documents:
        missing = sorted(str(path) for path in plan_documents - configured_documents)
        extra = sorted(str(path) for path in configured_documents - plan_documents)
        raise ExecutionConfigError(
            f"phase YAML must map one-to-one to plan Markdown; missing={missing}, extra={extra}"
        )
    return config, phases


def read_state(config: dict[str, Any]) -> dict[str, str]:
    state_path = repo_path(str(config["state_file"]))
    if not state_path.exists():
        return {}
    state = load_yaml(state_path)
    entries = state.get("subepics", [])
    if not isinstance(entries, list):
        raise ExecutionConfigError(f"invalid subepics list in {state_path}")
    return {
        str(entry["key"]): str(entry["id"])
        for entry in entries
        if isinstance(entry, dict) and "key" in entry and "id" in entry
    }


def write_if_changed(path: Path, content: str) -> bool:
    current = path.read_text(encoding="utf-8") if path.exists() else None
    if current == content:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return True


def render_subepics(
    config: dict[str, Any],
    phases: list[dict[str, Any]],
    issue_ids: dict[str, str],
) -> tuple[list[dict[str, Any]], int]:
    template_path = repo_path(str(config["template"]), must_exist=True)
    template = Environment(
        undefined=StrictUndefined,
        autoescape=False,
        keep_trailing_newline=True,
        trim_blocks=True,
        lstrip_blocks=True,
    ).from_string(template_path.read_text(encoding="utf-8"))
    rendered_dir = repo_path(str(config["rendered_dir"]))
    rendered: list[dict[str, Any]] = []
    changed = 0
    for index, phase in enumerate(phases):
        previous_phase = phases[index - 1] if index > 0 else None
        next_phase = phases[index + 1] if index + 1 < len(phases) else None
        body = template.render(
            **phase,
            overall_goal=config["overall_goal"],
            document_full_path=str(phase["document_path"]),
            subepic_id=issue_ids.get(str(phase["key"]), "<this-subepic-id>"),
            previous_title=previous_phase["title"] if previous_phase else None,
            next_title=next_phase["title"] if next_phase else None,
        )
        body = re.sub(r"\n{3,}", "\n\n", body)
        output_path = rendered_dir / f"{phase['sequence']:02d}-{phase['key']}.md"
        changed += int(write_if_changed(output_path, body))
        rendered.append({"phase": phase, "path": output_path, "body": body})
    return rendered, changed


def parent_body(config: dict[str, Any], phases: list[dict[str, Any]]) -> str:
    plan_root = repo_path(str(config["plan_root"]), must_exist=True)
    order = "\n".join(
        f"{phase['sequence']}. {phase['phase_label']} — {phase['title']}"
        for phase in phases
    )
    return f"""# {config['title']}

## Overall goal

{config['overall_goal']}

## Plan authority

Read the plan from `{plan_root}`. Every Markdown chapter maps to one ordered
subepic. Chapter details remain authoritative; subepics define the common
execution, diagnostic, task-creation, closure, and commit process.

## Execution order

{order}

Claim this parent epic, start the first ready subepic immediately, and continue
through the dependency chain. Close the parent only after every subepic and its
children are closed, every phase exit proof is recorded, the full-application
verification passes, and the final git and Beads states are clean.
"""


def run_bd_json(arguments: list[str], body: str | None = None) -> Any:
    if shutil.which("bd") is None:
        raise ExecutionConfigError("required command is not installed: bd")
    completed = subprocess.run(
        ["bd", *arguments, "--json"],
        cwd=REPO_ROOT,
        input=body,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stdout.strip() or completed.stderr.strip()
        raise ExecutionConfigError(
            f"bd {' '.join(arguments)} failed with {completed.returncode}: {detail}"
        )
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise ExecutionConfigError(
            f"bd {' '.join(arguments)} returned invalid JSON: {completed.stdout!r}"
        ) from error


def issue_index() -> dict[str, list[dict[str, Any]]]:
    global ISSUE_INDEX
    if ISSUE_INDEX is None:
        ISSUE_INDEX = {}
        for issue in run_bd_json(["list", "--all", "--flat", "--limit", "0"]):
            external_ref = issue.get("external_ref")
            if external_ref:
                ISSUE_INDEX.setdefault(str(external_ref), []).append(issue)
    return ISSUE_INDEX


def remember_issue(issue: dict[str, Any]) -> None:
    external_ref = issue.get("external_ref")
    if not external_ref:
        return
    index = issue_index()
    index[str(external_ref)] = [issue]


def find_issue(external_ref: str) -> dict[str, Any] | None:
    exact = issue_index().get(external_ref, [])
    if len(exact) > 1:
        raise ExecutionConfigError(f"duplicate Beads external ref: {external_ref}")
    return exact[0] if exact else None


def upsert_epic(
    *,
    title: str,
    external_ref: str,
    specification: str,
    body: str,
    parent: str | None = None,
) -> tuple[dict[str, Any], bool]:
    issue = find_issue(external_ref)
    common = [
        "--title",
        title,
        "--type",
        "epic",
        "--external-ref",
        external_ref,
        "--spec-id",
        specification,
        "--body-file",
        "-",
    ]
    if parent is not None:
        common.extend(["--parent", parent])
    if issue is None:
        created = run_bd_json(["create", *common], body)
        remember_issue(created)
        return created, True
    updated = run_bd_json(["update", str(issue["id"]), *common], body)
    if isinstance(updated, list):
        updated = updated[0]
    remember_issue(updated)
    return updated, False


def block_dependency_map(issue_ids: list[str]) -> dict[str, set[str]]:
    dependencies = run_bd_json(
        ["dep", "list", *issue_ids, "--type", "blocks"]
    )
    mapped = {issue_id: set() for issue_id in issue_ids}
    for dependency in dependencies:
        issue_id = dependency.get("issue_id")
        depends_on_id = dependency.get("depends_on_id")
        if issue_id in mapped and depends_on_id:
            mapped[str(issue_id)].add(str(depends_on_id))
    return mapped


def save_state(
    config: dict[str, Any], parent: dict[str, Any], children: list[dict[str, Any]]
) -> None:
    state = {
        "schema_version": 1,
        "plan_id": config["plan_id"],
        "parent": {"id": parent["id"]},
        "subepics": [
            {
                "sequence": child["sequence"],
                "key": child["key"],
                "id": child["id"],
            }
            for child in children
        ],
    }
    content = yaml.dump(
        state,
        Dumper=IndentedSafeDumper,
        sort_keys=False,
        allow_unicode=True,
        explicit_start=True,
    )
    write_if_changed(repo_path(str(config["state_file"])), content)


def apply_hierarchy(
    config: dict[str, Any], phases: list[dict[str, Any]]
) -> dict[str, Any]:
    parent_config = config["parent"]
    parent, parent_created = upsert_epic(
        title=str(config["title"]),
        external_ref=str(parent_config["external_ref"]),
        specification=str(parent_config["specification"]),
        body=parent_body(config, phases),
    )

    known_ids = read_state(config)
    prelim_rendered, _ = render_subepics(config, phases, known_ids)
    children: list[dict[str, Any]] = []
    created_count = 0
    for entry in prelim_rendered:
        phase = entry["phase"]
        external_ref = f"plan:{config['plan_id']}#{phase['key']}"
        child = find_issue(external_ref)
        created = child is None
        if child is None:
            child, _ = upsert_epic(
                title=f"{phase['phase_label']}: {phase['title']}",
                external_ref=external_ref,
                specification=str(phase["document"]),
                body=entry["body"],
                parent=str(parent["id"]),
            )
        created_count += int(created)
        children.append(
            {
                "sequence": phase["sequence"],
                "key": phase["key"],
                "id": child["id"],
                "title": child["title"],
                "status": child["status"],
                "external_ref": external_ref,
            }
        )

    final_ids = {child["key"]: child["id"] for child in children}
    final_rendered, rendered_changed = render_subepics(config, phases, final_ids)
    for child, entry in zip(children, final_rendered):
        phase = entry["phase"]
        upsert_epic(
            title=f"{phase['phase_label']}: {phase['title']}",
            external_ref=child["external_ref"],
            specification=str(phase["document"]),
            body=entry["body"],
            parent=str(parent["id"]),
        )

    child_ids = [str(child["id"]) for child in children]
    dependencies = block_dependency_map(child_ids)
    dependency_changes = 0
    for previous, current in zip(children, children[1:]):
        if previous["id"] not in dependencies[current["id"]]:
            run_bd_json(["dep", "add", current["id"], previous["id"]])
            dependency_changes += 1

    save_state(config, parent, children)
    verification = verify_hierarchy(config, phases)
    return {
        "status": "ok",
        "operation": "apply",
        "parent": {
            "id": parent["id"],
            "title": parent["title"],
            "created": parent_created,
        },
        "subepics": children,
        "summary": {
            "subepic_count": len(children),
            "created_count": created_count,
            "dependency_changes": dependency_changes,
            "rendered_changes": rendered_changed,
            "verified": verification["summary"]["verified"],
        },
    }


def verify_hierarchy(
    config: dict[str, Any], phases: list[dict[str, Any]]
) -> dict[str, Any]:
    parent_ref = str(config["parent"]["external_ref"])
    parent_match = find_issue(parent_ref)
    if parent_match is None:
        raise ExecutionConfigError(f"parent epic does not exist: {parent_ref}")
    parent = parent_match
    if parent.get("issue_type") != "epic" or parent.get("parent") is not None:
        raise ExecutionConfigError("materialized parent is not a top-level epic")

    direct_children = run_bd_json(["children", str(parent["id"])])
    expected_refs = {f"plan:{config['plan_id']}#{phase['key']}" for phase in phases}
    relevant = [
        child for child in direct_children if child.get("external_ref") in expected_refs
    ]
    if len(relevant) != len(phases):
        raise ExecutionConfigError(
            f"expected {len(phases)} direct plan subepics, found {len(relevant)}"
        )
    if {child.get("external_ref") for child in relevant} != expected_refs:
        raise ExecutionConfigError("direct subepic external refs do not match phase YAML")

    issue_ids = {
        str(phase["key"]): str(
            next(
                child["id"]
                for child in relevant
                if child.get("external_ref")
                == f"plan:{config['plan_id']}#{phase['key']}"
            )
        )
        for phase in phases
    }
    rendered, rendered_changes = render_subepics(config, phases, issue_ids)
    issues_by_id = {str(issue["id"]): issue for issue in relevant}
    dependencies = block_dependency_map(list(issues_by_id))
    ordered: list[dict[str, Any]] = []
    for index, entry in enumerate(rendered):
        phase = entry["phase"]
        issue = issues_by_id[issue_ids[str(phase["key"])]]
        expected_title = f"{phase['phase_label']}: {phase['title']}"
        if issue.get("issue_type") != "epic":
            raise ExecutionConfigError(f"subepic has wrong type: {issue['id']}")
        if issue.get("parent") != parent["id"]:
            raise ExecutionConfigError(f"subepic has wrong parent: {issue['id']}")
        if issue.get("title") != expected_title:
            raise ExecutionConfigError(f"subepic has wrong title: {issue['id']}")
        if issue.get("spec_id") != phase["document"]:
            raise ExecutionConfigError(f"subepic has wrong specification: {issue['id']}")
        if issue.get("description", "").rstrip() != entry["body"].rstrip():
            raise ExecutionConfigError(f"subepic body drift: {issue['id']}")

        dependency_ids = dependencies[str(issue["id"])]
        expected_dependency_ids = (
            {issue_ids[str(phases[index - 1]["key"])]} if index > 0 else set()
        )
        if dependency_ids != expected_dependency_ids:
            raise ExecutionConfigError(
                f"subepic dependency drift for {issue['id']}: "
                f"expected={sorted(expected_dependency_ids)}, actual={sorted(dependency_ids)}"
            )
        ordered.append(
            {
                "sequence": phase["sequence"],
                "id": issue["id"],
                "title": issue["title"],
                "status": issue["status"],
            }
        )

    cycles = run_bd_json(["dep", "cycles"])
    if cycles:
        raise ExecutionConfigError(f"Beads dependency graph contains cycles: {cycles}")

    state_ids = read_state(config)
    if state_ids != issue_ids:
        raise ExecutionConfigError("bd-state.yaml does not match materialized subepics")
    return {
        "status": "ok",
        "operation": "verify",
        "parent": {"id": parent["id"], "title": parent["title"], "status": parent["status"]},
        "subepics": ordered,
        "summary": {
            "subepic_count": len(ordered),
            "rendered_changes": rendered_changes,
            "verified": True,
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = OutputParser(
        description="Render, create, or verify a plan-backed Beads epic hierarchy."
    )
    parser.add_argument(
        "operation", choices=("render", "apply", "verify"), help="operation to run"
    )
    parser.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CONFIG,
        help="epic YAML configuration path",
    )
    parser.add_argument(
        "--output",
        choices=("toon", "json"),
        default="toon",
        help="structured output format (default: toon)",
    )
    return parser


def main() -> int:
    arguments = build_parser().parse_args()
    try:
        config_path = arguments.config
        if not config_path.is_absolute():
            config_path = (REPO_ROOT / config_path).resolve()
        if not config_path.is_relative_to(REPO_ROOT):
            raise ExecutionConfigError(f"config path escapes repository: {config_path}")
        config, phases = load_configuration(config_path)
        if arguments.operation == "render":
            rendered, changed = render_subepics(config, phases, read_state(config))
            payload = {
                "status": "ok",
                "operation": "render",
                "rendered_files": [str(entry["path"].relative_to(REPO_ROOT)) for entry in rendered],
                "summary": {"rendered_count": len(rendered), "changed_count": changed},
            }
        elif arguments.operation == "apply":
            payload = apply_hierarchy(config, phases)
        else:
            payload = verify_hierarchy(config, phases)
        emit(payload, arguments.output)
        return 0
    except ExecutionConfigError as error:
        emit(
            {
                "status": "error",
                "operation": arguments.operation,
                "error": {"code": "execution_config", "message": str(error)},
            },
            arguments.output,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
