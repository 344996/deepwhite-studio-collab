"""Optional local Dreamina CLI adapter. CLI calls are always explicit and shell-free."""
import asyncio
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from fastapi import HTTPException

PROVIDER = 'dreamina-cli'
_CORE = None
_LOGIN = {}
_AUTH = None
_ACCOUNT = None
_CREDIT = None
_STATUS_CACHE = None
_STATUS_AT = 0
_AUTH_MUTATION_LOCK = threading.Lock()

# These are logical CLI model entries. Commands are selected from the verified
# dreamina subcommand help; the model_version is passed only where supported.
_MODELS = [
    dict(id='dreamina-image-5.0', name='即梦图像 5.0', series='即梦图像', kind='image', model_version='5.0', commands=['text2image','image2image'], sizes=['2k','4k']),
    dict(id='dreamina-image-5.0-pro', name='即梦图像 5.0 Pro', series='即梦图像', kind='image', model_version='5.0Pro', commands=['text2image','image2image'], sizes=['1.5k','2k','4k']),
    dict(id='dreamina-image-4.7', name='即梦图像 4.7', series='即梦图像', kind='image', model_version='4.7', commands=['text2image','image2image'], sizes=['2k','4k']),
    dict(id='dreamina-image-4.6', name='即梦图像 4.6', series='即梦图像', kind='image', model_version='4.6', commands=['text2image','image2image'], sizes=['2k','4k']),
    dict(id='dreamina-image-4.5', name='即梦图像 4.5', series='即梦图像', kind='image', model_version='4.5', commands=['text2image','image2image'], sizes=['2k','4k']),
    dict(id='dreamina-image-4.1', name='即梦图像 4.1', series='即梦图像', kind='image', model_version='4.1', commands=['text2image','image2image'], sizes=['2k','4k']),
    dict(id='dreamina-image-4.0', name='即梦图像 4.0', series='即梦图像', kind='image', model_version='4.0', commands=['text2image','image2image'], sizes=['2k','4k']),
    dict(id='dreamina-image-3.1', name='即梦图像 3.1', series='即梦图像', kind='image', model_version='3.1', commands=['text2image'], sizes=['1k','2k']),
    dict(id='dreamina-image-3.0', name='即梦图像 3.0', series='即梦图像', kind='image', model_version='3.0', commands=['text2image'], sizes=['1k','2k']),
    dict(id='dreamina-video-seedance-2.5', name='Seedance 2.5', series='Seedance', kind='video', model_version='seedance2.5', commands=['text2video','image2video','frames2video','multimodal2video'], sizes=['480p','720p','1080p'], durations=list(range(4,31)),max_images=30,max_videos=10,max_audios=10),
    dict(id='dreamina-video-seedance-1.5-pro', name='Seedance 1.5 Pro', series='Seedance', kind='video', model_version='seedance1.5pro', commands=['image2video','frames2video'], sizes=['720p'], durations=list(range(5,13)),max_images=2,max_videos=0,max_audios=0),
    dict(id='dreamina-video-seedance-1.0-fast', name='Seedance 1.0 Fast', series='Seedance', kind='video', model_version='seedance1.0fast', commands=['image2video'], sizes=['720p'], durations=list(range(5,11)),max_images=1,max_videos=0,max_audios=0),
    dict(id='dreamina-video-seedance-2.0', name='Seedance 2.0', series='Seedance', kind='video', model_version='seedance2.0', commands=['text2video','image2video','frames2video','multimodal2video'], sizes=['720p'], durations=list(range(4,16)),max_images=9,max_videos=3,max_audios=3),
    dict(id='dreamina-video-seedance-2.0-fast', name='Seedance 2.0 Fast', series='Seedance', kind='video', model_version='seedance2.0fast', commands=['text2video','image2video','frames2video','multimodal2video'], sizes=['720p'], durations=list(range(4,16)),max_images=9,max_videos=3,max_audios=3),
    dict(id='dreamina-video-seedance-2.0-vip', name='Seedance 2.0 VIP', series='Seedance', kind='video', model_version='seedance2.0_vip', commands=['text2video','image2video','frames2video','multimodal2video'], sizes=['720p','1080p','4k'], durations=list(range(4,16)),max_images=9,max_videos=3,max_audios=3),
    dict(id='dreamina-video-seedance-2.0-fast-vip', name='Seedance 2.0 Fast VIP', series='Seedance', kind='video', model_version='seedance2.0fast_vip', commands=['text2video','image2video','frames2video','multimodal2video'], sizes=['720p'], durations=list(range(4,16)),max_images=9,max_videos=3,max_audios=3),
    dict(id='dreamina-video-seedance-2.0-mini', name='Seedance 2.0 Mini', series='Seedance', kind='video', model_version='seedance2.0mini', commands=['text2video','image2video','frames2video','multimodal2video'], sizes=['720p'], durations=list(range(4,16)),max_images=9,max_videos=3,max_audios=3),
]


def _data_dir():
    if _CORE is not None:
        return Path(_CORE.DATA_DIR)
    return Path(os.environ.get('DEEPWHITE_STUDIO_RUNTIME_DIR') or Path(__file__).parent / 'workspace')


