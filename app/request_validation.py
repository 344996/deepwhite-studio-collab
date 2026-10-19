"""Public validation diagnostics must contain schema metadata, never input."""
from typing import get_args


MESSAGES = {
    'missing': '此字段为必填项。',
    'string_type': '需要文本。', 'string_too_long': '文本过长。',
    'string_too_short': '文本不能为空或长度不足。',
    'int_type': '需要整数。', 'int_parsing': '需要整数。',
    'float_type': '需要数字。', 'float_parsing': '需要数字。',
    'bool_type': '需要布尔值。', 'bool_parsing': '需要布尔值。',
    'list_type': '需要列表。', 'dict_type': '需要对象。',
    'model_type': '需要符合结构的对象。', 'model_attributes_type': '需要对象。',
    'extra_forbidden': '包含不支持的字段。',
    'literal_error': '请选择支持的值。', 'enum': '请选择支持的值。',
    'json_invalid': 'JSON 格式不正确。',
    'too_long': '项目数量过多。', 'too_short': '项目数量不足。',
    'greater_than': '数值低于允许范围。', 'greater_than_equal': '数值低于允许范围。',
    'less_than': '数值超过允许范围。', 'less_than_equal': '数值超过允许范围。',
    'value_error': '值不符合字段要求。', 'assertion_error': '值不符合字段要求。',
    'invalid_value': '值不符合字段要求。',
}


def _schema_fields(request):
    """Allow only declared field names; mapping keys and extra names are input."""
    names = {'body', 'query', 'path', 'header', 'cookie'}
    seen = set()

    def visit(annotation):
        if id(annotation) in seen:
            return
        seen.add(id(annotation))
        for name, field in getattr(annotation, 'model_fields', {}).items():
            names.add(name)
            if isinstance(field.alias, str):
                names.add(field.alias)
            visit(field.annotation)
        for item in get_args(annotation):
            visit(item)

    def dependency(item):
        for group in ('body_params', 'query_params', 'path_params', 'header_params', 'cookie_params'):
            for field in getattr(item, group, []):
                names.add(field.name)
                if isinstance(field.alias, str):
                    names.add(field.alias)
                visit(getattr(getattr(field, 'field_info', None), 'annotation', None))
        for child in getattr(item, 'dependencies', []):
            dependency(child)

    dependency(getattr(request.scope.get('route'), 'dependant', None))
    return names


def public_validation_errors(request, errors):
    names = _schema_fields(request)
    result = []
    for error in errors:
        kind = error.get('type')
        if kind not in MESSAGES:
            kind = 'invalid_value'
        message = MESSAGES[kind]
        context = error.get('ctx') or {}
        if kind in ('string_too_long', 'string_too_short'):
            limit = context.get('max_length' if kind == 'string_too_long' else 'min_length')
            if type(limit) is int and 0 <= limit <= 1_000_000_000:
                message = (f'文本过长：最多允许 {limit} 个字符。' if kind == 'string_too_long'
                           else f'文本不能为空，且至少需要 {limit} 个字符。')
        location = [item if type(item) is int or (isinstance(item, str) and item in names)
                    else '[key]' for item in error.get('loc', ())]
        result.append({'loc': location, 'type': kind, 'msg': message})
    return result
