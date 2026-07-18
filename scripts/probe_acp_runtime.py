#!/usr/bin/env python3
"""Probe an ACP stdio runtime through initialize and session/new."""

from __future__ import annotations

import argparse
import json
import os
import selectors
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


class ProbeError(Exception):
    pass


def summarize_config_option(option: Any) -> dict[str, Any]:
    if not isinstance(option, dict):
        return {"type": type(option).__name__}
    summary = {
        key: option[key]
        for key in ("id", "name", "category", "type")
        if isinstance(option.get(key), (str, bool, int, float))
    }
    options = option.get("options")
    if isinstance(options, list):
        summary["optionCount"] = len(options)
        if len(options) <= 20:
            summary["optionValues"] = [
                item.get("value")
                for item in options
                if isinstance(item, dict) and isinstance(item.get("value"), str)
            ]
    return summary


def summarize_session(session: Any) -> Any:
    if not isinstance(session, dict):
        return {"type": type(session).__name__}
    result: dict[str, Any] = {
        "sessionIdPresent": bool(str(session.get("sessionId", "")).strip())
    }
    config_options = session.get("configOptions")
    if isinstance(config_options, list):
        result["configOptions"] = [
            summarize_config_option(option) for option in config_options
        ]
    result["additionalFields"] = sorted(
        key for key in session if key not in {"sessionId", "configOptions"}
    )
    return result


def summarize_notifications(notifications: list[dict[str, Any]]) -> dict[str, Any]:
    session_update_types: set[str] = set()
    catalog_counts: dict[str, int] = {}
    for message in notifications:
        params = message.get("params")
        update = params.get("update") if isinstance(params, dict) else None
        if not isinstance(update, dict):
            continue
        update_type = update.get("sessionUpdate")
        if isinstance(update_type, str):
            session_update_types.add(update_type)
        for key in ("availableCommands", "configOptions", "models", "modes"):
            if isinstance(update.get(key), list):
                catalog_counts[key] = max(catalog_counts.get(key, 0), len(update[key]))
    result: dict[str, Any] = {
        "count": len(notifications),
        "methods": sorted(
            {
                message["method"]
                for message in notifications
                if isinstance(message.get("method"), str)
            }
        ),
    }
    if session_update_types:
        result["sessionUpdateTypes"] = sorted(session_update_types)
    if catalog_counts:
        result["catalogCounts"] = dict(sorted(catalog_counts.items()))
    return result


def parse_environment(values: list[str], clean: bool) -> dict[str, str]:
    if clean:
        result = {
            key: os.environ[key]
            for key in ("PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL")
            if key in os.environ
        }
    else:
        result = dict(os.environ)
    for value in values:
        key, separator, item = value.partition("=")
        if not separator or not key:
            raise ProbeError(f"invalid --env value: {value}")
        result[key] = item
    result.setdefault("NO_BROWSER", "1")
    return result