def _config_path():
    return _data_dir() / 'studio_dreamina' / 'config.json'


def _default_cli():
    found = shutil.which('dreamina') or shutil.which('dreamina.exe')
    return found or ''


def _default_config():
    return {'enabled': False, 'cli_path': _default_cli(), 'models': {m['id']: True for m in _MODELS}}


def config():
    path = _config_path()
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return _default_config()
    result = _default_config()
    result['enabled'] = data.get('enabled') is True
    if isinstance(data.get('cli_path'), str): result['cli_path'] = data['cli_path']
    saved = data.get('models')
    if isinstance(saved, dict):
        for model in _MODELS:
            if model['id'] in saved: result['models'][model['id']] = saved[model['id']] is True
    return result


def _write_config(data):
    path = _config_path(); path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temp, path)


def models():
    cfg = config()
    return [dict(id=m['id'], name=m['name'], series=m['series'], kind=m['kind'], enabled=cfg['models'].get(m['id'], True),
                 modes=list(m['commands']), versions=[m['model_version']]) for m in _MODELS]


def model_entry(model_id):
    entry = next((m for m in _MODELS if m['id'] == model_id), None)
    if not entry: raise HTTPException(400, '即梦模型不存在或尚未适配。')
    return entry


def spec(model):
    from studio_capabilities import option
    entry = model_entry(model)
    if entry['kind'] == 'image':
        fields = {'ratio': option('比例', ['1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9'], '1:1'),
                  'resolution': option('分辨率', entry['sizes'], '2k')}
        return {'kind':'image','supported':True,'max_images':10 if 'image2image' in entry['commands'] else 0,'max_videos':0,'max_audios':0,
                'prompt_min':1,'prompt_max':20000,'note':'单次任务费用未知：当前即梦 CLI 未提供报价接口；余额是账号剩余积分，不代表本次费用。','fields':fields}
    fields = {'ratio': option('比例', ['16:9','9:16','1:1','4:3','3:4'], '16:9'),
              'resolution': option('分辨率', entry['sizes'], '720p'),
              'duration': option('时长（秒）', entry['durations'], entry['durations'][0])}
    return {'kind':'video','supported':True,'max_images':entry['max_images'],'max_videos':entry['max_videos'],'max_audios':entry['max_audios'],
            'prompt_min':1,'prompt_max':20000,'note':'单次任务费用未知：当前即梦 CLI 未提供报价接口；余额是账号剩余积分，不代表本次费用。参考素材会直接交给本机即梦 CLI。','fields':fields}


def _cli_path():
    value = config()['cli_path']
    if not value: raise HTTPException(400, '请先在即梦设置中选择 dreamina.exe。')
    path = Path(value).expanduser()
    # Only a user-selected native executable is accepted; never treat this as shell text.
    if path.suffix.lower() != '.exe' or not path.is_file():
        raise HTTPException(400, '即梦 CLI 路径必须指向存在的 .exe 文件。')
    return str(path.resolve())


def _env():
    home = _data_dir() / 'studio_dreamina' / 'dreamina_home'
    for part in ('AppData/Roaming','AppData/Local','config'):
        (home / part).mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update({'HOME':str(home),'USERPROFILE':str(home),'APPDATA':str(home/'AppData'/'Roaming'),
                'LOCALAPPDATA':str(home/'AppData'/'Local'),'XDG_CONFIG_HOME':str(home/'config')})
    return env


def _run_cli(args, timeout=90):
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) if os.name == 'nt' else 0
    startup = None
    if os.name == 'nt' and hasattr(subprocess, 'STARTUPINFO'):
        startup = subprocess.STARTUPINFO(); startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    try:
        return subprocess.run([_cli_path(), *[str(x) for x in args]], shell=False, cwd=str(_data_dir()/'studio_dreamina'/'dreamina_home'), capture_output=True,
                              text=True, encoding='utf-8', errors='replace', timeout=timeout,
                              env=_env(), creationflags=flags, startupinfo=startup)
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(504, '即梦 CLI 响应超时；如已提交生成，请继续查询，不会自动重新提交。') from exc
    except OSError as exc:
        raise HTTPException(503, '无法启动即梦 CLI，请检查所选程序路径。') from exc


def _json_records(text):
    text = str(text or '').strip()
    for candidate in (text, *reversed(text.splitlines())):
        try:
            value = json.loads(candidate)
            if isinstance(value, dict): return value
        except (ValueError, TypeError): pass
    # CLI may prefix a JSON object with human-readable status text.
    match = re.search(r'\{[\s\S]*\}', text)
    if match:
        try:
            value = json.loads(match.group(0))
            if isinstance(value, dict): return value
        except ValueError: pass
    return {}


