"""Native text/video receipts. Reads never dispatch; resume only queries receipts.

The existing provider builders remain responsible for their original input mapping.
Only non-secret provider configuration is bound. Credentials are resolved at use
time, and a changed endpoint/protocol blocks execution instead of switching APIs.
"""
import asyncio
import contextvars
import hashlib
import json
import time
from urllib.parse import urlsplit, urlunsplit, quote, urlencode

import httpx
from fastapi import HTTPException
import main as core
import studio_legacy_tasks as ledger

WORKERS = {}
_SECRETS = contextvars.ContextVar('native_task_redaction', default=())
PROTOCOLS = {'video-generic', 'video-agnes', 'video-tudou', 'video-grok',
             'video-runninghub', 'video-jimeng', 'studio-generation'}


def clean_url(value):
    parts = urlsplit(str(value or ''))
    return urlunsplit((parts.scheme, parts.netloc.rsplit('@', 1)[-1], parts.path, '', ''))


def provider_binding(provider):
    # An explicit allowlist excludes API keys, account/session data and auth headers.
    fields = ('id', 'base_url', 'protocol', 'model_protocols', 'chat_models',
              'video_models', 'runninghub_base_url', 'runninghub_api_base_url')
    result = {key: provider[key] for key in fields if key in provider}
    for key in ('base_url', 'runninghub_base_url', 'runninghub_api_base_url'):
        if key in result:
            # A credential-bearing base URL cannot safely be persisted/replayed.
            if str(result[key]) != clean_url(result[key]):
                raise HTTPException(400, '任务地址包含认证参数，请使用独立密钥设置后再提交')
    return json.loads(json.dumps(result))


def bound_provider(record):
    expected = record['execution']['provider']
    provider = core.get_api_provider_exact(expected['id'])
    credential = credential_fingerprint(provider, record['task_kind'], record['execution']['payload'])
    if provider_binding(provider) != expected or credential != record['execution']['credential_fingerprint']:
        raise HTTPException(409, '任务创建后渠道地址、模型协议或账号密钥已改变；请恢复原配置后查询原任务')
    return provider


def credential_fingerprint(provider, kind, payload):
    if kind == 'video' and core.is_runninghub_provider(provider):
        value = core.runninghub_api_key(provider, use_wallet=True)
    elif kind == 'llm' and not (core.is_codex_provider(provider) or core.is_gemini_cli_provider(provider)):
        _, headers, _ = core.resolve_chat_provider(payload['provider'], payload['model'], payload.get('ms_model', ''))
        value = json.dumps(headers, sort_keys=True)
    else:
        value = core.provider_env_key_value(provider['id'])
    return hashlib.sha256(value.encode()).hexdigest()


def before_submit():
    record = current_record()
    if not record:
        return
    try:
        provider = bound_provider(record)
    except HTTPException as exc:
        exc.not_submitted = True
        raise
    _SECRETS.set(tuple(actual_credentials(provider, record)))
    ledger.update(record['id'], provider_submit_started=True)


def actual_credentials(provider, record):
    values = [core.provider_env_key_value(provider['id'])]
    if record['task_kind'] == 'video' and core.is_runninghub_provider(provider):
        values.append(core.runninghub_api_key(provider, use_wallet=True))
    elif record['task_kind'] == 'llm' and not (core.is_codex_provider(provider) or core.is_gemini_cli_provider(provider)):
        payload = record['execution']['payload']
        _, headers, _ = core.resolve_chat_provider(payload['provider'], payload['model'], payload.get('ms_model', ''))
        for key, value in headers.items():
            if key.lower() in ('authorization', 'x-goog-api-key'):
                values.append(str(value).removeprefix('Bearer '))
    return [value for value in values if value]


def child_identity(task_id):
    return 'native_' + hashlib.sha256(task_id.encode()).hexdigest()[:48]


