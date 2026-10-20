"""Version HTML at delivery time without changing an installed release.

StaticFiles still validates and resolves every request path. Only its regular
HTML file response is replaced; other files keep Starlette's normal behavior.
"""
from collections.abc import Callable
import hashlib
from pathlib import Path

import anyio
from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.responses import Response
from starlette.staticfiles import NotModifiedResponse, StaticFiles


class _VersionedHTMLResponse(Response):
    def __init__(self, path, transform, is_not_modified, status_code=200):
        super().__init__(status_code=status_code, headers={"Cache-Control": "no-cache"})
        # This path comes only from StaticFiles.lookup_path, never the URL.
        self.path = path
        self.transform = transform
        self.is_not_modified = is_not_modified

    def _content(self):
        text = Path(self.path).read_text(encoding="utf-8")
        return self.transform(text).encode("utf-8")

    async def __call__(self, scope, receive, send):
        try:
            content = await anyio.to_thread.run_sync(self._content)
        except (FileNotFoundError, NotADirectoryError):
            raise HTTPException(status_code=404) from None
        except PermissionError:
            raise HTTPException(status_code=401) from None
        # A disk-mtime validator is insufficient: VERSION and referenced assets
        # may change while the HTML bytes remain identical across releases.
        response = Response(
            content,
            status_code=self.status_code,
            media_type="text/html",
            headers={
                "Cache-Control": "no-cache",
                "ETag": '"' + hashlib.sha256(content).hexdigest() + '"',
            },
        )
        if self.status_code == 200 and self.is_not_modified(
            response.headers, Headers(scope=scope)
        ):
            response = NotModifiedResponse(response.headers)
        elif scope["method"] == "HEAD":
            # Keep the GET representation's Content-Length but send no body.
            response.body = b""
        await response(scope, receive, send)


class VersionedStaticFiles(StaticFiles):
    def __init__(self, *, transform: Callable[[str], str], **kwargs):
        super().__init__(**kwargs)
        self.transform = transform

    def file_response(self, full_path, stat_result, scope, status_code=200):
        if Path(full_path).suffix.lower() == ".html":
            return _VersionedHTMLResponse(
                full_path, self.transform, self.is_not_modified, status_code
            )
        return super().file_response(full_path, stat_result, scope, status_code)