def _scrub(text):
    text = str(text or '')
    text = re.sub(r'(?i)(["\']?(?:device_code|access_token|refresh_token|authorization|api[_-]?key)["\']?\s*:\s*)["\']?[^\s,"\'}]+["\']?', r'\1[已隐藏]', text)
    text = re.sub(r'(?i)(device_code|access_token|refresh_token|authorization|api[_-]?key)(\s*[=:]\s*)[^\s,;]+', r'\1\2[已隐藏]', text)
    text = re.sub(r'(?i)bearer\s+[^\s,;]+', 'Bearer [已隐藏]', text)
    return text[:600]


def _nested(data, *keys):
    for key in keys:
        if key in data and data[key] not in (None, ''): return data[key]
    for key in ('data','result','account'):
        val = data.get(key)
        if isinstance(val, dict):
            found = _nested(val, *keys)
            if found not in (None, ''): return found
    return None


def _auth_state(output, rc=0):
    data = _json_records(output)
    uid = _nested(data,'user_id','userId','uid','account_id','accountId')
    return bool(rc == 0 and uid not in (None,'')), data


def _account_data(result):
    data=_json_records((result.stdout or '')+'\n'+(result.stderr or ''))
    uid=_nested(data,'user_id','userId','uid','account_id','accountId')
    if result.returncode != 0 or uid in (None,''):
        raise HTTPException(401,'即梦 CLI 尚未登录，请先连接即梦账号。')
    return str(uid), _nested(data,'account_name','username','user_name','nickname'), _nested(data,'credit','credits','balance','available_credit','total_credit')


def _clear_status_cache():
    global _STATUS_CACHE, _STATUS_AT, _AUTH, _ACCOUNT, _CREDIT
    _STATUS_CACHE = None
    _STATUS_AT = 0
    _AUTH = None
    _ACCOUNT = None
    _CREDIT = None


def _prune_login_sessions(now=None):
    now = time.time() if now is None else now
    for login_id, entry in list(_LOGIN.items()):
        if now >= float(entry.get('expires_at') or 0):
            _LOGIN.pop(login_id, None)


@contextmanager
def _auth_mutation():
    if not _AUTH_MUTATION_LOCK.acquire(blocking=False):
        raise HTTPException(409, '即梦账号操作正在进行，请稍后重试。')
    try:
        yield
    finally:
        _AUTH_MUTATION_LOCK.release()


def status():
    global _STATUS_CACHE, _STATUS_AT, _AUTH, _ACCOUNT, _CREDIT
    _prune_login_sessions()
    cfg = config(); available = bool(cfg['cli_path'] and Path(cfg['cli_path']).suffix.lower()=='.exe' and Path(cfg['cli_path']).is_file())
    error = ''
    if cfg['enabled'] and available and time.time() - _STATUS_AT > 20:
        if not _AUTH_MUTATION_LOCK.acquire(blocking=False):
            return {'available':available,'enabled':cfg['enabled'],'authenticated':_AUTH,
                    'account':_ACCOUNT,'credit':_CREDIT,'error':'即梦账号操作正在进行，请稍后刷新。','models':models()}
        try:
            result = _run_cli(['user_credit'], timeout=20)
            data = _json_records((result.stdout or '')+'\n'+(result.stderr or ''))
            uid = _nested(data,'user_id','userId','uid','account_id','accountId')
            if result.returncode == 0 and uid not in (None,''):
                _AUTH = True; _ACCOUNT = _nested(data, 'account_name','username','user_name','nickname')
                _CREDIT = _nested(data, 'credit','credits','balance','available_credit','total_credit')
                _STATUS_AT = time.time()
            else:
                _AUTH = False; _ACCOUNT = None; _CREDIT = None
                error = '即梦账号未登录或暂不可用。'
                _STATUS_AT = time.time()
        except HTTPException as exc:
            _AUTH=False;_ACCOUNT=None;_CREDIT=None;error=str(exc.detail);_STATUS_AT=time.time()
        finally:
            _AUTH_MUTATION_LOCK.release()
    return {'available':available,'enabled':cfg['enabled'],'authenticated':_AUTH,
            'account':_ACCOUNT,'credit':_CREDIT,'error':error,'models':models()}


