"""Synthetic acceptance tests for offline assets; never archive the real bundle."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("archive_offline", HERE / "archive-offline.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
RESTORE = HERE.parent / "distribution/Restore-Offline.ps1"


def sha(data):
    return hashlib.sha256(data).hexdigest()


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="harnesshub-assets-test-")
        self.root = Path(self.temporary.name).resolve()
        self.bundle = self.root / "Synthetic Bundle 中文"
        self.bundle.mkdir()
        self.payload = {"dir 中文/a.txt": b"fixture\n", "binary.bin": bytes(range(256)) * 24, "empty.bin": b""}
        self.write_bundle()

    def tearDown(self):
        if os.name == "nt":
            self.assertEqual(self.root.parent, Path(tempfile.gettempdir()).resolve())
            self.assertTrue(self.root.name.startswith("harnesshub-assets-test-"))
            # This test exclusively owns the mkdtemp root; extended paths permit
            # cleanup of the intentionally >300-character regression fixtures.
            shutil.rmtree(MODULE.filesystem_path(self.root))
        self.temporary.cleanup()

    def write_bundle(self):
        for name, data in self.payload.items():
            target = MODULE.filesystem_path(self.bundle / name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        records = [{"path": name, "size": len(data), "sha256": sha(data)} for name, data in self.payload.items()]
        self.raw_manifest = json.dumps({"schemaVersion": 1, "platform": "win32", "arch": "arm64", "files": records}).encode()
        MODULE.filesystem_path(self.bundle / "bundle.json").write_bytes(self.raw_manifest)

    def assets(self, name="valid", split=False, secrets=()):
        archive = self.root / (name + ".zip")
        options = {"asset_limit": 512, "part_bytes": 256} if split else {}
        manifest = MODULE.create_assets(self.bundle, archive, quiet=True, secrets=secrets, **options)
        return archive.with_suffix(".offline.json"), manifest

    def test_single_and_split_assets_roundtrip_and_determinism(self):
        first, report = self.assets("first")
        second, _ = self.assets("second")
        self.assertEqual((self.root / "first.zip").read_bytes(), (self.root / "second.zip").read_bytes())
        result = MODULE.verify_assets(first, quiet=True)
        self.assertTrue(result["allZipFilesSizeAndSha256Verified"])
        split, report = self.assets("split", split=True)
        self.assertGreater(len(report["parts"]), 1)
        self.assertFalse((self.root / "split.zip").exists())
        self.assertTrue(all(part["bytes"] <= 256 for part in report["parts"]))
        self.assertEqual(MODULE.verify_assets(split, quiet=True)["zipSha256"], result["zipSha256"])

    def test_zip64_member_count_supported(self):
        previous = zipfile.ZIP_FILECOUNT_LIMIT
        zipfile.ZIP_FILECOUNT_LIMIT = 2
        try:
            manifest, _ = self.assets("zip64")
        finally:
            zipfile.ZIP_FILECOUNT_LIMIT = previous
        self.assertIn(b"PK\x06\x06", (self.root / "zip64.zip").read_bytes())
        MODULE.verify_assets(manifest, quiet=True)

    def test_windows_long_source_assets_and_temporary_paths(self):
        if os.name != "nt":
            self.skipTest("Extended Win32 path regression requires Windows")
        nesting = Path(*[("directory-" + str(index) + "-" + "x" * 65) for index in range(4)])
        self.bundle = self.root / "long-source" / nesting / "Source 中文"
        MODULE.filesystem_path(self.bundle).mkdir(parents=True)
        self.write_bundle()
        output = self.root / "long-assets" / nesting / "artifacts"
        MODULE.filesystem_path(output).mkdir(parents=True)
        self.assertGreater(len(str(self.bundle)), 300)
        self.assertGreater(len(str(output)), 300)
        manifest_path = output / "long.offline.json"
        MODULE.create_assets(self.bundle, output / "long.zip", quiet=True, asset_limit=512, part_bytes=256)
        result = MODULE.verify_assets(manifest_path, quiet=True)
        self.assertTrue(result["allZipFilesSizeAndSha256Verified"])
        self.assertGreater(result["parts"], 1)
        MODULE.filesystem_path(self.bundle / "binary.bin").write_bytes(b"z" * len(self.payload["binary.bin"]))
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            MODULE.create_assets(self.bundle, output / "corrupt.zip", quiet=True)
        self.assertFalse(MODULE.filesystem_path(output / "corrupt.offline.json").exists())
        self.assertFalse(list(MODULE.filesystem_path(output).glob(".offline-*-*")))

    def test_windows_path_prefix_rejects_relative_and_device_names(self):
        with self.assertRaisesRegex(ValueError, "explicit absolute"):
            MODULE.filesystem_path(Path("relative/file.zip"))
        if os.name != "nt":
            return
        normal = Path(r"C:\temp\fixture.zip")
        extended = MODULE.filesystem_path(normal)
        self.assertEqual(str(extended), r"\\?\C:\temp\fixture.zip")
        self.assertEqual(MODULE.filesystem_path(extended), extended)
        self.assertEqual(str(MODULE.filesystem_path(Path(r"\\server\share\fixture.zip"))), r"\\?\UNC\server\share\fixture.zip")
        for device in (r"\\.\C:\fixture.zip", r"\\?\GLOBALROOT\Device\HarddiskVolume1\fixture.zip"):
            with self.assertRaisesRegex(ValueError, "device path"):
                MODULE.filesystem_path(Path(device))

    def test_reject_source_extra_missing_and_hash_corruption(self):
        extra = self.bundle / "unlisted.txt"
        extra.write_text("extra")
        with self.assertRaisesRegex(ValueError, "Extra file"):
            self.assets("extra")
        extra.unlink()
        missing = self.bundle / "empty.bin"
        missing.unlink()
        with self.assertRaisesRegex(ValueError, "Missing inventoried"):
            self.assets("missing")
        missing.write_bytes(b"")
        (self.bundle / "binary.bin").write_bytes(b"z" * len(self.payload["binary.bin"]))
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            self.assets("changed")

    def test_reject_empty_state_and_sensitive_filename(self):
        state = self.bundle / "state"
        state.mkdir()
        with self.assertRaisesRegex(ValueError, "Mutable/incomplete"):
            self.assets("state")
        state.rmdir()
        self.payload["auth.json"] = b"{}"
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "Credential/state file"):
            self.assets("auth")

    def test_sdk_credentials_source_directory_is_allowed_and_secret_files_rejected(self):
        source = "engines/npm/node_modules/@anthropic-ai/sdk/src/lib/credentials/types.ts"
        self.payload[source] = b"export interface CredentialResult { token: string; }\n"
        self.write_bundle()
        manifest, _ = self.assets("sdk-source")
        self.assertTrue(MODULE.verify_assets(manifest, quiet=True)["allZipFilesSizeAndSha256Verified"])
        # A regular credentials file remains forbidden, even when listed with a
        # matching hash beside the legitimate SDK source directory.
        self.payload["configuration/credentials"] = b'{"api_key":"synthetic-private-token"}\n'
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "Credential/state file"):
            self.assets("credentials-file")
        del self.payload["configuration/credentials"]
        MODULE.filesystem_path(self.bundle / "configuration/credentials").unlink()
        # Allowing a source directory does not exempt content under it from the
        # explicit secret scan or exact bundle inventory/hash checks.
        secret = b"synthetic-company-auth-token"
        self.payload[source] = b'export const accidentalToken = "' + secret + b'";\n'
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "Credential material"):
            self.assets("sdk-secret", secrets=(secret,))

    def test_reject_private_key_and_explicit_secret_even_across_chunks(self):
        self.payload["leak.txt"] = b"-----BEGIN PRIVATE KEY-----\n" + b"A" * 64 + b"\n"
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "Credential material"):
            self.assets("private")
        secret = b"synthetic-private-api-token"
        self.payload["leak.txt"] = b"x" * (MODULE.CHUNK - 6) + secret
        self.write_bundle()
        with self.assertRaisesRegex(ValueError, "Credential material"):
            self.assets("secret", secrets=(secret,))

    def public_pem_fixture(self):
        name = "bin/git/usr/bin/msys-gnutls-30.dll"
        data = (b"synthetic-public-fixture-marker\n-----BEGIN PRIVATE KEY-----\n"
                + b"A" * 64 + b"\n-----END PRIVATE KEY-----\n")
        self.payload[name] = data
        self.write_bundle()
        return name, data

    def test_exact_reviewed_public_pem_create_and_verify(self):
        name, data = self.public_pem_fixture()
        # Synthetic review is process-local test injection, never a CLI option or
        # a production allowlist entry. Exercise source and ZIP-member reads.
        with mock.patch.dict(MODULE.REVIEWED_PUBLIC_PEM_FILES, {name: sha(data)}, clear=True):
            manifest, _ = self.assets("reviewed-public")
            self.assertTrue(MODULE.verify_assets(manifest, quiet=True)["allZipFilesSizeAndSha256Verified"])
        with self.assertRaisesRegex(ValueError, "Credential material"):
            MODULE.verify_assets(manifest, quiet=True)

    def test_reviewed_public_pem_rejects_one_changed_byte_even_with_updated_inventory(self):
        name, data = self.public_pem_fixture()
        changed = b"X" + data[1:]
        with mock.patch.dict(MODULE.REVIEWED_PUBLIC_PEM_FILES, {name: sha(data)}, clear=True):
            self.payload[name] = changed
            self.write_bundle()
            with self.assertRaisesRegex(ValueError, "exact reviewed public file"):
                self.assets("changed-public")
            # Construct a self-consistent hostile archive, then restore the real
            # review policy before verification: updated inventory/asset hashes
            # cannot authorize altered private-key-bearing bytes.
            with mock.patch.dict(MODULE.REVIEWED_PUBLIC_PEM_FILES, {name: sha(changed)}):
                manifest, _ = self.assets("changed-reviewed-fixture")
            with self.assertRaisesRegex(ValueError, "exact reviewed public file"):
                MODULE.verify_assets(manifest, quiet=True)

    def test_reviewed_public_pem_rejects_same_bytes_at_other_path(self):
        name, data = self.public_pem_fixture()
        other = "elsewhere/msys-gnutls-30.dll"
        del self.payload[name]
        MODULE.filesystem_path(self.bundle / name).unlink()
        self.payload[other] = data
        self.write_bundle()
        with mock.patch.dict(MODULE.REVIEWED_PUBLIC_PEM_FILES, {name: sha(data)}, clear=True):
            with self.assertRaisesRegex(ValueError, "Credential material"):
                self.assets("moved-public")
            with mock.patch.dict(MODULE.REVIEWED_PUBLIC_PEM_FILES, {other: sha(data)}):
                manifest, _ = self.assets("moved-reviewed-fixture")
            with self.assertRaisesRegex(ValueError, "Credential material"):
                MODULE.verify_assets(manifest, quiet=True)

    def test_reviewed_public_pem_never_exempts_explicit_secret(self):
        name, data = self.public_pem_fixture()
        secret = b"synthetic-public-fixture-marker"
        with mock.patch.dict(MODULE.REVIEWED_PUBLIC_PEM_FILES, {name: sha(data)}, clear=True):
            manifest, _ = self.assets("reviewed-no-secret")
            with self.assertRaisesRegex(ValueError, "Credential material"):
                self.assets("reviewed-secret", secrets=(secret,))
            with self.assertRaisesRegex(ValueError, "Credential material"):
                MODULE.verify_assets(manifest, quiet=True, secrets=(secret,))

    def test_reject_link_directory(self):
        target = self.root / "external"
        target.mkdir()
        link = self.bundle / "linked"
        if os.name == "nt":
            result = subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(link), str(target)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            link.symlink_to(target, target_is_directory=True)
        try:
            with self.assertRaisesRegex(ValueError, "Link/reparse"):
                self.assets("linked")
        finally:
            if os.name == "nt":
                os.rmdir(link)
            else:
                link.unlink()

    def test_reject_part_missing_extra_corruption_and_order(self):
        manifest, data = self.assets(split=True)
        first = self.root / data["parts"][0]["file"]
        original = first.read_bytes()
        first.unlink()
        with self.assertRaises(FileNotFoundError):
            MODULE.verify_assets(manifest, quiet=True)
        first.write_bytes(original)
        extra = self.root / "valid.zip.part999"
        extra.write_bytes(b"extra")
        with self.assertRaisesRegex(ValueError, "Unexpected archive part"):
            MODULE.verify_assets(manifest, quiet=True)
        extra.unlink()
        first.write_bytes(bytes([original[0] ^ 1]) + original[1:])
        with self.assertRaisesRegex(ValueError, "part SHA256 mismatch"):
            MODULE.verify_assets(manifest, quiet=True)
        first.write_bytes(original)
        data["parts"].reverse()
        manifest.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "order/name mismatch"):
            MODULE.verify_assets(manifest, quiet=True)

    def test_reject_existing_output_without_modifying_it(self):
        self.assets()
        original = (self.root / "valid.zip").read_bytes()
        with self.assertRaisesRegex(ValueError, "overwrite is prohibited"):
            self.assets()
        self.assertEqual((self.root / "valid.zip").read_bytes(), original)

    def test_zip_payload_verified_after_asset_hash(self):
        manifest, data = self.assets()
        archive = self.root / "valid.zip"
        replacement = self.root / "changed.zip"
        with zipfile.ZipFile(archive) as original, zipfile.ZipFile(replacement, "w", allowZip64=True) as changed:
            for entry in original.infolist():
                content = original.read(entry)
                if entry.filename.endswith("binary.bin"):
                    content = b"z" * len(content)
                changed.writestr(entry, content)
        archive.write_bytes(replacement.read_bytes())
        data["zipBytes"] = archive.stat().st_size
        data["zipSha256"] = sha(archive.read_bytes())
        data["parts"][0].update(bytes=data["zipBytes"], sha256=data["zipSha256"])
        manifest.write_text(json.dumps(data))
        with self.assertRaisesRegex(ValueError, "ZIP SHA-256 mismatch"):
            MODULE.verify_assets(manifest, quiet=True)

    def test_cli_failure_exits_nonzero(self):
        manifest, data = self.assets()
        data["zipSha256"] = "0" * 64
        manifest.write_text(json.dumps(data))
        result = subprocess.run([sys.executable, "-I", "-B", str(HERE / "archive-offline.py"), "verify", "--manifest", str(manifest)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Reassembled archive SHA256 differs", result.stderr)

    def test_windows_restore_validates_parts_and_members_and_preserves_targets(self):
        if os.name != "nt":
            self.skipTest("Windows PowerShell acceptance requires Windows")
        shell = Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        self.assertTrue(shell.is_file(), "Windows PowerShell is required, not silently skipped")
        # Restore hashes ZIP members as streams: long internal paths are never
        # passed to a Windows filesystem API or extracted by this script.
        member = "/".join(["long-member-" + "q" * 65] * 4) + "/read.txt"
        self.assertGreater(len(member), 300)
        self.payload[member] = b"long member verified without extraction\n"
        self.write_bundle()
        manifest, data = self.assets(split=True)
        destination = self.root / "restored.zip"

        def restore(output=destination):
            return subprocess.run([str(shell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(RESTORE), "-Manifest", str(manifest), "-OutputZip", str(output)], capture_output=True, text=True, encoding="utf-8", errors="replace")

        result = restore()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        original = destination.read_bytes()
        self.assertEqual(sha(original), data["zipSha256"])
        self.assertNotEqual(restore().returncode, 0)
        self.assertEqual(destination.read_bytes(), original)
        part = self.root / data["parts"][0]["file"]
        previous = part.read_bytes()
        part.unlink()
        self.assertNotEqual(restore(self.root / "missing-part.zip").returncode, 0)
        part.write_bytes(previous)
        extra = self.root / "valid.zip.part999"
        extra.write_bytes(b"extra")
        self.assertNotEqual(restore(self.root / "extra-part.zip").returncode, 0)
        extra.unlink()
        part.write_bytes(bytes([previous[0] ^ 1]) + previous[1:])
        self.assertNotEqual(restore(self.root / "bad.zip").returncode, 0)
        self.assertFalse((self.root / "bad.zip").exists())
        part.write_bytes(previous)
        data["parts"].reverse()
        manifest.write_text(json.dumps(data))
        self.assertNotEqual(restore(self.root / "wrong-order.zip").returncode, 0)
        self.assertFalse((self.root / "wrong-order.zip").exists())
        changed = self.root / "changed-member.zip"
        with zipfile.ZipFile(destination) as source, zipfile.ZipFile(changed, "w", allowZip64=True) as output:
            for entry in source.infolist():
                content = source.read(entry)
                if entry.filename.endswith("binary.bin"):
                    content = b"z" * len(content)
                output.writestr(entry, content)
        content = changed.read_bytes()
        data.update(zipName=changed.name, zipBytes=len(content), zipSha256=sha(content), parts=[{"index": 1, "file": changed.name, "bytes": len(content), "sha256": sha(content)}])
        manifest.write_text(json.dumps(data))
        result = restore(self.root / "wrong-member.zip")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ZIP member SHA256 mismatch", result.stderr)
        self.assertFalse((self.root / "wrong-member.zip").exists())
        self.assertFalse(list(self.root.glob("*.incomplete")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
