"""Run the unmodified portable engine and diagnose unusually slow startup."""
import faulthandler
import runpy
import sys
import threading
import time
import urllib.request
from pathlib import Path

main=Path(sys.argv[1]).resolve()
sys.argv=sys.argv[1:]
sys.path.insert(0,str(main.parent))
faulthandler.enable()
faulthandler.dump_traceback_later(90,repeat=False)

def ready():
    for _ in range(240):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8188/system_stats',timeout=1):
                faulthandler.cancel_dump_traceback_later();return
        except Exception:time.sleep(2)

threading.Thread(target=ready,daemon=True).start()
runpy.run_path(str(main),run_name='__main__')