def _checked(payload):
    cfg = config()
    if not cfg['enabled']: raise HTTPException(400, '请先在设置中启用即梦 CLI 通道。')
    entry = model_entry(payload.model)
    if not cfg['models'].get(entry['id'], False): raise HTTPException(400, '当前即梦模型已停用，请在设置中启用后再提交。')
    if payload.provider_id != PROVIDER or payload.kind != entry['kind']: raise HTTPException(400, '即梦模型与生成类型不匹配。')
    # Prevent submission when the executable has not been explicitly selected.
    _cli_path()
    if not 1 <= len(payload.prompt.strip()) <= 20000: raise HTTPException(400, '提示词需为 1–20000 个字符。')
    params = {}
    for key, field in spec(entry['id'])['fields'].items():
        value = payload.params.get(key, field['default'])
        if value not in field['values']: raise HTTPException(400, f'{field["label"]}不支持当前值。')
        params[key] = value
    refs = [dict(ref) for ref in payload.references if ref.get('url')]
    for ref in refs: ref.setdefault('kind','image')
    image_refs = [r for r in refs if r.get('kind','image') == 'image']
    for ref in refs:
        kind = ref.get('kind', 'image')
        if kind not in ('image','video','audio'): raise HTTPException(400, '参考素材类型不支持。')
        url = ref['url']
        if not url.startswith('/'):
            raise HTTPException(400, '即梦 CLI 仅接受已保存到本地的参考素材。')
        path = _CORE.output_file_from_url(url) if _CORE is not None else None
        if not path or not Path(path).is_file(): raise HTTPException(400, '参考素材已丢失，请重新上传。')
        suffix = Path(path).suffix.lower()
        allowed = {'.png','.jpg','.jpeg','.webp','.bmp'} if kind=='image' else {'.mp4','.mov','.webm','.m4v'} if kind=='video' else {'.mp3','.wav','.m4a','.aac','.ogg'}
        if suffix not in allowed: raise HTTPException(400, f'参考文件格式与{kind}类型不匹配。')
        if Path(path).stat().st_size > 50*1024*1024: raise HTTPException(400, '单个参考文件不能超过 50 MB。')
    command = None
    if payload.kind == 'image':
        if any(r.get('kind','image') != 'image' for r in refs) or len(image_refs)>10: raise HTTPException(400, '即梦图像编辑最多接受十张参考图。')
        command = 'image2image' if image_refs else 'text2image'
        if command not in entry['commands']: raise HTTPException(400,'此即梦图像型号不支持参考图编辑。')
    else:
        if payload.frame_mode:
            if len(image_refs) not in (1,2) or len(refs) != len(image_refs): raise HTTPException(400, '首尾帧模式需要一至两张图片。')
            if len(image_refs)==1 and image_refs[0].get('role')=='last_frame': raise HTTPException(400,'请先添加首帧。')
            command = 'image2video' if len(image_refs)==1 else 'frames2video'
        elif payload.multimodal and refs and 'multimodal2video' in entry['commands']:
            command = 'multimodal2video'
        elif len(refs)==1 and image_refs:
            command = 'image2video'
        elif not refs: command = 'text2video'
        else: command = 'multimodal2video'
        if command not in entry['commands']: raise HTTPException(400, '此即梦模型不支持当前参考素材模式。')
        if entry['model_version']!='seedance2.5' and command=='multimodal2video' and not (image_refs or any(r.get('kind')=='video' for r in refs)):
            raise HTTPException(400, 'Seedance 2.0 的全能参考模式至少需要一张图片或一个视频。')
        limits={'image':entry['max_images'],'video':entry['max_videos'],'audio':entry['max_audios']}
        total_limit=50 if entry['model_version']=='seedance2.5' else 12
        if command=='multimodal2video' and len(refs)>total_limit:
            raise HTTPException(400,f'此即梦型号最多接受 {total_limit} 个参考素材。')
        for kind,limit in limits.items():
            count=sum(1 for ref in refs if ref.get('kind','image')==kind)
            if count>limit: raise HTTPException(400,f'此即梦型号最多接受 {limit} 个{kind}参考素材。')
    if payload.frame_mode:
        refs.sort(key=lambda r: 0 if r.get('role')=='first_frame' else 2 if r.get('role')=='last_frame' else 1)
        for i, ref in enumerate(refs): ref['role']='first_frame' if i==0 else 'last_frame'
    req = payload.model_dump(); req['references'] = refs; req['params'] = params; req['dreamina_command'] = command
    if payload.kind=='video' and entry['model_version'].startswith('seedance'):
        import studio_generation as jobs
        req['input_prompt']=payload.prompt
        req['prompt']=jobs.seedance_prompt(payload.prompt,refs)
    return req, entry['model_version'], 'dreamina-cli://local'


def checked(payload):
    return _checked(payload)


def _arg(name, value):
    return f'--{name}={value}'


def _generation_args(job, child_index, output_dir):
    req=job['request']; entry=model_entry(req['model']); command=req['dreamina_command']; params=req['params']
    args=[command, _arg('prompt',req['prompt']), _arg('poll',0)]
    if command in ('text2image','image2image'):
        args.extend([_arg('model_version',entry['model_version']),_arg('resolution_type',params['resolution']),_arg('generate_num',1)])
        if params.get('width') and params.get('height'):
            args.extend([_arg('width',params['width']),_arg('height',params['height'])])
        elif params.get('ratio'):
            args.append(_arg('ratio',params['ratio']))
        if command=='image2image':
            paths=[]
            ref_dir=Path(output_dir)/'references';ref_dir.mkdir(parents=True,exist_ok=True)
            for i,ref in enumerate(req['references']):
                src=Path(_resolve_ref(ref));dest=ref_dir/f'reference-{i}{src.suffix.lower()}'
                shutil.copyfile(src,dest);paths.append(str(dest.resolve()))
            args.append(_arg('images',','.join(paths)))
    elif command in ('text2video','image2video','frames2video','multimodal2video'):
        # A CLI invocation represents exactly one durable child; count is managed by generation jobs.
        args.extend([_arg('model_version',entry['model_version']),_arg('duration',params['duration']),_arg('video_resolution',params['resolution'])])
        omit_ratio=entry['model_version']=='seedance2.5' and command in ('image2video','frames2video')
        if params.get('ratio') and not omit_ratio: args.append(_arg('ratio',params['ratio']))
        refs=req['references']
        if command=='image2video': args.append(_arg('image',_resolve_ref(refs[0])))
        elif command=='frames2video':
            images=[r for r in refs if r.get('kind','image')=='image']
            args.append(_arg('first',_resolve_ref(images[0])))
            if len(images)>1: args.append(_arg('last',_resolve_ref(images[1])))
        elif command=='multimodal2video':
            for ref in refs:
                flag={'image':'image','video':'video','audio':'audio'}[ref.get('kind','image')]
                args.append(_arg(flag,_resolve_ref(ref)))
    return args


