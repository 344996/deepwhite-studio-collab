"""Additive asset references; existing canvas fields and original files stay intact."""
import json
import os
import re
import tempfile
from pathlib import Path


def register_output(core, url, name='', request=None, job_id=''):
    import studio_assets
    request = request or {}
    project = 'default'
    canvas_id = request.get('canvas_id', '')
    if canvas_id:
        try:
            project = core.load_canvas(canvas_id).get('project') or 'default'
        except Exception:
            # A deleted canvas must not discard a paid result.
            pass
    source = {k: v for k, v in {
        'job_id': job_id, 'canvas_id': canvas_id,
        'node_id': request.get('node_id', ''),
        'model': request.get('model', ''),
        'provider_id': request.get('provider_id', ''),
        'prompt': request.get('prompt', ''),
        'params': request.get('params', {}),
    }.items() if v}
    return studio_assets.register_local(url, name=name, project_id=project, source=source)


def install(core):
    import studio_assets
    studio_assets.install(core)
    original_load = core.load_canvas
    original_resolver = core.output_file_from_url

    def resolve_media(url):
        value = url.get('url', '') if isinstance(url, dict) else url
        match = re.fullmatch(r'/api/studio/assets/([a-f0-9]{32})/file(?:\?[^#]*)?', value or '')
        if match:
            try:
                path = studio_assets.file_path(match.group(1))
                return str(path) if path else None
            except Exception:
                return None
        return original_resolver(url)

    def save_canvas(canvas):
        # Index media first. Original source fields are retained for rollback.
        studio_assets.enrich_canvas(canvas)
        path = Path(core.canvas_path(canvas['id']))
        path.parent.mkdir(parents=True, exist_ok=True)
        with core.CANVAS_LOCK:
            previous=0
            if path.exists():
                try:previous=int(json.loads(path.read_text(encoding='utf-8')).get('updated_at') or 0)
                except (ValueError,OSError):pass
            canvas['updated_at']=max(core.now_ms(),previous+1)
            fd, temporary = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
            try:
                with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                    json.dump(canvas, stream, ensure_ascii=False, indent=2)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)

    def load_canvas(canvas_id):
        canvas = original_load(canvas_id)
        # Lazy, non-destructive migration: references persist on next normal save.
        studio_assets.enrich_canvas(canvas)
        return canvas

    core.save_canvas = save_canvas
    core.load_canvas = load_canvas
    core.output_file_from_url = resolve_media
