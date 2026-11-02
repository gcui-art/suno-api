#!/usr/bin/env python3
"""Restricted SSH entry point for the local browser recovery coordinator."""
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path


def main():
    command = os.environ.get("SSH_ORIGINAL_COMMAND", "").strip()
    if command not in {"status", "claim", "complete", "fail", "result"}:
        raise ValueError("Unsupported recovery command")
    raw = sys.stdin.buffer.read(16385)
    if len(raw) > 16384:
        raise ValueError("Request is too large")
    data = json.loads(raw or b"{}")
    if not isinstance(data, dict):
        raise ValueError("Expected a JSON object")
    port = int(os.environ.get("SUNO_RECOVERY_CONTROL_PORT", "8005"))
    if port not in {8005, 18005}:
        raise ValueError("Unsupported control port")
    base = f"http://127.0.0.1:{port}"
    endpoint = "/api/internal/captcha-recovery"
    headers = {"Content-Type": "application/json"}
    body = None
    if command == "result":
        identifier = str(uuid.UUID(data["id"]))
        endpoint = f"/api/generation-requests/{identifier}"
    else:
        secret = Path(os.environ.get("SUNO_LOCAL_RECOVERY_SECRET_FILE", "/root/suno-api/data/local-recovery-secret")).read_text().strip()
        headers["Authorization"] = f"Bearer {secret}"
        if command == "status":
            endpoint += "?include=recent"
        else:
            data["action"] = command
            body = json.dumps(data).encode()
    request = urllib.request.Request(base + endpoint, data=body, headers=headers)
    try:
        response = urllib.request.urlopen(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        payload = json.load(response)
        print(json.dumps({"httpStatus": response.status, "data": payload}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}))
        sys.exit(1)