def prepare(kind, payload, task_id):
    import studio_catalog as catalog
    fixed = payload.model_copy(deep=True)
    pid = fixed.provider if kind == 'llm' else fixed.provider_id
    provider = core.get_api_provider_exact(pid)
    if kind == 'llm':
        fixed.provider = provider['id']
        fixed.model = catalog.resolve_model(fixed.provider, fixed.model, 'chat')
        if core.is_codex_provider(provider):
            fixed.model = core.selected_model(fixed.model, (provider.get('chat_models') or core.CODEX_DEFAULT_CHAT_MODELS)[0])
        elif core.is_gemini_cli_provider(provider):
            fixed.model = core.selected_model(fixed.model, (provider.get('chat_models') or core.GEMINI_CLI_DEFAULT_CHAT_MODELS)[0])
        else:
            _, _, fixed.model = core.resolve_chat_provider(fixed.provider, fixed.model, fixed.ms_model)
    else:
        fixed.provider_id = provider['id']
        if 'seedance' in fixed.model.lower() and 'multimodal' not in payload.model_fields_set:
            fixed.multimodal = True
        fixed.model = catalog.resolve_model(fixed.provider_id, fixed.model, 'video',
            images=[r for r in fixed.images if r.url], videos=[r for r in fixed.videos if r],
            audios=[r for r in fixed.audios if r], multimodal=fixed.multimodal)
        fixed.model = core.selected_model(fixed.model, 'agnes-video-v2.0' if core.is_agnes_provider(provider) else 'veo3-fast')
    binding = provider_binding(provider)
    deepwhite = urlsplit(binding.get('base_url', '')).hostname == 'api.deepwhiteai.com'
    credential = credential_fingerprint(provider, kind, fixed.model_dump())
    return {'payload': fixed.model_dump(), 'provider': binding, 'credential_fingerprint': credential,
            'child_id': child_identity(task_id) if deepwhite else '',
            'adapter': 'studio-generation' if deepwhite else 'native'}


def current_record():
    task_id = ledger.current_task()
    if not task_id:
        return None
    record = ledger.raw(task_id)
    return record if record['task_kind'] in ('llm', 'video') else None


def remember_video_receipt(protocol, remote_id, provider=None, **binding):
    record = current_record()
    if not record or record['task_kind'] != 'video' or not remote_id:
        return
    if provider and provider_binding(provider) != record['execution']['provider']:
        raise HTTPException(409, '视频提交渠道与已保存请求不一致')
    ledger.remember_receipt(protocol, remote_id, **binding)
    ledger.update(record['id'], remote_status='running', recovery_action='query_upstream')


def remember_video_result(raw, urls, **fields):
    record = current_record()
    if not record or record['task_kind'] != 'video':
        return
    result = {'videos': list(urls), 'task_id': record.get('upstream_task_id') or None, 'raw': safe_result(raw, record), **fields}
    ledger.update(record['id'], remote_status='succeeded', media_status='pending',
                  remote_result=result, recovery_action='archive_result', status='archiving')


def remote_failed(detail):
    record = current_record()
    if record:
        ledger.update(record['id'], remote_status='failed', recovery_action=None,
                      error=ledger.safe_error_detail(detail))


def mark_failure(task_id, exc, dispatched):
    record = ledger.raw(task_id)
    detail = ledger.safe_error_detail(getattr(exc, 'detail', None) or str(exc))
    code = getattr(exc, 'status_code', 500)
    if isinstance(exc, core.JimengPendingError):
        info = core.jimeng_pending_payload(exc)
        return ledger.update(task_id, status='paused', result=info, jimeng_pending=True,
                             remote_status='running', recovery_action='query_upstream', error=info['message'])
    if getattr(exc, 'not_submitted', False):
        dispatched = False
    if not dispatched or record.get('remote_status') == 'failed' or (not record.get('receipts') and 400 <= code < 500 and code not in (408, 409)):
        return ledger.update(task_id, status='failed', error=detail, status_code=code,
                             remote_status='failed' if dispatched else 'not_submitted', recovery_action=None)
    if record.get('remote_result'):
        return ledger.update(task_id, status='paused', remote_status='succeeded', media_status='failed',
                             recovery_action='archive_result', error=detail, status_code=code)
    if record.get('result') is not None:
        return ledger.update(task_id, status='paused', error=detail, recovery_status='result_not_persisted',
                             recovery_action=None, status_code=code)
    if record.get('receipts'):
        supported = record['receipt']['protocol'] in PROTOCOLS
        cached_child = False
        if record['receipt']['protocol'] == 'studio-generation':
            child = existing_child(record)
            cached_child = bool(child and any(item.get('remote_result') for item in child['children']))
        return ledger.update(task_id, status='paused', recovery_action='archive_result' if cached_child else 'query_upstream' if supported else None,
                             error=detail, status_code=code, recovery_status='receipt_saved')
    return ledger.update(task_id, status='uncertain' if dispatched else 'failed',
                         remote_status='unknown' if dispatched else 'not_submitted', recovery_action=None,
                         recovery_status='verification_required' if dispatched else 'not_submitted', error=detail, status_code=code)


