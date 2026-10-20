"""Canvas-bound Agent sessions. Model access uses only the configured provider API."""
import asyncio
import base64
import hashlib
import json
import mimetypes
import os
import re
import sqlite3
import tempfile
import threading
import time
import uuid
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException, Request
import main as core


SESSION_RE = re.compile(r"^[a-f0-9]{32}$")
REQUEST_RE = re.compile(r"^[A-Za-z0-9_-]{8,100}$")
ALLOWED_ATTACHMENTS = {".txt", ".md", ".markdown", ".docx"}
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
MAX_ATTACHMENT_CHARS = 30000
MAX_TURNS = 100
MAX_CONTEXT_CHARS = 120000
MAX_TOOL_ROUNDS = 4
SESSIONS_LOCK = threading.RLock()
WORKERS = {}


def directory():
    path = Path(core.DATA_DIR) / "studio_agent"
    path.mkdir(parents=True, exist_ok=True)
    return path


def session_path(session_id):
    if not SESSION_RE.fullmatch(str(session_id)):
        raise HTTPException(404, "Agent 会话不存在。")
    return directory() / f"{session_id}.json"


def read_session(session_id):
    path = session_path(session_id)
    if not path.is_file():
        raise HTTPException(404, "Agent 会话不存在。")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise HTTPException(500, "Agent 会话记录暂时无法读取。")


