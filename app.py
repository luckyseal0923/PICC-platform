"""Independent PICC application. No connections to the old production system."""
from __future__ import annotations
import argparse
import csv
import hashlib
import hmac
import io
import json
import os
import re
from pathlib import Path
import secrets
import sqlite3
import sys
import time
import threading
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps
from urllib import request as urlrequest, parse as urlparse, error as urlerror
from runtime_settings import public_settings, public_env_file, connection_sources

ROOT = Path(__file__).resolve().parent
if (ROOT / ".vendor").exists():
    sys.path.insert(0, str(ROOT / ".vendor"))
from flask import Flask, g, jsonify, make_response, request, session, send_from_directory

TAIPEI = timezone(timedelta(hours=8))
STATUSES = {"pending": "新開案", "claimed": "待預約", "awaiting_report": "待施打回報", "completed": "完成", "cancelled": "已取消"}
DIFFICULTIES = ["非常簡單", "簡單", "中等", "困難", "非常困難"]
SITES = ["右上臂", "左上臂", "左下肢", "右下肢", "其他"]
VEINS = ["Basilic", "Cephalic", "Brachial"]
CATHETERS = ["雙腔PICC", "單腔PICC"]
CANCEL_REASONS = ["暫不需要施打", "醫囑調整", "病人因素", "等待時間過久", "其他"]
SHARED_ENTRY_ID = "00000000-0000-4000-8000-000000000001"
SHARED_ENTRY_NAME = "內部共用入口（未驗證操作者）"
SHARED_WORKSPACE_ID = "00000000-0000-4000-8000-000000000002"
SHARED_IDS = (SHARED_ENTRY_ID, SHARED_WORKSPACE_ID)


class ApiError(Exception):
    def __init__(self, message, status=400):
        self.message, self.status = message, status


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def text(value, limit=1000):
    return str(value or "").strip()[:limit]


def required(body, key, label, limit=100):
    value = text(body.get(key), limit)
    if not value:
        raise ApiError(f"請填寫{label}")
    return value