def _resolve_ref(ref):
    url=ref.get('url','')
    path=_CORE.output_file_from_url(url) if _CORE is not None else None
    if not path or not Path(path).is_file(): raise HTTPException(400,'参考素材已丢失，请重新上传。')
    return str(Path(path).resolve())


def _receipt_ids(text):
    values=[]
    def visit(obj):
        if isinstance(obj,dict):
            for key,val in obj.items():
                if key in ('submit_id','submitId','task_id','taskId') and val not in (None,''):
                    values.append(str(val))
                elif isinstance(val,(dict,list)):visit(val)
        elif isinstance(obj,list):
            for val in obj:visit(val)
    # Some CLI versions emit several separate JSON records. Inspect all of them,
    # so a conflicting receipt cannot be hidden by a later success record.
    source=str(text or '');decoder=json.JSONDecoder()
    for match in re.finditer(r'[\{\[]',source):
        try:obj,_=decoder.raw_decode(source,match.start())
        except ValueError:continue
        visit(obj)
    values.extend(re.findall(r"(?i)\bsubmit[_ -]?id[\"']?\s*[:=]\s*[\"']?([a-zA-Z0-9_.:-]+)",source))
    return set(values)


def _submit_id(text):
    values=_receipt_ids(text)
    return next(iter(values)) if len(values)==1 else None


def _has_conflicting_submit_ids(text):
    return len(_receipt_ids(text))>1


def _gen_state(text):
    data=_json_records(text)
    raw=_nested(data,'gen_status','status','state')
    if not raw:
        match=re.search(r'(?i)\bgen_status\s*[:=]\s*["\']?([a-z_-]+)',str(text or ''))
        raw=match.group(1) if match else None
    value=str(raw or '').lower()
    if value in ('success','succeeded','complete','completed','done'): return 'success',data
    if value in ('fail','failed','failure','error','cancelled','canceled'): return 'failed',data
    if value in ('querying','running','pending','processing','queued','submitted','in_progress','in-progress'): return 'querying',data
    return 'unknown',data


def _failure(text, data):
    reason=_nested(data,'fail_reason','error','message','detail') or text or ''
    reason=str(reason)
    if 'AigcComplianceConfirmationRequired' in reason:
        return '此模型需要先在即梦网页完成一次授权确认，再重新提交。'
    if re.search(r'(?i)credit|quota|余额|额度',reason): return '即梦账号额度不足或不可用，请检查账号状态。'
    if re.search(r'(?i)auth|login|token|登录|授权',reason): return '即梦账号未登录或授权已失效，请重新连接账号。'
    return '即梦任务生成失败，请查看即梦 CLI 任务记录。'


def _result_files(folder):
    root=Path(folder).resolve()
    good={'.png','.jpg','.jpeg','.webp','.bmp','.mp4','.mov','.webm','.m4v'}
    items=[]
    if root.exists():
        for path in root.rglob('*'):
            try:
                resolved=path.resolve()
                relative=resolved.relative_to(root) if resolved.is_relative_to(root) else None
                if path.is_file() and relative and relative.parts[0]!='references' and path.suffix.lower() in good and path.stat().st_size:
                    items.append(path)
            except (OSError,ValueError): continue
    return sorted(items,key=lambda p:(p.suffix.lower() in {'.mp4','.mov','.webm','.m4v'},p.name.lower()))