def safe_result(value, record):
    sensitive = {'authorization', 'apikey', 'xapikey', 'xgoogapikey', 'accesstoken',
                 'refreshtoken', 'token', 'secret', 'password', 'credentialfingerprint'}
    credentials = list(_SECRETS.get())
    try:
        provider = core.get_api_provider_exact(record['execution']['provider']['id'])
        credentials.extend(actual_credentials(provider, record))
    except HTTPException:
        pass  # A settings change after acceptance must not discard a known output receipt.
    def clean(item):
        if isinstance(item, dict):
            return {key: '[已隐藏]' if ''.join(c for c in str(key).lower() if c.isalnum()) in sensitive else clean(content)
                    for key, content in item.items()}
        if isinstance(item, list):
            return [clean(content) for content in item]
        if isinstance(item, str):
            for credential in credentials:
                if credential:
                    item = item.replace(credential, '[已隐藏]')
            return item
        return item
    return clean(value)


def finish(task_id, result):
    record = ledger.raw(task_id)
    if record['task_kind'] == 'video' and not result.get('videos'):
        raise HTTPException(502, '视频任务未返回可用视频，不能标记为已完成')
    ledger.update(task_id, status='succeeded', result=safe_result(result, record), error='', remote_status='succeeded',
                  media_status='saved' if ledger.raw(task_id)['task_kind'] == 'video' else 'not_applicable',
                  recovery_action=None, completed_at=time.time(), recovery_status='complete')


async def run(task_id, kind):
    try:
        lock = recovery_lock(task_id)
    except HTTPException as exc:
        if exc.status_code == 409:
            return  # Another process owns the original worker; do not mutate its record.
        raise
    dispatched = False
    owned = False
    claim_attempted = False
    try:
        record = ledger.raw(task_id, kind)
        bound_provider(record)  # Configuration checks occur before the persisted dispatch claim.
        cls = core.CanvasLLMRequest if kind == 'llm' else core.CanvasVideoRequest
        payload = cls(**record['execution']['payload'])
        claim_attempted = True
        dispatched = ledger.dispatch(task_id)
        if not dispatched:
            return
        owned = True
        with ledger.receipt_context(task_id):
            result = await (core.canvas_llm(payload) if kind == 'llm' else core.canvas_video(payload))
        if kind == 'llm' and not str(result.get('text') or '').strip():
            raise HTTPException(502, '模型未返回文字，提交结果需核实')
        finish(task_id, result)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        mark_failure(task_id, exc, dispatched)
    finally:
        if owned or not claim_attempted:
            ledger.release(task_id)
        lock.close()


def launch(task_id, coro):
    key = ledger._key(task_id)
    task = asyncio.create_task(coro)
    WORKERS[key] = task
    task.add_done_callback(lambda done: WORKERS.pop(key, None) if WORKERS.get(key) is done else None)
    return task


async def create(kind, payload):
    request = payload.model_dump()
    request_id = request.get('request_id')
    if request_id and ledger.read(ledger.task_identity(kind, request_id), kind):
        return ledger.begin(kind, payload)[0]  # Compare original input without re-resolving current settings.
    if not request_id:
        import uuid
        payload = payload.model_copy(update={'request_id': uuid.uuid4().hex})
    task_id = ledger.task_identity(kind, payload.request_id)
    execution = prepare(kind, payload, task_id)
    result, created = ledger.begin(kind, payload, execution=execution)
    if created:
        launch(task_id, run(task_id, kind))
    return result