def save_session(session):
    """Atomic persistence; exported for the plan apply endpoint."""
    session_id = str(session.get("id") or "")
    path = session_path(session_id)
    session["updated_at"] = int(time.time() * 1000)
    encoded = json.dumps(session, ensure_ascii=False, separators=(",", ":"))
    with SESSIONS_LOCK:
        fd, temporary = tempfile.mkstemp(prefix=session_id + ".", suffix=".tmp", dir=str(path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(encoded)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return session


def public_session(session):
    """Polling does not resend whole scripts and skill packages on every request."""
    result={k:v for k,v in session.items() if k not in ('turns','attachments')}
    hidden={'skill_snapshots','attachment_text','user_content','tool_calls'}
    result['turns']=[{k:v for k,v in t.items() if k not in hidden} for t in session.get('turns',[])]
    result['attachments']=[{k:v for k,v in a.items() if k!='text'} for a in session.get('attachments',[])]
    return result


def _catalog_data():
    """Compatibility for archived assistant tests; runtime uses studio_models."""
    from studio_models import available_models
    return available_models(core)


def _skills():
    import studio_skills
    items = []
    for path in sorted(studio_skills.root().glob("*.json")):
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
            if item.get("id") and item.get("name"):
                items.append({"id": item["id"], "name": item["name"]})
        except (OSError, ValueError):
            continue
    return items


def _plan_api():
    import studio_agent_plans
    return studio_agent_plans


def _get_context(canvas_id, node_ids=None, asset_version_ids=None):
    context = _plan_api().context(canvas_id, node_ids or [], asset_version_ids or [])
    if not isinstance(context, dict):
        raise HTTPException(500, "无法读取当前画布上下文。")
    return context


def _latest_completed_plan(session):
    for turn in reversed(session.get("turns", [])):
        if turn.get("status") == "completed" and turn.get("plan"):
            return turn["plan"]
    return None


def bootstrap(canvas_id):
    if not canvas_id or len(str(canvas_id)) > 100:
        raise HTTPException(400, "请先选择一个画布。")
    _get_context(canvas_id)
    models, targets = _catalog_data()
    return {"models": models, "targets": targets, "skills": _skills()}


def _project_assets(project_id):
    try:
        items = _plan_api().project_assets(project_id)
        return [{k: item[k] for k in ("version_id", "asset_id", "project_id", "name", "kind", "status", "category", "url", "sha256")}
                for item in items if not item.get("missing")]
    except (ImportError, sqlite3.Error, HTTPException):
        return []


def _available_models():
    models, targets = _catalog_data()
    return {"chat": models, "targets": targets}


def available_models():
    """Return the chat and image/video target rows for plan revalidation."""
    return _catalog_data()


def _safe_error(exc, provider_id=""):
    text = str(exc or "")
    try:
        key = core.provider_env_key_value(provider_id) if provider_id else ""
    except Exception:
        key = ""
    if key:
        text = text.replace(key, "[已隐藏]")
    text = re.sub(r"(?i)bearer\s+[^\s,;\"']+", "Bearer [已隐藏]", text)
    text = re.sub(r"\bsk-[\w-]+", "[已隐藏]", text)
    text = re.sub(r"https?://\S+", "[链接已省略]", text)
    if isinstance(exc, httpx.TimeoutException):
        return "模型响应超时。本次请求结果可能不完整；请先核对服务记录，再决定是否重新提问。"
    if isinstance(exc, httpx.HTTPStatusError):
        status = exc.response.status_code
        return {401: "API 密钥无效或已过期。", 403: "账号无权调用此模型。", 402: "API 额度不足。",
                429: "平台繁忙或达到调用频率限制。"}.get(status, f"模型服务返回错误 ({status})。")
    if isinstance(exc, httpx.HTTPError):
        return "无法连接模型服务，请检查网络和平台设置。"
    return text[:500] or "Agent 处理失败，请检查 API 设置后重新提问。"


def _connection(provider_id, model):
    providers = {p.get("id"): p for p in core.load_api_providers()}
    provider = providers.get(provider_id)
    if not provider or not provider.get("enabled", True):
        raise HTTPException(400, "所选 API 平台不存在或已停用。")
    available = _available_models()["chat"]
    if not any(m["provider_id"] == provider_id and m["model"] == model for m in available):
        raise HTTPException(400, "所选对话模型未在启用目录中，请刷新模型列表。")
    key = core.provider_env_key_value(provider_id)
    if not key:
        raise HTTPException(400, "请先在 API 设置中保存密钥。")
    base = str(provider.get("base_url") or "").rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(400, "API 平台地址无效。")
    if parsed.scheme != "https" and parsed.hostname not in ("localhost", "127.0.0.1", "::1"):
        raise HTTPException(400, "远程模型服务必须使用 HTTPS。")
    endpoint = base + "/chat/completions" if base.endswith("/v1") else base + "/v1/chat/completions"
    return provider, endpoint, {"Authorization": "Bearer " + key}


def _skill_snapshots(skill_ids):
    import studio_skills
    if len(skill_ids) > 3 or len(set(skill_ids)) != len(skill_ids):
        raise HTTPException(400, "一次最多选择 3 个不重复的技能。")
    snapshots = {}
    for sid in skill_ids:
        skill = studio_skills.read(sid)
        files = skill.get("files") or {}
        main_text = files.get("SKILL.md", "")
        if not isinstance(main_text, str) or not main_text.strip():
            raise HTTPException(400, "所选技能缺少有效的 SKILL.md。")
        snapshots[sid] = {"name": str(skill.get("name") or sid), "files": files,
                          "instruction": main_text[:40000]}
    return snapshots


def _attachment_text(session, attachment_ids):
    if len(attachment_ids) > 8:
        raise HTTPException(400, "一次最多引用 8 个附件。")
    known = {a["id"]: a for a in session.get("attachments", [])}
    values = []
    for aid in dict.fromkeys(attachment_ids):
        item = known.get(aid)
        if not item:
            raise HTTPException(400, "附件不属于当前会话，请重新选择。")
        values.append(f"【附件：{item['name']}】\n{item['text']}")
    return "\n\n".join(values)


def _system_prompt(context, skill_snapshots, target_models):
    skills = "\n\n".join(f"【技能：{s['name']}，skill_id={sid}；references 文件：{', '.join(p for p in s['files'] if p.startswith('references/')) or '无'}】\n{s['instruction']}"
                           for sid, s in skill_snapshots.items())
    return ("你是 DeepWhite Studio 的画布创作 Agent。你只负责理解需求、读取已授权上下文并提出可审阅的图片/视频节点计划。"
            "绝不执行生成、提交付费任务、直接修改画布或调用外部工具。只使用下面提供的画布节点、资产和工具。"
            "需要引用素材时，在提示词内写 {{asset:VERSION_ID}}，VERSION_ID 必须来自资产目录；计划引用数组也必须使用同一版本 ID。"
            "如果 target_models 中图片或视频项为 null，本轮不能提出该类节点；请先询问用户选择目标。"
            "如果视觉输入未在本轮消息中作为图片发送，明确说明你没有查看图片内容，不得推断图片细节。"
            "修改上一版计划时必须沿用对应节点 key；如上下文提供已写入节点的 target_node_id，应沿用该 ID，便于更新原节点并保留已有生成结果。"
            "最终回答必须是单个 JSON 对象，格式为 {\"reply\":\"给用户的答复\",\"plan\":null 或 {\"nodes\":[{\"key\":\"稳定短键\",\"kind\":\"image或video\",\"title\":\"名称\",\"prompt\":\"提示词\",\"references\":[{\"version_id\":\"...\",\"label\":\"...\"}],\"target_node_id\":\"可选已有节点ID\"}]}}。纯文字问答必须返回 plan=null，并明确答复这是纯文字内容，不会创建画布节点。"
            "不要编造 asset_id、version_id、节点 ID、价格、费用或模型能力。\n\n"
            "本轮画布上下文 JSON：\n" + json.dumps(context, ensure_ascii=False) +
            "\n\n可用生成目标：\n" + json.dumps(target_models, ensure_ascii=False) +
            ("\n\n用户选中的技能指令快照：\n" + skills if skills else ""))


TOOL_DEFINITIONS = [
    {"type": "function", "function": {"name": "read_skill_reference", "description": "读取本轮已选技能中的一份 references 文本。",
        "parameters": {"type": "object", "properties": {"skill_id": {"type": "string"}, "path": {"type": "string"}}, "required": ["skill_id", "path"], "additionalProperties": False}}},
    {"type": "function", "function": {"name": "list_project_assets", "description": "列出当前项目已登记的可用资产版本。",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}},
    {"type": "function", "function": {"name": "list_available_models", "description": "列出当前启用的对话模型和图片/视频生成目标。",
        "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}},
]


def _tool(name, args, session, turn, context):
    try:
        if name == "list_project_assets":
            return {"items": _project_assets(context.get("project_id", session.get("project_id", "default")))}
        if name == "list_available_models":
            return _available_models()
        if name == "read_skill_reference":
            sid, path = args.get("skill_id"), args.get("path", "")
            snapshot = turn.get("skill_snapshots", {}).get(sid)
            pure = PurePosixPath(str(path))
            if not snapshot or pure.is_absolute() or ".." in pure.parts or "\\" in str(path) or not str(path).startswith("references/"):
                return {"error": "只能读取本轮已选技能的 references/ 文本。"}
            text = snapshot["files"].get(str(pure))
            if not isinstance(text, str):
                return {"error": "该技能引用不存在。"}
            return {"path": str(pure), "text": text[:20000]}
        return {"error": "未提供此工具。"}
    except Exception:
        return {"error": "读取工具数据失败。"}


def _vision_parts(context, asset_version_ids):
    if len(asset_version_ids) > 40:
        raise HTTPException(400, "一轮最多给 Agent 查看 4 张图片。")
    assets = {a.get("version_id"): a for a in context.get("assets", []) if isinstance(a, dict)}
    output, total = [], 0
    for version_id in dict.fromkeys(asset_version_ids):
        item = assets.get(version_id)
        if not item:
            raise HTTPException(400, "视觉输入必须来自当前上下文中的已登记图片版本。")
        if item.get("kind") != "image":
            continue
        if len(output) >= 4:
            raise HTTPException(400, "一轮最多给 Agent 查看 4 张图片。")
        try:
            path = Path(core.output_file_from_url(item.get("url", ""))).resolve(strict=True)
            path.relative_to(Path(core.DATA_DIR).resolve())
        except (TypeError, OSError, ValueError):
            raise HTTPException(400, "选中的图片文件当前不可用。")
        if not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
            raise HTTPException(413, "单张视觉参考图片不能超过 8 MB。")
        total += path.stat().st_size
        if total > 16 * 1024 * 1024:
            raise HTTPException(413, "视觉参考图片合计不能超过 16 MB。")
        mime = mimetypes.guess_type(path.name)[0]
        if not mime or not mime.startswith("image/"):
            raise HTTPException(400, "选中的版本不是受支持的图片文件。")
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        output.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}})
    return output


def _messages_for_turn(session, turn, context, target_models):
    messages = [{"role": "system", "content": _system_prompt(context, turn["skill_snapshots"], target_models)}]
    prior_turns = []
    budget = MAX_CONTEXT_CHARS // 2
    for prior in reversed(session.get("turns", [])[:-1]):
        if prior.get("status") == "completed":
            user_content, reply = prior.get("user_content", ""), prior.get("reply", "")
            size = len(user_content) + len(reply)
            if size <= budget:
                prior_turns.append((user_content, reply))
                budget -= size
    for user_content, reply in reversed(prior_turns):
        messages.append({"role": "user", "content": user_content})
        messages.append({"role": "assistant", "content": reply})
    content = turn.get("user_content") or turn["user_message"]
    content_parts = [{"type": "text", "text": content}]
    if turn.get("vision"):
        ids=turn.get('vision_asset_ids', [])
        images={a['version_id']:a for a in context.get('assets',[]) if a.get('kind')=='image'}
        for vid,part in zip(ids,_vision_parts(context,ids)):
            image=images[vid]
            content_parts.append({'type':'text','text':f"下面这张图片的版本编号 {vid}：{image.get('name','')}"})
            content_parts.append(part)
    user_content = content_parts if len(content_parts) > 1 else content
    messages.append({"role": "user", "content": user_content})
    return messages


async def _call_provider(provider_id, model, messages):
    textual=0
    for message in messages:
        content=message.get('content') or ''
        textual += len(content) if isinstance(content,str) else sum(len(p.get('text','')) for p in content if isinstance(p,dict))
    if textual>MAX_CONTEXT_CHARS:
        raise HTTPException(413,'本轮技能、剧本和对话上下文过长，请减少所选节点或拆分任务。')
    _, endpoint, headers = _connection(provider_id, model)
    async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=15), follow_redirects=False) as client:
        response = await client.post(endpoint, headers=headers, json={"model": model, "messages": messages,
            "stream": False, "tools": TOOL_DEFINITIONS, "tool_choice": "auto"})
        if response.status_code >= 400:
            error = httpx.HTTPStatusError("provider error", request=response.request, response=response)
            raise error
        return response.json()