async def execute(job_id):
    global _AUTH, _STATUS_AT, _ACCOUNT, _CREDIT
    import studio_generation as jobs
    job=jobs.read(job_id); req=job['request']
    try:
        cfg=config()
        if not cfg['enabled']: raise HTTPException(409,'即梦通道已停用；重新启用后可继续查询此任务。')
        auth=await asyncio.to_thread(_run_cli,['user_credit'],timeout=25)
        account_uid,account_name,credit=_account_data(auth)
        binding=hashlib.sha256(account_uid.encode('utf-8')).hexdigest()
        expected_uid=job.get('dreamina_account_binding')
        if expected_uid and expected_uid!=binding:
            job.update(status='paused',error='当前即梦账号与此任务提交时的账号不同，不能查询或继续任务。');jobs.save(job);return
        job['dreamina_account_binding']=binding;_AUTH=True;_ACCOUNT=account_name;_CREDIT=credit;_STATUS_AT=time.time();jobs.save(job)
        for index,child in enumerate(job['children']):
            if child['status']=='succeeded': continue
            if child['status']=='submitting' and not child.get('upstream_id'):
                job.update(status='uncertain',error='即梦提交结果尚不确定，请在即梦任务记录中核对；不会自动重新生成。');jobs.save(job);return
            task_dir=_data_dir()/'studio_dreamina'/'results'/job_id/str(index)
            task_dir.mkdir(parents=True,exist_ok=True)
            if child['status']=='queued':
                latest=config()
                if not latest['enabled'] or not latest['models'].get(req['model'],False):
                    job.update(status='paused',error='即梦通道或此模型已停用。重新启用后才能继续尚未提交的生成。');jobs.save(job);return
                child.update(status='submitting');job['status']='running';jobs.save(job)
                try:
                    result=await asyncio.to_thread(_run_cli,_generation_args(job,index,str(task_dir)),timeout=180)
                except Exception:
                    job.update(status='uncertain',error='即梦提交响应中断，需先在即梦任务记录核对；不会自动重新生成。');jobs.save(job);return
                text=(result.stdout or '')+'\n'+(result.stderr or '')
                submit_id=_submit_id(text)
                if not submit_id:
                    job.update(status='uncertain',error='即梦未返回任务编号，请先在即梦任务记录核对；不会自动重新生成。');jobs.save(job);return
                child.update(upstream_id=submit_id,status='running');jobs.save(job)
            while True:
                try:
                    result=await asyncio.to_thread(_run_cli,['query_result',_arg('submit_id',child['upstream_id'])],timeout=120)
                except Exception as exc:
                    job.update(status='paused',error=(str(exc.detail) if isinstance(exc,HTTPException) else '即梦任务查询中断。')+' 点击继续查询，不会重新生成。');jobs.save(job);return
                text=(result.stdout or '')+'\n'+(result.stderr or '')
                returned_id=_submit_id(text)
                if _has_conflicting_submit_ids(text) or returned_id!=str(child['upstream_id']):
                    job.update(status='paused',error='即梦返回的任务编号缺失或与本地记录不一致，已停止查询。');jobs.save(job);return
                state,data=_gen_state(text)
                if state=='failed':
                    child.update(status='failed',error=_failure(text,data));job.update(status='failed',error=child['error']);jobs.save(job);return
                if state=='success':
                    try:
                        downloaded=await asyncio.to_thread(_run_cli,['query_result',_arg('submit_id',child['upstream_id']),_arg('download_dir',str(task_dir))],timeout=120)
                    except Exception as exc:
                        job.update(status='paused',error=(str(exc.detail) if isinstance(exc,HTTPException) else '即梦结果下载中断。')+' 点击继续查询，不会重新生成。');jobs.save(job);return
                    downloaded_text=(downloaded.stdout or '')+'\n'+(downloaded.stderr or '')
                    downloaded_id=_submit_id(downloaded_text)
                    download_state,_=_gen_state(downloaded_text)
                    if _has_conflicting_submit_ids(downloaded_text) or downloaded_id!=str(child['upstream_id']):
                        job.update(status='paused',error='即梦下载结果的任务编号缺失或与本地记录不一致，已停止保存。');jobs.save(job);return
                    if download_state=='failed':
                        child.update(status='failed',error=_failure(downloaded_text,{}));job.update(status='failed',error=child['error']);jobs.save(job);return
                    if downloaded.returncode != 0 or download_state!='success':
                        job.update(status='paused',error='即梦任务已完成，但结果下载失败。点击继续查询，不会重新生成。');jobs.save(job);return
                    break
                if state=='unknown':
                    job.update(status='paused',error='即梦任务状态无法识别，已停止自动轮询。点击继续查询或在即梦任务记录核对，不会重新生成。');jobs.save(job);return
                if result.returncode and not _submit_id(text):
                    job.update(status='paused',error='即梦任务仍在运行或查询暂不可用。点击继续查询，不会重新生成。');jobs.save(job);return
                child['progress']=data.get('progress',0);jobs.save(job)
                await asyncio.sleep(jobs.POLL_SECONDS)
            files=_result_files(task_dir)
            expected={'.mp4','.mov','.webm','.m4v'} if req['kind']=='video' else {'.png','.jpg','.jpeg','.webp','.bmp'}
            files=[path for path in files if path.suffix.lower() in expected]
            if not files:
                job.update(status='paused',error='即梦报告任务完成，但本地未找到下载结果。点击继续查询，不会重新生成。');jobs.save(job);return
            outputs=[]
            try:
                for i,path in enumerate(files):
                    kind='video' if path.suffix.lower() in {'.mp4','.mov','.webm','.m4v'} else 'image'
                    outputs.append(jobs.persist_local_media(path,kind,job_id,f'{index}-{i}',request=req))
            except Exception as exc:
                job.update(status='paused',error='生成已完成，但本地保存失败：'+(str(exc.detail) if isinstance(exc,HTTPException) else '请检查输出目录空间与权限。')+' 点击继续保存/查询，不会重新生成。')
                jobs.save(job);return
            child.update(status='succeeded',outputs=outputs,usage=None);job['error']='';jobs.save(job)
        job.update(status='succeeded',error='');jobs.save(job)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        if job['status']!='uncertain':job['status']='paused' if isinstance(exc,HTTPException) and exc.status_code in (401,409,503,504) else 'failed'
        job['error']=str(exc.detail) if isinstance(exc,HTTPException) else '即梦 CLI 调用失败，请检查本机程序与账号状态。'
        if job['status']=='uncertain':job['error']+=' 提交结果待核实，不会自动重复生成。'
        jobs.save(job)


