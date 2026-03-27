#!/usr/bin/env python3
import argparse
import json
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class ControlPlaneState:
    def __init__(self) -> None:
        self.orgs_by_key: dict[str, dict] = {}
        self.next_key_id = 1

    def register(self, org_name: str) -> str:
        api_key = f"test-key-{self.next_key_id}"
        self.next_key_id += 1
        self.orgs_by_key[api_key] = {
            "orgName": org_name,
            "runtime": {
                "nodeVersion": "",
                "releaseChannel": "",
                "image": "",
                "stateSchemaVersion": None,
                "location": "",
                "intervalMs": None,
                "identityHint": {},
                "lastSeenAt": None,
                "onlineNow": False,
            },
            "recentNodeEvents": deque(maxlen=20),
        }
        return api_key

    def get_org(self, api_key: str) -> dict | None:
        return self.orgs_by_key.get(api_key)


STATE = ControlPlaneState()


class Handler(BaseHTTPRequestHandler):
    server_version = "pushme-netnode-mock/1.0"

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode())

    def _require_auth(self) -> dict | None:
        auth = self.headers.get("Authorization", "")
        prefix = "Bearer "
        if not auth.startswith(prefix):
            self._send_json(401, {"error": "missing bearer token"})
            return None
        api_key = auth[len(prefix) :]
        org = STATE.get_org(api_key)
        if org is None:
            self._send_json(403, {"error": "unknown api key"})
            return None
        return org

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._send_json(200, {"ok": True})
            return

        if self.path == "/api/bot/netnode/status":
            org = self._require_auth()
            if org is None:
                return
            self._send_json(
                200,
                {
                    "runtime": org["runtime"],
                    "recentNodeEvents": list(org["recentNodeEvents"]),
                },
            )
            return

        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/api/bot/register":
            payload = self._read_json()
            api_key = STATE.register(payload.get("orgName", ""))
            self._send_json(200, {"apiKey": api_key})
            return

        org = self._require_auth()
        if org is None:
            return

        payload = self._read_json()

        if self.path in {"/api/bot/netnode/startup", "/api/bot/netnode/heartbeat"}:
            org["runtime"] = {
                "nodeVersion": payload.get("nodeVersion", ""),
                "releaseChannel": payload.get("releaseChannel", ""),
                "image": payload.get("image", ""),
                "stateSchemaVersion": payload.get("stateSchemaVersion"),
                "location": payload.get("location", ""),
                "intervalMs": payload.get("intervalMs"),
                "identityHint": payload.get("identityHint", {}),
                "lastSeenAt": now_iso(),
                "onlineNow": True,
            }
            self._send_json(
                200,
                {
                    "updateAvailable": False,
                    "latestVersion": payload.get("nodeVersion", ""),
                    "minSupportedVersion": payload.get("nodeVersion", ""),
                    "image": payload.get("image", ""),
                },
            )
            return

        if self.path == "/api/bot/publish":
            org["recentNodeEvents"].appendleft(
                {
                    "eventType": payload.get("eventType"),
                    "title": payload.get("title"),
                    "summary": payload.get("summary"),
                    "sourceUrl": payload.get("sourceUrl"),
                    "receivedAt": now_iso(),
                    "metadata": payload.get("metadata", {}),
                }
            )
            self._send_json(200, {"ok": True})
            return

        self._send_json(404, {"error": "not found"})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