def _content(response):
    choices = response.get("choices") or []
    if not choices:
        raise ValueError("模型没有返回消息。")
    message = choices[0].get("message") or {}
    return message, response.get("usage")


def _parse_envelope(text):
    text = str(text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I)
    try:
        data = json.loads(text)
    except ValueError:
        if text.startswith("{") or text.lower().startswith("```json"):
            raise ValueError("模型返回了无法读取的 JSON 计划。")
        return text[:20000], None
    if not isinstance(data, dict) or not isinstance(data.get("reply"), str):
        raise ValueError("模型答复格式不正确。")
    plan = data.get("plan")
    if plan is not None and not isinstance(plan, dict):
        raise ValueError("模型计划格式不正确。")
    return data["reply"][:20000], plan


async def run_turn(session_id, request_id):
    session = read_session(session_id)
    turn = next((t for t in session.get("turns", []) if t.get("request_id") == request_id), None)
    if not turn or turn.get("status") != "running":
        return
    provider_id = turn["provider_id"]
    usage_total, usage_rounds = {}, []
    try:
        context = _get_context(session["canvas_id"], turn["node_ids"], turn["asset_version_ids"])
        context["target_models"] = turn["target_models"]
        context["vision_requested"] = bool(turn["vision"])
        context["previous_plan"] = session.get("plan") or _latest_completed_plan(session)
        context["applied_node_ids"] = session.get("applied_node_ids", [])
        vision_ids = [a["version_id"] for a in context.get("assets", []) if a.get("kind") == "image"] if turn["vision"] else []
        if turn["vision"]:
            import studio_capabilities
            if not vision_ids:
                raise HTTPException(400, "请在画布上下文中选择至少一张图片后再启用视觉输入。")
            if studio_capabilities.profile(turn["model"], "chat").get("max_images", 0) == 0:
                raise HTTPException(400, "所选对话模型不支持图片输入。")
            turn["vision_asset_ids"] = vision_ids
        messages = _messages_for_turn(session, turn, context, turn["target_models"])
        tool_records = []
        result = None
        for round_index in range(MAX_TOOL_ROUNDS):
            result = await _call_provider(provider_id, turn["model"], messages)
            assistant, usage = _content(result)
            if isinstance(usage, dict):
                usage_rounds.append(usage)
                for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
                    if isinstance(usage.get(key), (int, float)):
                        usage_total[key] = usage_total.get(key, 0) + usage[key]
            calls = assistant.get("tool_calls") or []
            if not isinstance(calls,list) or len(calls)>8:
                raise ValueError('模型请求了过多工具，请缩小任务范围后继续。')
            if not calls:
                reply, raw_plan = _parse_envelope(assistant.get("content", ""))
                plan = None
                if raw_plan is not None:
                    plan = _plan_api().validate_plan(raw_plan, context, available_models()[1])
                turn.update(status="completed", reply=reply, plan=plan,
                            usage={**usage_total, "rounds": usage_rounds}, tool_calls=tool_records,
                            completed_at=int(time.time() * 1000))
                session["plan"] = plan
                session["status"] = "completed"
                session["error"] = ""
                save_session(session)
                return
            if round_index == MAX_TOOL_ROUNDS - 1:
                raise ValueError("Agent 工具调用达到本轮上限，请缩小问题范围后继续。")
            messages.append({"role": "assistant", "content": assistant.get("content"), "tool_calls": calls})
            for call in calls:
                function = call.get("function") or {}
                name = function.get("name", "")
                try:
                    arguments = json.loads(function.get("arguments") or "{}")
                    if not isinstance(arguments, dict):
                        raise ValueError()
                except (ValueError, TypeError):
                    arguments = {}
                    tool_result = {"error": "工具参数必须是 JSON 对象。"}
                else:
                    tool_result = _tool(name, arguments, session, turn, context)
                tool_records.append({"name": name, "arguments": arguments,
                                     "result": tool_result})
                messages.append({"role": "tool", "tool_call_id": call.get("id", ""),
                                 "name": name, "content": json.dumps(tool_result, ensure_ascii=False)[:24000]})
        raise ValueError("Agent 没有生成最终答复。")
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        session = read_session(session_id)
        turn = next((t for t in session.get("turns", []) if t.get("request_id") == request_id), turn)
        turn.update(status="failed", error=_safe_error(exc, provider_id), completed_at=int(time.time() * 1000),
                    usage={**usage_total, "rounds": usage_rounds})
        session["status"] = "failed"
        session["error"] = turn["error"]
        session["plan"] = None
        save_session(session)