def read(task_id, kind):
    result = ledger.read(task_id, kind)
    if not result:
        raise HTTPException(404, '任务不存在')
    record = ledger.raw(task_id, kind)
    if not result['processing'] and recovery_is_locked(task_id):
        result.update(processing=True, status=record['status'], error=record.get('error', ''),
                      recovery_status=record.get('recovery_status', ''))
    child_id = record.get('execution', {}).get('child_id')
    if child_id and not result['processing'] and result['status'] != 'succeeded':
        child = existing_child(record)
        if child:
            import studio_generation as generation
            data = generation.public(child)
            if child['status'] == 'succeeded':
                if kind == 'llm':
                    value = {'text': data['text'], 'model': child['resolved_model'], 'request_id': child['id'],
                             'raw_usage': child['children'][0].get('usage')}
                else:
                    urls = [o['url'] for o in data['outputs']]
                    value = {'videos': urls, 'video_url': urls[0] if urls else '', 'url': urls[0] if urls else '',
                             'task_id': ','.join(data['task_ids']), 'request_id': child['id']}
                result.update(status='succeeded', result=value, error='', remote_status='succeeded',
                              media_status='saved' if kind == 'video' else 'not_applicable', recovery_action=None)
            elif child['status'] == 'failed':
                result.update(status='failed', error=ledger.safe_error_detail(child.get('error') or '原任务失败'),
                              remote_status='failed', recovery_action=None)
            elif any(c.get('upstream_id') for c in child['children']):
                cached = any(c.get('remote_result') for c in child['children'])
                result.update(status='paused', recovery_action='archive_result' if cached else 'query_upstream',
                              remote_status='succeeded' if cached else 'running')
    return result


def existing_child(record):
    import studio_generation as generation
    execution = record.get('execution', {})
    try:
        child = generation.read(execution['child_id'])
    except (HTTPException, KeyError):
        return None
    if child.get('fingerprint') != execution.get('child_fingerprint'):
        raise HTTPException(409, '子任务请求与父账本绑定不一致，请核实原任务')
    return child


def find(kind, request_id):
    return read(ledger.task_identity(kind, request_id), kind)


def recovery_lock(task_id):
    """OS-owned nonblocking lock: process exit releases it, reads never reclaim dispatch."""
    path = ledger.directory() / (ledger.validate_id(task_id) + '.recovery.lock')
    fh = path.open('a+b')
    try:
        fh.seek(0, 2)
        if not fh.tell():
            fh.write(b'0'); fh.flush()
        fh.seek(0)
        if core.os.name == 'nt':
            import msvcrt
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fh
    except OSError as exc:
        fh.close()
        raise HTTPException(409, '原任务正在查询或保存，请稍后读取状态') from exc


def recovery_is_locked(task_id):
    path = ledger.directory() / (task_id + '.recovery.lock')
    if not path.exists():
        return False
    try:
        lock = recovery_lock(task_id)
    except HTTPException as exc:
        if exc.status_code == 409:
            return True
        raise
    lock.close()
    return False


def query_urls(receipt, provider):
    remote_id = receipt['task_id']
    protocol = receipt['protocol']
    base = receipt.get('base_url') or core.video_api_root(provider)
    if protocol == 'video-agnes':
        return [base + '/agnesapi?' + urlencode({'video_id': remote_id, 'model_name': receipt['model']}),
                base + '/v1/videos/' + quote(remote_id, safe='')]
    if protocol == 'video-tudou':
        return [base + '/v1/tasks/' + quote(remote_id, safe='')]
    if protocol == 'video-grok':
        return [base + '/v1/videos/' + quote(remote_id, safe='')]
    return core.video_task_url_candidates(provider, base, remote_id, receipt.get('submit_url', ''))


