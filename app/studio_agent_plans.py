"""Archived assistant plan compatibility; current runtime uses studio_canvas_services.

Kept for source/history compatibility only. studio_server does not register its routes.
"""
import copy
import uuid
from fastapi import HTTPException
import main as core
from studio_canvas_services import (APPLY_LOCK, ACTIVE_JOB_STATES, TOKEN,
    node_job_active, revision, project_assets, context, validate_plan)


def apply_plan(session, plan):
    canvas=core.load_canvas(session['canvas_id'])
    if plan.get('canvas_id')!=canvas['id'] or plan.get('project_id')!=(canvas.get('project') or 'default'):
        raise HTTPException(409,'方案所属画布或项目已变更。')
    applied=[n for n in canvas.get('nodes',[]) if n.get('studioAgentPlanId')==plan['id']]
    if applied:
        import studio_agent
        workflow=[n for n in canvas.get('nodes',[]) if n.get('studioAgentSession')==session['id']
                  and n.get('studioAgentNodeKind')=='skill-run']
        by_key={n.get('studioAgentKey'):n['id'] for n in applied}
        for entry in session['plan']['nodes']:
            if entry['key'] in by_key:entry['target_node_id']=by_key[entry['key']]
        session['plan']['applied']=True
        session['applied_node_ids']=[n['id'] for n in applied+workflow]
        studio_agent.save_session(session)
        return {'canvas':canvas,'node_ids':[n['id'] for n in applied+workflow],'already_applied':True}
    if revision(canvas)!=plan['base_revision']:
        raise HTTPException(409,'画布已发生变化。请在对话中要求重新整理方案，避免覆盖手工修改。')
    # Recheck live model availability and current asset ownership immediately before applying.
    import studio_agent
    fresh=validate_plan({'nodes':plan['nodes']},{**plan,'target_models':{
        n['kind']:{'provider_id':n['provider_id'],'model':n['model']} for n in plan['nodes']}},
        studio_agent.available_models()[1])
    nodes=canvas.setdefault('nodes',[]); connections=canvas.setdefault('connections',[])
    right=max([float(n.get('x',0))+float(n.get('w') or 500) for n in nodes]+[0])+180
    created=[]
    # Materialize the selected Skill execution as an ordinary editable prompt
    # node. Its metadata makes the workflow relationship explicit to extensions.
    turn=next((t for t in reversed(session.get('turns',[]))
               if (t.get('plan') or {}).get('id')==plan['id'] and t.get('status')=='completed'),{})
    inputs=[nid for nid in turn.get('node_ids',[]) if any(n.get('id')==nid and n.get('type')=='prompt' for n in nodes)]
    input_right=max([float(n.get('x',0))+float(n.get('w') or 310) for n in nodes if n.get('id') in inputs]+[right-180])
    input_y=min([float(n.get('y',0)) for n in nodes if n.get('id') in inputs]+[0])
    skill_x=input_right+180
    snapshots=turn.get('skill_snapshots') or {}
    skill_items=list(snapshots.items())
    skill_node_ids=[]
    for si,(skill_id,skill) in enumerate(skill_items):
        key='skill-run-'+(str(skill_id) if skill_id else 'default')
        skill_node=next((n for n in nodes if n.get('studioAgentSession')==session['id']
                         and n.get('studioAgentKey')==key),None)
        requirements=turn.get('user_message','')
        input_titles=[next((n.get('studioTitle') or n.get('name') or n.get('id') for n in nodes if n.get('id')==nid),nid) for nid in inputs]
        node_text=('技能：'+str(skill.get('name') or '已选技能')+'\n'
                   '输入资料：'+('、'.join(input_titles) if inputs else '未附加剧本文本节点')+'\n'
                   '补充要求：'+requirements)
        if skill_node is None:
            skill_node={'id':'agent_skill_'+uuid.uuid4().hex,'type':'prompt','x':skill_x,
                        'y':input_y+si*460,'w':420,'text':node_text}
            nodes.append(skill_node)
        skill_node.update(text=node_text,studioTitle=str(skill.get('name') or 'Agent 运行')+' · Skill 运行',
            studioAgentNodeKind='skill-run',studioAgentSession=session['id'],studioAgentKey=key,
            studioSkillNode={'skill_id':skill_id,'name':str(skill.get('name') or 'Agent 运行'),
                'input_node_ids':inputs,'requirements':requirements,'request_id':turn.get('request_id',''),
                'status':'ready','statusLabel':'方案已写入'})
        skill_node_ids.append(skill_node['id'])
    # Workflow relationships live in metadata and are drawn by the extension.
    # They deliberately do not enter the canvas connection graph, which is
    # interpreted by existing generation code as actual prompt/media input.
    for index,proposal in enumerate(fresh['nodes']):
        node=next((n for n in nodes if n['id']==proposal['target_node_id']),None) if proposal['target_node_id'] else None
        if node is None:
            node=next((n for n in nodes if n.get('studioAgentSession')==session['id']
                       and n.get('studioAgentKey')==proposal['key']
                       and n.get('type')==('generator' if proposal['kind']=='image' else 'video')),None)
        if node is None:
            node={'id':'agent_'+uuid.uuid4().hex,'type':'generator' if proposal['kind']=='image' else 'video',
                'x':skill_x+1040+(index%2)*820,'y':input_y+(index//2)*660,'w':660,'inputs':[],'count':1}
            nodes.append(node)
        elif node_job_active(node):
            raise HTTPException(409,'任务尚未确认结束的节点不能覆盖。')
        # Preserve generated media; replace only the reviewed draft/input configuration.
        connections[:]=[c for c in connections if c.get('to')!=node['id']]
        node.update(studioTitle=proposal['title'],studioPrompt=proposal['prompt'],apiProvider=proposal['provider_id'],
            model=proposal['model'],studioParams=proposal['params'],studioParamsModel=proposal['model'],
            studioAgentPlanId=plan['id'],studioAgentSession=session['id'],studioAgentKey=proposal['key'],
            studioRefs=[],studioExcludedRefs=[],studioRefRoles={},studioRefOrder=[],studioRefLabels={},
            multimodal=True,useFrameRoles=False,studioReferenceChoice=True)
        node['studioAgentSkillNodeId']=skill_node_ids[0] if skill_node_ids else ''
        for ri,reference in enumerate(proposal['references']):
            source=next((n for n in nodes if n.get('type')=='image' and n.get('url')==reference['url']),None)
            if source is None:
                source={'id':'agent_ref_'+uuid.uuid4().hex,'type':'image','url':reference['url'],
                    'name':reference['name'],'mediaKind':reference['kind'],'x':node['x']-340,'y':node['y']+ri*300,
                    'w':280,'h':260,'studioAssetRefs':[{'version_id':reference['version_id'],'asset_id':reference['asset_id'],
                        'project_id':plan['project_id'],'url':reference['url']}]}
                nodes.append(source)
            node['studioRefOrder'].append(reference['url']);node['studioRefLabels'][reference['url']]=reference['mention']
            connections.append({'id':'agent_conn_'+uuid.uuid4().hex,'from':source['id'],'to':node['id'],'studioRole':'media-reference'})
        created.append(node['id'])
    for skill_node_id in skill_node_ids:
        skill_node=next(n for n in nodes if n['id']==skill_node_id)
        skill_node['studioSkillNode']['output_node_ids']=created[:]
    for node in nodes:
        if node.get('id') in inputs and node.get('studioAgentSession')==session['id'] and node.get('studioAgentNodeKind')=='script-source':
            node['studioAgentSkillNodeIds']=skill_node_ids[:]
    core.save_canvas(canvas)
    session['applied_node_ids']=created+skill_node_ids
    for entry,nid in zip(session['plan']['nodes'],created):entry['target_node_id']=nid
    session['plan']['applied']=True
    studio_agent.save_session(session)
    return {'canvas':canvas,'node_ids':created+skill_node_ids,'already_applied':False}


def install(app):
    @app.post('/api/studio/agent/sessions/{sid}/apply')
    async def apply(sid:str,payload:dict):
        import studio_agent
        with APPLY_LOCK:
            session=studio_agent.read_session(sid)
            if session.get('status')=='running':raise HTTPException(409,'请等待当前对话完成。')
            plan=session.get('plan')
            if not plan or plan.get('id')!=payload.get('plan_id'):raise HTTPException(409,'方案已更新，请查看最新方案。')
            return apply_plan(session,copy.deepcopy(plan))