def start(session_id, request_id):
    key = f"{session_id}:{request_id}"
    running = WORKERS.get(key)
    if running and not running.done():
        return
    task = asyncio.create_task(run_turn(session_id, request_id))
    WORKERS[key] = task
    task.add_done_callback(lambda done: WORKERS.pop(key, None) if WORKERS.get(key) is done else None)


async def create_turn(session_id, payload):
    session = read_session(session_id)
    request_id = str(payload.get("request_id") or "")
    if not REQUEST_RE.fullmatch(request_id):
        raise HTTPException(400, "请求编号格式无效。")
    existing = next((t for t in session.get("turns", []) if t.get("request_id") == request_id), None)
    if existing:
        return session
    if session.get("status") == "running":
        raise HTTPException(409, "当前会话仍在处理上一条消息。")
    if len(session.get("turns", [])) >= MAX_TURNS:
        raise HTTPException(409, "此会话已达到 100 轮上限，请创建新会话继续。")
    text = str(payload.get("message") or "").strip()
    if not text or len(text) > 100000:
        raise HTTPException(400, "请输入 1 到 100000 个字符的内容。")
    models, available_targets = _catalog_data()
    provider_id, model = str(payload.get("provider_id") or ""), str(payload.get("model") or "")
    if not any(m["provider_id"] == provider_id and m["model"] == model for m in models):
        raise HTTPException(400, "请选择当前启用目录中的对话模型。")
    _connection(provider_id, model)
    skill_ids = payload.get("skill_ids") or []
    if not isinstance(skill_ids, list) or any(not isinstance(s, str) for s in skill_ids):
        raise HTTPException(400, "技能选择格式无效。")
    snapshots = _skill_snapshots(skill_ids)
    attachment_ids = payload.get("attachment_ids") or []
    if not isinstance(attachment_ids, list) or any(not isinstance(a, str) for a in attachment_ids):
        raise HTTPException(400, "附件选择格式无效。")
    node_ids = payload.get("node_ids") or []
    asset_ids = payload.get("asset_version_ids") or []
    if not isinstance(node_ids, list) or not isinstance(asset_ids, list) or any(not isinstance(x, str) for x in node_ids + asset_ids):
        raise HTTPException(400, "画布上下文选择格式无效。")
    context = _get_context(session["canvas_id"], node_ids, asset_ids)
    source_attachment_ids={n.get('attachment_id') for n in context.get('nodes',[])
                           if n.get('agent_node_kind')=='script-source' and n.get('attachment_id')}
    # Use the editable canvas source as the single source of truth after upload.
    attachment_text = _attachment_text(session, [aid for aid in attachment_ids if aid not in source_attachment_ids])
    if len(text) + len(attachment_text) > MAX_CONTEXT_CHARS // 2:
        raise HTTPException(413, "本轮消息和附件超过 60000 字符，请拆分成较短的问题。")
    targets = {"image": None, "video": None}
    for kind in ("image", "video"):
        selected = payload.get(f"{kind}_model")
        if selected:
            if not isinstance(selected, dict):
                raise HTTPException(400, f"{kind} 生成目标格式无效。")
            match = next((t for t in available_targets if t["kind"] == kind and t["provider_id"] == selected.get("provider_id") and t["model"] == selected.get("model")), None)
            if not match:
                raise HTTPException(400, f"所选 {kind} 生成目标未启用。")
            targets[kind] = {k: match[k] for k in ("provider_id", "model", "label", "kind")}
    context["target_models"] = targets
    context["previous_plan"] = session.get("plan") or _latest_completed_plan(session)
    context["applied_node_ids"] = session.get("applied_node_ids", [])
    vision = payload.get("vision") is True
    if vision:
        if not any(a.get("kind") == "image" for a in context.get("assets", [])):
            raise HTTPException(400, "请在画布上下文中选择至少一张图片后再启用视觉输入。")
    turn = {"request_id": request_id, "status": "running", "provider_id": provider_id,
            "model": model, "user_message": text,
            "user_content": text + ("\n\n" + attachment_text if attachment_text else ""),
            "skill_ids": skill_ids, "skill_snapshots": snapshots,
            "attachment_ids": attachment_ids, "attachment_text": attachment_text,
            "node_ids": node_ids, "asset_version_ids": asset_ids, "vision": vision,
            "target_models": targets, "created_at": int(time.time() * 1000), "usage": {},
            "tool_calls": [], "error": ""}
    session.setdefault("turns", []).append(turn)
    session["status"] = "running"
    session["error"] = ""
    save_session(session)
    start(session_id, request_id)
    return read_session(session_id)