def _login_values(text):
    data = _json_records(text)
    uri = _nested(data,'verification_uri','verification_url','url')
    user_code = _nested(data,'user_code','userCode','code')
    device_code = _nested(data,'device_code','deviceCode')
    raw = str(text or '')
    def regex(name):
        m = re.search(r'(?i)["\']?'+name+r'["\']?\s*[:=]\s*["\']?([^\s,"\'}]+)', raw)
        return m.group(1) if m else None
    return uri or regex('verification_uri'), user_code or regex('user_code'), device_code or regex('device_code')


def _active_jobs(jobs):
    items=[]
    for path in jobs.directory().glob('*.json'):
        try:
            job=json.loads(path.read_text(encoding='utf-8'))
            if job.get('request',{}).get('provider_id')==PROVIDER: items.append(job)
        except (OSError,ValueError,TypeError): pass
    return items


def _unresolved_account_jobs(jobs):
    return [job for job in _active_jobs(jobs)
            if job.get('status') not in ('succeeded','failed','cancelled','complete','completed')]


async def _begin_login_flow():
    global _LOGIN
    _prune_login_sessions()
    # relogin is the CLI's documented forced OAuth flow, which clears the
    # prior account before issuing a fresh device code for account changes.
    _LOGIN.clear()
    _clear_status_cache()
    result=await asyncio.to_thread(_run_cli,['relogin','--headless'],timeout=30)
    uri,code,device=_login_values(result.stdout+'\n'+result.stderr)
    if result.returncode and not device: raise HTTPException(502,'即梦未能开始设备授权，请检查 CLI 输出或程序登录帮助。')
    if not (uri and code and device): raise HTTPException(502,'即梦授权响应不完整，未能安全取得设备验证信息。')
    from urllib.parse import urlsplit
    parsed=urlsplit(uri);host=(parsed.hostname or '').lower()
    try: invalid_url=bool(parsed.username or parsed.password or parsed.port)
    except ValueError: invalid_url=True
    if parsed.scheme!='https' or invalid_url or not any(host==root or host.endswith('.'+root) for root in ('dreamina.com','capcut.com','douyin.com','jimeng.jianying.com')):
        raise HTTPException(502,'即梦返回的授权网址未通过官方 HTTPS 域名校验。')
    login_id=secrets.token_urlsafe(18);_LOGIN[login_id]={'device_code':device,'expires_at':time.time()+900}
    return {'login_id':login_id,'verification_uri':uri,'user_code':code,'expires_in':900}


async def _check_login_flow(payload):
    global _AUTH, _ACCOUNT, _CREDIT, _STATUS_AT
    login_id=str(payload.get('login_id') or '')
    entry=_LOGIN.get(login_id)
    if not entry: raise HTTPException(404,'授权会话不存在或已过期，请重新开始授权。')
    if time.time()>=entry['expires_at']:
        _LOGIN.pop(login_id,None); raise HTTPException(410,'即梦设备授权已过期，请重新开始。')
    _prune_login_sessions()
    try: poll=max(1,min(int(payload.get('poll',5)),20))
    except (ValueError,TypeError): poll=5
    result=await asyncio.to_thread(_run_cli,['login','checklogin',f"--device_code={entry['device_code']}",f'--poll={poll}'],timeout=poll+8)
    output=result.stdout+'\n'+result.stderr
    success,data=_auth_state(output,result.returncode)
    # Completion messages may vary; accept a successful process only when output says done.
    done_hint=success or bool(re.search(r'(?i)(login\s+(?:success|complete)|authenticated|登录成功|授权成功)',output))
    if _LOGIN.get(login_id) is not entry or time.time()>=entry['expires_at']:
        _LOGIN.pop(login_id,None)
        if done_hint:
            await asyncio.to_thread(_run_cli,['logout'],timeout=30)
        _clear_status_cache()
        raise HTTPException(410,'本次授权已取消或过期，请重新开始授权。')
    done=False
    if done_hint:
        try:
            account_result=await asyncio.to_thread(_run_cli,['user_credit'],timeout=25)
            _,account,credit=_account_data(account_result)
            done=True
        except HTTPException:
            done=False
    if _LOGIN.get(login_id) is not entry or time.time()>=entry['expires_at']:
        _LOGIN.pop(login_id,None)
        if done_hint:
            await asyncio.to_thread(_run_cli,['logout'],timeout=30)
        _clear_status_cache()
        raise HTTPException(410,'本次授权已取消或过期，请重新开始授权。')
    if done:
        _AUTH=True;_ACCOUNT=account;_CREDIT=credit;_STATUS_AT=time.time();_LOGIN.pop(login_id,None)
        return {'authenticated':True,'complete':True,'message':'即梦账号已连接。'}
    waiting=bool(re.search(r'(?i)(pending|wait|authorization_pending|slow_down|等待|尚未授权)',output))
    if result.returncode==0 and not output.strip(): waiting=True
    if not waiting and result.returncode:
        return {'authenticated':False,'complete':False,'message':'即梦尚未完成授权，请确认网页授权状态后继续检查。'}
    return {'authenticated':False,'complete':False,'message':'等待你在即梦网页完成授权。'}


