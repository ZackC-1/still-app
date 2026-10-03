"""Send a fixed, actionable audit alert using a restricted send-only SMTP credential."""
import os
import smtplib
import ssl
import sys
from email.message import EmailMessage


def main():
    message = EmailMessage()
    message["From"] = os.environ["SECURITY_AUDIT_MAIL_FROM"]
    message["To"] = os.environ["SECURITY_AUDIT_MAIL_TO"]
    message["Subject"] = "Still catalog security audit needs review"
    message.set_content(
        "The independent weekly catalog audit failed or could not verify its access boundary. "
        "Review the private audit credential/routine and catalog inventory. Keep paid activation "
        "held; do not reopen old grants. No customer records are included.\n"
        f"Run: {os.environ['SECURITY_AUDIT_RUN_URL']}\n"
    )
    with smtplib.SMTP_SSL(
        os.environ["SECURITY_AUDIT_SMTP_HOST"],
        int(os.environ.get("SECURITY_AUDIT_SMTP_PORT") or "465"),
        context=ssl.create_default_context(),
        timeout=20,
    ) as smtp:
        smtp.login(os.environ["SECURITY_AUDIT_SMTP_USER"], os.environ["SECURITY_AUDIT_MAIL_TOKEN"])
        smtp.send_message(message)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Do not print provider/credential/recipient data from an SMTP exception.
        print("Security audit email failed; review the private send-only mail configuration.", file=sys.stderr)
        sys.exit(1)
