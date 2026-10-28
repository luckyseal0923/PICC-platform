import base64
import csv
import hashlib
import hmac
import io
import json
from pathlib import Path
import sqlite3
import sys
import subprocess
import threading
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import create_app, SHARED_ENTRY_ID, SHARED_WORKSPACE_ID


class PiccWorkflows(unittest.TestCase):
    def setUp(self):
        self.test_root = Path(__file__).resolve().parents[1] / "instance" / "tests"
        self.test_root.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=self.test_root)
        self.path = str(Path(self.temp.name) / "test.sqlite3")
        self.app = create_app({"TESTING": True, "DEMO_MODE": True, "DATABASE": self.path,
                               "SECRET_KEY": "unit-test-only-key", "SESSION_COOKIE_SECURE": False})
        with closing(sqlite3.connect(self.path, isolation_level=None)) as db:
            for table in ["events", "notifications", "idempotency", "tasks"]:
                db.execute("DELETE FROM " + table)
        self.client, self.headers = self.login("demo-admin")

    def tearDown(self):
        self.assertEqual(Path(self.temp.name).resolve().parent, self.test_root.resolve())
        self.temp.cleanup()

    def login(self, uid):
        client = self.app.test_client()
        result = client.post("/api/auth/demo", json={"userId": uid})
        self.assertEqual(result.status_code, 200)
        return client, {"X-CSRF-Token": result.json["csrf"]}

    def create(self, **extra):
        payload = {"patientName": "DEMO 個案", "bedNo": "測試01", "mrn": "DEMO001",
                   "requestId": "request-" + str(uuid.uuid4()), "duplicateAcknowledged": True}
        payload.update(extra)
        response = self.client.post("/api/tasks", json=payload, headers=self.headers)
        self.assertEqual(response.status_code, 201, response.json)
        return response.json["task"]

    def line_signature(self, raw_body, secret="line-webhook-test-secret"):
        return base64.b64encode(hmac.new(secret.encode(), raw_body, hashlib.sha256).digest()).decode()

    def claim(self, task, operator="demo-a"):
        return self.client.post(f"/api/tasks/{task['id']}/claim",
                                json={"version": task["version"], "operatorId": operator}, headers=self.headers)

    def report(self, task, operator="demo-b", **extra):
        return self.client.post(f"/api/tasks/{task['id']}/complete",
                                json={"version": task["version"], "operatorId": operator, "difficulty": "困難",
                                      "insertionSite": "右上臂", "vein": "Basilic", "catheterType": "雙腔PICC",
                                      "catheterLength": 42.5, "remark": "示範測試", **extra},
                                headers=self.headers)

    def test_actual_procedure_time_preserves_taipei_date_and_server_audit_time(self):
        claimed = self.claim(self.create()).json["task"]
        response = self.report(claimed, completedAt="2026-09-30T23:45")
        self.assertEqual(response.status_code, 200, response.json)
        done = response.json["task"]
        self.assertEqual(done["completedAt"], "2026-09-30T15:45:00+00:00")
        self.assertNotEqual(done["completedAt"], done["updatedAt"])
        stats = self.client.get("/api/stats").json
        self.assertEqual(next(m["count"] for m in stats["months"] if m["month"] == "2026-09"), 1)

    def test_self_report_can_record_an_earlier_actual_procedure_time(self):
        task = self.create(selfReport=True, operatorId="demo-a", difficulty="簡單", insertionSite="右上臂",
                           vein="Basilic", catheterType="單腔PICC", completedAt="2026-10-01T00:05")
        self.assertEqual(task["completedAt"], "2026-09-30T16:05:00+00:00")
        self.assertNotEqual(task["createdAt"], task["completedAt"])
        self.assertEqual(task["claimedAt"], task["createdAt"])

    def test_invalid_actual_procedure_time_does_not_complete_the_case(self):
        task = self.claim(self.create()).json["task"]
        response = self.report(task, completedAt="not-a-date")
        self.assertEqual(response.status_code, 400)
        self.assertIn("施打時間格式", response.json["error"])
        done = self.report(task).json["task"]
        self.assertEqual(done["status"], "completed")
        self.assertTrue(done["completedAt"])

    def test_two_active_stages_complete_directly_with_a_valid_lower_limb_report(self):
        task = self.claim(self.create()).json["task"]
        # The shared workspace has its own CSRF token.
        token = self.client.get("/api/workspace/config").json["csrf"]
        response = self.client.post(f"/api/workspace/tasks/{task['id']}/performed", json={"version": task["version"]}, headers={"X-CSRF-Token":token})
        self.assertEqual(response.status_code, 409, response.json)
        waiting = task
        self.assertEqual(waiting["status"], "claimed")
        self.assertEqual(self.client.get("/api/stats").json["totalCompleted"], 0)
        for site in ("左下肢", "右下肢"):
            current = waiting if site == "左下肢" else self.claim(self.create()).json["task"]
            report = {"version": current["version"], "operatorId":"demo-b", "difficulty":"簡單", "insertionSite":site, "vein":"Basilic", "catheterType":"單腔PICC"}
            result = self.client.post(f"/api/tasks/{current['id']}/complete", json=report, headers=self.headers)
            self.assertEqual(result.status_code, 200, result.json)
            self.assertEqual(result.json["task"]["insertionSite"], site)
        self.assertEqual(self.client.get("/api/stats").json["totalCompleted"], 2)

    def test_seven_day_duplicate_warning_requires_acknowledgement_without_creating_a_row(self):
        self.create(mrn="DUPLICATE-TEST")
        payload = {"patientName":"DEMO duplicate", "bedNo":"TEST", "mrn":" DUPLICATE-TEST ", "requestId":"warning-test"}
        result = self.client.post("/api/tasks", json=payload, headers=self.headers)
        self.assertEqual(result.json["duplicateCount"], 1)
        self.assertTrue(result.json["requiresDuplicateConfirmation"])
        self.assertEqual(len(self.client.get("/api/tasks").json["tasks"]), 1)
        payload["duplicateAcknowledged"] = True
        accepted = self.client.post("/api/tasks", json=payload, headers=self.headers)
        self.assertEqual(accepted.status_code, 201)
        retry = self.client.post("/api/tasks", json=payload, headers=self.headers)
        self.assertEqual(retry.json["task"]["id"], accepted.json["task"]["id"])
        self.assertEqual(len(self.client.get("/api/tasks").json["tasks"]), 2)

    def test_legacy_local_schema_upgrade_preserves_cases_audit_and_foreign_keys(self):
        task = self.create()
        legacy = Path(self.temp.name) / "legacy.sqlite3"
        with closing(sqlite3.connect(self.path)) as source, closing(sqlite3.connect(legacy)) as target:
            for table in ("users", "tasks", "events", "idempotency", "notifications"):
                schema = source.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()[0]
                target.execute(schema.replace(",'awaiting_report'", ""))
                rows = source.execute("SELECT * FROM " + table).fetchall()
                if rows:
                    target.executemany("INSERT INTO " + table + " VALUES(" + ",".join("?" for _ in rows[0]) + ")", rows)
            target.commit()
        create_app({"TESTING":True,"DEMO_MODE":True,"DATABASE":str(legacy),"SECRET_KEY":"test-only"})
        with closing(sqlite3.connect(legacy)) as connection:
            self.assertEqual(connection.execute("SELECT id FROM tasks").fetchone()[0], task["id"])
            self.assertGreater(connection.execute("SELECT COUNT(*) FROM events").fetchone()[0], 0)
            self.assertFalse(connection.execute("PRAGMA foreign_key_check").fetchall())
            connection.execute("UPDATE tasks SET status='awaiting_report'")
        self.assertTrue(Path(str(legacy)+".before-workflow-v3.sqlite3").exists())

    def test_monthly_numbering_and_csv_preserve_new_status_codes(self):
        first = self.create(mrn="MONTHLY-ONE")
        second = self.claim(self.create(mrn="MONTHLY-TWO")).json["task"]
        self.assertRegex(first["taskId"], r"^PICC-[0-9]{4}-001$")
        self.assertTrue(second["taskId"].endswith("-002"))
        content = self.client.get("/api/export").data.decode("utf-8-sig")
        rows = list(csv.DictReader(io.StringIO(content)))
        self.assertEqual({row["狀態代碼"] for row in rows}, {"pending", "claimed"})
        for row in rows:
            row["任務編號"] += "-COPY"
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=rows[0].keys())
        writer.writeheader();writer.writerows(rows)
        result = self.client.post("/api/import", data={"file":(io.BytesIO(output.getvalue().encode()),"new.csv")},headers=self.headers)
        self.assertEqual(result.status_code,200,result.json)
        copied = [row for row in self.client.get("/api/tasks").json["tasks"] if row["taskId"].endswith("-COPY")]
        self.assertEqual({row["status"] for row in copied}, {"pending", "claimed"})

    def test_anonymous_and_csrf_are_rejected(self):
        anonymous = self.app.test_client()
        self.assertEqual(anonymous.get("/api/tasks").status_code, 401)
        self.assertEqual(anonymous.get("/api/stats").status_code, 401)
        self.assertEqual(self.client.post("/api/tasks", json={}).status_code, 403)
        self.assertEqual(self.client.post("/api/tasks", json={}, headers={**self.headers, "Origin": "https://foreign.invalid"}).status_code, 403)

    def test_line_webhook_requires_configuration_and_valid_signature(self):
        anonymous = self.app.test_client()
        raw = json.dumps({"events": []}, separators=(",", ":")).encode()
        self.assertEqual(anonymous.post("/api/line/webhook", data=raw, content_type="application/json").status_code, 503)
        self.app.config["LINE_MESSAGING_CHANNEL_SECRET"] = "line-webhook-test-secret"
        self.assertEqual(anonymous.post("/api/line/webhook", data=raw, content_type="application/json",
                                        headers={"X-Line-Signature": "invalid"}).status_code, 401)
        verified = anonymous.post("/api/line/webhook", data=raw, content_type="application/json",
                                  headers={"X-Line-Signature": self.line_signature(raw)})
        self.assertEqual(verified.status_code, 200, verified.json)
        self.assertEqual(verified.json, {"ok": True, "accepted": 0, "testReplies": 0})

    def test_line_webhook_tracks_targets_without_storing_message_text_and_deduplicates(self):
        self.app.config["LINE_MESSAGING_CHANNEL_SECRET"] = "line-webhook-test-secret"
        anonymous = self.app.test_client()
        event = {
            "type": "message", "webhookEventId": "01H-WEBHOOK-TEST",
            "deliveryContext": {"isRedelivery": False},
            "source": {"type": "group", "groupId": "Cgroup-test", "userId": "Uactor-test"},
            "message": {"id": "message-test", "type": "text", "text": "病人姓名不應保存"},
        }
        raw = json.dumps({"events": [event]}, ensure_ascii=False, separators=(",", ":")).encode()
        headers = {"X-Line-Signature": self.line_signature(raw)}
        first = anonymous.post("/api/line/webhook", data=raw, content_type="application/json", headers=headers)
        second = anonymous.post("/api/line/webhook", data=raw, content_type="application/json", headers=headers)
        self.assertEqual(first.json["accepted"], 1)
        self.assertEqual(second.json["accepted"], 0)
        with closing(sqlite3.connect(self.path)) as connection:
            recipient = connection.execute(
                "SELECT source_type,source_id,actor_user_id,active,last_event_type FROM line_recipients"
            ).fetchone()
            self.assertEqual(recipient, ("group", "Cgroup-test", "Uactor-test", 1, "message"))
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM line_webhook_events").fetchone()[0], 1)
            database_text = " ".join(
                str(value) for row in connection.execute("SELECT * FROM line_webhook_events") for value in row
            )
            self.assertNotIn("病人姓名不應保存", database_text)

    def test_line_webhook_marks_a_departed_target_inactive(self):
        self.app.config["LINE_MESSAGING_CHANNEL_SECRET"] = "line-webhook-test-secret"
        anonymous = self.app.test_client()
        for event_type, event_id in (("join", "join-event"), ("leave", "leave-event")):
            event = {"type": event_type, "webhookEventId": event_id,
                     "source": {"type": "group", "groupId": "Cdeparted-group"}}
            raw = json.dumps({"events": [event]}, separators=(",", ":")).encode()
            response = anonymous.post("/api/line/webhook", data=raw, content_type="application/json",
                                      headers={"X-Line-Signature": self.line_signature(raw)})
            self.assertEqual(response.status_code, 200, response.json)
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute(
                "SELECT active,last_event_type FROM line_recipients WHERE source_id='Cdeparted-group'"
            ).fetchone(), (0, "leave"))

    def test_line_webhook_test_phrase_replies_without_persisting_text(self):
        self.app.config.update(
            LINE_MESSAGING_CHANNEL_SECRET="line-webhook-test-secret",
            LINE_MESSAGING_CHANNEL_ACCESS_TOKEN="line-access-token-test",
        )
        event = {
            "type": "message", "webhookEventId": "webhook-reply-test", "replyToken": "reply-token-test",
            "source": {"type": "group", "groupId": "Creply-group", "userId": "Ureply-user"},
            "message": {"id": "message-reply-test", "type": "text", "text": "Webhook 測試"},
        }
        raw = json.dumps({"events": [event]}, ensure_ascii=False, separators=(",", ":")).encode()

        class FakeResponse:
            status = 200
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return None

        class FakeOpener:
            def open(self, line_request, timeout):
                self.request = line_request
                self.timeout = timeout
                return FakeResponse()

        opener = FakeOpener()
        with patch("app.urlrequest.build_opener", return_value=opener):
            response = self.app.test_client().post(
                "/api/line/webhook", data=raw, content_type="application/json",
                headers={"X-Line-Signature": self.line_signature(raw)},
            )
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json["testReplies"], 1)
        self.assertEqual(opener.request.full_url, "https://api.line.me/v2/bot/message/reply")
        self.assertEqual(opener.request.headers["Authorization"], "Bearer line-access-token-test")
        sent = json.loads(opener.request.data)
        self.assertEqual(sent["replyToken"], "reply-token-test")
        self.assertEqual(sent["messages"][0]["text"], "PICC 網站 Webhook 已成功連線")
        with closing(sqlite3.connect(self.path)) as connection:
            database_text = " ".join(
                str(value) for table in ("line_webhook_events", "line_recipients")
                for row in connection.execute("SELECT * FROM " + table) for value in row
            )
        self.assertNotIn("Webhook 測試", database_text)

    def test_three_mobile_entries_have_no_patient_data_before_login(self):
        anonymous = self.app.test_client()
        with anonymous.get("/") as landing:
            self.assertEqual(landing.status_code, 200)
            self.assertIn(b'/assets/landing.js', landing.data)
        for route in ("picc-create", "picc-booking", "picc-report"):
            for suffix in ("", "/"):
                with anonymous.get("/" + route + suffix) as result:
                    self.assertEqual(result.status_code, 200)
                    self.assertIn(b'/assets/entry.js', result.data)
                    self.assertNotIn(b'id="navigation"', result.data)
                    self.assertNotIn(b'loginSection', result.data)
                    self.assertNotIn(b'lineLogin', result.data)
                    self.assertEqual(result.headers["X-Frame-Options"], "DENY")
        self.assertEqual(anonymous.get("/api/tasks?status=pending").status_code, 401)

    def test_three_entry_client_round_trip_over_real_http(self):
        from werkzeug.serving import make_server
        server = make_server("127.0.0.1", 0, self.app, threaded=True)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = subprocess.run(
                ["node", "tests/entry-integration.mjs", f"http://127.0.0.1:{server.server_port}/"],
                cwd=Path(__file__).resolve().parents[1], capture_output=True,
                encoding="utf-8", errors="replace", timeout=45)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            stats = self.client.get("/api/stats").json
            self.assertEqual(stats["totalCompleted"], 2)
            self.assertEqual({row["operatorId"]: row["count"] for row in stats["operators"]}, {"demo-a": 1, "demo-b": 1})
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

    def test_shared_entries_need_no_identity_and_keep_forgery_and_admin_boundaries(self):
        anonymous = self.app.test_client()
        config = anonymous.get("/api/entry/config").json
        self.assertFalse(config["loginRequired"])
        self.assertFalse(config["user"]["verified"])
        headers = {"X-CSRF-Token": config["csrf"]}
        with anonymous.session_transaction() as shared_session:
            self.assertNotIn("uid", shared_session)
        members = anonymous.get("/api/entry/users").json["users"]
        self.assertNotIn(SHARED_ENTRY_ID, [member["id"] for member in members])
        data = {"patientName": "DEMO", "bedNo": "TEST", "mrn": "DEMO-SHARED", "requestId": "shared-test"}
        self.assertEqual(anonymous.post("/api/entry/tasks", json=data).status_code, 403)
        self.assertEqual(anonymous.post("/api/entry/tasks", json=data, headers={**headers,"Origin":"https://foreign.invalid"}).status_code, 403)
        created = anonymous.post("/api/entry/tasks", json=data, headers=headers)
        self.assertEqual(created.status_code, 201)
        task = created.json["task"]
        self.assertEqual(task["createdBy"], SHARED_ENTRY_ID)
        self.assertEqual(anonymous.get("/api/entry/tasks?status=pending").status_code, 200)
        self.assertEqual(anonymous.get("/api/entry/tasks?status=completed").status_code, 400)
        self.assertEqual(anonymous.post(f"/api/entry/tasks/{task['id']}/claim", json={"version":1,"operatorId":SHARED_ENTRY_ID}, headers=headers).status_code, 400)
        self.assertEqual(anonymous.get("/api/stats").status_code, 401)
        self.assertEqual(anonymous.get("/api/entry/stats").status_code, 404)
        self.assertEqual(anonymous.post("/api/entry/users", json={}, headers=headers).status_code, 405)
        self.assertEqual(anonymous.delete(f"/api/entry/tasks/{task['id']}", headers=headers).status_code, 405)
        self.app.config["DEMO_MODE"] = False
        self.assertEqual(anonymous.get("/api/entry/config").status_code, 503)

    def test_desktop_workspace_has_full_shared_features_without_login(self):
        anonymous = self.app.test_client()
        with anonymous.get("/workspace/") as page:
            self.assertIn(b'id="navigation"', page.data)
            self.assertNotIn(b'id="login"', page.data)
        config = anonymous.get("/api/workspace/config").json
        self.assertFalse(config["loginRequired"])
        self.assertTrue(config["sharedWorkspace"])
        self.assertFalse(config["user"]["verified"])
        self.assertEqual(config["user"]["id"], SHARED_WORKSPACE_ID)
        headers = {"X-CSRF-Token": config["csrf"]}
        self.assertEqual(anonymous.get("/api/workspace/stats").status_code, 200)
        members = anonymous.get("/api/workspace/users").json["users"]
        self.assertFalse({SHARED_ENTRY_ID, SHARED_WORKSPACE_ID} & {member["id"] for member in members})
        data = {"patientName":"DEMO desktop","bedNo":"TEST","mrn":"DEMO-DESKTOP","requestId":"workspace-request"}
        self.assertEqual(anonymous.post("/api/workspace/tasks",json=data).status_code,403)
        task = anonymous.post("/api/workspace/tasks",json=data,headers=headers).json["task"]
        self.assertEqual(task["createdBy"],SHARED_WORKSPACE_ID)
        edited = anonymous.put(f"/api/workspace/tasks/{task['id']}",json={**data,"version":task["version"],"remark":"DEMO edited"},headers=headers)
        self.assertEqual(edited.status_code,200)
        self.assertEqual(anonymous.get("/api/workspace/export").status_code,200)
        response = anonymous.post("/api/workspace/users",json={"name":"DEMO new member","role":"admin","enabled":True},headers=headers)
        self.assertEqual(response.status_code,200)
        added = next(member for member in anonymous.get("/api/workspace/users").json["users"] if member["name"]=="DEMO new member")
        self.assertEqual(added["role"],"operator")
        self.assertEqual(anonymous.get("/api/workspace/auth/demo").status_code,404)

    def test_complete_counts_actual_performer_not_claimer(self):
        task = self.claim(self.create()).json["task"]
        completed = self.report(task)
        self.assertEqual(completed.status_code, 200)
        stats = self.client.get("/api/stats").json
        self.assertEqual(stats["totalCompleted"], 1)
        self.assertEqual(stats["operators"][0]["operatorId"], "demo-b")
        a, _ = self.login("demo-a")
        b, _ = self.login("demo-b")
        self.assertEqual(a.get("/api/stats?scope=all").json["totalCompleted"], 0)
        self.assertEqual(b.get("/api/stats").json["totalCompleted"], 1)

    def test_cancel_requires_reason_and_keeps_original_after_reorder(self):
        task = self.create()
        url = f"/api/tasks/{task['id']}"
        self.assertEqual(self.client.post(url+"/cancel", json={"version": 1}, headers=self.headers).status_code, 400)
        self.assertEqual(self.client.post(url+"/cancel", json={"version": 1, "reason": "其他"}, headers=self.headers).status_code, 400)
        response = self.client.post(url+"/cancel", json={"version": 1, "reason": "醫囑調整", "detail": "DEMO原因"}, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["task"]["status"], "cancelled")
        self.assertEqual(self.client.get("/api/stats").json["totalCompleted"], 0)
        new_task = self.create(requestId="reorder-request", copiedFromTaskId=task["id"])
        self.assertEqual(new_task["status"], "pending")
        self.assertNotEqual(new_task["taskId"], task["taskId"])
        self.assertEqual(new_task["reorderOf"], task["id"])
        self.assertEqual(self.client.get(url).json["task"]["status"], "cancelled")
        self.assertEqual(self.client.post(url+"/reopen", json={"version": 2}, headers=self.headers).status_code, 404)
        events = self.client.get(url).json["events"]
        self.assertEqual([e for e in events if e["action"] == "cancelled"][0]["detail"]["reason"], "醫囑調整")
        self.assertEqual([e for e in events if e["action"] == "reordered"][0]["detail"]["newTaskId"], new_task["id"])

    def test_member_cannot_remove_or_export(self):
        task = self.create()
        member, headers = self.login("demo-a")
        for suffix, method in [("", "delete")]:
            response = getattr(member, method)(f"/api/tasks/{task['id']}"+suffix,
                                               json={"version": 1, "reason": "test"}, headers=headers)
            self.assertEqual(response.status_code, 403)
        self.assertEqual(member.get("/api/export").status_code, 403)
        self.assertEqual(member.post("/api/users", json={}, headers=headers).status_code, 403)

    def test_simultaneous_claim_has_one_winner(self):
        task = self.create()
        def attempt(uid):
            client, headers = self.login(uid)
            return client.post(f"/api/tasks/{task['id']}/claim",
                               json={"version": 1, "operatorId": uid}, headers=headers).status_code
        with ThreadPoolExecutor(2) as pool:
            statuses = list(pool.map(attempt, ["demo-a", "demo-b"]))
        self.assertEqual(sorted(statuses), [200, 409])
        events = self.client.get(f"/api/tasks/{task['id']}").json["events"]
        self.assertEqual(sum(e["action"] == "claimed" for e in events), 1)

    def test_duplicate_submission_does_not_create_second_task(self):
        payload = {"patientName": "DEMO", "bedNo": "TEST", "mrn": "DEMO", "requestId": "same-request"}
        first = self.client.post("/api/tasks", json=payload, headers=self.headers)
        second = self.client.post("/api/tasks", json=payload, headers=self.headers)
        self.assertEqual(first.json["task"]["id"], second.json["task"]["id"])
        self.assertTrue(second.json["duplicate"])
        payload["patientName"] = "different"
        self.assertEqual(self.client.post("/api/tasks", json=payload, headers=self.headers).status_code, 409)
        self.assertEqual(len(self.client.get("/api/tasks").json["tasks"]), 1)

    def test_quotes_and_html_remain_data(self):
        task = self.create(patientName="DEMO 'quoted' <img>", remark="=1+1")
        self.assertEqual(task["patientName"], "DEMO 'quoted' <img>")
        self.assertEqual(len(self.client.get("/api/tasks").json["tasks"]), 1)
        exported = self.client.get("/api/export").data.decode("utf-8-sig")
        self.assertIn("'=1+1", exported)

    def test_self_report_and_repeat_complete(self):
        task = self.create(selfReport=True, operatorId="demo-a", difficulty="簡單",
                           insertionSite="左上臂", vein="Brachial", catheterType="單腔PICC", catheterLength="35")
        self.assertEqual(task["status"], "completed")
        self.assertEqual(self.report(task).status_code, 409)
        self.assertEqual(self.client.get("/api/stats").json["totalCompleted"], 1)
        self.assertEqual(self.client.post(f"/api/tasks/{task['id']}/cancel",
                                         json={"version": 1, "reason": "其他", "detail": "DEMO"},
                                         headers=self.headers).status_code, 409)

    def test_taiwan_completion_date_boundary(self):
        task = self.report(self.claim(self.create()).json["task"]).json["task"]
        with closing(sqlite3.connect(self.path, isolation_level=None)) as db:
            db.execute("UPDATE tasks SET completed_at='2026-10-13T16:30:00+00:00' WHERE id=?", (task["id"],))
        self.assertEqual(self.client.get("/api/stats?start=2026-10-14&end=2026-10-14").json["totalCompleted"], 1)
        self.assertEqual(self.client.get("/api/stats?start=2026-10-13&end=2026-10-13").json["totalCompleted"], 0)

    def test_import_does_not_invent_completion_date_and_deduplicates(self):
        content = "起單時間,任務編號,病人姓名,床號,病歷號,Status,施打者\n2026/10/01 10:00,OLD-001,DEMO,TEST,DEMO,完成,示範施打者甲\n"
        def upload():
            return self.client.post("/api/import", data={"file": (io.BytesIO(content.encode()), "old.csv")}, headers=self.headers)
        result = upload()
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(result.json["missingCompletionDate"], 1)
        self.assertEqual(upload().json["skipped"], 1)
        stats = self.client.get("/api/stats").json
        self.assertEqual(stats["totalCompleted"], 1)
        self.assertEqual(stats["missingCompletionDate"], 1)
        self.assertEqual(self.client.get("/api/stats?start=2026-10-01&end=2026-10-31").json["totalCompleted"], 0)

    def test_invalid_csv_rolls_back_every_row(self):
        content = "起單時間,任務編號,病人姓名,床號,病歷號,Status\n2026/10/01 10:00,OLD-001,DEMO,TEST,DEMO,待預約\n2026/10/01 10:00,OLD-002,DEMO,TEST,DEMO,unknown\n"
        response = self.client.post("/api/import", data={"file": (io.BytesIO(content.encode()), "old.csv")}, headers=self.headers)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(len(self.client.get("/api/tasks").json["tasks"]), 0)

    def test_no_data_is_valid_json_and_csv(self):
        self.assertEqual(self.client.get("/api/tasks").json, {"tasks": []})
        self.assertEqual(self.client.get("/api/stats").json["operators"], [])
        self.assertEqual(len(list(csv.reader(io.StringIO(self.client.get("/api/export").data.decode("utf-8-sig"))))), 1)

    def test_demo_announcements_never_send_external_requests(self):
        self.create()
        with patch("app.urlrequest.build_opener") as external:
            result = self.client.post("/api/announce", json={}, headers=self.headers)
            self.assertTrue(result.json["simulated"])
            notices = self.client.get("/api/notifications").json["notifications"]
            self.assertTrue(all(n["status"] == "simulated" for n in notices))
            external.assert_not_called()

    def test_disabled_user_session_is_rejected(self):
        member, _ = self.login("demo-a")
        with closing(sqlite3.connect(self.path, isolation_level=None)) as db:
            db.execute("UPDATE users SET enabled=0 WHERE id='demo-a'")
        self.assertEqual(member.get("/api/tasks").status_code, 401)

    def test_member_rename_does_not_split_performer_volume(self):
        self.report(self.claim(self.create()).json["task"])
        changed = self.client.post("/api/users", json={"id": "demo-b", "name": "更名施打者乙",
                                  "role": "operator", "enabled": True}, headers=self.headers)
        self.assertEqual(changed.status_code, 200)
        self.report(self.claim(self.create()).json["task"])
        stats = self.client.get("/api/stats").json
        self.assertEqual(stats["totalCompleted"], 2)
        self.assertEqual(len(stats["operators"]), 1)
        self.assertEqual(stats["operators"][0]["operatorName"], "更名施打者乙")

    def test_edit_patient_does_not_change_performer_or_completion_date(self):
        completed = self.report(self.claim(self.create()).json["task"]).json["task"]
        edited = self.client.put(f"/api/tasks/{completed['id']}", json={
            "version": completed["version"], "patientName": "DEMO corrected", "bedNo": "NEW-TEST",
            "mrn": completed["mrn"], "remark": "DEMO edited"}, headers=self.headers)
        self.assertEqual(edited.status_code, 200)
        self.assertEqual(edited.json["task"]["operatorId"], completed["operatorId"])
        self.assertEqual(edited.json["task"]["completedAt"], completed["completedAt"])

    def test_demo_login_unavailable_outside_demo_and_line_token_invalid(self):
        self.app.config["DEMO_MODE"] = False
        self.assertEqual(self.app.test_client().post("/api/auth/demo", json={"userId": "demo-admin"}).status_code, 404)
        self.app.config["LINE_CHANNEL_ID"] = "123456"
        class FakeResponse:
            def __enter__(self):
                return io.StringIO(json.dumps({"aud": "different-channel", "iss": "https://access.line.me",
                                               "exp": 9999999999, "sub": "fake-member"}))
            def __exit__(self, *args):
                pass
        with patch("app.urlrequest.urlopen", return_value=FakeResponse()):
            self.assertEqual(self.app.test_client().post("/api/auth/line", json={"idToken": "test"}).status_code, 401)


if __name__ == "__main__":
    unittest.main()
