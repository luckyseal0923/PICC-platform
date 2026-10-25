"""Public browser configuration; never publishes server/service-role credentials."""
import base64
import json
import re
from urllib.parse import urlparse

PUBLIC_ENV_NAMES = {"SUPABASE_URL", "SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"}


def public_env_file(path):
    values = {}
    if not path.is_file():
        return values
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        match = re.match(r"\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$", line)
        if not match or match.group(1) not in PUBLIC_ENV_NAMES:
            continue
        value = match.group(2)
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        else:
            value = value.split(" #", 1)[0].strip()
        values[match.group(1)] = value
    return values


def public_settings(source, url_override="", key_override=""):
    def literal(name):
        match = re.search(r"\b" + name + r"\s*:\s*(['\"])(.*?)\1", source)
        return match.group(2) if match else ""

    url = (url_override or literal("supabaseUrl")).strip().rstrip("/")
    key = (key_override or literal("supabaseAnonKey")).strip()
    if key and not url:
        raise ValueError("請設定 Supabase 公開網址")
    parsed = urlparse(url)
    if url and (parsed.username or parsed.password or parsed.query or parsed.fragment
                or parsed.path not in ("", "/") or not re.fullmatch(r"[A-Za-z0-9.-]+", parsed.hostname or "")
                or parsed.scheme not in ("http", "https")
                or (parsed.scheme != "https" and parsed.hostname not in ("localhost", "127.0.0.1"))):
        raise ValueError("Supabase 公開網址設定不正確")
    try:
        parsed.port
    except ValueError:
        raise ValueError("Supabase 公開網址設定不正確") from None
    if key:
        if key.startswith("sb_publishable_") and re.fullmatch(r"[A-Za-z0-9_-]+", key):
            pass
        else:
            try:
                parts = key.split(".")
                if len(parts) != 3:
                    raise ValueError()
                claims = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
                if not isinstance(claims, dict) or claims.get("role") != "anon":
                    raise ValueError()
            except (ValueError, KeyError, TypeError, UnicodeError):
                raise ValueError("僅能設定 Supabase 公開 anon／publishable key") from None
    trial = re.search(r"\btrialMode\s*:\s*(true|false)", source)
    return {"supabaseUrl": url, "supabaseAnonKey": key, "authProvider": "", "testAuthEnabled": False,
            "trialMode": not trial or trial.group(1) == "true"}


def connection_sources(settings):
    parsed = urlparse(settings["supabaseUrl"])
    if not parsed.hostname:
        return []
    return [parsed.scheme + "://" + parsed.netloc,
            ("wss" if parsed.scheme == "https" else "ws") + "://" + parsed.netloc]
