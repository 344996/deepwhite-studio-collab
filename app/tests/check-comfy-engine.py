import asyncio,json,os,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch,AsyncMock,Mock
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
runtime=tempfile.TemporaryDirectory(prefix='deepwhite-engine-test-')
os.environ['DEEPWHITE_STUDIO_RUNTIME_DIR']=runtime.name
import studio_comfy_engine as engine
from fastapi import HTTPException

class Engine(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        engine.PROCESS=None;engine.START_TASK=None;engine.ERROR=''
        self.root=Path(runtime.name)/'pack';(self.root/'python').mkdir(parents=True,exist_ok=True);(self.root/'ComfyUI').mkdir(exist_ok=True)
        (self.root/'python/python.exe').touch();(self.root/'ComfyUI/main.py').touch()
        engine.settings_path().parent.mkdir(parents=True,exist_ok=True)
        engine.settings_path().write_text(engine.Settings(directory=str(self.root)).model_dump_json())

    async def test_existing_engine_not_spawned_or_stopped(self):
        with patch.object(engine,'probe',AsyncMock(return_value=True)),patch.object(engine.subprocess,'Popen') as spawn:
            self.assertEqual((await engine.start())['state'],'ready');spawn.assert_not_called()
            self.assertFalse((await engine.stop())['stopped'])

    async def test_one_start_for_concurrent_requests(self):
        gate=asyncio.Event()
        async def boot():await gate.wait()
        with patch.object(engine,'probe',AsyncMock(return_value=False)),patch.object(engine,'boot',side_effect=boot) as boot_mock:
            await asyncio.gather(engine.start(),engine.start(),engine.start());self.assertEqual(boot_mock.call_count,1)
            gate.set();await engine.START_TASK

    async def test_auto_start_disabled(self):
        engine.settings_path().write_text(engine.Settings(directory=str(self.root),auto_start=False).model_dump_json())
        with patch.object(engine,'probe',AsyncMock(return_value=False)),patch.object(engine,'start',AsyncMock()) as start:
            with self.assertRaises(HTTPException):await engine.ensure()
            start.assert_not_called()

    async def test_hidden_launch_command_and_failure(self):
        process=Mock();process.poll.return_value=1
        sock=Mock();sock.__enter__=Mock(return_value=sock);sock.__exit__=Mock(return_value=False);sock.connect_ex.return_value=1
        with patch.object(engine,'probe',AsyncMock(return_value=False)),patch.object(engine.socket,'socket',return_value=sock),patch.object(engine.subprocess,'Popen',return_value=process) as spawn:
            await engine.boot();args=spawn.call_args.args[0]
            self.assertIn('--disable-auto-launch',args);self.assertIn('127.0.0.1',args)
            self.assertEqual(spawn.call_args.kwargs['cwd'],self.root/'ComfyUI');self.assertIn('退出',engine.ERROR)

    async def test_occupied_port_never_launches(self):
        sock=Mock();sock.__enter__=Mock(return_value=sock);sock.__exit__=Mock(return_value=False);sock.connect_ex.return_value=0
        with patch.object(engine,'probe',AsyncMock(return_value=False)),patch.object(engine.socket,'socket',return_value=sock),patch.object(engine.subprocess,'Popen') as spawn:
            await engine.boot();spawn.assert_not_called();self.assertIn('端口',engine.ERROR)

    async def test_bad_directory(self):
        with self.assertRaises(HTTPException):engine.layout(str(self.root/'missing'))

    async def test_busy_engine_is_not_stopped(self):
        import studio_generation as jobs
        process=Mock();process.poll.return_value=None;engine.PROCESS=process
        response=Mock();response.json.return_value={'queue_running':[[1]],'queue_pending':[]}
        client=AsyncMock();client.__aenter__.return_value=client;client.get.return_value=response
        with patch.object(engine.httpx,'AsyncClient',return_value=client),patch.object(jobs,'WORKERS',{}):
            with self.assertRaises(HTTPException):await engine.stop()
            process.terminate.assert_not_called()

    async def test_idle_owned_engine_stops(self):
        import studio_generation as jobs
        process=Mock();process.poll.return_value=None;engine.PROCESS=process
        response=Mock();response.json.return_value={'queue_running':[],'queue_pending':[]}
        client=AsyncMock();client.__aenter__.return_value=client;client.get.return_value=response
        with patch.object(engine.httpx,'AsyncClient',return_value=client),patch.object(jobs,'WORKERS',{}):
            self.assertTrue((await engine.stop())['stopped']);process.terminate.assert_called_once()

if __name__=='__main__':unittest.main()
