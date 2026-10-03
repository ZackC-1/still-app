import importlib.util
import io
import os
from pathlib import Path
import runpy
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("send_alert", Path(__file__).with_name("send-alert.py"))
alert = importlib.util.module_from_spec(spec)
spec.loader.exec_module(alert)


class AlertTest(unittest.TestCase):
    def test_cli_failure_redacts_provider_details(self):
        env = {
            "SECURITY_AUDIT_MAIL_FROM": "audit@example.invalid",
            "SECURITY_AUDIT_MAIL_TO": "owner@example.invalid",
            "SECURITY_AUDIT_SMTP_HOST": "smtp.example.invalid",
            "SECURITY_AUDIT_MAIL_TOKEN": "synthetic-credential-sentinel",
            "SECURITY_AUDIT_RUN_URL": "https://github.com/example/still/actions/runs/1",
        }
        diagnostics = io.StringIO()
        with patch.dict(os.environ, env, clear=True), patch("smtplib.SMTP_SSL", side_effect=RuntimeError("synthetic-credential-sentinel")), patch("sys.stderr", diagnostics):
            with self.assertRaises(SystemExit) as failure:
                runpy.run_path(str(Path(__file__).with_name("send-alert.py")), run_name="__main__")
        self.assertEqual(failure.exception.code, 1)
        self.assertEqual(diagnostics.getvalue(), "Security audit email failed; review the private send-only mail configuration.\n")

    def test_empty_workflow_port_uses_default(self):
        env = {
            "SECURITY_AUDIT_MAIL_FROM": "audit@example.invalid",
            "SECURITY_AUDIT_MAIL_TO": "owner@example.invalid",
            "SECURITY_AUDIT_SMTP_HOST": "smtp.example.invalid",
            "SECURITY_AUDIT_SMTP_PORT": "",
            "SECURITY_AUDIT_SMTP_USER": "send-only",
            "SECURITY_AUDIT_MAIL_TOKEN": "synthetic-credential-sentinel",
            "SECURITY_AUDIT_RUN_URL": "https://github.com/example/still/actions/runs/1",
        }
        with patch.dict(os.environ, env, clear=True), patch.object(alert.smtplib, "SMTP_SSL") as client:
            alert.main()
            self.assertEqual(client.call_args.args[1], 465)
            client.return_value.__enter__.return_value.send_message.assert_called_once()

    def test_fixed_actionable_email_and_restricted_sender(self):
        env = {
            "SECURITY_AUDIT_MAIL_FROM": "audit@example.invalid",
            "SECURITY_AUDIT_MAIL_TO": "owner@example.invalid",
            "SECURITY_AUDIT_SMTP_HOST": "smtp.example.invalid",
            "SECURITY_AUDIT_SMTP_USER": "send-only",
            "SECURITY_AUDIT_MAIL_TOKEN": "synthetic-credential-sentinel",
            "SECURITY_AUDIT_RUN_URL": "https://github.com/example/still/actions/runs/1",
        }
        with patch.dict(os.environ, env, clear=True), patch.object(alert.smtplib, "SMTP_SSL") as client:
            alert.main()
            smtp = client.return_value.__enter__.return_value
            smtp.login.assert_called_once_with("send-only", "synthetic-credential-sentinel")
            message = smtp.send_message.call_args.args[0]
            self.assertEqual(message["To"], "owner@example.invalid")
            self.assertIn("do not reopen old grants", message.get_content())
            self.assertIn(env["SECURITY_AUDIT_RUN_URL"], message.get_content())
            self.assertNotIn("synthetic-credential-sentinel", str(message))


if __name__ == "__main__":
    unittest.main()
