"""讯飞实时语音转写 (IAT) WebSocket 客户端.

参考旧 Node 实现 ``server/src/routes/speech.js`` 重写为纯 Python，不复制旧代码。
鉴权采用讯飞 v2 签名：HMAC-SHA256(api_secret, signature_origin) → base64。

已知坑（2026-08-16 实测修过）：signature_origin 第三行是
``GET /v2/iat HTTP/1.1``，绝不能加 ``request-line: `` 前缀（加了会返回
401 HMAC signature does not match）。headers 参数里的 ``request-line``
只是 authorization 头的参数名，不是签名串的前缀。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
from email.utils import formatdate
from urllib.parse import quote

from app.core.config import Settings

logger = logging.getLogger(__name__)

IAT_HOST = "iat-api.xfyun.cn"
IAT_PATH = "/v2/iat"
IAT_URL = "wss://iat-api.xfyun.cn/v2/iat"

PCM_FRAME_BYTES = 2560  # 1280 samples * 2 bytes，16kHz 下约 40ms 一帧
MAX_DURATION_SECONDS = 60
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
SUPPORTED_WAV_RATES = {8000, 16000}


class SpeechError(Exception):
    """语音转写失败（携带 HTTP 状态码）。"""

    def __init__(self, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


def build_signature_origin(date: str) -> str:
    """构造讯飞签名原串。第三行必须是 ``GET /v2/iat HTTP/1.1``。"""
    return f"host: {IAT_HOST}\ndate: {date}\nGET {IAT_PATH} HTTP/1.1"


def build_iat_authorization(api_key: str, api_secret: str, date: str) -> str:
    signature_origin = build_signature_origin(date)
    signature = base64.b64encode(
        hmac.new(
            api_secret.encode("utf-8"),
            signature_origin.encode("utf-8"),
            hashlib.sha256,
        ).digest()
    ).decode("ascii")
    authorization_origin = (
        f'api_key="{api_key}", algorithm="hmac-sha256", '
        f'headers="host date request-line", signature="{signature}"'
    )
    return base64.b64encode(authorization_origin.encode("utf-8")).decode("ascii")


def build_iat_url(api_key: str, api_secret: str, date: str | None = None) -> str:
    date = date or formatdate(usegmt=True)
    authorization = build_iat_authorization(api_key, api_secret, date)
    return (
        f"{IAT_URL}?authorization={quote(authorization, safe='')}"
        f"&date={quote(date, safe='')}&host={IAT_HOST}"
    )


def _build_frames(app_id: str, audio: bytes, sample_rate: int) -> list[str]:
    if not audio:
        raise SpeechError("音频为空", 400)
    payloads = [
        audio[offset : offset + PCM_FRAME_BYTES]
        for offset in range(0, len(audio), PCM_FRAME_BYTES)
    ]
    frames = []
    for index, payload in enumerate(payloads):
        if len(payloads) == 1:
            status = 2
        elif index == 0:
            status = 0
        elif index == len(payloads) - 1:
            status = 2
        else:
            status = 1
        frames.append(
            json.dumps(
                {
                    "common": {"app_id": app_id},
                    "business": {
                        "language": "zh_cn",
                        "domain": "iat",
                        "accent": "mandarin",
                        "vad_eos": 5000,
                        "dwa": "wpgs",
                    },
                    "data": {
                        "status": status,
                        "format": f"audio/L16;rate={sample_rate}",
                        "encoding": "raw",
                        "audio": base64.b64encode(payload).decode("ascii"),
                    },
                }
            )
        )
    return frames


async def transcribe(
    audio: bytes,
    *,
    app_id: str | None,
    api_key: str | None,
    api_secret: str | None,
    sample_rate: int = 16000,
    timeout: float = 30.0,
) -> str:
    """通过讯飞 WebSocket 转写 PCM 音频，返回完整文本。"""
    if not (app_id and api_key and api_secret):
        raise SpeechError(
            "讯飞语音听写凭据未配置（XFYUN_APP_ID/XFYUN_API_KEY/XFYUN_API_SECRET）",
            502,
        )

    try:
        import websockets
    except ImportError as exc:
        raise SpeechError("当前环境不支持 WebSocket", 502) from exc

    async def _run() -> str:
        async with websockets.connect(build_iat_url(api_key, api_secret)) as ws:
            for frame in _build_frames(app_id, audio, sample_rate):
                await ws.send(frame)
            transcript = ""
            async for raw in ws:
                message = json.loads(raw)
                if message.get("code") != 0:
                    raise SpeechError(
                        f"讯飞语音听写失败：{message.get('code')} {message.get('message')}",
                        502,
                    )
                data = message.get("data") or {}
                for item in (data.get("result") or {}).get("ws", []):
                    word = (item.get("cw") or [{}])[0].get("w") or ""
                    transcript += word
                if data.get("status") == 2:
                    return transcript.strip()
            raise SpeechError("讯飞语音听写连接意外关闭", 502)

    try:
        return await asyncio.wait_for(_run(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        raise SpeechError("讯飞语音听写超时", 502) from exc


def parse_wav_header(buffer: bytes) -> dict | None:
    if len(buffer) < 44:
        return None
    if buffer[:4] != b"RIFF" or buffer[8:12] != b"WAVE":
        return None
    audio_format = int.from_bytes(buffer[20:22], "little")
    channels = int.from_bytes(buffer[22:24], "little")
    sample_rate = int.from_bytes(buffer[24:28], "little")
    bits_per_sample = int.from_bytes(buffer[34:36], "little")
    offset = 12
    data_offset = -1
    data_end = len(buffer)
    while offset + 8 <= len(buffer):
        chunk_id = buffer[offset : offset + 4]
        size = int.from_bytes(buffer[offset + 4 : offset + 8], "little")
        if chunk_id == b"data":
            data_offset = offset + 8
            data_end = min(data_offset + size, len(buffer))
            break
        offset += 8 + size + (size % 2)
    if data_offset < 0:
        return None
    return {
        "audio_format": audio_format,
        "channels": channels,
        "sample_rate": sample_rate,
        "bits_per_sample": bits_per_sample,
        "data_offset": data_offset,
        "data_end": data_end,
    }


def detect_audio_format(
    buffer: bytes, mimetype: str = "", filename: str = ""
) -> str:
    name = (filename or "").lower()
    mime = (mimetype or "").lower()
    if (
        len(buffer) >= 12
        and buffer[:4] == b"RIFF"
        and buffer[8:12] == b"WAVE"
    ):
        return "wav"
    if len(buffer) >= 4 and buffer[:4].hex() == "1a45dfa3":
        return "unsupported-webm"
    if len(buffer) >= 4 and buffer[:4] == b"OggS":
        return "unsupported-ogg"
    if "webm" in mime or name.endswith(".webm"):
        return "unsupported-webm"
    if "ogg" in mime or name.endswith(".ogg"):
        return "unsupported-ogg"
    if "wav" in mime or "wave" in mime or name.endswith(".wav"):
        return "wav"
    if "pcm" in mime or name.endswith(".pcm"):
        return "pcm"
    return "unsupported-other"


async def transcribe_upload(
    buffer: bytes,
    mimetype: str,
    filename: str,
    settings: Settings,
) -> str:
    """校验上传音频格式并调用讯飞转写。"""
    if len(buffer) > MAX_UPLOAD_BYTES:
        raise SpeechError("音频文件过大", 400)
    format_name = detect_audio_format(buffer, mimetype, filename)
    if format_name.startswith("unsupported"):
        reason = (
            "webm"
            if format_name == "unsupported-webm"
            else "ogg"
            if format_name == "unsupported-ogg"
            else "未知"
        )
        raise SpeechError(
            f"音频格式不支持（{reason}）：当前仅支持 16kHz/8kHz 16bit 单声道 "
            "WAV 或 PCM，请将前端录音改为 WAV/PCM 后上传",
            501,
        )

    if format_name == "wav":
        header = parse_wav_header(buffer)
        if header is None:
            raise SpeechError("音频格式不支持：无法解析 WAV 文件头", 501)
        supported = (
            header["audio_format"] == 1
            and header["channels"] == 1
            and header["bits_per_sample"] == 16
            and header["sample_rate"] in SUPPORTED_WAV_RATES
        )
        if not supported:
            raise SpeechError(
                "音频格式不支持：WAV 需为 PCM 16bit 单声道，采样率 8kHz 或 16kHz",
                501,
            )
        duration = (header["data_end"] - header["data_offset"]) / (
            header["sample_rate"] * 2
        )
        if duration > MAX_DURATION_SECONDS:
            raise SpeechError("音频超过 60 秒限制", 400)
        pcm = buffer[header["data_offset"] : header["data_end"]]
        return await transcribe(
            pcm,
            app_id=settings.xfyun_app_id,
            api_key=settings.xfyun_api_key,
            api_secret=settings.xfyun_api_secret,
            sample_rate=header["sample_rate"],
        )

    duration = len(buffer) / (16000 * 2)
    if duration > MAX_DURATION_SECONDS:
        raise SpeechError("音频超过 60 秒限制", 400)
    return await transcribe(
        buffer,
        app_id=settings.xfyun_app_id,
        api_key=settings.xfyun_api_key,
        api_secret=settings.xfyun_api_secret,
        sample_rate=16000,
    )