async def query_video(record, provider):
    receipt = record['receipt']
    protocol = receipt['protocol']
    if protocol == 'video-jimeng':
        raw = await core.jimeng_query_result(receipt['task_id'], 'video')
        failure = core.jimeng_failure_reason(raw)
        if failure:
            remote_failed(failure)
            raise HTTPException(502, failure)
        values = core.jimeng_output_values(raw)
        if values:
            remember_video_result(raw, values, archive_mode='jimeng')
        return
    async with httpx.AsyncClient(timeout=core.AI_REQUEST_TIMEOUT) as client:
        if protocol == 'video-runninghub':
            response = await client.post(receipt['query_url'], headers=core.runninghub_json_headers(provider), json={'taskId': receipt['task_id']})
            response.raise_for_status()
            raw = response.json()
            status = core.runninghub_query_status(raw).upper()
            failed = status in {'FAILED','FAIL','ERROR','CANCEL','CANCELED','CANCELLED','4'}
            succeeded = status in {'SUCCESS','SUCCEEDED','COMPLETED','COMPLETE','FINISHED','DONE','3'}
            urls = core.video_output_urls(raw) or [u for u in core.runninghub_extract_outputs(raw) if str(u).startswith(('http://','https://','/output/','/assets/'))]
        else:
            raw = None
            last_error = None
            for url in query_urls(receipt, provider):
                try:
                    response = await client.get(url, headers=core.api_headers(provider=provider, model=receipt.get('model', '')))
                    response.raise_for_status()
                    raw = response.json()
                    break
                except (httpx.HTTPError, ValueError) as exc:
                    last_error = exc
            if raw is None:
                raise last_error or HTTPException(502, '原任务查询未返回有效结果')
            data = core.tudou_task_data(raw) if protocol == 'video-tudou' else raw.get('data', raw)
            if isinstance(data, list):
                data = data[0] if data else {}
            if not isinstance(data, dict):
                data = {}
            nested = data.get('detail', data)
            if not isinstance(nested, dict):
                nested = data
            status = str(nested.get('status') or nested.get('task_status') or data.get('status') or '').upper()
            failed = status in (core.TUDOU_VIDEO_FAILED_STATUSES if protocol == 'video-tudou' else core.VIDEO_TASK_FAILURE_STATUSES)
            succeeded = status in (core.TUDOU_VIDEO_SUCCESS_STATUSES if protocol == 'video-tudou' else core.VIDEO_TASK_SUCCESS_STATUSES)
            urls = core.tudou_video_result_urls(raw) if protocol == 'video-tudou' else core.video_output_urls(raw)
        if failed:
            remote_failed(core.runninghub_fail_reason(raw) if protocol == 'video-runninghub' else nested.get('fail_reason') or nested.get('error') or '远端视频任务失败')
            raise HTTPException(502, '远端视频任务已失败，请查看原任务记录')
        if urls:
            fields = {'video_id': receipt.get('video_id'), 'task_id': receipt.get('provider_task_id') or receipt['task_id']} if receipt.get('video_id') else {}
            remember_video_result(raw, urls, **fields)
        elif succeeded and protocol == 'video-grok':
            remember_video_result(raw, [], archive_mode='grok-content')
        elif succeeded:
            raise HTTPException(502, '远端任务已完成但未返回视频地址，请核对原任务')


async def archive(record, provider):
    result = record['remote_result']
    ledger.update(record['id'], status='archiving', media_status='pending', error='')
    mode = result.get('archive_mode')
    if mode == 'jimeng':
        videos = await core.jimeng_store_outputs(result['raw'], 'video', allow_query=False)
    elif mode == 'grok-content':
        receipt = record['receipt']
        async with httpx.AsyncClient(timeout=core.VIDEO_POLL_TIMEOUT) as client:
            videos = [await core.download_tudou_grok_video_content(client, provider, receipt['base_url'], receipt['task_id'])]
    else:
        videos = []
        for url in result['videos']:
            videos.append(await core.save_remote_video_to_output(url))
    final = {key: value for key, value in result.items() if key != 'archive_mode'}
    final['videos'] = videos
    finish(record['id'], final)


async def recover(task_id, lock):
    try:
        record = ledger.raw(task_id, 'video')
        provider = bound_provider(record)
        with ledger.receipt_context(task_id):
            if record.get('remote_result'):
                await archive(record, provider)
            elif record['receipt']['protocol'] == 'studio-generation':
                import studio_generation as generation
                await generation.resume_receipt_only(record['execution']['child_id'])
                result = generation.public(generation.read(record['execution']['child_id']))
                if result['status'] == 'succeeded':
                    urls = [output['url'] for output in result['outputs']]
                    finish(task_id, {'videos': urls, 'video_url': urls[0] if urls else '', 'url': urls[0] if urls else '',
                                     'task_id': ','.join(result['task_ids']), 'request_id': result['id']})
                else:
                    raise HTTPException(502, result.get('error') or '原子任务尚未完成')
            else:
                await query_video(record, provider)
                record = ledger.raw(task_id, 'video')
                if record.get('remote_result'):
                    await archive(record, provider)
                else:
                    ledger.update(task_id, status='paused', remote_status='running', recovery_action='query_upstream',
                                  error='原任务仍在处理中，可稍后继续查询；不会重新生成')
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        mark_failure(task_id, exc, True)
    finally:
        ledger.release(task_id)
        lock.close()


