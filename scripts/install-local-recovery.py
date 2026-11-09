#!/usr/bin/env python3
"""Install the restricted recovery coordinator credential without printing secrets."""
import os
import secrets
import sys
from pathlib import Path

os.umask(0o077)
public_key = Path(sys.argv[1]).read_text().strip()
if not public_key.startswith("ssh-ed25519 ") or "\n" in public_key:
    raise ValueError("Expected one Ed25519 public key")
secret_file = Path("/root/suno-api/data/local-recovery-secret")
if not secret_file.exists():
    secret_file.write_text(secrets.token_hex(32) + "\n")
secret_file.chmod(0o600)
ssh_directory = Path("/root/.ssh")
ssh_directory.mkdir(mode=0o700, exist_ok=True)
authorized = ssh_directory / "authorized_keys"
old = authorized.read_text() if authorized.exists() else ""
entry = 'restrict,command="/usr/bin/python3 /root/suno-api/scripts/local-recovery-command.py" ' + public_key
if public_key.split()[1] not in old:
    with authorized.open("a") as output:
        output.write(("\n" if old and not old.endswith("\n") else "") + entry + "\n")
authorized.chmod(0o600)
print("Restricted local recovery key and API secret installed")