class ACPProcess:
    def __init__(
        self, command: list[str], cwd: Path, env: dict[str, str], timeout: float
    ):
        self.timeout = timeout
        self.process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=False,
            shell=False,
        )
        if (
            self.process.stdin is None
            or self.process.stdout is None
            or self.process.stderr is None
        ):
            raise ProbeError("failed to open ACP stdio pipes")
        os.set_blocking(self.process.stdout.fileno(), False)
        os.set_blocking(self.process.stderr.fileno(), False)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ, "stdout")
        self.selector.register(self.process.stderr, selectors.EVENT_READ, "stderr")
        self.stdout_buffer = b""
        self.stderr_buffer = b""
        self.notifications: list[dict[str, Any]] = []

    def send(self, payload: dict[str, Any]) -> None:
        if self.process.stdin is None:
            raise ProbeError("ACP stdin is closed")
        self.process.stdin.write(
            json.dumps(payload, separators=(",", ":")).encode() + b"\n"
        )
        self.process.stdin.flush()

    def call(self, request_id: int, method: str, params: dict[str, Any]) -> Any:
        self.send(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        )
        deadline = time.monotonic() + self.timeout
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise ProbeError(
                    f"ACP runtime exited with {self.process.returncode}: {self.stderr_text()}"
                )
            for key, _ in self.selector.select(max(0.0, deadline - time.monotonic())):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    continue
                if key.data == "stderr":
                    self.stderr_buffer += chunk
                    continue
                self.stdout_buffer += chunk
                response_received = False
                response_result: Any = None
                while b"\n" in self.stdout_buffer:
                    line, self.stdout_buffer = self.stdout_buffer.split(b"\n", 1)
                    if not line.strip():
                        continue
                    message = self.parse_message(line)
                    if message.get("id") == request_id and (
                        "result" in message or "error" in message
                    ):
                        if "error" in message:
                            raise ProbeError(
                                f"ACP {method} failed: {json.dumps(message['error'], ensure_ascii=False)}"
                            )
                        response_received = True
                        response_result = message.get("result")
                        continue
                    self.handle_unsolicited(message)
                if response_received:
                    return response_result
        raise ProbeError(f"ACP {method} timed out after {self.timeout:g}s")

    def handle_unsolicited(self, message: dict[str, Any]) -> None:
        if "method" in message and "id" in message:
            self.send(
                {
                    "jsonrpc": "2.0",
                    "id": message["id"],
                    "error": {
                        "code": -32601,
                        "message": "probe client method unsupported",
                    },
                }
            )
        else:
            self.notifications.append(message)

    def drain(self, duration: float) -> None:
        deadline = time.monotonic() + max(0.0, duration)
        while time.monotonic() < deadline:
            events = self.selector.select(max(0.0, deadline - time.monotonic()))
            if not events:
                break
            for key, _ in events:
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    continue
                if key.data == "stderr":
                    self.stderr_buffer += chunk
                    continue
                self.stdout_buffer += chunk
                while b"\n" in self.stdout_buffer:
                    line, self.stdout_buffer = self.stdout_buffer.split(b"\n", 1)
                    if line.strip():
                        self.handle_unsolicited(self.parse_message(line))

    @staticmethod
    def parse_message(line: bytes) -> dict[str, Any]:
        try:
            message = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ProbeError(
                f"ACP stdout contained invalid JSON: {line[:200]!r}"
            ) from exc
        if not isinstance(message, dict):
            raise ProbeError("ACP stdout message must be a JSON object")
        return message

    def stderr_text(self) -> str:
        return self.stderr_buffer.decode("utf-8", errors="replace").strip()

    def close(self) -> None:
        self.selector.close()
        if self.process.stdin is not None:
            self.process.stdin.close()
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--timeout", type=float, default=10.0)
    parser.add_argument("--env", action="append", default=[])
    parser.add_argument(
        "--clean-env",
        action="store_true",
        help="drop inherited credentials and provider configuration, using a fresh temporary HOME unless --env HOME=... is provided",
    )
    parser.add_argument("--initialize-only", action="store_true")
    parser.add_argument(
        "--notification-settle-ms",
        type=int,
        default=250,
        help="bounded wait after session/new for asynchronous command and Skill updates",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="print full session payloads; the default redacts session IDs and summarizes catalogs",
    )
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("provide the ACP runtime command after --")
    cwd = args.cwd.resolve()
    if not cwd.is_dir():
        parser.error(f"--cwd is not a directory: {cwd}")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if not 0 <= args.notification_settle_ms <= 5_000:
        parser.error("--notification-settle-ms must be between 0 and 5000")

    runtime: ACPProcess | None = None
    temporary_home: tempfile.TemporaryDirectory[str] | None = None
    try:
        environment = parse_environment(args.env, args.clean_env)
        if args.clean_env and "HOME" not in environment:
            temporary_home = tempfile.TemporaryDirectory(
                prefix="tutti-agent-extension-probe-home-"
            )
            environment["HOME"] = temporary_home.name
            environment.setdefault("XDG_CONFIG_HOME", os.path.join(
                temporary_home.name, ".config"
            ))
            environment.setdefault("XDG_DATA_HOME", os.path.join(
                temporary_home.name, ".local", "share"
            ))
            environment.setdefault("XDG_STATE_HOME", os.path.join(
                temporary_home.name, ".local", "state"
            ))
            environment.setdefault("XDG_CACHE_HOME", os.path.join(
                temporary_home.name, ".cache"
            ))
        runtime = ACPProcess(
            command, cwd, environment, args.timeout
        )
        initialize = runtime.call(
            1,
            "initialize",
            {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": {"readTextFile": False, "writeTextFile": False},
                    "terminal": False,
                },
                "clientInfo": {
                    "name": "tutti-agent-extension-probe",
                    "version": "1.0.0",
                },
            },
        )
        result: dict[str, Any] = {"status": "ok", "initialize": initialize}
        if not args.initialize_only:
            session = runtime.call(
                2,
                "session/new",
                {"cwd": os.fspath(cwd), "mcpServers": []},
            )
            if (
                not isinstance(session, dict)
                or not str(session.get("sessionId", "")).strip()
            ):
                raise ProbeError("ACP session/new returned no sessionId")
            result["sessionNew"] = session if args.full else summarize_session(session)
            runtime.drain(args.notification_settle_ms / 1_000)
        result["notifications"] = (
            runtime.notifications
            if args.full
            else summarize_notifications(runtime.notifications)
        )
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, ProbeError) as exc:
        print(
            json.dumps({"status": "error", "error": str(exc)}, ensure_ascii=False),
            file=sys.stderr,
        )
        return 1
    finally:
        if runtime is not None:
            runtime.close()
        if temporary_home is not None:
            temporary_home.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