async def resume(task_id):
    record = ledger.raw(task_id, 'video')
    if record['status'] == 'succeeded':
        return read(task_id, 'video')
    if record.get('remote_status') == 'failed':
        return read(task_id, 'video')
    if ledger._key(task_id) in ledger._ACTIVE:
        return read(task_id, 'video')
    if not record.get('remote_result') and not (record.get('receipt') and record['receipt']['protocol'] in PROTOCOLS):
        # A deterministic child plan alone is not evidence that it was created/accepted.
        if record['execution'].get('child_id'):
            import studio_generation as generation
            child = existing_child(record)
            if child and any(item.get('upstream_id') for item in child['children']):
                with ledger.receipt_context(task_id):
                    ledger.remember_receipt('studio-generation', record['execution']['child_id'])
                ledger.update(task_id, recovery_action='query_upstream')
                record = ledger.raw(task_id, 'video')
            elif child and child['status'] == 'succeeded':
                data = generation.public(child)
                urls = [item['url'] for item in data['outputs']]
                finish(task_id, {'videos': urls, 'video_url': urls[0] if urls else '', 'url': urls[0] if urls else '', 'task_id': ','.join(data['task_ids']), 'request_id': child['id']})
                return read(task_id, 'video')
        if not record.get('receipt') or record['receipt']['protocol'] not in PROTOCOLS:
            raise HTTPException(409, '未保存可查询回执，提交结果需核实；不会重新生成')
    bound_provider(record)
    lock = recovery_lock(task_id)
    try:
        ledger.update(task_id, status='archiving' if record.get('remote_result') else 'running', error='')
        ledger.activate(task_id)
        launch(task_id, recover(task_id, lock))
    except Exception:
        lock.close()
        ledger.release(task_id)
        raise
    return read(task_id, 'video')


def install(app):
    from fastapi import Response

    @app.get('/api/studio/task-media/{task_id}')
    async def task_media(task_id: str, u: str):
        # F04: public results name a handle; the signed link stays inside the task record.
        url = ledger.signed_media_url(task_id, u)
        if not url:
            raise HTTPException(404, '结果不存在')
        try:
            async with httpx.AsyncClient(timeout=120, follow_redirects=True) as client:
                response = await client.get(url)
        except httpx.HTTPError:
            raise HTTPException(502, '原始结果暂时无法下载，请稍后重试或查询原任务。')
        if not response.is_success:
            raise HTTPException(502, '原始结果链接已失效或拒绝访问，请查询原任务恢复。')
        return Response(response.content, media_type=response.headers.get('content-type') or 'application/octet-stream')

    @app.get('/api/canvas-native-tasks/capabilities')
    async def capabilities():
        return {'version': 1, 'kinds': ['llm', 'video'], 'get_dispatches': False,
                'video_resume': ['query_upstream', 'archive_result']}

    @app.post('/api/canvas-llm-tasks')
    async def create_llm(payload: core.CanvasLLMRequest):
        return await create('llm', payload)

    @app.get('/api/canvas-llm-tasks/by-request/{request_id}')
    async def find_llm(request_id: str):
        return find('llm', request_id)

    @app.get('/api/canvas-llm-tasks/{task_id}')
    async def get_llm(task_id: str):
        return read(task_id, 'llm')

    @app.post('/api/canvas-video-tasks')
    async def create_video(payload: core.CanvasVideoRequest):
        return await create('video', payload)

    @app.get('/api/canvas-video-tasks/by-request/{request_id}')
    async def find_video(request_id: str):
        return find('video', request_id)

    @app.get('/api/canvas-video-tasks/{task_id}')
    async def get_video(task_id: str):
        return read(task_id, 'video')

    @app.post('/api/canvas-video-tasks/{task_id}/resume')
    async def resume_video(task_id: str):
        return await resume(task_id)
