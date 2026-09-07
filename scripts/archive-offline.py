"""Create and verify a frozen HarnessHub release ZIP; Python standard library only."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
import unicodedata
import uuid
import zipfile
from datetime import datetime, timezone


CHUNK = 1024 * 1024
MANIFEST_LIMIT = 64 * 1024 * 1024
ASSET_LIMIT = 2 * 1024 * 1024 * 1024
PART_BYTES = 1932735283  # floor(1.8 GiB), below the GitHub single-asset limit.
PRIVATE_KEY = re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/]{30,}")
# Public GnuTLS self-test keys, verified against 3.8.13 commit
# b390d80208ed60f1b33ad899475951a8efb40ccd, lib/crypto-selftests-pk.c.
# Exact byte/path review only; provenance and block comparison are documented in
# docs/offline-artifacts.md. Explicit secret values never receive this exception.
REVIEWED_PUBLIC_PEM_FILES = {
    "bin/git/usr/bin/msys-gnutls-30.dll": "5f3019ca853a642a5d26b81661040f295cc11cfc588a43500fbcb2fbee7cc444",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def filesystem_path(value):
    """Use Win32 extended absolute paths locally; never change machine policy.

    Inventory and ZIP member names stay portable relative names. Only filesystem
    operations receive the extended prefix, including temporary output paths.
    Device namespaces other than an absolute drive or UNC share are rejected.
    """
    value = Path(value)
    require(value.is_absolute(), "Filesystem paths must be explicit absolute paths")
    if os.name != "nt":
        return value
    raw = os.path.normpath(str(value))
    if raw.startswith("\\\\?\\UNC\\"):
        suffix = raw[8:]
        require(len(suffix.split("\\")) >= 2 and all(suffix.split("\\")[:2]), "Invalid extended UNC path")
        return Path("\\\\?\\UNC\\" + suffix)
    if raw.startswith("\\\\?\\"):
        require(re.match(r"^[A-Za-z]:\\", raw[4:]) is not None, "Unsupported Windows device path")
        return Path(raw)
    require(not raw.startswith("\\\\.\\"), "Unsupported Windows device path")
    if raw.startswith("\\\\"):
        suffix = raw[2:]
        require(len(suffix.split("\\")) >= 2 and all(suffix.split("\\")[:2]), "Invalid UNC path")
        return Path("\\\\?\\UNC\\" + suffix)
    require(re.match(r"^[A-Za-z]:\\", raw) is not None, "Expected an absolute Windows drive path")
    return Path("\\\\?\\" + raw)


def identity(name):
    return unicodedata.normalize("NFC", name).casefold()


def relative_name(value, *, directory=False):
    require(isinstance(value, str) and value, "Inventory path must be a nonempty string")
    name = value.replace("\\", "/")
    parts = name.split("/")
    require(not name.startswith("/") and all(part not in ("", ".", "..") for part in parts),
            f"Unsafe inventory path: {value}")
    require(not any(":" in part or "\x00" in part or part.endswith((".", " ")) for part in parts),
            f"Unsupported Windows inventory path: {value}")
    require(identity(parts[0]) not in ("state", ".incomplete"), f"Mutable/incomplete payload: {value}")
    lowered = [identity(part) for part in parts]
    require(not any(part in (".git", ".ssh", ".aws", ".azure", ".gnupg") for part in lowered), f"Private configuration directory: {value}")
    if not directory:
        require(lowered[-1] not in ("auth.json", "credentials.json", "credentials", ".npmrc", ".pypirc", "id_rsa", "id_ed25519")
                and not re.search(r"(?:^\.env(?:\.|$)|\.(?:dpapi|sqlite(?:-wal|-shm)?|p12|pfx)$)", lowered[-1]), f"Credential/state file: {value}")
    return name


def regular_stat(path, directory=False):
    path = filesystem_path(path)
    info = path.lstat()
    require(not stat.S_ISLNK(info.st_mode) and not (getattr(info, "st_file_attributes", 0) & 0x400),
            f"Link/reparse point is not a release file: {path}")
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode),
            f"Unexpected filesystem entry type: {path}")
    return info


def signature(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def digest_stream(stream, destination=None, secrets=(), *, payload_name=None):
    digest = hashlib.sha256()
    size = 0
    tail = b""
    private_material = False
    reviewed_hash = REVIEWED_PUBLIC_PEM_FILES.get(payload_name)
    overlap = max([2048] + [len(secret) for secret in secrets])
    while chunk := stream.read(CHUNK):
        sample = tail + chunk
        require(not any(secret in sample for secret in secrets), "Credential material detected in payload; value omitted")
        if PRIVATE_KEY.search(sample) is not None:
            private_material = True
            require(reviewed_hash is not None, "Credential material detected in payload; value omitted")
        tail = sample[-overlap:]
        digest.update(chunk)
        size += len(chunk)
        if destination is not None:
            destination.write(chunk)
    actual_hash = digest.hexdigest()
    require(not private_material or actual_hash == reviewed_hash,
            "Credential material detected outside the exact reviewed public file; value omitted")
    return size, actual_hash


class Progress:
    def __init__(self, enabled=True):
        self.enabled = enabled
        self.last = 0.0

    def emit(self, stage, count=0, total=0, force=False):
        now = time.monotonic()
        if self.enabled and (force or now - self.last >= 10):
            print(json.dumps({"stage": stage, "files": count, "total": total}), flush=True)
            self.last = now


def parse_inventory(manifest_bytes):
    require(len(manifest_bytes) <= MANIFEST_LIMIT, "Oversized bundle.json")
    manifest = json.loads(manifest_bytes)
    require(isinstance(manifest, dict) and manifest.get("schemaVersion") == 1
            and manifest.get("platform") == "win32" and manifest.get("arch") in ("arm64", "x64"),
            "Unsupported bundle manifest")
    entries = manifest.get("files")
    require(isinstance(entries, list) and entries, "Empty or invalid bundle inventory")
    inventory = {}
    seen = {identity("bundle.json")}
    for entry in entries:
        require(isinstance(entry, dict) and set(entry) == {"path", "size", "sha256"}, "Invalid inventory entry")
        name = relative_name(entry["path"])
        require(identity(name) not in seen, f"Duplicate inventory path: {name}")
        require(type(entry["size"]) is int and 0 <= entry["size"] <= (1 << 53) - 1, f"Invalid size: {name}")
        require(isinstance(entry["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", entry["sha256"]), f"Invalid SHA-256: {name}")
        seen.add(identity(name))
        inventory[name] = {"size": entry["size"], "sha256": entry["sha256"]}
    inventory["bundle.json"] = {"size": len(manifest_bytes), "sha256": hashlib.sha256(manifest_bytes).hexdigest()}
    return inventory, manifest_bytes


def read_inventory(bundle):
    require(bundle.is_absolute(), "--bundle must be an explicit absolute path")
    bundle = filesystem_path(bundle)
    regular_stat(bundle, directory=True)
    manifest_path = bundle / "bundle.json"
    require(regular_stat(manifest_path).st_size <= MANIFEST_LIMIT, "Oversized bundle.json")
    return parse_inventory(manifest_path.read_bytes())


def audit_directory(bundle, inventory, progress, hashes=True, secrets=()):
    bundle = filesystem_path(bundle)
    actual = {}
    directories = [bundle]
    empty_directories = 0
    while directories:
        directory = directories.pop()
        regular_stat(directory, directory=True)
        children = list(directory.iterdir())
        if not children:
            empty_directories += 1
        for file in children:
            relative = file.relative_to(bundle).as_posix()
            info = file.lstat()
            relative_name(relative, directory=stat.S_ISDIR(info.st_mode))
            require(not stat.S_ISLNK(info.st_mode) and not (getattr(info, "st_file_attributes", 0) & 0x400),
                    f"Link/reparse point in payload: {relative}")
            if stat.S_ISDIR(info.st_mode):
                directories.append(file)
            else:
                regular_stat(file)
                require(relative in inventory, f"Extra file absent from bundle.json: {relative}")
                require(identity(relative) not in actual, f"Duplicate on-disk path: {relative}")
                actual[identity(relative)] = relative
    missing = set(inventory) - set(actual.values())
    require(not missing, f"Missing inventoried files: {sorted(missing)[:5]}")
    total = sum(item["size"] for item in inventory.values())
    if hashes:
        progress.emit("verify-source", total=len(inventory), force=True)
        for index, (relative, expected) in enumerate(inventory.items(), 1):
            file = bundle / relative
            before = regular_stat(file)
            require(before.st_size == expected["size"], f"Source size mismatch: {relative}")
            with file.open("rb") as stream:
                actual_size, actual_hash = digest_stream(stream, secrets=secrets, payload_name=relative)
            require(signature(before) == signature(regular_stat(file)), f"Source changed while hashing: {relative}")
            require((actual_size, actual_hash) == (expected["size"], expected["sha256"]), f"Source SHA-256 mismatch: {relative}")
            progress.emit("verify-source", index, len(inventory))
    return {"fileCount": len(inventory), "uncompressedBytes": total, "emptyDirectoriesOmitted": empty_directories}


def zip_info(name, size=0, directory=False):
    info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
    info.create_system = 0
    info.external_attr = 0x10 if directory else 0x20
    info.compress_type = zipfile.ZIP_STORED if directory else zipfile.ZIP_DEFLATED
    info.file_size = size
    return info


def verify_archive(archive_path, inventory, manifest_bytes, root_name, progress, secrets=()):
    archive_path = filesystem_path(archive_path)
    expected = {root_name + "/" + name: value for name, value in inventory.items()}
    expected_names = set(expected) | {root_name + "/"}
    progress.emit("verify-zip", total=len(inventory), force=True)
    with zipfile.ZipFile(archive_path, "r", allowZip64=True) as archive:
        members = archive.infolist()
        names = [member.filename for member in members]
        require(len(names) == len(set(names)), "Duplicate ZIP members")
        require(len(names) == len({identity(name) for name in names}), "Case/Unicode collision in ZIP members")
        require(set(names) == expected_names, "ZIP member set differs from bundle.json/root directory")
        root = archive.getinfo(root_name + "/")
        require(root.is_dir() and root.file_size == 0, "ZIP root directory missing or invalid")
        for index, (name, expected_file) in enumerate(expected.items(), 1):
            member = archive.getinfo(name)
            require(not member.is_dir() and not (member.flag_bits & 1), f"Unexpected/encrypted ZIP entry: {name}")
            require(not stat.S_ISLNK(member.external_attr >> 16), f"ZIP symlink: {name}")
            require(member.file_size == expected_file["size"], f"ZIP size mismatch: {name}")
            with archive.open(member, "r") as stream:
                size, digest = digest_stream(stream, secrets=secrets, payload_name=name[len(root_name) + 1:])
            require((size, digest) == (expected_file["size"], expected_file["sha256"]), f"ZIP SHA-256 mismatch: {name}")
            progress.emit("verify-zip", index, len(inventory))
        require(archive.read(root_name + "/bundle.json") == manifest_bytes, "ZIP bundle.json differs from source manifest")
        return {"archiveMemberCount": len(members), "zip64EntryCount": sum(member.extract_version >= 45 for member in members)}


def create_archive(bundle, destination, quiet=False, secrets=()):
    bundle = filesystem_path(bundle)
    destination = filesystem_path(destination)
    started = time.monotonic()
    progress = Progress(not quiet)
    require(destination.is_absolute() and destination.suffix.lower() == ".zip", "--zip must be an explicit absolute .zip path")
    regular_stat(destination.parent, directory=True)
    require(not destination.resolve().is_relative_to(bundle.resolve()), "ZIP output must be outside the bundle")
    report_path = destination.with_suffix(".verification.json")
    require(not destination.exists() and not report_path.exists(), "ZIP/report output already exists; overwrite is prohibited")
    root_name = relative_name(bundle.name, directory=True)
    require("/" not in root_name, "Invalid ZIP root name")
    inventory, manifest_bytes = read_inventory(bundle)
    source = audit_directory(bundle, inventory, progress, secrets=secrets)
    token = uuid.uuid4().hex
    temporary = destination.parent / ("." + destination.name + "." + token + ".incomplete")
    temporary_report = destination.parent / ("." + report_path.name + "." + token + ".incomplete")
    try:
        progress.emit("create-zip", total=len(inventory), force=True)
        with zipfile.ZipFile(temporary, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as archive:
            archive.writestr(zip_info(root_name + "/", directory=True), b"")
            for index, (relative, expected) in enumerate(sorted(inventory.items()), 1):
                file = bundle / relative
                before = regular_stat(file)
                require(before.st_size == expected["size"], f"Source changed before ZIP write: {relative}")
                info = zip_info(root_name + "/" + relative, expected["size"])
                info._compresslevel = 1
                with file.open("rb") as source_file, archive.open(info, "w", force_zip64=True) as target:
                    size, digest = digest_stream(source_file, target, secrets=secrets, payload_name=relative)
                require(signature(before) == signature(regular_stat(file)), f"Source changed during ZIP write: {relative}")
                require((size, digest) == (expected["size"], expected["sha256"]), f"Source changed/hash mismatch during ZIP write: {relative}")
                progress.emit("create-zip", index, len(inventory))
        audit_directory(bundle, inventory, progress, hashes=False)
        verified = verify_archive(temporary, inventory, manifest_bytes, root_name, progress, secrets=secrets)
        progress.emit("hash-zip", force=True)
        with temporary.open("rb") as stream:
            zip_bytes, zip_hash = digest_stream(stream)
        audit_directory(bundle, inventory, progress, hashes=False)
        report = {"schemaVersion": 1, "verifiedAt": datetime.now(timezone.utc).isoformat(),
                  "zipName": destination.name, "bundleRootName": root_name, "zipBytes": zip_bytes,
                  "zipSha256": zip_hash, "manifestSha256": inventory["bundle.json"]["sha256"],
                  "inventoryFileCount": len(inventory) - 1, **source, **verified,
                  "sourceInventoryExact": True, "zipInventoryExact": True, "allZipFilesSizeAndSha256Verified": True,
                  "stateIncluded": False, "incompleteIncluded": False, "zip64Enabled": True,
                  "compression": "deflate level 1", "elapsedSeconds": round(time.monotonic() - started, 3)}
        with temporary_report.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        # Hard-link publication is atomic and fails if another process created the target.
        # Both temporary files are siblings on the same volume; unlink removes only our temporary names.
        os.link(temporary, destination)
        os.link(temporary_report, report_path)
        progress.emit("verified", len(inventory), len(inventory), force=True)
        return report
    finally:
        for owned_file in (temporary, temporary_report):
            if owned_file.exists():
                owned_file.unlink()


def load_assets(manifest_path):
    require(manifest_path.is_absolute(), "--manifest must be an explicit absolute path")
    manifest_path = filesystem_path(manifest_path)
    regular_stat(manifest_path.parent, directory=True)
    require(regular_stat(manifest_path).st_size <= MANIFEST_LIMIT, "Oversized asset manifest")
    manifest = json.loads(manifest_path.read_bytes())
    require(isinstance(manifest, dict) and manifest.get("schemaVersion") == 1, "Unsupported asset manifest")
    for field in ("zipName", "bundleRootName"):
        require(relative_name(manifest.get(field), directory=field == "bundleRootName") == manifest[field] and "/" not in manifest[field], f"Invalid {field}")
    require(manifest["zipName"].endswith(".zip"), "Archive name must end in .zip")
    for field in ("zipSha256", "bundleManifestSha256"):
        require(isinstance(manifest.get(field), str) and re.fullmatch(r"[a-f0-9]{64}", manifest[field]), f"Invalid {field}")
    require(type(manifest.get("zipBytes")) is int and manifest["zipBytes"] > 0, "Invalid archive size")
    parts = manifest.get("parts")
    require(isinstance(parts, list) and parts, "No archive parts")
    total = 0
    for index, part in enumerate(parts, 1):
        expected = manifest["zipName"] if len(parts) == 1 else f"{manifest['zipName']}.part{index:03}"
        require(isinstance(part, dict) and set(part) == {"index", "file", "bytes", "sha256"}, "Invalid archive part")
        require(part["index"] == index and part["file"] == expected, "Archive part order/name mismatch")
        require(type(part["bytes"]) is int and 0 < part["bytes"] < ASSET_LIMIT and (len(parts) == 1 or part["bytes"] <= PART_BYTES), "Archive part exceeds asset limit")
        require(isinstance(part["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", part["sha256"]), "Invalid part SHA256")
        total += part["bytes"]
    require(total == manifest["zipBytes"], "Archive part size total differs")
    expected_names = {part["file"] for part in parts}
    for file in manifest_path.parent.iterdir():
        if identity(file.name).startswith(identity(manifest["zipName"] + ".part")):
            require(file.name in expected_names, f"Unexpected archive part: {file.name}")
    return manifest


def verify_zip_payload(archive_path, manifest, progress, secrets=()):
    archive_path = filesystem_path(archive_path)
    with zipfile.ZipFile(archive_path, "r", allowZip64=True) as archive:
        member = archive.getinfo(manifest["bundleRootName"] + "/bundle.json")
        require(member.file_size <= MANIFEST_LIMIT, "Oversized archived bundle.json")
        raw = archive.read(member)
    require(hashlib.sha256(raw).hexdigest() == manifest["bundleManifestSha256"], "Archived bundle manifest SHA256 differs")
    inventory, raw = parse_inventory(raw)
    return verify_archive(archive_path, inventory, raw, manifest["bundleRootName"], progress, secrets=secrets)


def verify_assets(manifest_path, quiet=False, secrets=()):
    manifest_path = filesystem_path(manifest_path)
    manifest = load_assets(manifest_path)
    progress = Progress(not quiet)
    # The private temporary directory owns only this verification's assembled ZIP.
    with tempfile.TemporaryDirectory(prefix=".offline-verify-", dir=manifest_path.parent) as temporary:
        assembled = Path(temporary) / manifest["zipName"]
        combined = hashlib.sha256()
        combined_size = 0
        with assembled.open("xb") as target:
            for part in manifest["parts"]:
                file = manifest_path.parent / part["file"]
                before = regular_stat(file)
                require(before.st_size == part["bytes"], f"Archive part size mismatch: {part['file']}")
                digest = hashlib.sha256()
                size = 0
                with file.open("rb") as source:
                    while chunk := source.read(CHUNK):
                        digest.update(chunk)
                        combined.update(chunk)
                        target.write(chunk)
                        size += len(chunk)
                require(signature(before) == signature(regular_stat(file)), "Archive part changed while reading")
                require(size == part["bytes"] and digest.hexdigest() == part["sha256"], f"Archive part SHA256 mismatch: {part['file']}")
                combined_size += size
                progress.emit("verify-part", part["index"], len(manifest["parts"]), force=True)
        require(combined_size == manifest["zipBytes"] and combined.hexdigest() == manifest["zipSha256"], "Reassembled archive SHA256 differs")
        result = verify_zip_payload(assembled, manifest, progress, secrets=secrets)
    return {"schemaVersion": 1, "zipName": manifest["zipName"], "zipBytes": combined_size,
            "zipSha256": combined.hexdigest(), "parts": len(manifest["parts"]), **result,
            "allZipFilesSizeAndSha256Verified": True, "networkUsed": False}


def create_assets(bundle, destination, quiet=False, secrets=(), asset_limit=ASSET_LIMIT, part_bytes=PART_BYTES):
    bundle = filesystem_path(bundle)
    destination = filesystem_path(destination)
    require(destination.is_absolute() and destination.suffix.lower() == ".zip", "--zip must be an explicit absolute .zip path")
    regular_stat(destination.parent, directory=True)
    require(not destination.resolve().is_relative_to(bundle.resolve()), "Asset output must be outside the bundle")
    manifest_path = destination.with_suffix(".offline.json")
    require(not os.path.lexists(destination) and not os.path.lexists(manifest_path), "Archive/manifest target already exists; overwrite is prohibited")
    require(not any(destination.parent.glob(destination.name + ".part*")), "Archive parts already exist; overwrite is prohibited")
    require(64 <= part_bytes < asset_limit <= ASSET_LIMIT, "Invalid asset size boundaries")
    with tempfile.TemporaryDirectory(prefix=".offline-build-", dir=destination.parent) as temporary:
        stage = Path(temporary)
        (stage / "build").mkdir()
        (stage / "assets").mkdir()
        archive = stage / "build" / destination.name
        report = create_archive(bundle, archive, quiet=quiet, secrets=secrets)
        parts = []
        if report["zipBytes"] < asset_limit:
            target = stage / "assets" / destination.name
            os.link(archive, target)
            parts.append({"index": 1, "file": destination.name, "bytes": report["zipBytes"], "sha256": report["zipSha256"]})
        else:
            with archive.open("rb") as source:
                index = 1
                while source.tell() < report["zipBytes"]:
                    name = f"{destination.name}.part{index:03}"
                    target = stage / "assets" / name
                    digest = hashlib.sha256()
                    size = 0
                    with target.open("xb") as output:
                        while size < part_bytes and (chunk := source.read(min(CHUNK, part_bytes - size))):
                            digest.update(chunk)
                            size += len(chunk)
                            output.write(chunk)
                    parts.append({"index": index, "file": name, "bytes": size, "sha256": digest.hexdigest()})
                    index += 1
        manifest = {"schemaVersion": 1, "zipName": destination.name, "bundleRootName": bundle.name,
                    "zipBytes": report["zipBytes"], "zipSha256": report["zipSha256"],
                    "bundleManifestSha256": report["manifestSha256"], "parts": parts,
                    "verification": report, "secretEnvironmentValuesChecked": len(secrets) // 2}
        staged_manifest = stage / "assets" / manifest_path.name
        staged_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        # Re-read the final assets, reconstruct their ZIP and hash every ZIP member.
        verify_assets(staged_manifest, quiet=quiet, secrets=secrets)
        for part in parts:
            os.link(stage / "assets" / part["file"], destination.parent / part["file"])
        # Manifest is the completion marker and is published last, without replacement.
        os.link(staged_manifest, manifest_path)
    return manifest


def main():
    parser = argparse.ArgumentParser(description="Create/verify offline HarnessHub release assets; no downloads or installs.")
    parser.add_argument("action", choices=("create", "verify"))
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--zip", dest="archive", type=Path)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--secret-env", action="append", default=[], metavar="NAME", help="Reject exact UTF-8/UTF-16LE value of an existing secret environment variable; value is never logged")
    options = parser.parse_args()
    try:
        secrets = []
        for name in options.secret_env:
            require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name), "Invalid secret environment variable name")
            value = os.environ.get(name)
            require(isinstance(value, str) and len(value) >= 8, f"Secret environment variable is missing/too short: {name}")
            secrets.extend((value.encode("utf-8"), value.encode("utf-16-le")))
        if options.action == "create":
            require(options.bundle is not None and options.archive is not None, "--bundle and --zip are required")
            result = create_assets(options.bundle, options.archive, secrets=tuple(secrets))
        else:
            require(options.manifest is not None, "--manifest is required")
            result = verify_assets(options.manifest, secrets=tuple(secrets))
        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    except (ValueError, OSError, KeyError, zipfile.BadZipFile) as error:
        print(f"Offline archive validation failed: {error}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