def _docx_text(content):
    from io import BytesIO
    try:
        with zipfile.ZipFile(BytesIO(content)) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > 8 * 1024 * 1024:
                raise ValueError("DOCX 文件内容过大。")
            root = ET.fromstring(archive.read(info))
    except (KeyError, zipfile.BadZipFile, ET.ParseError):
        raise ValueError("DOCX 文件格式无效。")
    paragraphs = []
    for para in root.iter():
        if para.tag.endswith("}p"):
            bits = [node.text or "" for node in para.iter() if node.tag.endswith("}t")]
            if bits:
                paragraphs.append("".join(bits))
    return "\n".join(paragraphs)


async def import_attachment(session_id, request):
    session = read_session(session_id)
    if session.get("status") == "running":
        raise HTTPException(409, "Agent 正在处理本轮消息，完成后再上传附件。")
    form = await request.form()
    upload = form.get("file")
    if not upload or not getattr(upload, "filename", ""):
        raise HTTPException(400, "请选择 TXT、Markdown 或 DOCX 文件。")
    filename = Path(str(upload.filename).replace("\\", "/")).name
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_ATTACHMENTS:
        raise HTTPException(415, "附件只支持 TXT、Markdown 和 DOCX。")
    content = await upload.read(MAX_ATTACHMENT_BYTES + 1)
    if len(content) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(413, "单个附件不能超过 8 MB。")
    try:
        text = _docx_text(content) if suffix == ".docx" else content.decode("utf-8-sig")
    except (UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(400, "附件必须是有效的 UTF-8 文本或 DOCX 文件。") from exc
    text = text.strip()
    if not text:
        raise HTTPException(400, "附件没有可读取的文字。")
    if len(text) > MAX_ATTACHMENT_CHARS:
        raise HTTPException(413, "附件文字超过 30000 字符，请拆成较短章节后分别上传。")
    item = {"id": uuid.uuid4().hex, "name": filename[:180], "text": text,
            "sha256": hashlib.sha256(content).hexdigest(), "created_at": int(time.time() * 1000)}
    session.setdefault("attachments", []).append(item)
    save_session(session)
    # The upload response is used once to create an editable canvas source node.
    # Polling continues to omit attachment text through public_session().
    return {k: item[k] for k in ("id", "name", "sha256", "created_at", "text")}


def install(core_module=None):
    global core
    if core_module is not None:
        core = core_module
    app = core.app

    @app.get("/api/studio/agent/bootstrap")
    async def bootstrap_route(canvas_id: str):
        return bootstrap(canvas_id)

    @app.get("/api/studio/agent/sessions")
    async def sessions_list(canvas_id: str):
        if not canvas_id:
            raise HTTPException(400, "请先选择一个画布。")
        items = []
        for path in directory().glob("*.json"):
            try:
                session = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if session.get("canvas_id") == canvas_id:
                items.append({k:session.get(k) for k in ('id','canvas_id','project_id','status','created_at','updated_at')})
        return {"items": sorted(items, key=lambda s: s.get("updated_at", 0), reverse=True)}

    @app.post("/api/studio/agent/sessions")
    async def session_create(payload: dict):
        canvas_id = str(payload.get("canvas_id") or "")
        context = _get_context(canvas_id)
        session = {"id": uuid.uuid4().hex, "canvas_id": canvas_id,
                   "project_id": str(context.get("project_id") or "default"),
                   "status": "idle", "error": "", "turns": [], "attachments": [],
                   "plan": None, "applied_node_ids": [], "created_at": int(time.time() * 1000), "updated_at": int(time.time() * 1000)}
        save_session(session)
        return {"session": public_session(session)}

    @app.get("/api/studio/agent/sessions/{session_id}")
    async def session_detail(session_id: str):
        session = read_session(session_id)
        if session.get("status") == "running":
            current = asyncio.current_task()
            has_worker = any(key.startswith(session_id + ":") and not task.done() for key, task in WORKERS.items())
            if not has_worker:
                session["status"] = "interrupted"
                session["error"] = "服务在处理期间重启；为避免重复提交，Agent 不会自动重试。请检查平台记录后手动继续。"
                for turn in session.get("turns", []):
                    if turn.get("status") == "running":
                        turn["status"] = "interrupted"
                        turn["error"] = session["error"]
                save_session(session)
        return {"session": public_session(session)}

    @app.post("/api/studio/agent/sessions/{session_id}/messages")
    async def message_create(session_id: str, payload: dict):
        return {"session": public_session(await create_turn(session_id, payload))}

    @app.post("/api/studio/agent/sessions/{session_id}/attachments")
    async def attachment_upload(session_id: str, request: Request):
        return await import_attachment(session_id, request)