def create_app(config=None):
    app = Flask(__name__, static_folder=None)
    demo = os.environ.get("PICC_DEMO") == "1"
    app.config.update(
        DEMO_MODE=demo,
        SUPABASE_PUBLIC_URL=os.environ.get("SUPABASE_URL", os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")),
        SUPABASE_PUBLIC_KEY=os.environ.get("SUPABASE_ANON_KEY", os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY", "")),
        DATABASE=str(ROOT / os.environ.get("PICC_DATABASE", f"instance/picc{'-demo' if demo else ''}.sqlite3")),
        LIFF_ID=os.environ.get("PICC_LIFF_ID", ""),
        LINE_CHANNEL_ID=os.environ.get("LINE_LOGIN_CHANNEL_ID", ""),
        BOOTSTRAP_ADMIN=os.environ.get("PICC_BOOTSTRAP_ADMIN_LINE_ID", ""),
        NOTIFICATION_WEBHOOK=os.environ.get("PICC_NOTIFICATION_WEBHOOK", ""),
        NOTIFICATION_SECRET=os.environ.get("PICC_NOTIFICATION_SECRET", ""),
        NOTIFICATION_ALLOWED_HOSTS=os.environ.get("PICC_NOTIFICATION_ALLOWED_HOSTS", ""),
        SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE="Strict",
        SESSION_COOKIE_SECURE=not demo, PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        MAX_CONTENT_LENGTH=2 * 1024 * 1024,
    )
    if config:
        app.config.update(config)
    if not app.config["DEMO_MODE"] and not app.config.get("TESTING"):
        local_public = public_env_file(ROOT / ".env.local")
        app.config["SUPABASE_PUBLIC_URL"] = app.config["SUPABASE_PUBLIC_URL"] or local_public.get("SUPABASE_URL", local_public.get("NEXT_PUBLIC_SUPABASE_URL", ""))
        app.config["SUPABASE_PUBLIC_KEY"] = app.config["SUPABASE_PUBLIC_KEY"] or local_public.get("SUPABASE_ANON_KEY", local_public.get("NEXT_PUBLIC_SUPABASE_ANON_KEY", ""))
    db_path = Path(app.config["DATABASE"])
    db_path.parent.mkdir(parents=True, exist_ok=True)
    secret_file = db_path.parent / ".session-secret"
    if not app.config.get("SECRET_KEY"):
        if not secret_file.exists():
            secret_file.write_text(secrets.token_hex(32), encoding="utf-8")
        app.secret_key = secret_file.read_text(encoding="utf-8").strip()

    def db():
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DATABASE"], timeout=10, isolation_level=None)
            g.db.row_factory = sqlite3.Row
            g.db.execute("PRAGMA foreign_keys=ON")
        return g.db

    @app.teardown_appcontext
    def close_db(_):
        connection = g.pop("db", None)
        if connection:
            connection.close()

    with app.app_context():
        db().executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS users(
          id TEXT PRIMARY KEY, line_id TEXT UNIQUE, name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('admin','operator')),
          enabled INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS tasks(
          id TEXT PRIMARY KEY, task_id TEXT UNIQUE NOT NULL,
          patient_name TEXT NOT NULL, bed_no TEXT NOT NULL, mrn TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','claimed','awaiting_report','completed','cancelled')),
          created_at TEXT NOT NULL, created_by TEXT NOT NULL,
          claimed_id TEXT, claimed_by TEXT, claimed_at TEXT,
          operator_id TEXT, operator_name TEXT, completed_at TEXT,
          difficulty TEXT, insertion_site TEXT, vein TEXT,
          catheter_type TEXT, catheter_length REAL, remark TEXT DEFAULT '',
          cancel_reason TEXT, cancel_detail TEXT, cancelled_at TEXT,
          deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1,
          source TEXT DEFAULT 'new', reorder_of TEXT, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS task_status ON tasks(status,deleted_at);
        CREATE INDEX IF NOT EXISTS task_mrn ON tasks(mrn);
        CREATE INDEX IF NOT EXISTS task_completion ON tasks(completed_at,operator_id);
        CREATE TABLE IF NOT EXISTS case_counters(period TEXT PRIMARY KEY,last_value INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS events(
          id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT REFERENCES tasks(id),
          action TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
          occurred_at TEXT NOT NULL, detail TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS idempotency(
          user_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
          task_id TEXT NOT NULL REFERENCES tasks(id), PRIMARY KEY(user_id,request_id)
        );
        CREATE TABLE IF NOT EXISTS notifications(
          id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL,
          task_id TEXT REFERENCES tasks(id), created_at TEXT NOT NULL,
          actor_name TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER DEFAULT 0,
          payload TEXT NOT NULL, last_error TEXT
        );
        """)
        if "reorder_of" not in {r["name"] for r in db().execute("PRAGMA table_info(tasks)") }:
            db().execute("ALTER TABLE tasks ADD COLUMN reorder_of TEXT")
        task_schema = db().execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").fetchone()[0]
        if "awaiting_report" not in task_schema:
            backup_path = Path(str(db_path) + ".before-workflow-v3.sqlite3")
            if not backup_path.exists():
                backup = sqlite3.connect(backup_path)
                try:
                    db().backup(backup)
                finally:
                    backup.close()
            upgraded = re.sub(r"^CREATE TABLE\s+tasks\b", "CREATE TABLE tasks_status_upgrade", task_schema, count=1, flags=re.I)
            upgraded = re.sub(r"'claimed'\s*,\s*'completed'", "'claimed','awaiting_report','completed'", upgraded, count=1)
            if "awaiting_report" not in upgraded:
                raise RuntimeError("本機案件資料庫需要更新，原始備份已保留")
            indexes = [row[0] for row in db().execute("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='tasks' AND sql IS NOT NULL")]
            db().execute("PRAGMA foreign_keys=OFF")
            db().execute("BEGIN IMMEDIATE")
            try:
                db().execute(upgraded)
                db().execute("INSERT INTO tasks_status_upgrade SELECT * FROM tasks")
                db().execute("DROP TABLE tasks")
                db().execute("ALTER TABLE tasks_status_upgrade RENAME TO tasks")
                for index_sql in indexes:
                    db().execute(index_sql)
                if db().execute("PRAGMA foreign_key_check").fetchone():
                    raise RuntimeError("本機案件資料庫的關聯驗證未通過")
                db().execute("COMMIT")
            except Exception:
                db().execute("ROLLBACK")
                raise
            finally:
                db().execute("PRAGMA foreign_keys=ON")
        if app.config["DEMO_MODE"] and not db().execute("SELECT 1 FROM users").fetchone():
            db().executemany("INSERT INTO users(id,name,role) VALUES(?,?,?)", [
                ("demo-admin", "示範管理者", "admin"),
                ("demo-a", "示範施打者甲", "operator"),
                ("demo-b", "示範施打者乙", "operator"),
            ])
            seed_demo(db())
        if app.config["DEMO_MODE"]:
            db().execute("INSERT OR IGNORE INTO users(id,name,role) VALUES(?,?,'operator')",
                         (SHARED_ENTRY_ID, SHARED_ENTRY_NAME))
            db().execute("INSERT OR IGNORE INTO users(id,name,role) VALUES(?,?,'admin')",
                         (SHARED_WORKSPACE_ID, "內部共用工作站（未驗證操作者）"))

    def user():
        shared = request.path.startswith(("/api/entry/", "/api/workspace/")) and app.config["DEMO_MODE"]
        shared_id = SHARED_WORKSPACE_ID if request.path.startswith("/api/workspace/") else SHARED_ENTRY_ID
        row = db().execute("SELECT * FROM users WHERE id=? AND enabled=1",
                           (shared_id if shared else session.get("uid"),)).fetchone()
        if not row:
            if shared:
                raise ApiError("共用入口目前無法使用，請重新整理", 503)
            raise ApiError("請先登入", 401)
        return dict(row)

    def admin():
        u = user()
        if u["role"] != "admin":
            raise ApiError("此功能限管理者使用", 403)
        return u

    def body():
        value = request.get_json(silent=True)
        if not isinstance(value, dict):
            raise ApiError("請使用有效的 JSON 資料")
        return value

    @app.before_request
    def protect():
        if app.config["DEMO_MODE"] and (
            request.remote_addr not in ("127.0.0.1", "::1")
            or request.host.split(":")[0] not in ("localhost", "127.0.0.1", "[")
        ):
            raise ApiError("示範模式只允許本機使用", 403)
        shared = request.path.startswith(("/api/entry/", "/api/workspace/"))
        if shared and not app.config["DEMO_MODE"]:
            raise ApiError("系統尚未完成連線設定，請聯絡管理者或重新整理後再試。", 503)
        public = ("/api/config", "/api/health", "/api/auth/demo", "/api/auth/line", "/api/entry/config", "/api/workspace/config")
        if request.path.startswith("/api/") and request.path not in public:
            user()
            if request.method not in ("GET", "HEAD", "OPTIONS"):
                csrf_key = "workspace_csrf" if request.path.startswith("/api/workspace/") else "entry_csrf" if shared else "csrf"
                if not session.get(csrf_key) or not hmac.compare_digest(
                    request.headers.get("X-CSRF-Token", ""), session[csrf_key]
                ):
                    raise ApiError("請重新整理頁面後再試", 403)
        if request.method not in ("GET", "HEAD", "OPTIONS"):
            origin = request.headers.get("Origin")
            if origin and urlparse.urlparse(origin).netloc != request.host:
                raise ApiError("不允許跨網站操作", 403)

    @app.after_request
    def headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Frame-Options"] = "DENY"
        try:
            supabase_sources = " ".join(connection_sources(browser_settings()))
        except ValueError:
            supabase_sources = ""
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self' https://static.line-scdn.net; "
            "style-src 'self'; img-src 'self' data:; connect-src 'self' https://api.line.me "
            "https://access.line.me https://liff.line.me https://static.line-scdn.net " + supabase_sources + "; "
            "frame-src https://access.line.me https://liff.line.me; "
            "base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
        )
        if request.path.startswith("/api/") or response.mimetype == "text/html":
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.errorhandler(ApiError)
    def api_error(error):
        return jsonify(ok=False, error=error.message), error.status

    @app.errorhandler(413)
    def too_large(_):
        return jsonify(ok=False, error="檔案超過 2 MB"), 413

    @app.errorhandler(500)
    def server_error(_):
        return jsonify(ok=False, error="操作未完成，請稍後再試"), 500

    @app.get("/")
    def index():
        return send_from_directory(ROOT / "static", "landing.html")

    def browser_settings():
        return public_settings((ROOT / "static/config.js").read_text(encoding="utf-8"),
                               app.config["SUPABASE_PUBLIC_URL"], app.config["SUPABASE_PUBLIC_KEY"])

    @app.get("/assets/config.js")
    def runtime_browser_config():
        try:
            settings = browser_settings()
        except ValueError:
            settings = {"setupError": "系統連線設定不正確，請聯絡管理者。"}
        response = make_response("window.PICC_CONFIG = " + json.dumps(settings, ensure_ascii=True) + ";\n")
        response.mimetype = "application/javascript"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/workspace")
    @app.get("/workspace/")
    def workspace():
        return send_from_directory(ROOT / "static", "index.html")

    @app.get("/picc-create")
    @app.get("/picc-create/")
    @app.get("/picc-booking")
    @app.get("/picc-booking/")
    @app.get("/picc-report")
    @app.get("/picc-report/")
    def mobile_entry():
        return send_from_directory(ROOT / "static", "entry.html")

    @app.get("/assets/<path:name>")
    def assets(name):
        return send_from_directory(ROOT / "static", name)

    @app.get("/api/health")
    def health():
        return jsonify(ok=True)

    @app.get("/api/config")
    def config_endpoint():
        return jsonify(appName="picc-v2", backend="demo", notificationsEnabled=False, demo=app.config["DEMO_MODE"], liffId=app.config["LIFF_ID"],
                       lineReady=bool(app.config["LIFF_ID"] and app.config["LINE_CHANNEL_ID"]),
                       cancelReasons=CANCEL_REASONS, difficulties=DIFFICULTIES,
                       sites=SITES, veins=VEINS, catheters=CATHETERS)

    @app.get("/api/entry/config")
    def entry_config():
        # Anti-forgery cookie only: no personal identity or login is required.
        session.setdefault("entry_csrf", secrets.token_urlsafe(32))
        u = user()
        return jsonify(appName="picc-v2", backend="demo", demo=True, loginRequired=False,
                       accessMode="shared", notificationsEnabled=False,
                       user={"id": u["id"], "name": u["name"], "role": "shared", "verified": False},
                       csrf=session["entry_csrf"], cancelReasons=CANCEL_REASONS,
                       difficulties=DIFFICULTIES, sites=SITES, veins=VEINS, catheters=CATHETERS)

    @app.get("/api/workspace/config")
    def workspace_config():
        session.setdefault("workspace_csrf", secrets.token_urlsafe(32))
        u = user()
        return jsonify(appName="picc-v2", backend="demo", demo=True, loginRequired=False,
                       sharedWorkspace=True, notificationsEnabled=False,
                       user={"id": u["id"], "name": u["name"], "role": "admin", "verified": False},
                       csrf=session["workspace_csrf"], cancelReasons=CANCEL_REASONS,
                       difficulties=DIFFICULTIES, sites=SITES, veins=VEINS, catheters=CATHETERS)

    def sign_in(u):
        session.clear()
        session["uid"], session["csrf"] = u["id"], secrets.token_urlsafe(32)
        session.permanent = True
        return jsonify(ok=True, user={k: u[k] for k in ("id", "name", "role")}, csrf=session["csrf"])

    @app.post("/api/auth/demo")
    def demo_login():
        if not app.config["DEMO_MODE"]:
            raise ApiError("示範登入已停用", 404)
        u = db().execute("SELECT * FROM users WHERE id=? AND enabled=1", (body().get("userId"),)).fetchone()
        if not u or not u["id"].startswith("demo-"):
            raise ApiError("請選擇示範身分")
        return sign_in(dict(u))

    @app.post("/api/auth/line")
    def line_login():
        channel = app.config["LINE_CHANNEL_ID"]
        if not channel:
            raise ApiError("LINE 登入尚未設定", 503)
        token = required(body(), "idToken", "LINE 登入資訊", 10000)
        data = urlparse.urlencode({"id_token": token, "client_id": channel}).encode()
        try:
            req = urlrequest.Request("https://api.line.me/oauth2/v2.1/verify", data=data,
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
            with urlrequest.urlopen(req, timeout=10) as response:
                profile = json.load(response)
        except (urlerror.URLError, ValueError):
            raise ApiError("LINE 登入驗證失敗，請重新登入", 401)
        if (str(profile.get("aud")) != channel or profile.get("iss") != "https://access.line.me"
                or profile.get("exp", 0) <= time.time() or not profile.get("sub")):
            raise ApiError("LINE 登入資訊無效", 401)
        line_id = profile["sub"]
        u = db().execute("SELECT * FROM users WHERE line_id=? AND enabled=1", (line_id,)).fetchone()
        if not u and line_id == app.config["BOOTSTRAP_ADMIN"]:
            db().execute("INSERT OR IGNORE INTO users(id,line_id,name,role) VALUES(?,?,?,'admin')",
                         (str(uuid.uuid4()), line_id, text(profile.get("name")) or "管理者"))
            u = db().execute("SELECT * FROM users WHERE line_id=? AND enabled=1", (line_id,)).fetchone()
        if not u:
            raise ApiError("此 LINE 帳號尚未獲得 PICC 團隊使用權限，請聯絡管理者", 403)
        return sign_in(dict(u))

    @app.get("/api/me")
    def me():
        u = user()
        return jsonify(user={k: u[k] for k in ("id", "name", "role")}, csrf=session["csrf"])

    @app.post("/api/auth/logout")
    def logout():
        session.clear()
        return jsonify(ok=True)

    def audit(task_id, action, u, detail):
        db().execute("INSERT INTO events(task_id,action,actor_id,actor_name,occurred_at,detail) VALUES(?,?,?,?,?,?)",
                     (task_id, action, u["id"], u["name"], now(), json.dumps(detail, ensure_ascii=False)))

    def notification(event, task, u):
        payload = {"event": event, "task": task, "actorName": u["name"], "occurredAt": now()}
        db().execute("INSERT INTO notifications(event,task_id,created_at,actor_name,status,payload) VALUES(?,?,?,?,?,?)",
                     (event, task.get("id"), now(), u["name"],
                      "simulated" if app.config["DEMO_MODE"] else "queued",
                      json.dumps(payload, ensure_ascii=False)))

    def task_row(task_id):
        row = db().execute("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL", (task_id,)).fetchone()
        if not row:
            raise ApiError("找不到此案件", 404)
        return row

    def task_json(row):
        mapping = {"task_id": "taskId", "patient_name": "patientName", "bed_no": "bedNo",
                   "created_at": "createdAt", "created_by": "createdBy", "claimed_id": "claimedId",
                   "claimed_by": "claimedBy", "claimed_at": "claimedAt", "operator_id": "operatorId",
                   "operator_name": "operatorName", "completed_at": "completedAt", "insertion_site": "insertionSite",
                   "catheter_type": "catheterType", "catheter_length": "catheterLength",
                   "cancel_reason": "cancelReason", "cancel_detail": "cancelDetail", "cancelled_at": "cancelledAt",
                   "updated_at": "updatedAt", "deleted_at": "deletedAt", "reorder_of": "reorderOf"}
        result = {mapping.get(k, k): row[k] for k in row.keys()}
        result["statusLabel"] = STATUSES[row["status"]]
        for id_key, name_key in (("claimed_id","claimedBy"),("operator_id","operatorName")):
            member = db().execute("SELECT name FROM users WHERE id=?", (row[id_key],)).fetchone() if row[id_key] else None
            if member:
                result[name_key] = member[0]
        result["hasDifficultHistory"] = bool(db().execute(
            "SELECT 1 FROM tasks WHERE TRIM(mrn)=TRIM(?) AND status='completed' "
            "AND difficulty IN ('困難','非常困難') AND deleted_at IS NULL LIMIT 1", (row["mrn"],)).fetchone())
        return result

    def operator(body_data):
        row = db().execute("SELECT * FROM users WHERE id=? AND id NOT IN (?,?) AND enabled=1",
                           (body_data.get("operatorId"), *SHARED_IDS)).fetchone()
        if not row:
            raise ApiError("請選擇有效的施打者")
        return row

    def report_values(data):
        op = operator(data)
        choices = [("difficulty", DIFFICULTIES, "放置困難度"), ("insertionSite", SITES, "施打位置"),
                   ("vein", VEINS, "血管"), ("catheterType", CATHETERS, "管路類型")]
        for key, options, label in choices:
            if data.get(key) not in options:
                raise ApiError(f"請選擇{label}")
        length = data.get("catheterLength")
        if length not in (None, ""):
            try:
                length = float(length)
                if not 0 < length < float("inf"):
                    raise ValueError()
            except (ValueError, TypeError):
                raise ApiError("管路長度須為正數")
        else:
            length = None
        return [op["id"], op["name"], now(), data["difficulty"], data["insertionSite"],
                data["vein"], data["catheterType"], length, text(data.get("remark"))]

    def checked_version(data, row):
        if data.get("version") != row["version"]:
            raise ApiError("案件已被其他人更新，請重新整理後再操作", 409)

    def transaction(fn):
        @wraps(fn)
        def wrapped(*args, **kwargs):
            db().execute("BEGIN IMMEDIATE")
            try:
                result = fn(*args, **kwargs)
                db().execute("COMMIT")
                return result
            except Exception:
                db().execute("ROLLBACK")
                raise
        return wrapped

    @app.get("/api/tasks")
    @app.get("/api/entry/tasks")
    def tasks():
        if request.path.startswith("/api/entry/") and request.args.get("status") not in ("pending", "claimed", "awaiting_report"):
            raise ApiError("請指定新開案或待預約清單", 400)
        clauses, values = ["deleted_at IS NULL"], []
        if request.args.get("status") in STATUSES:
            clauses.append("status=?"); values.append(request.args["status"])
        if request.args.get("mine") == "1":
            clauses.append("(claimed_id=? OR operator_id=?)")
            values.extend([user()["id"], user()["id"]])
        if request.args.get("q"):
            clauses.append("(patient_name LIKE ? OR mrn LIKE ? OR bed_no LIKE ? OR task_id LIKE ?)")
            values.extend(["%" + text(request.args["q"], 100) + "%"] * 4)
        for key, op in (("start", ">="), ("end", "<=")):
            if request.args.get(key):
                date = valid_date(request.args[key])
                clauses.append(f"date(created_at,'+8 hours') {op} ?"); values.append(date)
        rows = db().execute("SELECT * FROM tasks WHERE " + " AND ".join(clauses)
                            + " ORDER BY created_at DESC", values).fetchall()
        return jsonify(tasks=[task_json(row) for row in rows])

    @app.get("/api/tasks/<task_id>")
    @app.get("/api/entry/tasks/<task_id>")
    def detail(task_id):
        events = db().execute("SELECT action,actor_name,occurred_at,detail FROM events WHERE task_id=? ORDER BY id DESC",
                              (task_id,)).fetchall()
        return jsonify(task=task_json(task_row(task_id)), events=[
            {"action": e["action"], "actorName": e["actor_name"], "occurredAt": e["occurred_at"],
             "detail": json.loads(e["detail"])} for e in events])

    def next_case_number(timestamp):
        period = datetime.fromisoformat(timestamp).astimezone(TAIPEI).strftime("%y%m")
        prefix = "PICC-" + period + "-"
        numbers = [int(row[0][len(prefix):]) for row in db().execute("SELECT task_id FROM tasks WHERE task_id LIKE ?", (prefix+"%",))
                   if re.fullmatch(re.escape(prefix)+r"[0-9]{3,}", row[0])]
        counter = db().execute("SELECT last_value FROM case_counters WHERE period=?", (period,)).fetchone()
        value = max(max(numbers, default=0), counter[0] if counter else 0) + 1
        db().execute("INSERT INTO case_counters(period,last_value) VALUES(?,?) ON CONFLICT(period) DO UPDATE SET last_value=excluded.last_value", (period,value))
        return prefix + str(value).zfill(3)

    @app.post("/api/tasks")
    @app.post("/api/entry/tasks")
    @transaction
    def create_task():
        u, data = user(), body()
        name = required(data, "patientName", "病人姓名")
        bed = required(data, "bedNo", "床號")
        mrn = required(data, "mrn", "病歷號")
        request_id = required(data, "requestId", "送出識別碼", 100)
        signature = hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        old = db().execute("SELECT * FROM idempotency WHERE user_id=? AND request_id=?", (u["id"], request_id)).fetchone()
        if old:
            if old["payload_hash"] != signature:
                raise ApiError("送出識別碼已使用，請重新開啟表單", 409)
            return jsonify(ok=True, duplicate=True, task=task_json(task_row(old["task_id"])))
        recent = db().execute("SELECT COUNT(*) FROM tasks WHERE TRIM(mrn)=? AND deleted_at IS NULL "
                              "AND julianday(created_at)>=julianday('now','-7 days') AND julianday(created_at)<=julianday('now')", (mrn,)).fetchone()[0]
        if recent and data.get("duplicateAcknowledged") is not True:
            return jsonify(ok=False, requiresDuplicateConfirmation=True, duplicateCount=recent,
                           error="七日內已有相同病歷號案件，請確認是否重複開單。")
        is_self = data.get("selfReport") is True
        original_id = text(data.get("copiedFromTaskId"))
        if original_id:
            original = task_row(original_id)
            if original["status"] != "cancelled":
                raise ApiError("只有已取消案件可重新起單", 409)
            if is_self:
                raise ApiError("重新起單請先建立新開案案件")
        report = report_values(data) if is_self else None
        task_id = str(uuid.uuid4())
        timestamp = now()
        task_number = next_case_number(timestamp)
        db().execute("INSERT INTO tasks(id,task_id,patient_name,bed_no,mrn,status,created_at,created_by,updated_at,remark)"
                     " VALUES(?,?,?,?,?,?,?,?,?,?)",
                     (task_id, task_number, name, bed, mrn, "completed" if is_self else "pending",
                      timestamp, u["id"], timestamp, text(data.get("remark"))))
        if report:
            db().execute("UPDATE tasks SET operator_id=?,operator_name=?,completed_at=?,difficulty=?,insertion_site=?,"
                         "vein=?,catheter_type=?,catheter_length=?,remark=?,claimed_id=?,claimed_by=?,claimed_at=? WHERE id=?",
                         report + [report[0], report[1], timestamp, task_id])
        db().execute("INSERT INTO idempotency VALUES(?,?,?,?)", (u["id"], request_id, signature, task_id))
        if original_id:
            db().execute("UPDATE tasks SET source='reorder',reorder_of=? WHERE id=?", (original_id, task_id))
        task = task_json(task_row(task_id))
        audit(task_id, "reordered_created" if original_id else ("self_completed" if is_self else "created"),
              u, {"task": task, "originalTaskId": original_id})
        if original_id:
            audit(original_id, "reordered", u, {"newTaskId": task_id, "newTaskNumber": task_number})
        notification("self_completed" if is_self else "created", task, u)
        return jsonify(ok=True, task=task), 201

    @app.post("/api/tasks/<task_id>/claim")
    @app.post("/api/entry/tasks/<task_id>/claim")
    @transaction
    def claim(task_id):
        u, data, row = user(), body(), task_row(task_id)
        checked_version(data, row)
        if row["status"] != "pending":
            raise ApiError("此案件已被預約或已結案", 409)
        op = operator(data)
        count = db().execute("UPDATE tasks SET status='claimed',claimed_id=?,claimed_by=?,claimed_at=?,updated_at=?,"
                            "version=version+1 WHERE id=? AND status='pending' AND version=?",
                            (op["id"], op["name"], now(), now(), task_id, row["version"])).rowcount
        if count != 1:
            raise ApiError("此案件已被其他人預約", 409)
        task = task_json(task_row(task_id))
        audit(task_id, "claimed", u, {"operatorName": op["name"]})
        notification("claimed", task, u)
        return jsonify(ok=True, task=task)

    @app.post("/api/tasks/<task_id>/performed")
    @app.post("/api/entry/tasks/<task_id>/performed")
    @transaction
    def performed(task_id):
        u, data, row = user(), body(), task_row(task_id)
        checked_version(data, row)
        if row["status"] != "claimed":
            raise ApiError("只有待預約案件可以標記待施打回報", 409)
        db().execute("UPDATE tasks SET status='awaiting_report',updated_at=?,version=version+1 WHERE id=?", (now(), task_id))
        audit(task_id, "awaiting_report", u, {"previousStatus": "claimed"})
        return jsonify(ok=True, task=task_json(task_row(task_id)))

    @app.post("/api/tasks/<task_id>/complete")
    @app.post("/api/entry/tasks/<task_id>/complete")
    @transaction
    def complete(task_id):
        u, data, row = user(), body(), task_row(task_id)
        checked_version(data, row)
        if row["status"] not in ("claimed", "awaiting_report"):
            raise ApiError("只有待預約或待施打回報案件可以回報完成", 409)
        report = report_values(data)
        db().execute("UPDATE tasks SET status='completed',operator_id=?,operator_name=?,completed_at=?,difficulty=?,"
                     "insertion_site=?,vein=?,catheter_type=?,catheter_length=?,remark=?,updated_at=?,"
                     "version=version+1 WHERE id=?", report + [now(), task_id])
        task = task_json(task_row(task_id))
        audit(task_id, "completed", u, {"operatorName": report[1], "report": task})
        notification("completed", task, u)
        return jsonify(ok=True, task=task)

    @app.post("/api/tasks/<task_id>/cancel")
    @app.post("/api/entry/tasks/<task_id>/cancel")
    @transaction
    def cancel(task_id):
        u, data, row = user(), body(), task_row(task_id)
        checked_version(data, row)
        if row["status"] not in ("pending", "claimed"):
            raise ApiError("只有新開案或待預約案件可以取消", 409)
        reason = data.get("reason")
        detail_text = text(data.get("detail"))
        if reason not in CANCEL_REASONS or (reason == "其他" and not detail_text):
            raise ApiError("請選擇取消原因；選其他時請補充說明")
        db().execute("UPDATE tasks SET status='cancelled',cancel_reason=?,cancel_detail=?,cancelled_at=?,"
                     "updated_at=?,version=version+1 WHERE id=?", (reason, detail_text, now(), now(), task_id))
        task = task_json(task_row(task_id))
        audit(task_id, "cancelled", u, {"reason": reason, "detail": detail_text, "previousStatus": row["status"]})
        notification("cancelled", task, u)
        return jsonify(ok=True, task=task)

    @app.put("/api/tasks/<task_id>")
    @transaction
    def edit_task(task_id):
        u, data, row = admin(), body(), task_row(task_id)
        checked_version(data, row)
        db().execute("UPDATE tasks SET patient_name=?,bed_no=?,mrn=?,remark=?,updated_at=?,version=version+1 WHERE id=?",
                     (required(data, "patientName", "病人姓名"), required(data, "bedNo", "床號"),
                      required(data, "mrn", "病歷號"), text(data.get("remark")), now(), task_id))
        if row["status"] == "claimed" and data.get("claimedId"):
            assigned = operator({"operatorId": data["claimedId"]})
            db().execute("UPDATE tasks SET claimed_id=?,claimed_by=? WHERE id=?",
                         (assigned["id"], assigned["name"], task_id))
        if row["status"] == "completed" and data.get("editReport") is True:
            report = report_values(data)
            # Correcting a report does not change the original completion time.
            report[2] = parse_legacy_date(data.get("completedAt")) if data.get("completedAt") else row["completed_at"]
            db().execute("UPDATE tasks SET operator_id=?,operator_name=?,completed_at=?,difficulty=?,insertion_site=?,"
                         "vein=?,catheter_type=?,catheter_length=?,remark=? WHERE id=?", report + [task_id])
        audit(task_id, "edited", u, {"before": task_json(row), "after": task_json(task_row(task_id))})
        return jsonify(ok=True, task=task_json(task_row(task_id)))

    @app.delete("/api/tasks/<task_id>")
    @transaction
    def delete_task(task_id):
        u, data, row = admin(), body(), task_row(task_id)
        checked_version(data, row)
        reason = required(data, "reason", "移除原因", 1000)
        db().execute("UPDATE tasks SET deleted_at=?,updated_at=?,version=version+1 WHERE id=?", (now(), now(), task_id))
        audit(task_id, "removed", u, {"reason": reason, "task": task_json(row)})
        return jsonify(ok=True)

    @app.get("/api/users")
    @app.get("/api/entry/users")
    def users():
        u = user()
        rows = db().execute("SELECT * FROM users WHERE id NOT IN (?,?) ORDER BY role,name", SHARED_IDS).fetchall()
        return jsonify(users=[{k: row[k] for k in
                               (("id", "name", "role", "enabled", "line_id") if u["role"] == "admin"
                                else ("id", "name", "role", "enabled"))} for row in rows])

    @app.post("/api/users")
    @transaction
    def save_user():
        u, data = admin(), body()
        name = required(data, "name", "姓名")
        role = data.get("role")
        if role not in ("operator", "admin"):
            raise ApiError("請選擇有效角色")
        enabled = 1 if data.get("enabled", True) else 0
        line_id = text(data.get("lineId"), 100)
        uid = text(data.get("id")) or str(uuid.uuid4())
        if uid in SHARED_IDS:
            raise ApiError("共用入口不是施打成員，無需編輯")
        previous = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if request.path.startswith("/api/workspace/"):
            role = previous["role"] if previous else "operator"
            line_id = previous["line_id"] if previous else None
        elif "lineId" not in data and previous:
            line_id = previous["line_id"]
        if uid == u["id"] and (not enabled or role != "admin"):
            raise ApiError("不能停用或移除自己的管理者權限")
        if not app.config["DEMO_MODE"] and not line_id:
            raise ApiError("請填寫此成員的 LINE 使用者 ID")
        try:
            db().execute("INSERT INTO users(id,line_id,name,role,enabled) VALUES(?,?,?,?,?) ON CONFLICT(id) "
                         "DO UPDATE SET line_id=excluded.line_id,name=excluded.name,role=excluded.role,enabled=excluded.enabled",
                         (uid, line_id or None, name, role, enabled))
        except sqlite3.IntegrityError:
            raise ApiError("此 LINE 帳號已存在")
        audit(None, "member_updated", u, {"memberId": uid, "name": name, "role": role, "enabled": enabled})
        return jsonify(ok=True)

    @app.get("/api/stats")
    def stats():
        u = user()
        clauses, values = ["status='completed'", "deleted_at IS NULL"], []
        if u["role"] != "admin" or request.args.get("scope") == "mine":
            clauses.append("operator_id=?"); values.append(u["id"])
        for key, op in (("start", ">="), ("end", "<=")):
            if request.args.get(key):
                clauses.append(f"date(completed_at,'+8 hours') {op} ?")
                values.append(valid_date(request.args[key]))
        where = " AND ".join(clauses)
        operators = db().execute(
            "SELECT COALESCE(operator_id,'legacy:'||COALESCE(operator_name,'')) AS operatorId,"
            "COALESCE(u.name,operator_name,'未記錄施打者') AS operatorName,COUNT(*) AS count,"
            "SUM(CASE WHEN difficulty IN ('困難','非常困難') THEN 1 ELSE 0 END) AS difficultCount "
            "FROM tasks LEFT JOIN users u ON u.id=tasks.operator_id WHERE " + where
            + " GROUP BY operatorId,operatorName ORDER BY count DESC", values).fetchall()
        months = db().execute(
            "SELECT strftime('%Y-%m',completed_at,'+8 hours') AS month,COUNT(*) AS count FROM tasks WHERE "
            + where + " AND completed_at IS NOT NULL GROUP BY month ORDER BY month", values).fetchall()
        created = db().execute("SELECT strftime('%Y-%m',created_at,'+8 hours') AS month,COUNT(*) AS count "
                               "FROM tasks WHERE deleted_at IS NULL GROUP BY month ORDER BY month").fetchall()
        counts = dict(db().execute("SELECT status,COUNT(*) FROM tasks WHERE deleted_at IS NULL GROUP BY status").fetchall())
        missing_clause = " AND operator_id=?" if u["role"] != "admin" or request.args.get("scope") == "mine" else ""
        missing = db().execute("SELECT COUNT(*) FROM tasks WHERE status='completed' AND completed_at IS NULL "
                                "AND deleted_at IS NULL" + missing_clause,
                                [u["id"]] if missing_clause else []).fetchone()[0]
        return jsonify(operators=[dict(x) for x in operators], months=[dict(x) for x in months],
                       createdMonths=[dict(x) for x in created], counts=counts,
                       totalCompleted=sum(x["count"] for x in operators), missingCompletionDate=missing,
                       basis="實際施打者／完成日期（Asia/Taipei）；取消及移除案件不計入")

    @app.get("/api/export")
    def export():
        admin()
        clauses, values = ["deleted_at IS NULL"], []
        for key, op in (("start", ">="), ("end", "<=")):
            if request.args.get(key):
                clauses.append(f"date(created_at,'+8 hours') {op} ?"); values.append(valid_date(request.args[key]))
        rows = db().execute("SELECT * FROM tasks WHERE " + " AND ".join(clauses) + " ORDER BY created_at DESC", values).fetchall()
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["起單時間", "任務編號", "病人姓名", "床號", "病歷號", "Status", "接單者", "施打者",
                         "管路種類", "管路長度(cm)", "部位", "血管", "困難度", "備註", "完成時間", "取消時間", "取消原因", "取消說明", "狀態代碼"])
        keys = ["created_at", "task_id", "patient_name", "bed_no", "mrn", "status", "claimed_by", "operator_name",
                "catheter_type", "catheter_length", "insertion_site", "vein", "difficulty", "remark",
                "completed_at", "cancelled_at", "cancel_reason", "cancel_detail"]
        for row in rows:
            current = task_json(row)
            writer.writerow([csv_safe(STATUSES[row[k]] if k == "status" else current["claimedBy"] if k == "claimed_by" else current["operatorName"] if k == "operator_name" else row[k]) for k in keys] + [row["status"]])
        return app.response_class("\ufeff" + output.getvalue(), mimetype="text/csv",
                                  headers={"Content-Disposition": 'attachment; filename="PICC-tasks.csv"'})

    @app.post("/api/import")
    @transaction
    def import_csv():
        u = admin()
        file = request.files.get("file")
        if not file:
            raise ApiError("請選擇 CSV 檔案")
        try:
            content = file.read().decode("utf-8-sig")
            rows = list(csv.DictReader(io.StringIO(content)))
        except (UnicodeError, csv.Error):
            raise ApiError("請使用 UTF-8 編碼的 CSV")
        if len(rows) > 10000:
            raise ApiError("每次最多匯入 10,000 筆")
        added, skipped, missing = 0, 0, 0
        for number, raw in enumerate(rows, 2):
            number_id = text(raw.get("任務編號"))
            if not number_id:
                raise ApiError(f"第 {number} 列缺少任務編號")
            if db().execute("SELECT 1 FROM tasks WHERE task_id=?", (number_id,)).fetchone():
                skipped += 1; continue
            status = text(raw.get("狀態代碼"))
            if not status:
                status = {"待預約":"pending", "待施打":"claimed", "待回報":"awaiting_report", "新開案":"pending", "施打回報":"awaiting_report", "待施打回報":"awaiting_report", "完成":"completed", "已取消":"cancelled"}.get(raw.get("Status"))
            if status not in STATUSES:
                status = None
            if not status:
                raise ApiError(f"第 {number} 列狀態無法辨識")
            name, bed, mrn = (text(raw.get(k)) for k in ("病人姓名", "床號", "病歷號"))
            if not all((name, bed, mrn)):
                raise ApiError(f"第 {number} 列缺少病人基本資料")
            created = parse_legacy_date(raw.get("起單時間")) or now()
            completed = parse_legacy_date(raw.get("完成時間"))
            if status == "completed" and not completed:
                missing += 1
            op_name = text(raw.get("施打者"))
            op_rows = db().execute("SELECT id FROM users WHERE name=? AND id NOT IN (?,?)", (op_name, *SHARED_IDS)).fetchall()
            op_id = op_rows[0]["id"] if len(op_rows) == 1 else None
            try:
                length = float(raw["管路長度(cm)"]) if raw.get("管路長度(cm)") else None
            except ValueError:
                raise ApiError(f"第 {number} 列管路長度格式不正確")
            task_id = str(uuid.uuid4())
            db().execute("INSERT INTO tasks(id,task_id,patient_name,bed_no,mrn,status,created_at,created_by,"
                         "claimed_by,operator_id,operator_name,completed_at,difficulty,insertion_site,vein,"
                         "catheter_type,catheter_length,remark,cancel_reason,cancel_detail,cancelled_at,source,updated_at)"
                         " VALUES(" + ",".join(["?"] * 23) + ")",
                         (task_id, number_id, name, bed, mrn, status, created, u["id"],
                          text(raw.get("接單者")), op_id, op_name, completed, text(raw.get("困難度")),
                          text(raw.get("部位")), text(raw.get("血管")), text(raw.get("管路種類")),
                          length, text(raw.get("備註")), text(raw.get("取消原因")), text(raw.get("取消說明")),
                          parse_legacy_date(raw.get("取消時間")), "legacy-import", now()))
            audit(task_id, "imported", u, {"taskId": number_id, "missingCompletionDate": status == "completed" and not completed})
            added += 1
        return jsonify(ok=True, added=added, skipped=skipped, missingCompletionDate=missing)

    @app.get("/api/notifications")
    def notifications():
        admin()
        rows = db().execute("SELECT id,event,created_at,actor_name,status,attempts,last_error FROM notifications "
                            "ORDER BY id DESC LIMIT 100").fetchall()
        return jsonify(notifications=[dict(x) for x in rows])

    @app.post("/api/announce")
    @transaction
    def announce():
        u = admin()
        rows = db().execute("SELECT * FROM tasks WHERE status='claimed' AND deleted_at IS NULL ORDER BY created_at").fetchall()
        payload = {"event": "announce_pending", "tasks": [task_json(row) for row in rows], "occurredAt": now()}
        db().execute("INSERT INTO notifications(event,created_at,actor_name,status,payload) VALUES(?,?,?,?,?)",
                     ("announce_pending", now(), u["name"],
                      "simulated" if app.config["DEMO_MODE"] else "queued", json.dumps(payload, ensure_ascii=False)))
        audit(None, "announcement_requested", u, {"count": len(rows)})
        return jsonify(ok=True, count=len(rows), simulated=app.config["DEMO_MODE"])

    def deliver_notification(notice_id):
        row = db().execute("SELECT * FROM notifications WHERE id=?", (notice_id,)).fetchone()
        if not row:
            raise ApiError("找不到通知", 404)
        if app.config["DEMO_MODE"]:
            return jsonify(ok=True, simulated=True)
        if row["status"] == "sent":
            return jsonify(ok=True, alreadySent=True)
        url = app.config["NOTIFICATION_WEBHOOK"]
        host = urlparse.urlparse(url)
        allowed = {x.strip() for x in app.config["NOTIFICATION_ALLOWED_HOSTS"].split(",") if x.strip()}
        if (host.scheme != "https" or host.hostname not in allowed or not app.config["NOTIFICATION_SECRET"]):
            raise ApiError("請先設定新版通知流程與允許的主機", 503)
        if db().execute("UPDATE notifications SET status='sending' WHERE id=? AND status IN ('queued','failed')",
                        (notice_id,)).rowcount != 1:
            raise ApiError("此通知正在發送，請稍後重新整理", 409)
        # The configured service must not redirect credential-bearing requests.
        class NoRedirect(urlrequest.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None
        try:
            payload = json.loads(row["payload"])
            payload["eventKey"] = str(uuid.uuid5(uuid.NAMESPACE_URL, str(db_path.resolve()) + ":" + str(notice_id)))
            req = urlrequest.Request(url, data=json.dumps(payload, ensure_ascii=False).encode(),
                                     headers={"Content-Type": "application/json",
                                              "Authorization": "Bearer " + app.config["NOTIFICATION_SECRET"]})
            with urlrequest.build_opener(NoRedirect).open(req, timeout=10) as response:
                if response.status < 200 or response.status >= 300:
                    raise ValueError()
            state, error = "sent", None
        except (urlerror.URLError, ValueError):
            state, error = "failed", "通知服務未確認送出，請稍後重試"
        db().execute("UPDATE notifications SET status=?,last_error=?,attempts=attempts+1 WHERE id=?",
                     (state, error, notice_id))
        if state == "failed":
            raise ApiError(error, 502)
        return jsonify(ok=True)

    @app.post("/api/notifications/<int:notice_id>/retry")
    def retry_notification(notice_id):
        admin()
        return deliver_notification(notice_id)

    def notification_worker():
        while True:
            with app.app_context():
                rows = db().execute("SELECT id FROM notifications WHERE status IN ('queued','failed') "
                                    "AND attempts<3 ORDER BY id LIMIT 10").fetchall()
                for row in rows:
                    try:
                        deliver_notification(row["id"])
                    except ApiError:
                        pass
            time.sleep(15)
    workspace_views = {"tasks", "detail", "create_task", "claim", "performed", "complete", "cancel",
                       "edit_task", "delete_task", "users", "save_user", "stats", "export",
                       "import_csv", "notifications"}
    for rule in list(app.url_map.iter_rules()):
        if rule.rule.startswith("/api/") and not rule.rule.startswith("/api/entry/") and rule.endpoint in workspace_views:
            app.add_url_rule("/api/workspace/" + rule.rule[len("/api/"):],
                             endpoint="workspace_" + rule.endpoint, view_func=app.view_functions[rule.endpoint],
                             methods=sorted(rule.methods - {"HEAD", "OPTIONS"}))
    app.notification_worker = notification_worker
    return app


def valid_date(value):
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        raise ApiError("日期格式不正確")


def parse_legacy_date(value):
    value = text(value)
    if not value:
        return None
    try:
        result = datetime.fromisoformat(value.replace("/", "-").replace("Z", "+00:00"))
        if result.tzinfo is None:
            result = result.replace(tzinfo=TAIPEI)
        return result.astimezone(timezone.utc).isoformat(timespec="seconds")
    except ValueError:
        raise ApiError("舊資料日期格式不正確，請修正後再匯入")


def csv_safe(value):
    value = str(value if value is not None else "")
    if value and value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")):
        value = "'" + value
    return value


def seed_demo(db):
    timestamp = datetime.now(timezone.utc)
    examples = [
        ("示範個案 A", "測試01", "DEMO001", "pending", None, None, 28),
        ("示範個案 B", "測試02", "DEMO002", "pending", None, None, 5),
        ("示範個案 C", "測試03", "DEMO003", "claimed", "demo-a", "示範施打者甲", 19),
        ("示範個案 D", "測試04", "DEMO004", "claimed", "demo-b", "示範施打者乙", 8),
        ("示範個案 E", "測試05", "DEMO005", "cancelled", None, None, 40),
        ("示範歷史 A", "測試11", "DEMO001", "completed", "demo-a", "示範施打者甲", 70),
        ("示範歷史 B", "測試12", "DEMO012", "completed", "demo-b", "示範施打者乙", 90),
        ("示範歷史 C", "測試13", "DEMO013", "completed", "demo-a", "示範施打者甲", 170),
    ]
    for i, (name, bed, mrn, status, oid, oname, hours) in enumerate(examples):
        created = (timestamp - timedelta(hours=hours)).isoformat(timespec="seconds")
        uid = "demo-task-" + str(i + 1)
        db.execute("INSERT INTO tasks(id,task_id,patient_name,bed_no,mrn,status,created_at,created_by,"
                   "claimed_id,claimed_by,claimed_at,operator_id,operator_name,completed_at,"
                   "difficulty,insertion_site,vein,catheter_type,catheter_length,remark,"
                   "cancel_reason,cancel_detail,cancelled_at,source,updated_at)"
                   " VALUES(" + ",".join(["?"] * 25) + ")",
                   (uid, "DEMO-PICC-" + str(i + 1).zfill(3), name, bed, mrn, status, created, "demo-admin",
                    oid, oname, created if oid else None, oid if status == "completed" else None,
                    oname if status == "completed" else None,
                    (timestamp - timedelta(hours=hours - 3)).isoformat(timespec="seconds") if status == "completed" else None,
                    "困難" if i == 5 else ("簡單" if status == "completed" else None),
                    "右上臂" if status == "completed" else None, "Basilic" if status == "completed" else None,
                    "雙腔PICC" if status == "completed" else None, 40 if status == "completed" else None,
                    "這是獨立的示範資料",
                    "醫囑調整" if status == "cancelled" else None,
                    "示範取消紀錄" if status == "cancelled" else None,
                    now() if status == "cancelled" else None, "demo", now()))
        db.execute("INSERT INTO events(task_id,action,actor_id,actor_name,occurred_at,detail) VALUES(?,?,?,?,?,?)",
                   (uid, "cancelled" if status == "cancelled" else "created", "demo-admin", "示範管理者",
                    created, json.dumps({"note": "示範資料", "reason": "醫囑調整" if status == "cancelled" else ""}, ensure_ascii=False)))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    args = parser.parse_args()
    if args.demo:
        os.environ["PICC_DEMO"] = "1"
    app = create_app()
    if (not app.config["DEMO_MODE"] and app.config["NOTIFICATION_WEBHOOK"]
            and app.config["NOTIFICATION_SECRET"] and app.config["NOTIFICATION_ALLOWED_HOSTS"]):
        threading.Thread(target=app.notification_worker, daemon=True).start()
    from waitress import serve
    host = "127.0.0.1" if app.config["DEMO_MODE"] else os.environ.get("HOST", "127.0.0.1")
    print(f"PICC {'demo' if app.config['DEMO_MODE'] else 'app'}: http://{host}:{args.port}", flush=True)
    serve(app, host=host, port=args.port, threads=8)