def install(core):
    global _CORE
    _CORE = core
    app = core.app
    original=core.public_api_providers
    def public_providers():
        cfg=config()
        return [p for p in original() if p.get('id')!=PROVIDER]+[
            dict(id=PROVIDER,name='即梦账号',base_url='dreamina-cli://local',enabled=cfg['enabled'],
                 protocol=PROVIDER,has_key=False,primary=False,
                 image_models=[m['id'] for m in _MODELS if m['kind']=='image' and cfg['models'].get(m['id'],True)],
                 video_models=[m['id'] for m in _MODELS if m['kind']=='video' and cfg['models'].get(m['id'],True)],chat_models=[])]
    core.public_api_providers=public_providers

    @app.get('/api/studio/dreamina/status')
    async def dreamina_status(): return await asyncio.to_thread(status)

    @app.get('/api/studio/dreamina/config')
    async def dreamina_config():
        cfg = config(); return {'enabled':cfg['enabled'],'cli_path':cfg['cli_path'],'models':cfg['models']}

    @app.put('/api/studio/dreamina/config')
    async def dreamina_save_config(payload: dict):
        global _LOGIN
        cfg=config()
        cli_path_changed=False
        if 'enabled' in payload and not isinstance(payload['enabled'], bool): raise HTTPException(400,'enabled 必须为布尔值。')
        if 'cli_path' in payload:
            path = str(payload['cli_path'] or '').strip()
            if path != str(cfg['cli_path'] or ''):
                cli_path_changed=True
                try:
                    import studio_generation as jobs
                    if any(job.get('status') not in ('succeeded','failed','uncertain') for job in _active_jobs(jobs)):
                        raise HTTPException(409,'即梦任务正在运行或等待查询，暂不能切换 CLI 路径或账号。')
                except ImportError: pass
            if path:
                candidate=Path(path).expanduser()
                if candidate.suffix.lower()!='.exe' or not candidate.is_file(): raise HTTPException(400,'即梦 CLI 路径必须指向存在的 .exe 文件。')
                path=str(candidate.resolve())
            cfg['cli_path']=path
        if 'models' in payload:
            prefs=payload['models']
            if not isinstance(prefs,dict) or set(prefs)-set(cfg['models']) or any(not isinstance(v,bool) for v in prefs.values()):
                raise HTTPException(400,'models 必须是已知模型 id 到布尔值的映射。')
            cfg['models'].update(prefs)
        if 'enabled' in payload: cfg['enabled']=payload['enabled']
        if cli_path_changed:
            with _auth_mutation():
                _write_config(cfg)
                _LOGIN.clear()
                _clear_status_cache()
        else:
            _write_config(cfg)
        return {'enabled':cfg['enabled'],'cli_path':cfg['cli_path'],'models':cfg['models']}

    @app.post('/api/studio/dreamina/login')
    async def dreamina_login():
        if not config()['enabled']: raise HTTPException(400,'请先启用即梦 CLI 通道。')
        import studio_generation as jobs
        if _unresolved_account_jobs(jobs):
            raise HTTPException(409,'仍有未完成或待核实的即梦任务。请先完成结果查询并保存输出，再重新授权或换号。')
        with _auth_mutation():
            return await _begin_login_flow()

    @app.post('/api/studio/dreamina/login-cancel')
    async def dreamina_login_cancel(payload: dict):
        login_id=str(payload.get('login_id') or '')
        existed=_LOGIN.pop(login_id,None) is not None
        return {'cancelled':existed}

    @app.post('/api/studio/dreamina/logout')
    async def dreamina_logout():
        global _LOGIN
        # Help confirms this removes local OAuth state without changing config
        # or task records. Only an explicit UI action reaches this endpoint.
        import studio_generation as jobs
        if _unresolved_account_jobs(jobs):
            raise HTTPException(409,'仍有未完成或待核实的即梦任务。请先完成结果查询并保存输出，再退出账号；这样可保留任务提交账号的查询能力。')
        with _auth_mutation():
            result=await asyncio.to_thread(_run_cli,['logout'],timeout=30)
            if result.returncode:
                raise HTTPException(502,'即梦 CLI 未能退出账号；本地连接状态保持原样。')
            _LOGIN.clear()
            _clear_status_cache()
            return {'authenticated':False,'message':'已退出本机即梦账号。'}

    @app.post('/api/studio/dreamina/login-check')
    async def dreamina_login_check(payload: dict):
        with _auth_mutation():
            return await _check_login_flow(payload)
