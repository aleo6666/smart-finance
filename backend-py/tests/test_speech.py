"""讯飞 IAT 语音转写：签名回归 + 路由 mock。"""

import base64
import hashlib
import hmac

from app.api.deps import create_access_token
from app.services.speech import (
    IAT_HOST,
    IAT_PATH,
    build_iat_authorization,
    build_signature_origin,
)


def test_signature_origin_third_line_has_no_request_line_prefix() -> None:
    origin = build_signature_origin("Tue, 18 Aug 2026 08:00:00 GMT")

    assert origin == (
        f"host: {IAT_HOST}\n"
        "date: Tue, 18 Aug 2026 08:00:00 GMT\n"
        f"GET {IAT_PATH} HTTP/1.1"
    )
    # 已知坑：第三行绝不能加 "request-line: " 前缀（否则 401 HMAC 不匹配）
    assert "request-line:" not in origin
    assert "request-line" not in origin.splitlines()[2]


def test_authorization_signature_matches_hmac_of_origin() -> None:
    api_key = "test-key"
    api_secret = "test-secret"
    date = "Tue, 18 Aug 2026 08:00:00 GMT"

    authorization = base64.b64decode(
        build_iat_authorization(api_key, api_secret, date)
    ).decode("ascii")

    assert 'api_key="test-key"' in authorization
    # headers 里 "request-line" 只是参数名，不是签名串前缀
    assert 'headers="host date request-line"' in authorization
    expected_signature = base64.b64encode(
        hmac.new(
            api_secret.encode("utf-8"),
            build_signature_origin(date).encode("utf-8"),
            hashlib.sha256,
        ).digest()
    ).decode("ascii")
    assert f'signature="{expected_signature}"' in authorization


def test_transcribe_route_mocks_transcription(api_client, monkeypatch) -> None:
    async def fake_transcribe_upload(buffer, mimetype, filename, settings):
        assert buffer == b"FAKEAUDIO"
        assert filename == "sample.wav"
        return "你好，世界"

    monkeypatch.setattr("app.api.speech.transcribe_upload", fake_transcribe_upload)
    token = create_access_token(1)

    response = api_client.post(
        "/api/speech/transcribe",
        headers={"Authorization": f"Bearer {token}"},
        files={"audio": ("sample.wav", b"FAKEAUDIO", "audio/wav")},
    )

    assert response.status_code == 200
    assert response.json() == {"success": True, "data": {"text": "你好，世界"}}


def test_transcribe_route_requires_token(api_client) -> None:
    response = api_client.post(
        "/api/speech/transcribe",
        files={"audio": ("sample.wav", b"FAKEAUDIO", "audio/wav")},
    )

    assert response.status_code == 401
    assert response.json()["success"] is False
