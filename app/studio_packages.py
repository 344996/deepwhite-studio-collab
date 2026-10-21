"""Canvas production packages ("制作包") that external agents import over MCP.

A package is an inert JSON layout of titled text nodes. Importing it creates an
ordinary canvas through the same idempotent create/edit journal as the graph
tools, so retries never duplicate a canvas and nothing is generated.
"""
import json
import re

from fastapi import HTTPException

import studio_graph as graph
from studio_integrations import packages_root

TOOLS = {"list_canvas_packages", "import_canvas_package"}
ID = re.compile(r"[A-Za-z0-9_-]{1,80}")
VARIABLE = re.compile(r"\{\{\s*([^{}\s]{1,40})\s*\}\}")
MAX_NODES = 40


def _read(path):
    try:
        package = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return None
    if (not isinstance(package, dict) or not ID.fullmatch(str(package.get("id", ""))) or
            package["id"] != path.stem or not isinstance(package.get("name"), str) or
            not isinstance(package.get("nodes"), list) or not 1 <= len(package["nodes"]) <= MAX_NODES):
        return None
    for node in package["nodes"]:
        if (not isinstance(node, dict) or not ID.fullmatch(str(node.get("key", ""))) or
                not isinstance(node.get("text"), str) or len(node["text"]) > 20000 or
                not isinstance(node.get("x"), (int, float)) or not isinstance(node.get("y"), (int, float))):
            return None
    return package


def packages():
    folder = packages_root()
    found = [_read(path) for path in sorted(folder.glob("*.json"))] if folder.is_dir() else []
    return {package["id"]: package for package in found if package}


def _public(package):
    variables = sorted({name for node in package["nodes"]
                        for name in VARIABLE.findall(node["text"] + node.get("title", ""))})
    return {"id": package["id"], "name": package["name"], "version": str(package.get("version", "1.0.0")),
            "description": package.get("description", ""), "skill": package.get("skill", ""),
            "node_count": len(package["nodes"]), "variables": variables,
            "next_steps": package.get("next_steps", "")}


def _fill(text, variables):
    return VARIABLE.sub(lambda match: str(variables.get(match.group(1), match.group(0)))[:2000], text)


def _import(args):
    package = packages().get(args["package_id"])
    if not package:
        raise HTTPException(404, "制作包不存在；请先调用 list_canvas_packages。")
    variables = args.get("variables") or {}
    if not isinstance(variables, dict) or len(variables) > 40 or not all(
            isinstance(key, str) and isinstance(value, (str, int, float)) for key, value in variables.items()):
        raise HTTPException(400, "variables 只能是最多 40 项的文字键值。")
    title = (args.get("title") or "").strip() or _fill(package["name"], variables)
    created = graph._create({"operation_id": args["operation_id"], "project_id": args["project_id"],
                             "title": title[:120], "expected_revision": args["expected_revision"]})
    operations = []
    for node in package["nodes"]:
        operation = {"op": "add_prompt", "key": node["key"], "text": _fill(node["text"], variables)[:20000],
                     "x": float(node["x"]), "y": float(node["y"])}
        if node.get("title"):
            operation["title"] = _fill(str(node["title"]), variables)[:120]
        operations.append(operation)
    edited = graph._edit({"canvas_id": created["canvas_id"], "expected_revision": created["revision"],
                          "operation_id": args["operation_id"] + "-nodes", "operations": operations})
    return {**created, "revision": edited["revision"], "node_ids": edited["node_ids"],
            "package": _public(package)}


def call(name, args):
    if name == "list_canvas_packages":
        return {"items": [_public(package) for package in packages().values()]}
    return _import(args)
