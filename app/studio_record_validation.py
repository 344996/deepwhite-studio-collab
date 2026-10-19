"""Pure persisted-record validation shared by normal reads and update readiness."""


def project_index(data):
    projects = data.get('projects') if isinstance(data, dict) else data
    if not isinstance(projects, list):
        raise ValueError('项目列表格式无效')
    ids = set()
    for project in projects:
        if not isinstance(project, dict) or not isinstance(project.get('id'), str) or not project['id']:
            raise ValueError('项目编号缺失或格式无效')
        if project['id'] in ids:
            raise ValueError('项目编号重复')
        ids.add(project['id'])
    return projects


def canvas_record(data):
    if not isinstance(data, dict): raise ValueError('画布记录必须是对象')
    for field in ('nodes', 'connections'):
        if field in data and (not isinstance(data[field], list) or any(not isinstance(v, dict) for v in data[field])):
            raise ValueError('画布节点或连线格式不正确')
    return data
