"""Serialize UI saves with external-agent edits; never accept a stale snapshot."""
from fastapi import HTTPException
import studio_agent_plans as plans


def install(core):
    async def update_canvas(canvas_id, payload):
        with plans.APPLY_LOCK:
            canvas=core.load_canvas(canvas_id)
            current=int(canvas.get('updated_at') or 0)
            if current and int(payload.base_updated_at or 0)!=current:
                raise HTTPException(409,{'message':'画布已有更新，已保留本地草稿，请先处理冲突。',
                    'canvas':canvas,'updated_at':current})
            canvas['title']=(payload.title or canvas.get('title') or '未命名画布')[:80]
            canvas['icon']=(payload.icon or canvas.get('icon') or 'layers')[:32]
            canvas['kind']=core.normalize_canvas_kind(canvas.get('kind'))
            canvas['nodes']=payload.nodes
            canvas['connections']=payload.connections
            if canvas['kind']=='smart':canvas['viewport']=payload.viewport
            else:canvas['viewport']=canvas.get('viewport') or {'x':0,'y':0,'scale':1}
            canvas['logs']=payload.logs[-500:]
            canvas['settings']=payload.settings or {}
            core.save_canvas(canvas)
            updated=int(canvas['updated_at'])
        await core.manager.broadcast_canvas_updated(canvas_id,updated,payload.client_id)
        return {'canvas':canvas}
    # Preserve FastAPI's already-parsed request model and path dependencies.
    for route in core.app.routes:
        if getattr(route,'path',None)=='/api/canvases/{canvas_id}' and 'PUT' in (getattr(route,'methods',None) or set()):
            route.dependant.call=update_canvas
    core.update_canvas=update_canvas
