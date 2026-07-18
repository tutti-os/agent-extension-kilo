#!/usr/bin/env python3
"""Validate a declarative Tutti Agent Extension package without network access."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import stat
import sys
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath
from typing import Any

MANIFEST_SCHEMA = "tutti.agent.manifest.v1"
PROFILE_SCHEMAS = {
    "discovery": "tutti.agent.discovery.v1",
    "tools": "tutti.agent.tools.v1",
    "capabilities": "tutti.agent.capabilities.v1",
    "composer": "tutti.agent.composer.v1",
}
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$")
EXACT_NPM_PACKAGE = re.compile(
    r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@"
    r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$"
)
EXACT_UV_PACKAGE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]*=="
    r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[A-Za-z0-9._+-]*)?$"
)
BINARY_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
PRESENTATION_ASSET_LIMIT = 256 << 10
PRESENTATION_ASSET_SUFFIXES = {".jpeg", ".jpg", ".png", ".svg", ".webp"}
PACKAGE_DOCUMENTATION = {"AGENTS.md", "LICENSE", "NOTICE.md", "README.md"}
MANIFEST_KEYS = {
    "schemaVersion",
    "agentKey",
    "version",
    "name",
    "description",
    "icon",
    "sidebarIcon",
    "heroImage",
    "runtime",
    "profiles",
    "localizationInfo",
}
PERMISSION_SEMANTICS = {
    "read-only",
    "ask-before-write",
    "accept-edits",
    "full-access",
}
ALLOWED_PLACEHOLDERS = {"${projectRoot}", "${installRoot}", "${platform}"}
CAPABILITY_KEYS = {
    "imageInput",
    "audioInput",
    "embeddedContext",
    "interrupt",
    "resume",
    "permissionModes",
    "modelSelection",
    "mcpHttp",
    "mcpSse",
    "planMode",
    "skills",
}


class ValidationError(Exception):
    pass


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValidationError(f"cannot read JSON {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise ValidationError(f"expected JSON object: {path}")
    return value


def require_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{field} must be a non-empty string")
    return value


def require_string_array(
    value: Any, field: str, *, non_empty: bool = False
) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValidationError(f"{field} must be a string array")
    if non_empty and not value:
        raise ValidationError(f"{field} must not be empty")
    return value


def require_safe_relative_path(value: Any, field: str) -> str:
    path = require_string(value, field)
    pure = PurePosixPath(path)
    if pure.is_absolute() or ".." in pure.parts or "\\" in path:
        raise ValidationError(f"{field} must be a safe relative POSIX path")
    return path


def validate_template_argument(value: str, field: str) -> None:
    if re.search(r"[|;&`\n\r<>]|\$\(", value):
        raise ValidationError(f"{field} contains forbidden shell syntax")
    for placeholder in re.findall(r"\$\{[^}]+\}", value):
        if placeholder not in ALLOWED_PLACEHOLDERS:
            raise ValidationError(f"{field} contains unsupported placeholder {placeholder}")


def resolve_reference(root: Path, value: Any, field: str) -> Path:
    reference = require_string(value, field)
    pure = PurePosixPath(reference)
    if pure.is_absolute() or ".." in pure.parts or "\\" in reference:
        raise ValidationError(f"{field} must be a safe relative POSIX path")
    resolved = (root / Path(*pure.parts)).resolve()
    try:
        resolved.relative_to(root.resolve())
    except ValueError as exc:
        raise ValidationError(f"{field} escapes package root") from exc
    if not resolved.is_file():
        raise ValidationError(f"{field} does not exist: {reference}")
    return resolved


def validate_presentation_asset(root: Path, descriptor: Any, field: str) -> Path:
    if not isinstance(descriptor, dict):
        raise ValidationError(f"{field} must be an extension asset")
    reject_unknown_keys(descriptor, {"type", "src"}, field)
    if descriptor.get("type") != "asset":
        raise ValidationError(f"{field} must be an extension asset")
    path = resolve_reference(root, descriptor.get("src"), f"{field}.src")
    if path.stat().st_size > PRESENTATION_ASSET_LIMIT:
        raise ValidationError(f"{field} exceeds the 256 KiB presentation asset limit")
    if path.suffix.lower() not in PRESENTATION_ASSET_SUFFIXES:
        raise ValidationError(f"{field} must be JPEG, PNG, SVG, or WebP")
    content_type, _ = mimetypes.guess_type(path.name)
    if not content_type or not content_type.startswith("image/"):
        raise ValidationError(f"{field} must use a supported image file type")
    if path.suffix.lower() == ".svg":
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            raise ValidationError(f"{field} SVG must be valid UTF-8") from exc
        if re.search(r"<\?(?!xml\s)|<!DOCTYPE|<!ENTITY", content, re.IGNORECASE):
            raise ValidationError(f"{field} SVG contains active XML content")
        if re.search(
            r"url\s*\(\s*['\"]?\s*(?:https?:|//|data:image/svg)",
            content,
            re.IGNORECASE,
        ):
            raise ValidationError(f"{field} SVG contains a remote reference")
        try:
            document = ET.fromstring(content)
        except ET.ParseError as exc:
            raise ValidationError(f"{field} SVG must be well-formed XML") from exc
        if document.tag.rsplit("}", 1)[-1].lower() != "svg":
            raise ValidationError(f"{field} SVG root element must be svg")
        for element in document.iter():
            element_name = element.tag.rsplit("}", 1)[-1].lower()
            if element_name in {
                "script",
                "style",
                "foreignobject",
                "iframe",
                "object",
                "embed",
            }:
                raise ValidationError(f"{field} SVG contains active content")
            for attribute, raw_value in element.attrib.items():
                attribute_name = attribute.rsplit("}", 1)[-1].lower()
                value = raw_value.strip().lower()
                if (
                    attribute_name.startswith("on")
                    or "javascript:" in value
                    or re.search(
                        r"url\s*\(\s*['\"]?\s*(?:https?:|//|data:image/svg)",
                        value,
                        re.IGNORECASE,
                    )
                ):
                    raise ValidationError(f"{field} SVG contains active or remote content")
                if attribute_name in {"href", "src"} and not (
                    value.startswith("#")
                    or (
                        value.startswith("data:image/")
                        and not value.startswith("data:image/svg")
                    )
                ):
                    raise ValidationError(f"{field} SVG contains a remote reference")
    else:
        validate_raster_asset(path.read_bytes(), path.suffix.lower(), field)
    return path


def validate_raster_asset(data: bytes, suffix: str, field: str) -> None:
    if suffix == ".png":
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            raise ValidationError(f"{field} must be a valid PNG container")
        offset = 8
        chunks: list[bytes] = []
        while offset < len(data):
            if len(data) - offset < 12:
                raise ValidationError(f"{field} must be a valid PNG container")
            length = int.from_bytes(data[offset : offset + 4], "big")
            chunk_type = data[offset + 4 : offset + 8]
            offset += 12 + length
            if offset > len(data):
                raise ValidationError(f"{field} must be a valid PNG container")
            chunks.append(chunk_type)
            if chunk_type == b"IEND":
                if length != 0 or offset != len(data):
                    raise ValidationError(f"{field} must be a valid PNG container")
                break
        if not chunks or chunks[0] != b"IHDR" or b"IDAT" not in chunks or chunks[-1] != b"IEND":
            raise ValidationError(f"{field} must be a valid PNG container")
        return
    if suffix in {".jpeg", ".jpg"}:
        if len(data) < 8 or data[:2] != b"\xff\xd8" or data[-2:] != b"\xff\xd9":
            raise ValidationError(f"{field} must be a valid JPEG container")
        saw_frame = False
        saw_scan = False
        offset = 2
        while offset < len(data) - 2 and not saw_scan:
            if data[offset] != 0xFF:
                raise ValidationError(f"{field} must be a valid JPEG container")
            while offset < len(data) and data[offset] == 0xFF:
                offset += 1
            if offset >= len(data):
                raise ValidationError(f"{field} must be a valid JPEG container")
            marker = data[offset]
            offset += 1
            if marker in {0x01, *range(0xD0, 0xD8)}:
                continue
            if marker == 0xD9 or offset + 2 > len(data):
                break
            length = int.from_bytes(data[offset : offset + 2], "big")
            if length < 2 or offset + length > len(data):
                raise ValidationError(f"{field} must be a valid JPEG container")
            if marker in {
                0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
            }:
                saw_frame = True
            if marker == 0xDA:
                saw_scan = True
            offset += length
        if not saw_frame or not saw_scan:
            raise ValidationError(f"{field} must be a valid JPEG container")
        return
    if suffix == ".webp":
        if (
            len(data) < 20
            or data[:4] != b"RIFF"
            or data[8:12] != b"WEBP"
            or int.from_bytes(data[4:8], "little") + 8 != len(data)
        ):
            raise ValidationError(f"{field} must be a valid WebP container")
        offset = 12
        has_image_chunk = False
        while offset < len(data):
            if len(data) - offset < 8:
                raise ValidationError(f"{field} must be a valid WebP container")
            chunk_type = data[offset : offset + 4]
            length = int.from_bytes(data[offset + 4 : offset + 8], "little")
            offset += 8 + length + (length % 2)
            if offset > len(data):
                raise ValidationError(f"{field} must be a valid WebP container")
            has_image_chunk = has_image_chunk or chunk_type in {b"VP8 ", b"VP8L", b"ANMF"}
        if offset != len(data) or not has_image_chunk:
            raise ValidationError(f"{field} must be a valid WebP container")


def check_package_tree(root: Path) -> None:
    for path in root.rglob("*"):
        relative = path.relative_to(root)
        if path.is_symlink():
            raise ValidationError(f"symlinks are not allowed: {relative}")
        mode = path.stat().st_mode
        if path.is_file() and mode & (stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH):
            raise ValidationError(f"executable files are not allowed: {relative}")
        if any(part in {".git", "node_modules"} for part in relative.parts):
            raise ValidationError(f"development directory is not allowed: {relative}")


def check_declared_files(root: Path, referenced: set[Path]) -> None:
    allowed = {path.resolve() for path in referenced}
    allowed.add((root / "tutti.agent.json").resolve())
    allowed.update((root / name).resolve() for name in PACKAGE_DOCUMENTATION)
    allowed_directories = {root.resolve()}
    for target in allowed:
        parent = target.parent
        while parent != root.resolve() and parent != parent.parent:
            allowed_directories.add(parent)
            parent = parent.parent
    for path in root.rglob("*"):
        if path.is_dir() and path.resolve() not in allowed_directories:
            raise ValidationError(
                f"undeclared package directory is not allowed: {path.relative_to(root)}"
            )
        if path.is_file() and path.resolve() not in allowed:
            raise ValidationError(
                f"undeclared package file is not allowed: {path.relative_to(root)}"
            )


def reject_unknown_keys(value: dict[str, Any], allowed: set[str], field: str) -> None:
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ValidationError(f"{field} contains unsupported fields: {', '.join(unknown)}")


def check_install(runtime: dict[str, Any]) -> None:
    reject_unknown_keys(runtime, {"kind", "install", "launch"}, "runtime")
    if runtime.get("kind") != "standard-acp":
        raise ValidationError("runtime.kind must be standard-acp")
    install = runtime.get("install")
    launch = runtime.get("launch")
    if not isinstance(install, dict) or not isinstance(launch, dict):
        raise ValidationError("runtime.install and runtime.launch must be objects")
    reject_unknown_keys(install, {"runner", "args"}, "runtime.install")
    reject_unknown_keys(launch, {"executable", "args"}, "runtime.launch")
    runner = install.get("runner")
    if runner not in {"npm", "pnpm", "uv"}:
        raise ValidationError("runtime.install.runner must be npm, pnpm, or uv")
    args = require_string_array(
        install.get("args"), "runtime.install.args", non_empty=True
    )
    package_pattern = EXACT_UV_PACKAGE if runner == "uv" else EXACT_NPM_PACKAGE
    for index, arg in enumerate(args):
        validate_template_argument(arg, f"runtime.install.args[{index}]")
    packages = [arg for arg in args if package_pattern.fullmatch(arg)]
    if len(packages) != 1:
        syntax = "package==version" if runner == "uv" else "package@version"
        raise ValidationError(
            f"install args must contain exactly one exact {runner} {syntax}"
        )
    package = packages[0]
    expected_args = {
        "npm": ["install", "--prefix", "${installRoot}", package],
        "pnpm": ["add", "--dir", "${installRoot}", package],
        "uv": ["pip", "install", "--target", "${installRoot}", package],
    }[runner]
    if args != expected_args:
        raise ValidationError(
            f"runtime {runner} install args must be exactly: {' '.join(expected_args)}"
        )
    executable = require_string(launch.get("executable"), "runtime.launch.executable")
    if (
        not executable.startswith("${installRoot}/")
        or ".." in PurePosixPath(executable).parts
        or "\\" in executable
    ):
        raise ValidationError("launch executable must stay under ${installRoot}")
    validate_template_argument(executable, "runtime.launch.executable")
    launch_args = require_string_array(launch.get("args"), "runtime.launch.args")
    for index, arg in enumerate(launch_args):
        validate_template_argument(arg, f"runtime.launch.args[{index}]")


def validate_discovery_profile(profile: dict[str, Any]) -> None:
    reject_unknown_keys(profile, {"schemaVersion", "candidates"}, "discovery")
    candidates = profile.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        raise ValidationError("discovery.candidates must be a non-empty array")
    for index, candidate in enumerate(candidates):
        field = f"discovery.candidates[{index}]"
        if not isinstance(candidate, dict):
            raise ValidationError(f"{field} must be an object")
        reject_unknown_keys(
            candidate, {"binaryNames", "version", "launchArgs", "probe"}, field
        )
        binaries = require_string_array(
            candidate.get("binaryNames"), f"{field}.binaryNames", non_empty=True
        )
        if any(not BINARY_NAME.fullmatch(binary) for binary in binaries):
            raise ValidationError(
                f"{field}.binaryNames contains an invalid binary name"
            )
        version = candidate.get("version")
        if not isinstance(version, dict):
            raise ValidationError(f"{field}.version must be an object")
        reject_unknown_keys(version, {"args", "constraint"}, f"{field}.version")
        version_args = require_string_array(
            version.get("args"), f"{field}.version.args", non_empty=True
        )
        for arg_index, arg in enumerate(version_args):
            validate_template_argument(arg, f"{field}.version.args[{arg_index}]")
        require_string(version.get("constraint"), f"{field}.version.constraint")
        launch_args = require_string_array(
            candidate.get("launchArgs"), f"{field}.launchArgs"
        )
        for arg_index, arg in enumerate(launch_args):
            validate_template_argument(arg, f"{field}.launchArgs[{arg_index}]")
        probe = candidate.get("probe")
        if not isinstance(probe, dict) or probe.get("kind") != "acp-initialize":
            raise ValidationError(f"{field}.probe.kind must be acp-initialize")
        reject_unknown_keys(probe, {"kind", "timeoutMs"}, f"{field}.probe")
        timeout_ms = probe.get("timeoutMs")
        if not isinstance(timeout_ms, int) or not 100 <= timeout_ms <= 60_000:
            raise ValidationError(f"{field}.probe.timeoutMs must be 100..60000")


def validate_tools_profile(profile: dict[str, Any]) -> None:
    reject_unknown_keys(profile, {"schemaVersion", "tools"}, "tools")
    tools = profile.get("tools")
    if not isinstance(tools, list):
        raise ValidationError("tools.tools must be an array")
    for index, tool in enumerate(tools):
        field = f"tools.tools[{index}]"
        if not isinstance(tool, dict):
            raise ValidationError(f"{field} must be an object")
        reject_unknown_keys(tool, {"name", "aliases"}, field)
        require_string(tool.get("name"), f"{field}.name")
        if "aliases" in tool:
            require_string_array(tool["aliases"], f"{field}.aliases")


def validate_capabilities_profile(profile: dict[str, Any]) -> dict[str, bool]:
    reject_unknown_keys(profile, {"schemaVersion", "declared"}, "capabilities")
    declared = profile.get("declared")
    if not isinstance(declared, dict):
        raise ValidationError("capabilities.declared must be an object")
    if not all(
        isinstance(key, str) and isinstance(value, bool)
        for key, value in declared.items()
    ):
        raise ValidationError("capabilities.declared values must be booleans")
    reject_unknown_keys(declared, CAPABILITY_KEYS, "capabilities.declared")
    return declared


def validate_skill_root(root: Any, index: int) -> None:
    field = f"composer.skills.roots[{index}]"
    if not isinstance(root, dict):
        raise ValidationError(f"{field} must be an object")
    reject_unknown_keys(root, {"scope", "path"}, field)
    if root.get("scope") not in {"workspace", "user"}:
        raise ValidationError(f"{field}.scope must be workspace or user")
    require_safe_relative_path(root.get("path"), f"{field}.path")


def validate_composer_profile(profile: dict[str, Any]) -> tuple[bool, bool]:
    reject_unknown_keys(
        profile,
        {"schemaVersion", "model", "permission", "permissionModes", "skills"},
        "composer",
    )
    model = profile.get("model")
    if not isinstance(model, dict) or model.get("source") != "acp-session-models":
        raise ValidationError("composer.model.source must be acp-session-models")
    reject_unknown_keys(model, {"source"}, "composer.model")
    permission = profile.get("permission")
    if (
        not isinstance(permission, dict)
        or permission.get("source") != "acp-session-modes"
    ):
        raise ValidationError("composer.permission.source must be acp-session-modes")
    reject_unknown_keys(permission, {"source"}, "composer.permission")
    modes = profile.get("permissionModes")
    if not isinstance(modes, list):
        raise ValidationError("composer.permissionModes must be an array")
    runtime_ids: set[str] = set()
    for index, mode in enumerate(modes):
        field = f"composer.permissionModes[{index}]"
        if not isinstance(mode, dict):
            raise ValidationError(f"{field} must be an object")
        reject_unknown_keys(mode, {"runtimeId", "semantic"}, field)
        runtime_id = require_string(mode.get("runtimeId"), f"{field}.runtimeId").strip()
        if runtime_id in runtime_ids:
            raise ValidationError(f"{field}.runtimeId must be unique")
        runtime_ids.add(runtime_id)
        if mode.get("semantic") not in PERMISSION_SEMANTICS:
            raise ValidationError(f"{field}.semantic is unsupported")
    skills = profile.get("skills")
    if skills is None:
        return False, bool(modes)
    if not isinstance(skills, dict):
        raise ValidationError("composer.skills must be an object")
    reject_unknown_keys(
        skills, {"invocation", "triggerPrefix", "roots"}, "composer.skills"
    )
    if skills.get("invocation") != "textTrigger":
        raise ValidationError("composer.skills.invocation must be textTrigger")
    trigger = require_string(
        skills.get("triggerPrefix"), "composer.skills.triggerPrefix"
    )
    if any(character.isspace() for character in trigger) or len(trigger) > 8:
        raise ValidationError(
            "composer.skills.triggerPrefix must be a short non-space prefix"
        )
    roots = skills.get("roots")
    if not isinstance(roots, list) or not roots:
        raise ValidationError("composer.skills.roots must be a non-empty array")
    for index, root in enumerate(roots):
        validate_skill_root(root, index)
    return True, bool(modes)


def validate_profiles(profile_values: dict[str, dict[str, Any]]) -> None:
    validate_discovery_profile(profile_values["discovery"])
    validate_tools_profile(profile_values["tools"])
    capabilities = validate_capabilities_profile(profile_values["capabilities"])
    composer_has_skills, composer_has_permission_modes = validate_composer_profile(
        profile_values["composer"]
    )
    if bool(capabilities.get("skills")) != composer_has_skills:
        raise ValidationError(
            "capabilities.declared.skills must match the composer.skills declaration"
        )
    if bool(capabilities.get("permissionModes")) != composer_has_permission_modes:
        raise ValidationError(
            "capabilities.declared.permissionModes must match composer.permissionModes"
        )


def validate(root: Path) -> None:
    root = root.resolve()
    manifest_path = root / "tutti.agent.json"
    if not root.is_dir() or not manifest_path.is_file():
        raise ValidationError(f"package must contain tutti.agent.json: {root}")
    check_package_tree(root)
    manifest = read_json(manifest_path)
    reject_unknown_keys(manifest, MANIFEST_KEYS, "manifest")
    if manifest.get("schemaVersion") != MANIFEST_SCHEMA:
        raise ValidationError(f"schemaVersion must be {MANIFEST_SCHEMA}")
    require_string(manifest.get("agentKey"), "agentKey")
    version = require_string(manifest.get("version"), "version")
    if not SEMVER.fullmatch(version):
        raise ValidationError("version must be semantic versioning without a range")
    require_string(manifest.get("name"), "name")
    require_string(manifest.get("description"), "description")

    runtime = manifest.get("runtime")
    if not isinstance(runtime, dict):
        raise ValidationError("runtime must be an object")
    check_install(runtime)

    referenced_paths = {
        validate_presentation_asset(root, manifest.get("icon"), "icon"),
        validate_presentation_asset(root, manifest.get("heroImage"), "heroImage"),
    }
    if manifest.get("sidebarIcon") is not None:
        referenced_paths.add(
            validate_presentation_asset(
                root, manifest.get("sidebarIcon"), "sidebarIcon"
            )
        )

    profiles = manifest.get("profiles")
    if not isinstance(profiles, dict):
        raise ValidationError("profiles must be an object")
    reject_unknown_keys(profiles, set(PROFILE_SCHEMAS), "profiles")
    profile_values: dict[str, dict[str, Any]] = {}
    for profile_name, schema in PROFILE_SCHEMAS.items():
        profile_path = resolve_reference(
            root, profiles.get(profile_name), f"profiles.{profile_name}"
        )
        profile = read_json(profile_path)
        if profile.get("schemaVersion") != schema:
            raise ValidationError(f"profiles.{profile_name} must use {schema}")
        profile_values[profile_name] = profile
        referenced_paths.add(profile_path)
    validate_profiles(profile_values)

    localization = manifest.get("localizationInfo")
    if not isinstance(localization, dict):
        raise ValidationError("localizationInfo must be an object")
    reject_unknown_keys(
        localization,
        {"defaultLocale", "defaultFile", "additionalLocales"},
        "localizationInfo",
    )
    require_string(localization.get("defaultLocale"), "localizationInfo.defaultLocale")
    locale_files = [
        resolve_reference(
            root, localization.get("defaultFile"), "localizationInfo.defaultFile"
        )
    ]
    additional = localization.get("additionalLocales", [])
    if not isinstance(additional, list):
        raise ValidationError("localizationInfo.additionalLocales must be an array")
    for index, locale in enumerate(additional):
        if not isinstance(locale, dict):
            raise ValidationError(f"additionalLocales[{index}] must be an object")
        reject_unknown_keys(
            locale, {"locale", "file"}, f"additionalLocales[{index}]"
        )
        require_string(locale.get("locale"), f"additionalLocales[{index}].locale")
        locale_files.append(
            resolve_reference(
                root, locale.get("file"), f"additionalLocales[{index}].file"
            )
        )
    for locale_file in locale_files:
        referenced_paths.add(locale_file)
        locale = read_json(locale_file)
        require_string(locale.get("agent.name"), f"{locale_file.name}.agent.name")
        require_string(
            locale.get("agent.description"), f"{locale_file.name}.agent.description"
        )
    check_declared_files(root, referenced_paths)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "package", type=Path, help="Directory containing tutti.agent.json"
    )
    args = parser.parse_args()
    try:
        validate(args.package)
    except ValidationError as exc:
        print(f"validation failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"status": "ok", "package": os.fspath(args.package.resolve())}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
