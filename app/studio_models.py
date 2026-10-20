"""Enabled model inventory shared by manual canvas and external controllers."""
import main as default_core


def available_models(core_module=None):
    core = core_module or default_core
    import studio_catalog
    store = studio_catalog.load_store()
    providers = {p.get("id"): p for p in core.load_api_providers()
                 if p.get("id") and p.get("enabled", True) and p.get("protocol", "openai") == "openai"}
    chats, targets = [], []
    for provider_id, provider in providers.items():
        saved = store.get(provider_id) or {}
        if saved and str(provider.get("base_url", "")).rstrip("/") != str(saved.get("base_url", "")).rstrip("/"):
            continue
        entries = saved.get("models", [])
        used = set()
        for entry in entries:
            if not studio_catalog.active(entry):
                continue
            kind = entry.get("kind")
            if kind == "chat" and studio_catalog.annotate(entry).get("role") == "generate":
                model = entry.get("id", "")
                if model and model not in used:
                    chats.append({"provider_id": provider_id, "model": model,
                                  "label": provider.get("model_names", {}).get(model) or entry.get("name") or model})
                    used.add(model)
            elif kind in ("image", "video") and studio_catalog.annotate(entry).get("role") == "generate":
                model = entry.get("id", "")
                if model:
                    targets.append({"provider_id": provider_id, "model": model,
                                    "label": provider.get("model_names", {}).get(model) or entry.get("name") or model,
                                    "kind": kind})
        # Provider lists are actual configured model IDs and serve only before a catalog snapshot exists.
        if not saved:
            for model in provider.get("chat_models", []) or []:
                if model and model not in used:
                    chats.append({"provider_id": provider_id, "model": model,
                                  "label": provider.get("model_names", {}).get(model) or model})
                    used.add(model)
            for kind in ("image", "video"):
                for model in provider.get(f"{kind}_models", []) or []:
                    if model:
                        targets.append({"provider_id": provider_id, "model": model,
                                        "label": provider.get("model_names", {}).get(model) or model,
                                        "kind": kind})
    # Optional local generation channels are targets, never conversation models.
    import studio_dreamina
    if studio_dreamina.config()['enabled']:
        for entry in studio_dreamina.models():
            if entry['enabled']:
                targets.append({'provider_id':studio_dreamina.PROVIDER,'model':entry['id'],
                                'label':entry['name']+' · 即梦账号','kind':entry['kind']})
    return chats, targets
