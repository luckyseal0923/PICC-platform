import base64
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from app import create_app
from runtime_settings import public_settings, public_env_file


def fake_key(role):
    payload=base64.urlsafe_b64encode(json.dumps({"role":role}).encode()).decode().rstrip("=")
    return "eyJ0eXAiOiJKV1QifQ."+payload+".synthetic-signature"


class RuntimeSettings(unittest.TestCase):
    def setUp(self):
        parent=Path(__file__).resolve().parents[1]/"instance/runtime-tests"
        parent.mkdir(parents=True,exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(dir=parent)

    def tearDown(self):
        self.temp.cleanup()

    def app(self,**overrides):
        return create_app({"TESTING":True,"DEMO_MODE":False,"SECRET_KEY":"runtime-test-only",
                           "DATABASE":str(Path(self.temp.name)/"test.sqlite3"),
                           "SUPABASE_PUBLIC_URL":"","SUPABASE_PUBLIC_KEY":"",**overrides})

    def test_host_environment_is_published_as_public_runtime_config(self):
        client=self.app(SUPABASE_PUBLIC_URL="https://database.example.test",SUPABASE_PUBLIC_KEY=fake_key("anon")).test_client()
        result=client.get("/assets/config.js")
        config=json.loads(result.text.removeprefix("window.PICC_CONFIG = ").strip().removesuffix(";"))
        self.assertEqual(config["supabaseUrl"],"https://database.example.test")
        self.assertEqual(config["supabaseAnonKey"],fake_key("anon"))
        self.assertEqual(result.headers["Cache-Control"],"no-store")
        result.close()

    def test_service_role_secret_is_never_published(self):
        for key in (fake_key("service_role"),"sb_secret_synthetic_never_publish"):
            with self.app(SUPABASE_PUBLIC_KEY=key).test_client().get("/assets/config.js") as result:
                self.assertNotIn(key,result.text)
                self.assertIn("setupError",result.text)

    def test_csp_allows_only_the_configured_supabase_origin(self):
        with self.app(SUPABASE_PUBLIC_URL="https://database.example.test").test_client().get("/") as result:
            csp=result.headers["Content-Security-Policy"]
            self.assertIn("https://database.example.test",csp)
            self.assertIn("wss://database.example.test",csp)
            self.assertNotIn("connect-src *",csp)

    def test_invalid_public_origins_are_rejected(self):
        for url in ("http://external.example.test","https://user:password@example.test","https://example.test/?key=secret","https://evil.example.test';connect-src *"):
            with self.assertRaises(ValueError):
                public_settings("",url,"")

    def test_publishable_keys_do_not_require_an_auth_identity(self):
        self.assertEqual(public_settings("","https://database.example.test","sb_publishable_synthetic")['supabaseAnonKey'],"sb_publishable_synthetic")

    def test_unconfigured_production_does_not_serve_fake_data(self):
        result=self.app().test_client().get("/api/workspace/config")
        self.assertEqual(result.status_code,503)
        self.assertNotIn("正在讀取",result.text)
        self.assertNotIn("csrf",result.json)

    def test_env_local_parser_reads_only_public_supabase_fields(self):
        path=Path(self.temp.name)/".env.local"
        path.write_text('NEXT_PUBLIC_SUPABASE_URL="https://database.example.test"\nNEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_synthetic\nSUPABASE_SERVICE_ROLE_KEY=never-read-this\n',encoding="utf-8")
        values=public_env_file(path)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY",values)
        self.assertEqual(values["NEXT_PUBLIC_SUPABASE_URL"],"https://database.example.test")
