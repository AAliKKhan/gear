"""Installed standalone authority interoperates with unchanged legacy training records."""
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from gear.training.runtime.device_lease import NodeDeviceLedger as LegacyLedger
from gear.training.runtime.job import device_ledger
from gear.training.runtime.node_generation import record_generation
from gear.training.storage.content import atomic_json

AVAILABLE = importlib.util.find_spec("hitch_inference") is not None


class StandaloneDeviceLeaseTests(unittest.TestCase):
    @unittest.skipUnless(AVAILABLE, "install the standalone hitch-inference wheel for interoperability")
    def test_one_installed_authority_and_shared_legacy_handoff(self):
        from hitch_inference.device_lease import NodeDeviceLedger

        with tempfile.TemporaryDirectory() as root:
            node = {"nodeId": "shared-node", "generation": "boot-1"}
            identity = {**node, "bootIdentity": "os-boot-1"}
            atomic_json(Path(root) / "identity.json", identity)
            record_generation(root, identity)
            old = LegacyLedger(root, node)
            neutral = device_ledger({"nodeRoot": root, "node": node, "deviceLeaseRuntime": "standalone-v1"})
            self.assertIsInstance(neutral, NodeDeviceLedger)
            self.assertIsInstance(device_ledger({"nodeRoot": root, "node": node}), LegacyLedger)
            with patch("gear.training.runtime.device_lease.gpu_processes", return_value=[]), patch("hitch_inference.device_lease.gpu_processes", return_value=[]):
                old.acquire("training/legacy-job", ["GPU-1"])
                with self.assertRaises(ValueError):
                    neutral.acquire("inference/new", ["GPU-1"])
                neutral.acquire("inference/disjoint", ["GPU-2", "GPU-3"])
                self.assertEqual(old.inspect("inference/disjoint")["devices"], ["GPU-2", "GPU-3"])
                self.assertEqual(neutral.inspect("training/legacy-job")["devices"], ["GPU-1"])
                old.fence("training/legacy-job")
                self.assertTrue(neutral.release("training/legacy-job"))
                neutral.acquire("inference/handoff", ["GPU-1"])
                neutral.fence("inference/handoff")
                self.assertTrue(old.release("inference/handoff"))
                self.assertEqual(old.path, neutral.path)

    def test_unknown_authority_fails_clearly(self):
        with self.assertRaisesRegex(ValueError, "unknown device lease runtime"):
            device_ledger({"nodeRoot": "/unused", "node": {"nodeId": "node", "generation": "generation"}, "deviceLeaseRuntime": "unknown"})
