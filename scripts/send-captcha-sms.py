#!/usr/bin/env python3
"""Send the Suno manual-captcha alert using the existing Aunera Tencent SMS setup."""

import os
import sys
from pathlib import Path


def load_env(path: Path) -> None:
    if not path.is_file():
        raise RuntimeError(f"SMS env file not found: {path}")
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def normalize_phone(phone: str) -> str:
    phone = phone.strip()
    if phone.isdigit() and len(phone) == 11 and phone.startswith("1"):
        return f"+86{phone}"
    return phone


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: send-captcha-sms.py PHONE CODE", file=sys.stderr)
        return 2

    env_file = Path(os.environ.get("SUNO_CAPTCHA_SMS_ENV_FILE", "/root/Aunera/backend/.env"))
    load_env(env_file)

    from tencentcloud.common import credential
    from tencentcloud.common.profile.client_profile import ClientProfile
    from tencentcloud.common.profile.http_profile import HttpProfile
    from tencentcloud.sms.v20210111 import sms_client
    from tencentcloud.sms.v20210111.models import SendSmsRequest

    required = ("TCC_SECRET_ID", "TCC_SECRET_KEY", "TCC_SDK_APPID", "TCC_TEMPLATE_ID", "TCC_SIGN_NAME")
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise RuntimeError(f"missing Tencent SMS config: {', '.join(missing)}")

    cred = credential.Credential(os.environ["TCC_SECRET_ID"], os.environ["TCC_SECRET_KEY"])
    http_profile = HttpProfile()
    http_profile.endpoint = os.environ.get("TCC_ENDPOINT", "sms.tencentcloudapi.com")
    client_profile = ClientProfile()
    client_profile.httpProfile = http_profile
    client = sms_client.SmsClient(cred, os.environ.get("TCC_REGION", "ap-beijing"), client_profile)

    request = SendSmsRequest()
    request.SmsSdkAppId = os.environ["TCC_SDK_APPID"]
    request.SignName = os.environ["TCC_SIGN_NAME"]
    request.TemplateId = os.environ["TCC_TEMPLATE_ID"]
    request.TemplateParamSet = [sys.argv[2]]
    request.PhoneNumberSet = [normalize_phone(sys.argv[1])]
    response = client.SendSms(request)
    if not response.SendStatusSet:
        raise RuntimeError("Tencent SMS returned no send status")
    status = response.SendStatusSet[0]
    if status.Code != "Ok":
        raise RuntimeError(f"Tencent SMS rejected request: {status.Code}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
