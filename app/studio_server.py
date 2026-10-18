"""Independent DeepWhite Studio entry point, retaining the original canvas engine."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import main as core
from fastapi import Request
from fastapi.responses import JSONResponse, RedirectResponse

app = core.app
app.title = '深白片场 · DeepWhite Studio'
import studio_asset_integration
studio_asset_integration.install(core)
import studio_storage
studio_storage.install(core)
import studio_dreamina
studio_dreamina.install(core)
import studio_account, studio_skills
studio_account.install(app)
studio_skills.install(app)
import studio_comfy
studio_comfy.install(core)
import studio_comfy_engine
studio_comfy_engine.install(app)
import studio_workflows
studio_workflows.install(app)
import studio_runninghub
studio_runninghub.install(app)
import studio_rh_workflows
studio_rh_workflows.install(app)
from studio_settings import install as install_settings
install_settings(app)
from studio_pricing import install as install_pricing
from studio_midjourney import install as install_midjourney
install_pricing(app)
install_midjourney(app)
from studio_generation import install as install_generation
install_generation(app)
import studio_native_tasks
studio_native_tasks.install(app)
import studio_agent
import studio_agent_builtins
studio_agent_builtins.install()
studio_agent.install(core)
import studio_agent_plans
studio_agent_plans.install(app)
import studio_canvas_concurrency
studio_canvas_concurrency.install(core)
import studio_control
studio_control.install(app)
import studio_gallery
studio_gallery.install(app)

# Migrate the product view only; saved enable/remove preferences remain intact.
import studio_catalog
_catalogs = studio_catalog.load_store()
for _provider_id, _saved in _catalogs.items():
    for _entry in _saved.get('models', []):
        studio_catalog.annotate(_entry)
    if any(p['id']==_provider_id for p in core.load_api_providers()):
        studio_catalog.apply_to_provider(_provider_id, _saved['models'])
if _catalogs:
    studio_catalog.save_store(_catalogs)
VERSION = (ROOT / 'VERSION').read_text(encoding='utf-8').strip()


@app.middleware('http')
async def studio_boundary(request: Request, call_next):
    boundary_error = core.local_connection_error(request)
    if boundary_error:
        return JSONResponse({'detail': boundary_error}, status_code=403)
    # An upstream in-place updater would overwrite this independent product.
    if request.url.path in ('/api/update-from-github', '/api/update-rollback'):
        return JSONResponse({'detail': 'DeepWhite Studio 使用独立版本更新。'}, status_code=409)
    if request.url.path == '/api/check-update':
        return JSONResponse({'current_version': VERSION, 'latest_version': VERSION,
                             'has_update': False, 'update_available': False})
    return await call_next(request)


# Keep the original project manager and all canvas behavior; only change the entry URL.
app.router.routes[:] = [route for route in app.router.routes if getattr(route, 'path', None) != '/']


@app.get('/')
def workspace():
    return core.static_html_response('canvas-list.html')


@app.get('/preview')
def interaction_preview():
    return core.static_html_response('studio-preview.html')


@app.get('/settings')
def basic_settings():
    return core.static_html_response('studio-settings.html')


@app.get('/original-tools')
def original_tools():
    return core.static_html_response('index.html')


@app.get('/api/studio/health')
def health():
    return {'app': 'DeepWhite Studio', 'display_name':'深白片场', 'version': VERSION,
            'installation': str(ROOT), 'pid': os.getpid(), 'stage': 'asset-foundation'}


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=int(os.getenv('DEEPWHITE_STUDIO_PORT', '3848')),
                ws_ping_interval=None, ws_ping_timeout=None)
